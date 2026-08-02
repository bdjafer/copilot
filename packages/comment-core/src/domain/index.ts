/**
 * `createDomain` (§2.9) — the §4.1 edge-case table implemented **once**, headless.
 * `createCommentEngine` inherits it by extension, so the content script and the service worker
 * run the same rules against the same store.
 *
 * DOM-free.
 */

import type {
  AppendCommentInput,
  AppendResult,
  Comment,
  CommentDomain,
  CommentRef,
  CommentStore,
  CreateResult,
  CreateThreadInput,
  DeleteCommentResult,
  DomainOptions,
  StoredThread,
  Thread,
  ThreadFilter,
  ThreadRecord,
} from '../types.ts'

import { CommentError, guardStore } from '../errors.ts'
import { idFactory } from '../ids.ts'
import {
  defaultReopensOnReply,
  isEmptyBody,
  makeComment,
  makeThread,
  narrowThread,
  reduceAppend,
  reduceEdit,
  reduceReopen,
  reduceResolve,
} from './reduce.ts'

export function createDomain(store: CommentStore, options?: DomainOptions): CommentDomain {
  const clock = options?.now ?? (() => new Date())
  const nowIso = (): string => clock().toISOString()
  const createId = idFactory(options?.createId)
  const reopensOnReply = options?.reopensOnReply ?? defaultReopensOnReply
  /** §4.1 rule 16: reported once per record per instance. */
  const reportedVersions = new Set<string>()

  function report(error: CommentError): void {
    try {
      options?.onError?.(error)
    } catch {
      // A faulty error sink must not take down the domain call that reported to it.
    }
  }

  function reportUnsupported(stored: StoredThread): void {
    if (reportedVersions.has(stored.id)) return
    reportedVersions.add(stored.id)
    report(
      new CommentError(
        'unsupported_version',
        `thread ${stored.id} was written by record version ${stored.v}; skipped`,
        { threadId: stored.id },
      ),
    )
  }

  /* ------------------------------------------------------------------ store IO (wrapped) */

  const io = {
    getThread: (id: string) => guardStore(() => store.getThread(id), { threadId: id }),
    listThreads: (pageKey: string) => guardStore(() => store.listThreads(pageKey)),
    listAllThreads: () => guardStore(() => store.listAllThreads()),
    listComments: (threadId: string) =>
      guardStore(() => store.listComments(threadId), { threadId }),
    getComment: (id: string) =>
      store.getComment
        ? guardStore(() => store.getComment!(id), { commentId: id })
        : Promise.resolve(null),
  }

  /**
   * Every mutation goes through here so `store.transaction` is used when the adapter has one
   * and §4.3's write ordering applies verbatim when it does not.
   */
  function write(apply: (s: CommentStore) => Promise<void>): Promise<void> {
    return guardStore(async () => {
      if (store.transaction) await store.transaction(async (tx) => void (await apply(tx)))
      else await apply(store)
    })
  }

  /* ------------------------------------------------------------------------- lookups */

  async function requireThread(threadId: string): Promise<Thread> {
    const stored = await io.getThread(threadId)
    if (!stored)
      throw new CommentError('thread_not_found', `thread ${threadId} not found`, { threadId })
    const thread = narrowThread(stored)
    if (!thread) {
      // Rule 16: unknown versions are never rewritten, so no write path may narrow past here.
      reportUnsupported(stored)
      throw new CommentError(
        'unsupported_version',
        `thread ${threadId} was written by record version ${stored.v}`,
        { threadId },
      )
    }
    return thread
  }

  /**
   * `CommentRef` resolution (§2.9): the tuple form is O(1) on any store, the bare-id form is
   * O(1) when the adapter offers `getComment` and an O(n) scan otherwise — the documented
   * fallback of §2.7.
   */
  async function findComment(ref: CommentRef): Promise<Comment | null> {
    if (typeof ref === 'object') {
      const direct = await io.getComment(ref.id)
      if (direct) return direct
      return (await io.listComments(ref.threadId)).find((c) => c.id === ref.id) ?? null
    }
    if (store.getComment) return await io.getComment(ref)
    for (const stored of await io.listAllThreads()) {
      const hit = (await io.listComments(stored.id)).find((c) => c.id === ref)
      if (hit) return hit
    }
    return null
  }

  /** §4.3: a thread that reads back with zero comments is deleted on read. Silent, no events. */
  async function gcEmptyThread(threadId: string): Promise<void> {
    try {
      await write((s) => s.deleteThread(threadId))
    } catch (error) {
      report(
        error instanceof CommentError
          ? error
          : new CommentError('store_failed', 'read-time GC failed', { threadId, cause: error }),
      )
    }
  }

  function matchesThread(thread: Thread, filter?: ThreadFilter): boolean {
    if (!filter) return true
    if (filter.status && thread.status !== filter.status) return false
    if (filter.since && thread.createdAt < filter.since) return false
    if (filter.kind !== undefined) {
      const kinds = typeof filter.kind === 'string' ? [filter.kind] : filter.kind
      if (!kinds.includes(thread.kind)) return false
    }
    return true
  }

  /* --------------------------------------------------------------------------- domain */

  return {
    async createThread(input: CreateThreadInput): Promise<CreateResult> {
      // Rule 2: rejects before any write.
      if (isEmptyBody(input.body)) throw new CommentError('empty_body')

      // Rule 15: a replayed create is a no-op that reports what is already on disk.
      let repairThread: Thread | null = null
      if (input.id) {
        const stored = await io.getThread(input.id)
        // Rule 16: an unknown-version record is **never rewritten**. Without this branch the
        // dedupe check narrows to `null`, the whole idempotency path is skipped, and a fresh
        // `v: THREAD_VERSION` thread is written straight over the future record's id — the one
        // write path `requireThread` does not cover.
        if (stored && !narrowThread(stored)) {
          reportUnsupported(stored)
          throw new CommentError(
            'unsupported_version',
            `thread ${stored.id} was written by record version ${stored.v}`,
            { threadId: stored.id },
          )
        }
        const existing = narrowThread(stored)
        if (existing) {
          const comments = await io.listComments(existing.id)
          const first =
            (input.commentId ? comments.find((c) => c.id === input.commentId) : undefined) ??
            comments[0]
          if (first) {
            return {
              kind: 'created',
              thread: existing,
              comment: first,
              reopened: false,
              deduped: true,
            }
          }
          // A thread with no comments is a crashed half-write, not a duplicate: re-attach the
          // first comment instead of resurrecting the "empty thread cannot exist" violation.
          repairThread = existing
        }
      } else if (input.commentId) {
        const existing = await findComment(input.commentId)
        const storedOwner = existing ? await io.getThread(existing.threadId) : null
        if (storedOwner && !narrowThread(storedOwner)) {
          // Rule 16 again: replaying a create whose comment already hangs off a future-version
          // thread must not mint a second thread for it.
          reportUnsupported(storedOwner)
          throw new CommentError(
            'unsupported_version',
            `thread ${storedOwner.id} was written by record version ${storedOwner.v}`,
            { threadId: storedOwner.id },
          )
        }
        const owner = narrowThread(storedOwner)
        if (existing && owner) {
          return {
            kind: 'created',
            thread: owner,
            comment: existing,
            reopened: false,
            deduped: true,
          }
        }
      }

      const stamp = nowIso()
      const thread =
        repairThread ??
        makeThread({
          id: input.id ?? createId(),
          pageKey: input.pageKey,
          kind: input.kind,
          anchor: input.anchor,
          capture: input.capture,
          nowIso: stamp,
        })
      const comment = makeComment({
        id: input.commentId ?? createId(),
        threadId: thread.id,
        author: input.author,
        body: input.body,
        nowIso: stamp,
      })

      // §4.3: comment first, thread second. A crash between them leaves an invisible orphan
      // comment; the inverse order would leave the empty thread the invariant forbids.
      await write(async (s) => {
        await s.putComment(comment)
        if (!repairThread) await s.putThread(thread)
      })

      return { kind: 'created', thread, comment, reopened: false, deduped: false }
    },

    async appendComment(threadId: string, input: AppendCommentInput): Promise<AppendResult> {
      if (isEmptyBody(input.body)) throw new CommentError('empty_body', undefined, { threadId })
      const thread = await requireThread(threadId) // rule 9: no resurrection

      if (input.id) {
        const existing = store.getComment
          ? await io.getComment(input.id)
          : ((await io.listComments(threadId)).find((c) => c.id === input.id) ?? null)
        // Rule 15's key is an idempotency key **for this append**, and `getComment` is a global
        // O(1) lookup (§2.7), so the hit has to be scoped back to the target thread. Otherwise
        // a host-chosen key (SPEC-copilot §7.3's `id: \`r:${runId}\``) that already exists on a
        // different thread returns an `AppendResult` whose `comment.threadId` contradicts its
        // `thread.id`, and the append silently never lands on the thread it was asked for.
        if (existing && existing.threadId === threadId) {
          return { kind: 'replied', thread, comment: existing, reopened: false, deduped: true }
        }
        if (existing) {
          // Writing it anyway would mint a second comment sharing one id, which makes the
          // store's own `getComment(id)` / `deleteComment(id)` ambiguous. It is a caller bug.
          throw new CommentError(
            'invalid_options',
            `comment id ${input.id} already exists on thread ${existing.threadId}`,
            { threadId, commentId: input.id },
          )
        }
      }

      const stamp = nowIso()
      const { thread: next, reopened } = reduceAppend(thread, input.author, reopensOnReply, stamp)
      const comment = makeComment({
        id: input.id ?? createId(),
        threadId,
        author: input.author,
        body: input.body,
        nowIso: stamp,
      })

      // §4.2.4 state precedes content: the reopen lands before the reply, so an observer bound
      // only to content events can never see a reply against a stale status. Rules 4 and 5: no
      // thread write at all when the reply does not reopen.
      await write(async (s) => {
        if (reopened) await s.putThread(next)
        await s.putComment(comment)
      })

      return { kind: 'replied', thread: next, comment, reopened, deduped: false }
    },

    async editComment(ref: CommentRef, body: string): Promise<Comment> {
      if (isEmptyBody(body)) throw new CommentError('empty_body')
      const comment = await findComment(ref)
      if (!comment) {
        throw new CommentError('comment_not_found', undefined, {
          commentId: typeof ref === 'string' ? ref : ref.id,
        })
      }
      const next = reduceEdit(comment, body, nowIso())
      await write((s) => s.putComment(next)) // rule 13: no thread write
      return next
    },

    async deleteComment(ref: CommentRef): Promise<DeleteCommentResult> {
      const comment = await findComment(ref)
      if (!comment) {
        throw new CommentError('comment_not_found', undefined, {
          commentId: typeof ref === 'string' ? ref : ref.id,
        })
      }
      const threadId = comment.threadId
      const siblings = await io.listComments(threadId)
      const remaining = siblings.filter((c) => c.id !== comment.id)
      const stored = await io.getThread(threadId)
      const thread = narrowThread(stored)

      // Rule 7 keys off the record **existing**, not off it being readable: gating the cascade
      // on the narrowed thread leaves a zero-comment thread on disk behind an unknown-version
      // record, which is the "an empty thread cannot exist" invariant broken. Deleting is not
      // rewriting (rule 16), which is why `delete()` is version-agnostic too.
      if (remaining.length === 0 && stored) {
        // Rule 7 + §4.3: comment first, then thread. A crash between leaves an empty thread,
        // which the next read GCs.
        await write(async (s) => {
          await s.deleteComment(comment.id)
          await s.deleteThread(threadId)
        })
        return { comment, threadDeleted: true, thread: null }
      }

      // Rule 6: the thread, its anchor, its capture and the remaining comments survive, and
      // `updatedAt` does not move.
      await write((s) => s.deleteComment(comment.id))
      return { comment, threadDeleted: false, thread }
    },

    async resolve(threadId: string): Promise<Thread> {
      const thread = await requireThread(threadId)
      const { thread: next, changed } = reduceResolve(thread, nowIso())
      if (changed) await write((s) => s.putThread(next))
      return next
    },

    async reopen(threadId: string): Promise<Thread> {
      const thread = await requireThread(threadId)
      const { thread: next, changed } = reduceReopen(thread, nowIso())
      if (changed) await write((s) => s.putThread(next))
      return next
    },

    async delete(threadId: string): Promise<void> {
      // Deliberately version-agnostic: deleting an unknown-version record is not "rewriting"
      // it, and a host must be able to clear junk a future build wrote.
      const stored = await io.getThread(threadId)
      if (!stored) throw new CommentError('thread_not_found', undefined, { threadId })
      await write((s) => s.deleteThread(threadId)) // cascades comments
    },

    async get(threadId: string): Promise<ThreadRecord | null> {
      const stored = await io.getThread(threadId)
      if (!stored) return null
      const thread = narrowThread(stored)
      if (!thread) {
        reportUnsupported(stored)
        return null
      }
      const comments = await io.listComments(threadId)
      if (comments.length === 0) {
        await gcEmptyThread(threadId)
        return null
      }
      return { thread, comments }
    },

    async list(filter?: ThreadFilter): Promise<ThreadRecord[]> {
      // `undefined` and `null` are both "all pages" here: a headless domain has no current
      // page to default to (§2.9 ThreadFilter).
      const scope = filter?.pageKey
      const stored =
        scope === undefined || scope === null
          ? await io.listAllThreads()
          : await io.listThreads(scope)

      const records: ThreadRecord[] = []
      for (const candidate of stored) {
        const thread = narrowThread(candidate)
        if (!thread) {
          reportUnsupported(candidate)
          continue
        }
        if (!matchesThread(thread, filter)) continue
        const comments = await io.listComments(thread.id)
        if (comments.length === 0) {
          await gcEmptyThread(thread.id)
          continue
        }
        if (filter?.author && !comments.some((c) => c.author === filter.author)) continue
        records.push({ thread, comments })
      }
      // The store already sorted by createdAt ascending (§2.7 adapter rule 1).
      return records
    },
  }
}
