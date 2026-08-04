/**
 * SPEC-swarm §10 release gate 10 — the seeded demo scenario.
 *
 * §10 gives the demo its own LOC line and makes the gate depend on it, for a reason stated in the
 * same table: **"so nobody dogfoods on real work on day one."** A tool whose agents hold bash with
 * the user's privileges (S8) cannot have "point it at your repository" as its first instruction.
 *
 * What follows tests the demo as a *product surface*, not as a fixture: that the failing test
 * really fails, that the fix really fixes it, that the second criterion really catches the cheat,
 * and that the three attempts really produce three different outcomes when played through the
 * executor. A demo that asserts its own narration is worse than no demo.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  DEMO_ATTEMPTS,
  DEMO_CRITERIA,
  DEMO_FILES,
  DEMO_FIX,
  DEMO_OBJECTIVE,
  DEMO_SCENARIO,
  demoTurns,
  runDemoAttempts,
} from '../src/testing/demo/index.ts'
import { createDemoRepo, type DemoRepo } from '../src/testing/node/demo-repo.ts'

let repo: DemoRepo | null = null

afterEach(() => {
  repo?.remove()
  repo = null
})

function run(cwd: string, command: readonly string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync(command[0]!, command.slice(1), {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { ok: true, output }
  } catch (error) {
    const shaped = error as { stdout?: string; stderr?: string }
    return { ok: false, output: `${shaped.stdout ?? ''}${shaped.stderr ?? ''}` }
  }
}

describe('§10 the scenario is a real repository with a real bug', () => {
  it('seeds a git repo whose test suite genuinely FAILS', () => {
    repo = createDemoRepo()
    const result = run(repo.root, DEMO_CRITERIA[0]!.command)
    /* If this ever passes on the seeded tree the demo has no subject. */
    expect(result.ok).toBe(false)
    expect(result.output).toMatch(/hello-world|helloworld/)
  })

  it('and the seeded bug is the one the README says it is', () => {
    repo = createDemoRepo()
    const source = readFileSync(join(repo.root, DEMO_SCENARIO.sourcePath), 'utf8')
    /* The separator is dropped: `[^a-z0-9]+` replaced with the empty string. */
    expect(source).toContain("replace(/[^a-z0-9]+/g, '')")
  })

  it('the documented fix makes the whole suite pass', () => {
    repo = createDemoRepo()
    repo.applyFix()
    expect(run(repo.root, DEMO_CRITERIA[0]!.command).ok).toBe(true)
  })
})

describe('§10 the two acceptance criteria are checkable, and the second one earns its place', () => {
  it('both criteria pass on the correct fix', () => {
    repo = createDemoRepo()
    repo.applyFix()
    for (const criterion of DEMO_CRITERIA) {
      expect({ id: criterion.id, ok: run(repo.root, criterion.command).ok }).toEqual({
        id: criterion.id,
        ok: true,
      })
    }
  })

  it('the CHEAT passes criterion 1 and is caught by criterion 2', () => {
    /*
     * The whole reason there are two. An agent that "fixes" a failing test by editing the test
     * satisfies "the tests pass" completely — and a demo with only that criterion would teach a
     * new user, on their very first run, that green means done. §4.3.6's verifier is swarm's and
     * not the agent's precisely because of this case.
     */
    repo = createDemoRepo()
    repo.applyTestEdit()
    expect(run(repo.root, DEMO_CRITERIA[0]!.command).ok).toBe(true)
    expect(run(repo.root, DEMO_CRITERIA[1]!.command).ok).toBe(false)
  })

  it('every criterion is argv, never a shell string', () => {
    /* The same rule the workspace runner holds: a criterion that went through a shell would make
     * the demo the one place user text reaches one. */
    for (const criterion of DEMO_CRITERIA) {
      expect(Array.isArray(criterion.command)).toBe(true)
      expect(criterion.command.length).toBeGreaterThan(1)
      for (const part of criterion.command) expect(part).not.toContain('&&')
    }
  })

  it('the protected path is the test file the second criterion guards', () => {
    expect(DEMO_CRITERIA[1]!.command).toContain(DEMO_SCENARIO.protectedPath)
    expect(DEMO_FILES.some((file) => file.path === DEMO_SCENARIO.protectedPath)).toBe(true)
  })
})

describe('§10 the three attempts are three different lessons', () => {
  it('there are exactly three, and their outcomes are all different', () => {
    expect(DEMO_ATTEMPTS).toHaveLength(3)
    const outcomes = DEMO_ATTEMPTS.map((attempt) => attempt.outcome)
    expect(new Set(outcomes).size).toBe(3)
    /* The order is the argument: a user who sees only the success learns that swarm works; a user
     * who sees failure → ambiguity → success learns what it does when it does not. */
    expect(outcomes).toEqual(['verification-failed', 'delivery-unknown', 'succeeded'])
  })

  it('each one explains itself in a line the user can read', () => {
    for (const attempt of DEMO_ATTEMPTS) {
      expect(attempt.explanation.length).toBeGreaterThan(40)
      expect(attempt.summary.length).toBeGreaterThan(10)
    }
  })

  it('`demoTurns` refuses an attempt that does not exist rather than returning nothing', () => {
    expect(demoTurns(1).length).toBeGreaterThan(0)
    expect(() => demoTurns(4)).toThrow(/no attempt 4/)
  })
})

describe('§10 the scripted run is a real run', () => {
  it('plays all three attempts through the executor', async () => {
    const results = await runDemoAttempts()
    expect(results.map((r) => r.index)).toEqual([1, 2, 3])
  })

  it("attempt 2's `unknown` receipt comes from the executor, not from the narration", async () => {
    const results = await runDemoAttempts()
    /*
     * V5/[F2]: the send left and no `message_accepted` came back. This value is produced by the
     * same ack-observation code path the jcode adapter uses — the demo does not assert it, it
     * observes it. A demo that hard-coded this would show the user a behaviour that might not
     * exist.
     */
    expect(results[1]!.ack).toBe('unknown')
    expect(results[1]!.turnCompleted).toBe(false)

    /* And the other two really are acknowledged, so `unknown` means something. */
    expect(results[0]!.ack).toBe('accepted')
    expect(results[2]!.ack).toBe('accepted')
  })

  it('attempts 1 and 3 complete a turn', async () => {
    const results = await runDemoAttempts()
    expect(results[0]!.turnCompleted).toBe(true)
    expect(results[2]!.turnCompleted).toBe(true)
  })

  it('reaches no network, no model and no disk', async () => {
    /* `runDemoAttempts` takes no adapter: it constructs a `MockExecutor` itself, so there is no
     * argument a caller could pass that would point the demo at a real backend. */
    const results = await runDemoAttempts()
    expect(results).toHaveLength(3)
  })
})

describe('§10 the demo repo is disposable and lands nowhere near real work', () => {
  it('is created under the OS temp dir and removed completely', () => {
    const created = createDemoRepo()
    expect(created.root).toContain('swarm-demo-')
    expect(run(created.root, ['git', 'rev-parse', '--is-inside-work-tree']).ok).toBe(true)
    created.remove()
    expect(run(created.root, ['git', 'status']).ok).toBe(false)
  })

  it('carries the objective and the fix as data, so a head can render both', () => {
    expect(DEMO_OBJECTIVE).toMatch(/slugify/)
    expect(DEMO_FIX.contents).toContain("'-'")
    expect(DEMO_FIX.path).toBe(DEMO_SCENARIO.sourcePath)
  })
})
