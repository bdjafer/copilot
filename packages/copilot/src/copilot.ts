import type { RunSlot } from './run/handle.ts'
import type { InternalToolRegistry } from './tools/registry.ts'
import type {
  Copilot,
  CopilotEventMap,
  CopilotInspection,
  CopilotOptions,
  ErrorScope,
  LanguageModelLike,
  Run,
  RunHandle,
  RunResult,
  RunState,
  ToolDefinition,
  TriggerInput,
} from './types.ts'

// SPEC-copilot §2.5 / §2.6 / §3 — `createCopilot`: trigger, attach, cancel, cancelByPrefix,
// resumePending, get, list, runs, inspect, destroy, and the retry policy. Runs are data, not
// promises: `trigger()` never rejects, `result()` never rejects, `cancel()` never rejects (§3.4).
import {
  ATTACH_POLL_MS,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT_MS,
  MAX_ATTEMPTS,
  retryDelayMs,
  STALE_AFTER_MS,
} from './constants.ts'
import { createEmitter } from './emitter.ts'
import { CopilotError, decodeRunError, encodeRunError, messageOf } from './errors.ts'
import { createInstanceId, createRunId } from './ids.ts'
import { runAttempt } from './loop.ts'
import { createWritable } from './readable.ts'
import { createRunHandle } from './run/handle.ts'
import { createTicker } from './run/heartbeat.ts'
import { createQueue } from './run/queue.ts'
import { createRunRecord, isStale, isTerminal, patchRun } from './run/record.ts'
import { createMemoryRunStore } from './store/memory.ts'
import { createToolRegistry } from './tools/registry.ts'

export const VERSION = '0.0.0'

interface TriggerSpec {
  model: LanguageModelLike
  modelName: string
  tools: readonly ToolDefinition[]
  maxSteps: number
  system: string | undefined
}

interface Slot<TContext> extends RunSlot<TContext> {
  owned: boolean
  spec: TriggerSpec | null
  controller: AbortController | null
  /** `undefined` = no cancel requested; `null` = cancelled without a reason. */
  cancelReason: string | null | undefined
  restarted: boolean
  /** This instance already holds (or was granted) the store lease for the next attempt. */
  claimed: boolean
  attemptPromise: Promise<void> | null
  requeueAt: number | undefined
  pollTimer: ReturnType<typeof setInterval> | null
  polling: boolean
}

function modelIdOf(model: LanguageModelLike | undefined): string | null {
  if (model === undefined) return null
  if (typeof model === 'string') return model
  const id = (model as { modelId?: unknown }).modelId
  return typeof id === 'string' && id.length > 0 ? id : null
}

export function createCopilot<
  // eslint-disable-next-line no-explicit-any -- the locked signature (§2.5)
  const TTools extends readonly ToolDefinition<string, any, any, TContext>[] = readonly [],
  TContext = unknown,
>(options: CopilotOptions<TTools, TContext>): Copilot<TTools, TContext> {
  if (options === null || typeof options !== 'object') {
    throw new CopilotError('invalid_options', 'createCopilot requires an options object')
  }
  if (options.provider === undefined || options.provider === null) {
    throw new CopilotError('no_provider', 'createCopilot requires a `provider`')
  }

  const maxSteps = options.maxSteps ?? DEFAULT_MAX_STEPS
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(maxSteps) || maxSteps < 1) {
    throw new CopilotError('invalid_options', '`maxSteps` must be >= 1')
  }
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    throw new CopilotError('invalid_options', '`concurrency` must be >= 1')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new CopilotError('invalid_options', '`timeoutMs` must be > 0')
  }

  const now = options.now ?? (() => new Date())
  const nowIso = () => now().toISOString()
  const createId = options.createId ?? createRunId
  const instanceId = createInstanceId()
  const store = options.runStore ?? createMemoryRunStore<TContext>()
  const registry = createToolRegistry(
    (options.tools ?? ([] as unknown as TTools)) as TTools,
  ) as InternalToolRegistry<TTools>
  const renderContext =
    options.renderContext ?? ((context: TContext) => JSON.stringify(context, null, 2) ?? '')

  const emitter = createEmitter<TTools, TContext>({
    instanceId,
    now,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  })

  const slots = new Map<string, Slot<TContext>>()
  const runsStore = createWritable<readonly Run<TContext>[]>([])
  let destroyed = false
  let lastStoreError: string | null = null

  /* ---------------- store plumbing (§3.4: failure is fatal to the run) -------------- */

  const wrapStoreError = (error: unknown, runId?: string): CopilotError => {
    lastStoreError = messageOf(error)
    return CopilotError.is(error)
      ? error
      : new CopilotError('store_failed', messageOf(error), {
          cause: error,
          ...(runId === undefined ? {} : { runId }),
        })
  }

  const putRecord = async (record: Run<TContext>): Promise<void> => {
    try {
      await store.put(record)
    } catch (error) {
      throw wrapStoreError(error, record.id)
    }
  }

  const getRecord = async (id: string): Promise<Run<TContext> | null> => {
    try {
      return await store.get(id)
    } catch (error) {
      throw wrapStoreError(error, id)
    }
  }

  /* ---------------- slots ---------------- */

  const rebuildRuns = () => {
    const records: Run<TContext>[] = []
    for (const slot of slots.values()) if (slot.record !== null) records.push(slot.record)
    records.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
    runsStore.set(records)
  }

  const publish = (slot: Slot<TContext>, record: Run<TContext>) => {
    slot.record = record
    slot.store.set(record)
    rebuildRuns()
  }

  const emit: typeof emitter.emit = (event, runId, payload) => {
    if (destroyed) return
    emitter.emit(event, runId, payload)
  }

  const emitError = (error: CopilotError, scope: ErrorScope, runId?: string) => {
    if (destroyed) return
    emitter.emitError(error, scope, runId)
  }

  const settle = (slot: Slot<TContext>, result: RunResult<TContext>) => {
    if (slot.settled) return
    slot.settled = true
    slot.result = result
    stopPolling(slot)
    // oxlint-disable-next-line no-useless-spread -- snapshot: a sink removes itself on end
    for (const sink of [...slot.tokenSinks]) sink.end()
    for (const waiter of slot.waiters.splice(0)) waiter(result)
  }

  /**
   * The placeholder `Run` handed back when there is no durable record to report — either because
   * the run genuinely does not exist, or because the store failed before the first write landed.
   * It reports the failure that actually happened: labelling a store outage `run_not_found` sends
   * the host looking for a missing key instead of a broken store.
   */
  const missingRecord = (id: string, error?: CopilotError): Run<TContext> =>
    ({
      id,
      state: 'error',
      input: '',
      error: encodeRunError(
        error ?? new CopilotError('run_not_found', 'no such run', { runId: id }),
      ),
      attempts: 0,
      heartbeat: nowIso(),
      createdAt: nowIso(),
    }) as Run<TContext>

  const resultFromRecord = (record: Run<TContext>): RunResult<TContext> => {
    const restarted = record.attempts > 1
    if (record.state === 'done') {
      return {
        ok: true,
        runId: record.id,
        output: record.output ?? '',
        steps: 0,
        usage: {},
        run: record,
        restarted,
      }
    }
    if (record.state === 'cancelled') {
      return {
        ok: false,
        runId: record.id,
        reason: 'cancelled',
        error: null,
        run: record,
        restarted,
      }
    }
    return {
      ok: false,
      runId: record.id,
      reason: 'error',
      error: decodeRunError(record.error, record.id),
      run: record,
      restarted,
    }
  }

  /**
   * Where a foreign `cancelled` record was cancelled. The local view of the run before it went
   * terminal is the best evidence; without one, a run that never started an attempt was
   * necessarily cancelled while queued.
   */
  const cancelledAt = (
    priorState: RunState | undefined,
    record: Run<TContext>,
  ): 'queued' | 'processing' => {
    if (priorState === 'queued') return 'queued'
    if (priorState === 'processing') return 'processing'
    return record.attempts === 0 ? 'queued' : 'processing'
  }

  /** Emits the terminal event for a record this instance did not produce, then settles. */
  const emitTerminalFromRecord = (
    slot: Slot<TContext>,
    record: Run<TContext>,
    priorState: RunState | undefined,
  ) => {
    if (slot.settled) return
    const result = resultFromRecord(record)
    if (record.state === 'done') {
      emit('run:done', record.id, {
        runId: record.id,
        run: record,
        output: record.output ?? '',
        steps: 0,
        usage: {},
        durationMs: 0,
      })
    } else if (record.state === 'cancelled') {
      emit('run:cancelled', record.id, {
        runId: record.id,
        run: record,
        reason: slot.cancelReason ?? null,
        at: cancelledAt(priorState, record),
      })
    } else {
      emit('run:error', record.id, {
        runId: record.id,
        run: record,
        error: decodeRunError(record.error, record.id) ?? new CopilotError('provider_error'),
        attempt: record.attempts,
        willRetry: false,
      })
    }
    emit('run:settled', record.id, { runId: record.id, run: record, result })
    settle(slot, result)
  }

  const emitSettled = (
    slot: Slot<TContext>,
    record: Run<TContext>,
    result: RunResult<TContext>,
  ) => {
    emit('run:settled', record.id, { runId: record.id, run: record, result })
    settle(slot, result)
  }

  function stopPolling(slot: Slot<TContext>) {
    if (slot.pollTimer !== null) clearInterval(slot.pollTimer)
    slot.pollTimer = null
    slot.polling = false
  }

  const pollWanted = (slot: Slot<TContext>): boolean =>
    slot.waiters.length > 0 ||
    slot.tokenSinks.size > 0 ||
    slot.store.size > 0 ||
    emitter.runListenerCount(slot.id) > 0

  /**
   * Ownership is decided synchronously by `trigger` and corrected asynchronously by the store
   * lookup (§3.2 row 1) or by a lost `claim` (§3.1). Whoever is already waiting on the handle
   * made its poll decision under the old answer, so every correction re-runs it.
   */
  function repollIfWanted(slot: Slot<TContext>) {
    if (pollWanted(slot)) ensurePolling(slot)
  }

  function ensurePolling(slot: Slot<TContext>) {
    if (destroyed || slot.owned || slot.settled || slot.polling) return
    slot.polling = true

    const poll = async (first: boolean) => {
      if (destroyed || slot.settled) {
        stopPolling(slot)
        return
      }
      if (!first && !pollWanted(slot)) {
        stopPolling(slot)
        return
      }
      let record: Run<TContext> | null
      try {
        record = await getRecord(slot.id)
      } catch (error) {
        const failure = wrapStoreError(error, slot.id)
        stopPolling(slot)
        emitError(failure, 'store', slot.id)
        settle(slot, {
          ok: false,
          runId: slot.id,
          reason: 'error',
          error: failure,
          run: slot.record ?? missingRecord(slot.id, failure),
          restarted: slot.restarted,
        })
        return
      }
      if (destroyed || slot.settled) return
      // A `trigger` may have adopted this slot while the read was in flight: the run is this
      // instance's again, and the loop — not the poller — reports its terminal state.
      if (slot.owned) {
        stopPolling(slot)
        return
      }
      if (record === null) {
        stopPolling(slot)
        const error = new CopilotError('run_not_found', `no run with id ${slot.id}`, {
          runId: slot.id,
        })
        settle(slot, {
          ok: false,
          runId: slot.id,
          reason: 'error',
          error,
          run: missingRecord(slot.id),
          restarted: false,
        })
        return
      }
      const priorState = slot.record?.state
      publish(slot, record)
      if (isTerminal(record.state)) {
        stopPolling(slot)
        emitTerminalFromRecord(slot, record, priorState)
      }
    }

    void poll(true)
    if (slot.polling) {
      slot.pollTimer = setInterval(() => {
        void poll(false)
      }, ATTACH_POLL_MS)
    }
  }

  const createSlot = (id: string, init: { owned: boolean; spec: TriggerSpec | null }) => {
    const slot: Slot<TContext> = {
      id,
      record: null,
      store: createWritable<Run<TContext> | null>(null),
      deduped: false,
      settled: false,
      result: null,
      waiters: [],
      tokenSinks: new Set(),
      owned: init.owned,
      spec: init.spec,
      controller: null,
      cancelReason: undefined,
      restarted: false,
      claimed: false,
      attemptPromise: null,
      requeueAt: undefined,
      pollTimer: null,
      polling: false,
      ensurePolling: () => {
        ensurePolling(slot)
      },
    }
    slots.set(id, slot)
    return slot
  }

  /**
   * `deduped` is a property of the HANDLE, not of the run (§2.6: "no new work was started").
   * The handle that started the work must never flip to `true` because a later `trigger` or
   * `attach` bound onto the same run; `deduped: true` is passed for exactly those later handles,
   * while the first handle reads the slot flag the store lookup sets when the run pre-existed.
   */
  const makeHandle = (slot: Slot<TContext>, deduped?: true): RunHandle<TTools, TContext> =>
    createRunHandle<TTools, TContext>({
      slot,
      emitter,
      cancel: (runId, reason) => api.cancel(runId, reason),
      ...(deduped === undefined ? {} : { deduped }),
    })

  /* ---------------- heartbeat + queue ---------------- */

  const bumpHeartbeat = (slot: Slot<TContext>) => {
    const record = slot.record
    if (record === null || isTerminal(record.state) || destroyed) return
    const bumped = patchRun(record, { heartbeat: nowIso() })
    publish(slot, bumped)
    void store.put(bumped).catch((error: unknown) => {
      // A blipped heartbeat write is reported but does not kill a healthy run; only the state
      // transitions of §3.3.1 are fatal when they cannot be recorded.
      emitError(wrapStoreError(error, slot.id), 'store', slot.id)
    })
  }

  const ticker = createTicker(() => {
    for (const slot of slots.values()) {
      if (!queue.holds(slot.id)) continue
      bumpHeartbeat(slot)
      // Renew the lease alongside the heartbeat so a live owner keeps it and a dead one does not.
      if (slot.claimed && store.claim !== undefined) {
        void store.claim(slot.id, instanceId, STALE_AFTER_MS).catch(() => undefined)
      }
    }
  })

  const queue = createQueue({
    concurrency,
    now: () => now().getTime(),
    start: (runId) => {
      startRun(runId)
    },
    onActive: (activeRuns) => {
      emit('runtime:active', null, { activeRuns })
    },
    onIdle: () => {
      emit('runtime:idle', null, { activeRuns: 0 })
    },
    onActiveCountChange: (activeRuns) => {
      ticker.sync(activeRuns > 0 && !destroyed)
    },
  })

  /* ---------------- the run pipeline ---------------- */

  const defaultSpec = (): TriggerSpec => ({
    model: options.provider,
    modelName: 'default',
    tools: registry.subset(undefined),
    maxSteps,
    system: undefined,
  })

  const failWithStoreError = (slot: Slot<TContext>, error: unknown) => {
    const failure = wrapStoreError(error, slot.id)
    emitError(failure, 'store', slot.id)
    const record = slot.record ?? missingRecord(slot.id, failure)
    if (slot.settled) return
    emit('run:error', slot.id, {
      runId: slot.id,
      run: record,
      error: failure,
      attempt: record.attempts,
      willRetry: false,
    })
    emitSettled(slot, record, {
      ok: false,
      runId: slot.id,
      reason: 'error',
      error: failure,
      run: record,
      restarted: slot.restarted,
    })
  }

  const writeCancelled = async (
    slot: Slot<TContext>,
    base: Run<TContext>,
    at: 'queued' | 'processing',
  ) => {
    const record = patchRun(base, { state: 'cancelled', heartbeat: nowIso() })
    await putRecord(record)
    publish(slot, record)
    emit('run:cancelled', slot.id, {
      runId: slot.id,
      run: record,
      reason: slot.cancelReason ?? null,
      at,
    })
    emitSettled(slot, record, {
      ok: false,
      runId: slot.id,
      reason: 'cancelled',
      error: null,
      run: record,
      restarted: record.attempts > 1,
    })
  }

  async function processRun(slot: Slot<TContext>): Promise<void> {
    if (destroyed) return
    const fresh = await getRecord(slot.id)
    if (fresh === null) {
      const error = new CopilotError('run_not_found', `no run with id ${slot.id}`, {
        runId: slot.id,
      })
      emitError(error, 'store', slot.id)
      settle(slot, {
        ok: false,
        runId: slot.id,
        reason: 'error',
        error,
        run: missingRecord(slot.id),
        restarted: slot.restarted,
      })
      return
    }
    if (isTerminal(fresh.state)) {
      const priorState = slot.record?.state
      publish(slot, fresh)
      emitTerminalFromRecord(slot, fresh, priorState)
      return
    }
    if (slot.cancelReason !== undefined) {
      await writeCancelled(slot, fresh, 'queued')
      return
    }
    // §3.1: queued → processing requires a successful claim (when the store supports it) or a
    // stale heartbeat (when it does not). A run adopted by `resumePending` already passed that
    // gate — re-claiming would only re-test a lease this instance was just granted.
    if (store.claim !== undefined && !slot.claimed) {
      const claimed = await store.claim(slot.id, instanceId, STALE_AFTER_MS)
      if (!claimed) {
        // Another context owns this attempt. This instance is now an observer of a foreign run:
        // it must poll for the terminal state, or every outstanding `result()` waits forever
        // for a loop that runs somewhere else (§2.6).
        slot.owned = false
        slot.claimed = false
        publish(slot, fresh)
        repollIfWanted(slot)
        return
      }
      slot.claimed = true
    }

    const attempt = fresh.attempts + 1
    const record = patchRun(fresh, {
      state: 'processing',
      attempts: attempt,
      heartbeat: nowIso(),
    })
    await putRecord(record)
    publish(slot, record)
    if (attempt > 1) slot.restarted = true

    const spec = slot.spec ?? defaultSpec()
    emit('run:start', slot.id, {
      runId: slot.id,
      run: record,
      attempt,
      resumed: attempt > 1,
      model: spec.modelName,
    })

    const controller = new AbortController()
    slot.controller = controller
    const startedAt = now().getTime()

    const outcome = await runAttempt<TContext>({
      run: record,
      attempt,
      model: spec.model,
      tools: spec.tools,
      maxSteps: spec.maxSteps,
      timeoutMs,
      signal: controller.signal,
      system: spec.system,
      systemPrompt: options.systemPrompt,
      renderContext,
      now,
      emitToken: (delta, step) => {
        emit('run:token', slot.id, { runId: slot.id, delta, step })
        // oxlint-disable-next-line no-useless-spread -- snapshot: a consumer may detach
        for (const sink of [...slot.tokenSinks]) sink.push(delta)
      },
      emitStep: (payload) => {
        emit('run:step', slot.id, {
          runId: slot.id,
          run: slot.record ?? record,
          step: payload.step,
          text: payload.text,
          // The loop is generic over the host's tuple; the union is reconstructed here.
          calls: payload.calls as unknown as CopilotEventMap<TTools, TContext>['run:step']['calls'],
          usage: payload.usage,
          finishReason: payload.finishReason,
        })
        bumpHeartbeat(slot)
      },
      emitToolCall: (payload) => {
        emit('tool:call', slot.id, {
          runId: slot.id,
          step: payload.step,
          name: payload.name as TTools[number]['name'],
          input: payload.input,
        })
      },
      emitToolResult: (payload) => {
        emit('tool:result', slot.id, {
          runId: slot.id,
          step: payload.step,
          call: payload.call as unknown as CopilotEventMap<TTools, TContext>['tool:result']['call'],
          durationMs: payload.durationMs,
        })
      },
      emitError: (error, scope) => {
        emitError(error, scope, slot.id)
      },
      recordToolStats: (name, durationMs, ok) => {
        registry.record(name, durationMs, ok)
      },
    })

    slot.controller = null
    const durationMs = now().getTime() - startedAt

    // destroy() aborts in-flight attempts WITHOUT writing a terminal state (§3.3.12).
    if (destroyed) return

    const latest = await getRecord(slot.id)
    if (latest !== null && latest.state === 'cancelled') {
      const priorState = slot.record?.state
      publish(slot, latest)
      emitTerminalFromRecord(slot, latest, priorState)
      return
    }
    const base = latest ?? record

    if (slot.cancelReason !== undefined || outcome.type === 'cancelled') {
      await writeCancelled(slot, base, 'processing')
      return
    }

    if (outcome.type === 'done') {
      const done = patchRun(base, {
        state: 'done',
        output: outcome.output,
        heartbeat: nowIso(),
      })
      await putRecord(done)
      publish(slot, done)
      emit('run:done', slot.id, {
        runId: slot.id,
        run: done,
        output: outcome.output,
        steps: outcome.steps,
        usage: outcome.usage,
        durationMs,
      })
      emitSettled(slot, done, {
        ok: true,
        runId: slot.id,
        output: outcome.output,
        steps: outcome.steps,
        usage: outcome.usage,
        run: done,
        restarted: done.attempts > 1,
      })
      return
    }

    const error = outcome.error
    const willRetry = error.retryable && attempt < MAX_ATTEMPTS
    if (willRetry) {
      const requeued = patchRun(base, { state: 'queued', heartbeat: nowIso() })
      await putRecord(requeued)
      publish(slot, requeued)
      emit('run:error', slot.id, {
        runId: slot.id,
        run: requeued,
        error,
        attempt,
        willRetry: true,
      })
      // The record stays `queued` for the backoff interval and keeps ticking (§3.1).
      slot.requeueAt = now().getTime() + retryDelayMs(attempt)
      return
    }

    const finalError =
      error.retryable && attempt >= MAX_ATTEMPTS
        ? new CopilotError(
            'max_attempts',
            `run failed after ${attempt} attempts: ${error.message}`,
            { runId: slot.id, cause: error },
          )
        : error
    const failed = patchRun(base, {
      state: 'error',
      error: encodeRunError(finalError),
      heartbeat: nowIso(),
    })
    await putRecord(failed)
    publish(slot, failed)
    emit('run:error', slot.id, {
      runId: slot.id,
      run: failed,
      error: finalError,
      attempt,
      willRetry: false,
    })
    emitSettled(slot, failed, {
      ok: false,
      runId: slot.id,
      reason: 'error',
      error: finalError,
      run: failed,
      restarted: failed.attempts > 1,
    })
  }

  function startRun(runId: string) {
    const slot = slots.get(runId)
    if (slot === undefined) {
      queue.finish(runId)
      return
    }
    const attemptPromise = processRun(slot)
      .catch((error: unknown) => {
        failWithStoreError(slot, error)
      })
      .finally(() => {
        slot.attemptPromise = null
        queue.finish(runId)
        if (slot.requeueAt !== undefined && !destroyed) {
          const at = slot.requeueAt
          slot.requeueAt = undefined
          queue.add(runId, at)
        }
      })
    slot.attemptPromise = attemptPromise
    void attemptPromise
  }

  async function initTrigger(slot: Slot<TContext>, input: TriggerInput<TTools, TContext>) {
    try {
      if (input.runId !== undefined) {
        const existing = await getRecord(input.runId)
        if (existing !== null) {
          // §3.2: the run already exists ⇒ no new work, no `run:queued`.
          slot.deduped = true
          slot.owned = false
          slot.spec = null
          publish(slot, existing)
          if (isTerminal(existing.state)) {
            settle(slot, resultFromRecord(existing))
            return
          }
          // The run belongs to whoever is processing it — possibly another context. Nothing
          // pushes its terminal state here (§2.6), so the poll decision taken while this slot
          // still looked owned has to be taken again.
          repollIfWanted(slot)
          return
        }
      }
      const record = createRunRecord<TContext>({
        id: slot.id,
        input: input.input,
        ...(input.context === undefined ? {} : { context: input.context }),
        now: now(),
      })
      // Durable-first: the state transition is written before its event is emitted (§3.3.1).
      await putRecord(record)
      publish(slot, record)
      emit('run:queued', slot.id, { runId: slot.id, run: record })
      if (slot.cancelReason !== undefined) {
        await writeCancelled(slot, record, 'queued')
        return
      }
      queue.add(slot.id)
    } catch (error) {
      failWithStoreError(slot, error)
    }
  }

  const resolveSpec = (input: TriggerInput<TTools, TContext>): TriggerSpec => {
    let model: LanguageModelLike = options.provider
    let modelName = 'default'
    if (typeof input.model === 'string') {
      const named = options.models?.[input.model]
      if (named === undefined) {
        throw new CopilotError('unknown_model', `unknown model: ${input.model}`)
      }
      model = named
      modelName = input.model
    } else if (input.model !== undefined) {
      model = input.model
      modelName = modelIdOf(input.model) ?? 'custom'
    }
    return {
      model,
      modelName,
      tools: registry.subset(input.tools),
      maxSteps: input.maxSteps ?? maxSteps,
      system: input.system,
    }
  }

  /** `TriggerInput.signal` cancels its run (§2.6). */
  const bindTriggerSignal = (slot: Slot<TContext>, signal: AbortSignal) => {
    if (signal.aborted) {
      slot.cancelReason = 'trigger signal aborted'
      return
    }
    signal.addEventListener(
      'abort',
      () => {
        void api.cancel(slot.id, 'trigger signal aborted')
      },
      { once: true },
    )
  }

  /* ---------------- public surface ---------------- */

  const api: Copilot<TTools, TContext> = {
    trigger(input) {
      if (destroyed) throw new CopilotError('destroyed', 'this copilot has been destroyed')
      if (input === null || typeof input !== 'object' || typeof input.input !== 'string') {
        throw new CopilotError('invalid_options', 'trigger requires `{ input: string }`')
      }
      const spec = resolveSpec(input)
      const id = input.runId ?? createId()

      const existing = slots.get(id)
      // A slot standing for real work — this instance owns it, or a durable record was found
      // for it — dedupes (§3.2 rows 1-2). A slot left behind by `attach()` for a run that has no
      // record does NOT: §3.2 row 3 requires a new run whenever no record exists, and a silent
      // no-op there is a run the host believes it started.
      if (existing !== undefined && (existing.owned || existing.record !== null)) {
        return makeHandle(existing, true)
      }
      if (existing !== undefined && !existing.settled) {
        stopPolling(existing)
        existing.owned = true
        existing.deduped = false
        existing.spec = spec
        const adopted = makeHandle(existing)
        if (input.signal !== undefined) bindTriggerSignal(existing, input.signal)
        void initTrigger(existing, input)
        return adopted
      }
      // An already-settled observer keeps its own answer; this run starts from a clean slot.
      if (existing !== undefined) slots.delete(id)

      const slot = createSlot(id, { owned: true, spec })
      const handle = makeHandle(slot)
      if (input.signal !== undefined) bindTriggerSignal(slot, input.signal)
      void initTrigger(slot, input)
      return handle
    },

    attach(runId) {
      if (destroyed) throw new CopilotError('destroyed', 'this copilot has been destroyed')
      const existing = slots.get(runId)
      if (existing !== undefined) return makeHandle(existing, true)
      return makeHandle(createSlot(runId, { owned: false, spec: null }), true)
    },

    async cancel(runId, reason) {
      try {
        const slot = slots.get(runId)
        if (slot !== undefined) {
          if (slot.settled) return false
          const known = slot.record
          if (known !== null && isTerminal(known.state)) return false
          slot.cancelReason = reason ?? null

          if (queue.isProcessing(runId)) {
            slot.controller?.abort(new CopilotError('aborted', reason ?? 'cancelled', { runId }))
            await slot.attemptPromise?.catch(() => undefined)
            return true
          }

          queue.remove(runId)
          const record = known ?? (await getRecord(runId))
          if (record === null) return true // the initial write is still in flight
          if (isTerminal(record.state)) return false
          await writeCancelled(
            slot,
            record,
            record.state === 'processing' ? 'processing' : 'queued',
          )
          return true
        }

        const record = await getRecord(runId)
        if (record === null || isTerminal(record.state)) return false
        const foreign = createSlot(runId, { owned: false, spec: null })
        foreign.cancelReason = reason ?? null
        publish(foreign, record)
        await writeCancelled(
          foreign,
          record,
          record.state === 'processing' ? 'processing' : 'queued',
        )
        return true
      } catch (error) {
        emitError(wrapStoreError(error, runId), 'store', runId)
        return false
      }
    },

    async cancelByPrefix(prefix, reason) {
      let live: Run<TContext>[]
      try {
        live = await store.list({ state: ['queued', 'processing'], idPrefix: prefix })
      } catch (error) {
        emitError(wrapStoreError(error), 'store')
        return []
      }
      const cancelled: string[] = []
      for (const record of live) {
        if (await api.cancel(record.id, reason)) cancelled.push(record.id)
      }
      return cancelled
    },

    async resumePending(resumeOptions) {
      const staleAfterMs = resumeOptions?.staleAfterMs ?? STALE_AFTER_MS
      const restarted: string[] = []
      const failed: string[] = []
      let skipped = 0
      let scanned = 0

      try {
        const pending = await store.list({
          state: ['queued', 'processing'],
          ...(resumeOptions?.limit === undefined ? {} : { limit: resumeOptions.limit }),
        })
        scanned = pending.length

        for (const record of pending) {
          if (destroyed) break
          // A queued run in a LIVE local queue is not abandoned (§3.1).
          if (queue.holds(record.id)) {
            skipped += 1
            continue
          }
          const existing = slots.get(record.id)
          if (existing !== undefined && existing.settled) {
            skipped += 1
            continue
          }
          if (!isStale(record, now(), staleAfterMs)) {
            skipped += 1
            continue
          }
          // The lease is the tie-break between two contexts resuming at the same moment. A
          // caller that passes `staleAfterMs: 0` has declared the previous owner dead (§7.4's
          // kill/revive cycle), so the lease it left behind must not outrank that declaration.
          if (store.claim !== undefined && staleAfterMs > 0) {
            const claimed = await store.claim(record.id, instanceId, staleAfterMs)
            if (!claimed) {
              skipped += 1
              continue
            }
          }

          const slot = existing ?? createSlot(record.id, { owned: false, spec: null })
          slot.owned = true
          slot.claimed = true
          stopPolling(slot)
          publish(slot, record)

          if (record.attempts >= MAX_ATTEMPTS) {
            const error = new CopilotError(
              'max_attempts',
              `run exhausted ${MAX_ATTEMPTS} attempts`,
              { runId: record.id },
            )
            const terminal = patchRun(record, {
              state: 'error',
              error: encodeRunError(error),
              heartbeat: nowIso(),
            })
            await putRecord(terminal)
            publish(slot, terminal)
            emit('run:error', record.id, {
              runId: record.id,
              run: terminal,
              error,
              attempt: record.attempts,
              willRetry: false,
            })
            emitSettled(slot, terminal, {
              ok: false,
              runId: record.id,
              reason: 'error',
              error,
              run: terminal,
              restarted: true,
            })
            failed.push(record.id)
            continue
          }

          slot.restarted = true
          queue.add(record.id)
          restarted.push(record.id)
        }
      } catch (error) {
        emitError(wrapStoreError(error), 'store')
      }

      return { scanned, restarted, failed, skipped }
    },

    get(runId) {
      return store.get(runId)
    },

    list(filter) {
      return store.list(filter)
    },

    runs: runsStore,
    tools: registry,

    on(event, listener, listenerOptions) {
      return emitter.on(event, listener, listenerOptions)
    },
    once(event, listener) {
      return emitter.once(event, listener)
    },
    off(event, listener) {
      emitter.off(event, listener)
    },
    subscribe(listener) {
      return emitter.subscribe(listener)
    },

    inspect(): CopilotInspection {
      const counts: Record<RunState, number> = {
        queued: 0,
        processing: 0,
        done: 0,
        error: 0,
        cancelled: 0,
      }
      for (const record of runsStore.get()) counts[record.state] += 1
      return {
        version: VERSION,
        provider: {
          models: Object.keys(options.models ?? {}),
          default: modelIdOf(options.provider),
        },
        tools: registry.stats(),
        runs: counts,
        config: { maxSteps, concurrency, timeoutMs, maxAttempts: MAX_ATTEMPTS },
        listeners: emitter.counts(),
        store: { name: store.name ?? 'anonymous', lastError: lastStoreError },
      }
    },

    async destroy() {
      if (destroyed) return
      destroyed = true
      ticker.stop()
      const pending: Array<Promise<unknown>> = []
      for (const slot of slots.values()) {
        stopPolling(slot)
        slot.controller?.abort(
          new CopilotError('destroyed', 'copilot destroyed', { runId: slot.id }),
        )
        if (slot.attemptPromise !== null) pending.push(slot.attemptPromise.catch(() => undefined))
      }
      queue.destroy()
      emitter.clear()
      await Promise.allSettled(pending)
      const error = new CopilotError('destroyed', 'copilot destroyed')
      for (const slot of slots.values()) {
        if (slot.settled) continue
        settle(slot, {
          ok: false,
          runId: slot.id,
          reason: 'cancelled',
          error,
          run: slot.record ?? missingRecord(slot.id, error),
          restarted: slot.restarted,
        })
      }
    },
  }

  return api
}
