/**
 * Records → view models (SPEC-swarm §6.2, §6.2.1, §6.4–6.6).
 *
 * The server projects; the head renders. Two rules make that split honest rather than nominal:
 *
 *  - **one `bucketOf`** produces `FleetVM.buckets` *and* `DelegationVM.bucket` (§6.2.1), so the
 *    fleet list and the row badge cannot disagree — they are literally the same call;
 *  - **`effortConfirmed` is a literal `false`** on every `TurnVM` (§4.3.4, #7), which is why the
 *    field is typed rather than computed. Nothing here can claim an effort was observed.
 *
 * Everything is a pure function of a `ReadTx` plus a clock, so `snapshot()` and the event writer
 * produce byte-identical state — the property §13's "re-subscription reproduces byte-identical
 * state" assertion depends on.
 *
 * Node ≥ 24, server-only (it reads the store), but it touches no I/O of its own.
 */

import type { ReadTx } from '../log/types.ts'
import type {
  AttemptComparisonVM,
  AttemptId,
  AttemptRecord,
  AttemptVM,
  CriterionStatus,
  DelegationId,
  DelegationRecord,
  DelegationVM,
  DiffVM,
  FleetBucket,
  FleetVM,
  SpendCounters,
  TurnRecord,
  TurnVM,
} from '../types.ts'

import { emptySpendCounters, worstFraction } from '../domain/budget.ts'
import { attentionScore, bucketOf, compareAttention, emptyBuckets } from '../domain/rollup.ts'

/** W5's stall threshold: `running` with no stream event for this long renders as `stalled`. */
export const STALL_AFTER_MS = 120_000

/**
 * The cosmetic, non-durable half of an attempt's state (W4, W5). It is deliberately **not** on
 * `AttemptRecord`: "what is it doing right now" and "how long since it said anything" are
 * observations of a live stream, and persisting them would resurrect a stale sentence after a
 * restart as though it were current.
 */
export interface AttemptRuntime {
  nowDoing: string | null
  lastEventAt: number
  diff: DiffVM['totals'] | null
  staleBase: boolean
}

export interface ProjectionContext {
  readonly now: number
  readonly runtime: ReadonlyMap<AttemptId, AttemptRuntime>
  readonly capUsd: number | null
  readonly concurrency: FleetVM['concurrency']
  readonly dispatchPaused: boolean
}

export function emptyRuntime(now: number): AttemptRuntime {
  return { nowDoing: null, lastEventAt: now, diff: null, staleBase: false }
}

/** `delegation_meta` — what the head typed, kept beside the record rather than inside it (C4b). */
export interface DelegationMeta {
  readonly baseRef: string
  readonly workspaceRoot: string
  readonly instanceKey: string
  /**
   * How many attempts this delegation has **opened in the current admission epoch** — the durable
   * half of D2's "the scheduler admits up to *n* attempts independently".
   *
   * Without it the scheduler computed `parallelAttempts − liveAttempts.length` on every tick, and
   * `liveAttempts` shrinks whenever an attempt *ends*: every finished attempt was silently
   * backfilled with a fresh worktree, a fresh session and fresh tokens, forever. An attempt is
   * admitted by D2 (from `queued`) or by a D19 reopen — and by nothing else.
   */
  readonly openedInEpoch?: number
  /** When this epoch began. D19 restarts it, so a reopen does not carry its original age (F7). */
  readonly epochQueuedAt?: number
  /** Set by `retry{injectPriorFailure}`, consumed once by the next attempt's objective turn (A2). */
  readonly priorFailure?: string
}

export function readDelegation(tx: ReadTx, id: DelegationId): DelegationRecord | null {
  return tx.getRecord<DelegationRecord>('delegation', id)?.value ?? null
}

export function readAttempt(tx: ReadTx, id: AttemptId): AttemptRecord | null {
  return tx.getRecord<AttemptRecord>('attempt', id)?.value ?? null
}

export function readTurn(tx: ReadTx, id: string): TurnRecord | null {
  return tx.getRecord<TurnRecord>('turn', id)?.value ?? null
}

export function readMeta(tx: ReadTx, id: DelegationId): DelegationMeta | null {
  return tx.getRecord<DelegationMeta>('delegation_meta', id)?.value ?? null
}

export function turnVM(turn: TurnRecord, now: number): TurnVM {
  return {
    id: turn.id,
    attemptId: turn.attemptId,
    delivery: turn.delivery,
    effective: turn.effective,
    landing: turn.deliveryDetail.landing,
    /* The literal, again, at the surface a presentation MUST render (§4.3.4). */
    effortConfirmed: false,
    configInherited: turn.effective.reasoningEffort === 'inherited',
    elapsedMs: Math.max(0, (turn.endedAt ?? now) - turn.startedAt),
    toolCalls: turn.toolCallCount,
  }
}

function spendOfTurns(turns: readonly TurnRecord[]): SpendCounters {
  let spend = emptySpendCounters()
  for (const turn of turns) {
    spend = {
      ...spend,
      turns: spend.turns + 1,
      toolCalls: spend.toolCalls + turn.toolCallCount,
      inputTokens: spend.inputTokens + (turn.usage?.input ?? 0),
      outputTokens: spend.outputTokens + (turn.usage?.output ?? 0),
    }
  }
  return spend
}

export function attemptVM(
  tx: ReadTx,
  attempt: AttemptRecord,
  context: ProjectionContext,
): AttemptVM {
  const turns = attempt.turns
    .map((id) => readTurn(tx, id))
    .filter((turn): turn is TurnRecord => turn !== null)
  const runtime = context.runtime.get(attempt.id)
  const current = turns.length === 0 ? null : turns[turns.length - 1]!
  const lastRun = attempt.verifications.at(-1) ?? null
  const spend = spendOfTurns(turns)
  return {
    id: attempt.id,
    attemptNo: attempt.attemptNo,
    live: attempt.outcome === 'open',
    channel: attempt.channel,
    outcome: attempt.outcome,
    sessionId: attempt.executor.sessionId,
    worktree: attempt.workspace.worktree,
    staleBase: attempt.workspace.staleBase || (runtime?.staleBase ?? false),
    nowDoing: runtime?.nowDoing ?? null,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    turns: turns.length,
    toolCalls: spend.toolCalls,
    spend,
    currentTurn: current === null ? null : turnVM(current, context.now),
    verification:
      lastRun === null
        ? null
        : { runNo: lastRun.runNo, verdict: lastRun.verdict, at: lastRun.endedAt },
    evidenceRef: attempt.evidence,
  }
}

function criterionStatuses(
  delegation: DelegationRecord,
  attempt: AttemptRecord | null,
): readonly { readonly id: string; readonly label: string; readonly status: CriterionStatus }[] {
  const run = attempt?.verifications.at(-1) ?? null
  return delegation.spec.acceptance.map((criterion) => {
    const result = run?.results.find((r) => r.id === criterion.id)
    const status: CriterionStatus =
      result === undefined
        ? criterion.kind === 'manual'
          ? 'manual'
          : 'unrun'
        : result.status === 'timeout'
          ? 'error'
          : result.status
    return { id: criterion.id, label: criterion.label, status }
  })
}

/** A5, promoted to **M** by Q9 — non-null once ≥2 attempts have evidence, and it never auto-lands. */
export function comparisonVM(
  tx: ReadTx,
  delegation: DelegationRecord,
  context: ProjectionContext,
): AttemptComparisonVM | null {
  const attempts = delegation.attempts
    .map((id) => readAttempt(tx, id))
    .filter((attempt): attempt is AttemptRecord => attempt !== null)
  const withEvidence = attempts.filter((a) => a.verifications.length > 0 || a.evidence !== null)
  if (withEvidence.length < 2) return null

  const rows = withEvidence.map((attempt) => {
    const run = attempt.verifications.at(-1) ?? null
    const vm = attemptVM(tx, attempt, context)
    const diff = context.runtime.get(attempt.id)?.diff ?? null
    return {
      id: attempt.id,
      attemptNo: attempt.attemptNo,
      verdict: (run?.verdict ?? 'unrun') as 'pass' | 'fail' | 'indeterminate' | 'unrun',
      filesChanged: diff?.files ?? 0,
      insertions: diff?.insertions ?? 0,
      deletions: diff?.deletions ?? 0,
      criteria: criterionStatuses(delegation, attempt).map((c) => ({ id: c.id, status: c.status })),
      estUsd: vm.spend.estUsd,
      durationMs: Math.max(0, (attempt.endedAt ?? context.now) - attempt.startedAt),
      turns: vm.turns,
      toolCalls: vm.toolCalls,
    }
  })

  /* Best *passing* attempt by (criteria, cost). A recommendation is a sort, never an action. */
  const passing = rows
    .filter((row) => row.verdict === 'pass')
    .sort((a, b) => a.estUsd - b.estUsd || a.durationMs - b.durationMs)
  return { attempts: rows, recommendation: passing[0]?.id ?? null }
}

export function delegationVM(
  tx: ReadTx,
  delegation: DelegationRecord,
  context: ProjectionContext,
): DelegationVM {
  const attempts = delegation.attempts
    .map((id) => readAttempt(tx, id))
    .filter((attempt): attempt is AttemptRecord => attempt !== null)
    .map((attempt) => attemptVM(tx, attempt, context))
  const focused =
    attempts.find((a) => a.id === delegation.focusedAttempt) ??
    attempts.find((a) => a.live) ??
    attempts.at(-1) ??
    null
  const focusedRecord = focused === null ? null : (readAttempt(tx, focused.id) ?? null)

  const stalledForMs = stallOf(delegation, attempts, context)
  const staleBase = attempts.some((a) => a.staleBase)
  const deliveryUnknown = attempts.some((a) => a.currentTurn?.delivery === 'unknown')
  const worst = worstFraction(delegation.spend, delegation.spec.budget)
  const meta = readMeta(tx, delegation.id)

  const bucketInput = {
    state: delegation.state,
    stalledForMs,
    landed: delegation.landed !== null,
  }
  return {
    id: delegation.id,
    version: delegation.version,
    title: delegation.title,
    state: delegation.state,
    verdict: delegation.verdict,
    bucket: bucketOf(bucketInput),
    unverifiable: delegation.unverifiable,
    dispatchPaused: delegation.dispatchPaused,
    landed: delegation.landed !== null,
    attentionScore: attentionScore({
      state: delegation.state,
      landed: delegation.landed !== null,
      stalled: stalledForMs !== null,
      deliveryUnknown,
      budgetBreached: worst >= 1,
      staleBase,
      ageMinutes: Math.floor(Math.max(0, context.now - delegation.createdAt) / 60_000),
    }),
    nowDoing: focused?.nowDoing ?? null,
    stalledForMs,
    staleBase,
    needsYou: delegation.state === 'needs-you' ? delegation.lastNeedsYouReason : null,
    spec: delegation.spec,
    defaults: {
      provider: delegation.spec.model.provider,
      model: delegation.spec.model.model,
      reasoningEffort: delegation.spec.model.reasoningEffort,
      delivery: delegation.spec.delivery.mode,
    },
    baseRef: meta?.baseRef ?? delegation.spec.workspace.baseRevision,
    baseRevision: delegation.spec.workspace.baseRevision,
    liveAttemptIds: delegation.liveAttempts,
    focusedAttemptId: delegation.focusedAttempt,
    origin: delegation.origin,
    currentTurn: focused?.currentTurn ?? null,
    attempts,
    comparison: comparisonVM(tx, delegation, context),
    budget: { used: delegation.spend, limit: delegation.spec.budget, worstFraction: worst },
    acceptance: criterionStatuses(delegation, focusedRecord),
  }
}

function stallOf(
  delegation: DelegationRecord,
  attempts: readonly AttemptVM[],
  context: ProjectionContext,
): number | null {
  if (delegation.state !== 'running') return null
  let quietest: number | null = null
  for (const attempt of attempts) {
    if (!attempt.live) continue
    const runtime = context.runtime.get(attempt.id)
    const since = context.now - (runtime?.lastEventAt ?? context.now)
    if (since >= STALL_AFTER_MS) quietest = Math.max(quietest ?? 0, since)
  }
  return quietest
}

export function fleetVM(tx: ReadTx, context: ProjectionContext): FleetVM {
  /* `compareAttention` is a total order over (score, updatedAt, id) and `DelegationVM` carries no
   * `updatedAt` — the record does, so the sort key is assembled here rather than widening the VM. */
  const rows = tx.listRecords<DelegationRecord>('delegation').map((stored) => ({
    vm: delegationVM(tx, stored.value, context),
    updatedAt: stored.value.updatedAt,
    id: stored.value.id,
    attentionScore: 0,
  }))
  for (const row of rows) row.attentionScore = row.vm.attentionScore

  const buckets = emptyBuckets<DelegationId[]>(() => [])
  const counts = emptyBuckets<number>(() => 0)
  let spend = emptySpendCounters()

  for (const { vm: row } of rows.sort(compareAttention)) {
    buckets[row.bucket].push(row.id)
    counts[row.bucket] += 1
    spend = {
      wallMs: spend.wallMs + row.budget.used.wallMs,
      monotonicMs: spend.monotonicMs + row.budget.used.monotonicMs,
      sleptMs: spend.sleptMs + row.budget.used.sleptMs,
      turns: spend.turns + row.budget.used.turns,
      toolCalls: spend.toolCalls + row.budget.used.toolCalls,
      inputTokens: spend.inputTokens + row.budget.used.inputTokens,
      outputTokens: spend.outputTokens + row.budget.used.outputTokens,
      estUsd: spend.estUsd + row.budget.used.estUsd,
    }
  }

  return {
    buckets: buckets as Record<FleetBucket, readonly DelegationId[]>,
    counts,
    dispatchPaused: context.dispatchPaused,
    concurrency: context.concurrency,
    spend: { ...spend, capUsd: context.capUsd },
  }
}

/** `compareAttention` needs `updatedAt`; `DelegationVM` does not carry it, so it is derived here. */
export function sortDelegationIds(
  tx: ReadTx,
  ids: readonly DelegationId[],
  context: ProjectionContext,
): readonly DelegationId[] {
  const rows = ids
    .map((id) => readDelegation(tx, id))
    .filter((record): record is DelegationRecord => record !== null)
    .map((record) => ({
      id: record.id,
      updatedAt: record.updatedAt,
      attentionScore: delegationVM(tx, record, context).attentionScore,
    }))
  return rows.sort(compareAttention).map((row) => row.id)
}
