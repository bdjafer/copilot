/**
 * The demo's proof that Module 1 works with no extension, no service worker and no model:
 * the **built ESM** engine and renderer, the demo's own echo responder, and a `localStorage`
 * store — walked end to end through the UI the way a person walks it.
 *
 *   place → send → echo reply → resolve → reply (auto-reopen) → delete
 *
 * `vitest.config.ts` aliases both package names at `dist/index.js`, and `test/global-setup.ts`
 * builds them first, so nothing here reaches into `src/`. The static pages under `site/` load
 * the IIFE build of the same sources; the last describe pins the `<script>` order that makes
 * that half work.
 */

import type { CommentEngine } from '@astrale-os/comment-core'
import type { CommentUI } from '@astrale-os/comment-ui'

import * as CommentCore from '@astrale-os/comment-core'
import { createCommentEngine, createLocalStorageStore } from '@astrale-os/comment-core'
import * as CommentUi from '@astrale-os/comment-ui'
import { mountCommentUI } from '@astrale-os/comment-ui'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { DEMO_ANCHORING, DEMO_MODES } from '../site/assets/demo.js'
import { attachEchoResponder, echoReply } from '../site/assets/echo.js'
import { BUILT_ENTRIES, ECHO_DELAY, installLocalStorage, settle } from './support.ts'

const PAGE_KEY = 'https://demo.test/basic'
/** vitest's root is `apps/demo`. */
const demoRoot = process.cwd()
const site = resolve(demoRoot, 'site')

/** Wait for the responder's nth reply to be durably written. */
async function waitForEcho(count: number): Promise<void> {
  const deadline = Date.now() + 2000
  while (echoes.length < count) {
    if (Date.now() > deadline) throw new Error(`echo ${count} never arrived`)
    await new Promise<void>((done) => setTimeout(done, 5))
  }
  await settle()
}

installLocalStorage()

let engine: CommentEngine
let ui: CommentUI
let detachEcho: () => void
/** Every `AppendResult` the echo responder produced, in order. */
let echoes: Array<{ threadId: string; reopened: boolean; deduped: boolean }>
let busy: Array<[string, boolean]>
/** Every `thread:reopen` the engine emitted, with the reason that carries who caused it. */
let reopens: Array<{ threadId: string; reason: string }>
let offReopen: () => void

beforeEach(async () => {
  localStorage.clear()
  document.body.innerHTML = `
    <main>
      <h1 id="title">A page nobody built for commenting</h1>
      <p class="intro">Anchors are scored, not looked up.</p>
      <ul>
        <li class="item">Apricot</li>
        <li class="item">Kiwi</li>
      </ul>
    </main>`

  engine = createCommentEngine({
    store: createLocalStorageStore({ namespace: 'exp-spec-demo' }),
    pageKey: PAGE_KEY,
    // The pages' own configuration, imported rather than restated.
    modes: DEMO_MODES,
    anchoring: DEMO_ANCHORING,
  })
  await engine.ready()

  ui = mountCommentUI(engine, { panel: { defaultOpen: true } })
  echoes = []
  busy = []
  reopens = []
  offReopen = engine.on('thread:reopen', ({ thread, reason }) => {
    reopens.push({ threadId: thread.id, reason })
  })
  detachEcho = attachEchoResponder(engine, {
    delay: ECHO_DELAY,
    onBusy: (threadId: string, isBusy: boolean) => {
      busy.push([threadId, isBusy])
      ui.decorate(threadId, isBusy ? { chip: { text: 'echo', tone: 'busy', spinner: true } } : null)
    },
    onReplied: (threadId: string, result: { reopened: boolean; deduped: boolean }) =>
      echoes.push({ threadId, reopened: result.reopened, deduped: result.deduped }),
  })
  await settle()
})

afterEach(() => {
  offReopen()
  detachEcho()
  ui.unmount()
  engine.destroy()
  document.body.innerHTML = ''
  localStorage.clear()
})

/* --------------------------------------------------------------------------- the whole walk */

/** Place through the engine, then Send through the renderer's composer — as a person would. */
async function placeAndSend(selector: string, body: string, kind = 'comment'): Promise<string> {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`no element for ${selector}`)
  expect(engine.placement.start(kind, { element })).toBe(true)
  await settle()

  const input = ui.root.querySelector<HTMLTextAreaElement>('.cc-composer-input')!
  expect(ui.root.querySelector('.cc-composer')?.getAttribute('data-open')).toBe('true')
  input.value = body
  input.dispatchEvent(new Event('input'))
  ui.root.querySelector<HTMLButtonElement>('[data-action="send"]')!.click()
  await settle()

  const [thread] = engine.listThreads()
  expect(thread).toBeDefined()
  return thread.id
}

function popover(): HTMLElement {
  const node = ui.root.querySelector<HTMLElement>('.cc-thread[data-open="true"]')
  if (!node) throw new Error('the thread popover is not open')
  return node
}

function bodies(): string[] {
  return [...popover().querySelectorAll('.cc-body')].map((node) => node.textContent ?? '')
}

function authors(): string[] {
  return [...popover().querySelectorAll('.cc-author')].map((node) => node.textContent ?? '')
}

describe('the demo walk, on the built bundles', () => {
  test('place → send → echo → resolve → reply → delete', async () => {
    // --- place + send ------------------------------------------------------------------
    const threadId = await placeAndSend('.intro', 'does this paragraph still hold?')
    await engine.reanchor()
    await settle()

    // Send wrote exactly one comment, and the badge is on the element that was picked.
    expect(engine.getThreadView(threadId)?.comments).toHaveLength(1)
    expect(ui.root.querySelector(`.cc-badge[data-thread="${threadId}"]`)).not.toBeNull()
    // While the responder "thinks", the HOST decorates the badge — comment-ui has no idea a
    // copilot exists (SPEC-comment-core §7.2).
    expect(busy).toEqual([[threadId, true]])
    expect(ui.root.querySelector('.cc-chip')?.textContent).toBe('echo')

    // --- echo reply --------------------------------------------------------------------
    await waitForEcho(1)
    expect(echoes).toEqual([{ threadId, reopened: false, deduped: false }])
    const view = engine.getThreadView(threadId)!
    expect(view.comments.map((comment) => comment.author)).toEqual(['user', 'copilot'])
    expect(view.lastComment.body).toBe(echoReply('comment', 'does this paragraph still hold?'))
    // The loop guard held: a copilot comment does not trigger another copilot comment.
    await settle()
    expect(engine.getThreadView(threadId)?.comments).toHaveLength(2)
    // The busy chip went up and came back down — the host clears its own decoration.
    expect(busy).toEqual([
      [threadId, true],
      [threadId, false],
    ])
    expect(ui.root.querySelector('.cc-chip')).toBeNull()

    ui.focus(threadId)
    await settle()
    expect(bodies()).toEqual([
      'does this paragraph still hold?',
      echoReply('comment', 'does this paragraph still hold?'),
    ])
    expect(authors()).toEqual(['user', 'copilot'])

    // --- resolve -----------------------------------------------------------------------
    popover().querySelector<HTMLButtonElement>('[data-role="status"]')!.click()
    await settle()
    expect(engine.getThreadView(threadId)?.isResolved).toBe(true)
    // Resolved badges are hidden by default (Figma/Docs behaviour); the panel still lists it.
    expect(ui.root.querySelector(`.cc-badge[data-thread="${threadId}"]`)).toBeNull()
    expect(popover().querySelector('[data-role="status"]')?.getAttribute('data-action')).toBe(
      'reopen',
    )

    // A copilot reply NEVER reopens (§4.1 rules 3/4) — the one asymmetry between the authors.
    const late = await engine.appendComment(threadId, { author: 'copilot', body: 'one more note' })
    expect(late.reopened).toBe(false)
    expect(engine.getThreadView(threadId)?.isResolved).toBe(true)
    expect(reopens).toEqual([])
    await settle()

    // --- reply, which auto-reopens ------------------------------------------------------
    popover().querySelector<HTMLButtonElement>('[data-action="reply"]')!.click()
    await settle()
    const reply = ui.root.querySelector<HTMLTextAreaElement>('.cc-composer-input')!
    reply.value = 'no — the second sentence is wrong'
    reply.dispatchEvent(new Event('input'))
    ui.root.querySelector<HTMLButtonElement>('[data-action="send"]')!.click()
    await settle()

    // The same three assertions the never-reopen case above gets, so the two sides of §4.1's
    // author asymmetry are pinned to the same depth: the state flipped, the engine SAID it
    // flipped, and it said so for the right reason ('reply', not an 'explicit' Reopen click —
    // nothing in this walk pressed one).
    expect(engine.getThreadView(threadId)?.isResolved).toBe(false)
    expect(engine.getThreadView(threadId)?.status).toBe('open')
    expect(reopens).toEqual([{ threadId, reason: 'reply' }])
    const record = await engine.get(threadId)
    expect(record?.thread.resolvedAt).toBeNull()
    expect(record?.thread.resolvedBy).toBeNull()
    // …and the responder answered the user's reply, on the now-open thread.
    await waitForEcho(2)
    expect(echoes).toHaveLength(2)
    expect(echoes[1]).toEqual({ threadId, reopened: false, deduped: false })
    expect(authors()).toEqual(['user', 'copilot', 'copilot', 'user', 'copilot'])

    // --- delete ------------------------------------------------------------------------
    popover().querySelector<HTMLButtonElement>('[data-action="delete"]')!.click()
    await settle()
    expect(engine.listThreads()).toEqual([])
    expect(ui.root.querySelector('.cc-badge')).toBeNull()
    expect(await engine.list()).toEqual([])
  })

  test('a reload rehydrates the thread from localStorage', async () => {
    const threadId = await placeAndSend('#title', 'is this heading right?')
    await waitForEcho(1)

    // A second engine over the same origin storage is what a page reload looks like.
    const reloaded = createCommentEngine({
      store: createLocalStorageStore({ namespace: 'exp-spec-demo' }),
      pageKey: PAGE_KEY,
    })
    try {
      await reloaded.ready()
      const [thread] = reloaded.listThreads()
      expect(thread?.id).toBe(threadId)
      expect(thread?.comments.map((comment) => comment.author)).toEqual(['user', 'copilot'])
    } finally {
      reloaded.destroy()
    }
  })

  test('ask mode is a different kind with a different canned reply', async () => {
    const threadId = await placeAndSend('#title', 'what is this section for?', 'ask')
    await waitForEcho(1)
    const view = engine.getThreadView(threadId)!
    expect(view.kind).toBe('ask')
    expect(view.lastComment.body).toBe(echoReply('ask', 'what is this section for?'))
  })
})

/* ------------------------------------------------------------------ the responder's own rules */

describe('the echo responder', () => {
  test('drops its reply when the thread was deleted while it was thinking', async () => {
    const threadId = await placeAndSend('.item', 'this row moves')
    await waitForEcho(1)

    // Delete inside the delay window. The scheduled reply is cancelled on `thread:delete`, and
    // the durable re-read catches anything already in flight — a dropped output, never a
    // resurrected thread.
    await engine.appendComment(threadId, { author: 'user', body: 'still here?' })
    await engine.delete(threadId)
    await new Promise<void>((done) => setTimeout(done, ECHO_DELAY * 3))
    await settle()
    expect(await engine.list()).toEqual([])
    expect(echoes).toHaveLength(1)
  })

  test('is idempotent — the same comment can only ever be echoed once', async () => {
    const threadId = await placeAndSend('.item', 'echo me exactly once')
    await waitForEcho(1)
    const target = engine.getThreadView(threadId)!.comments[0]

    // A second responder replaying the same source comment (a reload, or a second tab observing
    // the same store) writes nothing: `id` is the idempotency key.
    const second = await engine.appendComment(threadId, {
      author: 'copilot',
      body: echoReply('comment', target.body),
      id: `echo:${target.id}`,
    })
    expect(second.deduped).toBe(true)
    expect(engine.getThreadView(threadId)?.comments).toHaveLength(2)
  })
})

/* ------------------------------------------------------------------- the static pages contract */

describe('the static pages', () => {
  const pages = readdirSync(`${site}/pages`).sort()

  test('cover the scenario matrix (PLAN §3.8)', () => {
    expect(pages).toEqual([
      'attribute-churn.html',
      'basic.html',
      'infinite-scroll.html',
      'popover.html',
      'reorder.html',
      'spa.html',
    ])
    expect(existsSync(`${site}/index.html`)).toBe(true)
    // The one page DESIGN §9 sanctions a heavyweight upgrade on, and the only page that has one.
    expect(existsSync(`${site}/material.html`)).toBe(true)
  })

  test('load the three bundles in order, and boot through the shared module', () => {
    for (const page of [...pages.map((page) => `pages/${page}`), 'index.html', 'material.html']) {
      const html = readFileSync(`${site}/${page}`, 'utf8')
      const loaded = [...html.matchAll(/<script src="[^"]*\/(\S+\.iife\.js)"/g)].map((m) => m[1])
      // §1.2: `comment-ui` reads `globalThis.Comments` and the appearance is selected at mount
      // from `globalThis.CommentsUIGlass`, so this order is load-bearing twice over.
      expect(loaded, page).toEqual([
        'comment-core.iife.js',
        'comment-ui.iife.js',
        'comment-ui-glass.iife.js',
      ])
      expect(html, page).toContain('bootDemo(')
    }
  })

  test('the tests really did load the built bundles', async () => {
    for (const entry of Object.values(BUILT_ENTRIES)) {
      expect(entry).toMatch(/[/\\]dist[/\\](index|glass)\.js$/)
      expect(existsSync(entry)).toBe(true)
    }

    // The paths existing proves nothing about what THIS file imported. `vitest.config.ts`
    // builds its aliases from the same `BUILT_ENTRIES`, so importing each built entry directly
    // must hand back the very objects the suite has been driving: repoint an alias at `src/`
    // and these identities break, which is the failure the old two-string assertion missed.
    const core = (await import(
      pathToFileURL(BUILT_ENTRIES['@astrale-os/comment-core']).href
    )) as typeof CommentCore
    const ui = (await import(
      pathToFileURL(BUILT_ENTRIES['@astrale-os/comment-ui']).href
    )) as typeof CommentUi
    expect(core.createCommentEngine).toBe(CommentCore.createCommentEngine)
    expect(ui.mountCommentUI).toBe(CommentUi.mountCommentUI)
    // …and the engine the UI bundle writes through is the SAME copy the test drives, which is
    // what "declares comment-core external" buys (§1.2). Two copies would fail here.
    expect(core.CommentError).toBe(CommentCore.CommentError)
  })
})
