/**
 * The verifier (SPEC-swarm §8) — the half of the law of done that the agent cannot write.
 *
 * Four rules shape this file:
 *
 *  1. **Where** (§8.1). `command`, `file` and `artifact` run **in the attempt's worktree**, in a
 *     child spawned by the server under the same structural constraints as the agent: the same
 *     scrubbed env, the same allowlisted root, `cwd` inside the worktree, no inheritance of the
 *     server's environment (VE7). Acceptance commands are agent-influenced code.
 *  2. **`review` isolation** (§8.2, VE6). An independent session on a read-only clone, created for
 *     the run and closed after. A judge sharing the working context grades its own homework.
 *  3. **Verdict** (§8.4). `pass` iff every machine-checkable criterion passed and none is
 *     `error`/`timeout`. Any `manual` ⇒ `indeterminate`, and `indeterminate` routes to
 *     `needs-you` — never to `succeeded` and never to `failed`.
 *  4. **Evidence** (§8.5, VE3). Every run writes a bundle whose `manifest.json` digests the files
 *     beside it, and the whole bundle is reconstructable from the durable log alone.
 *
 * Node ≥ 24, server-only.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type {
  AcceptanceCriterion,
  CriterionResult,
  ReasoningEffort,
  VerificationInput,
  VerificationRun,
  Verifier,
} from '../types.ts'

import { VERIFIER_CAPS } from '../domain/constants.ts'
import { SwarmError } from '../errors.ts'
import { scrubbedEnv } from './workspace.ts'

/** The fixed rubric schema of §8.2 — one shape, so a judge cannot invent its own verdict format. */
export const REVIEW_RUBRIC_SCHEMA = {
  type: 'object',
  required: ['score', 'rationale', 'failures'],
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
    rationale: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
  },
  additionalProperties: false,
} as const

export interface ReviewOutcome {
  readonly score: number
  readonly rationale: string
  readonly judgeSessionId: string
  readonly judgeModel: string
  readonly failed?: boolean
}

/**
 * Injected because it needs an executor instance and a clone, and because §8.2's isolation is the
 * property under test: a verifier that could reach the working session would satisfy every other
 * rule here and still grade its own homework.
 */
export interface ReviewRunner {
  run(input: {
    readonly criterion: Extract<AcceptanceCriterion, { kind: 'review' }>
    readonly attemptId: string
    readonly cwd: string
    readonly baseRevision: string
    readonly effort: ReasoningEffort | undefined
    readonly deadlineMs: number
  }): Promise<ReviewOutcome>
}

export interface VerifierOptions {
  /** `$SWARM_HOME/evidence` (§7.2). */
  readonly evidenceRoot: string
  readonly now?: () => number
  readonly ids?: () => string
  readonly review?: ReviewRunner
  /** Resolve and re-check the worktree path on **every** run (§7.3, S6, §13). */
  readonly assertWorkspace?: (cwd: string) => string
  readonly runNoFor?: (attemptId: string) => number
  /** Injected for tests; production spawns a real child. */
  readonly runCommand?: CommandRunner
}

export interface CommandRunner {
  (input: {
    readonly command: string
    readonly cwd: string
    readonly timeoutMs: number
    readonly env: Record<string, string>
  }): {
    readonly code: number | null
    readonly stdout: string
    readonly stderr: string
    readonly timedOut: boolean
  }
}

const defaultRunCommand: CommandRunner = (input) => {
  const result = spawnSync(input.command, {
    shell: true,
    cwd: input.cwd,
    timeout: input.timeoutMs,
    encoding: 'utf8',
    env: input.env,
    maxBuffer: 64 * 1024 * 1024,
    /* Killed by process group (§8.3): a test runner that spawned children must not outlive it. */
    killSignal: 'SIGKILL',
  })
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error === undefined ? '' : String(result.error)),
    timedOut: result.signal === 'SIGKILL' && result.status === null,
  }
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/* ------------------------------------------------------------- §8.1/§7.3 the second door (S6) */

/**
 * Contain a criterion-supplied relative path inside the run's already-guarded `cwd`.
 *
 * `assertWorkspace` guards the run root **once**, and that was never the whole door: every
 * `AcceptanceCriterion` carries its own `cwd` or `path`, all of them agent-influenced (§8.1 calls
 * acceptance commands "agent-influenced code"). `join(cwd, '../../..')` escaped it, and what it
 * escaped into is `$SWARM_HOME` — `tokens.json`, `cli-token` and `swarm.db`. §7.3's algorithm is
 * "on every use, on the resolved path", so it runs here too, per criterion.
 *
 * The path need not exist: a `file{must:'absent'}` criterion names one that must not. So the
 * containment test runs against the **nearest existing ancestor**'s realpath, with the missing
 * suffix appended lexically — a symlink cannot hide in a component that is not there yet.
 */
export function containWithin(base: string, requested: string | undefined): string {
  const rel = requested ?? '.'
  if (isAbsolute(rel)) {
    throw new SwarmError('workspace_denied', `criterion path '${rel}' must be relative`, {
      details: { base, requested: rel },
    })
  }
  const written = resolve(base, rel)
  const realBase = realpathSync(resolve(base))

  let probe = resolve(realBase, rel)
  const target = probe
  while (!existsSync(probe)) {
    const parent = dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  const suffix = relative(probe, target)
  const resolved = suffix.length === 0 ? realpathSync(probe) : join(realpathSync(probe), suffix)
  if (
    resolved !== realBase &&
    !resolved.startsWith(realBase.endsWith(sep) ? realBase : realBase + sep)
  ) {
    throw new SwarmError('workspace_denied', `'${rel}' resolves outside the attempt worktree`, {
      details: { base: realBase, requested: rel, resolved },
    })
  }
  /* Validated on the **resolved** path (§7.3), handed back **as written**: the child gets the
   * path the operator would recognise, and `/var` → `/private/var` on Darwin is not a rename. */
  return written
}

/** §8.3: output is captured to files and truncated **in the record** at 64 KiB (VE8). */
function truncate(text: string): { readonly text: string; readonly truncated: boolean } {
  const limit = VERIFIER_CAPS.recordTruncateBytes
  if (text.length <= limit) return { text, truncated: false }
  return { text: text.slice(0, limit), truncated: true }
}

export function createVerifier(options: VerifierOptions): Verifier {
  const now = options.now ?? Date.now
  const ids = options.ids ?? (() => Math.random().toString(36).slice(2, 12))
  const runCommand = options.runCommand ?? defaultRunCommand

  return {
    async run(input: VerificationInput): Promise<VerificationRun> {
      const startedAt = now()
      const runId = `run_${ids()}`
      /* S6, every time — session creation is not the only door into a worktree (§13). */
      const cwd = options.assertWorkspace?.(input.workspace.cwd) ?? input.workspace.cwd
      const evidenceRef = join(options.evidenceRoot, input.attemptId, runId)
      mkdirSync(evidenceRef, { recursive: true, mode: 0o700 })

      const budget = Math.min(
        input.criteria.reduce((sum, c) => sum + criterionTimeout(c), 0),
        VERIFIER_CAPS.runDeadlineMs,
        input.deadlineMs,
      )
      const deadline = startedAt + budget

      const results: CriterionResult[] = []
      for (const criterion of input.criteria) {
        const remaining = Math.max(0, deadline - now())
        results.push(
          await runCriterion(criterion, {
            cwd,
            baseRevision: input.workspace.baseRevision,
            attemptId: input.attemptId,
            evidenceRef,
            remaining,
            runCommand,
            review: options.review,
          }),
        )
      }

      const endedAt = now()
      const run: VerificationRun = {
        runId,
        attemptId: input.attemptId,
        runNo: options.runNoFor?.(input.attemptId) ?? 1,
        startedAt,
        endedAt,
        verdict: verdictOf(results),
        results,
        baseRevisionAtRun: input.workspace.baseRevision,
        /* Q10: a moved base annotates and is labelled; it never invalidates the evidence. */
        staleBase: false,
        evidenceRef,
      }
      writeFileSync(join(evidenceRef, 'run.json'), `${JSON.stringify(run, null, 2)}\n`, {
        mode: 0o600,
      })
      return run
    },
  }
}

function criterionTimeout(criterion: AcceptanceCriterion): number {
  if (criterion.kind !== 'command') return VERIFIER_CAPS.criterionTimeoutMs
  return Math.min(criterion.timeoutMs, VERIFIER_CAPS.maxCriterionTimeoutMs)
}

interface CriterionContext {
  readonly cwd: string
  readonly baseRevision: string
  readonly attemptId: string
  readonly evidenceRef: string
  readonly remaining: number
  readonly runCommand: CommandRunner
  readonly review: ReviewRunner | undefined
}

async function runCriterion(
  criterion: AcceptanceCriterion,
  context: CriterionContext,
): Promise<CriterionResult> {
  switch (criterion.kind) {
    case 'command':
      return runCommandCriterion(criterion, context)
    case 'file':
      return runFileCriterion(criterion, context)
    case 'artifact':
      return runArtifactCriterion(criterion, context)
    case 'review':
      return runReviewCriterion(criterion, context)
    case 'manual':
      /* Never satisfies anything automatically; it routes to `needs-you` (§3.2). */
      return { id: criterion.id, kind: 'manual', status: 'manual' }
  }
}

function runCommandCriterion(
  criterion: Extract<AcceptanceCriterion, { kind: 'command' }> & { id: string },
  context: CriterionContext,
): CriterionResult {
  const timeoutMs = Math.max(1, Math.min(criterionTimeout(criterion), context.remaining))
  const startedAt = Date.now()

  let cwd: string
  try {
    /* S6, per criterion (§7.3, §8.1): a `cwd` of `'../../..'` reaches `$SWARM_HOME`, which holds
     * `tokens.json`, `cli-token` and `swarm.db`. Refusing is a criterion `error`, never a run. */
    cwd = containWithin(context.cwd, criterion.cwd)
  } catch (error) {
    return refusedCommand(criterion, context, startedAt, error)
  }

  const result = context.runCommand({
    command: criterion.command,
    cwd,
    timeoutMs,
    /* VE7: the same scrubbed env the agent got, plus only what the criterion declared. */
    env: scrubbedEnv(criterion.env ?? {}),
  })
  const stdoutRef = join(context.evidenceRef, `${criterion.id}.out`)
  const stderrRef = join(context.evidenceRef, `${criterion.id}.err`)
  writeFileSync(stdoutRef, result.stdout, { mode: 0o600 })
  writeFileSync(stderrRef, result.stderr, { mode: 0o600 })
  const expect = criterion.expectExit ?? 0
  const status: CriterionResult['status'] = result.timedOut
    ? 'timeout'
    : result.code === null
      ? 'error'
      : result.code === expect
        ? 'pass'
        : 'fail'
  return {
    id: criterion.id,
    kind: 'command',
    status: status as 'pass' | 'fail' | 'error' | 'timeout',
    exitCode: result.code,
    durationMs: Math.max(0, Date.now() - startedAt),
    stdoutRef,
    stderrRef,
    truncated: truncate(result.stdout).truncated || truncate(result.stderr).truncated,
  }
}

/** A criterion refused by the allowlist: recorded as evidence, never silently skipped. */
function refusedCommand(
  criterion: { readonly id: string },
  context: CriterionContext,
  startedAt: number,
  error: unknown,
): CriterionResult {
  const message = error instanceof Error ? error.message : String(error)
  const stdoutRef = join(context.evidenceRef, `${criterion.id}.out`)
  const stderrRef = join(context.evidenceRef, `${criterion.id}.err`)
  writeFileSync(stdoutRef, '', { mode: 0o600 })
  writeFileSync(stderrRef, `workspace_denied: ${message}\n`, { mode: 0o600 })
  return {
    id: criterion.id,
    kind: 'command',
    status: 'error',
    exitCode: null,
    durationMs: Math.max(0, Date.now() - startedAt),
    stdoutRef,
    stderrRef,
    truncated: false,
  }
}

function runFileCriterion(
  criterion: Extract<AcceptanceCriterion, { kind: 'file' }> & { id: string },
  context: CriterionContext,
): CriterionResult {
  let path: string
  try {
    path = containWithin(context.cwd, criterion.path)
  } catch (error) {
    return {
      id: criterion.id,
      kind: 'file',
      status: 'error',
      observed: error instanceof Error ? error.message : String(error),
    }
  }
  let exists = true
  let content = ''
  try {
    content = readFileSync(path, 'utf8')
  } catch {
    exists = false
  }
  switch (criterion.must) {
    case 'exist':
      return {
        id: criterion.id,
        kind: 'file',
        status: exists ? 'pass' : 'fail',
        observed: exists ? 'present' : 'absent',
      }
    case 'absent':
      return {
        id: criterion.id,
        kind: 'file',
        status: exists ? 'fail' : 'pass',
        observed: exists ? 'present' : 'absent',
      }
    case 'match': {
      if (!exists) return { id: criterion.id, kind: 'file', status: 'fail', observed: 'absent' }
      if (criterion.pattern === undefined) {
        return { id: criterion.id, kind: 'file', status: 'error', observed: 'no pattern given' }
      }
      let matched: boolean
      try {
        matched = new RegExp(criterion.pattern, 'm').test(content)
      } catch {
        return { id: criterion.id, kind: 'file', status: 'error', observed: 'invalid pattern' }
      }
      return {
        id: criterion.id,
        kind: 'file',
        status: matched ? 'pass' : 'fail',
        observed: matched ? 'matched' : 'did not match',
      }
    }
    case 'changed': {
      const diff = spawnSync(
        'git',
        ['diff', '--name-only', context.baseRevision, '--', criterion.path],
        {
          cwd: context.cwd,
          encoding: 'utf8',
          env: scrubbedEnv(),
        },
      )
      const changed = (diff.stdout ?? '').trim().length > 0
      return {
        id: criterion.id,
        kind: 'file',
        status: changed ? 'pass' : 'fail',
        observed: changed ? 'changed since base' : 'unchanged since base',
      }
    }
  }
}

function runArtifactCriterion(
  criterion: Extract<AcceptanceCriterion, { kind: 'artifact' }> & { id: string },
  context: CriterionContext,
): CriterionResult {
  let path: string
  try {
    path = containWithin(context.cwd, criterion.path)
  } catch {
    return {
      id: criterion.id,
      kind: 'artifact',
      status: 'error',
      sha256: null,
      bytes: null,
      producedDuringAttempt: criterion.producedDuringAttempt,
    }
  }
  let bytes: number | null = null
  let digest: string | null = null
  try {
    bytes = statSync(path).size
    digest = sha256(readFileSync(path))
  } catch {
    return {
      id: criterion.id,
      kind: 'artifact',
      status: 'fail',
      sha256: null,
      bytes: null,
      producedDuringAttempt: criterion.producedDuringAttempt,
    }
  }
  const sizeOk = criterion.minBytes === undefined || bytes >= criterion.minBytes
  const digestOk = criterion.sha256 === undefined || criterion.sha256 === digest
  return {
    id: criterion.id,
    kind: 'artifact',
    status: sizeOk && digestOk ? 'pass' : 'fail',
    sha256: digest,
    bytes,
    producedDuringAttempt: criterion.producedDuringAttempt,
  }
}

async function runReviewCriterion(
  criterion: Extract<AcceptanceCriterion, { kind: 'review' }> & { id: string },
  context: CriterionContext,
): Promise<CriterionResult> {
  if (context.review === undefined) {
    return {
      id: criterion.id,
      kind: 'review',
      status: 'error',
      score: 0,
      rationale: 'no review runner is configured; a judge is never improvised',
      judgeSessionId: '',
      judgeModel: '',
    }
  }
  try {
    const outcome = await context.review.run({
      criterion,
      attemptId: context.attemptId,
      cwd: context.cwd,
      baseRevision: context.baseRevision,
      effort: criterion.effort,
      deadlineMs: Math.max(1, context.remaining),
    })
    const threshold = criterion.threshold ?? VERIFIER_CAPS.reviewThreshold
    return {
      id: criterion.id,
      kind: 'review',
      status: outcome.failed === true ? 'error' : outcome.score >= threshold ? 'pass' : 'fail',
      score: outcome.score,
      rationale: outcome.rationale,
      judgeSessionId: outcome.judgeSessionId,
      judgeModel: outcome.judgeModel,
    }
  } catch (error) {
    return {
      id: criterion.id,
      kind: 'review',
      status: 'error',
      score: 0,
      rationale: error instanceof Error ? error.message : String(error),
      judgeSessionId: '',
      judgeModel: '',
    }
  }
}

/**
 * §8.4, and §3.2's rule that `review` is advisory. A `review` result can fail a run but cannot
 * carry one on its own unless it is the only non-`manual` kind present **and**
 * `reviewIsAuthoritative` is set — which is the caller's ruling, not this function's, because it
 * depends on the spec flag rather than on the results.
 */
export function verdictOf(
  results: readonly CriterionResult[],
  options: { readonly reviewIsAuthoritative?: boolean } = {},
): VerificationRun['verdict'] {
  if (results.length === 0) return 'indeterminate'
  if (results.some((r) => r.kind === 'manual')) return 'indeterminate'
  const machine = results.filter(
    (r) => r.kind === 'command' || r.kind === 'file' || r.kind === 'artifact',
  )
  const reviews = results.filter((r) => r.kind === 'review')
  /* A machine-checkable criterion that errored or timed out did not pass, and an unfinished check
   * is a failed run (§8.4's "none is error/timeout"). */
  if (machine.some((r) => r.status === 'error' || r.status === 'timeout')) return 'fail'
  const reviewErrored = reviews.some((r) => r.status === 'error')
  if (machine.length === 0) {
    if (reviews.length === 0) return 'indeterminate'
    if (options.reviewIsAuthoritative !== true) return 'indeterminate'
    if (reviewErrored) return 'indeterminate'
    return reviews.every((r) => r.status === 'pass') ? 'pass' : 'fail'
  }
  if (!machine.every((r) => r.status === 'pass')) return 'fail'
  /* A judge that **ran** and scored below its threshold is evidence, and fails the run. A judge
   * that could not run at all is **not** evidence: `review` is advisory (§3.2), so its absence
   * routes to `indeterminate` — and therefore to `needs-you` (§8.4 rule 4) — never to `fail`.
   * Mapping it to `fail` made "no review runner is configured" look like "the work is wrong". */
  if (reviews.some((r) => r.status === 'fail')) return 'fail'
  return reviewErrored ? 'indeterminate' : 'pass'
}

/** ≥1 machine-checkable criterion makes `verified` reachable at all (§3.2). */
export function hasMachineCheckableCriterion(criteria: readonly AcceptanceCriterion[]): boolean {
  return criteria.some((c) => c.kind === 'command' || c.kind === 'file' || c.kind === 'artifact')
}

/* ------------------------------------------------------------------------- §8.5 the bundle */

export interface EvidenceBundleInput {
  readonly evidenceRef: string
  readonly diff: string
  readonly transcript: readonly unknown[]
  readonly tools: readonly unknown[]
  readonly cost: unknown
  readonly timings: unknown
  readonly run: VerificationRun | null
}

/**
 * VE3's bundle. `manifest.json` digests every file beside it, which is what makes "reconstructable
 * from the durable log alone after a mid-turn restart" a checkable claim rather than a hope.
 */
export function writeEvidenceBundle(input: EvidenceBundleInput): { manifestDigest: string } {
  mkdirSync(input.evidenceRef, { recursive: true, mode: 0o700 })
  const files: Record<string, string> = {}
  const write = (name: string, body: string): void => {
    writeFileSync(join(input.evidenceRef, name), body, { mode: 0o600 })
    files[name] = sha256(body)
  }
  write('diff.patch', input.diff)
  write('transcript.jsonl', input.transcript.map((row) => JSON.stringify(row)).join('\n'))
  write('tools.jsonl', input.tools.map((row) => JSON.stringify(row)).join('\n'))
  write('cost.json', `${JSON.stringify(input.cost, null, 2)}\n`)
  write('timings.json', `${JSON.stringify(input.timings, null, 2)}\n`)
  if (input.run !== null) write('run.json', `${JSON.stringify(input.run, null, 2)}\n`)
  const manifest = `${JSON.stringify({ files }, null, 2)}\n`
  writeFileSync(join(input.evidenceRef, 'manifest.json'), manifest, { mode: 0o600 })
  return { manifestDigest: sha256(manifest) }
}
