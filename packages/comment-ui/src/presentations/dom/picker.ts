/**
 * Placement-mode highlight: an overlay drawn from `PickerVM.rect`.
 *
 * The picker is deliberately **not** an anchored surface (§3.1.5): the controller already has
 * the candidate rect and recomputes it every frame, so there is nothing a positioning pass could
 * add. This is the one place a presentation writes `left`/`top`/`width`/`height` itself, and it
 * is allowed precisely because no node here is registered with `host.anchor()`.
 *
 * The overlay is `pointer-events: none` and lives in the shadow layer, so the highlight never
 * intercepts the click that places the thread and **the host page's DOM is never mutated** —
 * no wrapper span, no injected outline, no attribute (PLAN §3.3). The `data-picking` guard that
 * makes the *rest* of the layer click-through is the controller's, not this file's.
 */

import type { PickerVM } from '../../presentation.ts'

import { el, setAttr, setText } from '../../dom.ts'

export interface Picker {
  render(picker: PickerVM | null): void
  destroy(): void
}

export function createPicker(doc: Document, layer: HTMLElement): Picker {
  const box = el(doc, 'div', { class: 'cc-picker', 'aria-hidden': 'true', hidden: true })
  const hint = el(doc, 'div', { class: 'cc-pick-hint', 'aria-hidden': 'true', hidden: true })
  layer.append(box, hint)

  return {
    render(picker) {
      if (!picker) {
        setAttr(box, 'hidden', true)
        setAttr(hint, 'hidden', true)
        return
      }
      setText(hint, picker.hint)
      setAttr(box, 'data-kind', picker.kind)
      const rect = picker.rect
      if (!rect) {
        setAttr(box, 'hidden', true)
        setAttr(hint, 'hidden', true)
        return
      }
      box.style.left = `${String(Math.round(rect.x))}px`
      box.style.top = `${String(Math.round(rect.y))}px`
      box.style.width = `${String(Math.round(rect.width))}px`
      box.style.height = `${String(Math.round(rect.height))}px`
      hint.style.left = `${String(Math.round(rect.x))}px`
      hint.style.top = `${String(Math.max(0, Math.round(rect.y) - 26))}px`
      setAttr(box, 'hidden', false)
      setAttr(hint, 'hidden', false)
    },

    destroy() {
      box.remove()
      hint.remove()
    },
  }
}
