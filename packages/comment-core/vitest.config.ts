import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'happy-dom',
    /**
     * `--expose-gc` is what lets the GC-safety regression in `test/engine-anchoring.test.ts`
     * force the collection that used to unsubscribe happy-dom's `MutationObserver` (see
     * `src/testing/test-page.ts`).
     */
    execArgv: ['--expose-gc'],
  },
})
