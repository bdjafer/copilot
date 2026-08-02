// SPEC-copilot §2.3 — constants. Each has exactly one defensible value, so none is an option.

/** PLAN §4.5: bounded retry. Not configurable — there is one defensible value. */
export const MAX_ATTEMPTS = 3 as const

/** Heartbeat older than this ⇒ resumePending() restarts the run. Overridable per call. */
export const STALE_AFTER_MS = 60_000 as const

/** Heartbeat write interval while processing (and while queued in a live queue). */
export const HEARTBEAT_MS = 10_000 as const

/** Tool-loop cap default (§2.5). */
export const DEFAULT_MAX_STEPS = 8

/** Concurrent processing runs (§2.5). SW lifetime is the scarce resource, not throughput. */
export const DEFAULT_CONCURRENCY = 1

/** Wall clock per attempt, ms (§2.5). */
export const DEFAULT_TIMEOUT_MS = 240_000

/** Per-tool-call wall clock (§2.4). */
export const DEFAULT_TOOL_TIMEOUT_MS = 30_000

/** `runtime:idle` is trailing-debounced by this much (§2.8 / §3.3.9). */
export const IDLE_DEBOUNCE_MS = 500

/** `attach()` polls a foreign run every HEARTBEAT_MS / 2 (§2.6). */
export const ATTACH_POLL_MS = HEARTBEAT_MS / 2

/**
 * Delay before a failed-but-retryable run is picked up again: `min(2 ** attempt * 1000, 30_000)`
 * — 2 s, then 4 s. Not configurable, but not zero either.
 */
export function retryDelayMs(attempt: number): number {
  return Math.min(2 ** attempt * 1000, 30_000)
}
