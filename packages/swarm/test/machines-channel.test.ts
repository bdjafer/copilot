/**
 * SPEC-swarm §3.3 — `ChannelState`, rows **C1–C15**, one test per row.
 *
 * `ChannelState` is **per attempt, per executor session** (PRODUCT §4.2), never per delegation:
 * with `parallelAttempts: 3` there are three of these machines under one delegation, and a head
 * that assumed one channel would send the right words to the wrong agent.
 */

import { describe, expect, it } from 'vitest'

import type { ChannelState } from '../src/types.ts'

import {
  CHANNEL_STATES,
  CHANNEL_TERMINAL_STATES,
  CHANNEL_TRANSITIONS,
  channelMachine,
  type ChannelTrigger,
} from '../src/domain/machines.ts'

const NON_TERMINAL = CHANNEL_STATES.filter(
  (s) => !(CHANNEL_TERMINAL_STATES as readonly ChannelState[]).includes(s),
)

interface Row {
  readonly id: string
  readonly from: ChannelState
  readonly trigger: ChannelTrigger
  readonly to: ChannelState
  readonly label: string
}

const ROWS: readonly Row[] = [
  {
    id: 'C1',
    from: 'detached',
    trigger: 'connection_opened',
    to: 'attaching',
    label: 'attach_session written',
  },
  {
    id: 'C2',
    from: 'attaching',
    trigger: 'attached',
    to: 'idle',
    label: 'attached; writer lease held with fence f',
  },
  {
    id: 'C3',
    from: 'attaching',
    trigger: 'attach_failed',
    to: 'disconnected',
    label: 'socket error or 10 s timeout',
  },
  { id: 'C4', from: 'idle', trigger: 'submit', to: 'submitting', label: 'submit() under fence f' },
  {
    id: 'C5',
    from: 'submitting',
    trigger: 'message_accepted',
    to: 'accepted',
    label: 'message_accepted for this session',
  },
  {
    id: 'C6',
    from: 'submitting',
    trigger: 'submit_failed',
    to: 'disconnected',
    label: 'write error or acceptTimeoutMs',
  },
  {
    id: 'C7',
    from: 'accepted',
    trigger: 'first_stream_event',
    to: 'streaming',
    label: 'first delta or tool_start',
  },
  { id: 'C8', from: 'streaming', trigger: 'turn_done', to: 'idle', label: 'turn_done' },
  {
    id: 'C9',
    from: 'streaming',
    trigger: 'interrupt_issued',
    to: 'interrupting',
    label: 'cancel or softInterrupt issued',
  },
  {
    id: 'C10',
    from: 'interrupting',
    trigger: 'turn_done',
    to: 'idle',
    label: 'turn_done after the interrupt',
  },
  {
    id: 'C11',
    from: 'interrupting',
    trigger: 'interrupt_merged',
    to: 'streaming',
    label: '3 s of deltas with no turn_done',
  },
  {
    id: 'C13',
    from: 'disconnected',
    trigger: 'reconnect',
    to: 'attaching',
    label: 'supervised reconnect',
  },
  {
    id: 'C14',
    from: 'disconnected',
    trigger: 'reconnect_exhausted',
    to: 'closed',
    label: 'terminal attempt or budget exhausted',
  },
  {
    id: 'C15',
    from: 'idle',
    trigger: 'close',
    to: 'closed',
    label: 'close() — the ONLY lease release',
  },
]

describe('§3.3 ChannelState — the C-table', () => {
  it('declares 15 rows, C1..C15, each exactly once', () => {
    const ids = CHANNEL_TRANSITIONS.map((r) => r.id)
    expect(ids).toHaveLength(15)
    expect(ids).toEqual(Array.from({ length: 15 }, (_, i) => `C${i + 1}`))
  })

  it('has exactly the nine states, with `closed` the only terminal one', () => {
    expect(CHANNEL_STATES).toHaveLength(9)
    expect([...CHANNEL_TERMINAL_STATES]).toEqual(['closed'])
  })

  for (const row of ROWS) {
    it(`${row.id}: ${row.from} --${row.trigger}--> ${row.to} (${row.label})`, () => {
      const outcome = channelMachine.transition(row.from, row.trigger)
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) return
      expect(outcome.state).toBe(row.to)
      expect(outcome.rowId).toBe(row.id)
    })
  }

  it('C12: any non-terminal state disconnects on socket close, instance death or heartbeat loss', () => {
    for (const state of NON_TERMINAL) {
      const outcome = channelMachine.transition(state, 'socket_closed')
      expect(outcome.ok).toBe(true)
      if (!outcome.ok) continue
      expect(outcome.state).toBe('disconnected')
      expect(outcome.rowId).toBe('C12')
    }
  })

  it('C12 does not resurrect a closed channel: `closed` has already released its lease (#10)', () => {
    const outcome = channelMachine.transition('closed', 'socket_closed')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toBe('illegal_from')
  })

  it('C15: close() is the ONLY row that reaches `closed` from a live channel (§5.4 #9)', () => {
    const toClosed = CHANNEL_TRANSITIONS.filter((r) => r.to === 'closed')
    expect(toClosed.map((r) => r.id).sort()).toEqual(['C14', 'C15'])
    /* C14 is the supervisor giving up on an already-disconnected channel; C15 is the release. */
    expect(toClosed.find((r) => r.id === 'C15')?.triggers).toEqual(['close'])
    expect(channelMachine.transition('streaming', 'close').ok).toBe(false)
  })

  it('turn_done means different things from `streaming` and from `interrupting` (C8 vs C10)', () => {
    const streaming = channelMachine.transition('streaming', 'turn_done')
    const interrupting = channelMachine.transition('interrupting', 'turn_done')
    expect(streaming.ok && streaming.rowId).toBe('C8')
    expect(interrupting.ok && interrupting.rowId).toBe('C10')
  })

  it('there is no path from `detached` straight to `idle` — attaching is observable', () => {
    expect(channelMachine.transition('detached', 'attached').ok).toBe(false)
  })
})

/**
 * The whole cross product. Transcribed from §3.3's C-table, not derived from
 * `CHANNEL_TRANSITIONS`, so it is an independent statement of the same contract.
 */
const CHANNEL_TRIGGERS = [
  'connection_opened',
  'attached',
  'attach_failed',
  'submit',
  'message_accepted',
  'submit_failed',
  'first_stream_event',
  'turn_done',
  'interrupt_issued',
  'interrupt_merged',
  'socket_closed',
  'reconnect',
  'reconnect_exhausted',
  'close',
] as const satisfies readonly ChannelTrigger[]

const LEGAL_CHANNEL_PAIRS: ReadonlySet<string> = new Set<string>([
  ...ROWS.map((row) => `${row.from}|${row.trigger}`),
  /* C12 — any non-terminal channel disconnects; `closed` has already released (§5.4 #9). */
  ...NON_TERMINAL.map((state) => `${state}|socket_closed`),
])

describe('§3.3 ChannelState — the illegal half of the table', () => {
  it('accepts exactly the legal (state × trigger) pairs and rejects every other one', () => {
    const wronglyAccepted: string[] = []
    const wronglyRejected: string[] = []
    for (const state of CHANNEL_STATES) {
      for (const trigger of CHANNEL_TRIGGERS) {
        const key = `${state}|${trigger}`
        const outcome = channelMachine.transition(state, trigger)
        if (LEGAL_CHANNEL_PAIRS.has(key)) {
          if (!outcome.ok) wronglyRejected.push(key)
          continue
        }
        if (outcome.ok) wronglyAccepted.push(key)
        else expect({ key, reason: outcome.reason }).toEqual({ key, reason: 'illegal_from' })
      }
    }
    expect(wronglyAccepted).toEqual([])
    expect(wronglyRejected).toEqual([])
    expect(
      CHANNEL_STATES.length * CHANNEL_TRIGGERS.length - LEGAL_CHANNEL_PAIRS.size,
    ).toBeGreaterThan(90)
  })

  it('a `closed` channel accepts nothing at all — the lease is already released (#10)', () => {
    for (const trigger of CHANNEL_TRIGGERS) {
      expect({ trigger, ok: channelMachine.transition('closed', trigger).ok }).toEqual({
        trigger,
        ok: false,
      })
    }
  })
})
