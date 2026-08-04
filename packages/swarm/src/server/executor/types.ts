/**
 * `ExecutorAdapter` — the backend-neutral seam (SPEC-swarm §5.1) and the normative capability
 * matrix (§5.2).
 *
 * The seam serves **one real backend and one fake** (#27) and says so: there is no
 * `claude-agent-sdk` column and no third `AdapterId`, because §10 rules out pluggable non-jcode
 * backends as a non-goal and a capability column for a backend the product declines is a
 * contradiction that takes fifteen flags and a conformance suite with it. What the seam buys is
 * real all the same: `MockExecutor` and `executorConformance()` exist because of it, and every
 * jcode-specific wound stays in one file.
 *
 * Types only — no runtime, no `node:*` — so `./testing` can implement the interface without
 * dragging the Node adapter in behind it.
 */

import type {
  AdapterId,
  Fence,
  InstanceKey,
  ModelRoute,
  PreflightReport,
  ReasoningEffort,
} from '../../types.ts'

export type { AdapterId, PreflightReport, ModelRoute } from '../../types.ts'

export interface InstanceOptions {
  readonly jcodeHome: string
  readonly workingDir: string
  /** Explicit, never defaulted (S10): the SDK's `true` silently spends the user's subscription. */
  readonly inheritLogins: boolean
  readonly binary?: string
  /** The **WHOLE** env, not a patch (§5.3) — this is what makes S9's scrubbed child env real. */
  readonly env: Record<string, string>
  /**
   * Extra args to the **BRIDGE PROCESS ONLY**. Tool flags are inert here: the agent lives in the
   * daemon and `spawn_server` forwards only `--provider`/`--provider-profile`/`--model` to
   * `jcode serve` ([F4], §7.3). A non-empty value MUST NOT be read as a tool-authority claim.
   */
  readonly argv?: readonly string[]
  readonly startupTimeoutMs: number
  readonly cleanupTimeoutMs: number
  readonly inheritStderr: boolean
}

export interface ExecutorCapabilities {
  readonly nativeReplay: boolean
  readonly idempotentSubmit: boolean
  /** Does the ack identify *which* message? For jcode: no — it carries only `session_id`. */
  readonly submitAckCorrelates: boolean
  readonly observableEffort: boolean
  readonly observableModel: boolean
  /** Config attached to the message itself. jcode is session-sticky, so `false`. */
  readonly perTurnConfig: boolean
  readonly programmaticApprovals: boolean
  readonly perTurnToolRestriction: boolean
  readonly structuredOutput: boolean
  readonly contextOnlyMessage: boolean
  readonly softInterrupt: boolean
  readonly interruptLandingObservable: boolean
  readonly history: 'lossless' | 'text-only' | 'none'
  readonly sessionsPerConnection: number | 'many'
  readonly usageEvents: boolean
}

/** The bridge's closed set of credential provider ids ([F17], §5.3). */
export type InstanceCredentialProvider =
  | 'claude-api'
  | 'openai-api'
  | 'openrouter'
  | 'cursor'
  | 'gemini'
  | 'jcode'

export const INSTANCE_CREDENTIAL_PROVIDERS = [
  'claude-api',
  'openai-api',
  'openrouter',
  'cursor',
  'gemini',
  'jcode',
] as const satisfies readonly InstanceCredentialProvider[]

/**
 * A **deliberate subset** of the SDK's `RuntimeInfo` ([F14]), not a shape-for-shape copy. Two
 * fields are dropped on purpose: `healthy: true` is a hard-coded literal — the only real
 * liveness signal is the `ping` `getRuntimeInfo()` performs first, which §5.3 requires on an
 * **attached** connection — and `sessionId` names the probe session, an artefact of the topology
 * rather than instance state. `provider`/`model`/`routes` are served from the bridge's cache
 * with no daemon round trip, so they are as fresh as the last attach and are never a health check.
 */
export interface ExecutorRuntimeInfo {
  readonly server: string
  readonly protocolVersion: number
  readonly capabilities: readonly string[]
  readonly provider?: string
  readonly model?: string
  readonly providers: readonly string[]
  readonly routes: readonly ModelRoute[]
}

export interface ExecutorSessionInfo {
  readonly sessionId: string
  readonly workingDir?: string
  readonly title?: string
  /** `SessionInfo.status` is untyped and **lies** (#18) — hence `trusted: false` beside it. */
  readonly status: string
  readonly trusted: false
  readonly transcriptBytes?: number
  readonly archived: boolean
  readonly archivedAtMs?: number
}

export interface KillOutcomeReport {
  readonly pgid: number
  readonly daemonPid: number | null
  readonly signalled: readonly string[]
  readonly survivors: readonly number[]
  readonly daemonStopped: boolean
  readonly durationMs: number
}

export interface StructuredResult<T> {
  readonly value: T | null
  readonly attempts: number
  /** Every response, valid or not — stored as evidence. */
  readonly raw: readonly string[]
  readonly failed: boolean
  readonly error?: { readonly code: string; readonly message: string }
}

export interface SessionConfigPatch {
  readonly model?: string
  readonly reasoningEffort?: ReasoningEffort | null
}

export interface ConfigApplyReport {
  readonly applied: readonly ('model' | 'reasoningEffort')[]
  /** jcode: **never** `'reasoningEffort'` — the bridge discards the daemon's applied value. */
  readonly confirmed: readonly ('model' | 'reasoningEffort')[]
  readonly refused: readonly { readonly field: string; readonly reason: string }[]
}

export interface ExecutorSubmission {
  readonly text: string
  readonly contextOnly?: boolean
  readonly awaitAckMs?: number
  readonly images?: readonly (readonly [string, string])[]
}

/**
 * `ack` is derived from a `message_accepted{session_id}` **observed on the session's own
 * `events()` stream** within `awaitAckMs`, NEVER from `sendMessage` returning ([F2]): the SDK's
 * `waitForAccept:true` resolves on timeout, so the call cannot distinguish `accepted` from
 * `unknown`. `correlated` is always `false` for jcode — the ack carries no content and no index.
 */
export interface SubmitReceipt {
  readonly ack: 'accepted' | 'unknown'
  readonly ackAtMs: number | null
  readonly correlated: boolean
}

export type ExecutorEvent =
  | { readonly k: 'text' | 'reasoning'; readonly text: string }
  | { readonly k: 'reasoning_done'; readonly durationSecs?: number }
  | { readonly k: 'tool_start' | 'tool_exec'; readonly callId: string; readonly name: string }
  /**
   * [F11]: the bridge was verified to hard-code `call_id: String::new()` for `tool_input_delta`
   * while the other three tool events carry a real id. Protocol v1 types the field as a plain
   * `string`, and whether 0.67.0 still empties it is unreachable without a model turn, so the
   * adapter keeps the mitigation unconditionally: an **empty** wire `call_id` is attributed to the
   * most recent `tool_start` on that session, a non-empty one is taken at face value. A consumer
   * MUST NOT key input buffers by the raw wire value, or every concurrent tool's argument stream
   * merges into one bucket.
   */
  | { readonly k: 'tool_input'; readonly callId: string; readonly delta: string }
  | {
      readonly k: 'tool_done'
      readonly callId: string
      readonly name: string
      readonly output: string
      readonly error?: string
    }
  | {
      readonly k: 'usage'
      readonly input: number
      readonly output: number
      readonly cacheReadInput?: number
    }
  | { readonly k: 'accepted' }
  | { readonly k: 'turn_done' }
  | { readonly k: 'closed'; readonly reason: string }
  | {
      readonly k: 'background'
      readonly taskId: string
      readonly label: string
      readonly percent?: number
      readonly summary: string
      /**
       * `'native'` on protocol v1: `background_progress` is a first-class event carrying
       * `task_id`, `label`, `percent` and `summary`, so [B7]'s markdown-header scrape of a
       * `notification` body describes a bridge that no longer exists — there is no `notification`
       * event kind on jcode 0.67.0. `'scraped'` is retained for any backend that must
       * reverse-engineer the signal, and either value MUST NOT feed state, budget or completion:
       * a progress report is not a turn.
       */
      readonly provenance: 'native' | 'scraped'
      /** Native only: the task reported itself finished. */
      readonly done?: boolean
    }
  | {
      readonly k: 'model_info'
      readonly provider?: string
      readonly model?: string
      /**
       * jcode 0.67.0's `model_info` carries **no** `solicited` field, so this is `false` for every
       * jcode event: a broadcast cannot be told from an answer. It stays in the union because a
       * backend that can distinguish the two owes the distinction.
       */
      readonly solicited: boolean
    }
  /** Never feeds a state machine (#18). */
  | { readonly k: 'session_status'; readonly status: string; readonly trusted: false }
  | { readonly k: 'error'; readonly code: string; readonly message: string }

export interface ExecutorSessionHandle {
  readonly sessionId: string
  /** Hot stream. The server MUST drain it **without awaiting head IO** (X7). */
  events(): AsyncIterableIterator<ExecutorEvent>
  applyConfig(patch: SessionConfigPatch, fence: Fence): Promise<ConfigApplyReport>
  submit(msg: ExecutorSubmission, fence: Fence): Promise<SubmitReceipt>
  interrupt(
    kind: 'soft' | 'urgent' | 'cancel' | 'retract',
    content: string | null,
    fence: Fence,
  ): Promise<void>
  structured<T>(
    msg: ExecutorSubmission,
    schema: unknown,
    maxRetries: number,
    fence: Fence,
  ): Promise<StructuredResult<T>>
  /**
   * Pinned normatively to `peekSession`, **never** `getHistory` ([F8], #45): `getHistory` does
   * `content.as_str().unwrap_or("")` with no flattening, so a block-array message comes back as
   * `""` — and §5.5's digest match against `""` makes every `unknown` turn look un-landed, the
   * one direction Q5 says must never auto-act. Used **only** for prompt-digest matching.
   */
  tail(limit: number): Promise<{ role: string; content: string }[]>
  rename(title: string | null): Promise<void>
  archive(): Promise<void>
  /** The **only** lease release (§5.4 #9). `detachSession` is a verified no-op and never called. */
  close(reason: string): Promise<void>
}

export interface ExecutorInstance {
  readonly key: InstanceKey
  readonly adapterId: AdapterId
  /** The swarm-created **BRIDGE** group; `null` ⇒ no hard kill is available. */
  readonly pgid: number | null
  /** The `setsid()` daemon, resolved from `servers.json` ([F1]). */
  readonly daemonPid: number | null
  runtimeInfo(): Promise<ExecutorRuntimeInfo>
  createSession(req: { workingDir: string; title?: string }): Promise<ExecutorSessionHandle>
  openSession(sessionId: string): Promise<ExecutorSessionHandle>
  /**
   * A **disk inventory**, not a live-session list ([F16]): the bridge merges every persisted
   * record under `JCODE_HOME` with its own snapshot, so short-lived and stray sessions appear
   * here. Swarm's own attempt records are authoritative for the fleet; this is used for GC only.
   */
  listSessions(): Promise<ExecutorSessionInfo[]>
  /** Instance-global (R10) — which is why credentials are a pool dimension of `InstanceKey`. */
  setCredential(provider: InstanceCredentialProvider, apiKey: string): Promise<void>
  dispose(reason: string): Promise<void>
  /**
   * `dispose()`, then `kill(-pgid)` on the bridge group, then `kill(-daemonPid)` on the daemon
   * group. Rejects `capability_absent` when `pgid === null` (§4.3.7) — it never falls back to
   * another target, because signalling a group swarm did not create is swarm killing itself
   * while the agent it meant to stop keeps running.
   */
  hardKill(reason: string): Promise<KillOutcomeReport>
}

export interface ExecutorAdapter {
  readonly id: AdapterId
  readonly capabilities: ExecutorCapabilities
  preflight(): Promise<PreflightReport>
  acquireInstance(key: InstanceKey, opts: InstanceOptions): Promise<ExecutorInstance>
}

/**
 * §5.2, the `jcode` column. **Every `false` here is a mitigation obligation** discharged in
 * §5.4, and `executorConformance()` asserts declared capabilities against observed behaviour, so
 * an adapter that lies about one of them fails CI rather than production.
 */
export const JCODE_CAPABILITIES: ExecutorCapabilities = {
  nativeReplay: false,
  idempotentSubmit: false,
  submitAckCorrelates: false,
  observableEffort: false,
  /** `setModel` broadcasts `model_info` to every attached client — the one observable of the two. */
  observableModel: true,
  perTurnConfig: false,
  programmaticApprovals: false,
  /** And *no* tool restriction at any scope on this topology, per turn or per instance ([F4]). */
  perTurnToolRestriction: false,
  structuredOutput: true,
  contextOnlyMessage: true,
  softInterrupt: true,
  interruptLandingObservable: false,
  /** Only via `peekSession`; `getHistory` is effectively `'none'` for block-array messages ([F8]). */
  history: 'text-only',
  sessionsPerConnection: 1,
  usageEvents: true,
}
