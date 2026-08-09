import { describe, expect, it, vi } from 'vitest'

import {
  defineMemoryStorage,
  storageDriver,
  type StorageCommit,
  type StorageDriver,
  type StoredDerivation,
  type StoredEvidence,
  type StoredFact,
} from '../src/storage/driver.ts'
import { harness } from './support.ts'

const access = { allowedScopes: [] as string[] }

async function seedTwoFacts(options: Parameters<typeof harness>[0] = {}) {
  const context = harness(options)
  await context.memory.open({ create: true })
  const report = await context.memory.remember({
    id: 'source-episode',
    kind: 'assertion',
    content: { type: 'text', text: 'Alice has source facts A and B.' },
    source: { kind: 'fixture' },
    assertions: {
      entities: [{ id: 'alice', name: 'Alice' }],
      facts: [
        {
          id: 'fact-a',
          subject: { id: 'alice' },
          predicate: 'source_a',
          object: { scalar: true },
        },
        {
          id: 'fact-b',
          subject: { id: 'alice' },
          predicate: 'source_b',
          object: { scalar: true },
        },
      ],
    },
  })
  expect(report.facts.created).toEqual(['fact-a', 'fact-b'])
  return context
}

async function revision(memory: Awaited<ReturnType<typeof seedTwoFacts>>['memory']) {
  return (await memory.stats()).snapshotRevision
}

describe('maintained rule derivations', () => {
  it('registers queryable derived support and round-trips its current state', async () => {
    const { memory } = await seedTwoFacts()
    const input = {
      conclusion: {
        id: 'derived-c',
        subjectId: 'alice',
        predicate: 'derived_c',
        object: { kind: 'scalar' as const, value: true },
      },
      rule: { id: 'rules/a-implies-c', version: '1' },
      premises: [{ kind: 'fact' as const, id: 'fact-a' }],
      access,
      expectedRevision: await revision(memory),
    }
    const report = await memory.deriveFact(input, { operationId: 'derive-c' })

    expect(report).toMatchObject({
      outcome: 'created',
      conclusion: { id: 'derived-c', status: 'active' },
      derivation: { state: 'active', conclusionFactId: 'derived-c' },
    })
    await expect(memory.getFact('derived-c', access)).resolves.toMatchObject({
      id: 'derived-c',
      evidence: [],
      derivations: [{ id: report.derivation.id, state: 'active' }],
    })
    await expect(memory.deriveFact(input, { operationId: 'derive-c' })).resolves.toEqual(report)

    const analysis = await memory.analyze({ access })
    expect(analysis.findings).toContainEqual(
      expect.objectContaining({ code: 'derived_only', items: [{ kind: 'fact', id: 'derived-c' }] }),
    )
    const archive = await memory.export({ access, complete: true })
    expect(archive).toMatchObject({ formatVersion: 4 })
    expect(archive.canonical.derivations).toHaveLength(1)

    const restored = harness()
    await restored.memory.open({ create: true })
    await restored.memory.import(archive)
    await expect(restored.memory.getFact('derived-c', access)).resolves.toMatchObject({
      status: 'active',
      derivations: [{ state: 'active', version: 1 }],
    })
    await expect(restored.memory.verifyIntegrity()).resolves.toMatchObject({ ok: true })
  })

  it('atomically registers an ordered bounded multi-conclusion rule activation', async () => {
    const { memory, storage } = await seedTwoFacts()
    const before = await revision(memory)
    const input = {
      derivations: [
        {
          conclusion: {
            id: 'batch-derived-c',
            subjectId: 'alice',
            predicate: 'batch_derived_c',
            object: { kind: 'scalar' as const, value: true },
          },
          rule: { id: 'rules/a-implies-c-and-b-implies-d', version: '1' },
          premises: [{ kind: 'fact' as const, id: 'fact-a' }],
        },
        {
          conclusion: {
            id: 'batch-derived-d',
            subjectId: 'alice',
            predicate: 'batch_derived_d',
            object: { kind: 'scalar' as const, value: true },
          },
          rule: { id: 'rules/a-implies-c-and-b-implies-d', version: '1' },
          premises: [{ kind: 'fact' as const, id: 'fact-b' }],
        },
      ],
      access,
      expectedRevision: before,
    }
    const report = await memory.deriveFacts(input, { operationId: 'derive-c-and-d' })

    expect(report.results.map((result) => result.conclusion.id)).toEqual([
      'batch-derived-c',
      'batch-derived-d',
    ])
    expect(report.results.map((result) => result.outcome)).toEqual(['created', 'created'])
    expect(
      report.results.map((result) => [
        result.derivation.operationId,
        result.derivation.recordedRevision,
      ]),
    ).toEqual([
      ['derive-c-and-d', before + 1],
      ['derive-c-and-d', before + 1],
    ])
    await expect(revision(memory)).resolves.toBe(before + 1)
    await expect(memory.deriveFacts(input, { operationId: 'derive-c-and-d' })).resolves.toEqual(
      report,
    )
    await expect(
      storageDriver(storage).query({
        kind: 'change',
        spaceId: 'space-1',
        filters: [{ field: 'operationId', op: 'eq', value: 'derive-c-and-d' }],
      }),
    ).resolves.toHaveLength(1)
    await expect(memory.export({ access, complete: true })).resolves.toMatchObject({
      canonical: {
        derivations: [
          expect.objectContaining({ conclusionFactId: 'batch-derived-c' }),
          expect.objectContaining({ conclusionFactId: 'batch-derived-d' }),
        ],
      },
    })
    await expect(memory.verifyIntegrity()).resolves.toMatchObject({ ok: true })
  })

  it('atomically retires a bounded rule version and cascades once', async () => {
    const { memory, storage } = await seedTwoFacts()
    const activated = await memory.deriveFacts(
      {
        derivations: [
          {
            conclusion: {
              id: 'retire-c',
              subjectId: 'alice',
              predicate: 'retire_c',
              object: { kind: 'scalar', value: true },
            },
            rule: { id: 'rules/retire', version: '1' },
            premises: [{ kind: 'fact', id: 'fact-a' }],
          },
          {
            conclusion: {
              id: 'retire-d',
              subjectId: 'alice',
              predicate: 'retire_d',
              object: { kind: 'scalar', value: true },
            },
            rule: { id: 'rules/retire', version: '1' },
            premises: [{ kind: 'fact', id: 'fact-b' }],
          },
          {
            conclusion: {
              id: 'keep-e',
              subjectId: 'alice',
              predicate: 'keep_e',
              object: { kind: 'scalar', value: true },
            },
            rule: { id: 'rules/keep', version: '1' },
            premises: [{ kind: 'fact', id: 'fact-a' }],
          },
        ],
        access,
        expectedRevision: await revision(memory),
      },
      { operationId: 'activate-retirement-fixture' },
    )
    const before = await revision(memory)
    const query = vi.spyOn(storageDriver(storage), 'query')
    const input = {
      where: { ruleIds: ['rules/retire'], ruleVersions: ['1'] },
      access,
      expectedRevision: before,
      maxMatches: 2,
      reason: 'rule version retired',
    }
    const report = await memory.withdrawDerivations(input, {
      operationId: 'retire-rule-version',
    })
    const retired = activated.results
      .filter((result) => result.derivation.rule.id === 'rules/retire')
      .map((result) => result.derivation.id)
      .sort()

    expect(report.withdrawals.map((result) => result.derivationId)).toEqual(retired)
    expect(report.withdrawals.map((result) => result.conclusionFactId).sort()).toEqual([
      'retire-c',
      'retire-d',
    ])
    expect(report.withdrawals.every((result) => result.withdrawalId !== result.derivationId)).toBe(
      true,
    )
    expect(report.unsupportedFacts).toEqual(['retire-c', 'retire-d'])
    expect(report.operation.id).toBe('retire-rule-version')
    const selectionQueries = query.mock.calls
      .map(([request]) => request)
      .filter(
        (request) =>
          request.kind === 'derivation' &&
          request.filters?.some((filter) => filter.field === 'rule.id' && filter.op === 'in') &&
          request.filters.some((filter) => filter.field === 'rule.version' && filter.op === 'in') &&
          request.filters.some((filter) => filter.field === 'state' && filter.op === 'eq') &&
          request.filters.some((filter) => filter.field === 'scopes'),
      )
    expect(selectionQueries.length).toBeGreaterThan(0)
    expect(selectionQueries.every((request) => request.limit === 16)).toBe(true)
    await expect(revision(memory)).resolves.toBe(before + 1)
    await expect(
      memory.withdrawDerivations(input, { operationId: 'retire-rule-version' }),
    ).resolves.toEqual(report)
    await expect(memory.getFact('retire-c', access)).resolves.toBeNull()
    await expect(memory.getFact('retire-d', access)).resolves.toBeNull()
    await expect(memory.getFact('keep-e', access)).resolves.toMatchObject({ status: 'active' })
    for (const result of report.withdrawals) {
      await expect(memory.getDerivation(result.withdrawalId, access)).resolves.toMatchObject({
        id: result.withdrawalId,
        state: 'withdrawn',
        reason: 'rule version retired',
        recordedRevision: before + 1,
      })
    }
    await expect(
      storageDriver(storage).query({
        kind: 'change',
        spaceId: 'space-1',
        filters: [{ field: 'operationId', op: 'eq', value: 'retire-rule-version' }],
      }),
    ).resolves.toHaveLength(1)
    await expect(memory.verifyIntegrity()).resolves.toMatchObject({ ok: true })
  })

  it('previews one exact support set and binds apply to its selector, revision, and digest', async () => {
    const { memory, storage } = await seedTwoFacts()
    const activated = await memory.deriveFacts({
      derivations: [
        {
          conclusion: {
            id: 'preview-retire-c',
            subjectId: 'alice',
            predicate: 'preview_retire_c',
            object: { kind: 'scalar', value: true },
          },
          rule: { id: 'rules/preview-retire', version: '7' },
          premises: [{ kind: 'fact', id: 'fact-a' }],
        },
        {
          conclusion: {
            id: 'preview-retire-d',
            subjectId: 'alice',
            predicate: 'preview_retire_d',
            object: { kind: 'scalar', value: true },
          },
          rule: { id: 'rules/preview-retire', version: '7' },
          premises: [{ kind: 'fact', id: 'fact-b' }],
        },
      ],
      access,
      expectedRevision: await revision(memory),
    })
    const before = await revision(memory)
    const where = { ruleIds: ['rules/preview-retire'], ruleVersions: ['7'] }
    await expect(
      memory.previewDerivationWithdrawals({ where, access, maxMatches: 1 }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: { maxMatches: 1, matchesAtLeast: 2 },
    })
    await expect(
      memory.previewDerivationWithdrawals({
        where: { ids: [activated.results[0]!.derivation.id, 'derivation_missing_00000001'] },
        access,
        maxMatches: 2,
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
    const empty = await memory.previewDerivationWithdrawals({
      where: { ruleIds: ['rules/no-current-support'] },
      access,
      maxMatches: 2,
    })
    expect(empty).toMatchObject({ derivations: [], snapshotRevision: before })
    expect(empty.selectionCursor).toBeUndefined()

    const preview = await memory.previewDerivationWithdrawals({
      where,
      access,
      expectedRevision: before,
      maxMatches: 2,
    })
    expect(preview.derivations.map((derivation) => derivation.id)).toEqual(
      activated.results.map((result) => result.derivation.id).sort(),
    )
    expect(preview.selectionCursor).toEqual(expect.any(String))
    expect(preview.work.records).toBeGreaterThanOrEqual(2)
    const repeatedPreview = await memory.previewDerivationWithdrawals({
      where,
      access,
      expectedRevision: before,
      maxMatches: 2,
    })
    expect(repeatedPreview.selectionCursor).toBe(preview.selectionCursor)
    expect(repeatedPreview.derivations).toEqual(preview.derivations)
    await expect(revision(memory)).resolves.toBe(before)

    await expect(
      memory.withdrawDerivations(
        {
          where: { conclusionFactIds: ['preview-retire-c'] },
          access,
          expectedRevision: before,
          maxMatches: 2,
          selectionCursor: preview.selectionCursor,
        },
        { operationId: 'mismatched-preview-retirement' },
      ),
    ).rejects.toMatchObject({ code: 'conflict', retryable: true })
    await expect(
      storageDriver(storage).get('operation', 'space-1', 'mismatched-preview-retirement'),
    ).resolves.toBeNull()
    await expect(revision(memory)).resolves.toBe(before)

    const input = {
      where,
      access,
      expectedRevision: preview.snapshotRevision,
      maxMatches: 2,
      selectionCursor: preview.selectionCursor,
      reason: 'Apply the checked preview.',
    }
    const report = await memory.withdrawDerivations(input, {
      operationId: 'apply-preview-retirement',
    })
    expect(report.withdrawals.map((withdrawal) => withdrawal.derivationId)).toEqual(
      preview.derivations.map((derivation) => derivation.id),
    )
    await expect(
      memory.withdrawDerivations(input, { operationId: 'apply-preview-retirement' }),
    ).resolves.toEqual(report)
    await expect(memory.verifyIntegrity()).resolves.toMatchObject({ ok: true })
  })

  it('intersects conclusion and time selectors against only the current derivation revision', async () => {
    let now = '2026-08-03T10:00:00.000Z'
    const { memory, storage } = await seedTwoFacts({ now: () => new Date(now) })
    const input = {
      conclusion: {
        id: 'current-only-retirement',
        subjectId: 'alice',
        predicate: 'current_only_retirement',
        object: { kind: 'scalar' as const, value: true },
      },
      rule: { id: 'rules/current-only-retirement', version: '4' },
      premises: [{ kind: 'fact' as const, id: 'fact-a' }],
      access,
      expectedRevision: await revision(memory),
    }
    const first = await memory.deriveFact(input)
    now = '2026-08-03T10:01:00.000Z'
    await memory.withdrawDerivation({
      derivationId: first.derivation.id,
      access,
      expectedRevision: await revision(memory),
    })
    now = '2026-08-03T10:02:00.000Z'
    const current = await memory.deriveFact({
      ...input,
      expectedRevision: await revision(memory),
    })
    expect(current.derivation.id).not.toBe(first.derivation.id)

    await expect(
      memory.withdrawDerivations({
        where: { ids: [first.derivation.id] },
        access,
        expectedRevision: await revision(memory),
        maxMatches: 1,
      }),
    ).rejects.toMatchObject({ code: 'not_found' })

    const query = vi.spyOn(storageDriver(storage), 'query')
    now = '2026-08-03T10:03:00.000Z'
    const report = await memory.withdrawDerivations({
      where: {
        ruleIds: ['rules/current-only-retirement'],
        ruleVersions: ['4'],
        conclusionFactIds: ['current-only-retirement'],
        recordedAt: {
          since: '2026-08-03T10:02:00.000Z',
          until: '2026-08-03T10:03:00.000Z',
        },
      },
      access,
      expectedRevision: await revision(memory),
      maxMatches: 1,
    })
    expect(report.withdrawals).toEqual([
      expect.objectContaining({
        derivationId: current.derivation.id,
        conclusionFactId: 'current-only-retirement',
      }),
    ])
    const selection = query.mock.calls
      .map(([request]) => request)
      .find(
        (request) =>
          request.kind === 'derivation' &&
          request.filters?.some((filter) => filter.field === 'conclusionFactId') &&
          request.filters.some((filter) => filter.field === 'recordedAt' && filter.op === 'gte') &&
          request.filters.some((filter) => filter.field === 'recordedAt' && filter.op === 'lt'),
      )
    expect(selection).toBeDefined()
    await expect(memory.verifyIntegrity()).resolves.toMatchObject({ ok: true })
  })

  it('leaves no partial rule retirement on an incomplete id set, breadth guard, or work breach', async () => {
    for (const candidate of [
      {
        operationId: 'retire-missing-id',
        where: undefined,
        maxMatches: 2,
        workLimits: undefined,
        error: { code: 'not_found' },
      },
      {
        operationId: 'retire-too-broad',
        where: { ruleIds: ['rules/retire-atomicity'] },
        maxMatches: 1,
        workLimits: undefined,
        error: { code: 'result_too_large' },
      },
      {
        operationId: 'retire-work-limit',
        where: { ruleIds: ['rules/retire-atomicity'] },
        maxMatches: 2,
        workLimits: { maxRecords: 1 },
        error: { code: 'result_too_large' },
      },
    ] as const) {
      const { memory, storage } = await seedTwoFacts()
      const activated = await memory.deriveFacts({
        derivations: [
          {
            conclusion: {
              id: 'retire-atomic-c',
              subjectId: 'alice',
              predicate: 'retire_atomic_c',
              object: { kind: 'scalar', value: true },
            },
            rule: { id: 'rules/retire-atomicity', version: '1' },
            premises: [{ kind: 'fact', id: 'fact-a' }],
          },
          {
            conclusion: {
              id: 'retire-atomic-d',
              subjectId: 'alice',
              predicate: 'retire_atomic_d',
              object: { kind: 'scalar', value: true },
            },
            rule: { id: 'rules/retire-atomicity', version: '1' },
            premises: [{ kind: 'fact', id: 'fact-b' }],
          },
        ],
        access,
        expectedRevision: await revision(memory),
      })
      const before = await revision(memory)
      const where =
        candidate.where ??
        ({
          ids: [activated.results[0]!.derivation.id, 'derivation_missing_00000001'],
        } as const)
      await expect(
        memory.withdrawDerivations(
          {
            where,
            access,
            expectedRevision: before,
            maxMatches: candidate.maxMatches,
            ...(candidate.workLimits === undefined ? {} : { workLimits: candidate.workLimits }),
          },
          { operationId: candidate.operationId },
        ),
      ).rejects.toMatchObject(candidate.error)
      await expect(revision(memory)).resolves.toBe(before)
      for (const result of activated.results) {
        await expect(memory.getDerivation(result.derivation.id, access)).resolves.toMatchObject({
          state: 'active',
          version: 1,
        })
      }
      await expect(
        storageDriver(storage).query({
          kind: 'derivation',
          spaceId: 'space-1',
          filters: [{ field: 'operationId', op: 'eq', value: candidate.operationId }],
        }),
      ).resolves.toEqual([])
      await expect(
        storageDriver(storage).get('operation', 'space-1', candidate.operationId),
      ).resolves.toBeNull()
    }
  })

  it('snapshots a retirement selector once and keeps single/batch withdrawal identities distinct', async () => {
    const { memory } = await seedTwoFacts()
    const derived = await memory.deriveFact({
      conclusion: {
        id: 'snapshot-retirement',
        subjectId: 'alice',
        predicate: 'snapshot_retirement',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'rules/snapshot-retirement', version: '1' },
      premises: [{ kind: 'fact', id: 'fact-a' }],
      access,
      expectedRevision: await revision(memory),
    })
    const checkedRevision = await revision(memory)
    let whereReads = 0
    const input = {
      access,
      expectedRevision: checkedRevision,
      maxMatches: 1,
    } as {
      where: { ids: string[] }
      access: typeof access
      expectedRevision: number
      maxMatches: number
    }
    Object.defineProperty(input, 'where', {
      enumerable: true,
      get: () => {
        whereReads += 1
        if (whereReads > 1) throw new Error('where was read more than once')
        return { ids: [derived.derivation.id] }
      },
    })
    const report = await memory.withdrawDerivations(input, {
      operationId: 'snapshot-retirement-op',
    })
    expect(whereReads).toBe(1)
    expect(report.withdrawals).toHaveLength(1)

    await expect(
      memory.withdrawDerivation(
        {
          derivationId: derived.derivation.id,
          access,
          expectedRevision: checkedRevision,
        },
        { operationId: 'snapshot-retirement-op' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(
      memory.withdrawDerivations(
        {
          where: { ids: [derived.derivation.id] },
          access,
          expectedRevision: checkedRevision,
          maxMatches: 2,
        },
        { operationId: 'snapshot-retirement-op' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
    await expect(
      memory.withdrawDerivations({
        where: {},
        access,
        expectedRevision: await revision(memory),
        maxMatches: 1,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('rejects an invalid member or aggregate work breach without partial batch residue', async () => {
    for (const candidate of [
      {
        operationId: 'invalid-second-member',
        secondPremise: 'missing-fact',
        workLimits: undefined,
        error: { code: 'conflict' },
      },
      {
        operationId: 'aggregate-work-limit',
        secondPremise: 'fact-b',
        workLimits: { maxGraphNodes: 3 },
        error: {
          code: 'result_too_large',
          details: { phase: 'derivation', dimension: 'graph_nodes', required: 4, maximum: 3 },
        },
      },
    ] as const) {
      const { memory, storage } = await seedTwoFacts()
      const before = await revision(memory)
      await expect(
        memory.deriveFacts(
          {
            derivations: [
              {
                conclusion: {
                  id: `${candidate.operationId}-first`,
                  subjectId: 'alice',
                  predicate: `${candidate.operationId}_first`,
                  object: { kind: 'scalar', value: true },
                },
                rule: { id: `rules/${candidate.operationId}`, version: '1' },
                premises: [{ kind: 'fact', id: 'fact-a' }],
              },
              {
                conclusion: {
                  id: `${candidate.operationId}-second`,
                  subjectId: 'alice',
                  predicate: `${candidate.operationId}_second`,
                  object: { kind: 'scalar', value: true },
                },
                rule: { id: `rules/${candidate.operationId}`, version: '1' },
                premises: [{ kind: 'fact', id: candidate.secondPremise }],
              },
            ],
            access,
            expectedRevision: before,
            ...(candidate.workLimits === undefined ? {} : { workLimits: candidate.workLimits }),
          },
          { operationId: candidate.operationId },
        ),
      ).rejects.toMatchObject(candidate.error)
      await expect(revision(memory)).resolves.toBe(before)
      await expect(
        storageDriver(storage).get('fact', 'space-1', `${candidate.operationId}-first`),
      ).resolves.toBeNull()
      await expect(
        storageDriver(storage).query({
          kind: 'derivation',
          spaceId: 'space-1',
          filters: [{ field: 'operationId', op: 'eq', value: candidate.operationId }],
        }),
      ).resolves.toEqual([])
      await expect(
        storageDriver(storage).get('operation', 'space-1', candidate.operationId),
      ).resolves.toBeNull()
    }
  })

  it('rejects duplicate conclusions, cardinality ambiguity, and combined positive cycles', async () => {
    const duplicate = await seedTwoFacts()
    const duplicateRevision = await revision(duplicate.memory)
    const duplicateConclusion = {
      subjectId: 'alice',
      predicate: 'duplicate_semantic',
      object: { kind: 'scalar' as const, value: true },
    }
    await expect(
      duplicate.memory.deriveFacts({
        derivations: [
          {
            conclusion: { ...duplicateConclusion, id: 'duplicate-one' },
            rule: { id: 'rules/duplicate-one', version: '1' },
            premises: [{ kind: 'fact', id: 'fact-a' }],
          },
          {
            conclusion: { ...duplicateConclusion, id: 'duplicate-two' },
            rule: { id: 'rules/duplicate-two', version: '1' },
            premises: [{ kind: 'fact', id: 'fact-b' }],
          },
        ],
        access,
        expectedRevision: duplicateRevision,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(revision(duplicate.memory)).resolves.toBe(duplicateRevision)

    await expect(
      duplicate.memory.deriveFacts({
        derivations: [
          {
            conclusion: {
              id: 'duplicate-id',
              subjectId: 'alice',
              predicate: 'duplicate_id_one',
              object: { kind: 'scalar', value: true },
            },
            rule: { id: 'rules/duplicate-id-one', version: '1' },
            premises: [{ kind: 'fact', id: 'fact-a' }],
          },
          {
            conclusion: {
              id: 'duplicate-id',
              subjectId: 'alice',
              predicate: 'duplicate_id_two',
              object: { kind: 'scalar', value: true },
            },
            rule: { id: 'rules/duplicate-id-two', version: '1' },
            premises: [{ kind: 'fact', id: 'fact-b' }],
          },
        ],
        access,
        expectedRevision: duplicateRevision,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(revision(duplicate.memory)).resolves.toBe(duplicateRevision)

    const cardinality = await seedTwoFacts({
      ontology: {
        id: 'test.batch-cardinality',
        version: '1',
        mode: 'open',
        entityTypes: {},
        factTypes: {
          Choice: { predicate: 'choice', cardinality: 'one' },
        },
      },
    })
    const cardinalityRevision = await revision(cardinality.memory)
    await expect(
      cardinality.memory.deriveFacts({
        derivations: [true, false].map((value) => ({
          conclusion: {
            subjectId: 'alice',
            predicate: 'choice',
            object: { kind: 'scalar' as const, value },
            type: 'Choice',
          },
          rule: { id: 'rules/two-choices', version: '1' },
          premises: [{ kind: 'fact' as const, id: value ? 'fact-a' : 'fact-b' }],
        })),
        access,
        expectedRevision: cardinalityRevision,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(revision(cardinality.memory)).resolves.toBe(cardinalityRevision)

    const cycle = await seedTwoFacts()
    const cycleRevision = await revision(cycle.memory)
    await expect(
      cycle.memory.deriveFacts({
        derivations: [
          {
            conclusion: {
              id: 'fact-a',
              subjectId: 'alice',
              predicate: 'source_a',
              object: { kind: 'scalar', value: true },
            },
            rule: { id: 'rules/b-supports-a', version: '1' },
            premises: [{ kind: 'fact', id: 'fact-b' }],
          },
          {
            conclusion: {
              id: 'fact-b',
              subjectId: 'alice',
              predicate: 'source_b',
              object: { kind: 'scalar', value: true },
            },
            rule: { id: 'rules/a-supports-b', version: '1' },
            premises: [{ kind: 'fact', id: 'fact-a' }],
          },
        ],
        access,
        expectedRevision: cycleRevision,
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(revision(cycle.memory)).resolves.toBe(cycleRevision)
  })

  it('snapshots a batch once and keeps single/batch operation identities distinct', async () => {
    const { memory } = await seedTwoFacts()
    const expectedRevision = await revision(memory)
    const members = [
      {
        conclusion: {
          id: 'snapshotted-c',
          subjectId: 'alice',
          predicate: 'snapshotted_c',
          object: { kind: 'scalar' as const, value: true },
        },
        rule: { id: 'rules/snapshotted-batch', version: '1' },
        premises: [{ kind: 'fact' as const, id: 'fact-a' }],
      },
      {
        conclusion: {
          id: 'snapshotted-d',
          subjectId: 'alice',
          predicate: 'snapshotted_d',
          object: { kind: 'scalar' as const, value: true },
        },
        rule: { id: 'rules/snapshotted-batch', version: '1' },
        premises: [{ kind: 'fact' as const, id: 'fact-b' }],
      },
    ]
    let reads = 0
    const input = Object.defineProperty({ access, expectedRevision }, 'derivations', {
      enumerable: true,
      get: () => (reads++ === 0 ? members : []),
    })
    const report = await memory.deriveFacts(input as never, {
      operationId: 'snapshotted-derive-batch',
    })
    expect(reads).toBe(1)
    expect(report.results.map((result) => result.conclusion.id)).toEqual([
      'snapshotted-c',
      'snapshotted-d',
    ])

    await expect(
      memory.deriveFact(
        {
          ...members[0],
          access,
          expectedRevision,
        },
        { operationId: 'snapshotted-derive-batch' },
      ),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })

    const unreadable = Object.defineProperty(
      { access, expectedRevision: await revision(memory) },
      'derivations',
      {
        enumerable: true,
        get: () => {
          throw new Error('untrusted derivation batch accessor')
        },
      },
    )
    await expect(memory.deriveFacts(unreadable as never)).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'derive facts input could not be snapshotted as JSON',
    })
  })

  it('propagates source sensitivity through transitive derived-fact projections', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    const source = await memory.remember({
      id: 'classified-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice has classified source fact A.' },
      source: { kind: 'fixture' },
      sensitivity: 'restricted',
      assertions: {
        entities: [{ id: 'alice', name: 'Alice' }],
        facts: [
          {
            id: 'classified-a',
            subject: { id: 'alice' },
            predicate: 'classified_a',
            object: { scalar: true },
          },
        ],
      },
    })
    expect(source.facts.created).toEqual(['classified-a'])
    await memory.deriveFact({
      conclusion: {
        id: 'classified-b',
        subjectId: 'alice',
        predicate: 'classified_b',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'rules/a-implies-b', version: '1' },
      premises: [{ kind: 'fact', id: 'classified-a' }],
      access,
      expectedRevision: await revision(memory),
    })
    await memory.deriveFact({
      conclusion: {
        id: 'classified-c',
        subjectId: 'alice',
        predicate: 'classified_c',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'rules/b-implies-c', version: '1' },
      premises: [{ kind: 'fact', id: 'classified-b' }],
      access,
      expectedRevision: await revision(memory),
    })

    const rebuilt = await memory.rebuildProjections({ kinds: ['lexical'] })
    const driver = storageDriver(storage)
    const space = await driver.getSpace('space-1')
    if (space?.projectionSets?.lexical === undefined) throw new Error('lexical set is missing')
    const projections = await driver.query({
      kind: 'projection',
      spaceId: 'space-1',
      filters: [
        { field: 'target.kind', op: 'eq', value: 'fact' },
        { field: 'target.id', op: 'eq', value: 'classified-c' },
        { field: 'setId', op: 'eq', value: space.projectionSets.lexical.id },
      ],
      limit: 10,
    })

    expect(rebuilt).toMatchObject({ failed: 0, staleRemaining: 0 })
    expect(projections).toHaveLength(1)
    expect(projections[0]).toMatchObject({
      state: 'ready',
      sensitivities: ['restricted'],
    })
  })

  it('invalidates and retracts a dependency chain to a fixpoint when source support disappears', async () => {
    const { memory, storage } = await seedTwoFacts()
    const first = await memory.deriveFact({
      conclusion: {
        id: 'derived-c',
        subjectId: 'alice',
        predicate: 'derived_c',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'rules/a-implies-c', version: '1' },
      premises: [{ kind: 'fact', id: 'fact-a' }],
      access,
      expectedRevision: await revision(memory),
    })
    const second = await memory.deriveFact({
      conclusion: {
        id: 'derived-d',
        subjectId: 'alice',
        predicate: 'derived_d',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'rules/c-implies-d', version: '1' },
      premises: [{ kind: 'fact', id: first.conclusion.id }],
      access,
      expectedRevision: await revision(memory),
    })

    const deleted = await memory.deleteEpisode({ episodeId: 'source-episode', access })
    expect(deleted.unsupportedFacts).toEqual(['derived-c', 'derived-d', 'fact-a', 'fact-b'])

    const records = await storageDriver(storage).exportRecords('space-1')
    const facts = new Map(
      records
        .filter((record): record is StoredFact => record.kindRecord === 'fact')
        .map((record) => [record.id, record]),
    )
    expect(facts.get('fact-a')?.status).toBe('deleted')
    expect(facts.get('derived-c')?.status).toBe('retracted')
    expect(facts.get('derived-d')?.status).toBe('retracted')
    const derivations = records.filter(
      (record): record is StoredDerivation => record.kindRecord === 'derivation',
    )
    expect(derivations.filter((item) => item.state === 'invalidated')).toHaveLength(2)
    expect(derivations.some((item) => item.supersedes === first.derivation.id)).toBe(true)
    expect(derivations.some((item) => item.supersedes === second.derivation.id)).toBe(true)
    await expect(memory.recall({ query: 'derived', access })).resolves.toMatchObject({ facts: [] })
    const integrity = await memory.verifyIntegrity()
    expect(integrity.issues).toEqual([])
  })

  it('keeps a fact current on independent rule support, then retracts it when that support is withdrawn', async () => {
    const { memory, storage } = await seedTwoFacts()
    const supported = await memory.deriveFact({
      conclusion: {
        id: 'fact-b',
        subjectId: 'alice',
        predicate: 'source_b',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'rules/a-implies-b', version: '1' },
      premises: [{ kind: 'fact', id: 'fact-a' }],
      access,
      expectedRevision: await revision(memory),
    })
    expect(supported.outcome).toBe('supported')

    await memory.retractFact({ factId: 'fact-b', allSupport: true, access })
    await expect(memory.getFact('fact-b', access)).resolves.toMatchObject({
      status: 'active',
      evidence: [],
      derivations: [{ state: 'active' }],
    })

    const withdrawn = await memory.withdrawDerivation({
      derivationId: supported.derivation.id,
      access,
      expectedRevision: await revision(memory),
      reason: 'rule retired',
    })
    expect(withdrawn).toMatchObject({ outcome: 'withdrawn', unsupportedFacts: ['fact-b'] })
    expect(await memory.getFact('fact-b', access)).toBeNull()
    const stored = await storageDriver(storage).get('fact', 'space-1', 'fact-b')
    expect(stored?.status).toBe('retracted')
  })

  it('resolves only current logical revisions across alternative support and reactivation', async () => {
    const { memory } = await seedTwoFacts()
    const conclusion = {
      id: 'shared-derived',
      subjectId: 'alice',
      predicate: 'shared_derived',
      object: { kind: 'scalar' as const, value: true },
    }
    const firstInput = {
      conclusion,
      rule: { id: 'rules/a-implies-shared', version: '1' },
      premises: [{ kind: 'fact' as const, id: 'fact-a' }],
      access,
    }
    const first = await memory.deriveFact({
      ...firstInput,
      expectedRevision: await revision(memory),
    })
    const second = await memory.deriveFact({
      conclusion,
      rule: { id: 'rules/b-implies-shared', version: '1' },
      premises: [{ kind: 'fact', id: 'fact-b' }],
      access,
      expectedRevision: await revision(memory),
    })

    const firstWithdrawal = await memory.withdrawDerivation({
      derivationId: first.derivation.id,
      access,
      expectedRevision: await revision(memory),
    })
    expect(firstWithdrawal.unsupportedFacts).toEqual([])
    await expect(memory.getFact('shared-derived', access)).resolves.toMatchObject({
      status: 'active',
      derivations: [{ id: second.derivation.id, state: 'active' }],
    })

    const secondWithdrawal = await memory.withdrawDerivation({
      derivationId: second.derivation.id,
      access,
      expectedRevision: await revision(memory),
    })
    expect(secondWithdrawal.unsupportedFacts).toEqual(['shared-derived'])
    expect(await memory.getFact('shared-derived', access)).toBeNull()

    const reactivated = await memory.deriveFact({
      ...firstInput,
      expectedRevision: await revision(memory),
    })
    expect(reactivated).toMatchObject({
      outcome: 'reactivated',
      derivation: {
        version: 3,
        state: 'active',
        supersedes: firstWithdrawal.derivation.id,
      },
      conclusion: { id: 'shared-derived', status: 'active' },
    })
  })

  it('invalidates an exact evidence premise even while its target fact keeps other source support', async () => {
    const { memory, storage } = await seedTwoFacts()
    const initial = await memory.export({ access, complete: true })
    const premiseEvidenceId = initial.canonical.evidence.find(
      (link) =>
        link.episodeId === 'source-episode' &&
        link.target.kind === 'fact' &&
        link.target.id === 'fact-a',
    )!.id
    await memory.remember({
      id: 'independent-source',
      kind: 'assertion',
      content: { type: 'text', text: 'A second source independently supports A.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'alice', name: 'Alice' }],
        facts: [
          {
            id: 'fact-a',
            subject: { id: 'alice' },
            predicate: 'source_a',
            object: { scalar: true },
          },
        ],
      },
    })
    await memory.deriveFact({
      conclusion: {
        id: 'derived-c',
        subjectId: 'alice',
        predicate: 'derived_c',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'rules/evidence-implies-c', version: '1' },
      premises: [{ kind: 'evidence', id: premiseEvidenceId }],
      access,
      expectedRevision: await revision(memory),
    })

    await memory.retractFact({ factId: 'fact-a', episodeId: 'source-episode', access })

    await expect(memory.getFact('fact-a', access)).resolves.toMatchObject({ status: 'active' })
    await expect(memory.getFact('derived-c', access)).resolves.toBeNull()
    const records = await storageDriver(storage).exportRecords('space-1')
    expect(records).toContainEqual(
      expect.objectContaining({
        kindRecord: 'derivation',
        state: 'invalidated',
        invalidPremises: [{ kind: 'evidence', id: premiseEvidenceId }],
      }),
    )
    await expect(memory.verifyIntegrity()).resolves.toMatchObject({ ok: true })
  })

  it('invalidates dependent conclusions when correction supersedes a fact premise', async () => {
    const { memory, storage } = await seedTwoFacts()
    await memory.deriveFact({
      conclusion: {
        id: 'derived-c',
        subjectId: 'alice',
        predicate: 'derived_c',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'rules/a-implies-c', version: '1' },
      premises: [{ kind: 'fact', id: 'fact-a' }],
      access,
      expectedRevision: await revision(memory),
    })

    await memory.correctFact({
      factId: 'fact-a',
      replacement: {
        id: 'fact-a-corrected',
        subject: { id: 'alice' },
        predicate: 'source_a',
        object: { scalar: false },
      },
      access,
    })

    await expect(memory.getFact('fact-a', access)).resolves.toMatchObject({
      status: 'superseded',
    })
    await expect(memory.getFact('fact-a-corrected', access)).resolves.toMatchObject({
      status: 'active',
    })
    await expect(memory.getFact('derived-c', access)).resolves.toBeNull()
    const records = await storageDriver(storage).exportRecords('space-1')
    expect(records).toContainEqual(
      expect.objectContaining({
        kindRecord: 'derivation',
        state: 'invalidated',
        invalidPremises: [{ kind: 'fact', id: 'fact-a' }],
      }),
    )
    await expect(memory.verifyIntegrity()).resolves.toMatchObject({ ok: true })
  })

  it('rejects active fact-dependency cycles', async () => {
    const { memory } = await seedTwoFacts()
    await memory.deriveFact({
      conclusion: {
        id: 'fact-b',
        subjectId: 'alice',
        predicate: 'source_b',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'rules/a-implies-b', version: '1' },
      premises: [{ kind: 'fact', id: 'fact-a' }],
      access,
      expectedRevision: await revision(memory),
    })

    await expect(
      memory.deriveFact({
        conclusion: {
          id: 'fact-a',
          subjectId: 'alice',
          predicate: 'source_a',
          object: { kind: 'scalar', value: true },
        },
        rule: { id: 'rules/b-implies-a', version: '1' },
        premises: [{ kind: 'fact', id: 'fact-b' }],
        access,
        expectedRevision: await revision(memory),
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('plans sparse derivation and governance writes without scanning an unrelated corpus', async () => {
    const { memory, storage } = await seedTwoFacts()
    await memory.remember({
      id: 'unrelated-corpus',
      kind: 'assertion',
      content: { type: 'text', text: 'A deliberately broad unrelated corpus.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'alice', name: 'Alice' }],
        facts: Array.from({ length: 256 }, (_, index) => ({
          id: `unrelated-${index.toString().padStart(4, '0')}`,
          subject: { id: 'alice' },
          predicate: `unrelated_${index.toString().padStart(4, '0')}`,
          object: { scalar: index },
        })),
      },
    })
    const driver = storageDriver(storage)
    const query = vi.spyOn(driver, 'query')
    const wholeSpace = vi
      .spyOn(driver, 'exportRecords')
      .mockRejectedValue(new Error('direct derivation planning must remain indexed'))
    const input = {
      conclusion: {
        id: 'bounded-derived',
        subjectId: 'alice',
        predicate: 'bounded_derived',
        object: { kind: 'scalar' as const, value: true },
      },
      rule: { id: 'rules/bounded', version: '1' },
      premises: [{ kind: 'fact' as const, id: 'fact-a' }],
      access,
      expectedRevision: await revision(memory),
      workLimits: { maxRecords: 32 },
    }

    const derived = await memory.deriveFact(input, { operationId: 'bounded-derive' })
    expect(wholeSpace).not.toHaveBeenCalled()
    expect(derived.work).toMatchObject({
      records: expect.any(Number),
      bytes: expect.any(Number),
      graphNodes: 2,
      graphEdges: 1,
      limits: { maxRecords: 32 },
    })
    expect(derived.work.records).toBeLessThan(32)
    expect(derived.work.bytes).toBeGreaterThan(0)
    const indexedQueries = query.mock.calls
      .map(([request]) => request)
      .filter(
        (request) =>
          ['derivation', 'evidence', 'fact'].includes(request.kind) &&
          request.filters?.some((filter) =>
            [
              'premiseFactIds',
              'premiseEvidenceIds',
              'conclusionFactId',
              'semanticKey',
              'entityId',
              'target.kind',
              'target.id',
            ].includes(filter.field),
          ) === true &&
          request.order?.length === 1 &&
          request.order[0]?.field === 'id' &&
          request.order[0]?.direction === 'asc',
      )
    expect(indexedQueries.length).toBeGreaterThan(0)
    expect(indexedQueries.every((request) => request.limit === 16)).toBe(true)
    const aliasPlanningQueries = query.mock.calls
      .map(([request]) => request)
      .filter((request) => request.kind === 'alias')
    expect(aliasPlanningQueries.length).toBeGreaterThan(0)
    expect(
      aliasPlanningQueries.every((request) =>
        request.filters?.some((filter) => filter.field === 'entityId'),
      ),
    ).toBe(true)
    const projectionPlanningQueries = query.mock.calls
      .map(([request]) => request)
      .filter(
        (request) =>
          request.kind === 'projection' &&
          request.order?.length === 1 &&
          request.order[0]?.field === 'id' &&
          request.order[0]?.direction === 'asc' &&
          request.limit === 16,
      )
    expect(projectionPlanningQueries.length).toBeGreaterThan(0)
    expect(
      projectionPlanningQueries.every(
        (request) =>
          request.filters?.some((filter) => filter.field === 'target.kind') === true &&
          request.filters.some((filter) => filter.field === 'target.id'),
      ),
    ).toBe(true)

    await expect(
      memory.deriveFact(
        { ...input, workLimits: { maxRecords: 1 } },
        { operationId: 'bounded-derive' },
      ),
    ).resolves.toEqual(derived)

    const withdrawn = await memory.withdrawDerivation({
      derivationId: derived.derivation.id,
      access,
      expectedRevision: await revision(memory),
      workLimits: { maxRecords: 32 },
    })
    expect(wholeSpace).not.toHaveBeenCalled()
    expect(withdrawn).toMatchObject({
      outcome: 'withdrawn',
      unsupportedFacts: ['bounded-derived'],
      work: { limits: { maxRecords: 32 } },
    })
    expect(withdrawn.work.records).toBeLessThan(32)

    const beforeCorrection = await revision(memory)
    await expect(
      memory.correctFact({
        factId: 'fact-b',
        replacement: {
          id: 'fact-b-corrected',
          subject: { id: 'alice' },
          predicate: 'source_b',
          object: { scalar: false },
        },
        access,
        workLimits: { maxRecords: 1 },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: { phase: 'derivation', dimension: 'records', required: 2, maximum: 1 },
    })
    await expect(revision(memory)).resolves.toBe(beforeCorrection)
    await expect(driver.get('fact', 'space-1', 'fact-b')).resolves.toMatchObject({
      status: 'active',
    })

    query.mockClear()
    const corrected = await memory.correctFact({
      factId: 'fact-b',
      replacement: {
        id: 'fact-b-corrected',
        subject: { id: 'alice' },
        predicate: 'source_b',
        object: { scalar: false },
      },
      access,
      workLimits: { maxRecords: 64 },
    })
    expect(wholeSpace).not.toHaveBeenCalled()
    expect(corrected).toMatchObject({
      affectedFacts: ['fact-b', 'fact-b-corrected'],
      work: { limits: { maxRecords: 64 } },
    })
    expect(corrected.work.records).toBeGreaterThan(0)
    expect(corrected.work.records).toBeLessThanOrEqual(64)
    expect(corrected.work.bytes).toBeGreaterThan(0)
    await expect(driver.get('fact', 'space-1', 'fact-b')).resolves.toMatchObject({
      status: 'superseded',
    })
    const correctionScans = query.mock.calls
      .map(([request]) => request)
      .filter(
        (request) =>
          ['alias', 'derivation', 'evidence', 'fact', 'projection'].includes(request.kind) &&
          request.order?.length === 1 &&
          request.order[0]?.field === 'id' &&
          request.order[0]?.direction === 'asc',
      )
    expect(correctionScans.length).toBeGreaterThan(0)
    expect(correctionScans.every((request) => request.limit === 16)).toBe(true)

    const beforeRetraction = await revision(memory)
    await expect(
      memory.retractFact({
        factId: 'fact-a',
        allSupport: true,
        access,
        workLimits: { maxRecords: 1 },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: { phase: 'derivation', dimension: 'records', required: 2, maximum: 1 },
    })
    await expect(revision(memory)).resolves.toBe(beforeRetraction)
    await expect(driver.get('fact', 'space-1', 'fact-a')).resolves.toMatchObject({
      status: 'active',
    })

    query.mockClear()
    const retracted = await memory.retractFact({
      factId: 'fact-a',
      allSupport: true,
      access,
      workLimits: { maxRecords: 32 },
    })
    expect(wholeSpace).not.toHaveBeenCalled()
    expect(retracted).toMatchObject({
      affectedEpisodes: ['source-episode'],
      affectedFacts: ['fact-a'],
      work: { limits: { maxRecords: 32 } },
    })
    expect(retracted.work.records).toBeGreaterThan(0)
    expect(retracted.work.records).toBeLessThanOrEqual(32)
    expect(retracted.work.bytes).toBeGreaterThan(0)
    const storedRetraction = await driver.get('fact', 'space-1', 'fact-a')
    expect(storedRetraction).toMatchObject({
      status: 'retracted',
    })
    expect(storedRetraction).not.toHaveProperty('conflictGroup')
    const retractionScans = query.mock.calls
      .map(([request]) => request)
      .filter(
        (request) =>
          ['derivation', 'evidence', 'projection'].includes(request.kind) &&
          request.order?.length === 1 &&
          request.order[0]?.field === 'id' &&
          request.order[0]?.direction === 'asc',
      )
    expect(retractionScans.length).toBeGreaterThan(0)
    expect(retractionScans.every((request) => request.limit === 16)).toBe(true)

    const beforeDeletion = await revision(memory)
    await expect(
      memory.deleteEpisode({
        episodeId: 'source-episode',
        access,
        workLimits: { maxRecords: 1 },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: { phase: 'derivation', dimension: 'records', required: 2, maximum: 1 },
    })
    await expect(revision(memory)).resolves.toBe(beforeDeletion)
    await expect(driver.get('episode', 'space-1', 'source-episode')).resolves.toMatchObject({
      retentionState: 'retained',
    })

    query.mockClear()
    const deleted = await memory.deleteEpisode({
      episodeId: 'source-episode',
      access,
      workLimits: { maxRecords: 128 },
    })
    expect(wholeSpace).not.toHaveBeenCalled()
    expect(deleted).toMatchObject({
      affectedEpisodes: ['source-episode'],
      purged: false,
      work: { limits: { maxRecords: 128 } },
    })
    expect(deleted.work.records).toBeGreaterThan(0)
    expect(deleted.work.records).toBeLessThanOrEqual(128)
    expect(deleted.work.bytes).toBeGreaterThan(0)
    await expect(driver.get('episode', 'space-1', 'source-episode')).resolves.toMatchObject({
      retentionState: 'deleted',
    })
    const deletionScans = query.mock.calls
      .map(([request]) => request)
      .filter(
        (request) =>
          ['alias', 'derivation', 'evidence', 'fact', 'mention', 'projection'].includes(
            request.kind,
          ) &&
          request.order?.length === 1 &&
          request.order[0]?.field === 'id' &&
          request.order[0]?.direction === 'asc',
      )
    expect(deletionScans.length).toBeGreaterThan(0)
    expect(deletionScans.every((request) => request.limit === 16)).toBe(true)
    expect(
      deletionScans.some(
        (request) =>
          request.kind === 'alias' &&
          request.filters?.some(
            (filter) => filter.field === 'episodeIds' && filter.op === 'contains',
          ),
      ),
    ).toBe(true)
    for (const kind of ['evidence', 'mention'] as const) {
      expect(
        deletionScans.some(
          (request) =>
            request.kind === kind &&
            request.filters?.some((filter) => filter.field === 'episodeId' && filter.op === 'eq'),
        ),
      ).toBe(true)
    }
    await expect(memory.export({ access, complete: true })).resolves.toMatchObject({
      canonical: { facts: expect.arrayContaining([expect.objectContaining({ id: 'fact-a' })]) },
    })
    expect(wholeSpace).not.toHaveBeenCalled()
  })

  it('fails closed on every derivation work dimension without a partial mutation', async () => {
    const cases = [
      {
        dimension: 'records',
        limits: { maxRecords: 1 },
        premises: async (storage: ReturnType<typeof harness>['storage']) => {
          const [evidence] = await storageDriver(storage).query({
            kind: 'evidence',
            spaceId: 'space-1',
            filters: [
              { field: 'target.kind', op: 'eq', value: 'fact' },
              { field: 'target.id', op: 'eq', value: 'fact-a' },
            ],
            limit: 1,
          })
          return [{ kind: 'evidence' as const, id: evidence!.id }]
        },
      },
      {
        dimension: 'bytes',
        limits: { maxBytes: 1 },
        premises: async () => [{ kind: 'fact' as const, id: 'fact-a' }],
      },
      {
        dimension: 'graph_nodes',
        limits: { maxGraphNodes: 1 },
        premises: async () => [{ kind: 'fact' as const, id: 'fact-a' }],
      },
      {
        dimension: 'graph_edges',
        limits: { maxGraphEdges: 1 },
        premises: async () => [
          { kind: 'fact' as const, id: 'fact-a' },
          { kind: 'fact' as const, id: 'fact-b' },
        ],
      },
    ] as const
    for (const [index, candidate] of cases.entries()) {
      const { memory, storage } = await seedTwoFacts()
      const before = await revision(memory)
      const id = `limited-derived-${index}`
      await expect(
        memory.deriveFact({
          conclusion: {
            id,
            subjectId: 'alice',
            predicate: `limited_${index}`,
            object: { kind: 'scalar', value: true },
          },
          rule: { id: `rules/limited-${index}`, version: '1' },
          premises: await candidate.premises(storage),
          access,
          expectedRevision: before,
          workLimits: candidate.limits,
        }),
      ).rejects.toMatchObject({
        code: 'result_too_large',
        details: {
          phase: 'derivation',
          dimension: candidate.dimension,
          required: expect.any(Number),
          maximum: 1,
        },
      })
      await expect(storageDriver(storage).get('fact', 'space-1', id)).resolves.toBeNull()
      await expect(revision(memory)).resolves.toBe(before)
    }
  })

  it('commits no derivation rows when a concurrent facade wins the revision race', async () => {
    const base = harness().storage
    const driver = storageDriver(base)
    const peerRef: { current?: ReturnType<typeof harness>['memory'] } = {}
    let injectRace = false
    const racing = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            if (injectRace && change.puts?.some((record) => record.kindRecord === 'derivation')) {
              injectRace = false
              await peerRef.current!.remember(
                {
                  id: 'racing-episode',
                  kind: 'event',
                  content: { type: 'text', text: 'A concurrent canonical mutation.' },
                  source: { kind: 'fixture' },
                },
                { operationId: 'race-winner' },
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
    const primaryContext = harness({ storage })
    const peerContext = harness({ storage })
    peerRef.current = peerContext.memory
    await primaryContext.memory.open({ create: true })
    await peerRef.current.open()
    await primaryContext.memory.remember({
      id: 'race-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice has a race premise.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'alice', name: 'Alice' }],
        facts: [
          {
            id: 'race-premise',
            subject: { id: 'alice' },
            predicate: 'race_premise',
            object: { scalar: true },
          },
        ],
      },
    })
    injectRace = true
    await expect(
      primaryContext.memory.deriveFact(
        {
          conclusion: {
            id: 'race-derived',
            subjectId: 'alice',
            predicate: 'race_derived',
            object: { kind: 'scalar', value: true },
          },
          rule: { id: 'rules/race', version: '1' },
          premises: [{ kind: 'fact', id: 'race-premise' }],
          access,
          expectedRevision: await revision(primaryContext.memory),
        },
        { operationId: 'racing-derive' },
      ),
    ).rejects.toMatchObject({ code: 'conflict', operationId: 'racing-derive' })
    await expect(driver.get('fact', 'space-1', 'race-derived')).resolves.toBeNull()
    await expect(
      driver.query({
        kind: 'derivation',
        spaceId: 'space-1',
        filters: [{ field: 'conclusionFactId', op: 'eq', value: 'race-derived' }],
      }),
    ).resolves.toEqual([])
    await expect(driver.get('operation', 'space-1', 'racing-derive')).resolves.toBeNull()
  })

  it('commits one complete derivation batch or no batch residue across concurrent facades', async () => {
    const base = harness().storage
    const driver = storageDriver(base)
    const peerRef: { current?: ReturnType<typeof harness>['memory'] } = {}
    let injectRace = false
    const racing = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            if (
              injectRace &&
              change.puts?.filter((record) => record.kindRecord === 'derivation').length === 2
            ) {
              injectRace = false
              await peerRef.current!.remember(
                {
                  id: 'batch-racing-episode',
                  kind: 'event',
                  content: { type: 'text', text: 'A concurrent canonical batch mutation.' },
                  source: { kind: 'fixture' },
                },
                { operationId: 'batch-race-winner' },
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
    const primary = harness({ storage }).memory
    const peer = harness({ storage }).memory
    peerRef.current = peer
    await primary.open({ create: true })
    await peer.open()
    await primary.remember({
      id: 'batch-race-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice has two batch race premises.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'alice', name: 'Alice' }],
        facts: [
          {
            id: 'batch-race-a',
            subject: { id: 'alice' },
            predicate: 'batch_race_a',
            object: { scalar: true },
          },
          {
            id: 'batch-race-b',
            subject: { id: 'alice' },
            predicate: 'batch_race_b',
            object: { scalar: true },
          },
        ],
      },
    })
    const batch = (expectedRevision: number) => ({
      derivations: [
        {
          conclusion: {
            id: 'batch-race-c',
            subjectId: 'alice',
            predicate: 'batch_race_c',
            object: { kind: 'scalar' as const, value: true },
          },
          rule: { id: 'rules/batch-race', version: '1' },
          premises: [{ kind: 'fact' as const, id: 'batch-race-a' }],
        },
        {
          conclusion: {
            id: 'batch-race-d',
            subjectId: 'alice',
            predicate: 'batch_race_d',
            object: { kind: 'scalar' as const, value: true },
          },
          rule: { id: 'rules/batch-race', version: '1' },
          premises: [{ kind: 'fact' as const, id: 'batch-race-b' }],
        },
      ],
      access,
      expectedRevision,
    })
    injectRace = true
    await expect(
      primary.deriveFacts(batch(await revision(primary)), { operationId: 'racing-derive-batch' }),
    ).rejects.toMatchObject({ code: 'conflict', operationId: 'racing-derive-batch' })
    for (const id of ['batch-race-c', 'batch-race-d']) {
      await expect(driver.get('fact', 'space-1', id)).resolves.toBeNull()
    }
    await expect(
      driver.query({
        kind: 'derivation',
        spaceId: 'space-1',
        filters: [{ field: 'operationId', op: 'eq', value: 'racing-derive-batch' }],
      }),
    ).resolves.toEqual([])
    await expect(driver.get('operation', 'space-1', 'racing-derive-batch')).resolves.toBeNull()
    await expect(
      driver.query({
        kind: 'change',
        spaceId: 'space-1',
        filters: [{ field: 'operationId', op: 'eq', value: 'racing-derive-batch' }],
      }),
    ).resolves.toEqual([])

    await expect(
      primary.deriveFacts(batch(await revision(primary)), { operationId: 'racing-derive-batch' }),
    ).resolves.toMatchObject({
      results: [
        { conclusion: { id: 'batch-race-c' }, outcome: 'created' },
        { conclusion: { id: 'batch-race-d' }, outcome: 'created' },
      ],
    })
    await expect(primary.verifyIntegrity()).resolves.toMatchObject({ ok: true })
  })

  it('commits one complete withdrawal batch or no withdrawal residue across concurrent facades', async () => {
    const base = harness().storage
    const driver = storageDriver(base)
    const peerRef: { current?: ReturnType<typeof harness>['memory'] } = {}
    let injectRace = false
    const racing = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            if (
              injectRace &&
              change.puts?.filter(
                (record) => record.kindRecord === 'derivation' && record.state === 'withdrawn',
              ).length === 2
            ) {
              injectRace = false
              await peerRef.current!.remember(
                {
                  id: 'withdrawal-batch-racing-episode',
                  kind: 'event',
                  content: {
                    type: 'text',
                    text: 'A concurrent canonical withdrawal-batch mutation.',
                  },
                  source: { kind: 'fixture' },
                },
                { operationId: 'withdrawal-batch-race-winner' },
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
    const primary = harness({ storage }).memory
    const peer = harness({ storage }).memory
    peerRef.current = peer
    await primary.open({ create: true })
    await peer.open()
    await primary.remember({
      id: 'withdrawal-batch-race-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice has two withdrawal race premises.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'alice', name: 'Alice' }],
        facts: [
          {
            id: 'withdrawal-batch-race-a',
            subject: { id: 'alice' },
            predicate: 'withdrawal_batch_race_a',
            object: { scalar: true },
          },
          {
            id: 'withdrawal-batch-race-b',
            subject: { id: 'alice' },
            predicate: 'withdrawal_batch_race_b',
            object: { scalar: true },
          },
        ],
      },
    })
    await primary.deriveFacts(
      {
        derivations: [
          {
            conclusion: {
              id: 'withdrawal-batch-race-c',
              subjectId: 'alice',
              predicate: 'withdrawal_batch_race_c',
              object: { kind: 'scalar', value: true },
            },
            rule: { id: 'rules/withdrawal-batch-race', version: '1' },
            premises: [{ kind: 'fact', id: 'withdrawal-batch-race-a' }],
          },
          {
            conclusion: {
              id: 'withdrawal-batch-race-d',
              subjectId: 'alice',
              predicate: 'withdrawal_batch_race_d',
              object: { kind: 'scalar', value: true },
            },
            rule: { id: 'rules/withdrawal-batch-race', version: '1' },
            premises: [{ kind: 'fact', id: 'withdrawal-batch-race-b' }],
          },
        ],
        access,
        expectedRevision: await revision(primary),
      },
      { operationId: 'seed-withdrawal-batch-race' },
    )
    const withdraw = (expectedRevision: number) => ({
      where: { ruleIds: ['rules/withdrawal-batch-race'] },
      access,
      expectedRevision,
      maxMatches: 2,
      reason: 'Retire the raced rule set.',
    })

    injectRace = true
    await expect(
      primary.withdrawDerivations(withdraw(await revision(primary)), {
        operationId: 'racing-withdrawal-batch',
      }),
    ).rejects.toMatchObject({ code: 'conflict', operationId: 'racing-withdrawal-batch' })
    await expect(
      driver.query({
        kind: 'derivation',
        spaceId: 'space-1',
        filters: [{ field: 'operationId', op: 'eq', value: 'racing-withdrawal-batch' }],
      }),
    ).resolves.toEqual([])
    await expect(driver.get('operation', 'space-1', 'racing-withdrawal-batch')).resolves.toBeNull()
    await expect(
      driver.query({
        kind: 'change',
        spaceId: 'space-1',
        filters: [{ field: 'operationId', op: 'eq', value: 'racing-withdrawal-batch' }],
      }),
    ).resolves.toEqual([])
    for (const id of ['withdrawal-batch-race-c', 'withdrawal-batch-race-d']) {
      await expect(primary.getFact(id, access)).resolves.toMatchObject({ id, status: 'active' })
    }

    await expect(
      primary.withdrawDerivations(withdraw(await revision(primary)), {
        operationId: 'racing-withdrawal-batch',
      }),
    ).resolves.toMatchObject({
      withdrawals: [
        { conclusionFactId: 'withdrawal-batch-race-c' },
        { conclusionFactId: 'withdrawal-batch-race-d' },
      ],
      unsupportedFacts: ['withdrawal-batch-race-c', 'withdrawal-batch-race-d'],
    })
    await expect(primary.verifyIntegrity()).resolves.toMatchObject({ ok: true })
  })

  it('re-authorizes correction support after a concurrent hidden-support race', async () => {
    const base = harness().storage
    const driver = storageDriver(base)
    let injectHiddenSupport = false
    const hiddenEvidence: StoredEvidence = {
      kindRecord: 'evidence',
      id: 'hidden-correction-support',
      spaceId: 'space-1',
      episodeId: 'hidden-support-episode',
      target: { kind: 'fact', id: 'correction-race-fact' },
      relation: 'supports',
      status: 'active',
      scopes: ['secret'],
      createdAt: '2026-08-03T10:00:00.000Z',
      operationId: 'hidden-support-writer',
    }
    const racing = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            if (
              injectHiddenSupport &&
              change.puts?.some(
                (record) => record.kindRecord === 'episode' && record.kind === 'correction',
              )
            ) {
              injectHiddenSupport = false
              await target.commit({
                spaceId: 'space-1',
                expectedRevision: change.expectedRevision,
                puts: [hiddenEvidence],
                semanticChange: {
                  operationId: hiddenEvidence.operationId,
                  operationKind: 'ingest',
                  phase: 'canonical',
                  partitions: [
                    {
                      scopes: ['secret'],
                      affected: {
                        episodeIds: [hiddenEvidence.episodeId],
                        entityIds: [],
                        factIds: [hiddenEvidence.target.id],
                      },
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
    const { memory } = harness({ storage })
    await memory.open({ create: true })
    await memory.remember({
      id: 'correction-race-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice has a correction target.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'alice', name: 'Alice' }],
        facts: [
          {
            id: 'correction-race-fact',
            subject: { id: 'alice' },
            predicate: 'correction_race_fact',
            object: { scalar: true },
          },
        ],
      },
    })
    await memory.remember({
      id: 'hidden-support-episode',
      kind: 'event',
      content: { type: 'text', text: 'Private support appears during correction planning.' },
      source: { kind: 'fixture' },
      scopes: ['secret'],
    })

    injectHiddenSupport = true
    await expect(
      memory.correctFact(
        {
          factId: 'correction-race-fact',
          replacement: {
            id: 'correction-race-replacement',
            subject: { id: 'alice' },
            predicate: 'correction_race_fact',
            object: { scalar: false },
          },
          access,
          workLimits: { maxRecords: 64 },
        },
        { operationId: 'racing-correction' },
      ),
    ).rejects.toMatchObject({ code: 'scope_denied' })
    await expect(driver.get('fact', 'space-1', 'correction-race-fact')).resolves.toMatchObject({
      status: 'active',
    })
    await expect(driver.get('fact', 'space-1', 'correction-race-replacement')).resolves.toBeNull()
    await expect(driver.get('evidence', 'space-1', hiddenEvidence.id)).resolves.toEqual(
      hiddenEvidence,
    )
    await expect(driver.get('operation', 'space-1', 'racing-correction')).resolves.toBeNull()
  })

  it('commits no retraction rows when a concurrent facade wins the revision race', async () => {
    const base = harness().storage
    const driver = storageDriver(base)
    const peerRef: { current?: ReturnType<typeof harness>['memory'] } = {}
    let injectRace = false
    const racing = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            if (
              injectRace &&
              change.puts?.some(
                (record) => record.kindRecord === 'evidence' && record.status === 'withdrawn',
              )
            ) {
              injectRace = false
              await peerRef.current!.remember(
                {
                  id: 'retraction-race-winner',
                  kind: 'event',
                  content: { type: 'text', text: 'A concurrent canonical mutation.' },
                  source: { kind: 'fixture' },
                },
                { operationId: 'retraction-race-winner' },
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
    const primaryContext = harness({ storage })
    const peerContext = harness({ storage })
    peerRef.current = peerContext.memory
    await primaryContext.memory.open({ create: true })
    await peerRef.current.open()
    await primaryContext.memory.remember({
      id: 'retraction-race-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice has support that must remain atomic.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'alice', name: 'Alice' }],
        facts: [
          {
            id: 'retraction-race-fact',
            subject: { id: 'alice' },
            predicate: 'retraction_race_fact',
            object: { scalar: true },
          },
        ],
      },
    })
    const evidence = await driver.query({
      kind: 'evidence',
      spaceId: 'space-1',
      filters: [
        { field: 'target.kind', op: 'eq', value: 'fact' },
        { field: 'target.id', op: 'eq', value: 'retraction-race-fact' },
      ],
    })
    expect(evidence).toHaveLength(1)

    injectRace = true
    await expect(
      primaryContext.memory.retractFact(
        {
          factId: 'retraction-race-fact',
          allSupport: true,
          access,
          workLimits: { maxRecords: 32 },
        },
        { operationId: 'racing-retraction' },
      ),
    ).rejects.toMatchObject({ code: 'conflict', operationId: 'racing-retraction' })
    await expect(driver.get('fact', 'space-1', 'retraction-race-fact')).resolves.toMatchObject({
      status: 'active',
    })
    await expect(driver.get('evidence', 'space-1', evidence[0]!.id)).resolves.toMatchObject({
      status: 'active',
    })
    await expect(driver.get('operation', 'space-1', 'racing-retraction')).resolves.toBeNull()
  })

  it('commits no episode deletion rows when a concurrent facade wins the revision race', async () => {
    const base = harness().storage
    const driver = storageDriver(base)
    const peerRef: { current?: ReturnType<typeof harness>['memory'] } = {}
    let injectRace = false
    const racing = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            if (
              injectRace &&
              change.puts?.some(
                (record) => record.kindRecord === 'episode' && record.retentionState === 'deleted',
              )
            ) {
              injectRace = false
              await peerRef.current!.remember(
                {
                  id: 'deletion-race-winner',
                  kind: 'event',
                  content: { type: 'text', text: 'A concurrent canonical mutation.' },
                  source: { kind: 'fixture' },
                },
                { operationId: 'deletion-race-winner' },
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
    const primaryContext = harness({ storage })
    const peerContext = harness({ storage })
    peerRef.current = peerContext.memory
    await primaryContext.memory.open({ create: true })
    await peerRef.current.open()
    await primaryContext.memory.remember({
      id: 'deletion-race-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice has support that must remain atomic.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'alice', name: 'Alice' }],
        facts: [
          {
            id: 'deletion-race-fact',
            subject: { id: 'alice' },
            predicate: 'deletion_race_fact',
            object: { scalar: true },
          },
        ],
      },
    })

    injectRace = true
    await expect(
      primaryContext.memory.deleteEpisode(
        {
          episodeId: 'deletion-race-source',
          access,
          workLimits: { maxRecords: 64 },
        },
        { operationId: 'racing-deletion' },
      ),
    ).rejects.toMatchObject({ code: 'conflict', operationId: 'racing-deletion' })
    await expect(driver.get('episode', 'space-1', 'deletion-race-source')).resolves.toMatchObject({
      retentionState: 'retained',
    })
    await expect(driver.get('fact', 'space-1', 'deletion-race-fact')).resolves.toMatchObject({
      status: 'active',
    })
    await expect(driver.get('operation', 'space-1', 'racing-deletion')).resolves.toBeNull()
    const lifecycles = await driver.query({ kind: 'lifecycle', spaceId: 'space-1' })
    expect(lifecycles.some((record) => record.operationId === 'racing-deletion')).toBe(false)
  })

  it('commits no grouped deletion rows when a concurrent facade wins the revision race', async () => {
    const base = harness().storage
    const driver = storageDriver(base)
    const peerRef: { current?: ReturnType<typeof harness>['memory'] } = {}
    let injectRace = false
    const racing = new Proxy(driver, {
      get(target, property, receiver) {
        if (property === 'commit') {
          return async (change: StorageCommit) => {
            if (
              injectRace &&
              change.puts?.some(
                (record) => record.kindRecord === 'episode' && record.retentionState === 'deleted',
              )
            ) {
              injectRace = false
              await peerRef.current!.remember(
                {
                  id: 'bulk-deletion-race-winner',
                  kind: 'event',
                  content: { type: 'text', text: 'A concurrent canonical mutation.' },
                  source: { kind: 'fixture' },
                },
                { operationId: 'bulk-deletion-race-winner' },
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
    const primaryContext = harness({ storage })
    const peerContext = harness({ storage })
    peerRef.current = peerContext.memory
    await primaryContext.memory.open({ create: true })
    await peerRef.current.open()
    for (const id of ['bulk-deletion-race-a', 'bulk-deletion-race-b']) {
      await primaryContext.memory.remember({
        id,
        kind: 'assertion',
        content: { type: 'text', text: `${id} has support that must remain atomic.` },
        source: { kind: 'fixture' },
        tags: ['bulk-deletion-race'],
        assertions: {
          entities: [{ id: `${id}-entity`, name: id }],
          facts: [
            {
              id: `${id}-fact`,
              subject: { id: `${id}-entity` },
              predicate: 'bulk_deletion_race_fact',
              object: { scalar: true },
            },
          ],
        },
      })
    }
    const where = { tags: { all: ['bulk-deletion-race'] } } as const
    const preview = await primaryContext.memory.snapshot({ access, filters: { episodes: where } })

    injectRace = true
    await expect(
      primaryContext.memory.deleteEpisodes(
        {
          where,
          access,
          expectedRevision: preview.snapshotRevision,
          maxMatches: 2,
          workLimits: { maxRecords: 64 },
        },
        { operationId: 'racing-bulk-deletion' },
      ),
    ).rejects.toMatchObject({ code: 'conflict', operationId: 'racing-bulk-deletion' })
    for (const id of ['bulk-deletion-race-a', 'bulk-deletion-race-b']) {
      await expect(driver.get('episode', 'space-1', id)).resolves.toMatchObject({
        retentionState: 'retained',
      })
      await expect(driver.get('fact', 'space-1', `${id}-fact`)).resolves.toMatchObject({
        status: 'active',
      })
    }
    await expect(driver.get('operation', 'space-1', 'racing-bulk-deletion')).resolves.toBeNull()
    const lifecycles = await driver.query({ kind: 'lifecycle', spaceId: 'space-1' })
    expect(lifecycles.some((record) => record.operationId === 'racing-bulk-deletion')).toBe(false)
  })

  it('physically scrubs evidence-grounded derivations during hard purge', async () => {
    const { memory, storage } = await seedTwoFacts()
    const archive = await memory.export({ access, complete: true })
    const evidenceId = archive.canonical.evidence.find(
      (link) => link.target.kind === 'fact' && link.target.id === 'fact-a',
    )!.id
    const deriveInput = {
      conclusion: {
        id: 'derived-c',
        subjectId: 'alice',
        predicate: 'derived_c',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'rules/evidence-implies-c', version: '1' },
      premises: [{ kind: 'evidence', id: evidenceId }],
      access,
      expectedRevision: await revision(memory),
    } as const
    await memory.deriveFact(deriveInput, { operationId: 'derive-before-purge' })

    const purged = await memory.hardPurge({ access, episodeIds: ['source-episode'] })
    expect(purged.unsupportedFacts).toContain('derived-c')
    const records = await storageDriver(storage).exportRecords('space-1')
    expect(records.some((record) => record.kindRecord === 'derivation')).toBe(false)
    expect(
      records.find(
        (record): record is StoredFact => record.kindRecord === 'fact' && record.id === 'derived-c',
      )?.status,
    ).toBe('deleted')
    const scrubbedOperation = records.find(
      (record) => record.kindRecord === 'operation' && record.id === 'derive-before-purge',
    )
    expect(scrubbedOperation).toMatchObject({ kindRecord: 'operation' })
    expect(scrubbedOperation).not.toHaveProperty('result')
    await expect(
      memory.deriveFact(deriveInput, { operationId: 'derive-before-purge' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' })
  })
})
