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

  test('a resume in a FRESH process replays with the default spec — overrides are not durable', async () => {
    // `Run` is locked at nine fields (§2.2): `model`, `tools` and `maxSteps` from `TriggerInput`
    // have nowhere durable to live, so an instance that did not issue the trigger cannot know
    // them. A cross-process resume therefore replays with the primary provider and the full
    // registry — the run:start model is 'default' and a tool the trigger excluded is available.
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
    await first.destroy()

    const second = createCopilot({
      provider: scriptedModel([{ toolCall: { name: 'write', input: {} } }, { text: 'replayed' }]),
      models: { fast: scriptedModel('fast') },
      runStore: store,
      tools,
    })
    const models: string[] = []
    second.on('run:start', ({ model }) => models.push(model))
    await second.resumePending({ staleAfterMs: 0 })
    const result = await second.attach('r1').result()
    expect(result.ok && result.output).toBe('replayed')
    expect(models).toEqual(['default'])
    expect(executed).toEqual(['write'])
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
