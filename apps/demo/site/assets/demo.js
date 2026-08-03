/**
 * Shared boot for every demo page — the whole integration, in one function.
 *
 * The pages are plain static HTML: two `<script src>` tags for the IIFE bundles (comment-core
 * FIRST — `comment-ui.iife.js` reads `Comments` off the global scope, SPEC-comment-core §1.2)
 * and one `<script type="module">` that calls `bootDemo()`. No bundler, no framework, no
 * extension, no AI. If something here does not work, Module 1 does not work.
 */

import { attachEchoResponder } from './echo.js'

/**
 * The two locked demo modes: `c` places a comment, `a` asks.
 * @type {readonly import('@astrale-os/comment-core').Mode[]}
 */
export const DEMO_MODES = [
  { kind: 'comment', trigger: { key: 'c', interaction: 'pick' } },
  { kind: 'ask', trigger: { key: 'a', interaction: 'pick' }, badge: { icon: '?', label: 'Ask' } },
]

/**
 * Raised from the 0.62 default, deliberately and with a measurement behind it.
 *
 * A positional selector keeps matching after a list mutation — it just points at whoever moved
 * into the slot. That WRONG element scores 0.76 when its text shares nothing with the captured
 * digest, and ~0.97 on a feed whose rows share boilerplate: `text` carries 0.12 of the weight
 * against 0.22 for classes and 0.16 for structure, so being the same shape in the same place
 * nearly clears the bar on its own. At 0.62 the resolver accepts that match and short-circuits,
 * so the fingerprint scan that would have found the real element (1.00) never runs. Every
 * correct re-anchor across these six pages measures ≥0.95.
 *
 * 0.9 therefore buys "orphan rather than point at the wrong thing", which is the design's own
 * stated preference. Whether the LIBRARY default should move is a question for the M2 anchoring
 * bench against a real-site corpus (PLAN §3.8), not for a demo page.
 *
 * @type {import('@astrale-os/comment-core').AnchoringOptions}
 */
export const DEMO_ANCHORING = { threshold: 0.9 }

/**
 * @param options {
 *   title, hint,                       // toolbar copy
 *   engine, ui,                        // overrides merged into the two option bags
 *   delay,                             // echo responder delay, ms
 * }
 * @returns { engine, ui, log, detach }
 */
export function bootDemo(options = {}) {
  const { Comments, CommentsUI } = globalThis
  if (!Comments || !CommentsUI) {
    throw new Error(
      'load ../vendor/comment-core.iife.js and then ../vendor/comment-ui.iife.js first',
    )
  }

  const engine = Comments.createCommentEngine({
    // localStorage is the demo store (SPEC-comment-core §2.8): per-origin, wiped by "clear site
    // data", readable by the page. An extension MUST pass createKeyValueStore(kv) instead.
    store: Comments.createLocalStorageStore({ namespace: 'exp-spec-demo' }),
    // No `pageKey`: defaultPageKey (origin + path + non-volatile query) already separates the
    // six pages — and, on the SPA page, its ?route= values.
    modes: DEMO_MODES,
    anchoring: DEMO_ANCHORING,
    ...options.engine,
  })

  const ui = CommentsUI.mountCommentUI(engine, { panel: { defaultOpen: true }, ...options.ui })

  const bar = createToolbar(engine, options)
  const log = bar.log

  // Host-owned badge chrome (SPEC-comment-core §7.2): comment-ui knows nothing about copilots,
  // so the *host* decorates while a reply is in flight and clears it afterwards.
  const detachEcho = attachEchoResponder(engine, {
    delay: options.delay ?? 800,
    onBusy: (threadId, busy) =>
      ui.decorate(threadId, busy ? { chip: { text: 'echo', tone: 'busy', spinner: true } } : null),
    onReplied: (threadId, result) =>
      log(
        `echo → ${short(threadId)} · reopened=${result.reopened} deduped=${result.deduped}`,
        'echo',
      ),
    onError: (error) => log(`echo failed: ${String(error)}`, 'error'),
  })

  const unsubscribeEvents = engine.subscribe((event) => log(describe(event), event.type))
  const unsubscribeThreads = engine.threads.subscribe((threads) => bar.counts(threads))
  void engine.ready().then(() => bar.counts(engine.listThreads()))

  const api = {
    engine,
    ui,
    log,
    detach() {
      unsubscribeEvents()
      unsubscribeThreads()
      detachEcho()
      ui.unmount()
      engine.destroy()
      bar.element.remove()
    },
  }

  // Devtools handle: `demo.engine.inspect()` and `demo.engine.explain(id)` are the two calls
  // worth knowing when a badge lands somewhere surprising.
  globalThis.demo = api
  return api
}

/* ------------------------------------------------------------------------------- the toolbar */

function createToolbar(engine, options) {
  const element = document.createElement('header')
  element.className = 'demo-bar'
  element.innerHTML = `
    <div class="demo-bar-head">
      <h1 class="demo-bar-title"></h1>
      <p class="demo-bar-hint"></p>
    </div>
    <div class="demo-bar-actions">
      <button type="button" data-demo="comment">Comment <kbd>C</kbd></button>
      <button type="button" data-demo="ask">Ask <kbd>A</kbd></button>
      <button type="button" data-demo="reset">Reset this page</button>
      <a href="../index.html">← all scenarios</a>
    </div>
    <p class="demo-bar-counts" data-demo="counts">0 threads</p>
    <ol class="demo-log" data-demo="log" aria-label="engine events"></ol>
  `
  element.querySelector('.demo-bar-title').textContent = options.title ?? 'exp-spec demo'
  element.querySelector('.demo-bar-hint').textContent = options.hint ?? ''
  document.body.prepend(element)

  const logList = element.querySelector('[data-demo="log"]')
  const countsEl = element.querySelector('[data-demo="counts"]')

  element.querySelector('[data-demo="comment"]').addEventListener('click', () => {
    engine.startPlacement('comment')
  })
  element.querySelector('[data-demo="ask"]').addEventListener('click', () => {
    engine.startPlacement('ask')
  })
  element.querySelector('[data-demo="reset"]').addEventListener('click', () => {
    void Promise.all(engine.listThreads().map((thread) => engine.delete(thread.id)))
  })

  function log(text, kind = 'info') {
    const line = document.createElement('li')
    line.dataset.kind = kind
    line.textContent = text
    logList.prepend(line)
    while (logList.childElementCount > 14) logList.lastElementChild.remove()
  }

  function counts(threads) {
    const open = threads.filter((t) => !t.isResolved).length
    const resolved = threads.length - open
    const orphaned = threads.filter((t) => t.isOrphaned).length
    countsEl.textContent = `${open} open · ${resolved} resolved · ${orphaned} orphaned`
  }

  return { element, log, counts }
}

/* -------------------------------------------------------------------------------- log lines */

function describe(event) {
  const p = event.payload
  const id = p.thread ? short(p.thread.id) : ''
  switch (event.type) {
    case 'thread:create':
    case 'thread:reply':
      return `${event.type} ${id} ${p.comment.author}: ${clip(p.comment.body)}`
    case 'thread:anchored':
      return `thread:anchored ${id} via ${p.via} (${p.confidence.toFixed(2)}) ← ${p.previous}`
    case 'thread:orphaned':
      return `thread:orphaned ${id} — badge docks, nothing is written`
    case 'thread:reopen':
      return `thread:reopen ${id} (${p.reason})`
    case 'page:change':
      return `page:change → ${p.pageKey}`
    case 'error':
      return `error ${p.error.code} in ${p.phase}`
    default:
      return `${event.type} ${id}`.trim()
  }
}

const short = (id) => id.slice(0, 8)
const clip = (body) => (body.length > 40 ? `${body.slice(0, 40)}…` : body)
