/**
 * Snapshot diff → store events (§2.13 `StoreEventMap`), used by `observeStore` and, in the DOM
 * half, by the engine's remote path.
 *
 * Pure: no store, no clock, no sequence numbers. The caller seals each input into a
 * `StoreEvent` with its own `seq`/`at`.
 *
 * Ordering inside one pass (§4.2.4 / §4.2.5 / §2.10.5):
 *   per thread — state (`resolve` | `reopen`) → replies in `createdAt` order → edits → deletes;
 *   then thread deletions, in `createdAt` order.
 *
 * DOM-free.
 */

import type {
  Author,
  Comment,
  EventSource,
  StoreEvent,
  StoreEventMap,
  StoreEventName,
  Thread,
} from '../types.ts'

import { compareRecords } from '../store/common.ts'

/** A store event before `seq`/`at` are stamped on it. */
export type StoreEventInput = {
  [K in StoreEventName]: { type: K; payload: StoreEventMap[K] }
}[StoreEventName]

export interface DomainSnapshot {
  /** Known-version threads with at least one comment. Empty threads are never surfaced. */
  threads: Map<string, Thread>
  /** threadId → commentId → Comment. */
  comments: Map<string, Map<string, Comment>>
  /**
   * Thread records that exist in the store but currently read back with zero comments — the
   * intermediate state of the last-comment GC (§4.3). They are invisible as threads, but they
   * are what tells a delete apart from a rule-7 auto-GC.
   */
  emptyThreadIds: Set<string>
}

export interface DiffOptions {
  source: EventSource
  /**
   * True when a record that is absent from `prev` has never been observed by any earlier
   * incarnation of this consumer — i.e. it is after the durable cursor (§2.10).
   */
  isNew: (kind: 'thread' | 'comment', id: string, at: string) => boolean
  reopensOnReply: (author: Author) => boolean
}

export function emptySnapshot(): DomainSnapshot {
  return { threads: new Map(), comments: new Map(), emptyThreadIds: new Set() }
}

/** Stamp a diff result into a deliverable event. */
export function sealEvent(input: StoreEventInput, seq: number, at: number): StoreEvent {
  return { type: input.type, seq, at, payload: input.payload } as StoreEvent
}

function sorted(map: Map<string, Comment> | undefined): Comment[] {
  return map ? [...map.values()].sort(compareRecords) : []
}

export function diffSnapshots(
  prev: DomainSnapshot,
  next: DomainSnapshot,
  options: DiffOptions,
): StoreEventInput[] {
  const { source, isNew, reopensOnReply } = options
  const events: StoreEventInput[] = []

  for (const thread of [...next.threads.values()].sort(compareRecords)) {
    const nextComments = next.comments.get(thread.id)
    const prevComments = prev.comments.get(thread.id)
    const nextList = sorted(nextComments)
    const prevThread = prev.threads.get(thread.id)

    if (!prevThread) {
      if (nextList.length === 0) continue // an empty thread is never surfaced (rule 16)

      if (isNew('thread', thread.id, thread.createdAt)) {
        // §4.2.3: the first comment is a `thread:create`, never a `thread:reply`.
        const [first, ...rest] = nextList
        events.push({ type: 'thread:create', payload: { thread, comment: first!, source } })
        for (const comment of rest) {
          events.push({ type: 'thread:reply', payload: { thread, comment, source } })
        }
        continue
      }

      // Pre-existing thread we are seeing for the first time (cold start): adopt it silently,
      // but its comments may still be new relative to the cursor.
      for (const comment of nextList) {
        if (isNew('comment', comment.id, comment.createdAt)) {
          events.push({ type: 'thread:reply', payload: { thread, comment, source } })
        } else if (comment.editedAt && isNew('comment', comment.id, comment.editedAt)) {
          // The edit happened while this consumer was down, so the previous body is genuinely
          // unrecoverable — `''` is the unambiguous sentinel, since rule 2 makes an empty body
          // impossible on a real record.
          events.push({
            type: 'comment:edit',
            payload: { thread, comment, previousBody: '', source },
          })
        }
      }
      continue
    }

    const replies: Comment[] = []
    const edits: Comment[] = []
    const removed: Comment[] = []
    for (const comment of nextList) {
      const before = prevComments?.get(comment.id)
      if (!before) {
        if (isNew('comment', comment.id, comment.createdAt)) replies.push(comment)
      } else if (before.body !== comment.body || before.editedAt !== comment.editedAt) {
        edits.push(comment)
      }
    }
    for (const before of sorted(prevComments)) {
      if (!nextComments?.has(before.id)) removed.push(before)
    }

    if (prevThread.status !== thread.status) {
      if (thread.status === 'resolved') {
        events.push({ type: 'thread:resolve', payload: { thread, source } })
      } else {
        // §2.10.5: `reason: 'reply'` iff the same diff adds a comment whose author reopens.
        const byReply = replies.some((comment) => reopensOnReply(comment.author))
        events.push({
          type: 'thread:reopen',
          payload: { thread, reason: byReply ? 'reply' : 'explicit', source },
        })
      }
    }
    for (const comment of replies) {
      events.push({ type: 'thread:reply', payload: { thread, comment, source } })
    }
    for (const comment of edits) {
      const previousBody = prevComments?.get(comment.id)?.body ?? ''
      events.push({ type: 'comment:edit', payload: { thread, comment, previousBody, source } })
    }
    for (const comment of removed) {
      events.push({
        type: 'comment:delete',
        payload: { thread, comment, threadDeleted: false, source },
      })
    }
  }

  for (const thread of [...prev.threads.values()].sort(compareRecords)) {
    if (next.threads.has(thread.id)) continue
    const comments = sorted(prev.comments.get(thread.id))

    if (next.emptyThreadIds.has(thread.id)) {
      // Rule 7: the record is still on disk with no comments left — the auto-GC's own
      // intermediate state. Deletion order is `comment:delete` → `thread:delete` (§4.2.5).
      for (const comment of comments) {
        events.push({
          type: 'comment:delete',
          payload: { thread: null, comment, threadDeleted: true, source },
        })
      }
      events.push({ type: 'thread:delete', payload: { thread, comments, reason: 'empty', source } })
    } else {
      // Rule 8: an explicit thread deletion emits only `thread:delete`, carrying the full
      // comment list.
      events.push({
        type: 'thread:delete',
        payload: { thread, comments, reason: 'explicit', source },
      })
    }
  }

  return events
}
