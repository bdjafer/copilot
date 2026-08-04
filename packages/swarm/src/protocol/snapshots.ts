/**
 * `snap{seq, state}` — the fully materialized view at `seq`, per stream family (SPEC-swarm §2.3).
 *
 * §2.3 pins the *protocol* around the snapshot exactly — one transaction for cursor and state, no
 * event both in the snapshot and re-delivered — but never says what `state` contains. As with
 * `req.args` (`./intents.ts`), that is a shape two independently-written stages must agree on, so
 * it is declared once, here, rather than discovered when the first `snap` lands.
 *
 * The rule the four shapes follow: **a snapshot carries exactly the state that stream's events
 * mutate**, so `snapshot` and `from:<seq>` converge on the same projection. A field that no event
 * on that stream can change does not belong in its snapshot; a field an event *can* change and
 * the snapshot omits is a projection that never recovers from a re-subscribe.
 *
 * The decoders are shallow on purpose: they establish that the container is the right shape so
 * the projection can proceed, and they trust the view models inside it — those were produced by
 * the same `SwarmEvent` union the codec already validates, and re-validating a `DelegationVM`
 * field by field here would be a second copy of §6.2 that drifts from the first.
 *
 * DOM-free and Node-free.
 */

import type {
  ConfirmationRequest,
  DelegationVM,
  DiffVM,
  FleetVM,
  HealthVM,
  NoticeVM,
  SpendCounters,
  TranscriptEntry,
} from '../types.ts'
import type { StreamFamily } from './frames.ts'

/** `server` — health, doctor, notices and the pending copilot confirmations (§6.4, §6.7). */
export interface ServerSnapshot {
  readonly health: HealthVM
  readonly notices: readonly NoticeVM[]
  readonly confirmations: readonly ConfirmationRequest[]
}

/**
 * `fleet` — every delegation the head may see, plus the three fleet-scoped facts
 * `fleet.spend`/`fleet.caps` mutate. The delegations arrive as whole `DelegationVM`s because that
 * is what `fleet.delegation_created`/`_summary` carry: one shape, one projection path.
 */
export interface FleetSnapshot {
  readonly delegations: readonly DelegationVM[]
  readonly concurrency: FleetVM['concurrency']
  readonly dispatchPaused: boolean
  readonly spend: SpendCounters & { readonly capUsd: number | null }
}

/** `delegation:<id>` — the one delegation, fully materialized (attempts, turns, verification). */
export interface DelegationSnapshot {
  readonly delegation: DelegationVM
}

/**
 * `attempt:<id>` — the transcript slice the server retains plus the materialized diff.
 *
 * `hasOlder` is the server's claim that its retained window starts before `entries[0]`; the
 * client's own ring adds to it (§6.2 `TranscriptVM.hasOlder`).
 */
export interface AttemptSnapshot {
  readonly attemptId: string
  readonly entries: readonly TranscriptEntry[]
  readonly hasOlder: boolean
  readonly diff: DiffVM | null
}

export interface SnapshotByFamily {
  server: ServerSnapshot
  fleet: FleetSnapshot
  delegation: DelegationSnapshot
  attempt: AttemptSnapshot
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Decode `snap.state` for a family. Returns `null` for anything that is not the declared
 * container — the client raises `bad_protocol` and re-subscribes rather than projecting a
 * half-shaped snapshot, because a snapshot is the *base* every later `evt` is applied to and a
 * wrong base is wrong forever.
 */
export function decodeSnapshot<F extends StreamFamily>(
  family: F,
  state: unknown,
): SnapshotByFamily[F] | null {
  if (!isRecord(state)) return null
  switch (family) {
    case 'server': {
      if (!isRecord(state.health)) return null
      if (!Array.isArray(state.notices)) return null
      if (!Array.isArray(state.confirmations)) return null
      return state as unknown as SnapshotByFamily[F]
    }
    case 'fleet': {
      if (!Array.isArray(state.delegations)) return null
      if (!isRecord(state.concurrency)) return null
      if (typeof state.dispatchPaused !== 'boolean') return null
      if (!isRecord(state.spend)) return null
      return state as unknown as SnapshotByFamily[F]
    }
    case 'delegation': {
      if (!isRecord(state.delegation)) return null
      return state as unknown as SnapshotByFamily[F]
    }
    default: {
      if (typeof state.attemptId !== 'string') return null
      if (!Array.isArray(state.entries)) return null
      if (typeof state.hasOlder !== 'boolean') return null
      if (state.diff !== null && !isRecord(state.diff)) return null
      return state as unknown as SnapshotByFamily[F]
    }
  }
}
