/**
 * Placement mode — DESIGN §7 rows 18–20 and §8.2.
 *
 * **The hole is the highlight.** The scrim is a full-viewport wash punched with an evenodd
 * `clip-path` 4 px outside the candidate, plus four 6 px corner ticks — ticks survive on
 * backgrounds where a full ring dissolves, and the whole thing is drawn in *our* layer, so the
 * host page is never dimmed, blurred, frozen or touched. That is not a stylistic preference: the
 * page belongs to someone else, and mutating it to draw a highlight is a mutation in every sense
 * except the DOM's.
 *
 * The layer stays `pointer-events: none`, non-negotiably. The engine resolves the pick target
 * from `composedPath()[0]` and does not filter shadow trees, so a single interactive node here
 * would make our own overlay the candidate and anchor the thread on the highlight.
 *
 * The outline **slides** between candidates rather than blinking on and off: one instrument
 * scanning, not twelve boxes flickering. This is also the one surface a presentation is allowed
 * to position itself — nothing here is registered through `host.anchor()`, the controller already
 * recomputes the candidate rect every frame, and a positioning pass could add nothing.
 *
 * The hint is deliberately rationed: once per mount for 2.5 s, and again after 700 ms of dwell on
 * one candidate — i.e. exactly when someone has stopped and is wondering. The sentence itself is
 * always in the controller's `role="status"` region regardless, so a screen reader never depends
 * on this timing.
 */

import type { PickerVM } from '../../presentation.ts'
import type { HueOf } from './kind.ts'

import { el, setAttr, setText } from '../../dom.ts'
import { icon, kindIcon, setIcon } from './icons.ts'
import { applyHue } from './kind.ts'

/** §7 row 19: the first pick session of a mount explains itself, for this long, once. */
const INTRO_MS = 2500
/** …and after this much stillness on one candidate, so does every session after it. */
const DWELL_MS = 700
/** §7 row 20: a candidate this large is probably not what you meant. */
const BAD_TARGET_RATIO = 0.72

export interface Picker {
  render(picker: PickerVM | null, hueOf: HueOf): void
  destroy(): void
}

export function createPicker(doc: Document, win: Window, layer: HTMLElement): Picker {
  const scrim = el(doc, 'div', { class: 'cc-scrim', 'aria-hidden': 'true', hidden: true })
  const ring = el(doc, 'div', { class: 'cc-ring', 'aria-hidden': 'true', hidden: true })
  for (const corner of ['tl', 'tr', 'bl', 'br']) {
    ring.append(el(doc, 'span', { class: 'cc-tick', 'data-corner': corner }))
  }
  const hintText = el(doc, 'span', { class: 'cc-hint-text' })
  const hint = el(
    doc,
    'div',
    { class: 'cc-pick-hint cc-glass', 'aria-hidden': 'true', hidden: true },
    [hintText],
  )
  const cursorGlyph = icon(doc, 'cc-i-comment', 'cc-icon')
  const cursor = el(doc, 'div', { class: 'cc-cursor', 'aria-hidden': 'true', hidden: true }, [
    cursorGlyph,
    el(doc, 'span', { class: 'cc-cursor-esc' }, ['⎋']),
  ])
  layer.append(scrim, ring, hint, cursor)

  let active = false
  let intro = true
  let dwellTimer = 0
  let dwellKey = ''
  let hintUntil = 0
  let frame = 0
  let x = 0
  let y = 0

  function moveCursor(): void {
    frame = 0
    // §8.2: the cursor glyph rides at (+14, +14). It is the most latency-sensitive surface in
    // the product, which is exactly why it is a `translate` write and nothing else.
    cursor.style.translate = `${String(Math.round(x + 14))}px ${String(Math.round(y + 14))}px`
  }

  function onMove(event: PointerEvent): void {
    x = event.clientX
    y = event.clientY
    if (frame) return
    frame = win.requestAnimationFrame(moveCursor)
  }
  const listener = onMove as (event: Event) => void

  function stopDwell(): void {
    if (dwellTimer) win.clearTimeout(dwellTimer)
    dwellTimer = 0
  }

  function showHint(ms: number): void {
    hintUntil = Date.now() + ms
    setAttr(hint, 'hidden', false)
    win.setTimeout(() => {
      if (Date.now() >= hintUntil) setAttr(hint, 'hidden', true)
    }, ms + 16)
  }

  function enter(): void {
    if (active) return
    active = true
    win.addEventListener('pointermove', listener, { passive: true })
    setAttr(cursor, 'hidden', false)
    if (intro) {
      intro = false
      showHint(INTRO_MS)
    }
  }

  function leave(): void {
    if (!active) return
    active = false
    win.removeEventListener('pointermove', listener)
    if (frame) win.cancelAnimationFrame(frame)
    frame = 0
    stopDwell()
    dwellKey = ''
    setAttr(scrim, 'hidden', true)
    setAttr(ring, 'hidden', true)
    setAttr(hint, 'hidden', true)
    setAttr(cursor, 'hidden', true)
  }

  return {
    render(picker, hueOf) {
      if (!picker) {
        leave()
        return
      }
      enter()
      setText(hintText, picker.hint)
      setIcon(cursorGlyph, kindIcon(picker.kind))
      setAttr(ring, 'data-kind', picker.kind)
      setAttr(cursor, 'data-kind', picker.kind)
      // §2.3: the ring and the cursor disc are the two surfaces that answer "which mode am I in"
      // before anything has been placed, so they are the two that must not be the same blue.
      applyHue(ring, hueOf, picker.kind)
      applyHue(cursor, hueOf, picker.kind)

      const rect = picker.rect
      if (!rect) {
        setAttr(scrim, 'hidden', true)
        setAttr(ring, 'hidden', true)
        stopDwell()
        dwellKey = ''
        return
      }

      const left = Math.round(rect.x)
      const top = Math.round(rect.y)
      const width = Math.round(rect.width)
      const height = Math.round(rect.height)

      ring.style.translate = `${String(left)}px ${String(top)}px`
      ring.style.width = `${String(width)}px`
      ring.style.height = `${String(height)}px`
      // The punch, 4 px outset with a 6 px round, as one evenodd path: the outer rectangle is the
      // viewport, the inner one is the hole. One property, one composited layer, no second node.
      scrim.style.setProperty('--_hx', `${String(left - 4)}px`)
      scrim.style.setProperty('--_hy', `${String(top - 4)}px`)
      scrim.style.setProperty('--_hw', `${String(width + 8)}px`)
      scrim.style.setProperty('--_hh', `${String(height + 8)}px`)

      const viewport = Math.max(1, win.innerWidth * win.innerHeight)
      const covers = (width * height) / viewport
      // Wordlessly: "probably not what you want".
      setAttr(ring, 'data-bad', covers > BAD_TARGET_RATIO ? 'true' : null)

      // The hint has a **fixed home** (bottom centre, in the sheet) and is not moved per
      // candidate. Riding the candidate put it over the line above the target — the one line the
      // eye is using to decide — and left it at `translate 0 0`, clipped under the host's own
      // toolbar, whenever the session was opened from the keyboard with the pointer at rest.
      // §7 row 19 rations it and gives it a rise; it never said where it lives.
      setAttr(scrim, 'hidden', false)
      setAttr(ring, 'hidden', false)

      const key = `${String(left)}:${String(top)}:${String(width)}:${String(height)}`
      if (key !== dwellKey) {
        dwellKey = key
        stopDwell()
        dwellTimer = win.setTimeout(() => {
          dwellTimer = 0
          showHint(2200)
        }, DWELL_MS)
      }
    },

    destroy() {
      leave()
      scrim.remove()
      ring.remove()
      hint.remove()
      cursor.remove()
    },
  }
}
