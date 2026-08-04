/**
 * Materialize the demo repository on disk (SPEC-swarm §10, release gate 10).
 *
 * Separate from `src/testing/demo/*` for one reason: that directory must stay Node-free, and this
 * needs `node:fs`. Separate from the scenario for a second reason worth stating — the demo can be
 * *shown* without ever writing a file, so writing one is an explicit call rather than a side
 * effect of importing the scenario.
 *
 * It creates a git repository so the second acceptance criterion (`git diff --exit-code` against
 * the test file) is actually runnable. Without a repo that criterion is prose, and a demo whose
 * criteria cannot run teaches the user to trust criteria that cannot run.
 *
 * Node ≥ 24; testing-only.
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { DEMO_FILES, DEMO_FIX } from '../demo/scenario.ts'

export interface DemoRepo {
  readonly root: string
  /** Apply the fix attempt 3 makes, so a demo can show a real diff. */
  applyFix(): void
  /** The cheat attempt 1 makes: edit the test instead of the source. */
  applyTestEdit(): void
  remove(): void
}

/**
 * Create the scratch repository under the OS temp dir.
 *
 * Never inside the user's own tree: the entire point of the seeded demo is that a first run
 * cannot touch real work, and putting the scratch repo next to real work would give that up on a
 * mistyped path.
 */
export function createDemoRepo(options: { readonly git?: boolean } = {}): DemoRepo {
  const root = mkdtempSync(join(tmpdir(), 'swarm-demo-'))

  const write = (path: string, contents: string): void => {
    const target = join(root, path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, contents, 'utf8')
  }

  for (const file of DEMO_FILES) write(file.path, file.contents)

  if (options.git !== false) {
    const git = (...args: string[]): void => {
      execFileSync('git', args, {
        cwd: root,
        stdio: 'ignore',
        /* An identity that cannot be mistaken for the user's, and never their global config. */
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'swarm demo',
          GIT_AUTHOR_EMAIL: 'demo@swarm.invalid',
          GIT_COMMITTER_NAME: 'swarm demo',
          GIT_COMMITTER_EMAIL: 'demo@swarm.invalid',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_SYSTEM: '/dev/null',
        },
      })
    }
    git('init', '--quiet', '--initial-branch', 'main')
    git('add', '.')
    git('commit', '--quiet', '-m', 'seed: slugify with one failing test')
  }

  return {
    root,
    applyFix() {
      write(DEMO_FIX.path, DEMO_FIX.contents)
    },
    /**
     * The cheat: rewrite the expectations to match the buggy output.
     *
     * Both of them. Two of the four seeded assertions fail on the seeded source, so an edit that
     * changed only one would leave the suite red and the demo would never reach the point — which
     * is that a green suite is not evidence when the agent could edit the suite.
     */
    applyTestEdit() {
      const test = DEMO_FILES.find((file) => file.path.startsWith('test/'))!
      write(
        test.path,
        test.contents.replace("'hello-world'", "'helloworld'").replace("'a-b'", "'ab'"),
      )
    },
    remove() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}
