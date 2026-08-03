/**
 * The `KeyValueAdapter` over `chrome.storage` — SPEC-comment-core §6's "~15 lines" seam, and
 * the single object that carries all three key ranges (`src/keys.ts`).
 *
 * One adapter, three consumers:
 *   `createKeyValueStore(kv, { namespace: 'exp-spec' })`   — threads + comments
 *   `createKeyValueRunStore(kv, { namespace: 'runs' })`    — copilot runs + leases
 *   `createKeyValueCursor(kv, { namespace: 'exp-spec:host' })` + `src/host-state.ts`
 *
 * `comment-core` and `copilot` each declare their own structurally identical `KeyValueAdapter`
 * (neither imports the other), so the return type is annotated against comment-core's and
 * asserted assignable to copilot's by `KV_SATISFIES_BOTH` below — a compile-time proof that one
 * object legitimately serves both, not a cast.
 */

import type { KeyValueAdapter as RunKeyValueAdapter } from '@astrale-os/browser-copilot'
import type { KeyValueAdapter } from '@astrale-os/comment-core/headless'

import type { StorageAreaLike, StorageChangedEvent, StorageLike } from './platform.ts'

/**
 * The one area this adapter uses. Not an option: `createStorageKv` reads `storage.local` and
 * nothing else, so an `areaName` that could disagree with the area actually being read is a way
 * to build an adapter whose `watch` never fires — with no second area to make it worth having.
 */
const AREA_NAME = 'local'

export interface StorageKvOptions {
  /**
   * Called once if `getKeys()` is missing (Chrome < 130 / Firefox < 136). The adapter then
   * falls back to `get(null)`, which deserializes the whole area — see `keys()`.
   */
  onDegraded?: (reason: string) => void
}

/**
 * `chrome.storage.local.get(keys)` omits absent keys on Chrome but yields `undefined` values on
 * some polyfills. Stripping them here makes `values[key]` mean exactly "present" for every
 * consumer, which is what `createKeyValueRunStore.get` (`value === undefined ⇒ null`) reads.
 */
function compact(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) if (value !== undefined) out[key] = value
  return out
}

export function createStorageKv(storage: StorageLike, options?: StorageKvOptions): KeyValueAdapter {
  const area: StorageAreaLike = storage.local
  const onChanged: StorageChangedEvent = storage.onChanged
  let warnedNoGetKeys = false

  return {
    async get(keys) {
      // `chrome.storage.local.get([])` resolves `{}` but still costs an IPC round trip, and the
      // kv store asks for `[]` on every empty prefix scan.
      if (keys.length === 0) return {}
      return compact(await area.get([...keys]))
    },

    async set(entries) {
      await area.set(entries)
    },

    async remove(keys) {
      if (keys.length === 0) return
      await area.remove([...keys])
    },

    async keys(prefix) {
      if (typeof area.getKeys === 'function') {
        return (await area.getKeys()).filter((key) => key.startsWith(prefix))
      }
      // Key-only is normative (§2.8) because `get(null)` deserializes every capture and every
      // run record on each prefix scan. Without `getKeys` there is no key-only path, so the
      // rule is broken loudly rather than quietly.
      if (!warnedNoGetKeys) {
        warnedNoGetKeys = true
        options?.onDegraded?.(
          'storage.getKeys() is unavailable (Chrome < 130): falling back to get(null), which ' +
            'deserializes the whole area on every prefix scan',
        )
      }
      return Object.keys(await area.get(null)).filter((key) => key.startsWith(prefix))
    },

    watch(cb) {
      const listener = (changes: Record<string, unknown>, changedArea: string): void => {
        if (changedArea !== AREA_NAME) return
        cb(Object.keys(changes))
      }
      onChanged.addListener(listener)
      return () => onChanged.removeListener(listener)
    },
  }
}

/**
 * Compile-time proof that one adapter serves both libraries. `copilot` re-declares
 * `KeyValueAdapter` rather than importing comment-core's (the packages never import each
 * other); if either declaration drifts, this line stops compiling instead of a `runStore`
 * silently taking `never`.
 */
export type KvSatisfiesBoth = KeyValueAdapter extends RunKeyValueAdapter ? true : never
export const KV_SATISFIES_BOTH: KvSatisfiesBoth = true
