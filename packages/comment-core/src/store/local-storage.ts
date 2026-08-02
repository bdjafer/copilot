/**
 * Demo/standalone default (§2.8). Built on `createKeyValueStore` + a `storage`-event watch.
 *
 * **Demo-only, and per-origin.** In a content script `localStorage` is the HOST PAGE's origin
 * storage — the same trap PLAN §3.6 documents for IndexedDB. Threads are therefore per-site,
 * evictable under storage pressure, wiped by "clear site data", and readable by the page.
 * Extensions and any multi-page product MUST pass `createKeyValueStore(kv)` over
 * extension-owned storage instead.
 *
 * DOM-free by construction: `localStorage` and the `storage` event are reached through
 * structural types and `globalThis`, never through `lib.dom` identifiers, and never at module
 * scope — the first access happens inside the first store call.
 */

import type { CommentStore, KeyValueAdapter } from '../types.ts'

import { CommentError } from '../errors.ts'
import { createKeyValueStore, DEFAULT_NAMESPACE } from './kv.ts'

/**
 * Structural superset of `lib.dom`'s `Storage`. Every `Storage` is assignable to it, so the
 * locked `{ storage?: Storage }` call site still typechecks, while the declaration stays free
 * of `lib.dom` identifiers as §1.1 requires of `comment-core/headless`.
 */
export interface StorageLike {
  readonly length: number
  key(index: number): string | null
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface StorageEventLike {
  key?: string | null
}

interface EventTargetLike {
  addEventListener?: (type: string, listener: (event: StorageEventLike) => void) => void
  removeEventListener?: (type: string, listener: (event: StorageEventLike) => void) => void
}

/** Lazily resolved on first use — never at module scope (§2.8). */
function resolveStorage(supplied?: StorageLike): StorageLike {
  const storage = supplied ?? (globalThis as { localStorage?: StorageLike }).localStorage
  if (!storage) {
    throw new CommentError(
      'store_failed',
      'localStorage is unavailable in this context; pass { storage } or use createKeyValueStore',
    )
  }
  return storage
}

function storageKv(namespace: string, supplied?: StorageLike): KeyValueAdapter {
  let cached: StorageLike | null = null
  const storage = (): StorageLike => (cached ??= resolveStorage(supplied))

  return {
    async get(keys) {
      const s = storage()
      const out: Record<string, unknown> = {}
      for (const key of keys) {
        const raw = s.getItem(key)
        if (raw === null) continue
        try {
          out[key] = JSON.parse(raw)
        } catch {
          // A value another writer put there in a format we cannot read is not our record.
        }
      }
      return out
    },

    async set(entries) {
      const s = storage()
      for (const [key, value] of Object.entries(entries)) s.setItem(key, JSON.stringify(value))
    },

    async remove(keys) {
      const s = storage()
      for (const key of keys) s.removeItem(key)
    },

    /** Key-only (§2.8): indices are walked, no value is ever deserialized to enumerate keys. */
    async keys(prefix) {
      const s = storage()
      const out: string[] = []
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i)
        if (key !== null && key.startsWith(prefix)) out.push(key)
      }
      return out
    },

    watch(cb) {
      const target = globalThis as unknown as EventTargetLike
      if (!target.addEventListener) return () => {}
      const handler = (event: StorageEventLike): void => {
        // `key: null` is "the whole store was cleared", and the cleared keys are gone before we
        // can enumerate them. Reporting the two owned prefixes keeps the namespace filter
        // satisfied, because `subscribe` may over-notify but must never under-notify.
        const key = event.key
        cb(key === null || key === undefined ? [`${namespace}:t:`, `${namespace}:c:`] : [key])
      }
      target.addEventListener('storage', handler)
      return () => target.removeEventListener?.('storage', handler)
    },
  }
}

export function createLocalStorageStore(options?: {
  storage?: StorageLike
  namespace?: string
}): CommentStore {
  const namespace = options?.namespace ?? DEFAULT_NAMESPACE
  return createKeyValueStore(storageKv(namespace, options?.storage), { namespace })
}
