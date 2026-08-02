// SPEC-copilot §1 / §2 — the public barrel. DOM-free end to end: this package never touches
// `document`, `window`, `navigator`, `localStorage` or `chrome`.
export { HEARTBEAT_MS, MAX_ATTEMPTS, retryDelayMs, STALE_AFTER_MS } from './constants.ts'
export { createCopilot } from './copilot.ts'
export type { CopilotErrorCode } from './errors.ts'
export { CopilotError, isRetryable } from './errors.ts'
export { lazyModel } from './loop.ts'
export { createKeyValueRunStore, defineRunStore } from './store/kv.ts'
export { createMemoryRunStore } from './store/memory.ts'
export { defineTool, toolsFor } from './tools/define.ts'
export { remoteTool, serveTools } from './tools/remote.ts'
export type {
  Awaitable,
  ContextOf,
  Copilot,
  CopilotEvent,
  CopilotEventMap,
  CopilotEventName,
  CopilotInspection,
  CopilotOptions,
  ErrorScope,
  KeyValueAdapter,
  LanguageModelLike,
  ReadableStore,
  ResumeReport,
  Run,
  RunContext,
  RunFilter,
  RunHandle,
  RunRecord,
  RunResult,
  RunStore,
  StandardSchemaV1,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolInputOf,
  ToolNameOf,
  ToolOutputOf,
  ToolRegistry,
  ToolTransport,
  TriggerInput,
  Unsubscribe,
  Usage,
} from './types.ts'
