/**
 * The seeded demo scenario (SPEC-swarm §10, release gate 10).
 *
 * Data and a scripted run, both Node-free — materializing the repository on disk lives in
 * `src/testing/node/demo-repo.ts`, because that needs `node:fs` and this must not.
 */

export {
  DEMO_ATTEMPTS,
  DEMO_CRITERIA,
  DEMO_FILES,
  DEMO_FIX,
  DEMO_OBJECTIVE,
  DEMO_SCENARIO,
  demoTurns,
} from './scenario.ts'
export type { DemoAttempt, DemoCriterion, DemoFile } from './scenario.ts'

export { runDemoAttempts } from './run.ts'
export type { DemoAttemptResult, DemoRunOptions } from './run.ts'
