// SPEC-copilot §2.2 / §3.1 — run construction and the pure state transitions. `Run` is PLAN
// §4.2's nine fields plus the `spec` replay snapshot; nothing else is ever written to the store.
import type { Run, RunSpec, RunState } from '../types.ts'

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set<RunState>([
  'done',
  'error',
  'cancelled',
])

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state)
}

export function createRunRecord<TContext>(input: {
  id: string
  input: string
  context?: TContext
  /** §2.2 — written once, here, and only when the trigger supplied at least one override. */
  spec?: RunSpec
  now: Date
}): Run<TContext> {
  const iso = input.now.toISOString()
  const record: Run<TContext> = {
    id: input.id,
    state: 'queued',
    input: input.input,
    attempts: 0,
    heartbeat: iso,
    createdAt: iso,
  } as Run<TContext>
  if (input.context !== undefined) {
    ;(record as { context?: TContext }).context = input.context
  }
  if (input.spec !== undefined) record.spec = input.spec
  return record
}

/**
 * §2.2 — the trigger-time snapshot of the per-run overrides, or `undefined` when there is nothing
 * to remember. `model` is recorded only as a `models` KEY: an inline `LanguageModelLike` cannot be
 * written to a store, and naming it something the reviving process cannot resolve would make the
 * record lie. `system` is deliberately absent (§2.2 / §3.5).
 */
export function snapshotSpec(input: {
  model?: string
  tools?: readonly string[]
  maxSteps?: number
}): RunSpec | undefined {
  const spec: RunSpec = {}
  if (input.model !== undefined) spec.model = input.model
  if (input.tools !== undefined) spec.tools = [...input.tools]
  if (input.maxSteps !== undefined) spec.maxSteps = input.maxSteps
  return Object.keys(spec).length === 0 ? undefined : spec
}

/** A run is stale when its heartbeat is older than `staleAfterMs` (§3.1 / §2.3). */
export function isStale(run: Run, now: Date, staleAfterMs: number): boolean {
  const beat = Date.parse(run.heartbeat)
  if (Number.isNaN(beat)) return true
  return now.getTime() - beat >= staleAfterMs
}

/**
 * Apply a state patch, preserving every other field — `context` and `spec` included, which is why
 * a resumed attempt in any process can still read the trigger's overrides. `output` and `error`
 * are only ever set, never cleared: a retry is a fresh run, never a mutation of a terminal one
 * (§2.2). `spec` is not patchable: it is decided by the trigger, once.
 */
export function patchRun<TContext>(
  run: Run<TContext>,
  patch: Partial<Pick<Run, 'state' | 'output' | 'error' | 'attempts' | 'heartbeat'>>,
): Run<TContext> {
  return { ...run, ...patch }
}
