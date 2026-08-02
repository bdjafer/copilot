/**
 * §1 build: **Vite lib mode, ESM + IIFE. IIFE global: `Copilot`.**
 *
 * Two passes, because a lib build can only name an IIFE global for a single entry:
 *
 *  - `BUILD_TARGET=iife` bundles the root entry into one self-contained `dist/copilot.iife.js`
 *    exposing `Copilot`, so a bare page (or an MV3 script that cannot run a bundler) can drop it
 *    in. Everything is inlined — there is nothing for a `<script>` tag to resolve.
 *  - the default pass emits ESM for both subpaths of §1's entry-point table, keeping
 *    `copilot/testing` a separate chunk so a production bundle never pulls in the scripted model.
 *    Runtime dependencies stay external there: the host owns the `ai` instance it injects as
 *    `provider`, and shipping a second copy of the SDK inside this package is how two versions
 *    of a provider protocol end up in one worker.
 *
 * The package's `exports` keep pointing at `src` for workspace consumers (the repo type-checks
 * across packages); `publishConfig.exports` is what a published tarball resolves to.
 */

import { defineConfig } from 'vite'

const iife = process.env.BUILD_TARGET === 'iife'

export default defineConfig({
  build: {
    target: 'es2022',
    // The two passes write into one `dist/`, so the second must not wipe the first.
    emptyOutDir: iife,
    sourcemap: true,
    minify: false,
    lib: iife
      ? {
          entry: { copilot: 'src/index.ts' },
          name: 'Copilot',
          formats: ['iife'],
          fileName: () => 'copilot.iife.js',
        }
      : {
          entry: {
            index: 'src/index.ts',
            testing: 'src/testing/index.ts',
          },
          formats: ['es'],
          fileName: (_format, name) => `${name}.js`,
        },
    rollupOptions: {
      external: iife ? [] : ['ai', 'nanoid', '@standard-schema/spec'],
    },
  },
})
