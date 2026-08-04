/**
 * `clientConformance()` under vitest (SPEC-swarm §13).
 *
 * The suite is runner-agnostic on purpose — a host embedding swarm runs the identical array in
 * whatever runner it already has — so this file is four lines and the contract lives in
 * `src/testing/client-conformance.ts`.
 */

import { describe, it } from 'vitest'

import { clientConformance } from '../src/testing/client-conformance.ts'

describe('clientConformance()', () => {
  for (const testCase of clientConformance()) {
    it(testCase.name, testCase.run)
  }
})
