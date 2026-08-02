/**
 * Internal test/fixture seam. **Not part of §2** and deliberately not reachable from any public
 * barrel: `src/index.ts` re-exports `engine/index.ts` wholesale, so anything exported from there
 * lands on the package's public surface. Keeping the seam in its own module is what makes
 * "not re-exported from any barrel" true rather than merely documented.
 *
 * `createTestPage` needs it because no DOM emulator reproduces `MutationObserver` delivery
 * timing faithfully, so the fixture has to drive the anchoring batch deterministically.
 *
 * DOM-free.
 */

/**
 * Typed as a plain `symbol`: `Symbol.for` returns a **registered** symbol, so `unique symbol`
 * would assert a nominal identity the value does not have.
 */
export const INTERNALS: symbol = Symbol.for('comment-core.engine.internals')

export interface EngineInternals {
  /** Run the debounced anchoring batch now. False when nothing was pending. */
  flush(): boolean
  /** Force a full resolution pass and emit its transitions. */
  pass(): void
  /** Poll `location.href` (§4.6.6). */
  poll(): void
  /** The tail of the reload/navigation queue. */
  settled(): Promise<void>
}

export function engineInternals(engine: object): EngineInternals | null {
  return (engine as Record<symbol, EngineInternals | undefined>)[INTERNALS] ?? null
}
