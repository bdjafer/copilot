/**
 * The three disjoint key ranges of SPEC-comment-core §6, in one place.
 *
 * | Range              | Owner          | Contents                                              |
 * |--------------------|----------------|-------------------------------------------------------|
 * | `exp-spec:*`       | `comment-core` | thread and comment records (`:t:` / `:c:` subranges)   |
 * | `runs:*`           | `copilot`      | run records, leases                                   |
 * | `exp-spec:host:*`  | **the bridge** | pending set, thread→run index, cursors, unread, failed, settings |
 *
 * There is no fourth range: everything the bridge owns, settings included, is under
 * `exp-spec:host:*`.
 *
 * `exp-spec:host:*` sits *inside* the comment-core namespace on purpose — §6 names that exact
 * string — and it is safe because `createKeyValueStore` filters its `watch` to `{ns}:t:` and
 * `{ns}:c:` (never the bare `{ns}:`), so host writes never wake a thread re-read in every tab.
 * The reverse holds too: nothing in this module ever writes under `:t:` or `:c:`.
 */

/** comment-core's namespace. Thread/comment records live at `exp-spec:t:*` / `exp-spec:c:*`. */
export const COMMENT_NS = 'exp-spec'

/** copilot's namespace. Run records at `runs:r:*`, leases at `runs:l:*`. */
export const RUN_NS = 'runs'

/** The bridge's own namespace, a subrange of `COMMENT_NS`. */
export const HOST_NS = `${COMMENT_NS}:host`

/** `observeStore` cursor ids. One per consumer — two consumers must never share a cursor. */
export const CURSOR_DISPATCH = 'dispatch'
export const CURSOR_CANCEL = 'cancel'

/**
 * Settings are bridge-owned state, so they live in the bridge's own range. §6 binds the three
 * namespaces "and nothing else"; a fourth top-level key is exactly the drift that table exists
 * to prevent. Nothing else in the range starts with `settings` — every other member is under
 * `:pending:` / `:run:` / `:unread:` / `:failed:` / `:cursor:`.
 */
export const SETTINGS_KEY = `${HOST_NS}:settings`

/**
 * Where settings lived before they moved into the host range. Read-only: `loadSettings` falls
 * back to it once, so an existing profile does not silently reset to defaults; the next save
 * writes at `SETTINGS_KEY` and the legacy key is never written again.
 */
export const LEGACY_SETTINGS_KEY = `${COMMENT_NS}:settings`

/* ----------------------------------------------------------------- host range */

const enc = encodeURIComponent

/**
 * Per-record keys, never a single mutable set object. A service worker and any number of
 * content scripts write this range concurrently; read-modify-write over one array key loses
 * entries silently, which is precisely the failure §6 says the durable pending set must not
 * have.
 */
export const PENDING_PREFIX = `${HOST_NS}:pending:`
export const pendingPagePrefix = (pageKey: string): string => `${PENDING_PREFIX}${enc(pageKey)}:`
export const pendingKey = (pageKey: string, threadId: string): string =>
  `${pendingPagePrefix(pageKey)}${enc(threadId)}`

/**
 * thread → run index. Batch runs are not thread-prefixed, so `cancelByPrefix` cannot find them.
 *
 * Keyed on **(thread, run)**, not on the thread alone: a thread can be covered by a live batch
 * run and a single run at the same time (a human reply during a review). One slot per thread
 * would let the second `indexRun` erase the first, and the first run's `run:settled` would then
 * clear an index row belonging to a run that is still going.
 */
export const RUN_INDEX_PREFIX = `${HOST_NS}:run:`
export const runIndexThreadPrefix = (threadId: string): string =>
  `${RUN_INDEX_PREFIX}${enc(threadId)}:`
export const runIndexKey = (threadId: string, runId: string): string =>
  `${runIndexThreadPrefix(threadId)}${enc(runId)}`

/**
 * Splits a run-index key back into its two encoded segments. Unambiguous because `enc` escapes
 * `:` in both components, so the first `:` after the prefix is always the separator.
 */
export function parseRunIndexKey(key: string): { threadId: string; runId: string } | null {
  if (!key.startsWith(RUN_INDEX_PREFIX)) return null
  const rest = key.slice(RUN_INDEX_PREFIX.length)
  const cut = rest.indexOf(':')
  if (cut <= 0) return null
  return {
    threadId: decodeURIComponent(rest.slice(0, cut)),
    runId: decodeURIComponent(rest.slice(cut + 1)),
  }
}

/** Unread copilot replies, cleared when the page shows the thread. */
export const UNREAD_PREFIX = `${HOST_NS}:unread:`
export const unreadKey = (threadId: string): string => `${UNREAD_PREFIX}${enc(threadId)}`

/**
 * Last terminal failure per thread. Durable for the same reason `unread` is: a chip rebuilt
 * from durable state on every `refresh()` and every page load would otherwise erase the one
 * signal that a run died — leaving a thread that looks like it was never sent.
 */
export const FAILED_PREFIX = `${HOST_NS}:failed:`
export const failedKey = (threadId: string): string => `${FAILED_PREFIX}${enc(threadId)}`

/** Last `:`-delimited segment, decoded. Safe because every id component is URL-encoded. */
export const idFromKey = (key: string): string =>
  decodeURIComponent(key.slice(key.lastIndexOf(':') + 1))

/* ------------------------------------------------------------------ run ids */

/**
 * Run ids are `c:{threadId}:{commentId}` — thread-prefixed, so "cancel this thread's work" is a
 * prefix operation with no side index (SPEC-copilot §6). Keying on the comment id alone would
 * make `cancelByPrefix('c:${threadId}:')` a permanent no-op.
 */
export const singleRunId = (threadId: string, commentId: string): string =>
  `c:${threadId}:${commentId}`
export const threadRunPrefix = (threadId: string): string => `c:${threadId}:`

/**
 * One member of a batch run's content address: the thread **and the comment it was submitted
 * at**.
 *
 * Hashing the thread ids alone would make a run id a permanent fingerprint of a thread set, so
 * that set could be reviewed exactly once ever: reply to the copilot, press Send again, and
 * `copilot.trigger` dedupes against the terminal record of the first run — pending cleared,
 * `{ ok: true }` returned, nothing run. Including the tip comment id keeps the property that
 * actually matters (an SW replay of one submit is idempotent, because the tips have not moved)
 * without freezing the thread set forever.
 */
export const batchToken = (threadId: string, tipCommentId?: string): string =>
  // The `c` prefix keeps "no comments" (`t1#`) distinct from a comment literally named like the
  // sentinel would be — the token is hashed, so an ambiguity here is an undetectable collision.
  tipCommentId === undefined ? `${threadId}#` : `${threadId}#c${tipCommentId}`

/** Batch run ids are page-prefixed and content-addressed, so a replayed submit dedupes. */
export const batchRunId = (pageKey: string, tokens: readonly string[]): string =>
  `b:${pageKey}:${hashIds(tokens)}`

/** djb2 over the sorted id list. Only needs to be stable and short, not cryptographic. */
export function hashIds(ids: readonly string[]): string {
  let hash = 5381
  for (const id of [...ids].sort()) {
    for (let i = 0; i < id.length; i++) hash = ((hash << 5) + hash + id.charCodeAt(i)) | 0
    hash = ((hash << 5) + hash + 58) | 0
  }
  return (hash >>> 0).toString(36)
}
