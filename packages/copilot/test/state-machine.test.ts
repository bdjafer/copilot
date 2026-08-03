// SPEC-copilot §3.1 — the run state machine. One test per normative bullet.
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import type { Run, RunState } from '../src/types.ts'

import { createCopilot, defineTool, MAX_ATTEMPTS, retryDelayMs } from '../src/index.ts'
import { createMemoryRunStore } from '../src/store/memory.ts'
import { createTestCopilot } from '../src/testing/harness.ts'
import { scriptedModel } from '../src/testing/scripted-model.ts'
import { httpError } from './support.ts'

const record = (over: Partial<Run> & { id: string }): Run => ({
  state: 'queued',
  input: 'stored',
  attempts: 0,
  heartbeat: new Date(0).toISOString(),
  createdAt: new Date(0).toISOString(),
  ...over,
})

describe('§3.1 run state machine', () => {
  test('the happy path is queued → processing → done', async () => {
    const t = createTestCopilot({ script: 'answer' })
    const states: RunState[] = []
    t.copilot.runs.subscribe((runs) => {
      const state = runs[0]?.state
      if (state !== undefined && states.at(-1) !== state) states.push(state)
    })
    await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    expect(states).toEqual(['queued', 'processing', 'done'])
    await t.dispose()
  })

  test('cancel from queued lands `cancelled` with at: "queued"', async () => {
    const copilot = createCopilot({
      provider: scriptedModel([{ text: 'first', delayMs: 50_000 }, { text: 'second' }]),
      concurrency: 1,
    })
    const events: Array<'queued' | 'processing'> = []
    copilot.on('run:cancelled', ({ at }) => events.push(at))
    const first = copilot.trigger({ runId: 'a', input: 'a' })
    const second = copilot.trigger({ runId: 'b', input: 'b' })
    await vi.waitFor(() => expect(second.run.get()?.state).toBe('queued'))
    const cancelled = await copilot.cancel('b', 'not needed')
    expect(cancelled).toBe(true)
    const result = await second.result()
    expect(!result.ok && result.reason).toBe('cancelled')
    expect(result.run.state).toBe('cancelled')
    expect(events).toEqual(['queued'])
    void first
    await copilot.destroy()
  })

  test('a FOREIGN run cancelled while queued reports at: "queued", not "processing"', async () => {
    vi.useFakeTimers()
    try {
      const store = createMemoryRunStore()
      await store.put(record({ id: 'r1', state: 'queued', attempts: 0 }))
      const observer = createCopilot({ provider: scriptedModel('unused'), runStore: store })
      const at: string[] = []
      observer.on('run:cancelled', (payload) => at.push(payload.at))
      const settled = observer.attach('r1').result()
      await vi.advanceTimersByTimeAsync(10)

      // The owning context cancels it before it ever started an attempt.
      await store.put(record({ id: 'r1', state: 'cancelled', attempts: 0 }))
      await vi.advanceTimersByTimeAsync(5_000)
      const result = await settled
      expect(!result.ok && result.reason).toBe('cancelled')
      expect(at).toEqual(['queued'])
      await observer.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('cancel from processing lands `cancelled` with at: "processing"', async () => {
    const t = createTestCopilot({ script: [{ text: 'slow', delayMs: 50_000 }] })
    const handle = t.copilot.trigger({ runId: 'r1', input: 'hi' })
    await t.events.waitFor('run:start')
    expect(await t.copilot.cancel('r1', 'user cancelled')).toBe(true)
    const result = await handle.result()
    expect(!result.ok && result.reason).toBe('cancelled')
    const cancelled = t.events.of('run:cancelled')[0]
    expect(cancelled).toMatchObject({ at: 'processing', reason: 'user cancelled' })
    await t.dispose()
  })

  test('attempts is incremented when an attempt STARTS, not when it fails', async () => {
    const t = createTestCopilot({ script: 'ok' })
    const handle = t.copilot.trigger({ runId: 'r1', input: 'hi' })
    const start = await t.events.waitFor('run:start')
    expect(start.attempt).toBe(1)
    expect(start.run.attempts).toBe(1)
    await handle.result()
    expect((await t.copilot.get('r1'))?.attempts).toBe(1)
    await t.dispose()
  })

  test('a retryable failure requeues the run: the record stays `queued` during the backoff', async () => {
    vi.useFakeTimers()
    try {
      const t = createTestCopilot({
        provider: scriptedModel([{ error: httpError(429) }, { text: 'recovered' }]),
      })
      const handle = t.copilot.trigger({ runId: 'r1', input: 'hi' })
      const settled = handle.result()
      await vi.advanceTimersByTimeAsync(100)
      expect((await t.copilot.get('r1'))?.state).toBe('queued')
      expect(t.events.of('run:start')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(retryDelayMs(1))
      await settled
      expect(t.events.of('run:start')).toHaveLength(2)
      await t.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a run reaching attempts === MAX_ATTEMPTS and failing terminates with max_attempts', async () => {
    vi.useFakeTimers()
    try {
      const t = createTestCopilot({
        provider: scriptedModel([
          { error: httpError(429) },
          { error: httpError(429) },
          { error: httpError(429) },
          { text: 'never reached' },
        ]),
      })
      const settled = t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
      await vi.advanceTimersByTimeAsync(30_000)
      const result = await settled
      expect(!result.ok && result.error?.code).toBe('max_attempts')
      expect(t.events.of('run:start')).toHaveLength(MAX_ATTEMPTS)
      const stored = await t.copilot.get('r1')
      expect(stored?.attempts).toBe(MAX_ATTEMPTS)
      expect(stored?.state).toBe('error')
      expect(stored?.error).toMatch(/^max_attempts: /)
      await t.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('done / error / cancelled are absorbing — resumePending never revives them', async () => {
    const store = createMemoryRunStore()
    for (const state of ['done', 'error', 'cancelled'] as const) {
      await store.put(record({ id: state, state, heartbeat: new Date(0).toISOString() }))
    }
    const copilot = createCopilot({ provider: scriptedModel('ok'), runStore: store })
    const report = await copilot.resumePending({ staleAfterMs: 0 })
    expect(report).toMatchObject({ scanned: 0, restarted: [], failed: [] })
    await copilot.destroy()
  })

  test('a queued run in a LIVE local queue keeps its heartbeat ticking (§3.1)', async () => {
    vi.useFakeTimers()
    try {
      const copilot = createCopilot({
        provider: scriptedModel([
          { text: 'one', delayMs: 60_000 },
          { text: 'two', delayMs: 10 },
        ]),
        concurrency: 1,
      })
      const first = copilot.trigger({ runId: 'a', input: 'a' })
      const second = copilot.trigger({ runId: 'b', input: 'b' })
      await vi.advanceTimersByTimeAsync(50)
      const early = (await copilot.get('b'))?.heartbeat
      await vi.advanceTimersByTimeAsync(25_000)
      const later = (await copilot.get('b'))?.heartbeat
      expect(Date.parse(later!)).toBeGreaterThan(Date.parse(early!))
      expect((await copilot.get('b'))?.state).toBe('queued')
      void first
      void second
      await copilot.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('resumePending() skips run ids the local queue already holds', async () => {
    vi.useFakeTimers()
    try {
      const copilot = createCopilot({
        provider: scriptedModel([
          { text: 'one', delayMs: 60_000 },
          { text: 'two', delayMs: 10 },
        ]),
        concurrency: 1,
      })
      copilot.trigger({ runId: 'a', input: 'a' })
      copilot.trigger({ runId: 'b', input: 'b' })
      await vi.advanceTimersByTimeAsync(50)
      const report = await copilot.resumePending({ staleAfterMs: 0 })
      expect(report.scanned).toBe(2)
      expect(report.skipped).toBe(2)
      expect(report.restarted).toEqual([])
      await copilot.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a resume in a FRESH process replays with the run’s persisted spec snapshot', async () => {
    // §2.2 / decision log #26: `model` (as a `models` KEY), `tools` and `maxSteps` are snapshotted
    // into `run.spec` at trigger time, so an instance that never saw the `TriggerInput` still
    // replays the SAME run — the named tier, not the default provider, and the trigger's tool
    // subset, not the full registry. (This test asserted the opposite in wave 1, when the record
    // had nowhere to keep them.)
    const store = createMemoryRunStore()
    const executed: string[] = []
    const tools = [
      defineTool({
        name: 'write',
        description: 'batch-only in the §6 bridge',
        inputSchema: z.object({}),
        execute: () => {
          executed.push('write')
          return 'posted'
        },
      }),
    ] as const

    const first = createCopilot({
      provider: scriptedModel('primary'),
      // The run is triggered on the `fast` tier, which never finishes: the worker dies mid-run.
      models: { fast: scriptedModel([{ text: 'never', delayMs: 60_000 }]) },
      runStore: store,
      tools,
    })
    first.trigger({ runId: 'r1', input: 'hi', model: 'fast', tools: [] })
    await vi.waitFor(async () => expect((await store.get('r1'))?.state).toBe('processing'))
    expect((await store.get('r1'))?.spec).toEqual({ model: 'fast', tools: [] })
    await first.destroy()

    const second = createCopilot({
      // If the snapshot were ignored, THIS model would run: it calls the excluded tool and
      // answers 'replayed'. The `fast` tier answers 'fast' and calls nothing.
      provider: scriptedModel([{ toolCall: { name: 'write', input: {} } }, { text: 'replayed' }]),
      models: { fast: scriptedModel('fast') },
      runStore: store,
      tools,
    })
    const models: string[] = []
    second.on('run:start', ({ model }) => models.push(model))
    await second.resumePending({ staleAfterMs: 0 })
    const result = await second.attach('r1').result()
    expect(result.ok && result.output).toBe('fast')
    expect(models).toEqual(['fast'])
    expect(executed).toEqual([]) // `tools: []` survived the process boundary
    await second.destroy()
  })

  test('a slot created by attach() is resumed with the snapshot too — "any process" means any slot', async () => {
    // The ruling says resumePending AND attach replay the snapshot. `attach` never processes, but
    // it leaves an unowned slot behind (`spec: null`), and the watchdog adopts exactly that slot:
    // the resolution must come off the RECORD, not off whatever the slot was born with.
    const store = createMemoryRunStore()
    const first = createCopilot({
      provider: scriptedModel('primary'),
      models: { fast: scriptedModel([{ text: 'never', delayMs: 60_000 }]) },
      runStore: store,
    })
    first.trigger({ runId: 'r1', input: 'hi', model: 'fast' })
    await vi.waitFor(async () => expect((await store.get('r1'))?.state).toBe('processing'))
    await first.destroy()

    const second = createCopilot({
      provider: scriptedModel('primary'),
      models: { fast: scriptedModel('fast') },
      runStore: store,
    })
    const models: string[] = []
    second.on('run:start', ({ model }) => models.push(model))
    const attached = second.attach('r1') // the slot exists BEFORE the resume
    const settled = attached.result()
    await second.resumePending({ staleAfterMs: 0 })
    const result = await settled
    expect(result.ok && result.output).toBe('fast')
    expect(models).toEqual(['fast'])
    await second.destroy()
  })

  test('a trigger with no overrides persists NO spec — absence means "this instance’s defaults"', async () => {
    const store = createMemoryRunStore()
    const copilot = createCopilot({ provider: scriptedModel('ok'), runStore: store })
    await copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    const stored = await store.get('r1')
    expect(stored?.spec).toBeUndefined()
    expect(Object.keys(stored ?? {})).not.toContain('spec')
    await copilot.destroy()
  })

  test('an inline model INSTANCE is not snapshotted (nothing serialises an object)', async () => {
    const store = createMemoryRunStore()
    const copilot = createCopilot({ provider: scriptedModel('default'), runStore: store })
    await copilot
      .trigger({ runId: 'r1', input: 'hi', model: scriptedModel('inline'), maxSteps: 4 })
      .result()
    // maxSteps is durable; the instance is not — a reviving process could not resolve it.
    expect((await store.get('r1'))?.spec).toEqual({ maxSteps: 4 })
    await copilot.destroy()
  })

  test('the persisted maxSteps drives the replay, not the reviving instance’s default', async () => {
    const store = createMemoryRunStore()
    const tools = [
      defineTool({
        name: 'probe',
        description: 'stub',
        inputSchema: z.object({}),
        execute: () => 'ok',
      }),
    ] as const
    const call = { toolCall: { name: 'probe', input: {} } }

    const first = createCopilot({
      provider: scriptedModel([{ text: 'never', delayMs: 60_000 }]),
      runStore: store,
      tools,
    })
    first.trigger({ runId: 'r1', input: 'hi', maxSteps: 1 })
    await vi.waitFor(async () => expect((await store.get('r1'))?.state).toBe('processing'))
    await first.destroy()

    // The reviving instance defaults to 8 steps; the snapshot says 1, so the model's second step
    // never happens and the run ends as `step_limit` (§3.4) instead of 'done'.
    const second = createCopilot({
      provider: scriptedModel([call, { text: 'done' }]),
      runStore: store,
      tools,
    })
    await second.resumePending({ staleAfterMs: 0 })
    const result = await second.attach('r1').result()
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error?.code).toBe('step_limit')
    await second.destroy()
  })

  test('an unresolvable spec degrades with an `error` event instead of failing the resume', async () => {
    // The reviving process may register different tiers and a different tool set (§2.2): a resume
    // must finish the work, and report the degradation, rather than throw at the host.
    const store = createMemoryRunStore()
    const executed: string[] = []
    const tools = [
      defineTool({
        name: 'keep',
        description: 'stub',
        inputSchema: z.object({}),
        execute: () => {
          executed.push('keep')
          return 'ok'
        },
      }),
    ] as const

    const first = createCopilot({
      provider: scriptedModel('primary'),
      models: { fast: scriptedModel([{ text: 'never', delayMs: 60_000 }]) },
      runStore: store,
      tools: [
        ...tools,
        defineTool({
          name: 'gone',
          description: 'a tool the next process does not register',
          inputSchema: z.object({}),
          execute: () => 'ok',
        }),
      ] as const,
    })
    first.trigger({ runId: 'r1', input: 'hi', model: 'fast', tools: ['keep', 'gone'] })
    await vi.waitFor(async () => expect((await store.get('r1'))?.state).toBe('processing'))
    await first.destroy()

    // No `fast` tier here, and no `gone` tool.
    const second = createCopilot({
      provider: scriptedModel([{ toolCall: { name: 'keep', input: {} } }, { text: 'degraded' }]),
      runStore: store,
      tools,
    })
    const errors: Array<{ code: string; scope: string }> = []
    second.on('error', ({ error, scope }) => errors.push({ code: error.code, scope }))
    const models: string[] = []
    second.on('run:start', ({ model }) => models.push(model))

    const report = await second.resumePending({ staleAfterMs: 0 })
    expect(report.restarted).toEqual(['r1'])
    const result = await second.attach('r1').result()
    expect(result.ok && result.output).toBe('degraded')
    expect(models).toEqual(['default'])
    expect(executed).toEqual(['keep'])
    expect(errors).toEqual([
      { code: 'unknown_model', scope: 'provider' },
      { code: 'unknown_tool', scope: 'tool' },
    ])
    await second.destroy()
  })

  test('a restart replays the run from step 1 — there is no mid-loop checkpoint', async () => {
    const store = createMemoryRunStore()
    const calls: string[] = []
    const tools = [
      defineTool({
        name: 'probe',
        description: 'stub',
        inputSchema: z.object({}),
        execute: () => {
          calls.push('probe')
          return 'ok'
        },
      }),
    ] as const
    const call = { toolCall: { name: 'probe', input: {} } }

    // The first instance dies while the model is still producing the second step.
    const first = createCopilot({
      provider: scriptedModel([call, { text: 'never', delayMs: 60_000 }]),
      runStore: store,
      tools,
    })
    const handle = first.trigger({ runId: 'r1', input: 'hi' })
    await vi.waitFor(() => expect(calls.length).toBe(1))
    await first.destroy()
    void handle

    const second = createCopilot({
      provider: scriptedModel([call, { text: 'done' }]),
      runStore: store,
      tools,
    })
    await second.resumePending({ staleAfterMs: 0 })
    const result = await second.attach('r1').result()
    expect(result.ok && result.output).toBe('done')
    expect(calls).toEqual(['probe', 'probe']) // replayed from step 1
    await second.destroy()
  })
})
