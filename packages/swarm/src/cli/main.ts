/**
 * The bin's Node-facing half (SPEC-swarm §1.1, §7.1).
 *
 * It exists so that `src/cli.ts` — which sits at the root of `src/` and is therefore scanned by
 * the same `grep -rE "node:|\bprocess\b"` gate that guards the client core (§1.2, §13) — names
 * neither. Everything platform-specific a bin needs (`argv`, `exitCode`) lives here, under
 * `src/cli/`, which the gate allows.
 *
 * `runCli` still returns an exit code rather than calling `process.exit`, so the same code path
 * stays drivable from a test; this module is the only place that turns that number into a
 * process outcome.
 *
 * Node ≥ 24, CLI-only.
 */

import { runCli } from './index.ts'

/** Runs the CLI over `process.argv` and records the exit code. Never throws for a CLI failure. */
export async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2))
}
