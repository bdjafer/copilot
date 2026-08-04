/**
 * SPEC-swarm §2.3, §2.4 — subscriptions, the per-stream cursor, and the client's half of the
 * durable-replay contract.
 *
 * The three properties under test are the ones that make replay *durable* rather than
 * connection-scoped (#5): a cursor survives the socket, a gap is a bug, and lag is explicit.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SwarmEvent } from '../src/protocol/events.ts'

import { BACKPRESSURE, RESUBSCRIBE_ORDER } from '../src/protocol/constants.ts'
import {
  createTestClient,
  makeAttemptSnapshot,
  makeFleetSnapshot,
  makeServerSnapshot,
} from '../src/testing/client-harness.ts'
import { makeDelegationVM } from '../src/testing/fixtures.ts'

const caps = (running: number): SwarmEvent => ({
  k: 'fleet.caps',
  concurrency: { runningAttempts: running, cap: 4, queued: 0 },
  dispatchPaused: false,
})

describe('§2.3 subscribe, snapshot, cursor', () => {
  it('pins `server` and `fleet` for the life of the client and never unsubscribes them', () => {
    const harness = createTestClient()
    harness.start()
    harness.client.focus('delegation-1')
    harness.client.focus(null)
    expect(harness.transport.of('unsub').map((frame) => frame.stream)).toEqual([
      'delegation:delegation-1',
    ])
    harness.destroy()
  })

  it('takes `seq` from the snapshot, so the first event applied is its successor', () => {
    const harness = createTestClient()
    harness.transport.handshake()
    harness.transport.snap('server', 0, makeServerSnapshot())
    harness.transport.snap('fleet', 12, makeFleetSnapshot())
    expect(harness.client.connection.get().streams).toContainEqual({
      stream: 'fleet',
      seq: 12,
      lagged: false,
    })
    harness.transport.evt('fleet', 13, caps(3))
    expect(harness.client.fleet.get().concurrency.runningAttempts).toBe(3)
    harness.destroy()
  })

  it('rejects a malformed snapshot rather than founding the projection on it', () => {
    const harness = createTestClient()
    harness.transport.handshake()
    harness.transport.snap('fleet', 1, { delegations: 'not-an-array' })
    expect(harness.errors.some((error) => error.code === 'bad_protocol')).toBe(true)
    expect(harness.client.delegations.get().size).toBe(0)
    harness.destroy()
  })

  it('a fleet snapshot REPLACES: a delegation the server dropped does not survive it', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM({ id: 'gone' }),
    })
    expect(harness.client.delegations.get().has('gone')).toBe(true)
    harness.transport.lagged('fleet', 1, 'retention')
    harness.transport.snap('fleet', 40, makeFleetSnapshot({ delegations: [makeDelegationVM()] }))
    expect(harness.client.delegations.get().has('gone')).toBe(false)
    expect(harness.client.delegations.get().has('delegation-1')).toBe(true)
    harness.destroy()
  })
})

describe('§2.3 resume — the cursor outlives the connection', () => {
  it('resumes each stream from its own last seq, independently', () => {
    const harness = createTestClient()
    harness.transport.handshake()
    harness.transport.snap('server', 5, makeServerSnapshot())
    harness.transport.snap('fleet', 0, makeFleetSnapshot())
    harness.transport.evt('fleet', 1, caps(1))
    harness.transport.evt('fleet', 2, caps(2))

    harness.transport.serverClose(1006)
    harness.transport.clearSent()
    harness.transport.handshake()

    expect(harness.transport.lastSub('server')?.from).toBe(5)
    expect(harness.transport.lastSub('fleet')?.from).toBe(2)
    harness.destroy()
  })

  it('re-subscribes in the §2.5 rule 2 order: attention before transcripts', () => {
    const harness = createTestClient()
    harness.start()
    harness.client.focus('delegation-1')
    const handle = harness.client.transcript('a1')

    harness.transport.serverClose(1006)
    harness.transport.clearSent()
    harness.transport.handshake()

    const families = harness.transport.of('sub').map((sub) => {
      if (sub.stream === 'server' || sub.stream === 'fleet') return sub.stream
      return sub.stream.startsWith('delegation:') ? 'delegation' : 'attempt'
    })
    const ranks = families.map((family) => RESUBSCRIBE_ORDER.indexOf(family as never))
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(families).toEqual(['server', 'fleet', 'delegation', 'attempt'])
    handle.release()
    harness.destroy()
  })

  it('falls back to `snapshot` for a stream whose first subscription never settled', () => {
    const harness = createTestClient()
    harness.transport.handshake()
    /* `fleet` is subscribed but never answered before the socket dies. */
    harness.transport.snap('server', 0, makeServerSnapshot())
    harness.transport.serverClose(1006)
    harness.transport.clearSent()
    harness.transport.handshake()
    expect(harness.transport.lastSub('fleet')?.from).toBe('snapshot')
    harness.destroy()
  })
})

describe('§2.3 a gap is a bug, lag is explicit', () => {
  it('raises an error naming the stream, the expected seq and the observed one', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, caps(1))
    harness.transport.evt('fleet', 4, caps(4))
    const error = harness.errors.find((candidate) => candidate.message.includes('gap on fleet'))
    expect(error).toBeDefined()
    expect(error?.details).toMatchObject({ stream: 'fleet', expected: 2, received: 4 })
    expect(error?.retryable).toBe(false)
    harness.destroy()
  })

  it('marks the stream lagged until the forced snapshot lands', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, caps(1))
    harness.transport.evt('fleet', 9, caps(9))
    expect(harness.client.connection.get().streams).toContainEqual({
      stream: 'fleet',
      seq: 1,
      lagged: true,
    })
    harness.transport.snap('fleet', 9, makeFleetSnapshot())
    expect(harness.client.connection.get().streams).toContainEqual({
      stream: 'fleet',
      seq: 9,
      lagged: false,
    })
    harness.destroy()
  })

  it('carries the lag reason to the head verbatim (§2.4 backpressure vs §2.3 retention)', () => {
    const harness = createTestClient()
    harness.start()
    const seen: { stream: string; reason: string }[] = []
    harness.client.on('stream:lagged', (event) => seen.push(event))
    const handle = harness.client.transcript('a1')
    harness.transport.snap('attempt:a1', 3, makeAttemptSnapshot({ attemptId: 'a1' }))
    harness.transport.lagged('attempt:a1', 3, 'backpressure')
    expect(seen).toEqual([{ stream: 'attempt:a1', fromSeq: 3, reason: 'backpressure' }])
    expect(handle.vm.get().lagged).toBe(true)
    handle.release()
    harness.destroy()
  })
})

describe('§2.4 ack cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('acks every 128 frames without waiting for the timer', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.clearSent()
    for (let seq = 1; seq <= BACKPRESSURE.ackEveryFrames; seq++) {
      harness.transport.evt('fleet', seq, caps(seq))
    }
    const acks = harness.transport.of('ack')
    expect(acks).toHaveLength(1)
    expect(acks[0]).toMatchObject({ stream: 'fleet', seq: BACKPRESSURE.ackEveryFrames })
    harness.destroy()
  })

  it('acks a partial batch after 1 s of the tick, so a quiet stream still settles its window', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.clearSent()
    harness.transport.evt('fleet', 1, caps(1))
    expect(harness.transport.of('ack')).toHaveLength(0)

    harness.clock.advance(BACKPRESSURE.ackEveryMs)
    vi.advanceTimersByTime(BACKPRESSURE.ackEveryMs)
    expect(harness.transport.of('ack')).toEqual([
      { p: 'swarm', v: 1, k: 'ack', stream: 'fleet', seq: 1 },
    ])
    harness.destroy()
  })
})

describe('§6.2 ref-counted attempt streams', () => {
  it('subscribes once for two transcript handles and releases on the second', () => {
    const harness = createTestClient()
    harness.start()
    const first = harness.client.transcript('a1')
    const second = harness.client.transcript('a1')
    expect(harness.transport.of('sub').filter((sub) => sub.stream === 'attempt:a1')).toHaveLength(1)
    first.release()
    expect(harness.transport.of('unsub')).toHaveLength(0)
    second.release()
    expect(harness.transport.of('unsub').map((frame) => frame.stream)).toEqual(['attempt:a1'])
    harness.destroy()
  })

  it('is idempotent: releasing twice does not unsubscribe a stream someone else holds', () => {
    const harness = createTestClient()
    harness.start()
    const first = harness.client.transcript('a1')
    const second = harness.client.transcript('a1')
    first.release()
    first.release()
    expect(harness.transport.of('unsub')).toHaveLength(0)
    second.release()
    expect(harness.transport.of('unsub')).toHaveLength(1)
    harness.destroy()
  })

  it('re-acquires from `snapshot` after a release, since the cursor was forgotten with it', () => {
    const harness = createTestClient()
    harness.start()
    const first = harness.client.transcript('a1')
    harness.transport.snap('attempt:a1', 7, makeAttemptSnapshot({ attemptId: 'a1' }))
    first.release()
    harness.transport.clearSent()
    const second = harness.client.transcript('a1')
    expect(harness.transport.lastSub('attempt:a1')?.from).toBe('snapshot')
    second.release()
    harness.destroy()
  })

  it('reports subscriber counts through inspect() (§6.2 diagnostics only)', () => {
    const harness = createTestClient()
    harness.start()
    const handle = harness.client.transcript('a1')
    const report = harness.client.inspect()
    expect(report.streams).toContainEqual({
      stream: 'attempt:a1',
      seq: 0,
      subscribers: 1,
      lagged: false,
    })
    expect(report.handles).toEqual({ transcripts: 1, diffs: 0 })
    handle.release()
    harness.destroy()
  })
})
