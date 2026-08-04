/**
 * SPEC-swarm §2.5 / §6.3 — the request-timeout reaper.
 *
 * `createIntentQueue` had three rules for a request that is answered, re-sent or queued, and none
 * for the one that is **never answered at all**. A server that accepts the frame and then replies
 * with neither `res` nor `err` — a wedged handler, a dropped reply, a crash between write and
 * flush — left `dispatch()`'s promise pending forever: a head spinner that never resolves, an
 * `inspect().pending` row that never clears, and no surface anywhere able to say why. `abortAll`
 * did not cover it either, because that fires on a socket that *noticed*, and this is precisely
 * the case where nothing did.
 *
 * These cases pin the reaper in both directions: it settles the silent request, and it never
 * touches one that was answered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SERVER_POLICY } from '../src/domain/constants.ts'
import { SwarmError } from '../src/errors.ts'
import { createTestClient } from '../src/testing/client-harness.ts'

describe('§2.5 a sent request that is never answered is reaped, not left pending', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('settles the promise with a visible `timeout` error instead of hanging forever', async () => {
    const harness = createTestClient()
    harness.start()

    const pending = harness.client.killSwitch({ killInstances: false })
    expect(harness.transport.of('req')).toHaveLength(1)
    /* Nothing is written back: the server took the frame and went silent. */
    expect(harness.client.inspect().pending).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(SERVER_POLICY.requestTimeoutMs + 10)
    const result = await pending

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(SwarmError.is(result.error)).toBe(true)
    expect(result.error.code).toBe('timeout')
    /* Safe by construction: §2.5 rule 3's `(tokenId, idempotencyKey)` cache replays the original
     * response — including the original error — so a retry cannot become a second mutation. */
    expect(result.error.retryable).toBe(true)
    expect(result.error.message).toMatch(/killSwitch/)

    /* And the row is gone, so `pendingIntents` stops counting a request nobody is waiting on. */
    expect(harness.client.inspect().pending).toHaveLength(0)
    expect(harness.client.connection.get().pendingIntents).toBe(0)
    harness.destroy()
  })

  it('raises a notice so the user learns why the spinner stopped', async () => {
    const harness = createTestClient()
    harness.start()

    void harness.client.killSwitch({ killInstances: false })
    await vi.advanceTimersByTimeAsync(SERVER_POLICY.requestTimeoutMs + 10)

    const notices = harness.client.notices.get()
    const timeout = notices.find((notice) => notice.id.startsWith('request-timeout-'))
    expect(timeout).toBeDefined()
    /* `delivery-unknown` is the honest kind: the request left, nothing came back, and whether the
     * server acted on it is exactly what nobody knows. */
    expect(timeout?.kind).toBe('delivery-unknown')
    expect(timeout?.severity).toBe('warn')
    expect(timeout?.detail).toMatch(/killSwitch/)
    expect(timeout?.dismissible).toBe(true)
    harness.destroy()
  })

  it('counts it, so a wedged server is visible in `inspect().counters`', async () => {
    const harness = createTestClient()
    harness.start()

    expect(harness.client.inspect().counters.timedOut).toBe(0)
    void harness.client.killSwitch({ killInstances: false })
    await vi.advanceTimersByTimeAsync(SERVER_POLICY.requestTimeoutMs + 10)
    expect(harness.client.inspect().counters.timedOut).toBe(1)
    /* Not counted as answered or refused: those mean a frame came back. */
    expect(harness.client.inspect().counters.answered).toBe(0)
    expect(harness.client.inspect().counters.refused).toBe(0)
    harness.destroy()
  })

  it('does NOT reap a request that was answered in time', async () => {
    const harness = createTestClient()
    harness.start()

    const pending = harness.client.killSwitch({ killInstances: false })
    const req = harness.transport.of('req')[0]!
    harness.transport.respond(req.id, { ok: true }, 1)
    const result = await pending
    expect(result.ok).toBe(true)

    /* Well past the deadline: the reaper for that id must already be cancelled, or it fires into
     * a promise that is long settled and decrements a counter that no longer has a row. */
    await vi.advanceTimersByTimeAsync(SERVER_POLICY.requestTimeoutMs * 3)
    expect(harness.client.inspect().counters.timedOut).toBe(0)
    expect(harness.client.inspect().pending).toHaveLength(0)
    harness.destroy()
  })

  it('does NOT reap one that was answered with an error, either', async () => {
    const harness = createTestClient()
    harness.start()

    const pending = harness.client.reconcile('delegation-1')
    const req = harness.transport.of('req')[0]!
    harness.transport.fail(req.id, 'not_found', 'no such delegation')
    const result = await pending
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.error.code).toBe('not_found')

    await vi.advanceTimersByTimeAsync(SERVER_POLICY.requestTimeoutMs * 3)
    expect(harness.client.inspect().counters.timedOut).toBe(0)
    harness.destroy()
  })

  it('restarts the clock on a resend rather than reaping a request barely asked', async () => {
    const harness = createTestClient()
    harness.start()

    void harness.client.killSwitch({ killInstances: false })
    /* Most of the way to the deadline, then the socket drops and comes back. */
    await vi.advanceTimersByTimeAsync(SERVER_POLICY.requestTimeoutMs - 1_000)
    harness.transport.serverClose(1006, 'socket dropped')
    harness.transport.handshake()
    expect(harness.client.inspect().counters.resent).toBe(1)

    /* Past the ORIGINAL deadline but not the new one: a resend is a fresh ask at a fresh server,
     * and reaping it on the first clock would time out a request that had barely been made. */
    await vi.advanceTimersByTimeAsync(2_000)
    expect(harness.client.inspect().counters.timedOut).toBe(0)
    expect(harness.client.inspect().pending).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(SERVER_POLICY.requestTimeoutMs)
    expect(harness.client.inspect().counters.timedOut).toBe(1)
    harness.destroy()
  })

  it('a destroyed client leaves no timer behind to fire into a settled promise', async () => {
    const harness = createTestClient()
    harness.start()

    const pending = harness.client.killSwitch({ killInstances: false })
    harness.destroy()
    /* `destroy()` aborts everything outstanding, so the promise is already settled — and the
     * reaper must have died with it rather than firing later and counting a second settle. */
    const result = await pending
    expect(result.ok).toBe(false)

    await vi.advanceTimersByTimeAsync(SERVER_POLICY.requestTimeoutMs * 3)
    expect(harness.client.inspect().counters.timedOut).toBe(0)
  })

  it('an offline intent is not on the clock until it is actually sent', async () => {
    const harness = createTestClient({ autoAccept: false })

    void harness.client.killSwitch({ killInstances: false })
    /* Queued, never written — §6.6's stale-turn rule owns this window, not the reaper's. */
    expect(harness.client.inspect().offlineQueue).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(SERVER_POLICY.requestTimeoutMs * 2)
    expect(harness.client.inspect().counters.timedOut).toBe(0)

    harness.transport.handshake()
    expect(harness.client.inspect().pending).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(SERVER_POLICY.requestTimeoutMs + 10)
    expect(harness.client.inspect().counters.timedOut).toBe(1)
    harness.destroy()
  })
})
