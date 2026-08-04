import { defineConfig } from 'vitest/config'

/**
 * `node`, not `happy-dom`: the client core is DOM-free *and* Node-free (§1.1 H2), so a DOM
 * environment would hide an accidental `document` reference behind a global that only the test
 * runner supplies. The boundary is asserted statically instead — `test/boundaries.test.ts`
 * walks the import graph reachable from `src/index.ts` (§13 grep gates).
 *
 * The server store is `node:sqlite` (decision log #12), so the suite needs Node regardless.
 */
export default defineConfig({
  test: {
    environment: 'node',
  },
})
