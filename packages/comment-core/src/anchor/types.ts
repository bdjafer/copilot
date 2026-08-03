/**
 * DOM-dependent anchoring types (§2.4 `AnchorMatch`, §2.5 the whole anchoring API surface).
 *
 * Deliberately **not** in `src/types.ts`: everything here names `Element`, `Range`, `Document`
 * or `ParentNode`, and `src/types.ts` is the type half of `comment-core/headless`, whose
 * emitted declarations must reference no `lib.dom` identifier (§1.1). The DOM-free halves of
 * the anchoring vocabulary — `AnchorDescriptor`, `Selector`, `ElementFingerprint`,
 * `ElementCapture`, `MatchVia` — stay there and are re-exported from here by `anchor/index.ts`.
 */

import type {
  AnchorDescriptor,
  ElementCapture,
  ElementFingerprint,
  MatchVia,
  Selector,
} from '../types.ts'

/* -------------------------------------------------------------------------------------- §2.4 */

export interface AnchorMatch {
  element: Element
  range: Range | null
  confidence: number
  via: MatchVia
}

/* -------------------------------------------------------------------------------------- §2.5 */

/* ------------------------------------------------------------------- §2.5 target confidence */

export type TargetRejection =
  | 'root'
  | 'viewport-fraction'
  | 'no-own-content'
  | 'no-identity'
  | 'passthrough-wrapper'

export interface TargetAssessment {
  /** What was examined — `document.elementFromPoint`'s answer. */
  readonly element: Element
  /** 0..1. */
  readonly confidence: number
  readonly rejections: readonly TargetRejection[]
  /** What to anchor to: `element` when confident, else the landmark chosen by the walk. */
  readonly anchor: Element
  /** `anchor !== element`. */
  readonly landmark: boolean
}

export interface AssessOptions {
  document?: Document
  /** The point, for the nearest-descendant branch. Without it, only step 1 and step 3 run. */
  point?: { readonly clientX: number; readonly clientY: number }
  /** Accept score. Default 0.50. */
  threshold?: number
  /** Fraction of viewport area that triggers `viewport-fraction`. Default 0.55. */
  maxViewportFraction?: number
  /** Descendant-search radius in px. Default 240. */
  searchRadius?: number
  /** CSS selector for step 1. Defaults to the landmark set of §2.5. */
  landmarks?: string
}

export interface CaptureOptions {
  /** Defaults to target's ownerDocument. */
  document?: Document
  /**
   * The viewport point the user clicked (decision log #42/#43). When present, `captureTarget`
   * runs `assessTarget` on the target first: a **low-confidence** target is not anchored to —
   * the descriptor is built for the landmark `assessTarget` chose instead — and the point is
   * stored on `AnchorDescriptor.point`, relative to whichever element was chosen.
   * Absent ⇒ no assessment, no `point`, and byte-identical behaviour to before the field existed.
   */
  point?: { readonly clientX: number; readonly clientY: number }
  /** Overrides for the confidence heuristic. See `assessTarget`. */
  assess?: AssessOptions
  /** Extra strategies, merged with defaultStrategies and sorted by weight. */
  strategies?: readonly SelectorStrategy[]
  /** outerHTML byte cap after sanitization. Default 8192. */
  htmlLimit?: number
  /** capture.text char cap. Default 2000. */
  textLimit?: number
  /** Replaces the built-in sanitizer (strips <script>, on* attrs, javascript: URLs). */
  sanitize?: (html: string) => string
  /** Last chance to strip PII before persistence. Runs after sanitize. */
  redact?: (capture: ElementCapture) => ElementCapture
  now?: () => Date
}

export interface ResolveOptions {
  /** Resolution scope. Default: `document`. Pass an added subtree for the cheap retry path. */
  root?: ParentNode
  document?: Document
  strategies?: readonly SelectorStrategy[]
  /** Accept score. Default 0.62. */
  threshold?: number
  /** fingerprint-scan candidate budget. Default 500. */
  scanLimit?: number
  /** Overrides scoreCandidate for every candidate. */
  scoring?: (element: Element, fingerprint: ElementFingerprint) => number
  /** Wall-clock budget in ms for one resolve. Default 12. Exceeded ⇒ return best-so-far/null. */
  budgetMs?: number
}

export interface AnchorExplanation {
  anchor: AnchorDescriptor
  attempts: readonly AnchorAttempt[]
  result: AnchorMatch | null
  totalMs: number
  budgetExceeded: boolean
}

export interface AnchorAttempt {
  selector: Selector | 'fingerprint-scan'
  /** Candidates the selector produced. */
  candidates: number
  /** Best fingerprint score among them, 0 when none. */
  best: number
  accepted: boolean
  ms: number
}

export interface DescribeContext {
  document: Document
  /** target.closest() that also works for a Range (uses commonAncestorContainer). */
  closest(target: Element | Range, selector: string): Element | null
}

export interface ResolveContext {
  root: ParentNode
  document: Document
  /** Remaining ms in this resolve's budget. Strategies must respect it. */
  budgetMs: number
}

/**
 * Custom locator. `verify` is not a choice: every candidate is fingerprint-verified.
 * `S` is constrained to `{ type: string }` rather than `Selector` so a synthesized
 * `{ type: 'x-row-id'; value: string }` from `defineSelectorStrategy` fits without the
 * implicit-index-signature dance; every persisted selector still satisfies `Selector`.
 */
export interface SelectorStrategy<S extends { type: string } = Selector> {
  /** Must be a BuiltinSelector['type'] to replace a builtin, or `x-*` for a custom one. */
  type: S['type']
  /** Higher runs first. Builtins: attr 90, css 80, textQuote 70, nthPath 40, textPosition 30. */
  weight: number
  /** 'fuzzy' strategies are skipped on the MutationObserver fast path. Default 'cheap'. */
  cost?: 'cheap' | 'fuzzy'
  /** Produce the selector payload (minus `type`) for a target, or null to abstain. */
  describe(target: Element | Range, ctx: DescribeContext): Omit<S, 'type'> | null
  /** Produce candidates. Returning a Range implies mode 'text'. */
  resolve(selector: S, ctx: ResolveContext): Element | Range | Iterable<Element> | null
}

/**
 * What every internal call site passes strategies around as. A `SelectorStrategy<Selector>`
 * is assignable to it and so is every `defineSelectorStrategy` result, without either one
 * having to satisfy `CustomSelector`'s index signature.
 */
export type AnyStrategy = SelectorStrategy<{ type: string }>
