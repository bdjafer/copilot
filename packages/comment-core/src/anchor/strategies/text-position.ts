/**
 * `textPosition` strategy — weight 30, the lowest builtin (§2.5), cost `fuzzy`.
 *
 * Raw character offsets into the document's flattened text. Worthless on its own — one inserted
 * paragraph invalidates every offset on the page — but it is the position **hint** that lets
 * `matchQuote` pick the right one of forty identical "Submit" strings, and it is the last
 * resort when the quote itself was edited away.
 */

import type { SelectorStrategy } from '../types.ts'

import { isRange, textRootOf } from '../dom.ts'
import { rangeToTextPosition, textPositionToRange } from '../vendor/hypothesis/text-range.ts'

export const textPositionStrategy: SelectorStrategy<{
  type: 'textPosition'
  start: number
  end: number
}> = {
  type: 'textPosition',
  weight: 30,
  cost: 'fuzzy',

  describe(target, ctx) {
    if (!isRange(target)) return null
    const root = textRootOf(ctx.document, ctx.document)
    return rangeToTextPosition(root, target)
  },

  resolve(selector, ctx) {
    const root = textRootOf(ctx.root, ctx.document)
    return textPositionToRange(root, selector.start, selector.end)
  },
}
