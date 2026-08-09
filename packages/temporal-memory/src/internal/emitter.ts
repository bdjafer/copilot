import type { ErrorScope, MemoryEventMap, MemoryEventName, Unsubscribe } from '../types.ts'

import { MemoryError } from '../errors.ts'

export class MemoryEmitter {
  readonly #listeners = new Map<MemoryEventName, Set<(event: never) => void>>()
  readonly #onError?: (error: MemoryError, scope: ErrorScope) => void

  constructor(onError?: (error: MemoryError, scope: ErrorScope) => void) {
    this.#onError = onError
  }

  on<K extends MemoryEventName>(
    name: K,
    listener: (event: MemoryEventMap[K]) => void,
  ): Unsubscribe {
    let listeners = this.#listeners.get(name)
    if (listeners === undefined) {
      listeners = new Set()
      this.#listeners.set(name, listeners)
    }
    listeners.add(listener as (event: never) => void)
    return () => listeners?.delete(listener as (event: never) => void)
  }

  emit<K extends MemoryEventName>(name: K, event: MemoryEventMap[K]): void {
    for (const listener of this.#listeners.get(name) ?? []) {
      try {
        listener(structuredClone(event) as never)
      } catch (error) {
        this.#reportListenerError(error)
      }
    }
  }

  #reportListenerError(error: unknown): void {
    const normalized = MemoryError.is(error)
      ? error
      : new MemoryError('internal', 'memory event listener failed', { cause: error })
    try {
      this.#onError?.(normalized, 'listener')
    } catch {
      // Error observers cannot be allowed to create an unhandled rejection or recurse.
    }
  }
}
