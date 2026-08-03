// SPEC-copilot §2.5 / §2.6 / §2.10 — the runtime surface.
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import type { LanguageModelLike, Run } from '../src/types.ts'

import { createCopilot, defineTool, lazyModel, MAX_ATTEMPTS } from '../src/index.ts'
import { createMemoryRunStore } from '../src/store/memory.ts'
import { createTestCopilot } from '../src/testing/harness.ts'
import { scriptedModel } from '../src/testing/scripted-model.ts'

const record = (over: Partial<Run> & { id: string }): Run => ({
  state: 'queued',
  input: 'stored',
  attempts: 0,
  heartbeat: new Date(0).toISOString(),
  createdAt: new Date(0).toISOString(),
  ...over,
})

describe('§2.6 trigger / handle', () => {
  test('trigger() is synchronous and the run store fills in on the next microtask', async () => {
    const copilot = createCopilot({ provider: scriptedModel('ok') })
    const handle = copilot.trigger({ runId: 'r1', input: 'hi' })
    expect(handle.id).toBe('r1')
    expect(handle.run.get()).toBeNull() // null until the initial durable write lands
    const states: (string | undefined)[] = []
    handle.run.subscribe((run) => states.push(run?.state))
    await handle.result()
    expect(states[0]).toBe('queued')
    expect(states.at(-1)).toBe('done')
    await copilot.destroy()
  })

  test('handle.tokens() yields the stream and ends at the terminal event', async () => {
    const copilot = createCopilot({ provider: scriptedModel('abc') })
    const handle = copilot.trigger({ input: 'hi' })
    const seen: string[] = []
    for await (const delta of handle.tokens()) seen.push(delta)
    expect(seen.join('')).toBe('abc')
    const result = await handle.result()
    expect(result.ok && result.output).toBe('abc')
    await copilot.destroy()
  })

  test('handle.cancel() delegates to copilot.cancel()', async () => {
    const copilot = createCopilot({ provider: scriptedModel([{ text: 'x', delayMs: 60_000 }]) })
    const handle = copilot.trigger({ runId: 'r1', input: 'hi' })
    await vi.waitFor(() => expect(handle.run.get()?.state).toBe('processing'))
    expect(await handle.cancel('nope')).toBe(true)
    const result = await handle.result()
    expect(!result.ok && result.reason).toBe('cancelled')
    await copilot.destroy()
  })

  test('TriggerInput.signal cancels the run', async () => {
    const controller = new AbortController()
    const copilot = createCopilot({ provider: scriptedModel([{ text: 'x', delayMs: 60_000 }]) })
    const handle = copilot.trigger({ runId: 'r1', input: 'hi', signal: controller.signal })
    await vi.waitFor(() => expect(handle.run.get()?.state).toBe('processing'))
    controller.abort()
    const result = await handle.result()
    expect(!result.ok && result.reason).toBe('cancelled')
    await copilot.destroy()
  })

  test('TriggerInput.model selects a named alternate', async () => {
    const copilot = createCopilot({
      provider: scriptedModel('default model'),
      models: { fast: scriptedModel('fast model') },
    })
    const fast = await copilot.trigger({ input: 'hi', model: 'fast' }).result()
    expect(fast.ok && fast.output).toBe('fast model')
    const base = await copilot.trigger({ input: 'hi' }).result()
    expect(base.ok && base.output).toBe('default model')
    await copilot.destroy()
  })

  test('run:start reports the model name used for the attempt', async () => {
    const t = createTestCopilot({
      provider: scriptedModel('x'),
      models: { fast: scriptedModel('y') },
    })
    await t.copilot.trigger({ runId: 'a', input: 'hi' }).result()
    await t.copilot.trigger({ runId: 'b', input: 'hi', model: 'fast' }).result()
    expect(t.events.of('run:start').map((event) => event.model)).toEqual(['default', 'fast'])
    await t.dispose()
  })
})

describe('§2.6 cancelByPrefix / resumePending / queries', () => {
  test('cancelByPrefix cancels every live run under the prefix and reports the ids', async () => {
    const copilot = createCopilot({
      provider: scriptedModel([
        { text: 'a', delayMs: 60_000 },
        { text: 'b', delayMs: 60_000 },
        { text: 'c', delayMs: 60_000 },
      ]),
      concurrency: 3,
    })
    const handles = ['c:t1:1', 'c:t1:2', 'c:t2:1'].map((id) =>
      copilot.trigger({ runId: id, input: id }),
    )
    await vi.waitFor(() => expect(handles.every((h) => h.run.get() !== null)).toBe(true))
    const cancelled = await copilot.cancelByPrefix('c:t1:', 'thread deleted')
    expect([...cancelled].sort()).toEqual(['c:t1:1', 'c:t1:2'])
    expect((await copilot.get('c:t2:1'))?.state).toBe('processing')
    await copilot.destroy()
  })

  test('resumePending terminates a record that already burned MAX_ATTEMPTS', async () => {
    const store = createMemoryRunStore()
    await store.put(record({ id: 'r1', state: 'processing', attempts: MAX_ATTEMPTS }))
    const copilot = createCopilot({ provider: scriptedModel('ok'), runStore: store })
    const report = await copilot.resumePending({ staleAfterMs: 0 })
    expect(report).toMatchObject({ scanned: 1, restarted: [], failed: ['r1'], skipped: 0 })
    const stored = await copilot.get('r1')
    expect(stored?.state).toBe('error')
    expect(stored?.error).toMatch(/^max_attempts: /)
    await copilot.destroy()
  })

  test('resumePending honours `limit` and reports `scanned`', async () => {
    const store = createMemoryRunStore()
    for (const index of [1, 2, 3]) {
      await store.put(record({ id: `r${index}`, createdAt: new Date(index * 1000).toISOString() }))
    }
    const copilot = createCopilot({ provider: scriptedModel('ok'), runStore: store })
    const report = await copilot.resumePending({ staleAfterMs: 0, limit: 2 })
    expect(report.scanned).toBe(2)
    await copilot.destroy()
  })

  test('a fresh heartbeat is skipped, a stale one is restarted', async () => {
    const store = createMemoryRunStore()
    await store.put(
      record({ id: 'fresh', state: 'processing', heartbeat: new Date().toISOString() }),
    )
    await store.put(
      record({ id: 'stale', state: 'processing', heartbeat: new Date(0).toISOString() }),
    )
    const copilot = createCopilot({ provider: scriptedModel([{ text: 'ok' }]), runStore: store })
    const report = await copilot.resumePending()
    expect(report.restarted).toEqual(['stale'])
    expect(report.skipped).toBe(1)
    await copilot.destroy()
  })

  test('get() and list() pass through to the store; runs is a live createdAt-ascending view', async () => {
    const copilot = createCopilot({ provider: scriptedModel([{ text: 'a' }, { text: 'b' }]) })
    await copilot.trigger({ runId: 'first', input: 'a' }).result()
    await copilot.trigger({ runId: 'second', input: 'b' }).result()
    expect((await copilot.get('first'))?.output).toBe('a')
    expect((await copilot.list({ state: 'done' })).map((run) => run.id)).toEqual([
      'first',
      'second',
    ])
    expect(copilot.runs.get().map((run) => run.id)).toEqual(['first', 'second'])
    await copilot.destroy()
  })
})

describe('§2.6 listeners', () => {
  test('once() fires exactly once and off() removes a listener', async () => {
    const copilot = createCopilot({ provider: scriptedModel([{ text: 'a' }, { text: 'b' }]) })
    let onceCount = 0
    let offCount = 0
    const listener = () => {
      offCount += 1
    }
    copilot.once('run:done', () => {
      onceCount += 1
    })
    copilot.on('run:done', listener)
    await copilot.trigger({ input: 'a' }).result()
    copilot.off('run:done', listener)
    await copilot.trigger({ input: 'b' }).result()
    expect(onceCount).toBe(1)
    expect(offCount).toBe(1)
    await copilot.destroy()
  })

  test('on(_, _, { runId }) only sees that run; { signal } unsubscribes on abort', async () => {
    const copilot = createCopilot({ provider: scriptedModel([{ text: 'a' }, { text: 'b' }]) })
    const scoped: string[] = []
    const aborted: string[] = []
    const controller = new AbortController()
    copilot.on('run:done', ({ runId }) => scoped.push(runId), { runId: 'a' })
    copilot.on('run:done', ({ runId }) => aborted.push(runId), { signal: controller.signal })
    await copilot.trigger({ runId: 'a', input: 'a' }).result()
    controller.abort()
    await copilot.trigger({ runId: 'b', input: 'b' }).result()
    expect(scoped).toEqual(['a'])
    expect(aborted).toEqual(['a'])
    await copilot.destroy()
  })
})

describe('§2.6 attach polling', () => {
  test('a handle nobody waits on stops polling; a run this instance owns never polls', async () => {
    vi.useFakeTimers()
    try {
      const store = createMemoryRunStore()
      let reads = 0
      const counted = {
        name: 'counted',
        get: async (id: string) => {
          reads += 1
          return store.get(id)
        },
        put: (run: Run) => store.put(run),
        list: (filter?: Parameters<typeof store.list>[0]) => store.list(filter),
      }
      await store.put(record({ id: 'foreign', state: 'processing' }))
      const copilot = createCopilot({ provider: scriptedModel('ok'), runStore: counted })

      // No result() caller and no listeners ⇒ no polling at all.
      copilot.attach('foreign')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(reads).toBe(0)

      // A run this instance owns is driven by the loop, not by polling.
      await copilot.trigger({ runId: 'owned', input: 'hi' }).result()
      const before = reads
      await vi.advanceTimersByTimeAsync(30_000)
      expect(reads).toBe(before)
      await copilot.destroy()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('§2.11 createTestCopilot event recorder', () => {
  test('all() / of() / order() / waitFor() describe the same stream', async () => {
    const t = createTestCopilot({ script: 'hi' })
    const started = t.events.waitFor('run:start', { runId: 'r1' })
    await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    expect((await started).attempt).toBe(1)
    expect(t.events.of('run:done')[0]?.output).toBe('hi')
    expect(t.events.order('r1')[0]).toBe('run:queued')
    expect(t.events.all().length).toBe(t.events.order().length)
    await expect(t.events.waitFor('run:cancelled', { timeoutMs: 5 })).rejects.toThrow()
    await t.dispose()
  })
})

describe('§2.10 inspect()', () => {
  test('reports provider, tools, run counts, config, listeners and store', async () => {
    const copilot = createCopilot({
      provider: scriptedModel([{ toolCall: { name: 'probe', input: {} } }, { text: 'ok' }]),
      models: { fast: scriptedModel('fast') },
      tools: [
        defineTool({
          name: 'probe',
          description: 'a probe',
          inputSchema: z.object({ a: z.string().optional() }),
          execute: () => 'ok',
        }),
      ] as const,
      maxSteps: 4,
      concurrency: 2,
      timeoutMs: 1_000,
    })
    copilot.on('run:done', () => undefined)
    copilot.subscribe(() => undefined)
    await copilot.trigger({ runId: 'r1', input: 'hi' }).result()

    const report = copilot.inspect()
    expect(report.version).toBe('0.0.0')
    expect(report.provider).toEqual({ models: ['fast'], default: 'scripted' })
    expect(report.tools[0]).toMatchObject({
      name: 'probe',
      description: 'a probe',
      calls: 1,
      errors: 0,
    })
    expect(report.tools[0]?.avgMs).toBeGreaterThanOrEqual(0)
    expect(report.tools[0]?.schema).toMatchObject({ type: 'object' })
    expect(report.runs).toEqual({ queued: 0, processing: 0, done: 1, error: 0, cancelled: 0 })
    expect(report.config).toEqual({
      maxSteps: 4,
      concurrency: 2,
      timeoutMs: 1_000,
      maxAttempts: MAX_ATTEMPTS,
    })
    expect(report.listeners['run:done']).toBe(1)
    expect(report.listeners['*']).toBe(1)
    expect(report.store).toEqual({ name: 'memory', lastError: null })
    await copilot.destroy()
  })

  test('provider.default is null when the injected instance exposes no modelId', async () => {
    const bare = { specificationVersion: 'v3', provider: 'x', modelId: '', supportedUrls: {} }
    const copilot = createCopilot({ provider: bare as unknown as LanguageModelLike })
    expect(copilot.inspect().provider.default).toBeNull()
    await copilot.destroy()
  })
})

describe('§2.1 lazyModel', () => {
  test('defers construction to the first attempt and memoizes it', async () => {
    let built = 0
    const copilot = createCopilot({
      provider: lazyModel(() => {
        built += 1
        return scriptedModel([{ text: 'one' }, { text: 'two' }])
      }),
    })
    expect(built).toBe(0)
    await copilot.trigger({ input: 'a' }).result()
    await copilot.trigger({ input: 'b' }).result()
    expect(built).toBe(1)
    await copilot.destroy()
  })

  test('a rejecting factory surfaces as provider_error ON THAT ATTEMPT and is not memoized', async () => {
    // §2.1 / decision log #32: `lazyModel` memoizes SUCCESS only. A cached rejection would poison
    // every run for the rest of the worker's life, and the MV3 case is precisely "the first wake
    // preceded the API key being stored" — so attempt 2 calls the factory again.
    vi.useFakeTimers()
    try {
      let calls = 0
      const t = createTestCopilot({
        provider: lazyModel(() => {
          calls += 1
          if (calls === 1) throw new Error('no api key yet')
          return scriptedModel('recovered')
        }),
      })
      const settled = t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
      await vi.advanceTimersByTimeAsync(5_000)
      const result = await settled
      expect(t.events.of('run:error')[0]?.error.code).toBe('provider_error')
      expect(t.events.of('run:error')[0]?.willRetry).toBe(true)
      expect(result.ok && result.output).toBe('recovered')
      expect(calls).toBe(2)
      await t.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
