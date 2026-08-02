import { expect, test } from 'vitest'

import { VERSION } from '../src/index.ts'

test('package boots', () => {
  expect(VERSION).toBe('0.0.0')
})
