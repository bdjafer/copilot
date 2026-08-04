/**
 * SPEC-swarm §8.1 (the *second* door), §8.2/§8.4 (review is advisory) and §8.5 (the bundle a real
 * run writes) — the three verifier rules that a helper-level test could not reach.
 *
 * §13's named row is *"a symlink inside an allowlisted root pointing outside it is refused with
 * `workspace_denied`, on session creation **and** on a verifier run"*. That passed while every
 * per-criterion `cwd` and `path` walked straight past the guard, because the guard was applied to
 * `input.workspace.cwd` and to nothing else — so the tests here drive the criteria, not the run.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { CommandRunner, ReviewRunner } from '../src/server/verifier.ts'
import type { AttemptRecord, DelegationRecord, VerificationRun } from '../src/types.ts'
import type { ServerHarness } from './support/server-harness.ts'

import { containWithin, createVerifier, verdictOf } from '../src/server/verifier.ts'
import { createServerHarness, drain, specFor } from './support/server-harness.ts'

const scratch: string[] = []
let harness: ServerHarness | null = null

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-boundary-'))
  scratch.push(dir)
  return dir
}

afterEach(async () => {
  await harness?.dispose()
  harness = null
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const actor = { kind: 'user', head: 'test', tokenId: 'tok-test' } as const
let idem = 0
const ctx = (): { actor: typeof actor; tokenId: string; idempotencyKey: string } => {
  idem += 1
  return { actor, tokenId: 'tok-test', idempotencyKey: `boundary-${idem}` }
}

/* --------------------------------------------------------- §8.1 the per-criterion allowlist */

describe('§8.1/§7.3 — the allowlist runs on every criterion, not only on the run', () => {
  it('`containWithin` refuses a `..` escape and an absolute path, and allows a subdirectory', () => {
    const base = tempDir()
    mkdirSync(join(base, 'packages', 'x'), { recursive: true })
    expect(containWithin(base, 'packages/x')).toBe(join(base, 'packages/x'))
    /* A path that does not exist yet is legal — `file{must:'absent'}` names one on purpose. */
    expect(containWithin(base, 'not/here.txt')).toBe(join(base, 'not/here.txt'))
    expect(() => containWithin(base, '../../..')).toThrow(/outside the attempt worktree/)
    expect(() => containWithin(base, '/etc')).toThrow(/must be relative/)
  })

  it('a symlink that leaves the worktree is refused even though its realpath exists', () => {
    const base = tempDir()
    const outside = tempDir()
    writeFileSync(join(outside, 'secret.txt'), 'tokens.json lives out here\n')
    symlinkSync(outside, join(base, 'escape'))
    expect(() => containWithin(base, 'escape/secret.txt')).toThrow(/outside the attempt worktree/)
  })

  it('a criterion `cwd` of `../../..` never reaches $SWARM_HOME: it is a refused `error`', async () => {
    const cwd = tempDir()
    const seen: string[] = []
    const runCommand: CommandRunner = (input) => {
      seen.push(input.cwd)
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    const verifier = createVerifier({ evidenceRoot: tempDir(), runCommand, ids: () => 'fixed' })
    const run = await verifier.run({
      attemptId: 'a-1',
      criteria: [
        {
          kind: 'command',
          id: 'esc',
          label: 'escape',
          command: 'pwd -P',
          cwd: '../../..',
          timeoutMs: 1_000,
        },
      ],
      workspace: { cwd, baseRevision: 'b'.repeat(40) },
      deadlineMs: 5_000,
      reason: 'manual',
    })
    /* The command never ran: `$SWARM_HOME` holds `tokens.json`, `cli-token` (0600 credentials)
     * and `swarm.db`, and §8.1 calls acceptance commands "agent-influenced code". */
    expect(seen).toEqual([])
    expect(run.results[0]).toMatchObject({ kind: 'command', status: 'error', exitCode: null })
    const stderr = readFileSync((run.results[0] as { stderrRef: string }).stderrRef, 'utf8')
    expect(stderr).toContain('workspace_denied')
  })

  it('a `file` and an `artifact` path are contained too — all three doors, not just the first', async () => {
    const cwd = tempDir()
    const verifier = createVerifier({
      evidenceRoot: tempDir(),
      runCommand: () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
      ids: () => 'fixed',
    })
    const run = await verifier.run({
      attemptId: 'a-1',
      criteria: [
        { kind: 'file', id: 'f', label: 'f', path: '../../../etc/hosts', must: 'exist' },
        {
          kind: 'artifact',
          id: 'a',
          label: 'a',
          path: '../../../etc/hosts',
          producedDuringAttempt: false,
        },
      ],
      workspace: { cwd, baseRevision: 'b'.repeat(40) },
      deadlineMs: 5_000,
      reason: 'manual',
    })
    expect(run.results.map((r) => r.status)).toEqual(['error', 'error'])
  })
})

/* ------------------------------------------------- §8.2/§8.4 a judge that cannot run is not a fail */

describe('§8.4/§3.2 — `review` is advisory: a judge that could not run never fails a run', () => {
  it('a review-only run with an erroring judge is `indeterminate`, which routes to `needs-you`', () => {
    const errored = {
      id: 'r',
      kind: 'review',
      status: 'error',
      score: 0,
      rationale: 'no review runner is configured; a judge is never improvised',
      judgeSessionId: '',
      judgeModel: '',
    } as const
    expect(verdictOf([errored])).toBe('indeterminate')
    expect(verdictOf([errored], { reviewIsAuthoritative: true })).toBe('indeterminate')
  })

  it('an erroring judge beside passing machine criteria is `indeterminate`, not `fail`', () => {
    const passing = {
      id: 'c',
      kind: 'command',
      status: 'pass',
      exitCode: 0,
      durationMs: 1,
      stdoutRef: '',
      stderrRef: '',
      truncated: false,
    } as const
    const errored = {
      id: 'r',
      kind: 'review',
      status: 'error',
      score: 0,
      rationale: 'the judge died',
      judgeSessionId: '',
      judgeModel: '',
    } as const
    expect(verdictOf([passing, errored])).toBe('indeterminate')
    /* A judge that RAN and scored below its threshold is evidence, and still fails the run. */
    expect(verdictOf([passing, { ...errored, status: 'fail', score: 0.1 }])).toBe('fail')
  })

  it('a delegation whose only criterion is a `review` does not verify to `fail`', async () => {
    harness = await createServerHarness({ listen: false })
    const created = await harness.server.engine.dispatch(
      'createDelegation',
      {
        spec: specFor(harness.repo, {
          acceptance: [
            { kind: 'review', id: 'r1', label: 'judge', rubric: 'is it good?', threshold: 0.7 },
          ],
        } as never),
      },
      ctx(),
    )
    expect(created.ok).toBe(true)
    const id = created.ok ? (created.value as string) : ''
    await drain(harness)
    await harness.server.engine.dispatch('verify', { delegationId: id }, ctx())

    const record = harness.server.engine.store.read(
      (tx) => tx.getRecord<DelegationRecord>('delegation', id)!.value,
    )
    const attempt = harness.server.engine.store.read(
      (tx) => tx.getRecord<AttemptRecord>('attempt', record.attempts[0]!)!.value,
    )
    const run = attempt.verifications.at(-1) as VerificationRun
    expect(run.verdict).not.toBe('fail')
    expect(record.state).not.toBe('failed')
  })

  it('a wired judge produces a scored `review` result on its own session and clone (VE6)', async () => {
    const seen: { cwd: string; attemptId: string }[] = []
    const review: ReviewRunner = {
      run(input) {
        seen.push({ cwd: input.cwd, attemptId: input.attemptId })
        return Promise.resolve({
          score: 0.95,
          rationale: 'clean',
          judgeSessionId: 'judge-7',
          judgeModel: 'mock-model',
        })
      },
    }
    const verifier = createVerifier({ evidenceRoot: tempDir(), review, ids: () => 'fixed' })
    const cwd = tempDir()
    const run = await verifier.run({
      attemptId: 'a-1',
      criteria: [{ kind: 'review', id: 'r', label: 'r', rubric: 'is it good?', threshold: 0.7 }],
      workspace: { cwd, baseRevision: 'b'.repeat(40) },
      deadlineMs: 5_000,
      reason: 'manual',
    })
    expect(seen).toEqual([{ cwd, attemptId: 'a-1' }])
    expect(run.results[0]).toMatchObject({
      kind: 'review',
      status: 'pass',
      judgeSessionId: 'judge-7',
    })
  })
})

/* ---------------------------------------------------------------- §8.5 the bundle, from a run */

describe('§8.5/§13 — a real run writes the bundle and its manifest digests match the files', () => {
  it('production verification writes diff/transcript/tools/cost/timings and a truthful digest', async () => {
    harness = await createServerHarness({ listen: false })
    const created = await harness.server.engine.dispatch(
      'createDelegation',
      {
        spec: specFor(harness.repo, {
          acceptance: [
            { kind: 'file', id: 'f', label: 'readme', path: 'README.md', must: 'exist' },
          ],
        } as never),
      },
      ctx(),
    )
    const id = created.ok ? (created.value as string) : ''
    await drain(harness)
    await harness.server.engine.dispatch('verify', { delegationId: id }, ctx())

    const record = harness.server.engine.store.read(
      (tx) => tx.getRecord<DelegationRecord>('delegation', id)!.value,
    )
    const attempt = harness.server.engine.store.read(
      (tx) => tx.getRecord<AttemptRecord>('attempt', record.attempts[0]!)!.value,
    )
    const run = attempt.verifications.at(-1) as VerificationRun

    const manifest = JSON.parse(readFileSync(join(run.evidenceRef, 'manifest.json'), 'utf8')) as {
      files: Record<string, string>
    }
    expect(Object.keys(manifest.files).sort()).toEqual([
      'cost.json',
      'diff.patch',
      'run.json',
      'timings.json',
      'tools.jsonl',
      'transcript.jsonl',
    ])
    /* §13: "its `manifest.json` digests match the files on disk." Production used to emit the
     * sha of the *run id string* under the name `manifestDigest`, which matched nothing. */
    for (const [name, digest] of Object.entries(manifest.files)) {
      const body = readFileSync(join(run.evidenceRef, name))
      expect({ name, digest: createHash('sha256').update(body).digest('hex') }).toEqual({
        name,
        digest,
      })
    }

    const evidence = harness.server.engine.store
      .read((tx) => tx.readLog(`delegation:${id}`, 0, 500))
      .filter((row) => row.ev.k === 'deleg.evidence')
      .at(-1)
    expect(evidence).not.toBeUndefined()
    const emitted = (evidence!.ev as { manifestDigest: string }).manifestDigest
    const onDisk = createHash('sha256')
      .update(readFileSync(join(run.evidenceRef, 'manifest.json')))
      .digest('hex')
    expect(emitted).toBe(onDisk)
  })
})
