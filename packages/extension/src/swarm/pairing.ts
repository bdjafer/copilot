/**
 * Pairing — `POST /pair` (SPEC-swarm §2.1, PRODUCT S2/S3).
 *
 * `swarm serve` prints an 8-char Crockford-base32 code (TTL 300 s, single use, 5 attempts). The
 * head exchanges it, once, for a long-lived token. Three details are load-bearing and all three
 * are enforced here rather than assumed:
 *
 *  - **`x-swarm-client` is required even though `/pair` is token-exempt.** It is what makes the
 *    request non-simple, which is what stops a random page from form-POSTing a pairing code it
 *    guessed. Sending it is not optional politeness; without it the server answers 403.
 *  - **The code is normalized before it is sent** — dashes stripped, upper-cased — because the
 *    server prints `K7QF-2M9X` and compares against `K7QF2M9X`. Making the human delete the dash
 *    the product printed is a way to spend one of their five attempts.
 *  - **Every failure resolves, none throws.** A wrong code, a dead server and a rate-limited
 *    caller are all things the pairing screen must render as a sentence with a fix; an exception
 *    escaping into a `submit` handler is a screen that does nothing.
 *
 * Pure over `FetchLike`: no `chrome.*`, no DOM, no globals.
 */

import type { FetchLike } from './platform.ts'
import type { SwarmPairing } from './token.ts'

import { normalizeEndpoint } from './token.ts'

export interface PairInput {
  /** What the user typed: `127.0.0.1:7717`, `http://127.0.0.1:7717`, either is accepted. */
  readonly endpoint: string
  /** The code `swarm serve` printed; dashes and case are the user's business, not ours. */
  readonly code: string
  /** Shown in `swarm tokens ls` and in every audit row this head causes (S13). */
  readonly clientName: string
  readonly now?: () => number
}

export type PairResult =
  | { readonly ok: true; readonly pairing: SwarmPairing }
  | {
      readonly ok: false
      /** `bad-code` covers expired and spent codes: the server cannot tell us which, by design. */
      readonly reason: 'bad-code' | 'rate-limited' | 'unreachable' | 'bad-response'
      readonly detail: string
    }

/** `K7QF-2M9X` → `K7QF2M9X`; the server compares against the stripped, upper-cased form. */
export function normalizePairingCode(raw: string): string {
  return raw.replace(/-/g, '').trim().toUpperCase()
}

export async function pairSwarm(fetchLike: FetchLike, input: PairInput): Promise<PairResult> {
  let endpoint: string
  try {
    endpoint = normalizeEndpoint(input.endpoint)
  } catch {
    return { ok: false, reason: 'unreachable', detail: `not a URL: ${input.endpoint}` }
  }

  const code = normalizePairingCode(input.code)
  if (code.length === 0) {
    return { ok: false, reason: 'bad-code', detail: 'enter the code `swarm serve` printed' }
  }

  let response
  try {
    response = await fetchLike(`${endpoint}/pair`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Token-exempt, client-header-required (§2.1). This header IS the CSRF defence.
        'x-swarm-client': input.clientName,
      },
      body: JSON.stringify({ code, clientName: input.clientName, clientKind: 'extension' }),
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: `no swarm server at ${endpoint} (${String(error)}) — run \`swarm serve\``,
    }
  }

  if (!response.ok) {
    const detail = await errorDetail(response.json.bind(response))
    if (response.status === 429) return { ok: false, reason: 'rate-limited', detail }
    if (response.status === 401) return { ok: false, reason: 'bad-code', detail }
    return { ok: false, reason: 'bad-response', detail: `${response.status}: ${detail}` }
  }

  const body = (await response.json().catch(() => null)) as {
    tokenId?: unknown
    token?: unknown
    issuedAt?: unknown
  } | null
  if (
    body === null ||
    typeof body.token !== 'string' ||
    typeof body.tokenId !== 'string' ||
    body.token.length === 0
  ) {
    return { ok: false, reason: 'bad-response', detail: 'pairing response carried no token' }
  }

  return {
    ok: true,
    pairing: {
      endpoint,
      token: body.token,
      tokenId: body.tokenId,
      clientName: input.clientName,
      issuedAt: typeof body.issuedAt === 'number' ? body.issuedAt : (input.now?.() ?? Date.now()),
    },
  }
}

/** The server answers `SwarmError.toJSON()` on refusal; anything else degrades to a status line. */
async function errorDetail(read: () => Promise<unknown>): Promise<string> {
  try {
    const body = (await read()) as { message?: unknown; error?: unknown } | null
    if (body !== null && typeof body.message === 'string') return body.message
    if (body !== null && typeof body.error === 'string') return body.error
  } catch {
    /* A non-JSON body is not more informative than the status we already have. */
  }
  return 'pairing refused'
}
