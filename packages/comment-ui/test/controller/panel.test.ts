/**
 * §3 / PLAN §3.3 panel, asserted on `vm.panel`: the corner surface where the two page-invisible
 * states stay reachable — resolved (badge hidden, reopenable) and unanchored (element gone).
 * Section assignment is total and exclusive; `pending` is in none of them.
 */

import { afterEach, describe, expect, test } from 'vitest'

import { rowsOf, scene, tick } from '../support.ts'

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

describe('structure', () => {
  test('publishes one section per configured id, labelled and with an empty string', async () => {
    const s = await boot()
    expect(s.vm().panel?.title).toBe('Comments')
    expect(s.vm().panel?.sections.map((section) => section.id)).toEqual([
      'open',
      'resolved',
      'unanchored',
    ])
    expect(s.vm().panel?.sections.map((section) => section.label)).toEqual([
      'Open',
      'Resolved',
      'Unanchored',
    ])
    expect(s.vm().panel?.sections.map((section) => section.empty)).toEqual([
      'No open comments on this page.',
      'No resolved comments.',
      'Nothing unanchored.',
    ])
  })

  test('the sections option selects which sections exist', async () => {
    const s = await boot({ ui: { panel: { sections: ['open'] } } })
    expect(s.vm().panel?.sections.map((section) => section.id)).toEqual(['open'])
  })

  test('panel.enabled false publishes no panel at all', async () => {
    const s = await boot({ ui: { panel: { enabled: false } } })
    expect(s.vm().panel).toBeNull()
    s.ui.panel.open()
    expect(s.ui.panel.isOpen).toBe(false)
  })

  test('corner is carried on the model', async () => {
    const s = await boot({ ui: { panel: { corner: 'tl' } } })
    expect(s.vm().panel?.corner).toBe('tl')
  })
})

describe('open / close', () => {
  test('defaultOpen and the toggle intent agree with panel.isOpen', async () => {
    const s = await boot()
    expect(s.ui.panel.isOpen).toBe(false)
    expect(s.vm().panel?.open).toBe(false)

    s.intents.togglePanel()
    await tick()
    expect(s.ui.panel.isOpen).toBe(true)
    expect(s.vm().panel?.open).toBe(true)

    s.ui.panel.toggle()
    await tick()
    expect(s.ui.panel.isOpen).toBe(false)
  })

  test('open(section) marks that section current', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    s.ui.panel.open('resolved')
    await tick()
    const current = s.vm().panel?.sections.filter((section) => section.current)
    expect(current?.map((section) => section.id)).toEqual(['resolved'])
  })

  test('open(section) ignores a section this panel does not render', async () => {
    const s = await boot({ ui: { panel: { sections: ['open'] } } })
    s.ui.panel.open('resolved')
    await tick()
    expect(s.ui.panel.isOpen).toBe(true)
    expect(s.vm().panel?.sections.filter((section) => section.current)).toHaveLength(1)
    expect(s.vm().panel?.sections[0]?.id).toBe('open')
  })

  test('selectSection moves the current section without touching open state', async () => {
    const s = await boot()
    s.intents.selectSection('unanchored')
    await tick()
    expect(s.ui.panel.isOpen).toBe(false)
    expect(s.vm().panel?.sections.find((section) => section.current)?.id).toBe('unanchored')
  })

  test('close() is a no-op when already closed', async () => {
    const s = await boot()
    const before = s.vm().seq
    s.ui.panel.close()
    await tick()
    expect(s.ui.panel.isOpen).toBe(false)
    expect(s.vm().seq).toBe(before)
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

    expect(rowsOf(s.vm(), 'open')).toEqual([open])
    expect(rowsOf(s.vm(), 'resolved')).toEqual([resolved])
    expect(rowsOf(s.vm(), 'unanchored')).toEqual([orphan])
  })

  test('resolved wins over orphaned — one thread is never listed twice', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    await s.engine.resolve(id)
    await s.page.mutate((doc) => {
      doc.querySelector('#a')?.remove()
    })
    await s.settle()
    expect(rowsOf(s.vm(), 'resolved')).toEqual([id])
    expect(rowsOf(s.vm(), 'unanchored')).toEqual([])
  })

  test('the total counts open threads only', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    await s.seed('#a')
    const resolved = await s.seed('#b')
    await s.engine.resolve(resolved)
    await s.settle()
    expect(s.vm().panel?.total).toBe(1)
  })
})

describe('rows', () => {
  test('a row carries the mode, the count, the latest body and the capture title', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a', 'the first thing')
    await s.engine.appendComment(id, { author: 'copilot', body: 'the latest thing' })
    await s.settle()

    const row = s.vm().panel?.sections.find((section) => section.id === 'open')?.rows[0]
    expect(row).toMatchObject({
      threadId: id,
      kind: 'comment',
      label: 'comment',
      ariaLabel: 'comment (2)',
      body: 'the latest thing',
      count: 2,
      anchor: 'anchored',
      status: 'open',
      action: null,
    })
    expect(row?.title).toContain('alpha text')
  })

  test('a resolved row offers reopen; an unanchored row offers delete', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const resolved = await s.seed('#a')
    const orphan = await s.seed('#b')
    await s.engine.resolve(resolved)
    await s.page.mutate((doc) => {
      doc.querySelector('#b')?.remove()
    })
    await s.settle()

    const action = (section: string): string | null | undefined =>
      s.vm().panel?.sections.find((entry) => entry.id === section)?.rows[0]?.action
    expect(action('resolved')).toBe('reopen')
    expect(action('unanchored')).toBe('delete')

    s.intents.reopenThread(resolved)
    await s.settle()
    expect(s.engine.getThreadView(resolved)?.isResolved).toBe(false)

    s.intents.deleteThread(orphan)
    await s.settle()
    expect(s.engine.getThreadView(orphan)).toBeNull()
  })

  test('rows are referentially stable across unrelated renders', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    await s.seed('#a')
    const before = s.vm().panel?.sections.find((section) => section.id === 'open')?.rows[0]
    s.ui.decorate('unrelated', { tone: 'muted' })
    await tick()
    const after = s.vm().panel?.sections.find((section) => section.id === 'open')?.rows[0]
    expect(after).toBe(before)
  })
})
