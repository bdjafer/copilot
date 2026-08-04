#!/usr/bin/env node
/**
 * The `swarm` bin (SPEC-swarm §1.1, §7.1).
 *
 * A bin is **not** an export entry, so H1's four entries hold and the CLI head costs no public
 * surface (§1.1). Everything it does lives in `src/cli/index.ts`, which returns an exit code
 * rather than calling `process.exit` — so the same code path is drivable from a test.
 *
 * Node ≥ 24, CLI-only.
 */

import { runCli } from './cli/index.ts'

const code = await runCli(process.argv.slice(2))
process.exitCode = code
