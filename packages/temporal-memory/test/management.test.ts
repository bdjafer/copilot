import { describe, expect, it, vi } from 'vitest'

import { analyzeStructuralGraph } from '../src/algorithms/graph.ts'
import { MemoryError, type JsonValue } from '../src/index.ts'
import { stableStringify } from '../src/internal/value.ts'
import {
  storageDriver,
  type StorageDriver,
  type StoredOperation,
  type StoredSignal,
} from '../src/storage/driver.ts'
import { harness, WORK_ONTOLOGY } from './support.ts'

const access = { allowedScopes: [] as string[] }
const privateAccess = { allowedScopes: ['private'] }

async function seedGraph() {
  const { memory, storage } = harness()
  await memory.open({ create: true })
  const report = await memory.remember({
    id: 'graph',
    kind: 'assertion',
    content: { type: 'text', text: 'Alpha links to Beta, and Beta links to Gamma.' },
    source: { kind: 'fixture' },
    assertions: {
      entities: [
        { id: 'alpha', name: 'Alpha' },
        { id: 'beta', name: 'Beta' },
        { id: 'gamma', name: 'Gamma' },
      ],
      facts: [
        { subject: { id: 'alpha' }, predicate: 'links_to', object: { id: 'beta' } },
        { subject: { id: 'beta' }, predicate: 'links_to', object: { id: 'gamma' } },
      ],
    },
  })
  return { memory, report, storage }
}

describe('management and analysis APIs', () => {
  it('detaches canonical mutation and maintenance requests before queued work', async () => {
    const { memory } = harness()
    await memory.open({ create: true })

    const rememberInput = {
      id: 'mutation-snapshot',
      kind: 'assertion' as const,
      content: { type: 'text' as const, text: 'Alice works at Acme.' },
      source: { kind: 'mutation-snapshot' },
      tags: ['original'],
      metadata: { state: 'original' },
      assertions: {
        entities: [
          { id: 'snapshot-alice', name: 'Alice' },
          { id: 'snapshot-acme', name: 'Acme' },
          { id: 'snapshot-globex', name: 'Globex' },
        ],
        facts: [
          {
            id: 'snapshot-employment',
            subject: { id: 'snapshot-alice' },
            predicate: 'works_at',
            object: { id: 'snapshot-acme' },
          },
        ],
      },
    }
    const rememberOptions = {
      operationId: 'snapshot-remember-operation',
      workLimits: { maxRecords: 10_000 },
    }
    const rememberPromise = memory.remember(rememberInput, rememberOptions)
    rememberInput.id = 'mutated-episode'
    rememberInput.content.text = 'Mutated after invocation.'
    rememberInput.source.kind = 'mutated-source'
    rememberInput.tags[0] = 'mutated'
    rememberInput.metadata.state = 'mutated'
    rememberInput.assertions.entities[0]!.id = 'mutated-alice'
    rememberOptions.operationId = 'mutated-remember-operation'
    rememberOptions.workLimits.maxRecords = 0
    const remembered = await rememberPromise
    expect(remembered).toMatchObject({
      operation: { id: 'snapshot-remember-operation' },
      episode: {
        id: 'mutation-snapshot',
        content: { type: 'text', text: 'Alice works at Acme.' },
        source: { kind: 'mutation-snapshot' },
        tags: ['original'],
        metadata: { state: 'original' },
      },
    })
    expect(await memory.getEntity('snapshot-alice', access)).toMatchObject({ id: 'snapshot-alice' })

    const batchInputs = [
      {
        id: 'mutation-batch-a',
        kind: 'text' as const,
        content: { type: 'text' as const, text: 'Batch A.' },
        source: { kind: 'mutation-batch' },
      },
      {
        id: 'mutation-batch-b',
        kind: 'text' as const,
        content: { type: 'text' as const, text: 'Batch B.' },
        source: { kind: 'mutation-batch' },
      },
    ]
    const batchOptions = { workLimits: { maxRecords: 10_000 } }
    const batchPromise = memory.rememberMany(batchInputs, batchOptions)
    batchInputs[0]!.id = 'mutated-batch'
    batchInputs[0]!.content.text = 'Mutated batch.'
    batchOptions.workLimits.maxRecords = 0
    const batch = await batchPromise
    expect(batch.failed).toEqual([])
    expect(batch.reports.map((report) => report.episode.id)).toEqual([
      'mutation-batch-a',
      'mutation-batch-b',
    ])

    const correctionInput = {
      factId: 'snapshot-employment',
      access: { allowedScopes: [] as string[] },
      reason: 'Original correction.',
      replacement: {
        subject: { id: 'snapshot-alice' },
        predicate: 'works_at',
        object: { id: 'snapshot-globex' },
      },
    }
    const correctionOptions = { operationId: 'snapshot-correction-operation' }
    const correctionPromise = memory.correctFact(correctionInput, correctionOptions)
    correctionInput.factId = 'mutated-fact'
    correctionInput.access.allowedScopes.push('private')
    correctionInput.reason = 'Mutated correction.'
    correctionInput.replacement.object.id = 'snapshot-acme'
    correctionOptions.operationId = 'mutated-correction-operation'
    const correction = await correctionPromise
    expect(correction.operation.id).toBe('snapshot-correction-operation')
    const replacementId = correction.affectedFacts.find((id) => id !== 'snapshot-employment')!
    expect(await memory.getFact(replacementId, access)).toMatchObject({
      object: { kind: 'entity', entityId: 'snapshot-globex' },
    })

    const rebuildRequest = {
      kinds: ['lexical'] as const,
      episodeIds: ['mutation-snapshot'],
      scanLimits: { maxRecords: 10_000, maxBytes: 16 * 1024 * 1024 },
    }
    const rebuildOptions = { operationId: 'snapshot-rebuild-operation' }
    const rebuildPromise = memory.rebuildProjections(rebuildRequest, rebuildOptions)
    rebuildRequest.episodeIds[0] = 'mutated-episode'
    rebuildRequest.scanLimits.maxRecords = 0
    rebuildOptions.operationId = 'mutated-rebuild-operation'
    expect(await rebuildPromise).toMatchObject({
      operation: { id: 'snapshot-rebuild-operation' },
    })

    const archive = await memory.export({ access, complete: true })
    const imported = harness()
    await imported.memory.open({ create: true })
    const importOptions = {
      operationId: 'snapshot-import-operation',
      collisions: 'reject' as const,
      limits: { maxRecords: 10_000, maxBytes: 16 * 1024 * 1024 },
    }
    const importPromise = imported.memory.import(archive, importOptions)
    Reflect.set(archive.manifest, 'digest', '0'.repeat(64))
    Reflect.set(importOptions, 'operationId', 'mutated-import-operation')
    Reflect.set(importOptions, 'collisions', 'invalid')
    importOptions.limits.maxRecords = 0
    expect(await importPromise).toMatchObject({
      operation: { id: 'snapshot-import-operation' },
      valid: true,
    })
    expect(await imported.memory.getEpisode('mutation-snapshot', access)).toMatchObject({
      id: 'mutation-snapshot',
    })

    const purgeInput = {
      access: { allowedScopes: [] as string[] },
      episodeIds: ['mutation-batch-a'],
      workLimits: { maxRecords: 10_000 },
    }
    const purgeOptions = { operationId: 'snapshot-purge-operation' }
    const purgePromise = imported.memory.hardPurge(purgeInput, purgeOptions)
    purgeInput.episodeIds[0] = 'mutation-batch-b'
    purgeInput.access.allowedScopes.push('private')
    purgeInput.workLimits.maxRecords = 0
    purgeOptions.operationId = 'mutated-purge-operation'
    expect(await purgePromise).toMatchObject({
      operation: { id: 'snapshot-purge-operation' },
      affectedEpisodes: ['mutation-batch-a'],
      purged: true,
    })
    await expect(imported.memory.getEpisode('mutation-batch-a', access)).resolves.toBeNull()
    await expect(imported.memory.getEpisode('mutation-batch-b', access)).resolves.toMatchObject({
      id: 'mutation-batch-b',
    })

    const guarded = harness()
    await guarded.memory.open({ create: true })
    const driver = storageDriver(guarded.storage)
    const storageCalls = [
      vi.spyOn(driver, 'get'),
      vi.spyOn(driver, 'query'),
      vi.spyOn(driver, 'count'),
      vi.spyOn(driver, 'commit'),
      vi.spyOn(driver, 'exportRecords'),
    ]
    const unexpected = { unexpected: true }
    const unreadableOptions = Object.defineProperty({}, 'operationId', {
      enumerable: true,
      get: () => {
        throw new Error('unreadable mutation option')
      },
    })
    const invalidCalls = [
      () =>
        guarded.memory.remember({
          id: 'invalid-remember',
          kind: 'text',
          content: { type: 'text', text: 'Invalid.' },
          source: { kind: 'fixture' },
          ...unexpected,
        } as never),
      () => guarded.memory.rememberMany([batchInputs[1]!], unexpected as never),
      () => guarded.memory.retryEpisode('missing', unexpected as never),
      () => guarded.memory.reprocessEpisode('missing', unexpected as never),
      () =>
        guarded.memory.deriveFact({
          conclusion: {
            subjectId: 'missing',
            predicate: 'invalid',
            object: { kind: 'scalar', value: true },
          },
          rule: { id: 'invalid', version: '1' },
          premises: [],
          access,
          expectedRevision: 0,
          ...unexpected,
        } as never),
      () =>
        guarded.memory.deriveFacts({
          derivations: [],
          access,
          expectedRevision: 0,
          ...unexpected,
        } as never),
      () =>
        guarded.memory.withdrawDerivation({
          derivationId: 'missing',
          access,
          expectedRevision: 0,
          ...unexpected,
        } as never),
      () =>
        guarded.memory.previewDerivationWithdrawals(
          { where: { ids: ['missing'] }, access, maxMatches: 1 },
          unexpected as never,
        ),
      () =>
        guarded.memory.withdrawDerivations(
          { where: { ids: ['missing'] }, access, expectedRevision: 0, maxMatches: 1 },
          unexpected as never,
        ),
      () =>
        guarded.memory.correctFact({
          factId: 'missing',
          replacement: {
            subject: { id: 'missing' },
            predicate: 'invalid',
            object: { scalar: true },
          },
          access,
          ...unexpected,
        } as never),
      () => guarded.memory.retractFact({ factId: 'missing', access, ...unexpected } as never),
      () =>
        guarded.memory.mergeEntities({
          targetId: 'missing',
          sourceIds: ['also-missing'],
          access,
          ...unexpected,
        } as never),
      () => guarded.memory.splitEntityMerge({ mergeId: 'missing', access, ...unexpected } as never),
      () => guarded.memory.deleteEpisode({ episodeId: 'missing', access, ...unexpected } as never),
      () =>
        guarded.memory.previewEpisodeDeletions(
          { where: { ids: ['missing'] }, access, maxMatches: 1 },
          unexpected as never,
        ),
      () =>
        guarded.memory.deleteEpisodes(
          { where: { ids: ['missing'] }, access, expectedRevision: 0, maxMatches: 1 },
          unexpected as never,
        ),
      () => guarded.memory.hardPurge({ access, episodeIds: ['missing'], ...unexpected } as never),
      () => guarded.memory.resetSpace({ confirmSpaceId: 'space-1', ...unexpected } as never),
      () => guarded.memory.import(archive, unexpected as never),
      () => guarded.memory.rebuildProjections({ ...unexpected } as never),
      () => guarded.memory.rebuildProjections({}, unreadableOptions as never),
    ]
    for (const invalidCall of invalidCalls) {
      await expect(invalidCall()).rejects.toSatisfy((error: unknown) =>
        MemoryError.is(error, 'invalid_input'),
      )
    }
    for (const storageCall of storageCalls) expect(storageCall).not.toHaveBeenCalled()

    const resetRequest = {
      confirmSpaceId: 'space-1',
      scanLimits: { maxRecords: 10_000, maxBytes: 16 * 1024 * 1024 },
    }
    const resetPromise = imported.memory.resetSpace(resetRequest)
    resetRequest.confirmSpaceId = 'mutated-space'
    resetRequest.scanLimits.maxRecords = 0
    expect(await resetPromise).toMatchObject({ purged: true })
  })

  it('owns lifecycle, management, point-read, integrity, and journal options at invocation', async () => {
    const opened = harness()
    const openOptions = {
      create: true,
      metadata: { owner: 'original', nested: { state: 'ready' } },
    }
    const openPromise = opened.memory.open(openOptions)
    openOptions.create = false
    openOptions.metadata.owner = 'mutated'
    openOptions.metadata.nested.state = 'mutated'
    expect(await openPromise).toMatchObject({
      metadata: { owner: 'original', nested: { state: 'ready' } },
    })

    await opened.memory.remember({
      id: 'remaining-options-episode',
      kind: 'assertion',
      content: { type: 'text', text: 'Remaining facade options are invocation values.' },
      source: { kind: 'remaining-options' },
      assertions: { entities: [{ id: 'remaining-options-entity', name: 'Owned Options' }] },
    })

    const liveSignal = new AbortController().signal
    let managementLimitReads = 0
    const managementOptions = Object.defineProperty({ signal: liveSignal }, 'scanLimits', {
      enumerable: true,
      get: () => {
        managementLimitReads += 1
        return managementLimitReads === 1
          ? { maxRecords: 10_000, maxBytes: 16 * 1024 * 1024 }
          : { maxRecords: 0, maxBytes: 0 }
      },
    })
    const statsPromise = opened.memory.stats(managementOptions as never)
    Reflect.set(managementOptions, 'signal', AbortSignal.abort())
    const stats = await statsPromise
    expect(managementLimitReads).toBe(1)
    expect(stats.episodes).toBe(1)

    let accessReads = 0
    const pointAccess = Object.defineProperty({}, 'allowedScopes', {
      enumerable: true,
      get: () => {
        accessReads += 1
        return accessReads === 1 ? [] : ['private']
      },
    }) as { allowedScopes: string[] }
    let pointLimitReads = 0
    const pointOptions = Object.defineProperty({ signal: liveSignal }, 'scanLimits', {
      enumerable: true,
      get: () => {
        pointLimitReads += 1
        return pointLimitReads === 1
          ? { maxRecords: 10_000, maxBytes: 16 * 1024 * 1024 }
          : { maxRecords: 0, maxBytes: 0 }
      },
    })
    const pointPromise = opened.memory.getEpisode(
      'remaining-options-episode',
      pointAccess,
      pointOptions as never,
    )
    Reflect.set(pointOptions, 'signal', AbortSignal.abort())
    expect(await pointPromise).toMatchObject({ id: 'remaining-options-episode' })
    expect(accessReads).toBe(1)
    expect(pointLimitReads).toBe(1)

    const baseline = await opened.memory.snapshot({ access })
    const registrationOptions = { signal: liveSignal }
    const registrationPromise = opened.memory.registerJournalConsumer(
      { id: 'remaining-options-consumer', journal: 'semantic', cursor: baseline.changesCursor },
      registrationOptions,
    )
    registrationOptions.signal = AbortSignal.abort()
    expect(await registrationPromise).toMatchObject({
      id: 'remaining-options-consumer',
      state: 'active',
    })

    await opened.memory.remember({
      id: 'remaining-options-delta',
      kind: 'text',
      content: { type: 'text', text: 'A checkpoint delta.' },
      source: { kind: 'remaining-options' },
    })
    const delta = await opened.memory.changes({ access, cursor: baseline.changesCursor })
    const acknowledgementOptions = { signal: liveSignal }
    const acknowledgementPromise = opened.memory.acknowledgeJournalConsumer(
      { id: 'remaining-options-consumer', journal: 'semantic', cursor: delta.nextCursor },
      acknowledgementOptions,
    )
    acknowledgementOptions.signal = AbortSignal.abort()
    expect(await acknowledgementPromise).toMatchObject({
      id: 'remaining-options-consumer',
      throughRevision: delta.throughRevision,
    })

    const compactionOptions = { signal: liveSignal }
    const compactionPromise = opened.memory.compactChanges(
      {
        confirmSpaceId: 'space-1',
        registeredConsumers: true,
        expectedRevision: delta.currentRevision,
        maxChanges: 100,
        dryRun: true,
      },
      compactionOptions,
    )
    compactionOptions.signal = AbortSignal.abort()
    expect(await compactionPromise).toMatchObject({ dryRun: true })

    const retirementOptions = { signal: liveSignal }
    const retirementPromise = opened.memory.retireJournalConsumer(
      { id: 'remaining-options-consumer', journal: 'semantic' },
      retirementOptions,
    )
    retirementOptions.signal = AbortSignal.abort()
    expect(await retirementPromise).toMatchObject({ state: 'retired' })

    let integrityLimitReads = 0
    const integrityOptions = Object.defineProperty({ signal: liveSignal }, 'limits', {
      enumerable: true,
      get: () => {
        integrityLimitReads += 1
        return integrityLimitReads === 1
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
    const integrityPromise = opened.memory.verifyIntegrity(integrityOptions as never)
    Reflect.set(integrityOptions, 'signal', AbortSignal.abort())
    expect(await integrityPromise).toMatchObject({ ok: true })
    expect(integrityLimitReads).toBe(1)

    const driver = storageDriver(opened.storage)
    const inspect = vi.spyOn(driver, 'inspect')
    await expect(opened.memory.open({ unexpected: true } as never)).rejects.toSatisfy(
      (error: unknown) => MemoryError.is(error, 'invalid_input'),
    )
    expect(inspect).not.toHaveBeenCalled()
    const storageCalls = [
      vi.spyOn(driver, 'get'),
      vi.spyOn(driver, 'query'),
      vi.spyOn(driver, 'count'),
      vi.spyOn(driver, 'exportRecords'),
    ]
    const unreadableOptions = Object.defineProperty({}, 'scanLimits', {
      enumerable: true,
      get: () => {
        throw new Error('unreadable management options')
      },
    })
    await expect(opened.memory.stats(unreadableOptions as never)).rejects.toSatisfy(
      (error: unknown) => MemoryError.is(error, 'invalid_input'),
    )
    for (const storageCall of storageCalls) expect(storageCall).not.toHaveBeenCalled()
  })

  it('detaches core read, analysis, feed, and export requests before asynchronous work', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'request-public',
      kind: 'assertion',
      content: { type: 'text', text: 'Public request snapshot entity.' },
      source: { kind: 'request-public' },
      assertions: { entities: [{ id: 'request-public-entity', name: 'Public Snapshot' }] },
    })
    await memory.remember({
      id: 'request-private',
      kind: 'assertion',
      content: { type: 'text', text: 'Private request snapshot entity.' },
      source: { kind: 'request-private' },
      scopes: ['private'],
      assertions: { entities: [{ id: 'request-private-entity', name: 'Private Snapshot' }] },
    })
    const signalBaseline = await memory.snapshot({ access: privateAccess })
    const publicSignal = await memory.putSignals({
      access,
      expectedRevision: signalBaseline.snapshotRevision,
      signals: [
        {
          namespace: 'request.public',
          target: { kind: 'episode', id: 'request-public' },
          producer: { kind: 'manual', id: 'request-test', version: '1' },
          scopes: [],
          value: 'public',
        },
      ],
    })
    await memory.putSignals({
      access: privateAccess,
      expectedRevision: publicSignal.revision,
      signals: [
        {
          namespace: 'request.private',
          target: { kind: 'episode', id: 'request-private' },
          producer: { kind: 'manual', id: 'request-test', version: '1' },
          scopes: ['private'],
          value: 'private',
        },
      ],
    })

    const pointRequest = {
      kind: 'episode' as const,
      id: 'request-public',
      access: { allowedScopes: [] as string[] },
    }
    const pointPromise = memory.read(pointRequest)
    pointRequest.id = 'request-private'
    pointRequest.access.allowedScopes.push('private')
    expect((await pointPromise).value?.id).toBe('request-public')

    let allowedScopeReads = 0
    const accessorAccess = Object.defineProperty({}, 'allowedScopes', {
      enumerable: true,
      get: () => {
        allowedScopeReads += 1
        return allowedScopeReads === 1 ? [] : ['private']
      },
    }) as { allowedScopes: string[] }
    const recallRequest = {
      anchors: { entityIds: ['request-public-entity'] },
      access: accessorAccess,
      filters: { episodes: { ids: ['request-public'] } },
      channels: { exact: true, lexical: false, semantic: false, graph: false, temporal: false },
    }
    const recallPromise = memory.recall(recallRequest)
    recallRequest.anchors.entityIds[0] = 'request-private-entity'
    recallRequest.filters.episodes.ids[0] = 'request-private'
    const recalled = await recallPromise
    expect(allowedScopeReads).toBe(1)
    expect(recalled.episodes.map((episode) => episode.episodeId)).toEqual(['request-public'])

    const searchRequest = {
      anchors: { entityIds: ['request-public-entity'] },
      access: { allowedScopes: [] as string[] },
      channels: { exact: true, lexical: false, semantic: false, graph: false, temporal: false },
      target: 'all' as const,
    }
    const searchPromise = memory.search(searchRequest)
    searchRequest.anchors.entityIds[0] = 'request-private-entity'
    searchRequest.access.allowedScopes.push('private')
    searchRequest.target = 'episodes' as never
    const searched = await searchPromise
    expect(searched.context.entities.map((entity) => entity.id)).toContain('request-public-entity')
    expect(searched.context.entities.map((entity) => entity.id)).not.toContain(
      'request-private-entity',
    )

    const neighborhoodRequest = {
      entityId: 'request-public-entity',
      access: { allowedScopes: [] as string[] },
    }
    const neighborhoodPromise = memory.neighborhood(neighborhoodRequest)
    neighborhoodRequest.entityId = 'request-private-entity'
    neighborhoodRequest.access.allowedScopes.push('private')
    expect((await neighborhoodPromise).center.id).toBe('request-public-entity')

    const browseRequest = {
      kind: 'episode' as const,
      access: { allowedScopes: [] as string[] },
      filters: { episodes: { source: { kinds: ['request-public'] } } },
      limit: 10,
    }
    const browsePromise = memory.browse(browseRequest)
    browseRequest.filters.episodes.source.kinds[0] = 'request-private'
    browseRequest.access.allowedScopes.push('private')
    expect((await browsePromise).items.map((episode) => episode.id)).toEqual(['request-public'])

    const snapshotRequest = {
      access: { allowedScopes: [] as string[] },
      filters: { episodes: { ids: ['request-public'] } },
      maxRecords: 100,
    }
    const snapshotPromise = memory.snapshot(snapshotRequest)
    snapshotRequest.filters.episodes.ids[0] = 'request-private'
    snapshotRequest.access.allowedScopes.push('private')
    expect((await snapshotPromise).episodes.map((episode) => episode.id)).toEqual([
      'request-public',
    ])

    const analysisRequest = {
      access: { allowedScopes: [] as string[] },
      filters: { episodes: { ids: ['request-public'] } },
      pagerank: { seeds: [{ id: 'request-public-entity', weight: 1 }] },
    }
    const analysisPromise = memory.analyze(analysisRequest)
    analysisRequest.filters.episodes.ids[0] = 'request-private'
    analysisRequest.pagerank.seeds[0]!.id = 'request-private-entity'
    analysisRequest.access.allowedScopes.push('private')
    const analysis = await analysisPromise
    expect(analysis.overview.episodes).toBe(1)
    expect(analysis.provenance.bySourceKind).toEqual({ 'request-public': 1 })
    expect(analysis.algorithms).toMatchObject({ personalized: true, seedCount: 1 })

    const exportRequest = {
      access: { allowedScopes: [] as string[] },
      episodeIds: ['request-public'],
    }
    const exportPromise = memory.export(exportRequest)
    exportRequest.episodeIds[0] = 'request-private'
    exportRequest.access.allowedScopes.push('private')
    expect((await exportPromise).canonical.episodes.map((episode) => episode.id)).toEqual([
      'request-public',
    ])

    const changesRequest = { access: { allowedScopes: [] as string[] }, limit: 100 }
    const changesPromise = memory.changes(changesRequest)
    changesRequest.access.allowedScopes.push('private')
    changesRequest.limit = 1
    const changes = await changesPromise
    expect(JSON.stringify(changes.changes)).toContain('request-public')
    expect(JSON.stringify(changes.changes)).not.toContain('request-private')

    const signalChangesRequest = { access: { allowedScopes: [] as string[] }, limit: 100 }
    const signalChangesPromise = memory.signalChanges(signalChangesRequest)
    signalChangesRequest.access.allowedScopes.push('private')
    signalChangesRequest.limit = 1
    const signalChanges = await signalChangesPromise
    expect(JSON.stringify(signalChanges.changes)).toContain('request-public')
    expect(JSON.stringify(signalChanges.changes)).not.toContain('request-private')

    const driver = storageDriver(storage)
    const query = vi.spyOn(driver, 'query')
    const invalidCalls = [
      () =>
        memory.read({ kind: 'episode', id: 'request-public', access, unexpected: true } as never),
      () => memory.recall({ access, unexpected: true } as never),
      () => memory.search({ access, unexpected: true } as never),
      () =>
        memory.neighborhood({
          entityId: 'request-public-entity',
          access,
          unexpected: true,
        } as never),
      () => memory.browse({ kind: 'episode', access, unexpected: true } as never),
      () => memory.snapshot({ access, unexpected: true } as never),
      () => memory.analyze({ access, unexpected: true } as never),
      () => memory.changes({ access, unexpected: true } as never),
      () => memory.signalChanges({ access, unexpected: true } as never),
      () => memory.export({ access, unexpected: true } as never),
    ]
    for (const invalidCall of invalidCalls) {
      await expect(invalidCall()).rejects.toSatisfy((error: unknown) =>
        MemoryError.is(error, 'invalid_input'),
      )
    }
    await expect(
      memory.recall({ access: { ...access, unexpected: true } } as never),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))
    expect(query).not.toHaveBeenCalled()
  })

  it('fails point reads closed when their visible record graph changes mid-read', async () => {
    const { memory, report, storage } = await seedGraph()
    const peer = harness({ storage }).memory
    await peer.open()
    const driver = storageDriver(storage)
    const originalGet = driver.get.bind(driver)
    let raceOn: 'entity' | 'episode' | 'fact' | undefined
    let raceIndex = 0
    const get = vi.spyOn(driver, 'get')
    get.mockImplementation((async (kind, spaceId, id) => {
      const record = await originalGet(kind, spaceId, id)
      if (kind === raceOn) {
        raceOn = undefined
        raceIndex += 1
        await peer.remember(
          {
            id: `point-read-race-${raceIndex}`,
            kind: 'assertion',
            content: { type: 'text', text: `Point read race ${raceIndex}.` },
            source: { kind: 'fixture' },
            assertions: {
              entities: [{ id: `point-read-race-entity-${raceIndex}`, name: 'Race' }],
            },
          },
          { operationId: `point-read-race-operation-${raceIndex}` },
        )
      }
      return record
    }) as StorageDriver['get'])

    raceOn = 'episode'
    await expect(memory.getEpisode('graph', access)).rejects.toSatisfy(
      (error: unknown) => MemoryError.is(error, 'conflict') && error.retryable,
    )
    raceOn = 'entity'
    await expect(memory.getEntity('alpha', access)).rejects.toSatisfy(
      (error: unknown) => MemoryError.is(error, 'conflict') && error.retryable,
    )
    raceOn = 'fact'
    await expect(memory.getFact(report.facts.created[0]!, access)).rejects.toSatisfy(
      (error: unknown) => MemoryError.is(error, 'conflict') && error.retryable,
    )
    get.mockRestore()
  })

  it('streams provenance-complete point reads under exact scan limits', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    for (let index = 0; index < 17; index += 1) {
      const suffix = index.toString().padStart(2, '0')
      await memory.remember({
        id: `point-read-${suffix}`,
        kind: 'assertion',
        content: { type: 'text', text: `Point-read evidence ${suffix}.` },
        source: { kind: 'fixture' },
        assertions: {
          entities: [{ id: 'point-read-entity', name: 'Point Read Entity' }],
          facts: [
            {
              id: 'point-read-fact',
              subject: { id: 'point-read-entity' },
              predicate: 'point_read_observed',
              object: { scalar: true },
            },
          ],
        },
      })
    }
    const before = await memory.stats()
    const driver = storageDriver(storage)
    const exported = vi
      .spyOn(driver, 'exportRecords')
      .mockRejectedValue(new Error('point reads must not use whole-space export'))
    const queries = vi.spyOn(driver, 'query')
    const generous = { maxRecords: 1_000, maxBytes: 16 * 1024 * 1024 }

    const entity = await memory.read({
      kind: 'entity',
      id: 'point-read-entity',
      access,
      scanLimits: generous,
    })
    const fact = await memory.read({
      kind: 'fact',
      id: 'point-read-fact',
      access,
      scanLimits: generous,
    })
    const episode = await memory.read({
      kind: 'episode',
      id: 'point-read-00',
      access,
      scanLimits: generous,
    })

    expect(entity).toMatchObject({
      value: { id: 'point-read-entity', evidence: expect.any(Array) },
      snapshotRevision: before.snapshotRevision,
      generatedAt: '2026-08-03T10:00:00.000Z',
      scan: { limits: generous },
    })
    expect(entity.value?.evidence).toHaveLength(17)
    expect(entity.scan.records).toBeGreaterThan(17)
    expect(entity.scan.bytes).toBeGreaterThan(0)
    expect(fact.value?.evidence).toHaveLength(17)
    expect(fact.scan.records).toBeGreaterThan(17)
    expect(fact.scan.bytes).toBeGreaterThan(0)
    expect(episode).toMatchObject({
      value: { id: 'point-read-00' },
      scan: { records: 1, bytes: expect.any(Number), limits: generous },
    })
    expect(exported).not.toHaveBeenCalled()
    expect(
      queries.mock.calls
        .map(([query]) => query)
        .filter((query) => ['alias', 'evidence', 'derivation', 'lifecycle'].includes(query.kind))
        .every((query) => query.limit !== undefined && query.limit <= 16),
    ).toBe(true)

    await expect(
      memory.read({
        kind: 'entity',
        id: 'point-read-entity',
        access,
        scanLimits: {
          maxRecords: entity.scan.records - 1,
          maxBytes: entity.scan.bytes,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'point_read_scan',
        dimension: 'records',
        required: entity.scan.records,
        maximum: entity.scan.records - 1,
      },
    })
    await expect(
      memory.read({
        kind: 'entity',
        id: 'point-read-entity',
        access,
        scanLimits: {
          maxRecords: entity.scan.records,
          maxBytes: entity.scan.bytes - 1,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'point_read_scan',
        dimension: 'bytes',
        required: entity.scan.bytes,
        maximum: entity.scan.bytes - 1,
      },
    })
    await expect(
      memory.getEntity('point-read-entity', access, {
        scanLimits: { maxRecords: entity.scan.records, maxBytes: entity.scan.bytes },
      }),
    ).resolves.toMatchObject({ id: 'point-read-entity', evidence: expect.any(Array) })
    await expect(
      memory.getFact('point-read-fact', access, {
        scanLimits: { maxRecords: fact.scan.records, maxBytes: fact.scan.bytes },
      }),
    ).resolves.toMatchObject({ id: 'point-read-fact', evidence: expect.any(Array) })
    expect((await memory.stats()).snapshotRevision).toBe(before.snapshotRevision)
  })

  it('brackets stats, integrity, and canonical export at one disclosed revision', async () => {
    const { memory, storage } = await seedGraph()
    const peer = harness({ storage }).memory
    await peer.open()
    const driver = storageDriver(storage)
    const originalCount = driver.count.bind(driver)
    const originalQuery = driver.query.bind(driver)
    let race: (() => Promise<void>) | undefined
    let raceTrigger: 'count' | 'query' | undefined
    let raceIndex = 0
    const consumeRace = async (trigger: 'count' | 'query'): Promise<void> => {
      if (raceTrigger !== trigger) return
      const write = race
      race = undefined
      raceTrigger = undefined
      if (write !== undefined) await write()
    }
    const count = vi.spyOn(driver, 'count')
    count.mockImplementation((async (query) => {
      const result = await originalCount(query)
      await consumeRace('count')
      return result
    }) as StorageDriver['count'])
    const query = vi.spyOn(driver, 'query')
    query.mockImplementation((async (request) => {
      const result = await originalQuery(request)
      if (
        [
          'episode',
          'entity',
          'alias',
          'mention',
          'fact',
          'evidence',
          'derivation',
          'lifecycle',
          'merge',
        ].includes(request.kind)
      ) {
        await consumeRace('query')
      }
      return result
    }) as StorageDriver['query'])
    const armRace = (trigger: 'count' | 'query'): void => {
      raceIndex += 1
      const index = raceIndex
      raceTrigger = trigger
      race = async () => {
        await peer.remember(
          {
            id: `composite-read-race-${index}`,
            kind: 'assertion',
            content: { type: 'text', text: `Composite read race ${index}.` },
            source: { kind: 'fixture' },
            assertions: {
              entities: [{ id: `composite-read-race-entity-${index}`, name: 'Race' }],
            },
          },
          { operationId: `composite-read-race-operation-${index}` },
        )
      }
    }

    for (const [trigger, read] of [
      ['count', () => memory.stats()],
      ['query', () => memory.export({ access, complete: true })],
      ['query', () => memory.verifyIntegrity()],
    ] as const) {
      armRace(trigger)
      await expect(read()).rejects.toSatisfy(
        (error: unknown) => MemoryError.is(error, 'conflict') && error.retryable,
      )
    }
    const logicalRevisionBeforeMetadataRace = (await memory.stats()).snapshotRevision
    raceTrigger = 'count'
    race = async () => {
      await peer.createSyncCheckpoint(
        { access, confirmSpaceId: 'space-1' },
        { operationId: 'composite-read-metadata-race' },
      )
    }
    await expect(memory.stats()).rejects.toSatisfy(
      (error: unknown) => MemoryError.is(error, 'conflict') && error.retryable,
    )
    expect((await memory.stats()).snapshotRevision).toBe(logicalRevisionBeforeMetadataRace)
    count.mockRestore()
    query.mockRestore()

    const stats = await memory.stats()
    const archive = await memory.export({ access, complete: true })
    const integrity = await memory.verifyIntegrity()
    expect(integrity.issues).toEqual([])
    expect(stats).toMatchObject({
      snapshotRevision: archive.snapshotRevision,
      generatedAt: '2026-08-03T10:00:00.000Z',
    })
    expect(integrity).toMatchObject({
      ok: true,
      snapshotRevision: archive.snapshotRevision,
      checkedAt: '2026-08-03T10:00:00.000Z',
    })
  })

  it('bounds integrity storage, graph, and issue work without whole-space export', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    for (let index = 0; index < 17; index += 1) {
      await memory.remember(
        {
          id: `integrity-page-${index.toString().padStart(2, '0')}`,
          kind: 'text',
          content: { type: 'text', text: `Integrity page ${index}.` },
          source: { kind: 'fixture' },
        },
        { operationId: `integrity-page-operation-${index.toString().padStart(2, '0')}` },
      )
    }

    const driver = storageDriver(storage)
    const originalQuery = driver.query.bind(driver)
    const query = vi.spyOn(driver, 'query')
    query.mockImplementation(((request) => originalQuery(request)) as StorageDriver['query'])
    const exportRecords = vi
      .spyOn(driver, 'exportRecords')
      .mockRejectedValue(new Error('integrity must not use whole-space export'))
    const before = await memory.stats()

    await expect(
      memory.verifyIntegrity({
        limits: {
          maxRecords: 1,
          maxBytes: 1024 * 1024,
          maxGraphNodes: 100,
          maxGraphEdges: 100,
          maxIssues: 10,
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'integrity' &&
        error.details?.dimension === 'records' &&
        error.details?.required === 2 &&
        error.details?.maximum === 1,
    )
    await expect(
      memory.verifyIntegrity({
        limits: {
          maxRecords: 1_000,
          maxBytes: 1,
          maxGraphNodes: 100,
          maxGraphEdges: 100,
          maxIssues: 10,
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'integrity' &&
        error.details?.dimension === 'bytes' &&
        Number(error.details?.required) > 1 &&
        error.details?.maximum === 1,
    )
    expect((await memory.stats()).snapshotRevision).toBe(before.snapshotRevision)
    query.mockClear()

    const report = await memory.verifyIntegrity({
      limits: {
        maxRecords: 1_000,
        maxBytes: 16 * 1024 * 1024,
        maxGraphNodes: 1_000,
        maxGraphEdges: 1_000,
        maxIssues: 10,
      },
    })
    expect(report).toMatchObject({
      ok: true,
      issues: [],
      work: {
        issuesDetected: 0,
        issuesTruncated: false,
        limits: { maxRecords: 1_000, maxIssues: 10 },
      },
    })
    expect(report.work.records).toBeGreaterThan(17)
    expect(report.work.records).toBeLessThanOrEqual(report.work.limits.maxRecords)
    expect(report.work.bytes).toBeGreaterThan(0)
    expect(report.work.bytes).toBeLessThanOrEqual(report.work.limits.maxBytes)
    expect(
      query.mock.calls
        .map(([request]) => request)
        .filter(
          (request) => request.order?.[0]?.field === 'id' && request.order[0].direction === 'asc',
        )
        .every((request) => request.limit !== undefined && request.limit <= 16),
    ).toBe(true)
    expect(exportRecords).not.toHaveBeenCalled()
    exportRecords.mockRestore()
    query.mockRestore()
  })

  it('reports every integrity failure while bounding retained issue details', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    for (let index = 0; index < 3; index += 1) {
      await memory.remember(
        {
          id: `integrity-issue-${index}`,
          kind: 'text',
          content: { type: 'text', text: `Integrity issue ${index}.` },
          source: { kind: 'fixture' },
        },
        { operationId: `integrity-issue-operation-${index}` },
      )
    }
    const driver = storageDriver(storage)
    const space = await driver.getSpace('space-1')
    const operations = await Promise.all(
      [0, 1, 2].map((index) =>
        driver.get('operation', 'space-1', `integrity-issue-operation-${index}`),
      ),
    )
    if (space === null || operations.some((operation) => operation === null)) {
      throw new Error('integrity issue fixture is missing')
    }
    await driver.commit({
      spaceId: 'space-1',
      expectedRevision: space.revision,
      puts: operations.map((operation) => ({ ...operation!, attempts: 0 })),
    })

    const bounded = await memory.verifyIntegrity({ limits: { maxIssues: 1 } })
    expect(bounded).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'invalid_operation' })],
      work: { issuesDetected: 3, issuesTruncated: true, limits: { maxIssues: 1 } },
    })
    expect(bounded.issues).toHaveLength(1)

    const summaryOnly = await memory.verifyIntegrity({ limits: { maxIssues: 0 } })
    expect(summaryOnly).toMatchObject({
      ok: false,
      issues: [],
      work: { issuesDetected: 3, issuesTruncated: true, limits: { maxIssues: 0 } },
    })
  })

  it('bounds canonical archive scans, output, and import preparation', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    for (let index = 0; index < 17; index += 1) {
      await memory.remember({
        id: `archive-page-${index.toString().padStart(2, '0')}`,
        kind: 'assertion',
        content: { type: 'text', text: `Archive page ${index}.` },
        source: { kind: 'fixture' },
      })
    }

    const driver = storageDriver(storage)
    const originalQuery = driver.query.bind(driver)
    const query = vi.spyOn(driver, 'query')
    query.mockImplementation(((request) => originalQuery(request)) as StorageDriver['query'])
    const exportRecords = vi.spyOn(driver, 'exportRecords')

    const broadScan = memory.export({
      access,
      complete: true,
      scanLimits: { maxRecords: 16, maxBytes: 1024 * 1024 },
      limits: { maxRecords: 100, maxBytes: 1024 * 1024 },
    })
    await expect(broadScan).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'scan' &&
        error.details?.dimension === 'records' &&
        error.details?.required === 17 &&
        error.details?.maximum === 16,
    )
    await expect(
      memory.export({
        access,
        complete: true,
        scanLimits: { maxRecords: 100, maxBytes: 1 },
        limits: { maxRecords: 100, maxBytes: 1024 * 1024 },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'scan' &&
        error.details?.dimension === 'bytes',
    )
    await expect(
      memory.export({
        access,
        complete: true,
        scanLimits: { maxRecords: 100, maxBytes: 1024 * 1024 },
        limits: { maxRecords: 16, maxBytes: 1024 * 1024 },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'archive' &&
        error.details?.dimension === 'records' &&
        error.details?.required === 34 &&
        error.details?.maximum === 16,
    )

    const request = {
      access,
      complete: true,
      scanLimits: { maxRecords: 100, maxBytes: 1024 * 1024 },
      limits: { maxRecords: 100, maxBytes: 1024 * 1024 },
    } as const
    const archive = await memory.export(request)
    const archiveBytes = new TextEncoder().encode(
      stableStringify(archive as unknown as JsonValue),
    ).byteLength
    await expect(
      memory.export({ ...request, limits: { maxRecords: 100, maxBytes: archiveBytes } }),
    ).resolves.toEqual(archive)
    await expect(
      memory.export({ ...request, limits: { maxRecords: 100, maxBytes: archiveBytes - 1 } }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'archive' &&
        error.details?.dimension === 'bytes' &&
        error.details?.required === archiveBytes &&
        error.details?.maximum === archiveBytes - 1,
    )

    expect(exportRecords).not.toHaveBeenCalled()
    const canonicalKinds = new Set([
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
    const canonicalQueries = query.mock.calls
      .map(([candidate]) => candidate)
      .filter((candidate) => canonicalKinds.has(candidate.kind))
    expect(canonicalQueries.length).toBeGreaterThan(0)
    expect(
      canonicalQueries.every((candidate) => candidate.limit === 1 || candidate.limit === 16),
    ).toBe(true)
    query.mockRestore()
    exportRecords.mockRestore()

    const target = harness().memory
    await target.open({ create: true })
    await expect(
      target.import(archive, {
        dryRun: true,
        limits: { maxRecords: 16, maxBytes: archiveBytes },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') && error.details?.dimension === 'records',
    )
    await expect(
      target.import(archive, {
        dryRun: true,
        limits: { maxRecords: 34, maxBytes: archiveBytes - 1 },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') && error.details?.dimension === 'bytes',
    )
    await expect(
      target.import(archive, {
        dryRun: true,
        limits: { maxRecords: 34, maxBytes: archiveBytes },
        prepareLimits: { maxRecords: 33, maxBytes: 1024 * 1024 },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'import' &&
        error.details?.dimension === 'records' &&
        error.details?.required === 34 &&
        error.details?.maximum === 33,
    )
    await expect(
      target.import(archive, {
        dryRun: true,
        limits: { maxRecords: 34, maxBytes: archiveBytes },
      }),
    ).resolves.toMatchObject({ dryRun: true, valid: true, imported: { episodes: 17 } })
    await target.import(archive, { limits: { maxRecords: 34, maxBytes: archiveBytes } })
    await expect(target.stats()).resolves.toMatchObject({ episodes: 17 })
  })

  it('pushes simple statistics into storage and keyset-scans complex metrics in bounded pages', async () => {
    const { memory, storage } = await seedGraph()
    const driver = storageDriver(storage)
    let space = (await driver.getSpace('space-1'))!
    const recordedAt = '2026-08-03T10:00:00.000Z'
    const signals: Extract<StoredSignal, { state: 'active' }>[] = Array.from(
      { length: 1_001 },
      (_, index) => {
        const key = index.toString(16).padStart(64, '0')
        return {
          kindRecord: 'signal',
          id: `signal_${key}_00000001`,
          spaceId: 'space-1',
          key,
          version: 1,
          namespace: 'stats.pagination',
          slot: `slot-${index}`,
          target: { kind: 'episode', id: 'graph' },
          producer: { kind: 'manual', id: 'stats-fixture', version: '1' },
          scopes: [],
          tags: [],
          basis: { episodeIds: [], entityIds: [], factIds: [] },
          inputRevision: space.revision,
          recordedRevision: space.revision + 1,
          basisView: { kind: 'current' },
          recordedAt,
          state: 'active',
          value: index,
        }
      },
    )
    await driver.commit({
      spaceId: 'space-1',
      expectedRevision: space.revision,
      puts: signals,
      signalChange: {
        action: 'put',
        partitions: [
          {
            scopes: [],
            affected: signals.map((signal) => ({ key: signal.key, target: signal.target })),
          },
        ],
      },
    })
    space = (await driver.getSpace('space-1'))!
    const first = signals[0]!
    const {
      value: _firstValue,
      state: _firstState,
      expiresAt: _firstExpiresAt,
      ...withdrawnBase
    } = first
    await driver.commit({
      spaceId: 'space-1',
      expectedRevision: space.revision,
      puts: [
        {
          ...withdrawnBase,
          id: `signal_${first.key}_00000002`,
          version: 2,
          inputRevision: space.revision,
          recordedRevision: space.revision + 1,
          supersedes: first.id,
          state: 'withdrawn',
        } satisfies StoredSignal,
      ],
      signalChange: {
        action: 'withdraw',
        partitions: [{ scopes: [], affected: [{ key: first.key, target: first.target }] }],
      },
    })
    space = (await driver.getSpace('space-1'))!
    const operations: StoredOperation[] = Array.from({ length: 1_001 }, (_, index) => ({
      kindRecord: 'operation',
      id: `stats-operation-${index.toString().padStart(4, '0')}`,
      bindingId: `stats-binding-${index}`,
      spaceId: 'space-1',
      kind: 'rebuild',
      state: 'succeeded',
      diagnosticsState: 'available',
      diagnosticsTruncated: false,
      stage: 'completed',
      startedAt: recordedAt,
      updatedAt: recordedAt,
      completedAt: recordedAt,
      retryable: false,
      attempts: 1,
      warnings: [],
      remoteCalls: [
        {
          capability: 'embedding',
          provider: 'stats-fixture',
          model: 'bounded',
          destination: 'local',
          fields: ['content'],
          startedAt: recordedAt,
          completedAt: recordedAt,
          outcome: 'succeeded',
        },
      ],
    }))
    await driver.commit({
      spaceId: 'space-1',
      expectedRevision: space.revision,
      puts: operations,
    })

    const exportRecords = vi
      .spyOn(driver, 'exportRecords')
      .mockRejectedValue(new Error('stats must not materialize the whole space'))
    const count = vi.spyOn(driver, 'count')
    const originalQuery = driver.query.bind(driver)
    const limits: number[] = []
    const query = vi.spyOn(driver, 'query').mockImplementation((async (request) => {
      if (request.limit !== undefined) limits.push(request.limit)
      return originalQuery(request)
    }) as StorageDriver['query'])

    const stats = await memory.stats()

    expect(stats).toMatchObject({
      episodes: 1,
      entities: 3,
      facts: 2,
      derivations: 0,
      derivationRevisions: 0,
      conflicts: 0,
      operations: 1_002,
      changes: 2,
      signals: 1_000,
      signalRevisions: 1_002,
      signalChanges: 2,
      providerCalls: 1_001,
    })
    expect(stats.scan).toMatchObject({
      records: expect.any(Number),
      bytes: expect.any(Number),
      limits: { maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 },
    })
    expect(stats.scan.records).toBeGreaterThan(2_000)
    expect(stats.scan.bytes).toBeGreaterThan(0)
    await expect(
      memory.stats({
        scanLimits: {
          maxRecords: stats.scan.records - 1,
          maxBytes: stats.scan.bytes,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'stats_scan',
        dimension: 'records',
        required: stats.scan.records,
        maximum: stats.scan.records - 1,
      },
    })
    await expect(
      memory.stats({
        scanLimits: {
          maxRecords: stats.scan.records,
          maxBytes: stats.scan.bytes - 1,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'stats_scan',
        dimension: 'bytes',
        required: stats.scan.bytes,
        maximum: stats.scan.bytes - 1,
      },
    })
    await expect(
      memory.stats({
        scanLimits: { maxRecords: stats.scan.records, maxBytes: stats.scan.bytes },
      }),
    ).resolves.toMatchObject({
      providerCalls: 1_001,
      scan: { records: stats.scan.records, bytes: stats.scan.bytes },
    })
    expect(exportRecords).not.toHaveBeenCalled()
    expect([...new Set(count.mock.calls.map(([request]) => request.kind))].sort()).toEqual([
      'change',
      'derivation',
      'entity',
      'episode',
      'fact',
      'operation',
      'signal',
      'signal_change',
    ])
    expect(limits.length).toBeGreaterThan(0)
    expect(limits.every((limit) => limit >= 1 && limit <= 1_000)).toBe(true)
    expect(query.mock.calls.some(([request]) => request.startAfter !== undefined)).toBe(true)

    exportRecords.mockRestore()
    count.mockRestore()
    query.mockRestore()
  })

  it('selects application-defined current state before pagination', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    for (const [id, state] of [
      ['active-thread', 'open'],
      ['closed-thread', 'closed'],
    ] as const) {
      await memory.remember({
        id: `episode-${id}`,
        kind: 'assertion',
        content: { type: 'text', text: `${id} is ${state}.` },
        source: {
          kind: 'copilot.thread',
          threadId: id,
          metadata: { surface: 'editor' },
        },
        tags: ['session', state],
        metadata: { workspace: 'alpha' },
        assertions: {
          entities: [{ id, name: id }],
          facts: [
            {
              subject: { id },
              predicate: 'session_state',
              object: { scalar: state },
            },
          ],
        },
      })
    }

    const page = await memory.browse({
      kind: 'fact',
      access,
      filters: {
        episodes: {
          source: { kinds: ['copilot.thread'], metadata: { surface: 'editor' } },
          tags: { all: ['session'], none: ['closed'] },
          metadata: { workspace: 'alpha' },
        },
        facts: {
          predicates: ['session_state'],
          objects: [{ kind: 'scalar', value: 'open' }],
        },
      },
      limit: 1,
    })

    expect(page.items).toHaveLength(1)
    expect(page.items[0]).toMatchObject({
      subjectId: 'active-thread',
      object: { kind: 'scalar', value: 'open' },
    })
    expect(page.nextCursor).toBeUndefined()
  })

  it('pushes an id-ordered episode page, access, and indexable filters into storage', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    for (const [id, scopes, tags] of [
      ['episode-a', [], ['session', 'active']],
      ['episode-b', [], ['session', 'active']],
      ['episode-c', ['private'], ['session', 'active']],
      ['episode-d', [], ['session', 'archived']],
    ] as const) {
      await memory.remember({
        id,
        kind: 'assertion',
        content: { type: 'text', text: `${id} storage paging.` },
        source: { kind: 'copilot.thread', threadId: id },
        scopes,
        tags,
        assertions: { entities: [{ id: `${id}-entity`, name: id }] },
      })
    }
    const driver = storageDriver(storage)
    const query = vi.spyOn(driver, 'query')
    const request = {
      kind: 'episode' as const,
      access,
      order: 'id' as const,
      filters: {
        episodes: {
          source: { kinds: ['copilot.thread'] },
          tags: { all: ['session'], none: ['archived'] },
        },
      },
    }

    const first = await memory.browse({ ...request, limit: 1 })
    expect(first.items.map((episode) => episode.id)).toEqual(['episode-a'])
    expect(query.mock.calls.map(([candidate]) => candidate.kind)).not.toEqual(
      expect.arrayContaining([
        'entity',
        'fact',
        'alias',
        'evidence',
        'mention',
        'lifecycle',
        'merge',
      ]),
    )
    const pushed = query.mock.calls
      .map(([candidate]) => candidate)
      .find((item) => item.kind === 'episode')
    expect(pushed).toMatchObject({
      order: [{ field: 'id', direction: 'asc' }],
      limit: 2,
      filters: expect.arrayContaining([
        { field: 'scopes', op: 'all_inside', value: [] },
        { field: 'retentionState', op: 'eq', value: 'retained' },
        { field: 'sourceKind', op: 'in', value: ['copilot.thread'] },
        { field: 'tags', op: 'contains_all', value: ['session'] },
        { field: 'tags', op: 'contains_none', value: ['archived'] },
      ]),
    })

    query.mockClear()
    const second = await memory.browse({ ...request, limit: 2, cursor: first.nextCursor })
    expect(second.items.map((episode) => episode.id)).toEqual(['episode-b'])
    expect(
      query.mock.calls.map(([candidate]) => candidate).find((item) => item.kind === 'episode')
        ?.startAfter,
    ).toEqual(['episode-a'])

    query.mockClear()
    const newestFirst = await memory.browse({ ...request, order: 'newest', limit: 1 })
    const newestSecond = await memory.browse({
      ...request,
      order: 'newest',
      limit: 1,
      cursor: newestFirst.nextCursor,
    })
    expect([newestFirst.items[0]?.id, newestSecond.items[0]?.id]).toEqual([
      'episode-a',
      'episode-b',
    ])
    expect(
      query.mock.calls
        .map(([candidate]) => candidate)
        .filter((item) => item.kind === 'episode')
        .at(-1),
    ).toMatchObject({
      order: [
        { field: 'receivedAt', direction: 'desc' },
        { field: 'id', direction: 'asc' },
      ],
      startAfter: ['2026-08-03T10:00:00.000Z', 'episode-a'],
    })
    query.mockRestore()

    for (const id of ['unicode-z', 'unicode-á']) {
      await memory.remember({
        id,
        kind: 'assertion',
        content: { type: 'text', text: `${id} ordering.` },
        source: { kind: 'unicode-order' },
      })
    }
    const unicode = await memory.browse({
      kind: 'episode',
      access,
      order: 'id',
      filters: { episodes: { source: { kinds: ['unicode-order'] } } },
      limit: 10,
    })
    expect(unicode.items.map((episode) => episode.id)).toEqual(['unicode-z', 'unicode-á'])
  })

  it('returns a complete bounded graph snapshot for downstream algorithms', async () => {
    const { memory, report, storage } = await seedGraph()
    const driver = storageDriver(storage)
    const space = (await driver.getSpace('space-1'))!
    await driver.commit({
      spaceId: 'space-1',
      expectedRevision: space.revision,
      puts: [
        {
          kindRecord: 'evidence',
          id: 'contradictory-evidence',
          spaceId: 'space-1',
          episodeId: 'graph',
          target: { kind: 'fact', id: report.facts.created[0]! },
          relation: 'contradicts',
          status: 'active',
          scopes: [],
          createdAt: '2026-08-03T00:00:00.000Z',
          operationId: 'fixture-contradiction',
        },
      ],
      semanticChange: {
        operationId: 'fixture-contradiction',
        operationKind: 'reprocess',
        phase: 'governance',
        partitions: [
          {
            scopes: [],
            affected: {
              episodeIds: ['graph'],
              entityIds: [],
              factIds: [report.facts.created[0]!],
            },
          },
        ],
      },
    })

    const snapshot = await memory.snapshot({ access, maxRecords: 100 })

    expect(snapshot).toMatchObject({
      complete: true,
      ontology: { id: 'test.open', version: '1' },
      scan: {
        records: expect.any(Number),
        bytes: expect.any(Number),
        limits: { maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 },
      },
      counts: { episodes: 1, entities: 3, facts: 2 },
    })
    expect(snapshot.entities.map((entity) => entity.id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(snapshot.facts.map((fact) => fact.predicate)).toEqual(['links_to', 'links_to'])
    expect(snapshot.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'contradictory-evidence', relation: 'contradicts' }),
      ]),
    )
    expect(snapshot.counts.evidence).toBe(snapshot.evidence.length)
    expect(snapshot.counts.records).toBeGreaterThanOrEqual(6)

    await expect(memory.snapshot({ access, maxRecords: 1 })).rejects.toSatisfy((error: unknown) =>
      MemoryError.is(error, 'result_too_large'),
    )
  })

  it('pages and exactly admits snapshot storage before output filtering', async () => {
    const { memory, storage } = await seedGraph()
    for (let index = 0; index < 17; index += 1) {
      await memory.remember({
        id: `snapshot-page-${index.toString().padStart(2, '0')}`,
        kind: 'text',
        content: { type: 'text', text: `Snapshot page ${index}.` },
        source: { kind: 'fixture' },
      })
    }
    await memory.remember({
      id: 'snapshot-private-row',
      kind: 'text',
      content: { type: 'text', text: 'Storage pushdown must hide this row.' },
      source: { kind: 'private-fixture' },
      scopes: ['private'],
    })

    const driver = storageDriver(storage)
    const query = vi.spyOn(driver, 'query')
    const exportRecords = vi.spyOn(driver, 'exportRecords')
    const snapshot = await memory.snapshot({ access, maxRecords: 100 })
    expect(snapshot.episodes).toHaveLength(18)
    expect(JSON.stringify(snapshot)).not.toContain('snapshot-private-row')
    expect(snapshot.scan).toMatchObject({
      records: expect.any(Number),
      bytes: expect.any(Number),
      limits: { maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 },
    })
    expect(snapshot.scan.records).toBeGreaterThan(16)
    expect(snapshot.scan.bytes).toBeGreaterThan(0)

    const snapshotKinds = new Set([
      'episode',
      'entity',
      'fact',
      'alias',
      'evidence',
      'derivation',
      'mention',
      'lifecycle',
      'merge',
    ])
    const scans = query.mock.calls
      .map(([request]) => request)
      .filter((request) => snapshotKinds.has(request.kind))
    expect(scans.length).toBeGreaterThan(9)
    for (const scan of scans) {
      expect(scan).toMatchObject({
        order: [{ field: 'id', direction: 'asc' }],
        limit: 16,
      })
    }
    expect(exportRecords).not.toHaveBeenCalled()

    const exact = await memory.snapshot({
      access,
      maxRecords: 100,
      scanLimits: {
        maxRecords: snapshot.scan.records,
        maxBytes: snapshot.scan.bytes,
      },
    })
    expect(exact.scan).toEqual({
      records: snapshot.scan.records,
      bytes: snapshot.scan.bytes,
      limits: {
        maxRecords: snapshot.scan.records,
        maxBytes: snapshot.scan.bytes,
      },
    })
    await expect(
      memory.snapshot({
        access,
        maxRecords: 100,
        scanLimits: {
          maxRecords: snapshot.scan.records - 1,
          maxBytes: snapshot.scan.bytes,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'snapshot_scan',
        dimension: 'records',
        required: snapshot.scan.records,
        maximum: snapshot.scan.records - 1,
      },
    })
    await expect(
      memory.snapshot({
        access,
        maxRecords: 100,
        scanLimits: {
          maxRecords: snapshot.scan.records,
          maxBytes: snapshot.scan.bytes - 1,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'snapshot_scan',
        dimension: 'bytes',
        required: snapshot.scan.bytes,
        maximum: snapshot.scan.bytes - 1,
      },
    })
    query.mockRestore()
    exportRecords.mockRestore()
  })

  it('bounds recall, graph expansion, and residual browse through one physical scan contract', async () => {
    const { memory, storage } = await seedGraph()
    for (let index = 0; index < 17; index += 1) {
      await memory.remember({
        id: `retrieval-page-${index.toString().padStart(2, '0')}`,
        kind: 'text',
        content: { type: 'text', text: `Retrieval page ${index}.` },
        source: { kind: 'fixture' },
      })
    }
    await memory.remember({
      id: 'retrieval-private-row',
      kind: 'text',
      content: { type: 'text', text: 'A private row must be filtered in storage.' },
      source: { kind: 'private-fixture' },
      scopes: ['private'],
    })

    const driver = storageDriver(storage)
    const query = vi.spyOn(driver, 'query')
    const exportRecords = vi.spyOn(driver, 'exportRecords')
    const recallRequest = {
      anchors: { entityIds: ['alpha'] },
      access,
      channels: {
        exact: true,
        lexical: false,
        semantic: false,
        graph: true,
        temporal: false,
      },
      graphDepth: 2,
      scanLimits: { maxRecords: 1_000, maxBytes: 16 * 1024 * 1024 },
    } as const
    const recall = await memory.recall(recallRequest)
    expect(recall.paths.length).toBeGreaterThan(0)
    expect(recall.scan).toMatchObject({
      records: expect.any(Number),
      bytes: expect.any(Number),
      limits: { maxRecords: 1_000, maxBytes: 16 * 1024 * 1024 },
    })
    expect(recall.scan.records).toBeGreaterThan(16)
    expect(recall.scan.bytes).toBeGreaterThan(0)
    expect(JSON.stringify(recall)).not.toContain('retrieval-private-row')

    const exactRecall = await memory.recall({
      ...recallRequest,
      scanLimits: { maxRecords: recall.scan.records, maxBytes: recall.scan.bytes },
    })
    expect(exactRecall.scan).toEqual({
      records: recall.scan.records,
      bytes: recall.scan.bytes,
      limits: { maxRecords: recall.scan.records, maxBytes: recall.scan.bytes },
    })
    await expect(
      memory.recall({
        ...recallRequest,
        scanLimits: { maxRecords: recall.scan.records - 1, maxBytes: recall.scan.bytes },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'recall_scan',
        dimension: 'records',
        required: recall.scan.records,
        maximum: recall.scan.records - 1,
      },
    })
    await expect(
      memory.recall({
        ...recallRequest,
        scanLimits: { maxRecords: recall.scan.records, maxBytes: recall.scan.bytes - 1 },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'recall_scan',
        dimension: 'bytes',
        required: recall.scan.bytes,
        maximum: recall.scan.bytes - 1,
      },
    })

    const entityPage = await memory.browse({
      kind: 'entity',
      access,
      order: 'id',
      limit: 1,
      scanLimits: { maxRecords: 1_000, maxBytes: 16 * 1024 * 1024 },
    })
    expect(entityPage.scan.records).toBeGreaterThan(16)
    await expect(
      memory.browse({
        kind: 'entity',
        access,
        order: 'id',
        limit: 1,
        scanLimits: {
          maxRecords: entityPage.scan.records - 1,
          maxBytes: entityPage.scan.bytes,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'browse_scan',
        dimension: 'records',
        required: entityPage.scan.records,
        maximum: entityPage.scan.records - 1,
      },
    })

    const episodeRevision = (await memory.stats()).snapshotRevision
    await expect(
      memory.browse({
        kind: 'episode',
        access,
        order: 'id',
        limit: 200,
        scanLimits: { maxRecords: 1, maxBytes: 1024 * 1024 },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'browse_scan',
        dimension: 'records',
        required: 2,
        maximum: 1,
      },
    })
    expect((await memory.stats()).snapshotRevision).toBe(episodeRevision)

    const neighborhood = await memory.neighborhood({
      entityId: 'alpha',
      access,
      depth: 2,
      scanLimits: { maxRecords: 1_000, maxBytes: 16 * 1024 * 1024 },
    })
    expect(neighborhood.scan).toEqual(recall.scan)
    const retrievalKinds = new Set([
      'episode',
      'entity',
      'fact',
      'alias',
      'evidence',
      'derivation',
      'mention',
      'lifecycle',
      'merge',
    ])
    const broadPages = query.mock.calls
      .map(([request]) => request)
      .filter(
        (request) =>
          retrievalKinds.has(request.kind) &&
          request.order?.[0]?.field === 'id' &&
          request.order[0].direction === 'asc',
      )
    expect(broadPages.length).toBeGreaterThan(9)
    expect(broadPages.some((request) => request.limit === 16)).toBe(true)
    expect(broadPages.every((request) => request.limit !== undefined && request.limit <= 16)).toBe(
      true,
    )
    expect(exportRecords).not.toHaveBeenCalled()
    query.mockRestore()
    exportRecords.mockRestore()
  })

  it('bulk-deletes an access-bounded selector only at its previewed revision', async () => {
    let now = '2026-08-01T00:00:00.000Z'
    const { memory } = harness({ now: () => new Date(now) })
    await memory.open({ create: true })
    for (const [id, group, instant] of [
      ['session-a', 'cluster-a', '2026-08-01T00:00:00.000Z'],
      ['session-b', 'cluster-a', '2026-08-02T00:00:00.000Z'],
      ['session-c', 'cluster-b', '2026-08-03T00:00:00.000Z'],
    ] as const) {
      now = instant
      await memory.remember({
        id,
        kind: 'assertion',
        content: { type: 'text', text: `${id} belongs to ${group}.` },
        source: { kind: 'peripheral.session' },
        tags: ['session', group],
        assertions: { entities: [{ id: `entity-${id}`, name: id }] },
      })
    }
    const where = {
      source: { kinds: ['peripheral.session'] },
      tags: { all: ['session', 'cluster-a'] },
      receivedAt: { until: '2026-08-03T00:00:00.000Z' },
    } as const
    await expect(
      memory.previewEpisodeDeletions({ where, access, maxMatches: 1 }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'result_too_large'))
    const emptyPreview = await memory.previewEpisodeDeletions({
      where: { tags: { all: ['missing-cluster'] } },
      access,
      maxMatches: 2,
    })
    expect(emptyPreview).toMatchObject({ episodes: [], work: { records: 0 } })
    expect(emptyPreview.selectionCursor).toBeUndefined()
    const preview = await memory.previewEpisodeDeletions({ where, access, maxMatches: 2 })
    expect(preview.episodes.map((episode) => episode.id)).toEqual(['session-a', 'session-b'])
    expect(preview.selectionCursor).toEqual(expect.any(String))
    const repeatedPreview = await memory.previewEpisodeDeletions({
      where,
      access,
      expectedRevision: preview.snapshotRevision,
      maxMatches: 2,
    })
    expect(repeatedPreview.episodes).toEqual(preview.episodes)
    expect(repeatedPreview.selectionCursor).toBe(preview.selectionCursor)

    await expect(
      memory.deleteEpisodes(
        { where, access, expectedRevision: preview.snapshotRevision, maxMatches: 1 },
        { operationId: 'delete-cluster-too-broad' },
      ),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'result_too_large'))

    const beforeMismatch = (await memory.stats()).snapshotRevision
    await expect(
      memory.deleteEpisodes(
        {
          where: { tags: { all: ['cluster-b'] } },
          access,
          expectedRevision: preview.snapshotRevision,
          maxMatches: 2,
          selectionCursor: preview.selectionCursor,
        },
        { operationId: 'delete-cluster-mismatch' },
      ),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'conflict'))
    expect((await memory.stats()).snapshotRevision).toBe(beforeMismatch)

    let whereReads = 0
    const deleteInput = {
      access,
      expectedRevision: preview.snapshotRevision,
      maxMatches: 2,
      selectionCursor: preview.selectionCursor,
    } as {
      where: typeof where
      access: typeof access
      expectedRevision: number
      maxMatches: number
      selectionCursor: string
    }
    Object.defineProperty(deleteInput, 'where', {
      enumerable: true,
      get: () => {
        whereReads += 1
        if (whereReads > 1) throw new Error('episode deletion selector was read more than once')
        return where
      },
    })
    const deleted = await memory.deleteEpisodes(deleteInput, { operationId: 'delete-cluster-a' })
    expect(whereReads).toBe(1)
    expect(deleted.affectedEpisodes).toEqual(['session-a', 'session-b'])
    expect(await memory.getEpisode('session-a', access)).toBeNull()
    expect(await memory.getEpisode('session-c', access)).toMatchObject({ id: 'session-c' })

    const replayed = await memory.deleteEpisodes(
      {
        where: {
          ...where,
          tags: { all: ['cluster-a', 'session', 'session'] },
        },
        access,
        expectedRevision: preview.snapshotRevision,
        maxMatches: 2,
        selectionCursor: preview.selectionCursor,
      },
      { operationId: 'delete-cluster-a' },
    )
    expect(replayed.operation.id).toBe(deleted.operation.id)
  })

  it('bounds grouped deletion planning without materializing an unrelated corpus', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'bulk-bounded-unrelated',
      kind: 'assertion',
      content: { type: 'text', text: 'A deliberately broad unrelated fact corpus.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'bulk-bounded-unrelated-entity', name: 'Unrelated' }],
        facts: Array.from({ length: 256 }, (_, index) => ({
          id: `bulk-bounded-unrelated-${index.toString().padStart(4, '0')}`,
          subject: { id: 'bulk-bounded-unrelated-entity' },
          predicate: `unrelated_${index.toString().padStart(4, '0')}`,
          object: { scalar: index },
        })),
      },
    })
    for (const id of ['bulk-bounded-a', 'bulk-bounded-b']) {
      await memory.remember({
        id,
        kind: 'assertion',
        content: { type: 'text', text: `${id} belongs to the bounded deletion group.` },
        source: { kind: 'peripheral.session' },
        tags: ['bulk-bounded'],
        assertions: {
          entities: [{ id: `${id}-entity`, name: id }],
          facts: [
            {
              id: `${id}-fact`,
              subject: { id: `${id}-entity` },
              predicate: 'belongs_to_bounded_group',
              object: { scalar: true },
            },
          ],
        },
      })
    }
    const where = {
      source: { kinds: ['peripheral.session'] },
      tags: { all: ['bulk-bounded'] },
    } as const
    const preview = await memory.snapshot({ access, filters: { episodes: where } })
    expect(preview.episodes.map((episode) => episode.id)).toEqual([
      'bulk-bounded-a',
      'bulk-bounded-b',
    ])

    const driver = storageDriver(storage)
    const originalQuery = driver.query.bind(driver)
    const query = vi
      .spyOn(driver, 'query')
      .mockImplementation(((request) => originalQuery(request)) as StorageDriver['query'])
    const exportRecords = vi
      .spyOn(driver, 'exportRecords')
      .mockRejectedValue(new Error('bulk deletion must remain indexed'))
    const beforeRevision = (await driver.getSpace('space-1'))!.revision

    await expect(
      memory.deleteEpisodes(
        {
          where,
          access,
          expectedRevision: preview.snapshotRevision,
          maxMatches: 2,
          workLimits: { maxRecords: 1 },
        },
        { operationId: 'bulk-bounded-admission' },
      ),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: { phase: 'derivation', dimension: 'records', required: 2, maximum: 1 },
    })
    await expect(driver.getSpace('space-1')).resolves.toMatchObject({ revision: beforeRevision })
    await expect(driver.get('episode', 'space-1', 'bulk-bounded-a')).resolves.toMatchObject({
      retentionState: 'retained',
    })

    query.mockClear()
    const deleted = await memory.deleteEpisodes(
      {
        where,
        access,
        expectedRevision: preview.snapshotRevision,
        maxMatches: 2,
        workLimits: { maxRecords: 128 },
      },
      { operationId: 'bulk-bounded-delete' },
    )
    expect(deleted).toMatchObject({
      affectedEpisodes: ['bulk-bounded-a', 'bulk-bounded-b'],
      purged: false,
      work: { limits: { maxRecords: 128 } },
    })
    expect(deleted.work.records).toBeGreaterThan(0)
    expect(deleted.work.records).toBeLessThanOrEqual(128)
    expect(deleted.work.bytes).toBeGreaterThan(0)
    expect(await memory.getEpisode('bulk-bounded-a', access)).toBeNull()
    expect(await memory.getEpisode('bulk-bounded-unrelated', access)).toMatchObject({
      id: 'bulk-bounded-unrelated',
    })
    expect(exportRecords).not.toHaveBeenCalled()

    const scans = query.mock.calls
      .map(([request]) => request)
      .filter((request) =>
        ['episode', 'evidence', 'mention', 'alias', 'derivation', 'fact', 'projection'].includes(
          request.kind,
        ),
      )
    expect(scans.length).toBeGreaterThan(0)
    expect(scans.every((request) => request.limit === 16)).toBe(true)
    expect(
      scans.some(
        (request) =>
          request.kind === 'episode' &&
          request.filters?.some((filter) => filter.field === 'sourceKind' && filter.op === 'in') &&
          request.filters?.some(
            (filter) => filter.field === 'tags' && filter.op === 'contains_all',
          ),
      ),
    ).toBe(true)
    for (const kind of ['evidence', 'mention'] as const) {
      expect(
        scans.some(
          (request) =>
            request.kind === kind &&
            request.filters?.some((filter) => filter.field === 'episodeId' && filter.op === 'in'),
        ),
      ).toBe(true)
    }
    expect(
      scans.some(
        (request) =>
          request.kind === 'alias' &&
          request.filters?.some(
            (filter) => filter.field === 'episodeIds' && filter.op === 'contains_any',
          ),
      ),
    ).toBe(true)
    expect(
      scans.some(
        (request) =>
          request.kind === 'evidence' &&
          request.filters?.some((filter) => filter.field === 'episodeId' && filter.op === 'eq'),
      ),
    ).toBe(false)

    const replayed = await memory.deleteEpisodes(
      {
        where,
        access,
        expectedRevision: preview.snapshotRevision,
        maxMatches: 2,
        workLimits: { maxRecords: 1 },
      },
      { operationId: 'bulk-bounded-delete' },
    )
    expect(replayed).toEqual(deleted)
    query.mockRestore()
    exportRecords.mockRestore()
  })

  it('hard-purges a grouped selector with the same revision and breadth guards', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    for (const [id, group] of [
      ['transient-a', 'cluster-a'],
      ['transient-b', 'cluster-a'],
      ['durable', 'cluster-b'],
    ] as const) {
      await memory.remember({
        id,
        kind: 'assertion',
        content: { type: 'text', text: `${id} is in ${group}.` },
        source: { kind: 'peripheral.session' },
        tags: [group],
        assertions: { entities: [{ id: `entity-${id}`, name: id }] },
      })
    }
    const episodes = {
      source: { kinds: ['peripheral.session'] },
      tags: { all: ['cluster-a'] },
    } as const
    const preview = await memory.snapshot({ access, filters: { episodes } })

    await expect(
      memory.hardPurge(
        { access, episodes, expectedRevision: preview.snapshotRevision, maxMatches: 1 },
        { operationId: 'purge-cluster-too-broad' },
      ),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'result_too_large'))
    expect(await memory.getEpisode('transient-a', access)).toMatchObject({ id: 'transient-a' })

    const purged = await memory.hardPurge(
      { access, episodes, expectedRevision: preview.snapshotRevision, maxMatches: 2 },
      { operationId: 'purge-cluster-a' },
    )
    expect(purged.affectedEpisodes).toEqual(['transient-a', 'transient-b'])
    expect(await memory.getEpisode('transient-a', access)).toBeNull()
    expect(await memory.getEpisode('durable', access)).toMatchObject({ id: 'durable' })
    expect(JSON.stringify(await memory.export({ access, complete: true }))).not.toContain(
      'transient-a',
    )
  })

  it('bounds hard-purge planning, reports exact work, and never exports the whole space', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'bounded-purge-target',
      kind: 'event',
      content: { type: 'event', name: 'transient', value: true },
      source: { kind: 'peripheral.session' },
      tags: ['bounded-purge'],
    })
    const where = { tags: { all: ['bounded-purge'] } } as const
    const preview = await memory.snapshot({ access, filters: { episodes: where } })
    const driver = storageDriver(storage)
    const before = (await driver.getSpace('space-1'))!.revision
    const exportRecords = vi
      .spyOn(driver, 'exportRecords')
      .mockRejectedValue(new Error('whole-space export is forbidden'))

    await expect(
      memory.hardPurge(
        {
          access,
          episodes: where,
          expectedRevision: preview.snapshotRevision,
          maxMatches: 1,
          workLimits: { maxRecords: 1 },
        },
        { operationId: 'bounded-purge-rejected' },
      ),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: { phase: 'derivation', dimension: 'records', required: 2, maximum: 1 },
    })
    expect((await driver.getSpace('space-1'))!.revision).toBe(before)
    await expect(driver.query({ kind: 'purge', spaceId: 'space-1' })).resolves.toEqual([])
    await expect(memory.getEpisode('bounded-purge-target', access)).resolves.toMatchObject({
      id: 'bounded-purge-target',
    })

    const query = vi.spyOn(driver, 'query')
    const purged = await memory.hardPurge(
      {
        access,
        episodes: where,
        expectedRevision: preview.snapshotRevision,
        maxMatches: 1,
        workLimits: {
          maxRecords: 500,
          maxBytes: 2 * 1024 * 1024,
          maxGraphNodes: 500,
          maxGraphEdges: 500,
        },
      },
      { operationId: 'bounded-purge-succeeded' },
    )
    expect(purged.work).toMatchObject({
      records: expect.any(Number),
      bytes: expect.any(Number),
      limits: {
        maxRecords: 500,
        maxBytes: 2 * 1024 * 1024,
        maxGraphNodes: 500,
        maxGraphEdges: 500,
      },
    })
    expect(purged.work.records).toBeGreaterThan(0)
    expect(purged.work.records).toBeLessThanOrEqual(500)
    expect(
      query.mock.calls.some(
        ([request]) =>
          request.limit === 16 &&
          ['episode', 'change', 'signal_change', 'operation'].includes(request.kind),
      ),
    ).toBe(true)
    expect(
      query.mock.calls
        .map(([request]) => request.limit)
        .filter((limit): limit is number => limit !== undefined && limit > 1),
    ).toEqual(expect.arrayContaining([16]))
    expect(exportRecords).not.toHaveBeenCalled()
    const [marker] = await driver.query({
      kind: 'purge',
      spaceId: 'space-1',
      filters: [{ field: 'state', op: 'eq', value: 'succeeded' }],
    })
    expect(marker).not.toHaveProperty('workLimits')
    query.mockRestore()
    exportRecords.mockRestore()
  })

  it('hard-purges the complete previewed target set of a signal group', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    for (const id of ['signal-target-a', 'signal-target-b', 'signal-target-kept']) {
      await memory.remember({
        id,
        kind: 'event',
        content: { type: 'event', name: 'observed', value: { id } },
        source: { kind: 'peripheral.session' },
      })
    }
    const beforeSignals = await memory.browseSignals({ access })
    await memory.putSignals({
      access,
      expectedRevision: beforeSignals.snapshotRevision,
      signals: ['signal-target-a', 'signal-target-b'].map((id) => ({
        namespace: 'retention.cluster',
        target: { kind: 'episode' as const, id },
        producer: { kind: 'algorithm' as const, id: 'dream', version: '1' },
        scopes: [],
        tags: ['cluster:stale'],
        basis: { episodeIds: [id] },
        value: { recommendation: 'forget' },
      })),
    })
    const where = {
      namespaces: ['retention.cluster'],
      tags: { all: ['cluster:stale'] },
    } as const
    const preview = await memory.browseSignals({ access, where, limit: 1 })
    expect(preview).toMatchObject({ total: 2, targetSelectionCursor: expect.any(String) })

    await expect(
      memory.hardPurge(
        {
          access,
          signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
          maxMatches: 1,
        },
        { operationId: 'signal-target-purge-too-broad' },
      ),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'result_too_large'))
    expect(await memory.getEpisode('signal-target-a', access)).toMatchObject({
      id: 'signal-target-a',
    })

    const purged = await memory.hardPurge(
      {
        access,
        signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
        maxMatches: 2,
      },
      { operationId: 'signal-target-purge' },
    )
    expect(purged.affectedEpisodes).toEqual(['signal-target-a', 'signal-target-b'])
    expect(await memory.getEpisode('signal-target-a', access)).toBeNull()
    expect(await memory.getEpisode('signal-target-kept', access)).toMatchObject({
      id: 'signal-target-kept',
    })
    expect(
      (await memory.browseSignals({ access, where, revisionView: 'history' })).signals,
    ).toEqual([])
  })

  it('soft-deletes exact signal-selected episode targets and consumes the signals atomically', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    for (const id of ['soft-signal-a', 'soft-signal-b', 'soft-signal-kept']) {
      await memory.remember({
        id,
        kind: 'event',
        content: { type: 'event', name: 'observed', value: { id } },
        source: { kind: 'peripheral.session' },
      })
    }
    const beforeSignals = await memory.browseSignals({ access })
    await memory.putSignals({
      access,
      expectedRevision: beforeSignals.snapshotRevision,
      signals: ['soft-signal-a', 'soft-signal-b'].map((id) => ({
        namespace: 'retention.soft-delete',
        target: { kind: 'episode' as const, id },
        producer: { kind: 'algorithm' as const, id: 'dream', version: '1' },
        scopes: [],
        tags: ['cluster:stale'],
        basis: { episodeIds: [id] },
        value: { recommendation: 'forget' },
      })),
    })
    const where = {
      namespaces: ['retention.soft-delete'],
      tags: { all: ['cluster:stale'] },
    } as const
    const preview = await memory.browseSignals({ access, where, limit: 1 })
    const semanticBaseline = await memory.snapshot({ access })
    expect(preview).toMatchObject({ total: 2, targetSelectionCursor: expect.any(String) })

    const beforeAdmission = (await storageDriver(storage).getSpace('space-1'))!.revision
    await expect(
      memory.deleteEpisodes(
        {
          access,
          signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
          maxMatches: 2,
          workLimits: { maxRecords: 1 },
        },
        { operationId: 'signal-target-soft-delete-admission' },
      ),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: { phase: 'derivation', dimension: 'records', required: 2, maximum: 1 },
    })
    await expect(storageDriver(storage).getSpace('space-1')).resolves.toMatchObject({
      revision: beforeAdmission,
    })

    await expect(
      memory.deleteEpisodes(
        {
          access,
          signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
          maxMatches: 1,
        },
        { operationId: 'signal-target-soft-delete-too-broad' },
      ),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'result_too_large'))
    expect(await memory.getEpisode('soft-signal-a', access)).toMatchObject({ id: 'soft-signal-a' })

    const deleted = await memory.deleteEpisodes(
      {
        access,
        signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
        maxMatches: 2,
        workLimits: { maxRecords: 128 },
      },
      { operationId: 'signal-target-soft-delete' },
    )
    expect(deleted).toMatchObject({
      affectedEpisodes: ['soft-signal-a', 'soft-signal-b'],
      work: { limits: { maxRecords: 128 } },
    })
    expect(deleted.work.records).toBeGreaterThan(0)
    expect(deleted.work.bytes).toBeGreaterThan(0)
    expect(await memory.getEpisode('soft-signal-a', access)).toBeNull()
    expect(await memory.getEpisode('soft-signal-kept', access)).toMatchObject({
      id: 'soft-signal-kept',
    })
    expect(await memory.browseSignals({ access, where })).toMatchObject({ total: 0, signals: [] })
    const signalHistory = await memory.browseSignals({
      access,
      where,
      revisionView: 'history',
    })
    expect(signalHistory.signals).toHaveLength(4)
    expect(signalHistory.signals.filter((signal) => signal.state === 'withdrawn')).toHaveLength(2)

    const semanticDelta = await memory.changes({
      access,
      cursor: semanticBaseline.changesCursor,
    })
    const signalDelta = await memory.signalChanges({
      access,
      cursor: preview.signalChangesCursor,
    })
    expect(semanticDelta.changes).toEqual([expect.objectContaining({ phase: 'governance' })])
    expect(signalDelta.changes).toEqual([expect.objectContaining({ action: 'withdraw' })])
    expect(signalDelta.changes[0]!.revision).toBe(semanticDelta.changes[0]!.revision)

    const replayed = await memory.deleteEpisodes(
      {
        access,
        signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
        maxMatches: 2,
        workLimits: { maxRecords: 1 },
      },
      { operationId: 'signal-target-soft-delete' },
    )
    expect(replayed).toEqual(deleted)
    await expect(memory.verifyIntegrity()).resolves.toMatchObject({ ok: true })
  })

  it('keeps signal-target expiry evaluation bound to the preview cursor', async () => {
    let now = '2026-08-01T00:00:00.000Z'
    const { memory } = harness({ now: () => new Date(now) })
    await memory.open({ create: true })
    await memory.remember({
      id: 'signal-expiry-preview-target',
      kind: 'event',
      content: { type: 'event', name: 'displayed', value: { kind: 'modal' } },
      source: { kind: 'peripheral.session' },
    })
    const baseline = await memory.browseSignals({ access })
    await memory.putSignals({
      access,
      expectedRevision: baseline.snapshotRevision,
      signals: [
        {
          namespace: 'retention.preview-expiry',
          target: { kind: 'episode', id: 'signal-expiry-preview-target' },
          producer: { kind: 'algorithm', id: 'dream', version: '1' },
          scopes: [],
          basis: { episodeIds: ['signal-expiry-preview-target'] },
          expiresAt: '2026-08-01T00:01:00.000Z',
          value: { recommendation: 'forget' },
        },
      ],
    })
    const where = { namespaces: ['retention.preview-expiry'] } as const
    const preview = await memory.browseSignals({ access, where })
    expect(preview).toMatchObject({ total: 1, targetSelectionCursor: expect.any(String) })

    now = '2026-08-01T00:02:00.000Z'
    const deleted = await memory.deleteEpisodes({
      access,
      signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
      maxMatches: 1,
      workLimits: { maxRecords: 32 },
    })
    expect(deleted.affectedEpisodes).toEqual(['signal-expiry-preview-target'])
    expect(await memory.getEpisode('signal-expiry-preview-target', access)).toBeNull()
  })

  it('rejects non-episode and stale signal selections before soft deletion', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    const report = await memory.remember({
      id: 'soft-signal-safety',
      kind: 'assertion',
      content: { type: 'text', text: 'A retained entity exists.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'soft-signal-entity', name: 'Retained' }] },
    })
    const baseline = await memory.browseSignals({ access })
    await memory.putSignals({
      access,
      expectedRevision: baseline.snapshotRevision,
      signals: [
        {
          namespace: 'retention.soft-delete-safety',
          target: { kind: 'entity', id: 'soft-signal-entity' },
          producer: { kind: 'manual', id: 'reviewer', version: '1' },
          scopes: [],
          basis: { episodeIds: ['soft-signal-safety'] },
          value: { recommendation: 'forget' },
        },
      ],
    })
    const where = { namespaces: ['retention.soft-delete-safety'] } as const
    const preview = await memory.browseSignals({ access, where })
    await expect(
      memory.deleteEpisodes({
        access,
        signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
        maxMatches: 1,
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))
    expect(await memory.getEpisode('soft-signal-safety', access)).toMatchObject({
      id: 'soft-signal-safety',
    })
    expect(await memory.getEntity(report.entities.created[0]!, access)).toMatchObject({
      id: 'soft-signal-entity',
    })

    await memory.remember({
      id: 'soft-signal-concurrent-write',
      kind: 'event',
      content: { type: 'event', name: 'unrelated', value: null },
      source: { kind: 'fixture' },
    })
    await expect(
      memory.deleteEpisodes({
        access,
        signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
        maxMatches: 1,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { requiresSignalBaseline: true },
    })
  })

  it('binds signal-target purge previews to filter, access, generation, and revision', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'bound-signal-target',
      kind: 'event',
      content: { type: 'event', name: 'displayed', value: { kind: 'modal' } },
      source: { kind: 'peripheral.session' },
    })
    const baseline = await memory.browseSignals({ access })
    await memory.putSignals({
      access,
      expectedRevision: baseline.snapshotRevision,
      signals: [
        {
          namespace: 'retention.bound',
          target: { kind: 'episode', id: 'bound-signal-target' },
          producer: { kind: 'manual', id: 'reviewer', version: '1' },
          scopes: [],
          tags: ['stale'],
          value: true,
        },
      ],
    })
    const where = { namespaces: ['retention.bound'], tags: { all: ['stale'] } } as const
    const preview = await memory.browseSignals({ access, where })

    await expect(
      memory.hardPurge({
        access,
        signalTargets: {
          where: { namespaces: ['retention.bound'], tags: { all: ['different'] } },
          selectionCursor: preview.targetSelectionCursor!,
        },
        maxMatches: 1,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { requiresSignalBaseline: true },
    })
    await expect(
      memory.hardPurge({
        access: privateAccess,
        signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
        maxMatches: 1,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { requiresSignalBaseline: true },
    })

    await memory.remember({
      id: 'signal-target-concurrent-write',
      kind: 'event',
      content: { type: 'event', name: 'unrelated', value: null },
      source: { kind: 'fixture' },
    })
    await expect(
      memory.hardPurge({
        access,
        signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
        maxMatches: 1,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { requiresSignalBaseline: true },
    })
    expect(await memory.getEpisode('bound-signal-target', access)).toMatchObject({
      id: 'bound-signal-target',
    })

    await memory.resetSpace({ confirmSpaceId: 'space-1' })
    const replacement = harness({ storage }).memory
    await replacement.open({ create: true })
    await expect(
      replacement.hardPurge({
        access,
        signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
        maxMatches: 1,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { requiresSignalBaseline: true },
    })
  })

  it('issues destructive signal selection cursors only for constrained active current views', async () => {
    let now = '2026-08-03T10:00:00.000Z'
    const { memory } = harness({ now: () => new Date(now) })
    await memory.open({ create: true })
    await memory.remember({
      id: 'selection-eligibility',
      kind: 'event',
      content: { type: 'event', name: 'visible', value: true },
      source: { kind: 'fixture' },
    })
    const baseline = await memory.browseSignals({ access })
    await memory.putSignals({
      access,
      expectedRevision: baseline.snapshotRevision,
      signals: [
        {
          namespace: 'retention.eligibility',
          target: { kind: 'episode', id: 'selection-eligibility' },
          producer: { kind: 'manual', id: 'reviewer', version: '1' },
          scopes: [],
          value: true,
          expiresAt: '2026-08-03T10:01:00.000Z',
        },
      ],
    })
    const where = { namespaces: ['retention.eligibility'] } as const
    expect((await memory.browseSignals({ access })).targetSelectionCursor).toBeUndefined()
    expect(
      (await memory.browseSignals({ access, where, revisionView: 'history' }))
        .targetSelectionCursor,
    ).toBeUndefined()
    expect(
      (await memory.browseSignals({ access, where, includeExpired: true })).targetSelectionCursor,
    ).toBeUndefined()

    const preview = await memory.browseSignals({ access, where })
    await expect(
      memory.hardPurge({
        access,
        signalTargets: {
          where: { ...where, states: ['withdrawn'] },
          selectionCursor: preview.targetSelectionCursor!,
        },
        maxMatches: 1,
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))
    await expect(
      memory.hardPurge({
        access,
        episodeIds: ['selection-eligibility'],
        signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
        maxMatches: 1,
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))

    now = '2026-08-03T10:02:00.000Z'
    const emptyPreview = await memory.browseSignals({ access, where })
    expect(emptyPreview.total).toBe(0)
    expect(emptyPreview.targetSelectionCursor).toBeUndefined()
    await expect(
      memory.hardPurge({
        access,
        signalTargets: { where, selectionCursor: preview.targetSelectionCursor! },
        maxMatches: 1,
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      details: { requiresSignalBaseline: true },
    })
  })

  it('requires deleted history to be selected and previewed explicitly before purge', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    for (const id of ['retained-session', 'deleted-session']) {
      await memory.remember({
        id,
        kind: 'event',
        content: { type: 'event', name: 'observed', value: id },
        source: { kind: 'peripheral.session' },
        tags: ['expired'],
      })
    }
    await memory.deleteEpisode({ episodeId: 'deleted-session', access })
    const currentWhere = { tags: { all: ['expired'] } } as const
    const currentPreview = await memory.snapshot({
      access,
      filters: { episodes: currentWhere },
    })
    expect(currentPreview.episodes.map((episode) => episode.id)).toEqual(['retained-session'])
    await memory.hardPurge({
      access,
      episodes: currentWhere,
      expectedRevision: currentPreview.snapshotRevision,
      maxMatches: 1,
    })

    const deletedWhere = {
      tags: { all: ['expired'] },
      retentionStates: ['deleted'],
    } as const
    const historyPreview = await memory.snapshot({
      access,
      view: { kind: 'history' },
      filters: { episodes: deletedWhere },
    })
    expect(historyPreview.episodes.map((episode) => episode.id)).toEqual(['deleted-session'])
    await memory.hardPurge({
      access,
      episodes: deletedWhere,
      expectedRevision: historyPreview.snapshotRevision,
      maxMatches: 1,
    })
    expect(
      (
        await memory.snapshot({
          access,
          view: { kind: 'history' },
          filters: { episodes: deletedWhere },
        })
      ).episodes,
    ).toEqual([])
  })

  it('keeps selector governance bounded to the caller-visible slice', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    for (const [id, scopes] of [
      ['public-session', []],
      ['private-session', ['private']],
    ] as const) {
      await memory.remember({
        id,
        kind: 'assertion',
        content: { type: 'text', text: id },
        source: { kind: 'peripheral.session' },
        scopes,
        tags: ['expired'],
        assertions: { entities: [{ id: `entity-${id}`, name: id }] },
      })
    }
    const episodes = { tags: { all: ['expired'] } } as const
    const preview = await memory.snapshot({ access, filters: { episodes } })
    expect(preview.episodes.map((episode) => episode.id)).toEqual(['public-session'])

    await memory.hardPurge({
      access,
      episodes,
      expectedRevision: preview.snapshotRevision,
      maxMatches: 1,
    })

    expect(await memory.getEpisode('public-session', privateAccess)).toBeNull()
    expect(await memory.getEpisode('private-session', privateAccess)).toMatchObject({
      id: 'private-session',
    })
  })

  it('does not re-evaluate a destructive selector after its preview revision changes', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'previewed',
      kind: 'event',
      content: { type: 'event', name: 'displayed', value: { kind: 'modal' } },
      source: { kind: 'peripheral.session' },
      tags: ['transient'],
    })
    const where = { tags: { all: ['transient'] } } as const
    const preview = await memory.snapshot({ access, filters: { episodes: where } })
    await memory.remember({
      id: 'concurrent-write',
      kind: 'event',
      content: { type: 'event', name: 'unrelated', value: null },
      source: { kind: 'fixture' },
    })

    await expect(
      memory.deleteEpisodes({
        where,
        access,
        expectedRevision: preview.snapshotRevision,
        maxMatches: 1,
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'conflict'))
    expect(await memory.getEpisode('previewed', access)).toMatchObject({ id: 'previewed' })
  })

  it('rejects misspelled, empty, and ambiguous destructive selectors', async () => {
    const { memory } = harness()
    await memory.open({ create: true })

    await expect(
      memory.browse({
        kind: 'episode',
        access,
        filters: { episdoes: { tags: { all: ['x'] } } } as never,
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))
    await expect(
      memory.deleteEpisodes({ where: {}, access, expectedRevision: 0, maxMatches: 1 }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))
    await expect(
      memory.hardPurge({
        access,
        episodeIds: ['x'],
        episodes: { tags: { all: ['x'] } },
        expectedRevision: 0,
        maxMatches: 1,
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))
    await expect(
      memory.hardPurge({
        access,
        before: '2026-08-04T00:00:00.000Z',
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))
    await expect(
      memory.hardPurge({ access, episodeIds: ['x'], workLimit: { maxRecords: 1 } } as never),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))
  })

  it('browses typed records with stable revision-bound cursors', async () => {
    const { memory } = await seedGraph()

    const first = await memory.browse({ kind: 'entity', access, order: 'id', limit: 2 })
    expect(first.items.map((item) => item.id)).toEqual(['alpha', 'beta'])
    expect(first.nextCursor).toEqual(expect.any(String))

    const second = await memory.browse({
      kind: 'entity',
      access,
      order: 'id',
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.items.map((item) => item.id)).toEqual(['gamma'])
    expect(second.snapshotRevision).toBe(first.snapshotRevision)
    expect(second.generatedAt).toBe(first.generatedAt)
  })

  it('binds browse cursors to canonical request and access semantics, but not page size', async () => {
    const { memory } = await seedGraph()
    const first = await memory.browse({
      kind: 'entity',
      access,
      order: 'id',
      filters: { entities: { ids: ['beta', 'alpha'] } },
      limit: 1,
    })
    expect(first.items.map((item) => item.id)).toEqual(['alpha'])

    const second = await memory.browse({
      kind: 'entity',
      access,
      order: 'id',
      filters: { entities: { ids: ['alpha', 'beta', 'alpha'] } },
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.items.map((item) => item.id)).toEqual(['beta'])

    for (const changed of [
      {
        kind: 'entity' as const,
        access: privateAccess,
        order: 'id' as const,
        filters: { entities: { ids: ['alpha', 'beta'] } },
      },
      {
        kind: 'entity' as const,
        access,
        order: 'id' as const,
        filters: { entities: { ids: ['alpha', 'gamma'] } },
      },
      {
        kind: 'entity' as const,
        access,
        order: 'id' as const,
        view: { kind: 'history' as const },
        filters: { entities: { ids: ['alpha', 'beta'] } },
      },
      {
        kind: 'entity' as const,
        access,
        order: 'id' as const,
        conflictPolicy: 'exclude' as const,
        filters: { entities: { ids: ['alpha', 'beta'] } },
      },
      {
        kind: 'entity' as const,
        access,
        order: 'newest' as const,
        filters: { entities: { ids: ['alpha', 'beta'] } },
      },
    ]) {
      await expect(memory.browse({ ...changed, cursor: first.nextCursor })).rejects.toSatisfy(
        (error: unknown) => MemoryError.is(error, 'conflict'),
      )
    }
  })

  it('keeps current-view evaluation time fixed across browse pages', async () => {
    let now = '2026-08-03T10:00:00.000Z'
    const { memory } = harness({ now: () => new Date(now) })
    await memory.open({ create: true })
    await memory.remember({
      id: 'clock-page',
      kind: 'assertion',
      content: { type: 'text', text: 'Three facts share one bounded validity window.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'clock-root', name: 'Clock Root' }],
        facts: ['a', 'b', 'c'].map((suffix) => ({
          id: `fact-${suffix}`,
          subject: { id: 'clock-root' },
          predicate: `clock_${suffix}`,
          object: { scalar: suffix },
          validTime: {
            from: '2026-08-01T00:00:00.000Z',
            to: '2026-08-04T00:00:00.000Z',
          },
        })),
      },
    })

    const first = await memory.browse({ kind: 'fact', access, order: 'id', limit: 1 })
    expect(first.items.map((item) => item.id)).toEqual(['fact-a'])
    expect(first.generatedAt).toBe('2026-08-03T10:00:00.000Z')

    now = '2026-08-05T10:00:00.000Z'
    const second = await memory.browse({
      kind: 'fact',
      access,
      order: 'id',
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.items.map((item) => item.id)).toEqual(['fact-b', 'fact-c'])
    expect(second.generatedAt).toBe(first.generatedAt)
  })

  it('invalidates a browse cursor after reset and recreation at the same revision', async () => {
    const firstHarness = harness()
    await firstHarness.memory.open({ create: true })
    const stalePeer = harness({ storage: firstHarness.storage })
    await stalePeer.memory.open()
    const input = {
      id: 'generation-page',
      kind: 'assertion' as const,
      content: { type: 'text' as const, text: 'Two generation-bound entities.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          { id: 'generation-a', name: 'Generation A' },
          { id: 'generation-b', name: 'Generation B' },
        ],
      },
    }
    await firstHarness.memory.remember(input)
    const oldPage = await firstHarness.memory.browse({
      kind: 'entity',
      access,
      order: 'id',
      limit: 1,
    })
    await firstHarness.memory.resetSpace({ confirmSpaceId: 'space-1' })

    const recreated = harness({ storage: firstHarness.storage })
    await recreated.memory.open({ create: true })
    await recreated.memory.remember(input)
    const newPage = await recreated.memory.browse({
      kind: 'entity',
      access,
      order: 'id',
      limit: 1,
    })
    expect(newPage.snapshotRevision).toBe(oldPage.snapshotRevision)

    await expect(
      recreated.memory.browse({
        kind: 'entity',
        access,
        order: 'id',
        limit: 1,
        cursor: oldPage.nextCursor,
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'conflict'))

    await expect(stalePeer.memory.getEpisode('generation-page', access)).rejects.toMatchObject({
      code: 'conflict',
      details: { requiresReopen: true },
    })
    await stalePeer.memory.close()
    await stalePeer.memory.open()
    expect(await stalePeer.memory.getEpisode('generation-page', access)).toMatchObject({
      id: 'generation-page',
    })
  })

  it('preflights and streams destructive reset reports under exact scan limits', async () => {
    const seed = async () => {
      const context = harness()
      await context.memory.open({ create: true })
      for (let index = 0; index < 17; index += 1) {
        const id = `reset-scan-${index.toString().padStart(2, '0')}`
        await context.memory.remember({
          id: `${id}-episode`,
          kind: 'assertion',
          content: { type: 'text', text: `${id} is resettable.` },
          source: { kind: 'fixture' },
          assertions: { entities: [{ id, name: id }] },
        })
      }
      return context
    }

    const baseline = await seed()
    const baselineDriver = storageDriver(baseline.storage)
    const baselineExport = vi
      .spyOn(baselineDriver, 'exportRecords')
      .mockRejectedValue(new Error('reset must not use whole-space export'))
    const baselineQueries = vi.spyOn(baselineDriver, 'query')
    const report = await baseline.memory.resetSpace({
      confirmSpaceId: 'space-1',
      scanLimits: { maxRecords: 1_000, maxBytes: 16 * 1024 * 1024 },
    })

    expect(report.scan.records).toBe(
      report.affectedEpisodes.length +
        report.affectedEntities.length +
        report.affectedFacts.length +
        report.projectionsInvalidated,
    )
    expect(report.scan.records).toBeGreaterThan(17)
    expect(report.scan.bytes).toBeGreaterThan(0)
    expect(report.affectedEpisodes).toHaveLength(17)
    expect(report.affectedEntities).toHaveLength(17)
    expect(baselineExport).not.toHaveBeenCalled()
    expect(
      baselineQueries.mock.calls
        .map(([query]) => query)
        .filter((query) => ['episode', 'entity', 'fact', 'projection'].includes(query.kind))
        .every((query) => query.limit !== undefined && query.limit <= 16),
    ).toBe(true)

    const recordLimited = await seed()
    const recordDriver = storageDriver(recordLimited.storage)
    const recordExport = vi
      .spyOn(recordDriver, 'exportRecords')
      .mockRejectedValue(new Error('reset must not use whole-space export'))
    await expect(
      recordLimited.memory.resetSpace({
        confirmSpaceId: 'space-1',
        scanLimits: {
          maxRecords: report.scan.records - 1,
          maxBytes: report.scan.bytes,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'reset_scan',
        dimension: 'records',
        required: report.scan.records,
        maximum: report.scan.records - 1,
      },
    })
    expect(recordExport).not.toHaveBeenCalled()
    await expect(
      recordLimited.memory.getEpisode('reset-scan-00-episode', access),
    ).resolves.toMatchObject({ id: 'reset-scan-00-episode' })
    const recordRetry = await recordLimited.memory.resetSpace({
      confirmSpaceId: 'space-1',
      scanLimits: { maxRecords: report.scan.records, maxBytes: report.scan.bytes },
    })
    expect(recordRetry.scan).toMatchObject({
      records: report.scan.records,
      bytes: report.scan.bytes,
    })

    const byteLimited = await seed()
    const byteDriver = storageDriver(byteLimited.storage)
    const byteExport = vi
      .spyOn(byteDriver, 'exportRecords')
      .mockRejectedValue(new Error('reset must not use whole-space export'))
    await expect(
      byteLimited.memory.resetSpace({
        confirmSpaceId: 'space-1',
        scanLimits: {
          maxRecords: report.scan.records,
          maxBytes: report.scan.bytes - 1,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'reset_scan',
        dimension: 'bytes',
        required: report.scan.bytes,
        maximum: report.scan.bytes - 1,
      },
    })
    expect(byteExport).not.toHaveBeenCalled()
    await expect(
      byteLimited.memory.getEpisode('reset-scan-00-episode', access),
    ).resolves.toMatchObject({ id: 'reset-scan-00-episode' })
    const byteRetry = await byteLimited.memory.resetSpace({
      confirmSpaceId: 'space-1',
      scanLimits: { maxRecords: report.scan.records, maxBytes: report.scan.bytes },
    })
    expect(byteRetry.scan).toMatchObject({
      records: report.scan.records,
      bytes: report.scan.bytes,
    })
  })

  it('returns common revision and evaluation lineage for recall and neighborhood', async () => {
    const { memory } = await seedGraph()
    const recall = await memory.recall({
      anchors: { entityIds: ['alpha'] },
      access,
      channels: { exact: true, lexical: false, semantic: false, graph: true, temporal: false },
    })
    const neighborhood = await memory.neighborhood({ entityId: 'alpha', access })

    expect(recall).toMatchObject({
      spaceId: 'space-1',
      snapshotRevision: expect.any(Number),
      generatedAt: '2026-08-03T10:00:00.000Z',
    })
    expect(neighborhood).toMatchObject({
      snapshotRevision: recall.snapshotRevision,
      generatedAt: recall.generatedAt,
    })
  })

  it('fails a browse cursor closed after the snapshot changes', async () => {
    const { memory } = await seedGraph()
    const first = await memory.browse({ kind: 'entity', access, order: 'id', limit: 1 })
    await memory.remember({
      id: 'later',
      kind: 'assertion',
      content: { type: 'text', text: 'Delta arrives later.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'delta', name: 'Delta' }] },
    })

    await expect(
      memory.browse({
        kind: 'entity',
        access,
        order: 'id',
        limit: 1,
        cursor: first.nextCursor,
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'conflict'))
  })

  it('reports evidence-backed structural and provenance analysis', async () => {
    const { memory } = await seedGraph()
    await memory.remember({
      id: 'private',
      kind: 'assertion',
      content: { type: 'text', text: 'A restricted isolated node.' },
      source: { kind: 'private-fixture' },
      scopes: ['private'],
      assertions: { entities: [{ id: 'private-node', name: 'Private Node' }] },
    })

    const report = await memory.analyze({ access, top: 10 })

    expect(report.overview).toMatchObject({ episodes: 1, entities: 3, facts: 2 })
    expect(report.provenance.bySourceKind).toEqual({ fixture: 1 })
    expect(report.graph).toMatchObject({ nodes: 3, edges: 2, components: 1 })
    expect(report.graph.topEntities.find((item) => item.id === 'beta')?.degree).toBe(2)
    expect(report.algorithms.graph).toBe('structural-pagerank-v1')
    expect(JSON.stringify(report)).not.toMatch(/private-node|private-fixture/u)
  })

  it('supports bounded seed-weighted personalized analysis without widening visibility', async () => {
    const { memory } = await seedGraph()
    await memory.remember({
      id: 'private-personalization',
      kind: 'assertion',
      content: { type: 'text', text: 'A private seed.' },
      source: { kind: 'private-fixture' },
      scopes: ['private'],
      assertions: { entities: [{ id: 'private-seed', name: 'Private Seed' }] },
    })

    const structural = await memory.analyze({ access, top: 10 })
    const personalized = await memory.analyze({
      access,
      top: 10,
      pagerank: { seeds: [{ id: 'alpha', weight: 2 }] },
      budgets: {
        maxScannedRecords: 100,
        maxScannedBytes: 100_000,
        maxAnalyzedRecords: 11,
        maxGraphNodes: 3,
        maxGraphEdges: 2,
        maxPageRankSteps: 200,
        maxTemporalComparisons: 1,
      },
    })

    expect(personalized.algorithms).toMatchObject({
      graph: 'personalized-pagerank-v1',
      personalized: true,
      seedCount: 1,
    })
    expect(personalized.work).toEqual({
      scannedRecords: 21,
      scannedBytes: expect.any(Number),
      analyzedRecords: 11,
      graphNodes: 3,
      graphEdges: 2,
      pageRankSteps: expect.any(Number),
      temporalComparisons: 0,
      limits: {
        maxScannedRecords: 100,
        maxScannedBytes: 100_000,
        maxAnalyzedRecords: 11,
        maxGraphNodes: 3,
        maxGraphEdges: 2,
        maxPageRankSteps: 200,
        maxTemporalComparisons: 1,
      },
    })
    expect(personalized.work.scannedBytes).toBeLessThanOrEqual(100_000)
    expect(personalized.work.pageRankSteps).toBeLessThanOrEqual(200)
    expect(
      personalized.graph.topEntities.find((item) => item.id === 'alpha')!.pageRank,
    ).toBeGreaterThan(structural.graph.topEntities.find((item) => item.id === 'alpha')!.pageRank)
    expect(JSON.stringify(personalized)).not.toContain('private-seed')

    await expect(
      memory.analyze({ access, budgets: { maxAnalyzedRecords: 10 } }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: { actual: 11, limit: 10 },
    })
    await expect(memory.analyze({ access, budgets: { maxGraphNodes: 2 } })).rejects.toMatchObject({
      code: 'result_too_large',
      details: { actual: 3, limit: 2 },
    })
    await expect(memory.analyze({ access, budgets: { maxGraphEdges: 1 } })).rejects.toMatchObject({
      code: 'result_too_large',
      details: { actual: 2, limit: 1 },
    })
    await expect(
      memory.analyze({ access, budgets: { maxPageRankSteps: 199 } }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: { actual: 200, limit: 199 },
    })
    await expect(
      memory.analyze({ access, pagerank: { seeds: [{ id: 'private-seed' }] } }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(memory.analyze({ access, pagerank: { seeds: [] } })).rejects.toMatchObject({
      code: 'invalid_input',
    })
    await expect(
      memory.analyze({
        access,
        budgets: { maxGraphNodes: 3, unknown: 1 } as never,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('pages and exactly admits every physical analysis row before post-filtering', async () => {
    const { memory, storage } = await seedGraph()
    for (let index = 0; index < 40; index += 1) {
      await memory.remember({
        id: `analysis-page-${index.toString().padStart(2, '0')}`,
        kind: 'text',
        content: { type: 'text', text: `Analysis page ${index}.` },
        source: { kind: 'fixture' },
      })
    }
    const signalBaseline = await memory.stats()
    const firstSignal = await memory.putSignals({
      access,
      expectedRevision: signalBaseline.snapshotRevision,
      signals: [
        {
          namespace: 'analysis.scan',
          slot: 'history',
          target: { kind: 'episode', id: 'graph' },
          producer: { kind: 'manual', id: 'analysis-fixture', version: '1' },
          scopes: [],
          value: { revision: 1 },
        },
      ],
    })
    await memory.putSignals({
      access,
      expectedRevision: firstSignal.revision,
      signals: [
        {
          namespace: 'analysis.scan',
          slot: 'history',
          target: { kind: 'episode', id: 'graph' },
          producer: { kind: 'manual', id: 'analysis-fixture', version: '2' },
          scopes: [],
          value: { revision: 2 },
        },
      ],
    })

    const driver = storageDriver(storage)
    const query = vi.spyOn(driver, 'query')
    const exportRecords = vi.spyOn(driver, 'exportRecords')
    const report = await memory.analyze({ access })

    expect(report).toMatchObject({
      overview: { episodes: 41 },
      signals: { active: 1 },
      work: {
        scannedRecords: expect.any(Number),
        scannedBytes: expect.any(Number),
      },
    })
    expect(report.work.scannedRecords).toBeGreaterThan(report.work.analyzedRecords)
    expect(report.work.scannedBytes).toBeGreaterThan(0)
    const scanKinds = new Set([
      'episode',
      'entity',
      'fact',
      'alias',
      'evidence',
      'derivation',
      'mention',
      'lifecycle',
      'merge',
      'signal',
    ])
    const scans = query.mock.calls
      .map(([request]) => request)
      .filter((request) => scanKinds.has(request.kind))
    expect(scans.length).toBeGreaterThan(10)
    for (const scan of scans) {
      expect(scan.limit).toBe(16)
      expect(scan.order).toEqual(
        scan.kind === 'signal'
          ? [
              { field: 'key', direction: 'asc' },
              { field: 'version', direction: 'desc' },
              { field: 'id', direction: 'desc' },
            ]
          : [{ field: 'id', direction: 'asc' }],
      )
    }
    expect(exportRecords).not.toHaveBeenCalled()

    const exact = await memory.analyze({
      access,
      budgets: {
        maxScannedRecords: report.work.scannedRecords,
        maxScannedBytes: report.work.scannedBytes,
      },
    })
    expect(exact.work).toMatchObject({
      scannedRecords: report.work.scannedRecords,
      scannedBytes: report.work.scannedBytes,
    })
    await expect(
      memory.analyze({
        access,
        budgets: {
          maxScannedRecords: report.work.scannedRecords - 1,
          maxScannedBytes: report.work.scannedBytes,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'analysis_scan',
        dimension: 'records',
        required: report.work.scannedRecords,
        maximum: report.work.scannedRecords - 1,
      },
    })
    await expect(
      memory.analyze({
        access,
        budgets: {
          maxScannedRecords: report.work.scannedRecords,
          maxScannedBytes: report.work.scannedBytes - 1,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'analysis_scan',
        dimension: 'bytes',
        required: report.work.scannedBytes,
        maximum: report.work.scannedBytes - 1,
      },
    })
    query.mockRestore()
    exportRecords.mockRestore()
  })

  it('rejects an analysis assembled across a paged-scan write race', async () => {
    const { memory, storage } = await seedGraph()
    for (let index = 0; index < 17; index += 1) {
      await memory.remember({
        id: `analysis-race-page-${index.toString().padStart(2, '0')}`,
        kind: 'text',
        content: { type: 'text', text: `Analysis race page ${index}.` },
        source: { kind: 'fixture' },
      })
    }
    const peer = harness({ storage }).memory
    await peer.open()
    const driver = storageDriver(storage)
    const originalQuery = driver.query.bind(driver)
    let raced = false
    const query = vi.spyOn(driver, 'query').mockImplementation(async (request) => {
      const result = await originalQuery(request)
      if (!raced && request.kind === 'episode' && request.limit === 16) {
        raced = true
        await peer.remember(
          {
            id: 'analysis-race-writer',
            kind: 'text',
            content: { type: 'text', text: 'Concurrent analysis write.' },
            source: { kind: 'fixture' },
          },
          { operationId: 'analysis-race-peer-operation' },
        )
      }
      return result
    })

    await expect(memory.analyze({ access })).rejects.toSatisfy(
      (error: unknown) => MemoryError.is(error, 'conflict') && error.retryable,
    )
    expect(raced).toBe(true)
    query.mockRestore()
  })

  it('bounds cardinality-one overlap comparisons independently of finding output', async () => {
    const { memory } = harness({ ontology: WORK_ONTOLOGY })
    await memory.open({ create: true })
    for (const [index, company] of ['acme', 'globex', 'initech'].entries()) {
      await memory.remember({
        id: `employment-${index}`,
        kind: 'assertion',
        content: { type: 'text', text: `Alice works at ${company}.` },
        source: { kind: 'fixture' },
        assertions: {
          entities: [
            { id: 'alice', name: 'Alice', types: ['Person'] },
            { id: company, name: company, types: ['Company'] },
          ],
          facts: [
            {
              subject: { id: 'alice' },
              predicate: 'works_at',
              object: { id: company },
              type: 'Employment',
            },
          ],
        },
      })
    }

    await expect(
      memory.analyze({ access, budgets: { maxTemporalComparisons: 1 } }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: { actual: 2, limit: 1 },
    })
    const report = await memory.analyze({
      access,
      top: 2,
      budgets: { maxTemporalComparisons: 3 },
    })
    expect(report.work.temporalComparisons).toBe(3)
    expect(report.temporal.overlappingCardinalityOnePairs).toBe(3)
    expect(report.findings.map((finding) => finding.code)).toEqual(['conflict', 'temporal_overlap'])
    expect(report.findingSummary).toEqual({
      total: 7,
      returned: 2,
      truncated: true,
      byCode: {
        conflict: 1,
        derived_only: 0,
        isolated_entity: 0,
        single_source: 3,
        temporal_overlap: 3,
      },
    })
  })

  it('applies search target before top-k selection', async () => {
    const { memory } = await seedGraph()

    const result = await memory.search({
      query: 'links_to',
      access,
      target: 'facts',
      limit: 1,
      channels: { exact: true, lexical: false, semantic: false, graph: false, temporal: true },
    })

    expect(result.items).toHaveLength(1)
    expect(result.items[0]?.kind).toBe('fact')
    expect(result.context.facts).toHaveLength(1)
  })

  it('keeps withdrawn provenance visible only to historical analysis', async () => {
    const { memory, report } = await seedGraph()
    await memory.retractFact({ factId: report.facts.created[0]!, allSupport: true, access })

    const current = await memory.analyze({ access })
    const history = await memory.analyze({ access, view: { kind: 'history' } })

    expect(current.overview.withdrawnEvidence).toBe(0)
    expect(history.overview.withdrawnEvidence).toBeGreaterThan(0)
    expect(history.overview.facts).toBe(2)
  })

  it('computes deterministic PageRank, components, and degree metrics', () => {
    const report = analyzeStructuralGraph(
      ['c', 'a', 'b', 'isolated'],
      [
        { id: 'ab', source: 'a', target: 'b' },
        { id: 'bc', source: 'b', target: 'c' },
      ],
    )

    expect(report.componentCount).toBe(2)
    expect(report.nodes.find((item) => item.id === 'b')).toMatchObject({
      degree: 2,
      inDegree: 1,
      outDegree: 1,
    })
    expect(report.nodes.reduce((total, item) => total + item.pageRank, 0)).toBeCloseTo(1, 10)
    expect(report.converged).toBe(true)
    expect(report).toMatchObject({ edgeCount: 2, arcCount: 2, density: 0.125 })

    const parallel = analyzeStructuralGraph(
      ['a', 'b'],
      [
        { id: 'ab-1', source: 'a', target: 'b' },
        { id: 'ab-2', source: 'a', target: 'b' },
      ],
    )
    expect(parallel).toMatchObject({ edgeCount: 2, arcCount: 1, density: 0.25 })
  })

  it('normalizes deterministic personalized PageRank over disconnected components', () => {
    const edges = [
      { id: 'ab', source: 'a', target: 'b' },
      { id: 'xy', source: 'x', target: 'y' },
    ]
    const first = analyzeStructuralGraph(['y', 'b', 'x', 'a'], edges, {
      seeds: [
        { id: 'a', weight: 3 },
        { id: 'b', weight: 1 },
      ],
    })
    const reordered = analyzeStructuralGraph(['a', 'x', 'b', 'y'], [...edges].reverse(), {
      seeds: [
        { id: 'b', weight: 1 },
        { id: 'a', weight: 3 },
      ],
    })

    expect(first).toEqual(reordered)
    expect(first).toMatchObject({ personalized: true, seedCount: 2 })
    expect(first.nodes.reduce((total, item) => total + item.pageRank, 0)).toBeCloseTo(1, 10)
    expect(first.nodes.find((item) => item.id === 'x')?.pageRank).toBe(0)
    expect(first.nodes.find((item) => item.id === 'y')?.pageRank).toBe(0)
    expect(() => analyzeStructuralGraph(['a'], [], { seeds: [{ id: 'missing' }] })).toThrow(
      RangeError,
    )
  })
})
