/**
 * SPEC-swarm §6.2, §6.2.1 and §6.4–6.6 — what the client turns wire events into.
 *
 * `client-connection` and `client-streams` prove the client talks `swarm.v1` correctly; this file
 * proves that what comes out the other side is a view model a head can trust:
 *
 *  - **the 34 → 23 projection is reachable, not just declarable.** `protocolConformance()` asserts
 *    `EVENT_PROJECTION` is total against `SwarmClientEvents` as a *table*; a table says nothing
 *    about whether the client ever raises a key. Here every one of the 23 is driven from a frame.
 *  - **projection is deterministic.** Same frames + same injected clock ⇒ byte-identical stores,
 *    and a snapshot of a state converges with the replay that produced it (§2.3). Without this,
 *    "re-subscription from snapshot reproduces byte-identical state" (§13) is a server-only claim
 *    and the head's own copy is free to disagree.
 *  - **the attention score is the arithmetic of §6.4–6.6 and orders the fleet** (F2), including
 *    the tie-break, which is what stops a list from jittering between two equal rows.
 *  - **every published view model is frozen and `structuredClone`-able** (§6.2, H5).
 */

import { describe, expect, it } from 'vitest'

import type { SwarmEvent } from '../src/protocol/events.ts'
import type { TestClient } from '../src/testing/client-harness.ts'
import type { DelegationVM } from '../src/types.ts'

import { emptySpendCounters } from '../src/domain/budget.ts'
import { ATTENTION_WEIGHTS } from '../src/domain/rollup.ts'
import {
  createTestClient,
  makeAttemptSnapshot,
  makeFleetSnapshot,
  makeServerSnapshot,
} from '../src/testing/client-harness.ts'
import {
  makeAttemptVM,
  makeConfirmationRequest,
  makeDelegationVM,
  makeHealthVM,
  makeKillReport,
  makeLandingRecord,
  makeNoticeVM,
  makeRetractReport,
  makeTurnVM,
  makeVerificationRun,
} from '../src/testing/fixtures.ts'
import { SWARM_CLIENT_EVENT_KEYS } from '../src/types.ts'

const TS = 5_000

/** Frozen-deep check: §6.2 freezes the VM *and* everything reachable from it. */
function assertDeeplyFrozen(value: unknown, path = '$'): void {
  if (typeof value !== 'object' || value === null) return
  expect({ path, frozen: Object.isFrozen(value) }).toEqual({ path, frozen: true })
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    assertDeeplyFrozen(child, `${path}.${key}`)
  }
}

/** The published surface as one comparable value — no clocks, no identities, just state. */
function snapshotOf(harness: TestClient): string {
  return JSON.stringify({
    delegations: [...harness.client.delegations.get().entries()],
    fleet: harness.client.fleet.get(),
    health: harness.client.health.get(),
    notices: harness.client.notices.get(),
  })
}

/**
 * One script that touches every projected surface: a delegation, an attempt, a turn through its
 * whole delivery, a verification, a landing and the fleet counters around them.
 */
function driveFullScript(harness: TestClient): void {
  harness.start()
  harness.transport.evt('server', 1, { k: 'server.health', health: makeHealthVM() }, TS)
  harness.transport.evt(
    'fleet',
    1,
    { k: 'fleet.delegation_created', delegation: makeDelegationVM() },
    TS,
  )
  harness.client.focus('delegation-1')
  harness.transport.evt(
    'delegation:delegation-1',
    1,
    { k: 'deleg.attempt_started', attempt: makeAttemptVM() },
    TS,
  )
  harness.transport.evt(
    'delegation:delegation-1',
    2,
    { k: 'deleg.turn_prepared', turn: makeTurnVM() },
    TS,
  )
  harness.transport.evt(
    'delegation:delegation-1',
    3,
    {
      k: 'deleg.turn_delivery',
      turnId: 'turn-1',
      delivery: 'running',
      detail: { ackAtMs: TS, correlated: false, landing: 'confirmed' },
    },
    TS,
  )
  harness.transport.evt(
    'delegation:delegation-1',
    4,
    { k: 'deleg.turn_ended', turnId: 'turn-1', usage: { input: 10, output: 20 }, toolCalls: 2 },
    TS,
  )
  harness.transport.evt(
    'delegation:delegation-1',
    5,
    { k: 'deleg.verify_result', run: makeVerificationRun() },
    TS,
  )
  harness.transport.evt(
    'delegation:delegation-1',
    6,
    { k: 'deleg.landed', landing: makeLandingRecord() },
    TS,
  )
  harness.transport.evt(
    'fleet',
    2,
    {
      k: 'fleet.caps',
      concurrency: { runningAttempts: 1, cap: 4, queued: 0 },
      dispatchPaused: false,
    },
    TS,
  )
}

describe('§6.4 the head-facing event map — every declared key is reachable from the wire', () => {
  it('raises all 23 keys of `SwarmClientEvents` and no key it never declared', () => {
    const harness = createTestClient()
    const seen = new Set<string>()
    harness.client.subscribe((key) => {
      seen.add(key)
    })

    harness.start() /* `connection` */

    harness.transport.evt('server', 1, { k: 'server.health', health: makeHealthVM() }, TS)
    harness.transport.evt('server', 2, { k: 'server.notice', notice: makeNoticeVM() }, TS)
    harness.transport.evt(
      'server',
      3,
      { k: 'server.confirmation', request: makeConfirmationRequest() },
      TS,
    )

    harness.transport.evt(
      'fleet',
      1,
      { k: 'fleet.delegation_created', delegation: makeDelegationVM() },
      TS,
    )
    harness.transport.evt(
      'fleet',
      2,
      { k: 'fleet.delegation_summary', delegation: makeDelegationVM({ title: 'Renamed' }) },
      TS,
    )
    /* One kind, two keys: `delegation:state` always, `needs-you` when the state is the ask. */
    harness.transport.evt(
      'fleet',
      3,
      {
        k: 'fleet.delegation_state',
        delegationId: 'delegation-1',
        state: 'needs-you',
        bucket: 'needs-you',
        version: 2,
      },
      TS,
    )
    harness.transport.evt(
      'fleet',
      4,
      {
        k: 'fleet.spend',
        spend: { ...emptySpendCounters(), estUsd: 9, capUsd: 10 },
      },
      TS,
    )

    harness.client.focus('delegation-1')
    const deleg = (seq: number, event: SwarmEvent): void => {
      harness.transport.evt('delegation:delegation-1', seq, event, TS)
    }
    deleg(1, { k: 'deleg.attempt_started', attempt: makeAttemptVM() })
    deleg(2, { k: 'deleg.turn_prepared', turn: makeTurnVM() })
    deleg(3, {
      k: 'deleg.turn_delivery',
      turnId: 'turn-1',
      delivery: 'running',
      detail: { ackAtMs: TS, correlated: false, landing: 'confirmed' },
    })
    deleg(4, {
      k: 'deleg.turn_ended',
      turnId: 'turn-1',
      usage: { input: 1, output: 2 },
      toolCalls: 1,
    })
    deleg(5, { k: 'deleg.turn_retracted', report: makeRetractReport() })
    deleg(6, {
      k: 'deleg.verify_started',
      attemptId: 'attempt-1',
      runId: 'run-1',
      reason: 'auto-turn-end',
    })
    deleg(7, { k: 'deleg.verify_result', run: makeVerificationRun() })
    deleg(8, { k: 'deleg.landed', landing: makeLandingRecord() })
    deleg(9, { k: 'deleg.drift', attemptId: 'attempt-1', kind: 'model', detail: 'shadow differs' })
    deleg(10, {
      k: 'deleg.evidence',
      attemptId: 'attempt-1',
      evidenceRef: 'evidence/attempt-1',
      manifestDigest: 'sha256:0',
    })
    deleg(11, { k: 'deleg.attempt_ended', attemptId: 'attempt-1', outcome: 'verified' })

    /* The three keys that are not a projected `evt` at all. */
    harness.transport.lagged('fleet', 4, 'backpressure') /* `stream:lagged` */
    harness.transport.fail(null, 'rate_limited', 'slow down', true) /* `error` */
    harness.transport.serverClose(1006)
    harness.transport.handshake({ serverVersion: '9.9.9' }) /* `server-changed` */

    expect([...seen].sort()).toEqual([...SWARM_CLIENT_EVENT_KEYS].sort())
    harness.destroy()
  })

  it('`subscribe` sees the same keys `on` does, so a bridge cannot miss one (§6.2)', () => {
    const harness = createTestClient()
    const viaOn: string[] = []
    const viaSubscribe: string[] = []
    harness.client.on('delegation:create', () => viaOn.push('delegation:create'))
    harness.client.subscribe((key) => {
      if (key === 'delegation:create') viaSubscribe.push(key)
    })
    harness.start()
    harness.transport.evt(
      'fleet',
      1,
      { k: 'fleet.delegation_created', delegation: makeDelegationVM() },
      TS,
    )
    expect(viaOn).toEqual(['delegation:create'])
    expect(viaSubscribe).toEqual(['delegation:create'])
    harness.destroy()
  })
})

describe('§6.2 projection is deterministic', () => {
  it('the same frames and the same clock produce byte-identical stores', () => {
    const a = createTestClient({ startAtMs: TS })
    const b = createTestClient({ startAtMs: TS })
    driveFullScript(a)
    driveFullScript(b)
    expect(snapshotOf(a)).toEqual(snapshotOf(b))
    /* And it is not vacuously equal: the script actually produced a delegation. */
    expect(a.client.delegations.get().size).toBe(1)
    a.destroy()
    b.destroy()
  })

  it('a snapshot of the replayed state converges with the replay itself (§2.3, §13)', () => {
    const replayed = createTestClient({ startAtMs: TS })
    driveFullScript(replayed)
    const projected = replayed.client.delegations.get().get('delegation-1') as DelegationVM

    /* What the server would have materialized at that `seq` is exactly this row. */
    const resumed = createTestClient({ startAtMs: TS })
    resumed.transport.handshake()
    resumed.transport.snap('server', 1, makeServerSnapshot({ health: makeHealthVM() }))
    resumed.transport.snap('fleet', 2, makeFleetSnapshot({ delegations: [projected] }))

    expect(JSON.stringify([...resumed.client.delegations.get().entries()])).toEqual(
      JSON.stringify([...replayed.client.delegations.get().entries()]),
    )
    replayed.destroy()
    resumed.destroy()
  })

  it('re-projecting an unchanged delegation hands back the identical object (§6.2)', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    harness.transport.evt(
      'fleet',
      1,
      { k: 'fleet.delegation_created', delegation: makeDelegationVM() },
      TS,
    )
    const first = harness.client.delegations.get().get('delegation-1')
    /* A summary carrying the same row is a re-projection, not a change. */
    harness.transport.evt(
      'fleet',
      2,
      { k: 'fleet.delegation_summary', delegation: makeDelegationVM() },
      TS,
    )
    expect(harness.client.delegations.get().get('delegation-1')).toBe(first)
    harness.destroy()
  })
})

describe('§6.4–6.6 the attention score orders the fleet (F2)', () => {
  const failedAt = (id: string, ageMinutes: number): SwarmEvent => ({
    k: 'fleet.delegation_created',
    delegation: makeDelegationVM({
      id,
      state: 'failed',
      /* The wire carries one age signal — the server's own score — which the client inverts on
       * first sight and then keeps with its own clock (§6.2's determinism). §6.4–6.6's formula
       * caps its own age term at `ageCap`, so a legal wire score is capped too: an uncapped one
       * would not be an old delegation, it would be a server disagreeing about the flags. */
      attentionScore: ATTENTION_WEIGHTS.failed + Math.min(ATTENTION_WEIGHTS.ageCap, ageMinutes),
    }),
  })

  it('sorts a bucket by score descending, recovering age from the server score', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    harness.transport.evt('fleet', 1, failedAt('d-new', 0), TS)
    harness.transport.evt('fleet', 2, failedAt('d-old', 50), TS)
    harness.transport.evt('fleet', 3, failedAt('d-mid', 5), TS)

    const vms = harness.client.delegations.get()
    expect(vms.get('d-old')?.attentionScore).toBe(ATTENTION_WEIGHTS.failed + 50)
    expect(vms.get('d-mid')?.attentionScore).toBe(ATTENTION_WEIGHTS.failed + 5)
    expect(vms.get('d-new')?.attentionScore).toBe(ATTENTION_WEIGHTS.failed)
    expect(harness.client.fleet.get().buckets.failed).toEqual(['d-old', 'd-mid', 'd-new'])
    harness.destroy()
  })

  it('breaks a tie by `updatedAt` desc, then by id — a total order that never jitters', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    /* Equal scores, equal timestamps ⇒ id ascending. */
    harness.transport.evt('fleet', 1, failedAt('d-b', 0), TS)
    harness.transport.evt('fleet', 2, failedAt('d-a', 0), TS)
    expect(harness.client.fleet.get().buckets.failed).toEqual(['d-a', 'd-b'])

    /* Now move one forward in time: `updatedAt` desc outranks the id. */
    harness.transport.evt(
      'fleet',
      3,
      {
        k: 'fleet.delegation_summary',
        delegation: makeDelegationVM({ id: 'd-b', state: 'failed' }),
      },
      TS + 60_000,
    )
    expect(harness.client.fleet.get().buckets.failed).toEqual(['d-b', 'd-a'])
    harness.destroy()
  })

  it('caps the age term at 199, so age never outranks a signal the other row carries', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    harness.transport.evt('fleet', 1, failedAt('d-ancient', 10_000), TS)
    /* Same bucket, same flags but one more signal — and no amount of waiting overtakes it,
     * because the cap (199) is below the smallest weight in the table (400). */
    harness.transport.evt(
      'fleet',
      2,
      {
        k: 'fleet.delegation_created',
        delegation: makeDelegationVM({
          id: 'd-stale',
          state: 'failed',
          staleBase: true,
          attentionScore: ATTENTION_WEIGHTS.failed + ATTENTION_WEIGHTS.staleBase,
        }),
      },
      TS,
    )
    const ancient = harness.client.delegations.get().get('d-ancient') as DelegationVM
    expect(ancient.attentionScore).toBe(ATTENTION_WEIGHTS.failed + ATTENTION_WEIGHTS.ageCap)
    expect(ATTENTION_WEIGHTS.ageCap).toBeLessThan(ATTENTION_WEIGHTS.staleBase)
    expect(harness.client.fleet.get().buckets.failed).toEqual(['d-stale', 'd-ancient'])

    /* And the cap is the CLIENT's too, not only the server's: the client keeps its own clock
     * from the recovered `createdAtMs`, so ten thousand more minutes must not add a point. */
    harness.clock.advance(10_000 * 60_000)
    harness.transport.evt('fleet', 3, failedAt('d-tick', 0), TS)
    expect((harness.client.delegations.get().get('d-ancient') as DelegationVM).attentionScore).toBe(
      ATTENTION_WEIGHTS.failed + ATTENTION_WEIGHTS.ageCap,
    )
    harness.destroy()
  })

  it('counts every delegation but lists only the filtered ones (§6.2)', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    harness.transport.evt('fleet', 1, failedAt('d-a', 0), TS)
    harness.transport.evt(
      'fleet',
      2,
      { k: 'fleet.delegation_created', delegation: makeDelegationVM({ id: 'd-run' }) },
      TS,
    )
    harness.client.setFilter({ buckets: ['failed'] })
    const fleet = harness.client.fleet.get()
    expect(fleet.buckets.working).toEqual([])
    expect(fleet.counts.working).toBe(1)
    expect(fleet.buckets.failed).toEqual(['d-a'])
    harness.destroy()
  })
})

describe('§6.2 the fleet-level rules the client projects', () => {
  it('the kill switch pauses dispatch and terminalizes nothing (Q16, #31)', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    harness.transport.evt(
      'fleet',
      1,
      { k: 'fleet.delegation_created', delegation: makeDelegationVM() },
      TS,
    )
    harness.transport.evt(
      'fleet',
      2,
      { k: 'fleet.kill_switch', report: makeKillReport({ turnsCancelled: ['turn-1'] }) },
      TS,
    )
    const fleet = harness.client.fleet.get()
    expect(fleet.dispatchPaused).toBe(true)
    /* A panic stop that destroys N delegations and forces N retries is not a panic stop. */
    const vm = harness.client.delegations.get().get('delegation-1') as DelegationVM
    expect(vm.state).toBe('running')
    expect(vm.bucket).toBe('working')
    expect(fleet.counts.cancelled).toBe(0)
    harness.destroy()
  })

  it('a partial kill raises `capability-absent` and refuses to be dismissed (§13, [F1])', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    harness.transport.evt(
      'fleet',
      1,
      {
        k: 'fleet.kill_switch',
        report: makeKillReport({
          instancesKilled: [
            {
              pgid: 4242,
              signalled: ['SIGTERM'],
              survivors: [],
              daemonPid: null,
              daemonStopped: false,
              durationMs: 12,
            },
          ],
        }),
      },
      TS,
    )
    const notice = harness.client.notices
      .get()
      .find((candidate) => candidate.kind === 'capability-absent')
    expect(notice).toBeDefined()
    expect(notice?.severity).toBe('error')
    /* A partial stop is never reported as a stop, and never quietly dismissed. */
    expect(notice?.dismissible).toBe(false)
    harness.destroy()
  })

  it('raises `budget` at the soft fraction and again at the hard cap (§3.4)', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    const levels: string[] = []
    harness.client.on('budget', (event) => levels.push(event.level))
    const spend = (estUsd: number): SwarmEvent => ({
      k: 'fleet.spend',
      spend: { ...emptySpendCounters(), estUsd, capUsd: 10 },
    })
    harness.transport.evt('fleet', 1, spend(1), TS)
    harness.transport.evt('fleet', 2, spend(8), TS)
    harness.transport.evt('fleet', 3, spend(10), TS)
    expect(levels).toEqual(['soft', 'hard'])
    harness.destroy()
  })

  it('`nowDoing` is one line from the live tool call, and clears when it finishes (W4)', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    harness.transport.evt(
      'fleet',
      1,
      { k: 'fleet.delegation_created', delegation: makeDelegationVM() },
      TS,
    )
    harness.client.focus('delegation-1')
    const handle = harness.client.transcript('attempt-1')
    harness.transport.evt(
      'attempt:attempt-1',
      1,
      { k: 'att.tool', callId: 'call-1', name: 'bash', target: 'pnpm test', status: 'exec' },
      TS,
    )
    expect(harness.client.delegations.get().get('delegation-1')?.nowDoing).toBe('bash pnpm test')
    harness.transport.evt(
      'attempt:attempt-1',
      2,
      { k: 'att.tool', callId: 'call-1', name: 'bash', target: 'pnpm test', status: 'done' },
      TS,
    )
    expect(harness.client.delegations.get().get('delegation-1')?.nowDoing).toBeNull()
    handle.release()
    harness.destroy()
  })
})

describe('§6.2 every published view model is frozen and structuredClone-able (H5)', () => {
  it('freezes the delegation map, the fleet, health, notices and the connection', () => {
    const harness = createTestClient({ startAtMs: TS })
    driveFullScript(harness)
    harness.transport.evt('server', 2, { k: 'server.notice', notice: makeNoticeVM() }, TS)

    for (const value of [
      harness.client.fleet.get(),
      harness.client.health.get(),
      harness.client.notices.get(),
      harness.client.connection.get(),
      harness.client.delegations.get().get('delegation-1'),
    ]) {
      assertDeeplyFrozen(value)
      structuredClone(value)
    }
    harness.destroy()
  })

  it('freezes the two handle view models too — a transcript is handed out just as widely', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    const transcript = harness.client.transcript('a1')
    const diff = harness.client.diff('a1')
    harness.transport.snap('attempt:a1', 0, makeAttemptSnapshot({ attemptId: 'a1' }))
    harness.transport.evt('attempt:a1', 1, { k: 'att.text', text: 'hello' }, TS)
    harness.transport.evt(
      'attempt:a1',
      2,
      { k: 'att.diff', totals: { files: 1, insertions: 2, deletions: 0 }, staleBase: false },
      TS,
    )

    assertDeeplyFrozen(transcript.vm.get())
    assertDeeplyFrozen(diff.vm.get())
    structuredClone(transcript.vm.get())
    structuredClone(diff.vm.get())
    transcript.release()
    diff.release()
    harness.destroy()
  })
})

describe('§6.2 the attempt counters are the SERVER’s totals, counted once', () => {
  const seedFocused = (harness: TestClient): void => {
    harness.transport.evt(
      'fleet',
      1,
      {
        k: 'fleet.delegation_created',
        delegation: makeDelegationVM({
          attempts: [makeAttemptVM({ currentTurn: makeTurnVM() })],
        }),
      },
      TS,
    )
    harness.client.focus('delegation-1')
  }

  const tool = (
    callId: string,
    name: string,
    target: string | null,
    status: 'start' | 'exec' | 'done' | 'error',
  ): SwarmEvent => ({ k: 'att.tool', callId, name, target, status })

  it('does not double-count: live `att.tool` starts are REPLACED by `deleg.turn_ended`', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    seedFocused(harness)
    const handle = harness.client.transcript('attempt-1')

    harness.transport.evt('attempt:attempt-1', 1, tool('c1', 'bash', 'pnpm test', 'start'), TS)
    harness.transport.evt('attempt:attempt-1', 2, tool('c1', 'bash', 'pnpm test', 'done'), TS)
    harness.transport.evt('attempt:attempt-1', 3, tool('c2', 'read', 'a.ts', 'start'), TS)
    harness.transport.evt('attempt:attempt-1', 4, tool('c2', 'read', 'a.ts', 'done'), TS)
    /* Live, before the turn record lands. */
    expect(harness.client.delegations.get().get('delegation-1')?.attempts[0]?.toolCalls).toBe(2)

    harness.transport.evt(
      'delegation:delegation-1',
      1,
      { k: 'deleg.turn_ended', turnId: 'turn-1', usage: { input: 1, output: 2 }, toolCalls: 2 },
      TS,
    )
    const attempt = harness.client.delegations.get().get('delegation-1')?.attempts[0]
    expect(attempt?.toolCalls).toBe(2)
    expect(attempt?.turns).toBe(1)
    expect(attempt?.currentTurn?.toolCalls).toBe(2)
    handle.release()
    harness.destroy()
  })

  it('still takes the server’s total when it disagrees with what the stream showed', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    seedFocused(harness)
    const handle = harness.client.transcript('attempt-1')
    harness.transport.evt('attempt:attempt-1', 1, tool('c1', 'bash', null, 'start'), TS)
    harness.transport.evt(
      'delegation:delegation-1',
      1,
      { k: 'deleg.turn_ended', turnId: 'turn-1', usage: { input: 1, output: 2 }, toolCalls: 5 },
      TS,
    )
    expect(harness.client.delegations.get().get('delegation-1')?.attempts[0]?.toolCalls).toBe(5)
    handle.release()
    harness.destroy()
  })

  it('`nowDoing` survives a concurrent tool finishing (W4, #47, [F11])', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    seedFocused(harness)
    const handle = harness.client.transcript('attempt-1')
    const nowDoing = (): string | null =>
      harness.client.delegations.get().get('delegation-1')?.nowDoing ?? null

    harness.transport.evt('attempt:attempt-1', 1, tool('c1', 'bash', 'slow.sh', 'start'), TS)
    harness.transport.evt('attempt:attempt-1', 2, tool('c2', 'read', 'a.ts', 'start'), TS)
    expect(nowDoing()).toBe('read a.ts')
    /* The younger tool finishes while `bash slow.sh` is still executing. */
    harness.transport.evt('attempt:attempt-1', 3, tool('c2', 'read', 'a.ts', 'done'), TS)
    expect(nowDoing()).toBe('bash slow.sh')
    harness.transport.evt('attempt:attempt-1', 4, tool('c1', 'bash', 'slow.sh', 'error'), TS)
    expect(nowDoing()).toBeNull()
    handle.release()
    harness.destroy()
  })
})

describe('§6.4–6.6 the attention inversion keeps the server’s ordering', () => {
  /** A flag the client cannot re-derive from the wire — `deliveryUnknown` is the standing case. */
  const withServerOnlyFlag = (id: string): SwarmEvent => ({
    k: 'fleet.delegation_created',
    delegation: makeDelegationVM({
      id,
      state: 'running',
      attentionScore: ATTENTION_WEIGHTS.deliveryUnknown,
    }),
  })

  it('does not clamp a flag it cannot reproduce down into the age term', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    harness.transport.evt('fleet', 1, withServerOnlyFlag('d-unknown'), TS)
    const vm = harness.client.delegations.get().get('d-unknown') as DelegationVM
    /* Before the residual existed this projected as 199 — below `staleBase` (400) and below
     * `budgetBreached` (500) — and stayed there, silently re-ordering F2's list. */
    expect(vm.attentionScore).toBe(ATTENTION_WEIGHTS.deliveryUnknown)
    expect(vm.attentionScore).toBeGreaterThan(ATTENTION_WEIGHTS.staleBase)
    harness.destroy()
  })

  it('re-derives the residual on every server-authored summary, so a cleared flag stops counting', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    harness.transport.evt('fleet', 1, withServerOnlyFlag('d-unknown'), TS)
    harness.transport.evt(
      'fleet',
      2,
      {
        k: 'fleet.delegation_summary',
        delegation: makeDelegationVM({ id: 'd-unknown', state: 'running', attentionScore: 0 }),
      },
      TS,
    )
    /* The residual is gone. What remains is the age this client guessed at first sight — the
     * inversion cannot separate age from an unreproducible flag, and it attributes to age first.
     * That guess is bounded by `ageCap`, which is below the SMALLEST flag weight by construction,
     * so it can re-order two rows of the same flag class and never two of different ones. */
    const after = (harness.client.delegations.get().get('d-unknown') as DelegationVM).attentionScore
    expect(after).toBeLessThanOrEqual(ATTENTION_WEIGHTS.ageCap)
    expect(after).toBeLessThan(ATTENTION_WEIGHTS.staleBase)
    harness.destroy()
  })

  it('adds nothing when the two derivations agree, which is the normal case', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    harness.transport.evt(
      'fleet',
      1,
      {
        k: 'fleet.delegation_created',
        delegation: makeDelegationVM({
          id: 'd-agree',
          state: 'needs-you',
          attentionScore: ATTENTION_WEIGHTS.needsYou,
        }),
      },
      TS,
    )
    expect((harness.client.delegations.get().get('d-agree') as DelegationVM).attentionScore).toBe(
      ATTENTION_WEIGHTS.needsYou,
    )
    harness.destroy()
  })
})

describe('§2.3 a fleet snapshot prunes the side tables, not only the map', () => {
  it('forgets the age, focus and attempt ownership of a delegation the server dropped', () => {
    const harness = createTestClient({ startAtMs: TS })
    harness.start()
    harness.transport.evt(
      'fleet',
      1,
      { k: 'fleet.delegation_created', delegation: makeDelegationVM({ id: 'gone' }) },
      TS,
    )
    harness.client.focus('gone')
    expect(harness.client.delegations.get().has('gone')).toBe(true)

    harness.transport.lagged('fleet', 1, 'retention')
    harness.transport.snap('fleet', 40, makeFleetSnapshot({ delegations: [] }))
    expect(harness.client.delegations.get().has('gone')).toBe(false)

    /* The proof that `meta` went with it: the id is re-issued with a fresh score, and a stale
     * `meta` row would suppress the re-seed and keep projecting the old age. */
    harness.clock.advance(45 * 60_000)
    harness.transport.evt(
      'fleet',
      41,
      {
        k: 'fleet.delegation_created',
        delegation: makeDelegationVM({
          id: 'gone',
          state: 'failed',
          attentionScore: ATTENTION_WEIGHTS.failed,
        }),
      },
      TS + 45 * 60_000,
    )
    expect((harness.client.delegations.get().get('gone') as DelegationVM).attentionScore).toBe(
      ATTENTION_WEIGHTS.failed,
    )
    harness.destroy()
  })
})
