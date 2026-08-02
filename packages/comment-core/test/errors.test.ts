/** §2.14 errors + §2.7 adapter rule 6 (quota mapping). */

import { describe, expect, test } from 'vitest'

import { guardStore, wrapStore } from '../src/errors.ts'
import { CommentError } from '../src/headless.ts'

describe('CommentError (§2.14)', () => {
  test('carries name, code and the optional record ids', () => {
    const error = new CommentError('thread_not_found', 'gone', { threadId: 't1', commentId: 'c1' })
    expect(error.name).toBe('CommentError')
    expect(error.code).toBe('thread_not_found')
    expect(error.threadId).toBe('t1')
    expect(error.commentId).toBe('c1')
    expect(error.message).toBe('gone')
    expect(error instanceof Error).toBe(true)
  })

  test('preserves the underlying failure on .cause', () => {
    const cause = new Error('disk on fire')
    expect(new CommentError('store_failed', undefined, { cause }).cause).toBe(cause)
  })

  test('is() narrows, optionally on a specific code', () => {
    const error: unknown = new CommentError('empty_body')
    expect(CommentError.is(error)).toBe(true)
    expect(CommentError.is(error, 'empty_body')).toBe(true)
    expect(CommentError.is(error, 'store_failed')).toBe(false)
    expect(CommentError.is(new Error('plain'))).toBe(false)
    expect(CommentError.is(null)).toBe(false)
    expect(CommentError.is({ code: 'empty_body' })).toBe(false)
  })

  test('is() is brand-based, not instanceof — it survives a foreign realm/bundle', () => {
    // What a second bundle (comment-ui.iife.js reading globalThis.Comments) produces: a
    // different class identity, same brand.
    const foreign = Object.create(Error.prototype) as Record<string | symbol, unknown>
    foreign.code = 'quota_exceeded'
    Object.defineProperty(foreign, Symbol.for('comment-core.error'), {
      value: true,
      enumerable: false,
    })
    expect(foreign instanceof CommentError).toBe(false)
    expect(CommentError.is(foreign)).toBe(true)
    expect(CommentError.is(foreign, 'quota_exceeded')).toBe(true)
  })

  test('the brand is non-enumerable, so it never lands in JSON', () => {
    const error = new CommentError('empty_body')
    expect(Object.getOwnPropertySymbols(error)).toHaveLength(1)
    expect(JSON.stringify(error)).not.toContain('comment-core.error')
  })
})

describe('wrapStore (§2.7 adapter rule 6)', () => {
  test('maps an arbitrary failure to store_failed with the original on .cause', () => {
    const cause = new Error('ECONNRESET')
    const wrapped = wrapStore(cause)
    expect(CommentError.is(wrapped, 'store_failed')).toBe(true)
    expect(wrapped.cause).toBe(cause)
  })

  test.each([
    ['a DOMException-style name', Object.assign(new Error('nope'), { name: 'QuotaExceededError' })],
    ['a legacy DOMException code', Object.assign(new Error('nope'), { code: 22 })],
    ['an extension QUOTA_BYTES message', new Error('QUOTA_BYTES quota exceeded')],
    ['a Firefox quota name', Object.assign(new Error('x'), { name: 'NS_ERROR_DOM_QUOTA_REACHED' })],
  ])('maps %s to quota_exceeded', (_label, failure) => {
    expect(CommentError.is(wrapStore(failure), 'quota_exceeded')).toBe(true)
  })

  test('is idempotent for an already-typed CommentError', () => {
    const original = new CommentError('thread_not_found')
    expect(wrapStore(original)).toBe(original)
  })

  test('guardStore passes a value through and wraps a throw', async () => {
    await expect(guardStore(async () => 42)).resolves.toBe(42)
    await expect(
      guardStore(
        async () => {
          throw new Error('io')
        },
        { threadId: 't1' },
      ),
    ).rejects.toMatchObject({ code: 'store_failed', threadId: 't1' })
  })
})
