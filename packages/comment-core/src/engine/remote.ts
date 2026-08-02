/**
 * Remote-echo dedupe (§4.2.8).
 *
 * Every write the engine performs is recorded as a **per-write origin token** in a bounded
 * 500-entry set; an echo arriving back through `store.subscribe` whose token is in the set is
 * dropped once and the token retired.
 *
 * Wall-clock dedupe on `(id, updatedAt)` is explicitly wrong and is not used anywhere here:
 * two writes in the same millisecond — routine for a `resolve()` + auto-reopen sequence, and
 * *guaranteed* under the spec-sanctioned `now: () => new Date(0)` test stub — would collapse a
 * genuine remote change into a "local echo" and silently drop another tab's edit.
 *
 * **Deviation from §4.2.8, deliberate and local.** The spec says the token `w` is "written
 * alongside the record by the store adapter's own key layout". It cannot be: the `CommentStore`
 * port is locked at nine methods that take `Thread` / `Comment` by value, and §2.2 says those
 * records "gain no further fields, ever" — there is nowhere on the wire to put a token. The
 * token therefore lives in this engine-local set only, which preserves the property the rule
 * exists for (dedupe is per-write and never temporal) and loses only the ability to attribute
 * an echo to a *specific* remote instance, which nothing consumes.
 */

import type { StoreEventInput } from '../domain/diff.ts'

/** Bounded set size (§4.2.8). */
export const TOKEN_LIMIT = 500

export type TokenKind =
  /** a thread record write: create, resolve, reopen */
  | 't'
  /** a comment record write: reply */
  | 'c'
  /** a comment record edit */
  | 'e'
  /** a comment record removal */
  | 'x'
  /** a thread removal */
  | 'd'

export interface OriginTokens {
  /** Record a write this engine just performed. */
  record(kind: TokenKind, id: string): void
  /** True when `event` is this engine's own echo — retires the token. */
  consume(event: StoreEventInput): boolean
  /** Open a diff pass: everything recorded up to now is this pass's to consume or retire. */
  beginPass(): void
  /**
   * Retire tokens whose echo never arrived in the pass that claimed them. **This is what keeps
   * the set from under-notifying.**
   *
   * A local write updates the engine's `records` map before the queued reload takes its snapshot
   * baseline, so the echo diff for that write is usually empty and the token is never consumed.
   * Left pending, it sits in the set and eats the next genuine event with the same
   * `t:`/`c:`/`e:`/`x:`/`d:` key — another tab's `reopen()` of the thread this engine just
   * `resolve()`d would be dropped on the floor, which is exactly the "silently drop another
   * tab's edit" failure §4.2.8 exists to prevent.
   *
   * A token recorded *during* the pass (after `beginPass`) survives into the next one, so the
   * window between a store read and the diff cannot retire a token whose echo has not been
   * looked at yet. Dedupe stays per-write and never temporal.
   */
  sweep(): void
  readonly size: number
  clear(): void
}

function tokenOf(event: StoreEventInput): string {
  switch (event.type) {
    case 'thread:create':
      return `t:${event.payload.thread.id}`
    case 'thread:reply':
      return `c:${event.payload.comment.id}`
    case 'thread:resolve':
    case 'thread:reopen':
      return `t:${event.payload.thread.id}`
    case 'thread:delete':
      return `d:${event.payload.thread.id}`
    case 'comment:edit':
      return `e:${event.payload.comment.id}`
    case 'comment:delete':
      return `x:${event.payload.comment.id}`
  }
}

interface Entry {
  /** Outstanding echoes for this token. */
  count: number
  /** The sweep generation the token was recorded in. */
  gen: number
}

export function createOriginTokens(limit = TOKEN_LIMIT): OriginTokens {
  /** token → entry. A Map keeps FIFO insertion order for the bounded eviction. */
  const pending = new Map<string, Entry>()
  let generation = 0

  return {
    record(kind, id) {
      const key = `${kind}:${id}`
      const entry = pending.get(key)
      if (entry) {
        entry.count += 1
        entry.gen = generation
      } else {
        pending.set(key, { count: 1, gen: generation })
      }
      while (pending.size > limit) {
        const oldest = pending.keys().next().value
        if (oldest === undefined) break
        pending.delete(oldest)
      }
    },

    consume(event) {
      const key = tokenOf(event)
      const entry = pending.get(key)
      if (!entry) return false
      if (entry.count === 1) pending.delete(key)
      else entry.count -= 1
      return true
    },

    beginPass() {
      generation += 1
    },

    sweep() {
      for (const [key, entry] of pending) if (entry.gen < generation) pending.delete(key)
    },

    get size() {
      return pending.size
    },

    clear() {
      pending.clear()
      generation = 0
    },
  }
}
