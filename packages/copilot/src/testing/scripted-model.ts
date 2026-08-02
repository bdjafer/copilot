// SPEC-copilot §2.11 — a deterministic `LanguageModelLike`. Streams `text` char by char, plays a
// `toolCall` step, or fails an attempt. No network, no provider package.
import type { LanguageModelLike, ModelV3 } from '../types.ts'

export type ScriptedStep =
  | { text: string; delayMs?: number }
  | { toolCall: { name: string; input: unknown }; delayMs?: number }
  | { error: Error }

type CallOptions = Parameters<ModelV3['doStream']>[0]
type StreamResult = Awaited<ReturnType<ModelV3['doStream']>>
type GenerateResult = Awaited<ReturnType<ModelV3['doGenerate']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never

const usage = (text: string) => ({
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: text.length, text: text.length, reasoning: 0 },
})

function normalise(script: ScriptedStep[] | string | undefined): ScriptedStep[] {
  if (script === undefined) return [{ text: 'ok' }]
  if (typeof script === 'string') return [{ text: script }]
  return script.length === 0 ? [{ text: 'ok' }] : script
}

const abortError = (reason: unknown) =>
  reason instanceof Error ? reason : Object.assign(new Error('aborted'), { name: 'AbortError' })

/** A scripted delay is abortable — a model that ignored the signal could outlive its run. */
const delay = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(abortError(signal.reason))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(abortError(signal.reason))
      },
      { once: true },
    )
  })

/**
 * A deterministic model. The script is optional and defaults to `[{ text: 'ok' }]`, so
 * `scriptedModel()` is a valid zero-argument provider.
 */
export function scriptedModel(script?: ScriptedStep[] | string): LanguageModelLike {
  const steps = normalise(script)
  let index = 0
  let callId = 0

  const nextStep = (): ScriptedStep => {
    const step = steps[index]
    index += 1
    // Exhausted scripts stop the loop rather than replaying the last step forever.
    return step ?? { text: '' }
  }

  const partsFor = async (
    step: ScriptedStep,
    signal: AbortSignal | undefined,
  ): Promise<StreamPart[]> => {
    if ('error' in step) throw step.error
    if (step.delayMs !== undefined) await delay(step.delayMs, signal)

    if ('toolCall' in step) {
      callId += 1
      return [
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: `call-${callId}`,
          toolName: step.toolCall.name,
          input: JSON.stringify(step.toolCall.input ?? {}),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage: usage(''),
        },
      ] as StreamPart[]
    }

    const id = 'text-1'
    return [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id },
      ...[...step.text].map((char) => ({ type: 'text-delta', id, delta: char })),
      { type: 'text-end', id },
      {
        type: 'finish',
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: usage(step.text),
      },
    ] as StreamPart[]
  }

  const model: ModelV3 = {
    specificationVersion: 'v3',
    provider: 'copilot.scripted',
    modelId: 'scripted',
    supportedUrls: {},
    async doStream(options: CallOptions): Promise<StreamResult> {
      const parts = await partsFor(nextStep(), options.abortSignal)
      return {
        stream: new ReadableStream<StreamPart>({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      } as StreamResult
    },
    async doGenerate(_options: CallOptions): Promise<GenerateResult> {
      const step = nextStep()
      if ('error' in step) throw step.error
      if ('toolCall' in step) {
        callId += 1
        return {
          content: [
            {
              type: 'tool-call',
              toolCallId: `call-${callId}`,
              toolName: step.toolCall.name,
              input: JSON.stringify(step.toolCall.input ?? {}),
            },
          ],
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage: usage(''),
          warnings: [],
        } as unknown as GenerateResult
      }
      return {
        content: [{ type: 'text', text: step.text }],
        finishReason: { unified: 'stop', raw: 'end_turn' },
        usage: usage(step.text),
        warnings: [],
      } as unknown as GenerateResult
    },
  }

  return model
}
