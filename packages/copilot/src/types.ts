// SPEC-copilot §2 — the public type surface. Zero logic lives here.
import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { LanguageModel } from 'ai'

import type { CopilotError, CopilotErrorCode } from './errors.ts'

export type { StandardSchemaV1 }
export type { CopilotErrorCode }

/* ------------------------------------------------------------------ */
/* §2.1 primitives                                                     */
/* ------------------------------------------------------------------ */

export type Unsubscribe = () => void
export type Awaitable<T> = T | Promise<T>

/** Same contract as comment-core's, deliberately re-declared: the packages never import each other. */
export interface ReadableStore<T> {
  get(): T
  subscribe(listener: (value: T, previous: T) => void): Unsubscribe
}

/** AI SDK model instance, injected by the host. Never constructed here. */
export type LanguageModelLike = LanguageModel

/** The object-shaped member of the AI SDK's model union that this package implements/wraps. */
export type ModelV3 = Extract<LanguageModelLike, { specificationVersion: 'v3' }>

export interface Usage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

/* ------------------------------------------------------------------ */
/* §2.2 the Run record — PLAN §4.2's nine fields + the `spec` snapshot */
/* ------------------------------------------------------------------ */

export type RunContext<TContext> = unknown extends TContext
  ? { context?: TContext }
  : { context: TContext }

export type Run<TContext = unknown> = RunRecord<TContext> & RunContext<TContext>

/**
 * §2.2 — a JSON snapshot of the per-run overrides in `TriggerInput`. Every member is optional and
 * an absent member means "the processing instance's own default", so a run triggered without
 * overrides carries no `spec` at all.
 */
export interface RunSpec {
  /**
   * A KEY of `CopilotOptions.models` — never a model instance, which is not serialisable. An
   * inline `LanguageModelLike` therefore records nothing and a cross-process replay of that run
   * uses the primary `provider`.
   */
  model?: string
  /** The per-run tool subset, by name, exactly as `TriggerInput.tools` gave it (`[]` included). */
  tools?: readonly string[]
  maxSteps?: number
}

interface RunRecordFields {
  id: string
  state: 'queued' | 'processing' | 'done' | 'error' | 'cancelled'
  input: string
  /** Set on done. */
  output?: string
  /** Set on error; retry is a new run, never a mutation of this one. */
  error?: string
  attempts: number
  /** ISO. Bumped at every step, by the ticker while processing, and while queued in a live queue. */
  heartbeat: string
  createdAt: string
  /**
   * §2.2 — the replay snapshot. Written once, at trigger time, only when the trigger supplied at
   * least one of `model` / `tools` / `maxSteps`; never mutated afterwards and never written by a
   * resume. It is what makes a restart in a FRESH process a replay of the same run rather than a
   * different run wearing the same `runId`.
   */
  spec?: RunSpec
}

/**
 * The nine non-context fields. `context` is contributed by `RunContext<TContext>` alone, so
 * `Run<T>` is exactly PLAN §4.2's nine fields plus `spec`, and `RunRecord<Ctx>` never weakens the
 * §2.2 device that makes `run.context` required once `TContext` is concrete.
 *
 * `TContext` is phantom here — `Record<never, TContext>` is `{}`, so it adds no field — but the
 * parameter is part of the locked §2.2 signature and stays.
 */
export type RunRecord<TContext = unknown> = RunRecordFields & Record<never, TContext>

export type RunState = Run['state']

/* ------------------------------------------------------------------ */
/* §2.4 tools                                                          */
/* ------------------------------------------------------------------ */

export interface ToolDefinition<
  TName extends string = string,
  // eslint-disable-next-line no-explicit-any -- locked signature (§2.4)
  TInput = any,
  // eslint-disable-next-line no-explicit-any -- locked signature (§2.4)
  TOutput = any,
  TContext = unknown,
> {
  name: TName
  description: string
  inputSchema: StandardSchemaV1<unknown, TInput>
  outputSchema?: StandardSchemaV1<unknown, TOutput>
  execute(input: TInput, ctx: ToolContext<TContext>): Awaitable<TOutput>
  /** Per-call wall clock. Default 30_000. A dead transport must never hang a run forever. */
  timeoutMs?: number
}

export interface ToolContext<TContext = unknown> {
  runId: string
  /** 1-based loop step this call belongs to. */
  step: number
  /** 1-based run attempt. */
  attempt: number
  /** Aborted on cancel, run timeout, or destroy(). Tools MUST honour it. */
  signal: AbortSignal
  /** The trigger's opaque context payload, verbatim. Never interpreted by the runtime. */
  context: TContext
}

/** The ONLY thing standing between `copilot` and a messaging layer. One method. */
export interface ToolTransport<TContext = unknown> {
  call(
    name: string,
    input: unknown,
    ctx: {
      runId: string
      step: number
      attempt: number
      signal: AbortSignal
      context: TContext
    },
  ): Promise<unknown>
}

export interface ToolRegistry<TTools extends readonly ToolDefinition[]> {
  readonly names: readonly TTools[number]['name'][]
  get<N extends TTools[number]['name']>(name: N): Extract<TTools[number], { name: N }> | null
  has(name: string): boolean
  /** JSON Schema for the tool's input, derived from the Standard Schema. */
  schema(name: TTools[number]['name']): unknown
}

/* ------------------------------------------------------------------ */
/* §2.7 run store                                                      */
/* ------------------------------------------------------------------ */

export interface RunStore<TContext = unknown> {
  get(id: string): Promise<Run<TContext> | null>
  put(run: Run<TContext>): Promise<void>
  list(filter?: RunFilter): Promise<Run<TContext>[]>

  /* --- optional --- */
  /** Human-readable name for inspect(). Default: 'anonymous'. */
  readonly name?: string
  /** Multi-context resume safety. Returns false when another owner holds a fresh lease. */
  claim?(id: string, owner: string, ttlMs: number): Promise<boolean>
}

/** Same KeyValueAdapter shape as comment-core's, deliberately re-declared. */
export interface KeyValueAdapter {
  get(keys: readonly string[]): Promise<Record<string, unknown>>
  set(entries: Record<string, unknown>): Promise<void>
  remove(keys: readonly string[]): Promise<void>
  keys(prefix: string): Promise<string[]>
  watch?(cb: (changedKeys: string[]) => void): Unsubscribe
}

export interface RunFilter {
  state?: RunState | readonly RunState[]
  /** Run-id prefix. Adapters may implement it as a key-range scan. */
  idPrefix?: string
  /** ISO; createdAt < before. */
  before?: string
  limit?: number
}

export interface ResumeReport {
  scanned: number
  /** Run ids restarted. */
  restarted: readonly string[]
  /** Run ids that hit MAX_ATTEMPTS and were terminated with `max_attempts`. */
  failed: readonly string[]
  /** Claimed elsewhere, heartbeat still fresh, or already present in this instance's queue. */
  skipped: number
}

/* ------------------------------------------------------------------ */
/* §2.5 construction                                                   */
/* ------------------------------------------------------------------ */

export interface CopilotOptions<
  TTools extends readonly ToolDefinition[] = readonly [],
  TContext = unknown,
> {
  /** Required. There is no default brain. Throws `no_provider` when absent. */
  provider: LanguageModelLike
  /** Named alternates, selectable per run via `TriggerInput.model`. */
  models?: Record<string, LanguageModelLike>
  systemPrompt?: string | ((run: Run<TContext>) => Awaitable<string>)
  /** Host-registered. The runtime ships none. */
  tools?: TTools
  /** Default: createMemoryRunStore(). */
  runStore?: RunStore<TContext>
  /** context → prompt text. Default: JSON.stringify(context, null, 2). */
  renderContext?: (context: TContext, run: Run<TContext>) => Awaitable<string>
  /** Tool-loop cap. Default 8. */
  maxSteps?: number
  /** Concurrent processing runs. Default 1. */
  concurrency?: number
  /** Wall clock per attempt, ms. Default 240_000. */
  timeoutMs?: number
  /** Receives every `error` event, including ones thrown by `error` listeners. */
  onError?: (error: CopilotError, scope: ErrorScope) => void
  now?: () => Date
  /** Default: nanoid(12). */
  createId?: () => string
}

/* ------------------------------------------------------------------ */
/* §2.6 the runtime surface                                            */
/* ------------------------------------------------------------------ */

export interface TriggerInput<
  TTools extends readonly ToolDefinition[] = readonly [],
  TContext = unknown,
> {
  input: string
  /** Opaque. Reaches the prompt only via renderContext, and tools via ToolContext.context. */
  context?: TContext
  /** Idempotency key. A run with this id already in the store ⇒ handle onto it, no new work. */
  runId?: string
  /**
   * A key of `models`, or a model instance. Unknown key ⇒ `unknown_model` thrown sync. A key is
   * snapshotted into `run.spec.model` and survives a restart; an inline instance is not
   * serialisable and does not (§2.2).
   */
  model?: string | LanguageModelLike
  /** Per-run system prompt override. NOT snapshotted — a resumed attempt uses `systemPrompt`. */
  system?: string
  /** Per-run tool subset, by name. Omit for all registered tools. Snapshotted into `run.spec`. */
  tools?: readonly TTools[number]['name'][]
  /** Snapshotted into `run.spec`. */
  maxSteps?: number
  /** Cancels this run when aborted. */
  signal?: AbortSignal
}

export interface RunHandle<
  TTools extends readonly ToolDefinition[] = readonly [],
  TContext = unknown,
> {
  readonly id: string
  /** True when `runId` matched an existing run and no new work was started. */
  readonly deduped: boolean
  /** Live record view; null until the initial durable write lands (one microtask). */
  readonly run: ReadableStore<Run<TContext> | null>
  /** Resolves when the run reaches a terminal state. NEVER rejects for run failure. */
  result(): Promise<RunResult<TContext>>
  cancel(reason?: string): Promise<boolean>
  /** Run-scoped listener. Fires before global listeners for the same event. */
  on<E extends CopilotEventName>(
    event: E,
    listener: (payload: CopilotEventMap<TTools, TContext>[E]) => void,
  ): Unsubscribe
  /** Best-effort token stream. Ends at the terminal event. May yield nothing. */
  tokens(): AsyncIterable<string>
}

export type RunResult<TContext = unknown> =
  | {
      ok: true
      runId: string
      output: string
      steps: number
      usage: Usage
      run: Run<TContext>
      /** True when this run was restarted at least once. */
      restarted: boolean
    }
  | {
      ok: false
      runId: string
      reason: 'error' | 'cancelled'
      error: CopilotError | null
      run: Run<TContext>
      restarted: boolean
    }

export interface Copilot<
  TTools extends readonly ToolDefinition[] = readonly [],
  TContext = unknown,
> {
  /** Synchronous. Returns a view over a durable record, not a promise over a computation. */
  trigger(input: TriggerInput<TTools, TContext>): RunHandle<TTools, TContext>
  /** Re-attach to a run this process did not start. Foreign runs are polled. */
  attach(runId: string): RunHandle<TTools, TContext>
  /** True when a run existed and was queued/processing. Never throws. */
  cancel(runId: string, reason?: string): Promise<boolean>
  /** Cancel every queued/processing run whose id starts with `prefix`. */
  cancelByPrefix(prefix: string, reason?: string): Promise<readonly string[]>
  /** Host calls on wake / alarm. Restarts runs with stale heartbeats. Idempotent. */
  resumePending(options?: { staleAfterMs?: number; limit?: number }): Promise<ResumeReport>

  get(runId: string): Promise<Run<TContext> | null>
  list(filter?: RunFilter): Promise<Run<TContext>[]>
  /** Live in-process view: runs this instance has touched. Sorted by createdAt ascending. */
  readonly runs: ReadableStore<readonly Run<TContext>[]>
  readonly tools: ToolRegistry<TTools>

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
  /** The `*` firehose. Receives each event AFTER its typed listeners. */
  subscribe(listener: (event: CopilotEvent<TTools, TContext>) => void): Unsubscribe

  /** Serializable snapshot for the options page and devtools. */
  inspect(): CopilotInspection
  /** Aborts in-flight attempts, drops listeners, settles every outstanding result(). */
  destroy(): Promise<void>
}

/* ------------------------------------------------------------------ */
/* §2.8 events                                                         */
/* ------------------------------------------------------------------ */

export interface CopilotEventMap<
  TTools extends readonly ToolDefinition[] = readonly [],
  TContext = unknown,
> {
  'run:queued': { runId: string; run: Run<TContext> }
  'run:start': {
    runId: string
    run: Run<TContext>
    attempt: number
    resumed: boolean
    model: string
  }
  'run:step': {
    runId: string
    run: Run<TContext>
    step: number
    text: string
    calls: readonly ToolCall<TTools>[]
    usage: Usage
    finishReason: string
  }
  'run:token': { runId: string; delta: string; step: number }
  'run:done': {
    runId: string
    run: Run<TContext>
    output: string
    steps: number
    usage: Usage
    durationMs: number
  }
  'run:error': {
    runId: string
    run: Run<TContext>
    error: CopilotError
    attempt: number
    /** true ⇒ NOT terminal; a fresh `run:start` follows. */
    willRetry: boolean
  }
  'run:cancelled': {
    runId: string
    run: Run<TContext>
    reason: string | null
    at: 'queued' | 'processing'
  }
  /** Convenience terminal: exactly one per run, after done | error(final) | cancelled. */
  'run:settled': { runId: string; run: Run<TContext>; result: RunResult<TContext> }
  'tool:call': { runId: string; step: number; name: TTools[number]['name']; input: unknown }
  'tool:result': { runId: string; step: number; call: ToolCall<TTools>; durationMs: number }
  /** 0→1 active-run edge. Leading, undelayed. */
  'runtime:active': { activeRuns: number }
  /** 1→0 active-run edge. Trailing-debounced 500 ms. */
  'runtime:idle': { activeRuns: 0 }
  error: { error: CopilotError; scope: ErrorScope; runId?: string }
}

export type ErrorScope = 'provider' | 'tool' | 'store' | 'listener' | 'transport' | 'context'

/** The payoff of `const TTools`: a discriminated union keyed on your literal tool names. */
export type ToolCall<TTools extends readonly ToolDefinition[]> = {
  [K in TTools[number] as K['name']]:
    | { name: K['name']; ok: true; input: ToolInputOf<K>; output: ToolOutputOf<K> }
    | { name: K['name']; ok: false; input: ToolInputOf<K>; error: CopilotError }
}[TTools[number]['name']]

// eslint-disable-next-line no-explicit-any -- structural extraction over the locked signature
export type ToolInputOf<T> = T extends ToolDefinition<any, infer I, any, any> ? I : never
// eslint-disable-next-line no-explicit-any -- structural extraction over the locked signature
export type ToolOutputOf<T> = T extends ToolDefinition<any, any, infer O, any> ? O : never
// eslint-disable-next-line no-explicit-any -- structural extraction over the locked signature
export type ToolNameOf<C> = C extends Copilot<infer T, any> ? T[number]['name'] : never
// eslint-disable-next-line no-explicit-any -- structural extraction over the locked signature
export type ContextOf<C> = C extends Copilot<any, infer X> ? X : never

// eslint-disable-next-line no-explicit-any -- key extraction over the event map
export type CopilotEventName = keyof CopilotEventMap<any, any>

export type CopilotEvent<
  // eslint-disable-next-line no-explicit-any -- the firehose is intentionally loose
  TTools extends readonly ToolDefinition[] = any,
  // eslint-disable-next-line no-explicit-any -- the firehose is intentionally loose
  TContext = any,
> = {
  [K in CopilotEventName]: {
    type: K
    /** null only for runtime:active / runtime:idle. */
    runId: string | null
    /** Monotonic per run, per emitting instance, across that instance's attempts. */
    seq: number
    /** Stable id of the emitting runtime instance, `nanoid(8)` at construction. */
    instanceId: string
    at: number
    payload: CopilotEventMap<TTools, TContext>[K]
  }
}[CopilotEventName]

/* ------------------------------------------------------------------ */
/* §2.10 introspection                                                 */
/* ------------------------------------------------------------------ */

export interface CopilotInspection {
  version: string
  provider: { models: string[]; default: string | null }
  tools: Array<{
    name: string
    description: string
    schema: unknown
    calls: number
    errors: number
    avgMs: number
  }>
  runs: Record<RunState, number>
  config: { maxSteps: number; concurrency: number; timeoutMs: number; maxAttempts: 3 }
  listeners: Record<CopilotEventName | '*', number>
  store: { name: string; lastError: string | null }
}
