// SPEC-copilot §3.5 (prompt assembly) + §3.3.2 (per-attempt event sequence). The AI SDK is the
// loop: `ToolLoopAgent` with `stopWhen: stepCountIs(maxSteps)`, streaming always on (§8 #13).
import type { ModelMessage, Tool, ToolSet } from 'ai'

import { jsonSchema, stepCountIs, tool, ToolLoopAgent } from 'ai'

import type {
  Awaitable,
  ErrorScope,
  LanguageModelLike,
  ModelV3,
  Run,
  ToolCall,
  ToolDefinition,
  Usage,
} from './types.ts'

import { classifyProviderError, CopilotError, messageOf } from './errors.ts'
import { toJsonSchema } from './tools/define.ts'
import { executeToolCall, toolErrorPayload } from './tools/execute.ts'
import { isRemoteTool } from './tools/remote.ts'

export type AttemptOutcome =
  | { type: 'done'; output: string; steps: number; usage: Usage; finishReason: string }
  | { type: 'error'; error: CopilotError }
  | { type: 'cancelled' }

// eslint-disable-next-line no-explicit-any -- the loop is generic over the host's tool tuple
type AnyToolCall = ToolCall<any>

export interface AttemptDeps<TContext> {
  run: Run<TContext>
  attempt: number
  model: LanguageModelLike
  tools: readonly ToolDefinition[]
  maxSteps: number
  timeoutMs: number
  /** Aborted on cancel / destroy; the attempt links its own timeout controller to it. */
  signal: AbortSignal
  system: string | undefined
  systemPrompt: string | ((run: Run<TContext>) => Awaitable<string>) | undefined
  renderContext: (context: TContext, run: Run<TContext>) => Awaitable<string>
  now: () => Date
  emitToken(delta: string, step: number): void
  emitStep(payload: {
    step: number
    text: string
    calls: readonly AnyToolCall[]
    usage: Usage
    finishReason: string
  }): void
  emitToolCall(payload: { step: number; name: string; input: unknown }): void
  emitToolResult(payload: { step: number; call: AnyToolCall; durationMs: number }): void
  emitError(error: CopilotError, scope: ErrorScope): void
  recordToolStats(name: string, durationMs: number, ok: boolean): void
}

function mapUsage(usage: unknown): Usage {
  if (typeof usage !== 'object' || usage === null) return {}
  const source = usage as {
    inputTokens?: unknown
    outputTokens?: unknown
    totalTokens?: unknown
  }
  const out: Usage = {}
  if (typeof source.inputTokens === 'number') out.inputTokens = source.inputTokens
  if (typeof source.outputTokens === 'number') out.outputTokens = source.outputTokens
  if (typeof source.totalTokens === 'number') out.totalTokens = source.totalTokens
  return out
}

function addUsage(a: Usage, b: Usage): Usage {
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0)
  const out: Usage = {}
  const input = sum(a.inputTokens, b.inputTokens)
  const output = sum(a.outputTokens, b.outputTokens)
  const total = sum(a.totalTokens, b.totalTokens)
  if (input !== undefined) out.inputTokens = input
  if (output !== undefined) out.outputTokens = output
  if (total !== undefined) out.totalTokens = total
  return out
}

/** §3.5 — prompt assembly, in order, for each attempt. */
export async function assemblePrompt<TContext>(deps: {
  run: Run<TContext>
  system: string | undefined
  systemPrompt: string | ((run: Run<TContext>) => Awaitable<string>) | undefined
  renderContext: (context: TContext, run: Run<TContext>) => Awaitable<string>
}): Promise<ModelMessage[]> {
  let system = deps.system
  if (system === undefined) {
    system =
      typeof deps.systemPrompt === 'function'
        ? await deps.systemPrompt(deps.run)
        : (deps.systemPrompt ?? '')
  }

  const context = (deps.run as { context?: TContext }).context
  const rendered = context === undefined ? '' : await deps.renderContext(context, deps.run)

  return [
    { role: 'system', content: system ?? '' },
    {
      role: 'user',
      content: rendered === '' ? deps.run.input : `${rendered}\n\n${deps.run.input}`,
    },
  ]
}

export async function runAttempt<TContext>(deps: AttemptDeps<TContext>): Promise<AttemptOutcome> {
  const runId = deps.run.id

  let messages: ModelMessage[]
  try {
    messages = await assemblePrompt(deps)
  } catch (error) {
    // A deterministic prompt function fails identically on every attempt — never retryable.
    const failure = new CopilotError('context_render_failed', messageOf(error), {
      runId,
      cause: error,
    })
    deps.emitError(failure, 'context')
    return { type: 'error', error: failure }
  }

  const controller = new AbortController()
  const onUpstreamAbort = () => controller.abort(deps.signal.reason)
  if (deps.signal.aborted) return { type: 'cancelled' }
  deps.signal.addEventListener('abort', onUpstreamAbort, { once: true })

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new CopilotError('timeout', `attempt exceeded ${deps.timeoutMs}ms`, { runId }))
  }, deps.timeoutMs)

  /** Eager step counter for tool execution (callbacks fire ahead of stream consumption). */
  let eagerStep = 0
  /** Step counter derived from the ordered stream, used for tokens and `run:step`. */
  let streamStep = 0
  const callsByStep = new Map<number, AnyToolCall[]>()
  const textByStep = new Map<number, string>()

  const pushCall = (step: number, call: AnyToolCall) => {
    const list = callsByStep.get(step)
    if (list === undefined) callsByStep.set(step, [call])
    else list.push(call)
  }

  const toolSet: ToolSet = {}
  for (const definition of deps.tools) {
    toolSet[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema(
        toJsonSchema(definition.inputSchema) as Parameters<typeof jsonSchema>[0],
      ),
      execute: async (input: unknown) => {
        const step = Math.max(1, eagerStep)
        deps.emitToolCall({ step, name: definition.name, input })
        const started = deps.now().getTime()
        const outcome = await executeToolCall(definition, input, {
          runId,
          step,
          attempt: deps.attempt,
          signal: controller.signal,
          context: (deps.run as { context?: unknown }).context,
        })
        const durationMs = deps.now().getTime() - started
        const call = (
          outcome.ok
            ? { name: definition.name, ok: true, input: outcome.input, output: outcome.output }
            : { name: definition.name, ok: false, input: outcome.input, error: outcome.error }
        ) as AnyToolCall
        pushCall(step, call)
        deps.recordToolStats(definition.name, durationMs, outcome.ok)
        deps.emitToolResult({ step, call, durationMs })
        if (outcome.ok) return outcome.output
        // §3.4: tool failures go back to the model; the loop continues.
        deps.emitError(outcome.error, isRemoteTool(definition) ? 'transport' : 'tool')
        return toolErrorPayload(outcome.error)
      },
    }) as Tool
  }

  let totalUsage: Usage = {}
  let lastFinishReason = 'unknown'
  let streamError: unknown
  let stepLimitHit = false

  try {
    const agent = new ToolLoopAgent({
      model: deps.model,
      tools: toolSet,
      stopWhen: stepCountIs(deps.maxSteps),
      // §3.5 step 3 puts the system message in `messages`; the SDK only allows that on request.
      allowSystemInMessages: true,
      // The retry policy is the runtime's (§2.3 / §3.1): bounded by MAX_ATTEMPTS and spaced by
      // retryDelayMs. A second, hidden retry loop inside the SDK would make `attempts` lie.
      maxRetries: 0,
    })

    const stream = await agent.stream({
      messages,
      abortSignal: controller.signal,
      onStepStart: () => {
        eagerStep += 1
      },
    })

    for await (const part of stream.fullStream) {
      switch (part.type) {
        case 'start-step': {
          streamStep += 1
          break
        }
        case 'text-delta': {
          const step = Math.max(1, streamStep)
          textByStep.set(step, (textByStep.get(step) ?? '') + part.text)
          deps.emitToken(part.text, step)
          break
        }
        case 'tool-call': {
          // Only invalid calls surface here: a tool the model invented, or input the SDK could
          // not parse. Executed calls are reported by the wrapper above.
          if (part.invalid !== true) break
          const step = Math.max(1, streamStep)
          const error = new CopilotError(
            part.error !== undefined && /invalid/i.test(messageOf(part.error))
              ? 'tool_input_invalid'
              : 'tool_not_found',
            messageOf(part.error ?? `unknown tool: ${part.toolName}`),
            { runId, toolName: part.toolName },
          )
          deps.emitToolCall({ step, name: part.toolName, input: part.input })
          const call = {
            name: part.toolName,
            ok: false,
            // The SDK reports the raw (unparsed / unvalidated) input here, and it may be absent
            // entirely. `ToolCall.input` is never null/undefined, so §7.1's property access on a
            // failed call reads `undefined` rather than throwing.
            input: part.input ?? {},
            error,
          } as AnyToolCall
          pushCall(step, call)
          deps.emitToolResult({ step, call, durationMs: 0 })
          deps.emitError(error, 'tool')
          break
        }
        case 'finish-step': {
          const step = Math.max(1, streamStep)
          const usage = mapUsage(part.usage)
          totalUsage = addUsage(totalUsage, usage)
          lastFinishReason = part.finishReason
          // Reaching `maxSteps` with the model still asking for tools is the step limit.
          stepLimitHit = step >= deps.maxSteps && part.finishReason === 'tool-calls'
          deps.emitStep({
            step,
            text: textByStep.get(step) ?? '',
            calls: callsByStep.get(step) ?? [],
            usage,
            finishReason: stepLimitHit ? 'step-limit' : part.finishReason,
          })
          break
        }
        case 'finish': {
          const total = mapUsage(part.totalUsage)
          if (Object.keys(total).length > 0) totalUsage = total
          lastFinishReason = part.finishReason
          break
        }
        case 'error': {
          streamError = part.error
          break
        }
        case 'abort': {
          streamError ??= new CopilotError('aborted', 'stream aborted', { runId })
          break
        }
        default:
          break
      }
    }
  } catch (error) {
    streamError = error
  } finally {
    clearTimeout(timer)
    deps.signal.removeEventListener('abort', onUpstreamAbort)
  }

  if (timedOut) {
    return { type: 'error', error: new CopilotError('timeout', 'attempt timed out', { runId }) }
  }
  if (deps.signal.aborted) return { type: 'cancelled' }

  if (streamError !== undefined) {
    const failure = classifyProviderError(streamError, runId)
    if (failure.code === 'aborted') return { type: 'cancelled' }
    deps.emitError(failure, 'provider')
    return { type: 'error', error: failure }
  }

  const steps = Math.max(streamStep, 1)
  const lastText = textByStep.get(streamStep) ?? ''
  const output =
    lastText.length > 0
      ? lastText
      : [...textByStep.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([, text]) => text)
          .join('')

  if (stepLimitHit && output.trim() === '') {
    // Never a silent hang: a step limit with nothing to show is an error (§3.4).
    const failure = new CopilotError('step_limit', `run hit the ${deps.maxSteps}-step limit`, {
      runId,
    })
    deps.emitError(failure, 'provider')
    return { type: 'error', error: failure }
  }

  return {
    type: 'done',
    output,
    steps,
    usage: totalUsage,
    finishReason: stepLimitHit ? 'step-limit' : lastFinishReason,
  }
}

/**
 * Defer model construction to first use (§2.1). An MV3 service worker must register its event
 * listeners synchronously during initial evaluation, so a top-level `await getKey()` forfeits the
 * wake events the whole restart story depends on; `lazyModel` moves the await inside the first
 * attempt, where it is free.
 */
export function lazyModel(factory: () => Awaitable<LanguageModelLike>): LanguageModelLike {
  let pending: Promise<ModelV3> | undefined
  let resolved: ModelV3 | undefined

  const resolve = (): Promise<ModelV3> => {
    if (pending === undefined) {
      pending = Promise.resolve()
        .then(factory)
        .then((model) => {
          if (typeof model === 'string') {
            throw new CopilotError(
              'invalid_options',
              'lazyModel must resolve to a model instance, not a model id',
            )
          }
          resolved = model as ModelV3
          return resolved
        })
        .catch((error: unknown) => {
          // Let the next attempt try again — a rejection is `provider_error` for THAT attempt.
          pending = undefined
          throw error
        })
    }
    return pending
  }

  const model: ModelV3 = {
    specificationVersion: 'v3',
    provider: 'copilot.lazy',
    get modelId() {
      return resolved?.modelId ?? ''
    },
    supportedUrls: {},
    doGenerate: (options) => resolve().then((inner) => inner.doGenerate(options)),
    doStream: (options) => resolve().then((inner) => inner.doStream(options)),
  }
  return model
}
