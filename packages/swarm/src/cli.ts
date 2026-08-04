#!/usr/bin/env node
/**
 * The `swarm` bin (SPEC-swarm §1.1, §7.1).
 *
 * A bin is **not** an export entry, so H1's four entries hold and the CLI head costs no public
 * surface (§1.1). This file is deliberately three lines: it sits at the root of `src/`, where
 * §1.2's `node:*`/`process` gate applies, so the argv read and the exit code live one directory
 * down in `./cli/main.ts` — which the gate allows and which returns an exit code rather than
 * calling `process.exit`, so the same path stays drivable from a test.
 *
 * Node ≥ 24, CLI-only.
 */

import { main } from './cli/main.ts'

await main()
