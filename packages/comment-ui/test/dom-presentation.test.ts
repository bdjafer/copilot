/**
 * §3.1.8 / decision log #38 — `domPresentation` is **frozen**, and these four cases exist
 * precisely to fail when someone "improves" its markup.
 *
 * Everything else about the default appearance is covered contract-level by
 * `presentationConformance` and rule-level by the controller suite. What is left here is the
 * compatibility surface itself: the class names, the `data-action` hooks and the
 * `commentUIStyles` sheet that a host may already be styling from its own page. Those are a
 * promise, not an implementation detail, so they get a test that is *allowed* to be brittle.
 */

import { afterEach, describe, expect, test } from 'vitest'

import { commentUIStyles } from '../src/index.ts'
import { $, $$, click, domScene } from './support.ts'

const PAGE =
  '<article id="a" data-testid="a">alpha text</article><div id="b" data-testid="b">beta</div>'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  document.querySelectorAll('[data-comment-ui]').forEach((node) => {
    node.remove()
  })
})

async function boot(options?: Parameters<typeof domScene>[1]) {
  const s = await domScene(PAGE, { ui: { panel: { defaultOpen: true } }, ...options })
  cleanup.push(s.dispose)
  return s
}

describe('the frozen markup', () => {
  test('the badge keeps its class names, data hooks and internal structure', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'x', { kind: 'ask' })
    const badge = $(s.root, `.cc-badge[data-thread="${id}"]`)
    expect(badge?.tagName).toBe('BUTTON')
    expect(badge?.getAttribute('data-anchor')).toBe('anchored')
    expect(badge?.getAttribute('data-status')).toBe('open')
    expect(badge?.getAttribute('data-kind')).toBe('ask')
    expect(badge?.getAttribute('data-tone')).toBe('default')
    expect($(badge!, '.cc-badge-icon')?.textContent).toBe('?')
    expect($(badge!, '.cc-badge-count')?.textContent).toBe('1')
    expect($(badge!, '.cc-badge-marks')?.getAttribute('aria-hidden')).toBe('true')
    expect($(badge!, '.cc-chip-slot')?.getAttribute('aria-live')).toBe('polite')

    // The default glyph for a mode with no icon is still 💬.
    const plain = await s.seed('#b')
    expect($($(s.root, `.cc-badge[data-thread="${plain}"]`)!, '.cc-badge-icon')?.textContent).toBe(
      '💬',
    )
  })

  test('the popovers, the picker and the panel keep their class names and data-actions', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.focus(id)
    s.engine.placement.start('comment', { element: s.doc.querySelector('#b')! })
    await s.settle()

    expect($(s.root, '.cc-thread.cc-float')?.getAttribute('popover')).toBe('manual')
    expect($(s.root, '.cc-thread')?.getAttribute('data-open')).toBe('true')
    expect($(s.root, '.cc-composer.cc-float')?.getAttribute('data-open')).toBe('true')
    expect($(s.root, '.cc-composer-input')?.tagName).toBe('TEXTAREA')
    for (const action of ['close', 'reply', 'resolve', 'delete']) {
      expect($(s.root, `.cc-thread [data-action="${action}"]`)).not.toBeNull()
    }
    expect($(s.root, '.cc-thread [data-role="status"]')?.getAttribute('data-action')).toBe(
      'resolve',
    )
    for (const action of ['send', 'dismiss']) {
      expect($(s.root, `.cc-composer [data-action="${action}"]`)).not.toBeNull()
    }
    expect($(s.root, '.cc-picker')?.hasAttribute('hidden')).toBe(true)
    expect($(s.root, '.cc-pick-hint')?.hasAttribute('hidden')).toBe(true)
    expect($(s.root, '.cc-panel')?.tagName).toBe('SECTION')
    expect($(s.root, '.cc-panel-toggle')?.getAttribute('data-corner')).toBe('br')
    expect($$(s.root, '.cc-section').map((node) => node.getAttribute('data-section'))).toEqual([
      'open',
      'resolved',
      'unanchored',
    ])
    expect($(s.root, '.cc-row .cc-row-main')).not.toBeNull()
    expect($(s.root, '.cc-row .cc-row-kind')?.textContent).toBe('comment (1)')
    expect($(s.root, '.cc-row .cc-row-body')?.textContent).toBe('first comment')
  })

  test('the comment list and the inline editor keep their structure', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'typo heer')
    s.ui.focus(id)
    await s.settle()

    expect($(s.root, '.cc-comment .cc-author')?.getAttribute('data-author')).toBe('user')
    expect($(s.root, '.cc-comment .cc-time')?.tagName).toBe('TIME')
    expect($(s.root, '.cc-comment .cc-body')?.textContent).toBe('typo heer')

    click($(s.root, '.cc-comment [data-action="edit"]'))
    await s.settle()
    const input = $(s.root, '.cc-edit textarea') as HTMLTextAreaElement | null
    expect(input?.value).toBe('typo heer')
    expect(s.root.activeElement).toBe(input)
    expect($(s.root, '.cc-edit [data-action="save"]')).not.toBeNull()
    expect($(s.root, '.cc-edit [data-action="cancel-edit"]')).not.toBeNull()

    click($(s.root, '.cc-edit [data-action="cancel-edit"]'))
    await s.settle()
    expect($(s.root, '.cc-edit')).toBeNull()
    expect($(s.root, '.cc-comment .cc-body')?.textContent).toBe('typo heer')
  })

  test('the sheet is injected as `data-cc="base"` and is byte-identical to the export', async () => {
    const s = await boot({ ui: { css: '.cc-badge { font-weight: 600 }' } })
    const sheets = $$(s.root, 'style')
    expect(sheets.map((node) => node.getAttribute('data-cc'))).toEqual(['vars', 'base', 'custom'])
    expect(sheets[1]?.textContent).toBe(commentUIStyles)
    expect(sheets[2]?.textContent).toBe('.cc-badge { font-weight: 600 }')
    // The two rules the sheet carries that no computed style in this DOM can prove.
    expect(commentUIStyles).toMatch(/\.cc-layer\s*\{[^}]*pointer-events:\s*none/)
    expect(commentUIStyles).toMatch(/\.cc-layer\s*>\s*\*\s*\{\s*pointer-events:\s*auto/)
    expect(commentUIStyles).toMatch(
      /\.cc-picker,\s*\.cc-pick-hint,\s*\.cc-status\s*\{\s*pointer-events:\s*none/,
    )
    expect(commentUIStyles).toMatch(
      /\.cc-layer\[data-picking='true'\]\s*>\s*\*\s*\{\s*pointer-events:\s*none/,
    )
  })
})
