/**
 * Shared store plumbing: the `defineCommentStore` identity helper (§2.7), the one sort order
 * every adapter owes its consumers (§2.7 adapter rule 1), and the shape guards a persisted
 * record must pass before it is handed back.
 *
 * DOM-free.
 */

import type { Comment, CommentStore, StoredThread } from '../types.ts'

/** Identity function; preserves the concrete literal type of a store object. */
export function defineCommentStore<const S extends CommentStore>(store: S): S {
  return store
}

/**
 * `createdAt` ascending, ties broken by `id` ascending (§2.7 adapter rule 1). Consumers never
 * sort, so every list path in every adapter goes through this.
 */
export function compareRecords(
  a: { createdAt: string; id: string },
  b: { createdAt: string; id: string },
): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

export function sortRecords<T extends { createdAt: string; id: string }>(records: T[]): T[] {
  return records.sort(compareRecords)
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Structural guard, deliberately permissive about `v`: an adapter must be able to hand back a
 * record written by a future build (§2.7 `StoredThread`) so §4.1 rule 16 has something to skip.
 */
export function isStoredThread(value: unknown): value is StoredThread {
  if (!isRecordObject(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.v === 'number' &&
    typeof value.pageKey === 'string' &&
    typeof value.createdAt === 'string'
  )
}

export function isComment(value: unknown): value is Comment {
  if (!isRecordObject(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.threadId === 'string' &&
    typeof value.body === 'string' &&
    typeof value.createdAt === 'string'
  )
}

/** Defensive copy, so a caller mutating a returned record cannot reach into the store. */
export function clone<T>(value: T): T {
  return structuredClone(value)
}
