/**
 * The copilot tool surface (SPEC-swarm §6.7, Q8, #39).
 *
 * Six tools, three read and three write, and one rule that shapes every line of this file:
 * **no head connected ⇒ no confirmation ⇒ no write.** A write tool persists a
 * `ConfirmationRequest`, emits `server.confirmation`, and *waits*. A human calls `confirm` or
 * `deny`; unanswered requests expire after `confirmationTtlMs` and are denied automatically. The
 * copilot cannot act while nobody is watching, which is the entire point of the ruling — a
 * mandate with no mechanism is decided by whoever writes the code first (#39).
 *
 * Two absences are as normative as the presences:
 *
 *  - **`swarm.complete`, `swarm.verify`, `swarm.land` and `swarm.retry` do not exist** and MUST NOT
 *    be added. A verdict a conversation can write is not a verdict.
 *  - **`swarm.cancel` is refused outright** — before any confirmation is even offered — when the
 *    delegation's `createdBy.kind !== 'copilot'`. Confirming a cancel of somebody else's work is
 *    a decision a user should never be asked to make in a dialog they did not open.
 *
 * Node ≥ 24, server-only (it holds the engine).
 */

import type { Unsubscribe } from '../types.ts'
import type {
  ActorRef,
  ConfirmationRequest,
  CreateDelegationInput,
  DelegationId,
  DelegationRecord,
  DelegationState,
  DelegationVM,
  FleetVM,
  TurnDirective,
  TurnId,
} from '../types.ts'
import type { IntentResult, SwarmEngine } from './engine.ts'

import { delegationMachine } from '../domain/machines.ts'
import { SwarmError } from '../errors.ts'
import { readDelegation } from './projections.ts'

/** `until` for `swarm.wait` (§6.7). */
export type CopilotWaitUntil = 'idle' | 'waiting' | 'terminal' | 'event'

export interface CopilotSurfaceOptions {
  readonly engine: SwarmEngine
  /** Identifies the conversation on the `ConfirmationRequest`, so a human knows who is asking. */
  readonly conversationId: string
  readonly pageUrl?: string
  readonly ids?: () => string
  readonly now?: () => number
}

export interface CopilotTools {
  /** Read. No authority: counts and rows, exactly what a fleet list renders. */
  list(): FleetVM
  /** Read. No authority: one delegation, without transcript text — that lives on `attempt:*`. */
  inspect(delegationId: DelegationId): DelegationVM | null
  /** Read. Event-driven, never a poll. */
  wait(input: {
    delegationId: DelegationId
    until: CopilotWaitUntil
    timeoutMs: number
  }): Promise<{ reached: boolean; state: DelegationState | null }>
  /** Write. `ConfirmationRequest` → `confirm`. */
  start(input: CreateDelegationInput): Promise<IntentResult<DelegationId>>
  /** Write. `ConfirmationRequest` → `confirm`. */
  followUp(delegationId: DelegationId, directive: TurnDirective): Promise<IntentResult<TurnId>>
  /** Write. Refused **outright** when the delegation was not created by a copilot. */
  cancel(delegationId: DelegationId, scope: 'turn' | 'delegation'): Promise<IntentResult<null>>
}

const refuse = <T>(error: SwarmError): IntentResult<T> => ({ ok: false, error })

export function createCopilotSurface(options: CopilotSurfaceOptions): CopilotTools {
  const engine = options.engine
  const ids = options.ids ?? (() => Math.random().toString(36).slice(2, 12))
  const now = options.now ?? Date.now

  const requestedBy = {
    kind: 'copilot' as const,
    conversationId: options.conversationId,
    ...(options.pageUrl === undefined ? {} : { pageUrl: options.pageUrl }),
  }

  const readDelegationVM = (delegationId: DelegationId): DelegationVM | null => {
    const fleet = engine.snapshot('fleet').state as { delegations: readonly DelegationVM[] }
    return fleet.delegations.find((row) => row.id === delegationId) ?? null
  }

  /**
   * Ask, wait, then execute under `ActorRef{kind:'copilot', confirmedBy}` — or refuse. The audit
   * row therefore names both the conversation that asked and the token that agreed, which is the
   * half of S13 that answers "who decided this".
   */
  const gated = async <T>(
    tool: ConfirmationRequest['tool'],
    summary: string,
    payload: ConfirmationRequest['payload'],
    effective: ConfirmationRequest['effective'],
    run: (actor: ActorRef) => Promise<IntentResult<T>>,
  ): Promise<IntentResult<T>> => {
    const { decided } = engine.confirmations.request({
      requestId: `cnf_${ids()}`,
      tool,
      requestedBy,
      summary,
      payload,
      effective,
    })
    const outcome = await decided
    if (outcome.decision === 'deny') {
      return refuse(
        new SwarmError(
          'confirmation_required',
          outcome.reason === 'expired'
            ? `no head answered within confirmationTtlMs, so ${tool} was denied`
            : `${tool} was denied${outcome.reason === null ? '' : `: ${outcome.reason}`}`,
          { retryable: false, details: { tool, reason: outcome.reason } },
        ),
      )
    }
    return run({ kind: 'copilot', confirmedBy: outcome.confirmedBy })
  }

  const effectiveOf = (record: DelegationRecord): ConfirmationRequest['effective'] => ({
    provider: record.spec.model.provider,
    model: record.spec.model.model,
    reasoningEffort: record.spec.model.reasoningEffort,
    workspace: record.spec.workspace.workspaceId,
    writeMode: record.spec.workspace.writeMode,
  })

  const dispatchAs = <T>(
    intent: string,
    args: unknown,
    actor: ActorRef,
    idempotencyKey: string,
  ): Promise<IntentResult<T>> =>
    engine.dispatch(intent, args, {
      actor,
      /* The confirming head's token is the accountable identity; the copilot has none of its own. */
      tokenId: actor.kind === 'copilot' ? (actor.confirmedBy ?? 'copilot') : 'copilot',
      idempotencyKey,
    }) as Promise<IntentResult<T>>

  return {
    list() {
      const fleet = engine.snapshot('fleet').state as {
        delegations: readonly DelegationVM[]
        concurrency: FleetVM['concurrency']
        dispatchPaused: boolean
        spend: FleetVM['spend']
      }
      const buckets: Record<string, DelegationId[]> = {}
      const counts: Record<string, number> = {}
      for (const row of fleet.delegations) {
        ;(buckets[row.bucket] ??= []).push(row.id)
        counts[row.bucket] = (counts[row.bucket] ?? 0) + 1
      }
      return {
        buckets,
        counts,
        dispatchPaused: fleet.dispatchPaused,
        concurrency: fleet.concurrency,
        spend: fleet.spend,
      } as unknown as FleetVM
    },

    inspect(delegationId) {
      return readDelegationVM(delegationId)
    },

    wait(input) {
      const matches = (state: DelegationState | null): boolean => {
        if (state === null) return false
        switch (input.until) {
          case 'terminal':
            return delegationMachine.isTerminal(state)
          case 'waiting':
            return state === 'waiting' || state === 'needs-you'
          case 'idle':
            return state !== 'running' && state !== 'provisioning' && state !== 'verifying'
          case 'event':
            return true
        }
      }
      const stateOf = (): DelegationState | null =>
        engine.store.read((tx) => readDelegation(tx, input.delegationId)?.state ?? null)

      const initial = stateOf()
      if (input.until !== 'event' && matches(initial)) {
        return Promise.resolve({ reached: true, state: initial })
      }
      return new Promise((resolve) => {
        let unsubscribe: Unsubscribe = () => undefined
        const timer = setTimeout(() => {
          unsubscribe()
          resolve({ reached: false, state: stateOf() })
        }, input.timeoutMs)
        timer.unref?.()
        /* Event-driven (§6.7): the fan-out already fires on every committed record, so a poll
         * would be a second clock disagreeing with the first. */
        unsubscribe = engine.store.onCommit((result) => {
          const touched = result.emitted.some((row) => row.delegationId === input.delegationId)
          if (!touched) return
          const state = stateOf()
          if (!matches(state)) return
          clearTimeout(timer)
          unsubscribe()
          resolve({ reached: true, state })
        })
      })
    },

    async start(input) {
      const workspace = input.spec.workspace
      return gated(
        'swarm.start',
        `Start a delegation in ${workspace.workspaceId}: ${input.spec.objective.slice(0, 120)}`,
        input,
        {
          provider: input.spec.model.provider,
          model: input.spec.model.model,
          reasoningEffort: input.spec.model.reasoningEffort,
          workspace: workspace.workspaceId,
          writeMode: workspace.writeMode ?? 'worktree',
        },
        (actor) =>
          dispatchAs<DelegationId>(
            'createDelegation',
            {
              ...(input.delegationId === undefined ? {} : { delegationId: input.delegationId }),
              ...(input.title === undefined ? {} : { title: input.title }),
              spec: input.spec,
            },
            actor,
            input.idempotencyKey,
          ),
      )
    },

    async followUp(delegationId, directive) {
      const record = engine.store.read((tx) => readDelegation(tx, delegationId))
      if (record === null) {
        return refuse(new SwarmError('not_found', `no delegation ${delegationId}`))
      }
      return gated(
        'swarm.followUp',
        `Send a turn to "${record.title}": ${directive.text.slice(0, 120)}`,
        { delegationId, directive },
        effectiveOf(record),
        (actor) =>
          dispatchAs<TurnId>(
            'sendTurn',
            { delegationId, directive },
            actor,
            directive.idempotencyKey,
          ),
      )
    },

    async cancel(delegationId, scope) {
      const record = engine.store.read((tx) => readDelegation(tx, delegationId))
      if (record === null) {
        return refuse(new SwarmError('not_found', `no delegation ${delegationId}`))
      }
      /* Refused **outright** — no confirmation is even offered (§6.7). A dialog asking a human to
       * approve a copilot cancelling work the human started is a dialog that will be approved by
       * reflex. */
      if (record.createdBy.kind !== 'copilot') {
        return refuse(
          new SwarmError('forbidden', 'a copilot may only cancel a delegation a copilot created', {
            retryable: false,
            details: { delegationId, createdBy: record.createdBy.kind },
          }),
        )
      }
      return gated(
        'swarm.cancel',
        `Cancel "${record.title}" (${scope})`,
        { delegationId, scope },
        effectiveOf(record),
        (actor) =>
          dispatchAs<null>(
            'cancel',
            { delegationId, scope },
            actor,
            `copilot-cancel:${delegationId}:${scope}:${now()}`,
          ),
      )
    },
  }
}
