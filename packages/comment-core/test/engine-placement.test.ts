/**
 * §2.12 `PlacementController` + §4.5 placement/trigger behavior + §4.1 row 17 (`kind` is
 * opaque; an unknown kind rejects AND faults).
 */

import { afterEach, describe, expect, test } from 'vitest'

import type { Mode } from '../src/index.ts'

import { harness } from './dom-helpers.ts'

const PAGE =
  '<article id="a" data-testid="a">alpha text</article>' +
  '<div id="b" data-testid="b">beta text</div>' +
  '<input id="field" /><div id="editable" contenteditable="true">edit me</div>'

const MODES: readonly Mode[] = [
  { kind: 'comment', trigger: { key: 'c', interaction: 'pick' } },
  { kind: 'ask', trigger: { key: 'a', interaction: 'hover' } },
  { kind: 'triage', trigger: false },
  { kind: 'meta', trigger: { key: 'm', modifiers: { shift: true } } },
]

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  document.getSelection()?.removeAllRanges()
})

async function scene(options?: Parameters<typeof harness>[1]) {
  const h = await harness(PAGE, { modes: MODES, ...options })
  cleanup.push(h.dispose)
  return h
}

function key(doc: Document, k: string, init: KeyboardEventInit = {}, target?: Element): void {
  const event = new doc.defaultView!.KeyboardEvent('keydown', {
    key: k,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  })
  ;(target ?? doc.body).dispatchEvent(event)
}

function mouse(doc: Document, type: string, target: Element): void {
  target.dispatchEvent(
    new doc.defaultView!.MouseEvent(type, { bubbles: true, cancelable: true, composed: true }),
  )
}

describe('§2.12 the placement state machine', () => {
  test('start(kind, { element }) goes straight to composing and persists nothing', async () => {
    const h = await scene()
    const target = h.page.document.querySelector('#a')!
    expect(h.engine.placement.start('comment', { element: target })).toBe(true)

    const state = h.engine.placement.get()
    expect(state).toMatchObject({
      phase: 'composing',
      kind: 'comment',
      mode: 'element',
      replyTo: null,
    })
    expect(h.store.writes).toBe(0)
    expect(h.typed('placement:start')[0]!.payload.interaction).toBe('direct')
  })

  test('setDraft updates the composer, and submit persists + resolves with the domain result', async () => {
    const h = await scene()
    h.engine.placement.start('comment', { element: h.page.document.querySelector('#a')! })
    h.engine.placement.setDraft('draft body')
    expect(h.engine.placement.get()).toMatchObject({ draft: 'draft body' })

    const result = await h.engine.placement.submit()
    expect(result.kind).toBe('created')
    expect(result.comment.body).toBe('draft body')
    expect(h.engine.placement.get()).toEqual({ phase: 'idle' })
    expect(h.engine.getThreadView(result.thread.id)!.kind).toBe('comment')
  })

  test('submit() with an empty body rejects with empty_body and nothing is persisted', async () => {
    const h = await scene()
    h.engine.placement.start('comment', { element: h.page.document.querySelector('#a')! })
    await expect(h.engine.placement.submit('   ')).rejects.toMatchObject({ code: 'empty_body' })
    expect(h.store.writes).toBe(0)
  })

  test('on submit failure the state returns to composing with the draft intact', async () => {
    const h = await scene()
    h.store.putComment = async () => {
      throw new Error('write failed')
    }
    h.engine.placement.start('comment', { element: h.page.document.querySelector('#a')! })
    await expect(h.engine.placement.submit('keep me')).rejects.toMatchObject({
      code: 'store_failed',
    })
    expect(h.engine.placement.get()).toMatchObject({ phase: 'composing', draft: 'keep me' })
  })

  test('submit() while submitting is ignored and resolves with the in-flight promise', async () => {
    const h = await scene()
    h.engine.placement.start('comment', { element: h.page.document.querySelector('#a')! })
    const first = h.engine.placement.submit('once')
    const second = h.engine.placement.submit('twice')
    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(h.typed('thread:create')).toHaveLength(1)
  })

  test('cancel() is safe from any phase and is a no-op when idle', async () => {
    const h = await scene()
    h.engine.placement.cancel()
    expect(h.typed('placement:end')).toHaveLength(0)

    h.engine.placement.start('comment')
    expect(h.engine.placement.get().phase).toBe('picking')
    h.engine.placement.cancel('esc')
    expect(h.engine.placement.get()).toEqual({ phase: 'idle' })
    h.engine.placement.cancel('again')
    expect(h.typed('placement:end')).toHaveLength(1)
  })

  test('a reply composer inherits the thread kind and appends instead of creating', async () => {
    const h = await scene()
    const id = await h.seed('#a', 'first', { kind: 'ask' })
    h.events.length = 0

    expect(h.engine.placement.start(undefined, { threadId: id })).toBe(true)
    expect(h.engine.placement.get()).toMatchObject({ kind: 'ask', replyTo: id })
    const result = await h.engine.placement.submit('a reply')
    expect(result.kind).toBe('replied')
    expect(h.names()).toEqual(['placement:start', 'thread:reply', 'placement:end'])
  })
})

describe('§2.12 user-flow rejections are not errors', () => {
  test('start() while composing emits placement:rejected(busy) and NO error', async () => {
    const h = await scene()
    h.engine.placement.start('comment', { element: h.page.document.querySelector('#a')! })
    h.events.length = 0
    expect(
      h.engine.placement.start('comment', { element: h.page.document.querySelector('#b')! }),
    ).toBe(false)
    expect(h.typed('placement:rejected')[0]!.payload).toEqual({ kind: 'comment', reason: 'busy' })
    expect(h.typed('error')).toHaveLength(0)
  })

  test('a hover trigger with nothing hovered emits placement:rejected(no_target) and NO error', async () => {
    const h = await scene()
    expect(h.engine.startPlacement('ask')).toBe(false)
    expect(h.typed('placement:rejected')[0]!.payload).toEqual({ kind: 'ask', reason: 'no_target' })
    expect(h.typed('error')).toHaveLength(0)
  })

  test('§4.1 row 17: an unknown kind rejects AND emits error/unknown_kind', async () => {
    const h = await scene()
    expect(h.engine.startPlacement('nope')).toBe(false)
    expect(h.typed('placement:rejected')[0]!.payload).toEqual({
      kind: 'nope',
      reason: 'unknown_kind',
    })
    expect(h.typed('error')[0]!.payload.error.code).toBe('unknown_kind')
    expect(h.typed('error')[0]!.payload.phase).toBe('placement')
  })

  test('§4.1 row 17: kind is opaque — the domain never validates it against modes', async () => {
    const h = await scene()
    const id = await h.seed('#a', 'first', { kind: 'not-a-mode' })
    expect(h.engine.getThreadView(id)!.kind).toBe('not-a-mode')
  })
})

describe('§4.5 triggers', () => {
  test("a bare-letter trigger enters picking and emits placement:start('pick')", async () => {
    const h = await scene()
    key(h.page.document, 'c')
    expect(h.engine.placement.get()).toMatchObject({ phase: 'picking', kind: 'comment' })
    expect(h.typed('placement:start')[0]!.payload).toEqual({ kind: 'comment', interaction: 'pick' })
  })

  test('the trigger key is matched case-insensitively', async () => {
    const h = await scene()
    key(h.page.document, 'C')
    expect(h.engine.placement.get().phase).toBe('picking')
  })

  test('a bare-letter trigger is ignored in an input, a textarea and a contenteditable', async () => {
    const h = await scene()
    key(h.page.document, 'c', {}, h.page.document.querySelector('#field')!)
    expect(h.engine.placement.get().phase).toBe('idle')
    key(h.page.document, 'c', {}, h.page.document.querySelector('#editable')!)
    expect(h.engine.placement.get().phase).toBe('idle')
  })

  test('a trigger with a modifier bypasses the editable guard', async () => {
    const h = await scene()
    key(h.page.document, 'm', { shiftKey: true }, h.page.document.querySelector('#field')!)
    expect(h.engine.placement.get()).toMatchObject({ phase: 'picking', kind: 'meta' })
  })

  test('modifiers must match exactly — a bare press does not fire a modified trigger', async () => {
    const h = await scene()
    key(h.page.document, 'm')
    expect(h.engine.placement.get().phase).toBe('idle')
  })

  test('a second press of the same trigger key cancels', async () => {
    const h = await scene()
    key(h.page.document, 'c')
    key(h.page.document, 'c')
    expect(h.engine.placement.get()).toEqual({ phase: 'idle' })
    expect(h.typed('placement:end')[0]!.payload.reason).toBe('cancelled')
  })

  test('Esc cancels placement', async () => {
    const h = await scene()
    key(h.page.document, 'c')
    key(h.page.document, 'Escape')
    expect(h.engine.placement.get()).toEqual({ phase: 'idle' })
  })

  test('picking: mousemove tracks the candidate and a click places on it', async () => {
    const h = await scene()
    key(h.page.document, 'c')
    const target = h.page.document.querySelector('#b')!
    mouse(h.page.document, 'mousemove', target)
    expect(h.engine.placement.get()).toMatchObject({ phase: 'picking', candidate: target })

    mouse(h.page.document, 'click', target)
    expect(h.engine.placement.get()).toMatchObject({ phase: 'composing', element: target })
  })

  test("interaction 'hover' places immediately on the last hovered element", async () => {
    const h = await scene()
    mouse(h.page.document, 'mouseover', h.page.document.querySelector('#b')!)
    key(h.page.document, 'a')
    expect(h.engine.placement.get()).toMatchObject({
      phase: 'composing',
      kind: 'ask',
      element: h.page.document.querySelector('#b'),
    })
    expect(h.typed('placement:start')[0]!.payload.interaction).toBe('hover')
  })

  test('trigger: false attaches no listener; only startPlacement(kind) works', async () => {
    const h = await scene()
    key(h.page.document, 't')
    expect(h.engine.placement.get().phase).toBe('idle')
    expect(h.engine.startPlacement('triage')).toBe(true)
    expect(h.engine.placement.get()).toMatchObject({ phase: 'picking', kind: 'triage' })
  })

  test('§4.5 selection wins: a non-collapsed selection skips picking for BOTH pick and hover', async () => {
    const h = await scene()
    const doc = h.page.document
    for (const [k, kind] of [
      ['c', 'comment'],
      ['a', 'ask'],
    ] as const) {
      const node = doc.querySelector('#a')!.firstChild!
      const range = doc.createRange()
      range.setStart(node, 0)
      range.setEnd(node, 5)
      const selection = doc.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)

      key(doc, k)
      expect(h.engine.placement.get()).toMatchObject({ phase: 'composing', kind, mode: 'text' })
      h.engine.placement.cancel()
      selection.removeAllRanges()
    }
  })

  test('setModes re-registers triggers, cancels in-flight placement, and keeps threads', async () => {
    const h = await scene()
    const id = await h.seed('#a')
    key(h.page.document, 'c')
    expect(h.engine.placement.get().phase).toBe('picking')

    h.engine.setModes([{ kind: 'note', trigger: { key: 'n' } }])
    expect(h.engine.placement.get()).toEqual({ phase: 'idle' })
    expect(h.engine.modes.map((m) => m.kind)).toEqual(['note'])
    expect(h.engine.getThreadView(id)).not.toBeNull() // threads survive their mode's removal

    key(h.page.document, 'c')
    expect(h.engine.placement.get().phase).toBe('idle') // the old binding is gone
    key(h.page.document, 'n')
    expect(h.engine.placement.get()).toMatchObject({ phase: 'picking', kind: 'note' })
  })

  test('§4.5 placement is cancelled on page:change and on destroy()', async () => {
    const h = await scene()
    h.engine.placement.start('comment', { element: h.page.document.querySelector('#a')! })
    await h.page.navigate('https://example.com/elsewhere')
    expect(h.engine.placement.get()).toEqual({ phase: 'idle' })

    h.engine.placement.start('comment', { element: h.page.document.querySelector('#a')! })
    h.engine.destroy()
    expect(h.engine.placement.get()).toEqual({ phase: 'idle' })
  })
})
