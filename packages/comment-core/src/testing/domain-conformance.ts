/**
 * `domainConformance` (§2.16) — the executable form of the §4.1 edge-case table, for the 15
 * rows a headless domain can observe. Rows 14 (orphaning) and 17 (`startPlacement`) are
 * render-time and trigger-time and belong to `engineConformance()`.
 *
 * Rule 16 is asserted through `DomainOptions.onError`, which exists for exactly that reason: a
 * domain has no event bus, and a rule the conformance suite cannot observe is a rule that will
 * regress.
 *
 * DOM-free.
 */

import type { CommentDomain, CommentStore, Thread } from '../types.ts'
import type { Awaitable, ConformanceCase } from './types.ts'

import { createDomain } from '../domain/index.ts'
import { CommentError } from '../errors.ts'
import { assert, assertEqual, assertIds, assertRejects } from './assert.ts'
import { countingIds, makeCreateInput, makeThreadRecord, tickingClock } from './fixtures.ts'

interface Harness {
  store: CommentStore
  domain: CommentDomain
  errors: CommentError[]
}

export function domainConformance(factory: () => Awaitable<CommentStore>): ConformanceCase[] {
  const cases: ConformanceCase[] = []
  const test = (name: string, run: (h: Harness) => Promise<void>): void => {
    cases.push({
      name: `domain: ${name}`,
      run: async () => {
        const store = await factory()
        const errors: CommentError[] = []
        const domain = createDomain(store, {
          now: tickingClock(),
          createId: countingIds(),
          onError: (error) => errors.push(error),
        })
        await run({ store, domain, errors })
      },
    })
  }

  /* ------------------------------------------------------------------------- rule 1 */

  test('rule 1 — createThread stamps an open thread with its first comment', async ({
    domain,
    store,
  }) => {
    const result = await domain.createThread(makeCreateInput({ kind: 'ask', body: 'hello' }))
    assertEqual(result.kind, 'created', 'createThread must resolve with a CreateResult')
    assertEqual(result.reopened, false, 'create is never a reopen')
    assertEqual(result.deduped, false, 'a fresh create is never deduped')
    assertEqual(result.thread.status, 'open', 'a new thread is open')
    assertEqual(result.thread.resolvedAt, null, 'resolvedAt starts null')
    assertEqual(result.thread.resolvedBy, null, 'resolvedBy starts null')
    assertEqual(result.thread.kind, 'ask', 'kind is copied verbatim from the input')
    assertEqual(result.thread.v, 1, 'THREAD_VERSION is stamped on every written thread')
    assertEqual(result.comment.body, 'hello', 'the first comment carries the input body')
    assertEqual(result.comment.threadId, result.thread.id, 'the comment belongs to the thread')
    assertEqual(result.comment.editedAt, null, 'a fresh comment is not edited')
    assertIds(
      await store.listComments(result.thread.id),
      [result.comment.id],
      'the comment is persisted',
    )
    assert(await store.getThread(result.thread.id), 'the thread is persisted')
  })

  test('rule 1 — the first comment is written before the thread (§4.3)', async ({ store }) => {
    // The inverse order could leave the empty thread the invariant forbids; this order can only
    // leave an invisible orphan comment. Observed through the port, not through the adapter.
    const calls: string[] = []
    const spy: CommentStore = {
      ...store,
      putThread: (thread) => {
        calls.push('putThread')
        return store.putThread(thread)
      },
      putComment: (comment) => {
        calls.push('putComment')
        return store.putComment(comment)
      },
    }
    const result = await createDomain(spy, {
      now: tickingClock(),
      createId: countingIds(),
    }).createThread(makeCreateInput())

    if (calls.length > 0) {
      assertEqual(calls[0], 'putComment', 'the comment must be written first (§4.3)')
      assertEqual(calls[1], 'putThread', 'the thread must be written second (§4.3)')
    }
    // With `store.transaction` the writes are atomic and the question does not arise; either
    // way both records must exist once the create resolves.
    assert(await store.getThread(result.thread.id), 'the thread must be persisted')
    assertEqual(
      (await store.listComments(result.thread.id)).length,
      1,
      'the comment must be persisted',
    )
  })

  /* ------------------------------------------------------------------------- rule 2 */

  test('rule 2 — an empty body rejects before any write', async ({ domain, store }) => {
    await assertRejects(
      () => domain.createThread(makeCreateInput({ body: '   ' })),
      'empty_body',
      'createThread must reject a blank body',
    )
    assertIds(await store.listAllThreads(), [], 'nothing may be written for a rejected create')

    const { thread } = await domain.createThread(makeCreateInput())
    await assertRejects(
      () => domain.appendComment(thread.id, { author: 'user', body: '\n\t ' }),
      'empty_body',
      'appendComment must reject a blank body',
    )
    assertEqual((await store.listComments(thread.id)).length, 1, 'no comment may be written')
  })

  /* ------------------------------------------------------------------------- rule 3 */

  test('rule 3 — a user reply to a resolved thread auto-reopens it', async ({ domain }) => {
    const { thread } = await domain.createThread(makeCreateInput())
    const resolved = await domain.resolve(thread.id)
    const result = await domain.appendComment(thread.id, { author: 'user', body: 'not done' })
    assertEqual(result.reopened, true, 'AppendResult.reopened must be true')
    assertEqual(result.thread.status, 'open', 'the thread must be open again')
    assertEqual(result.thread.resolvedAt, null, 'resolvedAt must be cleared')
    assertEqual(result.thread.resolvedBy, null, 'resolvedBy must be cleared')
    assert(
      result.thread.updatedAt > resolved.updatedAt,
      'a thread-level transition must bump updatedAt',
    )
  })

  /* ------------------------------------------------------------------------- rule 4 */

  test('rule 4 — a copilot reply to a resolved thread leaves it resolved', async ({
    domain,
    store,
  }) => {
    const { thread } = await domain.createThread(makeCreateInput())
    const resolved = await domain.resolve(thread.id)
    const result = await domain.appendComment(thread.id, { author: 'copilot', body: 'done?' })
    assertEqual(result.reopened, false, 'a machine reply must never reopen')
    assertEqual(result.thread.status, 'resolved', 'status must be untouched')
    assertEqual(result.thread.resolvedAt, resolved.resolvedAt, 'resolvedAt must be untouched')
    assertEqual(result.thread.resolvedBy, 'user', 'resolvedBy must be untouched')
    const stored = await store.getThread(thread.id)
    assertEqual(stored?.updatedAt, resolved.updatedAt, 'no thread write at all — updatedAt frozen')
  })

  /* ------------------------------------------------------------------------- rule 5 */

  test('rule 5 — a reply to an open thread does not write the thread record', async ({
    domain,
    store,
  }) => {
    const { thread } = await domain.createThread(makeCreateInput())
    const result = await domain.appendComment(thread.id, { author: 'user', body: 'second' })
    assertEqual(result.reopened, false, 'an open thread is not reopened')
    const stored = await store.getThread(thread.id)
    assertEqual(stored?.updatedAt, thread.updatedAt, 'updatedAt must not move on a comment write')
    assertEqual((await store.listComments(thread.id)).length, 2, 'the reply is persisted')
  })

  /* ------------------------------------------------------------------------- rule 6 */

  test('rule 6 — deleting the first comment keeps the thread and its replies', async ({
    domain,
    store,
  }) => {
    const { thread, comment } = await domain.createThread(makeCreateInput())
    const reply = await domain.appendComment(thread.id, { author: 'user', body: 'second' })
    const result = await domain.deleteComment({ threadId: thread.id, id: comment.id })
    assertEqual(result.threadDeleted, false, 'the thread survives its first comment')
    assertEqual(result.thread?.id, thread.id, 'the post-state thread is returned')
    assertIds(await store.listComments(thread.id), [reply.comment.id], 'the replies survive')
    const stored = await store.getThread(thread.id)
    assertEqual(stored?.updatedAt, thread.updatedAt, 'no thread write on a comment delete')
    assert(
      stored?.anchor !== undefined && stored?.capture !== undefined,
      'anchor and capture survive',
    )
  })

  /* ------------------------------------------------------------------------- rule 7 */

  test('rule 7 — deleting the last comment auto-deletes the thread', async ({ domain, store }) => {
    const { thread, comment } = await domain.createThread(makeCreateInput())
    const result = await domain.deleteComment({ threadId: thread.id, id: comment.id })
    assertEqual(result.threadDeleted, true, 'DeleteCommentResult.threadDeleted must be true')
    assertEqual(result.thread, null, 'DeleteCommentResult.thread must be null')
    assertEqual(await store.getThread(thread.id), null, 'an empty thread cannot exist')
    assertIds(await store.listComments(thread.id), [], 'the comment is gone')
  })

  /* ------------------------------------------------------------------------- rule 8 */

  test('rule 8 — delete(threadId) hard-deletes and cascades', async ({ domain, store }) => {
    const { thread } = await domain.createThread(makeCreateInput())
    await domain.appendComment(thread.id, { author: 'copilot', body: 'reply' })
    await domain.delete(thread.id)
    assertEqual(await store.getThread(thread.id), null, 'the thread must be gone')
    assertIds(await store.listComments(thread.id), [], 'its comments must be cascaded')
    assertEqual(await domain.get(thread.id), null, 'the record must be unreachable')
  })

  /* ------------------------------------------------------------------------- rule 9 */

  test('rule 9 — every write to a deleted thread rejects, never resurrects', async ({
    domain,
    store,
  }) => {
    const { thread, comment } = await domain.createThread(makeCreateInput())
    await domain.delete(thread.id)
    await assertRejects(
      () => domain.appendComment(thread.id, { author: 'user', body: 'ghost' }),
      'thread_not_found',
      'appendComment on a deleted thread',
    )
    await assertRejects(
      () => domain.resolve(thread.id),
      'thread_not_found',
      'resolve on a deleted thread',
    )
    await assertRejects(
      () => domain.reopen(thread.id),
      'thread_not_found',
      'reopen on a deleted thread',
    )
    await assertRejects(
      () => domain.delete(thread.id),
      'thread_not_found',
      'delete on a deleted thread',
    )
    await assertRejects(
      () => domain.editComment({ threadId: thread.id, id: comment.id }, 'ghost'),
      'comment_not_found',
      'editComment on a deleted thread',
    )
    assertIds(await store.listAllThreads(), [], 'no write path may re-create the thread')
  })

  /* ------------------------------------------------------------------------ rule 10 */

  test('rule 10 — resolving mid-run needs no coordination', async ({ domain }) => {
    const { thread } = await domain.createThread(makeCreateInput())
    const resolved = await domain.resolve(thread.id) // run still in flight
    const late = await domain.appendComment(thread.id, { author: 'copilot', body: 'late output' })
    assertEqual(late.reopened, false, 'the late machine reply lands under rule 4')
    assertEqual(late.thread.status, 'resolved', 'the resolution stands')
    assertEqual(late.thread.resolvedAt, resolved.resolvedAt, 'resolvedAt is not re-stamped')
  })

  /* ------------------------------------------------------------------------ rule 11 */

  test('rule 11 — resolvedBy is always user and re-resolving is a no-op', async ({
    domain,
    store,
  }) => {
    const { thread } = await domain.createThread(makeCreateInput())
    const first = await domain.resolve(thread.id)
    assertEqual(first.status, 'resolved', 'resolve must flip the status')
    assertEqual(first.resolvedBy, 'user', 'the copilot may suggest, never execute')
    assert(first.resolvedAt !== null, 'resolvedAt is stamped with the status')

    const again = await domain.resolve(thread.id)
    assertEqual(again.resolvedAt, first.resolvedAt, 'resolving a resolved thread must not re-stamp')
    assertEqual(again.updatedAt, first.updatedAt, 'a no-op resolve must not write')
    assertEqual((await store.getThread(thread.id))?.updatedAt, first.updatedAt, 'no store write')
  })

  /* ------------------------------------------------------------------------ rule 12 */

  test('rule 12 — reopen clears resolvedAt and resolvedBy together', async ({ domain }) => {
    const { thread } = await domain.createThread(makeCreateInput())
    await domain.resolve(thread.id)
    const reopened = await domain.reopen(thread.id)
    assertEqual(reopened.status, 'open', 'reopen must flip the status')
    assertEqual(reopened.resolvedAt, null, 'resolvedAt must be cleared')
    assertEqual(reopened.resolvedBy, null, 'resolvedBy must be cleared with it')

    const again = await domain.reopen(thread.id)
    assertEqual(again.updatedAt, reopened.updatedAt, 'reopening an open thread must be a no-op')
  })

  /* ------------------------------------------------------------------------ rule 13 */

  test('rule 13 — editComment stamps editedAt in place, with no thread write', async ({
    domain,
    store,
  }) => {
    const { thread, comment } = await domain.createThread(makeCreateInput({ body: 'before' }))
    const edited = await domain.editComment({ threadId: thread.id, id: comment.id }, 'after')
    assertEqual(edited.body, 'after', 'the body must be replaced in place')
    assert(edited.editedAt !== null, 'editedAt must be stamped')
    assertEqual(edited.id, comment.id, 'an edit is not a new record — no tombstones')
    assertEqual((await store.listComments(thread.id)).length, 1, 'an edit must not add a record')
    assertEqual((await store.getThread(thread.id))?.updatedAt, thread.updatedAt, 'no thread write')
    await assertRejects(
      () => domain.editComment({ threadId: thread.id, id: comment.id }, ' '),
      'empty_body',
      'editing to an empty body must reject',
    )
  })

  test('rule 13 — editComment accepts a bare comment id', async ({ domain }) => {
    const { comment } = await domain.createThread(makeCreateInput())
    const edited = await domain.editComment(comment.id, 'after')
    assertEqual(edited.body, 'after', 'the bare-id CommentRef form must resolve')
  })

  /* ------------------------------------------------------------------------ rule 15 */

  test('rule 15 — replaying a create with the same id is a deduped no-op', async ({
    domain,
    store,
  }) => {
    const first = await domain.createThread(
      makeCreateInput({ id: 't-fixed', commentId: 'c-fixed' }),
    )
    assertEqual(first.deduped, false, 'the first create actually writes')
    const replay = await domain.createThread(
      makeCreateInput({ id: 't-fixed', commentId: 'c-fixed', body: 'different' }),
    )
    assertEqual(replay.deduped, true, 'a replayed create must report deduped')
    assertEqual(
      replay.comment.body,
      first.comment.body,
      'the existing record is returned unchanged',
    )
    assertIds(await store.listAllThreads(), ['t-fixed'], 'a replay must not write a second thread')
    assertIds(
      await store.listComments('t-fixed'),
      ['c-fixed'],
      'a replay must not write a second comment',
    )
  })

  test('rule 15 — replaying an append with the same id is a deduped no-op', async ({
    domain,
    store,
  }) => {
    const { thread } = await domain.createThread(makeCreateInput())
    const first = await domain.appendComment(thread.id, {
      author: 'copilot',
      body: 'run output',
      id: 'r:run-1',
    })
    assertEqual(first.deduped, false, 'the first append actually writes')
    const replay = await domain.appendComment(thread.id, {
      author: 'copilot',
      body: 'run output (retry)',
      id: 'r:run-1',
    })
    assertEqual(replay.deduped, true, 'a restarted run must not double-post')
    assertEqual(replay.comment.body, 'run output', 'the existing comment is returned unchanged')
    assertEqual((await store.listComments(thread.id)).length, 2, 'no second comment was written')
  })

  test('rule 15 — a deduped user reply does not reopen a resolved thread', async ({ domain }) => {
    const { thread } = await domain.createThread(makeCreateInput())
    await domain.appendComment(thread.id, { author: 'user', body: 'reply', id: 'fixed' })
    const resolved = await domain.resolve(thread.id)
    const replay = await domain.appendComment(thread.id, {
      author: 'user',
      body: 'reply',
      id: 'fixed',
    })
    assertEqual(replay.deduped, true, 'the replay is a no-op')
    assertEqual(replay.reopened, false, 'a no-op write must not fire the auto-reopen rule')
    assertEqual(replay.thread.status, 'resolved', 'the thread must stay resolved')
    assertEqual(replay.thread.updatedAt, resolved.updatedAt, 'nothing was written')
  })

  /* ------------------------------------------------------------------------ rule 16 */

  test('rule 16 — an unknown record version is skipped, reported, and never rewritten', async ({
    domain,
    store,
    errors,
  }) => {
    const future = { ...makeThreadRecord('t-future'), v: 99 } as unknown as Thread
    await store.putThread(future)
    await store.putComment({
      id: 'c-future',
      threadId: 't-future',
      author: 'user',
      body: 'from the future',
      createdAt: '2026-01-01T00:00:00.000Z',
      editedAt: null,
    })

    assertIds(
      (await domain.list()).map((r) => r.thread),
      [],
      'an unknown version must be skipped from every list',
    )
    assertEqual(await domain.get('t-future'), null, 'an unknown version must be skipped from get')

    const stored = await store.getThread('t-future')
    assertEqual(stored?.v, 99, 'an unknown version must never be rewritten')

    assert(errors.length > 0, 'the fault must be reported through DomainOptions.onError')
    assert(
      errors.every((e) => CommentError.is(e, 'unsupported_version')),
      'the reported error must carry code unsupported_version',
    )
    assertEqual(errors[0]!.threadId, 't-future', 'the report must name the record')

    await domain.list()
    assertEqual(errors.length, 1, 'the fault is reported once per record per instance')
  })

  /* --------------------------------------------------------- reads (list / get scope) */

  test('list defaults to ALL pages for a headless domain', async ({ domain }) => {
    const a = await domain.createThread(makeCreateInput({ pageKey: 'https://a.example' }))
    const b = await domain.createThread(makeCreateInput({ pageKey: 'https://b.example' }))
    const ids = (await domain.list()).map((r) => r.thread.id)
    assert(ids.includes(a.thread.id) && ids.includes(b.thread.id), 'undefined pageKey = all pages')
    assertEqual((await domain.list({ pageKey: null })).length, 2, 'null pageKey = all pages')
    assertEqual((await domain.list({ pageKey: 'https://a.example' })).length, 1, 'a string scopes')
  })

  test('list filters by kind, status, author and since', async ({ domain }) => {
    const ask = await domain.createThread(makeCreateInput({ kind: 'ask' }))
    const commentThread = await domain.createThread(makeCreateInput({ kind: 'comment' }))
    await domain.appendComment(commentThread.thread.id, { author: 'copilot', body: 'machine' })
    await domain.resolve(ask.thread.id)

    assertEqual((await domain.list({ kind: 'ask' })).length, 1, 'kind filter')
    assertEqual((await domain.list({ kind: ['ask', 'comment'] })).length, 2, 'kind list filter')
    assertEqual((await domain.list({ status: 'resolved' })).length, 1, 'status filter')
    assertEqual((await domain.list({ author: 'copilot' })).length, 1, 'author filter')
    assertEqual(
      (await domain.list({ since: commentThread.thread.createdAt })).length,
      1,
      'since filter is inclusive on thread.createdAt',
    )
  })

  test('list sorts by thread.createdAt ascending and carries sorted comments', async ({
    domain,
  }) => {
    const first = await domain.createThread(makeCreateInput())
    const second = await domain.createThread(makeCreateInput())
    await domain.appendComment(first.thread.id, { author: 'user', body: 'b' })
    const records = await domain.list()
    assertIds(
      records.map((r) => r.thread),
      [first.thread.id, second.thread.id],
      'sorted by createdAt',
    )
    assertEqual(records[0]!.comments.length, 2, 'the record carries its comments')
    assert(
      records[0]!.comments[0]!.createdAt <= records[0]!.comments[1]!.createdAt,
      'comments are sorted by createdAt ascending',
    )
  })

  test('get returns null for an unknown thread', async ({ domain }) => {
    assertEqual(await domain.get('nope'), null, 'get must return null, not reject')
  })

  test('a thread that reads back with zero comments is skipped and GC-ed', async ({
    domain,
    store,
  }) => {
    // §4.3: the crash window between "comment deleted" and "thread deleted" is closed on read.
    await store.putThread(makeThreadRecord('t-empty'))
    assertIds(
      (await domain.list()).map((r) => r.thread),
      [],
      'an empty thread is never surfaced',
    )
    assertEqual(await store.getThread('t-empty'), null, 'the loader deletes it')
  })

  return cases
}
