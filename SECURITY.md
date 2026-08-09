# Security policy

## Supported versions

This repository is pre-1.0. Security fixes are applied to the latest published prerelease only.
Older snapshots and unpublished branches are not supported distributions.

## Reporting a vulnerability

Use the repository's private GitHub Security Advisory flow. Do not open a public issue or include
secrets, production data, credentials, or personal data in a report.

Include, when possible:

- the affected package and exact version or commit;
- runtime, storage engine, and browser or Node.js version;
- a minimal reproduction and expected security boundary;
- impact, required privileges, and whether the behavior crosses spaces or scopes;
- any known workaround.

Maintainers should acknowledge a complete report within five business days. Remediation timing
depends on severity and reproducibility. A coordinated disclosure date will be agreed before public
release notes are published.

## Dependency vulnerability policy

The release build emits `dist/sbom.cdx.json` with the resolved production npm graph, the complete
locked Cargo inventory shipped by the embedded WASM dependency, and the exact WASM hash. CI runs
both `pnpm audit --prod --audit-level high` and checksum-pinned OSV Scanner over that SBOM. OSV's
public advisory databases are downloaded first and the candidate is then scanned in offline mode;
the repository inventory is not sent to an advisory query service.

An ignored OSV record is not a claim that a dependency is safe. Every exception must name the exact
advisory, explain the required resolution or reachability evidence, and include a near-term expiry.
The current inherited-Cargo baseline expires on 2026-08-23 and blocks package publication until it is
resolved or explicitly approved from current evidence. A new or expired finding fails CI, and the
complete gate runs weekly even without a source change. The npm workspace and GitHub Actions receive
weekly update proposals, but the URL-pinned WASM/Cargo graph requires a separately reviewed fork
build.

## Temporal-memory boundary

`AccessContext.allowedScopes` is not an authentication mechanism. Hosts must derive it from a trusted
principal and keep storage capabilities away from untrusted callers. Reports involving scope
laundering, cross-space access, export/purge authorization, provider disclosure, archive parsing,
IndexedDB isolation, or SurrealDB query injection are security reports.

`SurrealMemoryStorage.rawQuery()` is a database-wide administrator capability and is deliberately
outside the `AccessContext` boundary. It must remain disabled for untrusted callers. Enabling it,
passing exact target confirmation, or using parameter bindings does not make arbitrary query text
safe. Raw mutation of package-owned `tm_*` tables bypasses revision guards, journals, purge closure,
projection invalidation, and sync integrity; applications should reserve raw writes for their own
tables unless operating a controlled migration or repair procedure.

`compactSyncHistory()` is also trusted maintenance. It permanently removes selected local
checkpoint payloads while retaining content-addressed headers and ancestry metadata. It is not a
privacy erasure API: use `hardPurge()` for erasure, which invalidates all local sync history before
canonical deletion. Keep compaction behind whole-space authorization, choose its cutoff from the
supported peer-offline/reseed policy, and treat `details.requiresReseed` as a fail-closed operator
event. Do not expose its exact space/revision/HEAD confirmations as proof that an untrusted caller is
authorized.

`syncHistory()`, `syncSessions()`, and `compactSyncSessions()` expose or reclaim replication
metadata and must receive the same host-derived scope grant. Terminal-detail compaction preserves
checkpoint-owned payloads and session idempotency headers, but its conflict/tombstone deletion is
irreversible local maintenance. Exact space/revision/HEAD confirmation is a concurrency guard, not
administrator authentication.

`exportSyncBundle()` discloses a whole logical checkpoint plus ancestry metadata. Keep it behind
whole-space authorization and protect persisted frames with the host's confidentiality, integrity,
and replay controls. The final digest chain detects accidental or hostile frame modification but is
not a signature. Use `openSyncBundle()` over a durable frame-oriented `SyncBundleReader` rather than
exposing a store directly as `MemorySyncPeer`; it rejects gaps, extra/incomplete frames, commitment
and manifest mismatches, oversized admitted bundles, and post-open frame mutation. The reader still
owns safe framing and must not parse an entire untrusted container before returning one bounded
frame. Exact space confirmation, native validation, and a final `commit` frame do not authenticate
the exporter or importer or provide encryption/replay protection.
