// SPEC-copilot §2.9 (errors) + §2.3 (constants). One test per normative statement.
import { describe, expect, test } from 'vitest'

import { HEARTBEAT_MS, MAX_ATTEMPTS, retryDelayMs, STALE_AFTER_MS } from '../src/constants.ts'
import {
  classifyProviderError,
  CopilotError,
  decodeRunError,
  encodeRunError,
  isRetryable,
} from '../src/errors.ts'
import { httpError } from './support.ts'

describe('§2.9 CopilotError', () => {
  test('name is the literal "CopilotError" and it is an Error', () => {
    const e = new CopilotError('tool_failed', 'boom')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('CopilotError')
    expect(e.message).toBe('boom')
    expect(e.code).toBe('tool_failed')
  })

  test('carries optional runId / toolName / cause', () => {
    const cause = new Error('inner')
    const e = new CopilotError('tool_timeout', 'slow', { runId: 'r1', toolName: 't', cause })
    expect(e.runId).toBe('r1')
    expect(e.toolName).toBe('t')
    expect(e.cause).toBe(cause)
  })

  test('retryable is derived from the code', () => {
    expect(new CopilotError('provider_error').retryable).toBe(true)
    expect(new CopilotError('rate_limited').retryable).toBe(true)
    expect(new CopilotError('timeout').retryable).toBe(true)
    expect(new CopilotError('store_failed').retryable).toBe(false)
    expect(new CopilotError('tool_input_invalid').retryable).toBe(false)
    expect(new CopilotError('step_limit').retryable).toBe(false)
    expect(new CopilotError('aborted').retryable).toBe(false)
    expect(new CopilotError('run_not_found').retryable).toBe(false)
    expect(new CopilotError('context_render_failed').retryable).toBe(false)
  })

  test('static is() narrows by instance and optionally by code', () => {
    const e = new CopilotError('tool_timeout')
    expect(CopilotError.is(e)).toBe(true)
    expect(CopilotError.is(e, 'tool_timeout')).toBe(true)
    expect(CopilotError.is(e, 'tool_failed')).toBe(false)
    expect(CopilotError.is(new Error('x'))).toBe(false)
    expect(CopilotError.is(null)).toBe(false)
    expect(CopilotError.is(undefined, 'timeout')).toBe(false)
  })

  test('toJSON() is a structured-clone-safe projection (§3.3.13)', () => {
    const e = new CopilotError('tool_failed', 'nope', {
      runId: 'r1',
      toolName: 'read_thread',
      cause: () => 'not cloneable',
    })
    const json = e.toJSON()
    expect(json).toEqual({
      name: 'CopilotError',
      code: 'tool_failed',
      message: 'nope',
      runId: 'r1',
      toolName: 'read_thread',
      retryable: false,
    })
    expect(structuredClone(json)).toEqual(json)
  })

  test('toJSON() omits absent runId / toolName', () => {
    expect(new CopilotError('timeout', 'slow').toJSON()).toEqual({
      name: 'CopilotError',
      code: 'timeout',
      message: 'slow',
      retryable: true,
    })
  })

  test('a default message is derived from the code', () => {
    expect(new CopilotError('no_provider').message.length).toBeGreaterThan(0)
  })
})

describe('§2.9 isRetryable', () => {
  test('true for provider_error, rate_limited and timeout only', () => {
    expect(isRetryable(new CopilotError('provider_error'))).toBe(true)
    expect(isRetryable(new CopilotError('rate_limited'))).toBe(true)
    expect(isRetryable(new CopilotError('timeout'))).toBe(true)
  })

  test('store_failed is NOT retryable — run-store failure is fatal (§3.4)', () => {
    expect(isRetryable(new CopilotError('store_failed'))).toBe(false)
  })

  test('non-CopilotError values are not retryable', () => {
    expect(isRetryable(new Error('x'))).toBe(false)
    expect(isRetryable('rate_limited')).toBe(false)
    expect(isRetryable(null)).toBe(false)
  })
})

describe('§2.9 provider classification', () => {
  test('429 is rate_limited; 5xx and network failures are retryable provider_error', () => {
    expect(classifyProviderError(httpError(429)).code).toBe('rate_limited')
    expect(classifyProviderError(httpError(429)).retryable).toBe(true)
    expect(classifyProviderError(httpError(503)).code).toBe('provider_error')
    expect(classifyProviderError(httpError(503)).retryable).toBe(true)
    expect(classifyProviderError(new Error('network down')).retryable).toBe(true)
  })

  test('a 4xx other than 429 is provider_error but NOT retryable (§2.9, decision log #30)', () => {
    // A 400 has no other code to map to, and the provider rejects it identically on every attempt,
    // so classification sets `retryable: false` on the INSTANCE: `isRetryable(e)` is the source of
    // truth and the code is only its default. Retrying would spend the whole MAX_ATTEMPTS budget
    // and report `max_attempts` instead of the 401 the host has to show.
    const e = classifyProviderError(httpError(400))
    expect(e.code).toBe('provider_error')
    expect(e.retryable).toBe(false)
    expect(isRetryable(e)).toBe(false)
    for (const status of [401, 403, 404, 422]) {
      expect(isRetryable(classifyProviderError(httpError(status)))).toBe(false)
    }
  })

  test('an abort is `aborted` and never retried — the host asked for it', () => {
    const abort = Object.assign(new Error('stop'), { name: 'AbortError' })
    expect(classifyProviderError(abort).code).toBe('aborted')
    expect(classifyProviderError(abort).retryable).toBe(false)
  })
})

describe('§2.2 the durable `Run.error` string', () => {
  test('encode/decode round-trips the code and the message', () => {
    const encoded = encodeRunError(new CopilotError('tool_timeout', 'slow tool'))
    expect(encoded).toBe('tool_timeout: slow tool')
    const decoded = decodeRunError(encoded, 'r1')
    expect(decoded?.code).toBe('tool_timeout')
    expect(decoded?.message).toBe('slow tool')
    expect(decoded?.runId).toBe('r1')
  })

  test('a record with no error decodes to null', () => {
    expect(decodeRunError(undefined, 'r1')).toBeNull()
  })

  test('a foreign / older / host-written error string decodes to a NON-retryable error', () => {
    // The record it came from is terminal, and terminal is absorbing (§3.1): handing back
    // `retryable: true` invites a retry of a run that can never be retried.
    const decoded = decodeRunError('the other runtime wrote this', 'r1')
    expect(decoded?.code).toBe('provider_error')
    expect(decoded?.retryable).toBe(false)
    expect(isRetryable(decoded)).toBe(false)
  })
})

describe('§2.3 constants', () => {
  test('MAX_ATTEMPTS is 3 (PLAN §4.5, not configurable)', () => {
    expect(MAX_ATTEMPTS).toBe(3)
  })

  test('STALE_AFTER_MS is 60_000', () => {
    expect(STALE_AFTER_MS).toBe(60_000)
  })

  test('HEARTBEAT_MS is 10_000', () => {
    expect(HEARTBEAT_MS).toBe(10_000)
  })

  test('retryDelayMs(attempt) = min(2 ** attempt * 1000, 30_000) — 2 s then 4 s', () => {
    expect(retryDelayMs(1)).toBe(2_000)
    expect(retryDelayMs(2)).toBe(4_000)
    expect(retryDelayMs(3)).toBe(8_000)
    expect(retryDelayMs(10)).toBe(30_000)
    expect(retryDelayMs(0)).toBe(1_000)
  })
})
