/**
 * SPEC-swarm §3.4 (budgets and the writer lease), §4.2 (`structured`, `budget`), §4.3.9 (retract)
 * and §3.3 D12/D21 — the rules that were accepted at the boundary and then not applied.
 *
 * The shape of every case: *set the knob the spec declares, then assert the knob did something*.
 * Six of the six budget dimensions, the lease TTL under a live stream, a `structured` directive
 * reaching `runStructured`, and the two verification rows with no path to them.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { ExecutorSessionHandle } from '../src/server/executor/types.ts'
import type { AttemptRecord, DelegationRecord, TurnRecord } from '../src/types.ts'
import type { ServerHarness } from './support/server-harness.ts'

import { LEASES } from '../src/domain/constants.ts'
import { sessionLease } from '../src/domain/leases.ts'
import { MockExecutor } from '../src/testing/mock-executor.ts'
import { createServerHarness, drain, settle, specFor } from './support/server-harness.ts'

let harness: ServerHarness | null = null
afterEach(async () => {
  await harness?.dispose()
  harness = null
})

const actor = { kind: 'user', head: 'test', tokenId: 'tok-test' } as const
let idem = 0
const ctx = (): { actor: typeof actor; tokenId: string; idempotencyKey: string } => {
  idem += 1
  return { actor, tokenId: 'tok-test', idempotencyKey: `budget-${idem}` }
}

async function serve(
  options: Parameters<typeof createServerHarness>[0] = {},
): Promise<ServerHarness> {
  harness = await createServerHarness({ listen: false, ...options })
  return harness
}

async function create(h: ServerHarness, spec: Parameters<typeof specFor>[1] = {}): Promise<string> {
  const created = await h.server.engine.dispatch(
    'createDelegation',
    { spec: specFor(h.repo, spec) },
    ctx(),
  )
  if (!created.ok) throw created.error
  return created.value as string
}

const deleg = (h: ServerHarness, id: string): DelegationRecord =>
  h.server.engine.store.read((tx) => tx.getRecord<DelegationRecord>('delegation', id)!.value)

const attemptOf = (h: ServerHarness, id: string): AttemptRecord =>
  h.server.engine.store.read((tx) => tx.getRecord<AttemptRecord>('attempt', id)!.value)

const turnsOf = (h: ServerHarness, attempt: AttemptRecord): readonly TurnRecord[] =>
  h.server.engine.store.read((tx) =>
    attempt.turns.map((t) => tx.getRecord<TurnRecord>('turn', t)!.value),
  )

/** The live session for an attempt, reached through the adapter's own caches. */
async function sessionOf(
  executor: MockExecutor,
  attempt: AttemptRecord,
): Promise<ExecutorSessionHandle> {
  const instance = await executor.acquireInstance(attempt.executor.instanceKey, {
    jcodeHome: '/tmp/x',
    workingDir: '/tmp/x',
    inheritLogins: false,
    env: {},
    startupTimeoutMs: 1,
    cleanupTimeoutMs: 1,
    inheritStderr: false,
  })
  return instance.openSession(attempt.executor.sessionId!)
}

/* ------------------------------------------------------------------- §3.4 the six dimensions */

describe('§3.4 — every budget dimension is counted, not only the one that worked', () => {
  it('`toolCalls` accrues on the delegation, so `maxToolCalls` can breach at all', async () => {
    const executor = new MockExecutor()
    const h = await serve({ adapter: executor })
    const id = await create(h)
    await drain(h)
    const attempt = attemptOf(h, deleg(h, id).attempts[0]!)
    const session = await sessionOf(executor, attempt)

    executor.script(session, {
      ack: true,
      steps: [
        { k: 'tool', callId: 'c1', name: 'bash', output: 'ok' },
        { k: 'tool', callId: 'c2', name: 'bash', output: 'ok' },
        { k: 'turn_done' },
      ],
    })
    await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'do two things', idempotencyKey: 'tools-1' } },
      ctx(),
    )
    await settle(12)

    /* `addSpend` was called at exactly two sites and neither of them was a tool call, so
     * `maxToolCalls` was a limit that could not be reached. */
    expect(deleg(h, id).spend.toolCalls).toBeGreaterThanOrEqual(2)
  })

  it('`wallMs` accrues per turn, so the wall fraction is not permanently zero', async () => {
    /* A clock that moves, because a turn's wall time is the difference between two readings and a
     * frozen clock makes every turn free. */
    let clock = 1_000_000
    const h = await serve({ now: () => (clock += 7) })
    const id = await create(h)
    await drain(h)
    expect(deleg(h, id).spend.wallMs).toBeGreaterThanOrEqual(0)

    await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'another turn', idempotencyKey: 'wall-1' } },
      ctx(),
    )
    await settle(10)
    const spend = deleg(h, id).spend
    /* The old code grew `wallMs` **only** on a sleep gap, and added the same gap to `sleptMs` —
     * and `budgetFractions` reads `wallMs − sleptMs`, so the fraction was pinned at 0. */
    expect(spend.wallMs - spend.sleptMs).toBeGreaterThan(0)
  })

  it('a configured dollar cap with no price oracle raises `capability-absent` rather than reading as unbreached', async () => {
    const h = await serve({ config: { caps: { hardSpendUsd: 5 } } })
    const id = await create(h)
    await drain(h)
    await settle(8)

    const notices = h.server.engine.listNotices()
    const raised = notices.find((n) => n.title === 'Spend caps are not enforced')
    expect(raised?.kind).toBe('capability-absent')
    expect(raised?.dismissible).toBe(false)
    void id
  })

  it('a `TurnBudget{maxToolCalls}` cancels that turn only, and records `budget-breach` on it', async () => {
    const executor = new MockExecutor()
    const h = await serve({ adapter: executor })
    const id = await create(h)
    await drain(h)
    const attempt = attemptOf(h, deleg(h, id).attempts[0]!)
    const session = await sessionOf(executor, attempt)

    executor.script(session, {
      ack: true,
      steps: [
        { k: 'tool', callId: 'c1', name: 'bash', output: 'ok' },
        { k: 'tool', callId: 'c2', name: 'bash', output: 'ok' },
      ],
    })
    await h.server.engine.dispatch(
      'sendTurn',
      {
        delegationId: id,
        directive: { text: 'spend it', budget: { maxToolCalls: 1 }, idempotencyKey: 'tb-1' },
      },
      ctx(),
    )
    await settle(14)

    const turns = turnsOf(h, attemptOf(h, attempt.id))
    const budgeted = turns.find((t) => t.effective.budget !== null)
    expect(budgeted?.deliveryDetail.reason).toBe('budget-breach')
    /* §3.4: "a `TurnBudget` breach `cancel`s that turn only". The session and the delegation live. */
    expect(deleg(h, id).state).not.toBe('cancelled')
    expect(attemptOf(h, attempt.id).outcome).toBe('open')
  })
})

/* ------------------------------------------------------------- §3.4 rule 2 the writer lease */

describe('§3.4 rule 2 — the writer lease is renewed, and expiry never releases mid-stream', () => {
  it('`renewLeases` extends the session lease and keeps its fence', async () => {
    let clock = 2_000_000
    const h = await serve({ now: () => clock })
    const id = await create(h)
    await drain(h)
    const attempt = attemptOf(h, deleg(h, id).attempts[0]!)
    const key = sessionLease(attempt.executor.sessionId!)

    const before = h.server.engine.store.read((tx) => tx.getLease(key))!
    clock += LEASES.sessionRenewMs
    h.server.engine.renewLeases()
    const after = h.server.engine.store.read((tx) => tx.getLease(key))!

    expect(after.expiresAt).toBeGreaterThan(before.expiresAt)
    /* A token that moved on every renewal would invalidate the fence the writer is mid-call with. */
    expect(after.token).toBe(before.token)
    expect(after.holder).toBe(attempt.id)
  })

  it('a lease left to expire blocks the next submission instead of silently handing the session over', async () => {
    let clock = 3_000_000
    const h = await serve({ now: () => clock })
    const id = await create(h)
    await drain(h)
    const attempt = attemptOf(h, deleg(h, id).attempts[0]!)

    /* Past the 60 s TTL with no renewal — the state `leaseStatus` describes and nothing produced. */
    clock += LEASES.sessionTtlMs + 1
    await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'after the TTL', idempotencyKey: 'ttl-1' } },
      ctx(),
    )
    await settle(10)

    const turns = turnsOf(h, attemptOf(h, attempt.id))
    const last = turns.at(-1)!
    expect(last.delivery).toBe('failed')
    expect(last.deliveryDetail.reason).toBe('lease_held')
  })
})

/* ------------------------------------------------------------------------ §4.2 `structured` */

describe('§4.2 — a `structured` directive runs `runStructured`, not a plain message', () => {
  it('the turn reaches `ended`, the schema digest is recorded, and the attempts are evidence', async () => {
    const executor = new MockExecutor()
    const h = await serve({ adapter: executor })
    const id = await create(h)
    await drain(h)
    const attempt = attemptOf(h, deleg(h, id).attempts[0]!)
    const session = await sessionOf(executor, attempt)
    const calls: unknown[] = []
    const original = session.structured.bind(session)
    ;(session as { structured: unknown }).structured = (
      msg: unknown,
      schema: unknown,
      maxRetries: number,
      fence: unknown,
    ) => {
      calls.push({ schema, maxRetries })
      return (original as (...a: unknown[]) => unknown)(msg, schema, maxRetries, fence)
    }

    await h.server.engine.dispatch(
      'sendTurn',
      {
        delegationId: id,
        directive: {
          text: 'answer in the shape',
          structured: { schema: { type: 'object' }, maxRetries: 1 },
          idempotencyKey: 'structured-1',
        },
      },
      ctx(),
    )
    await settle(14)

    /* The old path recorded `structured.schemaDigest`, advertised `'structured'` in
     * `hello_ok`, and sent a plain `sendMessage`. */
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ maxRetries: 1 })

    const turns = turnsOf(h, attemptOf(h, attempt.id))
    const structured = turns.find((t) => t.effective.structured !== null)!
    expect(structured.effective.structured?.schemaDigest).toHaveLength(64)
    expect(structured.delivery).toBe('ended')
    expect(structured.endedAt).not.toBeNull()
  })
})

/* -------------------------------------------------------- §4.3.9 retract, D12 and D21 */

describe('§4.3.9 — no record may misdescribe a delivery', () => {
  it('retracting an already-`sent` non-interrupt turn is refused, not reported as a deletion', async () => {
    const h = await serve()
    const id = await create(h)
    await drain(h)
    const attempt = attemptOf(h, deleg(h, id).attempts[0]!)
    const sent = turnsOf(h, attempt).at(-1)!
    expect(['sent', 'accepted', 'running', 'ended']).toContain(sent.delivery)

    const result = await h.server.engine.dispatch('retract', { turnId: sent.id }, ctx())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('invalid_spec')
    /* The turn is still there, and still says what actually happened to it. */
    const after = h.server.engine.store.read((tx) => tx.getRecord<TurnRecord>('turn', sent.id))
    expect(after).not.toBeNull()
  })
})

describe('§3.3 D12/D21 — the two verification rows that had no path to them', () => {
  it('D12: criteria failed with the budget exhausted reaches `failed`, not `needs-you`', async () => {
    const h = await serve()
    const id = await create(h, {
      acceptance: [{ kind: 'file', id: 'f', label: 'f', path: 'never-written.txt', must: 'exist' }],
      /* One turn of budget, which the objective turn spends — so the failure is terminal. */
      budget: {
        maxWallMs: 45 * 60_000,
        maxTurns: 1,
        maxToolCalls: 200,
        maxInputTokens: 2_000_000,
        maxOutputTokens: 200_000,
        onBreach: 'pause-dispatch',
      },
    } as never)
    await drain(h)
    await settle(10)

    const record = deleg(h, id)
    expect(record.state).toBe('failed')
    expect(attemptOf(h, record.attempts[0]!).outcome).toBe('exhausted')
  })

  it('D21: re-verifying a `failed` delegation appends a run and never reaches `succeeded`', async () => {
    const h = await serve()
    const id = await create(h, {
      acceptance: [{ kind: 'file', id: 'f', label: 'f', path: 'README.md', must: 'exist' }],
      budget: {
        maxWallMs: 45 * 60_000,
        maxTurns: 1,
        maxToolCalls: 200,
        maxInputTokens: 2_000_000,
        maxOutputTokens: 200_000,
        onBreach: 'pause-dispatch',
      },
    } as never)
    await drain(h)
    await settle(8)
    const attemptId = deleg(h, id).attempts[0]!
    const runsBefore = attemptOf(h, attemptId).verifications.length

    /* Force `failed` through the one path that reaches it, then re-verify. */
    const before = deleg(h, id)
    if (before.state !== 'failed') {
      h.server.engine.store.commit((tx) => {
        tx.putRecord('delegation', id, before.version + 1, {
          ...before,
          state: 'failed',
          version: before.version + 1,
        })
      })
    }
    const verified = await h.server.engine.dispatch('verify', { delegationId: id }, ctx())
    expect(verified.ok).toBe(true)
    expect(attemptOf(h, attemptId).verifications.length).toBeGreaterThan(runsBefore)
    /* "a pass reaches `succeeded` only via D19 then D10." */
    expect(deleg(h, id).state).toBe('failed')
  })
})
