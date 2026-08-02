/**
 * `resolveAnchor` / `explainAnchor` (§2.5), implementing the §4.6.2–4 pipeline:
 *
 *  2. strategies in weight order, `cheap` before `fuzzy`; **every** candidate is verified with
 *     `scoreCandidate` (tag match required) — Hypothesis's `maybeAssertQuote` discipline as a
 *     property of the pipeline, so a stale-but-valid CSS path can never silently attach to the
 *     wrong element;
 *  3. the first candidate at or above `threshold` (0.62) wins; otherwise a fingerprint scan
 *     over the first `scanLimit` (500) same-tag elements in `root`; below threshold ⇒ `null`;
 *  4. in text mode the vendored TextQuote → TextPosition chain additionally produces
 *     `AnchorMatch.range`; a failed range with a successful element match yields `range: null`
 *     and `confidence` reduced by 0.15.
 *
 * Never throws. A strategy that throws is an abstention; a budget overrun returns
 * best-so-far/null.
 */

import type { AnchorDescriptor, ElementFingerprint, MatchVia, Selector } from '../types.ts'
import type {
  AnchorAttempt,
  AnchorExplanation,
  AnchorMatch,
  AnyStrategy,
  ResolveOptions,
} from './types.ts'

import { elementOf, elementOfNode, isElement, isRange, rootContains, textRootOf } from './dom.ts'
import { scoreCandidate } from './score.ts'
import { byCostThenWeight, mergeStrategies } from './strategies/index.ts'
import { matchQuote } from './vendor/hypothesis/match-quote.ts'
import { textOffsets, textPositionToRange } from './vendor/hypothesis/text-range.ts'

/** §2.5 defaults. */
export const DEFAULT_THRESHOLD = 0.62
export const DEFAULT_SCAN_LIMIT = 500
export const DEFAULT_BUDGET_MS = 12
/** §4.6.4: the penalty for an element match whose quote could not be re-located. */
export const RANGE_PENALTY = 0.15

const clock = (): number =>
  typeof performance === 'object' && typeof performance?.now === 'function'
    ? performance.now()
    : Date.now()

interface Candidate {
  element: Element
  range: Range | null
}

function toCandidates(produced: Element | Range | Iterable<Element> | null): Candidate[] {
  if (!produced) return []
  if (isRange(produced)) {
    const element = elementOfNode(produced.commonAncestorContainer)
    return element ? [{ element, range: produced }] : []
  }
  if (isElement(produced)) return [{ element: produced, range: null }]
  const out: Candidate[] = []
  try {
    for (const value of produced as Iterable<Element>) {
      if (isElement(value)) out.push({ element: value, range: null })
    }
  } catch {
    // A hostile iterable is an abstention, not a fault.
  }
  return out
}

interface ResolveRun {
  match: AnchorMatch | null
  attempts: AnchorAttempt[]
  totalMs: number
  budgetExceeded: boolean
}

function resolveDocument(options: ResolveOptions | undefined): Document | null {
  if (options?.document) return options.document
  const root = options?.root as Partial<Document> & Partial<Element> & Partial<Node>
  if (root) {
    if (root.nodeType === 9) return root as Document
    if (root.ownerDocument) return root.ownerDocument
  }
  return (globalThis as { document?: Document }).document ?? null
}

function run(anchor: AnchorDescriptor, options?: ResolveOptions): ResolveRun {
  const started = clock()
  const attempts: AnchorAttempt[] = []
  const doc = resolveDocument(options)
  if (!doc) return { match: null, attempts, totalMs: 0, budgetExceeded: false }

  const root: ParentNode = options?.root ?? doc
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD
  const scanLimit = options?.scanLimit ?? DEFAULT_SCAN_LIMIT
  const budgetMs = options?.budgetMs ?? DEFAULT_BUDGET_MS
  const score = options?.scoring ?? scoreCandidate
  const strategies = (options?.strategies as readonly AnyStrategy[] | undefined) ?? undefined
  const ordered = mergeStrategies(strategies).sort(byCostThenWeight)

  const elapsed = (): number => clock() - started
  let budgetExceeded = false
  let winner: (Candidate & { score: number; via: MatchVia }) | null = null

  const selectorsByType = new Map<string, Selector>()
  for (const selector of anchor.selectors) {
    if (!selectorsByType.has(selector.type)) selectorsByType.set(selector.type, selector)
  }

  for (const strategy of ordered) {
    if (winner) break
    const selector = selectorsByType.get(strategy.type)
    if (!selector) continue
    if (elapsed() >= budgetMs) {
      budgetExceeded = true
      break
    }

    const attemptStart = clock()
    let produced: Element | Range | Iterable<Element> | null = null
    try {
      produced = strategy.resolve(selector as never, {
        root,
        document: doc,
        budgetMs: Math.max(0, budgetMs - elapsed()),
      })
    } catch {
      produced = null // §2.5: never throws
    }

    const candidates = toCandidates(produced)
    let best = 0
    let accepted = false
    for (const candidate of candidates) {
      if (!rootContains(root, candidate.element)) continue
      const value = score(candidate.element, anchor.fingerprint)
      if (value > best) best = value
      if (value >= threshold) {
        // §4.6.3: the FIRST candidate at or above threshold wins.
        winner = { ...candidate, score: value, via: selector.type }
        accepted = true
        break
      }
    }
    attempts.push({
      selector,
      candidates: candidates.length,
      best,
      accepted,
      ms: clock() - attemptStart,
    })
  }

  if (!winner && !budgetExceeded) {
    const scan = fingerprintScan(anchor.fingerprint, root, {
      threshold,
      scanLimit,
      score,
      deadline: () => elapsed() >= budgetMs,
    })
    attempts.push(scan.attempt)
    if (scan.exceeded) budgetExceeded = true
    if (scan.winner) winner = scan.winner
  }

  if (!winner) return { match: null, attempts, totalMs: elapsed(), budgetExceeded }

  let confidence = winner.score
  let range = winner.range

  // §4.6.4 — text mode additionally runs the vendored TextQuote → TextPosition chain.
  if (anchor.mode === 'text' && !range) {
    range = locateQuote(anchor, winner.element, root, doc)
    if (!range) confidence = Math.max(0, confidence - RANGE_PENALTY)
  }

  return {
    match: { element: winner.element, range, confidence, via: winner.via },
    attempts,
    totalMs: elapsed(),
    budgetExceeded,
  }
}

function fingerprintScan(
  fingerprint: ElementFingerprint,
  root: ParentNode,
  ctx: {
    threshold: number
    scanLimit: number
    score: (element: Element, fingerprint: ElementFingerprint) => number
    deadline: () => boolean
  },
): {
  attempt: AnchorAttempt
  winner: (Candidate & { score: number; via: MatchVia }) | null
  exceeded: boolean
} {
  const started = clock()
  let scanned = 0
  let best = 0
  let bestElement: Element | null = null
  let exceeded = false

  let pool: Iterable<Element> = []
  try {
    pool = fingerprint.tag ? Array.from(root.querySelectorAll(fingerprint.tag)) : []
  } catch {
    pool = []
  }

  for (const element of pool) {
    if (scanned >= ctx.scanLimit) break
    if (ctx.deadline()) {
      exceeded = true
      break
    }
    scanned++
    const value = ctx.score(element, fingerprint)
    if (value > best) {
      best = value
      bestElement = element
    }
  }

  const accepted = best >= ctx.threshold && bestElement !== null
  return {
    attempt: {
      selector: 'fingerprint-scan',
      candidates: scanned,
      best,
      accepted,
      ms: clock() - started,
    },
    winner: accepted
      ? { element: bestElement!, range: null, score: best, via: 'fingerprint-scan' }
      : null,
    exceeded,
  }
}

/** The TextQuote → TextPosition chain, tried inside the matched element then across the root. */
function locateQuote(
  anchor: AnchorDescriptor,
  element: Element,
  root: ParentNode,
  doc: Document,
): Range | null {
  const quote = anchor.selectors.find((s) => s.type === 'textQuote') as
    | { type: 'textQuote'; exact: string; prefix: string; suffix: string }
    | undefined
  const position = anchor.selectors.find((s) => s.type === 'textPosition') as
    | { type: 'textPosition'; start: number; end: number }
    | undefined

  for (const scope of [element as Node, textRootOf(root, doc)]) {
    if (!scope) continue
    const { text } = textOffsets(scope)
    if (text === '') continue

    if (quote?.exact) {
      const hit = matchQuote(text, quote.exact, {
        prefix: quote.prefix || undefined,
        suffix: quote.suffix || undefined,
        hint: scope === element ? undefined : position?.start,
      })
      if (hit) {
        const range = textPositionToRange(scope, hit.start, hit.end)
        if (range) return range
      }
    } else if (position) {
      const range = textPositionToRange(scope, position.start, position.end)
      if (range) return range
    }
  }
  return null
}

/**
 * Re-attach a descriptor to a live element. Races all selectors, verifies every candidate
 * against the fingerprint, falls back to a bounded same-tag scan. Returns null below
 * threshold — never guesses. Never throws.
 */
export function resolveAnchor(
  anchor: AnchorDescriptor,
  options?: ResolveOptions,
): AnchorMatch | null {
  try {
    return run(anchor, options).match
  } catch {
    return null
  }
}

/** Same as resolveAnchor but returns a full per-selector trace. Powers `engine.explain()`. */
export function explainAnchor(
  anchor: AnchorDescriptor,
  options?: ResolveOptions,
): AnchorExplanation {
  try {
    const result = run(anchor, options)
    return {
      anchor,
      attempts: Object.freeze(result.attempts),
      result: result.match,
      totalMs: result.totalMs,
      budgetExceeded: result.budgetExceeded,
    }
  } catch {
    return { anchor, attempts: Object.freeze([]), result: null, totalMs: 0, budgetExceeded: false }
  }
}

/** Shared by the engine's fast path: the element a target resolves to, for cache checks. */
export { elementOf }
