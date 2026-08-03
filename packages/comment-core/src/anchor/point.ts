/**
 * The stored click point (§2.4 `AnchorPoint`, decision log #42, DESIGN §0 D8).
 *
 * Two halves, and they are deliberately the only two:
 *
 *  - `buildAnchorPoint` runs **once**, at capture, and writes the point four ways because they
 *    fail in different directions — `dx/dy` is exact while a box keeps its size, `fx/fy` is the
 *    only thing that survives a responsive re-layout, and `docX/docY` is the only thing that
 *    survives the element vanishing.
 *  - `livePoint` runs **every anchoring pass** and is a read, never a write (§4.6.5): orphanhood
 *    is still never a write, and neither is a coordinate.
 */

import type { AnchorPoint, DocumentPoint, DocumentRect } from '../types.ts'

/** A box whose size is within this many px of the captured one counts as "the same box". */
const SAME_BOX_EPSILON = 1

/**
 * Snapshot where inside `element` the user clicked. Viewport-space input, four representations
 * out. Never throws: an unmeasurable element yields a point that is still document-correct.
 */
export function buildAnchorPoint(
  element: Element,
  point: { readonly clientX: number; readonly clientY: number },
  meta: { confidence: number; landmark: boolean },
  doc?: Document,
): AnchorPoint {
  const view = (doc ?? element.ownerDocument ?? undefined)?.defaultView ?? null
  let left = 0
  let top = 0
  let width = 0
  let height = 0
  try {
    const box = element.getBoundingClientRect()
    left = box.left
    top = box.top
    width = box.width
    height = box.height
  } catch {
    /* a detached node still deserves a document-space point */
  }
  const dx = point.clientX - left
  const dy = point.clientY - top
  return Object.freeze({
    dx,
    dy,
    fx: width > 0 ? dx / width : 0,
    fy: height > 0 ? dy / height : 0,
    docX: point.clientX + (view?.scrollX ?? 0),
    docY: point.clientY + (view?.scrollY ?? 0),
    viewport: Object.freeze({
      width: view?.innerWidth ?? 0,
      height: view?.innerHeight ?? 0,
      dpr: view?.devicePixelRatio ?? 1,
    }),
    confidence: meta.confidence,
    landmark: meta.landmark,
  })
}

/**
 * Rehydrate a stored point against the live rect (§2.3 `Anchoring.point`). Derivation, per pass,
 * never a write:
 *
 *  - anchored, box the same size ⇒ `rect.left + dx`, `rect.top + dy`
 *  - anchored, box resized ⇒ `rect.left + fx * rect.width`, `rect.top + fy * rect.height`
 *  - orphaned (no element) ⇒ `docX / docY`, the value that needs no element at all
 *
 * The captured box size is recovered from the two representations themselves (`w = dx / fx`),
 * which is exact whenever the click was not on the box's own edge — and where it *was*, both
 * branches agree to the pixel, so the choice cannot matter.
 */
export function livePoint(
  point: AnchorPoint | undefined,
  rect: DocumentRect | null,
  anchored: boolean,
): DocumentPoint | null {
  if (!point) return null
  if (!anchored || !rect) return { x: point.docX, y: point.docY }
  const capturedWidth = point.fx !== 0 ? point.dx / point.fx : rect.width
  const capturedHeight = point.fy !== 0 ? point.dy / point.fy : rect.height
  const same =
    Math.abs(capturedWidth - rect.width) <= SAME_BOX_EPSILON &&
    Math.abs(capturedHeight - rect.height) <= SAME_BOX_EPSILON
  return same
    ? { x: rect.left + point.dx, y: rect.top + point.dy }
    : { x: rect.left + point.fx * rect.width, y: rect.top + point.fy * rect.height }
}

export function samePoint(a: DocumentPoint | null, b: DocumentPoint | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y
}
