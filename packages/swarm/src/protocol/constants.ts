/**
 * Wire-level constants: close codes (§2.5), heartbeat and backpressure (§2.4), frame and image
 * caps (§2.4), reconnect backoff (§2.5) and stream retention (§2.3).
 *
 * These are values the two peers must agree on to the number, so they are declared once, as
 * data, and asserted in tests against the spec tables rather than typed into two files.
 *
 * DOM-free and Node-free.
 */

import type { LagReason, StreamFamily } from './frames.ts'

/* --------------------------------------------------------------------------- §2.5 close codes */

export const CLOSE_CODES = {
  /** Missing or unknown `swarm.tok.<token>` subprotocol. */
  unauthenticated: 4001,
  /** `Origin` outside the allowlist, or a `Host` that is not a literal loopback authority. */
  forbidden: 4003,
  /** First frame was not `hello`, or the envelope did not parse. */
  protocol: 4004,
  /** No `pong` and no frame within `HEARTBEAT.deadMs`. */
  heartbeat: 4008,
  /** Backpressure that dropping `attempt:*` could not relieve. */
  backpressure: 4009,
  /** Server shutting down; pairs with `bye{retryAfterMs}`. */
  shuttingDown: 4013,
} as const satisfies Record<string, number>

export type CloseCodeName = keyof typeof CLOSE_CODES
export type CloseCode = (typeof CLOSE_CODES)[CloseCodeName]

/**
 * **Terminal** close codes (§2.5 rule 4): the client stops retrying and surfaces a fix. Retrying
 * an unauthenticated or forbidden connection forever is how a paired-then-revoked head turns
 * into a reconnect loop that never tells the user why.
 */
export const TERMINAL_CLOSE_CODES = [
  CLOSE_CODES.unauthenticated,
  CLOSE_CODES.forbidden,
  CLOSE_CODES.protocol,
] as const

const TERMINAL_SET: ReadonlySet<number> = new Set<number>(TERMINAL_CLOSE_CODES)

export function isTerminalCloseCode(code: number): boolean {
  return TERMINAL_SET.has(code)
}

/** The `ConnectionVM.blockedReason` a terminal close maps to; `null` for a retryable close. */
export function blockedReasonForCloseCode(
  code: number,
): 'unauthenticated' | 'forbidden' | 'protocol' | null {
  switch (code) {
    case CLOSE_CODES.unauthenticated:
      return 'unauthenticated'
    case CLOSE_CODES.forbidden:
      return 'forbidden'
    case CLOSE_CODES.protocol:
      return 'protocol'
    default:
      return null
  }
}

/* ---------------------------------------------------------------------------- §2.4 heartbeat */

export const HEARTBEAT = {
  /** Server pings after this much idle time. */
  serverPingMs: 15_000,
  /** Client pings after this much idle time — deliberately longer, so the server leads. */
  clientPingMs: 20_000,
  /** No `pong` **and no frame** within this window ⇒ close 4008 (server) / reconnect (client). */
  deadMs: 30_000,
} as const

/* ------------------------------------------------------------------------- §2.4 backpressure */

export const LIMITS = {
  /** One text message. Oversize event payloads truncate with `truncated: true`. */
  frameBytes: 1024 * 1024,
  /**
   * 700 **KB** decoded — 700 000 bytes, not 700 KiB — per image and per turn, *derived* from
   * `frameBytes` rather than chosen (§2.4): base64 inflates by ~33 %, so 700 KB decoded is
   * ~933 KB on the wire and fits one 1 MiB frame with room for the envelope and the prompt.
   * Refused in the client core with `invalid_spec` before any frame is built, so the user never
   * gets a transport error for a product-level refusal. The unit is load-bearing: §13's boundary
   * row is "700 KB accepted, **701 KB** refused", and 701 000 < 700 × 1024 — a KiB cap accepts
   * the very byte count the DoD names as the refusal.
   */
  imageBytesPerImage: 700_000,
  imageBytesPerTurn: 700_000,
} as const

export const BACKPRESSURE = {
  /** Per-connection outbound queue. Either breach drops the highest-volume `attempt:*`. */
  queueBytes: 4 * 1024 * 1024,
  queueFrames: 4_000,
  /** Unacked window per stream; only `attempt:*` is ever paused by it. */
  unackedWindow: 512,
  /** Client `ack` cadence: whichever comes first. */
  ackEveryFrames: 128,
  ackEveryMs: 1_000,
} as const

/**
 * Only `attempt:*` degrades (§2.4, Q12): the transcript is evidence, not the product.
 * `server`, `fleet` and `delegation:*` are never paused and never dropped, so a head that is
 * behind still learns *which delegation needs it* — the thing the fleet exists to answer.
 */
export const DEGRADABLE_STREAM_FAMILIES = ['attempt'] as const satisfies readonly StreamFamily[]

export function isDegradableStream(family: StreamFamily): boolean {
  return (DEGRADABLE_STREAM_FAMILIES as readonly StreamFamily[]).includes(family)
}

export const LAG_REASONS = [
  'backpressure',
  'retention',
  'server_restart',
] as const satisfies readonly LagReason[]

/* ---------------------------------------------------------------------------- §2.5 reconnect */

export const RECONNECT = {
  baseMs: 250,
  factor: 1.8,
  capMs: 30_000,
  /** ±25 %, applied to the computed delay. */
  jitter: 0.25,
} as const

/**
 * Backoff for attempt *n* (1-based), before jitter. Exported so the client's schedule is a pure
 * function a test can assert rather than a timer a test has to observe.
 */
export function backoffDelayMs(attempt: number): number {
  if (attempt <= 1) return RECONNECT.baseMs
  return Math.min(RECONNECT.capMs, RECONNECT.baseMs * RECONNECT.factor ** (attempt - 1))
}

/**
 * Re-subscribe order after `hello_ok` (§2.5 rule 2): **attention before transcripts**. A head
 * that re-subscribes `attempt:*` first spends its whole backlog budget on the stream that is
 * allowed to lag, and learns last which delegation is asking for it.
 */
export const RESUBSCRIBE_ORDER = [
  'server',
  'fleet',
  'delegation',
  'attempt',
] as const satisfies readonly StreamFamily[]

/* --------------------------------------------------------------------------- §2.3 retention */

export const RETENTION = {
  server: { kind: 'days', days: 30 },
  fleet: { kind: 'forever' },
  delegation: { kind: 'delegation-lifetime' },
  /** 7 d **or** 200 MB, then the floor rises and a late resume gets `lagged{retention}`. */
  attempt: { kind: 'days-or-bytes', days: 7, bytes: 200 * 1_000_000 },
} as const satisfies Record<StreamFamily, { kind: string } & Record<string, unknown>>
