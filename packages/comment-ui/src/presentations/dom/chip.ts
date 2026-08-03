/**
 * Decoration chips — the entire "copilot thinking" / "pending dispatch" / "run failed" surface,
 * rendered **purely from `ChipVM`**. This layer never learns what a copilot is, and after the
 * split it could not: it renders `{ text, tone, spinner }` and has no way to reach anything else.
 *
 * The slot carries `aria-live="polite"` (§3 a11y) so "thinking" → settled is announced without
 * stealing focus. Rendering is idempotent — an unchanged chip touches no node, so a render pass
 * triggered by an unrelated thread cannot re-announce one.
 */

import type { ChipVM } from '../../presentation.ts'

import { el, setAttr, setText } from '../../dom.ts'

export function createChipSlot(doc: Document, live: boolean): HTMLElement {
  const slot = el(doc, 'span', { class: 'cc-chip-slot' })
  if (live) slot.setAttribute('aria-live', 'polite')
  return slot
}

/** Renders (or clears) the chip inside a slot. Returns true when a chip is showing. */
export function renderChip(doc: Document, slot: HTMLElement, chip: ChipVM | null): boolean {
  if (!chip) {
    if (slot.firstChild) slot.replaceChildren()
    return false
  }

  let node = slot.querySelector<HTMLElement>('.cc-chip')
  if (!node) {
    node = el(doc, 'span', { class: 'cc-chip' })
    slot.replaceChildren(node)
  }
  setAttr(node, 'data-tone', chip.tone)

  const spinner = node.querySelector<HTMLElement>('.cc-spinner')
  if (chip.spinner && !spinner) {
    node.prepend(el(doc, 'span', { class: 'cc-spinner', 'aria-hidden': 'true' }))
  } else if (!chip.spinner && spinner) {
    spinner.remove()
  }

  let text = node.querySelector<HTMLElement>('.cc-chip-text')
  if (!text) {
    text = el(doc, 'span', { class: 'cc-chip-text' })
    node.append(text)
  }
  setText(text, chip.text)
  return true
}

/** The shape-not-colour markers (§3): resolved, orphaned and approximate each get a glyph. */
export function renderMarks(
  doc: Document,
  node: HTMLElement,
  flags: { resolved: boolean; orphaned: boolean; approximate: boolean },
): void {
  const glyphs = [
    flags.resolved ? 'resolved' : null,
    flags.orphaned ? 'orphaned' : null,
    flags.approximate ? 'approximate' : null,
  ].filter((mark): mark is string => mark !== null)
  const key = glyphs.join(',')
  if (node.getAttribute('data-marks') === key) return
  node.setAttribute('data-marks', key)
  node.replaceChildren(
    ...glyphs.map((mark) => el(doc, 'span', { class: 'cc-mark', 'data-mark': mark })),
  )
}
