/**
 * `protocolConformance()` — `swarm.v1` as executable cases (§2.2–§2.5, §6.4, §13).
 *
 * §13 requires it to "enumerate the **34** `SwarmEvent` kinds of §6.4 by name, assert each routes
 * to its declared stream, and assert the 34→projection onto `SwarmClientEvents` is total". Those
 * three, plus the codec's admission rules and the subscription contract, are the part of the
 * protocol that is decidable **without a server**, and they are all here.
 *
 * The connection-level rows of §13 — `hello` first or close 4004, snapshot/replay interleavings,
 * the 100 000-event backpressure drive — need a live server and join through the optional
 * harness parameter when the server stage lands. Calling `protocolConformance()` with no
 * argument runs everything that is decidable today.
 *
 * DOM-free and Node-free.
 */

import type { ClientFrame, ServerFrame } from '../protocol/frames.ts'
import type { SwarmClientEvents } from '../types.ts'
import type { ConformanceCase } from './types.ts'

import {
  attemptStream,
  decodeClientFrame,
  decodeServerFrame,
  delegationStream,
  encodeFrame,
  parseStreamName,
  resolveSubscription,
} from '../protocol/codec.ts'
import {
  BACKPRESSURE,
  CLOSE_CODES,
  HEARTBEAT,
  LIMITS,
  TERMINAL_CLOSE_CODES,
  isTerminalCloseCode,
} from '../protocol/constants.ts'
import {
  EVENT_PROJECTION,
  EVENT_STREAM_FAMILY,
  SWARM_EVENT_KINDS,
  TRANSPORT_ONLY_CLIENT_EVENTS,
  isSwarmEventKind,
  streamFamilyOf,
} from '../protocol/events.ts'
import { SWARM_PROTOCOL, SWARM_PROTOCOL_VERSION } from '../protocol/frames.ts'
import { SWARM_CLIENT_EVENT_KEYS } from '../types.ts'
import { assert, assertDeepEqual, assertEqual } from './assert.ts'
import { sampleEvent } from './fixtures.ts'

const envelope = { p: SWARM_PROTOCOL, v: SWARM_PROTOCOL_VERSION } as const

export function protocolConformance(): ConformanceCase[] {
  const cases: ConformanceCase[] = []
  const test = (name: string, run: () => void): void => {
    cases.push({
      name: `protocol: ${name}`,
      run: () => {
        run()
        return Promise.resolve()
      },
    })
  }

  /* ------------------------------------------------------------------ §6.4 the 34 kinds */

  test('the SwarmEvent union is exactly 34 kinds, each named once', () => {
    assertEqual(SWARM_EVENT_KINDS.length, 34, '§6.4 declares 34 kinds')
    assertEqual(
      new Set<string>(SWARM_EVENT_KINDS).size,
      34,
      'a duplicated kind would make the routing table ambiguous',
    )
  })

  test('every kind routes to its declared stream family (§2.3)', () => {
    const expected: Record<string, string> = {
      'server.': 'server',
      'fleet.': 'fleet',
      'deleg.': 'delegation',
      'att.': 'attempt',
    }
    for (const kind of SWARM_EVENT_KINDS) {
      const prefix = Object.keys(expected).find((p) => kind.startsWith(p))
      assert(prefix !== undefined, `kind ${kind} has no stream prefix`)
      assertEqual(
        streamFamilyOf(kind),
        expected[prefix],
        `${kind} must route to the ${expected[prefix]} stream`,
      )
      assertEqual(
        EVENT_STREAM_FAMILY[kind],
        streamFamilyOf(kind),
        'the table and the accessor agree',
      )
    }
  })

  test('the stream families carry the volumes §2.3 assigns them', () => {
    const counts = { server: 0, fleet: 0, delegation: 0, attempt: 0 }
    for (const kind of SWARM_EVENT_KINDS) counts[streamFamilyOf(kind)]++
    assertDeepEqual(
      counts,
      { server: 7, fleet: 6, delegation: 13, attempt: 8 },
      '§6.4 enumerates 7 + 6 + 13 + 8 = 34',
    )
  })

  test('every kind has a projection entry, and every event-derived client key is reachable', () => {
    const reachable = new Set<string>()
    for (const kind of SWARM_EVENT_KINDS) {
      const keys = EVENT_PROJECTION[kind]
      assert(Array.isArray(keys), `kind ${kind} has no projection entry — the map must be total`)
      for (const key of keys) reachable.add(key)
    }
    for (const key of TRANSPORT_ONLY_CLIENT_EVENTS) {
      assert(
        !reachable.has(key),
        `${key} is declared transport-only but a wire kind projects onto it`,
      )
      reachable.add(key)
    }
    assertDeepEqual(
      [...reachable].sort(),
      [...SWARM_CLIENT_EVENT_KEYS].sort(),
      'every SwarmClientEvents key must be reachable — a key nobody emits is a key nobody can use',
    )
  })

  test('projection targets are declared SwarmClientEvents keys', () => {
    const declared = new Set<string>(SWARM_CLIENT_EVENT_KEYS)
    for (const kind of SWARM_EVENT_KINDS) {
      for (const key of EVENT_PROJECTION[kind] as readonly (keyof SwarmClientEvents)[]) {
        assert(declared.has(key), `${kind} projects onto undeclared key ${String(key)}`)
      }
    }
  })

  test('ingest rejects an unknown event kind and accepts every declared one', () => {
    for (const kind of SWARM_EVENT_KINDS) {
      assert(isSwarmEventKind(kind), `${kind} must be accepted on ingest`)
    }
    assert(!isSwarmEventKind('deleg.telepathy'), 'an unknown kind is rejected on ingest (§3.5)')
    assert(!isSwarmEventKind(42), 'a non-string kind is rejected on ingest')
  })

  test('every sample event encodes and decodes through an evt frame unchanged', () => {
    for (const kind of SWARM_EVENT_KINDS) {
      const ev = sampleEvent(kind)
      const frame: ServerFrame = { ...envelope, k: 'evt', stream: 'fleet', seq: 1, ts: 7, ev }
      const decoded = decodeServerFrame(encodeFrame(frame))
      assert(decoded.ok, `evt{${kind}} must decode: ${decoded.ok ? '' : decoded.message}`)
      assertDeepEqual(decoded.frame, frame, `evt{${kind}} must round-trip byte-identically`)
    }
  })

  /* ------------------------------------------------------------------ §2.2 the envelope */

  test('p and v ride on every frame, and a mis-wired peer fails on frame 1', () => {
    const encoded = encodeFrame({
      ...envelope,
      k: 'hello',
      client: 'test/0.1',
      head: 'test',
      minV: 1,
      maxV: 1,
    })
    const parsed = JSON.parse(encoded) as Record<string, unknown>
    assertEqual(parsed.p, 'swarm', 'p is on every frame')
    assertEqual(parsed.v, 1, 'v is on every frame')

    const wrongProtocol = decodeClientFrame(JSON.stringify({ p: 'nope', v: 1, k: 'hello' }))
    assert(!wrongProtocol.ok && wrongProtocol.fatal, 'a wrong protocol closes 4004')
    assertEqual(
      wrongProtocol.ok ? '' : wrongProtocol.code,
      'bad_protocol',
      'and reports bad_protocol',
    )

    const wrongVersion = decodeClientFrame(JSON.stringify({ p: 'swarm', v: 2, k: 'hello' }))
    assert(!wrongVersion.ok && wrongVersion.fatal, 'a wrong version closes 4004')

    const notJson = decodeClientFrame('{ not json')
    assert(!notJson.ok && notJson.fatal, 'an unparseable frame closes 4004')
  })

  test('an unknown client frame kind errors WITHOUT closing the connection (§2.2)', () => {
    const result = decodeClientFrame(JSON.stringify({ ...envelope, k: 'telepathy' }))
    assert(!result.ok, 'an unknown kind must not decode')
    assertEqual(result.ok ? '' : result.code, 'unknown_frame', 'it is unknown_frame')
    assertEqual(result.ok ? true : result.fatal, false, 'and the connection survives')
  })

  test('an unknown SERVER frame kind is ignorable, not fatal — forward compatibility', () => {
    const result = decodeServerFrame(JSON.stringify({ ...envelope, k: 'from_the_future' }))
    assert(!result.ok, 'an unknown kind must not decode')
    assertEqual(result.ok ? true : result.fatal, false, 'the client ignores it and keeps talking')
  })

  test('every client frame kind round-trips', () => {
    const frames: ClientFrame[] = [
      { ...envelope, k: 'hello', client: 'ext/0.1', head: 'extension', minV: 1, maxV: 1 },
      {
        ...envelope,
        k: 'req',
        id: 1,
        intent: 'createDelegation',
        args: { title: 't' },
        idempotencyKey: 'idem-1',
      },
      { ...envelope, k: 'sub', id: 2, stream: 'fleet', from: 'snapshot' },
      { ...envelope, k: 'sub', id: 3, stream: delegationStream('d-1'), from: 12 },
      { ...envelope, k: 'unsub', stream: attemptStream('a-1') },
      { ...envelope, k: 'ack', stream: attemptStream('a-1'), seq: 128 },
      { ...envelope, k: 'ping', t: 1 },
      { ...envelope, k: 'pong', t: 2 },
    ]
    for (const frame of frames) {
      const decoded = decodeClientFrame(encodeFrame(frame))
      assert(decoded.ok, `${frame.k} must decode: ${decoded.ok ? '' : decoded.message}`)
      assertDeepEqual(decoded.frame, frame, `${frame.k} must round-trip`)
    }
  })

  test('every server frame kind round-trips', () => {
    const frames: ServerFrame[] = [
      {
        ...envelope,
        k: 'hello_ok',
        server: 'swarm',
        serverVersion: '0.1.0',
        connectionId: 'c-1',
        capabilities: ['replay', 'snapshot'],
        serverTimeMs: 100,
      },
      { ...envelope, k: 'res', id: 1, data: { from: 12 } },
      {
        ...envelope,
        k: 'err',
        id: 1,
        code: 'turn_in_flight',
        message: 'a turn is in flight',
        retryable: true,
      },
      { ...envelope, k: 'snap', id: 2, stream: 'fleet', seq: 9, state: { buckets: {} } },
      { ...envelope, k: 'evt', stream: 'fleet', seq: 10, ts: 5, ev: sampleEvent('fleet.caps') },
      {
        ...envelope,
        k: 'lagged',
        stream: attemptStream('a-1'),
        fromSeq: 3,
        reason: 'backpressure',
      },
      { ...envelope, k: 'ping', t: 1 },
      { ...envelope, k: 'bye', reason: 'shutting down', retryAfterMs: 5000 },
    ]
    for (const frame of frames) {
      const decoded = decodeServerFrame(encodeFrame(frame))
      assert(decoded.ok, `${frame.k} must decode: ${decoded.ok ? '' : decoded.message}`)
      assertDeepEqual(decoded.frame, frame, `${frame.k} must round-trip`)
    }
  })

  test('an err frame naming an unknown code is refused', () => {
    const result = decodeServerFrame(
      JSON.stringify({
        ...envelope,
        k: 'err',
        id: null,
        code: 'nope',
        message: 'x',
        retryable: false,
      }),
    )
    assert(!result.ok, 'the error code union is closed on the wire too (§9)')
  })

  /* -------------------------------------------------------------------- §2.2 stream names */

  test('stream names are validated by shape; an unroutable one is stream_unknown', () => {
    assertDeepEqual(parseStreamName('server'), { family: 'server', id: null }, 'server parses')
    assertDeepEqual(parseStreamName('fleet'), { family: 'fleet', id: null }, 'fleet parses')
    assertDeepEqual(
      parseStreamName('delegation:d-1'),
      { family: 'delegation', id: 'd-1' },
      'delegation:<id> parses',
    )
    assertDeepEqual(
      parseStreamName('attempt:a-1'),
      { family: 'attempt', id: 'a-1' },
      'attempt:<id> parses',
    )
    assertEqual(parseStreamName('delegation:'), null, 'an empty id is not a stream')
    assertEqual(parseStreamName('nope'), null, 'an unknown family is not a stream')

    const result = decodeClientFrame(
      JSON.stringify({ ...envelope, k: 'sub', id: 1, stream: 'nope', from: 'snapshot' }),
    )
    assert(!result.ok, 'an unroutable stream must not decode')
    assertEqual(result.ok ? '' : result.code, 'stream_unknown', 'it yields stream_unknown (§2.2)')
  })

  /* --------------------------------------------------------- §2.3 subscription and replay */

  test("sub{from:'snapshot'} plans a snapshot", () => {
    assertDeepEqual(
      resolveSubscription('snapshot', { head: 10, floor: 0 }),
      { kind: 'snapshot' },
      "'snapshot' is always available; it is the recovery every lag points at",
    )
  })

  test('sub{from:n} inside the window replays from n + 1', () => {
    assertDeepEqual(
      resolveSubscription(4, { head: 10, floor: 2 }),
      { kind: 'replay', fromExclusive: 4 },
      'replay is exclusive of the cursor, so nothing is delivered twice',
    )
    assertDeepEqual(
      resolveSubscription(10, { head: 10, floor: 2 }),
      { kind: 'replay', fromExclusive: 10 },
      'a cursor exactly at the head is caught up, not an error',
    )
  })

  test('sub{from:n} below the floor yields lagged, never a shortened replay', () => {
    assertDeepEqual(
      resolveSubscription(1, { head: 10, floor: 4 }, 'retention'),
      { kind: 'lagged', fromSeq: 1, reason: 'retention' },
      'a gap observed by a client is a bug; lag is always explicit (§2.3)',
    )
  })

  test('sub{from:n} above the head is bad_cursor', () => {
    assertDeepEqual(
      resolveSubscription(11, { head: 10, floor: 0 }),
      { kind: 'error', code: 'bad_cursor' },
      'a cursor from the future is a bug in the head, not a lag',
    )
    assertDeepEqual(
      resolveSubscription(-1, { head: 10, floor: 0 }),
      { kind: 'error', code: 'bad_cursor' },
      'a negative cursor is not a cursor',
    )
    assertDeepEqual(
      resolveSubscription(1.5, { head: 10, floor: 0 }),
      { kind: 'error', code: 'bad_cursor' },
      'a fractional cursor is not a cursor',
    )
  })

  /* ---------------------------------------------------------------------- §2.4 the caps */

  test('a frame over 1 MiB is refused with frame_too_large', () => {
    const oversize = JSON.stringify({
      ...envelope,
      k: 'req',
      id: 1,
      intent: 'sendTurn',
      idempotencyKey: 'idem-1',
      args: { text: 'x'.repeat(LIMITS.frameBytes) },
    })
    const result = decodeClientFrame(oversize)
    assert(!result.ok, 'an oversize frame must not decode')
    assertEqual(result.ok ? '' : result.code, 'frame_too_large', 'it is frame_too_large (§2.4)')
  })

  test('the §2.4 limits are the numbers the spec names', () => {
    assertEqual(LIMITS.frameBytes, 1024 * 1024, 'frame cap is 1 MiB')
    assertEqual(LIMITS.imageBytesPerImage, 700 * 1024, '700 KB decoded per image')
    assertEqual(LIMITS.imageBytesPerTurn, 700 * 1024, '700 KB decoded per turn')
    assertEqual(BACKPRESSURE.queueBytes, 4 * 1024 * 1024, 'outbound queue is 4 MiB')
    assertEqual(BACKPRESSURE.queueFrames, 4_000, 'or 4 000 frames')
    assertEqual(BACKPRESSURE.unackedWindow, 512, 'unacked window is 512 frames')
    assertEqual(BACKPRESSURE.ackEveryFrames, 128, 'ack every 128 frames')
    assertEqual(BACKPRESSURE.ackEveryMs, 1_000, 'or every second')
    assert(
      LIMITS.imageBytesPerTurn * (4 / 3) < LIMITS.frameBytes,
      'the image cap is DERIVED from the frame cap plus base64 inflation — it must still fit',
    )
  })

  test('the §2.4 heartbeat is 15 s / 20 s / 30 s', () => {
    assertEqual(HEARTBEAT.serverPingMs, 15_000, 'server pings at 15 s idle')
    assertEqual(HEARTBEAT.clientPingMs, 20_000, 'client pings at 20 s idle')
    assertEqual(HEARTBEAT.deadMs, 30_000, 'no pong and no frame within 30 s is fatal')
    assert(
      HEARTBEAT.serverPingMs < HEARTBEAT.clientPingMs,
      'the server must lead, or both peers ping on top of each other',
    )
  })

  /* ------------------------------------------------------------------ §2.5 close codes */

  test('the close codes are 4001/4003/4004/4008/4009/4013 and three are terminal', () => {
    assertDeepEqual(
      CLOSE_CODES,
      {
        unauthenticated: 4001,
        forbidden: 4003,
        protocol: 4004,
        heartbeat: 4008,
        backpressure: 4009,
        shuttingDown: 4013,
      },
      '§2.5 rule 4',
    )
    assertDeepEqual(
      [...TERMINAL_CLOSE_CODES],
      [4001, 4003, 4004],
      'unauthenticated, forbidden and protocol are terminal — the client stops and surfaces a fix',
    )
    assert(!isTerminalCloseCode(4008), 'a heartbeat close is retried, not surfaced as a dead end')
    assert(!isTerminalCloseCode(4013), 'a shutdown close is retried after retryAfterMs')
  })

  return cases
}
