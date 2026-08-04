/**
 * The `unknown` protocol (SPEC-swarm §5.5), as a pure decision over evidence.
 *
 * The procedure — take the `delegation:*` lease → reattach → `tail(12)` (**`peekSession`, never
 * the other read**, [F8]) → compare against the persisted `promptDigest` → read the workspace
 * revision and `git status --porcelain` against the post-dispatch snapshot → run non-mutating
 * acceptance criteria — is I/O and lives in the engine. **What the evidence means** is a four-row
 * table, and it lives here so it can be asserted without a session, a repo or a clock.
 *
 * The rule that matters most is the one that does nothing: `unknown` **never auto-resends by
 * default** (Q5). `sendMessage` has no idempotency key and `message_accepted` carries only
 * `session_id` — it does not even echo an index — so an ack can never be correlated to a send. A
 * duplicated destructive turn is unrecoverable; a confirmation is annoying.
 *
 * DOM-free and Node-free.
 */

import type { DeliveryState, ReconcileReport } from '../types.ts'

/** The four clauses of §5.5, verbatim — the head renders them as evidence lines (X4). */
export interface ReconcileEvidence {
  readonly ackLogged: boolean
  readonly digestInTail: boolean
  readonly workspaceMutated: boolean
  readonly toolEventsLogged: number
  readonly sessionIdle: boolean
}

export interface ReconcileDecision {
  readonly outcome: ReconcileReport['outcome']
  /** The delivery state the turn moves to; `null` ⇒ it stays where it is. */
  readonly delivery: DeliveryState | null
  /** `true` ⇒ the server resumes observing the session rather than asking anyone anything. */
  readonly resumeObservation: boolean
}

/**
 * §5.5's table, in its own order:
 *
 * | Evidence | Action |
 * |---|---|
 * | digest in tail, **or** workspace mutated after dispatch, **or** any tool event logged | delivery → `running`/`ended`; resume observation automatically |
 * | session observed `streaming` on reattach | resume observation; do not resend |
 * | all four of: no ack logged; digest absent; no workspace mutation; session idle | offer resend, confirmation required unless `autoResendOnStrongEvidence` |
 * | anything else | stay `unknown`; surface the four evidence lines and a Reconcile action |
 *
 * `turnDone` distinguishes the first row's two targets: positive evidence plus an observed
 * `turn_done` is `ended`, positive evidence without one is `running`. Both are V9, which is why
 * V9 is the one multi-target row in the delivery machine.
 */
export function decideReconciliation(
  evidence: ReconcileEvidence,
  options: { readonly autoResendOnStrongEvidence: boolean; readonly turnDoneObserved: boolean },
): ReconcileDecision {
  const positive =
    evidence.digestInTail || evidence.workspaceMutated || evidence.toolEventsLogged > 0
  if (positive) {
    return {
      outcome: options.turnDoneObserved ? 'ended' : 'resumed',
      delivery: options.turnDoneObserved ? 'ended' : 'running',
      resumeObservation: true,
    }
  }
  if (!evidence.sessionIdle) {
    /* The session is still streaming: resume observation, and above all do not resend. */
    return { outcome: 'resumed', delivery: 'running', resumeObservation: true }
  }
  const strong =
    !evidence.ackLogged &&
    !evidence.digestInTail &&
    !evidence.workspaceMutated &&
    evidence.sessionIdle
  if (strong) {
    return {
      outcome: options.autoResendOnStrongEvidence ? 'resent' : 'resend-offered',
      delivery: null,
      resumeObservation: false,
    }
  }
  return { outcome: 'still-unknown', delivery: null, resumeObservation: false }
}

/** A digest match over `peekSession`'s flattened text — the only transcript read swarm makes. */
export function digestPresentInTail(
  tail: readonly { readonly role: string; readonly content: string }[],
  promptText: string,
): boolean {
  const needle = promptText.trim()
  if (needle.length === 0) return false
  return tail.some((entry) => entry.role === 'user' && entry.content.trim() === needle)
}

export function emptyEvidence(): ReconcileEvidence {
  return {
    ackLogged: false,
    digestInTail: false,
    workspaceMutated: false,
    toolEventsLogged: 0,
    sessionIdle: true,
  }
}
