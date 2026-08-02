/**
 * Id factory (§2.9 `DomainOptions.createId`, default `nanoid(12)`).
 *
 * The seam exists so tests can pin ids and so a host can supply its own scheme; nothing in the
 * domain ever parses an id. DOM-free.
 */

import { nanoid } from 'nanoid'

/** Default id length. 12 nanoid chars ≈ 71 bits of entropy — ample for per-page records. */
export const ID_SIZE = 12

/** Default id factory: `nanoid(12)`. */
export function createDefaultId(): string {
  return nanoid<string>(ID_SIZE)
}

/** Resolve the injectable seam once, at construction. */
export function idFactory(createId?: () => string): () => string {
  return createId ?? createDefaultId
}
