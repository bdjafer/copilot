# Changelog

All notable changes to the published packages in this repo — `@astrale-os/comment-core`,
`@astrale-os/comment-ui`, `@astrale-os/browser-copilot` and `@astrale-os/swarm` — are recorded
here. The first three version together, in one entry per release, because `comment-ui` is a
renderer for `comment-core` and the demo and extension pin all three. `@astrale-os/swarm` is
independent of them: it shares the repository and the tooling, and nothing else.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/spec/v2.0.0.html) — while the packages sit
at `0.0.0` they are **unreleased and unpublished**, and the public surface may still move.

## [Unreleased]

### Added

- `@astrale-os/comment-core` — anchored comment threads: the `CommentEngine`, the five-strategy
  anchoring pipeline with fingerprint verification, memory / `localStorage` / key-value stores,
  the headless domain, and the `testing` conformance suites.
- `@astrale-os/comment-ui` — the shadow-root renderer: badges, composer and thread popovers, the
  corner panel, and the `--cc-*` custom-property theming surface.
- `@astrale-os/browser-copilot` — the DOM-free browser agent runtime: typed tools, the durable
  run queue that survives service-worker death, run stores, and the `testing` harness.
- Repository CI (`.github/workflows/ci.yml`): install → lint → typecheck → test → build on
  Node 22 / pnpm 10.
- `@astrale-os/swarm` — a server-scheduled fleet of coding-agent delegations, in four entry
  points plus a `swarm` binary.
  - **Client core** (`.`) — DOM-free and `node:*`-free: the connection with backoff and
    capability re-verification, per-stream gapless `seq` resume (`snapshot`, then `from:<seq>`),
    the offline intent queue with idempotency keys and a request-timeout reaper, ref-counted
    transcript and diff handles, and the nine attention-ordered fleet buckets.
  - **Server** (`./server`) — the daemon: loopback HTTP with one-time-code pairing, the
    `swarm.v1` WebSocket, a SQLite durable log with lease fencing, the attempt scheduler, the
    workspace guard (realpath + symlink, re-resolved on every use), swarm-owned verification
    with evidence bundles, and the jcode `api-bridge` adapter.
  - **Presentation seam** (`./presentation`) — the view model and intents a renderer implements.
    It imports nothing and emits a chunk with zero imports.
  - **Testing** (`./testing`) — `MockExecutor` on the jcode capability row, runner-agnostic
    executor / store / protocol / client conformance suites, the fake jcode bridge, and the
    seeded demo (a throwaway repo with a real failing test and two criteria that actually run).
  - **CLI** — `serve` is the daemon; every other verb is a head over the wire authenticating
    from a `0600` `$SWARM_HOME/cli-token`. `doctor` exits 0 healthy / 1 blocked / 2 degraded.
  - `pnpm demo` narrates the seeded scenario in about a second, and `pnpm demo:serve` runs a
    real server against the mock executor so a head can be paired without spending quota.
  - `README.md`, and `docs/DEMO-swarm.md` for the local walkthrough including the real bridge.

### Changed

- `@astrale-os/browser-copilot` — `zod` moved to `devDependencies` and the unused
  `@ai-sdk/anthropic` dependency dropped: provider packages and schema libraries are the
  consumer's own choice and were never imported by `src/`.
- All three packages carry full registry metadata (`description`, `keywords`, `repository` with
  `directory`, `homepage`, `bugs`, `engines`) and ship `README.md` + `LICENSE` in the tarball.
- `@astrale-os/swarm` — every TypeScript parameter property in `src/` was rewritten as a declared
  field with an explicit assignment. Node ≥ 24 runs `.ts` in **strip-only** mode, where a
  parameter property is the one class syntax that cannot be erased, so a single one anywhere in
  the graph made `node src/cli.ts` fail to load — the documented dev entry, the command the demo
  prints, and what the end-to-end test spawns. The emitted semantics are unchanged.
- **`@astrale-os/swarm` — the shipped `origins` allowlist now admits `chrome-extension://*`, and
  `originAllowed` gained a `<scheme>://*` wildcard to express it.** Read this before deploying:
  the wildcard matches **any authority on that scheme**, so every extension installed in the
  user's browser may now reach `POST /pair` and attempt the `swarm.v1` handshake. The default
  shipped with loopback entries only, and an unpacked extension's id is assigned by the browser
  from its install path — so a real MV3 head was refused `403: forbidden origin` and there was no
  first-run route to pairing that did not involve hand-editing the config with an id the user
  first has to go and look up. What this concedes is bounded: an `Origin` header is a
  browser-enforced statement of provenance and never of authorisation, prefix confusion is
  excluded (`chrome-extension-evil://` does not match), and the one-time pairing code — 8
  characters, 300 s, single use, 5 attempts, 20/min, printed on the server's own stdout, which an
  extension cannot read — remains the authentication. **Operators who can enumerate the extension
  id SHOULD narrow `origins` to `chrome-extension://<id>`; an exact entry still matches first.**
  Recorded as `[E2]` in `docs/SPEC-swarm.md`; both branches of both doors are now on the
  end-to-end journey's own path rather than covered only by unit tests over `originAllowed`.
- **`@astrale-os/swarm` — `tail()` now reads `peekSession` *and* `getHistory`, paired, where the
  locked spec previously banned `getHistory` outright.** This changes a contract, not only an
  implementation. The hazard the ban was written for is confirmed and unchanged — `get_history`
  does `content.as_str().unwrap_or("")` with no flattening, so a block-array message reads as
  `""`, and §5.5's prompt-digest match against `""` makes every `unknown` turn look un-landed.
  What the first run against a **live** jcode 0.67.0 bridge falsified is the *alternative*:
  `peek_session` is the **stored** tail and does not carry what swarm just sent — a `noReply`
  message was still absent from it three seconds later while `get_history` already had it, and a
  fresh session's stored tail holds jcode's own injected session-context reminder instead. So
  `peekSession` alone fails **closed** on every turn. The stored tail is read first and only the
  live rows it has not flushed are merged, with every `''` row dropped. `getHistory` is never read
  alone and never outside `JcodeSession.tail()`; the §13 gate enforces that at **call-site** scope
  (same function body) rather than file scope, which passed on the mere presence of the word.
  Recorded as `[E1]` in `docs/SPEC-swarm.md`, which is amended in §5.2, §5.4 #12, §12 #13, §12 #45
  and §13.
- `@astrale-os/swarm` — `waitForAccept` must now be written **`false`** rather than omitted, and
  the §13 gate changed from "never appears" to "never `true`" plus an enumeration of the two files
  allowed to pass it. `@1jehuang/jcode-sdk@1.0.1` defaulted to "do not wait"; the installed 1.1.0
  reads `options.waitForAccept ?? true` with `acceptTimeoutMs ?? 10_000`, so absence now blocks the
  send for up to ten seconds on exactly the un-acked case V5 exists for — and the SDK's
  `waitForEvent` *resolves* on timeout, so the wait cannot tell `accepted` from `unknown` anyway.
  Recorded as `[E3]` in `docs/SPEC-swarm.md`.

### Fixed

- `@astrale-os/swarm` — a delegation whose default `reasoningEffort` is `null` had **every** turn
  refused pre-flight on the real jcode adapter. The session's declared effort shadow starts
  `undefined` ("nothing driven"), `reconciliationTarget` returns `null` ("no effort is driven"),
  and `null !== undefined` made the engine issue `applyConfig({reasoningEffort: null})` — which
  the wire cannot express (`effort` is a required non-empty string) and the adapter therefore
  refuses `no_effort_to_set`, moving the turn to `failed` through V3 and dequeuing it. It recurred
  after every reconnect, since the shadow is re-invalidated on each reattach, and the extension
  head can produce the state (its `effort('')` maps to `null`). Reconciling *nothing* to `null` is
  now a no-op rather than a config call; reconciling a **driven** effort to `null` is still
  refused, because running the turn under an effort its own record denies is the one lie §4.3.4
  exists to prevent. Invisible to 853 tests because `MockExecutor.applyConfig` accepted `null` and
  reported it applied — the mock now refuses it exactly as jcode does, and the rule is pinned for
  every adapter in `executorConformance`.
- `@astrale-os/swarm` — `MockExecutor` records an ordered log of the calls that reached it
  (`adapter.calls`), and §4.2's normative "config **before** the send it configures" is asserted
  against it. Deleting the `applyConfig` call from the dispatch path outright previously left the
  entire suite green: every effort assertion read `turn.effective.reasoningEffort` off the
  projected view model, which is a pure function of the directive and the delegation defaults —
  the record swarm *declared*, never what it *did*. "ZERO executor calls" for a mid-turn config
  change now means it literally, too.
- `@astrale-os/swarm` (extension head) — the `hidden` attribute was **inert across the entire
  swarm surface**. `ui/styles.ts` declared `display` on class selectors and shipped no
  `[hidden] { display: none }` rule of its own, and the UA's is specificity 0-1-0, so every author
  class beat it. The pairing card and the fleet drew simultaneously in both directions, the detail
  pane painted unpopulated section frames with nothing focused, the "entries were dropped under
  backpressure" banner never went away, and the `position: fixed` notice stack kept its footprint
  when empty. The surface tests could not see it: they assert `hasAttribute('hidden')`, which was
  true either way. Now asserted as an *effect* — computed `display`, over every `.cc-*` class the
  sheet names.
- `@astrale-os/swarm` — `cancel{scope:'delegation'}` wrote `cancelled` onto the record *before*
  the forced state refresh that emits it, so the refresh found the state it was about to write
  already there and returned early. The cancellation was durable and completely invisible: no
  `fleet.delegation_state`, no summary, and every connected head went on showing the delegation
  as queued or running while the intent answered `ok`. Caught by the end-to-end journey test —
  the first test in the suite to drive a cancel through a head rather than through the store.

- `@astrale-os/comment-core/testing` — `createTestPage` pins happy-dom's `MutationObserver`
  callback, which happy-dom holds in a `WeakRef` that nothing else references. A garbage
  collection between two mutations used to unsubscribe the observer silently, which made
  observer-driven assertions fail at random under a parallel test run.

[Unreleased]: https://github.com/astrale-os/exp-spec/commits/main
