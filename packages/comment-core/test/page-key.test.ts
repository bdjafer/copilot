/** §2.6 page key. */

import { describe, expect, test } from 'vitest'

import { createPageKey, defaultPageKey, volatileParams } from '../src/headless.ts'

const key = (url: string, options?: Parameters<typeof defaultPageKey>[1]): string =>
  defaultPageKey(new URL(url), options)

describe('defaultPageKey (§2.6)', () => {
  test('keeps origin + pathname', () => {
    expect(key('https://example.com/docs/spec')).toBe('https://example.com/docs/spec')
  })

  test('strips the hash by default', () => {
    expect(key('https://example.com/a#section-3')).toBe('https://example.com/a')
  })

  test('keeps the hash when keepHash is set', () => {
    expect(key('https://example.com/a#s3', { keepHash: true })).toBe('https://example.com/a#s3')
  })

  test('strips the trailing slash by default', () => {
    expect(key('https://example.com/a/')).toBe('https://example.com/a')
    expect(key('https://example.com/')).toBe('https://example.com')
    expect(key('https://example.com/a/')).toBe(key('https://example.com/a'))
  })

  test('keeps the trailing slash on request', () => {
    expect(key('https://example.com/a/', { trailingSlash: 'keep' })).toBe('https://example.com/a/')
  })

  test('sorts remaining params so param order cannot fork the key', () => {
    expect(key('https://example.com/a?b=2&a=1')).toBe(key('https://example.com/a?a=1&b=2'))
    expect(key('https://example.com/a?b=2&a=1')).toBe('https://example.com/a?a=1&b=2')
  })

  test('drops volatile params', () => {
    expect(key('https://example.com/a?utm_source=x&utm_medium=y&id=7')).toBe(
      'https://example.com/a?id=7',
    )
    expect(key('https://example.com/a?gclid=1&fbclid=2&msclkid=3&ref=4')).toBe(
      'https://example.com/a',
    )
    expect(key('https://example.com/a?session_token=abc&sid=9')).toBe('https://example.com/a')
  })

  test('drops host-supplied params, by name and by pattern', () => {
    expect(key('https://example.com/a?trace=1&keep=2', { dropParams: ['trace'] })).toBe(
      'https://example.com/a?keep=2',
    )
    expect(key('https://example.com/a?x_debug=1&keep=2', { dropParams: [/^x_/] })).toBe(
      'https://example.com/a?keep=2',
    )
  })

  test('keepParams wins over every drop rule', () => {
    expect(key('https://example.com/a?ref=abc', { keepParams: ['ref'] })).toBe(
      'https://example.com/a?ref=abc',
    )
    expect(
      key('https://example.com/a?trace=1', { dropParams: ['trace'], keepParams: ['trace'] }),
    ).toBe('https://example.com/a?trace=1')
  })

  test('a repeated param keeps every value, deterministically ordered', () => {
    expect(key('https://example.com/a?a=2&a=1')).toBe('https://example.com/a?a=1&a=2')
  })

  test('volatileParams are stateless (no /g), so repeated tests keep matching', () => {
    for (const pattern of volatileParams) expect(pattern.global).toBe(false)
    const first = key('https://example.com/a?utm_source=x')
    const second = key('https://example.com/a?utm_source=x')
    expect(first).toBe(second)
    expect(first).toBe('https://example.com/a')
  })
})

describe('createPageKey (§2.6)', () => {
  test('curries defaultPageKey', () => {
    const pageKey = createPageKey({ keepParams: ['docId'], keepHash: true })
    expect(pageKey(new URL('https://example.com/d?docId=7&utm_source=x#a'))).toBe(
      'https://example.com/d?docId=7#a',
    )
  })
})
