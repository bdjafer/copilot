/**
 * Badges — DESIGN §7 rows 1–4 and §8.1.
 *
 * **A badge is solid, never glass.** Forty of them, each running the controller's frame loop and
 * each forcing a backdrop-root readback over an article nobody wrote for us, is a jank machine.
 * Depth on the resting layer comes from the keyline sandwich and elevation; material is a reward
 * for expressing intent, and that is also why the widget reads as *subtle* liquid glass rather
 * than a frosted mood board — you only ever see one pane at a time, and you summoned it.
 *
 * Rest is a 12 px dot at α .72. It becomes a 22 px pill with a glyph and a tabular count when,
 * and only when, intent is expressed: cursor within 96 px (S1), hover (S2), `:focus-visible`
 * (S3 — always *more* than hover, because a keyboard user has no proximity signal), a live
 * decoration chip (S6 — a working copilot must never hide), touch (S8), or the two seconds after
 * the page changes underneath us. Those five mitigations ship together or the dormant badge is a
 * bug; four of them are CSS, and the two this file owns are `data-near` and `data-reveal`.
 *
 * The state silhouette is unconditional: filled = open, hollow + check = resolved, dashed =
 * orphaned, open ring = approximate. It is readable in a screenshot, which is the test that
 * "colour never carries state alone" has to pass.
 */

import type { BadgeVM, Intents, PresentationHost, Rect } from '../../presentation.ts'

import { el, setAttr, setText } from '../../dom.ts'
import { createChip, createChipSlot, type ChipSlot } from './chip.ts'
import { renderMarks } from './chip.ts'
import { icon, kindIcon, setIcon } from './icons.ts'
import { bloom, flight, roll } from './motion.ts'

/** §8.1: badges whose anchors land within this many px of each other fan instead of overlapping. */
const CLUSTER_PX = 24
/** A jump larger than this between two publications is a re-anchor, not a scroll (§6.4 `flight`). */
const FLIGHT_PX = 48
/** §7's fifth discoverability mitigation: every badge is revealed for this long after a page swap. */
export const PAGE_REVEAL_MS = 2000

interface Entry {
  button: HTMLButtonElement
  glyph: SVGSVGElement
  text: HTMLElement
  count: HTMLElement
  marks: HTMLElement
  chip: ChipSlot
  open: boolean
  rect: Rect | null
}

export interface BadgeLayer {
  render(badges: readonly BadgeVM[], reduced: boolean): void
  /** The nodes S1 should watch, with their reveal radius. */
  proximity(): { node: HTMLElement; radius: number }[]
  elementFor(threadId: string): HTMLElement | null
  rectFor(threadId: string): DOMRect | null
  destroy(): void
}

export function createBadgeLayer(host: PresentationHost, intents: Intents): BadgeLayer {
  const { doc } = host
  const entries = new Map<string, Entry>()
  /** Every id this mount has ever drawn — `bloom` is for a genuine creation and nothing else. */
  const seen = new Set<string>()
  let revealUntil = 0
  let hadBadges = false

  function create(badge: BadgeVM): Entry {
    const glyph = icon(doc, kindIcon(badge.kind), 'cc-badge-icon')
    // A host that supplied `Mode.badge.icon` gets its own string; nothing else ever draws text
    // in a badge, and every emoji in the old appearance is gone — a different font, a different
    // baseline and a different colour on every operating system.
    const text = el(doc, 'span', { class: 'cc-badge-glyph', 'aria-hidden': 'true' })
    const count = el(doc, 'span', { class: 'cc-badge-count', 'aria-hidden': 'true' })
    const marks = el(doc, 'span', { class: 'cc-badge-marks', 'aria-hidden': 'true' })
    const slot = createChipSlot(doc, true)
    const button = el(
      doc,
      'button',
      {
        type: 'button',
        class: 'cc-badge',
        'data-thread': badge.threadId,
        'data-near': 'false',
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
      },
      [glyph, text, count, marks, slot],
    )
    const entry: Entry = {
      button,
      glyph,
      text,
      count,
      marks,
      chip: createChip(doc, slot),
      open: false,
      rect: null,
    }
    button.addEventListener('click', (event) => {
      event.preventDefault()
      if (entry.open) intents.closeThread()
      else intents.openThread(badge.threadId)
    })
    host.layer.append(button)
    host.anchor(`badge:${badge.threadId}`, button)
    return entry
  }

  function update(entry: Entry, badge: BadgeVM, reduced: boolean): void {
    entry.open = badge.open
    if (badge.icon === null) {
      setIcon(entry.glyph, kindIcon(badge.kind))
      setText(entry.text, '')
      setAttr(entry.glyph, 'data-on', 'true')
    } else {
      setText(entry.text, badge.icon)
      setAttr(entry.glyph, 'data-on', null)
    }

    // §7 row 2: a badge reading "1" is noise, so the count exists from two upward. The full
    // count is still in the accessible name, in every state, including the 12 px dot.
    roll(entry.count, badge.count >= 2 ? String(badge.count) : '', reduced)
    renderMarks(doc, entry.marks, badge)

    setAttr(entry.button, 'data-anchor', badge.anchor)
    setAttr(entry.button, 'data-status', badge.resolved ? 'resolved' : 'open')
    setAttr(
      entry.button,
      'data-state',
      badge.orphaned ? 'orphaned' : badge.resolved ? 'resolved' : 'open',
    )
    setAttr(entry.button, 'data-kind', badge.kind)
    setAttr(entry.button, 'data-approximate', badge.approximate ? 'true' : null)
    setAttr(entry.button, 'data-tone', badge.tone)
    setAttr(entry.button, 'data-docked', badge.docked ? 'true' : null)
    // §8.1: `transform-origin` follows the positioner's resolved placement, so the pill grows
    // *out of its anchor* rather than out of itself, and never over the element it annotates.
    setAttr(entry.button, 'data-placement', badge.placement)
    setAttr(entry.button, 'aria-label', badge.ariaLabel)
    setAttr(entry.button, 'aria-expanded', badge.open ? 'true' : 'false')
    setAttr(entry.button, 'title', badge.title)
    setAttr(entry.button, 'hidden', badge.offscreen)
    // S6: a badge carrying live copilot state is never allowed to hide.
    setAttr(entry.button, 'data-chip', badge.chip ? badge.chip.tone : null)
    entry.chip.render(badge.chip)

    if (badge.rect && entry.rect) {
      const dx = badge.rect.x - entry.rect.x
      const dy = badge.rect.y - entry.rect.y
      // Scrolling moves every badge together and is the positioner's business; a jump this size
      // on one badge is its reference being swapped underneath it, which is worth a flight.
      if (Math.hypot(dx, dy) >= FLIGHT_PX) {
        flight(entry.button, entry.rect, badge.rect, reduced)
      }
    }
    entry.rect = badge.rect
  }

  /**
   * §8.1's stack. Overlapping badges are the commonest ugly state on a dense page: two anchors a
   * few px apart draw two pills on top of each other and neither is clickable. Grouping them into
   * a fan is the one place the design lets geometry drive markup.
   */
  function cluster(badges: readonly BadgeVM[]): void {
    const groups: { x: number; y: number; ids: string[] }[] = []
    for (const badge of badges) {
      const rect = badge.rect
      if (!rect || badge.offscreen) continue
      const found = groups.find(
        (group) => Math.hypot(group.x - rect.x, group.y - rect.y) <= CLUSTER_PX,
      )
      if (found) found.ids.push(badge.threadId)
      else groups.push({ x: rect.x, y: rect.y, ids: [badge.threadId] })
    }
    for (const group of groups) {
      group.ids.forEach((id, index) => {
        const entry = entries.get(id)
        if (!entry) return
        setAttr(entry.button, 'data-stack', group.ids.length > 1 ? String(index) : null)
        setAttr(entry.button, 'data-stack-size', group.ids.length > 1 ? group.ids.length : null)
      })
    }
  }

  return {
    render(badges, reduced) {
      const wanted = new Set<string>()
      const now = Date.now()
      if (badges.length > 0 && !hadBadges) revealUntil = now + PAGE_REVEAL_MS
      hadBadges = badges.length > 0

      for (const badge of badges) {
        wanted.add(badge.threadId)
        let entry = entries.get(badge.threadId)
        const fresh = !entry
        if (!entry) {
          entry = create(badge)
          entries.set(badge.threadId, entry)
        }
        update(entry, badge, reduced)
        // A first sighting after the page already had badges is a creation. A first sighting of
        // the whole set is a load, and a re-show after the off-screen skip is neither.
        if (fresh && !seen.has(badge.threadId) && seen.size > 0) bloom(entry.button, reduced)
        seen.add(badge.threadId)
      }

      for (const [id, entry] of entries) {
        if (wanted.has(id)) continue
        host.anchor(`badge:${id}`, null)
        entry.chip.destroy()
        entry.button.remove()
        entries.delete(id)
      }

      cluster(badges)

      // The fifth mitigation, applied to the layer so one attribute reveals every badge at once.
      const revealing = now < revealUntil
      setAttr(host.layer, 'data-reveal-all', revealing ? 'true' : null)
      if (revealing) {
        doc.defaultView?.setTimeout(
          () => {
            if (Date.now() >= revealUntil) host.layer.removeAttribute('data-reveal-all')
          },
          revealUntil - now + 16,
        )
      }
    },

    proximity() {
      return [...entries.values()]
        .filter((entry) => !entry.button.hasAttribute('hidden'))
        .map((entry) => ({ node: entry.button, radius: 96 }))
    },

    elementFor(threadId) {
      return entries.get(threadId)?.button ?? null
    },

    rectFor(threadId) {
      const entry = entries.get(threadId)
      return entry ? entry.button.getBoundingClientRect() : null
    },

    destroy() {
      for (const [id, entry] of entries) {
        host.anchor(`badge:${id}`, null)
        entry.chip.destroy()
        entry.button.remove()
      }
      entries.clear()
    },
  }
}
