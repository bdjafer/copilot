/**
 * §3 / PLAN §3.3 placement-mode highlight, asserted on `vm.picker`, plus the two things the
 * **controller** owns around it and no presentation may touch: `data-picking` on the layer and
 * the `role="status"` announcement.
 *
 * `.cc-layer` and `.cc-status` are the controller's own nodes — they exist with
 * `presentation: null` — so looking at them here does not make this a markup test.
 */

import { afterEach, describe, expect, test } from 'vitest'

import { $, scene, tick } from '../support.ts'

const PAGE =
  '<article id="a" data-testid="a">alpha text</article><div id="b" data-testid="b">beta</div>'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  document.querySelectorAll('[data-comment-ui]').forEach((node) => {
    node.remove()
  })
})

async function boot(options?: Parameters<typeof scene>[1]) {
  const s = await scene(PAGE, options)
  cleanup.push(s.dispose)
  return s
}

function mouse(doc: Document, type: string, target: Element): void {
  target.dispatchEvent(
    new (doc.defaultView as Window & typeof globalThis).MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  )
}

describe('placement highlight', () => {
  test('is absent while idle', async () => {
    const s = await boot()
    expect(s.vm().picker).toBeNull()
  })

  test('carries the kind, the candidate rect and the hint', async () => {
    const s = await boot()
    mouse(s.doc, 'mouseover', s.doc.querySelector('#a')!)
    expect(s.engine.startPlacement('comment')).toBe(true)
    await tick()

    expect(s.engine.placement.get()).toMatchObject({ phase: 'picking', kind: 'comment' })
    expect(s.vm().picker).toMatchObject({
      kind: 'comment',
      hint: 'Click an element to comment on it — Esc to cancel',
    })
    expect(s.vm().picker?.rect).not.toBeNull()
  })

  test('picking with no candidate yet publishes a null rect', async () => {
    const s = await boot()
    s.engine.startPlacement('comment')
    await tick()
    expect(s.engine.placement.get()).toMatchObject({ phase: 'picking', candidate: null })
    expect(s.vm().picker).toMatchObject({ kind: 'comment' })
    expect(s.vm().picker?.rect).toBeNull()
  })

  test('every widget goes click-through while picking, and only while picking', async () => {
    // The engine resolves the pick target from `composedPath()[0]` and cannot filter shadow
    // trees, so a badge, the panel or an open popover under the cursor is just as pickable as
    // the page. The layer is marked for the length of the pick instead — by the CONTROLLER, so
    // no presentation can forget it.
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const layer = $(s.root, '.cc-layer')!
    expect(layer.hasAttribute('data-picking')).toBe(false)

    s.engine.startPlacement('comment')
    await tick()
    expect(layer.getAttribute('data-picking')).toBe('true')

    // Committing the pick (not just cancelling) has to clear it too, or the composer that opens
    // next would be click-through.
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    expect(s.engine.placement.get().phase).toBe('composing')
    expect(layer.hasAttribute('data-picking')).toBe(false)
    expect(s.vm().picker).toBeNull()
  })

  test('re-entering placement announces the hint again', async () => {
    // `announce` is an idempotent text write — the same string a second time changes no DOM and
    // fires no live-region announcement. The region is therefore cleared when placement ends,
    // which is what makes the second announcement real.
    const s = await boot()
    const status = (): HTMLElement => $(s.root, '.cc-status')!
    const seen: string[] = []
    const observer = new (s.doc.defaultView as unknown as typeof globalThis).MutationObserver(
      () => {
        seen.push(status().textContent ?? '')
      },
    )
    observer.observe(status(), { characterData: true, childList: true, subtree: true })

    s.engine.startPlacement('comment')
    await tick()
    expect(s.vm().announce).toBe('Click an element to comment on it — Esc to cancel')
    s.engine.placement.cancel('escape')
    await tick()
    expect(status().textContent).toBe('')
    expect(s.vm().announce).toBe('')

    s.engine.startPlacement('comment')
    await tick()
    expect(status().textContent).toBe('Click an element to comment on it — Esc to cancel')
    observer.disconnect()
    expect(seen.filter((text) => text !== '')).toHaveLength(2)
  })

  test('the page is never touched, in or out of placement', async () => {
    const s = await boot()
    const before = s.doc.body.innerHTML
    mouse(s.doc, 'mouseover', s.doc.querySelector('#a')!)
    s.engine.startPlacement('comment')
    await tick()
    expect(s.vm().picker).not.toBeNull()
    expect(s.doc.body.innerHTML).toBe(before)

    s.engine.placement.cancel('esc')
    await tick()
    expect(s.vm().picker).toBeNull()
    expect(s.doc.body.innerHTML).toBe(before)
  })
})
