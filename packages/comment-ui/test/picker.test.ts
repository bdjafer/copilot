/**
 * §3 / PLAN §3.3 placement-mode highlight: an overlay drawn from `engine.placement`'s
 * `candidate`, never a mutation of the host page.
 */

import { afterEach, describe, expect, test } from 'vitest'

import { $, scene, tick } from './support.ts'

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
  test('is hidden while idle', async () => {
    const s = await boot()
    expect($(s.root, '.cc-picker')?.hasAttribute('hidden')).toBe(true)
    expect($(s.root, '.cc-pick-hint')?.hasAttribute('hidden')).toBe(true)
  })

  test('tracks the candidate the engine reports and announces the hint', async () => {
    const s = await boot()
    mouse(s.doc, 'mouseover', s.doc.querySelector('#a')!)
    expect(s.engine.startPlacement('comment')).toBe(true)
    await tick()

    expect(s.engine.placement.get()).toMatchObject({ phase: 'picking', kind: 'comment' })
    const box = $(s.root, '.cc-picker')!
    expect(box.hasAttribute('hidden')).toBe(false)
    expect(box.getAttribute('data-kind')).toBe('comment')
    expect($(s.root, '.cc-status')?.textContent).toBe(
      'Click an element to comment on it — Esc to cancel',
    )
    expect($(s.root, '.cc-pick-hint')?.textContent).toBe(
      'Click an element to comment on it — Esc to cancel',
    )
  })

  test('the overlay is inert to pointers and hidden from the a11y tree', async () => {
    const s = await boot()
    const box = $(s.root, '.cc-picker')!
    const hint = $(s.root, '.cc-pick-hint')!
    expect(box.getAttribute('aria-hidden')).toBe('true')
    expect(hint.getAttribute('aria-hidden')).toBe('true')
    // Asserted at the sheet, which happy-dom does not cascade.
    const { commentUIStyles } = await import('../src/styles.ts')
    // The HINT is the dangerous one: it is drawn 26px above the candidate, i.e. on the cursor's
    // way into it, and `.cc-layer > *` grants `auto` to every direct child of the layer. Left
    // out of this rule it becomes the engine's own `candidate` (which is `composedPath()[0]`,
    // unfiltered for shadow trees) and a click anchors the thread on comment-ui's shadow DOM.
    expect(commentUIStyles).toMatch(
      /\.cc-picker,\s*\.cc-pick-hint,\s*\.cc-status\s*\{\s*pointer-events:\s*none/,
    )
    expect(commentUIStyles).toMatch(
      /\.cc-layer\[data-picking='true'\]\s*>\s*\*\s*\{\s*pointer-events:\s*none/,
    )
  })

  test('every widget goes click-through while picking, and only while picking', async () => {
    // Same failure one level up: a badge, the panel or an open popover under the cursor is just
    // as pickable as the hint, and the engine cannot filter them out (it never learns the
    // shadow root exists). The layer is marked for the length of the pick instead.
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const layer = $(s.root, '.cc-layer')!
    expect(layer.hasAttribute('data-picking')).toBe(false)

    s.engine.startPlacement('comment')
    await tick()
    expect(layer.getAttribute('data-picking')).toBe('true')

    // Committing the pick (not just cancelling) has to clear it too, or the composer that
    // opens next would be click-through.
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    expect(s.engine.placement.get().phase).toBe('composing')
    expect(layer.hasAttribute('data-picking')).toBe(false)
  })

  test('re-entering placement announces the hint again', async () => {
    // `announce` is `setText`, which is idempotent — writing the same string a second time
    // changes no DOM and fires no live-region announcement. The status region is therefore
    // cleared when placement ends, which is what makes the second announcement real.
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
    s.engine.placement.cancel('escape')
    await tick()
    expect(status().textContent).toBe('')

    s.engine.startPlacement('comment')
    await tick()
    expect(status().textContent).toBe('Click an element to comment on it — Esc to cancel')
    observer.disconnect()
    expect(seen.filter((text) => text !== '')).toHaveLength(2)
  })

  test('disappears when placement leaves picking, and never touched the page', async () => {
    const s = await boot()
    const before = s.doc.body.innerHTML
    mouse(s.doc, 'mouseover', s.doc.querySelector('#a')!)
    s.engine.startPlacement('comment')
    await tick()
    expect($(s.root, '.cc-picker')?.hasAttribute('hidden')).toBe(false)
    expect(s.doc.body.innerHTML).toBe(before)

    s.engine.placement.cancel('esc')
    await tick()
    expect($(s.root, '.cc-picker')?.hasAttribute('hidden')).toBe(true)
    expect(s.doc.body.innerHTML).toBe(before)
  })

  test('picking with no candidate yet draws nothing', async () => {
    const s = await boot()
    s.engine.startPlacement('comment')
    await tick()
    expect(s.engine.placement.get()).toMatchObject({ phase: 'picking', candidate: null })
    expect($(s.root, '.cc-picker')?.hasAttribute('hidden')).toBe(true)
  })
})
