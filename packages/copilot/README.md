# @astrale-os/browser-copilot

**A generic LLM agent runtime for the browser, built for processes that die.** Trigger a run,
listen to events, register typed tools. The runtime keeps every run as a durable record, so a
Manifest V3 service worker that gets terminated 30 seconds into a job wakes up, calls one
method, and finishes it — on the same model tier, with the same tool subset, under the same
step cap the original trigger asked for.

It knows nothing about comments, or about your app. It has **zero imports of
`@astrale-os/comment-core`**, and it never touches `document`, `window`, `navigator`,
`localStorage` or `chrome` — not at module scope, not at runtime. DOM access is a `remoteTool`
away; MV3 keepalive is two events away.

```
trigger()                claim + start           model finishes
   ─────────▶  queued  ──────────────▶  processing  ──────────▶  done
                 │                          │
                 │ cancel                   │ cancel / abort
                 ▼                          ▼
             cancelled                  cancelled
                 ▲                          │
                 │                          │ attempt fails
                 └──── attempts < 3 ── queued ── attempts = 3 ─▶ error
```

**Runs are data, not promises.** `trigger()` is synchronous. `result()` never rejects.
`cancel()` never rejects. The runtime never produces an unhandled rejection — which matters a
great deal in a worker that is about to be killed anyway.

---

## Install

```sh
npm i @astrale-os/browser-copilot ai
npm i @ai-sdk/anthropic zod   # your provider + your schema library
```

Runtime dependencies: `ai` (v6+) and `nanoid`. Provider packages, schema libraries (any
[Standard Schema](https://standardschema.dev) implementation — zod v4, valibot, arktype) and
messaging are yours: they are peer-optional and never imported by this package.

| Subpath | Contents | DOM |
|---|---|---|
| `@astrale-os/browser-copilot` | `createCopilot`, tools, transports, run stores, errors, types | never |
| `@astrale-os/browser-copilot/testing` | scripted model, run-store conformance, kill/revive harness | never |

Build: Vite lib mode, ESM + IIFE. IIFE global: `Copilot`.

---

## Quick start

```ts
import { anthropic } from '@ai-sdk/anthropic'
import { z } from 'zod'

import { createCopilot, defineTool } from '@astrale-os/browser-copilot'

const copilot = createCopilot({
  provider: anthropic('claude-opus-5'),
  systemPrompt: 'You help the user understand what they are reading. Be terse.',
  tools: [
    defineTool({
      name: 'fetch_text',
      description: 'Plain text of a URL',
      inputSchema: z.object({ url: z.url(), maxChars: z.number().default(4000) }),
      execute: async ({ url, maxChars }, { signal }) =>
        (await (await fetch(url, { signal })).text()).slice(0, maxChars),
    }),
  ] as const,
})

const result = await copilot
  .trigger({ input: 'Summarise https://example.com in one sentence.' })
  .result()

console.log(result.ok ? result.output : result.error?.code)
```

`runStore` defaults to memory, `maxSteps` to 8, `concurrency` to 1, streaming is always on. And
`copilot.tools.names` is `readonly "fetch_text"[]` — not `string[]`.

---

## Typed tools

`defineTool` uses `const TName` plus Standard Schema inference, and that is what turns tool
activity into an **exhaustive switch with no casts**. Add a tool and the compiler points at
every place that has to handle it.

```ts
import { z } from 'zod'
import type { ToolTransport } from '@astrale-os/browser-copilot'
import { createCopilot, CopilotError, lazyModel, toolsFor } from '@astrale-os/browser-copilot'

// `toolsFor<Ctx>()` binds the context type once, so every `ctx.context` below is `Ctx`.
type Ctx = { threadId: string; pageKey: string }
const { defineTool, remoteTool } = toolsFor<Ctx>()

const transport: ToolTransport<Ctx> = {
  call: (name, input, { context }) => sendToPage(name, input, context.pageKey),
}

const tools = [
  defineTool({
    name: 'read_thread',
    description: 'Full thread with comments',
    inputSchema: z.object({ threadId: z.string() }),
    execute: ({ threadId }) => readThread(threadId),
  }),
  remoteTool(
    {
      name: 'get_element_html',
      description: 'Live HTML of the anchored element',
      inputSchema: z.object({ threadId: z.string() }),
      timeoutMs: 5_000,
    },
    transport,
  ),
] as const

const copilot = createCopilot<typeof tools, Ctx>({
  provider: lazyModel(() => loadModel()),
  renderContext: (c) => `thread=${c.threadId} page=${c.pageKey}`,
  tools,
})

copilot.on('run:step', ({ calls }) => {
  for (const call of calls) {
    switch (call.name) {
      case 'read_thread':
        if (call.ok) console.debug(call.output?.comments.length ?? 0) // typed from execute
        break
      case 'get_element_html':
        if (!call.ok && CopilotError.is(call.error, 'tool_timeout')) degradeToCapture()
        break
    }
  }
})
```

Three things worth knowing:

* **`toolsFor<Ctx>()` is not sugar.** The free `defineTool`'s `TContext` is a trailing type
  parameter with no inference site, so `ctx.context` is `unknown` in every tool written the
  plain way. One line restores it.
* **Tool failures go back to the model**, always, not configurably. A throwing tool becomes a
  tool-result message describing the failure and the loop continues — which is what lets a
  page-reading tool fail on a closed tab and the model fall back to a stored snapshot in the
  same step. `timeoutMs` (default 30 s) produces `tool_timeout` the same way.
* **On a failed call, `call.input` is the model's raw input** and may not satisfy the schema —
  `tool_input_invalid` exists precisely because it did not, and `{}` is reported when the model
  emitted nothing. Read it as evidence about what the model tried, never as a validated value.
  Only the `ok: true` arm carries an input the schema accepted.

### Tools that must run somewhere else

`remoteTool` declares a tool where the loop runs and executes it across a one-method
`ToolTransport`. `serveTools` is the other end. One declaration site for the schema; inputs are
validated on **both** ends, so a malformed model call never reaches the far side.

```ts
import { z } from 'zod'
import { defineTool, serveTools } from '@astrale-os/browser-copilot'

const served = serveTools([
  defineTool({
    name: 'get_page_context',
    description: 'URL, title, heading outline, selection',
    inputSchema: z.object({}),
    execute: () => ({
      url: location.href,
      title: document.title,
      selection: getSelection()?.toString() ?? null,
    }),
  }),
] as const)

// `handle` re-validates the input, builds the AbortSignal and enforces `timeoutMs` on this side.
for (const name of served.names) onMessage(`tool:${name}`, (data) => served.handle(name, data))
```

`ToolTransport.call` receives the run's `context` verbatim. That is deliberate: without it, a
remote tool could only learn its destination from a model-generated argument — routing a value
the runtime already holds through the LLM — and the transport could only guess "the active
tab" instead of targeting the run's own page.

---

## The run lifecycle

### The record

Ten fields. Nothing else is persisted; per-step text, tool calls and usage live in the event
stream and in `RunResult`.

| Field | Type | Notes |
|---|---|---|
| `id` | `string` | Host-composable. Prefix it (`c:{threadId}:{commentId}`) and `cancelByPrefix` / `list({ idPrefix })` become free queries. |
| `state` | `'queued' \| 'processing' \| 'done' \| 'error' \| 'cancelled'` | The last three are absorbing. |
| `input` | `string` | The prompt. |
| `output` | `string?` | Set on done. |
| `error` | `string?` | Set on error. A retry is a **new run**, never a mutation of this one. |
| `attempts` | `number` | Incremented when an attempt *starts*. |
| `heartbeat` | `string` | Bumped every step, by the 10 s ticker while processing, **and while queued in a live queue**. |
| `createdAt` | `string` | ISO. |
| `context` | `TContext` | Opaque. Reaches the prompt only via `renderContext`, and tools via `ToolContext.context`. |
| `spec` | `RunSpec?` | `{ model?, tools?, maxSteps? }` — written once at trigger time, only when overrides were given. |

**`spec` is what makes a restart a replay of the same run.** `resumePending()` in a fresh
process reads a record, not a `TriggerInput`, so without it a resumed run would silently run on
the default provider with the full tool registry — a different run wearing the same `runId`,
whose output your idempotent write-back would happily commit.

| `spec` member | Resolved at attempt start as | If it cannot be resolved |
|---|---|---|
| `model` | `options.models[spec.model]` | falls back to `provider`, `run:start.model` is `'default'`, one `error` event (`unknown_model`) |
| `tools` | `registry.subset(spec.tools)` | unknown names dropped, one `error` event each (`unknown_tool`) |
| `maxSteps` | used verbatim | — |

A resume must never *fail* because the reviving process registers different tiers. Note that
`model` is snapshotted as a **key of `options.models`**: an inline `LanguageModelLike` is not
serialisable, so `trigger({ model: someInstance })` records nothing. `system` is not
snapshotted either — put per-run prompt shaping in `systemPrompt(run)` (a function of the
record, reproducible anywhere) or in `context`, which is durable by construction.

`TContext` must be **JSON round-trippable**. It is written to the store and read back in another
process, so a `Date`, `Map`, `Set` or class instance goes in and comes back as something else
while still typed `TContext`. The runtime does not clone, revive or validate it.

### Events

Thirteen of them. Every state transition is written to the `RunStore` **before** its event
fires, so inside a `run:done` handler `await copilot.get(runId)` already reflects it.

| Event | Payload | When |
|---|---|---|
| `run:queued` | `{ runId, run }` | once per run, after the first durable write; **not** re-emitted on resume |
| `run:start` | `{ runId, run, attempt, resumed, model }` | each attempt |
| `run:token` | `{ runId, delta, step }` | best-effort, lossy by contract — may be entirely absent |
| `tool:call` | `{ runId, step, name, input }` | always before its `tool:result` |
| `tool:result` | `{ runId, step, call, durationMs }` | `call` is the typed `ToolCall<TTools>` |
| `run:step` | `{ runId, run, step, text, calls, usage, finishReason }` | each step boundary, after its `tool:*` |
| `run:done` | `{ runId, run, output, steps, usage, durationMs }` | terminal |
| `run:error` | `{ runId, run, error, attempt, willRetry }` | **`willRetry: true` is not terminal** — a fresh `run:start` follows |
| `run:cancelled` | `{ runId, run, reason, at: 'queued' \| 'processing' }` | terminal |
| `run:settled` | `{ runId, run, result }` | exactly one per run **per emitting instance**, after the final terminal |
| `runtime:active` | `{ activeRuns }` | 0→1 edge, **leading and undelayed** |
| `runtime:idle` | `{ activeRuns: 0 }` | 1→0 edge, trailing-debounced 500 ms |
| `error` | `{ error, scope, runId? }` | `scope`: `provider \| tool \| store \| listener \| transport \| context` |

Bind **`run:settled`** when you only care that the work is over — it saves you three bindings
and it fires whatever happened.

Ordering guarantees:

1. Canonical per-attempt sequence: `run:start` → (`run:token`\* interleaved with
   (`tool:call` → `tool:result`)\* and `run:step` at each boundary) → exactly one of
   `run:done` | `run:error` | `run:cancelled`. Nothing follows the terminal for that attempt.
2. Run-scoped listeners (`handle.on`, `on(_, _, { runId })`) fire **before** global ones; the
   `*` firehose fires after typed listeners.
3. `seq` is monotonic **per run, per emitting instance**, across that instance's attempts.
   There is no shared cross-context counter and there will not be one.
4. Cross-run interleaving is arbitrary when `concurrency > 1`. Per-run order is total; global
   order is not.
5. **Never build state on tokens.** `run:token` may be absent entirely (a provider without
   streaming, or no listener attached). `run:done` and the run store are the durable channel.

### Idempotency

| You call | You get |
|---|---|
| `trigger({ runId })` where the run exists and is **non-terminal** | a handle onto it, `deduped: true`, no new work, no `run:queued` |
| `trigger({ runId })` where the run exists and is **terminal** | a handle whose `result()` resolves immediately from the record, `deduped: true` |
| `trigger()` with no `runId` | a fresh id from `createId()` |
| `cancel(unknownId)` / `cancel(terminalId)` | `false`, no event, never throws |
| `attach(unknownId)` | a handle whose `result()` resolves `{ ok: false, reason: 'error', error: run_not_found }` |
| `resumePending()` from two contexts at once | both safe: with `store.claim` the loser reports `skipped`; without it, double-processing is possible-but-harmless (terminal write is last-writer-wins on the same id) |

Compose your run ids and this becomes a real key: a replayed message after a restart cannot
double-spend tokens or double-post a reply.

---

## Surviving Manifest V3

This is the part the runtime exists for. Four duties, and the runtime hands you a primitive for
each.

| Duty | Primitive | Host cost |
|---|---|---|
| Keepalive while work is outstanding | `runtime:active` / `runtime:idle` | 3 lines |
| Watchdog after the worker died | `resumePending()` | 3 lines (`chrome.alarms`, 30 s floor) |
| Token relay to the open page | `subscribe()` + your own projection | ~10 lines |
| Idempotent write-back | `run:done.runId` as the key | 1 line |
| Visible failure after 3 dead attempts | `run:error` with `willRetry: false` | 3 lines |
| "Which threads are busy?" after a restart | `list({ state, idPrefix })` | 3 lines |
| Offscreen-document escape hatch | `RunStore.claim` | ~10 lines |

```ts
/* --- 1. keepalive: two events bracket every ping the host needs --- */
let keepalive: ReturnType<typeof setInterval> | undefined
copilot.on('runtime:active', () => {
  keepalive ??= setInterval(() => void chrome.runtime.getPlatformInfo(), 25_000)
})
copilot.on('runtime:idle', () => {
  clearInterval(keepalive)
  keepalive = undefined
})

/* --- 2. watchdog: resumePending() on every wake --- */
chrome.alarms.create('copilot-watchdog', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'copilot-watchdog') void copilot.resumePending()
})
chrome.runtime.onStartup.addListener(() => void copilot.resumePending())
void copilot.resumePending()
```

`runtime:active` is a **leading, undelayed** edge on purpose. The live MV3 constraint is the
30-second idle timer, which a silent `fetch` does not reset, so a 500 ms-delayed keepalive is a
500 ms hole at exactly the wrong moment. `runtime:idle` is trailing-debounced 500 ms, so a gap
between two runs does not thrash your interval. Starting late can kill a run; stopping late
costs one ping.

### `lazyModel`, and why listener registration order is not style

MV3 only wakes a terminated worker for listeners registered in the **first turn** of initial
evaluation. A top-level `await getApiKey()` before your `chrome.*` listeners forfeits every
wake event the whole survival story depends on. `lazyModel` moves the `await` inside the first
attempt, where it is free:

```ts
provider: lazyModel(() => getAnthropic().then((a) => a('claude-opus-5')))
```

The factory **memoizes success only**. A rejected factory is not cached: the rejection surfaces
as `provider_error` on that attempt and the next attempt calls it again — because the first
wake can legitimately precede the API key being stored, and a cached rejection would poison
every run for the rest of the worker's life.

### Re-attaching, and the relay

`RunStore` has no `subscribe` and the terminal state is written by the *processing* instance, so
an attaching instance has no push channel. `attach(runId)` therefore **polls** `runStore.get`
every 5 s until the record is terminal, then settles `result()` and emits the terminal locally.
Polling stops on settle, on `destroy()`, and when nobody is listening. A handle for a run this
instance owns never polls.

That is also why `run:settled` is unique **per instance**, not per run: a worker that owns a run
and an options page attached to it each emit their own.

**Cross-context uniqueness is the relay's job**, and so is projection. Exactly four payloads are
structured-clone-safe and post verbatim — `run:token`, `run:queued`, `run:done`,
`run:cancelled`. Everything else carries a live `CopilotError`, and `CopilotError` is an `Error`
subclass, so structured clone silently drops `code`, `retryable`, `runId` and `toolName` and
throws `DataCloneError` on a non-cloneable `.cause`. `code` is the field your page branches on.

```ts
const CLONE_SAFE = new Set(['run:token', 'run:queued', 'run:done', 'run:cancelled'])

function project(event: CopilotEvent): unknown {
  if (CLONE_SAFE.has(event.type)) return event
  if (event.type === 'run:step') {
    // Every failed ToolCall holds a live CopilotError — same duty.
    const calls = event.payload.calls.map((c) => (c.ok ? c : { ...c, error: c.error.toJSON() }))
    return { ...event, payload: { ...event.payload, calls } }
  }
  if (event.type === 'run:error') {
    return { ...event, payload: { ...event.payload, error: event.payload.error.toJSON() } }
  }
  return null // this relay forwards nothing else
}

chrome.runtime.onConnect.addListener((port) => {
  const off = copilot.subscribe((event) => {
    const projected = project(event)
    if (projected !== null) port.postMessage(projected)
  })
  port.onDisconnect.addListener(off)
})
```

On the receiving end, **dedupe and order on `(runId, instanceId, seq)`**. `seq` is per run per
instance, so keep a high-water mark per `(runId, instanceId)` stream and drop anything at or
below it. Across instances, order by `at`; ties are arbitrary. A relay that forwards two
instances' `run:settled` for one run and lets the page act on both has skipped this step — it
has not hit a runtime bug.

An open port also extends the worker's lifetime, which is why the streaming channel should be a
port rather than a broadcast.

### Level-triggered recovery

`run:queued` / `run:settled` are edges emitted by one instance. After a worker death a page has
no way to ask "who is busy?" unless you give it one — and the run store already knows:

```ts
const busy = await copilot.list({ state: ['queued', 'processing'], idPrefix: 'c:' })
```

### Constants you cannot configure

`MAX_ATTEMPTS = 3`, `STALE_AFTER_MS = 60_000` (overridable per `resumePending()` call),
`HEARTBEAT_MS = 10_000`, and `retryDelayMs(attempt) = min(2 ** attempt * 1000, 30_000)` — 2 s,
then 4 s. Each has exactly one defensible value here; an option with one defensible value is a
decision the implementer will get wrong. The backoff in particular is not zero: `rate_limited`
is retryable, so an immediate requeue turns one 429 into three 429s inside a few milliseconds
and a `max_attempts` terminal — strictly worse than a single attempt.

A **queued run in a live queue is not abandoned**: its heartbeat keeps ticking while it waits on
`concurrency` or on the retry delay, and `resumePending()` skips run ids the local queue already
holds. Without both halves, `concurrency: 1` plus a 30 s watchdog terminates every run but the
first as `max_attempts` without ever calling the model.

---

## Run stores

Three methods required, one optional. There is no `delete` (retention is adapter policy — a
ring buffer inside `put` is five lines) and no `subscribe` (cross-context observation is a Port
relay, which is a host duty and also extends worker lifetime).

| Factory | Backing | Use it for |
|---|---|---|
| `createMemoryRunStore()` | a `Map` | tests, page-hosted runs; adds `snapshot()` and an in-memory `claim` |
| `createKeyValueRunStore(kv, { namespace, keep })` | any `KeyValueAdapter` | production; key layout `{ns}:r:{runId}`, `keep` ring-buffers terminal runs on write, `claim` over a lease key |
| `defineRunStore(store)` | yours | identity function that preserves the literal type |

```ts
import { createKeyValueRunStore, createMemoryRunStore, defineRunStore } from '@astrale-os/browser-copilot'

export const memory = createMemoryRunStore()
export const durable = createKeyValueRunStore(kv, { namespace: 'runs', keep: 200 })

/* Three required methods. `claim` is optional — add it only for multi-context resume safety. */
export const custom = defineRunStore({
  name: 'sqlite',
  get: (id) => db.get(id),
  put: (run) => db.put(run),
  async list(filter) {
    const runs = await db.scan()
    const states = filter?.state === undefined ? null : [filter.state].flat()
    return runs
      .filter((r) => (states === null || states.includes(r.state)) &&
        (filter?.idPrefix === undefined || r.id.startsWith(filter.idPrefix)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, filter?.limit ?? Infinity)
  },
} satisfies RunStore)
```

Contract: `put` resolves only when the write is durable; `list` returns runs sorted by
`createdAt` ascending honouring `filter`; I/O failures throw and the runtime wraps them in
`store_failed`, which is **fatal to the run** — durability is the entire MV3 contract, and a
runtime that cannot write is a runtime whose retries are invisible anyway.

`claim(id, owner, ttlMs)` exists for the offscreen-document escape hatch. Leases expire on the
host clock (`Date.now()`), deliberately: a lease coordinates *processes*, and letting a test's
virtual clock hand out a lease a real second process still holds is not an improvement.
`CopilotOptions.now` drives heartbeats, staleness and event timestamps inside one instance and
nothing else. Run `runStoreConformance()` against your adapter.

---

## Errors

Two planes, and they never mix.

**Programmer errors throw synchronously** from `createCopilot()` or `trigger()` — you want
those at the top of the stack trace, not on the run queue.

| Code | Thrown when |
|---|---|
| `no_provider` | `createCopilot` without a `provider` |
| `duplicate_tool` | two registered tools share a name |
| `unknown_model` | `trigger({ model })` names a key that is not in `models` |
| `unknown_tool` | `trigger({ tools })` names a tool that is not registered |
| `invalid_options` | an unusable option combination |
| `destroyed` | any call after `destroy()` |

**Run errors are always an event plus a `Run` record.** Never a rejection.

| Code | Retryable by default | Meaning |
|---|---|---|
| `provider_error` | **yes**, unless classified otherwise | 5xx or a network failure. A **non-429 4xx is `provider_error` with `retryable: false`** |
| `rate_limited` | yes | 429 |
| `timeout` | yes | the per-attempt wall clock (`timeoutMs`, default 240 s) expired |
| `tool_not_found` | no | the model called a tool that is not registered |
| `tool_input_invalid` | no | Standard Schema rejected the model's arguments |
| `tool_failed` | no | the tool threw |
| `tool_timeout` | no | the tool exceeded its `timeoutMs` (default 30 s) |
| `step_limit` | no | `maxSteps` reached with **no** text to show |
| `context_render_failed` | no | `renderContext` threw — a deterministic function fails identically every time |
| `aborted` | no | you asked for it |
| `run_not_found` | no | `attach()` on an id with no record |
| `store_failed` | no | the run store threw — fatal to the run |
| `max_attempts` | no | three attempts, all failed |

**`isRetryable(e)` is the source of truth; the code is only its default.** Never branch on
`e.code === 'provider_error'` to decide whether to retry: a 401 has no other code to map to, the
provider will reject the identical request identically twice more, and you would spend the whole
attempt budget only to report `max_attempts` instead of the 401 your user needs to see.

`CopilotError` carries `code`, `runId?`, `toolName?`, `retryable`, `cause?`, a
`static is(e, code?)` guard, and `toJSON()` — a structured-clone-safe projection for transports.

Two more policies worth naming:

* **Step limit is not a failure by default.** Reaching `maxSteps` ends the run as `done` with
  `finishReason: 'step-limit'` and whatever text exists. Only if that text is empty does it end
  as `error` / `step_limit`. Never a silent hang.
* **Listener isolation.** A throwing listener produces one `error` event (`scope: 'listener'`)
  and stays subscribed. A listener that throws while handling `error` goes to `options.onError`,
  then `console.error`. `error` never re-emits itself.

---

## API reference

### Construction

| Export | Signature |
|---|---|
| `createCopilot` | `<const TTools, TContext>(options: CopilotOptions<TTools, TContext>) => Copilot<TTools, TContext>` |

| Option | Type | Default |
|---|---|---|
| `provider` | `LanguageModelLike` | **required** |
| `models` | `Record<string, LanguageModelLike>` | `{}` |
| `systemPrompt` | `string \| ((run: Run<TContext>) => Awaitable<string>)` | `''` |
| `tools` | `TTools` | `[]` |
| `runStore` | `RunStore<TContext>` | `createMemoryRunStore()` |
| `renderContext` | `(context: TContext, run: Run<TContext>) => Awaitable<string>` | `JSON.stringify(context, null, 2)` |
| `maxSteps` | `number` | `8` |
| `concurrency` | `number` | `1` |
| `timeoutMs` | `number` | `240_000` (per attempt, not an MV3 budget) |
| `onError` | `(error: CopilotError, scope: ErrorScope) => void` | — |
| `now` / `createId` | `() => Date` / `() => string` | `new Date()` / `nanoid(12)` |

Deliberately absent, each because it has one defensible value: `maxAttempts`, `stream`,
`heartbeatMs`, `staleAfterMs`, retry backoff, tool-error policy, run retention,
temperature/topP (pass a preconfigured model).

### `Copilot`

| Member | Signature | One-liner |
|---|---|---|
| `trigger` | `(input: TriggerInput) => RunHandle` | **Synchronous.** A view over a durable record, not a promise over a computation. |
| `attach` | `(runId: string) => RunHandle` | Re-attach to a run this process did not start; polls foreign runs every 5 s. |
| `cancel` | `(runId, reason?) => Promise<boolean>` | True when a run existed and was queued/processing. Never throws. |
| `cancelByPrefix` | `(prefix, reason?) => Promise<readonly string[]>` | Cancel all work under a run-id prefix; resolves with the ids cancelled. |
| `resumePending` | `(options?: { staleAfterMs?, limit? }) => Promise<ResumeReport>` | Restart runs with stale heartbeats, replaying each run's own `spec`. Idempotent. |
| `get` / `list` | `(runId) => Promise<Run \| null>` / `(filter?: RunFilter) => Promise<Run[]>` | `RunFilter` = `{ state?, idPrefix?, before?, limit? }`. |
| `runs` | `ReadableStore<readonly Run[]>` | Live in-process view of runs this instance touched. |
| `tools` | `ToolRegistry<TTools>` | `names`, `get(name)`, `has(name)`, `schema(name)`. Read-only by design. |
| `on` / `once` / `off` | `(event, listener, options?)` | `options`: `{ once?, signal?, runId? }`. |
| `subscribe` | `(listener: (e: CopilotEvent) => void) => Unsubscribe` | The `*` firehose. |
| `inspect` | `() => CopilotInspection` | Provider/models, per-tool call counts and schemas, run counts by state, config, listener counts. |
| `destroy` | `() => Promise<void>` | Aborts in-flight attempts **without** writing terminal states, so `resumePending()` can pick them up. Settles every outstanding `result()` with `{ ok: false, reason: 'cancelled', error: destroyed }`. |

### `TriggerInput` and `RunHandle`

| `TriggerInput` field | Type | Notes |
|---|---|---|
| `input` | `string` | required |
| `context` | `TContext` | opaque; reaches the prompt only via `renderContext` |
| `runId` | `string` | the idempotency key |
| `model` | `string \| LanguageModelLike` | a key of `models` (snapshotted) or an instance (not) |
| `system` | `string` | per-run prompt override; **not** snapshotted |
| `tools` | `readonly TTools[number]['name'][]` | per-run subset, snapshotted |
| `maxSteps` | `number` | snapshotted |
| `signal` | `AbortSignal` | cancels this run when aborted |

| `RunHandle` member | Signature |
|---|---|
| `id` / `deduped` | `string` / `boolean` |
| `run` | `ReadableStore<Run<TContext> \| null>` — `null` until the initial durable write lands |
| `result()` | `Promise<RunResult<TContext>>` — a discriminated union; **never rejects** |
| `cancel(reason?)` | `Promise<boolean>` |
| `on(event, listener)` | run-scoped, fires before global listeners |
| `tokens()` | `AsyncIterable<string>` — best-effort, ends at the terminal event, may yield nothing |

### Tools

| Export | One-liner |
|---|---|
| `defineTool(def)` | Author a tool; `const TName` + Standard Schema inference. |
| `toolsFor<TContext>()` | Returns `{ defineTool, remoteTool }` bound to a context type. |
| `remoteTool(def, transport)` | Declare here, execute across a `ToolTransport`. |
| `serveTools(tools, options?)` | The other end: `handle(name, input, ctx?)` + `names`. Re-validates, builds the signal, enforces `timeoutMs`. |

### Prompt assembly

Per attempt, in order: `system` = `TriggerInput.system` ?? `systemPrompt(run)` ?? `''`;
`rendered` = `renderContext(run.context, run)` (or `''` when there is no context);
messages = `[system, rendered ? rendered + '\n\n' + run.input : run.input]`; tools filtered by
`TriggerInput.tools` or `run.spec.tools`; loop = AI SDK `ToolLoopAgent` with
`stopWhen: stepCountIs(maxSteps)`, streaming on.

**Runs are stateless.** Nothing from a previous run enters the prompt. Submit and follow-up are
one code path — the host puts the conversation in `context`.

---

## Testing (`@astrale-os/browser-copilot/testing`)

| Export | One-liner |
|---|---|
| `scriptedModel(script?)` | A deterministic `LanguageModelLike`. Streams `text` char by char. Zero-arg default: `[{ text: 'ok' }]`. |
| `runStoreConformance(factory)` | 28 cases: durability, sorting, filtering, upsert, optional `claim`, `spec` round-trip. |
| `createTestCopilot(options?)` | The whole runtime plus an event recorder, `kill()` and `revive()`. |

`kill()` / `revive()` is the only way to test the central claim — that a run outlives the
process that started it:

```ts
import { createTestCopilot, runStoreConformance } from '@astrale-os/browser-copilot/testing'
import { defineTool } from '@astrale-os/browser-copilot'
import { expect, it } from 'vitest'
import { z } from 'zod'

for (const c of runStoreConformance(() => myStore())) it(c.name, c.run)

it('restarts from scratch after service-worker death and posts exactly once', async () => {
  const t = createTestCopilot({
    tools: [
      defineTool({
        name: 'read_thread',
        description: 'stub',
        inputSchema: z.object({}),
        execute: () => ({ comments: [] }),
      }),
    ] as const,
    script: [{ toolCall: { name: 'read_thread', input: {} } }, { text: 'done' }],
  })

  t.copilot.trigger({ runId: 'c:t1:1', input: 'hi', context: { threadId: 't1' } })
  await t.events.waitFor('run:start')
  await t.kill() // the record stays `processing` with a stale heartbeat

  const revived = t.revive()
  expect((await revived.resumePending({ staleAfterMs: 0 })).restarted).toEqual(['c:t1:1'])
  const result = await revived.attach('c:t1:1').result()
  expect(result.ok && result.restarted).toBe(true)
})
```

A scripted `toolCall` must name a **registered** tool, or the loop turns it into
`tool_not_found` fed back to the model and the test exercises the error path instead.

Conformance suites are runner-agnostic `{ name, run }[]` arrays, so vitest, `node:test` and bun
all work with one `for` loop.

---

## What this package deliberately does not have

No middleware, no plugins, no `wrapTool`, no `transformPrompt`. No `ask()` one-shot, no
`triggerMany`, no `BatchHandle`, no `drain`, no `queue` object, no `undoRun`, no `simulate`, no
`watchdog()`, no `explain(runId)`. No tool approval flow, no effect ledger. No
`KeepaliveAdapter` or `TimerAdapter`.

`systemPrompt` as a function and `renderContext` cover prompt shaping; everything else is either
already in the runtime or is a host concern that `on()` reaches in three lines. Batch dispatch,
for instance, is one run with many items in `context` and a per-item tool — not many runs.

---

## License

Apache-2.0 © Astrale.
