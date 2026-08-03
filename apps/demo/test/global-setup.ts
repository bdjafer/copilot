/**
 * The demo's tests run against the **built ESM** bundles, not `src/` — that is the whole point
 * of an app-level test: it is the first consumer that goes through `exports`, so a build that
 * emits nothing usable fails here rather than in someone's browser.
 *
 * Both packages are built through their own vite configs (no second build definition to drift)
 * before any test file is imported, because `vitest.config.ts` aliases the two package names
 * straight at `dist/index.js` and a static import cannot wait for `beforeAll`.
 *
 * `emptyOutDir: false` keeps this additive: a `dist/types/` emitted by a previous root build
 * survives.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

export default async function setup(): Promise<void> {
  for (const packageDir of ['packages/comment-core', 'packages/comment-ui']) {
    await build({
      root: resolve(repoRoot, packageDir),
      logLevel: 'warn',
      build: { emptyOutDir: false },
    })
  }
}
