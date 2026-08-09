import { describe, expect, it, vi } from 'vitest'

import type { RememberInput } from '../src/index.ts'

import { storageDriver } from '../src/storage/driver.ts'
import { harness, WORK_ONTOLOGY } from './support.ts'

function employment(
  episodeId: string,
  company: { id: string; name: string },
  from?: string,
): RememberInput {
  return {
    id: episodeId,
    idempotencyKey: episodeId,
    kind: 'assertion',
    content: { type: 'text', text: `Alice works at ${company.name}` },
    source: { kind: 'test' },
    assertions: {
      entities: [
        { id: 'alice', name: 'Alice', types: ['Person'], aliases: ['A. Example'] },
        { ...company, types: ['Company'] },
      ],
      facts: [
        {
          subject: { id: 'alice' },
          predicate: 'works_at',
          object: { id: company.id },
          type: 'Employment',
          ...(from === undefined ? {} : { validTime: { from } }),
        },
      ],
    },
  }
}

describe('canonical ingestion', () => {
  it('AC03 and AC06 ingest an explicit assertion into entities, aliases, facts, and evidence', async () => {
    const { memory } = harness({ ontology: WORK_ONTOLOGY })
    await memory.open({ create: true })

    const report = await memory.remember(employment('ep-1', { id: 'acme', name: 'Acme' }))

    expect(report.operation.state).toBe('succeeded')
    expect(report.entities.created).toEqual(['alice', 'acme'])
    expect(report.facts.created).toHaveLength(1)
    await expect(memory.getEntity('alice', { allowedScopes: [] })).resolves.toMatchObject({
      name: 'Alice',
      aliases: expect.arrayContaining([expect.objectContaining({ value: 'A. Example' })]),
    })
    const fact = await memory.getFact(report.facts.created[0]!, { allowedScopes: [] })
    expect(fact).toMatchObject({
      subjectId: 'alice',
      predicate: 'works_at',
      object: { kind: 'entity', entityId: 'acme' },
      status: 'active',
    })
    expect(fact?.evidence.map((item) => item.episodeId)).toEqual(['ep-1'])
  })

  it('AC05 retries the same accepted identity without duplicating canonical knowledge', async () => {
    const { memory } = harness({ ontology: WORK_ONTOLOGY })
    await memory.open({ create: true })
    const input = employment('ep-1', { id: 'acme', name: 'Acme' })

    const first = await memory.remember(input)
    const second = await memory.remember(structuredClone(input))

    expect(second.episode.id).toBe(first.episode.id)
    expect(await memory.stats()).toMatchObject({ episodes: 1, entities: 2, facts: 1 })
  })

  it('AC07 attaches repeated evidence without multiplying an equivalent fact', async () => {
    const { memory } = harness({ ontology: WORK_ONTOLOGY })
    await memory.open({ create: true })
    const first = await memory.remember(employment('ep-1', { id: 'acme', name: 'Acme' }))
    const second = await memory.remember(employment('ep-2', { id: 'acme', name: 'Acme' }))

    expect(second.facts.repeated).toEqual(first.facts.created)
    expect((await memory.stats()).facts).toBe(1)
    const fact = await memory.getFact(first.facts.created[0]!, { allowedScopes: [] })
    expect(fact?.evidence.map((item) => item.episodeId)).toEqual(['ep-1', 'ep-2'])
  })

  it('bounds automatic projection provenance with exact independently reported scan work', async () => {
    const input: RememberInput = {
      id: 'projection-bounded',
      idempotencyKey: 'projection-bounded',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice works at Acme.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          { id: 'alice', name: 'Alice', aliases: ['A. Example'], types: ['Person'] },
          { id: 'acme', name: 'Acme', types: ['Company'] },
        ],
        facts: [
          {
            id: 'projection-bounded-fact',
            subject: { id: 'alice' },
            predicate: 'works_at',
            object: { id: 'acme' },
            type: 'Employment',
          },
        ],
      },
    }
    const run = async (limits: { maxRecords: number; maxBytes: number }) => {
      const context = harness({ ontology: WORK_ONTOLOGY })
      await context.memory.open({ create: true })
      const driver = storageDriver(context.storage)
      const exportRecords = vi
        .spyOn(driver, 'exportRecords')
        .mockRejectedValue(new Error('automatic projection must not export canonical memory'))
      const queries = vi.spyOn(driver, 'query')
      const report = await context.memory.remember(input, {
        operationId: 'projection-bounded-operation',
        projectionScanLimits: limits,
      })
      expect(exportRecords).not.toHaveBeenCalled()
      expect(
        queries.mock.calls
          .map(([request]) => request)
          .filter((request) => ['alias', 'evidence', 'projection'].includes(request.kind))
          .every((request) => request.limit !== undefined && request.limit <= 16),
      ).toBe(true)
      return { ...context, driver, report }
    }

    const generous = { maxRecords: 1_000, maxBytes: 16 * 1024 * 1024 }
    const baseline = await run(generous)
    expect(baseline.report.operation.state).toBe('succeeded')
    expect(baseline.report.projectionScan).toMatchObject({ limits: generous })
    expect(baseline.report.projectionScan.records).toBeGreaterThan(1)
    expect(baseline.report.projectionScan.bytes).toBeGreaterThan(1)

    const exact = await run({
      maxRecords: baseline.report.projectionScan.records,
      maxBytes: baseline.report.projectionScan.bytes,
    })
    expect(exact.report.operation.state).toBe('succeeded')
    expect(exact.report.projectionScan.records).toBe(baseline.report.projectionScan.records)
    expect(exact.report.projectionScan.bytes).toBe(baseline.report.projectionScan.bytes)

    const recordLimited = await run({
      maxRecords: baseline.report.projectionScan.records - 1,
      maxBytes: baseline.report.projectionScan.bytes,
    })
    expect(recordLimited.report.operation).toMatchObject({
      state: 'partial',
      stage: 'projection_scan_failed',
      error: { code: 'result_too_large' },
    })
    expect(recordLimited.report.projectionScan.records).toBe(
      baseline.report.projectionScan.records - 1,
    )
    await expect(
      recordLimited.driver.count({ kind: 'projection', spaceId: 'space-1' }),
    ).resolves.toBe(0)
    await expect(
      recordLimited.memory.getFact('projection-bounded-fact', { allowedScopes: [] }),
    ).resolves.toMatchObject({ id: 'projection-bounded-fact' })

    const byteLimited = await run({
      maxRecords: baseline.report.projectionScan.records,
      maxBytes: baseline.report.projectionScan.bytes - 1,
    })
    expect(byteLimited.report.operation).toMatchObject({
      state: 'partial',
      stage: 'projection_scan_failed',
      error: { code: 'result_too_large' },
    })
    expect(byteLimited.report.projectionScan.bytes).toBeLessThan(
      baseline.report.projectionScan.bytes,
    )
    await expect(
      byteLimited.driver.count({ kind: 'projection', spaceId: 'space-1' }),
    ).resolves.toBe(0)
  })

  it('AC08 supersedes a cardinality-one fact from a known later valid start', async () => {
    const { memory } = harness({ ontology: WORK_ONTOLOGY })
    await memory.open({ create: true })
    const first = await memory.remember(
      employment('ep-1', { id: 'acme', name: 'Acme' }, '2024-01-01T00:00:00.000Z'),
    )
    const second = await memory.remember(
      employment('ep-2', { id: 'globex', name: 'Globex' }, '2026-01-01T00:00:00.000Z'),
    )

    expect(second.facts.superseded).toEqual(first.facts.created)
    await expect(
      memory.getFact(first.facts.created[0]!, { allowedScopes: [] }),
    ).resolves.toMatchObject({
      status: 'superseded',
      validTime: { from: '2024-01-01T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
    })
  })

  it('orders a late-arriving historical fact by valid time rather than arrival time', async () => {
    const { memory } = harness({ ontology: WORK_ONTOLOGY })
    await memory.open({ create: true })
    const later = await memory.remember(
      employment('ep-later', { id: 'globex', name: 'Globex' }, '2026-01-01T00:00:00.000Z'),
    )
    const lateHistorical = await memory.remember(
      employment('ep-late-history', { id: 'acme', name: 'Acme' }, '2024-01-01T00:00:00.000Z'),
    )
    const historicalFact = lateHistorical.facts.created[0]!

    expect(lateHistorical.facts.superseded).toContain(historicalFact)
    expect(await memory.getFact(historicalFact, { allowedScopes: [] })).toMatchObject({
      status: 'superseded',
      supersededBy: later.facts.created[0],
      validTime: {
        from: '2024-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      },
    })
    const at2025 = await memory.recall({
      anchors: { factIds: [historicalFact, later.facts.created[0]!] },
      access: { allowedScopes: [] },
      view: { kind: 'valid-at', at: '2025-01-01T00:00:00.000Z' },
      channels: { exact: true, lexical: false, graph: false, temporal: false },
    })
    expect(at2025.facts.map((fact) => fact.id)).toEqual([historicalFact])
  })

  it('AC09 preserves an unresolved cardinality conflict when valid time is unknown', async () => {
    const { memory } = harness({ ontology: WORK_ONTOLOGY })
    await memory.open({ create: true })
    const first = await memory.remember(employment('ep-1', { id: 'acme', name: 'Acme' }))
    const second = await memory.remember(employment('ep-2', { id: 'globex', name: 'Globex' }))

    expect(second.facts.disputed).toContain(first.facts.created[0])
    expect(second.facts.disputed).toContain(second.facts.created[0])
    expect(await memory.getFact(first.facts.created[0]!, { allowedScopes: [] })).toMatchObject({
      status: 'disputed',
    })
  })

  it('AC13 never exposes a record without all required scopes', async () => {
    const { memory } = harness({ ontology: WORK_ONTOLOGY })
    await memory.open({ create: true })
    const input = employment('ep-1', { id: 'acme', name: 'Acme' })
    input.scopes = ['origin:acme.test', 'private']
    const report = await memory.remember(input)

    await expect(
      memory.getEpisode('ep-1', { allowedScopes: ['origin:acme.test'] }),
    ).resolves.toBeNull()
    await expect(
      memory.getFact(report.facts.created[0]!, {
        allowedScopes: ['origin:acme.test', 'private'],
      }),
    ).resolves.toMatchObject({ predicate: 'works_at' })
  })

  it('plans ingestion through bounded indexed truth maintenance without whole-space export', async () => {
    const seed = async () => {
      const context = harness({
        ontology: {
          ...WORK_ONTOLOGY,
          factTypes: {
            ...WORK_ONTOLOGY.factTypes,
            DerivedEmployment: {
              predicate: 'derived_from_employment',
              subjectTypes: ['Person'],
              object: { kind: 'scalar', valueType: 'boolean' },
            },
          },
        },
      })
      await context.memory.open({ create: true })
      for (let index = 0; index < 17; index += 1) {
        await context.memory.remember({
          id: `unrelated-${index.toString().padStart(2, '0')}`,
          idempotencyKey: `unrelated-${index.toString().padStart(2, '0')}`,
          kind: 'assertion',
          content: { type: 'text', text: `Unrelated ${index}` },
          source: { kind: 'fixture' },
          assertions: {
            entities: [{ id: `unrelated-${index}`, name: `Unrelated ${index}` }],
            facts: [
              {
                id: `unrelated-fact-${index}`,
                subject: { id: `unrelated-${index}` },
                predicate: 'unrelated',
                object: { scalar: index },
              },
            ],
          },
        })
      }
      const source = await context.memory.remember(
        employment('bounded-source', { id: 'acme', name: 'Acme' }, '2024-01-01T00:00:00.000Z'),
      )
      await context.memory.deriveFact(
        {
          conclusion: {
            id: 'bounded-derived',
            subjectId: 'alice',
            predicate: 'derived_from_employment',
            object: { kind: 'scalar', value: true },
            type: 'DerivedEmployment',
          },
          rule: { id: 'bounded-ingestion-rule', version: '1' },
          premises: [{ kind: 'fact', id: source.facts.created[0]! }],
          access: { allowedScopes: [] },
          expectedRevision: (await context.memory.stats()).snapshotRevision,
        },
        { operationId: 'bounded-ingestion-derive' },
      )
      return { ...context, sourceFactId: source.facts.created[0]! }
    }
    const target = employment(
      'bounded-target',
      { id: 'globex', name: 'Globex' },
      '2026-01-01T00:00:00.000Z',
    )
    const generous = {
      maxRecords: 1_000,
      maxBytes: 16 * 1024 * 1024,
      maxGraphNodes: 1_000,
      maxGraphEdges: 1_000,
    }

    const baseline = await seed()
    const baselineDriver = storageDriver(baseline.storage)
    const baselineExport = vi
      .spyOn(baselineDriver, 'exportRecords')
      .mockRejectedValue(new Error('ingestion must not use whole-space export'))
    const baselineQueries = vi.spyOn(baselineDriver, 'query')
    const report = await baseline.memory.remember(target, {
      operationId: 'bounded-ingestion-target',
      workLimits: generous,
    })

    expect(report.operation.state).toBe('succeeded')
    expect(report.work).toMatchObject({
      records: expect.any(Number),
      bytes: expect.any(Number),
      graphNodes: expect.any(Number),
      graphEdges: expect.any(Number),
      limits: generous,
    })
    expect(report.work.records).toBeGreaterThan(1)
    expect(report.work.bytes).toBeGreaterThan(1)
    expect(report.work.graphNodes).toBeGreaterThanOrEqual(2)
    expect(report.work.graphEdges).toBeGreaterThanOrEqual(1)
    expect(baselineExport).not.toHaveBeenCalled()
    expect(
      baselineQueries.mock.calls
        .map(([query]) => query)
        .filter((query) => query.kind === 'derivation')
        .every((query) => query.limit !== undefined && query.limit <= 16),
    ).toBe(true)
    await expect(baselineDriver.get('fact', 'space-1', 'bounded-derived')).resolves.toMatchObject({
      status: 'retracted',
    })

    const recordLimited = await seed()
    const recordDriver = storageDriver(recordLimited.storage)
    const recordExport = vi
      .spyOn(recordDriver, 'exportRecords')
      .mockRejectedValue(new Error('ingestion must not use whole-space export'))
    const beforeRecordLimit = await recordLimited.memory.stats()
    const recordFailure = await recordLimited.memory.remember(target, {
      operationId: 'bounded-ingestion-record-limit',
      workLimits: { ...report.work.limits, maxRecords: report.work.records - 1 },
    })
    expect(recordFailure.operation).toMatchObject({
      state: 'failed',
      stage: 'canonical_failed',
      diagnosticsTruncated: true,
      error: { code: 'result_too_large' },
    })
    expect(recordFailure.work.records).toBe(report.work.records - 1)
    expect(recordExport).not.toHaveBeenCalled()
    await expect(
      recordLimited.memory.getFact(recordLimited.sourceFactId, { allowedScopes: [] }),
    ).resolves.toMatchObject({ status: 'active' })
    await expect(
      recordLimited.memory.getFact('bounded-derived', { allowedScopes: [] }),
    ).resolves.toMatchObject({ status: 'active' })
    await expect(
      recordLimited.memory.getEntity('globex', { allowedScopes: [] }),
    ).resolves.toBeNull()
    expect(await recordLimited.memory.stats()).toMatchObject({
      episodes: beforeRecordLimit.episodes + 1,
      entities: beforeRecordLimit.entities,
      facts: beforeRecordLimit.facts,
      derivations: beforeRecordLimit.derivations,
    })
    const recordRetry = await recordLimited.memory.retryEpisode('bounded-target', {
      operationId: 'bounded-ingestion-record-retry',
      workLimits: report.work.limits,
    })
    expect(recordRetry.operation.state).toBe('succeeded')
    expect(recordRetry.work).toEqual(report.work)

    const byteLimited = await seed()
    const byteDriver = storageDriver(byteLimited.storage)
    const byteExport = vi
      .spyOn(byteDriver, 'exportRecords')
      .mockRejectedValue(new Error('ingestion must not use whole-space export'))
    const byteFailure = await byteLimited.memory.remember(target, {
      operationId: 'bounded-ingestion-byte-limit',
      workLimits: { ...report.work.limits, maxBytes: report.work.bytes - 1 },
    })
    expect(byteFailure.operation.error).toMatchObject({
      code: 'result_too_large',
    })
    expect(byteFailure.operation.diagnosticsTruncated).toBe(true)
    expect(byteFailure.work.bytes).toBeLessThan(report.work.bytes)
    expect(byteExport).not.toHaveBeenCalled()
    const byteRetry = await byteLimited.memory.retryEpisode('bounded-target', {
      operationId: 'bounded-ingestion-byte-retry',
      workLimits: report.work.limits,
    })
    expect(byteRetry.operation.state).toBe('succeeded')
    expect(byteRetry.work).toEqual(report.work)
  })
})
