/**
 * §1.2 / §3.1.1 build: **ESM + IIFE, IIFE globals `CommentsUI` and `CommentsUIGlass`**, mirroring
 * `comment-core`'s multi-pass setup (a lib build can only name an IIFE global for a single entry).
 *
 * **IIFE build contract (normative, §1.2).** `comment-ui.iife.js` declares `comment-core`
 * **external** and reads it from `globalThis.Comments`; it never bundles its own copy, so
 * `comment-core.iife.js` must be loaded first (§7.1). That is exactly why `CommentError.is` is
 * brand-based rather than `instanceof` — two copies of the class would make the guard lie.
 * `@floating-ui/dom` is the opposite case: it is `comment-ui`'s own dependency, exposes no
 * documented global, and nothing else on the page shares it, so it is inlined into both
 * bundles and a bare `<script>` tag has nothing to resolve.
 *
 * Three passes, because they answer three different questions:
 *
 *  - `BUILD_TARGET=iife` — the root as an IIFE, global `CommentsUI`.
 *  - `BUILD_TARGET=glass` — `comment-ui/glass`, as **both** ESM and IIFE from one entry, plus
 *    `dist/comment-ui-glass.css`. It gets its own pass rather than joining the ESM entry list,
 *    and that is load-bearing: rollup hoists a module shared by two entries into a common chunk,
 *    so `/glass` sharing a chunk with the root would put the engine one relative import away
 *    from the theme — silently undoing the property §1.2's table states as "**none at runtime**".
 *    A single-entry pass makes that impossible by construction rather than by review.
 *  - the default pass — the three ESM entries of §3.1.1: the root, the **types-only**
 *    `presentation` module (which compiles to an empty chunk — that is the point: it costs a
 *    consumer nothing at runtime and can therefore be the seam without being a dependency), and
 *    `testing`.
 *
 * Both stylesheets are emitted from the same strings their presentations inject, so the injected
 * and importable forms can never drift.
 */

import { defineConfig, type Plugin } from 'vite'

import { commentUIStyles } from './src/presentations/dom/styles.ts'
import { glassStyles } from './src/presentations/glass/styles.ts'

const target = process.env.BUILD_TARGET
const iife = target === 'iife'
const glass = target === 'glass'

/** The importable half of the CSS contract — same bytes as the injected `<style>`. */
function emitStylesheet(): Plugin {
  return {
    name: 'comment-ui:stylesheet',
    apply: 'build',
    generateBundle() {
      if (glass) {
        this.emitFile({ type: 'asset', fileName: 'comment-ui-glass.css', source: glassStyles })
        return
      }
      this.emitFile({ type: 'asset', fileName: 'comment-ui.css', source: commentUIStyles })
    },
  }
}

const esmEntries = {
  index: 'src/index.ts',
  presentation: 'src/presentation.ts',
  testing: 'src/testing/index.ts',
}

export default defineConfig({
  plugins: [emitStylesheet()],
  build: {
    target: 'es2022',
    // The passes write into one `dist/`, so only the first of them may wipe it.
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
      : glass
        ? {
            entry: 'src/glass.ts',
            name: 'CommentsUIGlass',
            formats: ['es', 'iife'],
            fileName: (format) => (format === 'iife' ? 'comment-ui-glass.iife.js' : 'glass.js'),
          }
        : { entry: esmEntries, formats: ['es'], fileName: (_format, name) => `${name}.js` },
    // `/glass` names the root as external too. It has nothing to import from it today — that is
    // the whole point of a types-only seam — but declaring it is what guarantees a later edit
    // cannot quietly inline a second controller into the theme bundle.
    rollupOptions: glass
      ? {
          external: ['@astrale-os/comment-ui'],
          output: { globals: { '@astrale-os/comment-ui': 'CommentsUI' } },
        }
      : {
          external: ['@astrale-os/comment-core', '@astrale-os/comment-core/testing'],
          output: { globals: { '@astrale-os/comment-core': 'Comments' } },
        },
  },
})
