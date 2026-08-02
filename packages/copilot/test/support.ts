import type { ScriptedStep } from '../src/testing/scripted-model.ts'
// Shared test helpers. Nothing here is part of the public API.
import type { LanguageModelLike, ModelV3 } from '../src/types.ts'

import { scriptedModel } from '../src/testing/scripted-model.ts'

type CallOptions = Parameters<ModelV3['doStream']>[0]
type StreamResult = Awaited<ReturnType<ModelV3['doStream']>>
type StreamPart = StreamResult['stream'] extends ReadableStream<infer P> ? P : never

/** A scripted model that records the prompt it was handed, plus a hook fired on every call. */
export function recordingModel(
  script?: ScriptedStep[] | string,
  onCall?: () => void,
): { model: LanguageModelLike; prompts: CallOptions['prompt'][] } {
  const inner = scriptedModel(script) as ModelV3
  const prompts: CallOptions['prompt'][] = []
  const model: ModelV3 = {
    specificationVersion: 'v3',
    provider: 'copilot.recording',
    modelId: 'recording',
    supportedUrls: {},
    doStream: (options) => {
      prompts.push(options.prompt)
      onCall?.()
      return inner.doStream(options)
    },
    doGenerate: (options) => inner.doGenerate(options),
  }
  return { model, prompts }
}

/**
 * A model whose every step emits text AND a tool call — the shape `ScriptedStep` cannot express
 * (§2.11 locks it to one of text | toolCall | error). It is the only way to reach §3.4's
 * "reaching maxSteps ends the run as `done` with whatever text exists" branch.
 */
export function textAndToolCallModel(toolName: string, text: string): LanguageModelLike {
  let call = 0
  const model: ModelV3 = {
    specificationVersion: 'v3',
    provider: 'copilot.test',
    modelId: 'text-and-tool-call',
    supportedUrls: {},
    async doStream() {
      call += 1
      const id = `text-${call}`
      const parts: StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id },
        { type: 'text-delta', id, delta: text },
        { type: 'text-end', id },
        {
          type: 'tool-call',
          toolCallId: `call-${call}`,
          toolName,
          input: '{}',
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool_use' },
          usage: {
            inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: text.length, text: text.length, reasoning: 0 },
          },
        },
      ]
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      } as Awaited<ReturnType<ModelV3['doStream']>>
    },
    doGenerate: () => {
      throw new Error('textAndToolCallModel is streaming-only')
    },
  }
  return model
}

export function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { statusCode: status })
}

/** A run store whose methods fail on demand — for the `store_failed` paths of §3.4. */
export function failingStore(inner: {
  get: (id: string) => Promise<unknown>
  put: (run: never) => Promise<void>
  list: (filter?: never) => Promise<unknown[]>
}) {
  return inner
}
