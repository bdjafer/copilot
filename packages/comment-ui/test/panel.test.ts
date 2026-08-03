/**
 * §3 / PLAN §3.3 panel: the corner surface where the two page-invisible states stay reachable
 * — resolved (badge hidden, reopenable) and unanchored (element gone). Section assignment is
 * total and exclusive; `pending` is in none of them.
 */

import { afterEach, describe, expect, test } from 'vitest'

import { $, $$, click, scene, tick } from './support.ts'

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
  const section = (name: string): HTMLElement | null => $(s.root, `[data-section="${name}"]`)
  const rows = (name: string): HTMLElement[] => $$(section(name)!, '.cc-row')
  return { ...s, section, rows }
}

describe('structure', () => {
  test('is a named region with one heading-labelled list per section', async () => {
    const s = await boot()
    const panel = $(s.root, '.cc-panel')!
    expect(panel.tagName).toBe('SECTION')
    expect(panel.getAttribute('role')).toBe('region')
    expect(panel.getAttribute('aria-label')).toBe('Comments')
    expect($(panel, 'h2')?.textContent).toBe('Comments')

    for (const name of ['open', 'resolved', 'unanchored']) {
      const wrapper = s.section(name)!
      const heading = $(wrapper, 'h3')!
      const list = $(wrapper, 'ul')!
      expect(list.getAttribute('aria-labelledby')).toBe(heading.id)
      expect(heading.id).not.toBe('')
    }
  })

  test('the sections option selects which sections exist', async () => {
    const s = await boot({ ui: { panel: { sections: ['open'] } } })
    expect($$(s.root, '.cc-section')).toHaveLength(1)
    expect(s.section('resolved')).toBeNull()
  })

  test('panel.enabled false renders no panel and no toggle', async () => {
    const s = await boot({ ui: { panel: { enabled: false } } })
    expect($(s.root, '.cc-panel')).toBeNull()
    expect($(s.root, '.cc-panel-toggle')).toBeNull()
    s.ui.panel.open()
    expect(s.ui.panel.isOpen).toBe(false)
  })

  test('corner is reflected on the panel and its toggle', async () => {
    const s = await boot({ ui: { panel: { corner: 'tl' } } })
    expect($(s.root, '.cc-panel')?.getAttribute('data-corner')).toBe('tl')
    expect($(s.root, '.cc-panel-toggle')?.getAttribute('data-corner')).toBe('tl')
  })
})

describe('open / close', () => {
  test('defaultOpen and the toggle button agree with panel.isOpen', async () => {
    const s = await boot()
    expect(s.ui.panel.isOpen).toBe(false)
    expect($(s.root, '.cc-panel')?.getAttribute('data-open')).toBe('false')
    expect($(s.root, '.cc-panel-toggle')?.getAttribute('aria-expanded')).toBe('false')

    click($(s.root, '.cc-panel-toggle'))
    await tick()
    expect(s.ui.panel.isOpen).toBe(true)
    expect($(s.root, '.cc-panel')?.getAttribute('data-open')).toBe('true')
    expect($(s.root, '.cc-panel-toggle')?.getAttribute('aria-expanded')).toBe('true')

    s.ui.panel.toggle()
    await tick()
    expect(s.ui.panel.isOpen).toBe(false)
  })

  test('open(section) marks that section current', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    s.ui.panel.open('resolved')
    await tick()
    expect(s.section('resolved')?.getAttribute('data-current')).toBe('true')
    expect(s.section('open')?.getAttribute('data-current')).toBe('false')
  })

  test('open(section) ignores a section this panel does not render', async () => {
    const s = await boot({ ui: { panel: { sections: ['open'] } } })
    s.ui.panel.open('resolved')
    await tick()
    expect(s.ui.panel.isOpen).toBe(true)
    expect(s.section('open')?.getAttribute('data-current')).toBe('true')
  })

  test('close() is a no-op when already closed', async () => {
    const s = await boot()
    s.ui.panel.close()
    expect(s.ui.panel.isOpen).toBe(false)
  })
})

describe('section assignment is total and exclusive', () => {
  test('open / resolved / unanchored each get exactly their thread', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const open = await s.seed('#a', 'still open')
    const resolved = await s.seed('#b', 'done with this')
    const orphan = await s.seed('#c', 'element is gone')
    await s.engine.resolve(resolved)
    await s.page.mutate((doc) => {
      doc.querySelector('#c')?.remove()
    })
    await s.settle()

    expect(s.rows('open').map((row) => row.getAttribute('data-thread'))).toEqual([open])
    expect(s.rows('resolved').map((row) => row.getAttribute('data-thread'))).toEqual([resolved])
    expect(s.rows('unanchored').map((row) => row.getAttribute('data-thread'))).toEqual([orphan])
  })

  test('resolved wins over orphaned — one thread is never listed twice', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    await s.engine.resolve(id)
    await s.page.mutate((doc) => {
      doc.querySelector('#a')?.remove()
    })
    await s.settle()
    expect($$(s.root, `.cc-row[data-thread="${id}"]`)).toHaveLength(1)
    expect(s.rows('resolved')).toHaveLength(1)
    expect(s.rows('unanchored')).toHaveLength(0)
  })

  test('each section shows its own count and empty label', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    expect($(s.section('open')!, '.cc-empty')?.hasAttribute('hidden')).toBe(false)
    expect($(s.section('open')!, '.cc-empty')?.textContent).toBe('No open comments on this page.')
    expect($(s.section('resolved')!, '.cc-empty')?.textContent).toBe('No resolved comments.')
    expect($(s.section('unanchored')!, '.cc-empty')?.textContent).toBe('Nothing unanchored.')

    await s.seed('#a')
    expect($(s.section('open')!, 'h3')?.textContent).toContain('(1)')
    expect($(s.section('open')!, '.cc-empty')?.hasAttribute('hidden')).toBe(true)
    expect($(s.root, '.cc-panel-toggle .cc-badge-count')?.textContent).toBe('1')
  })
})

describe('rows', () => {
  test('a row shows the mode, the count and the latest body, and focuses on click', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a', 'the first thing')
    await s.engine.appendComment(id, { author: 'copilot', body: 'the latest thing' })
    await s.settle()

    const row = s.rows('open')[0]!
    expect($(row, '.cc-row-kind')?.textContent).toBe('comment (2)')
    expect($(row, '.cc-row-body')?.textContent).toBe('the latest thing')
    expect($(row, '.cc-row-main')?.getAttribute('aria-label')).toBe('comment (2)')

    click($(row, '.cc-row-main'))
    await tick()
    expect($(s.root, '.cc-thread')?.getAttribute('data-thread')).toBe(id)
  })

  test('a resolved row reopens; an unanchored row discards', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const resolved = await s.seed('#a')
    const orphan = await s.seed('#b')
    await s.engine.resolve(resolved)
    await s.page.mutate((doc) => {
      doc.querySelector('#b')?.remove()
    })
    await s.settle()

    click($(s.rows('resolved')[0]!, '[data-action="reopen"]'))
    await s.settle()
    expect(s.engine.getThreadView(resolved)?.isResolved).toBe(false)

    click($(s.rows('unanchored')[0]!, '[data-action="delete"]'))
    await s.settle()
    expect(s.engine.getThreadView(orphan)).toBeNull()
  })

  test('an open row carries no destructive action', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    await s.seed('#a')
    expect($(s.rows('open')[0]!, '.cc-row-actions button')).toBeNull()
  })

  test('rows are reused across renders, so a focused row survives', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    const row = s.rows('open')[0]!
    await s.engine.appendComment(id, { author: 'user', body: 'again' })
    await s.settle()
    expect(s.rows('open')[0]).toBe(row)
  })
})
