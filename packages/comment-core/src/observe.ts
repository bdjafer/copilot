/**
 * Store-level observation (§2.10) — domain events by diffing consecutive store snapshots,
 * with a durable cursor so a context that was not alive when the write happened still sees it.
 *
 * This is the mechanism that lets an MV3 service worker take `thread:create` / `thread:reply`
 * hooks with no messaging channel at all: the extension storage change event fires in every context and
 * *wakes a dormant worker*, and the cursor is what makes the waking write visible — an
 * in-memory baseline would be taken after it.
 *
 * DOM-free.
 */

import type { DomainSnapshot } from './domain/diff.ts'
import type {
  CommentStore,
  KeyValueAdapter,
  ObserveCursor,
  ObserveOptions,
  StoreEvent,
  Unsubscribe,
} from './types.ts'

import { diffSnapshots, emptySnapshot, sealEvent } from './domain/diff.ts'
import { defaultReopensOnReply, narrowThread } from './domain/reduce.ts'
import { DEFAULT_NAMESPACE } from './store/kv.ts'

/** Bounded tie-breaker set (§2.10.1). */
const SEEN_CAP = 200

interface CursorState {
  /** Max `createdAt` / `editedAt` / `updatedAt` observed. */
  lastSeenAt: string
  /** Record ids at exactly `lastSeenAt`, capped at SEEN_CAP. */
  seen: string[]
}

type RecordKind = 'thread' | 'comment'

const seenKey = (kind: RecordKind, id: string): string => `${kind === 'thread' ? 't' : 'c'}:${id}`

function parseCursor(value: unknown): CursorState | null {
  if (typeof value !== 'object' || value === null) return null
  const state = value as { lastSeenAt?: unknown; seen?: unknown }
  if (typeof state.lastSeenAt !== 'string') return null
  const seen = Array.isArray(state.seen) ? state.seen.filter((v) => typeof v === 'string') : []
  return { lastSeenAt: state.lastSeenAt, seen }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  )
}

/** Default cursor: correct only for a context that outlives every write it must observe. */
function createMemoryCursor(): ObserveCursor {
  let state: unknown = null
  return {
    async load() {
      return state
    },
    async save(next) {
      state = next
    },
  }
}

export function createKeyValueCursor(
  kv: KeyValueAdapter,
  options?: { namespace?: string; id?: string },
): ObserveCursor {
  const key = `${options?.namespace ?? DEFAULT_NAMESPACE}:cursor:${options?.id ?? 'default'}`
  return {
    async load() {
      return (await kv.get([key]))[key] ?? null
    },
    async save(state) {
      await kv.set({ [key]: state })
    },
  }
}

export function observeStore(
  store: CommentStore,
  listener: (event: StoreEvent) => void,
  options?: ObserveOptions,
): Unsubscribe {
  const scope = options?.pageKey ?? null
  const replay = options?.replay ?? false
  const cursor = options?.cursor ?? createMemoryCursor()

  let snapshot: DomainSnapshot = emptySnapshot()
  let primed = false
  let disposed = false
  let running = false
  let pending = false
  let seq = 0

  function schedule(): void {
    if (disposed) return
    if (running) {
      pending = true
      return
    }
    running = true
    // Coalesce every notification raised in this turn into one pass: a non-transactional
    // store notifies once per record write, and rule 7's comment+thread pair must be diffed
    // together to read as a single deletion rather than an intermediate empty thread.
    queueMicrotask(() => void drain())
  }

  async function drain(): Promise<void> {
    try {
      do {
        pending = false
        await pass()
      } while (pending && !disposed)
    } catch {
      // `observeStore` has no error channel in its locked signature. The cursor was not
      // advanced and the snapshot was not committed, so the batch is re-delivered on the next
      // notification — at-least-once, which is what rule 15's idempotency keys are for.
      pending = false
    } finally {
      running = false
    }
  }

  async function pass(): Promise<void> {
    const state = parseCursor(await cursor.load())
    const stored = scope === null ? await store.listAllThreads() : await store.listThreads(scope)

    const next = emptySnapshot()
    for (const candidate of stored) {
      const thread = narrowThread(candidate)
      if (!thread) continue // rule 16: unknown versions are skipped, never rewritten
      const comments = await store.listComments(thread.id)
      if (comments.length === 0) {
        // Invisible as a thread (rule 16), but remembered so a rule-7 auto-GC can be told
        // apart from a rule-8 explicit delete.
        next.emptyThreadIds.add(thread.id)
        continue
      }
      next.threads.set(thread.id, thread)
      next.comments.set(thread.id, new Map(comments.map((c) => [c.id, c])))
    }

    const seen = new Set(state?.seen ?? [])
    const isNew = (kind: RecordKind, id: string, at: string): boolean => {
      if (!state) return primed ? true : replay
      if (at > state.lastSeenAt) return true
      if (at < state.lastSeenAt) return false
      return !seen.has(seenKey(kind, id))
    }

    const events = diffSnapshots(snapshot, next, {
      source: 'remote', // it cannot know origin; guard trigger loops on comment.author (PLAN §8)
      isNew,
      reopensOnReply: defaultReopensOnReply,
    })

    for (const input of events) {
      const result = listener(sealEvent(input, ++seq, Date.now())) as unknown
      // A listener that throws or rejects aborts the pass before the cursor advances.
      if (isThenable(result)) await result
    }

    snapshot = next
    primed = true
    await cursor.save(advanceCursor(state, next))
  }

  const unsubscribe = store.subscribe(scope, schedule)
  schedule() // establish the baseline (or replay) immediately

  return () => {
    if (disposed) return
    disposed = true
    unsubscribe()
  }
}

function advanceCursor(state: CursorState | null, snapshot: DomainSnapshot): CursorState {
  const stamps: Array<{ key: string; at: string }> = []
  let lastSeenAt = state?.lastSeenAt ?? ''

  const observe = (at: string, key?: string): void => {
    if (at > lastSeenAt) lastSeenAt = at
    if (key) stamps.push({ key, at })
  }

  for (const thread of snapshot.threads.values()) {
    observe(thread.createdAt, seenKey('thread', thread.id))
    observe(thread.updatedAt)
  }
  for (const bucket of snapshot.comments.values()) {
    for (const comment of bucket.values()) {
      const key = seenKey('comment', comment.id)
      observe(comment.createdAt, key)
      if (comment.editedAt) observe(comment.editedAt, key)
    }
  }

  const seen = new Set(state && state.lastSeenAt === lastSeenAt ? state.seen : [])
  for (const stamp of stamps) if (stamp.at === lastSeenAt) seen.add(stamp.key)
  const list = [...seen]
  return { lastSeenAt, seen: list.slice(Math.max(0, list.length - SEEN_CAP)) }
}
