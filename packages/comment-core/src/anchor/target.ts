/**
 * `captureTarget` (§2.5) — one call, because a Thread never has an anchor without a capture
 * (decision log #19).
 *
 * §4.6.1: every strategy's `describe` runs in weight order and non-null results become
 * `AnchorDescriptor.selectors`; the same strategy objects supply `resolve` at anchoring time,
 * which is what makes a custom locator like §7.4's `x-row-id` written as well as read.
 *
 * Never throws: a detached node yields a low-signal descriptor.
 */

import type { AnchorDescriptor, ElementCapture, ElementFingerprint, Selector } from '../types.ts'
import type { AnyStrategy, CaptureOptions, DescribeContext, TargetAssessment } from './types.ts'

import { assessTarget } from './assess.ts'
import { captureElement } from './capture.ts'
import { closestOf, elementOf, isRange, ownerDocumentOf } from './dom.ts'
import { fingerprintElement } from './fingerprint.ts'
import { buildAnchorPoint } from './point.ts'
import { byWeight, mergeStrategies } from './strategies/index.ts'

/** What a target with no live element still yields, so a Thread is always well-formed. */
const EMPTY_FINGERPRINT: ElementFingerprint = {
  tag: '',
  stableClasses: [],
  attrs: {},
  textDigest: '',
}

/**
 * Snapshot a target into everything a Thread needs. A Thread never has an anchor without a
 * capture, so this is one call. Never throws: a detached node yields a low-signal descriptor.
 */
export function captureTarget(
  target: Element | Range,
  options?: CaptureOptions,
): { anchor: AnchorDescriptor; capture: ElementCapture } {
  const doc = options?.document ?? ownerDocumentOf(target)

  // §4.6 step 0 (decision log #43): assess *before* anything else. A confident target changes
  // nothing and the rest of the pipeline sees the element it always saw; a low-confidence one
  // hands the whole capture over to the landmark `assessTarget` chose, because a thread bolted to
  // a 100vh layout wrapper is the failure this exists to prevent.
  const assessment = assessOf(target, options, doc)
  const described: Element | Range = assessment ? assessment.anchor : target

  const element = elementOf(described)
  const mode: AnchorDescriptor['mode'] = isRange(described) ? 'text' : 'element'

  const selectors: Selector[] = []
  if (doc) {
    const ctx: DescribeContext = { document: doc, closest: closestOf }
    const strategies = mergeStrategies(options?.strategies as readonly AnyStrategy[] | undefined)
    for (const strategy of strategies.sort(byWeight)) {
      let payload: object | null = null
      try {
        payload = strategy.describe(described, ctx) as object | null
      } catch {
        payload = null // an abstention, never a fault
      }
      if (payload) selectors.push({ ...payload, type: strategy.type } as Selector)
    }
  }

  let fingerprint = EMPTY_FINGERPRINT
  if (element) {
    try {
      fingerprint = fingerprintElement(element)
    } catch {
      fingerprint = EMPTY_FINGERPRINT
    }
  }

  const anchor: AnchorDescriptor = { mode, selectors, fingerprint }
  // §2.4: additive and written once. A path with no click — keyboard, a selection, a host calling
  // `captureTarget` directly — has no coordinate, and must never invent one. A text anchor is a
  // *quote*, and §4.5 states outright that selection placement has no point.
  const click = mode === 'element' ? options?.point : undefined
  if (click && element) {
    anchor.point = buildAnchorPoint(
      element,
      click,
      {
        confidence: assessment?.confidence ?? 1,
        landmark: assessment?.landmark ?? false,
      },
      doc ?? undefined,
    )
  }

  return { anchor, capture: captureElement(described, options) }
}

/**
 * Step 0's guard. Assessment runs only for an element target with a click point: a `Range` is a
 * quote, and redirecting a quote to a landmark would silently change what the thread is about.
 */
function assessOf(
  target: Element | Range,
  options: CaptureOptions | undefined,
  doc: Document | null,
): TargetAssessment | null {
  if (!options?.point || isRange(target)) return null
  const element = elementOf(target)
  if (!element) return null
  try {
    return assessTarget(element, {
      point: options.point,
      ...(doc ? { document: doc } : {}),
      ...options.assess,
    })
  } catch {
    return null // §2.5: never throws, and a heuristic that fails must not cost the capture
  }
}
