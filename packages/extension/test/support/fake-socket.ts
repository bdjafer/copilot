/**
 * A driveable `WebSocketFactory` and a driveable `FetchLike` — the swarm head's half of
 * `fake-chrome.ts`.
 *
 * The head injects both (`src/swarm/platform.ts`), so the whole pairing + connect + reconnect path
 * runs with no network, no timers and no browser: a test opens a socket, answers a `hello`, drives
 * close code 4001, and asserts the token was dropped. That is the §2.5 reconnect contract's one
 * head-visible clause, and it is unassertable against a real socket.
 */

import type {
  FetchLike,
  FetchResponseLike,
  WebSocketFactory,
  WebSocketLike,
} from '../../src/swarm/platform.ts'

export interface FakeSocket extends WebSocketLike {
  readonly url: string
  readonly protocols: readonly string[]
  readonly sent: string[]
  readonly closes: { code?: number; reason?: string }[]
  /** Drive the peer. */
  open(): void
  message(text: string): void
  serverClose(code: number, reason?: string, wasClean?: boolean): void
  fail(error: unknown): void
}

export interface FakeSockets {
  readonly factory: WebSocketFactory
  readonly sockets: FakeSocket[]
  readonly last: () => FakeSocket | undefined
}

export function createFakeSockets(): FakeSockets {
  const sockets: FakeSocket[] = []
  const factory: WebSocketFactory = (url, protocols) => {
    const socket: FakeSocket = {
      url,
      protocols: [...protocols],
      sent: [],
      closes: [],
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send(data) {
        socket.sent.push(data)
      },
      close(code, reason) {
        socket.closes.push({ code, reason })
        socket.onclose?.({ code: code ?? 1000, reason: reason ?? '', wasClean: true })
      },
      open() {
        socket.onopen?.(undefined)
      },
      message(text) {
        socket.onmessage?.({ data: text })
      },
      serverClose(code, reason = '', wasClean = false) {
        socket.onclose?.({ code, reason, wasClean })
      },
      fail(error) {
        socket.onerror?.(error)
      },
    }
    sockets.push(socket)
    return socket
  }
  return { factory, sockets, last: () => sockets[sockets.length - 1] }
}

export interface FakeFetchCall {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: unknown
}

export interface FakeFetch {
  readonly fetch: FetchLike
  readonly calls: FakeFetchCall[]
  /** Queue one reply; a request with none queued throws, which is the "server is down" case. */
  reply(response: Partial<FetchResponseLike> & { body?: unknown }): void
  fail(error: unknown): void
}

export function createFakeFetch(): FakeFetch {
  const calls: FakeFetchCall[] = []
  const queue: Array<
    { kind: 'reply'; response: FetchResponseLike } | { kind: 'fail'; error: unknown }
  > = []

  return {
    calls,
    reply(response) {
      queue.push({
        kind: 'reply',
        response: {
          ok: response.ok ?? true,
          status: response.status ?? 200,
          json: async () => response.body ?? {},
        },
      })
    },
    fail(error) {
      queue.push({ kind: 'fail', error })
    },
    fetch: async (url, init) => {
      calls.push({
        url,
        method: init.method,
        headers: init.headers,
        body: JSON.parse(init.body) as unknown,
      })
      const next = queue.shift()
      if (next === undefined) throw new Error('ECONNREFUSED')
      if (next.kind === 'fail') throw next.error
      return next.response
    },
  }
}
