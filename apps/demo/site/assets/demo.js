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
  // No `badge.icon`: DESIGN §0 D5 deletes the "?" outright. Ask differs from comment by hue
  // alone (§2.3), and the mode's word survives in `title` / `aria-label`.
  { kind: 'ask', trigger: { key: 'a', interaction: 'pick' }, badge: { label: 'Ask' } },
]

/**
 * The library default, restored — this was 0.9 until wave 4.
 *
 * The measurement behind 0.9 was real: a positional selector keeps matching after a list
 * mutation and simply points at whoever moved into the slot, and that WRONG element used to
 * score 0.76 (nothing in common but shape) or ~0.97 on a feed whose rows share boilerplate,
 * because `text` was 0.12 of a weighted average against 0.22 for classes and 0.16 for structure.
 * A page could only defend itself by demanding near-certainty of every match.
 *
 * SPEC §2.5 / decision log #26 moved that defence into the engine: the text digest is now a
 * **verifier**, so a candidate that nothing identifies and whose text disagrees scores 0 rather
 * than 0.76 — at any threshold. Both measurements above are now 0. Keeping 0.9 would buy only
 * one thing: throwing away the honest approximate matches the same change makes safe, such as a
 * paragraph whose framework regenerated every bookkeeping attribute (0.75, decision log #27).
 *
 * @type {import('@astrale-os/comment-core').AnchoringOptions}
 */
export const DEMO_ANCHORING = { threshold: 0.62 }

/**
 * Which appearance a page mounts. **Glass is the default** — it is the product's intended
 * appearance (`docs/DESIGN.md`), and a demo that showed the fallback would be arguing for the
 * wrong thing. `?theme=default` is the escape hatch, and it exists for a real reason rather than
 * for symmetry: `domPresentation` is a frozen compatibility surface, so being able to put the two
 * side by side on the same page, in the same browser, with one query parameter is how you check
 * that the split kept its promise.
 *
 * @param {string} search
 * @returns {'glass' | 'default'}
 */
export function resolveTheme(search = '') {
  return new URLSearchParams(search).get('theme') === 'default' ? 'default' : 'glass'
}

/**
 * @param options {
 *   title, hint,                       // toolbar copy
 *   theme,                             // 'glass' | 'default'; defaults to ?theme= then glass
 *   engine, ui,                        // overrides merged into the two option bags
 *   delay,                             // echo responder delay, ms
 * }
 * @returns { engine, ui, log, theme, detach }
 */
export function bootDemo(options = {}) {
  const { Comments, CommentsUI, CommentsUIGlass } = globalThis
  if (!Comments || !CommentsUI) {
    throw new Error(
      'load ../vendor/comment-core.iife.js and then ../vendor/comment-ui.iife.js first',
    )
  }

  const theme = options.theme ?? resolveTheme(globalThis.location?.search ?? '')
  if (theme === 'glass' && !CommentsUIGlass) {
    throw new Error('load ../vendor/comment-ui-glass.iife.js, or pass ?theme=default')
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

  const ui = CommentsUI.mountCommentUI(engine, {
    // No `defaultOpen`. DESIGN §7 row 5 is "0 threads → zero pixels", and a demo whose headline
    // is "nothing exists until intent is expressed" cannot open with a `0 · 0 · 0` card parked
    // over the scenario it is trying to show. `⌥⇧C` and the seed are how you ask for it.
    // One field. That is the entire cost of a second appearance, and it is the whole argument
    // for the presentation seam: none of the logic below knows which one is mounted.
    ...(theme === 'glass' ? { presentation: CommentsUIGlass.glassPresentation() } : {}),
    ...options.ui,
  })

  const bar = createToolbar(engine, { ...options, theme })
  const log = bar.log

  // Signal S7 of the disclosure map: the panel seed is a dot until you ask for it, so there has
  // to be a way to ask from the keyboard. The chord is the HOST's, not the widget's — a library
  // that installs a global shortcut on somebody else's page has overstepped.
  const onSummon = (event) => {
    if (event.altKey && event.shiftKey && (event.key === 'C' || event.key === 'c')) {
      event.preventDefault()
      ui.panel.toggle()
    }
  }
  globalThis.addEventListener('keydown', onSummon)

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
    theme,
    detach() {
      unsubscribeEvents()
      unsubscribeThreads()
      detachEcho()
      globalThis.removeEventListener('keydown', onSummon)
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
      <a data-demo="theme" href="?theme=default"></a>
      <a data-demo="index" href="../index.html">← all scenarios</a>
    </div>
    <p class="demo-bar-counts" data-demo="counts">0 threads</p>
    <ol class="demo-log" data-demo="log" aria-label="engine events"></ol>
  `
  element.querySelector('.demo-bar-title').textContent = options.title ?? 'exp-spec demo'
  element.querySelector('.demo-bar-hint').textContent = options.hint ?? ''
  element.dataset.theme = options.theme ?? 'glass'

  // The escape hatch, in the one place it is useful: a link back to the same page under the
  // other appearance, so the two are one click apart rather than one rebuild apart.
  const themeLink = element.querySelector('[data-demo="theme"]')
  const glass = (options.theme ?? 'glass') === 'glass'
  themeLink.textContent = glass ? 'Default theme →' : '← Glass theme'
  themeLink.href = glass ? '?theme=default' : '?'
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
