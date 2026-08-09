import { describe, expect, it } from 'vitest'

import {
  createMemory,
  type ContextBundle,
  type Memory,
  type MemoryOptions,
  type Ontology,
  type StructuredInferenceProvider,
} from '../src/index.ts'
import { snapshotJson, validateJson } from '../src/internal/value.ts'
import {
  createSurrealMemoryCapabilities,
  createSurrealMemoryStorage,
} from '../src/surreal/index.ts'
import { createInMemoryStorage } from '../src/testing/index.ts'
import { harness, OPEN_ONTOLOGY } from './support.ts'

const access = { allowedScopes: [] as string[] }

const emptyInference: StructuredInferenceProvider = {
  lineage: {
    provider: 'fixture',
    model: 'empty-v1',
    destination: 'local',
  },
  infer: async () => ({ entities: [], facts: [] }),
}

it('enforces JSON node budgets without materializing a width-sized traversal stack', () => {
  const sparse: null[] = []
  sparse.length = 1_000_000_000
  sparse[0] = null
  expect(() => validateJson(sparse, 'sparse', { maxNodes: 1 })).toThrow(
    'sparse exceeds 1 JSON nodes',
  )
  expect(() => snapshotJson(sparse, 'sparse', { maxNodes: 1 })).toThrow(
    'sparse exceeds 1 JSON nodes',
  )

  let reads = 0
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get: () => (reads++ === 0 ? 'snapshotted' : 'changed'),
  })
  expect(snapshotJson(accessor)).toMatchObject({
    value: { value: 'snapshotted' },
    nodes: 2,
  })
  expect(reads).toBe(1)

  let optionalReads = 0
  const optional = Object.defineProperty({ nested: { cursor: undefined } }, 'cursor', {
    enumerable: true,
    get: () => {
      optionalReads += 1
      return undefined
    },
  })
  expect(snapshotJson(optional, 'request', { omitUndefinedObjectProperties: true })).toMatchObject({
    value: { nested: {} },
    nodes: 4,
  })
  expect(optionalReads).toBe(1)
  expect(() => snapshotJson([undefined], 'array', { omitUndefinedObjectProperties: true })).toThrow(
    'array[0] must be JSON-round-trippable',
  )

  const prototypeKey = snapshotJson(JSON.parse('{"__proto__":{"safe":true}}')).value as Record<
    string,
    unknown
  >
  expect(Object.hasOwn(prototypeKey, '__proto__')).toBe(true)
  expect(Object.getPrototypeOf(prototypeKey)).toBe(Object.prototype)
  expect(({} as { safe?: boolean }).safe).toBeUndefined()

  const unreadable = Object.defineProperty({}, 'value', {
    enumerable: true,
    get: () => {
      throw new Error('untrusted snapshot detail')
    },
  })
  expect(() => snapshotJson(unreadable, 'unreadable')).toThrow(
    expect.objectContaining({
      code: 'invalid_input',
      message: 'unreadable could not be snapshotted as JSON',
    }),
  )
})

function extensionRecall(memory: Memory): Promise<ContextBundle> {
  return memory.recall({ query: 'public contract', access })
}

function copilotPrompt(context: ContextBundle): string {
  return `${context.rendered}\nSources: ${Object.keys(context.citations).join(', ')}`
}

describe('baseline contracts', () => {
  it('AC02 root package is headless and serverless', async () => {
    const root = await import('../src/index.ts')
    const memory = createMemory({
      spaceId: 'headless',
      storage: createInMemoryStorage(),
    })

    expect(globalThis.document).toBeUndefined()
    expect(Object.keys(root).sort()).toEqual(
      ['MemoryError', 'createMemory', 'isRetryable', 'openSyncBundle'].sort(),
    )
    const mutableDetails = { queryOutcome: 'unknown', nested: { values: ['original'] } }
    const immutableError = new root.MemoryError('storage_failed', 'immutable diagnostics', {
      retryable: false,
      details: mutableDetails,
    })
    mutableDetails.queryOutcome = 'changed'
    mutableDetails.nested.values[0] = 'changed'
    expect(immutableError.details).toEqual({
      queryOutcome: 'unknown',
      nested: { values: ['original'] },
    })
    expect(Object.isFrozen(immutableError)).toBe(true)
    expect(Object.isFrozen(immutableError.details)).toBe(true)
    const immutableNested = immutableError.details?.nested as
      | { readonly values: readonly string[] }
      | undefined
    expect(immutableNested).toBeDefined()
    expect(Object.isFrozen(immutableNested)).toBe(true)
    expect(Object.isFrozen(immutableNested!.values)).toBe(true)
    expect(Reflect.set(immutableError, 'retryable', true)).toBe(false)
    expect(Reflect.set(immutableError.details!, 'queryOutcome', 'changed')).toBe(false)
    expect(Object.keys(memory)).toEqual(['spaceId'])
    await expect(memory.open({ create: true })).resolves.toMatchObject({ id: 'headless' })
    await expect(memory.inspect()).resolves.toMatchObject({
      storage: { persistent: false },
    })
  })

  it('detaches returned values and isolates every event listener payload', async () => {
    const { memory } = harness()
    const opened = await memory.open({
      create: true,
      metadata: { owner: 'original', nested: { state: 'ready' } },
    })
    const mutableOpened = opened.metadata as {
      owner: string
      nested: { state: string }
    }
    mutableOpened.owner = 'mutated'
    mutableOpened.nested.state = 'mutated'
    expect(await memory.open()).toMatchObject({
      metadata: { owner: 'original', nested: { state: 'ready' } },
    })

    const observed: { state: string; warnings: readonly string[] }[] = []
    memory.on('operation:settled', (event) => {
      Reflect.set(event.operation, 'state', 'failed')
      ;(event.operation.warnings as string[]).push('first-listener-mutation')
    })
    memory.on('operation:settled', (event) => {
      observed.push({ state: event.operation.state, warnings: event.operation.warnings })
    })

    const report = await memory.remember(
      {
        id: 'detached-output-episode',
        kind: 'assertion',
        content: { type: 'text', text: 'Original output content.' },
        source: { kind: 'output-test', metadata: { owner: 'original' } },
        assertions: { entities: [{ id: 'detached-output-entity', name: 'Original entity' }] },
      },
      { operationId: 'detached-output-operation' },
    )
    expect(observed).toEqual([{ state: 'succeeded', warnings: [] }])

    const mutableEpisode = report.episode as unknown as {
      content: { text: string }
      source: { metadata: { owner: string } }
    }
    mutableEpisode.content.text = 'Mutated output content.'
    mutableEpisode.source.metadata.owner = 'mutated'
    ;(report.operation.warnings as string[]).push('returned-report-mutation')
    ;(report.entities.created as string[]).push('invented-entity')

    expect(await memory.getEpisode('detached-output-episode', access)).toMatchObject({
      content: { text: 'Original output content.' },
      source: { metadata: { owner: 'original' } },
    })
    expect(await memory.getEntity('detached-output-entity', access)).toMatchObject({
      name: 'Original entity',
    })
    expect(await memory.getEntity('invented-entity', access)).toBeNull()
    expect(await memory.operation('detached-output-operation')).toMatchObject({
      state: 'succeeded',
      warnings: [],
    })
  })

  it('validates the disclosure-limit profile at construction', () => {
    const options = { spaceId: 'disclosure-limits', storage: createInMemoryStorage() }
    expect(() =>
      createMemory({
        ...options,
        disclosureLimits: { maxBytes: 0 },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(() =>
      createMemory({
        ...options,
        disclosureLimits: { maxTokens: 4_000_001 },
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(() =>
      createMemory({
        ...options,
        disclosureLimits: { unexpected: true } as never,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(() =>
      createMemory({
        ...options,
        disclosureLimits: { countTokens: 'not-a-function' } as never,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(() =>
      createMemory({
        ...options,
        ingestion: { candidateLimit: 8, unsupported: true } as never,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(() =>
      createMemory({
        ...options,
        retrieval: { weights: { invented: 1 } } as never,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(() =>
      createMemory({
        ...options,
        now: 'not-a-function' as never,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(() =>
      createMemory({
        ...options,
        ontology: {
          id: 'invalid-construction-ontology',
          version: '1',
          mode: 'open',
          entityTypes: [],
          factTypes: {},
        } as never,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }))
  })

  it('owns closed construction JSON while retaining captured behavior capabilities', async () => {
    const storage = createInMemoryStorage()
    const ontology = structuredClone(OPEN_ONTOLOGY) as Ontology
    const reads = new Map<string, number>()
    const capture =
      <T>(name: string, value: T, later: T = value): (() => T) =>
      () => {
        const count = (reads.get(name) ?? 0) + 1
        reads.set(name, count)
        return count === 1 ? value : later
      }
    const countTokens = () => 1
    const disclosureLimits = Object.defineProperties(
      {},
      {
        maxBytes: { configurable: true, enumerable: true, get: capture('maxBytes', 1_024, 0) },
        maxTokens: { configurable: true, enumerable: true, get: capture('maxTokens', 1_024, 0) },
        countTokens: {
          configurable: true,
          enumerable: true,
          get: capture('countTokens', countTokens, 'changed' as unknown as typeof countTokens),
        },
      },
    )
    const now = () => new Date('2026-08-09T10:00:00.000Z')
    const createId = () => 'construction-capability-id'
    const onError = () => undefined
    const options = Object.defineProperties(
      {},
      {
        spaceId: { enumerable: true, get: capture('spaceId', 'construction-owned', '') },
        storage: { enumerable: true, get: capture('storage', storage) },
        ontology: { enumerable: true, get: capture('ontology', ontology) },
        disclosureLimits: {
          enumerable: true,
          get: capture('disclosureLimits', disclosureLimits),
        },
        ingestion: {
          enumerable: true,
          get: capture('ingestion', { candidateLimit: 8 }, { candidateLimit: 0 }),
        },
        retrieval: {
          enumerable: true,
          get: capture('retrieval', { candidateLimit: 8 }, { candidateLimit: 0 }),
        },
        operationTimeoutMs: {
          enumerable: true,
          get: capture('operationTimeoutMs', 5_000, 0),
        },
        now: { enumerable: true, get: capture('now', now) },
        createId: { enumerable: true, get: capture('createId', createId) },
        onError: { enumerable: true, get: capture('onError', onError) },
      },
    ) as MemoryOptions

    const memory = createMemory(options)
    ;(ontology as { id: string }).id = 'mutated-after-construction'
    Object.defineProperty(disclosureLimits, 'maxBytes', { enumerable: true, value: 0 })

    await expect(memory.open({ create: true })).resolves.toMatchObject({
      id: 'construction-owned',
      ontology: { id: OPEN_ONTOLOGY.id, version: OPEN_ONTOLOGY.version },
    })
    expect(Object.fromEntries(reads)).toEqual({
      spaceId: 1,
      storage: 1,
      ontology: 1,
      disclosureLimits: 1,
      ingestion: 1,
      retrieval: 1,
      operationTimeoutMs: 1,
      now: 1,
      createId: 1,
      onError: 1,
      maxBytes: 1,
      maxTokens: 1,
      countTokens: 1,
    })
  })

  it('rejects unknown or unreadable construction properties before capability use', () => {
    const storage = createInMemoryStorage()
    expect(() =>
      createMemory({
        spaceId: 'construction-unknown',
        storage,
        unsupported: true,
      } as unknown as MemoryOptions),
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }))

    const unreadable = Object.defineProperty(
      { spaceId: 'construction-unreadable', storage },
      'retrieval',
      {
        enumerable: true,
        get: () => {
          throw new Error('unreadable construction profile')
        },
      },
    )
    expect(() => createMemory(unreadable as MemoryOptions)).toThrow(
      expect.objectContaining({
        code: 'invalid_input',
        message: 'memory options could not be snapshotted',
      }),
    )
  })

  it('keeps raw SurrealQL on a separate opt-in admin capability', async () => {
    const request = {
      query: 'RETURN $value;',
      bindings: { value: true },
      confirmNamespace: 'astrale',
      confirmDatabase: 'temporal_memory',
    }
    const storage = createSurrealMemoryStorage({ endpoint: 'mem://' })

    expect('rawQuery' in createInMemoryStorage()).toBe(false)
    expect('rawQuery' in storage).toBe(false)
    expect(() =>
      createSurrealMemoryCapabilities(
        { endpoint: 'mem://' },
        { dangerouslyAllowRawQueries: false as true },
      ),
    ).toThrow(expect.objectContaining({ code: 'policy_denied' }))
    expect(() =>
      createSurrealMemoryCapabilities(storage as never, {
        dangerouslyAllowRawQueries: true,
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    expect(() =>
      createSurrealMemoryCapabilities({ endpoint: 'mem://' }, {
        dangerouslyAllowRawQueries: true,
        unexpected: true,
      } as never),
    ).toThrow(expect.objectContaining({ code: 'invalid_input' }))
    const capabilities = createSurrealMemoryCapabilities(
      { endpoint: 'mem://' },
      { dangerouslyAllowRawQueries: true },
    )
    const { admin } = capabilities
    expect(Object.isFrozen(capabilities)).toBe(true)
    expect(Object.isFrozen(capabilities.storage)).toBe(true)
    expect('rawQuery' in capabilities.storage).toBe(false)
    expect(Object.isFrozen(admin)).toBe(true)
    expect(Object.keys(admin)).toEqual(['rawQuery'])
    await expect(admin.rawQuery({ ...request, confirmDatabase: 'wrong' })).rejects.toMatchObject({
      code: 'invalid_input',
    })
    await expect(admin.rawQuery(request)).rejects.toMatchObject({ code: 'not_open' })
    await expect(
      admin.rawQuery({ ...request, bindings: { 'invalid-name': true } }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const unreadable = Object.defineProperty({ ...request }, 'query', {
      enumerable: true,
      get: () => {
        throw new Error('untrusted accessor detail')
      },
    })
    await expect(admin.rawQuery(unreadable)).rejects.toMatchObject({
      code: 'invalid_input',
      message: 'raw query request could not be snapshotted',
    })
  })

  it('AC03 accepts text, conversational, structured, and explicit-assertion episodes', async () => {
    const { memory } = harness({ inference: emptyInference })
    await memory.open({ create: true })

    const reports = await Promise.all([
      memory.remember({
        id: 'text',
        kind: 'text',
        content: { type: 'text', text: 'Plain text evidence.' },
        source: { kind: 'fixture' },
      }),
      memory.remember({
        id: 'message',
        kind: 'message',
        content: { type: 'message', role: 'user', text: 'Conversational evidence.' },
        source: { kind: 'fixture' },
      }),
      memory.remember({
        id: 'structured',
        kind: 'structured',
        content: { type: 'structured', value: { project: 'Temporal Memory' } },
        source: { kind: 'fixture' },
      }),
      memory.remember({
        id: 'assertion',
        kind: 'assertion',
        content: { type: 'text', text: 'A host-supplied assertion.' },
        source: { kind: 'fixture' },
        assertions: { entities: [{ id: 'contract', name: 'Public contract' }] },
      }),
    ])

    expect(reports.map((report) => report.operation.state)).toEqual([
      'succeeded',
      'succeeded',
      'succeeded',
      'succeeded',
    ])
    expect(await memory.stats()).toMatchObject({ episodes: 4, entities: 1 })
  })

  it('requires canonical UTC instants so lexical temporal ordering is chronological', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    const input = {
      id: 'non-canonical-time',
      kind: 'assertion' as const,
      content: { type: 'text' as const, text: 'Timestamp validation.' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'clock', name: 'Clock' }] },
    }

    await expect(
      memory.remember({ ...input, observedAt: '2026-08-03T12:00:00+02:00' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      memory.remember({ ...input, observedAt: '2026-08-03T10:00:00Z' }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      memory.remember({ ...input, observedAt: '2026-08-03T10:00:00.000Z' }),
    ).resolves.toMatchObject({ episode: { observedAt: '2026-08-03T10:00:00.000Z' } })
  })

  it('rejects unpaired Unicode surrogates before persistence or hashing', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    const unpaired = String.fromCharCode(0xd800)

    await expect(
      memory.remember({
        id: `invalid-${unpaired}`,
        kind: 'text',
        content: { type: 'text', text: 'Invalid identifier.' },
        source: { kind: 'fixture' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      memory.remember({
        id: 'invalid-content',
        kind: 'structured',
        content: { type: 'structured', value: { invalid: unpaired } },
        source: { kind: 'fixture' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('AC20 lets an extension use only the public Memory contract', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'public-contract',
      kind: 'assertion',
      content: { type: 'text', text: 'The extension uses the public contract.' },
      source: { kind: 'extension' },
      assertions: { entities: [{ id: 'contract', name: 'Public contract' }] },
    })

    const context = await extensionRecall(memory)

    expect(context.entities.map((entity) => entity.id)).toContain('contract')
    expect('query' in (memory as object)).toBe(false)
    expect('driver' in (memory as object)).toBe(false)
  })

  it('AC21 returns a detached ContextBundle consumable after memory closes', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'copilot-context',
      kind: 'assertion',
      content: { type: 'text', text: 'The Copilot receives cited context.' },
      source: { kind: 'extension' },
      assertions: { entities: [{ id: 'copilot', name: 'Copilot context' }] },
    })
    const context = structuredClone(await extensionRecall(memory))
    await memory.close()

    const prompt = copilotPrompt(context)

    expect(prompt).toContain('Copilot context')
    expect(prompt).toContain('Sources: m1')
    expect(JSON.stringify(context)).not.toMatch(/surreal|indxdb|sql/iu)
  })

  it('AC22 constrains prescribed types and maps permitted unknowns through hybrid fallbacks', async () => {
    const prescribed: Ontology = {
      id: 'ontology.prescribed',
      version: '1',
      mode: 'prescribed',
      entityTypes: { Person: {} },
      factTypes: {},
    }
    const rejected = harness({ ontology: prescribed })
    await rejected.memory.open({ create: true })
    const rejection = await rejected.memory.remember({
      id: 'unknown-prescribed',
      kind: 'assertion',
      content: { type: 'text', text: 'A model invented a type.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'unknown', name: 'Unknown', types: ['InventedType'] }],
      },
    })

    expect(rejection.operation.state).toBe('failed')
    expect(rejection.warnings).toContain('unknown prescribed entity type: InventedType')
    expect(await rejected.memory.getEpisode('unknown-prescribed', access)).toMatchObject({
      id: 'unknown-prescribed',
    })
    expect((await rejected.memory.stats()).entities).toBe(0)

    const hybrid: Ontology = {
      id: 'ontology.hybrid',
      version: '1',
      mode: 'hybrid',
      entityTypes: { OtherEntity: {} },
      factTypes: {
        OtherFact: {
          predicate: 'fallback',
          object: { kind: 'scalar' },
        },
      },
      unknownEntityType: 'OtherEntity',
      unknownFactType: 'OtherFact',
    }
    const fallback = harness({ ontology: hybrid })
    await fallback.memory.open({ create: true })
    const accepted = await fallback.memory.remember({
      id: 'unknown-hybrid',
      kind: 'assertion',
      content: { type: 'text', text: 'An unknown type uses explicit fallbacks.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'unknown', name: 'Unknown', types: ['InventedType'] }],
        facts: [
          {
            subject: { id: 'unknown' },
            predicate: 'invented_relation',
            object: { scalar: 'value' },
            type: 'InventedFact',
          },
        ],
      },
    })

    expect(await fallback.memory.getEntity('unknown', access)).toMatchObject({
      types: ['OtherEntity'],
    })
    expect(await fallback.memory.getFact(accepted.facts.created[0]!, access)).toMatchObject({
      type: 'OtherFact',
      predicate: 'invented_relation',
    })

    const warningOntology: Ontology = {
      id: 'ontology.warning',
      version: '1',
      mode: 'prescribed',
      entityTypes: { Subject: {} },
      factTypes: {
        NumericClaim: {
          predicate: 'has_count',
          object: { kind: 'scalar', valueType: 'number' },
          severity: 'warn',
        },
      },
    }
    const warning = harness({ ontology: warningOntology })
    await warning.memory.open({ create: true })
    const warned = await warning.memory.remember({
      id: 'warning-severity',
      kind: 'assertion',
      content: { type: 'text', text: 'A warning-level ontology mismatch.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'subject', name: 'Subject', types: ['Subject'] }],
        facts: [
          {
            subject: { id: 'subject' },
            predicate: 'has_count',
            object: { scalar: 'not a number' },
            type: 'NumericClaim',
          },
        ],
      },
    })
    expect(warned.operation.state).toBe('succeeded')
    expect(warned.warnings).toContain('scalar object does not satisfy fact type NumericClaim')
  })

  it('treats same-name identities and injected query syntax as untrusted data', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    const injected = "Robert'); DELETE tm_episode; --"

    await memory.remember({
      id: 'identity-1',
      kind: 'assertion',
      content: { type: 'text', text: injected },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          {
            id: 'alex-1',
            name: 'Alex Smith',
            identifiers: { email: 'alex.one@example.test' },
          },
        ],
      },
    })
    await memory.remember({
      id: 'identity-2',
      kind: 'assertion',
      content: { type: 'text', text: 'A distinct Alex Smith.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          {
            id: 'alex-2',
            name: 'Alex Smith',
            identifiers: { email: 'alex.two@example.test' },
          },
        ],
      },
    })

    expect(await memory.getEpisode('identity-1', access)).toMatchObject({
      content: { type: 'text', text: injected },
    })
    expect(await memory.getEntity('alex-1', access)).toMatchObject({ id: 'alex-1' })
    expect(await memory.getEntity('alex-2', access)).toMatchObject({ id: 'alex-2' })
    expect(await memory.stats()).toMatchObject({ episodes: 2, entities: 2 })
  })
})
