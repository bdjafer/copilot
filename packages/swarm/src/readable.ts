/**
 * The one reactive primitive (SPEC-swarm §6.1, H3). `ReadableStore` is the public half —
 * **re-declared in `src/types.ts`, never imported from `comment-core`** — and `writable()` is the
 * internal half the client drives.
 *
 * There is deliberately no `derived()`, no `select()` and no framework adapter subpath: §6.2
 * promises that store values are *referentially stable when unchanged*, so a
 * `useSyncExternalStore` binding is four module-level constants at the call site and a
 * `===` memoization in the head is correct without any help from here.
 *
 * `set` notifies only on a real change (`Object.is`), which is what makes that promise
 * enforceable: the projection may recompute a `FleetVM` on every frame, and as long as it hands
 * back the same object when nothing moved, no subscriber runs.
 *
 * DOM-free and Node-free.
 */

import type { ReadableStore, Unsubscribe } from './types.ts'

export interface WritableStore<T> extends ReadableStore<T> {
  /** Sets the value and notifies subscribers when it actually changed (`Object.is`). */
  set(value: T): void
  /** Number of live subscribers — for `inspect()`. */
  readonly size: number
}

/**
 * @param onError Receives a subscriber throw. Required for `destroy()` to be safe: every
 * imperative write in the client commits through one of these stores, so an unisolated dispatch
 * would let a faulting renderer propagate out of an intent — turning a rendering bug into a
 * rejected `sendTurn`.
 */
export function writable<T>(initial: T, onError?: (error: unknown) => void): WritableStore<T> {
  let value = initial
  const listeners = new Set<(value: T, previous: T) => void>()

  return {
    get: () => value,

    subscribe(listener) {
      listeners.add(listener)
      let active = true
      const unsubscribe: Unsubscribe = () => {
        if (!active) return /* idempotent */
        active = false
        listeners.delete(listener)
      }
      return unsubscribe
    },

    set(next) {
      if (Object.is(next, value)) return
      const previous = value
      value = next
      /* Frozen snapshot: subscribing or unsubscribing during a notification takes effect on the
       * next one, never mid-iteration. */
      for (const listener of Array.from(listeners)) {
        try {
          listener(value, previous)
        } catch (error) {
          if (onError) onError(error)
        }
      }
    },

    get size() {
      return listeners.size
    },
  }
}

/** Narrow a writable to its read half, so the published surface cannot be written through. */
export function readonlyStore<T>(store: WritableStore<T>): ReadableStore<T> {
  return { get: () => store.get(), subscribe: (listener) => store.subscribe(listener) }
}
