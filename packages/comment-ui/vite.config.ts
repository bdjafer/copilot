/**
 * §1.2 build: **ESM + IIFE, IIFE global `CommentsUI`**, mirroring `comment-core`'s two-pass
 * setup (a lib build can only name an IIFE global for a single entry).
 *
 * **IIFE build contract (normative, §1.2).** `comment-ui.iife.js` declares `comment-core`
 * **external** and reads it from `globalThis.Comments`; it never bundles its own copy, so
 * `comment-core.iife.js` must be loaded first (§7.1). That is exactly why `CommentError.is` is
 * brand-based rather than `instanceof` — two copies of the class would make the guard lie.
 * `@floating-ui/dom` is the opposite case: it is `comment-ui`'s own dependency, exposes no
 * documented global, and nothing else on the page shares it, so it is inlined into both
 * bundles and a bare `<script>` tag has nothing to resolve.
 *
 * The build also emits `dist/comment-ui.css` from the same `commentUIStyles` string the
 * renderer injects, so the injected and importable forms can never drift.
 */

import { defineConfig, type Plugin } from 'vite'

import { commentUIStyles } from './src/styles.ts'

const iife = process.env.BUILD_TARGET === 'iife'

/** The importable half of the CSS contract — same bytes as the injected `<style>`. */
function emitStylesheet(): Plugin {
  return {
    name: 'comment-ui:stylesheet',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'comment-ui.css', source: commentUIStyles })
    },
  }
}

export default defineConfig({
  plugins: [emitStylesheet()],
  build: {
    target: 'es2022',
    // The two passes write into one `dist/`, so the second must not wipe the first.
    emptyOutDir: iife,
    sourcemap: true,
    minify: false,
    cssCodeSplit: false,
    lib: iife
      ? {
          entry: { 'comment-ui': 'src/index.ts' },
          name: 'CommentsUI',
          formats: ['iife'],
          fileName: () => 'comment-ui.iife.js',
        }
      : {
          entry: { index: 'src/index.ts' },
          formats: ['es'],
          fileName: (_format, name) => `${name}.js`,
        },
    rollupOptions: {
      external: ['@astrale-os/comment-core'],
      output: { globals: { '@astrale-os/comment-core': 'Comments' } },
    },
  },
})
