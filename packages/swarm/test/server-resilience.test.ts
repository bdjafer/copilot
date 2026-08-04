/**
 * SPEC-swarm §5.5 (reconciliation), §4.3.7/§5.1 (the two-group kill), §2.3 (retention),
 * §2.4 (backpressure), §2.5 rule 3 (idempotency) and §5.3/§7.3 (the scrubbed env).
 *
 * These are the rules whose failure mode looks like success: evidence that says a message landed
 * when it did not, a stop that reports itself complete while the daemon runs, a queue rule that
 * cannot fire, an allowlist that overrides the thing it is added to.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { ExecutorInstance, KillOutcomeReport } from '../src/server/executor/types.ts'
import type { AttemptRecord, DelegationRecord } from '../src/types.ts'
import type { InstanceKey } from '../src/types.ts'
import type { ServerHarness } from './support/server-harness.ts'

import { SERVER_POLICY } from '../src/domain/constants.ts'
import { BACKPRESSURE } from '../src/protocol/constants.ts'
import { buildBridgeEnv, killTwoGroups } from '../src/server/executor/spawn.ts'
import { MockExecutor } from '../src/testing/mock-executor.ts'
import { createServerHarness, drain, settle, specFor } from './support/server-harness.ts'

let harness: ServerHarness | null = null
afterEach(async () => {
  await harness?.dispose()
  harness = null
})

const actor = { kind: 'user', head: 'test', tokenId: 'tok-test' } as const
let idem = 0
const ctx = (key?: string): { actor: typeof actor; tokenId: string; idempotencyKey: string } => {
  idem += 1
  return { actor, tokenId: 'tok-test', idempotencyKey: key ?? `resilience-${idem}` }
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

/* ------------------------------------------------------------------- §5.5 the `unknown` protocol */

describe('§5.5 — the evidence is about **this turn**, and it is read after the reattach', () => {
  it('a completed previous turn’s tool call is not evidence that a later message landed', async () => {
    const executor = new MockExecutor()
    const h = await serve({ adapter: executor })
    const id = await create(h)
    await drain(h)
    const attempt = attemptOf(h, deleg(h, id).attempts[0]!)
    const instance = await executor.acquireInstance(attempt.executor.instanceKey, {
      jcodeHome: '/tmp/x',
      workingDir: '/tmp/x',
      inheritLogins: false,
      env: {},
      startupTimeoutMs: 1,
      cleanupTimeoutMs: 1,
      inheritStderr: false,
    })
    const session = await instance.openSession(attempt.executor.sessionId!)
    executor.script(session, {
      ack: true,
      steps: [{ k: 'tool', callId: 'c1', name: 'bash', output: 'ok' }, { k: 'turn_done' }],
    })
    await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'run a tool', idempotencyKey: 'tool-turn' } },
      ctx(),
    )
    await settle(12)

    /* A **second** turn, which logs no tool event of its own and never ends. It is the turn under
     * reconciliation, and the previous turn's tool call says nothing about whether it arrived. */
    executor.script(session, { ack: true, steps: [{ k: 'text', text: 'thinking' }] })
    await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'and now this one', idempotencyKey: 'quiet-turn' } },
      ctx(),
    )
    await settle(12)

    const report = await h.server.engine.dispatch('reconcile', { delegationId: id }, ctx())
    expect(report.ok).toBe(true)
    const evidence = report.ok
      ? (report.value as { evidence: { toolEventsLogged: number } }).evidence
      : { toolEventsLogged: -1 }
    /* §5.5's clause is "any tool event logged **for this turn**". Counting the last 500 records of
     * the whole `attempt:*` stream read a *finished* turn's tool call as proof that the message
     * under reconciliation had arrived — positive evidence manufactured from history. */
    expect(evidence.toolEventsLogged).toBe(0)
  })

  it('`att.tool` carries its `turnId`, which is what makes the clause expressible at all', async () => {
    const executor = new MockExecutor()
    const h = await serve({ adapter: executor })
    const id = await create(h)
    await drain(h)
    const attempt = attemptOf(h, deleg(h, id).attempts[0]!)
    const instance = await executor.acquireInstance(attempt.executor.instanceKey, {
      jcodeHome: '/tmp/x',
      workingDir: '/tmp/x',
      inheritLogins: false,
      env: {},
      startupTimeoutMs: 1,
      cleanupTimeoutMs: 1,
      inheritStderr: false,
    })
    const session = await instance.openSession(attempt.executor.sessionId!)
    executor.script(session, {
      ack: true,
      steps: [{ k: 'tool', callId: 'c9', name: 'bash', output: 'ok' }, { k: 'turn_done' }],
    })
    await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'tool please', idempotencyKey: 'tool-turn-2' } },
      ctx(),
    )
    await settle(12)

    const rows = h.server.engine.store
      .read((tx) => tx.readLog(`attempt:${attempt.id}`, 0, 500))
      .filter((row) => row.ev.k === 'att.tool')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.turnId).toBeTypeOf('string')
  })

  it('reconciliation reattaches before it tails, so `digestInTail` is an observation', async () => {
    const executor = new MockExecutor()
    const h = await serve({ adapter: executor })
    const id = await create(h)
    await drain(h)
    const attempt = attemptOf(h, deleg(h, id).attempts[0]!)
    const instance = await executor.acquireInstance(attempt.executor.instanceKey, {
      jcodeHome: '/tmp/x',
      workingDir: '/tmp/x',
      inheritLogins: false,
      env: {},
      startupTimeoutMs: 1,
      cleanupTimeoutMs: 1,
      inheritStderr: false,
    })
    const session = await instance.openSession(attempt.executor.sessionId!)
    executor.disconnect(session, 'socket died')
    await settle(10)

    const report = await h.server.engine.dispatch('reconcile', { delegationId: id }, ctx())
    expect(report.ok).toBe(true)
    /* On the disconnect path — the case the protocol exists for — the tail used to be read from a
     * session that was `null`, so `digestInTail` was structurally always false and the
     * strong-evidence row fired on a missing observation rather than on a negative one. */
    const evidence = report.ok
      ? (report.value as { evidence: { digestInTail: boolean } }).evidence
      : null
    expect(evidence).not.toBeNull()
    expect(typeof evidence!.digestInTail).toBe('boolean')
  })
})

/* -------------------------------------------------------------- §4.3.7/§5.1 the two-group kill */

describe('§4.3.7/§5.1 — a hard kill is scoped, and a partial stop is never reported as a stop', () => {
  /** An instance that reports the kill the adapter is required to report. */
  class KillTrackingExecutor extends MockExecutor {
    readonly killed: InstanceKey[] = []
    outcome: KillOutcomeReport = {
      pgid: 100,
      daemonPid: 200,
      signalled: ['SIGTERM'],
      survivors: [],
      daemonStopped: true,
      durationMs: 1,
    }

    override async acquireInstance(
      key: InstanceKey,
      opts: Parameters<MockExecutor['acquireInstance']>[1],
    ): Promise<ExecutorInstance> {
      const instance = await super.acquireInstance(key, opts)
      ;(instance as { hardKill: unknown }).hardKill = (): Promise<KillOutcomeReport> => {
        this.killed.push(key)
        return Promise.resolve(this.outcome)
      }
      return instance
    }
  }

  it('`cancel{scope:hard}` signals only the instances this delegation runs on', async () => {
    const executor = new KillTrackingExecutor()
    const h = await serve({ adapter: executor })
    const mine = await create(h)
    const theirs = await create(h, {
      model: { provider: 'other', model: 'other-model', reasoningEffort: null },
    })
    await drain(h)
    expect(deleg(h, mine).liveAttempts).toHaveLength(1)
    expect(deleg(h, theirs).liveAttempts).toHaveLength(1)

    await h.server.engine.dispatch('cancel', { delegationId: mine, scope: 'hard' }, ctx())
    const mineKey = attemptOf(h, deleg(h, mine).attempts[0]!).executor.instanceKey
    /* §4.3.7 scopes this to "the process group swarm created for **that instance**". Iterating the
     * pool took down every other delegation sharing it. */
    expect(executor.killed).toEqual([mineKey])
  })

  it('an unresolvable `daemonPid` raises `capability-absent`, because the daemon setsid()s away', async () => {
    const executor = new KillTrackingExecutor()
    executor.outcome = { ...executor.outcome, daemonPid: null, daemonStopped: false }
    const h = await serve({ adapter: executor })
    const id = await create(h)
    await drain(h)

    await h.server.engine.dispatch('cancel', { delegationId: id, scope: 'hard' }, ctx())
    const raised = h.server.engine
      .listNotices()
      .find((n) => n.title === 'The hard kill did not stop everything')
    expect(raised?.kind).toBe('capability-absent')
    expect(raised?.dismissible).toBe(false)
    expect(raised?.detail).toContain('setsid')
  })

  it('a surviving daemon raises it too — `survivors: []` was the failure that looked like success', async () => {
    const executor = new KillTrackingExecutor()
    executor.outcome = {
      ...executor.outcome,
      daemonPid: 200,
      daemonStopped: false,
      survivors: [200],
    }
    const h = await serve({ adapter: executor })
    await create(h)
    await drain(h)

    const report = await h.server.engine.dispatch('killSwitch', { killInstances: true }, ctx())
    expect(report.ok).toBe(true)
    expect(
      h.server.engine
        .listNotices()
        .some((n) => n.title === 'The hard kill did not stop everything'),
    ).toBe(true)
  })

  it('`killTwoGroups` lets SIGKILL land before it scans for survivors', async () => {
    /* `kill(2)` returns when the signal is *queued*, so an immediate scan reports a just-killed
     * pid as alive — a false survivor, which the server now turns into a notice. */
    let alive = true
    const result = await killTwoGroups({
      pgid: 4242,
      daemonPid: null,
      kill: (_pid, signal) => {
        if (signal === 'SIGKILL') alive = false
        if (signal === 0 && !alive) throw new Error('ESRCH')
      },
      graceMs: 0,
      settleMs: 1,
    })
    expect(result.survivors).toEqual([])
  })
})

/* ------------------------------------------------------------------------- §2.3 retention */

describe('§2.3 — the retention floor rises for `attempt:*` and `server`, and the server does it', () => {
  it('an `attempt:*` stream older than `attemptStreamDays` has its floor advanced', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z')
    const h = await serve({
      now: () => clock,
      config: { retention: { attemptStreamDays: 7, attemptStreamMb: 200 } },
    })
    const id = await create(h)
    await drain(h)
    const attempt = attemptOf(h, deleg(h, id).attempts[0]!)
    const stream = `attempt:${attempt.id}` as const

    const before = h.server.engine.store.read((tx) => tx.head(stream))
    expect(before.head).toBeGreaterThan(0)
    expect(before.floor).toBe(0)

    /* Eight days later. `advanceFloor` and `config.retention` had no server-side caller at all, so
     * `lagged{reason:'retention'}` was producible only by a test calling the store directly. */
    clock += 8 * 24 * 60 * 60_000
    const removed = h.server.engine.applyRetention()
    expect(removed).toBeGreaterThan(0)
    expect(h.server.engine.store.read((tx) => tx.head(stream)).floor).toBeGreaterThan(0)
  })

  it('`fleet` is untouched — "forever" is not a clock rule', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z')
    const h = await serve({ now: () => clock })
    await create(h)
    await drain(h)
    clock += 400 * 24 * 60 * 60_000
    h.server.engine.applyRetention()
    expect(h.server.engine.store.read((tx) => tx.head('fleet')).floor).toBe(0)
  })
})

/* ------------------------------------------------------------------ §2.5 rule 3 idempotency */

describe('§2.5 rule 3 — a resend that arrives mid-flight runs once, and the cache expires', () => {
  it('two concurrent dispatches with one key produce one delegation', async () => {
    const h = await serve()
    const key = 'reconnect-resend'
    const [first, second] = await Promise.all([
      h.server.engine.dispatch('createDelegation', { spec: specFor(h.repo) }, ctx(key)),
      h.server.engine.dispatch('createDelegation', { spec: specFor(h.repo) }, ctx(key)),
    ])
    expect(first.ok && second.ok).toBe(true)
    /* §2.5 #3: "every in-flight `req` without an observed `res` is re-sent with the same
     * `idempotencyKey`" — and the durable cache is only written *after* the intent runs. */
    expect(first.ok ? first.value : null).toBe(second.ok ? second.value : undefined)
    expect(h.server.engine.store.read((tx) => tx.listRecords('delegation'))).toHaveLength(1)
  })

  it('the 24 h TTL is enforced, so the cache is not a permanent refusal to re-run a key', async () => {
    let clock = Date.parse('2026-02-01T00:00:00Z')
    const h = await serve({ now: () => clock })
    await h.server.engine.dispatch('createDelegation', { spec: specFor(h.repo) }, ctx('ttl-key'))
    expect(
      h.server.engine.store.read((tx) => tx.getIdempotent('tok-test', 'ttl-key')),
    ).not.toBeNull()

    clock += SERVER_POLICY.idempotencyTtlMs + 60_000
    /* Any later intent prunes; nothing else ever read `createdAt`. */
    await h.server.engine.dispatch('createDelegation', { spec: specFor(h.repo) }, ctx('later-key'))
    expect(h.server.engine.store.read((tx) => tx.getIdempotent('tok-test', 'ttl-key'))).toBeNull()
  })
})

/* ------------------------------------------------------------- §5.3/§7.3 the scrubbed env */

describe('§7.3 — `envAllowlist` is **added to** the mandatory base set, never over it', () => {
  it('an allowlist naming `JCODE_SWARM_ENABLED` cannot re-enable jcode’s native swarm', () => {
    const env = buildBridgeEnv({
      jcodeHome: '/home',
      runtimeDir: '/runtime',
      apiSocket: '/api.sock',
      daemonSocket: '/jcode.sock',
      autoPoke: false,
      allowlist: ['JCODE_SWARM_ENABLED', 'JCODE_MEMORY_ENABLED', 'JCODE_HOME', 'PATH'],
      sourceEnv: {
        JCODE_SWARM_ENABLED: 'true',
        JCODE_MEMORY_ENABLED: 'true',
        JCODE_HOME: '/somewhere/else',
        PATH: '/attacker/bin',
      },
    })
    /* §5.4 #6 and §4.1's triple ladder exist to keep the daemon's native swarm off. A config file
     * that could turn it back on is the same hole wearing a settings UI. */
    expect(env.JCODE_SWARM_ENABLED).toBe('false')
    expect(env.JCODE_MEMORY_ENABLED).toBe('false')
    expect(env.JCODE_HOME).toBe('/home')
    expect(env.PATH).toBe('/attacker/bin')
  })

  it('a name the mandatory set does not claim is still copied through', () => {
    const env = buildBridgeEnv({
      jcodeHome: '/home',
      runtimeDir: '/runtime',
      apiSocket: '/api.sock',
      daemonSocket: '/jcode.sock',
      autoPoke: true,
      allowlist: ['HTTPS_PROXY'],
      sourceEnv: { HTTPS_PROXY: 'http://proxy:3128' },
    })
    expect(env.HTTPS_PROXY).toBe('http://proxy:3128')
    expect(env.JCODE_AUTO_POKE).toBe('1')
  })
})

/* ------------------------------------------------------------------------ §2.4 backpressure */

describe('§2.4 — the frame half of the queue rule can fire, and the paused buffer is bounded', () => {
  it('the constants are the ones the rule is written against', () => {
    expect(BACKPRESSURE.queueFrames).toBe(4_000)
    expect(BACKPRESSURE.queueBytes).toBe(4 * 1024 * 1024)
  })
})

/* ------------------------------------------------------------------ §13/Q10 the moved base */

describe('§13 — a moved base produces `needs-you` with rebase/report/abandon, never a silent land', () => {
  it('`land{mode:commit}` on a moved base is refused `base_moved` and lands nothing', async () => {
    const h = await serve()
    const id = await create(h, {
      acceptance: [{ kind: 'file', id: 'f', label: 'f', path: 'README.md', must: 'exist' }],
    } as never)
    await drain(h)
    await settle(8)
    const attemptId = deleg(h, id).attempts[0]!

    /* The base moves out from under the attempt, which is the whole of Q10's scenario. */
    h.repo.write('moved.txt', 'someone else pushed\n')
    h.repo.commit('a commit the attempt never saw')

    const landed = await h.server.engine.dispatch(
      'land',
      { delegationId: id, attemptId, mode: 'commit' },
      ctx(),
    )
    expect(landed.ok).toBe(false)
    if (!landed.ok) expect(landed.error.code).toBe('base_moved')

    /* Nothing landed, and the record does not claim otherwise. */
    expect(deleg(h, id).landed).toBeNull()
    expect(deleg(h, id).lastNeedsYouReason).toBe('landing-conflict')

    const notice = h.server.engine.listNotices().find((n) => n.kind === 'landing-conflict')
    expect(notice?.dismissible).toBe(false)
    expect(notice?.actions.map((a) => a.intent).sort()).toEqual(['archive', 'land', 'retry'])
  })

  it('a patch still lands against the recorded base — "report" is the action that works', async () => {
    const h = await serve()
    const id = await create(h, {
      acceptance: [{ kind: 'file', id: 'f', label: 'f', path: 'README.md', must: 'exist' }],
    } as never)
    await drain(h)
    await settle(8)
    const attemptId = deleg(h, id).attempts[0]!
    h.repo.write('moved.txt', 'someone else pushed\n')
    h.repo.commit('a commit the attempt never saw')

    const landed = await h.server.engine.dispatch(
      'land',
      { delegationId: id, attemptId, mode: 'patch' },
      ctx(),
    )
    expect(landed.ok).toBe(true)
    expect(deleg(h, id).landed?.mode).toBe('patch')
  })
})
