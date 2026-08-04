/**
 * Wire events → view models (SPEC-swarm §6.2, §6.2.1, §6.4–6.6).
 *
 * This is the whole of "the client core owns projection" (#2). Four properties are structural
 * here rather than aspirational:
 *
 *  - **`bucketOf` produces both `FleetVM.buckets` and `DelegationVM.bucket`** (§6.2.1), so the
 *    fleet list and the row badge cannot disagree. It is imported, never re-implemented.
 *  - **The attention score is recomputed locally on every projected VM** (§6.4–6.6). The wire
 *    carries one age signal — the server's own score — so the client inverts it *once*, on first
 *    sight, and then keeps its own clock: `ageMinutes` is measured from the delegation's tracked
 *    `createdAtMs`, using the **event's `ts`** as the pass's clock. That makes a projection a
 *    pure function of (events, seed) and a determinism test a `JSON.stringify` comparison rather
 *    than a tolerance.
 *  - **Values are referentially stable when unchanged** (§6.2): only the delegation an event
 *    touched is rebuilt, so `===` memoization in a head is correct.
 *  - **Server reconciliation always wins** (X11). An optimistic record carries `version: -1` and
 *    is replaced wholesale by the first server record for that id. The client core never merges.
 *
 * `EVENT_PROJECTION` (§6.4) is the *permitted* set of head-facing keys per wire kind; this module
 * emits a subset of it. `server.pairing` is the standing example: the table permits `notice`, and
 * there is no `NoticeKind` for a pairing, so whether a pairing deserves a notice is the server's
 * ruling and arrives as `server.notice` — the client does not invent one.
 *
 * DOM-free and Node-free.
 */

import type { SwarmEvent } from '../protocol/events.ts'
import type { ServerCapability } from '../protocol/frames.ts'
import type {
  AttemptSnapshot,
  DelegationSnapshot,
  FleetSnapshot,
  ServerSnapshot,
} from '../protocol/snapshots.ts'
import type {
  AttemptId,
  AttemptVM,
  ConfirmationRequest,
  DelegationId,
  DelegationVM,
  FleetFilter,
  FleetVM,
  HealthVM,
  NoticeVM,
  SpendCounters,
  SwarmClientEvents,
  TurnVM,
} from '../types.ts'

import { SOFT_BREACH_FRACTION, emptySpendCounters } from '../domain/budget.ts'
import {
  ATTENTION_WEIGHTS,
  attentionScore,
  bucketOf,
  compareAttention,
  emptyBuckets,
} from '../domain/rollup.ts'
import { SwarmError as SwarmErrorClass, isSwarmErrorCode } from '../errors.ts'
import { deepFreeze } from './freeze.ts'

/** How many notices the client retains. The store is a live surface, not an archive (§2.3). */
export const NOTICE_RETENTION = 100

export interface ProjectionOptions {
  readonly now: () => number
  /** The negotiated capabilities, for `server-changed` (§2.5 rule 2). */
  capabilities(): readonly ServerCapability[]
  emit<K extends keyof SwarmClientEvents>(key: K, payload: SwarmClientEvents[K]): void
}

interface DelegationMeta {
  createdAtMs: number
  updatedAtMs: number
}

export interface ProjectionResult {
  /** `true` when a published store's value changed and the caller must republish. */
  readonly delegationsChanged: boolean
  readonly fleetChanged: boolean
  readonly healthChanged: boolean
  readonly noticesChanged: boolean
}

export interface Projection {
  delegations(): ReadonlyMap<DelegationId, DelegationVM>
  fleet(): FleetVM
  health(): HealthVM
  notices(): readonly NoticeVM[]
  confirmations(): readonly ConfirmationRequest[]

  applyServerSnapshot(snapshot: ServerSnapshot): void
  applyFleetSnapshot(snapshot: FleetSnapshot): void
  applyDelegationSnapshot(snapshot: DelegationSnapshot): void
  applyAttemptSnapshot(snapshot: AttemptSnapshot): void
  applyEvent(
    event: SwarmEvent,
    context: { readonly ts: number; readonly streamId: string | null },
  ): void

  pushNotice(notice: NoticeVM): void

  /** Local view selection (§6.3) — it never reaches the wire and it never changes `counts`. */
  setFilter(filter: FleetFilter): void

  /** §6.6: the only two optimistic records, both `version: -1`. */
  optimisticDelegation(vm: DelegationVM): void
  optimisticTurn(delegationId: DelegationId, attemptId: AttemptId | null, turn: TurnVM): void

  setFocusedAttempt(delegationId: DelegationId, attemptId: AttemptId | null): void
  attemptOwner(attemptId: AttemptId): DelegationId | null

  /** Drain the changes accumulated since the last call. */
  drain(): ProjectionResult
}

const EMPTY_HEALTH: HealthVM = deepFreeze({
  server: { ok: false, version: '', uptimeMs: 0 },
  executor: { ok: false, adapterId: 'mock', versions: {}, blocked: null, fix: null },
  instances: [],
  routes: [],
  approvalsAvailable: false,
  lastDoctorAt: null,
})

const EMPTY_FLEET: FleetVM = deepFreeze({
  buckets: emptyBuckets<readonly DelegationId[]>(() => []),
  counts: emptyBuckets<number>(() => 0),
  dispatchPaused: false,
  concurrency: { runningAttempts: 0, cap: 0, queued: 0 },
  spend: { ...emptySpendCounters(), capUsd: null },
})

/**
 * The flag half of §6.4–6.6's score — everything except age. Inverting the server's score against
 * this is what recovers a delegation's age from a wire that carries no timestamp for it.
 */
function flagScore(vm: DelegationVM): number {
  return attentionScore({
    state: vm.state,
    landed: vm.landed,
    stalled: vm.stalledForMs !== null,
    deliveryUnknown: hasUnknownDelivery(vm),
    budgetBreached: vm.budget.worstFraction >= 1,
    staleBase: vm.staleBase,
    ageMinutes: 0,
  })
}

function hasUnknownDelivery(vm: DelegationVM): boolean {
  if (vm.currentTurn?.delivery === 'unknown') return true
  return vm.attempts.some((attempt) => attempt.currentTurn?.delivery === 'unknown')
}

function scoreOf(vm: DelegationVM, createdAtMs: number, nowMs: number): number {
  return attentionScore({
    state: vm.state,
    landed: vm.landed,
    stalled: vm.stalledForMs !== null,
    deliveryUnknown: hasUnknownDelivery(vm),
    budgetBreached: vm.budget.worstFraction >= 1,
    staleBase: vm.staleBase,
    ageMinutes: Math.max(0, (nowMs - createdAtMs) / 60_000),
  })
}

function addSpendEvent(spend: SpendCounters, input: number, output: number): SpendCounters {
  return {
    ...spend,
    inputTokens: spend.inputTokens + input,
    outputTokens: spend.outputTokens + output,
  }
}

function toolLine(name: string, target: string | null): string {
  return target === null || target.length === 0 ? name : `${name} ${target}`
}

export function createProjection(options: ProjectionOptions): Projection {
  let delegations = new Map<DelegationId, DelegationVM>()
  const meta = new Map<DelegationId, DelegationMeta>()
  const focusedAttempt = new Map<DelegationId, AttemptId | null>()
  const attemptOwners = new Map<AttemptId, DelegationId>()
  let fleet: FleetVM = EMPTY_FLEET
  let health: HealthVM = EMPTY_HEALTH
  let notices: readonly NoticeVM[] = []
  let confirmations: readonly ConfirmationRequest[] = []
  let filter: FleetFilter = {}

  let delegationsChanged = false
  let fleetChanged = false
  let healthChanged = false
  let noticesChanged = false

  /* -------------------------------------------------------------------- delegation plumbing */

  /**
   * Rebuild one delegation. Everything derived — `bucket`, `attentionScore`, `currentTurn`,
   * `focusedAttemptId`, `liveAttemptIds` — is computed **here** and nowhere else, so a caller
   * cannot produce a VM whose badge disagrees with its bucket.
   */
  const commit = (base: DelegationVM, nowMs: number): DelegationVM => {
    const focus = focusedAttempt.get(base.id) ?? base.focusedAttemptId
    const attempts = base.attempts
    const focused = attempts.find((attempt) => attempt.id === focus) ?? null
    /* `liveAttempts` is derived from the attempts the client actually holds — but only once it
     * holds any. A `queued` delegation has none yet and the server's list is the only truth. */
    const liveAttemptIds =
      attempts.length > 0
        ? attempts.filter((attempt) => attempt.live).map((attempt) => attempt.id)
        : base.liveAttemptIds
    const withDerived: DelegationVM = {
      ...base,
      liveAttemptIds,
      focusedAttemptId: focus ?? null,
      currentTurn: focused === null ? null : focused.currentTurn,
      nowDoing:
        focused?.nowDoing ?? attempts.find((a) => a.live && a.nowDoing !== null)?.nowDoing ?? null,
      bucket: bucketOf(base),
    }
    const info = meta.get(base.id)
    const createdAtMs = info?.createdAtMs ?? nowMs
    const vm: DelegationVM = {
      ...withDerived,
      attentionScore: scoreOf(withDerived, createdAtMs, nowMs),
    }
    for (const attempt of vm.attempts) attemptOwners.set(attempt.id, vm.id)
    return deepFreeze(vm)
  }

  const put = (vm: DelegationVM, nowMs: number): DelegationVM => {
    const committed = commit(vm, nowMs)
    const previous = delegations.get(committed.id)
    if (previous !== undefined && sameVM(previous, committed)) return previous
    const next = new Map(delegations)
    next.set(committed.id, committed)
    delegations = next
    delegationsChanged = true
    fleetChanged = true
    return committed
  }

  /**
   * Structural equality over the published surface. Cheap enough to run per event and worth it:
   * §6.2's `===` stability promise is only true if a re-projection that changed nothing hands
   * back the object the head already has.
   */
  const sameVM = (a: DelegationVM, b: DelegationVM): boolean =>
    a === b || JSON.stringify(a) === JSON.stringify(b)

  const seed = (vm: DelegationVM, nowMs: number): void => {
    if (meta.has(vm.id)) {
      const info = meta.get(vm.id)!
      info.updatedAtMs = nowMs
      return
    }
    /* First sight: the server's score is the only age signal on the wire, so invert it once. */
    const ageMinutes = Math.min(
      ATTENTION_WEIGHTS.ageCap,
      Math.max(0, vm.attentionScore - flagScore(vm)),
    )
    meta.set(vm.id, { createdAtMs: nowMs - ageMinutes * 60_000, updatedAtMs: nowMs })
  }

  const touch = (id: DelegationId, nowMs: number): void => {
    const info = meta.get(id)
    if (info) info.updatedAtMs = nowMs
  }

  const patch = (
    id: DelegationId,
    nowMs: number,
    mutate: (vm: DelegationVM) => DelegationVM,
  ): DelegationVM | null => {
    const current = delegations.get(id)
    if (current === undefined) return null
    touch(id, nowMs)
    return put(mutate(current), nowMs)
  }

  const patchAttempt = (
    delegationId: DelegationId,
    attemptId: AttemptId,
    nowMs: number,
    mutate: (attempt: AttemptVM) => AttemptVM,
  ): DelegationVM | null =>
    patch(delegationId, nowMs, (vm) => ({
      ...vm,
      attempts: vm.attempts.map((attempt) =>
        attempt.id === attemptId ? mutate(attempt) : attempt,
      ),
    }))

  const patchTurn = (
    delegationId: DelegationId,
    turnId: string,
    nowMs: number,
    mutate: (turn: TurnVM) => TurnVM,
  ): DelegationVM | null =>
    patch(delegationId, nowMs, (vm) => ({
      ...vm,
      attempts: vm.attempts.map((attempt) =>
        attempt.currentTurn?.id === turnId
          ? { ...attempt, currentTurn: mutate(attempt.currentTurn) }
          : attempt,
      ),
    }))

  /* --------------------------------------------------------------------------- fleet rollup */

  /**
   * `buckets` is what the head lists; `counts` is how many exist. They differ **only** by the
   * local `FleetFilter`, and that is why §6.2 declares both: if `counts` were `buckets[b].length`
   * the field would be redundant, and a filtered head could never say "3 of 12 need you".
   */
  const passesFilter = (vm: DelegationVM): boolean => {
    if (filter.buckets !== undefined && !filter.buckets.includes(vm.bucket)) return false
    if (
      filter.workspaceIds !== undefined &&
      !filter.workspaceIds.includes(vm.spec.workspace.workspaceId)
    ) {
      return false
    }
    if (filter.providers !== undefined && !filter.providers.includes(vm.defaults.provider)) {
      return false
    }
    if (filter.text !== undefined && filter.text.length > 0) {
      const needle = filter.text.toLowerCase()
      const haystack = `${vm.title}\n${vm.spec.objective}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  }

  const rebuildFleet = (): void => {
    const buckets = emptyBuckets<DelegationId[]>(() => [])
    const counts = emptyBuckets<number>(() => 0)
    const sortable: {
      vm: DelegationVM
      attentionScore: number
      updatedAt: number
      id: DelegationId
    }[] = []
    for (const vm of delegations.values()) {
      counts[vm.bucket] += 1
      if (!passesFilter(vm)) continue
      sortable.push({
        vm,
        id: vm.id,
        attentionScore: vm.attentionScore,
        updatedAt: meta.get(vm.id)?.updatedAtMs ?? 0,
      })
    }
    sortable.sort(sorter())
    for (const row of sortable) buckets[row.vm.bucket].push(row.id)
    const next: FleetVM = { ...fleet, buckets, counts }
    if (JSON.stringify(next.buckets) === JSON.stringify(fleet.buckets)) {
      if (JSON.stringify(next.counts) === JSON.stringify(fleet.counts)) return
    }
    fleet = deepFreeze(next)
  }

  type SortRow = { vm: DelegationVM; attentionScore: number; updatedAt: number; id: DelegationId }

  /** F2's default is `'attention'`; the other three are the same total order on another key. */
  const sorter = (): ((a: SortRow, b: SortRow) => number) => {
    switch (filter.sort ?? 'attention') {
      case 'updated':
        return (a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      case 'created':
        return (a, b) =>
          (meta.get(b.id)?.createdAtMs ?? 0) - (meta.get(a.id)?.createdAtMs ?? 0) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      case 'spend':
        return (a, b) =>
          b.vm.budget.used.estUsd - a.vm.budget.used.estUsd ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      default:
        return compareAttention
    }
  }

  const setFleet = (mutate: (current: FleetVM) => FleetVM): void => {
    const next = mutate(fleet)
    if (JSON.stringify(next) === JSON.stringify(fleet)) return
    fleet = deepFreeze(next)
    fleetChanged = true
  }

  /* -------------------------------------------------------------------------------- notices */

  const pushNotice = (notice: NoticeVM): void => {
    const kept = [...notices, deepFreeze(notice)]
    notices = deepFreeze(kept.slice(Math.max(0, kept.length - NOTICE_RETENTION)))
    noticesChanged = true
  }

  /* --------------------------------------------------------------------------- event fan-in */

  const applyEvent = (
    event: SwarmEvent,
    context: { readonly ts: number; readonly streamId: string | null },
  ): void => {
    const at = context.ts
    switch (event.k) {
      case 'server.hello': {
        options.emit('server-changed', {
          serverVersion: event.version,
          capabilities: options.capabilities(),
        })
        return
      }
      case 'server.health': {
        health = deepFreeze(event.health)
        healthChanged = true
        options.emit('health', health)
        return
      }
      case 'server.doctor': {
        health = deepFreeze({
          ...health,
          executor: {
            ...health.executor,
            ok: event.report.ok,
            blocked: event.report.blocked,
            fix: event.report.fix,
            versions: event.report.versions,
          },
          lastDoctorAt: at,
        })
        healthChanged = true
        options.emit('health', health)
        return
      }
      case 'server.notice': {
        pushNotice(event.notice)
        options.emit('notice', event.notice)
        return
      }
      case 'server.pairing': {
        /* Permitted to raise `notice` (§6.4) — but no `NoticeKind` describes a pairing, so
         * whether one is warranted is the server's ruling and arrives as `server.notice`. */
        return
      }
      case 'server.confirmation': {
        confirmations = deepFreeze([...confirmations, event.request])
        options.emit('confirmation', event.request)
        return
      }
      case 'server.confirmation_resolved': {
        confirmations = deepFreeze(
          confirmations.filter((request) => request.requestId !== event.requestId),
        )
        return
      }

      case 'fleet.delegation_created': {
        seed(event.delegation, at)
        const vm = put(event.delegation, at)
        options.emit('delegation:create', { delegationId: vm.id, vm })
        return
      }
      case 'fleet.delegation_summary': {
        seed(event.delegation, at)
        touch(event.delegation.id, at)
        const vm = put(event.delegation, at)
        options.emit('delegation:update', { delegationId: vm.id, vm })
        return
      }
      case 'fleet.delegation_state': {
        const previous = delegations.get(event.delegationId)
        if (previous === undefined) return
        const vm = patch(event.delegationId, at, (current) => ({
          ...current,
          state: event.state,
          version: event.version,
        }))
        if (vm === null) return
        options.emit('delegation:state', {
          delegationId: vm.id,
          state: vm.state,
          bucket: vm.bucket,
          previous: previous.state,
        })
        /* One kind, two keys, conditionally (§6.4): attention is a first-class signal, not a
         * string comparison repeated at every call site. */
        if (vm.state === 'needs-you') {
          options.emit('needs-you', {
            delegationId: vm.id,
            reason: vm.needsYou ?? 'question',
            vm,
          })
        }
        return
      }
      case 'fleet.spend': {
        setFleet((current) => ({ ...current, spend: event.spend }))
        const cap = event.spend.capUsd
        if (cap !== null && cap > 0) {
          const fraction = event.spend.estUsd / cap
          if (fraction >= 1) options.emit('budget', { scope: 'fleet', level: 'hard', fraction })
          else if (fraction >= SOFT_BREACH_FRACTION) {
            options.emit('budget', { scope: 'fleet', level: 'soft', fraction })
          }
        }
        return
      }
      case 'fleet.caps': {
        setFleet((current) => ({
          ...current,
          concurrency: event.concurrency,
          dispatchPaused: event.dispatchPaused,
        }))
        return
      }
      case 'fleet.kill_switch': {
        setFleet((current) => ({ ...current, dispatchPaused: true }))
        /* §4.3.7/§13: a stop that left the daemon alive must never be reported as a stop. */
        const partial = event.report.instancesKilled.filter(
          (outcome) => outcome.daemonPid === null || !outcome.daemonStopped,
        )
        if (partial.length > 0) {
          const notice: NoticeVM = {
            id: `kill-partial-${event.report.at}`,
            kind: 'capability-absent',
            severity: 'error',
            title: 'Kill switch could not stop every agent',
            detail:
              `${partial.length} instance(s) reported daemonStopped:false or an unresolved ` +
              'daemon pid — the agent may still be running.',
            at: event.report.at,
            actions: [{ intent: 'killSwitch', label: 'Try again' }],
            dismissible: false,
          }
          pushNotice(notice)
          options.emit('notice', notice)
        }
        return
      }

      case 'deleg.attempt_started': {
        const delegationId = context.streamId
        if (delegationId === null) return
        attemptOwners.set(event.attempt.id, delegationId)
        const vm = patch(delegationId, at, (current) => ({
          ...current,
          attempts: current.attempts.some((a) => a.id === event.attempt.id)
            ? current.attempts.map((a) => (a.id === event.attempt.id ? event.attempt : a))
            : [...current.attempts, event.attempt],
        }))
        if (vm === null) return
        options.emit('attempt:start', { delegationId, attempt: event.attempt })
        return
      }
      case 'deleg.attempt_ended': {
        const delegationId = context.streamId
        if (delegationId === null) return
        const vm = patch(delegationId, at, (current) => ({
          ...current,
          attempts: current.attempts.map((a) =>
            a.id === event.attemptId
              ? { ...a, live: false, outcome: event.outcome, endedAt: at }
              : a,
          ),
          liveAttemptIds: current.liveAttemptIds.filter((id) => id !== event.attemptId),
        }))
        if (vm === null) return
        options.emit('attempt:end', {
          delegationId,
          attemptId: event.attemptId,
          outcome: event.outcome,
        })
        return
      }
      case 'deleg.channel': {
        const delegationId = context.streamId
        if (delegationId === null) return
        const vm = patchAttempt(delegationId, event.attemptId, at, (attempt) => ({
          ...attempt,
          channel: event.channel,
        }))
        if (vm === null) return
        options.emit('delegation:update', { delegationId, vm })
        return
      }
      case 'deleg.turn_prepared': {
        const delegationId = context.streamId
        if (delegationId === null) return
        const vm = patchAttempt(delegationId, event.turn.attemptId, at, (attempt) => ({
          ...attempt,
          currentTurn: event.turn,
        }))
        if (vm === null) return
        options.emit('turn:prepared', { delegationId, turn: event.turn })
        return
      }
      case 'deleg.turn_delivery': {
        const delegationId = context.streamId
        if (delegationId === null) return
        const vm = patchTurn(delegationId, event.turnId, at, (turn) => ({
          ...turn,
          delivery: event.delivery,
          landing: event.detail.landing,
        }))
        if (vm === null) return
        options.emit('turn:delivery', {
          delegationId,
          turnId: event.turnId,
          delivery: event.delivery,
          detail: event.detail,
        })
        return
      }
      case 'deleg.turn_ended': {
        const delegationId = context.streamId
        if (delegationId === null) return
        const vm = patch(delegationId, at, (current) => ({
          ...current,
          attempts: current.attempts.map((attempt) =>
            attempt.currentTurn?.id === event.turnId
              ? {
                  ...attempt,
                  turns: attempt.turns + 1,
                  toolCalls: attempt.toolCalls + event.toolCalls,
                  currentTurn: { ...attempt.currentTurn, toolCalls: event.toolCalls },
                }
              : attempt,
          ),
        }))
        if (vm === null) return
        options.emit('turn:end', {
          delegationId,
          turnId: event.turnId,
          toolCalls: event.toolCalls,
        })
        return
      }
      case 'deleg.turn_retracted': {
        const delegationId = context.streamId
        if (delegationId === null) return
        const affected = new Set<string>([event.report.requested, ...event.report.alsoRetracted])
        patch(delegationId, at, (current) => ({
          ...current,
          attempts: current.attempts.map((attempt) =>
            attempt.currentTurn !== null && affected.has(attempt.currentTurn.id)
              ? {
                  ...attempt,
                  currentTurn:
                    event.report.restoredTo === 'deleted'
                      ? null
                      : { ...attempt.currentTurn, delivery: 'prepared' as const },
                }
              : attempt,
          ),
        }))
        options.emit('turn:retracted', { delegationId, report: event.report })
        return
      }
      case 'deleg.verify_started': {
        const delegationId = context.streamId
        if (delegationId === null) return
        options.emit('verify:start', {
          delegationId,
          attemptId: event.attemptId,
          runId: event.runId,
        })
        return
      }
      case 'deleg.verify_result': {
        const delegationId = context.streamId
        if (delegationId === null) return
        patchAttempt(delegationId, event.run.attemptId, at, (attempt) => ({
          ...attempt,
          verification: {
            runNo: event.run.runNo,
            verdict: event.run.verdict,
            at: event.run.endedAt,
          },
          evidenceRef: event.run.evidenceRef,
        }))
        options.emit('verify:result', { delegationId, run: event.run })
        return
      }
      case 'deleg.landed': {
        const delegationId = context.streamId
        if (delegationId === null) return
        patch(delegationId, at, (current) => ({ ...current, landed: true }))
        options.emit('land:result', { delegationId, landing: event.landing })
        return
      }
      case 'deleg.drift': {
        const delegationId = context.streamId
        if (delegationId === null) return
        options.emit('drift', {
          delegationId,
          attemptId: event.attemptId,
          kind: event.kind,
          detail: event.detail,
        })
        return
      }
      case 'deleg.evidence': {
        const delegationId = context.streamId
        if (delegationId === null) return
        patchAttempt(delegationId, event.attemptId, at, (attempt) => ({
          ...attempt,
          evidenceRef: event.evidenceRef,
        }))
        options.emit('evidence', {
          delegationId,
          attemptId: event.attemptId,
          evidenceRef: event.evidenceRef,
        })
        return
      }
      case 'deleg.defaults_updated': {
        const delegationId = context.streamId
        if (delegationId === null) return
        const vm = patch(delegationId, at, (current) => ({
          ...current,
          version: event.version,
          defaults: {
            ...current.defaults,
            ...(event.patch.model === undefined ? {} : { model: event.patch.model }),
            ...(event.patch.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: event.patch.reasoningEffort }),
            ...(event.patch.delivery === undefined ? {} : { delivery: event.patch.delivery }),
          },
        }))
        if (vm === null) return
        options.emit('delegation:update', { delegationId, vm })
        return
      }

      /* `att.*` — the high-volume stream. Deltas feed `TranscriptVM`/`DiffVM` through the
       * ref-counted handles, not the event bus (§6.4's empty projections); what lands on the
       * delegation VM is the one-line "now doing" (W4) and the attempt's own counters. */
      case 'att.tool': {
        const attemptId = context.streamId
        if (attemptId === null) return
        const delegationId = attemptOwners.get(attemptId)
        if (delegationId === undefined) return
        const nowDoing =
          event.status === 'done' || event.status === 'error'
            ? null
            : toolLine(event.name, event.target)
        patchAttempt(delegationId, attemptId, at, (attempt) => ({
          ...attempt,
          nowDoing,
          toolCalls: event.status === 'start' ? attempt.toolCalls + 1 : attempt.toolCalls,
        }))
        return
      }
      case 'att.usage': {
        const attemptId = context.streamId
        if (attemptId === null) return
        const delegationId = attemptOwners.get(attemptId)
        if (delegationId === undefined) return
        patchAttempt(delegationId, attemptId, at, (attempt) => ({
          ...attempt,
          spend: addSpendEvent(attempt.spend, event.input, event.output),
        }))
        return
      }
      case 'att.diff': {
        const attemptId = context.streamId
        if (attemptId === null) return
        const delegationId = attemptOwners.get(attemptId)
        if (delegationId === undefined) return
        /* Only the attempt's own `staleBase` moves: `DelegationVM.staleBase` is a server ruling
         * (it drives `needs-you`), and a client that derived it would out-vote the server. */
        patchAttempt(delegationId, attemptId, at, (attempt) => ({
          ...attempt,
          staleBase: event.staleBase,
        }))
        return
      }
      case 'att.error': {
        /* An executor-level failure, not a swarm one: `code` is jcode's vocabulary, so it is
         * carried in `details` and the swarm code stays `executor_refused` unless it happens to
         * be one of §9's own. */
        options.emit(
          'error',
          new SwarmErrorClass(
            isSwarmErrorCode(event.code) ? event.code : 'executor_refused',
            event.message,
            {
              retryable: false,
              details: { attemptId: context.streamId, executorCode: event.code },
            },
          ),
        )
        return
      }
      case 'att.text':
      case 'att.reasoning':
      case 'att.background':
      case 'att.turn_boundary':
        return
    }
  }

  return {
    delegations: () => delegations,
    fleet: () => fleet,
    health: () => health,
    notices: () => notices,
    confirmations: () => confirmations,

    applyServerSnapshot(snapshot) {
      health = deepFreeze(snapshot.health)
      healthChanged = true
      notices = deepFreeze([...snapshot.notices].slice(-NOTICE_RETENTION))
      noticesChanged = true
      confirmations = deepFreeze([...snapshot.confirmations])
    },

    applyFleetSnapshot(snapshot) {
      const at = options.now()
      /* A snapshot **replaces**: it is the fully materialized view at `seq`, and a merge would
       * keep a delegation the server has since purged (§2.3). Every row then goes through the
       * same derivation an event uses, so snapshot and replay converge byte-for-byte. */
      delegations = new Map()
      delegationsChanged = true
      for (const vm of snapshot.delegations) {
        seed(vm, at)
        put(vm, at)
      }
      setFleet((current) => ({
        ...current,
        concurrency: snapshot.concurrency,
        dispatchPaused: snapshot.dispatchPaused,
        spend: snapshot.spend,
      }))
      fleetChanged = true
    },

    applyDelegationSnapshot(snapshot) {
      const at = options.now()
      seed(snapshot.delegation, at)
      put(snapshot.delegation, at)
    },

    applyAttemptSnapshot() {
      /* The attempt stream's materialized state is the transcript and the diff; both live in the
       * ref-counted handles (`./transcript.ts`), which subscribe to the same delivery. */
    },

    applyEvent,

    pushNotice,

    setFilter(next) {
      filter = next
      delegationsChanged = true
      fleetChanged = true
    },

    optimisticDelegation(vm) {
      const at = options.now()
      seed(vm, at)
      put(vm, at)
    },

    optimisticTurn(delegationId, attemptId, turn) {
      const at = options.now()
      const target = attemptId ?? delegations.get(delegationId)?.liveAttemptIds[0] ?? null
      if (target === null) return
      patchAttempt(delegationId, target, at, (attempt) => ({ ...attempt, currentTurn: turn }))
    },

    setFocusedAttempt(delegationId, attemptId) {
      focusedAttempt.set(delegationId, attemptId)
      const current = delegations.get(delegationId)
      if (current !== undefined) put(current, options.now())
    },

    attemptOwner(attemptId) {
      return attemptOwners.get(attemptId) ?? null
    },

    drain() {
      if (delegationsChanged) rebuildFleet()
      const result: ProjectionResult = {
        delegationsChanged,
        fleetChanged: fleetChanged || delegationsChanged,
        healthChanged,
        noticesChanged,
      }
      delegationsChanged = false
      fleetChanged = false
      healthChanged = false
      noticesChanged = false
      return result
    },
  }
}
