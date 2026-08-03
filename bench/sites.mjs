/**
 * Real-site smoke (PLAN §3.8's "real-site corpus"), best effort, no auth, no login walls.
 *
 *   node bench/sites.mjs
 *
 * For each site: open it, check whether a plain `<script>` tag is allowed by its CSP, inject the
 * two IIFE bundles, boot the engine on a `localStorage` store, place a thread with the keyboard,
 * reload, re-inject, and re-resolve the STORED record with `Comments.resolveAnchor` — the same
 * exported API the engine uses — reporting the confidence and whether it landed on the same
 * element.
 *
 * Two honesty notes that belong next to the numbers, not in a footnote:
 *
 *  - The bundles go in through CDP `Runtime.evaluate`, which is **not** subject to the page's
 *    CSP. That models the extension's isolated world (and a devtools paste), NOT the standalone
 *    `<script src>` story — which is why the CSP probe is run and reported separately.
 *  - Only keys under the bench's own `localStorage` namespace are written, and they are removed
 *    at the end. Nothing else on these origins is touched.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  ab,
  BENCH_DIR,
  evalPage,
  open,
  placeComment,
  reload,
  scrollIntoView,
  setViewport,
  shot,
  sleep,
} from './lib/driver.mjs'

const VENDOR = resolve(BENCH_DIR, '../apps/demo/dist/vendor')
const CORE = readFileSync(resolve(VENDOR, 'comment-core.iife.js'), 'utf8')
const UI = readFileSync(resolve(VENDOR, 'comment-ui.iife.js'), 'utf8')
const NAMESPACE = 'exp-spec-bench'

/**
 * Prepended to every site's `pick` snippet.
 *
 * Real sites are not the demo: they wrap prose in generated containers (Parsoid `<section
 * id="mwAQ">`, MDN's `.content-section`) whose own selectors are as volatile as the thing we are
 * trying to locate. So the bench does not hand-write a site selector — it picks the element by
 * its *content*, then derives a positional `:nth-child` path to click it. The path is the
 * bench's own pointer for the CDP click; the engine never sees it, and what gets measured is
 * whatever anchor `captureTarget` decides to store for that element.
 */
const PICK_PRELUDE = String.raw`
const pathOf = (el) => {
  const parts = []
  for (let n = el; n && n.nodeType === 1 && n !== document.body; n = n.parentElement) {
    const p = n.parentElement
    if (!p) break
    parts.unshift(n.tagName.toLowerCase() + ':nth-child(' + ([...p.children].indexOf(n) + 1) + ')')
  }
  return 'body > ' + parts.join(' > ')
}
const describe = (el) => ({ selector: pathOf(el), tag: el.tagName, text: norm(el.textContent).slice(0, 80) })
`

const SITES = [
  {
    name: 'wikipedia',
    url: 'https://en.wikipedia.org/wiki/Anchor',
    // A body paragraph deep in the article: no id, no data-*, plenty of prose. Parsoid nests
    // every paragraph inside a generated <section id="mwXX">, so ':scope > p' finds nothing —
    // the 2026 markup, not the 2015 one the old selector assumed.
    pick: `
      const root = document.querySelector('#mw-content-text .mw-parser-output')
      if (!root) return { selector: null, why: 'no .mw-parser-output' }
      const p = [...root.querySelectorAll('p')].filter((n) => n.textContent.trim().length > 240)[1]
      return p ? describe(p) : { selector: null, why: 'no long paragraph' }
    `,
  },
  {
    name: 'mdn',
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver',
    // The hardest kind of real-world target: a paragraph with **no id, no class, no data-***,
    // so the stored fingerprint is text + structure only. `.section-content` is gone from MDN's
    // 2026 DOM; `.extra` (the baseline widget) is skipped so the target is documentation prose;
    // link-free is required because a CDP click at a paragraph's centre otherwise lands on an
    // inline <a> and the engine would (correctly) anchor the link, which is a much easier case.
    pick: `
      const p = [...document.querySelectorAll('article p, main p')].filter(
        (n) =>
          n.textContent.trim().length > 100 &&
          !n.closest('.extra') &&
          n.querySelectorAll('a').length === 0,
      )[0]
      return p ? describe(p) : { selector: null, why: 'no link-free paragraph' }
    `,
  },
]

/** Raw injection — deliberately NOT through evalPage, whose async wrapper would scope the `var`. */
function inject(source, globalName) {
  ab(
    ['eval', '--stdin'],
    `${source}\n;globalThis.${globalName} = ${globalName}; ${globalName} && true`,
  )
}

/** Does this origin's CSP allow a plain inline `<script>`? The standalone-library question. */
function cspProbe() {
  return evalPage(`
    const token = 'bench_' + Math.random().toString(36).slice(2)
    const script = document.createElement('script')
    script.textContent = 'globalThis[' + JSON.stringify(token) + '] = true'
    document.documentElement.append(script)
    const ran = globalThis[token] === true
    script.remove()
    delete globalThis[token]
    return { inlineScriptRuns: ran }
  `)
}

/** Boots comment-core + comment-ui the way a `<script>`-tag host would, on a localStorage store. */
function boot() {
  return evalPage(`
    if (globalThis.demo) {
      globalThis.demo.ui.unmount()
      globalThis.demo.engine.destroy()
    }
    const booted = globalThis.Comments.createCommentEngine({
      store: globalThis.Comments.createLocalStorageStore({ namespace: ${JSON.stringify(NAMESPACE)} }),
      modes: [{ kind: 'comment', trigger: { key: 'c', interaction: 'pick' } }],
    })
    const ui = globalThis.CommentsUI.mountCommentUI(booted, { panel: { defaultOpen: false } })
    globalThis.demo = { engine: booted, ui }
    await booted.ready()
    return { pageKey: booted.pageKey, threads: booted.listThreads().length }
  `)
}

async function load(url) {
  open(url)
  setViewport()
  ab(['wait', '--load', 'networkidle'])
  const csp = cspProbe()
  inject(CORE, 'Comments')
  inject(UI, 'CommentsUI')
  const booted = boot()
  await sleep(600)
  return { csp, booted }
}

const results = []

for (const site of SITES) {
  const run = { site: site.name, url: site.url, steps: {}, error: null }
  process.stdout.write(`\n▶ ${site.name}  (${site.url})\n`)
  try {
    const first = await load(site.url)
    run.steps.csp = first.csp
    run.steps.boot = first.booted
    process.stdout.write(
      `  csp: inline <script> ${first.csp.inlineScriptRuns ? 'ALLOWED' : 'BLOCKED'} · engine booted on ${first.booted.pageKey}\n`,
    )

    const target = evalPage(`${PICK_PRELUDE}\n${site.pick}`)
    run.steps.target = target
    if (!target.selector) throw new Error(`no target on ${site.name}: ${String(target.why)}`)
    // A CDP click whose target centre is outside the viewport reports success and does nothing.
    scrollIntoView(target.selector)
    await sleep(400)
    const placed = await placeComment({ selector: target.selector, body: 'bench: real-site smoke' })
    run.steps.placed = {
      id: placed.id,
      status: placed.status,
      confidence: placed.confidence,
      via: placed.via,
      element: placed.element,
    }
    process.stdout.write(
      `  placed on ${placed.element.tag} "${placed.element.text.slice(0, 48)}…"\n`,
    )
    shot(`site-${site.name}-01-placed.png`)

    reload()
    ab(['wait', '--load', 'networkidle'])
    inject(CORE, 'Comments')
    inject(UI, 'CommentsUI')
    run.steps.reboot = boot()
    await sleep(800)

    const after = evalPage(`return probe(${JSON.stringify(placed.id)})`)
    run.steps.afterReload = {
      found: after.found,
      status: after.status,
      confidence: after.confidence,
      via: after.via,
      element: after.element,
      badge: after.badge,
      badgeOffset: after.badgeOffset ?? null,
    }
    const sameElement =
      after.found && after.element !== null && after.element.key === placed.element.key
    run.steps.sameElement = sameElement
    process.stdout.write(
      `  after reload: ${after.status} @ ${String(after.confidence)} via ${String(after.via)} — same element: ${String(sameElement)}\n`,
    )

    run.steps.resolve = evalPage(
      `return await resolveAt(${JSON.stringify(placed.id)}, [0.62, 0.85, 0.9])`,
    )
    shot(`site-${site.name}-02-after-reload.png`)
  } catch (error) {
    run.error = String(error?.message ?? error)
    process.stdout.write(`  ✗ ${run.error}\n`)
  }

  // Leave the origin exactly as we found it.
  try {
    run.cleanup = evalPage(`
      const keys = []
      for (let i = 0; i < localStorage.length; i += 1) {
        const k = localStorage.key(i)
        if (k.startsWith(${JSON.stringify(NAMESPACE)})) keys.push(k)
      }
      for (const k of keys) localStorage.removeItem(k)
      return { removed: keys.length }
    `)
  } catch (error) {
    run.cleanup = { error: String(error?.message ?? error) }
  }
  results.push(run)
}

const out = resolve(BENCH_DIR, 'results-sites.json')
writeFileSync(out, `${JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2)}\n`)
process.stdout.write(`\nwrote ${out}\n`)
