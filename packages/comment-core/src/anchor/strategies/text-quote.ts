/**
 * `textQuote` strategy — weight 70 (§2.5), cost `fuzzy`.
 *
 * Hypothesis's TextQuote selector: the exact quote plus 32 characters of context on each side.
 * Resolution runs the vendored `matchQuote` (Myers approximate matching via
 * `approx-string-match`) over the scope's flattened text and returns a live `Range`, which is
 * what makes `AnchorDescriptor.mode === 'text'` mean something.
 *
 * `cost: 'fuzzy'` is deliberate: approximate matching over a whole document's text is not a
 * thing to do on every MutationObserver batch (§4.6.5 skips fuzzy strategies on the scoped
 * fast path). A text thread still re-anchors its *element* on the fast path via `attr`/`css`;
 * §4.6.4's "failed range with a successful element match" rule then costs it 0.15 confidence
 * until the next full pass restores the range.
 */

import type { SelectorStrategy } from '../types.ts'

import { isRange, textRootOf } from '../dom.ts'
import { matchQuote } from '../vendor/hypothesis/match-quote.ts'
import {
  rangeToTextPosition,
  textOffsets,
  textPositionToRange,
} from '../vendor/hypothesis/text-range.ts'

/** Hypothesis uses 32 characters of context either side. */
export const CONTEXT_LENGTH = 32
/** A quote longer than this is truncated: Myers' cost is O(k/w · n) in the pattern length. */
const MAX_QUOTE = 512

export const textQuoteStrategy: SelectorStrategy<{
  type: 'textQuote'
  exact: string
  prefix: string
  suffix: string
}> = {
  type: 'textQuote',
  weight: 70,
  cost: 'fuzzy',

  describe(target, ctx) {
    // An element target has no quote — its whole text is its `textDigest`, and describing it
    // here would flip a mode the capture already decided (§2.4 `AnchorDescriptor.mode`).
    if (!isRange(target)) return null
    const exact = target.toString()
    if (exact.trim() === '') return null

    const root = textRootOf(ctx.document, ctx.document)
    const position = rangeToTextPosition(root, target)
    const { text } = textOffsets(root)
    if (!position) return { exact: exact.slice(0, MAX_QUOTE), prefix: '', suffix: '' }

    return {
      exact: exact.slice(0, MAX_QUOTE),
      prefix: text.slice(Math.max(0, position.start - CONTEXT_LENGTH), position.start),
      suffix: text.slice(position.end, position.end + CONTEXT_LENGTH),
    }
  },

  resolve(selector, ctx) {
    const root = textRootOf(ctx.root, ctx.document)
    const { text } = textOffsets(root)
    if (text === '') return null
    const match = matchQuote(text, selector.exact, {
      prefix: selector.prefix || undefined,
      suffix: selector.suffix || undefined,
    })
    if (!match) return null
    return textPositionToRange(root, match.start, match.end)
  },
}
