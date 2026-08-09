import {
  createMemory,
  MemoryError,
  openSyncBundle,
  type JsonValue,
  type SyncBundleCheckpointFrame,
  type SyncBundleChunkFrame,
  type SyncBundleFrame,
} from '../../src/index.ts'
import { sha256, stableStringify } from '../../src/internal/value.ts'
import { storageDriver } from '../../src/storage/driver.ts'
import {
  createSurrealMemoryCapabilities,
  createSurrealMemoryStorage,
} from '../../src/surreal/index.ts'

declare global {
  interface Window {
    __temporalMemoryStage?: string
    __temporalMemoryResult?:
      | {
          ok: true
          stats: { episodes: number; entities: number; facts: number }
          factStatus: string
          recallFacts: readonly string[]
          recallLineage: boolean
          episodeStoragePaging: boolean
          unicodeOrderPaging: boolean
          injectionPreserved: boolean
          injectionRecall: boolean
          concurrentReads: boolean
          rawQuerySeparated: boolean
          rawQueryTargetGuard: boolean
          rawQueryParameterized: boolean
          rawQueryBounded: boolean
          rawQueryStatementFailure: boolean
          rawQueryRequestSnapshotted: boolean
          rawQueryUnknownSharedFence: boolean
          transactionUnknownSharedFence: boolean
          connectionCleanupReusable: boolean
          transactionRollbackReusable: boolean
          rawQueryClosed: boolean
          ingestionIndexedPlanning: boolean
          ingestionContextScanBounded: boolean
          ingestionProjectionScanBounded: boolean
          pointReadScanBounded: boolean
          managementScanBounded: boolean
          resetScanBounded: boolean
          derivationPersisted: boolean
          derivationBatchAtomic: boolean
          derivationWithdrawalBatchAtomic: boolean
          derivationIndexedPlanning: boolean
          correctionIndexedPlanning: boolean
          retractionIndexedPlanning: boolean
          episodeDeletionIndexedPlanning: boolean
          episodeDeletionPreviewBound: boolean
          hardPurgeIndexedPlanning: boolean
          entityMergeIndexedPlanning: boolean
          purgeReplayBlocked: boolean
          purgeProjectionClosure: boolean
          purgeRequestBound: boolean
          operationPurgeScrubbed: boolean
          activeMergeIndex: boolean
          schemaMigrationPersisted: boolean
          projectionSetCutover: boolean
          projectionSensitivityPersisted: boolean
          projectionScanBounded: boolean
          changeFeedPersisted: boolean
          changePurgeInvalidated: boolean
          changePurgeScrubbed: boolean
          changeCompactionPersisted: boolean
          changeCompactionInvalidated: boolean
          journalConsumersPersisted: boolean
          constructionOptionsSnapshotted: boolean
          facadeOptionsSnapshotted: boolean
          publicOutputsDetached: boolean
          signalRequestSnapshotted: boolean
          coreReadRequestsSnapshotted: boolean
          mutationRequestsSnapshotted: boolean
          signalBasisScanBounded: boolean
          signalPersisted: boolean
          signalSoftDeleteAtomic: boolean
          signalPurgeClosed: boolean
          signalKeyPurgeAtomic: boolean
          signalDiagnostics: boolean
          retrievalScanBounded: boolean
          analysisScanBounded: boolean
          snapshotScanBounded: boolean
          integrityIndexedPlanning: boolean
          signalChangeFeedPersisted: boolean
          signalChangePurgeScrubbed: boolean
          signalChangeCompactionPersisted: boolean
          signalChangeCompactionInvalidated: boolean
          boundedCanonicalArchive: boolean
          syncRequestsSnapshotted: boolean
          syncRoundTripPersisted: boolean
          syncCompactionPersisted: boolean
          syncInventoryPersisted: boolean
          syncBundleExported: boolean
        }
      | { ok: false; error: string; stack?: string }
  }
}

async function loseDatabaseCallCompletion<T>(
  callNumbers: number | readonly number[],
  run: () => Promise<T>,
): Promise<T> {
  const originalLocks = navigator.locks
  if (originalLocks === undefined) throw new Error('outcome probe requires Web Locks')
  const locksDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'locks')
  const lostCalls = new Set(typeof callNumbers === 'number' ? [callNumbers] : callNumbers)
  let physicalCalls = 0
  const faultingLocks = {
    query: () => originalLocks.query(),
    request: async (
      name: string,
      options: LockOptions,
      callback: (lock: Lock | null) => Promise<unknown>,
    ) => {
      const value = await originalLocks.request(name, options, callback)
      if (!name.includes(':runtime:') && lostCalls.has(++physicalCalls)) {
        throw new Error('injected response loss after physical database execution')
      }
      return value
    },
  } as unknown as LockManager
  Object.defineProperty(Navigator.prototype, 'locks', {
    configurable: true,
    get: () => faultingLocks,
  })
  try {
    return await run()
  } finally {
    if (locksDescriptor === undefined) Reflect.deleteProperty(Navigator.prototype, 'locks')
    else Object.defineProperty(Navigator.prototype, 'locks', locksDescriptor)
  }
}

async function run(): Promise<void> {
  window.__temporalMemoryStage = 'starting'
  const worker = new URL(location.href).searchParams.get('worker') !== 'false'
  const endpoint = `indxdb://temporalmemory${crypto.randomUUID().replaceAll('-', '')}` as const
  const constructionStorage = createSurrealMemoryStorage({ endpoint, worker })
  const constructionReads = new Map<string, number>()
  const constructionCapture =
    <T>(name: string, value: T, later: T = value): (() => T) =>
    () => {
      const count = (constructionReads.get(name) ?? 0) + 1
      constructionReads.set(name, count)
      return count === 1 ? value : later
    }
  const constructionOntology = {
    id: 'browser.construction',
    version: '1',
    mode: 'open' as const,
    entityTypes: {},
    factTypes: {},
  }
  const constructionOptions = Object.defineProperties(
    {},
    {
      spaceId: {
        enumerable: true,
        get: constructionCapture('spaceId', 'browser-construction-owned', ''),
      },
      storage: {
        enumerable: true,
        get: constructionCapture('storage', constructionStorage),
      },
      ontology: {
        enumerable: true,
        get: constructionCapture('ontology', constructionOntology),
      },
      operationTimeoutMs: {
        enumerable: true,
        get: constructionCapture('operationTimeoutMs', 5_000, 0),
      },
    },
  ) as Parameters<typeof createMemory>[0]
  const constructionMemory = createMemory(constructionOptions)
  constructionOntology.id = 'mutated-after-construction'
  const constructionSpace = await constructionMemory.open({ create: true })
  const constructionUnknownRejected = (() => {
    try {
      createMemory({
        spaceId: 'browser-construction-unknown',
        storage: constructionStorage,
        unsupported: true,
      } as never)
      return false
    } catch (error) {
      return MemoryError.is(error, 'invalid_input')
    }
  })()
  const constructionOptionsSnapshotted =
    constructionSpace.id === 'browser-construction-owned' &&
    constructionSpace.ontology.id === 'browser.construction' &&
    constructionUnknownRejected &&
    [...constructionReads.values()].every((count) => count === 1) &&
    constructionReads.size === 4
  await constructionMemory.close()
  const firstStorage = createSurrealMemoryStorage({ endpoint, worker })
  const first = createMemory({ spaceId: 'browser-space', storage: firstStorage })
  await first.open({ create: true })
  const rawQuerySeparated = !('rawQuery' in firstStorage)
  window.__temporalMemoryStage = 'first-open'
  const report = await first.remember({
    id: 'episode-1',
    kind: 'assertion',
    content: { type: 'text', text: 'Ada created the analytical engine.' },
    source: { kind: 'browser-test' },
    tags: ['browser', 'primary'],
    assertions: {
      entities: [{ id: 'ada', name: 'Ada Lovelace', aliases: ['Ada'] }],
      facts: [
        {
          subject: { id: 'ada' },
          predicate: 'created',
          object: { scalar: 'analytical engine' },
        },
      ],
    },
  })
  const factId = report.facts.created[0]
  if (factId === undefined) {
    throw new Error(
      `canonical fact integration failed: ${JSON.stringify(report.operation.error ?? report.warnings)}`,
    )
  }
  if (
    report.operation.diagnosticsState !== 'available' ||
    report.operation.diagnosticsTruncated !== false
  ) {
    throw new Error('new operation diagnostics state is invalid')
  }
  const ingestionLimit = await first.reprocessEpisode('episode-1', {
    operationId: 'browser-ingestion-limit',
    workLimits: { maxRecords: 1 },
  })
  const ingestionIndexedPlanning =
    report.work.records > 0 &&
    report.work.bytes > 0 &&
    ingestionLimit.operation.state === 'failed' &&
    ingestionLimit.operation.stage === 'canonical_failed' &&
    ingestionLimit.operation.error?.code === 'result_too_large' &&
    ingestionLimit.work.records === 1 &&
    ingestionLimit.work.limits.maxRecords === 1
  const ingestionProjectionLimit = await first.reprocessEpisode('episode-1', {
    operationId: 'browser-ingestion-projection-limit',
    projectionScanLimits: { maxRecords: 1, maxBytes: 1024 * 1024 },
  })
  const ingestionProjectionScanBounded =
    report.projectionScan.records > 1 &&
    report.projectionScan.bytes > 0 &&
    ingestionProjectionLimit.operation.state === 'partial' &&
    ingestionProjectionLimit.operation.stage === 'projection_scan_failed' &&
    ingestionProjectionLimit.operation.error?.code === 'result_too_large' &&
    ingestionProjectionLimit.projectionScan.records === 1 &&
    ingestionProjectionLimit.projectionScan.limits.maxRecords === 1
  const injected = "Robert'); DELETE tm_episode; --"
  await first.remember(
    {
      id: 'episode-injection',
      kind: 'assertion',
      content: { type: 'text', text: injected },
      source: { kind: 'browser-test' },
      tags: ['browser', 'hostile'],
      sensitivity: 'browser-restricted',
      assertions: {
        entities: [{ id: 'injected-entity', name: injected }],
      },
    },
    { operationId: 'browser-injection-operation' },
  )
  window.__temporalMemoryStage = 'remembered'
  await first.close()
  window.__temporalMemoryStage = 'first-closed'

  const { storage: secondStorage, admin: secondAdmin } = createSurrealMemoryCapabilities(
    { endpoint, worker },
    { dangerouslyAllowRawQueries: true },
  )
  const second = createMemory({ spaceId: 'browser-space', storage: secondStorage })
  await second.open()
  const peer = createMemory({ spaceId: 'browser-space', storage: secondStorage })
  await peer.open()
  window.__temporalMemoryStage = 'second-open'
  const rawQueryTargetGuard = await secondAdmin
    .rawQuery({
      query: 'CREATE power_user_confirmation_probe;',
      confirmNamespace: 'wrong',
      confirmDatabase: 'temporal_memory',
    })
    .then(
      () => false,
      (error: unknown) => MemoryError.is(error, 'invalid_input'),
    )
  const rawMarker = "Robert'); DELETE power_user_probe; --"
  const secondRawMarker = 'second-frame'
  const rawQuery = await secondAdmin.rawQuery<
    [
      readonly JsonValue[],
      readonly JsonValue[],
      readonly { marker: string; space_id: string }[],
      readonly JsonValue[],
    ]
  >({
    query: `CREATE power_user_probe CONTENT { space_id: $space, marker: $marker };
CREATE power_user_probe CONTENT { space_id: $space, marker: $secondMarker };
SELECT space_id, marker FROM power_user_probe WHERE space_id = $space ORDER BY marker LIMIT 2;
SELECT marker FROM power_user_probe WHERE marker = $missing LIMIT 1;`,
    bindings: {
      space: 'browser-space',
      marker: rawMarker,
      secondMarker: secondRawMarker,
      missing: 'absent-frame',
    },
    confirmNamespace: 'astrale',
    confirmDatabase: 'temporal_memory',
  })
  const rawSelect = rawQuery.statements[2]
  const rawEmptySelect = rawQuery.statements[3]
  const rawQueryParameterized =
    rawQuery.allSucceeded &&
    /^[a-f0-9]{64}$/u.test(rawQuery.queryHash) &&
    new TextEncoder().encode(stableStringify(rawQuery as unknown as JsonValue)).byteLength ===
      rawQuery.byteLength &&
    rawSelect?.success === true &&
    rawSelect.result.length === 2 &&
    rawSelect.result.every((row) => row.space_id === 'browser-space') &&
    new Set(rawSelect.result.map((row) => row.marker)).size === 2 &&
    rawSelect.result.some((row) => row.marker === rawMarker) &&
    rawSelect.result.some((row) => row.marker === secondRawMarker) &&
    rawEmptySelect?.success === true &&
    rawEmptySelect.result.length === 0
  const postResponseReconciliation = (error: unknown): error is MemoryError =>
    MemoryError.is(error, 'result_too_large') &&
    error.retryable === false &&
    error.details?.queryOutcome === 'responses_received' &&
    error.details?.requiresReconciliation === true
  const rawByteBounded = await secondAdmin
    .rawQuery({
      query: 'RETURN $value;',
      bindings: { value: 'x'.repeat(1_024) },
      confirmNamespace: 'astrale',
      confirmDatabase: 'temporal_memory',
      maxResultBytes: 64,
    })
    .then(
      () => false,
      (error: unknown) =>
        postResponseReconciliation(error) && typeof error.details?.requiredBytes === 'number',
    )
  const rawNodeBounded = await secondAdmin
    .rawQuery({
      query: 'RETURN { nested: [$value] };',
      bindings: { value: true },
      confirmNamespace: 'astrale',
      confirmDatabase: 'temporal_memory',
      maxResultNodes: 1,
    })
    .then(
      () => false,
      (error: unknown) =>
        postResponseReconciliation(error) && typeof error.details?.requiredNodes === 'number',
    )
  const boundedMutationMarker = `bounded-${crypto.randomUUID()}`
  const rawMutationBounded = await secondAdmin
    .rawQuery({
      query: `CREATE power_user_bounded_probe CONTENT { marker: $marker };
RETURN $value;`,
      bindings: { marker: boundedMutationMarker, value: 'x'.repeat(1_024) },
      confirmNamespace: 'astrale',
      confirmDatabase: 'temporal_memory',
      maxResultBytes: 64,
    })
    .then(
      () => false,
      (error: unknown) => postResponseReconciliation(error),
    )
  const boundedMutationState = await secondAdmin.rawQuery<[readonly { marker: string }[]]>({
    query: 'SELECT marker FROM power_user_bounded_probe WHERE marker = $marker LIMIT 1;',
    bindings: { marker: boundedMutationMarker },
    confirmNamespace: 'astrale',
    confirmDatabase: 'temporal_memory',
  })
  const rawQueryBounded =
    rawByteBounded &&
    rawNodeBounded &&
    rawMutationBounded &&
    boundedMutationState.allSucceeded &&
    boundedMutationState.statements[0]?.success === true &&
    boundedMutationState.statements[0].result[0]?.marker === boundedMutationMarker
  const rawFailure = await secondAdmin.rawQuery({
    query: "RETURN 1; THROW 'raw-query-probe'; RETURN 3;",
    confirmNamespace: 'astrale',
    confirmDatabase: 'temporal_memory',
  })
  const rawQueryStatementFailure =
    !rawFailure.allSucceeded && rawFailure.statements.some((statement) => !statement.success)
  const mutableRawRequest = {
    query: 'RETURN $value;',
    bindings: { value: 'before' },
    confirmNamespace: 'astrale',
    confirmDatabase: 'temporal_memory',
  }
  const mutableRawPromise = secondAdmin.rawQuery<[string]>(mutableRawRequest)
  mutableRawRequest.query = "THROW 'mutated';"
  mutableRawRequest.bindings.value = 'after'
  const snapshottedRaw = await mutableRawPromise
  let accessorQueryReads = 0
  let accessorBindingReads = 0
  const accessorBindings = Object.defineProperty({}, 'value', {
    enumerable: true,
    get: () => (accessorBindingReads++ === 0 ? 'accessor-before' : 'accessor-after'),
  }) as { readonly value: string }
  const accessorRaw = await secondAdmin.rawQuery<[string]>({
    get query() {
      accessorQueryReads += 1
      return accessorQueryReads === 1 ? 'RETURN $value;' : "THROW 'accessor-reread';"
    },
    bindings: accessorBindings,
    confirmNamespace: 'astrale',
    confirmDatabase: 'temporal_memory',
  })
  const rawQueryRequestSnapshotted =
    snapshottedRaw.statements[0]?.success === true &&
    snapshottedRaw.statements[0].result === 'before' &&
    accessorRaw.statements[0]?.success === true &&
    accessorRaw.statements[0].result === 'accessor-before' &&
    accessorQueryReads === 1 &&
    accessorBindingReads === 1
  const unknownRawOutcome = (error: unknown): boolean =>
    MemoryError.is(error, 'storage_failed') &&
    error.retryable === false &&
    error.details?.queryOutcome === 'unknown' &&
    error.details?.requiresReopen === true
  const poisonEndpoint = `indxdb://rawpoison${crypto.randomUUID().replaceAll('-', '')}` as const
  const { storage: poisonStorage, admin: poisonAdmin } = createSurrealMemoryCapabilities(
    { endpoint: poisonEndpoint, worker },
    { dangerouslyAllowRawQueries: true },
  )
  const poisonMemory = createMemory({ spaceId: 'raw-poison-space', storage: poisonStorage })
  const poisonPeer = createMemory({ spaceId: 'raw-poison-space', storage: poisonStorage })
  await poisonMemory.open({ create: true })
  await poisonPeer.open()
  const rawUnknownError = await loseDatabaseCallCompletion(1, () =>
    poisonAdmin.rawQuery({
      query: 'RETURN true;',
      confirmNamespace: 'astrale',
      confirmDatabase: 'temporal_memory',
    }),
  ).then(
    () => undefined,
    (error: unknown) => error,
  )
  const rawOutcomeUnknown = unknownRawOutcome(rawUnknownError)
  const rawPoisonImmutable =
    MemoryError.is(rawUnknownError) &&
    Object.isFrozen(rawUnknownError) &&
    Object.isFrozen(rawUnknownError.details) &&
    Reflect.set(rawUnknownError, 'retryable', true) === false &&
    Reflect.set(rawUnknownError.details!, 'queryOutcome', 'changed') === false
  const pairedFacadeFenced = await poisonMemory.stats().then(
    () => false,
    (error: unknown) => unknownRawOutcome(error),
  )
  const pairedOpenFenced = await poisonMemory.open().then(
    () => false,
    (error: unknown) => unknownRawOutcome(error),
  )
  const pairedAdminFenced = await poisonAdmin
    .rawQuery({
      query: 'RETURN true;',
      confirmNamespace: 'astrale',
      confirmDatabase: 'temporal_memory',
    })
    .then(
      () => false,
      (error: unknown) => unknownRawOutcome(error),
    )
  await poisonMemory.close()
  const peerStillFenced = await poisonPeer.stats().then(
    () => false,
    (error: unknown) => unknownRawOutcome(error),
  )
  const earlyReopenFenced = await poisonMemory.open().then(
    () => false,
    (error: unknown) => unknownRawOutcome(error),
  )
  const partialCloseFenced = peerStillFenced && earlyReopenFenced
  await poisonPeer.close()
  await poisonMemory.open()
  const recoveredRaw = await poisonAdmin.rawQuery<[boolean]>({
    query: 'RETURN true;',
    confirmNamespace: 'astrale',
    confirmDatabase: 'temporal_memory',
  })
  const rawQueryUnknownSharedFence =
    rawOutcomeUnknown &&
    rawPoisonImmutable &&
    pairedFacadeFenced &&
    pairedOpenFenced &&
    pairedAdminFenced &&
    partialCloseFenced &&
    recoveredRaw.allSucceeded &&
    recoveredRaw.statements[0]?.success === true &&
    recoveredRaw.statements[0].result === true
  await poisonMemory.close()

  const unknownTransactionOutcome = (error: unknown): boolean =>
    MemoryError.is(error, 'storage_failed') &&
    error.retryable === false &&
    error.details?.transactionOutcome === 'unknown' &&
    error.details?.requiresReopen === true
  const transactionStorage = createSurrealMemoryStorage({
    endpoint: `indxdb://transactionpoison${crypto.randomUUID().replaceAll('-', '')}`,
    worker,
  })
  const transactionMemory = createMemory({
    spaceId: 'transaction-poison-space',
    storage: transactionStorage,
  })
  const transactionPeer = createMemory({
    spaceId: 'transaction-poison-space',
    storage: transactionStorage,
  })
  await transactionMemory.open({ create: true })
  await transactionPeer.open()
  const transactionPoisonDriver = storageDriver(transactionStorage)
  const transactionOutcomeUnknown = await loseDatabaseCallCompletion(2, () =>
    transactionPoisonDriver.deleteSpace('transaction-poison-space', 0),
  ).then(
    () => false,
    (error: unknown) => unknownTransactionOutcome(error),
  )
  const transactionFacadeFenced = await transactionMemory.stats().then(
    () => false,
    (error: unknown) => unknownTransactionOutcome(error),
  )
  const transactionCachedOpenFenced = await transactionMemory.open().then(
    () => false,
    (error: unknown) => unknownTransactionOutcome(error),
  )
  await transactionMemory.close()
  const transactionPartialCloseFenced = await transactionPeer.stats().then(
    () => false,
    (error: unknown) => unknownTransactionOutcome(error),
  )
  const transactionEarlyReopenFenced = await transactionMemory.open().then(
    () => false,
    (error: unknown) => unknownTransactionOutcome(error),
  )
  await transactionPeer.close()
  const deletedSpaceObserved = await transactionMemory.open().then(
    () => false,
    (error: unknown) => MemoryError.is(error, 'space_not_found'),
  )
  const recreatedTransactionSpace = await transactionMemory.open({ create: true }).then(
    async () => (await transactionMemory.stats()).snapshotRevision === 0,
    () => false,
  )
  const transactionUnknownSharedFence =
    transactionOutcomeUnknown &&
    transactionFacadeFenced &&
    transactionCachedOpenFenced &&
    transactionPartialCloseFenced &&
    transactionEarlyReopenFenced &&
    deletedSpaceObserved &&
    recreatedTransactionSpace
  await transactionMemory.close()

  const transientOpenFailure = (error: unknown): boolean =>
    MemoryError.is(error, 'storage_failed') && error.details?.connectionCleanup === undefined
  const pendingConnectionCleanup = (error: unknown): boolean =>
    MemoryError.is(error, 'storage_failed') &&
    error.retryable === true &&
    error.details?.connectionCleanup === 'pending'

  const connectCleanupStorage = createSurrealMemoryStorage({
    endpoint: `indxdb://connectcleanup${crypto.randomUUID().replaceAll('-', '')}`,
    worker,
  })
  const connectCleanupMemory = createMemory({
    spaceId: 'connect-cleanup-space',
    storage: connectCleanupStorage,
  })
  const connectFailureObserved = await loseDatabaseCallCompletion(1, () =>
    connectCleanupMemory.open({ create: true }),
  ).then(
    () => false,
    (error: unknown) => transientOpenFailure(error),
  )
  const connectRetrySucceeded = await connectCleanupMemory.open({ create: true }).then(
    async () => (await connectCleanupMemory.stats()).snapshotRevision === 0,
    () => false,
  )
  await connectCleanupMemory.close()

  const bootstrapCleanupStorage = createSurrealMemoryStorage({
    endpoint: `indxdb://bootstrapcleanup${crypto.randomUUID().replaceAll('-', '')}`,
    worker,
  })
  const bootstrapCleanupMemory = createMemory({
    spaceId: 'bootstrap-cleanup-space',
    storage: bootstrapCleanupStorage,
  })
  const bootstrapCleanupPending = await loseDatabaseCallCompletion([3, 4], () =>
    bootstrapCleanupMemory.open({ create: true }),
  ).then(
    () => false,
    (error: unknown) => pendingConnectionCleanup(error),
  )
  const bootstrapRetrySucceeded = await bootstrapCleanupMemory.open({ create: true }).then(
    async () => (await bootstrapCleanupMemory.stats()).snapshotRevision === 0,
    () => false,
  )
  await bootstrapCleanupMemory.close()

  const closeCleanupStorage = createSurrealMemoryStorage({
    endpoint: `indxdb://closecleanup${crypto.randomUUID().replaceAll('-', '')}`,
    worker,
  })
  const closeCleanupMemory = createMemory({
    spaceId: 'close-cleanup-space',
    storage: closeCleanupStorage,
  })
  await closeCleanupMemory.open({ create: true })
  const closeCleanupPending = await loseDatabaseCallCompletion(1, () =>
    closeCleanupMemory.close(),
  ).then(
    () => false,
    (error: unknown) => pendingConnectionCleanup(error),
  )
  await closeCleanupMemory.close()
  const closeRetrySucceeded = await closeCleanupMemory.open().then(
    async () => (await closeCleanupMemory.stats()).snapshotRevision === 0,
    () => false,
  )
  const connectionCleanupReusable =
    connectFailureObserved &&
    connectRetrySucceeded &&
    bootstrapCleanupPending &&
    bootstrapRetrySucceeded &&
    closeCleanupPending &&
    closeRetrySucceeded
  await closeCleanupMemory.close()
  let contextProviderCalls = 0
  const contextStorage = createSurrealMemoryStorage({
    endpoint: `indxdb://context${crypto.randomUUID().replaceAll('-', '')}`,
    worker,
  })
  const contextMemory = createMemory({
    spaceId: 'browser-context-space',
    storage: contextStorage,
    inference: {
      lineage: {
        provider: 'browser-fixture',
        model: 'bounded-context-v1',
        destination: 'local',
      },
      infer: async () => {
        contextProviderCalls += 1
        return { entities: [], facts: [] }
      },
    },
    ingestion: { contextLimit: 1 },
  })
  await contextMemory.open({ create: true })
  await contextMemory.remember({
    id: 'browser-context-source',
    kind: 'assertion',
    content: { type: 'text', text: 'Bounded context source.' },
    source: { kind: 'browser-test' },
    assertions: { entities: [{ id: 'browser-context-entity', name: 'Context entity' }] },
  })
  const contextLimit = await contextMemory.remember(
    {
      id: 'browser-context-target',
      kind: 'text',
      content: { type: 'text', text: 'Bound this context.' },
      source: { kind: 'browser-test' },
    },
    {
      operationId: 'browser-context-limit',
      contextScanLimits: { maxRecords: 1, maxBytes: 1024 * 1024 },
    },
  )
  const contextRetry = await contextMemory.retryEpisode('browser-context-target', {
    operationId: 'browser-context-retry',
    contextScanLimits: { maxRecords: 100, maxBytes: 1024 * 1024 },
  })
  const ingestionContextScanBounded =
    contextLimit.operation.state === 'failed' &&
    contextLimit.operation.stage === 'inference_failed' &&
    contextLimit.operation.error?.code === 'result_too_large' &&
    contextLimit.contextScan.records === 1 &&
    contextProviderCalls === 1 &&
    contextRetry.operation.state === 'succeeded' &&
    contextRetry.contextScan.records > 1 &&
    contextRetry.contextScan.bytes > 0
  await contextMemory.close()
  const resetStorage = createSurrealMemoryStorage({
    endpoint: `indxdb://reset${crypto.randomUUID().replaceAll('-', '')}`,
    worker,
  })
  const resetMemory = createMemory({ spaceId: 'browser-reset-space', storage: resetStorage })
  await resetMemory.open({ create: true })
  await resetMemory.remember({
    id: 'browser-reset-episode',
    kind: 'assertion',
    content: { type: 'text', text: 'Bound destructive reset.' },
    source: { kind: 'browser-test' },
    assertions: { entities: [{ id: 'browser-reset-entity', name: 'Reset entity' }] },
  })
  const resetRevision = (await resetMemory.stats()).snapshotRevision
  const resetLimit = await resetMemory
    .resetSpace({
      confirmSpaceId: 'browser-reset-space',
      scanLimits: { maxRecords: 1, maxBytes: 1024 * 1024 },
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'reset_scan' &&
        error.details.dimension === 'records' &&
        typeof error.details.required === 'number' &&
        error.details.required > 1 &&
        error.details.maximum === 1,
    )
  const resetAtomic = (await resetMemory.stats()).snapshotRevision === resetRevision
  const resetSnapshotRequest = {
    confirmSpaceId: 'browser-reset-space',
    scanLimits: { maxRecords: 100, maxBytes: 1024 * 1024 },
  }
  const resetSnapshotPromise = resetMemory.resetSpace(resetSnapshotRequest)
  resetSnapshotRequest.confirmSpaceId = 'mutated-reset-space'
  resetSnapshotRequest.scanLimits.maxRecords = 0
  const resetReport = await resetSnapshotPromise
  const resetRequestSnapshotted = resetReport.purged && resetReport.scan.records > 1
  const resetScanBounded =
    resetLimit && resetAtomic && resetReport.scan.records > 1 && resetReport.scan.bytes > 0
  const signalSnapshotMemory = createMemory({
    spaceId: 'browser-signal-snapshot-space',
    storage: createSurrealMemoryStorage({
      endpoint: `indxdb://signalsnapshot${crypto.randomUUID().replaceAll('-', '')}`,
      worker,
    }),
  })
  await signalSnapshotMemory.open({ create: true })
  await signalSnapshotMemory.remember({
    id: 'browser-signal-snapshot-target',
    kind: 'assertion',
    content: { type: 'text', text: 'Browser signal snapshot target.' },
    source: { kind: 'browser-signal-snapshot' },
    assertions: {
      entities: [{ id: 'browser-signal-snapshot-entity', name: 'Browser Snapshot Entity' }],
    },
  })
  const signalSnapshotRevision = (await signalSnapshotMemory.stats()).snapshotRevision
  const snapshotSignal = {
    namespace: 'browser.snapshot.original',
    target: { kind: 'episode' as const, id: 'browser-signal-snapshot-target' },
    producer: { kind: 'algorithm' as const, id: 'browser-snapshot', version: '1' },
    scopes: [] as string[],
    tags: ['snapshot:original'],
    basis: { episodeIds: ['browser-signal-snapshot-target'] },
    value: { state: 'original' },
  }
  const snapshotPutRequest = {
    access: { allowedScopes: [] as string[] },
    expectedRevision: signalSnapshotRevision,
    signals: [snapshotSignal],
  }
  const snapshotPutPromise = signalSnapshotMemory.putSignals(snapshotPutRequest)
  snapshotSignal.namespace = 'browser.snapshot.mutated'
  snapshotSignal.target.id = 'missing-mutated-target'
  snapshotSignal.basis.episodeIds[0] = 'missing-mutated-target'
  snapshotSignal.value.state = 'mutated'
  const snapshotPut = await snapshotPutPromise
  const snapshotBrowseRequest = {
    access: { allowedScopes: [] as string[] },
    where: { namespaces: ['browser.snapshot.original'] },
  }
  const snapshotBrowsePromise = signalSnapshotMemory.browseSignals(snapshotBrowseRequest)
  snapshotBrowseRequest.where.namespaces[0] = 'browser.snapshot.mutated'
  const snapshotBrowse = await snapshotBrowsePromise
  const snapshotDeleteRequest: {
    access: { allowedScopes: string[] }
    mode: 'withdraw' | 'purge'
    where: { namespaces: string[] }
    expectedRevision: number
    maxMatches: number
    reason?: string
    maxRevisions?: number
  } = {
    access: { allowedScopes: [] as string[] },
    mode: 'withdraw',
    where: { namespaces: ['browser.snapshot.original'] },
    expectedRevision: snapshotPut.revision,
    maxMatches: 1,
    reason: 'original retirement',
  }
  const snapshotDeletePromise = signalSnapshotMemory.deleteSignals(snapshotDeleteRequest)
  snapshotDeleteRequest.mode = 'purge'
  snapshotDeleteRequest.where.namespaces[0] = 'browser.snapshot.mutated'
  snapshotDeleteRequest.reason = 'mutated retirement'
  snapshotDeleteRequest.maxRevisions = 1
  const snapshotDelete = await snapshotDeletePromise
  const signalSnapshotHistory = await signalSnapshotMemory.browseSignals({
    access: { allowedScopes: [] as string[] },
    revisionView: 'history',
  })
  const signalRequestSnapshotted =
    snapshotPut.signals[0]?.namespace === 'browser.snapshot.original' &&
    snapshotPut.signals[0]?.target.id === 'browser-signal-snapshot-target' &&
    snapshotPut.signals[0]?.state === 'active' &&
    (snapshotPut.signals[0].value as { state?: string }).state === 'original' &&
    snapshotBrowse.signals[0]?.id === snapshotPut.signals[0]?.id &&
    snapshotDelete.mode === 'withdraw' &&
    snapshotDelete.withdrawn[0]?.state === 'withdrawn' &&
    snapshotDelete.withdrawn[0].withdrawalReason === 'original retirement' &&
    signalSnapshotHistory.total === 2

  const pointSnapshotRequest = {
    kind: 'episode' as const,
    id: 'browser-signal-snapshot-target',
    access: { allowedScopes: [] as string[] },
  }
  const pointSnapshotPromise = signalSnapshotMemory.read(pointSnapshotRequest)
  pointSnapshotRequest.id = 'missing-mutated-target'
  pointSnapshotRequest.access.allowedScopes.push('private')
  const pointSnapshot = await pointSnapshotPromise
  const recallSnapshotRequest = {
    anchors: { entityIds: ['browser-signal-snapshot-entity'] },
    access: { allowedScopes: [] as string[] },
    filters: { episodes: { ids: ['browser-signal-snapshot-target'] } },
    channels: { exact: true, lexical: false, semantic: false, graph: false, temporal: false },
  }
  const recallSnapshotPromise = signalSnapshotMemory.recall(recallSnapshotRequest)
  recallSnapshotRequest.anchors.entityIds[0] = 'missing-mutated-entity'
  recallSnapshotRequest.filters.episodes.ids[0] = 'missing-mutated-target'
  recallSnapshotRequest.access.allowedScopes.push('private')
  const recallSnapshot = await recallSnapshotPromise
  const searchSnapshotRequest = {
    anchors: { entityIds: ['browser-signal-snapshot-entity'] },
    access: { allowedScopes: [] as string[] },
    channels: { exact: true, lexical: false, semantic: false, graph: false, temporal: false },
    target: 'all' as const,
  }
  const searchSnapshotPromise = signalSnapshotMemory.search(searchSnapshotRequest)
  searchSnapshotRequest.anchors.entityIds[0] = 'missing-mutated-entity'
  searchSnapshotRequest.access.allowedScopes.push('private')
  searchSnapshotRequest.target = 'episodes' as never
  const searchSnapshot = await searchSnapshotPromise
  const neighborhoodSnapshotRequest = {
    entityId: 'browser-signal-snapshot-entity',
    access: { allowedScopes: [] as string[] },
  }
  const neighborhoodSnapshotPromise = signalSnapshotMemory.neighborhood(neighborhoodSnapshotRequest)
  neighborhoodSnapshotRequest.entityId = 'missing-mutated-entity'
  neighborhoodSnapshotRequest.access.allowedScopes.push('private')
  const neighborhoodSnapshot = await neighborhoodSnapshotPromise
  const browseSnapshotRequest = {
    kind: 'episode' as const,
    access: { allowedScopes: [] as string[] },
    filters: { episodes: { ids: ['browser-signal-snapshot-target'] } },
    limit: 10,
  }
  const browseSnapshotPromise = signalSnapshotMemory.browse(browseSnapshotRequest)
  browseSnapshotRequest.filters.episodes.ids[0] = 'missing-mutated-target'
  browseSnapshotRequest.access.allowedScopes.push('private')
  const browseSnapshot = await browseSnapshotPromise
  const graphSnapshotRequest = {
    access: { allowedScopes: [] as string[] },
    filters: { episodes: { ids: ['browser-signal-snapshot-target'] } },
    maxRecords: 100,
  }
  const graphSnapshotPromise = signalSnapshotMemory.snapshot(graphSnapshotRequest)
  graphSnapshotRequest.filters.episodes.ids[0] = 'missing-mutated-target'
  graphSnapshotRequest.access.allowedScopes.push('private')
  const graphSnapshot = await graphSnapshotPromise
  const analysisSnapshotRequest = {
    access: { allowedScopes: [] as string[] },
    filters: { episodes: { ids: ['browser-signal-snapshot-target'] } },
    pagerank: { seeds: [{ id: 'browser-signal-snapshot-entity', weight: 1 }] },
  }
  const analysisSnapshotPromise = signalSnapshotMemory.analyze(analysisSnapshotRequest)
  analysisSnapshotRequest.filters.episodes.ids[0] = 'missing-mutated-target'
  analysisSnapshotRequest.pagerank.seeds[0]!.id = 'missing-mutated-entity'
  analysisSnapshotRequest.access.allowedScopes.push('private')
  const analysisSnapshot = await analysisSnapshotPromise
  const archiveSnapshotRequest = {
    access: { allowedScopes: [] as string[] },
    episodeIds: ['browser-signal-snapshot-target'],
  }
  const archiveSnapshotPromise = signalSnapshotMemory.export(archiveSnapshotRequest)
  archiveSnapshotRequest.episodeIds[0] = 'missing-mutated-target'
  archiveSnapshotRequest.access.allowedScopes.push('private')
  const archiveSnapshot = await archiveSnapshotPromise
  const changesSnapshotRequest = { access: { allowedScopes: [] as string[] }, limit: 100 }
  const changesSnapshotPromise = signalSnapshotMemory.changes(changesSnapshotRequest)
  changesSnapshotRequest.limit = 1
  changesSnapshotRequest.access.allowedScopes.push('private')
  const changesSnapshot = await changesSnapshotPromise
  const signalChangesSnapshotRequest = { access: { allowedScopes: [] as string[] }, limit: 100 }
  const signalChangesSnapshotPromise = signalSnapshotMemory.signalChanges(
    signalChangesSnapshotRequest,
  )
  signalChangesSnapshotRequest.limit = 1
  signalChangesSnapshotRequest.access.allowedScopes.push('private')
  const signalChangesSnapshot = await signalChangesSnapshotPromise
  const unknownReadRejected = await signalSnapshotMemory
    .analyze({ access: { allowedScopes: [] }, unexpected: true } as never)
    .then(
      () => false,
      (error: unknown) => MemoryError.is(error, 'invalid_input'),
    )
  const coreReadRequestsSnapshotted =
    pointSnapshot.value?.id === 'browser-signal-snapshot-target' &&
    recallSnapshot.episodes[0]?.episodeId === 'browser-signal-snapshot-target' &&
    searchSnapshot.context.entities.some(
      (entity) => entity.id === 'browser-signal-snapshot-entity',
    ) &&
    neighborhoodSnapshot.center.id === 'browser-signal-snapshot-entity' &&
    browseSnapshot.items[0]?.id === 'browser-signal-snapshot-target' &&
    graphSnapshot.episodes[0]?.id === 'browser-signal-snapshot-target' &&
    analysisSnapshot.overview.episodes === 1 &&
    analysisSnapshot.algorithms.personalized &&
    archiveSnapshot.canonical.episodes[0]?.id === 'browser-signal-snapshot-target' &&
    JSON.stringify(changesSnapshot.changes).includes('browser-signal-snapshot-target') &&
    JSON.stringify(signalChangesSnapshot.changes).includes('browser-signal-snapshot-target') &&
    unknownReadRejected
  await signalSnapshotMemory.close()
  const pointReadLimit = await second
    .read({
      kind: 'entity',
      id: 'ada',
      access: { allowedScopes: [] },
      scanLimits: { maxRecords: 1, maxBytes: 1024 * 1024 },
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'point_read_scan' &&
        error.details.dimension === 'records' &&
        error.details.required === 2 &&
        error.details.maximum === 1,
    )
  const pointRead = await second.read({
    kind: 'entity',
    id: 'ada',
    access: { allowedScopes: [] },
    scanLimits: { maxRecords: 100, maxBytes: 1024 * 1024 },
  })
  const pointReadScanBounded =
    pointReadLimit &&
    pointRead.value?.id === 'ada' &&
    pointRead.scan.records > 1 &&
    pointRead.scan.bytes > 0
  const episode = await second.getEpisode('episode-1', { allowedScopes: [] })
  const injectedEpisode = await second.getEpisode('episode-injection', { allowedScopes: [] })
  window.__temporalMemoryStage = 'episode-read'
  const fact = await second.getFact(factId, { allowedScopes: [] })
  window.__temporalMemoryStage = 'fact-read'
  const stats = await second.stats()
  const statsScanRejected = await second
    .stats({ scanLimits: { maxRecords: 1, maxBytes: 1024 * 1024 } })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'stats_scan' &&
        error.details.dimension === 'records' &&
        error.details.required === 2 &&
        error.details.maximum === 1,
    )
  const inspection = await second.inspect()
  const inspectionScanRejected = await second
    .inspect({ scanLimits: { maxRecords: 1, maxBytes: 1024 * 1024 } })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'inspection_scan' &&
        error.details.dimension === 'records' &&
        error.details.required === 2 &&
        error.details.maximum === 1,
    )
  const managementScanBounded =
    statsScanRejected &&
    inspectionScanRejected &&
    stats.scan.records > 1 &&
    stats.scan.bytes > 0 &&
    inspection.scan.records > 1 &&
    inspection.scan.bytes > 0
  const concurrent = await Promise.all(
    Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? second : peer).stats()),
  )
  const derivation = await second.deriveFact({
    conclusion: {
      id: 'browser-derived',
      subjectId: 'ada',
      predicate: 'browser_derived',
      object: { kind: 'scalar', value: true },
    },
    rule: { id: 'browser/rule', version: '1' },
    premises: [{ kind: 'fact', id: factId }],
    access: { allowedScopes: [] },
    expectedRevision: stats.snapshotRevision,
    workLimits: { maxRecords: 32 },
  })
  const derivationBatchRevision = (await second.stats()).snapshotRevision
  const derivationBatchInput = {
    derivations: [
      {
        conclusion: {
          id: 'browser-batch-derived-one',
          subjectId: 'ada',
          predicate: 'browser_batch_derived_one',
          object: { kind: 'scalar' as const, value: true },
        },
        rule: { id: 'browser/batch-rule', version: '1' },
        premises: [{ kind: 'fact' as const, id: factId }],
      },
      {
        conclusion: {
          id: 'browser-batch-derived-two',
          subjectId: 'ada',
          predicate: 'browser_batch_derived_two',
          object: { kind: 'scalar' as const, value: true },
        },
        rule: { id: 'browser/batch-rule', version: '1' },
        premises: [{ kind: 'fact' as const, id: factId }],
      },
    ],
    access: { allowedScopes: [] },
    expectedRevision: derivationBatchRevision,
    workLimits: { maxRecords: 64 },
  }
  const derivationBatch = await second.deriveFacts(derivationBatchInput, {
    operationId: 'browser-derive-batch',
  })
  const derivationBatchReplay = await peer.deriveFacts(derivationBatchInput, {
    operationId: 'browser-derive-batch',
  })
  const failedBatchRevision = (await second.stats()).snapshotRevision
  const derivationBatchFailureClosed = await second
    .deriveFacts(
      {
        derivations: [
          {
            conclusion: {
              id: 'browser-failed-batch-first',
              subjectId: 'ada',
              predicate: 'browser_failed_batch_first',
              object: { kind: 'scalar', value: true },
            },
            rule: { id: 'browser/failed-batch-rule', version: '1' },
            premises: [{ kind: 'fact', id: factId }],
          },
          {
            conclusion: {
              id: 'browser-failed-batch-second',
              subjectId: 'ada',
              predicate: 'browser_failed_batch_second',
              object: { kind: 'scalar', value: true },
            },
            rule: { id: 'browser/failed-batch-rule', version: '1' },
            premises: [{ kind: 'fact', id: 'browser-missing-batch-premise' }],
          },
        ],
        access: { allowedScopes: [] },
        expectedRevision: failedBatchRevision,
      },
      { operationId: 'browser-failed-derive-batch' },
    )
    .then(
      () => false,
      async (error: unknown) =>
        MemoryError.is(error, 'conflict') &&
        (await second.stats()).snapshotRevision === failedBatchRevision &&
        (await second.getFact('browser-failed-batch-first', { allowedScopes: [] })) === null,
    )
  const derivationBatchAtomic =
    derivationBatch.results.map((result) => result.conclusion.id).join(',') ===
      'browser-batch-derived-one,browser-batch-derived-two' &&
    derivationBatch.results.every(
      (result) =>
        result.derivation.operationId === 'browser-derive-batch' &&
        result.derivation.recordedRevision === derivationBatchRevision + 1,
    ) &&
    derivationBatchReplay.operation.id === derivationBatch.operation.id &&
    derivationBatchReplay.results[1]?.derivation.id === derivationBatch.results[1]?.derivation.id &&
    derivationBatchFailureClosed
  const temporaryDerivation = await second.deriveFact({
    conclusion: {
      id: 'browser-withdrawn-derived',
      subjectId: 'ada',
      predicate: 'browser_withdrawn_derived',
      object: { kind: 'scalar', value: true },
    },
    rule: { id: 'browser/withdrawn-rule', version: '1' },
    premises: [{ kind: 'fact', id: factId }],
    access: { allowedScopes: [] },
    expectedRevision: (await second.stats()).snapshotRevision,
    workLimits: { maxRecords: 32 },
  })
  const withdrawnDerivation = await second.withdrawDerivation({
    derivationId: temporaryDerivation.derivation.id,
    access: { allowedScopes: [] },
    expectedRevision: (await second.stats()).snapshotRevision,
    workLimits: { maxRecords: 32 },
  })
  const reactivatedDerivation = await second.deriveFact({
    conclusion: {
      id: 'browser-withdrawn-derived',
      subjectId: 'ada',
      predicate: 'browser_withdrawn_derived',
      object: { kind: 'scalar', value: true },
    },
    rule: { id: 'browser/withdrawn-rule', version: '1' },
    premises: [{ kind: 'fact', id: factId }],
    access: { allowedScopes: [] },
    expectedRevision: (await second.stats()).snapshotRevision,
    workLimits: { maxRecords: 32 },
  })
  const derivationLimitClosed = await second
    .deriveFact({
      conclusion: {
        id: 'browser-limited-derived',
        subjectId: 'ada',
        predicate: 'browser_limited_derived',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'browser/limited-rule', version: '1' },
      premises: [{ kind: 'fact', id: factId }],
      access: { allowedScopes: [] },
      expectedRevision: (await second.stats()).snapshotRevision,
      workLimits: { maxGraphNodes: 1 },
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'derivation' &&
        error.details.dimension === 'graph_nodes',
    )
  const derivationIndexedPlanning =
    derivation.work.records > 0 &&
    derivation.work.records <= 32 &&
    derivation.work.graphNodes === 2 &&
    derivation.work.graphEdges === 1 &&
    temporaryDerivation.work.records <= 32 &&
    withdrawnDerivation.work.records <= 32 &&
    withdrawnDerivation.outcome === 'withdrawn' &&
    withdrawnDerivation.unsupportedFacts.includes('browser-withdrawn-derived') &&
    reactivatedDerivation.outcome === 'reactivated' &&
    reactivatedDerivation.derivation.version === 3 &&
    reactivatedDerivation.derivation.supersedes === withdrawnDerivation.derivation.id &&
    derivationLimitClosed
  await second.remember({
    id: 'browser-retraction-source',
    kind: 'assertion',
    content: { type: 'text', text: 'A disposable fact exercises bounded retraction.' },
    source: { kind: 'retraction-probe' },
    assertions: {
      entities: [{ id: 'ada', name: 'Ada Lovelace' }],
      facts: [
        {
          id: 'browser-correction-fact',
          subject: { id: 'ada' },
          predicate: 'browser_correction_probe',
          object: { scalar: true },
        },
        {
          id: 'browser-retraction-fact',
          subject: { id: 'ada' },
          predicate: 'browser_retraction_probe',
          object: { scalar: true },
        },
      ],
    },
  })
  const correctionRevision = (await second.stats()).snapshotRevision
  const correctionLimitClosed = await second
    .correctFact({
      factId: 'browser-correction-fact',
      replacement: {
        id: 'browser-correction-replacement',
        subject: { id: 'ada' },
        predicate: 'browser_correction_probe',
        object: { scalar: false },
      },
      access: { allowedScopes: [] },
      workLimits: { maxRecords: 1 },
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'derivation' &&
        error.details.dimension === 'records' &&
        error.details.required === 2 &&
        error.details.maximum === 1,
    )
  const correctionLimitAtomic = (await second.stats()).snapshotRevision === correctionRevision
  const correctionSnapshotRequest = {
    factId: 'browser-correction-fact',
    replacement: {
      id: 'browser-correction-replacement',
      subject: { id: 'ada' },
      predicate: 'browser_correction_probe',
      object: { scalar: false },
    },
    access: { allowedScopes: [] as string[] },
    workLimits: { maxRecords: 64 },
  }
  const correctionSnapshotOptions = { operationId: 'browser-correction-snapshot' }
  const correctionSnapshotPromise = second.correctFact(
    correctionSnapshotRequest,
    correctionSnapshotOptions,
  )
  correctionSnapshotRequest.factId = 'mutated-correction-fact'
  correctionSnapshotRequest.replacement.id = 'mutated-correction-replacement'
  correctionSnapshotRequest.replacement.object.scalar = true
  correctionSnapshotRequest.access.allowedScopes.push('private')
  correctionSnapshotRequest.workLimits.maxRecords = 0
  correctionSnapshotOptions.operationId = 'mutated-correction-operation'
  const correction = await correctionSnapshotPromise
  const correctionRequestSnapshotted =
    correction.operation.id === 'browser-correction-snapshot' &&
    correction.affectedFacts.includes('browser-correction-replacement')
  const correctionIndexedPlanning =
    correctionLimitClosed &&
    correctionLimitAtomic &&
    correction.work.records > 0 &&
    correction.work.records <= 64 &&
    correction.work.bytes > 0 &&
    (await second.getFact('browser-correction-fact', { allowedScopes: [] }))?.status ===
      'superseded' &&
    (await second.getFact('browser-correction-replacement', { allowedScopes: [] }))?.status ===
      'active'
  const retractionRevision = (await second.stats()).snapshotRevision
  const retractionLimitClosed = await second
    .retractFact({
      factId: 'browser-retraction-fact',
      allSupport: true,
      access: { allowedScopes: [] },
      workLimits: { maxRecords: 1 },
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'derivation' &&
        error.details.dimension === 'records' &&
        error.details.required === 2 &&
        error.details.maximum === 1,
    )
  const retractionLimitAtomic = (await second.stats()).snapshotRevision === retractionRevision
  const retraction = await second.retractFact({
    factId: 'browser-retraction-fact',
    allSupport: true,
    access: { allowedScopes: [] },
    workLimits: { maxRecords: 32 },
  })
  const retractionIndexedPlanning =
    retractionLimitClosed &&
    retractionLimitAtomic &&
    retraction.work.records > 0 &&
    retraction.work.records <= 32 &&
    retraction.work.bytes > 0 &&
    retraction.affectedFacts.includes('browser-retraction-fact') &&
    (await second.getFact('browser-retraction-fact', { allowedScopes: [] })) === null
  await second.remember({
    id: 'browser-deletion-source',
    kind: 'assertion',
    content: { type: 'text', text: 'A disposable episode exercises bounded deletion.' },
    source: { kind: 'deletion-probe' },
    assertions: {
      entities: [{ id: 'ada', name: 'Ada Lovelace' }],
      facts: [
        {
          id: 'browser-deletion-fact',
          subject: { id: 'ada' },
          predicate: 'browser_deletion_probe',
          object: { scalar: true },
        },
      ],
    },
  })
  const deletionRevision = (await second.stats()).snapshotRevision
  const deletionLimitClosed = await second
    .deleteEpisode({
      episodeId: 'browser-deletion-source',
      access: { allowedScopes: [] },
      workLimits: { maxRecords: 1 },
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'derivation' &&
        error.details.dimension === 'records' &&
        error.details.required === 2 &&
        error.details.maximum === 1,
    )
  const deletionLimitAtomic = (await second.stats()).snapshotRevision === deletionRevision
  const deletion = await second.deleteEpisode({
    episodeId: 'browser-deletion-source',
    access: { allowedScopes: [] },
    workLimits: { maxRecords: 64 },
  })
  const episodeDeletionIndexedPlanning =
    deletionLimitClosed &&
    deletionLimitAtomic &&
    deletion.work.records > 0 &&
    deletion.work.records <= 64 &&
    deletion.work.bytes > 0 &&
    deletion.affectedFacts.includes('browser-deletion-fact') &&
    (await second.getEpisode('browser-deletion-source', { allowedScopes: [] })) === null &&
    (await second.getFact('browser-deletion-fact', { allowedScopes: [] })) === null
  window.__temporalMemoryStage = 'stats-read'
  const recalled = await second.recall({
    query: 'analytical engine',
    access: { allowedScopes: [] },
    channels: { exact: false, lexical: true, semantic: false, graph: true, temporal: false },
  })
  const injectionRecall = await second.recall({
    query: injected,
    access: { allowedScopes: [] },
    channels: { exact: true, lexical: true, semantic: false, graph: false, temporal: false },
  })
  const recallScanRejected = await second
    .recall({
      anchors: { entityIds: ['ada'] },
      access: { allowedScopes: [] },
      channels: { exact: true, lexical: false, semantic: false, graph: true, temporal: false },
      scanLimits: { maxRecords: 1, maxBytes: 1024 * 1024 },
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'recall_scan' &&
        error.details?.dimension === 'records' &&
        error.details?.required === 2 &&
        error.details?.maximum === 1,
    )
  const browseScanRejected = await second
    .browse({
      kind: 'entity',
      access: { allowedScopes: [] },
      order: 'id',
      limit: 1,
      scanLimits: { maxRecords: 1, maxBytes: 1024 * 1024 },
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'browse_scan' &&
        error.details?.dimension === 'records' &&
        error.details?.required === 2 &&
        error.details?.maximum === 1,
    )
  const nativeEpisodeScanRejected = await second
    .browse({
      kind: 'episode',
      access: { allowedScopes: [] },
      order: 'id',
      limit: 200,
      scanLimits: { maxRecords: 1, maxBytes: 1024 * 1024 },
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'browse_scan' &&
        error.details?.dimension === 'records' &&
        error.details?.required === 2 &&
        error.details?.maximum === 1,
    )
  const boundedNeighborhood = await second.neighborhood({
    entityId: 'ada',
    access: { allowedScopes: [] },
    depth: 2,
    scanLimits: { maxRecords: 100, maxBytes: 1024 * 1024 },
  })
  const retrievalScanBounded =
    recalled.scan.records > 0 &&
    recalled.scan.records <= recalled.scan.limits.maxRecords &&
    recalled.scan.bytes > 0 &&
    recalled.scan.bytes <= recalled.scan.limits.maxBytes &&
    boundedNeighborhood.scan.records > 0 &&
    boundedNeighborhood.scan.records <= boundedNeighborhood.scan.limits.maxRecords &&
    boundedNeighborhood.scan.bytes > 0 &&
    boundedNeighborhood.scan.bytes <= boundedNeighborhood.scan.limits.maxBytes &&
    recallScanRejected &&
    browseScanRejected &&
    nativeEpisodeScanRejected
  for (const id of ['unicode-z', 'unicode-á']) {
    await second.remember({
      id,
      kind: 'assertion',
      content: { type: 'text', text: `${id} ordering.` },
      source: { kind: 'unicode-order' },
    })
  }
  const firstUnicodePage = await second.browse({
    kind: 'episode',
    access: { allowedScopes: [] },
    order: 'id',
    filters: { episodes: { source: { kinds: ['unicode-order'] } } },
    limit: 1,
  })
  const secondUnicodePage = await second.browse({
    kind: 'episode',
    access: { allowedScopes: [] },
    order: 'id',
    filters: { episodes: { source: { kinds: ['unicode-order'] } } },
    limit: 1,
    cursor: firstUnicodePage.nextCursor,
  })
  const firstEpisodePage = await second.browse({
    kind: 'episode',
    access: { allowedScopes: [] },
    order: 'id',
    filters: {
      episodes: {
        source: { kinds: ['browser-test'] },
        tags: { all: ['browser'], none: ['excluded'] },
      },
    },
    limit: 1,
  })
  const secondEpisodePage = await second.browse({
    kind: 'episode',
    access: { allowedScopes: [] },
    order: 'id',
    filters: {
      episodes: {
        source: { kinds: ['browser-test'] },
        tags: { all: ['browser'], none: ['excluded'] },
      },
    },
    limit: 1,
    cursor: firstEpisodePage.nextCursor,
  })
  const newestEpisodePage = await second.browse({
    kind: 'episode',
    access: { allowedScopes: [] },
    order: 'newest',
    filters: {
      episodes: {
        source: { kinds: ['browser-test'] },
        tags: { all: ['browser'], none: ['excluded'] },
      },
    },
    limit: 1,
  })
  const olderEpisodePage = await second.browse({
    kind: 'episode',
    access: { allowedScopes: [] },
    order: 'newest',
    filters: {
      episodes: {
        source: { kinds: ['browser-test'] },
        tags: { all: ['browser'], none: ['excluded'] },
      },
    },
    limit: 1,
    cursor: newestEpisodePage.nextCursor,
  })
  const oldestEpisodePage = await second.browse({
    kind: 'episode',
    access: { allowedScopes: [] },
    order: 'oldest',
    filters: {
      episodes: {
        source: { kinds: ['browser-test'] },
        tags: { all: ['browser'], none: ['excluded'] },
      },
    },
    limit: 1,
  })
  const laterEpisodePage = await second.browse({
    kind: 'episode',
    access: { allowedScopes: [] },
    order: 'oldest',
    filters: {
      episodes: {
        source: { kinds: ['browser-test'] },
        tags: { all: ['browser'], none: ['excluded'] },
      },
    },
    limit: 1,
    cursor: oldestEpisodePage.nextCursor,
  })
  const changesBeforePurge = await second.changes({ access: { allowedScopes: [] } })
  const serializedChangesBeforePurge = JSON.stringify(changesBeforePurge.changes)
  const changeFeedPersisted =
    serializedChangesBeforePurge.includes('episode-1') &&
    serializedChangesBeforePurge.includes('episode-injection')
  await second.remember({
    id: 'episode-soft-delete',
    kind: 'event',
    content: { type: 'event', name: 'temporary', value: true },
    source: { kind: 'browser-soft-delete' },
  })
  await second.remember({
    id: 'episode-preview-delete',
    kind: 'event',
    content: { type: 'event', name: 'temporary-preview', value: true },
    source: { kind: 'browser-preview-delete' },
    tags: ['preview-delete'],
  })
  const episodeDeleteWhere = { tags: { all: ['preview-delete'] } } as const
  const episodeDeletePreview = await second.previewEpisodeDeletions({
    where: episodeDeleteWhere,
    access: { allowedScopes: [] },
    maxMatches: 1,
    workLimits: { maxRecords: 16 },
  })
  const repeatedEpisodeDeletePreview = await second.previewEpisodeDeletions({
    where: episodeDeleteWhere,
    access: { allowedScopes: [] },
    expectedRevision: episodeDeletePreview.snapshotRevision,
    maxMatches: 1,
    workLimits: { maxRecords: 16 },
  })
  const episodeDelete = await second.deleteEpisodes(
    {
      where: episodeDeleteWhere,
      access: { allowedScopes: [] },
      expectedRevision: episodeDeletePreview.snapshotRevision,
      selectionCursor: episodeDeletePreview.selectionCursor!,
      maxMatches: 1,
      workLimits: { maxRecords: 64 },
    },
    { operationId: 'browser-preview-delete' },
  )
  const episodeDeletionPreviewBound =
    episodeDeletePreview.episodes[0]?.id === 'episode-preview-delete' &&
    episodeDeletePreview.selectionCursor === repeatedEpisodeDeletePreview.selectionCursor &&
    episodeDeletePreview.work.records === 1 &&
    episodeDelete.affectedEpisodes.join(',') === 'episode-preview-delete' &&
    (await second.getEpisode('episode-preview-delete', { allowedScopes: [] })) === null
  const signalBaseline = await second.browseSignals({ access: { allowedScopes: [] } })
  const signalBasisLimitClosed = await second
    .putSignals({
      access: { allowedScopes: [] },
      expectedRevision: signalBaseline.snapshotRevision,
      basisScanLimits: { maxRecords: 1, maxBytes: 1024 * 1024 },
      signals: [
        {
          namespace: 'browser.basis-limit',
          target: { kind: 'episode', id: 'episode-1' },
          producer: { kind: 'algorithm', id: 'browser-fixture', version: '1' },
          scopes: [],
          basis: { episodeIds: ['episode-1'] },
          value: { admitted: false },
        },
      ],
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'signal_basis_scan' &&
        error.details.dimension === 'records' &&
        error.details.required === 2 &&
        error.details.maximum === 1,
    )
  const signalRevisionAfterLimit = (await second.stats()).snapshotRevision
  const signalWrite = await second.putSignals({
    access: { allowedScopes: [] },
    expectedRevision: signalBaseline.snapshotRevision,
    basisScanLimits: { maxRecords: 10_000, maxBytes: 16 * 1024 * 1024 },
    signals: [
      {
        namespace: 'browser.persistence',
        target: { kind: 'episode', id: 'episode-1' },
        producer: { kind: 'algorithm', id: 'browser-fixture', version: '1' },
        scopes: [],
        basis: { episodeIds: ['episode-1'] },
        value: { durable: true },
      },
      {
        namespace: 'browser.purge',
        target: { kind: 'entity', id: 'injected-entity' },
        producer: { kind: 'algorithm', id: 'browser-fixture', version: '1' },
        scopes: [],
        basis: { episodeIds: ['episode-injection'] },
        value: { contaminated: true },
      },
      {
        namespace: 'browser.purge',
        target: { kind: 'episode', id: 'episode-injection' },
        producer: { kind: 'algorithm', id: 'browser-fixture', version: '1' },
        scopes: [],
        basis: { episodeIds: ['episode-injection'] },
        value: { contaminated: true },
      },
      {
        namespace: 'browser.soft-delete',
        target: { kind: 'episode', id: 'episode-soft-delete' },
        producer: { kind: 'algorithm', id: 'browser-fixture', version: '1' },
        scopes: [],
        basis: { episodeIds: ['episode-soft-delete'] },
        value: { recommendation: 'forget' },
      },
    ],
  })
  const signalBasisScanBounded =
    signalBasisLimitClosed &&
    signalRevisionAfterLimit === signalBaseline.snapshotRevision &&
    signalWrite.basisScan.records > 1 &&
    signalWrite.basisScan.bytes > 0
  const softDeleteWhere = { namespaces: ['browser.soft-delete'] } as const
  const softDeletePreview = await second.browseSignals({
    access: { allowedScopes: [] },
    where: softDeleteWhere,
  })
  const softDeleteSemanticBaseline = await second.snapshot({ access: { allowedScopes: [] } })
  const softDelete = await second.deleteEpisodes(
    {
      access: { allowedScopes: [] },
      signalTargets: {
        where: softDeleteWhere,
        selectionCursor: softDeletePreview.targetSelectionCursor!,
      },
      maxMatches: 1,
      workLimits: { maxRecords: 64 },
    },
    { operationId: 'browser-soft-delete' },
  )
  const softDeleteSemanticDelta = await second.changes({
    access: { allowedScopes: [] },
    cursor: softDeleteSemanticBaseline.changesCursor,
  })
  const softDeleteSignalDelta = await second.signalChanges({
    access: { allowedScopes: [] },
    cursor: softDeletePreview.signalChangesCursor,
  })
  const signalSoftDeleteAtomic =
    softDelete.work.records > 0 &&
    softDelete.work.records <= 64 &&
    softDelete.work.bytes > 0 &&
    (await second.getEpisode('episode-soft-delete', { allowedScopes: [] })) === null &&
    (await second.browseSignals({ access: { allowedScopes: [] }, where: softDeleteWhere }))
      .total === 0 &&
    softDeleteSemanticDelta.changes.length === 1 &&
    softDeleteSemanticDelta.changes[0]?.phase === 'governance' &&
    softDeleteSignalDelta.changes.length === 1 &&
    softDeleteSignalDelta.changes[0]?.action === 'withdraw' &&
    softDeleteSignalDelta.changes[0]?.revision === softDeleteSemanticDelta.changes[0]?.revision
  const dependentSignalKey = signalWrite.signals.find(
    (signal) => signal.namespace === 'browser.purge',
  )?.key
  window.__temporalMemoryStage = 'recall-read'
  const driver = storageDriver(secondStorage)
  await driver.createSpace({
    kind: 'space',
    id: 'browser-legacy',
    spaceId: 'browser-legacy',
    generation: 'browser-legacy-generation',
    revision: 0,
    metadataRevision: 0,
    changesCompactedThrough: 0,
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
  } as Parameters<typeof driver.createSpace>[0])
  const legacyMemory = createMemory({ spaceId: 'browser-legacy', storage: secondStorage })
  await legacyMemory.open({ migrate: true })
  const migratedInspection = await legacyMemory.inspect()
  const migrationApplied =
    migratedInspection.space?.schemaVersion === '7' &&
    migratedInspection.schemaMigrations.length === 2 &&
    migratedInspection.schemaMigrations.every(
      (migration) => migration.state === 'succeeded' && /^[a-f0-9]{64}$/u.test(migration.checksum),
    )
  await legacyMemory.close()
  const hadEntityProjection = (
    await driver.query({ kind: 'projection', spaceId: 'browser-space' })
  ).some(
    (projection) =>
      projection.target.kind === 'entity' && projection.target.id === 'injected-entity',
  )
  const entityMergeRevision = (await second.stats()).snapshotRevision
  const entityMergeLimitClosed = await second
    .mergeEntities(
      {
        targetId: 'ada',
        sourceIds: ['injected-entity'],
        access: { allowedScopes: [] },
        workLimits: { maxRecords: 1 },
      },
      { operationId: 'op_browser_merge_limit' },
    )
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'derivation' &&
        error.details.dimension === 'records' &&
        error.details.required === 2 &&
        error.details.maximum === 1,
    )
  const entityMergeLimitAtomic = (await second.stats()).snapshotRevision === entityMergeRevision
  const indexedMerge = await second.mergeEntities(
    {
      targetId: 'ada',
      sourceIds: ['injected-entity'],
      access: { allowedScopes: [] },
      workLimits: { maxRecords: 64 },
    },
    { operationId: 'op_browser_merge_index' },
  )
  const mergeId = indexedMerge.operation.id.replace(/^op_/, 'merge_')
  const activeMergeRows = await driver.query({
    kind: 'merge',
    spaceId: 'browser-space',
    filters: [{ field: 'active', op: 'eq', value: true }],
  })
  const entitySplitRevision = (await second.stats()).snapshotRevision
  const entitySplitLimitClosed = await second
    .splitEntityMerge(
      { mergeId, access: { allowedScopes: [] }, workLimits: { maxRecords: 1 } },
      { operationId: 'browser-merge-split-limit' },
    )
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'derivation' &&
        error.details.dimension === 'records' &&
        error.details.required === 2 &&
        error.details.maximum === 1,
    )
  const entitySplitLimitAtomic = (await second.stats()).snapshotRevision === entitySplitRevision
  const indexedSplit = await second.splitEntityMerge(
    { mergeId, access: { allowedScopes: [] }, workLimits: { maxRecords: 64 } },
    { operationId: 'browser-merge-index-split' },
  )
  const inactiveMergeRows = await driver.query({
    kind: 'merge',
    spaceId: 'browser-space',
    filters: [{ field: 'active', op: 'eq', value: false }],
  })
  await second.rebuildProjections(
    { entityIds: ['injected-entity'] },
    { operationId: 'browser-merge-index-rebuild' },
  )
  const projectionSetBefore = (await driver.getSpace('browser-space'))?.projectionSets?.lexical?.id
  const projectionSnapshotRequest = {
    kinds: ['lexical'] as ('lexical' | 'embedding' | 'summary')[],
    scanLimits: { maxRecords: 10_000, maxBytes: 16 * 1024 * 1024 },
  }
  const projectionSnapshotOptions = { operationId: 'browser-atomic-projection-rebuild' }
  const projectionSnapshotPromise = second.rebuildProjections(
    projectionSnapshotRequest,
    projectionSnapshotOptions,
  )
  projectionSnapshotRequest.kinds[0] = 'summary'
  projectionSnapshotRequest.scanLimits.maxRecords = 0
  projectionSnapshotOptions.operationId = 'mutated-projection-rebuild'
  const projectionRebuild = await projectionSnapshotPromise
  const rebuildRequestSnapshotted =
    projectionRebuild.operation.id === 'browser-atomic-projection-rebuild'
  const projectionSetAfter = (await driver.getSpace('browser-space'))?.projectionSets?.lexical?.id
  const projectionRecall = await second.recall({
    query: 'Robert',
    access: { allowedScopes: [] },
    channels: { exact: false, lexical: true, semantic: false, graph: false, temporal: false },
  })
  const projectionEnvelopes = await secondAdmin.rawQuery<
    [
      readonly {
        target_id?: string
        set_id?: string
        state?: string
        text?: string
        sensitivities?: readonly string[]
      }[],
    ]
  >({
    query:
      "SELECT target_id, set_id, state, text, sensitivities FROM tm_projection WHERE space_id = $space AND projection_kind = 'lexical';",
    bindings: { space: 'browser-space' },
    confirmNamespace: 'astrale',
    confirmDatabase: 'temporal_memory',
  })
  const projectionRows = projectionEnvelopes.statements[0]
  const projectionSetCutover =
    projectionRebuild.failed === 0 &&
    projectionRebuild.staleRemaining === 0 &&
    projectionSetBefore !== undefined &&
    projectionSetAfter !== undefined &&
    projectionSetAfter !== projectionSetBefore &&
    projectionRecall.entities.some((entity) => entity.id === 'injected-entity') &&
    projectionRows?.success === true &&
    projectionRows.result.length > 0 &&
    projectionRows.result.every(
      (row) =>
        row.set_id === projectionSetAfter && row.state === 'ready' && typeof row.text === 'string',
    )
  const classifiedProjectionRows =
    projectionRows?.success === true
      ? projectionRows.result.filter((row) =>
          ['episode-injection', 'injected-entity'].includes(row.target_id ?? ''),
        )
      : []
  const projectionSensitivityPersisted =
    projectionRows?.success === true &&
    projectionRows.result.every(
      (row) =>
        Array.isArray(row.sensitivities) &&
        row.sensitivities.join(',') === [...row.sensitivities].sort().join(','),
    ) &&
    classifiedProjectionRows.length === 2 &&
    classifiedProjectionRows.every((row) => row.sensitivities?.join(',') === 'browser-restricted')
  const projectionSetBeforeLimit = (await driver.getSpace('browser-space'))?.projectionSets?.lexical
    ?.id
  const projectionScanRejected = await second
    .rebuildProjections(
      {
        kinds: ['lexical'],
        entityIds: ['injected-entity'],
        scanLimits: { maxRecords: 1, maxBytes: 1024 * 1024 },
      },
      { operationId: 'browser-projection-scan-limit' },
    )
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'projection_scan' &&
        error.details.dimension === 'records' &&
        error.details.required === 2 &&
        error.details.maximum === 1,
    )
  const projectionScanBounded =
    projectionRebuild.scan.records > 0 &&
    projectionRebuild.scan.records <= projectionRebuild.scan.limits.maxRecords &&
    projectionRebuild.scan.bytes > 0 &&
    projectionRebuild.scan.bytes <= projectionRebuild.scan.limits.maxBytes &&
    projectionScanRejected &&
    (await driver.getSpace('browser-space'))?.projectionSets?.lexical?.id ===
      projectionSetBeforeLimit
  const activeMergeIndex =
    activeMergeRows.some((merge) => merge.id === mergeId && merge.active) &&
    inactiveMergeRows.some((merge) => merge.id === mergeId && !merge.active) &&
    (
      await driver.query({
        kind: 'projection',
        spaceId: 'browser-space',
        filters: [
          { field: 'target.kind', op: 'eq', value: 'entity' },
          { field: 'target.id', op: 'eq', value: 'injected-entity' },
        ],
      })
    ).length > 0
  const entityMergeIndexedPlanning =
    entityMergeLimitClosed &&
    entityMergeLimitAtomic &&
    entitySplitLimitClosed &&
    entitySplitLimitAtomic &&
    indexedMerge.work.records > 0 &&
    indexedMerge.work.records <= 64 &&
    indexedMerge.work.bytes > 0 &&
    indexedSplit.work.records > 0 &&
    indexedSplit.work.records <= 64 &&
    indexedSplit.work.bytes > 0
  const purgeSignalWhere = { namespaces: ['browser.purge'] } as const
  const purgeSignalPreview = await second.browseSignals({
    access: { allowedScopes: [] },
    where: purgeSignalWhere,
    limit: 1,
  })
  const changesBeforeHardPurge = await second.changes({ access: { allowedScopes: [] } })
  const hardPurge = await second.hardPurge(
    {
      access: { allowedScopes: [] },
      signalTargets: {
        where: purgeSignalWhere,
        selectionCursor: purgeSignalPreview.targetSelectionCursor!,
      },
      maxMatches: 2,
      workLimits: {
        maxRecords: 1_000,
        maxBytes: 4 * 1024 * 1024,
        maxGraphNodes: 1_000,
        maxGraphEdges: 1_000,
      },
    },
    { operationId: 'browser-purge' },
  )
  const hardPurgeIndexedPlanning =
    hardPurge.work.records > 0 &&
    hardPurge.work.records <= 1_000 &&
    hardPurge.work.bytes > 0 &&
    hardPurge.work.bytes <= 4 * 1024 * 1024
  const purgeDelta = await second.changes({
    access: { allowedScopes: [] },
    cursor: changesBeforeHardPurge.nextCursor,
  })
  const changePurgeInvalidated =
    purgeDelta.changes.length === 1 &&
    purgeDelta.changes[0]?.phase === 'purge' &&
    purgeDelta.changes[0].partitions.every(
      (partition) =>
        partition.invalidated === true &&
        partition.affected.episodeIds.length === 0 &&
        partition.affected.entityIds.length === 0 &&
        partition.affected.factIds.length === 0,
    )
  const storedChanges = await driver.query({ kind: 'change', spaceId: 'browser-space' })
  const serializedStoredChanges = JSON.stringify(storedChanges)
  const changePurgeScrubbed =
    !serializedStoredChanges.includes('episode-injection') &&
    !serializedStoredChanges.includes('injected-entity')
  const purgeProjectionClosure =
    hadEntityProjection &&
    !(await driver.query({ kind: 'projection', spaceId: 'browser-space' })).some(
      (projection) =>
        projection.target.kind === 'entity' && projection.target.id === 'injected-entity',
    )
  const signalsAfterPurge = await second.browseSignals({
    access: { allowedScopes: [] },
    revisionView: 'history',
  })
  const storedSignalsAfterPurge = await driver.query({
    kind: 'signal',
    spaceId: 'browser-space',
  })
  const signalPurgeClosed =
    dependentSignalKey !== undefined &&
    signalsAfterPurge.total === 3 &&
    signalsAfterPurge.signals.filter((signal) => signal.namespace === 'browser.persistence')
      .length === 1 &&
    signalsAfterPurge.signals.filter((signal) => signal.namespace === 'browser.soft-delete')
      .length === 2 &&
    storedSignalsAfterPurge.length === 3 &&
    !JSON.stringify(storedSignalsAfterPurge).includes(dependentSignalKey) &&
    !JSON.stringify(storedSignalsAfterPurge).includes('episode-injection')
  const signalDelta = await second.signalChanges({
    access: { allowedScopes: [] },
    cursor: signalBaseline.signalChangesCursor,
  })
  const serializedSignalDelta = JSON.stringify(signalDelta)
  const signalChangeFeedPersisted =
    signalDelta.changes.map((change) => change.action).join(',') === 'put,withdraw,purge'
  const withdrawalChange = signalDelta.changes.find((change) => change.action === 'withdraw')
  const signalChangePurgeScrubbed =
    signalDelta.changes
      .filter((change) => change.action !== 'withdraw')
      .every((change) =>
        change.partitions.every(
          (partition) => partition.invalidated === true && partition.affected.length === 0,
        ),
      ) &&
    withdrawalChange?.partitions.every(
      (partition) =>
        partition.invalidated !== true &&
        partition.affected.every((affected) => affected.target.id === 'episode-soft-delete'),
    ) === true &&
    !serializedSignalDelta.includes('episode-injection') &&
    !serializedSignalDelta.includes(dependentSignalKey ?? 'missing-dependent-key')
  const signalAnalysis = await second.analyze({
    access: { allowedScopes: [] },
    pagerank: { seeds: [{ id: 'ada' }] },
    budgets: {
      maxScannedRecords: 100,
      maxScannedBytes: 1024 * 1024,
      maxAnalyzedRecords: 100,
      maxGraphNodes: 100,
      maxGraphEdges: 100,
      maxPageRankSteps: 10_000,
      maxTemporalComparisons: 100,
    },
  })
  const signalDiagnostics =
    signalAnalysis.signals.active === 1 &&
    signalAnalysis.signals.expired === 0 &&
    signalAnalysis.signals.withdrawn === 0 &&
    signalAnalysis.signals.byNamespace['browser.persistence']?.active === 1 &&
    signalAnalysis.algorithms.graph === 'personalized-pagerank-v1' &&
    signalAnalysis.algorithms.seedCount === 1 &&
    signalAnalysis.findingSummary.returned === signalAnalysis.findings.length &&
    signalAnalysis.findingSummary.total >= signalAnalysis.findingSummary.returned &&
    signalAnalysis.findingSummary.returned <= 20 &&
    signalAnalysis.work.pageRankSteps <= signalAnalysis.work.limits.maxPageRankSteps
  const analysisScanRejected = await second
    .analyze({
      access: { allowedScopes: [] },
      budgets: { maxScannedRecords: 1, maxScannedBytes: 1024 * 1024 },
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'analysis_scan' &&
        error.details?.dimension === 'records' &&
        error.details?.required === 2 &&
        error.details?.maximum === 1,
    )
  const analysisScanBounded =
    signalAnalysis.work.scannedRecords > 0 &&
    signalAnalysis.work.scannedBytes > 0 &&
    signalAnalysis.work.scannedRecords <= signalAnalysis.work.limits.maxScannedRecords &&
    signalAnalysis.work.scannedBytes <= signalAnalysis.work.limits.maxScannedBytes &&
    analysisScanRejected
  const boundedSnapshot = await second.snapshot({
    access: { allowedScopes: [] },
    scanLimits: { maxRecords: 100, maxBytes: 1024 * 1024 },
  })
  const snapshotScanRejected = await second
    .snapshot({
      access: { allowedScopes: [] },
      scanLimits: { maxRecords: 1, maxBytes: 1024 * 1024 },
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'snapshot_scan' &&
        error.details?.dimension === 'records' &&
        error.details?.required === 2 &&
        error.details?.maximum === 1,
    )
  const snapshotScanBounded =
    boundedSnapshot.scan.records > 0 &&
    boundedSnapshot.scan.bytes > 0 &&
    boundedSnapshot.scan.records <= boundedSnapshot.scan.limits.maxRecords &&
    boundedSnapshot.scan.bytes <= boundedSnapshot.scan.limits.maxBytes &&
    snapshotScanRejected
  const signalKeyPurgeBaseline = await second.browseSignals({ access: { allowedScopes: [] } })
  await second.putSignals({
    access: { allowedScopes: [] },
    expectedRevision: signalKeyPurgeBaseline.snapshotRevision,
    signals: [
      {
        namespace: 'browser.key-purge',
        target: { kind: 'episode', id: 'episode-1' },
        producer: { kind: 'manual', id: 'browser-fixture', version: '1' },
        scopes: [],
        value: { transient: true },
      },
    ],
  })
  const signalKeyPurgePreview = await second.browseSignals({
    access: { allowedScopes: [] },
    where: { namespaces: ['browser.key-purge'] },
  })
  const signalKeyPurge = await second.deleteSignals({
    access: { allowedScopes: [] },
    mode: 'purge',
    where: { namespaces: ['browser.key-purge'] },
    expectedRevision: signalKeyPurgePreview.snapshotRevision,
    maxMatches: 1,
    maxRevisions: 1,
  })
  const signalKeyPurgeAtomic =
    signalKeyPurge.matchedSignals === 1 &&
    signalKeyPurge.deletedRevisions === 1 &&
    (
      await second.browseSignals({
        access: { allowedScopes: [] },
        revisionView: 'history',
        where: { namespaces: ['browser.key-purge'] },
      })
    ).total === 0
  const purgeMarker = (await driver.query({ kind: 'purge', spaceId: 'browser-space' })).find(
    (marker) => marker.operationId === 'browser-purge',
  )
  const purgeRequestBound =
    purgeMarker?.id !== 'browser-purge' && /^[a-f0-9]{64}$/u.test(purgeMarker?.requestHash ?? '')
  const purgedOperation = await driver.get(
    'operation',
    'browser-space',
    'browser-injection-operation',
  )
  const operationOverwriteBlocked = await second
    .remember(
      {
        id: 'operation-overwrite-attempt',
        kind: 'assertion',
        content: { type: 'text', text: 'A late write must not replace erased diagnostics.' },
        source: { kind: 'browser-test' },
        assertions: { entities: [] },
      },
      { operationId: 'browser-injection-operation' },
    )
    .then(
      () => false,
      (error: unknown) => MemoryError.is(error, 'idempotency_conflict'),
    )
  const operationPurgeScrubbed =
    purgedOperation?.diagnosticsState === 'purged' &&
    purgedOperation.diagnosticsTruncated === false &&
    purgedOperation.stage === 'purged' &&
    purgedOperation.episodeId === undefined &&
    purgedOperation.result === undefined &&
    purgedOperation.error === undefined &&
    purgedOperation.warnings.length === 0 &&
    purgedOperation.remoteCalls.length === 0 &&
    !JSON.stringify(purgedOperation).includes('episode-injection') &&
    !JSON.stringify(purgedOperation).includes('injected-entity') &&
    operationOverwriteBlocked &&
    (await second.getEpisode('operation-overwrite-attempt', { allowedScopes: [] })) === null
  const purgeReplayBlocked = await second
    .remember({
      id: 'episode-injection-replay',
      idempotencyKey: 'episode-injection',
      kind: 'assertion',
      content: { type: 'text', text: injected },
      source: { kind: 'browser-test' },
      assertions: { entities: [{ id: 'injected-entity', name: injected }] },
    })
    .then(
      () => false,
      (error: unknown) => MemoryError.is(error, 'idempotency_conflict'),
    )
  window.__temporalMemoryStage = 'purge-replay-checked'
  const signalCompactionBaseline = await second.browseSignals({ access: { allowedScopes: [] } })
  const registeredSignalConsumer = await second.registerJournalConsumer({
    id: 'browser-signal-consumer',
    journal: 'signal',
    cursor: signalCompactionBaseline.signalChangesCursor,
  })
  const signalCompaction = await second.compactSignalChanges({
    confirmSpaceId: 'browser-space',
    registeredConsumers: true,
    expectedRevision: signalCompactionBaseline.snapshotRevision,
    maxChanges: 1_000,
  })
  const signalChangeCompactionInvalidated = await second
    .signalChanges({
      access: { allowedScopes: [] },
      cursor: signalBaseline.signalChangesCursor,
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'conflict') && error.details?.requiresSignalBaseline === true,
    )
  const compactionSnapshot = await second.snapshot({ access: { allowedScopes: [] } })
  const registeredSemanticConsumer = await second.registerJournalConsumer({
    id: 'browser-semantic-consumer',
    journal: 'semantic',
    cursor: compactionSnapshot.changesCursor,
  })
  const compaction = await second.compactChanges({
    confirmSpaceId: 'browser-space',
    registeredConsumers: true,
    expectedRevision: compactionSnapshot.snapshotRevision,
    maxChanges: 1_000,
  })
  const changeCompactionInvalidated = await second
    .changes({ access: { allowedScopes: [] }, cursor: changesBeforePurge.nextCursor })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'conflict') && error.details?.requiresSnapshot === true,
    )
  const canonicalArchive = await second.export({
    access: { allowedScopes: [] },
    complete: true,
    scanLimits: { maxRecords: 1_000, maxBytes: 1024 * 1024 },
    limits: { maxRecords: 1_000, maxBytes: 1024 * 1024 },
  })
  const identityEpisode = canonicalArchive.canonical.episodes.find(
    (episode) => episode.assertions !== undefined,
  )
  if (identityEpisode === undefined) throw new Error('canonical archive identity input is missing')
  const tamperedCanonical = {
    ...canonicalArchive.canonical,
    episodes: canonicalArchive.canonical.episodes.map((episode) =>
      episode.id === identityEpisode.id ? { ...episode, assertions: undefined } : episode,
    ),
  }
  const tamperedArchive = {
    ...canonicalArchive,
    canonical: tamperedCanonical,
    manifest: {
      ...canonicalArchive.manifest,
      digest: await sha256(stableStringify(tamperedCanonical as unknown as JsonValue)),
    },
  }
  const unknownPropertyArchive = {
    ...canonicalArchive,
    canonical: {
      ...canonicalArchive.canonical,
      episodes: canonicalArchive.canonical.episodes.map((episode) =>
        episode.id === identityEpisode.id
          ? { ...episode, source: { ...episode.source, unexpected: true } }
          : episode,
      ),
    },
  }
  const archiveTarget = createMemory({ spaceId: 'browser-archive-target', storage: secondStorage })
  await archiveTarget.open({ create: true })
  const archiveIdentityRejected = await archiveTarget
    .import(tamperedArchive, { dryRun: true })
    .then(
      () => false,
      (error: unknown) => MemoryError.is(error, 'import_invalid'),
    )
  const archiveSchemaRejected = await archiveTarget
    .import(unknownPropertyArchive as never, { dryRun: true })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'import_invalid') && error.message.includes('unexpected'),
    )
  const importSnapshotArchive = structuredClone(canonicalArchive)
  const importSnapshotOptions = {
    dryRun: true,
    collisions: 'reject' as const,
    limits: { maxRecords: 10_000, maxBytes: 16 * 1024 * 1024 },
  }
  const archiveDryRunPromise = archiveTarget.import(importSnapshotArchive, importSnapshotOptions)
  Reflect.set(importSnapshotArchive.manifest, 'digest', '0'.repeat(64))
  Reflect.set(importSnapshotOptions, 'dryRun', false)
  Reflect.set(importSnapshotOptions, 'collisions', 'invalid')
  importSnapshotOptions.limits.maxRecords = 0
  const archiveDryRun = await archiveDryRunPromise
  const importRequestSnapshotted = archiveDryRun.dryRun && archiveDryRun.valid
  await archiveTarget.close()
  const archiveLimitClosed = await second
    .export({
      access: { allowedScopes: [] },
      complete: true,
      scanLimits: { maxRecords: 1_000, maxBytes: 1024 * 1024 },
      limits: { maxRecords: 1_000, maxBytes: 1 },
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'archive' &&
        error.details?.dimension === 'bytes' &&
        error.details?.maximum === 1,
    )
  const boundedCanonicalArchive =
    canonicalArchive.formatVersion === 4 &&
    canonicalArchive.manifest.algorithm === 'SHA-256' &&
    /^[a-f0-9]{64}$/u.test(canonicalArchive.manifest.digest) &&
    canonicalArchive.manifest.counts.episodes > 0 &&
    identityEpisode.assertions !== undefined &&
    archiveIdentityRejected &&
    archiveSchemaRejected &&
    archiveDryRun.valid &&
    archiveLimitClosed
  const mutationRequestsSnapshotted =
    resetRequestSnapshotted &&
    correctionRequestSnapshotted &&
    rebuildRequestSnapshotted &&
    importRequestSnapshotted
  const facadeOptionsMemory = createMemory({
    spaceId: 'browser-facade-options',
    storage: createSurrealMemoryStorage({ endpoint, worker }),
  })
  const facadeOpenOptions = {
    create: true,
    metadata: { owner: 'browser-original', nested: { state: 'ready' } },
  }
  const facadeOpenPromise = facadeOptionsMemory.open(facadeOpenOptions)
  facadeOpenOptions.create = false
  facadeOpenOptions.metadata.owner = 'browser-mutated'
  facadeOpenOptions.metadata.nested.state = 'mutated'
  const facadeSpace = await facadeOpenPromise
  const facadeOpenInputSnapshotted =
    facadeSpace.metadata?.owner === 'browser-original' &&
    (facadeSpace.metadata.nested as { state?: string } | undefined)?.state === 'ready'
  const mutableFacadeMetadata = facadeSpace.metadata as {
    owner: string
    nested: { state: string }
  }
  mutableFacadeMetadata.owner = 'returned-value-mutation'
  mutableFacadeMetadata.nested.state = 'returned-value-mutation'
  const facadeReopenedSpace = await facadeOptionsMemory.open()
  let facadeListenerIsolated = false
  let facadeListenerState: string | undefined
  let facadeListenerWarnings: readonly string[] | undefined
  facadeOptionsMemory.on('operation:settled', (event) => {
    Reflect.set(event.operation, 'state', 'failed')
    ;(event.operation.warnings as string[]).push('first-listener-mutation')
  })
  facadeOptionsMemory.on('operation:settled', (event) => {
    facadeListenerState = event.operation.state
    facadeListenerWarnings = event.operation.warnings
    facadeListenerIsolated =
      event.operation.state !== 'failed' &&
      !event.operation.warnings.includes('first-listener-mutation')
  })
  const facadeRemember = await facadeOptionsMemory.remember(
    {
      id: 'browser-facade-options-episode',
      kind: 'assertion',
      content: { type: 'text', text: 'Facade options are invocation values.' },
      source: { kind: 'browser-facade-options', metadata: { owner: 'original' } },
    },
    { operationId: 'browser-facade-output-operation' },
  )
  const mutableFacadeEpisode = facadeRemember.episode as unknown as {
    content: { text: string }
    source: { metadata: { owner: string } }
  }
  mutableFacadeEpisode.content.text = 'Returned value mutation.'
  mutableFacadeEpisode.source.metadata.owner = 'returned-value-mutation'
  ;(facadeRemember.operation.warnings as string[]).push('returned-report-mutation')
  const facadeLiveSignal = new AbortController().signal
  let facadeManagementReads = 0
  const facadeManagementOptions = Object.defineProperty(
    { signal: facadeLiveSignal },
    'scanLimits',
    {
      enumerable: true,
      get: () => {
        facadeManagementReads += 1
        return facadeManagementReads === 1
          ? { maxRecords: 10_000, maxBytes: 16 * 1024 * 1024 }
          : { maxRecords: 0, maxBytes: 0 }
      },
    },
  )
  const facadeStatsPromise = facadeOptionsMemory.stats(facadeManagementOptions)
  Reflect.set(facadeManagementOptions, 'signal', AbortSignal.abort())
  const facadeStats = await facadeStatsPromise
  const facadePointOptions = { signal: facadeLiveSignal }
  const facadePointPromise = facadeOptionsMemory.getEpisode(
    'browser-facade-options-episode',
    { allowedScopes: [] },
    facadePointOptions,
  )
  facadePointOptions.signal = AbortSignal.abort()
  const facadePoint = await facadePointPromise
  const facadeOutputOperation = await facadeOptionsMemory.operation(
    'browser-facade-output-operation',
  )
  const facadeBaseline = await facadeOptionsMemory.snapshot({ access: { allowedScopes: [] } })
  const facadeRegistrationOptions = { signal: facadeLiveSignal }
  const facadeRegistrationPromise = facadeOptionsMemory.registerJournalConsumer(
    {
      id: 'browser-facade-options-consumer',
      journal: 'semantic',
      cursor: facadeBaseline.changesCursor,
    },
    facadeRegistrationOptions,
  )
  facadeRegistrationOptions.signal = AbortSignal.abort()
  const facadeConsumer = await facadeRegistrationPromise
  const facadeRetirementOptions = { signal: facadeLiveSignal }
  const facadeRetirementPromise = facadeOptionsMemory.retireJournalConsumer(
    { id: facadeConsumer.id, journal: 'semantic' },
    facadeRetirementOptions,
  )
  facadeRetirementOptions.signal = AbortSignal.abort()
  const facadeRetirement = await facadeRetirementPromise
  let facadeIntegrityReads = 0
  const facadeIntegrityOptions = Object.defineProperty({ signal: facadeLiveSignal }, 'limits', {
    enumerable: true,
    get: () => {
      facadeIntegrityReads += 1
      return facadeIntegrityReads === 1
        ? {
            maxRecords: 10_000,
            maxBytes: 16 * 1024 * 1024,
            maxGraphNodes: 10_000,
            maxGraphEdges: 10_000,
            maxIssues: 100,
          }
        : { maxRecords: 0 }
    },
  })
  const facadeIntegrityPromise = facadeOptionsMemory.verifyIntegrity(facadeIntegrityOptions)
  Reflect.set(facadeIntegrityOptions, 'signal', AbortSignal.abort())
  const facadeIntegrity = await facadeIntegrityPromise
  const facadeOptionsSnapshotted =
    facadeOpenInputSnapshotted &&
    facadeManagementReads === 1 &&
    facadeStats.episodes === 1 &&
    facadePoint?.id === 'browser-facade-options-episode' &&
    facadeConsumer.state === 'active' &&
    facadeRetirement.state === 'retired' &&
    facadeIntegrityReads === 1 &&
    facadeIntegrity.ok
  const publicOutputsDetached =
    facadeReopenedSpace.metadata?.owner === 'browser-original' &&
    (facadeReopenedSpace.metadata.nested as { state?: string } | undefined)?.state === 'ready' &&
    facadeListenerIsolated &&
    facadePoint?.content.type === 'text' &&
    facadePoint.content.text === 'Facade options are invocation values.' &&
    facadePoint.source.metadata?.owner === 'original' &&
    facadeOutputOperation !== null &&
    facadeOutputOperation.state === facadeListenerState &&
    JSON.stringify(facadeOutputOperation.warnings) === JSON.stringify(facadeListenerWarnings) &&
    !facadeOutputOperation.warnings.includes('returned-report-mutation')
  await facadeOptionsMemory.close()
  const integrityRevision = (await second.stats()).snapshotRevision
  const integrityLimitClosed = await second
    .verifyIntegrity({
      limits: {
        maxRecords: 1,
        maxBytes: 1024 * 1024,
        maxGraphNodes: 100,
        maxGraphEdges: 100,
        maxIssues: 10,
      },
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'integrity' &&
        error.details?.dimension === 'records' &&
        error.details?.required === 2 &&
        error.details?.maximum === 1,
    )
  const integrityLimitAtomic = (await second.stats()).snapshotRevision === integrityRevision
  const boundedIntegrity = await second.verifyIntegrity({
    limits: {
      maxRecords: 10_000,
      maxBytes: 16 * 1024 * 1024,
      maxGraphNodes: 10_000,
      maxGraphEdges: 10_000,
      maxIssues: 100,
    },
  })
  const integrityIndexedPlanning =
    integrityLimitClosed &&
    integrityLimitAtomic &&
    boundedIntegrity.ok &&
    boundedIntegrity.issues.length === 0 &&
    boundedIntegrity.work.records > 0 &&
    boundedIntegrity.work.records <= boundedIntegrity.work.limits.maxRecords &&
    boundedIntegrity.work.bytes > 0 &&
    boundedIntegrity.work.bytes <= boundedIntegrity.work.limits.maxBytes &&
    boundedIntegrity.work.graphNodes <= boundedIntegrity.work.limits.maxGraphNodes &&
    boundedIntegrity.work.graphEdges <= boundedIntegrity.work.limits.maxGraphEdges &&
    boundedIntegrity.work.issuesDetected === 0 &&
    !boundedIntegrity.work.issuesTruncated
  window.__temporalMemoryStage = 'change-compacted'
  window.__temporalMemoryStage = 'second-read'
  await peer.close()
  await second.close()
  window.__temporalMemoryStage = 'second-closed'
  const rawQueryClosed = await secondAdmin
    .rawQuery({
      query: 'RETURN true;',
      confirmNamespace: 'astrale',
      confirmDatabase: 'temporal_memory',
    })
    .then(
      () => false,
      (error: unknown) => MemoryError.is(error, 'not_open'),
    )
  const thirdStorage = createSurrealMemoryStorage({ endpoint, worker })
  const third = createMemory({ spaceId: 'browser-space', storage: thirdStorage })
  await third.open()
  const reopenedLegacy = createMemory({ spaceId: 'browser-legacy', storage: thirdStorage })
  await reopenedLegacy.open()
  const reopenedMigrationInspection = await reopenedLegacy.inspect()
  const schemaMigrationPersisted =
    migrationApplied &&
    reopenedMigrationInspection.space?.schemaVersion === '7' &&
    reopenedMigrationInspection.schemaMigrations.length === 2
  await reopenedLegacy.close()
  const compactedStats = await third.stats()
  const persistedSemanticConsumers = await third.journalConsumers({
    journal: 'semantic',
    state: 'all',
  })
  const persistedSignalConsumers = await third.journalConsumers({
    journal: 'signal',
    state: 'all',
  })
  const journalConsumersPersisted =
    registeredSemanticConsumer.state === 'active' &&
    registeredSignalConsumer.state === 'active' &&
    persistedSemanticConsumers.consumers.some(
      (consumer) =>
        consumer.id === registeredSemanticConsumer.id &&
        consumer.cursor === registeredSemanticConsumer.cursor,
    ) &&
    persistedSignalConsumers.consumers.some(
      (consumer) =>
        consumer.id === registeredSignalConsumer.id &&
        consumer.cursor === registeredSignalConsumer.cursor,
    )
  const afterCompaction = await third.changes({
    access: { allowedScopes: [] },
    cursor: compactionSnapshot.changesCursor,
  })
  const changeCompactionPersisted =
    compaction.deletedChanges > 0 &&
    compactedStats.changes === 0 &&
    compactedStats.changesCompactedThrough === compactionSnapshot.snapshotRevision &&
    afterCompaction.changes.length === 0 &&
    afterCompaction.changesCompactedThrough === compactionSnapshot.snapshotRevision
  const persistedSignals = await third.browseSignals({ access: { allowedScopes: [] } })
  const afterSignalCompaction = await third.signalChanges({
    access: { allowedScopes: [] },
    cursor: persistedSignals.signalChangesCursor,
  })
  const signalChangeCompactionPersisted =
    signalCompaction.deletedChanges === 5 &&
    compactedStats.signalChanges === 0 &&
    compactedStats.signalChangesCompactedThrough === signalCompactionBaseline.snapshotRevision &&
    afterSignalCompaction.changes.length === 0 &&
    afterSignalCompaction.signalChangesCompactedThrough ===
      signalCompactionBaseline.snapshotRevision
  const signalPersisted =
    persistedSignals.total === 1 &&
    persistedSignals.signals[0]?.namespace === 'browser.persistence' &&
    compactedStats.signals === 1 &&
    compactedStats.signalRevisions === 3
  const persistedDerivation = await third.getDerivation(derivation.derivation.id, {
    allowedScopes: [],
  })
  const persistedDerivedFact = await third.getFact('browser-derived', { allowedScopes: [] })
  const derivationPersisted =
    persistedDerivation?.state === 'active' &&
    persistedDerivation.rule.id === 'browser/rule' &&
    persistedDerivedFact?.derivations.some((item) => item.id === persistedDerivation.id) === true &&
    (await third.getFact('browser-batch-derived-one', { allowedScopes: [] }))?.derivations[0]
      ?.operationId === 'browser-derive-batch' &&
    (await third.getFact('browser-batch-derived-two', { allowedScopes: [] }))?.derivations[0]
      ?.operationId === 'browser-derive-batch'
  const derivationWithdrawalBatchPreview = await third.previewDerivationWithdrawals({
    where: { ruleIds: ['browser/batch-rule'], ruleVersions: ['1'] },
    access: { allowedScopes: [] },
    maxMatches: 2,
    workLimits: { maxRecords: 64 },
  })
  const derivationWithdrawalBatchRevision = derivationWithdrawalBatchPreview.snapshotRevision
  const derivationWithdrawalBatchInput = {
    where: { ruleIds: ['browser/batch-rule'], ruleVersions: ['1'] },
    access: { allowedScopes: [] },
    expectedRevision: derivationWithdrawalBatchRevision,
    maxMatches: 2,
    selectionCursor: derivationWithdrawalBatchPreview.selectionCursor,
    reason: 'Browser rule-set retirement.',
    workLimits: { maxRecords: 64 },
  }
  const derivationWithdrawalBatch = await third.withdrawDerivations(
    derivationWithdrawalBatchInput,
    { operationId: 'browser-withdraw-derivation-batch' },
  )
  const derivationWithdrawalBatchReplay = await third.withdrawDerivations(
    derivationWithdrawalBatchInput,
    { operationId: 'browser-withdraw-derivation-batch' },
  )
  const derivationWithdrawalBatchBeforeReopen =
    derivationWithdrawalBatchPreview.derivations.length === 2 &&
    typeof derivationWithdrawalBatchPreview.selectionCursor === 'string' &&
    (await third.stats()).snapshotRevision === derivationWithdrawalBatchRevision + 1 &&
    derivationWithdrawalBatch.withdrawals.length === 2 &&
    derivationWithdrawalBatch.withdrawals
      .map((withdrawal) => withdrawal.conclusionFactId)
      .sort()
      .join(',') === 'browser-batch-derived-one,browser-batch-derived-two' &&
    derivationWithdrawalBatch.unsupportedFacts.join(',') ===
      'browser-batch-derived-one,browser-batch-derived-two' &&
    derivationWithdrawalBatchReplay.operation.id === derivationWithdrawalBatch.operation.id &&
    derivationWithdrawalBatchReplay.withdrawals
      .map((withdrawal) => withdrawal.withdrawalId)
      .join(',') ===
      derivationWithdrawalBatch.withdrawals
        .map((withdrawal) => withdrawal.withdrawalId)
        .join(',') &&
    (await third.getFact('browser-batch-derived-one', { allowedScopes: [] })) === null &&
    (await third.getFact('browser-batch-derived-two', { allowedScopes: [] })) === null
  window.__temporalMemoryStage = 'sync-checkpoint'
  let syncCheckpointAccessReads = 0
  const syncCheckpointAccess = {} as { allowedScopes: string[] }
  Object.defineProperty(syncCheckpointAccess, 'allowedScopes', {
    enumerable: true,
    get: () => {
      syncCheckpointAccessReads += 1
      if (syncCheckpointAccessReads > 1) throw new Error('sync checkpoint access was read twice')
      return []
    },
  })
  const syncCheckpointRequest = {
    access: syncCheckpointAccess,
    confirmSpaceId: 'browser-space',
    maxChunkBytes: 64 * 1_024,
  }
  const syncCheckpointOptions = { operationId: 'browser-sync-checkpoint' }
  const syncCheckpointPromise = third.createSyncCheckpoint(
    syncCheckpointRequest,
    syncCheckpointOptions,
  )
  const syncCheckpointRequestCaptured = syncCheckpointAccessReads === 1
  syncCheckpointRequest.confirmSpaceId = 'mutated-browser-space'
  syncCheckpointRequest.maxChunkBytes = 1
  syncCheckpointOptions.operationId = 'mutated-browser-sync-checkpoint'
  const syncCheckpoint = await syncCheckpointPromise
  const replicaEndpoint =
    `indxdb://temporalmemoryreplica${crypto.randomUUID().replaceAll('-', '')}` as const
  const replicaStorage = createSurrealMemoryStorage({ endpoint: replicaEndpoint, worker })
  const replica = createMemory({ spaceId: 'browser-space', storage: replicaStorage })
  await replica.open({ create: true })
  let syncPullAccessReads = 0
  const syncPullAccess = {} as { allowedScopes: string[] }
  Object.defineProperty(syncPullAccess, 'allowedScopes', {
    enumerable: true,
    get: () => {
      syncPullAccessReads += 1
      if (syncPullAccessReads > 1) throw new Error('sync pull access was read twice')
      return []
    },
  })
  const syncPullRequest = {
    access: syncPullAccess,
    confirmSpaceId: 'browser-space',
    strategy: 'fast-forward-only' as const,
    maxAncestry: 10_000,
    receiveLimits: { maxBytes: 64 * 1_024 * 1_024, maxRecords: 10_000, maxChunks: 1_000 },
  }
  const syncPullOptions = { operationId: 'browser-sync-pull' }
  const syncPullPromise = replica.syncFrom(third, syncPullRequest, syncPullOptions)
  const syncPullRequestCaptured = syncPullAccessReads === 1
  syncPullRequest.confirmSpaceId = 'mutated-browser-space'
  syncPullRequest.maxAncestry = 0
  syncPullRequest.receiveLimits.maxRecords = 0
  syncPullOptions.operationId = 'mutated-browser-sync-pull'
  const syncReport = await syncPullPromise
  await replica.close()
  window.__temporalMemoryStage = 'sync-reopen'
  const reopenedReplicaStorage = createSurrealMemoryStorage({ endpoint: replicaEndpoint, worker })
  const reopenedReplica = createMemory({
    spaceId: 'browser-space',
    storage: reopenedReplicaStorage,
  })
  await reopenedReplica.open()
  let syncHeadAccessReads = 0
  const syncHeadAccess = {} as { allowedScopes: string[] }
  Object.defineProperty(syncHeadAccess, 'allowedScopes', {
    enumerable: true,
    get: () => {
      syncHeadAccessReads += 1
      if (syncHeadAccessReads > 1) throw new Error('sync head access was read twice')
      return []
    },
  })
  const replicaHeadPromise = reopenedReplica.syncHead(syncHeadAccess)
  const syncHeadRequestCaptured = syncHeadAccessReads === 1
  const replicaHead = await replicaHeadPromise
  const replicaEpisode = await reopenedReplica.getEpisode('episode-1', { allowedScopes: [] })
  const replicaDerivation = await reopenedReplica.getDerivation(derivation.derivation.id, {
    allowedScopes: [],
  })
  const replicaSignals = await reopenedReplica.browseSignals({
    access: { allowedScopes: [] },
    revisionView: 'history',
  })
  const replicaIntegrity = await reopenedReplica.verifyIntegrity()
  const replicaPurgeReplayBlocked = await reopenedReplica
    .remember({
      id: 'episode-injection-replica-replay',
      idempotencyKey: 'episode-injection',
      kind: 'assertion',
      content: { type: 'text', text: injected },
      source: { kind: 'browser-test' },
    })
    .then(
      () => false,
      (error: unknown) => MemoryError.is(error, 'idempotency_conflict'),
    )
  const syncRoundTripPersisted =
    syncReport.state === 'succeeded' &&
    syncReport.diagnosticsTruncated === false &&
    syncReport.error === undefined &&
    syncReport.receivedChunks === syncCheckpoint.chunkCount &&
    syncReport.checkpoint?.id === syncCheckpoint.id &&
    replicaHead.id === syncCheckpoint.id &&
    replicaEpisode?.content.type === 'text' &&
    replicaEpisode.content.text === 'Ada created the analytical engine.' &&
    replicaDerivation?.state === 'active' &&
    replicaSignals.total === 3 &&
    replicaIntegrity.ok &&
    replicaPurgeReplayBlocked
  await reopenedReplica.close()
  window.__temporalMemoryStage = 'sync-compaction'
  await third.remember({
    id: 'sync-compaction-sentinel',
    kind: 'text',
    content: { type: 'text', text: 'A newer checkpoint keeps the current HEAD payload.' },
    source: { kind: 'browser-test' },
  })
  const compactedHead = await third.createSyncCheckpoint(
    {
      access: { allowedScopes: [] },
      confirmSpaceId: 'browser-space',
      maxChunkBytes: 64 * 1_024,
    },
    { operationId: 'browser-sync-compacted-head' },
  )
  const syncCompactionSnapshot = await third.snapshot({ access: { allowedScopes: [] } })
  const syncCompactionRequest = {
    access: { allowedScopes: [] as string[] },
    confirmSpaceId: 'browser-space',
    expectedRevision: syncCompactionSnapshot.snapshotRevision,
    expectedHead: compactedHead.id,
    before: new Date(Date.now() + 60_000).toISOString(),
    maxCheckpoints: 64,
  }
  const syncCompactionPromise = third.compactSyncHistory(syncCompactionRequest)
  syncCompactionRequest.access.allowedScopes.push('mutated-scope')
  syncCompactionRequest.confirmSpaceId = 'mutated-browser-space'
  syncCompactionRequest.maxCheckpoints = 0
  const syncCompaction = await syncCompactionPromise
  const compactedPayloadUnavailable = await third
    .syncChunks({ access: { allowedScopes: [] }, checkpointId: syncCheckpoint.id })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'not_found') && error.details?.requiresReseed === true,
    )
  const syncInventoryRequest = { access: { allowedScopes: [] as string[] }, limit: 100 }
  const syncInventoryPromise = third.syncHistory(syncInventoryRequest)
  syncInventoryRequest.access.allowedScopes.push('mutated-scope')
  syncInventoryRequest.limit = 0
  const syncInventory = await syncInventoryPromise
  let bundleCursor: string | undefined
  let bundleCheckpointFrames = 0
  let bundleChunkFrames = 0
  let bundleCommit = false
  const bundleFrames: SyncBundleFrame[] = []
  do {
    const bundlePage = await third.exportSyncBundle({
      access: { allowedScopes: [] },
      confirmSpaceId: 'browser-space',
      checkpointId: compactedHead.id,
      cursor: bundleCursor,
      maxCheckpoints: 64,
      limit: 2,
      maxBytes: 128 * 1_024,
    })
    bundleCheckpointFrames += bundlePage.frames.filter(
      (frame) => frame.type === 'checkpoint',
    ).length
    bundleChunkFrames += bundlePage.frames.filter((frame) => frame.type === 'chunk').length
    bundleCommit ||= bundlePage.frames.some(
      (frame) =>
        frame.type === 'commit' &&
        frame.checkpointId === compactedHead.id &&
        frame.chunkCount === compactedHead.chunkCount,
    )
    bundleFrames.push(...bundlePage.frames)
    bundleCursor = bundlePage.nextCursor
  } while (bundleCursor !== undefined)
  const bundlePeer = await openSyncBundle(
    {
      readCommit: async () => bundleFrames.find((frame) => frame.type === 'commit') ?? null,
      readCheckpoint: async (index) =>
        bundleFrames.find(
          (frame): frame is SyncBundleCheckpointFrame =>
            frame.type === 'checkpoint' && frame.index === index,
        ) ?? null,
      readChunk: async (index) =>
        bundleFrames.find(
          (frame): frame is SyncBundleChunkFrame =>
            frame.type === 'chunk' && frame.chunk.index === index,
        ) ?? null,
    },
    { maxCheckpoints: 64, maxCheckpointBytes: 128 * 1_024 },
  )
  const bundlePeerHead = await bundlePeer.syncHead({ allowedScopes: [] })
  const syncBundleExported =
    bundleCheckpointFrames >= 2 &&
    bundleChunkFrames === compactedHead.chunkCount &&
    bundleCommit &&
    bundlePeerHead.id === compactedHead.id
  const sessionCompactionRequest = {
    access: { allowedScopes: [] as string[] },
    confirmSpaceId: 'browser-space',
    expectedRevision: syncCompactionSnapshot.snapshotRevision,
    expectedHead: compactedHead.id,
    before: new Date(Date.now() + 60_000).toISOString(),
    maxSessions: 64,
  }
  const sessionCompactionPromise = third.compactSyncSessions(sessionCompactionRequest)
  sessionCompactionRequest.access.allowedScopes.push('mutated-scope')
  sessionCompactionRequest.confirmSpaceId = 'mutated-browser-space'
  sessionCompactionRequest.maxSessions = 0
  const sessionCompaction = await sessionCompactionPromise
  const sessionInventory = await third.syncSessions({
    access: { allowedScopes: [] },
    limit: 100,
  })
  const compactedHeadPayload = await third.syncChunks({
    access: { allowedScopes: [] },
    checkpointId: compactedHead.id,
  })
  const syncUnknownFieldRejected = await third
    .syncHistory({ access: { allowedScopes: [] }, unexpected: true } as never)
    .then(
      () => false,
      (error: unknown) => MemoryError.is(error, 'invalid_input'),
    )
  const syncRequestsSnapshotted =
    syncCheckpointRequestCaptured &&
    syncPullRequestCaptured &&
    syncHeadRequestCaptured &&
    syncReport.operation?.id === 'browser-sync-pull' &&
    syncUnknownFieldRejected
  await third.close()
  const compactedSourceStorage = createSurrealMemoryStorage({ endpoint, worker })
  const compactedSource = createMemory({
    spaceId: 'browser-space',
    storage: compactedSourceStorage,
  })
  await compactedSource.open()
  const persistedCompactedHeader = await compactedSource.syncCheckpoint(syncCheckpoint.id, {
    allowedScopes: [],
  })
  const persistedCompactedHead = await compactedSource.syncHead({ allowedScopes: [] })
  const persistedSyncInventory = await compactedSource.syncHistory({
    access: { allowedScopes: [] },
    limit: 100,
  })
  const persistedSessionInventory = await compactedSource.syncSessions({
    access: { allowedScopes: [] },
    limit: 100,
  })
  const persistedDerivationWithdrawals = await Promise.all(
    derivationWithdrawalBatch.withdrawals.map((withdrawal) =>
      compactedSource.getDerivation(withdrawal.withdrawalId, { allowedScopes: [] }),
    ),
  )
  const derivationWithdrawalBatchAtomic =
    derivationWithdrawalBatchBeforeReopen &&
    persistedDerivationWithdrawals.every(
      (withdrawal) =>
        withdrawal?.state === 'withdrawn' &&
        withdrawal.operationId === 'browser-withdraw-derivation-batch',
    ) &&
    (await compactedSource.getFact('browser-batch-derived-one', { allowedScopes: [] })) === null &&
    (await compactedSource.getFact('browser-batch-derived-two', { allowedScopes: [] })) === null
  const persistedPayloadUnavailable = await compactedSource
    .syncChunks({ access: { allowedScopes: [] }, checkpointId: syncCheckpoint.id })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'not_found') && error.details?.requiresReseed === true,
    )
  const syncCompactionPersisted =
    syncCompaction.compactedCheckpoints === 1 &&
    syncCompaction.selected[0]?.checkpointId === syncCheckpoint.id &&
    syncCompaction.reclaimedBytes === syncCheckpoint.byteLength &&
    compactedPayloadUnavailable &&
    persistedCompactedHeader?.id === syncCheckpoint.id &&
    persistedCompactedHead.id === compactedHead.id &&
    persistedPayloadUnavailable
  const syncInventoryPersisted =
    syncInventory.checkpoints.find((item) => item.checkpoint.id === syncCheckpoint.id)
      ?.payloadState === 'pruned' &&
    syncInventory.checkpoints.find((item) => item.checkpoint.id === compactedHead.id)?.isHead ===
      true &&
    persistedSyncInventory.checkpoints.find((item) => item.checkpoint.id === syncCheckpoint.id)
      ?.payloadState === 'pruned' &&
    persistedSyncInventory.head.id === compactedHead.id &&
    sessionCompaction.compactedSessions > 0 &&
    sessionInventory.sessions.every((session) => session.detailsState === 'pruned') &&
    persistedSessionInventory.sessions.every((session) => session.detailsState === 'pruned') &&
    compactedHeadPayload.checkpoint.id === compactedHead.id &&
    compactedHeadPayload.chunks.length > 0

  const transactionDriver = storageDriver(compactedSourceStorage)
  const transactionSpaceBefore = await transactionDriver.getSpace('browser-space')
  const [projectionTemplate] = await transactionDriver.query({
    kind: 'projection',
    spaceId: 'browser-space',
    limit: 1,
  })
  if (transactionSpaceBefore === null || projectionTemplate === undefined) {
    throw new Error('transaction rollback probe requires an open space and projection template')
  }
  const validProbeId = 'browser-transaction-valid-projection'
  const invalidProbeId = 'browser-transaction-invalid-projection'
  const validProbe = { ...projectionTemplate, id: validProbeId }
  const invalidProbe = {
    ...projectionTemplate,
    id: invalidProbeId,
    setId: 42 as unknown as string,
  }
  const failedWithStorageError = await transactionDriver
    .commit({
      spaceId: 'browser-space',
      expectedRevision: transactionSpaceBefore.revision,
      expectedCanonicalRevision: transactionSpaceBefore.canonicalRevision ?? 0,
      puts: [validProbe, invalidProbe],
    })
    .then(
      () => false,
      (error: unknown) =>
        MemoryError.is(error, 'storage_failed') &&
        error.retryable &&
        error.details?.transactionOutcome === 'rolled_back' &&
        error.details?.requiresReopen === undefined,
    )
  const transactionSpaceAfterFailure = await transactionDriver.getSpace('browser-space')
  const failedRowsRolledBack =
    (await transactionDriver.get('projection', 'browser-space', validProbeId)) === null &&
    (await transactionDriver.get('projection', 'browser-space', invalidProbeId)) === null
  const reusedRevision = await transactionDriver.commit({
    spaceId: 'browser-space',
    expectedRevision: transactionSpaceBefore.revision,
    expectedCanonicalRevision: transactionSpaceBefore.canonicalRevision ?? 0,
    puts: [validProbe],
  })
  const transactionSpaceAfterReuse = await transactionDriver.getSpace('browser-space')
  const reusedRow = await transactionDriver.get('projection', 'browser-space', validProbeId)
  const cleanupRevision = await transactionDriver.commit({
    spaceId: 'browser-space',
    expectedRevision: reusedRevision,
    expectedCanonicalRevision: transactionSpaceBefore.canonicalRevision ?? 0,
    deletes: [{ kind: 'projection', id: validProbeId }],
  })
  const transactionSpaceAfterCleanup = await transactionDriver.getSpace('browser-space')
  const transactionRollbackReusable =
    failedWithStorageError &&
    failedRowsRolledBack &&
    transactionSpaceAfterFailure?.revision === transactionSpaceBefore.revision &&
    (transactionSpaceAfterFailure?.metadataRevision ?? 0) ===
      (transactionSpaceBefore.metadataRevision ?? 0) &&
    (transactionSpaceAfterFailure?.canonicalRevision ?? 0) ===
      (transactionSpaceBefore.canonicalRevision ?? 0) &&
    reusedRevision === transactionSpaceBefore.revision + 1 &&
    reusedRow?.id === validProbeId &&
    transactionSpaceAfterReuse?.revision === reusedRevision &&
    (transactionSpaceAfterReuse?.metadataRevision ?? 0) ===
      (transactionSpaceBefore.metadataRevision ?? 0) + 1 &&
    (transactionSpaceAfterReuse?.canonicalRevision ?? 0) ===
      (transactionSpaceBefore.canonicalRevision ?? 0) &&
    cleanupRevision === reusedRevision + 1 &&
    transactionSpaceAfterCleanup?.revision === cleanupRevision &&
    (transactionSpaceAfterCleanup?.metadataRevision ?? 0) ===
      (transactionSpaceBefore.metadataRevision ?? 0) + 2 &&
    (transactionSpaceAfterCleanup?.canonicalRevision ?? 0) ===
      (transactionSpaceBefore.canonicalRevision ?? 0) &&
    (await transactionDriver.get('projection', 'browser-space', validProbeId)) === null &&
    (await transactionDriver.get('projection', 'browser-space', invalidProbeId)) === null
  await compactedSource.close()
  window.__temporalMemoryStage = 'third-closed'
  if (
    episode?.content.type !== 'text' ||
    episode.content.text !== 'Ada created the analytical engine.'
  ) {
    throw new Error('episode did not survive a fresh IndexedDB connection')
  }
  if (fact?.predicate !== 'created')
    throw new Error('fact did not survive a fresh IndexedDB connection')
  window.__temporalMemoryResult = {
    ok: true,
    stats: { episodes: stats.episodes, entities: stats.entities, facts: stats.facts },
    factStatus: fact.status,
    recallFacts: recalled.facts.map((item) => item.id),
    recallLineage:
      Number.isInteger(recalled.snapshotRevision) &&
      typeof recalled.generatedAt === 'string' &&
      recalled.generatedAt.endsWith('Z'),
    episodeStoragePaging:
      firstEpisodePage.items[0]?.id === 'episode-1' &&
      secondEpisodePage.items[0]?.id === 'episode-injection' &&
      secondEpisodePage.generatedAt === firstEpisodePage.generatedAt &&
      [newestEpisodePage.items[0]?.id, olderEpisodePage.items[0]?.id].sort().join(',') ===
        'episode-1,episode-injection' &&
      [oldestEpisodePage.items[0]?.id, laterEpisodePage.items[0]?.id].sort().join(',') ===
        'episode-1,episode-injection',
    unicodeOrderPaging:
      firstUnicodePage.items[0]?.id === 'unicode-z' &&
      secondUnicodePage.items[0]?.id === 'unicode-á',
    injectionPreserved:
      injectedEpisode?.content.type === 'text' && injectedEpisode.content.text === injected,
    injectionRecall: injectionRecall.entities.some((item) => item.id === 'injected-entity'),
    concurrentReads: concurrent.every((item) => item.episodes === 2),
    rawQuerySeparated,
    rawQueryTargetGuard,
    rawQueryParameterized,
    rawQueryBounded,
    rawQueryStatementFailure,
    rawQueryRequestSnapshotted,
    rawQueryUnknownSharedFence,
    transactionUnknownSharedFence,
    connectionCleanupReusable,
    transactionRollbackReusable,
    rawQueryClosed,
    ingestionIndexedPlanning,
    ingestionContextScanBounded,
    ingestionProjectionScanBounded,
    pointReadScanBounded,
    managementScanBounded,
    resetScanBounded,
    derivationPersisted,
    derivationBatchAtomic,
    derivationWithdrawalBatchAtomic,
    derivationIndexedPlanning,
    correctionIndexedPlanning,
    retractionIndexedPlanning,
    episodeDeletionIndexedPlanning,
    episodeDeletionPreviewBound,
    hardPurgeIndexedPlanning,
    entityMergeIndexedPlanning,
    purgeReplayBlocked,
    purgeProjectionClosure,
    purgeRequestBound,
    operationPurgeScrubbed,
    activeMergeIndex,
    schemaMigrationPersisted,
    projectionSetCutover,
    projectionSensitivityPersisted,
    projectionScanBounded,
    changeFeedPersisted,
    changePurgeInvalidated,
    changePurgeScrubbed,
    changeCompactionPersisted,
    changeCompactionInvalidated,
    journalConsumersPersisted,
    constructionOptionsSnapshotted,
    facadeOptionsSnapshotted,
    publicOutputsDetached,
    signalRequestSnapshotted,
    coreReadRequestsSnapshotted,
    mutationRequestsSnapshotted,
    signalBasisScanBounded,
    signalPersisted,
    signalSoftDeleteAtomic,
    signalPurgeClosed,
    signalKeyPurgeAtomic,
    signalDiagnostics,
    retrievalScanBounded,
    analysisScanBounded,
    snapshotScanBounded,
    integrityIndexedPlanning,
    signalChangeFeedPersisted,
    signalChangePurgeScrubbed,
    signalChangeCompactionPersisted,
    signalChangeCompactionInvalidated,
    boundedCanonicalArchive,
    syncRequestsSnapshotted,
    syncRoundTripPersisted,
    syncCompactionPersisted,
    syncInventoryPersisted,
    syncBundleExported,
  }
}

void run().catch((error: unknown) => {
  window.__temporalMemoryResult = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof Error && error.stack !== undefined ? { stack: error.stack } : {}),
  }
})
