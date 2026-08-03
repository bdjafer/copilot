/**
 * Placement mode — DESIGN §0 D7, §7 rows 18–20, §8.2.
 *
 * **Nothing is drawn.** This file used to build a scrim punched with an evenodd `clip-path`, a
 * sliding ring, four corner ticks, a rationed dwell hint and a cursor-riding disc. Every one of
 * them is deleted: the decree's ruling is that an inspect-element frame over someone's page is
 * exactly the wrong idea, however admired the hole-is-the-highlight trick was (§13 ruling 11).
 *
 * What is left is a **cursor**, and that is the whole surface: its hotspot is the pin's sharp
 * corner, so the thing the user is aiming with is the point that gets stored (§8.2). A
 * low-confidence candidate swaps the image to the hollow variant — "this will attach to the block,
 * not to that" — and still draws nothing (§7 row 20).
 *
 * The cursor reaches the host document through `PresentationHost.cursor()`, never from here: the
 * controller owns the one constructed `CSSStyleSheet` and its lifetime, so "no presentation
 * touches the host document" stays a rule the type system enforces (SPEC decision log #46).
 *
 * `Labels.pickHint` still lands in the controller's `role="status"` region on every entry, so a
 * screen reader is told exactly what it was told before.
 */

import type { PickerVM, PresentationHost } from '../../presentation.ts'
import type { HueOf } from './kind.ts'

import { createCursorFactory } from './cursor.ts'

/** SPEC §2.5: a target is low-confidence below this, i.e. the click would hit a landmark. */
const LOW_CONFIDENCE = 0.5

export interface Picker {
  render(picker: PickerVM | null, hueOf: HueOf): void
  destroy(): void
}

export function createPicker(host: PresentationHost): Picker {
  const cursorFor = createCursorFactory()
  let applied: string | null = null

  function apply(value: string | null): void {
    if (value === applied) return
    applied = value
    host.cursor(value)
  }

  return {
    render(picker, hueOf) {
      if (!picker) {
        apply(null)
        return
      }
      // Decision log #48: `confidence` is published raw so a presentation may disagree about the
      // threshold; `landmark` answers the different question — "will this be redirected".
      const hollow = picker.landmark || picker.confidence < LOW_CONFIDENCE
      apply(cursorFor(hueOf(picker.kind), hollow ? 'hollow' : 'solid'))
    },

    destroy() {
      apply(null)
    },
  }
}
