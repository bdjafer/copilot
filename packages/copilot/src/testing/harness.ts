import type {
  Copilot,
  CopilotEvent,
  CopilotEventMap,
  CopilotEventName,
  CopilotOptions,
  RunStore,
  ToolDefinition,
  Unsubscribe,
} from '../types.ts'
import type { ScriptedStep } from './scripted-model.ts'

// SPEC-copilot §2.11 — `createTestCopilot`: an event recorder plus the only way to test PLAN
// §4.5's central claim — kill the runtime mid-run, revive it against the same store.
import { createCopilot } from '../copilot.ts'
import { createMemoryRunStore } from '../store/memory.ts'
import { scriptedModel } from './scripted-model.ts'

export interface TestCopilot<TTools extends readonly ToolDefinition[], TContext> {
  copilot: Copilot<TTools, TContext>
  runStore: RunStore<TContext>
  events: {
    all(): readonly CopilotEvent<TTools, TContext>[]
    of<E extends CopilotEventName>(e: E): CopilotEventMap<TTools, TContext>[E][]
    order(runId?: string): CopilotEventName[]
    waitFor<E extends CopilotEventName>(
      e: E,
      options?: { timeoutMs?: number; runId?: string },
    ): Promise<CopilotEventMap<TTools, TContext>[E]>
  }
  /** Simulates service-worker death: aborts everything without writing a terminal state. */
  kill(): Promise<void>
  /** New instance over the same store. Call resumePending() on it. */
  revive(): Copilot<TTools, TContext>
  dispose(): Promise<void>
}

export function createTestCopilot<
  const TTools extends readonly ToolDefinition[] = readonly [],
  TContext = unknown,
>(
  options?: Partial<CopilotOptions<TTools, TContext>> & { script?: ScriptedStep[] | string },
): TestCopilot<TTools, TContext> {
  const { script, ...rest } = options ?? {}
  const runStore = rest.runStore ?? createMemoryRunStore<TContext>()
  const recorded: CopilotEvent<TTools, TContext>[] = []
  const waiters: Array<(event: CopilotEvent<TTools, TContext>) => void> = []

  let unsubscribe: Unsubscribe | undefined

  const build = (): Copilot<TTools, TContext> => {
    // Built AT `TTools`, not asserted to it: `ToolCall<TTools>` narrowing inside a harness-based
    // test is only real if the instance's type comes from the tools that were registered.
    const instance = createCopilot<TTools, TContext>({
      ...rest,
      provider: rest.provider ?? scriptedModel(script),
      runStore,
    } as CopilotOptions<TTools, TContext>)
    unsubscribe = instance.subscribe((event) => {
      recorded.push(event)
      // oxlint-disable-next-line no-useless-spread -- snapshot: a waiter detaches itself
      for (const waiter of [...waiters]) waiter(event)
    })
    return instance
  }

  let current = build()

  const harness: TestCopilot<TTools, TContext> = {
    get copilot() {
      return current
    },
    runStore,
    events: {
      all: () => recorded,
      of(name) {
        return recorded
          .filter((event) => event.type === name)
          .map((event) => event.payload) as CopilotEventMap<TTools, TContext>[typeof name][]
      },
      order(runId) {
        return recorded
          .filter((event) => runId === undefined || event.runId === runId)
          .map((event) => event.type)
      },
      waitFor(name, waitOptions) {
        const matches = (event: CopilotEvent<TTools, TContext>) =>
          event.type === name &&
          (waitOptions?.runId === undefined || event.runId === waitOptions.runId)

        const seen = recorded.find(matches)
        if (seen !== undefined) {
          return Promise.resolve(seen.payload as CopilotEventMap<TTools, TContext>[typeof name])
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            detach()
            reject(new Error(`timed out waiting for ${name}`))
          }, waitOptions?.timeoutMs ?? 5_000)
          const waiter = (event: CopilotEvent<TTools, TContext>) => {
            if (!matches(event)) return
            detach()
            resolve(event.payload as CopilotEventMap<TTools, TContext>[typeof name])
          }
          const detach = () => {
            clearTimeout(timer)
            const at = waiters.indexOf(waiter)
            if (at >= 0) waiters.splice(at, 1)
          }
          waiters.push(waiter)
        })
      },
    },
    async kill() {
      unsubscribe?.()
      unsubscribe = undefined
      await current.destroy()
    },
    revive() {
      unsubscribe?.()
      current = build()
      return current
    },
    async dispose() {
      unsubscribe?.()
      unsubscribe = undefined
      await current.destroy()
    },
  }

  return harness
}
