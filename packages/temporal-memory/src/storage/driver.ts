import type {
  DerivationWorkLimits,
  Derivation,
  Entity,
  Episode,
  EvidenceLink,
  ExplicitAssertionSet,
  Fact,
  JsonValue,
  JournalConsumer,
  JournalKind,
  LifecycleTransition,
  MemoryChange,
  MemoryChangePartition,
  MemoryChangePhase,
  MemorySignal,
  MemorySignalChange,
  MemorySignalChangeAction,
  MemorySignalChangePartition,
  MemoryStorage,
  Mention,
  Ontology,
  OperationKind,
  ProcessingOperation,
  ProviderLineage,
  SchemaMigration,
  SpaceInfo,
  StorageInspection,
  SyncCheckpoint,
  SyncRecord,
  SyncRecordKind,
  SyncSessionState,
  SyncStrategy,
} from '../types.ts'

import { MemoryError } from '../errors.ts'
import { assertInstant, assertJson, assertString } from '../internal/value.ts'

export const CANONICAL_SCHEMA_VERSION = '7'
/** One more than the facade's maximum supported chain, so overflow is observable and rejected. */
export const MAX_SCHEMA_MIGRATION_RECORDS = 17

export type ProjectionKind = 'lexical' | 'embedding' | 'summary'

export interface StoredProjectionSet {
  id: string
  generation: string
  sourceCanonicalRevision: number
  activatedAt: string
  operationId: string
}

export interface StoredSpace extends SpaceInfo {
  kind: 'space'
  spaceId: string
  /** Opaque incarnation nonce used to invalidate cursors after destructive reset/recreate. */
  generation: string
  revision: number
  /** Monotonic source-data revision; projection and operation-only commits do not advance it. */
  canonicalRevision?: number
  /** Monotonic physical commit revision, including sync metadata-only transactions. */
  metadataRevision?: number
  /** Highest revision intentionally removed from the package semantic journal. */
  changesCompactedThrough: number
  /** Highest revision intentionally removed from the package signal journal. */
  signalChangesCompactedThrough: number
  ontologyValue: Ontology
  /** Active, atomically switched projection set for each derived retrieval channel. */
  projectionSets?: Readonly<Partial<Record<ProjectionKind, StoredProjectionSet>>>
}

export interface StoredSchemaMigration extends SchemaMigration {
  spaceId: string
}

export interface StorageMigrationChange {
  spaceId: string
  expectedRevision: number
  expectedMetadataRevision: number
  expectedSchemaVersion: string
  migration: StoredSchemaMigration
  /** Additive defaults only; an already-present value is preserved. */
  defaults: Readonly<{
    metadataRevision?: number
    canonicalRevision?: number
    signalChangesCompactedThrough?: number
  }>
}

export interface StoredEpisode extends Episode {
  kindRecord: 'episode'
  assertions?: ExplicitAssertionSet
}

export interface StoredEntity extends Omit<Entity, 'aliases'> {
  kindRecord: 'entity'
  identifierFingerprints: readonly string[]
}

export interface StoredAlias {
  kindRecord: 'alias'
  id: string
  spaceId: string
  entityId: string
  value: string
  normalized: string
  types: readonly string[]
  identifiers: Readonly<Record<string, string>>
  identifierFingerprints: readonly string[]
  scopes: readonly string[]
  episodeIds: readonly string[]
  createdAt: string
}

export interface StoredMention extends Mention {
  kindRecord: 'mention'
}

export interface StoredFact extends Fact {
  kindRecord: 'fact'
  semanticKey: string
  supportScopes: readonly string[]
  scopeHash: string
}

export interface StoredEvidence extends EvidenceLink {
  kindRecord: 'evidence'
}

export interface StoredDerivation extends Derivation {
  kindRecord: 'derivation'
}

export interface StoredLifecycle extends LifecycleTransition {
  kindRecord: 'lifecycle'
  spaceId: string
  snapshot?: JsonValue
}

export interface StoredOperation extends ProcessingOperation {
  kindRecord: 'operation'
  /** Internal create-once incarnation; absent only on operations persisted before binding existed. */
  bindingId?: string
  /** Private facade incarnation used only to fence recovery of live pending/running work. */
  runtimeOwnerId?: string
  result?: JsonValue
}

export interface StoredMerge {
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

export interface StoredProjection {
  kindRecord: 'projection'
  id: string
  spaceId: string
  target: { kind: 'episode' | 'entity' | 'fact'; id: string }
  projectionKind: ProjectionKind
  /** Absent only for legacy projections created before atomic projection sets. */
  setId?: string
  scopes: readonly string[]
  /** Sorted unique classifications inherited from every retained source dependency. */
  sensitivities: readonly string[]
  scopeHash: string
  schemaVersion: string
  generation: string
  contentHash: string
  text?: string
  vector?: readonly number[]
  lineage?: ProviderLineage
  state: 'building' | 'ready' | 'stale' | 'failed'
  createdAt: string
}

export interface StoredPurge {
  kindRecord: 'purge'
  id: string
  spaceId: string
  state: 'pending' | 'running' | 'succeeded' | 'failed'
  targets: readonly { kind: 'episode' | 'entity' | 'fact' | 'space'; id: string }[]
  completedTargets: readonly string[]
  /** Absent only on purge markers persisted before idempotency tombstones were introduced. */
  idempotencyKeyHashes?: readonly string[]
  /** Absent only on purge markers persisted before operation input binding was introduced. */
  requestHash?: string
  /** Present only while a bounded purge is active; successful portable tombstones omit it. */
  workLimits?: Required<DerivationWorkLimits>
  createdAt: string
  updatedAt: string
  operationId: string
}

export interface StoredChange extends MemoryChange {
  kindRecord: 'change'
  id: string
}

export type StoredSignal = MemorySignal & { kindRecord: 'signal' }

export interface StoredSignalChange extends MemorySignalChange {
  kindRecord: 'signal_change'
  id: string
}

export interface StoredJournalConsumer extends Omit<JournalConsumer, 'id'> {
  kindRecord: 'journal_consumer'
  /** Opaque physical identity; the public stable identifier is `consumerId`. */
  id: string
  spaceId: string
  consumerId: string
}

/** Per-journal epoch used to reject compaction across registry membership/checkpoint races. */
export interface StoredJournalRegistry {
  kindRecord: 'journal_registry'
  id: string
  spaceId: string
  journal: JournalKind
  version: number
  updatedAt: string
}

export interface StoredSyncCheckpoint extends SyncCheckpoint {
  kindRecord: 'sync_checkpoint'
  /** Local staging owner; intentionally absent from the portable checkpoint header. */
  chunkOwnerId?: string
  /** Local payload lifecycle; absent records from protocol v1 are inferred from `chunkOwnerId`. */
  payloadState?: 'available' | 'pruning' | 'pruned'
  /** Durable cleanup pointer used only while bounded physical reclamation is incomplete. */
  pruningOwnerId?: string
  sourceRevision: number
}

export interface StoredSyncChunk {
  kindRecord: 'sync_chunk'
  id: string
  spaceId: string
  ownerId: string
  index: number
  digest: string
  byteLength: number
  firstKey: string
  lastKey: string
  records: readonly SyncRecord[]
}

/** Small random-access index over a bounded sync chunk; payload is not duplicated here. */
export interface StoredSyncIndex {
  kindRecord: 'sync_index'
  id: string
  spaceId: string
  ownerId: string
  syncKey: string
  recordKind: SyncRecordKind
  recordId: string
  digest: string
  byteLength: number
  chunkIndex: number
  idempotencyKey?: string
  semanticKey?: string
  logicalKey?: string
  version?: number
  state?: string
  episodeId?: string
  entityId?: string
  subjectId?: string
  predicate?: string
  targetKind?: string
  targetId?: string
  conclusionFactId?: string
  premiseFactIds?: readonly string[]
  premiseEvidenceIds?: readonly string[]
  identifierFingerprints?: readonly string[]
  scopeHash?: string
}

export interface StoredSyncRef {
  kindRecord: 'sync_ref'
  id: 'head'
  spaceId: string
  head: string
  updatedAt: string
}

export interface StoredSyncSession {
  kindRecord: 'sync_session'
  id: string
  spaceId: string
  mode: 'checkpoint' | 'pull'
  state: SyncSessionState | 'building'
  requestHash: string
  strategy: SyncStrategy
  createdAt: string
  updatedAt: string
  snapshotRevision: number
  parentHead?: string
  cursorKindIndex?: number
  cursorId?: string
  maxChunkBytes?: number
  rootDigest?: string
  chunkCount: number
  recordCount: number
  byteLength: number
  scopes: readonly string[]
  /** Complete disclosure boundary for status, conflict, resolution, and abort APIs. */
  requiredScopes: readonly string[]
  /** Exact normalized access grant bound to the originating request. */
  requestScopes: readonly string[]
  /** Logical revision at which the request was admitted. */
  initialRevision: number
  /** Pull-only ancestry and aggregate checkpoint limits, persisted for deterministic resume. */
  ancestryLimit?: number
  receiveLimits?: {
    maxBytes: number
    maxRecords: number
    maxChunks: number
  }
  checkpointId?: string
  localHead?: string
  remoteHead?: string
  baseCheckpoint?: string
  targetCheckpoint?: string
  planOwnerId?: string
  planAttempt?: number
  planRootDigest?: string
  planChunkCount?: number
  planRecordCount?: number
  planByteLength?: number
  planScopes?: readonly string[]
  receivedChunks: number
  conflictCount: number
  appliedRecords: number
  deletedRecords: number
  purgeDominatedRecords: number
  applyLocalKey?: string
  applyTargetKey?: string
  applyProjectionCursor?: string
  rollback?: boolean
  operationId?: string
  /** Absent only on sessions persisted before bounded diagnostics existed. */
  diagnosticsTruncated?: boolean
  warnings: readonly string[]
  error?: string
  /** Local terminal-detail lifecycle; absent records are treated as available. */
  detailsState?: 'available' | 'pruning' | 'pruned'
}

export interface StoredSyncConflict {
  kindRecord: 'sync_conflict'
  id: string
  spaceId: string
  sessionId: string
  syncKey: string
  recordKind: SyncRecordKind
  recordId: string
  reason: 'both_modified' | 'delete_modify' | 'invalid_combination'
  baseDigest?: string
  localDigest?: string
  remoteDigest?: string
  resolution?: 'local' | 'remote' | 'delete'
}

export interface StoredSyncTombstone {
  kindRecord: 'sync_tombstone'
  id: string
  spaceId: string
  sessionId: string
  tombstoneKind: 'target' | 'idempotency'
  digest: string
}

export type StoredRecord =
  | StoredEpisode
  | StoredEntity
  | StoredAlias
  | StoredMention
  | StoredFact
  | StoredEvidence
  | StoredDerivation
  | StoredLifecycle
  | StoredOperation
  | StoredMerge
  | StoredProjection
  | StoredPurge
  | StoredChange
  | StoredSignal
  | StoredSignalChange
  | StoredJournalConsumer
  | StoredJournalRegistry
  | StoredSyncCheckpoint
  | StoredSyncChunk
  | StoredSyncIndex
  | StoredSyncRef
  | StoredSyncSession
  | StoredSyncConflict
  | StoredSyncTombstone

export type StoredRecordKind = StoredRecord['kindRecord']

export type RecordOfKind<K extends StoredRecordKind> = Extract<StoredRecord, { kindRecord: K }>

export const SYNC_METADATA_KINDS = new Set<StoredRecordKind>([
  'sync_checkpoint',
  'sync_chunk',
  'sync_index',
  'sync_ref',
  'sync_session',
  'sync_conflict',
  'sync_tombstone',
])

/** Non-portable operational rows allowed in metadata-only commits and metadata guards. */
export const LOCAL_METADATA_KINDS = new Set<StoredRecordKind>([
  ...SYNC_METADATA_KINDS,
  'journal_consumer',
  'journal_registry',
])

export type StorageFilter =
  | { field: string; op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'; value: JsonValue }
  | { field: string; op: 'in'; value: readonly JsonValue[] }
  | { field: string; op: 'contains'; value: JsonValue }
  | { field: string; op: 'defined' }
  | {
      field: string
      op: 'all_inside' | 'contains_all' | 'contains_any' | 'contains_none'
      value: readonly JsonValue[]
    }

export interface StorageQuery<K extends StoredRecordKind = StoredRecordKind> {
  kind: K
  spaceId: string
  filters?: readonly StorageFilter[]
  order?: readonly { field: string; direction: 'asc' | 'desc' }[]
  /** Strict lexicographic boundary corresponding one-for-one with `order`. */
  startAfter?: readonly JsonValue[]
  /** Facade calls require this structurally; optionality is retained for adapter-local tooling. */
  limit?: number
}

export interface StorageCountQuery<K extends StoredRecordKind = StoredRecordKind> {
  kind: K
  spaceId: string
  filters?: readonly StorageFilter[]
}

export interface StorageCommit {
  spaceId: string
  expectedRevision: number
  /** Optional source-data CAS guard for long-running derived-index work. */
  expectedCanonicalRevision?: number
  puts?: readonly StoredRecord[]
  deletes?: readonly { kind: StoredRecordKind; id: string }[]
  /** Atomically delete every retained signal revision for these ordered logical keys. */
  signalKeyDeletes?: readonly string[]
  semanticChange?: StorageSemanticChange
  /** Atomically remove semantic changes at or below this monotonic revision floor. */
  changeCompaction?: { throughRevision: number }
  signalChange?: StorageSignalChange
  /** Atomically remove signal changes at or below this monotonic revision floor. */
  signalChangeCompaction?: { throughRevision: number }
  /** Local operational metadata is CAS-guarded but does not advance the logical memory revision. */
  metadataOnly?: boolean
  /** Exact payload guards enforced in the same transaction as either logical or metadata work. */
  metadataGuards?: readonly {
    kind: StoredRecordKind
    id: string
    expected: StoredRecord | null
  }[]
  /** Atomically changes the active derived projection sets with this commit. */
  projectionSetActivations?: readonly {
    kind: ProjectionKind
    set: StoredProjectionSet
  }[]
}

export interface StorageSemanticChange {
  operationId: string
  operationKind: OperationKind
  phase: MemoryChangePhase
  partitions: readonly MemoryChangePartition[]
}

export interface StorageSignalChange {
  action: MemorySignalChangeAction
  partitions: readonly MemorySignalChangePartition[]
}

const CANONICAL_RECORD_KINDS = new Set<StoredRecordKind>([
  'episode',
  'entity',
  'alias',
  'mention',
  'fact',
  'evidence',
  'derivation',
  'lifecycle',
  'merge',
])

const OPERATION_KINDS = new Set<OperationKind>([
  'ingest',
  'reprocess',
  'correct',
  'retract',
  'delete',
  'purge',
  'export',
  'import',
  'migrate',
  'rebuild',
  'merge',
  'split',
  'derive',
  'sync',
])

const CHANGE_PHASES = new Set<MemoryChangePhase>([
  'accepted',
  'canonical',
  'governance',
  'import',
  'purge',
  'sync',
])

function assertOrderedUniqueStrings(values: readonly string[], field: string): void {
  if (!Array.isArray(values)) {
    throw new MemoryError('integrity_failed', `${field} must be an array`)
  }
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new MemoryError('integrity_failed', `${field}[${index}] must be a non-empty string`)
    }
    if (index > 0 && values[index - 1]! >= value) {
      throw new MemoryError('integrity_failed', `${field} must be sorted and unique`)
    }
  }
}

function assertProjectionSetShape(set: StoredProjectionSet, field: string): void {
  for (const [value, name] of [
    [set.id, `${field}.id`],
    [set.generation, `${field}.generation`],
    [set.activatedAt, `${field}.activatedAt`],
    [set.operationId, `${field}.operationId`],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new MemoryError('integrity_failed', `${name} is required`)
    }
  }
  if (!Number.isSafeInteger(set.sourceCanonicalRevision) || set.sourceCanonicalRevision < 0) {
    throw new MemoryError('integrity_failed', `${field}.sourceCanonicalRevision is invalid`)
  }
  try {
    assertInstant(set.activatedAt, `${field}.activatedAt`)
  } catch (error) {
    throw new MemoryError('integrity_failed', `${field}.activatedAt is invalid`, { cause: error })
  }
}

export function assertStorageMigrationChange(change: StorageMigrationChange): void {
  if (
    typeof change !== 'object' ||
    change === null ||
    typeof change.spaceId !== 'string' ||
    change.spaceId.length === 0 ||
    !Number.isSafeInteger(change.expectedRevision) ||
    change.expectedRevision < 0 ||
    !Number.isSafeInteger(change.expectedMetadataRevision) ||
    change.expectedMetadataRevision < 0 ||
    typeof change.expectedSchemaVersion !== 'string' ||
    change.expectedSchemaVersion.length === 0
  ) {
    throw new MemoryError('integrity_failed', 'schema migration guard is invalid')
  }
  const migration = change.migration
  if (
    typeof migration !== 'object' ||
    migration === null ||
    migration.spaceId !== change.spaceId ||
    typeof migration.id !== 'string' ||
    migration.id.length === 0 ||
    !Number.isSafeInteger(migration.sequence) ||
    migration.sequence < 1 ||
    migration.fromSchemaVersion !== change.expectedSchemaVersion ||
    typeof migration.toSchemaVersion !== 'string' ||
    migration.toSchemaVersion.length === 0 ||
    migration.toSchemaVersion === migration.fromSchemaVersion ||
    !/^[a-f0-9]{64}$/u.test(migration.checksum) ||
    migration.state !== 'succeeded'
  ) {
    throw new MemoryError('integrity_failed', 'schema migration checkpoint is invalid')
  }
  try {
    assertInstant(migration.appliedAt, 'migration.appliedAt')
  } catch (error) {
    throw new MemoryError('integrity_failed', 'schema migration time is invalid', { cause: error })
  }
  if (typeof change.defaults !== 'object' || change.defaults === null) {
    throw new MemoryError('integrity_failed', 'schema migration defaults are invalid')
  }
  const allowedDefaults = new Set([
    'metadataRevision',
    'canonicalRevision',
    'signalChangesCompactedThrough',
  ])
  for (const [field, value] of Object.entries(change.defaults)) {
    if (!allowedDefaults.has(field) || !Number.isSafeInteger(value) || Number(value) < 0) {
      throw new MemoryError('integrity_failed', `schema migration default is invalid: ${field}`)
    }
  }
}

function assertStoredSignalShape(signal: StoredSignal, expectedRevision: number): void {
  const requiredStrings: readonly [unknown, string][] = [
    [signal.id, 'signal.id'],
    [signal.spaceId, 'signal.spaceId'],
    [signal.key, 'signal.key'],
    [signal.namespace, 'signal.namespace'],
    [signal.slot, 'signal.slot'],
    [signal.target.id, 'signal.target.id'],
    [signal.producer.id, 'signal.producer.id'],
    [signal.producer.version, 'signal.producer.version'],
    [signal.recordedAt, 'signal.recordedAt'],
  ]
  for (const [value, field] of requiredStrings) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new MemoryError('integrity_failed', `${field} is required`)
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(signal.key)) {
    throw new MemoryError('integrity_failed', 'signal.key must be a lowercase SHA-256 digest')
  }
  if (!['episode', 'entity', 'fact'].includes(signal.target.kind)) {
    throw new MemoryError('integrity_failed', 'signal target kind is invalid')
  }
  if (!['manual', 'algorithm'].includes(signal.producer.kind)) {
    throw new MemoryError('integrity_failed', 'signal producer kind is invalid')
  }
  if (!Number.isInteger(signal.version) || signal.version < 1) {
    throw new MemoryError('integrity_failed', 'signal version is invalid')
  }
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new MemoryError('integrity_failed', 'signal expected revision is invalid')
  }
  if (
    signal.id !== `signal_${signal.key}_${signal.version.toString().padStart(8, '0')}` ||
    signal.recordedRevision !== expectedRevision + 1 ||
    signal.inputRevision !== expectedRevision
  ) {
    throw new MemoryError('integrity_failed', 'signal revision lineage is invalid')
  }
  if (
    (signal.version === 1 && signal.supersedes !== undefined) ||
    (signal.version > 1 &&
      (typeof signal.supersedes !== 'string' || signal.supersedes.length === 0))
  ) {
    throw new MemoryError('integrity_failed', 'signal supersession lineage is invalid')
  }
  if (
    !['current', 'valid-at', 'known-at', 'history'].includes(signal.basisView.kind) ||
    ((signal.basisView.kind === 'valid-at' || signal.basisView.kind === 'known-at') &&
      (typeof signal.basisView.at !== 'string' || signal.basisView.at.length === 0))
  ) {
    throw new MemoryError('integrity_failed', 'signal basis view is invalid')
  }
  try {
    assertInstant(signal.recordedAt, 'signal.recordedAt')
    if (signal.basisView.kind === 'valid-at' || signal.basisView.kind === 'known-at') {
      assertInstant(signal.basisView.at, 'signal.basisView.at')
    }
  } catch (error) {
    throw new MemoryError('integrity_failed', 'signal time lineage is invalid', { cause: error })
  }
  assertOrderedUniqueStrings(signal.scopes, 'signal.scopes')
  assertOrderedUniqueStrings(signal.tags, 'signal.tags')
  assertOrderedUniqueStrings(signal.basis.episodeIds, 'signal.basis.episodeIds')
  assertOrderedUniqueStrings(signal.basis.entityIds, 'signal.basis.entityIds')
  assertOrderedUniqueStrings(signal.basis.factIds, 'signal.basis.factIds')
  if (
    signal.producer.kind === 'algorithm' &&
    signal.basis.episodeIds.length + signal.basis.entityIds.length + signal.basis.factIds.length ===
      0
  ) {
    throw new MemoryError('integrity_failed', 'algorithm signal basis is required')
  }
  if (signal.state === 'active') {
    if (!Object.hasOwn(signal, 'value')) {
      throw new MemoryError('integrity_failed', 'active signal value is required')
    }
    if (Object.hasOwn(signal, 'withdrawalReason')) {
      throw new MemoryError('integrity_failed', 'active signal cannot have a withdrawal reason')
    }
    try {
      assertJson(signal.value, 'signal.value')
      if (signal.expiresAt !== undefined) assertInstant(signal.expiresAt, 'signal.expiresAt')
    } catch (error) {
      throw new MemoryError('integrity_failed', 'active signal payload is invalid', {
        cause: error,
      })
    }
  } else if (signal.state === 'withdrawn') {
    if (Object.hasOwn(signal, 'value') || Object.hasOwn(signal, 'expiresAt')) {
      throw new MemoryError('integrity_failed', 'withdrawn signal cannot retain a value or expiry')
    }
    if (
      signal.withdrawalReason !== undefined &&
      (typeof signal.withdrawalReason !== 'string' || signal.withdrawalReason.length === 0)
    ) {
      throw new MemoryError('integrity_failed', 'signal withdrawal reason is invalid')
    }
  } else {
    throw new MemoryError('integrity_failed', 'signal state is invalid')
  }
}

function assertStoredDerivationShape(derivation: StoredDerivation, expectedRevision: number): void {
  for (const [value, field] of [
    [derivation.id, 'derivation.id'],
    [derivation.spaceId, 'derivation.spaceId'],
    [derivation.key, 'derivation.key'],
    [derivation.conclusionFactId, 'derivation.conclusionFactId'],
    [derivation.rule.id, 'derivation.rule.id'],
    [derivation.rule.version, 'derivation.rule.version'],
    [derivation.recordedAt, 'derivation.recordedAt'],
    [derivation.operationId, 'derivation.operationId'],
  ] as const) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new MemoryError('integrity_failed', `${field} is required`)
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(derivation.key)) {
    throw new MemoryError('integrity_failed', 'derivation.key must be a lowercase SHA-256 digest')
  }
  if (!Number.isInteger(derivation.version) || derivation.version < 1) {
    throw new MemoryError('integrity_failed', 'derivation version is invalid')
  }
  if (
    derivation.id !==
      `derivation_${derivation.key}_${derivation.version.toString().padStart(8, '0')}` ||
    derivation.inputRevision !== expectedRevision ||
    derivation.recordedRevision !== expectedRevision + 1
  ) {
    throw new MemoryError('integrity_failed', 'derivation revision lineage is invalid')
  }
  if (
    (derivation.version === 1 && derivation.supersedes !== undefined) ||
    (derivation.version > 1 &&
      (typeof derivation.supersedes !== 'string' || derivation.supersedes.length === 0))
  ) {
    throw new MemoryError('integrity_failed', 'derivation supersession lineage is invalid')
  }
  if (!['host', 'deterministic', 'model'].includes(derivation.method)) {
    throw new MemoryError('integrity_failed', 'derivation method is invalid')
  }
  if ((derivation.method === 'model') !== (derivation.provider !== undefined)) {
    throw new MemoryError('integrity_failed', 'derivation provider lineage is inconsistent')
  }
  if (derivation.provider !== undefined && derivation.provider.capability !== 'inference') {
    throw new MemoryError('integrity_failed', 'derivation provider must be inference lineage')
  }
  try {
    assertInstant(derivation.recordedAt, 'derivation.recordedAt')
  } catch (error) {
    throw new MemoryError('integrity_failed', 'derivation recordedAt is invalid', { cause: error })
  }
  assertOrderedUniqueStrings(derivation.scopes, 'derivation.scopes')
  if (!Array.isArray(derivation.premises) || derivation.premises.length === 0) {
    throw new MemoryError('integrity_failed', 'derivation premises are required')
  }
  let previousPremise: string | undefined
  for (const [index, premise] of derivation.premises.entries()) {
    if (
      premise === null ||
      typeof premise !== 'object' ||
      !['fact', 'evidence'].includes(premise.kind) ||
      typeof premise.id !== 'string' ||
      premise.id.length === 0
    ) {
      throw new MemoryError('integrity_failed', `derivation.premises[${index}] is invalid`)
    }
    const key = `${premise.kind}\u0000${premise.id}`
    if (previousPremise !== undefined && previousPremise >= key) {
      throw new MemoryError('integrity_failed', 'derivation premises must be sorted and unique')
    }
    previousPremise = key
  }
  if (derivation.state === 'active') {
    if (derivation.invalidPremises !== undefined || derivation.reason !== undefined) {
      throw new MemoryError('integrity_failed', 'active derivation cannot carry invalidation data')
    }
    return
  }
  if (derivation.reason !== undefined && derivation.reason.length === 0) {
    throw new MemoryError('integrity_failed', 'derivation reason is invalid')
  }
  if (derivation.state === 'invalidated') {
    if (!Array.isArray(derivation.invalidPremises) || derivation.invalidPremises.length === 0) {
      throw new MemoryError('integrity_failed', 'invalidated derivation requires invalid premises')
    }
    const premiseKeys = new Set(
      derivation.premises.map((premise) => `${premise.kind}\u0000${premise.id}`),
    )
    let previousInvalidPremise: string | undefined
    for (const [index, premise] of derivation.invalidPremises.entries()) {
      if (
        premise === null ||
        typeof premise !== 'object' ||
        !['fact', 'evidence'].includes(premise.kind) ||
        typeof premise.id !== 'string' ||
        premise.id.length === 0
      ) {
        throw new MemoryError('integrity_failed', `derivation.invalidPremises[${index}] is invalid`)
      }
      const key = `${premise.kind}\u0000${premise.id}`
      if (
        !premiseKeys.has(key) ||
        (previousInvalidPremise !== undefined && previousInvalidPremise >= key)
      ) {
        throw new MemoryError(
          'integrity_failed',
          'invalid derivation premises must be a sorted subset of premises',
        )
      }
      previousInvalidPremise = key
    }
    return
  }
  if (derivation.state !== 'withdrawn' || derivation.invalidPremises !== undefined) {
    throw new MemoryError('integrity_failed', 'derivation state is invalid')
  }
}

function assertStoredJournalConsumerShape(consumer: StoredJournalConsumer): void {
  if (
    typeof consumer.id !== 'string' ||
    !/^journal_consumer_(semantic|signal)_[a-f0-9]{64}$/u.test(consumer.id) ||
    typeof consumer.spaceId !== 'string' ||
    consumer.spaceId.length === 0 ||
    typeof consumer.cursor !== 'string' ||
    consumer.cursor.length === 0 ||
    consumer.cursor.length > 4_096 ||
    !['semantic', 'signal'].includes(consumer.journal) ||
    !['active', 'retired'].includes(consumer.state) ||
    !Number.isSafeInteger(consumer.throughRevision) ||
    consumer.throughRevision < 0 ||
    typeof consumer.registeredAt !== 'string' ||
    typeof consumer.acknowledgedAt !== 'string'
  ) {
    throw new MemoryError('integrity_failed', 'journal consumer is invalid')
  }
  try {
    assertString(consumer.consumerId, 'journalConsumer.consumerId', 128)
  } catch {
    throw new MemoryError('integrity_failed', 'journal consumer identifier is invalid')
  }
  try {
    assertInstant(consumer.registeredAt, 'journalConsumer.registeredAt')
    assertInstant(consumer.acknowledgedAt, 'journalConsumer.acknowledgedAt')
    if (consumer.retiredAt !== undefined) {
      assertInstant(consumer.retiredAt, 'journalConsumer.retiredAt')
    }
  } catch (error) {
    throw new MemoryError('integrity_failed', 'journal consumer time is invalid', { cause: error })
  }
  if (
    (consumer.state === 'active' && consumer.retiredAt !== undefined) ||
    (consumer.state === 'retired' && consumer.retiredAt === undefined)
  ) {
    throw new MemoryError('integrity_failed', 'journal consumer retirement state is invalid')
  }
}

function assertStoredJournalRegistryShape(registry: StoredJournalRegistry): void {
  if (
    !['semantic', 'signal'].includes(registry.journal) ||
    registry.id !== `journal_registry_${registry.journal}` ||
    typeof registry.spaceId !== 'string' ||
    registry.spaceId.length === 0 ||
    !Number.isSafeInteger(registry.version) ||
    registry.version < 1 ||
    typeof registry.updatedAt !== 'string'
  ) {
    throw new MemoryError('integrity_failed', 'journal registry is invalid')
  }
  try {
    assertInstant(registry.updatedAt, 'journalRegistry.updatedAt')
  } catch (error) {
    throw new MemoryError('integrity_failed', 'journal registry time is invalid', { cause: error })
  }
}

/** Enforces the semantic and signal journal contracts at every built-in storage boundary. */
export function assertStorageCommitSemantics(commit: StorageCommit): void {
  if (
    commit.expectedCanonicalRevision !== undefined &&
    (!Number.isSafeInteger(commit.expectedCanonicalRevision) ||
      commit.expectedCanonicalRevision < 0)
  ) {
    throw new MemoryError('integrity_failed', 'expected canonical revision is invalid')
  }
  const projectionKinds = new Set<ProjectionKind>()
  for (const [index, activation] of (commit.projectionSetActivations ?? []).entries()) {
    if (!['lexical', 'embedding', 'summary'].includes(activation.kind)) {
      throw new MemoryError('integrity_failed', 'projection set kind is invalid')
    }
    if (projectionKinds.has(activation.kind)) {
      throw new MemoryError(
        'integrity_failed',
        'projection set activation contains duplicate kinds',
      )
    }
    projectionKinds.add(activation.kind)
    assertProjectionSetShape(activation.set, `projectionSetActivations[${index}].set`)
    if (
      commit.expectedCanonicalRevision === undefined ||
      activation.set.sourceCanonicalRevision !== commit.expectedCanonicalRevision
    ) {
      throw new MemoryError(
        'integrity_failed',
        'projection set activation requires its exact canonical source revision guard',
      )
    }
  }
  if ((commit.metadataGuards ?? []).some((guard) => !LOCAL_METADATA_KINDS.has(guard.kind))) {
    throw new MemoryError('integrity_failed', 'metadata guard contains a logical record')
  }
  if (commit.metadataOnly === true) {
    if (
      commit.semanticChange !== undefined ||
      commit.signalChange !== undefined ||
      commit.changeCompaction !== undefined ||
      commit.signalChangeCompaction !== undefined ||
      (commit.signalKeyDeletes?.length ?? 0) > 0 ||
      (commit.projectionSetActivations?.length ?? 0) > 0
    ) {
      throw new MemoryError(
        'integrity_failed',
        'metadata-only commit cannot mutate logical journals',
      )
    }
    const kinds = [
      ...(commit.puts ?? []).map((record) => record.kindRecord),
      ...(commit.deletes ?? []).map((record) => record.kind),
      ...(commit.metadataGuards ?? []).map((guard) => guard.kind),
    ]
    if (kinds.some((kind) => !LOCAL_METADATA_KINDS.has(kind))) {
      throw new MemoryError('integrity_failed', 'metadata-only commit contains logical records')
    }
  }
  if (commit.changeCompaction !== undefined) {
    if (
      !Number.isInteger(commit.changeCompaction.throughRevision) ||
      commit.changeCompaction.throughRevision < 0 ||
      commit.changeCompaction.throughRevision > commit.expectedRevision
    ) {
      throw new MemoryError('integrity_failed', 'semantic change compaction floor is invalid')
    }
    if (
      commit.semanticChange !== undefined ||
      commit.signalChange !== undefined ||
      commit.signalChangeCompaction !== undefined ||
      (commit.projectionSetActivations?.length ?? 0) > 0 ||
      (commit.signalKeyDeletes?.length ?? 0) > 0 ||
      (commit.puts?.length ?? 0) > 0 ||
      (commit.deletes?.length ?? 0) > 0
    ) {
      throw new MemoryError(
        'integrity_failed',
        'semantic change compaction cannot share a storage commit with other mutations',
      )
    }
  }
  if (commit.signalChangeCompaction !== undefined) {
    if (
      !Number.isInteger(commit.signalChangeCompaction.throughRevision) ||
      commit.signalChangeCompaction.throughRevision < 0 ||
      commit.signalChangeCompaction.throughRevision > commit.expectedRevision
    ) {
      throw new MemoryError('integrity_failed', 'signal change compaction floor is invalid')
    }
    if (
      commit.semanticChange !== undefined ||
      commit.changeCompaction !== undefined ||
      commit.signalChange !== undefined ||
      (commit.projectionSetActivations?.length ?? 0) > 0 ||
      (commit.signalKeyDeletes?.length ?? 0) > 0 ||
      (commit.puts?.length ?? 0) > 0 ||
      (commit.deletes?.length ?? 0) > 0
    ) {
      throw new MemoryError(
        'integrity_failed',
        'signal change compaction cannot share a storage commit with other mutations',
      )
    }
  }
  const canonicalMutation = [
    ...(commit.puts ?? []).map((record) => record.kindRecord),
    ...(commit.deletes ?? []).map((record) => record.kind),
  ].some((kind) => CANONICAL_RECORD_KINDS.has(kind))
  const signalPuts = (commit.puts ?? []).filter(
    (record): record is StoredSignal => record.kindRecord === 'signal',
  )
  const derivationPuts = (commit.puts ?? []).filter(
    (record): record is StoredDerivation => record.kindRecord === 'derivation',
  )
  const projectionPuts = (commit.puts ?? []).filter(
    (record): record is StoredProjection => record.kindRecord === 'projection',
  )
  const journalConsumerPuts = (commit.puts ?? []).filter(
    (record): record is StoredJournalConsumer => record.kindRecord === 'journal_consumer',
  )
  const journalRegistryPuts = (commit.puts ?? []).filter(
    (record): record is StoredJournalRegistry => record.kindRecord === 'journal_registry',
  )
  const journalConsumerDeletes = (commit.deletes ?? []).filter(
    (record) => record.kind === 'journal_consumer' || record.kind === 'journal_registry',
  )
  const signalDeletes = (commit.deletes ?? []).filter((record) => record.kind === 'signal')
  const signalKeyDeletes = commit.signalKeyDeletes ?? []
  if (commit.signalKeyDeletes !== undefined && signalKeyDeletes.length === 0) {
    throw new MemoryError('integrity_failed', 'signalKeyDeletes must not be empty')
  }
  if (signalKeyDeletes.length > 0) {
    assertOrderedUniqueStrings(signalKeyDeletes, 'signalKeyDeletes')
    if (signalKeyDeletes.some((key) => !/^[a-f0-9]{64}$/u.test(key))) {
      throw new MemoryError('integrity_failed', 'signalKeyDeletes contains an invalid logical key')
    }
    if (signalKeyDeletes.length > 10_000) {
      throw new MemoryError('integrity_failed', 'signalKeyDeletes exceeds 10000 logical keys')
    }
    if (signalPuts.length > 0 || signalDeletes.length > 0) {
      throw new MemoryError(
        'integrity_failed',
        'signal key deletion cannot mix with signal revision puts or deletes',
      )
    }
  }
  const signalJournalMutation = [
    ...(commit.puts ?? []).map((record) => record.kindRecord),
    ...(commit.deletes ?? []).map((record) => record.kind),
  ].some((kind) => kind === 'signal_change')
  if (
    signalPuts.some((signal) => signal.state === 'active') &&
    commit.semanticChange !== undefined
  ) {
    throw new MemoryError(
      'integrity_failed',
      'active non-epistemic signal revisions cannot share a semantic canonical commit',
    )
  }
  const signalKeys = new Set<string>()
  for (const signal of signalPuts) {
    assertStoredSignalShape(signal, commit.expectedRevision)
    if (signalKeys.has(signal.key)) {
      throw new MemoryError('integrity_failed', 'signal commit contains duplicate logical keys')
    }
    signalKeys.add(signal.key)
  }
  const derivationKeys = new Set<string>()
  for (const derivation of derivationPuts) {
    assertStoredDerivationShape(derivation, commit.expectedRevision)
    if (derivationKeys.has(derivation.key)) {
      throw new MemoryError('integrity_failed', 'derivation commit contains duplicate logical keys')
    }
    derivationKeys.add(derivation.key)
  }
  for (const projection of projectionPuts) {
    assertOrderedUniqueStrings(projection.scopes, 'projection.scopes')
    assertOrderedUniqueStrings(projection.sensitivities, 'projection.sensitivities')
    if (projection.sensitivities.some((value) => value.length > 128)) {
      throw new MemoryError(
        'integrity_failed',
        'projection sensitivity labels must contain at most 128 characters',
      )
    }
  }
  for (const consumer of journalConsumerPuts) assertStoredJournalConsumerShape(consumer)
  for (const registry of journalRegistryPuts) assertStoredJournalRegistryShape(registry)
  if (journalConsumerPuts.length > 0 || journalRegistryPuts.length > 0) {
    if (
      commit.metadataOnly !== true ||
      journalConsumerPuts.length !== 1 ||
      journalRegistryPuts.length !== 1 ||
      journalConsumerPuts[0]!.journal !== journalRegistryPuts[0]!.journal
    ) {
      throw new MemoryError(
        'integrity_failed',
        'journal consumer mutation requires one consumer and its registry epoch',
      )
    }
    const guarded = new Set(
      (commit.metadataGuards ?? []).map((guard) => `${guard.kind}\u0000${guard.id}`),
    )
    if (
      !guarded.has(`journal_consumer\u0000${journalConsumerPuts[0]!.id}`) ||
      !guarded.has(`journal_registry\u0000${journalRegistryPuts[0]!.id}`)
    ) {
      throw new MemoryError(
        'integrity_failed',
        'journal consumer mutation requires exact consumer and registry guards',
      )
    }
  }
  if (journalConsumerDeletes.length > 0) {
    throw new MemoryError(
      'integrity_failed',
      'journal consumer rows are retired in place and deleted only by whole-space reset',
    )
  }
  if (
    (signalPuts.length > 0 || signalDeletes.length > 0 || signalKeyDeletes.length > 0) &&
    commit.signalChange === undefined
  ) {
    throw new MemoryError(
      'integrity_failed',
      'signal storage mutation is missing its signal change record',
    )
  }
  if (signalJournalMutation && commit.signalChange === undefined) {
    throw new MemoryError(
      'integrity_failed',
      'signal journal mutation is missing its signal change record',
    )
  }
  if (canonicalMutation && commit.semanticChange === undefined) {
    throw new MemoryError(
      'integrity_failed',
      'canonical storage mutation is missing its semantic change record',
    )
  }
  const change = commit.semanticChange
  if (change !== undefined) {
    if (typeof change.operationId !== 'string' || change.operationId.length === 0) {
      throw new MemoryError('integrity_failed', 'semantic change operationId is required')
    }
    if (!OPERATION_KINDS.has(change.operationKind)) {
      throw new MemoryError('integrity_failed', 'semantic change operationKind is invalid')
    }
    if (!CHANGE_PHASES.has(change.phase)) {
      throw new MemoryError('integrity_failed', 'semantic change phase is invalid')
    }
    if (!Array.isArray(change.partitions) || change.partitions.length === 0) {
      throw new MemoryError('integrity_failed', 'semantic change requires a disclosure partition')
    }
    const scopeKeys = new Set<string>()
    for (const [index, partition] of change.partitions.entries()) {
      assertOrderedUniqueStrings(partition.scopes, `semanticChange.partitions[${index}].scopes`)
      const scopeKey = JSON.stringify(partition.scopes)
      if (scopeKeys.has(scopeKey)) {
        throw new MemoryError('integrity_failed', 'semantic change contains duplicate partitions')
      }
      scopeKeys.add(scopeKey)
      assertOrderedUniqueStrings(
        partition.affected.episodeIds,
        `semanticChange.partitions[${index}].affected.episodeIds`,
      )
      assertOrderedUniqueStrings(
        partition.affected.entityIds,
        `semanticChange.partitions[${index}].affected.entityIds`,
      )
      assertOrderedUniqueStrings(
        partition.affected.factIds,
        `semanticChange.partitions[${index}].affected.factIds`,
      )
      const affectedCount =
        partition.affected.episodeIds.length +
        partition.affected.entityIds.length +
        partition.affected.factIds.length
      if (partition.invalidated === true && affectedCount !== 0) {
        throw new MemoryError(
          'integrity_failed',
          'invalidated semantic change partitions must not disclose target identifiers',
        )
      }
      if (partition.invalidated !== true && affectedCount === 0) {
        throw new MemoryError(
          'integrity_failed',
          'semantic change partition has no affected targets',
        )
      }
    }
  }

  const signalChange = commit.signalChange
  if (signalChange === undefined) return
  if (!['put', 'withdraw', 'purge'].includes(signalChange.action)) {
    throw new MemoryError('integrity_failed', 'signal change action is invalid')
  }
  if (!Array.isArray(signalChange.partitions) || signalChange.partitions.length === 0) {
    throw new MemoryError('integrity_failed', 'signal change requires a disclosure partition')
  }
  if (signalChange.action === 'put' && signalPuts.some((signal) => signal.state !== 'active')) {
    throw new MemoryError('integrity_failed', 'put signal change contains a non-active revision')
  }
  if (
    signalChange.action === 'withdraw' &&
    signalPuts.some((signal) => signal.state !== 'withdrawn')
  ) {
    throw new MemoryError(
      'integrity_failed',
      'withdraw signal change contains a non-withdrawn revision',
    )
  }
  if (signalChange.action === 'purge' && signalPuts.length > 0) {
    throw new MemoryError('integrity_failed', 'purge signal change cannot put signal revisions')
  }
  if (signalKeyDeletes.length > 0 && signalChange.action !== 'purge') {
    throw new MemoryError('integrity_failed', 'signal key deletion requires a purge signal change')
  }
  const expectedKeys = new Set([
    ...signalPuts.map((signal) => signal.key),
    ...signalKeyDeletes,
    ...signalDeletes.flatMap((deletion) => {
      const match = /^signal_([a-f0-9]{64})_[0-9]{8}$/u.exec(deletion.id)
      return match === null ? [] : [match[1]!]
    }),
  ])
  const disclosedKeys = new Set<string>()
  const signalScopeKeys = new Set<string>()
  let invalidated = false
  for (const [index, partition] of signalChange.partitions.entries()) {
    assertOrderedUniqueStrings(partition.scopes, `signalChange.partitions[${index}].scopes`)
    const scopeKey = JSON.stringify(partition.scopes)
    if (signalScopeKeys.has(scopeKey)) {
      throw new MemoryError('integrity_failed', 'signal change contains duplicate partitions')
    }
    signalScopeKeys.add(scopeKey)
    if (!Array.isArray(partition.affected)) {
      throw new MemoryError('integrity_failed', 'signal change affected items must be an array')
    }
    let previousKey: string | undefined
    for (const [itemIndex, item] of partition.affected.entries()) {
      const key = item?.key
      const target = item?.target
      if (typeof key !== 'string' || !/^[a-f0-9]{64}$/u.test(key)) {
        throw new MemoryError('integrity_failed', 'signal change key is invalid')
      }
      if (previousKey !== undefined && previousKey >= key) {
        throw new MemoryError('integrity_failed', 'signal change affected items must be sorted')
      }
      previousKey = key
      if (
        target === null ||
        typeof target !== 'object' ||
        !['episode', 'entity', 'fact'].includes(target.kind) ||
        typeof target.id !== 'string' ||
        target.id.length === 0
      ) {
        throw new MemoryError(
          'integrity_failed',
          `signalChange.partitions[${index}].affected[${itemIndex}].target is invalid`,
        )
      }
      if (disclosedKeys.has(key)) {
        throw new MemoryError('integrity_failed', 'signal change contains duplicate keys')
      }
      disclosedKeys.add(key)
    }
    if (partition.invalidated === true) {
      invalidated = true
      if (partition.affected.length !== 0) {
        throw new MemoryError(
          'integrity_failed',
          'invalidated signal change partitions must not disclose signal identifiers',
        )
      }
    } else if (partition.affected.length === 0) {
      throw new MemoryError('integrity_failed', 'signal change partition has no affected keys')
    }
  }
  if (!invalidated && expectedKeys.size > 0) {
    if (
      expectedKeys.size !== disclosedKeys.size ||
      [...expectedKeys].some((key) => !disclosedKeys.has(key))
    ) {
      throw new MemoryError(
        'integrity_failed',
        'signal change keys do not match the signal storage mutation',
      )
    }
  }
}

export function materializeStoredChange(
  spaceId: string,
  revision: number,
  recordedAt: string,
  change: StorageSemanticChange,
): StoredChange {
  return {
    kindRecord: 'change',
    id: `change_${revision.toString().padStart(16, '0')}`,
    spaceId,
    revision,
    recordedAt,
    operationId: change.operationId,
    operationKind: change.operationKind,
    phase: change.phase,
    partitions: structuredClone(change.partitions),
  }
}

export function materializeStoredSignalChange(
  spaceId: string,
  revision: number,
  recordedAt: string,
  change: StorageSignalChange,
): StoredSignalChange {
  return {
    kindRecord: 'signal_change',
    id: `signal_change_${revision.toString().padStart(16, '0')}`,
    spaceId,
    revision,
    recordedAt,
    action: change.action,
    partitions: structuredClone(change.partitions),
  }
}

export interface RankedStoredRecord<K extends StoredRecordKind = StoredRecordKind> {
  record: RecordOfKind<K>
  score: number
}

/** Long-lived facade liveness lease; it is distinct from short physical-call arbitration. */
export interface StorageRuntimeLease {
  release(): Promise<void>
}

export function assertStorageRuntimeOwnerId(ownerId: string): void {
  if (
    typeof ownerId !== 'string' ||
    !/^runtime_owner_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      ownerId,
    )
  ) {
    throw new MemoryError('integrity_failed', 'runtime owner id is invalid')
  }
}

export interface StorageDriver {
  readonly name: string
  open(): Promise<void>
  close(): Promise<void>
  acquireRuntimeLease(ownerId: string): Promise<StorageRuntimeLease>
  runtimeLeaseActive(ownerId: string): Promise<boolean>
  inspect(): Promise<StorageInspection>
  createSpace(space: StoredSpace): Promise<void>
  getSpace(spaceId: string): Promise<StoredSpace | null>
  migrationHistory(spaceId: string): Promise<StoredSchemaMigration[]>
  applyMigration(change: StorageMigrationChange): Promise<StoredSpace>
  deleteSpace(spaceId: string, expectedRevision: number): Promise<void>
  get<K extends StoredRecordKind>(
    kind: K,
    spaceId: string,
    id: string,
  ): Promise<RecordOfKind<K> | null>
  query<K extends StoredRecordKind>(query: StorageQuery<K>): Promise<RecordOfKind<K>[]>
  count<K extends StoredRecordKind>(query: StorageCountQuery<K>): Promise<number>
  commit(change: StorageCommit): Promise<number>
  lexicalSearch(
    spaceId: string,
    query: string,
    generation: string,
    allowedScopes: readonly string[],
    limit: number,
    setId?: string,
  ): Promise<RankedStoredRecord<'projection'>[]>
  vectorSearch(
    spaceId: string,
    vector: readonly number[],
    generation: string,
    allowedScopes: readonly string[],
    limit: number,
    setId?: string,
  ): Promise<RankedStoredRecord<'projection'>[]>
  exportRecords(spaceId: string): Promise<StoredRecord[]>
}

const drivers = new WeakMap<object, StorageDriver>()

export function defineMemoryStorage<T extends object = Record<never, never>>(
  driver: StorageDriver,
  capabilities?: T,
): MemoryStorage & Readonly<T> {
  const storage = Object.freeze({ name: driver.name, ...capabilities })
  drivers.set(storage, driver)
  return storage as MemoryStorage & Readonly<T>
}

export function storageDriver(storage: MemoryStorage): StorageDriver {
  const driver = drivers.get(storage as object)
  if (driver === undefined) {
    throw new TypeError('storage must be created by a temporal-memory storage factory')
  }
  return driver
}
