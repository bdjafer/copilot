/**
 * SPEC-swarm §2 — the `swarm.v1` suite, plus the codec details `protocolConformance()` does not
 * carry because they are swarm-internal rather than peer-facing.
 */

import { describe, expect, it } from 'vitest'

import type { ClientFrame } from '../src/protocol/frames.ts'

import {
  base64DecodedBytes,
  decodeClientFrame,
  encodeFrame,
  exceedsFrameLimit,
  isHelloFrame,
  utf8ByteLength,
} from '../src/protocol/codec.ts'
import {
  RECONNECT,
  RESUBSCRIBE_ORDER,
  RETENTION,
  backoffDelayMs,
  blockedReasonForCloseCode,
  isDegradableStream,
} from '../src/protocol/constants.ts'
import { INTENT_NAMES, SERVER_CAPABILITIES } from '../src/protocol/frames.ts'
import { protocolConformance } from '../src/testing/protocol-conformance.ts'

describe('protocolConformance()', () => {
  for (const testCase of protocolConformance()) {
    it(testCase.name, testCase.run)
  }
})

describe('§2.2 the intent and capability vocabularies', () => {
  it('names 17 wire intents, and setFilter/focus are NOT among them (§6.3)', () => {
    expect(INTENT_NAMES).toHaveLength(17)
    expect(INTENT_NAMES as readonly string[]).not.toContain('setFilter')
    expect(INTENT_NAMES as readonly string[]).not.toContain('focus')
  })

  it('names the nine server capabilities', () => {
    expect(SERVER_CAPABILITIES).toHaveLength(9)
    expect(SERVER_CAPABILITIES).toContain('parallel-attempts')
    expect(SERVER_CAPABILITIES).toContain('confirmations')
  })
})

describe('§2.2 hello must be the first client frame', () => {
  it('is recognisable, so the connection can enforce close 4004 on anything else', () => {
    const hello = decodeClientFrame(
      encodeFrame({ p: 'swarm', v: 1, k: 'hello', client: 'c', head: 'cli', minV: 1, maxV: 1 }),
    )
    expect(hello.ok).toBe(true)
    if (hello.ok) expect(isHelloFrame(hello.frame)).toBe(true)

    const sub = decodeClientFrame(
      encodeFrame({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'fleet', from: 'snapshot' }),
    )
    expect(sub.ok).toBe(true)
    if (sub.ok) expect(isHelloFrame(sub.frame)).toBe(false)
  })

  it('refuses a hello whose head is not one of the three head kinds', () => {
    const result = decodeClientFrame(
      JSON.stringify({
        p: 'swarm',
        v: 1,
        k: 'hello',
        client: 'c',
        head: 'daemon',
        minV: 1,
        maxV: 1,
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.fatal).toBe(true)
  })

  it('refuses a hello that negotiates a version range swarm.v1 cannot serve', () => {
    const result = decodeClientFrame(
      JSON.stringify({ p: 'swarm', v: 1, k: 'hello', client: 'c', head: 'cli', minV: 1, maxV: 2 }),
    )
    expect(result.ok).toBe(false)
  })
})

describe('§2.2 request validation', () => {
  it('requires an idempotencyKey on every req — offline replay depends on it (§2.5 rule 3)', () => {
    const result = decodeClientFrame(
      JSON.stringify({ p: 'swarm', v: 1, k: 'req', id: 1, intent: 'sendTurn', args: {} }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('invalid_spec')
  })

  it('refuses an ack whose seq is below 1: seq starts at 1 and is never sparse', () => {
    const result = decodeClientFrame(
      JSON.stringify({ p: 'swarm', v: 1, k: 'ack', stream: 'attempt:a', seq: 0 }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('bad_cursor')
  })

  it('keeps optional fields optional through a round trip', () => {
    const frame: ClientFrame = {
      p: 'swarm',
      v: 1,
      k: 'req',
      id: 3,
      intent: 'updateDefaults',
      args: { reasoningEffort: 'high' },
      idempotencyKey: 'idem-9',
      expectedVersion: 4,
    }
    const decoded = decodeClientFrame(encodeFrame(frame))
    expect(decoded.ok).toBe(true)
    if (decoded.ok) expect(decoded.frame).toEqual(frame)
  })
})

describe('§2.4 byte accounting without TextEncoder', () => {
  it('measures UTF-8 length for ASCII, 2-byte, 3-byte and astral code points', () => {
    expect(utf8ByteLength('abc')).toBe(3)
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('€')).toBe(3)
    expect(utf8ByteLength('🛰')).toBe(4)
    expect(utf8ByteLength('a🛰é')).toBe(1 + 4 + 2)
    /* A lone surrogate is three bytes of replacement, not a crash. */
    expect(utf8ByteLength('\ud800')).toBe(3)
  })

  it('short-circuits the frame cap without measuring every byte', () => {
    expect(exceedsFrameLimit('x'.repeat(10), 100)).toBe(false)
    expect(exceedsFrameLimit('x'.repeat(101), 100)).toBe(true)
    expect(exceedsFrameLimit('é'.repeat(60), 100)).toBe(true)
  })

  it('sizes base64 from its length, tolerating padding and the url alphabet', () => {
    expect(base64DecodedBytes('AAAA')).toBe(3)
    expect(base64DecodedBytes('AAA=')).toBe(2)
    expect(base64DecodedBytes('AA==')).toBe(1)
    expect(base64DecodedBytes('-_-_')).toBe(3)
    expect(base64DecodedBytes('A')).toBeNull()
    expect(base64DecodedBytes('****')).toBeNull()
  })
})

describe('§2.5 reconnect policy', () => {
  it('backs off 250 ms ×1.8 to a 30 s cap', () => {
    expect(RECONNECT.baseMs).toBe(250)
    expect(RECONNECT.factor).toBe(1.8)
    expect(RECONNECT.capMs).toBe(30_000)
    expect(RECONNECT.jitter).toBe(0.25)
    expect(backoffDelayMs(1)).toBe(250)
    expect(backoffDelayMs(2)).toBeCloseTo(450)
    expect(backoffDelayMs(3)).toBeCloseTo(810)
    expect(backoffDelayMs(50)).toBe(30_000)
  })

  it('re-subscribes attention before transcripts (§2.5 rule 2)', () => {
    expect([...RESUBSCRIBE_ORDER]).toEqual(['server', 'fleet', 'delegation', 'attempt'])
  })

  it('maps the three terminal close codes to a blockedReason and the rest to null', () => {
    expect(blockedReasonForCloseCode(4001)).toBe('unauthenticated')
    expect(blockedReasonForCloseCode(4003)).toBe('forbidden')
    expect(blockedReasonForCloseCode(4004)).toBe('protocol')
    expect(blockedReasonForCloseCode(4008)).toBeNull()
    expect(blockedReasonForCloseCode(4009)).toBeNull()
    expect(blockedReasonForCloseCode(4013)).toBeNull()
  })
})

describe('§2.3–2.4 only attempt:* degrades (Q12)', () => {
  it('marks attempt as the one degradable family', () => {
    expect(isDegradableStream('attempt')).toBe(true)
    expect(isDegradableStream('fleet')).toBe(false)
    expect(isDegradableStream('delegation')).toBe(false)
    expect(isDegradableStream('server')).toBe(false)
  })

  it('publishes the §2.3 retention rules, with fleet kept forever', () => {
    expect(RETENTION.server).toEqual({ kind: 'days', days: 30 })
    expect(RETENTION.fleet).toEqual({ kind: 'forever' })
    expect(RETENTION.delegation).toEqual({ kind: 'delegation-lifetime' })
    expect(RETENTION.attempt).toEqual({ kind: 'days-or-bytes', days: 7, bytes: 200_000_000 })
  })
})
