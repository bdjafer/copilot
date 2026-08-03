/**
 * Badges — one `<button>` per `BadgeVM`, registered with the host so the controller can position
 * it, and nothing else.
 *
 * Every rule that used to live here now lives one layer down and arrives pre-decided: which
 * threads get a badge at all (`vm.badges` is already filtered — a pending thread is simply not
 * in it), whether a badge is docked, whether it is off-screen, its accessible name, its tone and
 * its markers. What is left is markup: which node, which class, which glyph.
 *
 * Badges are real buttons — keyboard reachable, `aria-label` from the model, `aria-expanded`
 * reflecting their popover (§3 a11y). Colour never carries state alone, so resolved, orphaned
 * and approximate each also draw a `.cc-mark`.
 */

import type { BadgeVM, Intents, PresentationHost } from '../../presentation.ts'

import { el, setAttr, setText } from '../../dom.ts'
import { createChipSlot, renderChip, renderMarks } from './chip.ts'

interface Entry {
  button: HTMLButtonElement
  icon: HTMLElement
  count: HTMLElement
  marks: HTMLElement
  chipSlot: HTMLElement
  /** Last published open state — the click handler toggles against the model, not the DOM. */
  open: boolean
}

export interface BadgeLayer {
  render(badges: readonly BadgeVM[]): void
  elementFor(threadId: string): HTMLElement | null
  destroy(): void
}

export function createBadgeLayer(host: PresentationHost, intents: Intents): BadgeLayer {
  const { doc } = host
  const entries = new Map<string, Entry>()

  function create(badge: BadgeVM): Entry {
    const icon = el(doc, 'span', { class: 'cc-badge-icon', 'aria-hidden': 'true' })
    const count = el(doc, 'span', { class: 'cc-badge-count' })
    const marks = el(doc, 'span', { class: 'cc-badge-marks', 'aria-hidden': 'true' })
    const chipSlot = createChipSlot(doc, true)
    const button = el(
      doc,
      'button',
      {
        type: 'button',
        class: 'cc-badge',
        'data-thread': badge.threadId,
        'aria-haspopup': 'dialog',
        'aria-expanded': 'false',
      },
      [icon, count, marks, chipSlot],
    )
    const entry: Entry = { button, icon, count, marks, chipSlot, open: false }

    button.addEventListener('click', (event) => {
      event.preventDefault()
      if (entry.open) intents.closeThread()
      else intents.openThread(badge.threadId)
    })

    host.layer.append(button)
    host.anchor(`badge:${badge.threadId}`, button)
    return entry
  }

  function update(entry: Entry, badge: BadgeVM): void {
    entry.open = badge.open
    setText(entry.icon, badge.icon ?? '💬')
    setText(entry.count, String(badge.count))
    renderMarks(doc, entry.marks, badge)

    setAttr(entry.button, 'data-anchor', badge.anchor)
    setAttr(entry.button, 'data-status', badge.resolved ? 'resolved' : 'open')
    setAttr(entry.button, 'data-kind', badge.kind)
    setAttr(entry.button, 'data-approximate', badge.approximate ? 'true' : null)
    setAttr(entry.button, 'data-tone', badge.tone)
    setAttr(entry.button, 'aria-label', badge.ariaLabel)
    setAttr(entry.button, 'aria-expanded', badge.open ? 'true' : 'false')
    setAttr(entry.button, 'title', badge.title)
    setAttr(entry.button, 'hidden', badge.offscreen)
    renderChip(doc, entry.chipSlot, badge.chip)
  }

  return {
    render(badges) {
      const wanted = new Set<string>()
      for (const badge of badges) {
        wanted.add(badge.threadId)
        let entry = entries.get(badge.threadId)
        if (!entry) {
          entry = create(badge)
          entries.set(badge.threadId, entry)
        }
        update(entry, badge)
      }
      for (const [id, entry] of entries) {
        if (wanted.has(id)) continue
        host.anchor(`badge:${id}`, null)
        entry.button.remove()
        entries.delete(id)
      }
    },

    elementFor(threadId) {
      return entries.get(threadId)?.button ?? null
    },

    destroy() {
      for (const [id, entry] of entries) {
        host.anchor(`badge:${id}`, null)
        entry.button.remove()
      }
      entries.clear()
    },
  }
}
