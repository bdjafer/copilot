/**
 * §6.2's freezing rule: every published view model is **frozen and `structuredClone`-able**, and
 * no head ever receives a raw executor or wire frame (H5).
 *
 * Freezing is not decoration. A `DelegationVM` is handed to N heads, a copilot tool and the
 * presentation seam at the same time; one of them mutating `attempts` in place would corrupt the
 * others' view with no event to explain it, and `===` memoization — which §6.2 also promises —
 * would then report "unchanged" for a value that changed underneath it.
 *
 * `structuredClone`-ability is what rules out the obvious shortcuts: no `Map`, no `Set`, no class
 * instance and no function may appear inside a published VM, so this walker only has to handle
 * plain objects and arrays.
 *
 * DOM-free and Node-free.
 */

/** Depth-first freeze of plain objects and arrays. Cycles are impossible in a VM built by hand. */
export function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null) return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return value
}
