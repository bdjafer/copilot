/**
 * SPEC-swarm §5.1–§5.2 — `executorConformance()` against `MockExecutor` in several capability
 * configurations (§13: "passes against `MockExecutor` in **every capability configuration it
 * declares**"), plus the injectable failures the suite drives on behalf of the server stage.
 */

import { describe, expect, it } from 'vitest'

import type {
  ExecutorAdapter,
  ExecutorCapabilities,
  ExecutorEvent,
  ExecutorSessionHandle,
} from '../src/server/executor/types.ts'
import type { MockExecutorOptions } from '../src/testing/mock-executor.ts'

import { sessionLease } from '../src/domain/leases.ts'
import { SwarmError } from '../src/errors.ts'
import { JCODE_CAPABILITIES } from '../src/server/executor/types.ts'
import { executorConformance } from '../src/testing/executor-conformance.ts'
import {
  MOCK_DEFAULT_CAPABILITIES,
  MockExecutor,
  mockInstanceOptions,
} from '../src/testing/mock-executor.ts'
import { mockExecutorHarness } from '../src/testing/mock-harness.ts'

const CONFIGURATIONS = {
  'jcode-shaped (the default)': {},
  'a fully capable backend': {
    capabilities: {
      nativeReplay: true,
      idempotentSubmit: true,
      submitAckCorrelates: true,
      observableEffort: true,
      observableModel: true,
      perTurnConfig: true,
      programmaticApprovals: true,
      structuredOutput: true,
      contextOnlyMessage: true,
      softInterrupt: true,
      interruptLandingObservable: true,
      history: 'lossless' as const,
      sessionsPerConnection: 'many' as const,
      usageEvents: true,
    },
  },
  'a minimal backend': {
    capabilities: {
      observableModel: false,
      structuredOutput: false,
      contextOnlyMessage: false,
      softInterrupt: false,
      history: 'none' as const,
      usageEvents: false,
    },
  },
  'an instance with no swarm-created process group': { pgid: null },
}

for (const [label, options] of Object.entries(CONFIGURATIONS)) {
  describe(`executorConformance() — ${label}`, () => {
    for (const testCase of executorConformance(() => mockExecutorHarness(options))) {
      it(testCase.name, testCase.run)
    }
  })
}

/**
 * §5.2's whole claim about this suite is "**a lying adapter fails CI**", and that is a property of
 * the suite, not of the mock — a mock that derives its behaviour from its own capability row can
 * never disagree with it. So the lie is injected at the seam instead: a wrapper that keeps
 * `MockExecutor`'s behaviour and swaps the declared row underneath it.
 *
 * These cases are the mutation proof, made permanent. Each one asserts that the suite **rejects**
 * a row the backend does not honour; a row nothing exercises would silently pass and is exactly
 * what this catches.
 */
function lyingAdapter(
  truth: MockExecutorOptions,
  lie: Partial<ExecutorCapabilities>,
): ExecutorAdapter {
  const real = new MockExecutor(truth)
  return {
    id: real.id,
    capabilities: { ...real.capabilities, ...lie },
    preflight: () => real.preflight(),
    acquireInstance: (key, opts) => real.acquireInstance(key, opts),
    /* The lie is about capabilities and nothing else. `quiesce` is the harness's barrier for a
     * negative claim about the stream, and a proxy that dropped it would hand every such case an
     * instantly-resolving barrier — turning "no second turn ran" into a false green for exactly
     * the adapters this suite exists to catch. */
    quiesce: () => real.quiesce(),
  } as ExecutorAdapter
}

function lyingHarness(truth: MockExecutorOptions, lie: Partial<ExecutorCapabilities>) {
  const honest = mockExecutorHarness(truth)
  return { ...honest, adapter: lyingAdapter(truth, lie) }
}

async function failuresUnder(
  truth: MockExecutorOptions,
  lie: Partial<ExecutorCapabilities>,
): Promise<string[]> {
  const failed: string[] = []
  for (const testCase of executorConformance(() => lyingHarness(truth, lie))) {
    try {
      await testCase.run()
    } catch {
      failed.push(testCase.name)
    }
  }
  return failed
}

describe('§5.2 a lying adapter fails CI — the claim, asserted', () => {
  const LIES: readonly { readonly label: string; readonly lie: Partial<ExecutorCapabilities> }[] = [
    { label: 'nativeReplay', lie: { nativeReplay: true } },
    { label: 'idempotentSubmit', lie: { idempotentSubmit: true } },
    { label: 'submitAckCorrelates', lie: { submitAckCorrelates: true } },
    { label: 'observableEffort', lie: { observableEffort: true } },
    { label: 'perTurnConfig', lie: { perTurnConfig: true } },
    { label: 'programmaticApprovals', lie: { programmaticApprovals: true } },
    { label: 'perTurnToolRestriction', lie: { perTurnToolRestriction: true } },
    { label: 'interruptLandingObservable', lie: { interruptLandingObservable: true } },
    { label: 'usageEvents', lie: { usageEvents: false } },
    { label: 'history', lie: { history: 'none' } },
    { label: 'structuredOutput', lie: { structuredOutput: false } },
    { label: 'contextOnlyMessage', lie: { contextOnlyMessage: false } },
    { label: 'softInterrupt', lie: { softInterrupt: false } },
  ]

  for (const { label, lie } of LIES) {
    it(`rejects an adapter that overstates \`${label}\``, async () => {
      const failed = await failuresUnder({}, lie)
      expect(failed.length).toBeGreaterThan(0)
    })
  }

  it('and passes the honest row it was derived from, so the proof is not vacuous', async () => {
    expect(await failuresUnder({}, {})).toEqual([])
  })

  /**
   * The regression test for the barrier itself.
   *
   * `idempotentSubmit` is caught by one case, and that case has to prove a **negative** — "no
   * second turn ever ran". It used to do so by waiting a fixed 40 ms and then ending the stream.
   * The mock emits every step behind `sleep(0)`, so a turn costs several macrotask hops; on a
   * loaded runner those hops outlast the window, the second `turn_done` lands after the stream
   * has been ended, and the lie goes uncaught. That is a false green in a suite whose entire job
   * is catching this exact lie, and it is why the case was flaky rather than merely slow.
   *
   * `quiesce()` replaced the window with the backend's own completion. Driving the mock with a
   * sleep far slower than any window would have been reproduces the original conditions
   * deterministically: with a wall clock this fails, with a barrier it does not.
   */
  it('catches the lie even when every step is slower than any wall-clock window would be', async () => {
    const slow = { sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms + 30)) }
    const failed = await failuresUnder(slow, { idempotentSubmit: true })
    expect(failed).toContain(
      'executor: idempotentSubmit decides whether a repeated submission runs a second turn (§5.2)',
    )
  })

  it('rejects an adapter that UNDERSTATES a capability it actually has', async () => {
    const capable = {
      capabilities: {
        nativeReplay: true,
        observableEffort: true,
        interruptLandingObservable: true,
        programmaticApprovals: true,
      },
    }
    expect(await failuresUnder(capable, {})).toEqual([])
    /* Same behaviour, denied on the wire: every one of the four must be caught. */
    for (const lie of [
      { nativeReplay: false },
      { observableEffort: false },
      { interruptLandingObservable: false },
      { programmaticApprovals: false },
    ] as const) {
      expect(await failuresUnder(capable, lie)).not.toEqual([])
    }
  })
})

describe('§5.2 the capability matrix', () => {
  it('mock defaults to the jcode column, so a test that does not opt out tests the real shape', () => {
    expect(MOCK_DEFAULT_CAPABILITIES).toEqual(JCODE_CAPABILITIES)
  })

  it('states the jcode row exactly as §5.2 does', () => {
    expect(JCODE_CAPABILITIES.nativeReplay).toBe(false)
    expect(JCODE_CAPABILITIES.idempotentSubmit).toBe(false)
    expect(JCODE_CAPABILITIES.submitAckCorrelates).toBe(false)
    expect(JCODE_CAPABILITIES.observableEffort).toBe(false)
    expect(JCODE_CAPABILITIES.observableModel).toBe(true)
    expect(JCODE_CAPABILITIES.perTurnConfig).toBe(false)
    expect(JCODE_CAPABILITIES.programmaticApprovals).toBe(false)
    expect(JCODE_CAPABILITIES.perTurnToolRestriction).toBe(false)
    expect(JCODE_CAPABILITIES.structuredOutput).toBe(true)
    expect(JCODE_CAPABILITIES.contextOnlyMessage).toBe(true)
    expect(JCODE_CAPABILITIES.softInterrupt).toBe(true)
    expect(JCODE_CAPABILITIES.interruptLandingObservable).toBe(false)
    expect(JCODE_CAPABILITIES.history).toBe('text-only')
    expect(JCODE_CAPABILITIES.sessionsPerConnection).toBe(1)
    expect(JCODE_CAPABILITIES.usageEvents).toBe(true)
  })
})

async function newSession(adapter: MockExecutor): Promise<{
  session: ExecutorSessionHandle
  instance: Awaited<ReturnType<MockExecutor['acquireInstance']>>
}> {
  const instance = await adapter.acquireInstance('mock/default', mockInstanceOptions())
  const session = await instance.createSession({ workingDir: '/tmp/w' })
  return { session, instance }
}

const fence = (session: ExecutorSessionHandle, token = 1) => ({
  key: sessionLease(session.sessionId),
  token,
})

async function collect(
  iterator: AsyncIterableIterator<ExecutorEvent>,
  stop: (e: ExecutorEvent) => boolean,
  max = 100,
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

describe('MockExecutor — the injectable failures the server stage needs', () => {
  it('ambiguous ack: the send left, nothing came back, and the receipt says `unknown` (V5)', async () => {
    const adapter = new MockExecutor()
    const { session } = await newSession(adapter)
    adapter.script(session, { ack: false, steps: [{ k: 'turn_done' }] })
    const receipt = await session.submit({ text: 'go', awaitAckMs: 20 }, fence(session))
    expect(receipt.ack).toBe('unknown')
    expect(receipt.ackAtMs).toBeNull()
    expect(receipt.correlated).toBe(false)
  })

  it('disconnect mid-turn: a `closed` event, then the stream ends (V8, C12, D18)', async () => {
    const adapter = new MockExecutor()
    const { session } = await newSession(adapter)
    const events = session.events()
    adapter.script(session, {
      ack: true,
      steps: [
        { k: 'text', text: 'half an ans' },
        { k: 'disconnect', reason: 'daemon died' },
      ],
    })
    await session.submit({ text: 'go', awaitAckMs: 50 }, fence(session))
    const seen = await collect(events, (e) => e.k === 'closed')
    expect(seen.map((e) => e.k)).toEqual(['accepted', 'text', 'closed'])
    expect(await events.next()).toEqual({ value: undefined, done: true })
  })

  it('refused effort change: reported in `refused`, never in `applied` (§4.2)', async () => {
    const adapter = new MockExecutor({ refuseConfig: ['reasoningEffort'] })
    const { session } = await newSession(adapter)
    const report = await session.applyConfig({ reasoningEffort: 'max' }, fence(session))
    expect(report.applied).toEqual([])
    expect(report.confirmed).toEqual([])
    expect(report.refused).toEqual([{ field: 'reasoningEffort', reason: 'invalid_request' }])
  })

  it('an applied effort is NEVER confirmed on a jcode-shaped backend (#7, §5.4 #11)', async () => {
    const adapter = new MockExecutor()
    const { session } = await newSession(adapter)
    const report = await session.applyConfig(
      { model: 'm', reasoningEffort: 'high' },
      fence(session),
    )
    expect(report.applied).toEqual(['model', 'reasoningEffort'])
    expect(report.confirmed).toEqual(['model'])
  })

  it('tool events: ids on start/exec/done, an EMPTY id on the input delta ([F11])', async () => {
    const adapter = new MockExecutor()
    const { session } = await newSession(adapter)
    const events = session.events()
    adapter.script(session, {
      ack: true,
      steps: [
        { k: 'tool', callId: 'call-a', name: 'bash', input: '{"cmd":"pnpm test"}', output: 'ok' },
        { k: 'turn_done' },
      ],
    })
    await session.submit({ text: 'go', awaitAckMs: 50 }, fence(session))
    const seen = await collect(events, (e) => e.k === 'turn_done')
    const kinds = seen.map((e) => e.k)
    expect(kinds).toEqual([
      'accepted',
      'tool_start',
      'tool_input',
      'tool_exec',
      'tool_done',
      'turn_done',
    ])
    const input = seen.find((e) => e.k === 'tool_input')
    expect(input && input.k === 'tool_input' && input.callId).toBe('')
    const start = seen.find((e) => e.k === 'tool_start')
    expect(start && start.k === 'tool_start' && start.callId).toBe('call-a')
  })

  it('background progress is carried with provenance:scraped and never as state (#16)', async () => {
    const adapter = new MockExecutor()
    const { session } = await newSession(adapter)
    const events = session.events()
    adapter.script(session, {
      ack: true,
      steps: [
        { k: 'background', taskId: 'bg-1', label: 'indexing', percent: 40 },
        { k: 'turn_done' },
      ],
    })
    await session.submit({ text: 'go', awaitAckMs: 50 }, fence(session))
    const seen = await collect(events, (e) => e.k === 'turn_done')
    const background = seen.find((e) => e.k === 'background')
    expect(background && background.k === 'background' && background.provenance).toBe('scraped')
  })

  it('two concurrent tools keep distinct ids on start/done even with empty-id input deltas', async () => {
    const adapter = new MockExecutor()
    const { session } = await newSession(adapter)
    const events = session.events()
    adapter.script(session, {
      ack: true,
      steps: [
        { k: 'tool', callId: 'call-a', name: 'bash', input: 'a' },
        { k: 'tool', callId: 'call-b', name: 'read', input: 'b' },
        { k: 'turn_done' },
      ],
    })
    await session.submit({ text: 'go', awaitAckMs: 50 }, fence(session))
    const seen = await collect(events, (e) => e.k === 'turn_done')
    const starts = seen.filter((e) => e.k === 'tool_start')
    expect(starts.map((e) => (e.k === 'tool_start' ? e.callId : ''))).toEqual(['call-a', 'call-b'])
    const inputs = seen.filter((e) => e.k === 'tool_input')
    expect(inputs.every((e) => e.k === 'tool_input' && e.callId === '')).toBe(true)
  })

  it('a second submit while a turn is in flight is refused (one writer, one turn)', async () => {
    const adapter = new MockExecutor()
    const { session } = await newSession(adapter)
    adapter.script(session, { ack: true, steps: [{ k: 'text', text: 'still going' }] })
    await session.submit({ text: 'first', awaitAckMs: 50 }, fence(session))
    await expect(
      session.submit({ text: 'second', awaitAckMs: 50 }, fence(session)),
    ).rejects.toThrow(SwarmError)
  })

  it('setCredential refuses a key with surrounding whitespace or a newline ([F17])', async () => {
    const adapter = new MockExecutor()
    const { instance } = await newSession(adapter)
    await expect(instance.setCredential('claude-api', ' sk-x ')).rejects.toThrow(/invalid_request/)
    await expect(instance.setCredential('claude-api', 'sk-x\n')).rejects.toThrow(/invalid_request/)
    await expect(instance.setCredential('claude-api', 'sk-x')).resolves.toBeUndefined()
  })

  it('hardKill reports daemonStopped:false when it cannot resolve a daemon pid ([F1])', async () => {
    const adapter = new MockExecutor({ daemonPid: null })
    const { instance } = await newSession(adapter)
    const outcome = await instance.hardKill('panic')
    expect(outcome.daemonPid).toBeNull()
    expect(outcome.daemonStopped).toBe(false)
  })

  it('hardKill without a pgid refuses capability_absent rather than guessing a target (§4.3.7)', async () => {
    const adapter = new MockExecutor({ pgid: null })
    const { instance } = await newSession(adapter)
    await expect(instance.hardKill('panic')).rejects.toThrow(SwarmError)
    await instance.hardKill('panic').catch((error: unknown) => {
      expect(SwarmError.is(error, 'capability_absent')).toBe(true)
    })
  })

  it('the event stream is drained without the server ever awaiting head IO (X7)', async () => {
    const adapter = new MockExecutor()
    const { session } = await newSession(adapter)
    /* No consumer at all while the turn plays: the ack must still be observed. */
    adapter.script(session, { ack: true, steps: [{ k: 'text', text: 'x' }, { k: 'turn_done' }] })
    const receipt = await session.submit({ text: 'go', awaitAckMs: 50 }, fence(session))
    expect(receipt.ack).toBe('accepted')
  })
})
