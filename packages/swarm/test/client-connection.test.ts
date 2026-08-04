/**
 * SPEC-swarm §2.1, §2.2, §2.4, §2.5 — the connection state machine, driven frame by frame.
 *
 * `clientConformance()` carries the rows §13 names; this file carries the mechanics underneath
 * them: which frame moves which state, what the heartbeat does with a silent socket, and what
 * `hello_ok` does when the server is not the one the head last spoke to.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CLIENT_TICK_MS } from '../src/client/connection.ts'
import { createSwarmClient } from '../src/client/index.ts'
import { HEARTBEAT, RECONNECT, backoffDelayMs } from '../src/protocol/constants.ts'
import { createTestClient } from '../src/testing/client-harness.ts'
import { createFakeTransport } from '../src/testing/fake-transport.ts'

describe('§2.2 the handshake', () => {
  it('writes hello with the injected client name and head, and nothing before it', () => {
    const harness = createTestClient({ clientName: 'ext/0.1', head: 'extension' })
    expect(harness.transport.sent).toHaveLength(1)
    const hello = harness.transport.sent[0]!
    expect(hello).toMatchObject({
      p: 'swarm',
      v: 1,
      k: 'hello',
      client: 'ext/0.1',
      head: 'extension',
      minV: 1,
      maxV: 1,
    })
    harness.destroy()
  })

  it('reports `connecting` before hello_ok and `connected` after', () => {
    const harness = createTestClient()
    expect(harness.client.connection.get().status).toBe('connecting')
    harness.transport.handshake({ serverVersion: '0.4.2' })
    const vm = harness.client.connection.get()
    expect(vm.status).toBe('connected')
    expect(vm.serverVersion).toBe('0.4.2')
    expect(vm.attempt).toBe(0)
    expect(vm.nextRetryAtMs).toBeNull()
    harness.destroy()
  })

  it('treats a malformed envelope as fatal and blocks with `protocol` (§2.2)', () => {
    const harness = createTestClient()
    harness.transport.handshake()
    harness.transport.deliverText('{"p":"not-swarm","v":1,"k":"res","id":1,"data":{}}')
    expect(harness.client.connection.get().status).toBe('blocked')
    expect(harness.client.connection.get().blockedReason).toBe('protocol')
    harness.destroy()
  })

  it('ignores an unknown server frame kind and keeps the connection (§2.2)', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.deliverText('{"p":"swarm","v":1,"k":"telemetry","payload":1}')
    expect(harness.client.connection.get().status).toBe('connected')
    /* Forward compatibility is a runtime property — but it is still reported, not swallowed. */
    expect(harness.errors.some((error) => error.code === 'unknown_frame')).toBe(true)
    harness.destroy()
  })

  it('answers a server ping with a pong carrying the same `t` (§2.4)', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.clearSent()
    harness.transport.deliver({ p: 'swarm', v: 1, k: 'ping', t: 4242 })
    expect(harness.transport.of('pong')).toEqual([{ p: 'swarm', v: 1, k: 'pong', t: 4242 }])
    harness.destroy()
  })
})

describe('§2.5 close-code policy', () => {
  it.each([
    [4001, 'unauthenticated'],
    [4003, 'forbidden'],
    [4004, 'protocol'],
  ] as const)('close %i is terminal and surfaces `%s`', (code, reason) => {
    const harness = createTestClient()
    harness.start()
    harness.transport.serverClose(code)
    const vm = harness.client.connection.get()
    expect(vm.status).toBe('blocked')
    expect(vm.blockedReason).toBe(reason)
    expect(vm.nextRetryAtMs).toBeNull()
    harness.destroy()
  })

  it('settles every outstanding intent when the connection is blocked', async () => {
    const harness = createTestClient()
    harness.start()
    const pending = harness.client.killSwitch({ killInstances: false })
    harness.transport.serverClose(4001)
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unauthenticated')
    harness.destroy()
  })

  it('does not reopen after a terminal close', () => {
    const harness = createTestClient()
    harness.start()
    const opens = harness.transport.opens
    harness.transport.serverClose(4003)
    expect(harness.transport.opens).toBe(opens)
    harness.destroy()
  })
})

describe('§2.5 rule 1 — the reconnect ladder', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules attempt n inside the jitter band around backoffDelayMs(n)', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.serverClose(1006)
    const vm = harness.client.connection.get()
    const base = backoffDelayMs(1)
    expect(vm.attempt).toBe(1)
    expect(vm.nextRetryAtMs).not.toBeNull()
    const delay = vm.nextRetryAtMs! - harness.clock.now()
    expect(delay).toBeGreaterThanOrEqual(Math.floor(base * (1 - RECONNECT.jitter)))
    expect(delay).toBeLessThanOrEqual(Math.ceil(base * (1 + RECONNECT.jitter)))
    harness.destroy()
  })

  it('reopens the transport when the backoff elapses, and resets on hello_ok', () => {
    const harness = createTestClient()
    harness.start()
    const opens = harness.transport.opens
    harness.transport.serverClose(1006)
    vi.advanceTimersByTime(RECONNECT.capMs)
    expect(harness.transport.opens).toBe(opens + 1)
    /* `open()` auto-accepts, so the client has already re-sent `hello`; the server answers. */
    harness.transport.handshake()
    expect(harness.client.connection.get().attempt).toBe(0)
    expect(harness.client.connection.get().status).toBe('connected')
    harness.destroy()
  })

  it('honours `bye{retryAfterMs}` as a floor on the next delay and suppresses the re-send', () => {
    const harness = createTestClient()
    harness.start()
    void harness.client.killSwitch({ killInstances: false })
    harness.transport.deliver({
      p: 'swarm',
      v: 1,
      k: 'bye',
      reason: 'shutting down',
      retryAfterMs: 60_000,
    })
    harness.transport.serverClose(4013)
    const vm = harness.client.connection.get()
    expect(vm.nextRetryAtMs! - harness.clock.now()).toBeGreaterThanOrEqual(60_000)

    harness.transport.clearSent()
    vi.advanceTimersByTime(120_000)
    harness.transport.handshake()
    /* §2.5 rule 3: a shutting-down server must not be re-sent the in-flight mutation. */
    expect(harness.transport.of('req')).toHaveLength(0)
    harness.destroy()
  })
})

describe('§2.4 heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('pings after clientPingMs of silence and gives up at deadMs', () => {
    const clockStart = 1_000
    let ms = clockStart
    const transport = createFakeTransport()
    const client = createSwarmClient({
      transport,
      clientName: 'test/0.1',
      head: 'test',
      now: () => ms,
    })
    transport.handshake()
    transport.clearSent()

    ms += HEARTBEAT.clientPingMs
    vi.advanceTimersByTime(CLIENT_TICK_MS)
    expect(transport.of('ping')).toHaveLength(1)

    ms += HEARTBEAT.deadMs
    vi.advanceTimersByTime(CLIENT_TICK_MS)
    /* No pong and no frame within 30 s ⇒ the client closes and re-enters the ladder. */
    expect(client.connection.get().status).toBe('reconnecting')
    client.destroy()
  })

  it('treats any inbound frame as liveness, not just a pong', () => {
    let ms = 1_000
    const transport = createFakeTransport()
    const client = createSwarmClient({
      transport,
      clientName: 'test/0.1',
      head: 'test',
      now: () => ms,
    })
    transport.handshake()
    transport.snap('server', 0, {
      health: {
        server: { ok: true, version: '0', uptimeMs: 0 },
        executor: { ok: true, adapterId: 'mock', versions: {}, blocked: null, fix: null },
        instances: [],
        routes: [],
        approvalsAvailable: false,
        lastDoctorAt: null,
      },
      notices: [],
      confirmations: [],
    })
    transport.clearSent()

    ms += HEARTBEAT.clientPingMs - 1
    vi.advanceTimersByTime(CLIENT_TICK_MS)
    expect(transport.of('ping')).toHaveLength(0)
    expect(client.connection.get().status).toBe('connected')
    client.destroy()
  })
})

describe('§2.5 rule 2 — server-changed', () => {
  it('raises `server-changed`, pushes a notice and forces every stream to re-snapshot', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.caps',
      concurrency: { runningAttempts: 1, cap: 4, queued: 0 },
      dispatchPaused: false,
    })

    const seen: { serverVersion: string }[] = []
    harness.client.on('server-changed', (event) => seen.push(event))

    harness.transport.serverClose(1006)
    harness.transport.clearSent()
    harness.transport.handshake({ serverVersion: '0.9.9' })

    expect(seen).toEqual([{ serverVersion: '0.9.9', capabilities: ['replay', 'snapshot'] }])
    expect(harness.transport.lastSub('fleet')?.from).toBe('snapshot')
    expect(harness.client.notices.get().some((notice) => notice.kind === 'server-changed')).toBe(
      true,
    )
    harness.destroy()
  })

  it('does not raise it on the first connect, when there is no previous server to differ from', () => {
    const harness = createTestClient()
    let raised = 0
    harness.client.on('server-changed', () => {
      raised += 1
    })
    harness.transport.handshake()
    expect(raised).toBe(0)
    harness.destroy()
  })

  it('raises it when the capability set changes even at the same version (X14)', () => {
    const harness = createTestClient()
    harness.transport.handshake({ capabilities: ['replay'] })
    let raised = 0
    harness.client.on('server-changed', () => {
      raised += 1
    })
    harness.transport.serverClose(1006)
    harness.transport.handshake({ capabilities: ['replay', 'landing'] })
    expect(raised).toBe(1)
    expect(harness.client.connection.get().capabilities).toEqual(['replay', 'landing'])
    harness.destroy()
  })
})

describe('§6.2 ConnectionVM', () => {
  it('is republished only when something actually changed', () => {
    const harness = createTestClient()
    harness.start()
    const seen: number[] = []
    harness.client.connection.subscribe(() => seen.push(1))
    const before = harness.client.connection.get()
    harness.transport.deliver({ p: 'swarm', v: 1, k: 'pong', t: 1 })
    expect(harness.client.connection.get()).toBe(before)
    expect(seen).toHaveLength(0)
    harness.destroy()
  })

  it('carries the per-stream cursor a head renders as "how far behind am I"', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.caps',
      concurrency: { runningAttempts: 1, cap: 4, queued: 0 },
      dispatchPaused: false,
    })
    const streams = harness.client.connection.get().streams
    expect(streams).toEqual([
      { stream: 'server', seq: 0, lagged: false },
      { stream: 'fleet', seq: 1, lagged: false },
    ])
    harness.destroy()
  })
})
