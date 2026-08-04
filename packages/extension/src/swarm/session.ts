/**
 * The head session — credentials and lifecycle around one `SwarmClient`.
 *
 * ## Ruling: the client core lives in a PAGE, not in the service worker
 *
 * MV3 gives us two places to hold a long-lived socket and only one of them is honest:
 *
 *  - The **service worker** is event-driven and is torn down on idle. WebSocket traffic resets the
 *    30 s timer on current Chrome, but nothing resets it across a browser-managed shutdown, a
 *    profile suspend or a laptop sleep — and swarm's confirmation seam (§6.7) is explicit that
 *    "no head connected ⇒ no confirmation ⇒ no write". A head that can die mid-turn and re-snapshot
 *    on wake is not a head a *human* is watching, which is the entire authority a confirmation
 *    carries. Add the `attempt:*` stream — the highest-volume stream in the protocol (§2.3) — and
 *    the worker would be paying to buffer a transcript nobody is looking at.
 *  - The **swarm page** (`entrypoints/swarm/`) is open exactly while a human is watching the
 *    fleet. Its socket lives as long as the tab, its re-subscribe is the ordinary §2.5 reconnect,
 *    and its rendering needs a DOM anyway.
 *
 * So: the page owns the client; the worker owns nothing swarm-shaped today. The pairing token
 * lives in `chrome.storage.local` rather than page memory precisely so a future badge poller
 * (F11 — `chrome.alarms` wake → re-snapshot `fleet` → rewrite badge) can read it without a second
 * pairing dance. That poller is **not** built here and the head does not pretend it is: with the
 * page closed there is no head, and §6.7's rule is that this is the correct behaviour, not a gap.
 *
 * ## What this module owns
 *
 * Everything about the *credential*: load it, connect with it, and drop it the moment the server
 * says it is no longer valid. Reconnect and resume are the client core's (§2.5: backoff, snapshot
 * or `from:<seq>`, idempotent re-send) — this module never re-implements them. It reacts to
 * exactly one connection outcome, the terminal `unauthenticated` close (4001), because that is the
 * one a reconnect can never fix and the one whose remedy is a human with a fresh pairing code.
 *
 * Pure over `SwarmHeadPlatform`: no `chrome.*`, no `wxt/*`, no DOM.
 */

import type {
  ConfirmationRequest,
  ReadableStore,
  SwarmClient,
  SwarmError,
  Unsubscribe,
} from '@astrale-os/swarm'

import { createSwarmClient, readonlyStore, writable } from '@astrale-os/swarm'

import type { PairResult, PairInput } from './pairing.ts'
import type { SwarmHeadPlatform } from './platform.ts'
import type { SwarmPairing } from './token.ts'

import { pairSwarm } from './pairing.ts'
import { createSwarmTokenStore, swarmSocketUrl } from './token.ts'
import { createSocketTransport } from './transport.ts'

/**
 * Head-level phases, distinct from `ConnectionVM.status` on purpose: the socket's state machine
 * answers "is the wire up", this one answers "may we even try". A revoked token is `unpaired`
 * here and `blocked` there, and the screen that must be rendered is the pairing screen.
 */
export type SwarmHeadPhase = 'loading' | 'unpaired' | 'pairing' | 'live'

export interface SwarmHeadState {
  readonly phase: SwarmHeadPhase
  readonly endpoint: string
  readonly clientName: string
  readonly tokenId: string | null
  /** Last pairing failure, or the reason the previous token was dropped. Rendered verbatim. */
  readonly error: string | null
}

export interface SwarmHeadSession {
  readonly state: ReadableStore<SwarmHeadState>
  /** `null` until a token exists; replaced (never mutated) when pairing succeeds. */
  readonly client: ReadableStore<SwarmClient | null>
  /**
   * Pending copilot write-tool confirmations (§6.7). They arrive as events, not as a store — the
   * client core exposes `on('confirmation')` and no `confirmations: ReadableStore` — so the head
   * keeps the list itself, drops entries on `confirm`/`deny`, and expires them at `expiresAt`
   * exactly as the server will. (Head deviation E2.)
   */
  readonly confirmations: ReadableStore<readonly ConfirmationRequest[]>
  /** Reads the stored token and connects. Idempotent; safe to call on every page load. */
  start(): Promise<void>
  pair(input: Omit<PairInput, 'now'>): Promise<PairResult>
  /** Revokes locally: drops the token, tears down the client, returns to the pairing screen. */
  unpair(): Promise<void>
  destroy(): void
}

export interface SwarmHeadSessionOptions extends SwarmHeadPlatform {
  /** Shown in `swarm tokens ls` and stamped on every audit row this head causes (S13). */
  readonly clientName?: string
  /** Prefilled on the pairing screen; the default is the spec's default port (§2.1). */
  readonly defaultEndpoint?: string
  readonly onError?: (error: SwarmError) => void
}

const DEFAULT_ENDPOINT = 'http://127.0.0.1:7717'

export function createSwarmHeadSession(options: SwarmHeadSessionOptions): SwarmHeadSession {
  const now = options.now ?? Date.now
  const clientName = options.clientName ?? 'exp-spec extension'
  const tokens = createSwarmTokenStore(options.storage)

  const state = writable<SwarmHeadState>({
    phase: 'loading',
    endpoint: options.defaultEndpoint ?? DEFAULT_ENDPOINT,
    clientName,
    tokenId: null,
    error: null,
  })
  const clientStore = writable<SwarmClient | null>(null)
  const confirmations = writable<readonly ConfirmationRequest[]>([])

  let live: { client: SwarmClient; unsubscribes: Unsubscribe[] } | null = null
  let destroyed = false

  const teardown = (): void => {
    if (live === null) return
    for (const unsubscribe of live.unsubscribes) unsubscribe()
    live.client.destroy()
    live = null
    clientStore.set(null)
    confirmations.set([])
  }

  /** §6.7: a request the server will auto-deny at `expiresAt` must not linger on the screen. */
  const pruneConfirmations = (): void => {
    const at = now()
    const kept = confirmations.get().filter((request) => request.expiresAt > at)
    if (kept.length !== confirmations.get().length) confirmations.set(kept)
  }

  const connect = (pairing: SwarmPairing): void => {
    teardown()
    const client = createSwarmClient({
      transport: createSocketTransport({
        url: swarmSocketUrl(pairing.endpoint),
        token: pairing.token,
        factory: options.webSocket,
      }),
      clientName: pairing.clientName,
      head: 'extension',
      now,
      onError: options.onError,
    })

    const unsubscribes: Unsubscribe[] = [
      client.on('confirmation', (request) => {
        pruneConfirmations()
        confirmations.set([
          ...confirmations.get().filter((held) => held.requestId !== request.requestId),
          request,
        ])
      }),
      client.connection.subscribe((connection) => {
        pruneConfirmations()
        // The ONE outcome a reconnect can never fix (§2.5 rule 4). `forbidden` and `protocol` are
        // terminal too, but they are wiring faults (an origin the server does not allow, a peer
        // that is not swarm) whose remedy is a fixed server, not a fresh token — dropping a valid
        // credential because a dev server was misconfigured would cost the user a re-pair for
        // nothing.
        if (connection.blockedReason !== 'unauthenticated') return
        void dropToken('this head was unpaired by the server — pair again with a fresh code')
      }),
    ]

    live = { client, unsubscribes }
    clientStore.set(client)
    state.set({
      phase: 'live',
      endpoint: pairing.endpoint,
      clientName: pairing.clientName,
      tokenId: pairing.tokenId,
      error: null,
    })
  }

  const dropToken = async (reason: string): Promise<void> => {
    teardown()
    await tokens.clear()
    if (destroyed) return
    const current = state.get()
    state.set({
      phase: 'unpaired',
      endpoint: current.endpoint,
      clientName,
      tokenId: null,
      error: reason,
    })
  }

  return {
    state: readonlyStore(state),
    client: readonlyStore(clientStore),
    confirmations: readonlyStore(confirmations),

    async start() {
      if (destroyed) return
      const pairing = await tokens.read()
      if (destroyed) return
      if (pairing === null) {
        state.set({ ...state.get(), phase: 'unpaired', tokenId: null })
        return
      }
      connect(pairing)
    },

    async pair(input) {
      state.set({ ...state.get(), phase: 'pairing', error: null })
      const result = await pairSwarm(options.fetch, { ...input, now })
      if (destroyed) return result
      if (!result.ok) {
        state.set({ ...state.get(), phase: 'unpaired', error: result.detail })
        return result
      }
      await tokens.write(result.pairing)
      if (destroyed) return result
      connect(result.pairing)
      return result
    },

    async unpair() {
      await dropToken('unpaired on this device')
    },

    destroy() {
      destroyed = true
      teardown()
    },
  }
}
