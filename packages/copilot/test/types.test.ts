// SPEC-copilot §9 (type-level DoD) + §2.4/§2.8 — inference is the payoff of `const TName` and
// `const TTools`. These assertions are enforced by `tsgo --noEmit`, which covers `test/`.
import { describe, expect, test } from 'vitest'
import { z } from 'zod'

import type * as Api from '../src/index.ts'
import type { HEARTBEAT_MS, MAX_ATTEMPTS, STALE_AFTER_MS } from '../src/index.ts'
import type {
  ContextOf,
  Copilot,
  Run,
  ToolCall,
  ToolInputOf,
  ToolNameOf,
  ToolOutputOf,
} from '../src/types.ts'

import { createCopilot, defineTool, toolsFor } from '../src/index.ts'
import { createTestCopilot } from '../src/testing/harness.ts'
import { scriptedModel } from '../src/testing/scripted-model.ts'

type Expect<T extends true> = T
type Equal<A, B> =
  (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2 ? true : false

type Ctx = { threadId: string; pageKey: string }
const { defineTool: defineCtxTool } = toolsFor<Ctx>()

const tools = [
  defineTool({
    name: 'read_thread',
    description: 'Full thread with comments',
    inputSchema: z.object({ threadId: z.string() }),
    execute: ({ threadId }) => ({ id: threadId, comments: [] as string[] }),
  }),
  defineTool({
    name: 'show_message',
    description: 'Show a message on the page',
    inputSchema: z.object({ text: z.string() }),
    execute: ({ text }) => `shown:${text}`,
  }),
  defineCtxTool({
    name: 'list_threads',
    description: 'Threads on a page',
    inputSchema: z.object({ pageKey: z.string() }),
    execute: ({ pageKey }, ctx) => [pageKey, ctx.context.threadId].length,
  }),
] as const

type Tools = typeof tools
type Call = ToolCall<Tools>

/* -- the discriminated union is keyed on the literal tool names -- */
export type NameAssertions = [
  Expect<Equal<Call['name'], 'read_thread' | 'show_message' | 'list_threads'>>,
  Expect<Equal<ToolInputOf<Tools[0]>, { threadId: string }>>,
  Expect<Equal<ToolOutputOf<Tools[1]>, string>>,
]

/** An exhaustive switch with no casts: adding a tool makes the compiler point here. */
function describeCall(call: Call): string {
  switch (call.name) {
    case 'read_thread': {
      // `call.input.threadId` is a string; `call.output.comments` is string[].
      const id: string = call.input.threadId
      return call.ok ? `${id}:${call.output.comments.length}` : `${id}:${call.error.code}`
    }
    case 'show_message': {
      const text: string = call.input.text
      return call.ok ? call.output : `${text}:${call.error.code}`
    }
    case 'list_threads': {
      const key: string = call.input.pageKey
      return call.ok ? `${key}:${call.output}` : `${key}:${call.error.code}`
    }
    default: {
      const never: never = call
      return never
    }
  }
}

/* -- createCopilot's inference agrees with the tools' view of the context -- */
const copilot = createCopilot<Tools, Ctx>({
  provider: scriptedModel('ok'),
  tools,
  renderContext: (context) => context.pageKey,
  systemPrompt: (run: Run<Ctx>) => `thread ${run.context.threadId}`,
})

export type CopilotAssertions = [
  Expect<Equal<ToolNameOf<typeof copilot>, Call['name']>>,
  Expect<Equal<ContextOf<typeof copilot>, Ctx>>,
  Expect<
    Equal<
      (typeof copilot)['tools']['names'],
      readonly ('read_thread' | 'show_message' | 'list_threads')[]
    >
  >,
  Expect<Equal<typeof copilot, Copilot<Tools, Ctx>>>,
]

/* -- `run.context` is required (not `| undefined`) once TContext is concrete -- */
function usesContext(run: Run<Ctx>): string {
  return run.context.threadId
}

/* ------------------------------------------------------------------ */
/* §9 — the TYPE half of "every symbol in §2 is exported"              */
/* ------------------------------------------------------------------ */

/** Referencing each one proves the root barrel exports it as a type. */
export type ExportedTypeSurface = [
  Api.Unsubscribe,
  Api.Awaitable<number>,
  Api.ReadableStore<number>,
  Api.LanguageModelLike,
  Api.StandardSchemaV1,
  Api.Usage,
  Api.RunContext<Ctx>,
  Api.RunRecord,
  Api.Run<Ctx>,
  Api.ToolDefinition,
  Api.ToolContext<Ctx>,
  Api.ToolTransport<Ctx>,
  Api.ToolRegistry<Tools>,
  Api.CopilotOptions<Tools, Ctx>,
  Api.Copilot<Tools, Ctx>,
  Api.TriggerInput<Tools, Ctx>,
  Api.RunHandle<Tools, Ctx>,
  Api.RunResult<Ctx>,
  Api.RunFilter,
  Api.ResumeReport,
  Api.RunStore<Ctx>,
  Api.KeyValueAdapter,
  Api.CopilotEventMap<Tools, Ctx>,
  Api.CopilotEventName,
  Api.CopilotEvent<Tools, Ctx>,
  Api.ErrorScope,
  Api.ToolCall<Tools>,
  Api.ToolInputOf<Tools[0]>,
  Api.ToolOutputOf<Tools[0]>,
  Api.ToolNameOf<Copilot<Tools, Ctx>>,
  Api.ContextOf<Copilot<Tools, Ctx>>,
  Api.CopilotErrorCode,
  Api.CopilotInspection,
]

/** §2.3 — the constants are literal types, not `number`. */
export type ConstantAssertions = [
  Expect<Equal<typeof MAX_ATTEMPTS, 3>>,
  Expect<Equal<typeof STALE_AFTER_MS, 60_000>>,
  Expect<Equal<typeof HEARTBEAT_MS, 10_000>>,
]

/** §2.2 — `RunRecord` is the eight non-context fields; `context` arrives via `RunContext`. */
export type RunShapeAssertions = [
  Expect<
    Equal<
      keyof Api.RunRecord,
      'id' | 'state' | 'input' | 'output' | 'error' | 'attempts' | 'heartbeat' | 'createdAt'
    >
  >,
  Expect<Equal<keyof Api.Run<Ctx>, keyof Api.RunRecord | 'context'>>,
  Expect<Equal<Api.Run<Ctx>['context'], Ctx>>,
  Expect<Equal<Api.Run['context'], unknown>>,
]

/* -- §2.11 — the harness is parameterized by TTools, not cast to it -- */
const harness = createTestCopilot({ tools, script: 'ok' })

export type HarnessAssertions = [
  Expect<Equal<ToolNameOf<(typeof harness)['copilot']>, Call['name']>>,
  Expect<Equal<(typeof harness)['copilot'], Copilot<Tools, unknown>>>,
]

describe('§9 type-level definition of done', () => {
  test('the exhaustive switch compiles and narrows input/output', () => {
    expect(
      describeCall({
        name: 'read_thread',
        ok: true,
        input: { threadId: 't1' },
        output: { id: 't1', comments: ['a'] },
      }),
    ).toBe('t1:1')
    expect(
      describeCall({ name: 'show_message', ok: true, input: { text: 'hi' }, output: 'shown:hi' }),
    ).toBe('shown:hi')
    expect(
      describeCall({ name: 'list_threads', ok: true, input: { pageKey: 'p' }, output: 2 }),
    ).toBe('p:2')
  })

  test('a typed context reaches renderContext, systemPrompt and the tools', async () => {
    const result = await copilot
      .trigger({ input: 'hi', context: { threadId: 't1', pageKey: 'p1' }, tools: ['read_thread'] })
      .result()
    expect(result.ok && result.output).toBe('ok')
    expect(usesContext(result.run)).toBe('t1')
    await copilot.destroy()
  })

  test('createTestCopilot narrows ToolCall<TTools> in a run:step handler without a cast', async () => {
    const t = createTestCopilot({
      tools,
      script: [{ toolCall: { name: 'read_thread', input: { threadId: 't1' } } }, { text: 'ok' }],
    })
    const seen: string[] = []
    t.copilot.on('run:step', ({ calls }) => {
      for (const call of calls) {
        switch (call.name) {
          case 'read_thread': {
            seen.push(`read_thread:${call.input.threadId}`)
            break
          }
          case 'show_message': {
            seen.push(`show_message:${call.input.text}`)
            break
          }
          case 'list_threads': {
            seen.push(`list_threads:${call.input.pageKey}`)
            break
          }
          default: {
            const never: never = call
            return never
          }
        }
      }
    })
    await t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    expect(seen).toEqual(['read_thread:t1'])
    await t.dispose()
  })

  test('copilot.tools is the read-only registry described by §2.4', () => {
    expect(copilot.tools.names).toEqual(['read_thread', 'show_message', 'list_threads'])
    expect(copilot.tools.has('read_thread')).toBe(true)
    expect(copilot.tools.get('show_message')?.description).toBe('Show a message on the page')
    expect(copilot.tools.schema('read_thread')).toMatchObject({ type: 'object' })
    expect('setEnabled' in copilot.tools).toBe(false)
  })
})
