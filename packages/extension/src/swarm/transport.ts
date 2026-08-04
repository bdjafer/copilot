/**
 * `SwarmTransport` over a browser `WebSocket` (SPEC-swarm §2.1, §6.1 H7).
 *
 * The client core never constructs a socket — it is handed one of these (H7), which is why the
 * same core runs in this page, in the CLI over `ws`, and in a test over a fake. This module is
 * the extension's half of that seam and it is deliberately the *only* place in the head that
 * knows a WebSocket exists.
 *
 * Two rules the client core relies on and the CLI transport also honours:
 *
 *  - **`open()` constructs a NEW socket every time.** The core owns reconnect (§2.5: 250 ms ×1.8,
 *    cap 30 s, ±25 % jitter) and calls `open()` again on each attempt; a transport that reused a
 *    closed socket would reconnect exactly once, silently, forever after.
 *  - **The token rides in the subprotocol list** (`swarm.v1`, `swarm.tok.<token>`), never a query
 *    parameter (S4).
 *
 * The socket is injected as a factory (`WebSocketFactory`), so `test/swarm-wiring.test.ts` drives
 * open, message, and every close code in §2.5 with no network.
 */

import type { SwarmTransport, Unsubscribe } from '@astrale-os/swarm'

import { SWARM_SUBPROTOCOL, SWARM_TOKEN_SUBPROTOCOL_PREFIX } from '@astrale-os/swarm'

import type { WebSocketFactory, WebSocketLike } from './platform.ts'

export interface SwarmSocketTransportOptions {
  /** `ws://127.0.0.1:7717/swarm` — build it with `swarmSocketUrl(endpoint)`. */
  readonly url: string
  readonly token: string
  readonly factory: WebSocketFactory
}

export function createSocketTransport(options: SwarmSocketTransportOptions): SwarmTransport {
  const openListeners = new Set<() => void>()
  const messageListeners = new Set<(text: string) => void>()
  const closeListeners = new Set<
    (info: { code: number; reason: string; wasClean: boolean }) => void
  >()
  const errorListeners = new Set<(error: unknown) => void>()
  let socket: WebSocketLike | null = null

  const add = <T>(set: Set<T>, listener: T): Unsubscribe => {
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  return {
    open(): void {
      const next = options.factory(options.url, [
        SWARM_SUBPROTOCOL,
        `${SWARM_TOKEN_SUBPROTOCOL_PREFIX}${options.token}`,
      ])
      socket = next
      next.onopen = () => {
        for (const listener of [...openListeners]) listener()
      }
      next.onmessage = (event) => {
        // `swarm.v1` is one JSON object per **text** message (§2.2); a Blob here is a peer that
        // is not speaking this protocol, and dropping it is more honest than a partial decode.
        if (typeof event.data !== 'string') return
        const text = event.data
        for (const listener of [...messageListeners]) listener(text)
      }
      next.onclose = (event) => {
        if (socket === next) socket = null
        for (const listener of [...closeListeners]) {
          listener({ code: event.code, reason: event.reason, wasClean: event.wasClean })
        }
      }
      next.onerror = (error) => {
        for (const listener of [...errorListeners]) listener(error)
      }
    },

    send(text: string): void {
      // A send while disconnected is not an error the head can act on: the core queues intents
      // offline (§6.4–6.6, X12) and re-sends them with their original idempotency key.
      socket?.send(text)
    },

    close(code = 1000, reason = 'head closed'): void {
      const current = socket
      socket = null
      current?.close(code, reason)
    },

    onOpen: (cb) => add(openListeners, cb),
    onMessage: (cb) => add(messageListeners, cb),
    onClose: (cb) => add(closeListeners, cb),
    onError: (cb) => add(errorListeners, cb),
  }
}
