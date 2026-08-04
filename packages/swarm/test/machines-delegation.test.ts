/**
 * SPEC-swarm §3.3 — `DelegationState`, rows **D1–D23**, one test per row, named after it.
 *
 * The table is the contract; these tests are the proof that the transcription is faithful and
 * that nothing else got in. The negative cases matter as much as the positive ones: D17 is the
 * only path to `cancelled` (#31), and D19 is the only path out of a terminal state (Q2).
 */

import { describe, expect, it } from 'vitest'

import type { DelegationState } from '../src/types.ts'

import {
  DELEGATION_STATES,
  DELEGATION_TERMINAL_STATES,
  DELEGATION_TRANSITIONS,
  delegationMachine,
  type DelegationTrigger,
} from '../src/domain/machines.ts'

const NON_TERMINAL = DELEGATION_STATES.filter(
  (s) => !(DELEGATION_TERMINAL_STATES as readonly DelegationState[]).includes(s),
)

interface Row {
  readonly id: string
  readonly from: DelegationState | null
  readonly trigger: DelegationTrigger
  readonly to: DelegationState | null
  readonly label: string
}

const ROWS: readonly Row[] = [
  {
    id: 'D1',
    from: null,
    trigger: 'created',
    to: 'queued',
    label: '— → queued on createDelegation',
  },
  {
    id: 'D2',
    from: 'queued',
    trigger: 'admitted',
    to: 'provisioning',
    label: 'the scheduler admits ONE ATTEMPT',
  },
  {
    id: 'D3',
    from: 'queued',
    trigger: 'cancel_delegation',
    to: 'cancelled',
    label: 'cancel while queued',
  },
  {
    id: 'D4',
    from: 'provisioning',
    trigger: 'attempt_attached',
    to: 'running',
    label: 'session attached, first turn submitted',
  },
  {
    id: 'D5',
    from: 'provisioning',
    trigger: 'provision_failed',
    to: 'failed',
    label: 'preflight/worktree/instance error after 3 retries',
  },
  {
    id: 'D6',
    from: 'running',
    trigger: 'turn_done_no_followup',
    to: 'waiting',
    label: 'turn_done with criteria present',
  },
  {
    id: 'D7',
    from: 'running',
    trigger: 'needs_you',
    to: 'needs-you',
    label: 'question, manual criterion or onBreach:needs-you',
  },
  {
    id: 'D8',
    from: 'waiting',
    trigger: 'verify',
    to: 'verifying',
    label: 'auto-verify at turn end or verify intent',
  },
  {
    id: 'D9',
    from: 'running',
    trigger: 'verify',
    to: 'verifying',
    label: 'verify while streaming, applied at turn end',
  },
  {
    id: 'D10',
    from: 'verifying',
    trigger: 'verification_passed',
    to: 'succeeded',
    label: 'every machine-checkable criterion passed',
  },
  {
    id: 'D11',
    from: 'verifying',
    trigger: 'verification_failed_budget_remaining',
    to: 'needs-you',
    label: 'failed with budget left, or indeterminate',
  },
  {
    id: 'D12',
    from: 'verifying',
    trigger: 'verification_exhausted',
    to: 'failed',
    label: 'failed with budget exhausted',
  },
  {
    id: 'D13',
    from: 'needs-you',
    trigger: 'send_turn',
    to: 'running',
    label: 'answering a question is sendTurn',
  },
  {
    id: 'D14',
    from: 'needs-you',
    trigger: 'accept',
    to: 'succeeded',
    label: 'accept{note} — the only path for unverifiable work',
  },
  {
    id: 'D15',
    from: 'needs-you',
    trigger: 'archive_abandon',
    to: 'abandoned',
    label: 'archive{abandon:true}',
  },
  {
    id: 'D16',
    from: 'waiting',
    trigger: 'send_turn',
    to: 'running',
    label: 'a follow-up resumes a waiting delegation',
  },
  {
    id: 'D18',
    from: 'running',
    trigger: 'executor_disconnect',
    to: 'waiting',
    label: 'executor disconnect from running',
  },
  {
    id: 'D18',
    from: 'verifying',
    trigger: 'executor_disconnect',
    to: 'waiting',
    label: 'executor disconnect from verifying',
  },
  {
    id: 'D20',
    from: 'succeeded',
    trigger: 'land',
    to: 'succeeded',
    label: 'landing is a facet, not a state',
  },
  {
    id: 'D21',
    from: 'failed',
    trigger: 'reverify',
    to: 'failed',
    label: 're-verification appends a run and stays failed',
  },
  {
    id: 'D22',
    from: 'provisioning',
    trigger: 'hard_spend_cap',
    to: 'queued',
    label: 'hard cap from provisioning',
  },
  {
    id: 'D22',
    from: 'running',
    trigger: 'hard_spend_cap',
    to: 'queued',
    label: 'hard cap from running',
  },
]

describe('§3.3 DelegationState — the D-table', () => {
  it('declares 23 rows, D1..D23, each exactly once', () => {
    const ids = DELEGATION_TRANSITIONS.map((r) => r.id)
    expect(ids).toHaveLength(23)
    expect(new Set(ids).size).toBe(23)
    expect(ids).toEqual(Array.from({ length: 23 }, (_, i) => `D${i + 1}`))
  })

  it('has exactly the ten states, four of them terminal', () => {
    expect(DELEGATION_STATES).toHaveLength(10)
    expect([...DELEGATION_TERMINAL_STATES]).toEqual([
      'succeeded',
      'failed',
      'cancelled',
      'abandoned',
    ])
  })

  for (const row of ROWS) {
    it(`${row.id}: ${row.from ?? '—'} --${row.trigger}--> ${row.to} (${row.label})`, () => {
      const outcome = delegationMachine.transition(row.from, row.trigger)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.state).toBe(row.to)
      expect(outcome.rowId).toBe(row.id)
    })
  }

  it('D17: every non-terminal state cancels on cancel_delegation, and a terminal one does not', () => {
    for (const state of NON_TERMINAL) {
      const outcome = delegationMachine.transition(state, 'cancel_delegation')
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) continue
      expect(outcome.state).toBe('cancelled')
      /* D3 refines D17 for `queued`; both agree on the target, and the specific row is reported. */
      expect(outcome.rowId).toBe(state === 'queued' ? 'D3' : 'D17')
    }
    for (const state of DELEGATION_TERMINAL_STATES) {
      const outcome = delegationMachine.transition(state, 'cancel_delegation')
      expect(outcome.ok).toBe(false)
      if (outcome.ok) continue
      expect(outcome.reason).toBe('illegal_from')
    }
  })

  it('D19: retry and a late sendTurn reopen any terminal state as queued', () => {
    for (const state of DELEGATION_TERMINAL_STATES) {
      for (const trigger of ['retry', 'send_turn'] as const) {
        const outcome = delegationMachine.transition(state, trigger)
        expect(outcome.ok).toBe(true)
        if (!outcome.ok) continue
        expect(outcome.state).toBe('queued')
        expect(outcome.rowId).toBe('D19')
      }
    }
  })

  it('D23: killSwitch changes NO delegation state, from any of the ten (Q16, #31)', () => {
    for (const state of DELEGATION_STATES) {
      const outcome = delegationMachine.transition(state, 'kill_switch')
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) continue
      expect(outcome.state).toBe(state)
      expect(outcome.deleted).toBe(false)
      expect(outcome.rowId).toBe('D23')
    }
  })

  it('the kill switch is NOT a path to cancelled — cancel{scope:delegation} is the only one', () => {
    const cancelling = DELEGATION_TRANSITIONS.filter((r) => r.to === 'cancelled')
    expect(cancelling.map((r) => r.id)).toEqual(['D3', 'D17'])
    for (const row of cancelling) {
      expect(row.triggers).toEqual(['cancel_delegation'])
    }
  })

  it('rejects a transition the table does not contain, and says which kind of rejection', () => {
    const illegal = delegationMachine.transition('queued', 'verification_passed')
    expect(illegal.ok).toBe(false)
    if (!illegal.ok) expect(illegal.reason).toBe('illegal_from')

    const unknown = delegationMachine.transition('queued', 'teleport' as DelegationTrigger)
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.reason).toBe('unknown_trigger')
  })

  it('D1 is the only creation edge, and it cannot be re-fired from a state', () => {
    const creations = DELEGATION_TRANSITIONS.filter((r) => r.from === '—')
    expect(creations.map((r) => r.id)).toEqual(['D1'])
    expect(delegationMachine.transition('queued', 'created').ok).toBe(false)
  })

  it('every row names who fires it, which is what tells a reader if it is a decision or an observation', () => {
    for (const row of DELEGATION_TRANSITIONS) {
      expect(row.firedBy).toBeTruthy()
      expect(row.note.length).toBeGreaterThan(10)
    }
  })
})
