/**
 * `pnpm --filter exp-spec-demo build` → `apps/demo/dist/`, a self-contained folder you can drop
 * on any static host.
 *
 *   dist/index.html, dist/pages/*.html   copied verbatim from `site/`
 *   dist/assets/*                        copied verbatim from `site/`
 *   dist/vendor/comment-core.iife.js     built here from packages/comment-core
 *   dist/vendor/comment-ui.iife.js       built here from packages/comment-ui
 *
 * The libraries are built through their own vite configs — there is no second build definition
 * to drift. Both passes run with `emptyOutDir: false`, so this script is purely additive to the
 * packages' `dist/`: a root `pnpm build` that already emitted ESM and `.d.ts` keeps them.
 */

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(demoRoot, '../..')
const out = resolve(demoRoot, 'dist')

/** The two IIFE bundles the pages load, in `<script src>` order. */
const VENDOR = [
  ['packages/comment-core', 'dist/comment-core.iife.js'],
  ['packages/comment-ui', 'dist/comment-ui.iife.js'],
  // Not linked by any page — comment-ui injects its own styles — but shipped so the importable
  // half of the CSS contract is visible next to the bundle that injects it.
  ['packages/comment-ui', 'dist/comment-ui.css'],
]

async function buildLibrary(packageDir) {
  const root = resolve(repoRoot, packageDir)
  // Same two passes as the package's own `build` script: IIFE first, then ESM.
  process.env.BUILD_TARGET = 'iife'
  try {
    await build({ root, logLevel: 'warn', build: { emptyOutDir: false } })
  } finally {
    delete process.env.BUILD_TARGET
  }
  await build({ root, logLevel: 'warn', build: { emptyOutDir: false } })
}

for (const packageDir of ['packages/comment-core', 'packages/comment-ui']) {
  await buildLibrary(packageDir)
}

await rm(out, { recursive: true, force: true })
await cp(resolve(demoRoot, 'site'), out, { recursive: true })
await mkdir(resolve(out, 'vendor'), { recursive: true })

for (const [packageDir, file] of VENDOR) {
  const from = resolve(repoRoot, packageDir, file)
  await cp(from, resolve(out, 'vendor', file.split('/').pop()))
}

const pages = await readdir(resolve(out, 'pages'))
const bytes = async (path) => (await stat(path)).size
console.log(`\ndist/ → ${out}`)
console.log(`  index.html + ${pages.length} pages: ${pages.join(', ')}`)
for (const [, file] of VENDOR) {
  const name = file.split('/').pop()
  console.log(
    `  vendor/${name}: ${((await bytes(resolve(out, 'vendor', name))) / 1024).toFixed(1)} kB`,
  )
}
console.log('  serve it with: pnpm --filter exp-spec-demo serve\n')
