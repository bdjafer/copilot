/**
 * The presence ladder of DESIGN §8.6, and the state marks of §5.
 *
 * `Decoration` is locked and unchanged; only its **rendering** changes. The host's precedence
 * (busy > failed > pending > unread) already collapsed into the one `ChipVM` this layer can see,
 * so the rung is derived from `{ tone, spinner }` alone and deterministically:
 *
 * | Rung | `ChipVM` | Visual |
 * |---|---|---|
 * | 0 | `busy` under 450 ms | **nothing** |
 * | 1 | `neutral` | 5 px hollow ring, muted |
 * | 2 | `busy` at or past 450 ms | breathing ring; the badge does **not** grow |
 * | 4 | `warn` / `danger` | 5 px warning triangle, **and the chip text is shown** |
 * | 5 | `info` | 5 px filled accent dot |
 *
 * Rung 3 (a tick per tool step on the ring) needs `{ step, steps }`, which `ChipVM` does not
 * carry — the ladder is otherwise complete, and inventing a channel for it would mean widening a
 * locked type from inside a theme.
 *
 * **Chip text renders visually only for `warn` / `danger`** — a failure code is an identifier,
 * not prose. For every other tone the shape plus the native `title` carries it. The text node is
 * nevertheless present, in the accessibility tree, in **every** state: the slot is the
 * `aria-live` region, and a chip that announced by disappearing would announce nothing at all.
 * Collapsed for eyes, complete for assistive technology.
 */

import type { ChipVM } from '../../presentation.ts'

import { el, setAttr, setText } from '../../dom.ts'
import { icon, setIcon } from './icons.ts'

/** DESIGN §7 row 4: a run that settles inside this window never draws anything at all. */
export const BUSY_QUIET_MS = 450

export type Rung = '0' | '1' | '2' | '4' | '5'

export function rungOf(chip: ChipVM, busySince: number, now: number): Rung {
  if (chip.tone === 'warn' || chip.tone === 'danger') return '4'
  if (chip.tone === 'busy' || chip.spinner) {
    return now - busySince < BUSY_QUIET_MS ? '0' : '2'
  }
  if (chip.tone === 'info') return '5'
  return '1'
}

const RUNG_GLYPH: Record<Rung, string> = {
  '0': 'cc-i-arc',
  '1': 'cc-i-arc',
  '2': 'cc-i-arc',
  '4': 'cc-i-warn',
  '5': 'cc-i-arc',
}

export function createChipSlot(doc: Document, live: boolean): HTMLElement {
  const slot = el(doc, 'span', { class: 'cc-chip-slot' })
  if (live) slot.setAttribute('aria-live', 'polite')
  return slot
}

export interface ChipSlot {
  render(chip: ChipVM | null): void
  destroy(): void
}

/**
 * A slot that owns its own 450 ms timer. The controller cannot re-render for us — nothing in the
 * model changed when a run crosses the quiet window — so the rung is bumped from here and only
 * ever forward.
 */
export function createChip(doc: Document, slot: HTMLElement): ChipSlot {
  let busySince = 0
  let timer = 0
  const view = doc.defaultView

  function clearTimer(): void {
    if (timer && view) view.clearTimeout(timer)
    timer = 0
  }

  return {
    render(chip) {
      if (!chip) {
        clearTimer()
        busySince = 0
        if (slot.firstChild) slot.replaceChildren()
        return
      }

      const busy = chip.tone === 'busy' || chip.spinner
      if (!busy) {
        clearTimer()
        busySince = 0
      } else if (busySince === 0) {
        busySince = Date.now()
      }

      let node = slot.querySelector<HTMLElement>('.cc-chip')
      let mark: Element | null = node?.querySelector('.cc-chip-mark') ?? null
      let text: HTMLElement | null = node?.querySelector<HTMLElement>('.cc-chip-text') ?? null
      if (!node) {
        mark = icon(doc, 'cc-i-arc', 'cc-chip-mark')
        text = el(doc, 'span', { class: 'cc-chip-text' })
        node = el(doc, 'span', { class: 'cc-chip' }, [mark, text])
        slot.replaceChildren(node)
      }

      const rung = rungOf(chip, busySince, Date.now())
      setAttr(node, 'data-tone', chip.tone)
      setAttr(node, 'data-rung', rung)
      // The tooltip is the browser's, so the collapsed rungs stay readable on hover for nothing.
      setAttr(node, 'title', chip.text)
      if (mark) setIcon(mark, RUNG_GLYPH[rung])
      if (text) setText(text, chip.text)

      // Cross the quiet window without a model change: schedule the one attribute write that
      // takes rung 0 to rung 2, and never schedule a second.
      if (rung === '0' && !timer && view) {
        timer = view.setTimeout(() => {
          timer = 0
          const live = slot.querySelector<HTMLElement>('.cc-chip')
          if (live?.getAttribute('data-rung') === '0') live.setAttribute('data-rung', '2')
        }, BUSY_QUIET_MS)
      }
    },

    destroy() {
      clearTimer()
    },
  }
}

/* --------------------------------------------------------------------------- state marks */

const MARK_GLYPH: Record<string, string> = {
  resolved: 'cc-i-check',
  orphaned: 'cc-i-pin-off',
  approximate: 'cc-i-tilde',
}

/**
 * §1.3: colour never carries state alone, and neither does motion. Every state also has a drawn
 * glyph that reads identically in a screenshot, under `prefers-reduced-motion` and under
 * `forced-colors`. These are 10 px `<use>` instances rather than CSS `content`, so the guarantee
 * is made of shapes rather than of a font that may not be installed.
 */
export function renderMarks(
  doc: Document,
  node: HTMLElement,
  flags: { resolved: boolean; orphaned: boolean; approximate: boolean },
): void {
  const marks = [
    flags.resolved ? 'resolved' : null,
    flags.orphaned ? 'orphaned' : null,
    flags.approximate ? 'approximate' : null,
  ].filter((mark): mark is string => mark !== null)
  const key = marks.join(',')
  if (node.getAttribute('data-marks') === key) return
  node.setAttribute('data-marks', key)
  node.replaceChildren(
    ...marks.map((mark) => {
      const glyph = icon(doc, MARK_GLYPH[mark], 'cc-mark')
      glyph.setAttribute('data-mark', mark)
      return glyph
    }),
  )
}
