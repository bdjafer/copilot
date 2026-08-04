/**
 * The strict ingest codec (SPEC-swarm §2.2, §2.3, §2.4) — pure, allocating nothing but the
 * decoded object, touching no clock, no socket and no store.
 *
 * Three rules from §2.2 are encoded here rather than left to the connection:
 *
 *  - an unknown `k` **from a client** is `unknown_frame` and the connection **survives**;
 *  - an unknown `k` **from the server** is *ignored* by the client — forward compatibility is a
 *    runtime property, exactly as the jcode SDK argues;
 *  - a bad envelope is fatal (close 4004), because a peer that cannot agree on `p`/`v` cannot be
 *    reasoned about at all. That is the whole reason `p` and `v` ride on every frame.
 *
 * Nothing here names `TextEncoder`, `atob` or `Buffer`: §13 typechecks a fixture that imports
 * `.` under `lib: ["ES2022"]` with no `dom` and no `@types/node`, and all three are absent from
 * that surface. The byte arithmetic below is therefore written out.
 *
 * DOM-free and Node-free.
 */

import type { SwarmErrorCode } from '../errors.ts'
import type { AttemptId, DelegationId } from '../types.ts'
import type { HelloFrame } from './frames.ts'

import { isSwarmErrorCode } from '../errors.ts'
import { LIMITS } from './constants.ts'
import { isSwarmEventKind } from './events.ts'
import {
  SWARM_PROTOCOL,
  SWARM_PROTOCOL_VERSION,
  type ClientFrame,
  type LagReason,
  type ServerFrame,
  type StreamFamily,
  type StreamName,
} from './frames.ts'

/**
 * `fatal` distinguishes "close 4004" from "reply `err` and keep the connection". A decoder that
 * collapsed the two would either kill a connection over a frame kind added in a later minor, or
 * keep talking to a peer that is not speaking `swarm.v1` at all.
 */
export type DecodeFailure = {
  readonly ok: false
  readonly code: SwarmErrorCode
  readonly message: string
  readonly fatal: boolean
}

export type DecodeResult<T> = { readonly ok: true; readonly frame: T } | DecodeFailure

const fail = (code: SwarmErrorCode, message: string, fatal = false): DecodeFailure => ({
  ok: false,
  code,
  message,
  fatal,
})

/* --------------------------------------------------------------------------- byte accounting */

/**
 * UTF-8 byte length of a JS string, without `TextEncoder`.
 *
 * The two bounds make the hot path cheap: a UTF-8 encoding is never shorter than the string's
 * UTF-16 length and never longer than three times it (an astral pair is 2 units → 4 bytes), so
 * only a frame inside the ambiguous band is measured exactly.
 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        i++
        continue
      }
      bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** `true` when the encoded frame breaches §2.4's 1 MiB cap. */
export function exceedsFrameLimit(text: string, limit: number = LIMITS.frameBytes): boolean {
  if (text.length > limit) return true
  if (text.length * 3 <= limit) return false
  return utf8ByteLength(text) > limit
}

/**
 * Decoded byte count of a base64 (or base64url) payload, computed from its length — no `atob`,
 * no allocation of the decoded buffer, which matters because the caller is checking an image it
 * is about to *refuse*.
 *
 * Returns `null` for a string that is not a plausible base64 body, so the caller can raise
 * `invalid_spec` for the malformed case rather than silently sizing it at 0.
 */
export function base64DecodedBytes(base64: string): number | null {
  let length = base64.length
  while (length > 0 && base64.charCodeAt(length - 1) === 61 /* '=' */) length--
  if (length % 4 === 1) return null
  for (let i = 0; i < length; i++) {
    const c = base64.charCodeAt(i)
    const ok =
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 43 ||
      c === 47 ||
      c === 45 ||
      c === 95
    if (!ok) return null
  }
  return Math.floor((length * 3) / 4)
}

/* ------------------------------------------------------------------------------ stream names */

export interface ParsedStream {
  readonly family: StreamFamily
  /** The delegation or attempt id; `null` for the two singleton streams. */
  readonly id: string | null
}

/**
 * Validate a stream name **by shape** (§2.2). An unroutable stream yields
 * `err{code:'stream_unknown'}` — never a subscription that is accepted and then never delivers.
 */
export function parseStreamName(value: unknown): ParsedStream | null {
  if (typeof value !== 'string' || value.length === 0) return null
  if (value === 'server') return { family: 'server', id: null }
  if (value === 'fleet') return { family: 'fleet', id: null }
  if (value.startsWith('delegation:')) {
    const id = value.slice('delegation:'.length)
    return id.length > 0 ? { family: 'delegation', id } : null
  }
  if (value.startsWith('attempt:')) {
    const id = value.slice('attempt:'.length)
    return id.length > 0 ? { family: 'attempt', id } : null
  }
  return null
}

export function delegationStream(id: DelegationId): StreamName {
  return `delegation:${id}`
}

export function attemptStream(id: AttemptId): StreamName {
  return `attempt:${id}`
}

/* ------------------------------------------------------- §2.3 subscription and replay policy */

export type SubscriptionPlan =
  /** `from:'snapshot'` — `snap{seq,state}` then `evt` from `seq + 1`, read in one transaction. */
  | { readonly kind: 'snapshot' }
  /** `from:n` within the retained window — `res{{from:n}}` then `evt` from `n + 1`. */
  | { readonly kind: 'replay'; readonly fromExclusive: number }
  /** `n < floor` — `lagged`, and the client MUST re-subscribe with `'snapshot'`. */
  | { readonly kind: 'lagged'; readonly fromSeq: number; readonly reason: LagReason }
  /** `n > head` — a cursor from the future is a bug in the head, not a lag. */
  | { readonly kind: 'error'; readonly code: 'bad_cursor' }

/**
 * The whole of §2.3's subscription contract as one pure decision, so both peers and every test
 * read the same four cases.
 *
 * A gap observed by a client is a **bug**, not a lag signal: lag is always explicit, which is why
 * "below the floor" produces a `lagged` frame and never a quietly-shortened replay.
 */
export function resolveSubscription(
  from: 'snapshot' | number,
  /* Named `bounds`, not `window`: shadowing a DOM global in the client core is exactly what §13's
   * grep gate is looking for, and a parameter is no less of a hit than a reference. */
  bounds: { readonly head: number; readonly floor: number },
  lagReason: LagReason = 'retention',
): SubscriptionPlan {
  if (from === 'snapshot') return { kind: 'snapshot' }
  if (!Number.isInteger(from) || from < 0) return { kind: 'error', code: 'bad_cursor' }
  if (from < bounds.floor) return { kind: 'lagged', fromSeq: from, reason: lagReason }
  if (from > bounds.head) return { kind: 'error', code: 'bad_cursor' }
  return { kind: 'replay', fromExclusive: from }
}

/* ------------------------------------------------------------------------------ the envelope */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isReqId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

/** Parse + envelope check. Every failure here but the size cap is fatal: close **4004** (§2.2). */
function openEnvelope(
  text: string,
): { readonly ok: true; readonly body: Record<string, unknown> } | DecodeFailure {
  if (exceedsFrameLimit(text)) {
    return fail('frame_too_large', `frame exceeds ${LIMITS.frameBytes} bytes`, false)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return fail('bad_protocol', 'frame is not JSON', true)
  }
  if (!isRecord(parsed)) return fail('bad_protocol', 'frame is not an object', true)
  if (parsed.p !== SWARM_PROTOCOL)
    return fail('bad_protocol', `p must be "${SWARM_PROTOCOL}"`, true)
  if (parsed.v !== SWARM_PROTOCOL_VERSION) {
    return fail('bad_protocol', `v must be ${SWARM_PROTOCOL_VERSION}`, true)
  }
  if (typeof parsed.k !== 'string') return fail('bad_protocol', 'k must be a string', true)
  return { ok: true, body: parsed }
}

/** One JSON object per text message (§2.2). The envelope is stamped here, never by the caller. */
export function encodeFrame(frame: ClientFrame | ServerFrame): string {
  return JSON.stringify({ ...frame, p: SWARM_PROTOCOL, v: SWARM_PROTOCOL_VERSION })
}

export function isHelloFrame(frame: ClientFrame): frame is HelloFrame {
  return frame.k === 'hello'
}

/* -------------------------------------------------------------------------- client → server */

export function decodeClientFrame(text: string): DecodeResult<ClientFrame> {
  const opened = openEnvelope(text)
  if (!opened.ok) return opened
  const f = opened.body

  switch (f.k) {
    case 'hello': {
      if (!isNonEmptyString(f.client)) return fail('bad_protocol', 'hello.client is required', true)
      if (f.head !== 'extension' && f.head !== 'cli' && f.head !== 'test') {
        return fail('bad_protocol', 'hello.head must be extension | cli | test', true)
      }
      if (f.minV !== 1 || f.maxV !== 1) {
        return fail('bad_protocol', 'hello.minV and hello.maxV must be 1', true)
      }
      return { ok: true, frame: f as unknown as ClientFrame }
    }
    case 'req': {
      if (!isReqId(f.id)) return fail('bad_protocol', 'req.id must be a non-negative integer', true)
      if (!isNonEmptyString(f.intent)) return fail('invalid_spec', 'req.intent is required')
      if (!isNonEmptyString(f.idempotencyKey)) {
        return fail('invalid_spec', 'req.idempotencyKey is required')
      }
      if (f.expectedVersion !== undefined && !Number.isInteger(f.expectedVersion)) {
        return fail('invalid_spec', 'req.expectedVersion must be an integer')
      }
      return { ok: true, frame: f as unknown as ClientFrame }
    }
    case 'sub': {
      if (!isReqId(f.id)) return fail('bad_protocol', 'sub.id must be a non-negative integer', true)
      if (parseStreamName(f.stream) === null) {
        return fail('stream_unknown', `unroutable stream ${String(f.stream)}`)
      }
      const from = f.from
      const validFrom =
        from === 'snapshot' || (typeof from === 'number' && Number.isInteger(from) && from >= 0)
      if (!validFrom) return fail('bad_cursor', "sub.from must be 'snapshot' or a seq >= 0")
      return { ok: true, frame: f as unknown as ClientFrame }
    }
    case 'unsub': {
      if (parseStreamName(f.stream) === null) {
        return fail('stream_unknown', `unroutable stream ${String(f.stream)}`)
      }
      return { ok: true, frame: f as unknown as ClientFrame }
    }
    case 'ack': {
      if (parseStreamName(f.stream) === null) {
        return fail('stream_unknown', `unroutable stream ${String(f.stream)}`)
      }
      if (!isSeq(f.seq)) return fail('bad_cursor', 'ack.seq must be an integer >= 1')
      return { ok: true, frame: f as unknown as ClientFrame }
    }
    case 'ping':
    case 'pong': {
      if (typeof f.t !== 'number') return fail('bad_protocol', 'ping.t must be a number', true)
      return { ok: true, frame: f as unknown as ClientFrame }
    }
    default:
      /* §2.2: the connection survives an unknown client frame kind. */
      return fail('unknown_frame', `unknown client frame kind ${String(f.k)}`)
  }
}

/* -------------------------------------------------------------------------- server → client */

export function decodeServerFrame(text: string): DecodeResult<ServerFrame> {
  const opened = openEnvelope(text)
  if (!opened.ok) return opened
  const f = opened.body

  switch (f.k) {
    case 'hello_ok': {
      if (!isNonEmptyString(f.server))
        return fail('bad_protocol', 'hello_ok.server is required', true)
      if (!isNonEmptyString(f.serverVersion)) {
        return fail('bad_protocol', 'hello_ok.serverVersion is required', true)
      }
      if (!isNonEmptyString(f.connectionId)) {
        return fail('bad_protocol', 'hello_ok.connectionId is required', true)
      }
      if (!Array.isArray(f.capabilities)) {
        return fail('bad_protocol', 'hello_ok.capabilities must be an array', true)
      }
      if (typeof f.serverTimeMs !== 'number') {
        return fail('bad_protocol', 'hello_ok.serverTimeMs must be a number', true)
      }
      return { ok: true, frame: f as unknown as ServerFrame }
    }
    case 'res': {
      if (!isReqId(f.id)) return fail('bad_protocol', 'res.id must be a non-negative integer', true)
      return { ok: true, frame: f as unknown as ServerFrame }
    }
    case 'err': {
      if (f.id !== null && !isReqId(f.id)) {
        return fail('bad_protocol', 'err.id must be an integer or null', true)
      }
      if (!isSwarmErrorCode(f.code))
        return fail('bad_protocol', `unknown error code ${String(f.code)}`)
      if (typeof f.message !== 'string')
        return fail('bad_protocol', 'err.message must be a string', true)
      if (typeof f.retryable !== 'boolean') {
        return fail('bad_protocol', 'err.retryable must be a boolean', true)
      }
      return { ok: true, frame: f as unknown as ServerFrame }
    }
    case 'snap': {
      if (!isReqId(f.id))
        return fail('bad_protocol', 'snap.id must be a non-negative integer', true)
      if (parseStreamName(f.stream) === null) {
        return fail('stream_unknown', `unroutable stream ${String(f.stream)}`)
      }
      /* A snapshot at seq 0 is legal: an empty stream materializes to its zero state. */
      if (typeof f.seq !== 'number' || !Number.isInteger(f.seq) || f.seq < 0) {
        return fail('bad_cursor', 'snap.seq must be an integer >= 0')
      }
      return { ok: true, frame: f as unknown as ServerFrame }
    }
    case 'evt': {
      if (parseStreamName(f.stream) === null) {
        return fail('stream_unknown', `unroutable stream ${String(f.stream)}`)
      }
      if (!isSeq(f.seq)) return fail('bad_cursor', 'evt.seq must be an integer >= 1')
      if (typeof f.ts !== 'number') return fail('bad_protocol', 'evt.ts must be a number', true)
      if (!isRecord(f.ev) || !isSwarmEventKind(f.ev.k)) {
        /*
         * Tolerated on egress (§3.5): a server that learns a new kind may send it and a client
         * that does not know it ignores it. Non-fatal, and the caller drops the frame — but the
         * *server's* ingest path uses `isSwarmEventKind` to reject, so a head can never write
         * history swarm cannot replay.
         */
        return fail('unknown_frame', `unknown event kind ${String((f.ev as { k?: unknown })?.k)}`)
      }
      return { ok: true, frame: f as unknown as ServerFrame }
    }
    case 'lagged': {
      if (parseStreamName(f.stream) === null) {
        return fail('stream_unknown', `unroutable stream ${String(f.stream)}`)
      }
      if (typeof f.fromSeq !== 'number' || !Number.isInteger(f.fromSeq) || f.fromSeq < 0) {
        return fail('bad_cursor', 'lagged.fromSeq must be an integer >= 0')
      }
      if (
        f.reason !== 'backpressure' &&
        f.reason !== 'retention' &&
        f.reason !== 'server_restart'
      ) {
        return fail('bad_protocol', `unknown lag reason ${String(f.reason)}`)
      }
      return { ok: true, frame: f as unknown as ServerFrame }
    }
    case 'ping':
    case 'pong': {
      if (typeof f.t !== 'number') return fail('bad_protocol', 'ping.t must be a number', true)
      return { ok: true, frame: f as unknown as ServerFrame }
    }
    case 'bye': {
      if (typeof f.reason !== 'string')
        return fail('bad_protocol', 'bye.reason must be a string', true)
      if (f.retryAfterMs !== undefined && typeof f.retryAfterMs !== 'number') {
        return fail('bad_protocol', 'bye.retryAfterMs must be a number', true)
      }
      return { ok: true, frame: f as unknown as ServerFrame }
    }
    default:
      /* Ignored by the client — forward compatibility is a runtime property (§2.2). */
      return fail('unknown_frame', `unknown server frame kind ${String(f.k)}`)
  }
}
