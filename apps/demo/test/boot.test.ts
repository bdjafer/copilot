/**
 * `bootDemo()` — the function **every** demo page calls, and the only thing between the built
 * bundles and a person clicking a badge. `demo.test.ts` walks the domain by building its own
 * engine, so nothing there executes this file: the guard on the two globals, the
 * `mountCommentUI` call, the toolbar wiring, `engine.subscribe(describe)` and the `globalThis`
 * devtools handle were all covered by `expect(html).toContain('bootDemo(')` — a rename or a
 * typo anywhere inside them left the suite green.
 *
 * The two `<script src>` globals are installed here from the **built** modules (the same ones
 * `vitest.config.ts` aliases), which is exactly what the IIFE pair does on a real page.
 */

import type { CommentEngine } from '@astrale-os/comment-core'
import type { CommentUI } from '@astrale-os/comment-ui'

import * as Comments from '@astrale-os/comment-core'
import * as CommentsUI from '@astrale-os/comment-ui'
import * as CommentsUIGlass from '@astrale-os/comment-ui/glass'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { bootDemo, DEMO_ANCHORING, DEMO_MODES } from '../site/assets/demo.js'
import { echoReply } from '../site/assets/echo.js'
import { ECHO_DELAY, installLocalStorage, settle } from './support.ts'

interface DemoApi {
  engine: CommentEngine
  ui: CommentUI
  log: (text: string, kind?: string) => void
  detach: () => void
}

installLocalStorage()

/** What the three `<script src="…iife.js">` tags leave on the page. */
function installGlobals(): void {
  Object.defineProperty(globalThis, 'Comments', { value: Comments, configurable: true })
  Object.defineProperty(globalThis, 'CommentsUI', { value: CommentsUI, configurable: true })
  Object.defineProperty(globalThis, 'CommentsUIGlass', {
    value: CommentsUIGlass,
    configurable: true,
  })
}

function clearGlobals(): void {
  Reflect.deleteProperty(globalThis, 'Comments')
  Reflect.deleteProperty(globalThis, 'CommentsUI')
  Reflect.deleteProperty(globalThis, 'CommentsUIGlass')
}

let demo: DemoApi | null = null

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = `
    <main>
      <h1 id="title">A page nobody built for commenting</h1>
      <p class="intro">Anchors are scored, not looked up.</p>
    </main>`
  installGlobals()
})

afterEach(() => {
  demo?.detach()
  demo = null
  clearGlobals()
  Reflect.deleteProperty(globalThis, 'demo')
  document.body.innerHTML = ''
  localStorage.clear()
})

function boot(options: Record<string, unknown> = {}): DemoApi {
  demo = bootDemo({ delay: ECHO_DELAY, ...options }) as DemoApi
  return demo
}

function bar(selector: string): HTMLElement {
  const node = document.querySelector<HTMLElement>(selector)
  if (!node) throw new Error(`no toolbar node for ${selector}`)
  return node
}

function logLines(): string[] {
  return [...document.querySelectorAll('.demo-log li')].map((node) => node.textContent ?? '')
}

describe('the guard on the two globals', () => {
  test('a page that forgot the <script src> pair fails loudly', () => {
    clearGlobals()
    expect(() => bootDemo({})).toThrow(/comment-core\.iife\.js/)
  })

  test('and so does one that loaded only comment-core (§1.2 load order)', () => {
    Reflect.deleteProperty(globalThis, 'CommentsUI')
    expect(() => bootDemo({})).toThrow(/comment-ui\.iife\.js/)
  })
})

describe('bootDemo wires the page', () => {
  test('mounts the UI, publishes the devtools handle and renders the toolbar copy', async () => {
    const api = boot({ title: 'Basic static page', hint: 'press C' })
    await api.engine.ready()
    await settle()

    expect(Reflect.get(globalThis, 'demo')).toBe(api)
    expect(bar('.demo-bar-title').textContent).toBe('Basic static page')
    expect(bar('.demo-bar-hint').textContent).toBe('press C')
    // The renderer is really mounted — shadow root, panel open by default.
    expect(api.ui.root.querySelector('.cc-panel')?.getAttribute('data-open')).toBe('true')
    // The pages' own configuration reached the engine, rather than the library defaults.
    expect(api.engine.modes.map((mode) => mode.kind)).toEqual(DEMO_MODES.map((mode) => mode.kind))
    // Back on the library default: the 0.9 the demo used to demand was a workaround for the
    // scoring arithmetic SPEC §2.5 / decision log #26 replaced.
    expect(DEMO_ANCHORING.threshold).toBe(0.62)
    expect(bar('[data-demo="counts"]').textContent).toBe('0 open · 0 resolved · 0 orphaned')
  })

  test('the toolbar buttons drive placement and the reset', async () => {
    const api = boot()
    await api.engine.ready()
    await settle()

    bar('[data-demo="comment"]').click()
    expect(api.engine.placement.get()).toMatchObject({ phase: 'picking', kind: 'comment' })
    api.engine.placement.cancel('escape')

    bar('[data-demo="ask"]').click()
    expect(api.engine.placement.get()).toMatchObject({ phase: 'picking', kind: 'ask' })
    api.engine.placement.cancel('escape')

    const threadId = await place(api, '.intro', 'does this paragraph still hold?')
    expect(api.engine.listThreads()).toHaveLength(1)
    bar('[data-demo="reset"]').click()
    await settle()
    expect(api.engine.listThreads()).toEqual([])
    expect(await api.engine.list()).toEqual([])
    expect(threadId).toBeTruthy()
  })

  test('the echo responder is attached, decorates the badge and logs every event', async () => {
    const api = boot()
    await api.engine.ready()
    await settle()

    const threadId = await place(api, '.intro', 'does this paragraph still hold?')
    // Host-owned chrome: `bootDemo` is the host, so the busy chip is ITS decoration.
    expect(api.ui.root.querySelector('.cc-chip')?.textContent).toBe('echo')
    expect(bar('[data-demo="counts"]').textContent).toBe('1 open · 0 resolved · 0 orphaned')

    await waitForLog(/^echo → /)
    const view = api.engine.getThreadView(threadId)
    expect(view?.comments.map((comment) => comment.author)).toEqual(['user', 'copilot'])
    expect(view?.lastComment.body).toBe(echoReply('comment', 'does this paragraph still hold?'))
    expect(api.ui.root.querySelector('.cc-chip')).toBeNull()

    // `describe()` builds every one of these lines by reading the event payload — a renamed
    // field is a thrown TypeError inside a store notification, not a missing line.
    const lines = logLines()
    expect(lines.some((line) => line.startsWith('thread:create'))).toBe(true)
    expect(lines.some((line) => line.startsWith('thread:reply'))).toBe(true)
    expect(lines.some((line) => /^echo → .+ reopened=false deduped=false$/.test(line))).toBe(true)
    expect(lines.every((line) => !line.includes('undefined'))).toBe(true)

    // The two anchoring branches of `describe()`, which only a TRANSITION reaches. Taking the
    // paragraph out of the page orphans the thread: the badge docks instead of moving to some
    // other paragraph. (Renaming its class used to be enough. §2.5's class rule now ignores a
    // class that no second element corroborates — bench F4 — and an element whose text is
    // unchanged is still the same element, so a rename is no longer a transition at all.)
    const intro = document.querySelector('.intro')!
    const host = intro.parentElement!
    intro.remove()
    await api.engine.reanchor()
    await settle()
    expect(api.engine.getThreadView(threadId)?.isOrphaned).toBe(true)
    expect(logLines()[0]).toMatch(/^thread:orphaned \S+ — badge docks, nothing is written$/)

    // …and putting it back re-anchors at 1.00, which is the `p.confidence.toFixed(2)` line.
    host.append(intro)
    await api.engine.reanchor()
    await settle()
    expect(logLines()[0]).toMatch(/^thread:anchored \S+ via \S+ \(\d\.\d{2}\) ← orphaned$/)

    // The log is capped, so a long session cannot grow the DOM without bound.
    for (let i = 0; i < 20; i += 1) api.log(`filler ${String(i)}`)
    expect(document.querySelectorAll('.demo-log li')).toHaveLength(14)
  })

  test('detach() unsubscribes, unmounts and takes the toolbar with it', async () => {
    const api = boot()
    await api.engine.ready()
    await settle()
    await place(api, '#title', 'is this heading right?')

    api.detach()
    demo = null
    expect(document.querySelector('.demo-bar')).toBeNull()
    expect(document.querySelector('[data-comment-ui]')).toBeNull()
    // A destroyed engine is the last word: §4.4 post-destroy calls reject, they never throw.
    await expect(api.engine.list()).rejects.toThrow(/destroyed/)
  })
})

/** Place through the engine and Send through the renderer's composer, as a person would. */
async function place(api: DemoApi, selector: string, body: string): Promise<string> {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`no element for ${selector}`)
  expect(api.engine.placement.start('comment', { element })).toBe(true)
  await settle()

  const input = api.ui.root.querySelector<HTMLTextAreaElement>('.cc-composer-input')
  if (!input) throw new Error('the composer never opened')
  input.value = body
  input.dispatchEvent(new Event('input'))
  api.ui.root.querySelector<HTMLButtonElement>('[data-action="send"]')?.click()
  await settle()

  const [thread] = api.engine.listThreads()
  if (!thread) throw new Error('Send wrote no thread')
  return thread.id
}

async function waitForLog(pattern: RegExp): Promise<void> {
  const deadline = Date.now() + 2000
  while (!logLines().some((line) => pattern.test(line))) {
    if (Date.now() > deadline) throw new Error(`no log line matched ${String(pattern)}`)
    await new Promise<void>((done) => setTimeout(done, 5))
  }
  await settle()
}
