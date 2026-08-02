/**
 * §2.11 `CommentEngineOptions.capture` and `anchoring.strategies`, plus §4.1 row 16 seen from
 * the engine (which "additionally emits `error`/`unsupported_version`").
 */

import { afterEach, describe, expect, test } from 'vitest'

import { createMemoryStore, defaultStrategies, defineSelectorStrategy } from '../src/index.ts'
import { harness } from './dom-helpers.ts'

const PAGE = '<div id="t" data-row-id="r7" data-testid="t">ssn 111-22-3333</div>'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

describe('§2.11 capture options', () => {
  test('capture.redact / htmlLimit / sanitize reach persistence through the composer', async () => {
    const h = await harness(PAGE, {
      capture: {
        htmlLimit: 32,
        redact: (capture) => ({ ...capture, text: capture.text.replace(/\d/gu, '#') }),
      },
    })
    cleanup.push(h.dispose)

    h.engine.placement.start('comment', { element: h.page.document.querySelector('#t')! })
    const result = await h.engine.placement.submit('about that')
    const stored = (await h.engine.get(result.thread.id))!.thread.capture

    expect(stored.text).toBe('ssn ###-##-####')
    expect(new TextEncoder().encode(stored.outerHTML).length).toBeLessThanOrEqual(32)
  })

  test('capture.now stamps capturedAt', async () => {
    const h = await harness(PAGE, {
      capture: { now: () => new Date('2026-03-04T05:06:07.000Z') },
    })
    cleanup.push(h.dispose)
    h.engine.placement.start('comment', { element: h.page.document.querySelector('#t')! })
    const result = await h.engine.placement.submit('x')
    expect(result.thread.capture.capturedAt).toBe('2026-03-04T05:06:07.000Z')
  })
})

describe('§4.6.1 one strategy list for both halves', () => {
  test('a custom locator is WRITTEN at capture time and READ at anchoring time', async () => {
    const rowId = defineSelectorStrategy({
      type: 'x-row-id',
      weight: 120,
      cost: 'cheap',
      describe: (target, { closest }) => {
        const row = closest(target, '[data-row-id]')
        return row ? { rowId: row.getAttribute('data-row-id')! } : null
      },
      resolve: (sel, { root }) => root.querySelector(`[data-row-id="${sel.rowId}"]`),
    })

    const h = await harness(PAGE, {
      anchoring: { strategies: [rowId, ...defaultStrategies] },
    })
    cleanup.push(h.dispose)

    h.engine.placement.start('comment', { element: h.page.document.querySelector('#t')! })
    const result = await h.engine.placement.submit('about the row')
    expect(result.thread.anchor.selectors[0]).toEqual({ type: 'x-row-id', rowId: 'r7' })

    // Recycle the row: everything structural changes, the key does not.
    await h.page.mutate((doc) => {
      doc.body.innerHTML =
        '<section><span>filler</span><div id="other" data-row-id="r7" data-testid="t">ssn 111-22-3333</div></section>'
    })
    const view = h.engine.getThreadView(result.thread.id)!
    expect(view.anchoring.status).toBe('anchored')
    expect(view.anchoring.via).toBe('x-row-id')
  })
})

describe('§4.1 rule 16 — unknown record version', () => {
  test('the record is skipped from the live view, never rewritten, and reported as error/unsupported_version', async () => {
    const store = createMemoryStore()
    await store.putComment({
      id: 'c1',
      threadId: 'future',
      author: 'user',
      body: 'from a newer build',
      createdAt: '2026-01-01T00:00:00.000Z',
      editedAt: null,
    })
    await store.putThread({
      id: 'future',
      v: 99 as 1,
      pageKey: 'https://example.com/doc',
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
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    const before = JSON.stringify(store.snapshot())

    // The report is emitted during the very first load — and exactly once per record per
    // instance — so it has to be collected through `onError`, not off the post-ready bus.
    const faults: Array<[string, string]> = []
    const h = await harness(PAGE, {
      store,
      onError: (error, phase) => faults.push([error.code, phase]),
    })
    cleanup.push(h.dispose)

    expect(h.engine.listThreads()).toEqual([])
    expect(h.engine.getThreadView('future')).toBeNull()
    expect(JSON.stringify(store.snapshot())).toBe(before) // never rewritten
    expect(faults).toEqual([['unsupported_version', 'store']])

    // Reported once per record per instance: a second read is silent.
    await h.engine.list()
    expect(faults).toHaveLength(1)
  })
})
