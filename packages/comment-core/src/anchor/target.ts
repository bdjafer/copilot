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
import type { AnyStrategy, CaptureOptions, DescribeContext } from './types.ts'

import { captureElement } from './capture.ts'
import { closestOf, elementOf, isRange, ownerDocumentOf } from './dom.ts'
import { fingerprintElement } from './fingerprint.ts'
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
  const element = elementOf(target)
  const mode: AnchorDescriptor['mode'] = isRange(target) ? 'text' : 'element'

  const selectors: Selector[] = []
  if (doc) {
    const ctx: DescribeContext = { document: doc, closest: closestOf }
    const strategies = mergeStrategies(options?.strategies as readonly AnyStrategy[] | undefined)
    for (const strategy of strategies.sort(byWeight)) {
      let payload: object | null = null
      try {
        payload = strategy.describe(target, ctx) as object | null
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

  return {
    anchor: { mode, selectors, fingerprint },
    capture: captureElement(target, options),
  }
}
