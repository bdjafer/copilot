/**
 * `@astrale-os/swarm/presentation` — the injected seam (SPEC-swarm §6.8, H6, Q15).
 *
 * **This module depends on nothing.** Not the barrel, not the protocol, not the domain types.
 * Every shape it needs is declared in it, and CI greps this file and its emitted `.d.ts` for a
 * module-loading statement and fails on a hit (§13, #34) — which is why not even this comment
 * spells the keyword. The duplication of `FleetBucket`, the state unions and the VM fields is
 * the whole value of the seam: a presentation can see these types and **nothing else**, so it
 * cannot reach the client, the wire or the store. A type-level test in
 * `test/presentation-compat.test.ts` asserts structural compatibility with the canonical shapes.
 *
 * This is `comment-ui/presentation`'s contract, verbatim in shape. The reference presentation
 * ships as `@astrale-os/swarm-ui`, its own package, in wave 2 (H6b) — for the same reason
 * `comment-ui` ships beside `comment-core`: a renderer in the core package is a renderer
 * everyone depends on.
 *
 * ES2022 plus `lib.dom` globals, which a DOM renderer is the expected consumer of.
 */

export interface SwarmHost {
  readonly root: ShadowRoot | HTMLElement
  readonly theme: 'light' | 'dark' | 'auto'
}

export interface SwarmPresentation {
  /** Called once. The return value is passed back to every later call as `handle`. */
  mount(host: SwarmHost, vm: SwarmViewModel, intents: SwarmIntents, labels: SwarmLabels): unknown
  /** Called on every VM change. The VM is frozen, total and pre-resolved. */
  render(handle: unknown, vm: SwarmViewModel): void
  /** Called once. MUST release every listener and node it created. */
  destroy(handle: unknown): void
}

/**
 * Every write a presentation can perform. Every method returns `void`, never throws, and is a
 * documented no-op against stale state — so a presentation needs no promises and no `try`/`catch`,
 * and a renderer can never make a scheduling decision by accident.
 */
export interface SwarmIntents {
  focus(delegationId: string | null): void
  setFilter(f: { buckets?: readonly string[]; text?: string; sort?: string }): void
  send(
    delegationId: string,
    text: string,
    opts?: {
      attemptId?: string
      delivery?: string
      model?: string
      reasoningEffort?: string | null
    },
  ): void
  retract(turnId: string): void
  cancel(delegationId: string, scope: 'turn' | 'delegation' | 'hard'): void
  retry(delegationId: string, parallel?: 1 | 2 | 3): void
  verify(delegationId: string, attemptId?: string): void
  accept(delegationId: string, note: string): void
  land(delegationId: string, attemptId: string, mode: 'commit' | 'patch'): void
  compare(delegationId: string): void
  pauseDispatch(delegationId: string | null, paused: boolean): void
  killSwitch(killInstances: boolean): void
  confirm(requestId: string): void
  deny(requestId: string, reason?: string): void
  dismissNotice(noticeId: string): void
  openTranscript(attemptId: string): void
  openDiff(attemptId: string): void
  escape(): void
}

/**
 * Ordered, total, pre-resolved. Structurally compatible with §6.2's view models and declared
 * independently so this module keeps its dependency count at zero.
 */
export interface SwarmViewModel {
  readonly connection: {
    readonly status: string
    readonly blockedReason: string | null
    readonly queuedOffline: number
  }
  readonly fleet: {
    readonly buckets: readonly SwarmBucketVM[]
    readonly dispatchPaused: boolean
    readonly concurrency: {
      readonly runningAttempts: number
      readonly cap: number
      readonly queued: number
    }
    readonly spend: { readonly estUsd: number; readonly capUsd: number | null }
  }
  readonly focused: SwarmDelegationVM | null
  readonly notices: readonly SwarmNoticeVM[]
  readonly confirmations: readonly SwarmConfirmationVM[]
  readonly health: {
    readonly ok: boolean
    readonly detail: string
    readonly fix: string | null
    readonly routes: readonly {
      readonly model: string
      readonly provider: string
      readonly available: boolean
      readonly detail: string
    }[]
    /** S8/S10/S11 in the product, not only in the spec (release gate 10). */
    readonly honesty: readonly {
      readonly id: string
      readonly title: string
      readonly detail: string
    }[]
  }
}

export interface SwarmBucketVM {
  readonly id: string
  readonly label: string
  readonly count: number
  readonly rows: readonly SwarmRowVM[]
}

export interface SwarmRowVM {
  readonly id: string
  readonly title: string
  readonly bucket: string
  readonly badge: string | null
  readonly nowDoing: string | null
  readonly attention: number
  readonly attempts: number
  readonly paused: boolean
}

/**
 * §6.8 writes this as `extends SwarmRowVM` while redeclaring `attempts` as a list, which does not
 * typecheck: the row carries a *count*, the focused delegation carries the attempts themselves.
 * `Omit` is the smallest fix that keeps both fields exactly as the spec declares them — renaming
 * either would change a locked field name. (Deviation D4.)
 */
export interface SwarmDelegationVM extends Omit<SwarmRowVM, 'attempts'> {
  readonly objective: string
  readonly state: string
  readonly verdict: string | null
  readonly baseRef: string
  readonly baseRevision: string
  readonly defaults: {
    readonly model: string
    readonly reasoningEffort: string | null
    readonly delivery: string
  }
  readonly effective: {
    readonly model: string
    readonly reasoningEffort: string | null
    /** MUST be rendered (§4.3.4): effort is declared intent, never observed state. */
    readonly effortConfirmed: false
    /** True ⇒ the mode gate applied (§4.3.8). */
    readonly inherited: boolean
  }
  readonly attempts: readonly {
    readonly id: string
    readonly attemptNo: number
    readonly live: boolean
    readonly channel: string
    readonly verdict: string | null
    readonly filesChanged: number
    readonly estUsd: number
  }[]
  readonly acceptance: readonly {
    readonly id: string
    readonly label: string
    readonly status: string
  }[]
  readonly budget: { readonly worstFraction: number; readonly label: string }
}

export interface SwarmNoticeVM {
  readonly id: string
  readonly kind: string
  readonly severity: string
  readonly title: string
  readonly detail: string
  readonly dismissible: boolean
}

export interface SwarmConfirmationVM {
  readonly requestId: string
  readonly summary: string
  readonly detail: string
  readonly expiresInMs: number
}

/** i18n — every user-visible string a presentation needs. Locked interface. */
export interface SwarmLabels {
  readonly send: string
  readonly cancel: string
  readonly cancelTurn: string
  readonly hardKill: string
  readonly retry: string
  readonly verify: string
  readonly accept: string
  readonly land: string
  readonly compare: string
  readonly pause: string
  readonly resume: string
  readonly confirm: string
  readonly deny: string
  readonly dismiss: string
  readonly killSwitch: string
  /** "declared, not confirmed" — the honest label (§4.3.4). */
  readonly effortDeclared: string
  readonly effortInherited: string
  readonly emptyFleet: string
  readonly placeholder: string
}
