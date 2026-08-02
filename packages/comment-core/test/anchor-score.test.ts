/**
 * §2.5 `fingerprintElement` + `scoreCandidate`. The two normative statements about the score
 * are "tag mismatch ⇒ 0" and "semantics > classes > structure > text"; both get a test, as
 * does every documented field of `ElementFingerprint`.
 */

import { beforeEach, describe, expect, test } from 'vitest'

import { fingerprintElement, scoreCandidate } from '../src/index.ts'

function page(html: string): Document {
  document.body.innerHTML = html
  return document
}

const el = (html: string): Element => {
  const doc = page(`<div id="host">${html}</div>`)
  return doc.querySelector('#host')!.firstElementChild!
}

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('§2.5 fingerprintElement', () => {
  test('tag is lowercased', () => {
    expect(fingerprintElement(el('<SPAN>x</SPAN>')).tag).toBe('span')
  })

  test('id is present only when the element has one', () => {
    expect(fingerprintElement(el('<p id="para">x</p>')).id).toBe('para')
    expect(fingerprintElement(el('<p>x</p>')).id).toBeUndefined()
  })

  test('hashed and utility class names are filtered out; word-like ones survive', () => {
    const fp = fingerprintElement(el('<p class="card sc-bdVaJa css-1a2b3c p-4 article-body">x</p>'))
    expect(fp.stableClasses).toEqual(['article-body', 'card'])
  })

  test('classFilter overrides the built-in heuristic', () => {
    const fp = fingerprintElement(el('<p class="p-4 card">x</p>'), {
      classFilter: (name) => name.startsWith('p-'),
    })
    expect(fp.stableClasses).toEqual(['p-4'])
  })

  test('attrs keep the semantic allowlist and every data-*, and skip the rest', () => {
    const fp = fingerprintElement(
      el('<a role="link" href="/x" data-testid="go" style="color:red" tabindex="0">x</a>'),
    )
    expect(fp.attrs).toEqual({ role: 'link', href: '/x', 'data-testid': 'go' })
  })

  test('textDigest is whitespace-collapsed and lowercased', () => {
    expect(fingerprintElement(el('<p>  Hello   World \n</p>')).textDigest).toBe('hello world')
  })

  test('rectHint is absent when the element has no layout', () => {
    // happy-dom reports 0x0 for everything; a 0x0 hint is noise, not a hint.
    expect(fingerprintElement(el('<p>x</p>')).rectHint).toBeUndefined()
  })
})

describe('§2.5 scoreCandidate', () => {
  test('tag mismatch ⇒ 0, unconditionally', () => {
    const fp = fingerprintElement(el('<p id="a" class="card">hello</p>'))
    const other = el('<div id="a" class="card">hello</div>')
    expect(scoreCandidate(other, fp)).toBe(0)
  })

  test('an identical element scores 1', () => {
    const target = el('<p id="a" class="card" role="note">hello</p>')
    expect(scoreCandidate(target, fingerprintElement(target))).toBe(1)
  })

  test('a same-tag element with nothing in common scores far below the 0.62 threshold', () => {
    const fp = fingerprintElement(el('<p id="a" class="card" role="note">hello there</p>'))
    const other = el('<p id="z" class="other" role="alert">completely different words</p>')
    expect(scoreCandidate(other, fp)).toBeLessThan(0.62)
  })

  test('semantics outweigh classes: losing role+id costs more than losing the class', () => {
    const doc = page(
      '<p id="a" class="card" role="note">hello</p>' +
        '<p id="a" class="other" role="note">hello</p>' +
        '<p id="z" class="card" role="alert">hello</p>',
    )
    const [target, classChanged, semanticsChanged] = Array.from(doc.querySelectorAll('p'))
    const fp = fingerprintElement(target!)
    expect(scoreCandidate(classChanged!, fp)).toBeGreaterThan(scoreCandidate(semanticsChanged!, fp))
  })

  test('classes outweigh text: losing the text costs less than losing the classes', () => {
    const doc = page(
      '<p class="card article-body">hello world</p>' +
        '<p class="card article-body">totally other prose</p>' +
        '<p class="nav sidebar">hello world</p>',
    )
    const [target, textChanged, classesChanged] = Array.from(doc.querySelectorAll('p'))
    const fp = fingerprintElement(target!)
    expect(scoreCandidate(textChanged!, fp)).toBeGreaterThan(scoreCandidate(classesChanged!, fp))
  })

  test('an element whose only evidence is its text is scored on its text alone', () => {
    const doc = page('<p>hello world</p><p>hello world</p><p>nothing alike at all</p>')
    const [target, same, different] = Array.from(doc.querySelectorAll('p'))
    const fp = fingerprintElement(target!)
    expect(scoreCandidate(same!, fp)).toBe(1)
    expect(scoreCandidate(different!, fp)).toBeLessThan(0.62)
  })

  test('a text digest that merely grew still scores as containment, not as a miss', () => {
    const doc = page('<p>hello world</p><p>hello world and then some more</p>')
    const [target, grown] = Array.from(doc.querySelectorAll('p'))
    expect(scoreCandidate(grown!, fingerprintElement(target!))).toBeGreaterThanOrEqual(0.62)
  })
})
