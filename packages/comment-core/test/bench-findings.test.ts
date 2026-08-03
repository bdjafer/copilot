/**
 * The four findings the real-browser bench filed (`bench/results.md`), each reproduced from the
 * demo page's own DOM shape, each failing before the wave-4 fix and passing after.
 *
 * | # | Filed as | Fixed by |
 * | --- | --- | --- |
 * | F1 | an orphan that has never resolved once draws no badge | `ElementCapture.rect` + the dock fallback in the anchoring pass |
 * | F2 | a recycled feed attaches the thread to a *different* post at 0.946 | the text digest as a verifier (§4.6.2), not a fifth contribution |
 * | F3 | regenerating ids + `data-*` orphans a byte-identical paragraph | a rewritten value whose original is gone is regeneration, not contradiction |
 * | F4 | hashed-class churn is not a non-event — 2/6–5/6 over four runs | a class is evidence only when word-like AND corroborated |
 */

import { afterEach, describe, expect, test } from 'vitest'

import type { DocumentRect } from '../src/index.ts'

import {
  captureTarget,
  createMemoryStore,
  explainAnchor,
  fingerprintElement,
  resolveAnchor,
  scoreCandidate,
} from '../src/index.ts'
import { harness } from './dom-helpers.ts'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

async function scene(html: string, options?: Parameters<typeof harness>[1]) {
  const h = await harness(html, options)
  cleanup.push(h.dispose)
  return h
}

function page(html: string): Document {
  document.body.innerHTML = html
  return document
}

/** happy-dom reports 0×0 for everything, so a real geometry claim has to be stubbed in. */
function stubRect(element: Element, rect: DocumentRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => rect,
    }),
  })
}

/* ------------------------------------------------------------------------------------- F1 */

describe('bench F1 — an orphan that has never resolved once still docks (PLAN §3.3)', () => {
  const DOCK: DocumentRect = { top: 120, left: 40, width: 200, height: 50 }

  test('the capture carries the target rect, so a cold-load orphan has a position to dock at', async () => {
    const store = createMemoryStore()
    const first = await scene('<p id="target">docked prose</p>', { store })
    stubRect(first.page.document.querySelector('#target')!, DOCK)
    const id = await first.seed('#target')
    expect(first.engine.getThreadView(id)!.capture.rect).toEqual(DOCK)
    await first.dispose()

    // A reload with the anchor element absent: brand-new engine, same store, no live rect ever.
    const second = await scene('<p id="other">a different page state</p>', { store })
    const view = second.engine.getThreadView(id)!
    expect(view.anchoring.status).toBe('orphaned')
    expect(view.anchoring.element).toBeNull()
    // Before the fix this was `null`, and comment-ui's `badgeVisible` therefore drew no badge.
    expect(view.anchoring.rect).toEqual(DOCK)
  })

  test('the dock survives being orphaned across two cold loads and is never written to twice', async () => {
    const store = createMemoryStore()
    const first = await scene('<p id="target">docked prose</p>', { store })
    stubRect(first.page.document.querySelector('#target')!, DOCK)
    const id = await first.seed('#target')
    await first.dispose()

    const second = await scene('<p id="other">gone</p>', { store })
    const writes = second.store.writes
    expect(second.engine.getThreadView(id)!.anchoring.rect).toEqual(DOCK)
    await second.dispose()

    const third = await scene('<p id="other">gone</p>', { store })
    expect(third.engine.getThreadView(id)!.anchoring.rect).toEqual(DOCK)
    // Orphanhood is still a render-time condition (PLAN §3.2): docking wrote nothing.
    expect(second.store.writes).toBe(writes)
  })

  test('a live rect still wins over the capture rect once the thread has resolved', async () => {
    const h = await scene('<p id="target">docked prose</p>')
    stubRect(h.page.document.querySelector('#target')!, DOCK)
    const id = await h.seed('#target')

    const live: DocumentRect = { top: 900, left: 10, width: 300, height: 20 }
    stubRect(h.page.document.querySelector('#target')!, live)
    await h.engine.reanchor(id)
    expect(h.engine.getThreadView(id)!.anchoring.rect).toEqual(live)

    await h.page.mutate((doc) => doc.querySelector('#target')!.remove())
    expect(h.engine.getThreadView(id)!.anchoring.rect).toEqual(live)
  })
})

/* ------------------------------------------------------------------------------------- F2 */

/**
 * `apps/demo/site/pages/infinite-scroll.html` verbatim: one `<article class="card">` per post,
 * `<h3>Post #N</h3><p>BODIES[n % 12] (post n)</p>`. Post #2 and Post #14 therefore carry the
 * same body and differ only in two numbers — 15 of 17 shared tokens, which scored 0.882 on the
 * text digest and 0.946 overall.
 */
const BODIES = [
  'Sourdough starter died over the holidays. Anyone still keeping one alive on rye?',
  'Found a heron standing in the canal at dawn, completely still, for eleven minutes.',
  'The 1974 pressing has a wider stereo image than every reissue since. Fight me.',
  'Tomatoes went in three weeks late and they are still outrunning the courgettes.',
  'Nobody warned me that a cast-iron pan seasons better with flaxseed than with olive oil.',
  'Rebuilt the bicycle wheel by hand. Thirty-two spokes, two evenings, one bruised thumb.',
  'The tide tables are wrong on the north side of the island by roughly twenty minutes.',
  'Halfway through translating a cookbook that nobody has printed since the fifties.',
  'Bats came back to the barn this year. Counted nine leaving at sunset, maybe more.',
  'A hardware shop that still sells single screws is worth a forty-minute detour.',
  'Learned that "aglet" is the word for the plastic tip of a shoelace. Changed nothing.',
  'Recorded the fog horn last night. It is a minor third, which explains the dread.',
]

function feed(from: number, to: number): string {
  let html = '<div id="feed">'
  for (let n = from; n <= to; n += 1) {
    html += `<article class="card"><h3>Post #${String(n)}</h3><p>${BODIES[n % BODIES.length]!} (post ${String(n)})</p></article>`
  }
  return `${html}</div>`
}

function cardOf(doc: Document, n: number): Element {
  const card = Array.from(doc.querySelectorAll('article.card')).find(
    (el) => el.querySelector('h3')?.textContent === `Post #${String(n)}`,
  )
  if (!card) throw new Error(`no card for post ${String(n)}`)
  return card
}

describe('bench F2 — a recycled feed must not attach the thread to a different post', () => {
  test('trimming the feed to posts #13–#22 orphans the thread instead of taking Post #14', () => {
    const doc = page(feed(1, 22))
    const { anchor } = captureTarget(cardOf(doc, 2), { document: doc })

    doc.body.innerHTML = feed(13, 22)

    // The stale selector really does still resolve — to the WRONG post. This is the mis-anchor
    // the bench recorded at 0.946, and it is the fingerprint's job to refuse it.
    const stale = anchor.selectors.find((s) => s.type === 'css') as { value: string } | undefined
    expect(doc.querySelector(stale!.value)).toBe(cardOf(doc, 14))

    expect(scoreCandidate(cardOf(doc, 14), anchor.fingerprint)).toBe(0)
    expect(resolveAnchor(anchor, { document: doc })).toBeNull()
    // Not a threshold-tuning problem either: it was accepted at 0.62, 0.85 and 0.9 alike.
    for (const threshold of [0.62, 0.85, 0.9]) {
      expect(resolveAnchor(anchor, { document: doc, threshold })).toBeNull()
    }
  })

  test('every sibling of the recycled feed is refused, not just the near-duplicate', () => {
    const doc = page(feed(1, 22))
    const { anchor } = captureTarget(cardOf(doc, 2), { document: doc })
    doc.body.innerHTML = feed(13, 22)

    for (const card of Array.from(doc.querySelectorAll('article.card'))) {
      expect(scoreCandidate(card, anchor.fingerprint)).toBe(0)
    }
    const explained = explainAnchor(anchor, { document: doc })
    expect(explained.result).toBeNull()
    expect(explained.attempts.at(-1)?.selector).toBe('fingerprint-scan')
  })

  test('restoring every post re-anchors on Post #2 itself, at full confidence', () => {
    const doc = page(feed(1, 22))
    const { anchor } = captureTarget(cardOf(doc, 2), { document: doc })

    doc.body.innerHTML = feed(13, 22)
    expect(resolveAnchor(anchor, { document: doc })).toBeNull()

    doc.body.innerHTML = feed(1, 22)
    const match = resolveAnchor(anchor, { document: doc })
    expect(match?.element).toBe(cardOf(doc, 2))
    expect(match?.confidence).toBe(1)
  })

  test('the engine reports it as orphaned, with the record untouched', async () => {
    const h = await scene(feed(1, 22))
    const id = await h.seed('article.card:nth-child(3)') // Post #3 — same shape, same twin risk
    expect(h.engine.getThreadView(id)!.anchoring.status).toBe('anchored')
    const writes = h.store.writes

    await h.page.mutate((doc) => {
      doc.body.innerHTML = feed(13, 22)
    })

    expect(h.engine.getThreadView(id)!.anchoring.status).toBe('orphaned')
    expect(h.store.writes).toBe(writes)
  })
})

/* ------------------------------------------------------------------------------------- F3 */

/**
 * `apps/demo/site/pages/attribute-churn.html` verbatim: three paragraphs carrying a React-style
 * `id` (`:r01:`), `data-testid`, `data-reactid`, `aria-describedby`, one stable `card` class and
 * two per-render hashes. "Churn ids and data attributes too" bumps `identity` and re-renders.
 */
const CHURN_TEXTS = [
  'Anchors keep several selectors and score them, so one going stale is survivable.',
  'A fingerprint records the tag, the role, the depth and the neighbours — not the class list.',
  'Text is the strongest signal on a page that rewrites everything else.',
]

/**
 * Word-like base-36 hashes: the 5.8 % of `Math.random().toString(36).slice(2, 8)` names that got
 * through finder's word-like filter and leaked into the fingerprint one render in seventeen.
 * Every row gets its own, exactly as `hash()` is called per row on the page.
 */
const WORD_LIKE_HASHES = [
  'heroic',
  'tuvalu',
  'liaise',
  'canape',
  'fedora',
  'muraro',
  'panama',
  'ravine',
  'sonata',
]

function churnPage(identity: number, render: number, texts = CHURN_TEXTS): string {
  const rows = texts.map((text, index) => {
    const hash = WORD_LIKE_HASHES[(render * texts.length + index) % WORD_LIKE_HASHES.length]!
    return (
      `<p class="card css-${hash} sc-${hash}" id=":r${String(identity)}${String(index)}:" ` +
      `data-testid="row-${String(identity)}-${String(index)}" ` +
      `data-reactid="${String(identity * 10 + index)}" ` +
      `aria-describedby="desc-${String(identity)}-${String(index)}">${text}</p>`
    )
  })
  return `<section id="app">${rows.join('')}</section>`
}

describe('bench F3 — regenerating ids + data-* must not orphan a byte-identical paragraph', () => {
  test('the paragraph re-anchors after every bookkeeping attribute is regenerated', () => {
    const doc = page(churnPage(0, 0))
    const target = doc.querySelectorAll('#app > p')[1]!
    const { anchor } = captureTarget(target, { document: doc })

    doc.body.innerHTML = churnPage(1, 1)

    const match = resolveAnchor(anchor, { document: doc })
    expect(match?.element).toBe(doc.querySelectorAll('#app > p')[1])
    // Re-anchored, and honest about it: below 0.85 is comment-ui's "approximately re-anchored".
    expect(match!.confidence).toBeGreaterThanOrEqual(0.62)
    expect(match!.confidence).toBeLessThan(0.85)
  })

  test('a regenerated id is only forgiven when the old one is gone from the document', () => {
    const doc = page(churnPage(0, 0))
    const target = doc.querySelectorAll('#app > p')[1]!
    const { anchor } = captureTarget(target, { document: doc })

    // Same regeneration, except the ORIGINAL ids are still in the page: nothing was regenerated,
    // so a different id is a genuine contradiction and the sibling must not be taken.
    doc.body.innerHTML = churnPage(1, 1) + churnPage(0, 2)
    const match = resolveAnchor(anchor, { document: doc })
    expect(match?.element).toBe(doc.querySelectorAll('section')[1]!.querySelectorAll('p')[1])
    expect(match!.confidence).toBe(1)
  })

  test('regenerated attributes do NOT license a match on different prose', () => {
    const doc = page(churnPage(0, 0))
    const target = doc.querySelectorAll('#app > p')[1]!
    const { anchor } = captureTarget(target, { document: doc })

    doc.body.innerHTML = churnPage(1, 1, [
      'One completely unrelated sentence.',
      'Another completely unrelated sentence.',
      'A third completely unrelated sentence.',
    ])
    expect(resolveAnchor(anchor, { document: doc })).toBeNull()
  })

  test('the engine re-anchors the same paragraph across the churn, with no store write', async () => {
    const h = await scene(churnPage(0, 0))
    const id = await h.seed('#app > p:nth-child(2)')
    const writes = h.store.writes

    await h.page.mutate((doc) => {
      doc.body.innerHTML = churnPage(1, 1)
    })

    const view = h.engine.getThreadView(id)!
    expect(view.anchoring.status).toBe('anchored')
    expect(view.anchoring.element).toBe(h.page.document.querySelectorAll('#app > p')[1])
    expect(h.store.writes).toBe(writes)
  })
})

/* ------------------------------------------------------------------------------------- F4 */

describe('bench F4 — per-render class hashes must not reach the fingerprint', () => {
  test('a class churn is a non-event now, for every render the filter used to leak', () => {
    // Every pair of renders over the word-like hash pool: 9 × 8 coin flips that used to be a
    // coin flip, all deterministic now. `attribute-churn` scored 5/6, 4/6, 4/6, 2/6 on this.
    for (let first = 0; first < WORD_LIKE_HASHES.length; first += 1) {
      for (let second = 0; second < WORD_LIKE_HASHES.length; second += 1) {
        if (first === second) continue
        const doc = page(churnPage(0, first))
        const target = doc.querySelectorAll('#app > p')[1]!
        const { anchor } = captureTarget(target, { document: doc })
        expect(anchor.fingerprint.stableClasses).toEqual(['card'])

        doc.body.innerHTML = churnPage(0, second)
        const match = resolveAnchor(anchor, { document: doc })
        expect(match?.element).toBe(doc.querySelectorAll('#app > p')[1])
        expect(match?.confidence).toBe(1)
      }
    }
  })

  test('a leaked hash cannot come back through the live class list either', () => {
    const doc = page(churnPage(0, 0))
    const target = doc.querySelectorAll('#app > p')[1]!
    const fingerprint = fingerprintElement(target)

    doc.body.innerHTML = churnPage(0, 1)
    // Coverage of the vetted set, not a symmetric Jaccard: the two new hashes are not looked at.
    expect(scoreCandidate(doc.querySelectorAll('#app > p')[1]!, fingerprint)).toBe(1)
  })

  test('a state class the app adds later costs the anchor nothing', () => {
    const doc = page('<li class="item row">Only show open threads</li><li class="row">x</li>')
    const target = doc.querySelector('li')!
    const fingerprint = fingerprintElement(target)
    target.className = 'item row is-selected'
    expect(scoreCandidate(target, fingerprint)).toBe(1)
  })
})
