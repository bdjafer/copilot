# `@astrale-os/temporal-memory`

Headless, local-first temporal memory for applications that need evidence-backed entities and
facts, maintained rule support, scoped disclosure, bitemporal views, hybrid retrieval, and browser
persistence.

Status: `0.1.0-alpha.1`. The public shape is usable for evaluation, but the package is not yet a
stable release. See the product and implementation documents for the remaining scale, migration,
and crash-recovery gates.

## Install after publication

```sh
pnpm add @astrale-os/temporal-memory
```

`@astrale-os/temporal-memory@0.1.0-alpha.1` is not yet on npm; the command above is the intended
registry surface after the release gates pass. The current package is built and packed from this
workspace and verified through the clean-consumer gate below.

The package currently pins the browser-proven candidate compatibility unit
`@astrale-os/surrealdb-wasm@3.0.4-astrale.1` + `surrealdb@2.0.8`. The adapter embeds
`surrealdb-core@3.0.5`; its exact source is fork commit
[`b049a1a`](https://github.com/astrale-os/surrealdb.js/commit/b049a1ace08147b90fb539d4681e2f22890d7eed),
derived from JavaScript SDK base `64b8f10`. The direct/worker Chromium and clean packed-consumer
gates pass, and independent branch/tag CI builds produced the same tarball and WASM bytes. The
manifest pins the versioned, checksummed
[GitHub prerelease tarball](https://github.com/astrale-os/surrealdb.js/releases/tag/surrealdb-wasm-v3.0.4-astrale.1),
not temporary local state. The package is not on npm; the official `@surrealdb/wasm` registry line
still ended at `3.0.3` when this candidate was published.

This is a mixed-license reference runtime. The Astrale JavaScript adapter is Apache-2.0, while
embedded `surrealdb-core`, `surrealdb-types`, and `surrealdb-types-derive` 3.0.5 are BSL 1.1 with a
2030-01-01 change date, and `surrealdb-protocol` 0.8.3 is BSL 1.1 with a 2029-09-17 change date.
The installed runtime is therefore not wholly open source before those dates. SurrealDB's
[official licence FAQ](https://support.surrealdb.com/en/articles/11541883-frequently-asked-questions)
says embedded application use is permitted
while offering a commercial hosted database service is restricted. The operative BSL texts and
their definition of “Database Service” control; approving that boundary remains a Temporal Memory
release decision and blocker.

## Quick start

```ts
import { createMemory } from '@astrale-os/temporal-memory'
import { createSurrealMemoryStorage } from '@astrale-os/temporal-memory/surreal'

const storage = createSurrealMemoryStorage({
  endpoint: 'indxdb://my-app-memory',
  worker: true,
})

const memory = createMemory({ spaceId: 'workspace', storage })
await memory.open({ create: true })

const ingestion = await memory.remember({
  id: 'note-1',
  kind: 'assertion',
  content: { type: 'text', text: 'Ada Lovelace designed the analytical engine.' },
  source: { kind: 'note' },
  assertions: {
    entities: [
      {
        id: 'ada',
        name: 'Ada Lovelace',
        types: ['Person'],
        mention: {
          text: 'Ada Lovelace',
          anchor: { kind: 'text', unit: 'utf16-code-unit', start: 0, end: 12 },
        },
      },
    ],
    facts: [
      {
        subject: { id: 'ada' },
        predicate: 'designed',
        object: { scalar: 'analytical engine' },
        evidence: {
          anchor: { kind: 'text', unit: 'utf16-code-unit', start: 0, end: 44 },
        },
      },
    ],
  },
}, {
  workLimits: {
    maxRecords: 100_000,
    maxBytes: 64 * 1024 * 1024,
    maxGraphNodes: 100_000,
    maxGraphEdges: 500_000,
  },
})

const context = await memory.recall({
  query: 'analytical engine',
  access: { allowedScopes: [] },
  scanLimits: { maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 },
})

console.log(context.rendered)
console.log(ingestion.work)
console.log(context.snapshotRevision, context.generatedAt, context.scan)
await memory.close()
```

The root entry is storage-neutral. Import the SurrealDB WASM adapter explicitly from `/surreal`.
`/testing` contains the deterministic in-memory adapter for tests.

Canonical ingestion does not export the memory. Identity matching, fact reconciliation, and
affected derivation truth maintenance use point reads and 16-row indexed keysets. Per-call
`IngestionOptions.workLimits` override `ingestion.workLimits` defaults; `rememberMany` applies its
batch limits independently to each episode. `IngestionReport.work` gives the exact distinct stored
rows, stable JSON bytes, dependency nodes, and edges admitted by canonical planning. Defaults are
100,000 rows, 64 MiB, 100,000 nodes, and 500,000 edges; hard maxima are 1,000,000 rows, 256 MiB,
250,000 nodes, and 1,000,000 edges.

Model-backed ingestion also accepts `contextScanLimits` at profile, per-call, and batch level.
`IngestionReport.contextScan` reports every physical canonical row and stable byte admitted while
assembling the scope-filtered provider context through 16-row keysets. Its defaults/hard maxima are
100,000/1,000,000 rows and 64/256 MiB. A breach settles at `inference_failed` before policy or
provider disclosure; the accepted episode can be retried with a different ceiling. Host-supplied
assertions and `contextLimit: 0` report zero context work.

Automatic post-canonical projections independently accept `projectionScanLimits` at the same three
levels. `IngestionReport.projectionScan` admits provenance aliases/evidence, distinct support
episodes, existing replacement rows, and generated projection rows through 16-row keysets. It uses
the same 100,000-row/64-MiB defaults and 1,000,000-row/256-MiB maxima. A breach settles the already
canonical operation `partial` at `projection_scan_failed`, commits no partial projection set, and
leaves canonical memory available for `retryEpisode()` or a bounded projection rebuild.

Provider policy receives `DisclosureRequest.sensitivities` as a sorted unique set of opaque labels,
not a guessed severity. It includes the input episode and every retained source episode behind
rendered aliases, direct fact evidence, and transitive active derivation premises. Stored
projections carry the same set, and embedding batches combine items only when both scopes and
sensitivities match exactly. A legacy projection generation without this provenance is not searched;
run a full `rebuildProjections()` to cut over atomically. Query text authored by the caller has no
memory-derived sensitivity on its own. Missing dependency provenance fails before policy/provider
invocation.

Provider payloads are also admitted before policy, and policy replacements are re-admitted before
execution. The defaults are 1 MiB of exact stable-JSON UTF-8 bytes and a conservative 262,144-token
ceiling. Supply a synchronous provider-aware counter when exact tokenizer and prompt-template
accounting is available:

```ts
const memory = createMemory({
  spaceId: 'workspace',
  storage,
  disclosureLimits: {
    maxBytes: 1024 * 1024,
    maxTokens: 128_000,
    countTokens: (request) => providerTokenizer.countRequest(request),
  },
})
```

Without `countTokens`, serialized UTF-8 bytes are used as a conservative payload-token upper bound.
The counter must include provider-owned prompt/template overhead if that overhead should share the
limit. Oversize work fails before provider execution; invalid counters fail closed.

`operationTimeoutMs` defaults to 240,000 ms. For `remember`/retry/reprocess, `recall`/`search`,
correction, and projection rebuild, the wall-clock budget starts at public-operation entry and
hard-races both disclosure-policy authorization and provider inference/embedding/reranking. A
policy or provider that ignores abort may keep doing external work, but its late result is detached
and cannot reach the next capability or mutate memory. Deadline expiry is retryable `timeout`;
caller abort is non-retryable `cancelled`.

This is deliberately not a hard database or sync-transport deadline. The facade checks its signal
between storage and peer awaits and passes it to cooperative peers, but it never detaches a storage
commit that might still take effect. Configure engine/transport timeouts at those layers and use
revision/idempotency reconciliation after an ambiguous external failure.

`MemoryError` snapshots and recursively freezes its JSON `details`, then freezes the public error
instance. Caller-owned input cannot change after construction, and one catcher cannot alter the
code, retryability, operation ID, or nested safety markers later observed elsewhere. The optional
opaque `cause` is retained by reference but is neither deep-frozen nor included by `toJSON()`.

An episode is durably accepted before canonical planning. If a work ceiling is exceeded, the report
settles at `canonical_failed` with `result_too_large`: no entity, fact, evidence, derivation,
lifecycle, projection deletion, or canonical journal change from that attempt commits, and
`retryEpisode()` can resume with a larger budget. `work` covers canonical planning, `contextScan`
covers context assembly, and `projectionScan` covers automatic projection input/output rows. None
measures provider execution, JavaScript heap, database-engine iterator work, or an in-flight
configured provider batch.

## Opening and schema migration

Opening fails closed on a canonical-schema mismatch by default. Existing schema-5 or schema-6
spaces can opt into the package's additive path explicitly:

```ts
await memory.open({ migrate: true })

const inspection = await memory.inspect()
for (const step of inspection.schemaMigrations) {
  console.log(step.fromSchemaVersion, step.toSchemaVersion, step.checksum)
}
```

The fixed `5 -> 6 -> 7` chain initializes only fields introduced by those versions. Every step and
its immutable audit record commit atomically under exact schema, logical-revision, and private
metadata-revision guards. The next open resumes at the first uncommitted step; simultaneous opens
converge on the same checkpoints. Step declarations are ordered and SHA-256 checksummed, and an
unknown, reordered, altered, newer, or unsupported history fails with `incompatible_schema`.
Migration commits do not advance the canonical memory revision or fabricate journal entries.

The additive chain has no exclusive facade owner or long-running lease. Every opener must opt in,
but any opted-in opener can help after another client wins a step or disappears. Independent
direct/direct, worker/worker, and mixed clients converge when paused before the same step; actual
owner-page termination after the atomic `5 -> 6` step leaves one valid checkpoint, and a fresh
opener resumes `6 -> 7`. This proves between-step recovery, not termination inside a database
transaction.

This does not migrate ontology meaning, rewrite canonical records, accept schema 4, or implement a
downgrade. Those transformations require a separately specified migration and remain stable-release
gates. Keep a recoverable backup before upgrading persistent application data.

## Power-user SurrealQL escape hatch

The Surreal adapter can issue a separately held, explicitly privileged admin capability for expert
queries that are not yet modeled by `Memory`. The application storage passed to `Memory` never has
a raw-query method, and the in-memory adapter cannot be elevated:

```ts
import { createMemory, MemoryError } from '@astrale-os/temporal-memory'
import {
  createSurrealMemoryCapabilities,
} from '@astrale-os/temporal-memory/surreal'

const { storage, admin } = createSurrealMemoryCapabilities(
  {
    endpoint: 'indxdb://my-app-memory',
    namespace: 'astrale',
    database: 'temporal_memory',
    worker: true,
  },
  { dangerouslyAllowRawQueries: true },
)

const memory = createMemory({ spaceId: 'workspace', storage })
await memory.open()

const response = await admin.rawQuery<
  [readonly { predicate: string; count: number }[]]
>({
  query: `
    SELECT predicate, count() AS count
    FROM tm_fact
    WHERE space_id = $space
    GROUP BY predicate
    ORDER BY count DESC
    LIMIT $limit;
  `,
  bindings: { space: memory.spaceId, limit: 100 },
  confirmNamespace: 'astrale',
  confirmDatabase: 'temporal_memory',
  maxResultBytes: 2 * 1024 * 1024,
})

for (const statement of response.statements) {
  if (!statement.success) throw new MemoryError('storage_failed', statement.error.message)
}
```

This is a trusted-host database administrator capability, not a scoped memory read. Keep `admin`
out of application/model code and pass only `storage` to `Memory`. Capability acquisition requires
an exact `dangerouslyAllowRawQueries: true` acknowledgement at paired construction time. An ordinary
storage returned by `createSurrealMemoryStorage` cannot later be elevated. The capability pair and
admin handle are frozen; admin shares its paired storage's lifecycle and bypasses `AccessContext`,
disclosure policy, canonical validation, revision CAS, semantic/signal journals, projection
invalidation, sync bookkeeping, and purge discovery. Reading package-owned `tm_*`
tables is useful for advanced analysis, but mutating them can make the `Memory` facade incoherent;
write raw data only to downstream-owned tables unless the caller deliberately assumes migration and
repair responsibility. Raw writes also bypass the facade's logical, canonical-source, and private
metadata revisions plus active projection-set references, so a host that deliberately migrates or
repairs `tm_*` MUST quiesce facade and raw writers, perform the change atomically, and run
`verifyIntegrity()` afterward; an integrity check overlapping an unrevisioned raw write has no
coherence guarantee. Every call requires the exact namespace/database confirmation and runs through
the same serialized direct/worker engine connection and, for IndexedDB, the same origin-wide Web
Lock as facade work. Bind dynamic values; never interpolate them into SurrealQL.

`rawQuery()` synchronously detaches its admitted top-level fields before scheduling storage work.
Bindings are copied and validated in one traversal under the 100,000-node, depth-64, and 4,000,000-
string-byte ceilings, so ordinary mutation or changing accessors cannot validate one value and send
another. An unreadable request or binding accessor fails with `invalid_input` before a database
call.

Statement failures are returned in-band and `rawQuery()` never retries. If the SDK call itself
fails before any statement response is available, the rejected `MemoryError` is non-retryable and
sets `{ queryOutcome: 'unknown', requiresReopen: true }`; it does not claim that a multi-statement
query rolled back. That error poisons the shared driver before queued database work can start:
subsequent admin calls, paired `Memory` work, and cached `open()` reject without touching the
database. If several facades share the storage, every reference must close; one close does not clear
the poison, and a failed early reopen does not consume another facade's reference. Only the final
physical close followed by a fresh open clears it. Reconcile downstream-owned state before any
explicit retry. The direct and worker browser harness executes the raw statement before losing its
completion signal and proves this complete shared-reference fence, including that a first observer
cannot mutate the retained error before another facade sees it; this is deterministic adapter
evidence, not a browser-process or database-worker kill.

Responses use SurrealDB's JSON representation, include each statement's success or structured
failure, a query hash, and exact canonical response bytes. Defaults are 8 MiB and 100,000 JSON nodes;
hard ceilings are 64 MiB and 1,000,000 nodes. A supplied result tuple generic is an unchecked
TypeScript assertion, is limited to `readonly JsonValue[]`, and does not add runtime schema
validation. The adapter consumes the SDK query-frame stream and
admits each scalar or row against the aggregate node and byte budgets before retaining it, so it
does not first assemble an unbounded whole result. The engine/SDK can still materialize one physical
chunk or one unusually large row before that row reaches the adapter. Potentially large work must
therefore remain natively bounded with `LIMIT` and, where supported by the statement, `TIMEOUT`.
If responses arrive but JSON validation, hashing, node admission, or exact-byte admission then
fails, the error is non-retryable and carries
`{ queryOutcome: 'responses_received', requiresReconciliation: true }`. A mutation may already be
durable. The connection remains healthy and unpoisoned so the host can issue a new bounded query to
reconcile state; never replay the original request blindly. Direct and worker tests commit a
downstream-owned row before forcing response admission to fail, then read that row through the same
connection.
Multi-statement queries are not retried; use an explicit `BEGIN TRANSACTION`/`COMMIT TRANSACTION`
block when atomicity is required. Statement failures remain in-band so partial execution is visible.
The escape hatch is one-shot SurrealQL with JSON-compatible results; it does not expose native SDK
value objects or a live-query subscription handle. The installed SDK exposes no query-cancellation
primitive, so the API does not pretend that abandoning result consumption stops engine work. Put a
native `TIMEOUT` on expensive statements. Generic resume is likewise not meaningful for arbitrary
SurrealQL: power users should write an explicit stable keyset predicate plus `LIMIT`, retain that
application cursor, and issue the next bounded query. Engine-level scripting, guest access, and
network targets remain disabled.

Evidence anchors are checked against immutable accepted content. Text and message episodes use
JavaScript UTF-16 code-unit ranges; structured and event episodes use RFC 6901 JSON Pointers into
`content.value`. An optional excerpt must match the resolved source exactly. If neither anchor nor
excerpt is supplied, the package records a broad whole-episode anchor; it never treats free-form
provider prose as a quote. Recall citations return every selected evidence occurrence and anchor.

```ts
await memory.remember({
  kind: 'assertion',
  content: { type: 'structured', value: { person: { name: 'Ada Lovelace' } } },
  source: { kind: 'record' },
  assertions: {
    entities: [
      {
        id: 'ada',
        name: 'Ada Lovelace',
        mention: {
          text: 'Ada Lovelace',
          anchor: { kind: 'json-pointer', pointer: '/person/name' },
        },
      },
    ],
  },
})
```

The browser gate and packed-consumer proof use Vite 8. As required by the SurrealDB WASM engine,
exclude the engine package from Vite dependency optimization:

```ts
import { defineConfig } from 'vite'

export default defineConfig({
  optimizeDeps: { exclude: ['@astrale-os/surrealdb-wasm'] },
})
```

## Scopes and temporal views

Every read supplies an `AccessContext`. A record is visible only when all of its required scopes
are present in `allowedScopes`. Entity names, types, aliases, and identifiers retain the scoped,
episode-level assertion that introduced them; a restricted enrichment cannot widen a public view
or public search projection.

```ts
const history = await memory.recall({
  anchors: { factIds: ['fact-id'] },
  access: { allowedScopes: ['team'] },
  view: { kind: 'known-at', at: '2026-08-01T00:00:00.000Z' },
})
```

Supported views are `current`, `valid-at`, `known-at`, and `history`. Retraction and soft deletion
preserve provenance; hard purge physically removes it.

Hard purge binds each operation id to the normalized request and rejects reuse. It also removes
projections reached through purged episode evidence, mentions, and alias provenance, even when a
shared canonical entity or fact survives. Caller-supplied operation ids are retained as operational
lineage and must be opaque, non-sensitive identifiers; never encode episode content or target ids in
them.

`AccessContext` is a defense-in-depth data filter, not authentication. The host must derive it from
an authenticated principal and must not let an untrusted caller choose arbitrary allowed scopes.

Construction has the same ownership rule as method calls. `createMemory(options)` accepts a closed
root object and reads each declared property once. It immediately validates and detaches `spaceId`,
ontology, disclosure-limit scalars, ingestion/retrieval profiles, and timeout, so unsupported fields,
unreadable accessors, or later mutation cannot reconfigure the facade. Storage, providers, policy,
clock, id factory, token counter, and error callback are deliberately captured as live capabilities;
the package retains those exact references without rereading their caller-owned container.

## Select, snapshot, and analyze

Recall, search, and neighborhood expose `snapshotRevision` and `generatedAt` and fail with a
retryable `conflict` if the space incarnation or revision changes while their multi-query read,
provider-backed ranking, and rendering are in flight. Management reads use the same optimistic
revision bracket. This is fail-closed consistency, not a database-native snapshot transaction.
`read`, `recall`, `search`, `neighborhood`, `browse`, `snapshot`, `analyze`, `changes`,
`signalChanges`, and `export` also detach their complete closed JSON request before purge
coordination, hashing, storage, or provider work. The common envelope ceiling is 1,000,000 nodes,
depth 64, and 64 MiB of aggregate strings; method-specific limits remain tighter. Immediate caller
or accessor mutation cannot broaden access, replace filters/anchors/seeds/IDs/cursors, or relax
budgets. Unknown fields, cycles, non-plain objects, malformed JSON, and unreadable accessors fail
before asynchronous work. `ReadOptions.signal` is copied separately and remains live.
Checked point reads bracket their complete visible evidence assembly and return the requested value,
revision/time lineage, and exact admitted physical work:

```ts
const point = await memory.read({
  kind: 'entity',
  id: 'entity:ada',
  access: { allowedScopes: ['team'] },
  scanLimits: { maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 },
})

const ada = await memory.getEntity(
  'entity:ada',
  { allowedScopes: ['team'] },
  { scanLimits: { maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 } },
)
```

`read` supports `episode`, `entity`, `fact`, and `derivation`. Entity and fact provenance advances
through 16-row relation keysets and point-loads distinct support episodes. Defaults are 100,000
rows/64 MiB and hard maxima are 1,000,000 rows/256 MiB. Exceeding either exact row/byte ceiling fails
with `point_read_scan` and no partial value. The `get*` methods are value-only convenience sugar over
the same bounded implementation; use `snapshot()` for a reusable complete reasoning baseline.
`stats()` returns `snapshotRevision`/`generatedAt` plus the exact residual `scan` work, and
`inspect()` reports the same physical-work envelope. `verifyIntegrity()` returns
`snapshotRevision`/`checkedAt`. Statistics, open-space inspection, and integrity verification
additionally bracket their metadata-sensitive scans with a private monotonic metadata generation.
Every facade storage commit advances that generation, including metadata-only
checkpoint/session/compaction work; a concurrent change therefore fails with retryable `conflict`
even when the public logical `snapshotRevision` is unchanged. The private generation is not a
change-feed cursor or public memory revision.

Integrity verification is a trusted whole-space diagnostic, so it intentionally has no
`AccessContext`. It no longer calls whole-space export: every canonical, journal, projection,
operation, purge, signal, and sync row is admitted through advancing 16-row keysets, with potentially
16 MiB sync chunks scanned one physical row at a time.

```ts
const integrity = await memory.verifyIntegrity({
  limits: {
    maxRecords: 250_000,
    maxBytes: 128 * 1024 * 1024,
    maxGraphNodes: 100_000,
    maxGraphEdges: 500_000,
    maxIssues: 500,
  },
})

if (!integrity.ok) {
  console.error(integrity.work.issuesDetected, integrity.issues)
  if (integrity.work.issuesTruncated) console.error('additional issue details omitted')
}
```

Defaults are 100,000 rows, 64 MiB of stable UTF-8 JSON, 100,000 active-derivation graph nodes,
500,000 graph edges, and 1,000 retained issue details. Hard maxima are 1,000,000 rows, 256 MiB,
250,000 nodes, 1,000,000 edges, and 10,000 details. `maxIssues: 0` runs a summary-only check:
validation still continues, `work.issuesDetected` remains complete, and `ok` still reflects omitted
errors. Row, byte, and graph breaches fail with `result_too_large` and exact
`{ phase: 'integrity', dimension, required, maximum }` details. `work` reports the admitted totals
and effective limits. These are cumulative facade bounds, not JavaScript heap, database-work, or
latency guarantees; the complete check remains O(n), and one bounded storage page materializes
before admission. The report has no separate exact response-byte cap.

```ts
const managementLimits = { maxRecords: 250_000, maxBytes: 128 * 1024 * 1024 }
const stats = await memory.stats({ scanLimits: managementLimits, signal })
const inspection = await memory.inspect({ scanLimits: managementLimits, signal })

console.log(stats.scan, inspection.scan)
```

`stats()` pushes simple cardinalities into the storage adapter; SurrealDB executes them as native
`count()` aggregates with bound filters. Those native aggregate counts do not transfer individual
rows and are therefore excluded from `scan`. Metrics that require latest-per-logical-key selection,
distinct conflict groups, stale-set classification, or provider-call summation admit every
transferred stable-JSON row and byte before use, through keyset pages of at most 1,000 records.
`inspect()` likewise uses a native pending-operation count and admits every stale-projection row.
Defaults are 100,000 rows/64 MiB and hard maxima are 1,000,000 rows/256 MiB. A breach fails without
partial metrics as `result_too_large`, with exact `stats_scan` or `inspection_scan` details.

Both calls accept cancellation. Inspection of a closed facade returns a zero-work closed report;
inspection of an open facade resolves the current persisted space incarnation and fails with
retryable `conflict` plus `requiresReopen: true` after another facade resets and recreates that
space. Neither call falls back to whole-space export. The reported stable bytes are caller-visible
transfer bounds, not a claim about native aggregate work, JavaScript heap, database scan latency, or
end-to-end latency; residual scans remain O(n), and mixed ascending/descending latest-version scans
can use the IndexedDB table iterator.

Browse cursors bind the space incarnation, normalized access scopes, canonical kind/order/view/
filter/conflict request, revision, first-page evaluation time, and boundary record. Page size may
change; access, request, reset, or revision drift may not. Clock passage therefore cannot change a
current-view result halfway through pagination.

For current, valid-at, and history episode browse without metadata equality filters, access,
source, retention/sensitivity, tag, and time predicates plus the `limit + 1` keyset page execute in
storage for all three orders. Known-at episodes and entity/fact pages retain their graph/lifecycle
assembly path, but that path now reads canonical kinds through advancing 16-row keysets under the
same explicit physical scan contract as recall. Descending IndexedDB pages currently use a Surreal
table iterator, so bounded transferred rows are not a database-scan latency claim.
Opaque string keys use deterministic Unicode scalar-value ordering in both adapters, matching
SurrealDB's default order rather than the host's ambient locale. Unpaired UTF-16 surrogates in any
validated string or JSON key are rejected before hashing or persistence.

An open memory handle is generation-bound. After another context resets and recreates its
`spaceId`, the stale handle returns `conflict` with `details.requiresReopen: true`; explicitly close
and reopen it before accessing the replacement.

```ts
const page = await memory.browse({
  kind: 'fact',
  access: { allowedScopes: ['team'] },
  filters: {
    episodes: { source: { kinds: ['copilot.thread'] } },
    facts: {
      predicates: ['session_state'],
      objects: [{ kind: 'scalar', value: 'open' }],
    },
  },
  order: 'newest',
  limit: 50,
  scanLimits: { maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 },
})

const snapshot = await memory.snapshot({
  access: { allowedScopes: ['team'] },
  maxRecords: 50_000,
  scanLimits: { maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 },
})

const analysis = await memory.analyze({
  access: { allowedScopes: ['team'] },
  top: 20,
  pagerank: {
    seeds: [
      { id: 'ongoing-thread', weight: 3 },
      { id: 'active-project', weight: 1 },
    ],
  },
  budgets: {
    maxScannedRecords: 100_000,
    maxScannedBytes: 64 * 1024 * 1024,
    maxAnalyzedRecords: 1_000_000,
    maxGraphNodes: 100_000,
    maxGraphEdges: 500_000,
    maxPageRankSteps: 50_000_000,
    maxTemporalComparisons: 1_000_000,
  },
})
```

Filters are nested by `episodes`, `entities`, and `facts`; filtering happens before pagination.
Recall, search context, neighborhood, and every browse page return `scan` with admitted physical
rows, exact stable-JSON row bytes, and effective limits. Their `scanLimits` default to 100,000 rows
and 64 MiB and have hard maxima of 1,000,000 rows and 256 MiB. Recall and residual browse advance
through 16-row canonical keysets; BM25/vector projection candidates are also admitted and their
query limits are clamped to the remaining row budget plus one. Native episode browse admits its
cursor boundary and at most `limit + 1` candidates. A breach is `result_too_large` with
`phase: 'recall_scan'` or `'browse_scan'`, the exact `dimension`, `required`, and `maximum`; a
partial context or page is never returned. Access and safe episode/evidence predicates are pushed
down and still rechecked. Graph expansion builds fact adjacency and episode-to-entity indexes once,
so it is linear in the admitted visible graph rather than repeatedly rescanning every fact and
evidence link.

These limits bound cumulative rows transferred into and retained by the facade, not JavaScript heap
bytes, IndexedDB work, or latency. One 16-row canonical page and one bounded native search result can
be materialized before admission rejects a row. Residual browse still assembles the complete
eligible universe before slicing the requested page, but that universe is now caller-bounded and
observable rather than unbounded.

`snapshot` returns a complete detached visible temporal graph, ontology, raw evidence and derivation
relations, mentions, and target-scoped lifecycle at one checked revision. It pages physical storage
in 16-row keysets under independent row/exact-stable-JSON-byte `scanLimits` and reports that work in
`snapshot.scan`. It fails on concurrent mutation, scan admission, or when `maxRecords` would be
exceeded, so downstream graph or rule algorithms never mistake a silent partial result for the
whole selection.

Analysis reports visible counts, source and predicate distributions, source and derivation
corroboration, derived-only facts, temporal overlaps, components, relation-edge and unique directed
arc counts, bounded adjacency density, degree, and deterministic PageRank. Parallel fact edges remain
distinct PageRank links; density is unique directed arcs divided by `nodes²`, including possible
self-arcs, so it remains in `[0,1]`. Optional weighted entity seeds switch to deterministic
`personalized-pagerank-v1`, which
is useful for session-relative salience, peripheral context, or downstream `dream()` analysis while
remaining a read-only structural score. Seeds must be unique visible nodes and cannot widen the
selected access/filter universe. These metrics are never truth confidence, source authority, or
permission to mutate data. Findings carry record, evidence, and derivation IDs so a host can inspect
the basis. The report also counts current visible signals by active/expired/withdrawn state and
namespace; those diagnostics do not affect the graph algorithm.

`top` defaults to 20 and independently caps both `graph.topEntities` and the returned `findings`
sample at 1..100 items. Findings are deterministic and severity-first: warnings precede
informational diagnostics, followed by Unicode-scalar code/item/evidence ordering.
`findingSummary` retains complete counts by code plus `total`, `returned`, and `truncated`, so a
small sample never masquerades as the complete diagnostic population. Report aggregation keeps only
the bounded top sets, computes timestamp extrema in one pass, and indexes active derivation
conclusions instead of rescanning every derivation for every fact.

Analysis pages canonical storage through advancing 16-row keysets. Its first admission boundary is
100,000 physical rows and 64 MiB of exact stable-JSON row bytes by default, with hard caps of
1 million rows and 256 MiB. Every returned row counts even when later removed by access, temporal,
latest-revision, or graph filtering. Scope and other safe filters are still pushed down. The report
then admits visible records consumed by the report, graph nodes, entity-valued edges, worst-case
PageRank steps, and cardinality-one temporal comparisons under separate budgets. Their defaults are
1 million analyzed records, 100,000 nodes, 500,000 edges, 50 million PageRank steps, and 1 million
temporal comparisons; hard caps are 5 million, 250,000, 1 million, 250 million, and 10 million.
The report returns actual scan and algorithm work plus effective limits. Exceeding a ceiling is
`result_too_large`, never a partial report, and a concurrent write fails the final stable-read check
with retryable `conflict`. Scan bytes bound canonical transfer/admission, not JavaScript heap bytes
or database latency; at most one 16-row page is in flight before admission.

## Signals for clusters, salience, and `dream()`

Signals are durable non-epistemic annotations for downstream algorithms and host observations. They
can represent cluster membership, salience, reinforcement/weakening recommendations, peripheral
state, or any other JSON value without pretending that the value is evidence or factual truth.

```ts
const baseline = await memory.snapshot({ access: { allowedScopes: ['team'] } })

const signalWrite = await memory.putSignals({
  access: { allowedScopes: ['team'] },
  expectedRevision: baseline.snapshotRevision,
  basisScanLimits: { maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 },
  signals: [
    {
      namespace: 'dream.cluster',
      slot: 'membership',
      target: { kind: 'episode', id: 'thread-42' },
      producer: { kind: 'algorithm', id: 'louvain', version: '2.1.0' },
      scopes: ['team'],
      tags: ['cluster:ongoing-work'],
      basis: { episodeIds: ['thread-42', 'thread-43'] },
      value: { cluster: 'ongoing-work', confidence: 0.84 },
      expiresAt: '2026-08-10T00:00:00.000Z',
    },
  ],
})
console.log(signalWrite.basisScan)

const signalWhere = {
  namespaces: ['dream.cluster'],
  tags: { all: ['cluster:ongoing-work'] },
  recordedAt: { until: '2026-08-05T00:00:00.000Z' },
} as const

const preview = await memory.browseSignals({
  access: { allowedScopes: ['team'] },
  where: signalWhere,
})

await memory.deleteSignals({
  access: { allowedScopes: ['team'] },
  mode: 'withdraw',
  where: signalWhere,
  expectedRevision: preview.snapshotRevision,
  maxMatches: preview.total,
  reason: 'cluster recomputed',
})
```

For an explicitly authorized forgetting action, the same grouping API can preview the complete
current signal set and hand an exact selection cursor to soft deletion or hard purge. The cursor
hashes every matching signal revision, not only the returned page. Choose one action; re-preview
after any mutation.

```ts
const targetPreview = await memory.browseSignals({
  access: { allowedScopes: ['team'] },
  where: signalWhere,
  limit: 50,
})

if (targetPreview.targetSelectionCursor !== undefined && targetPreview.total > 0) {
  await memory.deleteEpisodes({
    access: { allowedScopes: ['team'] },
    signalTargets: {
      where: signalWhere,
      selectionCursor: targetPreview.targetSelectionCursor,
    },
    maxMatches: targetPreview.total,
    workLimits: {
      maxRecords: 25_000,
      maxBytes: 32 * 1_024 * 1_024,
      maxGraphNodes: 25_000,
      maxGraphEdges: 100_000,
    },
  })
}
```

`deleteEpisodes.signalTargets` accepts episode targets only. It soft-deletes their canonical
episodes and atomically appends withdrawn revisions for every selected signal; the semantic and
signal journal rows remain separate but share the commit revision. To erase instead, pass the same
shape to `hardPurge`, which accepts episode, entity, and fact targets and purges only their declared
canonical `target`, never the opaque value or basis.

The cursor is minted only for a non-empty constrained current, active, non-expired selector. Both
actions recheck filter, access, space generation, preview revision, and the complete signal-ID set.
Soft deletion evaluates expiry at the cursor's frozen preview instant, so elapsed wall time alone
cannot change an already authorized selection; hard purge deliberately re-evaluates expiry at action
time and requires a new preview after expiry drift. The caller still makes the deletion/erasure
decision; signal values are not commands. The opaque cursor is a consistency token, not an
authorization credential; the host must keep these governance calls behind its trusted
administrative boundary.

Every write is an exact-revision CAS against the graph snapshot it analyzed. Algorithm producers
must declare at least one basis ID. The package verifies that the target and every declared basis
record exist and are visible in the selected temporal view, and that signal scopes include all
episode/fact dependency scopes. Every entity target or entity basis ID additionally requires a
declared basis episode or fact that is actually connected to it. This prevents a private entity-only
inference from being written into a less-restricted signal. Tags are normalized indexable grouping
labels and may change on a new revision without changing the logical signal identity.

That temporal-basis check is semantically complete but storage-sparse. It loads only the addressed
episodes, entities, and facts plus the lifecycle, support, active-merge component, incident facts,
aliases, and mentions needed to decide them; unrelated records are not enumerated. Scalar predicates
are chunked to 1,000 values and every query advances in at most 16-row ID keysets under
`basisScanLimits`, which defaults to 100,000 rows/64 MiB and caps at 1,000,000 rows/256 MiB.
`PutSignalsReport.basisScan` returns the exact rows/stable-JSON bytes returned by those queries,
including a row reached through two distinct provenance predicates. A breach reports
`phase: 'signal_basis_scan'` before any signal or journal mutation. Work is proportional to the
addressed merge/support/incident-fact closure, so a high-degree record can still reach the explicit
ceiling; stable JSON bytes are not a heap or database-latency measure.

Every `browseSignals`, `putSignals`, and `deleteSignals` request is copied and validated once before
the first asynchronous read or queued write. The closed envelope admits at most 1,000,000 JSON
nodes, depth 64, and 64 MiB of aggregate string data; per-operation signal, membership, page, and
work limits remain tighter. Later caller or accessor mutation cannot retarget access, filters,
identity, basis, values, revision, or destructive mode. Cycles, non-plain objects, unknown or
unsupported fields, malformed JSON, and unreadable accessors fail with `invalid_input` before
storage work. `ReadOptions.signal` remains a separately referenced live cancellation capability.

Logical signals have immutable revisions. Current browse selects the globally latest revision for
each key before access and filter evaluation, so a caller never falls back to an older revision.
Expired active signals are hidden by default; `includeExpired` and `revisionView: 'history'` expose
explicit management views. Cursors bind the request, access partition, space generation, evaluated
time, and exact revision. Selector-based withdrawal adds tombstone revisions; purge removes every
revision of each selected key. Both require a non-empty selector, exact preview revision, and
`maxMatches` guard. Purge additionally accepts `maxRevisions` (default `10,000`, maximum `100,000`)
and fails before mutation if retained history exceeds it.

Current/history browse and logical-key selection advance through 16-record `(key, version, id)`
keyset pages. Access plus immutable logical-identity filters are pushed into storage; the facade
retains only lightweight ordering metadata for at most `limit` results, fetches returned values one
at a time, and reports exact canonical `byteLength`. `maxBytes` defaults to 16 MiB and accepts at
most 64 MiB; the first non-fitting signal fails with `result_too_large`, while a later boundary emits
a cursor rather than skipping the record. Exact `total` still requires an O(n) scan. Mixed-direction
IndexedDB pages currently use the Surreal table iterator, so this is a transfer/facade-memory bound,
not a database-scan latency SLO. Page size and `maxBytes` may change between cursor calls.

The non-empty full-set signal-target commitment is version 2 and folds IDs in fixed 1,000-ID chunks
under a domain-separated SHA-256 chain, so its memory does not grow with the selection. Empty
selections expose no destructive cursor. A version-1 preview token fails closed with
`requiresSignalBaseline`; take a fresh constrained browse. `putSignals`
scans prior history only for its at-most-1,000 addressed logical keys. `deleteSignals({ mode:
'purge' })` natively counts all retained revisions under `maxRevisions`, then performs one atomic
key-range deletion instead of assembling a per-revision delete list.

One `putSignals` call accepts at most 1,000 signals. JSON values use the package's node, depth, and
UTF-8 budgets individually and across the complete write; the complete write also caps presented
scope, tag, and basis entries before deduplication. These limits reject batch amplification before
the graph is read or a transaction begins.

Signal writes advance the physical space revision but deliberately emit no semantic `changes`
record and never alter recall scores, facts, evidence, or support. They do atomically emit a
separate, non-epistemic `signalChanges` row. `browseSignals` returns the cursor needed to hand its
checked baseline to that feed:

```ts
const baseline = await memory.browseSignals({
  access: { allowedScopes: ['team'] },
  revisionView: 'current',
})

let cursor = baseline.signalChangesCursor
const delta = await memory.signalChanges({
  access: { allowedScopes: ['team'] },
  cursor,
  limit: 100,
})
cursor = delta.nextCursor
```

Each delta identifies a `put`, `withdraw`, or `purge` and partitions affected logical keys/targets
by their exact required scopes. The cursor binds the space incarnation, normalized access, and last
scanned physical revision. This permits independent restart-safe consumers without turning a
signal into canonical knowledge. A page may be empty after access filtering; continue while
`hasMore` is true.

A canonical hard purge deletes the complete history of any signal whose declared target or basis
references purged data. It also scrubs affected keys and targets from older signal-journal rows and
emits content-free scope invalidations. Consumers seeing `invalidated: true` must rebuild that
visible partition from `browseSignals`; forgotten identifiers are not recoverable from the feed.
That closure can inspect only declared fields: do not hide memory IDs, private content, or
dependencies inside opaque values, namespaces, slots, tags, or producer IDs and expect purge to
discover them.

For a durable local consumer, register its baseline once, then acknowledge only after downstream
effects and the returned cursor are durable:

```ts
await memory.registerJournalConsumer({
  id: 'peripheral-indexer',
  journal: 'signal',
  cursor: baseline.signalChangesCursor,
})

const delta = await memory.signalChanges({
  access,
  cursor: baseline.signalChangesCursor,
})

// Persist downstream effects first.
await memory.acknowledgeJournalConsumer({
  id: 'peripheral-indexer',
  journal: 'signal',
  cursor: delta.nextCursor,
})
```

The package can then compact from every active registered consumer without the host enumerating or
decoding cursors:

```ts
await memory.compactSignalChanges({
  confirmSpaceId: 'workspace',
  registeredConsumers: true,
  expectedRevision: currentRevision,
  maxChanges: 1_000,
})
```

Compaction is revision-bound, bounded, dry-runnable, and advances a durable monotonic floor. A
cursor behind the floor fails with `requiresSignalBaseline`; take a fresh `browseSignals` baseline.
Registry mode derives the minimum cursor across all active local records and guards its commit with
the registry epoch, so concurrent registration, acknowledgement, or retirement makes the plan fail
retryably. The stateless `consumerCursors` mode still accepts `1..1,000` feed-specific,
generation-bound cursors for externally managed checkpoints. The expert `throughRevision` override
is mutually exclusive with both safe modes.

Consumer acknowledgements are monotonic and cannot switch access partitions. `journalConsumers`
pages at most 100 records from one metadata revision. `retireJournalConsumer` is explicit and
idempotent; retired consumers stop holding the floor but remain tombstones and their identifiers
cannot be reused. Each journal admits at most 1,000 active plus retired records. Registry state is
local operational metadata: canonical archives and replica sync omit it, while reset removes it.
There is intentionally no lease timeout or automatic retirement that could discard history merely
because an offline consumer was slow. There is also no built-in `dream()` algorithm, expiry
scheduler, automatic action loop, non-erasure entity/fact action, or retrieval-scoring plug-in.
Exact episode-target soft deletion is available only through an explicit
`deleteEpisodes.signalTargets` call.

## Maintained derivations for rule engines

`deriveFact` records one canonical rule support over an exact set of current fact or evidence
premises. `deriveFacts` atomically applies one to 64 independent conclusions at the same checked
revision. The package validates every conclusion against the ontology, computes its disclosure scope
as the union of every premise scope, rejects positive fact-dependency cycles, and commits the facts
and derivations in one revision-CAS mutation.

```ts
const basis = await memory.snapshot({ access: { allowedScopes: ['team'] } })

const derived = await memory.deriveFact({
  conclusion: {
    id: 'thread-42-open',
    subjectId: 'thread-42',
    predicate: 'session_state',
    object: { kind: 'scalar', value: 'open' },
  },
  rule: { id: 'copilot/open-thread', version: '2' },
  premises: [
    { kind: 'fact', id: 'thread-42-started' },
    { kind: 'fact', id: 'thread-42-not-closed' },
  ],
  access: { allowedScopes: ['team'] },
  expectedRevision: basis.snapshotRevision,
  workLimits: {
    maxRecords: 25_000,
    maxBytes: 32 * 1_024 * 1_024,
    maxGraphNodes: 25_000,
    maxGraphEdges: 100_000,
  },
})

await memory.getDerivation(derived.derivation.id, { allowedScopes: ['team'] })
console.log(derived.work)

const activation = await memory.deriveFacts({
  derivations: [
    {
      conclusion: {
        subjectId: 'thread-42',
        predicate: 'needs_attention',
        object: { kind: 'scalar', value: true },
      },
      rule: { id: 'copilot/stale-open-thread', version: '3' },
      premises: [{ kind: 'fact', id: 'thread-42-open' }],
    },
    {
      conclusion: {
        subjectId: 'thread-42',
        predicate: 'peripheral_vision',
        object: { kind: 'scalar', value: 'active' },
      },
      rule: { id: 'copilot/stale-open-thread', version: '3' },
      premises: [{ kind: 'fact', id: 'thread-42-open' }],
    },
  ],
  access: { allowedScopes: ['team'] },
  expectedRevision: (await memory.stats()).snapshotRevision,
  workLimits: {
    maxRecords: 25_000,
    maxBytes: 32 * 1_024 * 1_024,
    maxGraphNodes: 25_000,
    maxGraphEdges: 100_000,
  },
})
console.log(activation.results, activation.work)

const retirementWhere = {
  ruleIds: ['copilot/stale-open-thread'],
  ruleVersions: ['3'],
} as const
const retirementPreview = await memory.previewDerivationWithdrawals({
  where: retirementWhere,
  access: { allowedScopes: ['team'] },
  maxMatches: 64,
})
if (retirementPreview.selectionCursor === undefined) throw new Error('nothing to retire')
console.log(retirementPreview.derivations, retirementPreview.work)

const retirement = await memory.withdrawDerivations(
  {
    where: retirementWhere,
    access: { allowedScopes: ['team'] },
    expectedRevision: retirementPreview.snapshotRevision,
    maxMatches: 64,
    selectionCursor: retirementPreview.selectionCursor,
    reason: 'Rule version 3 was replaced.',
    workLimits: {
      maxRecords: 25_000,
      maxBytes: 32 * 1_024 * 1_024,
      maxGraphNodes: 25_000,
      maxGraphEdges: 100_000,
    },
  },
  { operationId: 'retire-copilot-stale-open-thread-v3' },
)
console.log(retirement.withdrawals, retirement.unsupportedFacts, retirement.work)

const corrected = await memory.correctFact({
  factId: 'thread-42-not-closed',
  replacement: {
    id: 'thread-42-closed',
    subject: { id: 'thread-42' },
    predicate: 'session_state',
    object: { scalar: 'closed' },
  },
  access: { allowedScopes: ['team'] },
  workLimits: {
    maxRecords: 25_000,
    maxBytes: 32 * 1_024 * 1_024,
    maxGraphNodes: 25_000,
    maxGraphEdges: 100_000,
  },
})
console.log(corrected.work)

const retracted = await memory.retractFact({
  factId: 'thread-42-started',
  allSupport: true,
  access: { allowedScopes: ['team'] },
  workLimits: {
    maxRecords: 25_000,
    maxBytes: 32 * 1_024 * 1_024,
    maxGraphNodes: 25_000,
    maxGraphEdges: 100_000,
  },
})
console.log(retracted.work)
```

Derivations are immutable revisions and canonical support, but never source evidence or authority
scores. A fact remains current while any active source evidence or derivation supports it. Evidence
withdrawal, fact retraction, episode deletion, and hard purge invalidate affected derivations and
retract unsupported conclusions recursively to a fixpoint in the same mutation. Independent
support keeps a conclusion active. Retire a still-valid rule support explicitly with
`withdrawDerivation`, using its current revision as `expectedRevision`. Retire a rule version or
another bounded support set atomically with `withdrawDerivations`. Its non-empty selector can
intersect current derivation IDs, rule IDs, rule versions, conclusion fact IDs, and a half-open
recorded-time interval. `maxMatches` is an explicit 1..1,000 breadth guard; named IDs are strict, so
one missing, hidden, historical, or otherwise non-matching ID rejects the whole request. The method
appends every withdrawal successor, computes one aggregate truth-maintenance fixpoint, invalidates
affected projections, and emits one semantic change in a single revision-CAS commit. An empty
selection is `not_found`, never a successful no-op.

`previewDerivationWithdrawals` uses the same selector planner without mutation. It returns the
complete deterministic current support set, snapshot revision, evaluation time, and exact admitted
work. A non-empty preview also returns `selectionCursor`, an opaque token binding space incarnation,
access partition, selector, revision, and the exact support-ID digest. Passing it to apply detects
selector/access/reset/set drift before truth maintenance. Empty general selections return no cursor;
incomplete explicit IDs, breadth/work breaches, stale requested revisions, and concurrent writes
fail without partial output. Repeating an unchanged preview produces the same cursor. The token is a
consistency commitment, not authorization or authentication. Hosts that already authorized the
selector from another checked read may omit it and retain the same revision-CAS atomicity. Hard purge also removes the
contaminated derivation's stored replay payload while retaining a content-free operation tombstone,
so its operation ID cannot recreate erased lineage.

Direct single/batch derive, single/batch withdrawal, fact correction, fact-support retraction, and single/group episode soft
deletion are sparse, indexed operations: they use point reads and 16-row keyset pages over the
SurrealDB support, semantic-key, logical-key, conclusion, premise-array, episode/provenance, signal,
and evidence indexes. They never export the whole memory.
`workLimits` can lower the default row, stored-JSON-byte, graph-node, and graph-edge ceilings;
exceeding one fails with `result_too_large` before mutation. Derivation, correction, and retraction
reports return the exact admitted work for visibility, dependency, and affected-projection planning.
A final revision check plus commit CAS prevents a concurrent facade from leaving partial evidence,
conclusion, or support closure. A correction retry rereads and reauthorizes every direct support row;
support that became hidden during a lost revision race makes the retry fail closed.

Across independent same-origin clients, distinct operation IDs evaluating one new logical derivation
at the same revision have one canonical winner and one retryable, residue-free loser. Replaying the
winner's bound ID from the other client returns the stored report without advancing revision. The
losing ID remains unbound: only after the host re-evaluates at the winner's revision may it be reused;
if support is already active, that retry records `supported` without another derivation or semantic
change. Two clients withdrawing the same active support likewise produce one tombstone and one
retryable loser. Recursive truth maintenance, fact retraction, projection invalidation, operation,
and semantic change remain one commit. The browser matrix proves this with a two-level conclusion
chain across direct/direct, worker/worker, and mixed engines. The same matrix races two complete
two-conclusion batches: exactly one batch operation, two supports, and one semantic change win; the
loser leaves no fact, derivation, operation, or journal residue. Explicit loser re-evaluation returns
two `supported` results without duplicating support or semantic change. The same matrix races two
complete selector-based withdrawals: one client appends both tombstones and retracts both unsupported
conclusions atomically, while the other remains unbound and residue-free. Winner replay is exact;
after the winner retires the complete set, re-evaluating the loser selector returns `not_found`
instead of manufacturing an idempotent success.

Batch members are deliberately snapshot-independent: a conclusion created or reactivated by one
member cannot satisfy another member's premise in the same request. Duplicate semantic conclusions,
duplicate conclusion IDs, ambiguous cardinality-one partitions, and cycles in the combined planned
edge set reject the whole batch. Results preserve input order, while `work` is one aggregate budget.
This makes `deriveFacts` a safe multi-head rule-activation primitive, not an order-sensitive hidden
rule scheduler.

Rule evaluation remains downstream: consume `changes`, compute against a checked `snapshot`, then
call `deriveFact`/`deriveFacts` to activate support or `withdrawDerivation`/`withdrawDerivations` to
retire it. This keeps Datalog, ontology reasoners, temporal rule engines, and
a downstream `dream()` loop replaceable while giving them durable premise identity and truth
maintenance. The alpha supports positive single- and bounded multi-conclusion activations over the
current canonical view; it does not execute rules or implement negation, aggregation, existential
identity creation, iterative fixpoints, or a first-class temporal applicability basis.

## Bounded identity reconciliation

`mergeEntities` records a reversible current redirect without destroying either identity. Both
merge and `splitEntityMerge` accept the same caller-lowerable `workLimits` used by maintained
derivations and return an `EntityMergeReport` whose `work` is the exact admitted planning set:

```ts
const merged = await memory.mergeEntities({
  targetId: 'canonical-person',
  sourceIds: ['duplicate-person'],
  reason: 'confirmed duplicate',
  access: { allowedScopes: ['team'] },
  workLimits: {
    maxRecords: 25_000,
    maxBytes: 32 * 1_024 * 1_024,
    maxGraphNodes: 25_000,
    maxGraphEdges: 100_000,
  },
})

const split = await memory.splitEntityMerge({
  mergeId: merged.operation.id.replace(/^op_/, 'merge_'),
  reason: 'identity review reversed the decision',
  access: { allowedScopes: ['team'] },
  workLimits: merged.work.limits,
})
console.log(merged.work, split.work)
```

Planning point-loads the selected entities and reads only their aliases, alias episodes, entity
provenance, subject/object facts, related fact provenance, and affected projections through 16-row
indexed keysets. Internal set predicates are split into fixed 1,000-ID queries. It never exports the
whole memory. The caller must be able to see each identity and must have authority over every alias,
entity provenance row, and related fact provenance row; otherwise the operation fails closed before
mutation. A work-limit breach or revision/generation race leaves merge history, entities,
projections, lifecycle, operation, and change journal untouched. The redirect or reversal then
commits atomically under the exact revision used for planning. Split only reverses the named active
merge; it is not arbitrary semantic partitioning.

## Incremental semantic changes

`changes` is the durable restart-safe input for downstream graph algorithms, rule engines, caches,
and indexers. It emits one package-level record for each committed semantic revision, partitioned by
the exact scopes of its affected episode, entity, and fact IDs. It never exposes SurrealDB tables,
payload diffs, projections, or maintenance churn.

For a new consumer, take one complete snapshot and persist its `changesCursor`; subsequent reads
start strictly after that checked snapshot revision:

```ts
const baseline = await memory.snapshot({ access: { allowedScopes: ['team'] } })
let cursor = baseline.changesCursor
```

```ts
do {
  const page = await memory.changes({
    access: { allowedScopes: ['team'] },
    cursor,
    limit: 100,
  })

  for (const change of page.changes) {
    for (const partition of change.partitions) {
      if (partition.invalidated === true) {
        // Hard purge concealed erased IDs: rebuild this visible scope partition from snapshot().
        continue
      }
      console.log(change.revision, change.phase, partition.affected)
    }
  }

  cursor = page.nextCursor
  if (!page.hasMore) break
} while (true)
```

The opaque, feed-discriminated v2 cursor binds the space incarnation, exact normalized
`allowedScopes`, and last scanned revision. A signal-feed cursor is rejected rather than being
mistaken for a semantic acknowledgement. Reusing a cursor with different access or after
reset/recreate fails with `conflict` and
`details.requiresSnapshot: true`. `limit` bounds semantic revisions scanned before scope filtering,
so a page may contain no visible changes while `hasMore` remains true. Continue until `hasMore` is
false; then `throughRevision === currentRevision` and the cursor is caught up. Legacy v1 feed
cursors were not discriminated and are intentionally rejected; take a fresh `snapshot` or
`browseSignals` baseline after upgrading this alpha.

The scan is revision-bracketed. A concurrent write returns a retryable `conflict`; retry the same
request/cursor rather than applying a potentially stale page.

Accepted episodes, canonical integration, governance, import, and purge have distinct phases.
Projection rebuilds and operation-status updates do not fabricate semantic changes. Hard purge
scrubs erased target IDs from older journal rows and emits content-free scope invalidations, so a
consumer holding an earlier cursor can rebuild safely without affected-target fields retaining
forgotten IDs. Change records retain opaque operation lineage; hard purge cannot remove private data
a caller deliberately encoded into an operation id. The journal is operational metadata—not
evidence, factual support, a retrieval/decision trace, or part of canonical export.

Register long-lived local consumers from a snapshot cursor and acknowledge only after their
downstream effects are durable. Registered compaction then uses every active semantic consumer:

```ts
await memory.registerJournalConsumer({
  id: 'search-index',
  journal: 'semantic',
  cursor: baseline.changesCursor,
})

await memory.acknowledgeJournalConsumer({
  id: 'search-index',
  journal: 'semantic',
  cursor: lastPage.nextCursor,
})

let expectedRevision = lastPage.currentRevision
let compaction

do {
  compaction = await memory.compactChanges({
    confirmSpaceId: 'workspace',
    registeredConsumers: true,
    expectedRevision,
    maxChanges: 1_000,
  })
  expectedRevision = compaction.revision
} while (compaction.hasMore)
```

Set `dryRun: true` to preview one batch. The cursor exactly at `compactedThrough` remains valid;
older cursors, and cursorless scans once the floor is above zero, fail with `conflict` and
`details.requiresSnapshot: true`. `stats()` reports both retained `changes` and
`changesCompactedThrough`. `consumerCursors` must contain `1..1,000` durable semantic-feed cursors;
this stateless mode remains useful when checkpoints live in another system. The expert
`throughRevision` override is mutually exclusive with both cursor and registry mode. Registry
acknowledgement is local-only, monotonic, access-partition-stable, and epoch-guarded against
compaction races. Explicit retirement—not a clock-based lease—decides when an offline consumer no
longer holds retention. Browse and lifecycle details are described in the signal-journal section
above and apply identically to both journals.

## Group deletion and forgetting

Delete one known episode through the bounded provenance and truth-maintenance path:

```ts
const deleted = await memory.deleteEpisode({
  episodeId: 'peripheral-session-42',
  access: { allowedScopes: ['team'] },
  workLimits: {
    maxRecords: 25_000,
    maxBytes: 32 * 1_024 * 1_024,
    maxGraphNodes: 25_000,
    maxGraphEdges: 100_000,
  },
})
console.log(deleted.work)
```

`deleteEpisode` point-loads the episode, scans its evidence, mentions, aliases, affected derivations,
and projections in 16-row keysets, and returns exact admitted row/byte/graph work. A limit failure or
revision race leaves the episode, support, projections, lifecycle, and operation unchanged.

Preview the exact episode-deletion selection, then bind the mutation to its revision, full-set
cursor, and explicit breadth guard:

```ts
const where = {
  source: { kinds: ['peripheral.session'] },
  tags: { all: ['session'], any: ['closed', 'expired'] },
  receivedAt: { until: '2026-08-01T00:00:00.000Z' },
} as const

const preview = await memory.previewEpisodeDeletions({
  where,
  access: { allowedScopes: ['team'] },
  maxMatches: 1_000,
  workLimits: {
    maxRecords: 25_000,
    maxBytes: 32 * 1_024 * 1_024,
    maxGraphNodes: 25_000,
    maxGraphEdges: 100_000,
  },
})

if (preview.selectionCursor === undefined) throw new Error('nothing matched')

const deletedGroup = await memory.deleteEpisodes({
  where,
  access: { allowedScopes: ['team'] },
  expectedRevision: preview.snapshotRevision,
  maxMatches: 1_000,
  selectionCursor: preview.selectionCursor,
  workLimits: {
    maxRecords: 25_000,
    maxBytes: 32 * 1_024 * 1_024,
    maxGraphNodes: 25_000,
    maxGraphEdges: 100_000,
  },
})
console.log(deletedGroup.work)
```

`previewEpisodeDeletions` and `deleteEpisodes` share the same selector: retained visible episodes
through pushed-down source/tag/time/identity filters plus residual metadata equality, in
deterministic ID order. Preview returns the complete bounded episodes, exact selection work, and—if
non-empty—an opaque cursor binding space incarnation, access, filter, revision, and the ordered ID
digest. Apply reselects and checks all bindings before it reads matching evidence, mentions, aliases,
affected support, facts, and projections in 16-row keysets. Empty previews expose no destructive
cursor; selector, access, reset, revision, or selected-set drift is a retryable conflict. One-shot
revision-checked deletion without a cursor remains available for trusted hosts that do not need a
separately inspected selection.

`maxMatches` limits how many episodes may be previewed or changed; `workLimits` independently limits
every physical row/byte and graph edge or node admitted while selecting and planning.
`EpisodeDeletionPreview.work` and `BulkDeletionReport.work` return that exact work. A limit failure
or revision race leaves every episode, fact, lifecycle, projection, operation, and signal row
unchanged.

`deleteEpisodes` is a soft tombstone and preserves history. `hardPurge` accepts the same selector as
`episodes` with the same `expectedRevision`/`maxMatches` guards and physically removes selected
canonical content. It accepts the same `workLimits` shape and returns exact admitted work as
`PurgeReport.work`. Both default to retained episodes. To purge already soft-deleted history, select
`retentionStates: ['deleted']` and preview with `view: { kind: 'history' }`. Re-preview before
choosing hard purge. “Stale” is not a built-in truth status: express freshness through application
facts, valid time, or a non-epistemic signal recommendation, then make deletion an explicit policy
decision. For post-hoc clusters, use the constrained signal browse's `targetSelectionCursor` with
`deleteEpisodes.signalTargets` for episode soft deletion or `hardPurge.signalTargets` for explicit
erasure. Both recheck the complete selection and avoid a host-side target-ID paging race.

Hard-purge selection, whole-target authorization, dependency erasure, recursive truth maintenance,
projection invalidation, and journal scrubbing use point reads plus 16-row keyset scans; large
internal ID predicates are split into fixed 1,000-ID queries. Signal target/basis and merge-source
closure use dedicated SurrealDB envelope indexes. Semantic/signal journals and opaque operation
results still require complete kind scans, but every physical row and stable JSON byte is admitted
before a durable marker exists. A limit failure therefore leaves no marker or canonical mutation.
The running marker persists the normalized ceilings, reopen recovery reruns the identical bounded
planner, and local sync packs are reclaimed in 128-row metadata transactions. The admitted
canonical erase itself remains one atomic revision-CAS transaction; it is bounded, not a claim that
an arbitrarily large erasure is streamed through multiple canonical commits. The caller must have
scope authority over the complete affected derivative closure. The legacy `before` shorthand now
also requires `expectedRevision` and `maxMatches`; prefer the previewable `episodes.receivedAt`
selector.

Hard purge also replaces every contaminated durable operation with a content-free diagnostics
tombstone. The public operation keeps its opaque id, kind, terminal outcome, timestamps, and attempt
count, reports `diagnosticsState: 'purged'`, and drops `episodeId`, result, error, warnings, and
provider-call summaries. Contamination follows erased canonical/journal lineage and exact target IDs;
whole-memory rebuild, sync, and migration diagnostics are conservatively scrubbed. Unrelated
operations remain available. Every facade commit refuses to replace a purged operation tombstone,
including a late provider settlement from an operation that lost a cross-context purge race.
`verifyIntegrity()` reports `invalid_operation_tombstone` if privileged/raw storage mutation restores
payload fields or makes the tombstone non-terminal.

An `operationId` is create-once within a space. Internal running-to-terminal updates carry a private
random run binding plus the same kind and episode binding. Pending/running rows also carry a private
random runtime-owner incarnation. The public `ProcessingOperation` exposes neither token. Reusing a
terminal ID for another episode or operation returns `idempotency_conflict` before canonical
acceptance. APIs that explicitly document replay may return their already-bound stored result, but
no call can rebind the durable operation row.

Each open facade holds a runtime-owner lease distinct from the short database-call lock. Persistent
clients use an origin-wide Web Lock, while the in-memory adapter uses an exact process-local lease.
A new private incarnation is generated for every actual open lifetime, including reopening the same
`Memory` object after `close()`; an old token is never reacquired.
A second opener checks that lease before marking an operation interrupted or resuming its marked
hard purge/sync apply: live work is left untouched; page/worker death releases the lease and makes
the row recoverable. Hard-purge recovery first rebinds the running operation through a revision CAS;
concurrent recovery has one owner before sync-metadata cleanup or canonical replanning begins.
`close()` and successful `resetSpace()` release the lease only after queued writes finish. If a realm
dies after episode acceptance but before canonical integration, reopen retains
one accepted episode, marks the abandoned operation partial, and the host completes processing with
`retryEpisode` and a fresh operation ID. Sync apply additionally commits its active session and
running owner operation together, persists each applied record with its continuation cursor, and
atomically publishes the completed operation, HEAD, and terminal session. Once the remote checkpoint
has been received, owner death after a committed apply or inverse rollback step resumes locally
without the original peer. Rollback recovery uses the retained local checkpoint, preserves its
cumulative work counters, and atomically restores that HEAD with the terminal `aborted` session.
This liveness contract does not make provider calls or physical database writes interruptible.

The retry contract is deliberately method-specific:

| API | Caller-supplied identity contract |
| --- | --- |
| `remember` | The episode `idempotencyKey` owns semantic replay. If `operationId` is supplied on replay, it must name that episode's original ingestion operation; an unbound or differently bound ID is rejected instead of being silently ignored. |
| `deriveFact`, `deriveFacts`, `withdrawDerivation`, `withdrawDerivations`, `correctFact`, `deleteEpisodes` | The ID is bound to a canonical request hash (correction uses its deterministic accepted episode identity). Repeating the same settled request returns the stored result; different input is `idempotency_conflict`. Single/batch activation and single/batch withdrawal are four distinct bindings. A derivation-withdrawal or episode-deletion selection cursor, when supplied, is part of that request identity, so replay must pass the same cursor. |
| `createSyncCheckpoint`, `syncFrom` | The ID seeds or binds a resumable sync session. Resume rechecks the complete request, access partition, pinned revisions/checkpoints, and transfer limits. Prefer an explicit `sessionId` for transport-level resume. |
| `hardPurge` | The ID is request-bound while the durable marker is running and reopen recovery resumes forward. A settled purge is intentionally not a replayable diagnostic result; later reuse is `idempotency_conflict`. |
| `retryEpisode`, `reprocessEpisode`, `retractFact`, `mergeEntities`, `splitEntityMerge`, `deleteEpisode`, non-dry-run `import`, `rebuildProjections` | Fresh-only. The ID must have no durable binding at admission. A residue-free pre-admission/CAS loser leaves it unused and may submit it again; after any operation row is persisted, retry needs a new ID. Revision and semantic preconditions prevent duplicate/stale mutation; reuse never means replay. |
| `resetSpace` | Does not accept a caller operation ID because success removes the space and its operation journal. Its report contains a generated, response-local operation summary. |
| `resolveSync`, `abortSync` | Do not accept a caller operation ID. `sessionId` is the sole durable continuation identity. |

Dry-run import also rejects `operationId` because it creates no operation. Treat operation IDs as
opaque, non-sensitive lineage; do not encode payloads or credentials in them.

Operation status is deliberately bounded. `ProcessingOperation.diagnosticsTruncated` is `true`
when the durable journal samples more than 64 warnings or 64 payload-free provider calls, replaces
provider-authored diagnostic text, truncates a 2,000-byte warning/error message, or drops error
details. Samples retain the first and last 32
entries. Raw provider warning strings, exception messages/details, credentials, prompts, responses,
and call payloads are never persisted; provider warnings become a content-free count and failures
use library-authored classifications. `verifyIntegrity()` rejects over-budget rows and provider-call
objects with unknown fields.

Every precomputed governance mutation is committed only against the exact storage revision it read.
Merge, split, retraction, deletion, import, projection rebuild, and purge selection never refresh a
revision underneath stale puts/deletes; a race returns retryable `conflict` and the caller reruns
the complete mutation with the method's request-bound replay identity or a fresh-only operation ID
as specified above. Ingestion and correction may retry internally only by rereading and
replanning their complete canonical mutation. Correction also reauthorizes the refreshed target
support set on every retry. Episode processing rechecks the accepted episode and
its purge tombstone on every attempt, while projection commits are revision-pinned and never retry a
stale payload. Thus a purge that wins the revision race cannot be followed by a stale merge,
canonical integration, or projection write that recreates erased data.

For explicit destruction of the entire bound space, `resetSpace` requires exact space confirmation
and separately bounds the affected-ID report before deletion:

```ts
const reset = await memory.resetSpace({
  confirmSpaceId: 'workspace',
  scanLimits: { maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 },
})
console.log(reset.scan)
```

The method natively preflights episode/entity/fact/projection report rows, scans only those kinds in
16-row keysets, and returns their IDs/count plus exact `scan` work. The defaults are 100,000 rows/
64 MiB and hard maxima are 1,000,000 rows/256 MiB. A `reset_scan` limit failure, cancellation, or
revision race leaves the space and open handle intact. Only after the complete report is admitted
does the adapter delete every space table and the space record in one revision-guarded transaction;
the handle then closes. This is deliberately destructive and all-or-nothing, not resumable sync or
targeted hard purge. If a separate canonical writer commits first, reset returns retryable
`conflict`, preserves that write and every prior row, and requires an explicit retry that repeats
the full preflight. If reset commits first, a delayed guarded writer returns `space_not_found` and
cannot recreate the space or retain an operation, lifecycle, canonical, or journal row. Peer
facades must close before the host explicitly decides whether to create the space again. Neither
direction is retried or recreated implicitly, and death inside the physical delete transaction is
not yet qualified.

## Atomic projection rebuilds

Omit all target-id selectors to rebuild complete projection sets:

```ts
const report = await memory.rebuildProjections({
  kinds: ['lexical', 'embedding', 'summary'],
  scanLimits: { maxRecords: 100_000, maxBytes: 64 * 1024 * 1024 },
})

for (const set of report.activeProjectionSets) {
  console.log(set.kind, set.generation, set.sourceCanonicalRevision, set.activatedAt)
}
console.log(report.scan)
```

The rebuild writes each requested kind under a fresh hidden set id. Recall continues to query the
previous active set while provider batches run. Once a kind is complete, a single SurrealDB
transaction checks both the physical revision and the canonical source revision, records the
nonterminal activation stage, and changes the active space reference. Successful requested kinds
switch together; a kind with any failed row keeps its prior set. Staged rows from an interrupted or failed build remain
invisible, are reported through `staleProjections`/`staleRemaining`, and are reclaimed in bounded
pages by the next full rebuild. `memory.inspect()` and `memory.stats()` expose the same
`activeProjectionSets` lineage.

Rebuilds are single-flight per space across full and targeted requests, kind selections, and
facades. Admission verifies the operation ID is fresh and checks for a live rebuild at one pinned
physical revision; the guarded running-operation commit gives same-snapshot contenders exactly one
durable winner. A live contender gets retryable `conflict` naming the owner before target reads,
provider work, or staging. A losing ID with no operation row remains fresh for an explicit retry
after settlement. This fence prevents one rebuild's inactive-row cleanup from deleting another
rebuild's hidden set.

Full rebuilds no longer export or retain the whole memory. Episode, entity, and fact targets advance
through 16-row id keysets; each target is staged independently. Targeted rebuilds point-read at most
10,000 unique requested ids. Alias, evidence, provenance-episode, and active-set replacement rows
are fetched through sparse point reads or 16-row filtered keysets. Generated projection rows are
admitted before their commit. `scanLimits` covers all of those returned and planned rows plus their
exact stable-JSON bytes, defaults to 100,000 rows/64 MiB, and has hard maxima of 1,000,000 rows/
256 MiB. `report.scanned` remains the logical canonical-target count; `report.scan` is the physical
and planned-row work.

An admission failure is `result_too_large` with `phase: 'projection_scan'`, exact `dimension`,
`required`, and `maximum`. A targeted build fails before replacing its selected projections. A full
build may already have durable hidden rows from earlier targets, but it never activates that
incomplete set: the durable operation settles `partial`/`projection_scan_failed`, the previous set
remains searchable, and the next successful full rebuild reclaims the inactive rows. Projection
input/output admission bounds facade materialization; one 16-row storage page or one configured
embedding provider batch can already be in flight. Post-activation inactive-set cleanup is a
separate 16-row, timeout/cancellation-bounded pass and is not included in `report.scan`.

Activation remains authoritative if later inactive-row cleanup is interrupted or a storage fault
occurs. The method then settles `operation.state: 'partial'`, `stage: 'cleanup_deferred'`, and
`retryable: true`; `staleRemaining` exposes the harmless inactive rows and a subsequent full rebuild
reclaims them. It never reports a terminal success before that cleanup attempt finishes.
If the owner page or worker terminates after hidden rows are durable but before activation, reopen
marks the operation `partial`/`interrupted`, retains the old active set, and leaves those rows
unsearchable. A later full rebuild may activate and reclaim them normally.

Lexical staging retains text in the row payload but leaves the schemafull indexed `text` envelope
unset. Its activation transaction removes the old set from BM25, indexes the complete new text set,
marks it ready, and flips the reference together. Hidden lexical rows therefore cannot change the
active set's document-frequency scores before cutover.

A request containing `episodeIds`, `entityIds`, or `factIds` is intentionally a targeted rebuild.
It atomically replaces successful rows only inside the current active set and preserves prior rows
for a failed kind. It cannot activate a new embedding generation: after changing provider model,
version, or dimensions, run a full rebuild. Existing schema-v7 spaces without set metadata keep
their legacy rows active until that first successful full rebuild. Projection sets are physical
indexes, remain excluded from canonical export and replica sync, and never become factual support.

## Export and import

`memory.export()` creates a revision-bracketed, deterministic, SHA-256-manifested format-v4
canonical archive with `snapshotRevision` and `exportedAt`. Scoped selection cannot bypass visible
evidence or derivation premises. Import validates the archive envelope, manifest counts, temporal
fields, content variants, duplicate identities, references, evidence and derivation state,
ontology constraints, dependency cycles, current support, and scope partitions before its first
mutation. The digest does not cover envelope lineage and is not a signature.

Format v4 includes the latest selected revision of each maintained derivation and the premise and
conclusion closure required to validate it. It also carries the accepted explicit assertions behind
each episode `contentHash`, so import can recompute the complete identity before target reads or
collision planning. Assertions remain reprocessing input, not a second truth source. Import
recomputes target-space identities and materializes current support as a target-local version-one
revision. Older archive formats are rejected rather than silently reinterpreted. Signals remain intentionally excluded: derived
recommendations must not become evidence merely by export/import. A host that explicitly needs a
signal archive can page `browseSignals({ revisionView: 'history' })`; the alpha importer does not
restore that separate plane.

Format 4 is also a closed runtime schema. Unknown or missing properties, malformed nested unions,
non-canonical identity arrays, cross-space records, and ill-typed optional fields are rejected at
the envelope, ontology, record, assertion, lineage, anchor, and merge boundaries. Resource, shape,
manifest, digest, ontology, and episode-identity verification completes before target database
reads; portable property additions require a new archive format.

The public `ArchiveMerge`, `ArchiveCounts`, and `ArchiveManifest` types exactly describe the merge
and manifest wire shapes. Export builds merge records through an explicit format-v4 projection, so
storage-only fields cannot enter an archive without a deliberate format-contract change.

The format-v4 API remains a materialized selective/remapping document, but it is now fail-closed and
resource-bounded. Export scans only canonical tables in 16-row keyset pages. `scanLimits` defaults to
100,000 physical rows / 64 MiB and caps at 1,000,000 / 256 MiB; `limits` defaults to 10,000 manifest
records / 16 MiB of exact complete-archive JSON and caps at 100,000 / 64 MiB. Import applies the same
document limits before collision work, while `prepareLimits` independently caps expanded
target-local rows and their serialized transaction input at 100,000 / 64 MiB and may be lowered per
device. Both sides also enforce one million aggregate JSON nodes. A limit failure returns
`result_too_large` and no partial archive or mutation. Streaming this selective format remains a
release gate. Use replica sync for bounded transfer of the whole logical memory, or
`exportSyncBundle` plus a durable `MemorySyncPeer` bundle adapter for its bounded resumable offline
form.

Canonical mutations and maintenance calls own their inputs at invocation. `remember`/batch/retry,
derivation activation and withdrawal, correction/retraction, merge/split, episode deletion,
hard-purge/reset, import, and projection rebuild copy their complete closed JSON request and every
JSON option before entering the serialized queue. A caller therefore cannot retarget authority,
identities, revision guards, semantic inputs, destructive selectors, confirmations, operation ids,
collision policy, or resource limits while earlier work runs. Only `AbortSignal` remains a live
capability. Unknown fields fail before storage/provider work; malformed archives retain
`import_invalid` or `result_too_large`. Materialized format-v4 import deliberately pays for one
additional bounded document copy; large/resumable transfer belongs on the chunked sync path.

This ownership rule is exhaustive across the facade. Open metadata/flags, statistics and integrity
limits, point-read convenience access/options, retrieval/feed/signal/archive options, and journal
consumer registration/checkpoint/retirement/browse/compaction inputs are copied before storage or
queue work. Reassigning `options.signal` after invocation cannot switch cancellation authority; the
captured signal object itself remains live. Storage, providers, peers, and listeners remain explicit
live capabilities rather than JSON data.

JSON output is caller-owned too. Returned spaces, records, reports, replay results, and each
listener's event payload are detached snapshots; mutating one cannot change persistence, a later
read, or another listener's event. These values are mutable copies rather than recursively frozen
objects. Injected providers/storage/peers and listener functions remain live capabilities.

## Whole-memory synchronization

Sync uses immutable content-addressed checkpoints and three-way reconciliation, not archive import
or history-rewriting rebase. A checkpoint carries the complete canonical state, full retained
signal and derivation histories, and content-free hard-purge tombstones. It excludes projections,
change journals, operations, provider payloads, and source-local physical revisions. A purge
tombstone retains only hashed target/idempotency data and timestamps; caller-controlled purge
operation IDs are stripped from the portable record.

Every sync request is a closed invocation-time JSON value. Checkpoint creation/export, inventory,
pull/resume, status, conflict inspection/resolution, abort, and history/session compaction copy their
complete request before queueing, local storage, or peer calls. Later mutation cannot change access,
space confirmation, checkpoint/session identity, strategy, cursor, resolution, cutoff, or limits.
Options are copied at the same boundary; only the explicit `MemorySyncPeer` and `AbortSignal` remain
live capabilities. Optional object properties such as first-page `cursor: undefined` are treated as
absent, while root or array `undefined`, unknown fields, cycles, non-plain objects, and unreadable
accessors fail as `invalid_input`.

```ts
const checkpoint = await source.createSyncCheckpoint({
  access: { allowedScopes: ['team'] },
  confirmSpaceId: 'workspace',
  maxChunkBytes: 8 * 1024 * 1024,
})

const report = await destination.syncFrom(source, {
  access: { allowedScopes: ['team'] },
  confirmSpaceId: 'workspace',
  strategy: 'merge',
  receiveLimits: { maxBytes: 512 * 1024 * 1024, maxRecords: 1_000_000 },
})

if (report.state === 'conflicts') {
  let cursor: string | undefined
  do {
    const page = await destination.syncConflicts({
      sessionId: report.sessionId,
      access: { allowedScopes: ['team'] },
      cursor,
      limit: 100,
      maxBytes: 1024 * 1024,
    })
    for (const conflict of page.conflicts) {
      const detail = await destination.syncConflict({
        sessionId: report.sessionId,
        key: conflict.key,
        access: { allowedScopes: ['team'] },
      })
      // Present detail.base/local/remote and an explicit local/remote/delete choice.
      void detail
    }
    console.log(`conflict page: ${page.byteLength} bytes`)
    cursor = page.nextCursor
  } while (cursor !== undefined)
}

console.log(checkpoint.id, report.state)
```

### Offline whole-memory bundles

`exportSyncBundle` is the bounded offline export form of the same protocol. It emits indexed
checkpoint-header frames, the selected checkpoint's existing chunks, and exactly one final `commit`
frame. Persist a page and its cursor atomically; only advance to `nextCursor` after every frame in
that page is durable.

```ts
import { openSyncBundle } from '@astrale-os/temporal-memory'

let cursor: string | undefined
do {
  const page = await source.exportSyncBundle({
    access,
    confirmSpaceId: 'workspace',
    checkpointId: checkpoint.id,
    cursor,
    maxCheckpoints: 10_000,
    maxCheckpointBytes: 64 * 1024 * 1024,
    limit: 16,
    maxBytes: 32 * 1024 * 1024,
  })
  await bundleStore.commitPage(page.frames, page.nextCursor) // durable and index-checked
  cursor = page.nextCursor
} while (cursor !== undefined)

// The package verifies the completed durable store and exposes MemorySyncPeer.
const bundlePeer = await openSyncBundle(bundleStore, {
  maxCheckpoints: 10_000,
  maxCheckpointBytes: 64 * 1024 * 1024,
  receiveLimits: { maxBytes: 512 * 1024 * 1024, maxRecords: 1_000_000 },
})

await destination.syncFrom(bundlePeer, {
  access,
  confirmSpaceId: 'workspace',
  sessionId: 'restore-2026-08-04',
  strategy: 'merge',
})
```

The package deliberately does not choose a filesystem, R2, IndexedDB, or network container.
`bundleStore` is a durable host adapter implementing the small `SyncBundleReader` boundary:
`readCommit()`, `readCheckpoint(index)`, and `readChunk(index)`. `openSyncBundle` streams through that
reader once, retains only bounded header/chunk metadata plus one chunk body, and rejects a missing or
changed commit, gaps, duplicate checkpoint ids, extra frames, an incomplete target ancestry, a
mismatched rolling `checkpointDigest`, or checkpoint/chunk/root manifest disagreement before
returning `MemorySyncPeer`. It rechecks the commit and content-addressed frame on later peer reads, so
the reader must remain durable and available while `syncFrom` runs or resumes. `syncFrom` then
performs semantic validation, purge handling, three-way reconciliation, durable staging/resume, and
fail-closed apply exactly as it does for a live peer.

Opening pins its limits and abort signal before the first reader await. Every commit, checkpoint, and
chunk returned by the reader is copied and JSON-validated in one traversal under hard format limits
before structural checks, hashing, or retention. Reader-owned getters and later mutations therefore
cannot make admission observe one value and reconciliation use another. An unreadable or hard-
oversized frame fails as `import_invalid`; verification never clones the complete bundle.

Bundle pages default to 16 frames and 32 MiB of canonical frame payload, cap at 64 frames and
256 MiB, and never split a checkpoint chunk. Header inventory defaults to 10,000 and caps at 100,000;
the sum of canonical checkpoint-frame bytes defaults to 64 MiB and caps at 1 GiB. Both whole-bundle
ceilings are cursor-bound. The self-describing final commit records the bundle media type/version,
`checkpointCount`, `checkpointByteLength`, and the rolling digest, allowing `openSyncBundle` to
reject an unsupported or oversized input before scanning bodies. The
cursor also binds space generation, access grant, target checkpoint, logical revision, and the
private sync-metadata revision. Every page checks both revisions before and after its read; a logical
or facade metadata mutation returns a retryable conflict instead of silently mixing header or
payload states. Fresh snapshot-bound cursors are v2, and a pre-v2 alpha cursor must restart. The
bundle includes every accessible local checkpoint header plus deterministic genesis and validates
the target's complete ancestry before commit. Header indexes and a rolling SHA-256 commit the exact
header sequence; checkpoint/chunk/root digests commit the logical payload. These hashes detect
corruption, not authorship. This is whole-memory replica export/import, not selective format-v4
remapping and not history-rewriting rebase.

`SyncBundleReader` is deliberately frame-oriented. A file/blob adapter must index or frame the
container without parsing the complete bundle into one JSON value, return `null` immediately after
each committed sequence, and atomically persist each export page with its `nextCursor`. Reopening the
reader and calling `openSyncBundle` again is safe; pass the same `sessionId` back to `syncFrom` to
resume at the first receiver chunk that was not durably committed.

Checkpoint payload retention is explicit and local. Plan a bounded page first, then repeat the
committing call with each returned cursor while the same logical revision and HEAD remain current:

```ts
const access = { allowedScopes: ['team'] }
const snapshot = await destination.snapshot({ access })
const head = await destination.syncHead(access)
const request = {
  access,
  confirmSpaceId: 'workspace',
  expectedRevision: snapshot.snapshotRevision,
  expectedHead: head.id,
  before: '2026-07-01T00:00:00.000Z',
  maxCheckpoints: 64,
}

const plan = await destination.compactSyncHistory({ ...request, dryRun: true })
console.log(plan.selected)

let cursor: string | undefined
do {
  const page = await destination.compactSyncHistory({ ...request, cursor })
  cursor = page.nextCursor
} while (cursor !== undefined)
```

Local sync state is inspectable without private-table queries. `syncHistory` pages immutable headers
with `available`/`pruning`/`pruned` payload state and an explicit current-HEAD marker;
`syncSessions` pages scope-checked resumable and terminal session summaries. Both cursors bind the
space generation and normalized access grant; checkpoint pages additionally bind the logical
revision, private sync-metadata revision, and HEAD, and bracket each page against that exact state.
Payload compaction therefore expires an older checkpoint cursor rather than mixing lifecycle states;
pre-v2 alpha checkpoint cursors must restart. Session inventory intentionally remains a live ordered
view while active progress advances.

Terminal conflict detail and abandoned staging have a separate bounded retention primitive. It
keeps the session result/idempotency record and every chunk owner still referenced by an immutable
checkpoint:

```ts
const terminalPlan = await destination.compactSyncSessions({
  access,
  confirmSpaceId: 'workspace',
  expectedRevision: snapshot.snapshotRevision,
  expectedHead: head.id,
  before: '2026-07-01T00:00:00.000Z',
  maxSessions: 64,
  dryRun: true,
})

if (terminalPlan.selected.length > 0) {
  await destination.compactSyncSessions({
    access,
    confirmSpaceId: 'workspace',
    expectedRevision: snapshot.snapshotRevision,
    expectedHead: head.id,
    before: '2026-07-01T00:00:00.000Z',
    maxSessions: 64,
  })
}
```

This reclaims only local chunks and random-access indexes. Immutable checkpoint headers and parent
links remain, the current HEAD is always skipped, and the logical memory revision does not advance.
`syncCheckpoint` can therefore still inspect an old header, while `syncChunks` returns `not_found`
with `details.requiresReseed: true` once that payload is compacted. If a later divergent merge needs
that exact base, `syncFrom` fails with the same explicit reseed requirement instead of approximating
a merge. Choose the cutoff from the maximum supported peer-offline interval; the package does not
silently reset or replace a replica.

`Memory` implements the small `MemorySyncPeer` read interface, so the example works in-process. A
host may expose the same three bounded read methods over an authenticated file, device, or network
transport. To converge both directions, pull each destination explicitly; the package does not
discover peers or run a background sync service.

Each pull walks all remote parent branches until they meet locally retained ancestry and caches
missing immutable headers parent-first in bounded create-if-absent batches. Intermediate payloads
remain explicitly unavailable, so later DAG traversal and bundle export work while a request for an
uncached historical payload still returns `requiresReseed`. This is ancestry retention, not rebase or
an implicit full-history payload download.

Chunks contain at most 256 records, default to 8 MiB, and are bounded to 64 KiB..16 MiB. Each is
independently checksummed and committed with durable receiver progress. Resume with the same
`sessionId` (or `operationId`) to continue at the first missing chunk; the session remains pinned to
its original remote checkpoint even if the source HEAD advances. `fast-forward-only` refuses
divergence. `merge` auto-resolves unchanged/one-sided/identical records and pages durable conflicts
for same-record edits, delete/modify pairs, cross-branch derivation cycles, or unreconciled
cardinality-one facts. `receiveLimits` rejects the remote header before chunk transfer and bounds the
merged result; defaults are 512 MiB of canonical payload, 1,000,000 records, and 65,536 chunks.
Payload limits do not estimate IndexedDB/index overhead, so a host should lower them to its actual
quota policy. A chunk is additionally capped at one million JSON nodes; this is separate from the
ordinary 4 MiB single-value JSON budget, so a valid 8–16 MiB transfer chunk remains usable.
`syncChunks` pages default to 16 MiB of canonical chunk payload and are capped at 256 MiB;
transport and header encoding overhead is additional, and a page never splits a chunk.
Semantic checkpoint validation keeps at most two already checksummed chunks in an operation-local
LRU (32 MiB at the maximum chunk size). Random-access indexes, record digests, and exact index
projections are still revalidated on every use. Purge-dominance decisions reuse at most 100,000
body-free logical-dependency results and recompute after that ceiling rather than growing memory.
Three-way merge writes deterministic conflict rows in batches of at most 128; a retry safely
completes an interrupted prefix, and resolution does not rewrite an already identical row.
Random-access sync indexes are acceleration metadata, not authority. Safe indexed reads validate
the derived owner/key identity, verify the owning chunk, and recompute the complete index from its
portable record before using query fields. The facade write boundary first requires every chunk and
exactly one deterministic index per contained record in the same atomic commit; partial, index-only,
duplicate, forged, or checksum-invalid packs are rejected before the storage driver.
`verifyIntegrity()` scans chunk/index metadata in bounded
keyset pages, catches malformed manifests plus missing, extra, forged, or aggregate-orphan indexes,
and never trusts a raw index merely because its digest and chunk number look plausible. It also
derives the complete valid owner set from available/pruning checkpoints and exact active/reclaiming
session lifecycles. A self-consistent pack with matching indexes but no reachable owner is
`orphan_sync_owner`; conflict and staged-purge detail must likewise belong to a valid non-pruned pull
session.
Stored checkpoint lifecycle metadata and the singleton HEAD pointer are likewise validated on safe
reads and facade writes. `verifyIntegrity()` traverses parent links and recomputes every available
checkpoint's exact paged chunk manifest; a malformed source revision, owner transition, missing
parent, invalid HEAD target, or forged payload association fails closed.
Conflict pages contain only validated identities and digests and are bounded by both item count and
exact canonical response bytes (1 MiB default, 16 MiB maximum). Fresh fixed-size v2 cursors avoid
embedding large record keys, while bounded legacy v1 cursors remain consumable. `syncConflict`
retrieves one pinned base/local/remote triple on demand with a 1 MiB default and a
48 MiB-plus-envelope hard response bound. After terminal detail compaction, list and point reads
fail with `detailsPruned: true` rather than returning an ambiguous empty page. This keeps list paging
bounded without forcing a host to resolve opaque digests.

Session status, conflict paging, resolution, and abort are all checked against the session's complete
accumulated scope set. Resolution and abort additionally require exact `confirmSpaceId`; these APIs
are not metadata side channels around checkpoint disclosure checks.

Apply is fail-closed. Ordinary reads/writes receive retryable `sync_in_progress` while a partial
apply exists. Reopening resumes it automatically; `abortSync` rolls it back to the retained local
checkpoint only if the target adds no purge tombstone. Erasure is non-reversible, so a session with
a new purge refuses rollback and must resume forward. Hard-purge tombstones always dominate
additions, including facts, derivations, lifecycle, and signals transitively supported only by
purged evidence. Local dominance rows are exact derived identities bound to space, session, kind,
and digest; facade writes, lookups, and paged integrity verification reject malformed or substituted
rows instead of treating mere table presence as deletion authority. Aborting before apply removes
partial receiver/merge chunks, indexes, conflicts, and staged tombstones. Targeted hard purge first
invalidates every local sync pack so erased plaintext cannot be restored from an old checkpoint.

Hashes detect corruption, not authorship. The host must authenticate peers, authorize whole-space
scope disclosure, enforce transport body bounds, and provide encryption/replay protection where
needed. Manual `compactSyncHistory` is cursor-bounded, scope/revision/HEAD guarded, atomically marks
selected payloads unavailable, deletes owner rows in bounded batches, and finishes an interrupted
physical cleanup on reopen. `compactSyncSessions` applies the same mark-then-reclaim recovery model
to terminal detail, but deliberately retains small session headers so completed operation IDs remain
idempotent. These are not an automatic retention policy: checkpoint/session headers are not
collected, storage-engine overhead is not predicted by `reclaimedBytes`, and quota, hostile-peer,
independent-tab, and population-scale behavior remain unqualified.

Retained session status is bounded: `SyncReport`/`SyncSessionSummary` include an optional
library-authored `error`, at most 64 warnings of at most 2,000 UTF-8 bytes, and
`diagnosticsTruncated`. Overflow keeps the first and last 32 warnings. Every facade transition,
including recovery and compaction, applies the budget; `verifyIntegrity()` reports
`invalid_sync_session` for a raw/privileged row outside it.

Session rows are fully bound state, not editable labels. Before a safe API resumes, cleans, or
discloses one, it recomputes the original request hash and scope union, validates revision and
checkpoint/operation bindings, and compares active build/receive/plan counters with their exact
paged chunk-owner manifest. Reducing private scopes, swapping a head, or forging progress through a
raw query therefore yields `integrity_failed`. Terminal compaction can repair only oversized
diagnostic sampling; every request, scope, checkpoint, owner, and progress invariant must already be
valid.

## Runtime support

| Runtime | Adapter | Persistence | Evidence |
| --- | --- | --- | --- |
| Modern browser | SurrealDB WASM direct | IndexedDB | Chromium + Vite 8 single-page and same-origin multi-tab acceptance |
| Modern browser | SurrealDB WASM worker | IndexedDB | Chromium + Vite 8 single-page and same-origin multi-tab acceptance |
| Node.js 20+ | in-memory | none | packed-consumer smoke on Node 20; unit and contract tests on Node 22 |

Cloud/server SurrealDB endpoints are intentionally not exposed by the alpha reference factory.
The embedded driver does not acquire a shared reference until connect, namespace/database selection,
schema, backfill, and index bootstrap all finish. If setup fails after connect begins, the driver—not
the facade—owns the zero-reference physical cleanup. A lost cleanup or final-close completion returns
`details.connectionCleanup: 'pending'`; no new connection begins until a later `open()` or explicit
`close()` finishes that idempotent cleanup. The facade keeps `close()` active after such a failure,
even though its application state is already closed. Direct and worker Chromium schedules lose
completion after connect, schema bootstrap, bootstrap cleanup, and final close, then reuse the same
capability. This does not qualify process or database-worker death.
Current merge redirects use the schemafull/indexed `tm_merge.active` envelope field instead of
scanning inactive merge history. Opening an existing schema-v7 database idempotently backfills that
physical field from the unchanged canonical payload; it does not advance a memory revision.
Merge/split authority, disclosure-partition, and projection planning is independently bounded by
`workLimits` and indexed target closure; it does not scan or export unrelated canonical rows.
Fact conflict groups likewise have a schemafull/indexed `tm_fact.conflict_group` envelope field,
with an idempotent schema-v7 payload backfill, so statistics can scan distinct groups without
materializing unrelated facts.
Non-current views do not query merges because historical merge reconstruction is not an alpha
semantic.
Same-origin independent tabs now prove one-winner guarded signal CAS with a retryable loser and no
partial rows, explicit retry convergence, and one-winner same-preview signal withdrawal and
retained-key purge with exactly one journal action and no loser residue. They also prove that a hard
purge paused after its target read rejects a late signal dependency before creating its marker or
operation, while an explicit retry replans and erases the dependency. A separate nine-schedule
matrix races disjoint signal-selected soft deletions and both winner directions of soft deletion
versus hard purge. One physical-revision winner performs the complete canonical and signal action;
the loser leaves no operation, lifecycle, marker, canonical, semantic-journal, signal-revision, or
signal-journal residue and receives `requiresSignalBaseline`. Disjoint losing work explicitly
repreviews and succeeds with its still-unbound operation ID, while a consumed selection returns no
destructive cursor. After both clients read the same bounded semantic- or signal-journal compaction
batch, exactly one commits; its retryable loser does not delete rows or advance either floor, both
clients converge on the winner, and an old cursor in the other tab receives the feed-specific
baseline error. Independent derivation creation, winner
replay, explicit losing-ID re-evaluation, withdrawal, and cascading invalidation have the same
three-pairing coverage. A separate reset/writer matrix proves both deterministic winner directions:
writer-first leaves the complete write intact and makes reset retryable, while reset-first makes the
delayed write fail without recreating any row. These mutation/compaction races and reset/recreate
incarnation fencing cover direct/direct, worker/worker, and mixed connections. A deterministic post-query gate additionally
proves that cross-tab logical writes make in-flight snapshot, recall, checked point read, browse,
neighborhood, analysis, bounded archive export, integrity, signal browse, and both journal-page reads
fail retryably.
Checkpoint-only private-metadata changes make in-flight statistics and inspection fail without
changing their public revision. Persistent clients coordinate every physical SDK call with a stable
endpoint/namespace/database Web Lock; `indxdb://` fails `storage_failed` when Web Locks are
unavailable, while process-local `mem://` continues to work. The clean installed tarball repeats the
mixed-engine write/feed/reset path, but not the added destructive or compaction-contention schedules.
The single-page direct and worker paths also force a schema error after an earlier valid statement in
one generated transaction: the adapter reports `transactionOutcome: 'rolled_back'`, retains neither
row nor any space revision, and successfully commits and cleans up a follow-up write on the same
connection. A physical call that disappears without statement responses is instead non-retryable,
reports `transactionOutcome: 'unknown'` plus `requiresReopen`, and requires durable-state
reconciliation; database-worker death during `COMMIT` is not covered by the rollback probe.
The direct and worker paths also lose completion after a revision-guarded generated space deletion,
then prove both shared facades and cached `open()` remain fenced after one reference closes. Final
close and fresh open reveal the committed deletion; open without creation reports
`space_not_found`, and only explicit `open({ create: true })` recreates revision zero.
After that unknown outcome the facade also fences public calls and already-queued mutations, performs
no secondary failed-operation settlement, and refuses `open()` until explicit `close()`. Reads that
were already in flight recheck the fence before returning; calls made afterward reject before a
storage read, including `inspect()`. An old read remains rejected even if close/reopen completes
before it settles. Reopen rotates the private owner incarnation and runs ordinary durable recovery.
Injected post-commit loss proves that direct-read boundary plus request-bound replay, fresh-only
identity sealing, interrupted-ingestion retry, and explicit space recreation after an unknown reset;
it is deterministic facade evidence, not a physical database-worker kill.
Another source-browser case opens a second facade while ingestion is paused after durable acceptance
and proves the live owner's operation is not rewritten. It then terminates the owning page without
calling `close()`, reopens the observer, records one interrupted operation, and finishes the same
accepted episode through a fresh `retryEpisode` operation across direct/direct, worker/worker, and
mixed engines. A separate case pauses sync after its first durable journaled apply step: the observer
cannot steal the live operation, actual owner-page termination releases the lease, and observer
reopen completes the pinned local checkpoint without the original peer across the same engine
matrix. Unit schedules additionally prove atomic active-session/operation creation, atomic terminal
operation/HEAD/session publication, and the same no-steal rule for marked hard purge.
Another matrix pauses two identical session requests before activation from the same revision. One
client atomically owns and completes the session, the loser receives retryable `conflict` with no
operation, record, journal, or HEAD residue, and replay from that loser returns the winner's durable
report across direct/direct, worker/worker, and mixed engines.
Another case interrupts forward apply after one durable record, starts rollback, and pauses after
the first durable inverse record. A second client cannot steal or restart the live rollback; after
actual owner-page termination it claims the same operation, restores the retained local HEAD, and
finishes with the source peer gone across the same engine matrix. Exactly the forward and inverse
sync journal records remain.
Hard purge is separately terminated after marker creation, between bounded sync-metadata deletion
batches, immediately before its final canonical transaction, and immediately after a recovery-owner
claim. A fresh facade first wins one revision-CAS ownership transition, leaves other live observers
behind `purge_in_progress`, and resumes forward; the final canonical deletion, content-free marker,
single purge journal record, sync-history erasure, integrity, and replay denial converge across the
same engine matrix. An in-memory same-revision claim race gives exactly one recovery owner.
Another matrix pauses two distinct hard-purge operations from the same revision before their marker
commits. Exactly one revision-CAS marker wins; the loser receives retryable `conflict` and leaves no
operation, marker, owner, canonical, sync-metadata, or journal residue. After the winner settles, an
explicit loser retry rereads, replans, and succeeds. A second schedule holds the winner after its
durable marker: the distinct contender fails with `purge_in_progress` naming that operation before
target/dependency planning, leaves its own operation ID unbound, and succeeds after the same explicit
retry. Both schedules converge with integrity across direct/direct, worker/worker, and mixed engines.
This is not a cross-tab leader, notification bus, database snapshot, or general serializability
claim: other governance writes still need independent-context qualification. Projection cutover and
additive migration now have separate direct/direct, worker/worker, and mixed contention plus
between-transaction owner-death matrices. The ingestion page-death case pauses before its canonical
storage transaction; the hard-purge, projection, migration, and sync cases pause between complete
physical transactions, not during one.
Browser-process restart, database-worker termination during a physical commit, background
suspension, corruption, and quota exhaustion remain unqualified. Physical death inside an additive
migration transaction and row-transforming/ontology migration remain unqualified.

## Development

From the repository root:

```sh
pnpm --filter @astrale-os/temporal-memory lint
pnpm --filter @astrale-os/temporal-memory typecheck
pnpm --filter @astrale-os/temporal-memory test
pnpm --filter @astrale-os/temporal-memory build
pnpm --filter @astrale-os/temporal-memory verify:sbom
pnpm --filter @astrale-os/temporal-memory test:browser
pnpm --filter @astrale-os/temporal-memory verify:package
```

The browser gate exercises both direct and worker engines, a fresh IndexedDB connection, hostile
SQL-shaped text, scope-filtered retrieval, derivation persistence, bounded
correction/retraction/single-episode deletion, signal persistence, bounded signal browse, atomic
revision-counted signal key purge, signal-journal handoff/compaction, dependency-purge scrubbing,
bounded integrity rejection/reporting, and concurrent reads through a shared WASM engine. Its
separate-client matrix covers same-preview signal withdrawal/purge and pre-marker hard-purge
stale-plan rejection plus explicit replan, independent derivation create/replay/re-evaluate/withdraw/
cascade, and deterministic same-batch contention for both journal compaction APIs, across
direct/direct, worker/worker, and mixed engines. It also transfers a
full checkpoint to an independent IndexedDB replica and
verifies its logical HEAD, derivations, signal history, integrity, and purge replay denial after
reopen in both direct and worker modes.
The package gate installs the tarball into a clean temporary consumer with an isolated store,
fetches and hash-checks the public WASM prerelease, and verifies runtime imports, declaration
resolution, legal/documentation files, and the byte-identical deterministic CycloneDX 1.6 SBOM. It
checks the complete resolved npm dependency graph, 337 unique components from the WASM artifact's
locked Cargo inventory, the distinct embedded BUSL change dates, and the exact WASM file hash before
running an in-memory
ingest/derive/correct/retract/delete/signal/semantic-change/
signal-change/compaction/export/dry-run/import/recall cycle, typed derivation/signal/change
and integrity consumption, whole-memory sync, and direct plus module-worker IndexedDB close/reopen and replica
transfer from the installed artifact. The packed browser path also performs a full lexical
projection-set cutover and consumes its public active-set lineage from the installed declarations.

## Security and governance

- Report vulnerabilities through GitHub Security Advisories; do not disclose them in public issues.
- [Product contract](https://github.com/astrale-os/exp-spec/blob/main/docs/PRODUCT-temporal-memory.md)
- [Implementation specification](https://github.com/astrale-os/exp-spec/blob/main/docs/SPEC-temporal-memory.md)
- [Security policy](https://github.com/astrale-os/exp-spec/blob/main/SECURITY.md)
- [Contributing](https://github.com/astrale-os/exp-spec/blob/main/CONTRIBUTING.md)

Temporal Memory's own source is Apache-2.0; that does not relicense the mixed-license `/surreal`
runtime described above. Every build emits `dist/sbom.cdx.json` without a timestamp or machine-local
paths; its content-derived serial and sorted inventory make identical inputs byte-reproducible. The
embedded Cargo components are an exact inventory from the shipped `cargo-about` report, but their
intra-Cargo dependency edges are not present in that report and are therefore marked `unknown` with
a standard CycloneDX relationship composition rather than invented. An SBOM
is dependency evidence, not legal approval, a vulnerability attestation, or signed provenance.
