/**
 * In-memory store (§2.8). Test default.
 *
 * Deliberately does NOT implement `transaction`: leaving it absent makes §4.3's
 * comment-first/thread-second crash-safety ordering the path every default test exercises.
 * A store that wants the transactional path is a five-line wrapper (see the domain tests).
 *
 * DOM-free.
 */

import type { Comment, CommentStore, StoredThread, Thread, ThreadRecord } from '../types.ts'

import { clone, sortRecords } from './common.ts'

export interface MemoryStore extends CommentStore {
  /** Deep snapshot for assertions. */
  snapshot(): ThreadRecord[]
  restore(records: readonly ThreadRecord[]): void
  readonly reads: number
  readonly writes: number
}

/** In-memory store. Test default. */
export function createMemoryStore(seed?: readonly ThreadRecord[]): MemoryStore {
  const threads = new Map<string, StoredThread>()
  /** threadId → commentId → Comment. Comments live beside threads, never inside them (§3.6). */
  const comments = new Map<string, Map<string, Comment>>()
  const listeners = new Set<() => void>()
  let reads = 0
  let writes = 0

  function notify(): void {
    // Snapshot: a listener that unsubscribes during notification must not shift the iteration.
    const snapshot = Array.from(listeners)
    for (const listener of snapshot) listener()
  }

  function load(records: readonly ThreadRecord[]): void {
    threads.clear()
    comments.clear()
    for (const record of records) {
      threads.set(record.thread.id, clone(record.thread))
      const bucket = new Map<string, Comment>()
      for (const comment of record.comments) bucket.set(comment.id, clone(comment))
      comments.set(record.thread.id, bucket)
    }
  }

  if (seed) load(seed)

  const store: MemoryStore = {
    name: 'memory',

    async getThread(id) {
      reads++
      const thread = threads.get(id)
      return thread ? clone(thread) : null
    },

    async listThreads(pageKey) {
      reads++
      const out: StoredThread[] = []
      for (const thread of threads.values()) if (thread.pageKey === pageKey) out.push(clone(thread))
      return sortRecords(out)
    },

    async listAllThreads() {
      reads++
      return sortRecords([...threads.values()].map(clone))
    },

    async putThread(thread: Thread) {
      writes++
      threads.set(thread.id, clone(thread))
      if (!comments.has(thread.id)) comments.set(thread.id, new Map())
      notify()
    },

    async deleteThread(id) {
      writes++
      threads.delete(id)
      comments.delete(id) // cascades comments (§2.7 adapter rule 3)
      notify()
    },

    async listComments(threadId) {
      reads++
      const bucket = comments.get(threadId)
      return bucket ? sortRecords([...bucket.values()].map(clone)) : []
    },

    async getComment(id) {
      reads++
      for (const bucket of comments.values()) {
        const comment = bucket.get(id)
        if (comment) return clone(comment)
      }
      return null
    },

    async putComment(comment) {
      writes++
      let bucket = comments.get(comment.threadId)
      if (!bucket) {
        bucket = new Map()
        comments.set(comment.threadId, bucket)
      }
      bucket.set(comment.id, clone(comment))
      notify()
    },

    async deleteComment(id) {
      writes++
      // Never touches the owning thread record (§2.7 adapter rule 3).
      for (const bucket of comments.values()) if (bucket.delete(id)) break
      notify()
    },

    subscribe(_pageKey, cb) {
      // Ignoring pageKey is legal (§2.7 adapter rule 5): over-notify, never under-notify.
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },

    snapshot() {
      const records: ThreadRecord[] = []
      for (const thread of sortRecords([...threads.values()])) {
        const bucket = comments.get(thread.id)
        records.push({
          thread: clone(thread) as Thread,
          comments: bucket ? sortRecords([...bucket.values()].map(clone)) : [],
        })
      }
      return records
    },

    restore(records) {
      load(records)
      notify()
    },

    get reads() {
      return reads
    },

    get writes() {
      return writes
    },
  }

  return store
}
