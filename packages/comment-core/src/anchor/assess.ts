/**
 * `assessTarget` (§2.5, decision log #43, DESIGN §0 D8) — **target confidence**.
 *
 * Figma's oldest anchoring rule — "a pin attaches to the top-level frame it was dropped in, never
 * to a nested layer" — ported to a DOM nobody controls. `document.elementFromPoint` is happy to
 * hand back `<body>`, a 100vh layout wrapper or an empty spacer `<div>`; anchoring a thread to any
 * of those is what makes a click in a page's right margin behave like nonsense.
 *
 * Pure, synchronous, DOM-reading, **never throws**, and every branch is bounded (8 hops, depth 3,
 * 200 elements, 240 px) so a click can never cost more than a resolve does.
 *
 * The whole heuristic is capture-side on purpose (§4.6 step 0): it is a judgement about *what a
 * thread is about*, made once, while the page is still exactly what the user was looking at.
 */

import type { AssessOptions, TargetAssessment, TargetRejection } from './types.ts'

import { fingerprintElement } from './fingerprint.ts'

/** §2.5: a target is low-confidence below this. */
export const DEFAULT_ASSESS_THRESHOLD = 0.5
/** §2.5: a border box at or above this fraction of the viewport is "probably the page". */
export const DEFAULT_MAX_VIEWPORT_FRACTION = 0.55
/** §2.5: how far from the click point the nearest-confident-descendant branch will look. */
export const DEFAULT_SEARCH_RADIUS = 240

const MAX_HOPS = 8
const MAX_DEPTH = 3
const MAX_EXAMINED = 200

/** §2.5's weights. `root` is fatal and is not in the table. */
const WEIGHTS: Readonly<Record<Exclude<TargetRejection, 'root'>, number>> = {
  'viewport-fraction': 0.45,
  'no-own-content': 0.35,
  'no-identity': 0.3,
  'passthrough-wrapper': 0.25,
}

/** §2.5's landmark set — what step 1 of the walk is allowed to redirect to. */
export const LANDMARK_SELECTOR =
  'main, article, section, aside, header, footer, nav, form, figure, table, li, ' +
  'h1, h2, h3, h4, h5, h6, [role], [id], [data-testid], [data-test], [data-cy]'

/** Replaced / media content: a box holding one of these is *about* something. */
const REPLACED = 'img, svg, video, canvas, picture, iframe, input, button'

/**
 * "Not a semantic tag" means the two elements the platform gives no meaning to. Everything else
 * names what it is, which is exactly the identity signal this rejection is looking for.
 */
const GENERIC_TAGS = new Set(['div', 'span'])

function viewOf(doc: Document | undefined): Window | null {
  return doc?.defaultView ?? null
}

function safeRect(element: Element): { x: number; y: number; w: number; h: number } {
  try {
    const box = element.getBoundingClientRect()
    return { x: box.left, y: box.top, w: box.width, h: box.height }
  } catch {
    return { x: 0, y: 0, w: 0, h: 0 }
  }
}

function matchesSafely(element: Element, selector: string): boolean {
  try {
    return element.matches(selector)
  } catch {
    return false
  }
}

/** Own non-whitespace text: text nodes that are direct children, never a descendant's. */
function hasOwnText(element: Element): boolean {
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType !== 3) continue
    if ((node.textContent ?? '').trim() !== '') return true
  }
  return false
}

function hasReplacedChild(element: Element): boolean {
  for (const child of Array.from(element.children)) {
    if (matchesSafely(child, REPLACED)) return true
  }
  return false
}

function hasIdentity(element: Element): boolean {
  if (element.id) return true
  if (!GENERIC_TAGS.has(element.tagName.toLowerCase())) return true
  for (const name of Array.from(element.getAttributeNames?.() ?? [])) {
    if (name.startsWith('data-')) return true
  }
  try {
    if (fingerprintElement(element).stableClasses.length > 0) return true
  } catch {
    /* a fingerprint that cannot be taken is not evidence of identity */
  }
  return false
}

function isPassthroughWrapper(element: Element): boolean {
  const children = element.children
  if (children.length !== 1) return false
  const only = children[0]
  if (!only) return false
  const own = safeRect(element)
  const inner = safeRect(only)
  const area = own.w * own.h
  if (area <= 0) return false
  return (inner.w * inner.h) / area >= 0.95
}

function isRoot(element: Element, doc: Document | undefined): boolean {
  const tag = element.tagName.toLowerCase()
  if (tag === 'html' || tag === 'body') return true
  return doc !== undefined && element === doc.scrollingElement
}

/** §2.5's rejection table, as a pure read. */
export function rejectionsOf(
  element: Element,
  doc: Document | undefined,
  maxViewportFraction: number,
): TargetRejection[] {
  const rejections: TargetRejection[] = []
  if (isRoot(element, doc)) return ['root']

  const view = viewOf(doc)
  const viewport = Math.max(1, (view?.innerWidth ?? 0) * (view?.innerHeight ?? 0))
  const box = safeRect(element)
  if (view && (box.w * box.h) / viewport >= maxViewportFraction)
    rejections.push('viewport-fraction')
  if (!hasOwnText(element) && !hasReplacedChild(element)) rejections.push('no-own-content')
  if (!hasIdentity(element)) rejections.push('no-identity')
  if (isPassthroughWrapper(element)) rejections.push('passthrough-wrapper')
  return rejections
}

function scoreOf(rejections: readonly TargetRejection[]): number {
  if (rejections.includes('root')) return 0
  let sum = 0
  for (const rejection of rejections) {
    if (rejection === 'root') continue
    sum += WEIGHTS[rejection]
  }
  return Math.min(1, Math.max(0, 1 - sum))
}

/** Euclidean distance from a viewport point to the nearest edge of a box; 0 when inside. */
function distanceTo(
  box: { x: number; y: number; w: number; h: number },
  px: number,
  py: number,
): number {
  const dx = Math.max(box.x - px, 0, px - (box.x + box.w))
  const dy = Math.max(box.y - py, 0, py - (box.y + box.h))
  return Math.hypot(dx, dy)
}

function confidenceOf(element: Element, doc: Document | undefined, fraction: number): number {
  return scoreOf(rejectionsOf(element, doc, fraction))
}

/**
 * **Target confidence.** See `docs/SPEC-comment-core.md` §2.5 for the normative table.
 *
 * `confidence = clamp(1 - Σ weights, 0, 1)`; a target is **low-confidence below 0.50**. On
 * rejection the anchor moves — `closest()` over the landmark set (≤ 8 hops), else the nearest
 * confident descendant within 240 px of the point (depth ≤ 3, ≤ 200 examined), else
 * `document.scrollingElement` — and the click point is stored relative to *that*.
 */
export function assessTarget(element: Element, options?: AssessOptions): TargetAssessment {
  const doc = options?.document ?? element.ownerDocument ?? undefined
  const threshold = options?.threshold ?? DEFAULT_ASSESS_THRESHOLD
  const fraction = options?.maxViewportFraction ?? DEFAULT_MAX_VIEWPORT_FRACTION
  const radius = options?.searchRadius ?? DEFAULT_SEARCH_RADIUS
  const landmarks = options?.landmarks ?? LANDMARK_SELECTOR

  const rejections = rejectionsOf(element, doc, fraction)
  const confidence = scoreOf(rejections)
  if (confidence >= threshold) {
    return Object.freeze({
      element,
      confidence,
      rejections: Object.freeze(rejections),
      anchor: element,
      landmark: false,
    })
  }

  const anchor =
    walkToLandmark(element, doc, landmarks, threshold, fraction) ??
    nearestConfidentDescendant(element, doc, options?.point, threshold, fraction, radius) ??
    fallbackRoot(element, doc)

  return Object.freeze({
    element,
    confidence,
    rejections: Object.freeze(rejections),
    anchor,
    landmark: anchor !== element,
  })
}

/** Step 1 — the first ancestor-or-self in the landmark set that scores ≥ threshold, ≤ 8 hops. */
function walkToLandmark(
  element: Element,
  doc: Document | undefined,
  landmarks: string,
  threshold: number,
  fraction: number,
): Element | null {
  let current: Element | null = element
  for (let hop = 0; current && hop <= MAX_HOPS; hop += 1) {
    if (matchesSafely(current, landmarks) && confidenceOf(current, doc, fraction) >= threshold) {
      return current
    }
    current = current.parentElement
  }
  return null
}

/**
 * Step 2 — the nearest confident descendant to the point. This is the branch that rescues a click
 * in a page's empty right margin: it anchors to the article column beside the cursor.
 */
function nearestConfidentDescendant(
  element: Element,
  doc: Document | undefined,
  point: { readonly clientX: number; readonly clientY: number } | undefined,
  threshold: number,
  fraction: number,
  radius: number,
): Element | null {
  if (!point) return null
  let examined = 0
  let best: Element | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  let level: Element[] = Array.from(element.children)
  for (let depth = 1; depth <= MAX_DEPTH && level.length > 0; depth += 1) {
    const next: Element[] = []
    for (const candidate of level) {
      if (examined >= MAX_EXAMINED) return best
      examined += 1
      const box = safeRect(candidate)
      const distance = distanceTo(box, point.clientX, point.clientY)
      if (
        distance <= radius &&
        distance < bestDistance &&
        confidenceOf(candidate, doc, fraction) >= threshold
      ) {
        best = candidate
        bestDistance = distance
      }
      if (depth < MAX_DEPTH) next.push(...Array.from(candidate.children))
    }
    level = next
  }
  return best
}

/** Step 3 — never a failure, ever. */
function fallbackRoot(element: Element, doc: Document | undefined): Element {
  return doc?.scrollingElement ?? doc?.documentElement ?? element
}
