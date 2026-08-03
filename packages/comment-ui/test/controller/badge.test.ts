/**
 * §3 badge rules, asserted on `vm.badges`: `pending` renders nothing, resolved is hidden from
 * the page by default, orphaned docks at the last known rect, the approximate marker appears
 * below 0.85, badge chrome comes from `Mode.badge`, and off-screen badges are skipped.
 *
 * These were the most valuable tests in the old suite and they were never about selectors — they
 * were about the rules. Against the model they are also cheaper and faster.
 */

import type { ThreadView } from '@astrale-os/comment-core'

import { createMemoryStore } from '@astrale-os/comment-core'
import { afterEach, describe, expect, test } from 'vitest'

import type { ResolvedOptions } from '../../src/types.ts'

import { badgeVisible, sectionOf } from '../../src/controller/model.ts'
import { createCommentUIController } from '../../src/index.ts'
import { badgeOf, fakeIntersectionObserver, scene, tick } from '../support.ts'

/** A `ThreadView` in the one state no DOM emulator will hold still long enough to observe. */
function pendingView(): ThreadView {
  const comment = {
    id: 'c1',
    threadId: 't1',
    author: 'user' as const,
    body: 'hi',
    createdAt: '2026-01-01T00:00:00.000Z',
    editedAt: null,
  }
  return {
    id: 't1',
    v: 1,
    pageKey: 'k',
    kind: 'comment',
    anchor: {
      mode: 'element',
      selectors: [],
      fingerprint: { tag: 'div', stableClasses: [], attrs: {}, textDigest: '' },
    },
    capture: {
      outerHTML: '',
      text: '',
      cssPath: '',
      page: { url: '', title: '' },
      capturedAt: comment.createdAt,
    },
    status: 'open',
    resolvedAt: null,
    resolvedBy: null,
    createdAt: comment.createdAt,
    updatedAt: comment.createdAt,
    comments: [comment],
    anchoring: {
      status: 'pending',
      element: null,
      range: null,
      confidence: 0,
      via: null,
      rect: null,
    },
    isOrphaned: false,
    isResolved: false,
    lastComment: comment,
    lastActivityAt: comment.createdAt,
  }
}

function options(): ResolvedOptions {
  return {
    badge: { showResolved: false, orphaned: 'dock', offset: [6, -6], hideOffscreen: true },
  } as unknown as ResolvedOptions
}

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

describe('what gets a badge', () => {
  test('an anchored open thread yields one badge carrying its count and chrome', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    const badge = badgeOf(s.vm(), id)
    expect(badge).toMatchObject({
      threadId: id,
      kind: 'comment',
      anchor: 'anchored',
      count: 1,
      docked: false,
      resolved: false,
      orphaned: false,
      offscreen: false,
      open: false,
      tone: 'default',
    })

    await s.engine.appendComment(id, { author: 'copilot', body: 'reply' })
    await s.settle()
    expect(badgeOf(s.vm(), id)?.count).toBe(2)
  })

  test('Mode.badge supplies the icon and the accessible name', async () => {
    const s = await boot()
    const ask = await s.seed('#a', 'ask me', { kind: 'ask' })
    const plain = await s.seed('#b', 'plain')
    expect(badgeOf(s.vm(), ask)).toMatchObject({ icon: '?', label: 'Ask', ariaLabel: 'Ask (1)' })
    // A kind with no `Mode.badge` gets a null icon — the presentation draws its own glyph —
    // and falls back to the raw kind, never to a hard-coded word.
    expect(badgeOf(s.vm(), plain)).toMatchObject({
      icon: null,
      label: 'comment',
      ariaLabel: 'comment (1)',
    })
  })

  test('a thread whose kind left `modes` renders with default chrome', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'triage me', { kind: 'triage' })
    s.engine.setModes([{ kind: 'comment', trigger: { key: 'c' } }])
    await s.settle()
    expect(badgeOf(s.vm(), id)).toMatchObject({ ariaLabel: 'triage (1)', icon: null })
  })

  test('pending renders nothing — not a badge, not a panel row', () => {
    // §3, normative: on a cold load that is EVERY thread, for the length of the first
    // resolution pass. happy-dom reports `readyState: 'complete'`, so the engine closes that
    // window inside one microtask and the state is not reachable from an integration test —
    // the rule is therefore asserted where it is implemented, on the two predicates the model
    // consults.
    const view = pendingView()
    expect(badgeVisible(options(), view)).toBe(false)
    expect(sectionOf(view)).toBeNull()
    expect(
      badgeVisible(options(), { ...view, anchoring: { ...view.anchoring, status: 'anchored' } }),
    ).toBe(true)
  })

  test('a cold-started engine publishes an empty model before its first pass', async () => {
    const store = createMemoryStore()
    const seeded = await scene(PAGE, { engine: { store } })
    await seeded.seed('#a')
    seeded.ui.unmount()

    const cold = seeded.page.engine({ store, autoStart: false })
    const ui = createCommentUIController(cold, {
      panel: { defaultOpen: true },
      presentation: null,
    })
    cleanup.push(async () => {
      ui.unmount()
      cold.destroy()
      await seeded.page.dispose()
    })

    cold.start()
    expect(ui.vm.get().badges).toHaveLength(0)
    expect(ui.vm.get().panel?.sections.flatMap((section) => section.rows)).toHaveLength(0)

    await cold.ready()
    await seeded.page.flush()
    await tick()
    expect(ui.vm.get().badges).toHaveLength(1)
  })

  test('badges are published in document order, docked orphans last', async () => {
    const s = await boot()
    // Seeded bottom-up, so engine order and document order disagree.
    const third = await s.seed('#c')
    const first = await s.seed('#a')
    const second = await s.seed('#b')
    expect(s.vm().badges.map((badge) => badge.threadId)).toEqual([first, second, third])

    await s.page.mutate((doc) => {
      doc.querySelector('#a')?.remove()
    })
    await s.settle()
    expect(s.vm().badges.map((badge) => badge.threadId)).toEqual([second, third, first])
    expect(badgeOf(s.vm(), first)?.docked).toBe(true)
  })
})

describe('resolved', () => {
  test('is hidden from the page by default and shown with showResolved', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    await s.engine.resolve(id)
    await s.settle()
    expect(badgeOf(s.vm(), id)).toBeNull()

    const shown = await boot({ ui: { badge: { showResolved: true } } })
    const other = await shown.seed('#b')
    await shown.engine.resolve(other)
    await shown.settle()
    expect(badgeOf(shown.vm(), other)).toMatchObject({ resolved: true })
  })
})

describe('orphaned', () => {
  async function orphan(options?: Parameters<typeof scene>[1]) {
    const s = await boot(options)
    const id = await s.seed('#a', 'orphan me')
    await s.page.mutate((doc) => {
      doc.querySelector('#a')?.remove()
    })
    await s.settle()
    expect(s.engine.getThreadView(id)?.anchoring.status).toBe('orphaned')
    return { s, id }
  }

  test('dock (default) keeps a docked, flagged badge at the last known rect', async () => {
    const { s, id } = await orphan()
    expect(badgeOf(s.vm(), id)).toMatchObject({ anchor: 'orphaned', orphaned: true, docked: true })
    expect(badgeOf(s.vm(), id)?.rect).not.toBeNull()
  })

  test('panel-only removes the badge but keeps the panel row', async () => {
    const { s, id } = await orphan({ ui: { badge: { orphaned: 'panel-only' } } })
    expect(badgeOf(s.vm(), id)).toBeNull()
    const rows = s.vm().panel?.sections.find((section) => section.id === 'unanchored')?.rows ?? []
    expect(rows.map((row) => row.threadId)).toEqual([id])
  })

  test('hidden removes it from the page AND the panel', async () => {
    const { s, id } = await orphan({ ui: { badge: { orphaned: 'hidden' } } })
    expect(badgeOf(s.vm(), id)).toBeNull()
    expect(s.vm().panel?.sections.flatMap((section) => section.rows)).toHaveLength(0)
  })

  test('a returning element re-anchors the badge without a store write', async () => {
    const { s, id } = await orphan()
    const writes = s.store.writes
    await s.page.mutate((doc) => {
      const back = doc.createElement('article')
      back.id = 'a'
      back.setAttribute('data-testid', 'a')
      back.textContent = 'alpha text'
      doc.body.prepend(back)
    })
    await s.settle()
    expect(badgeOf(s.vm(), id)).toMatchObject({ anchor: 'anchored', docked: false })
    expect(s.store.writes).toBe(writes)
  })
})

describe('approximate re-anchoring', () => {
  test('marks the badge when confidence drops below 0.85', async () => {
    const s = await boot({ engine: { anchoring: { scoring: () => 0.7 } } })
    const id = await s.seed('#a')
    await s.engine.reanchor(id)
    await s.settle()
    expect(s.engine.getThreadView(id)?.anchoring.confidence).toBeLessThan(0.85)
    expect(badgeOf(s.vm(), id)).toMatchObject({
      approximate: true,
      title: 'Approximately re-anchored',
    })
  })
})

describe('off-screen skip', () => {
  test('an IntersectionObserver miss marks the badge offscreen; a hit clears it', async () => {
    const io = fakeIntersectionObserver()
    try {
      const s = await boot()
      const id = await s.seed('#a')
      const element = s.doc.querySelector('#a')!
      expect(io.observed.has(element)).toBe(true)

      io.set(element, false)
      await tick()
      expect(badgeOf(s.vm(), id)?.offscreen).toBe(true)
      io.set(element, true)
      await tick()
      expect(badgeOf(s.vm(), id)?.offscreen).toBe(false)
    } finally {
      io.restore()
    }
  })

  test('an off-screen badge survives unrelated render passes un-observed', async () => {
    const io = fakeIntersectionObserver()
    try {
      const s = await boot()
      const id = await s.seed('#a')
      const other = await s.seed('#b')
      const element = s.doc.querySelector('#a')!
      io.set(element, false)
      await tick()
      const observations = io.observeCalls()

      // Any unrelated store change re-runs the whole pass. It must NOT re-observe the element
      // or bring the hidden badge back.
      await s.engine.appendComment(other, { author: 'user', body: 'noise' })
      await s.settle()
      expect(badgeOf(s.vm(), id)?.offscreen).toBe(true)
      expect(io.observeCalls()).toBe(observations)
    } finally {
      io.restore()
    }
  })

  test('the active thread pins its badge on screen so its popover stays anchored', async () => {
    const io = fakeIntersectionObserver()
    try {
      const s = await boot()
      const id = await s.seed('#a')
      s.intents.openThread(id)
      await tick()
      io.set(s.doc.querySelector('#a')!, false)
      await tick()
      expect(badgeOf(s.vm(), id)?.offscreen).toBe(false)
    } finally {
      io.restore()
    }
  })

  test('hideOffscreen: false never observes at all', async () => {
    const io = fakeIntersectionObserver()
    try {
      const s = await boot({ ui: { badge: { hideOffscreen: false } } })
      await s.seed('#a')
      expect(io.observed.size).toBe(0)
    } finally {
      io.restore()
    }
  })
})

describe('badge teardown', () => {
  test('deleting a thread removes its badge', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    expect(s.vm().badges).toHaveLength(1)
    await s.engine.delete(id)
    await s.settle()
    expect(s.vm().badges).toHaveLength(0)
  })
})
