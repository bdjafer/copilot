/**
 * The general adapter (§2.8). Key layout, all per-record — **there is no shared mutable key**:
 *
 *   `{ns}:t:{pageKey}:{threadId}`   thread record (pageKey is in the key, URL-encoded)
 *   `{ns}:c:{threadId}:{commentId}` comment record
 *
 * A comment write never rewrites a thread. Every id component is URL-encoded as well as the
 * page key: caller-supplied idempotency keys are allowed to contain `:` (SPEC-copilot §7.3
 * writes `id: \`r:${runId}\``), and an unencoded `:` would make key parsing ambiguous.
 *
 * DOM-free.
 */

import type { Comment, CommentStore, KeyValueAdapter, StoredThread, Thread } from '../types.ts'

import { guardStore } from '../errors.ts'
import { isComment, isStoredThread, sortRecords } from './common.ts'

/**
 * Namespace default. Every normative example passes one explicitly (`'exp-spec'`, §6); the
 * spec never states a default, so this is a self-describing fallback, not a key range anyone
 * is expected to rely on.
 */
export const DEFAULT_NAMESPACE = 'comment-core'

const enc = encodeURIComponent

/** Last `:`-delimited segment. Safe because every id/page-key component is URL-encoded. */
function lastSegment(key: string): string {
  return key.slice(key.lastIndexOf(':') + 1)
}

export function createKeyValueStore(
  kv: KeyValueAdapter,
  options?: { namespace?: string },
): CommentStore {
  const ns = options?.namespace ?? DEFAULT_NAMESPACE
  const threadPrefix = `${ns}:t:`
  const commentPrefix = `${ns}:c:`

  const threadKey = (pageKey: string, id: string) => `${threadPrefix}${enc(pageKey)}:${enc(id)}`
  const pagePrefix = (pageKey: string) => `${threadPrefix}${enc(pageKey)}:`
  const commentKey = (threadId: string, id: string) => `${commentPrefix}${enc(threadId)}:${enc(id)}`
  const threadCommentPrefix = (threadId: string) => `${commentPrefix}${enc(threadId)}:`

  const listeners = new Set<() => void>()
  let unwatch: (() => void) | null = null

  function notify(): void {
    const snapshot = Array.from(listeners)
    for (const listener of snapshot) listener()
  }

  async function readThreads(prefix: string): Promise<StoredThread[]> {
    const keys = await kv.keys(prefix)
    if (keys.length === 0) return []
    const values = await kv.get(keys)
    const out: StoredThread[] = []
    for (const key of keys) {
      const value = values[key]
      if (isStoredThread(value)) out.push(value)
    }
    return sortRecords(out)
  }

  async function findThreadKey(id: string): Promise<string | null> {
    const encoded = enc(id)
    const keys = await kv.keys(threadPrefix)
    for (const key of keys) if (lastSegment(key) === encoded) return key
    return null
  }

  async function findCommentKey(id: string): Promise<string | null> {
    const encoded = enc(id)
    const keys = await kv.keys(commentPrefix)
    for (const key of keys) if (lastSegment(key) === encoded) return key
    return null
  }

  const store: CommentStore = {
    name: `key-value:${ns}`,

    getThread: (id) =>
      guardStore(
        async () => {
          const key = await findThreadKey(id)
          if (!key) return null
          const value = (await kv.get([key]))[key]
          return isStoredThread(value) ? value : null
        },
        { threadId: id },
      ),

    listThreads: (pageKey) => guardStore(() => readThreads(pagePrefix(pageKey))),

    listAllThreads: () => guardStore(() => readThreads(threadPrefix)),

    putThread: (thread: Thread) =>
      guardStore(
        async () => {
          const key = threadKey(thread.pageKey, thread.id)
          await kv.set({ [key]: thread })
          // A thread whose pageKey changed lives under a new key: new key first, old key second,
          // so a crash between them can only duplicate a record, never lose one.
          const encoded = enc(thread.id)
          const stale = (await kv.keys(threadPrefix)).filter(
            (k) => k !== key && lastSegment(k) === encoded,
          )
          if (stale.length > 0) await kv.remove(stale)
          notify()
        },
        { threadId: thread.id },
      ),

    deleteThread: (id) =>
      guardStore(
        async () => {
          const key = await findThreadKey(id)
          const commentKeys = await kv.keys(threadCommentPrefix(id))
          const doomed = key ? [key, ...commentKeys] : commentKeys
          if (doomed.length > 0) await kv.remove(doomed) // cascades comments
          notify()
        },
        { threadId: id },
      ),

    listComments: (threadId) =>
      guardStore(
        async () => {
          const keys = await kv.keys(threadCommentPrefix(threadId))
          if (keys.length === 0) return []
          const values = await kv.get(keys)
          const out: Comment[] = []
          for (const key of keys) {
            const value = values[key]
            if (isComment(value)) out.push(value)
          }
          return sortRecords(out)
        },
        { threadId },
      ),

    getComment: (id) =>
      guardStore(
        async () => {
          const key = await findCommentKey(id)
          if (!key) return null
          const value = (await kv.get([key]))[key]
          return isComment(value) ? value : null
        },
        { commentId: id },
      ),

    putComment: (comment) =>
      guardStore(
        async () => {
          await kv.set({ [commentKey(comment.threadId, comment.id)]: comment })
          notify()
        },
        { threadId: comment.threadId, commentId: comment.id },
      ),

    deleteComment: (id) =>
      guardStore(
        async () => {
          const key = await findCommentKey(id)
          if (key) await kv.remove([key]) // never touches the thread record
          notify()
        },
        { commentId: id },
      ),

    subscribe(_pageKey, cb) {
      listeners.add(cb)
      if (!unwatch && kv.watch) {
        // Namespace filtering (§2.8, normative): a shared adapter also carries `copilot`'s run
        // records and the bridge's host range, and a 10 s run heartbeat must not trigger a
        // thread re-read in every tab. Filtering on the two ranges this store actually owns is
        // strictly tighter than `{ns}:`, which would also match the bridge's `{ns}:host:*`.
        unwatch = kv.watch((changed) => {
          const mine = changed.some(
            (key) => key.startsWith(threadPrefix) || key.startsWith(commentPrefix),
          )
          if (mine) notify()
        })
      }
      return () => {
        listeners.delete(cb)
        if (listeners.size === 0 && unwatch) {
          unwatch()
          unwatch = null
        }
      }
    },
  }

  return store
}
