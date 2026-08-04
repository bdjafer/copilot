/**
 * The projection: client-core stores → one frozen `SwarmHeadViewModel` (§6.8's shape, extended by
 * `types.ts`).
 *
 * **The head owns zero orchestration.** Everything here is a pure function of view models the core
 * already derived: no scheduling, no admission, no verdicts, no conflict resolution (H8, X11). The
 * three things it *does* compute are all presentation-local and all cheap:
 *
 *  1. **Bucket order** — F1's nine buckets in attention order, with the core's own `counts` (which
 *     stay unfiltered so a filtered head can still say "3 of 12 need you") and the core's own
 *     attention-sorted row ids. `bucketOf` is never re-implemented here; the rows arrive bucketed.
 *  2. **`configLocked`** — §4.3.6's refusal, rendered *before* the click instead of after it.
 *  3. **The honesty list** — S8/S10/S11 (release gate 10). These are statements about what this
 *     system cannot do; they are constants because they are true regardless of any server state,
 *     and the two that depend on a probe (`approvals`, `effort`) say so with the probe's value.
 *
 * Head deviation **E3 — the workspace picker.** C4 wants "root from an allowlist" and C7 puts the
 * *route* catalog on `HealthVM.routes`; nothing in §6.2, §6.4 or §2.3's snapshots carries
 * `WorkspaceRegistration`, which lives only in the server's `config.json` (§7.3). So the picker is
 * seeded from the workspace ids observed on existing delegations and otherwise accepts free text,
 * with the server's `workspace_denied` as the authority. A picker that invented roots would be a
 * worse lie than an input that admits the server decides.
 *
 * DOM-free: this module builds data, never nodes.
 */

import type {
  ConfirmationRequest,
  ConnectionVM,
  DelegationId,
  DelegationVM,
  FleetBucket,
  FleetVM,
  HealthVM,
  NoticeVM,
  TranscriptVM,
} from '@astrale-os/swarm'
import type { SwarmBucketVM, SwarmNoticeVM, SwarmRowVM } from '@astrale-os/swarm/presentation'

import { effortLadder, REASONING_EFFORTS, TURN_DELIVERY_MODES } from '@astrale-os/swarm'

import type {
  SwarmHeadAttemptVM,
  SwarmHeadDelegationVM,
  SwarmHeadPairingVM,
  SwarmHeadTranscriptVM,
  SwarmHeadTurnVM,
  SwarmHeadViewModel,
} from './types.ts'

/** F1's order is the attention order: what needs you, then what broke, then what is running. */
export const BUCKET_ORDER: readonly FleetBucket[] = [
  'needs-you',
  'failed',
  'stalled',
  'working',
  'queued',
  'done-unlanded',
  'done-landed',
  'cancelled',
  'abandoned',
]

/** Nouns, not sentences — §10 keeps section titles because they are navigation (DESIGN §8.5/A1). */
export const BUCKET_LABEL: Record<FleetBucket, string> = {
  'needs-you': 'needs you',
  failed: 'failed',
  stalled: 'stalled',
  working: 'working',
  queued: 'queued',
  'done-unlanded': 'unlanded',
  'done-landed': 'landed',
  cancelled: 'cancelled',
  abandoned: 'abandoned',
}

/** §4.3.6: these four channel states refuse an effort or model change with `turn_in_flight`. */
const CONFIG_LOCKED_CHANNELS: readonly string[] = [
  'submitting',
  'accepted',
  'streaming',
  'interrupting',
]

export interface HeadProjectionInput {
  readonly pairing: SwarmHeadPairingVM
  readonly connection: ConnectionVM
  readonly fleet: FleetVM
  readonly delegations: ReadonlyMap<DelegationId, DelegationVM>
  readonly health: HealthVM
  readonly notices: readonly NoticeVM[]
  /** Refusals and wiring failures the head raised itself; same shape, `local:` ids. */
  readonly localNotices: readonly SwarmNoticeVM[]
  readonly confirmations: readonly ConfirmationRequest[]
  readonly focusId: DelegationId | null
  readonly transcript: TranscriptVM | null
  readonly now: number
}

export function projectHeadViewModel(input: HeadProjectionInput): SwarmHeadViewModel {
  const focused = input.focusId === null ? null : (input.delegations.get(input.focusId) ?? null)

  return Object.freeze({
    pairing: input.pairing,
    connection: Object.freeze({
      status: input.connection.status,
      blockedReason: input.connection.blockedReason,
      queuedOffline: input.connection.queuedOffline,
    }),
    fleet: Object.freeze({
      buckets: buildBuckets(input.fleet, input.delegations),
      dispatchPaused: input.fleet.dispatchPaused,
      concurrency: input.fleet.concurrency,
      spend: Object.freeze({
        estUsd: input.fleet.spend.estUsd,
        capUsd: input.fleet.spend.capUsd,
      }),
    }),
    focused: focused === null ? null : buildDelegation(focused, input),
    notices: buildNotices(input.notices, input.localNotices),
    confirmations: Object.freeze(
      input.confirmations.map((request) =>
        Object.freeze({
          requestId: request.requestId,
          summary: request.summary,
          detail: `${request.tool} · ${request.effective.model} · ${request.effective.workspace} (${request.effective.writeMode})`,
          expiresInMs: Math.max(0, request.expiresAt - input.now),
        }),
      ),
    ),
    health: Object.freeze({
      ok: input.health.server.ok && input.health.executor.ok,
      detail: healthDetail(input.health),
      fix: input.health.executor.fix,
      routes: Object.freeze(
        input.health.routes.map((route) =>
          Object.freeze({
            model: route.model,
            provider: route.provider,
            available: route.available,
            detail: route.detail,
          }),
        ),
      ),
      honesty: honesty(input.health, input.notices),
    }),
    workspaces: buildWorkspaces(input.delegations),
    deliveryModes: TURN_DELIVERY_MODES,
    efforts: REASONING_EFFORTS,
  })
}

/* ------------------------------------------------------------------- fleet */

function buildBuckets(
  fleet: FleetVM,
  delegations: ReadonlyMap<DelegationId, DelegationVM>,
): readonly SwarmBucketVM[] {
  return Object.freeze(
    BUCKET_ORDER.map((bucket) =>
      Object.freeze({
        id: bucket,
        label: BUCKET_LABEL[bucket],
        // The core's own count, NOT `rows.length`: the filter narrows rows and never counts, so
        // "2 shown of 7 needing you" stays sayable (§6.2 projections).
        count: fleet.counts[bucket],
        rows: Object.freeze(
          fleet.buckets[bucket]
            .map((id) => delegations.get(id))
            .filter((vm): vm is DelegationVM => vm !== undefined)
            .map(buildRow),
        ),
      }),
    ),
  )
}

function buildRow(vm: DelegationVM): SwarmRowVM {
  return Object.freeze({
    id: vm.id,
    title: vm.title,
    bucket: vm.bucket,
    badge: rowBadge(vm),
    nowDoing: vm.nowDoing,
    attention: vm.attentionScore,
    attempts: vm.attempts.length,
    paused: vm.dispatchPaused,
  })
}

/**
 * One value, never a verb. `needs-you`'s reason outranks everything (it is why the row is at the
 * top), then the verdict, then the facts a row can be wrong about silently: a stale base and an
 * unverifiable delegation (Q1 — a delegation with no criteria can never verify itself).
 */
function rowBadge(vm: DelegationVM): string | null {
  if (vm.needsYou !== null) return vm.needsYou
  if (vm.verdict !== null) return vm.verdict
  if (vm.stalledForMs !== null) return `stalled ${Math.round(vm.stalledForMs / 1000)}s`
  if (vm.staleBase) return 'stale base'
  if (vm.unverifiable) return 'unverifiable'
  return null
}

/* -------------------------------------------------------------- delegation */

function buildDelegation(vm: DelegationVM, input: HeadProjectionInput): SwarmHeadDelegationVM {
  /* §6.8's attempt row carries `filesChanged`, and `AttemptVM` has no such field — the only place
   * the number exists is `AttemptComparisonVM`, which is non-null once two attempts have evidence
   * (A5). So it is read from there when it exists and is **absent as 0** otherwise, rather than
   * being invented: a diff size nobody measured is exactly the kind of number S8 forbids. */
  const filesChanged = new Map<string, number>(
    (vm.comparison?.attempts ?? []).map((attempt) => [attempt.id, attempt.filesChanged]),
  )
  const attempts = vm.attempts.map((attempt) =>
    buildAttempt(attempt, filesChanged.get(attempt.id) ?? 0),
  )
  const focusedAttemptId = vm.focusedAttemptId ?? vm.liveAttemptIds[0] ?? attempts[0]?.id ?? null
  const focusedAttempt = attempts.find((attempt) => attempt.id === focusedAttemptId) ?? null

  return Object.freeze({
    ...buildRow(vm),
    objective: vm.spec.objective,
    objectiveLines: Object.freeze(vm.spec.objective.split('\n')),
    state: vm.state,
    verdict: vm.verdict,
    needsYou: vm.needsYou,
    stalledForMs: vm.stalledForMs,
    staleBase: vm.staleBase,
    unverifiable: vm.unverifiable,
    landed: vm.landed,
    baseRef: vm.baseRef,
    baseRevision: vm.baseRevision,
    writeMode: vm.spec.workspace.writeMode,
    workspaceId: vm.spec.workspace.workspaceId,
    focusedAttemptId,
    defaults: Object.freeze({
      model: vm.defaults.model,
      reasoningEffort: vm.defaults.reasoningEffort,
      delivery: vm.defaults.delivery,
    }),
    effective: buildEffective(vm),
    attempts: Object.freeze(attempts),
    acceptance: Object.freeze(
      vm.acceptance.map((criterion) =>
        Object.freeze({ id: criterion.id, label: criterion.label, status: criterion.status }),
      ),
    ),
    budget: Object.freeze({
      worstFraction: vm.budget.worstFraction,
      label: budgetLabel(vm),
    }),
    turn: buildTurn(vm, focusedAttempt),
    transcript: buildTranscript(input.transcript, focusedAttemptId),
    ladder: effortLadder(vm.defaults.provider, vm.defaults.model),
    deliveryModes: TURN_DELIVERY_MODES,
    comparison: buildComparison(vm),
  })
}

/**
 * The cascade's *shown* value (§5.3.1, C7b): the delegation default, plus the two honesty bits the
 * turn carries. With a turn in flight the turn's own effective config wins, because that is what
 * is actually running; with none, the delegation default is what the next turn will reconcile to
 * (Q4 — never the previous turn's override).
 */
function buildEffective(vm: DelegationVM): SwarmHeadDelegationVM['effective'] {
  const turn = vm.currentTurn
  if (turn === null) {
    return Object.freeze({
      model: vm.defaults.model,
      reasoningEffort: vm.defaults.reasoningEffort,
      effortConfirmed: false as const,
      inherited: false,
    })
  }
  return Object.freeze({
    model: turn.effective.model,
    reasoningEffort:
      turn.effective.reasoningEffort === null ? null : String(turn.effective.reasoningEffort),
    effortConfirmed: false as const,
    inherited: turn.configInherited,
  })
}

function buildAttempt(
  attempt: DelegationVM['attempts'][number],
  filesChanged: number,
): SwarmHeadAttemptVM {
  return Object.freeze({
    id: attempt.id,
    attemptNo: attempt.attemptNo,
    live: attempt.live,
    channel: attempt.channel,
    verdict: attempt.verification === null ? null : attempt.verification.verdict,
    filesChanged,
    estUsd: attempt.spend.estUsd,
    outcome: attempt.outcome,
    nowDoing: attempt.nowDoing,
    staleBase: attempt.staleBase,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt,
    turns: attempt.turns,
    toolCalls: attempt.toolCalls,
    evidenceRef: attempt.evidenceRef,
    verification:
      attempt.verification === null
        ? null
        : Object.freeze({
            runNo: attempt.verification.runNo,
            verdict: attempt.verification.verdict,
            at: attempt.verification.at,
          }),
  })
}

function buildTurn(vm: DelegationVM, attempt: SwarmHeadAttemptVM | null): SwarmHeadTurnVM | null {
  const turn = vm.currentTurn
  if (turn === null) return null
  return Object.freeze({
    id: turn.id,
    attemptId: turn.attemptId,
    delivery: turn.delivery,
    landing: turn.landing,
    model: String(turn.effective.model),
    reasoningEffort:
      turn.effective.reasoningEffort === null ? null : String(turn.effective.reasoningEffort),
    effortConfirmed: false as const,
    configInherited: turn.configInherited,
    elapsedMs: turn.elapsedMs,
    toolCalls: turn.toolCalls,
    configLocked: attempt !== null && CONFIG_LOCKED_CHANNELS.includes(attempt.channel),
  })
}

function buildTranscript(
  transcript: TranscriptVM | null,
  attemptId: string | null,
): SwarmHeadTranscriptVM {
  if (transcript === null || (attemptId !== null && transcript.attemptId !== attemptId)) {
    return Object.freeze({
      attemptId,
      following: true,
      lagged: false,
      hasOlder: false,
      entries: Object.freeze([]),
    })
  }
  return Object.freeze({
    attemptId: transcript.attemptId,
    following: transcript.following,
    lagged: transcript.lagged,
    hasOlder: transcript.hasOlder,
    entries: transcript.entries,
  })
}

/** A5 — a flagship parallel-attempt loop with no comparison surface is a retry log. */
function buildComparison(vm: DelegationVM): SwarmHeadDelegationVM['comparison'] {
  if (vm.comparison === null) return Object.freeze([])
  return Object.freeze(
    vm.comparison.attempts.map((attempt) =>
      Object.freeze({
        id: attempt.id,
        attemptNo: attempt.attemptNo,
        verdict: attempt.verdict,
        filesChanged: attempt.filesChanged,
        estUsd: attempt.estUsd,
        // Never auto-lands (§6.2): a recommendation is a sort order with a reason, not a verdict.
        recommended: vm.comparison?.recommendation === attempt.id,
      }),
    ),
  )
}

function budgetLabel(vm: DelegationVM): string {
  const used = vm.budget.used
  const limit = vm.budget.limit
  const percent = Math.round(vm.budget.worstFraction * 100)
  return `${percent}% · ${used.turns}/${limit.maxTurns} turns · ${used.toolCalls}/${limit.maxToolCalls} tools · $${used.estUsd.toFixed(2)}`
}

/* ---------------------------------------------------------- notices, health */

function buildNotices(
  server: readonly NoticeVM[],
  local: readonly SwarmNoticeVM[],
): readonly SwarmNoticeVM[] {
  return Object.freeze([
    ...local,
    ...server.map((notice) =>
      Object.freeze({
        id: notice.id,
        kind: notice.kind,
        severity: notice.severity,
        title: notice.title,
        detail: notice.detail,
        dismissible: notice.dismissible,
      }),
    ),
  ])
}

function healthDetail(health: HealthVM): string {
  if (!health.server.ok) return 'server unhealthy'
  if (!health.executor.ok) {
    return `${health.executor.adapterId} blocked: ${health.executor.blocked ?? 'unknown'}`
  }
  const available = health.routes.filter((route) => route.available).length
  const instances = health.instances.filter((instance) => instance.ok).length
  return `${available}/${health.routes.length} routes · ${instances}/${health.instances.length} instances`
}

/**
 * The in-product honesty surface (S8, S10, S11 — release gate 10). Four statements, and every one
 * of them is a thing this product **cannot** do rather than a thing it does:
 *
 *  - authority is structural (S8) — the agent holds bash with the user's privileges;
 *  - approvals are dark unless the runtime probe says otherwise (R6, S14);
 *  - effort is declared, never observed (§4.3.4, §5.1) — no getter exists in protocol v1;
 *  - network allowlisting is unenforceable without a container (S11).
 *
 * A `notice{kind:'honesty'}` from the server is folded in rather than replacing them: the server
 * knows about *its* configuration (a `sensitive` workspace, `inheritLogins`), the head knows about
 * the protocol.
 */
function honesty(
  health: HealthVM,
  notices: readonly NoticeVM[],
): readonly { readonly id: string; readonly title: string; readonly detail: string }[] {
  const base = [
    {
      id: 'authority',
      title: 'authority is structural',
      detail:
        'agents run bash with your privileges. The boundaries that hold are the workspace ' +
        'allowlist, worktree isolation and a scrubbed environment — not a permission prompt.',
    },
    {
      id: 'approvals',
      title: health.approvalsAvailable ? 'approvals available' : 'approvals are non-functional',
      detail: health.approvalsAvailable
        ? 'the executor advertises the permissions capability, so approval prompts are live.'
        : 'protocol v1 advertises no permissions capability; per-call approval is shipped dark.',
    },
    {
      id: 'effort',
      title: 'reasoning effort is declared, never confirmed',
      detail:
        'the executor discards the applied value and exposes no getter, so every effort shown ' +
        'anywhere in this head is what was asked for — not what ran.',
    },
    {
      id: 'network',
      title: 'network access is not restricted',
      detail:
        'network allowlisting is unenforceable without a container; this product claims none.',
    },
  ]
  const fromServer = notices
    .filter((notice) => notice.kind === 'honesty')
    .map((notice) => ({ id: notice.id, title: notice.title, detail: notice.detail }))
  return Object.freeze([...base, ...fromServer].map((entry) => Object.freeze(entry)))
}

function buildWorkspaces(
  delegations: ReadonlyMap<DelegationId, DelegationVM>,
): readonly { readonly id: string; readonly label: string }[] {
  const seen = new Map<string, string>()
  for (const vm of delegations.values()) {
    const id = vm.spec.workspace.workspaceId
    if (!seen.has(id)) seen.set(id, id)
  }
  return Object.freeze(
    [...seen.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([id, label]) => Object.freeze({ id, label })),
  )
}
