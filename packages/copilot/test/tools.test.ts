// SPEC-copilot §2.4 (tools) + §3.4 (tool error behaviour). Both-ends validation, timeouts,
// registry semantics.
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import type { ToolContext, ToolTransport } from '../src/types.ts'

import { CopilotError } from '../src/errors.ts'
import { defineTool, toJsonSchema, toolsFor } from '../src/tools/define.ts'
import { executeToolCall } from '../src/tools/execute.ts'
import { createToolRegistry } from '../src/tools/registry.ts'
import { isRemoteTool, remoteTool, serveTools } from '../src/tools/remote.ts'

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  runId: 'r1',
  step: 1,
  attempt: 1,
  signal: new AbortController().signal,
  context: undefined,
  ...over,
})

describe('§2.4 defineTool', () => {
  test('returns the definition verbatim (identity with inference)', () => {
    const tool = defineTool({
      name: 'echo',
      description: 'echoes',
      inputSchema: z.object({ text: z.string() }),
      execute: ({ text }) => text,
    })
    expect(tool.name).toBe('echo')
    expect(tool.description).toBe('echoes')
    expect(typeof tool.execute).toBe('function')
  })

  test('derives a JSON Schema for inspect() / the provider', () => {
    const tool = defineTool({
      name: 'x',
      description: 'd',
      inputSchema: z.object({ a: z.string(), b: z.number().optional() }),
      execute: () => 'ok',
    })
    const schema = toJsonSchema(tool.inputSchema) as {
      type: string
      properties: Record<string, unknown>
      required?: string[]
    }
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties)).toEqual(['a', 'b'])
    expect(schema.required).toEqual(['a'])
  })

  test('toolsFor<Ctx>() binds the context type and keeps the same runtime shape', () => {
    type Ctx = { threadId: string }
    const { defineTool: define } = toolsFor<Ctx>()
    const tool = define({
      name: 'ctx_tool',
      description: 'd',
      inputSchema: z.object({}),
      execute: (_input, c) => c.context.threadId,
    })
    expect(tool.name).toBe('ctx_tool')
  })
})

describe('§2.4 / §3.4 tool execution', () => {
  test('validates the model input against the Standard Schema before execute', async () => {
    const execute = vi.fn()
    const tool = defineTool({
      name: 't',
      description: 'd',
      inputSchema: z.object({ n: z.number() }),
      execute,
    })
    const result = await executeToolCall(tool, { n: 'not a number' }, ctx())
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error.code).toBe('tool_input_invalid')
    expect(execute).not.toHaveBeenCalled()
  })

  test('a failed call reports the model’s RAW input — it may not satisfy the schema (§2.8)', async () => {
    // Decision log #29: `ToolCall.input` is statically the tool's input type on both arms, but on
    // `ok: false` it is evidence about what the model tried, never a validated value.
    const tool = defineTool({
      name: 't',
      description: 'd',
      inputSchema: z.object({ n: z.number() }),
      execute: () => 'never',
    })
    const invalid = await executeToolCall(tool, { n: 'not a number' }, ctx())
    expect(invalid.ok).toBe(false)
    expect(invalid.input).toEqual({ n: 'not a number' })
    // …and a model that sent nothing at all still yields an object, never null/undefined.
    const missing = await executeToolCall(tool, undefined, ctx())
    expect(missing.ok).toBe(false)
    expect(missing.input).toEqual({})
  })

  test('passes the validated (parsed) value to execute', async () => {
    const tool = defineTool({
      name: 't',
      description: 'd',
      inputSchema: z.object({ n: z.coerce.number() }),
      execute: ({ n }) => n * 2,
    })
    const result = await executeToolCall(tool, { n: '21' }, ctx())
    expect(result).toMatchObject({ ok: true, output: 42 })
  })

  test('a throwing tool becomes tool_failed (fed back to the model, never fatal)', async () => {
    const tool = defineTool({
      name: 't',
      description: 'd',
      inputSchema: z.object({}),
      execute: () => {
        throw new Error('kaboom')
      },
    })
    const result = await executeToolCall(tool, {}, ctx())
    expect(result.ok === false && result.error.code).toBe('tool_failed')
    expect(result.ok === false && result.error.message).toBe('kaboom')
    expect(result.ok === false && result.error.toolName).toBe('t')
  })

  test('a CopilotError thrown by a tool keeps its code', async () => {
    const tool = defineTool({
      name: 't',
      description: 'd',
      inputSchema: z.object({}),
      execute: () => {
        throw new CopilotError('tool_failed', 'no open tab for page')
      },
    })
    const result = await executeToolCall(tool, {}, ctx())
    expect(result.ok === false && result.error.message).toBe('no open tab for page')
  })

  test('a tool that exhausts timeoutMs produces tool_timeout and aborts its signal', async () => {
    vi.useFakeTimers()
    try {
      let aborted = false
      const tool = defineTool({
        name: 'slow',
        description: 'd',
        inputSchema: z.object({}),
        timeoutMs: 50,
        execute: (_input, c) =>
          new Promise<string>((resolve) => {
            c.signal.addEventListener('abort', () => {
              aborted = true
              resolve('too late')
            })
          }),
      })
      const pending = executeToolCall(tool, {}, ctx())
      await vi.advanceTimersByTimeAsync(60)
      const result = await pending
      expect(result.ok === false && result.error.code).toBe('tool_timeout')
      expect(aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('an aborted run signal surfaces as `aborted`', async () => {
    const controller = new AbortController()
    const tool = defineTool({
      name: 't',
      description: 'd',
      inputSchema: z.object({}),
      execute: (_input, c) =>
        new Promise<string>((_resolve, reject) => {
          c.signal.addEventListener('abort', () => reject(c.signal.reason))
        }),
    })
    const pending = executeToolCall(tool, {}, ctx({ signal: controller.signal }))
    controller.abort(new CopilotError('aborted', 'cancelled'))
    const result = await pending
    expect(result.ok === false && result.error.code).toBe('aborted')
  })

  test('an output that fails outputSchema is a tool_failed, not a silent pass', async () => {
    const tool = defineTool({
      name: 't',
      description: 'd',
      inputSchema: z.object({}),
      outputSchema: z.object({ ok: z.boolean() }),
      execute: () => ({ ok: 'nope' }) as never,
    })
    const result = await executeToolCall(tool, {}, ctx())
    expect(result.ok === false && result.error.code).toBe('tool_failed')
  })
})

describe('§2.4 remoteTool + serveTools (both ends validate)', () => {
  const transportFor = (impl: ToolTransport['call']): ToolTransport => ({ call: impl })

  test('remoteTool forwards runId/step/attempt/signal/context verbatim', async () => {
    const seen: unknown[] = []
    const tool = remoteTool(
      { name: 'get_page_context', description: 'd', inputSchema: z.object({ a: z.string() }) },
      transportFor(async (name, input, c) => {
        seen.push({ name, input, runId: c.runId, step: c.step, attempt: c.attempt, ctx: c.context })
        return 'remote-ok'
      }),
    )
    const result = await executeToolCall(
      tool,
      { a: 'hi' },
      ctx({ runId: 'r9', step: 3, attempt: 2, context: { pageKey: 'p1' } }),
    )
    expect(result).toMatchObject({ ok: true, output: 'remote-ok' })
    expect(seen[0]).toEqual({
      name: 'get_page_context',
      input: { a: 'hi' },
      runId: 'r9',
      step: 3,
      attempt: 2,
      ctx: { pageKey: 'p1' },
    })
  })

  test('a malformed model call never reaches the transport (validated before transport)', async () => {
    const call = vi.fn()
    const tool = remoteTool(
      { name: 'r', description: 'd', inputSchema: z.object({ a: z.string() }) },
      transportFor(call),
    )
    const result = await executeToolCall(tool, { a: 1 }, ctx())
    expect(result.ok === false && result.error.code).toBe('tool_input_invalid')
    expect(call).not.toHaveBeenCalled()
  })

  test('a rejecting transport becomes tool_failed', async () => {
    const tool = remoteTool(
      { name: 'r', description: 'd', inputSchema: z.object({}) },
      transportFor(async () => {
        throw new Error('no open tab')
      }),
    )
    const result = await executeToolCall(tool, {}, ctx())
    expect(result.ok === false && result.error.code).toBe('tool_failed')
    expect(isRemoteTool(tool)).toBe(true)
  })

  test('serveTools exposes names and re-validates inputs on arrival', async () => {
    const served = serveTools([
      defineTool({
        name: 'show_message',
        description: 'd',
        inputSchema: z.object({ text: z.string() }),
        execute: ({ text }) => `shown:${text}`,
      }),
    ] as const)
    expect(served.names).toEqual(['show_message'])
    await expect(served.handle('show_message', { text: 'hi' })).resolves.toBe('shown:hi')
    await expect(served.handle('show_message', { text: 7 })).rejects.toMatchObject({
      code: 'tool_input_invalid',
    })
  })

  test('serveTools rejects an unknown tool name with tool_not_found', async () => {
    const served = serveTools([
      defineTool({ name: 'a', description: 'd', inputSchema: z.object({}), execute: () => 1 }),
    ] as const)
    await expect(served.handle('nope', {})).rejects.toMatchObject({ code: 'tool_not_found' })
  })

  test('serveTools always builds a complete ToolContext (envelope, then options, then ""/0)', async () => {
    let seen: ToolContext | undefined
    const served = serveTools(
      [
        defineTool({
          name: 'a',
          description: 'd',
          inputSchema: z.object({}),
          execute: (_input, c) => {
            seen = c
            return 1
          },
        }),
      ] as const,
      { context: { fallback: true } },
    )

    await served.handle('a', {})
    expect(seen).toMatchObject({ runId: '', step: 0, attempt: 0, context: { fallback: true } })
    expect(seen?.signal).toBeInstanceOf(AbortSignal)

    await served.handle(
      'a',
      {},
      { runId: 'r1', step: 2, attempt: 3, context: { from: 'envelope' } },
    )
    expect(seen).toMatchObject({ runId: 'r1', step: 2, attempt: 3, context: { from: 'envelope' } })
  })

  test('serveTools removes its upstream abort listener when the call ends', async () => {
    // A long-lived caller signal (one per port, not one per call) would otherwise accumulate one
    // listener per served call.
    const served = serveTools([
      defineTool({ name: 'a', description: 'd', inputSchema: z.object({}), execute: () => 1 }),
    ] as const)
    const controller = new AbortController()
    const added = vi.spyOn(controller.signal, 'addEventListener')
    const removed = vi.spyOn(controller.signal, 'removeEventListener')
    for (let index = 0; index < 5; index += 1) {
      await served.handle('a', {}, { signal: controller.signal })
    }
    expect(added).toHaveBeenCalledTimes(5)
    expect(removed).toHaveBeenCalledTimes(5)
    added.mockRestore()
    removed.mockRestore()
  })

  test('serveTools enforces timeoutMs locally so the far end cannot outlive the loop', async () => {
    vi.useFakeTimers()
    try {
      let aborted = false
      const served = serveTools([
        defineTool({
          name: 'slow',
          description: 'd',
          inputSchema: z.object({}),
          timeoutMs: 20,
          execute: (_input, c) =>
            new Promise<string>(() => {
              c.signal.addEventListener('abort', () => {
                aborted = true
              })
            }),
        }),
      ] as const)
      const pending = served.handle('slow', {})
      const assertion = expect(pending).rejects.toMatchObject({ code: 'tool_timeout' })
      await vi.advanceTimersByTimeAsync(30)
      await assertion
      expect(aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('§2.4 ToolRegistry', () => {
  const tools = [
    defineTool({ name: 'a', description: 'A', inputSchema: z.object({}), execute: () => 1 }),
    defineTool({ name: 'b', description: 'B', inputSchema: z.object({}), execute: () => 2 }),
  ] as const

  test('names / get / has / schema', () => {
    const registry = createToolRegistry(tools)
    expect(registry.names).toEqual(['a', 'b'])
    expect(registry.get('a')?.description).toBe('A')
    expect(registry.has('b')).toBe(true)
    expect(registry.has('zzz')).toBe(false)
    expect(registry.get('zzz' as 'a')).toBeNull()
    expect(registry.schema('a')).toMatchObject({ type: 'object' })
  })

  test('duplicate tool names are a programmer error (`duplicate_tool`)', () => {
    const dupes = [
      defineTool({ name: 'a', description: 'A', inputSchema: z.object({}), execute: () => 1 }),
      defineTool({ name: 'a', description: 'A2', inputSchema: z.object({}), execute: () => 2 }),
    ] as const
    expect(() => createToolRegistry(dupes)).toThrowError(
      expect.objectContaining({ code: 'duplicate_tool' }),
    )
  })

  test('per-run subsetting keeps only the named tools', () => {
    const registry = createToolRegistry(tools)
    expect(registry.subset(['b']).map((t) => t.name)).toEqual(['b'])
    expect(registry.subset(undefined).map((t) => t.name)).toEqual(['a', 'b'])
  })

  test('an unknown name in a subset is `unknown_tool`', () => {
    const registry = createToolRegistry(tools)
    expect(() => registry.subset(['zzz' as 'a'])).toThrowError(
      expect.objectContaining({ code: 'unknown_tool' }),
    )
  })

  test('call counters feed inspect(): calls, errors, avgMs', () => {
    const registry = createToolRegistry(tools)
    registry.record('a', 10, true)
    registry.record('a', 30, false)
    const stats = registry.stats()
    expect(stats[0]).toMatchObject({ name: 'a', calls: 2, errors: 1, avgMs: 20 })
    expect(stats[1]).toMatchObject({ name: 'b', calls: 0, errors: 0, avgMs: 0 })
  })
})
