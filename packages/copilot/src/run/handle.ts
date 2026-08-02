// SPEC-copilot §2.6 — `RunHandle`: a view over a durable record. `result()` never rejects,
// `tokens()` is best-effort and ends at the terminal event, `on()` is run-scoped and fires before
// global listeners for the same event.
import type { Emitter } from '../emitter.ts'
import type { Writable } from '../readable.ts'
import type {
  CopilotEventMap,
  CopilotEventName,
  Run,
  RunHandle,
  RunResult,
  ToolDefinition,
  Unsubscribe,
} from '../types.ts'

export interface TokenSink {
  push(delta: string): void
  end(): void
}

/** Per-run state shared by every handle onto the same run. */
export interface RunSlot<TContext> {
  readonly id: string
  record: Run<TContext> | null
  readonly store: Writable<Run<TContext> | null>
  deduped: boolean
  settled: boolean
  result: RunResult<TContext> | null
  readonly waiters: Array<(result: RunResult<TContext>) => void>
  readonly tokenSinks: Set<TokenSink>
  /** Foreign runs are polled; a handle that nobody waits on never starts the poll (§2.6). */
  ensurePolling(): void
}

export function createRunHandle<TTools extends readonly ToolDefinition[], TContext>(deps: {
  slot: RunSlot<TContext>
  emitter: Emitter<TTools, TContext>
  cancel: (runId: string, reason?: string) => Promise<boolean>
  /**
   * Fixed answer for a handle whose dedupe status is known at construction (a second `trigger`
   * or an `attach` onto a live slot). Omitted for the handle that issued the work: its answer is
   * the slot flag, which the initial store lookup sets only when the run already existed.
   */
  deduped?: boolean
}): RunHandle<TTools, TContext> {
  const { slot, emitter } = deps

  return {
    id: slot.id,
    get deduped() {
      return deps.deduped ?? slot.deduped
    },
    run: {
      get: () => slot.store.get(),
      subscribe: (listener) => {
        slot.ensurePolling()
        return slot.store.subscribe(listener)
      },
    },
    result(): Promise<RunResult<TContext>> {
      slot.ensurePolling()
      if (slot.settled && slot.result !== null) return Promise.resolve(slot.result)
      return new Promise<RunResult<TContext>>((resolve) => {
        slot.waiters.push(resolve)
      })
    },
    cancel(reason) {
      return deps.cancel(slot.id, reason)
    },
    on<E extends CopilotEventName>(
      event: E,
      listener: (payload: CopilotEventMap<TTools, TContext>[E]) => void,
    ): Unsubscribe {
      slot.ensurePolling()
      return emitter.on(event, listener, { runId: slot.id })
    },
    tokens(): AsyncIterable<string> {
      slot.ensurePolling()
      const buffer: string[] = []
      let finished = slot.settled
      let wake: (() => void) | null = null
      const sink: TokenSink = {
        push(delta) {
          buffer.push(delta)
          wake?.()
        },
        end() {
          finished = true
          wake?.()
        },
      }
      slot.tokenSinks.add(sink)

      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (;;) {
              const next = buffer.shift()
              if (next !== undefined) {
                yield next
                continue
              }
              if (finished) return
              await new Promise<void>((resolve) => {
                wake = resolve
              })
              wake = null
            }
          } finally {
            slot.tokenSinks.delete(sink)
          }
        },
      }
    },
  }
}
