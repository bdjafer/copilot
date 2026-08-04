/**
 * The connection state machine: handshake, backoff, heartbeat and close-code policy
 * (SPEC-swarm §2.1, §2.2, §2.4, §2.5).
 *
 * Five states — `idle`, `connecting`, `connected`, `reconnecting`, `blocked` (§6.2's
 * `ConnectionVM.status`) — and one rule that shapes all of them: **`4001`, `4003` and `4004` are
 * terminal** (§2.5 rule 4). A revoked token, a rebound `Host` and a mis-wired peer are not
 * transient, and a client that retries them forever becomes a reconnect loop that never tells the
 * user which of the three it is. `blocked` carries the reason so a head can render the fix.
 *
 * Everything above the socket is the transport's (H7). The contract this module assumes of it,
 * and which every shipped transport must honour:
 *
 *  - `open()` may be called again after a close and MUST establish a **fresh** connection — the
 *    reconnect ladder is driven from here, not from inside the transport;
 *  - the four listeners registered at construction stay live across those reopens.
 *
 * DOM-free and Node-free: no `WebSocket`, no timer identifier (see `./timers.ts`).
 */

import type { SwarmError } from '../errors.ts'
import type {
  ClientFrame,
  HeadKind,
  HelloOkFrame,
  ServerCapability,
  ServerFrame,
} from '../protocol/frames.ts'
import type { SwarmTransport, Unsubscribe } from '../types.ts'
import type { CancelTimer } from './timers.ts'

import { SwarmError as SwarmErrorClass } from '../errors.ts'
import { decodeServerFrame, encodeFrame } from '../protocol/codec.ts'
import {
  HEARTBEAT,
  RECONNECT,
  backoffDelayMs,
  blockedReasonForCloseCode,
  isTerminalCloseCode,
} from '../protocol/constants.ts'
import { SWARM_PROTOCOL, SWARM_PROTOCOL_VERSION } from '../protocol/frames.ts'
import { NOOP_CANCEL, scheduleAfter, scheduleEvery } from './timers.ts'

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'blocked'
export type BlockedReason = 'unauthenticated' | 'forbidden' | 'protocol' | null

/** The tick period that drives the heartbeat deadline and the `ack` cadence (§2.4). */
export const CLIENT_TICK_MS = 250

/**
 * What `hello_ok` established. Both flags are passed rather than read back off the connection,
 * because both describe the state the socket was in **before** it came up and the connection has
 * already cleared them by the time a listener runs — an ordering trap this shape removes.
 */
export interface ConnectionUp {
  readonly frame: HelloOkFrame
  /** §2.5 rule 2: a changed `serverVersion` or capability set forces `from:'snapshot'` (X14). */
  readonly changed: boolean
  /** §2.5 rule 3: a `bye{retryAfterMs}` was observed, so in-flight `req`s are NOT re-sent. */
  readonly resendSuppressed: boolean
}

export interface ConnectionOptions {
  readonly transport: SwarmTransport
  readonly clientName: string
  readonly head: HeadKind
  readonly now: () => number
  onUp(info: ConnectionUp): void
  /** Every decoded frame the connection does not consume itself. */
  onFrame(frame: ServerFrame): void
  /** The socket is gone. `blocked` ⇒ terminal close code; no further attempt is scheduled. */
  onDown(info: { readonly code: number; readonly blocked: boolean }): void
  /** Fires on every tick while connected, so the caller can flush time-based work once. */
  onTick(nowMs: number): void
  /** Anything a head must see. Never thrown — §9's refusals are values, not exceptions. */
  onError(error: SwarmError): void
  /** Any field `ConnectionVM` reads has changed. */
  onChange(): void
}

export interface ConnectionView {
  readonly status: ConnectionStatus
  readonly attempt: number
  readonly nextRetryAtMs: number | null
  readonly blockedReason: BlockedReason
  readonly serverVersion: string | null
  readonly capabilities: readonly ServerCapability[]
}

export interface Connection extends ConnectionView {
  connect(): void
  /** `false` when the frame could not be written — the caller queues or fails it. */
  send(frame: ClientFrame): boolean
  readonly connected: boolean
  destroy(): void
}

export function createConnection(options: ConnectionOptions): Connection {
  const { transport, now } = options

  let status: ConnectionStatus = 'idle'
  let attempt = 0
  let nextRetryAtMs: number | null = null
  let blockedReason: BlockedReason = null
  let serverVersion: string | null = null
  let capabilities: readonly ServerCapability[] = []
  let helloAcknowledged = false
  let resendSuppressed = false
  let byeRetryAfterMs: number | null = null
  let lastInboundAtMs = 0
  let lastPingAtMs = 0
  let destroyed = false

  let cancelRetry: CancelTimer = NOOP_CANCEL
  let cancelTick: CancelTimer = NOOP_CANCEL
  const listeners: Unsubscribe[] = []

  const changed = (): void => {
    options.onChange()
  }

  const raise = (error: SwarmError): void => {
    options.onError(error)
  }

  const write = (frame: ClientFrame): boolean => {
    try {
      transport.send(encodeFrame(frame))
      return true
    } catch (error) {
      raise(
        new SwarmErrorClass('internal', 'transport refused a frame', {
          retryable: true,
          cause: error,
        }),
      )
      return false
    }
  }

  const stopTick = (): void => {
    cancelTick()
    cancelTick = NOOP_CANCEL
  }

  /**
   * §2.4: the client pings after 20 s of silence and gives up after 30 s. "Silence" is **any**
   * inbound frame, not just a `pong` — a connection carrying a transcript is demonstrably alive
   * and pinging it would be noise on the stream that is already the loudest.
   */
  const tick = (): void => {
    if (destroyed || status !== 'connected') return
    const at = now()
    options.onTick(at)
    const idle = at - lastInboundAtMs
    if (idle >= HEARTBEAT.deadMs) {
      raise(
        new SwarmErrorClass('internal', `no frame for ${idle} ms; reconnecting`, {
          retryable: true,
          details: { idleMs: idle, deadMs: HEARTBEAT.deadMs },
        }),
      )
      /* Close locally: a socket that stopped answering will not answer a graceful close either,
       * and the reconnect ladder is driven by `onClose`. */
      try {
        transport.close()
      } catch {
        /* A transport that throws on close has already failed; `onClose` still drives recovery. */
      }
      return
    }
    if (idle >= HEARTBEAT.clientPingMs && at - lastPingAtMs >= HEARTBEAT.clientPingMs) {
      lastPingAtMs = at
      write({ p: SWARM_PROTOCOL, v: SWARM_PROTOCOL_VERSION, k: 'ping', t: at })
    }
  }

  const scheduleReconnect = (): void => {
    cancelRetry()
    attempt += 1
    const base = backoffDelayMs(attempt)
    /* ±25 % jitter (§2.5 rule 1): without it, N heads that lost the same server all return in
     * lockstep and the first tick after a restart is the busiest one. */
    const jittered = base * (1 + (Math.random() * 2 - 1) * RECONNECT.jitter)
    const delay = Math.max(
      0,
      Math.round(byeRetryAfterMs === null ? jittered : Math.max(jittered, byeRetryAfterMs)),
    )
    byeRetryAfterMs = null
    status = 'reconnecting'
    nextRetryAtMs = now() + delay
    changed()
    cancelRetry = scheduleAfter(delay, () => {
      cancelRetry = NOOP_CANCEL
      if (destroyed || status === 'blocked') return
      openSocket()
    })
  }

  const block = (reason: Exclude<BlockedReason, null>, code: number, message: string): void => {
    status = 'blocked'
    blockedReason = reason
    nextRetryAtMs = null
    stopTick()
    cancelRetry()
    cancelRetry = NOOP_CANCEL
    changed()
    raise(
      new SwarmErrorClass(reason === 'protocol' ? 'bad_protocol' : reason, message, {
        retryable: false,
        details: { closeCode: code },
      }),
    )
  }

  const openSocket = (): void => {
    if (destroyed || status === 'blocked' || status === 'connected') return
    status = attempt === 0 ? 'connecting' : 'reconnecting'
    helloAcknowledged = false
    changed()
    try {
      transport.open()
    } catch (error) {
      raise(
        new SwarmErrorClass('executor_unavailable', 'transport could not open', {
          retryable: true,
          cause: error,
        }),
      )
      scheduleReconnect()
    }
  }

  /**
   * §2.5 rule 2 reads as a **set** predicate, and it is treated as one. A server that re-orders an
   * otherwise identical capability list is not a changed server, and calling it one costs a
   * `server-changed` notice on a non-dismissible path plus `resubscribeAll(force:true)` — a full
   * re-snapshot of every stream, including every open `attempt:*`, the one family §2.4 lets lag.
   */
  const sameCapabilitySet = (
    a: readonly ServerCapability[],
    b: readonly ServerCapability[],
  ): boolean => {
    if (a.length !== b.length) return false
    const seen = new Set<ServerCapability>(a)
    return seen.size === new Set<ServerCapability>([...a, ...b]).size && b.every((c) => seen.has(c))
  }

  const handleHelloOk = (frame: HelloOkFrame): void => {
    helloAcknowledged = true
    const versionChanged = serverVersion !== null && serverVersion !== frame.serverVersion
    const capsChanged =
      serverVersion !== null && !sameCapabilitySet(capabilities, frame.capabilities)
    const wasSuppressed = resendSuppressed
    serverVersion = frame.serverVersion
    capabilities = [...frame.capabilities]
    status = 'connected'
    attempt = 0
    nextRetryAtMs = null
    blockedReason = null
    resendSuppressed = false
    byeRetryAfterMs = null
    changed()
    options.onUp({
      frame,
      changed: versionChanged || capsChanged,
      resendSuppressed: wasSuppressed,
    })
  }

  const handleMessage = (text: string): void => {
    if (destroyed) return
    lastInboundAtMs = now()
    const decoded = decodeServerFrame(text)
    if (!decoded.ok) {
      if (decoded.fatal) {
        /* A peer that cannot agree on `p`/`v` cannot be reasoned about at all (§2.2). Treated
         * exactly like the server's own close 4004: terminal, with the reason surfaced. */
        try {
          transport.close()
        } catch {
          /* ignore — `onClose` is what drives the state change. */
        }
        block('protocol', 4004, decoded.message)
        return
      }
      /* Unknown server frame kind, or an event kind this client does not know: **ignored**.
       * Forward compatibility is a runtime property (§2.2). */
      raise(new SwarmErrorClass(decoded.code, decoded.message, { retryable: false }))
      return
    }

    const frame = decoded.frame
    switch (frame.k) {
      case 'hello_ok':
        handleHelloOk(frame)
        return
      case 'ping':
        write({ p: SWARM_PROTOCOL, v: SWARM_PROTOCOL_VERSION, k: 'pong', t: frame.t })
        return
      case 'pong':
        return
      case 'bye':
        if (frame.retryAfterMs !== undefined) {
          byeRetryAfterMs = frame.retryAfterMs
          resendSuppressed = true
        }
        options.onFrame(frame)
        return
      default:
        if (!helloAcknowledged && frame.k !== 'err') {
          /* `hello_ok` is the server's half of §2.2's "hello first". An `err{id:null}` may
           * legitimately precede it (a rate limit on the handshake); a `snap` may not. */
          block('protocol', 4004, `server sent ${frame.k} before hello_ok`)
          return
        }
        options.onFrame(frame)
    }
  }

  const handleClose = (info: { code: number; reason: string; wasClean: boolean }): void => {
    if (destroyed) return
    stopTick()
    if (isTerminalCloseCode(info.code)) {
      const reason = blockedReasonForCloseCode(info.code)
      if (reason !== null) {
        block(reason, info.code, info.reason || `server closed with ${info.code}`)
        options.onDown({ code: info.code, blocked: true })
        return
      }
    }
    if (status === 'blocked') {
      options.onDown({ code: info.code, blocked: true })
      return
    }
    options.onDown({ code: info.code, blocked: false })
    scheduleReconnect()
  }

  listeners.push(
    transport.onOpen(() => {
      if (destroyed) return
      lastInboundAtMs = now()
      lastPingAtMs = now()
      /* §2.2: `hello` MUST be the first client frame — anything else closes 4004. */
      write({
        p: SWARM_PROTOCOL,
        v: SWARM_PROTOCOL_VERSION,
        k: 'hello',
        client: options.clientName,
        head: options.head,
        minV: 1,
        maxV: 1,
      })
      stopTick()
      cancelTick = scheduleEvery(CLIENT_TICK_MS, tick)
    }),
    transport.onMessage(handleMessage),
    transport.onClose(handleClose),
    transport.onError((error) => {
      if (destroyed) return
      raise(new SwarmErrorClass('internal', 'transport error', { retryable: true, cause: error }))
    }),
  )

  return {
    connect() {
      if (destroyed || status === 'connected' || status === 'connecting') return
      if (status === 'blocked') return
      openSocket()
    },

    send(frame) {
      if (destroyed || status !== 'connected') return false
      return write(frame)
    },

    get connected() {
      return status === 'connected'
    },
    get status() {
      return status
    },
    get attempt() {
      return attempt
    },
    get nextRetryAtMs() {
      return nextRetryAtMs
    },
    get blockedReason() {
      return blockedReason
    },
    get serverVersion() {
      return serverVersion
    },
    get capabilities() {
      return capabilities
    },

    destroy() {
      if (destroyed) return
      destroyed = true
      stopTick()
      cancelRetry()
      cancelRetry = NOOP_CANCEL
      for (const off of listeners) off()
      listeners.length = 0
      try {
        transport.close()
      } catch {
        /* Destroying must always be safe (§4.4's rule, applied to the client). */
      }
      status = 'idle'
      nextRetryAtMs = null
    },
  }
}
