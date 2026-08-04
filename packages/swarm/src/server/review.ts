/**
 * `review` isolation (SPEC-swarm §8.2, VE6) — the judge that never grades its own homework.
 *
 * The rule the whole file exists for: **an independent executor session on a read-only clone,
 * created for the run and closed after**. It never shares the working session or its transcript;
 * its own transcript is stored as evidence, and the verdict shape is fixed by
 * `REVIEW_RUBRIC_SCHEMA` so a judge cannot invent its own format.
 *
 * Two consequences that are easy to get wrong and expensive to notice:
 *
 *  - the clone is a **clone**, not the worktree. A judge with the attempt's working tree can
 *    change the thing it is grading, and `producedDuringAttempt` stops meaning anything.
 *  - a judge that cannot run is **not** a failing judge. `review` is advisory (§3.2), so this
 *    module reports the failure and `verdictOf` routes it to `indeterminate` — never to `fail`,
 *    which would read as "the work is wrong" when the truth is "nobody looked".
 *
 * Node ≥ 24, server-only.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Fence } from '../types.ts'
import type { ExecutorSessionHandle } from './executor/types.ts'
import type { ReviewOutcome, ReviewRunner } from './verifier.ts'

import { REVIEW_RUBRIC_SCHEMA } from './verifier.ts'
import { runGit } from './workspace.ts'

export interface JudgeSession {
  readonly session: ExecutorSessionHandle
  readonly fence: Fence
  readonly model: string
  /** Releases the writer lease and closes the session — the judge is never reused (§8.2). */
  release(): Promise<void>
}

export interface ReviewRunnerOptions {
  /** Opens a session on an instance of swarm's choosing, **never** the attempt's own session. */
  readonly openJudge: (input: {
    readonly workingDir: string
    readonly title: string
  }) => Promise<JudgeSession>
  /** Where the read-only clone and the judge transcript are written — `evidence/<attemptId>`. */
  readonly evidenceRoot: string
  readonly ids?: () => string
  /** Injected by tests; production shells out to `git clone --no-hardlinks`. */
  readonly clone?: (source: string, target: string) => void
}

/** A judge verdict, exactly `REVIEW_RUBRIC_SCHEMA`. Anything else is a judge that went off-script. */
interface RubricVerdict {
  readonly score: number
  readonly rationale: string
  readonly failures: readonly string[]
}

function defaultClone(source: string, target: string): void {
  mkdirSync(target, { recursive: true, mode: 0o700 })
  const result = runGit(source, ['clone', '--no-hardlinks', '--quiet', source, target], 120_000)
  if (result.code !== 0) throw new Error(`git clone for the review failed: ${result.stderr.trim()}`)
}

function parseVerdict(raw: unknown): RubricVerdict | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Record<string, unknown>
  if (typeof value.score !== 'number' || typeof value.rationale !== 'string') return null
  const failures = Array.isArray(value.failures) ? value.failures.map((f) => String(f)) : []
  /* The schema pins 0..1; a judge that returns 7 has not scored, it has guessed at a scale. */
  if (!Number.isFinite(value.score) || value.score < 0 || value.score > 1) return null
  return { score: value.score, rationale: value.rationale, failures }
}

/**
 * The prompt. It names the rubric, the base and the clone, and says in as many words that the
 * judge is looking at a copy — a judge that believes it can fix what it is grading will try.
 */
function judgePrompt(input: { readonly rubric: string; readonly baseRevision: string }): string {
  return [
    'You are an independent reviewer. You are looking at a READ-ONLY CLONE of a worktree.',
    'Do not modify anything. Do not run destructive commands. Grade only what you observe.',
    '',
    `Base revision: ${input.baseRevision}`,
    '',
    'Rubric:',
    input.rubric,
    '',
    'Answer with the required JSON object only: {score, rationale, failures}.',
    '`score` is 0..1, where 1 means the rubric is fully satisfied.',
  ].join('\n')
}

export function createReviewRunner(options: ReviewRunnerOptions): ReviewRunner {
  const ids = options.ids ?? (() => Math.random().toString(36).slice(2, 10))
  const clone = options.clone ?? defaultClone

  return {
    async run(input): Promise<ReviewOutcome> {
      const runId = `judge_${ids()}`
      const cloneDir = join(options.evidenceRoot, input.attemptId, 'review', runId)
      let judge: JudgeSession | null = null
      try {
        clone(input.cwd, cloneDir)
        judge = await options.openJudge({
          workingDir: cloneDir,
          title: `swarm review ${input.criterion.id}`,
        })
        const result = await judge.session.structured<unknown>(
          {
            text: judgePrompt({ rubric: input.criterion.rubric, baseRevision: input.baseRevision }),
          },
          REVIEW_RUBRIC_SCHEMA,
          1,
          judge.fence,
        )

        /* The judge's own transcript is evidence (§8.2): every attempt, valid or not. */
        writeFileSync(
          join(cloneDir, '..', `${runId}.jsonl`),
          `${result.raw.map((row) => JSON.stringify({ raw: row })).join('\n')}\n`,
          { mode: 0o600 },
        )

        const verdict = result.failed ? null : parseVerdict(result.value)
        if (verdict === null) {
          return {
            score: 0,
            rationale:
              result.error?.message ??
              'the judge did not answer in the fixed rubric shape {score, rationale, failures}',
            judgeSessionId: judge.session.sessionId,
            judgeModel: judge.model,
            failed: true,
          }
        }
        return {
          score: verdict.score,
          rationale:
            verdict.failures.length === 0
              ? verdict.rationale
              : `${verdict.rationale}\nfailures: ${verdict.failures.join('; ')}`,
          judgeSessionId: judge.session.sessionId,
          judgeModel: judge.model,
        }
      } finally {
        /* Created for the run and closed after — a judge that outlives its run is a second writer
         * on an instance the scheduler has already given to somebody else. */
        await judge?.release().catch(() => undefined)
        rmSync(cloneDir, { recursive: true, force: true })
      }
    },
  }
}
