import { describe, expect, it } from 'vitest'

import { createMemory, MemoryError, type EmbeddingProvider } from '../src/index.ts'
import {
  defineMemoryStorage,
  storageDriver,
  type StorageDriver,
  type StorageQuery,
} from '../src/storage/driver.ts'
import { createInMemoryStorage } from '../src/testing/index.ts'
import { harness, WORK_ONTOLOGY } from './support.ts'

const access = { allowedScopes: [] as string[] }

async function seedTimeline(
  scopes: readonly string[] = [],
  options: { now?: () => Date; beforeSecond?: () => void } = {},
) {
  const { memory } = harness({ ontology: WORK_ONTOLOGY, now: options.now })
  await memory.open({ create: true })
  const first = await memory.remember({
    id: 'ep-acme',
    kind: 'assertion',
    content: { type: 'text', text: 'Alice worked at Acme as an engineer.' },
    source: { kind: 'fixture', title: 'Acme note' },
    scopes,
    tags: ['career'],
    assertions: {
      entities: [
        { id: 'alice', name: 'Alice', aliases: ['A. Example'], types: ['Person'] },
        { id: 'acme', name: 'Acme', types: ['Company'] },
      ],
      facts: [
        {
          subject: { id: 'alice' },
          predicate: 'works_at',
          object: { id: 'acme' },
          type: 'Employment',
          validTime: { from: '2024-01-01T00:00:00.000Z' },
        },
      ],
    },
  })
  options.beforeSecond?.()
  const second = await memory.remember({
    id: 'ep-globex',
    kind: 'assertion',
    content: { type: 'text', text: 'Alice joined Globex as a researcher.' },
    source: { kind: 'fixture', title: 'Globex note' },
    scopes,
    tags: ['career'],
    assertions: {
      entities: [
        { id: 'alice', name: 'Alice', aliases: ['A. Example'], types: ['Person'] },
        { id: 'globex', name: 'Globex', types: ['Company'] },
      ],
      facts: [
        {
          subject: { id: 'alice' },
          predicate: 'works_at',
          object: { id: 'globex' },
          type: 'Employment',
          validTime: { from: '2026-01-01T00:00:00.000Z' },
        },
      ],
    },
  })
  return { memory, firstFact: first.facts.created[0]!, secondFact: second.facts.created[0]! }
}

describe('temporal hybrid retrieval', () => {
  it('pushes active merge selection to storage and skips merges outside the current view', async () => {
    const base = createInMemoryStorage()
    const driver = storageDriver(base)
    const mergeFilters: (StorageQuery<'merge'>['filters'] | undefined)[] = []
    const observing = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'query') {
          return async (query: StorageQuery) => {
            if (query.kind === 'merge') mergeFilters.push(query.filters)
            return target.query(query)
          }
        }
        const value = Reflect.get(target, property, receiver) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as StorageDriver
    const memory = createMemory({
      spaceId: 'active-merge-filter',
      storage: defineMemoryStorage(observing),
    })
    await memory.open({ create: true })
    await memory.remember({
      id: 'merge-filter-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Source and target are distinct.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          { id: 'merge-source', name: 'Merge Source' },
          { id: 'merge-target', name: 'Merge Target' },
        ],
      },
    })
    await memory.mergeEntities({
      targetId: 'merge-target',
      sourceIds: ['merge-source'],
      access,
    })

    mergeFilters.length = 0
    await memory.recall({
      anchors: { entityIds: ['merge-source'] },
      access,
      channels: { exact: true, lexical: false, graph: false, temporal: false },
    })
    expect(mergeFilters).toEqual([[{ field: 'active', op: 'eq', value: true }]])

    mergeFilters.length = 0
    await memory.recall({
      anchors: { entityIds: ['merge-source'] },
      access,
      view: { kind: 'history' },
      channels: { exact: true, lexical: false, graph: false, temporal: false },
    })
    expect(mergeFilters).toEqual([])
  })

  it('AC10 distinguishes current, valid-time, known-time, and history views', async () => {
    let instant = '2025-01-01T00:00:00.000Z'
    const { memory, firstFact, secondFact } = await seedTimeline([], {
      now: () => new Date(instant),
      beforeSecond: () => {
        instant = '2027-01-01T00:00:00.000Z'
      },
    })
    instant = '2028-01-01T00:00:00.000Z'

    const current = await memory.recall({
      anchors: { factIds: [firstFact, secondFact] },
      access,
      channels: { exact: true, lexical: false, graph: false, temporal: false },
    })
    expect(current.facts.map((fact) => fact.id)).toEqual([secondFact])

    const historical = await memory.recall({
      anchors: { factIds: [firstFact, secondFact] },
      access,
      view: { kind: 'valid-at', at: '2025-06-01T00:00:00.000Z' },
      channels: { exact: true, lexical: false, graph: false, temporal: false },
    })
    expect(historical.facts.map((fact) => fact.id)).toEqual([firstFact])

    const knownBeforeChange = await memory.recall({
      anchors: { factIds: [firstFact, secondFact] },
      access,
      view: { kind: 'known-at', at: '2026-01-01T00:00:00.000Z' },
      channels: { exact: true, lexical: false, graph: false, temporal: false },
    })
    expect(knownBeforeChange.facts.map((fact) => fact.id)).toEqual([firstFact])

    const history = await memory.recall({
      anchors: { factIds: [firstFact, secondFact] },
      access,
      view: { kind: 'history' },
      channels: { exact: true, lexical: false, graph: false, temporal: false },
    })
    expect(history.facts.map((fact) => fact.id).sort()).toEqual([firstFact, secondFact].sort())
  })

  it('AC11 and AC12 fuse lexical and graph candidates with stable source provenance', async () => {
    const { memory, secondFact } = await seedTimeline()

    const result = await memory.recall({ query: 'Globex researcher', access, graphDepth: 1 })

    expect(result.facts.map((fact) => fact.id)).toContain(secondFact)
    expect(result.entities.map((entity) => entity.id)).toEqual(
      expect.arrayContaining(['alice', 'globex']),
    )
    expect(result.citations).toMatchObject({
      m1: expect.objectContaining({ item: expect.any(Object), episodeIds: expect.any(Array) }),
    })
    const factCitation = Object.values(result.citations).find(
      (citation) => citation.item.kind === 'fact' && citation.item.id === secondFact,
    )
    expect(factCitation?.episodeIds).toEqual(['ep-globex'])
    expect(result.rendered).toContain('[m')
    expect(result.explanation.channels).toEqual(expect.arrayContaining(['lexical', 'graph']))
  })

  it('AC13 makes disallowed scopes non-observable across results and diagnostics', async () => {
    const { memory, secondFact } = await seedTimeline(['private'])

    const denied = await memory.recall({ query: 'Globex', access })

    expect(denied.entities).toEqual([])
    expect(denied.facts).toEqual([])
    expect(denied.episodes).toEqual([])
    expect(denied.rendered).not.toContain('Globex')
    expect(JSON.stringify(denied.explanation)).not.toContain(secondFact)
  })

  it('keeps scoped embedding projections non-observable to an unauthorized recall', async () => {
    const embeddings: EmbeddingProvider = {
      lineage: {
        provider: 'fixture',
        model: 'constant-vector',
        destination: 'local',
        dimensions: 2,
      },
      embed: async ({ texts }) => texts.map(() => [1, 0]),
    }
    const { memory } = harness({ embeddings })
    await memory.open({ create: true })
    await memory.remember({
      id: 'public-embedding',
      kind: 'assertion',
      content: { type: 'text', text: 'Public semantic target.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'public-target', name: 'Public semantic target' }] },
    })
    await memory.remember({
      id: 'private-embedding',
      kind: 'assertion',
      content: { type: 'text', text: 'Private semantic target.' },
      source: { kind: 'fixture' },
      scopes: ['private'],
      assertions: { entities: [{ id: 'private-target', name: 'Private semantic target' }] },
    })

    const result = await memory.recall({
      query: 'semantic target',
      access,
      channels: { exact: false, lexical: false, semantic: true, graph: false, temporal: false },
    })

    expect(result.entities.map((entity) => entity.id)).toContain('public-target')
    expect(JSON.stringify(result)).not.toContain('private-target')
  })

  it('AC04/11 uses injected embeddings without exposing provider machinery in context', async () => {
    const embeddings: EmbeddingProvider = {
      lineage: {
        provider: 'fixture',
        model: 'two-axis',
        destination: 'local',
        dimensions: 2,
      },
      embed: async ({ texts }) =>
        texts.map((text) =>
          /research|globex/iu.test(text) ? [1, 0] : /alice|acme/iu.test(text) ? [0.5, 0.5] : [0, 1],
        ),
    }
    const { memory } = harness({ ontology: WORK_ONTOLOGY, embeddings })
    await memory.open({ create: true })
    await memory.remember({
      id: 'ep-1',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice studies distributed systems.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'alice', name: 'Alice', types: ['Person'] }] },
    })

    const result = await memory.recall({
      query: 'research topic',
      access,
      channels: { exact: false, lexical: false, semantic: true, graph: false, temporal: false },
    })

    expect(result.entities.map((entity) => entity.id)).toContain('alice')
    expect(result.explanation.channels).toContain('semantic')
    expect(JSON.stringify(result)).not.toContain('two-axis')
  })

  it('fails recall closed when memory changes during provider-backed ranking', async () => {
    let concurrentWrite: (() => Promise<unknown>) | undefined
    const embeddings: EmbeddingProvider = {
      lineage: {
        provider: 'fixture',
        model: 'mutating-query-v1',
        destination: 'local',
        dimensions: 2,
      },
      embed: async ({ purpose, texts }) => {
        if (purpose === 'query' && concurrentWrite !== undefined) {
          const write = concurrentWrite
          concurrentWrite = undefined
          await write()
        }
        return texts.map(() => [1, 0])
      },
    }
    const { memory } = harness({ embeddings })
    await memory.open({ create: true })
    await memory.remember({
      id: 'recall-basis',
      kind: 'assertion',
      content: { type: 'text', text: 'Provider-backed coherent recall basis.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'basis', name: 'Basis' }] },
    })

    concurrentWrite = () =>
      memory.remember({
        id: 'recall-drift',
        kind: 'assertion',
        content: { type: 'text', text: 'This write races provider-backed recall.' },
        source: { kind: 'fixture' },
        assertions: { entities: [{ id: 'drift', name: 'Drift' }] },
      })
    await expect(
      memory.recall({
        query: 'basis',
        access,
        channels: { exact: false, lexical: false, semantic: true, graph: false, temporal: false },
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'conflict') && error.retryable)
    expect(await memory.getEpisode('recall-drift', access)).toMatchObject({ id: 'recall-drift' })
  })

  it('AC23 retains coherent local recall when providers are absent', async () => {
    const { memory, secondFact } = await seedTimeline()

    const result = await memory.recall({ query: 'Globex', access, rerank: true })

    expect(result.facts.map((fact) => fact.id)).toContain(secondFact)
    expect(result.degraded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: 'embedding' }),
        expect.objectContaining({ capability: 'rerank' }),
      ]),
    )
  })
})
