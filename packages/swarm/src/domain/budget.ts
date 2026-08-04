/**
 * Budgets and clocks (SPEC-swarm §3.4, X10, X16).
 *
 * Two rules carry the whole section:
 *
 *  - **the in-flight turn is never cancelled** by a fleet or delegation breach (Q11). A hard
 *    breach sets `dispatchPaused` and refuses *new* turns; killing the turn a user is watching
 *    throws away tokens already spent and produces the retry the cap was meant to avoid. Only a
 *    `TurnBudget` breach cancels, and only that turn.
 *  - **sleep is a large wall gap with a near-zero monotonic gap** (X16). A large gap in *both*
 *    clocks is a process that ran for hours producing nothing — the stall signature (W5).
 *    Reporting equal gaps as "asleep" would hide the exact failure stall detection exists to
 *    catch, and would make tracking two clocks pointless.
 *
 * DOM-free and Node-free.
 */

import type { BudgetSpec, SpendCounters, TurnBudget } from '../types.ts'

import { DEFAULT_TIMEOUTS } from './constants.ts'

export const SOFT_BREACH_FRACTION = 0.8

export function emptySpendCounters(): SpendCounters {
  return {
    wallMs: 0,
    monotonicMs: 0,
    sleptMs: 0,
    turns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estUsd: 0,
  }
}

export function addSpend(a: SpendCounters, b: Partial<SpendCounters>): SpendCounters {
  return {
    wallMs: a.wallMs + (b.wallMs ?? 0),
    monotonicMs: a.monotonicMs + (b.monotonicMs ?? 0),
    sleptMs: a.sleptMs + (b.sleptMs ?? 0),
    turns: a.turns + (b.turns ?? 0),
    toolCalls: a.toolCalls + (b.toolCalls ?? 0),
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    estUsd: a.estUsd + (b.estUsd ?? 0),
  }
}

export type BudgetDimension =
  | 'wallMs'
  | 'turns'
  | 'toolCalls'
  | 'inputTokens'
  | 'outputTokens'
  | 'spendUsd'

export type BudgetFractions = Readonly<Record<BudgetDimension, number>>

/**
 * Fraction of each limit consumed. `wallMs` is measured **excluding** `sleptMs` (X16): a laptop
 * that was closed for four hours did not spend four hours of the delegation's wall budget.
 */
export function budgetFractions(used: SpendCounters, limit: BudgetSpec): BudgetFractions {
  const wall = Math.max(0, used.wallMs - used.sleptMs)
  return {
    wallMs: fraction(wall, limit.maxWallMs),
    turns: fraction(used.turns, limit.maxTurns),
    toolCalls: fraction(used.toolCalls, limit.maxToolCalls),
    inputTokens: fraction(used.inputTokens, limit.maxInputTokens),
    outputTokens: fraction(used.outputTokens, limit.maxOutputTokens),
    spendUsd: limit.maxSpendUsd === undefined ? 0 : fraction(used.estUsd, limit.maxSpendUsd),
  }
}

function fraction(used: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 0
  return used / limit
}

export function worstFraction(used: SpendCounters, limit: BudgetSpec): number {
  return Math.max(...Object.values(budgetFractions(used, limit)))
}

export type BudgetLevel = 'none' | 'soft' | 'hard'

export interface BudgetBreach {
  readonly level: BudgetLevel
  readonly worstFraction: number
  /** Every dimension at or over its limit — named, so the notice can say *which* budget. */
  readonly breached: readonly BudgetDimension[]
  /**
   * What the server does (§3.4 "breach ladder"). `pauseDispatch` never cancels a running turn;
   * `needsYou` is the `onBreach:'needs-you'` variant, which routes to the attention plane.
   */
  readonly action: 'none' | 'warn' | 'pause-dispatch' | 'needs-you'
}

export function classifyBudget(used: SpendCounters, limit: BudgetSpec): BudgetBreach {
  const fractions = budgetFractions(used, limit)
  const worst = Math.max(...Object.values(fractions))
  const breached = (Object.keys(fractions) as BudgetDimension[]).filter((d) => fractions[d] >= 1)
  if (breached.length > 0) {
    return {
      level: 'hard',
      worstFraction: worst,
      breached,
      action: limit.onBreach === 'needs-you' ? 'needs-you' : 'pause-dispatch',
    }
  }
  if (worst >= SOFT_BREACH_FRACTION) {
    return { level: 'soft', worstFraction: worst, breached: [], action: 'warn' }
  }
  return { level: 'none', worstFraction: worst, breached: [], action: 'none' }
}

/**
 * A `TurnBudget` breach — the **only** budget that cancels, and it cancels that turn alone
 * (§3.4). The session survives; `budget-breach` is recorded on the turn.
 */
export function turnBudgetBreached(
  budget: TurnBudget | null,
  observed: { readonly wallMs: number; readonly toolCalls: number },
): boolean {
  if (budget === null) return false
  if (budget.maxWallMs !== undefined && observed.wallMs >= budget.maxWallMs) return true
  if (budget.maxToolCalls !== undefined && observed.toolCalls >= budget.maxToolCalls) return true
  return false
}

/* ---------------------------------------------------------------------- X16 sleep vs. stall */

export type ClockGapKind = 'none' | 'asleep' | 'stalled'

export interface ClockGap {
  readonly kind: ClockGapKind
  readonly wallGapMs: number
  readonly monoGapMs: number
  /** Δwall − Δmono: the suspend component, added to `SpendCounters.sleptMs`. */
  readonly sleptMs: number
}

/**
 * Classify a sampling gap (X16). Darwin's `CLOCK_UPTIME_RAW` and Linux's `CLOCK_MONOTONIC` both
 * exclude suspend, so the *difference* between the two clocks is the sleep, and their *agreement*
 * over a long gap is a stall.
 *
 * §13 asserts both directions by name: "a 4 h wall gap with a ≈0 monotonic gap reports asleep; a
 * 4 h gap in both clocks reports stalled".
 */
export function classifyClockGap(
  wallGapMs: number,
  monoGapMs: number,
  thresholdMs: number = DEFAULT_TIMEOUTS.sleepDetectThresholdMs,
): ClockGap {
  const slept = Math.max(0, wallGapMs - monoGapMs)
  if (slept > thresholdMs) return { kind: 'asleep', wallGapMs, monoGapMs, sleptMs: slept }
  if (wallGapMs > thresholdMs) return { kind: 'stalled', wallGapMs, monoGapMs, sleptMs: 0 }
  return { kind: 'none', wallGapMs, monoGapMs, sleptMs: 0 }
}
