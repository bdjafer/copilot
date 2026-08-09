import { fileURLToPath } from 'node:url'
import { chromium, type Page } from 'playwright'
import { createServer } from 'vite'
import { expect, it } from 'vitest'

it('AC01, AC02, and AC18 persist SurrealDB WASM state through IndexedDB in direct and worker engines', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    optimizeDeps: { exclude: ['@astrale-os/surrealdb-wasm'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error('Vite did not expose a local browser URL')
    for (const worker of [false, true]) {
      const page = await browser.newPage()
      const url = new URL('test/browser/harness.html', origin)
      url.searchParams.set('worker', String(worker))
      await page.goto(url.href)
      try {
        await page.waitForFunction(() => window.__temporalMemoryResult !== undefined, undefined, {
          timeout: 45_000,
        })
      } catch (error) {
        const stage = await page.evaluate(() => window.__temporalMemoryStage)
        const locks = await page.evaluate(async () => {
          if (navigator.locks === undefined) return undefined
          return navigator.locks.query()
        })
        throw new Error(
          `${worker ? 'worker' : 'direct'} browser harness stalled at ${stage ?? 'unknown'}; locks=${JSON.stringify(locks)}`,
          { cause: error },
        )
      }
      const result = await page.evaluate(() => window.__temporalMemoryResult)
      expect(result).toEqual({
        ok: true,
        stats: { episodes: 2, entities: 2, facts: 1 },
        factStatus: 'active',
        recallFacts: expect.arrayContaining([expect.any(String), 'browser-derived']),
        recallLineage: true,
        episodeStoragePaging: true,
        unicodeOrderPaging: true,
        injectionPreserved: true,
        injectionRecall: true,
        concurrentReads: true,
        rawQuerySeparated: true,
        rawQueryTargetGuard: true,
        rawQueryParameterized: true,
        rawQueryBounded: true,
        rawQueryStatementFailure: true,
        rawQueryRequestSnapshotted: true,
        rawQueryUnknownSharedFence: true,
        transactionUnknownSharedFence: true,
        connectionCleanupReusable: true,
        transactionRollbackReusable: true,
        rawQueryClosed: true,
        ingestionIndexedPlanning: true,
        ingestionContextScanBounded: true,
        ingestionProjectionScanBounded: true,
        pointReadScanBounded: true,
        managementScanBounded: true,
        resetScanBounded: true,
        derivationPersisted: true,
        derivationBatchAtomic: true,
        derivationWithdrawalBatchAtomic: true,
        derivationIndexedPlanning: true,
        correctionIndexedPlanning: true,
        retractionIndexedPlanning: true,
        episodeDeletionIndexedPlanning: true,
        episodeDeletionPreviewBound: true,
        hardPurgeIndexedPlanning: true,
        entityMergeIndexedPlanning: true,
        purgeReplayBlocked: true,
        purgeProjectionClosure: true,
        purgeRequestBound: true,
        operationPurgeScrubbed: true,
        activeMergeIndex: true,
        schemaMigrationPersisted: true,
        projectionSetCutover: true,
        projectionSensitivityPersisted: true,
        projectionScanBounded: true,
        changeFeedPersisted: true,
        changePurgeInvalidated: true,
        changePurgeScrubbed: true,
        changeCompactionPersisted: true,
        changeCompactionInvalidated: true,
        journalConsumersPersisted: true,
        constructionOptionsSnapshotted: true,
        facadeOptionsSnapshotted: true,
        publicOutputsDetached: true,
        signalRequestSnapshotted: true,
        coreReadRequestsSnapshotted: true,
        mutationRequestsSnapshotted: true,
        signalBasisScanBounded: true,
        signalPersisted: true,
        signalSoftDeleteAtomic: true,
        signalPurgeClosed: true,
        signalKeyPurgeAtomic: true,
        signalDiagnostics: true,
        retrievalScanBounded: true,
        analysisScanBounded: true,
        snapshotScanBounded: true,
        integrityIndexedPlanning: true,
        signalChangeFeedPersisted: true,
        signalChangePurgeScrubbed: true,
        signalChangeCompactionPersisted: true,
        signalChangeCompactionInvalidated: true,
        boundedCanonicalArchive: true,
        syncRequestsSnapshotted: true,
        syncRoundTripPersisted: true,
        syncCompactionPersisted: true,
        syncInventoryPersisted: true,
        syncBundleExported: true,
      })
      await page.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
}, 120_000)

interface IndependentFailure {
  ok: false
  error: {
    code: string
    retryable: boolean
    operationId?: string
    details?: Record<string, unknown>
  }
}

interface IndependentSuccess {
  ok: true
  revision: number
  signalId?: string
}

interface IndependentSignalDeletionSuccess {
  ok: true
  mode: 'withdraw' | 'purge'
  revision: number
  matchedSignals: number
  affectedKeys: string[]
  withdrawn: number
  deletedRevisions: number
}

interface IndependentSignalTargetActionSuccess {
  ok: true
  action: 'soft-delete' | 'hard-purge'
  revision: number
  operationId: string
  affectedEpisodes: string[]
  purged: boolean
}

interface IndependentEpisodeDeletionPreview {
  ok: true
  revision: number
  selectionCursor?: string
  episodeIds: string[]
}

interface IndependentEpisodeDeletionSuccess {
  ok: true
  revision: number
  operationId: string
  affectedEpisodes: string[]
  unsupportedFacts: string[]
}

interface IndependentEpisodeDeletionDiagnostics {
  revision: number | null
  episodes: { id: string; retentionState: string | null }[]
  operations: string[]
  lifecycle: { operationId: string; targetId: string; action: string }[]
  changes: { operationId: string; phase: string }[]
}

interface IndependentSignalTargetActionDiagnostics {
  revision: number | null
  episodes: { id: string; exists: boolean; retentionState: string | null }[]
  signals: {
    namespace: string
    slot: string
    version: number
    state: string
    targetId: string
  }[]
  operations: { id: string; kind: string; state: string; stage: string }[]
  lifecycles: { operationId: string; targetId: string; action: string }[]
  markers: {
    operationId: string
    state: string
    targets: number
    completedTargets: number
  }[]
  semanticChanges: { operationId: string; revision: number; phase: string }[]
  signalChanges: { revision: number; action: string; invalidated: boolean }[]
}

interface IndependentCompactionSuccess {
  ok: true
  dryRun: false
  requestedThroughRevision: number
  previousCompactedThrough: number
  compactedThrough: number
  batchChanges: number
  deletedChanges: number
  hasMore: boolean
  revision: number
}

interface IndependentDerivationSuccess {
  ok: true
  revision: number
  operationId: string
  outcome: 'created' | 'supported' | 'reactivated' | 'withdrawn'
  derivation: { id: string; version: number; state: string }
  conclusion: { id: string; status: string }
  invalidatedDerivations: string[]
  unsupportedFacts: string[]
}

interface IndependentDerivationBatchSuccess {
  ok: true
  revision: number
  operationId: string
  results: {
    outcome: 'created' | 'supported' | 'reactivated'
    derivation: { id: string; version: number; state: string }
    conclusion: { id: string; status: string }
  }[]
  invalidatedDerivations: string[]
  unsupportedFacts: string[]
}

interface IndependentDerivationWithdrawalBatchSuccess {
  ok: true
  revision: number
  operationId: string
  withdrawals: {
    derivationId: string
    withdrawalId: string
    conclusionFactId: string
  }[]
  invalidatedDerivations: string[]
  unsupportedFacts: string[]
}

interface IndependentDerivationWithdrawalPreview {
  ok: true
  revision: number
  selectionCursor?: string
  derivationIds: string[]
}

interface IndependentDerivationDiagnostics {
  facts: { id: string; status: string | null }[]
  derivations: {
    id: string
    conclusionFactId: string
    version: number
    state: string
    operationId: string
    supersedes: string | null
    invalidPremises: number
  }[]
  operations: string[]
  changes: { operationId: string; phase: string }[]
}

interface IndependentDerivationBatchDiagnostics {
  facts: { id: string; status: string | null }[]
  derivations: {
    id: string
    conclusionFactId: string
    version: number
    state: string
    operationId: string
    supersedes: string | null
  }[]
  operations: string[]
  changes: { operationId: string; phase: string }[]
}

interface IndependentIngestionSuccess {
  ok: true
  revision: number
  operation: { id: string; state: string; stage: string }
  episodeId: string
  createdFacts: string[]
  repeatedFacts?: string[]
}

interface IndependentIngestionDiagnostics {
  revision: number
  episode: boolean
  entity: boolean
  fact: string | null
  operations: {
    id: string
    state: string
    stage: string
    warnings: string[]
    runtimeOwnerId: string | null
  }[]
  changes: { operationId: string; phase: string }[]
  lifecycle: { action: string; operationId: string }[]
}

interface IndependentSyncApplySuccess {
  ok: true
  state: string
  operation: { id: string; state: string; stage: string }
  checkpointId: string | null
  appliedRecords: number
  deletedRecords: number
}

interface IndependentSyncDiagnostics {
  revision: number | null
  session: {
    id: string
    state: string
    operationId: string | null
    rollback: boolean
    localHead: string | null
    appliedRecords: number
    deletedRecords: number
    applyLocalKey: string | null
    applyTargetKey: string | null
    targetCheckpoint: string | null
    checkpointId: string | null
  } | null
  operation: {
    id: string
    state: string
    stage: string
    attempts: number
    runtimeOwnerId: string | null
  } | null
  head: string | null
  episodes: string[]
  entities: string[]
  facts: { id: string; status: string }[]
  syncOperations: { id: string; state: string; attempts: number }[]
  syncChanges: { revision: number; phase: string }[]
}

interface IndependentPurgeRecoveryDiagnostics {
  revision: number | null
  targetExists: boolean
  entityExists: boolean
  factExists: boolean
  operation: {
    id: string
    state: string
    stage: string
    attempts: number
    runtimeOwnerId: string | null
  } | null
  markers: {
    state: string
    targets: number
    completedTargets: number
    hasWorkLimits: boolean
    hasRequestHash: boolean
  }[]
  syncMetadata: Record<string, number>
  syncMetadataTotal: number
  semanticChanges: { revision: number; phase: string }[]
}

interface IndependentCompetingPurgeDiagnostics {
  revision: number | null
  targets: { id: string; exists: boolean }[]
  operations: {
    id: string
    state: string
    stage: string
    attempts: number
    runtimeOwnerId: string | null
  }[]
  markers: {
    operationId: string
    state: string
    targets: number
    completedTargets: number
  }[]
  semanticChanges: { operationId: string; revision: number; phase: string }[]
}

interface IndependentProjectionRebuildSuccess {
  ok: true
  operation: { id: string; state: string; stage: string }
  rebuilt: number
  failed: number
  staleRemaining: number
  activeSet: {
    kind: string
    setId: string
    sourceCanonicalRevision: number
    operationId: string
  } | null
}

interface IndependentProjectionRebuildDiagnostics {
  revision: number | null
  canonicalRevision: number | null
  activeSet: {
    id: string
    operationId: string
    sourceCanonicalRevision: number
  } | null
  operations: {
    id: string
    state: string
    stage: string
    runtimeOwnerId: string | null
  }[]
  projectionRows: number
  activeRows: number
  buildingRows: number
  inactiveRows: number
  setIds: string[]
}

interface IndependentMigrationDiagnostics {
  revision: number | null
  metadataRevision: number | null
  canonicalRevision: number | null
  schemaVersion: string | null
  signalChangesCompactedThrough: number | null
  migrations: {
    id: string
    sequence: number
    fromSchemaVersion: string
    toSchemaVersion: string
    checksum: string
    state: string
  }[]
}

interface IndependentResetSuccess {
  ok: true
  purged: boolean
  affectedEpisodes: string[]
  affectedEntities: string[]
  affectedFacts: string[]
  projectionsInvalidated: number
}

interface IndependentRememberSuccess {
  ok: true
  episodeId: string
  operation: { id: string; state: string; stage: string }
}

interface IndependentResetDiagnostics {
  spaceExists: boolean
  generation: string | null
  revision: number | null
  episodes: string[]
  operations: { id: string; state: string; stage: string }[]
  lifecycles: { operationId: string; action: string; targetId: string }[]
}

async function independentCommand<T>(
  page: Page,
  method: string,
  input?: Record<string, unknown>,
): Promise<T> {
  return page.evaluate(
    async ({ command, argument }) => {
      const api = window.__temporalIndependentContext
      if (api === undefined) throw new Error('independent-context harness is not ready')
      const operation = api[command]
      if (operation === undefined)
        throw new Error(`unknown independent-context command: ${command}`)
      return operation(argument)
    },
    { command: method, argument: input },
  ) as Promise<T>
}

it('recovers abandoned ingestion without stealing work from a live browser facade', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    optimizeDeps: { exclude: ['@astrale-os/surrealdb-wasm'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error('Vite did not expose a local browser URL')
    const independentUrl = new URL('test/browser/independent-context.html', origin).href
    for (const [victimWorker, observerWorker] of [
      [false, false],
      [true, true],
      [false, true],
    ] as const) {
      const context = await browser.newContext()
      try {
        const victim = await context.newPage()
        const observer = await context.newPage()
        await Promise.all([victim.goto(independentUrl), observer.goto(independentUrl)])
        await Promise.all([
          victim.waitForFunction(() => window.__temporalIndependentContext !== undefined),
          observer.waitForFunction(() => window.__temporalIndependentContext !== undefined),
        ])
        const endpoint = `indxdb://abrupt${crypto.randomUUID().replaceAll('-', '')}`
        const episodeId = 'abrupt-ingestion-episode'
        const interruptedOperationId = 'abrupt-ingestion-operation'
        const retryOperationId = 'abrupt-ingestion-retry'
        await independentCommand(victim, 'open', {
          endpoint,
          worker: victimWorker,
          create: true,
        })
        await independentCommand(victim, 'armOperationCommitGate', {
          operationId: interruptedOperationId,
          stage: 'canonical_committed',
          position: 'before',
        })
        const interrupted = independentCommand<IndependentIngestionSuccess | IndependentFailure>(
          victim,
          'attemptCrashIngest',
          { episodeId, operationId: interruptedOperationId },
        )
        const interruptedSettlement = interrupted.then(
          () => 'settled' as const,
          () => 'terminated' as const,
        )
        await expect
          .poll(
            async () =>
              (await independentCommand<{ reached: boolean }>(victim, 'operationCommitGateStatus'))
                .reached,
            { timeout: 5_000, interval: 10 },
          )
          .toBe(true)

        await independentCommand(observer, 'open', {
          endpoint,
          worker: observerWorker,
          create: false,
        })
        const whileLive = await independentCommand<IndependentIngestionDiagnostics>(
          observer,
          'ingestionDiagnostics',
          { episodeId, operationIds: [interruptedOperationId, retryOperationId] },
        )
        expect(whileLive).toMatchObject({
          revision: 1,
          episode: true,
          entity: false,
          fact: null,
          operations: [
            {
              id: interruptedOperationId,
              state: 'running',
              stage: 'accepted',
              warnings: [],
              runtimeOwnerId: expect.stringMatching(/^runtime_owner_/u),
            },
          ],
          changes: [{ operationId: interruptedOperationId, phase: 'accepted' }],
        })
        expect(
          whileLive.lifecycle.filter(
            (transition) =>
              transition.action === 'accepted' && transition.operationId === interruptedOperationId,
          ),
        ).toHaveLength(1)

        const abandonedOwnerId = whileLive.operations[0]!.runtimeOwnerId
        await victim.close({ runBeforeUnload: false })
        expect(await interruptedSettlement).toBe('terminated')
        await independentCommand(observer, 'reopen')
        const recovered = await independentCommand<IndependentIngestionDiagnostics>(
          observer,
          'ingestionDiagnostics',
          { episodeId, operationIds: [interruptedOperationId, retryOperationId] },
        )
        expect(recovered).toMatchObject({
          revision: 2,
          episode: true,
          entity: false,
          fact: null,
          operations: [
            {
              id: interruptedOperationId,
              state: 'partial',
              stage: 'interrupted',
              warnings: ['operation was interrupted by runtime termination'],
              runtimeOwnerId: abandonedOwnerId,
            },
          ],
          changes: [{ operationId: interruptedOperationId, phase: 'accepted' }],
        })

        const retried = await independentCommand<IndependentIngestionSuccess | IndependentFailure>(
          observer,
          'attemptRetryEpisode',
          {
            episodeId,
            operationId: retryOperationId,
          },
        )
        expect(retried).toMatchObject({
          ok: true,
          operation: { id: retryOperationId, state: 'succeeded', stage: 'completed' },
          episodeId,
          createdFacts: [`${episodeId}-fact`],
          repeatedFacts: [],
        })
        const final = await independentCommand<IndependentIngestionDiagnostics>(
          observer,
          'ingestionDiagnostics',
          { episodeId, operationIds: [interruptedOperationId, retryOperationId] },
        )
        expect(final).toMatchObject({
          episode: true,
          entity: true,
          fact: 'active',
          changes: [
            { operationId: interruptedOperationId, phase: 'accepted' },
            { operationId: retryOperationId, phase: 'canonical' },
          ],
        })
        expect(final.operations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: interruptedOperationId,
              state: 'partial',
              stage: 'interrupted',
            }),
            expect.objectContaining({
              id: retryOperationId,
              state: 'succeeded',
              stage: 'completed',
            }),
          ]),
        )
        expect(
          final.lifecycle.filter(
            (transition) =>
              transition.action === 'accepted' && transition.operationId === interruptedOperationId,
          ),
        ).toHaveLength(1)
        const integrity = await independentCommand<{ ok: true; integrity: boolean }>(
          observer,
          'attemptIntegrity',
        )
        expect(integrity).toMatchObject({ ok: true, integrity: true })
        await independentCommand(observer, 'close')
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
}, 60_000)

it('resumes a sync apply after owning-page termination without stealing its live owner', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    optimizeDeps: { exclude: ['@astrale-os/surrealdb-wasm'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error('Vite did not expose a local browser URL')
    const independentUrl = new URL('test/browser/independent-context.html', origin).href
    for (const [victimWorker, observerWorker] of [
      [false, false],
      [true, true],
      [false, true],
    ] as const) {
      const context = await browser.newContext()
      try {
        const victim = await context.newPage()
        const observer = await context.newPage()
        await Promise.all([victim.goto(independentUrl), observer.goto(independentUrl)])
        await Promise.all([
          victim.waitForFunction(() => window.__temporalIndependentContext !== undefined),
          observer.waitForFunction(() => window.__temporalIndependentContext !== undefined),
        ])
        const targetEndpoint = `indxdb://syncTarget${crypto.randomUUID().replaceAll('-', '')}`
        const sourceEndpoint = `indxdb://syncSource${crypto.randomUUID().replaceAll('-', '')}`
        const sessionId = 'abrupt-sync-session'
        const operationId = 'abrupt-sync-operation'
        const checkpointOperationId = 'abrupt-sync-source-checkpoint'
        await independentCommand(victim, 'open', {
          endpoint: targetEndpoint,
          worker: victimWorker,
          create: true,
        })
        const source = await independentCommand<{ checkpointId: string; records: number }>(
          victim,
          'prepareSyncSource',
          {
            endpoint: sourceEndpoint,
            worker: victimWorker,
            checkpointOperationId,
          },
        )
        expect(source.records).toBeGreaterThan(1)
        await independentCommand(victim, 'armOperationCommitGate', {
          operationId,
          stage: 'applying',
          position: 'after',
          semantic: true,
        })
        const interrupted = independentCommand<IndependentSyncApplySuccess | IndependentFailure>(
          victim,
          'attemptCrashSyncApply',
          { sessionId, operationId },
        )
        const interruptedSettlement = interrupted.then(
          () => 'settled' as const,
          () => 'terminated' as const,
        )
        await expect
          .poll(
            async () =>
              (await independentCommand<{ reached: boolean }>(victim, 'operationCommitGateStatus'))
                .reached,
            { timeout: 5_000, interval: 10 },
          )
          .toBe(true)

        await independentCommand(observer, 'open', {
          endpoint: targetEndpoint,
          worker: observerWorker,
          create: false,
          skipStats: true,
        })
        const whileLive = await independentCommand<IndependentSyncDiagnostics>(
          observer,
          'syncDiagnostics',
          { sessionId, operationId },
        )
        expect(whileLive).toMatchObject({
          revision: 2,
          session: {
            id: sessionId,
            state: 'applying',
            operationId,
            appliedRecords: 1,
            deletedRecords: 0,
            targetCheckpoint: source.checkpointId,
          },
          operation: {
            id: operationId,
            state: 'running',
            stage: 'applying',
            runtimeOwnerId: expect.stringMatching(/^runtime_owner_/u),
          },
        })
        const abandonedOwnerId = whileLive.operation!.runtimeOwnerId
        const blocked = await independentCommand<IndependentFailure>(observer, 'attemptStats')
        expect(blocked).toMatchObject({
          ok: false,
          error: { code: 'sync_in_progress', retryable: true },
        })

        await victim.close({ runBeforeUnload: false })
        expect(await interruptedSettlement).toBe('terminated')
        await independentCommand(observer, 'reopen')
        const recovered = await independentCommand<IndependentSyncDiagnostics>(
          observer,
          'syncDiagnostics',
          { sessionId, operationId },
        )
        expect(recovered).toMatchObject({
          session: {
            id: sessionId,
            state: 'succeeded',
            operationId,
            appliedRecords: source.records,
            deletedRecords: 0,
            targetCheckpoint: source.checkpointId,
            checkpointId: source.checkpointId,
          },
          operation: {
            id: operationId,
            state: 'succeeded',
            stage: 'completed',
            runtimeOwnerId: expect.stringMatching(/^runtime_owner_/u),
          },
          head: source.checkpointId,
          episodes: ['sync-crash-episode-a', 'sync-crash-episode-b'],
          entities: ['sync-crash-entity-a', 'sync-crash-entity-b'],
          facts: [
            { id: 'sync-crash-fact-a', status: 'active' },
            { id: 'sync-crash-fact-b', status: 'active' },
          ],
        })
        expect(recovered.operation!.runtimeOwnerId).not.toBe(abandonedOwnerId)
        const after = await independentCommand<{
          ok: true
          revision: number
          episodes: number
        }>(observer, 'attemptStats')
        expect(after).toMatchObject({ ok: true, episodes: 2 })
        const integrity = await independentCommand<{ ok: true; integrity: boolean }>(
          observer,
          'attemptIntegrity',
        )
        expect(integrity).toMatchObject({ ok: true, integrity: true })
        await independentCommand(observer, 'close')
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
}, 60_000)

it('resumes a sync rollback after owning-page termination without its remote peer', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    optimizeDeps: { exclude: ['@astrale-os/surrealdb-wasm'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error('Vite did not expose a local browser URL')
    const independentUrl = new URL('test/browser/independent-context.html', origin).href
    for (const [victimWorker, observerWorker] of [
      [false, false],
      [true, true],
      [false, true],
    ] as const) {
      const context = await browser.newContext()
      try {
        const victim = await context.newPage()
        const observer = await context.newPage()
        await Promise.all([victim.goto(independentUrl), observer.goto(independentUrl)])
        await Promise.all([
          victim.waitForFunction(() => window.__temporalIndependentContext !== undefined),
          observer.waitForFunction(() => window.__temporalIndependentContext !== undefined),
        ])
        const targetEndpoint = `indxdb://syncRollback${crypto.randomUUID().replaceAll('-', '')}`
        const sourceEndpoint = `indxdb://syncRollbackSource${crypto.randomUUID().replaceAll('-', '')}`
        const sessionId = 'abrupt-sync-rollback-session'
        const operationId = 'abrupt-sync-rollback-operation'
        await independentCommand(victim, 'open', {
          endpoint: targetEndpoint,
          worker: victimWorker,
          create: true,
        })
        const source = await independentCommand<{ checkpointId: string; records: number }>(
          victim,
          'prepareSyncSource',
          {
            endpoint: sourceEndpoint,
            worker: victimWorker,
            checkpointOperationId: 'abrupt-sync-rollback-source-checkpoint',
          },
        )
        expect(source.records).toBeGreaterThan(1)

        await independentCommand(victim, 'armOperationCommitFailure', {
          operationId,
          stage: 'applying',
          semantic: true,
          occurrence: 2,
        })
        const interruptedForward = await independentCommand<
          IndependentSyncApplySuccess | IndependentFailure
        >(victim, 'attemptSyncApply', { sessionId, operationId })
        expect(interruptedForward).toMatchObject({ ok: false })

        const partialForward = await independentCommand<IndependentSyncDiagnostics>(
          victim,
          'syncDiagnostics',
          { sessionId, operationId },
        )
        expect(partialForward).toMatchObject({
          revision: 2,
          session: {
            id: sessionId,
            state: 'applying',
            rollback: false,
            operationId,
            localHead: expect.any(String),
            appliedRecords: 1,
            deletedRecords: 0,
            targetCheckpoint: source.checkpointId,
          },
          operation: {
            id: operationId,
            state: 'running',
            stage: 'applying',
            runtimeOwnerId: expect.stringMatching(/^runtime_owner_/u),
          },
        })
        const localHead = partialForward.session!.localHead
        expect(localHead).not.toBeNull()

        await independentCommand(victim, 'armOperationCommitGate', {
          operationId,
          stage: 'rolling-back',
          position: 'after',
          semantic: true,
        })
        const rollback = independentCommand<IndependentSyncApplySuccess | IndependentFailure>(
          victim,
          'attemptSyncAbort',
          { sessionId },
        )
        const rollbackSettlement = rollback.then(
          () => 'settled' as const,
          () => 'terminated' as const,
        )
        await expect
          .poll(
            async () =>
              (await independentCommand<{ reached: boolean }>(victim, 'operationCommitGateStatus'))
                .reached,
            { timeout: 5_000, interval: 10 },
          )
          .toBe(true)

        await independentCommand(observer, 'open', {
          endpoint: targetEndpoint,
          worker: observerWorker,
          create: false,
          skipStats: true,
        })
        const whileLive = await independentCommand<IndependentSyncDiagnostics>(
          observer,
          'syncDiagnostics',
          { sessionId, operationId },
        )
        expect(whileLive).toMatchObject({
          revision: 4,
          session: {
            id: sessionId,
            state: 'rolling-back',
            rollback: true,
            operationId,
            localHead,
            appliedRecords: 1,
            deletedRecords: 1,
            applyLocalKey: expect.any(String),
            targetCheckpoint: localHead,
          },
          operation: {
            id: operationId,
            state: 'running',
            stage: 'rolling-back',
            runtimeOwnerId: expect.stringMatching(/^runtime_owner_/u),
          },
        })
        const abandonedOwnerId = whileLive.operation!.runtimeOwnerId
        await expect(
          independentCommand<IndependentFailure>(observer, 'attemptStats'),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: 'sync_in_progress', retryable: true },
        })
        await expect(
          independentCommand<IndependentFailure>(observer, 'attemptSyncAbort', { sessionId }),
        ).resolves.toMatchObject({
          ok: false,
          error: { code: 'sync_in_progress', retryable: true },
        })

        await victim.close({ runBeforeUnload: false })
        expect(await rollbackSettlement).toBe('terminated')
        await independentCommand(observer, 'reopen')
        const recovered = await independentCommand<IndependentSyncDiagnostics>(
          observer,
          'syncDiagnostics',
          { sessionId, operationId },
        )
        expect(recovered).toMatchObject({
          session: {
            id: sessionId,
            state: 'aborted',
            rollback: true,
            operationId,
            localHead,
            appliedRecords: 1,
            deletedRecords: 1,
            targetCheckpoint: localHead,
            checkpointId: localHead,
          },
          operation: {
            id: operationId,
            state: 'succeeded',
            stage: 'completed',
            attempts: 1,
            runtimeOwnerId: expect.stringMatching(/^runtime_owner_/u),
          },
          head: localHead,
          episodes: [],
          entities: [],
          facts: [],
          syncOperations: [{ id: operationId, state: 'succeeded', attempts: 1 }],
        })
        expect(recovered.operation!.runtimeOwnerId).not.toBe(abandonedOwnerId)
        expect(recovered.syncChanges).toHaveLength(2)
        expect(new Set(recovered.syncChanges.map((change) => change.revision)).size).toBe(2)
        await expect(
          independentCommand<{ ok: true; episodes: number }>(observer, 'attemptStats'),
        ).resolves.toMatchObject({ ok: true, episodes: 0 })
        await expect(
          independentCommand<{ ok: true; integrity: boolean }>(observer, 'attemptIntegrity'),
        ).resolves.toMatchObject({ ok: true, integrity: true })
        await independentCommand(observer, 'close')
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
}, 60_000)

it('resumes hard purge after owner death at every durable application phase', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    optimizeDeps: { exclude: ['@astrale-os/surrealdb-wasm'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error('Vite did not expose a local browser URL')
    const independentUrl = new URL('test/browser/independent-context.html', origin).href
    for (const [victimWorker, observerWorker] of [
      [false, false],
      [true, true],
      [false, true],
    ] as const) {
      for (const phase of [
        'after-marker',
        'mid-sync-cleanup',
        'before-final',
        'after-recovery-claim',
      ] as const) {
        const context = await browser.newContext()
        try {
          const victim = await context.newPage()
          const observer = await context.newPage()
          await Promise.all([victim.goto(independentUrl), observer.goto(independentUrl)])
          await Promise.all([
            victim.waitForFunction(() => window.__temporalIndependentContext !== undefined),
            observer.waitForFunction(() => window.__temporalIndependentContext !== undefined),
          ])
          const endpoint = `indxdb://purgeRecovery${crypto.randomUUID().replaceAll('-', '')}`
          await independentCommand(victim, 'open', {
            endpoint,
            worker: victimWorker,
            create: true,
          })
          await independentCommand(victim, 'seed')
          const checkpoint = await independentCommand<{
            checkpointId: string
            afterRevision: number
          }>(victim, 'createCheckpoint', {
            operationId: `purge-recovery-checkpoint-${phase}`,
          })
          const before = await independentCommand<IndependentPurgeRecoveryDiagnostics>(
            victim,
            'purgeRecoveryDiagnostics',
          )
          expect(before).toMatchObject({
            revision: checkpoint.afterRevision,
            targetExists: true,
            entityExists: true,
            factExists: true,
            operation: null,
            markers: [],
            semanticChanges: [],
          })
          expect(before.syncMetadataTotal).toBeGreaterThan(0)

          if (phase === 'mid-sync-cleanup') {
            await independentCommand(victim, 'armRecordDeletionCommitGate', {
              kind: 'sync_checkpoint',
              position: 'after',
            })
          } else {
            await independentCommand(victim, 'armOperationCommitGate', {
              operationId: 'independent-hard-purge-race',
              stage: phase === 'before-final' ? 'completed' : 'purge_marked',
              position: phase === 'before-final' ? 'before' : 'after',
              semantic: phase === 'before-final',
            })
          }
          const pending = independentCommand<
            { ok: true; purged: boolean; affectedEpisodes: string[] } | IndependentFailure
          >(victim, 'attemptHardPurge', { allCanonical: true })
          const pendingSettlement = pending.then(
            () => 'settled' as const,
            () => 'terminated' as const,
          )
          const gateStatusMethod =
            phase === 'mid-sync-cleanup'
              ? 'recordDeletionCommitGateStatus'
              : 'operationCommitGateStatus'
          await expect
            .poll(
              async () =>
                (await independentCommand<{ reached: boolean }>(victim, gateStatusMethod)).reached,
              { timeout: 5_000, interval: 10 },
            )
            .toBe(true)

          await independentCommand(observer, 'open', {
            endpoint,
            worker: observerWorker,
            create: false,
            skipStats: true,
          })
          const whileLive = await independentCommand<IndependentPurgeRecoveryDiagnostics>(
            observer,
            'purgeRecoveryDiagnostics',
          )
          expect(whileLive).toMatchObject({
            revision: checkpoint.afterRevision + 1,
            targetExists: true,
            entityExists: true,
            factExists: true,
            operation: {
              id: 'independent-hard-purge-race',
              state: 'running',
              stage: 'purge_marked',
              attempts: 1,
              runtimeOwnerId: expect.stringMatching(/^runtime_owner_/u),
            },
            markers: [
              {
                state: 'running',
                targets: expect.any(Number),
                completedTargets: 0,
                hasWorkLimits: true,
                hasRequestHash: true,
              },
            ],
            semanticChanges: [],
          })
          expect(whileLive.markers[0]!.targets).toBeGreaterThan(0)
          if (phase === 'mid-sync-cleanup') {
            expect(whileLive.syncMetadata.sync_checkpoint).toBe(0)
            expect(whileLive.syncMetadataTotal).toBeGreaterThan(0)
            expect(whileLive.syncMetadataTotal).toBeLessThan(before.syncMetadataTotal)
          } else if (phase === 'before-final') {
            expect(whileLive.syncMetadataTotal).toBe(0)
          } else {
            expect(whileLive.syncMetadataTotal).toBe(before.syncMetadataTotal)
          }
          const initialOwnerId = whileLive.operation!.runtimeOwnerId
          await expect(
            independentCommand<IndependentFailure>(observer, 'attemptStats'),
          ).resolves.toMatchObject({
            ok: false,
            error: {
              code: 'purge_in_progress',
              retryable: true,
            },
          })
          await expect(
            independentCommand<IndependentFailure>(observer, 'attemptHardPurge', {
              allCanonical: true,
            }),
          ).resolves.toMatchObject({
            ok: false,
            error: {
              code: 'purge_in_progress',
              retryable: true,
            },
          })

          await victim.close({ runBeforeUnload: false })
          expect(await pendingSettlement).toBe('terminated')

          let recoveryPage = observer
          let interruptedRecoveryOwnerId: string | null = null
          if (phase === 'after-recovery-claim') {
            await independentCommand(observer, 'armOperationCommitGate', {
              operationId: 'independent-hard-purge-race',
              stage: 'purge_marked',
              position: 'after',
              semantic: false,
            })
            const claiming = independentCommand(observer, 'reopen')
            const claimingSettlement = claiming.then(
              () => 'settled' as const,
              () => 'terminated' as const,
            )
            await expect
              .poll(
                async () =>
                  (
                    await independentCommand<{ reached: boolean }>(
                      observer,
                      'operationCommitGateStatus',
                    )
                  ).reached,
                { timeout: 5_000, interval: 10 },
              )
              .toBe(true)
            const claimed = await independentCommand<IndependentPurgeRecoveryDiagnostics>(
              observer,
              'purgeRecoveryDiagnostics',
            )
            expect(claimed.revision).toBe(checkpoint.afterRevision + 2)
            expect(claimed.syncMetadataTotal).toBe(before.syncMetadataTotal)
            interruptedRecoveryOwnerId = claimed.operation!.runtimeOwnerId
            expect(interruptedRecoveryOwnerId).not.toBe(initialOwnerId)

            const successor = await context.newPage()
            await successor.goto(independentUrl)
            await successor.waitForFunction(() => window.__temporalIndependentContext !== undefined)
            await independentCommand(successor, 'open', {
              endpoint,
              worker: victimWorker,
              create: false,
              skipStats: true,
            })
            const claimedWhileLive = await independentCommand<IndependentPurgeRecoveryDiagnostics>(
              successor,
              'purgeRecoveryDiagnostics',
            )
            expect(claimedWhileLive.operation!.runtimeOwnerId).toBe(interruptedRecoveryOwnerId)
            await expect(
              independentCommand<IndependentFailure>(successor, 'attemptStats'),
            ).resolves.toMatchObject({
              ok: false,
              error: { code: 'purge_in_progress', retryable: true },
            })
            await observer.close({ runBeforeUnload: false })
            expect(await claimingSettlement).toBe('terminated')
            recoveryPage = successor
          }

          await independentCommand(recoveryPage, 'reopen')
          const recovered = await independentCommand<IndependentPurgeRecoveryDiagnostics>(
            recoveryPage,
            'purgeRecoveryDiagnostics',
          )
          expect(recovered).toMatchObject({
            revision: checkpoint.afterRevision + (phase === 'after-recovery-claim' ? 4 : 3),
            targetExists: false,
            entityExists: false,
            factExists: false,
            operation: {
              id: 'independent-hard-purge-race',
              state: 'succeeded',
              stage: 'completed',
              attempts: 1,
              runtimeOwnerId: expect.stringMatching(/^runtime_owner_/u),
            },
            markers: [
              {
                state: 'succeeded',
                targets: 0,
                completedTargets: expect.any(Number),
                hasWorkLimits: false,
                hasRequestHash: true,
              },
            ],
            syncMetadataTotal: 0,
            semanticChanges: [{ revision: recovered.revision, phase: 'purge' }],
          })
          expect(recovered.markers[0]!.completedTargets).toBeGreaterThan(0)
          expect(recovered.operation!.runtimeOwnerId).not.toBe(initialOwnerId)
          if (interruptedRecoveryOwnerId !== null) {
            expect(recovered.operation!.runtimeOwnerId).not.toBe(interruptedRecoveryOwnerId)
          }
          expect(Object.values(recovered.syncMetadata).every((count) => count === 0)).toBe(true)
          await expect(
            independentCommand<{ ok: true; episodes: number }>(recoveryPage, 'attemptStats'),
          ).resolves.toMatchObject({ ok: true, episodes: 0 })
          await expect(
            independentCommand<{ ok: true; integrity: boolean }>(recoveryPage, 'attemptIntegrity'),
          ).resolves.toMatchObject({ ok: true, integrity: true })
          await expect(
            independentCommand<IndependentFailure>(recoveryPage, 'attemptHardPurge', {
              allCanonical: true,
            }),
          ).resolves.toMatchObject({
            ok: false,
            error: { code: 'idempotency_conflict', retryable: false },
          })
          await independentCommand(recoveryPage, 'close')
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
}, 120_000)

it('serializes distinct hard-purge starts and preserves explicit loser retry', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    optimizeDeps: { exclude: ['@astrale-os/surrealdb-wasm'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error('Vite did not expose a local browser URL')
    const independentUrl = new URL('test/browser/independent-context.html', origin).href
    for (const [leftWorker, rightWorker] of [
      [false, false],
      [true, true],
      [false, true],
    ] as const) {
      for (const scenario of ['same-snapshot', 'live-marker'] as const) {
        const context = await browser.newContext()
        try {
          const left = await context.newPage()
          const right = await context.newPage()
          await Promise.all([left.goto(independentUrl), right.goto(independentUrl)])
          await Promise.all([
            left.waitForFunction(() => window.__temporalIndependentContext !== undefined),
            right.waitForFunction(() => window.__temporalIndependentContext !== undefined),
          ])
          const endpoint = `indxdb://competingPurge${crypto.randomUUID().replaceAll('-', '')}`
          await independentCommand(left, 'open', {
            endpoint,
            worker: leftWorker,
            create: true,
          })
          await independentCommand(right, 'open', {
            endpoint,
            worker: rightWorker,
            create: false,
          })
          const targetIds = ['competing-purge-left', 'competing-purge-right']
          const operationIds = ['competing-purge-left-operation', 'competing-purge-right-operation']
          for (const targetId of targetIds) {
            await independentCommand(left, 'rememberEpisode', {
              id: targetId,
              text: `Distinct purge target ${targetId}.`,
            })
          }

          await independentCommand(left, 'armOperationCommitGate', {
            operationId: operationIds[0],
            stage: 'purge_marked',
            position: scenario === 'same-snapshot' ? 'before' : 'after',
            semantic: false,
          })
          const leftPending = independentCommand<
            { ok: true; purged: boolean; affectedEpisodes: string[] } | IndependentFailure
          >(left, 'attemptHardPurge', {
            targetId: targetIds[0],
            operationId: operationIds[0],
          })
          await expect
            .poll(
              async () =>
                (await independentCommand<{ reached: boolean }>(left, 'operationCommitGateStatus'))
                  .reached,
              { timeout: 5_000, interval: 10 },
            )
            .toBe(true)

          if (scenario === 'same-snapshot') {
            await independentCommand(right, 'armOperationCommitGate', {
              operationId: operationIds[1],
              stage: 'purge_marked',
              position: 'before',
              semantic: false,
            })
            const rightPending = independentCommand<
              { ok: true; purged: boolean; affectedEpisodes: string[] } | IndependentFailure
            >(right, 'attemptHardPurge', {
              targetId: targetIds[1],
              operationId: operationIds[1],
            })
            await expect
              .poll(
                async () =>
                  (
                    await independentCommand<{ reached: boolean }>(
                      right,
                      'operationCommitGateStatus',
                    )
                  ).reached,
                { timeout: 5_000, interval: 10 },
              )
              .toBe(true)
            await Promise.all([
              independentCommand(left, 'releaseOperationCommitGate'),
              independentCommand(right, 'releaseOperationCommitGate'),
            ])
            const outcomes = await Promise.all([leftPending, rightPending])
            const winnerIndex = outcomes.findIndex((outcome) => outcome.ok)
            const loserIndex = winnerIndex === 0 ? 1 : 0
            expect(winnerIndex).toBeGreaterThanOrEqual(0)
            expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
            expect(outcomes[loserIndex]).toMatchObject({
              ok: false,
              error: {
                code: 'conflict',
                retryable: true,
                operationId: operationIds[loserIndex],
              },
            })
            const afterWinner = await independentCommand<IndependentCompetingPurgeDiagnostics>(
              left,
              'competingPurgeDiagnostics',
              { targetIds, operationIds },
            )
            const targetState = new Map(
              afterWinner.targets.map((target) => [target.id, target.exists]),
            )
            expect(targetState.get(targetIds[winnerIndex]!)).toBe(false)
            expect(targetState.get(targetIds[loserIndex]!)).toBe(true)
            expect(afterWinner.operations).toEqual([
              expect.objectContaining({
                id: operationIds[winnerIndex],
                state: 'succeeded',
                stage: 'completed',
                attempts: 1,
              }),
            ])
            expect(afterWinner.markers).toEqual([
              expect.objectContaining({
                operationId: operationIds[winnerIndex],
                state: 'succeeded',
                targets: 0,
                completedTargets: 1,
              }),
            ])
            expect(afterWinner.semanticChanges).toEqual([
              expect.objectContaining({
                operationId: operationIds[winnerIndex],
                phase: 'purge',
              }),
            ])

            const loserPage = loserIndex === 0 ? left : right
            await expect(
              independentCommand<{
                ok: true
                purged: boolean
                affectedEpisodes: string[]
              }>(loserPage, 'attemptHardPurge', {
                targetId: targetIds[loserIndex],
                operationId: operationIds[loserIndex],
              }),
            ).resolves.toMatchObject({
              ok: true,
              purged: true,
              affectedEpisodes: [targetIds[loserIndex]],
            })
          } else {
            const blocked = await independentCommand<IndependentFailure>(
              right,
              'attemptHardPurge',
              {
                targetId: targetIds[1],
                operationId: operationIds[1],
              },
            )
            expect(blocked).toMatchObject({
              ok: false,
              error: {
                code: 'purge_in_progress',
                retryable: true,
                operationId: operationIds[0],
              },
            })
            const whileLive = await independentCommand<IndependentCompetingPurgeDiagnostics>(
              right,
              'competingPurgeDiagnostics',
              { targetIds, operationIds },
            )
            expect(whileLive.targets.every((target) => target.exists)).toBe(true)
            expect(whileLive.operations).toEqual([
              expect.objectContaining({
                id: operationIds[0],
                state: 'running',
                stage: 'purge_marked',
              }),
            ])
            expect(whileLive.markers).toEqual([
              expect.objectContaining({
                operationId: operationIds[0],
                state: 'running',
                completedTargets: 0,
              }),
            ])
            expect(whileLive.semanticChanges).toEqual([])
            await independentCommand(left, 'releaseOperationCommitGate')
            await expect(leftPending).resolves.toMatchObject({
              ok: true,
              purged: true,
              affectedEpisodes: [targetIds[0]],
            })
            await expect(
              independentCommand<{
                ok: true
                purged: boolean
                affectedEpisodes: string[]
              }>(right, 'attemptHardPurge', {
                targetId: targetIds[1],
                operationId: operationIds[1],
              }),
            ).resolves.toMatchObject({
              ok: true,
              purged: true,
              affectedEpisodes: [targetIds[1]],
            })
          }

          const completed = await independentCommand<IndependentCompetingPurgeDiagnostics>(
            left,
            'competingPurgeDiagnostics',
            { targetIds, operationIds },
          )
          expect(completed.targets.every((target) => !target.exists)).toBe(true)
          expect(completed.operations).toHaveLength(2)
          expect(completed.operations.every((operation) => operation.state === 'succeeded')).toBe(
            true,
          )
          expect(completed.markers).toHaveLength(2)
          expect(completed.markers.every((marker) => marker.state === 'succeeded')).toBe(true)
          expect(completed.semanticChanges).toHaveLength(2)
          expect(new Set(completed.semanticChanges.map((change) => change.revision)).size).toBe(2)
          await expect(
            independentCommand<{ ok: true; integrity: boolean }>(left, 'attemptIntegrity'),
          ).resolves.toMatchObject({ ok: true, integrity: true })
          await Promise.all([independentCommand(left, 'close'), independentCommand(right, 'close')])
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
}, 90_000)

it('serializes signal-target canonical actions without partial consumption', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    optimizeDeps: { exclude: ['@astrale-os/surrealdb-wasm'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error('Vite did not expose a local browser URL')
    const independentUrl = new URL('test/browser/independent-context.html', origin).href
    const waitForCommitGate = async (page: Page): Promise<void> => {
      await expect
        .poll(
          async () =>
            (await independentCommand<{ reached: boolean }>(page, 'operationCommitGateStatus'))
              .reached,
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true)
    }

    for (const [leftWorker, rightWorker] of [
      [false, false],
      [true, true],
      [false, true],
    ] as const) {
      for (const scenario of ['disjoint-delete', 'soft-delete-wins', 'hard-purge-wins'] as const) {
        const context = await browser.newContext()
        try {
          const left = await context.newPage()
          const right = await context.newPage()
          await Promise.all([left.goto(independentUrl), right.goto(independentUrl)])
          await Promise.all([
            left.waitForFunction(() => window.__temporalIndependentContext !== undefined),
            right.waitForFunction(() => window.__temporalIndependentContext !== undefined),
          ])
          const endpoint = `indxdb://signalTargetAction${crypto.randomUUID().replaceAll('-', '')}`
          await independentCommand(left, 'open', {
            endpoint,
            worker: leftWorker,
            create: true,
          })
          await independentCommand(right, 'open', {
            endpoint,
            worker: rightWorker,
            create: false,
          })

          const disjoint = scenario === 'disjoint-delete'
          const targetIds = disjoint
            ? ['signal-action-left-target', 'signal-action-right-target']
            : ['signal-action-shared-target']
          const namespaces = disjoint
            ? ['signal-action.left', 'signal-action.right']
            : ['signal-action.shared']
          const operationIds = disjoint
            ? ['signal-action-left-delete', 'signal-action-right-delete']
            : ['signal-action-soft-delete', 'signal-action-hard-purge']
          for (const targetId of targetIds) {
            await independentCommand(left, 'rememberEpisode', {
              id: targetId,
              text: `Signal-selected canonical target ${targetId}.`,
            })
          }
          await independentCommand(left, 'putSignalTargets', {
            targets: targetIds.map((targetId, index) => ({
              namespace: namespaces[index] ?? namespaces[0]!,
              slot: `target-${index}`,
              targetId,
            })),
          })

          const leftNamespace = namespaces[0]!
          const rightNamespace = disjoint ? namespaces[1]! : namespaces[0]!
          const [leftPreview, rightPreview] = await Promise.all([
            independentCommand<{
              revision: number
              total: number
              selectionCursor: string | null
            }>(left, 'previewSignalTargets', { namespace: leftNamespace }),
            independentCommand<{
              revision: number
              total: number
              selectionCursor: string | null
            }>(right, 'previewSignalTargets', { namespace: rightNamespace }),
          ])
          expect(leftPreview).toMatchObject({ total: 1, selectionCursor: expect.any(String) })
          expect(rightPreview).toMatchObject({ total: 1, selectionCursor: expect.any(String) })
          expect(leftPreview.revision).toBe(rightPreview.revision)
          const rightSelectionCursor = disjoint
            ? rightPreview.selectionCursor!
            : leftPreview.selectionCursor!

          await independentCommand(left, 'armOperationCommitGate', {
            operationId: operationIds[0],
            stage: 'completed',
            position: 'before',
            semantic: true,
          })
          const leftPending = independentCommand<
            IndependentSignalTargetActionSuccess | IndependentFailure
          >(left, 'attemptSignalTargetAction', {
            action: 'soft-delete',
            namespace: leftNamespace,
            selectionCursor: leftPreview.selectionCursor!,
            operationId: operationIds[0],
          })
          await waitForCommitGate(left)

          const rightAction = disjoint ? 'soft-delete' : 'hard-purge'
          await independentCommand(right, 'armOperationCommitGate', {
            operationId: operationIds[1],
            stage: disjoint ? 'completed' : 'purge_marked',
            position: 'before',
            semantic: disjoint,
          })
          const rightPending = independentCommand<
            IndependentSignalTargetActionSuccess | IndependentFailure
          >(right, 'attemptSignalTargetAction', {
            action: rightAction,
            namespace: rightNamespace,
            selectionCursor: rightSelectionCursor,
            operationId: operationIds[1],
          })
          await waitForCommitGate(right)

          if (disjoint) {
            await Promise.all([
              independentCommand(left, 'releaseOperationCommitGate'),
              independentCommand(right, 'releaseOperationCommitGate'),
            ])
            const outcomes = await Promise.all([leftPending, rightPending])
            const winnerIndex = outcomes.findIndex((outcome) => outcome.ok)
            const loserIndex = winnerIndex === 0 ? 1 : 0
            expect(winnerIndex).toBeGreaterThanOrEqual(0)
            expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
            expect(outcomes[loserIndex]).toMatchObject({
              ok: false,
              error: {
                code: 'conflict',
                retryable: true,
                operationId: operationIds[loserIndex],
                details: { requiresSignalBaseline: true },
              },
            })

            const afterWinner = await independentCommand<IndependentSignalTargetActionDiagnostics>(
              left,
              'signalTargetActionDiagnostics',
              { targetIds, namespaces, operationIds },
            )
            const episodeState = new Map(
              afterWinner.episodes.map((episode) => [episode.id, episode.retentionState]),
            )
            expect(episodeState.get(targetIds[winnerIndex]!)).toBe('deleted')
            expect(episodeState.get(targetIds[loserIndex]!)).toBe('retained')
            expect(afterWinner.operations).toEqual([
              expect.objectContaining({
                id: operationIds[winnerIndex],
                kind: 'delete',
                state: 'succeeded',
                stage: 'completed',
              }),
            ])
            expect(afterWinner.lifecycles).toEqual([
              {
                operationId: operationIds[winnerIndex],
                targetId: targetIds[winnerIndex],
                action: 'deleted',
              },
            ])
            expect(afterWinner.markers).toEqual([])
            expect(afterWinner.semanticChanges).toEqual([
              expect.objectContaining({
                operationId: operationIds[winnerIndex],
                phase: 'governance',
              }),
            ])
            expect(afterWinner.signalChanges.map((change) => change.action)).toEqual([
              'put',
              'withdraw',
            ])
            expect(
              afterWinner.signals
                .filter((signal) => signal.namespace === namespaces[winnerIndex])
                .map((signal) => signal.state),
            ).toEqual(['active', 'withdrawn'])
            expect(
              afterWinner.signals
                .filter((signal) => signal.namespace === namespaces[loserIndex])
                .map((signal) => signal.state),
            ).toEqual(['active'])

            const consumedPreview = await independentCommand<{
              total: number
              selectionCursor: string | null
            }>(left, 'previewSignalTargets', { namespace: namespaces[winnerIndex] })
            expect(consumedPreview).toEqual(
              expect.objectContaining({ total: 0, selectionCursor: null }),
            )
            const loserPage = loserIndex === 0 ? left : right
            const retryPreview = await independentCommand<{
              total: number
              selectionCursor: string | null
            }>(loserPage, 'previewSignalTargets', { namespace: namespaces[loserIndex] })
            expect(retryPreview).toMatchObject({ total: 1, selectionCursor: expect.any(String) })
            await expect(
              independentCommand<IndependentSignalTargetActionSuccess>(
                loserPage,
                'attemptSignalTargetAction',
                {
                  action: 'soft-delete',
                  namespace: namespaces[loserIndex],
                  selectionCursor: retryPreview.selectionCursor!,
                  operationId: operationIds[loserIndex],
                },
              ),
            ).resolves.toMatchObject({
              ok: true,
              action: 'soft-delete',
              operationId: operationIds[loserIndex],
              affectedEpisodes: [targetIds[loserIndex]],
              purged: false,
            })

            const completed = await independentCommand<IndependentSignalTargetActionDiagnostics>(
              right,
              'signalTargetActionDiagnostics',
              { targetIds, namespaces, operationIds },
            )
            expect(
              completed.episodes.every((episode) => episode.retentionState === 'deleted'),
            ).toBe(true)
            expect(completed.operations).toHaveLength(2)
            expect(completed.lifecycles).toHaveLength(2)
            expect(completed.markers).toEqual([])
            expect(completed.semanticChanges).toHaveLength(2)
            expect(completed.signals).toHaveLength(4)
            expect(completed.signalChanges.map((change) => change.action)).toEqual([
              'put',
              'withdraw',
              'withdraw',
            ])
          } else {
            const softWins = scenario === 'soft-delete-wins'
            if (softWins) {
              await independentCommand(left, 'releaseOperationCommitGate')
              await expect(leftPending).resolves.toMatchObject({
                ok: true,
                action: 'soft-delete',
                operationId: operationIds[0],
                affectedEpisodes: targetIds,
                purged: false,
              })
              await independentCommand(right, 'releaseOperationCommitGate')
            } else {
              await independentCommand(right, 'releaseOperationCommitGate')
              await expect(rightPending).resolves.toMatchObject({
                ok: true,
                action: 'hard-purge',
                operationId: operationIds[1],
                affectedEpisodes: targetIds,
                purged: true,
              })
              await independentCommand(left, 'releaseOperationCommitGate')
            }
            const loser = await (softWins ? rightPending : leftPending)
            expect(loser).toMatchObject({
              ok: false,
              error: {
                code: 'conflict',
                retryable: true,
                operationId: operationIds[softWins ? 1 : 0],
                details: { requiresSignalBaseline: true },
              },
            })

            const completed = await independentCommand<IndependentSignalTargetActionDiagnostics>(
              left,
              'signalTargetActionDiagnostics',
              { targetIds, namespaces, operationIds },
            )
            const winnerOperationId = operationIds[softWins ? 0 : 1]!
            expect(completed.operations).toEqual([
              expect.objectContaining({
                id: winnerOperationId,
                kind: softWins ? 'delete' : 'purge',
                state: 'succeeded',
                stage: 'completed',
              }),
            ])
            expect(completed.semanticChanges).toEqual([
              expect.objectContaining({
                operationId: winnerOperationId,
                phase: softWins ? 'governance' : 'purge',
              }),
            ])
            if (softWins) {
              expect(completed.episodes).toEqual([
                { id: targetIds[0], exists: true, retentionState: 'deleted' },
              ])
              expect(completed.signals.map((signal) => signal.state)).toEqual([
                'active',
                'withdrawn',
              ])
              expect(completed.lifecycles).toEqual([
                {
                  operationId: operationIds[0],
                  targetId: targetIds[0],
                  action: 'deleted',
                },
              ])
              expect(completed.markers).toEqual([])
              expect(completed.signalChanges.map((change) => change.action)).toEqual([
                'put',
                'withdraw',
              ])
            } else {
              expect(completed.episodes).toEqual([
                { id: targetIds[0], exists: false, retentionState: null },
              ])
              expect(completed.signals).toEqual([])
              expect(completed.lifecycles).toEqual([])
              expect(completed.markers).toEqual([
                expect.objectContaining({
                  operationId: operationIds[1],
                  state: 'succeeded',
                  targets: 0,
                }),
              ])
              expect(completed.markers[0]!.completedTargets).toBeGreaterThan(0)
              expect(completed.signalChanges.at(-1)).toMatchObject({
                action: 'purge',
                invalidated: true,
              })
            }
            const consumedPreview = await independentCommand<{
              total: number
              selectionCursor: string | null
            }>(right, 'previewSignalTargets', { namespace: namespaces[0] })
            expect(consumedPreview).toEqual(
              expect.objectContaining({ total: 0, selectionCursor: null }),
            )
          }

          await expect(
            independentCommand<{ ok: true; integrity: boolean }>(left, 'attemptIntegrity'),
          ).resolves.toMatchObject({ ok: true, integrity: true })
          await Promise.all([independentCommand(left, 'close'), independentCommand(right, 'close')])
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
}, 120_000)

it('serializes projection rebuilds and recovers abandoned staged sets across independent clients', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    optimizeDeps: { exclude: ['@astrale-os/surrealdb-wasm'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error('Vite did not expose a local browser URL')
    const independentUrl = new URL('test/browser/independent-context.html', origin).href
    const waitForCommitGate = async (page: Page): Promise<void> => {
      await expect
        .poll(
          async () =>
            (await independentCommand<{ reached: boolean }>(page, 'operationCommitGateStatus'))
              .reached,
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true)
    }

    for (const [leftWorker, rightWorker] of [
      [false, false],
      [true, true],
      [false, true],
    ] as const) {
      for (const scenario of ['same-snapshot', 'owner-death'] as const) {
        const context = await browser.newContext()
        try {
          const left = await context.newPage()
          const right = await context.newPage()
          await Promise.all([left.goto(independentUrl), right.goto(independentUrl)])
          await Promise.all([
            left.waitForFunction(() => window.__temporalIndependentContext !== undefined),
            right.waitForFunction(() => window.__temporalIndependentContext !== undefined),
          ])
          const endpoint = `indxdb://projectionRace${crypto.randomUUID().replaceAll('-', '')}`
          await independentCommand(left, 'open', {
            endpoint,
            worker: leftWorker,
            create: true,
          })
          await independentCommand(right, 'open', {
            endpoint,
            worker: rightWorker,
            create: false,
          })
          await independentCommand(left, 'seed')
          const operationIds = [`projection-${scenario}-left`, `projection-${scenario}-right`]
          let finalActiveOperationId = operationIds[1]!
          const initial = await independentCommand<IndependentProjectionRebuildDiagnostics>(
            left,
            'projectionRebuildDiagnostics',
            { operationIds },
          )
          expect(initial.activeSet).not.toBeNull()
          expect(initial.projectionRows).toBeGreaterThan(0)
          expect(initial).toMatchObject({
            operations: [],
            buildingRows: 0,
            inactiveRows: 0,
          })
          expect(initial.activeRows).toBe(initial.projectionRows)

          if (scenario === 'same-snapshot') {
            await Promise.all([
              independentCommand(left, 'armOperationCommitGate', {
                operationId: operationIds[0],
                stage: 'rebuilding',
                position: 'before',
                semantic: false,
              }),
              independentCommand(right, 'armOperationCommitGate', {
                operationId: operationIds[1],
                stage: 'rebuilding',
                position: 'before',
                semantic: false,
              }),
            ])
            const pending = [
              independentCommand<IndependentProjectionRebuildSuccess | IndependentFailure>(
                left,
                'attemptProjectionRebuild',
                { operationId: operationIds[0] },
              ),
              independentCommand<IndependentProjectionRebuildSuccess | IndependentFailure>(
                right,
                'attemptProjectionRebuild',
                { operationId: operationIds[1] },
              ),
            ]
            await Promise.all([waitForCommitGate(left), waitForCommitGate(right)])
            await Promise.all([
              independentCommand(left, 'releaseOperationCommitGate'),
              independentCommand(right, 'releaseOperationCommitGate'),
            ])
            const outcomes = await Promise.all(pending)
            const winnerIndex = outcomes.findIndex((outcome) => outcome.ok)
            const loserIndex = winnerIndex === 0 ? 1 : 0
            expect(winnerIndex).toBeGreaterThanOrEqual(0)
            expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1)
            expect(outcomes[loserIndex]).toMatchObject({
              ok: false,
              error: {
                code: 'conflict',
                retryable: true,
                operationId: operationIds[loserIndex],
              },
            })
            expect(outcomes[winnerIndex]).toMatchObject({
              ok: true,
              operation: {
                id: operationIds[winnerIndex],
                state: 'succeeded',
                stage: 'completed',
              },
              failed: 0,
              staleRemaining: 0,
            })
            const afterWinner = await independentCommand<IndependentProjectionRebuildDiagnostics>(
              left,
              'projectionRebuildDiagnostics',
              { operationIds },
            )
            expect(afterWinner.canonicalRevision).toBe(initial.canonicalRevision)
            expect(afterWinner.activeSet?.operationId).toBe(operationIds[winnerIndex])
            expect(afterWinner.operations).toEqual([
              expect.objectContaining({
                id: operationIds[winnerIndex],
                state: 'succeeded',
                stage: 'completed',
              }),
            ])
            expect(afterWinner).toMatchObject({
              projectionRows: initial.projectionRows,
              activeRows: initial.projectionRows,
              buildingRows: 0,
              inactiveRows: 0,
            })
            expect(afterWinner.setIds).toEqual([afterWinner.activeSet!.id])

            const loserPage = loserIndex === 0 ? left : right
            finalActiveOperationId = operationIds[loserIndex]!
            await expect(
              independentCommand<IndependentProjectionRebuildSuccess>(
                loserPage,
                'attemptProjectionRebuild',
                { operationId: operationIds[loserIndex] },
              ),
            ).resolves.toMatchObject({
              ok: true,
              operation: {
                id: operationIds[loserIndex],
                state: 'succeeded',
                stage: 'completed',
              },
              failed: 0,
              staleRemaining: 0,
            })
          } else {
            await independentCommand(left, 'armOperationCommitGate', {
              operationId: operationIds[0],
              stage: 'activating_projection_sets',
              position: 'before',
              semantic: false,
            })
            const ownerPending = independentCommand<
              IndependentProjectionRebuildSuccess | IndependentFailure
            >(left, 'attemptProjectionRebuild', { operationId: operationIds[0] })
            const ownerSettlement = ownerPending.then(
              () => 'settled' as const,
              () => 'terminated' as const,
            )
            await waitForCommitGate(left)

            const blocked = await independentCommand<IndependentFailure>(
              right,
              'attemptProjectionRebuild',
              { operationId: operationIds[1] },
            )
            expect(blocked).toMatchObject({
              ok: false,
              error: {
                code: 'conflict',
                retryable: true,
                operationId: operationIds[0],
                details: { activeOperationId: operationIds[0] },
              },
            })
            const during = await independentCommand<IndependentProjectionRebuildDiagnostics>(
              right,
              'projectionRebuildDiagnostics',
              { operationIds },
            )
            expect(during.canonicalRevision).toBe(initial.canonicalRevision)
            expect(during.activeSet?.id).toBe(initial.activeSet?.id)
            expect(during.operations).toEqual([
              expect.objectContaining({
                id: operationIds[0],
                state: 'running',
                runtimeOwnerId: expect.stringMatching(/^runtime_owner_/u),
              }),
            ])
            expect(during.activeRows).toBe(initial.projectionRows)
            expect(during.buildingRows).toBeGreaterThan(0)
            expect(during.inactiveRows).toBeGreaterThan(0)
            await expect(
              independentCommand<{ ok: true; episodes: number }>(right, 'attemptRecall'),
            ).resolves.toMatchObject({ ok: true, episodes: 1 })

            await left.close({ runBeforeUnload: false })
            expect(await ownerSettlement).toBe('terminated')
            await independentCommand(right, 'reopen')
            const recovered = await independentCommand<IndependentProjectionRebuildDiagnostics>(
              right,
              'projectionRebuildDiagnostics',
              { operationIds },
            )
            expect(recovered.activeSet?.id).toBe(initial.activeSet?.id)
            expect(recovered.operations).toEqual([
              expect.objectContaining({
                id: operationIds[0],
                state: 'partial',
                stage: 'interrupted',
              }),
            ])
            expect(recovered.buildingRows).toBeGreaterThan(0)
            expect(recovered.inactiveRows).toBeGreaterThan(0)

            await expect(
              independentCommand<IndependentProjectionRebuildSuccess>(
                right,
                'attemptProjectionRebuild',
                { operationId: operationIds[1] },
              ),
            ).resolves.toMatchObject({
              ok: true,
              operation: {
                id: operationIds[1],
                state: 'succeeded',
                stage: 'completed',
              },
              failed: 0,
              staleRemaining: 0,
            })
          }

          const completed = await independentCommand<IndependentProjectionRebuildDiagnostics>(
            right,
            'projectionRebuildDiagnostics',
            { operationIds },
          )
          expect(completed.canonicalRevision).toBe(initial.canonicalRevision)
          expect(completed.activeSet?.operationId).toBe(finalActiveOperationId)
          expect(completed).toMatchObject({
            projectionRows: initial.projectionRows,
            activeRows: initial.projectionRows,
            buildingRows: 0,
            inactiveRows: 0,
          })
          expect(completed.setIds).toEqual([completed.activeSet!.id])
          if (scenario === 'same-snapshot') {
            expect(completed.operations).toEqual([
              expect.objectContaining({ id: operationIds[0], state: 'succeeded' }),
              expect.objectContaining({ id: operationIds[1], state: 'succeeded' }),
            ])
          } else {
            expect(completed.operations).toEqual([
              expect.objectContaining({
                id: operationIds[0],
                state: 'partial',
                stage: 'interrupted',
              }),
              expect.objectContaining({
                id: operationIds[1],
                state: 'succeeded',
                stage: 'completed',
              }),
            ])
          }
          await expect(
            independentCommand<{ ok: true; episodes: number }>(right, 'attemptRecall'),
          ).resolves.toMatchObject({ ok: true, episodes: 1 })
          await expect(
            independentCommand<{ ok: true; integrity: boolean }>(right, 'attemptIntegrity'),
          ).resolves.toMatchObject({ ok: true, integrity: true })
          if (scenario === 'same-snapshot') await independentCommand(left, 'close')
          await independentCommand(right, 'close')
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
}, 120_000)

it('converges independent schema migration and resumes after the owner dies between steps', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    optimizeDeps: { exclude: ['@astrale-os/surrealdb-wasm'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error('Vite did not expose a local browser URL')
    const independentUrl = new URL('test/browser/independent-context.html', origin).href
    const waitForMigrationGate = async (page: Page): Promise<void> => {
      await expect
        .poll(
          async () =>
            (await independentCommand<{ reached: boolean }>(page, 'migrationGateStatus')).reached,
          { timeout: 5_000, interval: 10 },
        )
        .toBe(true)
    }
    const expectCompleteMigration = (diagnostics: IndependentMigrationDiagnostics): void => {
      expect(diagnostics).toMatchObject({
        revision: 0,
        metadataRevision: 2,
        canonicalRevision: 0,
        schemaVersion: '7',
        signalChangesCompactedThrough: 0,
        migrations: [
          {
            id: 'canonical-schema-5-to-6-signal-journal',
            sequence: 6,
            fromSchemaVersion: '5',
            toSchemaVersion: '6',
            checksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
            state: 'succeeded',
          },
          {
            id: 'canonical-schema-6-to-7-derivations',
            sequence: 7,
            fromSchemaVersion: '6',
            toSchemaVersion: '7',
            checksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
            state: 'succeeded',
          },
        ],
      })
    }

    for (const [leftWorker, rightWorker] of [
      [false, false],
      [true, true],
      [false, true],
    ] as const) {
      for (const scenario of ['same-snapshot', 'owner-death'] as const) {
        const context = await browser.newContext()
        try {
          const left = await context.newPage()
          const right = await context.newPage()
          await Promise.all([left.goto(independentUrl), right.goto(independentUrl)])
          await Promise.all([
            left.waitForFunction(() => window.__temporalIndependentContext !== undefined),
            right.waitForFunction(() => window.__temporalIndependentContext !== undefined),
          ])
          const endpoint = `indxdb://migrationRace${crypto.randomUUID().replaceAll('-', '')}`
          const seeded = await independentCommand<IndependentMigrationDiagnostics>(
            left,
            'seedLegacySpace',
            { endpoint, worker: leftWorker },
          )
          expect(seeded).toMatchObject({
            revision: 0,
            schemaVersion: '5',
            migrations: [],
          })

          if (scenario === 'same-snapshot') {
            await Promise.all([
              independentCommand(left, 'armMigrationGate', {
                fromSchemaVersion: '5',
                toSchemaVersion: '6',
                position: 'before',
              }),
              independentCommand(right, 'armMigrationGate', {
                fromSchemaVersion: '5',
                toSchemaVersion: '6',
                position: 'before',
              }),
            ])
            const openings = [
              independentCommand(left, 'open', {
                endpoint,
                worker: leftWorker,
                create: false,
                migrate: true,
              }),
              independentCommand(right, 'open', {
                endpoint,
                worker: rightWorker,
                create: false,
                migrate: true,
              }),
            ]
            await Promise.all([waitForMigrationGate(left), waitForMigrationGate(right)])
            await Promise.all([
              independentCommand(left, 'releaseMigrationGate'),
              independentCommand(right, 'releaseMigrationGate'),
            ])
            await expect(Promise.all(openings)).resolves.toHaveLength(2)
            const [leftComplete, rightComplete] = await Promise.all([
              independentCommand<IndependentMigrationDiagnostics>(left, 'migrationDiagnostics'),
              independentCommand<IndependentMigrationDiagnostics>(right, 'migrationDiagnostics'),
            ])
            expectCompleteMigration(leftComplete)
            expectCompleteMigration(rightComplete)
            expect(leftComplete.migrations).toEqual(rightComplete.migrations)
            await independentCommand(left, 'close')
          } else {
            await independentCommand(left, 'armMigrationGate', {
              fromSchemaVersion: '5',
              toSchemaVersion: '6',
              position: 'after',
            })
            const interrupted = independentCommand(left, 'open', {
              endpoint,
              worker: leftWorker,
              create: false,
              migrate: true,
            })
            const interruptedSettlement = interrupted.then(
              () => 'settled' as const,
              () => 'terminated' as const,
            )
            await waitForMigrationGate(left)
            const betweenSteps = await independentCommand<IndependentMigrationDiagnostics>(
              right,
              'inspectMigrationStorage',
              { endpoint, worker: rightWorker },
            )
            expect(betweenSteps).toMatchObject({
              revision: 0,
              metadataRevision: 1,
              canonicalRevision: 0,
              schemaVersion: '6',
              signalChangesCompactedThrough: 0,
              migrations: [
                {
                  id: 'canonical-schema-5-to-6-signal-journal',
                  sequence: 6,
                  fromSchemaVersion: '5',
                  toSchemaVersion: '6',
                  checksum: expect.stringMatching(/^[a-f0-9]{64}$/u),
                  state: 'succeeded',
                },
              ],
            })
            await left.close({ runBeforeUnload: false })
            expect(await interruptedSettlement).toBe('terminated')
            await independentCommand(right, 'open', {
              endpoint,
              worker: rightWorker,
              create: false,
              migrate: true,
            })
          }

          const completed = await independentCommand<IndependentMigrationDiagnostics>(
            right,
            'migrationDiagnostics',
          )
          expectCompleteMigration(completed)
          await independentCommand(right, 'reopen')
          expectCompleteMigration(
            await independentCommand<IndependentMigrationDiagnostics>(
              right,
              'migrationDiagnostics',
            ),
          )
          await independentCommand(right, 'close')
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
}, 90_000)

it('serializes destructive reset against a concurrent canonical writer without resurrection', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    optimizeDeps: { exclude: ['@astrale-os/surrealdb-wasm'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error('Vite did not expose a local browser URL')
    const independentUrl = new URL('test/browser/independent-context.html', origin).href
    const waitForGate = async (page: Page, method: string): Promise<void> => {
      await expect
        .poll(async () => (await independentCommand<{ reached: boolean }>(page, method)).reached, {
          timeout: 5_000,
          interval: 10,
        })
        .toBe(true)
    }

    for (const [leftWorker, rightWorker] of [
      [false, false],
      [true, true],
      [false, true],
    ] as const) {
      for (const scenario of ['write-wins', 'reset-wins'] as const) {
        const context = await browser.newContext()
        try {
          const left = await context.newPage()
          const right = await context.newPage()
          await Promise.all([left.goto(independentUrl), right.goto(independentUrl)])
          await Promise.all([
            left.waitForFunction(() => window.__temporalIndependentContext !== undefined),
            right.waitForFunction(() => window.__temporalIndependentContext !== undefined),
          ])
          const endpoint = `indxdb://resetRace${crypto.randomUUID().replaceAll('-', '')}`
          await independentCommand(left, 'open', {
            endpoint,
            worker: leftWorker,
            create: true,
          })
          await independentCommand(right, 'open', {
            endpoint,
            worker: rightWorker,
            create: false,
          })
          await independentCommand(left, 'seed')
          const contenderEpisodeId = 'reset-race-contender'
          const contenderOperationId = 'reset-race-operation'
          const diagnosticsInput = {
            endpoint,
            worker: rightWorker,
            episodeIds: ['shared-episode', contenderEpisodeId],
            operationIds: [contenderOperationId],
          }

          if (scenario === 'write-wins') {
            await independentCommand(left, 'armDeleteSpaceGate', { position: 'before' })
            const resetPending = independentCommand<IndependentResetSuccess | IndependentFailure>(
              left,
              'attemptReset',
            )
            void resetPending.catch(() => undefined)
            await waitForGate(left, 'deleteSpaceGateStatus')

            await expect(
              independentCommand<IndependentRememberSuccess>(right, 'attemptRememberEpisode', {
                id: contenderEpisodeId,
                operationId: contenderOperationId,
              }),
            ).resolves.toMatchObject({
              ok: true,
              episodeId: contenderEpisodeId,
              operation: {
                id: contenderOperationId,
                state: 'partial',
                stage: 'inference_failed',
              },
            })
            const beforeRelease = await independentCommand<IndependentResetDiagnostics>(
              right,
              'inspectResetStorage',
              diagnosticsInput,
            )
            expect(beforeRelease).toMatchObject({
              spaceExists: true,
              episodes: ['shared-episode', contenderEpisodeId],
              operations: [
                {
                  id: contenderOperationId,
                  state: 'partial',
                  stage: 'inference_failed',
                },
              ],
            })
            expect(beforeRelease.lifecycles).toContainEqual({
              operationId: contenderOperationId,
              action: 'accepted',
              targetId: contenderEpisodeId,
            })

            await independentCommand(left, 'releaseDeleteSpaceGate')
            await expect(resetPending).resolves.toMatchObject({
              ok: false,
              error: { code: 'conflict', retryable: true },
            })
            const afterConflict = await independentCommand<IndependentResetDiagnostics>(
              right,
              'inspectResetStorage',
              diagnosticsInput,
            )
            expect(afterConflict).toEqual(beforeRelease)
            await expect(
              independentCommand<IndependentResetSuccess>(left, 'attemptReset'),
            ).resolves.toMatchObject({
              ok: true,
              purged: true,
              affectedEpisodes: expect.arrayContaining(['shared-episode', contenderEpisodeId]),
            })
          } else {
            await independentCommand(right, 'armOperationCommitGate', {
              operationId: contenderOperationId,
              stage: 'accepted',
              position: 'before',
              semantic: true,
            })
            const writePending = independentCommand<
              IndependentRememberSuccess | IndependentFailure
            >(right, 'attemptRememberEpisode', {
              id: contenderEpisodeId,
              operationId: contenderOperationId,
            })
            void writePending.catch(() => undefined)
            await waitForGate(right, 'operationCommitGateStatus')

            await expect(
              independentCommand<IndependentResetSuccess>(left, 'attemptReset'),
            ).resolves.toMatchObject({
              ok: true,
              purged: true,
              affectedEpisodes: ['shared-episode'],
            })
            expect(
              await independentCommand<IndependentResetDiagnostics>(
                right,
                'inspectResetStorage',
                diagnosticsInput,
              ),
            ).toMatchObject({
              spaceExists: false,
              revision: null,
              episodes: [],
              operations: [],
              lifecycles: [],
            })

            await independentCommand(right, 'releaseOperationCommitGate')
            await expect(writePending).resolves.toMatchObject({
              ok: false,
              error: { code: 'space_not_found' },
            })
          }

          expect(
            await independentCommand<IndependentResetDiagnostics>(
              right,
              'inspectResetStorage',
              diagnosticsInput,
            ),
          ).toMatchObject({
            spaceExists: false,
            generation: null,
            revision: null,
            episodes: [],
            operations: [],
            lifecycles: [],
          })
          await Promise.all([independentCommand(left, 'close'), independentCommand(right, 'close')])
        } finally {
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
}, 90_000)

it('gives concurrent activation of one sync session exactly one durable owner', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    optimizeDeps: { exclude: ['@astrale-os/surrealdb-wasm'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error('Vite did not expose a local browser URL')
    const independentUrl = new URL('test/browser/independent-context.html', origin).href
    for (const [leftWorker, rightWorker] of [
      [false, false],
      [true, true],
      [false, true],
    ] as const) {
      const context = await browser.newContext()
      try {
        const left = await context.newPage()
        const right = await context.newPage()
        await Promise.all([left.goto(independentUrl), right.goto(independentUrl)])
        await Promise.all([
          left.waitForFunction(() => window.__temporalIndependentContext !== undefined),
          right.waitForFunction(() => window.__temporalIndependentContext !== undefined),
        ])
        const targetEndpoint = `indxdb://syncContention${crypto.randomUUID().replaceAll('-', '')}`
        const sourceEndpoint = `indxdb://syncContentionSource${crypto.randomUUID().replaceAll('-', '')}`
        const sessionId = 'contended-sync-session'
        const operationId = 'contended-sync-operation'
        await independentCommand(left, 'open', {
          endpoint: targetEndpoint,
          worker: leftWorker,
          create: true,
        })
        await independentCommand(right, 'open', {
          endpoint: targetEndpoint,
          worker: rightWorker,
          create: false,
        })
        const source = await independentCommand<{ checkpointId: string; records: number }>(
          left,
          'prepareSyncSource',
          {
            endpoint: sourceEndpoint,
            worker: leftWorker,
            checkpointOperationId: 'contended-source-checkpoint',
          },
        )
        const rightSource = await independentCommand<{ checkpointId: string; records: number }>(
          right,
          'openSyncSource',
          { endpoint: sourceEndpoint, worker: rightWorker },
        )
        expect(rightSource).toEqual(source)

        await independentCommand(left, 'armOperationCommitGate', {
          operationId,
          stage: 'applying',
          position: 'before',
          semantic: false,
        })
        const leftPending = independentCommand<IndependentSyncApplySuccess | IndependentFailure>(
          left,
          'attemptSyncApply',
          { sessionId, operationId },
        )
        await expect
          .poll(
            async () =>
              (await independentCommand<{ reached: boolean }>(left, 'operationCommitGateStatus'))
                .reached,
            { timeout: 5_000, interval: 10 },
          )
          .toBe(true)

        await independentCommand(right, 'armOperationCommitGate', {
          operationId,
          stage: 'applying',
          position: 'before',
          semantic: false,
        })
        const rightPending = independentCommand<IndependentSyncApplySuccess | IndependentFailure>(
          right,
          'attemptSyncApply',
          { sessionId, operationId },
        )
        await expect
          .poll(
            async () =>
              (await independentCommand<{ reached: boolean }>(right, 'operationCommitGateStatus'))
                .reached,
            { timeout: 5_000, interval: 10 },
          )
          .toBe(true)

        await Promise.all([
          independentCommand(left, 'releaseOperationCommitGate'),
          independentCommand(right, 'releaseOperationCommitGate'),
        ])
        const outcomes = await Promise.all([leftPending, rightPending])
        const successes = outcomes.filter(
          (outcome): outcome is IndependentSyncApplySuccess => outcome.ok,
        )
        const failures = outcomes.filter((outcome): outcome is IndependentFailure => !outcome.ok)
        expect(successes).toHaveLength(1)
        expect(successes[0]).toMatchObject({
          state: 'succeeded',
          operation: { id: operationId, state: 'succeeded', stage: 'completed' },
          checkpointId: source.checkpointId,
          appliedRecords: source.records,
          deletedRecords: 0,
        })
        expect(failures).toEqual([
          expect.objectContaining({
            ok: false,
            error: expect.objectContaining({ code: 'conflict', retryable: true }),
          }),
        ])

        const loser = outcomes[0]!.ok ? right : left
        const replay = await independentCommand<IndependentSyncApplySuccess | IndependentFailure>(
          loser,
          'attemptSyncApply',
          { sessionId, operationId },
        )
        expect(replay).toMatchObject({
          ok: true,
          state: 'succeeded',
          operation: { id: operationId, state: 'succeeded', stage: 'completed' },
          checkpointId: source.checkpointId,
          appliedRecords: source.records,
          deletedRecords: 0,
        })

        const diagnostics = await independentCommand<IndependentSyncDiagnostics>(
          left,
          'syncDiagnostics',
          { sessionId, operationId },
        )
        expect(diagnostics).toMatchObject({
          session: {
            id: sessionId,
            state: 'succeeded',
            operationId,
            appliedRecords: source.records,
            deletedRecords: 0,
            targetCheckpoint: source.checkpointId,
            checkpointId: source.checkpointId,
          },
          operation: {
            id: operationId,
            state: 'succeeded',
            stage: 'completed',
            attempts: 1,
          },
          head: source.checkpointId,
          episodes: ['sync-crash-episode-a', 'sync-crash-episode-b'],
          entities: ['sync-crash-entity-a', 'sync-crash-entity-b'],
          facts: [
            { id: 'sync-crash-fact-a', status: 'active' },
            { id: 'sync-crash-fact-b', status: 'active' },
          ],
          syncOperations: [{ id: operationId, state: 'succeeded', attempts: 1 }],
        })
        expect(diagnostics.syncChanges).toHaveLength(source.records)
        expect(new Set(diagnostics.syncChanges.map((change) => change.revision)).size).toBe(
          source.records,
        )
        const integrity = await independentCommand<{ ok: true; integrity: boolean }>(
          right,
          'attemptIntegrity',
        )
        expect(integrity).toMatchObject({ ok: true, integrity: true })
        await Promise.all([independentCommand(left, 'close'), independentCommand(right, 'close')])
      } finally {
        await context.close()
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
}, 60_000)

it('coordinates guarded reads, destructive writes, and compaction across independent clients', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'error',
    optimizeDeps: { exclude: ['@astrale-os/surrealdb-wasm'] },
    server: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error('Vite did not expose a local browser URL')
    const noLocksContext = await browser.newContext()
    await noLocksContext.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, 'locks', {
        configurable: true,
        get: () => undefined,
      })
    })
    const noLocksPage = await noLocksContext.newPage()
    const independentUrl = new URL('test/browser/independent-context.html', origin).href
    await noLocksPage.goto(independentUrl)
    await noLocksPage.waitForFunction(() => window.__temporalIndependentContext !== undefined)
    const attemptWithoutLocks = (endpoint: string) =>
      noLocksPage.evaluate(async (selectedEndpoint) => {
        const api = window.__temporalIndependentContext
        if (api === undefined) throw new Error('independent-context harness is not ready')
        try {
          const result = await api.open({
            endpoint: selectedEndpoint,
            worker: false,
            create: true,
          })
          return { ok: true as const, result }
        } catch (error) {
          const value = error as { code?: unknown; message?: unknown }
          return {
            ok: false as const,
            code: typeof value.code === 'string' ? value.code : 'unexpected',
            message: typeof value.message === 'string' ? value.message : String(error),
          }
        }
      }, endpoint)
    const persistentWithoutLocks = await attemptWithoutLocks(
      `indxdb://noLocks${crypto.randomUUID().replaceAll('-', '')}`,
    )
    expect(persistentWithoutLocks).toMatchObject({
      ok: false,
      code: 'storage_failed',
      message: expect.stringContaining('Web Locks API'),
    })
    const volatileWithoutLocks = await attemptWithoutLocks(
      `mem://noLocks${crypto.randomUUID().replaceAll('-', '')}`,
    )
    expect(volatileWithoutLocks).toMatchObject({
      ok: true,
      result: { revision: 0, episodes: 0, signals: 0, signalRevisions: 0 },
    })
    await independentCommand(noLocksPage, 'close')
    await noLocksContext.close()
    for (const [leftWorker, rightWorker] of [
      [false, false],
      [true, true],
      [false, true],
    ] as const) {
      const context = await browser.newContext()
      const left = await context.newPage()
      let right = await context.newPage()
      await Promise.all([left.goto(independentUrl), right.goto(independentUrl)])
      await Promise.all([
        left.waitForFunction(() => window.__temporalIndependentContext !== undefined),
        right.waitForFunction(() => window.__temporalIndependentContext !== undefined),
      ])
      const endpoint = `indxdb://independent${crypto.randomUUID().replaceAll('-', '')}`
      await independentCommand(left, 'open', { endpoint, worker: leftWorker, create: true })
      await independentCommand(left, 'seed')
      await independentCommand(right, 'open', { endpoint, worker: rightWorker, create: false })
      const semanticBaseline = await independentCommand<{ cursor: string; revision: number }>(
        left,
        'changeBaseline',
      )
      const raceRead = async <T>(
        method: string,
        kind:
          | 'change'
          | 'derivation'
          | 'entity'
          | 'episode'
          | 'projection'
          | 'signal'
          | 'signal_change',
        mutate: () => Promise<unknown>,
      ): Promise<T> => {
        await independentCommand(left, 'armReadGate', { kind })
        const pending = independentCommand<T>(left, method)
        try {
          await expect
            .poll(
              async () =>
                (await independentCommand<{ reached: boolean }>(left, 'readGateStatus')).reached,
              { timeout: 5_000, interval: 10 },
            )
            .toBe(true)
          await mutate()
        } finally {
          await independentCommand(left, 'releaseReadGate')
        }
        return pending
      }
      const raceCompaction = async (
        method: 'attemptCompactChanges' | 'attemptCompactSignalChanges',
        kind: 'change' | 'signal_change',
        expectedRevision: number,
        cursor: string,
        registered = false,
      ): Promise<(IndependentCompactionSuccess | IndependentFailure)[]> => {
        await Promise.all([
          independentCommand(left, 'armReadGate', { kind }),
          independentCommand(right, 'armReadGate', { kind }),
        ])
        const pending = [left, right].map((page) =>
          independentCommand<IndependentCompactionSuccess | IndependentFailure>(page, method, {
            expectedRevision,
            cursor,
            ...(registered ? { registered: true } : {}),
          }),
        )
        try {
          await expect
            .poll(
              async () =>
                (
                  await Promise.all(
                    [left, right].map((page) =>
                      independentCommand<{ reached: boolean }>(page, 'readGateStatus'),
                    ),
                  )
                ).every((status) => status.reached),
              { timeout: 5_000, interval: 10 },
            )
            .toBe(true)
        } finally {
          await Promise.all(
            [left, right].map((page) => independentCommand(page, 'releaseReadGate')),
          )
        }
        return Promise.all(pending)
      }
      const raceDerivation = async (
        method: 'attemptDeriveFact' | 'attemptWithdrawDerivation',
        inputs: readonly [Record<string, unknown>, Record<string, unknown>],
      ): Promise<(IndependentDerivationSuccess | IndependentFailure)[]> => {
        await Promise.all([
          independentCommand(left, 'armDerivationCommitGate'),
          independentCommand(right, 'armDerivationCommitGate'),
        ])
        const pending = [left, right].map((page, index) =>
          independentCommand<IndependentDerivationSuccess | IndependentFailure>(
            page,
            method,
            inputs[index],
          ),
        )
        try {
          await expect
            .poll(
              async () =>
                (
                  await Promise.all(
                    [left, right].map((page) =>
                      independentCommand<{ reached: boolean }>(page, 'derivationCommitGateStatus'),
                    ),
                  )
                ).every((status) => status.reached),
              { timeout: 5_000, interval: 10 },
            )
            .toBe(true)
        } finally {
          await Promise.all(
            [left, right].map((page) => independentCommand(page, 'releaseDerivationCommitGate')),
          )
        }
        return Promise.all(pending)
      }
      const raceDerivationBatch = async <
        TSuccess extends
          | IndependentDerivationBatchSuccess
          | IndependentDerivationWithdrawalBatchSuccess,
      >(
        method: 'attemptDeriveFacts' | 'attemptWithdrawDerivations',
        inputs: readonly [Record<string, unknown>, Record<string, unknown>],
      ): Promise<(TSuccess | IndependentFailure)[]> => {
        await Promise.all([
          independentCommand(left, 'armDerivationCommitGate'),
          independentCommand(right, 'armDerivationCommitGate'),
        ])
        const pending = [left, right].map((page, index) =>
          independentCommand<TSuccess | IndependentFailure>(page, method, inputs[index]),
        )
        try {
          await expect
            .poll(
              async () =>
                (
                  await Promise.all(
                    [left, right].map((page) =>
                      independentCommand<{ reached: boolean }>(page, 'derivationCommitGateStatus'),
                    ),
                  )
                ).every((status) => status.reached),
              { timeout: 5_000, interval: 10 },
            )
            .toBe(true)
        } finally {
          await Promise.all(
            [left, right].map((page) => independentCommand(page, 'releaseDerivationCommitGate')),
          )
        }
        return Promise.all(pending)
      }
      const logicalReadRaces = [
        ['attemptSnapshot', 'episode'],
        ['attemptRecall', 'episode'],
        ['attemptPointRead', 'entity'],
        ['attemptBrowse', 'episode'],
        ['attemptNeighborhood', 'episode'],
        ['attemptAnalyze', 'episode'],
        ['attemptExport', 'episode'],
        ['attemptIntegrity', 'episode'],
        ['previewEpisodeDeletions', 'episode'],
        ['previewDerivationWithdrawals', 'derivation'],
        ['attemptSignalBrowse', 'signal'],
        ['attemptChanges', 'change'],
        ['attemptSignalChanges', 'signal_change'],
      ] as const
      for (const [method, kind] of logicalReadRaces) {
        const label = method.replace(/^attempt/u, '').toLowerCase()
        const raced = await raceRead<IndependentFailure>(method, kind, () =>
          independentCommand(right, 'rememberEpisode', {
            id: `${label}-race-episode`,
            text: `An independent writer overlaps ${label} assembly.`,
          }),
        )
        expect(raced).toMatchObject({
          ok: false,
          error: { code: 'conflict', retryable: true },
        })
      }

      await independentCommand(left, 'seedEpisodeDeletionGroup')
      const episodeDeletionPreview = await independentCommand<
        IndependentEpisodeDeletionPreview | IndependentFailure
      >(left, 'previewEpisodeDeletions', {
        sourceKind: 'independent-episode-deletion',
        maxMatches: 2,
      })
      expect(episodeDeletionPreview).toMatchObject({
        ok: true,
        selectionCursor: expect.any(String),
        episodeIds: ['independent-episode-delete-a', 'independent-episode-delete-b'],
      })
      if (!episodeDeletionPreview.ok || episodeDeletionPreview.selectionCursor === undefined) {
        throw new Error('independent episode deletion preview failed')
      }
      const episodeDeletionOperationIds = [
        'independent-episode-delete-left',
        'independent-episode-delete-right',
      ] as const
      await Promise.all(
        [left, right].map((page, index) =>
          independentCommand(page, 'armOperationCommitGate', {
            operationId: episodeDeletionOperationIds[index],
            stage: 'completed',
            position: 'before',
            semantic: true,
          }),
        ),
      )
      const episodeDeletionAttempts = [left, right].map((page, index) =>
        independentCommand<IndependentEpisodeDeletionSuccess | IndependentFailure>(
          page,
          'attemptDeleteEpisodes',
          {
            sourceKind: 'independent-episode-deletion',
            expectedRevision: episodeDeletionPreview.revision,
            maxMatches: 2,
            selectionCursor: episodeDeletionPreview.selectionCursor,
            operationId: episodeDeletionOperationIds[index],
          },
        ),
      )
      try {
        await expect
          .poll(
            async () =>
              (
                await Promise.all(
                  [left, right].map((page) =>
                    independentCommand<{ reached: boolean }>(page, 'operationCommitGateStatus'),
                  ),
                )
              ).every((status) => status.reached),
            { timeout: 5_000, interval: 10 },
          )
          .toBe(true)
      } finally {
        await Promise.all(
          [left, right].map((page) => independentCommand(page, 'releaseOperationCommitGate')),
        )
      }
      const episodeDeletionOutcomes = await Promise.all(episodeDeletionAttempts)
      const episodeDeletionWinners = episodeDeletionOutcomes.filter(
        (outcome): outcome is IndependentEpisodeDeletionSuccess => outcome.ok,
      )
      const episodeDeletionLosers = episodeDeletionOutcomes.filter(
        (outcome): outcome is IndependentFailure => !outcome.ok,
      )
      expect(episodeDeletionWinners).toEqual([
        expect.objectContaining({
          ok: true,
          revision: episodeDeletionPreview.revision + 1,
          affectedEpisodes: ['independent-episode-delete-a', 'independent-episode-delete-b'],
          unsupportedFacts: [],
        }),
      ])
      expect(episodeDeletionLosers).toEqual([
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'conflict', retryable: true }),
        }),
      ])
      const episodeDeletionWinner = episodeDeletionWinners[0]!
      const episodeDeletionLoserIndex = episodeDeletionOutcomes[0]?.ok === false ? 0 : 1
      const episodeDeletionLoserPage = episodeDeletionLoserIndex === 0 ? left : right
      const episodeDeletionLoserOperationId = episodeDeletionOperationIds[episodeDeletionLoserIndex]
      const episodeDeletionDiagnostics =
        await independentCommand<IndependentEpisodeDeletionDiagnostics>(
          right,
          'episodeDeletionDiagnostics',
          {
            episodeIds: episodeDeletionPreview.episodeIds,
            operationIds: [...episodeDeletionOperationIds],
          },
        )
      expect(episodeDeletionDiagnostics).toMatchObject({
        revision: episodeDeletionWinner.revision,
        episodes: [
          { id: 'independent-episode-delete-a', retentionState: 'deleted' },
          { id: 'independent-episode-delete-b', retentionState: 'deleted' },
        ],
        operations: [episodeDeletionWinner.operationId],
        lifecycle: [
          {
            operationId: episodeDeletionWinner.operationId,
            targetId: 'independent-episode-delete-a',
            action: 'deleted',
          },
          {
            operationId: episodeDeletionWinner.operationId,
            targetId: 'independent-episode-delete-b',
            action: 'deleted',
          },
        ],
        changes: [{ operationId: episodeDeletionWinner.operationId, phase: 'governance' }],
      })
      const episodeDeletionReplay = await independentCommand<
        IndependentEpisodeDeletionSuccess | IndependentFailure
      >(episodeDeletionLoserPage, 'attemptDeleteEpisodes', {
        sourceKind: 'independent-episode-deletion',
        expectedRevision: episodeDeletionPreview.revision,
        maxMatches: 2,
        selectionCursor: episodeDeletionPreview.selectionCursor,
        operationId: episodeDeletionWinner.operationId,
      })
      expect(episodeDeletionReplay).toEqual(episodeDeletionWinner)
      const episodeDeletionRetryPreview = await independentCommand<
        IndependentEpisodeDeletionPreview | IndependentFailure
      >(episodeDeletionLoserPage, 'previewEpisodeDeletions', {
        sourceKind: 'independent-episode-deletion',
        maxMatches: 2,
      })
      expect(episodeDeletionRetryPreview).toEqual({
        ok: true,
        revision: episodeDeletionWinner.revision,
        selectionCursor: undefined,
        episodeIds: [],
      })
      const episodeDeletionRetry = await independentCommand<
        IndependentEpisodeDeletionSuccess | IndependentFailure
      >(episodeDeletionLoserPage, 'attemptDeleteEpisodes', {
        sourceKind: 'independent-episode-deletion',
        expectedRevision: episodeDeletionWinner.revision,
        maxMatches: 2,
        operationId: episodeDeletionLoserOperationId,
      })
      expect(episodeDeletionRetry).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      })
      expect(
        await independentCommand<IndependentEpisodeDeletionDiagnostics>(
          left,
          'episodeDeletionDiagnostics',
          {
            episodeIds: episodeDeletionPreview.episodeIds,
            operationIds: [...episodeDeletionOperationIds],
          },
        ),
      ).toEqual(episodeDeletionDiagnostics)

      const beforeCheckpoint = await independentCommand<{ revision: number }>(left, 'stats')
      const statsRace = await raceRead<IndependentFailure>(
        'attemptStats',
        'derivation',
        async () => {
          const checkpoint = await independentCommand<{
            beforeRevision: number
            afterRevision: number
          }>(right, 'createCheckpoint', {
            operationId: `independent-checkpoint-${leftWorker ? 'worker' : 'direct'}-${rightWorker ? 'worker' : 'direct'}`,
          })
          expect(checkpoint).toMatchObject({
            beforeRevision: beforeCheckpoint.revision,
            afterRevision: beforeCheckpoint.revision,
          })
        },
      )
      expect(statsRace).toMatchObject({
        ok: false,
        error: { code: 'conflict', retryable: true },
      })
      const beforeInspectionCheckpoint = await independentCommand<{ revision: number }>(
        left,
        'stats',
      )
      const inspectionRace = await raceRead<IndependentFailure>(
        'attemptInspect',
        'projection',
        async () => {
          const checkpoint = await independentCommand<{
            beforeRevision: number
            afterRevision: number
          }>(right, 'createCheckpoint', {
            operationId: `independent-inspection-checkpoint-${leftWorker ? 'worker' : 'direct'}-${rightWorker ? 'worker' : 'direct'}`,
          })
          expect(checkpoint).toMatchObject({
            beforeRevision: beforeInspectionCheckpoint.revision,
            afterRevision: beforeInspectionCheckpoint.revision,
          })
        },
      )
      expect(inspectionRace).toMatchObject({
        ok: false,
        error: { code: 'conflict', retryable: true },
      })

      const derivationBatchBaseline = await independentCommand<{ revision: number }>(left, 'stats')
      const batchOperationIds = ['independent-batch-left', 'independent-batch-right'] as const
      const batchAttempts = await raceDerivationBatch<IndependentDerivationBatchSuccess>(
        'attemptDeriveFacts',
        [
          {
            expectedRevision: derivationBatchBaseline.revision,
            operationId: batchOperationIds[0],
          },
          {
            expectedRevision: derivationBatchBaseline.revision,
            operationId: batchOperationIds[1],
          },
        ],
      )
      const batchWinners = batchAttempts.filter(
        (attempt): attempt is IndependentDerivationBatchSuccess => attempt.ok,
      )
      const batchLosers = batchAttempts.filter(
        (attempt): attempt is IndependentFailure => !attempt.ok,
      )
      expect(batchWinners).toEqual([
        expect.objectContaining({
          ok: true,
          revision: derivationBatchBaseline.revision + 1,
          results: [
            expect.objectContaining({
              outcome: 'created',
              derivation: expect.objectContaining({ version: 1, state: 'active' }),
              conclusion: { id: 'independent-batch-derived-one', status: 'active' },
            }),
            expect.objectContaining({
              outcome: 'created',
              derivation: expect.objectContaining({ version: 1, state: 'active' }),
              conclusion: { id: 'independent-batch-derived-two', status: 'active' },
            }),
          ],
          invalidatedDerivations: [],
          unsupportedFacts: [],
        }),
      ])
      expect(batchLosers).toEqual([
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'conflict', retryable: true }),
        }),
      ])
      const batchWinner = batchWinners[0]!
      const batchLoserIndex = batchAttempts[0]?.ok === false ? 0 : 1
      const batchLoserOperationId = batchOperationIds[batchLoserIndex]
      const batchRetryPage = batchLoserIndex === 0 ? left : right
      const afterBatchRace = await independentCommand<IndependentDerivationBatchDiagnostics>(
        right,
        'derivationBatchDiagnostics',
        { operationIds: [...batchOperationIds] },
      )
      expect(afterBatchRace.facts).toEqual([
        { id: 'independent-batch-derived-one', status: 'active' },
        { id: 'independent-batch-derived-two', status: 'active' },
      ])
      expect(afterBatchRace.derivations).toEqual([
        expect.objectContaining({
          conclusionFactId: 'independent-batch-derived-one',
          version: 1,
          state: 'active',
          operationId: batchWinner.operationId,
        }),
        expect.objectContaining({
          conclusionFactId: 'independent-batch-derived-two',
          version: 1,
          state: 'active',
          operationId: batchWinner.operationId,
        }),
      ])
      expect(afterBatchRace.operations).toEqual([batchWinner.operationId])
      expect(afterBatchRace.changes).toEqual([
        { operationId: batchWinner.operationId, phase: 'governance' },
      ])

      const batchReplay = await independentCommand<
        IndependentDerivationBatchSuccess | IndependentFailure
      >(batchRetryPage, 'attemptDeriveFacts', {
        expectedRevision: derivationBatchBaseline.revision,
        operationId: batchWinner.operationId,
      })
      expect(batchReplay).toMatchObject(batchWinner)
      const batchRetry = await independentCommand<
        IndependentDerivationBatchSuccess | IndependentFailure
      >(batchRetryPage, 'attemptDeriveFacts', {
        expectedRevision: batchWinner.revision,
        operationId: batchLoserOperationId,
      })
      expect(batchRetry).toMatchObject({
        ok: true,
        revision: batchWinner.revision + 1,
        operationId: batchLoserOperationId,
        results: [
          {
            outcome: 'supported',
            derivation: batchWinner.results[0]!.derivation,
            conclusion: batchWinner.results[0]!.conclusion,
          },
          {
            outcome: 'supported',
            derivation: batchWinner.results[1]!.derivation,
            conclusion: batchWinner.results[1]!.conclusion,
          },
        ],
        invalidatedDerivations: [],
        unsupportedFacts: [],
      })
      const afterBatchRetry = await independentCommand<IndependentDerivationBatchDiagnostics>(
        left,
        'derivationBatchDiagnostics',
        { operationIds: [...batchOperationIds] },
      )
      expect(afterBatchRetry.derivations).toHaveLength(2)
      expect(afterBatchRetry.operations).toEqual([...batchOperationIds].sort())
      expect(afterBatchRetry.changes).toEqual([
        { operationId: batchWinner.operationId, phase: 'governance' },
      ])

      const withdrawalBatchPreview = await independentCommand<
        IndependentDerivationWithdrawalPreview | IndependentFailure
      >(left, 'previewDerivationWithdrawals')
      expect(withdrawalBatchPreview).toMatchObject({
        ok: true,
        selectionCursor: expect.any(String),
        derivationIds: expect.arrayContaining(
          batchWinner.results.map((item) => item.derivation.id),
        ),
      })
      if (!withdrawalBatchPreview.ok || withdrawalBatchPreview.selectionCursor === undefined) {
        throw new Error('independent derivation withdrawal preview failed')
      }
      const withdrawalBatchBaseline = { revision: withdrawalBatchPreview.revision }
      const withdrawalBatchOperationIds = [
        'independent-withdrawal-batch-left',
        'independent-withdrawal-batch-right',
      ] as const
      const withdrawalBatchAttempts =
        await raceDerivationBatch<IndependentDerivationWithdrawalBatchSuccess>(
          'attemptWithdrawDerivations',
          [
            {
              expectedRevision: withdrawalBatchBaseline.revision,
              operationId: withdrawalBatchOperationIds[0],
              selectionCursor: withdrawalBatchPreview.selectionCursor,
            },
            {
              expectedRevision: withdrawalBatchBaseline.revision,
              operationId: withdrawalBatchOperationIds[1],
              selectionCursor: withdrawalBatchPreview.selectionCursor,
            },
          ],
        )
      const withdrawalBatchWinners = withdrawalBatchAttempts.filter(
        (attempt): attempt is IndependentDerivationWithdrawalBatchSuccess => attempt.ok,
      )
      const withdrawalBatchLosers = withdrawalBatchAttempts.filter(
        (attempt): attempt is IndependentFailure => !attempt.ok,
      )
      expect(withdrawalBatchWinners).toHaveLength(1)
      const withdrawalBatchWinner = withdrawalBatchWinners[0]!
      expect(withdrawalBatchWinner).toMatchObject({
        ok: true,
        revision: withdrawalBatchBaseline.revision + 1,
        invalidatedDerivations: [],
        unsupportedFacts: ['independent-batch-derived-one', 'independent-batch-derived-two'],
      })
      expect(withdrawalBatchWinner.withdrawals).toHaveLength(2)
      expect(
        withdrawalBatchWinner.withdrawals.map((withdrawal) => withdrawal.conclusionFactId).sort(),
      ).toEqual(['independent-batch-derived-one', 'independent-batch-derived-two'])
      expect(withdrawalBatchLosers).toEqual([
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'conflict', retryable: true }),
        }),
      ])

      const withdrawalBatchLoserIndex = withdrawalBatchAttempts[0]?.ok === false ? 0 : 1
      const withdrawalBatchLoserPage = withdrawalBatchLoserIndex === 0 ? left : right
      const withdrawalBatchLoserOperationId = withdrawalBatchOperationIds[withdrawalBatchLoserIndex]
      const afterWithdrawalBatchRace =
        await independentCommand<IndependentDerivationBatchDiagnostics>(
          right,
          'derivationBatchDiagnostics',
          { operationIds: [...withdrawalBatchOperationIds] },
        )
      expect(afterWithdrawalBatchRace.facts).toEqual([
        { id: 'independent-batch-derived-one', status: 'retracted' },
        { id: 'independent-batch-derived-two', status: 'retracted' },
      ])
      const activeBatchDerivations = afterWithdrawalBatchRace.derivations.filter(
        (derivation) => derivation.state === 'active',
      )
      const withdrawnBatchDerivations = afterWithdrawalBatchRace.derivations.filter(
        (derivation) => derivation.state === 'withdrawn',
      )
      expect(activeBatchDerivations).toHaveLength(2)
      expect(withdrawnBatchDerivations).toHaveLength(2)
      for (const withdrawal of withdrawnBatchDerivations) {
        const original = activeBatchDerivations.find(
          (derivation) => derivation.conclusionFactId === withdrawal.conclusionFactId,
        )
        expect(withdrawal).toMatchObject({
          version: 2,
          operationId: withdrawalBatchWinner.operationId,
          supersedes: original?.id,
        })
      }
      expect(afterWithdrawalBatchRace.operations).toEqual([withdrawalBatchWinner.operationId])
      expect(afterWithdrawalBatchRace.changes).toEqual([
        { operationId: withdrawalBatchWinner.operationId, phase: 'governance' },
      ])

      const withdrawalBatchReplay = await independentCommand<
        IndependentDerivationWithdrawalBatchSuccess | IndependentFailure
      >(withdrawalBatchLoserPage, 'attemptWithdrawDerivations', {
        expectedRevision: withdrawalBatchBaseline.revision,
        operationId: withdrawalBatchWinner.operationId,
        selectionCursor: withdrawalBatchPreview.selectionCursor,
      })
      expect(withdrawalBatchReplay).toEqual(withdrawalBatchWinner)
      const withdrawalBatchRetryPreview = await independentCommand<
        IndependentDerivationWithdrawalPreview | IndependentFailure
      >(withdrawalBatchLoserPage, 'previewDerivationWithdrawals')
      expect(withdrawalBatchRetryPreview).toEqual({
        ok: true,
        revision: withdrawalBatchWinner.revision,
        selectionCursor: undefined,
        derivationIds: [],
      })
      const withdrawalBatchRetry = await independentCommand<
        IndependentDerivationWithdrawalBatchSuccess | IndependentFailure
      >(withdrawalBatchLoserPage, 'attemptWithdrawDerivations', {
        expectedRevision: withdrawalBatchWinner.revision,
        operationId: withdrawalBatchLoserOperationId,
      })
      expect(withdrawalBatchRetry).toMatchObject({
        ok: false,
        error: { code: 'not_found' },
      })
      const afterWithdrawalBatchRetry =
        await independentCommand<IndependentDerivationBatchDiagnostics>(
          left,
          'derivationBatchDiagnostics',
          { operationIds: [...withdrawalBatchOperationIds] },
        )
      expect(afterWithdrawalBatchRetry).toEqual(afterWithdrawalBatchRace)

      const derivationBaseline = await independentCommand<{ revision: number }>(left, 'stats')
      const rootOperationIds = ['independent-root-left', 'independent-root-right'] as const
      const rootAttempts = await raceDerivation('attemptDeriveFact', [
        {
          kind: 'root',
          expectedRevision: derivationBaseline.revision,
          operationId: rootOperationIds[0],
        },
        {
          kind: 'root',
          expectedRevision: derivationBaseline.revision,
          operationId: rootOperationIds[1],
        },
      ])
      const rootWinners = rootAttempts.filter(
        (attempt): attempt is IndependentDerivationSuccess => attempt.ok,
      )
      const rootLosers = rootAttempts.filter(
        (attempt): attempt is IndependentFailure => !attempt.ok,
      )
      expect(rootWinners).toEqual([
        expect.objectContaining({
          ok: true,
          revision: derivationBaseline.revision + 1,
          outcome: 'created',
          derivation: expect.objectContaining({ version: 1, state: 'active' }),
          conclusion: { id: 'independent-derived-root', status: 'active' },
          invalidatedDerivations: [],
          unsupportedFacts: [],
        }),
      ])
      expect(rootLosers).toEqual([
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'conflict', retryable: true }),
        }),
      ])
      const rootWinner = rootWinners[0]!
      const rootLoserIndex = rootAttempts[0]?.ok === false ? 0 : 1
      const rootLoserOperationId = rootOperationIds[rootLoserIndex]
      const afterRootRace = await independentCommand<IndependentDerivationDiagnostics>(
        right,
        'derivationDiagnostics',
        { operationIds: [...rootOperationIds] },
      )
      expect(afterRootRace.facts).toEqual([
        { id: 'independent-derived-leaf', status: null },
        { id: 'independent-derived-root', status: 'active' },
      ])
      expect(afterRootRace.derivations).toEqual([
        expect.objectContaining({
          id: rootWinner.derivation.id,
          conclusionFactId: 'independent-derived-root',
          version: 1,
          state: 'active',
          operationId: rootWinner.operationId,
          supersedes: null,
          invalidPremises: 0,
        }),
      ])
      expect(afterRootRace.operations).toEqual([rootWinner.operationId])
      expect(afterRootRace.changes).toEqual([
        { operationId: rootWinner.operationId, phase: 'governance' },
      ])

      const rootRetryPage = rootLoserIndex === 0 ? left : right
      const rootReplay = await independentCommand<
        IndependentDerivationSuccess | IndependentFailure
      >(rootRetryPage, 'attemptDeriveFact', {
        kind: 'root',
        expectedRevision: derivationBaseline.revision,
        operationId: rootWinner.operationId,
      })
      expect(rootReplay).toMatchObject({
        ok: true,
        revision: rootWinner.revision,
        operationId: rootWinner.operationId,
        outcome: 'created',
        derivation: rootWinner.derivation,
        conclusion: rootWinner.conclusion,
        invalidatedDerivations: [],
        unsupportedFacts: [],
      })
      const rootRetry = await independentCommand<IndependentDerivationSuccess | IndependentFailure>(
        rootRetryPage,
        'attemptDeriveFact',
        {
          kind: 'root',
          expectedRevision: rootWinner.revision,
          operationId: rootLoserOperationId,
        },
      )
      expect(rootRetry).toMatchObject({
        ok: true,
        revision: rootWinner.revision + 1,
        operationId: rootLoserOperationId,
        outcome: 'supported',
        derivation: { id: rootWinner.derivation.id, version: 1, state: 'active' },
        conclusion: { id: 'independent-derived-root', status: 'active' },
        invalidatedDerivations: [],
        unsupportedFacts: [],
      })
      if (!rootRetry.ok) throw new Error('explicit derivation retry did not succeed')

      const leafOperationId = 'independent-leaf-create'
      const leaf = await independentCommand<IndependentDerivationSuccess | IndependentFailure>(
        right,
        'attemptDeriveFact',
        {
          kind: 'leaf',
          expectedRevision: rootRetry.revision,
          operationId: leafOperationId,
        },
      )
      expect(leaf).toMatchObject({
        ok: true,
        revision: rootRetry.revision + 1,
        operationId: leafOperationId,
        outcome: 'created',
        derivation: expect.objectContaining({ version: 1, state: 'active' }),
        conclusion: { id: 'independent-derived-leaf', status: 'active' },
        invalidatedDerivations: [],
        unsupportedFacts: [],
      })
      if (!leaf.ok) throw new Error('downstream derivation did not succeed')

      const withdrawalOperationIds = [
        'independent-withdraw-left',
        'independent-withdraw-right',
      ] as const
      const derivationWithdrawalAttempts = await raceDerivation('attemptWithdrawDerivation', [
        {
          derivationId: rootWinner.derivation.id,
          expectedRevision: leaf.revision,
          operationId: withdrawalOperationIds[0],
        },
        {
          derivationId: rootWinner.derivation.id,
          expectedRevision: leaf.revision,
          operationId: withdrawalOperationIds[1],
        },
      ])
      const derivationWithdrawalWinners = derivationWithdrawalAttempts.filter(
        (attempt): attempt is IndependentDerivationSuccess => attempt.ok,
      )
      const derivationWithdrawalLosers = derivationWithdrawalAttempts.filter(
        (attempt): attempt is IndependentFailure => !attempt.ok,
      )
      expect(derivationWithdrawalWinners).toHaveLength(1)
      expect(derivationWithdrawalWinners[0]).toMatchObject({
        ok: true,
        revision: leaf.revision + 1,
        outcome: 'withdrawn',
        derivation: expect.objectContaining({ version: 2, state: 'withdrawn' }),
        conclusion: { id: 'independent-derived-root', status: 'retracted' },
        invalidatedDerivations: [expect.any(String)],
        unsupportedFacts: ['independent-derived-leaf', 'independent-derived-root'],
      })
      expect(derivationWithdrawalLosers).toEqual([
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'conflict', retryable: true }),
        }),
      ])
      const derivationWithdrawalWinner = derivationWithdrawalWinners[0]!
      const derivationWithdrawalLoserIndex = derivationWithdrawalAttempts[0]?.ok === false ? 0 : 1
      const derivationWithdrawalLoserOperationId =
        withdrawalOperationIds[derivationWithdrawalLoserIndex]
      const withdrawalReplayPage = derivationWithdrawalLoserIndex === 0 ? left : right
      const withdrawalReplay = await independentCommand<
        IndependentDerivationSuccess | IndependentFailure
      >(withdrawalReplayPage, 'attemptWithdrawDerivation', {
        derivationId: rootWinner.derivation.id,
        expectedRevision: leaf.revision,
        operationId: derivationWithdrawalWinner.operationId,
      })
      expect(withdrawalReplay).toMatchObject({
        ok: true,
        revision: derivationWithdrawalWinner.revision,
        operationId: derivationWithdrawalWinner.operationId,
        outcome: 'withdrawn',
        derivation: derivationWithdrawalWinner.derivation,
        conclusion: derivationWithdrawalWinner.conclusion,
        invalidatedDerivations: derivationWithdrawalWinner.invalidatedDerivations,
        unsupportedFacts: derivationWithdrawalWinner.unsupportedFacts,
      })
      const allDerivationOperationIds = [
        ...rootOperationIds,
        leafOperationId,
        ...withdrawalOperationIds,
      ]
      const afterDerivationWithdrawal = await independentCommand<IndependentDerivationDiagnostics>(
        left,
        'derivationDiagnostics',
        { operationIds: allDerivationOperationIds },
      )
      expect(afterDerivationWithdrawal.facts).toEqual([
        { id: 'independent-derived-leaf', status: 'retracted' },
        { id: 'independent-derived-root', status: 'retracted' },
      ])
      expect(afterDerivationWithdrawal.derivations).toHaveLength(4)
      expect(afterDerivationWithdrawal.derivations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: leaf.derivation.id,
            conclusionFactId: 'independent-derived-leaf',
            version: 1,
            state: 'active',
            operationId: leafOperationId,
          }),
          expect.objectContaining({
            conclusionFactId: 'independent-derived-leaf',
            version: 2,
            state: 'invalidated',
            operationId: derivationWithdrawalWinner.operationId,
            supersedes: leaf.derivation.id,
            invalidPremises: 1,
          }),
          expect.objectContaining({
            id: rootWinner.derivation.id,
            conclusionFactId: 'independent-derived-root',
            version: 1,
            state: 'active',
            operationId: rootWinner.operationId,
          }),
          expect.objectContaining({
            id: derivationWithdrawalWinner.derivation.id,
            conclusionFactId: 'independent-derived-root',
            version: 2,
            state: 'withdrawn',
            operationId: derivationWithdrawalWinner.operationId,
            supersedes: rootWinner.derivation.id,
            invalidPremises: 0,
          }),
        ]),
      )
      expect(afterDerivationWithdrawal.operations).toEqual(
        [
          rootWinner.operationId,
          rootLoserOperationId,
          leafOperationId,
          derivationWithdrawalWinner.operationId,
        ].sort(),
      )
      expect(afterDerivationWithdrawal.operations).not.toContain(
        derivationWithdrawalLoserOperationId,
      )
      expect(afterDerivationWithdrawal.changes).toHaveLength(3)
      expect(afterDerivationWithdrawal.changes).toEqual(
        expect.arrayContaining(
          [rootWinner.operationId, leafOperationId, derivationWithdrawalWinner.operationId].map(
            (operationId) => ({ operationId, phase: 'governance' }),
          ),
        ),
      )
      expect(afterDerivationWithdrawal.changes).not.toContainEqual(
        expect.objectContaining({ operationId: rootLoserOperationId }),
      )
      expect(afterDerivationWithdrawal.changes).not.toContainEqual(
        expect.objectContaining({ operationId: derivationWithdrawalLoserOperationId }),
      )
      const derivationIntegrity = await independentCommand<{
        ok: true
        integrity: boolean
      }>(right, 'attemptIntegrity')
      expect(derivationIntegrity).toMatchObject({ ok: true, integrity: true })

      const baseline = await independentCommand<{
        cursor: string
        revision: number
        total: number
      }>(left, 'signalBaseline')
      expect(baseline.total).toBe(0)

      const attempts = await Promise.all([
        independentCommand<IndependentSuccess | IndependentFailure>(left, 'putSignal', {
          suffix: 'left',
          expectedRevision: baseline.revision,
        }),
        independentCommand<IndependentSuccess | IndependentFailure>(right, 'putSignal', {
          suffix: 'right',
          expectedRevision: baseline.revision,
        }),
      ])
      const winners = attempts.filter((attempt): attempt is IndependentSuccess => attempt.ok)
      const losers = attempts.filter((attempt): attempt is IndependentFailure => !attempt.ok)
      expect(winners).toHaveLength(1)
      expect(losers).toEqual([
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'conflict', retryable: true }),
        }),
      ])
      const afterRace = await independentCommand<{ total: number; slots: string[] }>(
        left,
        'signals',
      )
      expect(afterRace.total).toBe(1)
      expect(afterRace.slots).toHaveLength(1)
      const firstChanges = await independentCommand<{
        ok: true
        actions: string[]
      }>(left, 'signalChanges', { cursor: baseline.cursor })
      expect(firstChanges).toMatchObject({ ok: true, actions: ['put'] })

      const loserPage = attempts[0]?.ok === false ? left : right
      const retryBaseline = await independentCommand<{ revision: number }>(loserPage, 'stats')
      const retry = await independentCommand<IndependentSuccess | IndependentFailure>(
        loserPage,
        'putSignal',
        {
          suffix: attempts[0]?.ok === false ? 'left' : 'right',
          expectedRevision: retryBaseline.revision,
        },
      )
      expect(retry).toMatchObject({ ok: true, revision: retryBaseline.revision + 1 })

      const [leftSignals, rightSignals] = await Promise.all([
        independentCommand<{ revision: number; total: number; ids: string[]; slots: string[] }>(
          left,
          'signals',
        ),
        independentCommand<{ revision: number; total: number; ids: string[]; slots: string[] }>(
          right,
          'signals',
        ),
      ])
      expect(leftSignals).toEqual(rightSignals)
      expect(leftSignals).toMatchObject({ total: 2, slots: ['left', 'right'] })
      const secondChanges = await independentCommand<{ ok: true; actions: string[] }>(
        left,
        'signalChanges',
        { cursor: baseline.cursor },
      )
      expect(secondChanges).toMatchObject({ ok: true, actions: ['put', 'put'] })

      const withdrawalAttempts = await Promise.all([
        independentCommand<IndependentSignalDeletionSuccess | IndependentFailure>(
          left,
          'attemptDeleteSignals',
          {
            mode: 'withdraw',
            slot: 'left',
            expectedRevision: leftSignals.revision,
          },
        ),
        independentCommand<IndependentSignalDeletionSuccess | IndependentFailure>(
          right,
          'attemptDeleteSignals',
          {
            mode: 'withdraw',
            slot: 'left',
            expectedRevision: leftSignals.revision,
          },
        ),
      ])
      const withdrawalWinners = withdrawalAttempts.filter(
        (attempt): attempt is IndependentSignalDeletionSuccess => attempt.ok,
      )
      const withdrawalLosers = withdrawalAttempts.filter(
        (attempt): attempt is IndependentFailure => !attempt.ok,
      )
      expect(withdrawalWinners).toEqual([
        expect.objectContaining({
          ok: true,
          mode: 'withdraw',
          revision: leftSignals.revision + 1,
          matchedSignals: 1,
          withdrawn: 1,
          deletedRevisions: 0,
        }),
      ])
      expect(withdrawalWinners[0]!.affectedKeys).toHaveLength(1)
      expect(withdrawalLosers).toEqual([
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'conflict', retryable: true }),
        }),
      ])
      const withdrawnHistory = await independentCommand<{
        total: number
        revisions: { version: number; state: string }[]
      }>(right, 'signalHistory', { slot: 'left' })
      expect(withdrawnHistory).toMatchObject({
        total: 2,
        revisions: [
          { version: 1, state: 'active' },
          { version: 2, state: 'withdrawn' },
        ],
      })
      const afterWithdrawal = await independentCommand<{ total: number; slots: string[] }>(
        left,
        'signals',
      )
      expect(afterWithdrawal).toMatchObject({ total: 1, slots: ['right'] })
      const withdrawalChanges = await independentCommand<{ ok: true; actions: string[] }>(
        right,
        'signalChanges',
        { cursor: baseline.cursor },
      )
      expect(withdrawalChanges).toMatchObject({ actions: ['put', 'put', 'withdraw'] })

      const purgeAttempts = await Promise.all([
        independentCommand<IndependentSignalDeletionSuccess | IndependentFailure>(
          left,
          'attemptDeleteSignals',
          {
            mode: 'purge',
            slot: 'left',
            states: ['withdrawn'],
            expectedRevision: withdrawalWinners[0]!.revision,
          },
        ),
        independentCommand<IndependentSignalDeletionSuccess | IndependentFailure>(
          right,
          'attemptDeleteSignals',
          {
            mode: 'purge',
            slot: 'left',
            states: ['withdrawn'],
            expectedRevision: withdrawalWinners[0]!.revision,
          },
        ),
      ])
      const purgeWinners = purgeAttempts.filter(
        (attempt): attempt is IndependentSignalDeletionSuccess => attempt.ok,
      )
      const purgeLosers = purgeAttempts.filter(
        (attempt): attempt is IndependentFailure => !attempt.ok,
      )
      expect(purgeWinners).toEqual([
        expect.objectContaining({
          ok: true,
          mode: 'purge',
          revision: withdrawalWinners[0]!.revision + 1,
          matchedSignals: 1,
          withdrawn: 0,
          deletedRevisions: 2,
        }),
      ])
      expect(purgeWinners[0]!.affectedKeys).toEqual(withdrawalWinners[0]!.affectedKeys)
      expect(purgeLosers).toEqual([
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'conflict', retryable: true }),
        }),
      ])
      const purgedHistory = await independentCommand<{ total: number }>(right, 'signalHistory', {
        slot: 'left',
      })
      expect(purgedHistory.total).toBe(0)
      const afterSignalDeletion = await independentCommand<{
        revision: number
        total: number
        slots: string[]
      }>(left, 'signals')
      expect(afterSignalDeletion).toMatchObject({
        revision: purgeWinners[0]!.revision,
        total: 1,
        slots: ['right'],
      })
      const deletionChanges = await independentCommand<{ ok: true; actions: string[] }>(
        left,
        'signalChanges',
        { cursor: baseline.cursor },
      )
      expect(deletionChanges).toMatchObject({ actions: ['put', 'put', 'withdraw', 'purge'] })

      const signalCompactionBaseline = await independentCommand<{
        cursor: string
        revision: number
      }>(left, 'signalBaseline')
      expect(signalCompactionBaseline.revision).toBe(afterSignalDeletion.revision)
      await independentCommand(left, 'registerJournalConsumer', {
        id: 'independent-signal-consumer',
        journal: 'signal',
        cursor: baseline.cursor,
      })
      await expect(
        independentCommand<{ consumers: { id: string; throughRevision: number }[] }>(
          right,
          'journalConsumers',
          {
            journal: 'signal',
          },
        ),
      ).resolves.toMatchObject({
        consumers: [{ id: 'independent-signal-consumer', throughRevision: baseline.revision }],
      })

      await independentCommand(left, 'armReadGate', { kind: 'journal_consumer' })
      const acknowledgementRace = independentCommand<
        IndependentCompactionSuccess | IndependentFailure
      >(left, 'attemptCompactSignalChanges', {
        expectedRevision: afterSignalDeletion.revision,
        cursor: signalCompactionBaseline.cursor,
        registered: true,
      })
      try {
        await expect
          .poll(
            async () =>
              (await independentCommand<{ reached: boolean }>(left, 'readGateStatus')).reached,
            { timeout: 5_000, interval: 10 },
          )
          .toBe(true)
        await expect(
          independentCommand<{ throughRevision: number }>(right, 'acknowledgeJournalConsumer', {
            id: 'independent-signal-consumer',
            journal: 'signal',
            cursor: signalCompactionBaseline.cursor,
          }),
        ).resolves.toMatchObject({ throughRevision: afterSignalDeletion.revision })
      } finally {
        await independentCommand(left, 'releaseReadGate')
      }
      await expect(acknowledgementRace).resolves.toMatchObject({
        ok: false,
        error: { code: 'conflict', retryable: true },
      })
      await expect(
        independentCommand<{
          revision: number
          signalChanges: number
          signalChangesCompactedThrough: number
        }>(right, 'journalStats'),
      ).resolves.toMatchObject({
        revision: afterSignalDeletion.revision,
        signalChanges: 4,
        signalChangesCompactedThrough: 0,
      })

      await right.close()
      right = await context.newPage()
      await right.goto(independentUrl)
      await right.waitForFunction(() => window.__temporalIndependentContext !== undefined)
      await independentCommand(right, 'open', {
        endpoint,
        worker: rightWorker,
        create: false,
      })
      await expect(
        independentCommand<{ consumers: { id: string; throughRevision: number }[] }>(
          right,
          'journalConsumers',
          { journal: 'signal' },
        ),
      ).resolves.toMatchObject({
        consumers: [
          {
            id: 'independent-signal-consumer',
            throughRevision: afterSignalDeletion.revision,
          },
        ],
      })
      const signalCompactionAttempts = await raceCompaction(
        'attemptCompactSignalChanges',
        'signal_change',
        afterSignalDeletion.revision,
        signalCompactionBaseline.cursor,
        true,
      )
      const signalCompactionWinners = signalCompactionAttempts.filter(
        (attempt): attempt is IndependentCompactionSuccess => attempt.ok,
      )
      const signalCompactionLosers = signalCompactionAttempts.filter(
        (attempt): attempt is IndependentFailure => !attempt.ok,
      )
      expect(signalCompactionWinners).toEqual([
        expect.objectContaining({
          ok: true,
          dryRun: false,
          requestedThroughRevision: afterSignalDeletion.revision,
          previousCompactedThrough: 0,
          compactedThrough: afterSignalDeletion.revision,
          batchChanges: 4,
          deletedChanges: 4,
          hasMore: false,
          revision: afterSignalDeletion.revision + 1,
        }),
      ])
      expect(signalCompactionLosers).toEqual([
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'conflict', retryable: true }),
        }),
      ])
      const signalCompaction = signalCompactionWinners[0]!
      const expiredCursor = await independentCommand<IndependentFailure>(left, 'signalChanges', {
        cursor: baseline.cursor,
      })
      expect(expiredCursor).toMatchObject({
        ok: false,
        error: {
          code: 'conflict',
          retryable: false,
          details: {
            requiresSignalBaseline: true,
            signalChangesCompactedThrough: afterSignalDeletion.revision,
          },
        },
      })

      const afterSignalCompaction = await Promise.all([
        independentCommand<{
          revision: number
          changes: number
          changesCompactedThrough: number
          signalChanges: number
          signalChangesCompactedThrough: number
        }>(left, 'journalStats'),
        independentCommand<{
          revision: number
          changes: number
          changesCompactedThrough: number
          signalChanges: number
          signalChangesCompactedThrough: number
        }>(right, 'journalStats'),
      ])
      expect(afterSignalCompaction[0]).toEqual(afterSignalCompaction[1])
      expect(afterSignalCompaction[0]).toMatchObject({
        revision: signalCompaction.revision,
        changesCompactedThrough: 0,
        signalChanges: 0,
        signalChangesCompactedThrough: afterSignalDeletion.revision,
      })
      expect(afterSignalCompaction[0]!.changes).toBeGreaterThan(0)

      const semanticCompactionBaseline = await independentCommand<{
        cursor: string
        revision: number
      }>(left, 'changeBaseline')
      expect(semanticCompactionBaseline.revision).toBe(signalCompaction.revision)
      await independentCommand(left, 'registerJournalConsumer', {
        id: 'independent-semantic-consumer',
        journal: 'semantic',
        cursor: semanticCompactionBaseline.cursor,
      })
      await expect(
        independentCommand<{ consumers: { id: string }[] }>(right, 'journalConsumers', {
          journal: 'semantic',
        }),
      ).resolves.toMatchObject({ consumers: [{ id: 'independent-semantic-consumer' }] })
      const semanticCompactionAttempts = await raceCompaction(
        'attemptCompactChanges',
        'change',
        signalCompaction.revision,
        semanticCompactionBaseline.cursor,
        true,
      )
      const semanticCompactionWinners = semanticCompactionAttempts.filter(
        (attempt): attempt is IndependentCompactionSuccess => attempt.ok,
      )
      const semanticCompactionLosers = semanticCompactionAttempts.filter(
        (attempt): attempt is IndependentFailure => !attempt.ok,
      )
      expect(semanticCompactionWinners).toHaveLength(1)
      expect(semanticCompactionWinners[0]).toMatchObject({
        ok: true,
        dryRun: false,
        requestedThroughRevision: signalCompaction.revision,
        previousCompactedThrough: 0,
        compactedThrough: signalCompaction.revision,
        hasMore: false,
        revision: signalCompaction.revision + 1,
      })
      expect(semanticCompactionWinners[0]!.batchChanges).toBeGreaterThan(0)
      expect(semanticCompactionWinners[0]!.deletedChanges).toBe(
        semanticCompactionWinners[0]!.batchChanges,
      )
      expect(semanticCompactionLosers).toEqual([
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: 'conflict', retryable: true }),
        }),
      ])
      const afterSemanticCompaction = await Promise.all([
        independentCommand<{
          revision: number
          changes: number
          changesCompactedThrough: number
          signalChanges: number
          signalChangesCompactedThrough: number
        }>(left, 'journalStats'),
        independentCommand<{
          revision: number
          changes: number
          changesCompactedThrough: number
          signalChanges: number
          signalChangesCompactedThrough: number
        }>(right, 'journalStats'),
      ])
      expect(afterSemanticCompaction[0]).toEqual(afterSemanticCompaction[1])
      expect(afterSemanticCompaction[0]).toEqual({
        revision: semanticCompactionWinners[0]!.revision,
        changes: 0,
        changesCompactedThrough: signalCompaction.revision,
        signalChanges: 0,
        signalChangesCompactedThrough: afterSignalDeletion.revision,
      })
      const expiredSemanticCursor = await independentCommand<IndependentFailure>(
        right,
        'changesFromCursor',
        { cursor: semanticBaseline.cursor },
      )
      expect(expiredSemanticCursor).toMatchObject({
        ok: false,
        error: {
          code: 'conflict',
          retryable: false,
          details: {
            requiresSnapshot: true,
            changesCompactedThrough: signalCompaction.revision,
          },
        },
      })

      const stalePurge = await raceRead<IndependentFailure>(
        'attemptHardPurge',
        'episode',
        async () => {
          const lateDependencyBaseline = await independentCommand<{ revision: number }>(
            right,
            'stats',
          )
          const lateDependency = await independentCommand<IndependentSuccess | IndependentFailure>(
            right,
            'putSignal',
            {
              suffix: 'late-purge-dependency',
              expectedRevision: lateDependencyBaseline.revision,
            },
          )
          expect(lateDependency).toMatchObject({
            ok: true,
            revision: lateDependencyBaseline.revision + 1,
          })
        },
      )
      expect(stalePurge).toMatchObject({
        ok: false,
        error: { code: 'conflict', retryable: true },
      })
      const rejectedPurgeState = await independentCommand<{
        targetExists: boolean
        operationExists: boolean
        markerStates: string[]
      }>(right, 'purgeDiagnostics')
      expect(rejectedPurgeState).toEqual({
        targetExists: true,
        operationExists: false,
        markerStates: [],
      })
      const lateDependencyBeforeRetry = await independentCommand<{ total: number }>(
        right,
        'signalHistory',
        { slot: 'late-purge-dependency' },
      )
      expect(lateDependencyBeforeRetry.total).toBe(1)
      const retriedPurge = await independentCommand<{
        ok: true
        purged: boolean
        affectedEpisodes: string[]
      }>(left, 'attemptHardPurge')
      expect(retriedPurge).toMatchObject({
        ok: true,
        purged: true,
        affectedEpisodes: expect.arrayContaining(['shared-episode']),
      })
      const completedPurgeState = await independentCommand<{
        targetExists: boolean
        operationExists: boolean
        markerStates: string[]
      }>(right, 'purgeDiagnostics')
      expect(completedPurgeState).toEqual({
        targetExists: false,
        operationExists: true,
        markerStates: ['succeeded'],
      })
      const lateDependencyAfterRetry = await independentCommand<{ total: number }>(
        right,
        'signalHistory',
        { slot: 'late-purge-dependency' },
      )
      expect(lateDependencyAfterRetry.total).toBe(0)
      const postPurgeIntegrity = await independentCommand<{
        ok: true
        integrity: boolean
      }>(right, 'attemptIntegrity')
      expect(postPurgeIntegrity).toMatchObject({ ok: true, integrity: true })

      const recreated = await independentCommand<{
        revision: number
        episodes: number
        signals: number
      }>(right, 'resetAndRecreate')
      expect(recreated).toMatchObject({ revision: 0, episodes: 0, signals: 0 })
      const staleFacade = await independentCommand<IndependentFailure>(left, 'attemptStats')
      expect(staleFacade).toMatchObject({
        ok: false,
        error: { code: 'conflict', retryable: false, details: { requiresReopen: true } },
      })
      const reopened = await independentCommand<{
        revision: number
        episodes: number
        signals: number
      }>(left, 'reopen')
      expect(reopened).toMatchObject({ revision: 0, episodes: 0, signals: 0 })
      const oldCursor = await independentCommand<IndependentFailure>(left, 'signalChanges', {
        cursor: baseline.cursor,
      })
      expect(oldCursor).toMatchObject({ ok: false, error: { code: 'conflict' } })

      await Promise.all([independentCommand(left, 'close'), independentCommand(right, 'close')])
      await context.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
}, 60_000)
