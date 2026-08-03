import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The content-script half (engine, comment-ui, the pill) needs a DOM; the SW half does not
    // and is written to run under either.
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
})
