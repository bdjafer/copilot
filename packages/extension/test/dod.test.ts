/**
 * Structural guarantees the rest of the suite assumes: the package participates in the root
 * gate, the manifest declares what the code needs, and the platform boundary is where it says
 * it is.
 *
 * These are greps, and greps are the right tool here: the failures they catch (a `chrome.`
 * reference sneaking into a unit-testable module, a permission dropped from the manifest, a
 * `typecheck` script removed) are invisible to every behavioural test in the suite.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { KEEPALIVE_MS, WATCHDOG_PERIOD_MINUTES } from '../src/background/index.ts'
import wxtConfig from '../wxt.config.ts'

// vitest serves test files under `/@fs/…`, so `import.meta.url` is not a filesystem path here.
// `process.cwd()` is the package root, which is what vitest runs from.
const ROOT = process.cwd()
const read = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir))) {
    const relative = `${dir}/${entry}`
    if (statSync(join(ROOT, relative)).isDirectory()) walk(relative, out)
    else if (relative.endsWith('.ts')) out.push(relative)
  }
  return out
}

describe('package wiring — the root gate must see this package', () => {
  const pkg = JSON.parse(read('package.json')) as {
    scripts: Record<string, string>
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }

  it('runs wxt prepare before tsgo, so the generated ambient types exist', () => {
    // `wxt prepare` writes `.wxt/tsconfig.json` and the `defineBackground` / `browser` globals;
    // a bare `tsgo --noEmit` in a clean checkout fails without it.
    expect(pkg.scripts.typecheck).toBe('wxt prepare && tsgo --noEmit')
  })

  it('exposes test, lint and build so `pnpm -r` picks them up', () => {
    expect(pkg.scripts.test).toBe('vitest run')
    expect(pkg.scripts.lint).toBe('oxlint .')
    expect(pkg.scripts.build).toBe('wxt build')
  })

  it('depends on all three workspace packages plus the provider', () => {
    for (const name of [
      '@astrale-os/comment-core',
      '@astrale-os/comment-ui',
      '@astrale-os/browser-copilot',
    ]) {
      expect(pkg.dependencies[name]).toBe('workspace:*')
    }
    expect(pkg.dependencies['@ai-sdk/anthropic']).toBeTruthy()
    expect(pkg.dependencies['@webext-core/messaging']).toBeTruthy()
    expect(pkg.dependencies.zod).toBeTruthy()
  })

  it('stays private — this is the product, not a library', () => {
    expect((JSON.parse(read('package.json')) as { private: boolean }).private).toBe(true)
  })
})

describe('manifest', () => {
  const manifest = wxtConfig.manifest as {
    permissions: string[]
    host_permissions: string[]
    commands: Record<string, unknown>
  }

  it('declares the permissions the code actually calls', () => {
    // storage → the KeyValueAdapter; alarms → the watchdog; tabs → tabsForPageKey;
    // unlimitedStorage → captures are HTML.
    expect(manifest.permissions.sort()).toEqual(['alarms', 'storage', 'tabs', 'unlimitedStorage'])
  })

  it('grants the Anthropic host permission that makes the direct call CORS-free', () => {
    expect(manifest.host_permissions).toEqual(['https://api.anthropic.com/*'])
  })

  it('declares the two placement commands, since a command cannot bind a bare letter', () => {
    expect(Object.keys(manifest.commands).sort()).toEqual(['place-ask', 'place-comment'])
  })
})

describe('the built extension (when a build is present)', () => {
  const built = (() => {
    try {
      return JSON.parse(read('.output/chrome-mv3/manifest.json')) as Record<string, unknown>
    } catch {
      return null
    }
  })()

  it.runIf(built)('emits an MV3 module service worker and a document_start content script', () => {
    expect(built!.manifest_version).toBe(3)
    // A classic worker cannot `import`, and the bundle is ESM.
    expect(built!.background).toMatchObject({ type: 'module' })
    expect(
      (built!.content_scripts as Array<{ run_at: string; matches: string[] }>)[0],
    ).toMatchObject({
      run_at: 'document_start',
      matches: ['<all_urls>'],
    })
    expect(built!.options_ui).toBeTruthy()
    expect(built!.permissions).toContain('alarms')
    expect(built!.host_permissions).toEqual(['https://api.anthropic.com/*'])
  })
})

describe('platform boundary', () => {
  const sources = walk('src')
  /** Comments talk *about* `chrome.storage` constantly; only executable text is the lint's business. */
  const code = (file: string): string =>
    read(file)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('covers every module under src/', () => {
    expect(sources.length).toBeGreaterThan(10)
  })

  it('no module under src/ touches a platform global — only entrypoints do', () => {
    // The bridge is testable precisely because every `chrome.*` surface arrives as a parameter.
    // `shadow-ui.ts` is the declared exception: it is the WXT glue.
    const offenders = sources
      .filter((file) => file !== 'src/content/shadow-ui.ts')
      .filter((file) =>
        /\b(chrome|browser)\s*\.\s*(storage|runtime|tabs|alarms|commands)\b/.test(code(file)),
      )
    expect(offenders).toEqual([])
  })

  it('only shadow-ui.ts imports wxt/*', () => {
    const offenders = sources.filter((file) => /from 'wxt(\/|')/.test(code(file)))
    expect(offenders).toEqual(['src/content/shadow-ui.ts'])
  })

  it('every module the service worker loads imports comment-core through /headless', () => {
    // The root entry's *types* reference Element/Range/Document, which a SW tsconfig
    // (`lib: ["ES2022", "WebWorker"]`) does not have — so `headless` is normative, not a
    // convenience, and a type-only import from the root entry still breaks it.
    const swReachable = [
      ...walk('src/background'),
      'src/kv.ts',
      'src/keys.ts',
      'src/host-state.ts',
      'src/settings.ts',
      'src/messaging.ts',
      'src/platform.ts',
    ]
    for (const file of swReachable) {
      expect(code(file), file).not.toMatch(/from '@astrale-os\/comment-core'/)
    }
  })

  it('the service-worker half never imports comment-ui', () => {
    for (const file of walk('src/background')) {
      expect(code(file), file).not.toContain('@astrale-os/comment-ui')
    }
  })

  it('the content half never constructs a second copilot runtime', () => {
    // `createCopilot` in a content script would race the worker's runtime for the same run
    // store; the page gets tool serving and the relay, and nothing else.
    for (const file of walk('src/content')) {
      expect(code(file), file).not.toMatch(/\bcreateCopilot\b/)
    }
  })

  it('the two libraries meet only in the bridge, the adapter and the two tool halves', () => {
    const both = walk('src')
      .filter(
        (file) =>
          code(file).includes('@astrale-os/comment-core') &&
          code(file).includes('@astrale-os/browser-copilot'),
      )
      .sort()
    // background/index.ts is the bridge; kv.ts proves one adapter serves both; the two tool
    // files are the `remoteTool` ⇄ `serveTools` halves, which by construction name a
    // `CommentDomain`/`CommentEngine` on one side and a copilot tool on the other.
    expect(both).toEqual([
      'src/background/index.ts',
      'src/background/tools.ts',
      'src/content/tools.ts',
      'src/kv.ts',
    ])
  })
})

describe('MV3 survival constants', () => {
  it('pings inside the 30 s idle kill window', () => {
    expect(KEEPALIVE_MS).toBeGreaterThan(0)
    expect(KEEPALIVE_MS).toBeLessThan(30_000)
  })

  it('uses the minimum alarm period, which survives browser restart', () => {
    expect(WATCHDOG_PERIOD_MINUTES).toBe(0.5)
  })

  it('registers every listener before the first await in the SW entrypoint', () => {
    // MV3 only wakes a terminated worker for listeners registered in the FIRST turn of initial
    // evaluation. This is a lint that no runtime test can perform.
    const source = read('entrypoints/background.ts')
    const body = source.slice(source.indexOf('main()'))
    expect(body).not.toMatch(/\bawait\b/)
    expect(body).toContain('startBackground(')
  })

  it('the content script runs at document_start on <all_urls>', () => {
    const source = read('entrypoints/content.ts')
    expect(source).toContain("runAt: 'document_start'")
    expect(source).toContain("matches: ['<all_urls>']")
  })

  it('declares no cssInjectionMode, because nothing emits a content stylesheet', () => {
    // `'ui'` makes `createShadowRootUi` fetch `/content-scripts/content.css`, which this
    // entrypoint never emits — a "Failed to load styles" warning on every page for no benefit.
    // The host-chrome sheet is passed inline as the `css` option instead.
    // The option, not the word: the entrypoint's docstring explains why it is absent.
    expect(read('entrypoints/content.ts')).not.toMatch(/cssInjectionMode\s*:/)
    expect(read('src/content/shadow-ui.ts')).toContain('css: hostChromeStyles')
  })

  it('anchors the shadow host to <html>, which exists at document_start', () => {
    // WXT's default anchor is `document.body`, which is null until the parser reaches it, and
    // `mountUi` then throws "could not find anchor element".
    expect(read('src/content/shadow-ui.ts')).toContain("anchor: 'html'")
  })

  it('never sends a worker → page message without a tab target', () => {
    // `sendMessage(type, data)` is `runtime.sendMessage`: extension pages only, never a content
    // script. Every SW → page notification resolves tabs through `tabsForPageKey` instead — and
    // because the failure is silent (`.catch(() => {})` on a best-effort send), no behavioural
    // test can catch a regression here.
    const source = read('src/background/index.ts')
    const sends = [...source.matchAll(/messenger\.sendMessage\(([^;]*?)\),?\n/g)].map(
      (match) => match[1] ?? '',
    )
    expect(sends.length).toBeGreaterThan(0)
    for (const send of sends) expect(send, send).toContain('tabId')
  })

  it('mounts comment-ui with isolateEvents and an explicit root font-size', () => {
    const source = read('src/content/index.ts')
    expect(source).toContain('isolateEvents: true')
    expect(source).toContain("rootFontSize: '16px'")
  })
})
