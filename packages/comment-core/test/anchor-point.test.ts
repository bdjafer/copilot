/**
 * §2.5 `assessTarget` + §2.4 `AnchorDescriptor.point` (decision log #42/#43, DESIGN §0 D8).
 *
 * The user's complaint this file exists for: *clicking a generic area — the far right margin of
 * a page — does nonsense.* `document.elementFromPoint` is happy to answer `<body>` or a 100 vh
 * layout wrapper, and a thread bolted to either of those is a thread about nothing. The heuristic
 * is Figma's "attach to the top-level frame, never a nested layer" rule ported to a DOM nobody
 * controls, and this suite is its table.
 *
 * happy-dom reports 0×0 for every box, so every geometric claim below is stubbed in explicitly.
 * That is a feature here: the rejection weights are about *numbers*, and a suite that leaned on a
 * layout engine would be asserting the emulator rather than the rule.
 */

import { beforeEach, describe, expect, test } from 'vitest'

import type { DocumentRect } from '../src/index.ts'

import { livePoint } from '../src/anchor/point.ts'
import { assessTarget, captureTarget } from '../src/index.ts'

const VIEWPORT = { width: 1000, height: 800 }

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

function stubViewport(width = VIEWPORT.width, height = VIEWPORT.height): void {
  const view = document.defaultView as unknown as Record<string, unknown>
  Object.defineProperty(view, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(view, 'innerHeight', { configurable: true, value: height })
}

beforeEach(() => {
  document.body.innerHTML = ''
  stubViewport()
})

/* ------------------------------------------------------------------ §2.5, rejection by rejection */

describe('§2.5 assessTarget — the rejection table', () => {
  test('`root` is fatal: html, body and the scrolling element all score 0', () => {
    const doc = page('<article id="a">alpha</article>')
    for (const element of [doc.documentElement, doc.body]) {
      const result = assessTarget(element, { document: doc })
      expect({ rejections: [...result.rejections], confidence: result.confidence }).toEqual({
        rejections: ['root'],
        confidence: 0,
      })
    }
  })

  test('`viewport-fraction` alone costs 0.45 — big is not disqualifying', () => {
    // The normative example: a full-bleed `<section id="hero">` with a headline scores 0.55 and
    // IS anchored to. That is Figma's top-level-frame case working as intended.
    const doc = page('<section id="hero">A headline that is really the content</section>')
    const hero = doc.querySelector('#hero')!
    stubRect(hero, { top: 0, left: 0, width: 1000, height: 700 })
    const result = assessTarget(hero, { document: doc })
    expect([...result.rejections]).toEqual(['viewport-fraction'])
    expect(result.confidence).toBeCloseTo(0.55, 5)
    expect(result.anchor).toBe(hero)
    expect(result.landmark).toBe(false)
  })

  test('`no-own-content` costs 0.35, and a replaced child pays it off', () => {
    const doc = page(
      '<section id="empty"><span></span></section><section id="media"><img></section>',
    )
    const empty = doc.querySelector('#empty')!
    const media = doc.querySelector('#media')!
    expect([...assessTarget(empty, { document: doc }).rejections]).toContain('no-own-content')
    expect([...assessTarget(media, { document: doc }).rejections]).not.toContain('no-own-content')
  })

  test('`no-identity` costs 0.30: an id, a data-* or a real tag name each answer it', () => {
    const doc = page(
      '<div id="named">x</div><div data-testid="t">x</div><section>x</section><div>x</div>',
    )
    const of = (selector: string): string[] => [
      ...assessTarget(doc.querySelector(selector)!, { document: doc }).rejections,
    ]
    expect(of('#named')).not.toContain('no-identity')
    expect(of('[data-testid]')).not.toContain('no-identity')
    expect(of('section')).not.toContain('no-identity')
    expect(of('div:not([id]):not([data-testid])')).toContain('no-identity')
  })

  test('`passthrough-wrapper` costs 0.25: one child filling ≥ 95 % of its parent', () => {
    const doc = page('<div id="wrap"><p id="inner">real prose</p></div>')
    const wrap = doc.querySelector('#wrap')!
    stubRect(wrap, { top: 0, left: 0, width: 400, height: 200 })
    stubRect(doc.querySelector('#inner')!, { top: 0, left: 0, width: 400, height: 196 })
    expect([...assessTarget(wrap, { document: doc }).rejections]).toContain('passthrough-wrapper')
  })

  test('big AND anonymous, or big AND empty, is refused — the two the decree names', () => {
    const doc = page('<div class="l-1">   </div>')
    const wrapper = doc.querySelector('.l-1')!
    stubRect(wrapper, { top: 0, left: 0, width: 1000, height: 780 })
    const result = assessTarget(wrapper, { document: doc })
    // 1 - .45 - .35 - .30 clamps to 0.
    expect(result.confidence).toBe(0)
    expect(result.confidence).toBeLessThan(0.5)
  })
})

/* --------------------------------------------------------------------- §2.5, the landmark walk */

describe('§2.5 assessTarget — the bounded walk', () => {
  test('step 1: an unusable target redirects to the nearest confident landmark ancestor', () => {
    const doc = page('<article id="post">real prose here<div class="pad"> </div></article>')
    const pad = doc.querySelector('.pad')!
    stubRect(pad, { top: 0, left: 0, width: 900, height: 700 })
    const post = doc.querySelector('#post')!
    stubRect(post, { top: 0, left: 0, width: 600, height: 300 })
    const result = assessTarget(pad, { document: doc, point: { clientX: 10, clientY: 10 } })
    expect(result.anchor).toBe(post)
    expect(result.landmark).toBe(true)
    expect(result.element).toBe(pad)
  })

  test('step 2: a click in an empty right margin anchors to the column beside the cursor', () => {
    // Exactly the reported failure: `<body>` is fatal, there is no landmark ancestor to climb
    // to, and the only sane answer is the article the user was looking at.
    const doc = page('<article id="col">the column the reader is reading</article>')
    const column = doc.querySelector('#col')!
    stubRect(column, { top: 100, left: 40, width: 500, height: 400 })
    const result = assessTarget(doc.body, {
      document: doc,
      point: { clientX: 640, clientY: 300 },
    })
    expect(result.anchor).toBe(column)
    expect(result.landmark).toBe(true)
  })

  test('step 2 is bounded by the radius: nothing within 240 px means nothing is chosen', () => {
    const doc = page('<article id="col">prose</article>')
    stubRect(doc.querySelector('#col')!, { top: 0, left: 0, width: 100, height: 40 })
    const result = assessTarget(doc.body, { document: doc, point: { clientX: 900, clientY: 700 } })
    expect(result.anchor).toBe(doc.scrollingElement ?? doc.documentElement)
  })

  test('step 3: the scrolling element is the floor — assessment never fails', () => {
    const doc = page('')
    const result = assessTarget(doc.body, { document: doc, point: { clientX: 5, clientY: 5 } })
    expect(result.anchor).toBe(doc.scrollingElement ?? doc.documentElement)
    expect(result.landmark).toBe(true)
  })

  test('a confident target is returned untouched, walk not run', () => {
    const doc = page('<article id="a">alpha text</article>')
    const article = doc.querySelector('#a')!
    stubRect(article, { top: 10, left: 10, width: 300, height: 80 })
    const result = assessTarget(article, { document: doc, point: { clientX: 20, clientY: 20 } })
    expect({ anchor: result.anchor === article, landmark: result.landmark }).toEqual({
      anchor: true,
      landmark: false,
    })
    expect(result.confidence).toBe(1)
  })
})

/* --------------------------------------------------------------- §2.4 / §4.6.0, the click point */

describe('§2.4 AnchorDescriptor.point — the stored click offset', () => {
  test('no point supplied ⇒ no point stored, and nothing else changes', () => {
    const doc = page('<article id="a">alpha</article>')
    const { anchor } = captureTarget(doc.querySelector('#a')!, { document: doc })
    expect(anchor.point).toBeUndefined()
    expect('point' in anchor).toBe(false)
  })

  test('a point is stored four ways, relative to the element that was picked', () => {
    const doc = page('<article id="a">alpha text</article>')
    const article = doc.querySelector('#a')!
    stubRect(article, { top: 100, left: 50, width: 200, height: 100 })
    const { anchor } = captureTarget(article, {
      document: doc,
      point: { clientX: 150, clientY: 125 },
    })
    expect(anchor.point).toMatchObject({
      dx: 100,
      dy: 25,
      fx: 0.5,
      fy: 0.25,
      docX: 150,
      docY: 125,
      landmark: false,
    })
    expect(anchor.point?.viewport).toMatchObject({ width: 1000, height: 800 })
  })

  test('a low-confidence pick anchors to the landmark and stores the point relative to IT', () => {
    const doc = page('<article id="col">the column</article>')
    const column = doc.querySelector('#col')!
    stubRect(column, { top: 100, left: 40, width: 500, height: 400 })
    const { anchor, capture } = captureTarget(doc.body, {
      document: doc,
      point: { clientX: 640, clientY: 300 },
    })
    expect(anchor.point?.landmark).toBe(true)
    expect(anchor.fingerprint.id).toBe('col')
    // The capture follows the anchor, or the orphan dock would describe a different element.
    expect(capture.text).toBe('the column')
    // 640 - 40 = 600 px past the column's left edge; the coordinate itself is untouched.
    expect(anchor.point).toMatchObject({ dx: 600, dy: 200, docX: 640, docY: 300 })
  })

  test('round-trip: dx/dy while the box holds its size, fx/fy after it resizes', () => {
    const doc = page('<article id="a">alpha text</article>')
    const article = doc.querySelector('#a')!
    stubRect(article, { top: 100, left: 50, width: 200, height: 100 })
    const { anchor } = captureTarget(article, {
      document: doc,
      point: { clientX: 150, clientY: 125 },
    })

    // Same size, moved: the exact offset is preserved.
    expect(livePoint(anchor.point, { top: 300, left: 20, width: 200, height: 100 }, true)).toEqual({
      x: 120,
      y: 325,
    })
    // Resized (a responsive re-layout): the fraction is the only thing that survives it.
    expect(livePoint(anchor.point, { top: 100, left: 50, width: 400, height: 200 }, true)).toEqual({
      x: 250,
      y: 150,
    })
    // Orphaned: the document point needs no element at all.
    expect(livePoint(anchor.point, null, false)).toEqual({ x: 150, y: 125 })
  })

  test('a text-mode capture is never redirected and never invents a coordinate', () => {
    const doc = page('<article id="a">alpha text</article>')
    const range = doc.createRange()
    range.selectNodeContents(doc.querySelector('#a')!.firstChild!)
    const { anchor } = captureTarget(range, {
      document: doc,
      point: { clientX: 10, clientY: 10 },
    })
    expect(anchor.mode).toBe('text')
    expect(anchor.point).toBeUndefined()
  })
})
