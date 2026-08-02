/**
 * §2.3 `ThreadView` + the identity guarantee, and §2.11's synchronous reads
 * (`listThreads` / `getThreadView` / `threads`), including the §2.9 default-scope rule.
 */

import { afterEach, describe, expect, test } from 'vitest'

import { harness } from './dom-helpers.ts'

const PAGE =
  '<article id="a" data-testid="a">alpha text</article><div id="b" data-testid="b">beta text</div>'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

async function scene(options?: Parameters<typeof harness>[1]) {
  let t = Date.UTC(2026, 0, 1)
  const h = await harness(PAGE, { now: () => new Date((t += 1000)), ...options })
  cleanup.push(h.dispose)
  return h
}

describe('§2.3 ThreadView shape', () => {
  test('it is a structural superset of Thread with comments, anchoring and the derived flags', async () => {
    const h = await scene()
    const id = await h.seed('#a', 'the body')
    const view = h.engine.getThreadView(id)!

    expect(view.id).toBe(id)
    expect(view.v).toBe(1)
    expect(view.kind).toBe('comment')
    expect(view.comments.map((c) => c.body)).toEqual(['the body'])
    expect(view.isResolved).toBe(false)
    expect(view.isOrphaned).toBe(false)
    expect(view.lastComment.body).toBe('the body')
    expect(view.anchoring.status).toBe('anchored')
  })

  test('lastComment is the newest comment and is never null', async () => {
    const h = await scene()
    const id = await h.seed('#a', 'one')
    await h.engine.appendComment(id, { author: 'copilot', body: 'two' })
    await h.engine.appendComment(id, { author: 'user', body: 'three' })
    expect(h.engine.getThreadView(id)!.lastComment.body).toBe('three')
  })

  test('lastActivityAt is max(createdAt, editedAt) over the comments — thread.updatedAt does not move', async () => {
    const h = await scene()
    const id = await h.seed('#a', 'one')
    const before = h.engine.getThreadView(id)!
    await h.engine.appendComment(id, { author: 'copilot', body: 'two' })
    const afterReply = h.engine.getThreadView(id)!
    expect(afterReply.updatedAt).toBe(before.updatedAt) // §2.7 rule 7: no thread write
    expect(afterReply.lastActivityAt).toBe(afterReply.comments[1]!.createdAt)

    await h.engine.editComment({ threadId: id, id: afterReply.comments[0]!.id }, 'one, edited')
    const afterEdit = h.engine.getThreadView(id)!
    expect(afterEdit.lastActivityAt).toBe(afterEdit.comments[0]!.editedAt)
    expect(afterEdit.updatedAt).toBe(before.updatedAt)
  })

  test('isResolved mirrors status, and resolve/reopen clear the fields together', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    await h.engine.resolve(id)
    let view = h.engine.getThreadView(id)!
    expect(view.isResolved).toBe(true)
    expect(view.resolvedBy).toBe('user')
    expect(view.resolvedAt).not.toBeNull()

    await h.engine.reopen(id)
    view = h.engine.getThreadView(id)!
    expect(view.isResolved).toBe(false)
    expect(view.resolvedAt).toBeNull()
    expect(view.resolvedBy).toBeNull()
  })
})

describe('§2.3 identity guarantee', () => {
  test('every view and the array are frozen', async () => {
    const h = await scene()
    await h.seed('#a')
    const list = h.engine.threads.get()
    expect(Object.isFrozen(list)).toBe(true)
    expect(Object.isFrozen(list[0])).toBe(true)
    expect(Object.isFrozen(list[0]!.comments)).toBe(true)
  })

  test('a view is referentially stable until its record, comments or anchoring change', async () => {
    const h = await scene()
    const a = await h.seed('#a')
    const b = await h.seed('#b')
    const first = h.engine.getThreadView(a)!
    const listBefore = h.engine.threads.get()

    // An unrelated mutation must not churn any identity.
    await h.page.mutate((doc) => doc.body.append(doc.createElement('hr')))
    expect(h.engine.getThreadView(a)).toBe(first)
    expect(h.engine.threads.get()).toBe(listBefore)

    // A reply to `b` gives a NEW view for b and the SAME view for a.
    await h.engine.appendComment(b, { author: 'user', body: 'second' })
    expect(h.engine.getThreadView(a)).toBe(first)
    expect(h.engine.getThreadView(b)).not.toBe(listBefore[1])
    expect(h.engine.threads.get()).not.toBe(listBefore)

    // An anchoring change gives a new view too.
    const beforeOrphan = h.engine.getThreadView(a)!
    await h.page.mutate((doc) => doc.querySelector('#a')!.remove())
    expect(h.engine.getThreadView(a)).not.toBe(beforeOrphan)
  })

  test('threads.subscribe fires only when the array actually changed', async () => {
    const h = await scene()
    let notifications = 0
    h.engine.threads.subscribe(() => notifications++)
    await h.seed('#a')
    expect(notifications).toBe(1)
    await h.page.mutate((doc) => doc.body.append(doc.createElement('hr')))
    expect(notifications).toBe(1)
  })
})

describe('§2.11 synchronous reads', () => {
  test('listThreads defaults to the current page and is sorted by createdAt ascending', async () => {
    const h = await scene()
    const a = await h.seed('#a')
    const b = await h.seed('#b')
    expect(h.engine.listThreads().map((v) => v.id)).toEqual([a, b])
  })

  test('EngineThreadFilter filters on kind, status, author, since and anchor', async () => {
    const h = await scene()
    const a = await h.seed('#a', 'first', { kind: 'comment' })
    const b = await h.seed('#b', 'first', { kind: 'ask' })
    await h.engine.appendComment(b, { author: 'copilot', body: 'machine' })
    await h.engine.resolve(a)

    expect(h.engine.listThreads({ kind: 'ask' }).map((v) => v.id)).toEqual([b])
    expect(h.engine.listThreads({ kind: ['ask', 'comment'] })).toHaveLength(2)
    expect(h.engine.listThreads({ status: 'resolved' }).map((v) => v.id)).toEqual([a])
    expect(h.engine.listThreads({ author: 'copilot' }).map((v) => v.id)).toEqual([b])
    expect(h.engine.listThreads({ since: h.engine.getThreadView(b)!.createdAt })).toHaveLength(1)

    await h.page.mutate((doc) => doc.querySelector('#a')!.remove())
    expect(h.engine.listThreads({ anchor: 'orphaned' }).map((v) => v.id)).toEqual([a])
    expect(h.engine.listThreads({ anchor: 'anchored' }).map((v) => v.id)).toEqual([b])
  })

  test('listThreads never hits the store', async () => {
    const h = await scene()
    await h.seed('#a')
    const reads = h.store.reads
    h.engine.listThreads()
    h.engine.getThreadView('nope')
    expect(h.store.reads).toBe(reads)
  })

  test('§2.9 the async list() defaults to the engine’s CURRENT pageKey; pageKey: null is all pages', async () => {
    const h = await scene()
    await h.seed('#a')
    // A thread that belongs to another page, written straight through the domain surface.
    const view = h.engine.getThreadView(h.engine.listThreads()[0]!.id)!
    await h.engine.createThread({
      pageKey: 'https://example.com/elsewhere',
      kind: 'comment',
      anchor: view.anchor,
      capture: view.capture,
      author: 'user',
      body: 'other page',
    })

    expect((await h.engine.list()).map((r) => r.thread.pageKey)).toEqual([h.engine.pageKey])
    expect(await h.engine.list({ pageKey: null })).toHaveLength(2)
    expect(h.engine.listThreads()).toHaveLength(1) // the live view is page-scoped
  })

  test('ready() resolves after the first store load and the first anchoring pass', async () => {
    const h = await scene()
    await expect(h.engine.ready()).resolves.toBeUndefined()
    expect(h.engine.status.get()).toBe('ready')
  })
})
