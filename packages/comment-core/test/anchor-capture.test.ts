/**
 * §2.5 `captureTarget` / `captureElement` + `CaptureOptions`, and §4.6.1's "one strategy list
 * for both halves".
 */

import { beforeEach, describe, expect, test } from 'vitest'

import {
  captureElement,
  captureTarget,
  defaultStrategies,
  defineSelectorStrategy,
} from '../src/index.ts'

function page(html: string): Document {
  document.body.innerHTML = html
  return document
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('§2.5 captureElement', () => {
  test('outerHTML is sanitized: <script> is stripped', () => {
    const doc = page('<div id="t">hi<script>alert(1)</script></div>')
    const capture = captureElement(doc.querySelector('#t')!)
    expect(capture.outerHTML).not.toContain('<script')
    expect(capture.outerHTML).not.toContain('alert(1)')
  })

  test('outerHTML is sanitized: on* handler attributes are stripped', () => {
    const doc = page('<div id="t" onclick="steal()" data-keep="1">hi</div>')
    const capture = captureElement(doc.querySelector('#t')!)
    expect(capture.outerHTML).not.toContain('onclick')
    expect(capture.outerHTML).toContain('data-keep')
  })

  test('outerHTML is sanitized: javascript: URLs are neutralized', () => {
    const doc = page('<div id="t"><a href="javascript:evil()">x</a></div>')
    const capture = captureElement(doc.querySelector('#t')!)
    expect(capture.outerHTML).not.toContain('javascript:')
    expect(capture.outerHTML).toContain('about:blank')
  })

  test('htmlLimit caps outerHTML in BYTES, default 8192', () => {
    const doc = page(`<div id="t">${'é'.repeat(400)}</div>`)
    const capture = captureElement(doc.querySelector('#t')!, { htmlLimit: 40 })
    expect(new TextEncoder().encode(capture.outerHTML).length).toBeLessThanOrEqual(40)
    const dflt = captureElement(doc.querySelector('#t')!)
    expect(new TextEncoder().encode(dflt.outerHTML).length).toBeLessThanOrEqual(8192)
  })

  test('textLimit caps capture.text, default 2000', () => {
    const doc = page(`<div id="t">${'a'.repeat(5000)}</div>`)
    expect(captureElement(doc.querySelector('#t')!, { textLimit: 10 }).text).toHaveLength(10)
    expect(captureElement(doc.querySelector('#t')!).text).toHaveLength(2000)
  })

  test('a custom sanitize replaces the built-in one', () => {
    const doc = page('<div id="t">hi</div>')
    const capture = captureElement(doc.querySelector('#t')!, { sanitize: () => 'REPLACED' })
    expect(capture.outerHTML).toBe('REPLACED')
  })

  test('redact runs AFTER sanitize and is the last thing before persistence', () => {
    const doc = page('<div id="t">ssn 111-22-3333<script>  </script></div>')
    const seen: string[] = []
    const capture = captureElement(doc.querySelector('#t')!, {
      redact: (c) => {
        seen.push(c.outerHTML)
        return { ...c, text: c.text.replace(/\d/gu, '#') }
      },
    })
    expect(seen[0]).not.toContain('<script')
    expect(capture.text).toBe('ssn ###-##-####')
  })

  test('a throwing redact drops the text-bearing fields rather than persisting them', () => {
    const doc = page('<div id="t">secret</div>')
    const capture = captureElement(doc.querySelector('#t')!, {
      redact: () => {
        throw new Error('boom')
      },
    })
    expect(capture.text).toBe('')
    expect(capture.outerHTML).toBe('')
  })

  test('capturedAt comes from the injected clock; page carries url + title', () => {
    const doc = page('<div id="t">hi</div>')
    doc.title = 'Doc Title'
    const capture = captureElement(doc.querySelector('#t')!, {
      now: () => new Date('2026-02-03T04:05:06.000Z'),
    })
    expect(capture.capturedAt).toBe('2026-02-03T04:05:06.000Z')
    expect(capture.page.title).toBe('Doc Title')
    expect(capture.page.url).toBe(doc.defaultView!.location.href)
  })

  test('a Range target carries selectionText; an Element target does not', () => {
    const doc = page('<p id="p">hello brave new world</p>')
    const text = doc.querySelector('#p')!.firstChild!
    const range = doc.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 11)
    expect(captureElement(range).selectionText).toBe('brave')
    expect(captureElement(doc.querySelector('#p')!).selectionText).toBeUndefined()
  })

  test('cssPath is a finder selector that resolves back to the element', () => {
    const doc = page('<main><section><div class="card"><p id="para">x</p></div></section></main>')
    const element = doc.querySelector('#para')!
    const capture = captureElement(element)
    expect(doc.querySelector(capture.cssPath)).toBe(element)
  })
})

describe('§2.5 captureTarget', () => {
  test('an Element target yields mode "element", a Range target yields mode "text"', () => {
    const doc = page('<p id="p">hello brave new world</p>')
    expect(captureTarget(doc.querySelector('#p')!).anchor.mode).toBe('element')
    const range = doc.createRange()
    range.selectNodeContents(doc.querySelector('#p')!)
    expect(captureTarget(range).anchor.mode).toBe('text')
  })

  test('selectors are produced in weight order (attr 90 → css 80 → nthPath 40)', () => {
    const doc = page('<div id="t" data-testid="card">hello</div>')
    const { anchor } = captureTarget(doc.querySelector('#t')!)
    expect(anchor.selectors.map((s) => s.type)).toEqual(['attr', 'css', 'nthPath'])
  })

  test('a text target additionally gets textQuote (70) and textPosition (30), in weight order', () => {
    const doc = page('<p id="p">hello brave new world</p>')
    const text = doc.querySelector('#p')!.firstChild!
    const range = doc.createRange()
    range.setStart(text, 6)
    range.setEnd(text, 11)
    const { anchor } = captureTarget(range)
    expect(anchor.selectors.map((s) => s.type)).toEqual([
      'attr',
      'css',
      'textQuote',
      'nthPath',
      'textPosition',
    ])
  })

  test('the fingerprint is captured alongside the selectors — never hand-built', () => {
    const doc = page('<div id="t" class="card" role="button">hello</div>')
    const { anchor } = captureTarget(doc.querySelector('#t')!)
    expect(anchor.fingerprint.tag).toBe('div')
    expect(anchor.fingerprint.id).toBe('t')
    expect(anchor.fingerprint.stableClasses).toEqual(['card'])
    expect(anchor.fingerprint.attrs.role).toBe('button')
    expect(anchor.fingerprint.textDigest).toBe('hello')
  })

  test('a detached node yields a low-signal descriptor rather than throwing (§2.5)', () => {
    const orphan = document.createElement('div')
    orphan.textContent = 'detached'
    const result = captureTarget(orphan)
    expect(result.anchor.fingerprint.tag).toBe('div')
    expect(result.capture.text).toBe('detached')
    expect(() => captureTarget(orphan)).not.toThrow()
  })

  test('§4.6.1 one strategy list: a custom describe is written and a same-type one replaces a builtin', () => {
    const doc = page('<div id="t" data-row-id="r7">row</div>')
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
    const replacement = defineSelectorStrategy({
      type: 'nthPath',
      weight: 40,
      describe: () => ({ value: 'REPLACED' }),
      resolve: () => null,
    })

    const { anchor } = captureTarget(doc.querySelector('#t')!, {
      strategies: [rowId, replacement, ...defaultStrategies],
    })
    expect(anchor.selectors[0]).toEqual({ type: 'x-row-id', rowId: 'r7' })
    expect(anchor.selectors.find((s) => s.type === 'nthPath')).toEqual({
      type: 'nthPath',
      value: 'REPLACED',
    })
  })
})
