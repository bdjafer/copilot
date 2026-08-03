/**
 * The thin layer between a scenario and a real Chromium.
 *
 * Every browser action goes through the `agent-browser` CLI — one process per action, one
 * long-lived browser session behind them. Nothing here talks to CDP directly and nothing here
 * knows what a comment is; scenarios do.
 *
 * Two rules the whole bench rests on:
 *
 *  1. **Assertions are DOM assertions.** `probe()` reads the live engine and the live shadow-root
 *     badge and returns plain JSON. Screenshots are evidence for a human, never the test.
 *  2. **The element identity is content, not position.** `idOf()` keys an element on
 *     `TAG|normalized text`, and reports its structural path separately. That is what makes
 *     "re-anchored to the SAME element" checkable after a reload rebuilt every node, after a
 *     shuffle moved it, and after a popover re-mounted it somewhere else in the tree.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const BENCH_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SHOTS_DIR = resolve(BENCH_DIR, 'shots')

export const BASE = process.env.BENCH_BASE ?? 'http://127.0.0.1:4271'
const BIN = process.env.BENCH_BIN ?? 'agent-browser'
const SESSION = process.env.BENCH_SESSION ?? 'expspec-bench'

mkdirSync(SHOTS_DIR, { recursive: true })

/** One `agent-browser` invocation. Throws with stderr attached so a scenario can catch it. */
export function ab(args, input) {
  try {
    return execFileSync(BIN, ['--session', SESSION, ...args], {
      encoding: 'utf8',
      input,
      timeout: 90_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`agent-browser ${args.join(' ')} failed: ${detail || error.message}`)
  }
}

export const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/* --------------------------------------------------------------------------- in-page helpers */

/**
 * Prepended to every `evalPage()` snippet. Kept as one string (rather than an init script) so a
 * scenario can be replayed by hand: paste the prelude + the snippet into devtools and you get the
 * same JSON the bench recorded.
 */
const PRELUDE = String.raw`
const engine = globalThis.demo && globalThis.demo.engine
const shadow = [...document.documentElement.children].map((n) => n.shadowRoot).find(Boolean) || null
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()
const round = (n) => Math.round(n * 1000) / 1000
const rectOf = (r) => ({
  top: Math.round(r.top), left: Math.round(r.left),
  width: Math.round(r.width), height: Math.round(r.height),
})
const idOf = (el) => {
  if (!el || !el.isConnected) return null
  const path = []
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const p = n.parentElement
    path.unshift(n.tagName.toLowerCase() + (p ? ':nth-child(' + ([...p.children].indexOf(n) + 1) + ')' : ''))
  }
  const text = norm(el.textContent).slice(0, 90)
  return {
    key: el.tagName + '|' + text,
    tag: el.tagName,
    domId: el.id || null,
    text,
    path: path.join('>'),
    rect: rectOf(el.getBoundingClientRect()),
  }
}
const badgeOf = (id) => {
  const b = shadow && shadow.querySelector('.cc-badge[data-thread="' + id + '"]')
  if (!b) return null
  const r = b.getBoundingClientRect()
  const cs = getComputedStyle(b)
  return {
    anchorAttr: b.getAttribute('data-anchor'),
    statusAttr: b.getAttribute('data-status'),
    approximate: b.getAttribute('data-approximate') === 'true',
    hidden: b.hasAttribute('hidden'),
    marks: [...b.querySelectorAll('.cc-mark')].map((m) => m.getAttribute('data-mark')),
    opacity: Number(cs.opacity),
    borderStyle: cs.borderStyle,
    label: b.getAttribute('aria-label'),
    center: { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) },
  }
}
const panelOf = (id) => {
  if (!shadow) return null
  const row = shadow.querySelector('.cc-panel [data-thread="' + id + '"]')
  const section = row && row.closest('[data-section]')
  const counts = {}
  for (const h of shadow.querySelectorAll('.cc-panel h3')) {
    const m = norm(h.textContent).match(/^([A-Za-z ]+)\((\d+)\)$/)
    if (m) counts[m[1].trim().toLowerCase()] = Number(m[2])
  }
  return { listed: !!row, section: section ? section.getAttribute('data-section') : null, counts }
}
/** Everything the bench asserts on, for one thread, right now. */
const probe = (threadId) => {
  if (!engine) return { found: false, reason: 'no engine on page' }
  const view = threadId ? engine.getThreadView(threadId) : engine.listThreads()[0]
  const threads = engine.listThreads().length
  if (!view) return { found: false, threads, pageKey: engine.pageKey }
  const element = idOf(view.anchoring.element)
  const badge = badgeOf(view.id)
  const out = {
    found: true,
    id: view.id,
    threads,
    pageKey: engine.pageKey,
    status: view.anchoring.status,
    confidence: round(view.anchoring.confidence),
    via: view.anchoring.via,
    isOrphaned: view.isOrphaned,
    isResolved: view.isResolved,
    comments: view.comments.length,
    dockRect: view.anchoring.rect ? rectOf(view.anchoring.rect) : null,
    element,
    badge,
    panel: panelOf(view.id),
  }
  // top-end placement with offset [6, -6]: the badge sits on the element's top-right corner.
  if (element && badge) {
    out.badgeOffset = {
      dx: badge.center.x - (element.rect.left + element.rect.width),
      dy: badge.center.y - element.rect.top,
    }
  }
  return out
}
/** A fresh per-selector trace. Read-only w.r.t. anchor status (it only refreshes the cache). */
const traceOf = (threadId) => {
  const ex = engine && engine.explain(threadId, { fresh: true })
  if (!ex) return null
  return {
    totalMs: ex.totalMs,
    accepted: ex.result ? { via: ex.result.via, confidence: round(ex.result.confidence) } : null,
    attempts: ex.attempts.map((a) => ({
      selector: typeof a.selector === 'string' ? a.selector : a.selector.type,
      candidates: a.candidates,
      best: round(a.best),
      accepted: a.accepted,
    })),
  }
}
/**
 * Re-resolves the STORED anchor record with the exported engine API, at several accept
 * thresholds, against whatever DOM is on the page right now. This is the measurement that
 * separates "the anchor is fine, the threshold is wrong" from "the anchor points at the wrong
 * element" — and it is the same call the real-site smoke uses.
 */
const resolveAt = async (threadId, thresholds) => {
  const record = await engine.get(threadId)
  if (!record) return null
  const anchor = record.thread.anchor
  const matches = {}
  for (const threshold of thresholds) {
    const match = globalThis.Comments.resolveAnchor(anchor, { document, root: document, threshold })
    matches['@' + String(threshold)] = match
      ? { confidence: round(match.confidence), via: match.via, element: idOf(match.element) }
      : null
  }
  return {
    mode: anchor.mode,
    selectors: anchor.selectors.map((s) => ({ type: s.type, value: s.value ?? null })),
    fingerprint: {
      tag: anchor.fingerprint.tag,
      id: anchor.fingerprint.id ?? null,
      stableClasses: anchor.fingerprint.stableClasses,
      attrs: anchor.fingerprint.attrs,
      textDigest: (anchor.fingerprint.textDigest || '').slice(0, 90),
    },
    matches,
  }
}
/** The raw persisted bytes for this page — used to prove an orphan writes nothing. */
const storeBytes = () => {
  const out = {}
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i)
    if (k.startsWith('exp-spec-demo')) out[k] = localStorage.getItem(k)
  }
  return JSON.stringify(out)
}
`

/**
 * Runs `code` (an async-arrow body — must `return`) in the page and parses the JSON result.
 * Async so snippets can `await engine.get()`; agent-browser awaits the promise for us.
 */
export function evalPage(code) {
  const out = ab(['eval', '--stdin'], `(async () => {\n${PRELUDE}\n${code}\n})()`)
  const text = out.trim()
  if (text === '' || text === 'undefined') return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`eval did not return JSON:\n${text.slice(0, 400)}`)
  }
}

/* ------------------------------------------------------------------------------ page actions */

export function open(path) {
  ab(['open', path.startsWith('http') ? path : BASE + path])
}

/**
 * Pinned so the bench is reproducible: the default window is 1280×577 here, which puts the demo
 * pages' control rows at the very bottom edge — a CDP click on an element whose centre is one
 * pixel below the fold reports success and does nothing. 1440×900 keeps every control clickable
 * while still leaving the feed pages taller than the viewport, which the off-screen-badge check
 * needs.
 */
export const VIEWPORT = { width: 1440, height: 900 }
export const setViewport = () =>
  ab(['set', 'viewport', String(VIEWPORT.width), String(VIEWPORT.height)])

export const reload = () => ab(['reload'])
export const back = () => ab(['back'])
export const forward = () => ab(['forward'])
export const clickPage = (selector) => ab(['click', selector])
export const scroll = (dir, px) => ab(['scroll', dir, String(px)])
export const scrollIntoView = (selector) => ab(['scrollintoview', selector])
export const shot = (name) => ab(['screenshot', resolve(SHOTS_DIR, name)])

/** Waits for the demo engine to report `ready`, then for one anchoring batch to land. */
export async function waitReady() {
  ab(['wait', '--fn', "globalThis.demo && globalThis.demo.engine.status.get() === 'ready'"])
  await sleep(450)
}

/** Clears the demo's localStorage and reloads onto a clean page. */
export async function resetStore() {
  evalPage('localStorage.clear(); return { cleared: true }')
  reload()
  await waitReady()
}

/**
 * Drops focus back to the body.
 *
 * Needed after a scenario clicks a demo checkbox: `isEditableTarget` (placement.ts) treats every
 * `<input>` as editable regardless of `type`, so an unmodified trigger key is swallowed while a
 * checkbox or radio holds focus. Returns what was focused, so the bench can record it.
 */
export function blurActive() {
  return evalPage(`
    const active = document.activeElement
    const was = active ? active.tagName + (active.type ? '[type=' + active.type + ']' : '') : null
    if (active && active !== document.body) active.blur()
    return { was }
  `)
}

/**
 * Places a thread the way a human does: keyboard trigger, real click, real typing.
 *
 * No programmatic seam is used anywhere in this bench — `placement.start()` / `submit()` are
 * never called. `press c` reaches the engine's capture-phase window listener, the CDP click
 * reaches its capture-phase document listener, and the composer's textarea is focused by
 * comment-ui itself, so `keyboard type` lands in it through the shadow boundary.
 */
export async function placeComment({ key = 'c', selector, body }) {
  ab(['press', key])
  const picking = evalPage('return { phase: engine.placement.get().phase }')
  if (picking.phase !== 'picking') throw new Error(`trigger '${key}' did not enter placement mode`)
  clickPage(selector)
  const composing = evalPage(`
    const state = engine.placement.get()
    return {
      phase: state.phase,
      focused: shadow ? (shadow.activeElement && shadow.activeElement.tagName) : null,
      target: state.phase === 'composing' ? idOf(state.element) : null,
    }
  `)
  if (composing.phase !== 'composing') throw new Error(`click on ${selector} did not compose`)
  if (composing.focused !== 'TEXTAREA') throw new Error('composer textarea was not focused')
  ab(['keyboard', 'type', body])
  ab(['press', 'Control+Enter'])
  await sleep(700)
  const placed = evalPage('return probe(null)')
  if (!placed.found) throw new Error('no thread after submit')
  return placed
}
