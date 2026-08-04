/**
 * SPEC §1.1 build — Vite lib mode, ESM only, one chunk per entry.
 *
 * Four entries, and the split is the boundary, not a packaging preference:
 *
 *  - `index` is the client core. ES2022 only: no DOM, no `node:*`. Nothing it imports may pull
 *    `src/server/**` in, which is why the protocol is imported by the server through a relative
 *    path and never the other way round (§1.1).
 *  - `presentation` is the injected seam (§6.8) and **imports nothing** — it emits as a chunk
 *    with zero imports, which is what the `.d.ts` grep gate of §13 asserts.
 *  - `server` is Node ≥ 24 (`node:sqlite`); every `node:*` specifier stays external.
 *  - `testing` is dual-runtime; only `src/testing/node/**` may name `node:*`.
 *
 * There is no IIFE pass: unlike `comment-core`, nothing here is loaded by a bare `<script>` on a
 * page — the extension head bundles it, and the CLI head is Node.
 */

import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        index: 'src/index.ts',
        presentation: 'src/presentation.ts',
        server: 'src/server/index.ts',
        testing: 'src/testing/index.ts',
        /* Not an export entry — `bin: { "swarm": "./dist/cli.js" }` (§1.1), so H1's four entries
         * hold. It is still a build entry, because a `bin` that names a file the build does not
         * emit is a package that installs a broken command. */
        cli: 'src/cli.ts',
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      // §1.2's dependency list, plus every builtin. A bundled `node:sqlite` would make the
      // client entry unloadable in a service worker even though it never imports it.
      external: [/^node:/, '@1jehuang/jcode-sdk', 'ws', 'ulid'],
    },
  },
})
