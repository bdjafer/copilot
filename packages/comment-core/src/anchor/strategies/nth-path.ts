/**
 * `nthPath` strategy — weight 40 (§2.5). Pure structure, no names at all.
 *
 * It is the selector that survives a full re-theme and dies on any re-order, which is why it
 * sits below `css` and above `textPosition`. The path is absolute from the document element,
 * so on a **scoped** retry (`root` = an added subtree) it resolves against the owning document
 * and `resolveAnchor` drops anything outside the scope.
 */

import type { SelectorStrategy } from '../types.ts'

import { fallbackPath } from '../capture.ts'
import { elementOf, queryWithin } from '../dom.ts'

export const nthPathStrategy: SelectorStrategy<{ type: 'nthPath'; value: string }> = {
  type: 'nthPath',
  weight: 40,
  cost: 'cheap',

  describe(target) {
    const element = elementOf(target)
    if (!element?.tagName) return null
    const value = fallbackPath(element)
    return value ? { value } : null
  },

  resolve(selector, ctx) {
    // The path is absolute from the document element, so on a scoped retry it is resolved
    // against the owning document; `resolveAnchor` drops anything outside the scope.
    const scoped = queryWithin(ctx.root, selector.value)
    return scoped.length > 0 ? scoped : queryWithin(ctx.document, selector.value)
  },
}
