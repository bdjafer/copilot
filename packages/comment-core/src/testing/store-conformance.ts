/**
 * `storeConformance` (§2.16) — the §2.7 adapter contract as executable cases: sorting, cascade
 * delete, subscribe fan-out, upsert, durability.
 *
 * Runner-agnostic (`{ name, run }[]`): `for (const c of storeConformance(f)) it(c.name, c.run)`
 * works in vitest, node:test and bun alike.
 *
 * DOM-free.
 */

import type { CommentStore, Thread } from '../types.ts'
import type { Awaitable, ConformanceCase } from './types.ts'

import { assert, assertDeepEqual, assertEqual, assertIds } from './assert.ts'
import { makeCommentRecord, makeThreadRecord } from './fixtures.ts'

const PAGE = 'https://example.com/doc'
const OTHER = 'https://example.com/other'

export function storeConformance(factory: () => Awaitable<CommentStore>): ConformanceCase[] {
  const cases: ConformanceCase[] = []
  const test = (name: string, run: (store: CommentStore) => Promise<void>): void => {
    cases.push({ name: `store: ${name}`, run: async () => run(await factory()) })
  }

  /* ------------------------------------------------------------------------- threads */

  test('putThread then getThread returns the record', async (store) => {
    const thread = makeThreadRecord('t1')
    await store.putThread(thread)
    const read = await store.getThread('t1')
    assert(read !== null, 'getThread returned null for a written thread')
    assertDeepEqual(read, thread, 'the record read back differs from the record written')
  })

  test('getThread returns null for an unknown id', async (store) => {
    assertEqual(await store.getThread('nope'), null, 'getThread must return null, not throw')
  })

  test('putThread is an upsert keyed by id', async (store) => {
    await store.putThread(makeThreadRecord('t1'))
    await store.putThread(makeThreadRecord('t1', { kind: 'ask' }))
    const all = await store.listAllThreads()
    assertEqual(all.length, 1, 'a second putThread with the same id must not add a record')
    assertEqual(all[0]!.kind, 'ask', 'the second putThread must replace the first')
  })

  test('putThread resolves only when the write is durable', async (store) => {
    await store.putThread(makeThreadRecord('t1'))
    assert(await store.getThread('t1'), 'the record must be readable as soon as putThread resolves')
  })

  test('listThreads returns only the requested pageKey', async (store) => {
    await store.putThread(makeThreadRecord('t1', { pageKey: PAGE }))
    await store.putThread(makeThreadRecord('t2', { pageKey: OTHER }))
    assertIds(await store.listThreads(PAGE), ['t1'], 'listThreads leaked another page')
    assertIds(await store.listThreads(OTHER), ['t2'], 'listThreads leaked another page')
  })

  test('listThreads returns [] for an unknown pageKey', async (store) => {
    assertIds(await store.listThreads('https://nope.example'), [], 'expected an empty list')
  })

  test('listThreads sorts by createdAt ascending', async (store) => {
    await store.putThread(makeThreadRecord('b', { createdAt: '2026-01-03T00:00:00.000Z' }))
    await store.putThread(makeThreadRecord('a', { createdAt: '2026-01-01T00:00:00.000Z' }))
    await store.putThread(makeThreadRecord('c', { createdAt: '2026-01-02T00:00:00.000Z' }))
    assertIds(
      await store.listThreads(PAGE),
      ['a', 'c', 'b'],
      'consumers never sort — the adapter must',
    )
  })

  test('listThreads breaks createdAt ties by id ascending', async (store) => {
    for (const id of ['c', 'a', 'b']) await store.putThread(makeThreadRecord(id))
    assertIds(await store.listThreads(PAGE), ['a', 'b', 'c'], 'ties must break by id ascending')
  })

  test('listAllThreads returns every page', async (store) => {
    await store.putThread(makeThreadRecord('t1', { pageKey: PAGE }))
    await store.putThread(makeThreadRecord('t2', { pageKey: OTHER }))
    assertIds(await store.listAllThreads(), ['t1', 't2'], 'listAllThreads must ignore pageKey')
  })

  test('listAllThreads sorts by createdAt ascending, ties by id', async (store) => {
    await store.putThread(makeThreadRecord('z', { createdAt: '2026-01-02T00:00:00.000Z' }))
    await store.putThread(makeThreadRecord('b', { pageKey: OTHER }))
    await store.putThread(makeThreadRecord('a'))
    assertIds(await store.listAllThreads(), ['a', 'b', 'z'], 'listAllThreads must be sorted')
  })

  test('putThread with a changed pageKey moves the record between page scopes', async (store) => {
    await store.putThread(makeThreadRecord('t1', { pageKey: PAGE }))
    await store.putThread(makeThreadRecord('t1', { pageKey: OTHER }))
    assertIds(await store.listThreads(PAGE), [], 'the record must leave its old page scope')
    assertIds(
      await store.listThreads(OTHER),
      ['t1'],
      'the record must appear in its new page scope',
    )
    assertIds(await store.listAllThreads(), ['t1'], 'moving a record must not duplicate it')
  })

  test('deleteThread removes the thread', async (store) => {
    await store.putThread(makeThreadRecord('t1'))
    await store.deleteThread('t1')
    assertEqual(await store.getThread('t1'), null, 'the thread must be gone')
    assertIds(await store.listAllThreads(), [], 'the thread must be gone from every list')
  })

  test('deleteThread cascades its comments', async (store) => {
    await store.putThread(makeThreadRecord('t1'))
    await store.putComment(makeCommentRecord('c1', 't1'))
    await store.putComment(makeCommentRecord('c2', 't1'))
    await store.deleteThread('t1')
    assertIds(await store.listComments('t1'), [], 'deleteThread must cascade its comments')
  })

  test('deleteThread on an unknown id resolves without throwing', async (store) => {
    await store.deleteThread('nope')
  })

  /* ------------------------------------------------------------------------ comments */

  test('putComment then listComments returns the comment', async (store) => {
    await store.putThread(makeThreadRecord('t1'))
    const comment = makeCommentRecord('c1', 't1')
    await store.putComment(comment)
    assertDeepEqual(
      await store.listComments('t1'),
      [comment],
      'the comment must read back verbatim',
    )
  })

  test('listComments returns [] for an unknown thread', async (store) => {
    assertIds(await store.listComments('nope'), [], 'expected an empty list, not a throw')
  })

  test('listComments sorts by createdAt ascending', async (store) => {
    await store.putComment(makeCommentRecord('b', 't1', { createdAt: '2026-01-03T00:00:00.000Z' }))
    await store.putComment(makeCommentRecord('a', 't1', { createdAt: '2026-01-01T00:00:00.000Z' }))
    await store.putComment(makeCommentRecord('c', 't1', { createdAt: '2026-01-02T00:00:00.000Z' }))
    assertIds(await store.listComments('t1'), ['a', 'c', 'b'], 'listComments must be sorted')
  })

  test('listComments breaks createdAt ties by id ascending', async (store) => {
    for (const id of ['c', 'a', 'b']) await store.putComment(makeCommentRecord(id, 't1'))
    assertIds(await store.listComments('t1'), ['a', 'b', 'c'], 'ties must break by id ascending')
  })

  test('putComment is an upsert keyed by id', async (store) => {
    await store.putComment(makeCommentRecord('c1', 't1'))
    await store.putComment(makeCommentRecord('c1', 't1', { body: 'edited' }))
    const comments = await store.listComments('t1')
    assertEqual(comments.length, 1, 'a second putComment with the same id must not add a record')
    assertEqual(comments[0]!.body, 'edited', 'the second putComment must replace the first')
  })

  test('putComment keeps comments of different threads apart', async (store) => {
    await store.putComment(makeCommentRecord('c1', 't1'))
    await store.putComment(makeCommentRecord('c2', 't2'))
    assertIds(await store.listComments('t1'), ['c1'], 'comments must be scoped to their thread')
    assertIds(await store.listComments('t2'), ['c2'], 'comments must be scoped to their thread')
  })

  test('deleteComment removes only that comment', async (store) => {
    await store.putComment(makeCommentRecord('c1', 't1'))
    await store.putComment(makeCommentRecord('c2', 't1'))
    await store.deleteComment('c1')
    assertIds(await store.listComments('t1'), ['c2'], 'deleteComment removed the wrong records')
  })

  test('deleteComment must not touch the thread record', async (store) => {
    const thread = makeThreadRecord('t1')
    await store.putThread(thread)
    await store.putComment(makeCommentRecord('c1', 't1'))
    await store.deleteComment('c1')
    assertDeepEqual(await store.getThread('t1'), thread, 'the thread record must be untouched')
  })

  test('deleteComment on an unknown id resolves without throwing', async (store) => {
    await store.deleteComment('nope')
  })

  test('optional getComment returns the record or null', async (store) => {
    if (!store.getComment) return // documented fallback: the domain scans instead
    const comment = makeCommentRecord('c1', 't1')
    await store.putComment(comment)
    assertDeepEqual(await store.getComment('c1'), comment, 'getComment must find a written comment')
    assertEqual(await store.getComment('nope'), null, 'getComment must return null when absent')
  })

  /* ---------------------------------------------------------------------- reactivity */

  const counted = async (store: CommentStore, write: () => Promise<void>): Promise<number> => {
    let calls = 0
    const off = store.subscribe(null, () => {
      calls++
    })
    await write()
    off()
    return calls
  }

  test('subscribe is notified for a local putThread', async (store) => {
    assert(
      (await counted(store, () => store.putThread(makeThreadRecord('t1')))) > 0,
      'a write must notify local subscribers in the writing context',
    )
  })

  test('subscribe is notified for a local putComment', async (store) => {
    assert(
      (await counted(store, () => store.putComment(makeCommentRecord('c1', 't1')))) > 0,
      'a comment write must notify local subscribers',
    )
  })

  test('subscribe is notified for a local deleteThread', async (store) => {
    await store.putThread(makeThreadRecord('t1'))
    assert(
      (await counted(store, () => store.deleteThread('t1'))) > 0,
      'a delete must notify local subscribers',
    )
  })

  test('subscribe is notified for a local deleteComment', async (store) => {
    await store.putComment(makeCommentRecord('c1', 't1'))
    assert(
      (await counted(store, () => store.deleteComment('c1'))) > 0,
      'a comment delete must notify local subscribers',
    )
  })

  test('subscribe fans out to every subscriber', async (store) => {
    let a = 0
    let b = 0
    const offA = store.subscribe(PAGE, () => {
      a++
    })
    const offB = store.subscribe(null, () => {
      b++
    })
    await store.putThread(makeThreadRecord('t1'))
    offA()
    offB()
    assert(a > 0 && b > 0, 'every subscriber must be notified (over-notify is legal)')
  })

  test('unsubscribe stops notifications', async (store) => {
    let calls = 0
    const off = store.subscribe(null, () => {
      calls++
    })
    off()
    await store.putThread(makeThreadRecord('t1'))
    assertEqual(calls, 0, 'the unsubscriber must actually detach the listener')
  })

  test('unsubscribe is idempotent', async (store) => {
    const off = store.subscribe(null, () => {})
    off()
    off()
  })

  test('subscribe(null) is notified for writes on any page', async (store) => {
    assert(
      (await counted(store, () => store.putThread(makeThreadRecord('t1', { pageKey: OTHER })))) > 0,
      'a null page scope must see every page',
    )
  })

  /* --------------------------------------------------------------------- optionals */

  test('optional transaction makes all of its writes visible', async (store) => {
    if (!store.transaction) return // §4.3 covers the adapters that have none
    await store.transaction(async (tx) => {
      await tx.putComment(makeCommentRecord('c1', 't1'))
      await tx.putThread(makeThreadRecord('t1'))
    })
    assert(await store.getThread('t1'), 'a transactional thread write must be visible')
    assertIds(
      await store.listComments('t1'),
      ['c1'],
      'a transactional comment write must be visible',
    )
  })

  test('optional name is a string when present', async (store) => {
    if (store.name === undefined) return
    assertEqual(typeof store.name, 'string', 'store.name must be a string when present')
  })

  test('a future-version record survives a read/write round trip', async (store) => {
    // §2.7 `StoredThread`: an adapter must be able to hand back a record this build does not
    // understand, so §4.1 rule 16 has something to skip.
    const future = { ...makeThreadRecord('t1'), v: 99 } as unknown as Thread
    await store.putThread(future)
    const read = await store.getThread('t1')
    assertEqual(read?.v, 99, 'the adapter must not coerce or drop an unknown record version')
  })

  return cases
}
