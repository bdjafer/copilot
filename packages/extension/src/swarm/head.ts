/**
 * The head controller: session + client stores → one `SwarmHeadViewModel` store + one
 * `SwarmHeadIntents`.
 *
 * This is the whole of the head's state. It holds exactly four things the client core does not,
 * and each is a *view* concern the core is right not to have:
 *
 *  1. **Local notices** — refusals the head raised (`turn_in_flight`, a banned effort, a
 *     structured-answer cost disclosure). Same `SwarmNoticeVM` shape as the server's, `local:`
 *     ids, and they go through the same dismissal path.
 *  2. **The transcript handle** — ref-counted by the core (§6.2), so the head must acquire on
 *     focus and release on blur, or an attempt stream stays subscribed for the life of the page.
 *  3. **`following`** — follow-tail vs pinned scroll (W12), which is a scroll position and not
 *     fleet state.
 *  4. **The pairing plane** — from the session, which the core knows nothing about.
 *
 * Everything else is read straight off the core's stores and re-projected by `view-model.ts`.
 * When there is no client (unpaired, or between clients after a re-pair) the VM is still total:
 * empty buckets, empty health, the pairing plane populated. A renderer never sees a hole.
 */

import type {
  ConnectionVM,
  DelegationId,
  DelegationVM,
  FleetVM,
  HealthVM,
  NoticeVM,
  ReadableStore,
  SwarmClient,
  TranscriptHandle,
  TranscriptVM,
  Unsubscribe,
} from '@astrale-os/swarm'
import type { SwarmNoticeVM } from '@astrale-os/swarm/presentation'

import { readonlyStore, writable } from '@astrale-os/swarm'

import type { SwarmHeadSession } from './session.ts'
import type { SwarmHeadIntents, SwarmHeadViewModel } from './types.ts'

import { createHeadIntents } from './intents.ts'
import { projectHeadViewModel } from './view-model.ts'

const EMPTY_FLEET: FleetVM = {
  buckets: {
    'needs-you': [],
    failed: [],
    stalled: [],
    working: [],
    queued: [],
    'done-unlanded': [],
    'done-landed': [],
    cancelled: [],
    abandoned: [],
  },
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
  concurrency: { runningAttempts: 0, cap: 0, queued: 0 },
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
}

const EMPTY_HEALTH: HealthVM = {
  server: { ok: false, version: '', uptimeMs: 0 },
  executor: { ok: false, adapterId: 'jcode', versions: {}, blocked: null, fix: null },
  instances: [],
  routes: [],
  approvalsAvailable: false,
  lastDoctorAt: null,
}

const EMPTY_CONNECTION: ConnectionVM = {
  attempt: 0,
  nextRetryAtMs: null,
  status: 'idle',
  blockedReason: null,
  serverVersion: null,
  capabilities: [],
  pendingIntents: 0,
  queuedOffline: 0,
  streams: [],
}

export interface SwarmHead {
  readonly vm: ReadableStore<SwarmHeadViewModel>
  readonly intents: SwarmHeadIntents
  destroy(): void
}

export interface SwarmHeadOptions {
  readonly session: SwarmHeadSession
  readonly now?: () => number
}

export function createSwarmHead(options: SwarmHeadOptions): SwarmHead {
  const now = options.now ?? Date.now
  const session = options.session

  let client: SwarmClient | null = null
  let clientSubscriptions: Unsubscribe[] = []
  let handle: TranscriptHandle | null = null
  let handleAttemptId: string | null = null
  let handleSubscription: Unsubscribe | null = null
  let destroyed = false

  let fleet: FleetVM = EMPTY_FLEET
  let delegations: ReadonlyMap<DelegationId, DelegationVM> = new Map()
  let health: HealthVM = EMPTY_HEALTH
  let notices: readonly NoticeVM[] = []
  let connection: ConnectionVM = EMPTY_CONNECTION
  let focusId: DelegationId | null = null
  let transcript: TranscriptVM | null = null
  let following = true
  let localNotices: readonly SwarmNoticeVM[] = []
  const dismissed = new Set<string>()
  let noticeSeq = 0
  let keySeq = 0

  const store = writable<SwarmHeadViewModel>(project())

  function project(): SwarmHeadViewModel {
    return projectHeadViewModel({
      pairing: session.state.get(),
      connection,
      fleet,
      delegations,
      health,
      notices: notices.filter((notice) => !dismissed.has(notice.id)),
      localNotices: localNotices.filter((notice) => !dismissed.has(notice.id)),
      confirmations: session.confirmations.get(),
      focusId,
      transcript,
      now: now(),
    })
  }

  const publish = (): void => {
    if (destroyed) return
    store.set(project())
  }

  /**
   * The focused attempt drives the transcript subscription. Acquire on change, release the old
   * one in the same pass: the core ref-counts the attempt stream (§6.2), so a leaked handle is a
   * live `attempt:*` subscription for a delegation nobody is looking at — the one stream §2.4
   * degrades under backpressure, and the reason it has to.
   */
  const syncTranscript = (): void => {
    const focused = focusId === null ? null : (delegations.get(focusId) ?? null)
    const attemptId =
      focused === null
        ? null
        : (focused.focusedAttemptId ?? focused.liveAttemptIds[0] ?? focused.attempts[0]?.id ?? null)

    if (attemptId === handleAttemptId) return

    handleSubscription?.()
    handleSubscription = null
    handle?.release()
    handle = null
    handleAttemptId = attemptId
    transcript = null

    if (attemptId === null || client === null) return
    const next = client.transcript(attemptId)
    handle = next
    next.follow(following)
    transcript = next.vm.get()
    handleSubscription = next.vm.subscribe((value) => {
      transcript = value
      publish()
    })
  }

  const detach = (): void => {
    for (const unsubscribe of clientSubscriptions) unsubscribe()
    clientSubscriptions = []
    handleSubscription?.()
    handleSubscription = null
    handle?.release()
    handle = null
    handleAttemptId = null
    transcript = null
    client = null
    fleet = EMPTY_FLEET
    delegations = new Map()
    health = EMPTY_HEALTH
    notices = []
    connection = EMPTY_CONNECTION
    focusId = null
  }

  const attach = (next: SwarmClient): void => {
    detach()
    client = next
    fleet = next.fleet.get()
    delegations = next.delegations.get()
    health = next.health.get()
    notices = next.notices.get()
    connection = next.connection.get()
    focusId = next.focus.get()

    clientSubscriptions = [
      next.fleet.subscribe((value) => {
        fleet = value
        publish()
      }),
      next.delegations.subscribe((value) => {
        delegations = value
        syncTranscript()
        publish()
      }),
      next.health.subscribe((value) => {
        health = value
        publish()
      }),
      next.notices.subscribe((value) => {
        notices = value
        publish()
      }),
      next.connection.subscribe((value) => {
        connection = value
        publish()
      }),
      next.focus.subscribe((value) => {
        focusId = value
        syncTranscript()
        publish()
      }),
    ]
    syncTranscript()
    publish()
  }

  const subscriptions: Unsubscribe[] = [
    session.client.subscribe((value) => {
      if (value === null) detach()
      else attach(value)
      publish()
    }),
    session.state.subscribe(() => {
      publish()
    }),
    session.confirmations.subscribe(() => {
      publish()
    }),
  ]

  const intents = createHeadIntents({
    client: () => client,
    transcript: () => handle,
    now,
    key: () => `head-${now().toString(36)}-${(keySeq++).toString(36)}`,
    setFollowing: (on) => {
      following = on
      publish()
    },
    raise: (notice) => {
      noticeSeq += 1
      localNotices = [
        {
          id: `local:${noticeSeq}`,
          dismissible: notice.dismissible ?? true,
          kind: notice.kind,
          severity: notice.severity,
          title: notice.title,
          detail: notice.detail,
        },
        // A refusal log is not a product surface: keep the last five, drop the rest.
        ...localNotices.slice(0, 4),
      ]
      publish()
    },
    dismiss: (noticeId) => {
      dismissed.add(noticeId)
      localNotices = localNotices.filter((notice) => notice.id !== noticeId)
      publish()
    },
  })

  const current = session.client.get()
  if (current !== null) attach(current)

  return {
    vm: readonlyStore(store),
    intents,
    destroy() {
      destroyed = true
      for (const unsubscribe of subscriptions) unsubscribe()
      detach()
    },
  }
}
