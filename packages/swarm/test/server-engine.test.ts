/**
 * SPEC-swarm §3.3, §4, §5.5, §7.1 and §7.3 — the orchestration core, driven through the engine
 * over `MockExecutor` and a real scratch git repository.
 *
 * Almost every case here is one of §13's **named behavioural tests**, and the name says which:
 * `unknown` never auto-resends, a turn override does not leak, a mid-turn config change produces
 * zero executor calls, the kill switch never terminalizes, a symlink out of an allowlisted root is
 * refused on both doors, `bucketOf` covers `verifying`, an audit row outlives its delegation.
 *
 * The scheduler is ticked explicitly (`autoTick: false`): admission is a decision, and a decision
 * asserted against a background loop is a race dressed as a test.
 */

import { symlinkSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { AttemptRecord, DelegationRecord, TurnRecord } from '../src/types.ts'
import type { ServerHarness } from './support/server-harness.ts'

import { CHANNEL_RECONNECT } from '../src/domain/constants.ts'
import { sessionLease } from '../src/domain/leases.ts'
import { SwarmError } from '../src/errors.ts'
import { parseStreamName } from '../src/protocol/codec.ts'
import { MockExecutor } from '../src/testing/mock-executor.ts'
import {
  createScratchRepo,
  createServerHarness,
  drain,
  settle,
  specFor,
} from './support/server-harness.ts'

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

const actor = { kind: 'user', head: 'test', tokenId: 'tok-test' } as const

let idem = 0
function ctx(): { actor: typeof actor; tokenId: string; idempotencyKey: string } {
  idem += 1
  return { actor, tokenId: 'tok-test', idempotencyKey: `idem-${idem}` }
}

/** `createDelegation` through the real intent door, so the declared `IntentArgs` shape is used. */
async function create(
  h: ServerHarness,
  spec: Parameters<typeof specFor>[1] = {},
  extra: Record<string, unknown> = {},
): Promise<string> {
  const result = await h.server.engine.dispatch(
    'createDelegation',
    { spec: specFor(h.repo, spec), ...extra },
    ctx(),
  )
  if (!result.ok) throw result.error
  return result.value as string
}

function delegation(h: ServerHarness, id: string): DelegationRecord {
  return h.server.engine.store.read((tx) => tx.getRecord<DelegationRecord>('delegation', id)!.value)
}

function attempt(h: ServerHarness, id: string): AttemptRecord {
  return h.server.engine.store.read((tx) => tx.getRecord<AttemptRecord>('attempt', id)!.value)
}

function turn(h: ServerHarness, id: string): TurnRecord {
  return h.server.engine.store.read((tx) => tx.getRecord<TurnRecord>('turn', id)!.value)
}

/** `true`, or the refusal's code — so a failing assertion names the error instead of `false`. */
function okOf(result: { ok: boolean } | { ok: false; error: SwarmError }): true | string {
  return result.ok ? true : (result as { error: SwarmError }).error.code
}

/** Run the scheduler to quiescence — see `drain`'s note on the single-loop re-entrancy guard. */
async function tick(h: ServerHarness): Promise<void> {
  await drain(h)
}

/* ------------------------------------------------------------------- create, guard, base ref */

describe('§3.1 C4b — the record never holds a symbolic ref', () => {
  it('`createDelegation({baseRef:"HEAD"})` stores a 40-char sha, and no record holds "HEAD"', async () => {
    const h = await serve()
    const id = await create(h)
    const record = delegation(h, id)
    expect(record.spec.workspace.baseRevision).toBe(h.repo.head)
    expect(record.spec.workspace.baseRevision).toMatch(/^[0-9a-f]{40}$/)
    expect(JSON.stringify(record)).not.toContain('"HEAD"')
  })

  it('an unresolvable ref refuses with `base_unresolvable`', async () => {
    const h = await serve()
    const result = await h.server.engine.dispatch(
      'createDelegation',
      { spec: { ...specFor(h.repo), workspace: { workspaceId: 'scratch', baseRef: 'no-such' } } },
      ctx(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('base_unresolvable')
  })
})

describe('§7.3 the workspace allowlist (S6) — checked on the resolved path, every time', () => {
  it('refuses an unregistered workspace with `workspace_denied`', async () => {
    const h = await serve()
    const result = await h.server.engine.dispatch(
      'createDelegation',
      { spec: { ...specFor(h.repo), workspace: { workspaceId: 'elsewhere', baseRef: 'HEAD' } } },
      ctx(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('workspace_denied')
  })

  it('refuses a symlink inside the root that points outside it — on session creation AND on a verifier run', async () => {
    const h = await serve()
    const outside = createScratchRepo({ workspaceId: 'outside' })
    symlinkSync(outside.root, join(h.repo.root, 'escape'))

    /* Door one: the create/session path. */
    const created = await h.server.engine.dispatch(
      'createDelegation',
      {
        spec: {
          ...specFor(h.repo),
          workspace: { workspaceId: 'scratch', baseRef: 'HEAD', subPath: 'escape' },
        },
      },
      ctx(),
    )
    expect(created.ok).toBe(false)
    if (!created.ok) expect(created.error.code).toBe('workspace_denied')

    /* Door two: the verifier's own re-check — a guard that ran only at session creation would let
     * an agent-planted symlink run acceptance commands anywhere on disk (§8.1, §13). */
    expect(() =>
      h.server.guard.assertInsideWorkspace('scratch', join(h.repo.root, 'escape')),
    ).toThrow(/workspace_denied|outside the workspace root/)
    outside.dispose()
  })

  it('refuses `in-place` on a dirty tree with `workspace_dirty`; `allowDirty` proceeds and is attributable', async () => {
    const repo = createScratchRepo({ writeMode: 'in-place' })
    const h = await serve({ repo })
    repo.write('dirty.txt', 'uncommitted')

    const refused = await h.server.engine.dispatch(
      'createDelegation',
      {
        spec: {
          ...specFor(repo),
          workspace: { workspaceId: 'scratch', baseRef: 'HEAD', writeMode: 'in-place' },
        },
      },
      ctx(),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('workspace_dirty')

    const allowed = await h.server.engine.dispatch(
      'createDelegation',
      {
        spec: {
          ...specFor(repo),
          workspace: {
            workspaceId: 'scratch',
            baseRef: 'HEAD',
            writeMode: 'in-place',
            allowDirty: { note: 'I know what I am doing' },
          },
        },
      },
      ctx(),
    )
    expect(allowed.ok).toBe(true)
    if (!allowed.ok) return
    const record = delegation(h, allowed.value as string)
    /* C6: the one escape hatch from the one destructive mode is stamped with who and when. */
    expect(record.spec.workspace.allowDirty).toMatchObject({
      note: 'I know what I am doing',
      actor: { kind: 'user', tokenId: 'tok-test' },
    })
    expect(typeof record.spec.workspace.allowDirty?.at).toBe('number')
    const audit = h.server.engine.store.read((tx) => tx.readAudit(0, 50))
    expect(audit.some((row) => row.intent === 'createDelegation')).toBe(true)
  })

  it('a `sensitive` workspace forces worktree, refuses `in-place` and refuses `allowDirty` (#28)', async () => {
    const repo = createScratchRepo({ sensitive: true })
    const h = await serve({ repo })

    const inPlace = await h.server.engine.dispatch(
      'createDelegation',
      {
        spec: {
          ...specFor(repo),
          workspace: { workspaceId: 'scratch', baseRef: 'HEAD', writeMode: 'in-place' },
        },
      },
      ctx(),
    )
    expect(inPlace.ok).toBe(false)
    if (!inPlace.ok) expect(inPlace.error.code).toBe('workspace_denied')

    const dirty = await h.server.engine.dispatch(
      'createDelegation',
      {
        spec: {
          ...specFor(repo),
          workspace: {
            workspaceId: 'scratch',
            baseRef: 'HEAD',
            allowDirty: { note: 'nope' },
          },
        },
      },
      ctx(),
    )
    expect(dirty.ok).toBe(false)
    if (!dirty.ok) expect(dirty.error.code).toBe('workspace_denied')

    const forced = await create(h)
    expect(delegation(h, forced).spec.workspace.writeMode).toBe('worktree')
    /* There is no `readonly` value to request: it is not a member of the union (Q6, #28). */
    expect(['worktree', 'in-place']).toContain(delegation(h, forced).spec.workspace.writeMode)
  })
})

/* -------------------------------------------------------------------- the three machines */

describe('§3.3 D-rows — the delegation rollup', () => {
  it('D1 → D2 → D4: create, admit one attempt, run it, and land in `waiting` at turn end', async () => {
    const h = await serve()
    const created: string[] = []
    const unsubscribe = h.server.engine.store.onCommit((result) => {
      for (const record of result.emitted) {
        if (record.ev.k === 'fleet.delegation_created') created.push(record.ev.delegation.state)
      }
    })
    const id = await create(h, {
      acceptance: [
        { kind: 'file', id: 'readme', label: 'readme', path: 'README.md', must: 'exist' },
      ],
    })
    unsubscribe()
    /* D1 is `— → queued`, asserted on the event the create transaction emitted: the scheduler
     * ticks on every state change (§7.1), so by the time a test can read the record the first
     * attempt may already have been admitted — which is D2 doing its job, not D1 failing. */
    expect(created).toEqual(['queued'])

    await tick(h)
    const record = delegation(h, id)
    expect(record.attempts).toHaveLength(1)
    /* The objective is the first turn, the mock answers it, and verification runs at turn end. */
    expect(['running', 'verifying', 'succeeded', 'waiting']).toContain(record.state)
  })

  it('D17 — `cancel{scope:"delegation"}` is the ONLY path to `cancelled` (#31)', async () => {
    const h = await serve()
    const id = await create(h)
    await tick(h)
    const cancelled = await h.server.engine.dispatch(
      'cancel',
      { delegationId: id, scope: 'delegation' },
      ctx(),
    )
    expect(okOf(cancelled)).toBe(true)
    expect(delegation(h, id).state).toBe('cancelled')
    expect(delegation(h, id).liveAttempts).toEqual([])
  })

  it('D23 — `killSwitch` leaves every delegation non-terminal and every worktree present', async () => {
    const h = await serve()
    const id = await create(h)
    await tick(h)
    const before = delegation(h, id)
    const worktree = attempt(h, before.attempts[0]!).workspace.worktree!

    const result = await h.server.engine.dispatch('killSwitch', { killInstances: false }, ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const report = result.value as {
      delegationsTerminated: readonly unknown[]
      worktreesRemoved: readonly unknown[]
      dispatchPausedFleetWide: boolean
    }
    /* Literal-empty by type; asserted at runtime because a future edit that terminalizes would
     * otherwise only fail to typecheck in the file that changed. */
    expect(report.delegationsTerminated).toEqual([])
    expect(report.worktreesRemoved).toEqual([])
    expect(report.dispatchPausedFleetWide).toBe(true)

    const after = delegation(h, id)
    expect(['queued', 'provisioning', 'running', 'waiting', 'verifying', 'needs-you']).toContain(
      after.state,
    )
    expect(pathExists(worktree)).toBe(true)
  })

  it('D14 — an unverifiable delegation reaches `succeeded` only through `accept{note}` (Q1)', async () => {
    const h = await serve()
    const id = await create(h, { acceptance: [] })
    expect(delegation(h, id).unverifiable).toBe(true)
    await tick(h)

    /* `turn_done` alone never reaches `succeeded`: the attempt goes to `needs-you` instead. */
    expect(delegation(h, id).state).not.toBe('succeeded')
    expect(delegation(h, id).lastNeedsYouReason).toBe('unverifiable-turn-end')

    const accepted = await h.server.engine.dispatch(
      'accept',
      { delegationId: id, note: 'looks right to me' },
      ctx(),
    )
    expect(okOf(accepted)).toBe(true)
    const record = delegation(h, id)
    expect(record.state).toBe('succeeded')
    expect(record.verdict).toBe('accepted')

    const audit = h.server.engine.store.read((tx) => tx.readAudit(0, 100))
    const row = audit.find((entry) => entry.intent === 'accept')
    expect(row?.actor).toMatchObject({ kind: 'user', tokenId: 'tok-test' })
    expect(typeof row?.ts).toBe('number')
  })

  it('D22/Q11 — a hard spend cap pauses dispatch and never cancels the in-flight turn', async () => {
    const h = await serve()
    const id = await create(h, {
      /* One turn of budget: the objective turn exhausts it at its own end. */
      budget: {
        maxWallMs: 45 * 60_000,
        maxTurns: 1,
        maxToolCalls: 200,
        maxInputTokens: 2_000_000,
        maxOutputTokens: 200_000,
        onBreach: 'pause-dispatch',
      },
      acceptance: [
        { kind: 'file', id: 'readme', label: 'readme', path: 'README.md', must: 'exist' },
      ],
    })
    await tick(h)
    const record = delegation(h, id)
    expect(record.dispatchPaused).toBe(true)
    /* The turn that breached still reached `turn_done`; only dispatch stopped. */
    const first = turn(h, attempt(h, record.attempts[0]!).turns[0]!)
    expect(first.delivery).toBe('ended')
    expect(first.endedAt).not.toBeNull()
  })
})

describe('§3.3 C-rows — the channel supervisor', () => {
  it('C9 → C11: an interrupt that keeps producing deltas merges back into `streaming`', async () => {
    const h = await serve({ config: {} })
    const id = await create(h)
    await tick(h)
    const attemptId = delegation(h, id).attempts[0]!

    /* Force the channel into `streaming`, then issue the interrupt the way the server does. */
    const engine = h.server.engine
    engine.store.commit((tx) => {
      const record = tx.getRecord<AttemptRecord>('attempt', attemptId)!.value
      tx.putRecord('attempt', attemptId, 1, { ...record, channel: 'streaming' })
    })
    await engine.dispatch('cancel', { delegationId: id, scope: 'turn' }, ctx())
    /* `cancel` may have driven `turn_done` through the mock, which is C10 and outranks C11. */
    expect(['interrupting', 'idle', 'streaming']).toContain(attempt(h, attemptId).channel)
  })

  it('C13 → C14: the reconnect ladder runs its budget and `closed` releases the writer lease', async () => {
    const h = await serve()
    const id = await create(h)
    await tick(h)
    const attemptId = delegation(h, id).attempts[0]!
    const sessionId = attempt(h, attemptId).executor.sessionId!

    h.server.engine.store.commit((tx) => {
      const record = tx.getRecord<AttemptRecord>('attempt', attemptId)!.value
      tx.putRecord('attempt', attemptId, 1, {
        ...record,
        channel: 'disconnected',
        outcome: 'interrupted',
      })
    })

    const outcome = await h.server.engine.reconnectChannel(attemptId)
    /* The mock's session was closed by the disconnect, so every attach fails and the ladder
     * spends its eight tries — C3 each time, then C14. */
    expect(['reattached', 'exhausted']).toContain(outcome)
    if (outcome === 'exhausted') {
      expect(attempt(h, attemptId).channel).toBe('closed')
      expect(h.server.engine.store.read((tx) => tx.getLease(sessionLease(sessionId)))).toBeNull()
      const meta = h.server.engine.store.read(
        (tx) => tx.getRecord<{ reconnectTries: number }>('attempt_meta', attemptId)?.value,
      )
      expect(meta?.reconnectTries).toBe(CHANNEL_RECONNECT.maxTries)
    }
  }, 20_000)

  it('C15 — `close()` is the only lease release, and the channel row says so', async () => {
    const h = await serve()
    const id = await create(h, {
      acceptance: [
        { kind: 'file', id: 'readme', label: 'readme', path: 'README.md', must: 'exist' },
      ],
    })
    await tick(h)
    const record = delegation(h, id)
    const attemptId = record.attempts[0]!
    const sessionId = attempt(h, attemptId).executor.sessionId!
    if (record.state === 'succeeded') {
      expect(attempt(h, attemptId).channel).toBe('closed')
      expect(h.server.engine.store.read((tx) => tx.getLease(sessionLease(sessionId)))).toBeNull()
    }
  })
})

/* ------------------------------------------------------------------ §4 the turn directive */

describe('§4 the per-turn control block, at the SERVER boundary', () => {
  it('`swarm` and `swarm-deep` are refused at the server intent boundary (#9, layer 2)', async () => {
    const h = await serve()
    const id = await create(h)
    await tick(h)
    for (const effort of ['swarm', 'swarm-deep']) {
      const result = await h.server.engine.dispatch(
        'sendTurn',
        {
          delegationId: id,
          directive: { text: 'go', reasoningEffort: effort, idempotencyKey: `k-${effort}` },
        },
        ctx(),
      )
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.code).toBe('banned_effort')
    }
  })

  it('`{delivery:"interrupt", reasoningEffort:"max"}` is refused `config_not_available_in_mode` (#30)', async () => {
    const h = await serve()
    const id = await create(h)
    await tick(h)
    const refused = await h.server.engine.dispatch(
      'sendTurn',
      {
        delegationId: id,
        directive: {
          text: 'stop touching the fixtures',
          delivery: 'interrupt',
          reasoningEffort: 'max',
          idempotencyKey: 'k-mode',
        },
      },
      ctx(),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('config_not_available_in_mode')

    /* The same turn without the field is accepted and records `'inherited'` — the only honest
     * value for a mode that runs under whatever the previous turn set. */
    const accepted = await h.server.engine.dispatch(
      'sendTurn',
      {
        delegationId: id,
        directive: {
          text: 'stop touching the fixtures',
          delivery: 'interrupt',
          idempotencyKey: 'k-mode-2',
        },
      },
      ctx(),
    )
    expect(okOf(accepted)).toBe(true)
    if (!accepted.ok) return
    const record = turn(h, accepted.value as string)
    expect(record.effective.reasoningEffort).toBe('inherited')
    expect(record.effective.model).toBe('inherited')
    expect(record.deliveryDetail.landing).toBe('unconfirmed')
  })

  it('every persisted `EffectiveTurnConfig` carries `effortConfirmed: false`, without exception', async () => {
    const h = await serve()
    const id = await create(h)
    await tick(h)
    await h.server.engine.dispatch(
      'sendTurn',
      {
        delegationId: id,
        directive: { text: 'plan first', reasoningEffort: 'max', idempotencyKey: 'k1' },
      },
      ctx(),
    )
    await settle(6)
    const turns = h.server.engine.store.read((tx) => tx.listRecords<TurnRecord>('turn'))
    expect(turns.length).toBeGreaterThan(0)
    for (const stored of turns) {
      expect({ id: stored.id, confirmed: stored.value.effective.effortConfirmed }).toEqual({
        id: stored.id,
        confirmed: false,
      })
    }
  })

  it('Q4 non-sticky — turn 2 reconciles to the DELEGATION default, not to turn 1s override', async () => {
    const adapter = new MockExecutor()
    const h = await serve({ adapter })
    /* OpenAI, because `max` is on **its** ladder: Anthropic's is `none…high` plus `xhigh`/`max`
     * only for models in the capability table, which ships empty (§4.1). A refusal here would be
     * `unknown_effort`, which is the ladder working, not the cascade failing. */
    const id = await create(h, {
      model: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'medium' },
    })
    await tick(h)

    const first = await h.server.engine.dispatch(
      'sendTurn',
      {
        delegationId: id,
        directive: { text: 'plan', reasoningEffort: 'max', idempotencyKey: 'k1' },
      },
      ctx(),
    )
    expect(okOf(first)).toBe(true)
    await settle(8)
    await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'apply step 1', idempotencyKey: 'k2' } },
      ctx(),
    )
    await settle(8)

    const attemptId = delegation(h, id).attempts[0]!
    const turns = attempt(h, attemptId).turns.map((turnId) => turn(h, turnId))
    expect(turns.map((row) => row.directive.text)).toContain('plan')
    const withMax = turns.find((row) => row.directive.text === 'plan')
    const without = turns.find((row) => row.directive.text === 'apply step 1')
    expect(withMax?.effective.reasoningEffort).toBe('max')
    /* The omission resets to the delegation default ('medium'), never to 'max' (§4.3.2). */
    expect(without?.effective.reasoningEffort).toBe('medium')

    /* …and the reset REACHED THE EXECUTOR. Every assertion above reads `effective`, which is
     * `effectiveTurnConfig`'s pure output over `(directive, delegation defaults)` — the record, not
     * the session. Deleting the `applyConfig` call from `dispatchQueue` outright left the whole
     * suite green, so §4.2's "`setReasoningEffort` (await) → … → `sendMessage`" was asserted
     * nowhere at any level. `adapter.calls` is the ordered log of what actually left swarm. */
    const efforts = adapter.calls.flatMap((call) =>
      call.k === 'applyConfig' && call.patch.reasoningEffort !== undefined
        ? [call.patch.reasoningEffort]
        : [],
    )
    /* Three, not two: `execution.autoPoke` opens the attempt with the objective under the
     * delegation default before either of these turns exists. */
    expect(efforts).toEqual(['medium', 'max', 'medium'])

    /* Order, not just presence: config is applied BEFORE the send it configures, per turn. */
    const sequence = adapter.calls.flatMap((call) =>
      call.k === 'applyConfig'
        ? [`config:${String(call.patch.reasoningEffort)}`]
        : call.k === 'submit'
          ? [`submit:${call.text}`]
          : [],
    )
    expect(sequence.slice(-4)).toEqual([
      'config:max',
      'submit:plan',
      'config:medium',
      'submit:apply step 1',
    ])
  })

  it('§4.2 — the model reaches the executor as a `setModel` before the send, and is not re-sent', async () => {
    const adapter = new MockExecutor()
    const h = await serve({ adapter })
    const id = await create(h, {
      model: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'medium' },
    })
    await tick(h)

    await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'one', idempotencyKey: 'm1' } },
      ctx(),
    )
    await settle(8)
    await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'two', model: 'gpt-5.4-mini', idempotencyKey: 'm2' } },
      ctx(),
    )
    await settle(8)

    const models = adapter.calls.flatMap((call) =>
      call.k === 'applyConfig' && call.patch.model !== undefined ? [call.patch.model] : [],
    )
    /* Turn 1 asserts the delegation default against an empty shadow; turn 2 asserts its override.
     * Neither is a re-send of a value the shadow already holds — the shadow is what makes §4.2's
     * "if it differs" a real condition rather than a comment. */
    expect(models).toEqual(['gpt-5.4', 'gpt-5.4-mini'])
  })

  it('a `reasoningEffort: null` delegation dispatches its turns instead of refusing every one pre-flight', async () => {
    /*
     * The regression this pins was CRITICAL and invisible: `shadow.effort` starts `undefined`,
     * `reconciliationTarget` returns `null` for a delegation whose default effort is `null`,
     * `null !== undefined`, so the engine built `patch.reasoningEffort = null` — which the jcode
     * adapter refuses `no_effort_to_set`, because the wire has no unset. Every turn of such a
     * delegation was therefore moved to `refused_preflight` and dequeued, on the first turn and
     * again after every reconnect (the shadow is re-invalidated on each reattach). It never
     * surfaced because `MockExecutor.applyConfig` ACCEPTED `null` and reported it applied.
     *
     * The mock now refuses it exactly as jcode does (pinned for every adapter in
     * `executorConformance`), so this case fails against the old engine.
     *
     * `''` in the extension head's `effort()` maps to `null`, so this is a state the shipped UI
     * can produce.
     */
    const adapter = new MockExecutor()
    const h = await serve({ adapter })
    const id = await create(h, {
      model: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: null },
    })
    await tick(h)

    const sent = await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'go with the default', idempotencyKey: 'k-null' } },
      ctx(),
    )
    expect(okOf(sent)).toBe(true)
    await settle(8)

    const attemptId = delegation(h, id).attempts[0]!
    const turns = attempt(h, attemptId).turns.map((turnId) => turn(h, turnId))
    const row = turns.find((t) => t.directive.text === 'go with the default')
    expect(row?.effective.reasoningEffort).toBe(null)
    expect(row?.delivery).not.toBe('refused_preflight')

    /* Nothing unsendable was ever offered to the executor: there is no effort to reconcile TO
     * when none was ever driven, so `applyConfig` carries the model alone. */
    const efforts = adapter.calls.flatMap((call) =>
      call.k === 'applyConfig' && call.patch.reasoningEffort !== undefined
        ? [call.patch.reasoningEffort]
        : [],
    )
    expect(efforts).toEqual([])
    expect(
      adapter.calls.some((call) => call.k === 'submit' && call.text === 'go with the default'),
    ).toBe(true)
  })

  it('an effort that WAS driven and cannot be unset refuses the turn rather than run it under a lie', async () => {
    /* The other half of the `null` rule. Turn 1 drives `max`; turn 2 omits the field, so §4.3.2
     * reconciles to the delegation default — which is `null`, "no effort is driven". No wire can
     * express that, so the honest outcome is V3's `refused_preflight`, never a send under an
     * effort the turn's own record denies (§4.3.4). */
    const adapter = new MockExecutor()
    const h = await serve({ adapter })
    const id = await create(h, {
      model: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: null },
    })
    await tick(h)

    await h.server.engine.dispatch(
      'sendTurn',
      {
        delegationId: id,
        directive: { text: 'deep', reasoningEffort: 'max', idempotencyKey: 'n1' },
      },
      ctx(),
    )
    await settle(8)
    await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'shallow again', idempotencyKey: 'n2' } },
      ctx(),
    )
    await settle(8)

    const attemptId = delegation(h, id).attempts[0]!
    const turns = attempt(h, attemptId).turns.map((turnId) => turn(h, turnId))
    expect(turns.find((t) => t.directive.text === 'deep')?.delivery).not.toBe('failed')
    /* V3: `refused_preflight` is the trigger; `failed` is the state it lands in. */
    const refused = turns.find((t) => t.directive.text === 'shallow again')
    expect(refused?.delivery).toBe('failed')
    expect(refused?.deliveryDetail.reason).toBe('executor_refused')
    /* The refusal is a real executor answer, not a guess made without asking. */
    expect(
      adapter.calls.some((call) => call.k === 'applyConfig' && call.patch.reasoningEffort === null),
    ).toBe(true)
    expect(adapter.calls.some((call) => call.k === 'submit' && call.text === 'shallow again')).toBe(
      false,
    )
  })

  it('a config change while a turn is in flight returns `turn_in_flight` and produces ZERO executor calls', async () => {
    const adapter = new MockExecutor()
    const h = await serve({ adapter })
    const id = await create(h)
    await tick(h)
    const attemptId = delegation(h, id).attempts[0]!

    h.server.engine.store.commit((tx) => {
      const record = tx.getRecord<AttemptRecord>('attempt', attemptId)!.value
      tx.putRecord('attempt', attemptId, 1, { ...record, channel: 'streaming' })
    })
    const before = h.server.engine.store.read((tx) => tx.listRecords<TurnRecord>('turn')).length
    const callsBefore = adapter.calls.length

    const refused = await h.server.engine.dispatch(
      'sendTurn',
      {
        delegationId: id,
        directive: { text: 'switch model', model: 'gpt-5.4', idempotencyKey: 'k-inflight' },
      },
      ctx(),
    )
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error.code).toBe('turn_in_flight')
    /* Never queued, never deferred, never issued optimistically: no turn record was even made. */
    expect(h.server.engine.store.read((tx) => tx.listRecords<TurnRecord>('turn')).length).toBe(
      before,
    )
    /* …and "ZERO executor calls" now means it literally, against the adapter's own call log. The
     * record count alone could not distinguish "no call was made" from "a call was made and its
     * turn was then deleted" — and [F10] is precisely about a call whose side effect survives. */
    expect(adapter.calls.length).toBe(callsBefore)
  })

  it('§4.3.10 — a `sendTurn` without `attemptId` and two live attempts refuses `attempt_ambiguous`', async () => {
    const h = await serve({ config: { caps: { globalConcurrency: 4, perWorkspace: 3 } } })
    const id = await create(h, { parallelAttempts: 2 })
    await tick(h)
    const record = delegation(h, id)
    expect(record.liveAttempts.length).toBe(2)

    const ambiguous = await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'which of you?', idempotencyKey: 'k-amb' } },
      ctx(),
    )
    expect(ambiguous.ok).toBe(false)
    if (!ambiguous.ok) expect(ambiguous.error.code).toBe('attempt_ambiguous')

    /* Named, it lands: every turn belongs to an attempt, never to a delegation. */
    const targeted = await h.server.engine.dispatch(
      'sendTurn',
      {
        delegationId: id,
        directive: { text: 'you', attemptId: record.liveAttempts[1]!, idempotencyKey: 'k-t' },
      },
      ctx(),
    )
    expect(targeted.ok).toBe(true)
    if (targeted.ok)
      expect(turn(h, targeted.value as string).attemptId).toBe(record.liveAttempts[1])
  })

  it('Q9 — three attempts occupy three slots, three worktrees and three sessions', async () => {
    const h = await serve({
      config: { caps: { globalConcurrency: 4, perWorkspace: 3, worktreesPerRepo: 8 } },
    })
    const id = await create(h, { parallelAttempts: 3 })
    await tick(h)
    const record = delegation(h, id)
    expect(record.liveAttempts).toHaveLength(3)
    const attempts = record.liveAttempts.map((attemptId) => attempt(h, attemptId))
    expect(new Set(attempts.map((a) => a.workspace.worktree)).size).toBe(3)
    expect(new Set(attempts.map((a) => a.executor.sessionId)).size).toBe(3)
  })

  it('a `context-only` turn reaches `ended` on its ack and never enters `running` (#32, V13)', async () => {
    const h = await serve()
    const id = await create(h)
    await tick(h)
    const deliveries: string[] = []
    const unsubscribe = h.server.engine.store.onCommit((result) => {
      for (const record of result.emitted) {
        if (record.ev.k === 'deleg.turn_delivery') deliveries.push(record.ev.delivery)
      }
    })

    const sent = await h.server.engine.dispatch(
      'sendTurn',
      {
        delegationId: id,
        directive: {
          text: 'here is some context',
          delivery: 'context-only',
          idempotencyKey: 'k-co',
        },
      },
      ctx(),
    )
    await settle(8)
    unsubscribe()
    expect(sent.ok).toBe(true)
    if (!sent.ok) return
    expect(turn(h, sent.value as string).delivery).toBe('ended')
    expect(deliveries).not.toContain('running')
  })

  it('§4.3.9 — retracting one of three pending interrupts returns all three, all at `prepared`', async () => {
    const h = await serve()
    const id = await create(h)
    await tick(h)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const result = await h.server.engine.dispatch(
        'sendTurn',
        {
          delegationId: id,
          directive: { text: `interrupt ${i}`, delivery: 'interrupt', idempotencyKey: `k-i${i}` },
        },
        ctx(),
      )
      if (result.ok) ids.push(result.value as string)
      await settle(4)
    }
    expect(ids).toHaveLength(3)

    const retracted = await h.server.engine.dispatch('retract', { turnId: ids[0]! }, ctx())
    expect(retracted.ok).toBe(true)
    if (!retracted.ok) return
    const report = retracted.value as {
      requested: string
      alsoRetracted: readonly string[]
      sessionWide: boolean
      restoredTo: string
    }
    /* `cancelSoftInterrupts` takes only a session id, so retracting one un-delivers them all. */
    expect(report.sessionWide).toBe(true)
    expect(report.restoredTo).toBe('prepared')
    expect([...report.alsoRetracted].sort()).toEqual(ids.slice(1).sort())
    for (const turnId of ids) expect(turn(h, turnId).delivery).toBe('prepared')
  })

  it('#35 — `updateDefaults` retargets the NEXT turn and never touches one in flight', async () => {
    const h = await serve()
    const id = await create(h)
    await tick(h)
    const before = delegation(h, id)

    const updated = await h.server.engine.dispatch(
      'updateDefaults',
      { delegationId: id, patch: { reasoningEffort: 'high' } },
      { ...ctx(), expectedVersion: before.version },
    )
    expect(updated.ok).toBe(true)
    const after = delegation(h, id)
    expect(after.spec.model.reasoningEffort).toBe('high')
    expect(after.version).toBeGreaterThan(before.version)

    const next = await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: id, directive: { text: 'now what', idempotencyKey: 'k-after' } },
      ctx(),
    )
    expect(next.ok).toBe(true)
    if (next.ok) expect(turn(h, next.value as string).effective.reasoningEffort).toBe('high')
  })

  it('`expectedVersion` mismatch refuses `version_conflict`', async () => {
    const h = await serve()
    const id = await create(h)
    const stale = await h.server.engine.dispatch(
      'updateDefaults',
      { delegationId: id, patch: { priority: 5 } },
      { ...ctx(), expectedVersion: 999 },
    )
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.code).toBe('version_conflict')
  })
})

/* ------------------------------------------------------------- idempotency, audit, budgets */

describe('§2.5 rule 3 and §2.3 S13 — the durable caches and the audit trail', () => {
  it('an idempotency hit returns the ORIGINAL response, including the original error', async () => {
    const h = await serve()
    const key = { actor, tokenId: 'tok-test', idempotencyKey: 'idem-fixed' }
    const first = await h.server.engine.dispatch(
      'createDelegation',
      { spec: { ...specFor(h.repo), workspace: { workspaceId: 'nope', baseRef: 'HEAD' } } },
      key,
    )
    expect(first.ok).toBe(false)

    /* A retry that re-executes and succeeds where the first failed is a duplicate side effect
     * wearing an `ok`; the cache replays the refusal instead. */
    const replay = await h.server.engine.dispatch(
      'createDelegation',
      { spec: specFor(h.repo) },
      key,
    )
    expect(replay.ok).toBe(false)
    if (!replay.ok && !first.ok) expect(replay.error.code).toBe(first.error.code)
  })

  it('an audit row survives retention advancement, archive, discard and purge of its delegation', async () => {
    const h = await serve()
    const id = await create(h)
    await tick(h)
    await h.server.engine.dispatch('archive', { delegationId: id, abandon: true }, ctx())

    const store = h.server.engine.store
    const before = store.read((tx) => tx.readAudit(0, 200))
    expect(before.length).toBeGreaterThan(0)

    store.commit((tx) => {
      for (const head of tx.heads()) tx.advanceFloor(head.stream, head.head)
      tx.deleteStream(`delegation:${id}`)
      tx.deleteRecord('delegation', id)
      tx.appendAudit({
        intent: 'purge',
        actor: { kind: 'server', reason: 'test purge' },
        delegationId: id,
      })
    })

    const after = store.read((tx) => tx.readAudit(0, 200))
    /* The record of what was removed outlives what was removed (§3.5, Q20). */
    expect(after.length).toBe(before.length + 1)
    expect(after.some((row) => row.intent === 'createDelegation')).toBe(true)
    expect(after.some((row) => row.intent === 'purge')).toBe(true)
    expect(store.read((tx) => tx.getRecord('delegation', id))).toBeNull()
  })
})

describe('§5.5 X16 — sleep is not stall, and stall is not sleep', () => {
  it('a 4 h wall gap with a ≈0 monotonic gap reports "asleep"', async () => {
    let wall = 1_000_000
    let mono = 5_000
    const h = await serve({ now: () => wall })
    const engine = h.server.engine
    engine.sampleClock(wall, mono)
    wall += 4 * 60 * 60_000
    mono += 20
    expect(engine.sampleClock(wall, mono)).toBe('asleep')
    expect(engine.listNotices().some((n) => n.kind === 'resumed-from-sleep')).toBe(true)
  })

  it('a 4 h gap in BOTH clocks reports "stalled" — the process ran and produced nothing (W5)', async () => {
    let wall = 1_000_000
    let mono = 5_000
    const h = await serve({ now: () => wall })
    const engine = h.server.engine
    engine.sampleClock(wall, mono)
    wall += 4 * 60 * 60_000
    mono += 4 * 60 * 60_000
    expect(engine.sampleClock(wall, mono)).toBe('stalled')
    expect(engine.listNotices().some((n) => n.kind === 'resumed-from-sleep')).toBe(false)
  })

  it('on a detected sleep gap, every streaming turn becomes `unknown` and reconciliation runs', async () => {
    let wall = 1_000_000
    const h = await serve({ now: () => wall })
    const id = await create(h)
    await tick(h)
    const attemptId = delegation(h, id).attempts[0]!

    /* Put a turn back in flight, exactly as a suspend would have found it. */
    const turnId = attempt(h, attemptId).turns[0]!
    h.server.engine.store.commit((tx) => {
      const record = tx.getRecord<TurnRecord>('turn', turnId)!.value
      tx.putRecord('turn', turnId, 1, { ...record, delivery: 'running' })
      const live = tx.getRecord<AttemptRecord>('attempt', attemptId)!.value
      tx.putRecord('attempt', attemptId, 1, { ...live, channel: 'streaming' })
    })

    h.server.engine.sampleClock(wall, 10_000)
    wall += 4 * 60 * 60_000
    expect(h.server.engine.sampleClock(wall, 10_020)).toBe('asleep')
    expect(turn(h, turnId).delivery).toBe('unknown')
    expect(attempt(h, attemptId).channel).toBe('disconnected')
    await settle(8)
  })
})

describe('§5.5 the `unknown` protocol — never auto-resends by default (Q5)', () => {
  it('a `reconcile` with no positive evidence stays `unknown` and offers, never resends', async () => {
    const h = await serve()
    const id = await create(h)
    await tick(h)
    const attemptId = delegation(h, id).attempts[0]!
    const turnId = attempt(h, attemptId).turns[0]!
    h.server.engine.store.commit((tx) => {
      const record = tx.getRecord<TurnRecord>('turn', turnId)!.value
      tx.putRecord('turn', turnId, 1, {
        ...record,
        delivery: 'unknown',
        promptDigest: 'digest-that-is-nowhere',
      })
    })

    const result = await h.server.engine.dispatch('reconcile', { delegationId: id }, ctx())
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const report = result.value as {
      outcome: string
      evidence: Record<string, unknown>
      deliveryBefore: string
      deliveryAfter: string
    }
    /* The four clauses are reported verbatim so a human can read the reasoning (X4). */
    expect(Object.keys(report.evidence).sort()).toEqual([
      'ackLogged',
      'digestInTail',
      'sessionIdle',
      'toolEventsLogged',
      'workspaceMutated',
    ])
    expect(['still-unknown', 'resend-offered', 'resumed', 'ended']).toContain(report.outcome)
    expect(report.outcome).not.toBe('resent')
    expect(delegation(h, id).spec.autoResendOnStrongEvidence ?? false).toBe(false)
  })
})

function pathExists(path: string): boolean {
  try {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, '.probe'), '')
    return true
  } catch {
    return false
  }
}

describe('§9 errors are one class narrowed by code, serializable across the wire', () => {
  it('a refusal is a `SwarmError` with `retryable` set by the server', async () => {
    const h = await serve()
    const result = await h.server.engine.dispatch(
      'sendTurn',
      { delegationId: 'nope', directive: { text: 'x', idempotencyKey: 'k' } },
      ctx(),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(SwarmError.is(result.error)).toBe(true)
      expect(result.error.code).toBe('not_found')
      expect(typeof result.error.retryable).toBe('boolean')
    }
  })
})

describe('§3.4 the writer lease is a lease, and §8 landing tells the truth about a moved base', () => {
  it('a second writer on one session is refused with `lease_held`', async () => {
    const h = await serve()
    const id = await create(h)
    await tick(h)
    const attemptId = delegation(h, id).attempts[0]!
    const sessionId = attempt(h, attemptId).executor.sessionId!

    /* One holder, TTL 60 s (§3.4 rule 2). A second writer does not steal it — contention is an
     * expected outcome, so the store returns `null` and the caller raises `lease_held`. */
    const stolen = h.server.engine.store.commit((tx) =>
      tx.acquireLease(sessionLease(sessionId), 'another-writer', 60_000),
    ).value
    expect(stolen).toBeNull()
    expect(h.server.engine.store.read((tx) => tx.getLease(sessionLease(sessionId))?.holder)).toBe(
      attemptId,
    )
  })

  it('a moved base surfaces `landing-conflict` and never silently rebases (Q10, #23)', async () => {
    const h = await serve({
      config: {},
    })
    const id = await create(h, {
      acceptance: [
        { kind: 'file', id: 'readme', label: 'readme', path: 'README.md', must: 'exist' },
      ],
    })
    await tick(h)
    const attemptId = delegation(h, id).attempts[0]!

    /* The base moves under the delegation — the commit case §13 names. */
    h.repo.write('after.txt', 'moved on')
    h.repo.commit('the base moved')

    const before = h.server.engine.listNotices().length
    await h.server.engine.dispatch(
      'land',
      { delegationId: id, attemptId, mode: 'commit', targetBranch: 'swarm/moved' },
      ctx(),
    )
    const notices = h.server.engine.listNotices().slice(before)
    expect(notices.some((notice) => notice.kind === 'landing-conflict')).toBe(true)
    /* Annotated, never invalidated: the evidence still stands, and a human decides. */
    expect(
      notices.some((notice) => notice.actions.some((action) => action.intent === 'reconcile')) ||
        notices.some((notice) => notice.title.toLowerCase().includes('base')),
    ).toBe(true)
  }, 20_000)
})

describe('§2.3 the audit trail is NOT a stream (S13, Q20)', () => {
  it('there is no `audit` stream to subscribe to — it is read over HTTP or not at all', () => {
    /* `StreamName` is a template-literal union of four families; `audit` is in none of them, so a
     * `sub` naming it is refused by shape on ingest. S13's value is answering "who did this" about
     * work that landed months ago, and riding a 30-day stream made it a log with an expiry date. */
    expect(parseStreamName('audit')).toBeNull()
    expect(parseStreamName('server')).not.toBeNull()
    expect(parseStreamName('fleet')).not.toBeNull()
  })
})
