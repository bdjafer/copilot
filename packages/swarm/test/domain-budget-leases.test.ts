/**
 * SPEC-swarm §3.4 (budgets, leases, fencing) and X16 (sleep vs. stall).
 *
 * Two §13 rows are asserted by name here:
 *
 *  - "a hard spend cap sets `dispatchPaused` and the in-flight turn still reaches `turn_done`" —
 *    the classification half of it, which is what the budget monitor acts on (Q11);
 *  - "a 4 h wall gap with a ≈0 monotonic gap reports **asleep**; a 4 h gap in *both* clocks
 *    reports **stalled**" (#40). The old assertion had it backwards, and if the two were
 *    indistinguishable, tracking two clocks (X10) would buy nothing at all.
 */

import { describe, expect, it } from 'vitest'

import type { BudgetSpec, Lease } from '../src/types.ts'

import {
  SOFT_BREACH_FRACTION,
  addSpend,
  budgetFractions,
  classifyBudget,
  classifyClockGap,
  emptySpendCounters,
  turnBudgetBreached,
  worstFraction,
} from '../src/domain/budget.ts'
import { DEFAULT_TIMEOUTS } from '../src/domain/constants.ts'
import {
  checkFence,
  delegationLease,
  fenceOf,
  homeLease,
  leaseStatus,
  parseLeaseKey,
  repoLease,
  sessionLease,
  worktreeLease,
} from '../src/domain/leases.ts'

const limit: BudgetSpec = {
  maxWallMs: 1000,
  maxTurns: 10,
  maxToolCalls: 100,
  maxInputTokens: 1000,
  maxOutputTokens: 1000,
  onBreach: 'pause-dispatch',
}

describe('§3.4 budgets', () => {
  it('measures wall time EXCLUDING detected sleep (X16)', () => {
    const used = { ...emptySpendCounters(), wallMs: 900, sleptMs: 800 }
    expect(budgetFractions(used, limit).wallMs).toBeCloseTo(0.1)
  })

  it('warns at 80 % and never pauses there', () => {
    const soft = classifyBudget({ ...emptySpendCounters(), turns: 8 }, limit)
    expect(SOFT_BREACH_FRACTION).toBe(0.8)
    expect(soft.level).toBe('soft')
    expect(soft.action).toBe('warn')
    expect(soft.breached).toEqual([])
  })

  it('a hard breach pauses dispatch and NEVER cancels the in-flight turn (Q11)', () => {
    const hard = classifyBudget({ ...emptySpendCounters(), turns: 10 }, limit)
    expect(hard.level).toBe('hard')
    expect(hard.action).toBe('pause-dispatch')
    expect(hard.breached).toEqual(['turns'])
    /* There is no 'kill' action in the union at all — the spec forbids it by construction. */
    expect(['none', 'warn', 'pause-dispatch', 'needs-you']).toContain(hard.action)
  })

  it("onBreach:'needs-you' routes a hard breach to the attention plane instead", () => {
    const hard = classifyBudget(
      { ...emptySpendCounters(), turns: 10 },
      { ...limit, onBreach: 'needs-you' },
    )
    expect(hard.action).toBe('needs-you')
  })

  it('reports the worst dimension across the whole budget', () => {
    const used = { ...emptySpendCounters(), turns: 5, inputTokens: 900 }
    expect(worstFraction(used, limit)).toBeCloseTo(0.9)
  })

  it('ignores an unset maxSpendUsd rather than dividing by zero', () => {
    expect(budgetFractions({ ...emptySpendCounters(), estUsd: 42 }, limit).spendUsd).toBe(0)
  })

  it('a TurnBudget is the only budget that cancels, and only that turn', () => {
    expect(turnBudgetBreached(null, { wallMs: 1e9, toolCalls: 1e9 })).toBe(false)
    expect(turnBudgetBreached({ maxWallMs: 100 }, { wallMs: 100, toolCalls: 0 })).toBe(true)
    expect(turnBudgetBreached({ maxToolCalls: 3 }, { wallMs: 0, toolCalls: 2 })).toBe(false)
    expect(turnBudgetBreached({ maxToolCalls: 3 }, { wallMs: 0, toolCalls: 3 })).toBe(true)
  })

  it('adds counters dimension by dimension', () => {
    const sum = addSpend(emptySpendCounters(), { turns: 1, estUsd: 0.5 })
    expect(sum.turns).toBe(1)
    expect(sum.estUsd).toBe(0.5)
    expect(sum.toolCalls).toBe(0)
  })
})

describe('X16 sleep is a wall gap the monotonic clock did not see', () => {
  const FOUR_HOURS = 4 * 60 * 60_000

  it('a 4 h wall gap with a ≈0 monotonic gap reports ASLEEP', () => {
    const gap = classifyClockGap(FOUR_HOURS, 50)
    expect(gap.kind).toBe('asleep')
    expect(gap.sleptMs).toBe(FOUR_HOURS - 50)
  })

  it('a 4 h gap in BOTH clocks reports STALLED — the process ran and produced nothing (W5)', () => {
    const gap = classifyClockGap(FOUR_HOURS, FOUR_HOURS)
    expect(gap.kind).toBe('stalled')
    expect(gap.sleptMs).toBe(0)
  })

  it('a normal sampling interval is neither', () => {
    expect(classifyClockGap(5_000, 5_000).kind).toBe('none')
  })

  it('uses the §7.3 default threshold of 90 s', () => {
    expect(DEFAULT_TIMEOUTS.sleepDetectThresholdMs).toBe(90_000)
    expect(classifyClockGap(89_000, 0).kind).toBe('none')
    expect(classifyClockGap(91_000, 0).kind).toBe('asleep')
  })
})

describe('§3.4 leases and fencing tokens', () => {
  const lease: Lease = {
    key: sessionLease('s-1'),
    holder: 'server-a',
    token: 7,
    acquiredAt: 0,
    expiresAt: 100,
  }

  it('builds and parses the five lease kinds', () => {
    expect(sessionLease('s-1')).toBe('session:s-1')
    expect(homeLease('/home/j')).toBe('home:/home/j')
    expect(worktreeLease('/w/1')).toBe('worktree:/w/1')
    expect(repoLease('/repo')).toBe('repo:/repo')
    expect(delegationLease('d-1')).toBe('delegation:d-1')
    expect(parseLeaseKey('session:s-1')).toEqual({ kind: 'session', id: 's-1' })
    expect(parseLeaseKey('home:/home/j')).toEqual({ kind: 'home', id: '/home/j' })
    expect(parseLeaseKey('nonsense')).toBeNull()
    expect(parseLeaseKey('session:')).toBeNull()
  })

  it('refuses a fence below the highest observed token with stale_fence', () => {
    expect(checkFence(fenceOf(lease), lease.key, 7)).toBeNull()
    expect(checkFence(fenceOf(lease), lease.key, 8)?.code).toBe('stale_fence')
    expect(checkFence({ key: lease.key, token: 9 }, lease.key, 7)).toBeNull()
  })

  it('refuses a fence naming another lease: it has no claim on this one either', () => {
    expect(checkFence({ key: 'session:other', token: 99 }, lease.key, 1)?.code).toBe('stale_fence')
  })

  it('an expired lease is `suspect`, not released, while a turn streams (§3.4 rule 2)', () => {
    expect(leaseStatus(lease, 50, true)).toBe('held')
    expect(leaseStatus(lease, 150, true)).toBe('suspect')
    expect(leaseStatus(lease, 150, false)).toBe('expired')
  })
})
