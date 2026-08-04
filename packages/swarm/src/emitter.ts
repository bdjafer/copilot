/**
 * The typed bus behind `SwarmClient.on` / `once` / `subscribe` (SPEC-swarm §6.2, §6.4).
 *
 * Generic over the event map so it stays DOM-free and so `SwarmClientEvents`' 23 keys are the
 * only vocabulary a head ever sees — payloads are **VM deltas, never wire frames** (H5), and
 * nothing in this module knows what a frame is.
 *
 * Guarantees implemented here, each of which the client depends on:
 *
 *  - listeners run in registration order over a snapshot frozen at emit time, so subscribing or
 *    unsubscribing during a dispatch takes effect on the *next* dispatch;
 *  - **a throwing listener cannot break its peers or the emitter's caller.** The caller is
 *    usually the frame pump: a head that faults while rendering one delegation must not stop the
 *    client from applying the rest of the batch, or a rendering bug becomes a stalled fleet;
 *  - the firehose (`subscribe`) receives each event **after** its typed listeners, so a logger
 *    never observes an event a renderer has not seen yet.
 *
 * DOM-free and Node-free.
 */

import type { Unsubscribe } from './types.ts'

/**
 * `origin` carries the listener the caller passed to `once`, so `off` can detach a one-shot
 * registration: the set holds the self-removing wrapper, not the original.
 */
type AnyListener = ((payload: never) => void) & { origin?: unknown }

export interface EmitterOptions {
  /** Receives a listener throw with the event key it happened on. Never throws itself. */
  onListenerError?: (error: unknown, key: string) => void
}

export interface Emitter<M> {
  on<K extends keyof M>(key: K, listener: (payload: M[K]) => void): Unsubscribe
  once<K extends keyof M>(key: K, listener: (payload: M[K]) => void): Unsubscribe
  off<K extends keyof M>(key: K, listener: (payload: M[K]) => void): void
  /** The firehose: `(key, payload)`, matching `SwarmClient.subscribe` (§6.2). */
  subscribe(listener: (key: keyof M, payload: unknown) => void): Unsubscribe
  emit<K extends keyof M>(key: K, payload: M[K]): void
  /** Live listener counts per key plus `'*'`, for `inspect().counters`. */
  counts(): Record<string, number>
  /** Drops every listener. `destroy()` is built on this. */
  clear(): void
}

export function createEmitter<M>(options?: EmitterOptions): Emitter<M> {
  const typed = new Map<keyof M, Set<AnyListener>>()
  const firehose = new Set<(key: keyof M, payload: unknown) => void>()

  function report(error: unknown, key: string): void {
    try {
      options?.onListenerError?.(error, key)
    } catch {
      /* Error-loop breaker: the sink itself must never re-enter the bus. */
    }
  }

  const emitter: Emitter<M> = {
    on(key, listener) {
      let set = typed.get(key)
      if (!set) {
        set = new Set()
        typed.set(key, set)
      }
      const wrapped = listener as AnyListener
      set.add(wrapped)
      let active = true
      return () => {
        if (!active) return
        active = false
        typed.get(key)?.delete(wrapped)
      }
    },

    once(key, listener) {
      let set = typed.get(key)
      if (!set) {
        set = new Set()
        typed.set(key, set)
      }
      const wrapper: AnyListener = (payload: never) => {
        typed.get(key)?.delete(wrapper)
        ;(listener as AnyListener)(payload)
      }
      wrapper.origin = listener
      set.add(wrapper)
      let active = true
      return () => {
        if (!active) return
        active = false
        typed.get(key)?.delete(wrapper)
      }
    },

    off(key, listener) {
      const set = typed.get(key)
      if (!set) return
      set.delete(listener as AnyListener)
      /* A `once` registration is held as a wrapper, so detaching by the original also sweeps the
       * wrappers pointing back at it (deleting during Set iteration is safe). */
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

    emit(key, payload) {
      for (const listener of Array.from(typed.get(key) ?? [])) {
        try {
          ;(listener as (value: M[typeof key]) => void)(payload)
        } catch (error) {
          report(error, String(key))
        }
      }
      for (const listener of Array.from(firehose)) {
        try {
          listener(key, payload)
        } catch (error) {
          report(error, String(key))
        }
      }
    },

    counts() {
      const out: Record<string, number> = { '*': firehose.size }
      for (const [key, set] of typed) out[String(key)] = set.size
      return out
    },

    clear() {
      typed.clear()
      firehose.clear()
    },
  }

  return emitter
}
