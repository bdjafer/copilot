/**
 * Vendored from Hypothesis `annotator/anchoring/match-quote.ts` (BSD-2, see ./LICENSE).
 *
 * Approximate quote matching: find the occurrence of `quote` in `text` that best explains the
 * recorded prefix/suffix context and position hint. This is the half of the TextQuote chain
 * that `approx-string-match` cannot do on its own — Myers' algorithm returns every lowest-cost
 * match, and this scores them against the context so the *right* "Submit" out of forty wins.
 *
 * Ported to this codebase's module/type conventions rather than copied byte-for-byte (no
 * network access at implementation time); the algorithm, the weights and the scoring formula
 * are Hypothesis's. Do not "improve" the weights here — they are the vendored contract.
 */

import search from 'approx-string-match'

export interface QuoteMatchContext {
  prefix?: string
  suffix?: string
  /** Expected start offset, from the TextPosition selector. */
  hint?: number
}

export interface QuoteMatch {
  start: number
  end: number
  /** 0..1. 1 = the quote, its prefix, its suffix and its position all matched exactly. */
  score: number
}

/** Upper bound on the edit distance Myers' algorithm is asked to tolerate. */
const MAX_ERRORS = 256

/**
 * Similarity of `str` to the corresponding slice of `text`, 0..1, as an error ratio over the
 * pattern length.
 */
function textMatchScore(text: string, str: string): number {
  if (str.length === 0 || text.length === 0) return 0
  const matches = search(text, str, str.length)
  if (matches.length === 0) return 0
  return 1 - matches[0]!.errors / str.length
}

/** Weights are Hypothesis's: the quote dominates, context breaks ties, position nudges. */
const QUOTE_WEIGHT = 50
const PREFIX_WEIGHT = 20
const SUFFIX_WEIGHT = 20
const POS_WEIGHT = 2

/**
 * Find the best approximate match of `quote` in `text`.
 *
 * Returns `null` when the quote is empty or no match exists within the error budget.
 */
export function matchQuote(
  text: string,
  quote: string,
  context: QuoteMatchContext = {},
): QuoteMatch | null {
  if (quote.length === 0) return null

  const maxErrors = Math.min(MAX_ERRORS, quote.length / 2)
  const matches = search(text, quote, maxErrors)
  if (matches.length === 0) return null

  const scoreMatch = (match: { start: number; end: number; errors: number }): number => {
    const quoteScore = 1 - match.errors / quote.length

    const prefixScore = context.prefix
      ? textMatchScore(
          text.slice(Math.max(0, match.start - context.prefix.length), match.start),
          context.prefix,
        )
      : 1

    const suffixScore = context.suffix
      ? textMatchScore(text.slice(match.end, match.end + context.suffix.length), context.suffix)
      : 1

    let posScore = 1
    if (typeof context.hint === 'number' && text.length > 0) {
      const offset = Math.abs(match.start - context.hint)
      posScore = 1 - offset / text.length
    }

    const raw =
      QUOTE_WEIGHT * quoteScore +
      PREFIX_WEIGHT * prefixScore +
      SUFFIX_WEIGHT * suffixScore +
      POS_WEIGHT * posScore
    return raw / (QUOTE_WEIGHT + PREFIX_WEIGHT + SUFFIX_WEIGHT + POS_WEIGHT)
  }

  const scored = matches.map((match) => ({
    start: match.start,
    end: match.end,
    score: scoreMatch(match),
  }))
  scored.sort((a, b) => b.score - a.score)
  return scored[0] ?? null
}
