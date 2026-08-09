import { describe, expect, it } from 'vitest'

import { createMemory, type AccessContext, type Memory, type MemoryChange } from '../src/index.ts'
import { storageDriver } from '../src/storage/driver.ts'
import { createInMemoryStorage } from '../src/testing/index.ts'
import { harness, OPEN_ONTOLOGY } from './support.ts'

const publicAccess = { allowedScopes: [] as string[] }
const privateAccess = { allowedScopes: ['private'] }

async function collectChanges(
  memory: Memory,
  access: AccessContext,
  limit = 100,
): Promise<{ changes: MemoryChange[]; cursor: string; currentRevision: number }> {
  const changes: MemoryChange[] = []
  let cursor: string | undefined
  let currentRevision = 0
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    const page = await memory.changes({
      access,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
    })
    changes.push(...page.changes)
    cursor = page.nextCursor
    currentRevision = page.currentRevision
    if (!page.hasMore) return { changes, cursor, currentRevision }
  }
  throw new Error('change feed did not terminate')
}

describe('semantic change feed', () => {
  it('paginates committed semantics, binds access, and filters exact-scope partitions', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'public-episode',
      kind: 'assertion',
      content: { type: 'text', text: 'Public Alpha exists.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'public-alpha', name: 'Public Alpha' }] },
    })
    await memory.remember({
      id: 'private-episode',
      kind: 'assertion',
      content: { type: 'text', text: 'Private Beta exists.' },
      source: { kind: 'fixture' },
      scopes: ['private'],
      assertions: { entities: [{ id: 'private-beta', name: 'Private Beta' }] },
    })

    const publicFeed = await collectChanges(memory, publicAccess, 1)
    expect(publicFeed.changes.map((change) => change.phase)).toEqual(['accepted', 'canonical'])
    expect(JSON.stringify(publicFeed.changes)).toContain('public-episode')
    expect(JSON.stringify(publicFeed.changes)).not.toContain('private-episode')
    expect(publicFeed.currentRevision).toBeGreaterThan(
      Math.max(...publicFeed.changes.map((change) => change.revision)),
    )

    const firstPrivatePage = await memory.changes({ access: privateAccess, limit: 1 })
    expect(firstPrivatePage).toMatchObject({ hasMore: true })
    await expect(
      memory.changes({ access: publicAccess, cursor: firstPrivatePage.nextCursor }),
    ).rejects.toMatchObject({ code: 'conflict', details: { requiresSnapshot: true } })

    const privateFeed = await collectChanges(memory, privateAccess, 1)
    expect(privateFeed.changes.map((change) => change.phase)).toEqual([
      'accepted',
      'canonical',
      'accepted',
      'canonical',
    ])
    const publicSnapshot = await memory.snapshot({ access: publicAccess })
    const privateSnapshot = await memory.snapshot({ access: privateAccess })
    const signalBaseline = await memory.browseSignals({ access: publicAccess })
    await expect(
      memory.changes({ access: publicAccess, cursor: signalBaseline.signalChangesCursor }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: 'changes cursor is invalid' })

    await memory.mergeEntities({
      targetId: 'public-alpha',
      sourceIds: ['private-beta'],
      access: privateAccess,
    })
    const publicDelta = await memory.changes({
      access: publicAccess,
      cursor: publicSnapshot.changesCursor,
    })
    expect(publicDelta.changes).toHaveLength(1)
    expect(publicDelta.changes[0]).toMatchObject({ operationKind: 'merge', phase: 'governance' })
    expect(publicDelta.changes[0]!.partitions).toEqual([
      {
        scopes: [],
        affected: { episodeIds: [], entityIds: ['public-alpha'], factIds: [] },
      },
    ])
    expect(JSON.stringify(publicDelta.changes)).not.toContain('private-beta')

    const privateDelta = await memory.changes({
      access: privateAccess,
      cursor: privateSnapshot.changesCursor,
    })
    expect(privateDelta.changes[0]!.partitions).toEqual([
      {
        scopes: [],
        affected: { episodeIds: [], entityIds: ['public-alpha'], factIds: [] },
      },
      {
        scopes: ['private'],
        affected: { episodeIds: [], entityIds: ['private-beta'], factIds: [] },
      },
    ])
    expect(await memory.verifyIntegrity()).toMatchObject({ ok: true })
  })

  it('derives the safe compaction watermark from every snapshotted consumer cursor', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    const preHistory = await memory.snapshot({ access: publicAccess })
    for (const id of ['alpha', 'beta']) {
      await memory.remember({
        id: `${id}-episode`,
        kind: 'text',
        content: { type: 'text', text: `${id} history.` },
        source: { kind: 'fixture' },
      })
    }

    const slow = await memory.changes({ access: publicAccess, limit: 1 })
    const fast = await memory.changes({
      access: privateAccess,
      cursor: (await memory.changes({ access: privateAccess, limit: 1 })).nextCursor,
      limit: 1,
    })
    const baseline = await memory.snapshot({ access: publicAccess })
    const consumerCursors = [slow.nextCursor, fast.nextCursor]
    const request = {
      confirmSpaceId: 'space-1',
      consumerCursors,
      expectedRevision: baseline.snapshotRevision,
      maxChanges: 100,
    }
    const compactionPromise = memory.compactChanges(request)
    consumerCursors[0] = fast.nextCursor
    request.expectedRevision += 100

    await expect(compactionPromise).resolves.toMatchObject({
      requestedThroughRevision: slow.throughRevision,
      compactedThrough: slow.throughRevision,
      deletedChanges: 1,
      hasMore: false,
    })
    expect(await memory.changes({ access: publicAccess, cursor: slow.nextCursor })).toMatchObject({
      changesCompactedThrough: slow.throughRevision,
    })

    const current = await memory.snapshot({ access: publicAccess })
    const signalBaseline = await memory.browseSignals({ access: publicAccess })
    await expect(
      memory.compactChanges({
        confirmSpaceId: 'space-1',
        consumerCursors: [signalBaseline.signalChangesCursor],
        expectedRevision: current.snapshotRevision,
        maxChanges: 100,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: 'changes cursor is invalid' })
    await expect(
      memory.compactChanges({
        confirmSpaceId: 'space-1',
        consumerCursors: [],
        expectedRevision: current.snapshotRevision,
        maxChanges: 100,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      memory.compactChanges({
        confirmSpaceId: 'space-1',
        consumerCursors: Array.from({ length: 1_001 }, () => current.changesCursor),
        expectedRevision: current.snapshotRevision,
        maxChanges: 100,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      memory.compactChanges({
        confirmSpaceId: 'space-1',
        consumerCursors: [current.changesCursor],
        throughRevision: current.snapshotRevision,
        expectedRevision: current.snapshotRevision,
        maxChanges: 100,
      } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      memory.compactChanges({
        confirmSpaceId: 'space-1',
        consumerCursors: [preHistory.changesCursor],
        expectedRevision: current.snapshotRevision,
        maxChanges: 100,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: {
        requiresSnapshot: true,
        changesCompactedThrough: slow.throughRevision,
      },
    })

    const other = harness({ spaceId: 'other-space' }).memory
    await other.open({ create: true })
    const otherCursor = (await other.snapshot({ access: publicAccess })).changesCursor
    await expect(
      memory.compactChanges({
        confirmSpaceId: 'space-1',
        consumerCursors: [otherCursor],
        expectedRevision: current.snapshotRevision,
        maxChanges: 100,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { requiresSnapshot: true },
    })
    await other.close()
  })

  it('compacts bounded batches and requires a snapshot behind the retained floor', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    for (const id of ['alpha', 'beta']) {
      await memory.remember({
        id: `${id}-episode`,
        kind: 'assertion',
        content: { type: 'text', text: `${id} exists.` },
        source: { kind: 'fixture' },
        assertions: { entities: [{ id, name: id }] },
      })
    }

    const firstPage = await memory.changes({ access: publicAccess, limit: 1 })
    const floorPage = await memory.changes({
      access: publicAccess,
      cursor: firstPage.nextCursor,
      limit: 1,
    })
    const baseline = await memory.snapshot({ access: publicAccess })
    expect(await memory.stats()).toMatchObject({
      changes: 4,
      changesCompactedThrough: 0,
    })

    const dryRun = await memory.compactChanges({
      confirmSpaceId: 'space-1',
      throughRevision: baseline.snapshotRevision,
      expectedRevision: baseline.snapshotRevision,
      maxChanges: 2,
      dryRun: true,
    })
    expect(dryRun).toEqual({
      dryRun: true,
      requestedThroughRevision: baseline.snapshotRevision,
      previousCompactedThrough: 0,
      compactedThrough: floorPage.throughRevision,
      batchChanges: 2,
      deletedChanges: 0,
      hasMore: true,
      revision: baseline.snapshotRevision,
    })
    expect(await memory.stats()).toMatchObject({ changes: 4, changesCompactedThrough: 0 })

    const firstBatch = await memory.compactChanges({
      confirmSpaceId: 'space-1',
      throughRevision: baseline.snapshotRevision,
      expectedRevision: baseline.snapshotRevision,
      maxChanges: 2,
    })
    expect(firstBatch).toMatchObject({
      previousCompactedThrough: 0,
      compactedThrough: floorPage.throughRevision,
      batchChanges: 2,
      deletedChanges: 2,
      hasMore: true,
      revision: baseline.snapshotRevision + 1,
    })
    expect(await memory.stats()).toMatchObject({
      changes: 2,
      changesCompactedThrough: floorPage.throughRevision,
    })
    await expect(
      memory.changes({ access: publicAccess, cursor: firstPage.nextCursor }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: {
        requiresSnapshot: true,
        changesCompactedThrough: floorPage.throughRevision,
      },
    })
    await expect(memory.changes({ access: publicAccess })).rejects.toMatchObject({
      code: 'conflict',
      details: { requiresSnapshot: true },
    })
    const retained = await memory.changes({
      access: publicAccess,
      cursor: floorPage.nextCursor,
    })
    expect(retained.changes).toHaveLength(2)
    expect(retained.changesCompactedThrough).toBe(floorPage.throughRevision)

    const finalBatch = await memory.compactChanges({
      confirmSpaceId: 'space-1',
      throughRevision: baseline.snapshotRevision,
      expectedRevision: firstBatch.revision,
      maxChanges: 2,
    })
    expect(finalBatch).toMatchObject({
      previousCompactedThrough: floorPage.throughRevision,
      compactedThrough: baseline.snapshotRevision,
      batchChanges: 2,
      deletedChanges: 2,
      hasMore: false,
      revision: firstBatch.revision + 1,
    })
    expect(await memory.stats()).toMatchObject({
      changes: 0,
      changesCompactedThrough: baseline.snapshotRevision,
    })

    const replacement = await memory.snapshot({ access: publicAccess })
    expect(
      await memory.changes({ access: publicAccess, cursor: replacement.changesCursor }),
    ).toMatchObject({ changes: [], hasMore: false })
    await memory.remember({
      id: 'gamma-episode',
      kind: 'assertion',
      content: { type: 'text', text: 'gamma exists.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'gamma', name: 'gamma' }] },
    })
    expect(
      (
        await memory.changes({ access: publicAccess, cursor: replacement.changesCursor })
      ).changes.map((change) => change.phase),
    ).toEqual(['accepted', 'canonical'])
    expect(await memory.verifyIntegrity()).toMatchObject({ ok: true })
  })

  it('guards compaction with exact confirmation, revision, bounds, and a monotonic floor', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'guarded-episode',
      kind: 'text',
      content: { type: 'text', text: 'Guarded history.' },
      source: { kind: 'fixture' },
    })
    const baseline = await memory.snapshot({ access: publicAccess })
    const baseRequest = {
      confirmSpaceId: 'space-1',
      throughRevision: baseline.snapshotRevision,
      expectedRevision: baseline.snapshotRevision,
      maxChanges: 1,
    }
    await expect(
      memory.compactChanges({ ...baseRequest, confirmSpaceId: 'wrong-space' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(memory.compactChanges({ ...baseRequest, maxChanges: 0 })).rejects.toMatchObject({
      code: 'invalid_input',
    })
    await expect(
      memory.compactChanges({
        ...baseRequest,
        throughRevision: baseline.snapshotRevision + 1,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    await memory.remember({
      id: 'revision-drift',
      kind: 'text',
      content: { type: 'text', text: 'Revision drift.' },
      source: { kind: 'fixture' },
    })
    await expect(memory.compactChanges(baseRequest)).rejects.toMatchObject({
      code: 'conflict',
      retryable: true,
    })

    const current = await memory.snapshot({ access: publicAccess })
    const compacted = await memory.compactChanges({
      confirmSpaceId: 'space-1',
      throughRevision: current.snapshotRevision,
      expectedRevision: current.snapshotRevision,
      maxChanges: 1,
    })
    await expect(
      memory.compactChanges({
        confirmSpaceId: 'space-1',
        throughRevision: compacted.compactedThrough - 1,
        expectedRevision: compacted.revision,
        maxChanges: 1,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const noOp = await memory.compactChanges({
      confirmSpaceId: 'space-1',
      throughRevision: compacted.compactedThrough,
      expectedRevision: compacted.revision,
      maxChanges: 1,
    })
    expect(noOp).toMatchObject({
      compactedThrough: compacted.compactedThrough,
      batchChanges: 0,
      deletedChanges: 0,
      revision: compacted.revision,
    })
  })

  it('scrubs hard-purged identifiers and emits content-free invalidations', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    const remembered = await memory.remember({
      id: 'forget-me',
      kind: 'assertion',
      content: { type: 'text', text: 'Secret Person knows a secret.' },
      source: { kind: 'fixture' },
      scopes: ['secret'],
      assertions: {
        entities: [{ id: 'secret-person', name: 'Secret Person' }],
        facts: [
          {
            subject: { id: 'secret-person' },
            predicate: 'knows',
            object: { scalar: 'a secret' },
          },
        ],
      },
    })
    const secretAccess = { allowedScopes: ['secret'] }
    const before = await collectChanges(memory, secretAccess)
    const factId = remembered.facts.created[0]!
    expect(JSON.stringify(before.changes)).toContain('forget-me')
    expect(JSON.stringify(before.changes)).toContain(factId)

    await memory.hardPurge(
      {
        access: secretAccess,
        episodeIds: ['forget-me'],
        entityIds: ['secret-person'],
      },
      { operationId: 'purge-secret-fixture' },
    )

    const delta = await memory.changes({ access: secretAccess, cursor: before.cursor })
    expect(delta.changes).toEqual([
      expect.objectContaining({
        operationId: 'purge-secret-fixture',
        operationKind: 'purge',
        phase: 'purge',
        partitions: [
          {
            scopes: ['secret'],
            affected: { episodeIds: [], entityIds: [], factIds: [] },
            invalidated: true,
          },
        ],
      }),
    ])
    const fromCreation = await collectChanges(memory, secretAccess)
    const stored = await storageDriver(storage).query({ kind: 'change', spaceId: 'space-1' })
    for (const serialized of [JSON.stringify(fromCreation.changes), JSON.stringify(stored)]) {
      expect(serialized).not.toContain('forget-me')
      expect(serialized).not.toContain('secret-person')
      expect(serialized).not.toContain(factId)
    }
    expect(await memory.verifyIntegrity()).toMatchObject({ ok: true })
  })

  it('invalidates cursors after destructive space recreation', async () => {
    const storage = createInMemoryStorage()
    const first = createMemory({ spaceId: 'generation-space', storage, ontology: OPEN_ONTOLOGY })
    await first.open({ create: true })
    await first.remember({
      id: 'old-episode',
      kind: 'text',
      content: { type: 'text', text: 'Old generation.' },
      source: { kind: 'fixture' },
    })
    const cursor = (await first.changes({ access: publicAccess })).nextCursor
    await first.resetSpace({ confirmSpaceId: 'generation-space' })

    const second = createMemory({ spaceId: 'generation-space', storage, ontology: OPEN_ONTOLOGY })
    await second.open({ create: true })
    await expect(second.changes({ access: publicAccess, cursor })).rejects.toMatchObject({
      code: 'conflict',
      details: { requiresSnapshot: true },
    })
  })

  it('exports canonical state without the journal and emits one fresh import change', async () => {
    const source = harness()
    await source.memory.open({ create: true })
    await source.memory.remember({
      id: 'portable-episode',
      kind: 'assertion',
      content: { type: 'text', text: 'Portable Entity exists.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'portable-entity', name: 'Portable Entity' }] },
    })
    const archive = await source.memory.export({ access: publicAccess, complete: true })
    expect(Object.keys(archive.canonical).sort()).toEqual([
      'derivations',
      'entities',
      'episodes',
      'evidence',
      'facts',
      'lifecycle',
      'mentions',
      'merges',
    ])

    const target = harness()
    await target.memory.open({ create: true })
    await target.memory.import(archive)
    const feed = await collectChanges(target.memory, publicAccess)
    expect(feed.changes).toHaveLength(1)
    expect(feed.changes[0]).toMatchObject({ operationKind: 'import', phase: 'import' })
    expect(JSON.stringify(feed.changes[0])).toContain('portable-episode')
  })

  it('rejects canonical commits that bypass or violate the semantic journal', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    const driver = storageDriver(storage)
    const before = (await driver.getSpace('space-1'))!.revision
    await expect(
      driver.commit({
        spaceId: 'space-1',
        expectedRevision: before,
        deletes: [{ kind: 'episode', id: 'missing-fixture' }],
      }),
    ).rejects.toMatchObject({ code: 'integrity_failed' })
    await expect(
      driver.commit({
        spaceId: 'space-1',
        expectedRevision: before,
        semanticChange: {
          operationId: 'invalid-invalidation',
          operationKind: 'purge',
          phase: 'purge',
          partitions: [
            {
              scopes: [],
              affected: { episodeIds: ['must-not-leak'], entityIds: [], factIds: [] },
              invalidated: true,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'integrity_failed' })
    await expect(
      driver.commit({
        spaceId: 'space-1',
        expectedRevision: before,
        deletes: [{ kind: 'change', id: 'unbounded-bypass' }],
        changeCompaction: { throughRevision: before },
      }),
    ).rejects.toMatchObject({ code: 'integrity_failed' })
    await expect(
      driver.commit({
        spaceId: 'space-1',
        expectedRevision: before,
        changeCompaction: { throughRevision: before + 1 },
      }),
    ).rejects.toMatchObject({ code: 'integrity_failed' })
    expect((await driver.getSpace('space-1'))!.revision).toBe(before)
  })
})
