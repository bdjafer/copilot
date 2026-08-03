/**
 * Copilot chip state → `CommentUI.decorate()` (SPEC-comment-core §7.2).
 *
 * `comment-ui` has no idea what a copilot is; `decorate` takes `{ chip, tone, title }` and
 * nothing else. This module owns the mapping and the precedence, so the content script never
 * open-codes a `Decoration` literal and the rules are unit-testable without a shadow root.
 *
 * **Chips are edge-driven and cleared on `page:change`**, so §7.2's "re-derive from durable
 * state after `engine.ready()`" is mandatory, not optional: a worker death between
 * `busy: true` and `busy: false` otherwise leaves a chip spinning forever.
 */

import type { Decoration } from '@astrale-os/comment-ui'

export interface ChipState {
  busy?: boolean
  pending?: boolean
  /** Last terminal failure code for this thread; cleared when a new run starts. */
  failed?: string
  /** An unread copilot reply written while the tab was elsewhere. */
  unread?: boolean
}

/**
 * Precedence, most specific first:
 *
 * 1. **busy** — a run is live right now. Beats everything: it is the only state that changes on
 *    its own, and showing "pending" over a live run would invite a second dispatch.
 * 2. **failed** — a run that died three times must not look like a run that never happened.
 * 3. **pending** — queued for the next batch (PLAN §5's `manual` policy).
 * 4. **unread** — a reply landed while you were elsewhere.
 *
 * `null` clears the decoration entirely; `comment-ui` drops it on `thread:delete` and
 * `page:change` regardless.
 */
export function decorationFor(state: ChipState | undefined): Decoration | null {
  if (!state) return null
  if (state.busy) {
    return { chip: { text: 'copilot', tone: 'busy', spinner: true }, title: 'copilot is working' }
  }
  if (state.failed) {
    return { chip: { text: state.failed, tone: 'warn' }, title: 'copilot run failed' }
  }
  if (state.pending) {
    return { chip: { text: 'pending', tone: 'neutral' }, title: 'queued for the next batch' }
  }
  if (state.unread) {
    return { chip: { text: 'new reply', tone: 'info' }, tone: 'accent' }
  }
  return null
}

/**
 * The chip map. Owns nothing else: it holds per-thread flags and hands the caller the
 * decoration to apply, so the caller stays a two-line adapter over `ui.decorate`.
 */
export function createChipStore(apply: (threadId: string, decoration: Decoration | null) => void) {
  const states = new Map<string, ChipState>()

  const flush = (threadId: string): void => {
    const state = states.get(threadId)
    const decoration = decorationFor(state)
    if (decoration === null) states.delete(threadId)
    apply(threadId, decoration)
  }

  const patch = (threadId: string, change: Partial<ChipState>): void => {
    const next: ChipState = { ...states.get(threadId), ...change }
    // Drop falsy flags so an all-false state deletes the entry rather than accumulating one
    // per thread the copilot has ever touched.
    for (const key of Object.keys(next) as Array<keyof ChipState>) {
      if (!next[key]) delete next[key]
    }
    states.set(threadId, next)
    flush(threadId)
  }

  return {
    setBusy(threadId: string, busy: boolean): void {
      // A new run supersedes the previous run's failure. Without this, a retry that succeeds
      // leaves the old error code showing forever.
      patch(threadId, busy ? { busy: true, failed: undefined } : { busy: false })
    },
    setPending(threadId: string, pending: boolean): void {
      patch(threadId, { pending })
    },
    setFailed(threadId: string, code: string): void {
      patch(threadId, { busy: false, failed: code })
    },
    setUnread(threadId: string, unread: boolean): void {
      patch(threadId, { unread })
    },
    /**
     * `engine.ready()` re-derivation: replaces the whole map from durable state.
     *
     * Everything renderable must be passed here, `failed` included — the map is cleared first,
     * so anything held only in memory is erased on every `page:change`, every batch send and
     * every reload.
     */
    reset(
      busyThreads: readonly string[],
      pendingThreads: readonly string[],
      unread: readonly string[],
      failed: readonly { threadId: string; code: string }[] = [],
    ): void {
      const stale = [...states.keys()]
      states.clear()
      for (const threadId of busyThreads) states.set(threadId, { busy: true })
      for (const entry of failed) {
        // Busy still wins in `decorationFor`; carrying the code keeps the chip renderable the
        // moment a retry settles without another round trip.
        states.set(entry.threadId, { ...states.get(entry.threadId), failed: entry.code })
      }
      for (const threadId of pendingThreads) {
        states.set(threadId, { ...states.get(threadId), pending: true })
      }
      for (const threadId of unread) {
        states.set(threadId, { ...states.get(threadId), unread: true })
      }
      for (const threadId of new Set([...stale, ...states.keys()])) flush(threadId)
    },
    get(threadId: string): ChipState | undefined {
      return states.get(threadId)
    },
    /** Every thread currently carrying a chip. */
    keys(): string[] {
      return [...states.keys()]
    },
    clear(): void {
      const stale = [...states.keys()]
      states.clear()
      for (const threadId of stale) apply(threadId, null)
    },
  }
}

export type ChipStore = ReturnType<typeof createChipStore>
