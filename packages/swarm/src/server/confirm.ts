/**
 * The copilot confirmation seam (SPEC-swarm §6.7, Q8, #39).
 *
 * Q8 mandates read-only tools unasked and **per-call user confirmation** for the write tools. The
 * mandate needs a frame that can carry a confirmation to a human, and this is the registry behind
 * it: a pending request, a TTL, and two resolutions.
 *
 * The consequence worth stating out loud, because it is the point rather than a side effect:
 * **no head connected ⇒ no confirmation ⇒ no write.** The copilot cannot act while nobody is
 * watching. And `swarm.complete`, `swarm.verify`, `swarm.land` and `swarm.retry` do not exist and
 * MUST NOT be added — a verdict a conversation can write is not a verdict.
 *
 * DOM-free and Node-free.
 */

import type { ConfirmationRequest } from '../types.ts'

import { DEFAULT_TIMEOUTS } from '../domain/constants.ts'
import { SwarmError } from '../errors.ts'

/** The three write tools of §6.7, and only these three. */
export const COPILOT_WRITE_TOOLS = ['swarm.start', 'swarm.followUp', 'swarm.cancel'] as const
/** The three read tools — no authority, no confirmation, no ceremony. */
export const COPILOT_READ_TOOLS = ['swarm.list', 'swarm.inspect', 'swarm.wait'] as const

export interface PendingConfirmation {
  readonly request: ConfirmationRequest
  readonly resolve: (decision: 'confirm' | 'deny', by: string, reason?: string) => void
}

export type ConfirmationDecision =
  | { readonly decision: 'confirm'; readonly confirmedBy: string }
  | { readonly decision: 'deny'; readonly reason: string | null }

export interface ConfirmationRegistryOptions {
  readonly now?: () => number
  readonly ttlMs?: number
  /** Called for `server.confirmation` / `server.confirmation_resolved` (§6.4). */
  readonly onRequest?: (request: ConfirmationRequest) => void
  readonly onResolved?: (requestId: string, decision: 'confirm' | 'deny') => void
}

export class ConfirmationRegistry {
  private readonly pending = new Map<string, PendingConfirmation>()
  private readonly now: () => number
  private readonly ttlMs: number

  constructor(private readonly options: ConfirmationRegistryOptions = {}) {
    this.now = options.now ?? Date.now
    this.ttlMs = options.ttlMs ?? DEFAULT_TIMEOUTS.confirmationTtlMs
  }

  list(): readonly ConfirmationRequest[] {
    this.expire()
    return [...this.pending.values()].map((entry) => entry.request)
  }

  /** Register a request and return the promise the tool call awaits. */
  request(request: Omit<ConfirmationRequest, 'at' | 'expiresAt'>): {
    readonly request: ConfirmationRequest
    readonly decided: Promise<ConfirmationDecision>
  } {
    const at = this.now()
    const full: ConfirmationRequest = { ...request, at, expiresAt: at + this.ttlMs }
    let settle!: (decision: 'confirm' | 'deny', by: string, reason?: string) => void
    const decided = new Promise<ConfirmationDecision>((resolve) => {
      settle = (decision, by, reason) => {
        this.pending.delete(full.requestId)
        this.options.onResolved?.(full.requestId, decision)
        resolve(
          decision === 'confirm'
            ? { decision: 'confirm', confirmedBy: by }
            : { decision: 'deny', reason: reason ?? null },
        )
      }
    })
    this.pending.set(full.requestId, { request: full, resolve: settle })
    this.options.onRequest?.(full)
    return { request: full, decided }
  }

  confirm(requestId: string, confirmedBy: string): void {
    const entry = this.take(requestId)
    entry.resolve('confirm', confirmedBy)
  }

  deny(requestId: string, reason?: string): void {
    const entry = this.take(requestId)
    entry.resolve('deny', '', reason)
  }

  private take(requestId: string): PendingConfirmation {
    this.expire()
    const entry = this.pending.get(requestId)
    if (entry === undefined) {
      throw new SwarmError('confirmation_expired', `no pending confirmation ${requestId}`)
    }
    return entry
  }

  /** Unanswered requests expire after `confirmationTtlMs` and are **denied** automatically. */
  expire(): void {
    const at = this.now()
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.request.expiresAt <= at) entry.resolve('deny', '', 'expired')
      void id
    }
  }
}
