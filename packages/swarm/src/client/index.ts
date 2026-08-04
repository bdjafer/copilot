/**
 * `createSwarmClient` — the composition root of the headless client (SPEC-swarm §6.1–§6.6).
 *
 * Everything the client does is one of five things, and each has its own module:
 * `./connection.ts` owns the socket's state machine, `./streams.ts` owns subscriptions and the
 * per-stream cursor, `./queue.ts` owns intent dispatch and the offline queue,
 * `./projections.ts` turns events into view models, `./transcript.ts` owns the ref-counted
 * handles. This file wires them and implements the nineteen intents of §6.3.
 *
 * Three rules live *here* because they are about the seam between those modules:
 *
 *  - **Client-core refusals write zero frames** (§4.3.8, §13). `sendTurn` runs the mode gate, the
 *    ladder and the image cap through `validateTurnDirective` **before** dispatch, so
 *    `{delivery:'interrupt', reasoningEffort:'max'}` is refused with no wire traffic at all —
 *    steering happens mid-turn, configuring cannot, and the user should not wait for a round trip
 *    to be told so.
 *  - **On `hello_ok`, subscriptions are restored before intents are re-sent.** Attention before
 *    transcripts (§2.5 rule 2), and then §2.5 rule 3's idempotent re-send — in that order,
 *    because a `createDelegation` that lands before `fleet` is subscribed is a delegation the
 *    head never sees appear.
 *  - **The server owns policy** (#2, H8). The client refuses what §4.1/§4.3 make it refuse and
 *    projects what it is told; it never decides admission, budget or verdict, and it never
 *    resolves a conflict — an optimistic record is replaced wholesale (X11).
 *
 * DOM-free and Node-free: no `WebSocket`, no `document`, no `node:*`, no timer identifier.
 */

import type { ClientFrame, ServerFrame, StreamName } from '../protocol/frames.ts'
import type { IntentArgs } from '../protocol/intents.ts'
import type {
  AttemptId,
  ConnectionVM,
  CreateDelegationInput,
  DelegationDefaultsPatch,
  DelegationId,
  DelegationSpec,
  DelegationVM,
  FleetFilter,
  FocusStore,
  IntentResult,
  KillReport,
  LandOptions,
  LandingRecord,
  NoticeVM,
  ReconcileReport,
  RetractReport,
  SwarmClient,
  SwarmClientEvents,
  SwarmClientInspection,
  SwarmClientOptions,
  TurnDirective,
  TurnId,
  TurnVM,
} from '../types.ts'
import type { StreamEventDelivery, StreamSnapshotEvent } from './streams.ts'

import { emptySpendCounters } from '../domain/budget.ts'
import { checkEffortOnLadder, normalizeEffort, validateTurnDirective } from '../domain/directive.ts'
import { bucketOf } from '../domain/rollup.ts'
import { createEmitter } from '../emitter.ts'
import { SwarmError } from '../errors.ts'
import { delegationStream, parseStreamName } from '../protocol/codec.ts'
import { decodeSnapshot } from '../protocol/snapshots.ts'
import { readonlyStore, writable } from '../readable.ts'
import { createConnection } from './connection.ts'
import { deepFreeze } from './freeze.ts'
import { createIdFactory } from './ids.ts'
import { createProjection } from './projections.ts'
import { createIntentQueue } from './queue.ts'
import { createStreams } from './streams.ts'
import { createHandleRegistry } from './transcript.ts'

/** Reported by `inspect()`; the wire version is `SWARM_PROTOCOL_VERSION` and is separate. */
export const SWARM_CLIENT_VERSION = '0.1.0'

/** How many sent prompts the client remembers, for `TranscriptEntry{k:'user'}` (§6.2). */
const PROMPT_MEMORY = 500

const INITIAL_CONNECTION: ConnectionVM = deepFreeze({
  attempt: 0,
  nextRetryAtMs: null,
  status: 'idle',
  blockedReason: null,
  serverVersion: null,
  capabilities: [],
  pendingIntents: 0,
  queuedOffline: 0,
  streams: [],
})

function sameConnection(a: ConnectionVM, b: ConnectionVM): boolean {
  return (
    a.attempt === b.attempt &&
    a.nextRetryAtMs === b.nextRetryAtMs &&
    a.status === b.status &&
    a.blockedReason === b.blockedReason &&
    a.serverVersion === b.serverVersion &&
    a.pendingIntents === b.pendingIntents &&
    a.queuedOffline === b.queuedOffline &&
    a.capabilities.length === b.capabilities.length &&
    a.capabilities.every((capability, i) => capability === b.capabilities[i]) &&
    a.streams.length === b.streams.length &&
    a.streams.every(
      (stream, i) =>
        stream.stream === b.streams[i]?.stream &&
        stream.seq === b.streams[i]?.seq &&
        stream.lagged === b.streams[i]?.lagged,
    )
  )
}

export function createSwarmClient(options: SwarmClientOptions): SwarmClient {
  const now = options.now ?? Date.now
  const ids = createIdFactory(now)
  let requestId = 0
  let destroyed = false
  const counters = { snapshots: 0, events: 0, laggedFrames: 0, unroutedFrames: 0 }
  const prompts = new Map<TurnId, { text: string; images: number }>()

  const emitter = createEmitter<SwarmClientEvents>({
    onListenerError: (error) => {
      options.onError?.(
        SwarmError.is(error)
          ? error
          : new SwarmError('internal', 'a client event listener threw', { cause: error }),
      )
    },
  })

  const connectionStore = writable<ConnectionVM>(INITIAL_CONNECTION)
  const focusStore = writable<DelegationId | null>(null)

  const raise = (error: SwarmError): void => {
    options.onError?.(error)
    emitter.emit('error', error)
  }

  const projection = createProjection({
    now,
    capabilities: () => connection.capabilities,
    emit: (key, payload) => {
      /* `error` has two published surfaces — `SwarmClientOptions.onError` (§6.1) and the `error`
       * event key (§6.4) — and they must carry the same set. Routing the projection's own
       * failures through `raise` is what makes that true: a head that wired only the callback
       * would otherwise miss every `att.error` the executor raised. */
      if (key === 'error') {
        raise(payload as SwarmError)
        return
      }
      emitter.emit(key, payload)
    },
  })

  const delegationsStore = writable<ReadonlyMap<DelegationId, DelegationVM>>(
    projection.delegations(),
  )
  const fleetStore = writable(projection.fleet())
  const healthStore = writable(projection.health())
  const noticesStore = writable(projection.notices())

  /* ------------------------------------------------------------------------ publish plumbing */

  const buildConnectionVM = (): ConnectionVM =>
    deepFreeze({
      attempt: connection.attempt,
      nextRetryAtMs: connection.nextRetryAtMs,
      status: connection.status,
      blockedReason: connection.blockedReason,
      serverVersion: connection.serverVersion,
      capabilities: [...connection.capabilities],
      pendingIntents: queue.pendingCount,
      queuedOffline: queue.queuedCount,
      streams: streams.view(),
    })

  const publishConnection = (): void => {
    if (destroyed) return
    const next = buildConnectionVM()
    if (sameConnection(connectionStore.get(), next)) return
    connectionStore.set(next)
    emitter.emit('connection', next)
  }

  const publishProjection = (): void => {
    if (destroyed) return
    const changed = projection.drain()
    if (changed.delegationsChanged) delegationsStore.set(projection.delegations())
    if (changed.fleetChanged) fleetStore.set(projection.fleet())
    if (changed.healthChanged) healthStore.set(projection.health())
    if (changed.noticesChanged) noticesStore.set(projection.notices())
  }

  const pushNotice = (notice: NoticeVM): void => {
    projection.pushNotice(notice)
    emitter.emit('notice', notice)
    publishProjection()
  }

  /* ------------------------------------------------------------------------------- streaming */

  const malformedSnapshot = (stream: StreamName): void => {
    raise(
      new SwarmError('bad_protocol', `malformed snapshot for ${stream}`, {
        retryable: false,
        details: { stream },
      }),
    )
  }

  const onSnapshot = (snapshot: StreamSnapshotEvent): void => {
    counters.snapshots += 1
    /* A snapshot is the base every later `evt` is applied to, so a half-shaped one is refused
     * rather than projected: a wrong base is wrong until the next re-subscribe (§2.3). */
    switch (snapshot.family) {
      case 'server': {
        const state = decodeSnapshot('server', snapshot.state)
        if (state === null) return malformedSnapshot(snapshot.stream)
        projection.applyServerSnapshot(state)
        break
      }
      case 'fleet': {
        const state = decodeSnapshot('fleet', snapshot.state)
        if (state === null) return malformedSnapshot(snapshot.stream)
        projection.applyFleetSnapshot(state)
        break
      }
      case 'delegation': {
        const state = decodeSnapshot('delegation', snapshot.state)
        if (state === null) return malformedSnapshot(snapshot.stream)
        projection.applyDelegationSnapshot(state)
        break
      }
      default: {
        const state = decodeSnapshot('attempt', snapshot.state)
        if (state === null) return malformedSnapshot(snapshot.stream)
        if (snapshot.id !== null) handles.applySnapshot(snapshot.id, state)
      }
    }
    publishProjection()
    publishConnection()
  }

  const onEvent = (delivery: StreamEventDelivery): void => {
    counters.events += 1
    projection.applyEvent(delivery.event, { ts: delivery.ts, streamId: delivery.id })
    if (delivery.family === 'attempt' && delivery.id !== null) {
      handles.applyEvent(delivery.id, delivery.event, delivery.ts)
    }
    publishProjection()
  }

  const streams = createStreams({
    now,
    send: (frame: ClientFrame) => connection.send(frame),
    nextRequestId: () => {
      requestId += 1
      return requestId
    },
    onSnapshot,
    onEvent,
    onLagged: (info) => {
      counters.laggedFrames += 1
      emitter.emit('stream:lagged', info)
      /* Only `attempt:*` can lag (§2.4, Q12) — the transcript is evidence, not the product — and
       * the handle renders that honestly rather than showing a gap as content. */
      const parsed = parseStreamName(info.stream)
      if (parsed?.family === 'attempt' && parsed.id !== null) handles.markLagged(parsed.id, true)
    },
    onError: raise,
    onChange: publishConnection,
  })

  const handles = createHandleRegistry({
    now,
    acquire: (stream) => {
      streams.acquire(stream)
    },
    release: (stream) => {
      streams.release(stream)
    },
    resnapshot: (stream) => streams.resnapshot(stream),
    turnPrompt: (turnId) => prompts.get(turnId),
    onError: raise,
  })

  const queue = createIntentQueue({
    now,
    send: (frame: ClientFrame) => connection.send(frame),
    nextRequestId: () => {
      requestId += 1
      return requestId
    },
    onUnattributedError: raise,
    onStaleQueuedTurn: (info) => {
      /* §6.6: held, not sent. Ten minutes of a closed lid is enough for the instruction to be
       * wrong, and `NoticeVM.actions` is how the head offers to send it anyway. */
      pushNotice(
        deepFreeze({
          id: `stale-turn-${info.idempotencyKey}`,
          kind: 'stale-queued-turn',
          severity: 'warn',
          title: 'A queued turn was held',
          detail: `It waited ${Math.round(info.ageMs / 60_000)} minutes offline and was not sent.`,
          at: now(),
          actions: [
            { intent: 'sendTurn', label: 'Send anyway' },
            { intent: 'dismiss', label: 'Discard' },
          ],
          dismissible: true,
        }),
      )
    },
    onChange: publishConnection,
  })

  /* ------------------------------------------------------------------------------ connection */

  const connection = createConnection({
    transport: options.transport,
    clientName: options.clientName,
    head: options.head,
    now,
    onUp: ({ frame, changed, resendSuppressed }) => {
      if (changed) {
        emitter.emit('server-changed', {
          serverVersion: frame.serverVersion,
          capabilities: frame.capabilities,
        })
        pushNotice(
          deepFreeze({
            id: `server-changed-${frame.connectionId}`,
            kind: 'server-changed',
            severity: 'info',
            title: 'The server changed under this head',
            detail: `Now ${frame.serverVersion}. Every stream re-synchronised from a snapshot.`,
            at: frame.serverTimeMs,
            actions: [{ intent: 'dismiss', label: 'Dismiss' }],
            dismissible: true,
          }),
        )
      }
      /* Order is contractual: subscriptions first (§2.5 rule 2), then the idempotent re-send
       * (§2.5 rule 3) — otherwise a mutation lands on a stream nobody is listening to. */
      streams.resubscribeAll(changed)
      queue.onReconnected(resendSuppressed)
      publishConnection()
    },
    onFrame: (frame: ServerFrame) => {
      if (streams.handleFrame(frame)) return
      if (frame.k === 'res' && queue.handleRes(frame)) return
      if (frame.k === 'err' && queue.handleErr(frame)) return
      if (frame.k === 'bye') return
      counters.unroutedFrames += 1
    },
    onDown: (info) => {
      streams.onDisconnected()
      /* A terminal close ends the queue too: 4001/4003/4004 stop the reconnect ladder (§2.5
       * rule 4), so anything still waiting would wait forever. */
      if (info.blocked) queue.abortAll(blockedError(info.code))
      publishConnection()
    },
    onTick: (at) => {
      streams.flushAcks(at)
    },
    onError: raise,
    onChange: publishConnection,
  })

  /* Pinned for the life of the client (§2.5 rule 2): attention is never a subscription decision. */
  streams.pin('server')
  streams.pin('fleet')
  connection.connect()

  /* ---------------------------------------------------------------------------- intent layer */

  const refuse = <T>(error: SwarmError): Promise<IntentResult<T>> =>
    Promise.resolve({ ok: false, error })

  /**
   * The refusal a blocked connection owes a caller. `blocked` is terminal by construction (§2.5
   * rule 4), so an intent issued after it must **not** join the offline queue: that queue drains
   * on `hello_ok`, and there will not be one.
   */
  const blockedError = (closeCode?: number): SwarmError =>
    new SwarmError(
      connection.blockedReason === 'unauthenticated'
        ? 'unauthenticated'
        : connection.blockedReason === 'forbidden'
          ? 'forbidden'
          : 'bad_protocol',
      'the connection is blocked; the intent was not delivered',
      {
        retryable: false,
        details: {
          blockedReason: connection.blockedReason,
          ...(closeCode === undefined ? {} : { closeCode }),
        },
      },
    )

  async function dispatch<K extends keyof IntentArgs, T>(
    intent: K,
    args: IntentArgs[K],
    extra?: {
      idempotencyKey?: string
      expectedVersion?: number
      optimistic?: () => void
    },
  ): Promise<IntentResult<T>> {
    if (destroyed) {
      return { ok: false, error: new SwarmError('internal', 'client destroyed') }
    }
    /* The offline queue drains on `hello_ok`, and after a terminal close there will not be one
     * (§2.5 rule 4) — so an intent issued while `blocked` is refused here rather than queued into
     * a promise that never settles. `onDown` settles what was already outstanding; this settles
     * everything issued afterwards. */
    if (connection.status === 'blocked') {
      return { ok: false, error: blockedError() }
    }
    const result = await queue.dispatch(
      {
        intent,
        args,
        idempotencyKey: extra?.idempotencyKey ?? ids.next(intent),
        ...(extra?.expectedVersion === undefined ? {} : { expectedVersion: extra.expectedVersion }),
        ...(extra?.optimistic === undefined ? {} : { optimistic: extra.optimistic }),
      },
      connection.connected,
    )
    publishConnection()
    return result as IntentResult<T>
  }

  /** The optimistic `createDelegation` record of §6.6 — `version: -1` and nothing else invented. */
  const optimisticDelegationVM = (id: DelegationId, input: CreateDelegationInput): DelegationVM => {
    const spec = {
      ...input.spec,
      workspace: {
        workspaceId: input.spec.workspace.workspaceId,
        /* The server resolves `baseRef` to a 40-char sha inside the create transaction (C4b);
         * until then the client has no revision and says so with an empty string rather than
         * echoing the expression as if it were resolved. */
        baseRevision: '',
        writeMode: input.spec.workspace.writeMode ?? 'worktree',
        ...(input.spec.workspace.subPath === undefined
          ? {}
          : { subPath: input.spec.workspace.subPath }),
      },
    } as DelegationSpec
    const base = {
      id,
      version: -1,
      title: input.title ?? spec.objective.slice(0, 80),
      state: 'queued' as const,
      verdict: null,
      bucket: bucketOf({ state: 'queued', stalledForMs: null, landed: false }),
      unverifiable: spec.acceptance.length === 0,
      dispatchPaused: false,
      landed: false,
      attentionScore: 0,
      nowDoing: null,
      stalledForMs: null,
      staleBase: false,
      needsYou: null,
      spec,
      defaults: {
        provider: spec.model.provider,
        model: spec.model.model,
        reasoningEffort: spec.model.reasoningEffort,
        delivery: spec.delivery.mode,
      },
      baseRef: input.spec.workspace.baseRef ?? 'HEAD',
      baseRevision: '',
      liveAttemptIds: [],
      focusedAttemptId: null,
      origin: null,
      currentTurn: null,
      attempts: [],
      comparison: null,
      budget: { used: emptySpendCounters(), limit: spec.budget, worstFraction: 0 },
      acceptance: spec.acceptance.map((criterion) => ({
        id: criterion.id,
        label: criterion.label,
        status: 'unrun' as const,
      })),
    }
    return base satisfies DelegationVM
  }

  const optimisticTurnVM = (
    delegationId: DelegationId,
    directive: TurnDirective,
    turnId: TurnId,
  ): TurnVM | null => {
    const vm = projection.delegations().get(delegationId)
    if (vm === undefined) return null
    const attemptId = directive.attemptId ?? vm.liveAttemptIds[0] ?? null
    if (attemptId === null) return null
    const inherited = (directive.delivery ?? vm.defaults.delivery) !== 'after-turn'
    return {
      id: turnId,
      attemptId,
      delivery: 'prepared',
      effective: {
        provider: vm.defaults.provider,
        model: inherited ? 'inherited' : (directive.model ?? vm.defaults.model),
        reasoningEffort: inherited
          ? 'inherited'
          : directive.reasoningEffort === undefined
            ? vm.defaults.reasoningEffort
            : directive.reasoningEffort,
        /* Literal `false` in the type — this client cannot claim otherwise (§4.3.4, #7). */
        effortConfirmed: false,
        modelConfirmed: false,
        deliveryMode: directive.delivery ?? vm.defaults.delivery,
        structured: null,
        budget: directive.budget ?? null,
        executorVersions: {},
      },
      landing: inherited ? 'unconfirmed' : 'n/a',
      effortConfirmed: false,
      configInherited: inherited,
      elapsedMs: 0,
      toolCalls: 0,
    }
  }

  const rememberPrompt = (turnId: TurnId, directive: TurnDirective): void => {
    prompts.set(turnId, { text: directive.text, images: directive.images?.length ?? 0 })
    if (prompts.size > PROMPT_MEMORY) {
      const oldest = prompts.keys().next()
      if (!oldest.done) prompts.delete(oldest.value)
    }
  }

  /* ---------------------------------------------------------------------------- focus (C1) */

  const setFocus = (id: DelegationId | null, attemptId?: AttemptId): void => {
    if (destroyed) return
    const previous = focusStore.get()
    /* The focused delegation's own stream is ref-counted like an attempt's: a head that focuses
     * one delegation should not be paying for the fine-grained events of forty others. */
    if (previous !== null && previous !== id) streams.release(delegationStream(previous))
    focusStore.set(id)
    if (id !== null) {
      if (previous !== id) streams.acquire(delegationStream(id))
      projection.setFocusedAttempt(id, attemptId ?? null)
      publishProjection()
    }
  }

  const focus: FocusStore = Object.assign(setFocus, {
    get: () => focusStore.get(),
    subscribe: (listener: (value: DelegationId | null, previous: DelegationId | null) => void) =>
      focusStore.subscribe(listener),
  })

  /* ------------------------------------------------------------------------------ the client */

  const client: SwarmClient = {
    connection: readonlyStore(connectionStore),
    fleet: readonlyStore(fleetStore),
    delegations: readonlyStore(delegationsStore),
    focus,
    health: readonlyStore(healthStore),
    notices: readonlyStore(noticesStore),

    transcript: (attemptId) => handles.transcript(attemptId),
    diff: (attemptId) => handles.diff(attemptId),

    on: (key, cb) => emitter.on(key, cb),
    once: (key, cb) => emitter.once(key, cb),
    subscribe: (cb) => emitter.subscribe(cb),

    createDelegation(input) {
      const effort = input.spec.model.reasoningEffort
      if (effort !== null && effort !== undefined) {
        /* Layer one of three (§4.1, #9): `swarm`/`swarm-deep` are values jcode *accepts*, so an
         * `ok` from `setReasoningEffort` can never validate them. */
        try {
          normalizeEffort(effort)
        } catch (error) {
          return refuse(
            SwarmError.is(error) ? error : new SwarmError('unknown_effort', String(error)),
          )
        }
        const onLadder = checkEffortOnLadder(
          input.spec.model.provider,
          input.spec.model.model,
          effort,
        )
        if (onLadder !== null) return refuse(onLadder)
      }
      const delegationId = input.delegationId ?? ids.next('delegation')
      const optimistic = optimisticDelegationVM(delegationId, input)
      return dispatch<'createDelegation', DelegationId>(
        'createDelegation',
        {
          delegationId,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          spec: input.spec,
        },
        {
          idempotencyKey: input.idempotencyKey,
          optimistic: () => {
            projection.optimisticDelegation(optimistic)
            publishProjection()
          },
        },
      )
    },

    async sendTurn(id, directive) {
      const vm = projection.delegations().get(id)
      if (vm === undefined) {
        return {
          ok: false,
          error: new SwarmError('not_found', `unknown delegation ${id}`, {
            retryable: false,
            details: { delegationId: id },
          }),
        }
      }
      /* Zero frames on refusal (§13): the mode gate, the ladder and the image cap all run here. */
      const refusal = validateTurnDirective(directive, {
        defaults: vm.defaults,
        liveAttempts: vm.liveAttemptIds,
      })
      if (refusal !== null) return { ok: false, error: refusal }

      const optimisticTurnId = ids.next('turn')
      const result = await dispatch<'sendTurn', TurnId>(
        'sendTurn',
        { delegationId: id, directive },
        {
          idempotencyKey: directive.idempotencyKey,
          ...(directive.expectedVersion === undefined
            ? {}
            : { expectedVersion: directive.expectedVersion }),
          optimistic: () => {
            const turn = optimisticTurnVM(id, directive, optimisticTurnId)
            if (turn === null) return
            rememberPrompt(optimisticTurnId, directive)
            projection.optimisticTurn(id, turn.attemptId, turn)
            publishProjection()
          },
        },
      )
      if (result.ok) rememberPrompt(result.value, directive)
      return result
    },

    retract: (turnId) => dispatch<'retract', RetractReport>('retract', { turnId }),

    cancel: (id, o) =>
      dispatch<'cancel', void>('cancel', {
        delegationId: id,
        scope: o.scope,
        ...(o.attemptId === undefined ? {} : { attemptId: o.attemptId }),
      }),

    retry: (id, o) =>
      dispatch<'retry', readonly AttemptId[]>('retry', {
        delegationId: id,
        ...(o?.spec === undefined ? {} : { spec: o.spec }),
        ...(o?.parallel === undefined ? {} : { parallel: o.parallel }),
        ...(o?.injectPriorFailure === undefined
          ? {}
          : { injectPriorFailure: o.injectPriorFailure }),
      }),

    branch: (attemptId, o) =>
      dispatch<'branch', DelegationId>('branch', {
        attemptId,
        ...(o?.title === undefined ? {} : { title: o.title }),
      }),

    verify: (id, o) =>
      dispatch<'verify', string>('verify', {
        delegationId: id,
        ...(o?.attemptId === undefined ? {} : { attemptId: o.attemptId }),
        ...(o?.criteria === undefined ? {} : { criteria: o.criteria }),
      }),

    accept: (id, o) =>
      dispatch<'accept', void>('accept', {
        delegationId: id,
        note: o.note,
        ...(o.attemptId === undefined ? {} : { attemptId: o.attemptId }),
      }),

    land: (id, o: LandOptions) =>
      dispatch<'land', LandingRecord>('land', { delegationId: id, ...o }),

    discard: (attemptId) => dispatch<'discard', void>('discard', { attemptId }),

    archive: (id, o) =>
      dispatch<'archive', void>('archive', {
        delegationId: id,
        ...(o?.abandon === undefined ? {} : { abandon: o.abandon }),
      }),

    reconcile: (id) => dispatch<'reconcile', ReconcileReport>('reconcile', { delegationId: id }),

    pauseDispatch: (scope, paused) =>
      dispatch<'pauseDispatch', void>('pauseDispatch', { scope, paused }),

    killSwitch: (o) => dispatch<'killSwitch', KillReport>('killSwitch', o),

    updateDefaults: (id, patch: DelegationDefaultsPatch, expectedVersion) =>
      dispatch<'updateDefaults', void>(
        'updateDefaults',
        { delegationId: id, patch },
        expectedVersion === undefined ? undefined : { expectedVersion },
      ),

    confirm: (requestId) => dispatch<'confirm', void>('confirm', { requestId }),

    deny: (requestId, reason) =>
      dispatch<'deny', void>('deny', {
        requestId,
        ...(reason === undefined ? {} : { reason }),
      }),

    setFilter(filter: FleetFilter) {
      projection.setFilter(filter)
      publishProjection()
    },

    inspect(): SwarmClientInspection {
      return {
        protocolVersion: 1,
        clientVersion: SWARM_CLIENT_VERSION,
        connection: connectionStore.get(),
        streams: streams.inspect(),
        pending: queue.pending(),
        offlineQueue: queue.offline(),
        handles: handles.counts(),
        counters: { ...counters, ...queue.counters(), listeners: emitter.counts()['*'] ?? 0 },
      }
    },

    destroy() {
      if (destroyed) return
      destroyed = true
      queue.abortAll(new SwarmError('internal', 'client destroyed', { retryable: false }))
      connection.destroy()
      streams.destroy()
      handles.destroy()
      emitter.clear()
    },
  }

  return client
}
