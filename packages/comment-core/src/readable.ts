/**
 * The one reactive primitive (§2.1). `ReadableStore` is the public half; `writable()` is the
 * internal half the engine drives.
 *
 * There is deliberately no `select()`, no `derived()` and no framework adapter subpath: a
 * `useSyncExternalStore` binding is four module-level constants at the call site (§7.4).
 *
 * DOM-free.
 */

import type { ReadableStore, Unsubscribe } from './types.ts'

export interface WritableStore<T> extends ReadableStore<T> {
  /** Sets the value and notifies subscribers when it actually changed (`Object.is`). */
  set(value: T): void
  /** Number of live subscribers — for `inspect()`. */
  readonly size: number
}

/**
 * @param onError Receives a subscriber throw. **Required for §4.4** ("`stop()`, `cancel()` and
 * `destroy()` are always safe and idempotent"): `destroy()` sets `threads` to the empty list,
 * and an unisolated dispatch would let any `useSyncExternalStore` consumer that faults during
 * that commit propagate straight out of `destroy()`, leaving the engine half torn down. Every
 * imperative write commits through the same store, so the isolation is what keeps a faulty
 * renderer from turning into a rejected `appendComment`.
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
        if (!active) return // idempotent (§2.1)
        active = false
        listeners.delete(listener)
      }
      return unsubscribe
    },

    set(next) {
      if (Object.is(next, value)) return
      const previous = value
      value = next
      // Frozen snapshot: subscribing or unsubscribing during a notification takes effect on
      // the next one, never mid-iteration.
      const snapshot = Array.from(listeners)
      for (const listener of snapshot) {
        try {
          listener(value, previous)
        } catch (error) {
          if (onError) onError(error)
          // Without a sink there is nowhere to route it; swallowing still beats breaking the
          // remaining subscribers and the caller that committed the value.
        }
      }
    },

    get size() {
      return listeners.size
    },
  }
}

/** Narrow a writable down to its read half, so the public surface cannot be written through. */
export function readonlyStore<T>(store: WritableStore<T>): ReadableStore<T> {
  return { get: () => store.get(), subscribe: (listener) => store.subscribe(listener) }
}
