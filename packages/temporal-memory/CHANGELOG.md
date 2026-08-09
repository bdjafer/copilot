# Changelog

All notable package changes are recorded here. The package follows semantic versioning after its
first stable release; prerelease APIs may still change.

## 0.1.0-alpha.1 - 2026-08-04

- Added headless ingestion, scoped hybrid recall, bitemporal views, governance operations, and
  deterministic canonical archives.
- Made format-v4 merge, manifest, and section-count wire shapes exact public types backed by an
  explicit archive projection, and constrained raw-query result tuple assertions to JSON values.
- Replaced canonical ingestion's whole-space truth-maintenance export with point reads and 16-row
  indexed identity, alias-provenance, semantic/cardinality reconciliation, derivation-support, and
  projection-cleanup keysets. Profile, per-call, and batch `workLimits` bound exact stored-row,
  stable-JSON-byte, graph-node, and graph-edge work exposed by `IngestionReport.work`. A
  17-episode unrelated corpus, row/byte `N-1` accepted-only failures, bounded retry, direct/worker
  IndexedDB, and packed Node/browser consumers prove the sparse path.
- Added independently bounded provider inference-context assembly. Profile, per-call, and batch
  `contextScanLimits` guard 16-row facade-visible canonical scans; `IngestionReport.contextScan`
  exposes exact admitted rows/bytes. Row/byte `N-1` failures occur before provider disclosure and
  retry the accepted episode cleanly in source, direct/worker IndexedDB, and packed consumers.
- Added independently bounded automatic post-canonical projection assembly. Profile, per-call, and
  batch `projectionScanLimits` guard 16-row alias/evidence/support/replacement scans and generated
  rows; `IngestionReport.projectionScan` exposes exact work. Row/byte `N-1` settles partial without a
  projection commit while preserving canonical truth, with source, direct/worker, and packed proof.
- Replaced the optional single disclosure sensitivity with a canonical sorted set derived from all
  retained source dependencies. Entity aliases, direct evidence, and iterative transitive rule
  premises now propagate classifications into lexical, summary, and embedding projections plus
  inference and rerank policy requests. Embedding batches partition by exact scope-and-sensitivity
  pairs; a generation cutover makes pre-contract projections fail closed until atomically rebuilt.
  Mixed-classification, two-hop derivation, direct/worker IndexedDB, and golden-corpus tests cover
  storage and provider boundaries.
- Added construction-time `disclosureLimits` for every inference, embedding, and rerank payload.
  Original payloads are exact-byte/token admitted before policy and replacements are remeasured
  before provider execution. Defaults are 1 MiB and 262,144 tokens with hard maxima of 16 MiB and
  4,000,000 tokens; a synchronous provider-aware counter can include tokenizer and prompt overhead,
  while the default uses UTF-8 bytes as a conservative payload-token upper bound. Oversize and
  invalid-counter tests prove provider non-execution and content-free durable diagnostics.
- Hard-raced disclosure-policy authorization against the same operation signal and deadline as
  provider execution. A policy that ignores abort is detached, cannot invoke the provider after a
  timeout/cancellation, and records only a payload-free failed call summary. The stable boundary is
  explicitly cooperative rather than detached for storage commits and sync-peer waits.
- Closed construction-time ownership. `createMemory` now accepts a closed plain root, reads each
  supplied property exactly once, detaches ontology and ingestion/retrieval configuration, and
  captures storage/provider/policy/clock/id/token-counter/error capabilities by reference. Unknown
  or unreadable root fields, malformed ontology/profile values, unsupported retrieval channels, and
  invalid behavior hooks fail synchronously. Source, direct/worker IndexedDB, and installed
  Node/browser consumers prove that accessor or later caller mutation cannot reconfigure a facade.
- Closed caller-supplied operation identity semantics per method. Request-bound methods replay only
  the same normalized request; fresh-only mutations reject all reuse; sync continuation is
  session-bound; settled purge remains non-replayable. `remember` no longer silently ignores a
  supplied unbound ID on episode replay, dry-run import rejects IDs, and reset plus sync
  resolve/abort no longer expose `OperationOptions` where no durable binding can be honored.
- Closed the complete sync control plane at invocation. Checkpoint creation/export, inventory,
  pull/resume, status, conflict inspection/resolution, abort, and checkpoint/session compaction now
  copy one bounded closed JSON request before queueing, local storage, or peer work; standalone
  access and read/operation options are captured at the same boundary. Immediate nested mutation,
  changing accessors, unknown fields, and installed Node/direct/worker consumers prove that access,
  confirmation, identity, strategy, cursor, resolution, cutoff, and limits cannot be retargeted.
  `MemorySyncPeer` and `AbortSignal` remain explicit live capabilities. Captured optional object
  properties whose value is `undefined` canonicalize to absence for idiomatic first-page cursors;
  array/root `undefined` remains invalid.
- Closed the canonical mutation and maintenance control plane at invocation. Ingestion/batch/retry,
  derivation activation and withdrawal, correction/retraction, merge/split, episode deletion,
  hard-purge/reset, import, and projection rebuild now copy one bounded closed JSON request plus
  every JSON option before queueing, recovery, hashing, provider, or storage work. Immediate nested
  mutation, changing option accessors, unknown-field/no-storage probes, direct/worker IndexedDB,
  and installed Node/browser consumers cover the boundary. `AbortSignal` remains live; format-v4
  import pays for one additional bounded document copy and preserves archive-specific failures,
  while large/resumable transfer remains on sync bundles.
- Made invocation ownership exhaustive across the public facade. Open flags/metadata, management
  and integrity limits, point-read convenience access/options, retrieval/feed/signal/archive
  options, and journal-consumer registration, acknowledgement, retirement, browse, and compaction
  now capture one closed value before storage or queue work. Replacing an options object's signal
  cannot switch cancellation authority after the call; the captured `AbortSignal` remains live.
  Source, direct/worker SurrealDB, and installed Node/browser consumers prove the boundary.
- Closed public output ownership too. Facade JSON results remain detached from storage, cached
  state, caller/provider input, and durable replay data; every event listener now receives an
  independent payload. Source, direct/worker SurrealDB, and packed Node/browser probes mutate open,
  episode, operation, and listener values without changing persistence or later observers.
- Qualified the first true independent-context boundary with separate same-origin pages and separate
  IndexedDB/WASM clients. Expanding the matrix exposed that independently scheduled embedded
  transactions could both pass one revision guard; the persistent adapter now holds a stable
  endpoint/namespace/database Web Lock around every physical SDK call and fails closed when Web
  Locks are unavailable. Direct/direct, worker/worker, and mixed-engine races prove that guarded
  signal writes have exactly one winner, a retryable loser, and no partial signal or journal row;
  explicit retry converges both clients. Identical same-preview signal withdrawals and retained-key
  purges likewise have one winner, one retryable loser, exactly one journal action, and no loser
  residue. A hard purge paused after its target read rejects a late signal dependency before writing
  its marker or operation; an explicit retry replans and erases that dependency. A signal-target
  canonical-action matrix pauses disjoint soft deletions and both winner directions of soft deletion
  versus hard purge from one revision. Every schedule has one complete canonical/signal winner and a
  loser without operation, lifecycle, marker, canonical, or journal residue; disjoint work explicitly
  repreviews and retries with its unbound ID, while consumed selections expose no destructive cursor.
  Signal-selected purge marker conflicts now uniformly report `requiresSignalBaseline`. Two rule evaluations
  paused at canonical commit produce one derivation winner and one residue-free loser. Cross-client
  winner replay is stable; explicit re-evaluation with the unbound losing ID records `supported`
  without duplicating support or semantic change. Racing withdrawal writes one tombstone and
  atomically retracts a two-level unsupported conclusion chain while the loser leaves no operation or
  journal row. Deterministic same-batch semantic- and signal-journal compaction races likewise have one
  atomic winner and one retryable loser: only the selected journal and floor change, both clients
  converge, and the other tab's old cursor receives the correct baseline-reacquisition error.
  A destructive-reset/canonical-writer matrix covers both linearized directions across every engine
  pairing: writer-first preserves the complete write and makes reset retryable until an explicit
  full-preflight retry, while reset-first makes the delayed writer fail `space_not_found` without
  recreating operation, lifecycle, canonical, or journal rows. Reset/recreate forces a stale facade
  to reopen. Deterministic post-query gates prove cross-tab writes
  invalidate snapshot, recall, checked point read, browse, neighborhood, analysis, bounded archive
  export, integrity, signal browse, and both journal-page assemblies; checkpoint-only metadata changes
  independently invalidate statistics and inspection without changing logical revision. `mem://`
  still works without Web Locks. The installed tarball repeats the mixed-engine write/feed/reset
  matrix.
- Classified generated-transaction failures by observable outcome. An engine-returned failed
  statement now carries `transactionOutcome: 'rolled_back'`; direct and worker IndexedDB probes
  prove an earlier valid write and all space revisions roll back and the same connection remains
  reusable. A physical call failure with no statement response is non-retryable and carries
  `transactionOutcome: 'unknown'` plus `requiresReopen`; raw admin calls use the analogous
  `queryOutcome` marker and are never automatically replayed. This does not claim database-worker
  kill safety during `COMMIT`. Unknown generated/raw calls now poison the shared driver before
  queued calls start. Direct and worker post-execution loss after both a raw query and a
  revision-guarded generated space deletion proves admin, paired facade, and cached `open()`
  rejection, retention after a partial shared close, failed-open reference ownership, and
  final-close/fresh-open recovery. The generated schedule then observes the committed deletion and
  requires explicit recreation at revision zero. A facade that sees an unknown transaction outcome
  rejects public and queued work without a secondary settlement write until explicit close/reopen.
  In-flight public reads recheck that fence before returning and remain rejected across close/reopen,
  while later inspection rejects before touching storage. Injected post-commit loss proves the
  direct-read boundary, request-bound replay, fresh-only identity sealing, interrupted-ingestion
  recovery, and explicit recreation after an unknown reset.
- Made `MemoryError` diagnostics immutable at runtime. Construction snapshots and recursively
  freezes JSON details before freezing the public error instance, so a first observer cannot alter a
  retained shared error's retryability or nested reconciliation markers for another observer. Opaque
  causes remain by reference and outside serialized diagnostics.
- Made partial Surreal connection setup and failed final close explicitly recoverable. A driver
  reference is acquired only after connect/use/schema/backfill/index bootstrap; failure after connect
  begins owns a zero-reference close, and a lost cleanup or final-close completion retains
  `connectionCleanup: 'pending'` instead of leaking the handle or starting a second connection.
  Facade `close()` remains active while cleanup is owed. Direct and worker completion-loss schedules
  cover connect, schema bootstrap, bootstrap cleanup, final close, and same-capability reuse.
- Classified raw-query failures that occur after statement responses arrive. Adapter JSON, hash,
  node, or exact-byte admission failures are non-retryable with
  `queryOutcome: 'responses_received'` and `requiresReconciliation`; they do not poison the healthy
  connection. Direct and worker probes commit a downstream-owned row before forcing response
  admission failure, then reconcile it through the same connection without replaying the mutation.
- Snapshotted privileged raw-query envelopes before scheduling and replaced binding validation plus
  cloning with one bounded copy-and-validate traversal. Mutable or accessor-backed query/binding
  values can no longer change between admission and dispatch, and unreadable accessors fail as
  `invalid_input` before a database call. Direct and worker execution proves the first snapshot wins.
- Added a separate per-facade runtime-owner lease, distinct from short physical-call arbitration.
  Newly running operations retain only a private owner incarnation; `open()` now leaves live work
  untouched and recovers it only after that owner lease disappears. In-memory schedules prove that
  a second facade cannot steal ordinary ingestion, a marked hard purge, or an active sync apply.
  A real Chromium page is terminated after durable episode acceptance but before canonical commit;
  fresh direct/direct, worker/worker, and mixed clients mark exactly that abandoned operation
  partial, preserve one accepted episode/change, and complete through explicit `retryEpisode`
  without duplicate acceptance. `resetSpace()` releases the lease before reopening the same handle.
  Every actual open now rotates the token even when the same JavaScript facade is reused; a fault
  schedule caught the prior token reacquisition falsely treating its abandoned operation as live.
  Sync apply now atomically creates its active session plus owner operation and atomically completes
  its operation plus HEAD/session publication. A second Chromium owner-death matrix terminates the
  page after one durable journaled apply step; observer reopen claims the abandoned operation and
  completes the locally pinned checkpoint without its original peer across all engine pairings.
  A third direct/direct, worker/worker, and mixed matrix releases two identical activation commits
  from one snapshot: exactly one owns and completes the session, the loser is retryable with no
  residue, and terminal replay converges on the winner's report.
  A fourth matrix injects a forward interruption after one durable record, pauses rollback after
  its first durable inverse record, proves another facade cannot steal the live owner, then kills
  that page and completes locally from the retained checkpoint with the remote peer gone. The same
  operation changes owner, restores the local HEAD, and retains exactly one forward plus one inverse
  journal record across all engine pairings.
  Hard-purge recovery now first claims its active marker's running operation through a revision CAS,
  so concurrent ownerless recovery has one winner before metadata cleanup or canonical replanning.
  A focused same-revision unit race proves one claim and one purge journal transition. A fifth
  direct/direct, worker/worker, and mixed browser matrix kills owners after marker creation, between
  sync-metadata batches, before final canonical commit, and after a recovery claim; every phase
  converges on complete sync-history erasure, content-free success, integrity, and replay denial,
  while a third facade cannot steal the live recovery owner.
  A sixth matrix races distinct hard-purge IDs and targets from one revision. Exactly one marker
  commit wins; its retryable loser leaves no operation, marker, owner, canonical, sync-metadata, or
  journal residue, then explicitly replans and succeeds after the winner settles. When the winner's
  marker is already live, the contender instead fails with `purge_in_progress` naming the winner
  before target planning, remains unbound, and likewise succeeds after explicit retry. Both schedules
  converge with integrity across direct/direct, worker/worker, and mixed engines. This tightens
  internal contention semantics without changing the public API.
  These are page-realm termination at instrumented transaction boundaries, not browser-process,
  mid-transaction, quota, corruption, or background-suspension qualification.
- Made every generic query issued by the facade require an explicit row limit at compile time,
  removed dead unlimited ingestion/retrieval fallbacks, and paged open-time operation/purge recovery
  in 16-row upper-bound keysets. Adapter-local diagnostic tooling remains outside `Memory`.
- Removed the unreported post-success lexical-build tail from `deriveFact`; direct derivation now
  ends at its atomic canonical commit and projection invalidation, while explicit projection rebuild
  owns subsequent derivative work and reporting.
- Added direct and worker SurrealDB WASM adapters backed by IndexedDB.
- Added a construction-time separated, database-confirmed `SurrealMemoryAdmin.rawQuery()` escape hatch for
  trusted power users. The nominal application storage passed to `Memory` has no raw method or later
  elevation path; a privileged factory returns a frozen storage/admin pair only with an explicit
  dangerous acknowledgement. It accepts bounded parameter bindings and serializes through the shared
  direct/worker engine scheduler plus persistent origin-wide coordinator, returns byte/node-bounded
  JSON statement responses with query hashes and in-band failures, and never retries possibly
  non-idempotent multi-statement queries. Response assembly consumes the SDK frame stream and admits
  each scalar or row before retention, avoiding unbounded whole-result collection while retaining
  native `LIMIT`/`TIMEOUT` requirements for engine chunks and large individual rows.
  Raw SurrealQL is explicitly database-wide and bypasses Memory scopes and canonical invariants;
  package-owned `tm_*` mutation is unsupported except under host-owned migration/repair discipline.
- Added cursor-derived semantic and signal journal compaction. A host can pass `1..1,000` durable
  consumer cursors; the facade validates their feed discriminator, space incarnation, future/floor
  bounds, and derives the minimum safe revision. Semantic and signal cursors are now distinct v2
  wire formats, destructive requests are snapshotted before queueing, and the mutually exclusive
  raw `throughRevision` path remains an expert override. Consumer registration and retirement remain
  host policy.
- Replaced the temporary local WASM dependency with the pushed, tagged, checksummed
  `@astrale-os/surrealdb-wasm@3.0.4-astrale.1` canonical-CI GitHub prerelease and made the clean
  package gate fetch and hash-check it in an isolated store.
- Added scoped, episode-level entity attribute assertions to prevent mixed-scope enrichment leaks.
- Added verified UTF-16 text-range and RFC 6901 JSON Pointer anchors for evidence and literal entity
  mentions; recall citations preserve distinct anchored occurrences, and provider-authored excerpts
  cannot become quotes without matching accepted episode content.
- Made evidence withdrawal and soft deletion temporally reconstructable.
- Replaced single-episode deletion's whole-space export with a point read and 16-row filtered
  evidence, mention, alias, derivation, fact, and projection pages. `DeleteEpisodeInput.workLimits`
  now fails closed on exact row/byte/graph work and `EpisodeDeletionReport.work` reports it. A
  256-fact unrelated corpus, one-row unchanged-revision rejection, independent-facade commit race,
  direct/worker IndexedDB, and clean packed consumers prove no partial tombstone or support closure.
- Replaced filter- and signal-selected bulk soft deletion's whole-space export with 16-row indexed
  episode/signal selection, batch-filtered provenance, and targeted truth/projection closure.
  `DeleteEpisodesInput.workLimits` and `BulkDeletionReport.work` expose exact row/byte/graph
  admission independently of `maxMatches`; signal expiry remains bound to the checked preview
  instant. One-row rejection, a 256-fact unrelated corpus, idempotent replay, and an
  independent-facade commit race prove fail-closed atomicity.
- Added `previewEpisodeDeletions` as the exact inspect-before-apply boundary for source, tag,
  metadata, retention, identity, and received/occurred-time groups. Preview and apply share one
  bounded selector, return deterministic complete episodes plus exact work, and bind a non-empty
  selection cursor to space incarnation, access, filter, revision, and ordered IDs. Apply reselects;
  malformed, stale, reset, access, filter, revision, or set drift fails retryably without residue,
  while empty previews expose no destructive token. Request snapshotting, stable replay,
  direct/worker IndexedDB, installed Node/browser consumers, preview logical-race rejection, and
  direct/direct, worker/worker, plus mixed-client same-preview races cover the contract.
- Replaced merge/split whole-space disclosure planning and broad alias/evidence/fact authority scans
  with one point/16-row indexed entity closure over aliases, alias episodes, entity provenance,
  subject/object facts, related fact provenance, and projections. `MergeEntitiesInput.workLimits`
  and `SplitEntityMergeInput.workLimits` fail closed on exact stored-row/JSON-byte planning work;
  `EntityMergeReport.work` reports it. A one-row rejection leaves the revision unchanged, a 256-fact
  unrelated corpus rejects whole-space export, final revision/generation fencing preserves stale-plan
  safety, and in-memory, direct/worker WASM, plus packed-consumer tests exercise merge and reversal.
- Replaced integrity verification's whole-space export and recursive graph walk with complete
  16-row physical-kind keysets, one-row sync-chunk pages, and iterative derivation-cycle checking.
  `IntegrityOptions.limits` now bounds distinct rows, stable JSON bytes, active graph nodes/edges,
  and retained issue details; `IntegrityReport.work` reports exact admission and complete detected-
  issue/truncation state. `maxIssues: 0` supports summary-only checks without hiding failure. Exact
  limit errors occur without mutation, sync metadata retains its cross-revision fence, and
  in-memory, direct/worker WASM, plus packed consumers exercise rejection and success.
- Made recall, search context, neighborhood, and every browse page physically bounded and
  observable. `scanLimits` now admits canonical rows and returned lexical/vector projections under
  exact row/stable-JSON-byte ceilings; `ContextBundle`, `GraphNeighborhood`, and `BrowsePage` expose
  shared `PhysicalScanWork`. Residual entity/fact/episode paths use advancing 16-row keysets, native
  episode pages clamp `limit + 1` to the remaining budget, and graph expansion preindexes adjacency
  instead of rescanning the full fact/evidence corpus per visit. Exact `N`/`N-1`, private pushdown,
  no-export, unchanged-revision, in-memory, direct/worker, golden-corpus, and packed-consumer evidence
  fail closed rather than returning a partial context or page.
- Replaced targeted hard purge and reopen recovery's duplicated whole-space exports with one bounded
  point/16-row keyset erasure planner. `PurgeInput.workLimits` guards exact stored-row, stable-JSON
  byte, graph-node, and graph-edge work; `PurgeReport.work` reports it. Signal target/basis and merge
  source closure now use denormalized SurrealDB indexes, large predicates are split into 1,000-ID
  chunks, and full journal/opaque-operation scans remain explicitly admitted. Limit rejection occurs
  before marker creation; active markers persist the normalized ceilings; recovery reuses the same
  planner; sync packs are reclaimed in 128-row transactions; and the bounded canonical closure
  settles atomically. Mixed-scope derivatives fail closed before erasure. In-memory no-export,
  interrupted recovery, packed-consumer, and direct/worker browser tests cover the contract.
- Made explicit correction evidence, replacement activation, and prior-fact supersession one
  revision-guarded canonical mutation. Correction planning is now sparse and indexed, exposes exact
  row/byte/graph work under caller-lowerable ceilings, and reauthorizes the complete direct support
  set after every lost revision race so newly hidden support fails closed.
- Retained non-reversible, space-scoped idempotency tombstones after hard purge so replay and import
  cannot recreate purged evidence; bound purge operation ids to normalized requests with
  collision-safe marker ids.
- Pinned every static governance, purge-selection, and projection plan to the exact revision it
  read. Conflicts now fail retryably instead of replaying stale puts/deletes; only full reread/replan
  paths retry internally. Added adversarial independent-facade races proving that purge cannot be
  followed by stale merge, canonical, or projection resurrection and that a newly added dependency
  invalidates an uncommitted purge selection.
- Replaced destructive projection rebuild with atomic per-kind set cutover. Full rebuilds stage
  `building` rows under hidden set ids, bind a canonical-source revision across long provider work, and
  activate every successful requested kind through one guarded space-row transaction; failed kinds
  retain their prior set. Targeted rebuilds replace successful target rows atomically inside the
  active set. Search requires exact active-set identity, interrupted/inactive rows are observable and
  reclaimed in bounded pages, and inspection/statistics/rebuild reports expose active generation and
  source lineage. Terminal operation settlement now follows cleanup; a post-activation cleanup fault
  returns an explicit partial `cleanup_deferred` report without undoing the searchable generation.
  Full target selection now streams through 16-row keysets instead of whole-space export, targeted
  selection point-reads at most 10,000 unique ids, dependencies and replacement rows are sparse, and
  generated rows participate in exact public row/stable-byte admission. `MaintenanceReport.scan`
  exposes the work. A `projection_scan` failure keeps the old set active, durably marks hidden staged
  state partial, and a bounded retry reclaims it; stale totals use native counts. Exact `N`/`N-1`,
  no-export, direct/worker, golden-corpus, and packed-consumer checks cover the contract.
  Projection maintenance is now single-flight per space across full/targeted requests and facades:
  a fresh running-operation commit is the revision-CAS admission point, a live contender fails before
  target/provider/staging work while naming its owner, and a same-snapshot loser leaves its operation
  ID unbound for explicit retry. Independent direct/direct, worker/worker, and mixed clients prove
  one-winner admission, uninterrupted old-set recall, actual owner-page death after durable hidden
  staging, interrupted-operation recovery, and bounded reclamation with no inactive residue.
- Made operation diagnostics participate in hard erasure. Operations linked to erased episodes,
  canonical records, journal targets, or target-bearing results—and conservative whole-memory
  rebuild/sync/migration operations—become content-free `diagnosticsState: 'purged'` tombstones.
  Episode/result/error/warning/provider-call fields are removed, unrelated operations remain intact,
  recovery applies the same closure, and every facade commit rejects late or reused writes that
  would replace a purge tombstone. Integrity verification now fails with a dedicated issue if
  privileged/raw storage mutation rehydrates diagnostics or makes a tombstone non-terminal.
- Made durable operation IDs create-once per space. Each new operation receives a private random
  run binding; only state transitions carrying the same binding, kind, and episode may update a
  non-terminal row, while every terminal row rejects replacement with `idempotency_conflict`.
  This prevents a second remember/governance call from overwriting the first operation's lineage.
  The binding stays internal and is absent from `ProcessingOperation`.
- Bounded the durable operation journal to deterministic first/last samples of 64 warnings and 64
  payload-free provider calls, with 2,000-byte diagnostic strings and an explicit
  `diagnosticsTruncated` bit. Provider warning/error text, branded error details, credentials, and
  unknown call-summary fields cannot persist; integrity verification rejects malformed or
  over-budget rows. JSON validation now walks breadth incrementally with O(depth) work memory, so a
  sparse or hostile wide array cannot allocate a width-sized validation stack before its node budget
  fires.
- Removed projections reached through deleted or purged episode evidence, mentions, and alias
  provenance while preserving independently supported canonical records.
- Added nested episode/entity/fact selectors, revision-bound browse, complete bounded graph
  snapshots, and evidence-backed structural analysis APIs.
- Made snapshot's completeness boundary physical as well as logical. `scanLimits` now caps every
  pre-filter canonical row and exact stable-JSON byte while 16-row keysets assemble the selected
  graph; `snapshot.scan` reports actual work and limits. Exact-boundary, private-row pushdown,
  no-export, direct/worker IndexedDB, and packed-consumer checks keep the downstream reasoning
  baseline complete without an unbounded pre-result load.
- Added storage-native filtered episode keyset paging, coherent revision-bracketed point/aggregate
  reads, and explicit stats/integrity/export revision lineage.
- Replaced statistics' whole-space export with native filtered storage counts and caller-bounded
  keyset scans. `stats()` and `inspect()` now share cancellable `ManagementOptions`, return exact
  residual row/stable-byte work, and fail without partial metrics at exact `stats_scan` or
  `inspection_scan` boundaries. Latest derivation/signal state, distinct conflict groups, stale
  projections, and provider calls advance in pages of at most 1,000 records; native aggregates are
  explicitly outside the transfer envelope. Inspection natively counts pending operations, resolves
  the persisted space incarnation instead of trusting a stale facade cache, and rejects reset/recreate
  drift with `requiresReopen`. Exact N/N-1 source, installed Node, and direct/worker IndexedDB checks
  cover the public contract. SurrealDB carries an indexed schemafull fact conflict-group envelope with
  an idempotent schema-v7 backfill.
- Replaced direct derivation, withdrawal, fact-correction, and fact-retraction whole-space exports with point reads
  plus 16-row
  semantic-key, logical-key, conclusion, premise-array, and evidence keysets. Positive-cycle and
  truth-maintenance walks now expand only the affected closure under public row, stored-JSON-byte,
  graph-node, and graph-edge limits; reports expose exact admitted work. A 256-fact unrelated-corpus
  fixture rejects export, all limit dimensions fail before mutation, independent-facade derivation,
  correction, and retraction races leave no partial rows, and real direct/worker SurrealDB exercises
  bounded derive, withdrawal, correction, and retraction. Correction and retraction each prove a
  one-row ceiling leaves the source revision unchanged before a bounded retry succeeds; correction
  additionally rejects a private support inserted between planning and retry.
- Bounded the materialized format-v4 archive boundary without duplicating the replica protocol.
  Export scans only canonical tables in 16-row keysets under explicit work budgets and applies exact
  document record/byte plus aggregate-node ceilings. Import independently bounds the input document
  and expanded target-local rows/bytes before collision or mutation work. Format 4 also carries every
  episode `contentHash` preimage, including explicit assertions; import recomputes each hash before
  target reads, and collision remapping rehashes changed identities. Format 3 is rejected because it
  omitted assertions and cannot provide the same independent verification. The format is a closed
  nested schema: unknown/missing properties, malformed unions and optionals, non-canonical arrays,
  and cross-space records fail before target reads; an all-section mutation corpus and a million-node
  payload exercise that boundary. Large whole-memory backup and restore remain the resumable
  `exportSyncBundle`/`openSyncBundle`/`syncFrom` path.
- Replaced whole-space signal browse/write/delete scans with 16-record latest-revision keysets and
  immutable identity/access pushdown. Browse retains lightweight ordering candidates, point-fetches
  returned values under an exact 16 MiB default / 64 MiB maximum canonical response budget, and
  folds full-set commitments in fixed 1,000-ID chunks. Writes scan only addressed keys. Signal purge
  adds an explicit retained-revision guard, uses a native count, and atomically deletes by logical-key
  range instead of assembling a per-revision mutation.
- Replaced `putSignals`' complete temporal-universe scan with a storage-neutral addressed closure
  over exact targets/bases, temporal lifecycle, visible evidence/rule support, active merge
  components, incident facts, aliases, and mentions. Predicates use 1,000-value chunks and 16-row
  keysets under public `basisScanLimits`; `PutSignalsReport.basisScan` counts every returned
  row/stable-JSON byte, exact `N`/`N-1` failures precede mutation, and a 17-record unrelated corpus
  proves invariant work. Current-merge and known-at fact fixtures preserve the former semantics.
- Replaced destructive reset's whole-space export with native report-row preflight counts and
  16-row episode/entity/fact/projection keysets. `ResetSpaceInput.scanLimits` bounds exact report
  rows/bytes, `ResetSpaceReport.scan` exposes the work, and the revision-guarded whole-space delete
  starts only after the complete report is admitted. Separate direct/direct, worker/worker, and
  mixed-client schedules prove writer-first conflict with no lost commit and reset-first writer
  failure with no post-delete resurrection.
- Added generic checked point reads for episodes, entities, facts, and derivations. `read()` returns
  the value, revision/time lineage, and exact row/byte scan work; entity/fact provenance advances
  through 16-row keysets with deduplicated support-episode point loads. Exact `N`/`N-1` failure
  returns no partial value, while `getEpisode`/`getEntity`/`getFact`/`getDerivation` remain bounded
  value-only sugar over the same implementation.
- Core read and export requests are now closed, package-owned snapshots before their first await.
  `read`, `recall`, `search`, `neighborhood`, `browse`, `snapshot`, `analyze`, `changes`,
  `signalChanges`, and `export` use one bounded traversal, so later authority, filter, temporal-view,
  anchor, seed, ID, cursor, ordering, or budget mutation cannot retarget work. Shared limits are
  1,000,000 nodes, depth 64, and 64 MiB of strings; source tests, real direct/worker IndexedDB, and
  installed Node/browser consumers cover changing accessors, immediate nested mutation, closed
  envelopes, and pre-storage rejection.
- Removed reconciliation's per-conflict transaction and repeated sync-chunk validation hot paths.
  Merge conflicts now stage in deterministic 128-row metadata batches, identical resolved rows are
  not rewritten, purge-dominance caches at most 100,000 body-free dependency decisions, and semantic
  validation retains at most two verified chunks (32 MiB maximum) while still checking every index
  and record digest. A 101-conflict stress fixture requires one conflict batch and bounded chunk
  reads.
- Fixed the physical merge envelope: `tm_merge.active` is now a schemafull boolean with a native
  `(space_id, target_id, active)` index, current-view retrieval pushes the active predicate into the
  storage query, and open idempotently backfills schema-v7 rows whose canonical payload predates the
  envelope column. Non-current views skip merge storage entirely because historical merge
  reconstruction is not implemented. The ineffective `state` index is no longer declared for fresh
  databases.
- Replaced locale-sensitive canonical and cursor ordering with deterministic Unicode scalar-value
  ordering across the facade and both storage adapters; malformed surrogate strings now fail before
  persistence or hashing. This introduced canonical schema v5; the persisted signal journal below
  advanced it to v6, and maintained derivations advance the current schema to v7. Canonical
  archives are now format v3 and older formats fail closed rather than being silently reinterpreted.
- Added explicit `open({ migrate: true })` support for the additive schema `5 -> 6 -> 7` path.
  Every ordered declaration is SHA-256 checksummed, and each version update plus immutable
  `tm_migration` audit checkpoint commits atomically without advancing canonical revision or either
  journal. Interrupted chains resume at the first uncommitted step, concurrent opens converge, and
  altered history, unsupported versions, newer schemas, ontology changes, and downgrades fail
  closed. Inspection exposes the successful checkpoint lineage. Migration is helpable rather than
  facade-owned: independent direct/direct, worker/worker, and mixed clients paused before the same
  step converge on one checkpoint chain, and actual owner-page termination after the atomic first
  step leaves a valid cursor that a fresh opener resumes and persists through another reopen.
- Added a durable semantic revision feed with exact-scope affected-target partitions, access- and
  space-generation-bound cursors, atomic SurrealDB persistence, fresh import records, and
  content-free hard-purge invalidations that scrub erased identifiers from prior journal rows.
- Added dry-runnable, revision- and breadth-guarded semantic-journal compaction with a durable
  monotonic floor, atomic indexed SurrealDB range deletion, and snapshot-required expiry for older
  cursors.
- Added durable local semantic/signal journal consumers with monotonic feed-specific
  acknowledgement, metadata-revision-bound browsing, explicit non-reusable retirement tombstones,
  and registry-derived compaction guarded against concurrent membership/checkpoint changes. The
  bounded registry is operational state omitted from archive and replica sync; hard purge retains it
  and reset removes it.
- Added revision- and breadth-guarded selector-based soft deletion and hard purge for access-bounded
  source/tag/metadata/time groups.
- Added scoped immutable signal revisions for downstream cluster, salience, peripheral-state, and
  `dream()` outputs, with revision/basis lineage, indexable grouping tags, expiry, current/history
  browse, guarded group withdrawal/purge, diagnostic analysis counts, and dependency-aware canonical
  purge closure. Every entity target or basis reference requires declared episode/fact grounding to
  prevent entity-only scope laundering. Signals remain separate from evidence, truth, retrieval
  scoring, semantic changes, and canonical archives; per-signal and whole-write budgets bound
  algorithm batches.
- Signal browse, put, and delete now detach their complete closed JSON request envelopes in one
  bounded traversal before any asynchronous read or facade-queue entry. The 1,000,000-node,
  depth-64, 64 MiB aggregate-string ceiling is independent of tighter operation limits; later
  mutation or changing accessors cannot retarget authority, selectors, basis, values, revision, or
  destructive mode, and unreadable, cyclic, non-plain, malformed, or unknown input fails before
  storage. Source, direct/worker Chromium, and packed Node/browser consumers cover immediate nested
  mutation, single-read accessor behavior, and closed-envelope rejection.
- Added a separate durable signal-change journal with browse-to-feed baseline handoff, exact-scope
  key/target partitions, generation/access-bound cursors, atomic put/withdraw/purge persistence,
  content-free hard-purge invalidation, and independently guarded indexed compaction. Signals and
  their journal remain non-epistemic and excluded from canonical archives and semantic changes.
- Added exact signal-target erasure previews: constrained current active/non-expired signal pages
  expose a cursor bound to filter, access, generation, revision, expiry instant, and the complete
  matching revision set; `hardPurge.signalTargets` consumes it under a breadth guard without
  interpreting signal values or paging target IDs in host code. Empty selections no longer expose a
  destructive cursor.
- Added exact signal-target soft deletion for episode targets. `deleteEpisodes.signalTargets`
  consumes the same checked full-set cursor, commits canonical tombstones/support reassessment and
  withdrawn signal revisions atomically, and emits separate semantic and signal journal rows at the
  same revision so applied recommendations do not remain active.
- Added canonical maintained derivation revisions for downstream rule and ontology engines.
  `deriveFact` validates exact current fact/evidence premises, ontology and scope closure at a
  caller-checked revision; positive dependency cycles fail closed. Evidence withdrawal, fact
  retraction, episode deletion, explicit derivation withdrawal, and hard purge now invalidate
  affected support and retract unsupported conclusions recursively in the same mutation while
  preserving independently supported facts. Purge's generalized operation-diagnostics closure also
  removes contaminated derivation replay payloads while retaining tombstones that reject
  operation-ID reuse.
- Added `deriveFacts` as the bounded atomic multi-conclusion substrate for downstream rule engines.
  One to 64 members share a detached request, access partition, checked revision, operation, commit,
  journal revision, and aggregate row/byte/node/edge budget. Members evaluate only the pre-batch
  canonical state; duplicate semantic conclusions/IDs, ambiguous cardinality-one partitions,
  combined positive cycles, an invalid member, a work breach, cancellation, or a revision race leave
  no partial residue. Results preserve input order, single/batch replay identities are distinct, and
  the shared planner keeps single and batch ontology, cycle, reconciliation, truth-maintenance, and
  projection semantics aligned. Source tests, packed Node/browser consumers, and real Chromium
  direct/direct, worker/worker, and mixed-client races cover one complete winner, stable replay, and
  explicit residue-free loser re-evaluation without duplicate support or semantic change.
- Added `withdrawDerivations` as the bounded atomic rule-set retirement substrate. A closed selector
  intersects current derivation IDs, rule IDs, rule versions, conclusion fact IDs, and half-open
  recorded-time bounds under caller scope, exact revision, one aggregate work budget, and an explicit
  1..1,000 `maxMatches` guard. Explicit IDs are strict and historical active rows never match.
  `previewDerivationWithdrawals` runs that exact shared selector without mutation and returns the
  complete ordered support set, snapshot revision, work, and a non-empty opaque consistency cursor
  binding the space incarnation, access partition, selector, revision, and selected-ID digest.
  Cursor-bound apply reselects and compares every binding before mutation; unchanged repeated
  previews are deterministic, empty general selections expose no destructive token, and stale,
  reset, access, selector, or set drift is a retryable conflict.
  Every selected support receives one immutable withdrawn successor before a single aggregate
  truth-maintenance/projection pass, operation, revision-CAS commit, and semantic change. Stable
  request-bound replay, request snapshotting, missing-ID/selection/work rejection, injected
  residue-free commit loss, direct/worker IndexedDB reopen persistence, packed Node/browser
  consumers, preview logical-race rejection, and direct/direct, worker/worker, plus mixed-client
  same-preview two-support races cover the public contract.
- Added derivation point reads, fact/snapshot/analysis views, derived-only diagnostics, integrity
  checks, direct/worker IndexedDB persistence, and format-v4 export/import with premise/conclusion
  closure and target-local identity normalization. Rule execution, negation, aggregation, temporal
  applicability, and iterative fixpoint scheduling remain downstream or future boundaries.
- Added deterministic connected components, degree metrics, and structural PageRank. Analysis now
  also supports normalized positive-weight visible entity seeds through
  `personalized-pagerank-v1`, plus caller-lowerable hard ceilings for visible records, graph
  nodes/edges, admitted PageRank steps, and cardinality-one temporal comparisons. Reports expose
  actual work and limits; over-budget analysis fails instead of returning partial metrics. Reports
  now distinguish parallel relation edges from unique directed arcs and use the latter for density,
  keeping density bounded. Finding output is now a deterministic severity-first `top` sample with
  complete per-code/truncation counts; aggregation retains bounded top sets, indexes derivation
  conclusions once, computes timestamp extrema without sorting, and safely handles prototype-like
  source, predicate, and signal-namespace keys.
- Made analysis storage materialization bounded instead of merely bounding post-load algorithms.
  Canonical kinds now advance through 16-row `id` keysets, signal history through 16-row
  key/version keysets, and every physical row is admitted before post-filtering under public
  row/exact-stable-JSON-byte ceilings. Reports expose scan work and effective limits; exact-boundary,
  large-corpus, concurrent-write, in-memory, direct/worker IndexedDB, and packed-consumer tests prove
  rejection without whole-space export or partial reports.
- Added bounded structural, temporal, referential, ontology, evidence-scope, and content-variant
  validation before archive import mutation.
- Added whole-memory replica synchronization through a transport-neutral `MemorySyncPeer` contract:
  immutable content-addressed checkpoint DAGs, independently checksummed bounded chunks, durable
  pinned resume, fast-forward and three-way merge, paged explicit conflict resolution, monotonic
  purge dominance, target-local signal/derivation revision rebasing, fail-closed apply, automatic
  reopen recovery, and rollback when no new erasure occurred. Session inspection, conflict,
  resolution, and abort APIs require the session's complete scope set; a newly applied purge makes
  the session forward-only instead of allowing resurrection through rollback. Resume calls are
  durably bound to their original scope, strategy, ancestry, revision, and aggregate receive limits;
  caller-controlled byte/record/chunk budgets reject an oversized remote header before transfer and
  bound merged staging, while each chunk also has a bounded JSON-node budget. Chunk pages have a
  separate 16 MiB default and 256 MiB canonical-payload ceiling, never split a chunk, and protocol-v1
  checkpoint, record, chunk, and page envelopes reject unknown fields. Operation IDs are
  session-bound before peer contact, conflict values are available through a separately byte-bounded
  pinned point read, and abort removes partial receiver/plan assets. Portable purge markers strip
  caller-controlled operation IDs. Purge dominance transitively prunes concurrent facts,
  derivations, lifecycle, and signals whose only support was erased. An iterative strongly
  connected-component pass marks only actual cross-branch positive-cycle participants, while
  downstream acyclic derivations survive; those cycles and cardinality-one unions become
  `invalid_combination` conflicts. Hard purge invalidates all local sync history before erasure, and
  direct/worker IndexedDB plus packed-consumer gates exercise an independent replica.
- Added `exportSyncBundle` as the bounded, cursor-resumable offline form of whole-memory sync. It
  pages indexed portable checkpoint headers, existing target chunks, and a final commit under
  page, aggregate-header-byte, and header-count ceilings; binds the cursor to space generation,
  access, target, logical revision, and the private sync-metadata revision; brackets every page
  against both revisions; validates target ancestry; and commits the exact header sequence with its
  count, byte length, and a rolling SHA-256 digest. Fresh snapshot-bound cursors are v2; pre-v2
  alpha cursors restart instead of resuming across an unknowable metadata state. Added
  `SyncBundleReader` and
  `openSyncBundle` so a durable file/blob/IndexedDB adapter supplies only indexed frame reads while
  the package streams bounded validation of commitments, gaps, ancestry, payload manifests, and
  post-open mutation before exposing `MemorySyncPeer`. Native `syncFrom` remains the semantic,
  resumable, reconciling import path instead of a second merge engine.
- Hardened the untrusted bundle-reader boundary against validation/use races. `openSyncBundle`
  snapshots options before I/O and copies each commit, checkpoint, and chunk in one traversal under
  its hard node/depth/string limits before structural validation, hashing, or retention. Accessor-
  backed frames are read once per reader result, unreadable frames fail `import_invalid`, and only one
  bounded body is held at a time.
- Added bounded manual sync-history payload compaction without rewriting checkpoint ancestry.
  `compactSyncHistory` binds scope, exact space, logical revision, HEAD, cutoff, and opaque cursor;
  supports dry-run pages of at most 64 headers; atomically makes selected non-HEAD payloads
  unavailable; deletes chunks/indexes in bounded batches; and recovers interrupted cleanup on open.
  Portable headers remain inspectable, expired divergent merge bases fail with an explicit reseed
  requirement, and in-memory crash injection plus direct/worker IndexedDB and packed-consumer gates
  cover the contract. Automatic checkpoint retention and header collection remain future policy.
- Added bounded, scope-filtered `syncHistory` and `syncSessions` inventory so operators can inspect
  checkpoint payload availability, HEAD, resumable work, and terminal results without querying
  package-owned tables. Added guarded `compactSyncSessions` for terminal conflict/tombstone and
  unreferenced staging reclamation. It preserves checkpoint-owned chunks and small session
  idempotency/status headers, uses an atomic unavailable marker with bounded deletion, and finishes
  interrupted cleanup on reopen in memory and direct/worker IndexedDB tests. Automatic retention and
  checkpoint/session-header collection remain future policy. Checkpoint inventory pages now bracket
  the private metadata revision and emit snapshot-bound v2 cursors, so payload compaction cannot mix
  `available`, `pruning`, and `pruned` states across one traversal.
- Bounded every retained sync-session header to deterministic first/last samples of 64 warnings and
  2,000-byte warning/error strings. `SyncReport` and session inventory now expose the optional error
  plus `diagnosticsTruncated`; every resume/recovery/compaction transition normalizes the row, and
  integrity verification identifies privileged over-budget or malformed rows as
  `invalid_sync_session`.
- Sealed the complete durable sync-session state machine. Closed envelopes now rederive request and
  disclosure-scope bindings, validate revision/limit/checkpoint/operation relationships, enforce
  state-specific fields and counters, and compare active build/receiver/plan progress with bounded
  owner manifests before safe disclosure or resume. Terminal compaction may repair bounded
  diagnostics, but cannot normalize forged authority or progress metadata.
- Made sync-conflict inventory byte-bounded as well as count-bounded. `SyncConflictPage` exposes its
  exact canonical byte length, callers can set a 1 MiB-default/16 MiB-maximum `maxBytes`, and fresh
  fixed-size v2 cursors no longer embed large sync keys while bounded v1 cursors remain readable.
  Safe list/detail/resolution paths reject malformed privileged rows, integrity verification reports
  `invalid_sync_conflict` through a paged metadata scan, and compacted detail now fails explicitly
  with `detailsPruned: true` instead of looking like an empty inventory.
- Sealed sync purge-dominance acceleration rows: each tombstone now has an exact shape and derived
  space/session/kind/digest identity validated on facade commit and again on every suppression
  lookup. Paged integrity verification reports `invalid_sync_tombstone`, so a malformed raw row
  fails reconciliation instead of silently discarding live records.
- Sealed sync random-access acceleration metadata. Safe indexed reads validate derived identity,
  verify the owning chunk, and recompute the complete deterministic index projection before using
  semantic or dependency fields. Bounded integrity scans validate closed chunk manifests, exact
  per-chunk index sets, and aggregate index counts, detecting missing, extra, forged, or orphan rows.
  The facade commit boundary also rejects a chunk unless exactly one matching deterministic index
  per record is present in the same atomic write; index-only, partial, duplicate, forged, and
  checksum-invalid packs never reach a driver.
- Made replica ancestry retention complete: pulls traverse every remote parent branch to local
  history and cache missing immutable headers parent-first in guarded batches of 100, without
  downloading non-target payloads or overwriting concurrent rehydration. Sealed stored checkpoint
  source/lifecycle fields and the singleton HEAD ref; bounded integrity scans now verify parent
  closure and every available checkpoint's exact root/count/byte/scope manifest.
- Added a private monotonic `metadataRevision` to the space envelope. Every facade driver commit now
  advances it, Surreal transactions compare it alongside the logical revision, and
  `verifyIntegrity`, checkpoint inventory, and offline bundle export bracket their paged
  sync-metadata scans with it. Concurrent metadata-only work now returns retryable `conflict` or
  expires the opaque traversal instead of certifying a mixed metadata state; schema-v7 storage
  backfills missing counters to zero without changing the logical revision.
- Closed sync-asset owner reachability. Integrity verification derives valid chunk/index owners from
  exact available/pruning checkpoint and active/reclaiming session lifecycles, reports an internally
  consistent unreferenced pack as `orphan_sync_owner`, and requires conflict/tombstone detail to
  belong to a valid non-pruned pull session.
- Added pre-ranking scope filters and serialized access to shared embedded WASM engines.
- Partitioned embedding indexing by exact disclosure scopes and made projection batch limits real.
- Required canonical UTC RFC 3339 timestamps with millisecond precision.
- Enforced provider-response deadlines even for providers that ignore abort, with distinct
  retryable `timeout` and caller `cancelled` outcomes.
- Added a clean packed-consumer archive round-trip, declaration-resolution, and direct/worker
  IndexedDB verification gate.
- Added deterministic CycloneDX 1.6 generation to every build and the packed artifact. The SBOM
  covers the complete resolved production npm graph, nests all 337 unique components from the
  fork's shipped locked Cargo inventory, preserves the two distinct BUSL change dates, and binds the
  exact WASM file hash. A freshness check plus clean-consumer byte and semantic verification reject
  stale, machine-specific, incomplete, or license-collapsing output; a standard CycloneDX
  relationship composition marks unavailable intra-Cargo edges `unknown`.

This prerelease is an evaluation baseline, not a production-readiness declaration. Remaining gates
are tracked in the product and implementation documents.
