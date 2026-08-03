/**
 * §3 badge rules: `pending` renders nothing, resolved is hidden from the page by default,
 * orphaned docks at the last known `DocumentRect`, the approximate marker appears below 0.85,
 * badge chrome comes from `Mode.badge`, and off-screen badges are skipped.
 */

import type { ThreadView } from '@astrale-os/comment-core'

import { createMemoryStore } from '@astrale-os/comment-core'
import { afterEach, describe, expect, test } from 'vitest'

import type { UIContext } from '../src/context.ts'

import { badgeVisible } from '../src/badge.ts'
import { mountCommentUI } from '../src/index.ts'
import { sectionOf } from '../src/panel.ts'
import { $, badgeOf, badges, fakeIntersectionObserver, scene, tick } from './support.ts'

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

function fakeCtx(): UIContext {
  return {
    options: {
      badge: { showResolved: false, orphaned: 'dock', offset: [6, -6], hideOffscreen: true },
    },
  } as unknown as UIContext
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
  test('an anchored open thread renders one button carrying its count and mode chrome', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    const badge = badgeOf(s.root, id)
    expect(badge).not.toBeNull()
    expect(badge?.tagName).toBe('BUTTON')
    expect(badge?.getAttribute('type')).toBe('button')
    expect(badge?.getAttribute('data-anchor')).toBe('anchored')
    expect(badge?.getAttribute('data-kind')).toBe('comment')
    expect($(badge!, '.cc-badge-count')?.textContent).toBe('1')

    await s.engine.appendComment(id, { author: 'copilot', body: 'reply' })
    await s.settle()
    expect($(badgeOf(s.root, id)!, '.cc-badge-count')?.textContent).toBe('2')
  })

  test('Mode.badge supplies the icon and the accessible name', async () => {
    const s = await boot()
    const ask = await s.seed('#a', 'ask me', { kind: 'ask' })
    const plain = await s.seed('#b', 'plain')
    expect($(badgeOf(s.root, ask)!, '.cc-badge-icon')?.textContent).toBe('?')
    expect(badgeOf(s.root, ask)?.getAttribute('aria-label')).toBe('Ask (1)')
    // A kind with no `Mode.badge` falls back to the raw kind — never to a hard-coded word.
    expect(badgeOf(s.root, plain)?.getAttribute('aria-label')).toBe('comment (1)')
  })

  test('a thread whose kind left `modes` renders with default chrome', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'triage me', { kind: 'triage' })
    s.engine.setModes([{ kind: 'comment', trigger: { key: 'c' } }])
    await s.settle()
    expect(badgeOf(s.root, id)?.getAttribute('aria-label')).toBe('triage (1)')
    expect($(badgeOf(s.root, id)!, '.cc-badge-icon')?.textContent).toBe('💬')
  })

  test('pending renders nothing — not a badge, not a panel row', () => {
    // §3, normative: on a cold load that is EVERY thread, for the length of the first
    // resolution pass. happy-dom reports `readyState: 'complete'`, so the engine closes that
    // window inside one microtask and the state is not reachable from an integration test —
    // the rule is therefore asserted where it is implemented, on the two predicates the
    // renderer consults. See "residual gaps" in the suite README comment.
    const view = pendingView()
    expect(badgeVisible(fakeCtx(), view)).toBe(false)
    expect(sectionOf(view)).toBeNull()
    expect(
      badgeVisible(fakeCtx(), { ...view, anchoring: { ...view.anchoring, status: 'anchored' } }),
    ).toBe(true)
  })

  test('a cold-started engine paints nothing before its first pass', async () => {
    const store = createMemoryStore()
    const seeded = await scene(PAGE, { engine: { store } })
    await seeded.seed('#a')
    seeded.ui.unmount()

    const cold = seeded.page.engine({ store, autoStart: false })
    const ui = mountCommentUI(cold, { panel: { defaultOpen: true } })
    cleanup.push(async () => {
      ui.unmount()
      cold.destroy()
      await seeded.page.dispose()
    })

    cold.start()
    expect(badges(ui.root)).toHaveLength(0)
    expect($(ui.root, '.cc-row')).toBeNull()

    await cold.ready()
    await seeded.page.flush()
    await tick()
    expect(badges(ui.root)).toHaveLength(1)
  })
})

describe('resolved', () => {
  test('is hidden from the page by default and shown with showResolved', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    await s.engine.resolve(id)
    await s.settle()
    expect(badgeOf(s.root, id)).toBeNull()

    const shown = await boot({ ui: { badge: { showResolved: true } }, engine: {} })
    const other = await shown.seed('#b')
    await shown.engine.resolve(other)
    await shown.settle()
    const badge = badgeOf(shown.root, other)
    expect(badge?.getAttribute('data-status')).toBe('resolved')
    expect($(badge!, '.cc-mark[data-mark="resolved"]')).not.toBeNull()
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
    const view = s.engine.getThreadView(id)
    expect(view?.anchoring.status).toBe('orphaned')
    return { s, id }
  }

  test('dock (default) keeps a dimmed, flagged badge at the last known rect', async () => {
    const { s, id } = await orphan()
    const badge = badgeOf(s.root, id)
    expect(badge).not.toBeNull()
    expect(badge?.getAttribute('data-anchor')).toBe('orphaned')
    expect($(badge!, '.cc-mark[data-mark="orphaned"]')).not.toBeNull()
    // Docked, i.e. positioned — not left at the layer origin by accident.
    expect(badge?.style.position).toBe('')
  })

  test('panel-only removes the badge but keeps the panel row', async () => {
    const { s, id } = await orphan({ ui: { badge: { orphaned: 'panel-only' } } })
    expect(badgeOf(s.root, id)).toBeNull()
    expect($(s.root, `.cc-row[data-thread="${id}"]`)).not.toBeNull()
  })

  test('hidden removes it from the page AND the panel', async () => {
    const { s, id } = await orphan({ ui: { badge: { orphaned: 'hidden' } } })
    expect(badgeOf(s.root, id)).toBeNull()
    expect($(s.root, `.cc-row[data-thread="${id}"]`)).toBeNull()
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
    expect(badgeOf(s.root, id)?.getAttribute('data-anchor')).toBe('anchored')
    expect(s.store.writes).toBe(writes)
  })
})

describe('approximate re-anchoring', () => {
  test('marks the badge when confidence drops below 0.85', async () => {
    const s = await boot({ engine: { anchoring: { scoring: () => 0.7 } } })
    const id = await s.seed('#a')
    await s.engine.reanchor(id)
    await s.settle()
    const view = s.engine.getThreadView(id)
    expect(view?.anchoring.confidence).toBeLessThan(0.85)
    const badge = badgeOf(s.root, id)
    expect(badge?.getAttribute('data-approximate')).toBe('true')
    expect($(badge!, '.cc-mark[data-mark="approximate"]')).not.toBeNull()
    expect(badge?.getAttribute('title')).toBe('Approximately re-anchored')
  })
})

describe('off-screen skip', () => {
  test('an IntersectionObserver miss hides the badge; a hit brings it back', async () => {
    const io = fakeIntersectionObserver()
    try {
      const s = await boot()
      const id = await s.seed('#a')
      const element = s.doc.querySelector('#a')!
      expect(io.observed.has(element)).toBe(true)

      io.set(element, false)
      expect(badgeOf(s.root, id)?.hasAttribute('hidden')).toBe(true)
      io.set(element, true)
      expect(badgeOf(s.root, id)?.hasAttribute('hidden')).toBe(false)
    } finally {
      io.restore()
    }
  })

  test('an off-screen badge survives unrelated render passes un-tracked', async () => {
    const io = fakeIntersectionObserver()
    try {
      const s = await boot()
      const id = await s.seed('#a')
      const other = await s.seed('#b')
      const element = s.doc.querySelector('#a')!
      io.set(element, false)
      const observations = io.observeCalls()

      // Any unrelated store change re-runs the whole render pass. It must NOT re-observe the
      // element or bring the hidden badge back.
      await s.engine.appendComment(other, { author: 'user', body: 'noise' })
      await s.settle()
      expect(badgeOf(s.root, id)?.hasAttribute('hidden')).toBe(true)
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
      s.ui.focus(id)
      await tick()
      io.set(s.doc.querySelector('#a')!, false)
      expect(badgeOf(s.root, id)?.hasAttribute('hidden')).toBe(false)
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
    expect(badges(s.root)).toHaveLength(1)
    await s.engine.delete(id)
    await s.settle()
    expect(badges(s.root)).toHaveLength(0)
  })
})
