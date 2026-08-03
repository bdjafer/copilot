# Temporal Memory baseline release evidence

Date: 2026-08-03

## Dependency decision

- `@surrealdb/wasm` is pinned to `2.3.5`.
- `surrealdb` is pinned to `2.0.0-alpha.14`.
- Both installed package manifests declare `Apache-2.0` and the SurrealDB JavaScript repository.
- The lockfile records the exact pair. The alpha SDK declares a TypeScript 5 peer range while this
  workspace uses TypeScript 6.0.3; package typechecking and declaration generation pass despite that
  peer warning.
- Upgrade is blocked on the same direct-and-worker IndexedDB acceptance harness. WASM 3.0.2/3.0.3
  failed IndexedDB startup in this harness, while 2.4.0/2.6.1 hung during IndexedDB index creation.

## Security boundary

- The reference adapter accepts only `indxdb://` and `mem://` endpoints.
- WASM capabilities disable scripting, guest access, and network targets.
- Application values use bound query variables; the Chromium harness stores and recalls hostile SQL-
  shaped text without executing it.
- Provider disclosure is policy-gated, provider lineage is allow-listed, and credentials are absent
  from public types, durable call summaries, canonical records, and exports.
- Space and scope checks run before retrieval candidates enter ranking, graph expansion, rendering,
  diagnostics, or remote-provider disclosure.

## Reproducible gates

Run from the repository root:

```sh
pnpm --filter @astrale-os/temporal-memory lint
pnpm --filter @astrale-os/temporal-memory typecheck
pnpm --filter @astrale-os/temporal-memory test
pnpm --filter @astrale-os/temporal-memory build
pnpm --filter @astrale-os/temporal-memory test:browser
pnpm exec oxfmt --check packages/temporal-memory docs/PRODUCT-temporal-memory.md docs/SPEC-temporal-memory.md docs/RELEASE-temporal-memory.md
```

The browser gate creates the full Surreal schema and FTS indexes, ingests canonical data, closes the
first runtime, opens a fresh direct or module-worker connection to the same unique IndexedDB store,
and verifies lifecycle persistence, lexical recall, and injection resistance.
