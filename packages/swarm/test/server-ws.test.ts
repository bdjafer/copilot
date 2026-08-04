/**
 * SPEC-swarm §2.2–§2.5 — the envelope, the four stream families, durable replay, backpressure,
 * heartbeats and the close codes, driven over a **real socket**.
 *
 * The property under test throughout is §2.3's: **connections hold zero resumable state.** Every
 * assertion that a second connection can resume where the first left off is an assertion that the
 * first left nothing behind — which is what makes a service worker that dies without warning, and
 * a laptop that sleeps for hours, indistinguishable from a head that never disconnected.
 *
 * §13's protocol rows landed here rather than in `protocolConformance()` because they are
 * connection-level: they need a server, a durable log and a socket that can be made slow.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { LogRecord } from '../src/log/types.ts'
import type { EvtFrame, ServerFrame } from '../src/protocol/frames.ts'
import type { ServerHarness } from './support/server-harness.ts'

import { attemptStream } from '../src/protocol/codec.ts'
import { BACKPRESSURE, CLOSE_CODES, HEARTBEAT, LIMITS } from '../src/protocol/constants.ts'
import { SwarmConnection } from '../src/server/ws.ts'
import { createServerHarness, openRawSocket, settle } from './support/server-harness.ts'

let harness: ServerHarness | null = null

afterEach(async () => {
  await harness?.dispose()
  harness = null
})

async function serve(): Promise<ServerHarness> {
  harness = await createServerHarness()
  return harness
}

const isEvt = (frame: ServerFrame): frame is EvtFrame => frame.k === 'evt'

/** Write `n` `att.text` rows straight into the durable log — the executor pump's shape, no executor. */
function driveAttempt(h: ServerHarness, attemptId: string, n: number): readonly LogRecord[] {
  return h.server.engine.store.commit((tx) => {
    const rows: LogRecord[] = []
    for (let i = 0; i < n; i++) {
      rows.push(
        tx.appendLog({
          stream: attemptStream(attemptId),
          ev: { k: 'att.text', text: `chunk-${i}` },
          actor: { kind: 'server', reason: 'test' },
          attemptId,
        }),
      )
    }
    return rows
  }).value
}

function driveFleetNotice(h: ServerHarness, n: number): void {
  h.server.engine.store.commit((tx) => {
    for (let i = 0; i < n; i++) {
      tx.appendLog({
        stream: 'fleet',
        ev: {
          k: 'fleet.caps',
          concurrency: { runningAttempts: i, cap: 4, queued: 0 },
          dispatchPaused: false,
        },
        actor: { kind: 'server', reason: 'test' },
      })
    }
  })
}

describe('§2.2 the envelope and the first frame', () => {
  it('`hello` MUST be the first client frame; anything else closes 4004', async () => {
    const h = await serve()
    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    socket.send({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'fleet', from: 'snapshot' })
    expect((await socket.waitForClose()).code).toBe(CLOSE_CODES.protocol)
  })

  it('a second `hello` closes 4004 — the handshake happens once', async () => {
    const h = await serve()
    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    await socket.hello()
    socket.send({ p: 'swarm', v: 1, k: 'hello', client: 'again', head: 'test', minV: 1, maxV: 1 })
    expect((await socket.waitForClose()).code).toBe(CLOSE_CODES.protocol)
  })

  it('an unknown client `k` errors and the connection SURVIVES', async () => {
    const h = await serve()
    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    await socket.hello()
    socket.send({ p: 'swarm', v: 1, k: 'teleport', id: 7 })
    const error = await socket.waitFor((frame) => frame.k === 'err')
    expect(error).toMatchObject({ k: 'err', code: 'unknown_frame' })
    /* Survival is the assertion: a ping still answers. */
    socket.send({ p: 'swarm', v: 1, k: 'ping', t: 1 })
    expect((await socket.waitFor((frame) => frame.k === 'pong')).k).toBe('pong')
    expect(socket.closes).toEqual([])
    socket.close()
  })

  it('a wrong `p`/`v` is fatal on frame 1 — a mis-wired peer never gets a second chance', async () => {
    const h = await serve()
    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    socket.send({ p: 'swarm', v: 2, k: 'hello', client: 'x', head: 'test', minV: 1, maxV: 1 })
    expect((await socket.waitForClose()).code).toBe(CLOSE_CODES.protocol)
  })

  it('`hello_ok` advertises the capability set and a connection id', async () => {
    const h = await serve()
    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    const hello = (await socket.hello()) as Extract<ServerFrame, { k: 'hello_ok' }>
    expect(hello.capabilities).toContain('replay')
    expect(hello.capabilities).toContain('snapshot')
    expect(hello.capabilities).toContain('parallel-attempts')
    /* Approvals ship **dark** until the runtime probe flips (R6, #14). */
    expect(hello.capabilities).not.toContain('approvals')
    expect(typeof hello.connectionId).toBe('string')
    socket.close()
  })

  it('an unroutable stream yields `stream_unknown` and never a subscription', async () => {
    const h = await serve()
    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    await socket.hello()
    socket.send({ p: 'swarm', v: 1, k: 'sub', id: 4, stream: 'galaxy:1', from: 'snapshot' })
    const error = await socket.waitFor((frame) => frame.k === 'err')
    /* `id: null`, and that is §2.2 as written: the template-literal union is validated **by shape
     * on ingest**, so the frame never reaches the router that knows about request ids. The
     * connection survives — an unroutable stream is a client bug, not a protocol violation. */
    expect(error).toMatchObject({ code: 'stream_unknown', id: null })
    socket.send({ p: 'swarm', v: 1, k: 'ping', t: 2 })
    expect((await socket.waitFor((frame) => frame.k === 'pong')).k).toBe('pong')
    socket.close()
  })

  it('a frame over 1 MiB is refused with `frame_too_large` and the connection survives', async () => {
    const h = await serve()
    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    await socket.hello()
    socket.send(
      JSON.stringify({
        p: 'swarm',
        v: 1,
        k: 'req',
        id: 9,
        intent: 'createDelegation',
        args: { pad: 'x'.repeat(LIMITS.frameBytes + 1_000) },
        idempotencyKey: 'idem-big',
      }),
    )
    const error = await socket.waitFor((frame) => frame.k === 'err')
    expect(error).toMatchObject({ code: 'frame_too_large' })
    expect(socket.closes).toEqual([])
    socket.close()
  })
})

describe('§2.3 snapshot, replay and the gapless `seq`', () => {
  it('`sub{from:"snapshot"}` yields a snap whose seq is the exact predecessor of the first evt', async () => {
    const h = await serve()
    driveFleetNotice(h, 3)
    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    await socket.hello()
    socket.send({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'fleet', from: 'snapshot' })
    const snap = (await socket.waitFor((frame) => frame.k === 'snap')) as Extract<
      ServerFrame,
      { k: 'snap' }
    >
    expect(snap.seq).toBe(3)

    driveFleetNotice(h, 1)
    const evt = await socket.next(isEvt)
    expect(evt.seq).toBe(snap.seq + 1)
    socket.close()
  })

  it('`sub{from:n}` replays every record after n, in order, exactly once', async () => {
    const h = await serve()
    driveFleetNotice(h, 5)
    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    await socket.hello()
    socket.send({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'fleet', from: 2 })
    await socket.waitFor((frame) => frame.k === 'evt' && frame.seq === 5)
    const seqs = socket.frames.filter(isEvt).map((frame) => frame.seq)
    expect(seqs).toEqual([3, 4, 5])
    socket.close()
  })

  it('`sub{from:n}` below the floor yields `lagged{reason:"retention"}` and never a gap', async () => {
    const h = await serve()
    driveFleetNotice(h, 5)
    h.server.engine.store.commit((tx) => tx.advanceFloor('fleet', 3))
    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    await socket.hello()
    socket.send({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'fleet', from: 1 })
    const lagged = (await socket.waitFor((frame) => frame.k === 'lagged')) as Extract<
      ServerFrame,
      { k: 'lagged' }
    >
    expect(lagged.reason).toBe('retention')
    /* Not one event was delivered: a shortened replay is a gap, and §2.3 forbids gaps. */
    expect(socket.frames.filter(isEvt)).toEqual([])
    socket.close()
  })

  it('`sub{from:n}` above the head yields `bad_cursor`', async () => {
    const h = await serve()
    driveFleetNotice(h, 2)
    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    await socket.hello()
    socket.send({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'fleet', from: 99 })
    expect(await socket.waitFor((frame) => frame.k === 'err')).toMatchObject({
      code: 'bad_cursor',
      id: 1,
    })
    socket.close()
  })

  it('replay is DURABLE, not connection-scoped: a second connection resumes from the first cursor', async () => {
    const h = await serve()
    driveFleetNotice(h, 4)

    const first = await openRawSocket({ port: h.port(), token: h.token() })
    await first.hello()
    first.send({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'fleet', from: 0 })
    await first.waitFor((frame) => frame.k === 'evt' && frame.seq === 4)
    first.close()

    /* Everything the head needs to resume is `(stream, seq)`; the server kept nothing else. */
    driveFleetNotice(h, 3)
    const second = await openRawSocket({ port: h.port(), token: h.token('second head') })
    await second.hello()
    second.send({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'fleet', from: 4 })
    await second.waitFor((frame) => frame.k === 'evt' && frame.seq === 7)
    expect(second.frames.filter(isEvt).map((frame) => frame.seq)).toEqual([5, 6, 7])
    second.close()
  })

  it('the four families each carry their own gapless sequence', async () => {
    const h = await serve()
    driveFleetNotice(h, 2)
    driveAttempt(h, 'a-1', 3)
    const heads = h.server.engine.store.read((tx) => tx.heads())
    const byStream = new Map(heads.map((row) => [row.stream, row.head]))
    expect(byStream.get('fleet')).toBe(2)
    expect(byStream.get('attempt:a-1')).toBe(3)
    /* Per-stream, so a head watching one delegation never pays the fleet's transcript volume. */
    expect(byStream.get('server') ?? 0).toBe(0)
  })
})

describe('§2.4 backpressure — only `attempt:*` degrades (Q12)', () => {
  it('drives 100 000 executor events into a slow connection: the log head advances at full speed', async () => {
    const h = await serve()
    const engine = h.server.engine
    let delivered = 0

    /* A connection whose socket accepts ten frames and then reports a full kernel buffer — the
     * "10 frames/s" head of §13, without a wall-clock rate to wait on. */
    const connection = new SwarmConnection({
      id: 'slow',
      socket: {
        send: () => {
          delivered += 1
        },
        close: () => undefined,
        bufferedAmount: () => (delivered > 10 ? BACKPRESSURE.queueBytes + 1 : 0),
      },
      engine,
      token: {
        tokenId: 't',
        hash: '',
        clientName: 'slow',
        clientKind: 'test',
        issuedAt: 0,
        revokedAt: null,
      },
      serverVersion: '0.1.0',
      autoHeartbeat: false,
    })
    const unsubscribe = engine.store.onCommit((result) => {
      for (const record of result.emitted) connection.deliver(record)
    })

    await connection.receive(
      JSON.stringify({
        p: 'swarm',
        v: 1,
        k: 'hello',
        client: 'slow',
        head: 'test',
        minV: 1,
        maxV: 1,
      }),
    )
    await connection.receive(
      JSON.stringify({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'attempt:hot', from: 0 }),
    )
    await connection.receive(
      JSON.stringify({ p: 'swarm', v: 1, k: 'sub', id: 2, stream: 'fleet', from: 0 }),
    )

    const started = Date.now()
    for (let batch = 0; batch < 100; batch++) {
      driveAttempt(h, 'hot', 1_000)
      driveFleetNotice(h, 1)
    }
    const elapsed = Date.now() - started

    /* X7: the pump reached the disk regardless of head liveness. 100 000 rows, one writer. */
    expect(engine.store.read((tx) => tx.head('attempt:hot').head)).toBe(100_000)
    expect(engine.store.read((tx) => tx.head('fleet').head)).toBe(100)
    expect(elapsed).toBeLessThan(60_000)

    /* `fleet` was never dropped and never paused; `attempt:*` was dropped, explicitly. */
    expect(connection.counters.dropped).toBeGreaterThan(0)
    expect(connection.streams.some((s) => s.stream === 'fleet')).toBe(true)
    expect(connection.streams.some((s) => s.stream === 'attempt:hot')).toBe(false)
    unsubscribe()
    connection.close(1_000, 'done')
  })

  it('the unacked window pauses `attempt:*` and an `ack` releases it — `fleet` is never paused', async () => {
    const h = await serve()
    const engine = h.server.engine
    const sent: ServerFrame[] = []
    const connection = new SwarmConnection({
      id: 'windowed',
      socket: {
        send: (text) => sent.push(JSON.parse(text) as ServerFrame),
        close: () => undefined,
        bufferedAmount: () => 0,
      },
      engine,
      token: {
        tokenId: 't',
        hash: '',
        clientName: 'w',
        clientKind: 'test',
        issuedAt: 0,
        revokedAt: null,
      },
      serverVersion: '0.1.0',
      autoHeartbeat: false,
    })
    const unsubscribe = engine.store.onCommit((result) => {
      for (const record of result.emitted) connection.deliver(record)
    })
    await connection.receive(
      JSON.stringify({ p: 'swarm', v: 1, k: 'hello', client: 'w', head: 'test', minV: 1, maxV: 1 }),
    )
    await connection.receive(
      JSON.stringify({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'attempt:w', from: 0 }),
    )
    await connection.receive(
      JSON.stringify({ p: 'swarm', v: 1, k: 'sub', id: 2, stream: 'fleet', from: 0 }),
    )

    driveAttempt(h, 'w', BACKPRESSURE.unackedWindow + 40)
    driveFleetNotice(h, 5)

    const attemptFrames = sent.filter(isEvt).filter((f) => f.stream === 'attempt:w')
    const fleetFrames = sent.filter(isEvt).filter((f) => f.stream === 'fleet')
    expect(attemptFrames.length).toBeLessThanOrEqual(BACKPRESSURE.unackedWindow)
    /* Never paused, whatever the head is doing — the fleet is how a user learns who needs them. */
    expect(fleetFrames).toHaveLength(5)

    await connection.receive(
      JSON.stringify({
        p: 'swarm',
        v: 1,
        k: 'ack',
        stream: 'attempt:w',
        seq: BACKPRESSURE.unackedWindow,
      }),
    )
    const afterAck = sent.filter(isEvt).filter((f) => f.stream === 'attempt:w')
    expect(afterAck.length).toBeGreaterThan(attemptFrames.length)

    /* §2.4's coalescing: `att.text` merged while paused, ORDER preserved, LAST seq kept — and
     * the log still holds them unmerged, so replay is exact. */
    const last = afterAck[afterAck.length - 1]!
    expect(last.seq).toBe(BACKPRESSURE.unackedWindow + 40)
    expect(engine.store.read((tx) => tx.readLog('attempt:w', 0, 10_000)).length).toBe(
      BACKPRESSURE.unackedWindow + 40,
    )
    unsubscribe()
    connection.close(1_000, 'done')
  })
})

describe('§2.4/§2.5 heartbeat and the close codes', () => {
  it('pings at 15 s idle and closes 4008 after 30 s of silence', async () => {
    const h = await serve()
    let clock = 1_000
    const sent: ServerFrame[] = []
    let closedWith = 0
    const connection = new SwarmConnection({
      id: 'quiet',
      socket: {
        send: (text) => sent.push(JSON.parse(text) as ServerFrame),
        close: (code) => {
          closedWith = code
        },
        bufferedAmount: () => 0,
      },
      engine: h.server.engine,
      token: {
        tokenId: 't',
        hash: '',
        clientName: 'q',
        clientKind: 'test',
        issuedAt: 0,
        revokedAt: null,
      },
      serverVersion: '0.1.0',
      now: () => clock,
      autoHeartbeat: false,
    })
    await connection.receive(
      JSON.stringify({ p: 'swarm', v: 1, k: 'hello', client: 'q', head: 'test', minV: 1, maxV: 1 }),
    )

    clock += HEARTBEAT.serverPingMs
    connection.heartbeat()
    expect(sent.filter((frame) => frame.k === 'ping')).toHaveLength(1)

    clock += HEARTBEAT.deadMs
    connection.heartbeat()
    expect(closedWith).toBe(CLOSE_CODES.heartbeat)
  })

  it('shutdown sends `bye{retryAfterMs}` and closes 4013 — which suppresses the retry', async () => {
    const h = await serve()
    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    await socket.hello()
    await h.server.close()
    const bye = await socket.waitFor((frame) => frame.k === 'bye')
    expect(bye).toMatchObject({ k: 'bye', retryAfterMs: 1_000 })
    expect((await socket.waitForClose()).code).toBe(CLOSE_CODES.shuttingDown)
    /* `dispose()` is safe to call twice; the second close is a no-op. */
  })
})

describe('§3.5 write ordering — persist → emit → reply', () => {
  it('the `res` for an intent is written after the record is durable AND after the fan-out', async () => {
    const h = await serve()
    const seen: string[] = []
    const unsubscribe = h.server.engine.store.onCommit((result) => {
      for (const record of result.emitted) seen.push(`emit:${record.ev.k}`)
    })

    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    await socket.hello()
    socket.send({
      p: 'swarm',
      v: 1,
      k: 'req',
      id: 1,
      intent: 'createDelegation',
      args: {
        idempotencyKey: 'idem-order',
        spec: {
          specVersion: 1,
          objective: 'order matters',
          acceptance: [],
          workspace: { workspaceId: h.repo.registration.workspaceId, baseRef: 'HEAD' },
          model: { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: null },
          budget: {
            maxWallMs: 1_000,
            maxTurns: 1,
            maxToolCalls: 1,
            maxInputTokens: 1,
            maxOutputTokens: 1,
            onBreach: 'pause-dispatch',
          },
          execution: { nativeSwarm: false, jcodeMemory: false, autoPoke: false, skills: [] },
          context: [],
          delivery: { mode: 'after-turn', notify: 'silent' },
          parallelAttempts: 1,
        },
      },
      idempotencyKey: 'idem-order',
    })
    const res = await socket.waitFor((frame) => frame.k === 'res')
    seen.push('reply')
    await settle(2)

    expect(seen.includes('emit:fleet.delegation_created')).toBe(true)
    expect(seen.indexOf('emit:fleet.delegation_created')).toBeLessThan(seen.indexOf('reply'))
    expect((res as { data: unknown }).data).toBeTruthy()
    unsubscribe()
    socket.close()
  })
})

describe('§2.4 — the frame half of the queue rule, and the bound on the paused buffer', () => {
  /**
   * `write()` used to increment `queuedBytes`/`queuedFrames` and decrement them again on the next
   * synchronous line, so `queuedFrames` was permanently 0 and `overQueueLimit()` reduced to the
   * byte test alone: the "4 000 frames" half of §2.4's table could not fire under any load.
   */
  it('a backlog of frames on a socket whose bytes never breach still drops `attempt:*`', async () => {
    const h = await serve()
    const engine = h.server.engine
    let sent = 0
    const connection = new SwarmConnection({
      id: 'frames',
      socket: {
        send: () => {
          sent += 1
        },
        close: () => undefined,
        /* One byte outstanding, forever: a socket that never drains and never breaches 4 MiB. */
        bufferedAmount: () => 1,
      },
      engine,
      token: {
        tokenId: 't',
        hash: '',
        clientName: 'f',
        clientKind: 'test',
        issuedAt: 0,
        revokedAt: null,
      },
      serverVersion: '0.1.0',
      autoHeartbeat: false,
    })
    const unsubscribe = engine.store.onCommit((result) => {
      for (const record of result.emitted) connection.deliver(record)
    })
    await connection.receive(
      JSON.stringify({ p: 'swarm', v: 1, k: 'hello', client: 'f', head: 'test', minV: 1, maxV: 1 }),
    )
    await connection.receive(
      JSON.stringify({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'attempt:frames', from: 0 }),
    )

    /* Acked as it goes, so the unacked window never pauses and the queue rule is the only one left. */
    for (let batch = 0; batch < 12; batch++) {
      driveAttempt(h, 'frames', 500)
      await connection.receive(
        JSON.stringify({
          p: 'swarm',
          v: 1,
          k: 'ack',
          stream: 'attempt:frames',
          seq: engine.store.read((tx) => tx.head('attempt:frames').head),
        }),
      )
    }

    expect(sent).toBeGreaterThan(BACKPRESSURE.queueFrames)
    expect(connection.counters.dropped).toBeGreaterThan(0)
    expect(connection.streams.some((s) => s.stream === 'attempt:frames')).toBe(false)
    unsubscribe()
    connection.close(1_000, 'done')
  })

  it('the paused coalescing buffer is capped: a head that stops acking is lagged, not remembered', async () => {
    const h = await serve()
    const engine = h.server.engine
    const frames: ServerFrame[] = []
    const connection = new SwarmConnection({
      id: 'hoarder',
      socket: {
        send: (text) => frames.push(JSON.parse(text) as ServerFrame),
        close: () => undefined,
        bufferedAmount: () => 0,
      },
      engine,
      token: {
        tokenId: 't',
        hash: '',
        clientName: 'h',
        clientKind: 'test',
        issuedAt: 0,
        revokedAt: null,
      },
      serverVersion: '0.1.0',
      autoHeartbeat: false,
    })
    const unsubscribe = engine.store.onCommit((result) => {
      for (const record of result.emitted) connection.deliver(record)
    })
    await connection.receive(
      JSON.stringify({ p: 'swarm', v: 1, k: 'hello', client: 'h', head: 'test', minV: 1, maxV: 1 }),
    )
    await connection.receive(
      JSON.stringify({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'attempt:hoard', from: 0 }),
    )

    /* Non-delta events take one map entry each, keyed `${kind}:${seq}` — deltas coalesce, these do
     * not. No ack ever arrives, which is the failure §2.4 exists to prevent. */
    engine.store.commit((tx) => {
      for (let i = 0; i < BACKPRESSURE.unackedWindow + BACKPRESSURE.queueFrames + 50; i++) {
        tx.appendLog({
          stream: attemptStream('hoard'),
          ev: { k: 'att.tool', callId: `c${i}`, name: 'bash', target: null, status: 'start' },
          actor: { kind: 'server', reason: 'test' },
          attemptId: 'hoard',
        })
      }
    })

    expect(connection.counters.lagged).toBeGreaterThan(0)
    expect(frames.some((frame) => frame.k === 'lagged')).toBe(true)
    expect(connection.streams.some((s) => s.stream === 'attempt:hoard')).toBe(false)
    unsubscribe()
    connection.close(1_000, 'done')
  })
})
