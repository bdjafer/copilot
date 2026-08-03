/**
 * Shared scaffolding for the demo suite, and the **single definition of what the tests load**.
 *
 * `vitest.config.ts` builds its `resolve.alias` out of `BUILT_ENTRIES` and the tests assert
 * against the same object, so "the tests really did load the built bundles" cannot drift into a
 * restatement of two path strings that nothing points at.
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * `dirname(fileURLToPath(...))` rather than `new URL(path, import.meta.url)`: this module is in
 * the TEST graph, and vite statically rewrites the `new URL(literal, import.meta.url)` form into
 * an asset reference, which is no longer a `file:` URL by the time `fileURLToPath` sees it.
 */
const here = dirname(fileURLToPath(import.meta.url))
const packages = resolve(here, '../../../packages')

/** The two built ESM entries the two package names are aliased at. `global-setup.ts` emits them. */
export const BUILT_ENTRIES = {
  '@astrale-os/comment-core': resolve(packages, 'comment-core/dist/index.js'),
  '@astrale-os/comment-ui': resolve(packages, 'comment-ui/dist/index.js'),
} as const

/**
 * The demo's canned-reply delay, shortened. **Long enough that `settle()` never crosses it** —
 * which is the whole contract, because `place → send → …` asserts "Send wrote exactly one
 * comment" after two `settle()`s and a `reanchor()`, and a reply that lands inside that window
 * makes it two.
 *
 * 25 ms did not hold that contract. `settle()` is four macrotask hops, and under a parallel
 * five-package `pnpm --filter … test` run each hop can take tens of milliseconds — the failure
 * reproduced 5 times in 6 on an untouched checkout, and never in an isolated `--filter
 * exp-spec-demo` run, which is exactly the signature of a wall-clock budget being eaten by load
 * elsewhere in the process. 400 ms costs the suite nothing: `waitForEcho`/`waitForLog` poll on a
 * 2 s deadline and return as soon as the reply lands.
 */
export const ECHO_DELAY = 400

/** The renderer coalesces onto a microtask and the domain writes are promises. */
export async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve()
    await new Promise<void>((done) => setTimeout(done, 0))
  }
}

/**
 * happy-dom keeps `localStorage` on `Window.prototype`, and vitest's environment copies own
 * properties onto `globalThis` — so the global the pages get for free does not exist here.
 * Installing a `Storage`-shaped double keeps the demo's own call (`createLocalStorageStore()`,
 * no arguments, resolving `globalThis.localStorage` lazily) on the tested path.
 */
export function installLocalStorage(): void {
  const map = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
  }
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })
}
