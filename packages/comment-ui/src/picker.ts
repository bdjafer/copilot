/**
 * Placement-mode highlight (§5.2 `picker.ts`): an overlay drawn from `engine.placement`'s
 * `candidate`, which the engine updates on `mousemove` throttled to one animation frame.
 *
 * The overlay is `pointer-events: none` and lives in the shadow layer, so the highlight never
 * intercepts the click that places the thread and **the host page's DOM is never mutated** —
 * no wrapper span, no injected outline, no attribute (PLAN §3.3). `Labels.pickHint` is both
 * drawn next to the cursor and announced in the `role="status"` region.
 *
 * "Never intercepts" has to hold for the whole layer, not just the two overlay nodes: the
 * engine resolves the pick target from `composedPath()[0]` and does not filter shadow trees, so
 * anything of ours that is `pointer-events: auto` under the cursor becomes the `candidate` and
 * would anchor a thread on comment-ui's own DOM. While `picking`, this marks the layer
 * `data-picking="true"`, which turns every widget click-through (see `styles.ts`).
 *
 * The status region is cleared when placement ends, so re-entering placement re-announces:
 * `announce` writes the same string every time and `setText` is idempotent, so without the
 * clear the DOM would not change and no second live-region announcement would fire.
 */

import type { PlacementState } from '@astrale-os/comment-core'

import type { UIContext } from './context.ts'

import { el, setAttr, setText } from './dom.ts'

export interface Picker {
  render(state: PlacementState): void
  destroy(): void
}

export function createPicker(ctx: UIContext): Picker {
  const box = el(ctx.doc, 'div', { class: 'cc-picker', 'aria-hidden': 'true', hidden: true })
  const hint = el(ctx.doc, 'div', { class: 'cc-pick-hint', 'aria-hidden': 'true', hidden: true })
  setText(hint, ctx.labels.pickHint)
  ctx.layer.append(box, hint)

  let picking = false

  function place(candidate: Element | null): void {
    if (!candidate) {
      setAttr(box, 'hidden', true)
      setAttr(hint, 'hidden', true)
      return
    }
    const rect = candidate.getBoundingClientRect()
    box.style.left = `${String(Math.round(rect.left))}px`
    box.style.top = `${String(Math.round(rect.top))}px`
    box.style.width = `${String(Math.round(rect.width))}px`
    box.style.height = `${String(Math.round(rect.height))}px`
    hint.style.left = `${String(Math.round(rect.left))}px`
    hint.style.top = `${String(Math.max(0, Math.round(rect.top) - 26))}px`
    setAttr(box, 'hidden', false)
    setAttr(hint, 'hidden', false)
  }

  return {
    render(state) {
      if (state.phase !== 'picking') {
        if (picking) {
          picking = false
          setAttr(ctx.layer, 'data-picking', null)
          setAttr(box, 'hidden', true)
          setAttr(hint, 'hidden', true)
          ctx.announce('')
        }
        return
      }
      if (!picking) {
        picking = true
        setAttr(ctx.layer, 'data-picking', 'true')
        ctx.announce(ctx.labels.pickHint)
      }
      setAttr(box, 'data-kind', state.kind)
      place(state.candidate)
    },

    destroy() {
      setAttr(ctx.layer, 'data-picking', null)
      box.remove()
      hint.remove()
    },
  }
}
