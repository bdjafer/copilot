import type { ToolContext, ToolDefinition } from '../types.ts'

// SPEC-copilot §3.4 — Standard-Schema validation, per-call timeout, abort plumbing and the
// error→model mapping. A tool failure is NEVER fatal to the run: it becomes a tool-result
// message describing the failure and the loop continues.
import { DEFAULT_TOOL_TIMEOUT_MS } from '../constants.ts'
import { CopilotError, messageOf } from '../errors.ts'
import { validateWithSchema } from './define.ts'

export type ToolOutcome =
  | { ok: true; input: unknown; output: unknown }
  | { ok: false; input: unknown; error: CopilotError }

/** What the model sees when a tool fails — a result, not an exception (§3.4). */
export function toolErrorPayload(error: CopilotError): {
  error: { code: string; message: string }
} {
  return { error: { code: error.code, message: error.message } }
}

export async function executeToolCall(
  tool: ToolDefinition,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  // §2.8 (normative, decision log #29): on a FAILED call, `input` is the model's raw input and
  // may not satisfy the schema — a call that failed validation has no validated input, and what
  // the model actually sent is the only useful answer. It is never left null/undefined, so
  // §7.1's `call.input.text` reads `undefined` instead of throwing.
  const fail = (error: CopilotError, input: unknown = rawInput): ToolOutcome => ({
    ok: false,
    input: input ?? {},
    error,
  })

  const validated = await validateWithSchema(tool.inputSchema, rawInput)
  if (!validated.ok) {
    return fail(
      new CopilotError('tool_input_invalid', validated.message, {
        toolName: tool.name,
        runId: ctx.runId,
      }),
    )
  }

  const input = validated.value
  if (ctx.signal.aborted) {
    return fail(
      new CopilotError('aborted', 'run aborted before the tool ran', {
        toolName: tool.name,
        runId: ctx.runId,
      }),
      input,
    )
  }

  const timeoutMs = tool.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  const controller = new AbortController()
  const onUpstreamAbort = () => controller.abort(ctx.signal.reason)
  ctx.signal.addEventListener('abort', onUpstreamAbort, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false

  try {
    const output = await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        const error = new CopilotError(
          'tool_timeout',
          `tool ${tool.name} timed out after ${timeoutMs}ms`,
          { toolName: tool.name, runId: ctx.runId },
        )
        controller.abort(error)
        reject(error)
      }, timeoutMs)
      Promise.resolve(tool.execute(input, { ...ctx, signal: controller.signal })).then(
        resolve,
        reject,
      )
    })

    if (tool.outputSchema !== undefined) {
      const checked = await validateWithSchema(tool.outputSchema, output)
      if (!checked.ok) {
        return fail(
          new CopilotError('tool_failed', `output did not match outputSchema: ${checked.message}`, {
            toolName: tool.name,
            runId: ctx.runId,
          }),
          input,
        )
      }
      return { ok: true, input, output: checked.value }
    }

    return { ok: true, input, output }
  } catch (error) {
    if (timedOut && !CopilotError.is(error, 'tool_timeout')) {
      return fail(
        new CopilotError('tool_timeout', `tool ${tool.name} timed out after ${timeoutMs}ms`, {
          toolName: tool.name,
          runId: ctx.runId,
        }),
        input,
      )
    }
    if (CopilotError.is(error)) return fail(error, input)
    if (ctx.signal.aborted) {
      const reason = ctx.signal.reason
      return fail(
        CopilotError.is(reason)
          ? reason
          : new CopilotError('aborted', messageOf(reason ?? error), {
              toolName: tool.name,
              runId: ctx.runId,
            }),
        input,
      )
    }
    return fail(
      new CopilotError('tool_failed', messageOf(error), {
        toolName: tool.name,
        runId: ctx.runId,
        cause: error,
      }),
      input,
    )
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onUpstreamAbort)
  }
}
