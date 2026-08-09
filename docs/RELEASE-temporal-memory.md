# Temporal Memory alpha verification snapshot

Date: 2026-08-09

This is evidence for the source snapshot that becomes `0.1.0-alpha.1`. It is not a stable-release
or production-readiness declaration. Re-run every gate below against the packed artifact before
publishing; source-tree success alone is insufficient.

## Dependency decision

- The current candidate compatibility unit is `@astrale-os/surrealdb-wasm@3.0.4-astrale.1` +
  `surrealdb@2.0.8`, with embedded `surrealdb-core@3.0.5`. Exact fork source commit
  [`b049a1a`](https://github.com/astrale-os/surrealdb.js/commit/b049a1ace08147b90fb539d4681e2f22890d7eed)
  is derived from JavaScript SDK base `64b8f10` and is tagged
  `surrealdb-wasm-v3.0.4-astrale.1`.
- The source tag, checksums, and exact package are published as a
  [GitHub prerelease](https://github.com/astrale-os/surrealdb.js/releases/tag/surrealdb-wasm-v3.0.4-astrale.1).
  The package SHA-256 is
  `11a3aef3db9d1d1f771f1bc118d2649a65d4e09fd9b549ad081b6aafb803a09a`; the embedded WASM SHA-256
  is `5211b20f09a4834febff0d21d0f83c468e8275a4d36a333151fed5c2dd57c634`. Independent branch and
  annotated-tag CI runs
  [30835636830](https://github.com/astrale-os/surrealdb.js/actions/runs/30835636830) and
  [30835818594](https://github.com/astrale-os/surrealdb.js/actions/runs/30835818594) produced
  byte-identical package, WASM, and checksum artifacts and passed the four-case browser matrix. The
  attached release tarball is unchanged from that CI output. The Temporal Memory manifest pins the
  durable asset instead of a local `file:` path; the workspace lockfile pins npm's SHA-512 integrity
  and the packed verifier independently checks the installed WASM SHA-256. The GitHub asset URL
  itself is not content-addressed or signed, which is why signed/npm publication remains an open
  gate.
- The earlier `3.0.4-astrale.0` prerelease is retained unchanged but marked superseded. Its local
  publication build used Rust 1.97.1 while the tag CI pinned Rust 1.97.0, so the functional browser
  evidence passed but the public tarball did not match the tagged CI bytes. No rollback or mutable
  same-version asset replacement is used.
- On 2026-08-03, npm exposed official `@surrealdb/wasm` versions only through `3.0.3`, and
  `@astrale-os/surrealdb-wasm` was absent. This candidate is therefore URL-installable but not yet
  npm-installable by package name.
- The Chromium source and clean packed-artifact harnesses pass schema/index creation, persistence,
  lexical recall, separate durable semantic and signal journals, scoped signals, hostile bound
  values, maintained derivations, concurrent reads, and fresh direct and module-worker connections
  with this candidate.
- This source snapshot explicitly uses canonical schema `7`: schema `5` introduced deterministic
  Unicode hash/order semantics, schema `6` added the persisted signal-change table and compaction
  floor, and schema `7` adds canonical derivations. Archive format `4` carries the latest selected
  derivation revision plus its premise/conclusion closure. Schema mismatch still fails closed by
  default; explicit `open({ migrate: true })` now applies only the ordered, checksummed, atomic
  additive `5 -> 6 -> 7` chain. Each step and immutable audit record commit together and can resume
  after interruption without changing canonical revision or either journal. Schema 4, newer
  versions, altered history, downgrade, ontology migration, and row transforms remain unsupported.
  Migration is helpable rather than facade-owned: independent direct/direct, worker/worker, and
  mixed clients converge when released against the same source version, and actual owner-page death
  after the complete first transaction leaves one checkpoint that a fresh opener resumes to schema
  `7`. Physical death inside a migration transaction remains unqualified.
  Archive formats still fail closed. Sync protocol `1` uses additive schema-7 metadata tables and is
  versioned independently from canonical records and archive format.
- Atomic projection sets are an additive schema-v7 physical index contract: `tm_projection.set_id`,
  an indexed active-set predicate, private `canonicalRevision`, and active references in the flexible
  space payload. Projections now also carry dependency-derived `sensitivities`; their generation
  includes that contract version. Existing schema-v7 spaces backfill the private counter but do not
  search a missing or pre-classification active generation until a successful full rebuild;
  canonical records and archive format do not change.
- The Astrale JavaScript adapter is Apache-2.0. Embedded `surrealdb-core`, `surrealdb-types`, and
  `surrealdb-types-derive` 3.0.5 are BSL 1.1 with a 2030-01-01 change date;
  `surrealdb-protocol` 0.8.3 is BSL 1.1 with a 2029-09-17 change date. The runtime artifact is not
  wholly open source before the applicable change dates and declares `SEE LICENSE IN LICENSES.md`.
- SurrealDB's
  [official licence FAQ](https://support.surrealdb.com/en/articles/11541883-frequently-asked-questions)
  says
  embedded application use is permitted while a commercial hosted database service is restricted.
  The operative BSL texts and their definition of “Database Service” control; dependency-license
  approval remains an explicit release decision and blocker.
- Previously evaluated official artifacts failed IndexedDB index creation or SDK engine readiness;
  they are not release fallbacks for this candidate.
- The 2026-08-09 production-lock audit reports zero npm advisories across 49 packages. A separate
  checksum-verified OSV Scanner `2.5.0` run recognizes all 344 package components in the emitted SBOM
  and matches ten distinct advisory classes across nine inherited Cargo components. Seven have fixed
  floors (`ammonia` 4.1.3/4.1.4, `anyhow` 1.0.103, `crossbeam-epoch` 0.9.20,
  `event-listener` 5.4.2, `rand` 0.9.3, and `time` 0.3.47), two identify unmaintained crates
  (`bincode`, `paste`), and `RUSTSEC-2023-0071` has no patched `rsa` release. The shipped inventory
  omits intra-Cargo edges, so the scan establishes locked-component presence but neither runtime
  reachability nor exploitability. CI downloads the public advisory databases and scans offline on
  changes and a weekly schedule; named exceptions expire on 2026-08-23 and are release blockers,
  not vulnerability clearance.
- The upstream IndexedDB transaction fix was merged as WASM `3.0.4` in
  [PR 600](https://github.com/surrealdb/surrealdb.js/pull/600). The fork candidate is the bounded
  published replacement under license and production-readiness review; a GitHub asset alone does
  not complete npm delivery or approve the mixed-license boundary.

## Security boundary

- The reference adapter accepts only `indxdb://` and `mem://` endpoints.
- Shared references are now acquired only after connect/use/schema/backfill/index bootstrap. A
  partial open owns and attempts its own zero-reference close; if that cleanup or the last normal
  close loses completion, `connectionCleanup: 'pending'` blocks a new connection while a later
  `open()` or explicit `close()` retries cleanup. Direct and worker schedules lose completion after
  connect, schema bootstrap, bootstrap cleanup, and final close, then reuse the same capability.
- Persistent clients now hold one stable endpoint/namespace/database Web Lock around every physical
  SDK call, in addition to in-transaction revision guards. Expanding the independent-tab matrix
  exposed a real pre-fix two-winner guarded commit under overlapping embedded clients. The corrected
  direct/direct, worker/worker, and mixed matrix restores one winner; a browser context with Web
  Locks removed proves `indxdb://` fails `storage_failed` while process-local `mem://` still opens.
- Generated transactions now distinguish a returned rollback from a lost call outcome. Direct and
  worker IndexedDB deliberately fail a later schema-constrained statement after an earlier valid
  write; both report `transactionOutcome: 'rolled_back'`, retain neither row nor any space revision,
  then reuse the same connection successfully. A call with no statement response is conservatively
  non-retryable with `transactionOutcome: 'unknown'` and `requiresReopen`; raw admin uses
  `queryOutcome: 'unknown'`. Unknown generated/raw calls now poison the shared driver before queued
  calls start. Deterministic direct/worker post-execution lock-completion loss after both a raw query
  and a revision-guarded generated space deletion proves admin, paired-facade, and cached-open
  rejection, poison retention after only one shared reference closes, failed-open ownership
  preservation, and recovery only after final close plus fresh physical open. The generated schedule
  also proves that a first observer cannot mutate the retained error's retryability or nested outcome
  markers before another facade sees it, then observes the committed deletion and requires explicit
  recreation at revision zero. Physical database-worker death during `COMMIT` remains unqualified.
- Raw response validation now distinguishes post-response rejection from physical call loss. JSON,
  hash, node, or byte admission failure after statement responses is non-retryable with
  `queryOutcome: 'responses_received'` and `requiresReconciliation`, but does not poison the healthy
  connection. Direct and worker probes commit a downstream-owned row before forcing response
  admission failure, then reconcile it through the same connection without replay.
- Privileged raw-query requests now snapshot every admitted top-level field before scheduling and
  copy plus validate bindings in one bounded traversal. Direct and worker probes use query and
  binding accessors whose second values differ, proving only the first detached values reach
  SurrealDB; unreadable accessors fail as `invalid_input` before storage.
- Facades now retain the first unknown transaction error as a hard reopen fence. Public work,
  already-queued mutations, and normal failed-operation settlement cannot issue a second storage
  write. In-flight public reads recheck the same fence before returning, while later inspection
  rejects without another storage read; close/reopen cannot release a result started in the fenced
  incarnation. One injected post-commit loss proves this direct-read boundary, request-bound
  derivation replay, fresh-only delete-ID sealing, interrupted-ingestion recovery, and explicit
  recreation after a reset that actually committed. Reopening the same JavaScript object rotates
  its private runtime-owner incarnation; otherwise its abandoned ingestion operation would be
  falsely treated as live.
- `MemoryError` now snapshots and recursively freezes JSON details and freezes its public fields.
  Shared safety errors therefore retain their code, retryability, operation identity, and nested
  reconciliation markers even when multiple callers observe the same instance. Opaque causes remain
  unmodified and are not serialized.
- WASM capabilities disable scripting, guest access, and network targets.
- Application values use bound query variables; the Chromium harness stores and recalls hostile SQL-
  shaped text without executing it.
- Raw SurrealQL is absent from ordinary `SurrealMemoryStorage` and has no later elevation path. A
  privileged construction call returns a frozen storage/admin pair; `SurrealMemoryAdmin` additionally
  requires exact namespace/database confirmation. It is a trusted-host,
  database-wide administrator capability outside
  `AccessContext`; parameter binding does not make untrusted query text safe. Raw mutation of
  package-owned `tm_*` tables bypasses revision, journal, purge, projection, and sync invariants.
  Raw responses now consume the SDK frame stream and admit each scalar/row before retention under
  aggregate byte/node ceilings instead of first collecting the whole result; one engine chunk or
  unusually large row still requires native `LIMIT`/`TIMEOUT` discipline. The installed SDK exposes
  no physical query cancellation, so the API does not offer a cosmetic abort signal. Arbitrary SQL
  has no safe generic resume point; resumable expert reads use caller-authored deterministic keyset
  pages and a durable application cursor, while whole-memory transfer uses native sync bundles.
- Provider disclosure is policy-gated, provider lineage is allow-listed, and credentials are absent
  from public types, durable call summaries, canonical records, and exports. Every disclosure and
  stored projection now carries the sorted unique union of opaque sensitivity labels from rendered
  alias sources, direct evidence, and iterative transitive derivation premises. Embedding batches
  partition by exact scope-and-sensitivity pairs; older generations fail closed until rebuilt.
  Original and policy-replaced payloads now pass exact stable-JSON byte and conservative or
  provider-counted token ceilings before policy/provider execution. Invalid counters fail closed;
  durable failures retain no payload or detailed measurement.
- Disclosure-policy waits now share the same hard race as provider capability calls. Deadline expiry
  is retryable `timeout`, caller abort is non-retryable `cancelled`, and a late policy result cannot
  invoke the provider. Storage and sync-peer waits remain deliberately cooperative: detaching a
  possibly committing database write would make timeout settlement ambiguous, so engine/transport
  timeouts and reconciliation stay at those layers.
- Caller-supplied identity semantics are closed per method. Request-bound replay covers derivation
  create/withdraw, correction, and grouped deletion; checkpoint/sync IDs bind resumable sessions;
  hard purge resumes only a running marker; all other durable mutation IDs are fresh-only.
  `remember` rejects a supplied replay ID unless it names the bound ingestion, dry-run import rejects
  an ID, reset accepts none because it removes the journal, and sync resolve/abort use `sessionId`
  alone. Runtime validation rejects excluded IDs rather than silently ignoring them.
- Space and scope checks run before lexical/vector top-K selection and are repeated before graph
  expansion, rendering, diagnostics, export, and remote-provider disclosure.
- Recall/search/neighborhood bracket canonical reads and provider-backed ranking with one space
  incarnation, physical revision, and evaluation instant; concurrent writes fail retryably rather
  than returning mixed context. Browse cursors additionally bind canonical request semantics,
  normalized access, reset generation, revision, evaluation time, and page boundary while allowing
  page-size changes. Open facades reject a replacement space generation until explicitly reopened.
- Scoped entity attributes remain episode-level assertions, and facts reconcile only inside an
  exact supporting-scope partition.
- Correction evidence, replacement activation, and prior-fact supersession share one
  revision-guarded canonical commit. Correction now uses the same indexed, work-admitted support and
  truth-maintenance planner as direct derivation governance; an injected commit failure leaves no
  partial correction, and every lost-race retry reauthorizes all direct support so newly hidden
  support fails closed.
- Canonical derivations bind a rule/version and exact fact/evidence premises to one conclusion at a
  caller-checked revision. Scope is the premise-scope union, positive fact cycles fail closed, and
  source withdrawal, supersession, deletion, explicit derivation withdrawal, and purge invalidate
  affected supports and retract unsupported conclusions recursively in the same commit. Rule
  evaluation remains outside the package. Purge also removes contaminated derivation replay
  payloads while retaining content-free operation tombstones that reject operation-ID reuse.
- `deriveFacts` commits 1..64 such conclusions as one bounded multi-head activation under one shared
  pre-batch state, access capability, revision, work budget, operation, commit, and semantic change.
  Ordered results replay exactly; invalid later members, aggregate limit failure, duplicate
  semantic/id/cardinality-one conclusions, combined cycles, cancellation, and revision races leave
  no earlier-member residue. Batch outputs cannot become same-batch premises, so this is not hidden
  rule scheduling or fixpoint evaluation.
- `withdrawDerivations` atomically retires a bounded current support set selected by intersecting
  derivation/rule/version/conclusion/time predicates. Scope, exact revision, strict named IDs,
  aggregate row/byte/node/edge work, and a required 1..1,000 `maxMatches` guard fail closed before
  mutation. One commit appends every withdrawal successor and runs the complete cascading
  truth-maintenance/projection closure; the request-bound operation replays the exact ordered result.
  `previewDerivationWithdrawals` executes the same selector planner without mutation and returns the
  complete deterministic support set plus exact work. A non-empty preview cursor binds space
  incarnation, access, selector, revision, and the ordered selected-ID digest; apply reselects and
  verifies those bindings before mutation. Empty selections expose no token, unchanged repeated
  previews are stable, and stale, reset, access, selector, revision, or selection drift fails
  retryably without residue. One-shot revision-checked apply remains available when a trusted host
  does not need a separately authorized preview.
- Canonical ingestion no longer exports the space before truth maintenance. Accepted-episode,
  identity, alias provenance, semantic/cardinality fact reconciliation, affected derivation support,
  and projection cleanup use point reads plus 16-row indexed keysets under public row, stable-byte,
  graph-node, and graph-edge ceilings. `IngestionReport.work` exposes the exact admitted plan;
  profile, per-call, and per-batch options can lower it. A 17-episode unrelated corpus, exact row and
  byte `N-1` failures, accepted-only atomicity, bounded retry, direct/worker IndexedDB, and installed
  Node/browser consumers are covered. Model-backed ingestion separately scans inference context in
  16-row pages under public row/byte limits, reports exact `contextScan`, and fails before provider
  disclosure. Exact `N-1`, no-export, bounded retry, direct/worker, and packed-consumer probes cover
  that path too.
- Automatic post-canonical projection assembly now has independent profile/per-call/per-batch
  `projectionScanLimits` and exact `IngestionReport.projectionScan`. Alias, evidence, distinct
  support-episode, existing replacement, and generated projection rows advance through 16-row
  keysets. Exact row/byte `N`/`N-1` proves failure settles partial at `projection_scan_failed`, keeps
  canonical truth durable, and commits no projection; direct/worker and packed Node/browser probes
  cover the public contract.
- Removed the remaining dormant unlimited retrieval/ingestion branches and made the facade's
  private generic storage-query type require an explicit `limit`. Completeness work must now enter
  a keyset helper at compile time; open-time purge/abandoned-operation recovery advances in 16-row
  pages, while active sync recovery caps its invariant check at two rows.
- Removed direct derivation's ineffective unreported lexical-build tail. `deriveFact` now ends at
  the atomic terminal canonical commit/projection invalidation, so it cannot throw after durable
  success; explicit `rebuildProjections` owns later derivative work and its public scan report.
- Direct single/batch derivation creation and withdrawal, fact correction/retraction, and single-episode
  deletion no longer export canonical memory or scan identity and projection tables. Point reads plus 16-row
  semantic-key, alias/provenance, logical-key,
  premise-array, conclusion, evidence, and affected-projection keysets expand only the checked
  dependency closure. Public stored-row/JSON-byte and graph-node/edge limits fail before mutation,
  reports expose exact admitted work, and a final revision check plus commit CAS prevents partial
  race winners. A 256-fact unrelated corpus, every limit dimension, alternative supports, revision
  reactivation, one-row atomic correction/retraction/deletion rejections, and independent-facade
  derivation activation/withdrawal, correction, retraction, and deletion commit races are covered. Alias episode filtering
  bounds facade transfer but does not yet have a dedicated SurrealDB index.
- `previewEpisodeDeletions` now provides the exact native inspect-before-apply boundary for grouped
  soft deletion. It shares filter/access/retention/time selection with `deleteEpisodes`, returns the
  complete deterministic bounded episode set plus exact work, and emits a cursor only for non-empty
  selections. The cursor binds space incarnation, access, normalized filter, revision, and ordered
  selected IDs; apply reselects before mutation. Malformed, stale, reset, access, selector, revision,
  or selected-set drift is retryable and residue-free. One-shot revision-checked apply remains for
  trusted hosts, while request-bound replay includes the cursor identity.
- Bounded hard purge uses point reads, 16-row keysets, fixed 1,000-ID predicate chunks, indexed
  signal target/basis and merge closure, exact public row/byte/node/edge work, and a shared
  initial/reopen planner. A one-row ceiling fails before marker creation without changing revision;
  interrupted recovery persists and reuses its ceilings without whole-space export; direct/worker
  SurrealDB and the packed consumer exercise the public work contract. Full journals and opaque
  operation diagnostics remain admitted O(n) scans, and the final canonical erase is one bounded
  atomic commit rather than a multi-commit stream.
- Merge and split now use one admitted indexed entity closure for visibility, whole-identity
  authority, exact-scope journal disclosure, related facts, and projection invalidation. Both expose
  `workLimits` and exact `EntityMergeReport.work`; a one-row ceiling leaves revision/entity/merge
  state unchanged, a 256-fact unrelated corpus cannot trigger whole-space export, and direct/worker
  plus installed-package execution covers merge and reversal.
- General hard-purge operation closure is tested for direct episode bindings, canonical/journal
  lineage, target-bearing results, conservative whole-space operation kinds, unrelated-operation
  preservation, interrupted-purge recovery, and canonical/projection race losers. Tombstones expose
  `diagnosticsState: 'purged'`, contain no episode/result/error/warning/provider-call payload, and a
  central facade commit guard rejects both late settlement and later operation-ID reuse. A raw
  corruption fixture proves `verifyIntegrity` reports a rehydrated tombstone as
  `invalid_operation_tombstone`.
- Completed operation IDs are globally sealed within a space. An adversarial remember fixture first
  demonstrates that reuse overwrote the original row, then proves the private run-binding guard
  rejects rebinding before accepting the second episode while legitimate ingest, purge recovery,
  rebuild, and sync transitions retain their binding. Public and packed-consumer checks verify the
  private token is not exposed.
- Available operation diagnostics retain deterministic first/last samples capped at 64 warnings and
  64 payload-free provider calls; warning/error text is capped at 2,000 UTF-8 bytes and
  `diagnosticsTruncated` records every reduction. Hostile-provider fixtures prove credentials in
  lineage extras, warning strings, exception messages, and branded error details never reach public
  reports or raw stored rows. A 66-call rebuild proves both caps, and raw injection of a call payload
  is reported as `invalid_operation`. Generic JSON validation now advances wide arrays/objects one
  child at a time with O(depth) traversal memory; a billion-slot sparse-array fixture reaches its
  node budget without materializing a width-sized worklist.
- Retained sync-session status now has the same explicit resource discipline: at most 64
  deterministic warning samples, 2,000-byte warning/error strings, a public optional `error`, and
  `diagnosticsTruncated`. A raw over-budget fixture first produces `invalid_sync_session`; the normal
  guarded detail-compaction transition then reduces it to the first/last sample, retains the bounded
  error, marks truncation, and restores a clean integrity report. Source browser and packed
  direct/worker consumers assert complete successful session diagnostics.
- A separate private-scope pull fixture removes the stored request/required scopes and substitutes a
  valid-format false root digest. An unscoped `syncStatus` call fails `integrity_failed` before any
  metadata disclosure, paged verification reports `invalid_sync_session`, exact restoration returns
  the row to clean state, and the full 40-case sync suite proves all legitimate receive, planning,
  conflict, apply, rollback, abort, compaction, and recovery transitions remain valid.
- Every facade driver commit now advances a private monotonic metadata revision even when the public
  logical revision is unchanged. Surreal transactions compare both counters, and `verifyIntegrity`
  checks the metadata counter before and after its canonical plus paged sync scans. `syncHistory` and
  `exportSyncBundle` now bracket every page with the same counter and carry it in snapshot-bound v2
  cursors; pre-v2 alpha cursors restart. Deterministic injected metadata-only HEAD updates prove an
  overlapping integrity check, inventory page, or bundle page fails safely, leaves the logical
  revision unchanged, advances the metadata revision, and succeeds on a clean retry. Existing
  schema-v7 spaces are additively backfilled to zero on open.
- Full projection rebuilds no longer delete the searchable generation first. They stage durable rows
  under hidden set ids, preserve the prior active set for any failed kind, and atomically switch all
  successful requested kinds with one space-row commit guarded by the exact canonical-source
  revision. Adversarial provider blocking proves durable staged rows stay invisible; an independent
  facade canonical write prevents activation; direct and worker SurrealDB execute the indexed
  active-set query path. Inactive crash/failure rows are non-authoritative, counted as stale, warned
  by integrity verification, and reclaimed in bounded pages by a subsequent full rebuild. Injected
  cleanup failure proves an already activated generation remains searchable while the operation
  settles partial at `cleanup_deferred`, reports stale rows, and a later rebuild reclaims them.
  Source targets now stream one at a time through 16-row keysets; selected aliases, evidence,
  provenance episodes, existing target rows, and generated projections share exact public row/byte
  admission. Targeted selection is capped at 10,000 unique ids and remains atomic. Exact `N`/`N-1`
  tests reject without active-set change, leave any earlier full-build rows hidden under a durable
  partial operation, reject whole-space export, and prove a subsequent retry reclaims them. Stale
  totals use native counts, while cleanup itself remains a separate 16-row bounded-memory pass.
  Projection maintenance now admits only one pending/running rebuild per space across full and
  targeted requests. The active-operation scan is pinned before a guarded fresh-operation commit,
  so same-snapshot contenders have one durable winner and an unbound residue-free loser, while a
  later contender fails before target/provider/staging work and names the live owner. Separate
  direct/direct, worker/worker, and mixed IndexedDB clients prove both schedules. They also terminate
  the owner page after hidden rows are durable but before activation, preserve recall through the old
  set, recover the abandoned operation as interrupted, and use the still-unbound contender ID to
  activate a complete set and reclaim every inactive row.
- Successful hard purge removes raw targets and idempotency keys while retaining a content-free
  marker with operation metadata, a request hash, and domain-separated hashes needed to prevent
  remember/import replay. Marker identity is separately domain-hashed to prevent id aliases.
- Every canonical semantic mutation atomically writes an exact-scope affected-target journal row.
  Cursors bind space incarnation and access; purge scrubs erased identifiers from affected-target
  fields and emits only content-free scope invalidation. Retained operation ids must be opaque,
  non-sensitive values and must not encode content or target ids.
- `compactChanges` requires exact space and revision confirmation plus an explicit `1..1,000` batch
  ceiling. Its preferred `registeredConsumers: true` mode derives the minimum safe watermark from
  every active durable local checkpoint and guards the final commit with the registry epoch.
  Registration, monotonic acknowledgement, bounded browsing, and explicit retirement are public;
  retired identifiers remain non-reusable tombstones. The stateless `consumerCursors` mode still
  validates `1..1,000` feed-discriminated v2 cursors, while a mutually exclusive raw revision
  remains an expert override. The destructive request is snapshotted before queueing. Compaction
  atomically advances a monotonic floor with indexed row deletion; cursors behind that floor fail
  closed and require a replacement snapshot.
- Format-v3 export no longer calls database-wide `exportRecords()`: it scans only canonical tables
  in 16-row keysets under physical row/byte work limits, then applies exact document record/byte and
  aggregate-node ceilings. Import checks document limits before collision work and separately bounds
  expanded target-local rows/bytes before its atomic transaction. A 17-episode fixture proves scan
  continuation, exact byte boundaries, no unbounded storage call, and no mutation on limit failure;
  larger whole-memory portability remains routed through resumable sync bundles.
- Scoped signals are immutable, versioned, explicitly non-epistemic records. Algorithm writes require
  an exact input revision, a visible non-empty declared basis, scope closure over target and basis,
  and a connected episode/fact grounding for every entity target or entity basis ID. Signals never
  become evidence, factual support, confidence, lifecycle state, implicit retrieval weight, or
  semantic-journal events. Per-value and whole-write JSON budgets plus a pre-deduplication aggregate
  scope/tag/basis budget bound batch amplification.
- Signal browse, put, and delete copy and validate their complete closed JSON request envelopes once
  before asynchronous reads or queued writes. The shared envelope ceiling is 1,000,000 nodes,
  depth 64, and 64 MiB of strings; operation-specific limits remain tighter. Immediate caller or
  accessor mutation cannot retarget access, filters, identities, basis, values, revisions, or
  destructive mode. Source, direct/worker Chromium, and packed Node/browser consumers exercise the
  boundary; unknown, unreadable, cyclic, non-plain, or malformed input fails before storage work.
- Signal target/basis validation now reads a storage-neutral addressed closure over exact records,
  temporal lifecycle, visible support, active merge components, incident facts, aliases, and
  mentions. Scalar predicates use 1,000-value chunks and 16-row keysets under `basisScanLimits`
  (100,000 rows/64 MiB defaults; 1,000,000 rows/256 MiB maxima). `PutSignalsReport.basisScan`
  exposes every returned row/byte; exact `N-1` failures report `signal_basis_scan`, leave the
  revision and signal plane unchanged, and retry at `N`. A 17-record unrelated corpus has identical
  work, while current-merge and known-at fact fixtures preserve temporal semantics.
- Checked `read({ kind, id, access, scanLimits })` point reads expose the value, revision/time
  lineage, and exact physical scan work for episodes, entities, facts, and derivations. Entity/fact
  provenance uses 16-row alias, evidence, derivation, and lifecycle keysets plus deduplicated support
  episode point loads; no unlimited relation query or whole-space export remains in the path. A
  17-episode fixture proves exact row/byte `N`/`N-1`, no partial value, and value-only bounded `get*`
  sugar; source, direct/worker, and packed consumers cover the public contract.
- `read`, `recall`, `search`, `neighborhood`, `browse`, `snapshot`, `analyze`, `changes`,
  `signalChanges`, and `export` now copy and validate one complete closed JSON request before purge
  coordination or any other await. The 1,000,000-node, depth-64, 64 MiB envelope is independent of
  tighter method limits. Source, real direct/worker IndexedDB, and installed Node/browser consumers
  mutate nested authority, filters, anchors, seeds, IDs, cursors, targets, and limits immediately
  after invocation; only the first accessor values are observed, while unknown fields fail before
  storage.
- Invocation ownership is now exhaustive across the public facade rather than limited to selected
  method families. Open flags/metadata, management and integrity limits, point-read convenience
  access/options, retrieval/feed/signal/archive options, and journal-consumer lifecycle/compaction
  capture one closed value before storage or queue work. Replacing `options.signal` later cannot
  switch cancellation authority; source, direct/worker SurrealDB, and installed Node/browser
  consumers prove this contract.
- Public JSON output is now explicitly caller-owned. Returned space, episode, report, and durable
  operation replay values remain detached from cached/storage state, while event dispatch creates
  an independent payload per listener. Adversarial source, direct/worker SurrealDB, and installed
  Node/browser consumers prove that returned-value and earlier-listener mutation cannot affect
  persistence or a later observer.
- Every public sync request is now a closed, bounded invocation-time snapshot before queueing,
  local storage, or peer work. The boundary covers checkpoint creation/export, both inventories,
  pull/resume, status, conflict list/detail/resolution, abort, and checkpoint/session compaction;
  standalone access and options are captured too. The peer and abort signal remain live
  capabilities. Source, direct/worker Chromium, and installed Node/browser proofs mutate access,
  confirmations, ids, strategy, cursors, cutoffs, and limits immediately after invocation and reject
  unknown fields without storage. Optional object `undefined` canonicalizes to absence for first-page
  cursors, while root/array `undefined` remains invalid.
- Signal selection resolves the latest global revision before access filtering, so a restricted
  caller cannot fall back to an older visible revision. Group withdrawal or purge requires a
  non-empty selector, exact revision confirmation, and a caller-declared match ceiling. Browse and
  direct governance use 16-record keyset scans with identity/access pushdown; output retains only
  lightweight candidates and point-fetches values under an exact 16–64 MiB canonical response
  budget. Full-set commitments fold fixed 1,000-ID chunks instead of retaining every ID.
- Direct signal purge also requires `maxRevisions` (10,000 default, 100,000 maximum), checks it with
  a native aggregate, and atomically deletes by logical-key range rather than generating one delete
  statement per revision. A 1,001-key adversarial fixture proves scan continuation, exact totals,
  response bytes, both breadth guards, and the single range mutation; direct and worker Chromium
  execute the real SurrealDB transaction.
- A non-empty constrained current active/non-expired browse can mint a signal-target selection
  cursor for explicit canonical deletion or erasure. Empty selections expose no destructive token.
  `deleteEpisodes.signalTargets` and
  `hardPurge.signalTargets` verify its filter, access, generation, revision, current expiry
  eligibility, full matching revision-set hash, and match ceiling; signal values never authorize or
  determine the action. Soft deletion accepts episode targets only and atomically writes their
  tombstones, withdrawn signal revisions, and separate same-revision semantic/signal journal rows.
- Every signal put, withdrawal, or purge atomically emits a separate scope-partitioned signal-change
  row. `browseSignals` supplies the access- and space-generation-bound baseline cursor;
  `signalChanges` provides bounded restart-safe deltas without values or truth semantics.
- `compactSignalChanges` has the same exact-space, revision, and breadth guards as semantic
  compaction, including registry-derived or feed-specific stateless minimum watermarks, with an
  independent monotonic floor. Semantic and signal registries are separate local operational state,
  omitted from archive and replica sync, retained through hard purge, and removed by reset.
- Canonical hard purge deletes the complete history of every signal key whose target or any declared
  basis revision references erased memory. Opaque signal values, labels, and producer metadata are
  not dependency-discovery fields; downstream algorithms must declare every dependency in the
  target or basis and must not hide private content there expecting purge discovery.
- `resetSpace` no longer exports every stored row to build its response. It natively preflights the
  episode/entity/fact/projection report count, streams those rows in 16-row keysets under the same
  public scan defaults/maxima, returns exact `ResetSpaceReport.scan`, and performs the whole-space
  delete only after stable revision fencing. Exact record/byte `N-1` tests preserve the space, then
  retry at `N`; source, direct/worker, and installed-tarball probes cover the contract.
- Hard purge also replaces any historical signal-journal partition naming an erased key with a
  content-free invalidation and emits a new scope-only invalidation, preventing the journal from
  becoming a recovery path for forgotten identifiers.
- Whole-memory sync exposes immutable content-addressed checkpoint headers and bounded independently
  checksummed chunks through a transport-neutral peer contract. Receiver progress is durable and
  pinned to exact local/remote heads; three-way reconciliation surfaces same-record,
  delete/modify, cross-branch positive-cycle, and cardinality-one conflicts for explicit resolution.
  Resume paths recheck the complete session scope boundary and are bound to the original strategy,
  access grant, revision, ancestry, and receive limits. Caller-controlled aggregate byte, record,
  and chunk budgets reject oversized remote headers before transfer and also bound merge staging;
  each chunk has a separate JSON-node ceiling. Chunk pages have a 16 MiB default and 256 MiB
  canonical-payload ceiling, never split a chunk, and protocol-v1 envelopes reject unknown fields.
  Operation IDs are session-bound before peer contact,
  conflict values use a separate bounded point read, and abort cleans partial receiver/plan assets.
  Portable purge markers strip caller-controlled operation IDs. Purge dominance follows support
  dependencies so a concurrent derived fact cannot survive after its only evidence was erased.
  Repeated logical-dependency decisions use a body-free 100,000-key memo with exact fallback;
  semantic validation retains at most two verified chunks (32 MiB maximum) while rechecking every
  index and record digest. Deterministic conflict rows commit in 128-row metadata batches and
  identical resolved rows are not rewritten. The 101-conflict stress case asserts one conflict
  batch and no more than 32 chunk reads during resolution.
  Iterative strongly connected components conflict only actual derivation-cycle participants and
  preserve downstream acyclic derivations.
  Random-access indexes are rederived from their owning verified portable record before any safe
  indexed read trusts their semantic fields. The central facade commit boundary now validates the
  complete chunk and requires exactly one deterministic index per record in the same atomic put;
  helper-level adversarial cases reject missing, index-only, duplicate, forged, and checksum-invalid
  packs before storage. A raw-metadata fixture separately forges a valid-shape target field, proves
  `verifyIntegrity` reports `invalid_sync_index_set`, restores the exact row, and then completes the
  original staged-session cleanup. Fixed-size paged scans additionally catch malformed chunks/index
  identities and aggregate missing, extra, or orphan index rows.
  A two-generation remote-history fixture proves a fresh pull retains the intermediate header as an
  explicit no-payload ancestor, can subsequently export the complete DAG, and remains integrity
  clean. An adversarial checkpoint/HEAD fixture then injects a future source revision, substitutes a
  valid-shape nonexistent chunk owner, and corrupts the ref timestamp; safe reads fail closed and
  paged verification reports `invalid_sync_checkpoint`, `invalid_sync_checkpoint_payload`, and
  `invalid_sync_ref` before exact restoration returns the database to clean state.
  A separate adversarial pack clones one verified chunk and rederives every random index under a new
  but unreachable owner. Hash, shape, count, and per-record index checks all pass, while owner-closure
  verification reports `orphan_sync_owner`; deleting a live conflict session likewise makes its
  conflict detail and merge-plan pack fail ownership checks before exact restoration returns clean.
- `openSyncBundle` now snapshots limits and cancellation once before I/O and copies every untrusted
  commit, checkpoint, and chunk frame in a single hard-bounded JSON traversal before validation,
  hashing, or retention. Accessor-backed frames that throw on a second read pass through the detached
  value in tests, while an unreadable first value fails `import_invalid`; verification still holds at
  most one bounded frame body.
- `compactSyncHistory` provides manual local checkpoint-payload retention without rewriting the DAG.
  It is scope-, space-, revision-, HEAD-, cutoff-, and cursor-bound; scans at most 64 headers per
  page; supports dry run; atomically marks selected non-HEAD payloads unavailable; deletes chunk/index
  owners in bounded batches; and completes interrupted cleanup on reopen. Headers remain available
  for ancestry. A divergent merge whose exact base payload expired fails with an explicit reseed
  requirement rather than silently degrading to a two-way merge.
- Checkpoint hashes detect corruption but do not authenticate a peer. Any transport adapter must
  authenticate and authorize whole-space access, enforce public chunk/body bounds, and supply
  encryption and replay protection appropriate to the data.
- The `/surreal` entry point exposes construction-time raw SurrealQL admin authority through the same
  serialized direct/worker scheduler; ordinary application storage has no raw method or elevation
  path. Query
  text/bindings are bounded, each call confirms its target, JSON responses have
  exact byte/node limits and a query hash, and statement failures remain visible in-band. Raw
  multi-statement queries are never retried or made atomic implicitly. The adapter consumes the SDK
  frame stream and admits each scalar/row before retention instead of collecting the whole result;
  because one engine chunk or large row can still materialize first, callers still need native
  `LIMIT`/`TIMEOUT` for potentially large queries. There is no SDK-backed physical cancellation or
  generic SQL resume contract; callers that need resumable reads author deterministic keyset pages
  and persist their own cursor. Raw writes to package tables also bypass the private metadata
  revision; production repair therefore requires writer quiescence, an explicit transaction, and
  post-repair integrity verification.
- `stats()` no longer materializes a whole-space export. Simple cardinalities use native filtered
  storage counts; latest-per-key, distinct-conflict, stale-projection, signal-revision, and
  provider-call metrics admit every transferred row and stable-JSON byte through advancing keyset
  pages capped at 1,000 records. `inspect()` uses a native pending-operation count and the same exact
  admission for stale projections. Both expose cancellable `ManagementOptions`; defaults are 100,000
  rows/64 MiB, hard maxima are 1,000,000 rows/256 MiB, and a breach returns no partial metrics.
  Inspection now resolves the persisted space incarnation and rejects reset/recreate drift instead
  of returning the facade's stale cache. A 1,001-row fixture, exact N/N-1 row and byte checks,
  cancellation/generation tests, direct/worker IndexedDB, and installed Node/browser consumers cover
  the public work report. Native aggregate work remains outside the transfer envelope and residual
  scans remain O(n); this is not yet a named-corpus latency qualification.
- `verifyIntegrity()` no longer calls whole-space export. It admits every distinct canonical,
  journal, projection, operation, purge, signal, and sync row under exact caller-lowerable
  row/stable-byte ceilings through 16-row keysets; potentially 16 MiB sync chunks use one-row pages.
  Active derivation cycle work has separate node/edge ceilings and uses an iterative walk. Retained
  issue details are capped independently, including summary-only mode, while total detected issues
  and `ok` remain complete. One-row rejection leaves revision unchanged, malformed operation rows
  prove detail truncation, metadata-only races still fail closed, and in-memory, direct/worker, plus
  packed consumers exercise the public work report. A deterministic independent-tab logical write
  also invalidates in-flight verification. The complete diagnostic remains O(n) and has no
  named-corpus latency or abrupt-crash qualification.
- Episode deletion and purge remove projections reached through evidence, mentions, and alias
  provenance without deleting independently supported canonical records.
- `AccessContext` is a data-filtering capability supplied by a trusted host. It does not authenticate
  callers, and the alpha facade is not safe to expose directly to an untrusted transport.

## Reproducible gates

Run from the repository root:

```sh
pnpm --filter @astrale-os/temporal-memory lint
pnpm --filter @astrale-os/temporal-memory typecheck
pnpm --filter @astrale-os/temporal-memory test
pnpm --filter @astrale-os/temporal-memory build
pnpm --filter @astrale-os/temporal-memory verify:sbom
pnpm --filter @astrale-os/temporal-memory test:browser
pnpm --filter @astrale-os/temporal-memory verify:package
pnpm exec oxfmt --check packages/temporal-memory docs/PRODUCT-temporal-memory.md docs/SPEC-temporal-memory.md docs/RELEASE-temporal-memory.md
```

Recorded locally on 2026-08-09 against this snapshot:

- temporal-memory lint, typecheck, build, and the 45-file package formatting check pass; the
  repository-wide formatting check also passes all 462 matched files;
- packed-consumer type proof covers the exact public format-v4 merge/count/manifest declarations,
  rejects a non-JSON raw-query result tuple, and the archive exporter uses an explicit merge
  projection rather than leaking storage records;
- the root test command serializes workspace packages so their independent Vitest pools do not turn
  DOM, browser/database, and 100,000-event workloads into host-contention timeouts. The complete
  workspace run passes 2,739 tests with 59 intentional Swarm skips; Temporal Memory contributes
  `270/270` tests across 16 files;
- deterministic SBOM generation and stale-file verification pass; CycloneDX CLI `0.32.0` validates
  the emitted document against CycloneDX 1.6, while the package verifier additionally checks the
  exact npm graph, standard complete/unknown relationship compositions, 337 unique Cargo
  components, applicable license set, distinct BUSL change dates, and exact WASM file hash;
- `pnpm audit --prod --audit-level high` reports zero npm advisories across the 49-package production
  workspace lock closure. Checksum-verified OSV Scanner `2.5.0` recognizes the SBOM's 344 npm/Cargo
  packages using locally downloaded advisory databases; the ten expected Cargo advisory classes are
  each documented and temporarily admitted through 2026-08-23, while a new or expired record fails;
- the Temporal Memory Vitest suite passes `270/270` tests across 16 files (`258` non-browser tests
  across 15 files plus twelve Chromium acceptances), including closed one-pass `createMemory`
  configuration and
  exact live-capability capture in source, direct/worker IndexedDB, and installed consumers;
  provider-raced recall; exact evidence- and fact-premise
  derivation invalidation, indexed sparse derivation planning, atomic multi-support rule/version
  retirement with strict explicit IDs, exact shared-planner preview and cursor-bound apply,
  current-revision-only conclusion/time intersection, request-bound replay, preview logical-race
  rejection, residue-free injected and real independent-client commit races, and all four derivation admission
  failures, bounded fact correction/retraction plus single/group and signal-selected episode deletion,
  including shared-planner group preview/cursor-bound apply, stable empty preview, and request
  snapshotting, and entity merge/split with exact work and unchanged-revision limit rejection, bounded hard-purge initial/recovery
  planning with pre-marker rejection, mixed-scope closure authorization, and a one-winner recovery
  claim race, frozen signal-preview
  expiry, a 256-fact no-export grouped-deletion corpus and replay, correction retry-time
  hidden-support authorization,
  sparse signal-basis work invariant under unrelated corpus growth, direct-evidence incident-scan
  short-circuiting, current entity-merge resolution, and known-at fact lifecycle reconstruction,
  feed-discriminated v2 semantic/signal cursors, durable local consumer
  registration/acknowledgement/retirement and registry- or cursor-derived multi-consumer
  minimum-watermark compaction with stale/wrong-feed/wrong-generation/breadth rejection,
  epoch-guarded races, acknowledging-page termination and fresh-client recovery, reset cleanup, and
  pre-queue request snapshotting, one-pass closed signal browse/put/delete, core
  read/analysis/feed/export, exhaustive open/management/point/integrity/journal option ownership,
  detached returned values and per-listener event payloads, and complete sync-control-plane request
  detachment with
  unreadable-accessor, unknown-field, and
  immediate nested-mutation proof, incremental raw-query frame admission before whole-result
  collection,
  alternative support/current-revision reactivation, recursive support maintenance, no-partial
  derivation, correction, retraction, single-deletion, and grouped-deletion commit races,
  point/aggregate read races, browse request/access binding, clock-stable paging, same-revision
  reset/recreate invalidation,
  malformed-Unicode rejection, closed format-4 all-section property/shape/cross-space/ordering and
  million-node pre-target-read rejection, storage-native filtered episode keysets, pinned interrupted sync
  transfer, aggregate remote/merge admission, explicit divergent/cross-record reconciliation,
  transitive purge dominance, operation/session binding, partial-staging cleanup, tamper rejection,
  fail-closed rollback, bounded checkpoint-payload compaction, expired-base reseed refusal,
  compaction crash-marker recovery, sync-apply reopen recovery, and native persisted-bundle
  rejection of missing, corrupted, or post-verification-mutated frames, deterministic weighted
  personalization, hidden-seed refusal, physical recall/residual-browse/snapshot/analysis
  row/exact-byte admission at `N` and rejection at `N-1`, 16-row/no-export large-corpus scans,
  linear graph expansion, mid-scan write conflict, historical
  signal-revision admission, record/graph/PageRank/temporal-work admission failures,
  bounded severity-first finding samples with complete truncation counts, and prototype-like
  diagnostic distribution keys, bounded/redacted operation diagnostics, O(depth) JSON validation,
  provider-call payload corruption detection, exact byte-bounded conflict pages, fixed-size
  resumable conflict cursors, privileged conflict-row rejection, and explicit compacted-detail
  expiry, exact bounded/no-export integrity row and byte admission, summary-only and truncated issue
  reporting with complete failure state, forged purge-tombstone fail-closed rejection, paged metadata-integrity detection,
  pre-storage exact chunk/index commit-pack rejection, and logical-plus-metadata snapshot fencing for
  checkpoint inventory and bundle pages, hidden projection-set staging, atomic generation cutover,
  ordered schema migration, interruption resume, concurrent-open convergence, checksum/newer-schema
  rejection, failed-generation preservation, projection rebuild physical row/exact-byte admission
  at `N`/`N-1`, streaming no-export recovery, and canonical-source race rejection, plus adversarial
  merge/canonical/projection/purge-selection races that prove stale plans cannot recreate purged
  data, and exact statistics/inspection row and byte admission at `N`/`N-1`, metadata-only stats
  race rejection, inspection cancellation, zero-work closed inspection, and reset/recreate
  generation rejection;
- the real Chromium acceptance passes `12/12`: the complete single-page case exercises direct and
  module-worker engines,
  proving non-ASCII cursor order matches SurrealDB, signal browse/put/delete plus core
  read/analysis/feed/export request detachment, exhaustive open/management/point/integrity/journal
  option ownership, detached public outputs and per-listener event delivery, and verifying raw-admin
  separation, target, binding,
  result-bound, statement-failure, generated-transaction rollback and same-connection reuse,
  lifecycle, bounded derivation create/preview/cursor-bound withdrawal/reactivation,
  bounded fact correction/retraction/single-episode deletion and limit rejection, exact grouped
  episode-deletion preview/cursor-bound apply, exact bounded
  signal-selected soft-deletion work, bounded format-4 canonical export plus re-signed
  episode-identity and unknown nested-property rejection, physical recall/neighborhood/
  residual/native-browse/projection-rebuild/snapshot/analysis scan reporting/rejection, bounded
  statistics/inspection scan reporting/rejection, bounded integrity rejection/reporting, and persisted
  checkpoint-payload compaction behavior in both modes, including bounded personalized PageRank over
  a visible entity seed; the independent-context case uses two same-origin pages and separate
  IndexedDB/WASM clients to prove one-winner guarded signal put CAS, no loser rows, explicit retry
  convergence, and one-winner same-preview signal withdrawal/purge with exact journal actions and no
  loser residue. Exact filter-selected episode-deletion previews also reject logical races, and two
  clients applying one group cursor have one atomic winner, one retryable residue-free loser, stable
  cross-client winner replay, and empty/no-cursor re-preview. A post-target-read late signal dependency makes hard purge fail before marker,
  operation, or erasure; explicit retry replans and erases it. Distinct purge IDs paused from one
  revision have one marker winner and one residue-free conflict; a contender against an already-live
  marker fails before planning and names its owner. Both losers remain unbound and succeed after
  explicit replan/retry across every engine pairing. Signal-target canonical actions add disjoint
  soft-delete one-winner contention with residue-free rebaseline/retry and both deterministic winner
  directions for soft delete versus hard purge from one cursor; no loser operation, lifecycle,
  marker, canonical row, or journal effect remains. After both clients read the same
  projection admission revision, exactly one rebuild binds and stages while the loser leaves no
  operation or projection row and can reuse its still-unbound ID after settlement. A separate live
  rebuild rejects its contender before target/provider work, continues recall through the old set,
  and survives actual owner-page termination after hidden staging: reopen records interruption and
  the contender rebuild atomically activates and reclaims all inactive rows. Both schedules run
  direct/direct, worker/worker, and mixed. Migration clients paused before the same `5 -> 6` step
  converge on one exact two-checkpoint chain; actual owner-page termination after that complete step
  exposes one valid schema-6 checkpoint, and a fresh client resumes to 7 and reopens cleanly. Both
  schedules use the same engine matrix. Destructive reset is separately paused at its guarded
  delete: writer-first preserves both the prior corpus and complete new write, then makes reset fail
  retryably until a full explicit retry; reset-first removes the space and makes the delayed writer
  fail `space_not_found` without operation, lifecycle, canonical, or journal resurrection. Both
  winner directions use the same three engine pairings. After one client registers a durable local
  semantic- or signal-journal consumer visible to the other and both read the same registry-derived
  compaction batch, one atomic commit advances only that floor while its
  retryable loser changes neither journal; both clients converge and the old cursor fails with the
  correct baseline contract. Distinct reasoner evaluations paused at commit produce one canonical
  derivation winner and one residue-free loser; cross-client winner replay is stable, losing-ID
  re-evaluation adds no duplicate support/change, and racing withdrawal atomically retracts a
  two-level unsupported chain. The same matrix proves reset/recreate fencing and logical-race
  rejection for snapshot, recall, checked point read, browse, neighborhood, analysis, bounded archive
  export, integrity, signal browse, and both journal pages after an overlapping write. Statistics and
  inspection separately reject overlapping metadata-only checkpoint work across direct/direct,
  worker/worker, and mixed engines; persistent open fails closed without Web Locks while `mem://`
  remains usable. A separate case opens an observer while ingestion is paused after durable
  acceptance, proves the live owner's operation is untouched, terminates the owning page without
  `close()`, and verifies fresh-client interrupted-operation recovery plus explicit retry across all
  three engine pairings. A second owner-death case pauses after the first durable sync-apply diff,
  proves the observer cannot steal the live operation, terminates the owner page, and completes the
  locally pinned checkpoint without the original peer across the same engine pairings. A third sync
  case releases two identical activation commits from the same revision, proves exactly one durable
  owner plus one retryable residue-free loser, and verifies terminal replay convergence;
- the packed-consumer verifier installs into an isolated store, fetches the public WASM release
  asset, verifies its package/core metadata and exact WASM hash, byte-compares the generated and
  installed CycloneDX 1.6 SBOM, checks its exact npm graph, 337-component Cargo inventory, mixed
  license boundaries, and WASM file binding, and typechecks public declarations
  including active projection-set lineage, `ManagementOptions`, `PhysicalScanWork`, and exact
  episode-deletion preview/cursor-bound apply, and passes
  Node plus direct/worker
  browser smoke, including full lexical set cutover with projection scan work/rejection, raw
  SurrealQL, installed-package closed archive-schema rejection, exhaustive facade option snapshots,
  detached public outputs/listener payloads, and bounded recall/browse/
  neighborhood/statistics/inspection/integrity/snapshot/analysis/correction/retraction/single/group
  deletion, including native group preview/apply, and registered semantic/signal consumer lifecycle and compaction execution from the
  installed package, plus the guarded signal race/retry, feed-floor, and
  reset fence across two installed mixed direct/worker pages;
  and
- the dependency fork itself passes Biome over 259 files, version alignment, a byte-stable
  337-component locked Cargo license inventory, exact packed-content checks, a reproducible package
  hash, and its
  four-case direct/worker by memory/IndexedDB Chromium matrix.

The Temporal Memory gates above are local artifact results. The dependency-fork results are also
backed by the two exact-commit remote CI runs linked in the dependency decision; neither constitutes
a Temporal Memory repository CI run until this source snapshot is pushed.

The browser gate creates the full Surreal schema and indexes, ingests canonical data, derives a
fact, withdraws and reactivates another logical support, rejects an under-budget graph walk,
rejects one-row fact correction, retraction, and episode deletion without advancing revision,
completes all three bounded retries, and
writes a scoped signal; it closes the first runtime, opens a fresh direct or module-worker
connection to the same unique IndexedDB store, and verifies lifecycle, derivation, both journals,
signal persistence, lexical recall, filtered `id`/`oldest`/`newest` episode keysets and coherent
lineage, physical scan work plus fail-closed ceilings for recall, neighborhood, residual entity
browse, native episode browse, statistics, and inspection, injection resistance, schemafull
active/inactive merge-envelope
queries through the real storage driver, atomic
full-set signal-target soft deletion/withdrawal; complete signal-target selection purge and
dependency closure; semantic- and signal-journal purge scrubbing; bounded compaction of both
journals from their feed-specific baseline cursors across a third fresh connection; old-cursor
invalidation; both compaction floors;
signal/statistics retention; serialized concurrent access to the shared WASM engine; and a complete
checkpoint transfer to an independent IndexedDB replica whose HEAD, signal/derivation history,
integrity, and purge replay denial survive reopen in both engine modes; then it creates a newer HEAD,
compacts the prior checkpoint payload, and proves the immutable old header plus unavailable-payload
state survive another fresh connection. It then pages checkpoint/session inventory, compacts
terminal session detail, proves checkpoint-owned chunks remain readable, and rechecks the compacted
detail state after another direct/worker reopen. The same direct/worker path exports the current HEAD
through bounded bundle pages, opens the result through the native one-chunk-at-a-time bundle
verifier, and verifies complete header/chunk/commit framing.

A separate ingestion crash-recovery case pauses immediately before canonical commit after its
acceptance operation, episode, lifecycle, and journal row are durable. Opening another facade leaves
that live owner unchanged. Closing the owning page without running package cleanup releases its
private runtime-owner Web Lock; observer reopen then writes one partial/interrupted operation and a
fresh `retryEpisode` operation completes the canonical fact without duplicating acceptance. The
schedule passes direct/direct, worker/worker, and mixed. In-memory gates separately prove a second
facade does not resume a marked hard purge or active sync apply while their owner is live, and
explicit sync resume fails closed. Two simultaneous ownerless hard-purge recovery claims from the
same revision additionally yield one owner, one terminal canonical commit, and one journal transition.

A separate hard-purge crash-recovery case creates real checkpoint metadata, then terminates owners
after the running marker commit, between bounded sync-metadata deletion batches, immediately before
the final canonical transaction, and immediately after a recovery-owner claim. Another facade stays
behind `purge_in_progress` while either original or recovery owner is live. Reopen wins one
revision-CAS claim and resumes forward; even a second claimant death converges on complete sync and
selected canonical erasure, one content-free marker and semantic change, integrity, and replay denial
across direct/direct, worker/worker, and mixed engines. Physical death inside the final transaction
is not exercised.

A separate hard-purge contention case pauses distinct operations and targets from the same revision
before marker commit. Exactly one revision-CAS marker wins; the loser receives retryable `conflict`
without operation, marker, owner, canonical, sync-metadata, or journal residue. Its second schedule
holds the winner after its durable marker; the contender receives retryable `purge_in_progress`
naming that winner before target/dependency planning and remains unbound. After the winner settles,
explicit replan/retry completes the loser, preserves two distinct semantic transitions, and passes
integrity across direct/direct, worker/worker, and mixed engines.

A separate sync crash-recovery case proves the active session and running owner operation exist in
one commit, pauses after the first complete journaled apply transaction, and leaves a second facade
behind the `sync_in_progress` barrier while that owner remains live. Actual owner-page termination
then lets observer reopen claim the operation and finish the already received checkpoint without the
original peer across direct/direct, worker/worker, and mixed. Deterministic instrumentation also
proves completed operation, guarded HEAD, and terminal session publication share one commit. These
cases qualify facade liveness and those exact transaction boundaries, not browser-process or
database-worker death during a physical transaction.

A separate rollback crash-recovery case injects a failure before the second forward logical commit,
then pauses after the first complete inverse rollback transaction. A second facade remains behind
`sync_in_progress` and cannot restart or steal that live rollback. Actual owner-page termination
lets observer reopen claim the same operation, finish from the retained local checkpoint with the
source page gone, atomically restore the local HEAD and terminal `aborted` session, and retain exactly
one forward plus one inverse journal record across direct/direct, worker/worker, and mixed engines.

A separate contention case lets one facade fully stage and pause the session immediately before
activation, independently advances a second facade to the same boundary, and releases both commits
together. Direct/direct, worker/worker, and mixed execution produce one succeeded owner and one
retryable `conflict`; the loser writes no extra operation or journal transition, source records are
applied exactly once, HEAD and integrity are coherent, and replay from the loser returns the durable
winner report.

A separate same-origin two-page matrix opens distinct SurrealDB clients against one IndexedDB
endpoint. Direct/direct, worker/worker, and mixed clients race guarded signal writes from the same
revision; exactly one commits, the loser is retryable, and neither a partial signal nor journal row
appears. Explicit retry converges both clients. Identical same-preview signal withdrawals and
retained-key purges likewise yield one winner, one retryable loser, one journal action, and no loser
residue. A separate nine-schedule target-action matrix pauses disjoint signal-selected soft deletes
and both winner directions of soft deletion versus hard purge before their first commits. One
physical-revision action wins completely; every loser carries `requiresSignalBaseline` and leaves no
operation, lifecycle, marker, canonical, semantic-journal, signal-revision, or signal-journal
residue. Disjoint work explicitly repreviews and succeeds with its unbound operation ID, while
consumed and empty selections expose no destructive cursor. A hard purge paused after its real target read rejects a late signal dependency before
creating an operation or marker or erasing data; explicit retry replans and erases the dependency.
For the signal journal, compaction first pauses after its bounded registry scan while another client
advances the registered checkpoint. The stale plan fails retryably without moving the floor or
deleting a row; immediate termination of the acknowledging page is followed by a fresh opener that
observes the advanced checkpoint. For each journal, a durable local consumer registered through one
client is then observed by the other, and both clients pause after the same bounded registry-derived
compaction read. Release yields
one exact atomic delete/floor winner and one retryable loser, neither operation mutates the other
journal, both clients converge, and the old cursor fails with the feed-specific baseline contract.
Two reasoner evaluations are also paused after complete planning: one canonical root derivation wins,
the loser leaves no fact/support/operation/change, winner replay from the other client is read-stable,
and explicit losing-ID re-evaluation records only `supported`. Two complete two-conclusion batch
plans are then paused at commit: one operation/revision/change winner contains both facts and
supports, the loser is residue-free, winner replay is stable, and explicit loser re-evaluation
returns two ordered `supported` results without duplicate support or change. After deriving a
dependent conclusion, two single withdrawals yield one tombstone and one loser; the winning commit
invalidates the dependent support and retracts both unsupported facts. A separate pair of complete
two-support rule/version retirement plans is created from one exact preview cursor and yields one
atomic batch winner and one unbound, residue-free loser. Winner replay is exact; because the winning
selector exhausts current support, loser re-preview returns an empty set with no cursor and one-shot
re-evaluation at the new revision fails `not_found` rather than recording a false no-op. A separate
logical-read schedule pauses retirement preview after its real derivation query and proves a
concurrent writer forces retryable rejection rather than returning a mixed or stale commitment.
The same logical-read schedule covers `previewEpisodeDeletions`. Two clients then apply one exact
two-episode filter selection from the same preview revision: one operation commits both tombstones,
lifecycles, and the semantic change, the other fails retryably without an operation or partial row,
winner replay is stable from the losing facade, and a fresh preview returns empty with no cursor.
Integrity remains valid.
Reset/recreate forces the stale facade to close and reopen. A test-only gate after a real physical
query lets the other page commit deterministically: snapshot, recall, checked point read, browse,
neighborhood, analysis, bounded archive export, integrity, signal browse, and both journal pages reject
the logical race, while statistics and inspection reject checkpoint-only private-metadata drift
without a public revision change. A context with Web Locks masked proves persistent open fails closed
and `mem://` remains available. The gates are evidence instrumentation, not production APIs.

The package gate builds and packs the publish artifact, installs it into a clean temporary
consumer with an isolated package store, fetches and hash-checks the pinned WASM release, verifies
publish-time exports and required files, byte-compares the installed `dist/sbom.cdx.json` with the
deterministic build output, and checks its complete resolved npm graph, 337 unique locked Cargo
components, distinct BUSL change dates, and exact WASM file hash. It then typechecks public
declarations including single and batch derivation activation, exact
retirement preview/cursor-bound withdrawal,
integrity, correction, retraction, merge/split, disclosure sensitivity/byte/token limits, and exact
single/group episode deletion preview/work/cursor contracts, runs a bounded
in-memory ingest/derive/derive-batch/preview-withdrawal/withdraw-batch/correct/retract/merge/split/delete/preview-delete-group/signal/signal-target-delete/signal-target-purge/semantic-change/signal-change/
compaction/export/dry-run/import/sync/recall cycle, restores maintained derivations from a format-4
archive, typechecks the public sync peer/checkpoint/request/report contracts, and verifies direct
plus module-worker IndexedDB close/reopen and independent replica sync including persisted
derivations, signals, analysis, both journals, the local consumer lifecycle, both journal compaction APIs, checkpoint-payload
compaction, checkpoint/session inventory, terminal-session-detail compaction, and privileged
raw-query types and execution from the installed tarball. The installed consumer additionally proves
dependency-derived inference sensitivity and provider-aware token rejection before provider
execution. It also executes and declaration-checks
bounded committed sync-bundle export plus native `SyncBundleReader`/`openSyncBundle` verification,
and declaration/runtime checks for bounded snapshots, personalized analysis plus physical row/byte
scan work, exact bounded statistics/inspection work, complete bounded integrity work, and fail-closed bounded
correction/retraction/merge/split/single/group deletion, from the installed package.
The installed browser consumer also repeats the two-page guarded signal race, explicit retry,
persisted signal-compaction floor, and reset/reopen fence with one direct and one worker client.

## Production-release gates still open

- Extend the implemented independent-client hard-purge pre-marker late-dependency fence, distinct
  one-winner start contention, and one-winner ownerless recovery claim to physical death inside the
  final canonical transaction. Actual owner termination after marker creation, between metadata
  batches, before final commit, and after a recovery claim now passes every engine pairing. Legacy
  completed purge markers without hashes cannot be retroactively protected from idempotency replay.
- Extend the implemented additive schema-5/6-to-7 migration from independent same-step contention
  and owner-page death after a complete step to physical process/database-worker death inside the
  transaction, and ratify backup/support windows; add separately specified restartable canonical
  row-transforming and ontology migrations if a future schema requires them. Downgrade remains
  refused.
- Extend the implemented durable local consumer registry from committed-acknowledgement owner-page
  termination to browser-process/database-worker death during a physical commit, and decide whether
  cross-device ownership or incarnation-safe retirement-tombstone reclamation is required. There is
  intentionally no clock lease that can discard an offline consumer. Signal acknowledgement versus
  stale registered compaction, semantic/signal feed assembly, and deterministic registered
  same-batch compaction contention now have direct/direct, worker/worker, and mixed-client proof.
- Qualify the implemented bounded recall, neighborhood, residual browse, addressed signal-basis
  closure, and destructive-reset accounting with named browser corpora, then push canonical filters
  and bounded graph neighborhoods into SurrealDB only where measurements justify the physical
  coupling. Canonical ingestion, inference-context assembly, signal-basis validation, and affected
  truth maintenance now have bounded sparse plans; reset remains deliberately whole-space but
  streams its bounded report after native preflight. Integrity remains O(n) and still needs named-corpus
  latency/memory qualification. Hard purge's complete
  journal/opaque-diagnostic scans and atomic final
  commit still need named-corpus and abrupt-kill qualification. Remove the descending
  IndexedDB table-iterator fallback only with measured, browser-proven query planning.
- Ratify archive-format and ontology migration policy. Selective format 4 intentionally remains one
  bounded, independently verifiable canonical document rather than duplicating the replica protocol;
  large resumable whole-memory transfer uses paged content-addressed sync bundles. Format 4 rejects
  all-section property/shape/cross-space/ordering mutations plus a million-node corpus before target
  reads, carries and verifies every episode identity preimage, and rehashes collision-remapped
  episodes.
- Qualify sync against hostile peers, transport replay/substitution, independent contexts, quota
  exhaustion, large histories/graphs, and named memory/latency/disk-amplification targets; ratify an
  offline-peer/reseed and automatic retention policy around the manual payload-compaction primitive;
  add bounded checkpoint/session-header collection beyond the implemented terminal-detail cleanup
  and at least one authenticated encrypted bundle/transport adapter. Runtime-owner fencing now
  rejects open-time and explicit resume of an apply owned by another live facade; actual
  post-first-diff IndexedDB apply and rollback owner death resume across all engine pairings, and
  same-session activation has one residue-free winner. Physical mid-transaction termination remains
  unqualified.
- Exercise persistent browser restart, quota exhaustion, corruption, and crash failpoints. Extend
  independent-context contention beyond the implemented guarded signal put/withdraw/purge,
  signal-target canonical delete/purge, hard-purge pre-marker late-dependency fence, distinct-start
  contention, and every durable owner-death recovery phase, derivation
  single and two-conclusion-batch create/replay/re-evaluation plus single withdraw/cascade,
  post-accept/pre-canonical ingestion termination and retry, post-first-diff sync-apply and rollback
  termination with peer-independent completion, signal acknowledgement versus registered
  compaction plus acknowledging-page recovery, both journal compaction races,
  destructive-reset/canonical-writer contention in both winner directions, reset fence, complete-read
  logical-race, and statistics/inspection metadata-race matrix to other governance and physical
  mid-write termination. Projection cutover and additive migration now have their own independent
  contention and between-transaction owner-death matrices.
- Decide and implement the remaining signal portability and consumption boundaries: there is no
  signal archive/import section, expiry scheduler, automatic/general recommendation action loop,
  non-erasure entity/fact action, retrieval-scoring plug-in, or cross-device/automatic
  acknowledgement service. Exact episode-target soft deletion is implemented and remains explicitly
  host-invoked.
- Extend the current sparse unrelated-corpus proof into named population-scale latency/memory and
  abrupt-crash qualification, then decide from demonstrated consumers whether the public contract
  needs temporal applicability bases, iterative fixpoint scheduling across the implemented atomic
  multi-head commits, stratified negation, aggregation, or existential identity creation. Do not put
  a rule-language interpreter into the storage package by default.
- Refresh the WASM fork to remove the seven fixed-version Cargo advisories, replace or explicitly
  approve the two unmaintained crates, and remove or prove the unpatched `rsa` path unreachable;
  otherwise the 2026-08-23 exceptions must not be renewed as release waivers. Approve the mixed-
  license runtime; decide whether to publish the resulting tagged Astrale WASM candidate to npm; and
  add signed publication/provenance plus registry-name install verification if npm is chosen.
  Deterministic CycloneDX build, packed-artifact verification, npm audit, scheduled offline OSV
  policy, and weekly dependency proposals are complete; organizational SBOM ingestion/retention
  remains a release-process decision.

Until these gates pass, the package is an evaluation alpha even when every current test is green.
