/**
 * §3 `decorate()` — the whole "copilot thinking" / "pending dispatch" / "run failed" surface,
 * driven **purely by data the host passes in**. The controller never learns what a copilot is:
 * these tests only ever hand it `{ text, tone, spinner }`, and what comes out is `ChipVM`.
 *
 * Lifecycle (normative): a decoration is dropped on that thread's `thread:delete` and the whole
 * map is cleared on `page:change`; it is otherwise sticky and has no TTL.
 */

import { afterEach, describe, expect, test } from 'vitest'

import { badgeOf, scene, tick } from '../support.ts'

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

describe('the chip model', () => {
  test('a chip appears on the badge and clears with null', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    expect(badgeOf(s.vm(), id)?.chip).toBeNull()

    s.ui.decorate(id, { chip: { text: 'pending', tone: 'neutral' } })
    await tick()
    expect(badgeOf(s.vm(), id)?.chip).toEqual({
      text: 'pending',
      tone: 'neutral',
      spinner: false,
    })

    s.ui.decorate(id, null)
    await tick()
    expect(badgeOf(s.vm(), id)?.chip).toBeNull()
  })

  test('tone and spinner default in the model, so no presentation has to', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.decorate(id, { chip: { text: 'bare' } })
    await tick()
    expect(badgeOf(s.vm(), id)?.chip).toEqual({ text: 'bare', tone: 'neutral', spinner: false })
  })

  test('the spinner is data-driven and reversible', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.decorate(id, { chip: { text: 'copilot', tone: 'busy', spinner: true } })
    await tick()
    expect(badgeOf(s.vm(), id)?.chip).toEqual({ text: 'copilot', tone: 'busy', spinner: true })

    s.ui.decorate(id, { chip: { text: 'copilot', tone: 'busy' } })
    await tick()
    expect(badgeOf(s.vm(), id)?.chip?.spinner).toBe(false)
  })

  test('every documented tone reaches the model verbatim', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    for (const tone of ['neutral', 'info', 'busy', 'warn', 'danger'] as const) {
      s.ui.decorate(id, { chip: { text: tone, tone } })
      await tick()
      expect(badgeOf(s.vm(), id)?.chip?.tone).toBe(tone)
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
    expect(badgeOf(s.vm(), id)).toMatchObject({ tone: 'muted', title: 'copilot run failed' })
  })

  test('a decoration with no chip still applies its tone', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.decorate(id, { tone: 'accent' })
    await tick()
    expect(badgeOf(s.vm(), id)).toMatchObject({ tone: 'accent', chip: null })
  })

  test('the same chip reaches the badge, the popover and the panel row', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    s.ui.decorate(id, { chip: { text: 'copilot', tone: 'busy', spinner: true } })
    s.ui.focus(id)
    await tick()
    const chip = { text: 'copilot', tone: 'busy', spinner: true }
    expect(badgeOf(s.vm(), id)?.chip).toEqual(chip)
    expect(s.vm().thread?.chip).toEqual(chip)
    expect(s.vm().panel?.sections.flatMap((section) => section.rows)[0]?.chip).toEqual(chip)
  })

  test('an explicit host title beats the approximate marker on the badge', async () => {
    const s = await boot({ engine: { anchoring: { scoring: () => 0.7 } } })
    const id = await s.seed('#a')
    await s.engine.reanchor(id)
    await s.settle()
    expect(badgeOf(s.vm(), id)?.title).toBe('Approximately re-anchored')
    s.ui.decorate(id, { title: 'copilot is thinking' })
    await tick()
    expect(badgeOf(s.vm(), id)?.title).toBe('copilot is thinking')
  })

  test('decorating an unknown thread is inert, and survives that thread arriving later', async () => {
    const s = await boot()
    s.ui.decorate('not-yet', { chip: { text: 'pending' }, tone: 'muted' })
    await tick()
    expect(s.vm().badges).toHaveLength(0)

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
    expect(badgeOf(s.vm(), 'not-yet')).toMatchObject({
      tone: 'muted',
      chip: { text: 'pending', tone: 'neutral', spinner: false },
    })
  })
})

describe('lifecycle', () => {
  test('a decoration is dropped on its thread deletion, and does not leak to a new thread', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.decorate(id, { chip: { text: 'copilot', tone: 'busy' } })
    await tick()
    expect(badgeOf(s.vm(), id)?.chip).not.toBeNull()

    await s.engine.delete(id)
    await s.settle()
    const revived = await s.seed('#a', 'a brand new thread')
    expect(revived).not.toBe(id)
    expect(badgeOf(s.vm(), revived)?.chip).toBeNull()
  })

  test('the whole map is cleared on page:change', async () => {
    const s = await boot()
    const first = await s.seed('#a')
    const second = await s.seed('#b')
    s.ui.decorate(first, { chip: { text: 'copilot' } })
    s.ui.decorate(second, { chip: { text: 'pending' } })
    await tick()
    expect(s.vm().badges.filter((badge) => badge.chip !== null)).toHaveLength(2)

    await s.page.navigate('https://example.com/other')
    await s.settle()
    expect(s.engine.listThreads()).toHaveLength(0)

    await s.page.navigate('https://example.com/doc')
    await s.settle()
    // The threads came back; a stale chip must NOT have survived the navigation.
    expect(s.engine.listThreads()).toHaveLength(2)
    expect(s.vm().badges.filter((badge) => badge.chip !== null)).toHaveLength(0)
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
    expect(badgeOf(s.vm(), id)?.chip?.text).toBe('copilot')
  })
})
