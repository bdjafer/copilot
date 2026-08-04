/**
 * The scripted three-attempt run (SPEC-swarm §10, release gate 10).
 *
 * Drives `MockExecutor` through the scenario next door and reports what each attempt actually
 * did, so the demo is a *run* rather than a slideshow: the `unknown` receipt in attempt 2 is
 * produced by the same ack-observation code the jcode adapter uses ([F2]), not asserted by a
 * narrator. A demo that fakes its own output is worth less than no demo, because it teaches the
 * user something that will not be true when they point swarm at real work.
 *
 * DOM-free and Node-free.
 */

import type { ExecutorSessionHandle } from '../../server/executor/types.ts'
import type { Fence } from '../../types.ts'
import type { DemoAttempt } from './scenario.ts'

import { sessionLease } from '../../domain/leases.ts'
import { MockExecutor, mockInstanceOptions } from '../mock-executor.ts'
import { toMockScript } from '../mock-harness.ts'
import { DEMO_ATTEMPTS, DEMO_OBJECTIVE } from './scenario.ts'

export interface DemoRunOptions {
  /** How long each submission waits for its acknowledgement (V5). */
  readonly awaitAckMs?: number
  /** Injected so a demo can run under fake timers. */
  readonly sleep?: (ms: number) => Promise<void>
}

export interface DemoAttemptResult {
  readonly index: number
  readonly summary: string
  /** What the executor actually reported, not what the scenario predicted. */
  readonly ack: 'accepted' | 'unknown'
  /** Whether a `turn_done` was observed before the stream went quiet. */
  readonly turnCompleted: boolean
  readonly expectedOutcome: DemoAttempt['outcome']
  readonly explanation: string
}

/**
 * Play all three attempts and report each one.
 *
 * The caller supplies no adapter: the point is that the demo cannot accidentally reach a real
 * backend. A `MockExecutor` with the **jcode capability row** (its default) is used, so what the
 * demo shows is the shape of the real backend rather than a friendlier fiction.
 */
export async function runDemoAttempts(
  options: DemoRunOptions = {},
): Promise<readonly DemoAttemptResult[]> {
  const adapter = new MockExecutor({
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
  })
  const instance = await adapter.acquireInstance('demo/mock', mockInstanceOptions())
  const results: DemoAttemptResult[] = []

  try {
    for (const attempt of DEMO_ATTEMPTS) {
      /* A fresh session per attempt: attempts are independent by construction (§3.3), and a demo
       * that reused one would quietly show the opposite. */
      const session = await instance.createSession({
        workingDir: `/demo/attempt-${attempt.index}`,
        title: `${DEMO_OBJECTIVE} (attempt ${attempt.index})`,
      })
      const fence: Fence = { key: sessionLease(session.sessionId), token: attempt.index }

      let ack: 'accepted' | 'unknown' = 'unknown'
      let turnCompleted = false
      const quiet = (): Promise<'quiet'> =>
        (options.sleep ?? defaultSleep)(options.awaitAckMs ?? 40).then(() => 'quiet' as const)

      for (const turn of attempt.turns) {
        adapter.script(session, toMockScript(turn))
        const events = session.events()
        const receipt = await session.submit(
          { text: DEMO_OBJECTIVE, awaitAckMs: options.awaitAckMs ?? 40 },
          fence,
        )
        ack = receipt.ack === 'accepted' ? 'accepted' : 'unknown'
        /* Bounded. Attempt 2 is the turn that never completes — no ack, no `turn_done`, and the
         * stream stays open because nothing has gone wrong with it. An unbounded drain there
         * would hang the demo on exactly the case the demo is trying to show. */
        turnCompleted = await drainToTurnDone(events, quiet)
      }

      results.push({
        index: attempt.index,
        summary: attempt.summary,
        ack,
        turnCompleted,
        expectedOutcome: attempt.outcome,
        explanation: attempt.explanation,
      })
      await session.close('demo attempt finished')
    }
  } finally {
    await instance.dispose('demo finished')
  }

  return results
}

/**
 * Drain until `turn_done`, the stream ends, or the stream simply goes quiet.
 *
 * The third case is the one that matters: a turn that never completes leaves an open stream with
 * nothing on it, so "no `turn_done`" cannot be detected by reading — only by reading *and* giving
 * up. Which is the same shape as V5's `awaitAckMs`, for the same reason.
 */
async function drainToTurnDone(
  events: AsyncIterableIterator<{ readonly k: string }>,
  quiet: () => Promise<'quiet'>,
  max = 100,
): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    const next = await Promise.race([events.next(), quiet()])
    if (next === 'quiet') return false
    if (next.done === true) return false
    if (next.value.k === 'turn_done') return true
    if (next.value.k === 'closed') return false
  }
  return false
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/** Typed narrowly so the demo cannot depend on session internals. */
export type DemoSession = ExecutorSessionHandle
