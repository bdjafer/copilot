/**
 * The `autoUpdate` lifecycle behind a badge — the half of §3's positioning contract that no
 * assertion on the DOM can see, because a badge at stale coordinates looks exactly like a badge
 * at correct ones under happy-dom.
 *
 * `@floating-ui/dom` is mocked here (and only here) so every tracker start and cleanup is
 * countable, keyed by the reference it was started against: the badge tracks its anchored
 * element, the popover tracks the badge.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'

const trackers = vi.hoisted(() => {
  const entries: Array<{ reference: unknown; floating: Element; alive: boolean }> = []
  return {
    entries,
    reset(): void {
      entries.length = 0
    },
    liveFor(reference: unknown): number {
      return entries.filter((entry) => entry.alive && entry.reference === reference).length
    },
    starts(reference: unknown): number {
      return entries.filter((entry) => entry.reference === reference).length
    },
  }
})

vi.mock('@floating-ui/dom', () => ({
  autoUpdate: (reference: unknown, floating: Element, update: () => void) => {
    const entry = { reference, floating, alive: true }
    trackers.entries.push(entry)
    update()
    return () => {
      entry.alive = false
    }
  },
  computePosition: () => Promise.resolve({ x: 0, y: 0 }),
  offset: () => ({ name: 'offset', fn: () => ({}) }),
  flip: () => ({ name: 'flip', fn: () => ({}) }),
  shift: () => ({ name: 'shift', fn: () => ({}) }),
}))

const { $, badgeOf, click, fakeIntersectionObserver, scene, tick } = await import('./support.ts')

const PAGE =
  '<article id="a" data-testid="a">alpha text</article><div id="b" data-testid="b">beta</div>'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  document.querySelectorAll('[data-comment-ui]').forEach((node) => {
    node.remove()
  })
  trackers.reset()
})

async function boot(options?: Parameters<typeof scene>[1]) {
  const s = await scene(PAGE, { ui: { panel: { defaultOpen: true } }, ...options })
  cleanup.push(s.dispose)
  return s
}

describe('a badge that is pinned while off-screen', () => {
  test('gets its tracker back — the popover anchors to it', async () => {
    const io = fakeIntersectionObserver()
    try {
      const s = await boot()
      const id = await s.seed('#a')
      const element = s.doc.querySelector('#a')!
      const badge = badgeOf(s.root, id)!
      expect(trackers.liveFor(element)).toBe(1)

      // Off screen: the tracker is torn down on purpose (that is the whole point of the skip).
      io.set(element, false)
      expect(trackers.liveFor(element)).toBe(0)
      expect(badge.hasAttribute('hidden')).toBe(true)

      // The panel is how an off-screen thread is reached. Opening it un-hides the badge and
      // anchors the popover to it — with no tracker, both sit at their last coordinates
      // forever, because the IntersectionObserver callback (the only other place a tracker is
      // restarted) never fires for a click.
      click($(s.root, `.cc-row[data-thread="${id}"] .cc-row-main`))
      await tick()
      expect(badgeOf(s.root, id)?.hasAttribute('hidden')).toBe(false)
      expect($(s.root, '.cc-thread')?.getAttribute('data-open')).toBe('true')
      expect(trackers.liveFor(element)).toBe(1)
      // …and the popover tracks the badge, so the chain is unbroken end to end.
      expect(trackers.liveFor(badgeOf(s.root, id))).toBe(1)
    } finally {
      io.restore()
    }
  })

  test('and loses it again when it is un-pinned while still off-screen', async () => {
    const io = fakeIntersectionObserver()
    try {
      const s = await boot()
      const id = await s.seed('#a')
      const element = s.doc.querySelector('#a')!
      io.set(element, false)
      click($(s.root, `.cc-row[data-thread="${id}"] .cc-row-main`))
      await tick()
      expect(trackers.liveFor(element)).toBe(1)

      // Closing the popover must not leave a frame loop running for a badge nobody can see.
      click(badgeOf(s.root, id))
      await tick()
      expect(badgeOf(s.root, id)?.hasAttribute('hidden')).toBe(true)
      expect(trackers.liveFor(element)).toBe(0)
    } finally {
      io.restore()
    }
  })

  test('an unrelated render pass still does not restart a tracker for a hidden badge', async () => {
    const io = fakeIntersectionObserver()
    try {
      const s = await boot()
      const id = await s.seed('#a')
      const other = await s.seed('#b')
      const element = s.doc.querySelector('#a')!
      io.set(element, false)
      const started = trackers.starts(element)

      await s.engine.appendComment(other, { author: 'user', body: 'noise' })
      await s.settle()
      expect(trackers.starts(element)).toBe(started)
      expect(trackers.liveFor(element)).toBe(0)
      expect(badgeOf(s.root, id)?.hasAttribute('hidden')).toBe(true)
    } finally {
      io.restore()
    }
  })
})

describe('teardown', () => {
  test('unmount leaves no live tracker behind', async () => {
    const s = await scene(PAGE, { ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    s.ui.focus(id)
    await tick()
    expect(trackers.entries.some((entry) => entry.alive)).toBe(true)

    await s.dispose()
    expect(trackers.entries.filter((entry) => entry.alive)).toEqual([])
  })
})
