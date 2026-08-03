/**
 * The `exp-spec:host:*` range of SPEC-comment-core §6 — the bridge's own durable side map,
 * keyed by threadId, holding what `Thread` deliberately has no field for.
 *
 * Three collections, all per-record (never one mutable set object):
 *
 * * **pending set** — PLAN §5's `manual` dispatch policy. Threads accumulate here while you are
 *   still forming thoughts; the pill sends them as one batch. In-worker memory loses this
 *   silently after 30 s of idle, which is the one piece of host state whose loss is
 *   user-visible.
 * * **unread** — a copilot reply written while the tab was closed. Cleared when the page shows
 *   the thread.
 * * **failed** — the last terminal failure per thread. Durable for the same reason `unread` is:
 *   the chip map is rebuilt from durable state on every refresh and every page load, so an
 *   in-memory-only failure is erased by the next SPA navigation.
 *
 * There is deliberately **no thread → run index**. One used to live here, to make a
 * page-prefixed batch run findable from a thread id; every question it answered is a projection
 * of `copilot.list({ state: ['queued', 'processing'] })` over `run.context`, which is the same
 * durable storage without the second write path that could disagree with it.
 *
 * DOM-free and `chrome`-free: a `KeyValueAdapter` is the whole dependency.
 */

import type { KeyValueAdapter } from '@astrale-os/comment-core/headless'

import {
  FAILED_PREFIX,
  failedKey,
  idFromKey,
  pendingKey,
  pendingPagePrefix,
  PENDING_PREFIX,
  unreadKey,
  UNREAD_PREFIX,
} from './keys.ts'

/* ------------------------------------------------------------ pending set */

export interface PendingEntry {
  threadId: string
  pageKey: string
  kind: string
  at: string
}

function isPendingEntry(value: unknown): value is PendingEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<PendingEntry>
  return typeof entry.threadId === 'string' && typeof entry.pageKey === 'string'
}

export function createHostState(kv: KeyValueAdapter, now: () => Date = () => new Date()) {
  async function readPending(prefix: string): Promise<PendingEntry[]> {
    const keys = await kv.keys(prefix)
    if (keys.length === 0) return []
    const values = await kv.get(keys)
    const out: PendingEntry[] = []
    for (const key of keys) {
      const value = values[key]
      if (isPendingEntry(value)) out.push(value)
    }
    // Stable order so the batch run id (content-addressed over the id list) and the pill count
    // agree across contexts.
    return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
  }

  return {
    /* --------------------------------------------------------- pending */

    async markPending(entry: Omit<PendingEntry, 'at'>): Promise<void> {
      await kv.set({
        [pendingKey(entry.pageKey, entry.threadId)]: { ...entry, at: now().toISOString() },
      })
    },

    /** Idempotent — clearing a thread that was never pending is a no-op, not an error. */
    async clearPending(pageKey: string, threadId: string): Promise<void> {
      await kv.remove([pendingKey(pageKey, threadId)])
    },

    listPending(pageKey: string): Promise<PendingEntry[]> {
      return readPending(pendingPagePrefix(pageKey))
    },

    listAllPending(): Promise<PendingEntry[]> {
      return readPending(PENDING_PREFIX)
    },

    /**
     * A deleted thread must not keep a page's pill counting it. The pageKey is not always known
     * at the call site (`thread:delete` carries the thread, but a cancel path may not), so this
     * scans the whole range — bounded by the number of *pending* threads, not by all threads.
     */
    async dropPendingThread(threadId: string): Promise<void> {
      const entries = await this.listAllPending()
      const doomed = entries
        .filter((entry) => entry.threadId === threadId)
        .map((entry) => pendingKey(entry.pageKey, entry.threadId))
      if (doomed.length > 0) await kv.remove(doomed)
    },

    async clearPendingMany(entries: readonly PendingEntry[]): Promise<void> {
      if (entries.length === 0) return
      await kv.remove(entries.map((entry) => pendingKey(entry.pageKey, entry.threadId)))
    },

    /* ---------------------------------------------------------- unread */

    async markUnread(threadId: string): Promise<void> {
      await kv.set({ [unreadKey(threadId)]: { threadId, at: now().toISOString() } })
    },

    async clearUnread(threadId: string): Promise<void> {
      await kv.remove([unreadKey(threadId)])
    },

    async listUnread(): Promise<string[]> {
      return (await kv.keys(UNREAD_PREFIX)).map(idFromKey)
    },

    /* ---------------------------------------------------------- failed */

    /** Last terminal failure for a thread. Overwrites: only the most recent one is renderable. */
    async markFailed(threadId: string, code: string): Promise<void> {
      await kv.set({ [failedKey(threadId)]: { threadId, code, at: now().toISOString() } })
    },

    /** A new run supersedes the previous run's failure — otherwise a retry that succeeds still
     * shows the old error code forever. */
    async clearFailed(threadId: string): Promise<void> {
      await kv.remove([failedKey(threadId)])
    },

    async listFailed(): Promise<Array<{ threadId: string; code: string }>> {
      const keys = await kv.keys(FAILED_PREFIX)
      if (keys.length === 0) return []
      const values = await kv.get(keys)
      const out: Array<{ threadId: string; code: string }> = []
      for (const key of keys) {
        const value = values[key] as { code?: unknown } | undefined
        if (typeof value?.code !== 'string') continue
        out.push({ threadId: idFromKey(key), code: value.code })
      }
      return out
    },

    /* ---------------------------------------------------------- purge */

    /** Everything this range holds about one thread, dropped in one call on `thread:delete`. */
    async forgetThread(threadId: string): Promise<void> {
      await this.dropPendingThread(threadId)
      await kv.remove([unreadKey(threadId), failedKey(threadId)])
    },
  }
}

export type HostState = ReturnType<typeof createHostState>
