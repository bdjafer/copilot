/**
 * SPEC-swarm §2.2–§2.5 — the frames a head has to have a **route** for.
 *
 * Every case here is one shape of the same failure: a server frame the client received, understood
 * well enough to decode, and then had nowhere to put. None of them is a state-machine row, which
 * is why a green suite is no evidence about them.
 *
 *  - a `lagged` or a gap answered per-frame instead of once (§2.3, §2.4);
 *  - an `err` answering a `sub` rather than a `req` (§2.2, §2.3);
 *  - an `err` naming a code this build does not know (§2.2);
 *  - a `refresh()` issued while the socket is gone (§6.2, §6.6).
 */

import { describe, expect, it } from 'vitest'

import type { SwarmEvent } from '../src/protocol/events.ts'
import type { ServerCapability } from '../src/protocol/frames.ts'

import { SWARM_PROTOCOL, SWARM_PROTOCOL_VERSION } from '../src/protocol/frames.ts'
import {
  createTestClient,
  makeAttemptSnapshot,
  makeFleetSnapshot,
  makeServerSnapshot,
} from '../src/testing/client-harness.ts'

const caps = (running: number): SwarmEvent => ({
  k: 'fleet.caps',
  concurrency: { runningAttempts: running, cap: 4, queued: 0 },
  dispatchPaused: false,
})

const subsFor = (harness: ReturnType<typeof createTestClient>, stream: string): number =>
  harness.transport.of('sub').filter((frame) => frame.stream === stream).length

describe('§2.3/§2.4 one re-snapshot per drop — backpressure must not amplify into load', () => {
  it('answers a `lagged` followed by N in-flight events with ONE sub and ONE lag signal', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.clearSent()

    harness.transport.lagged('fleet', 5, 'backpressure')
    /* Everything the server had already written to the socket arrives after the `lagged`. Each
     * one is ahead of the cursor; answering each with a re-subscribe is the inversion §2.4
     * exists to prevent. */
    for (let seq = 6; seq <= 15; seq++) harness.transport.evt('fleet', seq, caps(seq))

    expect(subsFor(harness, 'fleet')).toBe(1)
    expect(harness.transport.lastSub('fleet')?.from).toBe('snapshot')
    expect(harness.errors).toEqual([])
    harness.destroy()
  })

  it('answers a gap followed by N more events with ONE error and ONE sub', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, caps(1))
    harness.transport.clearSent()

    harness.transport.evt('fleet', 9, caps(9))
    for (let seq = 10; seq <= 20; seq++) harness.transport.evt('fleet', seq, caps(seq))

    expect(subsFor(harness, 'fleet')).toBe(1)
    expect(harness.errors).toHaveLength(1)
    expect(harness.errors[0]?.message).toContain('gap on fleet')
    harness.destroy()
  })

  it('applies nothing between the forced sub and the snapshot that answers it (§2.3)', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, caps(1))
    expect(harness.client.fleet.get().concurrency.runningAttempts).toBe(1)

    harness.transport.lagged('fleet', 1, 'backpressure')
    harness.transport.evt('fleet', 2, caps(99))
    expect(harness.client.fleet.get().concurrency.runningAttempts).toBe(1)

    harness.transport.snap('fleet', 7, makeFleetSnapshot())
    expect(harness.client.connection.get().streams).toContainEqual({
      stream: 'fleet',
      seq: 7,
      lagged: false,
    })
    harness.transport.evt('fleet', 8, caps(3))
    expect(harness.client.fleet.get().concurrency.runningAttempts).toBe(3)
    harness.destroy()
  })
})

describe('§2.2/§2.3 an `err` answering a `sub` is routed, never dropped', () => {
  it('recovers `bad_cursor` by re-subscribing from a snapshot, and says so', () => {
    const harness = createTestClient()
    harness.transport.handshake()
    harness.transport.snap('server', 0, makeServerSnapshot())
    harness.transport.snap('fleet', 0, makeFleetSnapshot())
    harness.transport.evt('fleet', 1, caps(1))

    /* A purge restarted the stream under the head: its cursor is now above the head, which §2.3
     * makes `err{code:'bad_cursor'}`. */
    harness.transport.serverClose(1006)
    harness.transport.clearSent()
    harness.transport.handshake()
    const resume = harness.transport.lastSub('fleet')
    expect(resume?.from).toBe(1)
    harness.transport.fail(resume!.id, 'bad_cursor', 'cursor 1 is above head 0')

    expect(harness.errors.map((error) => error.code)).toContain('bad_cursor')
    expect(harness.transport.lastSub('fleet')?.from).toBe('snapshot')
    expect(harness.client.inspect().counters.unroutedFrames ?? 0).toBe(0)
    harness.destroy()
  })

  it('raises `stream_unknown` and does NOT retry it — a refused stream is not a sub loop', () => {
    const harness = createTestClient()
    harness.transport.handshake()
    harness.transport.snap('server', 0, makeServerSnapshot())
    const sub = harness.transport.lastSub('fleet')!
    harness.transport.clearSent()
    harness.transport.fail(sub.id, 'stream_unknown', 'unroutable stream fleet')

    expect(harness.errors.map((error) => error.code)).toContain('stream_unknown')
    expect(subsFor(harness, 'fleet')).toBe(0)
    /* But it is not forgotten either: §2.5 rule 2's re-subscribe is the retry. */
    harness.transport.serverClose(1006)
    harness.transport.handshake()
    expect(harness.transport.lastSub('fleet')?.from).toBe('snapshot')
    harness.destroy()
  })

  it('marks the stream lagged until a snapshot lands, so the head can render the hole', () => {
    const harness = createTestClient()
    harness.transport.handshake()
    harness.transport.snap('server', 0, makeServerSnapshot())
    const sub = harness.transport.lastSub('fleet')!
    harness.transport.fail(sub.id, 'bad_cursor', 'nope')
    expect(harness.client.connection.get().streams).toContainEqual({
      stream: 'fleet',
      seq: 0,
      lagged: true,
    })
    harness.transport.snap('fleet', 3, makeFleetSnapshot())
    expect(harness.client.connection.get().streams).toContainEqual({
      stream: 'fleet',
      seq: 3,
      lagged: false,
    })
    harness.destroy()
  })

  it('still routes an `err` that answers a `req`, and an `err{id:null}` (the ids share a counter)', async () => {
    const harness = createTestClient()
    harness.start()
    const pending = harness.client.cancel('delegation-1', { scope: 'delegation' })
    const req = harness.transport.lastReq('cancel')!
    harness.transport.fail(req.id, 'not_found', 'no such delegation')
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('not_found')

    harness.transport.fail(null, 'rate_limited', 'slow down')
    expect(harness.errors.map((error) => error.code)).toContain('rate_limited')
    harness.destroy()
  })
})

describe('§2.2 an `err` naming an unknown code settles its intent instead of hanging it', () => {
  it('delivers a future error code as `internal` and preserves it in details', async () => {
    const harness = createTestClient()
    harness.start()
    const pending = harness.client.cancel('delegation-1', { scope: 'delegation' })
    const req = harness.transport.lastReq('cancel')!
    harness.transport.deliverText(
      JSON.stringify({
        p: SWARM_PROTOCOL,
        v: SWARM_PROTOCOL_VERSION,
        k: 'err',
        id: req.id,
        code: 'quota_exhausted_in_a_later_minor',
        message: 'refused',
        retryable: false,
      }),
    )
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('internal')
      expect(result.error.details?.unknownErrorCode).toBe('quota_exhausted_in_a_later_minor')
    }
    expect(harness.client.connection.get().pendingIntents).toBe(0)
    harness.destroy()
  })
})

describe('§6.2 `DiffHandle.refresh()` always settles', () => {
  it('settles while the socket is gone rather than waiting for a snapshot that cannot come', async () => {
    const harness = createTestClient()
    harness.start()
    const diff = harness.client.diff('attempt-1')
    harness.transport.snap('attempt:attempt-1', 0, makeAttemptSnapshot())
    harness.transport.serverClose(1006)

    await expect(diff.refresh()).resolves.toBeUndefined()
    diff.release()
    harness.destroy()
  })

  it('settles a refresh that was in flight when the socket went', async () => {
    const harness = createTestClient()
    harness.start()
    const diff = harness.client.diff('attempt-1')
    harness.transport.snap('attempt:attempt-1', 0, makeAttemptSnapshot())
    const pending = diff.refresh()
    harness.transport.serverClose(1006)
    await expect(pending).resolves.toBeUndefined()
    diff.release()
    harness.destroy()
  })

  it('still resolves on the snapshot when the socket is live', async () => {
    const harness = createTestClient()
    harness.start()
    const diff = harness.client.diff('attempt-1')
    harness.transport.snap('attempt:attempt-1', 0, makeAttemptSnapshot())
    const pending = diff.refresh()
    harness.transport.snap('attempt:attempt-1', 4, makeAttemptSnapshot())
    await expect(pending).resolves.toBeUndefined()
    diff.release()
    harness.destroy()
  })
})

describe('§2.5 rule 2 — `capabilities` is a SET, not a sequence', () => {
  const order = (list: readonly ServerCapability[]): ServerCapability[] => [...list]

  it('a re-ordered but identical capability list is not a changed server', () => {
    const harness = createTestClient()
    let changed = 0
    harness.client.on('server-changed', () => {
      changed += 1
    })
    harness.transport.handshake({ capabilities: order(['replay', 'snapshot', 'landing']) })
    harness.transport.snap('server', 0, makeServerSnapshot())
    harness.transport.snap('fleet', 0, makeFleetSnapshot())
    harness.transport.serverClose(1006)
    harness.transport.clearSent()
    harness.transport.handshake({ capabilities: order(['landing', 'replay', 'snapshot']) })

    expect(changed).toBe(0)
    /* And therefore no forced re-snapshot of every stream (X14). */
    expect(harness.transport.lastSub('fleet')?.from).toBe(0)
    harness.destroy()
  })

  it('a genuinely different capability set still raises `server-changed`', () => {
    const harness = createTestClient()
    let changed = 0
    harness.client.on('server-changed', () => {
      changed += 1
    })
    harness.transport.handshake({ capabilities: ['replay', 'snapshot'] })
    harness.transport.snap('server', 0, makeServerSnapshot())
    harness.transport.snap('fleet', 0, makeFleetSnapshot())
    harness.transport.serverClose(1006)
    harness.transport.handshake({ capabilities: ['replay', 'landing'] })

    expect(changed).toBe(1)
    expect(harness.transport.lastSub('fleet')?.from).toBe('snapshot')
    harness.destroy()
  })
})
