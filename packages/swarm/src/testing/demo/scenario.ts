/**
 * The seeded demo scenario — release gate 10 (SPEC-swarm §10).
 *
 * §10 budgets this its own line because the gate depends on it, and the reason is a sentence in
 * the same table: **"so nobody dogfoods on real work on day one."** A tool whose failure mode is
 * an agent with bash and the user's privileges (S8) must not have "point it at your repository"
 * as its first instruction. This is what a new user is pointed at instead: a scratch repository, a
 * genuinely failing test, two acceptance criteria that are actually checkable, and a scripted
 * three-attempt run whose outcomes are fixed in advance.
 *
 * Three properties make it a demo rather than a fixture, and each is asserted in
 * `test/testing-demo.test.ts`:
 *
 *  1. **The three attempts are not three copies of the same thing.** Attempt 1 fails
 *     verification, attempt 2 hits the delivery-`unknown` path (V5's ack that never arrives), and
 *     attempt 3 succeeds. A demo where everything works teaches nothing about the product, whose
 *     entire subject is what happens when things do not.
 *  2. **The acceptance criteria are real.** They are the commands a verifier would actually run,
 *     against a repository this scenario can actually materialize — not prose.
 *  3. **Nothing here reaches a model, a network or the user's disk.** The scenario is data; the
 *     run is scripted against `MockExecutor`. Materializing the repository is a separate, opt-in
 *     Node-side call (`src/testing/node/demo-repo.ts`), because this file must stay Node-free.
 *
 * DOM-free and Node-free.
 */

import type { ConformanceTurn } from '../executor-conformance.ts'

/** A file the demo repository is seeded with. Paths are relative and always POSIX. */
export interface DemoFile {
  readonly path: string
  readonly contents: string
}

/** One acceptance criterion, in the shape §4.3.6's verifier runs. */
export interface DemoCriterion {
  readonly id: string
  readonly description: string
  /** argv, never a shell string — the same rule the workspace runner holds. */
  readonly command: readonly string[]
  /** What the criterion means when it passes, in the words the user reads. */
  readonly passLabel: string
}

/** One scripted attempt: what the agent "does", and how it ends. */
export interface DemoAttempt {
  readonly index: number
  readonly summary: string
  /** The turns `MockExecutor` plays for this attempt. */
  readonly turns: readonly ConformanceTurn[]
  /**
   * How this attempt is meant to end.
   *
   * `'verification-failed'`, `'delivery-unknown'` and `'succeeded'` — in that order — are the
   * three outcomes a user has to understand before they trust the thing with real work.
   */
  readonly outcome: 'verification-failed' | 'delivery-unknown' | 'succeeded'
  /** Why it ended that way, in one line, for the demo narration. */
  readonly explanation: string
}

/**
 * The failing test the demo is built around.
 *
 * A real assertion against a real bug: `slugify` drops the separator between words, so
 * `"Hello World"` becomes `"helloworld"`. Small enough to read in ten seconds, and wrong in a way
 * a reader can confirm without running anything.
 */
const SOURCE_FILE: DemoFile = {
  path: 'src/slugify.js',
  contents: `/** Turn a title into a URL slug. */
export function slugify(title) {
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '')
}
`,
}

const TEST_FILE: DemoFile = {
  path: 'test/slugify.test.js',
  contents: `import assert from 'node:assert/strict'
import { test } from 'node:test'

import { slugify } from '../src/slugify.js'

test('lowercases and trims', () => {
  assert.equal(slugify('  Hello  '), 'hello')
})

test('joins words with a single hyphen', () => {
  // Fails on the seeded source: the separator is dropped entirely.
  assert.equal(slugify('Hello World'), 'hello-world')
})

test('collapses runs of punctuation into one hyphen', () => {
  assert.equal(slugify('a --- b'), 'a-b')
})

test('has no leading or trailing hyphen', () => {
  assert.equal(slugify('!! hi !!'), 'hi')
})
`,
}

const PACKAGE_FILE: DemoFile = {
  path: 'package.json',
  contents: `${JSON.stringify(
    {
      name: 'swarm-demo-slugify',
      version: '0.0.0',
      private: true,
      type: 'module',
      scripts: { test: 'node --test test/slugify.test.js' },
    },
    null,
    2,
  )}\n`,
}

const README_FILE: DemoFile = {
  path: 'README.md',
  contents: `# swarm demo: slugify

A throwaway repository with one real bug, seeded so the first delegation anyone runs is not
against their own work.

\`slugify('Hello World')\` returns \`'helloworld'\`. It should return \`'hello-world'\`.

Run \`node --test test/slugify.test.js\` to watch it fail.
`,
}

export const DEMO_FILES: readonly DemoFile[] = [PACKAGE_FILE, SOURCE_FILE, TEST_FILE, README_FILE]

/** The objective the demo delegation is created with. */
export const DEMO_OBJECTIVE =
  'Fix slugify so it joins words with a single hyphen, without breaking the other tests.'

/**
 * The two acceptance criteria §10 asks for.
 *
 * Two rather than one, and deliberately not the same shape: the first is the obvious "the tests
 * pass", the second is the one that catches the cheat. An agent that "fixes" the failing test by
 * editing the test file satisfies the first criterion completely — which is why §4.3.6's verifier
 * is swarm's and not the agent's, and why a demo with only one criterion would teach the wrong
 * lesson on its first run.
 */
export const DEMO_CRITERIA: readonly DemoCriterion[] = [
  {
    id: 'tests-pass',
    description: 'The test suite passes.',
    /* The file, not the directory: `node --test test/` resolves the argument as a *module path*
     * on Node ≥ 24 and fails with `Cannot find module`, which would make the criterion "fail" for
     * a reason that has nothing to do with the code. */
    command: ['node', '--test', 'test/slugify.test.js'],
    passLabel: 'All four slugify tests pass.',
  },
  {
    id: 'test-file-unchanged',
    description: 'The test file was not modified.',
    /* `git diff --exit-code -- <path>` exits non-zero when the path changed, so the criterion is
     * "the agent fixed the code, not the evidence". */
    command: ['git', 'diff', '--exit-code', '--', TEST_FILE.path],
    passLabel: 'The fix is in the source, not in the test.',
  },
]

/**
 * The scripted three-attempt run.
 *
 * The order is the argument. A user who sees only attempt 3 learns that swarm works; a user who
 * sees 1 → 2 → 3 learns what swarm does when it does not, which is the only thing that makes an
 * unattended agent fleet trustworthy enough to point at real work.
 */
export const DEMO_ATTEMPTS: readonly DemoAttempt[] = [
  {
    index: 1,
    summary: 'Edits the test instead of the source.',
    turns: [
      {
        ack: true,
        text: 'The assertion looks wrong — updating the expectation to match the output.',
        tools: [{ callId: 'demo-1-edit', name: 'edit', input: TEST_FILE.path }],
        usage: true,
        turnDone: true,
      },
    ],
    outcome: 'verification-failed',
    explanation:
      'Criterion 1 passed and criterion 2 failed: the tests are green because the test changed. ' +
      'Swarm runs the criteria itself, so the attempt is rejected rather than reported as done.',
  },
  {
    index: 2,
    summary: 'Submits a fix, and the acknowledgement never arrives.',
    turns: [
      /* V5, [F2]: the send left and nothing came back. `waitForAccept` cannot tell this from
       * success — the SDK resolves on timeout either way — so the receipt is `unknown` and swarm
       * must not guess. */
      { ack: false, text: '', turnDone: false },
    ],
    outcome: 'delivery-unknown',
    explanation:
      'The submission left and no acknowledgement came back. Swarm reports `unknown` rather than ' +
      'assuming either way, and asks before re-sending — because a turn that did land would ' +
      'otherwise be run twice.',
  },
  {
    index: 3,
    summary: 'Fixes the source and both criteria pass.',
    turns: [
      {
        ack: true,
        text: 'Replacing the non-alphanumeric run with a hyphen, then trimming the edges.',
        tools: [{ callId: 'demo-3-edit', name: 'edit', input: SOURCE_FILE.path }],
        usage: true,
        turnDone: true,
      },
    ],
    outcome: 'succeeded',
    explanation:
      'Both criteria pass: the four tests are green and the test file is untouched. The diff is ' +
      'three characters, and swarm shows it before anything is landed.',
  },
]

/** The patch attempt 3 "writes" — the answer, for a demo that wants to show the diff. */
export const DEMO_FIX: DemoFile = {
  path: SOURCE_FILE.path,
  contents: `/** Turn a title into a URL slug. */
export function slugify(title) {
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
`,
}

/** Everything a demo runner needs, in one value. */
export const DEMO_SCENARIO = {
  objective: DEMO_OBJECTIVE,
  files: DEMO_FILES,
  criteria: DEMO_CRITERIA,
  attempts: DEMO_ATTEMPTS,
  fix: DEMO_FIX,
  /** The one file an agent must not touch, named once so both the criterion and a test can use it. */
  protectedPath: TEST_FILE.path,
  sourcePath: SOURCE_FILE.path,
} as const

/** The turns for one attempt, for a harness driving `MockExecutor` (§5.2). */
export function demoTurns(attempt: number): readonly ConformanceTurn[] {
  const found = DEMO_ATTEMPTS.find((entry) => entry.index === attempt)
  if (found === undefined) throw new Error(`demo: no attempt ${attempt} (there are three)`)
  return found.turns
}
