/**
 * A fake `SwarmClient` and a fake `SwarmHeadSession` — the harness the head's surfaces are tested
 * against.
 *
 * The head is **stores in, intents out**, so the honest way to test it is to hold the real thing
 * (`createSwarmHead` + the real projection + the real renderer) against a client whose stores a
 * test can drive and whose intents a test can read back. Nothing is stubbed inside the head; the
 * only fake is the boundary the client core owns.
 *
 * The view models come from `@astrale-os/swarm/testing`'s fixtures, so a surface assertion is made
 * against the *spec's* shapes rather than against shapes this package invented — if a locked field
 * moves, these tests stop compiling, which is the point of importing the fixtures rather than
 * hand-rolling a delegation.
 */

import type {
  AttemptId,
  ConfirmationRequest,
  ConnectionVM,
  DelegationId,
  DelegationVM,
  DiffHandle,
  FleetVM,
  FocusStore,
  HealthVM,
  NoticeVM,
  SwarmClient,
  TranscriptHandle,
  TranscriptVM,
  WritableStore,
} from '@astrale-os/swarm'

import { readonlyStore, writable } from '@astrale-os/swarm'
import { emptyBuckets, makeHealthVM } from '@astrale-os/swarm/testing'

import type { SwarmHeadSession, SwarmHeadState } from '../../src/swarm/session.ts'

export interface RecordedCall {
  readonly intent: string
  readonly args: readonly unknown[]
}

export interface FakeSwarmClient {
  readonly client: SwarmClient
  readonly calls: RecordedCall[]
  readonly fleet: WritableStore<FleetVM>
  readonly delegations: WritableStore<ReadonlyMap<DelegationId, DelegationVM>>
  readonly health: WritableStore<HealthVM>
  readonly notices: WritableStore<readonly NoticeVM[]>
  readonly connection: WritableStore<ConnectionVM>
  /** Push transcript entries for an attempt the head has a handle on. */
  setTranscript(attemptId: AttemptId, vm: TranscriptVM): void
  /** How many handles are live — the ref-counting §6.2 requires the head to honour. */
  readonly liveHandles: number
  readonly destroyed: boolean
  /** Replace the delegation map from a list, the way a snapshot would. */
  setDelegations(list: readonly DelegationVM[]): void
}

export function emptyFleetVM(overrides: Partial<FleetVM> = {}): FleetVM {
  return {
    buckets: emptyBuckets<DelegationId[]>(() => []),
    counts: {
      'needs-you': 0,
      failed: 0,
      stalled: 0,
      working: 0,
      queued: 0,
      'done-unlanded': 0,
      'done-landed': 0,
      cancelled: 0,
      abandoned: 0,
    },
    dispatchPaused: false,
    concurrency: { runningAttempts: 0, cap: 4, queued: 0 },
    spend: {
      wallMs: 0,
      monotonicMs: 0,
      sleptMs: 0,
      turns: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estUsd: 0,
      capUsd: null,
    },
    ...overrides,
  }
}

export function fleetFrom(list: readonly DelegationVM[]): FleetVM {
  const buckets = emptyBuckets<DelegationId[]>(() => [])
  const counts = { ...emptyFleetVM().counts }
  const out: Record<string, DelegationId[]> = {}
  for (const vm of list) {
    ;(out[vm.bucket] ??= []).push(vm.id)
    counts[vm.bucket] += 1
  }
  return emptyFleetVM({
    buckets: { ...buckets, ...(out as FleetVM['buckets']) },
    counts,
    concurrency: { runningAttempts: list.length, cap: 4, queued: 0 },
  })
}

export function emptyTranscriptVM(attemptId: AttemptId): TranscriptVM {
  return { attemptId, following: true, entries: [], hasOlder: false, lagged: false }
}

export function createFakeSwarmClient(): FakeSwarmClient {
  const calls: RecordedCall[] = []
  const record = (intent: string, ...args: unknown[]): Promise<never> => {
    calls.push({ intent, args })
    /* Never settles: the head must treat an intent as fire-and-forget (§6.8), and a test that
     * depended on the resolution would be testing a promise this fake invented. */
    return new Promise<never>(() => {})
  }

  const fleet = writable<FleetVM>(emptyFleetVM())
  const delegations = writable<ReadonlyMap<DelegationId, DelegationVM>>(new Map())
  const health = writable<HealthVM>(makeHealthVM())
  const notices = writable<readonly NoticeVM[]>([])
  const connection = writable<ConnectionVM>({
    attempt: 0,
    nextRetryAtMs: null,
    status: 'connected',
    blockedReason: null,
    serverVersion: '0.1.0',
    capabilities: [],
    pendingIntents: 0,
    queuedOffline: 0,
    streams: [],
  })
  const focusValue = writable<DelegationId | null>(null)
  const transcripts = new Map<AttemptId, WritableStore<TranscriptVM>>()
  const handles = new Map<AttemptId, number>()
  let destroyed = false

  const setFocus = (id: DelegationId | null, attemptId?: AttemptId): void => {
    calls.push({ intent: 'focus', args: [id, attemptId] })
    focusValue.set(id)
    if (id === null || attemptId === undefined) return
    const vm = delegations.get().get(id)
    if (vm === undefined) return
    const next = new Map(delegations.get())
    next.set(id, { ...vm, focusedAttemptId: attemptId })
    delegations.set(next)
  }

  const focus: FocusStore = Object.assign(setFocus, {
    get: () => focusValue.get(),
    subscribe: (listener: (value: DelegationId | null, previous: DelegationId | null) => void) =>
      focusValue.subscribe(listener),
  })

  const transcriptStore = (attemptId: AttemptId): WritableStore<TranscriptVM> => {
    const existing = transcripts.get(attemptId)
    if (existing !== undefined) return existing
    const created = writable<TranscriptVM>(emptyTranscriptVM(attemptId))
    transcripts.set(attemptId, created)
    return created
  }

  const client: SwarmClient = {
    connection: readonlyStore(connection),
    fleet: readonlyStore(fleet),
    delegations: readonlyStore(delegations),
    focus,
    health: readonlyStore(health),
    notices: readonlyStore(notices),

    transcript(attemptId): TranscriptHandle {
      handles.set(attemptId, (handles.get(attemptId) ?? 0) + 1)
      const store = transcriptStore(attemptId)
      return {
        vm: readonlyStore(store),
        follow(on) {
          calls.push({ intent: 'follow', args: [attemptId, on] })
          store.set({ ...store.get(), following: on })
        },
        async loadOlder(n) {
          calls.push({ intent: 'loadOlder', args: [attemptId, n] })
        },
        release() {
          handles.set(attemptId, Math.max(0, (handles.get(attemptId) ?? 0) - 1))
        },
      }
    },

    diff(attemptId): DiffHandle {
      const store = writable({
        attemptId,
        baseRevision: '',
        staleBase: false,
        files: [],
        totals: { files: 0, insertions: 0, deletions: 0 },
        truncated: false,
      })
      return {
        vm: readonlyStore(store),
        expand: () => {},
        refresh: async () => {},
        release: () => {},
      }
    },

    on: () => () => {},
    once: () => () => {},
    subscribe: () => () => {},

    createDelegation: (input) => record('createDelegation', input),
    sendTurn: (id, directive) => record('sendTurn', id, directive),
    retract: (turnId) => record('retract', turnId),
    cancel: (id, options) => record('cancel', id, options),
    retry: (id, options) => record('retry', id, options),
    branch: (attemptId, options) => record('branch', attemptId, options),
    verify: (id, options) => record('verify', id, options),
    accept: (id, options) => record('accept', id, options),
    land: (id, options) => record('land', id, options),
    discard: (attemptId) => record('discard', attemptId),
    archive: (id, options) => record('archive', id, options),
    reconcile: (id) => record('reconcile', id),
    pauseDispatch: (scope, paused) => record('pauseDispatch', scope, paused),
    killSwitch: (options) => record('killSwitch', options),
    updateDefaults: (id, patch, expectedVersion) =>
      record('updateDefaults', id, patch, expectedVersion),
    confirm: (requestId) => record('confirm', requestId),
    deny: (requestId, reason) => record('deny', requestId, reason),

    setFilter(filter) {
      calls.push({ intent: 'setFilter', args: [filter] })
    },

    inspect: () => ({
      protocolVersion: 1,
      clientVersion: 'fake',
      connection: connection.get(),
      streams: [],
      pending: [],
      offlineQueue: [],
      handles: { transcripts: 0, diffs: 0 },
      counters: {},
    }),

    destroy() {
      destroyed = true
    },
  }

  return {
    client,
    calls,
    fleet,
    delegations,
    health,
    notices,
    connection,
    setTranscript(attemptId, vm) {
      transcriptStore(attemptId).set(vm)
    },
    get liveHandles() {
      return [...handles.values()].reduce((sum, count) => sum + count, 0)
    },
    get destroyed() {
      return destroyed
    },
    setDelegations(list) {
      delegations.set(new Map(list.map((vm) => [vm.id, vm])))
      fleet.set(fleetFrom(list))
    },
  }
}

export interface FakeSession {
  readonly session: SwarmHeadSession
  readonly state: WritableStore<SwarmHeadState>
  readonly client: WritableStore<SwarmClient | null>
  readonly confirmations: WritableStore<readonly ConfirmationRequest[]>
  readonly pairs: { endpoint: string; code: string }[]
  readonly unpairs: number
}

export function createFakeSession(initial?: Partial<SwarmHeadState>): FakeSession {
  const state = writable<SwarmHeadState>({
    phase: 'live',
    endpoint: 'http://127.0.0.1:7717',
    clientName: 'exp-spec extension',
    tokenId: 'tok-1',
    error: null,
    ...initial,
  })
  const client = writable<SwarmClient | null>(null)
  const confirmations = writable<readonly ConfirmationRequest[]>([])
  const pairs: { endpoint: string; code: string }[] = []
  let unpairs = 0

  const session: SwarmHeadSession = {
    state: readonlyStore(state),
    client: readonlyStore(client),
    confirmations: readonlyStore(confirmations),
    async start() {},
    async pair(input) {
      pairs.push({ endpoint: input.endpoint, code: input.code })
      return { ok: false, reason: 'bad-code', detail: 'fake' }
    },
    async unpair() {
      unpairs += 1
      state.set({ ...state.get(), phase: 'unpaired', tokenId: null })
    },
    destroy() {},
  }

  return {
    session,
    state,
    client,
    confirmations,
    pairs,
    get unpairs() {
      return unpairs
    },
  }
}
