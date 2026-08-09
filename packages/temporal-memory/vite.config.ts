import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    target: 'es2022',
    sourcemap: true,
    minify: false,
    lib: {
      entry: {
        index: 'src/index.ts',
        surreal: 'src/surreal/index.ts',
        testing: 'src/testing/index.ts',
      },
      formats: ['es'],
      fileName: (_format, name) => `${name}.js`,
    },
    rollupOptions: {
      external: ['@astrale-os/surrealdb-wasm', 'surrealdb'],
    },
  },
})
