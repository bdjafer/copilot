# Headless Temporal Graph Memory

## Product contract and alpha status

| Field                 | Value                                                                      |
| --------------------- | -------------------------------------------------------------------------- |
| Contract status       | Normative product contract                                                 |
| Implementation status | Working `0.1.0-alpha.1` evaluation baseline                                |
| Release status        | Prerelease; not a production-readiness or registry-publication declaration |
| Date                  | 2026-08-04                                                                 |
| Runtime               | Browser-compatible JavaScript/TypeScript; Node.js 20+ for the test adapter |
| Reference persistence | Embedded SurrealDB WASM with IndexedDB persistence                         |
| Tested Surreal pair   | `@astrale-os/surrealdb-wasm 3.0.4-astrale.1` + `surrealdb 2.0.8`            |
| Planned consumers     | Chrome extension orchestration layer and headless Copilot module           |

This document owns product semantics, boundaries, invariants, and release gates for
`@astrale-os/temporal-memory`. The implementation specification owns exact TypeScript contracts,
storage records, defaults, ordering, and errors. Source and tests show the current alpha behavior;
they do not silently weaken the semantic locks in this document.

The terms **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** describe requirement
strength. A normative requirement is not an assertion that the alpha or a published artifact has
already satisfied it. Current behavior and remaining gates are called out explicitly below.

## 1. Purpose

The package turns normalized source episodes into an evolving temporal graph of entities, claims,
and evidence, then returns scoped, attributable context to downstream AI applications.

The product is inspired by Graphiti's context-graph model and benchmarked against SurrealDB
Spectron's published memory architecture, but it is an independent design, not a browser port,
service wrapper, or compatibility layer. Its stable product concepts are:

- immutable source evidence;
- resolved identities and source-local mentions;
- temporal claims rather than asserted truth;
- provenance and conflict history;
- incremental updates;
- replaceable search projections;
- deterministic, scope-bounded reads.

The first integration target is a Chrome extension, but the package remains Chrome-independent.
The extension and Copilot integrations are planned consumers, not current production integrations.

## 2. Ownership and boundaries

| Concern                                       | Memory package               | Host application                | Model provider               |
| --------------------------------------------- | ---------------------------- | ------------------------------- | ---------------------------- |
| Episode validation and idempotency            | Owns                         | Supplies normalized input       | None                         |
| Browser capture and permissions               | None                         | Owns                            | None                         |
| Authentication and principal-to-scope mapping | None                         | Owns                            | None                         |
| Entity/fact extraction                        | Orchestrates                 | Supplies provider or assertions | Executes requested inference |
| Resolution and temporal reconciliation        | Owns                         | Configures ontology and policy  | May propose candidates       |
| Canonical graph and projections               | Owns                         | Hosts storage capability        | None                         |
| Recall, browse, snapshot, and analysis        | Owns                         | Calls and consumes              | May embed or rerank          |
| Semantic revision change feed                 | Owns                         | Persists consumer cursor         | None                         |
| Non-epistemic signal revisions                | Owns generic scoped substrate | Runs algorithms and applies policy | None                      |
| Conversation, planning, tools, and actions    | None                         | Owns                            | None                         |
| Provider credentials                          | Never persists by default    | Owns                            | Validates                    |
| Export, import, correction, and purge UX      | Provides headless capability | Owns UX and authorization       | None                         |
| Whole-memory replica synchronization          | Owns logical protocol        | Owns transport, peer auth, and policy | None                    |

The package MUST:

- expose a programmatic API with no required UI;
- avoid dependencies on DOM state, Chrome APIs, extension manifests, or a UI framework;
- accept storage, providers, policy, ontology, time, and identity generation through configuration;
- require no HTTP application server or separate database process;
- remain usable from a worker-compatible browser environment;
- avoid importing the extension or Copilot packages;
- keep SurrealQL, physical tables, record ids, transactions, and database handles private from the
  ordinary memory capability; the separately granted, construction-time database-admin capability
  is the explicit trusted escape hatch and never exposes the database handle itself.

The initial product does not own page scraping, file parsing, email access, third-party connectors,
live dialogue state, agent actions, credential storage, user authentication, legal consent decisions,
cloud service operation, transport discovery, collaborative tenancy, or Graphiti compatibility.

## 3. Semantic model

| Concept              | Contract                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Memory space         | Top-level isolation and lifecycle boundary. Every canonical record belongs to exactly one space.                           |
| Episode              | Immutable accepted evidence with content, source, time, scopes, sensitivity, retention metadata, and idempotency identity. |
| Entity               | Persistent identity assembled from scoped, episode-backed aliases and identifiers.                                         |
| Mention              | Exact source-local occurrence and anchor that may resolve to an entity without losing its original wording and episode.    |
| Fact                 | Independently addressable temporal claim from a subject through a predicate to an entity or scalar object.                 |
| Evidence link        | Relation plus exact episode anchor showing where an episode supports, corrects, contradicts, or mentions a target.         |
| Lifecycle transition | Record-time change such as creation, supersession, dispute, retraction, deletion, merge, or split.                         |
| Ontology             | Versioned entity/fact definitions and constraints supplied by the host.                                                    |
| Projection           | Rebuildable lexical text, embedding, or summary derived from canonical records.                                            |
| Signal               | Immutable scoped non-epistemic annotation/recommendation revision with declared target, basis, producer, and input revision. |
| Processing operation | Durable status, diagnostics, provider accounting, and recovery information for work.                                       |

Episodes are evidence. Entities, facts, summaries, and classifications are interpretations. A fact
is a claim supported by sources, not a certificate of objective truth. Every new evidence link
resolves to immutable episode content through either a UTF-16 text range or an RFC 6901 JSON
Pointer. A provider-authored excerpt is accepted only when it exactly matches that source anchor;
it never becomes a quote merely because a model returned it.

The product keeps the following axes independent:

| Axis | Meaning | Alpha state |
| --- | --- | --- |
| Source authority/trust | A policy prior about an origin or author, not whether one claim is true. | Source identity is durable; calibrated trust is not yet canonical. |
| Extraction confidence | How certain an extractor is that it interpreted an episode correctly. | Not a canonical support weight. |
| Evidential support | Which retained episodes support, contradict, or correct a claim. | First-class evidence graph. |
| Reconciliation state | Whether a claim is active, disputed, superseded, retracted, or deleted in a view. | First-class fact/lifecycle state. |
| Retrieval relevance | Query-local rank contribution from exact, lexical, semantic, graph, or temporal channels. | Returned per channel and never persisted as truth. |
| Salience and retention | Whether a host should surface, strengthen, weaken, expire, delete, or purge material. | Scoped signals can persist recommendations; host policy applies them and no signal silently changes truth. |

Confidence, trust, support count, temporal state, retrieval score, structural centrality, and
retention eligibility MUST NOT be collapsed into one mutable importance number.

### 3.1 Semantic invariants

1. Every canonical record belongs to one memory space.
2. Accepted episode content is immutable except for soft-deletion state or hard purge.
3. Every derived fact is traceable to retained evidence or an explicit host assertion.
4. Current knowledge is a view over claims and evidence, not destructive rewriting of history.
5. Supersession, dispute, correction, and retraction preserve prior records unless hard-purged.
6. Reusing an idempotency identity cannot duplicate canonical knowledge or silently change content.
7. Entity resolution cannot destroy mention-level or episode-level provenance.
8. Entity merges are auditable; undoing a recorded merge MUST preserve source identities.
9. Search scores never become truth confidence.
10. Canonical meaning remains available when projections are absent, stale, or rebuilt. A full
    rebuild cannot expose a partial generation: successful kinds switch by one active-set commit,
    while a failed kind retains its previous active set.
11. Reads, traversal, ranking, diagnostics, and provider context never cross a space boundary.
12. A record is visible only when every required scope is allowed by the caller.
13. Removing one evidence source does not remove a fact supported by another retained source.
14. Hard purge removes targeted canonical content and projections that would reveal it.
15. Provider credentials never enter canonical records, durable call summaries, or exports.
16. All accepted instants use canonical UTC RFC 3339 form with millisecond precision.
17. A citation excerpt is derived from immutable episode content at its stored anchor, never trusted
    as free-form provider prose.
18. Canonical aliases are identity labels, not source mentions unless a literal anchored occurrence
    exists in the episode.
19. Every semantic canonical mutation atomically records scope-partitioned affected targets; physical
    projection or operation churn does not masquerade as a semantic change.
20. Hard purge removes erased target identifiers from semantic journal affected-target fields and
    emits only content-free invalidation for affected disclosure partitions. Operation ids remain
    opaque, non-sensitive lineage and MUST NOT encode content or target identifiers.
21. Signal revisions are not evidence, factual support, confidence, lifecycle truth, or implicit
    retrieval weight. A signal write MUST NOT mutate canonical records or emit a semantic change.
22. An algorithm signal declares a non-empty visible basis, the exact input revision and temporal
    view it analyzed, and scopes at least as restrictive as every episode/fact dependency.
23. Every entity target or entity basis reference in a signal is grounded by a declared episode or
    fact dependency that is actually adjacent to that entity; an entity-only inference cannot
    become a declassification path.
24. Canonical hard purge removes every revision of a signal key when any declared target or basis
    revision references purged data. Opaque signal values and labels MUST NOT conceal sensitive
    dependencies that purge is expected to discover.
25. Every signal put, withdrawal, or purge atomically records a separate scope-partitioned
    signal-change row; it never appears in the semantic journal or changes factual support.
26. Hard purge removes erased keys and targets from historical signal-change rows and emits only
    content-free invalidations for affected scope partitions.
27. Signal-selected canonical deletion or erasure requires a constrained current
    active/non-expired preview, an exact full-selection cursor, explicit breadth confirmation, and
    a separate `deleteEpisodes` or `hardPurge` call; signal values never authorize or determine the
    action.
28. Signal-selected soft deletion accepts episode targets only and atomically withdraws the exact
    selected signal revisions in the same physical commit. The canonical and signal journals remain
    separate records at that shared revision, so applying a recommendation cannot leave it active.
29. Hard purge replaces every operation diagnostically linked to erased data with a content-free,
    immutable tombstone. It removes episode, result, error, warning, and provider-call fields; exposes
    `diagnosticsState: 'purged'`; and prevents late or reused commits from restoring those fields.
    Unrelated operation diagnostics remain available, while whole-memory rebuild, sync, and migration
    diagnostics are conservatively treated as linked. Integrity verification detects a rehydrated or
    non-terminal tombstone as an error.
30. A durable operation id is create-once within its space. A private run binding authorizes only
    same-kind, same-episode transitions of that non-terminal operation; terminal operations and purge
    tombstones cannot be rebound. Explicit replay APIs may read an already-bound result but never
    replace its row, and the private binding is not part of `ProcessingOperation`.
31. Available operation diagnostics are bounded data, not an unbounded trace sink. New rows retain
    at most 64 warning strings of at most 2,000 UTF-8 bytes and 64 payload-free provider-call
    summaries, sampling the earliest and latest entries deterministically and exposing
    `diagnosticsTruncated: true` whenever entries, provider-authored diagnostic text, error details,
    or error-message bytes were omitted. Raw provider warning/error text and provider error details
    never enter the durable journal.
32. A portable episode carries every field in its `contentHash` preimage, including explicit input
    assertions. Import recomputes that identity before collision planning or mutation, and collision
    remapping recomputes it after changing the episode id and idempotency key.
33. Format 4 is a closed, canonical schema rather than an extensible property bag. Import rejects
    missing required properties, unknown properties, malformed discriminated unions, non-canonical
    identity arrays, cross-space records, and ill-typed optional fields at every envelope, ontology,
    record, assertion, lineage, anchor, and merge level. Payload resource, shape, manifest, digest,
    ontology, and episode-identity checks complete before the importer reads target database state;
    adding a portable property requires a new archive format.

Operation reuse is deliberately explicit rather than inferred from the presence of
`OperationOptions`. `remember` replays by episode idempotency identity and accepts a supplied
operation id on replay only when it names that episode's original ingestion. Derivation creation or
withdrawal, correction, and grouped deletion bind a settled result to an exact request. Checkpoint
creation and `syncFrom` bind resumable session state. Hard purge resumes a running marker forward but
rejects reuse after settlement. Retry/reprocess, single retraction/deletion, merge/split, non-dry-run
import, and projection rebuild are fresh-id-only. Dry-run import rejects an operation id.
`resolveSync` and `abortSync` use `sessionId` alone; `resetSpace` accepts no caller operation id
because successful reset removes the journal that could enforce create-once identity.
Fresh means no durable binding exists at admission: a same-revision loser that commits no operation
row remains unbound and may submit that id again, while any persisted binding makes later use a
conflict rather than replay.

Hard-purge idempotency reuse needs a durable, content-free denial marker so the original key cannot
recreate purged material. The alpha stores domain-separated SHA-256 key hashes on purge markers,
binds a collision-safe marker to the normalized request hash, rechecks both inside revision retries,
and blocks replay through ingestion and import. Same-id reuse while active returns
`purge_in_progress`; reuse after settlement or with different input returns `idempotency_conflict`.
Focused tests cover completed and interrupted recovery, request binding, marker-id alias resistance,
in-memory reopen, reset release, and direct/worker browser replay denial. Production qualification
still requires adversarial cross-context schedules and a policy for legacy completed markers whose
hashes cannot be reconstructed.

## 4. Temporal semantics

The system distinguishes:

- **valid time**: when a claim applies in the represented world;
- **record time**: when memory learned, changed, or withdrew the claim;
- **episode occurrence time**: when the source says an event happened;
- **episode receipt time**: when memory accepted the evidence.

All external instants MUST be strings of the exact form `YYYY-MM-DDTHH:mm:ss.sssZ`. Offset forms,
missing milliseconds, and invalid calendar values are rejected. A validity interval is half-open:
`from` is inclusive and `to` is exclusive. Either bound may be absent; absent information remains
unknown rather than being replaced with an invented timestamp.

The alpha exposes four views:

| View          | Current behavior                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `current`     | Supported `active` or `disputed` facts whose validity contains the package clock. Current merge redirects apply.                  |
| `valid-at(T)` | Supported, non-retracted, non-deleted facts whose validity contains `T`, including superseded historical intervals.               |
| `known-at(T)` | Reconstructs facts, evidence withdrawal, and soft episode deletion recorded by `T`, then retains facts valid at `T`.              |
| `history`     | Returns visible retained history including superseded, disputed, retracted, and soft-deleted records. Hard-purged data is absent. |

This is not yet a general two-axis query with independent valid-time and record-time instants.
Historical reconstruction of entity merge/profile state is also incomplete. Those are explicit
post-alpha semantics, not properties inferred from the current fact-history implementation.

Spectron calls its third axis **system time** and bases it on MVCC storage history. Temporal Memory's
space revision and lifecycle records provide application ordering and logical `known-at`
reconstruction; they do **not** provide arbitrary database rewind. The IndexedDB WASM adapter is not
a documented versioned SurrealDB storage engine, so this product MUST NOT describe revision checks
or `known-at` as `SELECT ... VERSION` system-time travel.

For ontology facts with cardinality `one`, the alpha reconciles within an exact scope partition:

- equal semantic identity adds evidence rather than another fact;
- an unambiguous later valid start closes and supersedes the earlier interval;
- a late-arriving earlier interval is ordered by valid time rather than receipt order;
- overlapping claims with missing or equal starts remain disputed;
- explicit correction and retraction use auditable lifecycle records.

The default policy is conservative. Semantic similarity alone MUST NOT invalidate a claim.

## 5. Ingestion and knowledge synthesis

The package accepts text, conversational messages, structured JSON-like values, normalized events,
and explicit assertions. The host normalizes files, pages, email, calendars, and connectors before
submission.

The semantic ingestion sequence is:

1. validate and durably accept the episode;
2. obtain explicit or provider-produced candidates;
3. resolve entities conservatively;
4. validate and reconcile facts and time;
5. commit canonical graph changes;
6. build replaceable projections;
7. settle the durable operation and return a report.

Accepted evidence survives denied, unavailable, malformed, or failed provider work. A retry uses
the accepted episode and MUST remain idempotent. Projection failure may make the operation partial,
but MUST NOT roll back coherent canonical data.

A full-space projection rebuild stages each requested kind under a fresh hidden set. Recall keeps
using the prior set until a single canonical-source-guarded commit activates every successful kind;
failed kinds remain on their prior sets, and inactive rows are reclaimable without affecting search.
A target-selected rebuild performs only an atomic replacement inside the current set and cannot
activate a new embedding generation. `inspect`, `stats`, and rebuild reports expose active set,
generation, canonical source revision, activation time, and operation lineage so operators can
verify the cutover without private-table access.

Only one projection rebuild may be pending or running in a space, including target-selected and
full requests from different facades. Admission checks fresh identity and active ownership against
one pinned physical revision, then atomically binds the running operation. A live contender fails
before target/provider work and names the owner; same-snapshot contenders have one durable winner
and one residue-free retryable loser. This deliberately serializes non-canonical maintenance so one
rebuild's inactive-set cleanup cannot delete another rebuild's staged rows. If the owner disappears
after durable staging, reopen marks its operation interrupted while the old set remains searchable;
the next full rebuild activates independently and reclaims the abandoned rows in bounded pages.

Full rebuild input is streamed one canonical target at a time from 16-row episode/entity/fact
keysets. Targeted rebuilds accept at most 10,000 unique ids and point-read only that selection.
Alias/evidence/provenance dependencies and targeted replacement rows use sparse point or 16-row
indexed reads. Returned inputs and generated projection outputs are admitted under caller-lowerable
100,000-row/64-MiB defaults and 1-million-row/256-MiB hard ceilings; the maintenance report exposes
exact physical/planned `scan` work separately from its logical `scanned` target count. Full rebuilds
therefore retain at most one target's planning state plus one provider batch, not the whole canonical
space. A `projection_scan` failure cannot switch a full set or mutate a targeted selection. Earlier
full-set targets may already be durable but remain hidden, and the settled partial operation makes
that recoverable state explicit until a later full rebuild reclaims it.

Explicit assertions bypass extraction, not validation, scope, ontology, time, reconciliation, or
provenance. Model output is untrusted candidate data and passes the same validation boundary.

Text/message evidence uses non-empty JavaScript UTF-16 code-unit ranges that cannot split surrogate
pairs. Structured/event evidence uses RFC 6901 JSON Pointers into `content.value`. An unanchored
text excerpt is accepted only when it occurs exactly once; structured excerpts require a pointer.
When no narrower evidence is supplied, the package records an honest broad anchor over the whole
episode rather than fabricating precision. Long rendered excerpts may be bounded, but the full
anchor remains durable. Distinct occurrences in one episode remain distinct evidence links.

Mentions obey the same literal-source rule. A canonical name may be used as an implicit mention only
when it occurs exactly once. Aliases supplied for resolution are preserved as scoped identity
provenance but are never converted into occurrences that were not present in the source.

The public batch operation accepts 1–1000 episodes and is processed sequentially. Batch options
carry cancellation only; atomic and parallel batch modes are not part of the alpha contract.

### 5.1 Provider disclosure

Inference, embedding, and reranking are injected semantic capabilities. Each provider declares its
identity, model, destination class, and relevant version/dimension lineage. Before a provider call,
policy receives the proposed capability, destination, fields, payload, scopes, and a sorted unique
set of every sensitivity label carried by the payload's retained source dependencies, and may allow,
redact, replace, or deny it. Labels are opaque; the package unions them rather than inventing a
severity order. Dependency closure includes the input episode, rendered entity-alias sources,
direct fact evidence, and transitive active derivation premises. Incomplete provenance fails closed.

Every projection stores that dependency-derived sensitivity set. Embedding projections are
constructed per exact `(scopes, sensitivities)` pair. Remote indexing work is partitioned by that
pair before policy authorization and is further bounded by `ingestion.projectionBatchSize` (default
`64`, allowed `1`–`1000`). A batch never combines two different disclosure partitions.

Disclosure payloads are bounded twice: the original before policy and a policy replacement before
the provider. Exact stable-JSON UTF-8 bytes default to 1 MiB (16 MiB hard maximum); provider-input
tokens default to 262,144 (4,000,000 hard maximum). The built-in token measure uses payload bytes as
a conservative upper bound, while a synchronous provider-aware counter can include the model's
actual tokenizer and prompt/template overhead. Invalid counters fail closed and no payload content
is retained in diagnostics.

Provider credentials are runtime-only host concerns. Full prompts and raw provider responses are
not retained by default.

## 6. Entity resolution and ontology

Entity resolution favors precision over aggressive merging. It may use explicit ids, identifier
fingerprints, normalized aliases, type compatibility, scoped existing context, and injected model
candidates. It supports create, match, unresolved, reject, explicit merge, and undo-recorded-merge
outcomes. A general semantic split of one identity into newly allocated identities is not an alpha
capability.

The ontology supports:

- **open** mode for general types;
- **prescribed** mode for allowed types and constraints;
- **hybrid** mode with prescribed definitions and explicit fallback types;
- entity and fact type identity, descriptions, subject/object constraints, scalar kinds,
  cardinality, temporal shape, and reject/warn severity;
- version identity stored with spaces and derivation lineage.

Models cannot silently mutate ontology. Opening a space with an incompatible ontology fails rather
than reinterpreting stored memory. The fixed additive schema-5/6-to-7 migration path is explicitly
opted into and audited; ontology changes and canonical row-transforming migrations remain
production gates.

## 7. Retrieval, snapshot, and analysis

### 7.1 Recall and search

Recall accepts a natural-language query and/or entity/fact anchors plus access scopes, temporal
view, nested episode/entity/fact filters, conflict policy, channel switches, graph depth, result
limit, and output budgets. Episode filters cover stable source identities, kinds, tag all/any/none,
top-level metadata equality, retention/sensitivity values, and received/observed time. Fact filters
cover ids, types, predicates, subjects, exact entity/scalar objects, status, and recorded time.

The implemented channels are:

| Channel  | Alpha behavior                                                             |
| -------- | -------------------------------------------------------------------------- |
| Exact    | Anchors, normalized names/aliases/identifiers, and predicates.             |
| Lexical  | Scope-filtered SurrealDB BM25 over lexical projections.                    |
| Semantic | Scope- and generation-filtered cosine similarity over injected embeddings. |
| Graph    | Bounded TypeScript traversal over visible entity-valued facts.             |
| Temporal | Deterministic recency ordering within the selected temporal view.          |

Channels are fused by weighted reciprocal-rank fusion with deterministic tie-breaking. Optional
reranking passes through the provider policy boundary. Source trust, quality thresholds, learned
diversity, and calibrated confidence are not alpha ranking guarantees.

Recall returns a detached structured context bundle containing selected entities, facts, episode
excerpts with one or more exact evidence fragments, paths, conflict groups, stable per-result
citations whose sources carry those anchors, channel contributions, applied filters,
degraded-capability notices, a bounded text rendering, and explicit `snapshotRevision` /
`generatedAt` lineage. Recall brackets canonical reads, ranking, optional provider-backed query
embedding or reranking, and rendering with the space incarnation and revision. A concurrent
physical or semantic write fails the call with retryable `conflict` rather than returning mixed
context. Search carries the same context; neighborhood projects the same lineage. The check is an
optimistic consistency boundary, not a database-native read transaction, and a failed call may
already have performed governed remote computation. Summary projections can be rebuilt, but summary
selection is not yet assembled into recall output.

For persistent browser storage, each same-origin tab and each direct or module-worker engine is an
independent client. Local promise serialization protects one connection only; shared-memory safety
uses two layers: an origin-wide exclusive Web Lock serializes each physical SurrealDB SDK call for
the endpoint/namespace/database, and SurrealDB transactions atomically guard the space incarnation
plus applicable logical/canonical/private-metadata revisions with affected rows and journals.
Persistent open fails closed when Web Locks are unavailable instead of silently accepting unsafe
multi-tab writes. Concurrent writers from one baseline therefore have one winner and a retryable
loser, with explicit re-read/retry and no partial mutation. A reset/recreate fences already-open
facades and old cursors by incarnation, while journal compaction invalidates cursors below the
persisted floor across contexts. Reset itself is ordered against canonical writes: writer-first
returns a retryable reset conflict with the write preserved; reset-first makes a delayed writer fail
`space_not_found` without recreating any space row or payload. Browser lock arbitration is not a hidden leader, automatic conflict
retry, notification bus, or claim of snapshot-isolated multi-query reads.

Generated transaction failures are classified by evidence, not guessed. A returned failed statement
is a known rollback and exposes `transactionOutcome: 'rolled_back'`; no row or space revision from
the transaction survives, and the connection can continue. Loss of the physical call before any
statement response is an unknown outcome, is non-retryable, requires reopen plus durable-state
reconciliation, and is not permission to replay a fresh-only mutation. Raw SurrealQL uses the same
rule with `queryOutcome: 'unknown'`. This conservative contract does not itself prove database-worker
kill safety during `COMMIT`. Once observed, the facade rejects new work before storage access and
rechecks in-flight public reads before returning a value or emitting completion; an inspection call
made after the fence therefore cannot perform even a diagnostic storage read. The read fence is
incarnation-stable: close/reopen cannot turn a result started before the unknown outcome into a
successful result from the new facade incarnation. Public `MemoryError` diagnostics are construction-
time snapshots: nested JSON details and the error instance are frozen. The first observer of a
retained safety error therefore cannot weaken the retryability or reconciliation markers later seen
by another facade; an opaque `cause` is neither copied nor serialized.

Complete reads re-read the persisted incarnation/revision after their component queries. A logical
write from another tab during snapshot or recall therefore makes the reader fail with retryable
conflict instead of returning a mixed graph. Statistics and inspection additionally fence the
private metadata revision, including checkpoint/session-only work that leaves the public logical
revision unchanged. Detection is fail-closed but optimistic: already completed database/provider
work is not rolled back.

The authority and selection side of that boundary is immutable as well. `read`, `recall`, `search`,
`neighborhood`, `browse`, `snapshot`, `analyze`, `changes`, `signalChanges`, and `export` copy their
complete closed JSON request once before purge coordination, hashing, storage, or provider work.
The shared envelope ceiling is 1,000,000 nodes, depth 64, and 64 MiB of aggregate strings; each
method's tighter selector, scan, graph, result, and archive limits still apply. Later caller or
accessor mutation cannot broaden access, replace filters/anchors/seeds/IDs/cursors, or relax a
budget. Unknown fields, cycles, non-plain objects, malformed JSON, and unreadable accessors fail
before asynchronous work. Optional object properties captured as `undefined` become absent, so the
usual first-page `cursor: undefined` pattern remains ergonomic; array/root `undefined` is still
invalid. A separately copied `AbortSignal` remains live by design.

Replica reconciliation has the same ownership rule across checkpoint creation/export, sync
inventory, pull/resume, conflict inspection/resolution, abort, and checkpoint/session compaction.
Every JSON request and standalone access grant is closed and detached before local queueing,
storage, or peer work; options are copied at invocation. A queued caller cannot later replace its
space confirmation, access partition, head/session/checkpoint identity, merge strategy, resolution,
cursor, cutoff, or work limit. The peer and abort signal are intentionally live capabilities, not
JSON. This makes request identity, authorization, hashing, and execution observe one value without
pretending the transport itself is immutable.

Canonical mutations are invocation-time values too. Ingestion and retry, derivation activation and
withdrawal, correction/retraction, merge/split, episode deletion, hard purge/reset, import, and
projection rebuild detach their complete request plus every JSON option before entering the write
queue. Operation ids, access grants, expected revisions, semantic inputs, destructive selectors and
confirmations, collision mode, and resource ceilings cannot be swapped while earlier work is
running. Only the captured abort signal remains live. Unknown request/options fields fail before
local or provider work; archive shape/resource failures retain import's dedicated error taxonomy.

Import pays for one additional bounded document copy because format-v4 is intentionally the small,
materialized archive path. That cost is explicit rather than allowing a caller to mutate a document
between digest validation and commit. The hard archive ceiling does not increase; larger data stays
on the chunked, resumable sync-bundle protocol.

The same invariant starts at construction and is exhaustive rather than method-family-specific.
`createMemory` accepts one closed options object: it captures `spaceId`, ontology, disclosure
limits, ingestion/retrieval profiles, and timeout exactly once and owns detached JSON copies before
the facade exists. Unknown fields, unreadable accessors, malformed JSON, and later caller mutation
fail or have no effect. Injected storage, provider, policy, clock, id factory, token counter, and
error callback remain the exact live behavior-bearing capabilities captured at that boundary; their
containing properties are never reread.

Open flags/metadata,
management and integrity limits, point-read convenience access/options, retrieval/feed/signal/archive
options, and the complete journal-consumer lifecycle/compaction plane are invocation-time values.
Replacing an options object's signal after the call cannot change cancellation authority, although
the captured `AbortSignal` remains live. Only captured
storage/provider/policy/clock/id/token-counter/peer/listener capabilities are intentionally retained
as behavior-bearing references. This gives a downstream worker one coherent rule for every public
JSON argument instead of a list of shallow-copy exceptions.

The ownership boundary is bidirectional. Every JSON result from `Memory` is a detached caller-owned
value rather than an alias of input, cached space state, a storage record, provider output, or
durable replay state. Mutating it cannot change a later observer. Each event listener likewise
receives its own detached payload, preventing one extension or algorithm observer from corrupting
another observer's view. The copies are intentionally mutable and are not a recursive-freezing
promise; behavior-bearing providers, storage, peers, callbacks, and unsubscribe functions remain
live capabilities.

Recall, search context, and neighborhood also expose one `PhysicalScanWork`. Caller-lowerable
`scanLimits` default to 100,000 physical rows and 64 MiB of exact stable-JSON row bytes, with hard
maxima of 1 million rows and 256 MiB. Canonical kinds advance through 16-row id keysets; every row
counts before visibility or semantic filtering. Lexical/vector results count too, and the native
query is capped by the remaining row budget plus one. A breach fails with `result_too_large` and
exact `recall_scan`, dimension, required, and maximum details rather than returning partial context.
Access and equivalent episode/evidence filters are pushed down and rechecked. Graph expansion builds
adjacency and evidence indexes once, making traversal linear in the admitted visible graph instead
of repeatedly scanning all facts and links. These are facade transfer/materialization bounds, not
heap, disk-work, or latency guarantees; one 16-row page and one bounded search result can be in
flight before rejection.

### 7.2 Browse

`browse` returns typed pages of episodes, entities, or facts. It applies the same space, scope,
temporal, filter, and conflict boundaries as recall. Orders are `newest`, `oldest`, or `id`; limits
are 1–200.

Filter dimensions are conjunctive; values inside one categorical array are alternatives. Episode
filters constrain eligible evidence before facts and entities are assembled. An entity filter
induces an entity-bounded graph, so facts with a filtered endpoint are not returned. Exact scalar
object filtering occurs before pagination, rather than requiring a consumer to scan pages and
discard non-matches.

Cursors bind to the private space incarnation, normalized access, canonical kind/order/view/filter/
conflict semantics, exact physical revision, first-page current-view evaluation instant, and last
record. Page size may change. A cursor therefore fails closed after access/request drift,
destructive reset/recreate, or mutation instead of silently changing the result set. Clock passage
alone cannot expire a member halfway through pagination. Each page exposes `snapshotRevision` and
`generatedAt`.

Current, valid-at, and history episode pages without metadata residuals are storage-native: exact
access containment, stable source dimensions, retention/sensitivity, tags, and time filters execute
before a lexicographic `limit + 1` keyset page is returned. `id`, `oldest`, and `newest` are covered.
Opaque string keys use deterministic Unicode scalar-value order across the facade, in-memory
reference, and SurrealDB's default ordering; locale-sensitive collation is never implicit.
Known-at/residual episode and entity/fact pages still assemble the complete eligible
evidence-induced graph in JavaScript before slicing, but each continuation now reads it through
16-row canonical keysets under the same 100,000-row/64-MiB defaults and 1-million-row/256-MiB hard
ceilings. Native episode pages admit the cursor boundary and no more than the lesser of `limit + 1`
or the remaining record budget plus one. Every page returns exact `scan` work; a breach reports
`browse_scan` and returns no partial page. `scanLimits` are an execution guard and may change between
cursor pages without changing selection semantics. The reference IndexedDB engine requires a
Surreal table iterator for descending generic queries after its indexed route failed with an
invalid key range; this bounds transfer and facade memory, not database scan latency.

An already-open facade is likewise bound to its original incarnation. If another context resets and
recreates the same `spaceId`, the stale handle reports `conflict` with `requiresReopen` and cannot
adopt the replacement until the host explicitly closes and opens it again.

Checked point reads use `read({ kind, id, access, scanLimits })` for episodes, entities, facts, and
derivations. The result carries the value, snapshot revision, evaluation time, and exact physical
row/byte work. Entity and fact provenance advances through 16-row alias, evidence, derivation, and
lifecycle keysets and point-loads distinct support episodes; it never uses an unlimited relation
query or whole-space export. The default ceiling is 100,000 rows/64 MiB and the hard maximum is
1,000,000 rows/256 MiB. A breach fails with `point_read_scan` and returns no partial value.
`getEpisode`, `getEntity`, `getFact`, and `getDerivation` are value-only convenience projections of
the same checked implementation and accept optional scan limits. Every point read is bracketed by
the space incarnation and revision and returns a retryable `conflict`, rather than a mixed result,
when they change in flight. Consumers needing a reusable complete reasoning baseline use
`snapshot`.

### 7.3 Snapshot

`snapshot` returns the complete selected visible temporal graph as detached episodes, entity views,
fact views, raw visible evidence relations (including contradictions), derivations, mentions, target-scoped
lifecycle records, ontology, counts, and the canonical revision. It brackets materialization with a
space-incarnation and revision check and fails with retryable `conflict` on revision mutation or
space removal; a replacement incarnation requires an explicit reopen.
`maxRecords` defaults to `50,000`, accepts `1..1,000,000`, counts those top-level returned records,
and fails with
`result_too_large` rather than silently truncating. `scanLimits` separately defaults to 100,000
physical rows and 64 MiB of their exact stable-JSON encoding, with hard caps of 1 million rows and
256 MiB. Canonical kinds advance through 16-row `id` keysets; every returned row counts before
visibility, temporal, or induced-graph filtering. Safe filters are pushed down and rechecked.
`snapshot.scan` returns actual row/byte work and effective limits. A breach fails with
machine-readable `phase: 'snapshot_scan'`, `dimension`, `required`, and `maximum` details. This
bounds transfer and retained facade materialization, not heap bytes or database latency; one storage
page is necessarily in flight before admission.

This is the extension boundary for downstream graph algorithms and reasoners. It preserves the
package's scope, temporal, evidence, and merge semantics while keeping storage handles and
SurrealQL private. The generation/revision check detects concurrent mutation but is not a
database-native multi-query read transaction. The returned `changesCursor` is bound to that checked revision, space
incarnation, and exact access scopes, allowing a consumer to persist one baseline and then follow
only later semantic changes. Snapshot filters/view are not hidden cursor state; downstream owns
their incremental selection logic.

### 7.4 Analyze

`analyze` produces a read-only, scope- and temporal-view-bounded snapshot report containing:

- visible episode, entity, fact, evidence, active derivation, and conflict counts;
- source-kind and predicate distributions;
- unsupported, derived-only, single-source, and multi-source corroboration counts;
- isolated entities and unresolved conflict findings;
- cardinality-one temporal-overlap findings;
- current visible signal counts by active, expired, and withdrawn state plus namespace, kept outside
  the graph calculation; and
- connected components, relation-edge count, unique directed arc count, bounded density,
  in/out/total degree, and structural PageRank over visible entity-valued fact edges.

Without seeds the algorithm lineage remains exactly `structural-pagerank-v1`. Optional unique,
positive-weight visible entity seeds select `personalized-pagerank-v1`; weights are normalized and
the teleport plus dangling distribution stays inside those seeds. A downstream may derive seeds
from the current thread, a retrieval result, or another governed selection without giving those
nodes factual authority. Both modes report personalization, seed count, damping, iterations,
convergence, and tolerance and remain deterministic structural analysis—not truth confidence,
source authority, semantic importance, or permission to mutate records.

The caller's `top` value defaults to 20 and independently bounds both ranked entities and the
finding sample to 1..100 entries. Findings put warnings before informational diagnostics and then use
deterministic Unicode-scalar code, item, evidence, and message ordering. `findingSummary` returns
complete per-code counts, total count, returned count, and an explicit truncation flag. Conflict or
overlap populations therefore remain measurable without making the report itself unbounded.

Parallel entity-valued fact records remain distinct PageRank links and are reported as `edges`.
`arcs` is the unique directed source/target pair count; density is `arcs / nodes²`, explicitly
including the possibility of self-arcs, and therefore stays in `[0,1]` even with parallel facts.

Storage work is admitted independently under caller-lowerable defaults of 100,000 physical rows and
64 MiB of their canonical JSON, with hard caps of 1 million rows and 256 MiB. Analysis reads each
canonical table through advancing 16-row `id` keysets and reads signals through the existing
16-row key/version/id keyset. Every row returned by storage counts before visibility,
temporal, latest-revision, or induced-graph filtering; bytes are the exact UTF-8 length of that
row's stable JSON encoding. Scope and other provably equivalent filters are pushed into storage,
but the facade still rechecks them. A scan ceiling fails immediately with `result_too_large` and
machine-readable `phase: 'analysis_scan'`, `dimension`, `required`, and `maximum` details. This
bounds transfer and retained facade materialization, while making no heap-byte or database-latency
claim; one in-flight storage page is necessarily materialized before its rows can be admitted.

Algorithm work is then admitted under defaults of 1 million visible analyzed records, 100,000 graph
nodes, 500,000 entity-valued edges, 50 million worst-case PageRank steps, and 1 million
cardinality-one temporal pair comparisons, with hard caps of 5 million, 250,000, 1 million,
250 million, and 10 million. The report returns actual physical scan and algorithm work plus all
effective limits. Exceeding any ceiling fails with `result_too_large` instead of returning partial
metrics. One final incarnation/revision check covers all scan pages and computation, so a concurrent
write produces retryable `conflict` rather than a mixed report.

### 7.5 Scoped non-epistemic signals

The implemented signal plane is the generic bridge between coherent downstream computation and
governed host action. It is intentionally narrower than a rule engine and more durable than a
process-local callback. A signal can carry cluster membership, salience, reinforcement/weakening,
peripheral state, retention advice, or another finite JSON value against an episode, entity, or
fact.

Each logical signal is partitioned by space, namespace, slot, producer identity, target, and exact
scopes. Its immutable revisions record producer/algorithm version, normalized grouping tags,
declared episode/entity/fact basis IDs, the exact input revision and temporal view, record time,
value, and optional expiry. Tags such as `cluster:ongoing-work` are selector-visible and may change
between revisions without changing logical identity. Algorithm producers require a non-empty basis;
manual observations may omit it.

Every `browseSignals`, `putSignals`, and `deleteSignals` request is a closed JSON envelope copied
and validated once at the public boundary before asynchronous reads or queued writes. The envelope
has a 1,000,000-node, depth-64, and 64 MiB aggregate-string ceiling, while the operation-specific
limits below remain tighter. Later caller mutation or a changing accessor cannot retarget access,
filters, identity, basis, values, revision, or destructive mode. Cycles, non-plain objects,
unsupported or unknown fields, malformed JSON, and unreadable accessors fail as `invalid_input`
before storage work. The separately supplied `AbortSignal` remains a live capability by reference.

`putSignals` uses exact revision CAS and never silently rebases an algorithm result onto a newer
graph. It verifies target/basis visibility and dependency scopes in the declared temporal view.
Every entity target or entity basis ID requires a declared basis episode or fact actually connected
to it, preventing entity-only scope laundering. One batch commits at one new physical revision. The
write produces no canonical semantic change and has no implicit effect on facts, evidence,
lifecycle, recall, search, PageRank, or ranking fusion.

Basis validation is semantically complete across current, valid-at, known-at, and history views but
storage-sparse. It loads exact targets and bases plus only their temporal lifecycle, visible
evidence/rule support, active merge components, incident facts, aliases, and mentions. Unrelated
records are not enumerated. Scalar predicates use 1,000-value chunks and every query advances in at
most 16-row keysets under `basisScanLimits` (100,000 rows/64 MiB defaults; 1,000,000 rows/256 MiB
hard maxima). `PutSignalsReport.basisScan` exposes every returned row and its stable-JSON bytes,
including a row returned by two distinct provenance predicates. Work scales with the addressed
merge/support/incident-fact closure, so a high-degree record can still hit the explicit ceiling. A
`signal_basis_scan` breach or revision drift leaves signals and both journals unchanged.

`browseSignals` supplies revision-bound current/history pages, exact filters over logical identity,
producer, target, state, tags, basis, record time, and expiry, and an exact match total. Current
selection chooses the latest revision globally before access/filter evaluation, preventing an older
revision from resurfacing for a less-privileged caller. Expired active signals are hidden by default
but remain inspectable. Its page cursor binds the space incarnation, normalized access, complete
request, evaluation time, and exact space revision. A non-empty constrained current
active/non-expired browse also returns `targetSelectionCursor`, which hashes the complete matching
signal-revision set rather than only the returned page; empty selections expose no destructive
token. Storage advances in 16-record keyset pages with access and immutable identity filters pushed
down. The facade retains only `limit` lightweight candidates, fetches output values individually,
and enforces an exact canonical response-byte ceiling (16 MiB default, 64 MiB maximum). Exact totals
remain O(n), and mixed-direction IndexedDB scans are not a latency SLO.

`deleteSignals` applies a non-empty selector only at a caller-previewed revision and below an
explicit `maxMatches` ceiling. Withdrawal appends tombstone revisions; purge atomically removes the
complete retained history of each selected logical key after a native count satisfies the explicit
`maxRevisions` guard. The storage transaction deletes by logical-key range rather than carrying one
delete command per revision. Canonical hard purge independently removes
complete signal histories when any declared target or basis depends on a purged ID, including when
only an older signal revision declared that dependency.

`hardPurge.signalTargets` can consume that cursor with the same filter and an explicit `maxMatches`.
It revalidates space generation, access, filter, preview revision, current expiry eligibility, and
the full selection hash before creating the purge marker, then erases only each selected signal's
declared canonical target. It never interprets the signal value or automatically applies advice.
The package cannot discover a dependency deliberately hidden inside arbitrary JSON, namespace,
slot, tag, or producer text. Those fields MUST use opaque, non-sensitive application identifiers;
every memory dependency relevant to scope, invalidation, or forgetting belongs in `target` or
`basis`.

`deleteEpisodes.signalTargets` consumes the same kind of cursor but accepts only episode targets.
It applies ordinary soft-deletion semantics to the deduplicated target episodes and appends a
withdrawn revision for every selected signal in one revision-CAS commit. That commit writes one
canonical governance change and one signal withdrawal change at the same physical revision, while
keeping their payloads and semantics separate. It does not inspect signal values and cannot be used
for entity or fact targets. Signals are excluded from canonical format-v4 export/import. Explicit
signal portability, automatic expiry maintenance, a retrieval-policy plug-in, registered consumer
acknowledgements, automatic action policy, and other
non-erasure canonical workflows remain open boundaries.

Independent clients do not turn these previews into a hidden action queue. Signal-target soft
deletions planned from one physical revision have one commit winner; a loser leaves no canonical,
operation, lifecycle, projection, semantic-journal, signal-revision, or signal-journal residue and
must explicitly reacquire a complete signal baseline. A disjoint selection can then be replanned and
retried with its still-unbound operation ID. A consumed selection instead disappears from the active
view and is not silently replayed. If soft deletion races hard purge from the same cursor, either the
atomic delete/withdraw commit wins before any purge marker or the marker wins and deletion writes
nothing while purge resumes forward. The package never changes the requested action to make a race
"succeed."

Every successful signal put, withdrawal, or purge atomically writes a separate durable signal-change
row at the same physical revision. Exact-scope partitions name the affected logical keys and
targets; they carry no signal value, evidence, score, or canonical truth. `signalChanges` scans this
plane with an access- and generation-bound opaque cursor. `browseSignals` returns a
`signalChangesCursor` at its checked revision so an application can take a complete current/history
baseline and then consume only later transitions without a race.

Hard purge removes affected target/key identifiers from prior signal-change rows. If any item in a
scope partition is erased, that historical partition becomes a content-free invalidation and the
purge commit emits another invalidation for the affected scopes. This may intentionally discard
delta precision for unrelated keys sharing that partition; rebuilding the visible signal partition
is the safe response. `compactSignalChanges` provides the same explicit confirmation, revision CAS,
bounded batch, dry-run, monotonic floor, and stale-cursor failure model as semantic compaction.
For externally managed consumers, the host supplies every active cursor and the facade validates
the signal-feed discriminator and derives the minimum safe watermark. Long-lived local consumers
can instead use the package-owned register/acknowledge/retire lifecycle; registered compaction
enumerates every active checkpoint and epoch-guards the destructive commit.

### 7.6 Maintained rule support

Downstream reasoning is now native at the substrate boundary without making the package a rule
engine. `deriveFact` registers one canonical conclusion against an exact checked revision, explicit
rule id/version, and a non-empty set of current fact/evidence premises. `deriveFacts` registers a
bounded 1..64-member multi-conclusion activation under one shared revision, authority, work budget,
operation, commit, and semantic change. Conclusions reuse only existing visible identities and pass
the same ontology, cardinality, temporal, JSON, and conflict rules as asserted facts.

Derivations are immutable revision chains distinct from both source evidence and non-epistemic
signals. Their required scopes are the union of all premise scopes, so a private premise cannot
produce a public conclusion. The package rejects positive dependency cycles, exposes current or
historical support through facts, snapshots, point reads, analysis, integrity, and portable
archives, and lets a host append an explicit withdrawal revision. `withdrawDerivations` is the
bounded atomic retirement form for a rule version or another precisely selected support set. It
intersects current derivation IDs, rule IDs, rule versions, conclusion fact IDs, and recorded-time
bounds under caller scope, exact revision, aggregate work limits, and an explicit 1..1,000
`maxMatches` guard. Named IDs are strict: a hidden, historical, missing, or otherwise non-matching
member rejects the whole request instead of retiring a subset.

`previewDerivationWithdrawals` makes that destructive boundary inspectable without exporting the
rule plane. It runs the same 16-row current-revision selector under the same scope, breadth, and work
limits, and returns the complete deterministic support set with snapshot lineage. Non-empty results
carry an opaque cursor committing to space incarnation, access, selector, revision, and the exact
ordered support-ID digest. Apply can bind to that cursor and rejects drift before truth maintenance;
empty selections deliberately expose no mutation token. The cursor is consistency evidence rather
than authority, and a host with another checked authorization path may still use one-shot
exact-revision apply.

Every canonical path that can make a premise unavailable runs one atomic truth-maintenance closure:
ingestion reconciliation, correction, evidence retraction, soft deletion, derivation withdrawal,
and hard purge. Invalid supports receive new immutable revisions. A conclusion stays current while
it has any active direct evidence or derivation; otherwise it retracts or deletes, and downstream
supports are reconsidered until the graph is stable. Projections and the semantic journal change in
the same commit. Hard purge also physically removes complete derivation histories that directly
name purged evidence or facts.

Canonical ingestion now enters that closure through the same sparse planner as direct governance.
Identity visibility, semantic/cardinality reconciliation, affected premise/conclusion support, and
projection cleanup use point reads plus 16-row indexed keysets. `IngestionProfile.workLimits`
provides defaults, per-call `IngestionOptions.workLimits` overrides them, and sequential
`rememberMany` applies its batch limits per episode. `IngestionReport.work` reports exact admitted
stored rows, stable JSON bytes, dependency nodes, and edges. A breach retains the already accepted
episode but commits none of that attempt's canonical plan; the host can inspect the failed report
and call `retryEpisode` with a different ceiling.

Model-backed ingestion also exposes profile/per-call/per-batch `contextScanLimits` and exact
`IngestionReport.contextScan`. Context assembly uses the same 16-row facade-visible canonical scan
as bounded retrieval, with 100,000/64 MiB defaults and 1,000,000/256 MiB hard maxima. A breach occurs
before policy/provider disclosure and leaves the accepted episode available for retry. This bounds
facade row transfer and retained context state, not database iterator work, JavaScript heap, or
provider execution.

Automatic post-canonical projections expose independent profile/per-call/per-batch
`projectionScanLimits` and exact `IngestionReport.projectionScan`. Alias, evidence, support-episode,
replacement-row, and generated-row work advances through 16-row keysets under the same defaults and
maxima. A breach cannot roll back already committed canonical truth: it settles the operation
partial at `projection_scan_failed`, commits no partial projection mutation, and leaves the episode
available for retry or a bounded rebuild. The report bounds facade rows and stable bytes, not
provider execution, heap, engine iterator work, or one configured provider batch.

The direct reasoning, correction, and retraction paths are storage-targeted rather than hidden
database exports. `deriveFact`, `deriveFacts`, `withdrawDerivation`,
`previewDerivationWithdrawals`, `withdrawDerivations`,
`correctFact`, and `retractFact`
use point reads plus the existing SurrealDB support, semantic-key, logical-key, conclusion,
premise-array, evidence, alias, and projection indexes. Correction authorizes all direct support
history; retraction authorizes every active target support before selecting one episode or all
support. Cycle detection walks forward only from each proposed conclusion and checks the combined
stored-plus-batch edge plan; support maintenance starts at changed premises/conclusions and expands
only through affected current derivations. Queries advance in 16-row keyset pages, and explicit row,
byte, graph-node, and graph-edge ceilings fail before mutation. Derivation, correction, and
retraction reports expose the exact admitted work and normalized limits. This makes a sparse
reasoning or fact-governance update proportional to its dependency closure even when the space
contains a large unrelated corpus; it does not turn downstream rule evaluation into a package
responsibility.

A downstream ontology or Datalog engine therefore follows `changes`, evaluates a revision-checked
`snapshot`, and CAS-writes its positive conclusions with premise lineage. One bounded multi-head
activation can commit atomically through `deriveFacts`, but every member is checked only against the
pre-batch current premise state: batch outputs cannot feed another member, and duplicate semantic
conclusions, ambiguous cardinality-one partitions, or combined positive cycles fail without residue.
When a rule/version is disabled or replaced, one `withdrawDerivations` commit appends every selected
withdrawal successor, runs aggregate cascading truth maintenance once, invalidates projections, and
emits one semantic change. Independent clients have at most one complete winner; a loser stays
unbound and residue-free, replays the winner exactly when given its bound ID, and must preview a new
selection before reusing its own ID.
The host still owns rule execution, scheduling, negation, stratification, aggregation, existential
identity creation, iteration, and recomputation policy. Arbitrary temporal reasoning bases and
fixpoint evaluation remain open only if real consumers require them. This is deliberately smaller
than embedding a particular rule language in memory.

### 7.7 Incremental change journals

`changes` is the storage-neutral incremental boundary for restart-safe downstream computation. A
semantic canonical mutation atomically writes one revision record with operation lineage, phase,
commit time, and exact-scope partitions of affected episode, entity, and fact IDs. Accepted input,
canonical integration, governance, import, and purge are distinguishable phases. Projection writes,
operation settlement, and other physical maintenance revisions do not impersonate knowledge
changes.

The scan is revision-bracketed and fails retryably on concurrent mutation. This prevents returning a
pre-purge copy of a historical journal row after its identifiers have been scrubbed; it is still a
mutation detector, not a database-native snapshot transaction or cross-context linearizability proof.

The cursor binds the space incarnation, exact normalized access scopes, and last scanned revision.
It may advance across invisible and non-semantic revisions; a page can therefore be empty while more
journal rows remain. Access changes, destructive reset/recreate, or a cursor ahead of the space fail
with `conflict` and require a fresh snapshot/cursor. This is intentionally a package-level feed, not
a SurrealDB table changefeed.

The normal bootstrap is `snapshot(...).changesCursor`, which closes the snapshot-to-feed handoff
without rescanning the full journal. Omitting a cursor means scan from space creation only while no
history has been compacted.

Hard purge creates a special disclosure problem: enumerating erased targets would defeat forgetting.
The implementation scrubs those IDs from historical journal rows and emits only content-free
invalidations for their exact scope partitions. A consumer that already knew the targets sees the
later invalidation and rebuilds that visible partition from `snapshot`; a new consumer cannot recover
forgotten IDs from affected-target fields. Change records retain operation ids as operational
lineage, so callers MUST use opaque, non-sensitive ids and MUST NOT encode content or target ids in
them. Change records are not source evidence, factual support, salience, or retrieval/decision
traces, and canonical export omits them.

`compactChanges` provides explicit bounded maintenance once every downstream consumer has durably
acknowledged a watermark. It requires exact space confirmation, the caller's current expected
revision, `maxChanges` in `1..1,000`, and exactly one watermark source. The preferred
`registeredConsumers: true` mode enumerates every active durable local consumer and derives its
minimum checkpoint. `registerJournalConsumer`, `acknowledgeJournalConsumer`,
`retireJournalConsumer`, and metadata-revision-bound `journalConsumers` provide the lifecycle.
Acknowledgements are monotonic, cannot change their cursor's exact access partition, and update a
per-journal epoch. Compaction guards that epoch, so a concurrent registration, acknowledgement, or
retirement invalidates the plan instead of deleting newly required history. The stateless
`consumerCursors` mode accepts `1..1,000` durable, feed-discriminated v2 cursors, validates their
space incarnation and floor, and derives the minimum revision. A mutually exclusive
`throughRevision` expert override supports external acknowledgement systems. `dryRun` previews one
batch.
Each applied batch atomically range-deletes indexed `tm_change` rows, advances a monotonic space
floor, and advances the physical revision without fabricating a semantic change. The cursor exactly
at the floor remains valid. Older cursors, and cursorless scans after the floor advances, fail with
`conflict` plus `requiresSnapshot`; a fresh snapshot supplies the replacement cursor. The package
does not guess retirement from elapsed time and has no automatic expiry scheduler or cross-device
cursor registry. Local registry records are operational metadata omitted from archive and replica
sync; reset removes them. Retired identifiers remain non-reusable tombstones, and each journal is
bounded to 1,000 active plus retired records. This favors offline-consumer safety over implicit
lease expiry; the host still makes the explicit retirement decision.

The semantic and signal journals are intentionally separate. `changes` answers “which canonical
memory may have changed?”; `signalChanges` answers “which non-epistemic recommendations or
observations changed?” A signal mutation MUST NOT appear in the semantic journal, and signal-plane
consumers MUST NOT interpret the signal journal as evidence or support. Both feeds use the shared
physical revision only for coherent ordering and cursor handoff.

### 7.8 Downstream capability audit

The package judges extensibility at four levels: representable data, selective reads before
pagination, coherent computation, and governed application of results. “A consumer can export the
whole database and reconstruct it” is not treated as a sufficient native API.

| Capability probe | Current downstream-native boundary | Missing boundary |
| --- | --- | --- |
| Peripheral/session state such as a visible modal or an unfinished thread | Native as display/open and hide/close episodes plus cardinality-one application facts when the state is a truth claim. A host can instead use scoped manual signals with expiry/withdrawal for explicitly non-epistemic peripheral attention. Current selectors expose live state, and `browseSignals` plus `signalChanges` provides a race-free restart handoff. | Absence is not an observation. The host must record the closing transition, validity end, signal withdrawal, or expiry; no scheduler silently invents disappearance. |
| Stale/delete/forget by group and time | Native for source/tag/metadata/retention/time episode selectors. `previewEpisodeDeletions` returns the complete bounded visible set and an exact selection cursor consumed by filter-selected `deleteEpisodes`, so hosts do not reconstruct or page deletion IDs. Signal selectors likewise support exact cursor-bound soft deletion/consumption or hard purge without interpreting signal values. | No automatic retention scheduler or generic signal-action interpreter exists. Non-erasure entity/fact governance remains absent; the host must explicitly choose soft deletion versus hard purge. |
| A downstream `dream()` graph process | Native for restart-safe recommendations and maintained conclusions: follow `changes`, evaluate a checked `snapshot`, or run bounded `analyze` with explicit current-session/project entity seeds; durably register and acknowledge each local semantic/signal consumer; CAS-write scoped/versioned signals for non-epistemic output, `deriveFact` for one premise-backed conclusion, or `deriveFacts` for one bounded atomic multi-head activation; then explicitly apply selected deletion/erasure. Structural and personalized scores retain exact algorithm/work lineage. | No built-in dream policy, automatic query-to-seed selector, retrieval-scoring extension, cross-device checkpoint service, automatic action loop, or generic strengthen/weaken interpreter. Algorithms cannot manufacture source evidence or authority. |
| Ontology inference or a reasoning-rule engine | Native positive-maintenance substrate: fixed ontology validation, checked snapshots, affected-target feed, rule/version plus fact/evidence premises, scope closure, positive-cycle rejection, canonical derivation revisions, bounded atomic multi-conclusion activation, exact bounded retirement preview/consistency cursors, strict selector-based atomic rule/version retirement, and cascading retraction are available. | Rule execution, iterative fixpoints, negation/stratification, aggregation, existential identities, mutable ontology proposal/migration, and temporal premise bases remain downstream or open. |

The remaining boundaries are generic substrate gaps, not reasons to add modal-, Copilot-, dream-,
or rule-language-specific methods. Epistemic support changes only through evidence or explicit
canonical derivations. Implemented salience signals remain separate from fact truth and provenance.

### 7.9 Spectron reference alignment

Spectron is the closest published architectural reference reviewed for this product. Its eight
pillars, experiential categories, five coherence dimensions, trace feedback, tiered retrieval, and
tri-temporal model are useful pressure tests. Alignment means adopting sound primitives where their
semantics fit a headless embedded component; it does not mean copying Spectron's service API,
category taxonomy, or answer-generation responsibilities.

The 2026-08-03 pressure test covered Spectron's complete architecture and mental-model sections,
the ingest/retrieve/reason/operations/session/tuning corpus, and the public REST, configuration,
schema, and embedded-runtime references. Conceptual promises and currently documented wire/schema
surfaces are classified separately below.

The current capability map is:

| Spectron primitive | Temporal Memory position | Decision |
| --- | --- | --- |
| Authoritative and experiential sources | Episodes retain source identity, exact content, exact evidence anchors, scopes, and time. Explicit assertions and provider candidates use one reconciler. | Keep and strengthen with a future typed authority/trust policy; do not infer authority only from source kind. |
| Reconciliation | Evidence-many-to-many facts, conservative identity resolution, disputes, correction, retraction, merge/split, and valid-time reconciliation are implemented. | Keep Temporal Memory's stronger auditable lifecycle and revision-governed writes. |
| Elaboration, reflection, and consolidation | `changes`, `snapshot`, and bounded structural/personalized `analyze` support restart-safe incremental computation; scoped signals persist revision/basis-bound recommendations; canonical derivations persist rule/version and exact premises with positive-cycle rejection, bounded atomic multi-head activation, and cascading truth maintenance; exact episode recommendations can be applied or erased explicitly. | Keep seed choice, rule scheduling/fixpoint evaluation, and recommendation choice host-governed. Qualify derivations under abrupt crash/scale and add temporal-basis semantics only from demonstrated need. |
| Calibration | Corroboration, contradiction, temporal overlap, and structural findings are visible, and downstream calibration output can persist as an explicitly non-epistemic signal. | Add typed authority priors, calibration semantics/evaluation, and durable unknown/hypothesis knowledge; never turn a signal, source count, PageRank, or model confidence into truth automatically. |
| Collective memory | A space can now be copied and reconciled across replicas through a transport-neutral checkpoint DAG, but it has no user/principal control plane or autonomous community semantics. | Keep byte transport, peer authentication, topology, and collaborative policy outside the embedded core. Multi-writer reconciliation must preserve scope, provenance, ontology, and deletion semantics. |
| Contexts and scope sets | Spaces provide hard logical isolation; records and signal partitions use one exact conjunctive required-scope set, and a trusted host supplies a subset-checked `AccessContext`. | Keep the small embedded capability model. Spectron's hierarchical grants, DNF alternatives/co-ownership, registered scope vocabulary, and principal delegation are not present and must not be implied. Add richer scope algebra only through an explicit migration, not ambiguous reinterpretation. |
| Sessions, state diffs, and profiles | Episodes preserve ordered messages/events; source, tags, metadata, valid time, and scoped application facts/signals can model thread state. `snapshot(...).changesCursor` and `changes` provide a revision-bound full-state-to-delta handoff, while a profile is a downstream view over selected current facts and instructions. | Keep sessions and profiles outside the generic canonical vocabulary. Add a reusable projection/query helper only if real consumers cannot express the view efficiently; do not make one-session-per-thread or Spectron's category layout a storage requirement. |
| Experiential categories | Episodic, identity, knowledge, context, instructions, and uncertainty can be modeled with episode kinds, tags, ontology types, and facts. | Keep the core vocabulary open. Categories are host profiles/views, not a mandatory closed enum. Durable unknown/hypothesis records remain a useful generic gap. |
| Ontology grounding | The configured ontology is a versioned validation contract with entity/fact shapes, subject/object/value constraints, and cardinality; provider candidates cannot bypass it. Downstream entailment can persist maintained conclusions through rule-identified derivations. | Keep validation and maintained support separate from rule interpretation. Mutable ontology proposal/approval and migration remain future substrates. |
| Supersession, decay, and forget | Fact lifecycle, correction/retraction, soft episode deletion, breadth-guarded hard purge, signal expiry, and grouped/time selectors keep replacement, relevance advice, and erasure distinct. | Keep this separation. A downstream can persist reinforcement/decay recommendations as signals, but no scheduler or retrieval loop applies them automatically. Do not reinforce merely because ranking returned an item: exposure, user outcome, correction, and source support are different signals. Hard purge remains stronger and more explicit than ordinary aging. |
| Retrieval/decision/response traces | The semantic change journal reports affected targets but deliberately carries no candidates, scoring, decisions, prompts, or responses. Operations and in-process events expose part of execution. | Add privacy-bounded durable retrieval and decision traces only as scoped, retention-governed data. Response traces belong to the host because this package does not synthesize answers. |
| Semantic response reuse | The package retrieves evidence but does not own prompts or answers. | Keep outside core. A host may cache responses against citation and revision dependencies. |
| Four-tier query ladder | Exact lookup, hybrid channels, graph depth, optional reranking, budgets, and degraded notices already expose costs explicitly. Stored signals are not silently consumed. | A future adaptive planner and explicit signal-aware relevance policy may escalate or adjust channels, but must report that contribution; answer synthesis/full-context fallback remains a host decision. |
| Tri-temporal storage | Valid time, logical record/known time, source occurrence time, receipt time, lifecycle history, and revision ordering exist. | Keep the extra episode-time distinctions. Do not claim MVCC system-time rewind on IndexedDB. |
| Deployment | Spectron's published product is used through a running `spectrond` service over HTTP/MCP/SDK; its docs state there is no supported in-process extraction/recall API. | Preserve Temporal Memory's defining advantage: embedded browser WASM, no server process, opaque local persistence, and offline-capable host control. |

The five coherence dimensions map as follows:

| Dimension | Current status | Next useful substrate |
| --- | --- | --- |
| Semantic | Entity/fact graph, ontology, exact/cosine semantic retrieval. | Quality corpus and calibrated entity-resolution evaluation. |
| Lexical | Immutable episode content, exact anchors, citations, BM25. | Optional source sections/chunks without losing parent anchors; keyword bridges only if benchmarks justify them. |
| Relational | Scoped entity-valued facts, bounded graph traversal, structural and explicit seed-weighted personalized PageRank. | Native relation projection, recursive traversal pushdown, and evidence-based automatic query-to-seed selection. |
| Temporal | Valid, known/recorded, observed, received, lifecycle, and current/history views. | Independent valid/known axes and historical entity/merge reconstruction; real system time only on a qualified versioned engine. |
| Spatial | Host metadata can carry coordinates but the facade has no spatial predicate or rank channel. | Add an optional geometry facet only for demonstrated downstream cases; do not burden every memory record with location. |

Several published Spectron pages describe stronger conceptual fields than its current public schema
examples expose—for example a structured source object with exact spans, stored trust/confidence,
three distinct trace kinds, importance/TTL, and derivation lineage. Its schema page instead shows a
narrower turn reference, attribute supersession, and one `decision_trace` summary. Temporal Memory
treats the architecture as direction, not proof of an available compatibility contract. Exact
evidence anchoring, explicit provider lineage, revision-bound state/diff handoff, separate
semantic/signal journals, and premise-backed truth maintenance are implemented here now; calibrated
authority and durable retrieval/decision traces are not.

## 8. Persistence architecture and SurrealDB tiers

The package has three entry points:

| Entry        | Role                                               |
| ------------ | -------------------------------------------------- |
| Package root | Storage-neutral memory facade and domain types.    |
| `/surreal`   | Embedded SurrealDB WASM storage plus a privileged raw-query capability. |
| `/testing`   | Deterministic non-persistent in-memory adapter.    |

The reference adapter pins and tests the candidate compatibility unit
`@astrale-os/surrealdb-wasm@3.0.4-astrale.1` + `surrealdb@2.0.8`. It embeds
`surrealdb-core@3.0.5`; exact fork source commit
[`b049a1a`](https://github.com/astrale-os/surrealdb.js/commit/b049a1ace08147b90fb539d4681e2f22890d7eed)
is derived from JavaScript SDK base `64b8f10`. The direct/worker Chromium and clean packed-artifact
gates pass; independent branch/tag CI builds are byte-identical, and the release tarball is that CI
output. The Temporal Memory manifest pins the checksummed tarball on versioned source tag
[`surrealdb-wasm-v3.0.4-astrale.1`](https://github.com/astrale-os/surrealdb.js/releases/tag/surrealdb-wasm-v3.0.4-astrale.1),
so it no longer relies on local state; npm publication and license approval remain release
limitations. Dependency upgrades are atomic and must pass the same source and packed-artifact
harnesses. The adapter accepts only `indxdb://` and `mem://` endpoints and registers only embedded
WASM engines. It does not expose HTTP, WebSocket, cloud, or arbitrary Surreal connections.

| Capability tier     | Current implementation                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| Canonical storage   | Schemafull tables, ordinary indexes, bound values, transactions, per-space optimistic revision checks, and storage-filtered active merge redirects with an additive legacy-envelope backfill. |
| Lexical retrieval   | Native SurrealDB analyzer and BM25 full-text index.                                                        |
| Vector retrieval    | Exact cosine expression and ordering over stored vectors; no HNSW or other vector index.                   |
| Episode browse      | Access/filter-pushed `limit + 1` keyset pages for current, valid-at, and history views without metadata residuals; residual/known-at pages use complete 16-row canonical scans under public row/byte limits; descending IndexedDB queries use a table iterator. |
| Statistics          | Native bound-filtered counts for simple cardinalities; latest-per-key, distinct-conflict, stale-projection, and provider-call metrics use advancing keyset pages capped at 1,000 rows. |
| Graph retrieval     | Recall/search/neighborhood scan canonical rows and projection candidates under public row/byte limits, then traverse preindexed visible adjacency in TypeScript rather than Surreal graph relations. |
| Structural analysis | Components, degree, density, `structural-pagerank-v1`, and caller-seeded `personalized-pagerank-v1` run in TypeScript after 16-row physical scans under independent row, exact-byte, and algorithm-work budgets. |
| Semantic changes    | One atomic `tm_change` record per semantic revision; indexed revision scans plus atomic bounded range compaction and facade scope filtering. |
| Journal consumers   | Local-only `tm_journal_consumer` checkpoints and per-journal epochs; monotonic same-access acknowledgements, explicit non-reusable retirement tombstones, metadata-revision keyset browse, and epoch-guarded registered compaction. |
| Signals             | Closed one-pass browse/put/delete request snapshots prevent post-call mutation or accessor retargeting; immutable `tm_signal` revisions have unique key/version identity plus namespace, target, producer/slot, tag, revision, and expiry indexes; 16-record keyset scans provide identity/access pushdown, exact byte-bounded pages, addressed-key prior-version scans, native revision counts, and atomic logical-key range purge. |
| Signal changes      | One atomic `tm_signal_change` record per signal mutation; indexed revision scans, scope filtering, purge invalidation, and independent bounded compaction. |
| Replica sync        | Closed one-pass control-plane request snapshots plus content-addressed checkpoint chunks, bounded inventories/bundles, durable pull and conflict sessions, guarded apply/rollback, and explicit checkpoint/session-detail compaction. |
| Raw SurrealQL       | Construction-time frozen storage/`SurrealMemoryAdmin` pair for trusted power users; ordinary application storage has no raw method or elevation path; exact database confirmation, JSON bindings/results, incremental frame admission under byte/node bounds, statement diagnostics, shared direct/worker scheduling, and origin-wide persistent arbitration. |
| Browser hosting     | Direct and package-owned module-worker WASM engines; IndexedDB for durable endpoints.                      |

The facade owns memory semantics. SurrealDB remains replaceable and the root `Memory` API exposes no
storage commands. The `/surreal` storage factory returns a nominal application capability with no
raw-query method and no later elevation path. A separate privileged factory creates a fresh, frozen
storage/admin pair after an explicit dangerous acknowledgement; the host distributes only the
storage half to application code. An alternative persistence adapter is not a supported alpha
extension surface.

Raw SurrealQL is a database-wide administrator escape hatch, not another memory read API. It does
not apply `AccessContext`, disclosure policy, canonical validation, revision guards, journals,
projection invalidation, purge discovery, or sync bookkeeping. Power users may read `tm_*` for
advanced aggregates and graph expressions, but should write only downstream-owned tables; raw
mutation of package-owned tables requires an explicit host migration/repair discipline. Such writes
also bypass the facade's private metadata generation: the host must quiesce facade/raw writers,
perform the repair atomically, and verify afterward rather than treating an overlapping integrity
scan as coherent. Each call must confirm the exact namespace/database, parameter bindings and
results are bounded JSON, and the complete request is detached before it enters the database
scheduler. Bindings are copied and validated in one bounded traversal, so later mutation or a
changing accessor cannot pass validation with one value and dispatch another; unreadable accessors
fail before storage. All execution uses the same per-storage scheduler in direct and worker modes
plus the same origin-wide persistent coordinator as facade work. Statement failures are returned
individually, and multi-statement queries are neither made atomic nor retried implicitly. The
adapter consumes the SDK frame stream and admits each scalar or row against aggregate byte/node
bounds before retaining it, avoiding whole-result collection. One engine chunk or unusually large
row can still materialize first, so native `LIMIT` and `TIMEOUT` remain mandatory for potentially
large work. The installed SDK exposes no physical query-cancellation primitive, so the admin API
does not pretend that an `AbortSignal` can stop already-dispatched database work; abandoning the
promise or ending response consumption is not cancellation. Arbitrary SurrealQL also has no safe
generic resume point. A resumable expert scan must be authored as deterministic keyset pages with
bound cursor values, `LIMIT`, and an application-durable cursor; whole-memory transfer uses the
content-addressed `syncFrom` protocol instead.
If statement responses arrive but adapter-side validation or result admission rejects them, the
error is non-retryable with `queryOutcome: 'responses_received'` and
`requiresReconciliation: true`: mutations may already be durable. That does not poison the healthy
connection; the host issues a new bounded inspection query and never replays the original request
blindly.
If physical completion disappears, the unknown error poisons the shared driver rather than only the
admin promise: admin, paired facade work, and cached `open()` all fail without another database call.
Every open facade reference must close; a partial close cannot clear the poison or let a failed open
steal another facade's reference. The next fresh physical open is the recovery boundary.

SurrealDB should be used more deeply where it improves bounded execution without leaking physical
schema into the public API:

1. project canonical entity-valued facts into package-owned relation records and push bounded
   recursive neighborhoods into SurrealQL;
2. push filters, pagination, corroboration counts, distributions, and selector previews below the
   JavaScript materialization boundary;
3. benchmark and, when justified, push caller-seeded personalized PageRank below the materialization
   boundary; add automatic query-to-seed selection only with evidence-based selection semantics;
4. add an HNSW index only after named-corpus recall/latency/memory benchmarks show exact cosine is
   insufficient, and retain generation/dimension isolation;
5. use geometry indexes/functions only behind an optional spatial facet; and
6. keep both implemented public journals independent of physical database changefeeds; use a
   database changefeed later only as an internally qualified wake-up/transport optimization, never
   as either public payload.

SurrealDB's `SELECT ... VERSION` time travel is storage-engine-dependent. The current IndexedDB WASM
engine is not qualified as versioned storage, so application lifecycle records remain the temporal
source of truth. Switching to a versioned engine later would add a physical audit axis; it would not
replace valid time, known time, evidence status, or package revisions.

### 8.1 Durability and coordination evidence

The Chromium acceptance harness creates the full schema and indexes, writes canonical data, closes
the first runtime, opens fresh second and third connections to the same IndexedDB database, and
verifies direct and module-worker reads, lexical recall, semantic- and signal-feed persistence,
purge scrubbing, bounded compaction of both feeds, old-cursor invalidation, scoped signal
persistence/diagnostics, dependency-aware signal purge, both persisted compaction floors, and the
separate raw-admin acquisition, confirmation, parameterization, response-bound, failure, and
closed-lifecycle contract. This proves graceful fresh-connection reopen. A separate source-browser
case pauses ingestion after its durable acceptance transaction, opens another facade without
misclassifying the live owner, terminates the owning page without `close()`, and then reopens/retries
from the observer. Across direct/direct, worker/worker, and mixed clients it preserves exactly one
accepted episode/change, marks only the abandoned operation partial, and completes canonical
processing under a fresh operation ID. This is not browser-process restart, database-worker death
during a transaction, background suspension, or quota recovery. A separate same-origin two-page matrix proves guarded
signal-write CAS/retry, one-winner same-preview signal withdrawal and retained-key purge without
loser residue, and pre-marker hard-purge rejection when a late signal dependency arrives after the
target read; explicit retry replans and erases that dependency. Both clients are also paused after
reading the same bounded semantic- or signal-journal compaction batch: one atomically deletes the
batch and advances only its floor, while the retryable loser changes neither journal. The other tab's
old cursor receives the correct feed-specific baseline error. Distinct rule evaluations paused after
complete planning likewise produce one canonical derivation winner and one residue-free loser;
cross-client replay is stable, explicit losing-ID re-evaluation adds no duplicate support/change, and
racing withdrawal atomically retracts a two-level unsupported conclusion chain. The same matrix
proves reset incarnation fencing and both destructive-reset/canonical-writer winner directions with
no lost committed write or post-delete resurrection, plus logical-race rejection for snapshot, recall, checked point read,
browse, neighborhood, analysis, bounded archive export, integrity, signal browse, and semantic/signal
journal pages, plus private-metadata-race rejection for statistics and inspection across
direct/direct, worker/worker, and mixed clients. A separate no-Web-Locks context proves persistent
open fails closed while `mem://` remains usable.

Writes are serialized per facade and protected by storage revisions; persistent physical calls are
also arbitrated across same-origin clients by a stable endpoint/namespace/database Web Lock. The
expanded race first exposed a real two-winner failure under independently scheduled embedded
transactions; the origin-wide lock plus in-transaction revision guard closes that gap. Every static
facade also holds a separate private runtime-owner lease. Open-time ordinary-operation,
hard-purge, and sync-apply recovery checks this liveness token first, so a second client cannot steal
work merely by opening; page/worker death or graceful close releases the lease. Deterministic
in-memory schedules cover all three recovery paths, while Chromium covers ordinary post-accept
ingestion recovery, hard-purge owner death at every durable application phase, and sync owner death
after durable journaled forward and inverse rollback steps. Ownerless hard-purge recovery first wins
one revision-CAS operation claim; rollback recovery restores the retained local HEAD without its
remote peer. Sync activation
atomically binds the active session to its running owner operation, and successful publication
atomically commits the completed operation, HEAD, and terminal session. Every static
governance, purge-selection, and projection plan is
pinned to the revision it read and fails retryably rather than replaying its puts/deletes against a
newer revision. Ingestion and correction retry only by rereading and rebuilding the full plan;
episode processing also rechecks durable purge tombstones and live accepted-episode identity on each
attempt. Adversarial independent-facade tests prove that a winning purge cannot be followed by stale
merge, canonical, or projection data and that a new dependency makes an uncommitted purge selection
fail closed. The separate-client matrix now proves direct signal withdrawal/purge contention,
hard-purge pre-marker late-dependency fencing, derivation create/replay/re-evaluation/withdrawal with
cascading invalidation, same-batch contention for both journal compaction APIs, and one-winner
activation of an identical sync session with residue-free terminal replay. It also proves one-winner
distinct hard-purge marker contention, fail-fast live-marker rejection before planning, and explicit
loser retry across every engine pairing. Target-selected canonical actions now have a separate
nine-schedule matrix: disjoint soft deletions explicitly rebaseline and retry, both soft-delete versus
hard-purge winner directions are atomic, all losers are residue-free, and consumed selections expose
no destructive cursor. Projection maintenance now has its own single-flight/cutover/owner-death
matrix; additive migration now has same-step/between-step evidence, while other governance writes
and any future row-transforming or ontology migration remain production gates.

Projection rebuild uses a separate monotonic canonical-source revision: projection and operation
commits may advance the physical space revision without invalidating the build, while any canonical
graph change prevents its final set activation. Each projection row carries a set id and each search
requires the exact active reference stored on the space. SurrealDB therefore makes the full-set
visibility change in one guarded transaction. That transaction marks the complete staged set ready,
updates the authoritative space row, and atomically retires/repopulates lexical BM25 envelope text;
it does not rewrite every vector to make it active. A crash can leave only inactive rows, never a
partially visible generation or a BM25 corpus containing staged text, and a later full rebuild
reclaims them in bounded pages. Operation settlement follows the cleanup attempt: if cleanup is
deferred after activation, the new generation remains authoritative but the report is explicitly
partial/retryable and exposes the inactive-row count.

Rebuild selection, dependencies, existing targeted rows, and generated projection rows participate
in exact row/stable-byte admission. Inactive-set reclamation remains a separate 16-row
timeout/cancellation-bounded pass because it follows authoritative cutover; its work is not included
in the projection input report. Stale totals use native counts rather than a whole projection-table
materialization.

## 9. Isolation, privacy, and security

Every operation is bound to one memory space. Within a space, a record requiring scopes `S` is
visible only if every member of `S` appears in `AccessContext.allowedScopes`. An empty allowed set
grants only unscoped records; there is no wildcard.

`AccessContext` is a defense-in-depth data filter, not authentication. The host MUST derive it from
a trusted principal and MUST NOT allow untrusted callers to self-select scopes.

Raw SurrealQL is the intentional exception to facade-level scope and policy enforcement. The admin
capability must stay in trusted host code; application/model code should receive only the separate
storage or `Memory` capability, and raw query text must never be accepted from a model, browser user,
or other untrusted principal. Exact target confirmation prevents accidental
database selection, not malicious statements; bound values prevent value injection, not unsafe
query text. Embedded engine capabilities continue to disable scripting, guest access, and network
targets even when raw queries are enabled.

Scope filtering applies before lexical/vector top-K selection, graph expansion, rendering,
diagnostics, export selection, and remote disclosure. Entity aliases, identifiers, facts, evidence,
and projections retain exact episode-backed scope partitions. A restricted enrichment cannot widen
a public identity or projection.

Signal visibility uses the same conjunctive access rule. Writes require caller access to their
declared scopes and to every target/basis record; dependency scopes cannot be omitted. Current
selection resolves the latest global revision before access filtering, so an older signal revision
cannot reappear when the latest is hidden, withdrawn, or expired. Tags and arbitrary values are
untrusted application data and MUST NOT be treated as authentication or used to conceal undeclared
private dependencies.

The package MUST:

- treat host input, web content, provider output, and imported archives as untrusted;
- use bound values for application data; facade SurrealQL is package-owned and constant, while an
  enabled raw query must remain trusted host-authored;
- disable scripting, guest access, and network targets in the reference WASM engine;
- prevent source content from changing policy, obtaining credentials, executing code/SurrealQL,
  requesting network access, or invoking browser/agent tools;
- expose a policy checkpoint before external provider calls;
- keep credentials and provider payloads out of canonical memory and export;
- avoid outbound telemetry unless the host explicitly installs and authorizes it.

IndexedDB and browser-origin isolation are not application-level encryption. The package makes no
encryption-at-rest claim. A local purge also cannot guarantee deletion by a remote provider that
previously processed content.

## 10. Correction, deletion, and governance

The package distinguishes:

- **correction**: atomically creates better supported current knowledge while retaining prior
  history;
- **retraction**: withdraws one source or all authorized support without asserting the opposite;
- **episode deletion**: soft-deletes evidence and reassesses dependent facts;
- **bulk episode deletion**: applies the same semantics to an access-bounded selector only at a
  previewed revision and below an explicit match ceiling;
- **projection rebuild/deletion**: replaces non-canonical indexes and summaries;
- **entity merge**: records a redirect without destroying source identity;
- **split merge**: deactivates a recorded merge and restores source identities;
- **hard purge**: physically removes selected canonical content and revealing projections;
- **space reset**: deletes the entire space after exact confirmation.

A fact remains current while another retained active source supports it. After its final support is
withdrawn or deleted, it no longer appears as an ordinary current fact. Historical reads may expose
soft-deleted or withdrawn provenance; hard-purged content is unrecoverable from the package.

Hard-purge dependency closure includes durable operational diagnostics. An affected operation keeps
only opaque identity, private run binding, kind, terminal outcome, timestamps, attempt count, and
`diagnosticsState: 'purged'`; its episode binding, result, error, warnings, and provider-call
summaries are physically removed. The closure follows erased canonical and semantic-journal lineage
plus exact target IDs in stored results. Because rebuild, sync, and migration may span the whole
space without per-target durable lineage, any such operation is scrubbed on targeted purge.
Revision CAS plus an operation-tombstone write guard prevents an in-flight loser from settling over
the tombstone after purge.

Available operation diagnostics use a fixed observability budget. The durable row keeps the first
32 and last 32 warnings and provider-call summaries when either stream exceeds 64 entries; warning
and error messages are capped at 2,000 UTF-8 bytes with malformed surrogate input made well formed.
`diagnosticsTruncated` distinguishes a complete sample from an intentionally reduced one. Error
code, retryability, and operation identity survive, but error `details` do not. Inference-provider
warning text is replaced by a content-free count, and provider/storage failures are classified with
library-authored messages so credentials, raw responses, queries, and payloads cannot hitchhike in
third-party exception text. This journal is operational status, not a general provider trace.

Soft deletion and hard purge invalidate projections through episode evidence, mentions, and alias
provenance, not only projections whose target id is directly selected. That projection-only closure
does not delete surviving entities or facts that retain independent canonical support.

Single and grouped soft episode deletion are bounded target operations. Single deletion point-loads
the visible retained episode. Group deletion selects retained visible episodes through pushed-down
identity/source/tag/time filters plus residual metadata equality, stopping at the first match above
`maxMatches`. `previewEpisodeDeletions` and filter-selected `deleteEpisodes` share that exact
selector. A non-empty preview returns the complete deterministic episode set and an opaque cursor
binding the space incarnation, access partition, normalized filter, revision, and ordered selected-ID
digest. Apply reselects and verifies every binding; an empty preview returns no destructive cursor,
and stale, reset, access, filter, revision, or selected-set drift fails retryably without mutation.
Signal-target deletion scans current revisions from bounded signal-history keysets and freezes expiry
to the checked preview instant. Both paths read only selected evidence, mentions,
aliases, affected derivations, facts, and projections in 16-row keysets, run the affected
truth-maintenance closure, and report exact admitted row/byte/graph work. A caller may lower every
ceiling. Limit failure and an independent-facade revision race leave no episode tombstone, fact
transition, lifecycle, projection deletion, operation, signal, or journal row. Alias episode
membership bounds facade transfer/materialization but has no dedicated SurrealDB index, so this is
not a latency claim.

`deleteEpisodes` rejects an empty selector, malformed or mismatched selection cursor, a stale
preview revision, zero matches, more than `maxMatches`, admitted work above `workLimits`, and
operation-id reuse with different input. The
selected episodes, dependent fact reassessment, lifecycle records, projection invalidation, and
settled operation commit in one revision CAS. Selector-based hard purge applies the same
preview-revision and breadth guards before
creating its durable purge marker. Source/tag/metadata/time dimensions compose conjunctively, so a
host can preview and govern a group without issuing one mutation per id. Selection is always after
scope filtering; the host remains responsible for authenticating the principal behind those
scopes.

Soft deletion and selector purge default to retained episodes so a default-current `snapshot`
previews the same set. Purging already deleted history requires an explicit
`retentionStates: ['deleted']` selector and a `history` preview; selecting both retained and deleted
states is also explicit.

Signal governance is separate from canonical deletion. `deleteSignals` selects current logical
signals by identity, namespace, slot, producer/version, target, state, tags, basis IDs, record time,
or expiry. The same exact preview revision and maximum-match pattern protects both withdrawal and
history purge. For canonical erasure, a constrained active current `browseSignals` returns a
full-selection cursor. `hardPurge.signalTargets` consumes that cursor plus the identical filter and a
match ceiling, revalidates its access/generation/revision/evaluation-time/full-set binding, and uses
the selected episode/entity/fact targets without host-side ID paging. This remains a distinct
authorized hard-purge action: the package never interprets a signal value as a command. Signal
withdrawal alone does not delete memory. Conversely, canonical hard purge automatically deletes
complete signal-key histories whose declared target or basis references erased IDs.

For non-erasing application, `deleteEpisodes.signalTargets` consumes the same exact selection but
rejects entity/fact targets. It soft-deletes the deduplicated episode targets, reassesses support,
invalidates projections, settles the operation, and appends withdrawal revisions for all selected
signals in one physical transaction. The semantic governance row and signal withdrawal row share
that revision but remain separate journals. This consumes an applied recommendation without
conflating the recommendation with the authorization or canonical effect.

The alpha correction path commits its correction episode, evidence, replacement fact, prior-fact
supersession, and operation in one revision-checked transaction. It preserves the exact fact scope,
is idempotent by operation id and content hash, and replans after a revision conflict. Planning uses
bounded indexed support, identity, ontology, truth-maintenance, and projection reads and returns its
exact admitted work. Every retry repeats whole-support authorization against the refreshed revision;
a private support inserted after the first plan makes the retry fail closed. Injected commit-failure
and hidden-support-race tests prove no partial canonical state in the tested adapter; abrupt
persistent-engine kill remains a browser production gate.

Retention and sensitivity values are stored on episodes. Provider-facing projections and
disclosures conservatively propagate the complete source-dependency sensitivity set; canonical
aliases, evidence, and derivations retain their explicit source links rather than duplicating a
mutable classification. Automatic retention scheduling and storage-pressure cleanup are not
implemented alpha behavior.

“Stale” is deliberately not an episode or fact status. A host may express domain freshness through
valid time, an application fact, or a scoped non-epistemic signal, and may then choose deletion or
purge through governance.
Structural importance, retrieval salience, confidence, evidence support, and retention eligibility
are separate concepts and MUST NOT be collapsed into one mutable weight.

## 11. Archive portability and whole-memory synchronization

### 11.1 Selective canonical archives

`export` produces one deterministic JSON document with media type
`application/vnd.astrale.temporal-memory+json`, format version `4`, canonical records, ontology,
space metadata, `snapshotRevision`, `exportedAt`, counts, and a SHA-256 digest over canonical
content. Export brackets materialization and hashing against the space generation and revision;
concurrent mutation fails closed. The digest detects canonical-array modification, but does not
cover envelope lineage and is not a signature or authenticity proof. Signals, semantic changes,
operations, purge markers, secrets, and provider payloads are excluded. A target import appends one
fresh local semantic import change instead of replaying source operational history. The archive
includes each selected logical derivation's latest visible revision and its conclusion/premise
closure. Each archive episode also carries the accepted explicit assertions required to recompute
its `contentHash`; those inputs remain distinct from canonical truth. Import verifies every episode
identity before target reads and rehashes remapped ids. Explicit signal history can be read through
`browseSignals`, but format v4 neither packages nor restores it.

Exports may select by allowed scopes, receipt-time range, episode ids, entity ids, or fact ids.
Dependency closure is retained through visible evidence and canonical derivations. `complete: true` requires access to
every episode in the space. Source-kind selection and projection-bearing archives are not supported
alpha portability guarantees.

Before reading target database state, import validates the closed envelope and ontology schemas,
canonical section counts and ordering, source-space consistency, bounded JSON, manifest digest, and
every recomputable episode identity. Before mutation it additionally validates duplicate identities,
content/source/assertion variants, temporal values,
references, evidence/derivation state, ontology subject/object/value constraints, positive-cycle
absence, active-premise availability, and exact alias, mention, evidence, derivation, and
fact-support scope partitions. It supports dry run and `reject`, `identical`, or `remap` collision
policies. Derivation keys/IDs are recomputed for the target and current supports become target-local
version-one revisions. Older formats are rejected rather than reinterpreted. The manifest digest
authenticates no data but does detect canonical-document modification.

`ArchiveMerge`, `ArchiveCounts`, and `ArchiveManifest` are exact public format-v4 wire types. Merge
records are produced by an explicit archive projection, so an internal storage-field addition does
not silently alter the portable format.

Export and import still materialize a single document in memory, but the document is now explicitly
bounded rather than open-ended. Export scans only canonical storage kinds in 16-row keysets under a
100,000-row / 64 MiB default work budget (1,000,000 / 256 MiB maximum), then caps the exact returned
archive at 10,000 manifest records / 16 MiB by default (100,000 / 64 MiB maximum). Import applies the
same document cap before collision work and independently caps expanded target-local rows and their
serialized transaction input at 100,000 / 64 MiB; hosts may lower every limit. Aggregate archive
JSON is capped at one million nodes. A breach fails with `result_too_large` before a partial artifact
or mutation. This remains the deliberate small/selective archive and target-space remapping API, not
the replica protocol. A second streaming encoding of the same remapping document is intentionally
not part of the contract: bounded `exportSyncBundle`/`syncFrom` owns resumable whole-memory
portability without duplicating framing, resume, or integrity semantics. Authenticated archive
envelopes and cross-version archive/ontology migrations remain production decisions. This does not
make selective format-v4 materialization disappear or change its remapping semantics.

### 11.2 Replica checkpoints and reconciliation

Whole-memory synchronization is a separate protocol. `createSyncCheckpoint` creates an immutable
content-addressed commit over the complete logical space; `syncHead`, `syncCheckpoint`, and
`syncChunks` expose bounded transport-neutral reads; and `syncFrom` pulls, verifies, reconciles, and
applies one peer checkpoint. Calling the pull in both directions is the explicit bidirectional
convergence pattern. The core does not open sockets, discover peers, authenticate principals, or
choose a cloud topology.

The entire sync control plane owns its request at public invocation. Closed, bounded JSON snapshots
cover access grants, confirmations, checkpoint/session ids, cursors, compaction cutoffs, strategies,
receive limits, and conflict resolutions before queueing or any local/remote I/O. Read and operation
options are copied at the same boundary. Only `AbortSignal` and `MemorySyncPeer` remain live
capabilities. This prevents a delayed or queued call from validating one reconciliation plan and
executing another after caller mutation.

`openSyncBundle` pins its caller limits and abort signal before reading an untrusted durable
container. Each returned commit, checkpoint, or chunk frame is detached and JSON-validated in one
hard-bounded traversal before the same snapshot is structurally checked, hashed, or retained. A
reader getter or concurrent container mutation therefore cannot pass validation with one value and
drive reconciliation with another; unreadable or hard-oversized frames fail as `import_invalid`.
Verification still retains only bounded metadata plus one bounded frame body at a time and rechecks
the authoritative reader on later peer calls.

A checkpoint includes canonical records, complete retained signal and derivation revision history,
and successful content-free hard-purge tombstones. It deliberately excludes projections, semantic
and signal journals, operation diagnostics, provider payloads, and source-local physical revision
numbers. Portable purge tombstones omit cleartext targets and caller-controlled operation IDs,
retaining only target/idempotency digests, state, hashes, and timestamps. Projections are invalidated
and rebuilt locally; imported signal/derivation revisions are
assigned valid target-local physical revision lineage while preserving logical keys, versions, and
supersession. This makes the replicated object the logical memory, not a byte copy of private
SurrealDB tables.

Offline whole-memory portability reuses this exact object and merge engine. `exportSyncBundle`
pages a selected retained checkpoint into indexed portable header frames, its unchanged checkpoint
chunks, and a final commit frame. Pages are bounded by frame count and canonical frame bytes and
carry an opaque resume cursor that is advanced only after the host durably stores the page. That
cursor and every page bind both the logical revision and the private sync-metadata revision, so
checkpoint publication, payload compaction, or session cleanup expires the traversal rather than
mixing states. Fresh snapshot-bound cursors are v2; pre-v2 alpha cursors restart. The header sequence
has a rolling SHA-256 digest and an aggregate byte commitment; the target payload
keeps its checkpoint, chunk, and ordered-root digests. The exporter includes accessible local headers
plus deterministic genesis and validates complete target ancestry before emitting commit. A
host-owned file/blob/IndexedDB adapter provides only indexed `readCommit`, `readCheckpoint`, and
`readChunk` primitives. Native `openSyncBundle` then verifies exact framing, ceilings, gaps, extra
frames, the header commitment and ancestry, target manifests, scope union, and commit immutability
with one chunk body in memory before exposing `MemorySyncPeer`; `syncFrom` performs semantic import,
three-way reconciliation, durable receive/apply resume, and purge dominance. The core intentionally
does not choose a blob transport or filesystem. An incomplete bundle is not a peer, and bundle import
is neither format-v4 remapping nor history rewriting.

The history is a checkpoint DAG with deterministic genesis per space and ontology. A fresh or
ancestor replica fast-forwards. Diverged replicas find a bounded common ancestor and perform a
three-way record merge: unchanged, one-sided, and byte-identical changes converge automatically;
same-record edits/deletes become durable conflicts; and graph-wide combinations such as a new
positive derivation cycle or unreconciled cardinality-one facts become `invalid_combination`
conflicts. Iterative strongly connected components identify only actual cycle participants, so
acyclic derivations downstream of a conflicted cycle remain eligible to converge. `syncConflicts`
pages them and `resolveSync` records explicit `local`, `remote`, or `delete` choices. The inventory
remains metadata-only and is bounded simultaneously by item count and exact canonical response
bytes (1 MiB default, 16 MiB maximum). New pages use fixed-size conflict-id cursors rather than
embedding a potentially large record key; legacy key cursors remain readable. Every listed row is
shape- and identity-checked before disclosure. `syncConflict` fetches one pinned base/local/remote
record triple under explicit byte bounds so a host can make an informed choice without
materializing every conflicting value. Once terminal detail compaction begins, both list and point
reads fail explicitly with `detailsPruned: true` instead of presenting an ambiguous empty result.
There is no history-rewriting `rebase`: rewriting ancestry or source-local revisions would weaken
auditability and make purge reconciliation unsafe.

A pull walks every remote parent branch until it reaches already retained local ancestry rather
than stopping after the first merge base. Missing immutable headers are stored parent-first in
bounded create-if-absent batches; only the selected remote target receives a payload, while
intermediate headers are explicitly `pruned`. This preserves a complete local DAG for later bundle
export and merge-base negotiation without silently promising that every historical payload is
available. A concurrent rehydration cannot be overwritten by ancestry caching.

Staged purge dominance is fail-closed rather than presence-based. Each local sync tombstone has an
exact closed shape and a derived identity bound to space, session, target-vs-idempotency kind, and
digest. Facade commits validate it before persistence, every suppression lookup revalidates the
loaded row against the requested tuple, and paged integrity verification reports
`invalid_sync_tombstone`. Thus privileged/raw metadata corruption cannot silently turn an unrelated
row into authority to discard live memory. Repeated dependency decisions are memoized as booleans
for at most 100,000 logical keys without retaining variant records; after the cap, traversal
recomputes rather than growing memory.

Transfer and staging are bounded. Checkpoints contain at most 256 records per chunk; configured
chunk size defaults to 8 MiB and is bounded to 64 KiB..16 MiB; pages never split chunks; every chunk
has a SHA-256 digest; and an ordered streaming hash chain commits the complete manifest. Durable
receiver progress advances only after a verified chunk and its random-access index commit together.
The central facade write boundary verifies the closed chunk manifest and requires exactly one
deterministic index projection per contained record in that same atomic write before invoking a
driver. Partial, index-only, duplicate, forged, or checksum-invalid packs cannot be produced by the
safe API.
A stored checkpoint header validates its content-derived identity plus private source-revision and
available/pruning/pruned owner lifecycle. The singleton HEAD ref has a closed shape, canonical
timestamp, and must name genesis or an available retained checkpoint. Integrity verification walks
parent links and recomputes each available payload's exact chunk count, record count, byte length,
scope union, ordering, and root digest in bounded keyset pages.
A random-access index is only an acceleration structure: every safe point/indexed read validates its
derived space/owner/key identity, loads the owning checksummed chunk, and recomputes the complete
index projection from the portable record before using indexed semantic or dependency fields.
`verifyIntegrity` independently scans chunks and indexes in fixed-size keyset pages, validates each
closed chunk manifest, compares every chunk with its exact index set (including missing and extra
rows), and reports malformed or orphan-count metadata. A forged raw index therefore fails closed
instead of steering reconciliation, referential checks, or ontology validation.
It separately derives owner reachability from valid available/pruning checkpoints and exact
active/reclaiming session lifecycles. A checksummed pack with perfectly matching indexes is still
invalid when no such owner reaches it; conflict and staged-purge detail likewise require a valid
non-pruned pull session. This closes self-consistent orphan storage, not only malformed rows.
Every facade storage commit also atomically advances a private monotonic metadata revision,
including commits that intentionally leave the logical memory revision unchanged. Integrity
verification, checkpoint inventory pages, and offline bundle pages bracket their sync-metadata reads
with space generation, logical revision, and this metadata revision; concurrent
checkpoint/session/compaction work fails retryably or expires the cursor instead of allowing an
artifact assembled from two metadata states. The counter is internal coordination state, exposed
only inside opaque consistency cursors and never as a public revision, temporal coordinate, or
change feed.
A chunk page defaults to 16 MiB of canonical chunk payload and is capped at 256 MiB, with transport
and header encoding overhead additional. Protocol-v1 checkpoint, record, chunk, and page envelopes
are closed: unknown fields are rejected instead of being silently ignored.
A resumed session pins its original local and remote heads, so a newer source HEAD cannot silently
retarget it. The original strategy, access grant, revision, ancestry bound, and aggregate receive
limits are durably bound to that session. A remote header is rejected before chunk transfer if it
exceeds the caller's byte, record, or chunk budget, and the same budget bounds a merged result;
defaults are 512 MiB of canonical payload, 1,000,000 records, and 65,536 chunks. Validation uses
bounded chunks and indexed random access; derivation-graph and cardinality validation have explicit
fail-closed node/edge/fact/comparison ceilings rather than unbounded allocation. Each chunk also has
a one-million-JSON-node ceiling distinct from the ordinary single-value ceiling, allowing a valid
8–16 MiB aggregate chunk without an unbounded object walk. Logical payload budgets do not predict
IndexedDB/index overhead, so hosts still need a stricter device quota policy. Semantic validation
retains at most two already verified chunks in an operation-local LRU (32 MiB at the maximum chunk
size) while continuing to revalidate every random-access index and record digest. Merge conflicts
stage in deterministic metadata batches of at most 128; retries safely replace an incomplete prefix,
and resolution does not rewrite byte-identical conflict rows.

Local checkpoint payload retention is an explicit maintenance action, not history rewriting.
`compactSyncHistory` scans at most 1..64 headers per cursor page before a canonical UTC cutoff and
requires whole-checkpoint scope visibility, exact space confirmation, current logical revision, and
the exact current HEAD. Dry run exposes the selected checkpoint ids and logical chunk/record/byte
counts. Commit atomically makes every selected non-HEAD payload unavailable under metadata CAS, then
deletes its chunks and random-access indexes in bounded batches. A durable per-checkpoint marker lets
`open()` finish an interrupted physical cleanup. Immutable headers and parent links remain; the
logical revision is unchanged. An expired divergent merge base produces non-retryable `conflict`
with `details.requiresReseed: true` instead of a guessed two-way merge. The host therefore chooses a
cutoff from its supported peer-offline/reseed policy.

Operators do not need raw database access to discover this state. `syncHistory` provides bounded,
scope-filtered checkpoint pages with local payload availability and a current-HEAD marker;
`syncSessions` provides bounded, scope-filtered resumable/terminal summaries. Checkpoint cursors bind
space generation, access, logical revision, private metadata revision, HEAD, and optional cutoff;
each page brackets that exact state, so compaction expires an older traversal rather than mixing
payload lifecycles. Session cursors use immutable creation order and bind generation, access, and
cutoff because active session inventory intentionally remains live. `compactSyncSessions` separately
reclaims terminal conflict rows, staged purge tombstones, and any unreferenced receiver/merge chunks.
It uses an atomic `pruning` marker plus bounded deletion and reopen recovery, while protecting every owner
still named by a checkpoint. The small terminal session header/result remains, preserving status and
operation-id idempotency. This is detail compaction, not session-header garbage collection.

That retained session header is bounded operational status. `SyncReport` exposes the library-authored
`error`, at most 64 warning strings of at most 2,000 UTF-8 bytes, and
`diagnosticsTruncated`. Overflow retains the first 32 and last 32 warnings; overlong or malformed
diagnostic text is reduced safely and sets the flag. Every facade metadata write enforces the same
budget, including reopen and detail-compaction transitions, while `verifyIntegrity` reports
`invalid_sync_session` for privileged/raw over-budget or malformed rows. Legacy sessions without the
flag read as complete. Targeted hard purge still removes every sync session before canonical erasure.

The header is also a closed durable state machine rather than caller-editable status. Before resume,
cleanup, inventory, point disclosure, or integrity success, the package rederives its request hash,
original access grant, required checkpoint-scope union, local/remote/base identities, logical
revision bounds, receive limits, and operation binding. Active checkpoint builds, remote receivers,
and merge plans must match their exact paged owner manifests. State-specific required fields and
counters are checked before use. A raw attempt to erase private scopes, retarget a checkpoint, forge
progress, or attach another operation therefore fails closed. Terminal diagnostics compaction keeps
one narrow repair path: it bounds diagnostic text first, validates every other invariant, and then
commits the normalized row.

Logical apply runs under a maintenance barrier. Projections are cleared, every revision-sensitive
signal or derivation revision is committed separately with target-local lineage, and progress is
stored atomically with each logical change. Reads and unrelated writes fail with
`sync_in_progress` while a partial apply exists. Reopening automatically resumes it; `abortSync`
rolls it back to the retained local checkpoint only when the target introduced no new purge
tombstone. Because erasure is non-reversible, such a session refuses rollback and must resume
forward. Purge tombstones dominate concurrent additions and are never resolved away; dependency and
support closure also removes concurrent facts, derivations, lifecycle, and signals supported only
by purged evidence. Aborting a pre-apply session removes its partial chunks, indexes, conflicts, and
staged tombstones. Targeted hard purge deletes all local sync packs and sessions first, so an old
checkpoint cannot retain erased plaintext; reset removes the entire space.

Checkpoint hashes detect corruption, not authorship. A host exposing `MemorySyncPeer` over a
transport MUST authenticate and authorize the peer, preserve the method-level response bounds,
protect confidentiality and replay at the transport/session layer, and pass only a deliberately
granted `AccessContext`. The alpha now exposes guarded manual checkpoint-payload and terminal-session
detail compaction, but not an automatic retention policy or checkpoint/session-header collection.
`reclaimedBytes` measures canonical chunk payload, not engine/index overhead. Quota exhaustion, very large graph qualification,
hostile-transport corpus testing, independent-context compaction contention, and signed/encrypted
pack envelopes remain release gates.

## 12. Reliability, observability, and evolution

Durable operations distinguish pending, running, partial, succeeded, failed, and cancelled states.
Accepted episodes and operation status allow explicit retry/reprocess after provider failure.
Pending/running operations carry a private runtime-owner incarnation. Reopen leaves a live owner's
work untouched and marks only ownerless or lease-abandoned work partial; that token never enters the
public operation, archives, replica state, or purged diagnostics tombstone. Every actual open,
including reuse of the same facade object after close, rotates the incarnation so abandoned work
cannot be mistaken for the reopened facade's live work. `diagnosticsState`
distinguishes ordinary operation detail from a physically scrubbed hard-purge tombstone. Hard purge
uses a durable marker and fails reads closed while recovery is active. Its replay-denial and
diagnostics tombstones are implemented in both initial and reopen-recovery paths. In-memory
adversarial schedules prove a live ordinary operation, marked purge, and active sync apply are not
stolen; Chromium proves actual owning-page termination at the ingestion post-accept/pre-canonical
boundary, at all hard-purge boundaries around marker/metadata/final work and recovery claim, after
one committed sync-apply diff, and after one committed inverse rollback diff.
Ingestion uses a fresh explicit retry. Apply recovery finishes the already received remote
checkpoint, while rollback recovery restores the retained local checkpoint; neither requires the
original peer. Mid-transaction engine termination, browser-process restart, suspension, quota, and
corruption remain release gates.

Cancellation cannot undo an accepted episode or committed transaction. Disclosure-policy,
inference, embedding, and reranking waits race the configured deadline; the API settles with
retryable `timeout` even when external code ignores abort, and any late result is detached before it
can invoke the next capability or mutate memory. Caller abort is non-retryable `cancelled`.
`operationTimeoutMs` is not a hard storage or sync-peer deadline: the facade checks cancellation
between those awaits and passes a signal to cooperative peers, but never detaches a possibly
committing database write. Engine and transport timeout/reconciliation remain host concerns.

The implemented event surface reports lifecycle readiness, operation settlement, provider
request/result, resolution decisions, reconciliation decisions, and retrieval completion. Those
notifications remain process-local and are not durable retrieval/decision traces. Restart-safe
incremental algorithms use the separate semantic `changes` and non-epistemic `signalChanges`
journals. Current statistics include both retained row counts and compacted-through floors alongside
record, conflict, operation, stale-projection, provider-call, current/retained derivation,
current non-expired signal, and retained signal-revision counts. Active projection-set lineage is
public in inspection, statistics, and rebuild reports; inactive or interrupted set rows contribute
to the stale count until bounded cleanup completes. Statistics and inspection expose exact,
caller-bounded physical scan work under one shared cancellation/row/byte option and fail rather than
return partial diagnostics. Native count aggregates remain outside that transferred-row measure.
Both fence private metadata-only commits as well as logical revision changes. Inspection reads the
current durable space generation and rejects reset/recreate drift instead of mixing it with cached
facade metadata. `analyze` adds access/view-bounded current
signal state and namespace counts without feeding them to PageRank or findings. Byte/quota and cost
telemetry are not public alpha fields.

Any future durable trace plane MUST be opt-in, scope-filtered before use, bounded by explicit
retention, redacted at the provider boundary, and separated from both canonical evidence and the
minimal semantic change journal. It MUST record the input revision, temporal view, candidate/result
ids, per-channel contributions, algorithm/model lineage, and application outcome without retaining
credentials or unnecessary raw prompts. Trace feedback may influence relevance only through an
explicit retrieval policy; it cannot reinforce factual support merely because an item was returned
or used.

The package independently identifies:

- package API version;
- canonical schema version;
- export format version;
- ontology id/version;
- fact derivation schema/provider lineage;
- canonical rule/support identity, version, premises, and input/recorded revisions;
- lexical, summary, and embedding projection generation;
- active projection-set id, canonical source revision, activation time, and operation lineage;
- embedding provider/model/version/dimension identity;
- signal producer/version, input/recorded revision, basis view, and immutable logical revision.

Projection generations can be rebuilt without changing canonical export meaning. Canonical schema
mismatch fails closed unless `open({ migrate: true })` can follow the exact additive `5 -> 6 -> 7`
registry. Each step has an immutable SHA-256 declaration checksum and commits its version change and
audit checkpoint together under schema/logical/private-revision guards, so reopen resumes from the
first uncommitted step and concurrent opens converge. Unknown or changed history, schema 4, newer
schemas, ontology mismatch, row-transforming upgrades, and downgrade still fail closed. The additive
chain has no exclusive owner: every opener must opt in, but independent opted-in clients may help it
forward. Same-step contenders converge on one checkpoint, and owner-page death after a complete
step leaves a valid cursor that a fresh opener resumes.

## 13. Performance boundary

Signal-basis validation uses a bounded addressed temporal/provenance closure and does not enumerate
unrelated records. Destructive reset necessarily accounts for its complete affected-ID report, but
uses native preflight counts plus public exact row/byte ceilings and 16-row keyset scans rather than
whole-space export. Checked point reads similarly bound complete
entity/fact provenance assembly and report exact admitted work. Reset first uses native counts and scans only
episode/entity/fact/projection report rows; after a stable revision check, its actual whole-space
delete remains one storage-native transaction. Canonical ingestion, inference-context assembly, and
affected truth maintenance use bounded plans. Projection rebuild, recall, search,
neighborhood, entity/fact/residual episode browse,
snapshot, analysis, direct derivation/correction/retraction, merge/split governance,
single/group/signal-selected episode soft deletion, targeted hard purge, format-v4 export, and
integrity verification instead use bounded 16-row canonical scans. Native current/valid-at/history
episode pages retain their smaller `limit + 1` path under the same admission contract.
Snapshot, analysis, checked point reads, ingestion, derivation, correction, retraction, entity reconciliation, episode
deletion, hard purge, signal basis validation, and reset expose exact admitted
row/stable-JSON-byte work. Integrity additionally reports and caps
active-derivation graph work and retained issue details. It checks every physical canonical,
journal, projection, and sync row through 16-row keysets, using one-row pages for potentially 16 MiB
sync chunks, and never falls back to whole-space export. Issue truncation does not truncate checking
or hide the overall failure state. The check remains O(n), and its stable JSON bytes are not a heap
measurement or database-work bound. Hard purge must scan complete semantic/signal journals and
opaque operation diagnostics, but does so in admitted keysets; its final canonical erase is one
bounded atomic commit, while sync-pack reclamation is streamed separately. Whole-memory portability
is chunked and resumable. The named page-native episode path bounds rows transferred/materialized to
`limit + 1`; residual browse scans a complete but explicitly row/byte-bounded universe on every
page. Recall admits canonical and returned projection rows and builds graph adjacency in linear
admitted work. Descending IndexedDB execution still scans via a Surreal table iterator. Structural
analysis and graph retrieval are facade-bounded but are not storage-pushed large-corpus algorithms.
Vector search uses exact cosine ordering without an ANN index.

Statistics no longer use whole-space export. Simple cardinalities execute as native storage
aggregates; latest signal/derivation state, distinct conflict groups, stale projections, and provider
calls use advancing keyset pages capped at 1,000 records. Inspection uses the same bounded approach
for stale projections and a native pending-operation count. This is a facade-memory/transfer bound,
not an O(1) or database-scan latency guarantee: the remaining metrics are O(n), and mixed-direction
latest-version scans may use the IndexedDB table iterator.

Signal browse, prior-version lookup, and direct signal withdrawal/purge also no longer materialize
whole-space arrays. They use 16-record keyset pages, retain at most the requested lightweight page
metadata, fetch output values one at a time under an exact 16–64 MiB response ceiling, chunk full-set
commitments, and count purge revisions before one atomic key-range deletion. These paths remain O(n)
where exact totals/latest-per-key selection require it. Signal-target soft deletion and hard purge
carry every scanned physical signal revision into bounded targeted governance planners. Hard purge
additionally uses indexed signal target/basis and merge-source closure plus bounded complete
journal/diagnostic scans.

The alpha therefore makes no corpus-size, latency-percentile, memory-footprint, IndexedDB-quota, or
main-thread responsiveness guarantee. Production work MUST define named corpus sizes, graph
densities, browser/device versions, warm/cold conditions, provider behavior, and measurable stop
conditions before claiming interactive performance.

## 14. Evidence and release posture

### 14.1 Current evidence surfaces

The current suite comprises 15 non-browser files with 258 tests; including twelve Chromium
acceptance cases, it comprises 16 files with 270 tests.

| Area                             | Evidence                                                                                                                                          | Boundary                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Headless contract                | Root-entry and public-contract tests                                                                                                              | Does not prove real extension/Copilot integration.                                                      |
| Construction ownership           | Closed one-pass `createMemory` root; detached ontology, disclosure limits, ingestion/retrieval profiles, and timeout; early capability/profile admission; source accessor tests, direct/worker SurrealDB, and installed Node/browser consumers. | Captured storage/provider/policy/clock/id/token-counter/error capabilities deliberately remain live behavior-bearing references. |
| Facade invocation ownership      | Exhaustive closed one-pass snapshots for open metadata/flags; management, point-read, retrieval, feed, signal, archive, and integrity options; standalone point access; and journal registration, acknowledgement, retirement, browse, and compaction. Source accessor/no-storage probes, direct/worker SurrealDB, and installed Node/browser consumers prove immediate nested mutation and post-call signal-property replacement cannot retarget work. | The captured `AbortSignal` and injected provider/storage/peer/listener capabilities intentionally remain live behavior-bearing objects. |
| Public output ownership          | Returned open/episode/report/replay JSON is detached from caller/provider input, storage, and cached state; each event listener receives an independent payload. Source, direct/worker SurrealDB, and installed Node/browser consumers mutate nested results and the first listener without changing persistence or a later observer. | Outputs are caller-mutable copies, not recursively frozen values; injected behavior-bearing capabilities remain live. |
| Canonical and temporal semantics | Deterministic ingestion, retrieval, governance, and security tests                                                                                | Small fixtures, not population-scale quality evaluation.                                                |
| Canonical ingestion planning     | Point/16-row indexed identity, reconciliation, affected truth/projection closure; public row/byte/node/edge work; 17-episode unrelated corpus; separately bounded 16-row inference-context and automatic post-canonical projection scans; exact row/byte `N`/`N-1`, no-export/no-unlimited-query, direct/worker, and packed-consumer evidence; actual page termination after durable acceptance with live-owner protection, interrupted-operation recovery, and explicit retry across all engine pairings | Accepted input and canonical truth intentionally remain durable after later projection-scan failure; reports do not measure provider execution, engine iterator work, heap, or an in-flight provider batch; page death is paused before canonical transaction, so mid-transaction engine/process kill and population benchmarks remain open. |
| Correction safety                | Indexed row/byte/graph admission and exact work, unchanged revision after one-row rejection, injected commit failure with no partial correction, and retry-time rejection of newly hidden support | Adapter fault injection and independent-facade race, not persistent-engine kill proof.                  |
| Entity reconciliation            | Point/16-row indexed visibility, whole-identity authority, exact-scope journal disclosure, related-fact and projection closure; exact work; one-row unchanged-revision rejection; 256-fact no-export corpus; stale-plan race; direct/worker and packed-consumer merge/split | Atomic bounded commit and independent-facade race are covered; abrupt process kill, independent adapter contention, and population benchmarks remain open. |
| Episode deletion                 | Single/group and signal-selected point/16-row filtered selection, provenance, support, and projection planning; exact work; exact native group preview/cursor-bound apply with shared selector and deterministic empty behavior; one-row unchanged-revision rejection; frozen preview expiry; 256-fact no-export corpus; request-bound replay; and independent-client same-preview one-winner atomicity | Alias episode filtering has no dedicated database index; no persistent-engine kill proof. |
| Hard purge                       | Point/16-row selection and erasure closure; 1,000-ID predicate chunks; indexed signal basis and merge provenance; exact work; one-row pre-marker rejection with unchanged revision; no-export initial/recovery proof; persisted recovery ceilings; complete derivative-scope authorization; content-free marker/operation closure; direct/worker execution; separate-client post-target-read late-signal race proving no stale marker/operation or erasure, followed by explicit replan and dependency erasure across all engine pairings; distinct same-snapshot purge-ID contention with one residue-free revision-CAS loser; live-marker rejection naming the winning operation before contender planning; explicit loser replan/retry; one-winner same-revision recovery claim; live-owner no-steal; and actual owner-page termination after marker creation, between sync-metadata batches, before final canonical commit, and after a recovery claim across all engine pairings, with complete metadata/canonical erasure, one journal transition, integrity, and replay denial | Complete journal and opaque diagnostic scans remain O(n); the bounded final canonical mutation is atomic rather than multi-commit streamed; physical death during that final transaction, browser-process death, and population benchmarks remain open. |
| Scope security                   | Mixed-scope identity, pre-ranking, semantic projection, export, merge, purge, and history tests                                                   | Host authentication remains out of scope.                                                               |
| Projection-set cutover           | Hidden durable staging; exact active-set retrieval; canonical-source fencing; one-target-at-a-time full scans; sparse targeted dependencies; public input/output row/exact-byte work; exact `N`/`N-1` no-export recovery; native stale counts; 16-row cleanup; direct/worker and packed-consumer execution; direct/direct, worker/worker, and mixed-client one-winner single-flight admission, live-owner rejection before planning/staging, uninterrupted old-set recall, actual owner-page death after durable staging, interrupted recovery, unbound-loser retry, and complete inactive-row reclamation | Provider batches remain an in-flight allocation; physical mid-transaction process/database-worker kill and named-corpus qualification remain open. |
| Additive schema migration        | Explicit schema-5/6-to-7 opt-in, ordered declaration checksums, atomic version/audit checkpoints, interruption resume, concurrent-open convergence, checksum/downgrade rejection, direct/worker fresh-connection persistence, independent direct/direct, worker/worker, and mixed same-step convergence, plus actual owner-page death after the first complete transaction with fresh-client continuation and reopen persistence | No schema-4 path, downgrade, ontology migration, row rewrite, physical mid-transaction process/database-worker kill proof, or backup/support-window policy is claimed. |
| Retrieve/select/snapshot/analyze | Closed one-pass request ownership with immediate authority/filter/anchor/seed/ID/limit mutation, unreadable-accessor, unknown-field, source, direct/worker IndexedDB, and installed Node/browser proof; nested selectors; revision-bound cursors; Unicode-stable page-native episode keysets; 16-row exact row/byte admission and work reports for recall, search context, neighborhood, residual browse, snapshot, and analysis; linear indexed graph expansion; and independent graph/CPU budgets for analysis. Exact `N`/`N-1`, private-row pushdown, no-export, unchanged-revision rejection, packed-consumer, and direct/worker IndexedDB evidence cover the physical contracts. Deterministic two-page post-query races prove snapshot, recall, browse, neighborhood, analysis, and bounded archive export reject cross-tab logical mutation in direct/direct, worker/worker, and mixed modes. | Residual browse, recall, snapshot, and analysis remain complete O(n) facade algorithms inside explicit ceilings; stable JSON bytes are not heap/database work; optimistic brackets are not database snapshots; population benchmarks remain open. |
| Checked point reads              | Episode/entity/fact/derivation `read`; closed one-pass authority/ID/limit snapshots; revision/time lineage and exact scan work; 16-row provenance keysets; distinct support-episode point loads; exact row/byte `N`/`N-1`; no-export and no-unlimited-relation-query assertions; value-only `get*` sugar; source, direct/worker, packed-consumer, and deterministic two-page logical-race execution | Complete entity/fact provenance remains O(n) in the addressed record's support degree; stable JSON bytes are not heap/database work; the optimistic bracket is not a database snapshot. |
| Statistics/inspection            | Native filtered count pushdown; caller-lowerable exact cumulative row/stable-byte admission and `PhysicalScanWork`; cancellation including closed inspection; logical/private-metadata and current-generation fencing; 1,000-record keyset pages for latest/distinct/summed metrics and stale projections; exact `N`/`N-1` and a 1,001-row adversarial fixture prove continuation and reject whole-space export; direct/worker SurrealDB plus packed-consumer execution; independent-tab reset/recreate fencing; deterministic two-page metadata-only checkpoint overlap rejects in-flight statistics and inspection without changing logical revision across all engine pairings | Remaining scans and native aggregates can be O(n); stable bytes are not heap/database work; mixed-direction pages may use a table iterator; no named-corpus latency benchmark. |
| Integrity verification           | Complete physical-row validation through 16-row keysets and one-row sync-chunk pages; exact row/stable-byte and active-derivation node/edge admission; bounded or summary-only issue details with complete failure counts; no-export, one-row unchanged-revision rejection, metadata-race, malformed-row truncation, in-memory, direct/worker, packed-consumer, and deterministic two-page logical-race proof | Trusted whole-space O(n) diagnostic; stable bytes are not heap/database work; optimistic fencing is not a database snapshot; no named-corpus latency proof. |
| Semantic changes                 | Closed one-pass feed-page authority/cursor/limit snapshots; access-bound pagination, feed-discriminated v2 cursors, exact-scope partitions, storage invariants, import freshness, reset invalidation, purge scrubbing, stateless-cursor, registered-consumer, or expert-revision bounded compaction; local monotonic checkpoint registration/acknowledgement, explicit retirement tombstones, metadata-revision pagination, epoch-guarded acknowledgement/compaction races, compaction-request snapshotting, deterministic two-page mid-assembly logical-race rejection, direct/worker reopen persistence, and same-batch direct/direct, worker/worker, and mixed-client registered compaction contention with one atomic winner, retryable loser, cross-journal non-interference, and old-cursor rejection | No lease/automatic retirement, tombstone reclamation or identifier reuse, cross-device registry, automatic retention, or browser-process/database-worker mid-commit proof. |
| Signals                          | Closed one-pass browse/put/delete request snapshots with unknown-field, unreadable-accessor, and immediate nested-mutation proof; revision/basis CAS; storage-neutral addressed temporal/provenance closure with 1,000-value predicates, 16-row keysets, exact physical row/byte work, unrelated-corpus invariance, current-merge and known-at parity, and `N`/`N-1` no-mutation proof; 16-record keyset current/history scans with identity/access pushdown; exact total and 16–64 MiB canonical page bounds; non-empty-only 1,000-ID chunked full-set commitments; addressed-key writes; native revision-counted atomic key purge; a 1,001-key adversarial fixture; direct/worker and packed-consumer execution; two-page direct/direct, worker/worker, and mixed-engine one-winner put CAS plus same-preview withdrawal/purge, retryable losers, exact journal actions, no loser residue, and explicit put retry convergence; target-selected canonical soft-delete/hard-purge work, integrity, and dependency closure; disjoint soft-delete one-winner contention with residue-free rebaseline/retry; and both deterministic winner directions for soft delete versus hard purge from one cursor across all engine pairings | A high-degree merge/support/incident-fact closure and exact totals/latest selection can remain O(n) in the addressed degree or signal population; mixed-direction IndexedDB scans may use a table iterator, and hard purge still scans complete admitted journals/diagnostics; stable JSON bytes are not heap/database work; no population benchmark, abrupt-kill, archive/import, expiry scheduler, automatic action engine, or retrieval plug-in. |
| Destructive reset                | Native report-row preflight counts; 16-row episode/entity/fact/projection report scans; exact row/byte `N`/`N-1` no-delete proof; revision-guarded whole-space transaction; no-export, direct/worker, packed-consumer, and independent-tab stale-incarnation/reopen execution; deterministic writer-first conflict/preserved-write and reset-first `space_not_found`/no-resurrection schedules across direct/direct, worker/worker, and mixed clients | The admitted affected-ID report is complete O(n); the delete is deliberately all-or-nothing, not resumable; physical mid-transaction death, browser-process death, and population-scale proof remain open. |
| Signal changes                   | Baseline handoff, feed-discriminated access-bound cursor scans, action and partition disclosure, semantic separation, storage invariants, purge scrubbing/invalidation, stateless and registered minimum-watermark bounded compaction; local monotonic checkpoint registration/acknowledgement, explicit retirement, metadata-revision pagination, epoch guarding, direct/worker reopen persistence, deterministic two-page mid-assembly logical-race rejection, installed mixed-engine observation of the persisted floor, and direct/direct, worker/worker, and mixed-client proof that a concurrent acknowledgement invalidates a registry-derived compaction without floor movement, survives immediate acknowledging-page termination, and then permits one atomic registered-compaction winner with a retryable loser, cross-journal non-interference, convergence, and old-cursor rejection | No lease/automatic retirement, tombstone reclamation or identifier reuse, cross-device registry, signal archive/import, or browser-process/database-worker mid-commit proof. |
| Maintained derivations           | Exact-revision premise validation; immutable/current logical revisions; indexed 16-row positive-cycle and affected-support closure; public row/byte/node/edge admission limits with exact work reports; independent support and reactivation; bounded 1..64-member atomic multi-head activation against one pre-batch state; recursive invalidation; single withdrawal plus strict selector-based 1..1,000-support atomic rule/version retirement; exact non-empty preview cursors binding selector/access/incarnation/revision/support digest; source correction/single/group deletion/retraction; hard-purge closure plus replay-payload scrubbing; integrity and archive/import. A 256-fact unrelated corpus rejects whole-space export, every limit fails before mutation, invalid later batch members and aggregate-work breaches leave no earlier-member residue, duplicate semantic/id/cardinality-one conclusions and combined cycles fail atomically, accessor snapshots are stable, and one-row correction/retraction/single/group deletion rejection leaves revision unchanged. Direct/worker SurrealDB and packed consumers prove bounded derive/batch/replay/reopen/preview/single-and-batch-withdraw/reactivate/correct/retract/delete. Separate direct/direct, worker/worker, and mixed clients prove preview logical-race rejection, same-preview one-winner single and complete two-conclusion activation/retirement batches, residue-free losers, bound-winner replay, explicit unbound-loser re-evaluation without duplicate support/change, and atomic cascading invalidation with integrity. | Current-premise positive acyclic writes only; a batch is not a rule scheduler or iterative fixpoint and cannot consume its own outputs. No negation, aggregation, existential identity creation, temporal applicability basis, physical mid-transaction crash, large-graph, archive-remap, or population-scale latency proof. |
| Connection lifecycle            | A reference is acquired only after connect/use/schema/backfill/index bootstrap; direct and worker completion-loss schedules cover physical connect, schema bootstrap, failed-open cleanup, and final close. Partial setup and failed final close retain zero-reference cleanup ownership, block fresh connection work until idempotent close succeeds, preserve failed-open reference ownership, keep facade close/retry live, and reuse the same capability afterward. | Deterministic post-execution completion loss is not browser-process/database-worker death; repeated permanent engine-close failure can only remain explicitly pending, not be force-reclaimed by JavaScript. |
| Raw SurrealQL                    | Nominal application storage with no raw method or later elevation path; frozen storage/admin pair construction with an explicit dangerous acknowledgement; one-pass bounded pre-scheduler request/binding snapshots; JSON-constrained result tuple declarations; direct/worker target confirmation, bound hostile values, custom-table multi-statement execution, incremental SDK-frame scalar/row admission before retention, exact response-byte/node rejection, in-band statement failure, non-retryable `responses_received` reconciliation after a committed mutation exceeds response admission, non-retryable unknown-call outcome marking, and deterministic post-execution completion loss proving shared-driver admin/facade/cached-open poison, reference-counted final-close recovery, failed-open ownership preservation, closed rejection, public declaration, origin-wide persistent scheduling, and packed-consumer execution | Capability separation is dependency injection, not authentication or same-origin code isolation; the result tuple generic is an unchecked TypeScript assertion, not runtime schema validation; database-admin capability only; one engine chunk or individual row can materialize before admission; the installed SDK has no physical query cancellation, and arbitrary SQL has no generic resume point, so callers use native `TIMEOUT` plus deterministic keyset pages/application cursors; no scope/policy filtering or safety claim for raw `tm_*` mutation; deterministic post-execution lock-completion loss is not browser-process/database-worker mid-commit proof. |
| Transaction failure semantics   | Direct and worker IndexedDB force a schema failure after an earlier valid generated-transaction statement; both return `transactionOutcome: 'rolled_back'`, retain no probe row or logical/canonical/private revision, reuse the same connection for a guarded commit, and clean up without residue. Missing statement responses are conservatively non-retryable `unknown` outcomes with `requiresReopen`; generated transactions and raw queries poison their shared physical driver before queued calls can start. A direct/worker post-execution completion-loss schedule executes a revision-guarded space deletion, proves both shared facades and cached open remain fenced across a partial close, proves the retained error and nested diagnostics cannot be mutated by an observer, then proves final close/reopen observes the committed deletion and only explicit recreation restores revision zero. Separate injected post-commit response loss proves facade and queued-write fencing without secondary settlement, in-flight direct-read rejection retained across close/reopen, zero-read post-fence inspection, fresh owner incarnation on reopen, request-bound replay, fresh-only identity sealing, interrupted-ingestion recovery, and explicit post-reset recreation. | Browser-process/database-worker death during `COMMIT`, quota exhaustion, and reconciliation against a genuinely killed persistent engine remain unqualified. |
| Browser persistence              | Real Chromium against direct and worker SurrealDB WASM engines, including privileged raw-query frame-admission probes and immediate nested signal plus canonical correction/reset/import/rebuild request mutation snapshots; exhaustive open/management/point/integrity/journal option ownership plus detached public outputs/per-listener events; bounded canonical ingestion, pre-provider inference-context and post-canonical projection rejection/reporting, checked point reads, signal-basis validation, and destructive reset; bounded projection rebuild, recall/neighborhood/residual/native browse, and integrity rejection/reporting; bounded merge/split with unchanged-revision limit rejection plus indexed active/inactive selection; bounded derivation activation, exact retirement preview, single/batch withdrawal, and reactivation with reopen persistence; bounded fact correction/retraction, single-episode deletion, and exact group-deletion preview/apply; persisted derivations, semantic/signal journals, local consumer checkpoints, and signals; bounded atomic signal-selected soft delete/withdraw; exact signal-target selection purge; dependency closure; purge replay/scrubbing; both registry-derived journal compactions; independent whole-memory replica transfer; checkpoint-payload compaction retained across reopen; stable origin-wide physical-call arbitration plus private facade-owner liveness and fail-closed no-lock open; actual page termination after accepted ingestion, committed journal acknowledgement, projection hidden staging, one complete additive-migration step, every durable hard-purge application/recovery phase, one durable sync-apply diff, and one durable inverse rollback diff; separate same-origin pages and clients prove guarded signal put/withdraw/purge contention, exact filter-selected same-preview group-deletion contention, signal-target disjoint soft-delete contention and both soft-delete/hard-purge winner directions with residue-free rebaseline semantics, destructive-reset/canonical-writer contention in both winner directions, projection single-flight admission/live-owner rejection/old-set recall/interrupted recovery/inactive reclamation, additive-migration same-step convergence/between-step continuation, hard-purge pre-marker stale-plan rejection and explicit dependency-aware replan, distinct same-snapshot purge-ID one-winner contention plus live-marker pre-planning rejection and explicit retry, derivation create/replay/re-evaluation/preview-race/same-preview single-and-batch-withdrawal/cascade, acknowledgement-versus-registered-compaction epoch rejection, registered same-batch contention, and cross-journal non-interference for both journal compactors, one-winner same-session sync activation with residue-free replay, incarnation fencing, logical-race rejection for snapshot/recall/point read/browse/neighborhood/analyze/export/integrity/signal browse/both feeds plus episode-deletion preview, and metadata-race rejection for stats/inspection across direct/direct, worker/worker, and mixed, with installed mixed write/feed/reset proof | Tested terminations occur only before or after complete physical transactions. No browser-process or database-worker mid-commit kill, background suspension, quota, corruption, or broad independent-context mutation proof. |
| Portability                      | Revision-bracketed deterministic format-v4 export/import; closed exact envelope/ontology/record/assertion schema with public merge/count/manifest wire types and explicit merge projection; all-section unknown-property, malformed optional, cross-space, ordering, million-node, and pre-target-read rejection; complete recomputable episode identity including explicit assertions; remap rehashing; 16-row canonical-only scan with work, exact document, preparation, and aggregate-node bounds; derivation closure; direct/worker and packed-consumer proof; additive canonical-schema migration proof; bounded resumable whole-memory sync bundles | Selective archive intentionally remains one bounded materialized remapping document; canonical-only digest is not an envelope signature; archive-format/ontology migration policy remains open. |
| Replica synchronization          | Closed one-pass snapshots for the complete sync control plane with immediate nested mutation, single-read accessor, unknown-field/no-storage, direct/worker, and installed-consumer proof; content-addressed checkpoint DAG; independently checksummed byte/record/node-bounded chunks with exact pre-driver index packs; aggregate receiver/merge admission; scope/request/operation-bound pinned resume; ancestry/fast-forward/three-way merge; logical-and-metadata-snapshot-fenced bounded offline bundle export and peer-backed import; metadata-snapshot checkpoint and live session inventory; paged durable conflicts and explicit resolution; transitive purge dominance; partial-staging cleanup; fail-closed apply, qualified rollback, and reopen recovery; guarded checkpoint-payload plus terminal-session-detail compaction with retained headers/idempotency records, expired-base reseed failure, crash-marker recovery, in-memory fault injection, direct/worker IndexedDB persistence, atomic active-session/owner-operation creation, atomic completed-operation/HEAD/session publication, deterministic live-owner no-steal, one-winner same-session activation with retryable residue-free loser and terminal replay, and actual owning-page termination after durable forward and inverse rollback diffs with peer-independent completion across direct/direct, worker/worker, and mixed engines | Concrete authenticated/encrypted bundle/transport adapters, automatic retention and checkpoint/session-header GC, engine-overhead quota/fuzz/hostile-peer corpora, physical mid-transaction termination, and population-scale validation remain unqualified. |
| Package artifact                 | Clean consumer installs the tarball; checks exports/docs/license/types plus the byte-identical deterministic CycloneDX 1.6 SBOM, its complete resolved npm graph, 337-component locked embedded Cargo inventory, distinct BUSL change dates, and exact WASM hash; executes fail-closed bounded ingestion context/canonical/projection planning, point reads, signal basis and immediate facade/signal/core-read/mutation/sync request mutation, output/listener mutation, reset, projection/retrieval/integrity/governance, preview-bound atomic rule-set retirement and grouped episode deletion, archive restoration, signal actions, registered compaction, and sync in Node plus direct/worker IndexedDB; repeats guarded signal CAS/retry, feed-floor, and reset fencing across two installed mixed-engine pages; and verifies the WASM dependency's pushed source tag, reproducible hashes, and GitHub prerelease asset | Vite 8 + Chromium proof; the standard relationship composition marks unavailable intra-Cargo edges `unknown`; current Cargo advisory matches therefore establish inventory presence, not WASM reachability; not npm publication, broad bundler support, signed provenance, or vulnerability clearance. |
| CI                               | Frozen install, Chromium install, lint, format check, typecheck, tests, build, deterministic SBOM freshness, npm production audit, checksum-pinned OSV Scanner `2.5.0` over locally downloaded/offline advisory databases, clean-consumer package verification, immutable action revisions, weekly scheduled re-scan, and weekly npm/action dependency proposals | Ten inherited Cargo advisory classes have explicit exceptions expiring 2026-08-23 and remain publication blockers; no release signing, signed provenance, vulnerability attestation, or live registry verification. |

The versioned `golden-v1.json` file is a deterministic case-to-test index. It is not yet a full
input/output gold corpus with quality metrics, generative property tests, human review, or benchmark
thresholds.

### 14.2 Licensing and distribution status

Temporal Memory's own source and package declare Apache-2.0. The package allowlist includes README,
LICENSE, CHANGELOG, built JavaScript, declarations, and `dist/sbom.cdx.json`;
`publishConfig.access` is public. The
repository also provides contributing and security-reporting guidance.

The Astrale WASM adapter's JavaScript is Apache-2.0, but its embedded
`surrealdb-core`, `surrealdb-types`, and `surrealdb-types-derive` 3.0.5 components are BSL 1.1 with a
2030-01-01 change date, while `surrealdb-protocol` 0.8.3 is BSL 1.1 with a 2029-09-17 change date.
The WASM candidate declares `SEE LICENSE IN LICENSES.md`; the reference runtime therefore is not
wholly open source before the applicable change dates.
SurrealDB's
[official licence FAQ](https://support.surrealdb.com/en/articles/11541883-frequently-asked-questions)
says
embedded application use is permitted while offering a commercial hosted database service is
restricted. The operative BSL texts and their definition of “Database Service” control. Approving
that mixed-license boundary remains a release decision and blocker.

The candidate's browser and clean packed-artifact gates pass, and the exact source commit, source
tag, reproducible hashes, and GitHub prerelease tarball are public. Each Temporal Memory build also
emits a timestamp-free, path-free CycloneDX 1.6 SBOM with a content-derived serial. It represents the
complete resolved production npm graph and the complete shipped locked Cargo inventory; it
marks unavailable intra-Cargo edges as `unknown` with a standard CycloneDX relationship composition
instead of inventing them. These controls remove the ephemeral local
dependency, but do not assert npm availability, production support, signed provenance,
vulnerability clearance, or mixed-license approval. Npm publication, dependency
vulnerability/license approval, release automation, and supported-version policy require
independent delivery evidence.

The 2026-08-09 dependency scan is deliberately two-layered. `pnpm audit --prod --audit-level high`
reports no known npm advisories across the 49-package production workspace lock closure. OSV Scanner
`2.5.0` recognizes 344 packages in the emitted SBOM and, using downloaded databases in offline mode,
matches ten distinct advisory classes across nine components in the inherited Cargo inventory. Two
are unmaintained-crate notices (`bincode`, `paste`); seven have newer fixed versions (`ammonia`
twice, `anyhow`, `crossbeam-epoch`, `event-listener`, `rand`, and `time`); the `rsa` timing advisory
has no patched version. Because the upstream inventory omits intra-Cargo relationships and affected-
function reachability, presence cannot honestly be promoted to either exploitability or clearance.
CI permits only those named findings through short-lived exceptions expiring 2026-08-23, fails on a
new or expired finding, and does not transmit the candidate SBOM to an advisory query service.
Refreshing the WASM fork plus reachability/risk review remains a publication blocker.

## 15. Production gates

The alpha MUST NOT be described as stable or production-ready until all of the following are met:

1. The remaining public API, error-model, compatibility-window, and supported-upgrade decisions are
   ratified.
2. Canonical row-transforming and ontology migrations are resumable, restartable, and tested
   against downgrade; the implemented additive schema-5/6-to-7 chain now has same-step independent
   convergence and owner-page death between complete steps, but still needs physical
   mid-transaction process/database-worker kill qualification and a ratified
   supported-version/backup policy.
3. Browser-process restart, termination during a physical database transaction, background
   suspension, quota exhaustion, and corruption recovery have adversarial browser evidence. The
   implemented runtime-owner lease already prevents a second opener from stealing live ingestion,
   hard-purge, or sync-apply work; actual owning-page termination after durable ingestion acceptance
   at every durable hard-purge application/recovery phase, and after one committed forward or inverse
   rollback sync diff has direct/worker/mixed browser proof. Ingestion completes by explicit retry;
   hard purge first claims one recovery owner and resumes forward; sync apply resumes the received checkpoint and
   rollback restores the retained local checkpoint without the original peer. Reset invalidation
   and both reset/canonical-writer winner directions, guarded signal
   creation, same-preview signal withdrawal/purge, hard-purge pre-marker late-dependency rejection and
   explicit replan, derivation create/replay/re-evaluation/withdrawal with cascading invalidation,
   same-batch semantic/signal journal compaction contention, the listed complete-read logical-race
   brackets, and statistics/inspection metadata-race rejection now have independent
   direct/worker/mixed-tab proof. Distinct hard-purge starts also have one-winner marker contention,
   live-marker pre-planning rejection, residue-free losers, and explicit retry proof across the same
   pairings. Signal-target canonical actions have disjoint soft-delete rebaseline/retry plus both
   soft-delete/hard-purge winner directions with one complete winner and no loser residue across the
   same pairings; other governance mutations still require independent-context qualification.
   Projection rebuild now has one-winner admission, live-owner rejection before
   staging, old-set recall, actual owner-page termination after durable staging, interrupted
   recovery, and complete inactive-row reclamation across the same pairings. The supported
   optimistic consistency boundary is ratified; physical termination during the SurrealDB
   activation transaction remains part of the broader process-kill gate.
4. Hard purge extends the implemented pre-marker late-dependency fence, distinct one-winner starts,
   post-marker owner-death recovery, and one-winner recovery claim with physical-final-commit crash
   evidence; upgrade policy addresses legacy completed markers that predate replay hashes.
5. Large-corpus reads use bounded storage scans or pushdown and meet named latency/memory targets;
   vector indexing is selected from measured need.
6. The now-bounded, closed-schema selective format-v4 export/import gains an explicit
   archive-format/ontology migration policy without duplicating the sync-bundle streaming protocol;
   replica sync meets named large-corpus transfer/reconciliation memory, latency, disk-amplification,
   quota, and hostile-peer targets; the manual payload-compaction primitive gains a ratified
   peer-offline/reseed policy, automatic retention orchestration where appropriate, and bounded
   checkpoint/session-header collection beyond the implemented terminal-detail reclamation.
7. Any future storage sizing, pressure, maintenance-stage, or provider-cost observability has
   defined semantics and evidence before entering the public contract.
8. Retention defaults, automatic maintenance policy, and the encryption-at-rest threat model are
   decided.
9. A real Chrome extension and Copilot consume the package without physical storage knowledge.
10. A representative gold corpus, property/invariant suite, benchmark matrix, and human-reviewed
    quality thresholds replace case-name coverage as evaluation evidence.
11. The implemented bounded signal and maintained-derivation planes gain named large-corpus targets
    plus crash evidence. Direct signal put/withdraw/purge and target-selected canonical
    soft-delete/hard-purge actions now have independent-client contention evidence. Maintained
    single and bounded multi-conclusion derivation creation, replay/re-evaluation, single and
    selector-based batch withdrawal, and cascading invalidation also have independent-client
    evidence; iterative rule-set evaluation,
    temporal-basis, and archive-remap schedules remain separate gates.
    Signal portability/retained-history policy and any
    retrieval-policy integration remain explicit; derivations need temporal-applicability or
    iterative fixpoint semantics only if adopted. Any durable trace or calibration plane has scope
    non-interference, revision lineage, retention/deletion semantics, and explicit separation from
    factual support; both implemented local registries still require a tombstone-reclamation
    decision, cross-device checkpoint boundary, and browser-process/database-worker mid-commit
    evidence around acknowledgement and compaction. Application-boundary acknowledging-page
    termination is covered. Explicit retirement without clock expiry is the current safety policy;
    revisit it only with an incarnation-safe protocol that cannot silently strand an offline
    consumer.
12. Dependency/license approval, resolution or explicit approval of every inherited Cargo advisory,
    release signing/provenance, registry publication, and post-release support are evidenced. The
    deterministic build, packed-artifact SBOM, npm audit, offline OSV gate, short-lived reviewed
    baseline, and update proposals are implemented; they are not vulnerability clearance or an
    organizational SBOM ingestion/retention policy.

## 16. Future-compatible capabilities

The architecture may later support signed/encrypted sync transports, collaborative or
server-hosted memory control planes, local model bundles, encrypted searchable storage, community summaries,
automatic consolidation, ontology proposals with approval, multimodal extraction, federation,
alternative storage engines, remote execution, protocol adapters, user-facing graph management,
signal-aware opt-in retrieval policies, and richer rule execution with stratified negation,
aggregation, temporal applicability, or iterative fixpoint scheduling across atomic activations.
Automatic query-to-seed
selection for personalized PageRank, optional spatial retrieval,
source-section anchors, and adaptive retrieval planning are compatible additions when benchmarked.

Future capabilities MUST preserve evidence provenance, temporal history, space/scope isolation,
provider disclosure control, deterministic destructive semantics, and storage opacity.

## 17. Architectural basis

The product takes conceptual inspiration from Graphiti's separation of episodes, entities,
temporal facts, provenance, ontology, and hybrid retrieval, and from Spectron's coherence,
trace-feedback, calibration, and memory-evolution model. It uses an independent TypeScript and
browser-native architecture.

Primary references:

- [Graphiti repository and conceptual overview](https://github.com/getzep/graphiti)
- [Spectron principles and goals](https://surrealdb.com/docs/spectron/architecture/principles-and-goals)
- [Spectron eight pillars and experiential categories](https://surrealdb.com/docs/spectron/architecture/eight-pillars-and-categories)
- [Spectron coherence, retrieval, and tiers](https://surrealdb.com/docs/spectron/architecture/coherence-retrieval-and-tiers)
- [Spectron tri-temporal model](https://surrealdb.com/docs/spectron/architecture/tri-temporal-model)
- [Spectron traces and memory evolution](https://surrealdb.com/docs/spectron/architecture/traces-and-evolution)
- [Spectron memory categories](https://surrealdb.com/docs/spectron/mental-model/memory-categories)
- [Spectron sessions and turns](https://surrealdb.com/docs/spectron/mental-model/sessions-and-turns)
- [Spectron state and diffs](https://surrealdb.com/docs/spectron/agent-memory/sessions/state-and-diffs)
- [Spectron provenance and traceability](https://surrealdb.com/docs/spectron/mental-model/provenance-and-traceability)
- [Spectron contexts and scope](https://surrealdb.com/docs/spectron/mental-model/contexts-and-scope)
- [Spectron supersession, decay, and forget](https://surrealdb.com/docs/spectron/mental-model/memory-lifecycle)
- [Spectron surfaces, models, and security](https://surrealdb.com/docs/spectron/architecture/surface-security-and-models)
- [Spectron ontology grounding](https://surrealdb.com/docs/spectron/agent-memory/tuning/ontology-grounding)
- [Spectron data model and schema](https://surrealdb.com/docs/spectron/reference/data-model-and-schema)
- [Spectron forgetting](https://surrealdb.com/docs/spectron/agent-memory/operations/forget)
- [Spectron hybrid search](https://surrealdb.com/docs/spectron/agent-memory/retrieve/hybrid-search)
- [Spectron embedded/in-process boundary](https://surrealdb.com/docs/spectron/quickstarts/embedded)
- [SurrealDB JavaScript WebAssembly engine](https://surrealdb.com/docs/reference/javascript/engines/wasm)
- [SurrealDB embedded engines](https://surrealdb.com/docs/reference/javascript/concepts/embedded-engines)
- [SurrealDB hybrid search](https://surrealdb.com/docs/learn/data-models/vector-search/hybrid-search)
- [SurrealDB full-text index definitions](https://surrealdb.com/docs/reference/query-language/statements/define/indexes)
- [SurrealDB BM25 scoring and ranking](https://surrealdb.com/docs/learn/data-models/full-text-search/scoring-and-ranking)
- [SurrealDB `SELECT VERSION` storage-engine boundary](https://surrealdb.com/docs/reference/query-language/statements/select)
- [SurrealDB changefeeds and `SHOW CHANGES`](https://surrealdb.com/docs/reference/query-language/statements/show)
- [SurrealDB graph paths and idioms](https://surrealdb.com/docs/reference/query-language/language-primitives/idioms)
- [SurrealDB geometry values](https://surrealdb.com/docs/reference/query-language/language-primitives/data-types/geometries)
- [SurrealDB licence FAQs](https://support.surrealdb.com/en/articles/11541883-frequently-asked-questions)

## Final product statement

`@astrale-os/temporal-memory@0.1.0-alpha.1` is a working evaluation implementation of a headless,
local-first temporal graph memory. It provides scoped canonical evidence, fact/evidence history,
exact text/JSON evidence anchors and citations, hybrid recall, revision-bound browse and complete
bounded snapshots, a durable scope-filtered semantic revision feed with guarded compaction,
selector-governed deletion and purge, evidence-backed structural and caller-seeded personalized
PageRank analysis with bounded physical scans and explicit work budgets, scoped and
revision/basis-bound non-epistemic signals for downstream algorithms, governed provider calls,
deterministic canonical archives, and an embedded SurrealDB WASM reference adapter. Its API may
change, and the production gates above remain part of the product contract rather than implied
future polish.
