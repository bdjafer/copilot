// SPEC-copilot §2.4 — `remoteTool` (declared where the loop runs, executed somewhere else) and
// `serveTools` (the other end). One declaration site for the schema; inputs are validated on
// both ends (§3.4).
import type { StandardSchemaV1 } from '@standard-schema/spec'

import type { ToolContext, ToolDefinition, ToolTransport } from '../types.ts'
import type { RemoteToolInput } from './define.ts'

import { DEFAULT_TOOL_TIMEOUT_MS } from '../constants.ts'
import { CopilotError, messageOf } from '../errors.ts'
import { validateWithSchema } from './define.ts'

/** Remote tools are tagged so the runtime can report their failures with `scope: 'transport'`. */
const REMOTE = new WeakSet<object>()

export function isRemoteTool(tool: ToolDefinition): boolean {
  return REMOTE.has(tool)
}

export function remoteTool<
  const TName extends string,
  TSchema extends StandardSchemaV1,
  TOutput = unknown,
  TContext = unknown,
>(
  def: RemoteToolInput<TName, TSchema, TOutput>,
  transport: ToolTransport<TContext>,
): ToolDefinition<TName, StandardSchemaV1.InferOutput<TSchema>, TOutput, TContext> {
  const tool = {
    name: def.name,
    description: def.description,
    inputSchema: def.inputSchema,
    ...(def.outputSchema === undefined ? {} : { outputSchema: def.outputSchema }),
    ...(def.timeoutMs === undefined ? {} : { timeoutMs: def.timeoutMs }),
    // The loop validates before calling `execute`; this is the far-end hand-off.
    execute: (input: unknown, ctx: ToolContext<TContext>) =>
      transport.call(def.name, input, {
        runId: ctx.runId,
        step: ctx.step,
        attempt: ctx.attempt,
        signal: ctx.signal,
        context: ctx.context,
      }),
  } as unknown as ToolDefinition<TName, StandardSchemaV1.InferOutput<TSchema>, TOutput, TContext>

  REMOTE.add(tool)
  return tool
}

/**
 * The other end of a ToolTransport. `handle` always builds a complete `ToolContext`: its own
 * AbortController, the tool's `timeoutMs` enforced locally, and runId/step/attempt/context taken
 * from the arriving envelope, falling back to `options.context` and to `''`/`0`.
 */
export function serveTools<const TTools extends readonly ToolDefinition[]>(
  tools: TTools,
  options?: { context?: unknown },
): {
  handle(name: string, input: unknown, ctx?: Partial<ToolContext>): Promise<unknown>
  readonly names: readonly TTools[number]['name'][]
} {
  const byName = new Map<string, ToolDefinition>()
  for (const tool of tools) {
    if (byName.has(tool.name)) {
      throw new CopilotError('duplicate_tool', `duplicate tool name: ${tool.name}`)
    }
    byName.set(tool.name, tool)
  }

  return {
    names: tools.map((tool) => tool.name) as readonly TTools[number]['name'][],
    async handle(name, input, ctx) {
      const tool = byName.get(name)
      if (tool === undefined) {
        throw new CopilotError('tool_not_found', `unknown tool: ${name}`, { toolName: name })
      }

      const validated = await validateWithSchema(tool.inputSchema, input)
      if (!validated.ok) {
        throw new CopilotError('tool_input_invalid', validated.message, { toolName: name })
      }

      const controller = new AbortController()
      const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
      const upstream = ctx?.signal
      // The caller's signal outlives the call (one per port, not one per call), so the listener
      // is detached in `finally` — otherwise a long-lived transport accumulates one per call.
      const onUpstreamAbort = () => controller.abort(upstream?.reason)
      if (upstream !== undefined) {
        if (upstream.aborted) controller.abort(upstream.reason)
        else upstream.addEventListener('abort', onUpstreamAbort, { once: true })
      }

      const context: ToolContext = {
        runId: ctx?.runId ?? '',
        step: ctx?.step ?? 0,
        attempt: ctx?.attempt ?? 0,
        signal: controller.signal,
        context: ctx?.context ?? options?.context,
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        return await new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            const error = new CopilotError(
              'tool_timeout',
              `tool ${name} timed out after ${timeoutMs}ms`,
              { toolName: name },
            )
            controller.abort(error)
            reject(error)
          }, timeoutMs)
          Promise.resolve(tool.execute(validated.value, context)).then(resolve, reject)
        })
      } catch (error) {
        if (CopilotError.is(error)) throw error
        throw new CopilotError('tool_failed', messageOf(error), { toolName: name, cause: error })
      } finally {
        if (timer !== undefined) clearTimeout(timer)
        upstream?.removeEventListener('abort', onUpstreamAbort)
      }
    },
  }
}
