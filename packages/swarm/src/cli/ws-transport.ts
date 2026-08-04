/**
 * A `SwarmTransport` over a real WebSocket (SPEC-swarm §2.1, §6.1 H7, §7.1, R13).
 *
 * The token rides in the **subprotocol list**, never a query parameter (S4): query strings land in
 * server logs, browser history and referrers, and a credential that ends up in a log is a
 * credential that has been shared.
 *
 * Node ≥ 24, CLI-only.
 */

import { WebSocket } from 'ws'

import type { SwarmTransport, Unsubscribe } from '../types.ts'

import { SWARM_SUBPROTOCOL, SWARM_TOKEN_SUBPROTOCOL_PREFIX } from '../protocol/frames.ts'

export interface WebSocketTransportOptions {
  readonly url: string
  readonly token: string
  /** Sent so the server's `Host` check has a literal loopback authority to match (§2.1). */
  readonly host?: string
}

export function webSocketTransport(options: WebSocketTransportOptions): SwarmTransport {
  const openListeners = new Set<() => void>()
  const messageListeners = new Set<(text: string) => void>()
  const closeListeners = new Set<(i: { code: number; reason: string; wasClean: boolean }) => void>()
  const errorListeners = new Set<(e: unknown) => void>()
  let socket: WebSocket | null = null

  const add = <T>(set: Set<T>, cb: T): Unsubscribe => {
    set.add(cb)
    return () => {
      set.delete(cb)
    }
  }

  return {
    open(): void {
      socket = new WebSocket(options.url, [
        SWARM_SUBPROTOCOL,
        `${SWARM_TOKEN_SUBPROTOCOL_PREFIX}${options.token}`,
      ])
      socket.on('open', () => {
        for (const cb of [...openListeners]) cb()
      })
      socket.on('message', (data: Buffer | string) => {
        const text = typeof data === 'string' ? data : data.toString('utf8')
        for (const cb of [...messageListeners]) cb(text)
      })
      socket.on('close', (code: number, reason: Buffer) => {
        for (const cb of [...closeListeners]) {
          cb({ code, reason: reason.toString('utf8'), wasClean: code === 1_000 })
        }
      })
      socket.on('error', (error: unknown) => {
        for (const cb of [...errorListeners]) cb(error)
      })
    },
    send(text: string): void {
      socket?.send(text)
    },
    close(code = 1_000, reason = 'client closed'): void {
      socket?.close(code, reason)
      socket = null
    },
    onOpen: (cb) => add(openListeners, cb),
    onMessage: (cb) => add(messageListeners, cb),
    onClose: (cb) => add(closeListeners, cb),
    onError: (cb) => add(errorListeners, cb),
  }
}
