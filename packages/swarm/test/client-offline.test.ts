/**
 * SPEC-swarm §6.6 (H9, X12) — the offline queue, the two optimistic records, and X11's rule that
 * the server always wins.
 *
 * The queue is the difference between "the extension was asleep" and "the instruction was lost".
 * Everything asserted here is about ordering, identity and who resolves a conflict.
 */

import { describe, expect, it } from 'vitest'

import { SERVER_POLICY } from '../src/domain/constants.ts'
import { createTestClient } from '../src/testing/client-harness.ts'
import { makeDelegationVM, makeTurnDirective } from '../src/testing/fixtures.ts'

function offlineClient(): ReturnType<typeof createTestClient> {
  const harness = createTestClient({ autoAccept: false })
  return harness
}

describe('§6.6 queue and drain', () => {
  it('writes nothing while disconnected and counts what is waiting', () => {
    const harness = offlineClient()
    void harness.client.killSwitch({ killInstances: false })
    void harness.client.reconcile('delegation-1')
    void harness.client.discard('attempt-1')
    expect(harness.transport.of('req')).toHaveLength(0)
    expect(harness.client.connection.get().queuedOffline).toBe(3)
    expect(harness.client.inspect().offlineQueue.map((entry) => entry.intent)).toEqual([
      'killSwitch',
      'reconcile',
      'discard',
    ])
    harness.destroy()
  })

  it('drains in issue order with the keys minted when the intent was called', () => {
    const harness = offlineClient()
    void harness.client.killSwitch({ killInstances: false })
    void harness.client.reconcile('delegation-1')
    const keysBefore = harness.client.inspect().offlineQueue.map((entry) => entry.idempotencyKey)

    harness.transport.handshake()
    const reqs = harness.transport.of('req')
    expect(reqs.map((req) => req.intent)).toEqual(['killSwitch', 'reconcile'])
    expect(reqs.map((req) => req.idempotencyKey)).toEqual(keysBefore)
    expect(harness.client.connection.get().queuedOffline).toBe(0)
    harness.destroy()
  })

  it('the drained request becomes a normal in-flight request', async () => {
    const harness = offlineClient()
    const pending = harness.client.killSwitch({ killInstances: false })
    harness.transport.handshake()
    const req = harness.transport.lastReq('killSwitch')!
    harness.transport.respond(req.id, { at: 1, turnsCancelled: [] }, 3)
    const result = await pending
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.version).toBe(3)
    harness.destroy()
  })

  it('an intent issued while blocked is refused rather than queued forever', async () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.serverClose(4001)
    const result = await harness.client.reconcile('delegation-1')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.retryable).toBe(false)
    harness.destroy()
  })
})

describe('§6.6 optimistic records — exactly two, both `version: -1`', () => {
  it('createDelegation shows the delegation in the fleet immediately', () => {
    const harness = offlineClient()
    void harness.client.createDelegation({
      idempotencyKey: 'idem-1',
      delegationId: 'd-offline',
      title: 'Offline objective',
      spec: { ...makeDelegationVM().spec, workspace: { workspaceId: 'exp-spec', baseRef: 'main' } },
    })
    const vm = harness.client.delegations.get().get('d-offline')!
    expect(vm.version).toBe(-1)
    expect(vm.state).toBe('queued')
    expect(vm.bucket).toBe('queued')
    expect(vm.title).toBe('Offline objective')
    expect(vm.baseRef).toBe('main')
    expect(vm.baseRevision).toBe('')
    expect(harness.client.fleet.get().buckets.queued).toEqual(['d-offline'])
    harness.destroy()
  })

  it('sendTurn attaches an optimistic `prepared` turn to the targeted attempt', () => {
    const harness = createTestClient({ autoAccept: false })
    harness.transport.handshake()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM(),
    })
    harness.transport.serverClose(1006)

    void harness.client.sendTurn('delegation-1', makeTurnDirective({ text: 'do the thing' }))
    const turn = harness.client.delegations.get().get('delegation-1')!.attempts[0]!.currentTurn!
    expect(turn.delivery).toBe('prepared')
    expect(turn.effortConfirmed).toBe(false)
    expect(turn.effective.model).toBe('claude-opus-5')
    harness.destroy()
  })

  it('nothing else is optimistic: cancel changes no view model', () => {
    const harness = createTestClient({ autoAccept: false })
    harness.transport.handshake()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM(),
    })
    harness.transport.serverClose(1006)
    const before = harness.client.delegations.get().get('delegation-1')
    void harness.client.cancel('delegation-1', { scope: 'delegation' })
    expect(harness.client.delegations.get().get('delegation-1')).toBe(before)
    harness.destroy()
  })

  it('the server record replaces the optimistic one wholesale (X11)', () => {
    const harness = offlineClient()
    void harness.client.createDelegation({
      idempotencyKey: 'idem-1',
      delegationId: 'd-offline',
      title: 'Offline objective',
      spec: { ...makeDelegationVM().spec, workspace: { workspaceId: 'exp-spec', baseRef: 'HEAD' } },
    })
    harness.transport.handshake()
    harness.transport.snap('server', 0, {
      health: harness.client.health.get(),
      notices: [],
      confirmations: [],
    })
    harness.transport.snap('fleet', 0, {
      delegations: [],
      concurrency: { runningAttempts: 0, cap: 4, queued: 0 },
      dispatchPaused: false,
      spend: harness.client.fleet.get().spend,
    })
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM({
        id: 'd-offline',
        version: 1,
        title: 'Server title',
        state: 'provisioning',
      }),
    })
    const vm = harness.client.delegations.get().get('d-offline')!
    expect(vm.version).toBe(1)
    expect(vm.title).toBe('Server title')
    expect(vm.state).toBe('provisioning')
    harness.destroy()
  })
})

describe('§6.6 the ten-minute hold', () => {
  it('holds a stale turn, raises the notice, and lets everything else through', async () => {
    const harness = createTestClient({ autoAccept: false })
    harness.transport.handshake()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM(),
    })
    harness.transport.serverClose(1006)

    const stale = harness.client.sendTurn('delegation-1', makeTurnDirective())
    harness.clock.advance(SERVER_POLICY.staleQueuedTurnMs + 1)
    const fresh = harness.client.cancel('delegation-1', { scope: 'turn' })

    harness.transport.clearSent()
    harness.transport.handshake()

    const staleResult = await stale
    expect(staleResult.ok).toBe(false)
    if (!staleResult.ok) {
      expect(staleResult.error.code).toBe('invalid_spec')
      expect(staleResult.error.details).toMatchObject({ reason: 'stale-queued-turn' })
    }
    expect(harness.transport.of('req').map((req) => req.intent)).toEqual(['cancel'])
    const notice = harness.client.notices.get().find((n) => n.kind === 'stale-queued-turn')!
    expect(notice.dismissible).toBe(true)
    expect(notice.actions.map((action) => action.intent)).toEqual(['sendTurn', 'dismiss'])
    void fresh
    harness.destroy()
  })

  it('does not hold a turn that waited less than ten minutes', () => {
    const harness = createTestClient({ autoAccept: false })
    harness.transport.handshake()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM(),
    })
    harness.transport.serverClose(1006)
    void harness.client.sendTurn('delegation-1', makeTurnDirective())
    harness.clock.advance(SERVER_POLICY.staleQueuedTurnMs - 1)
    harness.transport.clearSent()
    harness.transport.handshake()
    expect(harness.transport.of('req').map((req) => req.intent)).toEqual(['sendTurn'])
    expect(harness.client.notices.get().some((n) => n.kind === 'stale-queued-turn')).toBe(false)
    harness.destroy()
  })

  it('only a turn is held — an aged `land` still drains (§6.6 names `sendTurn`)', () => {
    const harness = offlineClient()
    void harness.client.land('delegation-1', { attemptId: 'a1', mode: 'commit' })
    harness.clock.advance(SERVER_POLICY.staleQueuedTurnMs * 10)
    harness.transport.handshake()
    expect(harness.transport.of('req').map((req) => req.intent)).toEqual(['land'])
    harness.destroy()
  })
})
