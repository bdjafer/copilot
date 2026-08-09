import { describe, expect, it, vi } from 'vitest'

import { createMemory } from '../src/index.ts'
import { storageDriver } from '../src/storage/driver.ts'
import { createInMemoryStorage } from '../src/testing/index.ts'
import { harness } from './support.ts'

const publicAccess = { allowedScopes: [] as string[] }
const privateAccess = { allowedScopes: ['private'] }

async function remember(memory: ReturnType<typeof harness>['memory'], id: string): Promise<void> {
  await memory.remember({
    id: `${id}-episode`,
    kind: 'text',
    content: { type: 'text', text: `${id} history.` },
    source: { kind: 'fixture' },
  })
}

describe('durable journal consumers', () => {
  it('registers, advances, lists, persists, and explicitly retires local checkpoints', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    const semanticBaseline = await memory.snapshot({ access: publicAccess })
    const signalBaseline = await memory.browseSignals({ access: publicAccess })
    const request = {
      id: 'extension-indexer',
      journal: 'semantic' as const,
      cursor: semanticBaseline.changesCursor,
    }
    const registration = memory.registerJournalConsumer(request)
    request.id = 'mutated-after-call'
    request.cursor = signalBaseline.signalChangesCursor
    await expect(registration).resolves.toMatchObject({
      id: 'extension-indexer',
      journal: 'semantic',
      state: 'active',
      throughRevision: semanticBaseline.snapshotRevision,
    })
    await expect(
      memory.registerJournalConsumer({
        id: 'extension-indexer',
        journal: 'semantic',
        cursor: semanticBaseline.changesCursor,
      }),
    ).resolves.toMatchObject({ id: 'extension-indexer', state: 'active' })

    await remember(memory, 'alpha')
    const semanticDelta = await memory.changes({
      access: publicAccess,
      cursor: semanticBaseline.changesCursor,
    })
    const acknowledged = await memory.acknowledgeJournalConsumer({
      id: 'extension-indexer',
      journal: 'semantic',
      cursor: semanticDelta.nextCursor,
    })
    expect(acknowledged.throughRevision).toBe(semanticDelta.throughRevision)
    await expect(
      memory.acknowledgeJournalConsumer({
        id: 'extension-indexer',
        journal: 'semantic',
        cursor: semanticBaseline.changesCursor,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const privateDelta = await memory.changes({
      access: privateAccess,
      cursor: (await memory.snapshot({ access: privateAccess })).changesCursor,
    })
    await expect(
      memory.acknowledgeJournalConsumer({
        id: 'extension-indexer',
        journal: 'semantic',
        cursor: privateDelta.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    expect(await memory.journalConsumers({ journal: 'semantic' })).toMatchObject({
      consumers: [{ id: 'extension-indexer', state: 'active' }],
      hasMore: false,
    })
    await expect(memory.verifyIntegrity()).resolves.toMatchObject({
      ok: true,
      counts: { journal_consumer: 1, journal_registry: 1 },
    })
    expect(
      (await storageDriver(storage).exportRecords('space-1')).some((record) =>
        ['journal_consumer', 'journal_registry'].includes(record.kindRecord),
      ),
    ).toBe(false)

    await memory.close()
    const reopened = createMemory({ spaceId: 'space-1', storage })
    await reopened.open()
    await expect(reopened.journalConsumers({ journal: 'semantic' })).resolves.toMatchObject({
      consumers: [{ id: 'extension-indexer', throughRevision: acknowledged.throughRevision }],
    })
    const retired = await reopened.retireJournalConsumer({
      id: 'extension-indexer',
      journal: 'semantic',
    })
    expect(retired).toMatchObject({ state: 'retired' })
    await expect(
      reopened.retireJournalConsumer({ id: 'extension-indexer', journal: 'semantic' }),
    ).resolves.toEqual(retired)
    await expect(
      reopened.acknowledgeJournalConsumer({
        id: 'extension-indexer',
        journal: 'semantic',
        cursor: acknowledged.cursor,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(
      reopened.registerJournalConsumer({
        id: 'extension-indexer',
        journal: 'semantic',
        cursor: acknowledged.cursor,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect(await reopened.journalConsumers({ journal: 'semantic' })).toMatchObject({
      consumers: [],
    })
    expect(await reopened.journalConsumers({ journal: 'semantic', state: 'all' })).toMatchObject({
      consumers: [{ id: 'extension-indexer', state: 'retired' }],
    })
    await expect(reopened.verifyIntegrity()).resolves.toMatchObject({ ok: true })
  })

  it('pages a metadata-revision snapshot and invalidates it after registry mutation', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    const baseline = await memory.snapshot({ access: publicAccess })
    for (const id of ['consumer-a', 'consumer-b', 'consumer-c']) {
      await memory.registerJournalConsumer({
        id,
        journal: 'semantic',
        cursor: baseline.changesCursor,
      })
    }
    const first = await memory.journalConsumers({ journal: 'semantic', limit: 2 })
    expect(first.consumers.map((consumer) => consumer.id)).toEqual(['consumer-a', 'consumer-b'])
    expect(first).toMatchObject({ hasMore: true, nextCursor: expect.any(String) })
    const second = await memory.journalConsumers({
      journal: 'semantic',
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.consumers.map((consumer) => consumer.id)).toEqual(['consumer-c'])

    await remember(memory, 'pagination-revision')
    await expect(
      memory.journalConsumers({
        journal: 'semantic',
        limit: 2,
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    const refreshed = await memory.journalConsumers({ journal: 'semantic', limit: 2 })
    await memory.retireJournalConsumer({ id: 'consumer-a', journal: 'semantic' })
    await expect(
      memory.journalConsumers({
        journal: 'semantic',
        limit: 2,
        cursor: refreshed.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      memory.journalConsumers({ journal: 'signal', limit: 2, cursor: refreshed.nextCursor }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })

  it('derives compaction from every active registered consumer and excludes retired consumers', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    const baseline = await memory.snapshot({ access: publicAccess })
    await remember(memory, 'alpha')
    await remember(memory, 'beta')
    const slowPage = await memory.changes({
      access: publicAccess,
      cursor: baseline.changesCursor,
      limit: 1,
    })
    const current = await memory.snapshot({ access: publicAccess })
    await memory.registerJournalConsumer({
      id: 'slow',
      journal: 'semantic',
      cursor: slowPage.nextCursor,
    })
    await memory.registerJournalConsumer({
      id: 'fast',
      journal: 'semantic',
      cursor: current.changesCursor,
    })

    const preview = await memory.compactChanges({
      confirmSpaceId: 'space-1',
      registeredConsumers: true,
      expectedRevision: current.snapshotRevision,
      maxChanges: 100,
      dryRun: true,
    })
    expect(preview).toMatchObject({
      dryRun: true,
      requestedThroughRevision: slowPage.throughRevision,
      compactedThrough: slowPage.throughRevision,
      batchChanges: 1,
      deletedChanges: 0,
      revision: current.snapshotRevision,
    })
    await expect(memory.stats()).resolves.toMatchObject({ changesCompactedThrough: 0 })

    const first = await memory.compactChanges({
      confirmSpaceId: 'space-1',
      registeredConsumers: true,
      expectedRevision: current.snapshotRevision,
      maxChanges: 100,
    })
    expect(first).toMatchObject({
      requestedThroughRevision: slowPage.throughRevision,
      compactedThrough: slowPage.throughRevision,
      deletedChanges: 1,
    })
    await memory.retireJournalConsumer({ id: 'slow', journal: 'semantic' })
    const second = await memory.compactChanges({
      confirmSpaceId: 'space-1',
      registeredConsumers: true,
      expectedRevision: first.revision,
      maxChanges: 100,
    })
    expect(second).toMatchObject({
      requestedThroughRevision: current.snapshotRevision,
      compactedThrough: current.snapshotRevision,
      deletedChanges: 1,
    })

    await memory.retireJournalConsumer({ id: 'fast', journal: 'semantic' })
    await expect(
      memory.compactChanges({
        confirmSpaceId: 'space-1',
        registeredConsumers: true,
        expectedRevision: second.revision,
        maxChanges: 100,
      }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
      details: { requiresConsumerRegistration: true },
    })
  })

  it('keeps semantic and signal registries independent and rejects cross-feed cursors', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    const semantic = await memory.snapshot({ access: publicAccess })
    const signal = await memory.browseSignals({ access: publicAccess })
    await memory.registerJournalConsumer({
      id: 'semantic-consumer',
      journal: 'semantic',
      cursor: semantic.changesCursor,
    })
    await memory.registerJournalConsumer({
      id: 'signal-consumer',
      journal: 'signal',
      cursor: signal.signalChangesCursor,
    })
    await expect(
      memory.registerJournalConsumer({
        id: 'wrong-semantic',
        journal: 'semantic',
        cursor: signal.signalChangesCursor,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      memory.registerJournalConsumer({
        id: 'wrong-signal',
        journal: 'signal',
        cursor: semantic.changesCursor,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect((await memory.journalConsumers({ journal: 'semantic' })).consumers).toHaveLength(1)
    expect((await memory.journalConsumers({ journal: 'signal' })).consumers).toHaveLength(1)
  })

  it('uses a registered signal consumer as the signal-compaction watermark', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'signal-target-episode',
      kind: 'assertion',
      content: { type: 'text', text: 'Signal target exists.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'signal-target', name: 'Signal Target' }] },
    })
    const baseline = await memory.browseSignals({ access: publicAccess })
    await memory.registerJournalConsumer({
      id: 'signal-indexer',
      journal: 'signal',
      cursor: baseline.signalChangesCursor,
    })
    const write = await memory.putSignals({
      access: publicAccess,
      expectedRevision: baseline.snapshotRevision,
      signals: [
        {
          namespace: 'consumer.fixture',
          target: { kind: 'entity', id: 'signal-target' },
          producer: { kind: 'manual', id: 'fixture', version: '1' },
          scopes: [],
          basis: { episodeIds: ['signal-target-episode'] },
          value: { selected: true },
        },
      ],
    })
    const delta = await memory.signalChanges({
      access: publicAccess,
      cursor: baseline.signalChangesCursor,
    })
    await memory.acknowledgeJournalConsumer({
      id: 'signal-indexer',
      journal: 'signal',
      cursor: delta.nextCursor,
    })
    await expect(
      memory.compactSignalChanges({
        confirmSpaceId: 'space-1',
        registeredConsumers: true,
        expectedRevision: write.revision,
        maxChanges: 100,
      }),
    ).resolves.toMatchObject({
      requestedThroughRevision: write.revision,
      compactedThrough: write.revision,
      deletedChanges: 1,
    })
    await expect(
      memory.compactSignalChanges({
        confirmSpaceId: 'space-1',
        registeredConsumers: true,
        throughRevision: write.revision,
        expectedRevision: write.revision + 1,
        maxChanges: 100,
      } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      memory.compactSignalChanges({
        confirmSpaceId: 'space-1',
        registeredConsumers: false as true,
        expectedRevision: write.revision + 1,
        maxChanges: 100,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('rejects registered compaction if an independent acknowledgement races its commit', async () => {
    const storage = createInMemoryStorage()
    const left = createMemory({ spaceId: 'compaction-registry-race', storage })
    const right = createMemory({ spaceId: 'compaction-registry-race', storage })
    await left.open({ create: true })
    await right.open()
    const baseline = await left.snapshot({ access: publicAccess })
    await remember(left, 'race-alpha')
    await remember(left, 'race-beta')
    const slow = await left.changes({
      access: publicAccess,
      cursor: baseline.changesCursor,
      limit: 1,
    })
    const current = await left.snapshot({ access: publicAccess })
    await left.registerJournalConsumer({
      id: 'racing-consumer',
      journal: 'semantic',
      cursor: slow.nextCursor,
    })

    const driver = storageDriver(storage)
    const originalCommit = driver.commit.bind(driver)
    let compactionReached!: () => void
    let releaseCompaction!: () => void
    const reached = new Promise<void>((resolve) => {
      compactionReached = resolve
    })
    const released = new Promise<void>((resolve) => {
      releaseCompaction = resolve
    })
    vi.spyOn(driver, 'commit').mockImplementation(async (change) => {
      if (change.changeCompaction !== undefined) {
        compactionReached()
        await released
      }
      return originalCommit(change)
    })
    const compaction = left.compactChanges({
      confirmSpaceId: 'compaction-registry-race',
      registeredConsumers: true,
      expectedRevision: current.snapshotRevision,
      maxChanges: 100,
    })
    await reached
    await right.acknowledgeJournalConsumer({
      id: 'racing-consumer',
      journal: 'semantic',
      cursor: current.changesCursor,
    })
    releaseCompaction()
    await expect(compaction).rejects.toMatchObject({ code: 'conflict', retryable: true })
    expect(await left.stats()).toMatchObject({ changesCompactedThrough: 0 })
  })

  it('uses registry guards so independent writers cannot silently lose acknowledgements', async () => {
    const storage = createInMemoryStorage()
    const left = createMemory({ spaceId: 'registry-race', storage })
    const right = createMemory({ spaceId: 'registry-race', storage })
    await left.open({ create: true })
    await right.open()
    const baseline = await left.snapshot({ access: publicAccess })
    const driver = storageDriver(storage)
    const originalCommit = driver.commit.bind(driver)
    let arrivals = 0
    let release!: () => void
    const bothReady = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(driver, 'commit').mockImplementation(async (change) => {
      if ((change.puts ?? []).some((record) => record.kindRecord === 'journal_consumer')) {
        arrivals += 1
        if (arrivals === 2) release()
        await bothReady
      }
      return originalCommit(change)
    })
    const results = await Promise.allSettled([
      left.registerJournalConsumer({
        id: 'left-consumer',
        journal: 'semantic',
        cursor: baseline.changesCursor,
      }),
      right.registerJournalConsumer({
        id: 'right-consumer',
        journal: 'semantic',
        cursor: baseline.changesCursor,
      }),
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected).toMatchObject({ reason: { code: 'conflict', retryable: true } })
    const missingId = results[0]!.status === 'fulfilled' ? 'right-consumer' : 'left-consumer'
    await expect(
      right.registerJournalConsumer({
        id: missingId,
        journal: 'semantic',
        cursor: baseline.changesCursor,
      }),
    ).resolves.toMatchObject({ id: missingId })
    expect((await left.journalConsumers({ journal: 'semantic' })).consumers).toHaveLength(2)
  })

  it('enforces the finite registry bound across active and retired tombstones', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    const baseline = await memory.snapshot({ access: publicAccess })
    for (let index = 0; index < 1_000; index += 1) {
      await memory.registerJournalConsumer({
        id: `bounded-consumer-${index.toString().padStart(4, '0')}`,
        journal: 'semantic',
        cursor: baseline.changesCursor,
      })
    }
    await memory.retireJournalConsumer({ id: 'bounded-consumer-0000', journal: 'semantic' })
    await expect(
      memory.registerJournalConsumer({
        id: 'bounded-consumer-overflow',
        journal: 'semantic',
        cursor: baseline.changesCursor,
      }),
    ).rejects.toMatchObject({ code: 'result_too_large' })
    await expect(memory.verifyIntegrity()).resolves.toMatchObject({
      ok: true,
      counts: { journal_consumer: 1_000, journal_registry: 1 },
    })
  })

  it('removes local consumer checkpoints and registry epochs on destructive reset', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    const semantic = await memory.snapshot({ access: publicAccess })
    const signal = await memory.browseSignals({ access: publicAccess })
    await memory.registerJournalConsumer({
      id: 'semantic-reset-consumer',
      journal: 'semantic',
      cursor: semantic.changesCursor,
    })
    await memory.registerJournalConsumer({
      id: 'signal-reset-consumer',
      journal: 'signal',
      cursor: signal.signalChangesCursor,
    })
    await remember(memory, 'reset-target')
    await memory.hardPurge({
      access: publicAccess,
      episodeIds: ['reset-target-episode'],
    })
    await expect(memory.journalConsumers({ journal: 'semantic' })).resolves.toMatchObject({
      consumers: [{ id: 'semantic-reset-consumer' }],
    })
    await expect(memory.journalConsumers({ journal: 'signal' })).resolves.toMatchObject({
      consumers: [{ id: 'signal-reset-consumer' }],
    })

    await memory.resetSpace({ confirmSpaceId: 'space-1' })

    const driver = storageDriver(storage)
    await driver.open()
    await expect(driver.query({ kind: 'journal_consumer', spaceId: 'space-1' })).resolves.toEqual(
      [],
    )
    await expect(driver.query({ kind: 'journal_registry', spaceId: 'space-1' })).resolves.toEqual(
      [],
    )
    await driver.close()
  })
})
