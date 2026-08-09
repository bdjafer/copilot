import { describe, expect, it, vi } from 'vitest'

import type {
  EmbeddingProvider,
  InferenceRequest,
  JsonValue,
  MemoryPolicy,
  RerankProvider,
  StructuredInferenceProvider,
} from '../src/index.ts'

import { createMemory, MemoryError } from '../src/index.ts'
import { storageDriver, type StoredEvidence } from '../src/storage/driver.ts'
import { harness } from './support.ts'

function inference(
  destination: 'local' | 'remote',
  inspect?: (request: InferenceRequest) => void,
): StructuredInferenceProvider {
  return {
    lineage: {
      provider: 'fixture',
      model: 'structured-v1',
      destination,
      apiKey: 'credential-must-not-survive',
    } as StructuredInferenceProvider['lineage'],
    infer: async (request) => {
      inspect?.(request)
      return {
        entities: [{ candidateId: 'entity-1', id: 'ada', name: 'Ada Lovelace' }],
        facts: [
          {
            candidateId: 'fact-1',
            subject: { id: 'ada' },
            predicate: 'studied',
            object: { scalar: 'analytical engines' },
          },
        ],
      }
    },
  }
}

const embeddings: EmbeddingProvider = {
  lineage: {
    provider: 'fixture',
    model: 'embedding-v1',
    destination: 'local',
    dimensions: 2,
  },
  embed: async ({ texts }) => texts.map(() => [1, 0]),
}

describe('provider and disclosure boundary', () => {
  it('stores exact episode anchors and never turns canonical aliases into source mentions', async () => {
    const sentence = 'Ada Lovelace studied analytical engines.'
    const text = `${sentence} ${sentence}`
    let pass = 0
    const anchored: StructuredInferenceProvider = {
      lineage: { provider: 'fixture', model: 'anchored-v1', destination: 'local' },
      infer: async () => {
        const start = pass++ === 0 ? 0 : sentence.length + 1
        const anchor = {
          kind: 'text' as const,
          unit: 'utf16-code-unit' as const,
          start,
          end: start + sentence.length,
        }
        return {
          entities: [
            {
              candidateId: 'entity-1',
              id: 'ada',
              name: 'Ada Lovelace',
              aliases: ['Countess of Lovelace'],
              mention: {
                text: 'Ada Lovelace',
                anchor: { ...anchor, end: start + 'Ada Lovelace'.length },
              },
              evidence: { anchor, excerpt: sentence },
            },
          ],
          facts: [
            {
              candidateId: 'fact-1',
              subject: { id: 'ada' },
              predicate: 'studied',
              object: { scalar: 'analytical engines' },
              evidence: { anchor, excerpt: sentence },
            },
          ],
        }
      },
    }
    const { memory } = harness({ inference: anchored })
    await memory.open({ create: true })

    const first = await memory.remember({
      id: 'anchored',
      kind: 'text',
      content: { type: 'text', text },
      source: { kind: 'fixture' },
    })
    await memory.reprocessEpisode('anchored')

    const snapshot = await memory.snapshot({ access: { allowedScopes: [] } })
    const factId = first.facts.created[0]!
    const factEvidence = snapshot.evidence.filter(
      (link) => link.target.kind === 'fact' && link.target.id === factId,
    )
    expect(factEvidence).toHaveLength(2)
    const anchors = factEvidence
      .map((link) => link.anchor)
      .sort((left, right) =>
        left?.kind === 'text' && right?.kind === 'text' ? left.start - right.start : 0,
      )
    expect(anchors).toEqual([
      expect.objectContaining({ kind: 'text', start: 0, end: sentence.length }),
      expect.objectContaining({
        kind: 'text',
        start: sentence.length + 1,
        end: text.length,
      }),
    ])
    expect(snapshot.mentions).toHaveLength(2)
    expect(snapshot.mentions.every((mention) => mention.text === 'Ada Lovelace')).toBe(true)
    expect(snapshot.mentions.some((mention) => mention.text === 'Countess of Lovelace')).toBe(false)

    const recalled = await memory.recall({
      anchors: { factIds: [factId] },
      access: { allowedScopes: [] },
      channels: { exact: true, lexical: false, semantic: false, graph: false, temporal: false },
    })
    const citation = Object.values(recalled.citations).find(
      (item) => item.item.kind === 'fact' && item.item.id === factId,
    )
    expect(citation?.sources).toHaveLength(2)
    expect(recalled.facts[0]?.evidence[0]?.fragments).toHaveLength(2)

    const bounded = await memory.recall({
      anchors: { factIds: [factId] },
      access: { allowedScopes: [] },
      channels: { exact: true, lexical: false, semantic: false, graph: false, temporal: false },
      budget: { maxEvidence: 1 },
    })
    const boundedCitation = Object.values(bounded.citations).find(
      (item) => item.item.kind === 'fact' && item.item.id === factId,
    )
    expect(boundedCitation?.sources).toHaveLength(1)
    expect(bounded.facts[0]?.evidence.flatMap((item) => item.fragments)).toHaveLength(1)
  })

  it('resolves structured evidence and mentions through RFC 6901 JSON pointers', async () => {
    const { memory } = harness()
    await memory.open({ create: true })

    const report = await memory.remember({
      id: 'structured-anchors',
      kind: 'assertion',
      content: {
        type: 'structured',
        value: { people: [{ name: 'Ada Lovelace', role: 'mathematician' }] },
      },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          {
            id: 'ada',
            name: 'Ada Lovelace',
            mention: {
              text: 'Ada Lovelace',
              anchor: { kind: 'json-pointer', pointer: '/people/0/name' },
            },
          },
        ],
        facts: [
          {
            subject: { id: 'ada' },
            predicate: 'role',
            object: { scalar: 'mathematician' },
            evidence: { anchor: { kind: 'json-pointer', pointer: '/people/0/role' } },
          },
        ],
      },
    })

    const snapshot = await memory.snapshot({ access: { allowedScopes: [] } })
    const factId = report.facts.created[0]!
    expect(snapshot.mentions).toContainEqual(
      expect.objectContaining({
        text: 'Ada Lovelace',
        anchor: { kind: 'json-pointer', pointer: '/people/0/name' },
      }),
    )
    expect(snapshot.evidence).toContainEqual(
      expect.objectContaining({
        target: { kind: 'fact', id: factId },
        anchor: { kind: 'json-pointer', pointer: '/people/0/role' },
        excerpt: '"mathematician"',
      }),
    )
  })

  it('classifies unverifiable provider evidence shapes while retaining accepted episodes', async () => {
    const ambiguous: StructuredInferenceProvider = {
      lineage: { provider: 'fixture', model: 'ambiguous-v1', destination: 'local' },
      infer: async () => ({
        entities: [{ candidateId: 'entity-1', id: 'ada', name: 'Ada' }],
        facts: [
          {
            candidateId: 'fact-1',
            subject: { id: 'ada' },
            predicate: 'appears',
            object: { scalar: true },
            evidence: { excerpt: 'Ada' },
          },
        ],
      }),
    }
    const { memory } = harness({ inference: ambiguous })
    await memory.open({ create: true })

    const report = await memory.remember({
      id: 'ambiguous-anchor',
      kind: 'text',
      content: { type: 'text', text: 'Ada appears, and Ada appears again.' },
      source: { kind: 'fixture' },
    })

    expect(report.operation).toMatchObject({
      state: 'failed',
      error: { code: 'malformed_provider_output' },
    })
    expect(await memory.getEpisode('ambiguous-anchor', { allowedScopes: [] })).toMatchObject({
      id: 'ambiguous-anchor',
    })

    const malformedMention: StructuredInferenceProvider = {
      lineage: { provider: 'fixture', model: 'malformed-mention-v1', destination: 'local' },
      infer: async () => ({
        entities: [
          {
            candidateId: 'entity-1',
            id: 'ada',
            name: 'Ada',
            mention: 'Ada' as never,
          },
        ],
        facts: [],
      }),
    }
    const malformed = harness({ inference: malformedMention })
    await malformed.memory.open({ create: true })
    const malformedReport = await malformed.memory.remember({
      id: 'malformed-mention',
      kind: 'text',
      content: { type: 'text', text: 'Ada appears once.' },
      source: { kind: 'fixture' },
    })
    expect(malformedReport.operation).toMatchObject({
      state: 'failed',
      error: { code: 'malformed_provider_output' },
    })
    expect(
      await malformed.memory.getEpisode('malformed-mention', { allowedScopes: [] }),
    ).toMatchObject({ id: 'malformed-mention' })
  })

  it('rejects an invalid host evidence anchor before accepting the episode', async () => {
    const { memory } = harness()
    await memory.open({ create: true })

    await expect(
      memory.remember({
        id: 'bad-host-anchor',
        kind: 'assertion',
        content: { type: 'text', text: 'Ada' },
        source: { kind: 'fixture' },
        assertions: {
          entities: [
            {
              id: 'ada',
              name: 'Ada',
              evidence: {
                anchor: { kind: 'text', unit: 'utf16-code-unit', start: 0, end: 99 },
              },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    await expect(
      memory.remember({
        id: 'inherited-json-pointer',
        kind: 'assertion',
        content: { type: 'structured', value: {} },
        source: { kind: 'fixture' },
        assertions: {
          entities: [
            {
              id: 'ada',
              name: 'Ada',
              evidence: { anchor: { kind: 'json-pointer', pointer: '/toString' } },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    await expect(
      memory.remember({
        id: 'malformed-host-mention',
        kind: 'assertion',
        content: { type: 'text', text: 'Ada' },
        source: { kind: 'fixture' },
        assertions: { entities: [{ id: 'ada', name: 'Ada', mention: 'Ada' as never }] },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(await memory.stats()).toMatchObject({ episodes: 0 })
  })

  it('AC04 injects inference and embeddings with durable, payload-free call summaries', async () => {
    const { memory } = harness({ inference: inference('local'), embeddings })
    await memory.open({ create: true })

    const report = await memory.remember({
      id: 'ep-1',
      kind: 'text',
      content: { type: 'text', text: 'Ada studied analytical engines.' },
      source: { kind: 'fixture' },
    })

    expect(report.operation.state).toBe('succeeded')
    expect(report.privacy.calls).toEqual([
      expect.objectContaining({ capability: 'inference', outcome: 'succeeded' }),
      expect.objectContaining({ capability: 'embedding', outcome: 'succeeded' }),
    ])
    expect(report.privacy.calls.every((call) => !('payload' in call))).toBe(true)
  })

  it('sanitizes and bounds untrusted provider diagnostics before persistence', async () => {
    const secret = 'provider-credential-must-not-survive'
    let invocation = 0
    const hostile: StructuredInferenceProvider = {
      lineage: {
        provider: 'fixture',
        model: 'hostile-diagnostics-v1',
        destination: 'local',
        apiKey: secret,
      } as StructuredInferenceProvider['lineage'],
      infer: async () => {
        invocation += 1
        if (invocation === 1) return { entities: [], facts: [], warnings: [secret] }
        if (invocation === 2) {
          return { entities: [], facts: [], warnings: Array.from({ length: 65 }, () => secret) }
        }
        throw new MemoryError('provider_error', `${secret}:${'x'.repeat(10_000)}`, {
          details: { secret },
        })
      },
    }
    const { memory, storage } = harness({ inference: hostile })
    await memory.open({ create: true })

    const warned = await memory.remember({
      id: 'provider-warning-redaction',
      kind: 'text',
      content: { type: 'text', text: 'Provider warning boundary.' },
      source: { kind: 'fixture' },
    })
    const excessive = await memory.remember({
      id: 'provider-warning-limit',
      kind: 'text',
      content: { type: 'text', text: 'Provider warning count boundary.' },
      source: { kind: 'fixture' },
    })
    const failed = await memory.remember({
      id: 'provider-error-redaction',
      kind: 'text',
      content: { type: 'text', text: 'Provider error boundary.' },
      source: { kind: 'fixture' },
    })

    expect(warned.warnings).toEqual([
      'inference provider returned 1 warning(s); text was not retained',
    ])
    expect(warned.operation.diagnosticsTruncated).toBe(true)
    expect(excessive.operation).toMatchObject({
      state: 'failed',
      error: {
        code: 'malformed_provider_output',
        message: 'provider returned malformed output',
      },
    })
    expect(failed.operation).toMatchObject({
      state: 'partial',
      diagnosticsTruncated: true,
      error: { code: 'provider_error', message: 'provider call failed' },
    })
    expect(failed.operation.error?.details).toBeUndefined()
    const records = await storageDriver(storage).exportRecords('space-1')
    expect(JSON.stringify({ warned, excessive, failed, records })).not.toContain(secret)
  })

  it('samples operation diagnostics at fixed bounds and rejects payload-bearing call rows', async () => {
    let fail = false
    const boundedEmbeddings: EmbeddingProvider = {
      lineage: {
        provider: 'fixture',
        model: 'bounded-diagnostics-v1',
        destination: 'local',
        dimensions: 2,
      },
      embed: async ({ texts }) => {
        if (fail) throw new Error('untrusted provider failure')
        return texts.map(() => [1, 0])
      },
    }
    const { memory, storage } = harness({
      embeddings: boundedEmbeddings,
      ingestion: { projectionBatchSize: 1 },
    })
    await memory.open({ create: true })
    for (let index = 0; index < 66; index += 1) {
      await memory.remember({
        id: `diagnostic-sample-${index}`,
        kind: 'assertion',
        content: { type: 'text', text: `Diagnostic sample ${index}.` },
        source: { kind: 'fixture' },
        assertions: {},
      })
    }
    fail = true

    const rebuilt = await memory.rebuildProjections(
      { kinds: ['embedding'] },
      { operationId: 'bounded-diagnostic-rebuild' },
    )

    expect(rebuilt.operation).toMatchObject({ diagnosticsTruncated: true, state: 'partial' })
    expect(rebuilt.operation.warnings).toHaveLength(64)
    expect(rebuilt.operation.remoteCalls).toHaveLength(64)
    expect(await memory.verifyIntegrity()).toMatchObject({ ok: true, issues: [] })

    const driver = storageDriver(storage)
    const stored = await driver.get('operation', 'space-1', rebuilt.operation.id)
    const space = await driver.getSpace('space-1')
    if (stored === null || space === null || stored.remoteCalls[0] === undefined) {
      throw new Error('bounded operation fixture is missing')
    }
    await driver.commit({
      spaceId: 'space-1',
      expectedRevision: space.revision,
      puts: [
        {
          ...stored,
          remoteCalls: [
            {
              ...stored.remoteCalls[0],
              payload: 'forbidden',
            } as (typeof stored.remoteCalls)[number],
          ],
        },
      ],
    })
    expect(await memory.verifyIntegrity()).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ code: 'invalid_operation' })],
    })
  })

  it('keeps accepted evidence recoverable after a denied remote inference', async () => {
    const { memory } = harness({ inference: inference('remote') })
    await memory.open({ create: true })

    const report = await memory.remember({
      id: 'ep-1',
      kind: 'text',
      content: { type: 'text', text: 'Accepted before provider processing.' },
      source: { kind: 'fixture' },
    })

    expect(report.operation).toMatchObject({ state: 'failed', stage: 'inference_failed' })
    expect(report.privacy.calls).toEqual([
      expect.objectContaining({ capability: 'inference', outcome: 'denied' }),
    ])
    expect(await memory.getEpisode('ep-1', { allowedScopes: [] })).toMatchObject({ id: 'ep-1' })
    expect(await memory.stats()).toMatchObject({ episodes: 1, facts: 0 })
  })

  it('enforces and classifies the operation deadline when a provider ignores abort', async () => {
    const hanging: StructuredInferenceProvider = {
      lineage: { provider: 'fixture', model: 'hanging-v1', destination: 'local' },
      infer: () => new Promise<never>(() => undefined),
    }
    const { memory } = harness({ inference: hanging, operationTimeoutMs: 20 })
    await memory.open({ create: true })
    const startedAt = Date.now()

    const report = await memory.remember({
      id: 'provider-timeout',
      kind: 'text',
      content: { type: 'text', text: 'Evidence survives a hung provider.' },
      source: { kind: 'fixture' },
    })

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(report.operation).toMatchObject({
      state: 'partial',
      stage: 'inference_failed',
      retryable: true,
      error: { code: 'timeout', retryable: true },
    })
    expect(await memory.getEpisode('provider-timeout', { allowedScopes: [] })).toMatchObject({
      id: 'provider-timeout',
    })
  })

  it('hard-races a disclosure policy that ignores the operation deadline', async () => {
    let providerCalls = 0
    let releasePolicy: ((value: { action: 'allow' }) => void) | undefined
    const policy: MemoryPolicy = {
      authorizeDisclosure: () =>
        new Promise<{ action: 'allow' }>((resolve) => {
          releasePolicy = resolve
        }),
    }
    const provider = inference('remote')
    provider.infer = async (request, options) => {
      providerCalls += 1
      return inference('remote').infer(request, options)
    }
    const { memory } = harness({
      inference: provider,
      policy,
      operationTimeoutMs: 20,
    })
    await memory.open({ create: true })
    const startedAt = Date.now()

    const report = await memory.remember({
      id: 'policy-timeout',
      kind: 'text',
      content: { type: 'text', text: 'Evidence survives a hung disclosure policy.' },
      source: { kind: 'fixture' },
    })

    expect(Date.now() - startedAt).toBeLessThan(1_000)
    expect(report.operation).toMatchObject({
      state: 'partial',
      stage: 'inference_failed',
      retryable: true,
      error: { code: 'timeout', retryable: true },
    })
    expect(report.privacy.calls).toEqual([
      expect.objectContaining({ capability: 'inference', outcome: 'failed' }),
    ])
    expect(providerCalls).toBe(0)
    expect(await memory.getEpisode('policy-timeout', { allowedScopes: [] })).toMatchObject({
      id: 'policy-timeout',
    })

    releasePolicy?.({ action: 'allow' })
    await Promise.resolve()
    await Promise.resolve()
    expect(providerCalls).toBe(0)
  })

  it('detaches a late disclosure-policy result after caller cancellation', async () => {
    let providerCalls = 0
    let notifyPolicyEntered: (() => void) | undefined
    const policyEntered = new Promise<void>((resolve) => {
      notifyPolicyEntered = resolve
    })
    let releasePolicy: ((value: { action: 'allow' }) => void) | undefined
    const policy: MemoryPolicy = {
      authorizeDisclosure: () => {
        notifyPolicyEntered?.()
        return new Promise<{ action: 'allow' }>((resolve) => {
          releasePolicy = resolve
        })
      },
    }
    const provider = inference('remote')
    provider.infer = async (request, options) => {
      providerCalls += 1
      return inference('remote').infer(request, options)
    }
    const { memory } = harness({ inference: provider, policy })
    await memory.open({ create: true })
    const controller = new AbortController()
    const pending = memory.remember(
      {
        id: 'policy-cancelled',
        kind: 'text',
        content: { type: 'text', text: 'Cancel after policy admission begins.' },
        source: { kind: 'fixture' },
      },
      { signal: controller.signal },
    )
    await policyEntered
    controller.abort()

    const report = await pending
    expect(report.operation).toMatchObject({
      state: 'failed',
      stage: 'inference_failed',
      retryable: false,
      error: { code: 'cancelled', retryable: false },
    })
    expect(providerCalls).toBe(0)

    releasePolicy?.({ action: 'allow' })
    await Promise.resolve()
    await Promise.resolve()
    expect(providerCalls).toBe(0)
  })

  it('AC05 retries failed inference idempotently without duplicating accepted evidence', async () => {
    let attempts = 0
    const retrying = inference('local')
    retrying.infer = async (request, options) => {
      attempts += 1
      if (attempts === 1) throw new Error('temporary provider outage')
      return inference('local').infer(request, options)
    }
    const { memory } = harness({ inference: retrying })
    await memory.open({ create: true })

    const first = await memory.remember({
      id: 'ep-retry',
      kind: 'text',
      content: { type: 'text', text: 'Ada studied analytical engines.' },
      source: { kind: 'fixture' },
    })
    const retried = await memory.retryEpisode('ep-retry')
    const repeatedRetry = await memory.retryEpisode('ep-retry')

    expect(first.operation).toMatchObject({ state: 'partial', stage: 'inference_failed' })
    expect(retried.operation.state).toBe('succeeded')
    expect(repeatedRetry.facts.repeated).toEqual(retried.facts.created)
    expect(await memory.stats()).toMatchObject({ episodes: 1, entities: 1, facts: 1 })
  })

  it('routes remote payloads through a redacting policy before provider invocation', async () => {
    let observed = ''
    const policy: MemoryPolicy = {
      authorizeDisclosure: (request) => {
        const payload = structuredClone(request.payload) as unknown as InferenceRequest
        payload.episode.content = { type: 'text', text: '[redacted]' }
        return { action: 'allow', payload: payload as unknown as JsonValue }
      },
    }
    const { memory } = harness({
      inference: inference('remote', (request) => {
        observed = request.episode.content.type === 'text' ? request.episode.content.text : ''
      }),
      policy,
    })
    await memory.open({ create: true })

    const report = await memory.remember({
      id: 'ep-1',
      kind: 'text',
      content: { type: 'text', text: 'private raw content' },
      source: { kind: 'fixture' },
    })

    expect(observed).toBe('[redacted]')
    expect(report.privacy.remoteComputation).toBe(true)
  })

  it('AC19 never serializes provider credentials into canonical storage or export', async () => {
    const { memory } = harness({ inference: inference('local') })
    await memory.open({ create: true })
    await memory.remember({
      id: 'ep-1',
      kind: 'text',
      content: { type: 'text', text: 'Ada studied analytical engines.' },
      source: { kind: 'fixture' },
    })

    const exported = await memory.export({ access: { allowedScopes: [] }, complete: true })

    expect(JSON.stringify(exported)).not.toContain('credential-must-not-survive')
    expect(exported.canonical.facts[0]?.lineage.provider).toEqual({
      capability: 'inference',
      provider: 'fixture',
      model: 'structured-v1',
      destination: 'local',
    })
  })

  it('bounds inference context and excludes knowledge outside the episode scopes', async () => {
    let observed: InferenceRequest['context'] | undefined
    const provider = inference('local', (request) => {
      observed = request.context
    })
    const { memory } = harness({ inference: provider, ingestion: { contextLimit: 1 } })
    await memory.open({ create: true })
    await memory.remember({
      id: 'public',
      kind: 'assertion',
      content: { type: 'text', text: 'Public context.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'public-entity', name: 'Public entity' }] },
    })
    await memory.remember({
      id: 'private',
      kind: 'assertion',
      content: { type: 'text', text: 'Other tenant context.' },
      source: { kind: 'fixture' },
      scopes: ['tenant-b'],
      assertions: { entities: [{ id: 'private-entity', name: 'Private entity' }] },
    })

    await memory.remember({
      id: 'context-request',
      kind: 'text',
      content: { type: 'text', text: 'Use bounded context.' },
      source: { kind: 'fixture' },
      scopes: ['tenant-a'],
    })

    expect((observed?.entities.length ?? 0) + (observed?.facts.length ?? 0)).toBeLessThanOrEqual(1)
    expect(JSON.stringify(observed)).toContain('Public entity')
    expect(JSON.stringify(observed)).not.toContain('Private entity')
  })

  it('streams inference context through exact scan limits before provider disclosure', async () => {
    const seed = async () => {
      let providerCalls = 0
      const provider: StructuredInferenceProvider = {
        lineage: {
          provider: 'fixture',
          model: 'bounded-context-v1',
          destination: 'local',
        },
        infer: async () => {
          providerCalls += 1
          return { entities: [], facts: [] }
        },
      }
      const context = harness({ inference: provider, ingestion: { contextLimit: 5 } })
      await context.memory.open({ create: true })
      for (let index = 0; index < 17; index += 1) {
        await context.memory.remember({
          id: `context-source-${index.toString().padStart(2, '0')}`,
          idempotencyKey: `context-source-${index.toString().padStart(2, '0')}`,
          kind: 'assertion',
          content: { type: 'text', text: `Context source ${index}` },
          source: { kind: 'fixture' },
          assertions: {
            entities: [{ id: `context-entity-${index}`, name: `Context entity ${index}` }],
            facts: [
              {
                id: `context-fact-${index}`,
                subject: { id: `context-entity-${index}` },
                predicate: 'context_value',
                object: { scalar: index },
              },
            ],
          },
        })
      }
      return { ...context, providerCalls: () => providerCalls }
    }
    const target = {
      id: 'bounded-context-target',
      idempotencyKey: 'bounded-context-target',
      kind: 'text' as const,
      content: { type: 'text' as const, text: 'Assemble bounded inference context.' },
      source: { kind: 'fixture' },
    }
    const generous = { maxRecords: 1_000, maxBytes: 16 * 1024 * 1024 }

    const baseline = await seed()
    const baselineDriver = storageDriver(baseline.storage)
    const baselineExport = vi
      .spyOn(baselineDriver, 'exportRecords')
      .mockRejectedValue(new Error('inference context must not use whole-space export'))
    const baselineQueries = vi.spyOn(baselineDriver, 'query')
    const report = await baseline.memory.remember(target, {
      operationId: 'bounded-context-operation',
      contextScanLimits: generous,
    })
    expect(report.operation.state).toBe('succeeded')
    expect(report.contextScan).toMatchObject({ limits: generous })
    expect(report.contextScan.records).toBeGreaterThan(17)
    expect(report.contextScan.bytes).toBeGreaterThan(0)
    expect(baseline.providerCalls()).toBe(1)
    expect(baselineExport).not.toHaveBeenCalled()
    expect(
      baselineQueries.mock.calls
        .map(([query]) => query)
        .filter((query) =>
          [
            'episode',
            'entity',
            'fact',
            'alias',
            'evidence',
            'derivation',
            'mention',
            'lifecycle',
            'merge',
          ].includes(query.kind),
        )
        .every((query) => query.limit !== undefined && query.limit <= 16),
    ).toBe(true)

    const recordLimited = await seed()
    const recordDriver = storageDriver(recordLimited.storage)
    const recordExport = vi
      .spyOn(recordDriver, 'exportRecords')
      .mockRejectedValue(new Error('inference context must not use whole-space export'))
    const recordFailure = await recordLimited.memory.remember(target, {
      operationId: 'bounded-context-operation',
      contextScanLimits: {
        maxRecords: report.contextScan.records - 1,
        maxBytes: report.contextScan.bytes,
      },
    })
    expect(recordFailure.operation).toMatchObject({
      state: 'failed',
      stage: 'inference_failed',
      diagnosticsTruncated: true,
      error: { code: 'result_too_large' },
    })
    expect(recordFailure.contextScan.records).toBe(report.contextScan.records - 1)
    expect(recordLimited.providerCalls()).toBe(0)
    expect(recordExport).not.toHaveBeenCalled()
    const recordRetry = await recordLimited.memory.retryEpisode('bounded-context-target', {
      operationId: 'bounded-context-record-retry',
      contextScanLimits: report.contextScan.limits,
    })
    expect(recordRetry.operation.state).toBe('succeeded')
    expect(recordRetry.contextScan).toEqual(report.contextScan)
    expect(recordLimited.providerCalls()).toBe(1)

    const byteLimited = await seed()
    const byteDriver = storageDriver(byteLimited.storage)
    const byteExport = vi
      .spyOn(byteDriver, 'exportRecords')
      .mockRejectedValue(new Error('inference context must not use whole-space export'))
    const byteFailure = await byteLimited.memory.remember(target, {
      operationId: 'bounded-context-operation',
      contextScanLimits: {
        maxRecords: report.contextScan.records,
        maxBytes: report.contextScan.bytes - 1,
      },
    })
    expect(byteFailure.operation).toMatchObject({
      state: 'failed',
      stage: 'inference_failed',
      error: { code: 'result_too_large' },
    })
    expect(byteFailure.contextScan.bytes).toBeLessThan(report.contextScan.bytes)
    expect(byteLimited.providerCalls()).toBe(0)
    expect(byteExport).not.toHaveBeenCalled()
    const byteRetry = await byteLimited.memory.retryEpisode('bounded-context-target', {
      operationId: 'bounded-context-byte-retry',
      contextScanLimits: report.contextScan.limits,
    })
    expect(byteRetry.operation.state).toBe('succeeded')
    expect(byteRetry.contextScan).toEqual(report.contextScan)
    expect(byteLimited.providerCalls()).toBe(1)
  })

  it('reports successful remote retrieval computation without exposing its payload', async () => {
    const remoteEmbeddings: EmbeddingProvider = {
      ...embeddings,
      lineage: { ...embeddings.lineage, destination: 'remote' },
    }
    const policy: MemoryPolicy = { authorizeDisclosure: () => ({ action: 'allow' }) }
    const { memory } = harness({ embeddings: remoteEmbeddings, policy })
    const events: boolean[] = []
    memory.on('retrieval:complete', (event) => events.push(event.remoteComputation))
    await memory.open({ create: true })
    await memory.remember({
      id: 'remote-retrieval',
      kind: 'assertion',
      content: { type: 'text', text: 'Remote semantic retrieval.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'semantic', name: 'Semantic target' }] },
    })

    await memory.recall({
      query: 'semantic',
      access: { allowedScopes: [] },
      channels: { exact: false, lexical: false, semantic: true, graph: false, temporal: false },
    })

    expect(events).toEqual([true])
  })

  it('isolates embedding generations until projections are rebuilt for the new model', async () => {
    const firstEmbeddings: EmbeddingProvider = {
      ...embeddings,
      lineage: { ...embeddings.lineage, model: 'embedding-v1' },
    }
    const { memory: first, storage } = harness({ embeddings: firstEmbeddings })
    await first.open({ create: true })
    await first.remember({
      id: 'generation',
      kind: 'assertion',
      content: { type: 'text', text: 'Projection generation target.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'generation-target', name: 'Generation target' }] },
    })
    await first.close()

    const secondEmbeddings: EmbeddingProvider = {
      ...embeddings,
      lineage: { ...embeddings.lineage, model: 'embedding-v2' },
    }
    const second = createMemory({
      spaceId: 'space-1',
      storage,
      embeddings: secondEmbeddings,
    })
    await second.open()
    const before = await second.recall({
      query: 'generation',
      access: { allowedScopes: [] },
      channels: { exact: false, lexical: false, semantic: true, graph: false, temporal: false },
    })
    const rebuilt = await second.rebuildProjections({ kinds: ['embedding'] })
    const after = await second.recall({
      query: 'generation',
      access: { allowedScopes: [] },
      channels: { exact: false, lexical: false, semantic: true, graph: false, temporal: false },
    })

    expect(before.entities).toEqual([])
    expect(rebuilt.failed).toBe(0)
    expect(after.entities.map((entity) => entity.id)).toContain('generation-target')
  })

  it('keeps durable staged embedding rows invisible until one atomic set activation', async () => {
    const { memory: first, storage } = harness({ embeddings })
    await first.open({ create: true })
    for (const [id, entityId, text] of [
      ['a-first', 'first-target', 'First staged episode.'],
      ['z-second', 'second-target', 'Second staged episode.'],
    ] as const) {
      await first.remember({
        id,
        kind: 'assertion',
        content: { type: 'text', text },
        source: { kind: 'fixture' },
        assertions: { entities: [{ id: entityId, name: entityId }] },
      })
    }
    await first.close()

    let reachedResolve!: () => void
    let releaseResolve!: () => void
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve
    })
    const nextEmbeddings: EmbeddingProvider = {
      lineage: { ...embeddings.lineage, model: 'embedding-v2' },
      embed: async ({ purpose, texts }) => {
        if (purpose === 'index' && texts.includes('Second staged episode.')) {
          reachedResolve()
          await release
        }
        return texts.map(() => [1, 0])
      },
    }
    const second = createMemory({
      spaceId: 'space-1',
      storage,
      embeddings: nextEmbeddings,
      ingestion: { projectionBatchSize: 1 },
    })
    await second.open()
    const driver = storageDriver(storage)
    const beforeSpace = await driver.getSpace('space-1')
    const activeBefore = beforeSpace?.projectionSets?.embedding?.id
    const lexicalBefore = beforeSpace?.projectionSets?.lexical?.id
    const rebuilding = second.rebuildProjections({ kinds: ['lexical', 'embedding'] })
    await reached

    try {
      const duringSpace = await driver.getSpace('space-1')
      const duringRows = await driver.query({ kind: 'projection', spaceId: 'space-1' })
      const stagedRows = duringRows.filter(
        (projection) =>
          projection.projectionKind === 'embedding' &&
          projection.setId !== undefined &&
          projection.setId !== activeBefore,
      )
      const duringRecall = await second.recall({
        query: 'first-target',
        access: { allowedScopes: [] },
        channels: { exact: false, lexical: false, semantic: true, graph: false, temporal: false },
      })
      const duringLexical = await second.recall({
        query: 'first-target',
        access: { allowedScopes: [] },
        channels: { exact: false, lexical: true, semantic: false, graph: false, temporal: false },
      })

      expect(activeBefore).toBeDefined()
      expect(duringSpace?.projectionSets?.embedding?.id).toBe(activeBefore)
      expect(stagedRows.length).toBeGreaterThan(0)
      expect(stagedRows.every((projection) => projection.state === 'building')).toBe(true)
      expect(duringRecall.entities).toEqual([])
      expect(duringLexical.entities.map((entity) => entity.id)).toContain('first-target')
    } finally {
      releaseResolve()
    }

    const rebuilt = await rebuilding
    const activeAfter = (await driver.getSpace('space-1'))?.projectionSets?.embedding?.id
    const lexicalAfter = (await driver.getSpace('space-1'))?.projectionSets?.lexical?.id
    const afterRecall = await second.recall({
      query: 'first-target',
      access: { allowedScopes: [] },
      channels: { exact: false, lexical: false, semantic: true, graph: false, temporal: false },
    })

    expect(rebuilt).toMatchObject({ failed: 0, staleRemaining: 0 })
    expect(activeAfter).not.toBe(activeBefore)
    expect(lexicalAfter).not.toBe(lexicalBefore)
    expect(afterRecall.entities.map((entity) => entity.id)).toContain('first-target')
  })

  it('does not activate a staged set after a concurrent canonical write', async () => {
    const { memory: first, storage } = harness({ embeddings })
    await first.open({ create: true })
    for (const [id, text] of [
      ['a-source', 'First guarded source.'],
      ['z-source', 'Second guarded source.'],
    ] as const) {
      await first.remember({
        id,
        kind: 'assertion',
        content: { type: 'text', text },
        source: { kind: 'fixture' },
        assertions: {},
      })
    }
    await first.close()

    let reachedResolve!: () => void
    let releaseResolve!: () => void
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve
    })
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve
    })
    const guardedEmbeddings: EmbeddingProvider = {
      lineage: { ...embeddings.lineage, model: 'guarded-v2' },
      embed: async ({ purpose, texts }) => {
        if (purpose === 'index' && texts.includes('Second guarded source.')) {
          reachedResolve()
          await release
        }
        return texts.map(() => [1, 0])
      },
    }
    const rebuildingMemory = createMemory({
      spaceId: 'space-1',
      storage,
      embeddings: guardedEmbeddings,
      ingestion: { projectionBatchSize: 1 },
    })
    const peer = createMemory({ spaceId: 'space-1', storage, embeddings: guardedEmbeddings })
    await rebuildingMemory.open()
    await peer.open()
    const driver = storageDriver(storage)
    const activeBefore = (await driver.getSpace('space-1'))?.projectionSets?.embedding?.id
    const rebuilding = rebuildingMemory.rebuildProjections({ kinds: ['embedding'] })
    await reached

    await peer.remember({
      id: 'concurrent-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Concurrent canonical source.' },
      source: { kind: 'fixture' },
      assertions: {},
    })
    releaseResolve()
    const rebuilt = await rebuilding
    const after = await driver.getSpace('space-1')

    expect(rebuilt.operation).toMatchObject({ state: 'partial', retryable: true })
    expect(rebuilt.failed).toBeGreaterThan(0)
    expect(after?.projectionSets?.embedding?.id).toBe(activeBefore)
    expect((await rebuildingMemory.stats()).staleProjections).toBe(0)
  })

  it('reports deferred inactive-set cleanup without undoing an activated generation', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'cleanup-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Projection cleanup remains recoverable.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'cleanup-target', name: 'Cleanup target' }] },
    })
    const driver = storageDriver(storage)
    const originalCommit = driver.commit.bind(driver)
    let failCleanup = true
    const commit = vi.spyOn(driver, 'commit').mockImplementation(async (change) => {
      if (
        failCleanup &&
        (change.puts?.length ?? 0) === 0 &&
        change.deletes?.some((deletion) => deletion.kind === 'projection') === true
      ) {
        failCleanup = false
        throw new MemoryError('storage_failed', 'injected projection cleanup failure')
      }
      return originalCommit(change)
    })

    const first = await memory.rebuildProjections({ kinds: ['lexical'] })
    const recalled = await memory.recall({
      query: 'Cleanup target',
      access: { allowedScopes: [] },
      channels: { exact: false, lexical: true, semantic: false, graph: false, temporal: false },
    })

    expect(first.operation).toMatchObject({
      state: 'partial',
      stage: 'cleanup_deferred',
      retryable: true,
    })
    expect(first.failed).toBe(0)
    expect(first.staleRemaining).toBeGreaterThan(0)
    expect(first.operation.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^inactive projection cleanup was deferred:/u),
      ]),
    )
    expect(recalled.entities.map((entity) => entity.id)).toContain('cleanup-target')

    commit.mockRestore()
    const second = await memory.rebuildProjections({ kinds: ['lexical'] })
    expect(second).toMatchObject({
      operation: { state: 'succeeded' },
      failed: 0,
      staleRemaining: 0,
    })
  })

  it('streams full projection rebuilds under exact scan limits without whole-space export', async () => {
    const { memory, storage } = harness()
    await memory.open({ create: true })
    for (let index = 0; index < 17; index += 1) {
      await memory.remember({
        id: `projection-page-${index.toString().padStart(2, '0')}`,
        kind: 'text',
        content: { type: 'text', text: `Projection page ${index}.` },
        source: { kind: 'fixture' },
      })
    }
    await memory.remember({
      id: 'projection-graph-source',
      kind: 'assertion',
      content: { type: 'text', text: 'A projection graph source has indexed dependencies.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'projection-entity', name: 'Projection entity' }],
        facts: [
          {
            id: 'projection-fact',
            subject: { id: 'projection-entity' },
            predicate: 'projection-probe',
            object: { scalar: true },
          },
        ],
      },
    })

    const driver = storageDriver(storage)
    const query = vi.spyOn(driver, 'query')
    const exportRecords = vi.spyOn(driver, 'exportRecords')
    const baseline = await memory.rebuildProjections(
      {
        kinds: ['lexical'],
        scanLimits: { maxRecords: 1_000, maxBytes: 16 * 1024 * 1024 },
      },
      { operationId: 'projection-scan-baseline' },
    )
    expect(baseline).toMatchObject({
      operation: { state: 'succeeded' },
      scanned: 20,
      failed: 0,
      staleRemaining: 0,
      scan: {
        records: expect.any(Number),
        bytes: expect.any(Number),
        limits: { maxRecords: 1_000, maxBytes: 16 * 1024 * 1024 },
      },
    })
    expect(baseline.scan.records).toBeGreaterThan(baseline.scanned)
    expect(baseline.scan.bytes).toBeGreaterThan(0)
    expect(exportRecords).not.toHaveBeenCalled()
    const baselineRebuildPages = query.mock.calls
      .map(([request]) => request)
      .filter((request) =>
        ['episode', 'entity', 'fact', 'alias', 'evidence', 'projection'].includes(request.kind),
      )
    expect(baselineRebuildPages.some((request) => request.limit === 16)).toBe(true)
    expect(
      baselineRebuildPages.every((request) => request.limit !== undefined && request.limit <= 16),
    ).toBe(true)

    const exact = await memory.rebuildProjections(
      {
        kinds: ['lexical'],
        scanLimits: { maxRecords: baseline.scan.records, maxBytes: baseline.scan.bytes },
      },
      { operationId: 'projection-scan-exact-ok' },
    )
    expect(exact.scan).toEqual({
      records: baseline.scan.records,
      bytes: baseline.scan.bytes,
      limits: { maxRecords: baseline.scan.records, maxBytes: baseline.scan.bytes },
    })
    const activeBeforeFailures = (await memory.stats()).activeProjectionSets

    await expect(
      memory.rebuildProjections(
        {
          kinds: ['lexical'],
          scanLimits: {
            maxRecords: baseline.scan.records - 1,
            maxBytes: baseline.scan.bytes,
          },
        },
        { operationId: 'projection-scan-record-rejected' },
      ),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'projection_scan',
        dimension: 'records',
        required: baseline.scan.records,
        maximum: baseline.scan.records - 1,
      },
    })
    expect((await memory.stats()).activeProjectionSets).toEqual(activeBeforeFailures)
    expect(await memory.operation('projection-scan-record-rejected')).toMatchObject({
      state: 'partial',
      stage: 'projection_scan_failed',
    })

    await expect(
      memory.rebuildProjections(
        {
          kinds: ['lexical'],
          scanLimits: {
            maxRecords: baseline.scan.records,
            maxBytes: baseline.scan.bytes - 1,
          },
        },
        { operationId: 'projection-scan-byte-rejected' },
      ),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'projection_scan',
        dimension: 'bytes',
        required: baseline.scan.bytes,
        maximum: baseline.scan.bytes - 1,
      },
    })
    expect((await memory.stats()).activeProjectionSets).toEqual(activeBeforeFailures)

    const recovered = await memory.rebuildProjections(
      {
        kinds: ['lexical'],
        scanLimits: { maxRecords: baseline.scan.records, maxBytes: baseline.scan.bytes },
      },
      { operationId: 'projection-scan-recovered' },
    )
    expect(recovered).toMatchObject({
      operation: { state: 'succeeded' },
      staleRemaining: 0,
    })
    await expect(
      memory.rebuildProjections({ entityIds: Array.from({ length: 10_001 }, () => 'duplicate') }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      memory.rebuildProjections({ kinds: ['lexical', 'lexical', 'lexical', 'lexical'] }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    expect(exportRecords).not.toHaveBeenCalled()
    query.mockRestore()
    exportRecords.mockRestore()
  })

  it('partitions embedding batches by exact disclosure scopes and enforces the batch limit', async () => {
    const disclosures: string[][] = []
    const batchSizes: number[] = []
    const remoteEmbeddings: EmbeddingProvider = {
      lineage: {
        provider: 'fixture',
        model: 'embedding-partition-v1',
        destination: 'remote',
        dimensions: 2,
      },
      embed: async ({ texts }) => {
        batchSizes.push(texts.length)
        return texts.map(() => [1, 0])
      },
    }
    const policy: MemoryPolicy = {
      authorizeDisclosure: (request) => {
        if (request.capability === 'embedding') disclosures.push([...request.scopes])
        return { action: 'allow' }
      },
    }
    const { memory } = harness({
      embeddings: remoteEmbeddings,
      policy,
      ingestion: { projectionBatchSize: 1 },
    })
    await memory.open({ create: true })
    await memory.remember({
      id: 'scope-a',
      kind: 'assertion',
      content: { type: 'text', text: 'Alpha disclosure partition.' },
      source: { kind: 'fixture' },
      scopes: ['a'],
      assertions: { entities: [{ id: 'alpha', name: 'Alpha' }] },
    })
    await memory.remember({
      id: 'scope-b',
      kind: 'assertion',
      content: { type: 'text', text: 'Beta disclosure partition.' },
      source: { kind: 'fixture' },
      scopes: ['b'],
      assertions: { entities: [{ id: 'beta', name: 'Beta' }] },
    })

    disclosures.length = 0
    batchSizes.length = 0
    const rebuilt = await memory.rebuildProjections({ kinds: ['embedding'] })

    expect(rebuilt.failed).toBe(0)
    expect(batchSizes.length).toBeGreaterThan(1)
    expect(batchSizes.every((size) => size === 1)).toBe(true)
    expect(disclosures.some((scopes) => scopes.join(',') === 'a')).toBe(true)
    expect(disclosures.some((scopes) => scopes.join(',') === 'b')).toBe(true)
    expect(disclosures.some((scopes) => scopes.join(',') === 'a,b')).toBe(false)
  })

  it('derives projections from target-safe partitions despite weaker non-support evidence', async () => {
    const disclosures: string[][] = []
    const remoteEmbeddings: EmbeddingProvider = {
      lineage: {
        provider: 'fixture',
        model: 'safe-partition-v1',
        destination: 'remote',
        dimensions: 2,
      },
      embed: async ({ texts }) => texts.map(() => [1, 0]),
    }
    const policy: MemoryPolicy = {
      authorizeDisclosure: (request) => {
        if (request.capability === 'embedding') disclosures.push([...request.scopes])
        return { action: 'allow' }
      },
    }
    const { memory, storage } = harness({ embeddings: remoteEmbeddings, policy })
    await memory.open({ create: true })
    const report = await memory.remember({
      id: 'private-source',
      kind: 'assertion',
      content: { type: 'text', text: 'A private entity has a private fact.' },
      source: { kind: 'fixture' },
      scopes: ['private'],
      assertions: {
        entities: [{ id: 'private-entity', name: 'Private entity' }],
        facts: [
          {
            subject: { id: 'private-entity' },
            predicate: 'private_fact',
            object: { scalar: 'private value' },
          },
        ],
      },
    })
    await memory.remember({
      id: 'public-probe',
      kind: 'text',
      content: { type: 'text', text: 'Public probe.' },
      source: { kind: 'fixture' },
    })
    disclosures.length = 0

    const driver = storageDriver(storage)
    const space = await driver.getSpace('space-1')
    if (space === null) throw new Error('test space is missing')
    const createdAt = '2026-08-03T10:00:00.000Z'
    const forged: StoredEvidence[] = [
      {
        kindRecord: 'evidence',
        id: 'forged-entity-mention',
        spaceId: 'space-1',
        episodeId: 'public-probe',
        target: { kind: 'entity', id: 'private-entity' },
        relation: 'mentions',
        status: 'active',
        scopes: [],
        createdAt,
        operationId: 'forged-operation',
      },
      {
        kindRecord: 'evidence',
        id: 'forged-fact-contradiction',
        spaceId: 'space-1',
        episodeId: 'public-probe',
        target: { kind: 'fact', id: report.facts.created[0]! },
        relation: 'contradicts',
        status: 'active',
        scopes: [],
        createdAt,
        operationId: 'forged-operation',
      },
    ]
    await driver.commit({
      spaceId: 'space-1',
      expectedRevision: space.revision,
      puts: forged,
      semanticChange: {
        operationId: 'forged-operation',
        operationKind: 'reprocess',
        phase: 'governance',
        partitions: [
          {
            scopes: ['private'],
            affected: {
              episodeIds: [],
              entityIds: ['private-entity'],
              factIds: [report.facts.created[0]!],
            },
          },
        ],
      },
    })

    const rebuilt = await memory.rebuildProjections({
      kinds: ['embedding'],
      entityIds: ['private-entity'],
      factIds: [report.facts.created[0]!],
    })

    expect(rebuilt.failed).toBe(0)
    expect(disclosures.length).toBeGreaterThan(0)
    expect(disclosures.every((scopes) => scopes.join(',') === 'private')).toBe(true)
    expect(disclosures).not.toContainEqual([])
  })

  it('discloses the complete input and inference-context sensitivity set', async () => {
    const observed: string[][] = []
    const remoteInference: StructuredInferenceProvider = {
      lineage: {
        provider: 'fixture',
        model: 'classified-context-v1',
        destination: 'remote',
      },
      infer: async () => ({ entities: [], facts: [] }),
    }
    const policy: MemoryPolicy = {
      authorizeDisclosure: (request) => {
        if (request.capability === 'inference') observed.push([...request.sensitivities])
        return { action: 'allow' }
      },
    }
    const { memory } = harness({
      inference: remoteInference,
      policy,
      ingestion: { contextLimit: 10 },
    })
    await memory.open({ create: true })
    await memory.remember({
      id: 'classified-context',
      kind: 'assertion',
      content: { type: 'text', text: 'Classified context entity has a fact.' },
      source: { kind: 'fixture' },
      sensitivity: 'context-secret',
      assertions: {
        entities: [{ id: 'classified-context-entity', name: 'Classified context entity' }],
        facts: [
          {
            id: 'classified-context-fact',
            subject: { id: 'classified-context-entity' },
            predicate: 'classified_context_fact',
            object: { scalar: true },
          },
        ],
      },
    })
    await memory.remember({
      id: 'classified-target',
      kind: 'text',
      content: { type: 'text', text: 'Use classified context.' },
      source: { kind: 'fixture' },
      sensitivity: 'target-confidential',
    })

    expect(observed).toEqual([['context-secret', 'target-confidential']])
  })

  it('partitions equal-scope embedding work by exact sensitivity set', async () => {
    const disclosures: { sensitivities: string[]; texts: string[] }[] = []
    const remoteEmbeddings: EmbeddingProvider = {
      lineage: {
        provider: 'fixture',
        model: 'classified-partitions-v1',
        destination: 'remote',
        dimensions: 2,
      },
      embed: async ({ texts }) => texts.map(() => [1, 0]),
    }
    const policy: MemoryPolicy = {
      authorizeDisclosure: (request) => {
        if (request.capability === 'embedding') {
          const payload = request.payload as { texts: string[] }
          disclosures.push({
            sensitivities: [...request.sensitivities],
            texts: [...payload.texts],
          })
        }
        return { action: 'allow' }
      },
    }
    const { memory, storage } = harness({ embeddings: remoteEmbeddings, policy })
    await memory.open({ create: true })
    for (const [id, sensitivity] of [
      ['internal-episode', 'internal'],
      ['restricted-episode', 'restricted'],
    ] as const) {
      await memory.remember({
        id,
        kind: 'assertion',
        content: { type: 'text', text: `${sensitivity} projection source.` },
        source: { kind: 'fixture' },
        sensitivity,
        assertions: { entities: [{ id: `${id}-entity`, name: `${sensitivity} entity` }] },
      })
    }
    disclosures.length = 0

    const rebuilt = await memory.rebuildProjections({
      kinds: ['embedding'],
      episodeIds: ['internal-episode', 'restricted-episode'],
    })
    const projections = await storageDriver(storage).query({
      kind: 'projection',
      spaceId: 'space-1',
      filters: [
        { field: 'target.kind', op: 'eq', value: 'episode' },
        {
          field: 'target.id',
          op: 'in',
          value: ['internal-episode', 'restricted-episode'],
        },
        { field: 'projectionKind', op: 'eq', value: 'embedding' },
      ],
      limit: 10,
    })

    expect(rebuilt.failed).toBe(0)
    expect(disclosures).toHaveLength(2)
    expect(disclosures.map((item) => item.sensitivities).sort()).toEqual([
      ['internal'],
      ['restricted'],
    ])
    expect(disclosures.every((item) => item.texts.length === 1)).toBe(true)
    expect(projections.map((item) => item.sensitivities).sort()).toEqual([
      ['internal'],
      ['restricted'],
    ])
  })

  it('propagates selected retrieval dependencies to rerank disclosure', async () => {
    const observed: string[][] = []
    const reranker: RerankProvider = {
      lineage: {
        provider: 'fixture',
        model: 'classified-rerank-v1',
        destination: 'remote',
      },
      rerank: async ({ documents }) =>
        documents.map((document, index) => ({ id: document.id, score: -index })),
    }
    const policy: MemoryPolicy = {
      authorizeDisclosure: (request) => {
        if (request.capability === 'rerank') observed.push([...request.sensitivities])
        return { action: 'allow' }
      },
    }
    const { memory } = harness({ reranker, policy })
    await memory.open({ create: true })
    await memory.remember({
      id: 'rerank-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Classified rerank target.' },
      source: { kind: 'fixture' },
      sensitivity: 'rerank-secret',
      assertions: { entities: [{ id: 'rerank-entity', name: 'Classified rerank target' }] },
    })

    const result = await memory.recall({
      query: 'classified',
      access: { allowedScopes: [] },
      rerank: true,
      channels: { exact: true, lexical: true, semantic: false, graph: false, temporal: false },
    })

    expect(result.degraded).not.toContainEqual(expect.objectContaining({ capability: 'rerank' }))
    expect(observed).toEqual([['rerank-secret']])
  })

  it('enforces exact disclosure bytes before policy or provider execution', async () => {
    let policyCalls = 0
    let providerCalls = 0
    const provider: EmbeddingProvider = {
      lineage: {
        provider: 'fixture',
        model: 'byte-budget-v1',
        destination: 'remote',
        dimensions: 2,
      },
      embed: async ({ texts }) => {
        providerCalls += 1
        return texts.map(() => [1, 0])
      },
    }
    const policy: MemoryPolicy = {
      authorizeDisclosure: () => {
        policyCalls += 1
        return { action: 'allow' }
      },
    }
    const { memory } = harness({
      embeddings: provider,
      policy,
      disclosureLimits: { maxBytes: 1, maxTokens: 4_000_000 },
    })
    await memory.open({ create: true })

    await expect(
      memory.recall({
        query: 'Never disclose an oversized payload.',
        access: { allowedScopes: [] },
        channels: { exact: false, lexical: false, semantic: true, graph: false, temporal: false },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'provider_disclosure',
        dimension: 'bytes',
        maximum: 1,
      },
    })
    expect(policyCalls).toBe(0)
    expect(providerCalls).toBe(0)
  })

  it('enforces provider-aware token counts and fails invalid counters closed', async () => {
    let providerCalls = 0
    const provider: EmbeddingProvider = {
      lineage: {
        provider: 'fixture',
        model: 'token-budget-v1',
        destination: 'local',
        dimensions: 2,
      },
      embed: async ({ texts }) => {
        providerCalls += 1
        return texts.map(() => [1, 0])
      },
    }
    const bounded = harness({
      embeddings: provider,
      disclosureLimits: { maxBytes: 1024 * 1024, maxTokens: 1, countTokens: () => 2 },
    })
    await bounded.memory.open({ create: true })
    await expect(
      bounded.memory.recall({
        query: 'Count provider tokens.',
        access: { allowedScopes: [] },
        channels: { exact: false, lexical: false, semantic: true, graph: false, temporal: false },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: {
        phase: 'provider_disclosure',
        dimension: 'tokens',
        required: 2,
        maximum: 1,
        measurement: 'provider_counter',
      },
    })
    expect(providerCalls).toBe(0)

    const invalid = harness({
      embeddings: provider,
      disclosureLimits: {
        maxBytes: 1024 * 1024,
        maxTokens: 100,
        countTokens: () => Number.NaN,
      },
    })
    await invalid.memory.open({ create: true })
    const failedClosed = await invalid.memory.recall({
      query: 'Reject invalid token counts.',
      access: { allowedScopes: [] },
      channels: { exact: false, lexical: false, semantic: true, graph: false, temporal: false },
    })
    expect(failedClosed.degraded).toContainEqual(
      expect.objectContaining({ capability: 'embedding' }),
    )
    expect(providerCalls).toBe(0)
  })

  it('remeasures policy-replaced disclosure payloads before provider execution', async () => {
    let policyCalls = 0
    let providerCalls = 0
    const provider: EmbeddingProvider = {
      lineage: {
        provider: 'fixture',
        model: 'replacement-budget-v1',
        destination: 'remote',
        dimensions: 2,
      },
      embed: async ({ texts }) => {
        providerCalls += 1
        return texts.map(() => [1, 0])
      },
    }
    const policy: MemoryPolicy = {
      authorizeDisclosure: () => {
        policyCalls += 1
        return { action: 'allow', payload: { expanded: 'x'.repeat(8_192) } }
      },
    }
    const { memory } = harness({
      embeddings: provider,
      policy,
      disclosureLimits: { maxBytes: 4_096, maxTokens: 4_000_000 },
    })
    await memory.open({ create: true })

    await expect(
      memory.recall({
        query: 'Policy replacement must remain bounded.',
        access: { allowedScopes: [] },
        channels: { exact: false, lexical: false, semantic: true, graph: false, temporal: false },
      }),
    ).rejects.toMatchObject({
      code: 'result_too_large',
      details: { phase: 'provider_disclosure', dimension: 'bytes', maximum: 4_096 },
    })
    expect(policyCalls).toBe(1)
    expect(providerCalls).toBe(0)
  })
})
