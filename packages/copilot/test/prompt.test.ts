// SPEC-copilot §3.5 — prompt assembly, in order, for each attempt.
import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import { createCopilot, defineTool } from '../src/index.ts'
import { recordingModel } from './support.ts'

type Message = { role: string; content: unknown }

const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            typeof part === 'object' && part !== null
              ? String((part as { text?: string }).text ?? '')
              : '',
          )
          .join('')
      : ''

describe('§3.5 prompt assembly', () => {
  test('1. system comes from TriggerInput.system, then systemPrompt, then ""', async () => {
    const a = recordingModel('ok')
    const first = createCopilot({ provider: a.model, systemPrompt: 'from options' })
    await first.trigger({ input: 'hi', system: 'from trigger' }).result()
    expect(textOf((a.prompts[0] as Message[])[0]?.content)).toBe('from trigger')
    await first.destroy()

    const b = recordingModel('ok')
    const second = createCopilot({ provider: b.model, systemPrompt: 'from options' })
    await second.trigger({ input: 'hi' }).result()
    expect(textOf((b.prompts[0] as Message[])[0]?.content)).toBe('from options')
    await second.destroy()
  })

  test('1b. systemPrompt may be a function of the run', async () => {
    const { model, prompts } = recordingModel('ok')
    const copilot = createCopilot<readonly [], { kind: string }>({
      provider: model,
      systemPrompt: (run) => `prompt for ${run.context.kind}`,
    })
    await copilot.trigger({ input: 'hi', context: { kind: 'ask' } }).result()
    expect(textOf((prompts[0] as Message[])[0]?.content)).toBe('prompt for ask')
    await copilot.destroy()
  })

  test('2. rendered context defaults to JSON.stringify(context, null, 2)', async () => {
    const { model, prompts } = recordingModel('ok')
    const copilot = createCopilot({ provider: model })
    await copilot.trigger({ input: 'the input', context: { a: 1 } }).result()
    const user = (prompts[0] as Message[])[1]
    expect(textOf(user?.content)).toBe(`${JSON.stringify({ a: 1 }, null, 2)}\n\nthe input`)
    await copilot.destroy()
  })

  test('2b. renderContext replaces the default rendering', async () => {
    const { model, prompts } = recordingModel('ok')
    const copilot = createCopilot<readonly [], { threadId: string }>({
      provider: model,
      renderContext: (context) => `thread=${context.threadId}`,
    })
    await copilot.trigger({ input: 'the input', context: { threadId: 't1' } }).result()
    expect(textOf((prompts[0] as Message[])[1]?.content)).toBe('thread=t1\n\nthe input')
    await copilot.destroy()
  })

  test('3. messages are [system, user]; a run without context sends the input verbatim', async () => {
    const { model, prompts } = recordingModel('ok')
    const copilot = createCopilot({ provider: model, systemPrompt: 'sys' })
    await copilot.trigger({ input: 'just the input' }).result()
    const messages = prompts[0] as Message[]
    expect(messages.map((message) => message.role)).toEqual(['system', 'user'])
    expect(textOf(messages[1]?.content)).toBe('just the input')
    await copilot.destroy()
  })

  test('4. tools are the registered set filtered by TriggerInput.tools', async () => {
    const tools = [
      defineTool({ name: 'a', description: 'A', inputSchema: z.object({}), execute: () => 1 }),
      defineTool({ name: 'b', description: 'B', inputSchema: z.object({}), execute: () => 2 }),
    ] as const
    const { model, prompts } = recordingModel('ok')
    let offered: string[] = []
    const capture = {
      ...(model as object),
      doStream: (options: { tools?: Array<{ name: string }> }) => {
        offered = (options.tools ?? []).map((t) => t.name)
        return (model as { doStream: (o: unknown) => unknown }).doStream(options)
      },
    } as never
    const copilot = createCopilot({ provider: capture, tools })
    await copilot.trigger({ input: 'hi', tools: ['b'] }).result()
    expect(offered).toEqual(['b'])
    void prompts
    await copilot.destroy()
  })

  test('4b. omitting TriggerInput.tools offers every registered tool', async () => {
    const tools = [
      defineTool({ name: 'a', description: 'A', inputSchema: z.object({}), execute: () => 1 }),
      defineTool({ name: 'b', description: 'B', inputSchema: z.object({}), execute: () => 2 }),
    ] as const
    const { model } = recordingModel('ok')
    let offered: string[] = []
    const capture = {
      ...(model as object),
      doStream: (options: { tools?: Array<{ name: string }> }) => {
        offered = (options.tools ?? []).map((t) => t.name)
        return (model as { doStream: (o: unknown) => unknown }).doStream(options)
      },
    } as never
    const copilot = createCopilot({ provider: capture, tools })
    await copilot.trigger({ input: 'hi' }).result()
    expect(offered).toEqual(['a', 'b'])
    await copilot.destroy()
  })

  test('5. the loop stops at maxSteps (stopWhen: stepCountIs)', async () => {
    const { model, prompts } = recordingModel([
      { toolCall: { name: 'loop', input: {} } },
      { toolCall: { name: 'loop', input: {} } },
      { toolCall: { name: 'loop', input: {} } },
      { text: 'never reached' },
    ])
    const copilot = createCopilot({
      provider: model,
      maxSteps: 2,
      tools: [
        defineTool({
          name: 'loop',
          description: 'd',
          inputSchema: z.object({}),
          execute: () => 'again',
        }),
      ] as const,
    })
    await copilot.trigger({ input: 'hi' }).result()
    expect(prompts).toHaveLength(2)
    await copilot.destroy()
  })

  test('runs are stateless: nothing from a previous run enters the prompt', async () => {
    const { model, prompts } = recordingModel([{ text: 'one' }, { text: 'two' }])
    const copilot = createCopilot({ provider: model })
    await copilot.trigger({ input: 'first' }).result()
    await copilot.trigger({ input: 'second' }).result()
    expect((prompts[1] as Message[]).map((m) => textOf(m.content))).toEqual(['', 'second'])
    await copilot.destroy()
  })
})
