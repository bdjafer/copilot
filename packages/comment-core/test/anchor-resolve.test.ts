/**
 * §2.5 `resolveAnchor` / `explainAnchor` + `ResolveOptions`, i.e. the §4.6.2–4 pipeline:
 * weight order with cheap before fuzzy, unconditional fingerprint verification, threshold,
 * bounded fingerprint scan, budget, text-mode range and its 0.15 penalty.
 */

import { beforeEach, describe, expect, test } from 'vitest'

import type { AnchorDescriptor } from '../src/index.ts'

import {
  captureTarget,
  defaultStrategies,
  defineSelectorStrategy,
  explainAnchor,
  resolveAnchor,
} from '../src/index.ts'

function page(html: string): Document {
  document.body.innerHTML = html
  return document
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('§4.6.2 strategy order + unconditional verification', () => {
  test('the highest-weight selector that verifies wins, and `via` names it', () => {
    const doc = page('<div id="t" data-testid="card" class="card">hello world</div>')
    const { anchor } = captureTarget(doc.querySelector('#t')!)
    const match = resolveAnchor(anchor, { document: doc })
    expect(match?.element).toBe(doc.querySelector('#t'))
    expect(match?.via).toBe('attr') // attr (90) beats css (80)
  })

  test('cheap strategies run before fuzzy ones, whatever their weight', () => {
    const doc = page('<p id="p">hello brave new world</p>')
    const text = doc.querySelector('#p')!.firstChild!
    const range = doc.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 11)
    const { anchor } = captureTarget(range)
    doc.body.innerHTML = '' // force every strategy to be attempted

    const order = explainAnchor(anchor, { document: doc }).attempts.map((a) =>
      a.selector === 'fingerprint-scan' ? a.selector : a.selector.type,
    )
    // textQuote is weight 70 but cost 'fuzzy', so nthPath (40, cheap) precedes it.
    expect(order).toEqual([
      'attr',
      'css',
      'nthPath',
      'textQuote',
      'textPosition',
      'fingerprint-scan',
    ])
  })

  test('the winner of a text capture in an unchanged page is a cheap selector, not the quote', () => {
    const doc = page('<p id="p">hello brave new world</p>')
    const text = doc.querySelector('#p')!.firstChild!
    const range = doc.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 11)
    const { anchor } = captureTarget(range)
    const match = resolveAnchor(anchor, { document: doc })
    expect(match?.via).toBe('attr')
    expect(match?.range?.toString()).toBe('brave') // §4.6.4 still supplies the range
  })

  test('a stale-but-valid selector pointing at a different element is REJECTED by the fingerprint', () => {
    const doc = page('<section id="s"><p id="p" class="quote">the original text</p></section>')
    const { anchor } = captureTarget(doc.querySelector('#p')!)
    // Same selector, entirely different element behind it.
    doc.body.innerHTML = '<section id="s"><p id="p" class="banner">buy now, cheap</p></section>'
    expect(resolveAnchor(anchor, { document: doc })).toBeNull()
  })

  test('below threshold ⇒ null; resolveAnchor never guesses', () => {
    const doc = page('<div id="t" class="card">hello world</div>')
    const { anchor } = captureTarget(doc.querySelector('#t')!)
    doc.body.innerHTML = ''
    expect(resolveAnchor(anchor, { document: doc })).toBeNull()
  })

  test('threshold is configurable and gates acceptance', () => {
    const doc = page('<p id="p">hello world</p>')
    const { anchor } = captureTarget(doc.querySelector('#p')!)
    doc.body.innerHTML = '<p id="p">hello world, mostly</p>'
    expect(resolveAnchor(anchor, { document: doc, threshold: 0.99 })).toBeNull()
    expect(resolveAnchor(anchor, { document: doc, threshold: 0.3 })).not.toBeNull()
  })
})

describe('§4.6.3 fingerprint scan fallback', () => {
  test('a moved element with no working selector is found by the same-tag scan', () => {
    const doc = page('<article id="a"><p>the paragraph text</p></article><aside><p>o</p></aside>')
    const { anchor } = captureTarget(doc.querySelector('#a p')!)
    // Every selector now misses: the id-bearing ancestor is gone, the structure changed.
    doc.body.innerHTML = '<section><em>y</em><p>the paragraph text</p></section>'
    const match = resolveAnchor(anchor, { document: doc })
    expect(match?.via).toBe('fingerprint-scan')
    expect(match?.element).toBe(doc.querySelector('section p'))
  })

  test('scanLimit bounds the number of candidates the scan looks at', () => {
    const doc = page('<article id="a"><p>needle text here</p></article><aside><p>o</p></aside>')
    const { anchor } = captureTarget(doc.querySelector('#a p')!)
    doc.body.innerHTML = `<section>${'<p>unrelated filler</p>'.repeat(20)}<p>needle text here</p></section>`
    expect(resolveAnchor(anchor, { document: doc, scanLimit: 5 })).toBeNull()
    const trace = explainAnchor(anchor, { document: doc, scanLimit: 5 })
    expect(trace.attempts.at(-1)).toMatchObject({ selector: 'fingerprint-scan', candidates: 5 })
    expect(resolveAnchor(anchor, { document: doc, scanLimit: 500 })).not.toBeNull()
  })
})

describe('§2.5 ResolveOptions', () => {
  test('root scopes resolution: a match outside the subtree is not returned', () => {
    const doc = page(
      '<div id="left"><p id="p" class="quote">hello world</p></div><div id="right"></div>',
    )
    const { anchor } = captureTarget(doc.querySelector('#p')!)
    expect(
      resolveAnchor(anchor, { document: doc, root: doc.querySelector('#left')! }),
    ).not.toBeNull()
    expect(resolveAnchor(anchor, { document: doc, root: doc.querySelector('#right')! })).toBeNull()
  })

  test('scoring overrides scoreCandidate for every candidate, in both directions', () => {
    const doc = page('<div id="t" data-testid="c" class="card">hello</div>')
    const { anchor } = captureTarget(doc.querySelector('#t')!)
    expect(resolveAnchor(anchor, { document: doc })?.confidence).toBe(1)
    // A scorer that rejects everything drives the whole pipeline (selectors + scan) to null.
    expect(resolveAnchor(anchor, { document: doc, scoring: () => 0 })).toBeNull()
    // …and one that accepts everything accepts the very first candidate.
    expect(resolveAnchor(anchor, { document: doc, scoring: () => 0.7 })?.confidence).toBe(0.7)
  })

  test('budgetMs: 0 short-circuits every strategy and reports budgetExceeded', () => {
    const doc = page('<div id="t" data-testid="c">hello</div>')
    const { anchor } = captureTarget(doc.querySelector('#t')!)
    const trace = explainAnchor(anchor, { document: doc, budgetMs: 0 })
    expect(trace.result).toBeNull()
    expect(trace.budgetExceeded).toBe(true)
    expect(trace.attempts).toHaveLength(0)
  })

  test('strategies merge with the builtins: a custom locator resolves', () => {
    const rowId = defineSelectorStrategy({
      type: 'x-row-id',
      weight: 120,
      cost: 'cheap',
      describe: (target, { closest }) => {
        const row = closest(target, '[data-row-id]')
        return row ? { rowId: row.getAttribute('data-row-id')! } : null
      },
      resolve: (sel, { root }) => root.querySelector(`[data-row-id="${sel.rowId}"]`),
    })
    const doc = page('<div data-row-id="r7" class="row">row seven</div>')
    const { anchor } = captureTarget(doc.querySelector('[data-row-id]')!, {
      strategies: [rowId, ...defaultStrategies],
    })
    // Recycle the row: same key, moved in the DOM, different structural position.
    doc.body.innerHTML = '<div class="x"></div><div data-row-id="r7" class="row">row seven</div>'
    const match = resolveAnchor(anchor, {
      document: doc,
      strategies: [rowId, ...defaultStrategies],
    })
    expect(match?.via).toBe('x-row-id')
  })

  test('a strategy that throws is an abstention, never a fault', () => {
    const boom = defineSelectorStrategy({
      type: 'x-boom',
      weight: 1000,
      describe: () => ({ v: 1 }),
      resolve: () => {
        throw new Error('boom')
      },
    })
    const doc = page('<div id="t" data-testid="c">hello</div>')
    const { anchor } = captureTarget(doc.querySelector('#t')!, { strategies: [boom] })
    expect(anchor.selectors[0]!.type).toBe('x-boom')
    expect(resolveAnchor(anchor, { document: doc, strategies: [boom] })?.via).toBe('attr')
  })

  test('a malformed descriptor resolves to null instead of throwing', () => {
    const doc = page('<div id="t">hello</div>')
    const broken = {
      mode: 'element',
      selectors: [],
      fingerprint: undefined,
    } as unknown as AnchorDescriptor
    expect(() => resolveAnchor(broken, { document: doc })).not.toThrow()
    expect(resolveAnchor(broken, { document: doc })).toBeNull()
  })
})

describe('§2.5 explainAnchor', () => {
  test('the trace has one attempt per attempted selector, with candidates/best/accepted/ms', () => {
    const doc = page('<div id="t" data-testid="c" class="card">hello world</div>')
    const { anchor } = captureTarget(doc.querySelector('#t')!)
    const trace = explainAnchor(anchor, { document: doc })
    expect(trace.anchor).toBe(anchor)
    expect(trace.attempts).toHaveLength(1) // attr accepted immediately
    expect(trace.attempts[0]).toMatchObject({ candidates: 1, accepted: true })
    expect(trace.attempts[0]!.best).toBe(1)
    expect(typeof trace.attempts[0]!.ms).toBe('number')
    expect(trace.result?.element).toBe(doc.querySelector('#t'))
    expect(trace.budgetExceeded).toBe(false)
  })

  test('a failed resolve traces every selector plus the fingerprint scan', () => {
    const doc = page('<div id="t" data-testid="c" class="card">hello world</div>')
    const { anchor } = captureTarget(doc.querySelector('#t')!)
    doc.body.innerHTML = ''
    const trace = explainAnchor(anchor, { document: doc })
    const kinds = trace.attempts.map((a) =>
      a.selector === 'fingerprint-scan' ? a.selector : a.selector.type,
    )
    expect(kinds).toEqual(['attr', 'css', 'nthPath', 'fingerprint-scan'])
    expect(trace.attempts.every((a) => !a.accepted)).toBe(true)
    expect(trace.result).toBeNull()
  })
})

describe('§4.6.4 text mode', () => {
  test('a text anchor re-anchors to a live Range', () => {
    const doc = page('<p id="p">alpha beta gamma delta</p>')
    const text = doc.querySelector('#p')!.firstChild!
    const range = doc.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 16)
    const { anchor } = captureTarget(range)
    expect(anchor.mode).toBe('text')

    const match = resolveAnchor(anchor, { document: doc })
    expect(match?.range?.toString()).toBe('beta gamma')
  })

  test('the quote is re-found after the surrounding text moved', () => {
    const doc = page('<p id="p">alpha beta gamma delta</p>')
    const text = doc.querySelector('#p')!.firstChild!
    const range = doc.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 16)
    const { anchor } = captureTarget(range)

    doc.body.innerHTML = '<p id="p">prefixed prose. alpha beta gamma delta, and more</p>'
    const match = resolveAnchor(anchor, { document: doc })
    expect(match?.range?.toString()).toBe('beta gamma')
  })

  test('a failed range with a successful element match costs exactly 0.15 confidence', () => {
    const doc = page('<p id="p" class="quote" role="note">alpha beta gamma delta</p>')
    const target = doc.querySelector('#p')!
    const range = doc.createRange()
    range.setStart(target.firstChild!, 6)
    range.setEnd(target.firstChild!, 16)
    const { anchor } = captureTarget(range)

    const withRange = resolveAnchor(anchor, { document: doc })!
    expect(withRange.range).not.toBeNull()

    // Strip the quote from the descriptor: the element still matches, the range cannot.
    const quoteless = {
      ...anchor,
      selectors: anchor.selectors.filter(
        (s) => s.type !== 'textQuote' && s.type !== 'textPosition',
      ),
    }
    const withoutRange = resolveAnchor(quoteless, { document: doc })!
    expect(withoutRange.range).toBeNull()
    expect(withoutRange.element).toBe(target)
    expect(withoutRange.confidence).toBeCloseTo(withRange.confidence - 0.15, 10)
  })
})
