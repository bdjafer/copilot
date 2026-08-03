import { defineConfig } from 'vitest/config'

import { BUILT_ENTRIES } from './test/support.ts'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    globalSetup: ['./test/global-setup.ts'],
    testTimeout: 20_000,
  },
  resolve: {
    // Both names are redirected, not just the ones the test imports: `comment-ui.js` declares
    // `comment-core` external (SPEC §1.2), so without the first alias the UI bundle would pull a
    // SECOND copy of the engine out of `src/` and the test would quietly stop testing the build.
    //
    // The targets come from `test/support.ts`, which the tests also read — repointing an alias
    // at `src/` therefore fails `demo.test.ts`'s "really did load the built bundles" instead of
    // leaving it green against two strings nothing uses.
    alias: [
      {
        find: /^@astrale-os\/comment-core$/,
        replacement: BUILT_ENTRIES['@astrale-os/comment-core'],
      },
      { find: /^@astrale-os\/comment-ui$/, replacement: BUILT_ENTRIES['@astrale-os/comment-ui'] },
      {
        find: /^@astrale-os\/comment-ui\/glass$/,
        replacement: BUILT_ENTRIES['@astrale-os/comment-ui/glass'],
      },
    ],
  },
})
