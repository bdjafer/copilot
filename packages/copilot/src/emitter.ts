import type {
  CopilotEvent,
  CopilotEventMap,
  CopilotEventName,
  ErrorScope,
  ToolDefinition,
  Unsubscribe,
} from './types.ts'

// SPEC-copilot §3.3.10 — synchronous, snapshot-ordered emission. Run-scoped listeners fire
// before global ones; the `*` firehose receives each event after its typed listeners. A throwing
// listener produces one `error` event with scope 'listener' and stays subscribed (§3.4).
import { CopilotError, messageOf } from './errors.ts'

type AnyListener = (payload: never) => void
type AnyEvent = CopilotEvent<readonly ToolDefinition[], unknown>

interface Entry {
  listener: AnyListener
  runId?: string
  once?: boolean
}

export interface EmitterOptions {
  instanceId: string
  now: () => Date
  onError?: (error: CopilotError, scope: ErrorScope) => void
}

export interface Emitter<TTools extends readonly ToolDefinition[], TContext> {
  on<E extends CopilotEventName>(
    event: E,
    listener: (payload: CopilotEventMap<TTools, TContext>[E]) => void,
    options?: { once?: boolean; signal?: AbortSignal; runId?: string },
  ): Unsubscribe
  once<E extends CopilotEventName>(
    event: E,
    listener: (payload: CopilotEventMap<TTools, TContext>[E]) => void,
  ): Unsubscribe
  off<E extends CopilotEventName>(
    event: E,
    listener: (payload: CopilotEventMap<TTools, TContext>[E]) => void,
  ): void
  subscribe(listener: (event: CopilotEvent<TTools, TContext>) => void): Unsubscribe
  emit<E extends CopilotEventName>(
    event: E,
    runId: string | null,
    payload: CopilotEventMap<TTools, TContext>[E],
  ): void
  emitError(error: CopilotError, scope: ErrorScope, runId?: string): void
  counts(): Record<CopilotEventName | '*', number>
  /** Number of listeners bound to a specific run (any event). Drives attach() poll shutdown. */
  runListenerCount(runId: string): number
  clear(): void
}

const EVENT_NAMES: readonly CopilotEventName[] = [
  'run:queued',
  'run:start',
  'run:step',
  'run:token',
  'run:done',
  'run:error',
  'run:cancelled',
  'run:settled',
  'tool:call',
  'tool:result',
  'runtime:active',
  'runtime:idle',
  'error',
]

export function createEmitter<TTools extends readonly ToolDefinition[], TContext>(
  options: EmitterOptions,
): Emitter<TTools, TContext> {
  const typed = new Map<CopilotEventName, Entry[]>()
  const firehose: Array<(event: CopilotEvent<TTools, TContext>) => void> = []
  const seqs = new Map<string, number>()
  let depth = 0

  const listeners = (event: CopilotEventName): Entry[] => {
    let list = typed.get(event)
    if (list === undefined) {
      list = []
      typed.set(event, list)
    }
    return list
  }

  const remove = (event: CopilotEventName, entry: Entry) => {
    const list = typed.get(event)
    if (list === undefined) return
    const at = list.indexOf(entry)
    if (at >= 0) list.splice(at, 1)
  }

  const emit: Emitter<TTools, TContext>['emit'] = (event, runId, payload) => {
    const key = runId ?? ''
    const seq = (seqs.get(key) ?? 0) + 1
    seqs.set(key, seq)

    const envelope = {
      type: event,
      runId,
      seq,
      instanceId: options.instanceId,
      at: options.now().getTime(),
      payload,
    } as AnyEvent

    const snapshot = [...(typed.get(event) ?? [])]
    // Run-scoped listeners fire before global ones for the same event (§3.3.10).
    const ordered = [
      ...snapshot.filter((entry) => entry.runId !== undefined && entry.runId === runId),
      ...snapshot.filter((entry) => entry.runId === undefined),
    ]
    const failures: unknown[] = []

    depth += 1
    try {
      for (const entry of ordered) {
        if (entry.once === true) remove(event, entry)
        try {
          ;(entry.listener as (value: unknown) => void)(payload)
        } catch (error) {
          failures.push(error)
        }
      }
      // oxlint-disable-next-line no-useless-spread -- snapshot: a listener may unsubscribe
      for (const listener of [...firehose]) {
        try {
          listener(envelope as unknown as CopilotEvent<TTools, TContext>)
        } catch (error) {
          failures.push(error)
        }
      }
    } finally {
      depth -= 1
    }

    if (event === 'error') {
      const errorPayload = payload as CopilotEventMap<TTools, TContext>['error']
      try {
        options.onError?.(errorPayload.error, errorPayload.scope)
      } catch {
        /* a throwing onError is the end of the line */
      }
      // `error` never re-emits itself: a listener that throws while handling `error` goes to
      // options.onError, then console.error (§3.4).
      for (const failure of failures) {
        const wrapped = new CopilotError('invalid_options', messageOf(failure), { cause: failure })
        try {
          options.onError?.(wrapped, 'listener')
        } catch {
          /* ignore */
        }
        // oxlint-disable-next-line no-console
        console.error('[copilot] listener threw while handling `error`:', failure)
      }
      return
    }

    for (const failure of failures) {
      emit('error', runId, {
        error:
          failure instanceof CopilotError
            ? failure
            : new CopilotError('invalid_options', messageOf(failure), { cause: failure }),
        scope: 'listener',
        ...(runId === null ? {} : { runId }),
      } as CopilotEventMap<TTools, TContext>['error'])
    }
  }

  return {
    on(event, listener, opts) {
      const entry: Entry = { listener: listener as AnyListener }
      if (opts?.runId !== undefined) entry.runId = opts.runId
      if (opts?.once === true) entry.once = true
      listeners(event).push(entry)
      const unsubscribe = () => remove(event, entry)
      if (opts?.signal !== undefined) {
        if (opts.signal.aborted) {
          unsubscribe()
        } else {
          opts.signal.addEventListener('abort', unsubscribe, { once: true })
        }
      }
      return unsubscribe
    },
    once(event, listener) {
      return this.on(event, listener, { once: true })
    },
    off(event, listener) {
      const list = typed.get(event)
      if (list === undefined) return
      // `off` is the counterpart of the global `on(event, listener)` — it has no `runId` (§2.6),
      // so it must not silently unbind a run-scoped registration (`handle.on`) that happens to
      // share the function object. Only when no global registration exists does it fall back to
      // removing the first match, so `off` still undoes whatever `on` did.
      const global = list.findIndex(
        (entry) => entry.runId === undefined && entry.listener === (listener as AnyListener),
      )
      const at =
        global >= 0
          ? global
          : list.findIndex((entry) => entry.listener === (listener as AnyListener))
      if (at >= 0) list.splice(at, 1)
    },
    subscribe(listener) {
      firehose.push(listener)
      return () => {
        const at = firehose.indexOf(listener)
        if (at >= 0) firehose.splice(at, 1)
      }
    },
    emit,
    emitError(error, scope, runId) {
      emit('error', runId ?? null, {
        error,
        scope,
        ...(runId === undefined ? {} : { runId }),
      } as CopilotEventMap<TTools, TContext>['error'])
    },
    counts() {
      const result = { '*': firehose.length } as Record<CopilotEventName | '*', number>
      for (const name of EVENT_NAMES) result[name] = typed.get(name)?.length ?? 0
      return result
    },
    runListenerCount(runId) {
      let total = 0
      for (const list of typed.values()) {
        for (const entry of list) if (entry.runId === runId) total += 1
      }
      return total
    },
    clear() {
      typed.clear()
      firehose.length = 0
      if (depth !== 0) depth = 0
    },
  }
}
