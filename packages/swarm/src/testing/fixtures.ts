/**
 * Fixtures for the conformance suites and for host test suites.
 *
 * Every builder returns a **valid** value of the spec's shape with sensible overrides, so a test
 * that cares about one field does not have to spell forty. `sampleEvent` in particular covers all
 * **34** `SwarmEvent` kinds (§6.4): it is what lets `protocolConformance()` assert the routing
 * table by construction rather than by inspection.
 *
 * DOM-free and Node-free.
 */

import type { SwarmEvent, SwarmEventKind } from '../protocol/events.ts'
import type {
  ActorRef,
  AttemptVM,
  ConfirmationRequest,
  CreateDelegationInput,
  DelegationSpec,
  DelegationVM,
  HealthVM,
  KillReport,
  LandingRecord,
  NoticeVM,
  PreflightReport,
  RetractReport,
  TurnDirective,
  TurnVM,
  VerificationRun,
} from '../types.ts'

import { emptySpendCounters } from '../domain/budget.ts'
import { bucketOf } from '../domain/rollup.ts'
import { SWARM_EVENT_KINDS } from '../protocol/events.ts'

/** A 40-char sha, because §3.1 forbids a symbolic ref in a persisted record (C4b). */
export const BASE_REVISION = '9f2c1ab0000000000000000000000000000000ab'

export function makeActor(overrides: Partial<Extract<ActorRef, { kind: 'user' }>> = {}): ActorRef {
  return { kind: 'user', head: 'test', tokenId: 'tok-test', ...overrides }
}

export function makeDelegationSpec(overrides: Partial<DelegationSpec> = {}): DelegationSpec {
  return {
    specVersion: 1,
    objective: 'Make test/auth.spec.ts deterministic. Do not weaken the assertions.',
    acceptance: [
      {
        kind: 'command',
        id: 'unit',
        label: 'unit suite',
        command: 'pnpm test -- auth',
        timeoutMs: 300_000,
      },
    ],
    workspace: {
      workspaceId: 'exp-spec',
      baseRevision: BASE_REVISION,
      writeMode: 'worktree',
    },
    model: { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: 'medium' },
    budget: {
      maxWallMs: 45 * 60_000,
      maxTurns: 30,
      maxToolCalls: 200,
      maxInputTokens: 2_000_000,
      maxOutputTokens: 200_000,
      onBreach: 'pause-dispatch',
    },
    execution: { nativeSwarm: false, jcodeMemory: false, autoPoke: true, skills: [] },
    context: [],
    delivery: { mode: 'after-turn', notify: 'notify' },
    parallelAttempts: 1,
    ...overrides,
  }
}

export function makeCreateInput(
  overrides: Partial<CreateDelegationInput> = {},
): CreateDelegationInput {
  const { workspace: _dropped, ...rest } = makeDelegationSpec()
  return {
    idempotencyKey: 'idem-1',
    spec: {
      ...rest,
      workspace: { workspaceId: 'exp-spec', baseRef: 'HEAD', writeMode: 'worktree' },
    },
    ...overrides,
  }
}

export function makeTurnDirective(overrides: Partial<TurnDirective> = {}): TurnDirective {
  return { text: 'Plan the fix first.', idempotencyKey: 'idem-turn-1', ...overrides }
}

export function makeTurnVM(overrides: Partial<TurnVM> = {}): TurnVM {
  return {
    id: 'turn-1',
    attemptId: 'attempt-1',
    delivery: 'prepared',
    effective: {
      provider: 'anthropic',
      model: 'claude-opus-5',
      reasoningEffort: 'medium',
      effortConfirmed: false,
      modelConfirmed: false,
      deliveryMode: 'after-turn',
      structured: null,
      budget: null,
      executorVersions: { jcode: '0.67.0' },
    },
    landing: 'n/a',
    effortConfirmed: false,
    configInherited: false,
    elapsedMs: 0,
    toolCalls: 0,
    ...overrides,
  }
}

export function makeAttemptVM(overrides: Partial<AttemptVM> = {}): AttemptVM {
  return {
    id: 'attempt-1',
    attemptNo: 1,
    live: true,
    channel: 'idle',
    outcome: 'open',
    sessionId: 'session-1',
    worktree: '/tmp/swarm/worktrees/delegation-1/1',
    staleBase: false,
    nowDoing: null,
    startedAt: 1,
    endedAt: null,
    turns: 0,
    toolCalls: 0,
    spend: emptySpendCounters(),
    currentTurn: null,
    verification: null,
    evidenceRef: null,
    ...overrides,
  }
}

export function makeDelegationVM(overrides: Partial<DelegationVM> = {}): DelegationVM {
  const spec = overrides.spec ?? makeDelegationSpec()
  const state = overrides.state ?? 'running'
  const landed = overrides.landed ?? false
  const stalledForMs = overrides.stalledForMs ?? null
  return {
    id: 'delegation-1',
    version: 1,
    title: 'Fix flaky auth test',
    state,
    verdict: null,
    bucket: bucketOf({ state, stalledForMs, landed }),
    unverifiable: spec.acceptance.length === 0,
    dispatchPaused: false,
    landed,
    attentionScore: 0,
    nowDoing: null,
    stalledForMs,
    staleBase: false,
    needsYou: null,
    spec,
    defaults: {
      provider: spec.model.provider,
      model: spec.model.model,
      reasoningEffort: spec.model.reasoningEffort,
      delivery: spec.delivery.mode,
    },
    baseRef: 'HEAD',
    baseRevision: spec.workspace.baseRevision,
    liveAttemptIds: ['attempt-1'],
    focusedAttemptId: 'attempt-1',
    origin: null,
    currentTurn: null,
    attempts: [makeAttemptVM()],
    comparison: null,
    budget: { used: emptySpendCounters(), limit: spec.budget, worstFraction: 0 },
    acceptance: spec.acceptance.map((c) => ({
      id: c.id,
      label: c.label,
      status: 'unrun' as const,
    })),
    ...overrides,
  }
}

export function makePreflightReport(overrides: Partial<PreflightReport> = {}): PreflightReport {
  return {
    ok: true,
    detail: 'jcode 0.67.0',
    versions: { jcode: '0.67.0' },
    blocked: null,
    fix: null,
    ...overrides,
  }
}

export function makeHealthVM(overrides: Partial<HealthVM> = {}): HealthVM {
  return {
    server: { ok: true, version: '0.1.0', uptimeMs: 1000 },
    executor: { ok: true, adapterId: 'mock', versions: { mock: '1' }, blocked: null, fix: null },
    instances: [],
    routes: [],
    approvalsAvailable: false,
    lastDoctorAt: null,
    ...overrides,
  }
}

export function makeNoticeVM(overrides: Partial<NoticeVM> = {}): NoticeVM {
  return {
    id: 'notice-1',
    kind: 'honesty',
    severity: 'info',
    title: 'Effort is declared, not confirmed',
    detail: 'jcode discards the applied reasoning effort; swarm records what it asked for.',
    at: 1,
    actions: [{ intent: 'dismiss', label: 'Dismiss' }],
    dismissible: true,
    ...overrides,
  }
}

export function makeVerificationRun(overrides: Partial<VerificationRun> = {}): VerificationRun {
  return {
    runId: 'run-1',
    attemptId: 'attempt-1',
    runNo: 1,
    startedAt: 1,
    endedAt: 2,
    verdict: 'pass',
    results: [
      {
        id: 'unit',
        kind: 'command',
        status: 'pass',
        exitCode: 0,
        durationMs: 10,
        stdoutRef: 'evidence/attempt-1/run-1/unit.out',
        stderrRef: 'evidence/attempt-1/run-1/unit.err',
        truncated: false,
      },
    ],
    baseRevisionAtRun: BASE_REVISION,
    staleBase: false,
    evidenceRef: 'evidence/attempt-1/run-1',
    ...overrides,
  }
}

export function makeLandingRecord(overrides: Partial<LandingRecord> = {}): LandingRecord {
  return {
    mode: 'commit',
    attemptId: 'attempt-1',
    ref: 'fix/flaky-auth',
    sha: BASE_REVISION,
    at: 3,
    ...overrides,
  }
}

export function makeRetractReport(overrides: Partial<RetractReport> = {}): RetractReport {
  return {
    requested: 'turn-1',
    alsoRetracted: [],
    sessionWide: false,
    restoredTo: 'deleted',
    ...overrides,
  }
}

/** Literal-empty tuples included, so the fixture cannot express a kill switch that terminalizes. */
export function makeKillReport(overrides: Partial<KillReport> = {}): KillReport {
  return {
    at: 4,
    turnsCancelled: [],
    attemptsAffected: [],
    instancesKilled: [],
    dispatchPausedFleetWide: true,
    delegationsTerminated: [],
    worktreesRemoved: [],
    ...overrides,
  }
}

export function makeConfirmationRequest(
  overrides: Partial<ConfirmationRequest> = {},
): ConfirmationRequest {
  return {
    requestId: 'confirm-1',
    at: 1,
    expiresAt: 120_001,
    tool: 'swarm.start',
    requestedBy: { kind: 'copilot', conversationId: 'conv-1' },
    summary: 'Start a delegation against exp-spec',
    payload: makeCreateInput(),
    effective: {
      provider: 'anthropic',
      model: 'claude-opus-5',
      reasoningEffort: 'medium',
      workspace: 'exp-spec',
      writeMode: 'worktree',
    },
    ...overrides,
  }
}

/**
 * One valid event per kind (§6.4). The switch is exhaustive over `SwarmEventKind`, so a kind
 * added to the union without a fixture is a compile error — which is the point: the conformance
 * suite iterates `SWARM_EVENT_KINDS` and would otherwise silently skip the new one.
 */
export function sampleEvent(kind: SwarmEventKind): SwarmEvent {
  switch (kind) {
    case 'server.hello':
      return { k: 'server.hello', version: '0.1.0', bootId: 'boot-1' }
    case 'server.health':
      return { k: 'server.health', health: makeHealthVM() }
    case 'server.doctor':
      return { k: 'server.doctor', report: makePreflightReport() }
    case 'server.notice':
      return { k: 'server.notice', notice: makeNoticeVM() }
    case 'server.pairing':
      return { k: 'server.pairing', tokenId: 'tok-1', action: 'issued', clientName: 'Chrome' }
    case 'server.confirmation':
      return { k: 'server.confirmation', request: makeConfirmationRequest() }
    case 'server.confirmation_resolved':
      return { k: 'server.confirmation_resolved', requestId: 'confirm-1', decision: 'confirm' }
    case 'fleet.delegation_created':
      return { k: 'fleet.delegation_created', delegation: makeDelegationVM() }
    case 'fleet.delegation_state':
      return {
        k: 'fleet.delegation_state',
        delegationId: 'delegation-1',
        state: 'needs-you',
        bucket: 'needs-you',
        version: 2,
      }
    case 'fleet.delegation_summary':
      return { k: 'fleet.delegation_summary', delegation: makeDelegationVM() }
    case 'fleet.spend':
      return { k: 'fleet.spend', spend: { ...emptySpendCounters(), capUsd: null } }
    case 'fleet.caps':
      return {
        k: 'fleet.caps',
        concurrency: { runningAttempts: 1, cap: 4, queued: 0 },
        dispatchPaused: false,
      }
    case 'fleet.kill_switch':
      return { k: 'fleet.kill_switch', report: makeKillReport() }
    case 'deleg.attempt_started':
      return { k: 'deleg.attempt_started', attempt: makeAttemptVM() }
    case 'deleg.attempt_ended':
      return { k: 'deleg.attempt_ended', attemptId: 'attempt-1', outcome: 'interrupted' }
    case 'deleg.channel':
      return { k: 'deleg.channel', attemptId: 'attempt-1', channel: 'streaming' }
    case 'deleg.turn_prepared':
      return { k: 'deleg.turn_prepared', turn: makeTurnVM() }
    case 'deleg.turn_delivery':
      return {
        k: 'deleg.turn_delivery',
        turnId: 'turn-1',
        delivery: 'unknown',
        detail: { ackAtMs: null, correlated: false, landing: 'unconfirmed' },
      }
    case 'deleg.turn_ended':
      return {
        k: 'deleg.turn_ended',
        turnId: 'turn-1',
        usage: { input: 10, output: 20 },
        toolCalls: 2,
      }
    case 'deleg.turn_retracted':
      return { k: 'deleg.turn_retracted', report: makeRetractReport() }
    case 'deleg.verify_started':
      return {
        k: 'deleg.verify_started',
        attemptId: 'attempt-1',
        runId: 'run-1',
        reason: 'auto-turn-end',
      }
    case 'deleg.verify_result':
      return { k: 'deleg.verify_result', run: makeVerificationRun() }
    case 'deleg.landed':
      return { k: 'deleg.landed', landing: makeLandingRecord() }
    case 'deleg.drift':
      return {
        k: 'deleg.drift',
        attemptId: 'attempt-1',
        kind: 'model',
        detail: 'model_info announced gpt-5.4; shadow said claude-opus-5',
      }
    case 'deleg.evidence':
      return {
        k: 'deleg.evidence',
        attemptId: 'attempt-1',
        evidenceRef: 'evidence/attempt-1',
        manifestDigest: 'sha256:0',
      }
    case 'deleg.defaults_updated':
      return { k: 'deleg.defaults_updated', patch: { reasoningEffort: 'high' }, version: 3 }
    case 'att.text':
      return { k: 'att.text', text: 'looking at the fixture' }
    case 'att.reasoning':
      return { k: 'att.reasoning', text: 'the flake is a shared clock' }
    case 'att.tool':
      return {
        k: 'att.tool',
        callId: 'call-1',
        name: 'bash',
        target: 'pnpm test',
        status: 'start',
      }
    case 'att.usage':
      return { k: 'att.usage', input: 10, output: 20 }
    case 'att.background':
      return { k: 'att.background', taskId: 'bg-1', label: 'indexing', provenance: 'scraped' }
    case 'att.turn_boundary':
      return { k: 'att.turn_boundary', turnId: 'turn-1', edge: 'start' }
    case 'att.diff':
      return {
        k: 'att.diff',
        totals: { files: 1, insertions: 3, deletions: 1 },
        staleBase: false,
      }
    case 'att.error':
      return { k: 'att.error', code: 'internal', message: 'daemon closed the connection' }
  }
}

/** All 34, built. Handy for a store or backpressure test that needs volume with valid shapes. */
export function allSampleEvents(): readonly SwarmEvent[] {
  return SWARM_EVENT_KINDS.map(sampleEvent)
}
