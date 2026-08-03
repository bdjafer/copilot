/**
 * The real-browser anchoring bench (PLAN §3.8) — demo-page half.
 *
 * Six scenarios, one per `apps/demo` page, plus one extra for identical siblings. Each one
 * places a thread the way a human does (keyboard trigger → CDP click → typing), reloads, runs
 * the page's own perturbation, and asserts against the live DOM after every step.
 *
 *   node bench/run.mjs                 # all scenarios
 *   node bench/run.mjs popover spa     # a subset
 *
 * Expects a static server on BENCH_BASE (default http://127.0.0.1:4271) serving apps/demo/dist.
 * Writes bench/results.json (raw evidence) and bench/shots/*.png. bench/results.md is written by
 * hand from that JSON — see bench/run.md.
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  BASE,
  BENCH_DIR,
  back,
  blurActive,
  clickPage,
  evalPage,
  forward,
  open,
  placeComment,
  reload,
  resetStore,
  scroll,
  scrollIntoView,
  setViewport,
  shot,
  sleep,
  waitReady,
} from './lib/driver.mjs'

/* --------------------------------------------------------------------------------- assertions */

/** Badge tracks its element when its centre sits on the element's top-right corner. */
const TRACKS = { dx: 80, dy: 40 }

function evaluate(probe, expect, baseline) {
  const fails = []
  const want = (cond, message) => {
    if (!cond) fails.push(message)
  }

  if (expect.absent) {
    want(probe.found === false, `thread is still on the page (found=${String(probe.found)})`)
    if (typeof expect.threads === 'number') {
      want(probe.threads === expect.threads, `threads=${String(probe.threads)}`)
    }
    return fails
  }

  want(probe.found === true, 'thread not found on the page')
  if (!probe.found) return fails

  if (expect.status) want(probe.status === expect.status, `status=${probe.status}`)

  // The invariant that matters more than any single expectation, so it runs on every check that
  // has a baseline: an anchored badge must never sit on a DIFFERENT element. Orphaning is a
  // survivable outcome; pointing confidently at the wrong thing is not (PLAN §3.1).
  if (probe.element !== null && baseline !== null && !expect.allowDifferent) {
    want(
      probe.element.key === baseline.key,
      `MIS-ANCHOR: badge sits on "${probe.element.text.slice(0, 56)}" — expected "${baseline.text.slice(0, 56)}"`,
    )
  }
  if (expect.same) want(probe.element !== null, 'no anchored element')
  if (expect.minConfidence !== undefined) {
    want(
      probe.confidence >= expect.minConfidence,
      `confidence ${String(probe.confidence)} < ${String(expect.minConfidence)}`,
    )
  }
  if (expect.tracks) {
    const off = probe.badgeOffset
    want(probe.badge !== null && !probe.badge.hidden, 'no visible badge')
    want(
      off !== undefined && Math.abs(off.dx) <= TRACKS.dx && Math.abs(off.dy) <= TRACKS.dy,
      `badge is not on the element: ${JSON.stringify(off ?? null)}`,
    )
  }
  if (expect.docked) {
    want(probe.badge !== null, 'orphan has no docked badge')
    if (probe.badge) {
      want(probe.badge.anchorAttr === 'orphaned', `badge data-anchor=${probe.badge.anchorAttr}`)
      want(!probe.badge.hidden, 'docked badge is hidden')
      want(probe.badge.opacity < 1, `docked badge is not dimmed (opacity ${probe.badge.opacity})`)
      want(probe.badge.borderStyle === 'dashed', `docked badge border ${probe.badge.borderStyle}`)
      want(probe.badge.marks.includes('orphaned'), 'docked badge has no orphan glyph')
    }
    want(probe.dockRect !== null, 'orphan kept no dock rect')
  }
  if (expect.badgeHidden !== undefined) {
    want(
      probe.badge !== null && probe.badge.hidden === expect.badgeHidden,
      `badge hidden=${probe.badge ? String(probe.badge.hidden) : 'no badge'}`,
    )
  }
  if (expect.panelSection) {
    want(
      probe.panel !== null && probe.panel.listed && probe.panel.section === expect.panelSection,
      `panel section=${probe.panel ? String(probe.panel.section) : 'null'}`,
    )
  }
  if (typeof expect.threads === 'number') {
    want(probe.threads === expect.threads, `threads=${String(probe.threads)}`)
  }
  return fails
}

/* ------------------------------------------------------------------------------- the harness */

const results = []

async function scenario(name, page, body) {
  const run = {
    name,
    page,
    url: `${BASE}${page}`,
    id: null,
    baseline: null,
    checks: [],
    error: null,
  }
  const started = Date.now()
  const api = {
    /** Records the placement and freezes the element identity every later check compares to. */
    baseline(probe) {
      run.id = probe.id
      run.baseline = probe.element
      return probe
    },
    check(label, expect = {}) {
      const probe = evalPage(`return probe(${run.id === null ? 'null' : JSON.stringify(run.id)})`)
      const fails = evaluate(probe, expect, run.baseline)
      run.checks.push({ label, expect, fails, ok: fails.length === 0, probe })
      return probe
    },
    trace(label) {
      if (run.id === null) return null
      const trace = evalPage(`return traceOf(${JSON.stringify(run.id)})`)
      run.checks.push({ label, trace, ok: true, fails: [] })
      return trace
    },
    /** Re-resolves the stored record at several accept thresholds against the live DOM. */
    resolve(label, thresholds = [0.62, 0.85, 0.9]) {
      if (run.id === null) return null
      const data = evalPage(
        `return await resolveAt(${JSON.stringify(run.id)}, ${JSON.stringify(thresholds)})`,
      )
      run.checks.push({ label, resolve: data, ok: true, fails: [] })
      return data
    },
    note(label, data) {
      run.checks.push({ label, note: data, ok: true, fails: [] })
    },
    shot(label) {
      const file = `${name}-${String(run.checks.length).padStart(2, '0')}-${label}.png`
      shot(file)
      return file
    },
  }
  process.stdout.write(`\n▶ ${name}  (${page})\n`)
  try {
    await body(api)
  } catch (error) {
    run.error = String(error?.message ?? error)
    process.stdout.write(`  ✗ ${run.error}\n`)
  }
  run.ms = Date.now() - started
  for (const step of run.checks) {
    if (step.trace || step.note || step.resolve) continue
    process.stdout.write(
      `  ${step.ok ? '✓' : '✗'} ${step.label}${step.ok ? '' : ` — ${step.fails.join('; ')}`}\n`,
    )
  }
  results.push(run)
  return run
}

/**
 * Perturbations click the page's own controls, with a real CDP click, after scrolling the
 * control into view — a click whose target centre is outside the viewport is reported as a
 * success by CDP and does nothing. Falls back to a synthetic `.click()` only if the real one
 * throws; the fallback is recorded in results.json so no scenario can quietly stop being real.
 */
function control(selector) {
  evalPage(`
    const node = document.querySelector(${JSON.stringify(selector)})
    if (node) node.scrollIntoView({ block: 'center' })
    return { scrolled: !!node }
  `)
  try {
    clickPage(selector)
    return 'cdp-click'
  } catch {
    evalPage(
      `document.querySelector(${JSON.stringify(selector)}).click(); return { fallback: true }`,
    )
    return 'js-click'
  }
}

async function perturb(api, label, selector, settle = 700) {
  const how = control(selector)
  await sleep(settle)
  api.note(`perturbation: ${label}`, { selector, how })
}

/**
 * Wait until the store stops changing, and return the settled bytes.
 *
 * Every demo page attaches the echo responder, which replies to a new thread on an **800 ms
 * timer** — and a reply is a store write. Any check that compares raw store bytes across a
 * perturbation therefore has to take its "before" reading *after* that write has landed, or it
 * measures the responder rather than the perturbation. Recorded runs have shown both outcomes
 * from the same assertion, which is exactly the kind of coin flip a bench must not report.
 */
async function settledStoreBytes(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  let previous = evalPage('return { bytes: storeBytes() }').bytes
  for (;;) {
    await sleep(300)
    const current = evalPage('return { bytes: storeBytes() }').bytes
    if (current === previous || Date.now() > deadline) return current
    previous = current
  }
}

/** Resolves a positional selector for the element whose text matches, at placement time. */
function selectorFor(query) {
  return evalPage(`
    const nodes = [...document.querySelectorAll(${JSON.stringify(query.all)})]
    const target = nodes.find((n) => n.textContent.includes(${JSON.stringify(query.text)}))
    if (!target) return { selector: null }
    const index = [...target.parentElement.children].indexOf(target) + 1
    return {
      selector: ${JSON.stringify(query.parent)} + ' > ' + target.tagName.toLowerCase() + ':nth-child(' + index + ')',
      path: idOf(target).path,
    }
  `)
}

async function load(page) {
  open(page)
  setViewport()
  await waitReady()
  await resetStore()
}

/* --------------------------------------------------------------------------------- scenarios */

const SCENARIOS = {
  /* 1 — static page: nothing moves. The floor for everything else. */
  async static(api) {
    await load('/pages/basic.html')
    api.baseline(await placeComment({ selector: '#intro', body: 'bench: static anchor' }))
    api.check('placed', { status: 'anchored', same: true, tracks: true, minConfidence: 0.99 })
    api.trace('trace @ placement')
    api.shot('placed')

    reload()
    await waitReady()
    api.check('after reload', {
      status: 'anchored',
      same: true,
      tracks: true,
      minConfidence: 0.99,
      panelSection: 'open',
    })
    api.trace('trace @ reload')

    // basic.html ships no mutation control: its perturbation is viewport churn, which is what
    // exercises floating-ui's autoUpdate and the IntersectionObserver skip.
    scroll('down', 1200)
    await sleep(500)
    api.check('scrolled to bottom', { status: 'anchored', same: true })
    scroll('up', 1200)
    await sleep(500)
    api.check('scrolled back', { status: 'anchored', same: true, tracks: true })
    api.shot('after-scroll')
  },

  /* 1b — three byte-identical sibling cards: the fingerprint has to break the tie. */
  async ambiguous(api) {
    await load('/pages/basic.html')
    api.baseline(
      await placeComment({ selector: '.grid > .card:nth-child(2)', body: 'bench: middle card' }),
    )
    api.check('placed on card "Two"', { status: 'anchored', same: true, tracks: true })
    reload()
    await waitReady()
    api.check('after reload', { status: 'anchored', same: true, tracks: true })
    api.trace('trace @ reload')
    api.shot('after-reload')
  },

  /* 2 — list reorder: the badge must follow the row, not the slot. */
  async reorder(api) {
    await load('/pages/reorder.html')
    const target = selectorFor({ all: '#list > li', parent: '#list', text: 'Kiwi' })
    api.note('target', target)
    const placed = api.baseline(
      await placeComment({ selector: target.selector, body: 'bench: kiwi row' }),
    )
    api.check('placed on Kiwi', { status: 'anchored', same: true, tracks: true })
    api.trace('trace @ placement')
    api.shot('placed')

    reload()
    await waitReady()
    api.check('after reload', { status: 'anchored', same: true, tracks: true })

    await perturb(api, 'Shuffle', '#shuffle')
    const shuffled = api.check('after shuffle', { status: 'anchored', same: true, tracks: true })
    api.note('DOM path across the shuffle', {
      placed: placed.element ? placed.element.path : null,
      shuffled: shuffled.element ? shuffled.element.path : null,
      moved: (placed.element?.path ?? null) !== (shuffled.element?.path ?? null),
    })
    api.trace('trace @ shuffle')
    // The number the demo page's threshold note is about: what the stored anchor resolves to at
    // the LIBRARY default (0.62) versus the demo's raised accept score.
    api.resolve('stored anchor re-resolved after shuffle')
    api.shot('after-shuffle')

    await perturb(api, 'Sort A→Z', '#sort')
    api.check('after sort', { status: 'anchored', same: true, tracks: true })

    await perturb(api, 'Move first row down', '#up')
    api.check('after single-row move', { status: 'anchored', same: true, tracks: true })

    const before = await settledStoreBytes()
    await perturb(api, 'Remove Kiwi', '#remove')
    api.check('after removal', { status: 'orphaned', docked: true, panelSection: 'unanchored' })
    api.resolve('stored anchor re-resolved with Kiwi gone')
    const after = evalPage('return { bytes: storeBytes() }').bytes
    api.note('store untouched by orphaning', { equal: before === after })
    api.shot('orphaned')

    await perturb(api, 'Restore all rows', '#restore')
    api.check('after restore', { status: 'anchored', same: true, tracks: true })
    api.trace('trace @ restore')
    api.shot('re-anchored')

    reload()
    await waitReady()
    api.check('reload after the round trip', { status: 'anchored', same: true, tracks: true })
  },

  /* 3 — THE flagship: a portalled popover unmounts its content, then re-mounts new nodes. */
  async popover(api) {
    await load('/pages/popover.html')
    await perturb(api, 'open portalled popover', '#toggle-portal', 400)
    const placed = api.baseline(
      await placeComment({
        selector: '[data-popover="portal"] li.item:nth-child(2)',
        body: 'bench: popover row',
      }),
    )
    api.check('placed inside the open popover', {
      status: 'anchored',
      same: true,
      tracks: true,
      minConfidence: 0.9,
    })
    api.trace('trace @ placement')
    api.shot('anchored-open')

    const before = await settledStoreBytes()
    await perturb(api, 'close the popover (content unmounts)', '#toggle-portal')
    api.check('orphaned while closed', {
      status: 'orphaned',
      docked: true,
      panelSection: 'unanchored',
    })
    const after = evalPage('return { bytes: storeBytes() }').bytes
    api.note('orphaning wrote nothing to the store', {
      equal: before === after,
      bytes: before.length,
    })
    api.shot('orphaned-closed')

    await perturb(api, 'reopen the popover (brand new nodes)', '#toggle-portal')
    const reopened = api.check('re-anchored on reopen', {
      status: 'anchored',
      same: true,
      tracks: true,
    })
    api.note('DOM path across the unmount', {
      placed: placed.element ? placed.element.path : null,
      reopened: reopened.element ? reopened.element.path : null,
    })
    api.trace('trace @ reopen')
    api.shot('re-anchored-reopen')

    await perturb(api, 're-render the open popover in place', '#churn')
    api.check('after in-place re-render', { status: 'anchored', same: true, tracks: true })

    // Reload with the popover closed: the thread must come back orphaned, not lost, and
    // re-anchor when the popover opens again.
    await perturb(api, 'close before reload', '#toggle-portal', 400)
    reload()
    await waitReady()
    api.check('after reload, popover closed — record survives', {
      status: 'orphaned',
      panelSection: 'unanchored',
    })
    // Split out deliberately: PLAN §3.3 / SPEC §5.1's cold-load dock, filed as F1 and fixed in
    // wave 4. `anchoring.rect` is still a live derivation that is never persisted, so a thread
    // orphaning on the FIRST resolution pass has no rect of its own — it now docks at
    // `capture.rect` (SPEC §2.4, decision log #29) instead of drawing no badge at all.
    api.check('after reload, popover closed — badge docks (PLAN §3.3)', { docked: true })
    api.shot('orphaned-after-reload')

    await perturb(api, 'open the popover after the reload', '#toggle-portal')
    api.check('re-anchored after reload + reopen', { status: 'anchored', same: true, tracks: true })
    api.trace('trace @ reopen after reload')
    api.shot('re-anchored-after-reload')

    // The inline popover mounts in a fixed slot, so its DOM path is stable — the control case
    // that isolates "the path changed" from "the nodes were replaced".
    await perturb(api, 'close portal, open the inline popover', '#toggle-portal', 300)
    await perturb(api, 'open inline popover', '#toggle-inline', 400)
    api.note(
      'inline popover open',
      evalPage('return { open: !!document.querySelector(\'[data-popover="inline"]\') }'),
    )
  },

  /* 4 — infinite scroll: off-screen badges, late-arriving nodes, recycled rows. */
  async 'infinite-scroll'(api) {
    await load('/pages/infinite-scroll.html')
    // Deterministic feed: stop the sentinel from appending posts while we scroll. The blur is
    // load-bearing — see blurActive(): a focused checkbox swallows the trigger key.
    control('#auto')
    api.note('trigger key needs focus off the checkbox', blurActive())
    const target = selectorFor({ all: '#feed > article', parent: '#feed', text: 'Post #2' })
    api.note('target', target)
    api.baseline(await placeComment({ selector: target.selector, body: 'bench: post #2' }))
    api.check('placed on post #2', { status: 'anchored', same: true, tracks: true })
    api.trace('trace @ placement')
    api.shot('placed')

    reload()
    await waitReady()
    control('#auto')
    blurActive()
    api.check('after reload', { status: 'anchored', same: true, tracks: true })

    scroll('down', 3000)
    await sleep(700)
    api.check('scrolled the post off-screen', {
      status: 'anchored',
      same: true,
      badgeHidden: true,
      panelSection: 'open',
    })
    api.shot('offscreen')

    scrollIntoView(target.selector)
    await sleep(700)
    api.check('scrolled back', { status: 'anchored', same: true, tracks: true, badgeHidden: false })

    await perturb(api, 'Load 10 more', '#more')
    api.check('after 10 more posts', { status: 'anchored', same: true, tracks: true })

    await perturb(api, 'Trim to the last 10', '#trim')
    api.check('after the post is recycled away', { status: 'orphaned', docked: true })
    api.trace('trace @ trim')
    api.resolve('stored anchor re-resolved after trim')
    api.shot('orphaned')

    await perturb(api, 'Restore every post', '#restore')
    api.check('after restore', { status: 'anchored', same: true, tracks: true })
    api.trace('trace @ restore')
    api.shot('re-anchored')
  },

  /* 5 — SPA route change: the page key changes without a load. */
  async spa(api) {
    await load('/pages/spa.html')
    await perturb(api, 'route → inbox', '[data-route="inbox"]', 500)
    const placed = api.baseline(
      await placeComment({ selector: '#view li.item:nth-child(2)', body: 'bench: inbox row' }),
    )
    api.check('placed on the inbox route', {
      status: 'anchored',
      same: true,
      tracks: true,
      threads: 1,
    })
    api.shot('placed-inbox')

    const beforeBytes = await settledStoreBytes()
    const beforeKey = evalPage('return { pageKey: engine.pageKey }').pageKey
    await perturb(api, 'route → settings', '[data-route="settings"]', 600)
    api.check('gone on another route', { absent: true, threads: 0 })
    const after = evalPage('return { bytes: storeBytes(), pageKey: engine.pageKey }')
    api.note('leaving the route deletes nothing', {
      pageKeyChanged: beforeKey !== after.pageKey,
      storeUnchanged: beforeBytes === after.bytes,
      recordStillStored: after.bytes.includes(placed.id),
    })
    api.shot('other-route')

    await perturb(api, 'route → inbox', '[data-route="inbox"]', 600)
    api.check('back on the inbox route', {
      status: 'anchored',
      same: true,
      tracks: true,
      threads: 1,
    })

    back()
    await sleep(800)
    api.check('browser Back → settings', { absent: true, threads: 0 })
    forward()
    await sleep(800)
    api.check('browser Forward → inbox', { status: 'anchored', same: true, tracks: true })

    reload()
    await waitReady()
    api.check('hard reload on ?route=inbox', { status: 'anchored', same: true, tracks: true })
    api.trace('trace @ reload')
    api.shot('re-anchored')
  },

  /* 6 — attribute churn: hashed classes, then regenerated ids/data-*, then rewritten text. */
  async 'attribute-churn'(api) {
    await load('/pages/attribute-churn.html')
    api.baseline(
      await placeComment({ selector: '#app > p:nth-child(2)', body: 'bench: churned paragraph' }),
    )
    api.check('placed', { status: 'anchored', same: true, tracks: true })
    api.trace('trace @ placement')
    api.shot('placed')

    reload()
    await waitReady()
    api.check('after reload (classes re-hashed on every render)', {
      status: 'anchored',
      same: true,
      tracks: true,
    })
    api.trace('trace @ reload')

    await perturb(api, 'Churn hashed classes', '#churn-classes')
    api.check('after class churn', { status: 'anchored', same: true, tracks: true })
    api.trace('trace @ class churn')
    api.shot('after-class-churn')

    await perturb(api, 'Churn ids and data attributes too', '#churn-all')
    api.check('after id + data-* churn', { status: 'anchored', same: true })
    api.trace('trace @ id churn')
    api.resolve('stored anchor re-resolved after id churn')
    api.shot('after-id-churn')

    await perturb(api, 'Reset to the original markup', '#reset')
    api.check('after reset', { status: 'anchored', same: true, tracks: true })

    await perturb(api, 'Rewrite the text too', '#retext')
    // The element's own text changes here, so the baseline key legitimately cannot match.
    api.check('after the text is rewritten', { allowDifferent: true })
    api.trace('trace @ retext')
    api.shot('after-retext')
  },
}

/* ------------------------------------------------------------------------------------- main */

const requested = process.argv.slice(2)
const names = requested.length > 0 ? requested : Object.keys(SCENARIOS)

for (const name of names) {
  const body = SCENARIOS[name]
  if (!body) {
    process.stdout.write(`skipping unknown scenario "${name}"\n`)
    continue
  }
  await scenario(name, pageOf(name), body)
}

function pageOf(name) {
  const pages = {
    static: '/pages/basic.html',
    ambiguous: '/pages/basic.html',
    reorder: '/pages/reorder.html',
    popover: '/pages/popover.html',
    'infinite-scroll': '/pages/infinite-scroll.html',
    spa: '/pages/spa.html',
    'attribute-churn': '/pages/attribute-churn.html',
  }
  return pages[name] ?? ''
}

const out = resolve(BENCH_DIR, 'results.json')
writeFileSync(
  out,
  `${JSON.stringify({ base: BASE, ranAt: new Date().toISOString(), results }, null, 2)}\n`,
)

const total = results.flatMap((r) => r.checks).filter((c) => c.expect)
const failed = total.filter((c) => !c.ok)
process.stdout.write(
  `\n${String(total.length - failed.length)}/${String(total.length)} assertions passed across ${String(results.length)} scenarios → ${out}\n`,
)
for (const run of results) {
  if (run.error) process.stdout.write(`  scenario ${run.name} aborted: ${run.error}\n`)
}
