/**
 * The demo's two design commitments: **glass is what a page mounts**, and **nothing heavy is on
 * the wire before somebody has expressed intent**.
 *
 * The first is one field in `bootDemo`, and the escape hatch is one query parameter — which is
 * the cheapest possible demonstration that the renderer really did split into a headless
 * controller and a swappable presentation. Everything else in `demo.js` (the echo responder, the
 * log, the counts, the reset) is written against the engine and does not know or care which
 * appearance is mounted, and these cases run the same walk under both to prove it.
 *
 * The second is `material.html`. DESIGN §9 sanctioned a 3D renderer on exactly one page, with a
 * budget, and with the rule that exceeding the budget deletes the page rather than the budget.
 * The measurement is in `site/material.html` and the outcome is in `package.json`: there is no 3D
 * library in this repository. What survives is the lazy-load *discipline* the ruling attached to
 * it — five gates, a dynamic import that is the last line of the loader, and a CSS rendering that
 * is complete on its own — and that discipline is what the last describe pins.
 */

import type { CommentEngine } from '@astrale-os/comment-core'
import type { CommentUI } from '@astrale-os/comment-ui'

import * as Comments from '@astrale-os/comment-core'
import * as CommentsUI from '@astrale-os/comment-ui'
import * as CommentsUIGlass from '@astrale-os/comment-ui/glass'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { bootDemo, resolveTheme } from '../site/assets/demo.js'
import { upgradeMaterial } from '../site/assets/material.js'
import { ECHO_DELAY, installLocalStorage, settle } from './support.ts'

interface DemoApi {
  engine: CommentEngine
  ui: CommentUI
  theme: string
  log: (text: string, kind?: string) => void
  detach: () => void
}

const demoRoot = process.cwd()
const site = resolve(demoRoot, 'site')

installLocalStorage()

function installGlobals(): void {
  for (const [name, value] of [
    ['Comments', Comments],
    ['CommentsUI', CommentsUI],
    ['CommentsUIGlass', CommentsUIGlass],
  ] as const) {
    Object.defineProperty(globalThis, name, { value, configurable: true })
  }
}

let demo: DemoApi | null = null

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML =
    '<main><h1 id="title">A page nobody built for commenting</h1>' +
    '<p class="intro">Anchors are scored, not looked up.</p></main>'
  installGlobals()
})

afterEach(() => {
  demo?.detach()
  demo = null
  for (const name of ['Comments', 'CommentsUI', 'CommentsUIGlass', 'demo']) {
    Reflect.deleteProperty(globalThis, name)
  }
  document.body.innerHTML = ''
  localStorage.clear()
})

function boot(options: Record<string, unknown> = {}): DemoApi {
  demo = bootDemo({ delay: ECHO_DELAY, ...options }) as DemoApi
  return demo
}

/* --------------------------------------------------------------------------- the appearance */

describe('the demo mounts the product, not the fallback', () => {
  test('glass is the default, and it is the one the sprite gives away', async () => {
    const api = boot()
    await api.engine.ready()
    await settle()
    expect(api.theme).toBe('glass')
    // The 19-glyph sprite is injected by `glassPresentation` and by nothing else, so its presence
    // is a fact about which appearance is mounted rather than about which class names exist.
    expect(api.ui.root.querySelector('.cc-sprite symbol')).not.toBeNull()
    expect(api.ui.root.querySelector('.cc-seed')).not.toBeNull()
  })

  test('`?theme=default` is a real escape hatch onto the frozen appearance', async () => {
    const api = boot({ theme: 'default' })
    await api.engine.ready()
    await settle()
    expect(api.theme).toBe('default')
    expect(api.ui.root.querySelector('.cc-sprite')).toBeNull()
    // The frozen markup, unchanged: a corner toggle rather than a seed.
    expect(api.ui.root.querySelector('.cc-panel-toggle')).not.toBeNull()
    expect(api.ui.root.querySelector('.cc-seed')).toBeNull()
  })

  test('the query parameter is the only thing that selects it', () => {
    expect(resolveTheme('')).toBe('glass')
    expect(resolveTheme('?theme=glass')).toBe('glass')
    expect(resolveTheme('?theme=default')).toBe('default')
    // Anything else is glass: an unknown value must not leave a page with no appearance at all.
    expect(resolveTheme('?theme=neon')).toBe('glass')
    expect(resolveTheme('?route=b&theme=default')).toBe('default')
  })

  test('a page that forgot the appearance bundle says so, and names the fix', () => {
    Reflect.deleteProperty(globalThis, 'CommentsUIGlass')
    expect(() => bootDemo({})).toThrow(/comment-ui-glass\.iife\.js/)
    // …and the escape hatch does not need it, which is what makes the hatch an escape.
    const api = bootDemo({ theme: 'default', delay: ECHO_DELAY }) as DemoApi
    demo = api
    expect(api.theme).toBe('default')
  })

  test('the whole walk is appearance-agnostic — the same code drives both', async () => {
    for (const theme of ['glass', 'default'] as const) {
      localStorage.clear()
      const api = boot({ theme })
      await api.engine.ready()
      await settle()

      const element = document.querySelector('.intro')!
      expect(api.engine.placement.start('comment', { element })).toBe(true)
      await settle()
      const input = api.ui.root.querySelector<HTMLTextAreaElement>('.cc-composer-input')
      expect({ theme, composer: input !== null }).toEqual({ theme, composer: true })
      input!.value = 'does this paragraph still hold?'
      input!.dispatchEvent(new Event('input'))
      api.ui.root.querySelector<HTMLButtonElement>('[data-action="send"]')!.click()
      await settle()

      expect({ theme, threads: api.engine.listThreads().length }).toEqual({ theme, threads: 1 })
      api.detach()
      demo = null
    }
  })

  test('the host owns the summon chord, because a library must not take one', async () => {
    const api = boot()
    await api.engine.ready()
    await settle()
    expect(api.ui.panel.isOpen).toBe(true)

    const chord = (): void => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'C', altKey: true, shiftKey: true, bubbles: true }),
      )
    }
    chord()
    expect(api.ui.panel.isOpen).toBe(false)
    chord()
    expect(api.ui.panel.isOpen).toBe(true)

    // …and it comes off with the rest of the page, or a detached demo keeps eating keystrokes.
    api.detach()
    demo = null
    chord()
    expect(api.ui.panel.isOpen).toBe(true)
  })
})

/* -------------------------------------------------------- the one sanctioned heavy moment */

interface FakeObserver {
  count: number
  fire(ratio: number): void
}

/** Poll rather than count microtasks: a dynamic import is a load, not a promise chain. */
async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: never became true')
    await new Promise<void>((done) => setTimeout(done, 5))
  }
}

interface GateOverrides {
  reducedMotion?: boolean
  deviceMemory?: number
  hardwareConcurrency?: number
  displacement?: boolean
}

/**
 * The five gates, all satisfiable, so a test can fail exactly one of them at a time.
 *
 * The stubs land on `document.defaultView` because that is the window `upgradeMaterial` reads —
 * it takes it off the stage rather than off the ambient global, so that a page embedding the
 * stage in an iframe still gates against the right machine.
 */
function stubGates(overrides: GateOverrides = {}): { observer: FakeObserver; restore(): void } {
  const win = (document.defaultView ?? globalThis) as unknown as Record<string, unknown>
  const saved = new Map<string, PropertyDescriptor | undefined>()
  const set = (host: object, name: string, value: unknown): void => {
    const key = `${host === win ? 'win' : 'nav'}:${name}`
    if (!saved.has(key)) saved.set(key, Reflect.getOwnPropertyDescriptor(host, name))
    Object.defineProperty(host, name, { value, configurable: true, writable: true })
  }
  const navigator = win.navigator as object

  const state: FakeObserver = { count: 0, fire: () => {} }
  class Fake {
    constructor(private readonly callback: (records: unknown[]) => void) {
      state.count += 1
      state.fire = (ratio) => {
        this.callback([{ isIntersecting: ratio > 0, intersectionRatio: ratio }])
      }
    }
    observe(): void {}
    disconnect(): void {}
  }

  const reduced = overrides.reducedMotion ?? false
  set(win, 'matchMedia', (query: string) => ({
    matches: String(query).includes('no-preference') ? !reduced : reduced,
  }))
  set(win, 'IntersectionObserver', Fake)
  set(win, 'requestIdleCallback', (fn: () => void) => {
    fn()
  })
  if (overrides.displacement === false) {
    set(win, 'SVGFEDisplacementMapElement', undefined)
  } else {
    set(win, 'SVGFEDisplacementMapElement', function SVGFEDisplacementMapElement() {})
  }
  set(navigator, 'deviceMemory', overrides.deviceMemory ?? 8)
  set(navigator, 'hardwareConcurrency', overrides.hardwareConcurrency ?? 8)

  return {
    observer: state,
    restore() {
      for (const [key, descriptor] of saved) {
        const [scope, name] = key.split(':')
        const host = scope === 'win' ? win : navigator
        if (descriptor) Object.defineProperty(host, name, descriptor)
        else Reflect.deleteProperty(host, name)
      }
    },
  }
}

describe('the material page — the ruling, applied', () => {
  test('there is no 3D library in this repository, because the budget deleted it', () => {
    const manifest = JSON.parse(readFileSync(resolve(demoRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
    }
    const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    expect(
      names.filter((name) => /^(three|babylonjs|@babylonjs|regl|ogl|pixi)/.test(name)),
    ).toEqual([])
    // The measurement that decided it is written down on the page it decided about, so nobody
    // has to re-derive it from a commit message.
    const html = readFileSync(`${site}/material.html`, 'utf8')
    expect(html).toContain('127.5 KB')
    expect(html).toContain('45 KB gz')
  })

  test('the loader reaches the chunk through a dynamic import, and only that way', () => {
    const loader = readFileSync(`${site}/assets/material.js`, 'utf8')
    // A static import would defeat every gate below it, because the bytes would already be on
    // the wire before the first one was evaluated. This is the whole file's reason to exist.
    expect(loader).not.toMatch(/^\s*import\b[^\n]*material-lens/m)
    expect(loader).toMatch(/\bimport\(\s*'\.\/material-lens\.js'\s*\)/)
    // …and nothing else on the page pulls it in either: no tag, no preload, no module import.
    const html = readFileSync(`${site}/material.html`, 'utf8')
    expect(html).not.toMatch(/<(script|link)[^>]*material-lens/)
    expect(html).not.toMatch(/^\s*import\b[^\n]*material-lens/m)
  })

  test('the page renders its content before any of this runs', () => {
    const html = readFileSync(`${site}/material.html`, 'utf8')
    const css = readFileSync(`${site}/assets/demo.css`, 'utf8')
    // The lozenge is markup plus CSS. The upgrade is strictly additive and never load-bearing
    // for meaning — which is what makes refusing to load it a non-event.
    expect(html).toContain('class="material-lozenge"')
    expect(css).toContain('.material-lozenge {')
    expect(css).toContain("[data-lens='on']")
  })

  test.each([
    ['motion', { reducedMotion: true }],
    ['memory', { deviceMemory: 2 }],
    ['cores', { hardwareConcurrency: 4 }],
  ] as [string, GateOverrides][])(
    'gate %s refuses before an observer is even installed',
    (gate, override) => {
      const gates = stubGates(override)
      try {
        const stage = document.createElement('div')
        document.body.append(stage)
        const reports: { loaded: boolean; blockedBy: string | null }[] = []
        const teardown = upgradeMaterial(stage, (state) => reports.push(state))
        expect(reports).toEqual([{ loaded: false, blockedBy: gate }])
        // Cheapest-first: a machine that fails on cores never pays for an observer.
        expect(gates.observer.count).toBe(0)
        expect(stage.dataset.lens).toBeUndefined()
        teardown()
        stage.remove()
      } finally {
        gates.restore()
      }
    },
  )

  test('an observed but unseen stage loads nothing', () => {
    const gates = stubGates()
    try {
      const stage = document.createElement('div')
      document.body.append(stage)
      const reports: { loaded: boolean; blockedBy: string | null }[] = []
      upgradeMaterial(stage, (state) => reports.push(state))
      expect(gates.observer.count).toBe(1)
      expect(reports).toEqual([{ loaded: false, blockedBy: 'viewport' }])

      // Below the quarter-visible threshold is still "not yet".
      gates.observer.fire(0.1)
      expect(stage.dataset.lens).toBeUndefined()
      stage.remove()
    } finally {
      gates.restore()
    }
  })

  test('a quarter-visible stage upgrades, and leaving the viewport tears it down', async () => {
    const gates = stubGates()
    try {
      const stage = document.createElement('div')
      document.body.append(stage)
      const reports: { loaded: boolean; blockedBy: string | null }[] = []
      const teardown = upgradeMaterial(stage, (state) => reports.push(state))

      gates.observer.fire(0.4)
      // A dynamic import is a network hop in a browser and a transform hop here, so this waits
      // for the chunk rather than for a fixed number of microtasks.
      await waitFor(() => stage.dataset.lens === 'on')
      expect(reports.at(-1)).toEqual({ loaded: true, blockedBy: null })
      expect(stage.dataset.lens).toBe('on')
      expect(stage.querySelector('filter#demo-lens')).not.toBeNull()
      // ~700 bytes of markup: turbulence and a displacement map, and nothing else.
      expect(stage.querySelector('feTurbulence')).not.toBeNull()
      expect(stage.querySelector('feDisplacementMap')?.getAttribute('in2')).toBe('noise')

      gates.observer.fire(0)
      expect(stage.dataset.lens).toBeUndefined()
      expect(stage.querySelector('filter#demo-lens')).toBeNull()

      teardown()
      stage.remove()
    } finally {
      gates.restore()
    }
  })

  test('an engine with no displacement map keeps the page and drops the upgrade', async () => {
    const gates = stubGates({ displacement: false })
    try {
      const stage = document.createElement('div')
      document.body.append(stage)
      const reports: { loaded: boolean; blockedBy: string | null }[] = []
      upgradeMaterial(stage, (state) => reports.push(state))
      gates.observer.fire(0.9)
      await waitFor(() => reports.length > 1)
      expect(reports.at(-1)).toEqual({ loaded: false, blockedBy: 'support' })
      expect(stage.dataset.lens).toBeUndefined()
      stage.remove()
    } finally {
      gates.restore()
    }
  })
})
