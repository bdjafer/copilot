/**
 * The head's view model and intents — `@astrale-os/swarm/presentation`, extended where the seam
 * does not reach, and **assignable to it** so the seam stays real.
 *
 * SPEC-swarm §6.8 locks `SwarmViewModel` / `SwarmIntents` / `SwarmLabels` and PRODUCT §3 hands
 * rendering to the extension. The seam is therefore a floor, not a ceiling — H6's own wording is
 * that the extension "may ignore it entirely; the seam exists so it is not the only thing that
 * can render". This head does neither: it renders **through** the locked types and extends them,
 * with the compile-time proof at the bottom of this file that the extension's shapes are still
 * exactly what a `SwarmPresentation` may be handed.
 *
 * Three things the head needs that §6.8 has no field for, each with the requirement that forces it:
 *
 *  | Gap | Requirement | Extension field |
 *  |---|---|---|
 *  | `SwarmIntents` has no `createDelegation` | C1–C12b: the composer is the product's front door | `SwarmHeadIntents.create` |
 *  | `send()` carries text + 4 opts; a turn directive carries structure, budget and images | T3/T10, §5.3 "the effective value MUST be shown before send" | `SwarmHeadIntents.sendTurn(directive)` |
 *  | the VM has no transcript, no turn, no effort ladder | W1/W2 (live transcript), §4.3.4 (declared effort), C7/C7b (pickers with no round trip) | `SwarmHeadDelegationVM.transcript` / `.turn` / `.ladder` |
 *
 * (Head deviation **E1**.) Everything else — buckets, rows, notices, confirmations, health,
 * honesty — is the locked shape, unchanged, and is what the renderer actually reads.
 */

import type { TranscriptEntry } from '@astrale-os/swarm'
import type {
  SwarmBucketVM,
  SwarmConfirmationVM,
  SwarmDelegationVM,
  SwarmIntents,
  SwarmLabels,
  SwarmNoticeVM,
  SwarmPresentation,
  SwarmRowVM,
  SwarmViewModel,
} from '@astrale-os/swarm/presentation'

import type { SwarmHeadPhase } from './session.ts'

/* ------------------------------------------------------------------ view model */

/** The pairing plane. Not swarm state at all — it is "may this head even connect". */
export interface SwarmHeadPairingVM {
  readonly phase: SwarmHeadPhase
  readonly endpoint: string
  readonly clientName: string
  readonly tokenId: string | null
  readonly error: string | null
}

/**
 * The focused attempt's turn (§6.2 `TurnVM`), plus the one derived bit the follow-up bar cannot
 * work without: **whether a config change is legal right now**.
 *
 * §4.3.6 refuses an effort or model change while the channel is `submitting | accepted |
 * streaming | interrupting` (`turn_in_flight`, zero executor calls), and §4.3.10 refuses
 * effort/model on any delivery mode but `after-turn`. A picker that lets you choose and then
 * reports a refusal has spent the user's click to teach them a rule the head already knew.
 */
export interface SwarmHeadTurnVM {
  readonly id: string
  readonly attemptId: string
  readonly delivery: string
  readonly landing: string
  readonly model: string
  readonly reasoningEffort: string | null
  /** Literal `false`, and it MUST be rendered (§4.3.4): effort is declared, never observed. */
  readonly effortConfirmed: false
  /** True ⇒ the mode gate applied and this turn ran under whatever the last one set (§4.3.8). */
  readonly configInherited: boolean
  readonly elapsedMs: number
  readonly toolCalls: number
  /** `submitting | accepted | streaming | interrupting` on the focused attempt (§4.3.6). */
  readonly configLocked: boolean
}

export interface SwarmHeadTranscriptVM {
  readonly attemptId: string | null
  readonly following: boolean
  readonly lagged: boolean
  readonly hasOlder: boolean
  readonly entries: readonly TranscriptEntry[]
}

/** §6.8's attempt row, plus what the attempt timeline and the evidence strip need (W2, VE3, A5). */
export interface SwarmHeadAttemptVM {
  readonly id: string
  readonly attemptNo: number
  readonly live: boolean
  readonly channel: string
  readonly verdict: string | null
  readonly filesChanged: number
  readonly estUsd: number
  readonly outcome: string
  readonly nowDoing: string | null
  readonly staleBase: boolean
  readonly startedAt: number
  readonly endedAt: number | null
  readonly turns: number
  readonly toolCalls: number
  readonly evidenceRef: string | null
  readonly verification: {
    readonly runNo: number
    readonly verdict: string
    readonly at: number
  } | null
}

export interface SwarmHeadDelegationVM extends SwarmDelegationVM {
  readonly attempts: readonly SwarmHeadAttemptVM[]
  readonly objectiveLines: readonly string[]
  readonly state: string
  readonly needsYou: string | null
  readonly stalledForMs: number | null
  readonly staleBase: boolean
  readonly unverifiable: boolean
  readonly landed: boolean
  readonly writeMode: string
  readonly workspaceId: string
  readonly focusedAttemptId: string | null
  readonly turn: SwarmHeadTurnVM | null
  readonly transcript: SwarmHeadTranscriptVM
  /** The closed effort ladder for the effective provider+model (§4.1) — the picker's only source. */
  readonly ladder: readonly string[]
  readonly deliveryModes: readonly string[]
  readonly comparison: readonly {
    readonly id: string
    readonly attemptNo: number
    readonly verdict: string
    readonly filesChanged: number
    readonly estUsd: number
    readonly recommended: boolean
  }[]
}

export interface SwarmHeadViewModel extends SwarmViewModel {
  readonly pairing: SwarmHeadPairingVM
  readonly focused: SwarmHeadDelegationVM | null
  /** C4's allowlist has no wire representation; see `view-model.ts` (head deviation **E3**). */
  readonly workspaces: readonly { readonly id: string; readonly label: string }[]
  readonly deliveryModes: readonly string[]
  readonly efforts: readonly string[]
}

/* --------------------------------------------------------------------- intents */

export interface HeadAcceptanceInput {
  readonly kind: 'command' | 'file' | 'manual'
  readonly label: string
  /** `command` ⇒ the shell line; `file` ⇒ the path; `manual` ⇒ the instructions. */
  readonly value: string
}

export interface HeadCreateInput {
  readonly objective: string
  readonly title?: string
  readonly workspaceId: string
  readonly baseRef: string
  readonly writeMode: 'worktree' | 'in-place'
  readonly acceptance: readonly HeadAcceptanceInput[]
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string | null
  readonly delivery: string
  readonly parallelAttempts: 1 | 2 | 3
  readonly budget: {
    readonly maxWallMs: number
    readonly maxTurns: number
    readonly maxToolCalls: number
    readonly maxSpendUsd?: number
  }
}

/**
 * One follow-up message with its **per-turn** controls (§4.1 `TurnDirective`, T1–T10). Every field
 * but `text` is an override for this message only: omission reconciles to the *delegation* default,
 * never to the previous turn's override (Q4, §5.3.2).
 */
export interface HeadTurnInput {
  readonly text: string
  readonly attemptId?: string
  readonly delivery?: string
  readonly model?: string
  readonly reasoningEffort?: string | null
  /** T3 — attaches the head's structured-report schema and discloses the retry cost. */
  readonly structured?: boolean
  readonly budget?: { readonly maxWallMs?: number; readonly maxToolCalls?: number }
}

export interface SwarmHeadIntents extends SwarmIntents {
  create(input: HeadCreateInput): void
  sendTurn(delegationId: string, input: HeadTurnInput): void
  /** Q4's load-bearing knob — "high from now on" (§6.3 `updateDefaults`, #35). */
  updateDefaults(
    delegationId: string,
    patch: { model?: string; reasoningEffort?: string | null; delivery?: string },
  ): void
  branch(attemptId: string): void
  discard(attemptId: string): void
  archive(delegationId: string, abandon?: boolean): void
  reconcile(delegationId: string): void
  selectAttempt(delegationId: string, attemptId: string): void
  followTranscript(on: boolean): void
  loadOlder(): void
}

/* -------------------------------------------------------------- compile-time proofs */

/**
 * The head's shapes are still the seam's shapes. If a field is ever widened out of compatibility
 * — a `SwarmRowVM.attention` that stops being a number, an intent that starts returning a promise
 * — these four lines stop compiling, and the claim "the extension renders through the locked
 * presentation types" stops being a comment and starts being false.
 */
export type HeadVmIsSeamVm = SwarmHeadViewModel extends SwarmViewModel ? true : never
export type HeadIntentsAreSeamIntents = SwarmHeadIntents extends SwarmIntents ? true : never
export type HeadDelegationIsSeamDelegation = SwarmHeadDelegationVM extends SwarmDelegationVM
  ? true
  : never

export const HEAD_RENDERS_THROUGH_THE_SEAM: [
  HeadVmIsSeamVm,
  HeadIntentsAreSeamIntents,
  HeadDelegationIsSeamDelegation,
] = [true, true, true]

/** A renderer of this head is a `SwarmPresentation` with the head's VM and intents. */
export interface SwarmHeadPresentation extends SwarmPresentation {
  mount(
    host: { root: ShadowRoot | HTMLElement; theme: 'light' | 'dark' | 'auto' },
    vm: SwarmHeadViewModel,
    intents: SwarmHeadIntents,
    labels: SwarmLabels,
  ): unknown
  render(handle: unknown, vm: SwarmHeadViewModel): void
  destroy(handle: unknown): void
}

export type { SwarmBucketVM, SwarmConfirmationVM, SwarmLabels, SwarmNoticeVM, SwarmRowVM }
