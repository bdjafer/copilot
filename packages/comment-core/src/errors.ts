/**
 * Errors (SPEC-comment-core §2.14).
 *
 * One class, one code union, one guard. The guard is **brand-based, never `instanceof`**
 * (§1.2): `comment-ui.iife.js` reads `comment-core` off `globalThis.Comments`, so the two
 * bundles never share a class identity, and a structured-clone round trip drops the prototype
 * entirely. A `Symbol.for()` brand survives all three boundaries.
 *
 * DOM-free: nothing here references `lib.dom`.
 */

export type CommentErrorCode =
  | 'thread_not_found'
  | 'comment_not_found'
  | 'empty_body'
  | 'no_target'
  | 'placement_busy'
  | 'unknown_kind'
  | 'store_failed'
  /** Store is full. Distinguished from store_failed because it is the one a host can act on. */
  | 'quota_exceeded'
  | 'unsupported_version'
  | 'engine_destroyed'
  /** Bad construction/config: duplicate trigger binding, unusable option combination. */
  | 'invalid_options'
  /** start() found no usable `document`. Thrown synchronously. */
  | 'no_document'

/**
 * Cross-realm brand. Non-enumerable, so it never lands in JSON or a structured clone.
 *
 * Typed as a plain `symbol`, deliberately: `Symbol.for` returns a **registered** symbol, so a
 * `unique symbol` annotation would be a nominal guarantee the value does not have — it would
 * let two different `Symbol.for` keys typecheck as the same brand.
 */
const BRAND: symbol = Symbol.for('comment-core.error')

const MESSAGES: Record<CommentErrorCode, string> = {
  thread_not_found: 'thread not found',
  comment_not_found: 'comment not found',
  empty_body: 'comment body is empty',
  no_target: 'no placement target could be derived',
  placement_busy: 'placement is already in progress',
  unknown_kind: 'unknown mode kind',
  store_failed: 'store operation failed',
  quota_exceeded: 'store quota exceeded',
  unsupported_version: 'unsupported record version',
  engine_destroyed: 'engine is destroyed',
  invalid_options: 'invalid options',
  no_document: 'no usable document',
}

export interface CommentErrorInit {
  threadId?: string
  commentId?: string
  cause?: unknown
}

export class CommentError extends Error {
  override readonly name = 'CommentError' as const
  readonly code: CommentErrorCode
  readonly threadId?: string
  readonly commentId?: string
  declare readonly cause?: unknown

  constructor(code: CommentErrorCode, message?: string, init?: CommentErrorInit) {
    super(message ?? MESSAGES[code], init && 'cause' in init ? { cause: init.cause } : undefined)
    this.code = code
    if (init?.threadId !== undefined) this.threadId = init.threadId
    if (init?.commentId !== undefined) this.commentId = init.commentId
    Object.defineProperty(this, BRAND, { value: true, enumerable: false })
  }

  /**
   * Narrowing type guard, optionally on a specific code. Brand-based (§1.2) so it stays true
   * across the IIFE/ESM boundary, across realms, and across a structured clone.
   */
  static is(e: unknown, code?: CommentErrorCode): e is CommentError {
    if (typeof e !== 'object' || e === null) return false
    const branded = (e as Record<symbol, unknown>)[BRAND] === true
    if (!branded) return false
    return code === undefined || (e as { code?: unknown }).code === code
  }
}

/**
 * Quota detection across the three shapes §2.7 rule 6 names: a `QuotaExceededError`, a
 * `DOMException` whose `name` is `QuotaExceededError`, and an extension-runtime `QUOTA_BYTES`
 * message. The Firefox legacy name/codes are accepted too — a strict superset that cannot
 * misclassify a non-quota failure.
 */
function isQuotaFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown }
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
  if (code === 22 || code === 1014) return true
  return typeof message === 'string' && /QUOTA_BYTES|quota.{0,12}exceeded/i.test(message)
}

/**
 * Map a raw store failure onto the domain's error contract (§2.7 rule 6): `quota_exceeded`
 * when the store is full, `store_failed` otherwise, original always on `.cause`. Already-typed
 * `CommentError`s pass through unchanged, so wrapping is idempotent.
 */
export function wrapStore(error: unknown, init?: CommentErrorInit): CommentError {
  if (CommentError.is(error)) return error
  const code: CommentErrorCode = isQuotaFailure(error) ? 'quota_exceeded' : 'store_failed'
  const detail = error instanceof Error ? error.message : String(error)
  return new CommentError(code, `${MESSAGES[code]}: ${detail}`, { ...init, cause: error })
}

/** Run a store call, mapping any throw through `wrapStore`. */
export async function guardStore<T>(fn: () => Promise<T>, init?: CommentErrorInit): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    throw wrapStore(error, init)
  }
}
