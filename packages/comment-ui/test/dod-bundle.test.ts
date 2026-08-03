/**
 * §9 definition-of-done gate for the build, and the §1.2 IIFE contract that a config review
 * alone cannot prove:
 *
 *   "`comment-ui.iife.js` declares `comment-core` **external** and reads it from
 *    `globalThis.Comments`; it never bundles its own copy."
 *
 *   "The IIFE bundle exposes `Comments` / `CommentsUI` and `CommentsUI.mount()` works on a bare
 *    HTML page with no build step."
 *
 * Both bundles are produced here by the packages' own vite configs, so this fails the moment
 * the build stops emitting a usable artifact — a `build` script nobody runs is exactly how a
 * DoD row goes unmet. Declarations are emitted here too, which makes the last describe (every
 * `publishConfig.exports` target is a real file) the executable form of §1.1's "these subpaths
 * were verified against a real build", rather than a claim in prose.
 *
 * **This file writes into two packages' `dist/`, so it must never DESTROY one.** Both vite
 * passes run with `emptyOutDir: false`: the `BUILD_TARGET=iife` pass empties `dist/` by default
 * (the build script's own first step), and a test that inherits that deletes the `dist/types/`
 * tree `publishConfig.exports` names — silently, after the build that produced it, which is
 * exactly how a `build → test → publish` pipeline ships a package whose `types` condition
 * points at nothing.
 */

import type * as CommentCore from '@astrale-os/comment-core'

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import type * as CommentUiGlass from '../src/glass.ts'
import type * as CommentUi from '../src/index.ts'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const coreRoot = resolve(packageRoot, '../comment-core')
const repoRoot = resolve(packageRoot, '../..')
const artifact = resolve(packageRoot, 'dist/comment-ui.iife.js')
const glassArtifact = resolve(packageRoot, 'dist/comment-ui-glass.iife.js')
const stylesheet = resolve(packageRoot, 'dist/comment-ui.css')
const glassStylesheet = resolve(packageRoot, 'dist/comment-ui-glass.css')

const PACKAGES = [
  ['@astrale-os/comment-core', coreRoot],
  ['@astrale-os/comment-ui', packageRoot],
] as const

let CommentsUI: typeof CommentUi
let CommentsUIGlass: typeof CommentUiGlass
let Comments: typeof CommentCore

/** Set for the length of this file: the IIFE bundle reads the global by name, at load time. */
function setGlobalComments(value: unknown): void {
  Object.defineProperty(globalThis, 'Comments', { value, configurable: true, writable: true })
}

beforeAll(async () => {
  const { build } = await import('vite')
  for (const [name, root] of PACKAGES) {
    // The same passes the packages' own `build` scripts run, in the same order — a build
    // definition that only exists in a test proves nothing about what `pnpm build` emits.
    const passes = name === '@astrale-os/comment-ui' ? ['iife', 'glass'] : ['iife']
    for (const pass of passes) {
      process.env.BUILD_TARGET = pass
      try {
        await build({ root, logLevel: 'error', build: { emptyOutDir: false } })
      } finally {
        delete process.env.BUILD_TARGET
      }
    }
    await build({ root, logLevel: 'error', build: { emptyOutDir: false } })
    execFileSync(resolve(repoRoot, 'node_modules/.bin/tsgo'), ['-p', 'tsconfig.build.json'], {
      cwd: root,
      stdio: 'pipe',
    })
  }

  // Reproduce a `<script src>` pair: `comment-core.iife.js` first (§7.1), then `comment-ui`.
  // `Comments` is a real global here — NOT a parameter injected by the loader, which would let
  // a bundle reading a differently-named global pass this file unchanged.
  const coreCode = readFileSync(resolve(coreRoot, 'dist/comment-core.iife.js'), 'utf8')
  Comments = new Function(
    `${coreCode.replace(/^var Comments =/, 'return')}`,
  )() as typeof CommentCore
  setGlobalComments(Comments)
  const uiCode = readFileSync(artifact, 'utf8')
  CommentsUI = new Function(
    `${uiCode.replace(/^var CommentsUI =/, 'return')}`,
  )() as typeof CommentUi
  const glassCode = readFileSync(glassArtifact, 'utf8')
  CommentsUIGlass = new Function(
    `${glassCode.replace(/^var CommentsUIGlass =/, 'return')}`,
  )() as typeof CommentUiGlass
}, 180_000)

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'Comments')
})

describe('§1.2 / §9 — the IIFE bundle', () => {
  test('exposes `CommentsUI` with exactly the §3 / §3.1.7 runtime surface', () => {
    const exported = Object.keys(CommentsUI)
      .filter((name) => name !== 'default' && name !== '__proto__')
      .sort()
    expect(exported).toEqual([
      'commentUIStyles',
      'createCommentUIController',
      'defaultLabels',
      'domPresentation',
      'mount',
      'mountCommentUI',
    ])
  })

  test('declares comment-core external — it never bundles a second copy', () => {
    const code = readFileSync(artifact, 'utf8')
    expect(code).not.toContain('createCommentEngine(options')
    expect(code).not.toContain('THREAD_VERSION')
    // Its own dependency IS inlined, so a bare <script> has nothing to resolve.
    expect(code).toContain('computePosition')
    expect(code).not.toMatch(/\brequire\((['"])(?!\.)/)
    expect(code).not.toMatch(/\bfrom\s*(['"])(?!\.)[^'"]+\1/)
  })

  test('reads the engine off the `Comments` global — by that name, at load time', () => {
    const code = readFileSync(artifact, 'utf8')
    // The IIFE epilogue passes the global in as the external's argument. A bare identifier is
    // the whole contract: any other name, or a `globalThis.Whatever ?? {}` fallback, changes
    // this line. (`/\bComments\b/` on the file would also be satisfied by a comment.)
    expect(code).toMatch(/\}\)\(\s*\{\s*\}\s*,\s*Comments\s*\)\s*;?/)

    // And it is a REAL global read, so a page that forgot the first <script src> fails loudly
    // (§7.1's load order) instead of half-booting. `CommentsUI` was loaded that way above.
    const saved: unknown = Reflect.get(globalThis, 'Comments')
    Reflect.deleteProperty(globalThis, 'Comments')
    try {
      expect(() => new Function(code)()).toThrow(ReferenceError)
    } finally {
      setGlobalComments(saved)
    }
    expect(CommentsUI.mountCommentUI).toBeTypeOf('function')
  })

  test('the ESM pass emits every subpath of §3.1.1 the package publishes', () => {
    for (const entry of ['dist/index.js', 'dist/presentation.js', 'dist/testing.js']) {
      expect({ entry, built: existsSync(resolve(packageRoot, entry)) }).toEqual({
        entry,
        built: true,
      })
    }
  })

  test('`comment-ui/presentation` carries no runtime and no import (§3.1.1)', () => {
    // The types-only seam is what makes "a presentation imports zero engine code" enforceable
    // by a grep rather than by discipline. A `.d.ts` naming a `comment-core` identifier, or a
    // chunk that pulls one in, would put the engine one `import` away from every theme.
    const source = readFileSync(resolve(packageRoot, 'src/presentation.ts'), 'utf8')
    expect(source).not.toMatch(/^\s*import\b/m)
    expect(source).not.toMatch(/\bexport\b[^\n]*\bfrom\b/)

    const declaration = readFileSync(resolve(packageRoot, 'dist/types/presentation.d.ts'), 'utf8')
    expect(declaration).not.toMatch(/^\s*import\b/m)
    expect(declaration).not.toContain('comment-core')
    expect(declaration).not.toContain('floating-ui')
    expect(declaration).toContain('UIViewModel')
    expect(declaration).toContain('Intents')

    const chunk = readFileSync(resolve(packageRoot, 'dist/presentation.js'), 'utf8')
    expect(chunk).not.toMatch(/\bfrom\s*(['"])(?!\.)[^'"]+\1/)
  })

  test('emits the importable stylesheet, byte-identical to the injected one', async () => {
    expect(existsSync(stylesheet)).toBe(true)
    const { commentUIStyles } = await import('../src/presentations/dom/styles.ts')
    expect(readFileSync(stylesheet, 'utf8')).toBe(commentUIStyles)
    expect(CommentsUI.commentUIStyles).toBe(commentUIStyles)
  })

  test('`comment-ui/glass` ships two names and, at runtime, imports nothing (§1.2)', () => {
    const exported = Object.keys(CommentsUIGlass)
      .filter((name) => name !== 'default' && name !== '__proto__')
      .sort()
    expect(exported).toEqual(['glassPresentation', 'glassStyles'])

    // §1.2's table says "**none at runtime**", and this is what that costs a consumer: the ESM
    // chunk resolves no bare specifier at all — not the engine, not the controller, not the
    // positioning library — so selecting the theme can never drag a second copy of any of them
    // into a page. A shared rollup chunk would break exactly this line.
    const chunk = readFileSync(resolve(packageRoot, 'dist/glass.js'), 'utf8')
    expect(chunk).not.toMatch(/\bfrom\s*(['"])(?!\.)[^'"]+\1/)
    expect(chunk).not.toContain('comment-core')
    expect(chunk).not.toContain('computePosition')

    // …and the same for the IIFE, which is what a bare page loads third.
    const code = readFileSync(glassArtifact, 'utf8')
    expect(code).not.toMatch(/\bfrom\s*(['"])(?!\.)[^'"]+\1/)
    expect(code).not.toMatch(/\brequire\((['"])(?!\.)/)
    expect(code).toContain('CommentsUIGlass')
    // The controller is not in here: `mountCommentUI` stays the root bundle's, read off the page.
    expect(code).not.toContain('createCommentUIController')
    expect(code).not.toContain('THREAD_VERSION')
  })

  test('emits the importable glass stylesheet, byte-identical to the injected one', async () => {
    expect(existsSync(glassStylesheet)).toBe(true)
    const { glassStyles } = await import('../src/presentations/glass/styles.ts')
    expect(readFileSync(glassStylesheet, 'utf8')).toBe(glassStyles)
    expect(CommentsUIGlass.glassStyles).toBe(glassStyles)
  })

  test('the two appearances are selectable from the same bare page', async () => {
    document.body.innerHTML = '<article id="a" data-testid="a">alpha text</article>'
    const store = Comments.createMemoryStore()
    const ui = CommentsUI.mount({
      engine: { store, pageKey: 'https://example.com/glass' },
      ui: { panel: { defaultOpen: true }, presentation: CommentsUIGlass.glassPresentation() },
    })
    try {
      await ui.engine.ready()
      const target = document.querySelector('#a')!
      const { anchor, capture } = Comments.captureTarget(target)
      const created = await ui.engine.createThread({
        pageKey: ui.engine.pageKey,
        kind: 'comment',
        anchor,
        capture,
        author: 'user',
        body: 'drawn by the second presentation',
      })
      await ui.engine.reanchor()
      await new Promise<void>((done) => setTimeout(done, 0))

      const badge = ui.root.querySelector(
        `button[aria-haspopup="dialog"][data-thread="${created.thread.id}"]`,
      )
      expect(badge).not.toBeNull()
      // The sprite the theme injects, and the sheet, both landed in the same shadow root.
      expect(ui.root.querySelector('.cc-sprite')).not.toBeNull()
      expect(ui.root.querySelector('style[data-cc="base"]')?.textContent).toContain('--_glass-bg')
    } finally {
      ui.unmount()
      ui.engine.destroy()
      document.body.innerHTML = ''
    }
  })

  test('the build is additive: it never deletes what a previous pass emitted', () => {
    // The two vite passes plus the declaration emit write into one `dist/`. If any of them
    // empties it, the artifacts of the others are gone — which is the same failure this file
    // used to CAUSE for `dist/types/`.
    for (const [, root] of PACKAGES) {
      expect(existsSync(resolve(root, 'dist/types'))).toBe(true)
    }
    expect(existsSync(artifact)).toBe(true)
    expect(existsSync(resolve(coreRoot, 'dist/comment-core.iife.js'))).toBe(true)
  })

  test('CommentsUI.mount() works on a bare page with no build step', async () => {
    document.body.innerHTML = '<article id="a" data-testid="a">alpha text</article>'
    const store = Comments.createMemoryStore()
    const ui = CommentsUI.mount({
      engine: { store, pageKey: 'https://example.com/bare' },
      ui: { panel: { defaultOpen: true } },
    })
    try {
      await ui.engine.ready()
      const target = document.querySelector('#a')!
      const { anchor, capture } = Comments.captureTarget(target)
      const created = await ui.engine.createThread({
        pageKey: ui.engine.pageKey,
        kind: 'comment',
        anchor,
        capture,
        author: 'user',
        body: 'from a bare page',
      })
      await ui.engine.reanchor()
      await new Promise<void>((done) => setTimeout(done, 0))

      expect(ui.root.mode).toBe('open')
      expect(ui.root.querySelector(`.cc-badge[data-thread="${created.thread.id}"]`)).not.toBeNull()
      expect(ui.root.querySelector('.cc-row-body')?.textContent).toBe('from a bare page')
      ui.decorate(created.thread.id, { chip: { text: 'copilot', tone: 'busy', spinner: true } })
      await new Promise<void>((done) => setTimeout(done, 0))
      expect(ui.root.querySelector('.cc-chip')?.textContent).toBe('copilot')
    } finally {
      ui.unmount()
      ui.engine.destroy()
      document.body.innerHTML = ''
    }
  })
})

/**
 * §1.1 / §1.2's entry-point tables, checked against the filesystem the build just produced.
 * The published map is `publishConfig.exports` — npm swaps it over `exports` at pack time — so
 * a consumer never resolves through the workspace's source-pointing map, and nothing else in
 * either suite reads it. `comment-core` is included because this file is the only place both
 * packages are built together, and because it is this file that used to delete its `dist/`.
 */
interface PackageManifest {
  files?: string[]
  publishConfig?: { exports?: Record<string, string | Record<string, string>> }
}

/** Every path the map points at, in declaration order: `"./x.js"` or `{ types, import }`. */
function exportTargets(manifest: PackageManifest): string[] {
  const map = manifest.publishConfig?.exports ?? {}
  return Object.values(map).flatMap((entry) =>
    typeof entry === 'string' ? [entry] : Object.values(entry),
  )
}

describe('§1.1 / §1.2 — the published exports map', () => {
  for (const [name, root] of PACKAGES) {
    test(`${name} ships every file its published map names`, () => {
      const manifest = JSON.parse(
        readFileSync(resolve(root, 'package.json'), 'utf8'),
      ) as PackageManifest
      const targets = exportTargets(manifest)
      expect(targets.length).toBeGreaterThan(0)
      // Reported as a map so a failure names the missing subpath instead of `false !== true`.
      const present = Object.fromEntries(
        targets.map((target) => [target, existsSync(resolve(root, target))]),
      )
      expect(present).toEqual(Object.fromEntries(targets.map((target) => [target, true])))
      // …and `dist` is packed, or the map above points at files no tarball contains.
      expect(manifest.files).toContain('dist')
    })
  }

  test('the declarations actually type — a .d.ts that lies is worse than none', async () => {
    const types = resolve(packageRoot, 'dist/types/index.d.ts')
    const declaration = readFileSync(types, 'utf8')
    expect(declaration).toContain('mountCommentUI')
    expect(declaration).toContain('commentUIStyles')
    expect(declaration).toContain('createCommentUIController')
    expect(declaration).toContain('domPresentation')
    // The runtime surface and the declared surface are the same six names (§3, §3.1.7).
    const { commentUIStyles } = await import('../src/index.ts')
    expect(typeof commentUIStyles).toBe('string')
  })
})
