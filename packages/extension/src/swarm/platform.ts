/**
 * The swarm head's view of the platform, declared the same way `src/platform.ts` declares the
 * bridge's: **narrow structural types, injected as parameters, never a global**. `test/dod.test.ts`
 * enforces the rule for every module under `src/`, and it is what lets the whole pairing +
 * reconnect wiring run in vitest with no browser (`test/swarm-wiring.test.ts`).
 *
 * Three surfaces only, because the head needs exactly three things the platform owns: a place to
 * keep the pairing token (`chrome.storage.local`), a way to POST the pairing code
 * (`fetch`, which needs the `http://127.0.0.1/*` host permission to bypass CORS — the swarm
 * server sends no `Access-Control-Allow-Origin`), and a socket constructor.
 *
 * `WebSocketLike` is the DOM `WebSocket` narrowed to what `transport.ts` calls. Injecting the
 * *constructor* rather than importing the global is what makes the reconnect contract (§2.5)
 * assertable: a test drives close code 4001 and observes the head clear its token, with no
 * network and no timers.
 */

/* ------------------------------------------------------------------ storage */

/** The subset of `chrome.storage.StorageArea` the token store touches. */
export interface SwarmStorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string[]): Promise<void>
}

/* -------------------------------------------------------------------- fetch */

export interface FetchResponseLike {
  readonly ok: boolean
  readonly status: number
  json(): Promise<unknown>
}

export interface FetchRequestInit {
  method: string
  headers: Record<string, string>
  body: string
}

export type FetchLike = (url: string, init: FetchRequestInit) => Promise<FetchResponseLike>

/* ---------------------------------------------------------------- websocket */

export interface WebSocketCloseInfo {
  readonly code: number
  readonly reason: string
  readonly wasClean: boolean
}

/**
 * `WebSocket`, minus everything the transport does not use. `binaryType`, `bufferedAmount` and
 * the `EventTarget` half are deliberately absent: `swarm.v1` is one JSON object per text message
 * (§2.2), so a transport that could reach for a binary frame is a transport that could send one.
 */
export interface WebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: WebSocketCloseInfo) => void) | null
  onerror: ((event: unknown) => void) | null
}

/**
 * `new WebSocket(url, protocols)`. The token rides in `protocols` and never in the URL (S4): a
 * query string lands in logs, history and referrers, and a credential in a log is a credential
 * that has been shared.
 */
export type WebSocketFactory = (url: string, protocols: readonly string[]) => WebSocketLike

/* ----------------------------------------------------------------- assembly */

/** Everything the head page hands to `createSwarmHeadSession`. */
export interface SwarmHeadPlatform {
  readonly storage: SwarmStorageArea
  readonly fetch: FetchLike
  readonly webSocket: WebSocketFactory
  /** Injected so a projection pass is a pure function of its inputs (as in the client core). */
  readonly now?: () => number
}
