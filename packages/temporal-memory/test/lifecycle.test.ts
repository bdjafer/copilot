import { describe, expect, it, vi } from 'vitest'

import { createMemory, MemoryError } from '../src/index.ts'
import { storageDriver } from '../src/storage/driver.ts'
import { createInMemoryStorage } from '../src/testing/index.ts'
import { harness, WORK_ONTOLOGY } from './support.ts'

function unknownTransactionOutcome(operationId?: string): MemoryError {
  return new MemoryError('storage_failed', 'injected unknown transaction outcome', {
    operationId,
    retryable: false,
    details: { transactionOutcome: 'unknown', requiresReopen: true },
  })
}

function isUnknownTransactionOutcome(error: unknown): boolean {
  return (
    MemoryError.is(error, 'storage_failed') &&
    !error.retryable &&
    error.details?.transactionOutcome === 'unknown' &&
    error.details?.requiresReopen === true
  )
}

async function seedLegacySpace(
  storage: ReturnType<typeof createInMemoryStorage>,
  id: string,
  schemaVersion: string,
): Promise<void> {
  const driver = storageDriver(storage)
  await driver.open()
  await driver.createSpace({
    kind: 'space',
    id,
    spaceId: id,
    generation: `${id}-generation`,
    revision: 0,
    changesCompactedThrough: 0,
    ...(schemaVersion === '5' ? {} : { signalChangesCompactedThrough: 0 }),
    createdAt: '2026-08-03T10:00:00.000Z',
    updatedAt: '2026-08-03T10:00:00.000Z',
    schemaVersion,
    ontology: { id: 'astrale.open', version: '1' },
    ontologyValue: {
      id: 'astrale.open',
      version: '1',
      mode: 'open',
      entityTypes: {},
      factTypes: {},
    },
    metadata: {},
  } as Parameters<typeof driver.createSpace>[0])
  await driver.close()
}

describe('AC01 lifecycle persists across close and reopen', () => {
  it('creates, closes, and reopens one space on the same durable storage capability', async () => {
    const { memory, storage } = harness()

    await expect(memory.open()).rejects.toMatchObject({ code: 'space_not_found' })
    const created = await memory.open({ create: true, metadata: { owner: 'local' } })
    expect(created).toMatchObject({ id: 'space-1', metadata: { owner: 'local' } })
    expect((await memory.inspect()).state).toBe('degraded')
    await memory.close()
    expect((await memory.inspect()).state).toBe('closed')

    const reopened = createMemory({ spaceId: 'space-1', storage })
    await expect(reopened.open()).resolves.toMatchObject({ id: 'space-1' })
    await reopened.close()

    const live = createMemory({ spaceId: 'space-1', storage })
    const failedOpen = createMemory({ spaceId: 'space-1', storage })
    await live.open()
    const sharedDriver = storageDriver(storage)
    const closeSpy = vi.spyOn(sharedDriver, 'close')
    const openSpy = vi
      .spyOn(sharedDriver, 'open')
      .mockRejectedValueOnce(new MemoryError('storage_failed', 'injected pre-reference failure'))
    await expect(failedOpen.open()).rejects.toMatchObject({ code: 'storage_failed' })
    expect(closeSpy).not.toHaveBeenCalled()
    await expect(live.stats()).resolves.toMatchObject({ snapshotRevision: 0 })
    openSpy.mockRestore()
    closeSpy.mockRestore()
    await live.close()

    const pendingStorage = createInMemoryStorage()
    const pendingDriver = storageDriver(pendingStorage)
    const pendingMemory = createMemory({ spaceId: 'pending-cleanup', storage: pendingStorage })
    const pendingOpenSpy = vi.spyOn(pendingDriver, 'open').mockRejectedValueOnce(
      new MemoryError('storage_failed', 'injected incomplete connection cleanup', {
        details: { connectionCleanup: 'pending' },
      }),
    )
    const pendingCloseSpy = vi.spyOn(pendingDriver, 'close')
    await expect(pendingMemory.open()).rejects.toMatchObject({
      code: 'storage_failed',
      details: { connectionCleanup: 'pending' },
    })
    expect(pendingCloseSpy).not.toHaveBeenCalled()
    pendingOpenSpy.mockRestore()
    await pendingMemory.close()
    expect(pendingCloseSpy).toHaveBeenCalledOnce()
    pendingCloseSpy.mockRestore()

    const acquiredStorage = createInMemoryStorage()
    const acquiredDriver = storageDriver(acquiredStorage)
    const acquiredMemory = createMemory({ spaceId: 'acquired-cleanup', storage: acquiredStorage })
    const acquiredCloseSpy = vi
      .spyOn(acquiredDriver, 'close')
      .mockRejectedValueOnce(new MemoryError('storage_failed', 'injected close failure'))
    await expect(acquiredMemory.open()).rejects.toMatchObject({
      code: 'space_not_found',
      details: { connectionCleanup: 'pending' },
    })
    expect(acquiredCloseSpy).toHaveBeenCalledOnce()
    await acquiredMemory.close()
    expect(acquiredCloseSpy).toHaveBeenCalledTimes(2)
    acquiredCloseSpy.mockRestore()

    const legacyStorage = createInMemoryStorage()
    const legacyDriver = storageDriver(legacyStorage)
    await legacyDriver.open()
    await legacyDriver.createSpace({
      kind: 'space',
      id: 'legacy',
      spaceId: 'legacy',
      generation: 'legacy-generation',
      revision: 0,
      changesCompactedThrough: 0,
      signalChangesCompactedThrough: 0,
      createdAt: '2026-08-03T10:00:00.000Z',
      updatedAt: '2026-08-03T10:00:00.000Z',
      schemaVersion: '5',
      ontology: { id: 'astrale.open', version: '1' },
      ontologyValue: {
        id: 'astrale.open',
        version: '1',
        mode: 'open',
        entityTypes: {},
        factTypes: {},
      },
      metadata: {},
    })
    await legacyDriver.close()
    const incompatible = createMemory({ spaceId: 'legacy', storage: legacyStorage })
    await expect(incompatible.open()).rejects.toMatchObject({ code: 'incompatible_schema' })
  })

  it('rejects work before open and makes close idempotent', async () => {
    const { memory } = harness()
    await expect(memory.stats()).rejects.toSatisfy((error: unknown) =>
      MemoryError.is(error, 'not_open'),
    )
    await expect(memory.close()).resolves.toBeUndefined()
    await expect(memory.close()).resolves.toBeUndefined()
  })

  it('fences an unknown commit outcome until close/reopen without secondary writes or unsafe replay', async () => {
    const deriveContext = harness()
    await deriveContext.memory.open({ create: true })
    await deriveContext.memory.remember({
      id: 'uncertain-derive-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice supplies a premise.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'uncertain-alice', name: 'Alice' }],
        facts: [
          {
            id: 'uncertain-premise',
            subject: { id: 'uncertain-alice' },
            predicate: 'supplies',
            object: { scalar: true },
          },
        ],
      },
    })
    const deriveInput = {
      conclusion: {
        id: 'uncertain-conclusion',
        subjectId: 'uncertain-alice',
        predicate: 'derived',
        object: { kind: 'scalar' as const, value: true },
      },
      rule: { id: 'rules/uncertain', version: '1' },
      premises: [{ kind: 'fact' as const, id: 'uncertain-premise' }],
      access: { allowedScopes: [] as string[] },
      expectedRevision: (await deriveContext.memory.stats()).snapshotRevision,
    }
    const deriveDriver = storageDriver(deriveContext.storage)
    const deriveCommit = deriveDriver.commit.bind(deriveDriver)
    let deriveLostResponses = 0
    let loseDeriveResponse = true
    const deriveCommitSpy = vi.spyOn(deriveDriver, 'commit').mockImplementation(async (change) => {
      const targetsDerive = change.puts?.some(
        (record) => record.kindRecord === 'operation' && record.id === 'uncertain-derive-operation',
      )
      const revision = await deriveCommit(change)
      if (loseDeriveResponse && targetsDerive === true) {
        loseDeriveResponse = false
        deriveLostResponses += 1
        throw unknownTransactionOutcome('uncertain-derive-operation')
      }
      return revision
    })

    await expect(
      deriveContext.memory.deriveFact(deriveInput, {
        operationId: 'uncertain-derive-operation',
      }),
    ).rejects.toSatisfy(isUnknownTransactionOutcome)
    expect(deriveLostResponses).toBe(1)
    await expect(deriveContext.memory.stats()).rejects.toSatisfy(isUnknownTransactionOutcome)
    await expect(deriveContext.memory.open()).rejects.toSatisfy(isUnknownTransactionOutcome)
    await deriveContext.memory.close()
    await deriveContext.memory.open()
    await expect(
      deriveContext.memory.deriveFact(deriveInput, {
        operationId: 'uncertain-derive-operation',
      }),
    ).resolves.toMatchObject({
      outcome: 'created',
      operation: { id: 'uncertain-derive-operation', state: 'succeeded' },
      conclusion: { id: 'uncertain-conclusion', status: 'active' },
    })
    deriveCommitSpy.mockRestore()
    await deriveContext.memory.close()

    const ingestionContext = harness()
    await ingestionContext.memory.open({ create: true })
    const ingestionDriver = storageDriver(ingestionContext.storage)
    const ingestionCommit = ingestionDriver.commit.bind(ingestionDriver)
    let ingestionOperationCommits = 0
    let loseCanonicalResponse = true
    let markCanonicalCommitted = (): void => undefined
    let releaseLostResponse = (): void => undefined
    const canonicalCommitted = new Promise<void>((resolve) => {
      markCanonicalCommitted = resolve
    })
    const lostResponseReleased = new Promise<void>((resolve) => {
      releaseLostResponse = resolve
    })
    const ingestionCommitSpy = vi
      .spyOn(ingestionDriver, 'commit')
      .mockImplementation(async (change) => {
        const targetOperation = change.puts?.find(
          (record) =>
            record.kindRecord === 'operation' && record.id === 'uncertain-ingestion-operation',
        )
        if (targetOperation !== undefined) ingestionOperationCommits += 1
        const revision = await ingestionCommit(change)
        if (
          loseCanonicalResponse &&
          targetOperation?.kindRecord === 'operation' &&
          targetOperation.stage === 'canonical_committed'
        ) {
          loseCanonicalResponse = false
          markCanonicalCommitted()
          await lostResponseReleased
          throw unknownTransactionOutcome('uncertain-ingestion-operation')
        }
        return revision
      })
    const ingestionPending = ingestionContext.memory.remember(
      {
        id: 'uncertain-ingestion-source',
        kind: 'assertion',
        content: { type: 'text', text: 'Alice is processed once.' },
        source: { kind: 'fixture' },
        assertions: {
          entities: [{ id: 'uncertain-ingestion-alice', name: 'Alice' }],
          facts: [
            {
              id: 'uncertain-ingestion-fact',
              subject: { id: 'uncertain-ingestion-alice' },
              predicate: 'processed',
              object: { scalar: true },
            },
          ],
        },
      },
      { operationId: 'uncertain-ingestion-operation' },
    )
    await canonicalCommitted
    const ingestionGet = ingestionDriver.get.bind(ingestionDriver)
    let markOperationReadLoaded = (): void => undefined
    let releaseOperationRead = (): void => undefined
    const operationReadLoaded = new Promise<void>((resolve) => {
      markOperationReadLoaded = resolve
    })
    const operationReadReleased = new Promise<void>((resolve) => {
      releaseOperationRead = resolve
    })
    let delayOperationRead = true
    const ingestionGetSpy = vi.spyOn(ingestionDriver, 'get')
    ingestionGetSpy.mockImplementation((async (kind, spaceId, id) => {
      const record = await ingestionGet(kind, spaceId, id)
      if (delayOperationRead && kind === 'operation' && id === 'uncertain-ingestion-operation') {
        delayOperationRead = false
        markOperationReadLoaded()
        await operationReadReleased
      }
      return record
    }) as typeof ingestionDriver.get)
    const operationReadPending = ingestionContext.memory.operation('uncertain-ingestion-operation')
    await operationReadLoaded
    const queuedPending = ingestionContext.memory.remember(
      {
        id: 'uncertain-ingestion-queued',
        kind: 'text',
        content: { type: 'text', text: 'This queued write must never start.' },
        source: { kind: 'fixture' },
      },
      { operationId: 'uncertain-ingestion-queued-operation' },
    )
    releaseLostResponse()
    await expect(ingestionPending).rejects.toSatisfy(isUnknownTransactionOutcome)
    await expect(queuedPending).rejects.toSatisfy(isUnknownTransactionOutcome)
    expect(ingestionOperationCommits).toBe(2)
    const inspectionSpy = vi.spyOn(ingestionDriver, 'inspect')
    await expect(ingestionContext.memory.inspect()).rejects.toSatisfy(isUnknownTransactionOutcome)
    expect(inspectionSpy).not.toHaveBeenCalled()
    inspectionSpy.mockRestore()
    await ingestionContext.memory.close()
    await ingestionContext.memory.open()
    releaseOperationRead()
    await expect(operationReadPending).rejects.toSatisfy(isUnknownTransactionOutcome)
    ingestionGetSpy.mockRestore()
    await expect(
      ingestionContext.memory.operation('uncertain-ingestion-operation'),
    ).resolves.toMatchObject({
      id: 'uncertain-ingestion-operation',
      state: 'partial',
      stage: 'interrupted',
    })
    await expect(
      ingestionContext.memory.getEpisode('uncertain-ingestion-queued', { allowedScopes: [] }),
    ).resolves.toBeNull()
    await expect(
      ingestionContext.memory.retryEpisode('uncertain-ingestion-source', {
        operationId: 'uncertain-ingestion-retry',
      }),
    ).resolves.toMatchObject({
      operation: { id: 'uncertain-ingestion-retry', state: 'succeeded' },
      facts: { repeated: ['uncertain-ingestion-fact'] },
    })
    await expect(
      ingestionContext.memory.getFact('uncertain-ingestion-fact', { allowedScopes: [] }),
    ).resolves.toMatchObject({ id: 'uncertain-ingestion-fact', status: 'active' })
    ingestionCommitSpy.mockRestore()
    await ingestionContext.memory.close()

    const deleteContext = harness()
    await deleteContext.memory.open({ create: true })
    await deleteContext.memory.remember({
      id: 'uncertain-delete-source',
      kind: 'text',
      content: { type: 'text', text: 'Delete me once.' },
      source: { kind: 'fixture' },
    })
    const deleteDriver = storageDriver(deleteContext.storage)
    const deleteCommit = deleteDriver.commit.bind(deleteDriver)
    let deleteLostResponses = 0
    let loseDeleteResponse = true
    const deleteCommitSpy = vi.spyOn(deleteDriver, 'commit').mockImplementation(async (change) => {
      const targetsDelete = change.puts?.some(
        (record) => record.kindRecord === 'operation' && record.id === 'uncertain-delete-operation',
      )
      const revision = await deleteCommit(change)
      if (loseDeleteResponse && targetsDelete === true) {
        loseDeleteResponse = false
        deleteLostResponses += 1
        throw unknownTransactionOutcome('uncertain-delete-operation')
      }
      return revision
    })

    await expect(
      deleteContext.memory.deleteEpisode(
        { episodeId: 'uncertain-delete-source', access: { allowedScopes: [] } },
        { operationId: 'uncertain-delete-operation' },
      ),
    ).rejects.toSatisfy(isUnknownTransactionOutcome)
    expect(deleteLostResponses).toBe(1)
    await expect(deleteContext.memory.operation('uncertain-delete-operation')).rejects.toSatisfy(
      isUnknownTransactionOutcome,
    )
    await deleteContext.memory.close()
    await deleteContext.memory.open()
    await expect(
      deleteContext.memory.operation('uncertain-delete-operation'),
    ).resolves.toMatchObject({ id: 'uncertain-delete-operation', state: 'succeeded' })
    await deleteContext.memory.remember({
      id: 'uncertain-delete-second',
      kind: 'text',
      content: { type: 'text', text: 'Do not rebind the first delete identity.' },
      source: { kind: 'fixture' },
    })
    await expect(
      deleteContext.memory.deleteEpisode(
        { episodeId: 'uncertain-delete-second', access: { allowedScopes: [] } },
        { operationId: 'uncertain-delete-operation' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict', retryable: false })
    deleteCommitSpy.mockRestore()
    await deleteContext.memory.close()

    const resetContext = harness()
    await resetContext.memory.open({ create: true })
    await resetContext.memory.remember({
      id: 'uncertain-reset-source',
      kind: 'text',
      content: { type: 'text', text: 'Reset outcome is unknown.' },
      source: { kind: 'fixture' },
    })
    const resetDriver = storageDriver(resetContext.storage)
    const deleteSpace = resetDriver.deleteSpace.bind(resetDriver)
    let deleteSpaceCalls = 0
    const deleteSpaceSpy = vi
      .spyOn(resetDriver, 'deleteSpace')
      .mockImplementation(async (...args) => {
        deleteSpaceCalls += 1
        await deleteSpace(...args)
        throw unknownTransactionOutcome()
      })

    await expect(resetContext.memory.resetSpace({ confirmSpaceId: 'space-1' })).rejects.toSatisfy(
      isUnknownTransactionOutcome,
    )
    expect(deleteSpaceCalls).toBe(1)
    await expect(resetContext.memory.stats()).rejects.toSatisfy(isUnknownTransactionOutcome)
    await expect(resetContext.memory.open()).rejects.toSatisfy(isUnknownTransactionOutcome)
    await resetContext.memory.close()
    await expect(resetContext.memory.open()).rejects.toMatchObject({ code: 'space_not_found' })
    await expect(resetContext.memory.open({ create: true })).resolves.toMatchObject({
      id: 'space-1',
    })
    await expect(resetContext.memory.stats()).resolves.toMatchObject({ snapshotRevision: 0 })
    expect(deleteSpaceCalls).toBe(1)
    deleteSpaceSpy.mockRestore()
    await resetContext.memory.close()
  })

  it('bounds, cancels, and generation-fences inspection without stale facade metadata', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'inspection-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Inspection has physical projection work.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'inspection-entity', name: 'Inspection entity' }],
        facts: [
          {
            subject: { id: 'inspection-entity' },
            predicate: 'is_inspectable',
            object: { scalar: true },
          },
        ],
      },
    })

    const inspection = await memory.inspect()
    expect(inspection.scan.records).toBeGreaterThan(1)
    expect(inspection.scan.bytes).toBeGreaterThan(0)
    await expect(
      memory.inspect({
        scanLimits: {
          maxRecords: inspection.scan.records - 1,
          maxBytes: inspection.scan.bytes,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'inspection_scan',
        dimension: 'records',
        required: inspection.scan.records,
        maximum: inspection.scan.records - 1,
      },
    })
    await expect(
      memory.inspect({
        scanLimits: {
          maxRecords: inspection.scan.records,
          maxBytes: inspection.scan.bytes - 1,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'inspection_scan',
        dimension: 'bytes',
        required: inspection.scan.bytes,
        maximum: inspection.scan.bytes - 1,
      },
    })
    const cancelled = new AbortController()
    cancelled.abort()
    await expect(memory.inspect({ signal: cancelled.signal })).rejects.toSatisfy((error: unknown) =>
      MemoryError.is(error, 'cancelled'),
    )

    const peer = createMemory({ spaceId: 'space-1', storage })
    await peer.open()
    await peer.resetSpace({ confirmSpaceId: 'space-1' })
    await peer.open({ create: true })
    await expect(memory.inspect()).rejects.toMatchObject({
      code: 'conflict',
      details: { requiresReopen: true },
    })
    await memory.close()
    await expect(
      memory.inspect({ scanLimits: { maxRecords: 1, maxBytes: 1 } }),
    ).resolves.toMatchObject({
      state: 'closed',
      space: null,
      scan: { records: 0, bytes: 0, limits: { maxRecords: 1, maxBytes: 1 } },
    })
    await peer.close()
  })

  it('explicitly migrates additive schema 5 and 6 transitions with immutable checkpoints', async () => {
    const storage = createInMemoryStorage()
    await seedLegacySpace(storage, 'migrated', '5')
    const memory = createMemory({ spaceId: 'migrated', storage })

    await expect(memory.open({ migrate: true })).resolves.toMatchObject({ schemaVersion: '7' })
    const inspection = await memory.inspect()
    const driver = storageDriver(storage)
    const space = await driver.getSpace('migrated')

    expect(inspection.schemaMigrations).toEqual([
      expect.objectContaining({
        id: 'canonical-schema-5-to-6-signal-journal',
        sequence: 6,
        fromSchemaVersion: '5',
        toSchemaVersion: '6',
        state: 'succeeded',
      }),
      expect.objectContaining({
        id: 'canonical-schema-6-to-7-derivations',
        sequence: 7,
        fromSchemaVersion: '6',
        toSchemaVersion: '7',
        state: 'succeeded',
      }),
    ])
    expect(inspection.schemaMigrations.every((item) => /^[a-f0-9]{64}$/u.test(item.checksum))).toBe(
      true,
    )
    expect(space).toMatchObject({
      revision: 0,
      schemaVersion: '7',
      metadataRevision: 2,
      canonicalRevision: 0,
      signalChangesCompactedThrough: 0,
    })

    await memory.close()
    const reopened = createMemory({ spaceId: 'migrated', storage })
    await reopened.open({ migrate: true })
    expect((await reopened.inspect()).schemaMigrations).toHaveLength(2)
  })

  it('resumes at the first uncommitted migration step after a storage failure', async () => {
    const storage = createInMemoryStorage()
    await seedLegacySpace(storage, 'resumable', '5')
    const driver = storageDriver(storage)
    const original = driver.applyMigration.bind(driver)
    const apply = vi.spyOn(driver, 'applyMigration').mockImplementation(async (change) => {
      if (change.expectedSchemaVersion === '6') {
        throw new MemoryError('storage_failed', 'injected migration interruption')
      }
      return original(change)
    })
    const interrupted = createMemory({ spaceId: 'resumable', storage })

    await expect(interrupted.open({ migrate: true })).rejects.toMatchObject({
      code: 'storage_failed',
    })
    await driver.open()
    expect(await driver.getSpace('resumable')).toMatchObject({ schemaVersion: '6', revision: 0 })
    expect(await driver.migrationHistory('resumable')).toHaveLength(1)
    await driver.close()

    apply.mockRestore()
    const resumed = createMemory({ spaceId: 'resumable', storage })
    await expect(resumed.open({ migrate: true })).resolves.toMatchObject({ schemaVersion: '7' })
    expect((await resumed.inspect()).schemaMigrations).toHaveLength(2)
  })

  it('converges concurrent migration opens and rejects checksum or downgrade ambiguity', async () => {
    const storage = createInMemoryStorage()
    await seedLegacySpace(storage, 'concurrent-migration', '5')
    const driver = storageDriver(storage)
    const originalApply = driver.applyMigration.bind(driver)
    let injectedMetadataRace = false
    const apply = vi.spyOn(driver, 'applyMigration').mockImplementation(async (change) => {
      if (!injectedMetadataRace) {
        injectedMetadataRace = true
        await driver.commit({
          spaceId: change.spaceId,
          expectedRevision: change.expectedRevision,
          metadataOnly: true,
        })
      }
      return originalApply(change)
    })
    const left = createMemory({ spaceId: 'concurrent-migration', storage })
    const right = createMemory({ spaceId: 'concurrent-migration', storage })

    await expect(
      Promise.all([left.open({ migrate: true }), right.open({ migrate: true })]),
    ).resolves.toEqual([
      expect.objectContaining({ schemaVersion: '7' }),
      expect.objectContaining({ schemaVersion: '7' }),
    ])
    expect((await left.inspect()).schemaMigrations).toHaveLength(2)
    apply.mockRestore()
    await left.close()
    await right.close()

    const originalHistory = driver.migrationHistory.bind(driver)
    const history = vi
      .spyOn(driver, 'migrationHistory')
      .mockImplementation(async (spaceId) =>
        (await originalHistory(spaceId)).map((migration, index) =>
          index === 0 ? { ...migration, checksum: '0'.repeat(64) } : migration,
        ),
      )
    const corrupted = createMemory({ spaceId: 'concurrent-migration', storage })
    await expect(corrupted.open({ migrate: true })).rejects.toMatchObject({
      code: 'incompatible_schema',
    })
    history.mockRestore()

    const futureStorage = createInMemoryStorage()
    await seedLegacySpace(futureStorage, 'future', '8')
    const future = createMemory({ spaceId: 'future', storage: futureStorage })
    await expect(future.open({ migrate: true })).rejects.toMatchObject({
      code: 'incompatible_schema',
    })
  })

  it('fails closed on pre-classification projections until the first atomic full rebuild', async () => {
    const storage = createInMemoryStorage()
    const driver = storageDriver(storage)
    const recordedAt = '2026-08-03T10:00:00.000Z'
    await driver.open()
    await driver.createSpace({
      kind: 'space',
      id: 'legacy-v7',
      spaceId: 'legacy-v7',
      generation: 'legacy-v7-generation',
      revision: 0,
      changesCompactedThrough: 0,
      signalChangesCompactedThrough: 0,
      createdAt: recordedAt,
      updatedAt: recordedAt,
      schemaVersion: '7',
      ontology: { id: WORK_ONTOLOGY.id, version: WORK_ONTOLOGY.version },
      ontologyValue: WORK_ONTOLOGY,
      metadata: {},
    })
    await driver.close()

    const memory = createMemory({ spaceId: 'legacy-v7', storage, ontology: WORK_ONTOLOGY })
    await memory.open()
    await memory.remember({
      id: 'legacy-episode',
      kind: 'assertion',
      content: { type: 'text', text: 'Legacy searchable entity.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'legacy-entity', name: 'Legacy searchable entity' }] },
    })
    const before = await memory.recall({
      query: 'searchable',
      access: { allowedScopes: [] },
      channels: { exact: false, lexical: true, semantic: false, graph: false, temporal: false },
    })
    const rebuilt = await memory.rebuildProjections({ kinds: ['lexical'] })
    const after = await memory.recall({
      query: 'searchable',
      access: { allowedScopes: [] },
      channels: { exact: false, lexical: true, semantic: false, graph: false, temporal: false },
    })

    expect(before.entities).toEqual([])
    expect(before.degraded).toContainEqual(
      expect.objectContaining({
        capability: 'lexical',
        reason: 'lexical projection generation requires a full rebuild',
      }),
    )
    expect(rebuilt).toMatchObject({ failed: 0, staleRemaining: 0 })
    expect(rebuilt.activeProjectionSets.find((set) => set.kind === 'lexical')).toBeDefined()
    expect(after.entities.map((entity) => entity.id)).toEqual(['legacy-entity'])
  })
})
