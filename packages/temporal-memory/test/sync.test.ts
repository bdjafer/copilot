import { describe, expect, it, vi } from 'vitest'

import {
  createMemory,
  MemoryError,
  openSyncBundle,
  type JsonValue,
  type Memory,
  type MemorySyncPeer,
  type SyncBundleCheckpointFrame,
  type SyncBundleChunkFrame,
  type SyncBundleCommitFrame,
  type SyncBundleFrame,
  type SyncBundleReader,
} from '../src/index.ts'
import { storedSyncIndex, validateStoredSyncMetadataPuts } from '../src/internal/sync.ts'
import { stableStringify } from '../src/internal/value.ts'
import {
  storageDriver,
  type StorageCommit,
  type StorageDriver,
  type StoredOperation,
  type StoredRecord,
  type StoredSyncRef,
  type StoredSyncSession,
} from '../src/storage/driver.ts'
import { createInMemoryStorage } from '../src/testing/index.ts'
import { OPEN_ONTOLOGY, WORK_ONTOLOGY } from './support.ts'

const access = { allowedScopes: [] as string[] }

function replica(
  name: string,
  ontology = OPEN_ONTOLOGY,
  storage = createInMemoryStorage({ name }),
): Memory {
  let next = 0
  return createMemory({
    spaceId: 'sync-space',
    storage,
    ontology,
    now: () => new Date('2026-08-03T10:00:00.000Z'),
    createId: () => `${name}-${++next}`,
  })
}

async function remember(memory: Memory, episodeId: string, entityId: string): Promise<void> {
  await memory.remember({
    id: episodeId,
    idempotencyKey: episodeId,
    kind: 'assertion',
    content: { type: 'text', text: `${entityId} is active.` },
    source: { kind: 'fixture' },
    assertions: { entities: [{ id: entityId, name: entityId }] },
  })
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function encodeTestCursor(value: object): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function decodeTestCursor(value: string): Record<string, unknown> {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('test cursor is not an object')
  }
  return parsed as Record<string, unknown>
}

function bundleReader(frames: readonly SyncBundleFrame[]): SyncBundleReader {
  return {
    readCommit: async () => frames.find((frame) => frame.type === 'commit') ?? null,
    readCheckpoint: async (index) =>
      frames.find(
        (frame): frame is SyncBundleCheckpointFrame =>
          frame.type === 'checkpoint' && frame.index === index,
      ) ?? null,
    readChunk: async (index) =>
      frames.find(
        (frame): frame is SyncBundleChunkFrame =>
          frame.type === 'chunk' && frame.chunk.index === index,
      ) ?? null,
  }
}

function failOnSecondPropertyRead<T extends object, K extends keyof T>(value: T, key: K): T {
  const copy = structuredClone(value)
  const property = copy[key]
  let read = false
  Object.defineProperty(copy, key, {
    enumerable: true,
    configurable: true,
    get: () => {
      if (read) throw new Error(`bundle frame property ${String(key)} was read twice`)
      read = true
      return property
    },
  })
  return copy
}

function singleReadBundleReader(frames: readonly SyncBundleFrame[]): SyncBundleReader {
  const reader = bundleReader(frames)
  return {
    readCommit: async (options) => {
      const frame = await reader.readCommit(options)
      return frame === null ? null : failOnSecondPropertyRead(frame, 'checkpointId')
    },
    readCheckpoint: async (index, options) => {
      const frame = await reader.readCheckpoint(index, options)
      return frame === null ? null : failOnSecondPropertyRead(frame, 'checkpoint')
    },
    readChunk: async (index, options) => {
      const frame = await reader.readChunk(index, options)
      return frame === null ? null : failOnSecondPropertyRead(frame, 'chunk')
    },
  }
}

describe('whole-memory synchronization', () => {
  it('rejects a separate operationId on session-owned resolve and abort continuations', async () => {
    const memory = replica('continuation-options')
    await memory.open({ create: true })
    const invalidOptions = { operationId: 'silently-ignored-operation' } as never

    await expect(
      memory.resolveSync(
        {
          sessionId: 'missing-session',
          access,
          confirmSpaceId: 'sync-space',
          resolutions: [{ key: 'episode:missing', choice: 'local' }],
        },
        invalidOptions,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      memory.abortSync(
        { sessionId: 'missing-session', access, confirmSpaceId: 'sync-space' },
        invalidOptions,
      ),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('owns the closed sync control plane before queueing, storage, or peer work', async () => {
    const storage = createInMemoryStorage({ name: 'closed-sync-requests' })
    const source = replica('closed-sync-source', OPEN_ONTOLOGY, storage)
    await source.open({ create: true })
    await remember(source, 'closed-sync-episode-1', 'closed-sync-entity-1')

    const checkpointRequest = {
      access: { allowedScopes: [] as string[] },
      confirmSpaceId: 'sync-space',
      maxChunkBytes: 64 * 1_024,
    }
    const checkpointOptions = { operationId: 'closed-sync-checkpoint-1' }
    const checkpointPromise = source.createSyncCheckpoint(checkpointRequest, checkpointOptions)
    checkpointRequest.access.allowedScopes.push('mutated-scope')
    checkpointRequest.confirmSpaceId = 'mutated-space'
    checkpointRequest.maxChunkBytes = 1
    checkpointOptions.operationId = 'mutated-checkpoint-operation'
    const firstCheckpoint = await checkpointPromise
    expect(firstCheckpoint).toMatchObject({ protocolVersion: 1, spaceId: 'sync-space' })

    const chunksRequest = {
      access: { allowedScopes: [] as string[] },
      checkpointId: firstCheckpoint.id,
      startIndex: 0,
      limit: 1,
      maxBytes: 16 * 1_024 * 1_024,
    }
    const chunksPromise = source.syncChunks(chunksRequest)
    chunksRequest.access.allowedScopes.push('mutated-scope')
    chunksRequest.checkpointId = '0'.repeat(64)
    chunksRequest.startIndex = 1_000_000
    chunksRequest.limit = 0
    expect((await chunksPromise).checkpoint.id).toBe(firstCheckpoint.id)

    const historyRequest = {
      access: { allowedScopes: [] as string[] },
      before: '2026-08-03T11:00:00.000Z',
      limit: 100,
    }
    const historyPromise = source.syncHistory(historyRequest)
    historyRequest.access.allowedScopes.push('mutated-scope')
    historyRequest.before = 'not-an-instant'
    historyRequest.limit = 0
    expect(
      (await historyPromise).checkpoints.some((item) => item.checkpoint.id === firstCheckpoint.id),
    ).toBe(true)

    const bundleRequest = {
      access: { allowedScopes: [] as string[] },
      confirmSpaceId: 'sync-space',
      checkpointId: firstCheckpoint.id,
      maxCheckpoints: 100,
      maxCheckpointBytes: 16 * 1_024 * 1_024,
      limit: 1,
      maxBytes: 16 * 1_024 * 1_024,
    }
    const bundlePromise = source.exportSyncBundle(bundleRequest)
    bundleRequest.access.allowedScopes.push('mutated-scope')
    bundleRequest.confirmSpaceId = 'mutated-space'
    bundleRequest.checkpointId = '0'.repeat(64)
    bundleRequest.maxCheckpoints = 0
    expect((await bundlePromise).checkpoint.id).toBe(firstCheckpoint.id)

    await remember(source, 'closed-sync-episode-2', 'closed-sync-entity-2')
    const currentHead = await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space', maxChunkBytes: 64 * 1_024 },
      { operationId: 'closed-sync-checkpoint-2' },
    )
    const sourceRevision = (await source.stats()).snapshotRevision
    const compactionRequest = {
      access: { allowedScopes: [] as string[] },
      confirmSpaceId: 'sync-space',
      expectedRevision: sourceRevision,
      expectedHead: currentHead.id,
      before: '2026-08-03T11:00:00.000Z',
      maxCheckpoints: 64,
      dryRun: true,
    }
    const compactionPromise = source.compactSyncHistory(compactionRequest)
    compactionRequest.access.allowedScopes.push('mutated-scope')
    compactionRequest.confirmSpaceId = 'mutated-space'
    compactionRequest.expectedRevision += 1
    compactionRequest.maxCheckpoints = 0
    expect((await compactionPromise).selected.map((item) => item.checkpointId)).toContain(
      firstCheckpoint.id,
    )

    const target = replica('closed-sync-target')
    await target.open({ create: true })
    const pullRequest = {
      access: { allowedScopes: [] as string[] },
      confirmSpaceId: 'sync-space',
      strategy: 'fast-forward-only' as const,
      maxAncestry: 10_000,
      receiveLimits: { maxBytes: 64 * 1_024 * 1_024, maxRecords: 10_000, maxChunks: 1_000 },
    }
    const pullOptions = { operationId: 'closed-sync-pull' }
    const pullPromise = target.syncFrom(source, pullRequest, pullOptions)
    pullRequest.access.allowedScopes.push('mutated-scope')
    pullRequest.confirmSpaceId = 'mutated-space'
    pullRequest.maxAncestry = 0
    pullRequest.receiveLimits.maxRecords = 0
    pullOptions.operationId = 'mutated-sync-pull'
    const pull = await pullPromise
    expect(pull).toMatchObject({ state: 'succeeded', checkpoint: { id: currentHead.id } })
    expect(await target.operation('closed-sync-pull')).toMatchObject({
      id: 'closed-sync-pull',
      state: 'succeeded',
    })
    expect(await target.operation('mutated-sync-pull')).toBeNull()

    let accessReads = 0
    const singleReadAccess = {} as { allowedScopes: string[] }
    Object.defineProperty(singleReadAccess, 'allowedScopes', {
      enumerable: true,
      get: () => {
        accessReads += 1
        if (accessReads > 1) throw new Error('caller access was read more than once')
        return []
      },
    })
    const statusPromise = target.syncStatus(pull.sessionId, singleReadAccess)
    expect(accessReads).toBe(1)
    expect(await statusPromise).toMatchObject({ sessionId: pull.sessionId, state: 'succeeded' })

    const sessionsRequest = { access: { allowedScopes: [] as string[] }, limit: 100 }
    const sessionsPromise = target.syncSessions(sessionsRequest)
    sessionsRequest.access.allowedScopes.push('mutated-scope')
    sessionsRequest.limit = 0
    expect((await sessionsPromise).sessions.map((session) => session.sessionId)).toContain(
      pull.sessionId,
    )

    const targetRevision = (await target.stats()).snapshotRevision
    const targetHead = await target.syncHead(access)
    const sessionCompactionRequest = {
      access: { allowedScopes: [] as string[] },
      confirmSpaceId: 'sync-space',
      expectedRevision: targetRevision,
      expectedHead: targetHead.id,
      before: '2026-08-03T11:00:00.000Z',
      maxSessions: 64,
      dryRun: true,
    }
    const sessionCompactionPromise = target.compactSyncSessions(sessionCompactionRequest)
    sessionCompactionRequest.access.allowedScopes.push('mutated-scope')
    sessionCompactionRequest.confirmSpaceId = 'mutated-space'
    sessionCompactionRequest.maxSessions = 0
    expect((await sessionCompactionPromise).selected.map((session) => session.sessionId)).toContain(
      pull.sessionId,
    )

    const driver = storageDriver(storage)
    const storageCalls = [
      vi.spyOn(driver, 'getSpace'),
      vi.spyOn(driver, 'get'),
      vi.spyOn(driver, 'query'),
      vi.spyOn(driver, 'count'),
      vi.spyOn(driver, 'commit'),
      vi.spyOn(driver, 'exportRecords'),
    ]
    const unexpected = { unexpected: true }
    const invalidCalls: (() => Promise<unknown>)[] = [
      () =>
        source.createSyncCheckpoint({
          access,
          confirmSpaceId: 'sync-space',
          ...unexpected,
        } as never),
      () =>
        source.compactSyncHistory({
          access,
          confirmSpaceId: 'sync-space',
          expectedRevision: sourceRevision,
          expectedHead: currentHead.id,
          before: '2026-08-03T11:00:00.000Z',
          maxCheckpoints: 1,
          dryRun: true,
          ...unexpected,
        } as never),
      () => source.syncHistory({ access, ...unexpected } as never),
      () => source.syncHead({ allowedScopes: [], ...unexpected } as never),
      () => source.syncCheckpoint(currentHead.id, { allowedScopes: [], ...unexpected } as never),
      () => source.syncChunks({ access, checkpointId: currentHead.id, ...unexpected } as never),
      () =>
        source.exportSyncBundle({
          access,
          confirmSpaceId: 'sync-space',
          ...unexpected,
        } as never),
      () =>
        source.syncFrom(target, { access, confirmSpaceId: 'sync-space', ...unexpected } as never),
      () => source.syncStatus('missing-session', { allowedScopes: [], ...unexpected } as never),
      () => source.syncSessions({ access, ...unexpected } as never),
      () =>
        source.compactSyncSessions({
          access,
          confirmSpaceId: 'sync-space',
          expectedRevision: sourceRevision,
          expectedHead: currentHead.id,
          before: '2026-08-03T11:00:00.000Z',
          maxSessions: 1,
          dryRun: true,
          ...unexpected,
        } as never),
      () => source.syncConflicts({ sessionId: 'missing-session', access, ...unexpected } as never),
      () =>
        source.syncConflict({
          sessionId: 'missing-session',
          key: 'episode\u0000missing',
          access,
          ...unexpected,
        } as never),
      () =>
        source.resolveSync({
          sessionId: 'missing-session',
          access,
          confirmSpaceId: 'sync-space',
          resolutions: [{ key: 'episode\u0000missing', choice: 'local' }],
          ...unexpected,
        } as never),
      () =>
        source.abortSync({
          sessionId: 'missing-session',
          access,
          confirmSpaceId: 'sync-space',
          ...unexpected,
        } as never),
      () => source.syncHistory({ access }, { operationId: 'not-a-read-option' } as never),
      () =>
        source.createSyncCheckpoint({ access, confirmSpaceId: 'sync-space' }, {
          unexpected: true,
        } as never),
    ]
    for (const call of invalidCalls) {
      await expect(call()).rejects.toMatchObject({ code: 'invalid_input' })
    }
    for (const storageCall of storageCalls) expect(storageCall).not.toHaveBeenCalled()
  })

  it('streams a content-addressed checkpoint and fast-forwards a fresh replica', async () => {
    const source = replica('source')
    const target = replica('target')
    await source.open({ create: true })
    await target.open({ create: true })
    await remember(source, 'episode-1', 'entity-1')
    const longEpisodeId = 'e'.repeat(256)
    await source.remember({
      id: longEpisodeId,
      kind: 'text',
      content: { type: 'text', text: 'Maximum-length public id.' },
      source: { kind: 'fixture' },
    })

    const checkpoint = await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space', maxChunkBytes: 64 * 1024 },
      { operationId: 'checkpoint-1' },
    )
    expect(checkpoint).toMatchObject({ protocolVersion: 1, parents: [expect.any(String)] })
    const firstPage = await source.syncChunks({
      access,
      checkpointId: checkpoint.id,
      startIndex: 0,
      limit: 1,
    })
    expect(firstPage.chunks).toHaveLength(1)

    const report = await target.syncFrom(
      source,
      { access, confirmSpaceId: 'sync-space', strategy: 'merge' },
      { operationId: 'pull-1' },
    )

    expect(report).toMatchObject({ state: 'succeeded', remoteHead: checkpoint.id, conflicts: 0 })
    expect(await target.stats()).toMatchObject({ episodes: 2, entities: 1 })
    await expect(target.getEpisode('episode-1', access)).resolves.toMatchObject({
      id: 'episode-1',
    })
    await expect(target.getEpisode(longEpisodeId, access)).resolves.toMatchObject({
      id: longEpisodeId,
    })
    expect((await target.syncHead(access)).id).toBe(checkpoint.id)
  })

  it('retains complete remote ancestry as immutable headers for later DAG operations', async () => {
    const source = replica('ancestry-source')
    const target = replica('ancestry-target')
    await source.open({ create: true })
    await target.open({ create: true })
    await remember(source, 'ancestry-base-episode', 'ancestry-base-entity')
    const base = await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'ancestry-base-checkpoint' },
    )
    await remember(source, 'ancestry-head-episode', 'ancestry-head-entity')
    const head = await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'ancestry-head-checkpoint' },
    )

    await target.syncFrom(source, {
      access,
      confirmSpaceId: 'sync-space',
      strategy: 'fast-forward-only',
      sessionId: 'ancestry-pull',
    })

    await expect(target.syncCheckpoint(base.id, access)).resolves.toEqual(base)
    await expect(target.syncChunks({ access, checkpointId: base.id })).rejects.toMatchObject({
      code: 'not_found',
      details: { checkpointId: base.id, requiresReseed: true },
    })
    const bundle = await target.exportSyncBundle({
      access,
      confirmSpaceId: 'sync-space',
      checkpointId: head.id,
      limit: 64,
    })
    expect(
      bundle.frames
        .filter((frame): frame is SyncBundleCheckpointFrame => frame.type === 'checkpoint')
        .map((frame) => frame.checkpoint.id),
    ).toEqual(expect.arrayContaining([base.id, head.id]))
    expect(await target.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })
  })

  it('fails closed on malformed retained checkpoint and HEAD metadata', async () => {
    const storage = createInMemoryStorage({ name: 'checkpoint-metadata-integrity' })
    const memory = replica('checkpoint-metadata', OPEN_ONTOLOGY, storage)
    await memory.open({ create: true })
    await remember(memory, 'checkpoint-metadata-episode', 'checkpoint-metadata-entity')
    const head = await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'checkpoint-metadata-head' },
    )
    const driver = storageDriver(storage)
    const checkpoint = await driver.get('sync_checkpoint', 'sync-space', head.id)
    const ref = await driver.get('sync_ref', 'sync-space', 'head')
    const space = await driver.getSpace('sync-space')
    if (checkpoint === null || ref === null || space === null) {
      throw new Error('checkpoint metadata fixture is missing')
    }

    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: space.revision,
      metadataOnly: true,
      puts: [{ ...checkpoint, sourceRevision: space.revision + 1 }],
    })
    await expect(memory.syncCheckpoint(head.id, access)).rejects.toSatisfy((error: unknown) =>
      MemoryError.is(error, 'integrity_failed'),
    )
    expect(await memory.verifyIntegrity()).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_sync_checkpoint' }),
        expect.objectContaining({ code: 'invalid_sync_ref' }),
      ]),
    })

    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: space.revision,
      metadataOnly: true,
      puts: [checkpoint],
    })
    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: space.revision,
      metadataOnly: true,
      puts: [{ ...checkpoint, chunkOwnerId: 'forged-checkpoint-owner' }],
    })
    await expect(memory.syncChunks({ access, checkpointId: head.id })).rejects.toSatisfy(
      (error: unknown) => MemoryError.is(error, 'integrity_failed'),
    )
    expect(await memory.verifyIntegrity()).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_sync_checkpoint_payload' }),
      ]),
    })

    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: space.revision,
      metadataOnly: true,
      puts: [checkpoint, { ...ref, updatedAt: 'not-an-instant' }],
    })
    await expect(memory.syncHead(access)).rejects.toSatisfy((error: unknown) =>
      MemoryError.is(error, 'integrity_failed'),
    )
    expect(await memory.verifyIntegrity()).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'invalid_sync_ref' })],
    })

    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: space.revision,
      metadataOnly: true,
      puts: [ref],
    })
    expect(await memory.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })
  })

  it('retries integrity verification across a concurrent metadata-only commit', async () => {
    const storage = createInMemoryStorage({ name: 'coherent-metadata-integrity' })
    const memory = replica('coherent-metadata', OPEN_ONTOLOGY, storage)
    await memory.open({ create: true })
    await remember(memory, 'coherent-metadata-episode', 'coherent-metadata-entity')
    await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'coherent-metadata-head' },
    )
    const driver = storageDriver(storage)
    const originalQuery = driver.query.bind(driver)
    const before = await driver.getSpace('sync-space')
    const ref = await driver.get('sync_ref', 'sync-space', 'head')
    if (before === null || ref === null) throw new Error('metadata coherence fixture is missing')
    let injected = false
    const query = vi.spyOn(driver, 'query')
    query.mockImplementation((async (request) => {
      const records = await originalQuery(request)
      if (!injected && request.kind === 'episode') {
        injected = true
        await driver.commit({
          spaceId: 'sync-space',
          expectedRevision: before.revision,
          metadataOnly: true,
          puts: [{ ...ref, updatedAt: '2026-08-03T10:00:01.000Z' }],
        })
      }
      return records
    }) as StorageDriver['query'])

    await expect(memory.verifyIntegrity()).rejects.toMatchObject({
      code: 'conflict',
      retryable: true,
    })
    query.mockRestore()
    const after = await driver.getSpace('sync-space')
    expect(after?.revision).toBe(before.revision)
    expect(after?.metadataRevision).toBeGreaterThan(before.metadataRevision ?? 0)
    expect(await memory.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })
  })

  it('returns a bounded diagnostic error when fast-forward-only refuses divergence', async () => {
    const source = replica('fast-forward-source')
    const target = replica('fast-forward-target')
    await source.open({ create: true })
    await target.open({ create: true })
    await remember(source, 'fast-forward-base', 'fast-forward-base-entity')
    await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'fast-forward-base-checkpoint' },
    )
    await target.syncFrom(source, {
      access,
      confirmSpaceId: 'sync-space',
      strategy: 'fast-forward-only',
    })
    await remember(source, 'fast-forward-source-change', 'fast-forward-source-entity')
    await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'fast-forward-source-head' },
    )
    await remember(target, 'fast-forward-target-change', 'fast-forward-target-entity')
    await target.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'fast-forward-target-head' },
    )

    const failed = await target.syncFrom(source, {
      access,
      confirmSpaceId: 'sync-space',
      strategy: 'fast-forward-only',
      sessionId: 'fast-forward-divergence',
    })

    expect(failed).toMatchObject({
      state: 'failed',
      resumable: false,
      diagnosticsTruncated: false,
      warnings: ['local and remote histories diverged'],
      error: 'fast-forward-only sync refused divergent histories',
    })
    await expect(target.syncStatus(failed.sessionId, access)).resolves.toMatchObject({
      diagnosticsTruncated: false,
      error: 'fast-forward-only sync refused divergent histories',
    })
  })

  it('exports a bounded resumable sync bundle that imports through the reconciliation peer', async () => {
    const sourceStorage = createInMemoryStorage({ name: 'bundle-source' })
    const targetStorage = createInMemoryStorage({ name: 'bundle-target' })
    const source = replica('bundle-source', OPEN_ONTOLOGY, sourceStorage)
    const target = replica('bundle-target', OPEN_ONTOLOGY, targetStorage)
    await source.open({ create: true })
    await target.open({ create: true })
    await remember(source, 'bundle-base-episode', 'bundle-base-entity')
    await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space', maxChunkBytes: 64 * 1024 },
      { operationId: 'bundle-base' },
    )
    await remember(source, 'bundle-head-episode', 'bundle-head-entity')
    const head = await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space', maxChunkBytes: 64 * 1024 },
      { operationId: 'bundle-head' },
    )
    const sourceWholeSpaceExport = vi
      .spyOn(storageDriver(sourceStorage), 'exportRecords')
      .mockRejectedValue(new Error('sync bundle export must remain keyset-streamed'))
    const targetWholeSpaceExport = vi
      .spyOn(storageDriver(targetStorage), 'exportRecords')
      .mockRejectedValue(new Error('sync bundle import must remain chunk-streamed'))

    const frames: SyncBundleFrame[] = []
    let cursor: string | undefined
    let firstCursor: string | undefined
    do {
      const page = await source.exportSyncBundle({
        access,
        confirmSpaceId: 'sync-space',
        checkpointId: head.id,
        cursor,
        maxCheckpoints: 64,
        limit: 2,
        maxBytes: 128 * 1024,
      })
      expect(page).toMatchObject({
        mediaType: 'application/vnd.astrale.temporal-memory-sync-bundle+json',
        bundleVersion: 1,
        checkpoint: head,
      })
      expect(page.byteLength).toBe(new TextEncoder().encode(JSON.stringify(page.frames)).byteLength)
      frames.push(...page.frames)
      firstCursor ??= page.nextCursor
      cursor = page.nextCursor
    } while (cursor !== undefined)

    const checkpointFrames = frames.filter(
      (frame): frame is Extract<SyncBundleFrame, { type: 'checkpoint' }> =>
        frame.type === 'checkpoint',
    )
    expect(checkpointFrames.map((frame) => frame.index)).toEqual(
      checkpointFrames.map((_, index) => index),
    )
    const headers = new Map(
      checkpointFrames.map((frame) => [frame.checkpoint.id, frame.checkpoint]),
    )
    const chunks = frames
      .filter(
        (frame): frame is Extract<SyncBundleFrame, { type: 'chunk' }> => frame.type === 'chunk',
      )
      .map((frame) => frame.chunk)
      .sort((left, right) => left.index - right.index)
    const commits = frames.filter(
      (frame): frame is Extract<SyncBundleFrame, { type: 'commit' }> => frame.type === 'commit',
    )
    const checkpointByteLength = checkpointFrames.reduce(
      (total, frame) =>
        total + new TextEncoder().encode(stableStringify(frame as unknown as JsonValue)).byteLength,
      0,
    )
    expect(commits).toEqual([
      {
        type: 'commit',
        mediaType: 'application/vnd.astrale.temporal-memory-sync-bundle+json',
        bundleVersion: 1,
        checkpointId: head.id,
        checkpointCount: headers.size,
        checkpointByteLength,
        checkpointDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
        chunkCount: head.chunkCount,
        rootDigest: head.rootDigest,
      },
    ])
    const digestDomain = 'astrale.temporal-memory/sync-bundle-checkpoint-digest/v1'
    let checkpointDigest = await sha256Hex(
      stableStringify([digestDomain, 1, 'sync-space', head.id]),
    )
    for (const frame of checkpointFrames) {
      const headerDigest = await sha256Hex(
        stableStringify(frame.checkpoint as unknown as JsonValue),
      )
      checkpointDigest = await sha256Hex(
        stableStringify([digestDomain, checkpointDigest, frame.index, headerDigest]),
      )
    }
    expect(commits[0]?.checkpointDigest).toBe(checkpointDigest)
    expect(chunks).toHaveLength(head.chunkCount)
    expect(headers.get(head.id)).toEqual(head)
    expect(firstCursor).toEqual(expect.any(String))

    let optionSignalReads = 0
    const accessorOptions = Object.defineProperty(
      { maxCheckpoints: 64, maxCheckpointBytes: 128 * 1024 },
      'signal',
      {
        enumerable: true,
        get: () => {
          if (optionSignalReads > 0) throw new Error('sync bundle signal was read twice')
          optionSignalReads += 1
          return undefined
        },
      },
    )
    const accessorPeer = await openSyncBundle(singleReadBundleReader(frames), accessorOptions)
    expect(optionSignalReads).toBe(1)
    expect(await accessorPeer.syncHead(access)).toEqual(head)
    expect(
      (
        await accessorPeer.syncChunks({
          checkpointId: head.id,
          access,
          limit: 64,
        })
      ).chunks,
    ).toHaveLength(head.chunkCount)

    await expect(
      source.exportSyncBundle({
        access,
        confirmSpaceId: 'sync-space',
        checkpointId: head.id,
        maxCheckpoints: 64,
        maxBytes: 1,
      }),
    ).rejects.toMatchObject({ code: 'result_too_large' })

    await expect(
      openSyncBundle(bundleReader(frames), { maxCheckpointBytes: 1 }),
    ).rejects.toMatchObject({ code: 'result_too_large' })
    const bundlePeer = await openSyncBundle(bundleReader(frames), {
      maxCheckpoints: 64,
      maxCheckpointBytes: 128 * 1024,
    })
    const imported = await target.syncFrom(
      bundlePeer,
      { access, confirmSpaceId: 'sync-space', strategy: 'merge' },
      { operationId: 'bundle-import' },
    )
    expect(imported).toMatchObject({ state: 'succeeded', remoteHead: head.id })
    expect(await target.getEpisode('bundle-head-episode', access)).not.toBeNull()
    expect(sourceWholeSpaceExport).not.toHaveBeenCalled()
    expect(targetWholeSpaceExport).not.toHaveBeenCalled()
    sourceWholeSpaceExport.mockRestore()
    targetWholeSpaceExport.mockRestore()

    const metadataStalePage = await source.exportSyncBundle({
      access,
      confirmSpaceId: 'sync-space',
      checkpointId: head.id,
      maxCheckpoints: 64,
      limit: 1,
    })
    const driver = storageDriver(sourceStorage)
    const space = await driver.getSpace('sync-space')
    const ref = await driver.get('sync_ref', 'sync-space', 'head')
    if (space === null || ref === null || metadataStalePage.nextCursor === undefined) {
      throw new Error('metadata-bound bundle fixture is incomplete')
    }
    const legacyCursor = decodeTestCursor(metadataStalePage.nextCursor)
    legacyCursor.v = 1
    delete legacyCursor.metadataRevision
    await expect(
      source.exportSyncBundle({
        access,
        confirmSpaceId: 'sync-space',
        checkpointId: head.id,
        cursor: encodeTestCursor(legacyCursor),
        maxCheckpoints: 64,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: space.revision,
      metadataOnly: true,
      puts: [ref],
    })
    await expect(
      source.exportSyncBundle({
        access,
        confirmSpaceId: 'sync-space',
        checkpointId: head.id,
        cursor: metadataStalePage.nextCursor,
        maxCheckpoints: 64,
      }),
    ).rejects.toMatchObject({ code: 'conflict', retryable: true })

    const originalQuery = driver.query.bind(driver)
    let injected = false
    const query = vi.spyOn(driver, 'query')
    query.mockImplementation(async (request) => {
      const rows = await originalQuery(request)
      if (!injected && request.kind === 'sync_checkpoint') {
        injected = true
        const currentSpace = await driver.getSpace('sync-space')
        const currentRef = await driver.get('sync_ref', 'sync-space', 'head')
        if (currentSpace === null || currentRef === null) {
          throw new Error('metadata-bound bundle race fixture disappeared')
        }
        await driver.commit({
          spaceId: 'sync-space',
          expectedRevision: currentSpace.revision,
          metadataOnly: true,
          puts: [currentRef],
        })
      }
      return rows
    })
    await expect(
      source.exportSyncBundle({
        access,
        confirmSpaceId: 'sync-space',
        checkpointId: head.id,
        maxCheckpoints: 64,
        limit: 2,
      }),
    ).rejects.toMatchObject({ code: 'conflict', retryable: true })
    query.mockRestore()

    const stalePage = await source.exportSyncBundle({
      access,
      confirmSpaceId: 'sync-space',
      checkpointId: head.id,
      maxCheckpoints: 64,
      limit: 1,
    })
    await remember(source, 'bundle-after-cursor', 'bundle-after-cursor')
    await expect(
      source.exportSyncBundle({
        access,
        confirmSpaceId: 'sync-space',
        checkpointId: head.id,
        cursor: stalePage.nextCursor,
        maxCheckpoints: 64,
      }),
    ).rejects.toMatchObject({ code: 'conflict', retryable: true })
  })

  it('rejects incomplete or mutable persisted sync bundles before reconciliation', async () => {
    const source = replica('bundle-validation-source')
    await source.open({ create: true })
    await remember(source, 'bundle-validation-episode', 'bundle-validation-entity')
    const checkpoint = await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space', maxChunkBytes: 64 * 1024 },
      { operationId: 'bundle-validation-checkpoint' },
    )
    const frames: SyncBundleFrame[] = []
    let cursor: string | undefined
    do {
      const page = await source.exportSyncBundle({
        access,
        confirmSpaceId: 'sync-space',
        checkpointId: checkpoint.id,
        cursor,
        maxCheckpoints: 64,
        limit: 2,
      })
      frames.push(...page.frames)
      cursor = page.nextCursor
    } while (cursor !== undefined)

    await expect(
      openSyncBundle(bundleReader(frames.filter((frame) => frame.type !== 'commit'))),
    ).rejects.toMatchObject({ code: 'import_invalid' })

    await expect(
      openSyncBundle(
        bundleReader(frames.filter((frame) => frame.type !== 'chunk' || frame.chunk.index !== 0)),
      ),
    ).rejects.toMatchObject({ code: 'import_invalid' })

    const corrupted = structuredClone(frames) as SyncBundleFrame[]
    const commitIndex = corrupted.findIndex((frame) => frame.type === 'commit')
    const commit = corrupted[commitIndex]
    if (commit?.type !== 'commit') throw new Error('commit fixture is missing')
    corrupted[commitIndex] = { ...commit, checkpointDigest: '0'.repeat(64) }
    await expect(openSyncBundle(bundleReader(corrupted))).rejects.toMatchObject({
      code: 'import_invalid',
    })

    const validCommit = frames.find(
      (frame): frame is SyncBundleCommitFrame => frame.type === 'commit',
    )
    if (validCommit === undefined) throw new Error('commit fixture is missing')
    const unreadableCommit = structuredClone(validCommit)
    Object.defineProperty(unreadableCommit, 'checkpointId', {
      enumerable: true,
      get: () => {
        throw new Error('untrusted bundle accessor detail')
      },
    })
    await expect(
      openSyncBundle({
        ...bundleReader(frames),
        readCommit: async () => unreadableCommit,
      }),
    ).rejects.toMatchObject({
      code: 'import_invalid',
      message: 'sync bundle commit frame is malformed',
    })

    const mutable = structuredClone(frames) as SyncBundleFrame[]
    const reader = bundleReader(mutable)
    const peer = await openSyncBundle(reader)
    const headerIndex = mutable.findIndex(
      (frame) => frame.type === 'checkpoint' && frame.checkpoint.id === checkpoint.id,
    )
    const header = mutable[headerIndex]
    if (header?.type !== 'checkpoint') throw new Error('target header fixture is missing')
    mutable[headerIndex] = {
      ...header,
      checkpoint: { ...header.checkpoint, createdAt: '2026-08-03T10:00:01.000Z' },
    }
    await expect(peer.syncHead(access)).rejects.toMatchObject({ code: 'integrity_failed' })
  })

  it('reuses an unchanged HEAD without retaining a duplicate staged pack', async () => {
    const storage = createInMemoryStorage({ name: 'checkpoint-deduplication' })
    const memory = createMemory({
      spaceId: 'sync-space',
      storage,
      ontology: OPEN_ONTOLOGY,
      now: () => new Date('2026-08-03T10:00:00.000Z'),
      createId: () => 'checkpoint-deduplication-id',
    })
    await memory.open({ create: true })
    await remember(memory, 'deduplicated-episode', 'deduplicated-entity')
    const first = await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'deduplicated-first' },
    )
    const driver = storageDriver(storage)
    const chunksBefore = await driver.query({ kind: 'sync_chunk', spaceId: 'sync-space' })
    const indexesBefore = await driver.query({ kind: 'sync_index', spaceId: 'sync-space' })

    const second = await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'deduplicated-second' },
    )

    expect(second.id).toBe(first.id)
    expect(await driver.query({ kind: 'sync_chunk', spaceId: 'sync-space' })).toHaveLength(
      chunksBefore.length,
    )
    expect(await driver.query({ kind: 'sync_index', spaceId: 'sync-space' })).toHaveLength(
      indexesBefore.length,
    )
  })

  it('compacts old checkpoint payloads in bounded cursor pages while retaining ancestry headers', async () => {
    const storage = createInMemoryStorage({ name: 'sync-history-compaction' })
    let now = new Date('2026-08-03T10:00:00.000Z')
    const memory = createMemory({
      spaceId: 'sync-space',
      storage,
      ontology: OPEN_ONTOLOGY,
      now: () => now,
      createId: () => crypto.randomUUID(),
    })
    await memory.open({ create: true })
    await remember(memory, 'compaction-base-episode', 'compaction-base-entity')
    const base = await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space', maxChunkBytes: 64 * 1024 },
      { operationId: 'compaction-base' },
    )
    now = new Date('2026-08-03T11:00:00.000Z')
    await remember(memory, 'compaction-head-episode', 'compaction-head-entity')
    const head = await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space', maxChunkBytes: 64 * 1024 },
      { operationId: 'compaction-head' },
    )
    const snapshot = await memory.snapshot({ access })
    const request = {
      access,
      confirmSpaceId: 'sync-space',
      expectedRevision: snapshot.snapshotRevision,
      expectedHead: head.id,
      before: '2026-08-03T12:00:00.000Z',
      maxCheckpoints: 1,
    }

    const dryRun = await memory.compactSyncHistory({ ...request, dryRun: true })
    expect(dryRun).toMatchObject({
      dryRun: true,
      head: head.id,
      revision: snapshot.snapshotRevision,
      scannedCheckpoints: 1,
      selected: [
        {
          checkpointId: base.id,
          chunkCount: base.chunkCount,
          recordCount: base.recordCount,
          byteLength: base.byteLength,
        },
      ],
      compactedCheckpoints: 0,
      hasMore: true,
    })
    expect(dryRun.nextCursor).toEqual(expect.any(String))

    const compacted = await memory.compactSyncHistory(request)
    expect(compacted).toMatchObject({
      dryRun: false,
      selected: [{ checkpointId: base.id }],
      compactedCheckpoints: 1,
      deletedChunks: base.chunkCount,
      deletedIndexes: base.recordCount,
      reclaimedBytes: base.byteLength,
      hasMore: true,
      revision: snapshot.snapshotRevision,
    })
    const finalPage = await memory.compactSyncHistory({
      ...request,
      cursor: compacted.nextCursor,
    })
    expect(finalPage).toMatchObject({
      scannedCheckpoints: 1,
      selected: [],
      compactedCheckpoints: 0,
      skippedHead: 1,
      hasMore: false,
    })

    expect(await memory.syncCheckpoint(base.id, access)).toEqual(base)
    await expect(memory.syncChunks({ access, checkpointId: base.id })).rejects.toMatchObject({
      code: 'not_found',
      retryable: false,
      details: { checkpointId: base.id, requiresReseed: true },
    })
    expect(await memory.syncHead(access)).toEqual(head)
    await expect(memory.syncChunks({ access, checkpointId: head.id })).resolves.toMatchObject({
      checkpoint: head,
      chunks: expect.any(Array),
    })
    const driver = storageDriver(storage)
    expect(await driver.get('sync_checkpoint', 'sync-space', base.id)).toMatchObject({
      payloadState: 'pruned',
    })
    expect(await driver.get('sync_checkpoint', 'sync-space', base.id)).not.toHaveProperty(
      'chunkOwnerId',
    )
    expect(head.parents).toContain(base.id)
  })

  it('pages checkpoint and session inventory without exposing local fields', async () => {
    const storage = createInMemoryStorage({ name: 'sync-inventory' })
    let now = new Date('2026-08-03T10:00:00.000Z')
    const memory = createMemory({
      spaceId: 'sync-space',
      storage,
      ontology: OPEN_ONTOLOGY,
      now: () => now,
      createId: () => crypto.randomUUID(),
    })
    await memory.open({ create: true })
    await remember(memory, 'inventory-base', 'inventory-base')
    const base = await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'inventory-base' },
    )
    now = new Date('2026-08-03T11:00:00.000Z')
    await remember(memory, 'inventory-head', 'inventory-head')
    const head = await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'inventory-head' },
    )

    const first = await memory.syncHistory({ access, limit: 1 })
    expect(first).toMatchObject({
      head,
      checkpoints: [{ checkpoint: head, payloadState: 'available', isHead: true }],
      nextCursor: expect.any(String),
    })
    expect(first.checkpoints[0]!.checkpoint).not.toHaveProperty('chunkOwnerId')
    const second = await memory.syncHistory({ access, limit: 1, cursor: first.nextCursor })
    expect(second).toMatchObject({
      head,
      checkpoints: [{ checkpoint: base, payloadState: 'available', isHead: false }],
    })
    await expect(
      memory.syncHistory({
        access,
        limit: 1,
        before: '2026-08-04T00:00:00.000Z',
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    const sessions = await memory.syncSessions({ access, limit: 1 })
    expect(sessions).toMatchObject({
      sessions: [
        {
          mode: 'checkpoint',
          state: 'succeeded',
          detailsState: 'available',
          createdAt: '2026-08-03T11:00:00.000Z',
        },
      ],
      nextCursor: expect.any(String),
    })
    const olderSessions = await memory.syncSessions({
      access,
      limit: 1,
      cursor: sessions.nextCursor,
    })
    expect(olderSessions.sessions).toEqual([
      expect.objectContaining({
        mode: 'checkpoint',
        state: 'succeeded',
        detailsState: 'available',
        createdAt: '2026-08-03T10:00:00.000Z',
      }),
    ])

    const snapshot = await memory.snapshot({ access })
    await memory.compactSyncHistory({
      access,
      confirmSpaceId: 'sync-space',
      expectedRevision: snapshot.snapshotRevision,
      expectedHead: head.id,
      before: '2026-08-03T10:30:00.000Z',
      maxCheckpoints: 64,
    })
    const after = await memory.syncHistory({ access })
    expect(after.checkpoints.find((item) => item.checkpoint.id === base.id)).toMatchObject({
      payloadState: 'pruned',
      isHead: false,
    })
  })

  it('binds checkpoint inventory pages to one exact metadata revision', async () => {
    const storage = createInMemoryStorage({ name: 'sync-inventory-metadata-snapshot' })
    let now = new Date('2026-08-03T10:00:00.000Z')
    const memory = createMemory({
      spaceId: 'sync-space',
      storage,
      ontology: OPEN_ONTOLOGY,
      now: () => now,
      createId: () => crypto.randomUUID(),
    })
    await memory.open({ create: true })
    await remember(memory, 'inventory-metadata-base', 'inventory-metadata-base')
    await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'inventory-metadata-base' },
    )
    now = new Date('2026-08-03T11:00:00.000Z')
    await remember(memory, 'inventory-metadata-head', 'inventory-metadata-head')
    await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'inventory-metadata-head' },
    )

    const first = await memory.syncHistory({ access, limit: 1 })
    const driver = storageDriver(storage)
    const space = await driver.getSpace('sync-space')
    const ref = await driver.get('sync_ref', 'sync-space', 'head')
    if (space === null || ref === null || first.nextCursor === undefined) {
      throw new Error('metadata-bound inventory fixture is incomplete')
    }
    const legacyCursor = decodeTestCursor(first.nextCursor)
    legacyCursor.v = 1
    delete legacyCursor.metadataRevision
    await expect(
      memory.syncHistory({ access, limit: 1, cursor: encodeTestCursor(legacyCursor) }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: space.revision,
      metadataOnly: true,
      puts: [ref],
    })
    await expect(
      memory.syncHistory({ access, limit: 1, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    const originalQuery = driver.query.bind(driver)
    let injected = false
    const query = vi.spyOn(driver, 'query')
    query.mockImplementation(async (request) => {
      const rows = await originalQuery(request)
      if (!injected && request.kind === 'sync_checkpoint') {
        injected = true
        const currentSpace = await driver.getSpace('sync-space')
        const currentRef = await driver.get('sync_ref', 'sync-space', 'head')
        if (currentSpace === null || currentRef === null) {
          throw new Error('metadata race fixture disappeared')
        }
        await driver.commit({
          spaceId: 'sync-space',
          expectedRevision: currentSpace.revision,
          metadataOnly: true,
          puts: [currentRef],
        })
      }
      return rows
    })
    await expect(memory.syncHistory({ access, limit: 1 })).rejects.toMatchObject({
      code: 'conflict',
      retryable: true,
    })
    query.mockRestore()
    await expect(memory.syncHistory({ access, limit: 1 })).resolves.toMatchObject({
      checkpoints: expect.any(Array),
    })
  })

  it('bounds retained sync-session diagnostics and exposes explicit truncation', async () => {
    const storage = createInMemoryStorage({ name: 'sync-session-diagnostic-bounds' })
    const memory = createMemory({
      spaceId: 'sync-space',
      storage,
      ontology: OPEN_ONTOLOGY,
      now: () => new Date('2026-08-03T10:00:00.000Z'),
      createId: () => crypto.randomUUID(),
    })
    await memory.open({ create: true })
    await remember(memory, 'diagnostic-session-episode', 'diagnostic-session-entity')
    const head = await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'diagnostic-session-checkpoint' },
    )
    const inventory = await memory.syncSessions({ access, limit: 100 })
    const session = inventory.sessions[0]
    if (session === undefined) throw new Error('sync session fixture is missing')
    expect(session).toMatchObject({ diagnosticsTruncated: false, warnings: [] })
    expect(session).not.toHaveProperty('error')

    const driver = storageDriver(storage)
    const stored = await driver.get('sync_session', 'sync-space', session.sessionId)
    const space = await driver.getSpace('sync-space')
    if (stored === null || space === null) throw new Error('stored sync session fixture is missing')
    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: space.revision,
      metadataOnly: true,
      puts: [
        {
          ...stored,
          diagnosticsTruncated: false,
          warnings: Array.from({ length: 70 }, (_, index) => `warning-${index}`),
          error: 'e'.repeat(2_500),
        },
      ],
    })
    const contaminated = await driver.get('sync_session', 'sync-space', session.sessionId)
    expect(contaminated?.warnings).toHaveLength(70)
    expect(contaminated?.error).toHaveLength(2_500)
    expect(await memory.verifyIntegrity()).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'invalid_sync_session' })],
    })

    const snapshot = await memory.snapshot({ access })
    await memory.compactSyncSessions({
      access,
      confirmSpaceId: 'sync-space',
      expectedRevision: snapshot.snapshotRevision,
      expectedHead: head.id,
      before: '2026-08-03T11:00:00.000Z',
      maxSessions: 64,
    })
    const bounded = await memory.syncStatus(session.sessionId, access)
    expect(bounded).toMatchObject({
      diagnosticsTruncated: true,
      warnings: expect.any(Array),
      error: 'e'.repeat(2_000),
    })
    expect(bounded?.warnings).toHaveLength(64)
    expect(bounded?.warnings.slice(0, 32)).toEqual(
      Array.from({ length: 32 }, (_, index) => `warning-${index}`),
    )
    expect(bounded?.warnings.slice(32)).toEqual(
      Array.from({ length: 32 }, (_, index) => `warning-${index + 38}`),
    )
    expect(await memory.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })
  })

  it('validates the complete durable sync-session binding before metadata disclosure', async () => {
    const privateAccess = { allowedScopes: ['private'] }
    const source = replica('validated-session-source')
    const targetStorage = createInMemoryStorage({ name: 'validated-session-target' })
    const target = replica('validated-session-target', OPEN_ONTOLOGY, targetStorage)
    await source.open({ create: true })
    await target.open({ create: true })
    await source.remember({
      id: 'validated-session-private-episode',
      kind: 'text',
      content: { type: 'text', text: 'Private session metadata must remain private.' },
      source: { kind: 'fixture' },
      scopes: ['private'],
    })
    await source.createSyncCheckpoint(
      { access: privateAccess, confirmSpaceId: 'sync-space' },
      { operationId: 'validated-session-source-head' },
    )
    const report = await target.syncFrom(source, {
      access: privateAccess,
      confirmSpaceId: 'sync-space',
      sessionId: 'validated-session-pull',
    })
    const driver = storageDriver(targetStorage)
    const stored = await driver.get('sync_session', 'sync-space', report.sessionId)
    const space = await driver.getSpace('sync-space')
    if (stored === null || space === null) throw new Error('validated session fixture is missing')

    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: space.revision,
      metadataOnly: true,
      puts: [
        {
          ...stored,
          requiredScopes: [],
          requestScopes: [],
          rootDigest: '0'.repeat(64),
        },
      ],
    })
    await expect(target.syncStatus(report.sessionId, access)).rejects.toSatisfy((error: unknown) =>
      MemoryError.is(error, 'integrity_failed'),
    )
    expect(await target.verifyIntegrity()).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_sync_session' })]),
    })

    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: space.revision,
      metadataOnly: true,
      puts: [stored],
    })
    await expect(target.syncStatus(report.sessionId, privateAccess)).resolves.toMatchObject({
      state: 'succeeded',
      remoteHead: report.remoteHead,
    })
    expect(await target.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })
  })

  it('binds sync-history compaction to scope, space, revision, HEAD, bounds, and cursor policy', async () => {
    const storage = createInMemoryStorage({ name: 'sync-compaction-guards' })
    const privateAccess = { allowedScopes: ['private'] }
    let now = new Date('2026-08-03T10:00:00.000Z')
    const memory = createMemory({
      spaceId: 'sync-space',
      storage,
      ontology: OPEN_ONTOLOGY,
      now: () => now,
      createId: () => crypto.randomUUID(),
    })
    await memory.open({ create: true })
    await memory.remember({
      id: 'private-compaction-base',
      kind: 'text',
      content: { type: 'text', text: 'Private checkpoint history.' },
      source: { kind: 'fixture' },
      scopes: ['private'],
    })
    await memory.createSyncCheckpoint(
      { access: privateAccess, confirmSpaceId: 'sync-space' },
      { operationId: 'private-compaction-base' },
    )
    now = new Date('2026-08-03T11:00:00.000Z')
    await memory.remember({
      id: 'private-compaction-head',
      kind: 'text',
      content: { type: 'text', text: 'Private current checkpoint.' },
      source: { kind: 'fixture' },
      scopes: ['private'],
    })
    const head = await memory.createSyncCheckpoint(
      { access: privateAccess, confirmSpaceId: 'sync-space' },
      { operationId: 'private-compaction-head' },
    )
    const snapshot = await memory.snapshot({ access: privateAccess })
    const request = {
      access: privateAccess,
      confirmSpaceId: 'sync-space',
      expectedRevision: snapshot.snapshotRevision,
      expectedHead: head.id,
      before: '2026-08-03T12:00:00.000Z',
      maxCheckpoints: 1,
      dryRun: true,
    }

    await expect(memory.compactSyncHistory({ ...request, access })).rejects.toMatchObject({
      code: 'scope_denied',
    })
    await expect(
      memory.compactSyncHistory({ ...request, confirmSpaceId: 'another-space' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      memory.compactSyncHistory({
        ...request,
        expectedRevision: snapshot.snapshotRevision + 1,
      }),
    ).rejects.toMatchObject({ code: 'conflict', retryable: true })
    await expect(
      memory.compactSyncHistory({ ...request, expectedHead: 'f'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'conflict', retryable: true })
    await expect(
      memory.compactSyncHistory({ ...request, maxCheckpoints: 0 }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    const page = await memory.compactSyncHistory(request)
    expect(page.nextCursor).toEqual(expect.any(String))
    await expect(
      memory.compactSyncHistory({
        ...request,
        before: '2026-08-04T12:00:00.000Z',
        cursor: page.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    await expect(memory.syncHistory({ access })).rejects.toMatchObject({ code: 'scope_denied' })
    const sessionRequest = {
      access: privateAccess,
      confirmSpaceId: 'sync-space',
      expectedRevision: snapshot.snapshotRevision,
      expectedHead: head.id,
      before: '2026-08-03T12:00:00.000Z',
      maxSessions: 1,
      dryRun: true,
    }
    await expect(memory.compactSyncSessions({ ...sessionRequest, access })).rejects.toMatchObject({
      code: 'scope_denied',
    })
    await expect(
      memory.compactSyncSessions({ ...sessionRequest, confirmSpaceId: 'another-space' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      memory.compactSyncSessions({
        ...sessionRequest,
        expectedRevision: snapshot.snapshotRevision + 1,
      }),
    ).rejects.toMatchObject({ code: 'conflict', retryable: true })
    await expect(
      memory.compactSyncSessions({ ...sessionRequest, expectedHead: 'f'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'conflict', retryable: true })
    await expect(
      memory.compactSyncSessions({ ...sessionRequest, maxSessions: 0 }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const sessionPage = await memory.compactSyncSessions(sessionRequest)
    expect(sessionPage.nextCursor).toEqual(expect.any(String))
    await expect(
      memory.compactSyncSessions({
        ...sessionRequest,
        before: '2026-08-04T12:00:00.000Z',
        cursor: sessionPage.nextCursor,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('fails closed with an explicit reseed requirement when a divergent merge base was compacted', async () => {
    const left = replica('expired-base-left')
    const right = replica('expired-base-right')
    await left.open({ create: true })
    await right.open({ create: true })
    await remember(left, 'shared-before-compaction', 'shared-entity')
    const shared = await left.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'shared-before-compaction' },
    )
    await right.syncFrom(
      left,
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'clone-before-compaction' },
    )

    await remember(left, 'left-after-shared', 'left-after-shared')
    await left.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'left-after-shared' },
    )
    await remember(right, 'right-after-shared', 'right-after-shared')
    const rightHead = await right.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'right-after-shared' },
    )
    const rightSnapshot = await right.snapshot({ access })
    await right.compactSyncHistory({
      access,
      confirmSpaceId: 'sync-space',
      expectedRevision: rightSnapshot.snapshotRevision,
      expectedHead: rightHead.id,
      before: '2026-08-04T00:00:00.000Z',
      maxCheckpoints: 64,
    })

    await expect(
      right.syncFrom(left, {
        access,
        confirmSpaceId: 'sync-space',
        sessionId: 'expired-merge-base-session',
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      retryable: false,
      details: { checkpointId: shared.id, requiresReseed: true },
    })
    expect(await right.syncStatus('expired-merge-base-session', access)).toBeNull()
    expect(await right.syncCheckpoint(shared.id, access)).toEqual(shared)
    expect(await right.getEpisode('right-after-shared', access)).not.toBeNull()
  })

  it('finishes crash-interrupted checkpoint payload reclamation before reopening', async () => {
    const storage = createInMemoryStorage({ name: 'sync-compaction-recovery' })
    let now = new Date('2026-08-03T10:00:00.000Z')
    const createReplica = (): Memory =>
      createMemory({
        spaceId: 'sync-space',
        storage,
        ontology: OPEN_ONTOLOGY,
        now: () => now,
        createId: () => crypto.randomUUID(),
      })
    const memory = createReplica()
    await memory.open({ create: true })
    await remember(memory, 'recover-compaction-base', 'recover-compaction-base')
    const base = await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'recover-compaction-base' },
    )
    now = new Date('2026-08-03T11:00:00.000Z')
    await remember(memory, 'recover-compaction-head', 'recover-compaction-head')
    const head = await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'recover-compaction-head' },
    )
    const snapshot = await memory.snapshot({ access })
    const driver = storageDriver(storage)
    const storedBase = await driver.get('sync_checkpoint', 'sync-space', base.id)
    expect(storedBase?.chunkOwnerId).toEqual(expect.any(String))
    const ownerId = storedBase!.chunkOwnerId!
    const originalCommit = driver.commit.bind(driver)
    let interrupted = false
    const commit = vi.spyOn(driver, 'commit')
    commit.mockImplementation(async (change) => {
      if (
        !interrupted &&
        change.metadataOnly === true &&
        change.deletes?.some((entry) => entry.kind === 'sync_index' || entry.kind === 'sync_chunk')
      ) {
        interrupted = true
        throw new Error('simulated sync compaction crash')
      }
      return originalCommit(change)
    })

    await expect(
      memory.compactSyncHistory({
        access,
        confirmSpaceId: 'sync-space',
        expectedRevision: snapshot.snapshotRevision,
        expectedHead: head.id,
        before: '2026-08-03T12:00:00.000Z',
        maxCheckpoints: 64,
      }),
    ).rejects.toThrow('simulated sync compaction crash')
    commit.mockRestore()
    expect(await driver.get('sync_checkpoint', 'sync-space', base.id)).toMatchObject({
      payloadState: 'pruning',
      pruningOwnerId: ownerId,
    })
    await memory.close()

    const reopened = createReplica()
    await reopened.open()
    const recovered = await driver.get('sync_checkpoint', 'sync-space', base.id)
    expect(recovered).toMatchObject({ payloadState: 'pruned' })
    expect(recovered).not.toHaveProperty('chunkOwnerId')
    expect(recovered).not.toHaveProperty('pruningOwnerId')
    expect(
      await driver.query({
        kind: 'sync_chunk',
        spaceId: 'sync-space',
        filters: [{ field: 'ownerId', op: 'eq', value: ownerId }],
      }),
    ).toEqual([])
    expect(
      await driver.query({
        kind: 'sync_index',
        spaceId: 'sync-space',
        filters: [{ field: 'ownerId', op: 'eq', value: ownerId }],
      }),
    ).toEqual([])
    expect(await reopened.syncCheckpoint(base.id, access)).toEqual(base)
    await expect(reopened.syncChunks({ access, checkpointId: base.id })).rejects.toMatchObject({
      details: { requiresReseed: true },
    })
  })

  it('recovers interrupted terminal-session detail reclamation without deleting checkpoint payloads', async () => {
    const storage = createInMemoryStorage({ name: 'sync-session-compaction-recovery' })
    const createReplica = (): Memory =>
      createMemory({
        spaceId: 'sync-space',
        storage,
        ontology: OPEN_ONTOLOGY,
        now: () => new Date('2026-08-03T10:00:00.000Z'),
        createId: () => crypto.randomUUID(),
      })
    const memory = createReplica()
    await memory.open({ create: true })
    await remember(memory, 'session-recovery-episode', 'session-recovery-entity')
    const head = await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'session-recovery-checkpoint' },
    )
    const driver = storageDriver(storage)
    const [session] = await driver.query({
      kind: 'sync_session',
      spaceId: 'sync-space',
      filters: [{ field: 'state', op: 'eq', value: 'succeeded' }],
      limit: 1,
    })
    expect(session).toBeDefined()
    const snapshot = await memory.snapshot({ access })
    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: snapshot.snapshotRevision,
      metadataOnly: true,
      puts: [
        {
          kindRecord: 'sync_conflict',
          id: 'sync_conflict_session_recovery',
          spaceId: 'sync-space',
          sessionId: session!.id,
          syncKey: 'episode\u0000session-recovery-episode',
          recordKind: 'episode',
          recordId: 'session-recovery-episode',
          reason: 'both_modified',
        },
      ],
    })
    const chunksBefore = await driver.query({
      kind: 'sync_chunk',
      spaceId: 'sync-space',
      filters: [{ field: 'ownerId', op: 'eq', value: session!.id }],
    })
    expect(chunksBefore).toHaveLength(head.chunkCount)
    const originalCommit = driver.commit.bind(driver)
    let interrupted = false
    const commit = vi.spyOn(driver, 'commit')
    commit.mockImplementation(async (change) => {
      if (
        !interrupted &&
        change.metadataOnly === true &&
        change.deletes?.some((entry) => entry.kind === 'sync_conflict')
      ) {
        interrupted = true
        throw new Error('simulated sync session compaction crash')
      }
      return originalCommit(change)
    })

    await expect(
      memory.compactSyncSessions({
        access,
        confirmSpaceId: 'sync-space',
        expectedRevision: snapshot.snapshotRevision,
        expectedHead: head.id,
        before: '2026-08-03T11:00:00.000Z',
        maxSessions: 64,
      }),
    ).rejects.toThrow('simulated sync session compaction crash')
    commit.mockRestore()
    expect(await driver.get('sync_session', 'sync-space', session!.id)).toMatchObject({
      detailsState: 'pruning',
    })
    await memory.close()

    const reopened = createReplica()
    await reopened.open()
    expect(await driver.get('sync_session', 'sync-space', session!.id)).toMatchObject({
      state: 'succeeded',
      detailsState: 'pruned',
    })
    expect(
      await driver.query({
        kind: 'sync_conflict',
        spaceId: 'sync-space',
        filters: [{ field: 'sessionId', op: 'eq', value: session!.id }],
      }),
    ).toEqual([])
    expect(
      await driver.query({
        kind: 'sync_chunk',
        spaceId: 'sync-space',
        filters: [{ field: 'ownerId', op: 'eq', value: session!.id }],
      }),
    ).toHaveLength(head.chunkCount)
    await expect(reopened.syncChunks({ access, checkpointId: head.id })).resolves.toMatchObject({
      checkpoint: head,
      chunks: expect.any(Array),
    })
    await expect(reopened.syncStatus(session!.id, access)).resolves.toMatchObject({
      state: 'succeeded',
    })
  })

  it('keeps durable sync session metadata behind the checkpoint scope boundary', async () => {
    const source = replica('scoped-source')
    const target = replica('scoped-target')
    const privateAccess = { allowedScopes: ['private'] }
    await source.open({ create: true })
    await target.open({ create: true })
    await source.remember({
      id: 'private-sync-episode',
      kind: 'text',
      content: { type: 'text', text: 'Private replica state.' },
      source: { kind: 'fixture' },
      scopes: ['private'],
    })
    await source.createSyncCheckpoint(
      { access: privateAccess, confirmSpaceId: 'sync-space' },
      { operationId: 'private-sync-checkpoint' },
    )
    const report = await target.syncFrom(
      source,
      { access: privateAccess, confirmSpaceId: 'sync-space' },
      { operationId: 'private-sync-pull' },
    )

    await expect(target.syncStatus(report.sessionId, access)).rejects.toSatisfy((error: unknown) =>
      MemoryError.is(error, 'scope_denied'),
    )
    await expect(
      target.syncFrom(source, {
        sessionId: report.sessionId,
        access,
        confirmSpaceId: 'sync-space',
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'scope_denied'))
    await expect(target.syncStatus(report.sessionId, privateAccess)).resolves.toMatchObject({
      state: 'succeeded',
    })
  })

  it('rejects an operation id owned by another mutation before contacting the peer', async () => {
    const source = replica('operation-binding-source')
    const target = replica('operation-binding-target')
    await source.open({ create: true })
    await target.open({ create: true })
    await remember(source, 'operation-binding-remote', 'operation-binding-remote-entity')
    await target.remember(
      {
        id: 'operation-binding-local',
        kind: 'text',
        content: { type: 'text', text: 'Local operation owns the id.' },
        source: { kind: 'fixture' },
      },
      { operationId: 'shared-operation-id' },
    )
    const syncHead = vi.fn((...args: Parameters<MemorySyncPeer['syncHead']>) =>
      source.syncHead(...args),
    )
    const peer: MemorySyncPeer = {
      syncHead,
      syncCheckpoint: (...args) => source.syncCheckpoint(...args),
      syncChunks: (...args) => source.syncChunks(...args),
    }

    await expect(
      target.syncFrom(
        peer,
        {
          sessionId: 'operation-binding-session',
          access,
          confirmSpaceId: 'sync-space',
        },
        { operationId: 'shared-operation-id' },
      ),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'idempotency_conflict'))
    expect(syncHead).not.toHaveBeenCalled()
    await expect(target.getEpisode('operation-binding-remote', access)).resolves.toBeNull()
  })

  it('rejects a checkpoint above the receiver budget before requesting a chunk', async () => {
    const source = replica('bounded-source')
    const target = replica('bounded-target')
    await source.open({ create: true })
    await target.open({ create: true })
    await remember(source, 'bounded-episode', 'bounded-entity')
    const checkpoint = await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'bounded-checkpoint' },
    )
    const syncChunks = vi.fn((...args: Parameters<MemorySyncPeer['syncChunks']>) =>
      source.syncChunks(...args),
    )
    const peer: MemorySyncPeer = {
      syncHead: (...args) => source.syncHead(...args),
      syncCheckpoint: (...args) => source.syncCheckpoint(...args),
      syncChunks,
    }

    await expect(
      target.syncFrom(peer, {
        access,
        confirmSpaceId: 'sync-space',
        receiveLimits: { maxBytes: checkpoint.byteLength - 1 },
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'result_too_large'))
    expect(syncChunks).not.toHaveBeenCalled()
    expect(await target.stats()).toMatchObject({ episodes: 0, entities: 0, facts: 0 })
  })

  it('fails a merged result above its bound without mutating live memory', async () => {
    const left = replica('merge-budget-left')
    const right = replica('merge-budget-right')
    await left.open({ create: true })
    await right.open({ create: true })
    await remember(left, 'merge-budget-left-episode', 'merge-budget-left-entity')
    await remember(right, 'merge-budget-right-episode', 'merge-budget-right-entity')
    const leftHead = await left.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'merge-budget-left-head' },
    )
    const rightHead = await right.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'merge-budget-right-head' },
    )

    await expect(
      left.syncFrom(right, {
        sessionId: 'merge-budget-session',
        access,
        confirmSpaceId: 'sync-space',
        receiveLimits: { maxRecords: Math.max(leftHead.recordCount, rightHead.recordCount) },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.sessionId === 'merge-budget-session',
    )
    await expect(left.syncStatus('merge-budget-session', access)).resolves.toMatchObject({
      state: 'failed',
      resumable: false,
    })
    await expect(left.getEpisode('merge-budget-left-episode', access)).resolves.toBeTruthy()
    await expect(left.getEpisode('merge-budget-right-episode', access)).resolves.toBeNull()
    await expect(
      left.abortSync({
        sessionId: 'merge-budget-session',
        access,
        confirmSpaceId: 'sync-space',
      }),
    ).resolves.toMatchObject({ state: 'aborted' })
  })

  it('streams a bounded chunk larger than the ordinary single-value JSON budget', async () => {
    const source = replica('large-chunk-source')
    const target = replica('large-chunk-target')
    await source.open({ create: true })
    await target.open({ create: true })
    for (let index = 0; index < 3; index += 1) {
      await source.remember({
        id: `large-chunk-${index}`,
        kind: 'text',
        content: { type: 'text', text: `${index}${'x'.repeat(1_400_000)}` },
        source: { kind: 'fixture' },
      })
    }
    const checkpoint = await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'large-chunk-checkpoint' },
    )
    expect(checkpoint).toMatchObject({ chunkCount: 1 })
    expect(checkpoint.byteLength).toBeGreaterThan(4_000_000)

    await expect(
      target.syncFrom(
        source,
        { access, confirmSpaceId: 'sync-space' },
        { operationId: 'large-chunk-pull' },
      ),
    ).resolves.toMatchObject({ state: 'succeeded', receivedChunks: 1 })
    expect(await target.stats()).toMatchObject({ episodes: 3 })
  })

  it('preserves complete signal revision history while rebasing physical revisions locally', async () => {
    const source = replica('source-signals')
    const target = replica('target-signals')
    await source.open({ create: true })
    await target.open({ create: true })
    await remember(source, 'thread', 'thread-entity')
    let revision = (await source.snapshot({ access })).snapshotRevision
    const first = await source.putSignals({
      access,
      expectedRevision: revision,
      signals: [
        {
          namespace: 'session',
          slot: 'state',
          target: { kind: 'episode', id: 'thread' },
          producer: { kind: 'manual', id: 'host', version: '1' },
          scopes: [],
          value: { state: 'open' },
        },
      ],
    })
    revision = first.revision
    await source.putSignals({
      access,
      expectedRevision: revision,
      signals: [
        {
          namespace: 'session',
          slot: 'state',
          target: { kind: 'episode', id: 'thread' },
          producer: { kind: 'manual', id: 'host', version: '1' },
          scopes: [],
          value: { state: 'closed' },
        },
      ],
    })

    await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'signal-checkpoint' },
    )
    await target.syncFrom(
      source,
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'signal-pull' },
    )

    const history = await target.browseSignals({ access, revisionView: 'history', order: 'key' })
    const revisions = [...history.signals].sort((left, right) => left.version - right.version)
    expect(revisions.map((signal) => signal.version)).toEqual([1, 2])
    expect(revisions[1]).toMatchObject({ supersedes: revisions[0]!.id })
    expect(revisions[1]!.recordedRevision).toBeGreaterThan(revisions[0]!.recordedRevision)
    expect(await target.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })
  })

  it('surfaces a same-record divergent edit and resumes after an explicit resolution', async () => {
    const leftStorage = createInMemoryStorage({ name: 'left' })
    const leftDriver = storageDriver(leftStorage)
    const left = replica('left', OPEN_ONTOLOGY, leftStorage)
    const right = replica('right')
    await left.open({ create: true })
    await right.open({ create: true })
    await remember(left, 'shared', 'shared-entity')
    const conflictSlots = Array.from(
      { length: 101 },
      (_, index) => `state-${index.toString().padStart(3, '0')}`,
    )
    const branchSignals = (branch: 'base' | 'left' | 'right') =>
      conflictSlots.map((slot) => ({
        namespace: 'merge-test',
        slot,
        target: { kind: 'episode' as const, id: 'shared' },
        producer: { kind: 'manual' as const, id: 'host', version: '1' },
        scopes: [],
        value: { branch },
      }))
    let revision = (await left.snapshot({ access })).snapshotRevision
    const firstSignal = await left.putSignals({
      access,
      expectedRevision: revision,
      signals: branchSignals('base'),
    })
    await left.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'base' },
    )
    await right.syncFrom(left, { access, confirmSpaceId: 'sync-space' }, { operationId: 'clone' })

    await left.putSignals({
      access,
      expectedRevision: firstSignal.revision,
      signals: branchSignals('left'),
    })
    revision = (await right.snapshot({ access })).snapshotRevision
    await right.putSignals({
      access,
      expectedRevision: revision,
      signals: branchSignals('right'),
    })
    await left.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'left-head' },
    )
    await right.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'right-head' },
    )

    const commitSpy = vi.spyOn(leftDriver, 'commit')
    const first = await left.syncFrom(
      right,
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'divergent-pull' },
    )
    expect(first).toMatchObject({ state: 'conflicts', conflicts: 101, resumable: true })
    const conflictCommits = commitSpy.mock.calls.filter(([change]) =>
      change.puts?.some((record) => record.kindRecord === 'sync_conflict'),
    )
    expect(conflictCommits).toHaveLength(1)
    expect(
      conflictCommits[0]![0].puts?.filter((record) => record.kindRecord === 'sync_conflict'),
    ).toHaveLength(101)
    commitSpy.mockRestore()
    const page = await left.syncConflicts({ sessionId: first.sessionId, access, limit: 1_000 })
    expect(page.conflicts).toHaveLength(101)
    expect(
      page.conflicts.every(
        (conflict) => conflict.kind === 'signal' && conflict.reason === 'both_modified',
      ),
    ).toBe(true)
    expect(new TextEncoder().encode(JSON.stringify(page)).byteLength).toBe(page.byteLength)
    const firstConflictPage = await left.syncConflicts({
      sessionId: first.sessionId,
      access,
      limit: 1,
    })
    expect(firstConflictPage).toMatchObject({
      conflicts: [expect.any(Object)],
      nextCursor: expect.any(String),
      byteLength: expect.any(Number),
    })
    expect(new TextEncoder().encode(JSON.stringify(firstConflictPage)).byteLength).toBe(
      firstConflictPage.byteLength,
    )
    expect(new TextEncoder().encode(firstConflictPage.nextCursor!).byteLength).toBeLessThan(512)
    await expect(
      left.syncConflicts({
        sessionId: first.sessionId,
        access,
        limit: 1,
        maxBytes: firstConflictPage.byteLength - 1,
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'result_too_large'))
    const secondConflictPage = await left.syncConflicts({
      sessionId: first.sessionId,
      access,
      cursor: firstConflictPage.nextCursor,
      limit: 1_000,
    })
    expect(secondConflictPage.nextCursor).toBeUndefined()
    expect(secondConflictPage.conflicts).toHaveLength(100)
    expect(
      [...firstConflictPage.conflicts, ...secondConflictPage.conflicts]
        .map((conflict) => conflict.key)
        .sort(),
    ).toEqual(page.conflicts.map((conflict) => conflict.key).sort())
    const legacyCursor = encodeTestCursor({
      v: 1,
      spaceId: 'sync-space',
      sessionId: first.sessionId,
      lastKey: `signal\u0000${'x'.repeat(4_096)}`,
    })
    expect(new TextEncoder().encode(legacyCursor).byteLength).toBeGreaterThan(4_096)
    await expect(
      left.syncConflicts({ sessionId: first.sessionId, access, cursor: legacyCursor }),
    ).resolves.toMatchObject({ conflicts: [], byteLength: expect.any(Number) })
    const storedConflicts = await leftDriver.query({
      kind: 'sync_conflict',
      spaceId: 'sync-space',
      filters: [{ field: 'sessionId', op: 'eq', value: first.sessionId }],
    })
    const contaminatedConflict = storedConflicts[0]
    const leftSpace = await leftDriver.getSpace('sync-space')
    if (contaminatedConflict === undefined || leftSpace === null) {
      throw new Error('stored sync conflict fixture is missing')
    }
    const credential = 'sync-conflict-secret'
    await leftDriver.commit({
      spaceId: 'sync-space',
      expectedRevision: leftSpace.revision,
      metadataOnly: true,
      puts: [
        {
          ...contaminatedConflict,
          diagnosticPayload: { credential },
        } as unknown as typeof contaminatedConflict,
      ],
    })
    expect(await left.verifyIntegrity()).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'invalid_sync_conflict' })],
    })
    const malformedListError = await left
      .syncConflicts({ sessionId: first.sessionId, access })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    expect(MemoryError.is(malformedListError, 'integrity_failed')).toBe(true)
    expect(stableStringify(malformedListError as unknown as JsonValue)).not.toContain(credential)
    await leftDriver.commit({
      spaceId: 'sync-space',
      expectedRevision: leftSpace.revision,
      metadataOnly: true,
      puts: [contaminatedConflict],
    })
    expect(await left.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })
    const storedConflictSession = await leftDriver.get(
      'sync_session',
      'sync-space',
      first.sessionId,
    )
    if (storedConflictSession === null)
      throw new Error('stored conflict session fixture is missing')
    await leftDriver.commit({
      spaceId: 'sync-space',
      expectedRevision: leftSpace.revision,
      metadataOnly: true,
      deletes: [{ kind: 'sync_session', id: first.sessionId }],
    })
    expect(await left.verifyIntegrity()).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'invalid_sync_conflict' }),
        expect.objectContaining({ code: 'orphan_sync_owner' }),
      ]),
    })
    await leftDriver.commit({
      spaceId: 'sync-space',
      expectedRevision: leftSpace.revision,
      metadataOnly: true,
      puts: [storedConflictSession],
    })
    expect(await left.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })
    await expect(
      left.syncConflict({
        sessionId: first.sessionId,
        key: page.conflicts[0]!.key,
        access,
        maxBytes: 1,
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'result_too_large'))
    const detail = await left.syncConflict({
      sessionId: first.sessionId,
      key: page.conflicts[0]!.key,
      access,
    })
    expect(detail).toMatchObject({
      conflict: { kind: 'signal', reason: 'both_modified' },
      base: null,
      local: { value: { value: { branch: 'left' } } },
      remote: { value: { value: { branch: 'right' } } },
      byteLength: expect.any(Number),
    })
    expect(new TextEncoder().encode(JSON.stringify(detail)).byteLength).toBe(detail.byteLength)
    const getSpy = vi.spyOn(leftDriver, 'get')
    const resolved = await left.resolveSync({
      sessionId: first.sessionId,
      access,
      confirmSpaceId: 'sync-space',
      resolutions: page.conflicts.map((conflict) => ({ key: conflict.key, choice: 'local' })),
    })
    expect(getSpy.mock.calls.filter(([kind]) => kind === 'sync_chunk').length).toBeLessThanOrEqual(
      32,
    )
    getSpy.mockRestore()
    expect(resolved.state).toBe('succeeded')
    const current = await left.browseSignals({ access, includeExpired: true, limit: 200 })
    expect(current.signals).toHaveLength(101)
    expect(
      current.signals.every(
        (signal) =>
          signal.state === 'active' && stableStringify(signal.value) === '{"branch":"left"}',
      ),
    ).toBe(true)

    const snapshot = await left.snapshot({ access })
    const head = await left.syncHead(access)
    const request = {
      access,
      confirmSpaceId: 'sync-space',
      expectedRevision: snapshot.snapshotRevision,
      expectedHead: head.id,
      before: '2026-08-03T11:00:00.000Z',
      maxSessions: 64,
    }
    const plan = await left.compactSyncSessions({ ...request, dryRun: true })
    expect(plan.selected).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: first.sessionId })]),
    )
    const compacted = await left.compactSyncSessions(request)
    expect(compacted).toMatchObject({
      dryRun: false,
      deletedConflicts: 101,
      compactedSessions: expect.any(Number),
      reclaimedBytes: expect.any(Number),
    })
    expect(compacted.compactedSessions).toBeGreaterThan(0)
    await expect(left.syncStatus(first.sessionId, access)).resolves.toMatchObject({
      state: 'succeeded',
    })
    const inventory = await left.syncSessions({ access, limit: 100 })
    expect(
      inventory.sessions.find((session) => session.sessionId === first.sessionId),
    ).toMatchObject({ detailsState: 'pruned', state: 'succeeded' })
    await expect(left.syncConflicts({ sessionId: first.sessionId, access })).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'not_found') && error.details?.detailsPruned === true,
    )
    await expect(
      left.syncConflict({
        sessionId: first.sessionId,
        key: page.conflicts[0]!.key,
        access,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'not_found') && error.details?.detailsPruned === true,
    )
    await expect(left.syncChunks({ access, checkpointId: head.id })).resolves.toMatchObject({
      checkpoint: head,
      chunks: expect.any(Array),
    })
  })

  it('turns a cross-branch derivation cycle into explicit invalid-combination conflicts', async () => {
    const left = replica('cycle-left')
    const right = replica('cycle-right')
    await left.open({ create: true })
    await right.open({ create: true })
    await left.remember({
      id: 'cycle-basis',
      kind: 'assertion',
      content: { type: 'text', text: 'The two independently supported facts are true.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'cycle-entity', name: 'Cycle entity' }],
        facts: [
          {
            id: 'cycle-fact-a',
            subject: { id: 'cycle-entity' },
            predicate: 'cycle_a',
            object: { scalar: true },
          },
          {
            id: 'cycle-fact-b',
            subject: { id: 'cycle-entity' },
            predicate: 'cycle_b',
            object: { scalar: true },
          },
        ],
      },
    })
    await left.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'cycle-base' },
    )
    await right.syncFrom(
      left,
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'cycle-clone' },
    )
    await left.deriveFact({
      conclusion: {
        id: 'cycle-fact-b',
        subjectId: 'cycle-entity',
        predicate: 'cycle_b',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'cycle/a-implies-b', version: '1' },
      premises: [{ kind: 'fact', id: 'cycle-fact-a' }],
      access,
      expectedRevision: (await left.snapshot({ access })).snapshotRevision,
    })
    await right.deriveFact({
      conclusion: {
        id: 'cycle-fact-a',
        subjectId: 'cycle-entity',
        predicate: 'cycle_a',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'cycle/b-implies-a', version: '1' },
      premises: [{ kind: 'fact', id: 'cycle-fact-b' }],
      access,
      expectedRevision: (await right.snapshot({ access })).snapshotRevision,
    })
    const downstream = await right.deriveFact({
      conclusion: {
        id: 'cycle-downstream-fact',
        subjectId: 'cycle-entity',
        predicate: 'cycle_downstream',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'cycle/a-implies-downstream', version: '1' },
      premises: [{ kind: 'fact', id: 'cycle-fact-a' }],
      access,
      expectedRevision: (await right.snapshot({ access })).snapshotRevision,
    })
    await left.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'cycle-left-head' },
    )
    await right.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'cycle-right-head' },
    )

    const report = await left.syncFrom(
      right,
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'cycle-merge' },
    )
    expect(report).toMatchObject({ state: 'conflicts', conflicts: 2 })
    const conflicts = await left.syncConflicts({ sessionId: report.sessionId, access })
    expect(conflicts.conflicts).toHaveLength(2)
    expect(conflicts.conflicts.every((conflict) => conflict.reason === 'invalid_combination')).toBe(
      true,
    )

    const resolved = await left.resolveSync({
      sessionId: report.sessionId,
      access,
      confirmSpaceId: 'sync-space',
      resolutions: conflicts.conflicts.map((conflict) => ({
        key: conflict.key,
        choice: 'local',
      })),
    })
    expect(resolved.state).toBe('succeeded')
    await expect(left.getFact('cycle-downstream-fact', access)).resolves.toMatchObject({
      status: 'active',
    })
    await expect(left.getDerivation(downstream.derivation.id, access)).resolves.toMatchObject({
      state: 'active',
    })
    expect(await left.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })
  })

  it('refuses to silently union incompatible cardinality-one facts from separate branches', async () => {
    const left = replica('cardinality-left', WORK_ONTOLOGY)
    const right = replica('cardinality-right', WORK_ONTOLOGY)
    await left.open({ create: true })
    await right.open({ create: true })
    await left.remember({
      id: 'employment-identities',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice, Acme, and Globex exist.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          { id: 'alice', name: 'Alice', types: ['Person'] },
          { id: 'acme', name: 'Acme', types: ['Company'] },
          { id: 'globex', name: 'Globex', types: ['Company'] },
        ],
      },
    })
    await left.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'cardinality-base' },
    )
    await right.syncFrom(
      left,
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'cardinality-clone' },
    )
    await left.remember({
      id: 'left-employment-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice works at Acme.' },
      source: { kind: 'fixture' },
      assertions: {
        facts: [
          {
            id: 'left-employment',
            subject: { id: 'alice' },
            predicate: 'works_at',
            object: { id: 'acme' },
            type: 'Employment',
          },
        ],
      },
    })
    await right.remember({
      id: 'right-employment-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice works at Globex.' },
      source: { kind: 'fixture' },
      assertions: {
        facts: [
          {
            id: 'right-employment',
            subject: { id: 'alice' },
            predicate: 'works_at',
            object: { id: 'globex' },
            type: 'Employment',
          },
        ],
      },
    })
    await left.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'cardinality-left-head' },
    )
    await right.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'cardinality-right-head' },
    )

    const report = await left.syncFrom(
      right,
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'cardinality-merge' },
    )
    expect(report).toMatchObject({ state: 'conflicts', conflicts: 2 })
    const conflicts = await left.syncConflicts({ sessionId: report.sessionId, access })
    expect(conflicts.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'fact',
          id: 'left-employment',
          reason: 'invalid_combination',
        }),
        expect.objectContaining({
          kind: 'fact',
          id: 'right-employment',
          reason: 'invalid_combination',
        }),
      ]),
    )
    expect(await left.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })
  })

  it('resumes an interrupted multi-chunk transfer without replaying accepted chunks', async () => {
    const source = replica('resume-source')
    const target = replica('resume-target')
    await source.open({ create: true })
    await target.open({ create: true })
    for (let index = 0; index < 6; index += 1) {
      await source.remember({
        id: `large-${index}`,
        kind: 'text',
        content: { type: 'text', text: `${index}:${'x'.repeat(20_000)}` },
        source: { kind: 'fixture' },
      })
    }
    const checkpoint = await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space', maxChunkBytes: 64 * 1024 },
      { operationId: 'resume-checkpoint' },
    )
    expect(checkpoint.chunkCount).toBeGreaterThan(1)
    const receiveLimits = {
      maxBytes: checkpoint.byteLength + 1,
      maxRecords: checkpoint.recordCount + 1,
      maxChunks: checkpoint.chunkCount + 1,
    }
    const requested: number[] = []
    let interrupted = false
    const peer: MemorySyncPeer = {
      syncHead: (...args) => source.syncHead(...args),
      syncCheckpoint: (...args) => source.syncCheckpoint(...args),
      syncChunks: async (request, options) => {
        requested.push(request.startIndex ?? 0)
        if (!interrupted && (request.startIndex ?? 0) === 1) {
          interrupted = true
          throw new Error('transport disconnected')
        }
        return source.syncChunks(request, options)
      },
    }

    await expect(
      target.syncFrom(
        peer,
        { access, confirmSpaceId: 'sync-space', receiveLimits },
        { operationId: 'resumable-pull' },
      ),
    ).rejects.toThrow('transport disconnected')
    await expect(
      target.syncFrom(
        peer,
        {
          access,
          confirmSpaceId: 'sync-space',
          receiveLimits: { ...receiveLimits, maxBytes: receiveLimits.maxBytes + 1 },
        },
        { operationId: 'resumable-pull' },
      ),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'idempotency_conflict'))
    await remember(source, 'later-source-head', 'later-source-entity')
    await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'advanced-source-checkpoint' },
    )
    const resumed = await target.syncFrom(
      peer,
      { access, confirmSpaceId: 'sync-space', receiveLimits },
      { operationId: 'resumable-pull' },
    )

    expect(resumed.state).toBe('succeeded')
    expect(resumed.remoteHead).toBe(checkpoint.id)
    expect(requested.filter((index) => index === 0)).toHaveLength(1)
    expect(requested.filter((index) => index === 1)).toHaveLength(2)
    expect(await target.stats()).toMatchObject({ episodes: 6 })
    await expect(target.getEpisode('later-source-head', access)).resolves.toBeNull()
  })

  it('rejects partial, duplicated, and forged chunk/index commit packs before storage', async () => {
    const storage = createInMemoryStorage({ name: 'sync-commit-pack' })
    const memory = replica('sync-commit-pack', OPEN_ONTOLOGY, storage)
    await memory.open({ create: true })
    await remember(memory, 'sync-commit-pack-episode', 'sync-commit-pack-entity')
    await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'sync-commit-pack-checkpoint' },
    )
    const driver = storageDriver(storage)
    const [chunk] = await driver.query({
      kind: 'sync_chunk',
      spaceId: 'sync-space',
      order: [{ field: 'id', direction: 'asc' }],
      limit: 1,
    })
    if (chunk === undefined) throw new Error('sync commit-pack fixture is missing its chunk')
    const indexes = await driver.query({
      kind: 'sync_index',
      spaceId: 'sync-space',
      filters: [
        { field: 'ownerId', op: 'eq', value: chunk.ownerId },
        { field: 'chunkIndex', op: 'eq', value: chunk.index },
      ],
    })
    if (indexes.length !== chunk.records.length || indexes.length === 0) {
      throw new Error('sync commit-pack fixture is missing its indexes')
    }

    await expect(
      validateStoredSyncMetadataPuts('sync-space', [chunk, ...indexes]),
    ).resolves.toBeUndefined()
    await expect(
      validateStoredSyncMetadataPuts('sync-space', [chunk, ...indexes.slice(1)]),
    ).rejects.toMatchObject({ code: 'integrity_failed' })
    await expect(validateStoredSyncMetadataPuts('sync-space', [indexes[0]!])).rejects.toMatchObject(
      { code: 'integrity_failed' },
    )
    await expect(
      validateStoredSyncMetadataPuts('sync-space', [chunk, ...indexes, indexes[0]!]),
    ).rejects.toMatchObject({ code: 'integrity_failed' })
    await expect(
      validateStoredSyncMetadataPuts('sync-space', [
        { ...chunk, digest: '0'.repeat(64) },
        ...indexes,
      ]),
    ).rejects.toMatchObject({ code: 'integrity_failed' })
    await expect(
      validateStoredSyncMetadataPuts('sync-space', [
        chunk,
        { ...indexes[0]!, scopeHash: 'forged-scope-hash' },
        ...indexes.slice(1),
      ]),
    ).rejects.toMatchObject({ code: 'integrity_failed' })
  })

  it('aborts staging and removes partial receiver chunks and indexes', async () => {
    const source = replica('abort-staging-source')
    const targetStorage = createInMemoryStorage({ name: 'abort-staging-target' })
    const target = createMemory({
      spaceId: 'sync-space',
      storage: targetStorage,
      ontology: OPEN_ONTOLOGY,
      now: () => new Date('2026-08-03T10:00:00.000Z'),
    })
    await source.open({ create: true })
    await target.open({ create: true })
    for (let index = 0; index < 4; index += 1) {
      await source.remember({
        id: `abort-staging-${index}`,
        kind: 'text',
        content: { type: 'text', text: `${index}:${'x'.repeat(20_000)}` },
        source: { kind: 'fixture' },
      })
    }
    await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space', maxChunkBytes: 64 * 1024 },
      { operationId: 'abort-staging-head' },
    )
    const peer: MemorySyncPeer = {
      syncHead: (...args) => source.syncHead(...args),
      syncCheckpoint: (...args) => source.syncCheckpoint(...args),
      syncChunks: async (request, options) => {
        if ((request.startIndex ?? 0) === 1) throw new Error('stop after first chunk')
        return source.syncChunks(request, options)
      },
    }

    await expect(
      target.syncFrom(peer, {
        sessionId: 'abort-staging-session',
        access,
        confirmSpaceId: 'sync-space',
      }),
    ).rejects.toThrow('stop after first chunk')
    const driver = storageDriver(targetStorage)
    expect(await driver.query({ kind: 'sync_chunk', spaceId: 'sync-space' })).toHaveLength(1)
    const stagedIndexes = await driver.query({ kind: 'sync_index', spaceId: 'sync-space' })
    expect(stagedIndexes.length).toBeGreaterThan(0)
    const stagedIndex = stagedIndexes[0]!
    const stagedSpace = await driver.getSpace('sync-space')
    if (stagedSpace === null) throw new Error('staged sync index space is missing')
    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: stagedSpace.revision,
      metadataOnly: true,
      puts: [
        {
          ...stagedIndex,
          targetId: 'forged-index-target',
        },
      ],
    })
    expect(await target.verifyIntegrity()).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_sync_index_set' })]),
    })
    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: stagedSpace.revision,
      metadataOnly: true,
      puts: [stagedIndex],
    })
    expect(await target.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })

    await expect(
      target.abortSync({
        sessionId: 'abort-staging-session',
        access,
        confirmSpaceId: 'sync-space',
      }),
    ).resolves.toMatchObject({ state: 'aborted' })
    expect(await driver.query({ kind: 'sync_chunk', spaceId: 'sync-space' })).toEqual([])
    expect(await driver.query({ kind: 'sync_index', spaceId: 'sync-space' })).toEqual([])
  })

  it('rejects a self-consistent sync pack with no checkpoint or session owner', async () => {
    const storage = createInMemoryStorage({ name: 'orphan-sync-owner' })
    const memory = replica('orphan-sync-owner', OPEN_ONTOLOGY, storage)
    await memory.open({ create: true })
    await remember(memory, 'orphan-owner-episode', 'orphan-owner-entity')
    await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'orphan-owner-head' },
    )
    const driver = storageDriver(storage)
    const [sourceChunk] = await driver.query({
      kind: 'sync_chunk',
      spaceId: 'sync-space',
      order: [{ field: 'id', direction: 'asc' }],
      limit: 1,
    })
    const space = await driver.getSpace('sync-space')
    if (sourceChunk === undefined || space === null) {
      throw new Error('orphan owner fixture is missing its source pack')
    }
    const ownerId = 'unreferenced_sync_owner'
    const orphanChunk = {
      ...sourceChunk,
      id: `sync_chunk_${ownerId}_${sourceChunk.index.toString().padStart(12, '0')}`,
      ownerId,
    }
    const orphanIndexes = await Promise.all(
      orphanChunk.records.map((record) =>
        storedSyncIndex('sync-space', ownerId, orphanChunk.index, record),
      ),
    )
    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: space.revision,
      metadataOnly: true,
      puts: [orphanChunk, ...orphanIndexes],
    })

    expect(await memory.verifyIntegrity()).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'orphan_sync_owner' })]),
    })

    await driver.commit({
      spaceId: 'sync-space',
      expectedRevision: space.revision,
      metadataOnly: true,
      deletes: [
        ...orphanIndexes.map((index) => ({ kind: 'sync_index' as const, id: index.id })),
        { kind: 'sync_chunk', id: orphanChunk.id },
      ],
    })
    expect(await memory.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })
  })

  it('rejects a tampered chunk before any logical record is applied', async () => {
    const source = replica('tamper-source')
    const target = replica('tamper-target')
    await source.open({ create: true })
    await target.open({ create: true })
    await remember(source, 'tamper-episode', 'tamper-entity')
    await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'tamper-checkpoint' },
    )
    const peer: MemorySyncPeer = {
      syncHead: (...args) => source.syncHead(...args),
      syncCheckpoint: (...args) => source.syncCheckpoint(...args),
      syncChunks: async (request, options) => {
        const page = await source.syncChunks(request, options)
        return {
          ...page,
          chunks: page.chunks.map((chunk, index) =>
            index === 0 ? { ...chunk, digest: '0'.repeat(64) } : chunk,
          ),
        }
      },
    }

    await expect(
      target.syncFrom(peer, {
        access,
        confirmSpaceId: 'sync-space',
        sessionId: 'tampered-session',
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'import_invalid'))
    expect(await target.stats()).toMatchObject({ episodes: 0, entities: 0, facts: 0 })
    expect(await target.syncStatus('tampered-session', access)).toMatchObject({
      state: 'receiving',
      appliedRecords: 0,
      resumable: true,
    })
  })

  it('invalidates every local checkpoint pack during hard purge', async () => {
    const memory = replica('purge-source')
    await memory.open({ create: true })
    await remember(memory, 'private-episode', 'private-entity')
    const old = await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'before-purge' },
    )

    await memory.hardPurge(
      { access, episodeIds: ['private-episode'] },
      { operationId: 'caller-controlled-private-purge-id' },
    )

    await expect(memory.syncCheckpoint(old.id, access)).resolves.toBeNull()
    await expect(memory.syncChunks({ access, checkpointId: old.id })).rejects.toSatisfy(
      (error: unknown) => MemoryError.is(error, 'not_found'),
    )
    expect((await memory.syncHead(access)).parents).toEqual([])
    const afterPurge = await memory.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'after-purge' },
    )
    const page = await memory.syncChunks({
      access,
      checkpointId: afterPurge.id,
      limit: 64,
    })
    const tombstone = page.chunks
      .flatMap((chunk) => chunk.records)
      .find((record) => record.kind === 'purge')!
    expect(tombstone.value).toMatchObject({ targets: [], state: 'succeeded' })
    expect(tombstone.value).not.toHaveProperty('operationId')
  })

  it('lets hard-purge tombstones dominate concurrent remote additions', async () => {
    const leftStorage = createInMemoryStorage({ name: 'purge-left' })
    const left = replica('purge-left', OPEN_ONTOLOGY, leftStorage)
    const right = replica('purge-right')
    await left.open({ create: true })
    await right.open({ create: true })
    await remember(left, 'erased', 'retained-entity')
    await left.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'purge-base' },
    )
    await right.syncFrom(
      left,
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'purge-clone' },
    )

    await left.hardPurge({ access, episodeIds: ['erased'] })
    const rightRevision = (await right.snapshot({ access })).snapshotRevision
    await right.putSignals({
      access,
      expectedRevision: rightRevision,
      signals: [
        {
          namespace: 'remote-only',
          slot: 'state',
          target: { kind: 'episode', id: 'erased' },
          producer: { kind: 'manual', id: 'remote', version: '1' },
          scopes: [],
          value: { resurrect: true },
        },
      ],
    })
    await left.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'purged-head' },
    )
    await right.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'remote-head' },
    )

    const leftDriver = storageDriver(leftStorage)
    const originalCommit = leftDriver.commit.bind(leftDriver)
    const credential = 'forged-tombstone-secret'
    let cleanTombstones: StoredRecord[] = []
    let contaminated = false
    const commit = vi.spyOn(leftDriver, 'commit')
    commit.mockImplementation(async (change) => {
      const tombstones = (change.puts ?? []).filter(
        (record) => record.kindRecord === 'sync_tombstone',
      )
      if (!contaminated && tombstones.length > 0) {
        contaminated = true
        cleanTombstones = structuredClone(tombstones)
        return originalCommit({
          ...change,
          puts: (change.puts ?? []).map((record) =>
            record.kindRecord === 'sync_tombstone'
              ? ({ ...record, diagnosticPayload: { credential } } as unknown as StoredRecord)
              : record,
          ),
        })
      }
      return originalCommit(change)
    })
    const corruptedError = await left
      .syncFrom(right, { access, confirmSpaceId: 'sync-space' }, { operationId: 'purge-reconcile' })
      .then(
        () => undefined,
        (error: unknown) => error,
      )
    commit.mockRestore()
    expect(MemoryError.is(corruptedError, 'integrity_failed')).toBe(true)
    expect(stableStringify(corruptedError as unknown as JsonValue)).not.toContain(credential)
    expect(await left.verifyIntegrity()).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'invalid_sync_tombstone' })]),
    })
    const currentSpace = await leftDriver.getSpace('sync-space')
    if (currentSpace === null || cleanTombstones.length === 0) {
      throw new Error('sync tombstone corruption fixture is missing')
    }
    await originalCommit({
      spaceId: 'sync-space',
      expectedRevision: currentSpace.revision,
      metadataOnly: true,
      puts: cleanTombstones,
    })
    expect(await left.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })

    const report = await left.syncFrom(
      right,
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'purge-reconcile' },
    )

    expect(report).toMatchObject({ state: 'succeeded', conflicts: 0 })
    expect(report.purgeDominatedRecords).toBeGreaterThan(0)
    await expect(left.getEpisode('erased', access)).resolves.toBeNull()
    expect((await left.browseSignals({ access, revisionView: 'history' })).signals).toEqual([])
  })

  it('prunes concurrent derived support transitively when its evidence was purged', async () => {
    const left = replica('purge-derived-left')
    const right = replica('purge-derived-right')
    await left.open({ create: true })
    await right.open({ create: true })
    for (const episodeId of ['erased-support', 'retained-support']) {
      await left.remember({
        id: episodeId,
        kind: 'assertion',
        content: { type: 'text', text: `Alice appears in ${episodeId}.` },
        source: { kind: 'fixture' },
        assertions: { entities: [{ id: 'alice', name: 'Alice' }] },
      })
    }
    await left.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'purge-derived-base' },
    )
    await right.syncFrom(
      left,
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'purge-derived-clone' },
    )
    const archive = await right.export({ access, complete: true })
    const erasedEvidence = archive.canonical.evidence.find(
      (evidence) =>
        evidence.episodeId === 'erased-support' &&
        evidence.target.kind === 'entity' &&
        evidence.target.id === 'alice',
    )!
    const derived = await right.deriveFact({
      conclusion: {
        id: 'purge-derived-fact',
        subjectId: 'alice',
        predicate: 'concurrent_derived',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'rules/concurrent-evidence', version: '1' },
      premises: [{ kind: 'evidence', id: erasedEvidence.id }],
      access,
      expectedRevision: (await right.snapshot({ access })).snapshotRevision,
    })
    await left.hardPurge({ access, episodeIds: ['erased-support'] })
    await left.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'purge-derived-left-head' },
    )
    await right.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'purge-derived-right-head' },
    )

    const report = await left.syncFrom(
      right,
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'purge-derived-reconcile' },
    )
    expect(report).toMatchObject({ state: 'succeeded', conflicts: 0 })
    expect(report.purgeDominatedRecords).toBeGreaterThanOrEqual(2)
    await expect(left.getFact('purge-derived-fact', access)).resolves.toBeNull()
    await expect(left.getDerivation(derived.derivation.id, access)).resolves.toBeNull()
    await expect(left.getEntity('alice', access)).resolves.toMatchObject({ id: 'alice' })
  })

  it('keeps partial apply fail-closed and rolls back from the retained local checkpoint', async () => {
    const source = replica('rollback-source')
    const targetStorage = createInMemoryStorage({ name: 'rollback-target' })
    const target = createMemory({
      spaceId: 'sync-space',
      storage: targetStorage,
      ontology: OPEN_ONTOLOGY,
      now: () => new Date('2026-08-03T10:00:00.000Z'),
      createId: () => 'rollback-id',
    })
    await source.open({ create: true })
    await target.open({ create: true })
    await remember(source, 'rollback-episode', 'rollback-entity')
    await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'rollback-source-head' },
    )
    const driver = storageDriver(targetStorage)
    const originalCommit = driver.commit.bind(driver)
    let logicalSyncCommits = 0
    const commit = vi.spyOn(driver, 'commit')
    commit.mockImplementation(async (change) => {
      if (
        change.metadataOnly !== true &&
        change.semanticChange?.operationKind === 'sync' &&
        ++logicalSyncCommits === 2
      ) {
        throw new Error('simulated storage interruption')
      }
      return originalCommit(change)
    })

    await expect(
      target.syncFrom(source, {
        access,
        confirmSpaceId: 'sync-space',
        sessionId: 'rollback-session',
      }),
    ).rejects.toThrow('simulated storage interruption')
    await expect(target.stats()).rejects.toSatisfy((error: unknown) =>
      MemoryError.is(error, 'sync_in_progress'),
    )
    commit.mockRestore()

    const rolledBack = await target.abortSync({
      sessionId: 'rollback-session',
      access,
      confirmSpaceId: 'sync-space',
    })
    expect(rolledBack.state).toBe('aborted')
    expect(await target.stats()).toMatchObject({ episodes: 0, entities: 0 })
  })

  it('refuses rollback across a newly received non-reversible purge and resumes forward', async () => {
    const targetStorage = createInMemoryStorage({ name: 'purge-rollback-target' })
    const target = createMemory({
      spaceId: 'sync-space',
      storage: targetStorage,
      ontology: OPEN_ONTOLOGY,
      now: () => new Date('2026-08-03T10:00:00.000Z'),
      createId: () => 'purge-rollback-target-id',
    })
    const source = replica('purge-rollback-source')
    await target.open({ create: true })
    await source.open({ create: true })
    await remember(target, 'non-reversible-episode', 'non-reversible-entity')
    await target.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'non-reversible-base' },
    )
    await source.syncFrom(
      target,
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'non-reversible-clone' },
    )
    await source.hardPurge({ access, episodeIds: ['non-reversible-episode'] })
    await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'non-reversible-purged-head' },
    )
    const driver = storageDriver(targetStorage)
    const originalCommit = driver.commit.bind(driver)
    let logicalSyncCommits = 0
    const commit = vi.spyOn(driver, 'commit')
    commit.mockImplementation(async (change) => {
      if (
        change.metadataOnly !== true &&
        change.semanticChange?.operationKind === 'sync' &&
        ++logicalSyncCommits === 2
      ) {
        throw new Error('interrupt purge sync apply')
      }
      return originalCommit(change)
    })

    await expect(
      target.syncFrom(source, {
        access,
        confirmSpaceId: 'sync-space',
        sessionId: 'non-reversible-session',
      }),
    ).rejects.toThrow('interrupt purge sync apply')
    commit.mockRestore()
    await expect(
      target.abortSync({
        sessionId: 'non-reversible-session',
        access,
        confirmSpaceId: 'sync-space',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'conflict') && error.details?.requiresResume === true,
    )

    const completed = await target.syncFrom(source, {
      access,
      confirmSpaceId: 'sync-space',
      sessionId: 'non-reversible-session',
    })
    expect(completed.state).toBe('succeeded')
    await expect(target.getEpisode('non-reversible-episode', access)).resolves.toBeNull()
  })

  it('does not resume a sync apply owned by another live facade', async () => {
    const source = replica('live-sync-source')
    const targetStorage = createInMemoryStorage({ name: 'live-sync-target' })
    const createTarget = (): Memory =>
      createMemory({
        spaceId: 'sync-space',
        storage: targetStorage,
        ontology: OPEN_ONTOLOGY,
        now: () => new Date('2026-08-03T10:00:00.000Z'),
        createId: () => 'live-sync-id',
      })
    const first = createTarget()
    const second = createTarget()
    await source.open({ create: true })
    await first.open({ create: true })
    await remember(source, 'live-sync-episode', 'live-sync-entity')
    await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'live-sync-source-head' },
    )
    const driver = storageDriver(targetStorage)
    const originalCommit = driver.commit.bind(driver)
    let notifyPaused = (): void => undefined
    const paused = new Promise<void>((resolve) => {
      notifyPaused = resolve
    })
    let releasePaused = (): void => undefined
    const resumed = new Promise<void>((resolve) => {
      releasePaused = resolve
    })
    let activation: StorageCommit | undefined
    let atomicFinalization = false
    const commit = vi.spyOn(driver, 'commit')
    commit.mockImplementation(async (change: StorageCommit) => {
      const result = await originalCommit(change)
      const operation = change.puts?.find(
        (record): record is StoredOperation =>
          record.kindRecord === 'operation' && record.kind === 'sync',
      )
      const session = change.puts?.find(
        (record): record is StoredSyncSession =>
          record.kindRecord === 'sync_session' && record.id === 'live-sync-session',
      )
      const head = change.puts?.find(
        (record): record is StoredSyncRef =>
          record.kindRecord === 'sync_ref' && record.id === 'head',
      )
      if (
        activation === undefined &&
        operation?.state === 'running' &&
        operation.stage === 'applying' &&
        session?.kindRecord === 'sync_session' &&
        session.state === 'applying'
      ) {
        activation = change
        notifyPaused()
        await resumed
      }
      if (
        operation?.state === 'succeeded' &&
        session?.kindRecord === 'sync_session' &&
        session.state === 'succeeded' &&
        head?.kindRecord === 'sync_ref' &&
        (change.metadataGuards?.length ?? 0) === 2
      ) {
        atomicFinalization = true
      }
      return result
    })
    const pending = first.syncFrom(source, {
      access,
      confirmSpaceId: 'sync-space',
      sessionId: 'live-sync-session',
    })
    try {
      await paused
      expect(activation!.metadataOnly).not.toBe(true)
      expect(activation!.semanticChange).toBeUndefined()
      expect(
        activation!.puts?.filter(
          (record) => record.kindRecord === 'operation' || record.kindRecord === 'sync_session',
        ),
      ).toHaveLength(2)
      await second.open()
      const [running] = await driver.query({
        kind: 'operation',
        spaceId: 'sync-space',
        filters: [
          { field: 'kind', op: 'eq', value: 'sync' },
          { field: 'state', op: 'eq', value: 'running' },
        ],
        limit: 2,
      })
      expect(running).toMatchObject({
        kind: 'sync',
        state: 'running',
        runtimeOwnerId: expect.stringMatching(/^runtime_owner_/u),
      })
      await expect(second.stats()).rejects.toMatchObject({ code: 'sync_in_progress' })
      await expect(
        second.syncFrom(source, {
          access,
          confirmSpaceId: 'sync-space',
          sessionId: 'live-sync-session',
        }),
      ).rejects.toMatchObject({
        code: 'sync_in_progress',
        operationId: running!.id,
      })
    } finally {
      releasePaused()
    }
    await expect(pending).resolves.toMatchObject({ state: 'succeeded', conflicts: 0 })
    expect(atomicFinalization).toBe(true)
    await expect(second.stats()).resolves.toMatchObject({ episodes: 1, entities: 1 })
    commit.mockRestore()
    await Promise.all([first.close(), second.close(), source.close()])
  })

  it('automatically completes a crash-interrupted apply before reopening the replica', async () => {
    const source = replica('recovery-source')
    const targetStorage = createInMemoryStorage({ name: 'recovery-target' })
    const createTarget = (): Memory =>
      createMemory({
        spaceId: 'sync-space',
        storage: targetStorage,
        ontology: OPEN_ONTOLOGY,
        now: () => new Date('2026-08-03T10:00:00.000Z'),
        createId: () => 'recovery-id',
      })
    const target = createTarget()
    await source.open({ create: true })
    await target.open({ create: true })
    await remember(source, 'recovered-episode', 'recovered-entity')
    await source.createSyncCheckpoint(
      { access, confirmSpaceId: 'sync-space' },
      { operationId: 'recovery-source-head' },
    )
    const driver = storageDriver(targetStorage)
    const originalCommit = driver.commit.bind(driver)
    let logicalSyncCommits = 0
    const commit = vi.spyOn(driver, 'commit')
    commit.mockImplementation(async (change) => {
      if (
        change.metadataOnly !== true &&
        change.semanticChange?.operationKind === 'sync' &&
        ++logicalSyncCommits === 2
      ) {
        throw new Error('simulated process crash')
      }
      return originalCommit(change)
    })

    await expect(
      target.syncFrom(source, {
        access,
        confirmSpaceId: 'sync-space',
        sessionId: 'recovery-session',
      }),
    ).rejects.toThrow('simulated process crash')
    commit.mockRestore()
    await target.close()

    const reopened = createTarget()
    await reopened.open()
    expect(await reopened.stats()).toMatchObject({ episodes: 1, entities: 1 })
    expect(await reopened.syncStatus('recovery-session', access)).toMatchObject({
      state: 'succeeded',
    })
    expect(await reopened.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })
  })
})
