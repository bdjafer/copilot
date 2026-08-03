/**
 * The page end of the token relay (SPEC-copilot §3.3.5 / §3.3.8 / §3.3.13).
 *
 * **Dedupe on `(runId, instanceId, seq)`.** `seq` is monotonic per run *per emitting instance*,
 * and `run:settled` is unique per instance, not per run — an SW that owns a run and an options
 * page attached to it each emit their own. A page that acts on both has skipped the dedupe every
 * relayed event needs, not hit a runtime bug. Ordering across instances is by `at` only; there
 * is no shared counter to give more than that.
 *
 * Deliberately DOM-free and `chrome`-free so it is testable with a plain fake port. The
 * connection itself is the caller's.
 */

export interface RelayEnvelope {
  type: string
  runId: string | null
  seq: number
  instanceId: string
  at: number
  payload: unknown
}

function isEnvelope(value: unknown): value is RelayEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const envelope = value as Partial<RelayEnvelope>
  return (
    typeof envelope.type === 'string' &&
    typeof envelope.seq === 'number' &&
    typeof envelope.instanceId === 'string'
  )
}

/**
 * A bounded remembered-key set. An unbounded `Set<string>` on a long-lived content script grows
 * with every token of every run for the life of the tab; the window only has to be wider than
 * the reordering a port can produce, which is zero — a port is ordered — so this is purely
 * belt-and-braces against a reconnect replaying a tail.
 */
const SEEN_CAP = 2000

export interface RelayClientOptions {
  /** Called once per accepted (deduped) event. */
  onEvent(event: RelayEnvelope): void
  /** Bounded key memory. Default 2000. */
  cap?: number
}

export function createRelayClient(options: RelayClientOptions) {
  const cap = options.cap ?? SEEN_CAP
  const seen = new Set<string>()
  /** Highest accepted seq per (runId, instanceId), so a replayed prefix is dropped in O(1). */
  const highWater = new Map<string, number>()

  const remember = (key: string): void => {
    seen.add(key)
    if (seen.size <= cap) return
    // Insertion order is arrival order; dropping the oldest keeps the window honest.
    const excess = seen.size - cap
    let dropped = 0
    for (const old of seen) {
      seen.delete(old)
      if (++dropped >= excess) break
    }
  }

  return {
    /** Feed one raw `port.onMessage` value. Returns true when the event was accepted. */
    accept(raw: unknown): boolean {
      if (!isEnvelope(raw)) return false
      // `runtime:active` / `runtime:idle` carry `runId: null` — never relayed by this bridge,
      // but a foreign relay could, and a null runId must not collapse every instance into one key.
      const stream = `${raw.runId ?? '~'}::${raw.instanceId}`
      const key = `${stream}::${raw.seq}::${raw.type}`
      if (seen.has(key)) return false
      const water = highWater.get(stream)
      if (water !== undefined && raw.seq <= water && seen.size >= cap) {
        // Past the remembered window AND not newer than anything accepted: a replay.
        return false
      }
      remember(key)
      if (water === undefined || raw.seq > water) highWater.set(stream, raw.seq)
      options.onEvent(raw)
      return true
    },

    /** Number of distinct (runId, instanceId) streams observed. For tests and devtools. */
    get streams(): number {
      return highWater.size
    },

    reset(): void {
      seen.clear()
      highWater.clear()
    },
  }
}

export type RelayClient = ReturnType<typeof createRelayClient>
