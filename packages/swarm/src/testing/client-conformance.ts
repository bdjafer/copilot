/**
 * `clientConformance()` — the client core's half of §13, as runner-agnostic cases.
 *
 * `protocolConformance()` proves the *codec* obeys `swarm.v1`; this proves the **client** does.
 * The two are separate because a codec that routes 34 kinds correctly says nothing about whether
 * a head that slept through a server restart resumes from its cursor, and that is the property
 * the whole durable-log design exists to buy (§2.3, #5).
 *
 * Each case is named after the rule it holds the client to, so a failure names a spec line rather
 * than a function. A host embedding swarm runs the same array in whatever runner it already has.
 *
 * DOM-free and Node-free.
 */

import type { DelegationVM } from '../types.ts'
import type { ConformanceCase } from './types.ts'

import { SERVER_POLICY } from '../domain/constants.ts'
import { attentionScore } from '../domain/rollup.ts'
import { SwarmError } from '../errors.ts'
import { CLOSE_CODES } from '../protocol/constants.ts'
import { assert, assertDeepEqual, assertEqual } from './assert.ts'
import { createTestClient, makeAttemptSnapshot, makeFleetSnapshot } from './client-harness.ts'
import { makeDelegationVM, makeTurnDirective } from './fixtures.ts'

export function clientConformance(): ConformanceCase[] {
  const cases: ConformanceCase[] = []
  const test = (name: string, run: () => void | Promise<void>): void => {
    cases.push({
      name: `client: ${name}`,
      run: async () => {
        await run()
      },
    })
  }

  /* ------------------------------------------------------------------- §2.2 the handshake */

  test('`hello` is the first frame it writes, and it names the head (§2.2)', () => {
    const harness = createTestClient()
    const first = harness.transport.sent[0]
    assert(first !== undefined, 'the client must write a frame on open')
    assertEqual(first.k, 'hello', 'hello MUST be the first client frame')
    if (first.k === 'hello') {
      assertEqual(first.minV, 1, 'hello.minV is 1')
      assertEqual(first.maxV, 1, 'hello.maxV is 1')
      assertEqual(first.head, 'test', 'hello.head carries the head kind')
    }
    harness.destroy()
  })

  test('a server frame before `hello_ok` blocks the connection as `protocol` (§2.2)', () => {
    const harness = createTestClient()
    harness.transport.deliver({
      p: 'swarm',
      v: 1,
      k: 'snap',
      id: 1,
      stream: 'fleet',
      seq: 0,
      state: makeFleetSnapshot(),
    })
    assertEqual(
      harness.client.connection.get().status,
      'blocked',
      'a snapshot before hello_ok is a protocol violation',
    )
    assertEqual(harness.client.connection.get().blockedReason, 'protocol', 'reason is protocol')
    harness.destroy()
  })

  test('4001 and 4003 are terminal: the client stops and surfaces a fix (§2.5 rule 4)', () => {
    for (const [code, reason] of [
      [CLOSE_CODES.unauthenticated, 'unauthenticated'],
      [CLOSE_CODES.forbidden, 'forbidden'],
    ] as const) {
      const harness = createTestClient()
      harness.start()
      harness.transport.serverClose(code)
      const vm = harness.client.connection.get()
      assertEqual(vm.status, 'blocked', `close ${code} must block`)
      assertEqual(vm.blockedReason, reason, `close ${code} maps to ${reason}`)
      assertEqual(vm.nextRetryAtMs, null, 'a terminal close schedules no retry')
      harness.destroy()
    }
  })

  test('a non-terminal close schedules a retry with backoff (§2.5 rule 1)', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.serverClose(1006)
    const vm = harness.client.connection.get()
    assertEqual(vm.status, 'reconnecting', 'a transport-level close reconnects')
    assert(vm.nextRetryAtMs !== null, 'a retry must be scheduled')
    assertEqual(vm.attempt, 1, 'the first retry is attempt 1')
    harness.destroy()
  })

  /* -------------------------------------------------------- §2.3 snapshot, resume, gap, lag */

  test('the pinned streams subscribe from `snapshot` before anything else (§2.5 rule 2)', () => {
    const harness = createTestClient()
    harness.transport.handshake()
    const subs = harness.transport.of('sub')
    assertDeepEqual(
      subs.map((sub) => sub.stream),
      ['server', 'fleet'],
      'server then fleet — attention before transcripts',
    )
    assert(
      subs.every((sub) => sub.from === 'snapshot'),
      'a first subscription has no state to apply a delta to',
    )
    harness.destroy()
  })

  test('after a drop it resumes `from:<lastSeq>`, not from a snapshot (§2.3)', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.caps',
      concurrency: { runningAttempts: 1, cap: 4, queued: 0 },
      dispatchPaused: false,
    })
    harness.transport.evt('fleet', 2, {
      k: 'fleet.caps',
      concurrency: { runningAttempts: 2, cap: 4, queued: 0 },
      dispatchPaused: false,
    })
    harness.transport.serverClose(1006)
    harness.transport.clearSent()
    harness.transport.handshake()
    const sub = harness.transport.lastSub('fleet')
    assert(sub !== undefined, 'fleet must be re-subscribed')
    assertEqual(sub.from, 2, 'resume is from the durable cursor, exactly once')
    harness.destroy()
  })

  test('a `seq` gap is an error and is never applied (§2.3)', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.caps',
      concurrency: { runningAttempts: 1, cap: 4, queued: 0 },
      dispatchPaused: false,
    })
    harness.transport.clearSent()
    harness.transport.evt('fleet', 5, {
      k: 'fleet.caps',
      concurrency: { runningAttempts: 9, cap: 4, queued: 0 },
      dispatchPaused: true,
    })
    assert(
      harness.errors.some((error) => error.message.includes('gap on fleet')),
      'a gap is a bug, not a lag signal',
    )
    assertEqual(
      harness.client.fleet.get().concurrency.runningAttempts,
      1,
      'the gapped event must NOT be applied',
    )
    const sub = harness.transport.lastSub('fleet')
    assertEqual(sub?.from, 'snapshot', 'the only recoverable state is a snapshot')
    harness.destroy()
  })

  test('`lagged` forces a re-subscribe from `snapshot` and raises `stream:lagged` (§2.3)', () => {
    const harness = createTestClient()
    harness.start()
    let raised = 0
    harness.client.on('stream:lagged', () => {
      raised += 1
    })
    harness.transport.clearSent()
    harness.transport.lagged('fleet', 7, 'retention')
    assertEqual(raised, 1, 'lag is always explicit and always surfaced')
    assertEqual(harness.transport.lastSub('fleet')?.from, 'snapshot', 'MUST re-subscribe snapshot')
    harness.destroy()
  })

  test('a duplicate `seq` is dropped rather than double-applied (§2.3)', () => {
    const harness = createTestClient()
    harness.start()
    const caps = (running: number) =>
      ({
        k: 'fleet.caps',
        concurrency: { runningAttempts: running, cap: 4, queued: 0 },
        dispatchPaused: false,
      }) as const
    harness.transport.evt('fleet', 1, caps(1))
    harness.transport.evt('fleet', 1, caps(99))
    assertEqual(
      harness.client.fleet.get().concurrency.runningAttempts,
      1,
      'exactly once means a re-delivery changes nothing',
    )
    harness.destroy()
  })

  /* ---------------------------------------------------------------- §4.3 client-core refusals */

  test('`{delivery:"interrupt", reasoningEffort:"max"}` is refused with ZERO frames (§13, #30)', async () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM(),
    })
    harness.transport.clearSent()
    const result = await harness.client.sendTurn(
      'delegation-1',
      makeTurnDirective({ delivery: 'interrupt', reasoningEffort: 'max' }),
    )
    assert(!result.ok, 'the mode gate refuses')
    if (!result.ok) {
      assertEqual(result.error.code, 'config_not_available_in_mode', '§4.3.8 names this code')
    }
    assertEqual(
      harness.transport.of('req').length,
      0,
      'refused in the client core: no wire traffic',
    )
    harness.destroy()
  })

  test('the same turn without the field is accepted and records `inherited` (#30)', async () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM(),
    })
    harness.transport.clearSent()
    const pending = harness.client.sendTurn(
      'delegation-1',
      makeTurnDirective({ delivery: 'interrupt' }),
    )
    const req = harness.transport.lastReq('sendTurn')
    assert(req !== undefined, 'steering mid-turn is legal; only configuring is not')
    harness.transport.respond(req.id, 'turn-9', 2)
    const result = await pending
    assert(result.ok, 'the intent resolves')

    /* And the mode gate's own record: driven offline, where the client builds the TurnVM. */
    const offline = createTestClient({ autoAccept: false })
    offline.transport.handshake()
    offline.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM(),
    })
    offline.transport.serverClose(1006)
    void offline.client.sendTurn('delegation-1', makeTurnDirective({ delivery: 'interrupt' }))
    const turn = offline.client.delegations.get().get('delegation-1')?.attempts[0]?.currentTurn
    assert(turn !== undefined && turn !== null, 'the optimistic turn exists')
    assertEqual(turn.configInherited, true, 'the mode gate applied (§4.3.8)')
    assertEqual(turn.effective.reasoningEffort, 'inherited', 'the only honest value available')
    assertEqual(turn.effortConfirmed, false, 'a literal false — never observable (#7)')
    offline.destroy()
    harness.destroy()
  })

  test('`swarm` and `swarm-deep` are refused in the client core — layer one of three (§4.1, #9)', async () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.clearSent()
    for (const effort of ['swarm', 'swarm-deep']) {
      const result = await harness.client.createDelegation({
        idempotencyKey: `idem-${effort}`,
        spec: {
          ...makeDelegationVM().spec,
          model: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: effort as never },
          workspace: { workspaceId: 'exp-spec', baseRef: 'HEAD' },
        },
      })
      assert(!result.ok, `${effort} must be refused`)
      if (!result.ok) assertEqual(result.error.code, 'banned_effort', '§9 names banned_effort')
    }
    assertEqual(harness.transport.of('req').length, 0, 'a banned effort never reaches the wire')
    harness.destroy()
  })

  test('images totalling 701 KB are refused `invalid_spec`, never `frame_too_large` (#40)', async () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM(),
    })
    harness.transport.clearSent()
    const base64 = 'A'.repeat(Math.ceil(((701 * 1024) / 3) * 4))
    const result = await harness.client.sendTurn(
      'delegation-1',
      makeTurnDirective({ images: [{ mediaType: 'image/png', base64 }] }),
    )
    assert(!result.ok, '701 KB decoded is over the cap')
    if (!result.ok) {
      assertEqual(result.error.code, 'invalid_spec', 'a product refusal, not a transport error')
    }
    assertEqual(harness.transport.of('req').length, 0, 'refused before any frame is built')
    harness.destroy()
  })

  test('two live attempts and no `attemptId` refuses `attempt_ambiguous` (§4.3.10, #29)', async () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM({ liveAttemptIds: ['a1', 'a2'], attempts: [] }),
    })
    harness.transport.clearSent()
    const result = await harness.client.sendTurn('delegation-1', makeTurnDirective())
    assert(!result.ok, 'three concurrent sessions have no "the delegation" to send to')
    if (!result.ok) assertEqual(result.error.code, 'attempt_ambiguous', '§9 names this code')
    assertEqual(harness.transport.of('req').length, 0, 'refused in the client core')
    harness.destroy()
  })

  /* --------------------------------------------------------------- §2.5 rule 3 and §6.6 offline */

  test('an in-flight `req` is re-sent with the SAME idempotencyKey (§2.5 rule 3)', () => {
    const harness = createTestClient()
    harness.start()
    void harness.client.killSwitch({ killInstances: false })
    const first = harness.transport.lastReq('killSwitch')
    assert(first !== undefined, 'the intent was sent')
    harness.transport.serverClose(1006)
    harness.transport.clearSent()
    harness.transport.handshake()
    const second = harness.transport.lastReq('killSwitch')
    assert(second !== undefined, 'an unanswered req is re-sent')
    assertEqual(
      second.idempotencyKey,
      first.idempotencyKey,
      'a fresh key would turn one mutation into two',
    )
    harness.destroy()
  })

  test('intents issued offline queue, count, and flush in order (§6.6, H9)', async () => {
    const harness = createTestClient({ autoAccept: false })
    void harness.client.killSwitch({ killInstances: false })
    void harness.client.discard('attempt-7')
    assertEqual(harness.client.connection.get().queuedOffline, 2, 'both are queued')
    assertEqual(harness.transport.of('req').length, 0, 'nothing is written while disconnected')
    harness.transport.handshake()
    const reqs = harness.transport.of('req')
    assertDeepEqual(
      reqs.map((req) => req.intent),
      ['killSwitch', 'discard'],
      'order is the contract: a turn must not overtake the delegation it belongs to',
    )
    assertEqual(harness.client.connection.get().queuedOffline, 0, 'the queue drained')
    harness.destroy()
  })

  test('a queued turn older than ten minutes is HELD behind a notice (§6.6)', async () => {
    const harness = createTestClient({ autoAccept: false })
    harness.transport.accept()
    harness.transport.handshake()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM(),
    })
    harness.transport.serverClose(1006)

    const pending = harness.client.sendTurn('delegation-1', makeTurnDirective())
    harness.clock.advance(SERVER_POLICY.staleQueuedTurnMs + 1)
    harness.transport.clearSent()
    harness.transport.handshake()

    const result = await pending
    assert(!result.ok, 'ten minutes of a closed lid is enough for the instruction to be wrong')
    assertEqual(harness.transport.of('req').length, 0, 'it is held, not sent')
    assert(
      harness.client.notices.get().some((notice) => notice.kind === 'stale-queued-turn'),
      'the head is told, with an action to send it anyway',
    )
    harness.destroy()
  })

  test('an offline `createDelegation` applies an optimistic record with `version: -1` (§6.6)', () => {
    const harness = createTestClient({ autoAccept: false })
    void harness.client.createDelegation({
      idempotencyKey: 'idem-offline',
      delegationId: 'delegation-offline',
      spec: {
        ...makeDelegationVM().spec,
        workspace: { workspaceId: 'exp-spec', baseRef: 'HEAD' },
      },
    })
    const vm = harness.client.delegations.get().get('delegation-offline')
    assert(vm !== undefined, 'the head sees the delegation it just created')
    assertEqual(vm.version, -1, 'version -1 is the optimistic marker')
    assertEqual(vm.state, 'queued', 'nothing else is invented')
    assertEqual(vm.baseRevision, '', 'the server resolves baseRef to a sha; the client does not')
    harness.destroy()
  })

  /* ------------------------------------------------------------------ §6.2 view-model contract */

  test('every published view model is frozen and structuredClone-able (§6.2)', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM(),
    })
    const vm = harness.client.delegations.get().get('delegation-1')
    assert(vm !== undefined, 'the delegation exists')
    assert(Object.isFrozen(vm), 'a VM handed to N heads must not be mutable by one of them')
    assert(Object.isFrozen(vm.attempts), 'and neither must its arrays')
    structuredClone(vm)
    structuredClone(harness.client.fleet.get())
    structuredClone(harness.client.connection.get())
    harness.destroy()
  })

  test('an event that touches nothing leaves the VM referentially identical (§6.2)', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM(),
    })
    const before = harness.client.delegations.get().get('delegation-1')
    harness.transport.evt('fleet', 2, {
      k: 'fleet.caps',
      concurrency: { runningAttempts: 1, cap: 4, queued: 0 },
      dispatchPaused: false,
    })
    assert(
      harness.client.delegations.get().get('delegation-1') === before,
      '=== memoization in a head is only correct if unchanged means identical',
    )
    harness.destroy()
  })

  test('`bucketOf` produces both the row badge and the fleet list (§6.2.1)', () => {
    const harness = createTestClient()
    harness.start()
    harness.transport.evt('fleet', 1, {
      k: 'fleet.delegation_created',
      delegation: makeDelegationVM({ state: 'verifying' }),
    })
    const vm = harness.client.delegations.get().get('delegation-1') as DelegationVM
    assertEqual(vm.bucket, 'working', 'verifying is visible in `working`, never nowhere (#37)')
    assertDeepEqual(
      harness.client.fleet.get().buckets.working,
      ['delegation-1'],
      'the list and the badge come from one function',
    )
    harness.destroy()
  })

  test('the attention score is the arithmetic of §6.4–6.6, recomputed locally', () => {
    const harness = createTestClient({ startAtMs: 10 * 60_000 })
    harness.start()
    harness.transport.evt(
      'fleet',
      1,
      {
        k: 'fleet.delegation_created',
        delegation: makeDelegationVM({ state: 'needs-you', attentionScore: 1000 }),
      },
      10 * 60_000,
    )
    const vm = harness.client.delegations.get().get('delegation-1') as DelegationVM
    assertEqual(
      vm.attentionScore,
      attentionScore({
        state: 'needs-you',
        landed: false,
        stalled: false,
        deliveryUnknown: false,
        budgetBreached: false,
        staleBase: false,
        ageMinutes: 0,
      }),
      'the server score is inverted for age once, then recomputed from the VM',
    )
    harness.destroy()
  })

  /* ------------------------------------------------------------------- §6.2 the two handles */

  test('the attempt stream is subscribed on the first handle and released on the last (§6.2)', () => {
    const harness = createTestClient()
    harness.start()
    assertEqual(harness.transport.lastSub('attempt:a1'), undefined, 'nothing is subscribed yet')
    const transcript = harness.client.transcript('a1')
    const diff = harness.client.diff('a1')
    assert(
      harness.transport.lastSub('attempt:a1') !== undefined,
      'one subscription for two handles',
    )
    assertEqual(
      harness.transport.of('sub').filter((sub) => sub.stream === 'attempt:a1').length,
      1,
      'two handles must not double the only traffic allowed to lag',
    )
    transcript.release()
    assertEqual(harness.transport.of('unsub').length, 0, 'the diff still holds it')
    diff.release()
    assertEqual(harness.transport.of('unsub').length, 1, 'released on the last handle')
    harness.destroy()
  })

  test('consecutive text deltas coalesce into one entry (§2.4, §6.2)', () => {
    const harness = createTestClient()
    harness.start()
    const transcript = harness.client.transcript('a1')
    harness.transport.snap('attempt:a1', 0, makeAttemptSnapshot({ attemptId: 'a1' }))
    harness.transport.evt('attempt:a1', 1, { k: 'att.text', text: 'look' })
    harness.transport.evt('attempt:a1', 2, { k: 'att.text', text: 'ing at it' })
    const entries = transcript.vm.get().entries
    assertEqual(entries.length, 1, 'four hundred deltas are one paragraph')
    assertEqual(
      entries[0]?.k === 'text' ? entries[0].text : '',
      'looking at it',
      'order is preserved by concatenation, not by re-sorting',
    )
    transcript.release()
    harness.destroy()
  })

  /* ------------------------------------------------------------------------- §6.2 inspect() */

  test('`inspect()` is diagnostics only and reports the protocol version', () => {
    const harness = createTestClient()
    harness.start()
    const report = harness.client.inspect()
    assertEqual(report.protocolVersion, 1, 'the wire is swarm.v1')
    assert(report.streams.length >= 2, 'server and fleet are pinned')
    assertEqual(report.pending.length, 0, 'nothing is in flight')
    harness.destroy()
  })

  test('`destroy()` settles every outstanding intent instead of hanging (§4.4 applied)', async () => {
    const harness = createTestClient()
    harness.start()
    const pending = harness.client.killSwitch({ killInstances: false })
    harness.client.destroy()
    const result = await pending
    assert(!result.ok, 'a destroyed client answers its callers')
    if (!result.ok) assert(SwarmError.is(result.error), 'and answers with a SwarmError')
    harness.client.destroy()
  })

  return cases
}
