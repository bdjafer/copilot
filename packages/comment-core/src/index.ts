/**
 * `comment-core` — public barrel (§1.1).
 *
 * Re-exports **everything** in `comment-core/headless`, and (once the DOM half lands)
 * everything in `comment-core/anchor` plus the engine. `"sideEffects": false` and pure
 * top-level declarations keep the DOM half tree-shakeable, and every symbol re-exported here
 * must remain reachable without touching `document`, `window`, `navigator`, `chrome` or
 * `localStorage` at module scope.
 */

export * from './headless.ts'
export * from './anchor/index.ts'
export * from './engine/index.ts'
