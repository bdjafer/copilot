/**
 * The scheduler's admission rules (SPEC-swarm §7.1), as pure decisions.
 *
 * **The unit of admission is an attempt, not a delegation** (Q9). A delegation with
 * `parallelAttempts: 3` presents three admission candidates and occupies three slots when all
 * three are admitted — which is the difference between "three parallel attempts at one objective"
 * and a retry log wearing the word *swarm* (#29).
 *
 * Order is `priority` desc, then `queued` age asc (the aging guard, F7), and among equal-priority
 * candidates a **first** attempt outranks a **sibling** attempt: parallel exploration must never
 * starve a delegation that has not started at all.
 *
 * Everything here is a function of counted state, so the whole admission table is testable with no
 * store, no executor and no clock of its own.
 *
 * DOM-free and Node-free — the engine supplies the counts.
 */

import type { DelegationId, InstanceKey } from '../types.ts'

export interface AdmissionCandidate {
  readonly delegationId: DelegationId
  /** 0-based index of this attempt among the delegation's live slots. 0 ⇒ a *first* attempt. */
  readonly siblingIndex: number
  readonly priority: number
  readonly queuedAt: number
  readonly workspaceId: string
  readonly providerModel: string
  readonly instanceKey: InstanceKey
  readonly createdByCopilot: boolean
  /** A hard budget breach refuses admission; it never cancels what is already running (Q11). */
  readonly budgetHardBreached: boolean
  readonly delegationPaused: boolean
}

export interface AdmissionState {
  readonly runningAttempts: number
  readonly perWorkspace: Readonly<Record<string, number>>
  readonly perProviderModel: Readonly<Record<string, number>>
  readonly perRepoWorktrees: Readonly<Record<string, number>>
  readonly copilotAttempts: number
  readonly fleetPaused: boolean
}

export interface AdmissionCaps {
  readonly globalConcurrency: number
  readonly perWorkspace: number
  readonly perProviderModel: Readonly<Record<string, number>>
  readonly worktreesPerRepo: number
  readonly copilotConcurrency: number
}

export type AdmissionRefusal =
  | 'fleet_paused'
  | 'delegation_paused'
  | 'budget_hard_breached'
  | 'global_slot'
  | 'workspace_slot'
  | 'provider_model_slot'
  | 'copilot_slot'
  | 'worktrees_per_repo'

export type AdmissionDecision =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: AdmissionRefusal }

/**
 * Every clause of §7.1's "an attempt is admitted only when *all* hold", in the order a refusal is
 * most useful to report: the two pauses first (a user did this on purpose), then the budget, then
 * the four capacity limits. The `worktree:*` and `home:*` leases are checked by the caller, which
 * is the only party that can *take* them — a decision function that reported "lease available"
 * would be reporting a value that is stale the instant it returns.
 */
export function admissionDecision(
  candidate: AdmissionCandidate,
  state: AdmissionState,
  caps: AdmissionCaps,
  repoRoot: string,
): AdmissionDecision {
  if (state.fleetPaused) return { admit: false, reason: 'fleet_paused' }
  if (candidate.delegationPaused) return { admit: false, reason: 'delegation_paused' }
  if (candidate.budgetHardBreached) return { admit: false, reason: 'budget_hard_breached' }
  if (state.runningAttempts >= caps.globalConcurrency) {
    return { admit: false, reason: 'global_slot' }
  }
  if ((state.perWorkspace[candidate.workspaceId] ?? 0) >= caps.perWorkspace) {
    return { admit: false, reason: 'workspace_slot' }
  }
  const providerCap = caps.perProviderModel[candidate.providerModel]
  if (
    providerCap !== undefined &&
    (state.perProviderModel[candidate.providerModel] ?? 0) >= providerCap
  ) {
    return { admit: false, reason: 'provider_model_slot' }
  }
  if (candidate.createdByCopilot && state.copilotAttempts >= caps.copilotConcurrency) {
    return { admit: false, reason: 'copilot_slot' }
  }
  if ((state.perRepoWorktrees[repoRoot] ?? 0) >= caps.worktreesPerRepo) {
    return { admit: false, reason: 'worktrees_per_repo' }
  }
  return { admit: true }
}

/**
 * §7.1's order. The sibling tiebreak is the one that is easy to get wrong and expensive to
 * notice: without it, a delegation running two attempts keeps winning slots against a delegation
 * that has never started, and the fleet looks busy while one objective monopolises it.
 */
export function orderCandidates(
  candidates: readonly AdmissionCandidate[],
): readonly AdmissionCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority
    const aFirst = a.siblingIndex === 0 ? 0 : 1
    const bFirst = b.siblingIndex === 0 ? 0 : 1
    if (aFirst !== bFirst) return aFirst - bFirst
    if (a.queuedAt !== b.queuedAt) return a.queuedAt - b.queuedAt
    return a.delegationId < b.delegationId ? -1 : a.delegationId > b.delegationId ? 1 : 0
  })
}

/** Apply an admission to the counters, so a tick can admit several candidates in one pass. */
export function withAdmitted(
  state: AdmissionState,
  candidate: AdmissionCandidate,
  repoRoot: string,
): AdmissionState {
  return {
    ...state,
    runningAttempts: state.runningAttempts + 1,
    perWorkspace: {
      ...state.perWorkspace,
      [candidate.workspaceId]: (state.perWorkspace[candidate.workspaceId] ?? 0) + 1,
    },
    perProviderModel: {
      ...state.perProviderModel,
      [candidate.providerModel]: (state.perProviderModel[candidate.providerModel] ?? 0) + 1,
    },
    perRepoWorktrees: {
      ...state.perRepoWorktrees,
      [repoRoot]: (state.perRepoWorktrees[repoRoot] ?? 0) + 1,
    },
    copilotAttempts: state.copilotAttempts + (candidate.createdByCopilot ? 1 : 0),
  }
}
