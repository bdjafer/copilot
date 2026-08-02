/**
 * `css` strategy — weight 80 (§2.5). A thin `@medv/finder` wrapper.
 *
 * finder throws on a detached node, on its own timeout and when no unique selector exists; all
 * three are abstentions here, never faults (§2.5 "never throws").
 */

import { finder } from '@medv/finder'

import type { SelectorStrategy } from '../types.ts'

import { elementOf, queryWithin } from '../dom.ts'

/** finder's own defaults, minus the 1 s timeout: an anchoring pass has a 12 ms budget. */
const FINDER_TIMEOUT_MS = 200

export const cssStrategy: SelectorStrategy<{ type: 'css'; value: string }> = {
  type: 'css',
  weight: 80,
  cost: 'cheap',

  describe(target, ctx) {
    const element = elementOf(target)
    if (!element?.tagName) return null
    const root = ctx.document.body ?? ctx.document.documentElement
    if (!root) return null
    try {
      const value = finder(element, { root, timeoutMs: FINDER_TIMEOUT_MS })
      return value ? { value } : null
    } catch {
      return null
    }
  },

  resolve(selector, ctx) {
    return queryWithin(ctx.root, selector.value)
  },
}
