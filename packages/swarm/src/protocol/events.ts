/**
 * `SwarmEvent` — the closed union of **34** kinds (SPEC-swarm §6.4), the stream each one routes
 * to, and the many-to-one projection onto `SwarmClientEvents`.
 *
 * Two rules make this module load-bearing rather than declarative:
 *
 *  - **unknown kinds are rejected on ingest and tolerated on egress** (§3.5). A server that
 *    learns a new kind may send it; a client that does not know it ignores it. The reverse — a
 *    server accepting an unknown kind from a head — would let a head write history swarm cannot
 *    replay.
 *  - the routing table is *data*, so `protocolConformance()` can enumerate all 34 by name and
 *    assert each lands on its declared stream. The previous version of this spec said "a closed
 *    union of 31 kinds" over a list of 21 different keys, which is exactly the kind of claim a
 *    table makes falsifiable.
 *
 * DOM-free and Node-free.
 */

import type {
  AttemptId,
  AttemptOutcome,
  AttemptVM,
  ChannelState,
  ConfirmationRequest,
  DelegationDefaultsPatch,
  DelegationId,
  DelegationState,
  DelegationVM,
  DeliveryDetail,
  DeliveryState,
  DiffVM,
  FleetBucket,
  FleetVM,
  HealthVM,
  KillReport,
  LandingRecord,
  NoticeVM,
  PreflightReport,
  RetractReport,
  SpendCounters,
  SwarmClientEvents,
  TurnId,
  TurnRecord,
  TurnVM,
  VerificationInput,
  VerificationRun,
} from '../types.ts'
import type { StreamFamily } from './frames.ts'

export type SwarmEvent =
  /* ------------------------------------------------------------------ stream `server` (7) */
  | { readonly k: 'server.hello'; readonly version: string; readonly bootId: string }
  | { readonly k: 'server.health'; readonly health: HealthVM }
  | { readonly k: 'server.doctor'; readonly report: PreflightReport }
  | { readonly k: 'server.notice'; readonly notice: NoticeVM }
  | {
      readonly k: 'server.pairing'
      readonly tokenId: string
      readonly action: 'issued' | 'revoked'
      readonly clientName: string
    }
  | { readonly k: 'server.confirmation'; readonly request: ConfirmationRequest }
  | {
      readonly k: 'server.confirmation_resolved'
      readonly requestId: string
      readonly decision: 'confirm' | 'deny'
    }
  /* ------------------------------------------------------------------- stream `fleet` (6) */
  | { readonly k: 'fleet.delegation_created'; readonly delegation: DelegationVM }
  | {
      readonly k: 'fleet.delegation_state'
      readonly delegationId: DelegationId
      readonly state: DelegationState
      readonly bucket: FleetBucket
      readonly version: number
    }
  | { readonly k: 'fleet.delegation_summary'; readonly delegation: DelegationVM }
  | {
      readonly k: 'fleet.spend'
      readonly spend: SpendCounters & { readonly capUsd: number | null }
    }
  | {
      readonly k: 'fleet.caps'
      readonly concurrency: FleetVM['concurrency']
      readonly dispatchPaused: boolean
    }
  | { readonly k: 'fleet.kill_switch'; readonly report: KillReport }
  /* --------------------------------------------------------- stream `delegation:<id>` (13) */
  | { readonly k: 'deleg.attempt_started'; readonly attempt: AttemptVM }
  | {
      readonly k: 'deleg.attempt_ended'
      readonly attemptId: AttemptId
      readonly outcome: AttemptOutcome
    }
  | {
      readonly k: 'deleg.channel'
      readonly attemptId: AttemptId
      readonly channel: ChannelState
    }
  | { readonly k: 'deleg.turn_prepared'; readonly turn: TurnVM }
  | {
      readonly k: 'deleg.turn_delivery'
      readonly turnId: TurnId
      readonly delivery: DeliveryState
      readonly detail: DeliveryDetail
    }
  | {
      readonly k: 'deleg.turn_ended'
      readonly turnId: TurnId
      readonly usage: TurnRecord['usage']
      readonly toolCalls: number
    }
  | { readonly k: 'deleg.turn_retracted'; readonly report: RetractReport }
  | {
      readonly k: 'deleg.verify_started'
      readonly attemptId: AttemptId
      readonly runId: string
      readonly reason: VerificationInput['reason']
    }
  | { readonly k: 'deleg.verify_result'; readonly run: VerificationRun }
  | { readonly k: 'deleg.landed'; readonly landing: LandingRecord }
  | {
      readonly k: 'deleg.drift'
      readonly attemptId: AttemptId
      readonly kind: 'model' | 'workspace' | 'base'
      readonly detail: string
    }
  | {
      readonly k: 'deleg.evidence'
      readonly attemptId: AttemptId
      readonly evidenceRef: string
      readonly manifestDigest: string
    }
  | {
      readonly k: 'deleg.defaults_updated'
      readonly patch: DelegationDefaultsPatch
      readonly version: number
    }
  /* ------------------------------------------------------------ stream `attempt:<id>` (8) */
  | { readonly k: 'att.text'; readonly text: string }
  | { readonly k: 'att.reasoning'; readonly text: string }
  /**
   * `callId` is always the id from `tool_start`/`tool_exec`/`tool_done`. Input deltas arrive
   * from the bridge with an **empty** `call_id` ([F11]) and are attributed by the adapter to the
   * most recent `tool_start` on that session *before* they reach this event — the wire never
   * carries `''`.
   */
  | {
      readonly k: 'att.tool'
      readonly callId: string
      readonly name: string
      readonly target: string | null
      readonly status: 'start' | 'exec' | 'done' | 'error'
      readonly output?: string
      readonly durationMs?: number
    }
  | {
      readonly k: 'att.usage'
      readonly input: number
      readonly output: number
      readonly cacheReadInput?: number
    }
  | {
      readonly k: 'att.background'
      readonly taskId: string
      readonly label: string
      readonly percent?: number
      /** Literal: jcode derives this by string-matching a TUI header ([B7], #16). */
      readonly provenance: 'scraped'
    }
  | { readonly k: 'att.turn_boundary'; readonly turnId: TurnId; readonly edge: 'start' | 'end' }
  | {
      readonly k: 'att.diff'
      readonly totals: DiffVM['totals']
      readonly staleBase: boolean
    }
  | { readonly k: 'att.error'; readonly code: string; readonly message: string }

export type SwarmEventKind = SwarmEvent['k']

/**
 * The 34, by name and in the order §6.4 declares them. `protocolConformance()` iterates this;
 * ingest rejects anything not in it.
 */
export const SWARM_EVENT_KINDS = [
  'server.hello',
  'server.health',
  'server.doctor',
  'server.notice',
  'server.pairing',
  'server.confirmation',
  'server.confirmation_resolved',
  'fleet.delegation_created',
  'fleet.delegation_state',
  'fleet.delegation_summary',
  'fleet.spend',
  'fleet.caps',
  'fleet.kill_switch',
  'deleg.attempt_started',
  'deleg.attempt_ended',
  'deleg.channel',
  'deleg.turn_prepared',
  'deleg.turn_delivery',
  'deleg.turn_ended',
  'deleg.turn_retracted',
  'deleg.verify_started',
  'deleg.verify_result',
  'deleg.landed',
  'deleg.drift',
  'deleg.evidence',
  'deleg.defaults_updated',
  'att.text',
  'att.reasoning',
  'att.tool',
  'att.usage',
  'att.background',
  'att.turn_boundary',
  'att.diff',
  'att.error',
] as const satisfies readonly SwarmEventKind[]

const EVENT_KIND_SET: ReadonlySet<string> = new Set<string>(SWARM_EVENT_KINDS)

export function isSwarmEventKind(value: unknown): value is SwarmEventKind {
  return typeof value === 'string' && EVENT_KIND_SET.has(value)
}

/**
 * Which stream family each kind is written to (§2.3, §6.4). The *concrete* stream name for the
 * `delegation` and `attempt` families is supplied by the writer, because the id lives on the
 * record being mutated and not always in the payload — `att.text` carries no `attemptId` for
 * exactly the reason `attempt:*` is the high-volume stream.
 */
export const EVENT_STREAM_FAMILY = {
  'server.hello': 'server',
  'server.health': 'server',
  'server.doctor': 'server',
  'server.notice': 'server',
  'server.pairing': 'server',
  'server.confirmation': 'server',
  'server.confirmation_resolved': 'server',
  'fleet.delegation_created': 'fleet',
  'fleet.delegation_state': 'fleet',
  'fleet.delegation_summary': 'fleet',
  'fleet.spend': 'fleet',
  'fleet.caps': 'fleet',
  'fleet.kill_switch': 'fleet',
  'deleg.attempt_started': 'delegation',
  'deleg.attempt_ended': 'delegation',
  'deleg.channel': 'delegation',
  'deleg.turn_prepared': 'delegation',
  'deleg.turn_delivery': 'delegation',
  'deleg.turn_ended': 'delegation',
  'deleg.turn_retracted': 'delegation',
  'deleg.verify_started': 'delegation',
  'deleg.verify_result': 'delegation',
  'deleg.landed': 'delegation',
  'deleg.drift': 'delegation',
  'deleg.evidence': 'delegation',
  'deleg.defaults_updated': 'delegation',
  'att.text': 'attempt',
  'att.reasoning': 'attempt',
  'att.tool': 'attempt',
  'att.usage': 'attempt',
  'att.background': 'attempt',
  'att.turn_boundary': 'attempt',
  'att.diff': 'attempt',
  'att.error': 'attempt',
} as const satisfies Record<SwarmEventKind, StreamFamily>

export function streamFamilyOf(kind: SwarmEventKind): StreamFamily {
  return EVENT_STREAM_FAMILY[kind]
}

/**
 * The many-to-one projection of §6.4: which head-facing keys a wire kind **can** raise.
 *
 * Total over the 34 (every kind has an entry) and, read the other way, surjective onto every
 * `SwarmClientEvents` key except the transport-derived ones below. An empty array is a
 * deliberate value, not an omission: `att.*` deltas feed `TranscriptVM` through a ref-counted
 * `transcript()` handle rather than the event bus, and `fleet.caps` only moves `FleetVM`.
 *
 * A kind listing two keys raises both **conditionally** — `fleet.delegation_state` always raises
 * `delegation:state` and additionally raises `needs-you` when the new state is `needs-you`, which
 * is what makes attention a first-class signal instead of a string comparison at every call site.
 */
export const EVENT_PROJECTION = {
  'server.hello': ['server-changed'],
  'server.health': ['health'],
  'server.doctor': ['health'],
  'server.notice': ['notice'],
  'server.pairing': ['notice'],
  'server.confirmation': ['confirmation'],
  'server.confirmation_resolved': [],
  'fleet.delegation_created': ['delegation:create'],
  'fleet.delegation_state': ['delegation:state', 'needs-you'],
  'fleet.delegation_summary': ['delegation:update'],
  'fleet.spend': ['budget'],
  'fleet.caps': [],
  'fleet.kill_switch': ['notice'],
  'deleg.attempt_started': ['attempt:start'],
  'deleg.attempt_ended': ['attempt:end'],
  'deleg.channel': ['delegation:update'],
  'deleg.turn_prepared': ['turn:prepared'],
  'deleg.turn_delivery': ['turn:delivery'],
  'deleg.turn_ended': ['turn:end'],
  'deleg.turn_retracted': ['turn:retracted'],
  'deleg.verify_started': ['verify:start'],
  'deleg.verify_result': ['verify:result'],
  'deleg.landed': ['land:result'],
  'deleg.drift': ['drift'],
  'deleg.evidence': ['evidence'],
  'deleg.defaults_updated': ['delegation:update'],
  'att.text': [],
  'att.reasoning': [],
  'att.tool': [],
  'att.usage': [],
  'att.background': [],
  'att.turn_boundary': [],
  'att.diff': [],
  'att.error': ['error'],
} as const satisfies Record<SwarmEventKind, readonly (keyof SwarmClientEvents)[]>

/**
 * The keys no wire event can produce: they are observations of the transport itself. Listing
 * them is what lets the totality test be two-directional — "every kind projects" is only half
 * the claim; "every key is reachable" is the half that catches a key nobody ever emits.
 */
export const TRANSPORT_ONLY_CLIENT_EVENTS = [
  'connection',
  'stream:lagged',
] as const satisfies readonly (keyof SwarmClientEvents)[]
