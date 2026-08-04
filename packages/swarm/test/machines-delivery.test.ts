/**
 * SPEC-swarm §3.3 — `DeliveryState`, rows **V1–V14**, one test per row.
 *
 * This is the machine X4, Q5 and success criterion 5 all sit on: `unknown` is first-class and
 * user-visible, it is **not** terminal, and the only ways out of it are reconciliation (V9) or an
 * explicit human decision (V10). A design that made `unknown` terminal — or that hid it behind a
 * spinner — would turn "did my message land?" into a question the product cannot answer.
 */

import { describe, expect, it } from 'vitest'

import type { DeliveryState } from '../src/types.ts'

import {
  DELIVERY_STATES,
  DELIVERY_TERMINAL_STATES,
  DELIVERY_TRANSITIONS,
  deliveryMachine,
  type DeliveryTrigger,
} from '../src/domain/machines.ts'

interface Row {
  readonly id: string
  readonly from: DeliveryState | null
  readonly trigger: DeliveryTrigger
  readonly to: DeliveryState | null
  readonly label: string
}

const ROWS: readonly Row[] = [
  {
    id: 'V1',
    from: null,
    trigger: 'persisted',
    to: 'prepared',
    label: 'persisted BEFORE any wire write',
  },
  {
    id: 'V2',
    from: 'prepared',
    trigger: 'written',
    to: 'sent',
    label: 'frame written to the executor',
  },
  {
    id: 'V3',
    from: 'prepared',
    trigger: 'refused_preflight',
    to: 'failed',
    label: 'lease lost, banned effort, mid-turn config, budget',
  },
  {
    id: 'V4',
    from: 'sent',
    trigger: 'message_accepted',
    to: 'accepted',
    label: 'message_accepted observed',
  },
  {
    id: 'V5',
    from: 'sent',
    trigger: 'accept_timeout',
    to: 'unknown',
    label: "swarm's own acceptTimeoutMs elapsed",
  },
  {
    id: 'V5',
    from: 'sent',
    trigger: 'disconnect_before_ack',
    to: 'unknown',
    label: 'disconnect before the ack',
  },
  {
    id: 'V6',
    from: 'accepted',
    trigger: 'first_stream_event',
    to: 'running',
    label: 'first stream event of this turn',
  },
  { id: 'V7', from: 'running', trigger: 'turn_done', to: 'ended', label: 'turn_done' },
  {
    id: 'V8',
    from: 'running',
    trigger: 'disconnect_before_turn_done',
    to: 'unknown',
    label: 'disconnect before turn_done',
  },
  {
    id: 'V10',
    from: 'unknown',
    trigger: 'resend_resolved',
    to: 'failed',
    label: 'the user confirmed a resend or discarded it',
  },
  {
    id: 'V11',
    from: 'sent',
    trigger: 'session_error',
    to: 'failed',
    label: 'error frame on the session connection',
  },
  {
    id: 'V11',
    from: 'accepted',
    trigger: 'session_error',
    to: 'failed',
    label: 'error frame after the ack',
  },
  {
    id: 'V13',
    from: 'accepted',
    trigger: 'context_only_ack',
    to: 'ended',
    label: 'contextOnly ends on its ack — no turn_done exists',
  },
  {
    id: 'V14',
    from: 'sent',
    trigger: 'retract_interrupt',
    to: 'prepared',
    label: 'session-wide interrupt retract from sent',
  },
  {
    id: 'V14',
    from: 'accepted',
    trigger: 'retract_interrupt',
    to: 'prepared',
    label: 'session-wide interrupt retract from accepted',
  },
]

describe('§3.3 DeliveryState — the V-table', () => {
  it('declares 14 rows, V1..V14, each exactly once', () => {
    const ids = DELIVERY_TRANSITIONS.map((r) => r.id)
    expect(ids).toHaveLength(14)
    expect(ids).toEqual(Array.from({ length: 14 }, (_, i) => `V${i + 1}`))
  })

  it('has exactly the seven states, and `unknown` is NOT terminal (X4, Q5)', () => {
    expect(DELIVERY_STATES).toHaveLength(7)
    expect([...DELIVERY_TERMINAL_STATES]).toEqual(['ended', 'failed'])
    expect(DELIVERY_TERMINAL_STATES).not.toContain('unknown')
  })

  for (const row of ROWS) {
    it(`${row.id}: ${row.from ?? '—'} --${row.trigger}--> ${row.to} (${row.label})`, () => {
      const outcome = deliveryMachine.transition(row.from, row.trigger)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.state).toBe(row.to)
      expect(outcome.rowId).toBe(row.id)
    })
  }

  it('V9: reconciliation resolves `unknown` to accepted, running OR ended — and must name which', () => {
    const unnamed = deliveryMachine.transition('unknown', 'reconciled_positive')
    expect(unnamed.ok).toBe(false)
    if (!unnamed.ok) expect(unnamed.reason).toBe('target_required')

    for (const target of ['accepted', 'running', 'ended'] as const) {
      const outcome = deliveryMachine.transition('unknown', 'reconciled_positive', { to: target })
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) continue
      expect(outcome.state).toBe(target)
      expect(outcome.rowId).toBe('V9')
    }

    const impossible = deliveryMachine.transition('unknown', 'reconciled_positive', {
      to: 'failed',
    })
    expect(impossible.ok).toBe(false)
    if (!impossible.ok) expect(impossible.reason).toBe('target_not_allowed')
  })

  it('V12: a retract before the write DELETES the queue row; the audit row is kept elsewhere', () => {
    const outcome = deliveryMachine.transition('prepared', 'retract_before_write')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.rowId).toBe('V12')
    expect(outcome.deleted).toBe(true)
    expect(outcome.state).toBeNull()
  })

  it('V13 is the ONLY path to `ended` that is not turn_done (#32)', () => {
    const toEnded = DELIVERY_TRANSITIONS.filter(
      (r) => r.to === 'ended' || (Array.isArray(r.to) && r.to.includes('ended')),
    )
    expect(toEnded.map((r) => r.id).sort()).toEqual(['V13', 'V7', 'V9'].sort())
    /* Without V13 a noReply turn had no route to `ended` at all: V7 needs turn_done and V6 needs
     * a stream event, and a context-only message produces neither. */
    expect(deliveryMachine.transition('accepted', 'turn_done').ok).toBe(false)
  })

  it('an unknown delivery never resolves itself: only V9 and V10 leave it', () => {
    const fromUnknown = DELIVERY_TRANSITIONS.filter(
      (r) => Array.isArray(r.from) && (r.from as readonly string[]).includes('unknown'),
    )
    expect(fromUnknown.map((r) => r.id).sort()).toEqual(['V10', 'V9'].sort())
    expect(deliveryMachine.transition('unknown', 'turn_done').ok).toBe(false)
    expect(deliveryMachine.transition('unknown', 'written').ok).toBe(false)
  })

  it('V5 has two triggers because there are two ways to learn nothing (§5.4 #3, [F2])', () => {
    const v5 = DELIVERY_TRANSITIONS.find((r) => r.id === 'V5')
    expect(v5?.triggers).toEqual(['accept_timeout', 'disconnect_before_ack'])
    expect(v5?.firedBy).toBe('adapter')
  })

  it('a context-only turn never enters `running` (§3.3 note, #32)', () => {
    const prepared = deliveryMachine.transition(null, 'persisted')
    expect(prepared.ok && prepared.state).toBe('prepared')
    const sent = deliveryMachine.transition('prepared', 'written')
    expect(sent.ok && sent.state).toBe('sent')
    const accepted = deliveryMachine.transition('sent', 'message_accepted')
    expect(accepted.ok && accepted.state).toBe('accepted')
    const ended = deliveryMachine.transition('accepted', 'context_only_ack')
    expect(ended.ok && ended.state).toBe('ended')
  })
})

/**
 * The whole cross product. Transcribed from §3.3's V-table, not derived from
 * `DELIVERY_TRANSITIONS`.
 */
const DELIVERY_TRIGGERS = [
  'persisted',
  'written',
  'refused_preflight',
  'message_accepted',
  'accept_timeout',
  'disconnect_before_ack',
  'first_stream_event',
  'turn_done',
  'disconnect_before_turn_done',
  'reconciled_positive',
  'resend_resolved',
  'session_error',
  'retract_before_write',
  'context_only_ack',
  'retract_interrupt',
] as const satisfies readonly DeliveryTrigger[]

const LEGAL_DELIVERY_PAIRS: ReadonlySet<string> = new Set<string>([
  ...ROWS.filter((row) => row.from !== null).map((row) => `${row.from}|${row.trigger}`),
  /* Two rows are asserted above rather than declared in `ROWS`, because neither has a plain
   * target: V9 is multi-target, and V12 DELETES the queue row instead of moving it. */
  'unknown|reconciled_positive',
  'prepared|retract_before_write',
])

describe('§3.3 DeliveryState — the illegal half of the table', () => {
  it('accepts exactly the legal (state × trigger) pairs and rejects every other one', () => {
    const wronglyAccepted: string[] = []
    const wronglyRejected: string[] = []
    for (const state of DELIVERY_STATES) {
      for (const trigger of DELIVERY_TRIGGERS) {
        const key = `${state}|${trigger}`
        const outcome = deliveryMachine.transition(state, trigger)
        if (LEGAL_DELIVERY_PAIRS.has(key)) {
          /* V9 is the one multi-target row: legal, but the reducer refuses to guess which of
           * `accepted|running|ended` reconciliation found (`target_required`). */
          if (!outcome.ok && outcome.reason !== 'target_required') wronglyRejected.push(key)
          continue
        }
        if (outcome.ok) wronglyAccepted.push(key)
        else expect({ key, reason: outcome.reason }).toEqual({ key, reason: 'illegal_from' })
      }
    }
    expect(wronglyAccepted).toEqual([])
    expect(wronglyRejected).toEqual([])
    expect(
      DELIVERY_STATES.length * DELIVERY_TRIGGERS.length - LEGAL_DELIVERY_PAIRS.size,
    ).toBeGreaterThan(80)
  })

  it('`unknown` is not terminal — it still accepts the rows that resolve it (X4, Q5)', () => {
    /* V9 names three possible targets and will not pick one for the caller. */
    const reconciled = deliveryMachine.transition('unknown', 'reconciled_positive', {
      to: 'running',
    })
    expect(reconciled.ok && reconciled.state).toBe('running')
    expect(deliveryMachine.transition('unknown', 'reconciled_positive').ok).toBe(false)
    expect(deliveryMachine.transition('unknown', 'resend_resolved').ok).toBe(true)
    /* And nothing else leaves it: `session_error` is V11's, from `sent`/`accepted` only. */
    expect(deliveryMachine.transition('unknown', 'session_error').ok).toBe(false)
  })

  it('a terminal delivery accepts nothing', () => {
    for (const state of DELIVERY_TERMINAL_STATES) {
      for (const trigger of DELIVERY_TRIGGERS) {
        expect({ state, trigger, ok: deliveryMachine.transition(state, trigger).ok }).toEqual({
          state,
          trigger,
          ok: false,
        })
      }
    }
  })
})
