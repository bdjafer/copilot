import type {
  StoredDerivation,
  StoredPurge,
  StoredRecord,
  StoredSignal,
  StoredSyncCheckpoint,
  StoredSyncChunk,
  StoredSyncIndex,
} from '../storage/driver.ts'
import type { JsonValue, SyncCheckpoint, SyncChunk, SyncRecord, SyncRecordKind } from '../types.ts'

import { MemoryError } from '../errors.ts'
import {
  assertInstant,
  assertString,
  cloneJson,
  compareUnicode,
  normalizeScopes,
  sha256,
  stableStringify,
  validateJson,
} from './value.ts'

export const SYNC_PROTOCOL_VERSION = 1 as const
export const SYNC_CHECKPOINT_MEDIA_TYPE =
  'application/vnd.astrale.temporal-memory-sync-checkpoint+json' as const
export const DEFAULT_SYNC_CHUNK_BYTES = 8 * 1024 * 1024
export const MIN_SYNC_CHUNK_BYTES = 64 * 1024
export const MAX_SYNC_CHUNK_BYTES = 16 * 1024 * 1024
export const MAX_SYNC_CHUNK_JSON_NODES = 1_000_000
export const MAX_SYNC_RECORD_JSON_DEPTH = 72
export const MAX_SYNC_RECORD_ID_BYTES = 4_096
export const MAX_SYNC_RECORD_KEY_BYTES = 8_192

const SYNC_RECORD_DIGEST_DOMAIN = 'astrale.temporal-memory/sync-record/v1'
const SYNC_CHUNK_DIGEST_DOMAIN = 'astrale.temporal-memory/sync-chunk/v1'
const SYNC_CHAIN_DOMAIN = 'astrale.temporal-memory/sync-chain/v1'
const SYNC_COMMIT_DOMAIN = 'astrale.temporal-memory/sync-checkpoint/v1'
const SYNC_GENESIS_DOMAIN = 'astrale.temporal-memory/sync-genesis/v1'
const SYNC_INDEX_DOMAIN = 'astrale.temporal-memory/sync-index/v1'
const PURGED_EPISODE_IDEMPOTENCY_HASH_DOMAIN =
  'astrale.temporal-memory/purged-episode-idempotency-key/v1'
const SYNC_CHECKPOINT_FIELDS = [
  'byteLength',
  'chunkCount',
  'createdAt',
  'id',
  'mediaType',
  'ontologyDigest',
  'parents',
  'protocolVersion',
  'recordCount',
  'rootDigest',
  'scopes',
  'spaceId',
] as const
const MAX_SYNC_CHECKPOINT_SCOPES = 100_000
export const MAX_SYNC_CHECKPOINT_JSON_NODES = 200_000
export const MAX_SYNC_CHECKPOINT_JSON_DEPTH = 4
export const MAX_SYNC_CHECKPOINT_STRING_BYTES = 4_000_000

export const SYNC_RECORD_KINDS: readonly SyncRecordKind[] = [
  'alias',
  'derivation',
  'entity',
  'episode',
  'evidence',
  'fact',
  'lifecycle',
  'mention',
  'merge',
  'purge',
  'signal',
]

const SYNC_KIND_ORDER = new Map(SYNC_RECORD_KINDS.map((kind, index) => [kind, index]))

export function compareSyncRecords(left: SyncRecord, right: SyncRecord): number {
  return compareUnicode(left.key, right.key)
}

export function syncRecordKey(kind: SyncRecordKind, id: string): string {
  return `${kind}\u0000${id}`
}

export function normalizeSyncChunkBytes(value: number | undefined): number {
  const bytes = value ?? DEFAULT_SYNC_CHUNK_BYTES
  if (!Number.isInteger(bytes) || bytes < MIN_SYNC_CHUNK_BYTES || bytes > MAX_SYNC_CHUNK_BYTES) {
    throw new MemoryError(
      'invalid_input',
      `maxChunkBytes must be between ${MIN_SYNC_CHUNK_BYTES} and ${MAX_SYNC_CHUNK_BYTES}`,
    )
  }
  return bytes
}

export function validateSyncRecordJson(record: unknown, field = 'sync record') {
  if (
    typeof record !== 'object' ||
    record === null ||
    Array.isArray(record) ||
    stableStringify(Object.keys(record).sort(compareUnicode)) !==
      stableStringify(['id', 'key', 'kind', 'value'])
  ) {
    throw new MemoryError('invalid_input', `${field} must have the exact sync-record envelope`)
  }
  const candidate = record as SyncRecord
  assertString(candidate.id, `${field}.id`, MAX_SYNC_RECORD_ID_BYTES)
  assertString(candidate.key, `${field}.key`, MAX_SYNC_RECORD_KEY_BYTES)
  if (
    !SYNC_RECORD_KINDS.includes(candidate.kind) ||
    candidate.key !== syncRecordKey(candidate.kind, candidate.id)
  ) {
    throw new MemoryError('invalid_input', `${field} has an invalid identity`)
  }
  return validateJson(record, field, {
    maxNodes: MAX_SYNC_CHUNK_JSON_NODES,
    maxDepth: MAX_SYNC_RECORD_JSON_DEPTH,
    maxStringBytes: MAX_SYNC_CHUNK_BYTES,
  })
}

export function portableSyncRecord(record: StoredRecord): SyncRecord | null {
  if (!SYNC_KIND_ORDER.has(record.kindRecord as SyncRecordKind)) return null
  if (record.kindRecord === 'purge' && record.state !== 'succeeded') return null
  const raw = cloneJson(record as unknown as JsonValue) as Record<string, JsonValue>
  delete raw.kindRecord
  delete raw.id
  delete raw.spaceId
  if (record.kindRecord === 'signal' || record.kindRecord === 'derivation') {
    delete raw.inputRevision
    delete raw.recordedRevision
  }
  if (record.kindRecord === 'purge') {
    // A successful marker is a monotonic privacy tombstone. Never replicate an old cleartext target
    // list or caller-controlled operation id even if an adapter retained either one.
    raw.targets = []
    delete raw.operationId
  }
  const kind = record.kindRecord as SyncRecordKind
  return {
    key: syncRecordKey(kind, record.id),
    kind,
    id: record.id,
    value: raw,
  }
}

export function materializeSyncRecord(
  record: SyncRecord,
  spaceId: string,
  inputRevision: number,
): StoredRecord {
  if (record.key !== syncRecordKey(record.kind, record.id)) {
    throw new MemoryError('integrity_failed', 'sync record key does not match kind and id')
  }
  const base = {
    ...cloneJson(record.value),
    kindRecord: record.kind,
    id: record.id,
    spaceId,
  }
  if (record.kind === 'signal' || record.kind === 'derivation') {
    return {
      ...base,
      inputRevision,
      recordedRevision: inputRevision + 1,
    } as StoredSignal | StoredDerivation
  }
  if (record.kind === 'purge') {
    return {
      ...base,
      operationId: `sync_${record.id}`,
    } as StoredPurge
  }
  return base as StoredRecord
}

export async function syncRecordDigest(record: SyncRecord): Promise<string> {
  return sha256(stableStringify([SYNC_RECORD_DIGEST_DOMAIN, record] as unknown as JsonValue))
}

export function syncRecordByteLength(record: SyncRecord): number {
  return new TextEncoder().encode(stableStringify(record as unknown as JsonValue)).byteLength
}

export async function syncChunkDigest(records: readonly SyncRecord[]): Promise<string> {
  return sha256(stableStringify([SYNC_CHUNK_DIGEST_DOMAIN, records] as unknown as JsonValue))
}

/** Validates one durable chunk, including its exact address, bounds, ordering, and digest. */
export async function validateStoredSyncChunkRecord(
  chunk: StoredSyncChunk,
  expected: { spaceId: string; ownerId?: string; index?: number },
): Promise<void> {
  if (
    stableStringify(Object.keys(chunk).sort(compareUnicode)) !==
      stableStringify([
        'byteLength',
        'digest',
        'firstKey',
        'id',
        'index',
        'kindRecord',
        'lastKey',
        'ownerId',
        'records',
        'spaceId',
      ]) ||
    chunk.kindRecord !== 'sync_chunk' ||
    chunk.spaceId !== expected.spaceId ||
    (expected.ownerId !== undefined && chunk.ownerId !== expected.ownerId) ||
    (expected.index !== undefined && chunk.index !== expected.index) ||
    typeof chunk.ownerId !== 'string' ||
    chunk.ownerId.length === 0 ||
    !Number.isSafeInteger(chunk.index) ||
    chunk.index < 0 ||
    chunk.id !== `sync_chunk_${chunk.ownerId}_${chunk.index.toString().padStart(12, '0')}` ||
    !/^[a-f0-9]{64}$/u.test(chunk.digest) ||
    !Array.isArray(chunk.records) ||
    chunk.records.length < 1 ||
    chunk.records.length > 256 ||
    !Number.isSafeInteger(chunk.byteLength) ||
    chunk.byteLength < 2 ||
    chunk.byteLength > MAX_SYNC_CHUNK_BYTES
  ) {
    throw new MemoryError('integrity_failed', 'sync chunk address is inconsistent')
  }
  let actualBytes = 2
  let jsonNodes = 0
  let previousKey: string | undefined
  for (const [recordIndex, record] of chunk.records.entries()) {
    try {
      if (typeof record !== 'object' || record === null || Array.isArray(record)) {
        throw new Error('record is not an object')
      }
      jsonNodes += validateSyncRecordJson(record).nodes
      actualBytes += syncRecordByteLength(record) + (recordIndex === 0 ? 0 : 1)
    } catch (error) {
      throw new MemoryError('integrity_failed', 'sync chunk record is malformed', {
        cause: error,
      })
    }
    if (
      jsonNodes > MAX_SYNC_CHUNK_JSON_NODES ||
      actualBytes > MAX_SYNC_CHUNK_BYTES ||
      record.key !== syncRecordKey(record.kind, record.id) ||
      (previousKey !== undefined && compareUnicode(previousKey, record.key) >= 0)
    ) {
      throw new MemoryError('integrity_failed', 'sync chunk record bounds are invalid')
    }
    previousKey = record.key
  }
  if (
    chunk.firstKey !== chunk.records[0]!.key ||
    chunk.lastKey !== chunk.records.at(-1)!.key ||
    chunk.byteLength !== actualBytes
  ) {
    throw new MemoryError('integrity_failed', 'sync chunk manifest is inconsistent')
  }
  if ((await syncChunkDigest(chunk.records)) !== chunk.digest) {
    throw new MemoryError('integrity_failed', 'sync chunk checksum is invalid')
  }
}

/** Validates one portable chunk without materializing any other chunk. */
export async function validateSyncChunkEnvelope(
  checkpoint: SyncCheckpoint,
  chunk: SyncChunk,
  expectedIndex: number,
  previousKey?: string,
): Promise<{ firstKey: string; lastKey: string }> {
  if (
    typeof chunk !== 'object' ||
    chunk === null ||
    Array.isArray(chunk) ||
    stableStringify(Object.keys(chunk).sort(compareUnicode)) !==
      stableStringify(['byteLength', 'checkpointId', 'digest', 'index', 'records']) ||
    chunk.checkpointId !== checkpoint.id ||
    chunk.index !== expectedIndex ||
    !/^[a-f0-9]{64}$/u.test(chunk.digest) ||
    !Number.isSafeInteger(chunk.byteLength) ||
    chunk.byteLength < 2 ||
    chunk.byteLength > MAX_SYNC_CHUNK_BYTES ||
    !Array.isArray(chunk.records) ||
    chunk.records.length === 0 ||
    chunk.records.length > 256
  ) {
    throw new MemoryError('import_invalid', 'sync chunk envelope is malformed')
  }
  let last = previousKey
  let actualBytes = 2
  let jsonNodes = 0
  for (const [index, record] of chunk.records.entries()) {
    try {
      const metrics = validateSyncRecordJson(record, `sync chunk records[${index}]`)
      jsonNodes += metrics.nodes
      if (jsonNodes > MAX_SYNC_CHUNK_JSON_NODES) {
        throw new Error('chunk JSON node budget exceeded')
      }
      if (last !== undefined && compareUnicode(last, record.key) >= 0) {
        throw new Error('record order is invalid')
      }
      actualBytes += syncRecordByteLength(record) + (index === 0 ? 0 : 1)
      if (actualBytes > chunk.byteLength || actualBytes > MAX_SYNC_CHUNK_BYTES) {
        throw new Error('chunk byte budget exceeded')
      }
    } catch (error) {
      throw new MemoryError('import_invalid', 'sync chunk record is malformed', {
        cause: error,
      })
    }
    last = record.key
  }
  if (chunk.byteLength !== actualBytes || chunk.digest !== (await syncChunkDigest(chunk.records))) {
    throw new MemoryError('import_invalid', 'sync chunk checksum does not match its content')
  }
  return { firstKey: chunk.records[0]!.key, lastKey: chunk.records.at(-1)!.key }
}

export async function emptySyncRoot(): Promise<string> {
  return sha256(stableStringify([SYNC_CHAIN_DOMAIN, SYNC_PROTOCOL_VERSION]))
}

export async function appendSyncRoot(
  root: string,
  chunk: Pick<SyncChunk, 'index' | 'digest' | 'byteLength' | 'records'>,
): Promise<string> {
  const first = chunk.records[0]?.key ?? ''
  const last = chunk.records.at(-1)?.key ?? ''
  return sha256(
    stableStringify([
      SYNC_CHAIN_DOMAIN,
      root,
      chunk.index,
      chunk.digest,
      chunk.byteLength,
      chunk.records.length,
      first,
      last,
    ]),
  )
}

export async function syncCheckpointId(input: {
  spaceId: string
  parents: readonly string[]
  ontologyDigest: string
  rootDigest: string
  chunkCount: number
  recordCount: number
  byteLength: number
  scopes: readonly string[]
}): Promise<string> {
  return sha256(
    stableStringify([
      SYNC_COMMIT_DOMAIN,
      SYNC_PROTOCOL_VERSION,
      input.spaceId,
      [...input.parents].sort(compareUnicode),
      input.ontologyDigest,
      input.rootDigest,
      input.chunkCount,
      input.recordCount,
      input.byteLength,
      input.scopes,
    ]),
  )
}

export async function genesisSyncCheckpoint(input: {
  spaceId: string
  ontologyDigest: string
  createdAt: string
}): Promise<SyncCheckpoint> {
  const rootDigest = await emptySyncRoot()
  const id = await sha256(
    stableStringify([
      SYNC_GENESIS_DOMAIN,
      SYNC_PROTOCOL_VERSION,
      input.spaceId,
      input.ontologyDigest,
      rootDigest,
    ]),
  )
  return {
    mediaType: SYNC_CHECKPOINT_MEDIA_TYPE,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    id,
    spaceId: input.spaceId,
    parents: [],
    ontologyDigest: input.ontologyDigest,
    rootDigest,
    chunkCount: 0,
    recordCount: 0,
    byteLength: 0,
    scopes: [],
    createdAt: input.createdAt,
  }
}

export function publicSyncCheckpoint(checkpoint: StoredSyncCheckpoint): SyncCheckpoint {
  const {
    kindRecord: _kindRecord,
    chunkOwnerId: _owner,
    payloadState: _payloadState,
    pruningOwnerId: _pruningOwner,
    sourceRevision: _source,
    ...value
  } = checkpoint
  return cloneJson(value as unknown as JsonValue) as unknown as SyncCheckpoint
}

export async function validateSyncCheckpointId(checkpoint: SyncCheckpoint): Promise<void> {
  try {
    if (
      typeof checkpoint !== 'object' ||
      checkpoint === null ||
      Array.isArray(checkpoint) ||
      stableStringify(Object.keys(checkpoint).sort(compareUnicode)) !==
        stableStringify(SYNC_CHECKPOINT_FIELDS)
    ) {
      throw new Error('checkpoint fields are malformed')
    }
    validateJson(checkpoint, 'sync checkpoint header', {
      maxNodes: MAX_SYNC_CHECKPOINT_JSON_NODES,
      maxDepth: MAX_SYNC_CHECKPOINT_JSON_DEPTH,
      maxStringBytes: MAX_SYNC_CHECKPOINT_STRING_BYTES,
    })
    assertString(checkpoint.spaceId, 'sync checkpoint spaceId')
    assertInstant(checkpoint.createdAt, 'sync checkpoint createdAt')
    if (
      !Array.isArray(checkpoint.parents) ||
      checkpoint.parents.length > 2 ||
      checkpoint.parents.some(
        (parent, index) =>
          typeof parent !== 'string' ||
          !/^[a-f0-9]{64}$/u.test(parent) ||
          (index > 0 && compareUnicode(checkpoint.parents[index - 1]!, parent) >= 0),
      )
    ) {
      throw new Error('parents are malformed')
    }
    if (
      !Array.isArray(checkpoint.scopes) ||
      checkpoint.scopes.length > MAX_SYNC_CHECKPOINT_SCOPES ||
      stableStringify(normalizeScopes(checkpoint.scopes)) !== stableStringify(checkpoint.scopes)
    ) {
      throw new Error('scopes are malformed')
    }
  } catch (error) {
    throw new MemoryError('import_invalid', 'sync checkpoint header is malformed', {
      cause: error,
    })
  }
  if (
    checkpoint.mediaType !== SYNC_CHECKPOINT_MEDIA_TYPE ||
    checkpoint.protocolVersion !== SYNC_PROTOCOL_VERSION ||
    !/^[a-f0-9]{64}$/u.test(checkpoint.id) ||
    !/^[a-f0-9]{64}$/u.test(checkpoint.ontologyDigest) ||
    !/^[a-f0-9]{64}$/u.test(checkpoint.rootDigest) ||
    !Number.isSafeInteger(checkpoint.chunkCount) ||
    checkpoint.chunkCount < 0 ||
    !Number.isSafeInteger(checkpoint.recordCount) ||
    checkpoint.recordCount < 0 ||
    !Number.isSafeInteger(checkpoint.byteLength) ||
    checkpoint.byteLength < 0 ||
    checkpoint.chunkCount > checkpoint.recordCount ||
    checkpoint.recordCount > checkpoint.chunkCount * 256 ||
    checkpoint.byteLength > checkpoint.chunkCount * MAX_SYNC_CHUNK_BYTES
  ) {
    throw new MemoryError('import_invalid', 'sync checkpoint header is malformed')
  }
  if (checkpoint.parents.length === 0) {
    const canonicalRoot = await emptySyncRoot()
    const expectedGenesis = await sha256(
      stableStringify([
        SYNC_GENESIS_DOMAIN,
        SYNC_PROTOCOL_VERSION,
        checkpoint.spaceId,
        checkpoint.ontologyDigest,
        checkpoint.rootDigest,
      ]),
    )
    if (
      checkpoint.id !== expectedGenesis ||
      checkpoint.rootDigest !== canonicalRoot ||
      checkpoint.chunkCount !== 0 ||
      checkpoint.recordCount !== 0 ||
      checkpoint.byteLength !== 0 ||
      checkpoint.scopes.length !== 0
    ) {
      throw new MemoryError('import_invalid', 'sync genesis checkpoint is invalid')
    }
    return
  }
  if (
    checkpoint.parents.length < 1 ||
    checkpoint.chunkCount < 1 ||
    checkpoint.recordCount < 1 ||
    checkpoint.byteLength < 2
  ) {
    throw new MemoryError('import_invalid', 'non-genesis sync checkpoint is empty')
  }
  const expected = await syncCheckpointId(checkpoint)
  if (expected !== checkpoint.id) {
    throw new MemoryError('import_invalid', 'sync checkpoint id does not match its manifest')
  }
}

export async function syncIndexId(ownerId: string, key: string): Promise<string> {
  return `sync_index_${await sha256(stableStringify([SYNC_INDEX_DOMAIN, ownerId, key]))}`
}

/** Validates the closed durable representation of one random-access sync index. */
export function assertStoredSyncIndexShape(index: StoredSyncIndex): void {
  try {
    validateJson(index, 'sync index', { maxNodes: 4_096, maxStringBytes: 64 * 1024 })
    const allowed = new Set([
      'kindRecord',
      'id',
      'spaceId',
      'ownerId',
      'syncKey',
      'recordKind',
      'recordId',
      'digest',
      'byteLength',
      'chunkIndex',
      'idempotencyKey',
      'semanticKey',
      'logicalKey',
      'version',
      'state',
      'episodeId',
      'entityId',
      'subjectId',
      'predicate',
      'targetKind',
      'targetId',
      'conclusionFactId',
      'premiseFactIds',
      'premiseEvidenceIds',
      'identifierFingerprints',
      'scopeHash',
    ])
    if (Object.keys(index).some((key) => !allowed.has(key))) {
      throw new Error('sync index contains an unsupported field')
    }
    if (index.kindRecord !== 'sync_index') throw new Error('sync index record kind is invalid')
    assertString(index.id, 'syncIndex.id', 128)
    if (!/^sync_index_[a-f0-9]{64}$/u.test(index.id)) throw new Error('sync index id is invalid')
    assertString(index.spaceId, 'syncIndex.spaceId', 512)
    assertString(index.ownerId, 'syncIndex.ownerId', 1_024)
    assertString(index.syncKey, 'syncIndex.syncKey', MAX_SYNC_RECORD_KEY_BYTES)
    assertString(index.recordId, 'syncIndex.recordId', MAX_SYNC_RECORD_ID_BYTES)
    if (
      !SYNC_RECORD_KINDS.includes(index.recordKind) ||
      index.syncKey !== syncRecordKey(index.recordKind, index.recordId)
    ) {
      throw new Error('sync index record identity is invalid')
    }
    if (!/^[a-f0-9]{64}$/u.test(index.digest)) throw new Error('sync index digest is invalid')
    if (
      !Number.isSafeInteger(index.byteLength) ||
      index.byteLength < 1 ||
      index.byteLength > MAX_SYNC_CHUNK_BYTES ||
      !Number.isSafeInteger(index.chunkIndex) ||
      index.chunkIndex < 0
    ) {
      throw new Error('sync index location is invalid')
    }
    for (const field of [
      'idempotencyKey',
      'semanticKey',
      'logicalKey',
      'state',
      'episodeId',
      'entityId',
      'subjectId',
      'predicate',
      'targetKind',
      'targetId',
      'conclusionFactId',
      'scopeHash',
    ] as const) {
      if (index[field] !== undefined) assertString(index[field], `syncIndex.${field}`, 8_192)
    }
    if (
      index.version !== undefined &&
      (!Number.isSafeInteger(index.version) || index.version < 1)
    ) {
      throw new Error('sync index version is invalid')
    }
    for (const field of [
      'premiseFactIds',
      'premiseEvidenceIds',
      'identifierFingerprints',
    ] as const) {
      const values = index[field]
      if (values === undefined) continue
      if (!Array.isArray(values)) throw new Error(`sync index ${field} is invalid`)
      for (const value of values) assertString(value, `syncIndex.${field}`, 8_192)
    }
  } catch (error) {
    throw new MemoryError('integrity_failed', 'sync random-access index is malformed', {
      cause: error,
    })
  }
}

/** Validates one durable random-access index and its derived identity. */
export async function validateStoredSyncIndexRecord(
  index: StoredSyncIndex,
  expected: { spaceId: string; ownerId?: string; syncKey?: string },
): Promise<void> {
  assertStoredSyncIndexShape(index)
  if (
    index.spaceId !== expected.spaceId ||
    (expected.ownerId !== undefined && index.ownerId !== expected.ownerId) ||
    (expected.syncKey !== undefined && index.syncKey !== expected.syncKey) ||
    index.id !== (await syncIndexId(index.ownerId, index.syncKey))
  ) {
    throw new MemoryError('integrity_failed', 'sync random-access index identity is inconsistent')
  }
}

function stringArray(value: JsonValue | undefined): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? (value as readonly string[])
    : undefined
}

function nestedString(
  value: Readonly<Record<string, JsonValue>>,
  field: string,
  nested: string,
): string | undefined {
  const parent = value[field]
  if (parent === null || typeof parent !== 'object' || Array.isArray(parent)) return undefined
  const candidate = (parent as Readonly<Record<string, JsonValue>>)[nested]
  return typeof candidate === 'string' ? candidate : undefined
}

export async function storedSyncIndex(
  spaceId: string,
  ownerId: string,
  chunkIndex: number,
  record: SyncRecord,
): Promise<StoredSyncIndex> {
  const value = record.value
  const premises = Array.isArray(value.premises) ? value.premises : []
  const premiseFactIds = premises.flatMap((premise) => {
    if (premise === null || typeof premise !== 'object' || Array.isArray(premise)) return []
    return premise.kind === 'fact' && typeof premise.id === 'string' ? [premise.id] : []
  })
  const premiseEvidenceIds = premises.flatMap((premise) => {
    if (premise === null || typeof premise !== 'object' || Array.isArray(premise)) return []
    return premise.kind === 'evidence' && typeof premise.id === 'string' ? [premise.id] : []
  })
  return {
    kindRecord: 'sync_index',
    id: await syncIndexId(ownerId, record.key),
    spaceId,
    ownerId,
    syncKey: record.key,
    recordKind: record.kind,
    recordId: record.id,
    digest: await syncRecordDigest(record),
    byteLength: syncRecordByteLength(record),
    chunkIndex,
    ...(typeof value.idempotencyKey === 'string' ? { idempotencyKey: value.idempotencyKey } : {}),
    ...(typeof value.semanticKey === 'string' ? { semanticKey: value.semanticKey } : {}),
    ...(typeof value.key === 'string' ? { logicalKey: value.key } : {}),
    ...(typeof value.version === 'number' ? { version: value.version } : {}),
    ...(typeof value.state === 'string' ? { state: value.state } : {}),
    ...(typeof value.episodeId === 'string' ? { episodeId: value.episodeId } : {}),
    ...(typeof value.entityId === 'string' ? { entityId: value.entityId } : {}),
    ...(typeof value.subjectId === 'string' ? { subjectId: value.subjectId } : {}),
    ...(typeof value.predicate === 'string' ? { predicate: value.predicate } : {}),
    ...(nestedString(value, 'target', 'kind') === undefined
      ? {}
      : { targetKind: nestedString(value, 'target', 'kind') }),
    ...(nestedString(value, 'target', 'id') === undefined
      ? {}
      : { targetId: nestedString(value, 'target', 'id') }),
    ...(typeof value.conclusionFactId === 'string'
      ? { conclusionFactId: value.conclusionFactId }
      : {}),
    ...(premiseFactIds.length === 0 ? {} : { premiseFactIds }),
    ...(premiseEvidenceIds.length === 0 ? {} : { premiseEvidenceIds }),
    ...(stringArray(value.identifierFingerprints) === undefined
      ? {}
      : { identifierFingerprints: stringArray(value.identifierFingerprints) }),
    ...(typeof value.scopeHash === 'string' ? { scopeHash: value.scopeHash } : {}),
  }
}

/** Requires an index to be the exact deterministic projection of its indexed record. */
export async function validateStoredSyncIndexMatchesRecord(
  index: StoredSyncIndex,
  record: SyncRecord,
  spaceId: string,
): Promise<void> {
  await validateStoredSyncIndexRecord(index, {
    spaceId,
    ownerId: index.ownerId,
    syncKey: record.key,
  })
  const expected = await storedSyncIndex(spaceId, index.ownerId, index.chunkIndex, record)
  if (
    stableStringify(index as unknown as JsonValue) !==
    stableStringify(expected as unknown as JsonValue)
  ) {
    throw new MemoryError('integrity_failed', 'sync random-access index does not match its record')
  }
}

/**
 * Validates the atomic durable pack produced for each sync chunk. Chunks and their complete,
 * deterministic random-access indexes must enter storage together; partial or index-only packs
 * are never valid facade writes.
 */
export async function validateStoredSyncMetadataPuts(
  spaceId: string,
  puts: readonly (StoredSyncChunk | StoredSyncIndex)[],
): Promise<void> {
  if (puts.length === 0) return
  const chunks = new Map<string, StoredSyncChunk>()
  const indexesByLocation = new Map<string, Map<string, StoredSyncIndex>>()
  const indexIds = new Set<string>()
  const locationKey = (ownerId: string, index: number) => stableStringify([ownerId, index])

  for (const record of puts) {
    if (record.kindRecord === 'sync_chunk') {
      await validateStoredSyncChunkRecord(record, { spaceId })
      const location = locationKey(record.ownerId, record.index)
      if (chunks.has(location)) {
        throw new MemoryError('integrity_failed', 'sync metadata commit contains a duplicate chunk')
      }
      chunks.set(location, record)
      continue
    }
    await validateStoredSyncIndexRecord(record, { spaceId })
    if (indexIds.has(record.id)) {
      throw new MemoryError('integrity_failed', 'sync metadata commit contains a duplicate index')
    }
    indexIds.add(record.id)
    const location = locationKey(record.ownerId, record.chunkIndex)
    const indexes = indexesByLocation.get(location) ?? new Map<string, StoredSyncIndex>()
    if (indexes.has(record.syncKey)) {
      throw new MemoryError('integrity_failed', 'sync metadata commit contains a duplicate key')
    }
    indexes.set(record.syncKey, record)
    indexesByLocation.set(location, indexes)
  }

  for (const [location, indexes] of indexesByLocation) {
    const chunk = chunks.get(location)
    if (chunk === undefined) {
      throw new MemoryError('integrity_failed', 'sync index was committed without its chunk')
    }
    const records = new Map(chunk.records.map((record) => [record.key, record]))
    if (indexes.size !== records.size) {
      throw new MemoryError('integrity_failed', 'sync chunk index set is incomplete')
    }
    for (const [key, index] of indexes) {
      const record = records.get(key)
      if (record === undefined) {
        throw new MemoryError('integrity_failed', 'sync index does not belong to its chunk')
      }
      await validateStoredSyncIndexMatchesRecord(index, record, spaceId)
    }
  }
  for (const [location, chunk] of chunks) {
    if ((indexesByLocation.get(location)?.size ?? 0) !== chunk.records.length) {
      throw new MemoryError('integrity_failed', 'sync chunk was committed without every index')
    }
  }
}

export function syncRecordScopes(record: SyncRecord): readonly string[] {
  const value = record.value
  if (Array.isArray(value.scopes) && value.scopes.every((item) => typeof item === 'string')) {
    return value.scopes as readonly string[]
  }
  if (
    Array.isArray(value.supportScopes) &&
    value.supportScopes.every((item) => typeof item === 'string')
  ) {
    return value.supportScopes as readonly string[]
  }
  return []
}

export async function purgeTargetDigest(kind: string, id: string): Promise<string> {
  return sha256(`${kind}\u0000${id}`)
}

export async function purgedEpisodeIdempotencyDigest(
  spaceId: string,
  idempotencyKey: string,
): Promise<string> {
  return sha256(stableStringify([PURGED_EPISODE_IDEMPOTENCY_HASH_DOMAIN, spaceId, idempotencyKey]))
}

export function purgeDigests(record: SyncRecord): {
  target: readonly string[]
  idempotency: readonly string[]
} {
  if (record.kind !== 'purge') return { target: [], idempotency: [] }
  const marker = record.value as unknown as StoredPurge
  return {
    target: Array.isArray(marker.completedTargets) ? marker.completedTargets : [],
    idempotency: Array.isArray(marker.idempotencyKeyHashes) ? marker.idempotencyKeyHashes : [],
  }
}
