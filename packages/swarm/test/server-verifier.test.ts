/**
 * SPEC-swarm §8 — the verifier: the half of the law of done that the agent cannot write.
 *
 * The four rules, one describe block each: **where** each kind runs (§8.1), **review isolation**
 * (§8.2, VE6), the **caps** (§8.3, VE8) and the **verdict** (§8.4) — with the evidence bundle
 * (§8.5, VE3) asserted by digest rather than by existence, because "reconstructable from the
 * durable log alone" is only a checkable claim if the manifest is checked.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { CommandRunner, ReviewRunner } from '../src/server/verifier.ts'
import type { AcceptanceCriterion, CriterionResult, VerificationRun } from '../src/types.ts'

import { VERIFIER_CAPS } from '../src/domain/constants.ts'
import {
  createVerifier,
  hasMachineCheckableCriterion,
  REVIEW_RUBRIC_SCHEMA,
  verdictOf,
  writeEvidenceBundle,
} from '../src/server/verifier.ts'
import { createScratchRepo } from './support/server-harness.ts'

const scratch: { dirs: string[] } = { dirs: [] }

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-verify-'))
  scratch.dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of scratch.dirs) rmSync(dir, { recursive: true, force: true })
  scratch.dirs = []
})

interface Run {
  readonly run: VerificationRun
  readonly commands: { command: string; cwd: string; env: Record<string, string> }[]
}

async function verify(
  criteria: readonly AcceptanceCriterion[],
  options: {
    cwd?: string
    baseRevision?: string
    review?: ReviewRunner
    runCommand?: CommandRunner
    assertWorkspace?: (cwd: string) => string
    deadlineMs?: number
  } = {},
): Promise<Run> {
  const evidenceRoot = tempDir()
  const cwd = options.cwd ?? tempDir()
  const commands: Run['commands'] = []
  const runCommand: CommandRunner =
    options.runCommand ??
    ((input) => {
      commands.push({ command: input.command, cwd: input.cwd, env: input.env })
      return { code: 0, stdout: 'ok', stderr: '', timedOut: false }
    })

  const verifier = createVerifier({
    evidenceRoot,
    runCommand,
    ids: () => 'fixed',
    ...(options.review === undefined ? {} : { review: options.review }),
    ...(options.assertWorkspace === undefined ? {} : { assertWorkspace: options.assertWorkspace }),
  })
  const run = await verifier.run({
    attemptId: 'a-1',
    criteria: [...criteria],
    workspace: { cwd, baseRevision: options.baseRevision ?? 'b'.repeat(40) },
    deadlineMs: options.deadlineMs ?? 60_000,
    reason: 'manual',
  })
  return { run, commands }
}

describe('§8.1 where each kind runs', () => {
  it('a `command` runs in the attempt worktree with the scrubbed env and no server inheritance (VE7)', async () => {
    process.env.SWARM_VERIFIER_SENTINEL = 'leaked'
    const cwd = tempDir()
    const { run, commands } = await verify(
      [{ kind: 'command', id: 'unit', label: 'unit', command: 'pnpm test', timeoutMs: 5_000 }],
      { cwd },
    )
    delete process.env.SWARM_VERIFIER_SENTINEL

    expect(commands).toHaveLength(1)
    expect(commands[0]!.cwd).toBe(cwd)
    /* Acceptance commands are agent-influenced code: they get the same complete map the agent
     * got, not whatever the user exported into the shell that started `swarm serve`. */
    expect(commands[0]!.env.SWARM_VERIFIER_SENTINEL).toBeUndefined()
    expect(Object.keys(commands[0]!.env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TZ'])
    expect(run.results[0]).toMatchObject({ kind: 'command', status: 'pass', exitCode: 0 })
  })

  it('a criterion `cwd` is joined **inside** the worktree, never used as an absolute path', async () => {
    const cwd = tempDir()
    mkdirSync(join(cwd, 'packages', 'x'), { recursive: true })
    const { commands } = await verify(
      [
        {
          kind: 'command',
          id: 'sub',
          label: 'sub',
          command: 'true',
          cwd: 'packages/x',
          timeoutMs: 1_000,
        },
      ],
      { cwd },
    )
    expect(commands[0]!.cwd).toBe(join(cwd, 'packages/x'))
  })

  it('the workspace guard runs on EVERY verifier run, on the resolved path (§13, S6)', async () => {
    const seen: string[] = []
    const cwd = tempDir()
    await verify([{ kind: 'file', id: 'f', label: 'f', path: 'README.md', must: 'absent' }], {
      cwd,
      assertWorkspace: (path) => {
        seen.push(path)
        return path
      },
    })
    expect(seen).toEqual([cwd])
  })

  it('a refused workspace stops the run before a single criterion executes', async () => {
    await expect(
      verify([{ kind: 'command', id: 'c', label: 'c', command: 'rm -rf /', timeoutMs: 10 }], {
        assertWorkspace: () => {
          throw new Error('workspace_denied')
        },
      }),
    ).rejects.toThrow(/workspace_denied/)
  })

  it('`file` checks exist / absent / match / changed against the worktree', async () => {
    const cwd = tempDir()
    writeFileSync(join(cwd, 'present.txt'), 'hello world\n')
    const { run } = await verify(
      [
        { kind: 'file', id: 'a', label: 'a', path: 'present.txt', must: 'exist' },
        { kind: 'file', id: 'b', label: 'b', path: 'absent.txt', must: 'absent' },
        { kind: 'file', id: 'c', label: 'c', path: 'present.txt', must: 'match', pattern: 'world' },
        { kind: 'file', id: 'd', label: 'd', path: 'present.txt', must: 'match', pattern: 'nope' },
        { kind: 'file', id: 'e', label: 'e', path: 'present.txt', must: 'match' },
      ],
      { cwd },
    )
    expect(run.results.map((r) => r.status)).toEqual(['pass', 'pass', 'pass', 'fail', 'error'])
  })

  it('`artifact` checks size and digest, and reports both', async () => {
    const cwd = tempDir()
    const body = 'artifact body'
    writeFileSync(join(cwd, 'out.bin'), body)
    const digest = createHash('sha256').update(body).digest('hex')
    const { run } = await verify(
      [
        {
          kind: 'artifact',
          id: 'a',
          label: 'a',
          path: 'out.bin',
          sha256: digest,
          minBytes: 1,
          producedDuringAttempt: true,
        },
        {
          kind: 'artifact',
          id: 'b',
          label: 'b',
          path: 'out.bin',
          minBytes: 10_000,
          producedDuringAttempt: true,
        },
        {
          kind: 'artifact',
          id: 'c',
          label: 'c',
          path: 'missing.bin',
          producedDuringAttempt: false,
        },
      ],
      { cwd },
    )
    expect(run.results[0]).toMatchObject({ status: 'pass', sha256: digest, bytes: body.length })
    expect(run.results[1]!.status).toBe('fail')
    expect(run.results[2]).toMatchObject({ status: 'fail', sha256: null, bytes: null })
  })

  it('`manual` never satisfies anything automatically — it routes to `needs-you`', async () => {
    const { run } = await verify([{ kind: 'manual', id: 'm', label: 'm', instructions: 'look' }])
    expect(run.results[0]).toEqual({ id: 'm', kind: 'manual', status: 'manual' })
    expect(run.verdict).toBe('indeterminate')
  })
})

describe('§8.2 review isolation (VE6)', () => {
  it('a review runs through the injected runner, on its own session, with the fixed rubric schema', async () => {
    const calls: { cwd: string; attemptId: string }[] = []
    const review: ReviewRunner = {
      run(input) {
        calls.push({ cwd: input.cwd, attemptId: input.attemptId })
        return Promise.resolve({
          score: 0.9,
          rationale: 'looks right',
          judgeSessionId: 'judge-1',
          judgeModel: 'claude-opus-5',
        })
      },
    }
    const { run } = await verify(
      [{ kind: 'review', id: 'r', label: 'r', rubric: 'is it good?', threshold: 0.7 }],
      { review },
    )
    expect(calls).toHaveLength(1)
    expect(run.results[0]).toMatchObject({
      kind: 'review',
      status: 'pass',
      score: 0.9,
      judgeSessionId: 'judge-1',
    })
    /* One shape, so a judge cannot invent its own verdict format (§8.2). */
    expect(REVIEW_RUBRIC_SCHEMA.required).toEqual(['score', 'rationale', 'failures'])
    expect(Object.keys(REVIEW_RUBRIC_SCHEMA.properties).sort()).toEqual([
      'failures',
      'rationale',
      'score',
    ])
  })

  it('a judge is never improvised: with no runner configured the criterion is an `error`', async () => {
    const { run } = await verify([
      { kind: 'review', id: 'r', label: 'r', rubric: 'grade yourself', threshold: 0.7 },
    ])
    expect(run.results[0]).toMatchObject({ status: 'error', judgeSessionId: '' })
  })

  it('a review below its threshold fails, and a thrown judge is an `error`, never a pass', async () => {
    const low: ReviewRunner = {
      run: () =>
        Promise.resolve({
          score: 0.4,
          rationale: 'weak',
          judgeSessionId: 'j',
          judgeModel: 'm',
        }),
    }
    const { run: failing } = await verify(
      [{ kind: 'review', id: 'r', label: 'r', rubric: 'x', threshold: 0.7 }],
      { review: low },
    )
    expect(failing.results[0]!.status).toBe('fail')

    const angry: ReviewRunner = { run: () => Promise.reject(new Error('the judge died')) }
    const { run: errored } = await verify(
      [{ kind: 'review', id: 'r', label: 'r', rubric: 'x', threshold: 0.7 }],
      { review: angry },
    )
    expect(errored.results[0]).toMatchObject({ status: 'error', rationale: 'the judge died' })
  })
})

describe('§8.3 caps — timeouts, process groups and truncation (VE8)', () => {
  it('a per-criterion timeout is clamped to the 900 s ceiling', async () => {
    const seen: number[] = []
    await verify(
      [{ kind: 'command', id: 'slow', label: 'slow', command: 'sleep 1', timeoutMs: 60 * 60_000 }],
      {
        runCommand: (input) => {
          seen.push(input.timeoutMs)
          return { code: 0, stdout: '', stderr: '', timedOut: false }
        },
      },
    )
    expect(seen[0]).toBeLessThanOrEqual(VERIFIER_CAPS.maxCriterionTimeoutMs)
  })

  it('a timed-out command is `timeout`, not `fail` — an unfinished check is not a failed one', async () => {
    const { run } = await verify(
      [{ kind: 'command', id: 'c', label: 'c', command: 'sleep 999', timeoutMs: 10 }],
      {
        runCommand: () => ({ code: null, stdout: '', stderr: '', timedOut: true }),
      },
    )
    expect(run.results[0]!.status).toBe('timeout')
    expect(run.verdict).toBe('fail')
  })

  it('output is captured to files and truncated IN THE RECORD at 64 KiB', async () => {
    const big = 'x'.repeat(VERIFIER_CAPS.recordTruncateBytes + 1_000)
    const { run } = await verify(
      [{ kind: 'command', id: 'noisy', label: 'noisy', command: 'yes', timeoutMs: 1_000 }],
      { runCommand: () => ({ code: 0, stdout: big, stderr: '', timedOut: false }) },
    )
    const result = run.results[0] as Extract<CriterionResult, { kind: 'command' }>
    expect(result.truncated).toBe(true)
    /* The record truncates; the file on disk keeps everything, because evidence is the point. */
    expect(readFileSync(result.stdoutRef, 'utf8').length).toBe(big.length)
  })

  it('`expectExit` is honoured — a check that expects a failure passes when it gets one', async () => {
    const { run } = await verify(
      [
        {
          kind: 'command',
          id: 'must-fail',
          label: 'must-fail',
          command: 'exit 1',
          expectExit: 1,
          timeoutMs: 1_000,
        },
      ],
      { runCommand: () => ({ code: 1, stdout: '', stderr: '', timedOut: false }) },
    )
    expect(run.results[0]!.status).toBe('pass')
  })
})

describe('§8.4 the verdict, and §3.2s rule that review is advisory', () => {
  const passing = (kind: CriterionResult['kind']): CriterionResult =>
    kind === 'command'
      ? {
          id: kind,
          kind: 'command',
          status: 'pass',
          exitCode: 0,
          durationMs: 1,
          stdoutRef: '',
          stderrRef: '',
          truncated: false,
        }
      : kind === 'review'
        ? {
            id: kind,
            kind: 'review',
            status: 'pass',
            score: 1,
            rationale: '',
            judgeSessionId: 'j',
            judgeModel: 'm',
          }
        : { id: kind, kind: 'file', status: 'pass', observed: 'present' }

  it('`pass` iff every machine-checkable criterion passed and none errored or timed out', () => {
    expect(verdictOf([passing('command'), passing('file')])).toBe('pass')
    expect(
      verdictOf([
        passing('command'),
        { id: 'f', kind: 'file', status: 'fail', observed: 'absent' },
      ]),
    ).toBe('fail')
  })

  it('any `manual` ⇒ `indeterminate`, which routes to `needs-you` and never to succeeded or failed', () => {
    expect(verdictOf([passing('command'), { id: 'm', kind: 'manual', status: 'manual' }])).toBe(
      'indeterminate',
    )
  })

  it('a `review` alone cannot produce `pass` unless `reviewIsAuthoritative` is set (§3.2)', () => {
    expect(verdictOf([passing('review')])).toBe('indeterminate')
    expect(verdictOf([passing('review')], { reviewIsAuthoritative: true })).toBe('pass')
    /* And it can still *fail* a run that its machine-checkable siblings passed. */
    expect(
      verdictOf([
        passing('command'),
        {
          id: 'r',
          kind: 'review',
          status: 'fail',
          score: 0.1,
          rationale: '',
          judgeSessionId: 'j',
          judgeModel: 'm',
        },
      ]),
    ).toBe('fail')
  })

  it('an empty criteria list is `indeterminate` — an unverifiable delegation is Q1s, not the verifier’s', () => {
    expect(verdictOf([])).toBe('indeterminate')
    expect(hasMachineCheckableCriterion([])).toBe(false)
    expect(
      hasMachineCheckableCriterion([
        { kind: 'review', id: 'r', label: 'r', rubric: 'x', threshold: 0.7 },
      ]),
    ).toBe(false)
    expect(
      hasMachineCheckableCriterion([
        { kind: 'file', id: 'f', label: 'f', path: 'x', must: 'exist' },
      ]),
    ).toBe(true)
  })
})

describe('§8.5 the evidence bundle (VE3)', () => {
  it('writes every named file and a `manifest.json` whose digests match them', () => {
    const evidenceRef = tempDir()
    const { manifestDigest } = writeEvidenceBundle({
      evidenceRef,
      diff: 'diff --git a b\n',
      transcript: [{ k: 'text', text: 'hello' }],
      tools: [{ callId: 'c', name: 'bash' }],
      cost: { estUsd: 0.12 },
      timings: { wallMs: 42 },
      run: null,
    })
    const manifest = JSON.parse(readFileSync(join(evidenceRef, 'manifest.json'), 'utf8')) as {
      files: Record<string, string>
    }
    expect(Object.keys(manifest.files).sort()).toEqual([
      'cost.json',
      'diff.patch',
      'timings.json',
      'tools.jsonl',
      'transcript.jsonl',
    ])
    /* The manifest is only worth writing if it is checked: every digest is recomputed here. */
    for (const [name, digest] of Object.entries(manifest.files)) {
      const body = readFileSync(join(evidenceRef, name))
      expect({ name, digest: createHash('sha256').update(body).digest('hex') }).toEqual({
        name,
        digest,
      })
    }
    expect(manifestDigest).toHaveLength(64)
  })

  it('a run writes `run.json` under `evidence/<attemptId>/<runId>` and reports the ref', async () => {
    const { run } = await verify([
      { kind: 'file', id: 'f', label: 'f', path: 'nothing', must: 'absent' },
    ])
    expect(run.evidenceRef).toContain(join('a-1', run.runId))
    const written = JSON.parse(readFileSync(join(run.evidenceRef, 'run.json'), 'utf8')) as {
      runId: string
      verdict: string
    }
    expect(written.runId).toBe(run.runId)
    expect(written.verdict).toBe(run.verdict)
  })

  it('re-verification appends a run; nothing is overwritten (§8.6)', async () => {
    const evidenceRoot = tempDir()
    let runNo = 0
    const verifier = createVerifier({
      evidenceRoot,
      ids: () => `r${++runNo}`,
      runNoFor: () => runNo,
      runCommand: () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    })
    const input = {
      attemptId: 'a-1',
      criteria: [{ kind: 'file', id: 'f', label: 'f', path: 'x', must: 'absent' }] as const,
      workspace: { cwd: tempDir(), baseRevision: 'c'.repeat(40) },
      deadlineMs: 1_000,
      reason: 're-verify' as const,
    }
    const first = await verifier.run({ ...input, criteria: [...input.criteria] })
    const second = await verifier.run({ ...input, criteria: [...input.criteria] })
    expect(first.runId).not.toBe(second.runId)
    expect(second.runNo).toBeGreaterThan(first.runNo)
    expect(readFileSync(join(first.evidenceRef, 'run.json'), 'utf8')).toContain(first.runId)
  })

  it('`baseRevisionAtRun` records the base the run saw — a moved base annotates, never invalidates (Q10)', async () => {
    const repo = createScratchRepo()
    const { run } = await verify(
      [{ kind: 'file', id: 'f', label: 'f', path: 'README.md', must: 'exist' }],
      { cwd: repo.root, baseRevision: repo.head },
    )
    expect(run.baseRevisionAtRun).toBe(repo.head)
    expect(run.staleBase).toBe(false)
    repo.dispose()
  })
})
