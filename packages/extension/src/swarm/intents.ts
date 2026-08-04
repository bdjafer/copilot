/**
 * `SwarmHeadIntents` over one `SwarmClient` — the head's entire write surface.
 *
 * Every method here is a **translation**, never a decision: it shapes what the user did into the
 * intent the core already declares (§6.3) and hands back the core's refusal verbatim. The head
 * decides nothing about admission, budgets, verdicts or conflicts (H8), and it never resolves a
 * version conflict itself (X11) — `expectedVersion` is the core's business and a refusal is a
 * sentence on the screen.
 *
 * The seam's contract is that intents are **void, never throw, and are documented no-ops against
 * stale state** (§6.8). That is honoured literally: every call is fire-and-forget, every
 * `IntentResult{ok:false}` becomes a local notice with the error's own message, and a call made
 * while no client exists is dropped. A renderer therefore needs no promises and no `try`/`catch`,
 * which is exactly why the seam is shaped this way.
 *
 * Two product rules are enforced here rather than in the UI, because a UI can be rebuilt and a
 * rule must not be:
 *
 *  - **Banned efforts never leave the head.** `swarm` / `swarm-deep` mean "use jcode's internal
 *    swarm tool" and the executor happily accepts them (§5.1). `normalizeEffort` throws on them by
 *    design; that throw becomes a refusal notice here — the head is the fourth of the four layers
 *    §13 names, and the cheapest one.
 *  - **A structured demand discloses its cost before it is sent** (T3). `runStructured` burns
 *    corrective retries; the notice says so at send time, not in a tooltip nobody opens.
 */

import type {
  AcceptanceCriterion,
  CreateDelegationInput,
  IntentResult,
  ReasoningEffort,
  SwarmClient,
  TranscriptHandle,
  TurnDeliveryMode,
  TurnDirective,
} from '@astrale-os/swarm'
import type { SwarmNoticeVM } from '@astrale-os/swarm/presentation'

import { normalizeEffort, SwarmError } from '@astrale-os/swarm'

import type { HeadCreateInput, HeadTurnInput, SwarmHeadIntents } from './types.ts'

/**
 * T3's schema. One shape, declared here, so the toggle is a toggle and not a JSON editor: the
 * demand a follow-up makes is "answer with a report I can read as data", and the retry budget is
 * the SDK's default (§4.1 `DEFAULT_STRUCTURED_MAX_RETRIES`).
 */
export const STRUCTURED_REPORT_SCHEMA = {
  type: 'object',
  required: ['summary', 'changes', 'risks'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    changes: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
} as const

export interface HeadIntentDeps {
  /** `null` while unpaired or between clients; every intent is then a documented no-op. */
  client(): SwarmClient | null
  /** The live transcript handle, for `followTranscript` / `loadOlder`. */
  transcript(): TranscriptHandle | null
  raise(notice: Omit<SwarmNoticeVM, 'id' | 'dismissible'> & { dismissible?: boolean }): void
  dismiss(noticeId: string): void
  setFollowing(on: boolean): void
  now(): number
  /** Idempotency keys (C11, T13): client-generated, stable across an offline flush. */
  key(): string
}

export function createHeadIntents(deps: HeadIntentDeps): SwarmHeadIntents {
  const settle = <T>(label: string, run: Promise<IntentResult<T>> | undefined): void => {
    if (run === undefined) return
    void run.then(
      (result) => {
        if (result.ok) return
        deps.raise({
          kind: 'intent-refused',
          severity: 'warn',
          title: `${label} refused`,
          detail: `${result.error.code}: ${result.error.message}`,
        })
      },
      (error: unknown) => {
        deps.raise({
          kind: 'intent-failed',
          severity: 'error',
          title: `${label} failed`,
          detail: String(error),
        })
      },
    )
  }

  const withClient = <T>(run: (client: SwarmClient) => T): T | undefined => {
    const client = deps.client()
    if (client === null) return undefined
    return run(client)
  }

  const effort = (raw: string | null | undefined): ReasoningEffort | null | undefined => {
    if (raw === undefined) return undefined
    if (raw === null || raw === '') return null
    try {
      return normalizeEffort(raw)
    } catch (error) {
      deps.raise({
        kind: 'banned-effort',
        severity: 'warn',
        title: 'effort refused',
        detail: SwarmError.is(error) ? error.message : String(error),
      })
      return undefined
    }
  }

  /**
   * Declared before the object literal so `send` can call it without `this`: the seam hands these
   * methods around individually (a renderer keeps `intents.send` in a listener), and a method that
   * needs its receiver is a method that breaks the first time it is destructured.
   */
  const sendTurn = (delegationId: string, input: HeadTurnInput): void => {
    if (input.text.trim().length === 0) return
    const reasoning = effort(input.reasoningEffort)
    if (reasoning === undefined && input.reasoningEffort !== undefined) return

    /* Every optional field is **omitted**, never set to `undefined`. The two are the same value to
     * `validateTurnDirective` and the same bytes on the wire, but not to a reader: a turn record
     * carrying `model: undefined` reads as "a model was named and lost", and §4.3.10's refusal of
     * the *field* is only legible if an unset field is absent. */
    const directive: TurnDirective = {
      text: input.text,
      ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
      ...(input.delivery === undefined ? {} : { delivery: input.delivery as TurnDeliveryMode }),
      ...(input.model === undefined ? {} : { model: input.model }),
      // Q4: omission reconciles to the DELEGATION default, never to the previous turn.
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: reasoning ?? null }),
      ...(input.structured === true
        ? { structured: { schema: STRUCTURED_REPORT_SCHEMA, maxRetries: 2 } }
        : {}),
      ...(input.budget === undefined ? {} : { budget: input.budget }),
      idempotencyKey: deps.key(),
    }
    if (input.structured === true) {
      deps.raise({
        kind: 'structured-cost',
        severity: 'info',
        title: 'structured answer demanded',
        detail: 'schema validation may burn up to 2 corrective turns against this budget.',
      })
    }
    settle(
      'send',
      withClient((client) => client.sendTurn(delegationId, directive)),
    )
  }

  return {
    /* ------------------------------------------------------------- selection */

    focus(delegationId) {
      withClient((client) => {
        client.focus(delegationId)
      })
    },

    selectAttempt(delegationId, attemptId) {
      withClient((client) => {
        client.focus(delegationId, attemptId)
      })
    },

    setFilter(filter) {
      withClient((client) => {
        client.setFilter({
          buckets: filter.buckets as never,
          text: filter.text,
          sort: filter.sort as never,
        })
      })
    },

    followTranscript(on) {
      deps.setFollowing(on)
      deps.transcript()?.follow(on)
    },

    loadOlder() {
      const handle = deps.transcript()
      if (handle === null) return
      void handle.loadOlder(50).catch(() => {
        /* Older entries beyond the retention floor are a lag, not a failure (§2.3). */
      })
    },

    /* ---------------------------------------------------------------- create */

    create(input) {
      const reasoning = effort(input.reasoningEffort)
      if (reasoning === undefined && input.reasoningEffort !== undefined) return
      const created: CreateDelegationInput = {
        idempotencyKey: deps.key(),
        title: input.title === undefined || input.title.length === 0 ? undefined : input.title,
        spec: {
          specVersion: 1,
          objective: input.objective,
          acceptance: input.acceptance.map(toCriterion),
          workspace: {
            workspaceId: input.workspaceId,
            // A revision EXPRESSION; the server resolves it to a 40-char sha inside the create
            // transaction (C4b) and stores only the sha. The head never resolves a ref.
            baseRef: input.baseRef.length === 0 ? 'HEAD' : input.baseRef,
            writeMode: input.writeMode,
          },
          model: {
            provider: input.provider,
            model: input.model,
            reasoningEffort: reasoning ?? null,
          },
          budget: {
            maxWallMs: input.budget.maxWallMs,
            maxTurns: input.budget.maxTurns,
            maxToolCalls: input.budget.maxToolCalls,
            maxInputTokens: 0,
            maxOutputTokens: 0,
            maxSpendUsd: input.budget.maxSpendUsd,
            // Never `kill` (Q11): a hard breach pauses dispatch, it never cancels a running turn.
            onBreach: 'pause-dispatch',
          },
          execution: { nativeSwarm: false, jcodeMemory: false, autoPoke: true, skills: [] },
          context: [],
          delivery: { mode: input.delivery as TurnDeliveryMode, notify: 'notify' },
          parallelAttempts: input.parallelAttempts,
        },
      }
      settle(
        'create',
        withClient((client) => client.createDelegation(created)),
      )
    },

    /* ------------------------------------------------------------------ turn */

    send(delegationId, text, opts) {
      sendTurn(delegationId, {
        text,
        attemptId: opts?.attemptId,
        delivery: opts?.delivery,
        model: opts?.model,
        reasoningEffort: opts?.reasoningEffort,
      })
    },

    sendTurn,

    retract(turnId) {
      settle(
        'retract',
        withClient((client) =>
          client.retract(turnId).then((result) => {
            // §4.3.9: `cancelSoftInterrupts` is session-wide, so retracting one pending interrupt
            // retracts every pending interrupt on that session. Silently un-delivering messages
            // whose records still read "sent" is forbidden — so we say what went with it.
            if (result.ok && result.value.sessionWide && result.value.alsoRetracted.length > 0) {
              deps.raise({
                kind: 'retract-cascade',
                severity: 'warn',
                title: 'retract was session-wide',
                detail: `${result.value.alsoRetracted.length + 1} pending messages returned to prepared — the executor has no per-message retract.`,
              })
            }
            return result
          }),
        ),
      )
    },

    /* -------------------------------------------------------------- controls */

    cancel(delegationId, scope) {
      settle(
        'cancel',
        withClient((client) => client.cancel(delegationId, { scope })),
      )
    },

    retry(delegationId, parallel) {
      settle(
        'retry',
        withClient((client) => client.retry(delegationId, { parallel, injectPriorFailure: true })),
      )
    },

    verify(delegationId, attemptId) {
      settle(
        'verify',
        withClient((client) => client.verify(delegationId, { attemptId })),
      )
    },

    accept(delegationId, note) {
      // §4.3 rule 3: a zero-criteria delegation reaches `succeeded/accepted` ONLY through a human
      // verdict carrying an actor and a timestamp. The note is that verdict's body.
      settle(
        'accept',
        withClient((client) => client.accept(delegationId, { note })),
      )
    },

    land(delegationId, attemptId, mode) {
      settle(
        'land',
        withClient((client) => client.land(delegationId, { attemptId, mode })),
      )
    },

    branch(attemptId) {
      settle(
        'branch',
        withClient((client) => client.branch(attemptId)),
      )
    },

    discard(attemptId) {
      settle(
        'discard',
        withClient((client) => client.discard(attemptId)),
      )
    },

    archive(delegationId, abandon) {
      settle(
        'archive',
        withClient((client) => client.archive(delegationId, { abandon })),
      )
    },

    reconcile(delegationId) {
      settle(
        'reconcile',
        withClient((client) =>
          client.reconcile(delegationId).then((result) => {
            if (result.ok) {
              deps.raise({
                kind: 'delivery-unknown',
                severity: 'info',
                title: `reconciled: ${result.value.outcome}`,
                detail: evidenceLine(result.value.evidence),
              })
            }
            return result
          }),
        ),
      )
    },

    updateDefaults(delegationId, patch) {
      const reasoning = effort(patch.reasoningEffort)
      if (reasoning === undefined && patch.reasoningEffort !== undefined) return
      settle(
        'updateDefaults',
        withClient((client) =>
          client.updateDefaults(delegationId, {
            model: patch.model,
            ...(patch.reasoningEffort === undefined ? {} : { reasoningEffort: reasoning ?? null }),
            delivery: patch.delivery as TurnDeliveryMode | undefined,
          }),
        ),
      )
    },

    compare(delegationId) {
      // A5 lives in the detail surface; `compare` is a focus with an intent name, because the
      // comparison is already on the delegation's view model (`comparison`).
      withClient((client) => {
        client.focus(delegationId)
      })
    },

    pauseDispatch(delegationId, paused) {
      settle(
        'pauseDispatch',
        withClient((client) =>
          client.pauseDispatch(delegationId === null ? { fleet: true } : { delegationId }, paused),
        ),
      )
    },

    killSwitch(killInstances) {
      settle(
        'killSwitch',
        withClient((client) =>
          client.killSwitch({ killInstances }).then((result) => {
            if (result.ok) {
              // Q16/§5.3.11: a brake, not a delete. Saying so at the moment it fires is the only
              // way the user learns that their work is still there.
              const partial = result.value.instancesKilled.filter(
                (outcome) => !outcome.daemonStopped,
              )
              deps.raise({
                kind: 'kill-switch',
                severity: partial.length > 0 ? 'warn' : 'info',
                title: 'dispatch paused fleet-wide',
                detail:
                  `${result.value.turnsCancelled.length} turns cancelled, ` +
                  `${result.value.attemptsAffected.length} attempts affected, no delegation terminated, no worktree touched` +
                  (partial.length > 0 ? ` — ${partial.length} instance(s) NOT confirmed dead` : ''),
              })
            }
            return result
          }),
        ),
      )
    },

    /* ------------------------------------------------------- copilot gate §6.7 */

    confirm(requestId) {
      settle(
        'confirm',
        withClient((client) => client.confirm(requestId)),
      )
    },

    deny(requestId, reason) {
      settle(
        'deny',
        withClient((client) => client.deny(requestId, reason)),
      )
    },

    dismissNotice(noticeId) {
      deps.dismiss(noticeId)
    },

    openTranscript(attemptId) {
      withClient((client) => {
        const focused = client.focus.get()
        if (focused !== null) client.focus(focused, attemptId)
      })
    },

    openDiff(attemptId) {
      withClient((client) => {
        const focused = client.focus.get()
        if (focused !== null) client.focus(focused, attemptId)
      })
    },

    escape() {
      withClient((client) => {
        client.focus(null)
      })
    },
  }
}

function toCriterion(
  input: HeadCreateInput['acceptance'][number],
  index: number,
): AcceptanceCriterion {
  const id = `c${index + 1}`
  switch (input.kind) {
    case 'command':
      return {
        id,
        label: input.label.length === 0 ? input.value : input.label,
        kind: 'command',
        command: input.value,
        timeoutMs: 600_000,
      }
    case 'file':
      return {
        id,
        label: input.label.length === 0 ? input.value : input.label,
        kind: 'file',
        path: input.value,
        must: 'exist',
      }
    default:
      return {
        id,
        label: input.label.length === 0 ? 'manual check' : input.label,
        kind: 'manual',
        instructions: input.value,
      }
  }
}

/** §5.5's four strong-evidence clauses, rendered verbatim — never summarized into a verdict. */
function evidenceLine(evidence: {
  ackLogged: boolean
  digestInTail: boolean
  workspaceMutated: boolean
  toolEventsLogged: number
  sessionIdle: boolean
}): string {
  return [
    `ack ${evidence.ackLogged ? 'logged' : 'absent'}`,
    `digest ${evidence.digestInTail ? 'in tail' : 'absent'}`,
    `workspace ${evidence.workspaceMutated ? 'mutated' : 'clean'}`,
    `${evidence.toolEventsLogged} tool events`,
    evidence.sessionIdle ? 'session idle' : 'session busy',
  ].join(' · ')
}
