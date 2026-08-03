/**
 * The page's end of the token relay, connected (PLAN §4.5, SPEC-copilot §3.3.13).
 *
 * `createRelayClient` is the dedupe half and is deliberately transport-free; this is the half
 * that owns a `chrome.runtime.Port` — without it the relay is a service worker broadcasting
 * into a channel nobody has opened, and PLAN §4.5's streaming channel does not exist.
 *
 * **Connected only while something is running.** A port is not free: it extends the service
 * worker's lifetime, which is the point during a run (a >30 s run outlives the idle timer) and
 * a bug outside one — a content script on `<all_urls>` holding a port open would keep the
 * worker alive on every tab, forever. `want(true)` on the first busy thread, `want(false)` when
 * the last one settles.
 *
 * **Reconnect is the whole reason the port is not opened once at mount.** The worker dies mid-
 * run routinely; the port dies with it. `onDisconnect` while still wanted schedules a retry with
 * backoff, and the reconnect wakes the worker again — which is also what resumes the run.
 */

import type { PortLike, RuntimeLike } from '../platform.ts'
import type { RelayEnvelope } from './relay-client.ts'

import { RELAY_PORT_NAME } from '../messaging.ts'
import { createRelayClient } from './relay-client.ts'

/** Backoff schedule for reconnects, ms. Short first: a worker restart is ~instant. */
export const RECONNECT_DELAYS = [250, 1000, 4000] as const

export interface RelayLinkDeps {
  /** `chrome.runtime`, narrowed to the one call this needs. */
  runtime: Pick<RuntimeLike, 'connect'>
  /** One accepted (deduped) relayed event. */
  onEvent(event: RelayEnvelope): void
  setTimeout?(handler: () => void, ms: number): number
  clearTimeout?(handle: number): void
}

export interface RelayLink {
  /** Open the port when true, close it when false. Idempotent in both directions. */
  want(open: boolean): void
  readonly connected: boolean
  /** Reconnect attempts since the last successful connect. For tests and devtools. */
  readonly attempts: number
  destroy(): void
}

export function createRelayLink(deps: RelayLinkDeps): RelayLink {
  const setTimer = deps.setTimeout ?? ((handler, ms) => setTimeout(handler, ms) as never)
  const clearTimer = deps.clearTimeout ?? ((handle: number) => clearTimeout(handle))

  const client = createRelayClient({ onEvent: (event) => deps.onEvent(event) })
  let port: PortLike | null = null
  let wanted = false
  let destroyed = false
  let attempts = 0
  let retry: number | undefined

  const cancelRetry = (): void => {
    if (retry !== undefined) clearTimer(retry)
    retry = undefined
  }

  const scheduleRetry = (): void => {
    if (!wanted || destroyed || retry !== undefined) return
    const delay = RECONNECT_DELAYS[Math.min(attempts, RECONNECT_DELAYS.length - 1)]!
    attempts++
    retry = setTimer(() => {
      retry = undefined
      open()
    }, delay)
  }

  function open(): void {
    if (port !== null || !wanted || destroyed) return
    let opened: PortLike
    try {
      opened = deps.runtime.connect({ name: RELAY_PORT_NAME })
    } catch {
      // "Extension context invalidated" on reload, or no worker to accept the port.
      scheduleRetry()
      return
    }
    port = opened
    attempts = 0
    opened.onMessage.addListener((message: unknown) => {
      client.accept(message)
    })
    opened.onDisconnect.addListener(() => {
      if (port === opened) port = null
      // A disconnect while a run is still live is a worker death, not a shutdown: reconnecting
      // is what re-establishes the stream *and* wakes the worker that owns the run.
      scheduleRetry()
    })
  }

  const close = (): void => {
    cancelRetry()
    const open = port
    port = null
    // The dedupe window is per-connection: a fresh worker restarts `seq` at 1 for a resumed run,
    // and keeping the old high-water marks would drop the whole replayed stream.
    client.reset()
    attempts = 0
    try {
      open?.disconnect()
    } catch {
      // Already gone. Disconnecting a dead port is not an error worth propagating.
    }
  }

  return {
    want(next) {
      if (destroyed || next === wanted) return
      wanted = next
      if (next) open()
      else close()
    },
    get connected() {
      return port !== null
    },
    get attempts() {
      return attempts
    },
    destroy() {
      destroyed = true
      wanted = false
      close()
    },
  }
}
