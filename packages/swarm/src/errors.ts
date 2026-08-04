/**
 * Errors (SPEC-swarm §9). One class narrowed by `code`, serializable across the wire — the
 * trade `comment-core` made, for the reason decision log #24 gives: intents are called from a
 * service worker and a CLI, and domain refusals (`turn_in_flight`, `budget_exhausted`) are
 * *expected outcomes*. Expected outcomes that throw produce `try`/`catch` at every call site and
 * swallowed bugs, so `SwarmClientIntents` returns `{ ok: false, error }` and this class is what
 * lands in that slot.
 *
 * `retryable` is set by the server and is **authoritative**: the client retries only when it is
 * true (§9).
 *
 * DOM-free and Node-free.
 */

export type SwarmErrorCode =
  /* transport and admission (§2.1, §2.2, §2.4) */
  | 'unauthenticated'
  | 'forbidden'
  | 'unknown_frame'
  | 'bad_protocol'
  | 'frame_too_large'
  | 'bad_cursor'
  | 'stream_unknown'
  | 'rate_limited'
  /* intent boundary */
  | 'not_found'
  | 'version_conflict'
  | 'invalid_spec'
  | 'banned_effort'
  | 'unknown_effort'
  | 'turn_in_flight'
  | 'lease_held'
  /** `model`/`reasoningEffort` outside `after-turn` (§4.3.8). */
  | 'config_not_available_in_mode'
  /** ≥2 live attempts and no `attemptId` (§4.3.10). */
  | 'attempt_ambiguous'
  /** `baseRef` did not rev-parse at create (C4b). */
  | 'base_unresolvable'
  /* copilot write tools (§6.7) */
  | 'confirmation_required'
  | 'confirmation_expired'
  /* execution */
  | 'stale_fence'
  | 'budget_exhausted'
  | 'dispatch_paused'
  | 'workspace_denied'
  | 'workspace_dirty'
  | 'worktree_failed'
  | 'base_moved'
  | 'executor_unavailable'
  | 'version_floor'
  | 'executor_refused'
  | 'delivery_unknown'
  | 'verification_failed'
  | 'landing_conflict'
  | 'capability_absent'
  | 'internal'

/**
 * Every code, as data. The wire codec validates `err{code}` against this set, and
 * `swarm doctor`'s exit-code mapping is asserted against it, so a new code cannot be introduced
 * on one side of the wire only.
 */
export const SWARM_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'unknown_frame',
  'bad_protocol',
  'frame_too_large',
  'bad_cursor',
  'stream_unknown',
  'rate_limited',
  'not_found',
  'version_conflict',
  'invalid_spec',
  'banned_effort',
  'unknown_effort',
  'turn_in_flight',
  'lease_held',
  'config_not_available_in_mode',
  'attempt_ambiguous',
  'base_unresolvable',
  'confirmation_required',
  'confirmation_expired',
  'stale_fence',
  'budget_exhausted',
  'dispatch_paused',
  'workspace_denied',
  'workspace_dirty',
  'worktree_failed',
  'base_moved',
  'executor_unavailable',
  'version_floor',
  'executor_refused',
  'delivery_unknown',
  'verification_failed',
  'landing_conflict',
  'capability_absent',
  'internal',
] as const satisfies readonly SwarmErrorCode[]

const CODE_SET: ReadonlySet<string> = new Set<string>(SWARM_ERROR_CODES)

export function isSwarmErrorCode(value: unknown): value is SwarmErrorCode {
  return typeof value === 'string' && CODE_SET.has(value)
}

/**
 * Cross-realm brand, exactly as `comment-core` does it and for the same three reasons: the
 * extension head may hold a different module instance than the page, an error crossing the
 * WebSocket is rebuilt from `err{}` and never shares a prototype, and a `structuredClone` drops
 * the prototype entirely. `instanceof` is false in all three; a registered symbol survives them.
 *
 * Typed as a plain `symbol` deliberately — `Symbol.for` returns a registered symbol, so a
 * `unique symbol` annotation would claim nominal identity the value does not have.
 */
const BRAND: symbol = Symbol.for('astrale.swarm.error')

/** Defaults, so a code alone is a usable error. Overridden by the server's `err{message}`. */
const MESSAGES: Record<SwarmErrorCode, string> = {
  unauthenticated: 'not authenticated',
  forbidden: 'forbidden origin or host',
  unknown_frame: 'unknown frame kind',
  bad_protocol: 'protocol violation',
  frame_too_large: 'frame exceeds the 1 MiB cap',
  bad_cursor: 'cursor is ahead of the stream head',
  stream_unknown: 'unroutable stream',
  rate_limited: 'rate limited',
  not_found: 'not found',
  version_conflict: 'expectedVersion did not match',
  invalid_spec: 'invalid delegation spec',
  banned_effort: 'reasoning effort is banned',
  unknown_effort: 'reasoning effort is not on this provider ladder',
  turn_in_flight: 'a turn is in flight; configuration cannot change mid-turn',
  lease_held: 'the writer lease is held by another holder',
  config_not_available_in_mode: 'model and reasoningEffort require delivery: after-turn',
  attempt_ambiguous: 'this delegation has several live attempts; attemptId is required',
  base_unresolvable: 'baseRef did not resolve to a commit',
  confirmation_required: 'a human confirmation is required',
  confirmation_expired: 'the confirmation expired',
  stale_fence: 'fencing token is below the highest observed for this lease',
  budget_exhausted: 'budget exhausted',
  dispatch_paused: 'dispatch is paused',
  workspace_denied: 'workspace is outside the allowlist',
  workspace_dirty: 'workspace has uncommitted changes',
  worktree_failed: 'worktree could not be created',
  base_moved: 'the base revision has moved',
  executor_unavailable: 'executor is unavailable',
  version_floor: 'jcode is below the supported version floor',
  executor_refused: 'the executor refused the request',
  delivery_unknown: 'delivery could not be confirmed',
  verification_failed: 'verification failed',
  landing_conflict: 'landing conflicts with the target',
  capability_absent: 'the capability this requires is absent',
  internal: 'internal error',
}

/**
 * The codes the client may retry **absent a server ruling**. The server's `retryable` on the
 * wire always wins (§9); this is the local default for errors the client raises itself, before
 * any frame is written — the refusals of §4.3.3 and §4.3.8, for instance.
 */
const RETRYABLE_BY_DEFAULT: ReadonlySet<SwarmErrorCode> = new Set<SwarmErrorCode>([
  'turn_in_flight',
  'lease_held',
  'rate_limited',
  'executor_unavailable',
  'internal',
])

export interface SwarmErrorInit {
  readonly retryable?: boolean
  readonly details?: Record<string, unknown>
  readonly cause?: unknown
}

export class SwarmError extends Error {
  override readonly name = 'SwarmError' as const
  readonly code: SwarmErrorCode
  readonly retryable: boolean
  readonly details?: Record<string, unknown>
  declare readonly cause?: unknown

  constructor(code: SwarmErrorCode, message?: string, init?: SwarmErrorInit) {
    super(message ?? MESSAGES[code], init && 'cause' in init ? { cause: init.cause } : undefined)
    this.code = code
    this.retryable = init?.retryable ?? RETRYABLE_BY_DEFAULT.has(code)
    if (init?.details !== undefined) this.details = init.details
    Object.defineProperty(this, BRAND, { value: true, enumerable: false })
  }

  /** Narrowing guard, optionally on a specific code. Brand-based, never `instanceof`. */
  static is(e: unknown, code?: SwarmErrorCode): e is SwarmError {
    if (typeof e !== 'object' || e === null) return false
    if ((e as Record<symbol, unknown>)[BRAND] !== true) return false
    return code === undefined || (e as { code?: unknown }).code === code
  }

  /** The `err{}` frame body (§2.2), and what `structuredClone` carries. */
  toJSON(): {
    code: SwarmErrorCode
    message: string
    retryable: boolean
    details?: Record<string, unknown>
  } {
    return this.details === undefined
      ? { code: this.code, message: this.message, retryable: this.retryable }
      : {
          code: this.code,
          message: this.message,
          retryable: this.retryable,
          details: this.details,
        }
  }
}

/** Rebuild a `SwarmError` from an `err{}` frame body. An unknown code degrades to `internal`. */
export function swarmErrorFromWire(body: {
  code: unknown
  message?: unknown
  retryable?: unknown
  details?: unknown
}): SwarmError {
  const code = isSwarmErrorCode(body.code) ? body.code : 'internal'
  const message = typeof body.message === 'string' ? body.message : undefined
  const details =
    typeof body.details === 'object' && body.details !== null
      ? (body.details as Record<string, unknown>)
      : undefined
  return new SwarmError(code, message, {
    retryable: typeof body.retryable === 'boolean' ? body.retryable : undefined,
    details,
  })
}
