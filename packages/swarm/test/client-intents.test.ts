/**
 * SPEC-swarm §6.3 and `src/protocol/intents.ts` — one assertion per intent's frame shape, plus
 * the refusals the client core owns.
 *
 * §2.2 types `req.args` as `unknown`, so the mapping from a method call to a frame is a contract
 * the client and the server stage must share; these tests are that contract's other half. A
 * change to `IntentArgs` that the client does not follow fails here rather than at the server
 * boundary, where it would look like a malformed intent from a head.
 */

import { describe, expect, it } from 'vitest'

import type { ReqFrame } from '../src/protocol/frames.ts'

import { INTENT_NAMES } from '../src/protocol/frames.ts'
import { decodeIntentResponse } from '../src/protocol/intents.ts'
import { createTestClient } from '../src/testing/client-harness.ts'
import { makeDelegationVM, makeTurnDirective } from '../src/testing/fixtures.ts'

function withDelegation(): ReturnType<typeof createTestClient> {
  const harness = createTestClient()
  harness.start()
  harness.transport.evt('fleet', 1, {
    k: 'fleet.delegation_created',
    delegation: makeDelegationVM(),
  })
  harness.transport.clearSent()
  return harness
}

describe('§6.3 every intent writes the frame `IntentArgs` declares', () => {
  it('createDelegation — the client always fills `delegationId` (C11)', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.clearSent()
    void harness.client.createDelegation({
      idempotencyKey: 'idem-create',
      title: 'Fix flaky auth test',
      priority: 3,
      spec: { ...makeDelegationVM().spec, workspace: { workspaceId: 'exp-spec', baseRef: 'HEAD' } },
    })
    const req = harness.transport.lastReq('createDelegation')!
    expect(req.idempotencyKey).toBe('idem-create')
    expect(req.args).toMatchObject({ title: 'Fix flaky auth test', priority: 3 })
    expect(typeof (req.args as { delegationId: string }).delegationId).toBe('string')
    /* `baseRef` is an EXPRESSION on the wire; the server resolves it to a 40-char sha (C4b). */
    expect(req.args).toMatchObject({ spec: { workspace: { baseRef: 'HEAD' } } })
    harness.destroy()
  })

  it('sendTurn — the directive travels whole and its key rides on the envelope', () => {
    const harness = withDelegation()
    void harness.client.sendTurn('delegation-1', makeTurnDirective({ idempotencyKey: 'idem-t1' }))
    const req = harness.transport.lastReq('sendTurn')!
    expect(req.idempotencyKey).toBe('idem-t1')
    expect(req.args).toMatchObject({
      delegationId: 'delegation-1',
      directive: { text: 'Plan the fix first.' },
    })
    harness.destroy()
  })

  it('sendTurn — `expectedVersion` rides on the envelope, not in args (§2.2)', () => {
    const harness = withDelegation()
    void harness.client.sendTurn(
      'delegation-1',
      makeTurnDirective({ idempotencyKey: 'idem-t2', expectedVersion: 7 }),
    )
    expect(harness.transport.lastReq('sendTurn')!.expectedVersion).toBe(7)
    harness.destroy()
  })

  it('retract, discard, branch — single-id intents', () => {
    const harness = withDelegation()
    void harness.client.retract('turn-3')
    void harness.client.discard('attempt-4')
    void harness.client.branch('attempt-5', { title: 'Another angle' })
    expect(harness.transport.lastReq('retract')!.args).toEqual({ turnId: 'turn-3' })
    expect(harness.transport.lastReq('discard')!.args).toEqual({ attemptId: 'attempt-4' })
    expect(harness.transport.lastReq('branch')!.args).toEqual({
      attemptId: 'attempt-5',
      title: 'Another angle',
    })
    harness.destroy()
  })

  it('cancel — the three distinctly-named scopes of §4.3.7', () => {
    const harness = withDelegation()
    for (const scope of ['turn', 'delegation', 'hard'] as const) {
      void harness.client.cancel('delegation-1', { scope, attemptId: 'attempt-1' })
      expect(harness.transport.lastReq('cancel')!.args).toEqual({
        delegationId: 'delegation-1',
        scope,
        attemptId: 'attempt-1',
      })
    }
    harness.destroy()
  })

  it('retry — carries the parallel fan-out Q9 makes structural', () => {
    const harness = withDelegation()
    void harness.client.retry('delegation-1', { parallel: 3, injectPriorFailure: true })
    expect(harness.transport.lastReq('retry')!.args).toEqual({
      delegationId: 'delegation-1',
      parallel: 3,
      injectPriorFailure: true,
    })
    harness.destroy()
  })

  it('verify and accept — accept carries the note D14 requires', () => {
    const harness = withDelegation()
    void harness.client.verify('delegation-1', { attemptId: 'a1', criteria: ['unit'] })
    void harness.client.accept('delegation-1', { note: 'looks right', attemptId: 'a1' })
    expect(harness.transport.lastReq('verify')!.args).toEqual({
      delegationId: 'delegation-1',
      attemptId: 'a1',
      criteria: ['unit'],
    })
    expect(harness.transport.lastReq('accept')!.args).toEqual({
      delegationId: 'delegation-1',
      note: 'looks right',
      attemptId: 'a1',
    })
    harness.destroy()
  })

  it('land — names an attempt explicitly; there is no "current attempt" to guess at', () => {
    const harness = withDelegation()
    void harness.client.land('delegation-1', {
      attemptId: 'a2',
      mode: 'commit',
      targetBranch: 'fix/flaky-auth',
    })
    expect(harness.transport.lastReq('land')!.args).toEqual({
      delegationId: 'delegation-1',
      attemptId: 'a2',
      mode: 'commit',
      targetBranch: 'fix/flaky-auth',
    })
    harness.destroy()
  })

  it('archive, reconcile — the abandon flag is D15, not a second intent', () => {
    const harness = withDelegation()
    void harness.client.archive('delegation-1', { abandon: true })
    void harness.client.reconcile('delegation-1')
    expect(harness.transport.lastReq('archive')!.args).toEqual({
      delegationId: 'delegation-1',
      abandon: true,
    })
    expect(harness.transport.lastReq('reconcile')!.args).toEqual({ delegationId: 'delegation-1' })
    harness.destroy()
  })

  it('pauseDispatch — both scopes of §6.3', () => {
    const harness = withDelegation()
    void harness.client.pauseDispatch({ fleet: true }, true)
    expect(harness.transport.lastReq('pauseDispatch')!.args).toEqual({
      scope: { fleet: true },
      paused: true,
    })
    void harness.client.pauseDispatch({ delegationId: 'delegation-1' }, false)
    expect(harness.transport.lastReq('pauseDispatch')!.args).toEqual({
      scope: { delegationId: 'delegation-1' },
      paused: false,
    })
    harness.destroy()
  })

  it('killSwitch — carries only the instance flag; it is a brake, not a delete (Q16)', () => {
    const harness = withDelegation()
    void harness.client.killSwitch({ killInstances: true })
    expect(harness.transport.lastReq('killSwitch')!.args).toEqual({ killInstances: true })
    harness.destroy()
  })

  it('updateDefaults — patch in args, expectedVersion on the envelope (#35)', () => {
    const harness = withDelegation()
    void harness.client.updateDefaults('delegation-1', { reasoningEffort: 'high' }, 4)
    const req = harness.transport.lastReq('updateDefaults')!
    expect(req.args).toEqual({
      delegationId: 'delegation-1',
      patch: { reasoningEffort: 'high' },
    })
    expect(req.expectedVersion).toBe(4)
    harness.destroy()
  })

  it('confirm and deny — the copilot write gate of §6.7', () => {
    const harness = withDelegation()
    void harness.client.confirm('confirm-1')
    void harness.client.deny('confirm-2', 'not now')
    expect(harness.transport.lastReq('confirm')!.args).toEqual({ requestId: 'confirm-1' })
    expect(harness.transport.lastReq('deny')!.args).toEqual({
      requestId: 'confirm-2',
      reason: 'not now',
    })
    harness.destroy()
  })

  it('setFilter and focus never reach the wire (§2.2, §6.3)', () => {
    const harness = withDelegation()
    harness.client.setFilter({ buckets: ['needs-you'], sort: 'updated' })
    harness.client.focus('delegation-1', 'attempt-1')
    const intents = harness.transport.of('req').map((req) => req.intent)
    expect(intents).not.toContain('setFilter')
    expect(intents).not.toContain('focus')
    expect(INTENT_NAMES as readonly string[]).not.toContain('setFilter')
    harness.destroy()
  })

  it('covers all seventeen wire intents between them', () => {
    const harness = withDelegation()
    void harness.client.createDelegation({
      idempotencyKey: 'k',
      spec: { ...makeDelegationVM().spec, workspace: { workspaceId: 'exp-spec' } },
    })
    void harness.client.sendTurn('delegation-1', makeTurnDirective())
    void harness.client.retract('t')
    void harness.client.cancel('delegation-1', { scope: 'turn' })
    void harness.client.retry('delegation-1')
    void harness.client.branch('a')
    void harness.client.verify('delegation-1')
    void harness.client.accept('delegation-1', { note: 'n' })
    void harness.client.land('delegation-1', { attemptId: 'a', mode: 'patch' })
    void harness.client.discard('a')
    void harness.client.archive('delegation-1')
    void harness.client.reconcile('delegation-1')
    void harness.client.pauseDispatch({ fleet: true }, true)
    void harness.client.killSwitch({ killInstances: false })
    void harness.client.updateDefaults('delegation-1', {})
    void harness.client.confirm('c')
    void harness.client.deny('c')
    const seen = new Set(harness.transport.of('req').map((req) => req.intent))
    expect([...seen].sort()).toEqual([...INTENT_NAMES].sort())
    harness.destroy()
  })
})

describe('§6.3 results and idempotency', () => {
  it('resolves `{ok:true, value, version}` from `res.data`', async () => {
    const harness = withDelegation()
    const pending = harness.client.land('delegation-1', { attemptId: 'a1', mode: 'commit' })
    const req = harness.transport.lastReq('land')!
    harness.transport.respond(req.id, { mode: 'commit', attemptId: 'a1', ref: 'main', at: 9 }, 6)
    const result = await pending
    expect(result).toEqual({
      ok: true,
      value: { mode: 'commit', attemptId: 'a1', ref: 'main', at: 9 },
      version: 6,
    })
    harness.destroy()
  })

  it('resolves `{ok:false, error}` for a domain refusal and never throws (#24)', async () => {
    const harness = withDelegation()
    const pending = harness.client.sendTurn('delegation-1', makeTurnDirective())
    const req = harness.transport.lastReq('sendTurn')!
    harness.transport.fail(req.id, 'turn_in_flight', 'a turn is in flight', true)
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe('turn_in_flight')
      /* §9: `retryable` is the server's ruling and is authoritative. */
      expect(result.error.retryable).toBe(true)
    }
    harness.destroy()
  })

  it('refuses a malformed `res.data` rather than reporting version 0 for a real record', async () => {
    const harness = withDelegation()
    const pending = harness.client.reconcile('delegation-1')
    const req = harness.transport.lastReq('reconcile')!
    harness.transport.deliver({ p: 'swarm', v: 1, k: 'res', id: req.id, data: { oops: true } })
    const result = await pending
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('internal')
    expect(decodeIntentResponse({ oops: true })).toBeNull()
    expect(decodeIntentResponse({ value: 1, version: 2 })).toEqual({ value: 1, version: 2 })
    harness.destroy()
  })

  it('generates one idempotency key per call and reuses it on the re-send (§2.5 rule 3)', () => {
    const harness = withDelegation()
    void harness.client.cancel('delegation-1', { scope: 'delegation' })
    void harness.client.cancel('delegation-1', { scope: 'delegation' })
    const first = harness.transport.of('req') as readonly ReqFrame[]
    expect(first).toHaveLength(2)
    expect(first[0]!.idempotencyKey).not.toBe(first[1]!.idempotencyKey)

    harness.transport.serverClose(1006)
    harness.transport.clearSent()
    harness.transport.handshake()
    const resent = (harness.transport.of('req') as readonly ReqFrame[]).map(
      (req) => req.idempotencyKey,
    )
    expect(resent.sort()).toEqual([first[0]!.idempotencyKey, first[1]!.idempotencyKey].sort())
    harness.destroy()
  })

  it('does not re-send a request the server already answered', () => {
    const harness = withDelegation()
    void harness.client.killSwitch({ killInstances: false })
    const req = harness.transport.lastReq('killSwitch')!
    harness.transport.respond(req.id, null, 1)
    harness.transport.serverClose(1006)
    harness.transport.clearSent()
    harness.transport.handshake()
    expect(harness.transport.of('req')).toHaveLength(0)
    harness.destroy()
  })

  it('reports `pendingIntents` on the ConnectionVM while a request is outstanding', () => {
    const harness = withDelegation()
    void harness.client.killSwitch({ killInstances: false })
    expect(harness.client.connection.get().pendingIntents).toBe(1)
    const req = harness.transport.lastReq('killSwitch')!
    harness.transport.respond(req.id, null, 1)
    expect(harness.client.connection.get().pendingIntents).toBe(0)
    harness.destroy()
  })

  it('surfaces `err{id:null}` as a client error, attributed to no request', () => {
    const harness = withDelegation()
    harness.transport.fail(null, 'rate_limited', 'slow down', true)
    expect(harness.errors.some((error) => error.code === 'rate_limited')).toBe(true)
    harness.destroy()
  })
})

describe('§4.3 the client core refuses before the wire', () => {
  it('sendTurn to an unknown delegation is `not_found` with zero frames', async () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.clearSent()
    const result = await harness.client.sendTurn('nope', makeTurnDirective())
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('not_found')
    expect(harness.transport.of('req')).toHaveLength(0)
    harness.destroy()
  })

  it('an off-ladder effort is refused `unknown_effort` (§4.1)', async () => {
    const harness = withDelegation()
    /* The fixture delegation is Anthropic, whose ladder has no `minimal` (§4.1). */
    const result = await harness.client.sendTurn(
      'delegation-1',
      makeTurnDirective({ reasoningEffort: 'minimal' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('unknown_effort')
    expect(harness.transport.of('req')).toHaveLength(0)
    harness.destroy()
  })

  it('the mode gate runs BEFORE the ladder, so steering reports the right refusal', async () => {
    const harness = withDelegation()
    const result = await harness.client.sendTurn(
      'delegation-1',
      makeTurnDirective({ delivery: 'next-safe-point', reasoningEffort: 'minimal' }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('config_not_available_in_mode')
    harness.destroy()
  })
})
