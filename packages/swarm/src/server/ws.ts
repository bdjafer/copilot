/**
 * One WebSocket connection: admission, frames, subscriptions, backpressure and heartbeat
 * (SPEC-swarm §2.1–§2.5).
 *
 * **Connections hold zero resumable state** (§2.3, decision log #5). Everything a head needs to
 * resume is in the durable log, keyed by `(stream, seq)`; a connection owns only a cursor, an
 * outbound queue and two timers. A head offline for a day resumes with `from:<lastSeq>` and
 * receives everything, in order, exactly once — the property jcode's protocol cannot provide at
 * all, and one this class is careful never to acquire state that would break.
 *
 * **Only `attempt:*` degrades** (§2.4, Q12). The transcript is evidence, not the product:
 * `server`, `fleet` and `delegation:*` are never paused and never dropped, so a head that is
 * behind still learns *which delegation needs it* — the thing the fleet exists to answer. When
 * the outbound queue breaches, the highest-volume subscribed `attempt:*` is dropped with an
 * explicit `lagged{reason:'backpressure'}`; a silent drop would make a gap indistinguishable from
 * a bug, and §2.3 forbids gaps.
 *
 * Node ≥ 24, server-only.
 */

import type { LogRecord } from '../log/types.ts'
import type { SwarmEvent } from '../protocol/events.ts'
import type { ClientFrame, ServerCapability, ServerFrame, StreamName } from '../protocol/frames.ts'
import type { ActorRef, HeadKind } from '../types.ts'
import type { SwarmEngine } from './engine.ts'
import type { TokenRecord } from './tokens.ts'

import { SwarmError } from '../errors.ts'
import {
  decodeClientFrame,
  encodeFrame,
  parseStreamName,
  resolveSubscription,
  utf8ByteLength,
} from '../protocol/codec.ts'
import { BACKPRESSURE, CLOSE_CODES, HEARTBEAT } from '../protocol/constants.ts'

/** The capabilities this server advertises in `hello_ok` (§2.2). */
export const SERVER_CAPABILITY_SET: readonly ServerCapability[] = [
  'replay',
  'snapshot',
  'landing',
  'verify',
  'structured',
  'images',
  'parallel-attempts',
  'confirmations',
  /* `approvals` is deliberately absent: it ships dark until the runtime probe flips (R6, #14). */
]

/** The socket seam, so a connection can be driven by `ws` or by an in-process pipe alike. */
export interface ConnectionSocket {
  send(text: string): void
  close(code: number, reason: string): void
  /** Bytes still queued in the transport; feeds the outbound-queue rule of §2.4. */
  bufferedAmount(): number
}

export interface ConnectionOptions {
  readonly id: string
  readonly socket: ConnectionSocket
  readonly engine: SwarmEngine
  readonly token: TokenRecord
  readonly serverVersion: string
  readonly now?: () => number
  /** `false` in tests: heartbeats are then driven by explicit `heartbeat()` calls. */
  readonly autoHeartbeat?: boolean
}

interface Subscription {
  readonly stream: StreamName
  /** The highest `seq` written to this connection. Never a resumable identity — just a cursor. */
  cursor: number
  /** The highest `seq` the head acknowledged; `cursor - acked` is the unacked window. */
  acked: number
  paused: boolean
  /** Frames merged while paused, in order, with the **last** `seq` kept (§2.4). */
  coalesced: Map<string, { seq: number; ev: SwarmEvent; ts: number }>
  queuedFrames: number
}

export class SwarmConnection {
  readonly id: string
  private readonly socket: ConnectionSocket
  private readonly engine: SwarmEngine
  private readonly token: TokenRecord
  private readonly now: () => number
  private readonly subscriptions = new Map<StreamName, Subscription>()
  private head: HeadKind = 'test'
  private helloed = false
  private clientName = ''
  private closedAt: number | null = null
  private lastSeenAt: number
  private lastPingAt = 0
  private queuedBytes = 0
  private queuedFrames = 0
  private timer: ReturnType<typeof setInterval> | null = null
  /** Counters `/debug/streams` and `/metrics` report (§7.4). */
  readonly counters = { dropped: 0, lagged: 0, sent: 0, errors: 0 }

  constructor(private readonly options: ConnectionOptions) {
    this.id = options.id
    this.socket = options.socket
    this.engine = options.engine
    this.token = options.token
    this.now = options.now ?? Date.now
    this.lastSeenAt = this.now()
    if (options.autoHeartbeat !== false) {
      this.timer = setInterval(() => this.heartbeat(), 5_000)
      this.timer.unref?.()
    }
  }

  get closed(): boolean {
    return this.closedAt !== null
  }

  get actor(): ActorRef {
    return { kind: 'user', head: this.head, tokenId: this.token.tokenId }
  }

  get streams(): readonly { stream: StreamName; seq: number; lagged: boolean }[] {
    return [...this.subscriptions.values()].map((s) => ({
      stream: s.stream,
      seq: s.cursor,
      lagged: s.paused,
    }))
  }

  /* ------------------------------------------------------------------------------ ingress */

  async receive(text: string): Promise<void> {
    this.lastSeenAt = this.now()
    const decoded = decodeClientFrame(text)
    if (!decoded.ok) {
      if (decoded.fatal) {
        this.close(CLOSE_CODES.protocol, decoded.message)
        return
      }
      this.counters.errors += 1
      this.write({
        p: 'swarm',
        v: 1,
        k: 'err',
        id: null,
        code: decoded.code,
        message: decoded.message,
        retryable: false,
      })
      return
    }
    const frame = decoded.frame
    /* §2.2: `hello` MUST be the first client frame; anything else closes 4004. */
    if (!this.helloed && frame.k !== 'hello') {
      this.close(CLOSE_CODES.protocol, 'hello must be the first frame')
      return
    }
    await this.handle(frame)
  }

  private async handle(frame: ClientFrame): Promise<void> {
    switch (frame.k) {
      case 'hello': {
        if (this.helloed) {
          this.close(CLOSE_CODES.protocol, 'hello was already sent')
          return
        }
        this.helloed = true
        this.head = frame.head
        this.clientName = frame.client
        this.write({
          p: 'swarm',
          v: 1,
          k: 'hello_ok',
          server: 'swarm',
          serverVersion: this.options.serverVersion,
          connectionId: this.id,
          capabilities: SERVER_CAPABILITY_SET,
          serverTimeMs: this.now(),
        })
        return
      }
      case 'req': {
        const result = await this.engine.dispatch(frame.intent, frame.args, {
          actor: this.actor,
          tokenId: this.token.tokenId,
          idempotencyKey: frame.idempotencyKey,
          ...(frame.expectedVersion === undefined
            ? {}
            : { expectedVersion: frame.expectedVersion }),
        })
        if (result.ok) {
          this.write({ p: 'swarm', v: 1, k: 'res', id: frame.id, data: result.value })
        } else {
          this.counters.errors += 1
          this.write({
            p: 'swarm',
            v: 1,
            k: 'err',
            id: frame.id,
            code: result.error.code,
            message: result.error.message,
            retryable: result.error.retryable,
            ...(result.error.details === undefined ? {} : { details: result.error.details }),
          })
        }
        return
      }
      case 'sub':
        this.subscribe(frame.id, frame.stream, frame.from)
        return
      case 'unsub':
        this.subscriptions.delete(frame.stream)
        return
      case 'ack': {
        const subscription = this.subscriptions.get(frame.stream)
        if (subscription === undefined) return
        subscription.acked = Math.max(subscription.acked, frame.seq)
        if (
          subscription.paused &&
          subscription.cursor - subscription.acked < BACKPRESSURE.unackedWindow
        ) {
          subscription.paused = false
          this.flushCoalesced(subscription)
        }
        return
      }
      case 'ping':
        this.write({ p: 'swarm', v: 1, k: 'pong', t: frame.t })
        return
      case 'pong':
        return
    }
  }

  /**
   * §2.3. `from:'snapshot'` reads the state and the cursor in **one** transaction, so no event is
   * both in the snapshot and re-delivered after it; `from:n` below the floor yields `lagged` and
   * never a quietly-shortened replay, because a gap observed by a client is a bug, not a lag.
   */
  private subscribe(id: number, stream: StreamName, from: 'snapshot' | number): void {
    const parsed = parseStreamName(stream)
    if (parsed === null) {
      this.write({
        p: 'swarm',
        v: 1,
        k: 'err',
        id,
        code: 'stream_unknown',
        message: `unroutable stream ${stream}`,
        retryable: false,
      })
      return
    }
    const bounds = this.engine.store.read((tx) => tx.head(stream))
    const plan = resolveSubscription(from, bounds)

    switch (plan.kind) {
      case 'snapshot': {
        const snapshot = this.engine.snapshot(stream)
        this.subscriptions.set(stream, newSubscription(stream, snapshot.seq))
        this.write({
          p: 'swarm',
          v: 1,
          k: 'snap',
          id,
          stream,
          seq: snapshot.seq,
          state: snapshot.state,
        })
        return
      }
      case 'replay': {
        this.subscriptions.set(stream, newSubscription(stream, plan.fromExclusive))
        this.write({ p: 'swarm', v: 1, k: 'res', id, data: { from: plan.fromExclusive } })
        this.replay(stream, plan.fromExclusive)
        return
      }
      case 'lagged': {
        this.counters.lagged += 1
        this.write({
          p: 'swarm',
          v: 1,
          k: 'lagged',
          stream,
          fromSeq: plan.fromSeq,
          reason: plan.reason,
        })
        return
      }
      case 'error': {
        this.write({
          p: 'swarm',
          v: 1,
          k: 'err',
          id,
          code: plan.code,
          message: 'cursor is ahead of the stream head',
          retryable: false,
        })
        return
      }
    }
  }

  private replay(stream: StreamName, fromExclusive: number): void {
    let cursor = fromExclusive
    for (;;) {
      const batch = this.engine.store.read((tx) => tx.readLog(stream, cursor, 256))
      if (batch.length === 0) return
      for (const record of batch) this.deliver(record)
      cursor = batch[batch.length - 1]!.seq
    }
  }

  /* ------------------------------------------------------------------------------- egress */

  /** Called for every committed log record; the connection decides whether it is subscribed. */
  deliver(record: LogRecord): void {
    const subscription = this.subscriptions.get(record.stream)
    if (subscription === undefined || this.closed) return
    if (record.seq <= subscription.cursor) return

    const parsed = parseStreamName(record.stream)
    const degradable = parsed?.family === 'attempt'

    if (degradable) {
      /* §2.4: the unacked window pauses `attempt:*` for this connection until an `ack`. It never
       * pauses `fleet`/`delegation:*`/`server`, whatever the head is doing. */
      if (subscription.cursor - subscription.acked >= BACKPRESSURE.unackedWindow) {
        subscription.paused = true
      }
      if (subscription.paused) {
        this.coalesce(subscription, record)
        return
      }
      if (this.overQueueLimit()) {
        this.dropHighestVolumeAttempt(record.stream)
        return
      }
    }

    subscription.cursor = record.seq
    subscription.queuedFrames += 1
    this.write({
      p: 'swarm',
      v: 1,
      k: 'evt',
      stream: record.stream,
      seq: record.seq,
      ts: record.ts,
      ev: record.ev,
    })
  }

  /**
   * §2.4's coalescing rule: `text.delta`/`reasoning.delta` may merge in the outbound queue while
   * paused, **order preserved, last `seq` kept**. The log retains them unmerged, so replay is
   * exact — the merge is a rendering economy, never a loss of history.
   */
  private coalesce(subscription: Subscription, record: LogRecord): void {
    const kind = record.ev.k
    if (kind === 'att.text' || kind === 'att.reasoning') {
      const existing = subscription.coalesced.get(kind)
      const text = (record.ev as { text: string }).text
      subscription.coalesced.set(kind, {
        seq: record.seq,
        ts: record.ts,
        ev: {
          k: kind,
          text: existing === undefined ? text : `${(existing.ev as { text: string }).text}${text}`,
        } as SwarmEvent,
      })
      return
    }
    subscription.coalesced.set(`${kind}:${record.seq}`, {
      seq: record.seq,
      ts: record.ts,
      ev: record.ev,
    })
  }

  private flushCoalesced(subscription: Subscription): void {
    const pending = [...subscription.coalesced.values()].sort((a, b) => a.seq - b.seq)
    subscription.coalesced.clear()
    for (const entry of pending) {
      subscription.cursor = Math.max(subscription.cursor, entry.seq)
      this.write({
        p: 'swarm',
        v: 1,
        k: 'evt',
        stream: subscription.stream,
        seq: entry.seq,
        ts: entry.ts,
        ev: entry.ev,
      })
    }
  }

  private overQueueLimit(): boolean {
    return (
      this.queuedBytes + this.socket.bufferedAmount() > BACKPRESSURE.queueBytes ||
      this.queuedFrames > BACKPRESSURE.queueFrames
    )
  }

  /**
   * The breach action of §2.4: drop the **highest-volume subscribed `attempt:*`** and say so.
   * Explicit, because lag is always explicit — the client MUST re-subscribe from a snapshot.
   */
  private dropHighestVolumeAttempt(incoming: StreamName): void {
    let victim: Subscription | null = null
    for (const subscription of this.subscriptions.values()) {
      if (parseStreamName(subscription.stream)?.family !== 'attempt') continue
      if (victim === null || subscription.queuedFrames > victim.queuedFrames) {
        victim = subscription
      }
    }
    const target = victim ?? this.subscriptions.get(incoming) ?? null
    if (target === null) return
    this.counters.dropped += 1
    this.counters.lagged += 1
    this.subscriptions.delete(target.stream)
    this.write({
      p: 'swarm',
      v: 1,
      k: 'lagged',
      stream: target.stream,
      fromSeq: target.cursor,
      reason: 'backpressure',
    })
  }

  write(frame: ServerFrame): void {
    if (this.closed) return
    const text = encodeFrame(frame)
    const bytes = utf8ByteLength(text)
    this.queuedBytes += bytes
    this.queuedFrames += 1
    this.counters.sent += 1
    try {
      this.socket.send(text)
    } catch {
      this.close(CLOSE_CODES.backpressure, 'socket write failed')
      return
    }
    this.queuedBytes -= bytes
    this.queuedFrames -= 1
  }

  /** §2.4: server ping at 15 s idle; no `pong` and no frame within 30 s ⇒ close **4008**. */
  heartbeat(at = this.now()): void {
    if (this.closed) return
    if (at - this.lastSeenAt >= HEARTBEAT.deadMs) {
      this.close(CLOSE_CODES.heartbeat, 'no frame within 30 s')
      return
    }
    if (
      at - this.lastSeenAt >= HEARTBEAT.serverPingMs &&
      at - this.lastPingAt >= HEARTBEAT.serverPingMs
    ) {
      this.lastPingAt = at
      this.write({ p: 'swarm', v: 1, k: 'ping', t: at })
    }
  }

  /** §2.5: `bye{retryAfterMs}` pairs with close **4013** and suppresses the in-flight retry. */
  shutdown(retryAfterMs: number): void {
    this.write({ p: 'swarm', v: 1, k: 'bye', reason: 'shutting down', retryAfterMs })
    this.close(CLOSE_CODES.shuttingDown, 'shutting down')
  }

  close(code: number, reason: string): void {
    if (this.closed) return
    this.closedAt = this.now()
    if (this.timer !== null) clearInterval(this.timer)
    try {
      this.socket.close(code, reason)
    } catch {
      /* a socket that cannot be closed is already gone */
    }
  }

  inspect(): Record<string, unknown> {
    return {
      id: this.id,
      client: this.clientName,
      head: this.head,
      tokenId: this.token.tokenId,
      streams: this.streams,
      counters: this.counters,
    }
  }
}

function newSubscription(stream: StreamName, cursor: number): Subscription {
  return {
    stream,
    cursor,
    acked: cursor,
    paused: false,
    coalesced: new Map(),
    queuedFrames: 0,
  }
}

/* ------------------------------------------------------------------------------- admission */

export interface AdmissionInput {
  readonly protocols: readonly string[]
  readonly origin: string | undefined
  readonly host: string | undefined
  readonly port: number
  readonly allowedOrigins: readonly string[]
  readonly verify: (token: string) => TokenRecord | null
}

export type AdmissionOutcome =
  | { readonly ok: true; readonly token: TokenRecord; readonly protocol: string }
  | {
      readonly ok: false
      readonly close: number
      readonly httpStatus: number
      readonly reason: string
    }

const SUBPROTOCOL = 'swarm.v1'
const TOKEN_PREFIX = 'swarm.tok.'

/**
 * §2.1's admission table, in its order.
 *
 * The token rides in a **subprotocol**, never a query parameter (S4): query strings land in
 * server logs, browser history and referrers. `Host` must be a literal loopback authority, which
 * is what defeats DNS rebinding — a page on any domain can resolve that domain to `127.0.0.1` and
 * reach this server, and only the `Host` check notices.
 */
export function admit(input: AdmissionInput): AdmissionOutcome {
  if (!input.protocols.includes(SUBPROTOCOL)) {
    return { ok: false, close: CLOSE_CODES.protocol, httpStatus: 400, reason: 'swarm.v1 required' }
  }
  if (!hostAllowed(input.host, input.port)) {
    return {
      ok: false,
      close: CLOSE_CODES.forbidden,
      httpStatus: 403,
      reason: 'Host must be a literal loopback authority',
    }
  }
  if (!originAllowed(input.origin, input.allowedOrigins)) {
    return {
      ok: false,
      close: CLOSE_CODES.forbidden,
      httpStatus: 403,
      reason: 'Origin is not in the allowlist',
    }
  }
  const carrier = input.protocols.find((p) => p.startsWith(TOKEN_PREFIX))
  if (carrier === undefined) {
    return {
      ok: false,
      close: CLOSE_CODES.unauthenticated,
      httpStatus: 401,
      reason: 'swarm.tok.<token> subprotocol is required (S4)',
    }
  }
  const token = input.verify(carrier.slice(TOKEN_PREFIX.length))
  if (token === null) {
    return {
      ok: false,
      close: CLOSE_CODES.unauthenticated,
      httpStatus: 401,
      reason: 'unknown or revoked token',
    }
  }
  /* The server echoes **exactly** `swarm.v1` — never the token subprotocol, which would put the
   * credential into the response headers of every handshake. */
  return { ok: true, token, protocol: SUBPROTOCOL }
}

export function hostAllowed(host: string | undefined, port: number): boolean {
  if (host === undefined) return false
  return (
    host === `127.0.0.1:${port}` ||
    host === `localhost:${port}` ||
    host === `[::1]:${port}` ||
    host === '127.0.0.1' ||
    host === 'localhost'
  )
}

/** Absent is allowed (a CLI or Node head sends none); present must be on the list. */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined || origin.length === 0) return true
  if (allowed.includes(origin)) return true
  if (origin.startsWith('chrome-extension://') && allowed.some((a) => a === origin)) return true
  return /^http:\/\/localhost(:\d+)?$/.test(origin) || /^http:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)
}

export function errorFrame(id: number | null, error: SwarmError): ServerFrame {
  return {
    p: 'swarm',
    v: 1,
    k: 'err',
    id,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.details === undefined ? {} : { details: error.details }),
  }
}
