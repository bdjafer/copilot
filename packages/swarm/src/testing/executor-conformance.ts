/**
 * `executorConformance(factory)` — the suite **any** `ExecutorAdapter` must pass (§5.2, §13).
 *
 * Its job is narrow and unusual: it asserts **declared capabilities against observed behaviour**,
 * so an adapter that claims `observableEffort: true` and never confirms one, or claims
 * `submitAckCorrelates: false` and reports `correlated: true`, fails CI rather than production.
 * Every bold value in §5.2's `jcode` column is a mitigation obligation, and this is where the
 * obligation is checked.
 *
 * Runner-agnostic (`{ name, run }[]`), and driven through a small harness so it can run against
 * `MockExecutor` in every capability configuration **and** against the jcode adapter over
 * `fakeJcodeTransport()`. An adapter that cannot be scripted cannot be conformance-tested, which
 * is why `scriptTurn` is required rather than optional.
 *
 * DOM-free and Node-free.
 */

import type {
  ExecutorAdapter,
  ExecutorEvent,
  ExecutorInstance,
  ExecutorSessionHandle,
  InstanceOptions,
} from '../server/executor/types.ts'
import type { Fence, InstanceKey } from '../types.ts'
import type { Awaitable, ConformanceCase } from './types.ts'

import { sessionLease } from '../domain/leases.ts'
import { SwarmError } from '../errors.ts'
import { assert, assertEqual, assertRejects, show } from './assert.ts'

/** A backend-neutral turn description the harness translates for its adapter. */
export interface ConformanceTurn {
  /** `false` is the ambiguous ack (V5): the send left and nothing came back. */
  readonly ack: boolean
  readonly text?: string
  readonly tools?: readonly {
    readonly callId: string
    readonly name: string
    readonly input?: string
  }[]
  readonly usage?: boolean
  readonly turnDone?: boolean
  /** Emit `closed` in the middle of the turn — V8, C12, D18. */
  readonly disconnectMidTurn?: boolean
}

export interface ExecutorHarness {
  readonly adapter: ExecutorAdapter
  readonly instanceKey: InstanceKey
  readonly instanceOptions: InstanceOptions
  /** Arrange the backend so this session's next `submit` produces `turn`. */
  scriptTurn(session: ExecutorSessionHandle, turn: ConformanceTurn): void
  /** Kill the transport under a session, outside a turn (C12). */
  disconnect(session: ExecutorSessionHandle): void
  dispose(): Awaitable<void>
}

const ACK_WINDOW_MS = 40

/**
 * A bounded window for a **negative** claim about a stream.
 *
 * "Nothing more arrived" cannot be drained for — there is no frame to stop on — so the only
 * honest form is "nothing arrived within a window, and then the stream was ended". It is the same
 * shape as V5's `awaitAckMs`, which is a deadline for exactly the same reason.
 */
const settle = (ms = ACK_WINDOW_MS): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

function fenceFor(session: ExecutorSessionHandle, token: number): Fence {
  return { key: sessionLease(session.sessionId), token }
}

/** Drain until `stop` matches or the stream ends; never blocks past the end of the stream. */
async function drain(
  iterator: AsyncIterableIterator<ExecutorEvent>,
  stop: (e: ExecutorEvent) => boolean,
  max = 200,
): Promise<ExecutorEvent[]> {
  const seen: ExecutorEvent[] = []
  for (let i = 0; i < max; i++) {
    const next = await iterator.next()
    if (next.done === true) break
    seen.push(next.value)
    if (stop(next.value)) break
  }
  return seen
}

export function executorConformance(factory: () => Awaitable<ExecutorHarness>): ConformanceCase[] {
  const cases: ConformanceCase[] = []

  const test = (
    name: string,
    run: (ctx: {
      harness: ExecutorHarness
      instance: ExecutorInstance
      session: ExecutorSessionHandle
      fence: Fence
    }) => Promise<void>,
  ): void => {
    cases.push({
      name: `executor: ${name}`,
      run: async () => {
        const harness = await factory()
        const instance = await harness.adapter.acquireInstance(
          harness.instanceKey,
          harness.instanceOptions,
        )
        const session = await instance.createSession({
          workingDir: harness.instanceOptions.workingDir,
        })
        try {
          await run({ harness, instance, session, fence: fenceFor(session, 1) })
        } finally {
          await harness.dispose()
        }
      },
    })
  }

  /* ------------------------------------------------------------------- §5.1 preflight + pool */

  cases.push({
    name: 'executor: preflight reports ok XOR a blocked discriminant, and a blocked one has a fix',
    run: async () => {
      const harness = await factory()
      try {
        const report = await harness.adapter.preflight()
        assertEqual(report.ok, report.blocked === null, 'ok must be exactly "nothing is blocked"')
        if (report.blocked !== null) {
          assert(
            typeof report.fix === 'string' && report.fix.length > 0,
            'a blocked preflight MUST carry a copy-pasteable fix (R2, R3)',
          )
        }
      } finally {
        await harness.dispose()
      }
    },
  })

  cases.push({
    name: 'executor: one instance per InstanceKey (§5.3) — acquiring twice returns the same one',
    run: async () => {
      const harness = await factory()
      try {
        const a = await harness.adapter.acquireInstance(
          harness.instanceKey,
          harness.instanceOptions,
        )
        const b = await harness.adapter.acquireInstance(
          harness.instanceKey,
          harness.instanceOptions,
        )
        assert(a === b, 'the instance pool must be keyed by InstanceKey (R10, §5.3)')
      } finally {
        await harness.dispose()
      }
    },
  })

  /* ---------------------------------------------------------------------- §3.4 fencing */

  test('a fence below the highest observed for the session is refused with stale_fence', async (c) => {
    c.harness.scriptTurn(c.session, { ack: true, turnDone: true })
    await c.session.submit({ text: 'first', awaitAckMs: ACK_WINDOW_MS }, fenceFor(c.session, 7))
    await assertRejects(
      c.session.submit({ text: 'second', awaitAckMs: ACK_WINDOW_MS }, fenceFor(c.session, 6)),
      'stale_fence',
      'a mutating call under a stale fence must be refused (§3.4 rule 1)',
    )
  })

  /* ------------------------------------------------------------------- [F2] ack observation */

  test("an observed message_accepted yields ack:'accepted' with a timestamp", async (c) => {
    c.harness.scriptTurn(c.session, { ack: true, text: 'hello', turnDone: true })
    const receipt = await c.session.submit({ text: 'go', awaitAckMs: ACK_WINDOW_MS }, c.fence)
    assertEqual(receipt.ack, 'accepted', 'an emitted ack must produce ack:accepted')
    assert(receipt.ackAtMs !== null, 'an accepted receipt must carry ackAtMs')
  })

  test("no message_accepted inside awaitAckMs yields ack:'unknown' (V5), never a lie", async (c) => {
    c.harness.scriptTurn(c.session, { ack: false, turnDone: true })
    const receipt = await c.session.submit({ text: 'go', awaitAckMs: ACK_WINDOW_MS }, c.fence)
    assertEqual(receipt.ack, 'unknown', 'a missing ack must produce ack:unknown')
    assertEqual(receipt.ackAtMs, null, 'an unknown receipt has no ack timestamp')
  })

  test('SubmitReceipt.correlated matches the declared submitAckCorrelates (§5.4 #3)', async (c) => {
    c.harness.scriptTurn(c.session, { ack: true, turnDone: true })
    const receipt = await c.session.submit({ text: 'go', awaitAckMs: ACK_WINDOW_MS }, c.fence)
    assertEqual(
      receipt.correlated,
      c.harness.adapter.capabilities.submitAckCorrelates,
      'an adapter must not claim a correlation its capability row denies',
    )
  })

  /* --------------------------------------------------------------- §4.2 / §4.3.3 config */

  test('applyConfig confirms only what the capability row says is observable', async (c) => {
    const caps = c.harness.adapter.capabilities
    const report = await c.session.applyConfig({ model: 'm-1', reasoningEffort: 'high' }, c.fence)
    if (caps.observableEffort) {
      assert(
        report.confirmed.includes('reasoningEffort') ||
          report.refused.some((r) => r.field === 'reasoningEffort'),
        'observableEffort:true must either confirm the effort or say it was refused — a capability ' +
          'that is never exercised is not a capability',
      )
    } else {
      assert(
        !report.confirmed.includes('reasoningEffort'),
        'observableEffort:false MUST NOT confirm an effort (§5.4 #11) — it is declared, never observed',
      )
    }
    if (caps.observableModel) {
      const claimed =
        report.confirmed.includes('model') || report.refused.some((r) => r.field === 'model')
      assert(claimed, 'observableModel:true must either confirm the model or say it was refused')
    }
    for (const field of report.confirmed) {
      assert(report.applied.includes(field), 'a confirmed field must also be an applied one')
    }
    for (const refusal of report.refused) {
      assert(
        !report.applied.includes(refusal.field as 'model' | 'reasoningEffort'),
        'a refused field must never appear as applied',
      )
    }
  })

  test('a config change while a turn is in flight is refused with turn_in_flight (§4.3.3)', async (c) => {
    c.harness.scriptTurn(c.session, { ack: true, text: 'streaming', turnDone: false })
    await c.session.submit({ text: 'go', awaitAckMs: ACK_WINDOW_MS }, c.fence)
    await assertRejects(
      c.session.applyConfig({ reasoningEffort: 'max' }, c.fence),
      'turn_in_flight',
      'mid-turn config MUST be refused, never queued and never issued optimistically ([F10])',
    )
  })

  /* --------------------------------------------------------------- §4.2 delivery modes */

  test('a context-only submission is acked and produces NO turn_done (#32)', async (c) => {
    const caps = c.harness.adapter.capabilities
    if (!caps.contextOnlyMessage) {
      await assertRejects(
        c.session.submit({ text: 'ctx', contextOnly: true, awaitAckMs: ACK_WINDOW_MS }, c.fence),
        'capability_absent',
        'an adapter without contextOnlyMessage must refuse it rather than fake it',
      )
      return
    }
    const events = c.session.events()
    const receipt = await c.session.submit(
      { text: 'ctx', contextOnly: true, awaitAckMs: ACK_WINDOW_MS },
      c.fence,
    )
    assertEqual(receipt.ack, 'accepted', 'a context-only message is still acked')
    /* End the stream so "no turn_done ever arrives" is a claim about the whole turn, not about
     * however far a bounded drain happened to read. */
    c.harness.disconnect(c.session)
    const seen = await drain(events, (e) => e.k === 'closed')
    assert(
      !seen.some((e) => e.k === 'turn_done'),
      'noReply produces no turn_done — V13 is the only path to `ended` for it',
    )
  })

  test('softInterrupt capability governs soft/urgent, and landing stays unobservable', async (c) => {
    const caps = c.harness.adapter.capabilities
    c.harness.scriptTurn(c.session, { ack: true, text: 'working', turnDone: false })
    const events = c.session.events()
    await c.session.submit({ text: 'go', awaitAckMs: ACK_WINDOW_MS }, c.fence)
    await drain(events, (e) => e.k === 'text')
    if (!caps.softInterrupt) {
      await assertRejects(
        c.session.interrupt('soft', 'stop that', c.fence),
        'capability_absent',
        'an adapter without softInterrupt must refuse it',
      )
      return
    }
    await c.session.interrupt('soft', 'stop touching the fixtures', c.fence)
    /*
     * The observable is "did ANYTHING acknowledge the interrupt". §5.4 #10 turns on the fact that
     * `soft_interrupt_injected` is untranslated on jcode: nothing arrives, so `landing` stays
     * `'unconfirmed'` forever and swarm must never claim otherwise. An adapter that DECLARES the
     * capability owes an event, and one that denies it must not emit anything either — the stream
     * is ended first so this is a claim about the whole remainder of the turn, not about however
     * far a bounded drain happened to read.
     */
    c.harness.disconnect(c.session)
    const after = await drain(events, (e) => e.k === 'closed')
    const acknowledged = after.some((e) => e.k !== 'closed')
    assertEqual(
      acknowledged,
      caps.interruptLandingObservable,
      caps.interruptLandingObservable
        ? 'interruptLandingObservable:true must produce something to observe'
        : 'interruptLandingObservable:false MUST leave the landing unconfirmed (§5.4 #10)',
    )
  })

  test('structuredOutput capability governs structured(), and raw is kept as evidence', async (c) => {
    const caps = c.harness.adapter.capabilities
    if (!caps.structuredOutput) {
      await assertRejects(
        c.session.structured({ text: 'judge' }, {}, 2, c.fence),
        'capability_absent',
        'an adapter without structuredOutput must refuse it',
      )
      return
    }
    const result = await c.session.structured({ text: 'judge' }, {}, 2, c.fence)
    assert(result.attempts >= 1, 'a structured run costs at least one turn against the budget')
    assert(result.attempts <= 3, 'a structured run costs at most maxRetries + 1 turns')
    assert(result.raw.length >= 1, 'every response, valid or not, is stored as evidence')
  })

  test('history capability governs tail(), which is peekSession and text-only ([F8])', async (c) => {
    const caps = c.harness.adapter.capabilities
    c.harness.scriptTurn(c.session, { ack: true, text: 'reply', turnDone: true })
    await c.session.submit({ text: 'a prompt with a digest', awaitAckMs: ACK_WINDOW_MS }, c.fence)
    const tail = await c.session.tail(12)
    if (caps.history === 'none') {
      assertEqual(tail.length, 0, "history:'none' must return nothing rather than an empty string")
      return
    }
    for (const entry of tail) {
      assertEqual(typeof entry.role, 'string', 'tail entries carry a role')
      assertEqual(typeof entry.content, 'string', 'tail entries carry text content')
    }
  })

  test('usageEvents capability governs whether a usage event is ever observed', async (c) => {
    const caps = c.harness.adapter.capabilities
    const events = c.session.events()
    c.harness.scriptTurn(c.session, { ack: true, usage: true, turnDone: true })
    await c.session.submit({ text: 'go', awaitAckMs: ACK_WINDOW_MS }, c.fence)
    const seen = await drain(events, (e) => e.k === 'turn_done')
    const sawUsage = seen.some((e) => e.k === 'usage')
    assertEqual(
      sawUsage,
      caps.usageEvents,
      caps.usageEvents
        ? 'usageEvents:true must actually produce one on a turn that reports usage'
        : 'usageEvents:false must never emit a usage event',
    )
  })

  /* --------------------------------------------------------------------- [F11] tool ids */

  test('tool_input is never attributed to a tool other than the last tool_start ([F11])', async (c) => {
    const events = c.session.events()
    c.harness.scriptTurn(c.session, {
      ack: true,
      tools: [
        { callId: 'call-a', name: 'bash', input: '{"cmd":' },
        { callId: 'call-b', name: 'read', input: '{"path":' },
      ],
      turnDone: true,
    })
    await c.session.submit({ text: 'go', awaitAckMs: ACK_WINDOW_MS }, c.fence)
    const seen = await drain(events, (e) => e.k === 'turn_done')
    const start = seen.find((e) => e.k === 'tool_start')
    if (start === undefined) return
    assert(start.k === 'tool_start' && start.callId.length > 0, 'tool_start must carry its id')

    /**
     * §5.1 leaves one thing open, and this assertion holds it open deliberately:
     * `tool_input.callId` is typed `'' | string` because an adapter MAY attribute at the seam —
     * the jcode adapter does, to the most recent `tool_start` on that session, which is what §5.1
     * requires of it — or MAY pass the bridge's literal `''` through, which `MockExecutor` does so
     * that a consumer keying a buffer by it fails loudly rather than quietly.
     *
     * The third value is the one that is never allowed: a *different* tool's id. That is the
     * failure [F11] describes — every concurrent tool's argument stream merged into one bucket —
     * and it is the only one a backend-neutral suite can falsify.
     */
    let lastStart = ''
    let inputs = 0
    for (const event of seen) {
      if (event.k === 'tool_start') lastStart = event.callId
      if (event.k !== 'tool_input') continue
      inputs += 1
      assertEqual(
        event.callId === '' || event.callId === lastStart,
        true,
        `an input delta was attributed to ${show(event.callId)}, which is not the most recent ` +
          `tool_start (${show(lastStart)})`,
      )
    }
    assert(inputs > 0, 'the scripted turn produced no input deltas to attribute')
  })

  /* ------------------------------------------------------- X7, §5.4 #2 stream semantics */

  test('a disconnect mid-turn emits closed and ends the stream (V8, C12)', async (c) => {
    const events = c.session.events()
    c.harness.scriptTurn(c.session, { ack: true, text: 'half a', disconnectMidTurn: true })
    await c.session.submit({ text: 'go', awaitAckMs: ACK_WINDOW_MS }, c.fence)
    const seen = await drain(events, (e) => e.k === 'closed')
    assert(
      seen.some((e) => e.k === 'closed'),
      'a disconnect must be observable as `closed`',
    )
    const after = await events.next()
    assertEqual(
      after.done,
      true,
      'the stream ends after `closed`; there is no replay ([F2], §5.4 #2)',
    )
  })

  test('nativeReplay decides what a LATE subscriber receives, both ways (§5.4 #2)', async (c) => {
    const caps = c.harness.adapter.capabilities
    const first = c.session.events()
    c.harness.scriptTurn(c.session, { ack: true, text: 'early', turnDone: true })
    await c.session.submit({ text: 'go', awaitAckMs: ACK_WINDOW_MS }, c.fence)
    await drain(first, (e) => e.k === 'turn_done')
    const late = c.session.events()
    c.harness.disconnect(c.session)
    const seen = await drain(late, (e) => e.k === 'closed')
    assertEqual(
      seen.some((e) => e.k === 'text' && e.text === 'early'),
      caps.nativeReplay,
      caps.nativeReplay
        ? 'nativeReplay:true owes a late subscriber what it missed — declaring it and delivering ' +
            'nothing is the lie this suite exists to catch'
        : 'without native replay, what was not received never existed — the durable log is the ' +
            'truth (§5.4 #2)',
    )
  })

  /* ------------------------------------------------- §5.2 the rows nothing else exercises */

  test('idempotentSubmit decides whether a repeated submission runs a second turn (§5.2)', async (c) => {
    const caps = c.harness.adapter.capabilities
    const events = c.session.events()
    c.harness.scriptTurn(c.session, { ack: true, text: 'one', turnDone: true })
    await c.session.submit({ text: 'the same words', awaitAckMs: ACK_WINDOW_MS }, c.fence)
    await drain(events, (e) => e.k === 'turn_done')

    c.harness.scriptTurn(c.session, { ack: true, text: 'two', turnDone: true })
    await c.session.submit({ text: 'the same words', awaitAckMs: ACK_WINDOW_MS }, c.fence)

    if (!caps.idempotentSubmit) {
      const seen = await drain(events, (e) => e.k === 'turn_done')
      assert(
        seen.some((e) => e.k === 'turn_done'),
        'idempotentSubmit:false MUST run it twice; swarm carries the idempotency itself (§2.5 ' +
          'rule 3) precisely because the executor does not',
      )
      return
    }
    /* Give a second turn time to play, then end the stream: "no second turn ever ran" is then a
     * claim about a bounded window plus the whole remainder, not about scheduling luck. */
    await settle()
    c.harness.disconnect(c.session)
    const seen = await drain(events, (e) => e.k === 'closed')
    assert(
      !seen.some((e) => e.k === 'turn_done'),
      'idempotentSubmit:true must recognise the repeat — the seam carries no key (§5.1), so ' +
        'de-duplication is the only thing the flag can mean',
    )
  })

  test('perTurnConfig decides whether config rides the message or sticks to the session (§5.2)', async (c) => {
    const caps = c.harness.adapter.capabilities
    if (!caps.observableModel) {
      /* Config has exactly one observable at this seam (`model_info`), and this adapter denies
       * it. Nothing is asserted rather than asserted vacuously — the hole is named, not hidden. */
      return
    }
    const events = c.session.events()
    await c.session.applyConfig({ model: 'm-2' }, c.fence)
    /* Consume the announcement `applyConfig` itself makes, so what follows is the turn's own. */
    await drain(events, (e) => e.k === 'model_info')

    c.harness.scriptTurn(c.session, { ack: true, text: 'x', turnDone: true })
    await c.session.submit({ text: 'go', awaitAckMs: ACK_WINDOW_MS }, c.fence)
    const seen = await drain(events, (e) => e.k === 'turn_done')
    assertEqual(
      seen.some((e) => e.k === 'model_info'),
      caps.perTurnConfig,
      caps.perTurnConfig
        ? 'perTurnConfig:true attaches config to each message, so each turn carries it'
        : 'perTurnConfig:false is session-sticky: the config is set ONCE and outlives the ' +
            'submission that followed it — which is why §4.3.3 refuses a mid-turn change',
    )
  })

  test('perTurnToolRestriction: unrepresentable at this seam, and argv is never a claim ([F4])', async (c) => {
    const caps = c.harness.adapter.capabilities
    /*
     * §5.1's `ExecutorSubmission` carries `text`/`contextOnly`/`awaitAckMs`/`images` and
     * `SessionConfigPatch` carries `model`/`reasoningEffort`. Neither carries a tool set, so
     * there is nowhere for a per-turn restriction to be expressed and no way for one to be
     * observed: an adapter declaring `true` is declaring something this seam cannot honour.
     */
    assertEqual(
      caps.perTurnToolRestriction,
      false,
      'no field of ExecutorSubmission or SessionConfigPatch can carry a tool set (§5.1, §5.2)',
    )
    /*
     * [F4]'s trap: `InstanceOptions.argv` goes to the BRIDGE process, and `spawn_server` forwards
     * only --provider/--provider-profile/--model to `jcode serve`. Tool flags there are inert, and
     * an adapter that read them as authority would report a restriction that does not exist.
     */
    const withToolArgv = await c.harness.adapter.acquireInstance(c.harness.instanceKey, {
      ...c.harness.instanceOptions,
      argv: ['--allowed-tools', 'read'],
    })
    assertEqual(
      c.harness.adapter.capabilities.perTurnToolRestriction,
      false,
      'a tool flag in the bridge argv is not a tool-authority claim ([F4], §7.3)',
    )
    assertEqual(withToolArgv.adapterId, c.harness.adapter.id, 'and it is the same adapter')
  })

  test('programmaticApprovals is the supports("permissions") probe, not a claim (R6, §5.2)', async (c) => {
    const caps = c.harness.adapter.capabilities
    const info = await c.instance.runtimeInfo()
    /*
     * `HealthVM.approvalsAvailable` is defined as this probe and nothing else. If the declared
     * capability and the advertised one can disagree, the health surface is reporting a constant.
     */
    assertEqual(
      info.capabilities.includes('permissions'),
      caps.programmaticApprovals,
      "the declared capability and the backend's advertised one are the same fact (R6)",
    )
  })

  test('sessionsPerConnection is a transport fact: sessions stay distinct and isolated (§5.3)', async (c) => {
    const caps = c.harness.adapter.capabilities
    const other = await c.instance.createSession({
      workingDir: c.harness.instanceOptions.workingDir,
    })
    assert(other.sessionId !== c.session.sessionId, 'two sessions are two sessions')

    const mine = c.session.events()
    c.harness.scriptTurn(other, { ack: true, text: 'not for you', turnDone: true })
    await other.submit({ text: 'go', awaitAckMs: ACK_WINDOW_MS }, fenceFor(other, 1))
    c.harness.disconnect(c.session)
    const seen = await drain(mine, (e) => e.k === 'closed')
    assert(
      !seen.some((e) => e.k === 'text' && e.text === 'not for you'),
      'one connection per session (§5.3) is what makes an untagged ApiEvent::Error attributable ' +
        "at all ([F6]) — a stream that carries another session's events breaks that",
    )
    /* A finite number describes the CONNECTION, not the seam: the adapter opens more. */
    if (typeof caps.sessionsPerConnection === 'number') {
      for (let i = 0; i < caps.sessionsPerConnection + 1; i++) {
        const extra = await c.instance.createSession({
          workingDir: c.harness.instanceOptions.workingDir,
        })
        assert(extra.sessionId.length > 0, 'the seam serves more sessions than one connection can')
      }
    }
  })

  /* --------------------------------------------------------- §5.4 #9 close, §4.3.7 kill */

  test('close() is the only release: after it, a submit is refused (§5.4 #9)', async (c) => {
    await c.session.close('done')
    await assertRejects(
      c.session.submit({ text: 'after close', awaitAckMs: ACK_WINDOW_MS }, c.fence),
      'executor_unavailable',
      'a closed session must refuse work; there is no detach to undo (#10)',
    )
  })

  cases.push({
    name: 'executor: hardKill without a swarm-created pgid refuses capability_absent (§4.3.7)',
    run: async () => {
      const harness = await factory()
      try {
        const instance = await harness.adapter.acquireInstance(
          harness.instanceKey,
          harness.instanceOptions,
        )
        if (instance.pgid === null) {
          await assertRejects(
            instance.hardKill('panic'),
            'capability_absent',
            'an adapter that cannot name a group it created MUST fail rather than guess',
          )
          return
        }
        const outcome = await instance.hardKill('panic')
        assertEqual(outcome.pgid, instance.pgid, 'the report names the group that was signalled')
        assert(outcome.signalled.length > 0, 'a completed kill signalled something')
        if (outcome.daemonPid === null) {
          assertEqual(
            outcome.daemonStopped,
            false,
            'no daemon pid ⇒ daemonStopped:false — a partial stop is never reported as a stop ([F1])',
          )
        }
      } finally {
        await harness.dispose()
      }
    },
  })

  cases.push({
    name: 'executor: dispose() is idempotent and leaves no session usable',
    run: async () => {
      const harness = await factory()
      const instance = await harness.adapter.acquireInstance(
        harness.instanceKey,
        harness.instanceOptions,
      )
      const session = await instance.createSession({
        workingDir: harness.instanceOptions.workingDir,
      })
      try {
        await instance.dispose('first')
        await instance.dispose('second')
        let refused = false
        try {
          await session.submit({ text: 'x', awaitAckMs: ACK_WINDOW_MS }, fenceFor(session, 1))
        } catch (error) {
          refused = SwarmError.is(error)
        }
        assert(refused, 'a disposed instance leaves no writable session behind')
      } finally {
        await harness.dispose()
      }
    },
  })

  return cases
}
