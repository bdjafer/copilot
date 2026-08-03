/**
 * The pin — DESIGN §0 D5/D9, §7 rows 1–4 and §8.1.
 *
 * **A pin is solid, never glass.** Forty of them, each running the controller's frame loop and
 * each forcing a backdrop-root readback over an article nobody wrote for us, is a jank machine.
 * Depth on the resting layer comes from the keyline sandwich and elevation; material is a reward
 * for expressing intent.
 *
 * Rest is a 12 px dot at α .72. It becomes a **28 px teardrop** — a circle with exactly one 2 px
 * corner, and that corner sits *on the click point* — when, and only when, intent is expressed:
 * cursor within 96 px (S1), hover (S2), `:focus-visible` (S3 — always *more* than hover, because a
 * keyboard user has no proximity signal), a live decoration chip (S6), touch (S8), or the two
 * seconds after the page changes underneath us. Those five mitigations ship together or the
 * dormant pin is a bug.
 *
 * **A pin carries exactly one mark, always (§0 D5).** The host's `Mode.badge.icon` when supplied,
 * else `cc-i-comment` — *for every mode*; the state mark **replaces** it rather than riding beside
 * it (resolved ⇒ `cc-i-check`, failed ⇒ `cc-i-warn`); mode is carried by hue and by
 * `title` / `aria-label`, never by a second glyph; and **the count never draws on the pin** — it
 * lives in `aria-label`, the panel row and the batch pill, exactly where Vercel and Figma keep it.
 * The chip ladder moves off the face and onto the pin's **ring** (§8.6).
 */

import type { BadgeVM, Intents, PresentationHost, Rect } from '../../presentation.ts'
import type { HueOf } from './kind.ts'

import { el, setAttr, setText } from '../../dom.ts'
import { createChip, createChipSlot, type ChipSlot } from './chip.ts'
import { icon, kindIcon, setIcon } from './icons.ts'
import { applyHue } from './kind.ts'
import { bloom, flight } from './motion.ts'

/** §8.1: pins whose anchors land within this many px of each other fan instead of overlapping. */
const CLUSTER_PX = 24
/** A jump larger than this between two publications is a re-anchor, not a scroll (§6.4 `flight`). */
const FLIGHT_PX = 48
/** §7's fifth discoverability mitigation: every pin is revealed for this long after a page swap. */
export const PAGE_REVEAL_MS = 2000

interface Entry {
  button: HTMLButtonElement
  glyph: SVGSVGElement
  text: HTMLElement
  chip: ChipSlot
  open: boolean
  rect: Rect | null
}

export interface BadgeLayer {
  render(badges: readonly BadgeVM[], hueOf: HueOf, reduced: boolean): void
  /** The nodes S1 should watch, with their reveal radius. */
  proximity(): { node: HTMLElement; radius: number }[]
  elementFor(threadId: string): HTMLElement | null
  rectFor(threadId: string): DOMRect | null
  destroy(): void
}

/**
 * §7 row 3 / §8.6 rung 4: **the state chooses the one mark.** Resolved draws the check, a failed
 * run draws the warning, and everything else draws the payload — never two of them at once.
 */
function markFor(badge: BadgeVM): string {
  if (badge.chip && (badge.chip.tone === 'warn' || badge.chip.tone === 'danger')) return 'cc-i-warn'
  if (badge.resolved) return 'cc-i-check'
  return kindIcon(badge.kind)
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
    // A host that supplied `Mode.badge.icon` gets its own string, and it **replaces** the glyph.
    // Nothing else ever draws text in a pin: every emoji is gone (a different font, a different
    // baseline and a different colour on every operating system), and so is the count.
    const text = el(doc, 'span', { class: 'cc-badge-glyph', 'aria-hidden': 'true' })
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
      [glyph, text, slot],
    )
    const entry: Entry = {
      button,
      glyph,
      text,
      // §8.6: the ladder is drawn on the ring, so the pin's chip contributes no second mark —
      // only the rung (which the button wears) and the text (which `aria-live` reads).
      chip: createChip(doc, slot, {
        mark: false,
        onRung: (rung) => setAttr(button, 'data-rung', rung),
      }),
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

  function update(entry: Entry, badge: BadgeVM, hueOf: HueOf, reduced: boolean): void {
    entry.open = badge.open
    // One mark, chosen once. A host icon replaces the glyph; a state replaces both.
    const state = markFor(badge)
    const hostIcon = badge.icon !== null && state === kindIcon(badge.kind)
    if (hostIcon) {
      setText(entry.text, badge.icon ?? '')
      setAttr(entry.glyph, 'data-on', null)
    } else {
      setIcon(entry.glyph, state)
      setText(entry.text, '')
      setAttr(entry.glyph, 'data-on', 'true')
    }

    setAttr(entry.button, 'data-anchor', badge.anchor)
    setAttr(entry.button, 'data-status', badge.resolved ? 'resolved' : 'open')
    setAttr(
      entry.button,
      'data-state',
      badge.orphaned ? 'orphaned' : badge.resolved ? 'resolved' : 'open',
    )
    setAttr(entry.button, 'data-kind', badge.kind)
    // §2.3: the mode's hue offset, by its index in `engine.modes`. Since §0 D5 the hue is the
    // ONLY mode differentiator, so this is what tells `ask` from `comment` on the page.
    applyHue(entry.button, hueOf, badge.kind)
    setAttr(entry.button, 'data-approximate', badge.approximate ? 'true' : null)
    setAttr(entry.button, 'data-tone', badge.tone)
    // §7 row 1b: a docked pin is held revealed. An orphan has no anchor for the cursor to be
    // *near*, so proximity can never reveal it.
    setAttr(entry.button, 'data-docked', badge.docked ? 'true' : null)
    // §8.1: which corner is sharp — i.e. which quadrant the body hangs into — is the
    // controller's decision (SPEC #45); the matching radius and `translate` are the sheet's.
    setAttr(entry.button, 'data-corner', badge.pinCorner)
    setAttr(entry.button, 'data-point', badge.point ? 'true' : null)
    // Without a stored point a pin keeps the legacy behaviour: it hangs off the anchor rect, and
    // `transform-origin` follows the positioner's resolved placement.
    setAttr(entry.button, 'data-placement', badge.placement)
    setAttr(entry.button, 'aria-label', badge.ariaLabel)
    setAttr(entry.button, 'aria-expanded', badge.open ? 'true' : 'false')
    setAttr(entry.button, 'title', badge.title)
    setAttr(entry.button, 'hidden', badge.offscreen)
    // S6: a pin carrying live copilot state is never allowed to hide.
    setAttr(entry.button, 'data-chip', badge.chip ? badge.chip.tone : null)
    if (!badge.chip) setAttr(entry.button, 'data-rung', null)
    entry.chip.render(badge.chip)

    if (badge.rect && entry.rect) {
      const dx = badge.rect.x - entry.rect.x
      const dy = badge.rect.y - entry.rect.y
      // Scrolling moves every pin together and is the positioner's business; a jump this size
      // on one pin is its reference being swapped underneath it, which is worth a flight.
      if (Math.hypot(dx, dy) >= FLIGHT_PX) {
        flight(entry.button, entry.rect, badge.rect, reduced)
      }
    }
    entry.rect = badge.rect
  }

  /**
   * §8.1's stack. Overlapping pins are the commonest ugly state on a dense page: two anchors a
   * few px apart draw two marks on top of each other and neither is clickable. **The stack shows
   * no count** (§0 D5) — the fan *is* the count, and the number is in the `aria-label`.
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
    render(badges, hueOf, reduced) {
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
        update(entry, badge, hueOf, reduced)
        // A first sighting after the page already had pins is a creation. A first sighting of
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

      // The fifth mitigation, applied to the layer so one attribute reveals every pin at once.
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
