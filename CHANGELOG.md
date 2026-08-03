# Changelog

All notable changes to the published packages in this repo — `@astrale-os/comment-core`,
`@astrale-os/comment-ui` and `@astrale-os/browser-copilot` — are recorded here. The three
version together, in one entry per release, because `comment-ui` is a renderer for `comment-core`
and the demo and extension pin all three.

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

### Changed

- `@astrale-os/browser-copilot` — `zod` moved to `devDependencies` and the unused
  `@ai-sdk/anthropic` dependency dropped: provider packages and schema libraries are the
  consumer's own choice and were never imported by `src/`.
- All three packages carry full registry metadata (`description`, `keywords`, `repository` with
  `directory`, `homepage`, `bugs`, `engines`) and ship `README.md` + `LICENSE` in the tarball.

### Fixed

- `@astrale-os/comment-core/testing` — `createTestPage` pins happy-dom's `MutationObserver`
  callback, which happy-dom holds in a `WeakRef` that nothing else references. A garbage
  collection between two mutations used to unsubscribe the observer silently, which made
  observer-driven assertions fail at random under a parallel test run.

[Unreleased]: https://github.com/astrale-os/exp-spec/commits/main
