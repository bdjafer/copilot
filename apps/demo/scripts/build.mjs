/**
 * `pnpm --filter exp-spec-demo build` → `apps/demo/dist/`, a self-contained folder you can drop
 * on any static host.
 *
 *   dist/index.html, dist/material.html, dist/pages/*.html   copied verbatim from `site/`
 *   dist/assets/*                                            copied verbatim from `site/`
 *   dist/vendor/comment-core.iife.js                         built here from packages/comment-core
 *   dist/vendor/comment-ui.iife.js                           built here from packages/comment-ui
 *   dist/vendor/comment-ui-glass.iife.js                     the appearance, loaded third
 *
 * The libraries are built through their own vite configs — there is no second build definition
 * to drift. Every pass runs with `emptyOutDir: false`, so this script is purely additive to the
 * packages' `dist/`: a root `pnpm build` that already emitted ESM and `.d.ts` keeps them.
 *
 * The last thing it prints is the **byte ledger**: the gz size of everything a page loads. A
 * budget that is not measured by the build is a budget nobody is keeping.
 *
 * Read it knowing what it measures. The packages build with `minify: false` on purpose — a
 * readable bundle is worth more than a small one to anyone debugging this repository — and the
 * stylesheets ship their own documentation, so these figures are **unminified**. The budgets in
 * `docs/DESIGN.md` §12 are for minified output and are not comparable to this column.
 */

import { cp, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build } from 'vite'

const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = resolve(demoRoot, '../..')
const out = resolve(demoRoot, 'dist')

/** The IIFE bundles the pages load, in `<script src>` order. */
const VENDOR = [
  ['packages/comment-core', 'dist/comment-core.iife.js'],
  ['packages/comment-ui', 'dist/comment-ui.iife.js'],
  ['packages/comment-ui', 'dist/comment-ui-glass.iife.js'],
  // Not linked by any page — each presentation injects its own styles — but shipped so the
  // importable half of the CSS contract is visible next to the bundles that inject it.
  ['packages/comment-ui', 'dist/comment-ui.css'],
  ['packages/comment-ui', 'dist/comment-ui-glass.css'],
]

async function buildLibrary(packageDir, passes) {
  const root = resolve(repoRoot, packageDir)
  // The same passes as the package's own `build` script, in the same order.
  for (const pass of passes) {
    process.env.BUILD_TARGET = pass
    try {
      await build({ root, logLevel: 'warn', build: { emptyOutDir: false } })
    } finally {
      delete process.env.BUILD_TARGET
    }
  }
  await build({ root, logLevel: 'warn', build: { emptyOutDir: false } })
}

await buildLibrary('packages/comment-core', ['iife'])
await buildLibrary('packages/comment-ui', ['iife', 'glass'])

await rm(out, { recursive: true, force: true })
await cp(resolve(demoRoot, 'site'), out, { recursive: true })
await mkdir(resolve(out, 'vendor'), { recursive: true })

for (const [packageDir, file] of VENDOR) {
  const from = resolve(repoRoot, packageDir, file)
  await cp(from, resolve(out, 'vendor', file.split('/').pop()))
}

const gz = async (path) => gzipSync(await readFile(path), { level: 9 }).length
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`

const pages = await readdir(resolve(out, 'pages'))
console.log(`\ndist/ → ${out}`)
console.log(`  index.html + material.html + ${pages.length} pages: ${pages.join(', ')}`)

let scriptBytes = 0
for (const [, file] of VENDOR) {
  const name = file.split('/').pop()
  const bytes = await gz(resolve(out, 'vendor', name))
  // The CSS is injected by the bundle that owns it, so counting it separately would double it.
  if (name.endsWith('.iife.js')) scriptBytes += bytes
  console.log(`  vendor/${name}: ${kb(bytes)} gz`)
}
const lens = await gz(resolve(out, 'assets/material-lens.js'))
console.log(`  assets/material-lens.js: ${kb(lens)} gz — lazy, material.html only, never on mount`)
console.log(`  scripts a page loads: ${kb(scriptBytes)} gz, unminified (see the note above)`)
console.log('  serve it with: pnpm --filter exp-spec-demo serve\n')
