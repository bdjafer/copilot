// SPEC-copilot §2.9 — one error class, a code union, `is()`, `toJSON()` and provider
// classification. Two error planes (§3.4): programmer errors throw synchronously, run errors
// are always an event plus a Run record.

export type CopilotErrorCode =
  // programmer errors — thrown synchronously from createCopilot / trigger
  | 'no_provider'
  | 'duplicate_tool'
  | 'unknown_model'
  | 'unknown_tool'
  | 'invalid_options'
  | 'destroyed'
  // run errors — always events + a Run record, never a rejection
  | 'tool_not_found'
  | 'tool_input_invalid'
  | 'tool_failed'
  | 'tool_timeout'
  | 'provider_error'
  | 'rate_limited'
  | 'timeout'
  | 'step_limit'
  | 'context_render_failed'
  | 'aborted'
  | 'run_not_found'
  | 'store_failed'
  | 'max_attempts'

/** The retryable set (§2.9): 5xx / network, 429, and our own per-attempt wall clock. */
const RETRYABLE: ReadonlySet<CopilotErrorCode> = new Set<CopilotErrorCode>([
  'provider_error',
  'rate_limited',
  'timeout',
])

const CODES: ReadonlySet<string> = new Set<CopilotErrorCode>([
  'no_provider',
  'duplicate_tool',
  'unknown_model',
  'unknown_tool',
  'invalid_options',
  'destroyed',
  'tool_not_found',
  'tool_input_invalid',
  'tool_failed',
  'tool_timeout',
  'provider_error',
  'rate_limited',
  'timeout',
  'step_limit',
  'context_render_failed',
  'aborted',
  'run_not_found',
  'store_failed',
  'max_attempts',
])

export interface CopilotErrorOptions {
  runId?: string
  toolName?: string
  cause?: unknown
  /** Escape hatch for provider classification; defaults to the code's retryability. */
  retryable?: boolean
}

export class CopilotError extends Error {
  override readonly name = 'CopilotError' as const
  readonly code: CopilotErrorCode
  readonly runId?: string
  readonly toolName?: string
  readonly retryable: boolean
  override readonly cause?: unknown

  constructor(code: CopilotErrorCode, message?: string, options: CopilotErrorOptions = {}) {
    super(message ?? code.replaceAll('_', ' '))
    this.code = code
    this.retryable = options.retryable ?? RETRYABLE.has(code)
    if (options.runId !== undefined) this.runId = options.runId
    if (options.toolName !== undefined) this.toolName = options.toolName
    if (options.cause !== undefined) this.cause = options.cause
  }

  static is(e: unknown, code?: CopilotErrorCode): e is CopilotError {
    if (!(e instanceof CopilotError)) return false
    return code === undefined || e.code === code
  }

  /** Structured-clone-safe projection, for cross-context transports (§3.3.13). */
  toJSON(): {
    name: 'CopilotError'
    code: CopilotErrorCode
    message: string
    runId?: string
    toolName?: string
    retryable: boolean
  } {
    return {
      name: 'CopilotError',
      code: this.code,
      message: this.message,
      ...(this.runId === undefined ? {} : { runId: this.runId }),
      ...(this.toolName === undefined ? {} : { toolName: this.toolName }),
      retryable: this.retryable,
    }
  }
}

/** §2.9 — true for `provider_error`, `rate_limited` and `timeout`. */
export function isRetryable(e: unknown): boolean {
  return e instanceof CopilotError ? e.retryable : false
}

/* ------------------------------------------------------------------ */
/* provider-error classification                                       */
/* ------------------------------------------------------------------ */

function statusOf(e: object): number | undefined {
  const status =
    (e as { statusCode?: unknown; status?: unknown }).statusCode ??
    (e as { status?: unknown }).status
  return typeof status === 'number' ? status : undefined
}

function isAbort(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false
  const name = (e as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError' || name === 'AI_AbortError'
}

/**
 * Map anything thrown by the provider / AI SDK onto a `CopilotError`. Retryability follows the
 * §2.9 set: 5xx and network failures are `provider_error`, 429 is `rate_limited`, aborts are
 * `aborted` (never retried — the host asked for it).
 */
export function classifyProviderError(e: unknown, runId?: string): CopilotError {
  if (CopilotError.is(e)) return e
  if (isAbort(e)) {
    return new CopilotError('aborted', messageOf(e), { runId, cause: e })
  }
  if (typeof e === 'object' && e !== null) {
    const status = statusOf(e)
    if (status === 429) {
      return new CopilotError('rate_limited', messageOf(e), { runId, cause: e })
    }
    if (status !== undefined && status >= 400 && status < 500) {
      // 4xx other than 429 is a request the provider will reject identically next time.
      return new CopilotError('provider_error', messageOf(e), {
        runId,
        cause: e,
        retryable: false,
      })
    }
    const retryable = (e as { isRetryable?: unknown }).isRetryable
    if (typeof retryable === 'boolean') {
      return new CopilotError('provider_error', messageOf(e), { runId, cause: e, retryable })
    }
  }
  return new CopilotError('provider_error', messageOf(e), { runId, cause: e })
}

export function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  try {
    return JSON.stringify(e) ?? String(e)
  } catch {
    return String(e)
  }
}

/**
 * `Run.error` is a plain string (the record is locked at nine fields), so the code is encoded as
 * a `code: message` prefix and decoded here. This is the only way `attach()` — which sees a
 * record written by another process — can hand back a typed `CopilotError`.
 */
export function encodeRunError(error: CopilotError): string {
  return `${error.code}: ${error.message}`
}

export function decodeRunError(text: string | undefined, runId: string): CopilotError | null {
  if (text === undefined) return null
  const at = text.indexOf(': ')
  if (at > 0) {
    const code = text.slice(0, at)
    if (CODES.has(code)) {
      return new CopilotError(code as CopilotErrorCode, text.slice(at + 2), { runId })
    }
  }
  // A string this runtime did not encode — another process, an older version, a host-written
  // record. It still came off a TERMINAL record, and terminal is absorbing (§3.1), so reporting
  // it as retryable would invite a retry of a run that can never be retried.
  return new CopilotError('provider_error', text, { runId, retryable: false })
}
