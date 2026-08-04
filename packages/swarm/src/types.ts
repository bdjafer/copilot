/**
 * Every domain, record, directive and view-model type of SPEC-swarm §1.3, §3.1–§3.5, §4.1,
 * §6.1–§6.3, §6.7 and §8. **Zero logic** (§10) — this module declares shapes and nothing else,
 * so the client core, the server and the testing entry all agree on one vocabulary without any
 * of them importing another's runtime.
 *
 * **§3.1's convention is normative and written out here rather than elided:** every declared
 * field is `readonly`, every array is `readonly T[]`. `DeepReadonly` is not used.
 *
 * DOM-free and Node-free (§1.1 H2). The only imports are type-only, from `./protocol/frames.ts`
 * — which imports type-only back — so the cycle is erased at emit and there is no runtime edge
 * in either direction.
 */

import type { SwarmError } from './errors.ts'
import type {
  HeadKind,
  IntentName,
  LagReason,
  ServerCapability,
  StreamName,
} from './protocol/frames.ts'

/* -------------------------------------------------------------------------------- identity */

export type DelegationId = string
export type AttemptId = string
export type TurnId = string

/** `` `<provider>/<credentialScope>` `` — **two** dimensions (§5.3, decision log #26/#20). */
export type InstanceKey = string

/* ---------------------------------------------------------------- §6.1 reactive primitives */

/**
 * Re-declared, never imported (H3, §1.2). `comment-core` exports a structurally identical
 * `ReadableStore<T>`; a type-level test asserts the compatibility by importing it *in the test
 * file only*, so no shipped module ever depends on that package.
 */
export interface ReadableStore<T> {
  get(): T
  subscribe(listener: (value: T, previous: T) => void): Unsubscribe
}

export type Unsubscribe = () => void

/**
 * Injected transport (H7). The client core never constructs a WebSocket: the extension head
 * passes a WS transport, the CLI head passes a WS or in-process one, tests pass a fake.
 */
export interface SwarmTransport {
  open(): void
  send(text: string): void
  close(code?: number, reason?: string): void
  onOpen(cb: () => void): Unsubscribe
  onMessage(cb: (text: string) => void): Unsubscribe
  onClose(cb: (i: { code: number; reason: string; wasClean: boolean }) => void): Unsubscribe
  onError(cb: (e: unknown) => void): Unsubscribe
}

/* ------------------------------------------------------- §1.3 the temporal-memory seam only */

export type ContextRef =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'page'; readonly url: string; readonly title: string }
  | { readonly kind: 'thread'; readonly threadId: string }
  | { readonly kind: 'screenshot'; readonly digest: string }
  | { readonly kind: 'attempt'; readonly attemptId: AttemptId }
  | { readonly kind: 'memory'; readonly query: string; readonly sourceId: string }

export interface ContextBundle {
  readonly kind: ContextRef['kind']
  readonly text: string
  readonly provenance: {
    readonly sourceId: string
    readonly snapshotRevision?: string
    readonly generatedAt: number
    /** sha256 hex of `text`. */
    readonly digest: string
  }
  readonly citations?: readonly { readonly id: string; readonly label: string }[]
}

/**
 * Boundary-only (§1.3): declared here, implemented by the head, **never imported** from
 * `temporal-memory`. Bundles cross the wire by value; the server stores bundle text + digest on
 * the turn record and never calls a provider during reconciliation, replay or verification.
 */
export interface ContextProvider {
  readonly id: string
  /** Resolve a ref to inline prompt material. MUST be pure w.r.t. swarm state. */
  resolve(ref: ContextRef, budget: { maxChars: number }): Promise<ContextBundle>
}

/* ------------------------------------------------------------------------ §3.3 state unions */

/** Ten values; `succeeded`, `failed`, `cancelled` and `abandoned` are terminal (§3.3). */
export type DelegationState =
  | 'queued'
  | 'provisioning'
  | 'running'
  | 'waiting'
  | 'verifying'
  | 'needs-you'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'abandoned'

/** Nine values, **per attempt, per executor session** — never per delegation (§3.3, PRODUCT §4.2). */
export type ChannelState =
  | 'detached'
  | 'attaching'
  | 'idle'
  | 'submitting'
  | 'accepted'
  | 'streaming'
  | 'interrupting'
  | 'disconnected'
  | 'closed'

/** Seven values, per turn; `unknown` is first-class and user-visible (X4, §3.3). */
export type DeliveryState =
  | 'prepared'
  | 'sent'
  | 'accepted'
  | 'running'
  | 'ended'
  | 'unknown'
  | 'failed'

/* -------------------------------------------------------------------------- §4.1 directives */

export type TurnDeliveryMode = 'after-turn' | 'next-safe-point' | 'interrupt' | 'context-only'

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface TurnBudget {
  readonly maxWallMs?: number
  readonly maxToolCalls?: number
}

export interface TurnDirective {
  readonly text: string
  /** Required when `liveAttempts.length > 1` (Q9, §4.3.10). */
  readonly attemptId?: AttemptId
  /** Default `spec.delivery.mode`. */
  readonly delivery?: TurnDeliveryMode
  /** `'after-turn'` ONLY (#30); omission ⇒ the delegation default, never the previous turn (Q4). */
  readonly model?: string
  /** `'after-turn'` ONLY (#30); omission ⇒ the delegation default, never the previous turn (Q4). */
  readonly reasoningEffort?: ReasoningEffort | null
  readonly structured?: { readonly schema: unknown; readonly maxRetries?: number }
  /** ≤ 700 KB decoded per image and per turn (§2.4) — refused in the client core. */
  readonly images?: readonly { readonly mediaType: string; readonly base64: string }[]
  readonly context?: readonly ContextRef[]
  readonly budget?: TurnBudget
  readonly notify?: 'silent' | 'notify' | { readonly thread: string }
  readonly idempotencyKey: string
  readonly expectedVersion?: number
}

/* ------------------------------------------------------------- §3.1 specs and record bodies */

export interface SkillRef {
  readonly name: string
  readonly source: string
  readonly digest: string
}

/** All four transports (decision log #25) — the briefing's stdio-only claim was wrong. */
export interface McpServerRef {
  readonly name: string
  readonly enabled: boolean
  readonly config: Record<string, unknown>
  readonly transport: 'stdio' | 'http' | 'sse' | 'streamable-http'
}

export interface ModelSpec {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: ReasoningEffort | null
}

export interface BudgetSpec {
  readonly maxWallMs: number
  readonly maxTurns: number
  readonly maxToolCalls: number
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly maxSpendUsd?: number
  /** Never `'kill'` (Q11): a hard breach pauses dispatch, it does not cancel a running turn. */
  readonly onBreach: 'pause-dispatch' | 'needs-you'
}

export interface ExecutionSpec {
  /** Literals, not configuration (§3.1). */
  readonly nativeSwarm: false
  readonly jcodeMemory: false
  readonly autoPoke: boolean
  readonly skills: readonly SkillRef[]
  readonly mcp?: readonly McpServerRef[]
}

export interface WorkspaceSpec {
  readonly workspaceId: string
  /** Full 40-char sha, RESOLVED by the server at create (C4b) — never a symbolic ref. */
  readonly baseRevision: string
  /** `'readonly'` is deleted (Q6, #28): jcode has no read-only mode to back it. */
  readonly writeMode: 'worktree' | 'in-place'
  readonly subPath?: string
  /** The only `'in-place'`-on-dirty escape (C6); `actor` and `at` are stamped by the server. */
  readonly allowDirty?: { readonly actor: ActorRef; readonly at: number; readonly note: string }
}

export interface DeliveryDefaults {
  readonly mode: TurnDeliveryMode
  readonly notify: 'silent' | 'notify'
}

export interface DelegationSpec {
  readonly specVersion: 1
  readonly objective: string
  readonly constraints?: string
  /** `[]` ⇒ unverifiable (Q1): reachable only through `accept{note}` (D14). */
  readonly acceptance: readonly AcceptanceCriterion[]
  readonly workspace: WorkspaceSpec
  readonly model: ModelSpec
  readonly budget: BudgetSpec
  readonly execution: ExecutionSpec
  readonly context: readonly ContextRef[]
  readonly delivery: DeliveryDefaults
  /** Default 1 (Q9). N live attempts occupy N scheduler slots. */
  readonly parallelAttempts: 1 | 2 | 3
  /** Default `false` (Q5) — `unknown` never auto-resends. */
  readonly autoResendOnStrongEvidence?: boolean
  /** Default `false` (§3.2) — a `review` verdict alone is advisory. */
  readonly reviewIsAuthoritative?: boolean
}

/** §3.2. Every member also carries `id` and `label`. */
export type AcceptanceCriterion = { readonly id: string; readonly label: string } & (
  | {
      readonly kind: 'command'
      readonly command: string
      readonly cwd?: string
      readonly timeoutMs: number
      readonly expectExit?: number
      readonly env?: Record<string, string>
    }
  | {
      readonly kind: 'file'
      readonly path: string
      readonly must: 'exist' | 'absent' | 'match' | 'changed'
      readonly pattern?: string
    }
  | {
      readonly kind: 'artifact'
      readonly path: string
      readonly sha256?: string
      readonly minBytes?: number
      readonly producedDuringAttempt: boolean
    }
  | {
      readonly kind: 'review'
      readonly rubric: string
      readonly model?: string
      readonly effort?: ReasoningEffort
      /** 0..1, default 0.7. */
      readonly threshold: number
    }
  | { readonly kind: 'manual'; readonly instructions: string }
)

export type ActorRef =
  | { readonly kind: 'user'; readonly head: HeadKind; readonly tokenId: string }
  | { readonly kind: 'copilot'; readonly confirmedBy: string | null }
  | { readonly kind: 'server'; readonly reason: string }

export type NeedsYouReason =
  | 'question'
  | 'manual-criterion'
  | 'verification-failed'
  | 'budget'
  | 'delivery-unknown'
  | 'landing-conflict'
  | 'drift'
  | 'unverifiable-turn-end'

export interface LandingRecord {
  readonly mode: 'commit' | 'patch'
  readonly attemptId: AttemptId
  readonly ref: string
  readonly sha?: string
  readonly patchPath?: string
  readonly at: number
}

/* ------------------------------------------------------------------- §3.4 budgets and leases */

export interface SpendCounters {
  readonly wallMs: number
  /** Tracked separately from `wallMs` (X10) — the pair is what distinguishes sleep from stall. */
  readonly monotonicMs: number
  /** Σ(Δwall − Δmono) over detected gaps; excluded from `maxWallMs` (X16). */
  readonly sleptMs: number
  readonly turns: number
  readonly toolCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly estUsd: number
}

export type LeaseKey =
  | `session:${string}`
  | `home:${string}`
  | `worktree:${string}`
  | `delegation:${DelegationId}`
  | `repo:${string}`

export interface Lease {
  readonly key: LeaseKey
  readonly holder: string
  /** Fencing token, from one monotonic counter in the durable store (§3.4 rule 6). */
  readonly token: number
  readonly acquiredAt: number
  readonly expiresAt: number
}

export interface Fence {
  readonly key: LeaseKey
  readonly token: number
}

/* --------------------------------------------------------------------------- §3.1 records */

export interface DelegationRecord {
  readonly recordVersion: 1
  readonly id: DelegationId
  /** +1 per mutation; `expectedVersion` on an intent is checked against it. */
  readonly version: number
  readonly spec: DelegationSpec
  readonly title: string
  /** A ROLLUP over `liveAttempts` (§3.3), never an independently-set value. */
  readonly state: DelegationState
  /** Set iff `state === 'succeeded'`. */
  readonly verdict: 'verified' | 'accepted' | null
  /** Frozen at create: `spec.acceptance.length === 0`. */
  readonly unverifiable: boolean
  readonly dispatchPaused: boolean
  readonly landed: LandingRecord | null
  /** Append-only: every attempt ever. */
  readonly attempts: readonly AttemptId[]
  /** Non-terminal attempts; length ≤ `spec.parallelAttempts`. */
  readonly liveAttempts: readonly AttemptId[]
  /** The head's current selection; presentation only. */
  readonly focusedAttempt: AttemptId | null
  /** Set by `branch` (A6) — the lineage Q2 and A5 both need. */
  readonly origin: { readonly delegationId: DelegationId; readonly attemptId: AttemptId } | null
  readonly priority: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly createdBy: ActorRef
  readonly spend: SpendCounters
  readonly lastNeedsYouReason: NeedsYouReason | null
}

export interface AttemptRecord {
  readonly recordVersion: 1
  readonly id: AttemptId
  readonly delegationId: DelegationId
  /** 1-based, append-only (A1). */
  readonly attemptNo: number
  /** Frozen copy; a retry may edit it (A2). */
  readonly spec: DelegationSpec
  readonly executor: {
    readonly adapterId: AdapterId
    readonly instanceKey: InstanceKey
    readonly sessionId: string | null
    readonly versions: Record<string, string>
  }
  readonly workspace: {
    readonly root: string
    readonly worktree: string | null
    readonly baseRevision: string
    readonly staleBase: boolean
  }
  readonly channel: ChannelState
  readonly turns: readonly TurnId[]
  readonly verifications: readonly VerificationRun[]
  readonly evidence: string | null
  readonly startedAt: number
  readonly endedAt: number | null
  readonly outcome: AttemptOutcome
}

export type AttemptOutcome =
  | 'open'
  | 'interrupted'
  | 'exhausted'
  | 'verified'
  | 'accepted'
  | 'failed'
  | 'cancelled'
  | 'abandoned'

export interface EffectiveTurnConfig {
  readonly provider: string
  /** `'inherited'` iff `deliveryMode !== 'after-turn'` (#30). */
  readonly model: string | 'inherited'
  readonly reasoningEffort: ReasoningEffort | null | 'inherited'
  /**
   * A **literal**, not a boolean field (decision log #7): the bridge discards the daemon's
   * applied effort, the SDK returns `Promise<void>` and there is no getter, so no code path may
   * ever claim otherwise. A future implementation that writes `true` fails to typecheck.
   */
  readonly effortConfirmed: false
  /** True once `model_info` echoes it; false when `'inherited'`. */
  readonly modelConfirmed: boolean
  readonly deliveryMode: TurnDeliveryMode
  readonly structured: { readonly schemaDigest: string; readonly maxRetries: number } | null
  readonly budget: TurnBudget | null
  readonly executorVersions: Record<string, string>
}

export interface DeliveryDetail {
  readonly ackAtMs: number | null
  /** Always `false` for jcode: `message_accepted` carries only `session_id` (§5.4 #3). */
  readonly correlated: false
  readonly reason?: string
  /** `'unconfirmed'` for every soft interrupt — the landing event is untranslated (§5.4 #10). */
  readonly landing: 'confirmed' | 'unconfirmed' | 'n/a'
}

export interface TurnRecord {
  readonly recordVersion: 1
  readonly id: TurnId
  readonly attemptId: AttemptId
  readonly ordinal: number
  /** As requested. */
  readonly directive: TurnDirective
  /** As declared (§4.3) — never as observed. */
  readonly effective: EffectiveTurnConfig
  readonly promptDigest: string
  readonly attachmentDigests: readonly string[]
  readonly contextBundles: readonly ContextBundle['provenance'][]
  readonly delivery: DeliveryState
  readonly deliveryDetail: DeliveryDetail
  readonly usage: {
    readonly input: number
    readonly output: number
    readonly cacheReadInput?: number
  } | null
  readonly toolCallCount: number
  readonly startedAt: number
  readonly endedAt: number | null
  readonly actor: ActorRef
}

/* ------------------------------------------------------------------------ §3.1 create input */

export interface WorkspaceInput {
  readonly workspaceId: string
  /** A revision EXPRESSION (`'HEAD'`, a branch, a tag, a short sha); default `'HEAD'` (C4b). */
  readonly baseRef?: string
  readonly writeMode?: 'worktree' | 'in-place'
  readonly subPath?: string
  /** `actor` and `at` are stamped by the server, never accepted from the head. */
  readonly allowDirty?: { readonly note: string }
}

/** What a head submits. `spec` differs from `DelegationSpec` in exactly one field. */
export interface CreateDelegationInput {
  /** Client-generated (C11), so an offline create has a stable identity. */
  readonly delegationId?: DelegationId
  /** Omitted ⇒ auto-generated from the objective (C15). */
  readonly title?: string
  readonly idempotencyKey: string
  readonly priority?: number
  readonly spec: Omit<DelegationSpec, 'workspace'> & { readonly workspace: WorkspaceInput }
}

/* ------------------------------------------------------------------------- §8 verification */

export interface VerificationInput {
  readonly attemptId: AttemptId
  readonly criteria: readonly AcceptanceCriterion[]
  readonly workspace: { readonly cwd: string; readonly baseRevision: string }
  readonly deadlineMs: number
  readonly reason: 'auto-turn-end' | 'manual' | 'pre-land' | 're-verify'
}

/** Every member also carries `id`. */
export type CriterionResult = { readonly id: string } & (
  | {
      readonly kind: 'command'
      readonly status: 'pass' | 'fail' | 'error' | 'timeout'
      readonly exitCode: number | null
      readonly durationMs: number
      readonly stdoutRef: string
      readonly stderrRef: string
      readonly truncated: boolean
    }
  | { readonly kind: 'file'; readonly status: 'pass' | 'fail' | 'error'; readonly observed: string }
  | {
      readonly kind: 'artifact'
      readonly status: 'pass' | 'fail' | 'error'
      readonly sha256: string | null
      readonly bytes: number | null
      readonly producedDuringAttempt: boolean
    }
  | {
      readonly kind: 'review'
      readonly status: 'pass' | 'fail' | 'error'
      readonly score: number
      readonly rationale: string
      readonly judgeSessionId: string
      readonly judgeModel: string
    }
  | { readonly kind: 'manual'; readonly status: 'manual' }
)

export interface VerificationRun {
  readonly runId: string
  readonly attemptId: AttemptId
  /** Append-only; re-verification never overwrites (§8 rule 6). */
  readonly runNo: number
  readonly startedAt: number
  readonly endedAt: number
  readonly verdict: 'pass' | 'fail' | 'indeterminate'
  readonly results: readonly CriterionResult[]
  readonly baseRevisionAtRun: string
  readonly staleBase: boolean
  /** `$SWARM_HOME/evidence/<attemptId>/<runId>`. */
  readonly evidenceRef: string
}

export interface Verifier {
  run(input: VerificationInput): Promise<VerificationRun>
}

/* ------------------------------------------- §5.1 executor identity visible to the client */

/** No third backend (#27; §10 non-goal). */
export type AdapterId = 'jcode' | 'mock'

export interface PreflightReport {
  readonly ok: boolean
  readonly detail: string
  readonly versions: Record<string, string>
  readonly blocked:
    | 'version_floor'
    | 'binary_missing'
    | 'socket_dir'
    | 'credentials'
    | 'no_route'
    | null
  /** Copy-pasteable (R2, R3) — `swarm doctor` prints it verbatim. */
  readonly fix: string | null
}

/** `ModelRouteInfo`, camelCased at the seam (§5.1). */
export interface ModelRoute {
  readonly model: string
  readonly provider: string
  readonly apiMethod: string
  readonly available: boolean
  readonly detail: string
}

/* ------------------------------------------------------------------------ §6.2 view models */

export interface ConnectionVM {
  readonly attempt: number
  readonly nextRetryAtMs: number | null
  readonly status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'blocked'
  readonly blockedReason: 'unauthenticated' | 'forbidden' | 'protocol' | null
  readonly serverVersion: string | null
  readonly capabilities: readonly ServerCapability[]
  readonly pendingIntents: number
  readonly queuedOffline: number
  readonly streams: readonly {
    readonly stream: StreamName
    readonly seq: number
    readonly lagged: boolean
  }[]
}

/** Nine buckets, total over state × facets (§6.2.1, F1). */
export type FleetBucket =
  | 'needs-you'
  | 'failed'
  | 'stalled'
  | 'working'
  | 'queued'
  | 'done-unlanded'
  | 'done-landed'
  | 'cancelled'
  | 'abandoned'

export interface FleetVM {
  /** Attention-sorted. */
  readonly buckets: Record<FleetBucket, readonly DelegationId[]>
  readonly counts: Record<FleetBucket, number>
  readonly dispatchPaused: boolean
  readonly concurrency: {
    readonly runningAttempts: number
    readonly cap: number
    readonly queued: number
  }
  readonly spend: SpendCounters & { readonly capUsd: number | null }
}

export interface TurnVM {
  readonly id: TurnId
  readonly attemptId: AttemptId
  readonly delivery: DeliveryState
  readonly effective: EffectiveTurnConfig
  readonly landing: 'confirmed' | 'unconfirmed' | 'n/a'
  /** The presentation MUST render it (§4.3.4). */
  readonly effortConfirmed: false
  /** True when the mode gate applied (§4.3.8). */
  readonly configInherited: boolean
  readonly elapsedMs: number
  readonly toolCalls: number
}

export interface AttemptVM {
  readonly id: AttemptId
  readonly attemptNo: number
  readonly live: boolean
  readonly channel: ChannelState
  readonly outcome: AttemptOutcome
  readonly sessionId: string | null
  readonly worktree: string | null
  readonly staleBase: boolean
  readonly nowDoing: string | null
  readonly startedAt: number
  readonly endedAt: number | null
  readonly turns: number
  readonly toolCalls: number
  readonly spend: SpendCounters
  readonly currentTurn: TurnVM | null
  readonly verification: {
    readonly runNo: number
    readonly verdict: 'pass' | 'fail' | 'indeterminate'
    readonly at: number
  } | null
  readonly evidenceRef: string | null
}

/** A5, promoted to **M** by Q9 — the reason parallel attempts are worth their slots. */
export interface AttemptComparisonVM {
  readonly attempts: readonly {
    readonly id: AttemptId
    readonly attemptNo: number
    readonly verdict: 'pass' | 'fail' | 'indeterminate' | 'unrun'
    readonly filesChanged: number
    readonly insertions: number
    readonly deletions: number
    readonly criteria: readonly {
      readonly id: string
      readonly status: CriterionStatus
    }[]
    readonly estUsd: number
    readonly durationMs: number
    readonly turns: number
    readonly toolCalls: number
  }[]
  /** Best passing attempt by (criteria, cost); **never auto-lands**. */
  readonly recommendation: AttemptId | null
}

export type CriterionStatus = 'unrun' | 'pass' | 'fail' | 'error' | 'manual'

export interface DelegationVM {
  readonly id: DelegationId
  readonly version: number
  readonly title: string
  readonly state: DelegationState
  readonly verdict: 'verified' | 'accepted' | null
  /** The same total mapping the fleet used (§6.2.1) — `bucketOf` produces both. */
  readonly bucket: FleetBucket
  readonly unverifiable: boolean
  readonly dispatchPaused: boolean
  readonly landed: boolean
  /** F2 sort key (§6.4–6.6). */
  readonly attentionScore: number
  /** W4: latest tool + target, one line. */
  readonly nowDoing: string | null
  readonly stalledForMs: number | null
  readonly staleBase: boolean
  readonly needsYou: NeedsYouReason | null
  /** Frozen copy of the record's spec — everything a composer needs locally (C7b, Q18). */
  readonly spec: DelegationSpec
  /** The cascade's middle rung, pre-resolved (§4.3.1). */
  readonly defaults: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort: ReasoningEffort | null
    readonly delivery: TurnDeliveryMode
  }
  /** What the user typed / what it resolved to (C4b). */
  readonly baseRef: string
  readonly baseRevision: string
  readonly liveAttemptIds: readonly AttemptId[]
  readonly focusedAttemptId: AttemptId | null
  readonly origin: { readonly delegationId: DelegationId; readonly attemptId: AttemptId } | null
  /** The FOCUSED attempt's turn; null with none focused. */
  readonly currentTurn: TurnVM | null
  readonly attempts: readonly AttemptVM[]
  /** Non-null once ≥2 attempts have evidence (A5). */
  readonly comparison: AttemptComparisonVM | null
  readonly budget: {
    readonly used: SpendCounters
    readonly limit: BudgetSpec
    readonly worstFraction: number
  }
  readonly acceptance: readonly {
    readonly id: string
    readonly label: string
    readonly status: CriterionStatus
  }[]
}

export interface HealthVM {
  readonly server: { readonly ok: boolean; readonly version: string; readonly uptimeMs: number }
  readonly executor: {
    readonly ok: boolean
    readonly adapterId: AdapterId
    readonly versions: Record<string, string>
    readonly blocked: PreflightReport['blocked']
    readonly fix: string | null
  }
  readonly instances: readonly {
    readonly key: InstanceKey
    readonly pgid: number | null
    readonly daemonPid: number | null
    readonly sessions: number
    /**
     * From a `ping` on the **attached** probe connection only — an unattached ping is answered
     * bridge-locally and stays green with a dead daemon ([F5], §5.3).
     */
    readonly ok: boolean
    readonly detail: string
  }[]
  /** C7's picker source, and there is no other (Q18). */
  readonly routes: readonly ModelRoute[]
  /** The `supports('permissions')` probe (R6) — approvals ship dark until it flips. */
  readonly approvalsAvailable: boolean
  readonly lastDoctorAt: number | null
}

export type NoticeKind =
  | 'doctor-blocked'
  | 'version-floor'
  | 'server-changed'
  | 'stale-queued-turn'
  | 'resumed-from-sleep'
  | 'delivery-unknown'
  | 'drift'
  | 'budget-soft'
  | 'budget-hard'
  | 'landing-conflict'
  | 'retract-cascade'
  | 'capability-absent'
  /** S8/S10/S11 — the in-product honesty surface (release gate 10). */
  | 'honesty'

export interface NoticeVM {
  readonly id: string
  readonly kind: NoticeKind
  readonly severity: 'info' | 'warn' | 'error'
  readonly title: string
  readonly detail: string
  readonly at: number
  readonly delegationId?: DelegationId
  readonly attemptId?: AttemptId
  readonly turnId?: TurnId
  readonly actions: readonly {
    readonly intent: IntentName | 'dismiss'
    readonly label: string
  }[]
  readonly dismissible: boolean
}

export type TranscriptEntry =
  | {
      readonly k: 'user'
      readonly turnId: TurnId
      readonly text: string
      readonly at: number
      readonly images: number
    }
  | { readonly k: 'text'; readonly text: string; readonly at: number }
  /** W1: reasoning is a separate channel, collapsed by default. */
  | {
      readonly k: 'reasoning'
      readonly text: string
      readonly at: number
      readonly collapsed: true
    }
  | {
      readonly k: 'tool'
      readonly callId: string
      readonly name: string
      readonly target: string | null
      readonly status: 'start' | 'exec' | 'done' | 'error'
      readonly output: string | null
      readonly durationMs: number | null
    }
  /** W11 — rendered in its own plane, never state (#16). */
  | {
      readonly k: 'background'
      readonly taskId: string
      readonly label: string
      readonly percent?: number
      readonly provenance: 'scraped'
    }
  | { readonly k: 'usage'; readonly input: number; readonly output: number }
  | { readonly k: 'notice'; readonly text: string }

export interface TranscriptVM {
  readonly attemptId: AttemptId
  readonly following: boolean
  readonly entries: readonly TranscriptEntry[]
  readonly hasOlder: boolean
  readonly lagged: boolean
}

export interface DiffVM {
  readonly attemptId: AttemptId
  readonly baseRevision: string
  readonly staleBase: boolean
  readonly files: readonly {
    readonly path: string
    readonly status: 'added' | 'modified' | 'deleted' | 'renamed'
    readonly insertions: number
    readonly deletions: number
    readonly binary: boolean
    readonly hunks:
      | readonly {
          readonly header: string
          readonly lines: readonly string[]
        }[]
      | null
  }[]
  readonly totals: {
    readonly files: number
    readonly insertions: number
    readonly deletions: number
  }
  readonly truncated: boolean
}

export interface TranscriptHandle {
  readonly vm: ReadableStore<TranscriptVM>
  follow(on: boolean): void
  loadOlder(n: number): Promise<void>
  release(): void
}

export interface DiffHandle {
  readonly vm: ReadableStore<DiffVM>
  expand(path: string, expanded: boolean): void
  refresh(): Promise<void>
  release(): void
}

/** Diagnostics only — never a control surface (§6.2). */
export interface SwarmClientInspection {
  readonly protocolVersion: 1
  readonly clientVersion: string
  readonly connection: ConnectionVM
  readonly streams: readonly {
    readonly stream: StreamName
    readonly seq: number
    readonly subscribers: number
    readonly lagged: boolean
  }[]
  readonly pending: readonly {
    readonly id: number
    readonly intent: IntentName
    readonly idempotencyKey: string
    readonly sentAt: number
  }[]
  readonly offlineQueue: readonly {
    readonly intent: IntentName
    readonly idempotencyKey: string
    readonly queuedAt: number
  }[]
  readonly handles: { readonly transcripts: number; readonly diffs: number }
  readonly counters: Record<string, number>
}

/* ------------------------------------------------------------------- §6.3 intent payloads */

export interface LandOptions {
  readonly attemptId: AttemptId
  /** `'pr'` is wave 2 (Q3). */
  readonly mode: 'commit' | 'patch'
  readonly targetBranch?: string
  readonly message?: string
  readonly outPath?: string
}

export interface DelegationDefaultsPatch {
  readonly model?: string
  readonly reasoningEffort?: ReasoningEffort | null
  readonly delivery?: TurnDeliveryMode
  readonly budget?: Partial<BudgetSpec>
  readonly priority?: number
  readonly autoResendOnStrongEvidence?: boolean
}

/**
 * `cancelSoftInterrupts(sessionId)` is the only retract primitive and is session-wide (§4.3.9),
 * so a retract names everything it un-delivered. Leaving the others' records at `sent` would be
 * swarm asserting a delivery it had itself cancelled.
 */
export interface RetractReport {
  readonly requested: TurnId
  readonly alsoRetracted: readonly TurnId[]
  readonly sessionWide: boolean
  readonly restoredTo: 'prepared' | 'deleted'
}

export interface ReconcileReport {
  readonly delegationId: DelegationId
  readonly attemptId: AttemptId
  readonly turnId: TurnId | null
  readonly outcome: 'resumed' | 'ended' | 'still-unknown' | 'resend-offered' | 'resent'
  /** The four clauses of §5.5, verbatim — the head renders them as evidence lines. */
  readonly evidence: {
    readonly ackLogged: boolean
    readonly digestInTail: boolean
    readonly workspaceMutated: boolean
    readonly toolEventsLogged: number
    readonly sessionIdle: boolean
  }
  readonly deliveryBefore: DeliveryState
  readonly deliveryAfter: DeliveryState
  readonly at: number
}

/**
 * `dispose()`, then `kill(-pgid)` on the bridge group, then `kill(-daemonPid)` on the daemon's
 * group ([F1], §5.3). `daemonStopped: false` means the agent may still be running.
 */
export interface KillOutcome {
  readonly pgid: number
  readonly daemonPid: number | null
  readonly signalled: readonly string[]
  /** Scanned in BOTH groups; a live daemon lands here. */
  readonly survivors: readonly number[]
  readonly daemonStopped: boolean
  readonly durationMs: number
}

/**
 * A brake, not a delete (Q16, #31). `delegationsTerminated` and `worktreesRemoved` are **literal
 * empty tuples**, so an implementation that terminalizes a delegation from the kill switch fails
 * to typecheck.
 */
export interface KillReport {
  readonly at: number
  readonly turnsCancelled: readonly TurnId[]
  readonly attemptsAffected: readonly AttemptId[]
  readonly instancesKilled: readonly KillOutcome[]
  readonly dispatchPausedFleetWide: true
  readonly delegationsTerminated: readonly []
  readonly worktreesRemoved: readonly []
}

export interface FleetFilter {
  readonly buckets?: readonly FleetBucket[]
  readonly workspaceIds?: readonly string[]
  readonly providers?: readonly string[]
  readonly text?: string
  readonly tags?: readonly string[]
  /** Default `'attention'` (F2). */
  readonly sort?: 'attention' | 'updated' | 'created' | 'spend'
}

/* --------------------------------------------------------------- §6.4 head-facing event map */

/**
 * The head-facing projection of the 34 wire kinds (§6.4). Payloads are **VM deltas, never wire
 * frames** (H5): a head never sees a `SwarmEvent`, an executor event or a frame.
 *
 * §6.4's prose calls this "22 keys" while the block it introduces declares **23**. The block is
 * the normative artefact — it is what §13 asserts is exported "with exactly the listed
 * signature" — so all 23 are declared here and `SWARM_CLIENT_EVENT_KEYS` carries the count as
 * data. Dropping one to satisfy the prose would delete surface the DoD requires. (Deviation D1.)
 */
export interface SwarmClientEvents {
  'delegation:create': { delegationId: DelegationId; vm: DelegationVM }
  'delegation:state': {
    delegationId: DelegationId
    state: DelegationState
    bucket: FleetBucket
    previous: DelegationState
  }
  'delegation:update': { delegationId: DelegationId; vm: DelegationVM }
  'attempt:start': { delegationId: DelegationId; attempt: AttemptVM }
  'attempt:end': { delegationId: DelegationId; attemptId: AttemptId; outcome: AttemptOutcome }
  'turn:prepared': { delegationId: DelegationId; turn: TurnVM }
  'turn:delivery': {
    delegationId: DelegationId
    turnId: TurnId
    delivery: DeliveryState
    detail: DeliveryDetail
  }
  'turn:end': { delegationId: DelegationId; turnId: TurnId; toolCalls: number }
  'turn:retracted': { delegationId: DelegationId; report: RetractReport }
  'verify:start': { delegationId: DelegationId; attemptId: AttemptId; runId: string }
  'verify:result': { delegationId: DelegationId; run: VerificationRun }
  'land:result': { delegationId: DelegationId; landing: LandingRecord }
  drift: { delegationId: DelegationId; attemptId: AttemptId; kind: string; detail: string }
  evidence: { delegationId: DelegationId; attemptId: AttemptId; evidenceRef: string }
  'needs-you': { delegationId: DelegationId; reason: NeedsYouReason; vm: DelegationVM }
  budget: { scope: 'fleet' | DelegationId; level: 'soft' | 'hard'; fraction: number }
  health: HealthVM
  notice: NoticeVM
  confirmation: ConfirmationRequest
  connection: ConnectionVM
  'stream:lagged': { stream: StreamName; fromSeq: number; reason: LagReason }
  'server-changed': { serverVersion: string; capabilities: readonly ServerCapability[] }
  error: SwarmError
}

export const SWARM_CLIENT_EVENT_KEYS = [
  'delegation:create',
  'delegation:state',
  'delegation:update',
  'attempt:start',
  'attempt:end',
  'turn:prepared',
  'turn:delivery',
  'turn:end',
  'turn:retracted',
  'verify:start',
  'verify:result',
  'land:result',
  'drift',
  'evidence',
  'needs-you',
  'budget',
  'health',
  'notice',
  'confirmation',
  'connection',
  'stream:lagged',
  'server-changed',
  'error',
] as const satisfies readonly (keyof SwarmClientEvents)[]

/* ------------------------------------------------------------ §6.1–6.3 the client surface */

/**
 * §6.3: every intent returns this and **none throws for a domain refusal** (#24). Refusals
 * (`turn_in_flight`, `budget_exhausted`, `config_not_available_in_mode`) are expected outcomes,
 * and expected outcomes that throw produce `try`/`catch` at every call site and swallowed bugs.
 */
export type IntentResult<T> =
  | { readonly ok: true; readonly value: T; readonly version: number }
  | { readonly ok: false; readonly error: SwarmError }

/**
 * The nineteen intents of §6.3 — seventeen that reach the wire and two that never do.
 *
 * Every mutating intent carries an `idempotencyKey` (generated when omitted) and an optional
 * `expectedVersion`; both ride on the `req` envelope (§2.2) and the per-intent `args` shapes are
 * declared in `src/protocol/intents.ts`.
 */
export interface SwarmClientIntents {
  createDelegation(input: CreateDelegationInput): Promise<IntentResult<DelegationId>>
  sendTurn(id: DelegationId, directive: TurnDirective): Promise<IntentResult<TurnId>>
  /** Session-wide for interrupt modes (§4.3.9) — the report names everything it un-delivered. */
  retract(turnId: TurnId): Promise<IntentResult<RetractReport>>
  cancel(
    id: DelegationId,
    options: { scope: 'turn' | 'delegation' | 'hard'; attemptId?: AttemptId },
  ): Promise<IntentResult<void>>
  retry(
    id: DelegationId,
    options?: {
      spec?: Partial<DelegationSpec>
      /** Default `spec.parallelAttempts` (Q9). */
      parallel?: 1 | 2 | 3
      injectPriorFailure?: boolean
    },
  ): Promise<IntentResult<readonly AttemptId[]>>
  branch(attemptId: AttemptId, options?: { title?: string }): Promise<IntentResult<DelegationId>>
  verify(
    id: DelegationId,
    options?: { attemptId?: AttemptId; criteria?: readonly string[] },
  ): Promise<IntentResult<string>>
  accept(
    id: DelegationId,
    options: { note: string; attemptId?: AttemptId },
  ): Promise<IntentResult<void>>
  land(id: DelegationId, options: LandOptions): Promise<IntentResult<LandingRecord>>
  discard(attemptId: AttemptId): Promise<IntentResult<void>>
  archive(id: DelegationId, options?: { abandon?: boolean }): Promise<IntentResult<void>>
  reconcile(id: DelegationId): Promise<IntentResult<ReconcileReport>>
  pauseDispatch(
    scope: { fleet: true } | { delegationId: DelegationId },
    paused: boolean,
  ): Promise<IntentResult<void>>
  /** A brake, not a delete (Q16): it never terminalizes a delegation and never touches a tree. */
  killSwitch(options: { killInstances: boolean }): Promise<IntentResult<KillReport>>
  /** Q4's delegation default is the load-bearing knob; without this it is immutable (#35). */
  updateDefaults(
    id: DelegationId,
    patch: DelegationDefaultsPatch,
    expectedVersion?: number,
  ): Promise<IntentResult<void>>
  /** The copilot write-tool gate (§6.7, Q8). */
  confirm(requestId: string): Promise<IntentResult<void>>
  deny(requestId: string, reason?: string): Promise<IntentResult<void>>
  /** Local only — a view's own selection is not fleet state, and never reaches the wire. */
  setFilter(filter: FleetFilter): void
  focus(id: DelegationId | null, attemptId?: AttemptId): void
}

/**
 * `focus` is declared **twice** by the locked spec: §6.2 gives `SwarmClient` a
 * `focus: ReadableStore<DelegationId | null>` and §6.3 gives `SwarmClientIntents` a
 * `focus(id, attemptId?): void`, while `SwarmClient extends SwarmClientIntents`. As written that
 * does not typecheck — a property cannot be both a store and a method.
 *
 * The smallest fix that keeps **both** locked declarations is a callable store: the value is a
 * function with the intent's exact signature *and* carries `get`/`subscribe`, so `client.focus(id)`
 * and `client.focus.get()` both compile and mean what §6.2 and §6.3 say they mean. Deleting
 * either declaration would delete surface §13 asserts is exported. (Client deviation C1.)
 */
export interface FocusStore extends ReadableStore<DelegationId | null> {
  (id: DelegationId | null, attemptId?: AttemptId): void
}

/**
 * §6.1. `now` is injectable so a projection pass is a pure function of its inputs; the transport
 * is injected too (H7) — the client core never constructs a WebSocket, which is what lets one
 * client serve a service worker, a CLI and a test.
 */
export interface SwarmClientOptions {
  readonly transport: SwarmTransport
  readonly clientName: string
  readonly head: HeadKind
  readonly now?: () => number
  readonly contextProviders?: readonly ContextProvider[]
  readonly onError?: (error: SwarmError) => void
}

export interface SwarmClient extends SwarmClientIntents {
  readonly connection: ReadableStore<ConnectionVM>
  readonly fleet: ReadableStore<FleetVM>
  readonly delegations: ReadableStore<ReadonlyMap<DelegationId, DelegationVM>>
  /** Both §6.2's store and §6.3's intent — see `FocusStore`. */
  readonly focus: FocusStore
  readonly health: ReadableStore<HealthVM>
  readonly notices: ReadableStore<readonly NoticeVM[]>
  /** Ref-counted: the attempt stream is subscribed on first handle, released on last. */
  transcript(attemptId: AttemptId): TranscriptHandle
  diff(attemptId: AttemptId): DiffHandle
  on<K extends keyof SwarmClientEvents>(
    key: K,
    cb: (event: SwarmClientEvents[K]) => void,
  ): Unsubscribe
  once<K extends keyof SwarmClientEvents>(
    key: K,
    cb: (event: SwarmClientEvents[K]) => void,
  ): Unsubscribe
  subscribe(cb: (key: keyof SwarmClientEvents, event: unknown) => void): Unsubscribe
  inspect(): SwarmClientInspection
  destroy(): void
}

/* ------------------------------------------------------------------- §6.7 confirmation seam */

export interface ConfirmationRequest {
  readonly requestId: string
  readonly at: number
  readonly expiresAt: number
  readonly tool: 'swarm.start' | 'swarm.followUp' | 'swarm.cancel'
  readonly requestedBy: {
    readonly kind: 'copilot'
    readonly conversationId: string
    readonly pageUrl?: string
  }
  /** One line, rendered verbatim. */
  readonly summary: string
  readonly payload:
    | CreateDelegationInput
    | { readonly delegationId: DelegationId; readonly directive: TurnDirective }
    | { readonly delegationId: DelegationId; readonly scope: 'turn' | 'delegation' }
  readonly effective: {
    readonly provider: string
    readonly model: string
    readonly reasoningEffort: ReasoningEffort | null
    readonly workspace: string
    readonly writeMode: WorkspaceSpec['writeMode']
  }
}
