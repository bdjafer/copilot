/**
 * `comment-core/anchor` (§1.1) — capture / resolve / score / fingerprint / strategies.
 *
 * Needs a DOM, but only an **injectable** one: every entry point takes `options.document`, and
 * nothing here touches `document` at module scope, so the root barrel stays importable with the
 * globals deleted (§9).
 */

export { captureTarget } from './target.ts'
// `sanitizeHtml` stays internal: §2.5 exposes that seam as `CaptureOptions.sanitize`
// ("Replaces the built-in sanitizer"), and §2 lists no `sanitizeHtml` export.
export { captureElement } from './capture.ts'
export { fingerprintElement } from './fingerprint.ts'
export { scoreCandidate } from './score.ts'
export { explainAnchor, resolveAnchor } from './resolve.ts'
export { defaultStrategies, defineSelectorStrategy } from './strategies/index.ts'

export type {
  AnchorAttempt,
  AnchorExplanation,
  AnchorMatch,
  CaptureOptions,
  DescribeContext,
  ResolveContext,
  ResolveOptions,
  SelectorStrategy,
} from './types.ts'

/* The DOM-free half of the anchoring vocabulary lives in `src/types.ts` (§1.1) and is
   re-exported here so `comment-core/anchor` is a complete entry point on its own. */
export type {
  AnchorDescriptor,
  BuiltinSelector,
  CustomSelector,
  DocumentRect,
  ElementCapture,
  ElementFingerprint,
  MatchVia,
  Selector,
} from '../types.ts'
