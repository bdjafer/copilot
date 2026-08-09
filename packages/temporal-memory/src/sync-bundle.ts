import type {
  AccessContext,
  JsonValue,
  MemorySyncPeer,
  OpenSyncBundleOptions,
  ReadOptions,
  SyncBundleCheckpointFrame,
  SyncBundleChunkFrame,
  SyncBundleCommitFrame,
  SyncBundleReader,
  SyncCheckpoint,
  SyncChunk,
  SyncChunkPage,
  SyncChunksRequest,
  SyncReceiveLimits,
} from './types.ts'

import { MemoryError, normalizeStorageError } from './errors.ts'
import {
  appendSyncBundleCheckpointDigest,
  DEFAULT_SYNC_BUNDLE_CHECKPOINT_BYTES,
  DEFAULT_SYNC_BUNDLE_CHECKPOINTS,
  emptySyncBundleCheckpointDigest,
  MAX_SYNC_BUNDLE_CHECKPOINT_BYTES,
  MAX_SYNC_BUNDLE_CHECKPOINTS,
  SYNC_BUNDLE_MEDIA_TYPE,
  SYNC_BUNDLE_VERSION,
  syncBundleFrameByteLength,
} from './internal/sync-bundle.ts'
import {
  appendSyncRoot,
  emptySyncRoot,
  MAX_SYNC_CHECKPOINT_JSON_DEPTH,
  MAX_SYNC_CHECKPOINT_JSON_NODES,
  MAX_SYNC_CHECKPOINT_STRING_BYTES,
  MAX_SYNC_CHUNK_BYTES,
  MAX_SYNC_CHUNK_JSON_NODES,
  MAX_SYNC_RECORD_JSON_DEPTH,
  syncRecordScopes,
  validateSyncCheckpointId,
  validateSyncChunkEnvelope,
} from './internal/sync.ts'
import {
  assertAccess,
  assertNotAborted,
  assertString,
  cloneJson,
  compareUnicode,
  isVisible,
  normalizeScopes,
  sha256,
  snapshotJson,
  stableStringify,
  type JsonValidationLimits,
} from './internal/value.ts'

const DEFAULT_RECEIVE_BYTES = 512 * 1024 * 1024
const DEFAULT_RECEIVE_RECORDS = 1_000_000
const DEFAULT_RECEIVE_CHUNKS = 65_536
const DEFAULT_PAGE_BYTES = MAX_SYNC_CHUNK_BYTES
const MAX_PAGE_BYTES = 256 * 1024 * 1024
const SYNC_BUNDLE_FRAME_OVERHEAD_NODES = 16
const SYNC_BUNDLE_FRAME_OVERHEAD_BYTES = 4_096

interface NormalizedReceiveLimits {
  maxBytes: number
  maxRecords: number
  maxChunks: number
}

interface HeaderMetadata {
  index: number
  digest: string
  parents: readonly string[]
}

interface ChunkMetadata {
  digest: string
  byteLength: number
  firstKey: string
  lastKey: string
}

function exactFields(value: object, fields: readonly string[]): boolean {
  return (
    stableStringify(Object.keys(value).sort(compareUnicode)) ===
    stableStringify(fields as JsonValue)
  )
}

function snapshotBundleFrame(
  value: unknown,
  field: string,
  limits: JsonValidationLimits,
): JsonValue {
  try {
    return snapshotJson(value, field, limits).value
  } catch (error) {
    throw new MemoryError('import_invalid', `${field} is malformed`, { cause: error })
  }
}

function normalizeReceiveLimits(input: SyncReceiveLimits | undefined): NormalizedReceiveLimits {
  if (
    input !== undefined &&
    (typeof input !== 'object' || input === null || Array.isArray(input))
  ) {
    throw new MemoryError('invalid_input', 'receiveLimits must be an object')
  }
  const limits = {
    maxBytes: input?.maxBytes ?? DEFAULT_RECEIVE_BYTES,
    maxRecords: input?.maxRecords ?? DEFAULT_RECEIVE_RECORDS,
    maxChunks: input?.maxChunks ?? DEFAULT_RECEIVE_CHUNKS,
  }
  for (const [field, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new MemoryError(
        'invalid_input',
        `receiveLimits.${field} must be a positive safe integer`,
      )
    }
  }
  return limits
}

function readOptions(signal: AbortSignal | undefined): ReadOptions {
  return signal === undefined ? {} : { signal }
}

async function readStore<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (MemoryError.is(error)) throw error
    throw normalizeStorageError(error)
  }
}

function validateCommitFrame(value: unknown): SyncBundleCommitFrame {
  const snapshot = snapshotBundleFrame(value, 'sync bundle commit frame', {
    maxNodes: 32,
    maxDepth: 2,
    maxStringBytes: SYNC_BUNDLE_FRAME_OVERHEAD_BYTES,
  })
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    Array.isArray(snapshot) ||
    !exactFields(snapshot, [
      'bundleVersion',
      'checkpointByteLength',
      'checkpointCount',
      'checkpointDigest',
      'checkpointId',
      'chunkCount',
      'mediaType',
      'rootDigest',
      'type',
    ])
  ) {
    throw new MemoryError('import_invalid', 'sync bundle commit frame is malformed')
  }
  const commit = snapshot as unknown as SyncBundleCommitFrame
  if (
    commit.type !== 'commit' ||
    commit.mediaType !== SYNC_BUNDLE_MEDIA_TYPE ||
    commit.bundleVersion !== SYNC_BUNDLE_VERSION ||
    typeof commit.checkpointId !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(commit.checkpointId) ||
    !Number.isSafeInteger(commit.checkpointCount) ||
    commit.checkpointCount < 1 ||
    !Number.isSafeInteger(commit.checkpointByteLength) ||
    commit.checkpointByteLength < 1 ||
    typeof commit.checkpointDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(commit.checkpointDigest) ||
    !Number.isSafeInteger(commit.chunkCount) ||
    commit.chunkCount < 0 ||
    typeof commit.rootDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(commit.rootDigest)
  ) {
    throw new MemoryError('import_invalid', 'sync bundle commit frame is malformed')
  }
  return commit
}

async function validateCheckpointFrame(
  value: unknown,
  expectedIndex: number,
): Promise<SyncBundleCheckpointFrame> {
  const snapshot = snapshotBundleFrame(value, 'sync bundle checkpoint frame', {
    maxNodes: MAX_SYNC_CHECKPOINT_JSON_NODES + SYNC_BUNDLE_FRAME_OVERHEAD_NODES,
    maxDepth: MAX_SYNC_CHECKPOINT_JSON_DEPTH + 1,
    maxStringBytes: MAX_SYNC_CHECKPOINT_STRING_BYTES + SYNC_BUNDLE_FRAME_OVERHEAD_BYTES,
  })
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    Array.isArray(snapshot) ||
    !exactFields(snapshot, ['checkpoint', 'index', 'type'])
  ) {
    throw new MemoryError('import_invalid', 'sync bundle checkpoint frame is malformed')
  }
  const frame = snapshot as unknown as SyncBundleCheckpointFrame
  if (frame.type !== 'checkpoint' || frame.index !== expectedIndex) {
    throw new MemoryError('import_invalid', 'sync bundle checkpoint indexes are not contiguous')
  }
  await validateSyncCheckpointId(frame.checkpoint)
  return frame
}

async function validateChunkFrame(
  value: unknown,
  checkpoint: SyncCheckpoint,
  expectedIndex: number,
  previousKey?: string,
): Promise<{ frame: SyncBundleChunkFrame; metadata: ChunkMetadata }> {
  const snapshot = snapshotBundleFrame(value, 'sync bundle chunk frame', {
    maxNodes: MAX_SYNC_CHUNK_JSON_NODES + SYNC_BUNDLE_FRAME_OVERHEAD_NODES,
    maxDepth: MAX_SYNC_RECORD_JSON_DEPTH + 4,
    maxStringBytes: MAX_SYNC_CHUNK_BYTES + SYNC_BUNDLE_FRAME_OVERHEAD_BYTES,
  })
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    Array.isArray(snapshot) ||
    !exactFields(snapshot, ['chunk', 'type'])
  ) {
    throw new MemoryError('import_invalid', 'sync bundle chunk frame is malformed')
  }
  const frame = snapshot as unknown as SyncBundleChunkFrame
  if (frame.type !== 'chunk') {
    throw new MemoryError('import_invalid', 'sync bundle chunk frame is malformed')
  }
  const bounds = await validateSyncChunkEnvelope(
    checkpoint,
    frame.chunk,
    expectedIndex,
    previousKey,
  )
  return {
    frame,
    metadata: {
      digest: frame.chunk.digest,
      byteLength: frame.chunk.byteLength,
      ...bounds,
    },
  }
}

function assertCheckpointAccess(checkpoint: SyncCheckpoint, access: AccessContext): void {
  assertAccess(access)
  if (!isVisible(checkpoint.scopes, access)) {
    throw new MemoryError('scope_denied', 'checkpoint includes inaccessible scopes')
  }
}

class VerifiedSyncBundlePeer implements MemorySyncPeer {
  readonly #reader: SyncBundleReader
  readonly #commit: SyncBundleCommitFrame
  readonly #target: SyncCheckpoint
  readonly #headers: ReadonlyMap<string, HeaderMetadata>
  readonly #chunks: readonly ChunkMetadata[]

  constructor(input: {
    reader: SyncBundleReader
    commit: SyncBundleCommitFrame
    target: SyncCheckpoint
    headers: ReadonlyMap<string, HeaderMetadata>
    chunks: readonly ChunkMetadata[]
  }) {
    this.#reader = input.reader
    this.#commit = cloneJson(input.commit as unknown as JsonValue) as SyncBundleCommitFrame
    this.#target = cloneJson(input.target as unknown as JsonValue) as unknown as SyncCheckpoint
    this.#headers = input.headers
    this.#chunks = input.chunks
  }

  async #assertCommitStable(signal?: AbortSignal): Promise<void> {
    assertNotAborted(signal)
    const current = validateCommitFrame(
      await readStore(() => this.#reader.readCommit(readOptions(signal))),
    )
    if (
      stableStringify(current as unknown as JsonValue) !==
      stableStringify(this.#commit as unknown as JsonValue)
    ) {
      throw new MemoryError('integrity_failed', 'sync bundle commit changed after verification')
    }
  }

  async #checkpoint(id: string, signal?: AbortSignal): Promise<SyncCheckpoint | null> {
    const metadata = this.#headers.get(id)
    if (metadata === undefined) return null
    const frame = await validateCheckpointFrame(
      await readStore(() => this.#reader.readCheckpoint(metadata.index, readOptions(signal))),
      metadata.index,
    )
    const digest = await sha256(stableStringify(frame.checkpoint as unknown as JsonValue))
    if (frame.checkpoint.id !== id || digest !== metadata.digest) {
      throw new MemoryError('integrity_failed', 'sync bundle checkpoint changed after verification')
    }
    return cloneJson(frame.checkpoint as unknown as JsonValue) as unknown as SyncCheckpoint
  }

  async syncHead(access: AccessContext, options: ReadOptions = {}): Promise<SyncCheckpoint> {
    await this.#assertCommitStable(options.signal)
    const checkpoint = await this.#checkpoint(this.#target.id, options.signal)
    if (checkpoint === null) {
      throw new MemoryError('integrity_failed', 'sync bundle target checkpoint disappeared')
    }
    assertCheckpointAccess(checkpoint, access)
    await this.#assertCommitStable(options.signal)
    return checkpoint
  }

  async syncCheckpoint(
    id: string,
    access: AccessContext,
    options: ReadOptions = {},
  ): Promise<SyncCheckpoint | null> {
    assertString(id, 'checkpointId', 128)
    await this.#assertCommitStable(options.signal)
    const checkpoint = await this.#checkpoint(id, options.signal)
    if (checkpoint !== null) assertCheckpointAccess(checkpoint, access)
    await this.#assertCommitStable(options.signal)
    return checkpoint
  }

  async syncChunks(request: SyncChunksRequest, options: ReadOptions = {}): Promise<SyncChunkPage> {
    if (typeof request !== 'object' || request === null) {
      throw new MemoryError('invalid_input', 'sync chunk request is required')
    }
    assertAccess(request.access)
    assertString(request.checkpointId, 'checkpointId', 128)
    assertNotAborted(options.signal)
    const startIndex = request.startIndex ?? 0
    const limit = request.limit ?? 1
    const maxBytes = request.maxBytes ?? DEFAULT_PAGE_BYTES
    if (!Number.isSafeInteger(startIndex) || startIndex < 0) {
      throw new MemoryError('invalid_input', 'startIndex must be a non-negative integer')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
      throw new MemoryError('invalid_input', 'sync chunk limit must be between 1 and 64')
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PAGE_BYTES) {
      throw new MemoryError('invalid_input', `maxBytes must be between 1 and ${MAX_PAGE_BYTES}`)
    }
    if (request.checkpointId !== this.#target.id) {
      throw new MemoryError('not_found', 'sync bundle contains no payload for this checkpoint')
    }
    if (startIndex > this.#target.chunkCount) {
      throw new MemoryError('invalid_input', 'startIndex exceeds the checkpoint chunk count')
    }
    await this.#assertCommitStable(options.signal)
    const checkpoint = await this.#checkpoint(this.#target.id, options.signal)
    if (checkpoint === null) {
      throw new MemoryError('integrity_failed', 'sync bundle target checkpoint disappeared')
    }
    assertCheckpointAccess(checkpoint, request.access)
    if (checkpoint.chunkCount === 0 || startIndex === checkpoint.chunkCount) {
      await this.#assertCommitStable(options.signal)
      return { checkpoint, chunks: [] }
    }
    const chunks: SyncChunk[] = []
    let aggregateBytes = 0
    for (
      let index = startIndex;
      index < checkpoint.chunkCount && chunks.length < limit;
      index += 1
    ) {
      const expected = this.#chunks[index]!
      if (chunks.length > 0 && aggregateBytes + expected.byteLength > maxBytes) break
      if (chunks.length === 0 && expected.byteLength > maxBytes) {
        throw new MemoryError('result_too_large', 'the next sync chunk exceeds maxBytes', {
          details: { requiredBytes: expected.byteLength, chunkIndex: index },
        })
      }
      const previousKey = index === 0 ? undefined : this.#chunks[index - 1]!.lastKey
      const { frame, metadata } = await validateChunkFrame(
        await readStore(() => this.#reader.readChunk(index, readOptions(options.signal))),
        checkpoint,
        index,
        previousKey,
      )
      if (
        stableStringify(metadata as unknown as JsonValue) !==
        stableStringify(expected as unknown as JsonValue)
      ) {
        throw new MemoryError('integrity_failed', 'sync bundle chunk changed after verification')
      }
      chunks.push(cloneJson(frame.chunk as unknown as JsonValue) as unknown as SyncChunk)
      aggregateBytes += frame.chunk.byteLength
      assertNotAborted(options.signal)
    }
    const nextIndex = startIndex + chunks.length
    await this.#assertCommitStable(options.signal)
    return {
      checkpoint,
      chunks,
      ...(nextIndex < checkpoint.chunkCount ? { nextIndex } : {}),
    }
  }
}

/**
 * Verifies a completed durable bundle with bounded, one-chunk-at-a-time reads and exposes the
 * ordinary reconciliation peer. The reader remains authoritative and must stay available while
 * `syncFrom` runs or resumes.
 */
export async function openSyncBundle(
  reader: SyncBundleReader,
  options: OpenSyncBundleOptions = {},
): Promise<MemorySyncPeer> {
  if (
    typeof reader !== 'object' ||
    reader === null ||
    typeof reader.readCommit !== 'function' ||
    typeof reader.readCheckpoint !== 'function' ||
    typeof reader.readChunk !== 'function'
  ) {
    throw new MemoryError('invalid_input', 'reader must implement SyncBundleReader')
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw new MemoryError('invalid_input', 'sync bundle options must be an object')
  }
  let maxCheckpointsInput: unknown
  let maxCheckpointBytesInput: unknown
  let receiveLimitsInput: SyncReceiveLimits | undefined
  let signal: AbortSignal | undefined
  try {
    maxCheckpointsInput = Reflect.get(options, 'maxCheckpoints')
    maxCheckpointBytesInput = Reflect.get(options, 'maxCheckpointBytes')
    receiveLimitsInput = Reflect.get(options, 'receiveLimits') as SyncReceiveLimits | undefined
    signal = Reflect.get(options, 'signal') as AbortSignal | undefined
  } catch (error) {
    throw new MemoryError('invalid_input', 'sync bundle options could not be snapshotted', {
      cause: error,
    })
  }
  const maxCheckpoints = maxCheckpointsInput ?? DEFAULT_SYNC_BUNDLE_CHECKPOINTS
  if (
    typeof maxCheckpoints !== 'number' ||
    !Number.isSafeInteger(maxCheckpoints) ||
    maxCheckpoints < 1 ||
    maxCheckpoints > MAX_SYNC_BUNDLE_CHECKPOINTS
  ) {
    throw new MemoryError(
      'invalid_input',
      `maxCheckpoints must be between 1 and ${MAX_SYNC_BUNDLE_CHECKPOINTS}`,
    )
  }
  const maxCheckpointBytes = maxCheckpointBytesInput ?? DEFAULT_SYNC_BUNDLE_CHECKPOINT_BYTES
  if (
    typeof maxCheckpointBytes !== 'number' ||
    !Number.isSafeInteger(maxCheckpointBytes) ||
    maxCheckpointBytes < 1 ||
    maxCheckpointBytes > MAX_SYNC_BUNDLE_CHECKPOINT_BYTES
  ) {
    throw new MemoryError(
      'invalid_input',
      `maxCheckpointBytes must be between 1 and ${MAX_SYNC_BUNDLE_CHECKPOINT_BYTES}`,
    )
  }
  const limits = normalizeReceiveLimits(receiveLimitsInput)
  assertNotAborted(signal)
  const commit = validateCommitFrame(await readStore(() => reader.readCommit(readOptions(signal))))
  if (
    commit.checkpointCount > maxCheckpoints ||
    commit.checkpointByteLength > maxCheckpointBytes ||
    commit.chunkCount > limits.maxChunks
  ) {
    throw new MemoryError('result_too_large', 'sync bundle exceeds verification limits', {
      details: {
        checkpointCount: commit.checkpointCount,
        checkpointByteLength: commit.checkpointByteLength,
        chunkCount: commit.chunkCount,
      },
    })
  }

  const headers = new Map<string, HeaderMetadata>()
  let target: SyncCheckpoint | undefined
  let spaceId: string | undefined
  let ontologyDigest: string | undefined
  let checkpointByteLength = 0
  let checkpointDigest: string | undefined
  for (let index = 0; index < commit.checkpointCount; index += 1) {
    assertNotAborted(signal)
    const frame = await validateCheckpointFrame(
      await readStore(() => reader.readCheckpoint(index, readOptions(signal))),
      index,
    )
    spaceId ??= frame.checkpoint.spaceId
    ontologyDigest ??= frame.checkpoint.ontologyDigest
    if (
      frame.checkpoint.spaceId !== spaceId ||
      frame.checkpoint.ontologyDigest !== ontologyDigest
    ) {
      throw new MemoryError('import_invalid', 'sync bundle checkpoint identity changes')
    }
    if (headers.has(frame.checkpoint.id)) {
      throw new MemoryError('import_invalid', 'sync bundle contains a duplicate checkpoint')
    }
    checkpointDigest ??= await emptySyncBundleCheckpointDigest(spaceId, commit.checkpointId)
    checkpointDigest = await appendSyncBundleCheckpointDigest(
      checkpointDigest,
      index,
      frame.checkpoint,
    )
    checkpointByteLength += syncBundleFrameByteLength(frame)
    if (checkpointByteLength > commit.checkpointByteLength) {
      throw new MemoryError('import_invalid', 'sync bundle checkpoint byte commitment is too small')
    }
    if (checkpointByteLength > maxCheckpointBytes) {
      throw new MemoryError('result_too_large', 'sync bundle checkpoint headers exceed limit')
    }
    headers.set(frame.checkpoint.id, {
      index,
      digest: await sha256(stableStringify(frame.checkpoint as unknown as JsonValue)),
      parents: [...frame.checkpoint.parents],
    })
    if (frame.checkpoint.id === commit.checkpointId) target = frame.checkpoint
  }
  if (
    (await readStore(() => reader.readCheckpoint(commit.checkpointCount, readOptions(signal)))) !==
    null
  ) {
    throw new MemoryError('import_invalid', 'sync bundle contains uncommitted checkpoint frames')
  }
  if (
    checkpointDigest !== commit.checkpointDigest ||
    checkpointByteLength !== commit.checkpointByteLength ||
    target === undefined
  ) {
    throw new MemoryError('import_invalid', 'sync bundle checkpoint commitment does not match')
  }
  if (target.rootDigest !== commit.rootDigest || target.chunkCount !== commit.chunkCount) {
    throw new MemoryError('import_invalid', 'sync bundle target manifest does not match commit')
  }
  if (
    target.byteLength > limits.maxBytes ||
    target.recordCount > limits.maxRecords ||
    target.chunkCount > limits.maxChunks
  ) {
    throw new MemoryError('result_too_large', 'sync bundle target exceeds receive limits', {
      details: {
        byteLength: target.byteLength,
        recordCount: target.recordCount,
        chunkCount: target.chunkCount,
      },
    })
  }

  const pending = [target.id]
  const seen = new Set<string>()
  for (let position = 0; position < pending.length; position += 1) {
    assertNotAborted(signal)
    const id = pending[position]!
    if (seen.has(id)) continue
    const metadata = headers.get(id)
    if (metadata === undefined) {
      throw new MemoryError('import_invalid', 'sync bundle target ancestry is incomplete')
    }
    seen.add(id)
    pending.push(...metadata.parents)
  }

  const chunks: ChunkMetadata[] = []
  let root = await emptySyncRoot()
  let recordCount = 0
  let byteLength = 0
  let previousKey: string | undefined
  const scopes = new Set<string>()
  for (let index = 0; index < target.chunkCount; index += 1) {
    assertNotAborted(signal)
    const validated = await validateChunkFrame(
      await readStore(() => reader.readChunk(index, readOptions(signal))),
      target,
      index,
      previousKey,
    )
    chunks.push(validated.metadata)
    previousKey = validated.metadata.lastKey
    root = await appendSyncRoot(root, validated.frame.chunk)
    recordCount += validated.frame.chunk.records.length
    byteLength += validated.frame.chunk.byteLength
    if (recordCount > target.recordCount || byteLength > target.byteLength) {
      throw new MemoryError('import_invalid', 'sync bundle chunks exceed their target manifest')
    }
    for (const record of validated.frame.chunk.records) {
      for (const scope of syncRecordScopes(record)) scopes.add(scope)
    }
  }
  if ((await readStore(() => reader.readChunk(target.chunkCount, readOptions(signal)))) !== null) {
    throw new MemoryError('import_invalid', 'sync bundle contains uncommitted chunk frames')
  }
  if (
    root !== target.rootDigest ||
    recordCount !== target.recordCount ||
    byteLength !== target.byteLength ||
    stableStringify(normalizeScopes([...scopes])) !== stableStringify(target.scopes)
  ) {
    throw new MemoryError('import_invalid', 'sync bundle target payload does not match manifest')
  }
  const finalCommit = validateCommitFrame(
    await readStore(() => reader.readCommit(readOptions(signal))),
  )
  if (
    stableStringify(finalCommit as unknown as JsonValue) !==
    stableStringify(commit as unknown as JsonValue)
  ) {
    throw new MemoryError('conflict', 'sync bundle changed during verification', {
      retryable: true,
    })
  }
  return new VerifiedSyncBundlePeer({ reader, commit, target, headers, chunks })
}
