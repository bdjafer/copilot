/**
 * `MockExecutor` wired as an `ExecutorHarness`, so `executorConformance()` can run against it in
 * any capability configuration with one line at the call site.
 *
 * The translation from the suite's backend-neutral `ConformanceTurn` to a `MockTurnScript` lives
 * here rather than in the suite: the suite must stay expressible against the jcode adapter over
 * `fakeJcodeTransport()`, and a suite that spoke `MockStep` would only ever test the mock.
 *
 * DOM-free and Node-free.
 */

import type { ExecutorSessionHandle } from '../server/executor/types.ts'
import type { ConformanceTurn, ExecutorHarness } from './executor-conformance.ts'

import {
  MockExecutor,
  mockInstanceOptions,
  type MockExecutorOptions,
  type MockStep,
  type MockTurnScript,
} from './mock-executor.ts'

export function toMockScript(turn: ConformanceTurn): MockTurnScript {
  const steps: MockStep[] = []
  if (turn.text !== undefined) steps.push({ k: 'text', text: turn.text })
  for (const tool of turn.tools ?? []) {
    steps.push({
      k: 'tool',
      callId: tool.callId,
      name: tool.name,
      ...(tool.input === undefined ? {} : { input: tool.input }),
    })
  }
  if (turn.usage === true) steps.push({ k: 'usage', input: 10, output: 20 })
  if (turn.disconnectMidTurn === true) steps.push({ k: 'disconnect' })
  else if (turn.turnDone !== false) steps.push({ k: 'turn_done' })
  return { ack: turn.ack, steps }
}

export function mockExecutorHarness(options: MockExecutorOptions = {}): ExecutorHarness {
  const adapter = new MockExecutor(options)
  return {
    adapter,
    instanceKey: 'mock/default',
    instanceOptions: mockInstanceOptions(),
    scriptTurn(session: ExecutorSessionHandle, turn: ConformanceTurn) {
      adapter.script(session, toMockScript(turn))
    },
    disconnect(session: ExecutorSessionHandle) {
      adapter.disconnect(session)
    },
    /**
     * Deliberately resolved through `this.adapter`, not the one closed over above.
     *
     * `test/executor-mock.test.ts` builds a lying harness as `{ ...honest, adapter: lying }`, so a
     * `quiesce` bound to the honest adapter would drain an adapter that owns no sessions and
     * return instantly — a barrier that barriers nothing, which is worse than the wall-clock
     * window it replaced because it looks deterministic.
     */
    quiesce(this: { readonly adapter: { quiesce?: () => Promise<void> } }) {
      return this.adapter.quiesce?.() ?? Promise.resolve()
    },
    dispose() {
      /* Nothing to release: the mock owns no process, no socket and no file. */
    },
  }
}
