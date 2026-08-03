# SPEC — `copilot` (LOCKED)

> **Status: LOCKED.** This document is the implementation contract. Every export, signature,
> default value, ordering rule and error path below is normative. Implementers must not make
> API decisions; if something appears underspecified, it is a spec bug — fix the spec, then
> the code. Converged from entropy+ proposals A (dx), B (minimal), C (capability) against
> `PLAN.md` v2. Decision log in §8.
>
> **Locked-by-PLAN invariants this spec never renegotiates:** the `Run` record — PLAN §4.2's nine
> fields, none removed, none reinterpreted, plus the one durable addition ruled in decision log
> #26 (the `spec` replay snapshot, §2.2);
> `createCopilot({ provider, systemPrompt, tools: ToolDefinition[], runStore })`
> (§4.1); `copilot.trigger({ input, context?, runId? })` returning a handle (§4.1);
> `copilot.cancel(runId)`; `copilot.resumePending()`; the event names
> `run:start | run:step | run:token | run:done | run:error | run:cancelled` (§4.1); `context`
> is opaque and reaches the prompt only through host-supplied `renderContext` (§4.1); output is
> an event, not a side effect (§4.1); runs are data, not promises (§4.2, §4.5); retry is a
> fresh run bounded by `attempts <= 3` (§4.5); the AI SDK (`ai` v6+) is the loop (§4.3);
> **zero imports of `comment-core`, zero references to `chrome.*` / `wxt/*` / DOM globals**
> (§2, §4.1).

---

## 1. Package, entry points, dependencies

| Subpath | Contents | DOM |
|---|---|---|
| `copilot` | `createCopilot`, tools, transports, run stores, errors, types | never |
| `copilot/testing` | scripted model, run-store conformance, kill/revive harness | never |

`copilot` is **DOM-free end to end**. It never touches `document`, `window`, `navigator`,
`localStorage` or `chrome` — not at module scope, not at runtime. DOM-bound tools reach a page
through `remoteTool` / `ToolTransport`; MV3 keepalive and alarms are host duties driven by two
events (§4.4). A CI test imports both entry points with those globals deleted.

Build: Vite lib mode, ESM + IIFE. IIFE global: `Copilot`. **The build also emits declarations**
(`tsgo -p tsconfig.build.json` → `dist/types/`), and `publishConfig.exports` must point every
subpath at files the build actually produces — a `types` condition naming a `.d.ts` that no build
step writes is a package that type-checks in the workspace and resolves to `any` everywhere else
(decision log #33).
Runtime deps: `ai` (v6+), `nanoid`. Provider packages (`@ai-sdk/anthropic`,
`@built-in-ai/core`), schema libraries (zod / valibot / arktype) and messaging are the host's
— they are peer-optional and never imported by this package.

---

## 2. Public TypeScript API

### 2.1 Primitives

```ts
export type Unsubscribe = () => void
export type Awaitable<T> = T | Promise<T>

/** Same contract as comment-core's, deliberately re-declared: the packages never import each other. */
export interface ReadableStore<T> {
  get(): T
  subscribe(listener: (value: T, previous: T) => void): Unsubscribe
}

/** AI SDK v6 model instance, injected by the host. Never constructed here. */
export type LanguageModelLike = import('ai').LanguageModel

/**
 * Defer model construction to first use. Exists for exactly one reason: an MV3 service worker
 * must register its event listeners synchronously during initial evaluation, so
 * `provider: anthropic({ apiKey: await getKey() })` — a top-level await before
 * `chrome.runtime.onStartup.addListener(...)` — forfeits the wake events the whole restart
 * story depends on. `lazyModel` moves the `await` inside the first attempt, where it is free.
 *
 * **The factory memoizes success only (normative, decision log #32).** A resolved model is built
 * once and reused by every later attempt; a *rejected* factory is NOT cached — the rejection
 * surfaces as `provider_error` on that attempt and the next attempt calls the factory again. That
 * is the only reading under which "on that attempt" carries weight, and it is the one the MV3 case
 * needs: the first wake can find no API key stored yet, and a cached rejection would poison every
 * run for the rest of the worker's life.
 */
export function lazyModel(factory: () => Awaitable<LanguageModelLike>): LanguageModelLike

/** Standard Schema v1 — zod v4, valibot, arktype all satisfy it. */
export type { StandardSchemaV1 } from '@standard-schema/spec'

export interface Usage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}
```

### 2.2 The `Run` record (PLAN §4.2's nine fields + the `spec` replay snapshot)

```ts
/**
 * `context` is present exactly when the copilot is parameterized with a real context type.
 * With `TContext = unknown` (the default) it stays optional; with a concrete `TContext`
 * inferred from `renderContext`, `run.context` is `TContext`, not `TContext | undefined`.
 * Without this every consumer casts — the reference bridge in §6 did so four times.
 * A run is only ever created without context when `TriggerInput.context` is omitted, which
 * the type system already forbids once `TContext` is a required object type.
 */
export type RunContext<TContext> = unknown extends TContext
  ? { context?: TContext }
  : { context: TContext }

export type Run<TContext = unknown> = RunRecord<TContext> & RunContext<TContext>

export interface RunRecord<TContext = unknown> {
  id: string
  state: 'queued' | 'processing' | 'done' | 'error' | 'cancelled'
  input: string
  /** Set on done. */
  output?: string
  /** Set on error; retry is a new run, never a mutation of this one. */
  error?: string
  attempts: number
  /**
   * ISO. Bumped at every step, by the heartbeat ticker while processing, **and while the run
   * sits `queued` in a live local queue** (§3.1). A queued run whose heartbeat froze at
   * creation time would be judged stale by the 30 s watchdog, "restarted" (incrementing
   * `attempts`), and terminated as `max_attempts` after three ticks without the model ever
   * being called — which is what `concurrency: 1` guarantees for every run but the first.
   */
  heartbeat: string
  createdAt: string
  /**
   * **The replay snapshot (normative, decision log #26).** Written once, at trigger time, when —
   * and only when — the trigger supplied at least one of `model` / `tools` / `maxSteps`. Never
   * mutated afterwards, and never written by a resume: a run's spec is decided by the trigger that
   * created it, exactly like `input` and `context`.
   *
   * It exists because a restart is cross-process. `resumePending()` in a fresh service worker
   * reads a record, not a `TriggerInput`, so without this field the replay silently runs on the
   * default provider with the full tool registry — a batch run's `reply_to_thread` becomes
   * available to a single run, an `ask` run drops off its fast tier, and a `maxSteps: 12` review
   * replays with 8. That is a behaviour change no host can detect, let alone correct.
   */
  spec?: RunSpec
}

/**
 * A JSON snapshot of the per-run overrides in `TriggerInput`. Every member is optional and an
 * absent member means "the processing instance's own default", so a run triggered with no
 * overrides carries no `spec` at all.
 */
export interface RunSpec {
  /**
   * A **key of `CopilotOptions.models`** — never a model instance, which is not serialisable.
   * `trigger({ model })` with an inline `LanguageModelLike` therefore records nothing, and a
   * cross-process replay of that run uses the primary `provider`: an object the reviving process
   * never saw cannot be resurrected from a store, and inventing a name for it would only make the
   * record lie.
   */
  model?: string
  /** The per-run tool subset, by name, exactly as `TriggerInput.tools` gave it (`[]` included). */
  tools?: readonly string[]
  maxSteps?: number
}
```

`Run<T>` is **PLAN §4.2's nine fields plus `spec`** — the `RunRecord` / `RunContext` split is a
typing device for `context`'s optionality, not a field. The tenth field is the single addition this
spec makes to the locked record, and it is admitted for one reason only: it is what makes a
restarted run *the same run*, which is the property PLAN §4.5 is about. Nothing else is added —
everything the runtime wants to remember beyond this (per-step text, tool calls, usage) lives in
the in-process event stream and in `RunResult`, not in the durable record. `TContext` is a phantom
narrowing of the locked `context?: unknown`; `Run` (unparameterized) is assignable from `Run<T>`
and vice versa at the store boundary.

**Replay semantics (normative).** An instance that starts an attempt for a run it did not trigger —
`resumePending()` in a fresh process, a resumed run whose slot came from `attach()`, a
`trigger({ runId })` that deduped onto an existing record and was later adopted — resolves the
attempt's model, tool set and step cap from `run.spec`, not from its own defaults:

| `spec` member | Resolution at attempt start | When it cannot be resolved |
|---|---|---|
| `model` | `options.models[spec.model]`; `run:start.model` reports the key | Key absent in this process ⇒ fall back to `provider`, `run:start.model` is `'default'`, and one `error` event (`scope: 'provider'`, code `unknown_model`) reports the degradation. A resume must never fail because the reviving process registers different tiers. |
| `tools` | `registry.subset(spec.tools)` | Names this process does not register are dropped, each with one `error` event (`scope: 'tool'`, code `unknown_tool`). Dropping a tool is survivable; throwing `unknown_tool` out of `resumePending()` is not. |
| `maxSteps` | used verbatim | — |

`TriggerInput.system` is deliberately **not** snapshotted: it is prompt text, often large, and
`CopilotOptions.systemPrompt` — which is a function of the `Run` and therefore reproducible in any
process — is the durable channel for per-run prompt shaping. A resumed run whose trigger passed
`system` falls back to `systemPrompt(run)` (§3.5), and a host that needs the override to survive a
restart puts it in `context`, which is durable by construction.

**`TContext` must be JSON-round-trippable (normative).** `context` is written to the `RunStore`
and read back in a different process after a service-worker restart, so a `Date`, `Map`, `Set`
or class instance goes in and comes back as something else while still typed `TContext`. The
runtime does not clone, revive or validate it: hosts pass plain JSON values, and
`renderContext` must tolerate a value that has been through `JSON.parse(JSON.stringify(x))`.
`runStoreConformance()` asserts the round trip for a nested plain object.

### 2.3 Constants

```ts
/** PLAN §4.5: bounded retry. Not configurable — there is one defensible value. */
export const MAX_ATTEMPTS: 3
/** Heartbeat older than this ⇒ resumePending() restarts the run. Overridable per call. */
export const STALE_AFTER_MS: 60_000
/** Heartbeat write interval while processing (and while queued in a live queue). */
export const HEARTBEAT_MS: 10_000
/**
 * Delay before a failed-but-retryable run is picked up again: `min(2 ** attempt * 1000, 30_000)`
 * — 2 s, then 4 s. Not configurable, but not zero either: `rate_limited` is in the retryable
 * set and `MAX_ATTEMPTS` is 3, so an immediate requeue turns one 429 into three 429s inside a
 * few milliseconds and a `max_attempts` terminal — strictly worse than a single attempt.
 * The run stays `queued` and its heartbeat keeps ticking during the wait (§3.1).
 */
export function retryDelayMs(attempt: number): number
```

### 2.4 Tools

```ts
export interface ToolDefinition<
  TName extends string = string,
  TInput = any,
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

/**
 * Author a tool. `const TName` + Standard Schema inference is what makes `ToolCall<TTools>`
 * a discriminated union keyed on your literal tool names.
 */
export function defineTool<
  const TName extends string,
  TSchema extends StandardSchemaV1,
  TOutput,
  TContext = unknown,
>(def: {
  name: TName
  description: string
  inputSchema: TSchema
  outputSchema?: StandardSchemaV1<unknown, TOutput>
  execute(
    input: StandardSchemaV1.InferOutput<TSchema>,
    ctx: ToolContext<TContext>,
  ): Awaitable<TOutput>
  timeoutMs?: number
}): ToolDefinition<TName, StandardSchemaV1.InferOutput<TSchema>, Awaited<TOutput>, TContext>

/**
 * A tool declared where the loop runs but executed somewhere else (SW ⇄ content script).
 * One declaration site for the schema; inputs are validated on both ends.
 */
export function remoteTool<
  const TName extends string,
  TSchema extends StandardSchemaV1,
  TOutput = unknown,
  TContext = unknown,
>(
  def: {
    name: TName
    description: string
    inputSchema: TSchema
    outputSchema?: StandardSchemaV1<unknown, TOutput>
    timeoutMs?: number
  },
  transport: ToolTransport<TContext>,
): ToolDefinition<TName, StandardSchemaV1.InferOutput<TSchema>, TOutput, TContext>

/**
 * Bind `defineTool` / `remoteTool` to a context type. `defineTool`'s `TContext` is a trailing
 * type parameter with no inference site, so `ctx.context` is `unknown` in every tool written
 * the plain way — the advertised typed-context payoff never appears. Writing
 * `const { defineTool } = toolsFor<Ctx>()` restores it in one line, and the resulting
 * `ToolDefinition<…, Ctx>[]` is what makes `createCopilot`'s `TContext` inference agree with
 * the tools' view of it.
 */
export function toolsFor<TContext>(): {
  /** Same signature as the free `defineTool`, with `TContext` already fixed. */
  defineTool<const TName extends string, TSchema extends StandardSchemaV1, TOutput>(
    def: {
      name: TName
      description: string
      inputSchema: TSchema
      outputSchema?: StandardSchemaV1<unknown, TOutput>
      execute(
        input: StandardSchemaV1.InferOutput<TSchema>,
        ctx: ToolContext<TContext>,
      ): Awaitable<TOutput>
      timeoutMs?: number
    },
  ): ToolDefinition<TName, StandardSchemaV1.InferOutput<TSchema>, Awaited<TOutput>, TContext>
  /** Same signature as the free `remoteTool`, with `TContext` already fixed. */
  remoteTool<const TName extends string, TSchema extends StandardSchemaV1, TOutput = unknown>(
    def: {
      name: TName
      description: string
      inputSchema: TSchema
      outputSchema?: StandardSchemaV1<unknown, TOutput>
      timeoutMs?: number
    },
    transport: ToolTransport<TContext>,
  ): ToolDefinition<TName, StandardSchemaV1.InferOutput<TSchema>, TOutput, TContext>
}

/** The ONLY thing standing between `copilot` and `chrome.runtime`. One method. */
export interface ToolTransport<TContext = unknown> {
  call(
    name: string,
    input: unknown,
    ctx: {
      runId: string
      step: number
      attempt: number
      signal: AbortSignal
      /**
       * The run's context, verbatim — the same value an in-process tool gets on
       * `ToolContext.context`. Without it a remote tool can only learn its `threadId` from a
       * model-generated argument, i.e. a value the runtime already holds is routed through
       * the LLM. It is also how the transport picks its destination (the tab for
       * `context.pageKey`) instead of guessing "the active tab".
       */
      context: TContext
    },
  ): Promise<unknown>
}

/**
 * The other end of a ToolTransport. Re-validates inputs on arrival.
 *
 * `handle` **always** builds a complete `ToolContext` (normative): it creates its own
 * `AbortController`, enforces the tool's `timeoutMs` locally (so a content-script tool cannot
 * keep running after the loop side has already reported `tool_timeout`), and fills
 * `runId` / `step` / `attempt` / `context` from the arriving envelope, falling back to
 * `options.context` and to `''`/`0` for a caller that sends none. `ctx` is a partial override
 * for tests, not the source of truth.
 */
export function serveTools<const TTools extends readonly ToolDefinition[]>(
  tools: TTools,
  options?: { context?: unknown },
): {
  handle(name: string, input: unknown, ctx?: Partial<ToolContext>): Promise<unknown>
  readonly names: readonly TTools[number]['name'][]
}

/**
 * Read-only registry exposed as `copilot.tools`. It describes what is registered — it does
 * **not** toggle anything: per-run tool selection is `TriggerInput.tools`, and an options-page
 * toggle is a host-side preference the host applies when it triggers. (`ToolRegistry` has no
 * `setEnabled` on purpose: a mutable global enable-flag would make `ToolCall<TTools>`
 * inference lie about what a run can produce.)
 */
export interface ToolRegistry<TTools extends readonly ToolDefinition[]> {
  readonly names: readonly TTools[number]['name'][]
  get<N extends TTools[number]['name']>(name: N): Extract<TTools[number], { name: N }> | null
  has(name: string): boolean
  /** JSON Schema for the tool's input, derived from the Standard Schema. */
  schema(name: TTools[number]['name']): unknown
}
```

### 2.5 Construction

```ts
export function createCopilot<
  const TTools extends readonly ToolDefinition<string, any, any, TContext>[] = readonly [],
  TContext = unknown,
>(options: CopilotOptions<TTools, TContext>): Copilot<TTools, TContext>

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
  /** Concurrent processing runs. Default 1 — SW lifetime is the scarce resource, not throughput. */
  concurrency?: number
  /** Wall clock per attempt, ms. Default 240_000. */
  timeoutMs?: number
  /** Receives every `error` event, including ones thrown by `error` listeners. */
  onError?: (error: CopilotError, scope: ErrorScope) => void
  now?: () => Date
  /** Default: nanoid(12). */
  createId?: () => string
}
```

Deliberately **absent**, each because it has exactly one defensible value here:
`maxAttempts` (constant 3, PLAN §4.5), `stream` (PLAN §8 — always stream; providers without
streaming degrade automatically), `heartbeatMs`, `staleAfterMs` (constant, overridable at the
`resumePending` call site), retry backoff (a constant schedule, `retryDelayMs`, §2.3),
tool-error policy (always fed back to the model), run retention (the store adapter's
business), temperature / topP (pass a preconfigured model).

`timeoutMs` is a **per-attempt wall clock, not an MV3 budget**: the runtime's survival story is
`resumePending()` plus the `runtime:active` keepalive, not a short timeout (§3.6).

### 2.6 The runtime surface

```ts
export interface Copilot<
  TTools extends readonly ToolDefinition[] = readonly [],
  TContext = unknown,
> {
  /** Synchronous. Returns a view over a durable record, not a promise over a computation. */
  trigger(input: TriggerInput<TTools, TContext>): RunHandle<TTools, TContext>
  /**
   * Re-attach to a run this process did not start (post-SW-restart, options page, devtools).
   *
   * **Foreign runs are polled (normative).** `RunStore` has no `subscribe` (decision log #9)
   * and the terminal state is written by the *processing* instance, so an attaching instance
   * has no channel to learn it. `attach` therefore polls `runStore.get(id)` every
   * `HEARTBEAT_MS / 2` (5 s) until the record is terminal, then settles `result()` and emits
   * the corresponding terminal event locally. Polling stops on settle, on `destroy()`, and
   * when the handle has no `result()` caller and no listeners. A handle for a run this
   * instance owns never polls — it is driven by the loop.
   */
  attach(runId: string): RunHandle<TTools, TContext>
  /** True when a run existed and was queued/processing. Never throws. */
  cancel(runId: string, reason?: string): Promise<boolean>
  /**
   * Cancel every queued/processing run whose id starts with `prefix`. Resolves with the ids
   * actually cancelled. This is how a host cancels "all work for this thread" (PLAN §3.5's
   * "delete cancels any in-flight run") without keeping its own index: run ids are
   * host-composed, so `c:{threadId}:` is a prefix the host already knows.
   */
  cancelByPrefix(prefix: string, reason?: string): Promise<readonly string[]>
  /**
   * Host calls on wake / alarm. Restarts runs with stale heartbeats. Idempotent.
   *
   * **Restarts replay the run's own `spec` (§2.2), not this instance's defaults** — same model
   * tier, same tool subset, same step cap as the trigger asked for, in whatever process picks the
   * run up.
   */
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
  /**
   * Aborts in-flight attempts, drops listeners. Runs stay `processing` in the store so a later
   * `resumePending()` picks them up. **Every outstanding `result()` is settled locally** with
   * `{ ok: false, reason: 'cancelled', error: CopilotError('destroyed') }` before this
   * resolves — the durable record is untouched, only the local promise is closed out.
   * Leaving them pending forever would leak the promise and its continuations in a page
   * context, and would trade "no unhandled rejections" for "no settled promises", which is
   * not an improvement.
   */
  destroy(): Promise<void>
}

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
   * A key of `models`, or a model instance. Unknown key ⇒ `unknown_model` thrown sync.
   * A key is snapshotted into `run.spec.model` and survives a restart; an inline instance is not
   * serialisable and does not (§2.2).
   */
  model?: string | LanguageModelLike
  /** Per-run system prompt override. Not snapshotted — see §2.2's replay semantics. */
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

export interface RunFilter {
  state?: Run['state'] | readonly Run['state'][]
  /**
   * Run-id prefix. Host-composed ids are the only queryable link from a run back to whatever
   * the host cares about (`context` is opaque and unindexed), so this is what makes both
   * `cancelByPrefix` and "which threads have a live run?" a store query rather than a scan of
   * everything. Adapters may implement it as a key-range scan.
   */
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
  /**
   * Claimed by another context, heartbeat still fresh, **or already present in this
   * instance's own queue**. `resumePending` must skip run ids the local queue holds
   * (`queued` behind `concurrency`, or `processing` right now): they are not abandoned, they
   * are waiting, and restarting them would burn an attempt for nothing.
   */
  skipped: number
}
```

There is no `ok()` sugar on the handle, no `[Symbol.asyncIterator]`, no `ask()` one-shot, no
`triggerMany`, no `simulate`, no `drain`, no `queue` object, no `undoRun`, no `watchdog`, no
`explain(runId)`, no middleware, no plugins. See §8.

### 2.7 Run store

```ts
export interface RunStore<TContext = unknown> {
  get(id: string): Promise<Run<TContext> | null>
  put(run: Run<TContext>): Promise<void>
  list(filter?: RunFilter): Promise<Run<TContext>[]>

  /* --- optional --- */
  /** Human-readable name for inspect(). Default: 'anonymous'. */
  readonly name?: string
  /**
   * Multi-context resume safety (SW + offscreen document). Returns false when another owner
   * holds a fresh lease. Absent ⇒ advisory heartbeat locking only, sufficient for one SW.
   *
   * **Leases expire on the host clock (`Date.now()`), normative (decision log #31.)** The store
   * factories below take no clock seam, by design: a lease is a coordination fact between
   * *processes* (an SW and an offscreen document, two tabs, a real `chrome.storage` adapter shared
   * by both), and every one of them reads the wall clock. `CopilotOptions.now` drives heartbeats,
   * staleness and event timestamps *inside one instance*; making it also move leases would let a
   * test's virtual clock hand out a lease a real second process still holds. A host that wants
   * virtual-clock leases writes them into its own adapter — which is exactly what `claim` being
   * optional is for.
   */
  claim?(id: string, owner: string, ttlMs: number): Promise<boolean>
}

/** Identity function; preserves the concrete literal type of a store object. */
export function defineRunStore<const S extends RunStore<any>>(store: S): S

export function createMemoryRunStore<TContext = unknown>(): RunStore<TContext> & {
  snapshot(): Run<TContext>[]
}

/** Same KeyValueAdapter shape as comment-core's, deliberately re-declared. */
export interface KeyValueAdapter {
  get(keys: readonly string[]): Promise<Record<string, unknown>>
  set(entries: Record<string, unknown>): Promise<void>
  remove(keys: readonly string[]): Promise<void>
  keys(prefix: string): Promise<string[]>
  watch?(cb: (changedKeys: string[]) => void): Unsubscribe
}

/** Key layout `{ns}:r:{runId}`. `keep` ring-buffers terminal runs on write. */
export function createKeyValueRunStore<TContext = unknown>(
  kv: KeyValueAdapter,
  options?: { namespace?: string; keep?: number },
): RunStore<TContext>
```

**Adapter contract (normative).**
1. `put` resolves only when the write is durable.
2. `list` returns runs sorted by `createdAt` ascending, honouring `filter`.
3. There is no `delete`. **The runtime only ever appends and updates.** Retention is adapter
   policy — a ring buffer inside `put` is five lines, and only the host knows whether run
   history is a debugging asset or garbage.
4. There is no `subscribe`. `attach()` therefore polls `get` for runs this instance does not
   own (§2.6), and cross-context *event* observation is a host duty (a `chrome.runtime` Port
   relay of `copilot.subscribe()` events, PLAN §4.5), because that channel also extends SW
   lifetime and the runtime must not own it.
5. I/O failures throw; the runtime wraps them in `CopilotError('store_failed')` and treats them
   as fatal to the run (§4.5).

### 2.8 Events

```ts
export interface CopilotEventMap<
  TTools extends readonly ToolDefinition[] = readonly [],
  TContext = unknown,
> {
  'run:queued': { runId: string; run: Run<TContext> }
  'run:start': { runId: string; run: Run<TContext>; attempt: number; resumed: boolean; model: string }
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
    /** true ⇒ NOT terminal; a fresh `run:start` follows. Bind `run:settled` if you don't care. */
    willRetry: boolean
  }
  'run:cancelled': {
    runId: string
    run: Run<TContext>
    reason: string | null
    at: 'queued' | 'processing'
  }
  /**
   * Convenience terminal: exactly one **per run per emitting instance**, after
   * done | error(final) | cancelled. Cross-context uniqueness is the relay's job, not the
   * runtime's (§3.3.5).
   */
  'run:settled': { runId: string; run: Run<TContext>; result: RunResult<TContext> }
  'tool:call': { runId: string; step: number; name: TTools[number]['name']; input: unknown }
  'tool:result': { runId: string; step: number; call: ToolCall<TTools>; durationMs: number }
  /**
   * 0→1 active-run edge. Host: start the 25 s keepalive ping. **Leading edge — emitted
   * synchronously when the first run becomes active, before the first provider request is
   * issued.** The live MV3 constraint is the 30 s idle timer, which a silent `fetch` does not
   * reset; a 500 ms-delayed keepalive is a 500 ms hole at exactly the wrong moment.
   */
  'runtime:active': { activeRuns: number }
  /** 1→0 active-run edge. Host: stop it. Trailing-debounced 500 ms, so a gap between two
   *  runs does not thrash the host's interval. */
  'runtime:idle': { activeRuns: 0 }
  'error': { error: CopilotError; scope: ErrorScope; runId?: string }
}

export type ErrorScope = 'provider' | 'tool' | 'store' | 'listener' | 'transport' | 'context'

/**
 * The payoff of `const TTools`: a discriminated union keyed on your literal tool names.
 *
 * **On a failed call, `input` is the model's raw input and may not satisfy the schema
 * (normative, decision log #29).** `ok: false` covers `tool_input_invalid` (the model produced
 * arguments the Standard Schema rejected) and `tool_not_found` (a tool that was never registered),
 * and in both cases the only input that exists is the one the model emitted — unparsed,
 * unvalidated, possibly absent, in which case it is reported as `{}`. The static type stays
 * `ToolInputOf<K>` because widening it to `unknown` would force a cast in every `ok: true` branch
 * to buy safety in a branch that is already an error path: read `call.input` on a failed call as
 * *evidence about what the model tried*, never as a validated value. Only the `ok: true` arm
 * carries an input the schema accepted.
 */
export type ToolCall<TTools extends readonly ToolDefinition[]> = {
  [K in TTools[number] as K['name']]:
    | { name: K['name']; ok: true; input: ToolInputOf<K>; output: ToolOutputOf<K> }
    | { name: K['name']; ok: false; input: ToolInputOf<K>; error: CopilotError }
}[TTools[number]['name']]

export type ToolInputOf<T> = T extends ToolDefinition<any, infer I, any, any> ? I : never
export type ToolOutputOf<T> = T extends ToolDefinition<any, any, infer O, any> ? O : never
export type ToolNameOf<C> = C extends Copilot<infer T, any> ? T[number]['name'] : never
export type ContextOf<C> = C extends Copilot<any, infer X> ? X : never

export type CopilotEventName = keyof CopilotEventMap<any, any>

export type CopilotEvent<
  TTools extends readonly ToolDefinition[] = any,
  TContext = any,
> = {
  [K in CopilotEventName]: {
    type: K
    /** null only for runtime:active / runtime:idle. */
    runId: string | null
    /**
     * Monotonic **per run, per emitting instance**, across that instance's attempts.
     * NOT global across contexts: there is no shared durable counter (`Run` carries no counter —
     * `spec` is a trigger-time snapshot, never a running total — and `RunStore` has no seq, and
     * neither will gain one), so an SW and an offscreen document — the §3.6 escape
     * hatch — would both emit `1..n` for the same run. A relay dedupes and orders on
     * `(runId, instanceId, seq)`; across instances, order is by `at` and ties are arbitrary.
     */
    seq: number
    /** Stable id of the emitting runtime instance, `nanoid(8)` at construction. */
    instanceId: string
    at: number
    payload: CopilotEventMap<TTools, TContext>[K]
  }
}[CopilotEventName]
```

Every PLAN §4.1 listener compiles verbatim; `run:done` carries `runId` at the top level exactly
as §4.5 requires for an idempotent host append.

### 2.9 Errors

```ts
export class CopilotError extends Error {
  readonly name: 'CopilotError'
  readonly code: CopilotErrorCode
  readonly runId?: string
  readonly toolName?: string
  readonly retryable: boolean
  readonly cause?: unknown
  static is(e: unknown, code?: CopilotErrorCode): e is CopilotError
  /** Structured-clone-safe projection, for cross-context transports. */
  toJSON(): { name: 'CopilotError'; code: CopilotErrorCode; message: string; runId?: string; toolName?: string; retryable: boolean }
}

export type CopilotErrorCode =
  // programmer errors — thrown synchronously from createCopilot / trigger
  | 'no_provider' | 'duplicate_tool' | 'unknown_model' | 'unknown_tool' | 'invalid_options' | 'destroyed'
  // run errors — always events + a Run record, never a rejection
  | 'tool_not_found' | 'tool_input_invalid' | 'tool_failed' | 'tool_timeout'
  | 'provider_error' | 'rate_limited' | 'timeout' | 'step_limit' | 'context_render_failed'
  | 'aborted' | 'run_not_found' | 'store_failed' | 'max_attempts'

/**
 * **`isRetryable(e)` — i.e. the error INSTANCE's `retryable` flag — is the source of truth
 * (normative, decision log #30).** The code is the default, not the verdict: `provider_error`,
 * `rate_limited` and `timeout` construct with `retryable: true`, everything else with `false`, and
 * provider classification may override the flag on an individual error.
 *
 * The case that forces this: **a non-429 4xx is `provider_error` with `retryable: false`.** A 400,
 * 401 or 403 has no other code to map to — it is neither a rate limit nor a timeout — and the
 * provider will reject the identical request identically on the next two attempts, so retrying it
 * spends the whole `MAX_ATTEMPTS` budget and reports `max_attempts` instead of the 401 the host
 * needs to see. Never branch on `e.code === 'provider_error'` to decide whether to retry; branch
 * on `isRetryable(e)`.
 *
 * **`store_failed` is NOT retryable** — §3.4 makes run-store failure fatal ("the runtime
 * refuses to process a run it cannot record"), and a code cannot be both fatal and worth three
 * attempts. Durability is the MV3 contract; a runtime that cannot write is a runtime whose
 * retries are invisible anyway.
 */
export function isRetryable(e: unknown): boolean
```

### 2.10 Introspection

```ts
export interface CopilotInspection {
  version: string
  /**
   * `models` are the keys of `options.models`; `default` is the primary provider's
   * `modelId` when the injected instance exposes one, else `null` — a `LanguageModelLike` has
   * no name of its own and is not a key of `models`, so there is nothing else to report.
   */
  provider: { models: string[]; default: string | null }
  tools: Array<{
    name: string
    description: string
    schema: unknown
    calls: number
    errors: number
    avgMs: number
  }>
  runs: Record<Run['state'], number>
  config: { maxSteps: number; concurrency: number; timeoutMs: number; maxAttempts: 3 }
  listeners: Record<CopilotEventName | '*', number>
  store: { name: string; lastError: string | null }
}
```

`inspect()` is exactly what the options page needs to render tool toggles and exactly what a
devtools panel needs to render a run list. One method, no second API.

### 2.11 `copilot/testing`

```ts
export interface ConformanceCase { name: string; run: () => Promise<void> }

/** ~25 assertions: durability, sorting, filtering, upsert, optional claim semantics. */
export function runStoreConformance(
  factory: () => Awaitable<RunStore>,
): ConformanceCase[]

/**
 * A deterministic LanguageModelLike. Streams `text` char by char when asked to stream.
 * The script is optional and defaults to `[{ text: 'ok' }]`, so `scriptedModel()` is a valid
 * zero-argument provider — which is what the §9 DoD's globals-deleted import test calls.
 */
export function scriptedModel(script?: ScriptedStep[] | string): LanguageModelLike

export type ScriptedStep =
  | { text: string; delayMs?: number }
  | { toolCall: { name: string; input: unknown }; delayMs?: number }
  | { error: Error }

/** The only way to test PLAN §4.5: kill the runtime mid-run, revive it against the same store. */
export function createTestCopilot<
  const TTools extends readonly ToolDefinition[] = readonly [],
  TContext = unknown,
>(options?: Partial<CopilotOptions<TTools, TContext>> & { script?: ScriptedStep[] | string }): {
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
```

---

## 3. Semantic contracts (normative)

### 3.1 Run state machine

```
                trigger()                 claim + start            model finishes
   (nothing) ──────────────▶ queued ──────────────────▶ processing ──────────────▶ done
                               │                            │
                               │ cancel                     │ cancel / abort
                               ▼                            ▼
                           cancelled                    cancelled
                               ▲                            │
                               │                            │ attempt fails
                               │                            ▼
                               └──────── attempts < 3 ── queued ── attempts = 3 ─▶ error
```

* `queued → processing` requires a successful `claim` (when the store supports it) or a stale
  heartbeat (when it does not).
* **A queued run in a live queue is not abandoned.** While a run sits in this instance's FIFO
  (waiting on `concurrency`, or waiting out `retryDelayMs`), the heartbeat ticker bumps its
  `heartbeat` exactly as it does for a processing run, and `resumePending()` skips run ids the
  local queue already holds. Without both halves, `concurrency: 1` plus a 30 s watchdog
  terminates every run but the first as `max_attempts` without ever calling the model.
* `attempts` is incremented **when an attempt starts**, not when it fails. A run reaching
  `attempts === MAX_ATTEMPTS` and failing terminates as `error` with `max_attempts`.
* A retryable failure requeues the run after `retryDelayMs(attempt)` — 2 s, then 4 s (§2.3).
  The record stays `queued` for that interval.
* `done`, `error` and `cancelled` are absorbing. A terminal run is never resumed, restarted, or
  re-triggered — a "retry" is a fresh `trigger()` with a fresh `runId` (PLAN §4.2).
* **No mid-loop checkpoint (PLAN §4.5, deliberate).** A restart replays the run from step 1.
  It costs tokens, not correctness, because the host's append is idempotent on `runId`.
* **A restart replays the run's `spec`, in any process (§2.2).** `input`, `context` and `spec` are
  the run; the instance that resumes contributes only its `provider`, its registry and its
  `systemPrompt`. A restart that silently changed model tier, tool set or step cap would not be a
  replay of the same run — it would be a different run wearing the same `runId`, and the host's
  idempotent append would happily commit its output.

### 3.2 Idempotency

| Rule | Behavior |
|---|---|
| `trigger({ runId })` where the run exists and is **non-terminal** | No new work. Returns a handle onto the existing run with `deduped: true`. No `run:queued` event. |
| `trigger({ runId })` where the run exists and is **terminal** | No new work. Returns a handle whose `result()` resolves immediately from the stored record, `deduped: true`. Re-running a finished job requires a new id. |
| `trigger()` with no `runId` | New id from `createId()`. |
| `cancel(unknownId)` | Resolves `false`. Never throws. |
| `cancel(terminalId)` | Resolves `false`. No event. |
| `attach(unknownId)` | Returns a handle whose `run` store is `null` and whose `result()` resolves `{ ok: false, reason: 'error', error: CopilotError('run_not_found') }`. Never throws. |
| `attach(id)` for a run owned by another context | Polls `runStore.get(id)` every 5 s until terminal, then settles (§2.6). A run that never reaches a terminal state — because the owning worker died — is settled by whichever instance next runs `resumePending()`, not by the attaching one. |
| `resumePending()` called concurrently from two contexts | Both are safe. With `store.claim`, the loser reports the run under `skipped`. Without it, the heartbeat window (`STALE_AFTER_MS`) is the advisory lock and double-processing is possible-but-harmless because the terminal write is last-writer-wins on the same `runId` and the host's append is idempotent. |

### 3.3 Event ordering guarantees

1. **Durable-first.** Every state transition (`queued`, `processing`, `done`, `error`,
   `cancelled`) is written to the `RunStore` **before** its event is emitted. Inside a
   `run:done` handler, `await copilot.get(runId)` already reflects it. This is the property MV3
   needs: if the SW dies right after the event, the output is already recoverable.
   `run:token`, `tool:call`, `tool:result` and `run:step` are ephemeral and never write.
2. **Canonical per-attempt sequence:**
   `run:start` → ( `run:token`\* interleaved with ( `tool:call` → `tool:result` )\* and
   `run:step` at each step boundary ) → exactly one of `run:done` | `run:error` |
   `run:cancelled`. Nothing follows the terminal for that attempt.
3. **`run:queued` fires once per run**, before the first `run:start`, after the initial durable
   write. A resumed run does **not** re-emit `run:queued`.
4. **`run:error` with `willRetry: true` is not terminal.** The record stays `queued`; a fresh
   `run:start` (`attempt: n+1`, `resumed: true`) follows. Only `willRetry: false` sets
   `state: 'error'`.
5. **Exactly one `run:settled` per run per emitting instance**, across that instance's attempts,
   emitted immediately after the final terminal event it observes. This is the one event a host
   binds when it only cares that the work is over (clear the thinking chip, release the keepalive).
   It is **not** globally unique across contexts, and it cannot be: §2.6 makes an attaching
   instance emit the terminal locally after polling, so an SW that owns a run and an options page
   attached to it each emit their own — with no shared counter (§3.3.8) there is nothing to
   reconcile them with. **Cross-context uniqueness is the relay's dedupe duty**, on
   `(runId, instanceId, seq)` exactly like every other event: a relay that forwards two instances'
   `run:settled` for one run and lets the page act on both has skipped the dedupe every relayed
   event needs, not hit a runtime bug.
6. **`tool:call` always precedes its `tool:result`**; both precede the `run:step` that reports
   them in `calls`.
7. **`run:token` is best-effort and lossy by contract** (PLAN §4.5). It may be entirely absent
   (provider without streaming, no listener attached). It never precedes `run:start` and never
   follows a terminal event. **Never build state on tokens** — `run:done` and the run store are
   the durable channel.
8. **`seq` is monotonic per run per emitting instance**, across that instance's attempts. A
   `chrome.runtime` Port relay dedupes and orders on `(runId, instanceId, seq)`. Ordering
   across instances is by `at` only — there is no shared counter to give more than that.
9. **`runtime:active` fires on the 0→1 active-run edge (leading, undelayed), `runtime:idle` on
   1→0 (trailing, debounced 500 ms).** These bracket every keepalive concern the host has, and
   the asymmetry is deliberate: starting late can kill a run, stopping late costs one ping.
10. **Synchronous, snapshot-ordered emission.** Listeners run in registration order over a
    frozen list. Run-scoped listeners (`handle.on`, `on(_, _, { runId })`) fire before global
    ones. Subscribing during emission takes effect on the next emission. The `*` firehose
    receives each event after its typed listeners.
11. **Cross-run interleaving is arbitrary** when `concurrency > 1`. Per-run order is total;
    global order is not.
12. **`destroy()`** aborts in-flight attempts **without** writing terminal states (so a later
    `resumePending()` can pick them up), drops all listeners, and is idempotent. No event fires
    after it resolves. Outstanding `result()` promises are settled locally with
    `{ ok: false, reason: 'cancelled', error: CopilotError('destroyed') }` (§2.6) — settling a
    promise is not an event, and a never-settling promise is a leak, not a guarantee.
13. **Relayed events are projected, not cloned as-is.** Exactly four payloads are
    structured-clone-safe and may be posted verbatim: **`run:token`, `run:queued`, `run:done` and
    `run:cancelled`** (their `Run` — `context` and `spec` included — is JSON by contract, §2.2).
    Every other event is the relay's responsibility to project before posting:
    * `run:error`, `run:settled` and `error` carry a `CopilotError` directly;
    * **`run:step`, `tool:call` and `tool:result` carry one too** — §2.8's `ToolCall` holds a live
      `CopilotError` on every failed call, and `tool:call.input` is raw model output, which is JSON
      in practice but is never validated as such by the runtime.

    A `CopilotError` is an `Error` subclass, so structured clone drops `code`, `retryable`, `runId`
    and `toolName`, and throws `DataCloneError` on a non-cloneable `.cause`. **Hosts relaying
    `run:step`, `tool:*` or `run:error` MUST project the errors themselves**, through
    `CopilotError.toJSON()` — the runtime does not ship a pre-projected event stream, because the
    events a relay actually forwards are a host decision (§6 forwards two of thirteen) and a second
    "serialised" event shape would be a second contract to keep aligned. A relay that skips the
    projection delivers `error.code === undefined`, which is exactly the field §7.1 and §7.3
    branch on.

### 3.4 Error behavior

* **Two error planes, and they never mix.**
  * *Programmer errors* — `no_provider`, `duplicate_tool`, `unknown_model`, `unknown_tool`,
    `invalid_options`, `destroyed` — throw **synchronously** from `createCopilot()` or
    `trigger()`. You want those at the top of the stack trace.
  * *Run errors* — everything else — are **always an event plus a `Run` record**.
    `trigger()` never rejects. `result()` never rejects. `cancel()` never rejects.
    The runtime never produces an unhandled rejection, which matters in a worker that is about
    to be killed anyway. This is the direct consequence of "runs are data, not promises".
* **Tool failures go back to the model.** A throwing tool becomes a tool-result message
  describing the failure, surfaces as `tool:result` with `ok: false` and a typed `ToolCall`,
  and the loop continues. This is not configurable: a run whose one unreachable tool killed it
  is strictly worse than a run that learned the tool is unreachable and carried on with what it
  had. A tool that exhausts `timeoutMs` produces `tool_timeout` the same way. (A host may of
  course degrade *inside* the tool instead — §6's `get_thread_element_html` catches its own
  transport failure and answers with the stored capture, so the model gets a labelled fallback
  rather than an error to recover from. That is a host choice this policy makes possible, not a
  second error mode in the runtime.)
* **Input validation happens on both ends.** `remoteTool` validates against the schema before
  transport; `serveTools` validates again on arrival. A malformed model call never reaches the
  content script. Validation failure ⇒ `tool_input_invalid`, fed back to the model. **The
  resulting `ToolCall` reports the model's raw input** — the value that failed validation, or `{}`
  when the model emitted none — so `call.input` on an `ok: false` call is evidence, not a value
  that satisfies `inputSchema` (§2.8).
* **Provider errors end the attempt.** Retryable set: `provider_error` (5xx / network),
  `rate_limited`, `timeout`. Not retryable: `tool_input_invalid`, `step_limit`, `aborted`,
  `run_not_found`, `context_render_failed`, **`store_failed`** (fatal — see below), and
  **`provider_error` carrying a non-429 4xx**, which classification constructs with
  `retryable: false` (§2.9): the code is the default, `isRetryable(e)` is the verdict. Retries are
  bounded by `MAX_ATTEMPTS`, spaced by `retryDelayMs(attempt)` (§2.3), and then emit
  `run:error` / `max_attempts` with `willRetry: false`.
* **Step-limit policy.** Reaching `maxSteps` ends the run as `done` with
  `finishReason: 'step-limit'` and whatever text exists. If that text is empty, the run ends as
  `error` / `step_limit`. Never a silent hang.
* **`renderContext` failure** is `context_render_failed`, not retryable — a deterministic
  function will fail identically on every attempt.
* **Run-store failure is fatal to the run.** The runtime refuses to process a run it cannot
  record: durability is the entire MV3 contract. Emits `error` (`scope: 'store'`), and the run
  is left in whatever state was last durable.
* **Listener isolation.** A throwing listener produces one `error` event with
  `scope: 'listener'` and is otherwise ignored (it stays subscribed). A listener that throws
  while handling `error` goes to `options.onError`, then `console.error`. `error` never
  re-emits itself.

### 3.5 Prompt assembly (normative)

For each attempt, in order:
1. `system` = `TriggerInput.system` ?? `await systemPrompt(run)` (or the literal string) ?? `''`.
   In a process that did not issue the trigger there is no `TriggerInput.system` (§2.2: it is not
   snapshotted), so a resumed attempt starts at `systemPrompt(run)`.
2. `rendered` = `run.context === undefined ? '' : await renderContext(run.context, run)`.
   Failure ⇒ `context_render_failed`.
3. Messages = `[{ role: 'system', content: system }, { role: 'user', content: rendered ? rendered + '\n\n' + run.input : run.input }]`.
4. Tools = registered tools filtered by `TriggerInput.tools` when present, or by `run.spec.tools`
   on an attempt this instance did not trigger (§2.2).
5. Loop = AI SDK `ToolLoopAgent` with `stopWhen: stepCountIs(maxSteps)`, streaming enabled —
   `maxSteps` being `TriggerInput.maxSteps` ?? `run.spec.maxSteps` ?? `CopilotOptions.maxSteps`,
   and the model being `TriggerInput.model` ?? `models[run.spec.model]` ?? `provider`.

Runs are **stateless**: nothing from a previous run enters the prompt. Submit and follow-up
share one code path (PLAN §5) — the host puts the conversation in `context`.

### 3.6 MV3 host duties (informative; the runtime provides the primitives)

| PLAN §4.5 duty | Runtime primitive | Host cost |
|---|---|---|
| Keepalive while work is outstanding | `runtime:active` / `runtime:idle` events | 3 lines |
| Watchdog after SW death | `resumePending()` | 3 lines (`chrome.alarms`, 30 s floor) |
| Token relay to the open page | `subscribe()`; four payloads post verbatim, everything else needs the host's own `CopilotError.toJSON()` projection (§3.3.13) | 4 lines |
| Idempotent write-back | `run:done.runId` + `comment-core`'s `appendComment({ id })` | 1 line |
| Visible failure after 3 dead attempts | `run:error` with `willRetry: false` | 3 lines |
| Re-deriving "which threads are busy" after a restart | `list({ state, idPrefix })` | 3 lines |
| Offscreen-document escape hatch | `RunStore.claim` | ~10 lines |

The runtime provides no `KeepaliveAdapter`, no `TimerAdapter` and no `watchdog()` method: two
events and one method already reduce every duty to a handful of lines, and an adapter interface
would be a second way to express the same thing.

---

## 4. Internal module layout

`packages/copilot/src`

| File | ~LOC | Contents |
|---|---|---|
| `index.ts` | 35 | Public barrel. |
| `types.ts` | 150 | Run, options, events, tool types. Zero logic. |
| `errors.ts` | 85 | `CopilotError`, codes, `is()`, `isRetryable()`, `toJSON()`, provider-error classification. |
| `ids.ts` | 20 | nanoid(12) + injectable seam. |
| `readable.ts` | 45 | `ReadableStore` implementation. |
| `emitter.ts` | 110 | Typed bus: `on/once/off/subscribe`, per-run `seq`, run-scoped-first delivery, listener isolation, error-loop breaker. |
| `tools/define.ts` | 70 | `defineTool`, duplicate-name check, JSON-Schema derivation for `inspect()`. |
| `tools/registry.ts` | 80 | `ToolRegistry`, per-run subset filtering, call counters. |
| `tools/remote.ts` | 110 | `remoteTool`, `serveTools`, both-ends validation, `timeoutMs`. |
| `tools/execute.ts` | 100 | Standard-Schema validation, timeout, abort plumbing, error→model mapping. |
| `run/record.ts` | 90 | Run construction + pure state transitions + invariant assertions. |
| `run/heartbeat.ts` | 70 | 10 s ticker, staleness predicate, `claim` fallback. |
| `run/queue.ts` | 150 | FIFO, `concurrency`, active-count edges (`runtime:active` / `runtime:idle`). |
| `run/handle.ts` | 120 | `RunHandle`: `run` store, `result()`, `tokens()`, run-scoped `on`. |
| `loop.ts` | 260 | AI SDK `ToolLoopAgent` wiring: prompt assembly, streaming, step events, typed `ToolCall` construction, step-limit policy. |
| `copilot.ts` | 300 | `createCopilot`: `trigger`, `attach`, `cancel`, `resumePending`, `get`, `list`, `runs`, `inspect`, `destroy`, retry policy. |
| `store/memory.ts` | 65 | `createMemoryRunStore`. |
| `store/kv.ts` | 130 | `createKeyValueRunStore`, key layout, `keep` ring buffer, `claim` over a lease key. |
| `testing/index.ts` | 25 | Barrel. |
| `testing/scripted-model.ts` | 140 | `scriptedModel` — a conforming `LanguageModelLike`. |
| `testing/store-conformance.ts` | 130 | ~25 cases. |
| `testing/harness.ts` | 160 | `createTestCopilot`, event recorder, `kill()` / `revive()`. |

**Total: ~2,400 LOC.**

---

## 5. Quick start

```ts
import { createCopilot, defineTool } from 'copilot'
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'

const copilot = createCopilot({
  provider: anthropic('claude-opus-5'),
  systemPrompt: 'You help the user understand what they are reading. Be terse.',
  tools: [
    // DOM-free, like the package: a tool that touched `document` could not run in the SW,
    // which is where this runtime is designed to live. Page access is `remoteTool` (§2.4).
    defineTool({
      name: 'fetch_text',
      description: 'Plain text of a URL',
      inputSchema: z.object({ url: z.string().url(), maxChars: z.number().default(4000) }),
      execute: async ({ url, maxChars }, { signal }) =>
        (await (await fetch(url, { signal })).text()).slice(0, maxChars),
    }),
  ],
})

const result = await copilot.trigger({ input: 'Summarise https://example.com in one sentence.' }).result()
console.log(result.ok ? result.output : result.error?.code)
```

`runStore` defaults to memory, `maxSteps` to 8, `concurrency` to 1, streaming is always on.
`copilot.tools.names` is `readonly 'fetch_text'[]`.

---

## 6. Extension bridge — the service worker

This is the **only** file in the product that imports both libraries. Neither imports the
other, and neither mentions `chrome`.

```ts
// entrypoints/background.ts
import {
  CopilotError, createCopilot, createKeyValueRunStore, lazyModel, toolsFor,
  type ToolTransport,
} from 'copilot'
// `comment-core/headless`: the root entry's types need lib.dom, which a SW tsconfig lacks.
import {
  createDomain, createKeyValueStore, createKeyValueCursor, observeStore,
} from 'comment-core/headless'
import { createAnthropic } from '@ai-sdk/anthropic'
import { onMessage, sendMessage } from '@webext-core/messaging'
import { z } from 'zod'
import { kv } from './kv'
import { createTabRouter } from './tabs'

const store = createKeyValueStore(kv, { namespace: 'exp-spec' })
const comments = createDomain(store) // §3.5 rules, no DOM, works with the tab closed

// `threadIds` is set by batch runs only, and it is what every fan-out below iterates: a batch
// run speaks for N threads, a single run for its own. `context.threadIds ?? [context.threadId]`
// is the one expression that says so, and it lives in exactly one helper (`threadsOf`).
type Ctx = {
  threadId: string
  kind: string
  pageKey: string
  mode: 'single' | 'batch'
  threadIds?: string[]
}
const threadsOf = (c: Ctx): readonly string[] => c.threadIds ?? [c.threadId]

/** What `get_thread_element_html` answers with. `source` is the part the model must read. */
type ThreadElementHtml = { source: 'live' | 'capture'; html: string | null; note?: string }

const { defineTool, remoteTool } = toolsFor<Ctx>()

// pageKey → **every** tab showing it, recomputed from `tabs.query` on every call. Plural, and
// not a cached map: a map in worker memory dies with the worker every 30 s, and a run that
// outlives its worker would then find "no open tab" for a page that is right there. This is the
// bridge's ONLY tab lookup — a `sendMessage` from the worker with no tab target reaches extension
// pages and never a content script, so making the fan-out form the one available primitive is
// what stops a tab-less send from being re-introduced.
const tabs = createTabRouter(chrome.tabs) // tabsForPageKey(pageKey): Promise<number[]>

// The transport routes by the RUN's page, not by whatever tab happens to be focused: a
// background run outlives tab focus and tab existence (PLAN §1 step 4). No tab ⇒ a real
// tool failure, which the model can react to, rather than `null`, which it cannot
// distinguish from "the element is gone". First tab wins: a tool answers about *the* page, and
// two tabs on the same URL are the same document as far as the anchor is concerned. (Page
// *notifications* take all of them — see the fan-out below.)
const transport: ToolTransport<Ctx> = {
  call: async (name, input, { signal, context }) => {
    const [tabId] = await tabs.tabsForPageKey(context.pageKey)
    if (tabId === undefined) {
      throw new CopilotError('tool_failed', `no open tab for ${context.pageKey}`, { toolName: name })
    }
    return sendMessage(`tool:${name}`, input as never, tabId, { signal })
  },
}

// Best-effort SW → page fan-out. Every notification below goes to EVERY tab on the run's page:
// the same document open in two tabs is two content scripts, each with its own chip map, and a
// notification that reaches only one of them is a bug in the other.
const toPage = (pageKey: string, send: (tabId: number) => Promise<unknown>) =>
  tabs.tabsForPageKey(pageKey)
    .then((ids) => Promise.all(ids.map((tabId) => send(tabId).catch(() => undefined))))
    .catch(() => [])

// Listeners first, provider later: MV3 only wakes a terminated worker for listeners
// registered in the FIRST turn of initial evaluation. A top-level `await getKey()` above
// this line would silently forfeit every wake event the §3.6 survival story depends on.
let anthropicP: Promise<ReturnType<typeof createAnthropic>> | undefined
const getAnthropic = () => (anthropicP ??= (async () =>
  createAnthropic({
    apiKey: await getKey(),
    headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
  }))())

// `provider` is a thunk-backed lazy model: the key is resolved on first use, inside a handler.
const copilot = createCopilot({
  provider: lazyModel(() => getAnthropic().then((a) => a('claude-opus-5'))),
  models: { fast: lazyModel(() => getAnthropic().then((a) => a('claude-haiku-4-5'))) },
  runStore: createKeyValueRunStore(kv, { namespace: 'runs', keep: 200 }),
  systemPrompt: (run) => promptFor(run.context.kind), // per-mode prompt, PLAN §5 — no cast
  renderContext: (c) => `thread=${c.threadId} kind=${c.kind} page=${c.pageKey}`,
  tools: [
    remoteTool({ name: 'get_page_context', description: 'URL, title, heading outline, selection',
                 inputSchema: z.object({}) }, transport),
    // NOT a bare `remoteTool`. PLAN §5's tool table promises a fallback to the stored capture,
    // so the SW half calls the transport itself and answers `{ source, html, note? }` — a
    // discriminated answer the model must read, instead of a `string | null` in which "the
    // element is gone" and "no tab has this page open" are the same value. `source` is the part
    // that carries the meaning; `note` is prose for the model, never parsed.
    defineTool({ name: 'get_thread_element_html',
                 description: 'HTML of the element a thread is anchored to. Returns ' +
                   '{ source, html }: "live" is the element as it is on the page right now, ' +
                   '"capture" is the snapshot taken when the thread was created, returned when ' +
                   'the element is gone or no tab has that page open. Never guess which one you ' +
                   'got — read `source`.',
                 inputSchema: z.object({ threadId: z.string() }),
                 execute: async ({ threadId }, ctx): Promise<ThreadElementHtml> => {
                   let live: unknown = null
                   try {
                     live = await transport.call('get_thread_element_html', { threadId }, ctx)
                   } catch (error) {
                     // A cancelled run is not a page that failed to answer: propagate it, or a
                     // cancel silently becomes a successful capture read.
                     if (CopilotError.is(error, 'aborted')) throw error
                   }
                   if (typeof live === 'string') return { source: 'live', html: live }
                   const record = await comments.get(threadId)
                   if (!record) return { source: 'capture', html: null, note: 'thread not found' }
                   return { source: 'capture', html: record.thread.capture.outerHTML,
                            note: 'the live element is gone or the page is not open; this is the '
                              + 'capture taken when the thread was created' }
                 } }),
    remoteTool({ name: 'show_message', description: 'Show a message on the page',
                 inputSchema: z.object({ text: z.string() }) }, transport),
    defineTool({ name: 'read_thread', description: 'Full thread with comments',
                 inputSchema: z.object({ threadId: z.string() }),
                 execute: ({ threadId }) => comments.get(threadId) }),
    defineTool({ name: 'list_threads', description: 'Threads on a page',
                 inputSchema: z.object({ pageKey: z.string(), kind: z.string().optional() }),
                 execute: (f) => comments.list(f) }),
    // Batch-run only (PLAN §5 manual dispatch): filtered out of single runs by TriggerInput.tools.
    defineTool({ name: 'reply_to_thread', description: 'Post a reply into one thread',
                 inputSchema: z.object({ threadId: z.string(), body: z.string() }),
                 execute: async ({ threadId, body }, ctx) => {
                   if (!(await comments.get(threadId))) return 'thread deleted'
                   await comments.appendComment(threadId, {
                     author: 'copilot', body, id: `t:${ctx.runId}:${threadId}`,
                   })
                   return 'posted'
                 } }),
  ] as const,
})

const SINGLE_TOOLS = ['get_page_context', 'get_thread_element_html', 'show_message',
                      'read_thread', 'list_threads'] as const

// Run ids are `c:{threadId}:{commentId}` — thread-prefixed, so "cancel this thread's work"
// is a prefix operation and needs no side index. Keying on the comment id alone made
// `cancel(\`c:${threadId}\`)` a permanent no-op.
const runIdFor = (threadId: string, commentId: string) => `c:${threadId}:${commentId}`
const runPrefixFor = (threadId: string) => `c:${threadId}:`

// ── hook → trigger. comment-core hooks reach the SW with no messaging: same store.
// The durable cursor is mandatory here: chrome.storage.onChanged wakes a dormant worker, so
// the write that caused the wake landed BEFORE this line ran.
observeStore(store, async (event) => {
  if (event.type !== 'thread:create' && event.type !== 'thread:reply') return
  const { thread, comment } = event.payload
  if (comment.author !== 'user') return // PLAN §8: the author field is the ONLY loop guard
  if (dispatchPolicy(thread.kind) === 'manual') return void (await markPending(thread))

  copilot.trigger({
    runId: runIdFor(thread.id, comment.id), // idempotency key: an SW replay cannot double-trigger
    input: renderThread(await comments.get(thread.id)),
    context: { threadId: thread.id, kind: thread.kind, pageKey: thread.pageKey, mode: 'single' },
    // `model` (as a `models` KEY) and `tools` are snapshotted into `run.spec` (§2.2), so the
    // watchdog below restarts an `ask` run on the `fast` tier and WITHOUT `reply_to_thread` even
    // though the worker that issued this trigger is long dead. Passing a model instance here
    // instead of the key `'fast'` would not survive — nothing serialises an object.
    model: thread.kind === 'ask' ? 'fast' : undefined,
    tools: SINGLE_TOOLS,
  })
}, { cursor: createKeyValueCursor(kv, { namespace: 'exp-spec:host', id: 'dispatch' }) })

export const cancelRunsForThread = (threadId: string) =>
  copilot.cancelByPrefix(runPrefixFor(threadId), 'thread deleted')

observeStore(store, async ({ type, payload }) => {
  if (type !== 'thread:delete') return
  const threadId = payload.thread.id
  // A batch run's id is page-prefixed, so the prefix cancel above cannot see it. Scanning the
  // LIVE RUNS finds it — and each one carries the threads it covers, so nothing else has to be
  // stored to make this answerable. (A durable thread→run index used to; it was a second copy
  // of a fact the run store already keeps, and it could only ever disagree.)
  const batches = (await copilot.list({ state: ['queued', 'processing'] }))
    .filter((r) => r.context.mode === 'batch' && threadsOf(r.context).includes(threadId))
  await cancelRunsForThread(threadId)
  for (const run of batches) {
    // A batch run owes replies to every thread it covers; cancelling it because ONE was deleted
    // throws away the other N−1 answers, and `reply_to_thread` already returns 'thread deleted'
    // for the gone one. Cancel only when nothing it could still reply to is left.
    const covered = threadsOf(run.context).filter((id) => id !== threadId)
    const survivors = await Promise.all(covered.map((id) => comments.get(id)))
    if (survivors.every((record) => record === null)) await copilot.cancel(run.id, 'thread deleted')
  }
}, { cursor: createKeyValueCursor(kv, { namespace: 'exp-spec:host', id: 'cancel' }) })

// ── run:done → thread. Only SINGLE runs write a comment: a batch run's output is a summary
// over many threads (PLAN §5 surfaces it as a toast), not a reply belonging to threadIds[0].
copilot.on('run:done', async ({ runId, run, output }) => {
  if (run.context.mode !== 'single') return
  if (!(await comments.get(run.context.threadId))) return // deleted mid-run → drop the output
  await comments.appendComment(run.context.threadId, {
    author: 'copilot', body: output, id: `r:${runId}`,
  })
})

// ── a dead run must be visible. Three worker deaths terminate a run as `max_attempts`;
// without this the user sees a comment with no reply, no error, and a cleared chip.
// EVERY thread of the run, exactly like run:queued and run:settled: notifying `threadIds[0]`
// alone left the other eleven threads of a dead batch with a cleared chip and no failure state.
copilot.on('run:error', ({ run, error, willRetry }) => {
  if (willRetry) return
  for (const threadId of threadsOf(run.context)) {
    void toPage(run.context.pageKey, (tabId) =>
      sendMessage('copilot:failed', { threadId, code: error.code }, tabId))
  }
})

// ── one event to clear the chip, whatever happened. Nothing durable to sweep here: a run
// leaving `queued`/`processing` IS the sweep (see `copilot:busyThreads` below).
copilot.on('run:settled', ({ run }) => {
  for (const threadId of threadsOf(run.context)) {
    void toPage(run.context.pageKey, (tabId) =>
      sendMessage('copilot:busy', { threadId, busy: false }, tabId))
  }
})
copilot.on('run:queued', ({ run }) => {
  for (const threadId of threadsOf(run.context)) {
    void toPage(run.context.pageKey, (tabId) =>
      sendMessage('copilot:busy', { threadId, busy: true }, tabId))
  }
})

// ── level-triggered chip recovery. run:queued/run:settled are edges emitted by ONE instance;
// after a worker death a content script has no way to ask "who is busy?" without this.
//
// The run store is the whole answer, and there is **no side index** to consult: a run in
// `queued`/`processing` is the definition of busy, and it names the threads it speaks for. No
// `idPrefix` either — that filter silently excluded every page-prefixed batch run, which is
// exactly the case a side index was once introduced to patch. Deduped, because two live runs
// (a batch review plus a single run from a human reply) may cover the same thread.
onMessage('copilot:busyThreads', async () => {
  const live = await copilot.list({ state: ['queued', 'processing'] })
  return [...new Set(live.flatMap((r) => threadsOf(r.context)))]
})

// ── MV3 host duties: three lines each, because the runtime says when.
let keepalive: number | undefined
copilot.on('runtime:active', () => { keepalive ??= setInterval(chrome.runtime.getPlatformInfo, 25_000) })
copilot.on('runtime:idle', () => { clearInterval(keepalive); keepalive = undefined })

chrome.alarms.create('copilot-watchdog', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'copilot-watchdog') copilot.resumePending() })
chrome.runtime.onStartup.addListener(() => copilot.resumePending())
copilot.resumePending() // and on every SW wake

// ── best-effort token relay (also extends SW lifetime). `run:token` is one of the four
// clone-safe payloads and posts verbatim; everything else this relay forwards is projected by
// HAND, because projecting is the relay's duty, not the runtime's (§3.3.13). The page dedupes on
// (runId, instanceId, seq) — `run:settled` is unique per instance, not per run (§3.3.5).
chrome.runtime.onConnect.addListener((port) => {
  const off = copilot.subscribe((e) => {
    if (e.type === 'run:token') port.postMessage(e)
    else if (e.type === 'run:settled') port.postMessage({
      ...e,
      payload: { ...e.payload, result: { ...e.payload.result, error: e.payload.result.ok ? null
        : e.payload.result.error?.toJSON() ?? null } },
    })
    // `run:step` carries a live CopilotError inside every failed ToolCall — same duty.
    else if (e.type === 'run:step') port.postMessage({
      ...e,
      payload: { ...e.payload, calls: e.payload.calls.map((c) =>
        c.ok ? c : { ...c, error: c.error.toJSON() }) },
    })
  })
  port.onDisconnect.addListener(off)
})
```

Every `chrome.*` listener above is registered during initial evaluation, with no `await`
anywhere before it. That is not style: it is the precondition for the worker ever waking up
again.

Content-script half — `serveTools` is the other end of `remoteTool`, and it is the **single
normative content-script tool half** (SPEC-comment-core §7.2 deliberately hand-rolls none):

```ts
// entrypoints/content.ts (excerpt; the comment half is in SPEC-comment-core §7.2)
import { serveTools, defineTool } from 'copilot'
import { onMessage } from '@webext-core/messaging'
import { z } from 'zod'

const served = serveTools([
  defineTool({ name: 'get_page_context', description: '…', inputSchema: z.object({}),
               execute: () => ({ url: location.href, title: document.title,
                                 headings: [...document.querySelectorAll('h1,h2,h3')].map((h) => h.textContent?.trim()),
                                 selection: getSelection()?.toString() ?? null }) }),
  // The PAGE half answers `string | null` — the live element, or `null` for "orphaned",
  // precisely. It is the SW half above that turns that (and an unreachable page) into the
  // `{ source, html, note? }` the model sees; this end never knows about the capture.
  defineTool({ name: 'get_thread_element_html', description: '…',
               inputSchema: z.object({ threadId: z.string() }),
               execute: ({ threadId }) => {
                 const view = engine.getThreadView(threadId)
                 if (!view) throw new Error(`unknown thread ${threadId}`) // → tool_failed
                 return view.anchoring.element?.outerHTML ?? null // null means "orphaned", precisely
               } }),
  defineTool({ name: 'show_message', description: '…', inputSchema: z.object({ text: z.string() }),
               execute: ({ text }) => { toast(text); return 'shown' } }),
])

// `handle` builds the AbortSignal and enforces timeoutMs on this side too (§2.4).
for (const name of served.names) onMessage(`tool:${name}`, ({ data }) => served.handle(name, data))
```

---

## 7. Advanced usage

### 7.1 Typed step handling — an exhaustive switch, no casts

```ts
copilot.on('run:step', ({ runId, step, calls }) => {
  for (const call of calls) {
    switch (call.name) {
      case 'read_thread':
        // call.output is ThreadRecord | null — inferred from defineTool.execute
        if (call.ok) metrics.observe('ctx_comments', call.output?.comments.length ?? 0)
        break
      case 'show_message':
        console.debug(runId, step, call.input.text) // call.input.text is string
        break
      case 'get_thread_element_html':
        // `call.output` is `ThreadElementHtml` — the tool already degraded, so what is worth
        // observing is HOW it answered, not whether it threw.
        if (call.ok && call.output.source === 'capture') metrics.count('served_from_capture')
        break
      case 'reply_to_thread':
      case 'get_page_context':
      case 'list_threads':
        break
    }
  }
})
```

Adding a tool makes the compiler point at every place that must handle it.

### 7.2 Batch dispatch (PLAN §5 `manual` policy)

```ts
// The "N comments — Send to copilot" pill sends one run with the whole review in context.
async function sendBatch(threadIds: string[], pageKey: string) {
  const records = await Promise.all(threadIds.map((id) => comments.get(id)))
  const handle = copilot.trigger({
    runId: `b:${pageKey}:${hash(threadIds)}`,
    input: renderReview(records.filter(Boolean)),
    // `mode: 'batch'` is what stops the global run:done handler from appending this run's
    // summary as a comment in threadIds[0]; the per-thread writes are reply_to_thread's job.
    context: { threadId: threadIds[0], kind: 'comment', pageKey, mode: 'batch' },
    // reply_to_thread is only offered here — that is the entire tool-set difference. Both this
    // subset and `maxSteps: 12` land in `run.spec`, so a batch run that outlives its worker is
    // restarted as a batch run rather than as a single run with 8 steps (§2.2).
    tools: ['read_thread', 'list_threads', 'get_page_context', 'reply_to_thread'],
    maxSteps: 12,
  })
  const result = await handle.result()
  if (result.ok && result.output.trim()) toast(result.output) // optional overall summary
}
```

### 7.3 Streaming, re-attach after SW death, opportunistic local model

```ts
// Streaming a run in a page context.
const handle = copilot.trigger({ input: 'Review this section.', context, model: 'fast' })
for await (const delta of handle.tokens()) render(delta) // best-effort; may yield nothing
const result = await handle.result()
if (!result.ok && result.reason === 'error') retryBanner(result.error!.code)

// Re-attach to a run this process never started (fresh SW, options page, devtools).
// This handle polls the run store (§2.6) — nothing pushes terminal state across contexts. If the
// watchdog restarts the run in THIS process, it replays on the tier and tool subset recorded in
// `run.spec`, not on this instance's defaults (§2.2).
const revived = copilot.attach(runIdFor(threadId, commentId))
console.log(await revived.result())
console.log(revived.run.get()?.spec) // e.g. { model: 'fast', tools: [...] } — or undefined

// Opportunistic Gemini Nano: a model swap, not an API. @built-in-ai/core owns the fallback.
import { builtInAI } from '@built-in-ai/core'
const copilot = createCopilot({
  provider: anthropic('claude-opus-5'),
  models: { fast: anthropic('claude-haiku-4-5'), local: builtInAI({ fallback: anthropic('claude-haiku-4-5') }) },
  tools,
})
copilot.trigger({ input: `Title this in four words:\n${body}`, model: 'local', tools: [] })
```

### 7.4 Testing the MV3 story

```ts
import { createTestCopilot } from 'copilot/testing'
import { defineTool } from 'copilot'
import { expect, it } from 'vitest'
import { z } from 'zod'

it('restarts from scratch after service-worker death and posts exactly once', async () => {
  const t = createTestCopilot({
    // The scripted tool call must resolve to a REGISTERED tool, or §3.4 turns it into
    // `tool_not_found` fed back to the model and the test exercises the error path instead.
    tools: [defineTool({ name: 'read_thread', description: 'stub',
                         inputSchema: z.object({}), execute: () => ({ comments: [] }) })] as const,
    script: [{ toolCall: { name: 'read_thread', input: {} } }, { text: 'done' }],
  })
  t.copilot.trigger({ runId: 'c:t1:1', input: 'hi', context: { threadId: 't1' } })
  await t.events.waitFor('run:start')
  await t.kill() // SW dies mid-loop; the record stays `processing` with a stale heartbeat

  const revived = t.revive()
  const report = await revived.resumePending({ staleAfterMs: 0 })
  expect(report.restarted).toEqual(['c:t1:1'])
  const result = await revived.attach('c:t1:1').result()
  expect(result.ok && result.restarted).toBe(true)
  // the host's append is idempotent on runId, so a duplicated `done` writes nothing new
})
```

---

## 8. Decision log

| # | Contested point | Chosen | Rejected | Why |
|---|---|---|---|---|
| 1 | Tool declaration | Locked `ToolDefinition[]` + `defineTool` with `const TName` and Standard Schema inference (A) | B's raw AI SDK `ToolSet`; C's fat `ToolDefinition` (undo / approval / retries / cacheTtl / idempotencyKey / runtime / tags / enabled) | PLAN §4.1 locks the array of `ToolDefinition`. A's inference costs nothing at entry level and yields `ToolCall<TTools>` — the single highest-leverage type in the package. B's `ToolSet` renegotiates a lock; C's extras have no PLAN requirement. |
| 2 | `ToolCall` typing | Discriminated union keyed on literal tool names (A) | untyped `{ name: string; input: unknown }` | Handling tool activity becomes an exhaustive switch with no casts, and adding a tool makes the compiler point at every handler. |
| 3 | Tool error policy | Always fed back to the model; not configurable (B's discipline applied to A's default) | A's `onToolError: 'model' \| 'fail' \| fn`; C's `onError: 'fail-run' \| 'return-to-model'` | There is one defensible value: `get_thread_element_html` failing on a closed tab must let the model fall back to the stored capture in the same step. A hard-fail mode would only ever produce a worse run. |
| 4 | Tool approval / undo | **None** | C's `approval`, `ApprovalAdapter`, `undo`, `withEffectLedger`, `undoRun` | PLAN's four tools are read-mostly plus one toast. Human-in-the-loop is a second execution plane for zero stated requirement. |
| 5 | Remote execution seam | `remoteTool` + one-method `ToolTransport` + `serveTools` (A) | C's bidirectional `MessageTransport` + `serveCopilot` / `createCopilotClient` | Three of PLAN §5's four tools run in the content script, so the seam is required. One method (`call`) is all it takes; a full runtime proxy is a whole second API surface for a case PLAN already solves with a Port relay. |
| 6 | What `trigger()` returns | `RunHandle` — a view over a durable record (A/PLAN) | B's bare run id | PLAN §4.1 locks `const handle = copilot.trigger(...)`. B's id-only shape forces every consumer to re-query the store. |
| 7 | Failure surfacing | `result(): Promise<RunResult>` discriminated union; never rejects (A) | A's additional `ok()` that throws; C's thenable `RunHandle` | Two error planes on one handle is exactly how drift starts. One truth: the discriminated union. Also guarantees no unhandled rejection in a worker about to be killed. |
| 8 | Run record | Locked nine fields, no additions (B/C) — since amended by #26, which adds `spec` and nothing else | A's optional `updatedAt` / `metadata` / `v` | PLAN §4.2 is locked and the additions buy nothing: `heartbeat` is the freshness field, and the bridge's `threadId` belongs in `context`. The one addition that does buy something (a cross-process replay that is the same run) is ruled in #26. |
| 9 | Run store | 3 methods (`get`, `put`, `list`) + optional `claim` | A's 5 + `claim` + `prune`; C's 5 + three optional capability interfaces; B's 2 | `get` is required for `attach` and `runId` idempotency without loading everything. `delete` is dropped — B is right that retention is adapter policy (a ring buffer in `put`). `subscribe` is dropped — cross-context observation is a Port relay, which is a host duty per PLAN §4.5 and also extends SW lifetime. |
| 10 | Multi-context safety | Optional `RunStore.claim` (A) | C's `LeasingRunStore` + `probeRunStore`; nothing | The offscreen-document escape hatch (PLAN §4.5) needs it; making it one optional method rather than a probed capability interface keeps the required contract at three methods. |
| 11 | Event set | 13 events: 6 locked + `run:queued`, `run:settled`, `tool:call`, `tool:result`, `runtime:active`, `runtime:idle`, `error` | B's 2 (`state`, `token`); C's 17 (`run:restart`, `budget:exceeded`, `queue:change`, `run:compensated`, `tool:progress`, `tool:approval`, …) | PLAN §4.1 locks six names, so B's collapse is not available. `run:settled` saves every host three bindings; the `runtime:*` pair reduces the entire MV3 keepalive duty to three lines. C's extras track features this spec does not ship. |
| 12 | Concurrency | Option, default 1 | B's hardcoded serial; C's default 2 | B's reasoning (SW lifetime, not throughput, is scarce) sets the default. But a page-hosted copilot legitimately wants 3, and an optional field with a correct default does not grow the entry surface. |
| 13 | `maxAttempts` / staleness / streaming | Constants `MAX_ATTEMPTS = 3`, `STALE_AFTER_MS`, `HEARTBEAT_MS`; always stream (B) | A's `maxAttempts` / `staleAfterMs` / `stream` options | PLAN §4.5 pins attempts at 3 and §8 says always stream. An option with one defensible value is a decision the implementer will get wrong. `staleAfterMs` remains overridable at the `resumePending()` call site, where the alarm period actually varies. |
| 14 | Providers | `provider` + `models: Record<string, LanguageModelLike>` + per-run `model` | A's `ProviderMap` + `defineModel({ available })`; B's rebuild-the-agent-to-swap | PLAN §4.4 wants a selectable fast tier and an opportunistic local model. `@built-in-ai/core` already owns availability detection and silent remote fallback, so `defineModel` would re-implement a dependency. B's rebuild loses per-run tiering, which PLAN §5 needs for `ask` vs `comment`. |
| 15 | Per-run tool variation | `TriggerInput.tools: readonly TTools[number]['name'][]` — a subset filter | passing fresh `ToolDefinition[]` per run; two copilot instances | PLAN §5 needs `reply_to_thread` for batch runs only and a different tool set per mode. A name subset gives that with zero damage to `ToolCall<TTools>` inference; fresh definitions per run would erase it. |
| 16 | One-shot calls | **None** | A's `copilot.ask()` | A second execution path with no run record and no events is a second set of semantics to keep aligned. Hosts already hold the model; AI SDK `generateText` is two lines. |
| 17 | Middleware / plugins | **None** | A's `defineCopilotPlugin` + `wrapTool` + `transformPrompt`; C's `RunMiddleware`, `ToolMiddleware`, `copilot/middleware` (14 exports), `CopilotPlugin` | `systemPrompt` as a function and `renderContext` cover prompt shaping. Everything else (retry, timeout, budget, cache, redaction, tracing, provider fallback) is either already in the runtime or is a host concern that `on()` reaches. Largest surface cut in the package. |
| 18 | Batch / queue / lifecycle extras | **None** | C's `triggerMany`, `BatchHandle`, `drain`, `queue`, `cancelAll`, `metrics`, `watchdog`, `simulate`, `undoRun` | PLAN's batch dispatch (§5) is one run with many threads in context, not many runs — `triggerMany` would solve a problem the design does not have. |
| 19 | Introspection | `inspect()` only (A) | A's additional `explain(runId)` + `RunTrace`; C's journaling run store | `explain` requires a journaling store, which would force a fourth+fifth store method on every adapter. Per-step detail is already live on `run:step` and terminal detail on `RunResult`. `inspect()` alone feeds the options page and devtools. |
| 20 | Errors | One `CopilotError` + code union + `retryable` + `is()` + `toJSON()` (A) | C's 12 subclasses + `serializeError`/`deserializeError`; B's zero error types | One class covers narrowing, transport and classification. `toJSON()` replaces a serializer pair. B's zero-types design cannot express "throw synchronously for programmer errors", which is the property that keeps config bugs off the run queue. |
| 21 | Error planes | Programmer errors throw sync; run errors are events + records (A) | uniform rejection; uniform events | PLAN §4.2/§4.5: runs are data, not promises. A fire-and-forget `trigger()` in a dying service worker must never produce an unhandled rejection, and a missing `provider` must never become a silent queued run. |
| 22 | MV3 host support | `runtime:active` / `runtime:idle` events + `resumePending()` (A) | C's `KeepaliveAdapter` + `TimerAdapter` + `watchdog()` | Two events reduce keepalive to three host lines and keep `chrome` out of the package. Adapter interfaces would be a second, redundant way to express the same duty. |
| 23 | Idempotency semantics | `trigger({ runId })` dedupes for non-terminal **and** terminal runs; `deduped` on the handle | re-running a terminal run; rejecting on duplicate | PLAN §4.5's whole restart story depends on `runId` being a true key. Dedupe-on-terminal means a replayed `chrome.runtime` message after a restart cannot double-spend tokens or double-post a reply. |
| 24 | Test kit | `scriptedModel`, `runStoreConformance`, `createTestCopilot` with `kill()`/`revive()` (C's idea, A's runner-agnostic shape) | C's full `TestCopilot` surface with `ManualTimers`; no kit | `kill()`/`revive()` is the only way to test PLAN §4.5's central claim; it is the highest-value item in C's testing section. Conformance returns `ConformanceCase[]` rather than taking `{ describe, it, expect }` so it works in vitest, node:test and bun alike. |
| 25 | `KeyValueAdapter` duplication | Structurally identical type declared in **both** packages | a shared third package | PLAN §2's dependency rule is absolute: the two libraries never import each other, and each must make sense published standalone. A shared package would be a third internal dependency for a six-line interface. |

### 8.1 Wave-1 implementation rulings (D1–D8)

Wave 1's implementation surfaced eight points where the code could not follow the spec as written,
or followed it and produced a worse system. Each was ruled and is now normative in the body above;
they are recorded here so a reader never has to reconstruct why the locked text moved.

| # | Ruled | Where it lands | Why |
|---|---|---|---|
| 26 | **D1 — `Run` gains a persisted `spec` snapshot** `{ model?, tools?, maxSteps? }`, captured at trigger time only when overrides were given; `resumePending()` / a resumed `attach()` slot replay with it in ANY process. | §2.2 (field + `RunSpec` + replay table), §2.6, §3.1, §3.5, §6, §9 | The nine-field lock (#8) was written against additions that buy nothing — `updatedAt`, `metadata`, `v`. This one buys the central claim of PLAN §4.5: a restart must be a replay of *the same run*. Without it, `model: 'fast'`, `tools: SINGLE_TOOLS` and `maxSteps: 12` evaporate at the process boundary, and the fresh worker silently runs a *different* run under the same `runId` — on the expensive tier, with the batch-only `reply_to_thread` in reach, and the host's idempotent append commits the result. A model *instance* and `system` still do not survive: neither is serialisable in any honest way (§2.2). |
| 27 | **D2 — the clone-safe list is exactly `run:token`, `run:queued`, `run:done`, `run:cancelled`.** Hosts relaying `run:step`, `tool:call`, `tool:result` or `run:error` project errors through `CopilotError.toJSON()` themselves. | §3.3.13, §3.6, §6 | The old list called `run:step` clone-safe while §2.8 puts a live `CopilotError` inside every failed `ToolCall` — both cannot hold. Shrinking the promise to the four payloads that are genuinely JSON keeps the guarantee true and keeps projection where the relay already is; the alternative (a runtime-provided serialised event stream) is a second event contract to keep aligned for a duty that is four lines at the port. |
| 28 | **D3 — `run:settled` is exactly one per run *per emitting instance*.** Cross-context uniqueness is the relay's dedupe duty on `(runId, instanceId, seq)`. | §2.8, §3.3.5 | "Exactly one per run across all contexts" contradicted §2.6, which requires an attaching instance to emit the terminal it polled for, and §3.3.8, which says no shared counter exists. The per-instance reading is the one the runtime can actually keep, and dedupe was already the relay's job for every other event. |
| 29 | **D4 — on a failed `ToolCall`, `input` is the model's raw input and may not satisfy the schema** (`{}` when the model emitted none). Types unchanged. | §2.8, §3.4 | `tool_input_invalid` exists precisely because the input did not validate, so the honest `input` on that arm is unvalidated. Widening the static type to `unknown` would force a cast in every `ok: true` branch — real cost in the common path to describe an error path — so the fix is a normative note, not a signature change. |
| 30 | **D5 — a non-429 4xx is `provider_error` with `retryable: false`; `isRetryable()` is the source of truth**, the code is only its default. | §2.9, §3.4 | §2.9 defined `provider_error` as "5xx / network" and put the *code* in the retryable set, leaving 400/401/403 with no code to map to. Retrying a request the provider will reject identically burns all three attempts and reports `max_attempts` instead of the 401 the host must show. Classification therefore sets the flag per instance, and consumers branch on the flag. |
| 31 | **D6 — run-store leases expire on the host clock (`Date.now()`); `createMemoryRunStore()` / `createKeyValueRunStore()` take no clock, by design.** | §2.7 | A lease coordinates *processes*, and every process reads the wall clock. `CopilotOptions.now` is an instance-local seam for heartbeats, staleness and event timestamps; letting it move leases would let a test clock take a lease a live offscreen document still holds. A host that wants otherwise writes its own adapter — which is what `claim` being optional is for. |
| 32 | **D7 — `lazyModel` memoizes success only; a rejected factory is retried on the next attempt.** | §2.1 | "The factory is memoized" and "a rejection surfaces as `provider_error` on that attempt" only cohere under this reading, and it is the MV3 case: the first wake can precede the API key being stored, and a cached rejection would poison every run for the rest of the worker's life. |
| 33 | **D8 — the build emits `.d.ts` (`dist/types/`), and `publishConfig.exports` must name files the build produces** — in this package and in `comment-core`. | §1, §9 | A `types` condition pointing at a file no build step writes is invisible in the workspace (where `exports` resolves to `src`) and resolves to `any` for every published consumer. `comment-core` already emits declarations; this package advertised them without producing them. |

### 8.2 Wave-2 bridge rulings (D9–D11)

Wave 2 built the §6 bridge for real. Three points where the listing above described something the
extension does not (and should not) do. Nothing in §2 moved: all three are host-side, and §6 is
now the code that ships.

| # | Ruled | Where it lands | Why |
|---|---|---|---|
| 34 | **D9 — the bridge's one tab lookup is `TabRouter.tabsForPageKey(pageKey): Promise<number[]>`, plural**, recomputed from `tabs.query` per call; tool calls take the first tab, page notifications fan out to all of them. The singular `tabForPageKey` is gone. | §6 (transport, `toPage`, every `copilot.on` notifier) | Two facts the singular form cannot express. (a) The same document open in two tabs is two content scripts with two chip maps; a notification delivered to one is a bug in the other. (b) `sendMessage(type, data)` with no tab argument is `chrome.runtime.sendMessage`, which reaches extension pages and **never** a content script — so a tab-less notify rejects with `lastError`, is swallowed by its own `.catch`, and silently kills the chip, the pill, the failure state and every toast for the whole session. Making the plural, tab-targeting form the *only* available primitive is what keeps that from being re-introduced. Not cached, either: a map in worker memory dies every 30 s, and a run that outlived its worker would then find "no open tab" for a page that is right there. |
| 35 | **D10 — `get_thread_element_html` is a SW-local `defineTool` that calls the transport itself and answers `{ source: 'live' \| 'capture'; html: string \| null; note?: string }`**, falling back to `thread.capture.outerHTML`; `aborted` propagates untouched. The page half still answers `string \| null`. | §6 (both halves), §3.4, §7.1 | PLAN §5's tool table promises the capture fallback, and a bare `remoteTool` cannot keep it: as a plain `string \| null`, "the element is gone" (orphaned thread — a real, useful answer) and "no tab has this page open" (transport failure) collapse into the same `null`, and the model has no way to tell what it is looking at. The wrapper makes the closed-tab case a *degraded answer* instead of an error the model must recover from, and `source` is what stops it from reading a stale capture as the live DOM. `aborted` is the one failure that must not become a successful capture read, or a cancel would silently produce output. |
| 36 | **D11 — there is no thread → run index.** "Which threads are busy?" and "which batch run covers this thread?" are both projections of `copilot.list({ state: ['queued', 'processing'] })` over `run.context.threadIds ?? [run.context.threadId]`, deduped. The `exp-spec:host:run:*` range and its `indexRun` / `runsForThreads` / `clearRunIndex` / `clearRunIndexForThread` accessors are deleted. | §6 (`copilot:busyThreads`, the `thread:delete` observer), SPEC-comment-core §6 key table | The index existed because a batch run's id is page-prefixed, so `cancelByPrefix('c:{threadId}:')` cannot find it — but the run store already records, durably and in the same `chrome.storage`, both which runs are live and which threads each one speaks for. A mirror of a durable fact is not redundancy, it is a second truth with two ways to be wrong: stale, when a settle's sweep lost the race with a worker death, and missing, when a trigger's write did. It also had a failure mode of its own — one slot per thread erased a live run whenever a second covered the same thread — which the derivation cannot have, because it reads the runs themselves. The `idPrefix: 'c:'` filter in the old §6 listing was the same bug one level up: it excluded exactly the batch runs the index was added to find. |

---

## 9. Definition of done

* Every symbol in §2 is exported with exactly the listed signature.
* `runStoreConformance()` passes against `createMemoryRunStore`, `createKeyValueRunStore`, and
  the extension's `chrome.storage` adapter.
* Ordering rules §3.3.1–13 each have a named test.
* The `kill()` / `revive()` / `resumePending()` cycle in §7.4 is a passing test, and asserts the
  host append runs exactly once given an idempotent `id`.
* A test with `concurrency: 1` triggers three runs, advances time past `STALE_AFTER_MS` with
  the watchdog firing, and asserts the two queued runs still have `attempts === 1` and all
  three complete — the queued-vs-abandoned distinction of §3.1.
* A test asserts `attach()` from a second instance over the same store settles `result()`
  after the owning instance writes a terminal state, without any cross-instance channel.
* A test asserts `destroy()` settles every outstanding `result()` with
  `{ ok: false, reason: 'cancelled' }` and leaves the durable record resumable.
* A test asserts a `rate_limited` run waits `retryDelayMs(attempt)` between attempts rather
  than burning all three inside one tick.
* A test triggers with `model` (a `models` key), `tools` and `maxSteps`, kills the instance, and
  asserts a **fresh instance over the same store** replays all three from `run.spec` — the named
  tier is used, the excluded tool is never executed, and the step cap is the trigger's, not the
  new instance's default (§2.2). A companion test asserts a trigger with no overrides writes no
  `spec` at all, and that an unknown model key / unknown tool name in a snapshot degrades to the
  default provider / a dropped tool with an `error` event, never a thrown `resumePending()`.
* `runStoreConformance()` asserts the `spec` snapshot round-trips through the store with the other
  nine fields.
* `pnpm --filter <pkg> build` produces every file named by `publishConfig.exports` in both
  packages, `.d.ts` included, and a consumer type-check against the emitted declarations resolves
  the public API (not `any`).
* A CI test imports `copilot` and `copilot/testing` with `document`, `window`, `navigator`,
  `localStorage` and `chrome` deleted from `globalThis`, and asserts `createCopilot` is
  callable with `scriptedModel()`.
* `grep -rE "chrome\.|wxt/|from 'comment-core'|document\.|window\." packages/copilot/src`
  returns nothing.
* Type-level test: given three `defineTool` calls, a `switch (call.name)` over
  `ToolCall<typeof tools>` is exhaustive and `call.input` / `call.output` narrow correctly.

---

## 10. Deferred review notes

Findings from the two adversarial reviews that were **not** applied above. Their D-numbers are
local to this section and have nothing to do with the wave-1 implementation rulings D1–D8, which
are applied in the body and recorded in §8.1.

| # | Finding | Why deferred |
|---|---|---|
| D1 | *Re-derive `timeoutMs: 240_000` and the offscreen escape hatch from MV3's 30 s idle timer; Chrome removed the ~5-minute per-event cap in 110.* | The premise is right and the keepalive half is applied (`runtime:active` is now a leading edge, §2.8/§3.3.9). Changing the per-attempt wall clock itself is a tuning decision that wants a measurement of real run durations, not a spec edit — and `timeoutMs` is already an option a host can lower today. Revisit with M4 data. |
| D2 | *Align `copilot.destroy(): Promise<void>` with `comment-core`'s `engine.destroy(): void`; give `handle.on` the `once`/`signal` options `copilot.on` has.* | Cosmetic cross-package symmetry. `destroy()` is async here because it awaits in-flight aborts, and synchronous there because §4.2.11 of that spec makes destruction observable from the return; neither is wrong. `handle.on` is deliberately the narrow form — the handle is already run-scoped and disposable. |
| D3 | *Constrain `TContext extends JsonValue`.* | **Partially applied:** §2.2 now states the JSON round-trip contract normatively and `runStoreConformance()` asserts it. A hard `extends JsonValue` bound is not applied — it makes every host-defined interface (which is not assignable to a recursive `JsonValue` alias without an index signature) fail to compile, which is a worse failure than the one it prevents. |
