/**
 * Regression suite for the adversarial review of `comment-core`.
 *
 * One named test per finding, each stating the spec clause it enforces. These are the cases the
 * original suite could not see: several of them passed *because* a test asserted the buggy
 * behaviour, and the rest sat on code paths (unknown-version records, off-page writes, a stale
 * origin token, a throwing `ReadableStore` subscriber) no existing scenario reached.
 */

import { afterEach, describe, expect, test } from 'vitest'

import type { Comment, CommentStore, MemoryStore, StoreEvent, Thread } from '../src/index.ts'

import * as rootBarrel from '../src/index.ts'
import {
  captureTarget,
  CommentError,
  createDomain,
  createMemoryStore,
  defaultStrategies,
  observeStore,
  resolveAnchor,
} from '../src/index.ts'
import { harness, PAGE_URL } from './dom-helpers.ts'

const PAGE =
  '<article id="a" data-testid="a">alpha text</article><div id="b" data-testid="b">beta text</div>'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  document.body.innerHTML = ''
})

async function scene(options?: Parameters<typeof harness>[1]) {
  const h = await harness(PAGE, options)
  cleanup.push(h.dispose)
  return h
}

/** Let every queued microtask + timer turn settle (store notifications are microtask-coalesced). */
async function settle(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function anchorFor(doc: Document, selector: string) {
  const target = doc.querySelector(selector)
  if (!target) throw new Error(`no element for ${selector}`)
  return captureTarget(target, { document: doc })
}

/** An anchor/capture pair for the headless (no-engine) cases, over the ambient document. */
function headlessAnchor() {
  document.body.innerHTML = PAGE
  return anchorFor(document, '#a')
}

/** A stored thread this build cannot narrow (§2.7 `StoredThread`, §4.1 rule 16). */
function futureThread(id: string, pageKey: string, doc: Document): Thread {
  if (!doc.querySelector('#a')) doc.body.innerHTML = PAGE
  const { anchor, capture } = anchorFor(doc, '#a')
  return {
    id,
    v: 2 as unknown as 1,
    pageKey,
    kind: 'comment',
    anchor,
    capture,
    status: 'open',
    resolvedAt: null,
    resolvedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

function commentOn(threadId: string, id: string, body = 'body'): Comment {
  return {
    id,
    threadId,
    author: 'user',
    body,
    createdAt: '2026-01-01T00:00:00.000Z',
    editedAt: null,
  }
}

/* ─────────────────────────────────────────────────────────────────────────────────── HIGH ── */

describe('§4.2.1 persist-then-notify — a store rejection is an `error` event', () => {
  test('finding 1: an imperative store rejection emits exactly one `error` with phase `store`', async () => {
    const store = createMemoryStore()
    const h = await scene({ store })
    const id = await h.seed('#a')
    h.events.length = 0

    store.putThread = async () => {
      throw new Error('disk on fire')
    }
    await expect(h.engine.resolve(id)).rejects.toMatchObject({ code: 'store_failed' })

    const errors = h.typed('error')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.payload.phase).toBe('store')
    expect(errors[0]!.payload.error.code).toBe('store_failed')
    // "…and the live view is left untouched" — nothing optimistically mutated.
    expect(h.engine.getThreadView(id)!.status).toBe('open')
  })

  test('finding 1: `opts.onError` receives the same store fault, so a pager binding sees it', async () => {
    const sink: Array<[string, string]> = []
    const store = createMemoryStore()
    const h = await scene({ store, onError: (error, phase) => sink.push([error.code, phase]) })
    store.putComment = async () => {
      throw new Error('nope')
    }
    await expect(h.seed('#a')).rejects.toMatchObject({ code: 'store_failed' })
    expect(sink).toEqual([['store_failed', 'store']])
  })

  test('finding 1: a caller-visible rejection (`empty_body`) is NOT fanned into the `error` channel', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    h.events.length = 0
    await expect(h.engine.appendComment(id, { author: 'user', body: '   ' })).rejects.toMatchObject(
      { code: 'empty_body' },
    )
    // §2.12: the `error` channel is reserved for faults, so `onError` stays bindable to a pager.
    expect(h.typed('error')).toHaveLength(0)
  })
})

describe('§4.2.8 origin tokens must never under-notify', () => {
  test('finding 3: a stale origin token does not swallow another tab’s edit on the same record', async () => {
    const store = createMemoryStore()
    const h = await scene({ store })
    const id = await h.seed('#a')

    // A local write records a `t:` token. Its echo is absorbed by the local `records` update,
    // so the token is never consumed — it must not survive to eat the next genuine event.
    await h.engine.resolve(id)
    await h.flush()
    expect(h.engine.getThreadView(id)!.status).toBe('resolved')
    h.events.length = 0

    // Another tab reopens the very same thread: same token key `t:{id}`.
    await createDomain(store).reopen(id)
    await h.flush()

    const reopened = h.typed('thread:reopen')
    expect(reopened).toHaveLength(1)
    expect(reopened[0]!.payload.source).toBe('remote')
    expect(h.engine.getThreadView(id)!.status).toBe('open')
  })

  test('finding 3: the dedupe still holds — a local write is never re-emitted as its own echo', async () => {
    const h = await scene({ now: () => new Date(0) })
    const id = await h.seed('#a')
    h.events.length = 0
    await h.engine.resolve(id)
    await h.flush()
    await h.flush()
    expect(h.names()).toEqual(['thread:resolve'])
    expect(h.typed('thread:resolve')[0]!.payload.source).toBe('local')
  })

  test('finding 3: a local write and a remote write are not re-ordered into a self-echo', async () => {
    const store = createMemoryStore()
    const h = await scene({ store })
    const id = await h.seed('#a')
    h.events.length = 0

    await h.engine.appendComment(id, { author: 'copilot', body: 'local' })
    await createDomain(store).appendComment(id, { author: 'user', body: 'remote' })
    await h.flush()

    const replies = h.typed('thread:reply')
    expect(replies.map((e) => e.payload.comment.body)).toEqual(['local', 'remote'])
    expect(replies.map((e) => e.payload.source)).toEqual(['local', 'remote'])
  })
})

describe('§2.3 `ThreadView.lastComment` is non-nullable by invariant', () => {
  test('finding 4: resolving a thread this engine has not loaded never yields a zero-comment view', async () => {
    const store = createMemoryStore()
    // `subscribe` is inert, so the engine's `records` never learns about the write below — the
    // exact state in which the resolve path used to fall back to `comments: []`.
    const inert = { ...store, subscribe: () => () => {} } as MemoryStore
    const h = await scene({ store: inert })

    const { anchor, capture } = anchorFor(h.page.document, '#a')
    const created = await createDomain(store).createThread({
      pageKey: h.engine.pageKey,
      kind: 'comment',
      anchor,
      capture,
      author: 'user',
      body: 'from elsewhere',
    })
    expect(h.engine.getThreadView(created.thread.id)).toBeNull()

    await h.engine.resolve(created.thread.id)

    const view = h.engine.getThreadView(created.thread.id)!
    expect(view.comments).toHaveLength(1)
    expect(view.lastComment.body).toBe('from elsewhere')
    expect(view.lastActivityAt).not.toBe('')
    for (const each of h.engine.threads.get()) expect(each.lastComment).toBeDefined()
  })

  test('finding 4: every view the engine ever publishes has at least one comment', async () => {
    const h = await scene()
    const seen: number[] = []
    h.engine.threads.subscribe((views) => {
      for (const view of views) seen.push(view.comments.length)
    })
    const id = await h.seed('#a')
    await h.engine.appendComment(id, { author: 'copilot', body: 'two' })
    await h.engine.resolve(id)
    await h.flush()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((count) => count > 0)).toBe(true)
  })
})

describe('§4.1 rule 16 — an unknown-version record is never rewritten', () => {
  test('finding 5: an idempotent create against a future-version id rejects instead of overwriting it', async () => {
    const store = createMemoryStore()
    const { anchor, capture } = headlessAnchor()
    await store.putThread(futureThread('future', PAGE_URL, document))
    await store.putComment(commentOn('future', 'future-c'))

    const errors: CommentError[] = []
    const domain = createDomain(store, { onError: (error) => errors.push(error) })

    await expect(
      domain.createThread({
        id: 'future',
        pageKey: PAGE_URL,
        kind: 'comment',
        anchor,
        capture,
        author: 'user',
        body: 'clobber me',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_version' })

    // "never rewritten": the record on disk is byte-for-byte the future one.
    expect((await store.getThread('future'))!.v).toBe(2)
    // "reported once per record per instance".
    expect(errors.map((error) => error.code)).toEqual(['unsupported_version'])
  })

  test('finding 5: an idempotent create keyed only by `commentId` does not mint a second thread', async () => {
    const store = createMemoryStore()
    const { anchor, capture } = headlessAnchor()
    await store.putThread(futureThread('future', PAGE_URL, document))
    await store.putComment(commentOn('future', 'shared-c'))

    const domain = createDomain(store)
    await expect(
      domain.createThread({
        commentId: 'shared-c',
        pageKey: PAGE_URL,
        kind: 'comment',
        anchor,
        capture,
        author: 'user',
        body: 'replay',
      }),
    ).rejects.toMatchObject({ code: 'unsupported_version' })
    expect(await domain.list()).toEqual([])
  })
})

describe('§4.4 `destroy()` is always safe and idempotent', () => {
  test('finding 6: a throwing `threads` subscriber cannot break destroy()', async () => {
    const h = await scene()
    await h.seed('#a')
    h.engine.threads.subscribe(() => {
      throw new Error('render boom')
    })

    expect(() => h.engine.destroy()).not.toThrow()
    expect(h.engine.status.get()).toBe('destroyed')
    expect(() => h.engine.destroy()).not.toThrow()
    expect(h.engine.threads.get()).toEqual([])
  })

  test('finding 6: a throwing `threads` subscriber cannot break an imperative write either', async () => {
    const h = await scene()
    const phases: string[] = []
    h.engine.on('error', ({ phase }) => phases.push(phase))
    h.engine.threads.subscribe(() => {
      throw new Error('render boom')
    })

    const id = await h.seed('#a')
    expect(typeof id).toBe('string')
    expect(h.engine.getThreadView(id)).not.toBeNull()
    expect(phases).toContain('listener')
  })

  test('finding 6: `stop()` survives a throwing subscriber too', async () => {
    const h = await scene()
    h.engine.status.subscribe(() => {
      throw new Error('status boom')
    })
    expect(() => h.engine.stop()).not.toThrow()
    expect(h.engine.status.get()).toBe('idle')
  })
})

/* ───────────────────────────────────────────────────────────────────────────────── MEDIUM ── */

describe('§4.2.9 one `placement:start` … one `placement:end` per flow', () => {
  test('finding 7: the pick flow emits exactly one placement:start, not one per state transition', async () => {
    const h = await scene()
    h.events.length = 0
    expect(h.engine.startPlacement('comment')).toBe(true)
    expect(h.engine.placement.get().phase).toBe('picking')

    const doc = h.page.document
    doc.querySelector('#a')!.dispatchEvent(
      new doc.defaultView!.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    )

    expect(h.engine.placement.get().phase).toBe('composing')
    const starts = h.typed('placement:start')
    expect(starts).toHaveLength(1)
    expect(starts[0]!.payload).toEqual({ kind: 'comment', interaction: 'pick' })
  })

  test('finding 7: the whole pick→place flow is start … create … end, with one of each', async () => {
    const h = await scene()
    h.events.length = 0
    h.engine.startPlacement('comment')
    const doc = h.page.document
    doc.querySelector('#a')!.dispatchEvent(
      new doc.defaultView!.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        composed: true,
      }),
    )
    await h.engine.placement.submit('picked body')
    expect(h.names()).toEqual(['placement:start', 'thread:create', 'placement:end'])
  })

  test('finding 8: cancel() during `submitting` yields one placement:end, not a cancelled+placed pair', async () => {
    const store = createMemoryStore()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = await scene({ store })
    const target = h.page.document.querySelector('#a')!
    h.events.length = 0

    const realPut = store.putComment.bind(store)
    store.putComment = async (comment) => {
      await gate
      return realPut(comment)
    }

    expect(h.engine.placement.start('comment', { element: target })).toBe(true)
    const submitting = h.engine.placement.submit('body')
    expect(h.engine.placement.get().phase).toBe('submitting')

    // Esc during an in-flight submit (§4.5 routes Escape here from any non-idle phase).
    h.engine.placement.cancel('escape')
    expect(h.engine.placement.get().phase).toBe('idle')

    release()
    await submitting
    await h.flush()

    const ends = h.typed('placement:end')
    expect(ends).toHaveLength(1)
    expect(ends[0]!.payload).toEqual({ kind: 'comment', reason: 'cancelled', threadId: null })
    // The state machine stays idle — the flow is over, not half-restored to `composing`.
    expect(h.engine.placement.get().phase).toBe('idle')
  })
})

describe('§2.11 `off()` detaches what `on`/`once` attached', () => {
  test('finding 9: off() detaches a listener registered with once()', async () => {
    const h = await scene()
    let calls = 0
    const listener = (): void => {
      calls += 1
    }
    h.engine.once('thread:create', listener)
    expect(h.engine.inspect().listeners['thread:create']).toBe(1)

    h.engine.off('thread:create', listener)
    expect(h.engine.inspect().listeners['thread:create']).toBe(0)

    await h.seed('#a')
    expect(calls).toBe(0)
  })

  test('finding 9: off() detaches a listener registered with on(..., { once: true })', async () => {
    const h = await scene()
    let calls = 0
    const listener = (): void => {
      calls += 1
    }
    h.engine.on('thread:create', listener, { once: true })
    h.engine.off('thread:create', listener)
    await h.seed('#a')
    expect(calls).toBe(0)
    expect(h.engine.inspect().listeners['thread:create']).toBe(0)
  })

  test('finding 9: a once listener still fires exactly once and retires itself', async () => {
    const h = await scene()
    const bodies: string[] = []
    h.engine.once('thread:create', ({ comment }) => bodies.push(comment.body))
    await h.seed('#a', 'one')
    await h.seed('#b', 'two')
    expect(bodies).toEqual(['one'])
    expect(h.engine.inspect().listeners['thread:create']).toBe(0)
  })
})

describe('§4.1 rule 15 — idempotency keys are scoped to their thread', () => {
  test('finding 10: reusing a comment id from another thread never returns a foreign comment', async () => {
    const store = createMemoryStore()
    const domain = createDomain(store)
    const { anchor, capture } = headlessAnchor()
    const base = { pageKey: PAGE_URL, kind: 'comment', anchor, capture, author: 'user' } as const

    await domain.createThread({ ...base, id: 'A', body: 'thread a' })
    await domain.createThread({ ...base, id: 'B', body: 'thread b' })
    await domain.appendComment('A', { author: 'copilot', body: 'run output', id: 'shared' })

    await expect(
      domain.appendComment('B', { author: 'copilot', body: 'run output', id: 'shared' }),
    ).rejects.toMatchObject({ code: 'invalid_options' })

    // Thread B is untouched, and thread A keeps exactly one `shared` comment.
    expect((await domain.get('B'))!.comments.map((c) => c.body)).toEqual(['thread b'])
    expect((await domain.get('A'))!.comments.filter((c) => c.id === 'shared')).toHaveLength(1)
  })

  test('finding 10: same-thread reuse still dedupes with an internally consistent AppendResult', async () => {
    const store = createMemoryStore()
    const domain = createDomain(store)
    const { anchor, capture } = headlessAnchor()
    await domain.createThread({
      id: 'A',
      pageKey: PAGE_URL,
      kind: 'comment',
      anchor,
      capture,
      author: 'user',
      body: 'thread a',
    })
    const first = await domain.appendComment('A', { author: 'copilot', body: 'x', id: 'r:1' })
    const again = await domain.appendComment('A', { author: 'copilot', body: 'x again', id: 'r:1' })

    expect(first.deduped).toBe(false)
    expect(again.deduped).toBe(true)
    expect(again.comment.threadId).toBe(again.thread.id)
    expect(again.comment.body).toBe('x')
  })
})

describe('§4.4 post-`destroy()` calls neither mutate nor lie', () => {
  test('finding 11: startPlacement() is a no-op that returns false after destroy()', async () => {
    const h = await scene()
    h.engine.destroy()
    expect(h.engine.startPlacement('comment')).toBe(false)
    expect(h.engine.placement.get().phase).toBe('idle')
    expect(h.events).toEqual([])
  })

  test('finding 11: setModes() reports engine_destroyed and leaves `modes` alone', async () => {
    const h = await scene()
    const before = h.engine.modes
    h.engine.destroy()
    expect(() => h.engine.setModes([{ kind: 'other', trigger: { key: 'o' } }])).toThrow(
      expect.objectContaining({ code: 'engine_destroyed' }) as unknown as Error,
    )
    expect(h.engine.modes).toBe(before)
  })

  test('finding 11: placement.submit() rejects with engine_destroyed after destroy()', async () => {
    const h = await scene()
    h.engine.placement.start('comment', { element: h.page.document.querySelector('#a')! })
    h.engine.destroy()
    await expect(h.engine.placement.submit('body')).rejects.toMatchObject({
      code: 'engine_destroyed',
    })
  })
})

describe('§4.1 rule 8 — every delete emits one `thread:delete`', () => {
  test('finding 12: deleting an unknown-version record still emits thread:delete', async () => {
    const store = createMemoryStore()
    const h = await scene({ store })
    await store.putComment(commentOn('future', 'future-c'))
    await store.putThread(futureThread('future', h.engine.pageKey, h.page.document))
    await h.flush()
    h.events.length = 0

    await h.engine.delete('future')

    const deletes = h.typed('thread:delete')
    expect(deletes).toHaveLength(1)
    expect(deletes[0]!.payload.thread.id).toBe('future')
    expect(deletes[0]!.payload.reason).toBe('explicit')
    // Deleting is not rewriting: the record is gone, and its `v` was carried through verbatim.
    expect(deletes[0]!.payload.thread.v).toBe(2)
    expect(await store.getThread('future')).toBeNull()
  })
})

describe('§4.2.2 an event always has the view it describes', () => {
  test('finding 13: an off-page write persists but emits nothing on this page’s bus', async () => {
    const h = await scene()
    const { anchor, capture } = anchorFor(h.page.document, '#a')
    h.events.length = 0

    const result = await h.engine.createThread({
      pageKey: 'https://elsewhere.example/other',
      kind: 'comment',
      anchor,
      capture,
      author: 'user',
      body: 'off page',
    })

    expect(h.names()).toEqual([])
    expect(h.engine.getThreadView(result.thread.id)).toBeNull()
    // "Persist-then-notify" is not "never persist": the write landed.
    expect(await h.store.getThread(result.thread.id)).not.toBeNull()
  })

  test('finding 13: getThreadView(id) is non-null inside every emitted domain event', async () => {
    const h = await scene()
    const missing: string[] = []
    h.engine.subscribe((event) => {
      const payload = event.payload as { thread?: { id: string } }
      if (!event.type.startsWith('thread:') && !event.type.startsWith('comment:')) return
      if (event.type === 'thread:delete' || event.type === 'comment:delete') return
      if (payload.thread && !h.engine.getThreadView(payload.thread.id)) missing.push(event.type)
    })

    const id = await h.seed('#a')
    await h.engine.appendComment(id, { author: 'copilot', body: 'two' })
    await h.engine.resolve(id)
    await h.engine.reopen(id)
    await h.flush()
    expect(missing).toEqual([])
  })
})

describe('§2.10.4 bounded work', () => {
  test('finding 14: one notification burst costs one enumeration and one listComments per live thread', async () => {
    const store = createMemoryStore()
    const domain = createDomain(store)
    const { anchor, capture } = headlessAnchor()
    const THREADS = 20
    for (let i = 0; i < THREADS; i += 1) {
      await domain.createThread({
        id: `t${i}`,
        pageKey: PAGE_URL,
        kind: 'comment',
        anchor,
        capture,
        author: 'user',
        body: `thread ${i}`,
      })
    }

    let enumerations = 0
    let commentReads = 0
    const counted: CommentStore = {
      ...store,
      listAllThreads: async () => {
        enumerations += 1
        return store.listAllThreads()
      },
      listComments: async (threadId) => {
        commentReads += 1
        return store.listComments(threadId)
      },
    }

    const events: StoreEvent[] = []
    const stop = observeStore(counted, (event) => {
      events.push(event)
    })
    await settle()
    enumerations = 0
    commentReads = 0

    await domain.appendComment('t0', { author: 'user', body: 'one reply' })
    await settle()
    stop()

    expect(events.filter((event) => event.type === 'thread:reply')).toHaveLength(1)
    // §2.10.5: the notification burst a single write raises is coalesced into ONE pass.
    expect(enumerations).toBe(1)
    /*
     * DEVIATION (documented). §2.10.4 asks for O(changed records) by reading the thread-key
     * prefix and re-reading comments "only for threads whose key set changed". That is written
     * against `createKeyValueStore`'s key layout, but `observeStore` is handed a `CommentStore`
     * — the locked 9-method port (§2.7) — which exposes no key-level API at all, and §2.7 rule 7
     * guarantees a comment write never touches its thread record. So a new reply is invisible in
     * the thread enumeration and cannot be located without asking each thread for its comments.
     * The reachable bound is exactly one `listComments` per live thread per pass, which is what
     * this pins: never a repeat read, never a second pass.
     */
    expect(commentReads).toBe(THREADS)
  })

  test('finding 14: a notification that changed nothing emits nothing and still costs one pass', async () => {
    const store = createMemoryStore()
    const domain = createDomain(store)
    const { anchor, capture } = headlessAnchor()
    await domain.createThread({
      id: 't0',
      pageKey: PAGE_URL,
      kind: 'comment',
      anchor,
      capture,
      author: 'user',
      body: 'only',
    })

    const events: StoreEvent[] = []
    const stop = observeStore(store, (event) => {
      events.push(event)
    })
    await settle()
    events.length = 0

    // A write that changes nothing observable: the same comment, upserted.
    const record = (await domain.get('t0'))!
    await store.putComment(record.comments[0]!)
    await settle()
    stop()
    expect(events).toEqual([])
  })
})

describe('§4.6.2/.3 the anchoring pipeline never guesses', () => {
  test('finding 15: a signal-free fingerprint does not attach to an arbitrary same-tag element', () => {
    document.body.innerHTML = '<div id="x1"></div><div id="x2"></div>'
    const match = resolveAnchor({
      mode: 'element',
      selectors: [],
      fingerprint: { tag: 'div', stableClasses: [], attrs: {}, textDigest: '' },
    })
    expect(match).toBeNull()
  })

  test('finding 15: a detached node captures to a descriptor that cannot claim a live element', () => {
    document.body.innerHTML = '<div id="x1">alpha</div>'
    const detached = document.createElement('div')
    const { anchor } = captureTarget(detached)
    expect(resolveAnchor(anchor)).toBeNull()
  })

  test('finding 15: a fingerprint that carries real evidence still resolves (no over-correction)', () => {
    document.body.innerHTML = '<div id="x1" data-testid="row">alpha</div><div id="x2"></div>'
    const target = document.querySelector('#x1')!
    const { anchor } = captureTarget(target)
    expect(resolveAnchor(anchor)?.element).toBe(target)
  })
})

/* ──────────────────────────────────────────────────────────────────────────────────── LOW ── */

describe('§2 the public barrel exposes exactly the public surface', () => {
  test('finding 17: internal seams are not re-exported from the root barrel', () => {
    const names = Object.keys(rootBarrel)
    expect(names).not.toContain('INTERNALS')
    expect(names).not.toContain('engineInternals')
    expect(names).not.toContain('EngineInternals')
    expect(names).not.toContain('VERSION')
    // …and what remains is exactly the runtime surface §2 lists — no more, no less. §9:
    // "Every symbol in §2 and §3 is exported with exactly the listed signature."
    expect(names.filter((name) => name !== 'default').sort()).toEqual([
      'CommentError',
      'THREAD_VERSION',
      'assessTarget',
      'captureElement',
      'captureTarget',
      'createCommentEngine',
      'createDomain',
      'createKeyValueCursor',
      'createKeyValueStore',
      'createLocalStorageStore',
      'createMemoryStore',
      'createPageKey',
      'defaultPageKey',
      'defaultStrategies',
      'defineCommentStore',
      'defineSelectorStrategy',
      'explainAnchor',
      'fingerprintElement',
      'observeStore',
      'resolveAnchor',
      'scoreCandidate',
      'volatileParams',
    ])
  })
})

describe('§2.15 `anchoring.batches` counts batches', () => {
  test('finding 18: a single-thread reanchor(id) is not a batch; a full reanchor() is', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    await h.flush()

    const before = h.engine.inspect().anchoring.batches
    await h.engine.reanchor(id)
    expect(h.engine.inspect().anchoring.batches).toBe(before)

    await h.engine.reanchor()
    expect(h.engine.inspect().anchoring.batches).toBe(before + 1)
  })

  test('finding 18: the single-thread pass every local write runs is not a batch', async () => {
    // `subscribe` is inert, so no reload — and therefore no genuine full pass — can run here.
    // What is left is exactly the `{ only, force }` pass `upsertRecord` fires per write.
    const store = createMemoryStore()
    const h = await scene({ store: { ...store, subscribe: () => () => {} } as MemoryStore })
    const id = await h.seed('#a')
    await h.flush()

    const before = h.engine.inspect().anchoring.batches
    await h.engine.appendComment(id, { author: 'copilot', body: 'two' })
    await h.engine.resolve(id)
    await h.engine.reopen(id)
    expect(h.engine.inspect().anchoring.batches).toBe(before)
  })
})

describe('§4.1 rule 7 — the last comment always takes its thread with it', () => {
  test('finding 20: deleting the last comment of an unknown-version thread still cascades', async () => {
    const store = createMemoryStore()
    await store.putComment(commentOn('future', 'future-c'))
    await store.putThread(futureThread('future', PAGE_URL, document))

    const result = await createDomain(store).deleteComment({ threadId: 'future', id: 'future-c' })

    expect(result.threadDeleted).toBe(true)
    expect(result.thread).toBeNull()
    // "An empty thread cannot exist" — not even behind a record this build cannot read.
    expect(await store.getThread('future')).toBeNull()
    expect(await store.listComments('future')).toEqual([])
  })
})

describe('behaviours the review flagged that the spec actually mandates (pinned, not changed)', () => {
  test('finding 21 (dropped): §4.6.2 orders `cheap` before `fuzzy`, so nthPath precedes textQuote', () => {
    // "resolveAnchor runs strategies in weight order, `cheap` before `fuzzy`" is verbatim
    // normative, and §2.5 makes textQuote's whole-document approximate match the fuzzy one.
    // The effective order is a spec consequence, not an implementation defect; §4.6.4's 0.15
    // range penalty is the compensation the spec chose. Pinned so any change is deliberate.
    const order = defaultStrategies.map((strategy) => strategy.type)
    expect(order).toEqual(['attr', 'css', 'textQuote', 'nthPath', 'textPosition'])
    const weights = Object.fromEntries(defaultStrategies.map((s) => [s.type, s.weight]))
    expect(weights).toEqual({ attr: 90, css: 80, textQuote: 70, nthPath: 40, textPosition: 30 })
    const fuzzy = defaultStrategies.filter((s) => s.cost === 'fuzzy').map((s) => s.type)
    expect(fuzzy).toEqual(['textQuote', 'textPosition'])
  })

  test('finding 22 (dropped): destroy() cancels placement *during* destroy, and emits nothing after', async () => {
    const h = await scene()
    h.engine.placement.start('comment', { element: h.page.document.querySelector('#a')! })
    h.events.length = 0

    // §4.5: "Placement is cancelled automatically on page:change and on destroy()." The single
    // `placement:end` lands before destroy() returns, so §4.2.11's "no event is emitted AFTER
    // it" holds — and a mounted comment-ui needs that event to close an open composer.
    h.engine.destroy()
    expect(h.names()).toEqual(['placement:end'])
    expect(h.typed('placement:end')[0]!.payload.reason).toBe('cancelled')

    const after = h.events.length
    await h.page.mutate((doc) => doc.querySelector('#a')!.remove())
    expect(h.events).toHaveLength(after)
  })
})

describe('§1.2 the CommentError brand is a registered symbol, on purpose', () => {
  test('finding 23: `is()` accepts a foreign object carrying the same registered brand', () => {
    // This is the guarantee the `unique symbol` assertion was misdescribing: the brand is
    // deliberately cross-realm, so an error that crossed the IIFE/ESM boundary still narrows.
    const foreign: Record<string | symbol, unknown> = { name: 'CommentError', code: 'empty_body' }
    Object.defineProperty(foreign, Symbol.for('comment-core.error'), {
      value: true,
      enumerable: false,
    })
    expect(CommentError.is(foreign)).toBe(true)
    expect(CommentError.is(foreign, 'empty_body')).toBe(true)
    expect(CommentError.is(foreign, 'no_document')).toBe(false)
  })

  test('finding 23: the brand never lands in JSON or a structured clone', () => {
    const error = new CommentError('empty_body', 'nope', { threadId: 't1' })
    expect(Object.keys(error)).not.toContain('comment-core.error')
    expect(JSON.stringify(error)).not.toContain('comment-core.error')
    expect(CommentError.is(structuredClone(error))).toBe(false)
  })
})
