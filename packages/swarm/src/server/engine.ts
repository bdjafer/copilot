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
import { join } from 'node:path'
import { ulid } from 'ulid'

import type { LogRecord, ReadTx, SwarmStore, WriteTx } from '../log/types.ts'
import type { SwarmEvent } from '../protocol/events.ts'
import type { StreamName } from '../protocol/frames.ts'
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
} from './executor/types.ts'
import type { AttemptRuntime, DelegationMeta } from './projections.ts'
import type { ReconcileEvidence } from './reconcile.ts'
import type { AdmissionCandidate, AdmissionState } from './scheduler.ts'

import { addSpend, classifyBudget, classifyClockGap, emptySpendCounters } from '../domain/budget.ts'
import { CHANNEL_TIMEOUTS, LEASES, SERVER_POLICY } from '../domain/constants.ts'
import {
  effectiveTurnConfig,
  modeAllowsConfig,
  reconciliationTarget,
  validateTurnDirective,
} from '../domain/directive.ts'
import { delegationLease, sessionLease, worktreeLease } from '../domain/leases.ts'
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
import { admissionDecision, orderCandidates, withAdmitted } from './scheduler.ts'
import { createVerifier, hasMachineCheckableCriterion, verdictOf } from './verifier.ts'
import {
  baseHasMoved,
  createWorktree,
  diffAgainstBase,
  headRevision,
  isDirty,
  land,
  porcelainStatus,
  removeWorktree,
  resolveBaseRevision,
  scrubbedEnv,
  WorkspaceGuard,
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
  private dispatchPausedFleet = false
  private lastSample: { wall: number; mono: number }
  private ticking = false
  private timer: ReturnType<typeof setInterval> | null = null
  private closed = false
  /** X16: no mutating intent is accepted while a wake-up reconciliation is running. */
  private reconciling: Promise<void> | null = null
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
        assertWorkspace: (cwd) => cwd,
      })
    if (options.autoTick !== false) {
      this.timer = setInterval(() => {
        void this.tick()
        this.sampleClock()
      }, 1_000)
      this.timer.unref?.()
    }
  }

  /* ------------------------------------------------------------------------- small helpers */

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
    } else if (!delegationMachine.isTerminal(previous) && record.attempts.length > 0) {
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
    this.emit(
      tx,
      delegationStream(this.delegationOfTurn(tx, next)),
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

  notice(notice: Omit<NoticeVM, 'id' | 'at'>): NoticeVM {
    const full: NoticeVM = { ...notice, id: `notice_${this.ids()}`, at: this.now() }
    this.notices.push(full)
    if (this.notices.length > 200) this.notices.shift()
    this.commitPlain('notice', (tx) => {
      this.emit(
        tx,
        serverStream,
        { k: 'server.notice', notice: full },
        this.serverActor(notice.kind),
      )
    })
    return full
  }

  listNotices(): readonly NoticeVM[] {
    return this.notices
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
    return {
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
  }

  /* ---------------------------------------------------------------------------- snapshots */

  snapshot(stream: StreamName): { seq: number; state: unknown } {
    return this.store.snapshot(stream, (tx) => this.materialize(tx, stream))
  }

  private materialize(tx: ReadTx, stream: StreamName): unknown {
    if (stream === 'fleet') return fleetVM(tx, this.projectionContext(tx))
    if (stream === 'server') {
      return {
        version: this.options.version,
        bootId: this.options.bootId,
        notices: this.notices,
        confirmations: this.confirmations.list(),
      }
    }
    if (stream.startsWith('delegation:')) {
      const record = readDelegation(tx, stream.slice('delegation:'.length))
      return record === null ? null : delegationVM(tx, record, this.projectionContext(tx))
    }
    const attemptId = stream.slice('attempt:'.length)
    const attempt = readAttempt(tx, attemptId)
    return attempt === null ? null : attemptVM(tx, attempt, this.projectionContext(tx))
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
    })
    return stored
  }

  private versionOf(value: unknown): number {
    if (typeof value !== 'string') return 0
    return this.store.read((tx) => readDelegation(tx, value)?.version ?? 0)
  }

  private async run(intent: string, args: unknown, ctx: IntentContext): Promise<unknown> {
    const a = (args ?? {}) as Record<string, unknown>
    switch (intent) {
      case 'createDelegation':
        return this.createDelegation(a as unknown as CreateDelegationInput, ctx)
      case 'sendTurn':
        return this.sendTurn(a.delegationId as DelegationId, a.directive as TurnDirective, ctx)
      case 'retract':
        return this.retract(a.turnId as TurnId, ctx)
      case 'cancel':
        return this.cancel(
          a.delegationId as DelegationId,
          a.options as { scope: 'turn' | 'delegation' | 'hard'; attemptId?: AttemptId },
          ctx,
        )
      case 'retry':
        return this.retry(
          a.delegationId as DelegationId,
          (a.options ?? {}) as { parallel?: 1 | 2 | 3 },
          ctx,
        )
      case 'branch':
        return this.branch(a.attemptId as AttemptId, (a.options ?? {}) as { title?: string }, ctx)
      case 'verify':
        return this.verify(
          a.delegationId as DelegationId,
          (a.options ?? {}) as { attemptId?: AttemptId },
          ctx,
        )
      case 'accept':
        return this.accept(
          a.delegationId as DelegationId,
          a.options as { note: string; attemptId?: AttemptId },
          ctx,
        )
      case 'land':
        return this.land(a.delegationId as DelegationId, a.options as LandOptions, ctx)
      case 'discard':
        return this.discard(a.attemptId as AttemptId, ctx)
      case 'archive':
        return this.archive(
          a.delegationId as DelegationId,
          (a.options ?? {}) as { abandon?: boolean },
          ctx,
        )
      case 'reconcile':
        return this.reconcile(a.delegationId as DelegationId, ctx)
      case 'pauseDispatch':
        return this.pauseDispatch(
          a.scope as { fleet: true } | { delegationId: DelegationId },
          a.paused === true,
          ctx,
        )
      case 'killSwitch':
        return this.killSwitch((a.options ?? {}) as { killInstances?: boolean }, ctx)
      case 'updateDefaults':
        return this.updateDefaults(
          a.delegationId as DelegationId,
          a.patch as DelegationDefaultsPatch,
          ctx,
        )
      case 'confirm':
        this.confirmations.confirm(a.requestId as string, ctx.tokenId)
        return null
      case 'deny':
        this.confirmations.deny(a.requestId as string, a.reason as string | undefined)
        return null
      default:
        throw new SwarmError('invalid_spec', `unknown intent '${intent}'`)
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

    /* The config decisions are now known; re-persist the record carrying them, then send. */
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
      const live = readAttempt(tx, attempt.id)
      if (live !== null) this.moveChannel(tx, live, 'submit', actor)
    })

    const contextOnly = mode === 'context-only'
    try {
      if (mode === 'next-safe-point' || mode === 'interrupt') {
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
        return
      }

      this.commitPlain('turn_sent', (tx) => {
        const fresh = readTurn(tx, turn.id)
        if (fresh !== null) this.moveDelivery(tx, fresh, 'written', actor)
      })
      runtime.turnStartedAt = this.now()

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
          this.notice({
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
          })
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
            { delegationId: attempt.delegationId, attemptId },
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
            { delegationId: attempt.delegationId, attemptId },
          )
          if (current !== null) {
            this.putTurn(tx, { ...current, toolCallCount: current.toolCallCount + 1 })
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
            }),
          })
          return null
        }
        case 'accepted': {
          this.moveChannel(tx, attempt, 'message_accepted', actor)
          return null
        }
        case 'turn_done': {
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

    if (post === null || post === undefined) return
    if (post.kind === 'turn_end') void this.afterTurn(attemptId, post.delegationId)
    if (post.kind === 'disconnected') void this.afterDisconnect(attemptId, post.delegationId)
  }

  /* ---------------------------------------------------------------------------- turn end */

  private async afterTurn(attemptId: AttemptId, delegationId: DelegationId): Promise<void> {
    const decision = this.store.commit((tx) => {
      const delegation = this.requireDelegation(tx, delegationId)
      const meta = this.attemptMeta(tx, attemptId)
      const spend = addSpend(delegation.spend, { turns: 1 })
      const updated = this.putDelegation(tx, { ...delegation, spend })

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
    await this.reconcileDelegation(delegationId, this.serverActor('disconnect'))
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
          manifestDigest: digest(final.runId),
        },
        this.serverActor('verifier'),
        { delegationId: attempt.delegationId, attemptId },
      )

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
        /* D11: a failure with budget remaining, or an indeterminate result, is a question for a
         * human — never a silent `failed` and never a silent `succeeded`. */
        this.movePhase(tx, attemptId, 'verification_failed_budget_remaining')
        const delegation = this.requireDelegation(tx, attempt.delegationId)
        this.putDelegation(tx, {
          ...delegation,
          lastNeedsYouReason: verdict === 'fail' ? 'verification-failed' : 'manual-criterion',
        })
      }
      this.refreshDelegationState(tx, attempt.delegationId, this.serverActor('verifier'))
    })
    return final
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
      /* C15 — `close()` is the ONLY lease release; there is no detach (§5.4 #9). */
      void session?.close('attempt ended')
      this.store.commit((inner) => {
        inner.releaseLease(sessionLease(session?.sessionId ?? ''), attemptId)
      })
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

    if (plan.interruptMode) {
      const runtime = plan.attempt === null ? undefined : this.live.get(plan.attempt.id)
      if (runtime?.session != null && runtime.fence !== null) {
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
        if (runtime?.session != null && runtime.fence !== null) {
          await runtime.session.interrupt('cancel', null, runtime.fence)
        }
      }
      this.audit(ctx, 'cancel', { delegationId, scope: 'turn' })
      return null
    }

    if (options.scope === 'hard') {
      for (const instance of this.instances.values()) {
        try {
          await instance.hardKill('cancel{scope:hard}')
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

  /** D19 — `retry` reopens as attempt *N+1*; `verdict` cleared, `landed` retained (Q2). */
  private retry(
    delegationId: DelegationId,
    options: { parallel?: 1 | 2 | 3 },
    ctx: IntentContext,
  ): readonly AttemptId[] {
    this.store.commit((tx) => {
      const record = this.requireDelegation(tx, delegationId)
      const outcome = delegationMachine.transition(record.state, 'retry')
      const spec =
        options.parallel === undefined
          ? record.spec
          : { ...record.spec, parallelAttempts: options.parallel }
      this.putDelegation(tx, {
        ...record,
        spec,
        state: outcome.ok && outcome.state !== null ? outcome.state : 'queued',
        verdict: null,
        version: record.version + 1,
      })
      this.emitSummary(tx, delegationId, ctx.actor)
      tx.appendAudit({
        intent: 'retry',
        actor: ctx.actor,
        delegationId,
        effective: { parallel: spec.parallelAttempts },
        result: { ok: true },
        correlation: ctx.idempotencyKey,
      })
    })
    void this.tick()
    return []
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
      this.notice({
        kind: 'landing-conflict',
        severity: 'warn',
        title: 'The base has moved',
        detail:
          'Rebase, report or abandon — swarm never resolves a conflict on the agent’s behalf.',
        delegationId,
        attemptId: options.attemptId,
        actions: [{ intent: 'land', label: 'Land anyway' }],
        dismissible: true,
      })
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
      if (runtime?.session != null && runtime.fence !== null) {
        await runtime.session.interrupt('cancel', null, runtime.fence).catch(() => undefined)
      }
    }

    const instancesKilled: KillReport['instancesKilled'][number][] = []
    if (options.killInstances === true) {
      for (const instance of this.instances.values()) {
        try {
          instancesKilled.push(await instance.hardKill('kill switch'))
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
        const toolEvents = attempt === null ? 0 : this.countToolEvents(tx, attempt.id)
        const ackLogged = turn !== null && turn.deliveryDetail.ackAtMs !== null
        return { record, attempt, turn, toolEvents, ackLogged }
      })

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
      sessionIdle = setup.attempt.channel !== 'streaming'
      if (runtime?.session != null) {
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
    if (setup.attempt?.workspace.worktree != null) {
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

  private countToolEvents(tx: ReadTx, attemptId: AttemptId): number {
    const stream = attemptStream(attemptId)
    const head = tx.head(stream).head
    let count = 0
    for (const record of tx.readLog(stream, Math.max(0, head - 500), 500)) {
      if (record.ev.k === 'att.tool') count += 1
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
        kind: 'drift',
        severity: 'warn',
        title: 'A long gap in both clocks',
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
        this.putDelegation(tx, {
          ...record,
          spend: addSpend(record.spend, { sleptMs: gap.sleptMs, wallMs: gap.wallGapMs }),
        })
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
        await this.provision(candidate).catch((error: unknown) => {
          this.failProvisioning(candidate.delegationId, error)
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
      const wanted = record.spec.parallelAttempts - record.liveAttempts.length
      for (let i = 0; i < wanted; i++) {
        candidates.push({
          delegationId: record.id,
          siblingIndex: record.liveAttempts.length + i,
          priority: record.priority,
          queuedAt: record.createdAt,
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
  private async provision(candidate: AdmissionCandidate): Promise<void> {
    const attemptId = `a_${this.ids()}`
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

    if (prepared.attempt.workspace.worktree !== null) {
      createWorktree({
        root: prepared.attempt.workspace.root,
        path: prepared.attempt.workspace.worktree,
        baseRevision: prepared.attempt.workspace.baseRevision,
        branch: `swarm/${attemptId}`,
      })
      /* S6 again, on the resolved worktree path (§13). */
      this.guard.assertInsideWorkspace(
        prepared.delegation.spec.workspace.workspaceId,
        prepared.attempt.workspace.worktree,
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
    const text = [
      delegation.spec.objective,
      delegation.spec.constraints === undefined
        ? ''
        : `\n\nConstraints: ${delegation.spec.constraints}`,
    ].join('')
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

  /** D5 — preflight/worktree/instance error after 3 bounded retries. */
  private failProvisioning(delegationId: DelegationId, error: unknown): void {
    this.store.commit((tx) => {
      const record = readDelegation(tx, delegationId)
      if (record === null) return
      const attempts = tx.counter(`provision_failures:${delegationId}`)
      tx.bumpCounter(`provision_failures:${delegationId}`, 1)
      if (attempts + 1 < SERVER_POLICY.provisionRetries) return
      for (const attemptId of record.liveAttempts)
        this.endAttempt(tx, attemptId, 'failed', 'failed')
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
        result: { error: error instanceof Error ? error.message : String(error) },
      })
    })
    this.notice({
      kind: 'doctor-blocked',
      severity: 'error',
      title: 'Provisioning failed',
      detail: error instanceof Error ? error.message : String(error),
      delegationId,
      actions: [{ intent: 'retry', label: 'Retry' }],
      dismissible: true,
    })
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
    for (const instance of this.instances.values()) {
      await instance.dispose('server shutting down').catch(() => undefined)
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
