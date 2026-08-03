/**
 * The positioning lifecycle behind a surface — the half of §3.1.5's coordinate contract that no
 * assertion on a model can see, because a badge at stale coordinates has exactly the same
 * `BadgeVM` as one at correct coordinates.
 *
 * The positioner is mocked here (and only here) so every tracker start and cleanup is countable,
 * keyed by the reference it was started against.
 *
 * **These cases mount the probe rather than `presentation: null`, and that is not a loophole.**
 * A tracker exists per node registered through `host.anchor()`, so a mount with no presentation
 * has, by construction, zero trackers and nothing to assert. The probe draws nothing, asserts
 * nothing and queries nothing: it hands the controller one bare `<div>` per surface, which is
 * the minimum a presentation must do to participate in positioning at all.
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
  computePosition: () => Promise.resolve({ x: 0, y: 0, placement: 'top-end' }),
  offset: () => ({ name: 'offset', fn: () => ({}) }),
  flip: () => ({ name: 'flip', fn: () => ({}) }),
  shift: () => ({ name: 'shift', fn: () => ({}) }),
}))

const { fakeIntersectionObserver, probePresentation, scene, tick } = await import('../support.ts')

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

async function boot() {
  const probe = probePresentation({ anchor: true })
  const s = await scene(PAGE, {
    ui: { panel: { defaultOpen: true }, presentation: probe.presentation },
  })
  cleanup.push(s.dispose)
  return { ...s, probe }
}

describe('a badge that is pinned while off-screen', () => {
  test('gets its tracker back — the popover anchors to it', async () => {
    const io = fakeIntersectionObserver()
    try {
      const s = await boot()
      const id = await s.seed('#a')
      const element = s.doc.querySelector('#a')!
      expect(trackers.liveFor(element)).toBe(1)

      // Off screen: the tracker is torn down on purpose (that is the whole point of the skip).
      io.set(element, false)
      await tick()
      expect(trackers.liveFor(element)).toBe(0)

      // The panel is how an off-screen thread is reached. Opening it un-pins the badge and
      // anchors the popover to it — with no tracker, both sit at their last coordinates
      // forever, because the observer callback (the only other place a tracker is restarted)
      // never fires for a click.
      s.intents.openThread(id)
      await tick()
      expect(s.vm().badges[0]?.offscreen).toBe(false)
      expect(trackers.liveFor(element)).toBe(1)
      // …and the popover tracks the badge's node, so the chain is unbroken end to end.
      expect(trackers.liveFor(s.probe.nodes.get(`badge:${id}`))).toBe(1)
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
      await tick()
      s.intents.openThread(id)
      await tick()
      expect(trackers.liveFor(element)).toBe(1)

      // Closing the popover must not leave a frame loop running for a badge nobody can see.
      s.intents.closeThread()
      await tick()
      expect(s.vm().badges[0]?.offscreen).toBe(true)
      expect(trackers.liveFor(element)).toBe(0)
    } finally {
      io.restore()
    }
  })

  test('an unrelated render pass still does not restart a tracker for a hidden badge', async () => {
    const io = fakeIntersectionObserver()
    try {
      const s = await boot()
      await s.seed('#a')
      const other = await s.seed('#b')
      const element = s.doc.querySelector('#a')!
      io.set(element, false)
      await tick()
      const started = trackers.starts(element)

      await s.engine.appendComment(other, { author: 'user', body: 'noise' })
      await s.settle()
      expect(trackers.starts(element)).toBe(started)
      expect(trackers.liveFor(element)).toBe(0)
    } finally {
      io.restore()
    }
  })

  test('the controller writes left/top and data-placement, and samples it back', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    const node = s.probe.nodes.get(`badge:${id}`)
    // §3.1.5: coordinates and `data-placement` are written by the controller, on the node the
    // presentation merely handed over.
    expect(node?.style.left).toBe('0px')
    expect(node?.style.top).toBe('0px')
    expect(node?.getAttribute('data-placement')).toBe('top-end')

    // `BadgeVM.placement` is *sampled* at publication, never pushed: the frame loop resolves a
    // placement every animation frame, and republishing the model that often would turn a
    // positioning detail into a render storm.
    expect(s.vm().badges[0]?.placement).toBeNull()
    s.ui.decorate('unrelated', { tone: 'muted' })
    await tick()
    expect(s.vm().badges[0]?.placement).toBe('top-end')
  })
})

describe('teardown', () => {
  test('unmount leaves no live tracker behind', async () => {
    const probe = probePresentation({ anchor: true })
    const s = await scene(PAGE, {
      ui: { panel: { defaultOpen: true }, presentation: probe.presentation },
    })
    const id = await s.seed('#a')
    s.ui.focus(id)
    await tick()
    expect(trackers.entries.some((entry) => entry.alive)).toBe(true)

    await s.dispose()
    expect(trackers.entries.filter((entry) => entry.alive)).toEqual([])
  })
})
