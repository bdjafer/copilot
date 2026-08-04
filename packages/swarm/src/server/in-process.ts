/**
 * An in-process `SwarmTransport` (SPEC-swarm §6.1 H7, §7.1 `--in-process`).
 *
 * H7 makes the transport injected rather than constructed, and this is the payoff: the identical
 * client code runs over a WebSocket, over an in-process pipe, and over a fake — with the *same*
 * frames, the *same* admission and the *same* `SwarmConnection` on the other side. Nothing is
 * short-circuited: an in-process head still sends `hello`, still subscribes, still acks.
 *
 * §7.1 is explicit that this is **not** enough on its own: "proving H10 only in-process proves
 * that the client core can be called from Node, which was never in doubt; proving it over the
 * wire proves the server is a server". So this exists for tests and for `--in-process`, and the
 * CLI's default path is the real socket.
 *
 * Node ≥ 24, server-only (it holds a `SwarmConnection`).
 */

import type { SwarmTransport, Unsubscribe } from '../types.ts'
import type { SwarmServer } from './server.ts'
import type { TokenRecord } from './tokens.ts'

import { SwarmError } from '../errors.ts'
import { CLOSE_CODES } from '../protocol/constants.ts'
import { SwarmConnection } from './ws.ts'

export interface InProcessTransportOptions {
  readonly server: SwarmServer
  /** The same token a WebSocket head would carry in `swarm.tok.<token>` (§2.1). */
  readonly token: string
  readonly serverVersion?: string
}

/**
 * The connection is admitted exactly as a socket would be — an unknown token still yields
 * **4001** rather than a privileged back door, because a test transport that skips authentication
 * proves nothing about the one that does not.
 */
export function createInProcessTransport(options: InProcessTransportOptions): SwarmTransport {
  const record: TokenRecord | null = options.server.tokens.verify(options.token)
  const openListeners = new Set<() => void>()
  const messageListeners = new Set<(text: string) => void>()
  const closeListeners = new Set<(i: { code: number; reason: string; wasClean: boolean }) => void>()
  const errorListeners = new Set<(e: unknown) => void>()
  let connection: SwarmConnection | null = null

  const add = <T>(set: Set<T>, cb: T): Unsubscribe => {
    set.add(cb)
    return () => {
      set.delete(cb)
    }
  }

  return {
    open(): void {
      if (record === null) {
        for (const cb of closeListeners) {
          cb({ code: CLOSE_CODES.unauthenticated, reason: 'unknown token', wasClean: false })
        }
        for (const cb of errorListeners) cb(new SwarmError('unauthenticated', 'unknown token'))
        return
      }
      connection = new SwarmConnection({
        id: `inproc-${Math.random().toString(36).slice(2, 10)}`,
        socket: {
          send: (text) => {
            for (const cb of [...messageListeners]) cb(text)
          },
          close: (code, reason) => {
            for (const cb of [...closeListeners]) cb({ code, reason, wasClean: true })
          },
          /* An in-process pipe has no kernel buffer, so backpressure is driven entirely by the
           * frame counter — which is the rule §2.4 states first. */
          bufferedAmount: () => 0,
        },
        engine: options.server.engine,
        token: record,
        serverVersion: options.serverVersion ?? '0.1.0',
        autoHeartbeat: false,
      })
      for (const cb of [...openListeners]) cb()
    },
    send(text: string): void {
      void connection?.receive(text)
    },
    close(code = 1_000, reason = 'client closed'): void {
      connection?.close(code, reason)
      connection = null
    },
    onOpen: (cb) => add(openListeners, cb),
    onMessage: (cb) => add(messageListeners, cb),
    onClose: (cb) => add(closeListeners, cb),
    onError: (cb) => add(errorListeners, cb),
  }
}
