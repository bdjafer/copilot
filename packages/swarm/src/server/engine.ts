/**
 * The orchestration core (SPEC-swarm §3.3, §4.2, §4.3, §5.5, §7.1, §8).
 *
 * **Server-as-scheduler** (H8, Q7, decision log #2): the fleet progresses with no head attached,
 * so every policy decision — admission, budgets, leases, verification, landing, reconciliation —
 * is taken here and a head only projects it. Any policy in the head makes closing a tab a
 * scheduling event.
 *
 * Four invariants are structural rather than documented:
 *
 *  - **persist → emit → reply** (§3.5, X2). Every intent runs inside one `store.commit`, whose
 *    `onCommit` listeners fire before it returns, so a `res` written from the return value is
 *    written after the disk and after the fan-out, by construction.
 *  - **the executor pump never awaits head IO** (X7). `handleExecutorEvent` commits synchronously
 *    and returns; verification, dispatch of the next queued turn and reconciliation are all
 *    started with `void`, never awaited inside the drain.
 *  - **execution belongs to the attempt** (Q9, #29). Delegation state is a **rollup** over live
 *    attempt phases, so one attempt reaching `needs-you` shows the delegation as `needs-you` while
 *    its siblings keep running — which is correct, because the user *is* needed.
 *  - **the in-flight turn is never cancelled by a budget** (Q11). A hard breach sets
 *    `dispatchPaused` and refuses *new* turns; only a `TurnBudget` cancels, and only its own turn.
 *
 * Node ≥ 24, server-only.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ulid } from 'ulid'

import type { LogRecord, ReadTx, SwarmStore, WriteTx } from '../log/types.ts'
import type { SwarmEvent } from '../protocol/events.ts'
import type { StreamName } from '../protocol/frames.ts'
import type { IntentArgs } from '../protocol/intents.ts'
import type {
  AttemptSnapshot,
  DelegationSnapshot,
  FleetSnapshot,
  ServerSnapshot,
} from '../protocol/snapshots.ts'
import type {
  ActorRef,
  AttemptId,
  AttemptRecord,
  AttemptOutcome,
  CreateDelegationInput,
  DelegationDefaultsPatch,
  DelegationId,
  DelegationRecord,
  DelegationSpec,
  DelegationState,
  DeliveryState,
  EffectiveTurnConfig,
  Fence,
  HealthVM,
  InstanceKey,
  KillReport,
  LandOptions,
  NeedsYouReason,
  NoticeVM,
  ReasoningEffort,
  ReconcileReport,
  RetractReport,
  TranscriptEntry,
  TurnDirective,
  TurnId,
  TurnRecord,
  VerificationRun,
  Verifier,
} from '../types.ts'
import type { SwarmServerConfig, SwarmHomeLayout } from './config.ts'
import type {
  ExecutorAdapter,
  ExecutorEvent,
  ExecutorInstance,
  ExecutorSessionHandle,
  KillOutcomeReport,
} from './executor/types.ts'
import type { AttemptRuntime, DelegationMeta } from './projections.ts'
import type { ReconcileEvidence } from './reconcile.ts'
import type { JudgeSession } from './review.ts'
import type { AdmissionCandidate, AdmissionState } from './scheduler.ts'
import type { ReviewRunner } from './verifier.ts'
import type { WorkspaceGuard } from './workspace.ts'

import {
  addSpend,
  classifyBudget,
  classifyClockGap,
  emptySpendCounters,
  turnBudgetBreached,
} from '../domain/budget.ts'
import {
  CHANNEL_RECONNECT,
  CHANNEL_TIMEOUTS,
  LEASES,
  SERVER_POLICY,
  SERVER_RETENTION,
} from '../domain/constants.ts'
import {
  effectiveTurnConfig,
  modeAllowsConfig,
  reconciliationTarget,
  validateTurnDirective,
} from '../domain/directive.ts'
import {
  delegationLease,
  homeLease,
  leaseStatus,
  sessionLease,
  worktreeLease,
} from '../domain/leases.ts'
import { channelMachine, delegationMachine, deliveryMachine } from '../domain/machines.ts'
import { bucketOf, rollupDelegationState } from '../domain/rollup.ts'
import { SwarmError, swarmErrorFromWire } from '../errors.ts'
import { attemptStream, delegationStream } from '../protocol/codec.ts'
import { ConfirmationRegistry } from './confirm.ts'
import { assertEffortAllowed } from './executor/jcode.ts'
import {
  attemptVM,
  delegationVM,
  emptyRuntime,
  fleetVM,
  readAttempt,
  readDelegation,
  readMeta,
  readTurn,
  turnVM,
} from './projections.ts'
import { decideReconciliation, digestPresentInTail } from './reconcile.ts'
import { createReviewRunner } from './review.ts'
import { admissionDecision, orderCandidates, withAdmitted } from './scheduler.ts'
import {
  createVerifier,
  hasMachineCheckableCriterion,
  verdictOf,
  writeEvidenceBundle,
} from './verifier.ts'
import {
  assertPathInsideRoot,
  baseHasMoved,
  runGit,
  createWorktree,
  diffAgainstBase,
  headRevision,
  isDirty,
  land,
  porcelainStatus,
  removeWorktree,
  resolveBaseRevision,
  scrubbedEnv,
} from './workspace.ts'

/* ------------------------------------------------------------------------------------ types */

export type IntentResult<T> =
  | { readonly ok: true; readonly value: T; readonly version: number }
  | { readonly ok: false; readonly error: SwarmError }

export interface IntentContext {
  readonly actor: ActorRef
  readonly tokenId: string
  readonly idempotencyKey: string
  readonly expectedVersion?: number
}

/** The six live phases a rollup may see, plus the terminal a finished attempt contributes. */
export interface AttemptMeta {
  readonly phase: DelegationState
  readonly terminal: DelegationState | null
  readonly queuedAt: number
  readonly repoRoot: string
  readonly workspaceId: string
  readonly providerModel: string
  readonly instanceKey: InstanceKey
  /** Durable queue of `after-turn`/`context-only` turns waiting for `ChannelState === 'idle'`. */
  readonly pendingTurns: readonly TurnId[]
  readonly siblingIndex: number
  readonly reconnectTries: number
}

interface LiveAttempt extends AttemptRuntime {
  session: ExecutorSessionHandle | null
  instance: ExecutorInstance | null
  fence: Fence | null
  /** Declared shadow of the session config; invalidated on reconnect and on `model_info` (§4.2). */
  shadow: { model: string | null; effort: ReasoningEffort | null | undefined }
  toolInputs: Map<string, string>
  turnStartedAt: number
  dispatching: boolean
  /** When the last interrupt was written, or `null` — C9's clock and C11's guard. */
  interruptAt: number | null
  /** `true` while `reconnectChannel` owns the ladder, so two disconnects cannot race it (C13). */
  reconnecting: boolean
}

export interface SwarmEngineOptions {
  readonly store: SwarmStore
  readonly config: SwarmServerConfig
  readonly adapter: ExecutorAdapter
  readonly guard: WorkspaceGuard
  readonly layout: SwarmHomeLayout
  readonly version: string
  readonly bootId: string
  readonly verifier?: Verifier
  readonly now?: () => number
  readonly mono?: () => number
  readonly ids?: () => string
  readonly sleep?: (ms: number) => Promise<void>
  /** `false` in tests: the scheduler is then driven by explicit `tick()` calls. */
  readonly autoTick?: boolean
  /**
   * The only source of `SpendCounters.estUsd`. **There is no default** and none is invented: the
   * spec names no price table and no provider surface carries one, so a hard-coded rate would be
   * a number the user could not audit driving a cap that stops their work. Absent, `maxSpendUsd`
   * and `caps.hardSpendUsd` raise `notice{kind:'capability-absent'}` instead of silently reading
   * as "never breached" (S8).
   */
  readonly estimateTurnCostUsd?: (input: {
    readonly provider: string
    readonly model: string
    readonly inputTokens: number
    readonly outputTokens: number
  }) => number
  /** §8.2's judge. Absent ⇒ a `review` criterion is `error` ⇒ `indeterminate`, never `fail`. */
  readonly review?: ReviewRunner
}

/** The durable row behind `dispatchPausedFleet` (§3.5). One record, one field, one reason. */
interface ServerFlags {
  readonly dispatchPausedFleet: boolean
}

const serverStream: StreamName = 'server'
const fleetStream: StreamName = 'fleet'

function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/* ----------------------------------------------------------------------------------- engine */

export class SwarmEngine {
  readonly store: SwarmStore
  readonly config: SwarmServerConfig
  readonly confirmations: ConfirmationRegistry
  private readonly adapter: ExecutorAdapter
  private readonly guard: WorkspaceGuard
  private readonly layout: SwarmHomeLayout
  private readonly verifier: Verifier
  private readonly live = new Map<AttemptId, LiveAttempt>()
  private readonly notices: NoticeVM[] = []
  private readonly instances = new Map<InstanceKey, ExecutorInstance>()
  /**
   * A **cache of a durable row**, never the source of truth (§3.5's write ordering, Q16). A
   * fleet pause that lived only in memory came back running after a restart — the one moment at
   * which the user has already decided the fleet must not run.
   */
  private dispatchPausedFleet = false
  private lastSample: { wall: number; mono: number }
  private healthCache: HealthVM | null = null
  private ticking = false
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false
  /** X16: no mutating intent is accepted while a wake-up reconciliation is running. */
  private reconciling: Promise<void> | null = null
  /**
   * §2.5 rule 3: a reconnect re-sends every in-flight `req` with the same key **while the first
   * may still be executing**, and the durable cache is only written after. Two `cancel`s, two
   * `verify`s, two dispatched turns. This map collapses the resend onto the one execution.
   */
  private readonly inFlight = new Map<string, Promise<IntentResult<unknown>>>()
  /** §7.4's three fabricated metrics, counted where they actually happen. */
  private readonly observed = {
    leaseConflicts: 0,
    logWriteMs: 0,
    executorEvents: {} as Record<string, number>,
  }
  /** Raised once: a spend cap with nothing to price a turn is a gate that does not gate (S8). */
  private spendOracleWarned = false
  readonly startedAt: number

  readonly now: () => number
  readonly mono: () => number
  private readonly ids: () => string
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: SwarmEngineOptions) {
    this.store = options.store
    this.config = options.config
    this.adapter = options.adapter
    this.guard = options.guard
    this.layout = options.layout
    this.now = options.now ?? Date.now
    this.mono = options.mono ?? (() => performance.now())
    this.ids = options.ids ?? (() => ulid())
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms).unref?.()))
    this.startedAt = this.now()
    this.lastSample = { wall: this.now(), mono: this.mono() }
    this.confirmations = new ConfirmationRegistry({
      now: this.now,
      ttlMs: options.config.timeouts.confirmationTtlMs,
      onRequest: (request) => {
        this.commitPlain('server.confirmation', (tx) => {
          this.emit(
            tx,
            serverStream,
            { k: 'server.confirmation', request },
            this.serverActor('confirmation requested'),
          )
        })
      },
      onResolved: (requestId, decision) => {
        this.commitPlain('server.confirmation_resolved', (tx) => {
          this.emit(
            tx,
            serverStream,
            { k: 'server.confirmation_resolved', requestId, decision },
            this.serverActor('confirmation resolved'),
          )
        })
      },
    })
    this.verifier =
      options.verifier ??
      createVerifier({
        evidenceRoot: options.layout.evidenceDir,
        now: this.now,
        ids: this.ids,
        /* §8.1 and §13's second door: the allowlist is re-run on **every** verifier run, against
         * the resolved path. A worktree the agent symlinked out of would otherwise run acceptance
         * commands — agent-influenced code — anywhere on disk. */
        assertWorkspace: (cwd) => this.assertRunnableCwd(cwd),
        /* §8.2's judge, on its own session and its own read-only clone. Injected rather than
         * built here so the isolation stays the property under test. */
        review:
          options.review ??
          createReviewRunner({
            evidenceRoot: options.layout.evidenceDir,
            ids: this.ids,
            openJudge: (input) => this.openJudgeSession(input),
          }),
      })
    /* Q16 and §3.5: rehydrated before the first tick, so a restart cannot un-pause a fleet. */
    this.dispatchPausedFleet =
      this.store.read((tx) => tx.getRecord<ServerFlags>('server_flags', 'dispatch')?.value)
        ?.dispatchPausedFleet ?? false
    if (options.autoTick !== false) {
      this.timer = setInterval(() => {
        void this.tick()
        this.sampleClock()
        this.renewLeases()
        this.applyRetention()
      }, 1_000)
      this.timer.unref?.()
    }
  }

  /** §7.4's counters, read by `/metrics`. */
  metrics(): {
    readonly leaseConflicts: number
    readonly logWriteMs: number
    readonly executorEvents: Readonly<Record<string, number>>
  } {
    return this.observed
  }

  /* ------------------------------------------------------------------------- small helpers */

  /**
   * The two places a swarm-spawned child may legitimately run: a per-attempt worktree under
   * `$SWARM_HOME/worktrees` (§7.2) or a registered root, for `in-place`. Re-resolved on every
   * call, which is the whole of S6 — never once at registration.
   */
  assertRunnableCwd(cwd: string): string {
    return this.guard.assertInsideAny(
      [this.layout.worktreesDir, ...this.guard.list().map((row) => row.root)],
      cwd,
    )
  }

  serverActor(reason: string): ActorRef {
    return { kind: 'server', reason }
  }

  private emit(
    tx: WriteTx,
    stream: StreamName,
    ev: SwarmEvent,
    actor: ActorRef,
    ids: {
      delegationId?: DelegationId
      attemptId?: AttemptId
      turnId?: TurnId
      correlationId?: string
    } = {},
  ): LogRecord {
    return tx.appendLog({
      stream,
      ev,
      actor,
      ...(ids.delegationId === undefined ? {} : { delegationId: ids.delegationId }),
      ...(ids.attemptId === undefined ? {} : { attemptId: ids.attemptId }),
      ...(ids.turnId === undefined ? {} : { turnId: ids.turnId }),
      ...(ids.correlationId === undefined ? {} : { correlationId: ids.correlationId }),
    })
  }

  /** A commit with no audit row — executor observations, not intents. */
  private commitPlain<T>(reason: string, fn: (tx: WriteTx) => T): T {
    void reason
    if (this.closed) return undefined as T
    return this.store.commit(fn).value
  }

  private projectionContext(tx: ReadTx): Parameters<typeof delegationVM>[2] {
    const runtime = new Map<AttemptId, AttemptRuntime>()
    for (const [id, state] of this.live) runtime.set(id, state)
    return {
      now: this.now(),
      runtime,
      capUsd: this.config.caps.hardSpendUsd,
      concurrency: this.concurrency(tx),
      dispatchPaused: this.dispatchPausedFleet,
    }
  }

  private concurrency(tx: ReadTx): { runningAttempts: number; cap: number; queued: number } {
    let running = 0
    let queued = 0
    for (const stored of tx.listRecords<DelegationRecord>('delegation')) {
      running += stored.value.liveAttempts.length
      if (stored.value.state === 'queued') queued += 1
    }
    return { runningAttempts: running, cap: this.config.caps.globalConcurrency, queued }
  }

  private attemptMeta(tx: ReadTx, id: AttemptId): AttemptMeta | null {
    return tx.getRecord<AttemptMeta>('attempt_meta', id)?.value ?? null
  }

  private putAttemptMeta(tx: WriteTx, id: AttemptId, meta: AttemptMeta): void {
    tx.putRecord('attempt_meta', id, 1, meta)
  }

  private putDelegation(tx: WriteTx, record: DelegationRecord): DelegationRecord {
    const next: DelegationRecord = { ...record, updatedAt: this.now() }
    tx.putRecord('delegation', next.id, next.version, next)
    return next
  }

  private putAttempt(tx: WriteTx, record: AttemptRecord): AttemptRecord {
    tx.putRecord('attempt', record.id, 1, record)
    return record
  }

  private putTurn(tx: WriteTx, record: TurnRecord): TurnRecord {
    tx.putRecord('turn', record.id, 1, record)
    return record
  }

  private requireDelegation(tx: ReadTx, id: DelegationId): DelegationRecord {
    const record = readDelegation(tx, id)
    if (record === null) throw new SwarmError('not_found', `no delegation ${id}`)
    return record
  }

  private requireAttempt(tx: ReadTx, id: AttemptId): AttemptRecord {
    const record = readAttempt(tx, id)
    if (record === null) throw new SwarmError('not_found', `no attempt ${id}`)
    return record
  }

  private runtimeOf(attemptId: AttemptId): LiveAttempt {
    let state = this.live.get(attemptId)
    if (state === undefined) {
      state = {
        ...emptyRuntime(this.now()),
        session: null,
        instance: null,
        fence: null,
        shadow: { model: null, effort: undefined },
        toolInputs: new Map(),
        turnStartedAt: this.now(),
        dispatching: false,
        interruptAt: null,
        reconnecting: false,
      }
      this.live.set(attemptId, state)
    }
    return state
  }

  /* ------------------------------------------------------------------- state machine plumbing */

  /**
   * The delegation state is a **rollup** over live attempt phases (§3.3, Q9): a terminal state is
   * reachable only when `liveAttempts` is empty. Emitting `fleet.delegation_state` here — and only
   * here — is what makes the bucket on the row and the bucket in the list the same value.
   */
  private refreshDelegationState(
    tx: WriteTx,
    id: DelegationId,
    actor: ActorRef,
    forcedTerminal?: DelegationState,
  ): DelegationRecord {
    let record = this.requireDelegation(tx, id)
    const previous = record.state
    let next: DelegationState = previous

    if (forcedTerminal !== undefined) {
      next = forcedTerminal
    } else if (record.liveAttempts.length > 0) {
      const phases = record.liveAttempts
        .map((attemptId) => this.attemptMeta(tx, attemptId)?.phase)
        .filter((phase): phase is DelegationState => phase !== undefined)
      next = rollupDelegationState(phases) ?? previous
    } else if (
      !delegationMachine.isTerminal(previous) &&
      /* **`queued` is never rolled up.** A delegation with no live attempts and every past attempt
       * terminal is normally finished — but `queued` means work is *pending*: it is where D1 starts
       * and, decisively, where D19 lands a reopen (`retry`, or a late follow-up `sendTurn`), which
       * clears `verdict` in the same transaction. Rolling that back to `succeeded` on the next
       * refresh would restore the state and leave the verdict cleared, breaking §3.1's
       * "`verdict` is set iff `state === 'succeeded'`" — and it would silently swallow the reopen. */
      previous !== 'queued' &&
      record.attempts.length > 0
    ) {
      const terminals = record.attempts
        .map((attemptId) => this.attemptMeta(tx, attemptId)?.terminal)
        .filter((state): state is DelegationState => state !== undefined && state !== null)
      if (terminals.includes('succeeded')) next = 'succeeded'
      else if (terminals.length > 0) next = terminals.includes('failed') ? 'failed' : terminals[0]!
    }

    if (next === previous) return record
    record = this.putDelegation(tx, { ...record, state: next, version: record.version + 1 })
    this.emit(
      tx,
      fleetStream,
      {
        k: 'fleet.delegation_state',
        delegationId: record.id,
        state: record.state,
        bucket: bucketOf({
          state: record.state,
          stalledForMs: null,
          landed: record.landed !== null,
        }),
        version: record.version,
      },
      actor,
      { delegationId: record.id },
    )
    this.emitSummary(tx, record.id, actor)
    return record
  }

  private emitSummary(tx: WriteTx, id: DelegationId, actor: ActorRef): void {
    const record = readDelegation(tx, id)
    if (record === null) return
    this.emit(
      tx,
      fleetStream,
      {
        k: 'fleet.delegation_summary',
        delegation: delegationVM(tx, record, this.projectionContext(tx)),
      },
      actor,
      { delegationId: id },
    )
  }

  /** Move an attempt's phase through the delegation machine, naming the spec row that did it. */
  private movePhase(
    tx: WriteTx,
    attemptId: AttemptId,
    trigger: Parameters<typeof delegationMachine.transition>[1],
    options?: { to?: DelegationState },
  ): string | null {
    const meta = this.attemptMeta(tx, attemptId)
    if (meta === null) return null
    const outcome = delegationMachine.transition(meta.phase, trigger, options)
    if (!outcome.ok || outcome.state === null) return null
    this.putAttemptMeta(tx, attemptId, { ...meta, phase: outcome.state })
    return outcome.rowId
  }

  private moveChannel(
    tx: WriteTx,
    attempt: AttemptRecord,
    trigger: Parameters<typeof channelMachine.transition>[1],
    actor: ActorRef,
  ): AttemptRecord {
    const outcome = channelMachine.transition(attempt.channel, trigger)
    if (!outcome.ok || outcome.state === null || outcome.state === attempt.channel) return attempt
    const next = this.putAttempt(tx, { ...attempt, channel: outcome.state })
    this.emit(
      tx,
      delegationStream(attempt.delegationId),
      { k: 'deleg.channel', attemptId: attempt.id, channel: next.channel },
      actor,
      { delegationId: attempt.delegationId, attemptId: attempt.id },
    )
    return next
  }

  /* --------------------------------------------------------------- C9/C11 the interrupt window */

  /**
   * **C9 → C11.** `interrupt_issued` fires the moment swarm writes a `cancel` or a `softInterrupt`;
   * three seconds later, if deltas are *still* arriving and no `turn_done` has been seen, the
   * interrupt **merged into the turn** and the channel returns to `streaming` (C11).
   *
   * The guard is deliberately "did the stream keep producing", not "did time pass": jcode never
   * translates `soft_interrupt_injected` (§5.4 #10), so landing is unobservable, and three seconds
   * of *silence* is a turn that ended where swarm could not see it — a different fact, and one
   * C10/C12 already describe. Reporting it as a merge would invent an observation.
   */
  private issueInterrupt(attemptId: AttemptId, actor: ActorRef): void {
    const issuedAt = this.now()
    this.commitPlain('interrupt_issued', (tx) => {
      const attempt = readAttempt(tx, attemptId)
      if (attempt !== null) this.moveChannel(tx, attempt, 'interrupt_issued', actor)
    })
    const runtime = this.runtimeOf(attemptId)
    runtime.interruptAt = issuedAt
    void this.sleep(CHANNEL_TIMEOUTS.interruptMergeMs).then(() => {
      if (this.closed) return
      const live = this.live.get(attemptId)
      /* A later interrupt, a `turn_done` or a disconnect all clear the stamp; this timer then
       * belongs to a window that has already closed. */
      if (live === undefined || live.interruptAt !== issuedAt) return
      if (live.lastEventAt <= issuedAt) return
      live.interruptAt = null
      this.commitPlain('interrupt_merged', (tx) => {
        const attempt = readAttempt(tx, attemptId)
        if (attempt === null) return
        this.moveChannel(
          tx,
          attempt,
          'interrupt_merged',
          this.serverActor('interrupt merged into the turn'),
        )
      })
    })
  }

  /* -------------------------------------------------------------- C13/C14 the reconnect ladder */

  /**
   * **C13 → C2, or C13 → C3 → … → C14.** The supervised reconnect: 500 ms ×2 capped at 30 s, eight
   * tries (§3.3 C13). Exhaustion reaches `closed` (C14) and releases the writer lease, because a
   * channel that can never be reattached is a lease that would otherwise be held forever by a
   * session nobody can reach — and `close()` is the only release there is (§5.4 #9).
   *
   * The shadow of model/effort is **invalidated** on every reattach (§4.2): the session may have
   * been re-created, and a shadow that survives a reconnect is how the next turn skips the
   * `setModel` it needed.
   */
  async reconnectChannel(attemptId: AttemptId): Promise<'reattached' | 'exhausted' | 'skipped'> {
    const runtime = this.live.get(attemptId)
    if (runtime === undefined || runtime.reconnecting) return 'skipped'
    const setup = this.store.read((tx) => {
      const attempt = readAttempt(tx, attemptId)
      if (attempt === null || attempt.channel !== 'disconnected') return null
      if (attempt.outcome !== 'open' && attempt.outcome !== 'interrupted') return null
      return { sessionId: attempt.executor.sessionId, delegationId: attempt.delegationId }
    })
    const instance = runtime.instance
    if (setup === null || instance === null || setup.sessionId === null) return 'skipped'

    runtime.reconnecting = true
    try {
      for (let tries = 0; tries < CHANNEL_RECONNECT.maxTries; tries++) {
        if (this.closed) return 'skipped'
        await this.sleep(
          Math.min(
            CHANNEL_RECONNECT.capMs,
            CHANNEL_RECONNECT.baseMs * CHANNEL_RECONNECT.factor ** tries,
          ),
        )
        this.commitPlain('channel_reconnect', (tx) => {
          const attempt = readAttempt(tx, attemptId)
          if (attempt === null) return
          this.moveChannel(tx, attempt, 'reconnect', this.serverActor('channel supervisor'))
          const meta = this.attemptMeta(tx, attemptId)
          if (meta !== null) {
            this.putAttemptMeta(tx, attemptId, { ...meta, reconnectTries: tries + 1 })
          }
        })

        let session: ExecutorSessionHandle
        try {
          session = await instance.openSession(setup.sessionId)
        } catch {
          /* C3: a socket error or the 10 s attach deadline. The ladder keeps its budget. */
          this.commitPlain('channel_attach_failed', (tx) => {
            const attempt = readAttempt(tx, attemptId)
            if (attempt !== null) {
              this.moveChannel(tx, attempt, 'attach_failed', this.serverActor('channel supervisor'))
            }
          })
          continue
        }

        const fence = this.store.commit((tx) => {
          const lease = tx.acquireLease(
            sessionLease(session.sessionId),
            attemptId,
            LEASES.sessionTtlMs,
          )
          if (lease === null) return null
          const attempt = readAttempt(tx, attemptId)
          if (attempt !== null) {
            /* C2: `attached`, writer lease held with a NEW fence — the old one is now stale, which
             * is exactly what `stale_fence` refuses for a writer that did not notice the handover. */
            this.moveChannel(tx, attempt, 'attached', this.serverActor('channel supervisor'))
          }
          return { key: lease.key, token: lease.token }
        }).value
        if (fence === null) {
          await session.close('lease held by another writer').catch(() => undefined)
          continue
        }

        runtime.session = session
        runtime.fence = fence
        /* §4.2: the shadow is invalidated on reconnect, forcing a re-assert before the next send. */
        runtime.shadow = { model: null, effort: undefined }
        void this.pump(attemptId, session)
        void this.dispatchQueue(attemptId)
        return 'reattached'
      }

      /* C14: the budget is spent. `closed` is the only honest terminal for a channel that cannot
       * be reached again, and it is where the lease goes back. */
      this.commitPlain('channel_reconnect_exhausted', (tx) => {
        const attempt = readAttempt(tx, attemptId)
        if (attempt === null) return
        this.moveChannel(
          tx,
          attempt,
          'reconnect_exhausted',
          this.serverActor('reconnect budget exhausted'),
        )
        tx.releaseLease(sessionLease(setup.sessionId ?? ''), attemptId)
      })
      runtime.session = null
      runtime.fence = null
      this.notice({
        kind: 'capability-absent',
        severity: 'error',
        title: 'The executor channel could not be reattached',
        detail: `${CHANNEL_RECONNECT.maxTries} reconnect attempts failed; the attempt is interrupted and its writer lease is released (C14).`,
        delegationId: setup.delegationId,
        attemptId,
        actions: [{ intent: 'retry', label: 'Retry the delegation' }],
        dismissible: false,
      })
      return 'exhausted'
    } finally {
      runtime.reconnecting = false
    }
  }

  private moveDelivery(
    tx: WriteTx,
    turn: TurnRecord,
    trigger: Parameters<typeof deliveryMachine.transition>[1],
    actor: ActorRef,
    options?: { to?: DeliveryState; detail?: Partial<TurnRecord['deliveryDetail']> },
  ): TurnRecord | null {
    const outcome = deliveryMachine.transition(
      turn.delivery,
      trigger,
      options?.to === undefined ? undefined : { to: options.to },
    )
    if (!outcome.ok) return turn
    if (outcome.deleted) {
      tx.deleteRecord('turn', turn.id)
      return null
    }
    const next: TurnRecord = {
      ...turn,
      delivery: outcome.state ?? turn.delivery,
      deliveryDetail: { ...turn.deliveryDetail, ...options?.detail },
    }
    this.putTurn(tx, next)
    const delegationId = this.delegationOfTurn(tx, next)
    /* An attempt that is gone leaves no stream to emit on. `delegation:` — the empty id — is not a
     * routable `StreamName`, and a head subscribing to it gets `stream_unknown`. */
    if (delegationId === '') return next
    this.emit(
      tx,
      delegationStream(delegationId),
      {
        k: 'deleg.turn_delivery',
        turnId: next.id,
        delivery: next.delivery,
        detail: next.deliveryDetail,
      },
      actor,
      { turnId: next.id, attemptId: next.attemptId },
    )
    return next
  }

  private delegationOfTurn(tx: ReadTx, turn: TurnRecord): DelegationId {
    return readAttempt(tx, turn.attemptId)?.delegationId ?? ''
  }

  /* ------------------------------------------------------------------------- notices + health */

  /**
   * `tx` is passed by every caller that is **already inside** a transaction. The store is a single
   * writer and does not nest, so a notice raised from within an intent must ride that intent's
   * transaction — which is also the right semantics: the notice and the state change it describes
   * become durable together, or neither does.
   */
  notice(notice: Omit<NoticeVM, 'id' | 'at'>, tx?: WriteTx): NoticeVM {
    const full: NoticeVM = { ...notice, id: `notice_${this.ids()}`, at: this.now() }
    this.notices.push(full)
    if (this.notices.length > 200) this.notices.shift()
    const write = (target: WriteTx): void => {
      this.emit(
        target,
        serverStream,
        { k: 'server.notice', notice: full },
        this.serverActor(notice.kind),
      )
    }
    if (tx === undefined) this.commitPlain('notice', write)
    else write(tx)
    return full
  }

  listNotices(): readonly NoticeVM[] {
    return this.notices
  }

  /**
   * The most recent `HealthVM`, or a truthful placeholder before the first probe. `snapshot()` is
   * synchronous by contract — cursor and state are read in **one** transaction (§2.3) — and a
   * health probe is a `ping` on a socket, so the snapshot serves the last observation and
   * `lastDoctorAt` says how old it is. Inventing `ok:true` for a never-probed executor is the one
   * thing [F5] forbids.
   */
  lastHealth(): HealthVM {
    return (
      this.healthCache ?? {
        server: { ok: true, version: this.options.version, uptimeMs: this.now() - this.startedAt },
        executor: {
          ok: false,
          adapterId: this.adapter.id,
          versions: {},
          blocked: null,
          fix: null,
        },
        instances: [],
        routes: [],
        approvalsAvailable: false,
        lastDoctorAt: 0,
      }
    )
  }

  async health(): Promise<HealthVM> {
    const report = await this.adapter.preflight()
    const instances: HealthVM['instances'] = await Promise.all(
      [...this.instances.entries()].map(async ([key, instance]) => {
        /* [F5]: `ok` is a ping on the ATTACHED probe connection and nothing else. */
        let ok = false
        let detail = ''
        try {
          await instance.runtimeInfo()
          ok = true
        } catch (error) {
          detail = error instanceof Error ? error.message : String(error)
        }
        return {
          key,
          pgid: instance.pgid,
          daemonPid: instance.daemonPid,
          sessions: [...this.live.values()].filter((s) => s.instance === instance).length,
          ok,
          detail,
        }
      }),
    )
    let routes: HealthVM['routes'] = []
    for (const instance of this.instances.values()) {
      try {
        routes = (await instance.runtimeInfo()).routes
        break
      } catch {
        /* a dead instance contributes no routes; `instances[].ok` already says so */
      }
    }
    const health: HealthVM = {
      server: { ok: true, version: this.options.version, uptimeMs: this.now() - this.startedAt },
      executor: {
        ok: report.ok,
        adapterId: this.adapter.id,
        versions: report.versions,
        blocked: report.blocked,
        fix: report.fix,
      },
      instances,
      routes,
      /* Approvals ship **dark**, gated on the runtime probe (R6, #14) — never assumed available. */
      approvalsAvailable: false,
      lastDoctorAt: this.now(),
    }
    this.healthCache = health
    return health
  }

  /* ---------------------------------------------------------------------------- snapshots */

  snapshot(stream: StreamName): { seq: number; state: unknown } {
    return this.store.snapshot(stream, (tx) => this.materialize(tx, stream))
  }

  /**
   * `snap.state`, in the **declared** shape of `protocol/snapshots.ts` — one per stream family.
   *
   * The rule those four shapes follow is what makes replay and snapshot converge: a snapshot
   * carries exactly the state that stream's events mutate. So `fleet` carries whole
   * `DelegationVM`s (because `fleet.delegation_created`/`_summary` do), `server` carries the last
   * health observation plus notices and confirmations, and `attempt:*` carries the transcript
   * **rebuilt from the durable log** — the only source that is authoritative after a restart
   * (§5.4 #2), never `tail()`, which is pinned to prompt-digest matching alone ([F8]).
   */
  private materialize(tx: ReadTx, stream: StreamName): unknown {
    if (stream === 'fleet') {
      const context = this.projectionContext(tx)
      const fleet = fleetVM(tx, context)
      const delegations = tx
        .listRecords<DelegationRecord>('delegation')
        .map((stored) => delegationVM(tx, stored.value, context))
      return {
        delegations,
        concurrency: fleet.concurrency,
        dispatchPaused: fleet.dispatchPaused,
        spend: fleet.spend,
      } satisfies FleetSnapshot
    }
    if (stream === 'server') {
      return {
        health: this.lastHealth(),
        notices: this.notices,
        confirmations: this.confirmations.list(),
      } satisfies ServerSnapshot
    }
    if (stream.startsWith('delegation:')) {
      const record = readDelegation(tx, stream.slice('delegation:'.length))
      if (record === null) return null
      return {
        delegation: delegationVM(tx, record, this.projectionContext(tx)),
      } satisfies DelegationSnapshot
    }
    const attemptId = stream.slice('attempt:'.length)
    const attempt = readAttempt(tx, attemptId)
    if (attempt === null) return null
    const replayed = replayTranscript(tx, attemptId, TRANSCRIPT_SNAPSHOT_LIMIT)
    return {
      attemptId,
      entries: replayed.entries,
      hasOlder: replayed.hasOlder,
      diff:
        attempt.workspace.worktree === null
          ? null
          : diffAgainstBase(attempt.workspace.worktree, attempt.workspace.baseRevision, attemptId),
    } satisfies AttemptSnapshot
  }

  /* ------------------------------------------------------------------------ intent boundary */

  /**
   * The single intent door. Idempotency is durable and keyed `(tokenId, idempotencyKey)` with a
   * 24 h TTL (§2.5 rule 3), and a hit returns the **original** response — **including the original
   * error**. A retry that re-executes and succeeds where the first attempt failed is a duplicate
   * side effect wearing an `ok`.
   */
  async dispatch(
    intent: string,
    args: unknown,
    ctx: IntentContext,
  ): Promise<IntentResult<unknown>> {
    if (this.reconciling !== null) await this.reconciling
    const cached = this.store.read((tx) => tx.getIdempotent(ctx.tokenId, ctx.idempotencyKey))
    if (cached !== null) return deserializeResult(cached.response)

    /* §2.5 rule 3's other half. The durable cache is written **after** the intent runs, so a
     * reconnect resend — which is specified to arrive with the same key while the original may
     * still be in flight — missed the cache and ran the intent a second time. For `cancel`,
     * `retract`, `verify`, `killSwitch` and `sendTurn` that is a double side effect. */
    const key = `${ctx.tokenId}\u0000${ctx.idempotencyKey}`
    const running = this.inFlight.get(key)
    if (running !== undefined) return running

    const execution = this.execute(intent, args, ctx).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, execution)
    return execution
  }

  private async execute(
    intent: string,
    args: unknown,
    ctx: IntentContext,
  ): Promise<IntentResult<unknown>> {
    let result: IntentResult<unknown>
    try {
      result = { ok: true, value: await this.run(intent, args, ctx), version: 0 }
    } catch (error) {
      result = {
        ok: false,
        error: SwarmError.is(error)
          ? error
          : new SwarmError('internal', error instanceof Error ? error.message : String(error)),
      }
    }
    const stored: IntentResult<unknown> = result.ok
      ? { ok: true, value: result.value, version: this.versionOf(result.value) }
      : { ok: false, error: result.error }
    this.store.commit((tx) => {
      tx.putIdempotent(ctx.tokenId, ctx.idempotencyKey, serializeResult(stored))
      /* The 24 h TTL of §2.5 rule 3, enforced where the cache is written — nothing else ever
       * looked at `createdAt`, so the cache grew forever and a key was answered from it for the
       * life of the database, which is not idempotency but a permanent refusal to re-run. */
      tx.pruneIdempotent(SERVER_POLICY.idempotencyTtlMs)
    })
    return stored
  }

  private versionOf(value: unknown): number {
    if (typeof value !== 'string') return 0
    return this.store.read((tx) => readDelegation(tx, value)?.version ?? 0)
  }

  /**
   * The intent table, read **exactly** as `protocol/intents.ts` declares `IntentArgs`.
   *
   * That module is the shared contract, and its rule is the one this switch follows: *`args`
   * mirrors the §6.3 method signature, with the receiver's id hoisted to a named field and
   * `idempotencyKey`/`expectedVersion` removed* — both ride on the envelope (§2.2). A server that
   * invented a nesting the client core does not send would fail on frame 2 of every session, and
   * the two stages are written separately, which is precisely why the shape is declared once.
   */
  private async run<K extends keyof IntentArgs>(
    intent: K | string,
    args: unknown,
    ctx: IntentContext,
  ): Promise<unknown> {
    const a = (args ?? {}) as Record<string, unknown>
    switch (intent) {
      case 'createDelegation': {
        const input = a as unknown as IntentArgs['createDelegation']
        return this.createDelegation(
          {
            idempotencyKey: ctx.idempotencyKey,
            spec: input.spec,
            ...(input.delegationId === undefined ? {} : { delegationId: input.delegationId }),
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.priority === undefined ? {} : { priority: input.priority }),
          },
          ctx,
        )
      }
      case 'sendTurn': {
        const input = a as unknown as IntentArgs['sendTurn']
        return this.sendTurn(input.delegationId, input.directive, ctx)
      }
      case 'retract':
        return this.retract((a as unknown as IntentArgs['retract']).turnId, ctx)
      case 'cancel': {
        const input = a as unknown as IntentArgs['cancel']
        return this.cancel(
          input.delegationId,
          {
            scope: input.scope,
            ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
          },
          ctx,
        )
      }
      case 'retry': {
        const input = a as unknown as IntentArgs['retry']
        return this.retry(
          input.delegationId,
          {
            ...(input.spec === undefined ? {} : { spec: input.spec }),
            ...(input.parallel === undefined ? {} : { parallel: input.parallel }),
            ...(input.injectPriorFailure === undefined
              ? {}
              : { injectPriorFailure: input.injectPriorFailure }),
          },
          ctx,
        )
      }
      case 'branch': {
        const input = a as unknown as IntentArgs['branch']
        return this.branch(
          input.attemptId,
          input.title === undefined ? {} : { title: input.title },
          ctx,
        )
      }
      case 'verify': {
        const input = a as unknown as IntentArgs['verify']
        return this.verify(
          input.delegationId,
          input.attemptId === undefined ? {} : { attemptId: input.attemptId },
          ctx,
        )
      }
      case 'accept': {
        const input = a as unknown as IntentArgs['accept']
        return this.accept(
          input.delegationId,
          {
            note: input.note,
            ...(input.attemptId === undefined ? {} : { attemptId: input.attemptId }),
          },
          ctx,
        )
      }
      case 'land': {
        const { delegationId, ...options } = a as unknown as IntentArgs['land']
        return this.land(delegationId, options as LandOptions, ctx)
      }
      case 'discard':
        return this.discard((a as unknown as IntentArgs['discard']).attemptId, ctx)
      case 'archive': {
        const input = a as unknown as IntentArgs['archive']
        return this.archive(
          input.delegationId,
          input.abandon === undefined ? {} : { abandon: input.abandon },
          ctx,
        )
      }
      case 'reconcile':
        return this.reconcile((a as unknown as IntentArgs['reconcile']).delegationId, ctx)
      case 'pauseDispatch': {
        const input = a as unknown as IntentArgs['pauseDispatch']
        return this.pauseDispatch(input.scope, input.paused === true, ctx)
      }
      case 'killSwitch': {
        const input = a as unknown as IntentArgs['killSwitch']
        return this.killSwitch({ killInstances: input.killInstances === true }, ctx)
      }
      case 'updateDefaults': {
        const input = a as unknown as IntentArgs['updateDefaults']
        return this.updateDefaults(input.delegationId, input.patch, ctx)
      }
      case 'confirm':
        this.confirmations.confirm((a as unknown as IntentArgs['confirm']).requestId, ctx.tokenId)
        return null
      case 'deny': {
        const input = a as unknown as IntentArgs['deny']
        this.confirmations.deny(input.requestId, input.reason)
        return null
      }
      default:
        throw new SwarmError('invalid_spec', `unknown intent '${String(intent)}'`)
    }
  }

  private assertVersion(record: DelegationRecord, expected: number | undefined): void {
    if (expected !== undefined && expected !== record.version) {
      throw new SwarmError(
        'version_conflict',
        `expectedVersion ${expected} but the record is at ${record.version}`,
        { details: { expected, actual: record.version } },
      )
    }
  }

  /* ------------------------------------------------------------------- createDelegation (D1) */

  private createDelegation(input: CreateDelegationInput, ctx: IntentContext): DelegationId {
    const id = input.delegationId ?? `d_${this.ids()}`
    const spec = input.spec

    if (spec.parallelAttempts > this.config.caps.maxParallelAttempts) {
      throw new SwarmError(
        'invalid_spec',
        `parallelAttempts ${spec.parallelAttempts} exceeds the cap of ${this.config.caps.maxParallelAttempts}`,
      )
    }
    for (const banned of [spec.model.reasoningEffort]) {
      const refusal = assertEffortAllowed(banned ?? null)
      if (refusal !== null) throw refusal
    }

    /* S6, on every use — never once at registration (§7.3). */
    const resolved = this.guard.resolve(spec.workspace.workspaceId, spec.workspace.subPath)
    const registration = resolved.registration
    const requestedMode = spec.workspace.writeMode ?? registration.writeMode
    if (registration.sensitive && requestedMode === 'in-place') {
      throw new SwarmError('workspace_denied', 'a sensitive workspace refuses in-place writes')
    }
    if (registration.sensitive && spec.workspace.allowDirty !== undefined) {
      throw new SwarmError('workspace_denied', 'a sensitive workspace refuses allowDirty')
    }
    const writeMode = registration.sensitive ? 'worktree' : requestedMode
    if (
      writeMode === 'in-place' &&
      isDirty(resolved.root) &&
      spec.workspace.allowDirty === undefined
    ) {
      throw new SwarmError('workspace_dirty', 'the working tree has uncommitted changes (C6)')
    }

    const baseRef = spec.workspace.baseRef ?? 'HEAD'
    /* C4b: the record never holds a symbolic ref — drift, verification locking and landing all
     * key off a fixed sha, so `'HEAD'` would silently disable all three. */
    const baseRevision = resolveBaseRevision(resolved.root, baseRef)

    const fullSpec: DelegationSpec = {
      ...spec,
      workspace: {
        workspaceId: spec.workspace.workspaceId,
        baseRevision,
        writeMode,
        ...(spec.workspace.subPath === undefined ? {} : { subPath: spec.workspace.subPath }),
        ...(spec.workspace.allowDirty === undefined
          ? {}
          : {
              allowDirty: {
                actor: ctx.actor,
                at: this.now(),
                note: spec.workspace.allowDirty.note,
              },
            }),
      },
    }

    const record: DelegationRecord = {
      recordVersion: 1,
      id,
      version: 1,
      spec: fullSpec,
      title: input.title ?? autoTitle(fullSpec.objective),
      state: 'queued',
      verdict: null,
      /* Frozen at create (Q1): `[]` acceptance ⇒ `accept{note}` is the only path to `succeeded`. */
      unverifiable: fullSpec.acceptance.length === 0,
      dispatchPaused: false,
      landed: null,
      attempts: [],
      liveAttempts: [],
      focusedAttempt: null,
      origin: null,
      priority: input.priority ?? 0,
      createdAt: this.now(),
      updatedAt: this.now(),
      createdBy: ctx.actor,
      spend: emptySpendCounters(),
      lastNeedsYouReason: null,
    }

    this.store.commit((tx) => {
      this.putDelegation(tx, record)
      const meta: DelegationMeta = {
        baseRef,
        workspaceRoot: resolved.root,
        instanceKey: instanceKeyOf(fullSpec),
      }
      tx.putRecord('delegation_meta', id, 1, meta)
      /* D1 — the creation edge. */
      delegationMachine.transition(null, 'created')
      this.emit(
        tx,
        fleetStream,
        {
          k: 'fleet.delegation_created',
          delegation: delegationVM(tx, record, this.projectionContext(tx)),
        },
        ctx.actor,
        { delegationId: id, correlationId: ctx.idempotencyKey },
      )
      tx.appendAudit({
        intent: 'createDelegation',
        actor: ctx.actor,
        delegationId: id,
        effective: {
          baseRef,
          baseRevision,
          writeMode,
          parallelAttempts: fullSpec.parallelAttempts,
          allowDirty: fullSpec.workspace.allowDirty ?? null,
        },
        result: { ok: true },
        correlation: ctx.idempotencyKey,
      })
    })
    void this.tick()
    return id
  }

  /* ------------------------------------------------------------------------------ sendTurn */

  private async sendTurn(
    delegationId: DelegationId,
    directive: TurnDirective,
    ctx: IntentContext,
  ): Promise<TurnId> {
    const prepared = this.store.commit((tx) => {
      let delegation = this.requireDelegation(tx, delegationId)
      this.assertVersion(delegation, ctx.expectedVersion ?? directive.expectedVersion)

      if (this.dispatchPausedFleet || delegation.dispatchPaused) {
        throw new SwarmError('dispatch_paused', 'dispatch is paused; resume it before sending')
      }

      /* D19: a late follow-up on a terminal delegation **reopens** it as attempt N+1 (Q2). */
      if (delegationMachine.isTerminal(delegation.state)) {
        const row = delegationMachine.transition(delegation.state, 'send_turn')
        if (row.ok && row.state !== null) {
          delegation = this.putDelegation(tx, {
            ...delegation,
            state: row.state,
            verdict: null,
            version: delegation.version + 1,
          })
          /* D19 is D19 whichever intent fires it: a reopen starts a new admission epoch, or the
           * scheduler finds every slot already spent and never provisions attempt N+1. */
          const meta = readMeta(tx, delegationId)
          if (meta !== null) {
            tx.putRecord('delegation_meta', delegationId, 1, {
              ...meta,
              openedInEpoch: 0,
              epochQueuedAt: this.now(),
            } satisfies DelegationMeta)
          }
          this.emitSummary(tx, delegationId, ctx.actor)
        }
      }

      /* Layer 2 of the triple validation (§4.1, §4.3.8): the same refusals the client core made,
       * asserted again where a hand-written frame arrives. */
      const refusal = validateTurnDirective(directive, {
        defaults: {
          provider: delegation.spec.model.provider,
          model: delegation.spec.model.model,
          reasoningEffort: delegation.spec.model.reasoningEffort,
          delivery: delegation.spec.delivery.mode,
        },
        liveAttempts: delegation.liveAttempts,
      })
      if (refusal !== null) throw refusal
      const banned = assertEffortAllowed(directive.reasoningEffort ?? null)
      if (banned !== null) throw banned

      const breach = classifyBudget(delegation.spend, delegation.spec.budget)
      if (breach.level === 'hard') {
        throw new SwarmError('budget_exhausted', `budget breached: ${breach.breached.join(', ')}`)
      }

      const attemptId = directive.attemptId ?? delegation.liveAttempts[0] ?? null
      const attempt = attemptId === null ? null : readAttempt(tx, attemptId)

      /* §4.3.3: an effort or model change while the channel is busy is refused with
       * `turn_in_flight` and produces **zero** executor calls. Never queued, never deferred, and
       * never issued optimistically — the daemon would park on the agent mutex, time the call out
       * at 30 s, and apply the setting to a turn the user never targeted ([F10]). */
      const namesConfig = directive.model !== undefined || directive.reasoningEffort !== undefined
      if (
        attempt !== null &&
        namesConfig &&
        ['submitting', 'accepted', 'streaming', 'interrupting'].includes(attempt.channel)
      ) {
        throw new SwarmError('turn_in_flight', 'a turn is in flight; configuration cannot change')
      }

      const turn = this.prepareTurn(tx, delegation, attempt, directive, ctx)
      return { turnId: turn.id, attemptId: turn.attemptId }
    }).value

    /* Outside the transaction: the wire write, and only after the record is durable (V1). */
    void this.dispatchQueue(prepared.attemptId)
    void this.tick()
    return prepared.turnId
  }

  /** V1 — the record, with its prompt digest, **before** any wire write. */
  private prepareTurn(
    tx: WriteTx,
    delegation: DelegationRecord,
    attempt: AttemptRecord | null,
    directive: TurnDirective,
    ctx: IntentContext,
  ): TurnRecord {
    const attemptId = attempt?.id ?? `pending:${delegation.id}`
    const ordinal = (attempt?.turns.length ?? 0) + 1
    const effective: EffectiveTurnConfig = effectiveTurnConfig({
      directive,
      defaults: {
        provider: delegation.spec.model.provider,
        model: delegation.spec.model.model,
        reasoningEffort: delegation.spec.model.reasoningEffort,
        delivery: delegation.spec.delivery.mode,
      },
      executorVersions: attempt?.executor.versions ?? {},
      ...(directive.structured === undefined
        ? {}
        : { structuredSchemaDigest: digest(JSON.stringify(directive.structured.schema)) }),
    })
    const turn: TurnRecord = {
      recordVersion: 1,
      id: `t_${this.ids()}`,
      attemptId,
      ordinal,
      directive,
      effective,
      promptDigest: digest(directive.text),
      attachmentDigests: (directive.images ?? []).map((image) => digest(image.base64)),
      contextBundles: [],
      delivery: 'prepared',
      deliveryDetail: {
        ackAtMs: null,
        correlated: false,
        /* Every soft interrupt is permanently `'unconfirmed'`: the landing event is not
         * translated by the bridge (§5.4 #10). */
        landing: modeAllowsConfig(effective.deliveryMode) ? 'n/a' : 'unconfirmed',
      },
      usage: null,
      toolCallCount: 0,
      startedAt: this.now(),
      endedAt: null,
      actor: ctx.actor,
    }
    this.putTurn(tx, turn)
    deliveryMachine.transition(null, 'persisted')
    this.emit(
      tx,
      delegationStream(delegation.id),
      { k: 'deleg.turn_prepared', turn: turnVM(turn, this.now()) },
      ctx.actor,
      {
        delegationId: delegation.id,
        attemptId,
        turnId: turn.id,
        correlationId: ctx.idempotencyKey,
      },
    )
    if (attempt !== null) {
      this.putAttempt(tx, { ...attempt, turns: [...attempt.turns, turn.id] })
      const meta = this.attemptMeta(tx, attempt.id)
      if (meta !== null) {
        this.putAttemptMeta(tx, attempt.id, {
          ...meta,
          pendingTurns: [...meta.pendingTurns, turn.id],
        })
      }
      /* D13/D16: `sendTurn` moves `needs-you`/`waiting` back to `running`. */
      this.movePhase(tx, attempt.id, 'send_turn')
      this.refreshDelegationState(tx, delegation.id, ctx.actor)
    } else {
      /* No attempt yet: the objective turn is dispatched by the scheduler at provisioning. */
      const pending = tx.getRecord<TurnId[]>('delegation_pending', delegation.id)?.value ?? []
      tx.putRecord('delegation_pending', delegation.id, 1, [...pending, turn.id])
    }
    tx.appendAudit({
      intent: 'sendTurn',
      actor: ctx.actor,
      delegationId: delegation.id,
      attemptId,
      turnId: turn.id,
      effective,
      result: { ok: true },
      correlation: ctx.idempotencyKey,
    })
    return turn
  }

  /* ------------------------------------------------------------------ applyAndSubmit (§4.2) */

  /**
   * §4.2's normative submission sequence: assert the lease with fence *f* → assert
   * `ChannelState === 'idle'` → `setModel` if it differs from the shadow → `setReasoningEffort` if
   * it differs → persist the effective config → send → `sent`.
   *
   * The persist sits between config and send **deliberately**: a crash after `setModel` and before
   * the send leaves a session whose state matches no turn, and the reconciler must see that.
   */
  private async dispatchQueue(attemptId: AttemptId): Promise<void> {
    const runtime = this.live.get(attemptId)
    if (runtime === undefined || runtime.session === null || runtime.dispatching) return
    runtime.dispatching = true
    try {
      for (;;) {
        const next = this.store.read((tx) => {
          const attempt = readAttempt(tx, attemptId)
          const meta = this.attemptMeta(tx, attemptId)
          if (attempt === null || meta === null) return null
          if (attempt.channel !== 'idle') return null
          const turnId = meta.pendingTurns[0]
          if (turnId === undefined) return null
          const turn = readTurn(tx, turnId)
          return turn === null ? null : { attempt, turn }
        })
        if (next === null) return
        await this.applyAndSubmit(next.attempt, next.turn)
      }
    } finally {
      runtime.dispatching = false
    }
  }

  private async applyAndSubmit(attempt: AttemptRecord, turn: TurnRecord): Promise<void> {
    const runtime = this.runtimeOf(attempt.id)
    const session = runtime.session
    const fence = runtime.fence
    const actor = turn.actor
    if (session === null || fence === null) return

    const delegation = this.store.read((tx) => this.requireDelegation(tx, attempt.delegationId))
    const mode = turn.effective.deliveryMode

    /* §3.4 rule 2: an expired lease **blocks new submissions**, and while a turn streams it marks
     * the holder `suspect` rather than releasing. Asserted here because "blocks new submissions"
     * has exactly one place it can be true. */
    try {
      this.assertWriterLease(attempt.id, session.sessionId, attempt.channel === 'streaming')
    } catch (error) {
      this.commitPlain('turn_refused', (tx) => {
        const fresh = readTurn(tx, turn.id)
        if (fresh !== null) {
          this.moveDelivery(tx, fresh, 'refused_preflight', actor, {
            detail: { reason: SwarmError.is(error) ? error.code : String(error) },
          })
        }
        this.dequeue(tx, attempt.id, turn.id)
      })
      return
    }

    /* §4.3.2, non-sticky: an omitted field reconciles the session back to the DELEGATION default,
     * not to the previous override — a turn with `effort:'max'` followed by a turn without one
     * issues `setReasoningEffort(delegationDefault)` before its send (Q4). */
    const target = reconciliationTarget(turn.directive, {
      provider: delegation.spec.model.provider,
      model: delegation.spec.model.model,
      reasoningEffort: delegation.spec.model.reasoningEffort,
      delivery: delegation.spec.delivery.mode,
    })

    try {
      if (target !== null) {
        const patch: { model?: string; reasoningEffort?: ReasoningEffort | null } = {}
        if (target.model !== runtime.shadow.model) patch.model = target.model
        if (target.reasoningEffort !== runtime.shadow.effort) {
          patch.reasoningEffort = target.reasoningEffort
        }
        if (patch.model !== undefined || patch.reasoningEffort !== undefined) {
          const report = await session.applyConfig(patch, fence)
          if (patch.model !== undefined && report.applied.includes('model')) {
            runtime.shadow.model = patch.model
          }
          if (patch.reasoningEffort !== undefined && report.applied.includes('reasoningEffort')) {
            runtime.shadow.effort = patch.reasoningEffort
          }
          if (report.refused.length > 0) {
            throw new SwarmError(
              'executor_refused',
              `executor refused ${report.refused.map((r) => r.field).join(', ')}`,
              { details: { refused: report.refused } },
            )
          }
        }
      }
    } catch (error) {
      /* V3: refused pre-flight — lease lost, banned effort, live-turn config change, budget. */
      this.commitPlain('turn_refused', (tx) => {
        const fresh = readTurn(tx, turn.id)
        if (fresh !== null) {
          this.moveDelivery(tx, fresh, 'refused_preflight', actor, {
            detail: { reason: SwarmError.is(error) ? error.code : String(error) },
          })
        }
        this.dequeue(tx, attempt.id, turn.id)
      })
      return
    }

    const contextOnly = mode === 'context-only'
    const interruptMode = mode === 'next-safe-point' || mode === 'interrupt'

    /* The config decisions are now known; re-persist the record carrying them, then send.
     *
     * C4 (`idle → submitting`) belongs to `submit()` alone. An interrupt is written *into* a turn
     * that is already in flight — that is what the mode is for — so moving the channel here would
     * park it in `submitting` and every later interrupt on the same session would find a channel
     * that is not `idle` and never dispatch. Interrupts take C9 instead, below. */
    this.commitPlain('turn_config', (tx) => {
      const fresh = readTurn(tx, turn.id)
      if (fresh === null) return
      this.putTurn(tx, {
        ...fresh,
        effective: {
          ...fresh.effective,
          executorVersions: attempt.executor.versions,
        },
      })
      if (interruptMode) return
      const live = readAttempt(tx, attempt.id)
      if (live !== null) this.moveChannel(tx, live, 'submit', actor)
    })

    try {
      if (interruptMode) {
        await session.interrupt(
          mode === 'interrupt' ? 'urgent' : 'soft',
          turn.directive.text,
          fence,
        )
        this.commitPlain('turn_sent', (tx) => {
          const fresh = readTurn(tx, turn.id)
          if (fresh !== null) this.moveDelivery(tx, fresh, 'written', actor)
          this.dequeue(tx, attempt.id, turn.id)
        })
        /* C9, and the landing stays `'unconfirmed'` forever: `soft_interrupt_injected` is not
         * translated by the bridge, so swarm can say it *wrote* the interrupt and nothing more. */
        this.issueInterrupt(attempt.id, actor)
        return
      }

      this.commitPlain('turn_sent', (tx) => {
        const fresh = readTurn(tx, turn.id)
        if (fresh !== null) this.moveDelivery(tx, fresh, 'written', actor)
      })
      runtime.turnStartedAt = this.now()
      /* §4.2's `budget` row: "none — swarm timer + `cancel(sessionId)`". The wall half of a
       * `TurnBudget` has no executor primitive behind it, so the timer is swarm's own. */
      this.armTurnDeadline(attempt.id, attempt.delegationId, turn)

      /* §4.2's `structured` row. `runStructured` is **native and truly per-turn**, and calling
       * `submit` for a directive carrying `structured` recorded a `schemaDigest`, advertised the
       * `structured` capability in `hello_ok`, and then sent a plain message — a schema the user
       * asked for, acknowledged, and silently dropped. */
      if (turn.directive.structured !== undefined) {
        await this.submitStructured(attempt, turn, session, fence, actor)
        return
      }

      const receipt = await session.submit(
        {
          text: turn.directive.text,
          awaitAckMs: this.config.timeouts.acceptTimeoutMs,
          ...(contextOnly ? { contextOnly: true } : {}),
          ...(turn.directive.images === undefined
            ? {}
            : {
                images: turn.directive.images.map(
                  (image) => [image.mediaType, image.base64] as const,
                ),
              }),
        },
        fence,
      )

      this.commitPlain('turn_ack', (tx) => {
        const fresh = readTurn(tx, turn.id)
        if (fresh === null) return
        if (receipt.ack === 'accepted') {
          const accepted = this.moveDelivery(tx, fresh, 'message_accepted', actor, {
            detail: { ackAtMs: receipt.ackAtMs },
          })
          /* V13: `context-only` has no `turn_done`, so its ack is the only path to `ended` (#32). */
          if (contextOnly && accepted !== null) {
            this.moveDelivery(tx, accepted, 'context_only_ack', this.serverActor('context-only'))
          }
        } else {
          /* V5: swarm's own deadline elapsed with no `message_accepted` on the stream ([F2]). */
          this.moveDelivery(tx, fresh, 'accept_timeout', actor, {
            detail: { reason: 'no message_accepted inside acceptTimeoutMs' },
          })
          this.notice(
            {
              kind: 'delivery-unknown',
              severity: 'warn',
              title: 'Delivery could not be confirmed',
              detail:
                'No message_accepted arrived inside acceptTimeoutMs. Reconcile before resending — ' +
                'sendMessage has no idempotency key, so a resend cannot be deduplicated.',
              delegationId: attempt.delegationId,
              attemptId: attempt.id,
              turnId: turn.id,
              actions: [{ intent: 'reconcile', label: 'Reconcile' }],
              dismissible: false,
            },
            tx,
          )
        }
        const live = readAttempt(tx, attempt.id)
        if (live !== null && contextOnly) this.moveChannel(tx, live, 'turn_done', actor)
        this.dequeue(tx, attempt.id, turn.id)
      })
    } catch (error) {
      this.commitPlain('turn_failed', (tx) => {
        const fresh = readTurn(tx, turn.id)
        if (fresh !== null) {
          this.moveDelivery(tx, fresh, 'refused_preflight', actor, {
            detail: { reason: SwarmError.is(error) ? error.code : String(error) },
          })
        }
        const live = readAttempt(tx, attempt.id)
        if (live !== null) this.moveChannel(tx, live, 'submit_failed', actor)
        this.dequeue(tx, attempt.id, turn.id)
      })
    }
  }

  /**
   * §4.2's `structured` row, in full: native `runStructured`, `maxRetries + 1` turns against the
   * budget, `StructuredOutputError ⇒ structuredFailed`, and every attempt stored as evidence.
   *
   * The delivery walk is V4 → V6 → V7 rather than a special case, because that is what actually
   * happened: `runStructured` runs real turns underneath, and a delivery machine that skipped them
   * would leave the transcript describing a turn nobody can find.
   */
  private async submitStructured(
    attempt: AttemptRecord,
    turn: TurnRecord,
    session: ExecutorSessionHandle,
    fence: Fence,
    actor: ActorRef,
  ): Promise<void> {
    const schema = turn.directive.structured?.schema
    const maxRetries = turn.effective.structured?.maxRetries ?? 2
    const result = await session.structured<unknown>(
      {
        text: turn.directive.text,
        ...(turn.directive.images === undefined
          ? {}
          : {
              images: turn.directive.images.map(
                (image) => [image.mediaType, image.base64] as const,
              ),
            }),
      },
      schema,
      maxRetries,
      fence,
    )

    /* The attempts are the evidence §4.2 asks for, valid or not. */
    const evidenceRef = join(this.layout.evidenceDir, attempt.id, 'structured')
    try {
      mkdirSync(evidenceRef, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(evidenceRef, `${turn.id}.jsonl`),
        `${result.raw.map((row) => JSON.stringify({ raw: row })).join('\n')}\n`,
        { mode: 0o600 },
      )
    } catch {
      /* Evidence that cannot be written is a disk problem; the turn still has to end honestly. */
    }

    this.commitPlain('structured_result', (tx) => {
      const accepted = this.moveDelivery(
        tx,
        this.requireTurn(tx, turn.id),
        'message_accepted',
        actor,
        {
          detail: { ackAtMs: this.now() },
        },
      )
      if (accepted === null) return
      const running = this.moveDelivery(tx, accepted, 'first_stream_event', actor)
      if (running === null) return
      const ended = result.failed
        ? this.moveDelivery(tx, running, 'turn_done', actor, {
            detail: { reason: `structuredFailed: ${result.error?.code ?? 'invalid'}` },
          })
        : this.moveDelivery(tx, running, 'turn_done', actor)
      if (ended !== null) this.putTurn(tx, { ...ended, endedAt: this.now() })
      /* C5 → C7 → C8, for the same reason the delivery walks V4 → V6 → V7: `runStructured` ran
       * real turns underneath, and a channel that jumped from `submitting` to `idle` would leave
       * every later turn on this session waiting for a state the machine cannot reach. */
      for (const trigger of ['message_accepted', 'first_stream_event', 'turn_done'] as const) {
        const live = readAttempt(tx, attempt.id)
        if (live !== null) this.moveChannel(tx, live, trigger, actor)
      }
      this.dequeue(tx, attempt.id, turn.id)
    })

    if (result.failed) {
      this.notice({
        kind: 'capability-absent',
        severity: 'warn',
        title: 'The structured answer did not validate',
        detail: `${result.attempts} attempt(s) failed the schema; every response is stored as evidence.`,
        delegationId: attempt.delegationId,
        attemptId: attempt.id,
        turnId: turn.id,
        actions: [],
        dismissible: true,
      })
    }
    await this.afterTurn(attempt.id, attempt.delegationId)
  }

  /**
   * §4.2's `budget` row: the wall half of a `TurnBudget` is a **swarm timer** plus
   * `cancel(sessionId)`, because jcode has no per-turn deadline to delegate it to.
   */
  private armTurnDeadline(
    attemptId: AttemptId,
    delegationId: DelegationId,
    turn: TurnRecord,
  ): void {
    const wall = turn.effective.budget?.maxWallMs
    if (wall === undefined || wall <= 0) return
    void this.sleep(wall).then(() => {
      if (this.closed) return
      const still = this.store.read((tx) => readTurn(tx, turn.id))
      if (still === null) return
      if (
        still.delivery !== 'sent' &&
        still.delivery !== 'accepted' &&
        still.delivery !== 'running'
      ) {
        return
      }
      void this.breachTurnBudget(attemptId, delegationId, turn.id).catch(() => undefined)
    })
  }

  private requireTurn(tx: ReadTx, id: TurnId): TurnRecord {
    const turn = readTurn(tx, id)
    if (turn === null) throw new SwarmError('not_found', `no turn ${id}`)
    return turn
  }

  private dequeue(tx: WriteTx, attemptId: AttemptId, turnId: TurnId): void {
    const meta = this.attemptMeta(tx, attemptId)
    if (meta === null) return
    this.putAttemptMeta(tx, attemptId, {
      ...meta,
      pendingTurns: meta.pendingTurns.filter((id) => id !== turnId),
    })
  }

  /* --------------------------------------------------------------------- the executor pump */

  /**
   * X7: drained at full speed, **never awaiting head IO**. Everything this does is a synchronous
   * `store.commit`; the follow-up work — verification, the next queued turn, reconciliation — is
   * started with `void` so a slow verifier cannot stall the stream either.
   */
  private async pump(attemptId: AttemptId, session: ExecutorSessionHandle): Promise<void> {
    for await (const event of session.events()) {
      try {
        this.handleExecutorEvent(attemptId, event)
      } catch {
        /* One malformed event must not end the drain: what is not received never existed. */
      }
      if (event.k === 'closed') break
    }
  }

  private handleExecutorEvent(attemptId: AttemptId, event: ExecutorEvent): void {
    const runtime = this.runtimeOf(attemptId)
    runtime.lastEventAt = this.now()
    /* §7.4's `swarm_executor_events_total{kind}`, which used to be a hard-coded 0. */
    this.observed.executorEvents[event.k] = (this.observed.executorEvents[event.k] ?? 0) + 1
    const writeStartedAt = this.mono()
    const actor = this.serverActor('executor')
    const stream = attemptStream(attemptId)

    const post = this.store.commit((tx) => {
      const attempt = readAttempt(tx, attemptId)
      if (attempt === null) return null
      const deleg = delegationStream(attempt.delegationId)
      const current = currentTurn(tx, attempt)

      switch (event.k) {
        case 'text':
        case 'reasoning': {
          this.emit(tx, stream, { k: `att.${event.k}`, text: event.text }, actor, {
            delegationId: attempt.delegationId,
            attemptId,
          })
          this.moveChannel(tx, attempt, 'first_stream_event', actor)
          if (current !== null) this.moveDelivery(tx, current, 'first_stream_event', actor)
          return null
        }
        case 'tool_start':
        case 'tool_exec': {
          runtime.nowDoing = `${event.name} ${runtime.toolInputs.get(event.callId) ?? ''}`.trim()
          this.emit(
            tx,
            stream,
            {
              k: 'att.tool',
              callId: event.callId,
              name: event.name,
              target: targetOf(runtime.toolInputs.get(event.callId)),
              status: event.k === 'tool_start' ? 'start' : 'exec',
            },
            actor,
            {
              delegationId: attempt.delegationId,
              attemptId,
              /* §5.5 counts tool events **for this turn**; the id is what makes that a filter
               * rather than a guess about how far back to look. */
              ...(current === null ? {} : { turnId: current.id }),
            },
          )
          this.moveChannel(tx, attempt, 'first_stream_event', actor)
          if (current !== null) this.moveDelivery(tx, current, 'first_stream_event', actor)
          return null
        }
        case 'tool_input': {
          /* [F11]: the adapter has already attributed this to the most recent `tool_start`; the
           * buffer is keyed by that id, never by the empty one the bridge sends. */
          const key = event.callId
          runtime.toolInputs.set(key, (runtime.toolInputs.get(key) ?? '') + event.delta)
          return null
        }
        case 'tool_done': {
          this.emit(
            tx,
            stream,
            {
              k: 'att.tool',
              callId: event.callId,
              name: event.name,
              target: targetOf(runtime.toolInputs.get(event.callId)),
              status: event.error === undefined ? 'done' : 'error',
              output: event.output.slice(0, 4096),
            },
            actor,
            {
              delegationId: attempt.delegationId,
              attemptId,
              /* §5.5's clause is "any tool event logged **for this turn**". Without the id on the
               * record, reconciliation counted the whole `attempt:*` stream and read a *previous*
               * turn's tool call as evidence that the message under reconciliation had landed. */
              ...(current === null ? {} : { turnId: current.id }),
            },
          )
          if (current !== null) {
            const counted = this.putTurn(tx, {
              ...current,
              toolCallCount: current.toolCallCount + 1,
            })
            /* §3.4's `maxToolCalls` — one of the three dimensions `addSpend` was never given. */
            const delegation = this.requireDelegation(tx, attempt.delegationId)
            this.putDelegation(tx, {
              ...delegation,
              spend: addSpend(delegation.spend, { toolCalls: 1 }),
            })
            if (
              turnBudgetBreached(counted.effective.budget, {
                wallMs: this.now() - runtime.turnStartedAt,
                toolCalls: counted.toolCallCount,
              })
            ) {
              return {
                kind: 'turn_budget' as const,
                delegationId: attempt.delegationId,
                turnId: counted.id,
              }
            }
          }
          return null
        }
        case 'usage': {
          this.emit(
            tx,
            stream,
            {
              k: 'att.usage',
              input: event.input,
              output: event.output,
              ...(event.cacheReadInput === undefined
                ? {}
                : { cacheReadInput: event.cacheReadInput }),
            },
            actor,
            { delegationId: attempt.delegationId, attemptId },
          )
          if (current !== null) {
            this.putTurn(tx, {
              ...current,
              usage: {
                input: event.input,
                output: event.output,
                ...(event.cacheReadInput === undefined
                  ? {}
                  : { cacheReadInput: event.cacheReadInput }),
              },
            })
          }
          const delegation = this.requireDelegation(tx, attempt.delegationId)
          this.putDelegation(tx, {
            ...delegation,
            spend: addSpend(delegation.spend, {
              inputTokens: event.input,
              outputTokens: event.output,
              /* `estUsd` has exactly one source and no default (§3.4). Absent, it stays 0 and
               * `assertSpendMeasurable` says so out loud rather than letting `maxSpendUsd` read
               * as "never breached". */
              estUsd:
                this.options.estimateTurnCostUsd?.({
                  provider: delegation.spec.model.provider,
                  model: delegation.spec.model.model,
                  inputTokens: event.input,
                  outputTokens: event.output,
                }) ?? 0,
            }),
          })
          return null
        }
        case 'accepted': {
          this.moveChannel(tx, attempt, 'message_accepted', actor)
          return null
        }
        case 'turn_done': {
          /* C10 wins over C11: an interrupt followed by a `turn_done` did not merge, whatever the
           * merge timer would have concluded three seconds later. */
          runtime.interruptAt = null
          const live = this.moveChannel(tx, attempt, 'turn_done', actor)
          if (current !== null) {
            const ended = this.moveDelivery(tx, current, 'turn_done', actor)
            if (ended !== null) {
              const finished = this.putTurn(tx, { ...ended, endedAt: this.now() })
              this.emit(
                tx,
                deleg,
                {
                  k: 'deleg.turn_ended',
                  turnId: finished.id,
                  usage: finished.usage,
                  toolCalls: finished.toolCallCount,
                },
                actor,
                { delegationId: attempt.delegationId, attemptId, turnId: finished.id },
              )
              this.emit(
                tx,
                stream,
                { k: 'att.turn_boundary', turnId: finished.id, edge: 'end' },
                actor,
                { delegationId: attempt.delegationId, attemptId },
              )
            }
          }
          void live
          return { kind: 'turn_end' as const, delegationId: attempt.delegationId }
        }
        case 'closed': {
          /* C12 / V8 / D18: a disconnect is honest about what it cost — the turn becomes
           * `unknown`, the attempt is annotated `interrupted`, and the delegation waits. */
          runtime.interruptAt = null
          this.moveChannel(tx, attempt, 'socket_closed', actor)
          if (current !== null && (current.delivery === 'running' || current.delivery === 'sent')) {
            this.moveDelivery(
              tx,
              current,
              current.delivery === 'running'
                ? 'disconnect_before_turn_done'
                : 'disconnect_before_ack',
              actor,
              { detail: { reason: event.reason } },
            )
          }
          this.movePhase(tx, attemptId, 'executor_disconnect')
          this.refreshDelegationState(tx, attempt.delegationId, actor)
          return { kind: 'disconnected' as const, delegationId: attempt.delegationId }
        }
        case 'error': {
          this.emit(
            tx,
            stream,
            { k: 'att.error', code: event.code, message: event.message },
            actor,
            { delegationId: attempt.delegationId, attemptId },
          )
          /* V11: attributable ONLY because §5.3 binds one connection to one session ([F6]). */
          if (
            current !== null &&
            (current.delivery === 'sent' || current.delivery === 'accepted')
          ) {
            this.moveDelivery(tx, current, 'session_error', actor, {
              detail: { reason: `${event.code}: ${event.message}` },
            })
          }
          return null
        }
        case 'model_info': {
          if (
            !event.solicited &&
            event.model !== undefined &&
            event.model !== runtime.shadow.model
          ) {
            /* §4.3.5: unsolicited drift invalidates the shadow and is surfaced, never absorbed. */
            runtime.shadow.model = null
            this.emit(
              tx,
              deleg,
              {
                k: 'deleg.drift',
                attemptId,
                kind: 'model',
                detail: `model changed to ${event.model} without swarm asking`,
              },
              actor,
              { delegationId: attempt.delegationId, attemptId },
            )
          } else if (event.model !== undefined) {
            runtime.shadow.model = event.model
            if (current !== null) {
              this.putTurn(tx, {
                ...current,
                effective: { ...current.effective, modelConfirmed: true },
              })
            }
          }
          return null
        }
        case 'background': {
          this.emit(
            tx,
            stream,
            {
              k: 'att.background',
              taskId: event.taskId,
              label: event.label,
              provenance: 'scraped',
              ...(event.percent === undefined ? {} : { percent: event.percent }),
            },
            actor,
            { delegationId: attempt.delegationId, attemptId },
          )
          return null
        }
        case 'session_status':
        case 'reasoning_done':
          /* `session_status` is carried and never used: the vocabulary lies (#18, §5.4 #4). */
          return null
      }
    }).value

    this.observed.logWriteMs += Math.max(0, this.mono() - writeStartedAt)
    if (post === null || post === undefined) return
    /* X7: the follow-up work is started, never awaited — a slow verifier must not stall the drain.
     * Both are caught: contention on the `delegation:*` reconciliation lease is an expected
     * outcome (§3.4), and an expected outcome that escapes as an unhandled rejection would take
     * the server down for the one failure mode it exists to survive. */
    if (post.kind === 'turn_end') {
      void this.afterTurn(attemptId, post.delegationId).catch((error: unknown) => {
        this.noteBackgroundFailure('turn end', post.delegationId, attemptId, error)
      })
    }
    if (post.kind === 'disconnected') {
      void this.afterDisconnect(attemptId, post.delegationId).catch((error: unknown) => {
        this.noteBackgroundFailure('disconnect', post.delegationId, attemptId, error)
      })
    }
    if (post.kind === 'turn_budget') {
      void this.breachTurnBudget(attemptId, post.delegationId, post.turnId).catch(
        (error: unknown) => {
          this.noteBackgroundFailure('turn budget', post.delegationId, attemptId, error)
        },
      )
    }
  }

  /**
   * §3.4's last sentence: "a `TurnBudget` breach `cancel`s **that turn only** and records
   * `budget-breach` on it", and §4.2's `budget` row: "none — swarm timer + `cancel(sessionId)`;
   * `cancel` ends the turn; the session survives".
   *
   * `turnBudgetBreached` had no caller at all, so `TurnDirective.budget` was a field the client
   * could set, the server would persist onto `EffectiveTurnConfig`, and nothing would ever read.
   */
  private async breachTurnBudget(
    attemptId: AttemptId,
    delegationId: DelegationId,
    turnId: TurnId,
  ): Promise<void> {
    const runtime = this.live.get(attemptId)
    if (runtime === undefined || runtime.session === null || runtime.fence === null) return
    const already = this.commitPlain('turn_budget_breach', (tx) => {
      const turn = readTurn(tx, turnId)
      if (turn === null || turn.deliveryDetail.reason === 'budget-breach') return true
      this.putTurn(tx, {
        ...turn,
        deliveryDetail: { ...turn.deliveryDetail, reason: 'budget-breach' },
      })
      return false
    })
    if (already === true) return
    /* The turn, and only the turn. The session survives, which is what makes this different from
     * every other stop in §4.3.7. */
    await runtime.session.interrupt('cancel', null, runtime.fence).catch(() => undefined)
    this.issueInterrupt(attemptId, this.serverActor('turn budget'))
    this.notice({
      kind: 'budget-hard',
      severity: 'warn',
      title: 'The turn budget was reached',
      detail: 'This turn was cancelled; the session and the delegation are untouched (§3.4).',
      delegationId,
      attemptId,
      turnId,
      actions: [],
      dismissible: true,
    })
  }

  /**
   * A spend cap swarm cannot measure is a gate that does not gate (S8).
   *
   * `SpendCounters.estUsd` has exactly one possible source — an injected price oracle — and this
   * spec names no price table, so there is nothing honest to default to. What is **not** acceptable
   * is the previous behaviour: `estUsd` frozen at 0, so `fraction(0, maxSpendUsd)` was 0 and both
   * `BudgetSpec.maxSpendUsd` and `caps.hardSpendUsd` read as "never breached" while a surface
   * happily showed a dollar limit. Raised once, non-dismissible.
   */
  private assertSpendMeasurable(budget: { readonly maxSpendUsd?: number }): void {
    if (this.spendOracleWarned) return
    if (this.options.estimateTurnCostUsd !== undefined) return
    if (budget.maxSpendUsd === undefined && this.config.caps.hardSpendUsd === null) return
    this.spendOracleWarned = true
    this.notice({
      kind: 'capability-absent',
      severity: 'warn',
      title: 'Spend caps are not enforced',
      detail:
        'A dollar cap is configured but this server has no way to price a turn, so `estUsd` stays ' +
        '0 and the cap can never breach. Turn, token, tool-call and wall budgets are unaffected.',
      actions: [],
      dismissible: false,
    })
  }

  /** A background stage that refused. Surfaced as a notice; never a crash, never silence. */
  private noteBackgroundFailure(
    stage: string,
    delegationId: DelegationId,
    attemptId: AttemptId,
    error: unknown,
  ): void {
    if (this.closed) return
    this.notice({
      kind: 'doctor-blocked',
      severity: 'warn',
      title: `Post-${stage} work did not complete`,
      detail: SwarmError.is(error) ? `${error.code}: ${error.message}` : String(error),
      delegationId,
      attemptId,
      actions: [{ intent: 'reconcile', label: 'Reconcile' }],
      dismissible: true,
    })
  }

  /* ---------------------------------------------------------------------------- turn end */

  private async afterTurn(attemptId: AttemptId, delegationId: DelegationId): Promise<void> {
    const runtime = this.live.get(attemptId)
    const elapsedWall = runtime === undefined ? 0 : Math.max(0, this.now() - runtime.turnStartedAt)
    const decision = this.store.commit((tx) => {
      const delegation = this.requireDelegation(tx, delegationId)
      const meta = this.attemptMeta(tx, attemptId)
      /* `wallMs` grew **only** on a detected sleep gap, and that gap was added to `wallMs` and
       * `sleptMs` at once — and `budgetFractions` reads `wallMs − sleptMs`. The wall fraction was
       * therefore pinned at 0 and `maxWallMs` could never breach. It is turn time that spends the
       * wall budget; a suspend inside a turn is still excluded, because `sleptMs` is subtracted. */
      const spend = addSpend(delegation.spend, {
        turns: 1,
        wallMs: elapsedWall,
        monotonicMs: elapsedWall,
      })
      const updated = this.putDelegation(tx, { ...delegation, spend })
      this.assertSpendMeasurable(updated.spec.budget)

      const breach = classifyBudget(spend, updated.spec.budget)
      if (breach.level !== 'none') {
        this.emit(
          tx,
          fleetStream,
          { k: 'fleet.spend', spend: { ...spend, capUsd: this.config.caps.hardSpendUsd } },
          this.serverActor('budget'),
          { delegationId },
        )
      }
      if (breach.level === 'hard') {
        /* Q11: the in-flight turn is never cancelled — it has already ended here, and the state
         * moves at turn end (D22). Only dispatch stops. */
        this.putDelegation(tx, { ...updated, dispatchPaused: true, version: updated.version + 1 })
        this.movePhase(tx, attemptId, 'hard_spend_cap')
      }

      if ((meta?.pendingTurns.length ?? 0) > 0) return { kind: 'dispatch' as const, breach }
      if (updated.unverifiable) {
        /* D7: an unverifiable delegation cannot reach `succeeded` on `turn_done` alone (Q1). */
        this.movePhase(tx, attemptId, 'needs_you')
        this.putDelegation(tx, {
          ...updated,
          lastNeedsYouReason: 'unverifiable-turn-end' as NeedsYouReason,
        })
        this.refreshDelegationState(tx, delegationId, this.serverActor('turn end'))
        return { kind: 'needs-you' as const, breach }
      }
      /* D6 then D8: no queued follow-up and criteria present ⇒ waiting, then auto-verify (VE5). */
      this.movePhase(tx, attemptId, 'turn_done_no_followup')
      this.movePhase(tx, attemptId, 'verify')
      this.refreshDelegationState(tx, delegationId, this.serverActor('turn end'))
      return { kind: 'verify' as const, breach }
    }).value

    if (decision.breach.level === 'hard') {
      this.notice({
        kind: 'budget-hard',
        severity: 'error',
        title: 'Budget exhausted — dispatch paused',
        detail: `Breached: ${decision.breach.breached.join(', ')}. The running turn was not cancelled (Q11).`,
        delegationId,
        actions: [{ intent: 'pauseDispatch', label: 'Resume dispatch' }],
        dismissible: true,
      })
    } else if (decision.breach.level === 'soft') {
      this.notice({
        kind: 'budget-soft',
        severity: 'warn',
        title: 'Budget at 80 %',
        detail: `Worst dimension at ${(decision.breach.worstFraction * 100).toFixed(0)} %.`,
        delegationId,
        actions: [],
        dismissible: true,
      })
    }

    if (decision.kind === 'dispatch') {
      await this.dispatchQueue(attemptId)
      return
    }
    if (decision.kind === 'verify') await this.runVerification(attemptId, 'auto-turn-end')
  }

  private async afterDisconnect(attemptId: AttemptId, delegationId: DelegationId): Promise<void> {
    this.commitPlain('attempt_interrupted', (tx) => {
      const attempt = readAttempt(tx, attemptId)
      if (attempt !== null && attempt.outcome === 'open') {
        this.putAttempt(tx, { ...attempt, outcome: 'interrupted' })
      }
    })
    /* §5.5's procedure reattaches **inside** reconciliation, before the `tail(12)` — the tail is
     * the evidence, and a tail nobody can read is not "no evidence", it is no observation. */
    await this.reconcileDelegation(delegationId, this.serverActor('disconnect'))
    /* C13 then runs the full ladder for whatever reconciliation could not reattach; a channel it
     * already restored makes this a no-op. */
    void this.reconnectChannel(attemptId).catch(() => undefined)
  }

  /* ------------------------------------------------------------------------- verification */

  private async runVerification(
    attemptId: AttemptId,
    reason: 'auto-turn-end' | 'manual' | 'pre-land' | 're-verify',
  ): Promise<VerificationRun | null> {
    const setup = this.store.read((tx) => {
      const attempt = readAttempt(tx, attemptId)
      if (attempt === null) return null
      const delegation = readDelegation(tx, attempt.delegationId)
      if (delegation === null) return null
      return { attempt, delegation }
    })
    if (setup === null) return null
    const cwd = setup.attempt.workspace.worktree ?? setup.attempt.workspace.root
    const runId = `run_${this.ids()}`

    this.commitPlain('verify_started', (tx) => {
      this.emit(
        tx,
        delegationStream(setup.attempt.delegationId),
        { k: 'deleg.verify_started', attemptId, runId, reason },
        this.serverActor('verifier'),
        { delegationId: setup.attempt.delegationId, attemptId },
      )
    })

    let run: VerificationRun
    try {
      run = await this.verifier.run({
        attemptId,
        criteria: setup.delegation.spec.acceptance,
        workspace: { cwd, baseRevision: setup.attempt.workspace.baseRevision },
        deadlineMs: 20 * 60_000,
        reason,
      })
    } catch (error) {
      this.notice({
        kind: 'doctor-blocked',
        severity: 'error',
        title: 'Verification could not run',
        detail: error instanceof Error ? error.message : String(error),
        delegationId: setup.attempt.delegationId,
        attemptId,
        actions: [{ intent: 'verify', label: 'Retry verification' }],
        dismissible: true,
      })
      return null
    }

    const staleBase = baseHasMoved(
      setup.attempt.workspace.root,
      setup.attempt.workspace.baseRevision,
    )
    const stamped: VerificationRun = {
      ...run,
      runNo: setup.attempt.verifications.length + 1,
      /* Q10: labelled "verified against a base that has moved", never invalidated. */
      staleBase,
    }
    const authoritative = setup.delegation.spec.reviewIsAuthoritative === true
    const verdict = verdictOf(stamped.results, { reviewIsAuthoritative: authoritative })
    const final: VerificationRun = { ...stamped, verdict }

    /* §8.5's bundle, actually written. Production used to emit `digest(final.runId)` — the sha of
     * an id string — under the name `manifestDigest`, beside a directory containing only
     * `run.json` and the criterion output. §13 asks that "its `manifest.json` digests match the
     * files on disk"; a digest of the run id matches nothing, and matched nothing, checkably. */
    const bundle = this.writeBundle(setup.attempt, final)

    this.commitPlain('verify_result', (tx) => {
      const attempt = readAttempt(tx, attemptId)
      if (attempt === null) return
      this.putAttempt(tx, {
        ...attempt,
        verifications: [...attempt.verifications, final],
        evidence: final.evidenceRef,
        workspace: { ...attempt.workspace, staleBase },
      })
      this.emit(
        tx,
        delegationStream(attempt.delegationId),
        { k: 'deleg.verify_result', run: final },
        this.serverActor('verifier'),
        { delegationId: attempt.delegationId, attemptId },
      )
      this.emit(
        tx,
        delegationStream(attempt.delegationId),
        {
          k: 'deleg.evidence',
          attemptId,
          evidenceRef: final.evidenceRef,
          manifestDigest: bundle.manifestDigest,
        },
        this.serverActor('verifier'),
        { delegationId: attempt.delegationId, attemptId },
      )

      let forced: DelegationState | undefined
      const canReachVerified =
        hasMachineCheckableCriterion(setup.delegation.spec.acceptance) || authoritative
      if (verdict === 'pass' && canReachVerified) {
        /* D10 — the only automatic route to `succeeded`, and only with machine-checkable evidence. */
        this.movePhase(tx, attemptId, 'verification_passed')
        this.endAttempt(tx, attemptId, 'verified', 'succeeded')
        const delegation = this.requireDelegation(tx, attempt.delegationId)
        this.putDelegation(tx, {
          ...delegation,
          verdict: 'verified',
          version: delegation.version + 1,
        })
      } else {
        const delegation = this.requireDelegation(tx, attempt.delegationId)
        const exhausted =
          verdict === 'fail' &&
          classifyBudget(delegation.spend, delegation.spec.budget).level === 'hard'
        if (exhausted) {
          /* D12 — "criteria failed, budget exhausted". `verification_exhausted` appeared nowhere
           * outside the state table, so the else-branch always fired D11 and `verifying → failed`
           * was unreachable regardless of spend: the row was tested in the table and by no path. */
          this.movePhase(tx, attemptId, 'verification_exhausted')
          this.endAttempt(tx, attemptId, 'exhausted', 'failed')
          const ended = this.requireDelegation(tx, attempt.delegationId)
          this.putDelegation(tx, {
            ...ended,
            state: ended.liveAttempts.length === 0 ? 'failed' : ended.state,
            lastNeedsYouReason: 'budget' as NeedsYouReason,
            version: ended.version + 1,
          })
          /* D22 has already moved this attempt's phase to `queued` (the hard cap fires at the same
           * turn end), and `refreshDelegationState` deliberately never rolls `queued` up to a
           * terminal — that guard is what protects a D19 reopen. So D12 names its own terminal. */
          if (ended.liveAttempts.length === 0) forced = 'failed'
        } else {
          /* D11: a failure with budget remaining, or an indeterminate result, is a question for a
           * human — never a silent `failed` and never a silent `succeeded`. */
          this.movePhase(tx, attemptId, 'verification_failed_budget_remaining')
          this.putDelegation(tx, {
            ...delegation,
            lastNeedsYouReason: verdict === 'fail' ? 'verification-failed' : 'manual-criterion',
          })
        }
      }
      this.refreshDelegationState(tx, attempt.delegationId, this.serverActor('verifier'), forced)
    })
    return final
  }

  /**
   * §8.5's bundle, from the durable log — the only source that is authoritative after a restart
   * (§5.4 #2). `diff.patch`, `transcript.jsonl`, `tools.jsonl`, `cost.json`, `timings.json` and a
   * `manifest.json` that digests each of them, beside the `run.json` the verifier already wrote.
   */
  private writeBundle(
    attempt: AttemptRecord,
    run: VerificationRun,
  ): { readonly manifestDigest: string } {
    const { transcript, tools } = this.store.read((tx) => {
      const entries = replayTranscript(tx, attempt.id, TRANSCRIPT_SNAPSHOT_LIMIT)
      return {
        transcript: entries.entries,
        tools: entries.entries.filter((entry) => entry.k === 'tool'),
      }
    })
    const delegation = this.store.read((tx) => readDelegation(tx, attempt.delegationId))
    const diff =
      attempt.workspace.worktree === null
        ? ''
        : runGit(attempt.workspace.worktree, ['diff', attempt.workspace.baseRevision]).stdout
    try {
      return writeEvidenceBundle({
        evidenceRef: run.evidenceRef,
        diff,
        transcript,
        tools,
        cost: delegation?.spend ?? emptySpendCounters(),
        timings: {
          runId: run.runId,
          startedAt: run.startedAt,
          endedAt: run.endedAt,
          durationMs: Math.max(0, run.endedAt - run.startedAt),
        },
        run,
      })
    } catch (error) {
      this.noteBackgroundFailure('evidence', attempt.delegationId, attempt.id, error)
      return { manifestDigest: '' }
    }
  }

  private endAttempt(
    tx: WriteTx,
    attemptId: AttemptId,
    outcome: AttemptOutcome,
    terminal: DelegationState,
  ): void {
    const attempt = readAttempt(tx, attemptId)
    if (attempt === null) return
    this.putAttempt(tx, { ...attempt, outcome, endedAt: this.now() })
    const meta = this.attemptMeta(tx, attemptId)
    if (meta !== null) this.putAttemptMeta(tx, attemptId, { ...meta, terminal })
    const delegation = this.requireDelegation(tx, attempt.delegationId)
    this.putDelegation(tx, {
      ...delegation,
      liveAttempts: delegation.liveAttempts.filter((id) => id !== attemptId),
    })
    this.emit(
      tx,
      delegationStream(attempt.delegationId),
      { k: 'deleg.attempt_ended', attemptId, outcome },
      this.serverActor('attempt ended'),
      { delegationId: attempt.delegationId, attemptId },
    )
    const runtime = this.live.get(attemptId)
    if (runtime?.session !== null && runtime !== undefined) {
      const session = runtime.session
      runtime.session = null
      runtime.fence = null
      runtime.interruptAt = null
      /* C15 — `close()` is the ONLY lease release; there is no detach (§5.4 #9). The channel row
       * moves with it, so `deleg.channel` never leaves a head believing a dead session is idle. */
      const fresh = readAttempt(tx, attemptId)
      if (fresh !== null) this.moveChannel(tx, fresh, 'close', this.serverActor('attempt ended'))
      void session?.close('attempt ended')
      /* Released in **this** transaction: `endAttempt` already runs inside one, and the store is a
       * single writer with no nesting — a second `commit` here throws and takes the intent with
       * it, which is how `accept` and `cancel{scope:'delegation'}` both became `internal`. */
      if (session !== null) tx.releaseLease(sessionLease(session.sessionId), attemptId)
    }
  }

  /* ---------------------------------------------------------------------- other intents */

  private async retract(turnId: TurnId, ctx: IntentContext): Promise<RetractReport> {
    const plan = this.store.read((tx) => {
      const turn = readTurn(tx, turnId)
      if (turn === null) throw new SwarmError('not_found', `no turn ${turnId}`)
      const attempt = readAttempt(tx, turn.attemptId)
      const interruptMode =
        turn.effective.deliveryMode === 'interrupt' ||
        turn.effective.deliveryMode === 'next-safe-point'
      const siblings = interruptMode
        ? (attempt?.turns ?? [])
            .map((id) => readTurn(tx, id))
            .filter(
              (row): row is TurnRecord =>
                row !== null &&
                row.id !== turnId &&
                (row.delivery === 'sent' || row.delivery === 'accepted') &&
                (row.effective.deliveryMode === 'interrupt' ||
                  row.effective.deliveryMode === 'next-safe-point'),
            )
            .map((row) => row.id)
        : []
      return { turn, attempt, interruptMode, siblings }
    })

    /* §4.3.9's whole point is that no record may misdescribe a delivery. V12 is
     * `prepared → (deleted)` and nothing else, so `moveDelivery` refused a `sent` non-interrupt
     * turn and returned it unchanged — while the report still said `restoredTo:'deleted'` and the
     * turn was dequeued. A refusal is the honest answer; the message is already on the wire. */
    if (!plan.interruptMode && plan.turn.delivery !== 'prepared') {
      throw new SwarmError(
        'invalid_spec',
        `turn ${turnId} is already \`${plan.turn.delivery}\`; only a prepared turn can be retracted ` +
          '(interrupt-mode turns are retracted session-wide, §4.3.9)',
        { details: { turnId, delivery: plan.turn.delivery } },
      )
    }

    if (plan.interruptMode) {
      const runtime = plan.attempt === null ? undefined : this.live.get(plan.attempt.id)
      if (runtime !== undefined && runtime.session !== null && runtime.fence !== null) {
        /* §5.4 #16: the primitive takes only a session id, so this un-delivers EVERY pending
         * interrupt on that session. The report names all of them (§4.3.9). */
        await runtime.session.interrupt('retract', null, runtime.fence)
      }
    }

    const report = this.store.commit((tx) => {
      const affected = plan.interruptMode ? [turnId, ...plan.siblings] : [turnId]
      for (const id of affected) {
        const row = readTurn(tx, id)
        if (row === null) continue
        if (plan.interruptMode) {
          /* V14: back to `prepared` — leaving them at `sent` would be swarm asserting a delivery
           * it had itself cancelled. */
          this.moveDelivery(tx, row, 'retract_interrupt', ctx.actor)
        } else {
          this.moveDelivery(tx, row, 'retract_before_write', ctx.actor)
          if (plan.attempt !== null) this.dequeue(tx, plan.attempt.id, id)
        }
        tx.appendAudit({
          intent: 'retract',
          actor: ctx.actor,
          turnId: id,
          result: { sessionWide: plan.interruptMode },
          correlation: ctx.idempotencyKey,
        })
      }
      const built: RetractReport = {
        requested: turnId,
        alsoRetracted: plan.siblings,
        sessionWide: plan.interruptMode,
        restoredTo: plan.interruptMode ? 'prepared' : 'deleted',
      }
      if (plan.attempt !== null) {
        this.emit(
          tx,
          delegationStream(plan.attempt.delegationId),
          { k: 'deleg.turn_retracted', report: built },
          ctx.actor,
          { delegationId: plan.attempt.delegationId, attemptId: plan.attempt.id, turnId },
        )
      }
      return built
    }).value

    if (report.alsoRetracted.length > 0) {
      this.notice({
        kind: 'retract-cascade',
        severity: 'warn',
        title: 'Retract un-delivered more than one message',
        detail: `cancelSoftInterrupts is session-wide: ${report.alsoRetracted.length} other pending interrupt(s) were also retracted.`,
        actions: [],
        dismissible: true,
      })
    }
    return report
  }

  private async cancel(
    delegationId: DelegationId,
    options: { scope: 'turn' | 'delegation' | 'hard'; attemptId?: AttemptId },
    ctx: IntentContext,
  ): Promise<null> {
    const delegation = this.store.read((tx) => this.requireDelegation(tx, delegationId))
    const targets = options.attemptId === undefined ? delegation.liveAttempts : [options.attemptId]

    if (options.scope === 'turn') {
      for (const attemptId of targets) {
        const runtime = this.live.get(attemptId)
        if (runtime !== undefined && runtime.session !== null && runtime.fence !== null) {
          await runtime.session.interrupt('cancel', null, runtime.fence)
          /* C9 — `cancel` is an interrupt like any other; the session survives (§4.3.7). */
          this.issueInterrupt(attemptId, ctx.actor)
        }
      }
      this.audit(ctx, 'cancel', { delegationId, scope: 'turn' })
      return null
    }

    if (options.scope === 'hard') {
      /* §4.3.7 scopes this to "the process group swarm created for **that instance**". Iterating
       * the whole pool took down every other delegation sharing it — one user's hard cancel
       * killing work they never named, from an intent whose entire contract is a scope. */
      for (const key of this.instanceKeysOf(delegationId, targets)) {
        const instance = this.instances.get(key)
        if (instance === undefined) continue
        try {
          this.notePartialKill(await instance.hardKill('cancel{scope:hard}'), delegationId)
        } catch (error) {
          this.notice({
            kind: 'capability-absent',
            severity: 'error',
            title: 'Hard kill refused',
            detail: error instanceof Error ? error.message : String(error),
            delegationId,
            actions: [],
            dismissible: true,
          })
        }
      }
      this.audit(ctx, 'cancel', { delegationId, scope: 'hard' })
      return null
    }

    /* D17: `cancel{scope:'delegation'}` is the ONLY path to `cancelled` (#31). */
    this.store.commit((tx) => {
      const record = this.requireDelegation(tx, delegationId)
      const outcome = delegationMachine.transition(record.state, 'cancel_delegation')
      if (!outcome.ok || outcome.state === null) {
        throw new SwarmError('invalid_spec', `cannot cancel a ${record.state} delegation`)
      }
      for (const attemptId of record.attempts)
        this.endAttempt(tx, attemptId, 'cancelled', 'cancelled')
      const fresh = this.requireDelegation(tx, delegationId)
      this.putDelegation(tx, {
        ...fresh,
        state: 'cancelled',
        liveAttempts: [],
        version: fresh.version + 1,
      })
      this.refreshDelegationState(tx, delegationId, ctx.actor, 'cancelled')
      tx.appendAudit({
        intent: 'cancel',
        actor: ctx.actor,
        delegationId,
        effective: { scope: 'delegation', row: outcome.rowId },
        result: { ok: true },
        correlation: ctx.idempotencyKey,
      })
    })
    return null
  }

  /**
   * D19 — `retry` reopens as attempt *N+1*; `verdict` cleared, `landed` retained (Q2).
   *
   * §6.3 declares `retry(id, o?: {spec?, parallel?, injectPriorFailure?})` returning
   * `IntentResult<AttemptId[]>`. Two of the three options were dropped on the floor and the return
   * was the literal `[]` — so A2's "a retry may edit it" had no implementation, and a head that
   * asked which attempts it had just started got an empty answer every time.
   */
  private async retry(
    delegationId: DelegationId,
    options: {
      spec?: Partial<DelegationSpec>
      parallel?: 1 | 2 | 3
      injectPriorFailure?: boolean
    },
    ctx: IntentContext,
  ): Promise<readonly AttemptId[]> {
    const before = this.store.commit((tx) => {
      const record = this.requireDelegation(tx, delegationId)
      const outcome = delegationMachine.transition(record.state, 'retry')
      /* A2: the frozen spec copy an attempt carries may be edited by the retry that opens it. */
      const spec: DelegationSpec = {
        ...record.spec,
        ...options.spec,
        ...(options.parallel === undefined ? {} : { parallelAttempts: options.parallel }),
        /* `workspace` is never patchable here: a retry that moved the base or the write mode would
         * be a different delegation wearing the same id (C4b). */
        workspace: record.spec.workspace,
      }
      if (spec.parallelAttempts > this.config.caps.maxParallelAttempts) {
        throw new SwarmError(
          'invalid_spec',
          `parallelAttempts ${spec.parallelAttempts} exceeds the cap of ${this.config.caps.maxParallelAttempts}`,
        )
      }
      this.putDelegation(tx, {
        ...record,
        spec,
        state: outcome.ok && outcome.state !== null ? outcome.state : 'queued',
        verdict: null,
        version: record.version + 1,
      })
      /* D19 opens a **new admission epoch**: the slots this delegation already spent are what the
       * scheduler counts, and a reopen that did not reset them would never admit anything. */
      const meta = readMeta(tx, delegationId)
      if (meta !== null) {
        tx.putRecord('delegation_meta', delegationId, 1, {
          ...meta,
          openedInEpoch: 0,
          epochQueuedAt: this.now(),
          ...(options.injectPriorFailure === true
            ? { priorFailure: this.priorFailureSummary(tx, record) }
            : { priorFailure: undefined }),
        } satisfies DelegationMeta)
      }
      this.emitSummary(tx, delegationId, ctx.actor)
      tx.appendAudit({
        intent: 'retry',
        actor: ctx.actor,
        delegationId,
        effective: {
          parallel: spec.parallelAttempts,
          specPatched: Object.keys(options.spec ?? {}),
          injectPriorFailure: options.injectPriorFailure === true,
        },
        result: { ok: true },
        correlation: ctx.idempotencyKey,
      })
      return record.attempts
    }).value

    await this.tick()
    const after = this.store.read((tx) => this.requireDelegation(tx, delegationId).attempts)
    return after.filter((id) => !before.includes(id))
  }

  /**
   * What the previous attempt actually did wrong, in the words the evidence already uses. Injected
   * into the next attempt's objective so a retry is not the same prompt run twice.
   */
  private priorFailureSummary(tx: ReadTx, record: DelegationRecord): string {
    const attemptId = record.attempts.at(-1)
    const attempt = attemptId === undefined ? null : readAttempt(tx, attemptId)
    if (attempt === null) return 'The previous attempt did not report a reason.'
    const run = attempt.verifications.at(-1)
    const failed = (run?.results ?? []).filter((r) => r.status !== 'pass' && r.status !== 'manual')
    const lines = failed.map((r) => `- ${r.id} (${r.kind}): ${r.status}`)
    return [
      `The previous attempt ended \`${attempt.outcome}\`.`,
      ...(run === undefined ? [] : [`Its last verification returned \`${run.verdict}\`.`]),
      ...(lines.length === 0 ? [] : ['Criteria that did not pass:', ...lines]),
    ].join('\n')
  }

  /** A6: the new delegation carries `origin`, which is the lineage Q2 and A5 both need. */
  private branch(
    attemptId: AttemptId,
    options: { title?: string },
    ctx: IntentContext,
  ): DelegationId {
    const id = `d_${this.ids()}`
    this.store.commit((tx) => {
      const attempt = this.requireAttempt(tx, attemptId)
      const parent = this.requireDelegation(tx, attempt.delegationId)
      const record: DelegationRecord = {
        ...parent,
        id,
        version: 1,
        title: options.title ?? `${parent.title} (branch)`,
        state: 'queued',
        verdict: null,
        dispatchPaused: false,
        landed: null,
        attempts: [],
        liveAttempts: [],
        focusedAttempt: null,
        origin: { delegationId: parent.id, attemptId },
        createdAt: this.now(),
        updatedAt: this.now(),
        createdBy: ctx.actor,
        spend: emptySpendCounters(),
        lastNeedsYouReason: null,
      }
      this.putDelegation(tx, record)
      const parentMeta = readMeta(tx, parent.id)
      if (parentMeta !== null) tx.putRecord('delegation_meta', id, 1, parentMeta)
      this.emit(
        tx,
        fleetStream,
        {
          k: 'fleet.delegation_created',
          delegation: delegationVM(tx, record, this.projectionContext(tx)),
        },
        ctx.actor,
        { delegationId: id, correlationId: ctx.idempotencyKey },
      )
      tx.appendAudit({
        intent: 'branch',
        actor: ctx.actor,
        delegationId: id,
        attemptId,
        result: { origin: parent.id },
        correlation: ctx.idempotencyKey,
      })
    })
    void this.tick()
    return id
  }

  private async verify(
    delegationId: DelegationId,
    options: { attemptId?: AttemptId },
    ctx: IntentContext,
  ): Promise<string> {
    const attemptId = this.store.read((tx) => {
      const record = this.requireDelegation(tx, delegationId)
      return options.attemptId ?? record.liveAttempts[0] ?? record.attempts.at(-1) ?? null
    })
    if (attemptId === null) throw new SwarmError('not_found', 'this delegation has no attempt yet')
    this.commitPlain('verify_intent', (tx) => {
      const record = this.requireDelegation(tx, delegationId)
      if (record.state === 'failed') {
        /* D21 — `failed → failed`: re-verification appends a run, and a pass reaches `succeeded`
         * only via D19 then D10. The trigger existed in the table and was fired by nobody, so the
         * row was reachable only by reading it. */
        delegationMachine.transition(record.state, 'reverify')
        return
      }
      /* D8 from `waiting`, D9 from `running` — queued and applied at turn end (§3.3). */
      this.movePhase(tx, attemptId, 'verify')
      this.refreshDelegationState(tx, delegationId, ctx.actor)
    })
    this.audit(ctx, 'verify', { delegationId, attemptId })
    const run = await this.runVerification(attemptId, 'manual')
    return run?.runId ?? ''
  }

  /** D14 — `accept{note}` ⇒ `verdict='accepted'`, the **only** path for an unverifiable one (Q1). */
  private accept(
    delegationId: DelegationId,
    options: { note: string; attemptId?: AttemptId },
    ctx: IntentContext,
  ): null {
    if (typeof options?.note !== 'string' || options.note.trim().length === 0) {
      throw new SwarmError('invalid_spec', 'accept requires a note: a verdict needs a reason')
    }
    this.store.commit((tx) => {
      const record = this.requireDelegation(tx, delegationId)
      this.assertVersion(record, ctx.expectedVersion)
      const outcome = delegationMachine.transition(record.state, 'accept')
      if (!outcome.ok || outcome.state === null) {
        throw new SwarmError(
          'invalid_spec',
          `accept is only available from needs-you, not ${record.state}`,
        )
      }
      const attemptId = options.attemptId ?? record.liveAttempts[0] ?? record.attempts.at(-1)
      if (attemptId !== undefined) this.endAttempt(tx, attemptId, 'accepted', 'succeeded')
      const fresh = this.requireDelegation(tx, delegationId)
      this.putDelegation(tx, {
        ...fresh,
        state: 'succeeded',
        verdict: 'accepted',
        liveAttempts: [],
        version: fresh.version + 1,
      })
      this.refreshDelegationState(tx, delegationId, ctx.actor, 'succeeded')
      tx.appendAudit({
        intent: 'accept',
        actor: ctx.actor,
        delegationId,
        ...(attemptId === undefined ? {} : { attemptId }),
        effective: { note: options.note, row: outcome.rowId },
        result: { verdict: 'accepted' },
        correlation: ctx.idempotencyKey,
      })
    })
    return null
  }

  /** D20 — landing is a facet, not a state. */
  private land(delegationId: DelegationId, options: LandOptions, ctx: IntentContext): unknown {
    const setup = this.store.read((tx) => {
      const record = this.requireDelegation(tx, delegationId)
      const attempt = this.requireAttempt(tx, options.attemptId)
      return { record, attempt }
    })
    if (
      baseHasMoved(setup.attempt.workspace.root, setup.attempt.workspace.baseRevision) &&
      options.mode === 'commit'
    ) {
      /* §13: "a moved base produces `needs-you` with rebase/report/abandon, **never a silent
       * failure**". The previous version raised the notice and then landed anyway — a warning
       * followed by the exact action it warned about, which is worse than no warning: the record
       * says the work landed on a base that no longer exists. */
      this.store.commit((tx) => {
        const record = this.requireDelegation(tx, delegationId)
        this.putDelegation(tx, { ...record, lastNeedsYouReason: 'landing-conflict' })
        this.emitSummary(tx, delegationId, ctx.actor)
        tx.appendAudit({
          intent: 'land',
          actor: ctx.actor,
          delegationId,
          attemptId: options.attemptId,
          effective: { mode: options.mode, baseRevision: setup.attempt.workspace.baseRevision },
          result: { refused: 'base_moved' },
          correlation: ctx.idempotencyKey,
        })
      })
      this.notice({
        kind: 'landing-conflict',
        severity: 'error',
        title: 'The base has moved',
        detail:
          'Rebase, report or abandon — swarm never resolves a conflict on the agent’s behalf. ' +
          'A patch still applies cleanly to the recorded base; a commit no longer does.',
        delegationId,
        attemptId: options.attemptId,
        actions: [
          { intent: 'retry', label: 'Rebase — retry on the new base' },
          { intent: 'land', label: 'Report — land as a patch' },
          { intent: 'archive', label: 'Abandon' },
        ],
        dismissible: false,
      })
      throw new SwarmError(
        'base_moved',
        `the base ${setup.attempt.workspace.baseRevision.slice(0, 12)} has moved; rebase, report or abandon`,
        {
          details: {
            delegationId,
            attemptId: options.attemptId,
            baseRevision: setup.attempt.workspace.baseRevision,
          },
        },
      )
    }
    const landing = land({
      ...options,
      root: setup.attempt.workspace.root,
      worktree: setup.attempt.workspace.worktree ?? setup.attempt.workspace.root,
      baseRevision: setup.attempt.workspace.baseRevision,
      at: this.now(),
    })
    this.store.commit((tx) => {
      const record = this.requireDelegation(tx, delegationId)
      this.putDelegation(tx, { ...record, landed: landing, version: record.version + 1 })
      this.emit(tx, delegationStream(delegationId), { k: 'deleg.landed', landing }, ctx.actor, {
        delegationId,
        attemptId: options.attemptId,
      })
      this.emitSummary(tx, delegationId, ctx.actor)
      tx.appendAudit({
        intent: 'land',
        actor: ctx.actor,
        delegationId,
        attemptId: options.attemptId,
        effective: { mode: options.mode, targetBranch: options.targetBranch ?? null },
        result: landing,
        correlation: ctx.idempotencyKey,
      })
    })
    return landing
  }

  private discard(attemptId: AttemptId, ctx: IntentContext): null {
    this.store.commit((tx) => {
      const attempt = this.requireAttempt(tx, attemptId)
      this.endAttempt(tx, attemptId, 'abandoned', 'abandoned')
      if (attempt.workspace.worktree !== null) {
        removeWorktree(attempt.workspace.root, attempt.workspace.worktree)
      }
      this.refreshDelegationState(tx, attempt.delegationId, ctx.actor)
      tx.appendAudit({
        intent: 'discard',
        actor: ctx.actor,
        delegationId: attempt.delegationId,
        attemptId,
        result: { ok: true },
        correlation: ctx.idempotencyKey,
      })
    })
    return null
  }

  /** D15 — `archive{abandon:true}` is the only route to `abandoned`. */
  private archive(
    delegationId: DelegationId,
    options: { abandon?: boolean },
    ctx: IntentContext,
  ): null {
    this.store.commit((tx) => {
      const record = this.requireDelegation(tx, delegationId)
      if (options.abandon === true) {
        const outcome = delegationMachine.transition(record.state, 'archive_abandon')
        if (!outcome.ok || outcome.state === null) {
          throw new SwarmError(
            'invalid_spec',
            `archive{abandon} is only available from needs-you, not ${record.state}`,
          )
        }
        for (const attemptId of record.liveAttempts) {
          this.endAttempt(tx, attemptId, 'abandoned', 'abandoned')
        }
        const fresh = this.requireDelegation(tx, delegationId)
        this.putDelegation(tx, {
          ...fresh,
          state: 'abandoned',
          liveAttempts: [],
          version: fresh.version + 1,
        })
        this.refreshDelegationState(tx, delegationId, ctx.actor, 'abandoned')
      }
      /* The audit row outlives everything the archive removed (S13, Q20). */
      tx.appendAudit({
        intent: 'archive',
        actor: ctx.actor,
        delegationId,
        effective: { abandon: options.abandon === true },
        result: { ok: true },
        correlation: ctx.idempotencyKey,
      })
    })
    return null
  }

  private pauseDispatch(
    scope: { fleet: true } | { delegationId: DelegationId },
    paused: boolean,
    ctx: IntentContext,
  ): null {
    this.store.commit((tx) => {
      if ('fleet' in scope) {
        /* §3.5's write ordering: the row and the fan-out become durable together, so a restart
         * reads back the pause the user asked for instead of the absence of one (Q16). */
        tx.putRecord('server_flags', 'dispatch', 1, {
          dispatchPausedFleet: paused,
        } satisfies ServerFlags)
        this.dispatchPausedFleet = paused
        this.emit(
          tx,
          fleetStream,
          { k: 'fleet.caps', concurrency: this.concurrency(tx), dispatchPaused: paused },
          ctx.actor,
        )
      } else {
        const record = this.requireDelegation(tx, scope.delegationId)
        this.putDelegation(tx, {
          ...record,
          dispatchPaused: paused,
          version: record.version + 1,
        })
        this.emitSummary(tx, scope.delegationId, ctx.actor)
      }
      tx.appendAudit({
        intent: 'pauseDispatch',
        actor: ctx.actor,
        ...('fleet' in scope ? {} : { delegationId: scope.delegationId }),
        effective: { paused },
        result: { ok: true },
        correlation: ctx.idempotencyKey,
      })
    })
    if (!paused) void this.tick()
    return null
  }

  /**
   * D23 / Q16 / #31 — **a brake, not a delete.** Every in-flight turn is cancelled,
   * `dispatchPaused` is set fleet-wide, instances are optionally hard-killed, and **no delegation
   * changes state and no worktree is touched**. `KillReport`'s two literal-empty tuples are what
   * make a future implementation that terminalizes a delegation fail to typecheck.
   */
  private async killSwitch(
    options: { killInstances?: boolean },
    ctx: IntentContext,
  ): Promise<KillReport> {
    const turnsCancelled: TurnId[] = []
    const attemptsAffected: AttemptId[] = []
    const targets = this.store.read((tx) =>
      tx.listRecords<DelegationRecord>('delegation').flatMap((stored) =>
        stored.value.liveAttempts.map((attemptId) => ({
          attemptId,
          turnId: currentTurnId(tx, attemptId),
        })),
      ),
    )
    for (const target of targets) {
      attemptsAffected.push(target.attemptId)
      if (target.turnId !== null) turnsCancelled.push(target.turnId)
      const runtime = this.live.get(target.attemptId)
      if (runtime !== undefined && runtime.session !== null && runtime.fence !== null) {
        await runtime.session.interrupt('cancel', null, runtime.fence).catch(() => undefined)
      }
    }

    const instancesKilled: KillReport['instancesKilled'][number][] = []
    if (options.killInstances === true) {
      for (const instance of this.instances.values()) {
        try {
          const outcome = await instance.hardKill('kill switch')
          instancesKilled.push(outcome)
          this.notePartialKill(outcome, null)
        } catch (error) {
          this.notice({
            kind: 'capability-absent',
            severity: 'error',
            title: 'An instance could not be hard-killed',
            detail: error instanceof Error ? error.message : String(error),
            actions: [],
            dismissible: true,
          })
        }
      }
    }

    const report: KillReport = {
      at: this.now(),
      turnsCancelled,
      attemptsAffected,
      instancesKilled,
      dispatchPausedFleetWide: true,
      delegationsTerminated: [],
      worktreesRemoved: [],
    }
    this.dispatchPausedFleet = true
    this.store.commit((tx) => {
      /* Q16: "the switch always pauses" — and a switch whose pause evaporates on restart is not a
       * switch. The row is written in the same transaction as the report. */
      tx.putRecord('server_flags', 'dispatch', 1, {
        dispatchPausedFleet: true,
      } satisfies ServerFlags)
      /* D23 changes no state: the machine is consulted so the row id is on the audit row, and it
       * returns the state it was given. */
      for (const stored of tx.listRecords<DelegationRecord>('delegation')) {
        delegationMachine.transition(stored.value.state, 'kill_switch')
      }
      this.emit(tx, fleetStream, { k: 'fleet.kill_switch', report }, ctx.actor)
      this.emit(
        tx,
        fleetStream,
        { k: 'fleet.caps', concurrency: this.concurrency(tx), dispatchPaused: true },
        ctx.actor,
      )
      tx.appendAudit({
        intent: 'killSwitch',
        actor: ctx.actor,
        effective: { killInstances: options.killInstances === true },
        result: report,
        correlation: ctx.idempotencyKey,
      })
    })
    return report
  }

  /**
   * #35 — Q4 makes omission reset to the *delegation* default, which makes that default the knob
   * users actually reach for. It bumps `version`, writes an audit row, and applies **from the next
   * turn**; it never touches a turn in flight.
   */
  private updateDefaults(
    delegationId: DelegationId,
    patch: DelegationDefaultsPatch,
    ctx: IntentContext,
  ): null {
    const banned = assertEffortAllowed(patch.reasoningEffort ?? null)
    if (banned !== null) throw banned
    this.store.commit((tx) => {
      const record = this.requireDelegation(tx, delegationId)
      this.assertVersion(record, ctx.expectedVersion)
      const spec: DelegationSpec = {
        ...record.spec,
        model: {
          ...record.spec.model,
          ...(patch.model === undefined ? {} : { model: patch.model }),
          ...(patch.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: patch.reasoningEffort }),
        },
        ...(patch.delivery === undefined
          ? {}
          : { delivery: { ...record.spec.delivery, mode: patch.delivery } }),
        ...(patch.budget === undefined
          ? {}
          : { budget: { ...record.spec.budget, ...patch.budget } }),
        ...(patch.autoResendOnStrongEvidence === undefined
          ? {}
          : { autoResendOnStrongEvidence: patch.autoResendOnStrongEvidence }),
      }
      const next = this.putDelegation(tx, {
        ...record,
        spec,
        ...(patch.priority === undefined ? {} : { priority: patch.priority }),
        version: record.version + 1,
      })
      this.emit(
        tx,
        delegationStream(delegationId),
        { k: 'deleg.defaults_updated', patch, version: next.version },
        ctx.actor,
        { delegationId },
      )
      this.emitSummary(tx, delegationId, ctx.actor)
      tx.appendAudit({
        intent: 'updateDefaults',
        actor: ctx.actor,
        delegationId,
        effective: patch,
        result: { version: next.version },
        correlation: ctx.idempotencyKey,
      })
    })
    return null
  }

  /** The instances a delegation's attempts actually run on — the scope §4.3.7 names. */
  private instanceKeysOf(
    delegationId: DelegationId,
    attemptIds: readonly AttemptId[],
  ): readonly InstanceKey[] {
    return this.store.read((tx) => {
      const keys = new Set<InstanceKey>()
      for (const attemptId of attemptIds) {
        const attempt = readAttempt(tx, attemptId)
        if (attempt !== null) keys.add(attempt.executor.instanceKey)
      }
      if (keys.size === 0) {
        const meta = readMeta(tx, delegationId)
        if (meta !== null) keys.add(meta.instanceKey)
      }
      return [...keys]
    })
  }

  /**
   * §5.1/§4.3.7/§13: "an adapter that cannot resolve a `daemonPid` MUST report it … **and raise
   * `notice{kind:'capability-absent'}`**, because a kill that left the daemon alive must never be
   * reported as a completed stop."
   *
   * The adapter reported it faithfully; the server never looked. Only a *thrown* `hardKill` raised
   * a notice, so the one failure [F1] exists to catch — a bridge-only kill returning
   * `survivors: []` while the agent keeps writing to the worktree — arrived as a clean success.
   */
  private notePartialKill(outcome: KillOutcomeReport, delegationId: DelegationId | null): void {
    const reasons: string[] = []
    if (outcome.daemonPid === null) {
      reasons.push('the daemon pid could not be resolved from servers.json')
    } else if (!outcome.daemonStopped) {
      reasons.push(`the daemon (pid ${outcome.daemonPid}) survived the kill`)
    }
    if (outcome.survivors.length > 0) reasons.push(`survivors: ${outcome.survivors.join(', ')}`)
    if (reasons.length === 0) return
    this.notice({
      kind: 'capability-absent',
      severity: 'error',
      title: 'The hard kill did not stop everything',
      detail:
        `${reasons.join('; ')}. The daemon calls setsid(), so killing the bridge group alone ` +
        'stops nothing — the agent may still be writing to the worktree ([F1], §4.3.7).',
      ...(delegationId === null ? {} : { delegationId }),
      actions: [{ intent: 'cancel', label: 'Cancel the delegation' }],
      dismissible: false,
    })
  }

  private audit(ctx: IntentContext, intent: string, effective: unknown): void {
    this.store.commit((tx) => {
      tx.appendAudit({
        intent,
        actor: ctx.actor,
        effective,
        result: { ok: true },
        correlation: ctx.idempotencyKey,
      })
    })
  }

  /* ----------------------------------------------------------------------- reconciliation */

  private reconcile(delegationId: DelegationId, ctx: IntentContext): Promise<ReconcileReport> {
    return this.reconcileDelegation(delegationId, ctx.actor)
  }

  /**
   * §5.5's procedure. The lease is taken first — one reconciler per delegation — and the evidence
   * is gathered in the order the report renders it, so a head showing "four evidence lines and a
   * Reconcile action" is showing exactly what the decision was made from (X4).
   */
  private async reconcileDelegation(
    delegationId: DelegationId,
    actor: ActorRef,
  ): Promise<ReconcileReport> {
    const holder = `reconcile:${this.ids()}`
    const lease = this.store.commit((tx) =>
      tx.acquireLease(delegationLease(delegationId), holder, LEASES.reconciliationTtlMs),
    ).value
    if (lease === null) {
      throw new SwarmError('lease_held', 'another reconciliation holds this delegation')
    }
    try {
      const setup = this.store.read((tx) => {
        const record = this.requireDelegation(tx, delegationId)
        const attemptId = record.liveAttempts[0] ?? record.attempts.at(-1) ?? null
        const attempt = attemptId === null ? null : readAttempt(tx, attemptId)
        const turn = attempt === null ? null : currentTurn(tx, attempt)
        const toolEvents =
          attempt === null || turn === null ? 0 : this.countToolEvents(tx, attempt.id, turn.id)
        const ackLogged = turn !== null && turn.deliveryDetail.ackAtMs !== null
        return { record, attempt, turn, toolEvents, ackLogged }
      })

      /* §5.5's order is "take the lease → **reattach** → `tail(12)`". Reconciliation ran before
       * any reattach and `gatherEvidence` tailed only a session that happened to still be live,
       * so on the disconnect path — the case the protocol exists for — `digestInTail` was
       * structurally always `false`, and the strong-evidence row fired on a missing observation. */
      if (setup.attempt !== null) await this.reattachForEvidence(setup.attempt)
      const evidence = await this.gatherEvidence(setup)
      const decision = decideReconciliation(evidence, {
        autoResendOnStrongEvidence: setup.record.spec.autoResendOnStrongEvidence === true,
        turnDoneObserved: setup.turn?.delivery === 'ended',
      })

      const before: DeliveryState = setup.turn?.delivery ?? 'unknown'
      let after = before
      this.commitPlain('reconcile', (tx) => {
        if (setup.turn !== null && decision.delivery !== null) {
          const fresh = readTurn(tx, setup.turn.id)
          if (fresh !== null && fresh.delivery === 'unknown') {
            const moved = this.moveDelivery(tx, fresh, 'reconciled_positive', actor, {
              to: decision.delivery,
            })
            after = moved?.delivery ?? before
          }
        }
        tx.appendAudit({
          intent: 'reconcile',
          actor,
          delegationId,
          ...(setup.attempt === null ? {} : { attemptId: setup.attempt.id }),
          ...(setup.turn === null ? {} : { turnId: setup.turn.id }),
          effective: evidence,
          result: { outcome: decision.outcome },
        })
      })

      if (decision.outcome === 'resend-offered') {
        /* Q5: `unknown` **never** auto-resends by default. `sendMessage` has no idempotency key,
         * so a duplicated destructive turn is unrecoverable while a confirmation is annoying. */
        this.notice({
          kind: 'delivery-unknown',
          severity: 'warn',
          title: 'This message may never have arrived',
          detail:
            `no ack logged · digest absent from the tail · no workspace change since dispatch · ` +
            `session idle — resend requires your confirmation`,
          delegationId,
          ...(setup.attempt === null ? {} : { attemptId: setup.attempt.id }),
          ...(setup.turn === null ? {} : { turnId: setup.turn.id }),
          actions: [
            { intent: 'sendTurn', label: 'Resend' },
            { intent: 'discard', label: 'Discard' },
          ],
          dismissible: false,
        })
      }

      return {
        delegationId,
        attemptId: setup.attempt?.id ?? '',
        turnId: setup.turn?.id ?? null,
        outcome: decision.outcome,
        evidence,
        deliveryBefore: before,
        deliveryAfter: after,
        at: this.now(),
      }
    } finally {
      this.store.commit((tx) => tx.releaseLease(delegationLease(delegationId), holder))
    }
  }

  /**
   * One rung of C13's ladder, taken for the evidence rather than for the work: open the session,
   * take the writer lease with a fresh fence, and start the pump. It is the *same* reattach the
   * supervisor would do, which is why the supervisor then finds nothing to do.
   */
  private async reattachForEvidence(attempt: AttemptRecord): Promise<void> {
    const runtime = this.live.get(attempt.id)
    const sessionId = attempt.executor.sessionId
    if (runtime === undefined || sessionId === null) return
    if (runtime.session !== null || runtime.instance === null || runtime.reconnecting) return
    if (attempt.outcome !== 'open' && attempt.outcome !== 'interrupted') return

    let session: ExecutorSessionHandle
    try {
      session = await runtime.instance.openSession(sessionId)
    } catch {
      /* An unreachable session is not evidence of anything; the ladder still owns the retries. */
      return
    }
    const fence = this.store.commit((tx) => {
      const lease = tx.acquireLease(sessionLease(sessionId), attempt.id, LEASES.sessionTtlMs)
      if (lease === null) return null
      const fresh = readAttempt(tx, attempt.id)
      if (fresh !== null) {
        this.moveChannel(tx, fresh, 'reconnect', this.serverActor('reconciliation'))
        this.moveChannel(
          tx,
          this.requireAttempt(tx, attempt.id),
          'attached',
          this.serverActor('reconciliation'),
        )
      }
      return { key: lease.key, token: lease.token }
    }).value
    if (fence === null) {
      this.observed.leaseConflicts += 1
      await session.close('lease held by another writer').catch(() => undefined)
      return
    }
    runtime.session = session
    runtime.fence = fence
    /* §4.2: the shadow is invalidated on every reattach, forcing a re-assert before the next send. */
    runtime.shadow = { model: null, effort: undefined }
    void this.pump(attempt.id, session)
  }

  private async gatherEvidence(setup: {
    attempt: AttemptRecord | null
    turn: TurnRecord | null
    toolEvents: number
    ackLogged: boolean
  }): Promise<ReconcileEvidence> {
    let digestInTail = false
    let sessionIdle = true
    if (setup.attempt !== null && setup.turn !== null) {
      const runtime = this.live.get(setup.attempt.id)
      /* Re-read: the reattach above may have moved the channel, and §5.5 asks about the session
       * "observed `streaming` **on reattach**", not before it. */
      const attempt = this.store.read((tx) => readAttempt(tx, setup.attempt!.id)) ?? setup.attempt
      sessionIdle = attempt.channel !== 'streaming'
      if (runtime !== undefined && runtime.session !== null) {
        try {
          /* `peekSession`, never the other read ([F8]) — against `""` every turn looks un-landed. */
          const tail = await runtime.session.tail(12)
          digestInTail = digestPresentInTail(tail, setup.turn.directive.text)
        } catch {
          /* an unreachable session is not evidence of anything */
        }
      }
    }
    let workspaceMutated = false
    if (setup.attempt !== null && setup.attempt.workspace.worktree !== null) {
      const status = porcelainStatus(setup.attempt.workspace.worktree)
      const head = headRevision(setup.attempt.workspace.worktree)
      workspaceMutated =
        status.trim().length > 0 || (head !== null && head !== setup.attempt.workspace.baseRevision)
    }
    return {
      ackLogged: setup.ackLogged,
      digestInTail,
      workspaceMutated,
      toolEventsLogged: setup.toolEvents,
      sessionIdle,
    }
  }

  /**
   * §5.5's third clause is "any tool event logged **for this turn**", and the emphasis is the whole
   * rule. Counting the last 500 records of the entire `attempt:*` stream meant a *completed*
   * previous turn's tool call was read as positive evidence that the message under reconciliation
   * had landed — `decideReconciliation` then resumed observation on a turn that never arrived.
   */
  private countToolEvents(tx: ReadTx, attemptId: AttemptId, turnId: TurnId): number {
    const stream = attemptStream(attemptId)
    const head = tx.head(stream).head
    let count = 0
    for (const record of tx.readLog(stream, Math.max(0, head - 500), 500)) {
      if (record.ev.k === 'att.tool' && record.turnId === turnId) count += 1
    }
    return count
  }

  /* ------------------------------------------------------------------------ X16 sleep/stall */

  /**
   * §5.5's sleep detection. **The signature is a large wall gap with a near-zero monotonic gap** —
   * a large gap in *both* clocks is a process that ran for hours producing nothing, which is the
   * stall signature (W5). Reporting equal gaps as "asleep" would hide the exact failure stall
   * detection exists to catch, and would make tracking two clocks pointless.
   */
  sampleClock(wall = this.now(), mono = this.mono()): 'none' | 'asleep' | 'stalled' {
    const gap = classifyClockGap(
      wall - this.lastSample.wall,
      mono - this.lastSample.mono,
      this.config.timeouts.sleepDetectThresholdMs,
    )
    this.lastSample = { wall, mono }
    if (gap.kind === 'none') return 'none'
    if (gap.kind === 'stalled') {
      this.notice({
        /* `NoticeKind` has no `stall` member and it is a locked §6.4 union, so W5 rides `drift`
         * with a title that names it. Recorded as a deviation rather than widened silently. */
        kind: 'drift',
        severity: 'warn',
        title: 'Stalled — a long gap in both clocks (W5)',
        detail: `wall +${gap.wallGapMs} ms, monotonic +${gap.monoGapMs} ms — the process ran and produced nothing (W5).`,
        actions: [],
        dismissible: true,
      })
      return 'stalled'
    }

    /* Asleep: every channel disconnected, every in-flight turn `unknown`, the gap excluded from
     * `maxWallMs`, reconciliation for every affected delegation, and one notice. */
    const affected = this.store.commit((tx) => {
      const ids: DelegationId[] = []
      for (const stored of tx.listRecords<DelegationRecord>('delegation')) {
        const record = stored.value
        let touched = false
        for (const attemptId of record.liveAttempts) {
          const attempt = readAttempt(tx, attemptId)
          if (attempt === null) continue
          this.moveChannel(tx, attempt, 'socket_closed', this.serverActor('resumed from sleep'))
          const turn = currentTurn(tx, attempt)
          if (turn !== null && ['sent', 'accepted', 'running'].includes(turn.delivery)) {
            this.moveDelivery(
              tx,
              turn,
              turn.delivery === 'running' ? 'disconnect_before_turn_done' : 'disconnect_before_ack',
              this.serverActor('resumed from sleep'),
              { detail: { reason: 'the host slept; the provider stream is gone' } },
            )
            touched = true
          }
          this.movePhase(tx, attemptId, 'executor_disconnect')
        }
        /* `sleptMs` alone. Adding `wallGapMs` here too double-counted the suspend: the turn that
         * spanned it already carries the wall time, and `budgetFractions` subtracts `sleptMs`
         * exactly once (X16). Only delegations that were actually running slept on the clock. */
        if (record.liveAttempts.length > 0) {
          this.putDelegation(tx, {
            ...record,
            spend: addSpend(record.spend, { sleptMs: gap.sleptMs }),
          })
        }
        this.refreshDelegationState(tx, record.id, this.serverActor('resumed from sleep'))
        if (touched || record.liveAttempts.length > 0) ids.push(record.id)
      }
      return ids
    }).value

    this.notice({
      kind: 'resumed-from-sleep',
      severity: 'warn',
      title: 'Resumed from sleep',
      detail: `wall +${gap.wallGapMs} ms, monotonic +${gap.monoGapMs} ms, slept ${gap.sleptMs} ms.`,
      actions: [{ intent: 'reconcile', label: 'Reconcile' }],
      dismissible: true,
    })

    /* No mutating intent is accepted until reconciliation completes (X16). */
    this.reconciling = (async () => {
      for (const id of affected) {
        await this.reconcileDelegation(id, this.serverActor('resumed from sleep')).catch(
          () => undefined,
        )
      }
    })().finally(() => {
      this.reconciling = null
    })
    return 'asleep'
  }

  /* ------------------------------------------------------------------ §3.4 lease maintenance */

  /**
   * §3.4 rule 2: the writer lease has a 60 s TTL and is **renewed at 20 s**.
   *
   * Nothing renewed it, and `LEASES.sessionRenewMs` had no reader at all. Every real turn outlives
   * 60 s, after which `acquireLease` hands `session:*` to the next caller with a **new** fence —
   * and the reconnect ladder is exactly such a caller. The streaming writer's fence went stale
   * mid-turn and its next `applyConfig`/`submit`/`interrupt` was refused `stale_fence`: the writer
   * lease evicting the writer it exists to protect.
   *
   * The `home:*` leases ride along, for the same reason and with the same TTL.
   */
  renewLeases(at = this.now()): number {
    void at
    let renewed = 0
    this.store.commit((tx) => {
      for (const [attemptId, runtime] of this.live) {
        if (runtime.session === null) continue
        const lease = tx.renewLease(
          sessionLease(runtime.session.sessionId),
          attemptId,
          LEASES.sessionTtlMs,
        )
        if (lease !== null) renewed += 1
      }
      for (const key of this.instances.keys()) {
        const jcodeHome = join(this.layout.instancesDir, hashKey(key), 'home')
        if (tx.renewLease(homeLease(jcodeHome), `instance:${key}`, LEASES.sessionTtlMs) !== null) {
          renewed += 1
        }
      }
    })
    return renewed
  }

  /**
   * §3.4 rule 2's other half: **expiry never releases while a turn streams** — it marks the holder
   * `suspect` and blocks new submissions.
   *
   * `leaseStatus` had no caller, so `'suspect'` was a value the type system knew about and the
   * server never produced. Called before every send, which is the only moment at which "blocks new
   * submissions" means anything.
   */
  private assertWriterLease(attemptId: AttemptId, sessionId: string, streaming: boolean): void {
    const lease = this.store.read((tx) => tx.getLease(sessionLease(sessionId)))
    if (lease === null || lease.holder !== attemptId) {
      this.observed.leaseConflicts += 1
      throw new SwarmError('lease_held', `the writer lease for ${sessionId} is held elsewhere`, {
        details: { attemptId, sessionId, holder: lease?.holder ?? null },
      })
    }
    const status = leaseStatus(lease, this.now(), streaming)
    if (status === 'held') return
    this.observed.leaseConflicts += 1
    throw new SwarmError(
      'lease_held',
      status === 'suspect'
        ? `the writer lease for ${sessionId} expired while a turn streams; the holder is suspect`
        : `the writer lease for ${sessionId} has expired`,
      { details: { attemptId, sessionId, status } },
    )
  }

  /* ---------------------------------------------------------------------------- §2.3 retention */

  /**
   * §2.3's retention table, applied by the **server**.
   *
   * `advanceFloor` and `config.retention` had no server-side reader, so the `attempt:*` rule
   * ("7 d or 200 MB, then the floor rises") and the `server` stream's 30 days were rows in a table
   * nothing implemented: `lagged{reason:'retention'}` could only be produced by a test calling the
   * store directly. `fleet` and `delegation:*` are deliberately absent — "forever" and "delegation
   * lifetime" are not clock rules — and `audit` is exempt from all of it (S13, Q20).
   */
  applyRetention(at = this.now()): number {
    const attemptCutoff = at - this.config.retention.attemptStreamDays * 24 * 60 * 60_000
    const serverCutoff = at - SERVER_RETENTION.serverStreamDays * 24 * 60 * 60_000
    const attemptBytes = this.config.retention.attemptStreamMb * 1024 * 1024
    let removed = 0
    this.store.commit((tx) => {
      for (const row of tx.heads()) {
        if (row.stream === 'server') {
          removed += this.raiseFloor(tx, row.stream, row.floor, row.head, serverCutoff, Infinity)
          continue
        }
        if (!row.stream.startsWith('attempt:')) continue
        removed += this.raiseFloor(tx, row.stream, row.floor, row.head, attemptCutoff, attemptBytes)
      }
    })
    return removed
  }

  /** Walk from the floor forward until both the age and the size rule are satisfied. */
  private raiseFloor(
    tx: WriteTx,
    stream: StreamName,
    floor: number,
    head: number,
    cutoffTs: number,
    maxBytes: number,
  ): number {
    if (head <= floor) return 0
    const records = tx.readLog(stream, floor, Math.min(head - floor, SERVER_RETENTION.scanLimit))
    if (records.length === 0) return 0
    let total = 0
    for (const record of records) total += JSON.stringify(record.ev).length
    let next = floor
    let carried = total
    for (const record of records) {
      const overAge = record.ts < cutoffTs
      const overSize = carried > maxBytes
      if (!overAge && !overSize) break
      next = record.seq
      carried -= JSON.stringify(record.ev).length
    }
    if (next <= floor) return 0
    return tx.advanceFloor(stream, next)
  }

  /* --------------------------------------------------------------------------- §8.2 the judge */

  /**
   * A session for a review, on an instance of swarm's choosing and **never** the attempt's own.
   * Its writer lease is a real lease with a real fence, because §3.4 rule 1 applies to a judge's
   * mutating calls exactly as it does to an agent's.
   */
  private async openJudgeSession(input: {
    readonly workingDir: string
    readonly title: string
  }): Promise<JudgeSession> {
    const key = instanceKeyOf({
      model: this.config.defaults.model,
    } as unknown as DelegationSpec)
    const instance = await this.acquireInstance(key, {
      attempt: {
        workspace: { worktree: input.workingDir, root: input.workingDir },
        spec: { execution: { autoPoke: false } },
      } as unknown as AttemptRecord,
    })
    const session = await instance.createSession({
      workingDir: input.workingDir,
      title: input.title,
    })
    const holder = `judge:${this.ids()}`
    const lease = this.store.commit((tx) =>
      tx.acquireLease(sessionLease(session.sessionId), holder, LEASES.sessionTtlMs),
    ).value
    if (lease === null) {
      await session.close('judge could not take its writer lease').catch(() => undefined)
      this.observed.leaseConflicts += 1
      throw new SwarmError('lease_held', 'the judge session is already held')
    }
    return {
      session,
      fence: { key: lease.key, token: lease.token },
      model: this.config.defaults.model.model,
      release: async () => {
        await session.close('review finished').catch(() => undefined)
        this.store.commit((tx) => tx.releaseLease(sessionLease(session.sessionId), holder))
      },
    }
  }

  /* ---------------------------------------------------------------------------- scheduler */

  /**
   * One loop, ticked on every state change and every second (§7.1). **The unit of admission is an
   * attempt**: a delegation with `parallelAttempts: 3` presents three candidates and occupies
   * three slots, with distinct worktrees and distinct sessions by construction.
   */
  async tick(): Promise<void> {
    if (this.ticking || this.closed) return
    this.ticking = true
    try {
      const plan = this.store.read((tx) => this.planAdmissions(tx))
      for (const candidate of plan) {
        const attemptId = `a_${this.ids()}`
        await this.provision(candidate, attemptId).catch((error: unknown) => {
          this.failProvisioning(candidate.delegationId, attemptId, error)
        })
      }
    } finally {
      this.ticking = false
    }
  }

  private planAdmissions(tx: ReadTx): readonly AdmissionCandidate[] {
    const candidates: AdmissionCandidate[] = []
    for (const stored of tx.listRecords<DelegationRecord>('delegation')) {
      const record = stored.value
      if (delegationMachine.isTerminal(record.state)) continue
      if (record.state !== 'queued' && record.liveAttempts.length >= record.spec.parallelAttempts) {
        continue
      }
      const meta = readMeta(tx, record.id)
      if (meta === null) continue
      /**
       * The **epoch** is what bounds this, not the live count. `liveAttempts` shrinks when an
       * attempt ends, and a `wanted` derived from it re-admits a replacement for every attempt
       * that ever finished — an unbounded token-spend loop on any delegation whose siblings end
       * while one keeps running, which §3.3 explicitly permits ("the first attempt to reach
       * `verified` does **not** terminate its siblings"). D2 opens up to `parallelAttempts` per
       * epoch; only D19 (`retry`, or a late follow-up `sendTurn`) opens a new one.
       */
      const opened = meta.openedInEpoch ?? record.attempts.length
      const wanted = Math.min(
        record.spec.parallelAttempts - opened,
        record.spec.parallelAttempts - record.liveAttempts.length,
      )
      for (let i = 0; i < wanted; i++) {
        candidates.push({
          delegationId: record.id,
          siblingIndex: record.liveAttempts.length + i,
          priority: record.priority,
          /* Per epoch, not per record: a D19 reopen that carried `createdAt` outranked every
           * newer delegation forever under the aging guard (F7). */
          queuedAt: meta.epochQueuedAt ?? record.createdAt,
          workspaceId: record.spec.workspace.workspaceId,
          providerModel: `${record.spec.model.provider}/${record.spec.model.model}`,
          instanceKey: meta.instanceKey,
          createdByCopilot: record.createdBy.kind === 'copilot',
          budgetHardBreached: classifyBudget(record.spend, record.spec.budget).level === 'hard',
          delegationPaused: record.dispatchPaused,
        })
      }
    }

    let state: AdmissionState = {
      runningAttempts: this.concurrency(tx).runningAttempts,
      perWorkspace: {},
      perProviderModel: {},
      perRepoWorktrees: {},
      copilotAttempts: 0,
      fleetPaused: this.dispatchPausedFleet,
    }
    for (const stored of tx.listRecords<DelegationRecord>('delegation')) {
      const record = stored.value
      const n = record.liveAttempts.length
      if (n === 0) continue
      const key = record.spec.workspace.workspaceId
      const pm = `${record.spec.model.provider}/${record.spec.model.model}`
      state = {
        ...state,
        perWorkspace: { ...state.perWorkspace, [key]: (state.perWorkspace[key] ?? 0) + n },
        perProviderModel: {
          ...state.perProviderModel,
          [pm]: (state.perProviderModel[pm] ?? 0) + n,
        },
        copilotAttempts: state.copilotAttempts + (record.createdBy.kind === 'copilot' ? n : 0),
      }
    }

    const admitted: AdmissionCandidate[] = []
    for (const candidate of orderCandidates(candidates)) {
      const meta = readMeta(tx, candidate.delegationId)
      const repoRoot = meta?.workspaceRoot ?? ''
      const decision = admissionDecision(candidate, state, this.config.caps, repoRoot)
      if (!decision.admit) continue
      admitted.push(candidate)
      state = withAdmitted(state, candidate, repoRoot)
    }
    return admitted
  }

  /** D2 → D4: the slot, the leases, the worktree, the session, and then the first turn. */
  private async provision(candidate: AdmissionCandidate, attemptId: AttemptId): Promise<void> {
    const prepared = this.store.commit((tx) => {
      const record = this.requireDelegation(tx, candidate.delegationId)
      const meta = readMeta(tx, record.id)
      if (meta === null) throw new SwarmError('internal', 'delegation meta is missing')
      const attemptNo = record.attempts.length + 1
      const worktreePath = join(this.layout.worktreesDir, record.id, String(attemptNo))

      /* F4: one writing attempt per working tree; siblings take DISTINCT worktrees. */
      const lease = tx.acquireLease(worktreeLease(worktreePath), attemptId, LEASES.sessionTtlMs)
      if (lease === null) throw new SwarmError('lease_held', `worktree ${worktreePath} is held`)

      const attempt: AttemptRecord = {
        recordVersion: 1,
        id: attemptId,
        delegationId: record.id,
        attemptNo,
        spec: record.spec,
        executor: {
          adapterId: this.adapter.id,
          instanceKey: meta.instanceKey,
          sessionId: null,
          versions: {},
        },
        workspace: {
          root: meta.workspaceRoot,
          worktree: record.spec.workspace.writeMode === 'worktree' ? worktreePath : null,
          baseRevision: record.spec.workspace.baseRevision,
          staleBase: false,
        },
        channel: 'detached',
        turns: [],
        verifications: [],
        evidence: null,
        startedAt: this.now(),
        endedAt: null,
        outcome: 'open',
      }
      this.putAttempt(tx, attempt)
      this.putAttemptMeta(tx, attemptId, {
        phase: 'provisioning',
        terminal: null,
        queuedAt: this.now(),
        repoRoot: meta.workspaceRoot,
        workspaceId: record.spec.workspace.workspaceId,
        providerModel: candidate.providerModel,
        instanceKey: meta.instanceKey,
        pendingTurns: [],
        siblingIndex: candidate.siblingIndex,
        reconnectTries: 0,
      })
      /* D2 — the delegation leaves `queued` on the first admitted attempt. */
      delegationMachine.transition('queued', 'admitted')
      /* The epoch's slot is spent **here**, durably, in the same transaction that creates the
       * attempt: a slot that were only inferred from `liveAttempts` comes back when the attempt
       * ends, and the scheduler opens another one. */
      tx.putRecord('delegation_meta', record.id, 1, {
        ...meta,
        openedInEpoch: (meta.openedInEpoch ?? record.attempts.length) + 1,
        epochQueuedAt: meta.epochQueuedAt ?? record.createdAt,
      } satisfies DelegationMeta)
      this.putDelegation(tx, {
        ...record,
        attempts: [...record.attempts, attemptId],
        liveAttempts: [...record.liveAttempts, attemptId],
        focusedAttempt: record.focusedAttempt ?? attemptId,
        version: record.version + 1,
      })
      this.refreshDelegationState(tx, record.id, this.serverActor('scheduler'))
      return { attempt, delegation: record, fence: { key: lease.key, token: lease.token } }
    }).value

    const runtime = this.runtimeOf(attemptId)

    if (prepared.attempt.workspace.worktree === null) {
      /* `in-place`: the session's working directory is the registered root itself, so S6 runs
       * against that registration — on the resolved path, again, at use time (§7.3). */
      this.guard.assertInsideWorkspace(
        prepared.delegation.spec.workspace.workspaceId,
        prepared.attempt.workspace.root,
      )
    } else {
      createWorktree({
        root: prepared.attempt.workspace.root,
        path: prepared.attempt.workspace.worktree,
        baseRevision: prepared.attempt.workspace.baseRevision,
        branch: `swarm/${attemptId}`,
      })
      /* S6 again, on the resolved worktree path — against **swarm's own** worktree root (§7.2),
       * not the repository. A worktree is deliberately outside the repo it was cut from; the
       * check that matters is that the path swarm just handed the agent is still inside the
       * directory swarm owns, which a symlinked `$SWARM_HOME/worktrees` would not be. */
      assertPathInsideRoot(
        this.layout.worktreesDir,
        prepared.attempt.workspace.worktree,
        'worktree',
      )
    }

    const instance = await this.acquireInstance(prepared.attempt.executor.instanceKey, prepared)
    const workingDir = prepared.attempt.workspace.worktree ?? prepared.attempt.workspace.root
    /* C1 → C2: the session is created and attached, and the writer lease's fence is taken. */
    const session = await instance.createSession({ workingDir, title: prepared.delegation.title })

    const fence = this.store.commit((tx) => {
      const lease = tx.acquireLease(sessionLease(session.sessionId), attemptId, LEASES.sessionTtlMs)
      if (lease === null) throw new SwarmError('lease_held', 'the writer lease is held')
      const attempt = this.requireAttempt(tx, attemptId)
      const attached = this.putAttempt(tx, {
        ...attempt,
        executor: { ...attempt.executor, sessionId: session.sessionId },
      })
      this.moveChannel(tx, attached, 'connection_opened', this.serverActor('adapter'))
      const attaching = this.requireAttempt(tx, attemptId)
      this.moveChannel(tx, attaching, 'attached', this.serverActor('adapter'))
      this.emit(
        tx,
        delegationStream(prepared.attempt.delegationId),
        {
          k: 'deleg.attempt_started',
          attempt: attemptVM(tx, this.requireAttempt(tx, attemptId), this.projectionContext(tx)),
        },
        this.serverActor('scheduler'),
        { delegationId: prepared.attempt.delegationId, attemptId },
      )
      return { key: lease.key, token: lease.token }
    }).value

    runtime.session = session
    runtime.instance = instance
    runtime.fence = fence
    runtime.shadow = { model: null, effort: undefined }
    void this.pump(attemptId, session)

    /* The objective is the first turn (D4: "session created + attached, first turn submitted"). */
    this.commitPlain('first_turn', (tx) => {
      const pending =
        tx.getRecord<TurnId[]>('delegation_pending', prepared.delegation.id)?.value ?? []
      const meta = this.attemptMeta(tx, attemptId)
      const attempt = this.requireAttempt(tx, attemptId)
      const claimed: TurnId[] = []
      for (const turnId of pending) {
        const turn = readTurn(tx, turnId)
        if (turn === null) continue
        this.putTurn(tx, { ...turn, attemptId })
        claimed.push(turnId)
      }
      if (claimed.length === 0) {
        const objective = this.objectiveTurn(tx, prepared.delegation, attemptId)
        claimed.push(objective.id)
      }
      this.putAttempt(tx, { ...attempt, turns: [...attempt.turns, ...claimed] })
      if (meta !== null) {
        this.putAttemptMeta(tx, attemptId, {
          ...meta,
          pendingTurns: [...meta.pendingTurns, ...claimed],
        })
      }
      tx.deleteRecord('delegation_pending', prepared.delegation.id)
      /* D4: `provisioning → running`. */
      this.movePhase(tx, attemptId, 'attempt_attached')
      this.refreshDelegationState(tx, prepared.delegation.id, this.serverActor('scheduler'))
    })

    await this.dispatchQueue(attemptId)
  }

  private objectiveTurn(
    tx: WriteTx,
    delegation: DelegationRecord,
    attemptId: AttemptId,
  ): TurnRecord {
    const priorFailure = readMeta(tx, delegation.id)?.priorFailure
    const text = [
      delegation.spec.objective,
      delegation.spec.constraints === undefined
        ? ''
        : `\n\nConstraints: ${delegation.spec.constraints}`,
      /* `retry{injectPriorFailure}` (§6.3): consumed once, so attempt N+2 does not inherit N's. */
      priorFailure === undefined ? '' : `\n\nThe previous attempt:\n${priorFailure}`,
    ].join('')
    if (priorFailure !== undefined) {
      const meta = readMeta(tx, delegation.id)
      if (meta !== null) {
        tx.putRecord('delegation_meta', delegation.id, 1, {
          ...meta,
          priorFailure: undefined,
        } satisfies DelegationMeta)
      }
    }
    const directive: TurnDirective = {
      text,
      attemptId,
      delivery: 'after-turn',
      idempotencyKey: `objective:${delegation.id}:${attemptId}`,
    }
    const actor = this.serverActor('objective')
    const effective = effectiveTurnConfig({
      directive,
      defaults: {
        provider: delegation.spec.model.provider,
        model: delegation.spec.model.model,
        reasoningEffort: delegation.spec.model.reasoningEffort,
        delivery: delegation.spec.delivery.mode,
      },
      executorVersions: {},
    })
    const turn: TurnRecord = {
      recordVersion: 1,
      id: `t_${this.ids()}`,
      attemptId,
      ordinal: 1,
      directive,
      effective,
      promptDigest: digest(text),
      attachmentDigests: [],
      contextBundles: [],
      delivery: 'prepared',
      deliveryDetail: { ackAtMs: null, correlated: false, landing: 'n/a' },
      usage: null,
      toolCallCount: 0,
      startedAt: this.now(),
      endedAt: null,
      actor,
    }
    this.putTurn(tx, turn)
    this.emit(
      tx,
      delegationStream(delegation.id),
      { k: 'deleg.turn_prepared', turn: turnVM(turn, this.now()) },
      actor,
      { delegationId: delegation.id, attemptId, turnId: turn.id },
    )
    return turn
  }

  private async acquireInstance(
    key: InstanceKey,
    prepared: { attempt: AttemptRecord },
  ): Promise<ExecutorInstance> {
    const existing = this.instances.get(key)
    if (existing !== undefined) return existing
    const jcodeHome = join(this.layout.instancesDir, hashKey(key), 'home')

    /**
     * §7.1's "an attempt is admitted only when *all* hold: … `home:*` lease", and §3.4 rule 3's
     * singleton per `JCODE_HOME`. The holder is the **instance**, not the attempt: sibling
     * attempts share one instance and one home by construction, so an attempt-scoped holder would
     * have made the second sibling fight the first for a resource they are meant to share.
     *
     * The adapter takes `instances/<hash>/lock` in the same breath (§7.2). Two locks, because they
     * guard against two different intruders: this one against another attempt in *this* server,
     * that one against another process entirely — which is the one that corrupts the state dir.
     */
    const lease = this.store.commit((tx) =>
      tx.acquireLease(homeLease(jcodeHome), `instance:${key}`, LEASES.sessionTtlMs),
    ).value
    if (lease === null) {
      this.observed.leaseConflicts += 1
      throw new SwarmError('lease_held', `jcode home ${jcodeHome} is held by another instance`, {
        details: { key, jcodeHome },
      })
    }

    const instance = await this.adapter.acquireInstance(key, {
      jcodeHome,
      workingDir: prepared.attempt.workspace.worktree ?? prepared.attempt.workspace.root,
      /* S10: explicit, never defaulted — the SDK's `true` spends the user's subscription quota. */
      inheritLogins: this.config.executor.inheritLogins,
      env: buildInstanceEnv(this.config, jcodeHome, prepared.attempt.spec.execution.autoPoke),
      argv: this.config.executor.bridgeArgv,
      startupTimeoutMs: 20_000,
      cleanupTimeoutMs: 5_000,
      inheritStderr: false,
    })
    this.instances.set(key, instance)
    return instance
  }

  /**
   * D5 — preflight/worktree/instance error after **3 bounded retries**.
   *
   * The retries are the point, and they were unreachable. The old version bumped a counter and
   * returned for the first two failures **without touching the half-built attempt**: it stayed in
   * `liveAttempts`, so `wanted` computed to 0 forever, no second attempt was ever provisioned, and
   * failures 2 and 3 could not happen. A single transient `acquireInstance` refusal wedged the
   * delegation in `provisioning` permanently, holding a `worktree:*` lease and a worktree
   * directory nothing would ever reclaim, and `provision_failed` — D5's own trigger — appeared
   * nowhere outside the state table.
   *
   * So each failure now **rolls its attempt back** (lease, worktree, epoch slot) and requeues; the
   * third fires D5 for real.
   */
  private failProvisioning(delegationId: DelegationId, attemptId: AttemptId, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    const outcome = this.store.commit((tx) => {
      const record = readDelegation(tx, delegationId)
      if (record === null) return 'gone' as const
      const failures = tx.bumpCounter(`provision_failures:${delegationId}`, 1)
      this.rollbackProvisioning(tx, delegationId, attemptId)

      if (failures < SERVER_POLICY.provisionRetries) {
        /* Back to `queued`: the slot is free, the worktree is gone, and the next tick may try
         * again. This is the state the bounded retry was always supposed to run from. */
        this.refreshDelegationState(tx, delegationId, this.serverActor('provisioning'), 'queued')
        tx.appendAudit({
          intent: 'provision',
          actor: this.serverActor('provisioning'),
          delegationId,
          attemptId,
          effective: { attempt: failures, of: SERVER_POLICY.provisionRetries },
          result: { retrying: true, error: detail },
        })
        return 'retrying' as const
      }

      /* D5 proper. Every remaining live attempt is ended and the row id is on the audit trail. */
      for (const live of this.requireDelegation(tx, delegationId).liveAttempts) {
        this.movePhase(tx, live, 'provision_failed')
        this.endAttempt(tx, live, 'failed', 'failed')
      }
      const fresh = this.requireDelegation(tx, delegationId)
      this.putDelegation(tx, {
        ...fresh,
        state: 'failed',
        liveAttempts: [],
        version: fresh.version + 1,
      })
      this.refreshDelegationState(tx, delegationId, this.serverActor('provisioning'), 'failed')
      tx.appendAudit({
        intent: 'provision',
        actor: this.serverActor('provisioning'),
        delegationId,
        attemptId,
        effective: { attempt: failures, of: SERVER_POLICY.provisionRetries, row: 'D5' },
        result: { error: detail },
      })
      return 'failed' as const
    }).value

    if (outcome !== 'failed') return
    this.notice({
      kind: 'doctor-blocked',
      severity: 'error',
      title: 'Provisioning failed',
      detail: `${detail} (after ${SERVER_POLICY.provisionRetries} attempts)`,
      delegationId,
      actions: [{ intent: 'retry', label: 'Retry' }],
      dismissible: true,
    })
  }

  /**
   * Undo a half-built attempt so the slot, the lease and the disk all come back.
   *
   * An attempt that never attached has no session, no transcript and no evidence: deleting it is
   * honest, and leaving it in `attempts` would have made D5's "after 3 retries" read as three
   * abandoned attempts on a delegation the user never got to see start.
   */
  private rollbackProvisioning(
    tx: WriteTx,
    delegationId: DelegationId,
    attemptId: AttemptId,
  ): void {
    const attempt = readAttempt(tx, attemptId)
    const record = this.requireDelegation(tx, delegationId)
    const meta = readMeta(tx, delegationId)
    if (meta !== null) {
      tx.putRecord('delegation_meta', delegationId, 1, {
        ...meta,
        openedInEpoch: Math.max(0, (meta.openedInEpoch ?? record.attempts.length) - 1),
      } satisfies DelegationMeta)
    }
    this.putDelegation(tx, {
      ...record,
      attempts: record.attempts.filter((id) => id !== attemptId),
      liveAttempts: record.liveAttempts.filter((id) => id !== attemptId),
      focusedAttempt: record.focusedAttempt === attemptId ? null : record.focusedAttempt,
    })
    if (attempt === null) return

    /* Any turn the attempt had already claimed goes back to the delegation's pending queue: it was
     * prepared (V1) and never written, so it is still owed to whichever attempt starts next. */
    if (attempt.turns.length > 0) {
      const pending = tx.getRecord<TurnId[]>('delegation_pending', delegationId)?.value ?? []
      const restored = attempt.turns.filter((id) => !pending.includes(id))
      if (restored.length > 0) {
        tx.putRecord('delegation_pending', delegationId, 1, [...pending, ...restored])
      }
    }
    tx.deleteRecord('attempt', attemptId)
    tx.deleteRecord('attempt_meta', attemptId)
    if (attempt.workspace.worktree !== null) {
      tx.releaseLease(worktreeLease(attempt.workspace.worktree), attemptId)
      try {
        removeWorktree(attempt.workspace.root, attempt.workspace.worktree)
      } catch {
        /* A worktree that will not come off disk is a disk problem, not a scheduling one; the
         * lease is already back, which is what the next admission needs. */
      }
    }
    this.live.delete(attemptId)
  }

  /* ------------------------------------------------------------------------------ shutdown */

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.timer !== null) clearInterval(this.timer)
    for (const runtime of this.live.values()) {
      /* C15 again: `close()` is the only release, on shutdown as everywhere else. */
      await runtime.session?.close('server shutting down').catch(() => undefined)
    }
    for (const [key, instance] of this.instances) {
      await instance.dispose('server shutting down').catch(() => undefined)
      /* The `home:*` singleton goes back on a clean shutdown, so a restart inside the TTL is not
       * refused by a lease its own previous boot is still holding (§3.4 rule 3). */
      const jcodeHome = join(this.layout.instancesDir, hashKey(key), 'home')
      this.store.commit((tx) => tx.releaseLease(homeLease(jcodeHome), `instance:${key}`))
    }
    this.live.clear()
    this.instances.clear()
  }

  /** Diff for a live attempt (`att.diff`) — used by the head and by the evidence bundle. */
  attemptDiff(attemptId: AttemptId): ReturnType<typeof diffAgainstBase> | null {
    const attempt = this.store.read((tx) => readAttempt(tx, attemptId))
    if (attempt === null || attempt.workspace.worktree === null) return null
    return diffAgainstBase(attempt.workspace.worktree, attempt.workspace.baseRevision, attemptId)
  }
}

/* --------------------------------------------------------------------------------- helpers */

/** How much of an `attempt:*` transcript a snapshot carries; the rest is `hasOlder` (§6.2). */
export const TRANSCRIPT_SNAPSHOT_LIMIT = 500

/**
 * Rebuild an attempt's transcript from the **durable log** (§5.4 #2, §8.5).
 *
 * The log is the only authority here. `tail()` is pinned to `peekSession` and used *only* for
 * prompt-digest matching ([F8], §5.5), and jcode has no replay at all, so a snapshot built from
 * anything but swarm's own rows would come back short after a restart — silently, and exactly
 * when the evidence matters most.
 */
export function replayTranscript(
  tx: ReadTx,
  attemptId: AttemptId,
  limit: number,
): { entries: readonly TranscriptEntry[]; hasOlder: boolean } {
  const stream = attemptStream(attemptId)
  const bounds = tx.head(stream)
  const entries: TranscriptEntry[] = []
  let cursor = bounds.floor
  for (;;) {
    const batch = tx.readLog(stream, cursor, 256)
    if (batch.length === 0) break
    for (const record of batch) {
      const entry = transcriptEntryOf(record.ev, record.ts)
      if (entry !== null) entries.push(entry)
    }
    cursor = batch[batch.length - 1]!.seq
  }
  const trimmed = entries.length > limit ? entries.slice(entries.length - limit) : entries
  return { entries: trimmed, hasOlder: bounds.floor > 0 || trimmed.length < entries.length }
}

/** The `att.*` half of §6.4 → §6.2's `TranscriptEntry`. Anything else is not transcript. */
function transcriptEntryOf(event: SwarmEvent, at: number): TranscriptEntry | null {
  switch (event.k) {
    case 'att.text':
      return { k: 'text', text: event.text, at }
    case 'att.reasoning':
      return { k: 'reasoning', text: event.text, at, collapsed: true }
    case 'att.tool':
      return {
        k: 'tool',
        callId: event.callId,
        name: event.name,
        target: event.target,
        status: event.status,
        output: event.output ?? null,
        durationMs: event.durationMs ?? null,
      }
    case 'att.usage':
      return { k: 'usage', input: event.input, output: event.output }
    case 'att.background':
      return {
        k: 'background',
        taskId: event.taskId,
        label: event.label,
        provenance: 'scraped',
        ...(event.percent === undefined ? {} : { percent: event.percent }),
      }
    case 'att.error':
      return { k: 'notice', text: `${event.code}: ${event.message}` }
    default:
      return null
  }
}

function currentTurn(tx: ReadTx, attempt: AttemptRecord): TurnRecord | null {
  for (let i = attempt.turns.length - 1; i >= 0; i--) {
    const turn = readTurn(tx, attempt.turns[i]!)
    if (turn === null) continue
    if (turn.delivery !== 'ended' && turn.delivery !== 'failed') return turn
  }
  const last = attempt.turns.at(-1)
  return last === undefined ? null : readTurn(tx, last)
}

function currentTurnId(tx: ReadTx, attemptId: AttemptId): TurnId | null {
  const attempt = readAttempt(tx, attemptId)
  if (attempt === null) return null
  return currentTurn(tx, attempt)?.id ?? null
}

function targetOf(input: string | undefined): string | null {
  if (input === undefined) return null
  const match = /"(?:path|file|command|cmd)"\s*:\s*"([^"]+)"/.exec(input)
  return match?.[1] ?? null
}

function autoTitle(objective: string): string {
  const first = objective.split('\n')[0]?.trim() ?? 'Delegation'
  return first.length <= 72 ? first : `${first.slice(0, 69)}…`
}

/** `<provider>/<credentialScope>` — **two** dimensions, permanently (#26, #20, [F4]). */
export function instanceKeyOf(spec: DelegationSpec): InstanceKey {
  return `${spec.model.provider}/default`
}

function hashKey(key: InstanceKey): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 16)
}

function buildInstanceEnv(
  config: SwarmServerConfig,
  jcodeHome: string,
  autoPoke: boolean,
): Record<string, string> {
  const runtimeDir = join(jcodeHome, '..', 'runtime')
  const env = scrubbedEnv({
    JCODE_HOME: jcodeHome,
    JCODE_RUNTIME_DIR: runtimeDir,
    JCODE_API_SOCKET: join(runtimeDir, 'api.sock'),
    JCODE_SOCKET: join(runtimeDir, 'jcode.sock'),
    JCODE_SWARM_ENABLED: 'false',
    JCODE_MEMORY_ENABLED: 'false',
    JCODE_NO_TELEMETRY: '1',
    JCODE_NON_INTERACTIVE: '1',
    JCODE_AUTO_POKE: autoPoke ? '1' : '0',
  })
  for (const name of config.executor.envAllowlist) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

function serializeResult(result: IntentResult<unknown>): unknown {
  return result.ok
    ? { ok: true, value: result.value, version: result.version }
    : { ok: false, error: result.error.toJSON() }
}

/**
 * §13: an idempotency-cache hit returns the original response **including the original error**. A
 * retry that re-executes and succeeds where the first attempt failed is a duplicate side effect
 * wearing an `ok`, so the error is rebuilt rather than dropped.
 */
function deserializeResult(stored: unknown): IntentResult<unknown> {
  const row = stored as { ok?: boolean; value?: unknown; version?: number; error?: unknown }
  if (row.ok === true) return { ok: true, value: row.value, version: row.version ?? 0 }
  return {
    ok: false,
    error: swarmErrorFromWire((row.error ?? { code: 'internal' }) as { code: unknown }),
  }
}
