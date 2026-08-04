/**
 * Client-side identifier generation (SPEC-swarm §2.5 rule 3, §6.3, C11).
 *
 * Two kinds of id are minted here and they answer to different rules:
 *
 *  - **idempotency keys.** §6.3 says every mutating intent carries one, "generated if omitted",
 *    and §2.5 says an in-flight `req` is re-sent with **the same** key so the durable cache
 *    (keyed `(tokenId, idempotencyKey)`, TTL 24 h) returns the original response — *including the
 *    original error*. So a key is minted once per intent call and then never re-derived; a key
 *    regenerated on the retry path would turn one `land` into two.
 *  - **delegation ids** (C11). The client always fills `CreateDelegationInput.delegationId`, even
 *    online, so the offline optimistic record and the server's record share an id. Filling it
 *    only in the offline branch would give the two paths different reconciliation stories.
 *
 * `crypto.randomUUID` is not reachable: the client core typechecks under `lib: ["ES2022"]` with
 * no `dom` and no `@types/node` (§13), where `crypto` is not declared. `Math.random` is ES2022
 * and the ids never leave one server's idempotency table, so 96 random bits per instance plus a
 * per-instance monotonic counter is the right amount of collision resistance for the job.
 *
 * DOM-free and Node-free.
 */

const RADIX = 36

function randomChunk(): string {
  return Math.random().toString(RADIX).slice(2, 10)
}

export interface IdFactory {
  /** Stable for the life of one client; distinguishes two heads that restarted in the same ms. */
  readonly instanceId: string
  /** `<prefix>-<instance>-<n>` — monotonic within an instance, so ordering is readable in a log. */
  next(prefix: string): string
}

export function createIdFactory(now: () => number): IdFactory {
  const instanceId = `${now().toString(RADIX)}${randomChunk()}`
  let counter = 0
  return {
    instanceId,
    next(prefix) {
      counter += 1
      return `${prefix}-${instanceId}-${counter.toString(RADIX)}`
    },
  }
}
