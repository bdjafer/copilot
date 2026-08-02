/** §2.10 store-level observation: cold-start correctness, coalescing, at-least-once delivery. */

import { describe, expect, test } from 'vitest'

import {
  createDomain,
  createKeyValueCursor,
  createKeyValueStore,
  createMemoryStore,
  observeStore,
  type CommentDomain,
  type CommentStore,
  type ObserveOptions,
  type StoreEvent,
} from '../src/headless.ts'
import { countingIds, makeCreateInput, tickingClock } from '../src/testing/index.ts'
import { createMemoryKv, flush, withTransaction } from './helpers.ts'

interface Rig {
  store: CommentStore
  domain: CommentDomain
  events: StoreEvent[]
  types: () => string[]
  stop: () => void
}

function rig(options?: ObserveOptions, store: CommentStore = createMemoryStore()): Rig {
  const domain = createDomain(store, { now: tickingClock(), createId: countingIds() })
  const events: StoreEvent[] = []
  const stop = observeStore(store, (event) => void events.push(event), options)
  return { store, domain, events, types: () => events.map((e) => e.type), stop }
}

describe('observeStore cold start (§2.10)', () => {
  test('with an empty cursor and replay:false, the first pass emits nothing', async () => {
    const store = createMemoryStore()
    const domain = createDomain(store, { now: tickingClock(), createId: countingIds() })
    await domain.createThread(makeCreateInput())

    const r = rig(undefined, store)
    await flush()
    expect(r.events).toEqual([])
    r.stop()
  })

  test('with replay:true it emits thread:create for records that already existed', async () => {
    const store = createMemoryStore()
    const domain = createDomain(store, { now: tickingClock(), createId: countingIds() })
    await domain.createThread(makeCreateInput())
    await domain.appendComment('id-1', { author: 'copilot', body: 'reply' })

    const r = rig({ replay: true }, store)
    await flush()
    expect(r.types()).toEqual(['thread:create', 'thread:reply'])
    r.stop()
  })

  test('every emitted event is a remote echo — origin is unknowable from a store diff', async () => {
    const r = rig()
    await flush()
    await r.domain.createThread(makeCreateInput())
    await flush()
    expect(r.events.every((e) => e.payload.source === 'remote')).toBe(true)
    r.stop()
  })

  test('seq is monotonic from 1 and `at` is a wall clock', async () => {
    const r = rig()
    await flush()
    await r.domain.createThread(makeCreateInput())
    await r.domain.appendComment('id-1', { author: 'user', body: 'b' })
    await flush()
    expect(r.events.map((e) => e.seq)).toEqual([1, 2])
    expect(typeof r.events[0]!.at).toBe('number')
    r.stop()
  })
})

describe('observeStore diff (§2.10, §4.2)', () => {
  test('§4.2.3 — a first comment is thread:create, never thread:reply', async () => {
    const r = rig()
    await flush()
    await r.domain.createThread(makeCreateInput())
    await flush()
    expect(r.types()).toEqual(['thread:create'])
    expect(r.events[0]!.payload).toMatchObject({ comment: { body: 'first' } })
    r.stop()
  })

  test('one thread:reply per new comment, in createdAt order', async () => {
    const r = rig()
    await flush()
    const { thread } = await r.domain.createThread(makeCreateInput())
    await flush()
    r.events.length = 0
    await r.store.putComment({
      id: 'c-b',
      threadId: thread.id,
      author: 'user',
      body: 'b',
      createdAt: '2030-01-02T00:00:00.000Z',
      editedAt: null,
    })
    await r.store.putComment({
      id: 'c-a',
      threadId: thread.id,
      author: 'copilot',
      body: 'a',
      createdAt: '2030-01-01T00:00:00.000Z',
      editedAt: null,
    })
    await flush()
    expect(r.types()).toEqual(['thread:reply', 'thread:reply'])
    expect(r.events.map((e) => (e.payload as { comment: { id: string } }).comment.id)).toEqual([
      'c-a',
      'c-b',
    ])
    r.stop()
  })

  test('explicit resolve and reopen emit thread:resolve / thread:reopen(explicit)', async () => {
    const r = rig()
    await flush()
    const { thread } = await r.domain.createThread(makeCreateInput())
    await flush()
    r.events.length = 0
    await r.domain.resolve(thread.id)
    await flush()
    await r.domain.reopen(thread.id)
    await flush()
    expect(r.types()).toEqual(['thread:resolve', 'thread:reopen'])
    expect(r.events[1]!.payload).toMatchObject({ reason: 'explicit' })
    r.stop()
  })

  test('§4.2.4 — an auto-reopening reply emits thread:reopen(reply) then thread:reply', async () => {
    const r = rig()
    await flush()
    const { thread } = await r.domain.createThread(makeCreateInput())
    await r.domain.resolve(thread.id)
    await flush()
    r.events.length = 0

    await r.domain.appendComment(thread.id, { author: 'user', body: 'not done' })
    await flush()
    expect(r.types()).toEqual(['thread:reopen', 'thread:reply'])
    expect(r.events[0]!.payload).toMatchObject({ reason: 'reply' })
    // Both payloads carry the post-transition thread: a content-only listener never sees a
    // stale status.
    for (const event of r.events) {
      expect((event.payload as { thread: { status: string } }).thread.status).toBe('open')
    }
    r.stop()
  })

  test('a copilot reply to a resolved thread emits only thread:reply', async () => {
    const r = rig()
    await flush()
    const { thread } = await r.domain.createThread(makeCreateInput())
    await r.domain.resolve(thread.id)
    await flush()
    r.events.length = 0
    await r.domain.appendComment(thread.id, { author: 'copilot', body: 'late' })
    await flush()
    expect(r.types()).toEqual(['thread:reply'])
    r.stop()
  })

  test('an edit emits comment:edit carrying the previous body', async () => {
    const r = rig()
    await flush()
    const { thread, comment } = await r.domain.createThread(makeCreateInput({ body: 'before' }))
    await flush()
    r.events.length = 0
    await r.domain.editComment({ threadId: thread.id, id: comment.id }, 'after')
    await flush()
    expect(r.types()).toEqual(['comment:edit'])
    expect(r.events[0]!.payload).toMatchObject({
      previousBody: 'before',
      comment: { body: 'after' },
    })
    r.stop()
  })

  test('deleting a non-last comment emits comment:delete with threadDeleted false', async () => {
    const r = rig()
    await flush()
    const { thread, comment } = await r.domain.createThread(makeCreateInput())
    await r.domain.appendComment(thread.id, { author: 'user', body: 'second' })
    await flush()
    r.events.length = 0
    await r.domain.deleteComment({ threadId: thread.id, id: comment.id })
    await flush()
    expect(r.types()).toEqual(['comment:delete'])
    expect(r.events[0]!.payload).toMatchObject({ threadDeleted: false })
    r.stop()
  })

  test('§4.2.5 — an observed empty thread emits comment:delete then thread:delete(empty)', async () => {
    // The durable intermediate state of the rule-7 auto-GC: the comment is gone, the thread
    // record is not (yet). This is also exactly what a crash inside §4.3's ordered pair leaves
    // behind, and it is the only shape in which a store diff can tell rule 7 from rule 8.
    const r = rig()
    await flush()
    const { thread, comment } = await r.domain.createThread(makeCreateInput())
    await flush()
    r.events.length = 0

    await r.store.deleteComment(comment.id) // thread record deliberately left in place
    await flush()
    expect(r.types()).toEqual(['comment:delete', 'thread:delete'])
    expect(r.events[0]!.payload).toMatchObject({ threadDeleted: true, thread: null })
    expect(r.events[1]!.payload).toMatchObject({ reason: 'empty' })

    await r.store.deleteThread(thread.id) // the GC completes: nothing new to report
    await flush()
    expect(r.types()).toEqual(['comment:delete', 'thread:delete'])
    r.stop()
  })

  test('a coalesced last-comment GC reports one thread:delete (documented limit)', async () => {
    // When both writes land in one diff pass — the normal case — the auto-GC and an explicit
    // delete are indistinguishable through the store, so the pair is reported as rule 8's
    // shape. Consumers key off `thread:delete` itself, never off `reason`.
    const r = rig()
    await flush()
    const { thread, comment } = await r.domain.createThread(makeCreateInput())
    await flush()
    r.events.length = 0
    await r.domain.deleteComment({ threadId: thread.id, id: comment.id })
    await flush()
    expect(r.types()).toEqual(['thread:delete'])
    expect(r.events[0]!.payload).toMatchObject({ reason: 'explicit' })
    expect((r.events[0]!.payload as unknown as { comments: unknown[] }).comments).toHaveLength(1)
    r.stop()
  })

  test('an explicit thread delete emits only thread:delete, carrying the comment list', async () => {
    const r = rig()
    await flush()
    const { thread } = await r.domain.createThread(makeCreateInput())
    await r.domain.appendComment(thread.id, { author: 'copilot', body: 'second' })
    await flush()
    r.events.length = 0
    await r.domain.delete(thread.id)
    await flush()
    expect(r.types()).toEqual(['thread:delete'])
    expect(r.events[0]!.payload).toMatchObject({ reason: 'explicit' })
    expect((r.events[0]!.payload as unknown as { comments: unknown[] }).comments).toHaveLength(2)
    r.stop()
  })

  test('a transactional last-comment GC also emits exactly one thread:delete', async () => {
    const r = rig(undefined, withTransaction(createMemoryStore()))
    await flush()
    const { thread, comment } = await r.domain.createThread(makeCreateInput())
    await flush()
    r.events.length = 0
    await r.domain.deleteComment({ threadId: thread.id, id: comment.id })
    await flush()
    expect(r.types().filter((t) => t === 'thread:delete')).toHaveLength(1)
    r.stop()
  })

  test('an unknown record version is never surfaced', async () => {
    const r = rig({ replay: true })
    await r.store.putThread({
      id: 't-future',
      v: 9,
      pageKey: 'p',
      kind: 'comment',
      anchor: {
        mode: 'element',
        selectors: [],
        fingerprint: { tag: 'div', stableClasses: [], attrs: {}, textDigest: '' },
      },
      capture: {
        outerHTML: '',
        text: '',
        cssPath: '',
        page: { url: '', title: '' },
        capturedAt: '',
      },
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
      createdAt: '2030-01-01T00:00:00.000Z',
      updatedAt: '2030-01-01T00:00:00.000Z',
    } as never)
    await flush()
    expect(r.events).toEqual([])
    r.stop()
  })

  test('pageKey scopes the diff', async () => {
    const store = createMemoryStore()
    const domain = createDomain(store, { now: tickingClock(), createId: countingIds() })
    const r = rig({ pageKey: 'https://a.test' }, store)
    await flush()
    await domain.createThread(makeCreateInput({ pageKey: 'https://b.test' }))
    await flush()
    expect(r.events).toEqual([])
    await domain.createThread(makeCreateInput({ pageKey: 'https://a.test' }))
    await flush()
    expect(r.types()).toEqual(['thread:create'])
    r.stop()
  })

  test('unsubscribing stops delivery and is idempotent', async () => {
    const r = rig()
    await flush()
    r.stop()
    r.stop()
    await r.domain.createThread(makeCreateInput())
    await flush()
    expect(r.events).toEqual([])
  })

  test('§4.2.12 — every emitted event is structurally cloneable as emitted', async () => {
    const r = rig()
    await flush()
    const { thread, comment } = await r.domain.createThread(makeCreateInput())
    await r.domain.editComment({ threadId: thread.id, id: comment.id }, 'edited')
    await r.domain.resolve(thread.id)
    await r.domain.delete(thread.id)
    await flush()
    expect(r.events.length).toBeGreaterThan(2)
    for (const event of r.events) expect(structuredClone(event)).toEqual(event)
    r.stop()
  })
})

describe('observeStore durable cursor (§2.10, DoD)', () => {
  test('a write made while the consumer was down is delivered exactly once on revival', async () => {
    const kv = createMemoryKv()
    const store = createKeyValueStore(kv, { namespace: 'exp-spec' })
    const domain = createDomain(store, { now: tickingClock(), createId: countingIds() })
    const cursor = () => createKeyValueCursor(kv, { namespace: 'exp-spec:host', id: 'dispatch' })

    const first: StoreEvent[] = []
    const stopFirst = observeStore(store, (e) => void first.push(e), { cursor: cursor() })
    await flush()
    await domain.createThread(makeCreateInput({ body: 'seen while alive' }))
    await flush()
    expect(first.map((e) => e.type)).toEqual(['thread:create'])

    // The worker dies. The write below happens with nobody watching.
    stopFirst()
    await domain.appendComment('id-1', { author: 'user', body: 'written while down' })
    await flush()

    const second: StoreEvent[] = []
    const stopSecond = observeStore(store, (e) => void second.push(e), { cursor: cursor() })
    await flush()
    expect(second.map((e) => e.type)).toEqual(['thread:reply'])
    expect((second[0]!.payload as { comment: { body: string } }).comment.body).toBe(
      'written while down',
    )

    // …and exactly once: a further notification re-diffs but re-delivers nothing.
    await domain.resolve('id-1')
    await flush()
    expect(second.map((e) => e.type)).toEqual(['thread:reply', 'thread:resolve'])
    stopSecond()
  })

  test('the cursor is persisted under {ns}:cursor:{id}', async () => {
    const kv = createMemoryKv()
    const store = createKeyValueStore(kv, { namespace: 'ns' })
    const stop = observeStore(store, () => {}, {
      cursor: createKeyValueCursor(kv, { namespace: 'ns:host', id: 'dispatch' }),
    })
    await flush()
    expect(kv.data.has('ns:host:cursor:dispatch')).toBe(true)
    expect(kv.data.get('ns:host:cursor:dispatch')).toMatchObject({ lastSeenAt: expect.any(String) })
    stop()
  })

  test('a listener that rejects does not advance the cursor — at-least-once redelivery', async () => {
    const store = createMemoryStore()
    const domain = createDomain(store, { now: tickingClock(), createId: countingIds() })
    const delivered: string[] = []
    let failNext = true
    const stop = observeStore(store, async (event) => {
      if (failNext) {
        failNext = false
        throw new Error('dispatch failed')
      }
      delivered.push(`${event.type}:${event.seq}`)
    })
    await flush()

    await domain.createThread(makeCreateInput())
    await flush()
    expect(delivered).toEqual([]) // the first delivery threw

    // The next notification re-delivers the event that was never acknowledged.
    await domain.createThread(makeCreateInput())
    await flush()
    expect(delivered.filter((d) => d.startsWith('thread:create'))).toHaveLength(2)
    stop()
  })

  test('a synchronous listener throw is contained the same way', async () => {
    const store = createMemoryStore()
    const domain = createDomain(store, { now: tickingClock(), createId: countingIds() })
    let calls = 0
    const stop = observeStore(store, () => {
      calls++
      if (calls === 1) throw new Error('boom')
    })
    await flush()
    await domain.createThread(makeCreateInput())
    await flush()
    await domain.appendComment('id-1', { author: 'user', body: 'b' })
    await flush()
    expect(calls).toBeGreaterThan(1) // redelivered rather than lost
    stop()
  })
})
