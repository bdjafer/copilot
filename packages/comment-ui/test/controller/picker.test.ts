/**
 * §3 / PLAN §3.3 placement-mode highlight, asserted on `vm.picker`, plus the two things the
 * **controller** owns around it and no presentation may touch: `data-picking` on the layer and
 * the `role="status"` announcement.
 *
 * `.cc-layer` and `.cc-status` are the controller's own nodes — they exist with
 * `presentation: null` — so looking at them here does not make this a markup test.
 */

import { afterEach, describe, expect, test } from 'vitest'

import { $, probePresentation, scene, tick } from '../support.ts'

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

  test('the picker publishes the live point and the target confidence, and no overlay', async () => {
    const s = await boot()
    s.engine.startPlacement('comment')
    await tick()
    // `<body>` is a fatal rejection (SPEC §2.5), so this is the low-confidence branch exactly.
    s.doc.body.dispatchEvent(
      new (s.doc.defaultView as Window & typeof globalThis).MouseEvent('mousemove', {
        bubbles: true,
        composed: true,
        clientX: 640,
        clientY: 300,
      }),
    )
    await tick()
    expect(s.vm().picker).toMatchObject({
      kind: 'comment',
      confidence: 0,
      landmark: true,
      point: { x: 640, y: 300 },
    })
  })
})

/**
 * The placement cursor (§3.1.4 `host.cursor`, decision log #46, DESIGN §0 D7 / §11 rule 7).
 *
 * This is a controller case rather than a conformance one because the thing under test is a
 * *lifetime*, not a rendering: the failure it exists to prevent is a comment cursor left on
 * somebody else's page after the pick is over.
 */
describe('the placement cursor, and the one thing that reaches the host document', () => {
  const CURSOR = 'url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E") 2 22, crosshair'
  const sheets = (doc: Document): unknown[] =>
    (doc as unknown as { adoptedStyleSheets: unknown[] }).adoptedStyleSheets

  test('one constructed sheet, and it is popped on Esc', async () => {
    const s = await boot({
      ui: { presentation: probePresentation({ cursor: CURSOR }).presentation },
    })
    expect(sheets(s.doc)).toHaveLength(0)

    // A `MutationObserver` on the host document must record NOTHING for the whole pick: that is
    // what "the host page's DOM is never mutated" means, literally (§11 rule 7).
    const records: MutationRecord[] = []
    const observer = new (s.doc.defaultView as unknown as typeof globalThis).MutationObserver(
      (list) => records.push(...list),
    )
    observer.observe(s.doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })

    s.engine.startPlacement('comment')
    await tick()
    expect(sheets(s.doc)).toHaveLength(1)

    s.engine.placement.cancel('escape')
    await tick()
    expect(sheets(s.doc)).toHaveLength(0)

    observer.takeRecords()
    expect(records.filter((record) => record.target !== s.root.host)).toHaveLength(0)
    observer.disconnect()
  })

  test('it is popped on page:change, and on unmount', async () => {
    const s = await boot({
      ui: { presentation: probePresentation({ cursor: CURSOR }).presentation },
    })
    s.engine.startPlacement('comment')
    await tick()
    expect(sheets(s.doc)).toHaveLength(1)
    await s.page.navigate('https://example.com/next')
    await s.settle()
    expect(sheets(s.doc)).toHaveLength(0)

    s.engine.startPlacement('comment')
    await tick()
    expect(sheets(s.doc)).toHaveLength(1)
    s.ui.unmount()
    expect(sheets(s.doc)).toHaveLength(0)
  })

  test('a presentation that throws mid-pick does not keep the page hostage', async () => {
    // The presentation can no longer be trusted to hand back `cursor(null)`, so the controller —
    // which owns the lifetime precisely for this reason — pops the sheet itself.
    let fail = false
    const probe = probePresentation({ cursor: CURSOR })
    const create = probe.presentation.create.bind(probe.presentation)
    const wrapped = {
      ...probe.presentation,
      create(host: Parameters<typeof create>[0], intents: Parameters<typeof create>[1]) {
        const instance = create(host, intents)
        return {
          update(vm: Parameters<typeof instance.update>[0]) {
            instance.update(vm)
            if (fail) throw new Error('probe: update failed')
          },
          destroy: () => {
            instance.destroy()
          },
        }
      },
    }
    const s = await boot({ ui: { presentation: wrapped, onError: () => {} } })
    s.engine.startPlacement('comment')
    await tick()
    expect(sheets(s.doc)).toHaveLength(1)

    fail = true
    s.ui.decorate('nobody', { chip: { text: 'x' } })
    await tick()
    expect(sheets(s.doc)).toHaveLength(0)
  })
})
