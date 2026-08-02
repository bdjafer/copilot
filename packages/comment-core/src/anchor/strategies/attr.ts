/**
 * `attr` strategy — weight 90, the highest builtin (§2.5).
 *
 * Identifying attributes beat CSS paths because they survive re-layouts, wrapper divs and
 * class-name churn: a `data-testid` is a promise the app made on purpose.
 */

import type { SelectorStrategy } from '../types.ts'

import { elementOf, queryWithin } from '../dom.ts'

/** Attributes worth building a selector out of, most-identifying first. */
const IDENTIFYING: readonly string[] = [
  'id',
  'data-testid',
  'data-test-id',
  'data-test',
  'data-qa',
  'data-cy',
  'data-id',
  'name',
  'aria-label',
  'role',
]

const MAX_ATTRS = 3
const MAX_VALUE = 100

function escapeValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
}

export const attrStrategy: SelectorStrategy<{
  type: 'attr'
  tag: string
  attrs: Record<string, string>
}> = {
  type: 'attr',
  weight: 90,
  cost: 'cheap',

  describe(target) {
    const element = elementOf(target)
    if (!element?.tagName) return null

    const attrs: Record<string, string> = {}
    for (const name of IDENTIFYING) {
      if (Object.keys(attrs).length >= MAX_ATTRS) break
      let value: string | null = null
      try {
        value = element.getAttribute(name)
      } catch {
        value = null
      }
      if (value && value.length <= MAX_VALUE) attrs[name] = value
    }
    // `role` alone is not identifying — half a page is `role="button"`. Abstain rather than
    // hand `resolveAnchor` a selector that returns 200 candidates on every pass.
    const names = Object.keys(attrs)
    if (names.length === 0 || (names.length === 1 && names[0] === 'role')) return null

    return { tag: element.tagName.toLowerCase(), attrs }
  },

  resolve(selector, ctx) {
    const predicates = Object.entries(selector.attrs)
      .map(([name, value]) => `[${name}="${escapeValue(value)}"]`)
      .join('')
    return queryWithin(ctx.root, `${selector.tag}${predicates}`)
  },
}
