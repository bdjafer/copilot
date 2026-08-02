/** Shared test doubles. Not a test file. */

import type { CommentStore, KeyValueAdapter, StorageLike } from '../src/headless.ts'

export interface MemoryKv extends KeyValueAdapter {
  readonly data: Map<string, unknown>
  /** Number of `keys()` / `get()` calls, to assert key-only enumeration. */
  readonly calls: { get: number; set: number; remove: number; keys: number }
  /** Simulate another context writing: fires `watch` without touching this adapter's callers. */
  emit(keys: string[]): void
}

/** JSON-ish round trip on every boundary, like every real key/value backend. */
export function createMemoryKv(): MemoryKv {
  const data = new Map<string, unknown>()
  const watchers = new Set<(keys: string[]) => void>()
  const calls = { get: 0, set: 0, remove: 0, keys: 0 }

  const notify = (keys: string[]): void => {
    for (const watcher of Array.from(watchers)) watcher(keys)
  }

  return {
    data,
    calls,
    emit: notify,
    async get(keys) {
      calls.get++
      const out: Record<string, unknown> = {}
      for (const key of keys) if (data.has(key)) out[key] = structuredClone(data.get(key))
      return out
    },
    async set(entries) {
      calls.set++
      for (const [key, value] of Object.entries(entries)) data.set(key, structuredClone(value))
      notify(Object.keys(entries))
    },
    async remove(keys) {
      calls.remove++
      for (const key of keys) data.delete(key)
      notify([...keys])
    },
    async keys(prefix) {
      calls.keys++
      return [...data.keys()].filter((key) => key.startsWith(prefix))
    },
    watch(cb) {
      watchers.add(cb)
      return () => {
        watchers.delete(cb)
      }
    },
  }
}

/** `Storage`-shaped double for `createLocalStorageStore`. */
export function createFakeStorage(): StorageLike & { readonly map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  }
}

/**
 * Wraps a store with a `transaction`, so the domain's atomic path is exercised as well as
 * §4.3's ordered fallback. Notifies once, after the whole batch.
 */
export function withTransaction(store: CommentStore): CommentStore {
  const listeners = new Set<() => void>()
  let depth = 0
  let dirty = false

  const flush = (): void => {
    if (depth > 0 || !dirty) return
    dirty = false
    for (const listener of Array.from(listeners)) listener()
  }

  const wrapped: CommentStore = {
    ...store,
    name: 'transactional',
    getThread: (id) => store.getThread(id),
    listThreads: (pageKey) => store.listThreads(pageKey),
    listAllThreads: () => store.listAllThreads(),
    listComments: (id) => store.listComments(id),
    putThread: async (thread) => {
      await store.putThread(thread)
      dirty = true
      flush()
    },
    putComment: async (comment) => {
      await store.putComment(comment)
      dirty = true
      flush()
    },
    deleteThread: async (id) => {
      await store.deleteThread(id)
      dirty = true
      flush()
    },
    deleteComment: async (id) => {
      await store.deleteComment(id)
      dirty = true
      flush()
    },
    subscribe(_pageKey, cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    async transaction(fn) {
      depth++
      try {
        return await fn(wrapped)
      } finally {
        depth--
        flush()
      }
    },
  }
  return wrapped
}

/** Lets pending microtask/promise work settle. */
export async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}
