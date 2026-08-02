/**
 * Pure reducers for the §4.1 edge-case table. No store, no clock, no ids — every input is
 * passed in, so each rule is a one-line unit test.
 *
 * DOM-free.
 */

import type { Author, Comment, StoredThread, Thread } from '../types.ts'

import { THREAD_VERSION } from '../types.ts'

/** §4.1 rule 2: "an empty thread cannot exist" is enforced at the domain boundary. */
export function isEmptyBody(body: string): boolean {
  return body.trim() === ''
}

/**
 * §4.1 rule 16: a stored thread whose `v` is not `THREAD_VERSION` is skipped from every list
 * and from the live view, and is never rewritten. Narrowing is the only place that decides.
 */
export function isKnownVersion(thread: StoredThread): boolean {
  return thread.v === THREAD_VERSION
}

export function narrowThread(thread: StoredThread | null | undefined): Thread | null {
  if (!thread || !isKnownVersion(thread)) return null
  return thread as Thread
}

export function defaultReopensOnReply(author: Author): boolean {
  return author === 'user'
}

/**
 * §4.1 rules 3/4/5. A reply reopens iff the thread is resolved AND the author satisfies
 * `reopensOnReply` — and only then is the thread record written at all: `updatedAt` moves on
 * thread-level transitions only (§2.7 adapter rule 7).
 */
export function reduceAppend(
  thread: Thread,
  author: Author,
  reopensOnReply: (author: Author) => boolean,
  nowIso: string,
): { thread: Thread; reopened: boolean } {
  if (thread.status !== 'resolved' || !reopensOnReply(author)) return { thread, reopened: false }
  return {
    thread: { ...thread, status: 'open', resolvedAt: null, resolvedBy: null, updatedAt: nowIso },
    reopened: true,
  }
}

/**
 * §4.1 rule 11. No `by` parameter: `resolvedBy` is always `'user'`. Resolving an
 * already-resolved thread is a no-op that does not re-stamp `resolvedAt`.
 */
export function reduceResolve(
  thread: Thread,
  nowIso: string,
): { thread: Thread; changed: boolean } {
  if (thread.status === 'resolved') return { thread, changed: false }
  return {
    thread: {
      ...thread,
      status: 'resolved',
      resolvedAt: nowIso,
      resolvedBy: 'user',
      updatedAt: nowIso,
    },
    changed: true,
  }
}

/** §4.1 rule 12. Clears `resolvedAt` and `resolvedBy` together. Reopening an open thread is a no-op. */
export function reduceReopen(thread: Thread, nowIso: string): { thread: Thread; changed: boolean } {
  if (thread.status === 'open') return { thread, changed: false }
  return {
    thread: { ...thread, status: 'open', resolvedAt: null, resolvedBy: null, updatedAt: nowIso },
    changed: true,
  }
}

/** §4.1 rule 13. In-place; `editedAt` stamped; no thread write; no tombstones. */
export function reduceEdit(comment: Comment, body: string, nowIso: string): Comment {
  return { ...comment, body, editedAt: nowIso }
}

/** §4.1 rule 1. `status: 'open'`, resolution fields null, `v: THREAD_VERSION`, kind copied. */
export function makeThread(input: {
  id: string
  pageKey: string
  kind: string
  anchor: Thread['anchor']
  capture: Thread['capture']
  nowIso: string
}): Thread {
  return {
    id: input.id,
    v: THREAD_VERSION,
    pageKey: input.pageKey,
    kind: input.kind,
    anchor: input.anchor,
    capture: input.capture,
    status: 'open',
    resolvedAt: null,
    resolvedBy: null,
    createdAt: input.nowIso,
    updatedAt: input.nowIso,
  }
}

export function makeComment(input: {
  id: string
  threadId: string
  author: Author
  body: string
  nowIso: string
}): Comment {
  return {
    id: input.id,
    threadId: input.threadId,
    author: input.author,
    body: input.body,
    createdAt: input.nowIso,
    editedAt: null,
  }
}
