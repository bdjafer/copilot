/**
 * The `chrome.runtime` Port relay (PLAN §4.5, SPEC-copilot §3.3.13).
 *
 * Two duties, both the relay's and neither the runtime's:
 *
 * 1. **Projection.** Exactly four payloads are structured-clone-safe and post verbatim:
 *    `run:token`, `run:queued`, `run:done`, `run:cancelled`. Everything else carries a live
 *    `CopilotError` — an `Error` subclass, so structured clone silently drops `code`,
 *    `retryable`, `runId` and `toolName`, and throws `DataCloneError` on a non-cloneable
 *    `.cause`. `code` is the field the page branches on, so an unprojected relay delivers
 *    `undefined` exactly where it matters.
 * 2. **Dedupe keys.** `seq` is monotonic *per run per emitting instance*, and `run:settled` is
 *    unique per instance rather than per run (§3.3.5) — an SW that owns a run and an options
 *    page attached to it each emit their own. The relay forwards `(runId, instanceId, seq)`
 *    untouched; `createRelayClient` on the page is what actually dedupes.
 *
 * An open port also extends the worker's lifetime, which is why the streaming channel is a port
 * and not a broadcast.
 */

import type { CopilotEvent } from '@astrale-os/browser-copilot'

import { CopilotError } from '@astrale-os/browser-copilot'

import type { PortLike } from '../platform.ts'

// Declared in `messaging.ts` so the page end can open the port without importing this module,
// which would pull the whole copilot runtime into the content-script bundle.
export { RELAY_PORT_NAME } from '../messaging.ts'

/** The four clone-safe payloads of §3.3.13, as a set so the test can assert the list exactly. */
export const CLONE_SAFE_EVENTS: ReadonlySet<string> = new Set([
  'run:token',
  'run:queued',
  'run:done',
  'run:cancelled',
])

/** What a projected `CopilotError` looks like on the wire. `CopilotError.toJSON()`'s shape. */
export interface ProjectedError {
  name: 'CopilotError'
  code: string
  message: string
  retryable: boolean
  runId?: string
  toolName?: string
}

const projectError = (error: unknown): ProjectedError | null =>
  CopilotError.is(error) ? (error.toJSON() as ProjectedError) : null

/**
 * Hand-projects the events the bridge relays. Returns `null` for events the relay drops, so the
 * caller's branch is "post it or don't" and the projection table lives in exactly one place.
 *
 * The relay forwards six of thirteen event types: the token stream, the two lifecycle edges the
 * chip is driven from, and the three terminals. `tool:call` / `tool:result` / `runtime:*` are
 * deliberately not forwarded — nothing on the page renders them, and every forwarded event is
 * a message a dormant worker has to be awake to send.
 */
export function projectEvent(event: CopilotEvent): unknown {
  switch (event.type) {
    case 'run:token':
    case 'run:queued':
    case 'run:done':
    case 'run:cancelled':
      // Clone-safe verbatim: their `Run` — `context` and `spec` included — is JSON by contract.
      return event

    case 'run:settled': {
      const { result } = event.payload
      return {
        ...event,
        payload: {
          ...event.payload,
          result: { ...result, error: result.ok ? null : projectError(result.error) },
        },
      }
    }

    case 'run:error':
      return {
        ...event,
        payload: { ...event.payload, error: projectError(event.payload.error) },
      }

    case 'run:step':
      // Every failed ToolCall holds a live CopilotError, and `call.input` is raw model output —
      // JSON in practice, never validated as such by the runtime.
      return {
        ...event,
        payload: {
          ...event.payload,
          calls: event.payload.calls.map((call) =>
            call.ok ? call : { ...call, error: projectError(call.error) },
          ),
        },
      }

    default:
      return null
  }
}

export interface RelaySource {
  subscribe(listener: (event: CopilotEvent) => void): () => void
}

/**
 * Attaches one subscription per connected port. `postMessage` on a disconnected port throws, so
 * every post is guarded: a page that navigates away mid-run must not turn into an unhandled
 * exception inside the runtime's synchronous emit loop (§3.3.10), which would surface as a
 * `scope: 'listener'` error on an otherwise healthy run.
 */
export function attachRelay(port: PortLike, source: RelaySource): () => void {
  let live = true
  const off = source.subscribe((event) => {
    if (!live) return
    const projected = projectEvent(event)
    if (projected === null) return
    try {
      port.postMessage(projected)
    } catch {
      live = false
      off()
    }
  })
  const dispose = () => {
    if (!live) return
    live = false
    off()
  }
  port.onDisconnect.addListener(dispose)
  return dispose
}
