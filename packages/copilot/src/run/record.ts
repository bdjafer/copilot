// SPEC-copilot §2.2 / §3.1 — run construction and the pure state transitions. `Run` is exactly
// nine fields; nothing else is ever written to the store.
import type { Run, RunState } from '../types.ts'

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
  return record
}

/** A run is stale when its heartbeat is older than `staleAfterMs` (§3.1 / §2.3). */
export function isStale(run: Run, now: Date, staleAfterMs: number): boolean {
  const beat = Date.parse(run.heartbeat)
  if (Number.isNaN(beat)) return true
  return now.getTime() - beat >= staleAfterMs
}

/**
 * Apply a state patch, preserving the nine-field shape. `output` and `error` are only ever set,
 * never cleared: a retry is a fresh run, never a mutation of a terminal one (§2.2).
 */
export function patchRun<TContext>(
  run: Run<TContext>,
  patch: Partial<Pick<Run, 'state' | 'output' | 'error' | 'attempts' | 'heartbeat'>>,
): Run<TContext> {
  return { ...run, ...patch }
}
