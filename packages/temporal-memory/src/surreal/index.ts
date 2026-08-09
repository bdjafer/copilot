import { createWasmEngines, createWasmWorkerEngines } from '@astrale-os/surrealdb-wasm'
import { RecordId, Surreal, type QueryStats, type ServerError } from 'surrealdb'

import type { JsonValue, MemoryStorage, StorageInspection } from '../types.ts'

import { MemoryError, messageOf, normalizeStorageError } from '../errors.ts'
import {
  assertString,
  compareUnicode,
  sha256,
  snapshotJson,
  stableStringify,
  validateJson,
} from '../internal/value.ts'
import {
  assertStorageRuntimeOwnerId,
  assertStorageMigrationChange,
  assertStorageCommitSemantics,
  CANONICAL_SCHEMA_VERSION,
  defineMemoryStorage,
  LOCAL_METADATA_KINDS,
  MAX_SCHEMA_MIGRATION_RECORDS,
  materializeStoredChange,
  materializeStoredSignalChange,
  type RankedStoredRecord,
  type RecordOfKind,
  type StorageCountQuery,
  type StorageCommit,
  type StorageDriver,
  type StorageFilter,
  type StorageMigrationChange,
  type StorageQuery,
  type StorageRuntimeLease,
  type StoredRecord,
  type StoredRecordKind,
  type StoredSchemaMigration,
  type StoredSpace,
} from '../storage/driver.ts'

export interface SurrealMemoryStorageOptions {
  endpoint?: `indxdb://${string}` | `mem://${string}` | 'mem://'
  namespace?: string
  database?: string
  /** Run the embedded engine in its package-owned module worker. */
  worker?: boolean
}

export interface SurrealMemoryAdminOptions {
  /** Explicit authority acknowledgement required to acquire the database-wide admin capability. */
  dangerouslyAllowRawQueries: true
}

export interface SurrealRawQueryRequest {
  /** One or more parameterized SurrealQL statements. Limited to 1 MiB of UTF-8 query text. */
  query: string
  /** JSON-compatible parameter bindings. Never interpolate untrusted values into `query`. */
  bindings?: Readonly<Record<string, JsonValue>>
  /** Must exactly match the configured namespace on every privileged call. */
  confirmNamespace: string
  /** Must exactly match the configured database on every privileged call. */
  confirmDatabase: string
  /** Exact serialized response bound. Defaults to 8 MiB and is capped at 64 MiB. */
  maxResultBytes?: number
  /** Aggregate JSON node bound. Defaults to 100,000 and is capped at 1,000,000. */
  maxResultNodes?: number
}

export interface SurrealRawQueryStats {
  duration: string
  recordsReceived?: number
  bytesReceived?: number
  recordsScanned?: number
  bytesScanned?: number
}

export interface SurrealRawQueryError {
  kind: string
  code: number
  message: string
}

export type SurrealRawQueryStatement<T extends JsonValue = JsonValue> =
  | {
      index: number
      success: true
      type: 'live' | 'kill' | 'other'
      result: T
      stats?: SurrealRawQueryStats
    }
  | {
      index: number
      success: false
      error: SurrealRawQueryError
      stats?: SurrealRawQueryStats
    }

export interface SurrealRawQueryResult<R extends readonly JsonValue[] = readonly JsonValue[]> {
  /** SHA-256 of the exact query text for non-content-bearing diagnostics. */
  queryHash: string
  statements: { readonly [K in keyof R]: SurrealRawQueryStatement<R[K]> }
  allSucceeded: boolean
  /** UTF-8 byte length of the complete canonical JSON response, including this field. */
  byteLength: number
}

declare const SURREAL_MEMORY_STORAGE_CAPABILITY: unique symbol

/** Application storage capability. It deliberately has no raw-query method. */
export interface SurrealMemoryStorage extends MemoryStorage {
  /** @internal Nominal boundary; obtain this capability only from the Surreal factory. */
  readonly [SURREAL_MEMORY_STORAGE_CAPABILITY]: true
}

/** Separately held trusted-host capability for database-wide SurrealQL. */
export interface SurrealMemoryAdmin {
  /**
   * Execute privileged raw SurrealQL through the same serialized direct/worker engine connection.
   * The complete request and bounded JSON bindings are detached before database scheduling.
   * Statement failures are returned in-band so partial multi-statement execution is never hidden.
   * A post-response validation failure is non-retryable and requires durable-state reconciliation.
   */
  rawQuery<R extends readonly JsonValue[] = readonly JsonValue[]>(
    request: SurrealRawQueryRequest,
  ): Promise<SurrealRawQueryResult<R>>
}

/** Privileged construction result. Distribute only `storage` to application code. */
export interface SurrealMemoryCapabilities {
  readonly storage: SurrealMemoryStorage
  readonly admin: SurrealMemoryAdmin
}

type TableName =
  | 'tm_space'
  | 'tm_episode'
  | 'tm_operation'
  | 'tm_entity'
  | 'tm_alias'
  | 'tm_mention'
  | 'tm_fact'
  | 'tm_evidence'
  | 'tm_derivation'
  | 'tm_lifecycle'
  | 'tm_merge'
  | 'tm_projection'
  | 'tm_purge'
  | 'tm_change'
  | 'tm_signal'
  | 'tm_signal_change'
  | 'tm_journal_consumer'
  | 'tm_journal_registry'
  | 'tm_sync_checkpoint'
  | 'tm_sync_chunk'
  | 'tm_sync_index'
  | 'tm_sync_ref'
  | 'tm_sync_session'
  | 'tm_sync_conflict'
  | 'tm_sync_tombstone'
  | 'tm_migration'

interface Envelope {
  [key: string]: unknown
  external_id: string
  space_id: string
  payload: JsonValue
  idempotency_key?: string
  idempotency_key_hashes?: readonly string[]
  episode_id?: string
  operation_kind?: string
  state?: string
  updated_at?: string
  created_at?: string
  received_at?: string
  subject_id?: string
  predicate?: string
  semantic_key?: string
  status?: string
  object_entity_id?: string
  identifier_fingerprints?: readonly string[]
  entity_id?: string
  normalized?: string
  target_kind?: string
  target_id?: string
  relation?: string
  projection_kind?: string
  set_id?: string
  generation?: string
  scope_hash?: string
  scopes?: readonly string[]
  text?: string
  vector?: readonly number[]
  source_kind?: string
  name?: string
  types?: readonly string[]
  valid_from?: string
  valid_to?: string
  operation_id?: string
  source_ids?: readonly string[]
  active?: boolean
  withdrawn_at?: string
  revision?: number
  phase?: string
  logical_key?: string
  namespace?: string
  slot?: string
  producer_id?: string
  conclusion_fact_id?: string
  premise_fact_ids?: readonly string[]
  premise_evidence_ids?: readonly string[]
  rule_id?: string
  rule_version?: string
  version?: number
  recorded_revision?: number
  expires_at?: string
  signal_tags?: readonly string[]
  basis_episode_ids?: readonly string[]
  basis_entity_ids?: readonly string[]
  basis_fact_ids?: readonly string[]
  action?: string
  owner_id?: string
  sync_key?: string
  record_kind?: string
  record_id?: string
  chunk_index?: number
  checkpoint_id?: string
  session_id?: string
  tombstone_kind?: string
  head?: string
  payload_state?: string
  migration_sequence?: number
  from_schema_version?: string
  to_schema_version?: string
  checksum?: string
  conflict_group?: string
  consumer_id?: string
  journal?: string
}

interface QueryEnvelope {
  payload: JsonValue
}

interface RankedEnvelope extends QueryEnvelope {
  score: number
}

interface CountEnvelope {
  count: number
}

const TABLE_BY_KIND: Readonly<Record<StoredRecordKind, TableName>> = {
  episode: 'tm_episode',
  operation: 'tm_operation',
  entity: 'tm_entity',
  alias: 'tm_alias',
  mention: 'tm_mention',
  fact: 'tm_fact',
  evidence: 'tm_evidence',
  derivation: 'tm_derivation',
  lifecycle: 'tm_lifecycle',
  merge: 'tm_merge',
  projection: 'tm_projection',
  purge: 'tm_purge',
  change: 'tm_change',
  signal: 'tm_signal',
  signal_change: 'tm_signal_change',
  journal_consumer: 'tm_journal_consumer',
  journal_registry: 'tm_journal_registry',
  sync_checkpoint: 'tm_sync_checkpoint',
  sync_chunk: 'tm_sync_chunk',
  sync_index: 'tm_sync_index',
  sync_ref: 'tm_sync_ref',
  sync_session: 'tm_sync_session',
  sync_conflict: 'tm_sync_conflict',
  sync_tombstone: 'tm_sync_tombstone',
}

const RECORD_TABLES = Object.values(TABLE_BY_KIND)
const SPACE_TABLES: readonly TableName[] = [...RECORD_TABLES, 'tm_migration']

const QUERY_FIELDS: Readonly<Record<string, string>> = {
  id: 'external_id',
  idempotencyKey: 'idempotency_key',
  idempotencyKeyHashes: 'idempotency_key_hashes',
  episodeId: 'episode_id',
  episodeIds: 'payload.episodeIds',
  kind: 'operation_kind',
  state: 'state',
  consumerId: 'consumer_id',
  journal: 'journal',
  active: 'active',
  detailsState: 'details_state',
  requiredScopes: 'payload.requiredScopes',
  updatedAt: 'updated_at',
  createdAt: 'created_at',
  recordedAt: 'created_at',
  receivedAt: 'received_at',
  subjectId: 'subject_id',
  predicate: 'predicate',
  semanticKey: 'semantic_key',
  status: 'status',
  conflictGroup: 'conflict_group',
  'object.entityId': 'object_entity_id',
  identifierFingerprints: 'identifier_fingerprints',
  entityId: 'entity_id',
  normalized: 'normalized',
  'target.kind': 'target_kind',
  'target.id': 'target_id',
  targetKind: 'target_kind',
  targetId: 'target_id',
  relation: 'relation',
  projectionKind: 'projection_kind',
  setId: 'set_id',
  generation: 'generation',
  scopeHash: 'scope_hash',
  scopes: 'scopes',
  revision: 'revision',
  key: 'logical_key',
  namespace: 'namespace',
  slot: 'slot',
  'producer.id': 'producer_id',
  conclusionFactId: 'conclusion_fact_id',
  premiseFactIds: 'premise_fact_ids',
  premiseEvidenceIds: 'premise_evidence_ids',
  'rule.id': 'rule_id',
  'rule.version': 'rule_version',
  version: 'version',
  recordedRevision: 'recorded_revision',
  expiresAt: 'expires_at',
  episodeKind: 'payload.kind',
  retentionState: 'payload.retentionState',
  retentionPolicy: 'payload.retention',
  sensitivity: 'payload.sensitivity',
  observedAt: 'payload.observedAt',
  sourceKind: 'source_kind',
  sourceOrigin: 'payload.source.origin',
  sourceExternalId: 'payload.source.externalId',
  sourceThreadId: 'payload.source.threadId',
  sourceDocumentId: 'payload.source.documentId',
  sourceCapturedAt: 'payload.source.capturedAt',
  tags: 'payload.tags',
  sourceIds: 'source_ids',
  'basis.episodeIds': 'basis_episode_ids',
  'basis.entityIds': 'basis_entity_ids',
  'basis.factIds': 'basis_fact_ids',
  ownerId: 'owner_id',
  chunkOwnerId: 'payload.chunkOwnerId',
  syncKey: 'sync_key',
  recordKind: 'record_kind',
  recordId: 'record_id',
  index: 'chunk_index',
  chunkIndex: 'chunk_index',
  byteLength: 'byte_length',
  checkpointId: 'checkpoint_id',
  sessionId: 'session_id',
  tombstoneKind: 'tombstone_kind',
  head: 'head',
  payloadState: 'payload_state',
}

const BASE_FIELDS: readonly [string, string][] = [
  ['external_id', 'string'],
  ['space_id', 'string'],
  ['payload', 'object FLEXIBLE'],
]

const TABLE_FIELDS: Readonly<Record<TableName, readonly [string, string][]>> = {
  tm_space: [
    ['updated_at', 'option<string>'],
    ['created_at', 'option<string>'],
  ],
  tm_episode: [
    ['idempotency_key', 'option<string>'],
    ['received_at', 'option<string>'],
    ['source_kind', 'option<string>'],
    ['scopes', 'option<array<string>>'],
  ],
  tm_operation: [
    ['episode_id', 'option<string>'],
    ['operation_kind', 'option<string>'],
    ['state', 'option<string>'],
    ['updated_at', 'option<string>'],
  ],
  tm_entity: [
    ['identifier_fingerprints', 'option<array<string>>'],
    ['name', 'option<string>'],
    ['types', 'option<array<string>>'],
    ['created_at', 'option<string>'],
    ['updated_at', 'option<string>'],
  ],
  tm_alias: [
    ['entity_id', 'option<string>'],
    ['identifier_fingerprints', 'option<array<string>>'],
    ['normalized', 'option<string>'],
    ['types', 'option<array<string>>'],
    ['scopes', 'option<array<string>>'],
    ['created_at', 'option<string>'],
  ],
  tm_mention: [
    ['episode_id', 'option<string>'],
    ['entity_id', 'option<string>'],
    ['scopes', 'option<array<string>>'],
  ],
  tm_fact: [
    ['subject_id', 'option<string>'],
    ['predicate', 'option<string>'],
    ['semantic_key', 'option<string>'],
    ['scope_hash', 'option<string>'],
    ['status', 'option<string>'],
    ['conflict_group', 'option<string>'],
    ['object_entity_id', 'option<string>'],
    ['created_at', 'option<string>'],
    ['valid_from', 'option<string>'],
    ['valid_to', 'option<string>'],
  ],
  tm_evidence: [
    ['episode_id', 'option<string>'],
    ['target_kind', 'option<string>'],
    ['target_id', 'option<string>'],
    ['relation', 'option<string>'],
    ['status', 'option<string>'],
    ['scopes', 'option<array<string>>'],
    ['scope_hash', 'option<string>'],
    ['created_at', 'option<string>'],
    ['withdrawn_at', 'option<string>'],
  ],
  tm_derivation: [
    ['logical_key', 'option<string>'],
    ['version', 'option<number>'],
    ['recorded_revision', 'option<number>'],
    ['state', 'option<string>'],
    ['conclusion_fact_id', 'option<string>'],
    ['premise_fact_ids', 'option<array<string>>'],
    ['premise_evidence_ids', 'option<array<string>>'],
    ['rule_id', 'option<string>'],
    ['rule_version', 'option<string>'],
    ['scopes', 'option<array<string>>'],
    ['created_at', 'option<string>'],
  ],
  tm_lifecycle: [
    ['target_kind', 'option<string>'],
    ['target_id', 'option<string>'],
    ['operation_id', 'option<string>'],
    ['created_at', 'option<string>'],
  ],
  tm_merge: [
    ['active', 'option<bool>'],
    ['target_id', 'option<string>'],
    ['source_ids', 'option<array<string>>'],
    ['operation_id', 'option<string>'],
    ['created_at', 'option<string>'],
  ],
  tm_projection: [
    ['target_kind', 'option<string>'],
    ['target_id', 'option<string>'],
    ['projection_kind', 'option<string>'],
    ['set_id', 'option<string>'],
    ['generation', 'option<string>'],
    ['scope_hash', 'option<string>'],
    ['scopes', 'option<array<string>>'],
    ['sensitivities', 'option<array<string>>'],
    ['state', 'option<string>'],
    ['text', 'option<string>'],
    ['vector', 'option<array<float>>'],
    ['created_at', 'option<string>'],
  ],
  tm_purge: [
    ['state', 'option<string>'],
    ['idempotency_key_hashes', 'option<array<string>>'],
    ['operation_id', 'option<string>'],
    ['updated_at', 'option<string>'],
    ['created_at', 'option<string>'],
  ],
  tm_change: [
    ['revision', 'option<number>'],
    ['operation_id', 'option<string>'],
    ['operation_kind', 'option<string>'],
    ['phase', 'option<string>'],
    ['created_at', 'option<string>'],
  ],
  tm_signal: [
    ['logical_key', 'option<string>'],
    ['namespace', 'option<string>'],
    ['slot', 'option<string>'],
    ['producer_id', 'option<string>'],
    ['version', 'option<number>'],
    ['recorded_revision', 'option<number>'],
    ['state', 'option<string>'],
    ['target_kind', 'option<string>'],
    ['target_id', 'option<string>'],
    ['scopes', 'option<array<string>>'],
    ['signal_tags', 'option<array<string>>'],
    ['basis_episode_ids', 'option<array<string>>'],
    ['basis_entity_ids', 'option<array<string>>'],
    ['basis_fact_ids', 'option<array<string>>'],
    ['expires_at', 'option<string>'],
    ['created_at', 'option<string>'],
  ],
  tm_signal_change: [
    ['revision', 'option<number>'],
    ['action', 'option<string>'],
    ['created_at', 'option<string>'],
  ],
  tm_journal_consumer: [
    ['consumer_id', 'option<string>'],
    ['journal', 'option<string>'],
    ['state', 'option<string>'],
    ['revision', 'option<number>'],
    ['updated_at', 'option<string>'],
    ['created_at', 'option<string>'],
  ],
  tm_journal_registry: [
    ['journal', 'option<string>'],
    ['version', 'option<number>'],
    ['updated_at', 'option<string>'],
  ],
  tm_sync_checkpoint: [
    ['scopes', 'option<array<string>>'],
    ['payload_state', 'option<string>'],
    ['created_at', 'option<string>'],
  ],
  tm_sync_chunk: [
    ['owner_id', 'option<string>'],
    ['chunk_index', 'option<number>'],
  ],
  tm_sync_index: [
    ['owner_id', 'option<string>'],
    ['sync_key', 'option<string>'],
    ['record_kind', 'option<string>'],
    ['record_id', 'option<string>'],
    ['byte_length', 'option<number>'],
    ['chunk_index', 'option<number>'],
    ['idempotency_key', 'option<string>'],
    ['semantic_key', 'option<string>'],
    ['logical_key', 'option<string>'],
    ['version', 'option<number>'],
    ['state', 'option<string>'],
    ['episode_id', 'option<string>'],
    ['entity_id', 'option<string>'],
    ['subject_id', 'option<string>'],
    ['predicate', 'option<string>'],
    ['target_kind', 'option<string>'],
    ['target_id', 'option<string>'],
    ['conclusion_fact_id', 'option<string>'],
    ['premise_fact_ids', 'option<array<string>>'],
    ['premise_evidence_ids', 'option<array<string>>'],
    ['identifier_fingerprints', 'option<array<string>>'],
    ['scope_hash', 'option<string>'],
  ],
  tm_sync_ref: [
    ['head', 'option<string>'],
    ['updated_at', 'option<string>'],
  ],
  tm_sync_session: [
    ['state', 'option<string>'],
    ['details_state', 'option<string>'],
    ['scopes', 'option<array<string>>'],
    ['updated_at', 'option<string>'],
    ['created_at', 'option<string>'],
  ],
  tm_sync_conflict: [
    ['session_id', 'option<string>'],
    ['sync_key', 'option<string>'],
    ['record_kind', 'option<string>'],
    ['record_id', 'option<string>'],
  ],
  tm_sync_tombstone: [
    ['session_id', 'option<string>'],
    ['tombstone_kind', 'option<string>'],
    ['logical_key', 'option<string>'],
  ],
  tm_migration: [
    ['state', 'option<string>'],
    ['migration_sequence', 'option<number>'],
    ['from_schema_version', 'option<string>'],
    ['to_schema_version', 'option<string>'],
    ['checksum', 'option<string>'],
    ['updated_at', 'option<string>'],
    ['created_at', 'option<string>'],
  ],
}

function tableSchema(table: TableName): string[] {
  return [
    `DEFINE TABLE IF NOT EXISTS ${table} SCHEMAFULL;`,
    ...[...BASE_FIELDS, ...TABLE_FIELDS[table]].map(
      ([field, type]) => `DEFINE FIELD IF NOT EXISTS ${field} ON TABLE ${table} TYPE ${type};`,
    ),
  ]
}

const SCHEMA = [
  ...tableSchema('tm_space'),
  ...RECORD_TABLES.flatMap(tableSchema),
  ...tableSchema('tm_migration'),
].join('\n')

const INDEX_SCHEMA = `
DEFINE INDEX IF NOT EXISTS tm_space_external_unique ON TABLE tm_space FIELDS external_id UNIQUE;
DEFINE INDEX IF NOT EXISTS tm_episode_idempotency_unique ON TABLE tm_episode FIELDS space_id, idempotency_key UNIQUE;
DEFINE INDEX IF NOT EXISTS tm_episode_received ON TABLE tm_episode FIELDS space_id, received_at;
DEFINE INDEX IF NOT EXISTS tm_episode_source ON TABLE tm_episode FIELDS space_id, source_kind;
DEFINE INDEX IF NOT EXISTS tm_operation_state ON TABLE tm_operation FIELDS space_id, state;
DEFINE INDEX IF NOT EXISTS tm_operation_episode_kind ON TABLE tm_operation FIELDS space_id, episode_id, operation_kind;
DEFINE INDEX IF NOT EXISTS tm_entity_identifiers ON TABLE tm_entity FIELDS space_id, identifier_fingerprints;
DEFINE INDEX IF NOT EXISTS tm_entity_name ON TABLE tm_entity FIELDS space_id, name;
DEFINE INDEX IF NOT EXISTS tm_alias_normalized_type ON TABLE tm_alias FIELDS space_id, normalized, types;
DEFINE INDEX IF NOT EXISTS tm_alias_identifiers ON TABLE tm_alias FIELDS space_id, identifier_fingerprints;
DEFINE INDEX IF NOT EXISTS tm_alias_entity ON TABLE tm_alias FIELDS space_id, entity_id;
DEFINE INDEX IF NOT EXISTS tm_mention_episode ON TABLE tm_mention FIELDS space_id, episode_id;
DEFINE INDEX IF NOT EXISTS tm_mention_entity ON TABLE tm_mention FIELDS space_id, entity_id;
DEFINE INDEX IF NOT EXISTS tm_fact_semantic_unique ON TABLE tm_fact FIELDS space_id, semantic_key UNIQUE;
DEFINE INDEX IF NOT EXISTS tm_fact_scope_status ON TABLE tm_fact FIELDS space_id, scope_hash, status;
DEFINE INDEX IF NOT EXISTS tm_fact_conflict_group ON TABLE tm_fact FIELDS space_id, conflict_group;
DEFINE INDEX IF NOT EXISTS tm_fact_subject_predicate ON TABLE tm_fact FIELDS space_id, subject_id, predicate;
DEFINE INDEX IF NOT EXISTS tm_fact_object_entity ON TABLE tm_fact FIELDS space_id, object_entity_id;
DEFINE INDEX IF NOT EXISTS tm_fact_valid_time ON TABLE tm_fact FIELDS space_id, valid_from, valid_to;
DEFINE INDEX IF NOT EXISTS tm_evidence_episode ON TABLE tm_evidence FIELDS space_id, episode_id;
DEFINE INDEX IF NOT EXISTS tm_evidence_target ON TABLE tm_evidence FIELDS space_id, target_kind, target_id;
DEFINE INDEX IF NOT EXISTS tm_evidence_target_status ON TABLE tm_evidence FIELDS space_id, target_kind, target_id, status;
DEFINE INDEX IF NOT EXISTS tm_evidence_scope ON TABLE tm_evidence FIELDS space_id, scope_hash;
DEFINE INDEX IF NOT EXISTS tm_derivation_key_version_unique ON TABLE tm_derivation FIELDS space_id, logical_key, version UNIQUE;
DEFINE INDEX IF NOT EXISTS tm_derivation_conclusion_state ON TABLE tm_derivation FIELDS space_id, conclusion_fact_id, state;
DEFINE INDEX IF NOT EXISTS tm_derivation_premise_fact ON TABLE tm_derivation FIELDS space_id, premise_fact_ids;
DEFINE INDEX IF NOT EXISTS tm_derivation_premise_evidence ON TABLE tm_derivation FIELDS space_id, premise_evidence_ids;
DEFINE INDEX IF NOT EXISTS tm_derivation_rule_state ON TABLE tm_derivation FIELDS space_id, rule_id, rule_version, state;
DEFINE INDEX IF NOT EXISTS tm_derivation_recorded_revision ON TABLE tm_derivation FIELDS space_id, recorded_revision;
DEFINE INDEX IF NOT EXISTS tm_lifecycle_target_time ON TABLE tm_lifecycle FIELDS space_id, target_kind, target_id, created_at;
DEFINE INDEX IF NOT EXISTS tm_lifecycle_operation ON TABLE tm_lifecycle FIELDS space_id, operation_id;
DEFINE INDEX IF NOT EXISTS tm_merge_source ON TABLE tm_merge FIELDS space_id, source_ids;
DEFINE INDEX IF NOT EXISTS tm_merge_target_active ON TABLE tm_merge FIELDS space_id, target_id, active;
DEFINE INDEX IF NOT EXISTS tm_projection_target_generation ON TABLE tm_projection FIELDS space_id, target_kind, target_id, projection_kind, generation;
DEFINE INDEX IF NOT EXISTS tm_projection_active_set ON TABLE tm_projection FIELDS space_id, projection_kind, set_id, state;
DEFINE INDEX IF NOT EXISTS tm_projection_scope ON TABLE tm_projection FIELDS space_id, scope_hash;
DEFINE INDEX IF NOT EXISTS tm_purge_state ON TABLE tm_purge FIELDS space_id, state;
DEFINE INDEX IF NOT EXISTS tm_change_revision_unique ON TABLE tm_change FIELDS space_id, revision UNIQUE;
DEFINE INDEX IF NOT EXISTS tm_signal_key_version_unique ON TABLE tm_signal FIELDS space_id, logical_key, version UNIQUE;
DEFINE INDEX IF NOT EXISTS tm_signal_namespace_target ON TABLE tm_signal FIELDS space_id, namespace, target_kind, target_id;
DEFINE INDEX IF NOT EXISTS tm_signal_producer_slot ON TABLE tm_signal FIELDS space_id, producer_id, slot;
DEFINE INDEX IF NOT EXISTS tm_signal_tags ON TABLE tm_signal FIELDS space_id, signal_tags;
DEFINE INDEX IF NOT EXISTS tm_signal_basis_episode ON TABLE tm_signal FIELDS space_id, basis_episode_ids;
DEFINE INDEX IF NOT EXISTS tm_signal_basis_entity ON TABLE tm_signal FIELDS space_id, basis_entity_ids;
DEFINE INDEX IF NOT EXISTS tm_signal_basis_fact ON TABLE tm_signal FIELDS space_id, basis_fact_ids;
DEFINE INDEX IF NOT EXISTS tm_signal_recorded_revision ON TABLE tm_signal FIELDS space_id, recorded_revision;
DEFINE INDEX IF NOT EXISTS tm_signal_expiry ON TABLE tm_signal FIELDS space_id, expires_at;
DEFINE INDEX IF NOT EXISTS tm_signal_change_revision_unique ON TABLE tm_signal_change FIELDS space_id, revision UNIQUE;
DEFINE INDEX IF NOT EXISTS tm_journal_consumer_identity_unique ON TABLE tm_journal_consumer FIELDS space_id, journal, consumer_id UNIQUE;
DEFINE INDEX IF NOT EXISTS tm_journal_consumer_state_identity ON TABLE tm_journal_consumer FIELDS space_id, journal, state, consumer_id;
DEFINE INDEX IF NOT EXISTS tm_journal_registry_journal_unique ON TABLE tm_journal_registry FIELDS space_id, journal UNIQUE;
DEFINE INDEX IF NOT EXISTS tm_sync_checkpoint_payload_state ON TABLE tm_sync_checkpoint FIELDS space_id, payload_state;
DEFINE INDEX IF NOT EXISTS tm_sync_session_state_updated ON TABLE tm_sync_session FIELDS space_id, state, updated_at;
DEFINE INDEX IF NOT EXISTS tm_sync_session_details_state ON TABLE tm_sync_session FIELDS space_id, details_state;
DEFINE INDEX IF NOT EXISTS tm_sync_chunk_owner_index_unique ON TABLE tm_sync_chunk FIELDS space_id, owner_id, chunk_index UNIQUE;
DEFINE INDEX IF NOT EXISTS tm_sync_index_owner_key_unique ON TABLE tm_sync_index FIELDS space_id, owner_id, sync_key UNIQUE;
DEFINE INDEX IF NOT EXISTS tm_sync_index_kind_id ON TABLE tm_sync_index FIELDS space_id, owner_id, record_kind, record_id;
DEFINE INDEX IF NOT EXISTS tm_sync_index_derivation ON TABLE tm_sync_index FIELDS space_id, owner_id, logical_key, version;
DEFINE INDEX IF NOT EXISTS tm_sync_index_target ON TABLE tm_sync_index FIELDS space_id, owner_id, target_kind, target_id;
DEFINE INDEX IF NOT EXISTS tm_sync_index_fact ON TABLE tm_sync_index FIELDS space_id, owner_id, subject_id, predicate, scope_hash;
DEFINE INDEX IF NOT EXISTS tm_sync_conflict_session_key_unique ON TABLE tm_sync_conflict FIELDS space_id, session_id, sync_key UNIQUE;
DEFINE INDEX IF NOT EXISTS tm_sync_tombstone_session_kind_digest_unique ON TABLE tm_sync_tombstone FIELDS space_id, session_id, tombstone_kind, logical_key UNIQUE;
DEFINE INDEX IF NOT EXISTS tm_migration_state ON TABLE tm_migration FIELDS space_id, state;
DEFINE INDEX IF NOT EXISTS tm_migration_sequence_unique ON TABLE tm_migration FIELDS space_id, migration_sequence UNIQUE;
DEFINE ANALYZER IF NOT EXISTS tm_memory_text TOKENIZERS blank, class FILTERS lowercase, ascii;
DEFINE INDEX IF NOT EXISTS tm_projection_text ON TABLE tm_projection FIELDS text FULLTEXT ANALYZER tm_memory_text BM25;
`

const ENVELOPE_BACKFILL = `
UPDATE tm_merge SET active = payload.active WHERE active = NONE;
UPDATE tm_space SET payload.metadataRevision = 0 WHERE payload.metadataRevision = NONE;
UPDATE tm_space SET payload.canonicalRevision = 0 WHERE payload.canonicalRevision = NONE;
UPDATE tm_fact SET conflict_group = payload.conflictGroup WHERE conflict_group = NONE AND payload.conflictGroup != NONE;
UPDATE tm_signal SET basis_episode_ids = payload.basis.episodeIds WHERE basis_episode_ids = NONE;
UPDATE tm_signal SET basis_entity_ids = payload.basis.entityIds WHERE basis_entity_ids = NONE;
UPDATE tm_signal SET basis_fact_ids = payload.basis.factIds WHERE basis_fact_ids = NONE;
`

function tableFor(kind: StoredRecordKind): TableName {
  return TABLE_BY_KIND[kind]
}

function envelope(record: StoredRecord): Envelope {
  return {
    external_id: record.id,
    space_id: record.spaceId,
    payload: record as unknown as JsonValue,
    ...('idempotencyKey' in record ? { idempotency_key: record.idempotencyKey } : {}),
    ...(record.kindRecord === 'purge' && record.idempotencyKeyHashes !== undefined
      ? { idempotency_key_hashes: record.idempotencyKeyHashes }
      : {}),
    ...('episodeId' in record && record.episodeId !== undefined
      ? { episode_id: record.episodeId }
      : {}),
    ...(record.kindRecord === 'operation' ? { operation_kind: record.kind } : {}),
    ...(record.kindRecord === 'change'
      ? {
          revision: record.revision,
          operation_id: record.operationId,
          operation_kind: record.operationKind,
          phase: record.phase,
        }
      : {}),
    ...(record.kindRecord === 'signal'
      ? {
          logical_key: record.key,
          namespace: record.namespace,
          slot: record.slot,
          producer_id: record.producer.id,
          version: record.version,
          recorded_revision: record.recordedRevision,
          signal_tags: record.tags,
          basis_episode_ids: record.basis.episodeIds,
          basis_entity_ids: record.basis.entityIds,
          basis_fact_ids: record.basis.factIds,
          ...(record.state === 'active' && record.expiresAt !== undefined
            ? { expires_at: record.expiresAt }
            : {}),
        }
      : {}),
    ...(record.kindRecord === 'derivation'
      ? {
          logical_key: record.key,
          version: record.version,
          recorded_revision: record.recordedRevision,
          conclusion_fact_id: record.conclusionFactId,
          premise_fact_ids: record.premises
            .filter((premise) => premise.kind === 'fact')
            .map((premise) => premise.id),
          premise_evidence_ids: record.premises
            .filter((premise) => premise.kind === 'evidence')
            .map((premise) => premise.id),
          rule_id: record.rule.id,
          rule_version: record.rule.version,
        }
      : {}),
    ...(record.kindRecord === 'signal_change'
      ? { revision: record.revision, action: record.action }
      : {}),
    ...(record.kindRecord === 'journal_consumer'
      ? {
          consumer_id: record.consumerId,
          journal: record.journal,
          revision: record.throughRevision,
          created_at: record.registeredAt,
          updated_at: record.retiredAt ?? record.acknowledgedAt,
        }
      : {}),
    ...(record.kindRecord === 'journal_registry'
      ? { journal: record.journal, version: record.version }
      : {}),
    ...(record.kindRecord === 'sync_chunk'
      ? { owner_id: record.ownerId, chunk_index: record.index }
      : {}),
    ...(record.kindRecord === 'sync_checkpoint' && record.payloadState !== undefined
      ? { payload_state: record.payloadState }
      : {}),
    ...(record.kindRecord === 'sync_session' && record.detailsState !== undefined
      ? { details_state: record.detailsState }
      : {}),
    ...(record.kindRecord === 'sync_index'
      ? {
          owner_id: record.ownerId,
          sync_key: record.syncKey,
          record_kind: record.recordKind,
          record_id: record.recordId,
          byte_length: record.byteLength,
          chunk_index: record.chunkIndex,
          ...(record.logicalKey === undefined ? {} : { logical_key: record.logicalKey }),
          ...(record.version === undefined ? {} : { version: record.version }),
          ...(record.episodeId === undefined ? {} : { episode_id: record.episodeId }),
          ...(record.entityId === undefined ? {} : { entity_id: record.entityId }),
          ...(record.subjectId === undefined ? {} : { subject_id: record.subjectId }),
          ...(record.predicate === undefined ? {} : { predicate: record.predicate }),
          ...(record.targetKind === undefined ? {} : { target_kind: record.targetKind }),
          ...(record.targetId === undefined ? {} : { target_id: record.targetId }),
          ...(record.conclusionFactId === undefined
            ? {}
            : { conclusion_fact_id: record.conclusionFactId }),
          ...(record.premiseFactIds === undefined
            ? {}
            : { premise_fact_ids: record.premiseFactIds }),
          ...(record.premiseEvidenceIds === undefined
            ? {}
            : { premise_evidence_ids: record.premiseEvidenceIds }),
          ...(record.identifierFingerprints === undefined
            ? {}
            : { identifier_fingerprints: record.identifierFingerprints }),
          ...(record.scopeHash === undefined ? {} : { scope_hash: record.scopeHash }),
        }
      : {}),
    ...(record.kindRecord === 'sync_ref' ? { head: record.head } : {}),
    ...(record.kindRecord === 'sync_conflict'
      ? {
          session_id: record.sessionId,
          sync_key: record.syncKey,
          record_kind: record.recordKind,
          record_id: record.recordId,
        }
      : {}),
    ...(record.kindRecord === 'sync_tombstone'
      ? {
          session_id: record.sessionId,
          tombstone_kind: record.tombstoneKind,
          logical_key: record.digest,
        }
      : {}),
    ...('state' in record ? { state: record.state } : {}),
    ...('updatedAt' in record ? { updated_at: record.updatedAt } : {}),
    ...('createdAt' in record ? { created_at: record.createdAt } : {}),
    ...('recordedAt' in record ? { created_at: record.recordedAt } : {}),
    ...('receivedAt' in record ? { received_at: record.receivedAt } : {}),
    ...(record.kindRecord === 'episode' ? { source_kind: record.source.kind } : {}),
    ...(record.kindRecord === 'entity' ? { name: record.name, types: record.types } : {}),
    ...(record.kindRecord === 'alias' ? { types: record.types } : {}),
    ...('subjectId' in record ? { subject_id: record.subjectId } : {}),
    ...('predicate' in record ? { predicate: record.predicate } : {}),
    ...('semanticKey' in record ? { semantic_key: record.semanticKey } : {}),
    ...('status' in record ? { status: record.status } : {}),
    ...(record.kindRecord === 'fact' && record.conflictGroup !== undefined
      ? { conflict_group: record.conflictGroup }
      : {}),
    ...('object' in record && record.object.kind === 'entity'
      ? { object_entity_id: record.object.entityId }
      : {}),
    ...(record.kindRecord === 'fact' && record.validTime?.from !== undefined
      ? { valid_from: record.validTime.from }
      : {}),
    ...(record.kindRecord === 'fact' && record.validTime?.to !== undefined
      ? { valid_to: record.validTime.to }
      : {}),
    ...('identifierFingerprints' in record
      ? { identifier_fingerprints: record.identifierFingerprints }
      : {}),
    ...('entityId' in record && record.entityId !== undefined
      ? { entity_id: record.entityId }
      : {}),
    ...('normalized' in record ? { normalized: record.normalized } : {}),
    ...('target' in record ? { target_kind: record.target.kind, target_id: record.target.id } : {}),
    ...('relation' in record ? { relation: record.relation } : {}),
    ...(record.kindRecord === 'evidence' && record.withdrawnAt !== undefined
      ? { withdrawn_at: record.withdrawnAt }
      : {}),
    ...(record.kindRecord === 'evidence' ? { scope_hash: stableStringify(record.scopes) } : {}),
    ...(record.kindRecord === 'lifecycle' ? { operation_id: record.operationId } : {}),
    ...(record.kindRecord === 'merge'
      ? {
          target_id: record.targetId,
          source_ids: record.sourceIds,
          active: record.active,
          operation_id: record.operationId,
        }
      : {}),
    ...('projectionKind' in record ? { projection_kind: record.projectionKind } : {}),
    ...(record.kindRecord === 'projection' && record.setId !== undefined
      ? { set_id: record.setId }
      : {}),
    ...('generation' in record ? { generation: record.generation } : {}),
    ...('scopeHash' in record ? { scope_hash: record.scopeHash } : {}),
    ...('scopes' in record ? { scopes: record.scopes } : {}),
    ...(record.kindRecord === 'projection' ? { sensitivities: record.sensitivities } : {}),
    ...(record.kindRecord === 'projection' && record.state === 'ready' && record.text !== undefined
      ? { text: record.text }
      : {}),
    ...('vector' in record && record.vector !== undefined ? { vector: record.vector } : {}),
  }
}

function spaceEnvelope(space: StoredSpace): Envelope {
  return {
    external_id: space.id,
    space_id: space.spaceId,
    payload: space as unknown as JsonValue,
    updated_at: space.updatedAt,
    created_at: space.createdAt,
  }
}

function migrationEnvelope(migration: StoredSchemaMigration): Envelope {
  return {
    external_id: migration.id,
    space_id: migration.spaceId,
    payload: migration as unknown as JsonValue,
    state: migration.state,
    migration_sequence: migration.sequence,
    from_schema_version: migration.fromSchemaVersion,
    to_schema_version: migration.toSchemaVersion,
    checksum: migration.checksum,
    updated_at: migration.appliedAt,
    created_at: migration.appliedAt,
  }
}

function asRecord<K extends StoredRecordKind>(value: JsonValue): RecordOfKind<K> {
  return value as unknown as RecordOfKind<K>
}

function asSpace(value: JsonValue): StoredSpace {
  return value as unknown as StoredSpace
}

function asMigration(value: JsonValue): StoredSchemaMigration {
  return value as unknown as StoredSchemaMigration
}

function conflict(error: unknown): boolean {
  return /transaction conflict|revision conflict/iu.test(messageOf(error))
}

type TransactionOutcome = 'rolled_back' | 'unknown'

function transactionError(error: unknown, outcome?: TransactionOutcome): MemoryError {
  if (MemoryError.is(error)) return error
  const message = messageOf(error)
  const details = outcome === undefined ? undefined : { transactionOutcome: outcome }
  if (message.includes('TM_SPACE_NOT_FOUND')) {
    return new MemoryError('space_not_found', undefined, { details })
  }
  if (
    message.includes('TM_REVISION_CONFLICT') ||
    message.includes('TM_METADATA_REVISION_CONFLICT') ||
    message.includes('TM_CANONICAL_REVISION_CONFLICT') ||
    message.includes('TM_METADATA_CONFLICT') ||
    message.includes('TM_SCHEMA_MIGRATION_CONFLICT') ||
    conflict(error)
  ) {
    return new MemoryError('conflict', 'revision changed', {
      retryable: true,
      cause: error,
      details,
    })
  }
  const normalized = normalizeStorageError(error)
  if (outcome === undefined) return normalized
  return new MemoryError(normalized.code, normalized.message, {
    retryable: outcome === 'rolled_back' && normalized.retryable,
    cause: error,
    details: {
      ...normalized.details,
      transactionOutcome: outcome,
      ...(outcome === 'unknown' ? { requiresReopen: true } : {}),
    },
  })
}

const REVISION_GUARD = `
LET $current = SELECT * FROM ONLY $space_record;
IF $current = NONE {
  THROW 'TM_SPACE_NOT_FOUND';
};
IF $current.payload.revision != $expected_revision {
  THROW 'TM_REVISION_CONFLICT';
};
IF $current.payload.metadataRevision != $expected_metadata_revision {
  THROW 'TM_METADATA_REVISION_CONFLICT';
};
IF $current.payload.canonicalRevision != $expected_canonical_revision {
  THROW 'TM_CANONICAL_REVISION_CONFLICT';
};`

const MAX_RAW_QUERY_BYTES = 1_048_576
const MAX_RAW_QUERY_BINDINGS = 1_024
const DEFAULT_RAW_RESULT_BYTES = 8 * 1_024 * 1_024
const MAX_RAW_RESULT_BYTES = 64 * 1_024 * 1_024
const DEFAULT_RAW_RESULT_NODES = 100_000
const MAX_RAW_RESULT_NODES = 1_000_000
const SURREAL_WEB_LOCK_DOMAIN = '@astrale-os/temporal-memory/surreal-web-lock/v1'

interface OriginLockManager {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>
  query(): Promise<{
    held: readonly { name: string }[]
    pending: readonly { name: string }[]
  }>
}

interface DatabaseCallOptions {
  allowUncertain?: boolean
  unknownOutcome?: (error: unknown) => MemoryError
}

function originLockManager(): OriginLockManager | undefined {
  const navigatorValue = (globalThis as { navigator?: { locks?: unknown } }).navigator
  if (
    typeof navigatorValue?.locks !== 'object' ||
    navigatorValue.locks === null ||
    typeof (navigatorValue.locks as { request?: unknown }).request !== 'function' ||
    typeof (navigatorValue.locks as { query?: unknown }).query !== 'function'
  ) {
    return undefined
  }
  return navigatorValue.locks as OriginLockManager
}

function rawQueryStats(stats: QueryStats | undefined): SurrealRawQueryStats | undefined {
  if (stats === undefined) return undefined
  const result: SurrealRawQueryStats = { duration: String(stats.duration) }
  for (const [field, value] of [
    ['recordsReceived', stats.recordsReceived],
    ['bytesReceived', stats.bytesReceived],
    ['recordsScanned', stats.recordsScanned],
    ['bytesScanned', stats.bytesScanned],
  ] as const) {
    if (Number.isSafeInteger(value) && value >= 0) result[field] = value
  }
  return result
}

function rawQueryError(error: ServerError): SurrealRawQueryError {
  return {
    kind: error.kind,
    code: Number.isSafeInteger(error.code) ? error.code : 0,
    message: error.message,
  }
}

function rawResultTooLarge(message: string, details: Record<string, JsonValue>): MemoryError {
  return new MemoryError('result_too_large', message, { details })
}

function rawPostResponseError(error: unknown, queryHash?: string): MemoryError {
  const normalized = normalizeStorageError(error)
  return new MemoryError(normalized.code, normalized.message, {
    operationId: normalized.operationId,
    retryable: false,
    cause: error,
    details: {
      ...normalized.details,
      ...(queryHash === undefined ? {} : { queryHash }),
      queryOutcome: 'responses_received',
      requiresReconciliation: true,
    },
  })
}

const RAW_QUERY_REQUEST_FIELDS: ReadonlySet<string> = new Set([
  'query',
  'bindings',
  'confirmNamespace',
  'confirmDatabase',
  'maxResultBytes',
  'maxResultNodes',
])

interface RawQueryRequestSnapshot {
  query: unknown
  bindings: unknown
  confirmNamespace: unknown
  confirmDatabase: unknown
  maxResultBytes: unknown
  maxResultNodes: unknown
}

interface RawQueryValueAccumulator {
  mode: 'single' | 'batch'
  value: JsonValue | JsonValue[]
}

interface RawQueryAdmission {
  nodes: number
  stringBytes: number
  valueBytes: number
}

function snapshotRawQueryRequest(request: object): RawQueryRequestSnapshot {
  try {
    for (const field of Object.keys(request)) {
      if (!RAW_QUERY_REQUEST_FIELDS.has(field)) {
        throw new MemoryError('invalid_input', 'raw query request contains an unknown field')
      }
    }
    return {
      query: Reflect.get(request, 'query'),
      bindings: Reflect.get(request, 'bindings'),
      confirmNamespace: Reflect.get(request, 'confirmNamespace'),
      confirmDatabase: Reflect.get(request, 'confirmDatabase'),
      maxResultBytes: Reflect.get(request, 'maxResultBytes'),
      maxResultNodes: Reflect.get(request, 'maxResultNodes'),
    }
  } catch (error) {
    if (MemoryError.is(error)) throw error
    throw new MemoryError('invalid_input', 'raw query request could not be snapshotted', {
      cause: error,
    })
  }
}

class SurrealDriver implements StorageDriver {
  readonly name = 'surrealdb-wasm'
  readonly #endpoint: string
  readonly #namespace: string
  readonly #database: string
  readonly #db: Surreal
  readonly #originLockName: Promise<string> | null
  readonly #localRuntimeOwners = new Set<string>()
  #openCount = 0
  #opening: Promise<void> | null = null
  #databaseTail: Promise<void> = Promise.resolve()
  #uncertainConnectionError: MemoryError | null = null
  #connectionCleanupPending = false

  constructor(options: SurrealMemoryStorageOptions) {
    const endpoint = options.endpoint ?? 'indxdb://astrale-temporal-memory'
    if (!endpoint.startsWith('indxdb://') && !endpoint.startsWith('mem://')) {
      throw new MemoryError('invalid_input', 'SurrealDB endpoint must use indxdb:// or mem://')
    }
    this.#endpoint = endpoint
    this.#namespace = options.namespace ?? 'astrale'
    this.#database = options.database ?? 'temporal_memory'
    this.#originLockName = endpoint.startsWith('indxdb://')
      ? sha256(
          stableStringify([SURREAL_WEB_LOCK_DOMAIN, endpoint, this.#namespace, this.#database]),
        ).then((digest) => `${SURREAL_WEB_LOCK_DOMAIN}:${digest}`)
      : null
    assertString(this.#namespace, 'namespace', 128)
    assertString(this.#database, 'database', 128)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.#namespace)) {
      throw new MemoryError('invalid_input', 'namespace must be a SurrealDB identifier')
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.#database)) {
      throw new MemoryError('invalid_input', 'database must be a SurrealDB identifier')
    }
    const engineOptions = {
      defaults: {
        namespace: this.#namespace,
        database: this.#database,
      },
      capabilities: {
        scripting: false,
        guest_access: false,
        network_targets: false,
      },
    }
    this.#db = new Surreal({
      engines:
        options.worker === true
          ? createWasmWorkerEngines(engineOptions)
          : createWasmEngines(engineOptions),
    })
  }

  async open(): Promise<void> {
    if (this.#openCount > 0) {
      this.#assertConnectionOutcomeKnown()
      this.#openCount += 1
      return
    }
    if (this.#opening !== null) {
      await this.#opening
      this.#assertConnectionOutcomeKnown()
      this.#openCount += 1
      return
    }
    this.#opening = this.#connect()
    try {
      await this.#opening
      this.#openCount = 1
    } finally {
      this.#opening = null
    }
  }

  async #connect(): Promise<void> {
    await this.#resumeConnectionCleanup()
    let connectionMayExist = false
    try {
      await this.#databaseCall(() => {
        connectionMayExist = true
        return this.#db.connect(this.#endpoint)
      })
      await this.#databaseCall(() =>
        this.#db.use({ namespace: this.#namespace, database: this.#database }),
      )
      await this.#databaseCall(() => this.#db.query(SCHEMA).collect())
      // Schema-v7 merge payloads predate the indexed active envelope field. This idempotent physical
      // backfill does not change canonical payloads or the logical memory revision.
      await this.#databaseCall(() => this.#db.query(ENVELOPE_BACKFILL).collect())
      await this.#databaseCall(() => this.#db.query(INDEX_SCHEMA).collect())
    } catch (error) {
      if (!connectionMayExist) throw error
      this.#connectionCleanupPending = true
      try {
        await this.#finishConnectionCleanup()
      } catch (cleanupError) {
        const primary = normalizeStorageError(error)
        throw new MemoryError('storage_failed', primary.message, {
          retryable: true,
          cause: error,
          details: {
            ...primary.details,
            connectionCleanup: 'pending',
            primaryCode: primary.code,
            cleanupError: messageOf(cleanupError),
          },
        })
      }
      throw error
    }
  }

  async #resumeConnectionCleanup(): Promise<void> {
    if (!this.#connectionCleanupPending) return
    try {
      await this.#finishConnectionCleanup()
      this.#uncertainConnectionError = null
    } catch (error) {
      throw this.#connectionCleanupError(error)
    }
  }

  async #finishConnectionCleanup(): Promise<void> {
    await this.#databaseCall(() => this.#db.close(), { allowUncertain: true })
    this.#connectionCleanupPending = false
  }

  #connectionCleanupError(error: unknown): MemoryError {
    return new MemoryError('storage_failed', 'SurrealDB connection cleanup is still pending', {
      retryable: true,
      cause: error,
      details: { connectionCleanup: 'pending' },
    })
  }

  async close(): Promise<void> {
    if (this.#opening !== null) await this.#opening.catch(() => undefined)
    const hadReference = this.#openCount > 0
    if (hadReference) this.#openCount -= 1
    if (this.#openCount > 0) return
    if (this.#connectionCleanupPending) {
      await this.#resumeConnectionCleanup()
      this.#uncertainConnectionError = null
      return
    }
    if (!hadReference && this.#uncertainConnectionError === null) return
    this.#connectionCleanupPending = true
    try {
      await this.#finishConnectionCleanup()
    } catch (error) {
      throw this.#connectionCleanupError(error)
    }
    this.#uncertainConnectionError = null
  }

  async acquireRuntimeLease(ownerId: string): Promise<StorageRuntimeLease> {
    assertStorageRuntimeOwnerId(ownerId)
    this.#assertConnectionOutcomeKnown()
    if (this.#openCount === 0) throw new MemoryError('not_open', 'storage is not open')
    if (this.#originLockName === null) {
      if (this.#localRuntimeOwners.has(ownerId)) {
        throw new MemoryError('integrity_failed', 'runtime owner lease is already held')
      }
      this.#localRuntimeOwners.add(ownerId)
      let active = true
      return {
        release: async () => {
          if (!active) return
          active = false
          this.#localRuntimeOwners.delete(ownerId)
        },
      }
    }
    const manager = originLockManager()
    if (manager === undefined) {
      throw new MemoryError(
        'storage_failed',
        'persistent SurrealDB storage requires the browser Web Locks API for cross-context safety',
      )
    }
    const name = `${await this.#originLockName}:runtime:${ownerId}`
    let resolveAcquired = (): void => undefined
    let rejectAcquired = (_error: unknown): void => undefined
    const acquired = new Promise<void>((resolve, reject) => {
      resolveAcquired = resolve
      rejectAcquired = reject
    })
    let releaseLock = (): void => undefined
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const lockRequest = manager.request(name, { mode: 'exclusive' }, async () => {
      resolveAcquired()
      await released
    })
    void lockRequest.catch(rejectAcquired)
    await acquired
    let active = true
    return {
      release: async () => {
        if (!active) return
        active = false
        releaseLock()
        await lockRequest
      },
    }
  }

  async runtimeLeaseActive(ownerId: string): Promise<boolean> {
    assertStorageRuntimeOwnerId(ownerId)
    this.#assertConnectionOutcomeKnown()
    if (this.#openCount === 0) throw new MemoryError('not_open', 'storage is not open')
    if (this.#originLockName === null) return this.#localRuntimeOwners.has(ownerId)
    const manager = originLockManager()
    if (manager === undefined) {
      throw new MemoryError(
        'storage_failed',
        'persistent SurrealDB storage requires the browser Web Locks API for cross-context safety',
      )
    }
    const name = `${await this.#originLockName}:runtime:${ownerId}`
    try {
      const snapshot = await manager.query()
      return snapshot.held.some((lock) => lock.name === name)
    } catch (error) {
      throw new MemoryError('storage_failed', 'runtime owner liveness query failed', {
        cause: error,
      })
    }
  }

  #databaseCall<T>(run: () => Promise<T>, options: DatabaseCallOptions = {}): Promise<T> {
    const coordinated = async (): Promise<T> => {
      if (options.allowUncertain !== true) this.#assertConnectionOutcomeKnown()
      try {
        return await this.#originCoordinatedCall(run)
      } catch (error) {
        if (options.unknownOutcome === undefined || MemoryError.is(error)) throw error
        const uncertain = options.unknownOutcome(error)
        this.#uncertainConnectionError ??= uncertain
        throw this.#uncertainConnectionError
      }
    }
    const result = this.#databaseTail.then(coordinated, coordinated)
    this.#databaseTail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  #assertConnectionOutcomeKnown(): void {
    if (this.#uncertainConnectionError !== null) throw this.#uncertainConnectionError
  }

  async #originCoordinatedCall<T>(run: () => Promise<T>): Promise<T> {
    if (this.#originLockName === null) return run()
    const manager = originLockManager()
    if (manager === undefined) {
      throw new MemoryError(
        'storage_failed',
        'persistent SurrealDB storage requires the browser Web Locks API for cross-context safety',
      )
    }
    const name = await this.#originLockName
    let resolveAcquired = (): void => undefined
    let rejectAcquired = (_error: unknown): void => undefined
    const acquired = new Promise<void>((resolve, reject) => {
      resolveAcquired = resolve
      rejectAcquired = reject
    })
    let release = (): void => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    // Keep the Web Lock in a lease callback, but start the embedded IndexedDB operation from the
    // caller task. Direct-engine reads can stall when they are initiated inside the lock callback.
    const lockRequest = manager.request(name, { mode: 'exclusive' }, async () => {
      resolveAcquired()
      await released
    })
    void lockRequest.catch(rejectAcquired)
    await acquired

    let value: T | undefined
    let failure: unknown
    let succeeded = false
    try {
      value = await run()
      succeeded = true
    } catch (error) {
      failure = error
    }
    release()
    try {
      await lockRequest
    } catch (error) {
      if (succeeded) failure = error
      succeeded = false
    }
    if (!succeeded) throw failure
    return value as T
  }

  async #transaction(query: string, bindings: Record<string, unknown>): Promise<void> {
    const responses: Awaited<ReturnType<ReturnType<Surreal['query']>['responses']>> =
      await this.#databaseCall(() => this.#db.query(query, bindings).responses(), {
        unknownOutcome: (error) => transactionError(error, 'unknown'),
      })
    let fallback: unknown
    for (const response of responses) {
      if (response === undefined || response.success) continue
      fallback ??= response.error
      if (
        !/not executed due to a (?:failed|cancelled) transaction/iu.test(messageOf(response.error))
      ) {
        throw transactionError(response.error, 'rolled_back')
      }
    }
    if (fallback !== undefined) throw transactionError(fallback, 'rolled_back')
  }

  async inspect(): Promise<StorageInspection> {
    this.#assertConnectionOutcomeKnown()
    return {
      name: this.name,
      open: this.#openCount > 0,
      persistent: this.#endpoint.startsWith('indxdb://'),
      engine: 'surrealdb-wasm',
      endpoint: this.#endpoint,
      schemaVersion: CANONICAL_SCHEMA_VERSION,
    }
  }

  async rawQuery<R extends readonly JsonValue[] = readonly JsonValue[]>(
    request: SurrealRawQueryRequest,
  ): Promise<SurrealRawQueryResult<R>> {
    if (typeof request !== 'object' || request === null) {
      throw new MemoryError('invalid_input', 'raw query request is required')
    }
    const requestSnapshot = snapshotRawQueryRequest(request)
    assertString(requestSnapshot.query, 'query', MAX_RAW_QUERY_BYTES)
    assertString(requestSnapshot.confirmNamespace, 'confirmNamespace', 128)
    assertString(requestSnapshot.confirmDatabase, 'confirmDatabase', 128)
    if (
      requestSnapshot.confirmNamespace !== this.#namespace ||
      requestSnapshot.confirmDatabase !== this.#database
    ) {
      throw new MemoryError('invalid_input', 'raw query target confirmation does not match storage')
    }
    let queryBindings: Record<string, unknown> | undefined
    if (requestSnapshot.bindings !== undefined) {
      const bindingsSnapshot = snapshotJson(requestSnapshot.bindings, 'raw query bindings').value
      if (
        typeof bindingsSnapshot !== 'object' ||
        bindingsSnapshot === null ||
        Array.isArray(bindingsSnapshot)
      ) {
        throw new MemoryError('invalid_input', 'raw query bindings must be an object')
      }
      const bindings = Object.entries(bindingsSnapshot)
      if (bindings.length > MAX_RAW_QUERY_BINDINGS) {
        throw new MemoryError(
          'invalid_input',
          `raw query bindings exceed ${MAX_RAW_QUERY_BINDINGS} entries`,
        )
      }
      for (const [name] of bindings) {
        assertString(name, 'raw query binding name', 128)
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
          throw new MemoryError('invalid_input', `invalid raw query binding name: ${name}`)
        }
      }
      queryBindings = bindingsSnapshot as Record<string, JsonValue>
    }
    const maxResultBytes = requestSnapshot.maxResultBytes ?? DEFAULT_RAW_RESULT_BYTES
    if (
      typeof maxResultBytes !== 'number' ||
      !Number.isSafeInteger(maxResultBytes) ||
      maxResultBytes < 1 ||
      maxResultBytes > MAX_RAW_RESULT_BYTES
    ) {
      throw new MemoryError(
        'invalid_input',
        `maxResultBytes must be between 1 and ${MAX_RAW_RESULT_BYTES}`,
      )
    }
    const maxResultNodes = requestSnapshot.maxResultNodes ?? DEFAULT_RAW_RESULT_NODES
    if (
      typeof maxResultNodes !== 'number' ||
      !Number.isSafeInteger(maxResultNodes) ||
      maxResultNodes < 1 ||
      maxResultNodes > MAX_RAW_RESULT_NODES
    ) {
      throw new MemoryError(
        'invalid_input',
        `maxResultNodes must be between 1 and ${MAX_RAW_RESULT_NODES}`,
      )
    }
    if (this.#openCount === 0) {
      throw new MemoryError('not_open', 'raw SurrealQL requires an open memory storage')
    }
    const queryText = requestSnapshot.query

    let responsesReceived = false
    const queryHash = await sha256(queryText)
    try {
      const statements = await this.#databaseCall(
        async () => {
          if (this.#openCount === 0) {
            throw new MemoryError('not_open', 'raw SurrealQL requires an open memory storage')
          }
          const values = new Map<number, RawQueryValueAccumulator>()
          const collected: Array<SurrealRawQueryStatement<JsonValue> | undefined> = []
          const admission: RawQueryAdmission = { nodes: 0, stringBytes: 0, valueBytes: 0 }
          const encoder = new TextEncoder()
          const admitValue = (input: unknown, index: number): JsonValue => {
            const value = input === undefined ? null : input
            let metrics: ReturnType<typeof validateJson>
            try {
              metrics = validateJson(value, `raw query statement ${index} value`, {
                maxNodes: Math.max(1, MAX_RAW_RESULT_NODES - admission.nodes),
                maxStringBytes: Math.max(1, MAX_RAW_RESULT_BYTES - admission.stringBytes),
              })
            } catch (error) {
              if (MemoryError.is(error) && error.message.includes('exceeds')) {
                throw rawResultTooLarge('raw query response exceeds a hard JSON result limit', {
                  queryHash,
                  maxResultBytes: MAX_RAW_RESULT_BYTES,
                  maxResultNodes: MAX_RAW_RESULT_NODES,
                })
              }
              throw new MemoryError('storage_failed', 'raw query returned a non-JSON response', {
                cause: error,
              })
            }
            const requiredNodes = admission.nodes + metrics.nodes
            if (requiredNodes > maxResultNodes) {
              throw rawResultTooLarge('raw query response exceeds maxResultNodes', {
                queryHash,
                requiredNodes,
                maxResultNodes,
              })
            }
            const valueBytes = encoder.encode(stableStringify(value as JsonValue)).byteLength
            const requiredBytes = admission.valueBytes + valueBytes
            if (requiredBytes > maxResultBytes) {
              throw rawResultTooLarge('raw query response exceeds maxResultBytes', {
                queryHash,
                requiredBytes,
                maxResultBytes,
              })
            }
            admission.nodes = requiredNodes
            admission.stringBytes += metrics.stringBytes
            admission.valueBytes = requiredBytes
            return value as JsonValue
          }

          for await (const frame of this.#db.query(queryText, queryBindings).json().stream()) {
            responsesReceived = true
            const index = frame.query
            if (!Number.isSafeInteger(index) || index < 0) {
              throw new MemoryError(
                'storage_failed',
                'raw query returned an invalid statement index',
              )
            }
            if (index >= maxResultNodes) {
              throw rawResultTooLarge('raw query response exceeds maxResultNodes', {
                queryHash,
                requiredNodes: index + 1,
                maxResultNodes,
              })
            }
            if (frame.isValue()) {
              if (collected[index] !== undefined) {
                throw new MemoryError(
                  'storage_failed',
                  'raw query returned a value after a terminal statement frame',
                )
              }
              const value = admitValue(frame.value, index)
              const previous = values.get(index)
              if (frame.isSingle) {
                if (previous !== undefined) {
                  throw new MemoryError(
                    'storage_failed',
                    'raw query returned conflicting scalar and batched frames',
                  )
                }
                values.set(index, { mode: 'single', value })
              } else {
                if (previous?.mode === 'single') {
                  throw new MemoryError(
                    'storage_failed',
                    'raw query returned conflicting scalar and batched frames',
                  )
                }
                if (previous === undefined) {
                  values.set(index, { mode: 'batch', value: [value] })
                } else {
                  const batch = previous.value as JsonValue[]
                  batch.push(value)
                }
              }
              continue
            }
            if (frame.isError()) {
              if (collected[index] !== undefined) {
                throw new MemoryError(
                  'storage_failed',
                  'raw query returned more than one terminal frame for a statement',
                )
              }
              values.delete(index)
              const stats = rawQueryStats(frame.stats)
              collected[index] = {
                index,
                success: false,
                error: rawQueryError(frame.error),
                ...(stats === undefined ? {} : { stats }),
              }
              continue
            }
            if (!frame.isDone()) {
              throw new MemoryError('storage_failed', 'raw query returned an unknown frame')
            }
            if (collected[index] !== undefined) {
              throw new MemoryError(
                'storage_failed',
                'raw query returned more than one terminal frame for a statement',
              )
            }
            const accumulated = values.get(index)
            values.delete(index)
            const stats = rawQueryStats(frame.stats)
            collected[index] = {
              index,
              success: true,
              type: frame.type,
              result: accumulated === undefined ? [] : accumulated.value,
              ...(stats === undefined ? {} : { stats }),
            }
          }
          if (values.size > 0) {
            throw new MemoryError(
              'storage_failed',
              'raw query stream ended before every statement completed',
            )
          }
          for (let index = 0; index < collected.length; index += 1) {
            if (collected[index] === undefined) {
              throw new MemoryError('storage_failed', 'raw query omitted a statement response')
            }
          }
          return collected as SurrealRawQueryStatement<JsonValue>[]
        },
        {
          unknownOutcome: (error) => {
            const normalized = normalizeStorageError(error)
            return new MemoryError(normalized.code, normalized.message, {
              retryable: false,
              cause: error,
              details: {
                ...normalized.details,
                queryOutcome: 'unknown',
                requiresReopen: true,
              },
            })
          },
        },
      )
      const response = {
        queryHash,
        statements,
        allSucceeded: statements.every((statement) => statement.success),
        byteLength: 0,
      }
      let resultNodes: number
      try {
        resultNodes = validateJson(response, 'raw query response', {
          maxNodes: MAX_RAW_RESULT_NODES,
          maxStringBytes: MAX_RAW_RESULT_BYTES,
        }).nodes
      } catch (error) {
        if (MemoryError.is(error) && error.message.includes('exceeds')) {
          throw rawResultTooLarge('raw query response exceeds a hard JSON result limit', {
            queryHash,
            maxResultBytes: MAX_RAW_RESULT_BYTES,
            maxResultNodes: MAX_RAW_RESULT_NODES,
          })
        }
        throw new MemoryError('storage_failed', 'raw query returned a non-JSON response', {
          cause: error,
        })
      }
      if (resultNodes > maxResultNodes) {
        throw rawResultTooLarge('raw query response exceeds maxResultNodes', {
          queryHash,
          requiredNodes: resultNodes,
          maxResultNodes,
        })
      }
      const encoder = new TextEncoder()
      for (;;) {
        const byteLength = encoder.encode(
          stableStringify(response as unknown as JsonValue),
        ).byteLength
        if (byteLength === response.byteLength) break
        response.byteLength = byteLength
      }
      if (response.byteLength > maxResultBytes) {
        throw rawResultTooLarge('raw query response exceeds maxResultBytes', {
          queryHash,
          requiredBytes: response.byteLength,
          maxResultBytes,
        })
      }
      return response as unknown as SurrealRawQueryResult<R>
    } catch (error) {
      if (
        MemoryError.is(error) &&
        error.retryable === false &&
        error.details?.queryOutcome === 'unknown'
      ) {
        throw error
      }
      if (responsesReceived) throw rawPostResponseError(error, queryHash)
      if (MemoryError.is(error)) throw error
      throw normalizeStorageError(error)
    }
  }

  async #recordId(table: TableName, spaceId: string, externalId: string): Promise<RecordId> {
    return new RecordId(table, await sha256(`${spaceId}\u0000${externalId}`))
  }

  async createSpace(space: StoredSpace): Promise<void> {
    const id = await this.#recordId('tm_space', space.spaceId, space.id)
    const existing = await this.#databaseCall(() => this.#db.select<Envelope>(id).json())
    if (existing !== undefined) throw new MemoryError('space_exists')
    try {
      await this.#databaseCall(() =>
        this.#db.create<Envelope>(id).content(spaceEnvelope(space)).json(),
      )
    } catch (error) {
      const raced = await this.#databaseCall(() => this.#db.select<Envelope>(id).json()).catch(
        () => undefined,
      )
      if (raced !== undefined) throw new MemoryError('space_exists')
      throw normalizeStorageError(error)
    }
  }

  async getSpace(spaceId: string): Promise<StoredSpace | null> {
    const id = await this.#recordId('tm_space', spaceId, spaceId)
    const value = await this.#databaseCall(() => this.#db.select<Envelope>(id).json())
    return value === undefined ? null : asSpace(value.payload)
  }

  async migrationHistory(spaceId: string): Promise<StoredSchemaMigration[]> {
    const [rows] = await this.#databaseCall(() =>
      this.#db
        .query(
          `SELECT payload, migration_sequence, external_id FROM tm_migration WHERE space_id = $space ORDER BY migration_sequence ASC, external_id ASC LIMIT ${MAX_SCHEMA_MIGRATION_RECORDS};`,
          { space: spaceId },
        )
        .json()
        .collect<[QueryEnvelope[]]>(),
    )
    return rows.map((row) => asMigration(row.payload))
  }

  async applyMigration(change: StorageMigrationChange): Promise<StoredSpace> {
    assertStorageMigrationChange(change)
    const spaceRecord = await this.#recordId('tm_space', change.spaceId, change.spaceId)
    const migrationRecord = await this.#recordId(
      'tm_migration',
      change.spaceId,
      change.migration.id,
    )
    const current = await this.getSpace(change.spaceId)
    if (current === null) throw new MemoryError('space_not_found')
    const existingEnvelope = await this.#databaseCall(() =>
      this.#db.select<Envelope>(migrationRecord).json(),
    )
    const existing =
      existingEnvelope === undefined ? undefined : asMigration(existingEnvelope.payload)
    if (
      existing?.checksum === change.migration.checksum &&
      current.schemaVersion === change.migration.toSchemaVersion
    ) {
      return current
    }
    if (existing !== undefined) {
      throw new MemoryError('integrity_failed', 'schema migration checkpoint already differs')
    }
    if (
      current.revision !== change.expectedRevision ||
      (current.metadataRevision ?? 0) !== change.expectedMetadataRevision ||
      current.schemaVersion !== change.expectedSchemaVersion
    ) {
      throw new MemoryError('conflict', 'schema migration premise changed', { retryable: true })
    }
    const updated: StoredSpace = {
      ...current,
      schemaVersion: change.migration.toSchemaVersion,
      metadataRevision: (current.metadataRevision ?? change.defaults.metadataRevision ?? 0) + 1,
      canonicalRevision: current.canonicalRevision ?? change.defaults.canonicalRevision,
      signalChangesCompactedThrough:
        current.signalChangesCompactedThrough ?? change.defaults.signalChangesCompactedThrough ?? 0,
    }
    try {
      await this.#transaction(
        `BEGIN TRANSACTION;
LET $migration_current = SELECT VALUE payload FROM ONLY $space_record;
IF $migration_current = NONE { THROW 'TM_SPACE_NOT_FOUND'; };
IF $migration_current.revision != $expected_revision OR $migration_current.metadataRevision != $expected_metadata_revision OR $migration_current.schemaVersion != $expected_schema_version {
  THROW 'TM_SCHEMA_MIGRATION_CONFLICT';
};
LET $migration_existing = SELECT VALUE payload FROM ONLY $migration_record;
IF $migration_existing != NONE { THROW 'TM_SCHEMA_MIGRATION_CONFLICT'; };
CREATE $migration_record CONTENT $migration_content;
UPSERT $space_record CONTENT $space_content;
COMMIT TRANSACTION;`,
        {
          space_record: spaceRecord,
          migration_record: migrationRecord,
          expected_revision: change.expectedRevision,
          expected_metadata_revision: change.expectedMetadataRevision,
          expected_schema_version: change.expectedSchemaVersion,
          migration_content: migrationEnvelope(change.migration),
          space_content: spaceEnvelope(updated),
        },
      )
      return updated
    } catch (error) {
      const [raced, racedEnvelope] = await Promise.all([
        this.getSpace(change.spaceId).catch(() => null),
        this.#databaseCall(() => this.#db.select<Envelope>(migrationRecord).json()).catch(
          () => undefined,
        ),
      ])
      const racedMigration =
        racedEnvelope === undefined ? undefined : asMigration(racedEnvelope.payload)
      if (
        raced !== null &&
        raced.schemaVersion === change.migration.toSchemaVersion &&
        racedMigration?.checksum === change.migration.checksum
      ) {
        return raced
      }
      throw transactionError(error)
    }
  }

  async deleteSpace(spaceId: string, expectedRevision: number): Promise<void> {
    const spaceRecord = await this.#recordId('tm_space', spaceId, spaceId)
    const current = await this.getSpace(spaceId)
    if (current === null) throw new MemoryError('space_not_found')
    try {
      await this.#transaction(
        `BEGIN TRANSACTION;
${REVISION_GUARD}
${SPACE_TABLES.map((table) => `DELETE ${table} WHERE space_id = $space;`).join('\n')}
DELETE $space_record;
COMMIT TRANSACTION;`,
        {
          space: spaceId,
          space_record: spaceRecord,
          expected_revision: expectedRevision,
          expected_metadata_revision: current.metadataRevision ?? 0,
          expected_canonical_revision: current.canonicalRevision ?? 0,
        },
      )
    } catch (error) {
      throw transactionError(error)
    }
  }

  async get<K extends StoredRecordKind>(
    kind: K,
    spaceId: string,
    externalId: string,
  ): Promise<RecordOfKind<K> | null> {
    const id = await this.#recordId(tableFor(kind), spaceId, externalId)
    const value = await this.#databaseCall(() => this.#db.select<Envelope>(id).json())
    return value === undefined ? null : asRecord<K>(value.payload)
  }

  async query<K extends StoredRecordKind>(query: StorageQuery<K>): Promise<RecordOfKind<K>[]> {
    if (
      query.startAfter !== undefined &&
      (query.order === undefined || query.startAfter.length !== query.order.length)
    ) {
      throw new MemoryError('invalid_input', 'storage startAfter must match query order')
    }
    const bindings: Record<string, unknown> = { space: query.spaceId }
    const predicates = ['space_id = $space']
    for (const [index, filter] of (query.filters ?? []).entries()) {
      const field = QUERY_FIELDS[filter.field]
      if (field === undefined)
        throw new MemoryError('storage_failed', `unsupported query field: ${filter.field}`)
      if (filter.op === 'defined') {
        predicates.push(`${field} != NONE`)
        continue
      }
      const binding = `value${index}`
      bindings[binding] = filter.value
      predicates.push(`${field} ${operator(filter)} $${binding}`)
    }
    if (query.startAfter !== undefined) {
      const terms = query.order!.map((order, index) => {
        const field = QUERY_FIELDS[order.field]
        if (field === undefined) {
          throw new MemoryError('storage_failed', `unsupported order field: ${order.field}`)
        }
        const binding = `after${index}`
        bindings[binding] = query.startAfter![index]
        const equalPrefix = query.order!.slice(0, index).map((prefix, prefixIndex) => {
          const prefixField = QUERY_FIELDS[prefix.field]
          if (prefixField === undefined) {
            throw new MemoryError('storage_failed', `unsupported order field: ${prefix.field}`)
          }
          return `${prefixField} = $after${prefixIndex}`
        })
        return `(${[...equalPrefix, `${field} ${order.direction === 'asc' ? '>' : '<'} $${binding}`].join(' AND ')})`
      })
      predicates.push(`(${terms.join(' OR ')})`)
    }
    const ordering = (query.order ?? []).map((order) => {
      const field = QUERY_FIELDS[order.field]
      if (field === undefined)
        throw new MemoryError('storage_failed', `unsupported order field: ${order.field}`)
      return `${field} ${order.direction.toUpperCase()}`
    })
    const selectedOrderFields = [
      ...new Set(
        (query.order ?? []).map((order) => {
          const field = QUERY_FIELDS[order.field]
          if (field === undefined) {
            throw new MemoryError('storage_failed', `unsupported order field: ${order.field}`)
          }
          return field
        }),
      ),
    ]
    const limit = query.limit === undefined ? '' : ` LIMIT ${boundedLimit(query.limit)}`
    // The embedded IndexedDB engine currently builds an invalid key range for descending generic
    // queries. A table iterator preserves the bounded result contract until it can plan them safely.
    const iterator =
      query.order?.some((order) => order.direction === 'desc') === true ? ' WITH NOINDEX' : ''
    const sql = `SELECT payload${selectedOrderFields.map((field) => `, ${field}`).join('')} FROM ${tableFor(query.kind)}${iterator} WHERE ${predicates.join(' AND ')}${
      ordering.length === 0 ? '' : ` ORDER BY ${ordering.join(', ')}`
    }${limit}`
    const [rows] = await this.#databaseCall(() =>
      this.#db.query(sql, bindings).json().collect<[QueryEnvelope[]]>(),
    )
    return rows.map((row) => asRecord<K>(row.payload))
  }

  async count<K extends StoredRecordKind>(query: StorageCountQuery<K>): Promise<number> {
    const bindings: Record<string, unknown> = { space: query.spaceId }
    const predicates = ['space_id = $space']
    for (const [index, filter] of (query.filters ?? []).entries()) {
      const field = QUERY_FIELDS[filter.field]
      if (field === undefined) {
        throw new MemoryError('storage_failed', `unsupported count field: ${filter.field}`)
      }
      if (filter.op === 'defined') {
        predicates.push(`${field} != NONE`)
        continue
      }
      const binding = `count_value${index}`
      bindings[binding] = filter.value
      predicates.push(`${field} ${operator(filter)} $${binding}`)
    }
    const [rows] = await this.#databaseCall(() =>
      this.#db
        .query(
          `SELECT count() AS count FROM ${tableFor(query.kind)} WHERE ${predicates.join(' AND ')} GROUP ALL;`,
          bindings,
        )
        .json()
        .collect<[CountEnvelope[]]>(),
    )
    const count = rows[0]?.count ?? 0
    if (rows.length > 1 || !Number.isSafeInteger(count) || count < 0) {
      throw new MemoryError('storage_failed', 'storage count returned an invalid aggregate')
    }
    return count
  }

  async commit(change: StorageCommit): Promise<number> {
    assertStorageCommitSemantics(change)
    for (const record of change.puts ?? []) {
      if (record.spaceId !== change.spaceId) {
        throw new MemoryError('integrity_failed', 'cross-space record in commit')
      }
    }
    const current = await this.getSpace(change.spaceId)
    if (current === null) throw new MemoryError('space_not_found')
    if (current.revision !== change.expectedRevision) {
      throw new MemoryError('conflict', 'revision changed', { retryable: true })
    }
    if (
      change.expectedCanonicalRevision !== undefined &&
      (current.canonicalRevision ?? 0) !== change.expectedCanonicalRevision
    ) {
      throw new MemoryError('conflict', 'canonical memory changed', { retryable: true })
    }
    if (
      change.changeCompaction !== undefined &&
      change.changeCompaction.throughRevision < current.changesCompactedThrough
    ) {
      throw new MemoryError('integrity_failed', 'semantic change compaction floor moved backwards')
    }
    if (
      change.signalChangeCompaction !== undefined &&
      change.signalChangeCompaction.throughRevision < current.signalChangesCompactedThrough
    ) {
      throw new MemoryError('integrity_failed', 'signal change compaction floor moved backwards')
    }
    const revision = change.metadataOnly === true ? current.revision : current.revision + 1
    const canonicalRevision =
      (current.canonicalRevision ?? 0) +
      (change.metadataOnly === true || change.semanticChange === undefined ? 0 : 1)
    const metadataRevision = (current.metadataRevision ?? 0) + 1
    const updatedAt = new Date().toISOString()
    const updated: StoredSpace = {
      ...current,
      revision,
      canonicalRevision,
      metadataRevision,
      updatedAt,
      changesCompactedThrough:
        change.changeCompaction?.throughRevision ?? current.changesCompactedThrough,
      signalChangesCompactedThrough:
        change.signalChangeCompaction?.throughRevision ?? current.signalChangesCompactedThrough,
      ...(change.projectionSetActivations === undefined
        ? {}
        : {
            projectionSets: {
              ...current.projectionSets,
              ...Object.fromEntries(
                change.projectionSetActivations.map(({ kind, set }) => [kind, set]),
              ),
            },
          }),
    }
    const spaceRecord = await this.#recordId('tm_space', change.spaceId, change.spaceId)
    const bindings: Record<string, unknown> = {
      space_record: spaceRecord,
      expected_revision: change.expectedRevision,
      expected_metadata_revision: current.metadataRevision ?? 0,
      expected_canonical_revision:
        change.expectedCanonicalRevision ?? current.canonicalRevision ?? 0,
      space_content: spaceEnvelope(updated),
      space: change.spaceId,
    }
    const statements: string[] = ['BEGIN TRANSACTION;', REVISION_GUARD]
    for (const [index, guard] of (change.metadataGuards ?? []).entries()) {
      const recordBinding = `metadata_guard_record${index}`
      const valueBinding = `metadata_guard_value${index}`
      const variable = `metadata_guard${index}`
      bindings[recordBinding] = await this.#recordId(tableFor(guard.kind), change.spaceId, guard.id)
      statements.push(`LET $${variable} = SELECT VALUE payload FROM ONLY $${recordBinding};`)
      if (guard.expected === null) {
        statements.push(`IF $${variable} != NONE { THROW 'TM_METADATA_CONFLICT'; };`)
      } else {
        bindings[valueBinding] = guard.expected
        statements.push(
          `IF $${variable} = NONE OR $${variable} != $${valueBinding} { THROW 'TM_METADATA_CONFLICT'; };`,
        )
      }
    }
    if (change.changeCompaction !== undefined) {
      bindings.change_compaction_through = change.changeCompaction.throughRevision
      statements.push(
        'DELETE tm_change WHERE space_id = $space AND revision <= $change_compaction_through;',
      )
    }
    if (change.signalChangeCompaction !== undefined) {
      bindings.signal_change_compaction_through = change.signalChangeCompaction.throughRevision
      statements.push(
        'DELETE tm_signal_change WHERE space_id = $space AND revision <= $signal_change_compaction_through;',
      )
    }
    if (change.signalKeyDeletes !== undefined) {
      bindings.signal_delete_keys = change.signalKeyDeletes
      statements.push(
        'DELETE tm_signal WHERE space_id = $space AND logical_key IN $signal_delete_keys;',
      )
    }
    for (const [index, deletion] of (change.deletes ?? []).entries()) {
      const binding = `delete${index}`
      bindings[binding] = await this.#recordId(tableFor(deletion.kind), change.spaceId, deletion.id)
      statements.push(`DELETE $${binding};`)
    }
    for (const [index, record] of (change.puts ?? []).entries()) {
      const recordBinding = `put${index}`
      const contentBinding = `put_content${index}`
      bindings[recordBinding] = await this.#recordId(
        tableFor(record.kindRecord),
        change.spaceId,
        record.id,
      )
      bindings[contentBinding] = envelope(record)
      statements.push(`UPSERT $${recordBinding} CONTENT $${contentBinding};`)
    }
    for (const [index, activation] of (change.projectionSetActivations ?? []).entries()) {
      const setBinding = `projection_activation_set${index}`
      const kindBinding = `projection_activation_kind${index}`
      bindings[setBinding] = activation.set.id
      bindings[kindBinding] = activation.kind
      if (activation.kind === 'lexical') {
        statements.push(
          `UPDATE tm_projection SET text = NONE WHERE space_id = $space AND projection_kind = $${kindBinding} AND (set_id = NONE OR set_id != $${setBinding});`,
        )
      }
      statements.push(
        `UPDATE tm_projection SET state = 'ready', payload.state = 'ready'${
          activation.kind === 'lexical' ? ', text = payload.text' : ''
        } WHERE space_id = $space AND projection_kind = $${kindBinding} AND set_id = $${setBinding} AND state = 'building';`,
      )
    }
    if (change.semanticChange !== undefined) {
      const record = materializeStoredChange(
        change.spaceId,
        revision,
        updatedAt,
        change.semanticChange,
      )
      const recordBinding = 'semantic_change'
      const contentBinding = 'semantic_change_content'
      bindings[recordBinding] = await this.#recordId('tm_change', change.spaceId, record.id)
      bindings[contentBinding] = envelope(record)
      statements.push(`CREATE $${recordBinding} CONTENT $${contentBinding};`)
    }
    if (change.signalChange !== undefined) {
      const record = materializeStoredSignalChange(
        change.spaceId,
        revision,
        updatedAt,
        change.signalChange,
      )
      const recordBinding = 'signal_change'
      const contentBinding = 'signal_change_content'
      bindings[recordBinding] = await this.#recordId('tm_signal_change', change.spaceId, record.id)
      bindings[contentBinding] = envelope(record)
      statements.push(`CREATE $${recordBinding} CONTENT $${contentBinding};`)
    }
    statements.push('UPSERT $space_record CONTENT $space_content;')
    statements.push('COMMIT TRANSACTION;')
    try {
      await this.#transaction(statements.join('\n'), bindings)
      return revision
    } catch (error) {
      const raced = await this.getSpace(change.spaceId).catch(() => null)
      if (
        raced !== null &&
        (raced.revision !== change.expectedRevision ||
          (raced.metadataRevision ?? 0) !== (current.metadataRevision ?? 0) ||
          (change.expectedCanonicalRevision !== undefined &&
            (raced.canonicalRevision ?? 0) !== change.expectedCanonicalRevision))
      ) {
        throw new MemoryError('conflict', 'revision changed', {
          retryable: true,
          cause: error,
        })
      }
      throw transactionError(error)
    }
  }

  async lexicalSearch(
    spaceId: string,
    query: string,
    generation: string,
    allowedScopes: readonly string[],
    limit: number,
    setId?: string,
  ): Promise<RankedStoredRecord<'projection'>[]> {
    const setPredicate = setId === undefined ? 'AND set_id = NONE' : 'AND set_id = $set_id'
    const [rows] = await this.#databaseCall(() =>
      this.#db
        .query(
          `SELECT payload, search::score(0) AS score FROM tm_projection
         WHERE space_id = $space AND projection_kind = 'lexical' AND state = 'ready'
           AND generation = $generation
           ${setPredicate}
           AND scopes ALLINSIDE $allowed_scopes
           AND text @0@ $query
         ORDER BY score DESC LIMIT ${boundedLimit(limit)}`,
          {
            space: spaceId,
            query,
            generation,
            allowed_scopes: allowedScopes,
            ...(setId === undefined ? {} : { set_id: setId }),
          },
        )
        .json()
        .collect<[RankedEnvelope[]]>(),
    )
    return rows.map((row) => ({ record: asRecord<'projection'>(row.payload), score: row.score }))
  }

  async vectorSearch(
    spaceId: string,
    vector: readonly number[],
    generation: string,
    allowedScopes: readonly string[],
    limit: number,
    setId?: string,
  ): Promise<RankedStoredRecord<'projection'>[]> {
    const setPredicate = setId === undefined ? 'AND set_id = NONE' : 'AND set_id = $set_id'
    const [rows] = await this.#databaseCall(() =>
      this.#db
        .query(
          `SELECT payload, vector::similarity::cosine(vector, $vector) AS score
         FROM tm_projection
         WHERE space_id = $space AND projection_kind = 'embedding'
           AND generation = $generation AND state = 'ready'
           ${setPredicate}
           AND scopes ALLINSIDE $allowed_scopes
         ORDER BY score DESC LIMIT ${boundedLimit(limit)}`,
          {
            space: spaceId,
            vector,
            generation,
            allowed_scopes: allowedScopes,
            ...(setId === undefined ? {} : { set_id: setId }),
          },
        )
        .json()
        .collect<[RankedEnvelope[]]>(),
    )
    return rows.map((row) => ({ record: asRecord<'projection'>(row.payload), score: row.score }))
  }

  async exportRecords(spaceId: string): Promise<StoredRecord[]> {
    const records: StoredRecord[] = []
    for (const kind of Object.keys(TABLE_BY_KIND) as StoredRecordKind[]) {
      if (LOCAL_METADATA_KINDS.has(kind)) continue
      records.push(...(await this.query({ kind, spaceId })))
    }
    return records.sort(
      (left, right) =>
        compareUnicode(left.kindRecord, right.kindRecord) || compareUnicode(left.id, right.id),
    )
  }
}

function operator(filter: StorageFilter): string {
  switch (filter.op) {
    case 'eq':
      return '='
    case 'ne':
      return '!='
    case 'lt':
      return '<'
    case 'lte':
      return '<='
    case 'gt':
      return '>'
    case 'gte':
      return '>='
    case 'in':
      return 'IN'
    case 'contains':
      return 'CONTAINS'
    case 'all_inside':
      return 'ALLINSIDE'
    case 'contains_all':
      return 'CONTAINSALL'
    case 'contains_any':
      return 'CONTAINSANY'
    case 'contains_none':
      return 'CONTAINSNONE'
    case 'defined':
      return '!='
  }
}

function boundedLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new MemoryError('invalid_input', 'storage query limit must be between 1 and 10000')
  }
  return value
}

export function createSurrealMemoryStorage(
  options: SurrealMemoryStorageOptions = {},
): SurrealMemoryStorage {
  assertSurrealStorageOptions(options)
  return createSurrealStorage(options).storage
}

function assertSurrealStorageOptions(
  options: SurrealMemoryStorageOptions,
): asserts options is SurrealMemoryStorageOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new MemoryError('invalid_input', 'Surreal storage options must be an object')
  }
  const allowedFields = new Set(['endpoint', 'namespace', 'database', 'worker'])
  for (const field of Object.keys(options)) {
    if (!allowedFields.has(field)) {
      throw new MemoryError('invalid_input', `unknown Surreal storage option: ${field}`)
    }
  }
  if (options.worker !== undefined && typeof options.worker !== 'boolean') {
    throw new MemoryError('invalid_input', 'worker must be a boolean')
  }
}

function createSurrealStorage(options: SurrealMemoryStorageOptions): {
  storage: SurrealMemoryStorage
  driver: SurrealDriver
} {
  const driver = new SurrealDriver(options)
  const storage = defineMemoryStorage(driver) as SurrealMemoryStorage
  return { storage, driver }
}

export function createSurrealMemoryCapabilities(
  storageOptions: SurrealMemoryStorageOptions,
  adminOptions: SurrealMemoryAdminOptions,
): SurrealMemoryCapabilities {
  assertSurrealStorageOptions(storageOptions)
  if (typeof adminOptions !== 'object' || adminOptions === null || Array.isArray(adminOptions)) {
    throw new MemoryError('invalid_input', 'Surreal admin options are required')
  }
  for (const field of Object.keys(adminOptions)) {
    if (field !== 'dangerouslyAllowRawQueries') {
      throw new MemoryError('invalid_input', `unknown Surreal admin option: ${field}`)
    }
  }
  if (adminOptions.dangerouslyAllowRawQueries !== true) {
    throw new MemoryError(
      'policy_denied',
      'raw SurrealQL admin capability requires dangerouslyAllowRawQueries: true',
    )
  }
  const { storage, driver } = createSurrealStorage(storageOptions)
  const admin: SurrealMemoryAdmin = Object.freeze({
    rawQuery<R extends readonly JsonValue[] = readonly JsonValue[]>(
      request: SurrealRawQueryRequest,
    ): Promise<SurrealRawQueryResult<R>> {
      return driver.rawQuery<R>(request)
    },
  })
  return Object.freeze({ storage, admin })
}
