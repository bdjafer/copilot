/**
 * `defaultStrategies` + `defineSelectorStrategy` (§2.5), and the merge/order rules §4.6.1–2
 * that every call site shares.
 */

import type { BuiltinSelector, Selector } from '../../types.ts'
import type { AnyStrategy, DescribeContext, ResolveContext, SelectorStrategy } from '../types.ts'

import { attrStrategy } from './attr.ts'
import { cssStrategy } from './css.ts'
import { nthPathStrategy } from './nth-path.ts'
import { textPositionStrategy } from './text-position.ts'
import { textQuoteStrategy } from './text-quote.ts'

/** The five PLAN §3.1 builtins, in weight order. */
export const defaultStrategies: readonly SelectorStrategy<BuiltinSelector>[] = Object.freeze([
  attrStrategy,
  cssStrategy,
  textQuoteStrategy,
  nthPathStrategy,
  textPositionStrategy,
] as SelectorStrategy<BuiltinSelector>[])

/**
 * Author a strategy. The payload is INFERRED from `describe`'s return type and the selector
 * type is synthesized as `{ type: TType } & TPayload`, so `resolve(sel, …)` sees the real
 * payload fields. (A single `<const S extends Selector>` parameter has no inference site —
 * `S['type']` is an indexed access and `Omit<S, 'type'>` is non-homomorphic — so `S` would
 * collapse to `Selector`, `Omit<Selector, 'type'>` to `{}`, and every payload access in
 * `resolve` would be a compile error. Hence two parameters.)
 */
export function defineSelectorStrategy<
  const TType extends BuiltinSelector['type'] | `x-${string}`,
  TPayload extends object,
>(strategy: {
  type: TType
  weight: number
  cost?: 'cheap' | 'fuzzy'
  describe(target: Element | Range, ctx: DescribeContext): TPayload | null
  resolve(
    selector: { type: TType } & TPayload,
    ctx: ResolveContext,
  ): Element | Range | Iterable<Element> | null
}): SelectorStrategy<{ type: TType } & TPayload> {
  return strategy as SelectorStrategy<{ type: TType } & TPayload>
}

const BUILTINS: ReadonlySet<AnyStrategy> = new Set(defaultStrategies as readonly AnyStrategy[])

/**
 * §4.6.1: **one** strategy list serves both halves. Supplied strategies are merged onto the
 * builtins by `type` — same type replaces the builtin (§2.5: "Must be a
 * `BuiltinSelector['type']` to replace a builtin, or `x-*` for a custom one").
 *
 * Collision rule: a supplied strategy always beats a builtin, and re-listing a builtin (the
 * `[rowId, ...defaultStrategies]` idiom of §7.4) is a no-op — they are merged in either way.
 * That makes `[rowId]`, `[rowId, ...defaultStrategies]` and
 * `[...defaultStrategies, replacement]` all mean what they read like, which a plain
 * last-wins map does not.
 */
export function mergeStrategies(extra?: readonly AnyStrategy[]): AnyStrategy[] {
  const byType = new Map<string, AnyStrategy>()
  for (const strategy of defaultStrategies as readonly AnyStrategy[]) {
    byType.set(strategy.type, strategy)
  }
  for (const strategy of extra ?? []) {
    const current = byType.get(strategy.type)
    if (current && !BUILTINS.has(current) && BUILTINS.has(strategy)) continue
    byType.set(strategy.type, strategy)
  }
  return [...byType.values()].sort(byWeight)
}

/** Capture order (§4.6.1): weight descending, ties by type for determinism. */
export function byWeight(a: AnyStrategy, b: AnyStrategy): number {
  if (a.weight !== b.weight) return b.weight - a.weight
  return a.type < b.type ? -1 : a.type > b.type ? 1 : 0
}

/** Resolution order (§4.6.2): `cheap` before `fuzzy`, then weight descending. */
export function byCostThenWeight(a: AnyStrategy, b: AnyStrategy): number {
  const costA = a.cost === 'fuzzy' ? 1 : 0
  const costB = b.cost === 'fuzzy' ? 1 : 0
  if (costA !== costB) return costA - costB
  return byWeight(a, b)
}

export { attrStrategy, cssStrategy, nthPathStrategy, textPositionStrategy, textQuoteStrategy }

/**
 * Internal: hand a merged list back to `ResolveOptions.strategies`, whose locked type is
 * `readonly SelectorStrategy[]` (= `SelectorStrategy<Selector>`). `AnyStrategy` is the wider
 * internal container — every element of a merged list satisfies the public type, but
 * `{ type: string }` is not assignable to `Selector['type']` in the abstract.
 */
export function asStrategyList(
  list: readonly AnyStrategy[],
): readonly SelectorStrategy<Selector>[] {
  return list as unknown as readonly SelectorStrategy<Selector>[]
}
