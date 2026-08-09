import { describe, expect, it, vi } from 'vitest'

import { MemoryError, type MemoryExport } from '../src/index.ts'
import { sha256, stableStringify } from '../src/internal/value.ts'
import { storageDriver } from '../src/storage/driver.ts'
import { harness, WORK_ONTOLOGY } from './support.ts'

const publicAccess = { allowedScopes: [] as string[] }
const privateAccess = { allowedScopes: ['private'] }
const exactOnly = {
  exact: true,
  lexical: false,
  semantic: false,
  graph: false,
  temporal: false,
} as const

async function resignArchive(
  archive: MemoryExport,
  canonical: MemoryExport['canonical'],
): Promise<MemoryExport> {
  return {
    ...archive,
    canonical,
    manifest: {
      ...archive.manifest,
      digest: await sha256(stableStringify(canonical as unknown as never)),
      counts: {
        episodes: canonical.episodes.length,
        entities: canonical.entities.length,
        facts: canonical.facts.length,
        evidence: canonical.evidence.length,
        derivations: canonical.derivations.length,
        mentions: canonical.mentions.length,
        lifecycle: canonical.lifecycle.length,
        merges: canonical.merges.length,
      },
    },
  }
}

describe('scope isolation and temporal provenance', () => {
  it('does not launder private entity attributes through a public identity', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'public-alice',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice has a public profile.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          {
            id: 'alice',
            name: 'Alice',
            types: ['Person'],
            identifiers: { handle: 'alice-public' },
          },
        ],
      },
    })
    await memory.remember({
      id: 'private-alice',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice has a restricted identifier.' },
      source: { kind: 'fixture' },
      scopes: ['private'],
      assertions: {
        entities: [
          {
            id: 'alice',
            name: 'Alice Restricted',
            types: ['VIP'],
            identifiers: { ssn: 'SECRET-123' },
          },
        ],
      },
    })

    const publicEntity = await memory.getEntity('alice', publicAccess)
    expect(publicEntity).toMatchObject({
      name: 'Alice',
      types: ['Person'],
      identifiers: { handle: 'alice-public' },
    })
    expect(JSON.stringify(publicEntity)).not.toMatch(/SECRET-123|Restricted|VIP/u)

    const publicRecall = await memory.recall({
      query: 'SECRET-123',
      access: publicAccess,
      channels: { exact: true, lexical: true, semantic: false, graph: false, temporal: false },
    })
    expect(publicRecall.entities).toEqual([])
    expect(JSON.stringify(publicRecall)).not.toMatch(/SECRET-123|private-alice/u)

    const privateEntity = await memory.getEntity('alice', privateAccess)
    expect(privateEntity?.identifiers).toMatchObject({
      handle: 'alice-public',
      ssn: 'SECRET-123',
    })
  })

  it('does not let direct export selection bypass visible evidence', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'private-only',
      kind: 'assertion',
      content: { type: 'text', text: 'Restricted identity.' },
      source: { kind: 'fixture' },
      scopes: ['private'],
      assertions: {
        entities: [
          { id: 'restricted', name: 'Restricted', identifiers: { secret: 'PRIVATE-VALUE' } },
        ],
      },
    })

    const exported = await memory.export({
      access: publicAccess,
      entityIds: ['restricted'],
    })

    expect(exported.canonical.entities).toEqual([])
    expect(exported.canonical.episodes).toEqual([])
    expect(JSON.stringify(exported)).not.toMatch(/restricted|PRIVATE-VALUE|private-only/u)
  })

  it('filters authorization before lexical top-k selection', async () => {
    const { memory } = harness({ retrieval: { candidateLimit: 1 } })
    await memory.open({ create: true })
    for (let index = 0; index < 6; index += 1) {
      await memory.remember({
        id: `private-hit-${index}`,
        kind: 'assertion',
        content: { type: 'text', text: 'needle needle needle needle' },
        source: { kind: 'fixture' },
        scopes: ['private'],
        assertions: {
          entities: [{ id: `private-${index}`, name: 'needle needle needle needle' }],
        },
      })
    }
    await memory.remember({
      id: 'public-hit',
      kind: 'assertion',
      content: { type: 'text', text: 'needle public' },
      source: { kind: 'fixture' },
      assertions: { entities: [{ id: 'public', name: 'needle public' }] },
    })

    const result = await memory.recall({
      query: 'needle',
      access: publicAccess,
      limit: 1,
      channels: { exact: false, lexical: true, semantic: false, graph: false, temporal: false },
    })

    expect(result.entities.map((entity) => entity.id)).toEqual(['public'])
    expect(JSON.stringify(result)).not.toContain('private-hit')
  })

  it('keeps fact reconciliation inside an exact scope partition', async () => {
    const { memory } = harness({ ontology: WORK_ONTOLOGY })
    await memory.open({ create: true })
    const first = await memory.remember({
      id: 'public-employment',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice works at Acme.' },
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
    await memory.remember({
      id: 'private-employment',
      kind: 'assertion',
      content: { type: 'text', text: 'A restricted source says Alice works at Globex.' },
      source: { kind: 'fixture' },
      scopes: ['private'],
      assertions: {
        entities: [
          { id: 'alice', name: 'Alice', types: ['Person'] },
          { id: 'globex', name: 'Globex', types: ['Company'] },
        ],
        facts: [
          {
            subject: { id: 'alice' },
            predicate: 'works_at',
            object: { id: 'globex' },
            type: 'Employment',
          },
        ],
      },
    })

    const publicFact = await memory.getFact(first.facts.created[0]!, publicAccess)
    expect(publicFact).toMatchObject({ status: 'active', object: { entityId: 'acme' } })
    const publicRecall = await memory.recall({ query: 'works_at', access: publicAccess })
    expect(publicRecall.facts).toHaveLength(1)
    expect(JSON.stringify(publicRecall)).not.toContain('globex')
  })

  it('requires whole-entity authority for global merge and purge operations', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'public-identities',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice and Bob are public identities.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [
          { id: 'alice', name: 'Alice' },
          { id: 'bob', name: 'Bob' },
        ],
      },
    })
    await memory.remember({
      id: 'private-alice',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice has private provenance.' },
      source: { kind: 'fixture' },
      scopes: ['private'],
      assertions: { entities: [{ id: 'alice', name: 'Alice Private' }] },
    })

    await expect(
      memory.mergeEntities({ targetId: 'alice', sourceIds: ['bob'], access: publicAccess }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'scope_denied'))
    await expect(
      memory.hardPurge({ entityIds: ['alice'], access: publicAccess }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'scope_denied'))

    expect(await memory.getEntity('alice', privateAccess)).not.toBeNull()
    expect(await memory.getEntity('bob', publicAccess)).not.toBeNull()
  })

  it('requires authority over the complete hard-purge derivative closure', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    await memory.remember({
      id: 'public-purge-target',
      kind: 'event',
      content: { type: 'event', name: 'public', value: true },
      source: { kind: 'fixture' },
    })
    const baseline = await memory.browseSignals({ access: privateAccess })
    await memory.putSignals({
      access: privateAccess,
      expectedRevision: baseline.snapshotRevision,
      signals: [
        {
          namespace: 'private.derivative',
          target: { kind: 'episode', id: 'public-purge-target' },
          producer: { kind: 'algorithm', id: 'private-index', version: '1' },
          scopes: ['private'],
          basis: { episodeIds: ['public-purge-target'] },
          value: { private: true },
        },
      ],
    })

    await expect(
      memory.hardPurge({ episodeIds: ['public-purge-target'], access: publicAccess }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'scope_denied'))
    expect(await memory.getEpisode('public-purge-target', publicAccess)).not.toBeNull()

    await expect(
      memory.hardPurge({ episodeIds: ['public-purge-target'], access: privateAccess }),
    ).resolves.toMatchObject({ purged: true })
  })

  it('requires visible evidence even in history diagnostics', async () => {
    const { memory } = harness({ ontology: WORK_ONTOLOGY })
    await memory.open({ create: true })
    const privateReport = await memory.remember({
      id: 'private-fact',
      kind: 'assertion',
      content: { type: 'text', text: 'Restricted employment.' },
      source: { kind: 'fixture' },
      scopes: ['private'],
      assertions: {
        entities: [
          { id: 'private-person', name: 'Private Person', types: ['Person'] },
          { id: 'private-company', name: 'Private Company', types: ['Company'] },
        ],
        facts: [
          {
            subject: { id: 'private-person' },
            predicate: 'works_at',
            object: { id: 'private-company' },
            type: 'Employment',
          },
        ],
      },
    })
    const factId = privateReport.facts.created[0]!

    const history = await memory.recall({
      anchors: { factIds: [factId] },
      access: publicAccess,
      view: { kind: 'history' },
      channels: exactOnly,
    })

    expect(history.facts).toEqual([])
    expect(JSON.stringify(history)).not.toMatch(new RegExp(`${factId}|private-fact`, 'u'))
  })

  it('reconstructs support before retraction and retains withdrawn evidence in history', async () => {
    let instant = '2025-01-01T00:00:00.000Z'
    const { memory } = harness({ ontology: WORK_ONTOLOGY, now: () => new Date(instant) })
    await memory.open({ create: true })
    const report = await memory.remember({
      id: 'employment',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice works at Acme.' },
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
    const factId = report.facts.created[0]!
    instant = '2027-01-01T00:00:00.000Z'
    await memory.retractFact({ factId, allSupport: true, access: publicAccess })

    const knownBefore = await memory.recall({
      anchors: { factIds: [factId] },
      access: publicAccess,
      view: { kind: 'known-at', at: '2026-01-01T00:00:00.000Z' },
      channels: exactOnly,
    })
    expect(knownBefore.facts[0]).toMatchObject({ id: factId, status: 'active' })

    const history = await memory.recall({
      anchors: { factIds: [factId] },
      access: publicAccess,
      view: { kind: 'history' },
      channels: exactOnly,
    })
    expect(history.facts[0]).toMatchObject({ id: factId, status: 'retracted' })
    expect(history.facts[0]?.evidence.map((item) => item.episodeId)).toContain('employment')
  })

  it('keeps soft-deleted provenance temporal while current reads stay empty', async () => {
    let instant = '2025-01-01T00:00:00.000Z'
    const { memory } = harness({ ontology: WORK_ONTOLOGY, now: () => new Date(instant) })
    await memory.open({ create: true })
    const report = await memory.remember({
      id: 'employment',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice works at Acme.' },
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
    const factId = report.facts.created[0]!
    instant = '2027-01-01T00:00:00.000Z'
    await memory.deleteEpisode({ episodeId: 'employment', access: publicAccess })

    expect(await memory.getFact(factId, publicAccess)).toBeNull()
    const knownBefore = await memory.recall({
      anchors: { factIds: [factId] },
      access: publicAccess,
      view: { kind: 'known-at', at: '2026-01-01T00:00:00.000Z' },
      channels: exactOnly,
    })
    expect(knownBefore.facts[0]).toMatchObject({ id: factId, status: 'active' })

    const history = await memory.recall({
      anchors: { factIds: [factId] },
      access: publicAccess,
      view: { kind: 'history' },
      channels: exactOnly,
    })
    expect(history.facts[0]).toMatchObject({ id: factId, status: 'deleted' })
    expect(history.episodes.map((item) => item.episodeId)).toContain('employment')
  })

  it('rejects a valid-digest archive with broken canonical references before mutation', async () => {
    const seeded = harness({ ontology: WORK_ONTOLOGY })
    await seeded.memory.open({ create: true })
    await seeded.memory.remember({
      id: 'employment',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice works at Acme.' },
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
    const corrupt = structuredClone(
      await seeded.memory.export({ access: publicAccess, complete: true }),
    ) as MemoryExport
    const canonical = {
      ...corrupt.canonical,
      entities: corrupt.canonical.entities.filter((entity) => entity.id !== 'alice'),
    }
    const archive: MemoryExport = {
      ...corrupt,
      canonical,
      manifest: {
        ...corrupt.manifest,
        digest: await sha256(stableStringify(canonical as never)),
        counts: { ...corrupt.manifest.counts, entities: canonical.entities.length },
      },
    }
    const restored = harness({ ontology: WORK_ONTOLOGY })
    await restored.memory.open({ create: true })

    await expect(restored.memory.import(archive, { dryRun: true })).rejects.toSatisfy(
      (error: unknown) => MemoryError.is(error, 'import_invalid'),
    )
    expect(await restored.memory.stats()).toMatchObject({ episodes: 0, entities: 0, facts: 0 })
  })

  it('rejects valid-digest archives with incomplete episode content before mutation', async () => {
    const seeded = harness()
    await seeded.memory.open({ create: true })
    await seeded.memory.remember({
      id: 'source',
      kind: 'text',
      content: { type: 'text', text: 'Complete source content.' },
      source: { kind: 'fixture' },
    })
    const exported = await seeded.memory.export({ access: publicAccess, complete: true })
    const canonical: MemoryExport['canonical'] = {
      ...exported.canonical,
      episodes: exported.canonical.episodes.map((episode) => ({
        ...episode,
        content: { type: 'text' } as never,
      })),
    }
    const malformed = await resignArchive(exported, canonical)
    const restored = harness()
    await restored.memory.open({ create: true })

    await expect(restored.memory.import(malformed, { dryRun: true })).rejects.toSatisfy(
      (error: unknown) => MemoryError.is(error, 'import_invalid'),
    )
    expect(await restored.memory.stats()).toMatchObject({ episodes: 0, entities: 0, facts: 0 })
  })

  it('exports and verifies every episode content-identity preimage', async () => {
    const seeded = harness()
    await seeded.memory.open({ create: true })
    await seeded.memory.remember({
      id: 'identity-source',
      idempotencyKey: 'identity-request',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice owns a verifiable archive identity.' },
      source: { kind: 'fixture', externalId: 'identity-source' },
      tags: ['portable', 'identity'],
      metadata: { purpose: 'archive-verification' },
      assertions: {
        entities: [{ id: 'alice', name: 'Alice' }],
        facts: [{ subject: { id: 'alice' }, predicate: 'owns', object: { scalar: 'identity' } }],
      },
    })
    const exported = await seeded.memory.export({ access: publicAccess, complete: true })
    const episode = exported.canonical.episodes[0]!
    expect(exported.formatVersion).toBe(4)
    expect(episode.assertions).toEqual({
      entities: [{ id: 'alice', name: 'Alice' }],
      facts: [{ subject: { id: 'alice' }, predicate: 'owns', object: { scalar: 'identity' } }],
    })
    const identity = {
      id: episode.id,
      idempotencyKey: episode.idempotencyKey,
      kind: episode.kind,
      content: episode.content,
      source: episode.source,
      scopes: episode.scopes,
      sensitivity: episode.sensitivity ?? null,
      retention: episode.retention ?? null,
      tags: episode.tags,
      metadata: episode.metadata,
      validTime: episode.validTime ?? null,
      observedAt: episode.observedAt ?? null,
      assertions: episode.assertions ?? null,
    }
    expect(episode.contentHash).toBe(await sha256(stableStringify(identity as unknown as never)))

    const mutations: MemoryExport[] = [
      await resignArchive(exported, {
        ...exported.canonical,
        episodes: [{ ...episode, content: { type: 'text', text: 'Changed content.' } }],
      }),
      await resignArchive(exported, {
        ...exported.canonical,
        episodes: [{ ...episode, assertions: undefined }],
      }),
      await resignArchive(exported, {
        ...exported.canonical,
        episodes: [
          {
            ...episode,
            assertions: { ...episode.assertions, entities: [{ id: 'alice', name: 'Mallory' }] },
          },
        ],
      }),
    ]
    for (const archive of mutations) {
      const restored = harness()
      await restored.memory.open({ create: true })
      await expect(restored.memory.import(archive, { dryRun: true })).rejects.toMatchObject({
        code: 'import_invalid',
      })
      expect(await restored.memory.stats()).toMatchObject({ episodes: 0, entities: 0, facts: 0 })
    }
  })

  it('rejects every unknown nested archive property before target database reads', async () => {
    const ontology = {
      id: 'test.archive-closed-schema',
      version: '1',
      mode: 'open' as const,
      entityTypes: { Person: {} },
      factTypes: {},
    }
    const seeded = harness({ ontology })
    await seeded.memory.open({ create: true })
    await seeded.memory.remember({
      id: 'archive-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice, Alicia, and Acme establish an archive graph.' },
      source: { kind: 'fixture', metadata: { corpus: 'closed-schema' } },
      tags: ['closed-schema', 'archive'],
      assertions: {
        entities: [
          { id: 'alice', name: 'Alice', types: ['Person'] },
          { id: 'alicia', name: 'Alicia', types: ['Person'] },
          { id: 'acme', name: 'Acme' },
        ],
        facts: [
          {
            id: 'fact-base',
            subject: { id: 'alice' },
            predicate: 'works_at',
            object: { id: 'acme' },
          },
        ],
      },
    })
    await seeded.memory.remember({
      id: 'secondary-source',
      kind: 'text',
      content: { type: 'text', text: 'A second episode makes ordering observable.' },
      source: { kind: 'fixture' },
    })
    await seeded.memory.mergeEntities({
      targetId: 'alice',
      sourceIds: ['alicia'],
      access: publicAccess,
    })
    await seeded.memory.deriveFact({
      conclusion: {
        id: 'fact-derived',
        subjectId: 'alice',
        predicate: 'has_archive',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'archive/closed-schema', version: '1' },
      premises: [{ kind: 'fact', id: 'fact-base' }],
      access: publicAccess,
      expectedRevision: (await seeded.memory.stats()).snapshotRevision,
    })
    const exported = await seeded.memory.export({ access: publicAccess, complete: true })
    for (const section of Object.values(exported.canonical))
      expect(section.length).toBeGreaterThan(0)

    const episode = exported.canonical.episodes[0]!
    const entity = exported.canonical.entities[0]!
    const fact = exported.canonical.facts[0]!
    const evidence = exported.canonical.evidence[0]!
    const derivation = exported.canonical.derivations[0]!
    const mention = exported.canonical.mentions[0]!
    const lifecycle = exported.canonical.lifecycle[0]!
    const merge = exported.canonical.merges[0]!
    expect(Object.keys(merge).sort()).toEqual([
      'active',
      'createdAt',
      'id',
      'kindRecord',
      'operationId',
      'sourceIds',
      'spaceId',
      'targetId',
    ])
    expect(Object.keys(exported.manifest.counts).sort()).toEqual([
      'derivations',
      'entities',
      'episodes',
      'evidence',
      'facts',
      'lifecycle',
      'mentions',
      'merges',
    ])
    const canonicalAttacks: MemoryExport['canonical'][] = [
      {
        ...exported.canonical,
        episodes: [
          {
            ...episode,
            content: { ...episode.content, unexpected: true } as never,
          },
          ...exported.canonical.episodes.slice(1),
        ],
      },
      {
        ...exported.canonical,
        episodes: [
          {
            ...episode,
            source: { ...episode.source, unexpected: true } as never,
          },
          ...exported.canonical.episodes.slice(1),
        ],
      },
      {
        ...exported.canonical,
        episodes: [
          {
            ...episode,
            assertions: {
              ...episode.assertions,
              entities: [
                {
                  ...episode.assertions!.entities![0]!,
                  unexpected: true,
                } as never,
                ...episode.assertions!.entities!.slice(1),
              ],
            },
          },
          ...exported.canonical.episodes.slice(1),
        ],
      },
      {
        ...exported.canonical,
        entities: [
          {
            ...entity,
            aliases: [
              { ...entity.aliases[0]!, unexpected: true } as never,
              ...entity.aliases.slice(1),
            ],
          },
          ...exported.canonical.entities.slice(1),
        ],
      },
      {
        ...exported.canonical,
        facts: [
          { ...fact, lineage: { ...fact.lineage, unexpected: true } as never },
          ...exported.canonical.facts.slice(1),
        ],
      },
      {
        ...exported.canonical,
        evidence: [
          { ...evidence, target: { ...evidence.target, unexpected: true } as never },
          ...exported.canonical.evidence.slice(1),
        ],
      },
      {
        ...exported.canonical,
        derivations: [
          { ...derivation, rule: { ...derivation.rule, unexpected: true } as never },
          ...exported.canonical.derivations.slice(1),
        ],
      },
      {
        ...exported.canonical,
        mentions: [
          { ...mention, anchor: { ...mention.anchor!, unexpected: true } as never },
          ...exported.canonical.mentions.slice(1),
        ],
      },
      {
        ...exported.canonical,
        lifecycle: [
          { ...lifecycle, target: { ...lifecycle.target, unexpected: true } as never },
          ...exported.canonical.lifecycle.slice(1),
        ],
      },
      {
        ...exported.canonical,
        merges: [{ ...merge, unexpected: true } as never, ...exported.canonical.merges.slice(1)],
      },
      {
        ...exported.canonical,
        episodes: [
          { ...episode, spaceId: 'another-space' },
          ...exported.canonical.episodes.slice(1),
        ],
      },
      {
        ...exported.canonical,
        episodes: [
          { ...episode, tags: ['archive', 'archive'] },
          ...exported.canonical.episodes.slice(1),
        ],
      },
      {
        ...exported.canonical,
        entities: [...exported.canonical.entities].reverse(),
      },
      {
        ...exported.canonical,
        facts: [{ ...fact, deletedAt: false as never }, ...exported.canonical.facts.slice(1)],
      },
    ]
    const attacks: MemoryExport[] = [
      { ...exported, unexpected: true } as unknown as MemoryExport,
      { ...exported, space: { ...exported.space, unexpected: true } } as unknown as MemoryExport,
      {
        ...exported,
        ontology: {
          ...exported.ontology,
          entityTypes: {
            ...exported.ontology.entityTypes,
            Person: { ...exported.ontology.entityTypes.Person, unexpected: true },
          },
        },
      } as unknown as MemoryExport,
      {
        ...exported,
        manifest: {
          ...exported.manifest,
          counts: { ...exported.manifest.counts, unexpected: 0 },
        },
      } as unknown as MemoryExport,
      {
        ...exported,
        canonical: { ...exported.canonical, unexpected: [] },
      } as unknown as MemoryExport,
    ]
    for (const canonical of canonicalAttacks) attacks.push(await resignArchive(exported, canonical))

    const target = harness({ ontology })
    await target.memory.open({ create: true })
    const driver = storageDriver(target.storage)
    const reads = [
      vi.spyOn(driver, 'getSpace'),
      vi.spyOn(driver, 'get'),
      vi.spyOn(driver, 'query'),
      vi.spyOn(driver, 'count'),
      vi.spyOn(driver, 'exportRecords'),
    ]
    for (const attack of attacks) {
      await expect(target.memory.import(attack, { dryRun: true })).rejects.toMatchObject({
        code: 'import_invalid',
      })
    }
    for (const read of reads) expect(read).not.toHaveBeenCalled()
    reads.forEach((read) => read.mockRestore())
    expect(await target.memory.stats()).toMatchObject({ episodes: 0, entities: 0, facts: 0 })
  })

  it('rejects a million-node archive payload incrementally before target reads', async () => {
    const seeded = harness()
    await seeded.memory.open({ create: true })
    const exported = await seeded.memory.export({ access: publicAccess, complete: true })
    const oversized = {
      ...exported,
      space: {
        ...exported.space,
        metadata: { wide: Array.from({ length: 1_000_000 }, () => null) },
      },
    } as unknown as MemoryExport
    const target = harness()
    await target.memory.open({ create: true })
    const driver = storageDriver(target.storage)
    const getSpace = vi.spyOn(driver, 'getSpace')
    const query = vi.spyOn(driver, 'query')

    await expect(target.memory.import(oversized, { dryRun: true })).rejects.toSatisfy(
      (error: unknown) =>
        MemoryError.is(error, 'result_too_large') &&
        error.details?.phase === 'archive' &&
        error.details?.dimension === 'json_nodes',
    )
    expect(getSpace).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects re-signed archives whose evidence or mention anchors do not resolve', async () => {
    const seeded = harness()
    await seeded.memory.open({ create: true })
    await seeded.memory.remember({
      id: 'anchored-source',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice anchors a fact.' },
      source: { kind: 'fixture' },
      assertions: {
        entities: [{ id: 'alice', name: 'Alice' }],
        facts: [{ subject: { id: 'alice' }, predicate: 'anchors', object: { scalar: true } }],
      },
    })
    const exported = await seeded.memory.export({ access: publicAccess, complete: true })
    const invalidEvidence = await resignArchive(exported, {
      ...exported.canonical,
      evidence: exported.canonical.evidence.map((link, index) =>
        index === 0
          ? {
              ...link,
              anchor: { kind: 'text', unit: 'utf16-code-unit', start: 0, end: 999 },
            }
          : link,
      ),
    })
    const invalidMention = await resignArchive(exported, {
      ...exported.canonical,
      mentions: exported.canonical.mentions.map((mention, index) =>
        index === 0
          ? {
              ...mention,
              anchor: { kind: 'text', unit: 'utf16-code-unit', start: 6, end: 13 },
            }
          : mention,
      ),
    })

    for (const archive of [invalidEvidence, invalidMention]) {
      const restored = harness()
      await restored.memory.open({ create: true })
      await expect(restored.memory.import(archive, { dryRun: true })).rejects.toSatisfy(
        (error: unknown) => MemoryError.is(error, 'import_invalid'),
      )
      expect(await restored.memory.stats()).toMatchObject({ episodes: 0, entities: 0, facts: 0 })
    }
  })

  it('rejects malformed archive instants, scalar values, and SHA-256 fields', async () => {
    const seeded = harness()
    await seeded.memory.open({ create: true })
    await seeded.memory.remember({
      id: 'source',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice has a scalar fact.' },
      source: { kind: 'fixture', capturedAt: '2026-08-03T09:00:00.000Z' },
      assertions: {
        entities: [{ id: 'alice', name: 'Alice' }],
        facts: [{ subject: { id: 'alice' }, predicate: 'label', object: { scalar: 'value' } }],
      },
    })
    const exported = await seeded.memory.export({ access: publicAccess, complete: true })
    const mutations: MemoryExport[] = []
    mutations.push(
      await resignArchive(exported, {
        ...exported.canonical,
        episodes: exported.canonical.episodes.map((episode) => ({
          ...episode,
          source: { ...episode.source, capturedAt: '2026-08-03T11:00:00+02:00' },
        })),
      }),
    )
    mutations.push(
      await resignArchive(exported, {
        ...exported.canonical,
        facts: exported.canonical.facts.map((fact) => ({
          ...fact,
          object: { kind: 'scalar' } as never,
        })),
      }),
    )
    mutations.push(
      await resignArchive(exported, {
        ...exported.canonical,
        episodes: exported.canonical.episodes.map((episode) => ({
          ...episode,
          contentHash: 'A'.repeat(64),
        })),
      }),
    )
    mutations.push({
      ...exported,
      manifest: { ...exported.manifest, digest: exported.manifest.digest.toUpperCase() },
    })
    mutations.push({ ...exported, snapshotRevision: -1 })
    mutations.push({ ...exported, exportedAt: '2026-08-03T12:00:00+02:00' })
    mutations.push({ ...exported, formatVersion: 1 } as unknown as MemoryExport)

    for (const archive of mutations) {
      const restored = harness()
      await restored.memory.open({ create: true })
      await expect(restored.memory.import(archive, { dryRun: true })).rejects.toSatisfy(
        (error: unknown) => MemoryError.is(error, 'import_invalid'),
      )
      expect(await restored.memory.stats()).toMatchObject({ episodes: 0, entities: 0, facts: 0 })
    }
  })

  it('requires full ontology equality and complete prescribed fact definitions', async () => {
    const seeded = harness({ ontology: WORK_ONTOLOGY })
    await seeded.memory.open({ create: true })
    await seeded.memory.remember({
      id: 'employment',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice works at Acme.' },
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
    const exported = await seeded.memory.export({ access: publicAccess, complete: true })
    const ontologyMismatch: MemoryExport = {
      ...exported,
      ontology: {
        ...exported.ontology,
        entityTypes: { ...exported.ontology.entityTypes, Person: { description: 'forged' } },
      },
    }
    const entityTypeBypass = await resignArchive(exported, {
      ...exported.canonical,
      entities: exported.canonical.entities.map((entity, index) =>
        index === 0 ? { ...entity, types: ['Invented'] } : entity,
      ),
    })
    const factTypeBypass = await resignArchive(exported, {
      ...exported.canonical,
      facts: exported.canonical.facts.map((fact) => ({ ...fact, type: 'Invented' })),
    })
    const factPredicateBypass = await resignArchive(exported, {
      ...exported.canonical,
      facts: exported.canonical.facts.map((fact) => ({
        ...fact,
        predicate: 'founded',
        type: 'Employment',
      })),
    })
    const factObjectBypass = await resignArchive(exported, {
      ...exported.canonical,
      facts: exported.canonical.facts.map((fact) => ({
        ...fact,
        object: { kind: 'scalar', value: 'Acme' },
        type: 'Employment',
      })),
    })

    for (const archive of [
      ontologyMismatch,
      entityTypeBypass,
      factTypeBypass,
      factPredicateBypass,
      factObjectBypass,
    ]) {
      const restored = harness({ ontology: WORK_ONTOLOGY })
      await restored.memory.open({ create: true })
      await expect(restored.memory.import(archive)).rejects.toSatisfy((error: unknown) =>
        MemoryError.is(error, 'import_invalid'),
      )
      expect(await restored.memory.stats()).toMatchObject({ episodes: 0, entities: 0, facts: 0 })
    }
  })

  it('rejects mention and contradiction evidence that weakens target scope partitions', async () => {
    const seeded = harness({ ontology: WORK_ONTOLOGY })
    await seeded.memory.open({ create: true })
    await seeded.memory.remember({
      id: 'public-probe',
      kind: 'text',
      content: { type: 'text', text: 'Public probe.' },
      source: { kind: 'fixture' },
    })
    const report = await seeded.memory.remember({
      id: 'private-employment',
      kind: 'assertion',
      content: { type: 'text', text: 'Alice privately works at Acme.' },
      source: { kind: 'fixture' },
      scopes: ['private'],
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
    const exported = await seeded.memory.export({ access: privateAccess, complete: true })
    const attacks = [
      { relation: 'mentions' as const, target: { kind: 'entity' as const, id: 'alice' } },
      {
        relation: 'contradicts' as const,
        target: { kind: 'fact' as const, id: report.facts.created[0]! },
      },
    ]

    for (const [index, attack] of attacks.entries()) {
      const forged: MemoryExport['canonical']['evidence'][number] = {
        id: `forged-${index}`,
        spaceId: exported.space.id,
        episodeId: 'public-probe',
        target: attack.target,
        relation: attack.relation,
        status: 'active',
        scopes: [],
        createdAt: exported.exportedAt,
        operationId: `forged-operation-${index}`,
      }
      const malicious = await resignArchive(exported, {
        ...exported.canonical,
        evidence: [...exported.canonical.evidence, forged],
      })
      const restored = harness({ ontology: WORK_ONTOLOGY })
      await restored.memory.open({ create: true })

      await expect(restored.memory.import(malicious, { dryRun: true })).rejects.toSatisfy(
        (error: unknown) => MemoryError.is(error, 'import_invalid'),
      )
      expect(await restored.memory.stats()).toMatchObject({ episodes: 0, entities: 0, facts: 0 })
    }
  })

  it('rejects malformed or unknown nested remember properties before acceptance', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    const attempts = [
      {
        id: 'unknown-episode-property',
        kind: 'text',
        content: { type: 'text', text: 'Unknown top-level property.' },
        source: { kind: 'fixture' },
        unexpected: true,
      },
      {
        id: 'unknown-content-property',
        kind: 'text',
        content: { type: 'text', text: 'Unknown content property.', unexpected: true },
        source: { kind: 'fixture' },
      },
      {
        id: 'unknown-source-property',
        kind: 'text',
        content: { type: 'text', text: 'Unknown source property.' },
        source: { kind: 'fixture', unexpected: true },
      },
      {
        id: 'malformed-assertion-array',
        kind: 'assertion',
        content: { type: 'text', text: 'Malformed assertion array.' },
        source: { kind: 'fixture' },
        assertions: { entities: {} },
      },
      {
        id: 'unknown-assertion-property',
        kind: 'assertion',
        content: { type: 'text', text: 'Alice has an unknown assertion property.' },
        source: { kind: 'fixture' },
        assertions: { entities: [{ id: 'alice', name: 'Alice', unexpected: true }] },
      },
    ]
    for (const attempt of attempts) {
      await expect(memory.remember(attempt as never)).rejects.toMatchObject({
        code: 'invalid_input',
      })
    }
    expect(await memory.stats()).toMatchObject({ episodes: 0, entities: 0, facts: 0 })
  })

  it('rejects excessively deep JSON without recursive stack failure', async () => {
    const { memory } = harness()
    await memory.open({ create: true })
    let nested: Record<string, unknown> = { leaf: true }
    for (let index = 0; index < 70; index += 1) nested = { child: nested }

    await expect(
      memory.remember({
        id: 'too-deep',
        kind: 'structured',
        content: { type: 'structured', value: nested as never },
        source: { kind: 'fixture' },
      }),
    ).rejects.toSatisfy((error: unknown) => MemoryError.is(error, 'invalid_input'))
  })
})
