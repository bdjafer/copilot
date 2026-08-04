/**
 * The in-product honesty surface — S8, S10 and S11 stated **in the product**, not only in the
 * spec (SPEC-swarm §10, release gate 10).
 *
 * Every other module in this package exists to make swarm do something. This one exists to make
 * swarm admit what it does not do, in the place where the user is deciding whether to trust it.
 * The three statements are not disclaimers; each is the direct consequence of a decision recorded
 * in the spec, and each was re-confirmed against a live `jcode v0.67.0` `api-bridge`:
 *
 *  - **S8 — there is no tool authority.** jcode has no read-only mode, and the only lever that
 *    exists is a launch-time tool profile which [F4] shows cannot reach the daemon at all on this
 *    topology: the flag parses on `api-bridge` and stops there. `writeMode: 'readonly'` was
 *    **deleted** rather than shipped ([R3], #28) because a workspace labelled read-only while the
 *    agent holds bash with the user's privileges is a gate that does not gate — which S8 itself
 *    names as worse than admitting we have none. Saying so in the UI is what "admitting" means.
 *  - **S10 — an inherited login spends the user's own quota.** `inheritLogins` is explicit and
 *    never defaulted, precisely because the SDK's default of `true` silently bills a real
 *    subscription. Verified worse than the spec assumed: a *fresh* `JCODE_HOME` does not isolate
 *    every route either — jcode's `chatgpt-web` method authenticates from the user's browser
 *    profile under `$HOME`, and reports `available: true` on a home with no credentials at all.
 *    A user reading "no credentials inherited" would otherwise conclude "cannot spend", and on
 *    that one route they would be wrong.
 *  - **S11 — the authority model is structural, not a sandbox.** Allowlist, worktree, scrubbed
 *    env, process-group kill. No container, no VM, no enforced network allowlist (Q6, #15): R8
 *    forbids requiring a container, and network allowlisting without one is unenforceable — so it
 *    is not claimed.
 *
 * And one label rather than a statement: **effort is declared, never confirmed** (§4.3.4). The
 * bridge discards the daemon's applied value and offers no getter (§5.4 #11), so
 * `effortConfirmed` is a literal `false` and any UI that renders effort as settled is inventing
 * the confirmation.
 *
 * Pure data in, frozen data out. DOM-free and Node-free.
 */

import type { NoticeVM } from '../types.ts'

/** One row of `HealthVM.honesty` / `SwarmViewModel.health.honesty` (§6.8). */
export interface HonestyStatement {
  readonly id: string
  readonly title: string
  readonly detail: string
  /**
   * `false` for the statements that are always true of this product.
   *
   * A dismissible admission is one the user stops seeing after the first day, which for S8 and
   * S11 would defeat the point: they describe what swarm *is*, not something that happened.
   */
  readonly dismissible: boolean
}

export interface HonestyInput {
  /**
   * Whether any live instance was acquired with `inheritLogins: true`.
   *
   * S10's badge is about a real configuration, so the statement it produces is conditional —
   * unlike S8 and S11, which are unconditional.
   */
  readonly anyInheritedLogins?: boolean
  /**
   * Whether any delegation targets a workspace marked `sensitive` (§5.5, [R3]).
   *
   * On a sensitive workspace the S8 notice is **non-dismissible on every delegation created
   * against it** — the spec's words — because that is the case where the user has explicitly said
   * the blast radius matters.
   */
  readonly anySensitiveWorkspace?: boolean
  /** Whether any route's `api_method` can authenticate without a credential in this home. */
  readonly ambientRoutes?: readonly string[]
}

/** The two statements that are true of every swarm, on every machine, always. */
const ALWAYS: readonly HonestyStatement[] = [
  {
    id: 'honesty.no-tool-authority',
    title: 'Agents run with your full privileges',
    detail:
      'There is no read-only mode and no per-turn tool restriction. jcode exposes neither, and ' +
      'the one launch-time lever that exists never reaches the process that runs the agent. An ' +
      'agent can run any command you can, including writes outside its worktree. What limits it ' +
      'is the workspace allowlist and the worktree it was given — not a permission system.',
    dismissible: false,
  },
  {
    id: 'honesty.not-a-sandbox',
    title: 'This is isolation by structure, not a sandbox',
    detail:
      'Swarm confines agents with a path allowlist, a git worktree, a scrubbed environment and a ' +
      'process-group kill. It does not use a container or a VM, and it does not enforce network ' +
      'restrictions — an agent can reach the network exactly as you can. Treat a delegation as ' +
      'code you are about to run, because that is what it is.',
    dismissible: false,
  },
]

/**
 * The honesty rows for a given state.
 *
 * Deterministic and ordered: the unconditional statements first, then the conditional ones, so a
 * head can render the list without sorting and a test can compare it without a set.
 */
export function honestyStatements(input: HonestyInput = {}): readonly HonestyStatement[] {
  const rows: HonestyStatement[] = [...ALWAYS]

  if (input.anyInheritedLogins === true) {
    rows.push({
      id: 'honesty.inherited-logins',
      title: 'Agents are using your provider logins',
      detail:
        'At least one instance was started with `inheritLogins: true`, so every turn it runs ' +
        'spends your own subscription or API quota. Nothing here caps that except the budget you ' +
        'set on the delegation.',
      dismissible: true,
    })
  }

  if (input.ambientRoutes !== undefined && input.ambientRoutes.length > 0) {
    rows.push({
      id: 'honesty.ambient-credentials',
      title: 'Some models are reachable even without inherited logins',
      detail:
        `A fresh agent home does not isolate every provider: ${input.ambientRoutes.join(', ')} ` +
        'authenticate from your browser profile or ambient environment rather than from the ' +
        'credentials swarm manages. Those routes can spend your quota even when no login was ' +
        'inherited.',
      dismissible: true,
    })
  }

  rows.push({
    id: 'honesty.effort-declared',
    title: 'Reasoning effort is declared, not confirmed',
    detail:
      'Swarm can set a reasoning effort but cannot read back what the model actually applied — ' +
      'the bridge discards it and offers no getter. Effort is shown as requested, never as ' +
      'confirmed.',
    dismissible: true,
  })

  return rows
}

/**
 * The honesty statements as notices (§6.4 `NoticeKind: 'honesty'`).
 *
 * A statement and a notice are the same content in two surfaces: `HealthVM.honesty` is the
 * always-visible panel, and these are what a head shows when there is no panel open. The
 * `sensitive` case is why this is a function rather than a constant — the spec requires the S8
 * notice to be **non-dismissible** on a sensitive workspace, so dismissibility is a property of
 * the situation, not of the text.
 */
export function honestyNotices(input: HonestyInput & { readonly at: number }): readonly NoticeVM[] {
  const sensitive = input.anySensitiveWorkspace === true
  return honestyStatements(input).map((statement) => ({
    id: statement.id,
    kind: 'honesty' as const,
    /* `info`, not `warn`: nothing has gone wrong. Ranking a permanent truth as a warning trains
     * the user to dismiss warnings, which is how the one that matters gets missed. */
    severity: 'info' as const,
    title: statement.title,
    detail: statement.detail,
    at: input.at,
    actions: statement.dismissible
      ? ([{ intent: 'dismiss', label: 'Got it' }] as const)
      : ([] as const),
    dismissible:
      statement.dismissible &&
      /* Sensitive workspaces pin the tool-authority admission open (§5.5, [R3]). */
      !(sensitive && statement.id === 'honesty.no-tool-authority'),
  }))
}

/** Every id this module can produce — so a head can style them without string literals. */
export const HONESTY_IDS = [
  'honesty.no-tool-authority',
  'honesty.not-a-sandbox',
  'honesty.inherited-logins',
  'honesty.ambient-credentials',
  'honesty.effort-declared',
] as const

/**
 * jcode's `api_method` values that authenticate from outside the agent home, verified on 0.67.0.
 *
 * `chatgpt-web` reads a logged-in browser session (`detail: "logged-in Firefox ChatGPT session"`)
 * and is reported `available: true` on a `JCODE_HOME` created seconds earlier with no credentials
 * in it. A route in this set makes S10's promise incomplete, which is a thing to say out loud
 * rather than a thing to discover from a bill.
 */
export const AMBIENT_AUTH_METHODS: readonly string[] = ['chatgpt-web']

/** The ambient routes among a health snapshot's routes, for `HonestyInput.ambientRoutes`. */
export function ambientRoutesOf(
  routes: readonly { readonly model: string; readonly apiMethod?: string }[],
): readonly string[] {
  return routes
    .filter(
      (route) => route.apiMethod !== undefined && AMBIENT_AUTH_METHODS.includes(route.apiMethod),
    )
    .map((route) => route.model)
}
