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
  setViewport,
  shot,
  sleep,
} from './lib/driver.mjs'

const VENDOR = resolve(BENCH_DIR, '../apps/demo/dist/vendor')
const CORE = readFileSync(resolve(VENDOR, 'comment-core.iife.js'), 'utf8')
const UI = readFileSync(resolve(VENDOR, 'comment-ui.iife.js'), 'utf8')
const NAMESPACE = 'exp-spec-bench'

const SITES = [
  {
    name: 'wikipedia',
    url: 'https://en.wikipedia.org/wiki/Anchor',
    // A body paragraph deep in the article: no id, no data-*, plenty of text.
    target: `
      const root = document.querySelector('#mw-content-text .mw-parser-output')
      const p = [...root.querySelectorAll(':scope > p')].filter((n) => n.textContent.trim().length > 240)[1]
      const index = [...p.parentElement.children].indexOf(p) + 1
      return { selector: '#mw-content-text .mw-parser-output > *:nth-child(' + index + ')' }
    `,
  },
  {
    name: 'mdn',
    url: 'https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver',
    target: `
      const root = document.querySelector('.section-content') || document.querySelector('article')
      const p = [...root.querySelectorAll('p')].filter((n) => n.textContent.trim().length > 120)[0]
      const index = [...p.parentElement.children].indexOf(p) + 1
      const parent = p.parentElement.className.split(' ')[0]
      return { selector: '.' + parent + ' > *:nth-child(' + index + ')' }
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

    const target = evalPage(site.target)
    run.steps.target = target
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
