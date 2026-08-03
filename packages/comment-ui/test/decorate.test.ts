/**
 * §3 `decorate()` — the whole "copilot thinking" / "pending dispatch" / "run failed" surface,
 * driven **purely by data the host passes in**. `comment-ui` never learns what a copilot is:
 * these tests only ever hand it `{ text, tone, spinner }`.
 *
 * Lifecycle (normative): a decoration is dropped on that thread's `thread:delete` and the whole
 * map is cleared on `page:change`; it is otherwise sticky and has no TTL.
 */

import { afterEach, describe, expect, test } from 'vitest'

import { $, badgeOf, scene, tick } from './support.ts'

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

function chipOf(root: ParentNode, threadId: string): HTMLElement | null {
  return $(root, `.cc-badge[data-thread="${threadId}"] .cc-chip`)
}

describe('rendering', () => {
  test('a chip appears on the badge and clears with null', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    expect(chipOf(s.root, id)).toBeNull()

    s.ui.decorate(id, { chip: { text: 'pending', tone: 'neutral' } })
    await tick()
    expect(chipOf(s.root, id)?.textContent).toBe('pending')
    expect(chipOf(s.root, id)?.getAttribute('data-tone')).toBe('neutral')

    s.ui.decorate(id, null)
    await tick()
    expect(chipOf(s.root, id)).toBeNull()
  })

  test('the spinner is data-driven and reversible', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.decorate(id, { chip: { text: 'copilot', tone: 'busy', spinner: true } })
    await tick()
    expect($(chipOf(s.root, id)!, '.cc-spinner')).not.toBeNull()
    expect(chipOf(s.root, id)?.getAttribute('data-tone')).toBe('busy')
    expect(chipOf(s.root, id)?.textContent).toBe('copilot')

    s.ui.decorate(id, { chip: { text: 'copilot', tone: 'busy' } })
    await tick()
    expect($(chipOf(s.root, id)!, '.cc-spinner')).toBeNull()
  })

  test('every documented tone reaches the DOM verbatim', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    for (const tone of ['neutral', 'info', 'busy', 'warn', 'danger'] as const) {
      s.ui.decorate(id, { chip: { text: tone, tone } })
      await tick()
      expect(chipOf(s.root, id)?.getAttribute('data-tone')).toBe(tone)
    }
  })

  test('tone and title decorate the badge itself', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.decorate(id, {
      chip: { text: 'E_TIMEOUT', tone: 'warn' },
      tone: 'muted',
      title: 'copilot run failed',
    })
    await tick()
    const badge = badgeOf(s.root, id)!
    expect(badge.getAttribute('data-tone')).toBe('muted')
    expect(badge.getAttribute('title')).toBe('copilot run failed')
  })

  test('a decoration with no chip still applies its tone', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.decorate(id, { tone: 'accent' })
    await tick()
    expect(badgeOf(s.root, id)?.getAttribute('data-tone')).toBe('accent')
    expect(chipOf(s.root, id)).toBeNull()
  })

  test('chips live in an aria-live=polite region and repeat into panel and popover', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    s.ui.decorate(id, { chip: { text: 'copilot', tone: 'busy', spinner: true } })
    s.ui.focus(id)
    await tick()

    expect(
      $(s.root, `.cc-badge[data-thread="${id}"] .cc-chip-slot`)?.getAttribute('aria-live'),
    ).toBe('polite')
    expect($(s.root, '.cc-thread .cc-chip')?.textContent).toBe('copilot')
    expect($(s.root, '.cc-thread .cc-chip-slot')?.getAttribute('aria-live')).toBe('polite')
    expect($(s.root, `.cc-row[data-thread="${id}"] .cc-chip`)?.textContent).toBe('copilot')
  })

  test('decorating an unknown thread is inert, and survives that thread arriving later', async () => {
    const s = await boot()
    s.ui.decorate('not-yet', { chip: { text: 'pending' }, tone: 'muted' })
    await tick()
    expect($(s.root, '.cc-chip')).toBeNull()

    // "Sticky, no TTL" (§3) is what makes the copilot's own race safe: a host that decorates
    // from a dispatch edge before `createThread` has resolved must still get its chip. The
    // thread is created with that exact id — `CreateThreadInput.id` is the idempotency key.
    const target = s.doc.querySelector('#a')!
    const { captureTarget } = await import('@astrale-os/comment-core')
    const { anchor, capture } = captureTarget(target, { document: s.doc })
    await s.engine.createThread({
      pageKey: s.engine.pageKey,
      kind: 'comment',
      anchor,
      capture,
      author: 'user',
      body: 'arrived late',
      id: 'not-yet',
    })
    await s.settle()
    expect(chipOf(s.root, 'not-yet')?.textContent).toBe('pending')
    expect(badgeOf(s.root, 'not-yet')?.getAttribute('data-tone')).toBe('muted')
  })

  test('the panel row repeats the chip WITHOUT a second live region', async () => {
    // Documented narrowing of §3's "chips live in an aria-live region": one decoration renders
    // into up to three slots at once, and three live regions announce one transition three
    // times. The badge and the popover — the two the user is looking at — carry it; the panel
    // row is a silent duplicate.
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    s.ui.decorate(id, { chip: { text: 'copilot', tone: 'busy' } })
    await tick()
    const row = $(s.root, `.cc-row[data-thread="${id}"] .cc-chip-slot`)!
    expect($(row, '.cc-chip')?.textContent).toBe('copilot')
    expect(row.hasAttribute('aria-live')).toBe(false)
  })
})

describe('lifecycle', () => {
  test('a decoration is dropped on its thread deletion, and does not leak to a new thread', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.decorate(id, { chip: { text: 'copilot', tone: 'busy' } })
    await tick()
    expect(chipOf(s.root, id)).not.toBeNull()

    await s.engine.delete(id)
    await s.settle()
    const revived = await s.seed('#a', 'a brand new thread')
    expect(revived).not.toBe(id)
    expect(chipOf(s.root, revived)).toBeNull()
  })

  test('the whole map is cleared on page:change', async () => {
    const s = await boot()
    const first = await s.seed('#a')
    const second = await s.seed('#b')
    s.ui.decorate(first, { chip: { text: 'copilot' } })
    s.ui.decorate(second, { chip: { text: 'pending' } })
    await tick()
    expect($(s.root, '.cc-chip')).not.toBeNull()

    await s.page.navigate('https://example.com/other')
    await s.settle()
    expect(s.engine.listThreads()).toHaveLength(0)

    await s.page.navigate('https://example.com/doc')
    await s.settle()
    // The threads came back; a stale chip must NOT have survived the navigation.
    expect(s.engine.listThreads()).toHaveLength(2)
    expect($(s.root, '.cc-chip')).toBeNull()
  })

  test('decorations are otherwise sticky — no TTL, no clearing on unrelated renders', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.decorate(id, { chip: { text: 'copilot', tone: 'busy' } })
    await tick()
    for (let i = 0; i < 3; i += 1) {
      await s.engine.appendComment(id, { author: 'user', body: `noise ${String(i)}` })
      await s.settle()
    }
    expect(chipOf(s.root, id)?.textContent).toBe('copilot')
  })
})
