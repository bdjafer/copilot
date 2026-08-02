/**
 * Typed event bus (§2.11 `on/once/off/subscribe`, ordering rule §4.2.7).
 *
 * Generic over the event map so it stays DOM-free: the engine instantiates it with
 * `CommentEventMap` (which names `Element`), `observeStore` never needs it.
 *
 * Guarantees implemented here:
 *  - listeners run in registration order, over a snapshot frozen at emit time, so
 *    subscribing/unsubscribing during emission takes effect on the *next* emission;
 *  - a throwing listener cannot break the batch or its peers (§4.4);
 *  - the `*` firehose receives each event AFTER its typed listeners;
 *  - `seq` is monotonic per instance, starting at 1.
 */

import type { EventEnvelope, Unsubscribe } from './types.ts'

/**
 * `origin` carries the listener the caller actually passed to `on`/`once`. Without it,
 * `off(type, listener)` cannot detach a `{ once: true }` registration — the set holds the
 * self-removing wrapper, not the original — and §2.11's `off` would be unreliable for the whole
 * documented `once` option (the listener keeps firing and leaks into `inspect().listeners`).
 */
type AnyListener = ((payload: never) => void) & { origin?: unknown }

export interface EmitterOptions {
  /** Receives a listener throw, with the event type it happened on. Never throws itself. */
  onListenerError?: (error: unknown, type: string) => void
  /** Injectable clock for the `at` stamp. Default `Date.now`. */
  now?: () => number
}

export interface Emitter<M> {
  on<K extends keyof M>(
    type: K,
    listener: (payload: M[K]) => void,
    options?: { once?: boolean; signal?: AbortSignal },
  ): Unsubscribe
  once<K extends keyof M>(type: K, listener: (payload: M[K]) => void): Unsubscribe
  off<K extends keyof M>(type: K, listener: (payload: M[K]) => void): void
  /** The `*` firehose. */
  subscribe(listener: (event: EventEnvelope<M>) => void): Unsubscribe
  emit<K extends keyof M>(type: K, payload: M[K]): EventEnvelope<M>
  /** Live listener counts per type plus `'*'`, for `inspect()`. */
  counts(): Record<string, number>
  /** Drops every listener. `destroy()` is built on this. */
  clear(): void
  readonly seq: number
}

export function createEmitter<M>(options?: EmitterOptions): Emitter<M> {
  const typed = new Map<keyof M, Set<AnyListener>>()
  const firehose = new Set<(event: EventEnvelope<M>) => void>()
  const now = options?.now ?? Date.now
  let seq = 0

  function reportListenerError(error: unknown, type: string): void {
    try {
      options?.onListenerError?.(error, type)
    } catch {
      // Error-loop breaker (§4.4): the sink itself must never re-enter the bus.
    }
  }

  const emitter: Emitter<M> = {
    on(type, listener, opts) {
      if (opts?.signal?.aborted) return () => {}
      let wrapped: AnyListener
      if (opts?.once) {
        const once: AnyListener = (payload: never) => {
          typed.get(type)?.delete(once)
          ;(listener as AnyListener)(payload)
        }
        once.origin = listener
        wrapped = once
      } else {
        wrapped = listener as AnyListener
      }

      let set = typed.get(type)
      if (!set) {
        set = new Set()
        typed.set(type, set)
      }
      set.add(wrapped)

      let active = true
      const unsubscribe: Unsubscribe = () => {
        if (!active) return // idempotent (§2.1)
        active = false
        typed.get(type)?.delete(wrapped)
      }
      opts?.signal?.addEventListener('abort', unsubscribe, { once: true })
      return unsubscribe
    },

    once(type, listener) {
      return emitter.on(type, listener, { once: true })
    },

    off(type, listener) {
      const set = typed.get(type)
      if (!set) return
      set.delete(listener as AnyListener)
      // A `once` registration is held as a wrapper, so detaching by the original also has to
      // sweep the wrappers that point back at it (deleting during Set iteration is safe).
      for (const candidate of set) if (candidate.origin === listener) set.delete(candidate)
    },

    subscribe(listener) {
      firehose.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        firehose.delete(listener)
      }
    },

    emit(type, payload) {
      const event = { type, seq: ++seq, at: now(), payload } as EventEnvelope<M>
      // Snapshot both lists before dispatch (§4.2.7).
      const listeners = Array.from(typed.get(type) ?? [])
      for (const listener of listeners) {
        try {
          ;(listener as (value: M[typeof type]) => void)(payload)
        } catch (error) {
          reportListenerError(error, String(type))
        }
      }
      const observers = Array.from(firehose)
      for (const listener of observers) {
        try {
          listener(event)
        } catch (error) {
          reportListenerError(error, String(type))
        }
      }
      return event
    },

    counts() {
      const out: Record<string, number> = { '*': firehose.size }
      for (const [type, set] of typed) out[String(type)] = set.size
      return out
    },

    clear() {
      typed.clear()
      firehose.clear()
    },

    get seq() {
      return seq
    },
  }

  return emitter
}
