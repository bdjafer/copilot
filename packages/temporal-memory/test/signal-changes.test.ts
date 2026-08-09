import { describe, expect, it } from 'vitest'

import { MemoryError } from '../src/index.ts'
import { storageDriver } from '../src/storage/driver.ts'
import { harness } from './support.ts'

const publicAccess = { allowedScopes: [] as string[] }
const privateAccess = { allowedScopes: ['private'] }

async function rememberTarget(
  memory: ReturnType<typeof harness>['memory'],
  id: string,
  scopes: readonly string[] = [],
): Promise<void> {
  await memory.remember({
    id: `${id}-episode`,
    kind: 'assertion',
    content: { type: 'text', text: `${id} exists.` },
    source: { kind: 'fixture' },
    scopes,
    assertions: { entities: [{ id, name: id }] },
  })
}

describe('durable signal changes', () => {
  it('hands a browsed baseline to independent scope-bound consumers', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await rememberTarget(memory, 'public-target')
    await rememberTarget(memory, 'private-target', ['private'])

    const publicBaseline = await memory.browseSignals({ access: publicAccess })
    const privateBaseline = await memory.browseSignals({ access: privateAccess })
    expect(publicBaseline.signalChangesCursor).toBeTypeOf('string')
    const semanticBaseline = await memory.snapshot({ access: privateAccess })
    await expect(
      memory.signalChanges({ access: privateAccess, cursor: semanticBaseline.changesCursor }),
    ).rejects.toMatchObject({ code: 'invalid_input', message: 'signal changes cursor is invalid' })

    const write = await memory.putSignals({
      access: privateAccess,
      expectedRevision: privateBaseline.snapshotRevision,
      signals: [
        {
          namespace: 'peripheral.session',
          target: { kind: 'episode', id: 'public-target-episode' },
          producer: { kind: 'manual', id: 'observer', version: '1' },
          scopes: [],
          value: { visible: true },
        },
        {
          namespace: 'peripheral.session',
          target: { kind: 'episode', id: 'private-target-episode' },
          producer: { kind: 'manual', id: 'observer', version: '1' },
          scopes: ['private'],
          value: { visible: true },
        },
      ],
    })

    const publicDelta = await memory.signalChanges({
      access: publicAccess,
      cursor: publicBaseline.signalChangesCursor,
    })
    expect(publicDelta).toMatchObject({
      throughRevision: write.revision,
      currentRevision: write.revision,
      hasMore: false,
      changes: [
        {
          revision: write.revision,
          action: 'put',
          partitions: [{ scopes: [], affected: [expect.objectContaining({})] }],
        },
      ],
    })
    expect(publicDelta.changes[0]!.partitions[0]!.affected[0]!.target).toEqual({
      kind: 'episode',
      id: 'public-target-episode',
    })
    expect(JSON.stringify(publicDelta)).not.toContain('private-target')

    const privateDelta = await memory.signalChanges({
      access: privateAccess,
      cursor: privateBaseline.signalChangesCursor,
    })
    expect(privateDelta.changes[0]!.partitions).toHaveLength(2)
    expect(
      privateDelta.changes[0]!.partitions.flatMap((partition) => partition.affected),
    ).toHaveLength(2)

    await expect(
      memory.signalChanges({ access: privateAccess, cursor: publicDelta.nextCursor }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { requiresSignalBaseline: true },
    })
    expect(
      await memory.changes({ access: privateAccess, cursor: semanticBaseline.changesCursor }),
    ).toMatchObject({ changes: [] })

    const caughtUp = await memory.browseSignals({ access: privateAccess })
    expect(
      await memory.signalChanges({
        access: privateAccess,
        cursor: caughtUp.signalChangesCursor,
      }),
    ).toMatchObject({ changes: [], hasMore: false })
  })

  it('emits put, withdrawal, and purge transitions without changing semantic history', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await rememberTarget(memory, 'transition-target')
    const baseline = await memory.browseSignals({ access: publicAccess })
    const semanticBaseline = await memory.snapshot({ access: publicAccess })

    const first = await memory.putSignals({
      access: publicAccess,
      expectedRevision: baseline.snapshotRevision,
      signals: [
        {
          namespace: 'dream.salience',
          target: { kind: 'episode', id: 'transition-target-episode' },
          producer: { kind: 'algorithm', id: 'dream', version: '1' },
          scopes: [],
          basis: { episodeIds: ['transition-target-episode'] },
          value: { score: 0.8 },
        },
      ],
    })
    const second = await memory.putSignals({
      access: publicAccess,
      expectedRevision: first.revision,
      signals: [
        {
          namespace: 'dream.salience',
          target: { kind: 'episode', id: 'transition-target-episode' },
          producer: { kind: 'algorithm', id: 'dream', version: '2' },
          scopes: [],
          basis: { episodeIds: ['transition-target-episode'] },
          value: { score: 0.4 },
        },
      ],
    })
    const withdrawn = await memory.deleteSignals({
      access: publicAccess,
      mode: 'withdraw',
      where: { namespaces: ['dream.salience'] },
      expectedRevision: second.revision,
      maxMatches: 1,
    })
    const purged = await memory.deleteSignals({
      access: publicAccess,
      mode: 'purge',
      where: { namespaces: ['dream.salience'], states: ['withdrawn'] },
      expectedRevision: withdrawn.revision,
      maxMatches: 1,
    })

    const delta = await memory.signalChanges({
      access: publicAccess,
      cursor: baseline.signalChangesCursor,
    })
    expect(delta.changes.map((change) => change.action)).toEqual([
      'put',
      'put',
      'withdraw',
      'purge',
    ])
    expect(delta.changes.map((change) => change.revision)).toEqual([
      first.revision,
      second.revision,
      withdrawn.revision,
      purged.revision,
    ])
    const keys = delta.changes.map((change) => change.partitions[0]!.affected[0]!.key)
    expect(new Set(keys)).toEqual(new Set([first.signals[0]!.key]))
    expect(
      await memory.changes({ access: publicAccess, cursor: semanticBaseline.changesCursor }),
    ).toMatchObject({ changes: [] })
  })

  it('compacts only after an explicit bounded acknowledgement floor', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await rememberTarget(memory, 'compact-target')
    const initial = await memory.browseSignals({ access: publicAccess })
    let expectedRevision = initial.snapshotRevision
    for (const version of ['1', '2', '3']) {
      const write = await memory.putSignals({
        access: publicAccess,
        expectedRevision,
        signals: [
          {
            namespace: 'compact.fixture',
            target: { kind: 'episode', id: 'compact-target-episode' },
            producer: { kind: 'manual', id: 'fixture', version },
            scopes: [],
            value: { version },
          },
        ],
      })
      expectedRevision = write.revision
    }
    const firstPage = await memory.signalChanges({
      access: publicAccess,
      cursor: initial.signalChangesCursor,
      limit: 1,
    })
    const secondPage = await memory.signalChanges({
      access: publicAccess,
      cursor: firstPage.nextCursor,
      limit: 1,
    })
    const current = await memory.browseSignals({ access: publicAccess })

    const dryRun = await memory.compactSignalChanges({
      confirmSpaceId: 'space-1',
      consumerCursors: [current.signalChangesCursor],
      expectedRevision: current.snapshotRevision,
      maxChanges: 2,
      dryRun: true,
    })
    expect(dryRun).toMatchObject({
      compactedThrough: secondPage.throughRevision,
      batchChanges: 2,
      deletedChanges: 0,
      hasMore: true,
    })

    const firstBatch = await memory.compactSignalChanges({
      confirmSpaceId: 'space-1',
      consumerCursors: [current.signalChangesCursor],
      expectedRevision: current.snapshotRevision,
      maxChanges: 2,
    })
    expect(firstBatch).toMatchObject({
      compactedThrough: secondPage.throughRevision,
      deletedChanges: 2,
      hasMore: true,
    })
    await expect(
      memory.signalChanges({ access: publicAccess, cursor: initial.signalChangesCursor }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: {
        requiresSignalBaseline: true,
        signalChangesCompactedThrough: secondPage.throughRevision,
      },
    })
    expect(
      await memory.signalChanges({ access: publicAccess, cursor: secondPage.nextCursor }),
    ).toMatchObject({ changes: [expect.objectContaining({ action: 'put' })] })

    const finalBatch = await memory.compactSignalChanges({
      confirmSpaceId: 'space-1',
      consumerCursors: [current.signalChangesCursor],
      expectedRevision: firstBatch.revision,
      maxChanges: 2,
    })
    expect(finalBatch).toMatchObject({ deletedChanges: 1, hasMore: false })
    expect(await memory.stats()).toMatchObject({
      signalChanges: 0,
      signalChangesCompactedThrough: current.snapshotRevision,
    })
    const replacement = await memory.browseSignals({ access: publicAccess })
    expect(
      await memory.signalChanges({
        access: publicAccess,
        cursor: replacement.signalChangesCursor,
      }),
    ).toMatchObject({ changes: [], hasMore: false })
  })

  it('scrubs hard-purged identifiers and requires journaled raw signal mutations', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    await rememberTarget(memory, 'forget-signal')
    await rememberTarget(memory, 'keep-signal')
    const baseline = await memory.browseSignals({ access: publicAccess })
    const write = await memory.putSignals({
      access: publicAccess,
      expectedRevision: baseline.snapshotRevision,
      signals: ['forget-signal', 'keep-signal'].map((id) => ({
        namespace: 'dream.cluster',
        target: { kind: 'episode' as const, id: `${id}-episode` },
        producer: { kind: 'algorithm' as const, id: 'dream', version: '1' },
        scopes: [],
        basis: { episodeIds: [`${id}-episode`] },
        value: { cluster: 'working' },
      })),
    })
    const erasedKey = write.signals.find((signal) => signal.target.id.startsWith('forget'))!.key

    await memory.hardPurge(
      { access: publicAccess, episodeIds: ['forget-signal-episode'] },
      { operationId: 'purge-signal-journal' },
    )

    const delta = await memory.signalChanges({
      access: publicAccess,
      cursor: baseline.signalChangesCursor,
    })
    expect(delta.changes).toHaveLength(2)
    expect(delta.changes.every((change) => change.partitions[0]!.invalidated === true)).toBe(true)
    const serialized = JSON.stringify(delta)
    expect(serialized).not.toContain('forget-signal')
    expect(serialized).not.toContain(erasedKey)
    expect(await memory.verifyIntegrity()).toMatchObject({ ok: true })

    const driver = storageDriver(storage)
    const space = (await driver.getSpace('space-1'))!
    const remaining = (await driver.query({ kind: 'signal', spaceId: 'space-1' }))[0]!
    const rawVersion = remaining.version + 1
    await expect(
      driver.commit({
        spaceId: 'space-1',
        expectedRevision: space.revision,
        puts: [
          {
            ...remaining,
            id: `signal_${remaining.key}_${rawVersion.toString().padStart(8, '0')}`,
            version: rawVersion,
            inputRevision: space.revision,
            recordedRevision: space.revision + 1,
            supersedes: remaining.id,
          },
        ],
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'integrity_failed'))

    await expect(
      driver.commit({
        spaceId: 'space-1',
        expectedRevision: space.revision,
        signalChange: {
          action: 'purge',
          partitions: [
            {
              scopes: [],
              affected: [{ key: '0'.repeat(64), target: null as never }],
            },
          ],
        },
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'integrity_failed'))
  })
})
