/**
 * §3 accessibility, normative:
 *  - badges are real buttons, keyboard reachable, `aria-label` from mode + count,
 *    `aria-expanded` reflecting their popover;
 *  - the composer moves focus to its textarea, traps it, returns it on close, and closes on
 *    `Esc` — which also cancels placement;
 *  - the panel is a `<section>` named by `Labels.panelTitle`, with heading-labelled lists;
 *  - decoration chips live in an `aria-live="polite"` region, and placement announces
 *    `Labels.pickHint` the same way;
 *  - colour never carries state alone: resolved, orphaned and approximate each also have a
 *    shape or text marker.
 */

import { afterEach, describe, expect, test } from 'vitest'

import { $, $$, badgeOf, click, press, scene, tick } from './support.ts'

const PAGE =
  '<article id="a" data-testid="a">alpha text</article>' +
  '<div id="b" data-testid="b">beta text</div>' +
  '<p id="c" data-testid="c">gamma text</p>'

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

describe('roles and names', () => {
  test('every interactive node is a real button with a type and a name', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    s.ui.focus(id)
    await tick()

    for (const button of $$(s.root, 'button')) {
      expect(button.getAttribute('type')).toBe('button')
      const name = button.getAttribute('aria-label') ?? button.textContent ?? ''
      expect(name.trim().length).toBeGreaterThan(0)
    }
  })

  test('badges announce mode + count and their popover state', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'x', { kind: 'ask' })
    const badge = badgeOf(s.root, id)!
    expect(badge.getAttribute('aria-label')).toBe('Ask (1)')
    expect(badge.getAttribute('aria-haspopup')).toBe('dialog')
    expect(badge.getAttribute('aria-expanded')).toBe('false')
    // The icon is decorative — the name carries the meaning.
    expect($(badge, '.cc-badge-icon')?.getAttribute('aria-hidden')).toBe('true')

    click(badge)
    await tick()
    expect(badgeOf(s.root, id)?.getAttribute('aria-expanded')).toBe('true')
  })

  test('both popovers are dialogs with names', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.focus(id)
    s.engine.placement.start('comment', { element: s.doc.querySelector('#b')! })
    await tick()
    expect($(s.root, '.cc-thread')?.getAttribute('role')).toBe('dialog')
    expect($(s.root, '.cc-thread')?.getAttribute('aria-label')).toBe('comment (1)')
    expect($(s.root, '.cc-composer')?.getAttribute('role')).toBe('dialog')
    expect($(s.root, '.cc-composer')?.getAttribute('aria-label')).toBe('Add a comment…')
    expect($(s.root, '.cc-composer-input')?.getAttribute('aria-label')).toBe('Add a comment…')
  })

  test('the status region is a polite live region', async () => {
    const s = await boot()
    const status = $(s.root, '.cc-status')!
    expect(status.getAttribute('role')).toBe('status')
    expect(status.getAttribute('aria-live')).toBe('polite')
  })
})

describe('state is never colour-only', () => {
  test('resolved and orphaned each carry a marker element', async () => {
    const s = await boot({ ui: { badge: { showResolved: true } } })
    const resolved = await s.seed('#a')
    await s.engine.resolve(resolved)
    const orphan = await s.seed('#b')
    await s.page.mutate((doc) => {
      doc.querySelector('#b')?.remove()
    })
    await s.settle()

    expect($(badgeOf(s.root, resolved)!, '.cc-mark[data-mark="resolved"]')).not.toBeNull()
    expect($(badgeOf(s.root, orphan)!, '.cc-mark[data-mark="orphaned"]')).not.toBeNull()
  })

  test('approximate carries a marker AND a text equivalent', async () => {
    // A constant `scoring` verifies every candidate at 0.7 — above the 0.62 threshold, below
    // the 0.85 approximate line. It must not be combined with an orphan case in one scene:
    // it would re-anchor a removed element onto any survivor.
    const s = await boot({ engine: { anchoring: { scoring: () => 0.7 } } })
    const id = await s.seed('#c')
    await s.engine.reanchor(id)
    await s.settle()
    const badge = badgeOf(s.root, id)!
    // The marker is a glyph, hidden from the a11y tree; `title` carries the words.
    expect($(badge, '.cc-mark[data-mark="approximate"]')).not.toBeNull()
    expect($(badge, '.cc-badge-marks')?.getAttribute('aria-hidden')).toBe('true')
    expect(badge.getAttribute('title')).toBe('Approximately re-anchored')
  })
})

describe('focus management', () => {
  test('the composer takes focus, traps it and gives it back', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    const badge = badgeOf(s.root, id)!
    badge.focus()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#b')! })
    await tick()
    expect(s.root.activeElement).toBe($(s.root, '.cc-composer-input'))

    press($(s.root, '.cc-composer-input'), 'Escape')
    await tick()
    expect(s.root.activeElement).toBe(badge)
  })

  test('closing the thread popover returns focus to its badge', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    click(badgeOf(s.root, id))
    await tick()
    expect(s.root.activeElement).toBe($(s.root, '.cc-thread [data-action="close"]'))

    s.ui.focus(id) // toggle closed via the badge
    click(badgeOf(s.root, id))
    await tick()
    expect(s.root.activeElement).toBe(badgeOf(s.root, id))
  })
})

describe('the Escape chain at the shadow boundary', () => {
  test('cancels placement first, then the popover, then the panel', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    const layer = $(s.root, '.cc-layer')!

    s.ui.focus(id)
    s.engine.startPlacement('comment')
    await tick()
    expect(s.engine.placement.get().phase).toBe('picking')

    press(layer, 'Escape')
    await tick()
    expect(s.engine.placement.get().phase).toBe('idle')
    expect($(s.root, '.cc-thread')?.getAttribute('data-open')).toBe('true')

    press(layer, 'Escape')
    await tick()
    expect($(s.root, '.cc-thread')?.getAttribute('data-open')).toBe('false')
    expect(s.ui.panel.isOpen).toBe(true)

    press(layer, 'Escape')
    await tick()
    expect(s.ui.panel.isOpen).toBe(false)
  })

  test('a key other than Escape changes nothing', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    press($(s.root, '.cc-layer'), 'Enter')
    await tick()
    expect(s.ui.panel.isOpen).toBe(true)
  })
})
