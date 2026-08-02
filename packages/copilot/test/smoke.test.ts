import { expect, test } from 'vitest'
import { z } from 'zod'

import { createCopilot, defineTool } from '../src/index.ts'
import { scriptedModel } from '../src/testing/scripted-model.ts'

test('end to end: text only', async () => {
  const copilot = createCopilot({ provider: scriptedModel('hello world') })
  const handle = copilot.trigger({ input: 'hi' })
  const result = await handle.result()
  expect(result.ok && result.output).toBe('hello world')
  await copilot.destroy()
})

test('end to end: tool call then text', async () => {
  const seen: unknown[] = []
  const copilot = createCopilot({
    provider: scriptedModel([
      { toolCall: { name: 'read_thread', input: { id: 't1' } } },
      { text: 'done' },
    ]),
    tools: [
      defineTool({
        name: 'read_thread',
        description: 'stub',
        inputSchema: z.object({ id: z.string() }),
        execute: ({ id }) => {
          seen.push(id)
          return { comments: [] }
        },
      }),
    ] as const,
  })
  const handle = copilot.trigger({ input: 'hi', context: { threadId: 't1' } })
  const result = await handle.result()
  expect(seen).toEqual(['t1'])
  expect(result.ok && result.output).toBe('done')
  expect(result.ok && result.steps).toBe(2)
  await copilot.destroy()
})
