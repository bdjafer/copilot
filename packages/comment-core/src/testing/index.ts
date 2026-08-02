/**
 * `comment-core/testing` (§2.16) — runner-agnostic conformance suites.
 *
 * `storeConformance` and `domainConformance` are DOM-free and need no peer dependency.
 * `engineConformance` and `createTestPage` require one — importing this barrel does not,
 * because neither touches a DOM until it is called.
 */

export type { Awaitable, ConformanceCase } from './types.ts'
export { domainConformance } from './domain-conformance.ts'
export { storeConformance } from './store-conformance.ts'
export { engineConformance } from './engine-conformance.ts'
export { createTestPage, type TestPage } from './test-page.ts'

/* Fixtures, exported so a host suite can build records without a DOM. */
export {
  countingIds,
  makeCommentRecord,
  makeCreateInput,
  makeThreadRecord,
  tickingClock,
} from './fixtures.ts'
