/**
 * `pnpm --filter @astrale-os/swarm demo` — the seeded scenario, narrated, in about a second
 * (SPEC-swarm §10, release gate 10).
 *
 * §10 budgets the demo its own release-gate line and gives the reason in the same sentence:
 * **"so nobody dogfoods on real work on day one."** This is the thing a new reader runs before
 * they run anything else, and it is built so that nothing it prints is a claim it did not check:
 *
 *  - the seeded repository is materialized on disk and its test suite is **actually run**, so the
 *    "one real failing test" is a failure the reader watched happen;
 *  - the three attempts are played through `MockExecutor`, so attempt 2's `unknown` receipt comes
 *    out of the same ack-observation code the jcode adapter uses ([F2], V5) rather than from a
 *    narrator;
 *  - both acceptance criteria are **executed** — against the cheat and against the fix — so the
 *    claim that criterion 2 catches an agent editing the test is demonstrated, not asserted.
 *
 * A demo that fakes its own output is worth less than no demo, because everything it teaches has
 * to be unlearned the first time the product is pointed at real work.
 *
 * No model, no network, no credentials, and no path outside the OS temp dir.
 *
 * Node ≥ 24; testing-only.
 */

import { spawnSync } from 'node:child_process'

import type { DemoCriterion } from '../demo/scenario.ts'

import { runDemoAttempts } from '../demo/run.ts'
import { DEMO_ATTEMPTS, DEMO_CRITERIA, DEMO_OBJECTIVE, DEMO_SCENARIO } from '../demo/scenario.ts'
import { createDemoRepo } from './demo-repo.ts'

const write = (line = ''): void => {
  process.stdout.write(`${line}\n`)
}

const RULE = '─'.repeat(78)

function section(title: string): void {
  write()
  write(RULE)
  write(`  ${title}`)
  write(RULE)
  write()
}

/** Run one criterion exactly as §4.3.6's verifier would: argv, no shell, in the worktree. */
function runCriterion(criterion: DemoCriterion, cwd: string): boolean {
  const [command, ...args] = criterion.command
  const result = spawnSync(command!, args, { cwd, encoding: 'utf8' })
  return result.status === 0
}

function reportCriteria(cwd: string, label: string): readonly boolean[] {
  write(`  ${label}`)
  const results = DEMO_CRITERIA.map((criterion) => {
    const passed = runCriterion(criterion, cwd)
    write(`    ${passed ? 'PASS' : 'FAIL'}  ${criterion.id.padEnd(20)} ${criterion.description}`)
    return passed
  })
  write()
  return results
}

export async function runDemoCli(): Promise<number> {
  section('swarm demo — a seeded repository, one real bug, two criteria that run')

  write(`  objective   ${DEMO_OBJECTIVE}`)
  write('  executor    MockExecutor (no model, no network, no credentials)')
  write('  workspace   a throwaway git repo under the OS temp dir')

  const repo = createDemoRepo()
  try {
    write(`  path        ${repo.root}`)

    section('1. the bug is real — the seeded suite is run, not described')
    const seeded = spawnSync('node', ['--test', 'test/slugify.test.js'], {
      cwd: repo.root,
      encoding: 'utf8',
    })
    write(`  \`node --test test/slugify.test.js\` exited ${seeded.status} (non-zero is the point)`)
    write(`  slugify('Hello World') returns 'helloworld'; it should return 'hello-world'.`)
    write()

    section('2. the cheat — an agent that edits the test instead of the code')
    repo.applyTestEdit()
    const cheated = reportCriteria(repo.root, 'both criteria, run against the cheat:')
    write('  Criterion 1 passes: the suite really is green. Criterion 2 fails, because the')
    write('  evidence changed rather than the code. This is why §4.3.6 makes verification')
    write("  swarm's job and not the agent's — a fleet that believed the agent would have")
    write('  reported this attempt as done.')
    if (cheated[0] !== true || cheated[1] !== false) {
      write()
      write('  ! the demo did not reproduce its own claim — see test/testing-demo.test.ts')
      return 1
    }

    section('3. the fix — the same two criteria, against the real change')
    repo.remove()
    const fixed = createDemoRepo()
    try {
      fixed.applyFix()
      const results = reportCriteria(fixed.root, 'both criteria, run against the fix:')
      if (results.some((passed) => !passed)) {
        write('  ! the documented fix did not satisfy the criteria')
        return 1
      }
      write(`  The change is three characters, in ${DEMO_SCENARIO.sourcePath}.`)
    } finally {
      fixed.remove()
    }

    section('4. the three attempts, played through the executor')
    const played = await runDemoAttempts()
    for (const result of played) {
      const scripted = DEMO_ATTEMPTS.find((entry) => entry.index === result.index)!
      write(`  attempt ${result.index} — ${result.summary}`)
      write(
        `    receipt ${result.ack.padEnd(9)} turn completed ${String(result.turnCompleted).padEnd(6)}` +
          ` expected ${scripted.outcome}`,
      )
      for (const line of wrap(result.explanation, 72)) write(`    ${line}`)
      write()
    }
    write('  Attempt 2 is the one to read twice. The submission left and no acknowledgement')
    write('  came back, and no return value can tell that apart from success ([F2], V5) — so')
    write('  the receipt is `unknown` and swarm asks before re-sending, because a turn that')
    write('  did land would otherwise be run twice.')

    section('next')
    write('  A live server you can pair a head against, still on the mock executor:')
    write()
    write('    pnpm --filter @astrale-os/swarm demo:serve')
    write()
    write('  Driving a real agent needs jcode >= 0.66 and an authenticated jcode. See')
    write('  docs/DEMO-swarm.md for the exact commands and what each one is allowed to spend.')
    write()
    return 0
  } finally {
    repo.remove()
  }
}

function wrap(text: string, width: number): readonly string[] {
  const lines: string[] = []
  let current = ''
  for (const word of text.split(' ')) {
    if (current.length + word.length + 1 > width) {
      lines.push(current)
      current = word
    } else {
      current = current.length === 0 ? word : `${current} ${word}`
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}

if (import.meta.main) {
  process.exitCode = await runDemoCli()
}
