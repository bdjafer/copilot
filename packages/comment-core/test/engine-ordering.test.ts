/**
 * §4.2 event-ordering guarantees, one named test per numbered rule (§9 definition of done:
 * "Ordering rules §4.2.1–12 each have a named test").
 *
 * Rules 1, 3, 4, 5 and 7 also have headless coverage through `domainConformance`; here they
 * are asserted on the **engine's** bus, which is a different code path (local emission on top
 * of the domain result rather than a store diff).
 */

import { afterEach, describe, expect, test } from 'vitest'

import type { CommentEvent } from '../src/index.ts'

import { captureTarget, createMemoryStore } from '../src/index.ts'
import { createTestPage } from '../src/testing/test-page.ts'
import { harness, PAGE_URL } from './dom-helpers.ts'

const PAGE =
  '<article id="a" data-testid="a">alpha text</article><div id="b" data-testid="b">beta text</div>'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

async function scene(html = PAGE) {
  const h = await harness(html)
  cleanup.push(h.dispose)
  return h
}

describe('§4.2 ordering guarantees', () => {
  test('§4.2.1 persist-then-notify: a rejected store write emits no domain event and leaves the view untouched', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    h.events.length = 0

    // Break the store under the engine, then attempt a state transition.
    h.store.putThread = async () => {
      throw new Error('write failed')
    }
    await expect(h.engine.resolve(id)).rejects.toMatchObject({ code: 'store_failed' })
    expect(h.names().filter((n) => n.startsWith('thread:'))).toEqual([])
    expect(h.engine.getThreadView(id)!.status).toBe('open')
    // …and exactly one `error`, phase `'store'` — the other half of the same sentence.
    expect(h.typed('error')).toHaveLength(1)
    expect(h.typed('error')[0]!.payload.phase).toBe('store')
  })

  test('§4.2.2 view-before-listeners: getThreadView and threads.get() already reflect the event', async () => {
    const h = await scene()
    const seen: Array<{ status: string; count: number; inList: boolean }> = []
    h.engine.on('thread:create', ({ thread }) => {
      const view = h.engine.getThreadView(thread.id)!
      seen.push({
        status: view.status,
        count: view.comments.length,
        inList: h.engine.threads.get().some((v) => v.id === thread.id),
      })
    })
    const id = await h.seed('#a')

    h.engine.on('thread:reply', ({ thread }) => {
      const view = h.engine.getThreadView(thread.id)!
      seen.push({ status: view.status, count: view.comments.length, inList: true })
    })
    await h.engine.appendComment(id, { author: 'copilot', body: 'reply' })

    h.engine.on('thread:resolve', ({ thread }) => {
      seen.push({ status: h.engine.getThreadView(thread.id)!.status, count: 0, inList: true })
    })
    await h.engine.resolve(id)

    expect(seen).toEqual([
      { status: 'open', count: 1, inList: true },
      { status: 'open', count: 2, inList: true },
      { status: 'resolved', count: 0, inList: true },
    ])
  })

  test('§4.2.3 the first comment is thread:create, never thread:reply', async () => {
    const h = await scene()
    await h.seed('#a')
    expect(h.names()).toEqual(['thread:create'])
  })

  test('§4.2.4 state precedes content: thread:reopen(reply) then thread:reply, both post-transition', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    await h.engine.resolve(id)
    h.events.length = 0

    await h.engine.appendComment(id, { author: 'user', body: 'back please' })
    expect(h.names()).toEqual(['thread:reopen', 'thread:reply'])
    const [reopen, reply] = h.events as [CommentEvent, CommentEvent]
    expect(reopen.payload).toMatchObject({ reason: 'reply' })
    expect((reopen.payload as { thread: { status: string } }).thread.status).toBe('open')
    expect((reply.payload as { thread: { status: string } }).thread.status).toBe('open')
  })

  test('§4.2.4 a copilot reply to a resolved thread emits only thread:reply', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    await h.engine.resolve(id)
    h.events.length = 0
    await h.engine.appendComment(id, { author: 'copilot', body: 'suggestion' })
    expect(h.names()).toEqual(['thread:reply'])
  })

  test('§4.2.5 deletion order: comment:delete → thread:delete(empty) for the last comment', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    const view = h.engine.getThreadView(id)!
    h.events.length = 0

    await h.engine.deleteComment({ threadId: id, id: view.lastComment.id })
    expect(h.names()).toEqual(['comment:delete', 'thread:delete'])
    expect(h.typed('comment:delete')[0]!.payload).toMatchObject({
      threadDeleted: true,
      thread: null,
    })
    expect(h.typed('thread:delete')[0]!.payload.reason).toBe('empty')
  })

  test('§4.2.5 an explicit thread delete emits only thread:delete(explicit) with the full comment list', async () => {
    let t = Date.UTC(2026, 0, 1)
    const h = await harness(PAGE, { now: () => new Date((t += 1000)) })
    cleanup.push(h.dispose)
    const id = await h.seed('#a')
    await h.engine.appendComment(id, { author: 'copilot', body: 'two' })
    h.events.length = 0

    await h.engine.delete(id)
    expect(h.names()).toEqual(['thread:delete'])
    const payload = h.typed('thread:delete')[0]!.payload
    expect(payload.reason).toBe('explicit')
    expect(payload.comments.map((c) => c.body)).toEqual(['first', 'two'])
    expect(h.engine.getThreadView(id)).toBeNull()
  })

  test('§4.2.6 within a batch: all thread:orphaned first, then all thread:anchored', async () => {
    const h = await scene()
    await h.seed('#a')
    await h.seed('#b')
    h.events.length = 0

    // One mutation that orphans #a and re-parents #b (a fresh element, so it re-anchors).
    await h.page.mutate((doc) => {
      doc.querySelector('#a')!.remove()
      const b = doc.querySelector('#b')!
      const wrapper = doc.createElement('section')
      b.replaceWith(wrapper)
      wrapper.appendChild(b)
    })

    const anchorNames = h.names().filter((n) => n === 'thread:orphaned' || n === 'thread:anchored')
    expect(anchorNames[0]).toBe('thread:orphaned')
    expect(anchorNames.lastIndexOf('thread:orphaned')).toBeLessThan(
      anchorNames.indexOf('thread:anchored') === -1
        ? Infinity
        : anchorNames.indexOf('thread:anchored'),
    )
  })

  test('§4.2.6 transitions only: an unrelated mutation emits no anchoring event', async () => {
    const h = await scene()
    await h.seed('#a')
    h.events.length = 0
    await h.page.mutate((doc) => {
      doc.body.appendChild(doc.createElement('hr'))
    })
    expect(h.names().filter((n) => n.startsWith('thread:'))).toEqual([])
  })

  test('§4.2.6 a cold load never flashes orphans: exactly one thread:orphaned, and only after the first full pass', async () => {
    const first = await scene()
    await first.seed('#a')
    const snapshot = first.store.snapshot()
    await first.dispose()
    cleanup.length = 0

    // The harness zeroes its buffer after `ready()`, which would make any assertion about the
    // cold load vacuous — it cannot see the window this rule is about. Subscribe BEFORE the
    // first pass instead, by starting the engine by hand.
    const page = createTestPage('<div id="other">nothing here</div>', { url: PAGE_URL })
    const engine = page.engine({ store: createMemoryStore(snapshot), autoStart: false })
    const seen: Array<{ type: string; status: string }> = []
    engine.subscribe((event) =>
      seen.push({ type: event.type, status: engine.threads.get()[0]?.anchoring.status ?? 'none' }),
    )
    engine.start()
    await engine.ready()
    await page.flush()

    expect(seen.filter((e) => e.type === 'thread:orphaned')).toHaveLength(1)
    // No `thread:anchored` ever claimed it, and the view settled on `orphaned`.
    expect(seen.filter((e) => e.type === 'thread:anchored')).toHaveLength(0)
    expect(engine.threads.get()[0]!.anchoring.status).toBe('orphaned')
    await page.dispose()
  })

  test('§4.2.7 synchronous, snapshot-ordered emission with a monotonic seq from 1', async () => {
    const h = await scene()
    const order: string[] = []
    h.engine.on('thread:create', () => order.push('a'))
    h.engine.on('thread:create', () => {
      order.push('b')
      // Subscribing during emission takes effect on the NEXT emission.
      h.engine.on('thread:create', () => order.push('late'))
    })
    h.engine.on('thread:create', () => order.push('c'))
    await h.seed('#a')
    expect(order).toEqual(['a', 'b', 'c'])
    expect(h.events[0]!.seq).toBe(1)

    order.length = 0
    await h.seed('#b')
    expect(order).toEqual(['a', 'b', 'c', 'late'])
    expect(h.events[1]!.seq).toBe(2)
  })

  test('§4.2.7 the `*` firehose receives each event AFTER its typed listeners', async () => {
    const h = await scene()
    const order: string[] = []
    h.engine.on('thread:create', () => order.push('typed'))
    h.engine.subscribe((event) => {
      if (event.type === 'thread:create') order.push('firehose')
    })
    await h.seed('#a')
    expect(order).toEqual(['typed', 'firehose'])
  })

  test('§4.2.8 a remote write is re-emitted with source: remote', async () => {
    const h = await scene()
    // Another tab writes through its own domain over the same store.
    const target = h.page.document.querySelector('#a')!
    const { anchor, capture } = captureTarget(target, { document: h.page.document })
    await h.store.putComment({
      id: 'remote-c',
      threadId: 'remote-t',
      author: 'user',
      body: 'from another tab',
      createdAt: '2026-01-01T00:00:00.000Z',
      editedAt: null,
    })
    await h.store.putThread({
      id: 'remote-t',
      v: 1,
      pageKey: h.engine.pageKey,
      kind: 'comment',
      anchor,
      capture,
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await h.flush()

    const created = h.typed('thread:create')
    expect(created).toHaveLength(1)
    expect(created[0]!.payload.source).toBe('remote')
    expect(h.engine.getThreadView('remote-t')).not.toBeNull()
  })

  test('§4.2.8 a local write is NOT re-emitted as a remote echo (origin token, never a timestamp)', async () => {
    // A frozen clock is the exact case wall-clock dedupe gets wrong: every write shares one ms.
    const h = await harness(PAGE, { now: () => new Date(0) })
    cleanup.push(h.dispose)
    const id = await h.seed('#a')
    await h.engine.appendComment(id, { author: 'copilot', body: 'two' })
    await h.engine.resolve(id)
    await h.flush()

    expect(h.names()).toEqual(['thread:create', 'thread:reply', 'thread:resolve'])
    expect(
      h.events.every((event) => (event.payload as { source?: string }).source === 'local'),
    ).toBe(true)
  })

  test('§4.2.8 two same-millisecond local writes do not swallow a genuine remote change', async () => {
    const h = await harness(PAGE, { now: () => new Date(0) })
    cleanup.push(h.dispose)
    const id = await h.seed('#a')
    h.events.length = 0

    // Local reply + a remote reply from "another tab", both stamped at the same instant.
    await h.engine.appendComment(id, { author: 'copilot', body: 'local reply' })
    await h.store.putComment({
      id: 'remote-reply',
      threadId: id,
      author: 'user',
      body: 'remote reply',
      createdAt: new Date(0).toISOString(),
      editedAt: null,
    })
    await h.flush()

    const replies = h.typed('thread:reply')
    expect(replies.map((event) => event.payload.comment.body).sort()).toEqual([
      'local reply',
      'remote reply',
    ])
    expect(replies.find((e) => e.payload.comment.id === 'remote-reply')!.payload.source).toBe(
      'remote',
    )
  })

  test('§4.2.9 placement:end(placed) fires AFTER the thread:create for that submission', async () => {
    const h = await scene()
    const target = h.page.document.querySelector('#a')!
    expect(h.engine.placement.start('comment', { element: target })).toBe(true)
    const result = await h.engine.placement.submit('placed body')

    expect(h.names()).toEqual(['placement:start', 'thread:create', 'placement:end'])
    expect(h.typed('placement:end')[0]!.payload).toEqual({
      kind: 'comment',
      reason: 'placed',
      threadId: result.thread.id,
    })
  })

  test('§4.2.9 placement:end(cancelled) carries threadId: null', async () => {
    const h = await scene()
    h.engine.placement.start('comment', { element: h.page.document.querySelector('#a')! })
    h.engine.placement.cancel('user')
    expect(h.typed('placement:end')[0]!.payload).toEqual({
      kind: 'comment',
      reason: 'cancelled',
      threadId: null,
    })
  })

  test('§4.2.10 page:change is emitted after the unload+load, and thread:anchored follows it', async () => {
    const store = createMemoryStore()
    const h = await harness(PAGE, { store })
    cleanup.push(h.dispose)
    await h.seed('#a')
    h.events.length = 0

    await h.page.navigate('https://example.com/other')
    const names = h.names()
    expect(names).toContain('page:change')
    expect(h.typed('page:change')[0]!.payload).toMatchObject({
      pageKey: 'https://example.com/other',
      previous: 'https://example.com/doc',
    })
    // The old page's threads were unloaded.
    expect(h.engine.threads.get()).toEqual([])

    // Coming back re-loads them, and the anchoring event follows page:change.
    h.events.length = 0
    await h.page.navigate('https://example.com/doc')
    const back = h.names()
    expect(back.indexOf('page:change')).toBeLessThan(back.indexOf('thread:anchored'))
  })

  test('§4.2.11 destroy() stops the bus permanently — no event after it', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    h.engine.destroy()
    h.events.length = 0
    await h.page.mutate((doc) => doc.querySelector('#a')!.remove())
    expect(h.events).toEqual([])
    expect(h.engine.getThreadView(id)).toBeNull()
  })

  test('§4.2.12 every StoreEventMap event is structurally cloneable as emitted', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    await h.engine.appendComment(id, { author: 'copilot', body: 'two' })
    await h.engine.resolve(id)
    await h.engine.reopen(id)
    const view = h.engine.getThreadView(id)!
    await h.engine.editComment({ threadId: id, id: view.lastComment.id }, 'edited')
    await h.engine.deleteComment({ threadId: id, id: view.lastComment.id })
    await h.engine.delete(id)

    const storeEvents = h.events.filter((event) => !event.type.startsWith('placement:'))
    expect(storeEvents.map((e) => e.type)).toEqual([
      'thread:create',
      'thread:reply',
      'thread:resolve',
      'thread:reopen',
      'comment:edit',
      'comment:delete',
      'thread:delete',
    ])
    for (const event of storeEvents) expect(() => structuredClone(event)).not.toThrow()
  })

  test('§4.2.12 engine-only events carry live DOM values, and the documented projection clones', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    h.events.length = 0
    h.engine.focus(id)
    const click = h.typed('thread:click')[0]!

    // `view` and `element` are live references, not data — a relay must project them.
    expect(click.payload.view).toBe(h.engine.getThreadView(id))
    expect(click.payload.element).toBe(h.page.document.querySelector('#a'))

    expect(() =>
      structuredClone({
        type: click.type,
        seq: click.seq,
        at: click.at,
        payload: { thread: click.payload.thread, view: id, element: id },
      }),
    ).not.toThrow()
  })

  test('§4.2.12 a CommentError loses its own properties through structuredClone, so `error` must be projected', async () => {
    const h = await scene()
    h.engine.startPlacement('nope')
    const error = h.typed('error')[0]!.payload.error
    expect(error.code).toBe('unknown_kind')
    expect((structuredClone(error) as { code?: string }).code).toBeUndefined()
    // The documented projection survives.
    const projected = structuredClone({
      name: error.name,
      code: error.code,
      message: error.message,
      threadId: error.threadId,
      commentId: error.commentId,
    })
    expect(projected.code).toBe('unknown_kind')
  })
})
