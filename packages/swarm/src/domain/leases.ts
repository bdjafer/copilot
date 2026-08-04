/**
 * Leases and fencing tokens (SPEC-swarm §3.4).
 *
 * The one rule everything else hangs off: **every mutating executor call carries a `Fence`, and
 * the adapter refuses a call whose token is below the highest observed for that key**
 * (`stale_fence`). Tokens come from one monotonic counter in the durable store, so they are
 * globally comparable and survive restart — a lease acquired after a crash always outranks the
 * one the crashed process was holding, without any liveness guess.
 *
 * DOM-free and Node-free.
 */

import type { AttemptId, DelegationId, Fence, Lease, LeaseKey } from '../types.ts'

import { SwarmError } from '../errors.ts'

export type LeaseKind = 'session' | 'home' | 'worktree' | 'delegation' | 'repo'

export const LEASE_KINDS = [
  'session',
  'home',
  'worktree',
  'delegation',
  'repo',
] as const satisfies readonly LeaseKind[]

/** The writer lease: one holder per executor session (§3.4 rule 2). */
export function sessionLease(sessionId: string): LeaseKey {
  return `session:${sessionId}`
}

/** The singleton per `JCODE_HOME` (§3.4 rule 3, R9) — two daemons on one state dir corrupt it. */
export function homeLease(jcodeHome: string): LeaseKey {
  return `home:${jcodeHome}`
}

/** F4: one writing attempt per working tree. */
export function worktreeLease(path: string): LeaseKey {
  return `worktree:${path}`
}

/** F4: 8 worktrees per repo, counted against this key. */
export function repoLease(root: string): LeaseKey {
  return `repo:${root}`
}

/** The reconciliation lease (§5.5) — taken before the `unknown` protocol runs. */
export function delegationLease(id: DelegationId): LeaseKey {
  return `delegation:${id}`
}

export function parseLeaseKey(key: string): { kind: LeaseKind; id: string } | null {
  const separator = key.indexOf(':')
  if (separator <= 0) return null
  const kind = key.slice(0, separator)
  const id = key.slice(separator + 1)
  if (id.length === 0) return null
  return (LEASE_KINDS as readonly string[]).includes(kind) ? { kind: kind as LeaseKind, id } : null
}

export function fenceOf(lease: Lease): Fence {
  return { key: lease.key, token: lease.token }
}

/**
 * The refusal every adapter owes (§3.4 rule 1). Returns `null` when the call may proceed.
 *
 * A fence for a *different* key is not stale, it is wrong: it is refused as
 * `stale_fence` too, because a mutating call carrying someone else's lease has no claim on this
 * one either.
 */
export function checkFence(
  fence: Fence,
  key: LeaseKey,
  highestObservedToken: number,
): SwarmError | null {
  if (fence.key !== key) {
    return new SwarmError('stale_fence', `fence names lease '${fence.key}', not '${key}'`, {
      details: { expected: key, got: fence.key },
    })
  }
  if (fence.token < highestObservedToken) {
    return new SwarmError(
      'stale_fence',
      `fence ${fence.token} is below the highest observed ${highestObservedToken} for '${key}'`,
      { details: { key, token: fence.token, highestObserved: highestObservedToken } },
    )
  }
  return null
}

export function isExpired(lease: Lease, now: number): boolean {
  return lease.expiresAt <= now
}

/**
 * §3.4 rule 2: expiry **never releases while a turn streams** — it marks the holder `suspect` and
 * blocks new submissions. A lease that released itself mid-stream would hand the session to a
 * second writer while the first is still receiving its turn, which is the one thing the writer
 * lease exists to prevent.
 */
export function leaseStatus(
  lease: Lease,
  now: number,
  streaming: boolean,
): 'held' | 'suspect' | 'expired' {
  if (!isExpired(lease, now)) return 'held'
  return streaming ? 'suspect' : 'expired'
}

/** The attempt-scoped keys a scheduler must hold together before it may admit (§7.1). */
export interface AdmissionLeases {
  readonly worktree: LeaseKey
  readonly repo: LeaseKey
  readonly home: LeaseKey
}

export function admissionLeases(input: {
  readonly worktreePath: string
  readonly repoRoot: string
  readonly jcodeHome: string
  readonly attemptId: AttemptId
}): AdmissionLeases {
  return {
    worktree: worktreeLease(input.worktreePath),
    repo: repoLease(input.repoRoot),
    home: homeLease(input.jcodeHome),
  }
}
