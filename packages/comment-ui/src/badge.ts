/**
 * Badges (§5.2 `badge.ts`). One `<button>` per visible thread, tracking its anchored element
 * through `@floating-ui/dom`'s `autoUpdate`, or docked at `anchoring.rect` when the thread is
 * orphaned.
 *
 * Three visibility rules from §3, none configurable beyond the `badge` option bag:
 *  - **`pending` renders nothing.** On a cold load that is every thread, for the length of the
 *    first resolution pass — anything else is exactly the flash the anchoring rules exist to
 *    prevent. A pending thread is also in no panel section.
 *  - **resolved is hidden from the page** by default (Figma/Docs behavior) and lives in the
 *    panel's "resolved" section, where it can be reopened.
 *  - **orphaned stays reachable**: a dimmed, dashed badge docked at the last known
 *    `DocumentRect` (`orphaned: 'dock'`, the default) plus the panel's "unanchored" section,
 *    so a copilot reply to a permanently-gone element is never invisible.
 *
 * Badges are real buttons — keyboard reachable, `aria-label` composed from the mode name and
 * the comment count, `aria-expanded` reflecting their popover (§3 a11y).
 */

import type { ThreadView } from '@astrale-os/comment-core'

import type { UIContext } from './context.ts'
import type { Tracker, VisibilityWatcher } from './position.ts'

import { createChipSlot, renderChip } from './chip.ts'
import { isApproximate, threadLabel } from './context.ts'
import { el, setAttr, setText } from './dom.ts'
import { dockedReference, track, watchVisibility } from './position.ts'

interface BadgeEntry {
  button: HTMLButtonElement
  icon: HTMLElement
  count: HTMLElement
  marks: HTMLElement
  chipSlot: HTMLElement
  tracker: Tracker | null
  watcher: VisibilityWatcher | null
  /** The element currently being tracked; `null` for a docked badge. */
  reference: Element | null
  /** Serialized dock rect, so a re-render only rebuilds the tracker when the rect moves. */
  dockKey: string | null
  onScreen: boolean
}

export interface BadgeLayer {
  sync(views: readonly ThreadView[]): void
  elementFor(threadId: string): HTMLElement | null
  destroy(): void
}

/** §3: `pending` draws nothing, resolved is hidden unless asked for, orphan mode decides docks. */
export function badgeVisible(ctx: UIContext, view: ThreadView): boolean {
  const status = view.anchoring.status
  if (status === 'pending') return false
  if (view.isResolved && !ctx.options.badge.showResolved) return false
  if (status === 'orphaned') {
    return ctx.options.badge.orphaned === 'dock' && view.anchoring.rect !== null
  }
  return true
}

export function createBadgeLayer(ctx: UIContext): BadgeLayer {
  const entries = new Map<string, BadgeEntry>()

  function create(view: ThreadView): BadgeEntry {
    const icon = el(ctx.doc, 'span', { class: 'cc-badge-icon', 'aria-hidden': 'true' })
    const count = el(ctx.doc, 'span', { class: 'cc-badge-count' })
    const marks = el(ctx.doc, 'span', { class: 'cc-badge-marks', 'aria-hidden': 'true' })
    const chipSlot = createChipSlot(ctx, true)
    const button = el(
      ctx.doc,
      'button',
      {
        type: 'button',
        class: 'cc-badge',
        'data-thread': view.id,
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
      },
      [icon, count, marks, chipSlot],
    )

    button.addEventListener('click', (event) => {
      event.preventDefault()
      if (ctx.activeThread() === view.id) ctx.closeThread()
      else ctx.focusThread(view.id)
    })

    ctx.layer.append(button)
    return {
      button,
      icon,
      count,
      marks,
      chipSlot,
      tracker: null,
      watcher: null,
      reference: null,
      dockKey: null,
      onScreen: true,
    }
  }

  function stopTracking(entry: BadgeEntry): void {
    entry.tracker?.destroy()
    entry.tracker = null
  }

  function detach(entry: BadgeEntry): void {
    stopTracking(entry)
    entry.watcher?.destroy()
    entry.watcher = null
    entry.reference = null
    entry.dockKey = null
    entry.onScreen = true
  }

  function startTracker(entry: BadgeEntry, reference: Parameters<typeof track>[0]): void {
    if (entry.tracker) return
    entry.tracker = track(reference, entry.button, {
      placement: 'top-end',
      offset: ctx.options.badge.offset,
      onError: ctx.onError,
    })
  }

  /**
   * Keyed on the reference alone, deliberately **not** on `tracker !== null`: while a badge is
   * off-screen its tracker is intentionally torn down, and keying on it would make every
   * unrelated render pass re-observe the element and restart the frame loop for a badge nobody
   * can see — which is precisely the cost the off-screen skip exists to avoid.
   */
  function trackAnchored(entry: BadgeEntry, element: Element, threadId: string): void {
    if (entry.reference === element) return
    detach(entry)
    entry.reference = element
    startTracker(entry, element)
    if (!ctx.options.badge.hideOffscreen) return
    entry.watcher = watchVisibility(element, ctx.win, (visible) => {
      entry.onScreen = visible
      // The active thread's popover anchors to its badge, so it is never paused underneath it.
      const pinned = ctx.activeThread() === threadId
      setAttr(entry.button, 'hidden', !visible && !pinned)
      if (visible || pinned) startTracker(entry, element)
      else stopTracking(entry)
    })
  }

  function trackDocked(entry: BadgeEntry, view: ThreadView): void {
    const rect = view.anchoring.rect
    if (!rect) return
    const key = `${String(rect.top)}:${String(rect.left)}:${String(rect.width)}:${String(rect.height)}`
    if (entry.dockKey === key) return
    detach(entry)
    entry.dockKey = key
    startTracker(entry, dockedReference(rect, ctx.win))
  }

  function update(entry: BadgeEntry, view: ThreadView): void {
    const mode = ctx.modeOf(view.kind)
    const decoration = ctx.decorationOf(view.id)
    const orphaned = view.anchoring.status === 'orphaned'
    const approximate = isApproximate(view)

    setText(entry.icon, mode?.badge?.icon ?? '💬')
    setText(entry.count, String(view.comments.length))

    // Colour never carries state alone: every state also has a glyph.
    const marks =
      (view.isResolved ? '<resolved>' : '') +
      (orphaned ? '<orphaned>' : '') +
      (approximate ? '<approximate>' : '')
    if (entry.marks.getAttribute('data-marks') !== marks) {
      entry.marks.setAttribute('data-marks', marks)
      entry.marks.replaceChildren(
        ...[
          view.isResolved ? 'resolved' : null,
          orphaned ? 'orphaned' : null,
          approximate ? 'approximate' : null,
        ]
          .filter((mark): mark is string => mark !== null)
          .map((mark) => el(ctx.doc, 'span', { class: 'cc-mark', 'data-mark': mark })),
      )
    }

    setAttr(entry.button, 'data-anchor', view.anchoring.status)
    setAttr(entry.button, 'data-status', view.status)
    setAttr(entry.button, 'data-kind', view.kind)
    setAttr(entry.button, 'data-approximate', approximate ? 'true' : null)
    setAttr(entry.button, 'data-tone', decoration?.tone ?? 'default')
    setAttr(entry.button, 'aria-label', threadLabel(ctx, view))
    setAttr(entry.button, 'aria-expanded', ctx.activeThread() === view.id ? 'true' : 'false')
    setAttr(
      entry.button,
      'title',
      decoration?.title ?? (approximate ? ctx.labels.approximate : null),
    )
    renderChip(ctx, entry.chipSlot, decoration)

    const element = view.anchoring.element
    if (view.anchoring.status === 'anchored' && element) trackAnchored(entry, element, view.id)
    else trackDocked(entry, view)

    /**
     * Pinning is the second way in — and the only one the visibility watcher never sees. A badge
     * that went off-screen had its tracker torn down; if the panel then opens that thread, it is
     * un-hidden and the popover anchors to it, so it MUST be tracked again or it (and the
     * popover under it) sit at stale coordinates. `startTracker` is a no-op when one is already
     * running, so this is also the re-entry point after `hideOffscreen` un-pins a badge.
     */
    const pinned = ctx.activeThread() === view.id
    if (entry.reference && ctx.options.badge.hideOffscreen) {
      if (entry.onScreen || pinned) startTracker(entry, entry.reference)
      else stopTracking(entry)
    }
    setAttr(entry.button, 'hidden', !entry.onScreen && !pinned)
  }

  return {
    sync(views) {
      const wanted = new Set<string>()
      for (const view of views) {
        if (!badgeVisible(ctx, view)) continue
        wanted.add(view.id)
        let entry = entries.get(view.id)
        if (!entry) {
          entry = create(view)
          entries.set(view.id, entry)
        }
        update(entry, view)
      }
      for (const [id, entry] of entries) {
        if (wanted.has(id)) continue
        detach(entry)
        entry.button.remove()
        entries.delete(id)
      }
    },

    elementFor(threadId) {
      return entries.get(threadId)?.button ?? null
    },

    destroy() {
      for (const entry of entries.values()) {
        detach(entry)
        entry.button.remove()
      }
      entries.clear()
    },
  }
}
