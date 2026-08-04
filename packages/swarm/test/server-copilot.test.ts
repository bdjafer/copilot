/**
 * SPEC-swarm §6.7 (Q8, #39) — the copilot tool surface and the confirmation seam, and §13's row:
 * *"A copilot write tool without a `confirm` never executes, expires after `confirmationTtlMs`,
 * and a copilot `cancel` of a user-created delegation is refused outright."*
 *
 * The property every case here defends is the one the ruling exists for: **no head connected ⇒ no
 * confirmation ⇒ no write.** A pending confirmation is a request that has not happened yet.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { CopilotTools } from '../src/server/copilot.ts'
import type { ServerHarness } from './support/server-harness.ts'

import { DEFAULT_TIMEOUTS } from '../src/domain/constants.ts'
import { ConfirmationRegistry, COPILOT_WRITE_TOOLS } from '../src/server/confirm.ts'
import { createCopilotSurface } from '../src/server/copilot.ts'
import { createServerHarness, drain, settle, specFor } from './support/server-harness.ts'

let harness: ServerHarness | null = null

afterEach(async () => {
  await harness?.dispose()
  harness = null
})

async function serve(): Promise<{ h: ServerHarness; copilot: CopilotTools }> {
  harness = await createServerHarness({ listen: false })
  return {
    h: harness,
    copilot: createCopilotSurface({
      engine: harness.server.engine,
      conversationId: 'conv-1',
      pageUrl: 'https://example.test/thread/1',
    }),
  }
}

const userCtx = (key: string) => ({
  actor: { kind: 'user', head: 'test', tokenId: 'tok-user' } as const,
  tokenId: 'tok-user',
  idempotencyKey: key,
})

describe('§6.7 the three write tools are gated on a human', () => {
  it('`swarm.start` emits `server.confirmation`, executes nothing, and waits', async () => {
    const { h, copilot } = await serve()
    const emitted: string[] = []
    const unsubscribe = h.server.engine.store.onCommit((result) => {
      for (const record of result.emitted) emitted.push(record.ev.k)
    })

    const pending = copilot.start({
      idempotencyKey: 'copilot-start-1',
      spec: specFor(h.repo),
    })
    await settle(3)
    unsubscribe()

    expect(emitted).toContain('server.confirmation')
    /* Nothing was created: the tool is *asking*, and asking is not doing. */
    expect(h.server.engine.store.read((tx) => tx.listRecords('delegation'))).toHaveLength(0)

    const request = h.server.engine.confirmations.list()[0]!
    expect(request.tool).toBe('swarm.start')
    expect(request.requestedBy).toMatchObject({ kind: 'copilot', conversationId: 'conv-1' })
    expect(request.summary).toContain(specFor(h.repo).objective.slice(0, 20))
    /* The head renders `effective` verbatim, so the human sees what they are agreeing to. */
    expect(request.effective).toMatchObject({ workspace: 'scratch', writeMode: 'worktree' })
    expect(request.expiresAt - request.at).toBe(DEFAULT_TIMEOUTS.confirmationTtlMs)

    await h.server.engine.dispatch(
      'confirm',
      { requestId: request.requestId },
      userCtx('confirm-1'),
    )
    const result = await pending
    expect(result.ok).toBe(true)
    if (!result.ok) return
    /* The audit names both: the conversation that asked and the token that agreed. */
    const record = h.server.engine.store.read(
      (tx) =>
        tx.getRecord<{ createdBy: { kind: string; confirmedBy: string } }>(
          'delegation',
          result.value,
        )!.value,
    )
    expect(record.createdBy).toEqual({ kind: 'copilot', confirmedBy: 'tok-user' })
  })

  it('`deny` refuses the tool call and leaves the fleet untouched', async () => {
    const { h, copilot } = await serve()
    const pending = copilot.start({ idempotencyKey: 'copilot-start-2', spec: specFor(h.repo) })
    await settle(3)
    const request = h.server.engine.confirmations.list()[0]!
    await h.server.engine.dispatch(
      'deny',
      { requestId: request.requestId, reason: 'not now' },
      userCtx('deny-1'),
    )
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('confirmation_required')
      expect(result.error.message).toContain('not now')
    }
    expect(h.server.engine.store.read((tx) => tx.listRecords('delegation'))).toHaveLength(0)
  })

  it('an unanswered request expires after `confirmationTtlMs` and is denied automatically', async () => {
    let clock = 1_000
    const registry = new ConfirmationRegistry({ now: () => clock, ttlMs: 500 })
    const { decided } = registry.request({
      requestId: 'cnf-1',
      tool: 'swarm.start',
      requestedBy: { kind: 'copilot', conversationId: 'c' },
      summary: 'do a thing',
      payload: { delegationId: 'd', scope: 'turn' },
      effective: {
        provider: 'anthropic',
        model: 'claude-opus-5',
        reasoningEffort: null,
        workspace: 'w',
        writeMode: 'worktree',
      },
    })
    expect(registry.list()).toHaveLength(1)
    clock += 501
    registry.expire()
    expect(await decided).toEqual({ decision: 'deny', reason: 'expired' })
    /* No head connected ⇒ no confirmation ⇒ no write, and the wait is bounded rather than eternal. */
    expect(registry.list()).toHaveLength(0)
  })

  it('confirming an unknown or already-resolved request is `confirmation_expired`', async () => {
    const { h } = await serve()
    const result = await h.server.engine.dispatch(
      'confirm',
      { requestId: 'cnf-nope' },
      userCtx('confirm-nope'),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('confirmation_expired')
  })

  it('`swarm.followUp` is gated the same way and reaches the same intent', async () => {
    const { h, copilot } = await serve()
    const created = await h.server.engine.dispatch(
      'createDelegation',
      { spec: specFor(h.repo) },
      userCtx('user-create'),
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await drain(h)

    const pending = copilot.followUp(created.value as string, {
      text: 'try the other approach',
      idempotencyKey: 'copilot-turn-1',
    })
    await settle(3)
    const request = h.server.engine.confirmations.list()[0]!
    expect(request.tool).toBe('swarm.followUp')
    await h.server.engine.dispatch('confirm', { requestId: request.requestId }, userCtx('c2'))
    const result = await pending
    expect(result.ok).toBe(true)
  })
})

describe('§6.7 `swarm.cancel` is refused outright for work a copilot did not create', () => {
  it('refuses without even offering a confirmation', async () => {
    const { h, copilot } = await serve()
    const created = await h.server.engine.dispatch(
      'createDelegation',
      { spec: specFor(h.repo) },
      userCtx('user-create-2'),
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const result = await copilot.cancel(created.value as string, 'delegation')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('forbidden')
    /* Not "denied by a human" — never asked. A dialog asking a user to approve a copilot
     * cancelling their own work is a dialog approved by reflex. */
    expect(h.server.engine.confirmations.list()).toHaveLength(0)
  })

  it('allows it, with a confirmation, for a delegation the copilot created', async () => {
    const { h, copilot } = await serve()
    const start = copilot.start({ idempotencyKey: 'copilot-start-3', spec: specFor(h.repo) })
    await settle(3)
    await h.server.engine.dispatch(
      'confirm',
      { requestId: h.server.engine.confirmations.list()[0]!.requestId },
      userCtx('c3'),
    )
    const created = await start
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const pending = copilot.cancel(created.value, 'delegation')
    await settle(3)
    const request = h.server.engine.confirmations.list()[0]!
    expect(request.tool).toBe('swarm.cancel')
    await h.server.engine.dispatch('confirm', { requestId: request.requestId }, userCtx('c4'))
    expect((await pending).ok).toBe(true)
    expect(
      h.server.engine.store.read(
        (tx) => tx.getRecord<{ state: string }>('delegation', created.value)!.value.state,
      ),
    ).toBe('cancelled')
  })
})

describe('§6.7 the three read tools carry no authority', () => {
  it('`list` and `inspect` answer without a confirmation and without transcript text', async () => {
    const { h, copilot } = await serve()
    const created = await h.server.engine.dispatch(
      'createDelegation',
      { spec: specFor(h.repo), title: 'readable' },
      userCtx('user-create-3'),
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await drain(h)

    const fleet = copilot.list()
    expect(Object.values(fleet.counts).reduce((a, b) => a + b, 0)).toBe(1)
    const vm = copilot.inspect(created.value as string)!
    expect(vm.title).toBe('readable')
    /* The transcript lives on `attempt:*` and is not part of a `DelegationVM` (§6.2). */
    expect(JSON.stringify(vm)).not.toContain('att.text')
    expect(h.server.engine.confirmations.list()).toHaveLength(0)
  })

  it('`wait` is event-driven and bounded, and reports what it saw when it times out', async () => {
    const { h, copilot } = await serve()
    const created = await h.server.engine.dispatch(
      'createDelegation',
      { spec: specFor(h.repo) },
      userCtx('user-create-4'),
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.value as string

    const waiting = copilot.wait({ delegationId: id, until: 'terminal', timeoutMs: 200 })
    await drain(h)
    await h.server.engine.dispatch(
      'cancel',
      { delegationId: id, scope: 'delegation' },
      userCtx('c5'),
    )
    const reached = await waiting
    expect(reached).toEqual({ reached: true, state: 'cancelled' })

    const missed = await copilot.wait({
      delegationId: id,
      until: 'event',
      timeoutMs: 20,
    })
    expect(missed.reached).toBe(false)
    expect(missed.state).toBe('cancelled')
  })
})

describe('§6.7 the tool table is closed', () => {
  it('names exactly three write tools, and none of the four that must not exist', () => {
    expect([...COPILOT_WRITE_TOOLS]).toEqual(['swarm.start', 'swarm.followUp', 'swarm.cancel'])
    /* A verdict a conversation can write is not a verdict (§6.7). */
    for (const forbidden of ['swarm.complete', 'swarm.verify', 'swarm.land', 'swarm.retry']) {
      expect([...COPILOT_WRITE_TOOLS]).not.toContain(forbidden)
    }
  })
})
