/**
 * Pairing, tokens and the local CLI trust file (SPEC-swarm §2.1, S4, S5, R13).
 *
 * Three rules are structural here rather than documented:
 *
 *  - **only `sha256(token)` is stored** (S5). `tokens.json` never contains a usable credential, so
 *    reading it grants nothing; a token is shown once, at issue.
 *  - **tokens never expire, they are revoked** (S5). There is no `expiresAt` on the record, which
 *    is what stops a "temporarily broken head" from being indistinguishable from a revoked one.
 *  - **`cli-token` is filesystem-authenticated** (H10, R13). A fresh token is written 0600 on every
 *    start and deleted on clean shutdown; a process that can read a 0600 file in the user's home
 *    can already run `jcode` directly, so ownership *is* the authentication.
 *
 * Node ≥ 24, server-only.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { HeadKind } from '../protocol/frames.ts'

import { SERVER_POLICY } from '../domain/constants.ts'
import { SwarmError } from '../errors.ts'

/** The fixed `tokenId` of the local CLI credential (§2.1) — one row, rewritten on every start. */
export const CLI_TOKEN_ID = 'local-cli'

export interface TokenRecord {
  readonly tokenId: string
  /** sha256 hex of the token. The token itself is never written anywhere (S5). */
  readonly hash: string
  readonly clientName: string
  readonly clientKind: HeadKind
  readonly issuedAt: number
  readonly revokedAt: number | null
}

export interface IssuedToken {
  readonly tokenId: string
  /** Shown exactly once, at issue. */
  readonly token: string
  readonly issuedAt: number
}

export interface PairingCode {
  readonly code: string
  readonly expiresAt: number
  readonly attemptsLeft: number
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Crockford base32, 8 characters — no `I`, `L`, `O` or `U`, so a read-aloud code cannot collide. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function generatePairingCode(random: (n: number) => Uint8Array = randomBytes): string {
  const bytes = random(8)
  let out = ''
  for (let i = 0; i < 8; i++) out += CROCKFORD[bytes[i]! % CROCKFORD.length]
  return out
}

/** §2.1: 32 random bytes, base64url. */
export function generateToken(random: (n: number) => Uint8Array = randomBytes): string {
  return Buffer.from(random(32)).toString('base64url')
}

/** Constant-time comparison of two hex digests — a token check must not leak its prefix. */
function digestsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export interface TokenStoreOptions {
  readonly path: string
  readonly now?: () => number
  readonly random?: (n: number) => Uint8Array
  /** 20 pairing attempts per minute per connection (§2.1). */
  readonly pairRatePerMinute?: number
}

export interface PairRequest {
  readonly code: string
  readonly clientName: string
  readonly clientKind: HeadKind
  /** Opaque per-connection identity for the rate limiter — a socket id, never a user id. */
  readonly connectionId: string
}

/**
 * The whole of §2.1's credential surface. It owns a file, a code and a rate limiter and nothing
 * else: admission (`Origin`, `Host`, subprotocols) belongs to the HTTP/WS layer, which calls
 * `verify()` and gets a `TokenRecord` or `null`.
 */
export class TokenStore {
  private records = new Map<string, TokenRecord>()
  private pending: PairingCode | null = null
  private readonly rate = new Map<string, { windowStart: number; count: number }>()
  private readonly now: () => number
  private readonly random: (n: number) => Uint8Array
  private readonly ratePerMinute: number

  constructor(private readonly options: TokenStoreOptions) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? randomBytes
    this.ratePerMinute = options.pairRatePerMinute ?? 20
    this.load()
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.options.path, 'utf8')) as {
        tokens?: readonly TokenRecord[]
      }
      for (const record of raw.tokens ?? []) this.records.set(record.tokenId, record)
    } catch {
      /* A missing or unreadable token file is an empty one; pairing recreates it. */
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 })
    writeFileSync(
      this.options.path,
      `${JSON.stringify({ tokens: [...this.records.values()] }, null, 2)}\n`,
      { mode: 0o600 },
    )
    /* `writeFileSync`'s `mode` applies at **creation** only: on a file that already exists it is a
     * no-op, so a `tokens.json` that was ever world-readable stayed world-readable for the rest of
     * its life. §2.1 says 0600, and 0600 is what the file must actually be. */
    chmodSync(this.options.path, 0o600)
  }

  list(): readonly TokenRecord[] {
    return [...this.records.values()]
  }

  /** Print-once pairing code: TTL 300 s, single use, 5 attempts (§2.1). */
  issuePairingCode(): PairingCode {
    const code: PairingCode = {
      code: generatePairingCode(this.random),
      expiresAt: this.now() + SERVER_POLICY.pairingCodeTtlMs,
      attemptsLeft: SERVER_POLICY.pairingCodeAttempts,
    }
    this.pending = code
    return code
  }

  currentPairingCode(): PairingCode | null {
    if (this.pending === null) return null
    return this.pending.expiresAt > this.now() ? this.pending : null
  }

  /**
   * `POST /pair`. Token-exempt by construction (§2.1): requiring the output as input makes
   * pairing impossible. Every other gate — `x-swarm-client`, a permitted `Origin`, a literal-IP
   * `Host`, the one-time code, and this rate limiter — still applies.
   */
  pair(request: PairRequest): IssuedToken {
    this.checkRate(request.connectionId)
    const pending = this.pending
    if (pending === null || pending.expiresAt <= this.now()) {
      throw new SwarmError('unauthenticated', 'no pairing code is active; run `swarm pair`')
    }
    if (pending.attemptsLeft <= 0) {
      this.pending = null
      throw new SwarmError('rate_limited', 'pairing code is out of attempts')
    }
    const normalized = request.code.replace(/-/g, '').trim().toUpperCase()
    if (normalized !== pending.code) {
      this.pending = { ...pending, attemptsLeft: pending.attemptsLeft - 1 }
      throw new SwarmError('unauthenticated', 'pairing code does not match')
    }
    /* Single use: the code is spent whether or not the caller keeps the token. */
    this.pending = null
    return this.issueToken(request.clientName, request.clientKind)
  }

  private checkRate(connectionId: string): void {
    const at = this.now()
    const entry = this.rate.get(connectionId)
    if (entry === undefined || at - entry.windowStart >= 60_000) {
      this.rate.set(connectionId, { windowStart: at, count: 1 })
      return
    }
    entry.count += 1
    if (entry.count > this.ratePerMinute) {
      throw new SwarmError('rate_limited', `more than ${this.ratePerMinute} pair attempts a minute`)
    }
  }

  issueToken(clientName: string, clientKind: HeadKind, tokenId?: string): IssuedToken {
    const token = generateToken(this.random)
    const issuedAt = this.now()
    const id = tokenId ?? `tok_${Buffer.from(this.random(9)).toString('base64url')}`
    this.records.set(id, {
      tokenId: id,
      hash: sha256Hex(token),
      clientName,
      clientKind,
      issuedAt,
      revokedAt: null,
    })
    this.persist()
    return { tokenId: id, token, issuedAt }
  }

  /** `DELETE /pair/:tokenId`. Tokens never expire; they are revoked (S5). */
  revoke(tokenId: string): boolean {
    const record = this.records.get(tokenId)
    if (record === undefined || record.revokedAt !== null) return false
    this.records.set(tokenId, { ...record, revokedAt: this.now() })
    this.persist()
    return true
  }

  /** `null` for an unknown or revoked token — the caller closes **4001**, never 4003. */
  verify(token: string): TokenRecord | null {
    const hash = sha256Hex(token)
    for (const record of this.records.values()) {
      if (record.revokedAt === null && digestsMatch(record.hash, hash)) return record
    }
    return null
  }

  /**
   * H10: a fresh CLI token on every start, 0600, deleted on clean shutdown. `--token` overrides
   * the file; a missing file yields `unauthenticated` with the fix `swarm serve` or `swarm pair`.
   */
  writeCliToken(path: string): IssuedToken {
    const issued = this.issueToken('swarm cli', 'cli', CLI_TOKEN_ID)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, issued.token, { mode: 0o600 })
    chmodSync(path, 0o600)
    return issued
  }

  static readCliToken(path: string): string {
    try {
      const token = readFileSync(path, 'utf8').trim()
      if (token.length > 0) return token
    } catch {
      /* fall through to the actionable refusal below */
    }
    throw new SwarmError(
      'unauthenticated',
      `no cli token at ${path} — run \`swarm serve\` (or \`swarm pair\` for another head)`,
    )
  }

  static removeCliToken(path: string): void {
    rmSync(path, { force: true })
  }
}
