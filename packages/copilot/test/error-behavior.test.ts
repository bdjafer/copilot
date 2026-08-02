// SPEC-copilot §3.4 — the two error planes, tool policy, provider classification, step limit,
// renderContext failure, store failure and listener isolation.
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import type { Run, RunStore } from '../src/types.ts'

import { createCopilot, CopilotError, defineTool } from '../src/index.ts'
import { createMemoryRunStore } from '../src/store/memory.ts'
import { createTestCopilot } from '../src/testing/harness.ts'
import { scriptedModel } from '../src/testing/scripted-model.ts'
import { httpError, textAndToolCallModel } from './support.ts'

/** A copilot with no registered tools types `ToolCall<[]>` as `never` — correctly. */
type AnyCall =
  | { name: string; ok: true; input: unknown; output: unknown }
  | { name: string; ok: false; input: unknown; error: CopilotError }
const asCall = (call: unknown): AnyCall => call as AnyCall

describe('§3.4 programmer errors throw synchronously', () => {
  test('a missing provider is `no_provider`', () => {
    expect(() => createCopilot({} as never)).toThrowError(
      expect.objectContaining({ code: 'no_provider' }),
    )
  })

  test('duplicate tool names are `duplicate_tool`', () => {
    const tool = defineTool({
      name: 'dup',
      description: 'd',
      inputSchema: z.object({}),
      execute: () => 1,
    })
    expect(() => createCopilot({ provider: scriptedModel(), tools: [tool, tool] })).toThrowError(
      expect.objectContaining({ code: 'duplicate_tool' }),
    )
  })

  test('an unknown `model` key throws `unknown_model` synchronously from trigger()', () => {
    const copilot = createCopilot({ provider: scriptedModel(), models: { fast: scriptedModel() } })
    expect(() => copilot.trigger({ input: 'hi', model: 'nope' })).toThrowError(
      expect.objectContaining({ code: 'unknown_model' }),
    )
    void copilot.destroy()
  })

  test('an unknown per-run tool name throws `unknown_tool` synchronously from trigger()', () => {
    const copilot = createCopilot({ provider: scriptedModel() })
    expect(() => copilot.trigger({ input: 'hi', tools: ['nope'] as never })).toThrowError(
      expect.objectContaining({ code: 'unknown_tool' }),
    )
    void copilot.destroy()
  })

  test('bad options are `invalid_options`', () => {
    expect(() => createCopilot({ provider: scriptedModel(), maxSteps: 0 })).toThrowError(
      expect.objectContaining({ code: 'invalid_options' }),
    )
    expect(() => createCopilot({ provider: scriptedModel(), concurrency: 0 })).toThrowError(
      expect.objectContaining({ code: 'invalid_options' }),
    )
  })

  test('trigger() after destroy() throws `destroyed`', async () => {
    const copilot = createCopilot({ provider: scriptedModel() })
    await copilot.destroy()
    expect(() => copilot.trigger({ input: 'hi' })).toThrowError(
      expect.objectContaining({ code: 'destroyed' }),
    )
  })
})

describe('§3.4 run errors are events plus a Run record', () => {
  test('trigger() never rejects and result() never rejects for a failed run', async () => {
    vi.useFakeTimers()
    try {
      const t = createTestCopilot({
        provider: scriptedModel([
          { error: httpError(500) },
          { error: httpError(500) },
          { error: httpError(500) },
        ]),
      })
      const settled = t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(settled).resolves.toMatchObject({ ok: false, reason: 'error' })
      expect((await t.copilot.get('r1'))?.state).toBe('error')
      await t.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a throwing tool goes back to the model and the loop continues', async () => {
    const t = createTestCopilot({
      script: [{ toolCall: { name: 'boom', input: {} } }, { text: 'recovered from the failure' }],
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
    const result = await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    expect(result.ok && result.output).toBe('recovered from the failure')
    const toolResult = t.events.of('tool:result')[0]
    expect(toolResult?.call.ok).toBe(false)
    expect(toolResult?.call.ok === false && toolResult.call.error.code).toBe('tool_failed')
    expect(t.events.of('error').map((e) => e.scope)).toContain('tool')
    await t.dispose()
  })

  test('a tool call for an unregistered tool is tool_not_found, fed back to the model', async () => {
    const t = createTestCopilot({
      script: [{ toolCall: { name: 'ghost', input: {} } }, { text: 'moved on' }],
    })
    const result = await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    expect(result.ok && result.output).toBe('moved on')
    const call = asCall(t.events.of('tool:result')[0]?.call)
    expect(call.ok === false && call.error.code).toBe('tool_not_found')
    await t.dispose()
  })

  test('invalid model-generated input is tool_input_invalid, fed back to the model', async () => {
    const t = createTestCopilot({
      script: [
        { toolCall: { name: 'typed', input: { n: 'not a number' } } },
        { text: 'carried on' },
      ],
      tools: [
        defineTool({
          name: 'typed',
          description: 'd',
          inputSchema: z.object({ n: z.number() }),
          execute: ({ n }) => n,
        }),
      ] as const,
    })
    const result = await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    expect(result.ok && result.output).toBe('carried on')
    const toolResult = t.events.of('tool:result')[0]
    expect(toolResult?.call.ok === false && toolResult.call.error.code).toBe('tool_input_invalid')
    await t.dispose()
  })

  test('provider classification: 429 ⇒ rate_limited (retryable), 4xx ⇒ provider_error (not)', async () => {
    vi.useFakeTimers()
    try {
      const rate = createTestCopilot({
        provider: scriptedModel([{ error: httpError(429) }, { text: 'ok' }]),
      })
      const settled = rate.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
      await vi.advanceTimersByTimeAsync(5_000)
      await settled
      expect(rate.events.of('run:error')[0]?.error.code).toBe('rate_limited')
      expect(rate.events.of('run:error')[0]?.willRetry).toBe(true)
      await rate.dispose()

      const bad = createTestCopilot({ provider: scriptedModel([{ error: httpError(400) }]) })
      const result = await bad.copilot.trigger({ runId: 'r2', input: 'hi' }).result()
      expect(!result.ok && result.error?.code).toBe('provider_error')
      expect(bad.events.of('run:error')[0]?.willRetry).toBe(false)
      await bad.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('step limit with NO text ends the run as error / step_limit — never a silent hang', async () => {
    const t = createTestCopilot({
      maxSteps: 2,
      script: [
        { toolCall: { name: 'loop', input: {} } },
        { toolCall: { name: 'loop', input: {} } },
        { toolCall: { name: 'loop', input: {} } },
      ],
      tools: [
        defineTool({
          name: 'loop',
          description: 'd',
          inputSchema: z.object({}),
          execute: () => 'again',
        }),
      ] as const,
    })
    const result = await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    expect(!result.ok && result.error?.code).toBe('step_limit')
    expect(t.events.of('run:step').at(-1)?.finishReason).toBe('step-limit')
    expect((await t.copilot.get('r1'))?.state).toBe('error')
    await t.dispose()
  })

  test('step limit WITH text ends the run as done with finishReason "step-limit"', async () => {
    const t = createTestCopilot({
      maxSteps: 2,
      provider: textAndToolCallModel('loop', 'partial answer'),
      tools: [
        defineTool({
          name: 'loop',
          description: 'd',
          inputSchema: z.object({}),
          execute: () => 'again',
        }),
      ] as const,
    })
    const result = await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    expect(result.ok).toBe(true)
    expect(result.ok && result.output).toBe('partial answer')
    expect(t.events.of('run:step').at(-1)?.finishReason).toBe('step-limit')
    expect((await t.copilot.get('r1'))?.state).toBe('done')
    await t.dispose()
  })

  test('a failed call carries the model’s RAW input, and it is never null/undefined', async () => {
    // §2.8 types `ToolCall.input` as `ToolInputOf<K>` on BOTH branches, but a call that failed
    // validation has no validated input to report. The runtime hands back what the model sent —
    // §7.1's `call.input.text` therefore compiles, reads `undefined`, and must not throw.
    const t = createTestCopilot({
      script: [
        { toolCall: { name: 'typed', input: { n: 'not a number' } } },
        { text: 'carried on' },
      ],
      tools: [
        defineTool({
          name: 'typed',
          description: 'd',
          inputSchema: z.object({ n: z.number() }),
          execute: ({ n }) => n,
        }),
      ] as const,
    })
    await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    const call = t.events.of('tool:result')[0]?.call
    expect(call?.ok).toBe(false)
    expect(call?.input).toEqual({ n: 'not a number' })
    expect(call?.input === null || call?.input === undefined).toBe(false)
    await t.dispose()
  })

  test('an unregistered tool call also carries a non-null `input`', async () => {
    const t = createTestCopilot({
      script: [{ toolCall: { name: 'ghost', input: { a: 1 } } }, { text: 'moved on' }],
    })
    await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    const call = asCall(t.events.of('tool:result')[0]?.call)
    expect(call.ok).toBe(false)
    expect(call.input === null || call.input === undefined).toBe(false)
    await t.dispose()
  })

  test('renderContext failure is context_render_failed and is not retryable', async () => {
    const t = createTestCopilot({
      script: 'ok',
      renderContext: () => {
        throw new Error('cannot render')
      },
    })
    const result = await t.copilot.trigger({ runId: 'r1', input: 'hi', context: { a: 1 } }).result()
    expect(!result.ok && result.error?.code).toBe('context_render_failed')
    expect(t.events.of('run:start')).toHaveLength(1)
    expect(t.events.of('error').map((e) => e.scope)).toContain('context')
    await t.dispose()
  })

  test('run-store failure is fatal: an `error` event with scope store, and result() settles', async () => {
    const inner = createMemoryRunStore()
    let fail = false
    const store: RunStore = {
      name: 'flaky',
      get: (id) => inner.get(id),
      put: async (run: Run) => {
        if (fail) throw new Error('quota exceeded')
        await inner.put(run)
      },
      list: (filter) => inner.list(filter),
    }
    const copilot = createCopilot({ provider: scriptedModel('ok'), runStore: store })
    const scopes: string[] = []
    copilot.on('error', ({ scope }) => scopes.push(scope))
    fail = true
    const result = await copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    expect(scopes).toContain('store')
    expect(!result.ok && result.error?.code).toBe('store_failed')
    expect(!result.ok && result.error?.retryable).toBe(false)
    // The placeholder record must report the failure that actually happened, not `run_not_found`.
    expect(!result.ok && result.run.error).toMatch(/^store_failed: /)
    expect(copilot.inspect().store).toMatchObject({ name: 'flaky' })
    expect(copilot.inspect().store.lastError).toBe('quota exceeded')
    await copilot.destroy()
  })

  test('onError receives every `error` event', async () => {
    const seen: string[] = []
    const t = createTestCopilot({
      script: [{ toolCall: { name: 'ghost', input: {} } }, { text: 'ok' }],
      onError: (error, scope) => seen.push(`${scope}:${error.code}`),
    })
    await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    expect(seen).toContain('tool:tool_not_found')
    await t.dispose()
  })

  test('CopilotError.is narrows a tool error inside a typed step handler', async () => {
    const t = createTestCopilot({
      script: [{ toolCall: { name: 'ghost', input: {} } }, { text: 'ok' }],
    })
    const codes: string[] = []
    t.copilot.on('run:step', ({ calls }) => {
      for (const raw of calls) {
        const call = asCall(raw)
        if (!call.ok && CopilotError.is(call.error, 'tool_not_found')) codes.push(call.error.code)
      }
    })
    await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    expect(codes).toEqual(['tool_not_found'])
    await t.dispose()
  })
})
