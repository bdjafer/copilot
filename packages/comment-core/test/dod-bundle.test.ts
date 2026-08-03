/**
 * §9 definition-of-done gate for the build (§1.1 "Vite lib mode, ESM + IIFE. IIFE global:
 * `Comments`."):
 *
 *   "The IIFE bundle exposes `Comments` … and works on a bare HTML page with no build step."
 *
 * The bundle is produced here by the package's own `vite.config.ts`, so this test fails the
 * moment the build config stops emitting a usable artifact — a `build` script nobody runs is
 * exactly how this DoD row went unmet in the first place.
 *
 * `comment-ui.iife.js` reads `comment-core` off `globalThis.Comments` and never bundles its own
 * copy (§1.2), which is what makes the global name and the self-containment load-bearing rather
 * than cosmetic.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, test } from 'vitest'

import type * as CommentCore from '../src/index.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const artifact = resolve(packageRoot, 'dist/comment-core.iife.js')

/** Every runtime value §2 lists, and nothing else. */
const PUBLIC_VALUES = [
  'CommentError',
  'THREAD_VERSION',
  // §2.5, decision log #43: the target-confidence heuristic is public — a host that drives
  // placement itself must be able to ask the same question `captureTarget` asks.
  'assessTarget',
  'captureElement',
  'captureTarget',
  'createCommentEngine',
  'createDomain',
  'createKeyValueCursor',
  'createKeyValueStore',
  'createLocalStorageStore',
  'createMemoryStore',
  'createPageKey',
  'defaultPageKey',
  'defaultStrategies',
  'defineCommentStore',
  'defineSelectorStrategy',
  'explainAnchor',
  'fingerprintElement',
  'observeStore',
  'resolveAnchor',
  'scoreCandidate',
  'volatileParams',
].sort()

let Comments: typeof CommentCore

beforeAll(async () => {
  const { build } = await import('vite')
  process.env.BUILD_TARGET = 'iife'
  try {
    // `emptyOutDir: false` on both passes, for the reason `comment-ui`'s bundle DoD spells out:
    // the `BUILD_TARGET=iife` pass empties `dist/` by default, and this test is not the only
    // thing looking at that directory. `apps/demo`'s global setup builds this package into the
    // same `dist/` and then imports `dist/index.js`; `comment-ui`'s bundle DoD builds it too;
    // and `pnpm -r test` runs all three suites concurrently. A wipe here therefore makes an
    // unrelated package's assertion fail on file-system timing alone — and it deletes the
    // `dist/types/` tree `publishConfig.exports` names, after the build that produced it.
    await build({ root: packageRoot, logLevel: 'error', build: { emptyOutDir: false } })
  } finally {
    delete process.env.BUILD_TARGET
  }
  // The ESM pass writes into the same `dist/`; run it here too so the §1.1 entry-point table
  // is covered by the same gate.
  await build({ root: packageRoot, logLevel: 'error', build: { emptyOutDir: false } })

  // A `<script src>` tag evaluates the file in the page's global scope, where the bundle's
  // top-level `var Comments = …` becomes the global. `new Function` reproduces that shape
  // without needing a real script loader.
  const code = readFileSync(artifact, 'utf8')
  Comments = new Function(`${code.replace(/^var Comments =/, 'return')}`)() as typeof CommentCore
}, 60_000)

describe('§9 / §1.1 — the IIFE bundle', () => {
  test('exposes `Comments` with exactly the §2 runtime surface, and no internal seam', () => {
    const exported = Object.keys(Comments)
      .filter((name) => name !== 'default' && name !== '__proto__')
      .sort()
    expect(exported).toEqual(PUBLIC_VALUES)
    // Finding 17, at the bundle boundary: the test-fixture seam is not shipped.
    for (const internal of ['INTERNALS', 'engineInternals', 'EngineInternals', 'VERSION']) {
      expect(exported).not.toContain(internal)
    }
  })

  test('§1.1: the ESM pass emits all four subpath entry points', () => {
    for (const entry of ['index.js', 'headless.js', 'anchor.js', 'testing.js']) {
      expect(existsSync(resolve(packageRoot, 'dist', entry))).toBe(true)
    }
  })

  test('is self-contained: no bare import survives for a <script> tag to resolve', () => {
    const code = readFileSync(artifact, 'utf8')
    expect(code).not.toMatch(/\brequire\((['"])(?!\.)/)
    expect(code).not.toMatch(/\bfrom\s*(['"])(?!\.)[^'"]+\1/)
    // …and its dependencies really were inlined (§1.1 lists exactly these three plus vendor).
    expect(code.length).toBeGreaterThan(50_000)
  })

  test('works on a bare HTML page: mount an engine, place a thread, read it back', async () => {
    document.body.innerHTML = '<article id="a" data-testid="a">alpha text</article>'

    const store = Comments.createMemoryStore()
    const engine = Comments.createCommentEngine({ store, pageKey: 'https://example.com/bare' })
    try {
      await engine.ready()

      const target = document.querySelector('#a')!
      const { anchor, capture } = Comments.captureTarget(target)
      const created = await engine.createThread({
        pageKey: engine.pageKey,
        kind: 'comment',
        anchor,
        capture,
        author: 'user',
        body: 'from the bundle',
      })

      expect(created.kind).toBe('created')
      const view = engine.getThreadView(created.thread.id)
      expect(view?.lastComment.body).toBe('from the bundle')
      expect(engine.listThreads()).toHaveLength(1)
    } finally {
      engine.destroy()
      document.body.innerHTML = ''
    }
  })

  test('the headless half of the bundle needs no DOM', () => {
    const store = Comments.createMemoryStore()
    expect(typeof Comments.createDomain(store).list).toBe('function')
    expect(Comments.defaultPageKey(new URL('https://example.com/a/?utm_source=x'))).toBe(
      'https://example.com/a',
    )
  })

  test('`CommentError.is` stays true across the bundle boundary (brand, never instanceof)', async () => {
    const source = await import('../src/index.ts')
    const fromBundle = new Comments.CommentError('empty_body')
    const fromSource = new source.CommentError('empty_body')

    // Two distinct classes, one brand — this is the §1.2 contract `comment-ui.iife.js` relies on.
    expect(fromBundle instanceof source.CommentError).toBe(false)
    expect(source.CommentError.is(fromBundle, 'empty_body')).toBe(true)
    expect(Comments.CommentError.is(fromSource, 'empty_body')).toBe(true)
  })
})
