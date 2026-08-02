/**
 * §1.1 build: **Vite lib mode, ESM + IIFE. IIFE global: `Comments`.**
 *
 * Two passes, because a lib build can only name an IIFE global for a single entry:
 *
 *  - `BUILD_TARGET=iife` bundles the root entry into one self-contained
 *    `dist/comment-core.iife.js` exposing `Comments`, so §7.1's "no build step at all" HTML
 *    (`<script src="/comment-core.iife.js">`) works on a bare page. Every runtime dependency
 *    (`@medv/finder`, `approx-string-match`, `nanoid`, the vendored Hypothesis anchoring) is
 *    inlined — there is nothing for a `<script>` tag to resolve.
 *  - the default pass emits ESM for all four subpaths of §1.1's entry-point table, preserving
 *    `comment-core/headless`'s DOM-free boundary as its own chunk.
 *
 * `comment-ui.iife.js` declares `comment-core` external and reads it off `globalThis.Comments`
 * (§1.2), which is why the global name here is load-bearing rather than cosmetic.
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
          entry: { 'comment-core': 'src/index.ts' },
          name: 'Comments',
          formats: ['iife'],
          fileName: () => 'comment-core.iife.js',
        }
      : {
          entry: {
            index: 'src/index.ts',
            headless: 'src/headless.ts',
            anchor: 'src/anchor/index.ts',
            testing: 'src/testing/index.ts',
          },
          formats: ['es'],
          fileName: (_format, name) => `${name}.js`,
        },
    rollupOptions: {
      // `happy-dom` is an optional peer (§1.1) and only `createTestPage` needs it; it must never
      // be pulled into a bundle. Nothing else is external — see the IIFE rationale above.
      external: ['happy-dom'],
    },
  },
})
