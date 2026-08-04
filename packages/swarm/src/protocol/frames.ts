/**
 * `swarm.v1` — the envelope and every frame kind (SPEC-swarm §2.2).
 *
 * Types plus data tables; **zero I/O** and zero dependencies, which is why §1.1 can re-export
 * this module whole from `.` and have `./server` import it by relative path: a Node-only
 * consumer pays nothing at runtime and the client never reaches into the server to get it.
 *
 * `p` and `v` are on **every** frame so a mis-wired peer fails on frame 1 rather than on the
 * first frame whose shape happens to differ.
 *
 * DOM-free and Node-free.
 */

import type { SwarmErrorCode } from '../errors.ts'
import type { AttemptId, DelegationId } from '../types.ts'
import type { SwarmEvent } from './events.ts'

export const SWARM_PROTOCOL = 'swarm' as const
export const SWARM_PROTOCOL_VERSION = 1 as const

/** The WebSocket subprotocol the handshake MUST include and the server echoes exactly (§2.1). */
export const SWARM_SUBPROTOCOL = 'swarm.v1' as const

/** Token subprotocol prefix — S4: the token is never a query parameter (§2.1). */
export const SWARM_TOKEN_SUBPROTOCOL_PREFIX = 'swarm.tok.' as const

/** The envelope, spread into every frame below. */
export interface Envelope {
  readonly p: typeof SWARM_PROTOCOL
  readonly v: typeof SWARM_PROTOCOL_VERSION
}

export type HeadKind = 'extension' | 'cli' | 'test'

export type LagReason = 'backpressure' | 'retention' | 'server_restart'

export type ServerCapability =
  | 'replay'
  | 'snapshot'
  | 'landing'
  | 'verify'
  | 'structured'
  | 'approvals'
  | 'images'
  | 'parallel-attempts'
  | 'confirmations'

export const SERVER_CAPABILITIES = [
  'replay',
  'snapshot',
  'landing',
  'verify',
  'structured',
  'approvals',
  'images',
  'parallel-attempts',
  'confirmations',
] as const satisfies readonly ServerCapability[]

/**
 * Four stream families (§2.3). A template-literal union, so `sub{stream}` is validated by shape
 * on ingest and an unroutable stream yields `err{code:'stream_unknown'}` rather than a
 * subscription that silently never delivers.
 */
export type StreamName = 'server' | 'fleet' | `delegation:${DelegationId}` | `attempt:${AttemptId}`

export type StreamFamily = 'server' | 'fleet' | 'delegation' | 'attempt'

export const STREAM_FAMILIES = [
  'server',
  'fleet',
  'delegation',
  'attempt',
] as const satisfies readonly StreamFamily[]

/**
 * Seventeen wire intents. `setFilter` and `focus` are deliberately **absent**: they are local
 * view selections and never reach the wire (§2.2, §6.3).
 */
export type IntentName =
  | 'createDelegation'
  | 'sendTurn'
  | 'retract'
  | 'cancel'
  | 'retry'
  | 'branch'
  | 'verify'
  | 'accept'
  | 'land'
  | 'discard'
  | 'archive'
  | 'reconcile'
  | 'pauseDispatch'
  | 'killSwitch'
  | 'updateDefaults'
  | 'confirm'
  | 'deny'

export const INTENT_NAMES = [
  'createDelegation',
  'sendTurn',
  'retract',
  'cancel',
  'retry',
  'branch',
  'verify',
  'accept',
  'land',
  'discard',
  'archive',
  'reconcile',
  'pauseDispatch',
  'killSwitch',
  'updateDefaults',
  'confirm',
  'deny',
] as const satisfies readonly IntentName[]

/* --------------------------------------------------------------------------- client frames */

export type ClientFrameKind = 'hello' | 'req' | 'sub' | 'unsub' | 'ack' | 'ping' | 'pong'

export interface HelloFrame extends Envelope {
  readonly k: 'hello'
  readonly client: string
  readonly head: HeadKind
  readonly minV: 1
  readonly maxV: 1
}

export interface ReqFrame extends Envelope {
  readonly k: 'req'
  readonly id: number
  readonly intent: IntentName
  readonly args: unknown
  /** Keyed `(tokenId, idempotencyKey)` in the durable cache, TTL 24 h (§2.5 rule 3). */
  readonly idempotencyKey: string
  readonly expectedVersion?: number
}

export interface SubFrame extends Envelope {
  readonly k: 'sub'
  readonly id: number
  readonly stream: StreamName
  readonly from: 'snapshot' | number
}

export interface UnsubFrame extends Envelope {
  readonly k: 'unsub'
  readonly stream: StreamName
}

export interface AckFrame extends Envelope {
  readonly k: 'ack'
  readonly stream: StreamName
  readonly seq: number
}

export interface ClientPingFrame extends Envelope {
  readonly k: 'ping' | 'pong'
  readonly t: number
}

export type ClientFrame = HelloFrame | ReqFrame | SubFrame | UnsubFrame | AckFrame | ClientPingFrame

/* --------------------------------------------------------------------------- server frames */

export type ServerFrameKind =
  | 'hello_ok'
  | 'res'
  | 'err'
  | 'snap'
  | 'evt'
  | 'lagged'
  | 'ping'
  | 'pong'
  | 'bye'

export interface HelloOkFrame extends Envelope {
  readonly k: 'hello_ok'
  readonly server: string
  readonly serverVersion: string
  readonly connectionId: string
  readonly capabilities: readonly ServerCapability[]
  readonly serverTimeMs: number
}

export interface ResFrame extends Envelope {
  readonly k: 'res'
  readonly id: number
  readonly data: unknown
}

export interface ErrFrame extends Envelope {
  readonly k: 'err'
  /** `null` for an error that belongs to no request — a bad frame, a rate limit. */
  readonly id: number | null
  readonly code: SwarmErrorCode
  readonly message: string
  readonly retryable: boolean
  readonly details?: Record<string, unknown>
}

export interface SnapFrame extends Envelope {
  readonly k: 'snap'
  readonly id: number
  readonly stream: StreamName
  /** The fully materialized view **at** `seq`; the first `evt` that follows is `seq + 1`. */
  readonly seq: number
  readonly state: unknown
}

export interface EvtFrame extends Envelope {
  readonly k: 'evt'
  readonly stream: StreamName
  readonly seq: number
  readonly ts: number
  readonly ev: SwarmEvent
}

export interface LaggedFrame extends Envelope {
  readonly k: 'lagged'
  readonly stream: StreamName
  readonly fromSeq: number
  readonly reason: LagReason
}

export interface ServerPingFrame extends Envelope {
  readonly k: 'ping' | 'pong'
  readonly t: number
}

export interface ByeFrame extends Envelope {
  readonly k: 'bye'
  readonly reason: string
  /** Present ⇒ the client MUST NOT retry the in-flight `req` (§2.5 rule 3). */
  readonly retryAfterMs?: number
}

export type ServerFrame =
  | HelloOkFrame
  | ResFrame
  | ErrFrame
  | SnapFrame
  | EvtFrame
  | LaggedFrame
  | ServerPingFrame
  | ByeFrame

export const CLIENT_FRAME_KINDS = [
  'hello',
  'req',
  'sub',
  'unsub',
  'ack',
  'ping',
  'pong',
] as const satisfies readonly ClientFrameKind[]

export const SERVER_FRAME_KINDS = [
  'hello_ok',
  'res',
  'err',
  'snap',
  'evt',
  'lagged',
  'ping',
  'pong',
  'bye',
] as const satisfies readonly ServerFrameKind[]
