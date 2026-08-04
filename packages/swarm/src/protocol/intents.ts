/**
 * `req.args` and `res.data`, per intent (SPEC-swarm §2.2, §6.3).
 *
 * §2.2 types `req.args` as `unknown` and §6.3 types the client methods; nothing in between says
 * what a `sendTurn` frame actually carries. That gap is not a licence to improvise once per
 * caller: the client stage and the server stage are written separately, and a shape agreed in two
 * places is a shape that disagrees in one of them. So the mapping is declared here, as types plus
 * one decoder, in the module both sides already share (`./server` imports the protocol by
 * relative path, §1.1).
 *
 * The rule the table follows: **`args` mirrors the §6.3 method signature, with the receiver's id
 * hoisted to a named field and `idempotencyKey`/`expectedVersion` removed** — those two ride on
 * the envelope (§2.2) and duplicating them would let a frame disagree with itself.
 *
 * `res.data` is `IntentResponse`: the value the method resolves to plus the record `version`
 * §6.3's `IntentResult` requires. A bare value could not carry the version, and a version is what
 * `expectedVersion` on the *next* intent is compared against.
 *
 * DOM-free and Node-free.
 */

import type {
  AttemptId,
  CreateDelegationInput,
  DelegationDefaultsPatch,
  DelegationId,
  DelegationSpec,
  LandOptions,
  TurnDirective,
  TurnId,
} from '../types.ts'
import type { IntentName } from './frames.ts'

/** The `args` body of every `req` frame, keyed by intent (§6.3). */
export interface IntentArgs {
  createDelegation: {
    /** Client-generated (C11). The client core always fills it, so an offline optimistic record
     * and the server's record share one id. */
    readonly delegationId: DelegationId
    readonly title?: string
    readonly priority?: number
    readonly spec: CreateDelegationInput['spec']
  }
  sendTurn: { readonly delegationId: DelegationId; readonly directive: TurnDirective }
  retract: { readonly turnId: TurnId }
  cancel: {
    readonly delegationId: DelegationId
    readonly scope: 'turn' | 'delegation' | 'hard'
    readonly attemptId?: AttemptId
  }
  retry: {
    readonly delegationId: DelegationId
    readonly spec?: Partial<DelegationSpec>
    readonly parallel?: 1 | 2 | 3
    readonly injectPriorFailure?: boolean
  }
  branch: { readonly attemptId: AttemptId; readonly title?: string }
  verify: {
    readonly delegationId: DelegationId
    readonly attemptId?: AttemptId
    readonly criteria?: readonly string[]
  }
  accept: {
    readonly delegationId: DelegationId
    readonly note: string
    readonly attemptId?: AttemptId
  }
  land: { readonly delegationId: DelegationId } & LandOptions
  discard: { readonly attemptId: AttemptId }
  archive: { readonly delegationId: DelegationId; readonly abandon?: boolean }
  reconcile: { readonly delegationId: DelegationId }
  pauseDispatch: {
    readonly scope: { readonly fleet: true } | { readonly delegationId: DelegationId }
    readonly paused: boolean
  }
  killSwitch: { readonly killInstances: boolean }
  updateDefaults: {
    readonly delegationId: DelegationId
    readonly patch: DelegationDefaultsPatch
  }
  confirm: { readonly requestId: string }
  deny: { readonly requestId: string; readonly reason?: string }
}

/**
 * Compile-time proof that the table above covers exactly the 17 wire intents — `setFilter` and
 * `focus` are local view selections and never reach the wire (§2.2, §6.3), so a table entry for
 * either would be a frame nobody can send.
 */
export type IntentArgsCoverage = IntentName extends keyof IntentArgs
  ? keyof IntentArgs extends IntentName
    ? true
    : never
  : never
const INTENT_ARGS_ARE_TOTAL: IntentArgsCoverage = true
void INTENT_ARGS_ARE_TOTAL

/**
 * The `res.data` body. `version` is the record version **after** the mutation, which is what
 * `IntentResult.version` reports and what a later `expectedVersion` is checked against; an intent
 * that mutates nothing (`confirm`, `killSwitch`) reports the version it observed.
 */
export interface IntentResponse<T = unknown> {
  readonly value: T
  readonly version: number
}

/**
 * Strict, because the alternative is worse than a failure. A tolerant decoder that treated an
 * unrecognised `data` as the value would hand the head `version: 0` for a real record and make
 * every subsequent `expectedVersion` fail with `version_conflict` — a bug that surfaces three
 * intents later, in the server.
 */
export function decodeIntentResponse(data: unknown): IntentResponse | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const body = data as { value?: unknown; version?: unknown }
  if (!('value' in body)) return null
  if (typeof body.version !== 'number' || !Number.isFinite(body.version)) return null
  return { value: body.value, version: body.version }
}
