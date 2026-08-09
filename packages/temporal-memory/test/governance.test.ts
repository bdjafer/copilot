import { describe, expect, it, vi } from 'vitest'

import { createMemory, MemoryError, type PurgeReport } from '../src/index.ts'
import {
  defineMemoryStorage,
  storageDriver,
  type StorageCommit,
  type StorageDriver,
} from '../src/storage/driver.ts'
import { createInMemoryStorage } from '../src/testing/index.ts'
import { harness, WORK_ONTOLOGY } from './support.ts'

const access = { allowedScopes: [] as string[] }

async function seedEmployment() {
  const { memory, storage } = harness({ ontology: WORK_ONTOLOGY })
  await memory.open({ create: true })
  const first = await memory.remember({
    id: 'ep-1',
    kind: 'assertion',
    content: { type: 'text', text: 'Alice works at Acme.' },
    source: { kind: 'fixture' },
    assertions: {
      entities: [
        { id: 'alice', name: 'Alice', types: ['Person'] },
        { id: 'acme', name: 'Acme', types: ['Company'] },
        { id: 'globex', name: 'Globex', types: ['Company'] },
      ],
      facts: [
        {
          subject: { id: 'alice' },
          predicate: 'works_at',
          object: { id: 'acme' },
          type: 'Employment',
        },
      ],
    },
  })
  return { memory, storage, factId: first.facts.created[0]! }
}

describe('governance and portability', () => {
  it('never rebinds a completed operation id to a different episode', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    const first = {
      id: 'operation-owner',
      kind: 'assertion' as const,
      content: { type: 'text' as const, text: 'The original operation owner.' },
      source: { kind: 'fixture' },
      assertions: { entities: [] },
    }
    await memory.remember(first, { operationId: 'globally-unique-operation' })

    await expect(
      memory.remember(
        {
          id: 'operation-rebinder',
          kind: 'assertion',
          content: { type: 'text', text: 'This must not replace durable operation lineage.' },
          source: { kind: 'fixture' },
          assertions: { entities: [] },
        },
        { operationId: 'globally-unique-operation' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(memory.getEpisode('operation-rebinder', access)).resolves.toBeNull()
    await expect(memory.remember(first)).resolves.toMatchObject({
      operation: { id: 'globally-unique-operation' },
      episode: { id: 'operation-owner' },
    })
    await expect(
      memory.remember(first, { operationId: 'globally-unique-operation' }),
    ).resolves.toMatchObject({
      operation: { id: 'globally-unique-operation' },
      episode: { id: 'operation-owner' },
    })
    await expect(
      memory.remember(first, { operationId: 'unbound-replay-operation' }),
    ).rejects.toMatchObject({
      code: 'idempotency_conflict',
      operationId: 'unbound-replay-operation',
    })
    await expect(memory.operation('unbound-replay-operation')).resolves.toBeNull()
    await expect(memory.operation('globally-unique-operation')).resolves.not.toHaveProperty(
      'bindingId',
    )
    await expect(
      storageDriver(storage).get('operation', 'space-1', 'globally-unique-operation'),
    ).resolves.toMatchObject({
      episodeId: 'operation-owner',
      bindingId: expect.stringMatching(/^operation_binding_[0-9a-f-]{36}$/u),
    })
  })

  it('does not recover a running operation owned by another live facade', async () => {
    const baseStorage = createInMemoryStorage()
    const driver = storageDriver(baseStorage)
    let notifyCanonical = (): void => undefined
    const canonicalReached = new Promise<void>((resolve) => {
      notifyCanonical = resolve
    })
    let releaseCanonical = (): void => undefined
    const canonicalReleased = new Promise<void>((resolve) => {
      releaseCanonical = resolve
    })
    let gated = false
    const guarded = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            const canonical = change.puts?.some(
              (record) =>
                record.kindRecord === 'operation' &&
                record.id === 'live-owner-operation' &&
                record.stage === 'canonical_committed',
            )
            if (canonical && !gated) {
              gated = true
              notifyCanonical()
              await canonicalReleased
            }
            return target.commit(change)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as StorageDriver
    const storage = defineMemoryStorage(guarded)
    const first = createMemory({ spaceId: 'live-owner-space', storage })
    const second = createMemory({ spaceId: 'live-owner-space', storage })
    await first.open({ create: true })
    const pending = first.remember(
      {
        id: 'live-owner-episode',
        kind: 'assertion',
        content: { type: 'text', text: 'A live facade still owns this ingestion.' },
        source: { kind: 'fixture' },
        assertions: {
          entities: [{ id: 'live-owner-entity', name: 'Live owner' }],
          facts: [
            {
              id: 'live-owner-fact',
              subject: { id: 'live-owner-entity' },
              predicate: 'is_live',
              object: { scalar: true },
            },
          ],
        },
      },
      { operationId: 'live-owner-operation' },
    )
    try {
      await canonicalReached
      await second.open()
      await expect(
        driver.get('operation', 'live-owner-space', 'live-owner-operation'),
      ).resolves.toMatchObject({
        state: 'running',
        stage: 'accepted',
        warnings: [],
        runtimeOwnerId: expect.stringMatching(/^runtime_owner_/u),
      })
    } finally {
      releaseCanonical()
    }
    await expect(pending).resolves.toMatchObject({
      operation: { id: 'live-owner-operation', state: 'succeeded', stage: 'completed' },
      facts: { created: ['live-owner-fact'] },
    })
    await expect(first.operation('live-owner-operation')).resolves.not.toHaveProperty(
      'runtimeOwnerId',
    )
    await Promise.all([first.close(), second.close()])
  })

  it('does not resume a hard purge owned by another live facade', async () => {
    const baseStorage = createInMemoryStorage()
    const driver = storageDriver(baseStorage)
    let notifyMarker = (): void => undefined
    const markerReached = new Promise<void>((resolve) => {
      notifyMarker = resolve
    })
    let releaseMarker = (): void => undefined
    const markerReleased = new Promise<void>((resolve) => {
      releaseMarker = resolve
    })
    let gated = false
    const guarded = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            const startsPurge = change.puts?.some(
              (record) => record.kindRecord === 'purge' && record.state === 'running',
            )
            const revision = await target.commit(change)
            if (startsPurge && !gated) {
              gated = true
              notifyMarker()
              await markerReleased
            }
            return revision
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as StorageDriver
    const storage = defineMemoryStorage(guarded)
    const first = createMemory({ spaceId: 'live-purge-space', storage })
    const second = createMemory({ spaceId: 'live-purge-space', storage })
    await first.open({ create: true })
    await first.remember({
      id: 'live-purge-episode',
      kind: 'assertion',
      content: { type: 'text', text: 'This episode is erased by the live purge owner.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'live-purge-entity', name: 'Live purge entity' }] },
    })
    const pending = first.hardPurge(
      { access, episodeIds: ['live-purge-episode'] },
      { operationId: 'live-purge-operation' },
    )
    try {
      await markerReached
      await second.open()
      await expect(
        driver.get('operation', 'live-purge-space', 'live-purge-operation'),
      ).resolves.toMatchObject({
        state: 'running',
        stage: 'purge_marked',
        runtimeOwnerId: expect.stringMatching(/^runtime_owner_/u),
      })
      await expect(second.getEpisode('live-purge-episode', access)).rejects.toMatchObject({
        code: 'purge_in_progress',
        operationId: 'live-purge-operation',
      })
    } finally {
      releaseMarker()
    }
    await expect(pending).resolves.toMatchObject({
      operation: { id: 'live-purge-operation', state: 'succeeded' },
      purged: true,
      affectedEpisodes: ['live-purge-episode'],
    })
    await expect(second.getEpisode('live-purge-episode', access)).resolves.toBeNull()
    await Promise.all([first.close(), second.close()])
  })

  it('AC14 correction changes the current view without rewriting the prior fact', async () => {
    const { memory, factId } = await seedEmployment()

    const report = await memory.correctFact({
      factId,
      access,
      reason: 'User supplied the authoritative employer.',
      replacement: {
        subject: { id: 'alice' },
        predicate: 'works_at',
        object: { id: 'globex' },
        type: 'Employment',
      },
    })

    expect(report.operation.kind).toBe('correct')
    expect(report.affectedFacts).toHaveLength(2)
    await expect(memory.getFact(factId, access)).resolves.toMatchObject({ status: 'superseded' })
    const current = await memory.recall({ query: 'works_at', access })
    expect(current.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          object: { kind: 'entity', entityId: 'globex' },
          status: 'active',
        }),
      ]),
    )
    expect(current.facts.some((fact) => fact.id === factId)).toBe(false)
  })

  it('commits correction evidence, replacement, and supersession as one mutation', async () => {
    const base = createInMemoryStorage()
    const driver = storageDriver(base)
    let failCorrection = true
    const faulting = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            if (
              failCorrection &&
              change.puts?.some(
                (record) => record.kindRecord === 'episode' && record.kind === 'correction',
              )
            ) {
              failCorrection = false
              throw new MemoryError('storage_failed', 'injected atomic correction failure')
            }
            return target.commit(change)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as StorageDriver
    const memory = createMemory({
      spaceId: 'correction-atomicity',
      storage: defineMemoryStorage(faulting),
      ontology: WORK_ONTOLOGY,
    })
    await memory.open({ create: true })
    const seeded = await memory.remember({
      id: 'employment',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice works at Acme.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          { id: 'alice', name: 'Alice', types: ['Person'] },
          { id: 'acme', name: 'Acme', types: ['Company'] },
          { id: 'globex', name: 'Globex', types: ['Company'] },
        ],
        facts: [
          {
            subject: { id: 'alice' },
            predicate: 'works_at',
            object: { id: 'acme' },
            type: 'Employment',
          },
        ],
      },
    })
    const factId = seeded.facts.created[0]!
    const before = await memory.export({ access, complete: true })
    const correction = {
      factId,
      access,
      replacement: {
        subject: { id: 'alice' },
        predicate: 'works_at',
        object: { id: 'globex' },
        type: 'Employment',
      },
    }

    await expect(
      memory.correctFact(correction, { operationId: 'op-atomic-correction' }),
    ).rejects.toMatchObject({ code: 'storage_failed' })
    expect((await memory.export({ access, complete: true })).manifest.digest).toBe(
      before.manifest.digest,
    )
    expect(await memory.getFact(factId, access)).toMatchObject({ status: 'active' })
    expect(
      (await memory.browse({ kind: 'episode', access })).items.map((episode) => episode.kind),
    ).not.toContain('correction')

    const corrected = await memory.correctFact(correction, {
      operationId: 'op-atomic-correction',
    })
    expect(corrected.operation).toMatchObject({ kind: 'correct', state: 'succeeded' })
    expect(await memory.getFact(factId, access)).toMatchObject({ status: 'superseded' })
    expect(
      (await memory.browse({ kind: 'episode', access })).items.map((episode) => episode.kind),
    ).toContain('correction')
    await expect(
      memory.correctFact(correction, { operationId: 'op-atomic-correction' }),
    ).resolves.toEqual(corrected)
    await expect(
      memory.correctFact(
        {
          ...correction,
          replacement: { ...correction.replacement, object: { id: 'acme' } },
        },
        { operationId: 'op-atomic-correction' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })

  it('supports scoped single-source retraction and explicit all-support retraction', async () => {
    const { memory, factId } = await seedEmployment()
    await memory.remember({
      id: 'ep-2',
      kind: 'assertion',
      content: { type: 'text', text: 'A second source says Alice works at Acme.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          { id: 'alice', name: 'Alice', types: ['Person'] },
          { id: 'acme', name: 'Acme', types: ['Company'] },
        ],
        facts: [
          {
            subject: { id: 'alice' },
            predicate: 'works_at',
            object: { id: 'acme' },
            type: 'Employment',
          },
        ],
      },
    })

    await memory.retractFact({ factId, episodeId: 'ep-1', access })
    expect((await memory.getFact(factId, access))?.evidence.map((item) => item.episodeId)).toEqual([
      'ep-2',
    ])
    await memory.retractFact({ factId, allSupport: true, access })
    expect(await memory.getFact(factId, access)).toBeNull()
    const history = await memory.recall({
      anchors: { factIds: [factId] },
      access,
      view: { kind: 'history' },
      channels: { exact: true, lexical: false, semantic: false, graph: false, temporal: false },
    })
    expect(history.facts[0]).toMatchObject({ id: factId, status: 'retracted' })
  })

  it('AC15 reassesses shared support as source episodes are deleted', async () => {
    const { memory, factId } = await seedEmployment()
    await memory.remember({
      id: 'ep-2',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice works at Acme, independently confirmed.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          { id: 'alice', name: 'Alice', types: ['Person'] },
          { id: 'acme', name: 'Acme', types: ['Company'] },
        ],
        facts: [
          {
            subject: { id: 'alice' },
            predicate: 'works_at',
            object: { id: 'acme' },
            type: 'Employment',
          },
        ],
      },
    })

    const first = await memory.deleteEpisode({ episodeId: 'ep-1', access })
    expect(first.retainedFacts).toContain(factId)
    expect((await memory.getFact(factId, access))?.evidence.map((item) => item.episodeId)).toEqual([
      'ep-2',
    ])

    const second = await memory.deleteEpisode({ episodeId: 'ep-2', access })
    expect(second.unsupportedFacts).toContain(factId)
    expect(await memory.getFact(factId, access)).toBeNull()
  })

  it('records reversible entity merges without destroying source identity', async () => {
    const { memory, factId } = await seedEmployment()

    const merged = await memory.mergeEntities({
      targetId: 'globex',
      sourceIds: ['acme'],
      reason: 'fixture merge',
      access,
    })
    expect(merged.operation.kind).toBe('merge')
    expect(await memory.getEntity('acme', access)).toMatchObject({ mergedInto: 'globex' })
    expect(
      (
        await memory.recall({
          anchors: { factIds: [factId] },
          access,
          channels: { exact: true, lexical: false, graph: true, temporal: false },
        })
      ).facts[0]?.object,
    ).toEqual({ kind: 'entity', entityId: 'globex' })

    const split = await memory.splitEntityMerge({
      mergeId: merged.operation.id.replace('op_', 'merge_'),
      access,
    })
    expect(split.operation.kind).toBe('split')
    expect(await memory.getEntity('acme', access)).not.toMatchObject({ mergedInto: 'globex' })
    expect(
      (
        await memory.recall({
          anchors: { factIds: [factId] },
          access,
          channels: { exact: true, lexical: false, graph: true, temporal: false },
        })
      ).facts[0]?.object,
    ).toEqual({ kind: 'entity', entityId: 'acme' })
  })

  it('plans merge and split from a bounded indexed entity closure', async () => {
    const { memory, storage } = await seedEmployment()
    await memory.remember({
      id: 'merge-unrelated-corpus',
      kind: 'assertion',
      content: { type: 'text', text: 'A broad corpus unrelated to the merged identities.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'merge-unrelated-entity', name: 'Unrelated' }],
        facts: Array.from({ length: 256 }, (_, index) => ({
          id: `merge-unrelated-${index.toString().padStart(4, '0')}`,
          subject: { id: 'merge-unrelated-entity' },
          predicate: `unrelated_${index.toString().padStart(4, '0')}`,
          object: { scalar: index },
        })),
      },
    })
    const driver = storageDriver(storage)
    const originalQuery = driver.query.bind(driver)
    const query = vi
      .spyOn(driver, 'query')
      .mockImplementation(((request) => originalQuery(request)) as StorageDriver['query'])
    const exportRecords = vi
      .spyOn(driver, 'exportRecords')
      .mockRejectedValue(new Error('entity governance must remain indexed'))
    const beforeRevision = (await driver.getSpace('space-1'))!.revision

    await expect(
      memory.mergeEntities(
        {
          targetId: 'globex',
          sourceIds: ['acme'],
          access,
          workLimits: { maxRecords: 1 },
        },
        { operationId: 'bounded-merge-admission' },
      ),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: { phase: 'derivation', dimension: 'records', required: 2, maximum: 1 },
    })
    await expect(driver.getSpace('space-1')).resolves.toMatchObject({ revision: beforeRevision })
    await expect(driver.query({ kind: 'merge', spaceId: 'space-1' })).resolves.toEqual([])
    await expect(driver.get('entity', 'space-1', 'acme')).resolves.not.toHaveProperty('mergedInto')

    query.mockClear()
    const merged = await memory.mergeEntities(
      {
        targetId: 'globex',
        sourceIds: ['acme'],
        access,
        workLimits: { maxRecords: 64 },
      },
      { operationId: 'bounded-merge' },
    )
    expect(merged).toMatchObject({
      affectedEntities: ['globex', 'acme'],
      work: {
        graphNodes: 0,
        graphEdges: 0,
        limits: { maxRecords: 64 },
      },
    })
    expect(merged.work.records).toBeGreaterThan(0)
    expect(merged.work.records).toBeLessThanOrEqual(64)
    expect(merged.work.bytes).toBeGreaterThan(0)
    expect(exportRecords).not.toHaveBeenCalled()

    const scans = query.mock.calls
      .map(([request]) => request)
      .filter((request) => ['alias', 'evidence', 'fact', 'projection'].includes(request.kind))
    expect(scans.length).toBeGreaterThan(0)
    expect(
      scans.every(
        (request) =>
          request.limit === 16 &&
          request.order?.length === 1 &&
          request.order[0]?.field === 'id' &&
          request.order[0]?.direction === 'asc',
      ),
    ).toBe(true)
    expect(
      scans.some(
        (request) =>
          request.kind === 'alias' &&
          request.filters?.some((filter) => filter.field === 'entityId' && filter.op === 'in'),
      ),
    ).toBe(true)
    for (const field of ['subjectId', 'object.entityId']) {
      expect(
        scans.some(
          (request) =>
            request.kind === 'fact' &&
            request.filters?.some((filter) => filter.field === field && filter.op === 'in'),
        ),
      ).toBe(true)
    }
    expect(
      scans
        .filter((request) => ['alias', 'evidence', 'fact'].includes(request.kind))
        .every((request) => (request.filters?.length ?? 0) > 0),
    ).toBe(true)

    const mergeId = merged.operation.id.replace(/^op_/, 'merge_')
    const beforeSplitRevision = (await driver.getSpace('space-1'))!.revision
    await expect(
      memory.splitEntityMerge(
        {
          mergeId,
          access,
          workLimits: { maxRecords: 1 },
        },
        { operationId: 'bounded-merge-split-admission' },
      ),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: { phase: 'derivation', dimension: 'records', required: 2, maximum: 1 },
    })
    await expect(driver.getSpace('space-1')).resolves.toMatchObject({
      revision: beforeSplitRevision,
    })
    await expect(driver.get('merge', 'space-1', mergeId)).resolves.toMatchObject({ active: true })
    await expect(driver.get('entity', 'space-1', 'acme')).resolves.toMatchObject({
      mergedInto: 'globex',
    })

    query.mockClear()
    const split = await memory.splitEntityMerge(
      {
        mergeId,
        access,
        workLimits: { maxRecords: 64 },
      },
      { operationId: 'bounded-merge-split' },
    )
    expect(split).toMatchObject({
      affectedEntities: ['globex', 'acme'],
      work: {
        graphNodes: 0,
        graphEdges: 0,
        limits: { maxRecords: 64 },
      },
    })
    expect(split.work.records).toBeGreaterThan(0)
    expect(split.work.records).toBeLessThanOrEqual(64)
    expect(split.work.bytes).toBeGreaterThan(0)
    expect(exportRecords).not.toHaveBeenCalled()
    expect(
      query.mock.calls
        .map(([request]) => request)
        .filter((request) => ['alias', 'evidence', 'fact', 'projection'].includes(request.kind))
        .every((request) => request.limit === 16),
    ).toBe(true)

    await expect(
      memory.mergeEntities({
        targetId: 'globex',
        sourceIds: ['acme'],
        access,
        workLimit: { maxRecords: 1 },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      memory.splitEntityMerge({
        mergeId,
        access,
        workLimit: { maxRecords: 1 },
      } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    query.mockRestore()
    exportRecords.mockRestore()
  })

  it('never replays a stale merge plan after another facade hard-purges its source', async () => {
    const base = createInMemoryStorage()
    const driver = storageDriver(base)
    const peerRef: { current?: ReturnType<typeof createMemory> } = {}
    let injectedPurge = false
    const racing = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            if (!injectedPurge && change.puts?.some((record) => record.kindRecord === 'merge')) {
              injectedPurge = true
              await peerRef.current!.hardPurge(
                { access, entityIds: ['acme'] },
                { operationId: 'purge-racing-merge' },
              )
            }
            return target.commit(change)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as StorageDriver
    const storage = defineMemoryStorage(racing)
    const memory = createMemory({ spaceId: 'merge-purge-race', storage, ontology: WORK_ONTOLOGY })
    peerRef.current = createMemory({
      spaceId: 'merge-purge-race',
      storage,
      ontology: WORK_ONTOLOGY,
    })
    await memory.open({ create: true })
    await peerRef.current.open()
    await memory.remember({
      id: 'merge-purge-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Acme and Globex are companies.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          { id: 'acme', name: 'Acme', types: ['Company'] },
          { id: 'globex', name: 'Globex', types: ['Company'] },
        ],
      },
    })

    await expect(
      memory.mergeEntities(
        { targetId: 'globex', sourceIds: ['acme'], access },
        { operationId: 'merge-racing-purge' },
      ),
    ).rejects.toMatchObject({ code: 'conflict', retryable: true })
    expect(injectedPurge).toBe(true)
    await expect(racing.get('entity', 'merge-purge-race', 'acme')).resolves.toBeNull()
    await expect(racing.query({ kind: 'merge', spaceId: 'merge-purge-race' })).resolves.toEqual([])
  })

  it('does not recreate canonical or projection data when purge wins episode processing', async () => {
    for (const racePhase of ['canonical', 'projection'] as const) {
      const base = createInMemoryStorage()
      const driver = storageDriver(base)
      const spaceId = `processing-purge-${racePhase}`
      const episodeId = `${racePhase}-episode`
      const peerRef: { current?: ReturnType<typeof createMemory> } = {}
      let injectedPurge = false
      const racing = new Proxy(driver, {
        get(target, property, receiver) {
          if (property === 'commit') {
            return async (change: StorageCommit) => {
              const isRaceCommit =
                racePhase === 'canonical'
                  ? change.semanticChange?.phase === 'canonical'
                  : change.puts?.some((record) => record.kindRecord === 'projection') === true
              if (!injectedPurge && isRaceCommit) {
                injectedPurge = true
                await peerRef.current!.hardPurge(
                  { access, episodeIds: [episodeId] },
                  { operationId: `purge-racing-${racePhase}` },
                )
              }
              return target.commit(change)
            }
          }
          const value = Reflect.get(target, property, receiver) as unknown
          return typeof value === 'function' ? value.bind(target) : value
        },
      }) as StorageDriver
      const storage = defineMemoryStorage(racing)
      const memory = createMemory({ spaceId, storage })
      peerRef.current = createMemory({ spaceId, storage })
      await memory.open({ create: true })
      await peerRef.current.open()

      const processingOperationId = `processing-op-${racePhase}`
      await expect(
        memory.remember(
          {
            id: episodeId,
            kind: 'assertion',
            content: { type: 'text', text: `${racePhase} processing must lose to purge.` },
            source: { kind: 'fixture' },
            assertions: {
              entities: [{ id: `${racePhase}-entity`, name: `${racePhase} entity` }],
            },
          },
          { operationId: processingOperationId },
        ),
      ).rejects.toMatchObject({ code: 'idempotency_conflict' })

      expect(injectedPurge).toBe(true)
      await expect(racing.get('episode', spaceId, episodeId)).resolves.toBeNull()
      await expect(racing.query({ kind: 'evidence', spaceId })).resolves.toEqual([])
      await expect(racing.query({ kind: 'projection', spaceId })).resolves.toEqual([])
      if (racePhase === 'canonical') {
        await expect(racing.get('entity', spaceId, `${racePhase}-entity`)).resolves.toBeNull()
      }
      const tombstone = await racing.get('operation', spaceId, processingOperationId)
      expect(tombstone).toMatchObject({
        diagnosticsState: 'purged',
        stage: 'purged',
        retryable: false,
        warnings: [],
        remoteCalls: [],
      })
      expect(tombstone).not.toHaveProperty('episodeId')
      expect(tombstone).not.toHaveProperty('result')
    }
  })

  it('fails purge selection closed when another facade adds a new dependency first', async () => {
    const base = createInMemoryStorage()
    const driver = storageDriver(base)
    const peerRef: { current?: ReturnType<typeof createMemory> } = {}
    let injectedDependency = false
    const racing = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            if (
              !injectedDependency &&
              change.puts?.some((record) => record.kindRecord === 'purge')
            ) {
              injectedDependency = true
              await peerRef.current!.remember({
                id: 'late-dependency',
                kind: 'assertion',
                content: { type: 'text', text: 'Alice depends on Acme.' },
                source: { kind: 'fixture' },
                assertions: {
                  entities: [
                    { id: 'alice', name: 'Alice' },
                    { id: 'acme', name: 'Acme' },
                  ],
                  facts: [
                    {
                      id: 'late-fact',
                      subject: { id: 'alice' },
                      predicate: 'depends_on',
                      object: { id: 'acme' },
                    },
                  ],
                },
              })
            }
            return target.commit(change)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as StorageDriver
    const storage = defineMemoryStorage(racing)
    const memory = createMemory({ spaceId: 'purge-selection-race', storage })
    peerRef.current = createMemory({ spaceId: 'purge-selection-race', storage })
    await memory.open({ create: true })
    await peerRef.current.open()
    await memory.remember({
      id: 'purge-selection-base',
      kind: 'assertion',
      content: { type: 'text', text: 'Acme exists.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'acme', name: 'Acme' }] },
    })

    await expect(
      memory.hardPurge({ access, entityIds: ['acme'] }, { operationId: 'purge-stale-selection' }),
    ).rejects.toMatchObject({ code: 'conflict', retryable: true })
    expect(injectedDependency).toBe(true)
    await expect(racing.get('entity', 'purge-selection-race', 'acme')).resolves.not.toBeNull()
    await expect(racing.get('fact', 'purge-selection-race', 'late-fact')).resolves.not.toBeNull()
    await expect(racing.query({ kind: 'purge', spaceId: 'purge-selection-race' })).resolves.toEqual(
      [],
    )
    await expect(memory.verifyIntegrity()).resolves.toMatchObject({ ok: true })
  })

  it('AC16 exports, purges, and imports equivalent canonical meaning', async () => {
    const { memory, storage, factId } = await seedEmployment()
    const exported = await memory.export({ access, complete: true })

    const purged = await memory.hardPurge({ access, episodeIds: ['ep-1'] })
    expect(purged.purged).toBe(true)
    expect(await memory.getEpisode('ep-1', access)).toBeNull()

    await expect(
      memory.resetSpace({ confirmSpaceId: 'space-1' }, {
        operationId: 'reset-cannot-bind-operation',
      } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await memory.resetSpace({ confirmSpaceId: 'space-1' })
    const restored = createMemory({ spaceId: 'space-1', storage, ontology: WORK_ONTOLOGY })
    await restored.open({ create: true })
    await expect(
      restored.import(exported, {
        dryRun: true,
        operationId: 'dry-run-cannot-bind-operation',
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const dryRun = await restored.import(exported, { dryRun: true })
    expect(dryRun).toMatchObject({ dryRun: true, valid: true })
    await restored.import(exported)

    expect(await restored.getEpisode('ep-1', access)).toMatchObject({ id: 'ep-1' })
    expect(await restored.getFact(factId, access)).toMatchObject({ predicate: 'works_at' })
    expect((await restored.export({ access, complete: true })).manifest.digest).toBe(
      exported.manifest.digest,
    )
  })

  it('AC17 rebuilds projections without changing canonical export or integrity', async () => {
    const { memory } = await seedEmployment()
    const before = await memory.export({ access, complete: true })

    const rebuilt = await memory.rebuildProjections()
    const integrity = await memory.verifyIntegrity()
    const after = await memory.export({ access, complete: true })

    expect(rebuilt.rebuilt).toBeGreaterThan(0)
    expect(integrity.ok).toBe(true)
    expect(after.manifest.digest).toBe(before.manifest.digest)
  })

  it('removes projections reached through a purged episode while preserving shared canonical data', async () => {
    const { memory, storage, factId } = await seedEmployment()
    await memory.remember({
      id: 'ep-2',
      kind: 'assertion',
      content: { type: 'text', text: 'A second source confirms Alice works at Acme.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          { id: 'alice', name: 'Alice', types: ['Person'] },
          { id: 'acme', name: 'Acme', types: ['Company'] },
        ],
        facts: [
          {
            subject: { id: 'alice' },
            predicate: 'works_at',
            object: { id: 'acme' },
            type: 'Employment',
          },
        ],
      },
    })
    const driver = storageDriver(storage)
    const reachedTargets = new Set([
      'entity\u0000alice',
      'entity\u0000acme',
      'entity\u0000globex',
      `fact\u0000${factId}`,
    ])
    const targetKey = (projection: { target: { kind: string; id: string } }) =>
      `${projection.target.kind}\u0000${projection.target.id}`
    const before = await driver.query({ kind: 'projection', spaceId: 'space-1' })
    for (const target of reachedTargets) {
      expect(before.some((projection) => targetKey(projection) === target)).toBe(true)
    }

    const purged = await memory.hardPurge({ access, episodeIds: ['ep-1'] })

    const after = await driver.query({ kind: 'projection', spaceId: 'space-1' })
    expect(after.filter((projection) => reachedTargets.has(targetKey(projection)))).toEqual([])
    expect(purged.affectedEntities).toEqual(['acme', 'alice', 'globex'])
    expect(purged.affectedFacts).toContain(factId)
    expect(await memory.getFact(factId, access)).toMatchObject({ status: 'active' })
    expect((await memory.getFact(factId, access))?.evidence.map((item) => item.episodeId)).toEqual([
      'ep-2',
    ])
    expect(await memory.getEntity('alice', access)).toMatchObject({ id: 'alice' })
  })

  it('uses alias and mention provenance when soft-deleting episode projections', async () => {
    const { memory, storage } = await seedEmployment()
    const driver = storageDriver(storage)
    const entityEvidence = (
      await driver.query({
        kind: 'evidence',
        spaceId: 'space-1',
        filters: [{ field: 'episodeId', op: 'eq', value: 'ep-1' }],
      })
    ).filter((item) => item.target.kind === 'entity')
    const space = (await driver.getSpace('space-1'))!
    await driver.commit({
      spaceId: 'space-1',
      expectedRevision: space.revision,
      deletes: entityEvidence.map((item) => ({ kind: 'evidence' as const, id: item.id })),
      semanticChange: {
        operationId: 'fixture-strip-entity-evidence',
        operationKind: 'reprocess',
        phase: 'governance',
        partitions: [
          {
            scopes: [],
            affected: {
              episodeIds: ['ep-1'],
              entityIds: [
                ...new Set(
                  entityEvidence
                    .filter((item) => item.target.kind === 'entity')
                    .map((item) => item.target.id),
                ),
              ].sort(),
              factIds: [],
            },
          },
        ],
      },
    })
    expect(
      (await driver.query({ kind: 'projection', spaceId: 'space-1' })).some(
        (projection) => projection.target.kind === 'entity' && projection.target.id === 'globex',
      ),
    ).toBe(true)

    const deleted = await memory.deleteEpisode({ episodeId: 'ep-1', access })

    expect(
      (await driver.query({ kind: 'projection', spaceId: 'space-1' })).filter(
        (projection) => projection.target.kind === 'entity',
      ),
    ).toEqual([])
    expect(deleted.affectedEntities).toEqual(['acme', 'alice', 'globex'])
  })

  it('prevents hard-purged idempotency replay until the space is reset', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    const original = {
      id: 'ep-original',
      idempotencyKey: 'request-once',
      kind: 'assertion' as const,
      content: { type: 'text' as const, text: 'Disposable evidence.' },
      source: { kind: 'fixture' },
      assertions: { entities: [], facts: [] },
    }
    await memory.remember(original)
    const archived = await memory.export({ access, complete: true })

    await memory.hardPurge({ access, episodeIds: [original.id] })

    const [marker] = await storageDriver(storage).query({
      kind: 'purge',
      spaceId: 'space-1',
      filters: [{ field: 'state', op: 'eq', value: 'succeeded' }],
    })
    expect(marker).toMatchObject({ targets: [], idempotencyKeyHashes: [expect.any(String)] })
    expect(marker!.idempotencyKeyHashes![0]).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(marker)).not.toContain(original.idempotencyKey)

    const replay = { ...original, id: 'ep-replay' }
    await expect(memory.remember(replay)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    })
    await expect(memory.import(archived)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    })

    await memory.close()
    const reopened = createMemory({ spaceId: 'space-1', storage })
    await reopened.open()
    await expect(reopened.remember(replay)).rejects.toMatchObject({
      code: 'idempotency_conflict',
    })

    await reopened.resetSpace({ confirmSpaceId: 'space-1' })
    const reset = createMemory({ spaceId: 'space-1', storage })
    await reset.open({ create: true })
    await expect(reset.remember(replay)).resolves.toMatchObject({
      episode: { id: replay.id, idempotencyKey: original.idempotencyKey },
    })
  })

  it('scrubs only contaminated operation diagnostics and seals their tombstones', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    const privateReport = await memory.remember(
      {
        id: 'private-episode',
        kind: 'assertion',
        content: { type: 'text', text: 'Classified operation payload.' },
        source: { kind: 'fixture' },
        assertions: {
          entities: [{ id: 'private-entity', name: 'Private Entity' }],
          facts: [
            {
              subject: { id: 'private-entity' },
              predicate: 'private_value',
              object: { scalar: 'Classified operation payload.' },
            },
          ],
        },
      },
      { operationId: 'private-ingest-operation' },
    )
    await memory.remember(
      {
        id: 'retained-episode',
        kind: 'assertion',
        content: { type: 'text', text: 'Retained operation payload.' },
        source: { kind: 'fixture' },
        assertions: { entities: [{ id: 'retained-entity', name: 'Retained Entity' }] },
      },
      { operationId: 'retained-ingest-operation' },
    )
    const privateFactId = privateReport.facts.created[0]!

    await memory.hardPurge({
      access,
      episodeIds: ['private-episode'],
      entityIds: ['private-entity'],
    })

    const driver = storageDriver(storage)
    const privateOperation = await driver.get('operation', 'space-1', 'private-ingest-operation')
    expect(privateOperation).toMatchObject({
      kind: 'ingest',
      state: 'succeeded',
      diagnosticsState: 'purged',
      stage: 'purged',
      retryable: false,
      warnings: [],
      remoteCalls: [],
    })
    expect(privateOperation).not.toHaveProperty('episodeId')
    expect(privateOperation).not.toHaveProperty('result')
    expect(privateOperation).not.toHaveProperty('error')
    const serialized = JSON.stringify(privateOperation)
    for (const erased of [
      'private-episode',
      'private-entity',
      privateFactId,
      'Classified operation payload.',
    ]) {
      expect(serialized).not.toContain(erased)
    }
    await expect(memory.operation('private-ingest-operation')).resolves.toMatchObject({
      diagnosticsState: 'purged',
      stage: 'purged',
    })
    await expect(
      driver.get('operation', 'space-1', 'retained-ingest-operation'),
    ).resolves.toMatchObject({
      diagnosticsState: 'available',
      episodeId: 'retained-episode',
      result: expect.any(Object),
    })

    await expect(
      memory.remember(
        {
          id: 'replacement-episode',
          kind: 'assertion',
          content: { type: 'text', text: 'Cannot overwrite a purge tombstone.' },
          source: { kind: 'fixture' },
          assertions: { entities: [] },
        },
        { operationId: 'private-ingest-operation' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(memory.getEpisode('replacement-episode', access)).resolves.toBeNull()

    const currentSpace = (await driver.getSpace('space-1'))!
    await driver.commit({
      spaceId: 'space-1',
      expectedRevision: currentSpace.revision,
      puts: [
        {
          ...privateOperation!,
          episodeId: 'private-episode',
          result: { leakedEpisodeId: 'private-episode' },
          warnings: ['restored private diagnostics'],
        },
      ],
    })
    await memory.close()
    const corrupted = harness({ storage }).memory
    await corrupted.open()
    await expect(corrupted.verifyIntegrity()).resolves.toMatchObject({
      ok: false,
      issues: [
        expect.objectContaining({
          code: 'invalid_operation_tombstone',
          severity: 'error',
          record: { kind: 'operation', id: 'private-ingest-operation' },
        }),
      ],
    })
  })

  it('binds purge operationIds to one request without marker-id aliases or tombstone loss', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    const episode = (id: string) => ({
      id,
      idempotencyKey: `key-${id}`,
      kind: 'assertion' as const,
      content: { type: 'text' as const, text: `Disposable ${id}.` },
      source: { kind: 'fixture' },
      assertions: { entities: [], facts: [] },
    })
    for (const id of ['a', 'b', 'c']) await memory.remember(episode(id))

    await memory.hardPurge({ access, episodeIds: ['a'] }, { operationId: 'op_x' })
    const firstMarker = (
      await storageDriver(storage).query({ kind: 'purge', spaceId: 'space-1' })
    ).find((marker) => marker.operationId === 'op_x')!
    const firstHashes = [...(firstMarker.idempotencyKeyHashes ?? [])]

    await memory.hardPurge({ access, episodeIds: ['b'] }, { operationId: 'purge_x' })
    await expect(
      memory.hardPurge({ access, episodeIds: ['c'] }, { operationId: 'op_x' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(
      memory.hardPurge({ access, episodeIds: ['a'] }, { operationId: 'op_x' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })

    const markers = await storageDriver(storage).query({ kind: 'purge', spaceId: 'space-1' })
    const opMarker = markers.find((marker) => marker.operationId === 'op_x')!
    const prefixedMarker = markers.find((marker) => marker.operationId === 'purge_x')!
    expect(opMarker.id).not.toBe(prefixedMarker.id)
    expect(opMarker.id).not.toBe('purge_x')
    expect(opMarker.requestHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(opMarker.idempotencyKeyHashes).toEqual(firstHashes)
    expect(JSON.stringify(opMarker)).not.toContain('key-a')
    expect(await memory.getEpisode('c', access)).toMatchObject({ id: 'c' })
    await expect(memory.remember({ ...episode('a'), id: 'a-replay' })).rejects.toMatchObject({
      code: 'idempotency_conflict',
    })
  })

  it('atomically rejects concurrent reuse of one purge operationId', async () => {
    const storage = createInMemoryStorage()
    const first = createMemory({ spaceId: 'purge-race', storage })
    const second = createMemory({ spaceId: 'purge-race', storage })
    await first.open({ create: true })
    await second.open()
    for (const id of ['left', 'right']) {
      await first.remember({
        id,
        idempotencyKey: `key-${id}`,
        kind: 'assertion',
        content: { type: 'text', text: id },
        source: { kind: 'fixture' },
        assertions: { entities: [], facts: [] },
      })
    }

    const outcomes = await Promise.allSettled([
      first.hardPurge({ access, episodeIds: ['left'] }, { operationId: 'shared-purge' }),
      second.hardPurge({ access, episodeIds: ['right'] }, { operationId: 'shared-purge' }),
    ])

    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<PurgeReport> => outcome.status === 'fulfilled',
    )
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    )
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect(rejected[0]!.reason).toMatchObject({ code: 'idempotency_conflict' })
    const purgedId = fulfilled[0]!.value.affectedEpisodes[0]!
    const retainedId = purgedId === 'left' ? 'right' : 'left'
    expect(await first.getEpisode(purgedId, access)).toBeNull()
    expect(await first.getEpisode(retainedId, access)).toMatchObject({ id: retainedId })
    const markers = await storageDriver(storage).query({
      kind: 'purge',
      spaceId: 'purge-race',
      filters: [{ field: 'state', op: 'eq', value: 'succeeded' }],
    })
    expect(markers).toHaveLength(1)
    expect(markers[0]!.idempotencyKeyHashes).toHaveLength(1)
  })

  it('validates identical collisions and remaps a colliding import as one isolated graph', async () => {
    const { memory } = await seedEmployment()
    const exported = await memory.export({ access, complete: true })

    await expect(memory.import(exported)).rejects.toMatchObject({ code: 'import_invalid' })
    const identical = await memory.import(exported, { collisions: 'identical' })
    expect(identical.collisions.length).toBeGreaterThan(0)

    const remapped = await memory.import(exported, { collisions: 'remap' })
    expect(remapped.remapped).toMatchObject({
      'episode:ep-1': expect.any(String),
      'entity:alice': expect.any(String),
      [`fact:${exported.canonical.facts[0]!.id}`]: expect.any(String),
    })
    expect(await memory.getEpisode(remapped.remapped!['episode:ep-1']!, access)).toMatchObject({
      content: { type: 'text', text: 'Alice works at Acme.' },
    })
    const remappedArchive = await memory.export({
      access,
      episodeIds: [remapped.remapped!['episode:ep-1']!],
    })
    expect(remappedArchive.canonical.episodes[0]!.contentHash).not.toBe(
      exported.canonical.episodes[0]!.contentHash,
    )
    const restored = harness({ ontology: WORK_ONTOLOGY })
    await restored.memory.open({ create: true })
    await expect(restored.memory.import(remappedArchive, { dryRun: true })).resolves.toMatchObject({
      valid: true,
    })
    expect(await memory.verifyIntegrity()).toMatchObject({ ok: true })
  })

  it('resumes an interrupted hard purge before allowing reads after reopen', async () => {
    const base = createInMemoryStorage()
    const driver = storageDriver(base)
    const originalExportRecords = driver.exportRecords.bind(driver)
    let forbidInitialExport = false
    let forbiddenExportCalls = 0
    const exportRecords = vi.spyOn(driver, 'exportRecords').mockImplementation(async (spaceId) => {
      const active = await driver.query({
        kind: 'purge',
        spaceId,
        filters: [{ field: 'state', op: 'in', value: ['pending', 'running'] }],
        limit: 1,
      })
      if (forbidInitialExport || active.length > 0) {
        forbiddenExportCalls += 1
        throw new Error('whole-space export is forbidden during purge')
      }
      return originalExportRecords(spaceId)
    })
    let failCompletion = false
    let failed = false
    const faulting = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            const startsPurge = change.puts?.some(
              (record) => record.kindRecord === 'purge' && record.state === 'running',
            )
            const completesPurge = change.puts?.some(
              (record) => record.kindRecord === 'purge' && record.state === 'succeeded',
            )
            if (completesPurge && failCompletion && !failed) {
              failed = true
              throw new MemoryError('storage_failed', 'injected termination')
            }
            const revision = await target.commit(change)
            if (startsPurge) failCompletion = true
            return revision
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as StorageDriver
    const storage = defineMemoryStorage(faulting)
    const first = createMemory({ spaceId: 'resume-space', storage })
    await first.open({ create: true })
    const seeded = await first.remember(
      {
        id: 'ep-1',
        idempotencyKey: 'disposable-request',
        kind: 'assertion',
        content: { type: 'text', text: 'Disposable evidence.' },
        source: { kind: 'fixture' },
        assertions: {
          entities: [{ id: 'entity-1', name: 'Disposable' }],
          facts: [
            {
              subject: { id: 'entity-1' },
              predicate: 'contains',
              object: { scalar: 'Disposable evidence.' },
            },
          ],
        },
      },
      { operationId: 'interrupted-ingest-operation' },
    )
    const factId = seeded.facts.created[0]!

    forbidInitialExport = true
    await expect(first.hardPurge({ access, episodeIds: ['ep-1'] })).rejects.toMatchObject({
      code: 'storage_failed',
    })
    forbidInitialExport = false
    await expect(first.getEpisode('ep-1', access)).rejects.toMatchObject({
      code: 'purge_in_progress',
    })
    const [runningMarker] = await driver.query({
      kind: 'purge',
      spaceId: 'resume-space',
      filters: [{ field: 'state', op: 'eq', value: 'running' }],
    })
    expect(runningMarker).toMatchObject({
      workLimits: {
        maxRecords: expect.any(Number),
        maxBytes: expect.any(Number),
        maxGraphNodes: expect.any(Number),
        maxGraphEdges: expect.any(Number),
      },
    })
    await first.close()

    const reopened = createMemory({ spaceId: 'resume-space', storage })
    await reopened.open()
    expect(await reopened.getEpisode('ep-1', access)).toBeNull()
    const projections = await driver.query({ kind: 'projection', spaceId: 'resume-space' })
    expect(
      projections.filter(
        (projection) =>
          (projection.target.kind === 'entity' && projection.target.id === 'entity-1') ||
          (projection.target.kind === 'fact' && projection.target.id === factId),
      ),
    ).toEqual([])
    await expect(
      driver.get('operation', 'resume-space', 'interrupted-ingest-operation'),
    ).resolves.toMatchObject({
      diagnosticsState: 'purged',
      stage: 'purged',
      warnings: [],
      remoteCalls: [],
    })
    await expect(
      reopened.remember({
        id: 'ep-replay',
        idempotencyKey: 'disposable-request',
        kind: 'assertion',
        content: { type: 'text', text: 'Disposable evidence.' },
        source: { kind: 'fixture' },
        assertions: { entities: [{ id: 'entity-1', name: 'Disposable' }] },
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    expect((await reopened.inspect()).state).toBe('degraded')
    expect(forbiddenExportCalls).toBe(0)
    exportRecords.mockRestore()
  })

  it('gives concurrent hard-purge recovery exactly one runtime owner', async () => {
    const base = createInMemoryStorage({ name: 'contended-purge-recovery' })
    const driver = storageDriver(base)
    let failFinalCommit = true
    let gateRecoveryClaims = false
    let claimAttempts = 0
    let releaseClaims = (): void => undefined
    const claimsReleased = new Promise<void>((resolve) => {
      releaseClaims = resolve
    })
    let notifyClaimsReached = (): void => undefined
    const claimsReached = new Promise<void>((resolve) => {
      notifyClaimsReached = resolve
    })
    const faulting = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            const completesPurge = change.puts?.some(
              (record) => record.kindRecord === 'purge' && record.state === 'succeeded',
            )
            if (completesPurge && failFinalCommit) {
              failFinalCommit = false
              throw new MemoryError('storage_failed', 'interrupt purge before canonical settlement')
            }
            const recoveryClaim =
              gateRecoveryClaims &&
              change.puts?.some(
                (record) =>
                  record.kindRecord === 'operation' &&
                  record.id === 'contended-purge-operation' &&
                  record.state === 'running' &&
                  record.stage === 'purge_marked',
              ) === true &&
              change.puts?.every((record) => record.kindRecord !== 'purge') === true
            if (recoveryClaim) {
              claimAttempts += 1
              if (claimAttempts === 2) notifyClaimsReached()
              await claimsReleased
            }
            return target.commit(change)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as StorageDriver
    const storage = defineMemoryStorage(faulting)
    const first = createMemory({ spaceId: 'contended-purge-space', storage })
    await first.open({ create: true })
    await first.remember({
      id: 'contended-purge-episode',
      kind: 'text',
      content: { type: 'text', text: 'This record is removed after one recovery claim.' },
      source: { kind: 'fixture' },
    })
    await expect(
      first.hardPurge(
        { access, episodeIds: ['contended-purge-episode'] },
        { operationId: 'contended-purge-operation' },
      ),
    ).rejects.toMatchObject({ code: 'storage_failed' })

    const interruptedSpace = await driver.getSpace('contended-purge-space')
    if (interruptedSpace === null) throw new Error('interrupted purge space is missing')
    const beforeRecoveryRevision = await driver.commit({
      spaceId: 'contended-purge-space',
      expectedRevision: interruptedSpace.revision,
      deletes: [{ kind: 'operation', id: 'contended-purge-operation' }],
    })
    await first.close()

    gateRecoveryClaims = true
    const left = createMemory({ spaceId: 'contended-purge-space', storage })
    const right = createMemory({ spaceId: 'contended-purge-space', storage })
    const opening = Promise.all([left.open(), right.open()])
    await claimsReached
    releaseClaims()
    await opening

    expect(claimAttempts).toBe(2)
    await expect(left.stats()).resolves.toMatchObject({
      snapshotRevision: beforeRecoveryRevision + 2,
      episodes: 0,
    })
    await expect(right.getEpisode('contended-purge-episode', access)).resolves.toBeNull()
    await expect(
      driver.get('operation', 'contended-purge-space', 'contended-purge-operation'),
    ).resolves.toMatchObject({
      state: 'succeeded',
      stage: 'completed',
      attempts: 1,
      runtimeOwnerId: expect.stringMatching(/^runtime_owner_/u),
    })
    const markers = await driver.query({ kind: 'purge', spaceId: 'contended-purge-space' })
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({
      state: 'succeeded',
      targets: [],
      completedTargets: [expect.any(String)],
    })
    expect(markers[0]).not.toHaveProperty('workLimits')
    const purgeChanges = (
      await driver.query({ kind: 'change', spaceId: 'contended-purge-space' })
    ).filter((change) => change.operationId === 'contended-purge-operation')
    expect(purgeChanges).toHaveLength(1)
    await expect(left.verifyIntegrity()).resolves.toMatchObject({ ok: true })
    await Promise.all([left.close(), right.close()])
  })
})
