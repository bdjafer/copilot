/**
 * SPEC-swarm §7.1 (admission), §3.3 D2/D5/D19, §3.4 rules 2–3 and Q16 — the scheduler's own rules.
 *
 * Every case here names a row that the state table declared and no code path reached. They share a
 * shape on purpose: *drive the fleet to the state the row describes, then assert the row*. The
 * table was already tested against itself (`machines-delegation.test.ts` walks all 23 rows); what
 * was missing was a path to them.
 *
 * Node ≥ 24; the store is real SQLite wherever a restart is asserted, because "durable" is a
 * property of the file and `':memory:'` cannot express it.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ExecutorInstance, InstanceOptions } from '../src/server/executor/types.ts'
import type { AttemptRecord, DelegationRecord, InstanceKey } from '../src/types.ts'
import type { ScratchRepo, ServerHarness } from './support/server-harness.ts'

import { SERVER_POLICY } from '../src/domain/constants.ts'
import { homeLease, worktreeLease } from '../src/domain/leases.ts'
import { acquireHomeLock } from '../src/server/executor/spawn.ts'
import { MockExecutor } from '../src/testing/mock-executor.ts'
import {
  createScratchRepo,
  createServerHarness,
  drain,
  settle,
  specFor,
} from './support/server-harness.ts'

let harness: ServerHarness | null = null
const scratch: string[] = []

afterEach(async () => {
  await harness?.dispose()
  harness = null
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const actor = { kind: 'user', head: 'test', tokenId: 'tok-test' } as const
let idem = 0
function ctx(): { actor: typeof actor; tokenId: string; idempotencyKey: string } {
  idem += 1
  return { actor, tokenId: 'tok-test', idempotencyKey: `scheduler-${idem}` }
}

async function serve(
  options: Parameters<typeof createServerHarness>[0] = {},
): Promise<ServerHarness> {
  harness = await createServerHarness({ listen: false, ...options })
  return harness
}

async function create(h: ServerHarness, spec: Parameters<typeof specFor>[1] = {}): Promise<string> {
  const result = await h.server.engine.dispatch(
    'createDelegation',
    { spec: specFor(h.repo, spec) },
    ctx(),
  )
  if (!result.ok) throw result.error
  return result.value as string
}

const deleg = (h: ServerHarness, id: string): DelegationRecord =>
  h.server.engine.store.read((tx) => tx.getRecord<DelegationRecord>('delegation', id)!.value)

const attempt = (h: ServerHarness, id: string): AttemptRecord =>
  h.server.engine.store.read((tx) => tx.getRecord<AttemptRecord>('attempt', id)!.value)

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-sched-'))
  scratch.push(dir)
  return dir
}

/* ------------------------------------------------------------------ D2: the admission epoch */

describe('§7.1/D2 — an attempt is admitted by D2 or D19, and by nothing else', () => {
  it('a delegation with `parallelAttempts:2` does not grow a third attempt when one ends', async () => {
    const h = await serve()
    const id = await create(h, { parallelAttempts: 2 })
    await drain(h)
    expect(deleg(h, id).attempts).toHaveLength(2)

    /* §3.3's rollup note is explicit that a sibling ending does not end the others — so the
     * scheduler sees a free slot on the very next tick, and used to fill it. Forever. */
    const discarded = await h.server.engine.dispatch(
      'discard',
      { attemptId: deleg(h, id).attempts[0] },
      ctx(),
    )
    expect(discarded.ok).toBe(true)
    await drain(h)
    await drain(h)

    const after = deleg(h, id)
    expect(after.attempts).toHaveLength(2)
    expect(after.liveAttempts).toHaveLength(1)
  })

  it('D19 opens a new epoch: `retry` provisions attempt N+1 and returns its id', async () => {
    const h = await serve()
    const id = await create(h)
    await drain(h)
    const first = deleg(h, id).attempts[0]!

    await h.server.engine.dispatch('cancel', { delegationId: id, scope: 'delegation' }, ctx())
    const retried = await h.server.engine.dispatch('retry', { delegationId: id }, ctx())
    expect(retried.ok).toBe(true)

    /* §6.3 declares `IntentResult<AttemptId[]>`; the old implementation returned the literal `[]`. */
    const opened = (retried.ok ? retried.value : []) as readonly string[]
    expect(opened).toHaveLength(1)
    expect(opened[0]).not.toBe(first)
    expect(deleg(h, id).attempts).toEqual([first, opened[0]])
  })

  it('a `retry{spec}` edits the frozen spec copy the next attempt carries (A2)', async () => {
    const h = await serve()
    const id = await create(h)
    await drain(h)
    await h.server.engine.dispatch('cancel', { delegationId: id, scope: 'delegation' }, ctx())

    const retried = await h.server.engine.dispatch(
      'retry',
      { delegationId: id, spec: { objective: 'a different objective', constraints: 'be brief' } },
      ctx(),
    )
    expect(retried.ok).toBe(true)
    const opened = (retried.ok ? retried.value : []) as readonly string[]
    expect(attempt(h, opened[0]!).spec.objective).toBe('a different objective')
    /* `workspace` is deliberately not patchable — a moved base is a different delegation (C4b). */
    expect(attempt(h, opened[0]!).spec.workspace.baseRevision).toBe(h.repo.head)
  })

  it('`retry{injectPriorFailure}` puts the previous outcome in the next objective, once', async () => {
    const h = await serve()
    const id = await create(h)
    await drain(h)
    await h.server.engine.dispatch('cancel', { delegationId: id, scope: 'delegation' }, ctx())

    const retried = await h.server.engine.dispatch(
      'retry',
      { delegationId: id, injectPriorFailure: true },
      ctx(),
    )
    const second = ((retried.ok ? retried.value : []) as readonly string[])[0]!
    const turns = h.server.engine.store.read((tx) =>
      attempt(h, second).turns.map(
        (t) => tx.getRecord<{ directive: { text: string } }>('turn', t)!.value,
      ),
    )
    expect(turns[0]!.directive.text).toContain('The previous attempt')
    expect(turns[0]!.directive.text).toContain('cancelled')

    /* Consumed: attempt N+2 must not inherit N's failure as if it were its own. */
    await h.server.engine.dispatch('cancel', { delegationId: id, scope: 'delegation' }, ctx())
    const again = await h.server.engine.dispatch('retry', { delegationId: id }, ctx())
    const third = ((again.ok ? again.value : []) as readonly string[])[0]!
    const laterTurns = h.server.engine.store.read((tx) =>
      attempt(h, third).turns.map(
        (t) => tx.getRecord<{ directive: { text: string } }>('turn', t)!.value,
      ),
    )
    expect(laterTurns[0]!.directive.text).not.toContain('The previous attempt')
  })

  it('a D19 reopen re-ages: its epoch starts now, so it never permanently outranks newer work', async () => {
    const h = await serve()
    const id = await create(h)
    await drain(h)
    const createdAt = deleg(h, id).createdAt
    await h.server.engine.dispatch('cancel', { delegationId: id, scope: 'delegation' }, ctx())
    await h.server.engine.dispatch('retry', { delegationId: id }, ctx())

    const meta = h.server.engine.store.read(
      (tx) => tx.getRecord<{ epochQueuedAt?: number }>('delegation_meta', id)!.value,
    )
    expect(meta.epochQueuedAt).toBeGreaterThanOrEqual(createdAt)
  })
})

/* ------------------------------------------------------- D5: three bounded provisioning retries */

describe('§3.3 D5 — provisioning fails after three bounded retries, and not before', () => {
  /** An adapter that refuses to hand out an instance, counting how often it was asked. */
  class RefusingExecutor extends MockExecutor {
    /* Not `calls`: the base class owns that name for its ordered call log (`MockExecutorCall[]`). */
    acquisitions = 0
    override acquireInstance(key: InstanceKey, opts: InstanceOptions): Promise<ExecutorInstance> {
      this.acquisitions += 1
      void opts
      return Promise.reject(new Error(`no instance for ${key}`))
    }
  }

  it('one transient refusal requeues instead of wedging the delegation in `provisioning`', async () => {
    const adapter = new RefusingExecutor()
    const h = await serve({ adapter })
    const id = await create(h)
    await settle(2)
    await h.server.engine.tick()
    await settle(4)

    const after = deleg(h, id)
    /* The old behaviour: `liveAttempts` kept the half-built attempt, so `wanted` was 0 forever and
     * failures 2 and 3 could never happen — a permanent `provisioning` with one `acquireInstance`. */
    expect(after.state).toBe('queued')
    expect(after.liveAttempts).toHaveLength(0)
    expect(after.attempts).toHaveLength(0)
    expect(adapter.acquisitions).toBeGreaterThan(0)
    /* Bounded: the counter is the only thing that decides when D5 fires. */
    expect(h.server.engine.store.read((tx) => tx.counter(`provision_failures:${id}`))).toBeLessThan(
      SERVER_POLICY.provisionRetries,
    )
  })

  it('the worktree lease and the worktree directory come back on every failed attempt', async () => {
    const adapter = new RefusingExecutor()
    const h = await serve({ adapter })
    const id = await create(h)
    await settle(2)
    await h.server.engine.tick()
    await settle(4)

    const worktree = join(h.home, 'worktrees', id, '1')
    const held = h.server.engine.store.read((tx) => tx.getLease(worktreeLease(worktree)))
    expect(held).toBeNull()
    expect(() => readFileSync(join(worktree, 'README.md'))).toThrow()
  })

  it('the third failure reaches `failed` through D5 and records `provision_failed`', async () => {
    const adapter = new RefusingExecutor()
    const h = await serve({ adapter })
    const id = await create(h)
    for (let i = 0; i < SERVER_POLICY.provisionRetries + 2; i++) {
      await settle(2)
      await h.server.engine.tick()
      await settle(4)
    }
    expect(adapter.acquisitions).toBeGreaterThanOrEqual(SERVER_POLICY.provisionRetries)
    expect(deleg(h, id).state).toBe('failed')

    const audit = h.server.engine.store.read((tx) => tx.readAudit(0, 100))
    const row = audit.filter((r) => r.intent === 'provision').at(-1)
    expect(row?.effective).toMatchObject({ of: SERVER_POLICY.provisionRetries, row: 'D5' })
  })
})

/* --------------------------------------------------------------- Q16: the pause is durable */

describe('§3.5/Q16 — a fleet-wide dispatch pause survives a restart', () => {
  it('`pauseDispatch{fleet}` still refuses admission after the server is rebuilt on the same db', async () => {
    const home = tempHome()
    const db = join(home, 'swarm.db')
    const repo: ScratchRepo = createScratchRepo()
    scratch.push(repo.root)

    const first = await serve({ home, dbPath: db, repo })
    const paused = await first.server.engine.dispatch(
      'pauseDispatch',
      { scope: { fleet: true }, paused: true },
      ctx(),
    )
    expect(paused.ok).toBe(true)
    await first.server.close()
    harness = null

    const second = await createServerHarness({ listen: false, home, dbPath: db, repo })
    harness = second
    const id = await create(second, {})
    await drain(second)
    /* The switch always pauses (Q16), and a pause that evaporates on restart is not a switch. */
    expect(deleg(second, id).attempts).toHaveLength(0)

    await second.server.engine.dispatch(
      'pauseDispatch',
      { scope: { fleet: true }, paused: false },
      ctx(),
    )
    await drain(second)
    expect(deleg(second, id).attempts).toHaveLength(1)
  })

  it('`killSwitch` persists the pause it sets (Q16, §13 crash-resume)', async () => {
    const home = tempHome()
    const db = join(home, 'swarm.db')
    const repo = createScratchRepo()
    scratch.push(repo.root)

    const first = await serve({ home, dbPath: db, repo })
    const killed = await first.server.engine.dispatch('killSwitch', {}, ctx())
    expect(killed.ok).toBe(true)
    await first.server.close()
    harness = null

    const second = await createServerHarness({ listen: false, home, dbPath: db, repo })
    harness = second
    const id = await create(second, {})
    await drain(second)
    expect(deleg(second, id).attempts).toHaveLength(0)
  })
})

/* ------------------------------------------------- §3.4 rule 3 / §7.2: the `home:*` singleton */

describe('§3.4 rule 3 / §7.2 — the `home:*` lease and `instances/<hash>/lock`', () => {
  it('an admitted attempt holds a `home:*` lease for its instance', async () => {
    const h = await serve()
    const id = await create(h)
    await drain(h)
    const record = attempt(h, deleg(h, id).attempts[0]!)
    const jcodeHome = h.server.engine.store.read((tx) =>
      tx.listLeases().find((lease) => lease.key.startsWith('home:')),
    )
    expect(jcodeHome).not.toBeUndefined()
    expect(jcodeHome!.holder).toBe(`instance:${record.executor.instanceKey}`)
    /* §7.1: "an attempt is admitted only when *all* hold: … `home:*` lease" — and the holder is
     * the instance, because sibling attempts share one home by construction. */
    expect(jcodeHome!.key).toBe(
      homeLease(join(h.home, 'instances', jcodeHome!.key.split('/').at(-2) ?? '', 'home')),
    )
  })

  it('the lease is renewed rather than left to expire (§3.4 rule 2)', async () => {
    const h = await serve()
    const id = await create(h)
    await drain(h)
    const before = h.server.engine.store.read((tx) => tx.listLeases())
    expect(before.length).toBeGreaterThan(0)

    const renewed = h.server.engine.renewLeases()
    expect(renewed).toBeGreaterThan(0)
    const after = h.server.engine.store.read((tx) => tx.listLeases())
    for (const lease of after) {
      const previous = before.find((row) => row.key === lease.key)
      if (previous === undefined) continue
      expect(lease.expiresAt).toBeGreaterThanOrEqual(previous.expiresAt)
      /* Renewal keeps the fence: a token that moved would invalidate the writer mid-turn. */
      expect(lease.token).toBe(previous.token)
    }
    void id
  })

  it('`instances/<hash>/lock` is an O_EXCL singleton, reclaimed only after a liveness probe fails', () => {
    const dir = tempHome()
    const path = join(dir, 'lock')
    const first = acquireHomeLock(path, { pid: 4242, bootId: 'boot-a' }, { alive: () => true })
    expect(first.path).toBe(path)

    /* A live incumbent owns the home: two daemons on one state dir corrupt it (§5.3, R9). */
    expect(() =>
      acquireHomeLock(path, { pid: 99, bootId: 'boot-b' }, { alive: () => true }),
    ).toThrow(/jcode home is held by pid 4242/)

    /* A dead one left a file, not a claim — which is the only reason the pid is in there. */
    const reclaimed = acquireHomeLock(path, { pid: 99, bootId: 'boot-b' }, { alive: () => false })
    expect(JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).toMatchObject({ pid: 99 })
    reclaimed.release()
    first.release()
  })
})
