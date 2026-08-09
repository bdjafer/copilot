import type { JsonValue } from './types.ts'

export type MemoryErrorCode =
  | 'invalid_input'
  | 'not_open'
  | 'space_not_found'
  | 'space_exists'
  | 'scope_denied'
  | 'policy_denied'
  | 'provider_unavailable'
  | 'provider_error'
  | 'malformed_provider_output'
  | 'ontology_violation'
  | 'unresolved'
  | 'idempotency_conflict'
  | 'not_found'
  | 'result_too_large'
  | 'conflict'
  | 'cancelled'
  | 'timeout'
  | 'storage_quota'
  | 'storage_failed'
  | 'projection_failed'
  | 'integrity_failed'
  | 'incompatible_schema'
  | 'import_invalid'
  | 'purge_in_progress'
  | 'sync_in_progress'
  | 'internal'

const ERROR_BRAND = Symbol.for('@astrale-os/temporal-memory/MemoryError')

function immutableJson(value: JsonValue, ancestors = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value !== 'object') return value
  if (ancestors.has(value)) throw new TypeError('MemoryError details must be acyclic JSON')
  ancestors.add(value)
  const snapshot = Array.isArray(value)
    ? value.map((item) => immutableJson(item, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, immutableJson(item, ancestors)]),
      )
  ancestors.delete(value)
  return Object.freeze(snapshot) as JsonValue
}

const RETRYABLE: ReadonlySet<MemoryErrorCode> = new Set([
  'provider_unavailable',
  'provider_error',
  'timeout',
  'storage_quota',
  'storage_failed',
  'projection_failed',
  'sync_in_progress',
])

export interface MemoryErrorOptions {
  operationId?: string
  retryable?: boolean
  details?: Readonly<Record<string, JsonValue>>
  cause?: unknown
}

export interface MemoryErrorJSON {
  name: 'MemoryError'
  code: MemoryErrorCode
  message: string
  retryable: boolean
  operationId?: string
  details?: Readonly<Record<string, JsonValue>>
}

export class MemoryError extends Error {
  override readonly name = 'MemoryError' as const
  readonly code: MemoryErrorCode
  readonly retryable: boolean
  readonly operationId?: string
  readonly details?: Readonly<Record<string, JsonValue>>
  override readonly cause?: unknown
  readonly [ERROR_BRAND] = true

  constructor(code: MemoryErrorCode, message?: string, options: MemoryErrorOptions = {}) {
    super(message ?? code.replaceAll('_', ' '))
    this.code = code
    this.retryable = options.retryable ?? RETRYABLE.has(code)
    if (options.operationId !== undefined) this.operationId = options.operationId
    if (options.details !== undefined) {
      this.details = immutableJson(options.details) as Readonly<Record<string, JsonValue>>
    }
    if (options.cause !== undefined) this.cause = options.cause
    Object.freeze(this)
  }

  static is(error: unknown, code?: MemoryErrorCode): error is MemoryError {
    if (typeof error !== 'object' || error === null) return false
    if ((error as { [ERROR_BRAND]?: unknown })[ERROR_BRAND] !== true) return false
    return code === undefined || (error as { code?: unknown }).code === code
  }

  toJSON(): MemoryErrorJSON {
    return {
      name: 'MemoryError',
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.operationId === undefined ? {} : { operationId: this.operationId }),
      ...(this.details === undefined ? {} : { details: this.details }),
    }
  }
}

export function isRetryable(error: unknown): boolean {
  return MemoryError.is(error) && error.retryable
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

export function classifyProviderError(error: unknown, operationId?: string): MemoryError {
  if (MemoryError.is(error)) {
    const code = new Set<MemoryErrorCode>([
      'cancelled',
      'timeout',
      'provider_unavailable',
      'provider_error',
      'malformed_provider_output',
      'policy_denied',
    ]).has(error.code)
      ? error.code
      : 'provider_error'
    return new MemoryError(code, providerErrorMessage(code), {
      operationId: operationId ?? error.operationId,
      retryable: error.retryable,
      details: { providerDiagnosticsOmitted: true },
      cause: error,
    })
  }
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name
    if (name === 'AbortError') {
      return new MemoryError('cancelled', providerErrorMessage('cancelled'), {
        operationId,
        retryable: false,
        details: { providerDiagnosticsOmitted: true },
        cause: error,
      })
    }
    const status =
      (error as { status?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode
    if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
      return new MemoryError('provider_error', providerErrorMessage('provider_error'), {
        operationId,
        retryable: false,
        details: { providerDiagnosticsOmitted: true },
        cause: error,
      })
    }
  }
  return new MemoryError('provider_error', providerErrorMessage('provider_error'), {
    operationId,
    details: { providerDiagnosticsOmitted: true },
    cause: error,
  })
}

function providerErrorMessage(code: MemoryErrorCode): string {
  if (code === 'cancelled') return 'provider call was cancelled'
  if (code === 'timeout') return 'provider call timed out'
  if (code === 'provider_unavailable') return 'provider is unavailable'
  if (code === 'malformed_provider_output') return 'provider returned malformed output'
  if (code === 'policy_denied') return 'disclosure policy denied provider call'
  return 'provider call failed'
}

export function normalizeStorageError(error: unknown, operationId?: string): MemoryError {
  if (MemoryError.is(error)) return error
  const name =
    typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined
  const message = messageOf(error)
  const quota = name === 'QuotaExceededError' || /quota/i.test(message)
  return new MemoryError(quota ? 'storage_quota' : 'storage_failed', message, {
    operationId,
    cause: error,
  })
}
