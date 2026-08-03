/**
 * Decoration chips — the entire "copilot thinking" / "pending dispatch" / "run failed" surface,
 * rendered **purely from data the host passes to `decorate()`**. `comment-ui` never learns what
 * a copilot is: it renders `{ text, tone, spinner }` and nothing else (decision log #22).
 *
 * The slot carries `aria-live="polite"` (§3 a11y) so "copilot thinking" → settled is announced
 * without stealing focus. Rendering is idempotent — an unchanged decoration touches no node, so
 * a render pass triggered by an unrelated thread cannot re-announce a chip.
 */

import type { UIContext } from './context.ts'
import type { Decoration } from './types.ts'

import { el, setAttr, setText } from './dom.ts'

export function createChipSlot(ctx: UIContext, live: boolean): HTMLElement {
  const slot = el(ctx.doc, 'span', { class: 'cc-chip-slot' })
  if (live) slot.setAttribute('aria-live', 'polite')
  return slot
}

/** Renders (or clears) the chip inside a slot. Returns true when a chip is showing. */
export function renderChip(
  ctx: UIContext,
  slot: HTMLElement,
  decoration: Decoration | null,
): boolean {
  const chip = decoration?.chip
  if (!chip) {
    if (slot.firstChild) slot.replaceChildren()
    return false
  }

  let node = slot.querySelector<HTMLElement>('.cc-chip')
  if (!node) {
    node = el(ctx.doc, 'span', { class: 'cc-chip' })
    slot.replaceChildren(node)
  }
  setAttr(node, 'data-tone', chip.tone ?? 'neutral')

  let spinner = node.querySelector<HTMLElement>('.cc-spinner')
  if (chip.spinner && !spinner) {
    spinner = el(ctx.doc, 'span', { class: 'cc-spinner', 'aria-hidden': 'true' })
    node.prepend(spinner)
  } else if (!chip.spinner && spinner) {
    spinner.remove()
    spinner = null
  }

  let text = node.querySelector<HTMLElement>('.cc-chip-text')
  if (!text) {
    text = el(ctx.doc, 'span', { class: 'cc-chip-text' })
    node.append(text)
  }
  setText(text, chip.text)
  return true
}
