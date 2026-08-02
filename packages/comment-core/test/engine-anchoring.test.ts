/**
 * §4.6.5 the MutationObserver lifecycle, §4.1 row 14 (anchor element disappears), §2.3 the
 * `Anchoring` derivation, and `engine.reanchor` / `engine.focus` / `engine.explain`.
 */

import { afterEach, describe, expect, test } from 'vitest'

import { createCommentEngine, createMemoryStore } from '../src/index.ts'
import { harness } from './dom-helpers.ts'

const PAGE =
  '<article id="a" data-testid="a">alpha text</article><div id="b" data-testid="b">beta text</div>'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

async function scene(html = PAGE, options?: Parameters<typeof harness>[1]) {
  const h = await harness(html, options)
  cleanup.push(h.dispose)
  return h
}

describe('§4.1 row 14 — the anchor element disappears', () => {
  test('removal orphans the thread at render time with NO store write', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    const writesBefore = h.store.writes

    await h.page.mutate((doc) => doc.querySelector('#a')!.remove())

    const view = h.engine.getThreadView(id)!
    expect(view.anchoring.status).toBe('orphaned')
    expect(view.isOrphaned).toBe(true)
    expect(view.anchoring.element).toBeNull()
    expect(h.store.writes).toBe(writesBefore) // there is no field in which orphanhood could live
    expect(h.typed('thread:orphaned')[0]!.payload.thread.id).toBe(id)
  })

  test('the thread auto re-attaches when the element comes back', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    await h.page.mutate((doc) => doc.querySelector('#a')!.remove())
    expect(h.engine.getThreadView(id)!.anchoring.status).toBe('orphaned')
    h.events.length = 0

    await h.page.mutate((doc) => {
      const restored = doc.createElement('article')
      restored.id = 'a'
      restored.setAttribute('data-testid', 'a')
      restored.textContent = 'alpha text'
      doc.body.prepend(restored)
    })

    const view = h.engine.getThreadView(id)!
    expect(view.anchoring.status).toBe('anchored')
    expect(view.anchoring.element).toBe(h.page.document.querySelector('#a'))
    const anchored = h.typed('thread:anchored')[0]!
    expect(anchored.payload.previous).toBe('orphaned')
    expect(anchored.payload.confidence).toBe(1)
    expect(anchored.payload.via).toBe('attr')
  })

  test('an orphaned thread keeps its last known rect so the badge can dock', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    const before = h.engine.getThreadView(id)!.anchoring.rect
    expect(before).not.toBeNull()
    await h.page.mutate((doc) => doc.querySelector('#a')!.remove())
    expect(h.engine.getThreadView(id)!.anchoring.rect).toEqual(before)
    expect(h.typed('thread:orphaned')[0]!.payload.lastRect).toEqual(before)
  })
})

describe('§4.6.5 the observer loop', () => {
  test('the engine installs one shared MutationObserver, and observe: false skips it', async () => {
    const h = await scene()
    expect(h.engine.inspect().anchoring.observing).toBe(true)

    const quiet = await scene(PAGE, { anchoring: { observe: false } })
    expect(quiet.engine.inspect().anchoring.observing).toBe(false)
  })

  test('added nodes are retried scoped to the added subtree before the document', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    await h.page.mutate((doc) => doc.querySelector('#a')!.remove())
    h.events.length = 0

    await h.page.mutate((doc) => {
      const wrapper = doc.createElement('section')
      wrapper.innerHTML = '<article id="a" data-testid="a">alpha text</article>'
      doc.body.append(wrapper)
    })
    expect(h.engine.getThreadView(id)!.anchoring.status).toBe('anchored')
  })

  test('rescanIdle: false leaves an orphan orphaned when nothing is added to the page', async () => {
    const h = await scene(PAGE, { anchoring: { rescanIdle: false } })
    const id = await h.seed('#a')
    await h.page.mutate((doc) => doc.querySelector('#a')!.remove())
    expect(h.engine.getThreadView(id)!.anchoring.status).toBe('orphaned')

    // A same-tag element with the same fingerprint exists, but the orphan is never rescanned
    // against the whole document — only against what was added.
    await h.page.mutate((doc) => {
      const late = doc.createElement('article')
      late.id = 'a'
      late.setAttribute('data-testid', 'a')
      late.textContent = 'alpha text'
      doc.body.append(late)
    })
    // …and here it IS added, so the scoped cheap retry finds it.
    expect(h.engine.getThreadView(id)!.anchoring.status).toBe('anchored')
  })

  test('inspect().anchoring reports batches, lastBatchMs and the pending count', async () => {
    const h = await scene()
    await h.seed('#a')
    const before = h.engine.inspect().anchoring.batches
    await h.page.mutate((doc) => doc.body.append(doc.createElement('span')))
    const after = h.engine.inspect().anchoring
    expect(after.batches).toBeGreaterThan(before)
    expect(after.pending).toBe(0)
    expect(typeof after.lastBatchMs).toBe('number')
  })
})

describe('§2.11 anchoring control', () => {
  test('reanchor() forces a pass for every thread and emits the transitions', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    // Mutate behind the observer's back is impossible here, so mutate and cancel the batch by
    // reanchoring first — reanchor must not depend on a pending batch.
    h.page.document.querySelector('#a')!.remove()
    h.events.length = 0
    await h.engine.reanchor()
    expect(h.engine.getThreadView(id)!.anchoring.status).toBe('orphaned')
    expect(h.names()).toEqual(['thread:orphaned'])
  })

  test('reanchor(threadId) touches only that thread', async () => {
    const h = await scene()
    const a = await h.seed('#a')
    const b = await h.seed('#b')
    h.page.document.querySelector('#a')!.remove()
    h.page.document.querySelector('#b')!.remove()
    h.events.length = 0

    await h.engine.reanchor(a)
    expect(h.engine.getThreadView(a)!.anchoring.status).toBe('orphaned')
    expect(h.engine.getThreadView(b)!.anchoring.status).toBe('anchored') // stale on purpose
    expect(h.names()).toEqual(['thread:orphaned'])
  })

  test('focus() scrolls, marks active and emits thread:click; false for unknown/unanchored', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    expect(h.engine.focus('nope')).toBe(false)
    expect(h.engine.focus(id)).toBe(true)
    expect(h.engine.active.get()).toBe(id)
    expect(h.typed('thread:click')[0]!.payload.element).toBe(h.page.document.querySelector('#a'))

    await h.page.mutate((doc) => doc.querySelector('#a')!.remove())
    expect(h.engine.focus(id)).toBe(false)
  })

  test('explain() is CACHED by default and returns the trace of the last pass', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    const readsBefore = h.store.reads
    const trace = h.engine.explain(id)
    expect(trace?.result?.element).toBe(h.page.document.querySelector('#a'))
    expect(h.engine.explain(id)).toBe(trace) // same object: no work was done
    expect(h.store.reads).toBe(readsBefore)
    expect(h.engine.explain('missing')).toBeNull()
  })

  test('explain({ fresh: true }) re-runs resolution now', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    const cached = h.engine.explain(id)
    const fresh = h.engine.explain(id, { fresh: true })
    expect(fresh).not.toBe(cached)
    expect(fresh?.result?.element).toBe(h.page.document.querySelector('#a'))
  })
})

describe('§2.3 the Anchoring derivation', () => {
  test('a text thread exposes its live Range and its confidence', async () => {
    const h = await scene('<p id="p" data-testid="p">alpha beta gamma delta</p>')
    const text = h.page.document.querySelector('#p')!.firstChild!
    const range = h.page.document.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 16)

    expect(h.engine.placement.start('comment', { selection: range })).toBe(true)
    const result = await h.engine.placement.submit('about beta gamma')
    const view = h.engine.getThreadView(result.thread.id)!
    expect(view.anchoring.status).toBe('anchored')
    expect(view.anchoring.range?.toString()).toBe('beta gamma')
    expect(view.anchoring.confidence).toBeGreaterThan(0.85)
  })

  test('a mutated element is re-verified, and a weakened match is reported as approximate', async () => {
    const h = await scene(
      '<article id="a" data-testid="a" role="note" class="card">alpha text</article><div id="b">x</div>',
    )
    const id = await h.seed('#a')
    expect(h.engine.getThreadView(id)!.anchoring.confidence).toBe(1)

    // The element stays connected, so only the observer's `attributes` half can catch this.
    await h.page.mutate((doc) => doc.querySelector('#a')!.removeAttribute('data-testid'))

    const view = h.engine.getThreadView(id)!
    expect(view.anchoring.status).toBe('anchored')
    expect(view.anchoring.confidence).toBeGreaterThanOrEqual(0.62)
    expect(view.anchoring.confidence).toBeLessThan(0.85)
  })

  test('a mutated element that no longer verifies is orphaned even though it is still connected', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    await h.page.mutate((doc) => {
      const element = doc.querySelector('#a')!
      element.removeAttribute('data-testid')
      element.textContent = 'completely different subject matter now'
    })
    expect(h.engine.getThreadView(id)!.anchoring.status).toBe('orphaned')
  })

  test('§2.11 autoStart: false — construction succeeds, status stays idle, DOM methods no-op', async () => {
    const source = await scene()
    const id = await source.seed('#a')
    const snapshot = source.store.snapshot()

    const engine = createCommentEngine({
      store: createMemoryStore(snapshot),
      autoStart: false,
      document,
    })
    try {
      expect(engine.status.get()).toBe('idle')
      expect(engine.threads.get()).toEqual([])
      expect(engine.listThreads()).toEqual([])
      expect(engine.getThreadView(id)).toBeNull()
      expect(engine.focus(id)).toBe(false)
      expect(engine.explain(id)).toBeNull()
      await expect(engine.reanchor()).resolves.toBeUndefined()
      expect(engine.inspect().anchoring).toEqual({
        observing: false,
        batches: 0,
        lastBatchMs: 0,
        pending: 0,
      })
    } finally {
      engine.destroy()
    }
  })
})

describe('§4.2.6 the first full pass is gated on a parsed document', () => {
  /**
   * The content script is registered at `document_start` and `autoStart` defaults to `true`, so
   * `start()` normally runs against an empty `<html>`. A "first full pass" there would orphan
   * every thread on every page load.
   */
  function parsing(): () => void {
    Object.defineProperty(document, 'readyState', { get: () => 'loading', configurable: true })
    return () => Reflect.deleteProperty(document, 'readyState')
  }

  test('threads load as pending, ready() waits for DOMContentLoaded, and no orphan is flashed', async () => {
    const source = await scene()
    const id = await source.seed('#a')
    const snapshot = source.store.snapshot()

    // A page whose element is NOT present: without the gate this would orphan immediately.
    document.body.innerHTML = '<div id="unrelated">x</div>'

    const parsed = parsing()
    const engine = createCommentEngine({ store: createMemoryStore(snapshot), document })
    const seen: string[] = []
    engine.subscribe((event) => seen.push(event.type))

    try {
      // Let the store load settle: the threads are held in `pending`, and nothing is emitted.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(engine.status.get()).toBe('loading')
      expect(engine.getThreadView(id)?.anchoring.status).toBe('pending')
      expect(seen).toEqual([])

      // DOMContentLoaded releases the first full pass, and only then does the orphan appear.
      parsed()
      document.dispatchEvent(new document.defaultView!.Event('DOMContentLoaded'))
      await engine.ready()
      expect(engine.getThreadView(id)!.anchoring.status).toBe('orphaned')
      expect(seen).toEqual(['thread:orphaned'])
    } finally {
      parsed()
      engine.destroy()
    }
  })
})
