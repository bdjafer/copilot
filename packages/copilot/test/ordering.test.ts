// SPEC-copilot §3.3 — event ordering guarantees. One named test per rule (§9 DoD).
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import type { CopilotEvent, CopilotEventName } from '../src/types.ts'

import { createCopilot, defineTool } from '../src/index.ts'
import { createMemoryRunStore } from '../src/store/memory.ts'
import { createTestCopilot } from '../src/testing/harness.ts'
import { scriptedModel } from '../src/testing/scripted-model.ts'
import { httpError, recordingModel } from './support.ts'

const toolScript = [
  { toolCall: { name: 'read_thread', input: { id: 't1' } } },
  { text: 'final answer' },
]

const stubTool = () =>
  [
    defineTool({
      name: 'read_thread',
      description: 'stub',
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => ({ id, comments: [] }),
    }),
  ] as const

describe('§3.3 event ordering', () => {
  test('1. durable-first: the store already reflects the state inside the run:done handler', async () => {
    const copilot = createCopilot({ provider: scriptedModel('answer') })
    let observed: string | undefined
    const seen = new Promise<void>((resolve) => {
      copilot.on('run:done', ({ runId }) => {
        void copilot.get(runId).then((record) => {
          observed = record?.state
          resolve()
        })
      })
    })
    await copilot.trigger({ input: 'hi' }).result()
    await seen
    expect(observed).toBe('done')
    await copilot.destroy()
  })

  test('2. canonical per-attempt sequence: run:start → activity → exactly one terminal', async () => {
    const t = createTestCopilot({ script: toolScript, tools: stubTool() })
    await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    const order = t.events.order('r1')
    expect(order[0]).toBe('run:queued')
    expect(order[1]).toBe('run:start')
    expect(order.at(-1)).toBe('run:settled')
    expect(order.at(-2)).toBe('run:done')
    const terminals = order.filter((name) =>
      (['run:done', 'run:error', 'run:cancelled'] as CopilotEventName[]).includes(name),
    )
    expect(terminals).toEqual(['run:done'])
    await t.dispose()
  })

  test('3. run:queued fires once per run, before the first run:start; a resume does not re-emit it', async () => {
    const store = createMemoryRunStore()
    const t = createTestCopilot({ script: 'ok', runStore: store })
    const handle = t.copilot.trigger({ runId: 'r1', input: 'hi' })
    await handle.result()
    // Force a second attempt on a fresh instance over the same record.
    await store.put({
      ...(await store.get('r1'))!,
      state: 'processing',
      heartbeat: new Date(0).toISOString(),
    })
    const revived = t.revive()
    await revived.resumePending({ staleAfterMs: 0 })
    await revived.attach('r1').result()
    expect(t.events.order('r1').filter((name) => name === 'run:queued')).toHaveLength(1)
    expect(t.events.order('r1').indexOf('run:queued')).toBeLessThan(
      t.events.order('r1').indexOf('run:start'),
    )
    await t.dispose()
  })

  test('4. run:error with willRetry:true is not terminal — a fresh run:start follows', async () => {
    vi.useFakeTimers()
    try {
      const t = createTestCopilot({
        provider: scriptedModel([{ error: httpError(429) }, { text: 'recovered' }]),
      })
      const handle = t.copilot.trigger({ runId: 'r1', input: 'hi' })
      const settled = handle.result()
      await vi.advanceTimersByTimeAsync(5_000)
      const result = await settled
      const errors = t.events.of('run:error')
      expect(errors[0]?.willRetry).toBe(true)
      expect(errors[0]?.run.state).toBe('queued')
      const starts = t.events.of('run:start')
      expect(starts).toHaveLength(2)
      expect(starts[1]).toMatchObject({ attempt: 2, resumed: true })
      expect(result.ok).toBe(true)
      await t.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('5. exactly one run:settled per run, after the final terminal event', async () => {
    vi.useFakeTimers()
    try {
      const t = createTestCopilot({
        provider: scriptedModel([{ error: httpError(429) }, { text: 'recovered' }]),
      })
      const settled = t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
      await vi.advanceTimersByTimeAsync(5_000)
      await settled
      const order = t.events.order('r1')
      expect(order.filter((name) => name === 'run:settled')).toHaveLength(1)
      expect(order.at(-1)).toBe('run:settled')
      expect(order.at(-2)).toBe('run:done')
      await t.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('5b. one run:settled per run PER INSTANCE: an attaching instance emits its own (§2.6)', async () => {
    // §3.3.5 / decision log #28: the guarantee is per EMITTING INSTANCE. `attach` emits the
    // terminal it polled for (§2.6) and no shared counter exists to reconcile the two (§3.3.8),
    // so cross-context uniqueness is the relay's dedupe duty on (runId, instanceId, seq).
    vi.useFakeTimers()
    try {
      const store = createMemoryRunStore()
      const owner = createCopilot({
        provider: scriptedModel([{ text: 'answer', delayMs: 20_000 }]),
        runStore: store,
      })
      const observer = createCopilot({ provider: scriptedModel('unused'), runStore: store })
      const seen: string[] = []
      owner.on('run:settled', () => seen.push('owner'))
      observer.on('run:settled', () => seen.push('observer'))

      owner.trigger({ runId: 'r1', input: 'hi' })
      await vi.advanceTimersByTimeAsync(10)
      const settled = observer.attach('r1').result()
      await vi.advanceTimersByTimeAsync(30_000)
      await settled
      expect(seen).toEqual(['owner', 'observer'])
      await Promise.all([owner.destroy(), observer.destroy()])
    } finally {
      vi.useRealTimers()
    }
  })

  test('6. tool:call precedes tool:result; both precede the run:step that reports them', async () => {
    const t = createTestCopilot({ script: toolScript, tools: stubTool() })
    await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    const order = t.events.order('r1')
    const call = order.indexOf('tool:call')
    const result = order.indexOf('tool:result')
    const step = order.indexOf('run:step')
    expect(call).toBeGreaterThanOrEqual(0)
    expect(call).toBeLessThan(result)
    expect(result).toBeLessThan(step)
    const steps = t.events.of('run:step')
    expect(steps[0]?.calls.map((c) => c.name)).toEqual(['read_thread'])
    await t.dispose()
  })

  test('7. run:token never precedes run:start and never follows the terminal event', async () => {
    const t = createTestCopilot({ script: 'stream me' })
    await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    const order = t.events.order('r1')
    const first = order.indexOf('run:token')
    const last = order.lastIndexOf('run:token')
    expect(first).toBeGreaterThan(order.indexOf('run:start'))
    expect(last).toBeLessThan(order.indexOf('run:done'))
    expect(
      t.events
        .of('run:token')
        .map((e) => e.delta)
        .join(''),
    ).toBe('stream me')
    await t.dispose()
  })

  test('8. seq is monotonic per run per instance, across attempts; instanceId is stable', async () => {
    vi.useFakeTimers()
    try {
      const t = createTestCopilot({
        provider: scriptedModel([{ error: httpError(500) }, { text: 'ok' }]),
      })
      const settled = t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
      await vi.advanceTimersByTimeAsync(5_000)
      await settled
      const forRun = t.events.all().filter((event) => event.runId === 'r1')
      const seqs = forRun.map((event) => event.seq)
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      expect(new Set(seqs).size).toBe(seqs.length)
      expect(seqs[0]).toBe(1)
      expect(new Set(forRun.map((event) => event.instanceId)).size).toBe(1)
      await t.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('9. runtime:active is a leading edge emitted before the first provider request', async () => {
    vi.useFakeTimers()
    try {
      const events: CopilotEventName[] = []
      let atFirstCall: CopilotEventName[] = []
      const { model } = recordingModel('ok', () => {
        atFirstCall = [...events]
      })
      const copilot = createCopilot({ provider: model })
      copilot.subscribe((event) => events.push(event.type))
      const settled = copilot.trigger({ input: 'hi' }).result()
      await vi.advanceTimersByTimeAsync(10)
      await settled
      expect(atFirstCall).toContain('runtime:active')
      // …and runtime:idle is trailing-debounced by 500 ms.
      expect(events).not.toContain('runtime:idle')
      await vi.advanceTimersByTimeAsync(600)
      expect(events).toContain('runtime:idle')
      await copilot.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('9b. runtime:idle is not emitted when a second run starts inside the debounce window', async () => {
    vi.useFakeTimers()
    try {
      const events: CopilotEventName[] = []
      const copilot = createCopilot({ provider: scriptedModel([{ text: 'a' }, { text: 'b' }]) })
      copilot.subscribe((event) => events.push(event.type))
      await copilot.trigger({ input: 'one' }).result()
      await vi.advanceTimersByTimeAsync(100)
      const second = copilot.trigger({ input: 'two' }).result()
      await vi.advanceTimersByTimeAsync(10)
      await second
      expect(events.filter((name) => name === 'runtime:idle')).toHaveLength(0)
      expect(events.filter((name) => name === 'runtime:active')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(600)
      expect(events.filter((name) => name === 'runtime:idle')).toHaveLength(1)
      await copilot.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('10. synchronous snapshot-ordered emission: run-scoped first, then global, then `*`', async () => {
    const copilot = createCopilot({ provider: scriptedModel('ok') })
    const order: string[] = []
    copilot.on('run:done', () => order.push('global-1'))
    copilot.subscribe((event) => {
      if (event.type === 'run:done') order.push('firehose')
    })
    copilot.on('run:done', () => order.push('global-2'))
    const handle = copilot.trigger({ input: 'hi' })
    handle.on('run:done', () => order.push('run-scoped'))
    copilot.on('run:done', () => {
      // Subscribing during emission takes effect on the NEXT emission.
      copilot.on('run:done', () => order.push('late'))
    })
    await handle.result()
    expect(order).toEqual(['run-scoped', 'global-1', 'global-2', 'firehose'])
    await copilot.destroy()
  })

  test('10b. a throwing listener is isolated: one `error` event, scope listener, still subscribed', async () => {
    const copilot = createCopilot({ provider: scriptedModel('ok') })
    let calls = 0
    const errors: string[] = []
    copilot.on('run:token', () => {
      calls += 1
      throw new Error('listener blew up')
    })
    copilot.on('error', ({ scope, error }) => errors.push(`${scope}:${error.message}`))
    await copilot.trigger({ input: 'hi' }).result()
    expect(calls).toBe(2) // 'ok' streams two characters — the listener stayed subscribed
    expect(errors).toEqual(['listener:listener blew up', 'listener:listener blew up'])
    await copilot.destroy()
  })

  test('10c. a listener throwing on `error` goes to onError and never re-emits `error`', async () => {
    const onError = vi.fn()
    const copilot = createCopilot({ provider: scriptedModel('ok'), onError })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let errorEvents = 0
    copilot.on('error', () => {
      errorEvents += 1
      throw new Error('bad error listener')
    })
    copilot.on('run:done', () => {
      throw new Error('boom')
    })
    await copilot.trigger({ input: 'hi' }).result()
    expect(errorEvents).toBe(1)
    expect(onError).toHaveBeenCalled()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
    await copilot.destroy()
  })

  test('10d. off(event, fn) unbinds the global registration, not a run-scoped one', async () => {
    const copilot = createCopilot({ provider: scriptedModel('ok') })
    const order: string[] = []
    const shared = () => order.push('shared')
    const handle = copilot.trigger({ runId: 'r1', input: 'hi' })
    handle.on('run:done', shared) // run-scoped — fires FIRST (§3.3.10)
    copilot.on('run:done', () => order.push('marker'))
    copilot.on('run:done', shared) // global, same function object
    copilot.off('run:done', shared)
    await handle.result()
    // Run-scoped first, then the surviving global marker. Unbinding the run-scoped entry would
    // have produced ['marker', 'shared'].
    expect(order).toEqual(['shared', 'marker'])
    await copilot.destroy()
  })

  test('11. per-run order is total even when runs interleave at concurrency 2', async () => {
    const t = createTestCopilot({
      script: [
        { text: 'one', delayMs: 5 },
        { text: 'two', delayMs: 1 },
      ],
      concurrency: 2,
    })
    const a = t.copilot.trigger({ runId: 'a', input: 'a' }).result()
    const b = t.copilot.trigger({ runId: 'b', input: 'b' }).result()
    await Promise.all([a, b])
    for (const runId of ['a', 'b']) {
      const order = t.events.order(runId)
      expect(order.indexOf('run:queued')).toBeLessThan(order.indexOf('run:start'))
      expect(order.at(-1)).toBe('run:settled')
    }
    await t.dispose()
  })

  test('12. destroy() drops listeners, emits nothing afterwards and is idempotent', async () => {
    const copilot = createCopilot({ provider: scriptedModel([{ text: 'slow', delayMs: 50_000 }]) })
    const seen: CopilotEventName[] = []
    copilot.subscribe((event) => seen.push(event.type))
    const handle = copilot.trigger({ runId: 'r1', input: 'hi' })
    await Promise.resolve()
    await Promise.resolve()
    await copilot.destroy()
    const before = seen.length
    await copilot.destroy()
    const result = await handle.result()
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe('cancelled')
    expect(seen.length).toBe(before)
  })

  test('13. the clone-safe list is exactly run:token / run:queued / run:done / run:cancelled', async () => {
    // Decision log #27. The four payloads a relay may post verbatim — `Run` included, `spec` and
    // `context` included, because §2.2 makes both JSON by contract.
    const t = createTestCopilot({ script: 'hi' })
    await t.copilot
      .trigger({ runId: 'r1', input: 'hi', context: { threadId: 't1' }, maxSteps: 3 })
      .result()
    const cancelled = t.copilot.trigger({ runId: 'r2', input: 'bye', maxSteps: 2 })
    await t.copilot.cancel('r2', 'not needed')
    await cancelled.result()

    const CLONE_SAFE = ['run:token', 'run:queued', 'run:done', 'run:cancelled'] as const
    const seen = new Set<string>()
    for (const event of t.events.all()) {
      if ((CLONE_SAFE as readonly string[]).includes(event.type)) {
        expect(() => structuredClone(event.payload)).not.toThrow()
        seen.add(event.type)
      }
    }
    expect([...seen].sort()).toEqual(['run:cancelled', 'run:done', 'run:queued', 'run:token'])
    expect(structuredClone(t.events.of('run:done')[0]?.run.spec)).toEqual({ maxSteps: 3 })

    // Everything else is the relay's duty: a CopilotError loses `code` to structured clone.
    const cloned = structuredClone(new Error('x')) as { code?: unknown }
    expect(cloned.code).toBeUndefined()
    const settled = t.events.of('run:settled')[0]
    expect(settled).toBeDefined()
    await t.dispose()
  })

  test('13c. run:step / tool:result carry a live CopilotError: clone keeps the shape, drops `code`', async () => {
    // §3.3.13 / decision log #27: the clone-safe list is exactly run:token / run:queued /
    // run:done / run:cancelled. `run:step` and `tool:*` are NOT on it, because §2.8's `ToolCall`
    // carries a live `CopilotError` on every failed call — a relay must project them itself,
    // exactly like `run:error`.
    const t = createTestCopilot({
      script: [{ toolCall: { name: 'boom', input: {} } }, { text: 'done' }],
      tools: [
        defineTool({
          name: 'boom',
          description: 'd',
          inputSchema: z.object({}),
          execute: () => {
            throw new Error('tab is closed')
          },
        }),
      ] as const,
    })
    await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    const step = t.events.of('run:step')[0]
    const call = step?.calls[0]
    expect(call?.ok).toBe(false)
    expect(() => structuredClone(step)).not.toThrow()
    const cloned = structuredClone(step) as unknown as {
      calls: Array<{ error?: { code?: unknown } }>
    }
    expect(cloned.calls[0]?.error?.code).toBeUndefined()
    // The projection is what a relay must post instead.
    expect(call !== undefined && !call.ok && call.error.toJSON().code).toBe('tool_failed')
    const toolResult = t.events.of('tool:result')[0]
    expect(toolResult !== undefined && !toolResult.call.ok && toolResult.call.error.code).toBe(
      'tool_failed',
    )
    await t.dispose()
  })

  test('13b. an error-carrying event is relay-safe once projected through toJSON()', async () => {
    vi.useFakeTimers()
    try {
      const t = createTestCopilot({
        provider: scriptedModel([
          { error: new Error('nope') },
          { error: new Error('nope') },
          { error: new Error('nope') },
        ]),
      })
      const settled = t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await settled
      expect(result.ok).toBe(false)
      const projected = !result.ok && result.error !== null ? result.error.toJSON() : null
      expect(structuredClone(projected)).toEqual(projected)
      expect(projected?.code).toBe('max_attempts')
      await t.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('§2.8 event envelope', () => {
  test('runtime:* events carry a null runId; run events carry theirs', async () => {
    const copilot = createCopilot({ provider: scriptedModel('ok') })
    const events: CopilotEvent[] = []
    copilot.subscribe((event) => events.push(event))
    await copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    for (const event of events) {
      if (event.type === 'runtime:active' || event.type === 'runtime:idle') {
        expect(event.runId).toBeNull()
      } else {
        expect(event.runId).toBe('r1')
      }
      expect(typeof event.at).toBe('number')
      expect(event.instanceId).toMatch(/^.{8}$/)
    }
    await copilot.destroy()
  })
})
