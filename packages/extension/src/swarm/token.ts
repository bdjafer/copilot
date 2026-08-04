/**
 * The paired-token store (SPEC-swarm §2.1, PRODUCT S2/S4/S5).
 *
 * One record under one key in `chrome.storage.local`. It is written once at pairing, read on every
 * head start, and **deleted the moment the server says the token is no longer valid** — close code
 * 4001 (`blockedReason: 'unauthenticated'`), which §2.5 makes terminal precisely so a revoked head
 * stops hammering the socket and asks a human for a new code instead.
 *
 * Why `storage.local` and not `session`: the token is the head's long-lived credential (§2.1 —
 * "tokens never expire; they are revoked"), and a head that must be re-paired on every browser
 * restart is a head nobody keeps paired. Why not `sync`: it would replicate a loopback credential
 * to every machine on the profile, where the server it names does not exist.
 *
 * Pure over `SwarmStorageArea`; no `chrome.*`, no DOM.
 */

import type { SwarmStorageArea } from './platform.ts'

/** Namespaced with the same `exp-spec:` prefix as `src/keys.ts` so one area stays legible. */
export const SWARM_TOKEN_KEY = 'exp-spec:swarm:pairing'

/**
 * What pairing produced, plus where it points. The endpoint is part of the record because the
 * token is only meaningful against the server that issued it: re-pointing the head at another
 * port with the old token is an `unauthenticated` close and a confusing one.
 */
export interface SwarmPairing {
  /** `http://127.0.0.1:7717` — origin only, no path, no trailing slash. */
  readonly endpoint: string
  /** 32 random bytes base64url; only `sha256(token)` is stored server-side (§2.1). */
  readonly token: string
  readonly tokenId: string
  readonly clientName: string
  readonly issuedAt: number
}

function isPairing(value: unknown): value is SwarmPairing {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.endpoint === 'string' &&
    typeof record.token === 'string' &&
    typeof record.tokenId === 'string' &&
    typeof record.clientName === 'string' &&
    typeof record.issuedAt === 'number'
  )
}

export interface SwarmTokenStore {
  read(): Promise<SwarmPairing | null>
  write(pairing: SwarmPairing): Promise<void>
  clear(): Promise<void>
}

export function createSwarmTokenStore(storage: SwarmStorageArea): SwarmTokenStore {
  return {
    async read() {
      const raw = (await storage.get([SWARM_TOKEN_KEY]))[SWARM_TOKEN_KEY]
      // Total, like `normalizeSettings`: a malformed record is an unpaired head, never a throw
      // on the page's first frame. The recovery is the same either way — pair again.
      return isPairing(raw) ? raw : null
    },
    async write(pairing) {
      await storage.set({ [SWARM_TOKEN_KEY]: pairing })
    },
    async clear() {
      await storage.remove([SWARM_TOKEN_KEY])
    },
  }
}

/**
 * `http://127.0.0.1:7717` → `ws://127.0.0.1:7717/swarm` (§2.1).
 *
 * The path is fixed by the protocol and the scheme is derived rather than configured, so a head
 * cannot be pointed at `wss://` on a loopback server that speaks plain HTTP — an error whose only
 * symptom is a socket that never opens.
 */
export function swarmSocketUrl(endpoint: string): string {
  const url = new URL(endpoint)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/swarm'
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** Normalize what a human typed into an origin: trailing slashes and paths are dropped. */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim()
  const withScheme = /^[a-z]+:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  const url = new URL(withScheme)
  return url.origin
}
