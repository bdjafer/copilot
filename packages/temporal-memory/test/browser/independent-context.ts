import {
  createMemory,
  MemoryError,
  type JsonValue,
  type Memory,
  type MemorySignalState,
} from '../../src/index.ts'
import {
  SYNC_METADATA_KINDS,
  storageDriver,
  type StorageCommit,
  type StorageDriver,
  type StorageMigrationChange,
  type StoredRecordKind,
} from '../../src/storage/driver.ts'
import { createSurrealMemoryStorage } from '../../src/surreal/index.ts'

interface SerializedFailure {
  ok: false
  error: {
    code: string
    message: string
    retryable: boolean
    operationId?: string
    details?: Readonly<Record<string, JsonValue>>
  }
}

interface IndependentContextApi {
  [method: string]: (input?: unknown) => Promise<unknown>
}

declare global {
  interface Window {
    __temporalIndependentContext?: IndependentContextApi
  }
}

const access = { allowedScopes: [] as string[] }
const spaceId = 'independent-context-space'
let memory: Memory | undefined
let driver: StorageDriver | undefined
let syncSource: Memory | undefined

interface ReadGate {
  kind: StoredRecordKind
  reached: boolean
  released: Promise<void>
  release: () => void
}

let readGate: ReadGate | undefined
let derivationCommitGate: Omit<ReadGate, 'kind'> | undefined

interface OperationCommitSelector {
  operationId: string
  stage: string
  semantic?: boolean
}

interface OperationCommitGate extends Omit<ReadGate, 'kind'>, OperationCommitSelector {
  position: 'before' | 'after'
}

interface OperationCommitFailure extends OperationCommitSelector {
  remainingMatches: number
}

let operationCommitGate: OperationCommitGate | undefined
let operationCommitFailure: OperationCommitFailure | undefined

interface MigrationGate extends Omit<ReadGate, 'kind'> {
  fromSchemaVersion: string
  toSchemaVersion: string
  position: 'before' | 'after'
}

let migrationGate: MigrationGate | undefined

interface DeleteSpaceGate extends Omit<ReadGate, 'kind'> {
  position: 'before' | 'after'
}

let deleteSpaceGate: DeleteSpaceGate | undefined

interface RecordDeletionCommitGate extends Omit<ReadGate, 'kind'> {
  kind: StoredRecordKind
  position: 'before' | 'after'
}

let recordDeletionCommitGate: RecordDeletionCommitGate | undefined

function armReadGate(kind: StoredRecordKind): void {
  if (readGate !== undefined) throw new Error('independent read gate is already armed')
  let release = (): void => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  readGate = { kind, reached: false, released, release }
}

async function crossReadGate(kind: StoredRecordKind): Promise<void> {
  const gate = readGate
  if (gate === undefined || gate.reached || gate.kind !== kind) return
  gate.reached = true
  await gate.released
  if (readGate === gate) readGate = undefined
}

function armDerivationCommitPause(): void {
  if (derivationCommitGate !== undefined) {
    throw new Error('independent derivation commit gate is already armed')
  }
  let release = (): void => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  derivationCommitGate = { reached: false, released, release }
}

async function crossDerivationCommitGate(hasDerivationPut: boolean): Promise<void> {
  const gate = derivationCommitGate
  if (!hasDerivationPut || gate === undefined || gate.reached) return
  gate.reached = true
  await gate.released
  if (derivationCommitGate === gate) derivationCommitGate = undefined
}

function armOperationCommitPause(input: {
  operationId: string
  stage: string
  position: 'before' | 'after'
  semantic?: boolean
}): void {
  if (operationCommitGate !== undefined) {
    throw new Error('independent operation commit gate is already armed')
  }
  let release = (): void => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  operationCommitGate = { ...input, reached: false, released, release }
}

function operationCommitMatches(change: StorageCommit, selector: OperationCommitSelector): boolean {
  const semantic = change.semanticChange !== undefined || change.signalChange !== undefined
  if (selector.semantic !== undefined && selector.semantic !== semantic) return false
  return (
    change.puts?.some(
      (record) =>
        record.kindRecord === 'operation' &&
        record.id === selector.operationId &&
        record.stage === selector.stage,
    ) === true
  )
}

async function crossOperationCommitGate(
  change: StorageCommit,
  position: 'before' | 'after',
): Promise<void> {
  const gate = operationCommitGate
  if (gate === undefined || gate.reached || gate.position !== position) return
  if (!operationCommitMatches(change, gate)) return
  gate.reached = true
  await gate.released
  if (operationCommitGate === gate) operationCommitGate = undefined
}

function armOperationCommitFailure(input: {
  operationId: string
  stage: string
  semantic?: boolean
  occurrence: number
}): void {
  if (operationCommitFailure !== undefined) {
    throw new Error('independent operation commit failure is already armed')
  }
  if (!Number.isSafeInteger(input.occurrence) || input.occurrence < 1) {
    throw new Error('operation commit failure occurrence must be a positive safe integer')
  }
  operationCommitFailure = { ...input, remainingMatches: input.occurrence }
}

function throwArmedOperationCommitFailure(change: StorageCommit): void {
  const fault = operationCommitFailure
  if (fault === undefined || !operationCommitMatches(change, fault)) return
  fault.remainingMatches -= 1
  if (fault.remainingMatches > 0) return
  operationCommitFailure = undefined
  throw new Error('simulated operation commit interruption')
}

function armMigrationPause(input: {
  fromSchemaVersion: string
  toSchemaVersion: string
  position: 'before' | 'after'
}): void {
  if (migrationGate !== undefined) {
    throw new Error('independent migration gate is already armed')
  }
  let release = (): void => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  migrationGate = { ...input, reached: false, released, release }
}

async function crossMigrationGate(
  change: StorageMigrationChange,
  position: 'before' | 'after',
): Promise<void> {
  const gate = migrationGate
  if (
    gate === undefined ||
    gate.reached ||
    gate.position !== position ||
    gate.fromSchemaVersion !== change.migration.fromSchemaVersion ||
    gate.toSchemaVersion !== change.migration.toSchemaVersion
  ) {
    return
  }
  gate.reached = true
  await gate.released
  if (migrationGate === gate) migrationGate = undefined
}

function armDeleteSpacePause(position: 'before' | 'after'): void {
  if (deleteSpaceGate !== undefined) {
    throw new Error('independent delete-space gate is already armed')
  }
  let release = (): void => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  deleteSpaceGate = { position, reached: false, released, release }
}

async function crossDeleteSpaceGate(position: 'before' | 'after'): Promise<void> {
  const gate = deleteSpaceGate
  if (gate === undefined || gate.reached || gate.position !== position) return
  gate.reached = true
  await gate.released
  if (deleteSpaceGate === gate) deleteSpaceGate = undefined
}

function armRecordDeletionCommitPause(input: {
  kind: StoredRecordKind
  position: 'before' | 'after'
}): void {
  if (recordDeletionCommitGate !== undefined) {
    throw new Error('independent record deletion commit gate is already armed')
  }
  let release = (): void => undefined
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  recordDeletionCommitGate = { ...input, reached: false, released, release }
}

async function crossRecordDeletionCommitGate(
  change: StorageCommit,
  position: 'before' | 'after',
): Promise<void> {
  const gate = recordDeletionCommitGate
  if (gate === undefined || gate.reached || gate.position !== position) return
  if (change.deletes?.some((deletion) => deletion.kind === gate.kind) !== true) return
  gate.reached = true
  await gate.released
  if (recordDeletionCommitGate === gate) recordDeletionCommitGate = undefined
}

function requiredMemory(): Memory {
  if (memory === undefined) throw new Error('independent context is not open')
  return memory
}

function failure(error: unknown): SerializedFailure {
  if (MemoryError.is(error)) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.operationId === undefined ? {} : { operationId: error.operationId }),
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }
  }
  return {
    ok: false,
    error: {
      code: 'unexpected',
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  }
}

async function stats() {
  const result = await requiredMemory().stats()
  return {
    revision: result.snapshotRevision,
    episodes: result.episodes,
    signals: result.signals,
    signalRevisions: result.signalRevisions,
  }
}

async function migrationDiagnostics(selectedDriver: StorageDriver) {
  const [space, migrations] = await Promise.all([
    selectedDriver.getSpace(spaceId),
    selectedDriver.migrationHistory(spaceId),
  ])
  return {
    revision: space?.revision ?? null,
    metadataRevision: space?.metadataRevision ?? null,
    canonicalRevision: space?.canonicalRevision ?? null,
    schemaVersion: space?.schemaVersion ?? null,
    signalChangesCompactedThrough: space?.signalChangesCompactedThrough ?? null,
    migrations: migrations.map((migration) => ({
      id: migration.id,
      sequence: migration.sequence,
      fromSchemaVersion: migration.fromSchemaVersion,
      toSchemaVersion: migration.toSchemaVersion,
      checksum: migration.checksum,
      state: migration.state,
    })),
  }
}

async function openIndependentSyncSource(
  endpoint: `indxdb://${string}`,
  worker: boolean,
  create: boolean,
): Promise<Memory> {
  if (syncSource !== undefined) throw new Error('independent sync source is already open')
  const source = createMemory({
    spaceId,
    storage: createSurrealMemoryStorage({ endpoint, worker }),
  })
  try {
    await source.open({ create })
  } catch (error) {
    await source.close().catch(() => undefined)
    throw error
  }
  syncSource = source
  return source
}

async function runSyncApply(request: { sessionId: string; operationId: string }): Promise<unknown> {
  if (syncSource === undefined) throw new Error('independent sync source is not open')
  try {
    const report = await requiredMemory().syncFrom(
      syncSource,
      {
        access,
        confirmSpaceId: spaceId,
        sessionId: request.sessionId,
      },
      { operationId: request.operationId },
    )
    return {
      ok: true,
      state: report.state,
      operation: report.operation,
      checkpointId: report.checkpoint?.id ?? null,
      appliedRecords: report.appliedRecords,
      deletedRecords: report.deletedRecords,
    }
  } catch (error) {
    return failure(error)
  }
}

async function runSyncAbort(request: { sessionId: string }): Promise<unknown> {
  try {
    const report = await requiredMemory().abortSync({
      access,
      confirmSpaceId: spaceId,
      sessionId: request.sessionId,
    })
    return {
      ok: true,
      state: report.state,
      operation: report.operation,
      checkpointId: report.checkpoint?.id ?? null,
      appliedRecords: report.appliedRecords,
      deletedRecords: report.deletedRecords,
    }
  } catch (error) {
    return failure(error)
  }
}

window.__temporalIndependentContext = {
  async open(input?: unknown) {
    const options = input as {
      endpoint: `indxdb://${string}`
      worker: boolean
      create: boolean
      migrate?: boolean
      skipStats?: boolean
    }
    const storage = createSurrealMemoryStorage({
      endpoint: options.endpoint,
      worker: options.worker,
    })
    driver = storageDriver(storage)
    const query = driver.query.bind(driver)
    driver.query = (async (request) => {
      const result = await query(request)
      await crossReadGate(request.kind)
      return result
    }) as StorageDriver['query']
    const get = driver.get.bind(driver)
    driver.get = (async (kind, selectedSpaceId, id) => {
      const result = await get(kind, selectedSpaceId, id)
      await crossReadGate(kind)
      return result
    }) as StorageDriver['get']
    const commit = driver.commit.bind(driver)
    driver.commit = (async (change) => {
      await crossOperationCommitGate(change, 'before')
      await crossRecordDeletionCommitGate(change, 'before')
      await crossDerivationCommitGate(
        change.puts?.some((record) => record.kindRecord === 'derivation') === true,
      )
      throwArmedOperationCommitFailure(change)
      const revision = await commit(change)
      await crossOperationCommitGate(change, 'after')
      await crossRecordDeletionCommitGate(change, 'after')
      return revision
    }) as StorageDriver['commit']
    const applyMigration = driver.applyMigration.bind(driver)
    driver.applyMigration = (async (change) => {
      await crossMigrationGate(change, 'before')
      const migrated = await applyMigration(change)
      await crossMigrationGate(change, 'after')
      return migrated
    }) as StorageDriver['applyMigration']
    const deleteSpace = driver.deleteSpace.bind(driver)
    driver.deleteSpace = async (selectedSpaceId, expectedRevision) => {
      await crossDeleteSpaceGate('before')
      await deleteSpace(selectedSpaceId, expectedRevision)
      await crossDeleteSpaceGate('after')
    }
    memory = createMemory({ spaceId, storage })
    await memory.open({ create: options.create, migrate: options.migrate ?? false })
    return options.skipStats === true ? { opened: true } : stats()
  },

  async seedLegacySpace(input?: unknown) {
    const options = input as { endpoint: `indxdb://${string}`; worker: boolean }
    const storage = createSurrealMemoryStorage({
      endpoint: options.endpoint,
      worker: options.worker,
    })
    const seedDriver = storageDriver(storage)
    await seedDriver.open()
    try {
      await seedDriver.createSpace({
        kind: 'space',
        id: spaceId,
        spaceId,
        generation: 'independent-migration-generation',
        revision: 0,
        changesCompactedThrough: 0,
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:00.000Z',
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
      } as Parameters<typeof seedDriver.createSpace>[0])
      return await migrationDiagnostics(seedDriver)
    } finally {
      await seedDriver.close()
    }
  },

  async inspectMigrationStorage(input?: unknown) {
    const options = input as { endpoint: `indxdb://${string}`; worker: boolean }
    const storage = createSurrealMemoryStorage({
      endpoint: options.endpoint,
      worker: options.worker,
    })
    const inspectionDriver = storageDriver(storage)
    await inspectionDriver.open()
    try {
      return await migrationDiagnostics(inspectionDriver)
    } finally {
      await inspectionDriver.close()
    }
  },

  async migrationDiagnostics() {
    if (driver === undefined) throw new Error('independent context storage is not open')
    return migrationDiagnostics(driver)
  },

  async seed() {
    await requiredMemory().remember({
      id: 'shared-episode',
      kind: 'assertion',
      content: { type: 'text', text: 'Independent contexts share one durable memory.' },
      source: { kind: 'independent-context-test' },
      assertions: {
        entities: [{ id: 'shared-entity', name: 'Shared entity' }],
        facts: [
          {
            id: 'shared-fact',
            subject: { id: 'shared-entity' },
            predicate: 'is_shared',
            object: { scalar: true },
          },
        ],
      },
    })
    return stats()
  },

  async rememberEpisode(input?: unknown) {
    const request = input as { id: string; text: string }
    await requiredMemory().remember({
      id: request.id,
      kind: 'text',
      content: { type: 'text', text: request.text },
      source: { kind: 'independent-context-test' },
    })
    return stats()
  },

  async seedEpisodeDeletionGroup() {
    for (const suffix of ['a', 'b'] as const) {
      await requiredMemory().remember({
        id: `independent-episode-delete-${suffix}`,
        kind: 'event',
        content: { type: 'event', name: 'temporary-session', value: suffix },
        source: { kind: 'independent-episode-deletion' },
        tags: ['independent-episode-deletion'],
      })
    }
    return stats()
  },

  async previewEpisodeDeletions(input?: unknown) {
    const request = (input ?? {}) as { sourceKind?: string; maxMatches?: number }
    try {
      const preview = await requiredMemory().previewEpisodeDeletions({
        where: {
          source: { kinds: [request.sourceKind ?? 'independent-context-test'] },
        },
        access,
        maxMatches: request.maxMatches ?? 10_000,
      })
      return {
        ok: true,
        revision: preview.snapshotRevision,
        selectionCursor: preview.selectionCursor,
        episodeIds: preview.episodes.map((episode) => episode.id),
      }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptDeleteEpisodes(input?: unknown) {
    const request = input as {
      sourceKind: string
      expectedRevision: number
      maxMatches: number
      operationId: string
      selectionCursor?: string
    }
    try {
      const report = await requiredMemory().deleteEpisodes(
        {
          where: { source: { kinds: [request.sourceKind] } },
          access,
          expectedRevision: request.expectedRevision,
          maxMatches: request.maxMatches,
          ...(request.selectionCursor === undefined
            ? {}
            : { selectionCursor: request.selectionCursor }),
        },
        { operationId: request.operationId },
      )
      return {
        ok: true,
        revision: (await stats()).revision,
        operationId: report.operation.id,
        affectedEpisodes: report.affectedEpisodes,
        unsupportedFacts: report.unsupportedFacts,
      }
    } catch (error) {
      return failure(error)
    }
  },

  async episodeDeletionDiagnostics(input?: unknown) {
    if (driver === undefined) throw new Error('independent context storage is not open')
    const request = input as { episodeIds: string[]; operationIds: string[] }
    const operationSet = new Set(request.operationIds)
    const [space, episodes, operations, lifecycle, changes] = await Promise.all([
      driver.getSpace(spaceId),
      Promise.all(request.episodeIds.map((id) => driver!.get('episode', spaceId, id))),
      Promise.all(request.operationIds.map((id) => driver!.get('operation', spaceId, id))),
      driver.query({ kind: 'lifecycle', spaceId, limit: 100 }),
      driver.query({ kind: 'change', spaceId, limit: 100 }),
    ])
    return {
      revision: space?.revision ?? null,
      episodes: request.episodeIds.map((id, index) => ({
        id,
        retentionState: episodes[index]?.retentionState ?? null,
      })),
      operations: operations
        .filter((operation) => operation !== null)
        .map((operation) => operation.id)
        .sort(),
      lifecycle: lifecycle
        .filter(
          (transition) =>
            operationSet.has(transition.operationId) &&
            request.episodeIds.includes(transition.target.id),
        )
        .map((transition) => ({
          operationId: transition.operationId,
          targetId: transition.target.id,
          action: transition.action,
        }))
        .sort((left, right) =>
          left.targetId < right.targetId
            ? -1
            : left.targetId > right.targetId
              ? 1
              : left.operationId < right.operationId
                ? -1
                : left.operationId > right.operationId
                  ? 1
                  : 0,
        ),
      changes: changes
        .filter((change) => operationSet.has(change.operationId))
        .map((change) => ({ operationId: change.operationId, phase: change.phase })),
    }
  },

  async attemptRememberEpisode(input?: unknown) {
    const request = input as { id: string; operationId: string }
    try {
      const report = await requiredMemory().remember(
        {
          id: request.id,
          kind: 'text',
          content: { type: 'text', text: `Reset contention fixture ${request.id}.` },
          source: { kind: 'independent-reset-test' },
        },
        { operationId: request.operationId },
      )
      return {
        ok: true,
        episodeId: report.episode.id,
        operation: {
          id: report.operation.id,
          state: report.operation.state,
          stage: report.operation.stage,
        },
      }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptReset() {
    try {
      const report = await requiredMemory().resetSpace({ confirmSpaceId: spaceId })
      return {
        ok: true,
        purged: report.purged,
        affectedEpisodes: report.affectedEpisodes,
        affectedEntities: report.affectedEntities,
        affectedFacts: report.affectedFacts,
        projectionsInvalidated: report.projectionsInvalidated,
      }
    } catch (error) {
      return failure(error)
    }
  },

  async inspectResetStorage(input?: unknown) {
    const options = input as {
      endpoint: `indxdb://${string}`
      worker: boolean
      episodeIds: string[]
      operationIds: string[]
    }
    const storage = createSurrealMemoryStorage({
      endpoint: options.endpoint,
      worker: options.worker,
    })
    const inspectionDriver = storageDriver(storage)
    await inspectionDriver.open()
    try {
      const [space, episodes, operations, lifecycles] = await Promise.all([
        inspectionDriver.getSpace(spaceId),
        Promise.all(options.episodeIds.map((id) => inspectionDriver.get('episode', spaceId, id))),
        Promise.all(
          options.operationIds.map((id) => inspectionDriver.get('operation', spaceId, id)),
        ),
        inspectionDriver.query({ kind: 'lifecycle', spaceId, limit: 100 }),
      ])
      const operationSet = new Set(options.operationIds)
      return {
        spaceExists: space !== null,
        generation: space?.generation ?? null,
        revision: space?.revision ?? null,
        episodes: options.episodeIds.filter((_, index) => episodes[index] !== null),
        operations: operations
          .filter((operation) => operation !== null)
          .map((operation) => ({
            id: operation.id,
            state: operation.state,
            stage: operation.stage,
          })),
        lifecycles: lifecycles
          .filter((lifecycle) => operationSet.has(lifecycle.operationId))
          .map((lifecycle) => ({
            operationId: lifecycle.operationId,
            action: lifecycle.action,
            targetId: lifecycle.target.id,
          })),
      }
    } finally {
      await inspectionDriver.close()
    }
  },

  async attemptCrashIngest(input?: unknown) {
    const request = input as { episodeId: string; operationId: string }
    try {
      const report = await requiredMemory().remember(
        {
          id: request.episodeId,
          kind: 'assertion',
          content: { type: 'text', text: `Abrupt recovery fixture ${request.episodeId}.` },
          source: { kind: 'independent-crash-test' },
          assertions: {
            entities: [{ id: `${request.episodeId}-entity`, name: request.episodeId }],
            facts: [
              {
                id: `${request.episodeId}-fact`,
                subject: { id: `${request.episodeId}-entity` },
                predicate: 'survives_runtime_termination',
                object: { scalar: true },
              },
            ],
          },
        },
        { operationId: request.operationId },
      )
      return {
        ok: true,
        revision: (await stats()).revision,
        operation: {
          id: report.operation.id,
          state: report.operation.state,
          stage: report.operation.stage,
        },
        episodeId: report.episode.id,
        createdFacts: report.facts.created,
      }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptRetryEpisode(input?: unknown) {
    const request = input as { episodeId: string; operationId: string }
    try {
      const report = await requiredMemory().retryEpisode(request.episodeId, {
        operationId: request.operationId,
      })
      return {
        ok: true,
        revision: (await stats()).revision,
        operation: {
          id: report.operation.id,
          state: report.operation.state,
          stage: report.operation.stage,
        },
        episodeId: report.episode.id,
        createdFacts: report.facts.created,
        repeatedFacts: report.facts.repeated,
      }
    } catch (error) {
      return failure(error)
    }
  },

  async ingestionDiagnostics(input?: unknown) {
    if (driver === undefined) throw new Error('independent context storage is not open')
    const request = input as { episodeId: string; operationIds: string[] }
    const operationSet = new Set(request.operationIds)
    const [episode, entity, fact, operations, changes, lifecycle, currentStats] = await Promise.all(
      [
        driver.get('episode', spaceId, request.episodeId),
        driver.get('entity', spaceId, `${request.episodeId}-entity`),
        driver.get('fact', spaceId, `${request.episodeId}-fact`),
        Promise.all(request.operationIds.map((id) => driver!.get('operation', spaceId, id))),
        driver.query({ kind: 'change', spaceId, limit: 100 }),
        driver.query({ kind: 'lifecycle', spaceId, limit: 100 }),
        stats(),
      ],
    )
    return {
      revision: currentStats.revision,
      episode: episode !== null,
      entity: entity !== null,
      fact: fact === null ? null : fact.status,
      operations: operations
        .filter((operation) => operation !== null)
        .map((operation) => ({
          id: operation.id,
          state: operation.state,
          stage: operation.stage,
          warnings: operation.warnings,
          runtimeOwnerId: operation.runtimeOwnerId ?? null,
        }))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
      changes: changes
        .filter((change) => operationSet.has(change.operationId))
        .map((change) => ({ operationId: change.operationId, phase: change.phase }))
        .sort((left, right) =>
          left.operationId < right.operationId
            ? -1
            : left.operationId > right.operationId
              ? 1
              : left.phase < right.phase
                ? -1
                : left.phase > right.phase
                  ? 1
                  : 0,
        ),
      lifecycle: lifecycle
        .filter((transition) => transition.target.id === request.episodeId)
        .map((transition) => ({ action: transition.action, operationId: transition.operationId }))
        .sort((left, right) =>
          left.operationId < right.operationId
            ? -1
            : left.operationId > right.operationId
              ? 1
              : left.action < right.action
                ? -1
                : left.action > right.action
                  ? 1
                  : 0,
        ),
    }
  },

  async prepareSyncSource(input?: unknown) {
    const request = input as {
      endpoint: `indxdb://${string}`
      worker: boolean
      checkpointOperationId: string
    }
    const source = await openIndependentSyncSource(request.endpoint, request.worker, true)
    for (const suffix of ['a', 'b'] as const) {
      await source.remember({
        id: `sync-crash-episode-${suffix}`,
        kind: 'assertion',
        content: { type: 'text', text: `Sync crash source ${suffix}.` },
        source: { kind: 'independent-sync-crash-test' },
        assertions: {
          entities: [{ id: `sync-crash-entity-${suffix}`, name: `Sync crash ${suffix}` }],
          facts: [
            {
              id: `sync-crash-fact-${suffix}`,
              subject: { id: `sync-crash-entity-${suffix}` },
              predicate: 'survives_sync_owner_termination',
              object: { scalar: suffix },
            },
          ],
        },
      })
    }
    const checkpoint = await source.createSyncCheckpoint(
      { access, confirmSpaceId: spaceId },
      { operationId: request.checkpointOperationId },
    )
    return { checkpointId: checkpoint.id, records: checkpoint.recordCount }
  },

  async openSyncSource(input?: unknown) {
    const request = input as { endpoint: `indxdb://${string}`; worker: boolean }
    const source = await openIndependentSyncSource(request.endpoint, request.worker, false)
    const checkpoint = await source.syncHead(access)
    if (checkpoint === null) throw new Error('independent sync source has no checkpoint')
    return { checkpointId: checkpoint.id, records: checkpoint.recordCount }
  },

  async attemptCrashSyncApply(input?: unknown) {
    const request = input as { sessionId: string; operationId: string }
    return runSyncApply(request)
  },

  async attemptSyncApply(input?: unknown) {
    const request = input as { sessionId: string; operationId: string }
    return runSyncApply(request)
  },

  async attemptSyncAbort(input?: unknown) {
    const request = input as { sessionId: string }
    return runSyncAbort(request)
  },

  async syncDiagnostics(input?: unknown) {
    if (driver === undefined) throw new Error('independent context storage is not open')
    const request = input as { sessionId: string; operationId: string }
    const [space, session, operation, head, episodes, entities, facts, operations, changes] =
      await Promise.all([
        driver.getSpace(spaceId),
        driver.get('sync_session', spaceId, request.sessionId),
        driver.get('operation', spaceId, request.operationId),
        driver.get('sync_ref', spaceId, 'head'),
        driver.query({ kind: 'episode', spaceId, limit: 100 }),
        driver.query({ kind: 'entity', spaceId, limit: 100 }),
        driver.query({ kind: 'fact', spaceId, limit: 100 }),
        driver.query({ kind: 'operation', spaceId, limit: 100 }),
        driver.query({ kind: 'change', spaceId, limit: 100 }),
      ])
    return {
      revision: space?.revision ?? null,
      session:
        session === null
          ? null
          : {
              id: session.id,
              state: session.state,
              operationId: session.operationId ?? null,
              rollback: session.rollback ?? false,
              localHead: session.localHead ?? null,
              appliedRecords: session.appliedRecords,
              deletedRecords: session.deletedRecords,
              applyLocalKey: session.applyLocalKey ?? null,
              applyTargetKey: session.applyTargetKey ?? null,
              targetCheckpoint: session.targetCheckpoint ?? null,
              checkpointId: session.checkpointId ?? null,
            },
      operation:
        operation === null
          ? null
          : {
              id: operation.id,
              state: operation.state,
              stage: operation.stage,
              attempts: operation.attempts,
              runtimeOwnerId: operation.runtimeOwnerId ?? null,
            },
      head: head?.head ?? null,
      episodes: episodes
        .map((episode) => episode.id)
        .filter((id) => id.startsWith('sync-crash-'))
        .sort(),
      entities: entities
        .map((entity) => entity.id)
        .filter((id) => id.startsWith('sync-crash-'))
        .sort(),
      facts: facts
        .map((fact) => ({ id: fact.id, status: fact.status }))
        .filter((fact) => fact.id.startsWith('sync-crash-'))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
      syncOperations: operations
        .filter((item) => item.kind === 'sync')
        .map((item) => ({ id: item.id, state: item.state, attempts: item.attempts }))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
      syncChanges: changes
        .filter((change) => change.operationId === request.operationId && change.phase === 'sync')
        .map((change) => ({ revision: change.revision, phase: change.phase }))
        .sort((left, right) => left.revision - right.revision),
    }
  },

  async stats() {
    return stats()
  },

  async journalStats() {
    const result = await requiredMemory().stats()
    return {
      revision: result.snapshotRevision,
      changes: result.changes,
      changesCompactedThrough: result.changesCompactedThrough,
      signalChanges: result.signalChanges,
      signalChangesCompactedThrough: result.signalChangesCompactedThrough,
    }
  },

  async changeBaseline() {
    const snapshot = await requiredMemory().snapshot({ access })
    return {
      cursor: snapshot.changesCursor,
      revision: snapshot.snapshotRevision,
    }
  },

  async registerJournalConsumer(input?: unknown) {
    const request = input as { id: string; journal: 'semantic' | 'signal'; cursor: string }
    return requiredMemory().registerJournalConsumer(request)
  },

  async acknowledgeJournalConsumer(input?: unknown) {
    const request = input as { id: string; journal: 'semantic' | 'signal'; cursor: string }
    return requiredMemory().acknowledgeJournalConsumer(request)
  },

  async journalConsumers(input?: unknown) {
    const request = input as { journal: 'semantic' | 'signal' }
    return requiredMemory().journalConsumers({ journal: request.journal, state: 'all', limit: 100 })
  },

  async attemptDeriveFact(input?: unknown) {
    const request = input as {
      kind: 'root' | 'leaf'
      expectedRevision: number
      operationId: string
    }
    const root = request.kind === 'root'
    try {
      const report = await requiredMemory().deriveFact(
        {
          conclusion: {
            id: root ? 'independent-derived-root' : 'independent-derived-leaf',
            subjectId: 'shared-entity',
            predicate: root ? 'independent_root' : 'independent_leaf',
            object: { kind: 'scalar', value: true },
          },
          rule: {
            id: root ? 'independent/root-rule' : 'independent/leaf-rule',
            version: '1',
          },
          premises: [
            {
              kind: 'fact',
              id: root ? 'shared-fact' : 'independent-derived-root',
            },
          ],
          method: 'deterministic',
          access,
          expectedRevision: request.expectedRevision,
        },
        { operationId: request.operationId },
      )
      return {
        ok: true,
        revision: (await stats()).revision,
        operationId: report.operation.id,
        outcome: report.outcome,
        derivation: {
          id: report.derivation.id,
          version: report.derivation.version,
          state: report.derivation.state,
        },
        conclusion: { id: report.conclusion.id, status: report.conclusion.status },
        invalidatedDerivations: report.invalidatedDerivations,
        unsupportedFacts: report.unsupportedFacts,
      }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptDeriveFacts(input?: unknown) {
    const request = input as { expectedRevision: number; operationId: string }
    try {
      const report = await requiredMemory().deriveFacts(
        {
          derivations: [
            {
              conclusion: {
                id: 'independent-batch-derived-one',
                subjectId: 'shared-entity',
                predicate: 'independent_batch_one',
                object: { kind: 'scalar', value: true },
              },
              rule: { id: 'independent/batch-rule', version: '1' },
              premises: [{ kind: 'fact', id: 'shared-fact' }],
            },
            {
              conclusion: {
                id: 'independent-batch-derived-two',
                subjectId: 'shared-entity',
                predicate: 'independent_batch_two',
                object: { kind: 'scalar', value: true },
              },
              rule: { id: 'independent/batch-rule', version: '1' },
              premises: [{ kind: 'fact', id: 'shared-fact' }],
            },
          ],
          access,
          expectedRevision: request.expectedRevision,
        },
        { operationId: request.operationId },
      )
      return {
        ok: true,
        revision: (await stats()).revision,
        operationId: report.operation.id,
        results: report.results.map((result) => ({
          outcome: result.outcome,
          derivation: {
            id: result.derivation.id,
            version: result.derivation.version,
            state: result.derivation.state,
          },
          conclusion: { id: result.conclusion.id, status: result.conclusion.status },
        })),
        invalidatedDerivations: report.invalidatedDerivations,
        unsupportedFacts: report.unsupportedFacts,
      }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptWithdrawDerivation(input?: unknown) {
    const request = input as {
      derivationId: string
      expectedRevision: number
      operationId: string
    }
    try {
      const report = await requiredMemory().withdrawDerivation(
        {
          derivationId: request.derivationId,
          access,
          expectedRevision: request.expectedRevision,
          reason: 'independent rule retirement',
        },
        { operationId: request.operationId },
      )
      return {
        ok: true,
        revision: (await stats()).revision,
        operationId: report.operation.id,
        outcome: report.outcome,
        derivation: {
          id: report.derivation.id,
          version: report.derivation.version,
          state: report.derivation.state,
        },
        conclusion: { id: report.conclusion.id, status: report.conclusion.status },
        invalidatedDerivations: report.invalidatedDerivations,
        unsupportedFacts: report.unsupportedFacts,
      }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptWithdrawDerivations(input?: unknown) {
    const request = input as {
      expectedRevision: number
      operationId: string
      selectionCursor?: string
    }
    try {
      const report = await requiredMemory().withdrawDerivations(
        {
          where: {
            ruleIds: ['independent/batch-rule'],
            ruleVersions: ['1'],
          },
          access,
          expectedRevision: request.expectedRevision,
          maxMatches: 2,
          ...(request.selectionCursor === undefined
            ? {}
            : { selectionCursor: request.selectionCursor }),
          reason: 'independent batch rule retirement',
        },
        { operationId: request.operationId },
      )
      return {
        ok: true,
        revision: (await stats()).revision,
        operationId: report.operation.id,
        withdrawals: report.withdrawals,
        invalidatedDerivations: report.invalidatedDerivations,
        unsupportedFacts: report.unsupportedFacts,
      }
    } catch (error) {
      return failure(error)
    }
  },

  async previewDerivationWithdrawals() {
    try {
      const preview = await requiredMemory().previewDerivationWithdrawals({
        where: {
          ruleIds: ['independent/batch-rule'],
          ruleVersions: ['1'],
        },
        access,
        maxMatches: 2,
      })
      return {
        ok: true,
        revision: preview.snapshotRevision,
        selectionCursor: preview.selectionCursor,
        derivationIds: preview.derivations.map((derivation) => derivation.id),
      }
    } catch (error) {
      return failure(error)
    }
  },

  async derivationDiagnostics(input?: unknown) {
    if (driver === undefined) throw new Error('independent context storage is not open')
    const request = input as { operationIds: string[] }
    const selectedConclusions = new Set(['independent-derived-root', 'independent-derived-leaf'])
    const derivations = (await driver.query({ kind: 'derivation', spaceId, limit: 100 }))
      .filter((record) => selectedConclusions.has(record.conclusionFactId))
      .sort(
        (left, right) =>
          (left.conclusionFactId < right.conclusionFactId
            ? -1
            : left.conclusionFactId > right.conclusionFactId
              ? 1
              : 0) || left.version - right.version,
      )
    const facts = await Promise.all(
      [...selectedConclusions].sort().map(async (id) => {
        const fact = await driver!.get('fact', spaceId, id)
        return { id, status: fact?.status ?? null }
      }),
    )
    const operations = (
      await Promise.all(
        request.operationIds.map(async (id) => ({
          id,
          exists: (await driver!.get('operation', spaceId, id)) !== null,
        })),
      )
    )
      .filter((operation) => operation.exists)
      .map((operation) => operation.id)
      .sort()
    const operationSet = new Set(request.operationIds)
    const changes = (await driver.query({ kind: 'change', spaceId, limit: 100 }))
      .filter((change) => operationSet.has(change.operationId))
      .map((change) => ({ operationId: change.operationId, phase: change.phase }))
      .sort((left, right) =>
        left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0,
      )
    return {
      facts,
      derivations: derivations.map((derivation) => ({
        id: derivation.id,
        conclusionFactId: derivation.conclusionFactId,
        version: derivation.version,
        state: derivation.state,
        operationId: derivation.operationId,
        supersedes: derivation.supersedes ?? null,
        invalidPremises: derivation.invalidPremises?.length ?? 0,
      })),
      operations,
      changes,
    }
  },

  async derivationBatchDiagnostics(input?: unknown) {
    if (driver === undefined) throw new Error('independent context storage is not open')
    const request = input as { operationIds: string[] }
    const selectedConclusions = new Set([
      'independent-batch-derived-one',
      'independent-batch-derived-two',
    ])
    const derivations = (await driver.query({ kind: 'derivation', spaceId, limit: 100 }))
      .filter((record) => selectedConclusions.has(record.conclusionFactId))
      .sort((left, right) =>
        left.conclusionFactId < right.conclusionFactId
          ? -1
          : left.conclusionFactId > right.conclusionFactId
            ? 1
            : left.version - right.version,
      )
    const facts = await Promise.all(
      [...selectedConclusions].sort().map(async (id) => {
        const fact = await driver!.get('fact', spaceId, id)
        return { id, status: fact?.status ?? null }
      }),
    )
    const operations = (
      await Promise.all(
        request.operationIds.map(async (id) => ({
          id,
          exists: (await driver!.get('operation', spaceId, id)) !== null,
        })),
      )
    )
      .filter((operation) => operation.exists)
      .map((operation) => operation.id)
      .sort()
    const operationSet = new Set(request.operationIds)
    const changes = (await driver.query({ kind: 'change', spaceId, limit: 100 }))
      .filter((change) => operationSet.has(change.operationId))
      .map((change) => ({ operationId: change.operationId, phase: change.phase }))
      .sort((left, right) =>
        left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0,
      )
    return {
      facts,
      derivations: derivations.map((derivation) => ({
        id: derivation.id,
        conclusionFactId: derivation.conclusionFactId,
        version: derivation.version,
        state: derivation.state,
        operationId: derivation.operationId,
        supersedes: derivation.supersedes ?? null,
      })),
      operations,
      changes,
    }
  },

  async signalBaseline() {
    const page = await requiredMemory().browseSignals({ access })
    return {
      cursor: page.signalChangesCursor,
      revision: page.snapshotRevision,
      total: page.total,
    }
  },

  async putSignal(input?: unknown) {
    const request = input as { suffix: string; expectedRevision: number }
    try {
      const report = await requiredMemory().putSignals({
        access,
        expectedRevision: request.expectedRevision,
        signals: [
          {
            namespace: 'independent-context',
            slot: request.suffix,
            target: { kind: 'episode', id: 'shared-episode' },
            producer: { kind: 'manual', id: `page-${request.suffix}`, version: '1' },
            scopes: [],
            value: request.suffix,
          },
        ],
      })
      return { ok: true, revision: report.revision, signalId: report.signals[0]?.id }
    } catch (error) {
      return failure(error)
    }
  },

  async putSignalTargets(input?: unknown) {
    const request = input as {
      targets: { namespace: string; slot: string; targetId: string }[]
    }
    const baseline = await requiredMemory().browseSignals({ access })
    const report = await requiredMemory().putSignals({
      access,
      expectedRevision: baseline.snapshotRevision,
      signals: request.targets.map((target) => ({
        namespace: target.namespace,
        slot: target.slot,
        target: { kind: 'episode' as const, id: target.targetId },
        producer: {
          kind: 'algorithm' as const,
          id: `signal-target-${target.slot}`,
          version: '1',
        },
        scopes: [],
        basis: { episodeIds: [target.targetId] },
        value: { recommendation: 'forget' },
      })),
    })
    return { revision: report.revision, signalIds: report.signals.map((signal) => signal.id) }
  },

  async previewSignalTargets(input?: unknown) {
    const request = input as { namespace: string }
    const page = await requiredMemory().browseSignals({
      access,
      where: { namespaces: [request.namespace] },
      order: 'key',
      limit: 1,
    })
    return {
      revision: page.snapshotRevision,
      total: page.total,
      selectionCursor: page.targetSelectionCursor ?? null,
    }
  },

  async attemptSignalTargetAction(input?: unknown) {
    const request = input as {
      action: 'soft-delete' | 'hard-purge'
      namespace: string
      selectionCursor: string
      operationId: string
    }
    const where = { namespaces: [request.namespace] }
    try {
      const report =
        request.action === 'soft-delete'
          ? await requiredMemory().deleteEpisodes(
              {
                access,
                signalTargets: { where, selectionCursor: request.selectionCursor },
                maxMatches: 1,
              },
              { operationId: request.operationId },
            )
          : await requiredMemory().hardPurge(
              {
                access,
                signalTargets: { where, selectionCursor: request.selectionCursor },
                maxMatches: 1,
              },
              { operationId: request.operationId },
            )
      return {
        ok: true,
        action: request.action,
        revision: (await stats()).revision,
        operationId: report.operation.id,
        affectedEpisodes: report.affectedEpisodes,
        purged: report.purged,
      }
    } catch (error) {
      return failure(error)
    }
  },

  async signalTargetActionDiagnostics(input?: unknown) {
    if (driver === undefined) throw new Error('independent context storage is not open')
    const request = input as {
      targetIds: string[]
      namespaces: string[]
      operationIds: string[]
    }
    const namespaceSet = new Set(request.namespaces)
    const operationSet = new Set(request.operationIds)
    const [space, episodes, signals, operations, lifecycles, markers, changes, signalChanges] =
      await Promise.all([
        driver.getSpace(spaceId),
        Promise.all(request.targetIds.map((id) => driver!.get('episode', spaceId, id))),
        driver.query({ kind: 'signal', spaceId, limit: 100 }),
        Promise.all(request.operationIds.map((id) => driver!.get('operation', spaceId, id))),
        driver.query({ kind: 'lifecycle', spaceId, limit: 100 }),
        driver.query({ kind: 'purge', spaceId, limit: 100 }),
        driver.query({ kind: 'change', spaceId, limit: 100 }),
        driver.query({ kind: 'signal_change', spaceId, limit: 100 }),
      ])
    return {
      revision: space?.revision ?? null,
      episodes: request.targetIds.map((id, index) => ({
        id,
        exists: episodes[index] !== null,
        retentionState: episodes[index]?.retentionState ?? null,
      })),
      signals: signals
        .filter((signal) => namespaceSet.has(signal.namespace))
        .map((signal) => ({
          namespace: signal.namespace,
          slot: signal.slot,
          version: signal.version,
          state: signal.state,
          targetId: signal.target.id,
        }))
        .sort((left, right) =>
          left.namespace === right.namespace
            ? left.version - right.version
            : left.namespace < right.namespace
              ? -1
              : 1,
        ),
      operations: operations
        .filter((operation) => operation !== null)
        .map((operation) => ({
          id: operation.id,
          kind: operation.kind,
          state: operation.state,
          stage: operation.stage,
        }))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
      lifecycles: lifecycles
        .filter((lifecycle) => operationSet.has(lifecycle.operationId))
        .map((lifecycle) => ({
          operationId: lifecycle.operationId,
          targetId: lifecycle.target.id,
          action: lifecycle.action,
        }))
        .sort((left, right) =>
          left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0,
        ),
      markers: markers
        .filter((marker) => operationSet.has(marker.operationId))
        .map((marker) => ({
          operationId: marker.operationId,
          state: marker.state,
          targets: marker.targets.length,
          completedTargets: marker.completedTargets.length,
        })),
      semanticChanges: changes
        .filter((change) => operationSet.has(change.operationId))
        .map((change) => ({
          operationId: change.operationId,
          revision: change.revision,
          phase: change.phase,
        })),
      signalChanges: signalChanges.map((change) => ({
        revision: change.revision,
        action: change.action,
        invalidated: change.partitions.some((partition) => partition.invalidated === true),
      })),
    }
  },

  async signals() {
    const page = await requiredMemory().browseSignals({ access, order: 'key', limit: 100 })
    return {
      revision: page.snapshotRevision,
      total: page.total,
      ids: page.signals.map((signal) => signal.id).sort(),
      slots: page.signals.map((signal) => signal.slot).sort(),
    }
  },

  async signalHistory(input?: unknown) {
    const request = input as { slot: string }
    const page = await requiredMemory().browseSignals({
      access,
      revisionView: 'history',
      where: { slots: [request.slot] },
      order: 'key',
      limit: 100,
    })
    return {
      revision: page.snapshotRevision,
      total: page.total,
      revisions: page.signals
        .map((signal) => ({ id: signal.id, version: signal.version, state: signal.state }))
        .sort((left, right) => left.version - right.version),
    }
  },

  async attemptDeleteSignals(input?: unknown) {
    const request = input as {
      mode: 'withdraw' | 'purge'
      slot: string
      states?: MemorySignalState[]
      expectedRevision: number
    }
    try {
      const report = await requiredMemory().deleteSignals({
        access,
        mode: request.mode,
        where: {
          slots: [request.slot],
          ...(request.states === undefined ? {} : { states: request.states }),
        },
        expectedRevision: request.expectedRevision,
        maxMatches: 1,
        ...(request.mode === 'withdraw'
          ? { reason: 'independent-context contention probe' }
          : { maxRevisions: 10 }),
      })
      return {
        ok: true,
        mode: report.mode,
        revision: report.revision,
        matchedSignals: report.matchedSignals,
        affectedKeys: report.affectedKeys,
        withdrawn: report.withdrawn.length,
        deletedRevisions: report.deletedRevisions,
      }
    } catch (error) {
      return failure(error)
    }
  },

  async signalChanges(input?: unknown) {
    const request = input as { cursor: string }
    try {
      const page = await requiredMemory().signalChanges({
        access,
        cursor: request.cursor,
        limit: 100,
      })
      return {
        ok: true,
        revision: page.currentRevision,
        actions: page.changes.map((change) => change.action),
      }
    } catch (error) {
      return failure(error)
    }
  },

  async changesFromCursor(input?: unknown) {
    const request = input as { cursor: string }
    try {
      const page = await requiredMemory().changes({
        access,
        cursor: request.cursor,
        limit: 100,
      })
      return {
        ok: true,
        revision: page.currentRevision,
        phases: page.changes.map((change) => change.phase),
      }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptCompactChanges(input?: unknown) {
    const request = input as { expectedRevision: number; cursor: string; registered?: true }
    try {
      const report = await requiredMemory().compactChanges({
        confirmSpaceId: spaceId,
        ...(request.registered === true
          ? { registeredConsumers: true as const }
          : { consumerCursors: [request.cursor] }),
        expectedRevision: request.expectedRevision,
        maxChanges: 100,
      })
      return { ok: true, ...report }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptCompactSignalChanges(input?: unknown) {
    const request = input as { expectedRevision: number; cursor: string; registered?: true }
    try {
      const report = await requiredMemory().compactSignalChanges({
        confirmSpaceId: spaceId,
        ...(request.registered === true
          ? { registeredConsumers: true as const }
          : { consumerCursors: [request.cursor] }),
        expectedRevision: request.expectedRevision,
        maxChanges: 100,
      })
      return { ok: true, ...report }
    } catch (error) {
      return failure(error)
    }
  },

  async resetAndRecreate() {
    await requiredMemory().resetSpace({ confirmSpaceId: spaceId })
    await requiredMemory().open({ create: true })
    return stats()
  },

  async attemptStats() {
    try {
      return { ok: true, ...(await stats()) }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptSnapshot() {
    try {
      const result = await requiredMemory().snapshot({ access })
      return { ok: true, revision: result.snapshotRevision, episodes: result.episodes.length }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptRecall() {
    try {
      const result = await requiredMemory().recall({
        query: 'independent contexts durable memory',
        access,
        limit: 10,
      })
      return { ok: true, revision: result.snapshotRevision, episodes: result.episodes.length }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptPointRead() {
    try {
      const result = await requiredMemory().read({
        kind: 'entity',
        id: 'shared-entity',
        access,
      })
      return { ok: true, revision: result.snapshotRevision, found: result.value !== null }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptBrowse() {
    try {
      const result = await requiredMemory().browse({
        kind: 'episode',
        access,
        order: 'id',
        limit: 10,
      })
      return { ok: true, revision: result.snapshotRevision, items: result.items.length }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptNeighborhood() {
    try {
      const result = await requiredMemory().neighborhood({
        entityId: 'shared-entity',
        access,
        depth: 1,
      })
      return { ok: true, revision: result.snapshotRevision, nodes: result.entities.length }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptAnalyze() {
    try {
      const result = await requiredMemory().analyze({ access })
      return { ok: true, revision: result.snapshotRevision, nodes: result.graph.nodes }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptExport() {
    try {
      const result = await requiredMemory().export({ access, complete: true })
      return {
        ok: true,
        revision: result.snapshotRevision,
        episodes: result.canonical.episodes.length,
      }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptIntegrity() {
    try {
      const result = await requiredMemory().verifyIntegrity()
      return { ok: true, revision: result.snapshotRevision, integrity: result.ok }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptProjectionRebuild(input?: unknown) {
    const request = input as { operationId: string }
    try {
      const report = await requiredMemory().rebuildProjections(
        { kinds: ['lexical'] },
        { operationId: request.operationId },
      )
      return {
        ok: true,
        operation: {
          id: report.operation.id,
          state: report.operation.state,
          stage: report.operation.stage,
        },
        rebuilt: report.rebuilt,
        failed: report.failed,
        staleRemaining: report.staleRemaining,
        activeSet: report.activeProjectionSets.find((set) => set.kind === 'lexical') ?? null,
      }
    } catch (error) {
      return failure(error)
    }
  },

  async projectionRebuildDiagnostics(input?: unknown) {
    if (driver === undefined) throw new Error('independent context storage is not open')
    const request = input as { operationIds: string[] }
    const [space, operations, projections] = await Promise.all([
      driver.getSpace(spaceId),
      Promise.all(request.operationIds.map((id) => driver!.get('operation', spaceId, id))),
      driver.query({ kind: 'projection', spaceId, limit: 100 }),
    ])
    const activeSet = space?.projectionSets?.lexical
    const lexical = projections.filter((projection) => projection.projectionKind === 'lexical')
    return {
      revision: space?.revision ?? null,
      canonicalRevision: space?.canonicalRevision ?? null,
      activeSet:
        activeSet === undefined
          ? null
          : {
              id: activeSet.id,
              operationId: activeSet.operationId,
              sourceCanonicalRevision: activeSet.sourceCanonicalRevision,
            },
      operations: operations
        .filter((operation) => operation !== null)
        .map((operation) => ({
          id: operation.id,
          state: operation.state,
          stage: operation.stage,
          runtimeOwnerId: operation.runtimeOwnerId ?? null,
        }))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
      projectionRows: lexical.length,
      activeRows: lexical.filter(
        (projection) => projection.state === 'ready' && projection.setId === activeSet?.id,
      ).length,
      buildingRows: lexical.filter((projection) => projection.state === 'building').length,
      inactiveRows: lexical.filter(
        (projection) => projection.state !== 'ready' || projection.setId !== activeSet?.id,
      ).length,
      setIds: [...new Set(lexical.map((projection) => projection.setId ?? '$legacy'))].sort(),
    }
  },

  async attemptInspect() {
    try {
      const result = await requiredMemory().inspect()
      return { ok: true, state: result.state, projections: result.staleProjections }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptSignalBrowse() {
    try {
      const result = await requiredMemory().browseSignals({ access })
      return { ok: true, revision: result.snapshotRevision, signals: result.total }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptChanges() {
    try {
      const result = await requiredMemory().changes({ access })
      return { ok: true, revision: result.currentRevision, changes: result.changes.length }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptSignalChanges() {
    try {
      const result = await requiredMemory().signalChanges({ access })
      return { ok: true, revision: result.currentRevision, changes: result.changes.length }
    } catch (error) {
      return failure(error)
    }
  },

  async attemptHardPurge(input?: unknown) {
    const request = (input ?? {}) as {
      allCanonical?: boolean
      targetId?: string
      operationId?: string
    }
    const targetId = request.targetId ?? 'shared-episode'
    const operationId = request.operationId ?? 'independent-hard-purge-race'
    try {
      const report = await requiredMemory().hardPurge(
        {
          access,
          episodeIds: [targetId],
          ...(request.allCanonical === true
            ? { entityIds: ['shared-entity'], factIds: ['shared-fact'] }
            : {}),
        },
        { operationId },
      )
      return {
        ok: true,
        purged: report.purged,
        affectedEpisodes: report.affectedEpisodes,
      }
    } catch (error) {
      return failure(error)
    }
  },

  async purgeDiagnostics() {
    if (driver === undefined) throw new Error('independent context storage is not open')
    const [target, operation, markers] = await Promise.all([
      driver.get('episode', spaceId, 'shared-episode'),
      driver.get('operation', spaceId, 'independent-hard-purge-race'),
      driver.query({ kind: 'purge', spaceId }),
    ])
    return {
      targetExists: target !== null,
      operationExists: operation !== null,
      markerStates: markers
        .filter((marker) => marker.operationId === 'independent-hard-purge-race')
        .map((marker) => marker.state)
        .sort(),
    }
  },

  async purgeRecoveryDiagnostics() {
    if (driver === undefined) throw new Error('independent context storage is not open')
    const [space, target, entity, fact, operation, markers, changes, syncMetadataEntries] =
      await Promise.all([
        driver.getSpace(spaceId),
        driver.get('episode', spaceId, 'shared-episode'),
        driver.get('entity', spaceId, 'shared-entity'),
        driver.get('fact', spaceId, 'shared-fact'),
        driver.get('operation', spaceId, 'independent-hard-purge-race'),
        driver.query({ kind: 'purge', spaceId, limit: 100 }),
        driver.query({ kind: 'change', spaceId, limit: 100 }),
        Promise.all(
          [...SYNC_METADATA_KINDS].map(async (kind) => {
            const records = await driver!.query({ kind, spaceId, limit: 100 })
            return [kind, records.length] as const
          }),
        ),
      ])
    const syncMetadata = Object.fromEntries(syncMetadataEntries)
    return {
      revision: space?.revision ?? null,
      targetExists: target !== null,
      entityExists: entity !== null,
      factExists: fact !== null,
      operation:
        operation === null
          ? null
          : {
              id: operation.id,
              state: operation.state,
              stage: operation.stage,
              attempts: operation.attempts,
              runtimeOwnerId: operation.runtimeOwnerId ?? null,
            },
      markers: markers
        .filter((marker) => marker.operationId === 'independent-hard-purge-race')
        .map((marker) => ({
          state: marker.state,
          targets: marker.targets.length,
          completedTargets: marker.completedTargets.length,
          hasWorkLimits: marker.workLimits !== undefined,
          hasRequestHash: marker.requestHash !== undefined,
        })),
      syncMetadata,
      syncMetadataTotal: Object.values(syncMetadata).reduce((total, count) => total + count, 0),
      semanticChanges: changes
        .filter((change) => change.operationId === 'independent-hard-purge-race')
        .map((change) => ({ revision: change.revision, phase: change.phase })),
    }
  },

  async competingPurgeDiagnostics(input?: unknown) {
    if (driver === undefined) throw new Error('independent context storage is not open')
    const request = input as { targetIds: string[]; operationIds: string[] }
    const operationSet = new Set(request.operationIds)
    const [space, targets, operations, markers, changes] = await Promise.all([
      driver.getSpace(spaceId),
      Promise.all(
        request.targetIds.map(async (id) => ({
          id,
          exists: (await driver!.get('episode', spaceId, id)) !== null,
        })),
      ),
      Promise.all(request.operationIds.map((id) => driver!.get('operation', spaceId, id))),
      driver.query({ kind: 'purge', spaceId, limit: 100 }),
      driver.query({ kind: 'change', spaceId, limit: 100 }),
    ])
    return {
      revision: space?.revision ?? null,
      targets,
      operations: operations
        .filter((operation) => operation !== null)
        .map((operation) => ({
          id: operation.id,
          state: operation.state,
          stage: operation.stage,
          attempts: operation.attempts,
          runtimeOwnerId: operation.runtimeOwnerId ?? null,
        }))
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
      markers: markers
        .filter((marker) => operationSet.has(marker.operationId))
        .map((marker) => ({
          operationId: marker.operationId,
          state: marker.state,
          targets: marker.targets.length,
          completedTargets: marker.completedTargets.length,
        }))
        .sort((left, right) =>
          left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0,
        ),
      semanticChanges: changes
        .filter((change) => operationSet.has(change.operationId))
        .map((change) => ({
          operationId: change.operationId,
          revision: change.revision,
          phase: change.phase,
        }))
        .sort((left, right) => left.revision - right.revision),
    }
  },

  async createCheckpoint(input?: unknown) {
    const request = input as { operationId: string }
    const before = await stats()
    const checkpoint = await requiredMemory().createSyncCheckpoint(
      { access, confirmSpaceId: spaceId, maxChunkBytes: 64 * 1024 },
      { operationId: request.operationId },
    )
    const after = await stats()
    return {
      checkpointId: checkpoint.id,
      beforeRevision: before.revision,
      afterRevision: after.revision,
    }
  },

  async armReadGate(input?: unknown) {
    const request = input as { kind: StoredRecordKind }
    armReadGate(request.kind)
    return { armed: true }
  },

  async readGateStatus() {
    return { armed: readGate !== undefined, reached: readGate?.reached === true }
  },

  async releaseReadGate() {
    readGate?.release()
    return { released: readGate !== undefined }
  },

  async armDerivationCommitGate() {
    armDerivationCommitPause()
    return { armed: true }
  },

  async derivationCommitGateStatus() {
    return {
      armed: derivationCommitGate !== undefined,
      reached: derivationCommitGate?.reached === true,
    }
  },

  async releaseDerivationCommitGate() {
    derivationCommitGate?.release()
    return { released: derivationCommitGate !== undefined }
  },

  async armOperationCommitGate(input?: unknown) {
    const request = input as {
      operationId: string
      stage: string
      position: 'before' | 'after'
      semantic?: boolean
    }
    armOperationCommitPause(request)
    return { armed: true }
  },

  async armOperationCommitFailure(input?: unknown) {
    const request = input as {
      operationId: string
      stage: string
      semantic?: boolean
      occurrence: number
    }
    armOperationCommitFailure(request)
    return { armed: true }
  },

  async operationCommitGateStatus() {
    return {
      armed: operationCommitGate !== undefined,
      reached: operationCommitGate?.reached === true,
    }
  },

  async releaseOperationCommitGate() {
    operationCommitGate?.release()
    return { released: operationCommitGate !== undefined }
  },

  async armMigrationGate(input?: unknown) {
    const request = input as {
      fromSchemaVersion: string
      toSchemaVersion: string
      position: 'before' | 'after'
    }
    armMigrationPause(request)
    return { armed: true }
  },

  async migrationGateStatus() {
    return { armed: migrationGate !== undefined, reached: migrationGate?.reached === true }
  },

  async releaseMigrationGate() {
    migrationGate?.release()
    return { released: migrationGate !== undefined }
  },

  async armDeleteSpaceGate(input?: unknown) {
    const request = input as { position: 'before' | 'after' }
    armDeleteSpacePause(request.position)
    return { armed: true }
  },

  async deleteSpaceGateStatus() {
    return { armed: deleteSpaceGate !== undefined, reached: deleteSpaceGate?.reached === true }
  },

  async releaseDeleteSpaceGate() {
    deleteSpaceGate?.release()
    return { released: deleteSpaceGate !== undefined }
  },

  async armRecordDeletionCommitGate(input?: unknown) {
    const request = input as { kind: StoredRecordKind; position: 'before' | 'after' }
    armRecordDeletionCommitPause(request)
    return { armed: true }
  },

  async recordDeletionCommitGateStatus() {
    return {
      armed: recordDeletionCommitGate !== undefined,
      reached: recordDeletionCommitGate?.reached === true,
    }
  },

  async releaseRecordDeletionCommitGate() {
    recordDeletionCommitGate?.release()
    return { released: recordDeletionCommitGate !== undefined }
  },

  async reopen() {
    await requiredMemory().close()
    await requiredMemory().open()
    return stats()
  },

  async close() {
    readGate?.release()
    readGate = undefined
    derivationCommitGate?.release()
    derivationCommitGate = undefined
    operationCommitGate?.release()
    operationCommitGate = undefined
    operationCommitFailure = undefined
    migrationGate?.release()
    migrationGate = undefined
    deleteSpaceGate?.release()
    deleteSpaceGate = undefined
    recordDeletionCommitGate?.release()
    recordDeletionCommitGate = undefined
    if (syncSource !== undefined) await syncSource.close()
    syncSource = undefined
    if (memory !== undefined) await memory.close()
    memory = undefined
    driver = undefined
    return { closed: true }
  },
}
