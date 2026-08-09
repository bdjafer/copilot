# Contributing to exp-spec

Short version: **pnpm at the root, `ox` tooling only, and the spec is written before the code.**

---

## Setup

```sh
pnpm install     # ALWAYS at the workspace root — never inside a package
```

Requirements: Node ≥ 22, pnpm ≥ 10 (the repo pins `packageManager`, so `corepack` picks the
right one for you).

That is the workspace development floor. The published Temporal Memory runtime supports Node ≥ 20;
CI verifies its packed Node consumer separately from the full Node 22 workspace gate.

---

## Tooling

**Never use `prettier`, `eslint` or `tsc`.** Every config in this repo re-exports
[`@astrale-os/ox`](https://www.npmjs.com/package/@astrale-os/ox), which is where lint rules and
formatting live.

| Command | What it runs |
|---|---|
| `pnpm lint` | `oxlint .` |
| `pnpm lint:fix` | `oxlint --fix .` |
| `pnpm typecheck` | `tsgo --noEmit`, recursively |
| `pnpm test` | `vitest run`, recursively |
| `pnpm build` | workspace production builds plus `tsgo` declarations; the comment libraries emit ESM + IIFE, while Temporal Memory is ESM-only |
| `pnpm format` | `oxfmt --write .` — **only before committing** |
| `pnpm format:check` | `oxfmt --check .` |

`oxfmt.config.ts` and `oxlint.config.ts` are two lines each and should stay that way. If a rule
needs changing, change it in `@astrale-os/ox`.

### The gate

Three commands. All three must be green before anything is called done:

```sh
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm typecheck` at the root covers the packages enumerated in `pnpm-workspace.yaml`. After
touching a package, it is still worth running `pnpm typecheck` inside that package's directory —
green tests do **not** mean the types are fine, and the extension's typecheck additionally runs
`wxt prepare` first to regenerate its ambient globals.

---

## Dependencies

Three kinds, three notations:

| Kind | Notation | Example |
|---|---|---|
| Internal (another package in **this** repo) | `workspace:*` | `"@astrale-os/comment-core": "workspace:*"` |
| Astrale-external (another repo, published) | a semver range `>=X.Y.Z <X+1.0.0` | `"@astrale-os/ox": ">=0.1.0 <1.0.0"` |
| Third-party | normal caret unless a release contract pins a tested pair | `"zod": "^4.4.3"` |

Adding a runtime dependency to `comment-core` or `browser-copilot` is a decision, not a
detail — both are meant to be publishable and consumable standalone. `comment-core` currently
ships three (`@medv/finder`, `approx-string-match`, `nanoid`) plus vendored Hypothesis
anchoring; `browser-copilot` ships three (`ai`, `nanoid`, and the types-only
`@standard-schema/spec`). Provider packages (`@ai-sdk/*`), schema libraries (`zod`, valibot,
arktype) and messaging are the consumer's own dependency: this repo never declares them in a
published package's `dependencies` and never imports them from `src/`. `zod` appears in
`packages/copilot/devDependencies` because the tests use it as a Standard Schema fixture.

Temporal Memory intentionally owns exact `@surrealdb/wasm` and `surrealdb` runtime versions as one
tested compatibility pair. Do not widen either range independently. Upgrade both as an explicit
release decision, then rerun the direct/worker Chromium harness and packed-consumer gates. The
current pair includes an alpha SDK because newer published pairings fail those gates; this is a
recorded prerelease exception, not permission to use loose prerelease ranges elsewhere.

---

## The dependency rule

This is the one architectural constraint that cannot be traded away:

```
extension       → { comment-core, comment-ui, browser-copilot }
comment-ui      → comment-core
comment-core    → nothing internal      ← never imports the copilot
browser-copilot → nothing internal      ← never imports comment-core
temporal-memory → nothing internal      ← independent package; exact Surreal pair
```

And neither library ever names a platform:

```sh
grep -rE "chrome\.|wxt/|from '@astrale-os/browser-copilot'" packages/comment-core/src packages/comment-ui/src
grep -rE "chrome\.|wxt/|from '@astrale-os/comment-core'|document\.|window\." packages/copilot/src
```

Both must return nothing. Storage, messaging and transport are injected interfaces
(`KeyValueAdapter`, `ToolTransport`); the extension supplies chrome-backed adapters and the demo
supplies `localStorage`/in-memory ones. If you find yourself wanting a shared package for a
six-line interface — don't. `KeyValueAdapter` is deliberately declared twice, once in each
library, for exactly this reason.

---

## Spec first, then tests, then code

`docs/SPEC-comment-core.md` and `docs/SPEC-copilot.md` are **locked implementation contracts**,
not documentation. Every export, signature, default value, ordering rule and error path in them
is normative.

Temporal Memory changes are governed by `docs/PRODUCT-temporal-memory.md`,
`docs/SPEC-temporal-memory.md`, and the evidence boundary in `docs/RELEASE-temporal-memory.md`.

The workflow, in order:

1. **If the behaviour you need is not in a spec, or the spec is ambiguous, that is a spec bug.**
   Fix the spec first, in its own commit, and record the reasoning — the specs carry a decision
   log (`§8` / `§9`) and a deferred-review table precisely so nobody has to reconstruct why a
   locked line moved. Implementers do not make API decisions ad hoc.
2. **Write the test from the spec sentence**, not from the implementation you are about to
   write. Both specs end with a "Definition of done" section that is close to a test plan:
   ordering rules §4.2.1–12 / §3.3.1–13 "each have a named test" is a literal requirement.
3. **Then write the code**, and make the smallest change that satisfies the test.
4. **Prefer the conformance suites over bespoke assertions.** A new store adapter is not
   "probably fine" — it is `storeConformance()` + `domainConformance()` + `engineConformance()`
   (or `runStoreConformance()` for a run store) wired into your test file in three `for` loops.
   Those suites are exported from `@astrale-os/comment-core/testing` and
   `@astrale-os/browser-copilot/testing` as runner-agnostic `{ name, run }[]` arrays for exactly
   this purpose.

A rule the conformance suite cannot observe is a rule that will regress. That is why, for
instance, `DomainOptions.onError` exists at all: it is the only channel through which the
"unknown record version is skipped, never rewritten" rule can be asserted from a headless
domain.

### Two shared resources a test must not fight over

`pnpm test` runs every package's suite **concurrently**, and two suites already learned this the
hard way. Both rules are load-bearing, not stylistic:

1. **A test that runs a Vite build must pass `build: { emptyOutDir: false }`.** Three suites
   build into `packages/comment-core/dist` — `comment-core`'s bundle DoD, `comment-ui`'s bundle
   DoD and `apps/demo`'s global setup — and the `BUILD_TARGET=iife` pass empties `dist/` by
   default. One wipe makes another package's `existsSync` assertion fail on file-system timing
   alone. The cost is stale hashed chunks in `dist/` after a test run; only `pnpm build` empties
   it, which is why CI builds *after* it tests.
2. **Never assume happy-dom delivered a `MutationObserver` record.** happy-dom holds the
   observer's report callback in a `WeakRef` nothing else references, so a GC silently
   unsubscribes it (`createTestPage` pins it — see `comment-core/src/testing/test-page.ts`).
   Anything that drives the DOM outside `createTestPage` inherits the hazard.

### Comments in code

The house style is that a comment explains **why**, especially when the obvious implementation
is wrong. If a line looks odd — comment-before-thread write ordering, a brand-based `instanceof`
replacement, a leading-edge event, a poll instead of a monkey-patch — the reason belongs next to
it, because someone will otherwise "simplify" it back into a bug.

---

## Pull requests

* Keep the gate green: `pnpm lint && pnpm typecheck && pnpm test`.
* Run `pnpm format` immediately before committing, and not at other times (it touches the whole
  tree).
* A change to a locked spec and the code implementing it may live in the same PR, but they
  should be separate commits, spec first.
* New public exports need: a spec entry, a test, and a row in the relevant package README's API
  table. All three, or none.

---

## License

By contributing you agree that your contributions are licensed under the Apache License 2.0,
the same terms as the rest of the repository.
