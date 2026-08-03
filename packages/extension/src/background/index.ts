/**
 * The service worker (SPEC-copilot §6, SPEC-comment-core §7.3) — the only place the two
 * libraries meet. Neither imports the other; neither mentions `chrome`.
 *
 * **Listener registration order is the contract, not style.** MV3 only wakes a terminated worker
 * for listeners registered in the FIRST turn of initial evaluation. Everything below the
 * `startBackground` call site runs synchronously with no `await` before a single
 * `addListener` — a top-level `await getKey()` anywhere above them would silently forfeit every
 * wake event the whole restart story depends on. `lazyModel` is what moves that await inside a
 * handler, where it is free.
 */

import type {
  Copilot,
  CopilotEvent,
  LanguageModelLike,
  Run,
  RunHandle,
} from '@astrale-os/browser-copilot'
import type { CommentDomain, KeyValueAdapter, StoreEvent } from '@astrale-os/comment-core/headless'

import { createAnthropic } from '@ai-sdk/anthropic'
import { createCopilot, createKeyValueRunStore, lazyModel } from '@astrale-os/browser-copilot'
import {
  createDomain,
  createKeyValueCursor,
  createKeyValueStore,
  observeStore,
} from '@astrale-os/comment-core/headless'

import type { HostState } from '../host-state.ts'
import type { BridgeMessenger } from '../messaging.ts'
import type { AlarmsLike, AlarmLike, PortLike, RuntimeLike } from '../platform.ts'
import type { Kind, Settings } from '../settings.ts'
import type { BridgeTools, RunCtx, TabRouter } from './tools.ts'

import { createHostState } from '../host-state.ts'
import {
  batchRunId,
  batchToken,
  COMMENT_NS,
  CURSOR_CANCEL,
  CURSOR_DISPATCH,
  HOST_NS,
  RUN_NS,
  singleRunId,
  threadRunPrefix,
} from '../keys.ts'
import { RELAY_PORT_NAME } from '../messaging.ts'
import { BATCH_PROMPT, isKind, loadSettings, watchSettings } from '../settings.ts'
import { attachRelay } from './relay.ts'
import { renderContext, renderReview, renderThread } from './render.ts'
import {
  BATCH_MAX_STEPS,
  BATCH_TOOLS,
  buildTools,
  createToolTransport,
  SINGLE_TOOLS,
} from './tools.ts'

/** The object-shaped member of the AI SDK model union — what `lazyModel` returns. */
type ModelV3 = Extract<LanguageModelLike, { specificationVersion: 'v3' }>

/** PLAN §4.5: the documented 25 s API-ping pattern, held only while a run is active. */
export const KEEPALIVE_MS = 25_000
/** `chrome.alarms` minimum period. Survives worker death AND browser restart. */
export const WATCHDOG_ALARM = 'copilot-watchdog'
export const WATCHDOG_PERIOD_MINUTES = 0.5
/** Cap on how many runs one batch dispatch covers, so a runaway page cannot build a 500-thread prompt. */
export const MAX_BATCH_THREADS = 40

export interface BackgroundDeps {
  kv: KeyValueAdapter
  messenger: BridgeMessenger
  runtime: RuntimeLike
  alarms: AlarmsLike
  tabs: TabRouter
  setInterval(handler: () => void, ms: number): number
  clearInterval(handle: number): void
  now?: () => Date
  /**
   * Test seam. Absent ⇒ the real Anthropic provider, resolved lazily from the stored API key.
   * A test supplies `scriptedModel()` and never touches the network.
   */
  modelFactory?: (tier: 'primary' | 'fast', settings: Settings) => LanguageModelLike
}

export interface BackgroundHandle {
  copilot: Copilot<BridgeTools, RunCtx>
  comments: CommentDomain
  host: HostState
  /** Test/inspection hook. Not part of the MV3 story. */
  settings(): Promise<Settings>
  dispose(): Promise<void>
}

export function startBackground(deps: BackgroundDeps): BackgroundHandle {
  const { kv, messenger, runtime, alarms, tabs } = deps
  const now = deps.now ?? (() => new Date())

  const store = createKeyValueStore(kv, { namespace: COMMENT_NS })
  const comments = createDomain(store) // §3.5 rules, no DOM, works with the tab closed
  const host = createHostState(kv, now)

  /* ---------------------------------------------------------------- settings */

  // Read inside handlers, never at module scope. A worker woken by a storage change has no
  // settings in memory and no chance to fetch them before its first listener runs.
  let settingsP: Promise<Settings> | undefined
  const settings = (): Promise<Settings> => (settingsP ??= loadSettings(kv))
  /**
   * Bumped on every settings write. Everything derived from settings — the provider, and the
   * two resolved models — is keyed on it, because `lazyModel` memoizes for the lifetime of the
   * object it returns and `createCopilot` is handed those objects exactly once. Clearing
   * `settingsP` alone would leave a worker running on the key it booted with until the browser
   * killed it: paste a key into the options page, and every run keeps 401-ing on the empty one.
   */
  let settingsEpoch = 0
  const invalidateSettings = (): void => {
    settingsP = undefined
    anthropicP = undefined // the key or the tier may have changed
    settingsEpoch++
  }

  /* ---------------------------------------------------------------- provider */

  let anthropicP: Promise<ReturnType<typeof createAnthropic>> | undefined
  const getAnthropic = (): Promise<ReturnType<typeof createAnthropic>> =>
    (anthropicP ??= settings().then((current) =>
      createAnthropic({
        apiKey: current.apiKey,
        // With `https://api.anthropic.com/*` in host_permissions an extension-context request
        // bypasses CORS entirely; the header is belt-and-suspenders for page contexts.
        headers: { 'anthropic-dangerous-direct-browser-access': 'true' },
      }),
    ))

  const freshModel = (tier: 'primary' | 'fast'): LanguageModelLike => {
    const factory = deps.modelFactory
    if (factory) return lazyModel(async () => factory(tier, await settings()))
    return lazyModel(async () => {
      const current = await settings()
      const anthropic = await getAnthropic()
      return anthropic(tier === 'fast' ? current.fastModel : current.model)
    })
  }

  /**
   * A stable model object handed to `createCopilot` once, which re-resolves its inner
   * `lazyModel` whenever the settings epoch moves. `lazyModel` caches until its factory
   * *rejects*, so a key or tier change is otherwise invisible to an already-resolved model —
   * and `createCopilot` has no API to swap the provider after construction.
   */
  const modelFor = (tier: 'primary' | 'fast'): LanguageModelLike => {
    let epoch = -1
    let inner: ModelV3 | undefined
    const current = (): ModelV3 => {
      if (inner === undefined || epoch !== settingsEpoch) {
        epoch = settingsEpoch
        inner = freshModel(tier) as ModelV3
      }
      return inner
    }
    const model: ModelV3 = {
      specificationVersion: 'v3',
      provider: 'exp-spec.settings',
      get modelId() {
        return current().modelId
      },
      supportedUrls: {},
      doGenerate: (options) => current().doGenerate(options),
      doStream: (options) => current().doStream(options),
    }
    return model
  }

  /* ------------------------------------------------------------------- tools */

  const transport = createToolTransport(messenger, tabs)
  const tools = buildTools({
    comments,
    transport,
    onReply: (threadId) => {
      void host.markUnread(threadId).catch(() => {})
    },
  })

  /* ---------------------------------------------------------------- runtime */

  const copilot = createCopilot<BridgeTools, RunCtx>({
    provider: modelFor('primary'),
    models: { fast: modelFor('fast') },
    runStore: createKeyValueRunStore<RunCtx>(kv, { namespace: RUN_NS, keep: 200 }),
    tools,
    // Per-mode prompt (PLAN §5), resolved per attempt — no cast, `run.context` is typed.
    systemPrompt: async (run) => {
      if (run.context.mode === 'batch') return BATCH_PROMPT
      const current = await settings()
      const kind: Kind = isKind(run.context.kind) ? run.context.kind : 'comment'
      return current.prompts[kind]
    },
    renderContext,
  })

  /* ------------------------------------------------------- live-run derivation */

  /**
   * **The bridge keeps no thread→run index.** It used to: a durable `exp-spec:host:run:*` range,
   * written at every trigger and swept at every settle, so that "which threads are busy?" and
   * "which batch run covers this thread?" were answerable. Both questions are answered by the run
   * store itself — a live run already carries every thread it covers in `run.context`, and the run
   * store is the same `chrome.storage` durability the index was mirroring. A mirror of a durable
   * record is not extra safety, it is a second truth that can only ever be *wrong*: stale when a
   * settle's sweep lost the race with a worker death, missing when a trigger's write did.
   */
  const liveRuns = (): Promise<Run<RunCtx>[]> => copilot.list({ state: ['queued', 'processing'] })

  /**
   * Every thread a run speaks for. A single run covers exactly its own thread; a batch run
   * carries the list. The `??` is the whole difference, and it belongs in one place — every
   * notification, the busy answer and the cancel scan must agree on it or a batch run drops
   * eleven of its twelve threads somewhere.
   */
  const threadsOf = (context: RunCtx): readonly string[] => context.threadIds ?? [context.threadId]

  /* --------------------------------------------------------------- dispatch */

  async function dispatchSingle(
    threadId: string,
    commentId: string,
    kind: string,
    pageKey: string,
  ): Promise<RunHandle<BridgeTools, RunCtx> | null> {
    const record = await comments.get(threadId)
    if (!record) return null // deleted between the write and the wake
    return copilot.trigger({
      // Idempotency key: an SW replay of the same store event cannot double-trigger.
      runId: singleRunId(threadId, commentId),
      input: renderThread(record),
      context: { threadId, kind, pageKey, mode: 'single' },
      // `model` as a `models` KEY and `tools` are snapshotted into `run.spec` (§2.2), so the
      // watchdog restarts an `ask` run on the fast tier and without `reply_to_thread` even
      // though the worker that issued this trigger is long dead.
      ...(kind === 'ask' ? { model: 'fast' as const } : {}),
      tools: SINGLE_TOOLS,
    })
  }

  async function dispatchBatch(
    pageKey: string,
    threadIds: readonly string[],
  ): Promise<{ ok: boolean; runId?: string; reason?: string }> {
    const wanted = threadIds.slice(0, MAX_BATCH_THREADS)
    const records = (await Promise.all(wanted.map((id) => comments.get(id)))).filter(
      (record): record is NonNullable<typeof record> => record !== null,
    )
    if (records.length === 0) return { ok: false, reason: 'no threads' }

    const ids = records.map((record) => record.thread.id)
    // Content-addressed over (thread, tip comment) pairs, NOT over the thread ids alone. The id
    // set alone would make a run id a permanent fingerprint of that set: after the first review
    // settled, every later Send on the same threads would dedupe against the terminal record —
    // pending cleared, `{ ok: true }` returned, nothing run, no error. The tips move with every
    // human reply, so a genuine re-review gets a genuine run and an SW replay of one submit
    // still dedupes.
    const tokens = records.map((record) => batchToken(record.thread.id, record.comments.at(-1)?.id))
    const handle = copilot.trigger({
      runId: batchRunId(pageKey, tokens),
      input: renderReview(records, pageKey),
      // `mode: 'batch'` is what stops the global run:done handler from appending this run's
      // summary as a comment in ids[0]; the per-thread writes are reply_to_thread's job.
      context: { threadId: ids[0]!, kind: 'comment', pageKey, mode: 'batch', threadIds: ids },
      tools: BATCH_TOOLS,
      maxSteps: BATCH_MAX_STEPS,
    })
    // The pending set has served its purpose the moment the run exists durably; leaving it
    // would make the pill re-offer work that is already running.
    await host.clearPendingMany(
      (await host.listPending(pageKey)).filter((entry) => ids.includes(entry.threadId)),
    )
    for (const id of ids) notifyPending(pageKey, id, false)
    return { ok: true, runId: handle.id }
  }

  /* ---------------------------------------------- best-effort page notifications */

  /**
   * **Every SW → page message needs a tab id.** `sendMessage(type, data)` is
   * `chrome.runtime.sendMessage`, which reaches extension pages and never a content script;
   * only `chrome.tabs.sendMessage(tabId, …)` does. Without this fan-out the four notifications
   * below reject with `lastError`, get swallowed by their own `.catch`, and the pill, the busy
   * spinner, the failure chip and every toast are dead for the whole session.
   *
   * Fanning out over *all* tabs on the page, not the first, because the same document open in
   * two tabs is two content scripts, each with its own chip map.
   *
   * A rejected send is still normal operation (the tab closed between the query and the send),
   * which is why each one is individually caught.
   */
  const toPage = (pageKey: string, send: (tabId: number) => Promise<unknown>): Promise<unknown[]> =>
    tabs
      .tabsForPageKey(pageKey)
      .then((ids) => Promise.all(ids.map((tabId) => send(tabId).catch(() => undefined))))
      .catch(() => [])

  const notifyBusy = (pageKey: string, threadId: string, busy: boolean): void => {
    void toPage(pageKey, (tabId) =>
      messenger.sendMessage('copilot:busy', { threadId, busy }, tabId),
    )
  }
  const notifyPending = (pageKey: string, threadId: string, pending: boolean): void => {
    void toPage(pageKey, (tabId) =>
      messenger.sendMessage('copilot:pending', { threadId, pending }, tabId),
    )
  }
  const notifyFailed = (pageKey: string, threadId: string, code: string): void => {
    void toPage(pageKey, (tabId) =>
      messenger.sendMessage('copilot:failed', { threadId, code }, tabId),
    )
  }
  const toast = (pageKey: string, text: string, tone: 'info' | 'warn' = 'info'): void => {
    void toPage(pageKey, (tabId) => messenger.sendMessage('copilot:toast', { text, tone }, tabId))
  }

  /* ------------------------------------------------------- hooks (no messaging) */

  // `chrome.storage.onChanged` even wakes a dormant worker. The durable cursor is what makes
  // that useful: a fresh worker's in-memory baseline would be taken AFTER the write that woke
  // it, and the create would be invisible.
  const stopDispatch = observeStore(
    store,
    async (event: StoreEvent) => {
      if (event.type !== 'thread:create' && event.type !== 'thread:reply') return
      const { thread, comment } = event.payload
      // PLAN §8: the author field is the ONLY trigger-loop guard. A copilot reply that
      // re-triggered the copilot would run until the attempt cap on every thread.
      if (comment.author !== 'user') return

      const current = await settings()
      if (!current.enabled) return
      const kind: Kind = isKind(thread.kind) ? thread.kind : 'comment'

      // The same guard `copilot:sendBatch` applies, and for the same reason: without a key every
      // attempt 401s, the run dies as `max_attempts`, and a keyless install burns three provider
      // round trips per comment to produce a thread with no reply and no explanation. Parking it
      // in the pending set keeps the work — one Send after pasting a key dispatches all of it.
      if (!current.apiKey || current.dispatch[kind] === 'manual') {
        await host.markPending({ threadId: thread.id, pageKey: thread.pageKey, kind })
        notifyPending(thread.pageKey, thread.id, true)
        if (!current.apiKey) {
          toast(thread.pageKey, 'copilot needs an API key — open the options page', 'warn')
        }
        return
      }
      // Awaited, so a throw replays the event on the next notification rather than losing it.
      await dispatchSingle(thread.id, comment.id, kind, thread.pageKey)
    },
    { cursor: createKeyValueCursor(kv, { namespace: HOST_NS, id: CURSOR_DISPATCH }) },
  )

  const cancelRunsForThread = (threadId: string): Promise<readonly string[]> =>
    copilot.cancelByPrefix(threadRunPrefix(threadId), 'thread deleted')

  const stopCancel = observeStore(
    store,
    async (event: StoreEvent) => {
      if (event.type !== 'thread:delete') return
      const threadId = event.payload.thread.id
      // Batch runs are page-prefixed, so the prefix scan cannot see them — the live-run scan can,
      // and it carries the covered thread list with it, so no second `copilot.get` is needed.
      const batches = (await liveRuns()).filter(
        (run) => run.context.mode === 'batch' && threadsOf(run.context).includes(threadId),
      )
      await cancelRunsForThread(threadId)
      for (const run of batches) {
        // A batch run owes replies to every thread it covers. Cancelling all of them because
        // one was deleted throws away the other N−1 answers — and `reply_to_thread` already
        // returns `'thread deleted'` for the gone one, so the run degrades on its own. Cancel
        // only when nothing it could still reply to is left.
        const covered = threadsOf(run.context).filter((id) => id !== threadId)
        const survivors = await Promise.all(covered.map((id) => comments.get(id)))
        if (survivors.every((record) => record === null)) {
          await copilot.cancel(run.id, 'thread deleted')
        }
      }
      await host.forgetThread(threadId)
    },
    { cursor: createKeyValueCursor(kv, { namespace: HOST_NS, id: CURSOR_CANCEL }) },
  )

  /* ----------------------------------------------------------- run → thread */

  const offDone = copilot.on('run:done', async ({ runId, run, output }) => {
    if (run.context.mode !== 'single') {
      // A batch run's output is a summary over many threads (PLAN §5), surfaced as a toast.
      if (output.trim()) toast(run.context.pageKey, output.trim())
      return
    }
    if (!(await comments.get(run.context.threadId))) return // deleted mid-run → drop the output
    if (!output.trim()) return
    await comments.appendComment(run.context.threadId, {
      author: 'copilot',
      body: output,
      // The idempotency key: a restarted run cannot double-post.
      id: `r:${runId}`,
    })
    await host.markUnread(run.context.threadId)
  })

  // A dead run must be visible. Three worker deaths terminate a run as `max_attempts`; without
  // this the user sees a comment with no reply, no error, and a cleared chip.
  const offError = copilot.on('run:error', ({ run, error, willRetry }) => {
    if (willRetry) return
    // EVERY thread of the run, exactly like run:queued and run:settled. Notifying only
    // `threadIds[0]` left the other eleven threads of a dead batch with their busy chip cleared
    // and no failure state — the "a dead run must not look like no run" case, one thread wide.
    for (const threadId of threadsOf(run.context)) {
      // Durable, because `refresh()` rebuilds the chip map from durable state and would
      // otherwise erase this on the next SPA navigation or page load.
      void host.markFailed(threadId, error.code).catch(() => {})
      notifyFailed(run.context.pageKey, threadId, error.code)
    }
    if (run.context.mode === 'batch') {
      toast(run.context.pageKey, `copilot batch run failed (${error.code})`, 'warn')
    }
  })

  const offQueued = copilot.on('run:queued', ({ run }) => {
    for (const threadId of threadsOf(run.context)) {
      // A new run supersedes the previous run's failure, durably as well as on screen.
      void host.clearFailed(threadId).catch(() => {})
      notifyBusy(run.context.pageKey, threadId, true)
    }
  })

  // One event to clear the chip, whatever happened. Nothing durable to sweep: the run record
  // leaving `queued`/`processing` *is* the sweep.
  const offSettled = copilot.on('run:settled', ({ run }) => {
    for (const threadId of threadsOf(run.context)) {
      notifyBusy(run.context.pageKey, threadId, false)
    }
  })

  /* -------------------------------------------------------------- messaging */

  messenger.onMessage('copilot:busyThreads', async () => {
    // Level-triggered: run:queued/run:settled are edges emitted by ONE instance, so after a
    // worker death the page has no other way to ask "who is busy?". The run store answers it
    // directly — a run in `queued`/`processing` is the definition of busy, and it names its own
    // threads. Deduped because two live runs may cover the same thread.
    const live = await liveRuns()
    return [...new Set(live.flatMap((run) => threadsOf(run.context)))]
  })

  messenger.onMessage('copilot:sendBatch', async ({ data }) => {
    const current = await settings()
    if (!current.enabled) return { ok: false, reason: 'copilot disabled in options' }
    if (!current.apiKey) return { ok: false, reason: 'no API key set — open the options page' }
    return dispatchBatch(data.pageKey, data.threadIds)
  })

  // There is deliberately no `page:hello`. It stored nothing, and the routing it claimed to
  // enable is `tabs.query`-derived (`createTabRouter`), which survives a worker death and needs
  // no announcement — so it was one extra service-worker wake per page load in every tab.

  // `watchSettings`, not a hand-rolled `kv.watch` with an `endsWith(':settings')` predicate: the
  // content script already watches the same key through it, and two spellings of "the settings
  // changed" is how one of them ends up watching a key nothing writes.
  const stopSettingsWatch = watchSettings(kv, invalidateSettings)

  /* ------------------------------------------------------- MV3 host duties */

  let keepalive: number | undefined
  const offActive = copilot.on('runtime:active', () => {
    // Leading, undelayed (§3.3.9): starting the keepalive late can kill a run; stopping it
    // late costs one ping.
    keepalive ??= deps.setInterval(() => void runtime.getPlatformInfo(), KEEPALIVE_MS)
  })
  const offIdle = copilot.on('runtime:idle', () => {
    if (keepalive !== undefined) deps.clearInterval(keepalive)
    keepalive = undefined
  })

  alarms.onAlarm.addListener((alarm: AlarmLike) => {
    if (alarm.name === WATCHDOG_ALARM) void copilot.resumePending()
  })
  /**
   * `alarms.create` with an existing name **cancels and replaces** that alarm, restarting its
   * 30 s countdown. This runs on every initial evaluation, and the worker is woken by every
   * storage change and every message — so an unconditional create defers the watchdog for as
   * long as the session stays busy, which is exactly when a stuck run needs it. `get` first.
   *
   * The listener above is registered *before* this, synchronously: the await below must never
   * come between initial evaluation and an `addListener`, or a terminated worker stops being
   * woken for the alarm at all.
   */
  void (async () => {
    try {
      if (alarms.get && (await alarms.get(WATCHDOG_ALARM))) return
    } catch {
      // A polyfill without `get` is no reason to run without a watchdog.
    }
    alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MINUTES })
  })()
  runtime.onStartup.addListener(() => void copilot.resumePending())
  runtime.onInstalled.addListener(() => void copilot.resumePending())

  /* --------------------------------------------------------------- relay */

  const relays = new Set<() => void>()
  runtime.onConnect.addListener((port: PortLike) => {
    if (port.name !== undefined && port.name !== RELAY_PORT_NAME) return
    const dispose = attachRelay(port, {
      subscribe: (listener: (event: CopilotEvent) => void) => copilot.subscribe(listener as never),
    })
    relays.add(dispose)
    port.onDisconnect.addListener(() => relays.delete(dispose))
  })

  // …and on every SW wake. Fire-and-forget: it is the last statement, after every listener.
  void copilot.resumePending()

  return {
    copilot,
    comments,
    host,
    settings,
    async dispose() {
      stopDispatch()
      stopCancel()
      stopSettingsWatch()
      offDone()
      offError()
      offQueued()
      offSettled()
      offActive()
      offIdle()
      for (const dispose of relays) dispose()
      relays.clear()
      if (keepalive !== undefined) deps.clearInterval(keepalive)
      keepalive = undefined
      await copilot.destroy()
    },
  }
}
