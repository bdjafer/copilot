// SPEC-copilot §2.1 — the `ReadableStore` contract, implemented once and reused by
// `copilot.runs` and `handle.run`.
import type { ReadableStore, Unsubscribe } from './types.ts'

export interface Writable<T> extends ReadableStore<T> {
  set(value: T): void
  readonly size: number
}

export function createWritable<T>(initial: T): Writable<T> {
  let value = initial
  const listeners = new Set<(value: T, previous: T) => void>()

  return {
    get: () => value,
    get size() {
      return listeners.size
    },
    subscribe(listener): Unsubscribe {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next: T) {
      if (Object.is(next, value)) return
      const previous = value
      value = next
      // Snapshot: subscribing during notification takes effect on the next set.
      // oxlint-disable-next-line no-useless-spread -- snapshot: a listener may unsubscribe
      for (const listener of [...listeners]) listener(value, previous)
    },
  }
}
