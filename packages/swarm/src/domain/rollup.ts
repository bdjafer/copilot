/**
 * The fleet's derivation layer: the attempt→delegation rollup (§3.3, Q9), the total
 * state×facet→bucket mapping (§6.2.1) and the attention score (§6.4–6.6).
 *
 * All three are pure and exported from `./testing` as well as `.`, because each is a claim the
 * product makes about *what the user sees*, and a claim rendered by a component is a claim only
 * that component can be wrong about. `bucketOf` in particular produces both `FleetVM.buckets`
 * and `DelegationVM.bucket`, so the list and the row badge cannot disagree.
 *
 * DOM-free and Node-free.
 */

import type { DelegationId, DelegationState, FleetBucket } from '../types.ts'

/* ------------------------------------------------------------------------- §3.3 the rollup */

/**
 * Highest attention first (Q9). Execution belongs to the attempt; the delegation is a rollup, so
 * one attempt reaching `needs-you` shows the delegation as `needs-you` **while its siblings keep
 * running** — which is correct, because the user *is* needed.
 */
export const ROLLUP_PRIORITY = [
  'needs-you',
  'verifying',
  'running',
  'waiting',
  'provisioning',
  'queued',
] as const satisfies readonly DelegationState[]

const ROLLUP_RANK: ReadonlyMap<DelegationState, number> = new Map(
  ROLLUP_PRIORITY.map((state, index) => [state, index]),
)

/**
 * The delegation state projected from its **live** attempts.
 *
 * Returns `null` when nothing is live — the delegation may then reach a terminal state, and only
 * then (§3.3: "reaching a terminal state only when `liveAttempts` is empty"). A terminal state in
 * the live list is a programmer error and throws: it is precisely the bug the rollup exists to
 * prevent, and swallowing it produces a delegation frozen at `needs-you` with nothing running.
 */
export function rollupDelegationState(
  liveAttemptStates: readonly DelegationState[],
): DelegationState | null {
  let best: DelegationState | null = null
  let bestRank = Number.POSITIVE_INFINITY
  for (const state of liveAttemptStates) {
    const rank = ROLLUP_RANK.get(state)
    if (rank === undefined) {
      throw new Error(
        `rollupDelegationState: '${state}' is terminal and cannot describe a live attempt`,
      )
    }
    if (rank < bestRank) {
      bestRank = rank
      best = state
    }
  }
  return best
}

/* -------------------------------------------------------------------- §6.2.1 bucket mapping */

/**
 * The three facts `bucketOf` needs. `DelegationVM` satisfies it structurally, and so does a
 * server-side record projection — the mapping must be callable where there is no VM yet, or the
 * fleet list and the badge would be computed by two different functions.
 */
export interface BucketInput {
  readonly state: DelegationState
  /** W5. Non-null ⇒ the delegation is `running` but has produced nothing for a while. */
  readonly stalledForMs: number | null
  readonly landed: boolean
}

/**
 * Total over every state × facet combination (§6.2.1, F1). Every one of the ten states maps, so
 * no delegation can vanish from the dashboard — the previous mapping dropped `provisioning`,
 * `waiting`, `verifying` and `abandoned`, which made a delegation invisible for the whole of its
 * verification: the exact moment the law of done exists for.
 *
 * `dispatchPaused` is deliberately **not** a facet here: it is a badge on the row (§6.2.1). A
 * paused delegation is still whatever it is.
 */
export function bucketOf(vm: BucketInput): FleetBucket {
  switch (vm.state) {
    case 'queued':
      return 'queued'
    case 'provisioning':
    case 'waiting':
    case 'verifying':
      return 'working'
    case 'running':
      return vm.stalledForMs === null ? 'working' : 'stalled'
    case 'needs-you':
      return 'needs-you'
    case 'succeeded':
      return vm.landed ? 'done-landed' : 'done-unlanded'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
    case 'abandoned':
      return 'abandoned'
  }
}

export const FLEET_BUCKETS = [
  'needs-you',
  'failed',
  'stalled',
  'working',
  'queued',
  'done-unlanded',
  'done-landed',
  'cancelled',
  'abandoned',
] as const satisfies readonly FleetBucket[]

/** An empty bucket map, so a projection never has to spell nine keys to stay total. */
export function emptyBuckets<T>(make: () => T): Record<FleetBucket, T> {
  return {
    'needs-you': make(),
    failed: make(),
    stalled: make(),
    working: make(),
    queued: make(),
    'done-unlanded': make(),
    'done-landed': make(),
    cancelled: make(),
    abandoned: make(),
  }
}

/* ------------------------------------------------------------------ §6.4–6.6 attention score */

/**
 * The weights of §6.4–6.6, as inputs rather than as a VM: the score is a pure arithmetic claim,
 * and taking a clock (for `ageMinutes`) would make it a function of *when the test ran*.
 */
export interface AttentionInput {
  readonly state: DelegationState
  readonly landed: boolean
  readonly stalled: boolean
  readonly deliveryUnknown: boolean
  readonly budgetBreached: boolean
  readonly staleBase: boolean
  /** Age in whole minutes; contributes at most 199, so it never outranks a real signal. */
  readonly ageMinutes: number
}

export const ATTENTION_WEIGHTS = {
  needsYou: 1000,
  failed: 900,
  doneUnlanded: 800,
  stalled: 700,
  deliveryUnknown: 600,
  budgetBreached: 500,
  staleBase: 400,
  ageCap: 199,
} as const

export function attentionScore(input: AttentionInput): number {
  const w = ATTENTION_WEIGHTS
  return (
    (input.state === 'needs-you' ? w.needsYou : 0) +
    (input.state === 'failed' ? w.failed : 0) +
    (input.state === 'succeeded' && !input.landed ? w.doneUnlanded : 0) +
    (input.stalled ? w.stalled : 0) +
    (input.deliveryUnknown ? w.deliveryUnknown : 0) +
    (input.budgetBreached ? w.budgetBreached : 0) +
    (input.staleBase ? w.staleBase : 0) +
    Math.min(w.ageCap, Math.max(0, Math.floor(input.ageMinutes)))
  )
}

/** Ties break by `updatedAt` desc then `id` — a total order, so the list never jitters. */
export function compareAttention(
  a: { readonly attentionScore: number; readonly updatedAt: number; readonly id: DelegationId },
  b: { readonly attentionScore: number; readonly updatedAt: number; readonly id: DelegationId },
): number {
  if (a.attentionScore !== b.attentionScore) return b.attentionScore - a.attentionScore
  if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}
