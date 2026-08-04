/**
 * The lifecycle intents §6.3 declares and §3.3 gives rows to: `retry` (D19), `branch` (A6),
 * `discard`, `archive` (D15), `pauseDispatch` and `killSwitch` (D23) — plus the scheduler's
 * admission rules (§7.1) and the landing facet (D20, decision log #23).
 *
 * Each case names the rule it holds. The ones that matter most are the two that are *refusals*:
 * `dispatchPaused` must stop new turns without cancelling a running one (Q11), and a kill switch
 * must never reach a terminal state (Q16, #31).
 */

import { existsSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

import type { AttemptRecord, DelegationRecord } from '../src/types.ts'
import type { ServerHarness } from './support/server-harness.ts'

import { admissionDecision, orderCandidates, withAdmitted } from '../src/server/scheduler.ts'
import { createScratchRepo, createServerHarness, drain, specFor } from './support/server-harness.ts'

let harness: ServerHarness | null = null

afterEach(async () => {
  await harness?.dispose()
  harness = null
})

async function serve(
  options: Parameters<typeof createServerHarness>[0] = {},
): Promise<ServerHarness> {
  harness = await createServerHarness({ listen: false, ...options })
  return harness
}

let seq = 0
const ctx = () => ({
  actor: { kind: 'user', head: 'test', tokenId: 'tok' } as const,
  tokenId: 'tok',
  idempotencyKey: `lifecycle-${++seq}`,
})

async function create(h: ServerHarness, spec: Parameters<typeof specFor>[1] = {}): Promise<string> {
  const result = await h.server.engine.dispatch(
    'createDelegation',
    { spec: specFor(h.repo, spec) },
    ctx(),
  )
  if (!result.ok) throw result.error
  return result.value as string
}

const delegation = (h: ServerHarness, id: string): DelegationRecord =>
  h.server.engine.store.read((tx) => tx.getRecord<DelegationRecord>('delegation', id)!.value)

const attempt = (h: ServerHarness, id: string): AttemptRecord =>
  h.server.engine.store.read((tx) => tx.getRecord<AttemptRecord>('attempt', id)!.value)

const withCriteria = {
  acceptance: [
    {
      kind: 'file' as const,
      id: 'readme',
      label: 'readme',
      path: 'README.md',
      must: 'exist' as const,
    },
  ],
}

describe('§7.1 the scheduler admits ATTEMPTS, not delegations (Q9)', () => {
  it('orders by priority desc then queued age asc, and a first attempt outranks a sibling', () => {
    const base = {
      delegationId: 'd',
      workspaceId: 'w',
      providerModel: 'p/m',
      instanceKey: 'p/c',
      createdByCopilot: false,
      budgetHardBreached: false,
      delegationPaused: false,
    }
    const ordered = orderCandidates([
      { ...base, delegationId: 'old-sibling', siblingIndex: 1, priority: 0, queuedAt: 1 },
      { ...base, delegationId: 'new-first', siblingIndex: 0, priority: 0, queuedAt: 5 },
      { ...base, delegationId: 'urgent', siblingIndex: 0, priority: 9, queuedAt: 99 },
      { ...base, delegationId: 'old-first', siblingIndex: 0, priority: 0, queuedAt: 1 },
    ])
    expect(ordered.map((c) => c.delegationId)).toEqual([
      'urgent',
      /* `priority` desc first. Then, among equals, a **first** attempt outranks a **sibling** —
       * and it outranks it *before* age is consulted, because §7.1's reason for the rule is that
       * "parallel exploration never starves a delegation that has not started at all". Sorting by
       * age first would admit `old-sibling` (a second attempt of work already running) ahead of
       * `new-first` (work that has not begun), which is the starvation the rule forbids. Age is
       * the aging guard (F7) *within* each of those two classes. */
      'old-first',
      'new-first',
      'old-sibling',
    ])
  })

  it('refuses admission on every cap the spec names, one at a time', () => {
    const caps = {
      globalConcurrency: 1,
      perWorkspace: 1,
      perProviderModel: { 'p/m': 1 },
      worktreesPerRepo: 1,
      copilotConcurrency: 1,
      maxParallelAttempts: 3 as const,
      softSpendUsd: null,
      hardSpendUsd: null,
    }
    const candidate = {
      delegationId: 'd',
      siblingIndex: 0,
      priority: 0,
      queuedAt: 0,
      workspaceId: 'w',
      providerModel: 'p/m',
      instanceKey: 'p/c',
      createdByCopilot: false,
      budgetHardBreached: false,
      delegationPaused: false,
    }
    const empty = {
      runningAttempts: 0,
      perWorkspace: {},
      perProviderModel: {},
      perRepoWorktrees: {},
      copilotAttempts: 0,
      fleetPaused: false,
    }
    expect(admissionDecision(candidate, empty, caps, '/repo').admit).toBe(true)
    expect(
      admissionDecision(candidate, { ...empty, runningAttempts: 1 }, caps, '/repo').admit,
    ).toBe(false)
    expect(
      admissionDecision(candidate, { ...empty, perWorkspace: { w: 1 } }, caps, '/repo').admit,
    ).toBe(false)
    expect(
      admissionDecision(candidate, { ...empty, perProviderModel: { 'p/m': 1 } }, caps, '/repo')
        .admit,
    ).toBe(false)
    expect(
      admissionDecision(candidate, { ...empty, perRepoWorktrees: { '/repo': 1 } }, caps, '/repo')
        .admit,
    ).toBe(false)
    expect(admissionDecision(candidate, { ...empty, fleetPaused: true }, caps, '/repo').admit).toBe(
      false,
    )
    expect(
      admissionDecision({ ...candidate, delegationPaused: true }, empty, caps, '/repo').admit,
    ).toBe(false)
    expect(
      admissionDecision({ ...candidate, budgetHardBreached: true }, empty, caps, '/repo').admit,
    ).toBe(false)
    /* Q8: a copilot-created delegation counts against the fleet cap **and** `copilotConcurrency`. */
    expect(
      admissionDecision(
        { ...candidate, createdByCopilot: true },
        { ...empty, copilotAttempts: 1 },
        caps,
        '/repo',
      ).admit,
    ).toBe(false)
  })

  it('`withAdmitted` books every dimension the next decision reads', () => {
    const state = withAdmitted(
      {
        runningAttempts: 0,
        perWorkspace: {},
        perProviderModel: {},
        perRepoWorktrees: {},
        copilotAttempts: 0,
        fleetPaused: false,
      },
      {
        delegationId: 'd',
        siblingIndex: 0,
        priority: 0,
        queuedAt: 0,
        workspaceId: 'w',
        providerModel: 'p/m',
        instanceKey: 'p/c',
        createdByCopilot: true,
        budgetHardBreached: false,
        delegationPaused: false,
      },
      '/repo',
    )
    expect(state).toMatchObject({
      runningAttempts: 1,
      perWorkspace: { w: 1 },
      perProviderModel: { 'p/m': 1 },
      perRepoWorktrees: { '/repo': 1 },
      copilotAttempts: 1,
    })
  })
})

describe('§6.3 `pauseDispatch` — a brake on new turns, never on a running one (Q11)', () => {
  it('pauses at fleet scope, refuses new turns, and resumes', async () => {
    const h = await serve()
    const id = await create(h)
    await drain(h)

    const paused = await h.server.engine.dispatch(
      'pauseDispatch',
      { scope: { fleet: true }, paused: true },
      ctx(),
    )
    expect(paused.ok).toBe(true)

    const refused = await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'go', idempotencyKey: 'k-paused' } },
      ctx(),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('dispatch_paused')

    await h.server.engine.dispatch(
      'pauseDispatch',
      { scope: { fleet: true }, paused: false },
      ctx(),
    )
    const accepted = await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'go', idempotencyKey: 'k-resumed' } },
      ctx(),
    )
    expect(accepted.ok).toBe(true)
  })

  it('pauses one delegation without touching its neighbours', async () => {
    const h = await serve()
    const one = await create(h)
    const two = await create(h)
    await drain(h)
    await h.server.engine.dispatch(
      'pauseDispatch',
      { scope: { delegationId: one }, paused: true },
      ctx(),
    )
    expect(delegation(h, one).dispatchPaused).toBe(true)
    expect(delegation(h, two).dispatchPaused).toBe(false)
  })
})

describe('§3.3 D19 `retry` and A6 `branch`', () => {
  it('`retry` reopens a terminal delegation as attempt N+1, clearing the verdict', async () => {
    const h = await serve()
    const id = await create(h, withCriteria)
    await drain(h)
    expect(delegation(h, id).state).toBe('succeeded')
    expect(delegation(h, id).verdict).toBe('verified')

    const states: string[] = []
    const unsubscribe = h.server.engine.store.onCommit((result) => {
      for (const record of result.emitted) {
        if (record.ev.k === 'fleet.delegation_state') states.push(record.ev.state)
      }
    })
    const retried = await h.server.engine.dispatch('retry', { delegationId: id }, ctx())
    unsubscribe()
    expect(retried.ok).toBe(true)
    /* D19 leaves the terminal. Asserted as "the next state is non-terminal" rather than as the
     * literal `queued`, because the scheduler ticks on every state change (§7.1): by the time a
     * test can observe anything, `queued → provisioning` (D2) has usually already happened, and
     * pinning the intermediate would be testing the tick's latency, not the reopen. */
    expect(states.length).toBeGreaterThan(0)
    for (const state of states) {
      expect(['succeeded', 'failed', 'cancelled', 'abandoned']).not.toContain(state)
    }
    /* Q2: attempts are append-only, and the verdict a new attempt has not earned is cleared. */
    expect(delegation(h, id).verdict).toBeNull()
    await drain(h)
    expect(delegation(h, id).attempts.length).toBeGreaterThanOrEqual(2)
  }, 20_000)

  it('`branch` creates a new delegation carrying its lineage (A6, #40)', async () => {
    const h = await serve()
    const id = await create(h)
    await drain(h)
    const attemptId = delegation(h, id).attempts[0]!

    const branched = await h.server.engine.dispatch(
      'branch',
      { attemptId, title: 'a different angle' },
      ctx(),
    )
    expect(branched.ok).toBe(true)
    if (!branched.ok) return
    const child = delegation(h, branched.value as string)
    expect(child.title).toBe('a different angle')
    /* Without `origin`, `branch` would throw away the lineage Q2 and A5 both need. */
    expect(child.origin).toEqual({ delegationId: id, attemptId })
  })
})

describe('§6.3 `archive`, `discard` and the landing facet', () => {
  it('`archive{abandon:true}` reaches `abandoned` — the unverifiable-work plane (D15)', async () => {
    const h = await serve()
    const id = await create(h)
    await drain(h)
    const archived = await h.server.engine.dispatch(
      'archive',
      { delegationId: id, abandon: true },
      ctx(),
    )
    expect(archived.ok).toBe(true)
    expect(delegation(h, id).state).toBe('abandoned')
  })

  it('`discard` ends one attempt and leaves the delegation to its siblings', async () => {
    const h = await serve({ config: { caps: { globalConcurrency: 4, perWorkspace: 3 } } })
    const id = await create(h, { parallelAttempts: 2 })
    await drain(h)
    const live = delegation(h, id).liveAttempts
    expect(live).toHaveLength(2)

    const discarded = await h.server.engine.dispatch('discard', { attemptId: live[0]! }, ctx())
    expect(discarded.ok).toBe(true)
    expect(delegation(h, id).liveAttempts).not.toContain(live[0])
    expect(attempt(h, live[0]!).outcome).not.toBe('open')
  }, 20_000)

  it('D20 — `land` sets the facet and the state stays `succeeded`', async () => {
    const h = await serve()
    const id = await create(h, withCriteria)
    await drain(h)
    const attemptId = delegation(h, id).attempts[0]!

    const landed = await h.server.engine.dispatch(
      'land',
      { delegationId: id, attemptId, mode: 'patch' },
      ctx(),
    )
    expect(landed.ok).toBe(true)
    if (!landed.ok) return
    const record = landed.value as { mode: string; patchPath?: string }
    expect(record.mode).toBe('patch')
    expect(existsSync(record.patchPath!)).toBe(true)
    /* Landing is a facet, not a state. */
    expect(delegation(h, id).state).toBe('succeeded')
    expect(delegation(h, id).landed).not.toBeNull()
  }, 20_000)

  it('landing to a commit produces a branch that points at the worktree head', async () => {
    const repo = createScratchRepo()
    const h = await serve({ repo })
    const id = await create(h, withCriteria)
    await drain(h)
    const attemptId = delegation(h, id).attempts[0]!

    const landed = await h.server.engine.dispatch(
      'land',
      { delegationId: id, attemptId, mode: 'commit', targetBranch: 'swarm/landed' },
      ctx(),
    )
    expect(landed.ok).toBe(true)
    if (!landed.ok) return
    const record = landed.value as { mode: string; ref: string; sha?: string }
    expect(record.mode).toBe('commit')
    expect(record.ref).toBe('swarm/landed')
    expect(record.sha).toMatch(/^[0-9a-f]{40}$/)
  }, 20_000)
})

describe('§6.3 `killSwitch` is a brake, not a delete (Q16, #31)', () => {
  it('cancels in-flight turns, pauses dispatch fleet-wide, and terminalizes nothing', async () => {
    const h = await serve({ config: { caps: { globalConcurrency: 4, perWorkspace: 3 } } })
    const one = await create(h)
    const two = await create(h)
    await drain(h)
    const worktrees = [one, two].flatMap((id) =>
      delegation(h, id).attempts.map((a) => attempt(h, a).workspace.worktree),
    )
    expect(worktrees.every((path) => path !== null && existsSync(path))).toBe(true)

    const result = await h.server.engine.dispatch('killSwitch', { killInstances: false }, ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const report = result.value as {
      turnsCancelled: readonly string[]
      attemptsAffected: readonly string[]
      delegationsTerminated: readonly unknown[]
      worktreesRemoved: readonly unknown[]
      dispatchPausedFleetWide: boolean
    }
    expect(report.dispatchPausedFleetWide).toBe(true)
    expect(report.delegationsTerminated).toEqual([])
    expect(report.worktreesRemoved).toEqual([])

    for (const id of [one, two]) {
      expect(['succeeded', 'failed', 'cancelled', 'abandoned']).not.toContain(
        delegation(h, id).state,
      )
    }
    /* Not one worktree touched: the panic button and the delete button cannot be the same button. */
    expect(worktrees.every((path) => path !== null && existsSync(path))).toBe(true)

    /* And dispatch really is paused afterwards. */
    const refused = await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: one, directive: { text: 'go', idempotencyKey: 'k-after-kill' } },
      ctx(),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('dispatch_paused')
  }, 20_000)
})

describe("§3.3 D17 — `cancel{scope:'delegation'}` is the only path to `cancelled` (#31)", () => {
  /**
   * The regression these exist for: the cancellation was written onto the record **before** the
   * forced refresh that emits it, so `refreshDelegationState` found the state it was about to
   * write already there and returned early. The delegation really was cancelled, the intent
   * really answered `ok`, and no `fleet.delegation_state` and no summary were ever emitted — so
   * every connected head went on showing it as queued or running, indefinitely.
   *
   * A durable write nobody is told about is the worst shape a bug can take here. §2.3's contract
   * is that the log IS the notification, so the user is not looking at a stale view they could
   * refresh: they are looking at a fleet that is telling them the brake did not work.
   */
  const cancelStates = (h: ServerHarness): { states: string[]; stop: () => void } => {
    const states: string[] = []
    const stop = h.server.engine.store.onCommit((result) => {
      for (const record of result.emitted) {
        if (record.ev.k === 'fleet.delegation_state') states.push(record.ev.state)
      }
    })
    return { states, stop }
  }

  it('emits the state change, not only the record — a cancel no head hears is not a cancel', async () => {
    const h = await serve()
    const id = await create(h)
    const watch = cancelStates(h)

    const cancelled = await h.server.engine.dispatch(
      'cancel',
      { delegationId: id, scope: 'delegation' },
      ctx(),
    )
    watch.stop()
    expect(cancelled.ok).toBe(true)
    expect(delegation(h, id).state).toBe('cancelled')
    /* The observable half. Without it the assertion above passes and the product is broken. */
    expect(watch.states).toContain('cancelled')
  }, 20_000)

  it('cancels a REOPENED delegation with live attempts the same way', async () => {
    const h = await serve()
    const id = await create(h, withCriteria)
    await drain(h)
    /* A terminal delegation cannot be cancelled — D17 is scoped to `*non-terminal` — so the
     * running case is reached the way a user reaches it: by reopening (D19) and cancelling the
     * attempt that reopen started. */
    expect((await h.server.engine.dispatch('retry', { delegationId: id }, ctx())).ok).toBe(true)
    expect(delegation(h, id).attempts.length).toBeGreaterThan(0)

    const watch = cancelStates(h)
    const cancelled = await h.server.engine.dispatch(
      'cancel',
      { delegationId: id, scope: 'delegation' },
      ctx(),
    )
    watch.stop()
    expect(cancelled.ok).toBe(true)
    expect(delegation(h, id).state).toBe('cancelled')
    expect(delegation(h, id).liveAttempts).toEqual([])
    expect(watch.states).toContain('cancelled')
  }, 20_000)

  it('refuses to cancel a delegation that already reached a terminal state', async () => {
    const h = await serve()
    const id = await create(h, withCriteria)
    await drain(h)
    expect(delegation(h, id).state).toBe('succeeded')
    const refused = await h.server.engine.dispatch(
      'cancel',
      { delegationId: id, scope: 'delegation' },
      ctx(),
    )
    expect(refused.ok).toBe(false)
    /* And it stays `succeeded`: a refusal that half-applied would be worse than either answer. */
    expect(delegation(h, id).state).toBe('succeeded')
  }, 20_000)
})
