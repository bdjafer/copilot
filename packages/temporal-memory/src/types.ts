import type { MemoryError } from './errors.ts'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | { readonly [key: string]: JsonValue } | readonly JsonValue[]
export type Awaitable<T> = T | Promise<T>
export type Unsubscribe = () => void

export type EpisodeKind =
  | 'text'
  | 'message'
  | 'structured'
  | 'assertion'
  | 'correction'
  | 'retraction'
  | 'event'
export type FactStatus = 'active' | 'superseded' | 'disputed' | 'retracted' | 'deleted'
export type EvidenceRelation = 'supports' | 'contradicts' | 'corrects' | 'mentions'
export type EvidenceStatus = 'active' | 'withdrawn'
export type DerivationState = 'active' | 'invalidated' | 'withdrawn'
export type OperationKind =
  | 'ingest'
  | 'reprocess'
  | 'correct'
  | 'retract'
  | 'delete'
  | 'purge'
  | 'export'
  | 'import'
  | 'migrate'
  | 'rebuild'
  | 'merge'
  | 'split'
  | 'derive'
  | 'sync'
export type OperationState =
  | 'pending'
  | 'running'
  | 'partial'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export interface TimeInterval {
  from?: string
  to?: string
}

/**
 * A stable selector into immutable episode content.
 *
 * Text offsets are JavaScript UTF-16 code-unit boundaries and MUST NOT split a surrogate pair.
 * JSON pointers address the `value` of `structured` and `event` content using RFC 6901 syntax.
 */
export type EpisodeAnchor =
  | { kind: 'text'; unit: 'utf16-code-unit'; start: number; end: number }
  | { kind: 'json-pointer'; pointer: string }

/** A provider- or host-supplied citation that must resolve against the accepted episode. */
export interface EpisodeEvidenceInput {
  anchor?: EpisodeAnchor
  /** Exact source text. When no anchor is supplied, it must occur exactly once in text content. */
  excerpt?: string
}

export interface EntityMentionInput {
  text: string
  /** Required when `text` does not occur exactly once in the episode content. */
  anchor?: EpisodeAnchor
}

export interface AccessContext {
  allowedScopes: readonly string[]
}

export interface SourceReference {
  kind: string
  origin?: string
  url?: string
  title?: string
  externalId?: string
  author?: string
  threadId?: string
  documentId?: string
  capturedAt?: string
  metadata?: Readonly<Record<string, JsonValue>>
}

export type EpisodeContent =
  | { type: 'text'; text: string }
  | { type: 'message'; role: 'user' | 'assistant' | 'system' | 'tool'; text: string }
  | { type: 'structured'; value: JsonValue }
  | { type: 'event'; name: string; value: JsonValue }

export interface Episode {
  id: string
  spaceId: string
  idempotencyKey: string
  kind: EpisodeKind
  content: EpisodeContent
  source: SourceReference
  scopes: readonly string[]
  sensitivity?: string
  retention?: string
  tags: readonly string[]
  metadata: Readonly<Record<string, JsonValue>>
  validTime?: TimeInterval
  observedAt?: string
  receivedAt: string
  contentHash: string
  retentionState: 'retained' | 'deleted' | 'purged'
}

export interface EntityAlias {
  value: string
  normalized: string
  types: readonly string[]
  identifiers: Readonly<Record<string, string>>
  scopes: readonly string[]
  episodeIds: readonly string[]
  recordedAt: string
}

export interface Entity {
  id: string
  spaceId: string
  types: readonly string[]
  name: string
  aliases: readonly EntityAlias[]
  identifiers: Readonly<Record<string, string>>
  createdAt: string
  updatedAt: string
  mergedInto?: string
}

export type FactObject = { kind: 'entity'; entityId: string } | { kind: 'scalar'; value: JsonValue }

export interface ProviderLineage {
  capability: 'inference' | 'embedding' | 'rerank'
  provider: string
  model: string
  version?: string
  destination: 'local' | 'remote'
  dimensions?: number
}

export interface DerivationLineage {
  operationId: string
  method: 'host' | 'deterministic' | 'model' | 'import'
  provider?: ProviderLineage
  /** Rule that first created the fact. Additional supports live in `FactView.derivations`. */
  rule?: RuleIdentity
  ontology: { id: string; version: string }
  schemaVersion: string
}

export interface RuleIdentity {
  id: string
  version: string
}

export type DerivationPremise = { kind: 'fact'; id: string } | { kind: 'evidence'; id: string }

/**
 * Immutable revision of one logical rule support. Only the latest revision for a key is current.
 * A derivation is canonical support, but it is never source evidence or an authority score.
 */
export interface Derivation {
  id: string
  spaceId: string
  /** Stable digest of rule, conclusion semantic identity, premise set, and scope partition. */
  key: string
  version: number
  conclusionFactId: string
  rule: RuleIdentity
  premises: readonly DerivationPremise[]
  method: 'host' | 'deterministic' | 'model'
  provider?: ProviderLineage
  scopes: readonly string[]
  inputRevision: number
  recordedRevision: number
  recordedAt: string
  operationId: string
  supersedes?: string
  state: DerivationState
  invalidPremises?: readonly DerivationPremise[]
  reason?: string
}

export interface Fact {
  id: string
  spaceId: string
  subjectId: string
  predicate: string
  object: FactObject
  type?: string
  validTime?: TimeInterval
  recordedAt: string
  status: FactStatus
  supersededBy?: string
  conflictGroup?: string
  retractedAt?: string
  deletedAt?: string
  lineage: DerivationLineage
}

export interface EvidenceLink {
  id: string
  spaceId: string
  episodeId: string
  target: { kind: 'entity' | 'fact'; id: string }
  relation: EvidenceRelation
  status: EvidenceStatus
  scopes: readonly string[]
  /** Exact location in the immutable normalized episode; absent only on legacy imports. */
  anchor?: EpisodeAnchor
  excerpt?: string
  excerptTruncated?: true
  createdAt: string
  withdrawnAt?: string
  operationId: string
}

export interface Mention {
  id: string
  spaceId: string
  episodeId: string
  entityId?: string
  candidateId?: string
  text: string
  /** Exact source occurrence; absent only when no literal occurrence was asserted or on legacy imports. */
  anchor?: EpisodeAnchor
  scopes: readonly string[]
  operationId: string
}

export interface RememberInput {
  id?: string
  idempotencyKey?: string
  kind: EpisodeKind
  content: EpisodeContent
  source: SourceReference
  scopes?: readonly string[]
  sensitivity?: string
  retention?: string
  tags?: readonly string[]
  metadata?: Readonly<Record<string, JsonValue>>
  validTime?: TimeInterval
  observedAt?: string
  assertions?: ExplicitAssertionSet
}

export interface EntityReference {
  id?: string
  name?: string
  type?: string
  identifiers?: Readonly<Record<string, string>>
}

export interface ExplicitEntityInput extends EntityReference {
  name: string
  aliases?: readonly string[]
  types?: readonly string[]
  mention?: EntityMentionInput
  evidence?: EpisodeEvidenceInput
}

export interface ExplicitFactInput {
  id?: string
  subject: EntityReference
  predicate: string
  object: EntityReference | { scalar: JsonValue }
  type?: string
  validTime?: TimeInterval
  evidence?: EpisodeEvidenceInput
}

export interface ExplicitAssertionSet {
  entities?: readonly ExplicitEntityInput[]
  facts?: readonly ExplicitFactInput[]
}

/** A rule conclusion over existing canonical entities; derivation never creates identities. */
export interface DerivedFactInput {
  id?: string
  subjectId: string
  predicate: string
  object: FactObject
  type?: string
  validTime?: TimeInterval
}

export interface DerivationWorkLimits {
  /** Distinct stored rows admitted for visibility, cycle/support, and projection planning. */
  maxRecords?: number
  /** Stable UTF-8 JSON bytes of those distinct stored rows. */
  maxBytes?: number
  /** Distinct fact nodes visited by positive dependency traversal. */
  maxGraphNodes?: number
  /** Current premise-to-conclusion edges examined. */
  maxGraphEdges?: number
}

export interface DerivationWork {
  records: number
  bytes: number
  graphNodes: number
  graphEdges: number
  limits: Required<DerivationWorkLimits>
}

/** One maintained positive conclusion evaluated by a downstream reasoner. */
export interface DerivationInput {
  conclusion: DerivedFactInput
  rule: RuleIdentity
  premises: readonly DerivationPremise[]
  method?: 'host' | 'deterministic' | 'model'
  provider?: ProviderLineage
}

export interface DeriveFactInput extends DerivationInput {
  access: AccessContext
  /** Exact canonical revision used to evaluate every premise and the conclusion. */
  expectedRevision: number
  /** Fail-closed admission ceilings for indexed cycle and truth-maintenance planning. */
  workLimits?: DerivationWorkLimits
}

export interface DeriveFactsInput {
  /** One to 64 independent conclusions evaluated against the same pre-batch revision. */
  derivations: readonly DerivationInput[]
  access: AccessContext
  /** Exact canonical revision used to evaluate every premise and conclusion. */
  expectedRevision: number
  /** Aggregate fail-closed admission ceilings for the complete atomic plan. */
  workLimits?: DerivationWorkLimits
}

export interface WithdrawDerivationInput {
  derivationId: string
  access: AccessContext
  expectedRevision: number
  reason?: string
  /** Fail-closed admission ceilings for indexed truth-maintenance planning. */
  workLimits?: DerivationWorkLimits
}

/** Intersecting selector over globally current active derivation revisions. */
export interface DerivationFilter {
  ids?: readonly string[]
  ruleIds?: readonly string[]
  ruleVersions?: readonly string[]
  conclusionFactIds?: readonly string[]
  recordedAt?: InstantFilter
}

export interface PreviewDerivationWithdrawalsInput {
  /** Must contain at least one constraint; unconstrained whole-rule-plane previews are rejected. */
  where: DerivationFilter
  access: AccessContext
  /** Optional guard when the preview must share an already evaluated canonical revision. */
  expectedRevision?: number
  /** Fails closed if the complete current support selection is broader; accepts 1 through 1,000. */
  maxMatches: number
  /** Aggregate fail-closed admission ceilings for indexed selection. */
  workLimits?: DerivationWorkLimits
}

export interface WithdrawDerivationsInput {
  /** Must contain at least one constraint; an unconstrained all-rules withdrawal is rejected. */
  where: DerivationFilter
  access: AccessContext
  /** Exact canonical revision against which selection and support were previewed. */
  expectedRevision: number
  /** Fails closed if the selected current support count is broader; accepts 1 through 1,000. */
  maxMatches: number
  /** Optional consistency token returned by `previewDerivationWithdrawals` for this exact set. */
  selectionCursor?: string
  reason?: string
  /** Aggregate fail-closed admission ceilings for selection and truth-maintenance planning. */
  workLimits?: DerivationWorkLimits
}

export interface EntityTypeDefinition {
  description?: string
  identifiers?: readonly string[]
}

export interface FactTypeDefinition {
  predicate: string
  description?: string
  subjectTypes?: readonly string[]
  object?: { kind: 'entity'; types?: readonly string[] } | { kind: 'scalar'; valueType?: string }
  cardinality?: 'one' | 'many'
  temporal?: 'point' | 'interval' | 'either'
  severity?: 'reject' | 'warn'
}

export interface Ontology {
  id: string
  version: string
  mode: 'open' | 'prescribed' | 'hybrid'
  entityTypes: Readonly<Record<string, EntityTypeDefinition>>
  factTypes: Readonly<Record<string, FactTypeDefinition>>
  unknownEntityType?: string
  unknownFactType?: string
}

export interface CandidateEntity extends ExplicitEntityInput {
  candidateId: string
}

export interface CandidateFact extends ExplicitFactInput {
  candidateId: string
}

export interface InferenceRequest {
  episode: Episode
  ontology: Ontology
  context: {
    entities: readonly Entity[]
    facts: readonly Fact[]
  }
}

export interface InferenceResult {
  entities: readonly CandidateEntity[]
  facts: readonly CandidateFact[]
  warnings?: readonly string[]
}

export interface StructuredInferenceProvider {
  readonly lineage: Omit<ProviderLineage, 'capability' | 'dimensions'>
  infer(request: InferenceRequest, options: { signal: AbortSignal }): Promise<InferenceResult>
}

export interface EmbeddingProvider {
  readonly lineage: Omit<ProviderLineage, 'capability'> & { dimensions: number }
  embed(
    request: { purpose: 'index' | 'query'; texts: readonly string[] },
    options: { signal: AbortSignal },
  ): Promise<readonly (readonly number[])[]>
}

export interface RerankProvider {
  readonly lineage: Omit<ProviderLineage, 'capability' | 'dimensions'>
  rerank(
    request: { query: string; documents: readonly { id: string; text: string }[] },
    options: { signal: AbortSignal },
  ): Promise<readonly { id: string; score: number }[]>
}

export interface DisclosureRequest {
  id: string
  spaceId: string
  operationId: string
  capability: 'inference' | 'embedding' | 'rerank'
  provider: ProviderLineage
  /** Sorted unique opaque classifications from every retained source dependency in the payload. */
  sensitivities: readonly string[]
  scopes: readonly string[]
  fields: readonly string[]
  payload: JsonValue
}

export type DisclosureDecision =
  | { action: 'allow'; payload?: JsonValue }
  | { action: 'deny'; reason: string }

export interface MemoryPolicy {
  authorizeDisclosure(request: DisclosureRequest): Awaitable<DisclosureDecision>
}

export interface DisclosureLimits {
  /** Exact stable-JSON UTF-8 payload bytes. Defaults to 1 MiB; maximum 16 MiB. */
  maxBytes?: number
  /** Provider-input tokens. Defaults to 262,144; maximum 4,000,000. */
  maxTokens?: number
  /**
   * Optional synchronous provider-aware counter, including prompt/template overhead as needed.
   * Without one, UTF-8 payload bytes are used as a conservative token upper bound.
   */
  countTokens?: (request: DisclosureRequest) => number
}

export interface IngestionProfile {
  candidateLimit?: number
  contextLimit?: number
  /** Default physical row/byte ceilings for provider inference-context assembly. */
  contextScanLimits?: ArchiveLimits
  /** Default physical row/byte ceilings for automatic post-canonical projection assembly. */
  projectionScanLimits?: ArchiveLimits
  projectionBatchSize?: number
  /** Default fail-closed ceilings for indexed identity, reconciliation, and truth maintenance. */
  workLimits?: DerivationWorkLimits
}

export interface RetrievalProfile {
  candidateLimit?: number
  rrfConstant?: number
  weights?: Partial<Record<RetrievalChannel, number>>
}

export interface StorageInspection {
  name: string
  open: boolean
  persistent: boolean
  engine?: string
  endpoint?: string
  schemaVersion?: string
}

declare const memoryStorageBrand: unique symbol

/** Opaque storage capability created by the package's storage factories. */
export interface MemoryStorage {
  readonly name?: string
  readonly [memoryStorageBrand]: never
}

export interface MemoryOptions {
  spaceId: string
  storage: MemoryStorage
  ontology?: Ontology
  inference?: StructuredInferenceProvider
  embeddings?: EmbeddingProvider
  reranker?: RerankProvider
  policy?: MemoryPolicy
  disclosureLimits?: DisclosureLimits
  ingestion?: IngestionProfile
  retrieval?: RetrievalProfile
  /**
   * Wall-clock budget for provider-capable ingestion, retrieval, correction, and projection
   * rebuild operations. Provider and disclosure-policy waits are hard-raced against it; storage
   * and sync-peer waits are checked only cooperatively because detaching a possibly committing
   * write would be unsafe.
   */
  operationTimeoutMs?: number
  now?: () => Date
  createId?: () => string
  onError?: (error: MemoryError, scope: ErrorScope) => void
}

export interface SpaceInfo {
  id: string
  createdAt: string
  updatedAt: string
  schemaVersion: string
  ontology: { id: string; version: string }
  metadata: Readonly<Record<string, JsonValue>>
}

/** Immutable audit checkpoint for one successfully committed canonical-schema transition. */
export interface SchemaMigration {
  id: string
  sequence: number
  fromSchemaVersion: string
  toSchemaVersion: string
  checksum: string
  state: 'succeeded'
  appliedAt: string
}

export interface OpenOptions {
  create?: boolean
  metadata?: Readonly<Record<string, JsonValue>>
  /** Explicitly apply the package's ordered, additive, checksummed migration path. */
  migrate?: boolean
  /** Checked between migration steps and before recovery begins. */
  signal?: AbortSignal
}

export interface MemoryInspection {
  state: 'closed' | 'ready' | 'degraded' | 'maintenance'
  space: SpaceInfo | null
  storage: StorageInspection
  providers: {
    inference: boolean
    embeddings: boolean
    reranker: boolean
  }
  pendingOperations: number
  staleProjections: number
  activeProjectionSets: readonly ProjectionSetStatus[]
  schemaMigrations: readonly SchemaMigration[]
  /** Exact projection rows transferred while assembling this inspection. */
  scan: PhysicalScanWork
}

export interface OperationOptions {
  signal?: AbortSignal
  /**
   * Create-once durable identity, not a universal retry token. A method may reuse it only when
   * that method explicitly defines request-bound replay or resumable-session semantics; otherwise
   * every retry must use a fresh id and reuse fails with `idempotency_conflict`.
   */
  operationId?: string
}

export interface IngestionOptions extends OperationOptions {
  /** Per-operation override for provider inference-context scan work. */
  contextScanLimits?: ArchiveLimits
  /** Per-operation override for automatic post-canonical projection scan work. */
  projectionScanLimits?: ArchiveLimits
  /** Per-operation override for indexed identity, reconciliation, and truth-maintenance work. */
  workLimits?: DerivationWorkLimits
}

export interface BatchOptions {
  signal?: AbortSignal
  /** Applied independently to each provider inference-context scan in the batch. */
  contextScanLimits?: ArchiveLimits
  /** Applied independently to each automatic post-canonical projection scan in the batch. */
  projectionScanLimits?: ArchiveLimits
  /** Applied independently to every episode in the batch. */
  workLimits?: DerivationWorkLimits
}

export interface ReadOptions {
  signal?: AbortSignal
}

/** Trusted whole-space diagnostics with explicit physical row/byte admission. */
export interface ManagementOptions extends ReadOptions {
  scanLimits?: ArchiveLimits
}

export interface PointReadOptions extends ReadOptions {
  /** Physical related-row and stable-JSON-byte admission limits. */
  scanLimits?: ArchiveLimits
}

export interface ProcessingOperation {
  id: string
  spaceId: string
  kind: OperationKind
  state: OperationState
  /** Durable diagnostics are physically scrubbed when hard purge contaminates this operation. */
  diagnosticsState: 'available' | 'purged'
  /** True when bounded durable diagnostics omit warning or provider-call entries. */
  diagnosticsTruncated: boolean
  episodeId?: string
  stage: string
  startedAt: string
  updatedAt: string
  completedAt?: string
  retryable: boolean
  attempts: number
  warnings: readonly string[]
  error?: ReturnType<MemoryError['toJSON']>
  remoteCalls: readonly ProviderCallSummary[]
}

export interface ProviderCallSummary {
  capability: ProviderLineage['capability']
  provider: string
  model: string
  destination: ProviderLineage['destination']
  fields: readonly string[]
  startedAt: string
  completedAt?: string
  outcome: 'allowed' | 'denied' | 'succeeded' | 'failed'
}

export interface IngestionReport {
  operation: ProcessingOperation
  episode: Episode
  entities: {
    created: readonly string[]
    matched: readonly string[]
    merged: readonly string[]
    unresolved: readonly string[]
  }
  facts: {
    created: readonly string[]
    repeated: readonly string[]
    superseded: readonly string[]
    disputed: readonly string[]
    rejected: readonly string[]
  }
  projections: { created: number; stale: number; failed: number }
  /** Exact physical rows/bytes admitted while assembling provider inference context. */
  contextScan: PhysicalScanWork
  /** Exact physical rows/bytes admitted while assembling automatic projections. */
  projectionScan: PhysicalScanWork
  /** Exact distinct stored rows/bytes and dependency graph work admitted by canonical planning. */
  work: DerivationWork
  warnings: readonly string[]
  privacy: { remoteComputation: boolean; calls: readonly ProviderCallSummary[] }
}

export interface BatchReport {
  reports: readonly IngestionReport[]
  failed: readonly { index: number; error: ReturnType<MemoryError['toJSON']> }[]
}

export type TemporalView =
  | { kind: 'current' }
  | { kind: 'valid-at'; at: string }
  | { kind: 'known-at'; at: string }
  | { kind: 'history' }

export type RetrievalChannel = 'exact' | 'lexical' | 'semantic' | 'graph' | 'temporal'

export interface InstantFilter {
  /** Inclusive lower bound. */
  since?: string
  /** Exclusive upper bound. */
  until?: string
}

export interface TagFilter {
  all?: readonly string[]
  any?: readonly string[]
  none?: readonly string[]
}

export interface SourceFilter {
  kinds?: readonly string[]
  origins?: readonly string[]
  externalIds?: readonly string[]
  threadIds?: readonly string[]
  documentIds?: readonly string[]
  capturedAt?: InstantFilter
  /** Exact equality for the named top-level metadata fields. */
  metadata?: Readonly<Record<string, JsonValue>>
}

export interface EpisodeFilter {
  ids?: readonly string[]
  kinds?: readonly EpisodeKind[]
  source?: SourceFilter
  tags?: TagFilter
  retentionStates?: readonly Episode['retentionState'][]
  retentionPolicies?: readonly string[]
  sensitivities?: readonly string[]
  receivedAt?: InstantFilter
  observedAt?: InstantFilter
  /** Exact equality for the named top-level metadata fields. */
  metadata?: Readonly<Record<string, JsonValue>>
}

export interface EntityFilter {
  ids?: readonly string[]
  /** Matches an entity with at least one selected visible type. */
  types?: readonly string[]
}

export interface FactFilter {
  ids?: readonly string[]
  types?: readonly string[]
  predicates?: readonly string[]
  subjectIds?: readonly string[]
  /** Exact structural equality; multiple objects are alternatives. */
  objects?: readonly FactObject[]
  statuses?: readonly FactStatus[]
  recordedAt?: InstantFilter
}

export interface MemoryFilters {
  episodes?: EpisodeFilter
  entities?: EntityFilter
  facts?: FactFilter
}

export type MemorySignalTargetKind = 'episode' | 'entity' | 'fact'
export type MemorySignalState = 'active' | 'withdrawn'
export type MemorySignalProducerKind = 'manual' | 'algorithm'

export interface MemorySignalTarget {
  kind: MemorySignalTargetKind
  id: string
}

export interface MemorySignalBasis {
  episodeIds: readonly string[]
  entityIds: readonly string[]
  factIds: readonly string[]
}

export interface MemorySignalProducer {
  kind: MemorySignalProducerKind
  id: string
  version: string
}

export interface MemorySignalBase {
  /** Immutable revision id. */
  id: string
  spaceId: string
  /** Opaque logical identity shared by all revisions of this exact-scope signal. */
  key: string
  version: number
  namespace: string
  slot: string
  target: MemorySignalTarget
  producer: MemorySignalProducer
  scopes: readonly string[]
  /** Revision-level indexable grouping labels; excluded from logical signal identity. */
  tags: readonly string[]
  basis: MemorySignalBasis
  inputRevision: number
  recordedRevision: number
  basisView: TemporalView
  recordedAt: string
  supersedes?: string
}

export type MemorySignal = MemorySignalBase &
  (
    | {
        state: 'active'
        value: JsonValue
        expiresAt?: string
      }
    | {
        state: 'withdrawn'
        withdrawalReason?: string
      }
  )

export interface SignalInput {
  namespace: string
  /** Distinguishes multiple logical signals in one namespace for the same target. */
  slot?: string
  target: MemorySignalTarget
  producer: MemorySignalProducer
  /** Exact disclosure requirements. Must include every target and declared-basis scope. */
  scopes: readonly string[]
  /** Indexable grouping labels such as `cluster:ongoing-work`; may change by revision. */
  tags?: readonly string[]
  basis?: Partial<MemorySignalBasis>
  value: JsonValue
  expiresAt?: string
}

export interface PutSignalsRequest {
  access: AccessContext
  /** Revision of the snapshot or read result on which every signal is based. */
  expectedRevision: number
  basisView?: TemporalView
  /** Fail-closed physical row/byte ceilings for complete basis-view validation. */
  basisScanLimits?: ArchiveLimits
  signals: readonly SignalInput[]
}

export interface PutSignalsReport {
  revision: number
  signals: readonly MemorySignal[]
  supersededIds: readonly string[]
  /** Exact physical canonical rows/bytes admitted by basis-view validation. */
  basisScan: PhysicalScanWork
}

export interface SignalFilter {
  keys?: readonly string[]
  namespaces?: readonly string[]
  slots?: readonly string[]
  producerIds?: readonly string[]
  producerVersions?: readonly string[]
  targets?: readonly MemorySignalTarget[]
  states?: readonly MemorySignalState[]
  tags?: TagFilter
  /** Each supplied basis kind must overlap at least one listed id. */
  basis?: Partial<MemorySignalBasis>
  recordedAt?: InstantFilter
  expiresAt?: InstantFilter
}

export type SignalRevisionView = 'current' | 'history'

export interface BrowseSignalsRequest {
  access: AccessContext
  where?: SignalFilter
  revisionView?: SignalRevisionView
  /** Current-view active signals that have expired are hidden unless explicitly included. */
  includeExpired?: boolean
  order?: 'newest' | 'oldest' | 'key'
  cursor?: string
  limit?: number
  /** Exact canonical response ceiling. Defaults to 16 MiB and accepts at most 64 MiB. */
  maxBytes?: number
}

export interface SignalPage {
  signals: readonly MemorySignal[]
  /** Total matching revisions or logical current signals in this cursor snapshot. */
  total: number
  nextCursor?: string
  /** Start `signalChanges()` after this checked signal baseline. */
  signalChangesCursor: string
  /**
   * Exact full-set preview for `deleteEpisodes({ signalTargets: ... })` or
   * `hardPurge({ signalTargets: ... })`.
   * Present only for a constrained current, active, non-expired selection.
   */
  targetSelectionCursor?: string
  snapshotRevision: number
  generatedAt: string
  /** Exact UTF-8 byte length of the canonical JSON response, including this field. */
  byteLength: number
}

export interface DeleteSignalsRequest {
  access: AccessContext
  mode: 'withdraw' | 'purge'
  where: SignalFilter
  /** Revision used to preview this exact logical-key selection. */
  expectedRevision: number
  /** Fails closed if the selected logical-key count exceeds this guard. */
  maxMatches: number
  /**
   * Purge only: fails closed before mutation if the selected keys retain more revisions.
   * Defaults to 10,000 and accepts at most 100,000.
   */
  maxRevisions?: number
  /** Stored only on newly created withdrawal revisions. */
  reason?: string
}

export interface DeleteSignalsReport {
  mode: 'withdraw' | 'purge'
  revision: number
  matchedSignals: number
  affectedKeys: readonly string[]
  withdrawn: readonly MemorySignal[]
  deletedRevisions: number
}

export interface RecallRequest {
  query?: string
  anchors?: { entityIds?: readonly string[]; factIds?: readonly string[] }
  access: AccessContext
  view?: TemporalView
  filters?: MemoryFilters
  channels?: Partial<Record<RetrievalChannel, boolean>>
  graphDepth?: number
  conflictPolicy?: 'include' | 'exclude' | 'only'
  limit?: number
  budget?: { maxItems?: number; maxCharacters?: number; maxEvidence?: number }
  include?: Partial<Record<'episodes' | 'entities' | 'facts' | 'paths' | 'evidence', boolean>>
  rerank?: boolean
  /** Physical pre-filter row and stable-JSON-byte admission limits for the retrieval universe. */
  scanLimits?: ArchiveLimits
}

export interface SearchRequest extends RecallRequest {
  target?: 'all' | 'episodes' | 'entities' | 'facts'
}

export interface NeighborhoodRequest {
  entityId: string
  access: AccessContext
  view?: TemporalView
  depth?: number
  predicates?: readonly string[]
  limit?: number
  /** Physical pre-filter row and stable-JSON-byte admission limits. */
  scanLimits?: ArchiveLimits
}

export interface EpisodeExcerpt {
  episodeId: string
  source: SourceReference
  excerpt?: string
  /** Every selected evidence occurrence from this episode, kept distinct and source-addressable. */
  fragments: readonly EvidenceFragment[]
  scopes: readonly string[]
  receivedAt: string
}

export interface EvidenceFragment {
  evidenceId: string
  relation: EvidenceRelation
  anchor?: EpisodeAnchor
  excerpt?: string
  excerptTruncated?: true
}

export interface CitationSource extends EvidenceFragment {
  episodeId: string
}

export interface Citation {
  item: { kind: 'entity' | 'fact'; id: string }
  episodeIds: readonly string[]
  /** Exact evidence records and episode-local anchors behind this citation. */
  sources: readonly CitationSource[]
  status?: FactStatus
}

export interface FactView extends Fact {
  evidence: readonly EpisodeExcerpt[]
  /** Current visible rule supports, kept distinct from source evidence. */
  derivations: readonly Derivation[]
  lifecycle: readonly LifecycleTransition[]
}

export interface EntityView extends Entity {
  evidence: readonly EpisodeExcerpt[]
}

export interface LifecycleTransition {
  id: string
  target: { kind: 'entity' | 'fact' | 'episode'; id: string }
  action: string
  recordedAt: string
  operationId: string
  fromStatus?: string
  toStatus?: string
  relatedId?: string
}

export interface GraphPath {
  entityIds: readonly string[]
  factIds: readonly string[]
}

export interface ConflictView {
  id: string
  factIds: readonly string[]
  reason: string
}

export interface RetrievalContribution {
  item: { kind: 'entity' | 'fact' | 'episode'; id: string }
  channels: readonly { channel: RetrievalChannel; rank: number; contribution: number }[]
  fusedScore: number
  selected: boolean
}

export interface RetrievalExplanation {
  channels: readonly RetrievalChannel[]
  contributions: readonly RetrievalContribution[]
  filtersApplied: readonly string[]
  truncated: boolean
}

export interface DegradedCapability {
  capability: 'inference' | 'embedding' | 'rerank' | 'lexical' | 'storage'
  reason: string
}

export interface ContextBundle {
  spaceId: string
  snapshotRevision: number
  generatedAt: string
  view: TemporalView
  entities: readonly EntityView[]
  facts: readonly FactView[]
  episodes: readonly EpisodeExcerpt[]
  paths: readonly GraphPath[]
  conflicts: readonly ConflictView[]
  citations: Readonly<Record<string, Citation>>
  explanation: RetrievalExplanation
  rendered: string
  degraded: readonly DegradedCapability[]
  scan: PhysicalScanWork
}

export interface SearchItem {
  kind: 'episode' | 'entity' | 'fact'
  id: string
  score: number
  channels: readonly RetrievalChannel[]
}

export interface SearchResult {
  items: readonly SearchItem[]
  context: ContextBundle
}

export interface GraphNeighborhood {
  snapshotRevision: number
  generatedAt: string
  center: EntityView
  entities: readonly EntityView[]
  facts: readonly FactView[]
  paths: readonly GraphPath[]
  scan: PhysicalScanWork
}

export type BrowseKind = 'episode' | 'entity' | 'fact'
export type BrowseValue<K extends BrowseKind> = K extends 'episode'
  ? Episode
  : K extends 'entity'
    ? EntityView
    : FactView

export interface BrowseRequest<K extends BrowseKind = BrowseKind> {
  kind: K
  access: AccessContext
  view?: TemporalView
  filters?: MemoryFilters
  conflictPolicy?: RecallRequest['conflictPolicy']
  order?: 'newest' | 'oldest' | 'id'
  cursor?: string
  limit?: number
  /** Physical pre-filter row and stable-JSON-byte admission limits. */
  scanLimits?: ArchiveLimits
}

export interface BrowsePage<K extends BrowseKind = BrowseKind> {
  items: readonly BrowseValue<K>[]
  nextCursor?: string
  snapshotRevision: number
  generatedAt: string
  scan: PhysicalScanWork
}

export type PointReadKind = 'episode' | 'entity' | 'fact' | 'derivation'
export type PointReadValue<K extends PointReadKind> = K extends 'episode'
  ? Episode
  : K extends 'entity'
    ? EntityView
    : K extends 'fact'
      ? FactView
      : Derivation

export interface PointReadRequest<K extends PointReadKind = PointReadKind> {
  kind: K
  id: string
  access: AccessContext
  /** Physical related-row and stable-JSON-byte admission limits. */
  scanLimits?: ArchiveLimits
}

export interface PointReadResult<K extends PointReadKind = PointReadKind> {
  value: PointReadValue<K> | null
  snapshotRevision: number
  generatedAt: string
  scan: PhysicalScanWork
}

export interface SnapshotRequest {
  access: AccessContext
  view?: TemporalView
  filters?: MemoryFilters
  conflictPolicy?: RecallRequest['conflictPolicy']
  /**
   * Maximum aggregate episodes, entities, facts, evidence links, derivations, mentions, and
   * lifecycle records.
   * The call fails rather than returning a partial graph.
   */
  maxRecords?: number
  /** Physical pre-filter row and stable-JSON-byte admission limits. */
  scanLimits?: ArchiveLimits
}

export interface MemorySnapshot {
  spaceId: string
  snapshotRevision: number
  /** Start `changes()` after this complete snapshot without rescanning earlier journal history. */
  changesCursor: string
  generatedAt: string
  view: TemporalView
  ontology: Ontology
  episodes: readonly Episode[]
  entities: readonly EntityView[]
  facts: readonly FactView[]
  evidence: readonly EvidenceLink[]
  derivations: readonly Derivation[]
  mentions: readonly Mention[]
  lifecycle: readonly LifecycleTransition[]
  scan: PhysicalScanWork
  counts: {
    episodes: number
    entities: number
    facts: number
    evidence: number
    derivations: number
    mentions: number
    lifecycle: number
    records: number
  }
  complete: true
}

export interface AnalysisRequest {
  access: AccessContext
  view?: TemporalView
  filters?: MemoryFilters
  /** Independent cap for `graph.topEntities` and the severity-first `findings` sample; 1..100. */
  top?: number
  pagerank?: {
    damping?: number
    iterations?: number
    tolerance?: number
    /** Optional visible entity seeds; absent means uniform structural PageRank. */
    seeds?: readonly AnalysisPageRankSeed[]
  }
  /** Independent physical-scan and algorithm-work admission ceilings. */
  budgets?: AnalysisWorkBudgets
}

export interface AnalysisPageRankSeed {
  id: string
  /** Positive finite relative weight. Defaults to 1 and is normalized across seeds. */
  weight?: number
}

export interface AnalysisWorkBudgets {
  /** Physical rows admitted before facade filtering; defaults to 100,000 and caps at 1,000,000. */
  maxScannedRecords?: number
  /** Exact stable-JSON UTF-8 row bytes; defaults to 64 MiB and caps at 256 MiB. */
  maxScannedBytes?: number
  /** Visible records consumed by report computation; defaults to 1,000,000 and caps at 5,000,000. */
  maxAnalyzedRecords?: number
  /** Defaults to 100,000; hard cap 250,000. */
  maxGraphNodes?: number
  /** Defaults to 500,000; hard cap 1,000,000. */
  maxGraphEdges?: number
  /** Maximum `(nodes + edges) * requested iterations`; defaults to 50M and caps at 250M. */
  maxPageRankSteps?: number
  /** Defaults to 1,000,000 cardinality-one fact-pair checks; hard cap 10,000,000. */
  maxTemporalComparisons?: number
}

export interface AnalysisFinding {
  code: 'single_source' | 'derived_only' | 'conflict' | 'isolated_entity' | 'temporal_overlap'
  severity: 'info' | 'warning'
  items: readonly { kind: 'entity' | 'fact'; id: string }[]
  evidenceIds: readonly string[]
  message: string
}

export interface AnalysisReport {
  spaceId: string
  snapshotRevision: number
  generatedAt: string
  view: TemporalView
  overview: {
    episodes: number
    entities: number
    facts: number
    activeEvidence: number
    withdrawnEvidence: number
    activeDerivations: number
    conflicts: number
  }
  provenance: {
    bySourceKind: Readonly<Record<string, number>>
    byPredicate: Readonly<Record<string, number>>
    corroboration: {
      unsupported: number
      derivedOnly: number
      singleSource: number
      multipleSources: number
    }
  }
  graph: {
    nodes: number
    edges: number
    /** Unique directed entity pairs; density is `arcs / nodes²`, including possible self-arcs. */
    arcs: number
    components: number
    density: number
    topEntities: readonly {
      id: string
      degree: number
      inDegree: number
      outDegree: number
      pageRank: number
      component: number
    }[]
  }
  temporal: {
    earliestRecordedAt?: string
    latestRecordedAt?: string
    intervalFacts: number
    overlappingCardinalityOnePairs: number
  }
  /** Diagnostics only; these signals do not alter graph metrics, findings, or retrieval. */
  signals: {
    active: number
    expired: number
    withdrawn: number
    byNamespace: Readonly<Record<string, { active: number; expired: number; withdrawn: number }>>
  }
  /** Severity-first deterministic sample bounded by `AnalysisRequest.top`. */
  findings: readonly AnalysisFinding[]
  findingSummary: {
    total: number
    returned: number
    truncated: boolean
    byCode: Readonly<Record<AnalysisFinding['code'], number>>
  }
  work: {
    scannedRecords: number
    scannedBytes: number
    analyzedRecords: number
    graphNodes: number
    graphEdges: number
    pageRankSteps: number
    temporalComparisons: number
    limits: Required<AnalysisWorkBudgets>
  }
  algorithms: {
    graph: 'structural-pagerank-v1' | 'personalized-pagerank-v1'
    personalized: boolean
    seedCount: number
    damping: number
    iterations: number
    converged: boolean
    tolerance: number
  }
}

export interface CorrectFactInput {
  factId: string
  replacement: ExplicitFactInput
  reason?: string
  access: AccessContext
  scopes?: readonly string[]
  /** Fail-closed admission ceilings for indexed authorization and truth-maintenance planning. */
  workLimits?: DerivationWorkLimits
}

export interface RetractFactInput {
  factId: string
  episodeId?: string
  allSupport?: boolean
  reason?: string
  access: AccessContext
  /** Fail-closed admission ceilings for indexed support and truth-maintenance planning. */
  workLimits?: DerivationWorkLimits
}

export interface MergeEntitiesInput {
  targetId: string
  sourceIds: readonly string[]
  reason?: string
  access: AccessContext
  /** Fail-closed admission ceilings for indexed authority and projection planning. */
  workLimits?: DerivationWorkLimits
}

export interface SplitEntityMergeInput {
  mergeId: string
  reason?: string
  access: AccessContext
  /** Fail-closed admission ceilings for indexed authority and projection planning. */
  workLimits?: DerivationWorkLimits
}

export interface DeleteEpisodeInput {
  episodeId: string
  access: AccessContext
  /** Fail-closed admission ceilings for provenance, truth-maintenance, and projection planning. */
  workLimits?: DerivationWorkLimits
}

export interface PreviewEpisodeDeletionsInput {
  /** Must contain at least one constraint; only visible retained episodes can be selected. */
  where: EpisodeFilter
  access: AccessContext
  /** Optional guard when the preview must share an already evaluated canonical revision. */
  expectedRevision?: number
  /** Fails closed if the complete retained selection is broader; accepts 1 through 10,000. */
  maxMatches: number
  /** Aggregate fail-closed admission ceilings for indexed selection. */
  workLimits?: DerivationWorkLimits
}

export interface SignalTargetSelection {
  /** Must equal the constrained filter used to obtain `selectionCursor`. */
  where: SignalFilter
  /** `SignalPage.targetSelectionCursor` from the complete checked signal selection. */
  selectionCursor: string
}

interface DeleteEpisodesBaseInput {
  access: AccessContext
  /** Fails closed if the selected episode or signal count exceeds this guard. */
  maxMatches: number
  /** Fail-closed admission ceilings for selection, provenance, truth maintenance, and projections. */
  workLimits?: DerivationWorkLimits
}

export interface DeleteEpisodesByFilterInput extends DeleteEpisodesBaseInput {
  where: EpisodeFilter
  signalTargets?: never
  /** Revision returned by `previewEpisodeDeletions`, or another checked read for one-shot apply. */
  expectedRevision: number
  /** Optional consistency token returned by `previewEpisodeDeletions` for this exact set. */
  selectionCursor?: string
}

export interface DeleteEpisodesBySignalTargetsInput extends DeleteEpisodesBaseInput {
  where?: never
  /** Selects only episode targets and atomically withdraws the consumed signals. */
  signalTargets: SignalTargetSelection
  /** The selection cursor already binds the preview revision. */
  expectedRevision?: never
  selectionCursor?: never
}

export type DeleteEpisodesInput = DeleteEpisodesByFilterInput | DeleteEpisodesBySignalTargetsInput

export interface PurgeInput {
  access: AccessContext
  /** Fail-closed admission ceilings for selection, erasure closure, truth maintenance, and journals. */
  workLimits?: DerivationWorkLimits
  episodeIds?: readonly string[]
  /**
   * Selects episode targets by stable source, tag, metadata, state, and time fields.
   * Cannot be combined with `episodeIds` or `before`.
   */
  episodes?: EpisodeFilter
  /**
   * Purges the canonical targets of an exact current, active, non-expired signal selection.
   * Signal values are never interpreted; the cursor binds the complete previewed set.
   */
  signalTargets?: SignalTargetSelection
  entityIds?: readonly string[]
  factIds?: readonly string[]
  /** Legacy received-time shorthand; prefer `episodes.receivedAt.until` with an exact preview. */
  before?: string
  /** Required with `episodes` or `before`; must be the revision used to preview the selector. */
  expectedRevision?: number
  /**
   * Required with `episodes`, `before`, or `signalTargets`; fails before the purge marker if the
   * selected episode or signal count is broader.
   */
  maxMatches?: number
}

export interface PurgeReport extends DeletionReport {
  work: DerivationWork
}

export interface GovernanceReport {
  operation: ProcessingOperation
  affectedEpisodes: readonly string[]
  affectedEntities: readonly string[]
  affectedFacts: readonly string[]
  projectionsInvalidated: number
}

export interface EntityMergeReport extends GovernanceReport {
  work: DerivationWork
}

export interface CorrectionReport extends GovernanceReport {
  work: DerivationWork
}

export interface RetractionReport extends GovernanceReport {
  work: DerivationWork
}

export interface DerivationReport extends GovernanceReport {
  derivation: Derivation
  conclusion: Fact
  outcome: 'created' | 'supported' | 'reactivated' | 'withdrawn'
  invalidatedDerivations: readonly string[]
  unsupportedFacts: readonly string[]
  work: DerivationWork
}

export interface DerivationResult {
  derivation: Derivation
  conclusion: Fact
  outcome: 'created' | 'supported' | 'reactivated'
}

export interface DerivationBatchReport extends GovernanceReport {
  /** Results in the same order as the submitted derivations. */
  results: readonly DerivationResult[]
  invalidatedDerivations: readonly string[]
  unsupportedFacts: readonly string[]
  work: DerivationWork
}

export interface DerivationWithdrawalResult {
  /** Current active revision selected by the request. */
  derivationId: string
  /** Newly appended withdrawn successor revision. */
  withdrawalId: string
  conclusionFactId: string
}

export interface DerivationWithdrawalPreview {
  /** Complete deterministic current support selection; empty selections have no cursor. */
  derivations: readonly Derivation[]
  /** Binds this exact non-empty set, selector, access partition, space incarnation, and revision. */
  selectionCursor?: string
  snapshotRevision: number
  generatedAt: string
  work: DerivationWork
}

export interface DerivationWithdrawalBatchReport extends GovernanceReport {
  /** Deterministic derivation-id order. */
  withdrawals: readonly DerivationWithdrawalResult[]
  invalidatedDerivations: readonly string[]
  unsupportedFacts: readonly string[]
  work: DerivationWork
}

export interface DeletionReport extends GovernanceReport {
  purged: boolean
  unsupportedFacts: readonly string[]
  retainedFacts: readonly string[]
}

export interface ResetSpaceInput {
  /** Destructive confirmation; must exactly match the Memory instance's bound space. */
  confirmSpaceId: string
  /** Fail-closed physical ceilings for materializing the affected-id report before deletion. */
  scanLimits?: ArchiveLimits
}

export interface ResetSpaceReport extends DeletionReport {
  /** Exact episode/entity/fact/projection rows and canonical bytes read for the report. */
  scan: PhysicalScanWork
}

export interface EpisodeDeletionReport extends DeletionReport {
  work: DerivationWork
}

export interface EpisodeDeletionPreview {
  /** Complete deterministic visible retained selection; empty selections have no cursor. */
  episodes: readonly Episode[]
  /** Binds this exact non-empty set, selector, access partition, space incarnation, and revision. */
  selectionCursor?: string
  snapshotRevision: number
  generatedAt: string
  work: DerivationWork
}

export interface BulkDeletionReport extends DeletionReport {
  work: DerivationWork
}

export interface ArchiveLimits {
  /** Maximum records in an archive/output, or physical rows when used as scan limits. */
  maxRecords?: number
  /** Maximum canonical UTF-8 JSON bytes in an output, or summed row bytes as scan limits. */
  maxBytes?: number
}

/** Exact stored-row transfer and, where documented, planned-row work admitted by one operation. */
export interface PhysicalScanWork {
  records: number
  bytes: number
  limits: Required<ArchiveLimits>
}

export interface ExportRequest {
  access: AccessContext
  complete?: boolean
  episodeIds?: readonly string[]
  entityIds?: readonly string[]
  factIds?: readonly string[]
  scopes?: readonly string[]
  since?: string
  until?: string
  /** Bounds physical canonical rows examined while computing selection and dependency closure. */
  scanLimits?: ArchiveLimits
  /** Bounds the complete returned format-v4 archive. */
  limits?: ArchiveLimits
}

/** Portable episode form carrying the complete deterministic `contentHash` preimage. */
export interface ArchiveEpisode extends Episode {
  /** Accepted explicit input retained for identity verification and deterministic reprocessing. */
  assertions?: ExplicitAssertionSet
}

/** Exact format-v4 entity-identity merge lineage. */
export interface ArchiveMerge {
  kindRecord: 'merge'
  id: string
  spaceId: string
  targetId: string
  sourceIds: readonly string[]
  active: boolean
  reason?: string
  createdAt: string
  reversedAt?: string
  operationId: string
}

/** Exact record counts shared by a format-v4 manifest and its import report. */
export interface ArchiveCounts {
  readonly episodes: number
  readonly entities: number
  readonly facts: number
  readonly evidence: number
  readonly derivations: number
  readonly mentions: number
  readonly lifecycle: number
  readonly merges: number
}

export interface ArchiveManifest {
  algorithm: 'SHA-256'
  digest: string
  counts: ArchiveCounts
}

export interface MemoryExport {
  mediaType: 'application/vnd.astrale.temporal-memory+json'
  formatVersion: 4
  /** Canonical space revision from which every exported record was materialized. */
  snapshotRevision: number
  exportedAt: string
  space: SpaceInfo
  ontology: Ontology
  canonical: {
    episodes: readonly ArchiveEpisode[]
    entities: readonly Entity[]
    facts: readonly Fact[]
    evidence: readonly EvidenceLink[]
    derivations: readonly Derivation[]
    mentions: readonly Mention[]
    lifecycle: readonly LifecycleTransition[]
    merges: readonly ArchiveMerge[]
  }
  manifest: ArchiveManifest
}

export interface ImportOptions extends OperationOptions {
  dryRun?: boolean
  collisions?: 'reject' | 'identical' | 'remap'
  /** Bounds the accepted materialized format-v4 archive before collision or mutation work. */
  limits?: ArchiveLimits
  /** Bounds target-local physical rows prepared for validation and the atomic import transaction. */
  prepareLimits?: ArchiveLimits
}

export interface ImportReport {
  operation?: ProcessingOperation
  dryRun: boolean
  valid: boolean
  collisions: readonly string[]
  remapped?: Readonly<Record<string, string>>
  imported: ArchiveCounts
  warnings: readonly string[]
}

/** Logical records replicated by the whole-memory sync protocol. */
export type SyncRecordKind =
  | 'episode'
  | 'entity'
  | 'alias'
  | 'mention'
  | 'fact'
  | 'evidence'
  | 'derivation'
  | 'lifecycle'
  | 'merge'
  | 'purge'
  | 'signal'

/** A revision-portable record. Local storage revisions and derived projections are never packed. */
export interface SyncRecord {
  key: string
  kind: SyncRecordKind
  id: string
  value: Readonly<Record<string, JsonValue>>
}

/** Immutable, content-addressed commit header for one complete logical memory state. */
export interface SyncCheckpoint {
  mediaType: 'application/vnd.astrale.temporal-memory-sync-checkpoint+json'
  protocolVersion: 1
  id: string
  spaceId: string
  parents: readonly string[]
  ontologyDigest: string
  rootDigest: string
  chunkCount: number
  recordCount: number
  byteLength: number
  scopes: readonly string[]
  createdAt: string
}

/** Independently checksummed, bounded transfer unit. Chunk order is committed by `rootDigest`. */
export interface SyncChunk {
  checkpointId: string
  index: number
  digest: string
  byteLength: number
  records: readonly SyncRecord[]
}

export interface SyncChunkPage {
  checkpoint: SyncCheckpoint
  chunks: readonly SyncChunk[]
  /** Next zero-based chunk index. Absent when the checkpoint is complete. */
  nextIndex?: number
}

export type SyncBundleFrame =
  | { type: 'checkpoint'; index: number; checkpoint: SyncCheckpoint }
  | { type: 'chunk'; chunk: SyncChunk }
  | {
      type: 'commit'
      mediaType: 'application/vnd.astrale.temporal-memory-sync-bundle+json'
      bundleVersion: 1
      checkpointId: string
      checkpointCount: number
      checkpointByteLength: number
      checkpointDigest: string
      chunkCount: number
      rootDigest: string
    }

export type SyncBundleCheckpointFrame = Extract<SyncBundleFrame, { type: 'checkpoint' }>
export type SyncBundleChunkFrame = Extract<SyncBundleFrame, { type: 'chunk' }>
export type SyncBundleCommitFrame = Extract<SyncBundleFrame, { type: 'commit' }>

/**
 * Exports an immutable whole-memory checkpoint as bounded portable frames.
 *
 * Persist `nextCursor` only after every returned frame is durable. A completed bundle ends with one
 * `commit` frame; a store can then expose its headers/chunks through `MemorySyncPeer` for import.
 */
export interface ExportSyncBundleRequest {
  access: AccessContext
  confirmSpaceId: string
  /** Defaults to the current HEAD. Explicit ids allow repeatable export of an older retained pack. */
  checkpointId?: string
  cursor?: string
  /** Maximum portable checkpoint headers in the bundle. Defaults to 10,000; caps at 100,000. */
  maxCheckpoints?: number
  /** Whole-bundle checkpoint-frame budget. Defaults to 64 MiB and caps at 1 GiB. */
  maxCheckpointBytes?: number
  /** Maximum frames in this page. Defaults to 16 and is bounded to 1..64. */
  limit?: number
  /** Canonical frame-payload bound. Defaults to 32 MiB and caps at 256 MiB. */
  maxBytes?: number
}

export interface SyncBundlePage {
  mediaType: 'application/vnd.astrale.temporal-memory-sync-bundle+json'
  bundleVersion: 1
  checkpoint: SyncCheckpoint
  frames: readonly SyncBundleFrame[]
  /** Canonical UTF-8 bytes of `frames`; the repeated page envelope is additional. */
  byteLength: number
  nextCursor?: string
}

export interface CreateSyncCheckpointRequest {
  access: AccessContext
  /** Whole-space disclosure is privileged and must be confirmed explicitly. */
  confirmSpaceId: string
  /** Default 8 MiB; bounded to 64 KiB..16 MiB. */
  maxChunkBytes?: number
}

/**
 * Selects one bounded page of immutable checkpoint payloads for local reclamation.
 *
 * Headers are retained so the content-addressed ancestry remains inspectable. A replica that later
 * needs a compacted merge base must be explicitly reseeded instead of guessing at reconciliation.
 */
export interface CompactSyncHistoryRequest {
  access: AccessContext
  /** Exact destructive-maintenance confirmation. */
  confirmSpaceId: string
  /** Current logical revision observed by the maintenance caller. */
  expectedRevision: number
  /** Exact sync HEAD observed by the maintenance caller. */
  expectedHead: string
  /** Only checkpoints created strictly before this instant are scanned. */
  before: string
  /** Opaque continuation over immutable checkpoint headers. */
  cursor?: string
  /** Maximum headers scanned and payloads selected in this page. Accepted range: 1..64. */
  maxCheckpoints: number
  /** Plan one bounded page without making payloads unavailable. */
  dryRun?: boolean
}

export interface SyncHistoryCompactionItem {
  checkpointId: string
  createdAt: string
  chunkCount: number
  recordCount: number
  byteLength: number
}

export interface CompactSyncHistoryReport {
  dryRun: boolean
  head: string
  before: string
  revision: number
  scannedCheckpoints: number
  /** Payload-bearing non-HEAD checkpoints selected by this page. */
  selected: readonly SyncHistoryCompactionItem[]
  /** Selected payloads made unavailable; zero for a dry run. */
  compactedCheckpoints: number
  deletedChunks: number
  deletedIndexes: number
  /** Canonical chunk bytes physically removed by this completed call. */
  reclaimedBytes: number
  skippedHead: number
  skippedUnavailable: number
  hasMore: boolean
  nextCursor?: string
}

export type SyncCheckpointPayloadState = 'available' | 'pruning' | 'pruned'

/** Bounded local inventory over immutable checkpoint headers and payload availability. */
export interface SyncHistoryRequest {
  access: AccessContext
  /** Only checkpoints created strictly before this instant are returned. */
  before?: string
  cursor?: string
  /** Defaults to 50 and is bounded to 1..100. */
  limit?: number
}

export interface SyncHistoryItem {
  checkpoint: SyncCheckpoint
  payloadState: SyncCheckpointPayloadState
  isHead: boolean
}

export interface SyncHistoryPage {
  /** Current HEAD against which this page and its cursor were checked. */
  head: SyncCheckpoint
  revision: number
  checkpoints: readonly SyncHistoryItem[]
  nextCursor?: string
}

export interface SyncChunksRequest {
  access: AccessContext
  checkpointId: string
  startIndex?: number
  /** Defaults to 1 and is bounded to 1..64. */
  limit?: number
  /** Canonical chunk-payload bound; defaults to 16 MiB, caps at 256 MiB, and never splits. */
  maxBytes?: number
}

/** Transport-neutral peer; an RPC adapter can implement the same bounded methods. */
export interface MemorySyncPeer {
  syncHead(access: AccessContext, options?: ReadOptions): Promise<SyncCheckpoint>
  syncCheckpoint(
    id: string,
    access: AccessContext,
    options?: ReadOptions,
  ): Promise<SyncCheckpoint | null>
  syncChunks(request: SyncChunksRequest, options?: ReadOptions): Promise<SyncChunkPage>
}

export type SyncStrategy = 'merge' | 'fast-forward-only'
export type SyncSessionState =
  | 'receiving'
  | 'planning'
  | 'conflicts'
  | 'applying'
  | 'rolling-back'
  | 'succeeded'
  | 'aborted'
  | 'failed'

/** Aggregate logical checkpoint admission budget. Storage/index overhead is additional. */
export interface SyncReceiveLimits {
  /** Defaults to 512 MiB of canonical chunk payload. */
  maxBytes?: number
  /** Defaults to 1,000,000 logical records. */
  maxRecords?: number
  /** Defaults to 65,536 chunks. */
  maxChunks?: number
}

/**
 * Durable random-access primitives needed to open a completed offline sync bundle. Returned frames
 * are treated as untrusted and copied under hard format limits before validation or reuse.
 */
export interface SyncBundleReader {
  readCommit(options?: ReadOptions): Promise<SyncBundleCommitFrame | null>
  readCheckpoint(index: number, options?: ReadOptions): Promise<SyncBundleCheckpointFrame | null>
  readChunk(index: number, options?: ReadOptions): Promise<SyncBundleChunkFrame | null>
}

/** Admission ceilings for streaming verification of an untrusted persisted bundle. Snapshotted at entry. */
export interface OpenSyncBundleOptions extends ReadOptions {
  /** Defaults to 10,000 and caps at 100,000. */
  maxCheckpoints?: number
  /** Defaults to 64 MiB and caps at 1 GiB. */
  maxCheckpointBytes?: number
  /** Defaults match `syncFrom`; validation holds at most one chunk body at a time. */
  receiveLimits?: SyncReceiveLimits
}

export interface SyncFromRequest {
  access: AccessContext
  confirmSpaceId: string
  /** Resume a previously returned session without restarting received chunks. */
  sessionId?: string
  expectedRevision?: number
  strategy?: SyncStrategy
  /** Bounded ancestry walk; defaults to 10,000 checkpoint headers. */
  maxAncestry?: number
  /** Rejects an oversized remote or merged checkpoint before unbounded staging. */
  receiveLimits?: SyncReceiveLimits
}

export interface SyncConflict {
  key: string
  kind: SyncRecordKind
  id: string
  reason: 'both_modified' | 'delete_modify' | 'invalid_combination'
  baseDigest?: string
  localDigest?: string
  remoteDigest?: string
  resolution?: 'local' | 'remote' | 'delete'
}

export interface SyncConflictsRequest {
  sessionId: string
  access: AccessContext
  cursor?: string
  limit?: number
  /** Defaults to 1 MiB and caps at 16 MiB, including cursor and envelope bytes. */
  maxBytes?: number
}

export interface SyncConflictPage {
  conflicts: readonly SyncConflict[]
  nextCursor?: string
  /** Canonical UTF-8 byte length of this complete page. */
  byteLength: number
}

export interface SyncConflictDetailRequest {
  sessionId: string
  key: string
  access: AccessContext
  /** Defaults to 1 MiB and is bounded to 48 MiB plus envelope overhead. */
  maxBytes?: number
}

export interface SyncConflictDetail {
  conflict: SyncConflict
  base: SyncRecord | null
  local: SyncRecord | null
  remote: SyncRecord | null
  /** Canonical UTF-8 byte length of this complete detail response. */
  byteLength: number
}

export interface SyncResolution {
  key: string
  choice: 'local' | 'remote' | 'delete'
}

export interface ResolveSyncRequest {
  sessionId: string
  access: AccessContext
  confirmSpaceId: string
  resolutions: readonly SyncResolution[]
  expectedRevision?: number
}

export interface AbortSyncRequest {
  sessionId: string
  access: AccessContext
  confirmSpaceId: string
}

export interface SyncReport {
  sessionId: string
  state: SyncSessionState
  strategy: SyncStrategy
  localHead: string
  remoteHead: string
  baseCheckpoint?: string
  checkpoint?: SyncCheckpoint
  receivedChunks: number
  totalChunks: number
  conflicts: number
  appliedRecords: number
  deletedRecords: number
  purgeDominatedRecords: number
  resumable: boolean
  operation?: ProcessingOperation
  /** True when bounded durable session diagnostics omit warning entries or text bytes. */
  diagnosticsTruncated: boolean
  warnings: readonly string[]
  error?: string
}

export type SyncSessionDetailsState = 'available' | 'pruning' | 'pruned'

/** Bounded local inventory entry. Terminal session identity/status survives detail compaction. */
export interface SyncSessionSummary extends SyncReport {
  mode: 'checkpoint' | 'pull'
  createdAt: string
  updatedAt: string
  detailsState: SyncSessionDetailsState
}

export interface SyncSessionsRequest {
  access: AccessContext
  /** Only sessions created strictly before this instant are returned. */
  before?: string
  cursor?: string
  /** Defaults to 50 and is bounded to 1..100. */
  limit?: number
}

export interface SyncSessionsPage {
  sessions: readonly SyncSessionSummary[]
  nextCursor?: string
}

export interface CompactSyncSessionsRequest {
  access: AccessContext
  /** Exact destructive-maintenance confirmation. */
  confirmSpaceId: string
  /** Current logical revision observed by the maintenance caller. */
  expectedRevision: number
  /** Exact sync HEAD observed by the maintenance caller. */
  expectedHead: string
  /** Only terminal sessions settled strictly before this instant are scanned. */
  before: string
  /** Opaque continuation over immutable terminal-session settlement order. */
  cursor?: string
  /** Maximum sessions scanned and selected in this page. Accepted range: 1..64. */
  maxSessions: number
  /** Plan one bounded page without reclaiming staging or terminal detail. */
  dryRun?: boolean
}

export interface SyncSessionCompactionItem {
  sessionId: string
  mode: 'checkpoint' | 'pull'
  state: 'succeeded' | 'aborted' | 'failed'
  updatedAt: string
}

export interface CompactSyncSessionsReport {
  dryRun: boolean
  head: string
  before: string
  revision: number
  scannedSessions: number
  selected: readonly SyncSessionCompactionItem[]
  compactedSessions: number
  deletedChunks: number
  deletedIndexes: number
  deletedConflicts: number
  deletedTombstones: number
  reclaimedBytes: number
  skippedUnavailable: number
  hasMore: boolean
  nextCursor?: string
}

export interface RebuildRequest {
  kinds?: readonly ('lexical' | 'embedding' | 'summary')[]
  entityIds?: readonly string[]
  factIds?: readonly string[]
  episodeIds?: readonly string[]
  /** Physical source/dependency/projection row and stable-JSON-byte admission limits. */
  scanLimits?: ArchiveLimits
}

export interface ProjectionSetStatus {
  kind: 'lexical' | 'embedding' | 'summary'
  setId: string
  generation: string
  sourceCanonicalRevision: number
  activatedAt: string
  operationId: string
}

export interface MaintenanceReport {
  operation: ProcessingOperation
  scanned: number
  rebuilt: number
  failed: number
  staleRemaining: number
  activeProjectionSets: readonly ProjectionSetStatus[]
  scan: PhysicalScanWork
}

export interface IntegrityIssue {
  code: string
  severity: 'warning' | 'error'
  record?: { kind: string; id: string }
  message: string
}

export interface IntegrityLimits {
  /** Distinct physical storage rows admitted across canonical, journal, projection, and sync data. */
  maxRecords?: number
  /** Stable UTF-8 JSON bytes of those distinct physical rows. */
  maxBytes?: number
  /** Distinct fact nodes admitted to active derivation-cycle verification. */
  maxGraphNodes?: number
  /** Active fact-premise edges admitted to derivation-cycle verification. */
  maxGraphEdges?: number
  /** Maximum issue details retained in the report; zero performs a summary-only check. */
  maxIssues?: number
}

export interface IntegrityOptions extends ReadOptions {
  limits?: IntegrityLimits
}

export interface IntegrityWork {
  records: number
  bytes: number
  graphNodes: number
  graphEdges: number
  issuesDetected: number
  issuesTruncated: boolean
  limits: Required<IntegrityLimits>
}

export interface IntegrityReport {
  ok: boolean
  snapshotRevision: number
  checkedAt: string
  counts: Readonly<Record<string, number>>
  issues: readonly IntegrityIssue[]
  work: IntegrityWork
}

export interface MemoryStats {
  snapshotRevision: number
  generatedAt: string
  episodes: number
  entities: number
  facts: number
  /** Current active logical derivation supports. */
  derivations: number
  /** Retained immutable derivation revisions, including invalidated and withdrawn history. */
  derivationRevisions: number
  conflicts: number
  operations: number
  changes: number
  /** Revisions at or below this watermark are no longer available from `changes()`. */
  changesCompactedThrough: number
  /** Current active, non-expired logical signals across all scopes. */
  signals: number
  /** Retained immutable signal revisions, including withdrawn and expired history. */
  signalRevisions: number
  /** Retained signal-journal rows. */
  signalChanges: number
  /** Revisions at or below this watermark are no longer available from `signalChanges()`. */
  signalChangesCompactedThrough: number
  staleProjections: number
  activeProjectionSets: readonly ProjectionSetStatus[]
  providerCalls: number
  /** Exact residual rows transferred for latest/distinct/summed metrics. */
  scan: PhysicalScanWork
}

export type MemoryChangePhase =
  | 'accepted'
  | 'canonical'
  | 'governance'
  | 'import'
  | 'purge'
  | 'sync'

export interface MemoryChangeTargets {
  episodeIds: readonly string[]
  entityIds: readonly string[]
  factIds: readonly string[]
}

/** One exact disclosure partition within a committed semantic revision. */
export interface MemoryChangePartition {
  scopes: readonly string[]
  affected: MemoryChangeTargets
  /** The consumer must rebuild this visible partition instead of applying target-level updates. */
  invalidated?: true
}

/** Durable semantic change metadata. This is neither source evidence nor an execution trace. */
export interface MemoryChange {
  spaceId: string
  revision: number
  recordedAt: string
  /** Operational lineage only. Callers must use an opaque, non-sensitive identifier. */
  operationId: string
  operationKind: OperationKind
  phase: MemoryChangePhase
  partitions: readonly MemoryChangePartition[]
}

export interface ChangesRequest {
  access: AccessContext
  /** Opaque continuation. Omit to scan from creation of the current space. */
  cursor?: string
  /** Maximum committed semantic revisions scanned, not the number visible after scope filtering. */
  limit?: number
}

export interface ChangesPage {
  changes: readonly MemoryChange[]
  nextCursor: string
  throughRevision: number
  currentRevision: number
  changesCompactedThrough: number
  hasMore: boolean
}

/** Package-owned incremental journal whose checkpoints may be managed durably. */
export type JournalKind = 'semantic' | 'signal'

export type JournalConsumerState = 'active' | 'retired'

/** Local operational checkpoint. It is deliberately excluded from archives and replica sync. */
export interface JournalConsumer {
  id: string
  journal: JournalKind
  state: JournalConsumerState
  /** Opaque `changes()` or `signalChanges()` cursor, according to `journal`. */
  cursor: string
  throughRevision: number
  registeredAt: string
  acknowledgedAt: string
  retiredAt?: string
}

export interface RegisterJournalConsumerRequest {
  /** Stable, non-sensitive host identifier. Retired identifiers cannot be reused. */
  id: string
  journal: JournalKind
  /** Initial cursor obtained from the corresponding feed in the current space generation. */
  cursor: string
}

export interface AcknowledgeJournalConsumerRequest {
  id: string
  journal: JournalKind
  /** Monotonic cursor with the same access partition as the registered cursor. */
  cursor: string
}

export interface RetireJournalConsumerRequest {
  id: string
  journal: JournalKind
}

export interface JournalConsumersRequest {
  journal: JournalKind
  /** Defaults to `active`; `all` includes durable retirement tombstones. */
  state?: JournalConsumerState | 'all'
  /** Opaque metadata-revision-bound continuation. */
  cursor?: string
  /** Accepted range: 1..100; defaults to 50. */
  limit?: number
}

export interface JournalConsumersPage {
  consumers: readonly JournalConsumer[]
  nextCursor?: string
  hasMore: boolean
  snapshotRevision: number
}

interface CompactChangesRequestBase {
  /** Exact destructive-maintenance confirmation. */
  confirmSpaceId: string
  /** Current space revision observed by the maintenance caller. */
  expectedRevision: number
  /** Maximum semantic rows removed by this transaction. Accepted range: 1..1,000. */
  maxChanges: number
  /** Plan one bounded batch without changing storage. */
  dryRun?: boolean
}

export type CompactChangesRequest = CompactChangesRequestBase &
  (
    | {
        /** Expert override: highest acknowledged revision that may be removed. */
        throughRevision: number
        consumerCursors?: never
        registeredConsumers?: never
      }
    | {
        /**
         * Durable `changes()` cursors for every consumer to preserve. The minimum cursor revision
         * becomes the compaction watermark. Accepted length: 1..1,000.
         */
        consumerCursors: readonly string[]
        throughRevision?: never
        registeredConsumers?: never
      }
    | {
        /** Use every active durable semantic-journal consumer in the local registry. */
        registeredConsumers: true
        throughRevision?: never
        consumerCursors?: never
      }
  )

export interface CompactChangesReport {
  dryRun: boolean
  requestedThroughRevision: number
  previousCompactedThrough: number
  /** Applied floor, or the projected floor when `dryRun` is true. */
  compactedThrough: number
  /** Semantic rows selected for this bounded batch. */
  batchChanges: number
  deletedChanges: number
  /** More retained semantic rows remain at or below `requestedThroughRevision`. */
  hasMore: boolean
  /** Current space revision after the call; unchanged for dry-run and no-op calls. */
  revision: number
}

export type MemorySignalChangeAction = 'put' | 'withdraw' | 'purge'

export interface MemorySignalChangeItem {
  key: string
  target: MemorySignalTarget
}

/** One exact disclosure partition within a committed signal-plane revision. */
export interface MemorySignalChangePartition {
  scopes: readonly string[]
  affected: readonly MemorySignalChangeItem[]
  /** Hard purge concealed erased identifiers; rebuild this visible signal partition. */
  invalidated?: true
}

/** Durable non-epistemic signal change metadata. It never constitutes evidence or factual support. */
export interface MemorySignalChange {
  spaceId: string
  revision: number
  recordedAt: string
  action: MemorySignalChangeAction
  partitions: readonly MemorySignalChangePartition[]
}

export interface SignalChangesRequest {
  access: AccessContext
  /** Opaque continuation. Omit to scan from creation of the current space. */
  cursor?: string
  /** Maximum committed signal revisions scanned, before scope filtering. */
  limit?: number
}

export interface SignalChangesPage {
  changes: readonly MemorySignalChange[]
  nextCursor: string
  throughRevision: number
  currentRevision: number
  signalChangesCompactedThrough: number
  hasMore: boolean
}

interface CompactSignalChangesRequestBase {
  /** Exact destructive-maintenance confirmation. */
  confirmSpaceId: string
  /** Current space revision observed by the maintenance caller. */
  expectedRevision: number
  /** Maximum signal-journal rows removed by this transaction. Accepted range: 1..1,000. */
  maxChanges: number
  /** Plan one bounded batch without changing storage. */
  dryRun?: boolean
}

export type CompactSignalChangesRequest = CompactSignalChangesRequestBase &
  (
    | {
        /** Expert override: highest acknowledged revision that may be removed. */
        throughRevision: number
        consumerCursors?: never
        registeredConsumers?: never
      }
    | {
        /**
         * Durable `signalChanges()` cursors for every consumer to preserve. The minimum cursor
         * revision becomes the compaction watermark. Accepted length: 1..1,000.
         */
        consumerCursors: readonly string[]
        throughRevision?: never
        registeredConsumers?: never
      }
    | {
        /** Use every active durable signal-journal consumer in the local registry. */
        registeredConsumers: true
        throughRevision?: never
        consumerCursors?: never
      }
  )

export interface CompactSignalChangesReport {
  dryRun: boolean
  requestedThroughRevision: number
  previousCompactedThrough: number
  /** Applied floor, or the projected floor when `dryRun` is true. */
  compactedThrough: number
  /** Signal-journal rows selected for this bounded batch. */
  batchChanges: number
  deletedChanges: number
  /** More retained signal-journal rows remain at or below `requestedThroughRevision`. */
  hasMore: boolean
  /** Current space revision after the call; unchanged for dry-run and no-op calls. */
  revision: number
}

export type ErrorScope =
  | 'lifecycle'
  | 'input'
  | 'policy'
  | 'provider'
  | 'storage'
  | 'projection'
  | 'retrieval'
  | 'maintenance'
  | 'listener'

export interface LifecycleEvent {
  spaceId: string
  at: string
  state: MemoryInspection['state']
}

export interface OperationEvent {
  spaceId: string
  at: string
  operation: ProcessingOperation
}

export interface ProviderEvent {
  spaceId: string
  at: string
  operationId: string
  call: ProviderCallSummary
}

export interface ResolutionEvent {
  spaceId: string
  at: string
  operationId: string
  candidateId: string
  outcome: 'created' | 'matched' | 'merged' | 'unresolved' | 'rejected'
  entityId?: string
  basis: readonly string[]
}

export interface ReconciliationEvent {
  spaceId: string
  at: string
  operationId: string
  candidateId: string
  outcome: 'created' | 'repeated' | 'superseded' | 'disputed' | 'retracted' | 'rejected'
  factId?: string
}

export interface RetrievalEvent {
  spaceId: string
  at: string
  channels: readonly RetrievalChannel[]
  selected: number
  durationMs: number
  remoteComputation: boolean
}

export interface MemoryEventMap {
  'lifecycle:ready': LifecycleEvent
  'operation:settled': OperationEvent
  'provider:request': ProviderEvent
  'provider:result': ProviderEvent
  'resolution:decision': ResolutionEvent
  'reconciliation:decision': ReconciliationEvent
  'retrieval:complete': RetrievalEvent
}

export type MemoryEventName = keyof MemoryEventMap

export interface Memory {
  readonly spaceId: string
  open(options?: OpenOptions): Promise<SpaceInfo>
  close(): Promise<void>
  inspect(options?: ManagementOptions): Promise<MemoryInspection>
  /** Episode-key replay; a supplied operationId must name the episode's bound ingest operation. */
  remember(input: RememberInput, options?: IngestionOptions): Promise<IngestionReport>
  rememberMany(inputs: readonly RememberInput[], options?: BatchOptions): Promise<BatchReport>
  operation(id: string): Promise<ProcessingOperation | null>
  /** Fresh-only operationId: reuse never means replay. */
  retryEpisode(episodeId: string, options?: IngestionOptions): Promise<IngestionReport>
  /** Fresh-only operationId: reuse never means replay. */
  reprocessEpisode(episodeId: string, options?: IngestionOptions): Promise<IngestionReport>
  recall(request: RecallRequest, options?: ReadOptions): Promise<ContextBundle>
  search(request: SearchRequest, options?: ReadOptions): Promise<SearchResult>
  neighborhood(request: NeighborhoodRequest, options?: ReadOptions): Promise<GraphNeighborhood>
  browse<K extends BrowseKind>(
    request: BrowseRequest<K>,
    options?: ReadOptions,
  ): Promise<BrowsePage<K>>
  snapshot(request: SnapshotRequest, options?: ReadOptions): Promise<MemorySnapshot>
  analyze(request: AnalysisRequest, options?: ReadOptions): Promise<AnalysisReport>
  changes(request: ChangesRequest, options?: ReadOptions): Promise<ChangesPage>
  browseSignals(request: BrowseSignalsRequest, options?: ReadOptions): Promise<SignalPage>
  signalChanges(request: SignalChangesRequest, options?: ReadOptions): Promise<SignalChangesPage>
  registerJournalConsumer(
    request: RegisterJournalConsumerRequest,
    options?: ReadOptions,
  ): Promise<JournalConsumer>
  acknowledgeJournalConsumer(
    request: AcknowledgeJournalConsumerRequest,
    options?: ReadOptions,
  ): Promise<JournalConsumer>
  retireJournalConsumer(
    request: RetireJournalConsumerRequest,
    options?: ReadOptions,
  ): Promise<JournalConsumer>
  journalConsumers(
    request: JournalConsumersRequest,
    options?: ReadOptions,
  ): Promise<JournalConsumersPage>
  putSignals(request: PutSignalsRequest, options?: ReadOptions): Promise<PutSignalsReport>
  deleteSignals(request: DeleteSignalsRequest, options?: ReadOptions): Promise<DeleteSignalsReport>
  compactChanges(
    request: CompactChangesRequest,
    options?: ReadOptions,
  ): Promise<CompactChangesReport>
  compactSignalChanges(
    request: CompactSignalChangesRequest,
    options?: ReadOptions,
  ): Promise<CompactSignalChangesReport>
  read<K extends PointReadKind>(
    request: PointReadRequest<K>,
    options?: ReadOptions,
  ): Promise<PointReadResult<K>>
  getEpisode(id: string, access: AccessContext, options?: PointReadOptions): Promise<Episode | null>
  getEntity(
    id: string,
    access: AccessContext,
    options?: PointReadOptions,
  ): Promise<EntityView | null>
  getFact(id: string, access: AccessContext, options?: PointReadOptions): Promise<FactView | null>
  getDerivation(
    id: string,
    access: AccessContext,
    options?: PointReadOptions,
  ): Promise<Derivation | null>
  /** Returns one complete revision-pinned rule-support selection without mutation. */
  previewDerivationWithdrawals(
    input: PreviewDerivationWithdrawalsInput,
    options?: ReadOptions,
  ): Promise<DerivationWithdrawalPreview>
  /** Request-bound operationId: an identical settled request replays its stored result. */
  deriveFact(input: DeriveFactInput, options?: OperationOptions): Promise<DerivationReport>
  /** Atomically applies one to 64 independently evaluated conclusions at one checked revision. */
  deriveFacts(input: DeriveFactsInput, options?: OperationOptions): Promise<DerivationBatchReport>
  /** Request-bound operationId: an identical settled request replays its stored result. */
  withdrawDerivation(
    input: WithdrawDerivationInput,
    options?: OperationOptions,
  ): Promise<DerivationReport>
  /** Atomically retires a bounded checked rule/conclusion/time selection. */
  withdrawDerivations(
    input: WithdrawDerivationsInput,
    options?: OperationOptions,
  ): Promise<DerivationWithdrawalBatchReport>
  /** Request-bound operationId: an identical settled request replays its stored result. */
  correctFact(input: CorrectFactInput, options?: OperationOptions): Promise<CorrectionReport>
  /** Fresh-only operationId: reuse never means replay. */
  retractFact(input: RetractFactInput, options?: OperationOptions): Promise<RetractionReport>
  /** Fresh-only operationId: reuse never means replay. */
  mergeEntities(input: MergeEntitiesInput, options?: OperationOptions): Promise<EntityMergeReport>
  /** Fresh-only operationId: reuse never means replay. */
  splitEntityMerge(
    input: SplitEntityMergeInput,
    options?: OperationOptions,
  ): Promise<EntityMergeReport>
  /** Fresh-only operationId: reuse never means replay. */
  deleteEpisode(
    input: DeleteEpisodeInput,
    options?: OperationOptions,
  ): Promise<EpisodeDeletionReport>
  /** Returns one complete revision-pinned retained-episode selection without mutation. */
  previewEpisodeDeletions(
    input: PreviewEpisodeDeletionsInput,
    options?: ReadOptions,
  ): Promise<EpisodeDeletionPreview>
  /** Request-bound operationId: an identical settled request replays its stored result. */
  deleteEpisodes(
    input: DeleteEpisodesInput,
    options?: OperationOptions,
  ): Promise<BulkDeletionReport>
  /** Resumes a running bound marker; settled operationId reuse is always rejected. */
  hardPurge(input: PurgeInput, options?: OperationOptions): Promise<PurgeReport>
  /** Accepts cancellation only; success deletes the operation journal with the space. */
  resetSpace(input: ResetSpaceInput, options?: ReadOptions): Promise<ResetSpaceReport>
  export(request: ExportRequest, options?: ReadOptions): Promise<MemoryExport>
  /** Committed import is fresh-only; dry-run import rejects operationId. */
  import(value: MemoryExport, options?: ImportOptions): Promise<ImportReport>
  /** operationId seeds a request-bound, resumable checkpoint-build session. */
  createSyncCheckpoint(
    request: CreateSyncCheckpointRequest,
    options?: OperationOptions,
  ): Promise<SyncCheckpoint>
  compactSyncHistory(
    request: CompactSyncHistoryRequest,
    options?: ReadOptions,
  ): Promise<CompactSyncHistoryReport>
  syncHistory(request: SyncHistoryRequest, options?: ReadOptions): Promise<SyncHistoryPage>
  syncHead(access: AccessContext, options?: ReadOptions): Promise<SyncCheckpoint>
  syncCheckpoint(
    id: string,
    access: AccessContext,
    options?: ReadOptions,
  ): Promise<SyncCheckpoint | null>
  syncChunks(request: SyncChunksRequest, options?: ReadOptions): Promise<SyncChunkPage>
  exportSyncBundle(request: ExportSyncBundleRequest, options?: ReadOptions): Promise<SyncBundlePage>
  /** Resumes by explicit sessionId, or by the request-bound operationId-derived session. */
  syncFrom(
    peer: MemorySyncPeer,
    request: SyncFromRequest,
    options?: OperationOptions,
  ): Promise<SyncReport>
  syncStatus(
    sessionId: string,
    access: AccessContext,
    options?: ReadOptions,
  ): Promise<SyncReport | null>
  syncSessions(request: SyncSessionsRequest, options?: ReadOptions): Promise<SyncSessionsPage>
  compactSyncSessions(
    request: CompactSyncSessionsRequest,
    options?: ReadOptions,
  ): Promise<CompactSyncSessionsReport>
  syncConflicts(request: SyncConflictsRequest, options?: ReadOptions): Promise<SyncConflictPage>
  syncConflict(
    request: SyncConflictDetailRequest,
    options?: ReadOptions,
  ): Promise<SyncConflictDetail>
  /** Continues the existing sessionId; no separate caller operationId is accepted. */
  resolveSync(request: ResolveSyncRequest, options?: ReadOptions): Promise<SyncReport>
  /** Continues the existing sessionId; no separate caller operationId is accepted. */
  abortSync(request: AbortSyncRequest, options?: ReadOptions): Promise<SyncReport>
  /** Fresh-only operationId: reuse never means replay. */
  rebuildProjections(
    request?: RebuildRequest,
    options?: OperationOptions,
  ): Promise<MaintenanceReport>
  verifyIntegrity(options?: IntegrityOptions): Promise<IntegrityReport>
  stats(options?: ManagementOptions): Promise<MemoryStats>
  on<K extends MemoryEventName>(name: K, listener: (event: MemoryEventMap[K]) => void): Unsubscribe
}
