# `@astrale-os/temporal-memory` — Alpha Implementation Contract

| Field                  | Value                                                         |
| ---------------------- | ------------------------------------------------------------- |
| Status                 | As-built alpha contract; not a stable or production-ready API |
| Package version        | `0.1.0-alpha.1`                                               |
| Product contract       | [`PRODUCT-temporal-memory.md`](./PRODUCT-temporal-memory.md)  |
| Runtime                | Headless browser-compatible JavaScript/TypeScript             |
| Reference store        | Embedded SurrealDB WASM using `indxdb://` or `mem://`         |
| Tested dependency pair | `@astrale-os/surrealdb-wasm` `3.0.4-astrale.1`; `surrealdb` `2.0.8` |

This document describes the implementation that exists in the current alpha. It separates that
implementation from the semantic product contract and from work still required for production.
It does not declare registry publication, compatibility stability, or completion of every product
requirement.

The exact TypeScript ABI is defined by [`src/types.ts`](../packages/temporal-memory/src/types.ts),
the root barrel by [`src/index.ts`](../packages/temporal-memory/src/index.ts), and the storage
adapter by [`src/surreal/index.ts`](../packages/temporal-memory/src/surreal/index.ts). This document
summarizes those files instead of duplicating every declaration. A difference between prose and
the emitted declarations is an implementation defect; the emitted declarations remain the
as-built truth for `0.1.0-alpha.1`.

## 1. Semantic contract

### 1.1 Purpose and boundaries

Temporal Memory is a headless, local-first memory component for accepting evidence, deriving an
evidence-backed entity/fact graph, preserving valid-time and record-time history, and retrieving a
bounded cited context bundle. It does not own UI, authentication, credentials, model SDKs, browser
permissions, or Copilot execution.

One `Memory` facade is bound to one `spaceId`. A caller supplies `AccessContext` on every read or
governance operation. The package treats that context as an authorization decision already made by
the host; it is not an identity or authentication mechanism.

Scopes are conjunctive. A record is visible only when every record scope occurs in
`allowedScopes`; an empty scope list is visible to any caller in the same space. Space isolation,
visible supporting evidence, and scope-preserving projections are mandatory boundaries. A
restricted record cannot become a traversal bridge, citation, alias, embedding, or summary for a
less-privileged caller.

### 1.2 Canonical meaning

| Record               | Alpha meaning                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Episode              | Immutable accepted evidence plus mutable retention state.                                                |
| Entity               | Canonical identity assembled from evidence-scoped aliases and identifiers.                               |
| Entity alias         | Value, normalized value, types, identifiers, scopes, episode ids, and `recordedAt`.                      |
| Fact                 | Subject-predicate-object claim with valid time, recorded time, lifecycle status, and derivation lineage. |
| Evidence link        | Episode-to-target relation with exact content anchor, derived excerpt, status, and optional withdrawal.  |
| Derivation           | Immutable revision of rule/version support from fact/evidence premises to one conclusion.                |
| Mention              | Literal episode-local text plus exact content anchor associated with an entity or unresolved candidate. |
| Lifecycle transition | Append-only record-time transition for an episode, entity, or fact.                                      |
| Merge                | Reversible redirect from retained source entities to a retained target entity.                           |
| Operation            | Durable progress and diagnostics, or a content-free hard-purge tombstone identified by `diagnosticsState`. |
| Projection           | Rebuildable lexical, embedding, or summary derivative; never canonical truth.                            |
| Semantic change      | Durable operation/revision metadata with exact-scope affected targets; neither evidence nor a trace.     |
| Signal               | Immutable scoped non-epistemic annotation revision with target, producer, declared basis, and revision lineage. |

Episode content is one of text, message, structured JSON, or event JSON. Episode kinds additionally
express assertion, correction, and retraction intent. Explicit assertions are a deterministic host
interpretation; absent explicit assertions, an injected inference provider may propose bounded
candidates.

Every current fact must have active direct evidence or an active derivation whose complete premise
closure is caller-visible. Rule support never masquerades as source evidence. Repeated support
attaches evidence or another derivation without multiplying the semantic fact. A cardinality-one change may supersede a prior fact only
when temporal ordering is sufficient; otherwise conflicting claims remain disputed. Similarity
alone never merges identities or supersedes facts.

#### 1.2.1 Exact episode anchors

New evidence and mentions use `EpisodeAnchor`:

```ts
type EpisodeAnchor =
  | { kind: 'text'; unit: 'utf16-code-unit'; start: number; end: number }
  | { kind: 'json-pointer'; pointer: string }
```

The implemented rules are:

- A text anchor is a non-empty in-bounds range over `text` or `message` content. Offsets are
  JavaScript UTF-16 code units and neither boundary may split a surrogate pair.
- A JSON anchor is an RFC 6901 pointer into the `value` of `structured` or `event` content. Empty
  pointer selects the complete value. Invalid escapes, non-canonical array indexes, and unresolved
  paths fail validation.
- `EpisodeEvidenceInput.excerpt`, when present, is not trusted metadata. It must equal the text range
  exactly or equal the deterministic JSON serialization of the selected value. It is capped at
  4,096 UTF-8 bytes.
- An excerpt without an anchor is allowed only for text/message content and only when it occurs
  exactly once on valid scalar boundaries. Structured/event excerpts require a pointer.
- Omitting both fields creates a broad anchor over the complete episode content. Its stored/rendered
  excerpt is capped at 4,096 UTF-8 bytes and carries `excerptTruncated: true` when bounded; the anchor
  still selects the complete content.
- `EntityMentionInput.text` must equal the selected source value. An explicit unanchored mention
  must occur exactly once. An implicit canonical-name mention is omitted, rather than guessed, when
  absent or ambiguous. Canonical aliases never create mention records by themselves.
- Evidence identity includes the anchor. Two occurrences in one episode may therefore support the
  same target as distinct links instead of overwriting one another.

Host assertion anchor errors fail as `invalid_input` before episode acceptance. Invalid
provider-supplied anchors/excerpts fail the processing operation as `malformed_provider_output`
while preserving the already accepted episode. New package writes always store anchors. Format-v1
imports may contain older anchor-less evidence/mention records; when an anchor is present, import
and integrity verification resolve it against the immutable episode and reject/report mismatch.

### 1.3 Time

Public and imported instants are canonical UTC RFC 3339 strings with exactly millisecond precision,
for example `2026-08-03T10:00:00.000Z`. Offsets, missing milliseconds, invalid instants, and
non-canonical representations fail with `invalid_input` or `import_invalid` before canonical
mutation. Generated instants use `Date.prototype.toISOString()`.

Valid-time intervals are half-open `[from, to)`. Either bound may be absent; when both exist,
`from < to` is required. Absence means unknown or open, not a fabricated sentinel timestamp.

The implemented temporal views are:

| View          | Implemented behavior                                                                                                                                                                    |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current`     | Returns supported `active` or `disputed` facts whose validity contains the facade's current time.                                                                                       |
| `valid-at(T)` | Applies valid time at `T` while retaining the current record-time view; returns supported facts other than retracted/deleted ones. Superseded history may be visible at its valid time. |
| `known-at(T)` | Excludes episodes, evidence changes, and lifecycle transitions recorded after `T`, reconstructs the latest fact snapshot known by `T`, then applies validity at `T`.                    |
| `history`     | Returns each visible stored fact once with lifecycle and visible evidence history; it is not one row per historical state.                                                              |

`read`, `getEpisode`, `getEntity`, `getFact`, and `getDerivation` are current point reads. Temporal
views are available on `recall`, `search`, `neighborhood`, `browse`, and `analyze`. The alpha
reconstructs fact lifecycle,
evidence withdrawal, and soft episode deletion. It does not reconstruct arbitrary historical entity
profiles or merge state. Hard-purged payloads are absent from every view.

Each point read brackets all of its component storage reads with the space generation and revision.
Concurrent revision change fails with retryable `conflict`; a reset/recreated space requires close
and reopen. The checked `read` result carries that revision, evaluation time, and exact physical scan
work. `get*` methods return only its `value` as convenience sugar. Consumers that need a complete
multi-record reasoning baseline use `snapshot`.

`known-at` is application-level reconstruction from immutable record timestamps and lifecycle
records. `snapshotRevision` and the per-space revision are optimistic consistency tokens, not time
coordinates. The IndexedDB WASM adapter is not a qualified versioned storage engine and the package
does not issue `SELECT ... VERSION`; arbitrary MVCC system-time rewind is therefore not an alpha
capability. Episode `observedAt` and `receivedAt` remain separate from fact valid/recorded time.

For one persistent `indxdb://` endpoint, separate same-origin browser pages, direct engines, and
module-worker engines are independent storage clients. A driver's in-process promise queue is only
a connection-safety mechanism and MUST NOT be treated as cross-context coordination. The persistent
adapter MUST acquire one origin-wide exclusive Web Lock, under a stable package-domain name derived
from endpoint, namespace, and database, around every physical SDK call. Opening `indxdb://` MUST fail
closed with `storage_failed` when Web Locks are unavailable; `mem://` is process-local and does not
require them. The lock serializes physical access and is automatically released if its owning page
dies, but it is not itself a revision token.

Each open facade also owns a distinct, long-lived runtime lease. For persistent storage this is a
second origin-wide Web Lock whose stable name combines the same endpoint/namespace/database domain
with a private random facade-owner token; the in-memory adapter provides the equivalent exact
process-local lease registry. This lease is not held around database work and MUST NOT serialize
unrelated clients. A newly persisted `pending` or `running` operation stores the private owner token,
which is never exposed by `ProcessingOperation`, exported, synchronized, or retained in a purged
operation tombstone. Graceful `close()` releases the lease only after the facade write queue drains;
browser page/worker termination releases the Web Lock automatically. Every actual `open()` lifetime,
including reopen of the same JavaScript facade after `close()`, generates a new owner incarnation;
reacquiring an old token would falsely make abandoned work appear live.

Open-time recovery MUST query owner liveness before changing an owned non-terminal operation or
resuming a hard-purge/sync-apply workflow. A held owner lease means the other facade is still
authoritative: the opener skips recovery and ordinary APIs continue to obey the workflow's existing
fail-closed barrier. An absent lease makes the work eligible for recovery. Every newly written
active sync-apply or rollback session MUST be committed atomically with its bound running operation
and owner token; an active legacy session with no operation row is claimed by creating both through
one revision-guarded storage commit. Hard-purge recovery MUST likewise re-read the exact active marker
and prior operation, then claim or create its running operation through one revision-CAS commit before
deleting sync metadata or replanning canonical erasure. A wrong-kind or terminal operation bound to
an active marker is corruption. Concurrent recovery therefore has at most one owner; a loser leaves
the marker, operation, metadata, canonical rows, journals, and logical revision unchanged, then
observes the winner's live lease or retries after rereading. Owner tokens
are create-once random incarnations and are never reacquired by another facade, so a lease cannot
disappear and later become live again. Legacy running rows without an owner token remain immediately
recoverable. Liveness prevents false interruption; it does not make provider calls, user code, or
multi-stage workflows atomic.

Correctness therefore has two layers: Web Locks prevent overlapping embedded clients from observing
and committing through independently scheduled IndexedDB transactions, while the database
transaction still checks the persisted space incarnation and applicable logical, canonical, and
private-metadata revisions in the same transaction as all row and journal changes. Two independent
writers starting from one expected revision may produce at most one successful guarded commit; a
loser receives retryable `conflict`, leaves no partial rows, and may re-read then retry explicitly.
The package makes no fairness or automatic-retry guarantee.

Destructive reset is a stricter named boundary. Its admitted report remains pinned to the space
incarnation and logical revision through the final delete transaction. If a canonical writer commits
first, reset MUST fail with retryable `conflict`, leave the space and writer commit intact, and
require a new complete report preflight before explicit retry. If reset commits first, a writer
paused before its guarded commit MUST fail with `space_not_found` and MUST NOT recreate the space or
leave operation, lifecycle, canonical, or journal residue. Successful reset closes its facade;
other facades do not implicitly recreate the space and must close before an explicit create/open
decision. This is transaction-boundary atomicity, not qualification for browser-process or database-
worker death inside the physical transaction.

The Surreal adapter distinguishes an engine-returned transaction failure from loss of the call
outcome. If the engine returns a failed statement from a generated transaction, the adapter MUST
surface its storage error with `details.transactionOutcome: 'rolled_back'`; no statement, space
revision, canonical revision, or private metadata revision from that transaction may remain, and
the same connection remains usable. If the physical query call rejects without a statement result,
the adapter MUST instead set `details.transactionOutcome: 'unknown'`,
`details.requiresReopen: true`, and `retryable: false`. That error is not proof of rollback: the host
must close/reopen, inspect durable operation and space state, and follow that method's replay
contract rather than blindly resubmitting a fresh-only identity. A raw-query call with no statement
response uses the analogous non-retryable `details.queryOutcome: 'unknown'` boundary. Browser or
database-worker death during `COMMIT` remains unqualified.

Once a facade observes `transactionOutcome: 'unknown'`, it MUST fence all public work and already-
queued mutations with that same non-retryable error. It MUST NOT attempt a compensating operation
settlement or any other secondary storage write. A public read that started before the facade
observed the unknown outcome MUST recheck the fence at its public completion boundary and return the
same error instead of a value or completion event, even if explicit close/reopen completes before
that old read settles. A call made after observation, including closed-capable `inspect()`, MUST
reject before issuing another storage read. `open()` on that facade also fails until explicit
`close()` releases its owner lease; the next actual open uses a fresh owner incarnation and performs
normal durable recovery. Request-bound replay may then return an already-committed result, a fresh-
only identity remains sealed if its operation committed, and an unknown reset that deleted the space
requires an explicit host decision to create it again.

The same persisted-token boundary applies to reads across clients. If another context commits a
logical change after a complete read captures its initial incarnation/revision but before its final
check, the read MUST return retryable `conflict` and no result. Metadata-sensitive management reads
also compare the private metadata revision, so a checkpoint/session-only commit cannot be mixed into
one statistics or inspection report without detection. This detects overlap; it does not cancel the
other writer, undo provider work already performed, or supply snapshot isolation between component
queries.

An independent reset/recreate changes the incarnation even when the new logical revision equals an
old value. A facade that was already open MUST reject subsequent work with `requiresReopen: true`;
incarnation-bound browse, journal, selection, and sync cursors cannot alias the recreated space.
Cross-context journal compaction MUST make a now-expired cursor fail with the same feed-specific
baseline-reacquisition contract as same-context compaction. Two clients attempting to advance one
journal floor from the same expected revision have at most one winner; the loser is retryable and
leaves both journals and floors unchanged. The supported boundary is optimistic detection plus
origin-wide physical-call arbitration and atomic writes—not a long-running database snapshot,
cross-tab event bus, leader election protocol, or whole-facade serial execution across tabs.

### 1.4 Privacy and provider boundary

Inference, embedding, and reranking are injected capabilities. Each invocation passes through
`MemoryPolicy.authorizeDisclosure` when a policy exists. The policy may deny or replace the proposed
payload. Provider lineage records capability, provider, model, version, destination, and embedding
dimensions where relevant. Every `DisclosureRequest` carries a closed, sorted, unique
`sensitivities` set. Labels are opaque: the package never guesses an ordering or collapses them to a
single maximum. The set is the union of every retained source episode classification on which the
disclosed payload depends: the input episode, source episodes for rendered entity aliases, direct
fact evidence, and the transitive active-derivation premise closure. A caller-authored retrieval
query has no memory-derived classification by itself. Missing or inconsistent dependency provenance
fails closed before policy or provider invocation.

Provider credentials are not part of public memory types, canonical records, exports, events, or
diagnostics. Provider input and output are treated as bounded data and are never interpolated into
SurrealQL. Accepted episodes survive provider failure; provider-derived canonical changes commit
only after validation.

Provider-authored warning strings, exception messages, and exception details MUST NOT be persisted
as operation diagnostics. The facade may expose only library-authored classifications and a
content-free warning count. This rule applies even when a provider throws a branded `MemoryError`.

Every stored lexical, summary, or embedding projection carries the same dependency-derived
`sensitivities` set as its rendered source. Projection generation includes the sensitivity contract
version, so projections written before this field existed cannot remain active as implicitly
unclassified rows. Embedding projection work is partitioned by the exact pair of projection scope
set and sensitivity set. One disclosure request and provider batch never combines different pairs.
`ingestion.projectionBatchSize` is implemented with default `64` and accepted range `1..1000`.

Every original disclosure payload is admitted before policy invocation, and every policy-replaced
payload is admitted again before provider invocation. `MemoryOptions.disclosureLimits.maxBytes`
measures exact stable-JSON UTF-8 payload bytes, defaults to 1 MiB, and accepts `1..16 MiB`.
`maxTokens` defaults to 262,144 and accepts `1..4,000,000`. Without `countTokens`, UTF-8 bytes are a
conservative upper bound on losslessly tokenized payload content. A synchronous provider-aware
counter may instead return the actual count and MUST include any provider prompt/template overhead
that the host wants governed. A thrown, negative, fractional, or non-finite count fails closed as
`policy_denied`; a ceiling breach is `result_too_large` with content-free
`provider_disclosure`/dimension/required/maximum details on synchronous read paths. Durable
ingestion diagnostics retain only the library error classification. These limits govern the public
payload boundary, not policy heap use or provider-internal allocation.

Canonical ingestion identity, reconciliation, and truth-maintenance planning MUST use point reads
and filtered id-keyset pages of at most 16 rows; it MUST NOT call whole-space export. The
caller-lowerable `IngestionOptions.workLimits` override `IngestionProfile.workLimits`, and
`BatchOptions.workLimits` apply independently to each sequential episode. Defaults are 100,000
distinct stored rows, 64 MiB stable JSON, 100,000 dependency fact nodes, and 500,000 current
premise edges; hard maxima are 1,000,000 rows, 256 MiB, 250,000 nodes, and 1,000,000 edges.
`IngestionReport.work` returns the admitted canonical-planning work and normalized limits. Provider
inference-context assembly MUST independently honor `contextScanLimits` from the profile, per-call
options, or per-episode batch options. It scans through pages of at most 16 rows with the same
100,000/64 MiB defaults and 1,000,000/256 MiB hard maxima as retrieval scans.
`IngestionReport.contextScan` returns exact admitted rows/bytes. A breach is
`result_too_large` with phase `ingestion_context_scan`, settles the already accepted episode at
`inference_failed`, and occurs before disclosure policy or provider invocation.

Automatic post-canonical projection assembly MUST independently honor `projectionScanLimits` from
the profile, per-call options, or per-episode batch options, with the same defaults and maxima. It
MUST use point reads or ascending-ID keyset pages of at most 16 rows for aliases, evidence, support
episodes, and replacement projections; it MUST NOT issue an unlimited relation query or whole-space
export. `IngestionReport.projectionScan` reports exact admitted source, replacement, and generated
projection rows/bytes. A breach is `result_too_large` with phase `ingestion_projection_scan`,
settles the already canonical operation `partial` at `projection_scan_failed`, and commits no
partial projection mutation. Canonical memory remains durable and retryable. Provider execution,
engine-internal work, heap, and an in-flight configured provider batch remain outside all work
reports.

The facade's private storage-driver view requires `limit` on every generic query at compile time.
Completeness scans therefore enter through explicit keyset helpers; point reads use `get`, and
cardinalities use native aggregates. Adapter-local diagnostic/export tooling retains a separate
compatibility boundary and is not callable through `Memory`. Open-time abandoned-operation and
purge recovery uses 16-row upper-bound keysets; active sync recovery reads at most two rows to prove
its single-apply invariant.

## 2. Package and public API

### 2.1 Entry points

| Entry                                 | Runtime exports                                                  | Boundary                                                                              |
| ------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `@astrale-os/temporal-memory`         | `createMemory`, `openSyncBundle`, `MemoryError`, `isRetryable` plus public types | Does not import SurrealDB, WASM, DOM, Chrome APIs, or a provider SDK.                 |
| `@astrale-os/temporal-memory/surreal` | `createSurrealMemoryStorage`, `createSurrealMemoryCapabilities`; Surreal storage/admin/raw-query types | Owns the embedded engine and construction-time database-admin escape hatch.           |
| `@astrale-os/temporal-memory/testing` | `createInMemoryStorage`                                          | Test adapter only; no exported scripted providers, golden runner, or conformance kit. |

`MemoryStorage` is an opaque branded capability with an optional name. The root facade cannot issue
arbitrary storage commands. `SurrealMemoryStorage` is additionally nominal and deliberately has no
raw-query method. `createSurrealMemoryCapabilities` constructs the storage/admin pair specified in
§6.2; an ordinary storage capability cannot later be elevated. The alpha does not offer an
alternative-store authoring interface.

The package's exact pinned runtime pair is:

```json
{
  "@astrale-os/surrealdb-wasm": "3.0.4-astrale.1",
  "surrealdb": "2.0.8"
}
```

This exact pair is one compatibility unit. The WASM package embeds `surrealdb-core@3.0.5`; exact
fork source commit
[`b049a1a`](https://github.com/astrale-os/surrealdb.js/commit/b049a1ace08147b90fb539d4681e2f22890d7eed)
is derived from JavaScript SDK base `64b8f10`. It passes direct/worker Chromium and clean
packed-artifact gates; independent branch/tag CI builds produced byte-identical tarballs and WASM
binaries. The manifest resolves the versioned
[`surrealdb-wasm-v3.0.4-astrale.1`](https://github.com/astrale-os/surrealdb.js/releases/tag/surrealdb-wasm-v3.0.4-astrale.1)
GitHub prerelease asset with package SHA-256
`11a3aef3db9d1d1f771f1bc118d2649a65d4e09fd9b549ad081b6aafb803a09a`; it no longer references local
state. Npm publication and mixed-license approval remain release blockers.

### 2.2 Facade surface

The `Memory` interface groups the following implemented calls:

| Area        | Methods                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| Lifecycle   | `open`, `close`, `inspect`                                                                                    |
| Ingestion   | `remember`, `rememberMany`, `operation`, `retryEpisode`, `reprocessEpisode`                                   |
| Retrieval   | `recall`, `search`, `neighborhood`, `browse`, `snapshot`, `analyze`                                           |
| Incremental | `changes`, `signalChanges`, `registerJournalConsumer`, `acknowledgeJournalConsumer`, `retireJournalConsumer`, `journalConsumers` |
| Signals     | `browseSignals`, `putSignals`, `deleteSignals`                                                                |
| Point reads | `read`, `getEpisode`, `getEntity`, `getFact`, `getDerivation`, `previewEpisodeDeletions`, `previewDerivationWithdrawals`                 |
| Governance  | `deriveFact`, `deriveFacts`, `withdrawDerivation`, `withdrawDerivations`, `correctFact`, `retractFact`, `mergeEntities`, `splitEntityMerge`, `deleteEpisode`, `deleteEpisodes`, `hardPurge`, `resetSpace` |
| Archives    | `export`, `import`                                                                                            |
| Replica sync | `createSyncCheckpoint`, `compactSyncHistory`, `syncHead`, `syncCheckpoint`, `syncChunks`, `syncFrom`, `syncStatus`, `syncConflicts`, `syncConflict`, `resolveSync`, `abortSync` |
| Maintenance | `compactChanges`, `compactSignalChanges`, `rebuildProjections`, `verifyIntegrity`, `stats`                    |
| Events      | `on`                                                                                                          |

`createMemory` validates options synchronously and performs no I/O. `open` is explicit. With
`create: false` or an omitted option, a missing space is `space_not_found`; `create: true` creates
the space. A configured-ontology mismatch fails closed. A schema mismatch also fails closed unless
`migrate: true` explicitly requests the fixed safe registry described in section 6.3. Open options
reject unknown fields and accept an abort signal checked between migration and recovery stages.
Operational methods fail with `not_open` before open or after close.

### 2.3 Input limits and ontology

IDs are opaque non-empty well-formed Unicode strings capped at 256 UTF-8 bytes. Scope and type
strings are trimmed and capped at 128 UTF-8 bytes. Every JSON string and object key must also be
well-formed Unicode; unpaired UTF-16 surrogates fail before hashing or persistence rather than being
silently replaced. JSON input is restricted to finite JSON values, at most 100,000 nodes, depth 64,
and 4,000,000 aggregate UTF-8 string bytes. Text episode content is capped at 2,000,000 UTF-8 bytes.
Evidence/mention excerpts are capped at 4,096 UTF-8 bytes and JSON Pointer strings at 2,048 UTF-8
bytes. Each selector value array is capped at 10,000 entries.

The caller-owned request envelopes for `read`, `recall`, `search`, `neighborhood`, `browse`,
`snapshot`, `analyze`, `changes`, `signalChanges`, and `export` are closed JSON values. Each complete
request MUST be copied and validated in one bounded traversal synchronously at the public call
boundary, before purge coordination, hashing, storage reads, provider work, or any other await. The
snapshot admits at most 1,000,000 JSON nodes, depth 64, and 64 MiB of aggregate UTF-8 string data;
the method-specific selector, scan, graph, result, and archive limits remain independently tighter.
Every enumerable property, array member, and accessor is read exactly once into package-owned data.
Later caller mutation therefore cannot change access authority, filters, temporal view, anchors,
channels, graph seeds, selected IDs, cursors, ordering, budgets, or output limits. Cycles, non-plain
objects, unsupported or unknown properties, malformed JSON, and unreadable accessors fail
`invalid_input` before asynchronous work. A captured `undefined` value on an optional object
property is canonicalized as absence, matching JSON object serialization and ordinary paginated
`cursor: undefined` usage; root or array `undefined` remains invalid. `ReadOptions.signal` remains a
separately copied live cancellation capability rather than JSON data. The
`getEpisode`/`getEntity`/`getFact`/`getDerivation` conveniences inherit the same boundary through
`read`.

The same call-boundary ownership applies to the complete replica-sync control plane:
`createSyncCheckpoint`, `compactSyncHistory`, `syncHistory`, `syncHead`, `syncCheckpoint`,
`syncChunks`, `exportSyncBundle`, `syncFrom`, `syncStatus`, `syncSessions`,
`compactSyncSessions`, `syncConflicts`, `syncConflict`, `resolveSync`, and `abortSync`. Every JSON
request or standalone `AccessContext` MUST use the shared closed, bounded, one-pass snapshot before
queue admission, purge coordination, local storage, or a remote peer call. `ReadOptions` and
`OperationOptions` are closed and copied synchronously; their `AbortSignal` remains a live
capability, while `operationId` is captured as data. The `MemorySyncPeer` itself is also a live
transport capability and is not cloned. Consequently a caller cannot change a scope grant,
confirmation, checkpoint/session identity, strategy, conflict resolution, cursor, compaction
cutoff, or resource ceiling after invocation, including while an earlier queued write is running.
Unknown fields and malformed envelopes fail `invalid_input` before either the local driver or peer
is touched. Method-specific limits on ancestry, chunks, frames, conflicts, and response bytes remain
tighter than the shared envelope ceiling.

The canonical mutation and maintenance plane follows the same ownership rule. `remember`,
`rememberMany`, `retryEpisode`, `reprocessEpisode`, `deriveFact`, `deriveFacts`,
`withdrawDerivation`, `withdrawDerivations`, `correctFact`, `retractFact`, `mergeEntities`,
`splitEntityMerge`, `deleteEpisode`, `deleteEpisodes`, `hardPurge`, `resetSpace`, `import`, and
`rebuildProjections` MUST capture every caller-owned JSON request and option field synchronously
before serialized-queue admission, purge recovery/coordination, request hashing, provider work, or
storage. `OperationOptions.operationId`, ingestion/batch scan and work limits, import mode and
limits, and rebuild selectors are therefore immutable for the call; only the captured
`AbortSignal` remains live. Unknown option or request properties fail `invalid_input` before work,
except malformed archive content retains the `import_invalid`/`result_too_large` taxonomy defined
for import. Later mutation cannot change episode content or identity, authority, revision guards,
derivation premises/conclusions, correction/retraction targets, merge members, deletion/erasure
selectors, confirmations, collision policy, or resource ceilings.

Format-v4 import MUST detach the complete already-bounded document before queueing and validate the
package-owned copy thereafter. The snapshot uses the same one-million-node, depth-64, and
caller-selected archive-byte ceiling as import validation, preserves archive-specific error codes,
and necessarily adds one bounded document copy to this deliberately materialized small-archive
path. It is not permission to raise the 100,000-record/64-MiB hard document limit. Larger or
resumable transfer continues to use `exportSyncBundle`/`openSyncBundle`/`syncFrom`, which retains at
most one admitted chunk body rather than cloning a whole archive.

Ownership begins at `createMemory`. Its root options object MUST be closed and read exactly once per
declared property. `spaceId`, ontology, disclosure-limit scalars, ingestion/retrieval profiles, and
operation timeout MUST be synchronously validated and detached before the facade is returned.
Unknown properties, unreadable accessors, cycles, non-plain JSON values, or later mutation MUST NOT
alter the instance. The captured storage, inference/embedding/reranking provider, policy, clock, id
factory, token counter, and error callback are behavior-bearing capabilities: their references stay
live, but the package MUST NOT reread their properties from the caller-owned root or disclosure
object after construction admission.

Invocation ownership is exhaustive across the public facade. `open` metadata and flags;
management, point-read, retrieval, feed, signal, archive, integrity, and journal options; standalone
point-read access grants; and journal-consumer registration, acknowledgement, retirement, browse,
and compaction requests MUST all cross the same closed one-pass boundary before their first storage
or queue interaction. Nested JSON fields are package-owned for the call, and a caller replacing an
options object's `signal` property later cannot switch cancellation authority; the originally
captured `AbortSignal` object itself remains live. Unknown properties or unreadable accessors fail
`invalid_input`. Captured provider/storage/policy/clock/id/token-counter/peer/listener capabilities
and event callbacks remain live by design and are not JSON-cloned. This closes every public JSON
parameter without pretending that an injected behavior-bearing capability is immutable.

Output ownership is equally explicit. Every JSON data result returned by the `Memory` facade is
detached from caller input, cached space state, storage records, provider responses, and durable
operation replay data before crossing the public boundary. Mutating a returned object MUST NOT
alter later reads, replays, reports, or persistence. Event delivery MUST create an independent
detached payload for each listener, so an earlier listener cannot rewrite what a later listener
observes. Results and events are not promised to be recursively frozen; callers own their copy.
Explicit behavior-bearing capabilities such as peers, providers, storage, listeners, and
unsubscribe functions are outside this JSON result rule.

`putSignals` accepts `1..1,000` inputs. Signal scopes, tags, and each basis/filter array are capped
at 10,000 entries; one normalized signal basis is capped at 10,000 aggregate references. Signal
values use the ordinary bounded JSON contract both individually and in aggregate across one write.
One write is additionally capped at 100,000 aggregate presented scope, tag, and basis entries before
deduplication.

`deriveFact` accepts 1..10,000 unique fact/evidence premises, a bounded rule id/version, exact
non-negative `expectedRevision`, optional inference-provider lineage, and optional `workLimits`.
`deriveFacts` accepts 1..64 such members under one shared revision/access/work envelope; its complete
detached request is additionally capped at 1,000,000 JSON nodes and 64 MiB of aggregate JSON string
bytes. `previewDerivationWithdrawals` and `withdrawDerivations` select at most 1,000 current active
supports by a non-empty bounded rule/conclusion/id/recorded-time filter under one shared
revision/access/work envelope. Preview may optionally require an exact existing revision and returns
a consistency cursor only for a non-empty complete selection.
`previewEpisodeDeletions` and filter-selected `deleteEpisodes` select at most 10,000 visible retained
episodes under the same detached-request and work-limit envelope. Preview may optionally require an
exact existing revision and returns a consistency cursor only for a non-empty complete selection.
`withdrawDerivation`, `withdrawDerivations`, `correctFact`, `retractFact`, single `deleteEpisode`, and
bulk `deleteEpisodes`, plus `mergeEntities` and `splitEntityMerge`, accept the same work limits.
Defaults are 100,000 distinct admitted storage rows,
64 MiB of their stable JSON,
100,000 traversed fact nodes, and 500,000
current premise-to-conclusion edges. Callers may lower those ceilings; hard maxima are 1,000,000
rows, 256 MiB, 250,000 nodes, and 1,000,000 edges. A breach is `result_too_large` with
`phase: 'derivation'`, `dimension`, `required`, and `maximum`, before canonical mutation. Work
limits are admission policy rather than derivation identity, so operation-id replay returns an
already settled semantic result. It never creates entity identities. Conclusions pass the same
ontology, cardinality, JSON, time, and scope validation as asserted facts.

Ontology modes are `open`, `prescribed`, and `hybrid`. Prescribed mode rejects unknown types;
hybrid mode maps configured unknowns to fallback types; open mode accepts normalized proposed types.
Ontology checks occur before candidate-derived canonical mutation. An accepted episode remains
inspectable when later inference or ontology processing fails.

`MemoryFilters` is record-shaped: `episodes`, `entities`, and `facts`. Categorical arrays are
alternatives and dimensions compose conjunctively. Tags expose `all`, `any`, and `none`. Metadata
selection is exact equality on named top-level JSON fields. Instant ranges use inclusive `since`
and exclusive `until`. Fact objects use exact structural JSON equality. Invalid kinds, statuses,
instants, ranges, object variants, and non-JSON metadata fail as `invalid_input`.

## 3. Ingestion and projections

The implemented durable sequence is:

1. Validate input, canonical instants, scopes, JSON, and idempotency identity.
2. Atomically accept the immutable episode with a running operation.
3. Use explicit assertions or authorize and invoke inference.
4. Validate candidates against shape, ontology, and access boundaries.
5. Resolve entities using identifiers and compatible exact aliases; retain ambiguity rather than
   guessing.
6. Reconcile facts by semantic key, valid time, cardinality, and explicit intent.
7. Atomically commit entities, facts, evidence, lifecycle, derivation invalidations, cascading
   unsupported-fact transitions, and operation state.
8. Build lexical, summary, and optional embedding projections after canonical commit.

Projection failure leaves accepted evidence and canonical records durable and marks the operation
partial. Open marks only ownerless or provably abandoned pending/running operations partial and
retryable; it MUST leave an operation unchanged while its facade-owner lease is held, and it does
not automatically invoke remote providers. If termination occurs after episode acceptance but
before canonical integration, reopen preserves the accepted episode, records the interrupted
operation, and requires explicit `retryEpisode` with a fresh operation id. A termination before the
accept transaction leaves neither episode nor operation; a termination after a settled operation
commit permits the method's ordinary request-bound replay semantics.

Idempotency is `(spaceId, idempotencyKey)`. An omitted key defaults to the explicit episode id or a
generated id. Repeating the same key and immutable content returns the existing episode/report;
different content produces `idempotency_conflict`.

Writes are serialized per facade. `rememberMany` is sequential; its `BatchOptions` contains an
optional abort signal and per-episode `workLimits`. The alpha exposes no atomic-batch or
configurable-concurrency promise.

Lexical projections use deterministic text. Embedding projections include provider/model/dimension
generation identity and exact scope identity. Rebuild can select lexical, embedding, or summary
kinds and target ids. A rebuild with no target-id selector is a full-set rebuild. It writes every
new row under a fresh per-kind `setId`; lexical and vector search continue to filter the old active
set while those rows are built. Once every row for a kind succeeds, one revision- and
canonical-revision-guarded space commit changes that kind's active set reference. Multiple
successful requested kinds activate in the same commit. A failed kind retains its previous set;
rows from failed or superseded sets are never searched and are removed afterward in bounded pages.
`inspect`, `stats`, and the maintenance report expose the active set id, generation, canonical
source revision, activation time, and operation lineage. They count interrupted/inactive rows as
stale until a later full rebuild compacts them.

Projection maintenance is single-flight per space across full and target-selected requests, all
kind selections, and all facades. Admission MUST first establish that the caller operation id is
unused, pin the physical space revision, and query at most two `pending`/`running` rebuild
operations. An existing rebuild produces retryable `conflict` naming that active operation before
target reads, provider work, or staging. If two callers observe no active rebuild at one revision,
the guarded commit of the fresh running operation is the admission CAS: exactly one may bind an
operation row and the loser MUST leave no operation or projection residue. An unbound losing id is
still unused and may be submitted after the winner settles; a persisted binding remains
fresh-only. This fence is required so inactive-set cleanup can never erase another live rebuild's
hidden generation.

`RebuildRequest.scanLimits` is a closed archive-limit-shaped admission object with defaults of
100,000 rows and 67,108,864 exact stable-JSON bytes and hard maxima of 1,000,000 rows and
268,435,456 bytes. A full rebuild MUST read eligible episodes, entities, and facts through advancing
16-row ascending-id keysets and MUST stage at most one canonical target at a time. A targeted rebuild
MUST accept at most 10,000 unique selector ids, point-read only those targets, and preserve its
existing replacement atomicity. Entity aliases, fact evidence, provenance episodes, and existing
target projections MUST be obtained through point reads or advancing 16-row filtered keysets rather
than whole-table export/query.

Every returned source/dependency/replacement row and every generated projection row MUST be admitted
before commit. `MaintenanceReport.scan` reports their exact aggregate rows/bytes and effective
limits; `scanned` remains the count of eligible canonical targets. A breach is `result_too_large`
with `{ phase: 'projection_scan', dimension: 'records' | 'bytes', required, maximum }`. A targeted
request MUST NOT replace selected rows after such a failure. A full rebuild may have already staged
earlier targets under its new hidden set, but MUST NOT activate any requested kind; it MUST durably
settle the operation `partial`/`projection_scan_failed`, keep the prior active sets authoritative,
and leave inactive rows for the next full rebuild to reclaim. Stable-byte admission bounds facade
materialization, not heap or provider allocation; one 16-row storage page or one configured provider
batch may already be materialized.

The rebuild operation remains non-terminal through activation and its bounded cleanup attempt. If
activation is durable but cleanup is aborted, conflicted, or fails, the active set remains valid and
the operation settles `partial`/`cleanup_deferred`/retryable with inactive rows in
`staleRemaining`. A later full rebuild reclaims them. It MUST NOT reject after persisting a terminal
success merely because post-activation cleanup failed.

Inactive-set cleanup MUST use pages of at most 16 rows and remain cancellation/operation-timeout
bounded. It is post-activation reclamation rather than projection-input completeness work and is not
included in `MaintenanceReport.scan`. `staleRemaining` MUST use storage aggregates or another
bounded-memory calculation; it MUST NOT reload every projection row merely to count inactive state.
If an owning realm terminates after staging but before activation, open-time owner recovery marks
its operation `partial`/`interrupted` without changing the prior active set. The inactive rows remain
observable and unsearchable; a later admitted full rebuild may activate its own complete set and
reclaim both the abandoned set and the superseded active set in bounded pages.

A target-selected rebuild cannot define a complete generation. It atomically replaces only the
successful target/kind rows inside the current active set and preserves the prior rows for a kind
whose provider work failed. If the configured embedding generation differs from the active set, a
target-selected rebuild fails that kind and requires a full-set rebuild. Existing schema-v7 spaces
without set references keep their legacy `setId = NONE` rows active until their first successful
full rebuild.

## 4. Retrieval, snapshot, and analysis

### 4.0 Checked point reads

`read({ kind, id, access, scanLimits })` supports `episode`, `entity`, `fact`, and `derivation`.
It returns `{ value, snapshotRevision, generatedAt, scan }`. Missing, deleted, unsupported, or
access-hidden values return `value: null` without weakening the scan/revision contract. Episode and
derivation reads admit their addressed row. Entity reads additionally scan visible aliases and
active visible evidence, point-load each distinct retained support episode once, and assemble
detached excerpts. Fact reads likewise scan active visible evidence and distinct episodes, current
visible derivation revisions, and lifecycle. Every indexed one-to-many relation advances through
16-row ascending-ID keysets; no point-read path issues an unlimited storage query or whole-space
export.

`scanLimits` defaults to 100,000 physical rows/64 MiB of exact stable-JSON row bytes and cannot
exceed 1,000,000 rows/256 MiB. Rows count before final visibility/output assembly. A breach is
`result_too_large` with
`{ phase: 'point_read_scan', dimension: 'records' | 'bytes', required, maximum }`; no partial value
is returned. One 16-row page may already be materialized before admission, and stable JSON bytes are
not a heap, engine-work, or latency measure. The final incarnation/revision bracket detects but does
not prevent concurrent mutation and is not a database snapshot.

`getEpisode`, `getEntity`, `getFact`, and `getDerivation` are convenience projections of the same
checked implementation. Their optional `PointReadOptions` accepts `scanLimits` and `signal`; they
return only `PointReadResult.value` and therefore intentionally omit work/lineage. A caller needing
observable work MUST use `read`; one needing a reusable complete graph MUST use `snapshot`.

### 4.1 Recall and search

The retrieval channels are exact, lexical, semantic, graph, and temporal. Defaults enable exact,
lexical, graph, and temporal; semantic is enabled when an embedding provider is available. Each
channel produces ranks that are fused with weighted reciprocal-rank fusion:

| Setting         | Default                                                           |
| --------------- | ----------------------------------------------------------------- |
| Candidate limit | `100`                                                             |
| Result limit    | `20`, maximum `200`                                               |
| Graph depth     | `1`, range `0..3`                                                 |
| RRF constant    | `60`                                                              |
| Weights         | exact `2`, lexical `1`, semantic `1`, graph `0.8`, temporal `0.5` |

RRF contributions are ranking signals, not confidence or truth scores. Selection returns structured
entities, facts, evidence excerpts, paths, conflicts, deterministic citations, an explanation, a
rendered projection, degraded-capability notices, `snapshotRevision`, and `generatedAt`. Each
`EpisodeExcerpt.fragments` entry carries the selected evidence id, relation, anchor, derived excerpt,
and truncation flag. Each `Citation.sources` entry additionally carries its episode id. Multiple
selected occurrences in the same episode remain distinct; `episodeIds` is retained as a
deduplicated convenience field. Source fragments and citation source entries share the global
`budget.maxEvidence` allocation and cannot bypass it.
`search.target` is applied before final top-k.

Recall captures one current-view evaluation instant before constructing its universe and brackets
all canonical queries, lexical/vector reads, graph assembly, provider-backed query embedding or
reranking, and rendering with the space incarnation and revision. A generation or revision change
causes retryable `conflict`; no mixed result is returned. `search` carries the same context lineage,
and `neighborhood` projects the same `snapshotRevision` and `generatedAt`. Physical revisions that
do not change retrieval meaning, including signal writes, still advance this lineage. This is an
optimistic mutation detector, not a database-native read transaction or a claim that a failed call
performed no remote provider computation.

`RecallRequest.scanLimits` is a closed physical-admission object with the archive-limit shape. It
defaults to 100,000 rows and 67,108,864 exact stable-JSON row bytes and has hard maxima of 1,000,000
rows and 268,435,456 bytes. Recall MUST read each contributing canonical kind through advancing
16-row ascending-id keysets. Every returned row counts before visibility, temporal, latest-revision,
or induced-graph filtering. Surreal BM25 and exact-cosine queries bind allowed scopes before
ordering and limiting; every returned projection row also counts, and each native search limit MUST
be no greater than the remaining row budget plus one. Equivalent access and episode/evidence
predicates SHOULD execute in storage and MUST still be rechecked above it.

`ContextBundle.scan` reports exact admitted rows/bytes and the effective limits; `search` exposes the
same report in its context and `GraphNeighborhood.scan` projects it from its underlying recall. A
breach is `result_too_large` with
`{ phase: 'recall_scan', dimension: 'records' | 'bytes', required, maximum }`; partial retrieval
output MUST NOT be returned. These limits bound cumulative facade transfer and temporary retained
materialization, not heap bytes, engine-internal scan work, disk reads, or latency. One 16-row
canonical page and one bounded native lexical/vector result can materialize before per-row admission.

Graph expansion MUST index visible fact adjacency and episode-to-entity evidence once, then traverse
those indexes under the existing depth and candidate ceilings. It MUST NOT rescan the complete fact
or evidence population for every visited entity or episode. Episode filters reduce eligible
evidence before fact/entity assembly. Fact filters apply before selection or browse return.
Supplying an entity filter produces an induced entity-bounded result: a fact with a filtered subject
or entity object is removed.

### 4.2 Browse

`browse` returns typed pages of episodes, entity views, or fact views. It accepts the common access,
temporal, filter, and conflict controls plus `newest`, `oldest`, or `id` order. The default page size
is `50`; the accepted range is `1..200`.

The opaque v2 cursor binds the private space incarnation, normalized access scopes, canonicalized
kind/order/defaulted-view/filter/conflict request, last id, space revision, and one current-view
evaluation instant. Page size is deliberately excluded and may change between pages. A caller
cannot reuse a continuation after changing access or selection semantics; destructive
reset/recreate cannot alias a prior cursor even at the same revision. A mutation invalidates an old
cursor with retryable `conflict`. Clock passage alone does not change a current-view result between
pages because the cursor carries the first page's evaluation instant. Every page returns
`snapshotRevision` and `generatedAt`. Browse compares both generation and revision before and after
materialization. This detects mutation; it does not turn the underlying multi-query read into a
database snapshot. Pre-v2 browse cursors are invalid alpha input rather than a compatibility format.

`BrowseRequest.scanLimits` has the same defaults and hard maxima as recall and is deliberately an
execution ceiling rather than cursor selection state, so it may change between pages. Every
`BrowsePage.scan` reports exact physical rows, stable-JSON bytes, and effective limits. A breach is
`result_too_large` with
`{ phase: 'browse_scan', dimension: 'records' | 'bytes', required, maximum }`; a partial page MUST
NOT be returned.

Episode browse has a page-native fast path for current, valid-at, and history views when neither
episode nor source metadata equality requires residual evaluation. It pushes exact access-scope
containment, ids, kind, source identity, retention/sensitivity, tag all/any/none, and source/episode
time bounds into storage, orders there, seeks lexicographically after the cursor boundary, and reads
at most the lesser of `limit + 1` and the remaining row budget plus one. A resolved cursor boundary
also counts. All three orders are supported. String keys use Unicode scalar-value ordering,
matching SurrealDB's default non-`COLLATE` order and the in-memory driver without ambient locale
dependence. Known-at/residual episode and entity/fact browse MUST assemble their complete eligible
universe from the same admitted 16-row canonical scans as recall before sorting and slicing. Each
continuation therefore performs and reports a new bounded scan. On the reference IndexedDB engine,
descending generic queries deliberately use
SurrealQL `WITH NOINDEX`: the indexed route failed browser acceptance with an invalid key range.
These contracts bound transferred/materialized facade rows but do not claim bounded database scan
cost or latency.

### 4.3 Snapshot

`snapshot` materializes the complete selected visible universe as detached episodes, entity views,
fact views, raw evidence links (including `contradicts`), derivations, mentions, target-scoped lifecycle records,
ontology, counts, temporal view, and `snapshotRevision`. It reads the space generation and revision
before and after all component queries and returns retryable `conflict` if either differs. Output is
deterministically id-ordered. Current merge redirects and temporal/support filtering are already
applied; all current-validity checks use the single `generatedAt` evaluation instant. A consumer
does not receive a raw storage dump.

`maxRecords` defaults to `50,000` and accepts `1..1,000,000`. The count is top-level episodes,
entities, facts, evidence links, derivations, mentions, and lifecycle transitions. Exceeding it returns
`result_too_large`; partial snapshots are forbidden. `scanLimits` independently defaults to 100,000
physical rows and 67,108,864 stable-JSON bytes and accepts hard maxima of 1,000,000 rows and
268,435,456 bytes. Snapshot MUST read every contributing canonical kind through advancing 16-row
ascending-id keysets. Every row returned by storage counts before visibility, temporal, or
induced-graph filtering; access and other equivalent filters SHOULD be pushed down and MUST still be
rechecked. The returned `scan` reports exact admitted rows/bytes and effective limits. A breach is
`result_too_large` with
`{ phase: 'snapshot_scan', dimension: 'records' | 'bytes', required, maximum }`. These limits bound
cumulative transfer and retained facade materialization, not JavaScript heap bytes, database work,
or latency; one in-flight page is materialized before its rows can be admitted. Like `browse`, the
revision bracket detects change but is not a database-native snapshot transaction.
Every successful snapshot also returns `changesCursor`, bound to the same space incarnation,
normalized access scopes, and `snapshotRevision`. A downstream persists it and begins `changes()`
strictly after the complete baseline rather than rescanning older journal rows. Snapshot filters and
temporal view are not encoded in the cursor; the consumer remains responsible for applying its own
selection semantics to later affected targets.

### 4.4 Analyze and algorithm lineage

`analyze` operates on the same access-filtered temporal universe as retrieval and brackets its read
with a space-generation and revision check. It reports:

- visible episode/entity/fact, active/withdrawn-evidence, and active-derivation counts;
- source-kind and predicate distributions;
- zero, derived-only, single, and multiple visible-source corroboration counts;
- conflict groups and cardinality-one valid-time overlaps;
- connected components, relation-edge count, unique directed arc count, bounded density, degree,
  in-degree, out-degree, and PageRank;
- current visible signal counts partitioned into active, expired, and withdrawn states and by
  namespace, restricted to targets in the selected temporal universe; and
- isolated-entity, derived-only, single-source, conflict, and temporal-overlap findings.

With no seeds the exact graph lineage identifier is `structural-pagerank-v1`. Supplying 1..1,000
unique visible entity seeds with positive finite relative weights selects
`personalized-pagerank-v1`. Weights are normalized; both teleport and dangling mass use that
distribution, so inaccessible, filtered, or unknown seed ids fail `invalid_input` rather than
widening the graph. Both modes are deterministic PageRank over visible entity-valued fact edges and
report personalization, seed count, damping, iterations, convergence, and tolerance. They are
implemented in TypeScript, not by Surreal graph traversal. Findings describe structure in one
visible temporal snapshot; they do not establish source authority, factual truth, causality, or
model confidence. Signals are queried inside the same revision bracket but do not alter graph
metrics or findings.

`top` defaults to 20, accepts 1..100, and independently caps `graph.topEntities` and `findings`.
Finding order is warning before info, then Unicode-scalar code order, lexicographic item kind/id
sequence, item count, evidence-id sequence, evidence count, and message. `findingSummary.byCode`
counts the complete selected finding population; `total` is its sum, `returned` equals
`findings.length`, and `truncated` is exactly `total > returned`. The implementation MUST retain only
a bounded ordered finding sample and MUST NOT rescan all derivations per fact or sort all fact
timestamps merely to compute report extrema.

Parallel entity-valued facts remain distinct PageRank links and contribute separately to `edges`,
in-degree, and out-degree. `arcs` deduplicates exact directed source/target pairs. Density is
`arcs / nodes²`, including the possible self-arc in the denominator, and is therefore bounded to
`[0,1]` rather than becoming greater than one in a multi-edge graph.

`budgets` is a closed optional object. Storage-scan defaults and hard caps are respectively
100,000/1,000,000 physical rows and 67,108,864/268,435,456 bytes. Analysis MUST read canonical kinds
through advancing 16-row ascending-id keysets and signals through advancing 16-row
key/version/id keysets. Every row returned by storage is admitted before visibility,
temporal, latest-revision, or induced-graph filtering. `scannedBytes` is the sum of the exact UTF-8
length of each admitted row's stable JSON encoding. Access scopes and any other filter proven
equivalent to the facade predicate SHOULD execute in storage and MUST still be rechecked above it.
The limits bound cumulative transfer and retained facade materialization, not JavaScript heap bytes,
database work, or latency; the current storage page can be materialized before admission rejects
one of its rows.

Algorithm defaults and hard caps are respectively 1,000,000/5,000,000 visible records consumed by
report computation, 100,000/250,000 graph nodes, 500,000/1,000,000 entity-valued edges,
50,000,000/250,000,000 admitted PageRank steps, and 1,000,000/10,000,000 cardinality-one temporal
pair comparisons. The analyzed-record count is the sum of selected episodes, entities, facts,
evidence links, derivation revisions in the view, and latest visible signal revisions. Admitted
PageRank steps are `(nodes + edges) * requested maximum iterations`; the report records actual scan
rows/bytes, analyzed records, steps from completed iterations, every comparison count, and all
effective limits. A scan breach is `result_too_large` with
`{ phase: 'analysis_scan', dimension: 'records' | 'bytes', required, maximum }`; any breach fails
before a partial report is returned. The space incarnation and revision MUST be rechecked after all
pages and computation, so a concurrent write yields retryable `conflict` rather than a mixed report.

### 4.5 Semantic revision feed

`changes(request)` is the implemented durable incremental API. The public contracts are:

```ts
type MemoryChangePhase = 'accepted' | 'canonical' | 'governance' | 'import' | 'purge' | 'sync'

interface MemoryChangePartition {
  scopes: readonly string[]
  affected: {
    episodeIds: readonly string[]
    entityIds: readonly string[]
    factIds: readonly string[]
  }
  invalidated?: true
}

interface MemoryChange {
  spaceId: string
  revision: number
  recordedAt: string
  operationId: string
  operationKind: OperationKind
  phase: MemoryChangePhase
  partitions: readonly MemoryChangePartition[]
}

interface ChangesPage {
  changes: readonly MemoryChange[]
  nextCursor: string
  throughRevision: number
  currentRevision: number
  changesCompactedThrough: number
  hasMore: boolean
}
```

The default `limit` is `100`; the accepted range is `1..1,000`. It bounds stored semantic revisions
scanned before access filtering, not visible result count. Results are ascending by revision. A page
may therefore have zero `changes` and `hasMore: true`. Callers continue with the always-present
`nextCursor` until `hasMore` is false, at which point `throughRevision` equals the read watermark's
`currentRevision`.

The implementation reads the space revision before and after the indexed journal query and returns
a retryable `conflict` on any concurrent revision. This bracket is necessary because hard purge may
rewrite historical journal rows; it detects mutation but is not a database-native read snapshot.

The opaque v2 cursor binds its `changes` feed discriminator, `spaceId`, a private random
space-incarnation nonce, the exact normalized `allowedScopes`, and the last scanned revision. A
signal-feed cursor fails closed as invalid input rather than aliasing a semantic acknowledgement.
A different space/incarnation, different
access partition, or future revision fails with `conflict` and
`details: { requiresSnapshot: true }`. Reset/recreate therefore cannot alias an old cursor even when
timestamps repeat. A cursor is consumer/access-state and MUST NOT be reused after changing access.
The supported bootstrap is `snapshot(...).changesCursor`. Omitting a cursor intentionally scans from
the current space's creation only while `changesCompactedThrough === 0`; otherwise revision zero is
behind the retained floor and the call requires a fresh snapshot. Pre-v2 semantic/signal feed
cursors are invalid alpha input; after upgrade a consumer takes the corresponding fresh
`snapshot`/`browseSignals` baseline instead of guessing which legacy feed a structurally ambiguous
v1 token represented.

One `tm_change` record is committed atomically with each semantic canonical revision. Episode
acceptance and later canonical integration are separate phases. Governance includes correction,
retraction, merge/split, and soft deletion. Non-empty import emits one fresh import change instead of
importing source journal history. Projection/rebuild writes, operation-status writes, purge-marker
start, signal writes/withdrawals/purges, and no-op canonical/import phases advance the space revision
without a semantic row. The storage boundary rejects any canonical record mutation without its
semantic metadata and rejects malformed, duplicate-scope, empty, or identifier-bearing invalidation
partitions. It also rejects malformed signal revision lineage and prevents signal puts from sharing
a canonical semantic commit.

Each partition has one exact required-scope set. The facade removes invisible partitions before
return and removes the whole change when none remain. `invalidated: true` requires all affected-ID
arrays to be empty. Hard purge rewrites or deletes older change rows that named erased targets and
atomically appends content-free invalidations for their affected scope partitions. Consumers holding
an earlier cursor receive that purge revision and rebuild the visible partition from `snapshot`;
consumers starting later cannot recover purged IDs from affected-target fields. `operationId` is
retained operational lineage; every caller-supplied value MUST be opaque and non-sensitive and MUST
NOT encode content or target identifiers. Hard purge cannot scrub information deliberately encoded
inside such an identifier.

The implemented maintenance contract is:

```ts
type CompactChangesRequest = {
  confirmSpaceId: string
  expectedRevision: number
  maxChanges: number
  dryRun?: boolean
} & (
  | { consumerCursors: readonly string[]; throughRevision?: never }
  | { registeredConsumers: true; consumerCursors?: never; throughRevision?: never }
  | { throughRevision: number; consumerCursors?: never; registeredConsumers?: never }
)

interface CompactChangesReport {
  dryRun: boolean
  requestedThroughRevision: number
  previousCompactedThrough: number
  compactedThrough: number
  batchChanges: number
  deletedChanges: number
  hasMore: boolean
  revision: number
}
```

Exactly one watermark source is required. `registeredConsumers: true` reads every active local
consumer record for the semantic journal and uses their minimum cursor revision. Zero active
consumers fails with `invalid_input` and `requiresConsumerRegistration`; the package never treats an
empty registry as permission to delete everything. The plan reads the per-journal registry epoch
before and after its bounded consumer scan, checks the space metadata revision, and guards the
compaction transaction with that exact epoch. Concurrent registration, acknowledgement, or
retirement therefore produces retryable `conflict` without deleting history.

`consumerCursors` remains a stateless mode for checkpoints owned by an external system. It accepts
`1..1,000` durable semantic-feed cursors, validates each feed discriminator, space incarnation,
revision, and retained floor, and uses their minimum revision. This prevents host-side cursor
decoding and arithmetic but cannot prove that the host supplied every live external consumer.
`throughRevision` remains an expert override and may strand either registered or external
consumers; it is mutually exclusive with both safe modes. The request and any cursor array are
detached before the operation enters the facade queue, so later mutation cannot retarget
destructive maintenance. `requestedThroughRevision` reports the effective derived or explicit
watermark without disclosing cursor tokens.

`maxChanges` is required and accepts `1..1,000`. The facade reads at most `maxChanges + 1` indexed
rows above the prior floor and at or below the requested watermark. If more remain, the batch floor
is the last selected semantic revision; otherwise it advances through the requested revision,
including non-semantic gaps. `dryRun` returns that projected batch without mutation. An applied
batch atomically deletes `tm_change` rows at or below the new floor, persists the monotonic floor in
`tm_space`, and increments the space revision without a semantic row. Exact space confirmation and
expected revision prevent retargeting. Compaction cannot run during purge recovery.

Across independent persistent clients, two non-dry-run requests that would both advance the same
journal floor from one `expectedRevision` MUST have at most one winner. The winner deletes exactly
its admitted batch and advances only that journal's floor in its single revision-guarded commit. The
loser returns retryable `conflict` and MUST NOT delete a row, advance either floor, or increment the
revision. The package does not silently reread, replan, or retry. An explicit retry starts from the
new revision and floor. This contract applies independently to semantic and signal compaction; a
commit for one journal MUST NOT alter the other journal or its floor.

A cursor at `compactedThrough` is valid because it has acknowledged every removed revision. A cursor
below the floor, or no cursor after the floor exceeds zero, fails with `conflict` and
`details: { requiresSnapshot: true, changesCompactedThrough }`. Stateless cursor mode chooses the
minimum supplied acknowledgement; the trusted host MUST supply every external consumer it intends
to preserve. Registered mode instead owns local enumeration and explicit retirement as specified
below. Neither mode provides automatic retention, lease expiry, or a cross-device cursor service.
`stats` reports retained `changes` and `changesCompactedThrough`.

The journal is not canonical evidence, factual support, salience, or a retrieval/decision/response
trace. It is excluded from format-v4 archives; import creates local lineage. `stats.changes` reports
stored journal rows. There is no automatic retention or push subscription.

#### 4.5.1 Durable local journal consumers

The public lifecycle is shared by semantic and signal journals:

```ts
type JournalKind = 'semantic' | 'signal'

interface JournalConsumer {
  id: string
  journal: JournalKind
  state: 'active' | 'retired'
  cursor: string
  throughRevision: number
  registeredAt: string
  acknowledgedAt: string
  retiredAt?: string
}

registerJournalConsumer({ id, journal, cursor }): Promise<JournalConsumer>
acknowledgeJournalConsumer({ id, journal, cursor }): Promise<JournalConsumer>
retireJournalConsumer({ id, journal }): Promise<JournalConsumer>
journalConsumers({ journal, state?, cursor?, limit? }): Promise<JournalConsumersPage>
```

All request envelopes are closed and synchronously detached before entering the facade queue.
Identifiers are non-empty, well-formed Unicode bounded to 128 UTF-8 bytes and MUST be opaque and
non-sensitive. A registration cursor MUST be a feed-discriminated v2 cursor for the selected
journal, current space incarnation, and retained floor. Identical active registration replays
without a write; another checkpoint or a retired tombstone with that identifier fails with
`idempotency_conflict`.

Acknowledgement validates the current feed, generation, floor, and exact normalized access scopes.
It MUST advance monotonically; regression fails `invalid_input`. Changing access scopes also fails
and requires explicit retirement plus a fresh consumer identifier and baseline, because newly
visible history cannot be inferred from an old restricted checkpoint. Exact same-cursor replay is a
no-op. Acknowledging a retired or unknown consumer fails. Registration, advancing acknowledgement,
and retirement each atomically update the consumer row and its journal epoch through exact metadata
guards; an independent writer can have only one winner and retryable losers leave no partial row.

Retirement is explicit, durable, and idempotent. It immediately removes the consumer from registered
compaction minima but retains a tombstone; identifiers cannot be reused. Each journal admits at most
1,000 active plus retired records. There is no wall-clock lease, implicit expiry, or tombstone
reclamation in this version. This deliberately prevents a suspended or offline consumer from
silently authorizing data loss; hosts that need high consumer churn require a future incarnation-
safe reclamation policy.

`journalConsumers` defaults to active records, accepts `state: 'active' | 'retired' | 'all'`, and
uses `limit` `1..100` with default 50. Its opaque continuation binds the space incarnation,
journal, state filter, metadata revision, and last consumer identifier. Any facade commit between
pages—logical, consumer, sync, or other metadata-only work—invalidates the continuation with
retryable `conflict`; the caller restarts. The scan is bounded to `limit + 1` rows ordered by indexed
consumer identity.

Consumer rows and epochs are adapter-local operational metadata. They are not canonical evidence,
signal content, journal events, format-v4 archive content, or replica-sync records. Hard purge
retains them because its content-free journal invalidation must reach existing consumers;
destructive space reset removes them. `verifyIntegrity` scans them under its ordinary row/byte
limits, validates physical identity, epoch ownership, cursor lineage, and hard cardinality, and
reports an active checkpoint below an expert-advanced floor as a warning.

### 4.6 Scoped signals and downstream computation

Arbitrary graph and logical computation belongs downstream and consumes `snapshot`; storage-driver
access is not an extension API. The implemented signal plane lets that computation persist scoped,
non-epistemic output without turning it into a fact, evidence edge, lifecycle transition, semantic
change, or hidden retrieval weight.

The public shape is:

```ts
type MemorySignalTarget = { kind: 'episode' | 'entity' | 'fact'; id: string }
type MemorySignalBasis = {
  episodeIds: readonly string[]
  entityIds: readonly string[]
  factIds: readonly string[]
}

type MemorySignal = {
  id: string
  spaceId: string
  key: string
  version: number
  namespace: string
  slot: string
  target: MemorySignalTarget
  producer: { kind: 'manual' | 'algorithm'; id: string; version: string }
  scopes: readonly string[]
  tags: readonly string[]
  basis: MemorySignalBasis
  inputRevision: number
  recordedRevision: number
  basisView: TemporalView
  recordedAt: string
  supersedes?: string
} &
  (
    | { state: 'active'; value: JsonValue; expiresAt?: string }
    | { state: 'withdrawn'; withdrawalReason?: string }
  )
```

Logical identity is a domain-separated SHA-256 digest over space, namespace, slot, producer kind/id,
target kind/id, and exact normalized scopes. Producer version, tags, basis, value, expiry, and state
belong to a revision and are deliberately excluded, so a new algorithm version or cluster assignment
supersedes the same logical signal. Exact scopes remain in the key: different disclosure partitions
are independent logical signals and a host moving a recommendation between partitions must withdraw
the obsolete partition explicitly. The deterministic revision ID is
`signal_<key>_<version padded to 8 digits>`; versions start at one, are contiguous, and point to the
immediately preceding ID.

`browseSignals`, `putSignals`, and `deleteSignals` accept closed JSON request envelopes. Each
complete request MUST be copied and validated in one bounded traversal synchronously at the public
call boundary, before the first asynchronous read or facade-queue entry. The snapshot admits at
most 1,000,000 JSON nodes, depth 64, and 64 MiB of aggregate UTF-8 string data; the operation-specific
signal, membership, value, page, and work ceilings below remain independently tighter. Every
enumerable property, array member, and accessor is read exactly once into package-owned data. A
cycle, non-plain object, unsupported property, malformed JSON value, or unreadable accessor fails
`invalid_input` before storage work; a changing accessor contributes only its first admitted value.
Later caller mutation cannot change the access partition,
filter, target, producer, basis, scopes, tags, value, expiry, revision, or destructive mode that the
operation observes. `ReadOptions.signal` remains a live cancellation capability and is copied by
reference separately from the JSON request.

`putSignals` requires `access`, exact non-negative `expectedRevision`, optional `basisView` (default
`current`), optional `basisScanLimits`, and `1..1,000` active inputs. `slot` defaults to `default`;
tags and every basis list are normalized sorted sets. Algorithm producers require a non-empty basis.
One revision-bracketed, storage-neutral addressed closure validates that every target and declared
basis ID exists and is visible in the chosen temporal view. It loads only the requested records and
the provenance needed to decide those records: temporal lifecycle, visible evidence and rule
support, active merge components for current entity identity, incident facts needed to establish an
entity, and basis-episode aliases and mentions needed for entity grounding. Scalar predicates are
chunked to at most 1,000 values and every query advances in at most 16-row ID keysets. Unrelated
records are never enumerated. Every physical row returned by every addressed query, including a row
returned by two distinct provenance predicates, is admitted with its exact stable-JSON bytes before
semantic filtering. `basisScanLimits` defaults to 100,000 rows/64 MiB and cannot exceed 1,000,000
rows/256 MiB. A breach fails `result_too_large` with `phase: 'signal_basis_scan'`, exact
dimension/required/maximum, and no signal or journal mutation. `PutSignalsReport.basisScan` returns
exact admitted work and effective limits. The plan is sparse with respect to the whole space, but
its work remains proportional to the addressed records' merge, support, and incident-fact closure;
a high-degree entity or long history can therefore reach the explicit ceilings, and the contract is
not a database-latency guarantee. Signal scopes must be caller-visible and contain the union of
every target and basis episode scope plus every target and basis fact support scope. Entity IDs have
no independent scope record; every entity target and every entity basis ID therefore additionally
requires a declared basis episode or fact connected through visible alias, mention, evidence, or
fact adjacency. This prevents a private entity-only inference from being written into a
less-restricted signal. Duplicate logical keys in one batch fail. Any revision drift fails
retryably; the facade never rebases an analyzed result. One successful batch atomically writes at
`recordedRevision = inputRevision + 1`, advances the space revision without a `tm_change` row, and
writes one separate `tm_signal_change` row at that same revision.

`browseSignals` defaults to current active, non-expired logical signals, newest first, with page size
`100` and range `1..200`. `revisionView: 'history'` returns immutable revisions and does not hide old
expiry. `includeExpired` applies to current active rows. Filters cover keys, namespaces, slots,
producer IDs/versions, exact targets, states, tag `all`/`any`/`none`, overlap for each supplied basis
kind, recorded time, and expiry time. Current mode selects the global latest revision for every key
before access, state, expiry, and selector filtering; it never falls back to an older visible or
matching revision. The response returns detached signals, exact `total`, `snapshotRevision`, stable
`generatedAt`, an always-present `signalChangesCursor`, and an optional page cursor. The page cursor
binds space incarnation, normalized access,
canonicalized request (except page size), snapshot revision, expiry evaluation instant, and last ID.
Changing the request/access or any space mutation returns `conflict` rather than mixing pages.
`maxBytes` defaults to 16 MiB, accepts `1..64 MiB`, and may change with page size between cursor
calls. `byteLength` is the exact UTF-8 length of canonical JSON including itself. The facade scans
`tm_signal` in `(logical_key ASC, version DESC, external_id DESC)` keyset pages of at most 16 rows,
pushes access plus immutable key/namespace/slot/producer/target identity filters, retains at most
`limit` lightweight ordering candidates, and point-fetches selected values one at a time. If the
first ordered result cannot fit, the call fails `result_too_large` with required/allowed bytes; a
later boundary returns a cursor and never skips the record. Exact total/latest selection remains
O(n), and the page bound is not a database-scan latency guarantee.
A non-empty constrained current, active, non-expired request also returns
`targetSelectionCursor`. It binds space incarnation, normalized access, canonical filter, snapshot
revision, expiry evaluation instant, and a domain-separated SHA-256 commitment to every matching
signal revision ID—not merely the current page. Version 2 folds deterministic key-ordered IDs
through fixed 1,000-ID chunks and a final count, bounding commitment memory. Version-1 tokens
require a fresh signal baseline. Empty, unconstrained, history, expired-inclusive, and withdrawn
selections do not receive this target-selection cursor. The cursor is a consistency token, not
authorization; the trusted host still invokes `deleteEpisodes` or `hardPurge` explicitly.

`deleteSignals` requires `withdraw` or `purge`, a non-empty `SignalFilter`, exact
`expectedRevision`, and `maxMatches` in `1..10,000`. It selects globally current, caller-visible
logical keys; absent `states` means active only. Withdrawal selects active rows and appends one
tombstone revision per key with a shared new recorded revision and optional reason. Purge deletes
every retained revision of the selected keys in one CAS transaction. Purge `maxRevisions` defaults
to `10,000`, accepts `1..100,000`, and is invalid for withdrawal. A native filtered count MUST
satisfy that guard before one logical-key range deletion; implementations MUST NOT assemble an
unbounded per-revision delete list. Zero matches is `not_found`; a result above either guard is
`result_too_large`. These mutations are not replayable operations and do not emit semantic changes.
Each atomically writes a scope-partitioned signal-change row with action `withdraw` or `purge`.
`putSignals` scans prior history only for its at-most-1,000 addressed keys and uses the same 16-row
latest-revision keyset.

Across independent persistent clients, two signal deletions using the same preview revision MUST
have at most one winner. The loser is retryable `conflict`; withdrawal MUST append exactly one
tombstone revision and one `withdraw` journal row, while purge MUST erase the complete selected key
history and append exactly one `purge` journal row. Neither loser may leave a signal revision,
key-range deletion, or journal row. The package does not silently re-preview or retry either mode.

`deleteEpisodes.signalTargets` accepts the identical non-empty `SignalFilter`, the
`targetSelectionCursor`, and `maxMatches` in `1..10,000`. It performs the same access, generation,
revision, cursor-evaluation-time expiry, and complete revision-set checks described below, but
rejects a selection containing any entity or fact target. Clock passage after preview does not alone
change this soft-deletion selection; a physical revision or committed signal-ID-set drift still
fails. It deduplicates episode target IDs, requires every target to remain visible and retained,
applies ordinary bulk soft-deletion semantics, and appends a withdrawn revision for every selected
signal. Episode tombstones, dependent fact transitions,
projection invalidation, the settled idempotent operation, signal withdrawals, one semantic
governance change, and one signal withdrawal change commit atomically at the cursor revision plus
one. The two journal rows share a physical revision but retain separate payloads. Signal values are
never inspected. Replaying the same operation ID and exact request returns the stored deletion
report without appending another withdrawal revision.

`hardPurge.signalTargets` accepts the identical non-empty `SignalFilter`, the
`targetSelectionCursor`, and `maxMatches` in `1..10,000`. Before creating a purge marker it selects
globally latest, caller-visible, active signals, re-evaluates expiry at action time, recomputes the
complete revision-ID digest, and verifies filter, access, space generation, and physical revision.
Any expiry or other selection drift is `conflict` with `requiresSignalBaseline`; zero and over-broad
selections fail as `not_found` and `result_too_large`. The operation deduplicates and hard-purges only
the selected signals' declared episode/entity/fact `target`s. It never reads the signal value as an
action, never purges basis-only records, cannot combine this selector with direct purge targets, and
remains an explicitly authorized `hardPurge` call. Ordinary signal withdrawal does not mutate
canonical memory.

Across independent persistent clients, canonical signal-target actions are serialized by the
cursor's physical revision. Two soft deletions planned from one revision against disjoint selections
have exactly one first commit; the loser receives retryable `conflict` with
`requiresSignalBaseline: true` and leaves no operation, lifecycle, canonical, derivation,
projection, semantic-journal, signal-revision, or signal-journal residue. Its operation ID remains
unbound and may be reused only after an explicit `browseSignals` baseline and complete replan. If
the winner consumed the same selection, that baseline exposes no actionable cursor; the package
MUST NOT silently reuse withdrawn or erased signals.

A soft-delete and hard-purge race from the same signal-target cursor likewise has one first
revision-CAS winner. If soft deletion wins, its atomic canonical/withdrawal commit prevents marker
creation. If the purge marker wins, soft deletion commits nothing and hard purge resumes forward to
content-free settlement. No result may combine a stale soft-delete plan with a winning purge marker,
and the loser never changes action kind automatically. A contender that starts after the marker is
live receives `purge_in_progress` under the general hard-purge barrier. Existing operation-ID replay
and different-input conflict rules remain unchanged.

The durable non-epistemic delta contract is:

```ts
type MemorySignalChange = {
  spaceId: string
  revision: number
  recordedAt: string
  action: 'put' | 'withdraw' | 'purge'
  partitions: readonly {
    scopes: readonly string[]
    affected: readonly { key: string; target: MemorySignalTarget }[]
    invalidated?: true
  }[]
}

interface SignalChangesPage {
  changes: readonly MemorySignalChange[]
  nextCursor: string
  throughRevision: number
  currentRevision: number
  signalChangesCompactedThrough: number
  hasMore: boolean
}
```

`signalChanges` defaults to `100` stored signal revisions scanned and accepts `1..1,000`. Its v2
cursor carries a `signal_changes` feed discriminator, so a semantic cursor cannot be used as a
signal acknowledgement. It orders
rows by ascending physical revision, filters exact-scope partitions by `AccessContext`, and may
return zero visible rows while `hasMore` is true. The always-present cursor binds space incarnation,
normalized access, and `throughRevision`. The read brackets the indexed scan with generation and
revision checks; concurrent mutation is a retryable `conflict`. A baseline cursor comes from
`browseSignals`, not `snapshot`, because signals are a separate plane.

`compactSignalChanges` mirrors semantic compaction: exact `confirmSpaceId`, exactly one of the local
`registeredConsumers: true` mode, `1..1,000` feed-specific `consumerCursors`, or the non-negative
`throughRevision` expert override, current `expectedRevision`, `maxChanges` in `1..1,000`, optional
`dryRun`, bounded `maxChanges + 1` planning, indexed range deletion, monotonic floor, and one
physical revision per applied batch. Registry mode derives the minimum checkpoint across every
active signal consumer and guards the final transaction with its epoch. Stateless cursor mode still
requires the host to enumerate every external consumer it intends to preserve. A cursor exactly at
the floor remains valid. Older or cursorless scans fail with `conflict`,
`requiresSignalBaseline: true`, and `signalChangesCompactedThrough`. It inherits the
independent-client one-winner, no-loser-mutation, explicit-retry contract above and the registry
lifecycle in §4.5.1.

Canonical hard purge computes contaminated keys across all signal revisions and deletes the complete
history when any declared target or basis ID is purged. This prevents an older revision from
retaining the erased dependency. It replaces any historical signal-change partition naming a
contaminated key with an empty `invalidated: true` partition and emits a new content-free
invalidation at the purge revision. This deliberately favors erasure and safe partition rebuild over
preserving unrelated item-level deltas that shared the same scope partition. Purge cannot inspect
arbitrary JSON or infer IDs hidden inside a namespace, slot, tag, producer ID/version, or value.
Applications MUST keep those fields
non-sensitive and declare every scope/invalidation/forgetting dependency through `target` or
`basis`. Signal integrity verification checks shape, deterministic key/ID, timestamp/JSON validity,
target and basis references, scope closure, entity grounding, contiguous supersession, and revision
ordering.

`stats.signals` counts global current active non-expired logical signals and
`stats.signalRevisions` counts retained immutable revisions. `stats.signalChanges` and
`stats.signalChangesCompactedThrough` expose retained journal rows and their floor.
`analyze.signals` is instead
access/view/filter bounded and reports current active/expired/withdrawn counts plus per-namespace
counts for targets in its canonical universe. Neither surface makes a truth or ranking claim.
Signals and their journal are excluded from format-v4 canonical archives and semantic `changes`;
explicit signal history is paged with `browseSignals`, while incremental transitions use
`signalChanges`. No signal archive importer, push subscription, automatic expiry sweep, or
cross-device consumer acknowledgement service exists.

### 4.7 Maintained derivations and downstream reasoning

The canonical derivation plane is the rule-language-neutral write boundary for a downstream
reasoner. A derivation revision names one rule id/version, one conclusion fact, a sorted non-empty
set of fact/evidence premises, method/provider lineage, exact scopes, input and recorded revisions,
record time, operation, supersession, and `active`, `invalidated`, or `withdrawn` state. It is factual
support, unlike a signal, but it is never source evidence, source authority, confidence, or a
retrieval trace.

`deriveFact` requires an exact checked `expectedRevision`. Every premise must be current, active,
retained where evidence-backed, and visible to the caller. The conclusion can use only existing
visible entities, passes ordinary ontology/cardinality/time validation, and receives the normalized
union of all premise scopes. Its logical key hashes space, rule identity, conclusion semantic
identity, sorted premise set, and exact scope partition. Repeating an active key adds no duplicate
support; reactivating a previously invalidated or withdrawn key appends a new immutable revision.
Operation-id replay is request-bound.

`deriveFacts` is the bounded atomic multi-conclusion form. It accepts between one and 64 derivation
members, one shared `access`, one shared exact `expectedRevision`, and one aggregate `workLimits`
budget. A member has the same `conclusion`, `rule`, `premises`, optional `method`, and optional
`provider` fields as `deriveFact`; it cannot override the shared authority, revision, or budget. The
complete request is detached at the public call boundary, and results preserve member order.

Every member is evaluated against the same pre-batch canonical state. A fact created, reactivated,
or newly supported by one member MUST NOT satisfy another member's premise in that batch. This
prevents request order from becoming an implicit rule scheduler or hidden fixpoint. The planner
MUST reject duplicate conclusion semantic identities, duplicate explicit or derived conclusion
identifiers, and more than one member in the same normalized cardinality-one
`(subject, predicate, scope)` partition. It MUST cycle-check the union of stored active derivations
and all earlier planned batch edges, so mutually recursive supports between facts that already
exist are rejected even when neither member is cyclic alone.

The batch produces one request-bound operation, at most one revision-CAS commit, and at most one
semantic journal revision. All derivation revisions created by the batch carry that operation id and
commit revision. Truth maintenance and projection invalidation run once over the aggregate plan;
the report returns ordered per-member `{ derivation, conclusion, outcome }` results plus deduplicated
aggregate affected/invalidated/unsupported identifiers and exact aggregate work. Invalid input,
scope or ontology denial, unavailable premises, a duplicate/cycle/cardinality ambiguity, work-limit
failure, cancellation, or a revision race leaves no fact, derivation, lifecycle, projection,
operation, or journal residue. A batch containing only already-active supports may settle its
operation without emitting a semantic change.

Single and batch derivation requests share the stored `derive` operation kind but bind distinct
result/request discriminants. Reusing one operation id across the two forms is an
`idempotency_conflict`; legacy settled results without a discriminant are interpreted only as
single-derivation results.

Across independent persistent clients, two derivation evaluations with distinct operation IDs and
the same `expectedRevision` may produce at most one canonical commit. If they propose the same new
logical derivation, the winner writes exactly one conclusion/support revision, settled operation,
projection invalidation set, and semantic journal row. The loser returns retryable `conflict`; its
operation ID remains unbound and it leaves no fact, derivation, lifecycle, projection, operation, or
journal residue. The package does not silently refresh the revision or re-evaluate the rule. After
the host explicitly rechecks the rule against the winner's revision, it may retry with that still-
unbound losing ID. If the same support is already active, the retry returns `supported`, persists
only its settled evaluation operation, and emits no duplicate derivation or semantic change. This is
distinct from same-request reuse of the winner's already bound ID, which returns its stored replay.

`deriveFact` and `deriveFacts` terminate at their atomic canonical commit and projection
invalidation. They MUST NOT start an unreported derivative write after persisting terminal success;
hosts that need refreshed lexical, embedding, or summary rows use `rebuildProjections`, whose scan
and activation are independently reported and fenced.

The package rejects a new positive fact-premise edge when it would create a dependency cycle.
`withdrawDerivation` appends a tombstone revision under the same exact-revision guard. Correction,
ingestion reconciliation, evidence retraction, single/bulk episode deletion, derivation withdrawal,
and hard purge all run the same atomic truth-maintenance planner. It invalidates supports whose
premises are unavailable, retracts or deletes conclusions that have neither active direct evidence
nor another active derivation, and repeats until no downstream premise changes. Alternative direct
or rule support retains the fact. Projection removal and the semantic change record share that
canonical commit. Hard purge physically removes every revision of a derivation key that directly
references a purged fact/evidence record, removes its replay payload from retained derivation
operations while leaving a content-free operation tombstone, and then applies the same support
closure. The same generalized diagnostics closure scrubs any operation linked to erased records or
target-bearing results, not only derivation operations. Reusing that operation id remains an
`idempotency_conflict` rather than recreating erased lineage.

`withdrawDerivations` is the bounded atomic rule-retirement form. Its closed `where` selector MUST
contain at least one of `ids`, `ruleIds`, `ruleVersions`, `conclusionFactIds`, or a non-empty
half-open `recordedAt` interval. Array values are non-empty, unique after normalization, and capped
at 1,000. Constraints intersect. Selection considers only the globally current `active` revision of
each logical derivation key, applies caller scope before disclosure, and orders matches by
derivation id. Historical rows whose stored state was `active` MUST NOT match after a later
invalidation or withdrawal. If `ids` is present, every requested id MUST itself be a visible current
active revision satisfying the other constraints; otherwise the complete request fails as
`not_found` rather than retiring a subset.

`previewDerivationWithdrawals` is the read-only full-set counterpart. It accepts the same `where`,
`access`, `maxMatches`, and aggregate `workLimits`, plus an optional `expectedRevision`. It MUST use
the exact same normalized selector and indexed current-revision planner as apply, bracket the read
with one space generation/revision, and return derivations in deterministic derivation-id order,
`snapshotRevision`, `generatedAt`, and exact selection work. A supplied stale revision, a concurrent
mutation, selection overflow, work breach, or incomplete explicit-id set fails without a partial
result. A general selector with no match returns an empty list and no `selectionCursor`; it is safe
for a management UI but cannot authorize mutation.

For a non-empty result, `selectionCursor` is an opaque versioned consistency token binding the space
incarnation, normalized access, canonical selector, snapshot revision, and a digest of the exact
ordered derivation revision IDs. It is not authority, authentication, or a durable server-side
lease. It contains no rule, premise, or conclusion data. Malformed cursors are `invalid_input`.
Semantic mismatch, reset/recreate, revision movement, access change, or a different reselected set is
retryable `conflict`.

The request carries a checked `expectedRevision`, `maxMatches` from 1 through 1,000, optional shared
reason, optional preview `selectionCursor`, and one aggregate derivation work budget. The complete request is detached at the public
boundary. Selection MUST push scope plus available id/rule/version/conclusion/time constraints into
storage, page candidates in groups of at most 16, and admit every candidate/current-revision lookup
before retention. Zero matches is `not_found`; the first current match beyond `maxMatches` is
`result_too_large`. No selector is allowed to mean an accidental unbounded “all rules” operation.
When a cursor is supplied, apply MUST verify every cursor binding and the freshly reselected exact-ID
digest before planning a withdrawal. Omitting it retains the one-shot exact-revision API for hosts
that already authorized the selector from another checked read; it does not weaken CAS atomicity.

Every selected support receives one immutable `withdrawn` successor carrying the same logical key,
rule, conclusion, premises, method/provider, and scopes plus the shared operation, input/recorded
revision, time, and optional reason. The planner then runs truth maintenance and projection
invalidation once over the complete withdrawal set. The report returns deterministic
`{ derivationId, withdrawalId, conclusionFactId }` entries plus aggregate affected entities/facts,
downstream invalidated derivations, unsupported facts, projection count, and exact work. It commits
one request-bound `derive` operation, at most one revision-CAS transaction, and one semantic change.
Invalid input, an unavailable or non-current explicit id, scope denial, selection overflow, any
work breach, cancellation, or revision race leaves no withdrawal, fact, lifecycle, projection,
operation, or journal residue. This retires already-evaluated support; it does not execute a rule or
choose a replacement rule version.

Two independent withdrawals of the same active derivation revision with distinct operation IDs and
one `expectedRevision` likewise have at most one winner. The winner appends exactly one withdrawn
revision and atomically performs the complete recursive support invalidation, fact retraction,
projection deletion, settled operation, and semantic journal change. The retryable loser leaves no
tombstone, truth-maintenance row, operation, or journal residue and MUST re-evaluate current support
before any later action. Same-request reuse of the winning operation ID replays its stored report.

Two independent `withdrawDerivations` plans at one revision or from one preview cursor likewise have at most one complete
winner. The winner publishes every selected withdrawal and the aggregate cascading closure; the
retryable loser leaves no member or operation residue. Reusing the winner's bound operation id with
the same request replays the exact ordered report. A still-unbound loser id may be reused only after
the host previews and authorizes a new selector at the winning revision.

Direct `deriveFact`, `deriveFacts`, `withdrawDerivation`, `previewDerivationWithdrawals`, `withdrawDerivations`, `correctFact`,
`retractFact`, single `deleteEpisode`, and bulk `deleteEpisodes` planning MUST NOT call whole-space
export or an unfiltered projection/identity/support scan.
Premises, conclusion identities and visible aliases, evidence episodes, semantic matches, exact
derivation revisions, and affected projections use point or filtered reads. `correctFact` scans and
authorizes every direct support row, including inactive history, before it can supersede the fact.
`retractFact` scans every active direct support for the target through the target/status index so
whole-support authorization remains fail-closed, then withdraws either the addressed episode or all
support. `deleteEpisode` scans only provenance whose episode id matches the target plus affected
support/projections. `previewEpisodeDeletions` and filter-selected `deleteEpisodes` MUST use one
shared selector planner that pushes access, retained state, identity, source, tag, and time
predicates into episode selection, applies metadata equality residually, orders the complete result
by episode id, and stops after the first match beyond `maxMatches`. Preview returns the full selected
episodes, snapshot revision, evaluation time, exact work, and—only when non-empty—an opaque
consistency cursor binding the space incarnation, access partition, canonical selector, revision,
and exact ordered episode-id digest. It is not authorization or authentication. Repeating an
unchanged preview at one revision MUST return the same cursor. Apply with a cursor MUST reselect and
verify every binding and the complete set before provenance or truth-maintenance planning. A
malformed cursor is `invalid_input`; selector/access/reset/revision/set drift is retryable
`conflict` without mutation. Apply without a cursor remains a one-shot exact-revision operation.
Signal-selected deletion scans physical signal
history in logical-key/current-revision order, hashes the complete frozen selection, and retains at
most `maxMatches` rows. Both modes batch-filter evidence and mentions by selected episode IDs and
aliases by episode-ID membership before entering the same targeted support closure. Every facade
page contains at most 16 rows. Positive-cycle detection walks only
the forward current-derivation closure from the proposed conclusion toward its fact premises. Truth
maintenance starts only from facts, evidence, episodes, or derivation supports changed by the
request; it follows indexed premise arrays and conclusion ids until support stabilizes. Candidate
rows advance in id-keyset pages of at most 16.
For one logical derivation key, the native count plus its deterministic versioned ids select the
current revision without retaining the history. Historical `active` rows never count as current
when a later invalidated or withdrawn revision exists. Every loaded current derivation brings its
complete fact/evidence premise records into the checked closure before it can support or invalidate
a conclusion.

`IngestionReport.work`, `DerivationReport.work`, `DerivationBatchReport.work`,
`DerivationWithdrawalPreview.work`, `DerivationWithdrawalBatchReport.work`, `EpisodeDeletionPreview.work`, `CorrectionReport.work`, `RetractionReport.work`, `EntityMergeReport.work`,
`EpisodeDeletionReport.work`, and `BulkDeletionReport.work` return exact distinct admitted-row count
and bytes plus traversed graph nodes/edges and the normalized limits.
`IngestionOptions.workLimits`, `IngestionProfile.workLimits`, `BatchOptions.workLimits`,
`PreviewDerivationWithdrawalsInput.workLimits`, `WithdrawDerivationsInput.workLimits`, `PreviewEpisodeDeletionsInput.workLimits`, `CorrectFactInput.workLimits`,
`RetractFactInput.workLimits`, `MergeEntitiesInput.workLimits`,
`SplitEntityMergeInput.workLimits`, `DeleteEpisodeInput.workLimits`, and
`DeleteEpisodesInput.workLimits` accept the same defaults and hard maxima as derivation writes.
Row/byte values include selection (including scanned signal revisions), visibility, provenance,
direct/rule-support closure, affected facts, and projection cleanup; they exclude pure in-memory
ontology checks and database-engine internal index work. Work limits are not part of semantic
request identity, so a settled operation replay returns its originally recorded work and limits.
Each operation rechecks the exact source revision after planning and commits under the same revision
CAS; a race is retryable `conflict`. A governance limit or race produces no partial canonical,
projection, lifecycle, operation, signal, or journal mutation. Ingestion is intentionally two-stage:
the episode and accepted lifecycle are durable before planning. An ingestion limit failure settles
its operation at `canonical_failed`, commits no canonical-plan output, and remains retryable through
`retryEpisode` with a different budget.

`getDerivation`, `FactView.derivations`, `snapshot.derivations`, stats, analysis, integrity checks,
and format-v4 export/import expose the maintained result. Current and valid-at views use globally
latest active derivation revisions; known-at selects the latest revision recorded by the requested
instant; history exposes retained revisions. Portable import intentionally materializes each
exported current support as version one in the target space and binds it to the target import
revision instead of pretending that source-space physical revisions occurred locally.

The package does not execute rules. A downstream OWL/RDFS/Datalog/custom engine follows `changes`,
evaluates a checked `snapshot`, and CAS-writes conclusions with explicit rule and premise lineage.
`deriveFacts` can commit one bounded multi-head rule activation atomically, but it does not iterate,
consume its own outputs, or find a fixpoint. Negation, stratification, aggregation, existential
identity creation, rule scheduling, and fixpoint evaluation remain engine semantics; the core
supplies positive acyclic support and incremental retraction. Derivations currently bind the current
active canonical premise state, not an arbitrary `valid-at`/`known-at` reasoning basis. Temporal rule
engines must put applicability in the conclusion `validTime` and recompute/withdraw on their own
schedule. No built-in modal, Copilot, `dream`, ontology language, or rule vocabulary is imposed.

Retrieval still ignores non-epistemic signals unless a future explicit policy reports a separate
contribution. Automatic action loops, generic strengthen/weaken application, and non-erasure
signal-target governance remain host-owned.

### 4.8 Spectron pressure-test and compatibility boundary

The published Spectron architecture—its
[eight pillars and categories](https://surrealdb.com/docs/spectron/architecture/eight-pillars-and-categories),
[coherence/retrieval tiers](https://surrealdb.com/docs/spectron/architecture/coherence-retrieval-and-tiers),
[tri-temporal model](https://surrealdb.com/docs/spectron/architecture/tri-temporal-model), and
[trace evolution](https://surrealdb.com/docs/spectron/architecture/traces-and-evolution)—is a design
reference, not an API dependency. The classifications below are exact:

The 2026-08-03 audit also covered Spectron's full architecture/mental-model corpus, agent-memory
ingest/retrieve/reason/operations/sessions/tuning pages, and its REST, configuration, schema, and
embedded-runtime references. Where the architecture describes more than the published schema (for
example structured source spans/trust, three trace kinds, importance/TTL, or derivation fields), the
table classifies the documented executable surface separately from the aspiration.

- **implemented** means the alpha facade and tests expose the primitive;
- **downstream-native** means a consumer can implement it coherently using bounded public reads and
  governed writes without raw storage access;
- **missing substrate** means the data may be representable, but a serious incremental or maintained
  implementation lacks a generic public contract; and
- **outside core** means the host, not memory, owns the capability.

| Spectron concept | Classification | Alpha mapping or exact gap |
| --- | --- | --- |
| Authoritative ingestion | Implemented in part | Explicit assertions, source references, scopes, exact anchors, ontology checks, and one reconciler exist. Typed source-authority policy and calibrated trust do not. |
| Experiential ingestion | Implemented | Text/message/structured/event episodes, provider extraction, identities, facts, valid/record time, and idempotent reprocessing. |
| Reconciliation | Implemented | Conservative identity resolution, semantic fact identity, evidence aggregation, disputes, supersession, correction, retraction, and lifecycle history. |
| Reflection/elaboration | Downstream-native with maintained conclusions | `changes`, checked `snapshot`, and bounded structural or explicitly seeded personalized analysis support restart-safe evaluation; signals persist non-epistemic proposals; `deriveFact` persists one rule-supported conclusion and `deriveFacts` persists one bounded atomic multi-head activation against pre-batch premises; positive-cycle rejection and atomic cascading invalidation maintain conclusions. Seed selection, rule execution, temporal bases, negation/stratification, and iterative fixpoint scheduling remain downstream. |
| Consolidation | Downstream-native for recommendations and exact selected deletion/erasure; missing for automatic/general application | Bounded structural/personalized `analyze`, signals, signal/episode selector previews, withdrawal, deletion, and purge are available. An exact signal target set can soft-delete episode targets while atomically consuming the signals, or hard-purge episode/entity/fact targets, under an explicit full-set cursor and breadth guard. No built-in seed selector, consolidator, automatic loop, non-erasure entity/fact action, or generic strengthen/weaken application exists. |
| Calibration | Downstream-native for non-epistemic output; missing typed semantics | Conflicts, source counts, and structural findings exist, and a downstream may persist calibration output as a signal. Source trust, extractor-confidence semantics, calibrated posterior evaluation, and durable unknown/hypothesis knowledge do not. |
| Collective memory | Replica sync implemented; collaboration outside core | Whole logical spaces can fast-forward or three-way reconcile through a transport-neutral checkpoint DAG. Peer transport/authentication, tenancy, collaborative policy, and community aggregation remain outside core. |
| Context and scope topology | Implemented, intentionally narrower | A space isolates one logical memory and each stored partition carries one exact conjunctive required-scope set checked against a trusted host capability. There is no Spectron-style hierarchical grant tree, DNF alternative/co-owner clauses, registered scope vocabulary, principal, delegation, or authentication surface. Richer scope algebra would require a versioned migration. |
| Sessions, state diffs, and profiles | Downstream-native | Ordered message/event episodes plus source, tags, metadata, valid time, facts, and manual signals can represent thread state. `snapshot(...).changesCursor` plus `changes` gives a revision-bound state-to-diff handoff; profile/context assembly is a selected current view. The package deliberately does not impose one session schema, transcript owner, or prompt format. |
| Six experiential categories | Downstream-native | Episode kinds, tags, ontology types, and predicates can express episodic, identity, knowledge, context, instructions, and uncertainty without a closed enum. No category has hidden execution semantics. |
| Ontology grounding | Validation implemented; reasoning substrate downstream-native | The ontology fixes entity/fact vocabulary, subject/object/value shapes, and cardinality, and all provider output is validated. A downstream entailment engine can now persist maintained conclusions through canonical derivations, but the package does not interpret OWL/RDFS/Datalog or migrate ontology/rules. |
| Supersession, decay, and forget | Implemented in part; decay application is downstream-native | Canonical correction/retraction/lifecycle, soft episode deletion, guarded hard purge, signal expiry, and group/time selectors keep historical replacement, relevance advice, and erasure separate. A host can persist reinforcement or decay recommendations as signals; no scheduler or retrieval loop applies them automatically. Retrieval alone is not treated as evidence of utility, avoiding an implicit exposure-feedback loop. |
| Exact lexical coherence | Implemented | Text ranges and JSON Pointers are verified against accepted content and returned in citations. Aliases are not fabricated mentions. |
| Semantic coherence | Implemented in part | Ontology, entity/fact graph, embeddings, and semantic recall exist; no calibrated semantic-resolution quality claim. |
| Relational coherence | Implemented, not pushed down | Scoped graph traversal plus structural and explicit seed-weighted personalized PageRank run in TypeScript under work budgets; there are no package-owned Surreal relation edges, recursive-query pushdown, or automatic query-to-seed policy. |
| Temporal coherence | Implemented logically | Valid, recorded/known, observed, and received times plus lifecycle views exist. IndexedDB has no qualified MVCC system-time rewind. |
| Spatial coherence | Missing optional facet | Coordinates may be inert metadata; no geometry filter, distance ranker, or spatial index is public. |
| Hybrid retrieval | Implemented in part | Exact, BM25, cosine, graph, and temporal ranks use deterministic weighted RRF. Durable signals are intentionally ignored by ranking. No RAKE keyword graph, section hierarchy, geo channel, learned trace feedback, explicit signal policy, or adaptive escalation planner. |
| Four retrieval tiers | Downstream-native in part | A host can choose channel/cost budgets and reranking. The package does not synthesize responses, cache answers, or decide full-context prompt escalation. |
| Semantic change records | Implemented | Durable revision/operation lineage and exact-scope affected targets drive restart-safe invalidation without exposing physical storage mutations. They contain no retrieval decision payload. |
| Retrieval/decision traces | Missing substrate | Provider summaries, durable operations, in-process events, and the minimal semantic journal do not persist query candidates, scores, decisions, feedback, or outcomes. |
| Response traces/cache reuse | Outside core | Conversation, prompt assembly, model response, and answer-cache invalidation belong to the host; it may depend on citation ids and revisions. |
| Embedded/local runtime | Implemented and intentionally divergent | Temporal Memory runs in-process with SurrealDB WASM/IndexedDB. Spectron's published client surface requires a deployed `spectrond` HTTP/MCP service and documents no supported in-process extraction/recall API. |

Temporal Memory therefore aligns on evidence, reconciliation, coherence dimensions, cost-aware
retrieval, and safe evolution primitives while retaining its stronger local runtime, explicit
provider boundary, evidence-many-to-many history, revision-bound destructive operations, and
portable canonical archive. It does not claim Spectron wire, schema, category, trace, or deployment
compatibility.

The next generic API sequence is now: (1) qualify journal, signal, and derivation storage under
physical mid-transaction crash and bounded large-corpus scans (independent-context atomic
multi-conclusion contention is covered), (2) calibrated source/uncertainty policy, (3) decide
whether real reasoners need a temporal reasoning basis or iterative fixpoint scheduler, (4) add an
explicit signal-aware retrieval policy and/or durable trace plane only with separate lineage, and
(5) add optional spatial and adaptive retrieval facets. Specialized algorithms remain downstream
until evidence shows a smaller reusable primitive is missing.

## 5. Governance and portability

### 5.1 Corrections, retractions, merges, and deletion

- Correction commits its correction episode, evidence, replacement fact, prior supersession,
  lifecycle, and operation in one revision-CAS mutation. It stays in the exact fact scope, is
  idempotent by operation id and content hash, and replans from current state after a conflict. It
  does not rewrite source evidence. Its indexed planning obeys `workLimits`, and every retry MUST
  repeat support authorization against the refreshed revision before planning; newly hidden support
  fails closed with `scope_denied` rather than being superseded by stale authority.
- Retraction withdraws selected support. `allSupport: true` requires visibility of all support; the
  implementation does not infer an opposite claim.
- Merge retains source entities and evidence and records a current redirect. Split deactivates a
  recorded merge; it is not arbitrary entity partitioning. Both MUST point-load the selected
  entities and expand only indexed alias, alias-episode, entity-provenance, subject/object fact,
  related fact-provenance, and target-projection closure in 16-row keyset pages. Internal set
  predicates MUST be split into bounded chunks. `workLimits` MUST admit every distinct inspected row
  and stable JSON byte, and `EntityMergeReport.work` MUST report the exact admitted set. Authority
  covers every selected alias plus entity and related-fact provenance. A limit, authorization,
  abort, or revision/generation race MUST leave entity, merge, lifecycle, projection, operation, and
  journal storage unchanged; the accepted redirect/reversal is one revision-CAS mutation.
- Soft episode deletion tombstones the episode, removes its searchable projections, and recomputes
  dependent support. Shared support can keep a fact visible. Single `deleteEpisode` uses the bounded
  planning contract above; `workLimits` failure and revision races are atomic.
- Bulk soft deletion accepts a non-empty `EpisodeFilter`, `expectedRevision`, `maxMatches`
  (`1..10,000`), and optional `workLimits`. It selects retained visible episodes through bounded
  indexed pages, fails on zero/too many matches, work admission, or revision drift, and commits every
  episode tombstone, dependent fact transition, projection invalidation, and the settled operation
  in one revision CAS. `BulkDeletionReport.work` records exact planning work. The operation id is
  bound to the semantic request but not its work ceilings, and a successful report is replayable.
- Alternatively, bulk soft deletion accepts `signalTargets: { where, selectionCursor }` and
  `maxMatches`, plus the same optional `workLimits`. The cursor must come from the identical
  constrained current active/non-expired signal browse. Only episode targets are allowed. Expiry is
  evaluated at the cursor's frozen preview instant. The operation atomically performs the canonical
  soft deletion and appends withdrawn revisions for every consumed signal; its semantic and signal
  journal rows are separate but share the new physical revision. Signal values do not choose or
  authorize the action.
- Hard purge physically removes selected payloads and dependencies using content-free resumable
  markers; reads fail closed while a purge is pending. Projection invalidation follows direct
  targets plus episode evidence, mentions, and alias provenance without widening canonical deletion.
- The initial target/dependency plan is pinned to the captured space incarnation and revision. If an
  independent client commits after that capture but before the running marker is atomically created,
  marker creation MUST fail with retryable `conflict`; no target, dependency, operation, or marker
  row may be written or erased. This applies to direct IDs as well as selector/cursor inputs. The
  caller must re-read and explicitly retry so a new dependency can be authorized and included.
- Distinct purge operations may independently plan from the same revision. Their running-marker
  commits have exactly one revision-CAS winner; the loser receives retryable `conflict` and writes no
  operation, owner, marker, canonical row, sync-metadata deletion, or journal residue. A contender
  that instead observes the winner's live marker receives retryable `purge_in_progress` naming that
  operation before target/dependency planning and likewise does not bind its own operation id. After
  the winner settles, the loser may
  explicitly re-read, replan, and retry its still-unbound operation id; there is no automatic retry or
  stale-plan replay. Reusing one operation id for different purge input remains
  `idempotency_conflict`, not purge contention.
- Hard purge MUST accept caller-lowerable `workLimits` for distinct stored rows, stable JSON bytes,
  graph nodes, and graph edges, and MUST return the exact admitted values as `PurgeReport.work`.
  Initial selection/planning and reopen recovery MUST use the same point/16-row keyset erasure
  planner. Internal set predicates MUST be split into bounded chunks; signal target/basis and merge
  source closure MUST use their denormalized indexes. Full semantic-journal, signal-journal, and
  opaque operation-result scans remain necessary, but each row MUST be admitted before the marker.
  Exceeding a ceiling MUST leave the revision and purge-marker set unchanged.
- The active marker MUST persist normalized work ceilings. After marker commit, cancellation cannot
  reverse erasure: reopen MUST resume forward under those ceilings. Recovery MUST first win the
  exact marker/operation owner claim above. Local sync metadata MUST then be physically reclaimed in
  bounded idempotent batches while the marker blocks all facade access. Owner death immediately
  after marker creation or recovery claim, between metadata batches, or after metadata cleanup but
  before canonical settlement MUST be recoverable by another guarded claim. Canonical deletes, truth
  transitions, journal scrubs, operation tombstones, and successful content-free marker MUST settle
  in one admitted revision-CAS transaction. Successful markers MUST omit the transient work ceilings.
- Authorization MUST cover every scoped canonical or derived row changed by the purge closure,
  including aliases, evidence, mentions, derivations, projections, signals, and affected journal
  partitions. A hidden derivative MUST fail as `scope_denied` before marker creation.
- Hard purge MUST replace every operation linked through an erased episode, deleted canonical row,
  affected semantic-change partition, or exact target ID in its stored result with a content-free
  operation tombstone. Rebuild, sync, and migration operations are whole-space and MUST be treated as
  linked when any target is purged. The tombstone retains only id, space, private run binding, kind,
  terminal outcome, timestamps, attempts, `diagnosticsState: 'purged'`, and empty warnings/provider
  calls; it MUST omit `episodeId`, result, and error. A running/partial operation becomes
  non-retryable cancelled. Normal
  and reopen-recovery purge paths use the same closure. No later facade commit may replace the
  tombstone; revision CAS resolves a concurrent check/commit race.
- `hardPurge.episodes` accepts the same selector. It requires the preview `expectedRevision` and a
  `maxMatches` guard before its marker is created. Selector matches are access-bounded and union with
  any explicit entity/fact targets; it cannot be combined with the legacy episode-id/`before`
  selectors. A selector-based marker start uses the exact preview revision; it does not retry the
  selection against newer state.
- The legacy `hardPurge.before` shorthand also requires `expectedRevision` and `maxMatches`; hosts
  SHOULD prefer an equivalent previewable `episodes.receivedAt.until` selector.
- `hardPurge.signalTargets` accepts only a constrained current active/non-expired
  `browseSignals` selection cursor plus the identical filter and a `maxMatches` guard. The cursor
  binds access, generation, revision, expiry instant, and a digest of the complete matching signal
  revisions across all pages. The selected canonical episode/entity/fact targets are deduplicated;
  signal values and basis-only IDs do not become purge instructions.
- Bulk deletion and selector purge implicitly select `retained` episodes when `retentionStates` is
  absent. A deleted-history purge must explicitly select `deleted` and be previewed through the
  `history` view. This prevents a current-view preview from omitting historical targets that the
  mutation would otherwise include.
- Signal withdrawal/purge is governed independently through `deleteSignals` as specified in §4.6.
  Withdrawing a cluster or salience signal does not mutate its canonical target. Canonical hard
  purge deletes the full history of every signal key whose declared target/basis references an
  erased episode/entity/fact, in both the initial and recovery paths.

Replay-resistant idempotency tombstones use space-scoped, domain-separated SHA-256 key hashes on
purge markers. A separately domain-hashed marker id prevents operation-id/marker-id aliases, and a
normalized request hash binds the operation id to its exact input under create-only revision CAS.
For selector purges the bound input includes the selector, normalized access scopes, exact preview
cursor or revision, and match ceiling.
Ingestion and import reject a matching tombstone, including after successful or interrupted
recovery; revision-CAS retries recheck tombstones. Same-request reuse is non-replayable: active work
returns `purge_in_progress`, while settled or different-input reuse returns
`idempotency_conflict`. Reset removes the space and releases its tombstones. The alpha does not
promise full linearizability for unrelated in-flight work across independent contexts, and
already-completed legacy markers without hashes cannot be reconstructed.
`resetSpace` requires exact `confirmSpaceId`. Its optional `scanLimits` defaults to 100,000 rows/
64 MiB and has hard maxima of 1,000,000 rows/256 MiB. Native counts first preflight the episode,
entity, fact, and projection rows required by the `ResetSpaceReport`; those four kinds are then read
through 16-row ID keysets with exact stable-JSON-byte admission. The report returns their affected
IDs/projection count plus exact `scan` work. A row/byte breach (`phase: 'reset_scan'`), cancellation,
or revision drift fails before deletion and leaves the handle open. After admission, the storage
adapter deletes every table and the space record in one revision-guarded transaction and the handle
closes. The scan bounds report materialization; they are not a partial reset, heap measurement, or
database-work limit. This direct whole-space deletion is not evidence that targeted purge covers the
same failure schedules. Across independent clients, a writer that commits before deletion
invalidates reset and preserves all data; an explicit reset retry repeats the full preflight. A
reset that commits before a delayed guarded writer makes that writer fail `space_not_found` without
recreating the space or leaving residue. Neither direction is retried implicitly.

### 5.2 Export and import

The implemented archive has media type
`application/vnd.astrale.temporal-memory+json`, format version `4`, fully materialized canonical
arrays, ontology and space metadata, counts, and SHA-256 over a deterministic canonical
serialization. Each archive carries `snapshotRevision` and one canonical UTC `exportedAt`; export
checks the space generation and revision after selection and hashing. The digest covers the
canonical arrays, not envelope lineage, and is neither a signature nor an authenticity proof.

`ArchiveEpisode` extends the ordinary read-facing `Episode` with the optional explicit assertion set
that was accepted with the episode. Assertions are portable identity/reprocessing input, not a
second canonical truth source. Every exported episode therefore carries the complete deterministic
preimage of `contentHash`: `id`, `idempotencyKey`, `kind`, `content`, `source`, normalized `scopes`,
nullable `sensitivity` and `retention`, sorted unique `tags`, `metadata`, nullable `validTime` and
`observedAt`, and nullable `assertions`. Generated `receivedAt` and mutable `retentionState` are not
identity fields. Import MUST recompute and compare every episode hash before target reads, collision
planning, or mutation. `collisions: 'remap'` changes `id` and `idempotencyKey` and MUST recompute the
hash from the remapped preimage. Format 3 omitted assertions and is rejected rather than treated as
verifiable format 4.

Format 4 is a closed schema. Every envelope, space, ontology, manifest/count, canonical record,
discriminated union, assertion, reference, lineage, anchor, and merge object MUST contain all of its
required own properties, MAY contain only the optional properties defined by format 4, and MUST
reject `undefined`, inherited/non-plain state, and unknown properties. Source-space ids MUST agree
with `space.id`; exact-scope and episode tag arrays MUST already be sorted and unique; canonical
sections MUST use their defined deterministic order. Optional properties are validated when present,
not merely ignored. A portable property addition therefore requires a new format version rather than
being silently accepted by an older importer.

`ArchiveMerge`, `ArchiveCounts`, and `ArchiveManifest` are the normative public declarations for
the merge and manifest wire shapes. The eight count keys are `episodes`, `entities`, `facts`,
`evidence`, `derivations`, `mentions`, `lifecycle`, and `merges`. Export MUST construct every merge
through the format-v4 projection rather than serializing its storage record, so internal-only fields
cannot enter the archive without a format-contract change.

Export supports complete or selected ids, selection requiring specified scopes, and received-time
bounds. A complete export requires visibility of every episode. Dependencies needed to interpret
selected canonical records are included, including the latest visible revision of each selected
derivation key plus its conclusion and premise closure. Source-kind selection is not an export
option. Projections, signals, semantic changes, operations, purge markers, and credentials are not exported.
`browseSignals({ revisionView: 'history' })` is the explicit read boundary for a host-owned signal
archive, but format-v4 import has no signal section.

Format-v4 is a deliberately bounded small/selective document. `ExportRequest.scanLimits` bounds
the canonical physical rows examined (100,000 records / 64 MiB by default; 1,000,000 / 256 MiB
maximum), while `ExportRequest.limits` bounds the returned archive (10,000 manifest records / 16
MiB by default; 100,000 / 64 MiB maximum). Export scans only episode, entity, alias, mention, fact,
evidence, derivation, lifecycle, and merge rows in 16-row keyset pages; projections, operations,
signals, journals, and sync metadata do not consume its scan budget. Scan bytes are the sum of exact
canonical UTF-8 JSON bytes for examined stored rows. Archive records are the sum of the eight
manifest section counts; aliases embedded in an entity are not a ninth archive section but their
physical rows do consume the scan budget. Archive bytes are the exact canonical UTF-8 serialization
of the complete returned envelope. A page may transiently hold at most 16 individually bounded
stored values. Exceeding any limit fails with `result_too_large`, phase/dimension/required/maximum
details, and no partial archive.

`ImportOptions.limits` applies the same 10,000-record / 16 MiB defaults and 100,000-record / 64 MiB
hard maxima to the incoming document before record materialization or collision work.
`ImportOptions.prepareLimits` independently bounds target-local physical rows—including expanded
alias/source rows—and their summed canonical bytes; both default and cap at 100,000 rows / 64 MiB,
while callers may lower either value for a device. This distinction lets an archive succeed at its
exact transport-byte limit without pretending that target-local preparation has the same size.
Export and import also enforce a one-million-node aggregate JSON ceiling and the ordinary
depth/string safety rules. Limits are resource policy, not archive identity, and do not alter the
format-v4 digest. Whole-memory datasets above these bounds MUST use paged `exportSyncBundle`, a
durable random-access bundle store, `openSyncBundle`, and resumable `syncFrom` instead of attempting
a larger in-memory canonical document.

Before any target database read, import checks bounded JSON, the complete closed format/ontology
schema, section counts and canonical ordering, source-space consistency, digest, and every
recomputable episode content identity. It then checks every episode content/source/assertion variant,
scalar value, temporal/state field, duplicate identity, cross-record reference, evidence status,
exact scope partition, and known fact predicate/subject/object/value constraint before the first
mutation. Present evidence
and mention anchors are resolved against their referenced immutable episode, including exact excerpt
matching; anchor-less records remain accepted. Known ontology
mismatches fail closed during import even when ordinary ingestion severity is `warn`. Collision modes
are `reject`, `identical`, and `remap`; `dryRun` is optional. Non-dry import commits its prepared
records atomically. Derivation conclusion/premise references, exact scope closure, active-premise
availability, positive-cycle absence, and fact support are also validated. Portable derivation keys
and IDs are recomputed for the target space; each exported current support becomes version one at
the target import revision. Fact extraction lineage remains preserved rather than rewritten to
`method: 'import'`. The target appends one fresh local semantic import change when new canonical records are committed.

The importer is intentionally bounded small-archive alpha behavior: it materializes the document
within the limits above and uses one transaction. It does not stream, checkpoint, authenticate, or provide a broad
forward/backward compatibility layer. Format 4 has a closed runtime schema, while cross-record
semantic validation remains deliberately separate from archive authenticity. Older archive formats
are rejected rather than silently reinterpreted; the manifest digest covers the complete canonical
arrays but is not an authenticity signature. `exportSyncBundle` plus `syncFrom` provides bounded
offline whole-memory replica portability; it is not a streaming encoding of this selective/remapping
document.

### 5.3 Whole-memory replica synchronization

Replica synchronization is not format-v4 archive import. Archives select and remap canonical
knowledge into a target-local import event. Sync instead preserves one logical space across replicas,
including retained histories and monotonic erasure knowledge, while intentionally rebasing only
source-local physical revision numbers.

The transport-neutral boundary is:

```ts
interface MemorySyncPeer {
  syncHead(access: AccessContext, options?: ReadOptions): Promise<SyncCheckpoint>
  syncCheckpoint(
    id: string,
    access: AccessContext,
    options?: ReadOptions,
  ): Promise<SyncCheckpoint | null>
  syncChunks(request: SyncChunksRequest, options?: ReadOptions): Promise<SyncChunkPage>
}

interface SyncBundleReader {
  readCommit(options?: ReadOptions): Promise<SyncBundleCommitFrame | null>
  readCheckpoint(
    index: number,
    options?: ReadOptions,
  ): Promise<SyncBundleCheckpointFrame | null>
  readChunk(index: number, options?: ReadOptions): Promise<SyncBundleChunkFrame | null>
}

function openSyncBundle(
  reader: SyncBundleReader,
  options?: {
    signal?: AbortSignal
    maxCheckpoints?: number
    maxCheckpointBytes?: number
    receiveLimits?: SyncReceiveLimits
  },
): Promise<MemorySyncPeer>
```

`Memory` itself implements this interface. An RPC/file/device adapter may implement it without
exposing storage. `syncFrom(peer, ...)` is a pull. A host that wants bidirectional convergence calls
it once on each destination in an order chosen by host policy; the core has no push socket, peer
discovery, background daemon, or topology manager.

All `Memory` sync requests are invocation-time values, not mutable instructions retained by the
facade or queue. Their closed JSON snapshots and copied options follow section 2.3; the peer and
abort signal are the only live capabilities. This ownership rule is part of reconciliation safety:
authorization, destructive confirmation, conflict choice, and resume identity are evaluated from
the same package-owned request that is hashed, persisted, or sent to the peer.

`SyncBundleReader` is the smaller durable-container boundary. It supplies one final commit and
zero-based random access to checkpoint and target-chunk frames; each sequence MUST return `null`
immediately after its committed count. `openSyncBundle` is the native untrusted-bundle verifier and
returns the ordinary peer only after complete bounded validation. It does not require the host to
reimplement the sync protocol or reconciliation engine. Before the first await it MUST snapshot its
limits and abort signal. Every reader-returned commit, checkpoint, and chunk frame MUST be copied and
JSON-validated in one traversal under that frame type's hard node, depth, and string-byte ceilings
before structural validation, hashing, metadata retention, or return. A reader-owned accessor or
later mutation therefore cannot make validation observe one value and hashing or reconciliation use
another. An unreadable or hard-oversized frame is `import_invalid`; at most one bounded frame body is
copied at a time.

The checkpoint media type is
`application/vnd.astrale.temporal-memory-sync-checkpoint+json`, protocol version `1`. Genesis is
deterministic from the exact space id and ontology digest and has no parents or chunks. Every other
checkpoint has one parent for a local state commit or two sorted parents for a merge. Its id is
SHA-256 over a domain separator, protocol, space, sorted parents, ontology digest, ordered root
digest, record/chunk/byte counts, and normalized complete scope set. `createdAt` is diagnostic
metadata and is validated but deliberately excluded from state identity.

Protocol-v1 checkpoint, record, chunk, and page envelopes are closed; unknown fields are invalid
instead of being ignored. Checkpoint headers admit at most 100,000 normalized scopes, 200,000 JSON
nodes, and 4,000,000 aggregate UTF-8 string bytes. All counts must be safe integers and structurally
possible for the declared chunk count before any body transfer begins.

A packed `SyncRecord` is keyed by `kind + U+0000 + id`. Kinds are `alias`, `derivation`, `entity`,
`episode`, `evidence`, `fact`, `lifecycle`, `mention`, `merge`, `purge`, and `signal`, in Unicode
scalar-value order. The pack contains all canonical records, every retained derivation and signal
revision, and succeeded purge markers reduced to content-free target/idempotency digests. It omits
operations, projections, both change journals, provider calls, credentials, pending/failed purge
markers, caller-controlled purge operation IDs, and signal/derivation `inputRevision` and
`recordedRevision`. Applying a signal or
derivation history writes one revision per local commit so those two physical fields remain valid
and strictly increasing on the target.

`createSyncCheckpoint` requires exact `confirmSpaceId`, visibility of every packed record, and a
stable logical revision. It scans by kind/id without whole-space materialization. Chunks contain at
most 256 records. `maxChunkBytes` defaults to 8 MiB and accepts 64 KiB..16 MiB; a single larger
record fails `result_too_large`. A chunk also contains at most 1,000,000 JSON nodes. That aggregate
limit is deliberately separate from the ordinary single-value JSON budget, so multiple valid values
may fill an 8–16 MiB chunk without permitting an unbounded traversal. Each chunk independently
commits its records, byte length, first/last key, and SHA-256 digest. The checkpoint root is an
ordered hash chain over every chunk index, digest, length, count, and key boundary. An unchanged
build returns the current HEAD and deletes its duplicate staged pack. HEAD publication uses an exact
metadata compare-and-set and does not advance the logical revision.

`syncChunks` defaults to one chunk, accepts `limit` 1..64 and an aggregate canonical chunk-payload
`maxBytes`, never splits a chunk, and returns `nextIndex` while more remain. `maxBytes` defaults to
16 MiB and is capped at 256 MiB; transport/header encoding overhead is additional. A bound smaller
than the next chunk fails with `result_too_large` and the required payload size. The response is
access-checked against the checkpoint's complete scope union.

`exportSyncBundle` is protocol-v1's offline, whole-memory export page. It requires `AccessContext`
and exact `confirmSpaceId`; it targets explicit `checkpointId` or the current HEAD. A page contains
1..64 frames by caller/default bound and a canonical frame-array payload of at most caller/default
`maxBytes`; defaults are 16 frames and 32 MiB, and the byte cap is 256 MiB. The repeated page
checkpoint/envelope is additional. A checkpoint chunk is never split. Header inventory defaults to
10,000 and MUST be bounded to 1..100,000. The sum of the canonical individual checkpoint-frame
encodings (without array separators) defaults to 64 MiB and MUST be caller-bounded to 1 byte..1 GiB
with `maxCheckpointBytes`. Both whole-bundle ceilings are cursor-bound. A non-empty target MUST
retain an available local payload through every page or export fails with the ordinary explicit
reseed detail.

Frames are ordered in three phases: `{type:'checkpoint', index, checkpoint}` for every access-visible
stored local header in `(createdAt,id)` order followed by deterministic genesis; existing target
chunks in increasing index order; and exactly one final `commit`. Checkpoint-frame indexes start at
zero without gaps. A domain-separated SHA-256 chain over each full portable header commits the
header sequence; `commit` carries the exact bundle media type and version, `checkpointCount`, the
exact `checkpointByteLength`, the chain digest, target id, chunk count, and target root digest. It is
therefore self-describing even when page envelopes are not retained. Each header id and chunk/root
digest retains its ordinary protocol validation. The exporter MUST validate complete target ancestry
and scope visibility before commit. Hashes detect corruption, not authorship.

For interoperability, `canonical(value)` is the UTF-8 JSON serialization with object keys sorted in
Unicode scalar-value order, array order preserved, and no insignificant whitespace. Hex digests are
lowercase. Let `D = "astrale.temporal-memory/sync-bundle-checkpoint-digest/v1"`, `S` be the exact
space id, `T` the target checkpoint id, and `H[i]` the full checkpoint header in checkpoint frame
`i`. The committed chain is:

```text
h[0]   = SHA256(canonical([D, 1, S, T]))
h[i+1] = SHA256(canonical([D, h[i], i, SHA256(canonical(H[i]))]))
commit.checkpointDigest = h[commit.checkpointCount]
```

This commits the exact sequence encountered by the export cursor. The target and all of its
ancestors MUST be present. With respect to facade commits, the sequence is one logical-and-metadata
snapshot: concurrent checkpoint publication, payload compaction, session cleanup, or other
metadata-only work cannot enter only part of the sequence.

The opaque continuation binds space/generation, normalized access, target checkpoint, source
logical revision, private metadata revision, header ceiling, phase, exact header-chain progress, and
next chunk index. Every page MUST compare both revisions before and after reading. The caller MUST
durably store a complete page and its cursor together; a logical or facade metadata mutation expires
the cursor with retryable `conflict`. Fresh cursors are v2; a pre-v2 alpha cursor is invalid and the
export restarts from its first page because the cursor cannot prove its source metadata state.
`limit` and page-byte bounds may change between calls, but target, access, header-count ceiling, and
aggregate header-byte ceiling may not. A host MUST persist complete pages and their cursor
atomically, and its reader MUST frame/index the container without parsing the complete bundle into
one value. `openSyncBundle` checks exact closed frames; count/byte admission;
contiguous indexes; duplicate ids; extra or missing frames; the complete target ancestry; the
header chain; target/chunk/root counts, bytes, ordering, scopes, and hashes; and commit stability. It
holds bounded header/chunk metadata and at most one chunk body. Its defaults are 10,000 headers,
64 MiB of header frames, and the same 512 MiB/1,000,000-record/65,536-chunk receive limits as
`syncFrom`; callers may lower those limits. It rechecks the commit plus each content-addressed frame
served later and therefore requires the reader to remain available and immutable while a pull runs
or resumes. Once verified, the returned `MemorySyncPeer` feeds native `syncFrom`; reopening the
reader and reusing the same receiver `sessionId` resumes at the first missing receiver chunk. The
package does not prescribe a filesystem/blob/IndexedDB container. Bundle import preserves replica
identity and ancestry; it is not selective format-v4 import and there is no `rebase`.

`compactSyncHistory` is the local payload-retention primitive. It requires `AccessContext`, exact
`confirmSpaceId`, an exact current logical `expectedRevision`, the exact current `expectedHead`, a
canonical UTC `before` instant, and `maxCheckpoints` in 1..64. Each call scans at most that many
immutable headers ordered by `(createdAt, id)`; an opaque continuation is bound to the space
generation, normalized access grant, revision, HEAD, and cutoff. `hasMore` means more headers remain
in the scan, not necessarily more eligible payloads. Every scanned header is integrity- and
scope-checked. The current HEAD and already unavailable payloads are reported as skipped. Dry run
returns the exact selected ids and their canonical chunk, record, and byte counts without mutation.

A committing page atomically replaces each selected checkpoint's local `chunkOwnerId` with a durable
`pruning` owner marker under logical-revision, HEAD-ref, and per-header metadata guards. From that
commit onward the payload is unavailable. Chunks and random-access indexes are then deleted in
128-row metadata-only batches; each completed header becomes `pruned`. `open()` and the next
compaction call finish any remaining `pruning` owners. Thus termination may leave bounded reclaimable
garbage, but cannot leave a header advertising a partially readable payload. The logical space
revision, portable header, checkpoint id, and parent links do not change. `reclaimedBytes` is the sum
of canonical chunk bytes actually deleted by the completed call; it excludes record envelopes,
indexes, and engine overhead.

Compaction is deliberately not `rebase`. `syncCheckpoint` continues to return a pruned header for
ancestry negotiation, while a non-empty `syncChunks` read fails `not_found` with
`details.requiresReseed: true`. A remote head can be rehydrated from that peer under a new owner. If a
divergent three-way merge instead needs a locally pruned common-base payload, `syncFrom` fails before
session staging with non-retryable `conflict` and the same reseed detail; it never approximates the
merge from an older ancestor. The host must set the cutoff from its supported offline-peer horizon
and choose an explicit reset/archive/other reseed workflow. Resumable pull/conflict/apply sessions
block checkpoint-payload compaction.

`syncHistory` MUST page stored checkpoint headers in immutable creation/id order and return each
header's local `available`, `pruning`, or `pruned` payload state plus whether it is current HEAD. Its
cursor binds space generation, normalized access, logical revision, private metadata revision, HEAD,
optional cutoff, and last key. Each page MUST compare the private revision before and after the
checkpoint scan. A concurrent facade metadata transition is a retryable page conflict; a cursor from
an earlier metadata state is rejected and pagination restarts. Fresh cursors are v2; pre-v2 alpha
cursors are invalid because they cannot establish this snapshot. `syncSessions` MUST page durable
session summaries in immutable creation/id order with local detail state. Storage filters and a
facade recheck MUST enforce the session's complete accumulated scope set before returning it.
Session inventory cursors bind generation, normalized access, optional cutoff, and last key; they do
not claim a metadata snapshot while an active session advances.

`compactSyncSessions` is the terminal-detail reclamation primitive. It requires exact space,
revision, HEAD, canonical UTC cutoff, a 1..64 scan bound, scope visibility, and an optional bound
cursor/dry run. Only `succeeded`, `aborted`, or `failed` sessions are eligible. A committing page
atomically marks every selected session `pruning` under revision, HEAD-ref, and per-session metadata
CAS. It then deletes conflict rows, staged purge tombstones, and unreferenced receiver/merge chunks
and indexes in 128-row batches. Before deleting an owner it MUST verify that no immutable
checkpoint still names that owner; referenced checkpoint payloads are retained. The terminal
session header/result is marked `pruned`, not deleted, so status and operation-id idempotency remain.
`open()` and the next compaction finish interrupted pruning. Checkpoint and terminal session headers
are not collected by either compaction API.

`syncFrom` creates a durable receiver session. `sessionId`, when supplied, is the public resume
handle; otherwise a domain-separated id is derived from `operationId` or a generated seed. The
request is bound to space, pinned local/remote heads, common ancestor, strategy, access scopes, and
target revision. Its normalized ancestry bound and `receiveLimits` are bound as well; reusing it for
another request is `idempotency_conflict`, and every resume path rechecks the complete session scope
boundary before returning metadata or continuing work. The effective operation id is bound to the
session and checked for collisions before contacting the peer. `receiveLimits` defaults to 512 MiB of
canonical payload, 1,000,000 records, and 65,536 chunks. It rejects an oversized remote header
before chunk transfer and bounds merge-plan staging; these logical counts do not include database
indexes or engine overhead. Each accepted chunk, its random-access indexes, rolling root/counts,
and next index commit atomically as metadata without advancing the logical revision. Before the
driver call, the central facade commit boundary MUST validate the chunk's closed manifest, ordering,
byte/node bounds and digest and MUST require exactly one complete deterministic index projection per
contained record in that same write. Index-only, partial, duplicate, forged, and checksum-invalid
packs fail before persistence. Retrying requests only the first missing index. Once created, a
session fetches its pinned remote checkpoint
by id rather than following a newer remote HEAD. A local logical mutation after staging makes that
session a non-retryable `conflict`; start a new session against the new local state.

Ancestry negotiation walks complete checkpoint headers with default bound 10,000 and maximum
100,000. It MUST continue down every remote parent branch until that branch reaches already retained
local ancestry; finding the first merge base does not permit discarding other parents. Missing
non-local headers are persisted parent-first in create-if-absent metadata batches of at most 100.
They retain the exact portable header with local `payloadState: 'pruned'`; only an independently
received target may become `available`. A concurrent insertion or rehydration wins the metadata
guard instead of being overwritten. This makes subsequent local ancestry traversal and bundle
export complete while preserving an explicit reseed boundary for unretained payloads.

Missing ancestry is `conflict`; cross-space, protocol, ontology, malformed header, order,
scope, count, checksum, reference, identity, temporal, ontology, support, or scope-closure failures
are `import_invalid` or `integrity_failed` before apply. `fast-forward-only` succeeds only when the
local head is the merge base. `merge` performs a sorted three-way merge:

- identical values, unchanged sides, and one-sided additions/deletions resolve automatically;
- divergent values or delete/modify pairs create durable `both_modified` or `delete_modify`
  conflicts;
- successful purge records union monotonically, and their target/idempotency tombstones suppress
  every referencing record from either side; dependency/support closure also suppresses concurrent
  facts, derivations, lifecycle, and signals whose only support is purge-dominated;
- graph-wide validation turns unreconciled cardinality-one overlaps and cross-branch positive
  derivation cycles into `invalid_combination` conflicts rather than accepting two individually
  valid but jointly invalid branches.

Merge planning stages deterministic conflict rows in metadata-only batches of at most 128 and only
publishes the session's `conflicts` state after every row is durable. A crash may leave an incomplete
prefix while the session is still `planning`; retry deletes the abandoned plan payload and
idempotently completes the same derived conflict identities. Resolution replanning MUST NOT rewrite
an already identical conflict row. This keeps write amplification bounded without weakening durable
resume or conflict auditability.

Purge-dominance traversal memoizes the boolean result for a logical dependency across the pinned
base/local/remote checkpoints. The memo retains no record bodies, admits at most 100,000 dependency
keys, and falls back to exact recomputation after that bound. Checkpoint semantic validation may
retain at most two already checksummed chunks in an operation-local LRU, or 32 MiB at the maximum
16 MiB chunk size. Every random-access lookup still validates the derived index identity, record
digest, and complete record-to-index projection. These accelerators change neither authority nor
fail-closed behavior.

The local `sync_tombstone` acceleration row is not authority by table presence alone. Its envelope
is closed and its id is derived from space, session, `target`/`idempotency` kind, and 64-hex digest.
Every facade commit validates that identity, and every purge-dominance lookup revalidates the loaded
row against the exact requested tuple before suppressing a record. `verifyIntegrity` scans these
rows in bounded keyset pages, requires a valid non-pruned pull-session owner, and reports
`invalid_sync_tombstone`; privileged/raw contamination therefore fails reconciliation instead of
silently deleting live data.

`syncStatus` and `syncConflicts` require access to the session's accumulated complete scope set;
conflicts page stable keys and digests without values. Each `SyncConflictPage` reports its exact
canonical UTF-8 `byteLength`; `maxBytes` defaults to 1 MiB and caps at 16 MiB in addition to the
1..1,000 item limit. Fresh cursors are v2 and resume by the fixed-size derived conflict id, avoiding
the impossible-to-consume cursor produced when v1 embedded a maximally escaped sync key; bounded v1
key cursors remain accepted and continue in v1 order. Stored rows must have the exact metadata
shape, derived id, sync-key identity, reason/digest relationship, and optional resolution before a
safe API exposes or reuses them. `verifyIntegrity` scans session and conflict metadata in bounded
keyset pages, requires every retained conflict to belong to a valid non-pruned pull session, and
reports `invalid_sync_conflict` for violations without changing canonical-export semantics.
`syncConflict` performs a scope-checked point read of that key from the pinned base,
local, and remote checkpoints, verifies all stored conflict digests, and returns explicit `null` for
branch deletion. Its aggregate response defaults to 1 MiB and accepts at most 48 MiB plus envelope
overhead. Once a terminal session is `pruning` or `pruned`, conflict inventory and detail reads fail
with `not_found` and `details.detailsPruned: true`; they cannot look like a valid empty inventory.
`resolveSync` requires the same access, exact `confirmSpaceId`, accepts up to 1,000 unique choices,
and requires an unchanged target revision.
`abortSync` likewise requires access plus exact space confirmation. `local` and `remote` mean the
record at that key on the pinned branch; either may therefore mean deletion when the record is
absent. `delete` explicitly omits it. The entire plan is rebuilt and revalidated after each batch;
secondary referential conflicts may appear when deleting a record with independently changed
dependents. A purge-dominated choice remains deleted regardless of conflict resolution. There is
intentionally no `rebase` operation and no ancestry rewriting.

Validation is transfer-bounded and uses checkpoint indexes for random dependency/support checks. A
stored random-access index MUST have a closed shape and derived space/owner/key identity. Before a
safe indexed read may use its semantic, referential, or ontology fields, it MUST load the owning
checksummed chunk, find the identified portable record, and compare the index with the complete
deterministic projection recomputed from that record. Every facade put of a chunk or index MUST pass
the same exact chunk-plus-index-set validator before reaching a storage driver; raw database writes
remain the explicitly privileged exception. Integrity verification MUST scan chunks and
indexes in keyset pages of at most 100 rows, validate each chunk's closed manifest, request at most
257 indexes for its at-most-256 records so an extra row is visible, compare the exact ordered set,
and report malformed identities or an aggregate index/valid-record count mismatch. Random indexes
are acceleration metadata, never independent authority. Integrity verification MUST also derive the
complete allowed owner set from valid available/pruning checkpoints plus active or physically
reclaiming session states. Any chunk or index owner outside that set produces
`orphan_sync_owner`, even when the pack, hashes, and index projections are internally consistent.

A stored checkpoint also MUST validate its complete portable identity, local non-negative
`sourceRevision` no newer than the current logical revision, and exact payload lifecycle: available
has only `chunkOwnerId`, pruning has only `pruningOwnerId`, and pruned has neither. Stored genesis
rows are invalid because genesis is implicit. Integrity verification MUST traverse every retained
parent link and, for each available checkpoint, recompute its ordered root, chunk/record/byte counts,
cross-chunk key order, and exact scope union through chunk pages of at most 100. The sole valid
`sync_ref` row has id `head`, a closed envelope and canonical timestamp, and points only to implicit
genesis or an available valid checkpoint. Safe checkpoint/history/HEAD reads apply the same local
metadata validation; malformed privileged rows fail `integrity_failed` rather than becoming sync
authority.

The current positive-derivation/cardinality whole-graph validators fail closed above 100,000 graph
nodes, 500,000 graph edges, 250,000 cardinality-one facts, or 1,000,000 within-group comparisons.
These are allocation/CPU safety ceilings, not supported population SLOs; exceeding one is
`result_too_large`. Positive-cycle detection uses an iterative strongly connected-component pass:
only derivations participating in a cyclic component become conflicts, while downstream acyclic
derivations are not over-reported.

Apply sets a maintenance barrier and clears rebuildable projections. The transition into
`applying` or `rolling-back` MUST atomically persist the active session, its deterministic operation
binding, a running operation row, and that facade's private runtime-owner token before the barrier is
visible. Each logical diff atomically updates the durable session cursor with its canonical or
signal record and refreshes the same operation ownership. Canonical diffs emit local `phase: 'sync'`
semantic invalidations; signal diffs emit local put/withdraw/purge signal invalidations. An
interrupted apply makes ordinary APIs fail retryably with `sync_in_progress`. `open()` resumes the
single active apply before becoming ready; once the remote checkpoint is fully received, that resume
does not require the original peer to remain available. `abortSync` can abandon staging or, after
apply began, perform a checkpoint diff back to the retained local head only if the target adds no
purge marker. A new or strengthened purge is non-reversible: abort fails with non-retryable
`conflict` and `details.requiresResume: true`, and the pinned session must complete forward. After
the live logical record stream exactly matches the target checkpoint, operation completion, guarded
HEAD publication, and the terminal session state MUST be written by one revision- and metadata-CAS
guarded storage commit. There is no durable state in which the operation reports success while the
session still requires apply recovery. Abandoning a receiving, planning, conflicting, or failed
pre-apply session deletes partial receiver/plan chunks and indexes plus its conflicts and staged
tombstones; a complete verified remote checkpoint may remain as immutable ancestry/cache data.

Transitioning an interrupted apply into `rolling-back` MUST reuse its operation binding and
atomically commit the rollback marker, reset apply cursors, running `rolling-back` operation, and
current facade owner before the first inverse diff. Applied/deleted counters remain cumulative work
totals for the whole session. Every inverse diff MUST commit its logical record, local semantic or
signal invalidation, continuation cursor, and refreshed operation ownership together. While that
owner lease is live, another facade MUST neither steal nor advance the rollback and ordinary APIs
remain behind `sync_in_progress`. Once the lease is absent, exactly one revision-CAS claimant may
resume from the durable cursor using the retained local checkpoint; recovery MUST NOT require the
original peer or remote transport. Rollback completion MUST atomically publish the completed
operation, retained local HEAD, and terminal `aborted` session. A losing claimant leaves no rollback
or journal residue and retries only after rereading durable state.

Two facades may prepare the same request-bound session concurrently, but transition from the same
snapshot into active apply has exactly one revision-CAS winner. A contender that already observes
the winner's live owner fails retryably with `sync_in_progress`; two commits released from the same
pre-activation snapshot produce one winner and one retryable `conflict`. The loser MUST write no
operation, ownership, session, canonical, journal, or HEAD residue and MUST NOT rebind the winner's
operation token. Once the winner reaches a terminal session, replay of the same session/request/
operation binding returns that durable report; different bindings remain `idempotency_conflict`.

Hard purge and sync are mutually exclusive maintenance operations. As soon as targeted purge has a
durable running marker, it deletes every local sync checkpoint, chunk, index, ref, session,
conflict, and staged tombstone before canonical erasure continues. Recovery repeats that deletion.
Thus an old local pack cannot restore purged plaintext; the next checkpoint begins from deterministic
genesis while carrying the new content-free purge marker. Reset deletes the entire space.

`SyncReport` and `SyncSessionSummary` expose `diagnosticsTruncated: boolean`, bounded warnings, and
an optional bounded error. New and updated `StoredSyncSession` rows retain at most 64 warnings of at
most 2,000 UTF-8 bytes; overflow is the deterministic first 32 and last 32 sample. Error text has the
same byte ceiling. Any omitted bytes, malformed-surrogate replacement, or omitted warning entry sets
the flag; legacy rows without it read as `false`. Normalization runs on every facade storage commit,
including resume, recovery, resolution, abort, and detail compaction. `verifyIntegrity` reports
`invalid_sync_session` for an invalid lifecycle/detail state, truncation flag, warning array, or
error string. A raw query can still bypass this invariant by design, but the next valid session
transition normalizes a shape-valid legacy/oversized row before persistence.

Every stored session envelope MUST otherwise be closed and state-valid. Safe status, inventory,
conflict, resolution, abort, resume, recovery, and cleanup paths MUST validate it before using or
disclosing metadata. Validation recomputes the checkpoint-build or pull request hash; checks
`initialRevision <= snapshotRevision <= current revision`; canonical request/required/current/plan
scope sets; the exact required-scope union of parent or local/remote headers; ancestry and receive
limits; pinned local/remote/base/target/checkpoint references; and any existing sync-operation
binding. `building` and `receiving` sessions MUST match the exact chunk root/count/byte/scope
manifest under their derived owner; an active plan with `planOwnerId` MUST likewise match its plan
manifest. Receive, conflict, apply, rollback, success, and payload/detail lifecycle states have
state-specific required fields and monotonic non-negative counters. A compacted or aborted terminal
row may retain historical counters after its unreferenced physical detail is reclaimed, but those
counters never become active ownership authority again.

Terminal detail compaction is the sole repair exception for diagnostics: it may first normalize an
otherwise structurally valid oversized warning/error sample, then MUST validate every non-diagnostic
binding before writing the bounded pruning transition. It MUST NOT normalize a forged request,
scope, revision, checkpoint, owner, progress, or operation binding into validity.

Checkpoint digests provide corruption and consistency detection, not authenticity, confidentiality,
or peer authorization. A host adapter MUST authenticate peers, authorize whole-space disclosure,
bound transport bodies to the public chunk limits, encrypt sensitive traffic/storage as required,
and prevent transport-level replay/substitution. The alpha provides manual, guarded checkpoint
payload and terminal-session-detail compaction while retaining ancestry and idempotency headers. It
has no automatic retention scheduler, offline-peer lease/acknowledgement protocol,
checkpoint/session-header GC, or engine-overhead quota estimator.

## 6. Reference storage

### 6.1 Surreal capability tiers

| Tier                                  | Capability                                                                                                                                                                                                                                                                                                             |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Alpha-supported and browser-proven    | Embedded `indxdb://` and `mem://`; direct and package module-worker engines; schema bootstrap; closed one-pass `createMemory` JSON configuration ownership with exact live capability capture; bound user values; BM25 lexical search; exact cosine vector ordering; page-native episode browse with access/filter pushdown and compound keyset continuation; native filtered count aggregates and bounded keyset statistics; 16-row row/byte-admitted analysis; exhaustive closed invocation-time ownership across every public JSON/options boundary, including open, management, point access, integrity, and journal lifecycle/compaction; closed bounded one-pass core read, canonical mutation/maintenance, signal browse/put/delete, and complete sync-control-plane request snapshots; 16-row/exact-byte-bounded signal browse and revision-counted atomic key purge; separate atomic semantic and signal journals with feed-discriminated cursors, durable local consumer acknowledgements, and registry- or cursor-derived bounded compaction; scoped signal persistence and dependency purge; content-addressed sync checkpoint staging, transfer, apply, bounded inventory, checkpoint/session-detail compaction, and reopen recovery; construction-time separated, confirmed raw SurrealQL with incremental SDK-frame admission; per-storage scheduling, stable origin-wide physical-call arbitration, and private per-facade runtime-owner liveness for persistent clients; fail-closed persistent open without Web Locks; graceful close and fresh IndexedDB connection; actual owning-page termination after durable episode acceptance with interrupted-operation recovery and explicit retry, at every durable hard-purge application/recovery phase, after one durable sync-apply diff with peer-independent completion, and after one durable inverse rollback diff with retained-local-HEAD recovery and no remote peer; concurrent reads through one shared storage capability; two-page direct/direct, worker/worker, and mixed guarded signal put/withdraw/purge contention, signal-target disjoint soft-delete contention and both soft-delete/hard-purge winner directions with residue-free rebaseline semantics, hard-purge pre-marker late-dependency rejection and explicit replan, distinct hard-purge one-winner marker starts with live-marker pre-planning rejection and explicit retry, one-winner hard-purge recovery claim, single derivation create/replay/re-evaluation/withdrawal/cascade plus complete two-conclusion batch contention/replay/re-evaluation, registered same-batch semantic/signal journal compaction contention, one-winner same-session sync activation with residue-free terminal replay, reset fencing, logical-race rejection for snapshot/recall/point read/browse/neighborhood/analyze/export/integrity/signal browse/both feed pages, and metadata-sensitive statistics/inspection fencing. |
| Implemented but not release-qualified | Per-space revision-guarded transactions, facade idempotency, liveness-fenced operation/purge/sync recovery beyond the listed browser points, scope-aware lexical/vector top-k.                                                                                                                                                                                           |
| Unsupported                           | HTTP/WS/cloud Surreal endpoints, general independent-tab/process coordination beyond the listed optimistic and guarded-transaction cases, remote Surreal operation, HNSW/vector indexes, database-native graph traversal/PageRank, qualified IndexedDB MVCC time travel, raw database changefeeds, spatial retrieval, and an alternative-store conformance API.                                                                            |

The browser-proven reset boundary in the first row includes deterministic canonical-writer/reset
contention in both winner directions across direct/direct, worker/worker, and mixed clients; it does
not include physical termination inside the deletion transaction.

The adapter accepts only `indxdb://${string}`, `mem://${string}`, or `mem://`. Defaults are namespace
`astrale`, database `temporal_memory`, endpoint `indxdb://astrale-temporal-memory`, and direct mode;
`worker: true` selects the package-owned module-worker engine. The storage-options envelope is
closed to `endpoint`, `namespace`, `database`, and `worker`; the privileged factory applies the same
validation before constructing its pair.

A shared-driver reference is acquired only after physical connect, namespace/database selection,
schema declaration, idempotent envelope backfill, and index declaration all complete. Once the
physical connect callback has started, any failure in that sequence is owned by the driver: it MUST
attempt a physical close, MUST NOT increment the reference count, and MUST NOT make the facade
cleanup path decrement another live facade's reference. A new connect attempt MUST NOT begin while
that cleanup is unresolved. If cleanup itself fails or its completion is lost, the error MUST retain
`details.connectionCleanup: 'pending'`; a subsequent `open()` or explicit `close()` first retries the
idempotent cleanup. The same retained boundary applies when the last normal reference's physical
close loses completion. The facade MUST keep `close()` active after either failed path rather than
treating its locally closed state as proof that storage cleanup completed. A successful cleanup may
then reuse the same capability; schema/bootstrap retry is safe only because every package-owned step
is idempotent. This is resource-lifecycle reconciliation, not a claim about browser-process or
database-worker termination.

### 6.2 Privileged raw SurrealQL

`createSurrealMemoryStorage` returns the application-only `SurrealMemoryStorage` capability with no
`rawQuery` property and MUST NOT be accepted by any later elevation API.
`createSurrealMemoryCapabilities(storageOptions, adminOptions)` MUST reject unless the closed admin
options envelope contains `dangerouslyAllowRawQueries: true`, construct one fresh driver, and return
a frozen `{ storage, admin }` pair whose members share that driver. The admin handle MUST reject
while its paired storage is closed and MUST execute through the same per-storage database scheduler
and, for `indxdb://`, the same origin-wide Web Lock used by the facade. Direct and worker engines have
the same contract. This capability exists only on
the `/surreal` entry point; it is not part of `Memory`, `SurrealMemoryStorage`, or the in-memory
adapter. Separating handles is a least-authority dependency-injection boundary, not authentication
or same-origin code isolation: trusted host code controls who receives the admin handle.

Every `SurrealRawQueryRequest` contains `query`, optional `bindings`, exact `confirmNamespace` and
`confirmDatabase`, and optional `maxResultBytes`/`maxResultNodes`. The request envelope is closed.
Query text is non-empty well-formed Unicode bounded to 1 MiB. Bindings contain at most 1,024 valid
Surreal identifier names and otherwise obey the ordinary 100,000-node, depth-64, and 4,000,000
aggregate-string-byte JSON limits. Dynamic values MUST be bindings rather than interpolated query
fragments. Before scheduling database work, the adapter MUST read the admitted top-level fields into
one local snapshot and copy plus validate bindings in one bounded traversal that does not validate
and then reread a JSON path. Later caller mutation therefore cannot alter query text, target, limits,
or bound values. A request or binding accessor that cannot be read MUST fail as `invalid_input`
before database dispatch. Target confirmation mismatch also fails before dispatch.

The result uses SurrealDB's JSON representation and contains the SHA-256 query-text hash, one
success or structured failure per statement, `allSucceeded`, and its exact canonical JSON byte
length. Callers may supply a result tuple generic constrained to `readonly JsonValue[]`; it remains
an unchecked TypeScript assertion, and runtime validation remains structural JSON validation rather
than caller-selected schema validation. Results default to 8 MiB and 100,000 nodes, with
hard maxima of 64 MiB and 1,000,000 nodes. A bound violation is `result_too_large`. Query dispatch
and connection failures are normalized storage errors, while SurrealQL statement failures remain
in-band so prior successful non-transactional statements are not concealed.

The adapter MUST consume the SDK's incremental JSON query-frame stream. It MUST admit every scalar
or batched row against cumulative node and stable-JSON-byte limits before retaining that value in the
public response and MUST stop consuming once a limit fails. It therefore MUST NOT first collect an
unbounded whole statement result. The SDK/engine may still materialize one physical chunk and one
row before the adapter observes it; the public limits are not a database-work, heap, or per-row
allocation proof.

If physical execution returns statement responses but adapter-side JSON validation, hashing, node
admission, or exact-byte admission then fails, the call MUST fail non-retryably with
`details.queryOutcome: 'responses_received'` and `details.requiresReconciliation: true`. Statements,
including non-transactional mutations, may already have committed. The error MUST retain available
query hash and exact required-work details. This post-response boundary MUST NOT poison or reopen the
otherwise healthy shared connection; the trusted caller reconciles durable state through a new
bounded query and MUST NOT blindly replay the original request.

The adapter MUST NOT automatically retry raw queries: a multi-statement query may be non-idempotent.
Each SurrealQL statement has the database's ordinary transaction semantics; the caller MUST use an
explicit `BEGIN TRANSACTION`/`COMMIT TRANSACTION` block for an atomic group. Incremental frame
admission bounds aggregate adapter retention but not an engine chunk, an individual returned row,
scan cost, or latency. Potentially large queries MUST include native `LIMIT` and, where supported,
`TIMEOUT`. The installed SDK provides no physical cancellation method for a dispatched query stream,
so `SurrealMemoryAdmin.rawQuery` MUST NOT expose an `AbortSignal` that would only abandon adapter
observation while database work continued. Ending iteration or abandoning the returned promise is
not cancellation.

Arbitrary SurrealQL has no adapter-inferable safe resume key or idempotency boundary. The raw API
therefore MUST NOT promise generic retry or resume. A caller that needs a resumable large read MUST
author deterministic keyset-paginated statements with bound cursor values and `LIMIT`, durably store
its application cursor only after consuming each admitted response, and choose its own snapshot or
revision-consistency policy. Whole-memory portable transfer and reconciliation MUST use the bounded,
content-addressed sync APIs rather than recreating their framing through raw SQL.

If a physical raw-query call fails without statement responses, the shared driver MUST retain the
non-retryable `queryOutcome: 'unknown'` error as a connection poison. The admin handle, every paired
facade storage call, and cached `Memory.open()` MUST return that same error without another database
call. Closing only one of several open facades MUST NOT clear it. The final storage reference MUST
physically close the connection; only a subsequent fresh physical open may clear the poison. A
facade whose driver open failed before acquiring a reference MUST NOT decrement another facade's
reference in its cleanup path. Generated transactions use the same shared-driver rule with
`transactionOutcome: 'unknown'`. A fresh physical open clears only the connection poison; it MUST
NOT infer rollback or recreate durable state. If the uncertain transaction may have deleted a
space, ordinary open MUST surface `space_not_found` and only an explicit `open({ create: true })`
may recreate it. This is conservative reconciliation, not proof of the actual commit state.

Raw SurrealQL is a trusted-host, database-wide administrator capability. It intentionally bypasses
`AccessContext`, disclosure policy, canonical validation, revision CAS, semantic/signal journals,
projection invalidation, purge discovery, and sync bookkeeping. Reads over `tm_*` may power expert
analysis. Raw writes SHOULD target downstream-owned tables; mutating a package-owned table makes
facade coherence the host's migration/repair responsibility and does not advance the private
`metadataRevision`. The host MUST quiesce facade and raw writers around such a migration/repair, use
an explicit transaction where multiple statements form one change, and run `verifyIntegrity`
afterward. A verifier that overlaps an unrevisioned raw write has no coherent-snapshot guarantee.
Exact confirmation prevents accidental target selection, not malicious statements. Enabling raw
queries does not relax the embedded engine's disabled scripting, guest-access, or network-target
capabilities. The surface is one-shot SurrealQL with JSON-compatible results; native SDK values and
live-query subscription handles are not exposed.

The intended SurrealDB optimization order is relational projection plus recursive-neighborhood
pushdown, canonical filter/aggregate/page pushdown, benchmark-driven pushdown of explicit-seed
personalized PageRank, and only then benchmark-justified HNSW. Automatic query-to-seed selection
requires evidence-based selection semantics. Optional geometry support follows demonstrated product cases rather
than becoming mandatory metadata. The public incremental API already emits package-level affected
targets, scope partitions, canonical revision, and operation lineage. Database changefeeds may be
used later only as an internal wake-up mechanism after engine qualification; they do not replace the
semantic payload. None of those optimizations may bypass facade access or temporal filtering.

### 6.3 Physical schema

The adapter creates `tm_space`, `tm_episode`, `tm_operation`, `tm_entity`, `tm_alias`, `tm_mention`,
`tm_fact`, `tm_evidence`, `tm_lifecycle`, `tm_merge`, `tm_projection`, `tm_purge`, `tm_change`,
`tm_signal`, `tm_derivation`, `tm_signal_change`, `tm_journal_consumer`, `tm_journal_registry`,
`tm_sync_checkpoint`, `tm_sync_chunk`,
`tm_sync_index`, `tm_sync_ref`, `tm_sync_session`, `tm_sync_conflict`, `tm_sync_tombstone`, and
`tm_migration`. Tables are SCHEMAFULL at the envelope level, but their canonical
`payload` field is `object FLEXIBLE`. Indexed envelope fields support identity, operation state,
aliases, fact adjacency/time/status, evidence, lifecycle, projections, purge state, signal
identity/selection, and derivation conclusion/premise/rule/state lookup. BM25 indexes projection text. `tm_change` indexes unique
`(space_id, revision)` and stores its semantic envelope/payload. `tm_signal_change` separately
indexes unique `(space_id, revision)` and stores signal actions plus scope-partitioned logical keys
and targets without values. Spaces carry a private incarnation nonce for cursor reset detection and
monotonic `changesCompactedThrough` and `signalChangesCompactedThrough` floors. A private safe-integer
`metadataRevision` starts at zero and advances on every facade driver commit, whether logical or
metadata-only. It is internal storage coordination state and MUST NOT be exposed as a public memory
revision or journal position; it MAY appear only inside an opaque package consistency cursor. Each
journal's compaction uses its `(space_id, revision)` index for one transactional range deletion plus
floor/revision update. `tm_journal_consumer` uniquely indexes `(space_id, journal, consumer_id)` and
indexes `(space_id, journal, state, consumer_id)` for bounded keyset enumeration;
`tm_journal_registry` uniquely indexes `(space_id, journal)` and supplies the exact epoch guarded by
registered compaction. Both are local operational metadata: archive and replica sync omit them,
hard purge retains them, and reset deletes them. Their schema declarations are additive on open for
existing schema-v7 databases and do not change the portable canonical schema version. A separate
private safe-integer `canonicalRevision` advances only with a
semantic canonical commit. Long-running projection builds bind it so projection/operation-only
commits can proceed while any source-graph change prevents activation. `tm_space.payload` carries
the active per-kind projection-set references; `tm_projection.set_id` is indexed with space, kind,
and state. Search always requires exact active-set equality, including `NONE` for legacy rows. A
staged lexical row keeps text only in its flexible payload and is absent from the global BM25 index.
The activation transaction retires old indexed text, copies the complete new set's text into the
index, marks those payloads ready, and changes the authoritative space reference atomically; hidden
rows therefore cannot perturb active-set document-frequency scores. Embedding and summary rows use
the same readiness/reference boundary without BM25 work. Existing schema-v7 spaces additively
backfill both private counters to zero on open without changing the public memory revision. Evidence
and mention anchors live in canonical payloads; evidence ids
incorporate the anchor, so separate occurrences do not collide. `tm_signal` uniquely indexes
`(space_id, logical_key, version)` and indexes namespace/target, producer/slot, normalized tags,
recorded revision, and expiry. Direct signal purge executes one revision-guarded
`DELETE tm_signal WHERE space_id = $space AND logical_key IN $keys` statement after the native
revision count; signal-change creation and space revision advancement share that transaction. Vector
search is exact cosine ordering and has no HNSW index.
`tm_derivation` also uniquely indexes `(space_id, logical_key, version)` and indexes conclusion,
fact/evidence premise arrays, rule id/version, state, and recorded revision.
`tm_fact.conflict_group` is a schemafull optional envelope field indexed with `space_id`. Opening an
existing schema-v7 database idempotently backfills it from `payload.conflictGroup` without advancing
the logical or private metadata revision; distinct-conflict statistics can therefore filter and
order only grouped facts.
Sync tables index chunk owner/order, checkpoint owner/key/kind/dependencies, HEAD, session state,
conflict session/key, and staged purge digests. Sync-only metadata commits compare the current
logical revision, private metadata revision, and optional exact record guards. They advance only the
metadata revision, may mutate only these seven tables, and cannot emit either journal. Logical apply
commits advance both revisions and remain ordinary revision-advancing transactions. Journal-
consumer metadata commits have the same logical/private revision checks, may mutate only consumer
and registry rows, advance the journal epoch atomically, and cannot emit either journal.

All records carry `space_id`; facade queries bind values. Package-owned constant SurrealQL creates
schema and indexes. User/model strings are bound values, never query fragments. An enabled raw query
is the explicit trusted-host exception and still requires application data to use bindings.

`tm_migration` stores immutable successful additive-schema checkpoints. The only current registry is
the ordered `5 -> 6 -> 7` chain: step 6 initializes a missing signal-change compaction floor, and
step 7 initializes missing private metadata/canonical counters. Each declaration fixes an id,
sequence, source version, target version, and additive defaults. Its checksum is SHA-256 over those
fields plus the versioned `astrale.temporal-memory.schema-migration/v1` domain. Changing a shipped
declaration therefore invalidates its prior checkpoints instead of silently changing history.

Migration is opt-in through `open({ migrate: true })`; omission MUST preserve fail-closed behavior.
For each step, the adapter MUST atomically verify the exact source schema, logical revision, private
metadata revision, and absent checkpoint; create the `succeeded` checkpoint; update only the schema
version and missing additive defaults; and advance only the private metadata revision. It MUST NOT
advance the public logical or canonical-source revision, change canonical `updatedAt`, or emit a
semantic/signal journal row. A committed target version without its checkpoint, or vice versa, is
invalid.

The schema version is the durable chain cursor. Reopen reads the current space and ordered history,
validates every known checksum and transition, and resumes at the first uncommitted step. Reads of
space/history are bracketed by the private revision so a simultaneous migration is retried rather
than mistaken for corruption. Two concurrent opens may race, but deterministic checkpoint ids,
schema/revision guards, and idempotent post-error rereads MUST converge on one history. An unknown,
duplicate, reordered, altered, disconnected, newer, schema-4, or more-than-16-step history fails
with `incompatible_schema`. `inspect().schemaMigrations` exposes content-free public checkpoint
lineage.

Additive migration has no exclusive facade owner, operation row, or long-running lease. Every
opener MUST still opt in, but any opted-in opener may help the deterministic chain after another
client wins a step or disappears. Concurrent clients paused before the same step therefore converge
on one version/checkpoint pair; termination after a committed step leaves that pair valid and the
next opener resumes at the following step. Adapter close or realm death MUST NOT roll back a
committed checkpoint. There is no downgrade, ontology migration, canonical row transform, or
automatic backup contract; physical process/database-worker termination inside the atomic
transaction remains a separate gate.

`tm_merge.active` is a schemafull optional boolean with an index over
`(space_id, target_id, active)`, and current-view retrieval pushes `active = true` into the storage
query. Non-current views skip merge storage because historical merge reconstruction is explicitly
not implemented. Opening schema-v7 storage idempotently backfills a missing physical `active`
envelope field from `payload.active` before declaring the index and initializes a missing private
`payload.metadataRevision` to zero. These are additive physical migrations: canonical payload and
logical revision do not change, and no canonical schema-version bump is required. Fresh databases no
longer declare the ineffective historical `state` index; an upgraded engine may retain that unused
index until administrative cleanup or reset.

### 6.4 Transactions and scheduler

Canonical schema version is `7`; sync protocol `1` and format-v4 archives are independently
versioned. Sync tables are additive metadata under schema 7 and do not reinterpret canonical
payloads. Schema-5 and schema-6 spaces fail closed by default and use only the explicit additive
migration registry above. Canonical commits execute in Surreal
transactions, atomically create their semantic change row, and compare/advance a per-space logical
revision. Every driver commit also compares and advances `metadataRevision` in the same transaction;
this prevents two facade commits that share one logical revision from silently overwriting each
other's sync metadata. A mismatch is a retryable `conflict`.
`canonicalRevision` advances only when the commit carries a semantic canonical change. Projection
staging captures and guards that counter across its physical commits, so its own revision churn is
allowed but any source-graph mutation prevents the active-set switch.
Signal put/withdraw/purge commits instead atomically create a separate signal-change row at that
shared physical revision and never fabricate a semantic change.
Derivation put/withdrawal and premise-driven invalidation are canonical commits: one semantic
change covers their resulting fact/lifecycle transitions and projection invalidation.
No precomputed canonical/governance/projection put-delete plan may refresh its revision and retry.
Retraction, merge, split, deletion, import, projection rebuild, and explicit or selector-based purge
commit against the exact revision from which their complete selection was built; a conflict is
retryable but the caller MUST rerun the complete mutation, using request-bound replay only for a
method that defines it and a fresh operation ID otherwise. Purge pins even explicit-ID
selection before building the admitted erasure closure and commits its durable running marker at
that same revision.
`deleteEpisodes` and selector-based purge additionally require the caller-previewed revision.
Signal put/withdraw/purge, `deriveFact`, and `withdrawDerivation` likewise use caller-supplied exact
revision CAS and never rebase evaluated output, premises, or portable state.

`correctFact` and episode canonical integration may retry internally only after rereading and
replanning the entire semantic mutation. Every correction retry MUST also rescan and authorize the
target's complete direct support set under the caller's original access. Every episode-integration attempt rechecks the durable
idempotency purge tombstone, live accepted episode identity, content hash, and retention state.
Ordinary and target-selected projection generation captures its source revision before reading
scopes or invoking a provider and performs one atomic target-set commit attempt; a revision race
produces a failed/stale result rather than writing against the newer graph. Full rebuild may stage
multiple hidden batches, but every batch and the final active-set/index transaction bind the same
canonical source revision. Operation-status writes likewise make one revision-CAS attempt.

The short physical-call Web Lock and the runtime-owner lease serve different contracts. The former
prevents concurrent embedded SDK entry and is released after each call; the latter proves facade
liveness without holding the database lock. Recovery MUST NOT infer death from the presence of a
second client, operation age, wall-clock timeout, or background suspension alone.

A per-`MemoryStorage` scheduler serializes database calls to avoid re-entering the shared WASM/Rust
engine. It is not a process-global or endpoint-global scheduler. Multiple queries that construct a
retrieval universe run sequentially and may span revisions. Recall, search, neighborhood, browse,
snapshot, and analysis bracket the complete logical read with the space incarnation and revision
and fail rather than returning a result after either changes. This proves a stable optimistic
revision window for successful calls; it is not database-native snapshot isolation, a process-wide
lock, or yet independently evidenced across browser tabs/adapters.

An open `Memory` facade is bound to the private space incarnation loaded by `open()`. If another
context destructively resets and recreates the same `spaceId`, the stale facade fails with
`conflict` and `details.requiresReopen: true`; it cannot silently adopt the replacement while
retaining old ontology/provider configuration. `close()` followed by `open()` explicitly rebinds it.

## 7. Events, errors, and diagnostics

The alpha event map contains and emits `lifecycle:ready`, `operation:settled`, provider
request/result, resolution decision, reconciliation decision, and `retrieval:complete`. Listener
failures are routed to the `MemoryOptions.onError` callback without changing operation results.
Events are process-local notifications: they are not replayable and are not Spectron-style durable
retrieval/decision/response traces. The separate `changes` and `signalChanges` APIs are replayable
mutation journals for canonical and non-epistemic signal planes respectively, but deliberately
record no retrieval candidates, scores, decisions, prompts, responses, or feedback. Any future
trace records require their own scope, disclosure, retention, deletion, and relevance-only feedback
semantics.

Every newly written `ProcessingOperation` exposes `diagnosticsState: 'available' | 'purged'`.
Legacy rows without the field read as `available`. A `purged` operation is intentionally not a
replayable report: its diagnostic payload is absent, and reuse of its id fails
`idempotency_conflict`. Caller-supplied operation IDs are retained operational lineage and therefore
MUST remain opaque and non-sensitive. `verifyIntegrity` MUST report
`invalid_operation_tombstone` when a purged operation has an episode binding, result, error,
warning, provider call, retryable/non-terminal state, missing completion instant, or a stage other
than `purged`; an available operation with a `purged` stage is `invalid_operation`.

Every newly written operation also exposes `diagnosticsTruncated: boolean`; legacy rows without it
read as `false`. An available row stores at most 64 warnings, each at most 2,000 UTF-8 bytes, and at
most 64 `ProviderCallSummary` values. On overflow it retains the first 32 and last 32 entries and
sets `diagnosticsTruncated`. Truncated error-message bytes, omitted error `details`, or replacement
of provider-authored warning/error text also set the flag. Durable errors retain only `name`, code,
bounded message, retryability, and optional operation
id. Provider warning strings become one content-free count warning; provider and storage exception
messages are replaced by library-authored classifications before persistence. Provider-call rows
accept only capability, bounded provider/model labels, destination, at most 64 unique bounded field
names, canonical timestamps, and outcome; payload or unknown fields are invalid. A purged tombstone
sets `diagnosticsTruncated: false` because erasure is represented by `diagnosticsState`, not sample
truncation. `verifyIntegrity` reports `invalid_operation` for any over-budget or malformed available
row and `invalid_operation_tombstone` if a purged row claims truncation.

Every new stored operation also carries a private random `bindingId`; newly written `pending` and
`running` rows additionally carry the current facade's private `runtimeOwnerId`. Both are removed
from the public operation view. `runtimeOwnerId` is liveness metadata, not operation identity, and a
legitimate recovery/resume may replace it only after proving the previous owner's lease absent. The
pair `(spaceId, operationId)` remains create-once. A write may replace an existing non-terminal
operation only when `bindingId`, kind, and optional `episodeId` are identical; `succeeded`, `failed`,
`cancelled`, and purged rows reject ordinary replacement as `idempotency_conflict`. The only
exception is hard purge replacing a contaminated row with its content-free diagnostics tombstone.
Legacy non-terminal rows without a binding may transition only through another binding-less record;
legacy rows without `runtimeOwnerId` are recoverable but do not weaken binding checks. Replay-aware
methods inspect their request-bound stored result before mutation; neither private field turns reuse
into an implicit replay. Integrity accepts missing owner metadata on legacy rows, rejects malformed
owner tokens, and rejects any purged tombstone that retains one.

Caller-supplied identity semantics are closed as follows:

| Method | Normative reuse behavior |
| --- | --- |
| `remember` | Episode identity remains `(spaceId, idempotencyKey)`. A supplied `operationId` on replay MUST resolve to an `ingest` operation bound to that episode; a missing operation row, reprocess binding, or different episode binding MUST fail `idempotency_conflict`. Omitting the ID requests ordinary episode-key replay and returns the latest processing report. |
| `deriveFact`, `deriveFacts`, `withdrawDerivation`, `withdrawDerivations`, `correctFact`, `deleteEpisodes` | The operation MUST bind the complete normalized semantic request. Same-request settled reuse returns the stored result; mismatch is `idempotency_conflict`; an in-flight match is retryable `conflict`. Single/batch activation and single/batch withdrawal are distinct request kinds. A supplied derivation-withdrawal or episode-deletion selection cursor is part of the normalized request and MUST be repeated for replay. Work ceilings are replay admission, not semantic identity. |
| `createSyncCheckpoint` | `operationId` is a seed for the checkpoint-build session. Its derived session and complete request hash are resumable; reuse with a different parent, revision, access partition, or chunk ceiling is `idempotency_conflict` or a pinned-revision `conflict`. |
| `syncFrom` | `sessionId`, when present, is the primary resume identity; otherwise `operationId` seeds the session. The effective operation ID is bound to that session and the full pinned plan. Resume MUST reauthorize scope and revalidate all request/limit fields. |
| `hardPurge` | The ID binds the normalized purge request and a collision-resistant marker. Recovery resumes a running marker forward. A completed marker is not a replayable report and all later reuse is `idempotency_conflict`. |
| `retryEpisode`, `reprocessEpisode`, `retractFact`, `mergeEntities`, `splitEntityMerge`, `deleteEpisode`, committed `import`, `rebuildProjections` | Fresh-only: an ID MUST have no durable binding when admission starts. A residue-free pre-admission/CAS loser leaves its ID unused and may submit it again; once any operation row is persisted, retry uses a new ID. Revision/semantic preconditions, not ID replay, prevent stale or duplicate mutation. |
| Dry-run `import` | MUST reject `operationId`; it creates no durable operation. |
| `resetSpace` | MUST NOT accept `OperationOptions`. It returns a generated response-local operation summary, then removes the space and journal; it therefore cannot enforce a caller ID across success. |
| `resolveSync`, `abortSync` | MUST NOT accept `OperationOptions`; the existing `sessionId` is the sole durable continuation identity. |

An API not listed as replay-aware MUST NOT interpret reuse as success. Runtime validation MUST reject
an `operationId` where the exported option type excludes it rather than silently discarding the
property.

`MemoryError` is realm-brand-detectable and JSON-serializable. Construction MUST snapshot and
recursively freeze `details`, then freeze the public error instance. A caller that retains or catches
an error therefore cannot change its code, retryability, operation identity, or nested reconciliation
markers for another observer. `cause` remains an opaque diagnostic reference: it is neither cloned
nor deep-frozen and is omitted from `toJSON()`.

Its declared codes are:

`invalid_input`, `not_open`, `space_not_found`, `space_exists`, `scope_denied`, `policy_denied`,
`provider_unavailable`, `provider_error`, `malformed_provider_output`, `ontology_violation`,
`unresolved`, `idempotency_conflict`, `not_found`, `result_too_large`, `conflict`, `cancelled`, `timeout`,
`storage_quota`, `storage_failed`, `projection_failed`, `integrity_failed`,
`incompatible_schema`, `import_invalid`, `purge_in_progress`, `sync_in_progress`, and `internal`.

Provider-capable ingestion/retry/reprocess, recall/search, correction, and projection rebuild create
the configured operation deadline. Their disclosure-policy authorization, inference, embedding, and
reranking waits race that signal. Elapsed deadlines use the retryable `timeout` code; caller abort
uses non-retryable `cancelled`. External code that ignores abort may continue work, but its late
result is detached and cannot invoke the next capability or mutate canonical state. Storage and
sync-peer waits do not share this hard race: the facade checks the signal between awaits and passes
it to cooperative peers, but MUST NOT detach a possibly committing storage write. Engine/transport
timeouts and ambiguous-failure reconciliation belong to those layers. `retryable` never overrides
a method's operation-identity contract; specifically, an unknown transaction/query outcome is
non-retryable until reopen and durable-state reconciliation. `stats` intentionally
reports record, conflict, operation, semantic-change, signal-change, current active non-expired
signal, signal-revision, active derivation, derivation-revision, both journal floors,
stale-projection, and provider-call counts plus active projection-set lineage; it is a
trusted whole-space diagnostic without an `AccessContext`. It returns `snapshotRevision` and
`generatedAt`. `stats(options)` and `inspect(options)` accept one shared `ManagementOptions` with an
optional abort signal and caller-lowerable physical `scanLimits`. Defaults are 100,000 transferred
rows and 64 MiB of stable row JSON; hard maxima are 1,000,000 rows and 256 MiB. Their reports expose
the exact cumulative `PhysicalScanWork`. `stats_scan` admits every derivation revision,
conflict-bearing fact, signal revision, projection, and operation transferred for residual metrics;
`inspection_scan` admits every transferred projection. A breach MUST fail with `result_too_large`
and exact phase/dimension/required/maximum details rather than return partial metrics. Native count
aggregates and the statically bounded migration-checkpoint list do not transfer individual rows and
are excluded from this work measure. Simple cardinalities MUST use the storage adapter's native count operation;
SurrealDB implements it with a bound `SELECT count() ... GROUP ALL` aggregate. Latest active
derivation and non-expired signal state, distinct conflict groups, stale projections, and provider
calls MUST use lexicographic keyset pages containing at most 1,000 records and MUST NOT use
whole-space export. `inspect` MUST natively count pending/running/partial operations and scan stale
projections through the same page bound; it MUST honor cancellation even while closed, return zero
scan work when no space is open, reject a replaced space generation, and expose the currently read
space rather than a stale facade cache. Inspection and projection maintenance reports expose the
same set lineage. These remaining scans are O(n); scan limits bound facade-transferred stable JSON,
not native aggregate engine work, heap, or latency, and the page bound does not imply a
database-scan latency bound.
`verifyIntegrity` returns the checked `snapshotRevision` and `checkedAt`. Statistics, open-space
inspection, and integrity verification bracket their aggregate/scanned result and fail with
retryable `conflict` on concurrent logical-revision change. `stats`, open-space `inspect`,
`verifyIntegrity`, each `syncHistory` page, and each `exportSyncBundle` page additionally bracket
their paged metadata reads with the private metadata revision; a concurrent metadata-only facade
commit also produces retryable `conflict`. Their public revision fields remain logical revisions.

`verifyIntegrity({ limits })` performs a complete physical-row check under independently
caller-lowerable work ceilings. The defaults and hard maxima are:

| Dimension       | Default      | Hard maximum | Meaning |
| --------------- | ------------ | ------------ | ------- |
| `maxRecords`    | `100,000`    | `1,000,000`  | Distinct admitted canonical, journal, projection, purge, operation, signal, and sync rows. |
| `maxBytes`      | `67,108,864` | `268,435,456` | Stable UTF-8 JSON bytes of those distinct rows. |
| `maxGraphNodes` | `100,000`    | `250,000`    | Distinct fact nodes in the current active derivation-cycle graph. |
| `maxGraphEdges` | `500,000`    | `1,000,000`  | Current active fact-premise edges checked for cycles. |
| `maxIssues`     | `1,000`      | `10,000`     | Retained issue details; `0` requests a summary-only report. |

All fields except `maxIssues` accept integers from `1` through their maximum; `maxIssues` accepts
`0` through its maximum. Unknown limit fields are `invalid_input`. Every contributing storage kind
MUST be read through advancing ascending-id keysets of at most 16 rows. Because a sync chunk can
itself contain up to 16 MiB, sync-chunk integrity pages MUST contain at most one physical row. The
upper-bound probe and every internal parent, manifest, operation, and random-index read MUST be
admitted to the same distinct-row ledger before it can influence the result. Implementations MUST
NOT call whole-space export.

A row counts before validation or deduplication into semantic views. Re-reading the same
`kindRecord`/`id` counts once. A record/byte breach is `result_too_large` with
`{ phase: 'integrity', dimension: 'records' | 'bytes', required, maximum }`; graph breaches use
`graph_nodes` or `graph_edges` in the same shape. Integrity is read-only and a limit failure cannot
advance logical or private metadata revision. Active derivation cycle detection MUST be iterative,
not recursively proportional to graph depth.

The returned `work` reports exact admitted rows, stable bytes, graph nodes, graph edges, effective
limits, total `issuesDetected`, and `issuesTruncated`. `maxIssues` caps only retained detail; checking
continues, `issuesDetected` includes omitted warnings and errors, and `ok` is false if any detected
error exists even when `issues` is empty. The report has no separate canonical-response-byte cap.
These ceilings bound cumulative facade admission and retained diagnostic detail, not JavaScript heap
bytes, engine-internal scan work, disk reads, or latency; one bounded storage page is materialized
before its rows can be admitted. The complete check remains O(n).

## 8. Current evidence

The current repository contains deterministic Vitest coverage for lifecycle, ingestion,
providers/disclosure, retrieval, management, governance, temporal/scope isolation, contracts,
archive, maintained derivation, signal, sync, and both change-journal behaviors. The current count is
258 non-browser tests across 15 files and 270 total tests across 16 files when the twelve browser
cases are included. The browser harness runs real Chromium against direct and module-worker SurrealDB WASM
engines and proves:

- persistence across graceful close and a fresh IndexedDB connection;
- a generated transaction that first writes a valid projection and then violates a schema field
  returns `transactionOutcome: 'rolled_back'`, leaves both rows and all three space revisions
  unchanged, then permits a guarded write and cleanup on the same direct or worker connection;
- injected post-execution completion loss after a privileged raw query and after a revision-guarded
  generated space deletion returns the corresponding `queryOutcome: 'unknown'` or
  `transactionOutcome: 'unknown'` in direct and worker modes; admin, paired facade, and cached open
  remain fenced across a partial shared close, while final close plus fresh physical open clears the
  poison, exposes the committed deletion, and requires explicit recreation at revision zero; the
  retained shared error and nested details are frozen, so the first observer cannot weaken the
  retryability or reconciliation markers seen by later observers;
- caller node/byte bounds are enforced while consuming SDK frames, before whole-result collection,
  and reject with non-retryable
  `queryOutcome: 'responses_received'`; a direct/worker multi-statement probe commits a
  downstream-owned row before response admission rejects, then reconciles that row through the same
  healthy connection without replaying the mutation;
- injected completion loss after physical connect, after schema bootstrap, during failed-open
  cleanup, and during final close proves that direct and worker drivers retain zero-reference cleanup
  ownership, block a new connect until it settles, keep facade `close()` retryable, and reuse the same
  capability without leaking or stealing a reference;
- injected post-commit response loss fences a facade without a second physical settlement write;
  close/reopen rotates its owner token, recovers interrupted ingestion, replays a request-bound
  derivation, preserves a committed fresh-only identity seal, and requires explicit recreation after
  an unknown successful reset;
- canonical fact and BM25 lexical recall after reopen;
- schemafull/indexed active and inactive merge selection through the storage driver;
- additive schema-5-to-7 migration commits ordered checksummed audit records and persists through a
  fresh connection; independent direct/direct, worker/worker, and mixed clients paused before the
  same first step converge on one two-checkpoint chain, while actual owner-page termination after
  that complete transaction leaves an atomic schema-6 cursor that a fresh client resumes to 7;
- native filtered statistics counts return exact values in both adapters;
- bounded canonical ingestion reports admitted work and fails closed at a one-row planning limit in
  both adapters;
- inference-context assembly fails at a one-row scan ceiling before provider invocation and resumes
  the accepted episode under a bounded retry in both adapters;
- bounded signal pages, exact response bytes, and revision-counted atomic logical-key purge execute
  in both adapters;
- filtered `id`, `oldest`, and `newest` episode keysets, Unicode-order cursor parity, and coherent
  recall lineage;
- recall, neighborhood, residual entity browse, and native episode browse report admitted scan work
  and fail closed at an explicit one-row ceiling in both adapters;
- twenty concurrent stats reads through two facades sharing one storage capability;
- a second facade opened while another owner is paused after durable episode acceptance leaves the
  live operation unchanged; abrupt closure of the owning page releases its runtime lease, after
  which the observer reopens, marks exactly that operation interrupted, preserves one accepted
  episode/change, and completes canonical processing with a fresh `retryEpisode` operation across
  direct/direct, worker/worker, and mixed engines;
- hard-purge recovery has one same-revision owner claim before work resumes; actual owner-page death
  after marker creation, between sync-metadata batches, before final canonical settlement, and after
  a recovery claim converges on complete metadata/canonical erasure, one content-free marker and
  journal transition, integrity, and replay denial across all three engine pairings; a third facade
  cannot steal the live recovery claim;
- sync apply atomically creates its active session and owner operation, then atomically publishes its
  completed operation, guarded HEAD, and terminal session; a second facade cannot steal the live
  owner after its first journaled diff, and actual owning-page termination lets observer reopen
  finish the already received checkpoint without the original peer across all three engine pairings;
- rollback after one committed forward diff atomically reuses the same operation and restores toward
  the retained local checkpoint; a second facade cannot steal it after its first inverse diff, while
  actual owning-page termination lets observer reopen complete the `aborted` session, local HEAD, and
  exact two-entry forward/inverse journal history without opening the original peer across all three
  engine pairings;
- two identical sync requests paused at the same pre-activation revision have exactly one owner and
  one retryable conflict across all three engine pairings; the loser leaves no duplicate operation,
  canonical row, journal change, or HEAD state, and terminal replay returns the winner's report;
- every sync request and standalone access argument is captured once before queueing, local storage,
  or peer work; source tests cover the complete method matrix plus zero-I/O unknown-field rejection,
  while real direct/worker Chromium and clean installed Node/browser consumers mutate checkpoint,
  pull, inventory, and compaction authority/identity/limit values immediately after invocation and
  observe only the original request;
- two rebuilds paused before their running-operation commits have exactly one durable admission
  winner across direct/direct, worker/worker, and mixed engines; the loser has no operation or staged
  row and its still-unbound id succeeds after settlement. A live contender separately fails before
  target/provider/staging work while naming the owner. Actual owner-page termination after hidden
  lexical rows are durable but before activation leaves old-set recall intact; observer reopen marks
  the operation interrupted, and a fresh full rebuild atomically activates and reclaims every
  abandoned/inactive row;
- two same-origin pages with separate IndexedDB/WASM clients enforce one-winner signal put CAS and a
  retryable loser without partial signal or journal rows, converge after explicit retry, and enforce
  the same one-winner/no-residue boundary for identical same-preview signal withdrawal and retained-
  key purge across direct/direct, worker/worker, and mixed direct/worker engines;
- signal-target canonical actions paused before their first commit serialize across all three engine
  pairings: disjoint soft deletions have one complete winner, a residue-free loser carrying
  `requiresSignalBaseline`, and explicit retry with the unbound losing ID; from one shared cursor,
  both deterministic soft-delete/hard-purge winner directions leave exactly the requested winner's
  canonical, lifecycle, marker, operation, semantic, and signal effects, while a consumed selection
  returns no destructive cursor;
- a hard purge paused after its real target read rejects a newly committed signal dependency with a
  retryable conflict before creating its operation or marker or erasing data; explicit retry replans,
  includes, and erases that dependency across all three engine pairings;
- two distinct purges paused from the same snapshot have exactly one revision-CAS marker winner and
  one retryable, residue-free conflict; when the winning marker is already live, the contender
  instead fails with `purge_in_progress` naming it before target/dependency planning. Both losers
  remain unbound, explicitly replan after settlement, and converge with integrity across all three
  engine pairings;
- a signal consumer registered behind the current head is visible to another client; when compaction
  pauses after its bounded registry scan, an independent acknowledgement advances the checkpoint,
  invalidates the stale plan with retryable `conflict`, and leaves the floor and journal untouched.
  Immediate termination of the acknowledging page is followed by a fresh direct/worker opener that
  observes the advanced checkpoint across all three engine pairings;
- after a durable feed-specific consumer registered by one client is visible to the other and both
  read the same registry-derived semantic- or signal-journal compaction batch, one atomic
  commit deletes exactly that batch and advances only its floor, the other client receives retryable
  conflict without cross-journal mutation, both clients converge, and the old feed cursor receives
  its specific baseline-reacquisition error across all three engine pairings;
- two reasoners paused after complete derivation planning produce one canonical conclusion/support/
  operation/change winner and one residue-free retryable loser; the other client can replay the bound
  winner without a write, while explicit re-evaluation with the unbound losing ID returns `supported`
  without duplicate support or semantic change;
- two complete two-conclusion batch plans paused at commit produce one operation/revision/change
  winner containing both conclusions and supports, plus one retryable loser with no fact,
  derivation, lifecycle, operation, projection, or journal residue; cross-client winner replay is
  stable, and explicit loser re-evaluation at the new revision returns two ordered `supported`
  results without duplicate support or semantic change;
- after a downstream conclusion is derived from that root, two withdrawals paused at commit produce
  one tombstone/cascading-invalidation winner and one residue-free loser; cross-client winner replay
  is stable, both unsupported facts retract, and integrity remains valid across all engine pairings;
- the same clients fence a stale facade after reset/recreate;
- a test-only gate after a real canonical page deterministically overlaps an independent logical
  commit with snapshot and recall, and both readers return retryable conflict; the same gate overlaps
  metadata-only checkpoint work with statistics, which conflicts while the public logical revision
  remains unchanged, across all three engine pairings;
- core point-read, recall, search, neighborhood, browse, snapshot, analysis, semantic/signal feed,
  and export requests detach before their first await; source, direct/worker IndexedDB, and installed
  Node/browser consumers mutate nested authority, filters, anchors, seeds, IDs, targets, and limits
  immediately after invocation, while changing accessors contribute only their first value and
  unknown fields fail before storage;
- SQL-shaped hostile text remains stored/queryable data;
- raw SurrealQL is absent from application storage, requires separate acknowledged admin-capability
  acquisition and exact database confirmation, uses bound values, enforces JSON response bounds,
  exposes statement failures, rejects after storage close, and uses the persistent origin-wide
  coordinator rather than bypassing it;
- signal browse, put, and delete synchronously detach their complete closed request envelopes before
  asynchronous work; source, direct/worker Chromium, and installed Node/browser consumers prove
  that immediate nested mutation and changing accessors cannot retarget the admitted operation;
- projection rebuild reports admitted input/output work and a targeted one-row failure leaves the
  active lexical set unchanged in both adapters;
- bounded canonical export executes through the native keyset path and fails closed on an explicit
  archive-byte ceiling; format-4 import rejects a re-signed identity change and an unknown nested
  source property in both adapters;
- complete snapshot assembly executes through native 16-row keysets, reports physical row/byte work,
  and fails closed on an explicit scan ceiling in both adapters;
- bounded indexed derivation creation, withdrawal, current-revision reactivation, correction,
  retraction, single-episode deletion, and explicit work-limit rejection execute in both adapters,
  and canonical derivation persistence plus fact assembly survive a fresh direct/worker IndexedDB
  connection;
- analysis advances canonical and signal history through 16-row keysets, reports admitted physical
  rows and exact stable-JSON bytes, rejects an explicit scan ceiling, and completes in both adapters;
- durable semantic and signal changes plus their local consumer checkpoints survive reopen;
- direct/worker Chromium replay denial plus semantic-journal identifier scrubbing after purge in
  the reopened session;
- scoped signal persistence, analysis diagnostics, atomic signal-selected episode soft
  deletion/withdrawal, full-selection signal-target purge, complete dependency-key closure through
  the physical `tm_signal` table, and content-free signal-journal invalidation after hard purge; and
- bounded indexed compaction of both journals, old-cursor invalidation, both persisted floors, and
  an unrelated retained signal survive a third fresh IndexedDB connection; and
- a complete content-addressed checkpoint, full signal/derivation history, and purge replay
  tombstones transfer to an independent IndexedDB replica and remain valid after that replica is
  closed and reopened, in both direct and worker engines; and
- a newer source HEAD can compact the prior checkpoint payload while retaining its ancestry header,
  and that unavailable-payload state survives another fresh direct/worker IndexedDB connection.

Separate deterministic in-memory schedules pause a canonical ingestion, a hard purge after its
durable running marker, and sync immediately after the atomic active-session/owner-operation commit.
A second opener leaves all three live-owner operations untouched; explicit sync resume also fails
with `sync_in_progress` instead of stealing the binding. The sync schedule additionally proves that
successful operation completion, HEAD publication, and terminal session state share one guarded
commit. The hard-purge schedule additionally releases two ownerless recovery claims from the same
revision and proves one owner plus one terminal journal transition. These are facade/recovery-contract
tests; separate browser schedules supply application-boundary owner-termination evidence for hard
purge, forward sync, and rollback.

An injected storage-commit failure also proves that the correction path leaves none of its episode,
evidence, replacement, supersession, or operation records partially committed. This is canonical
atomicity evidence in the tested adapter, not abrupt persistent-engine kill evidence.

Provider-race fixtures prove a completed first batch can persist `building` rows under a hidden set while
semantic recall still returns no item from that generation; release of the final batch changes the
active reference and makes the complete set visible. A separate independent-facade canonical write
advances the source revision and prevents activation, leaving the prior set active and no stale rows
after cleanup. The direct and worker browser paths exercise the schemafull `set_id` field, active-set
index, search predicate, space-reference commit, and reopen behavior, but do not kill an engine
between staging and activation.

The browser harness uses graceful closes and reopens after purge and compaction, but its ingestion-
recovery case actually terminates the owning page at an instrumented point after the acceptance
transaction and before canonical commit. Separate sync cases terminate the owner after the first
complete journaled forward transaction and after the first complete inverse rollback transaction.
Apply resumes from the received checkpoint; rollback restores the retained local checkpoint with
the source page gone. Both continue from their durable cursors. A hard-purge case terminates owners
after the marker commit, between bounded sync-metadata deletion batches, before the final canonical
commit, and after a recovery-owner claim; all phases re-claim once and resume forward. The expanded independent-tab matrix first reproduced a two-winner guarded-write failure under overlapping embedded
transactions, then proves the stable Web Lock plus transaction guard restores one winner across
direct/direct, worker/worker, and mixed engines. The same matrix covers same-preview signal
withdrawal/purge, signal-target disjoint soft-delete contention and both soft-delete/hard-purge
winner directions with residue-free rebaseline semantics, pre-marker hard-purge late-dependency
rejection plus explicit replan, distinct hard-purge one-winner marker starts plus live-marker
pre-planning rejection and explicit retry, derivation create/replay/re-evaluation/withdrawal with
cascading invalidation, deterministic same-batch contention and cross-journal non-interference for
  both feed compactors, same-session sync activation contention with residue-free replay,
  destructive-reset/canonical-writer contention in both winner directions, reset fencing, logical-race
detection for snapshot, recall, checked point read, browse, neighborhood, analysis, bounded archive
export, integrity, signal browse, and both feed pages, plus metadata-sensitive statistics and
inspection. A context with Web Locks masked proves `indxdb://` fails closed while `mem://` remains
usable. The page-death cases prove lease release and recovery at those precise application
boundaries; they are not database-worker termination during a physical call, browser-process
restart, background suspension, quota, corruption, physical mid-transaction termination, or broad
cross-context mutation evidence. The
file
named `golden-v1.json` is a case-to-test index, not a golden input/output corpus, and the suite is
example-based rather than a generative property suite.

The repository also contains a CI gate for lint, format, typecheck, tests, build, deterministic SBOM
freshness, npm production audit, offline OSV matching, and package verification. GitHub Actions are
pinned to immutable commits. The OSV Scanner `2.5.0` release binary is checksum-pinned; CI downloads
the public npm and crates.io advisory databases, then uses `--offline-vulnerabilities --offline` so
the candidate inventory is not sent to an advisory query service. The complete gate is scheduled
weekly even without a source change, and weekly Dependabot proposals cover the npm workspace and
GitHub Actions; the URL-pinned WASM and its embedded Cargo graph still require an explicit fork
update. Package verification packs the prerelease, installs it into a
clean temporary consumer with an isolated package store, fetches and hash-checks the pinned public
WASM release, checks publish-time exports and legal/docs files, byte-compares and structurally
validates the installed CycloneDX inventory, and runs an
ingest/derive/correct/retract/delete/signal/signal-target-delete/signal-target-purge/change/journal-compaction/checkpoint-compaction/projection-rebuild/export/dry-run/import/sync/recall
runtime smoke, typechecks projection/retrieval scan work, `browse`/`analyze`/signal/`deleteEpisode`/
`deleteEpisodes.signalTargets`/`hardPurge.signalTargets`/`changes`/`signalChanges`/sync, the journal-
consumer lifecycle, and all three compaction APIs, and reopens IndexedDB with a persisted signal,
both journals, and both local consumer checkpoints before syncing an independent replica through
installed direct and module-worker engines. It also runs a mixed direct/worker two-page guarded
signal race, explicit retry, cross-page signal-compaction floor, and reset/reopen fence from the
installed tarball. The browser artifact proof uses Vite 8 with
`@astrale-os/surrealdb-wasm` excluded from dependency optimization. These source and
packed-candidate gates pass; that does not assert npm publication or a particular remote CI run.

Temporal Memory's local package metadata declares Apache-2.0, public access, README, LICENSE,
CHANGELOG, repository, bugs, and homepage metadata. The Astrale adapter JavaScript is also
Apache-2.0, but embedded `surrealdb-core`, `surrealdb-types`, and `surrealdb-types-derive` 3.0.5 are
BSL 1.1 with a 2030-01-01 change date, and `surrealdb-protocol` 0.8.3 is BSL 1.1 with a 2029-09-17
change date. The candidate declares `SEE LICENSE IN LICENSES.md`, and the reference runtime is not
wholly open source before those dates. SurrealDB's
[official licence FAQ](https://support.surrealdb.com/en/articles/11541883-frequently-asked-questions)
says embedded application use is permitted
while a commercial hosted database service is restricted. The operative BSL texts and their
definition of “Database Service” control; approving this mixed-license boundary remains a release
blocker. The build emits a deterministic CycloneDX 1.6 SBOM covering the complete resolved npm graph,
337 unique components from the shipped locked Cargo inventory, both distinct BUSL change dates, and
the exact WASM file hash. It omits timestamps and machine paths, derives its serial from content, and
is byte-compared plus structurally checked after clean-consumer installation. The shipped inventory
does not encode intra-Cargo dependency edges, so a standard CycloneDX relationship composition marks
those nested relationships `unknown` instead of inventing them. No publication, support level,
signed provenance, vulnerability clearance, or dependency-license approval is asserted by this
specification. On 2026-08-09, the npm audit reports no advisory across the 49-package production
workspace lock closure. OSV Scanner recognizes all 344 npm/Cargo packages in the SBOM and matches
ten distinct advisory classes across nine inherited Cargo components: two unmaintained notices,
seven advisories with newer fixed versions, and one unpatched `rsa` timing advisory. The source
inventory cannot prove their intra-Cargo or affected-function reachability. The checked-in exceptions
name each record, state the required disposition, and expire on 2026-08-23; new or expired findings
fail CI. Those exceptions are a time-bounded triage baseline, not a release waiver or attestation.

## 9. Explicit alpha limitations

The following behavior remains incomplete or unqualified in `0.1.0-alpha.1`:

- Revision-bracketed retrieval is not a database-native snapshot transaction. Snapshot, recall,
  checked point reads, browse, neighborhood, analyze, integrity, bounded archive export, signal
  browse, both feed pages, statistics, and inspection now have adversarial independent-tab/adapter
  evidence; this detects overlap but does not create one multi-query engine snapshot.
- Signal-basis validation now uses a bounded addressed provenance closure rather than enumerating
  the whole space. Destructive reset is necessarily whole-space by semantics, but performs a native
  bounded preflight followed by a streaming 16-row accounting scan rather than retaining the space
  in JavaScript. Canonical ingestion, inference-context assembly, and affected truth maintenance
  use bounded plans. Projection rebuild, recall, search, neighborhood,
  residual browse, integrity, snapshot, analysis, and canonical selector governance remain O(n),
  but use explicit row/byte and
  applicable graph/CPU ceilings with bounded keyset pages. Statistics/inspection use native counts
  plus 1,000-record keyset pages; signal browse
  and direct signal governance use 16-record scans plus exact response/revision guards. Format-v4
  export also uses 16-row canonical-only keysets, but still materializes its selected document within
  explicit scan/output/node limits. Their remaining scans are O(n), and descending or
  mixed-direction bounded pages may force a Surreal table iterator on IndexedDB.
- Only the additive schema-5/6-to-7 path is migrated. Downgrade, schema-4, ontology migration,
  canonical row transforms, physical mid-transaction migration death, retention enforcement, byte-accurate
  storage pressure, and repair actions are absent.
- Automatic signal expiry/application, a signal archive importer, retrieval-score plug-ins,
  automatic journal retention, cross-device consumer coordination, lease-based expiry,
  incarnation-safe retirement-tombstone reclamation, durable
  retrieval/decision traces, iterative rule/fixpoint execution, temporal rule-basis views,
  calibrated source authority/uncertainty, and ontology evolution are absent. Bounded atomic
  multi-conclusion activation is implemented but deliberately cannot consume its own outputs.
- Source-section hierarchy, RAKE keyword bridges, automatic query-to-seed selection, adaptive
  retrieval escalation, and optional spatial retrieval are absent.
- Remote/server Surreal, independent-context mutation families beyond guarded signal
  put/withdraw/purge, signal-target canonical delete/purge, hard-purge pre-marker late-dependency
  fencing and distinct-start contention, derivation
  create/replay/re-evaluation/withdrawal/cascade, semantic-feed acknowledgement-versus-compaction
  contention beyond the shared registry path's signal-feed proof,
  destructive-reset/canonical-writer contention in both winner directions, reset fencing,
  post-accept ingestion page-death recovery, every durable hard-purge application and
  recovery phase, post-first-diff sync-apply and rollback page-death recovery, plus same-session
  activation contention; browser-process/mid-transaction crash recovery and large-corpus behavior
  are unqualified.
- Sync has no built-in network/authentication/encryption layer. Manual checkpoint-payload compaction
  exists, but automatic retention, peer acknowledgement/lease policy, header/session-metadata GC,
  hostile-peer fuzzing, quota/disk-amplification targets, independent-context contention, and
  population-scale validation remain unqualified despite bounded chunks and fail-closed graph
  ceilings.
- Extension and Copilot tests prove a detached public type/value boundary only; they are not real
  consumer integration tests.

## 10. Production gates

Production support requires all of the following, with independent evidence:

1. **Consistency:** the listed complete-read optimistic brackets, reset/recreate fencing, and both
   destructive-reset/canonical-writer winner directions now have direct/worker/mixed-tab evidence.
   Cross-client mutation evidence covers guarded signal
   put/withdraw/purge, signal-target disjoint soft-delete contention plus both soft-delete/hard-purge
   winner directions, hard-purge pre-marker late-dependency rejection plus explicit replan, distinct
   hard-purge one-winner starts plus live-marker pre-planning rejection and explicit retry, and
   derivation create/replay/re-evaluation/withdrawal with cascading invalidation; the corrected
   correction path has independent-facade evidence. Runtime-owner liveness prevents open-time theft
   of ordinary, hard-purge, and sync-apply operations; post-accept ingestion page death, every
   durable hard-purge application/recovery phase, and post-first-diff sync-apply plus rollback page
   death have direct/worker/mixed recovery proof. Other semantic replans and a legacy-marker upgrade
   policy remain required. Atomic projection-set admission, cutover, old-set recall, owner-page
   termination, and inactive-set recovery now have independent direct/direct, worker/worker, and
   mixed-client qualification; physical termination inside the SurrealDB transaction remains part
   of the broader process-kill gate.
2. **Evolution:** the implemented ordered/checksummed/atomic additive chain now has independent
   same-step convergence and actual owner-page death between steps. Extend it with physical
   mid-transaction process/database-worker death evidence and a ratified backup/version window; any
   canonical row-transforming or ontology migration needs restart checkpoints and downgrade refusal
   tests across real stored versions.
3. **Scale:** storage pushdown for canonical and signal filters, graph neighborhoods, browse,
   selector previews, and aggregates; native relation projection where justified;
   streaming selective archives; ratified automatic/offline-peer policy around manual checkpoint
   payload compaction; bounded header/session collection; and named sync transfer/reconciliation
   latency, memory, disk-amplification, and size SLOs. HNSW or another ANN index is adopted only from
   measured need.
4. **Browser failure:** database-worker or owning realm termination during a physical write,
   browser-process restart, extension suspension,
   independent-context mutation families beyond guarded signal put/withdraw/purge, signal-target
   canonical delete/purge, hard-purge pre-marker late-dependency rejection, distinct-start contention,
   derivation create/replay/re-evaluation/withdrawal/cascade, signal acknowledgement/registered-
   compaction contention and owner-page recovery, semantic/signal compaction contention, reset
   fencing, and the implemented ingestion, hard-purge, sync-apply, rollback page-death, and same-
   session activation schedules; quota exhaustion and corruption recovery.
5. **API stability:** format-v4 merge/count/manifest shapes and raw-query JSON result tuples are now
   exact. Freeze the remaining reviewed prerelease-to-stable compatibility boundary. The operation-
   id matrix and the deliberately capability-hard/storage-cooperative deadline boundary above are
   already normative.
6. **Quality:** true golden inputs/outputs, property and fault-injection tests, scope
   non-interference across every derived channel, recomputable episode content identity in archives,
   and archive round-trip equivalence at scale.
7. **Evolution substrate:** the implemented local durable consumer registry gains physical
   browser-process/database-worker mid-commit evidence, a ratified cross-device ownership policy,
   and incarnation-safe tombstone reclamation if high-churn identifiers are required. Committed
   acknowledgement survives immediate owner-page termination; deterministic acknowledgement race,
   registered cross-context same-batch compaction, and feed-read races are already covered. The
   signal plane gains
   storage-bounded selection and explicit
   portability/retrieval-policy decisions; the derivation plane gains abrupt-restart, large-graph,
   and archive-remap qualification plus a decision on temporal-basis and iterative-fixpoint
   semantics; independent-client single-conclusion and atomic two-conclusion create/replay/re-
   evaluation are covered, as is single-conclusion withdraw/cascade. Any
   future trace/calibration plane has versioned
   lineage, affected-target IDs, revision CAS, scope non-interference, retention/deletion, restart
   behavior, and explicit separation from truth support.
8. **Consumers and release:** actual extension and Copilot integration, clean packed-consumer proof
   in CI, mixed-license approval, resolution or explicit risk approval of the inherited Cargo
   advisory baseline before its exceptions expire, signed provenance, registry publication, and
   support policy. Deterministic CycloneDX generation, packed-artifact verification, npm audit,
   scheduled offline OSV matching, and weekly dependency proposals are already implemented.
9. **Sync transport:** authenticated and encrypted peer adapters, bounded-body enforcement,
   replay/substitution threat tests, independent-context payload-compaction and recovery evidence,
   automatic retention/header GC policy, and adversarial multi-writer convergence evidence.

Until these gates are satisfied, this package is an evaluation alpha with useful executable
semantics—not a production memory service or a stable persistence format.
