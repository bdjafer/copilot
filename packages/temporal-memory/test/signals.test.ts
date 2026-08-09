import { describe, expect, it, vi } from 'vitest'

import { MemoryError, type JsonValue } from '../src/index.ts'
import { sha256, stableStringify } from '../src/internal/value.ts'
import { storageDriver, type StoredSignal } from '../src/storage/driver.ts'
import { harness } from './support.ts'

const access = { allowedScopes: [] as string[] }
const privateAccess = { allowedScopes: ['private'] }
const SIGNAL_KEY_HASH_DOMAIN = 'astrale.temporal-memory/signal-key/v1'

async function rememberEntity(
  memory: ReturnType<typeof harness>['memory'],
  id: string,
  scopes: readonly string[] = [],
) {
  return memory.remember({
    id: `${id}-episode`,
    kind: 'assertion',
    content: { type: 'text', text: `${id} is observable.` },
    source: { kind: 'fixture' },
    scopes,
    assertions: { entities: [{ id, name: id }] },
  })
}

describe('scoped non-epistemic signals', () => {
  it('versions revision-bound algorithm output without changing retrieval semantics', async () => {
    let instant = '2026-08-03T10:00:00.000Z'
    const { memory } = harness({ now: () => new Date(instant) })
    await memory.open({ create: true })
    await rememberEntity(memory, 'active-thread')
    const baseline = await memory.snapshot({ access })
    const recalledBefore = await memory.recall({ query: 'active-thread', access })

    const first = await memory.putSignals({
      access,
      expectedRevision: baseline.snapshotRevision,
      signals: [
        {
          namespace: '__proto__',
          slot: 'membership',
          target: { kind: 'episode', id: 'active-thread-episode' },
          producer: { kind: 'algorithm', id: 'louvain', version: '1.0.0' },
          scopes: [],
          tags: ['cluster:ongoing-work'],
          basis: { episodeIds: ['active-thread-episode'] },
          value: { cluster: 'ongoing-work', confidence: 0.92 },
          expiresAt: '2026-08-04T00:00:00.000Z',
        },
      ],
    })

    expect(first).toMatchObject({ revision: baseline.snapshotRevision + 1, supersededIds: [] })
    expect(first.signals[0]).toMatchObject({
      version: 1,
      inputRevision: baseline.snapshotRevision,
      recordedRevision: baseline.snapshotRevision + 1,
      producer: { version: '1.0.0' },
      state: 'active',
    })
    await expect(
      memory.putSignals({
        access,
        expectedRevision: baseline.snapshotRevision,
        signals: [
          {
            namespace: '__proto__',
            slot: 'membership',
            target: { kind: 'episode', id: 'active-thread-episode' },
            producer: { kind: 'algorithm', id: 'louvain', version: '1.0.1' },
            scopes: [],
            basis: { episodeIds: ['active-thread-episode'] },
            value: { cluster: 'stale-read' },
          },
        ],
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'conflict'))

    instant = '2026-08-03T11:00:00.000Z'
    const second = await memory.putSignals({
      access,
      expectedRevision: first.revision,
      signals: [
        {
          namespace: '__proto__',
          slot: 'membership',
          target: { kind: 'episode', id: 'active-thread-episode' },
          producer: { kind: 'algorithm', id: 'louvain', version: '1.1.0' },
          scopes: [],
          tags: ['cluster:archived-work'],
          basis: { episodeIds: ['active-thread-episode'] },
          value: { cluster: 'archived-work', confidence: 0.81 },
          expiresAt: '2026-08-03T10:30:00.000Z',
        },
      ],
    })
    expect(second.signals[0]).toMatchObject({ version: 2, supersedes: first.signals[0]!.id })
    expect(second.supersededIds).toEqual([first.signals[0]!.id])

    const current = await memory.browseSignals({ access })
    expect(current.signals).toEqual([])
    const expired = await memory.browseSignals({ access, includeExpired: true })
    expect(expired).toMatchObject({ total: 1, signals: [expect.objectContaining({ version: 2 })] })
    const history = await memory.browseSignals({
      access,
      revisionView: 'history',
      where: { producerVersions: ['1.0.0'], tags: { all: ['cluster:ongoing-work'] } },
    })
    expect(history.signals).toEqual([expect.objectContaining({ version: 1 })])

    const semanticDelta = await memory.changes({ access, cursor: baseline.changesCursor })
    expect(semanticDelta.changes).toEqual([])
    expect(semanticDelta.currentRevision).toBe(second.revision)
    expect(await memory.recall({ query: 'active-thread', access })).toEqual({
      ...recalledBefore,
      snapshotRevision: second.revision,
      generatedAt: instant,
    })
    const analysis = await memory.analyze({ access })
    expect(analysis).toMatchObject({
      signals: {
        active: 0,
        expired: 1,
        withdrawn: 0,
      },
    })
    expect(
      Object.getOwnPropertyDescriptor(analysis.signals.byNamespace, '__proto__')?.value,
    ).toEqual({ active: 0, expired: 1, withdrawn: 0 })
  })

  it('detaches browse, put, and delete requests before asynchronous signal work', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await rememberEntity(memory, 'snapshot-target')
    const baseline = await memory.snapshot({ access })
    let namespaceReads = 0
    const signal = {
      target: { kind: 'episode' as const, id: 'snapshot-target-episode' },
      producer: { kind: 'algorithm' as const, id: 'snapshot-algorithm', version: '1' },
      scopes: [] as string[],
      tags: ['snapshot:original'],
      basis: { episodeIds: ['snapshot-target-episode'] },
      value: { state: 'original' },
    } as {
      namespace: string
      target: { kind: 'episode'; id: string }
      producer: { kind: 'algorithm'; id: string; version: string }
      scopes: string[]
      tags: string[]
      basis: { episodeIds: string[] }
      value: { state: string }
    }
    Object.defineProperty(signal, 'namespace', {
      enumerable: true,
      get: () => {
        namespaceReads += 1
        if (namespaceReads > 1) throw new Error('signal namespace was read more than once')
        return 'snapshot.original'
      },
    })
    const putRequest = {
      access: { allowedScopes: [] as string[] },
      expectedRevision: baseline.snapshotRevision,
      signals: [signal],
    }
    const putPromise = memory.putSignals(putRequest)
    signal.target.id = 'mutated-missing-episode'
    signal.producer.version = 'mutated'
    signal.tags[0] = 'snapshot:mutated'
    signal.basis.episodeIds[0] = 'mutated-missing-episode'
    signal.value.state = 'mutated'
    putRequest.access.allowedScopes.push('private')
    const put = await putPromise
    expect(namespaceReads).toBe(1)
    expect(put.signals).toEqual([
      expect.objectContaining({
        namespace: 'snapshot.original',
        target: { kind: 'episode', id: 'snapshot-target-episode' },
        producer: { kind: 'algorithm', id: 'snapshot-algorithm', version: '1' },
        tags: ['snapshot:original'],
        basis: { episodeIds: ['snapshot-target-episode'], entityIds: [], factIds: [] },
        value: { state: 'original' },
      }),
    ])

    const browseRequest = {
      access: { allowedScopes: [] as string[] },
      where: { namespaces: ['snapshot.original'] },
      limit: 10,
    }
    const browsePromise = memory.browseSignals(browseRequest)
    browseRequest.where.namespaces[0] = 'snapshot.mutated'
    browseRequest.access.allowedScopes.push('private')
    const page = await browsePromise
    expect(page.signals.map((item) => item.id)).toEqual([put.signals[0]!.id])

    const deleteRequest: {
      access: { allowedScopes: string[] }
      mode: 'withdraw' | 'purge'
      where: { namespaces: string[] }
      expectedRevision: number
      maxMatches: number
      reason?: string
      maxRevisions?: number
    } = {
      access: { allowedScopes: [] },
      mode: 'withdraw',
      where: { namespaces: ['snapshot.original'] },
      expectedRevision: put.revision,
      maxMatches: 1,
      reason: 'original retirement',
    }
    const deletePromise = memory.deleteSignals(deleteRequest)
    deleteRequest.mode = 'purge'
    deleteRequest.where.namespaces[0] = 'snapshot.mutated'
    deleteRequest.reason = 'mutated retirement'
    deleteRequest.maxRevisions = 1
    const deleted = await deletePromise
    expect(deleted).toMatchObject({
      mode: 'withdraw',
      matchedSignals: 1,
      affectedKeys: [put.signals[0]!.key],
      withdrawn: [expect.objectContaining({ withdrawalReason: 'original retirement' })],
      deletedRevisions: 0,
    })
    expect(await memory.browseSignals({ access, revisionView: 'history' })).toMatchObject({
      total: 2,
    })

    const unreadable = Object.defineProperty({}, 'access', {
      enumerable: true,
      get: () => {
        throw new Error('unreadable signal request')
      },
    })
    await expect(memory.browseSignals(unreadable as never)).rejects.toSatisfy((error: unknown) =>
      MemoryError.is(error, 'invalid_input'),
    )
    await expect(memory.putSignals(unreadable as never)).rejects.toSatisfy((error: unknown) =>
      MemoryError.is(error, 'invalid_input'),
    )
    await expect(memory.deleteSignals(unreadable as never)).rejects.toSatisfy((error: unknown) =>
      MemoryError.is(error, 'invalid_input'),
    )
    await expect(memory.browseSignals({ access, unexpected: true } as never)).rejects.toSatisfy(
      (error: unknown) => MemoryError.is(error, 'invalid_input'),
    )
    await expect(
      memory.putSignals({
        access,
        expectedRevision: deleted.revision,
        signals: [],
        unexpected: true,
      } as never),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))
    await expect(
      memory.deleteSignals({
        access,
        mode: 'withdraw',
        where: { namespaces: ['snapshot.original'] },
        expectedRevision: deleted.revision,
        maxMatches: 1,
        unexpected: true,
      } as never),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))
  })

  it('derives disclosure and grounds every entity target or basis reference', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    await rememberEntity(memory, 'private-modal', ['private'])
    await rememberEntity(memory, 'public-target')
    const snapshot = await memory.snapshot({ access: privateAccess })
    const baseSignal = {
      namespace: 'peripheral.modal',
      target: { kind: 'entity' as const, id: 'private-modal' },
      producer: { kind: 'algorithm' as const, id: 'attention-model', version: '1' },
      value: { visible: true },
    }

    await expect(
      memory.putSignals({
        access: privateAccess,
        expectedRevision: snapshot.snapshotRevision,
        signals: [
          {
            ...baseSignal,
            scopes: [],
            basis: { episodeIds: ['private-modal-episode'] },
          },
        ],
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'scope_denied'))

    await expect(
      memory.putSignals({
        access: privateAccess,
        expectedRevision: snapshot.snapshotRevision,
        signals: [
          {
            ...baseSignal,
            scopes: ['private'],
            basis: { entityIds: ['private-modal'] },
          },
        ],
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))

    await expect(
      memory.putSignals({
        access: privateAccess,
        expectedRevision: snapshot.snapshotRevision,
        signals: [
          {
            namespace: 'scope-laundering-attempt',
            target: { kind: 'episode', id: 'public-target-episode' },
            producer: { kind: 'algorithm', id: 'attention-model', version: '1' },
            scopes: [],
            basis: { entityIds: ['private-modal'] },
            value: { visible: true },
          },
        ],
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))

    const basisQueries = vi.spyOn(storageDriver(storage), 'query')
    const stored = await memory.putSignals({
      access: privateAccess,
      expectedRevision: snapshot.snapshotRevision,
      signals: [
        {
          ...baseSignal,
          scopes: ['private'],
          basis: { episodeIds: ['private-modal-episode'] },
        },
      ],
    })
    expect(stored.signals[0]).toMatchObject({ scopes: ['private'] })
    expect(
      basisQueries.mock.calls.some(
        ([query]) =>
          query.kind === 'fact' &&
          query.filters?.some(
            (filter) => filter.field === 'subjectId' || filter.field === 'object.entityId',
          ),
      ),
    ).toBe(false)
    expect((await memory.browseSignals({ access })).signals).toEqual([])
    expect((await memory.browseSignals({ access: privateAccess })).signals).toHaveLength(1)
    expect(await memory.verifyIntegrity()).toMatchObject({ ok: true })
  })

  it('uses the addressed temporal lifecycle when validating a historical fact basis', async () => {
    let instant = '2025-01-01T00:00:00.000Z'
    const { memory } = harness({ now: () => new Date(instant) })
    await memory.open({ create: true })
    const ingestion = await memory.remember({
      id: 'historical-fact-episode',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice worked at Acme.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          { id: 'historical-alice', name: 'Historical Alice' },
          { id: 'historical-acme', name: 'Historical Acme' },
        ],
        facts: [
          {
            subject: { id: 'historical-alice' },
            predicate: 'worked_at',
            object: { id: 'historical-acme' },
          },
        ],
      },
    })
    const factId = ingestion.facts.created[0]!
    instant = '2027-01-01T00:00:00.000Z'
    await memory.retractFact({ factId, allSupport: true, access })
    const baseline = await memory.snapshot({ access })
    const signal = {
      namespace: 'historical.fact-basis',
      target: { kind: 'fact' as const, id: factId },
      producer: { kind: 'algorithm' as const, id: 'historical-validator', version: '1' },
      scopes: [] as string[],
      basis: { factIds: [factId] },
      value: { admitted: true },
    }

    await expect(
      memory.putSignals({
        access,
        expectedRevision: baseline.snapshotRevision,
        signals: [signal],
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'not_found'))
    expect((await memory.stats()).snapshotRevision).toBe(baseline.snapshotRevision)

    const stored = await memory.putSignals({
      access,
      expectedRevision: baseline.snapshotRevision,
      basisView: { kind: 'known-at', at: '2026-01-01T00:00:00.000Z' },
      signals: [signal],
    })
    expect(stored.signals[0]).toMatchObject({
      target: { kind: 'fact', id: factId },
      basisView: { kind: 'known-at', at: '2026-01-01T00:00:00.000Z' },
    })
    expect(stored.basisScan.records).toBeGreaterThan(1)
  })

  it('resolves only addressed active merge components in the current basis view', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'merged-identity-episode',
      kind: 'assertion',
      content: { type: 'text', text: 'Old and canonical identities refer to one person.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          { id: 'old-identity', name: 'Old Identity' },
          { id: 'canonical-identity', name: 'Canonical Identity' },
        ],
      },
    })
    await memory.mergeEntities({
      targetId: 'canonical-identity',
      sourceIds: ['old-identity'],
      access,
    })
    const baseline = await memory.snapshot({ access })
    const input = (targetId: string, namespace: string) => ({
      namespace,
      target: { kind: 'entity' as const, id: targetId },
      producer: { kind: 'algorithm' as const, id: 'identity-resolver', version: '1' },
      scopes: [] as string[],
      basis: { episodeIds: ['merged-identity-episode'] },
      value: { admitted: true },
    })

    await expect(
      memory.putSignals({
        access,
        expectedRevision: baseline.snapshotRevision,
        signals: [input('old-identity', 'merge.current-source')],
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'not_found'))

    const current = await memory.putSignals({
      access,
      expectedRevision: baseline.snapshotRevision,
      signals: [input('canonical-identity', 'merge.current-target')],
    })
    const history = await memory.putSignals({
      access,
      expectedRevision: current.revision,
      basisView: { kind: 'history' },
      signals: [input('old-identity', 'merge.historical-source')],
    })
    expect(current.signals[0]?.target.id).toBe('canonical-identity')
    expect(history.signals[0]).toMatchObject({
      target: { kind: 'entity', id: 'old-identity' },
      basisView: { kind: 'history' },
    })
  })

  it('bounds aggregate signal batch payloads and memberships', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await rememberEntity(memory, 'bounded-target')
    const snapshot = await memory.snapshot({ access })

    await expect(
      memory.putSignals({
        access,
        expectedRevision: snapshot.snapshotRevision,
        signals: Array.from({ length: 11 }, (_, batch) => ({
          namespace: 'bounded.memberships',
          slot: String(batch),
          target: { kind: 'episode' as const, id: 'bounded-target-episode' },
          producer: { kind: 'manual' as const, id: 'fixture', version: '1' },
          scopes: [],
          tags: Array<string>(10_000).fill('repeated'),
          value: null,
        })),
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))

    const largeValue = 'x'.repeat(2_100_000)
    await expect(
      memory.putSignals({
        access,
        expectedRevision: snapshot.snapshotRevision,
        signals: ['a', 'b'].map((slot) => ({
          namespace: 'bounded.values',
          slot,
          target: { kind: 'episode' as const, id: 'bounded-target-episode' },
          producer: { kind: 'manual' as const, id: 'fixture', version: '1' },
          scopes: [],
          value: largeValue,
        })),
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))
  })

  it('streams sparse signal basis validation under exact scan limits', async () => {
    const seed = async (unrelated: number) => {
      const context = harness()
      await context.memory.open({ create: true })
      await rememberEntity(context.memory, 'basis-scan-target')
      for (let index = 0; index < unrelated; index += 1) {
        await rememberEntity(context.memory, `unrelated-${index.toString().padStart(2, '0')}`)
      }
      return context
    }
    const request = (expectedRevision: number) => ({
      access,
      expectedRevision,
      signals: [
        {
          namespace: 'bounded.basis-scan',
          target: { kind: 'episode' as const, id: 'basis-scan-target-episode' },
          producer: { kind: 'algorithm' as const, id: 'basis-validator', version: '1' },
          scopes: [] as string[],
          basis: { episodeIds: ['basis-scan-target-episode'] },
          value: { admitted: true },
        },
      ],
    })

    const baseline = await seed(0)
    const baselineRevision = (await baseline.memory.stats()).snapshotRevision
    const report = await baseline.memory.putSignals({
      ...request(baselineRevision),
      basisScanLimits: { maxRecords: 1_000, maxBytes: 16 * 1024 * 1024 },
    })

    const crowded = await seed(17)
    const crowdedDriver = storageDriver(crowded.storage)
    const crowdedExport = vi
      .spyOn(crowdedDriver, 'exportRecords')
      .mockRejectedValue(new Error('signal basis validation must not use whole-space export'))
    const crowdedRevision = (await crowded.memory.stats()).snapshotRevision
    const crowdedQueries = vi.spyOn(crowdedDriver, 'query')
    const crowdedReport = await crowded.memory.putSignals({
      ...request(crowdedRevision),
      basisScanLimits: { maxRecords: 1_000, maxBytes: 16 * 1024 * 1024 },
    })

    expect(report.basisScan).toMatchObject({
      records: expect.any(Number),
      bytes: expect.any(Number),
      limits: { maxRecords: 1_000, maxBytes: 16 * 1024 * 1024 },
    })
    expect(report.basisScan.records).toBeGreaterThan(1)
    expect(report.basisScan.bytes).toBeGreaterThan(0)
    expect(crowdedReport.basisScan).toEqual(report.basisScan)
    expect(crowdedExport).not.toHaveBeenCalled()
    const basisKinds = new Set([
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
    const addressedFields = new Set([
      'id',
      'episodeId',
      'entityId',
      'subjectId',
      'object.entityId',
      'target.id',
      'targetId',
      'sourceIds',
      'conclusionFactId',
    ])
    expect(
      crowdedQueries.mock.calls
        .map(([query]) => query)
        .filter((query) => basisKinds.has(query.kind))
        .every((query) => query.limit !== undefined && query.limit <= 16),
    ).toBe(true)
    expect(
      crowdedQueries.mock.calls
        .map(([query]) => query)
        .filter((query) => basisKinds.has(query.kind))
        .every((query) =>
          query.filters?.some(
            (filter) =>
              addressedFields.has(filter.field) &&
              (filter.op === 'in' || filter.op === 'contains_any'),
          ),
        ),
    ).toBe(true)

    const recordLimited = await seed(0)
    const beforeRecordLimit = await recordLimited.memory.stats()
    await expect(
      recordLimited.memory.putSignals({
        ...request(beforeRecordLimit.snapshotRevision),
        basisScanLimits: {
          maxRecords: report.basisScan.records - 1,
          maxBytes: report.basisScan.bytes,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'signal_basis_scan',
        dimension: 'records',
        required: report.basisScan.records,
        maximum: report.basisScan.records - 1,
      },
    })
    expect((await recordLimited.memory.stats()).snapshotRevision).toBe(
      beforeRecordLimit.snapshotRevision,
    )
    expect((await recordLimited.memory.browseSignals({ access })).signals).toEqual([])
    const recordRetry = await recordLimited.memory.putSignals({
      ...request(beforeRecordLimit.snapshotRevision),
      basisScanLimits: {
        maxRecords: report.basisScan.records,
        maxBytes: report.basisScan.bytes,
      },
    })
    expect(recordRetry.basisScan).toMatchObject({
      records: report.basisScan.records,
      bytes: report.basisScan.bytes,
    })

    const byteLimited = await seed(0)
    const beforeByteLimit = await byteLimited.memory.stats()
    await expect(
      byteLimited.memory.putSignals({
        ...request(beforeByteLimit.snapshotRevision),
        basisScanLimits: {
          maxRecords: report.basisScan.records,
          maxBytes: report.basisScan.bytes - 1,
        },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'signal_basis_scan',
        dimension: 'bytes',
        required: report.basisScan.bytes,
        maximum: report.basisScan.bytes - 1,
      },
    })
    expect((await byteLimited.memory.stats()).snapshotRevision).toBe(
      beforeByteLimit.snapshotRevision,
    )
    expect((await byteLimited.memory.browseSignals({ access })).signals).toEqual([])
    const byteRetry = await byteLimited.memory.putSignals({
      ...request(beforeByteLimit.snapshotRevision),
      basisScanLimits: {
        maxRecords: report.basisScan.records,
        maxBytes: report.basisScan.bytes,
      },
    })
    expect(byteRetry.basisScan).toMatchObject({
      records: report.basisScan.records,
      bytes: report.basisScan.bytes,
    })
  })

  it('withdraws and purges groups by namespace plus time with breadth guards', async () => {
    let instant = '2026-08-01T00:00:00.000Z'
    const { memory } = harness({ now: () => new Date(instant) })
    await memory.open({ create: true })
    await rememberEntity(memory, 'session-a')
    await rememberEntity(memory, 'session-b')
    await rememberEntity(memory, 'modal')
    const baseline = await memory.snapshot({ access })
    const dream = await memory.putSignals({
      access,
      expectedRevision: baseline.snapshotRevision,
      signals: ['session-a', 'session-b'].map((id, index) => ({
        namespace: 'dream.salience',
        slot: 'strength',
        target: { kind: 'episode' as const, id: `${id}-episode` },
        producer: { kind: 'algorithm' as const, id: 'graph-dream', version: '2' },
        scopes: [],
        tags: ['cluster:working'],
        basis: { episodeIds: [`${id}-episode`] },
        value: { score: 0.8 - index / 10 },
      })),
    })
    instant = '2026-08-02T00:00:00.000Z'
    const peripheral = await memory.putSignals({
      access,
      expectedRevision: dream.revision,
      signals: [
        {
          namespace: 'peripheral.modal',
          target: { kind: 'episode', id: 'modal-episode' },
          producer: { kind: 'manual', id: 'ui-observer', version: '1' },
          scopes: [],
          value: { open: true },
        },
      ],
    })
    const selector = {
      namespaces: ['dream.salience'],
      tags: { all: ['cluster:working'] },
      recordedAt: { until: '2026-08-02T00:00:00.000Z' },
    } as const

    await expect(
      memory.deleteSignals({
        access,
        mode: 'withdraw',
        where: selector,
        expectedRevision: peripheral.revision,
        maxMatches: 1,
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'result_too_large'))

    const withdrawn = await memory.deleteSignals({
      access,
      mode: 'withdraw',
      where: selector,
      expectedRevision: peripheral.revision,
      maxMatches: 2,
      reason: 'dream recomputation invalidated this cluster',
    })
    expect(withdrawn).toMatchObject({ matchedSignals: 2, deletedRevisions: 0 })
    expect(withdrawn.withdrawn).toHaveLength(2)
    expect((await memory.browseSignals({ access })).signals).toEqual([
      expect.objectContaining({ namespace: 'peripheral.modal' }),
    ])
    expect(
      (
        await memory.browseSignals({
          access,
          revisionView: 'history',
          where: { namespaces: ['dream.salience'] },
        })
      ).signals,
    ).toHaveLength(4)
    expect(await memory.stats()).toMatchObject({ signals: 1, signalRevisions: 5 })

    const purged = await memory.deleteSignals({
      access,
      mode: 'purge',
      where: { namespaces: ['dream.salience'], states: ['withdrawn'] },
      expectedRevision: withdrawn.revision,
      maxMatches: 2,
    })
    expect(purged).toMatchObject({ matchedSignals: 2, deletedRevisions: 4, withdrawn: [] })
    expect(
      (
        await memory.browseSignals({
          access,
          revisionView: 'history',
          where: { namespaces: ['dream.salience'] },
        })
      ).signals,
    ).toEqual([])
    expect(await memory.stats()).toMatchObject({ signals: 1, signalRevisions: 1 })
  })

  it('bounds logical signal scans and atomically purges revision history by key', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    await rememberEntity(memory, 'bounded-signal-target')
    const driver = storageDriver(storage)
    const space = (await driver.getSpace('space-1'))!
    const recordedAt = '2026-08-05T00:00:00.000Z'
    const signals: StoredSignal[] = Array.from({ length: 1_001 }, (_, index) => {
      const key = index.toString(16).padStart(64, '0')
      return {
        kindRecord: 'signal',
        id: `signal_${key}_00000001`,
        spaceId: 'space-1',
        key,
        version: 1,
        namespace: 'bounded.signal-governance',
        slot: `slot-${index.toString().padStart(4, '0')}`,
        target: { kind: 'episode', id: 'bounded-signal-target-episode' },
        producer: { kind: 'manual', id: 'bounded-fixture', version: '1' },
        scopes: [],
        tags: ['cluster:bounded'],
        basis: { episodeIds: [], entityIds: [], factIds: [] },
        inputRevision: space.revision,
        recordedRevision: space.revision + 1,
        basisView: { kind: 'current' },
        recordedAt,
        state: 'active',
        value: index,
      }
    })
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
    await expect(
      driver.commit({
        spaceId: 'space-1',
        expectedRevision: space.revision + 1,
        signalKeyDeletes: [signals[0]!.key],
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'integrity_failed'))

    const originalQuery = driver.query.bind(driver)
    const query = vi.spyOn(driver, 'query').mockImplementation(async (request) => {
      if (request.kind === 'signal' && request.limit === undefined) {
        throw new Error('signal scans must always be bounded')
      }
      return originalQuery(request)
    })
    const originalCommit = driver.commit.bind(driver)
    const commit = vi
      .spyOn(driver, 'commit')
      .mockImplementation(async (change) => originalCommit(change))
    const where = { namespaces: ['bounded.signal-governance'] } as const
    const first = await memory.browseSignals({ access, where, order: 'key', limit: 200 })
    expect(first).toMatchObject({
      total: 1_001,
      signals: expect.arrayContaining([
        expect.objectContaining({ namespace: where.namespaces[0] }),
      ]),
      nextCursor: expect.any(String),
      targetSelectionCursor: expect.any(String),
    })
    expect(first.signals).toHaveLength(200)
    expect(first.byteLength).toBeLessThanOrEqual(16 * 1_024 * 1_024)
    expect(
      new TextEncoder().encode(stableStringify(first as unknown as JsonValue)).byteLength,
    ).toBe(first.byteLength)
    const second = await memory.browseSignals({
      access,
      where,
      order: 'key',
      limit: 200,
      cursor: first.nextCursor,
    })
    expect(second).toMatchObject({ total: 1_001, nextCursor: expect.any(String) })
    expect(second.signals).toHaveLength(200)
    expect(new Set([...first.signals, ...second.signals].map((signal) => signal.id)).size).toBe(400)
    await expect(
      memory.browseSignals({
        access,
        where: { keys: [signals[0]!.key] },
        maxBytes: 1,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        Number(error.details?.requiredBytes) > Number(error.details?.maxBytes),
    )

    const signalQueries = query.mock.calls
      .map(([request]) => request)
      .filter((request) => request.kind === 'signal')
    expect(signalQueries.every((request) => request.limit === 16)).toBe(true)
    expect(signalQueries.some((request) => request.startAfter !== undefined)).toBe(true)

    await expect(
      memory.deleteSignals({
        access,
        mode: 'purge',
        where,
        expectedRevision: first.snapshotRevision,
        maxMatches: 1_001,
        maxRevisions: 1_000,
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') && error.details?.revisions === 1_001,
    )
    expect(commit).not.toHaveBeenCalled()

    const purged = await memory.deleteSignals({
      access,
      mode: 'purge',
      where,
      expectedRevision: first.snapshotRevision,
      maxMatches: 1_001,
      maxRevisions: 1_001,
    })
    expect(purged).toMatchObject({ matchedSignals: 1_001, deletedRevisions: 1_001 })
    expect(commit).toHaveBeenCalledTimes(1)
    expect(commit.mock.calls[0]![0]).toMatchObject({
      signalKeyDeletes: signals.map((signal) => signal.key),
      signalChange: { action: 'purge' },
    })
    expect(commit.mock.calls[0]![0].deletes).toBeUndefined()
    expect(await memory.browseSignals({ access, where, revisionView: 'history' })).toMatchObject({
      total: 0,
      signals: [],
    })
  })

  it('hard purge erases every revision whose declared target or basis depends on purged data', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    await rememberEntity(memory, 'forget-me')
    await rememberEntity(memory, 'keep-me')
    const baseline = await memory.snapshot({ access })
    const first = await memory.putSignals({
      access,
      expectedRevision: baseline.snapshotRevision,
      signals: [
        {
          namespace: 'dream.cluster',
          target: { kind: 'episode', id: 'forget-me-episode' },
          producer: { kind: 'algorithm', id: 'dream', version: '1' },
          scopes: [],
          basis: { episodeIds: ['forget-me-episode'] },
          value: { cluster: 'temporary' },
        },
        {
          namespace: 'dream.cluster',
          target: { kind: 'episode', id: 'keep-me-episode' },
          producer: { kind: 'algorithm', id: 'dream', version: '1' },
          scopes: [],
          basis: { episodeIds: ['keep-me-episode'] },
          value: { cluster: 'durable' },
        },
      ],
    })
    const dependentKey = first.signals.find(
      (signal) => signal.target.id === 'forget-me-episode',
    )!.key
    await memory.putSignals({
      access,
      expectedRevision: first.revision,
      signals: [
        {
          namespace: 'dream.cluster',
          target: { kind: 'episode', id: 'forget-me-episode' },
          producer: { kind: 'algorithm', id: 'dream', version: '2' },
          scopes: [],
          basis: { episodeIds: ['forget-me-episode'] },
          value: { cluster: 'temporary-v2' },
        },
      ],
    })

    await memory.hardPurge(
      { access, episodeIds: ['forget-me-episode'] },
      { operationId: 'purge-signal-dependency' },
    )

    const history = await memory.browseSignals({ access, revisionView: 'history' })
    expect(history.signals).toEqual([
      expect.objectContaining({ target: { kind: 'episode', id: 'keep-me-episode' } }),
    ])
    const raw = await storageDriver(storage).exportRecords('space-1')
    const rawSignals = raw.filter((record) => record.kindRecord === 'signal')
    expect(rawSignals).toHaveLength(1)
    expect(JSON.stringify(rawSignals)).not.toContain(dependentKey)
    expect(JSON.stringify(rawSignals)).not.toContain('forget-me-episode')
    expect(await memory.verifyIntegrity()).toMatchObject({ ok: true })
  })

  it('binds signal cursors to request, access partition, and immutable revision', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    for (const id of ['a', 'b', 'c']) await rememberEntity(memory, id)
    const baseline = await memory.snapshot({ access })
    const seeded = await memory.putSignals({
      access,
      expectedRevision: baseline.snapshotRevision,
      signals: ['a', 'b', 'c'].map((id) => ({
        namespace: 'cluster',
        target: { kind: 'episode' as const, id: `${id}-episode` },
        producer: { kind: 'algorithm' as const, id: 'clusterer', version: '1' },
        scopes: [],
        basis: { episodeIds: [`${id}-episode`] },
        value: { id },
      })),
    })
    const first = await memory.browseSignals({ access, limit: 1, order: 'key' })
    expect(first.nextCursor).toBeTypeOf('string')
    await expect(
      memory.browseSignals({
        access: privateAccess,
        limit: 1,
        order: 'key',
        cursor: first.nextCursor,
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'conflict'))
    await expect(
      memory.browseSignals({
        access,
        where: { namespaces: ['cluster'] },
        limit: 1,
        order: 'key',
        cursor: first.nextCursor,
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'conflict'))

    await memory.putSignals({
      access,
      expectedRevision: seeded.revision,
      signals: [
        {
          namespace: 'cluster',
          target: { kind: 'episode', id: 'a-episode' },
          producer: { kind: 'algorithm', id: 'clusterer', version: '2' },
          scopes: [],
          basis: { episodeIds: ['a-episode'] },
          value: { id: 'a2' },
        },
      ],
    })
    await expect(
      memory.browseSignals({ access, limit: 1, order: 'key', cursor: first.nextCursor }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'conflict'))
  })

  it('enforces structural storage invariants and diagnoses dangling raw dependencies', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    const driver = storageDriver(storage)
    const space = (await driver.getSpace('space-1'))!
    const identity = [
      SIGNAL_KEY_HASH_DOMAIN,
      'space-1',
      'raw.fixture',
      'default',
      'manual',
      'fixture',
      'episode',
      'missing-episode',
      [],
    ]
    const key = await sha256(stableStringify(identity))
    const raw: StoredSignal = {
      kindRecord: 'signal',
      id: `signal_${key}_00000001`,
      spaceId: 'space-1',
      key,
      version: 1,
      namespace: 'raw.fixture',
      slot: 'default',
      target: { kind: 'episode', id: 'missing-episode' },
      producer: { kind: 'manual', id: 'fixture', version: '1' },
      scopes: [],
      tags: [],
      basis: { episodeIds: [], entityIds: [], factIds: [] },
      inputRevision: space.revision,
      recordedRevision: space.revision + 1,
      basisView: { kind: 'current' },
      recordedAt: '2026-08-03T10:00:00.000Z',
      state: 'active',
      value: { source: 'raw-driver' },
    }
    await expect(
      driver.commit({
        spaceId: 'space-1',
        expectedRevision: space.revision,
        puts: [{ ...raw, recordedRevision: space.revision + 2 }],
        signalChange: {
          action: 'put',
          partitions: [{ scopes: [], affected: [{ key, target: raw.target }] }],
        },
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'integrity_failed'))

    await driver.commit({
      spaceId: 'space-1',
      expectedRevision: space.revision,
      puts: [raw],
      signalChange: {
        action: 'put',
        partitions: [{ scopes: [], affected: [{ key, target: raw.target }] }],
      },
    })
    expect(await memory.verifyIntegrity()).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'invalid_signal' })],
    })
  })
})
