/**
 * §9 definition of done, DOM half:
 *
 *  - `engineConformance()` covers §4.1 rows 14 and 17 and passes against `createMemoryStore`
 *    and `createLocalStorageStore` (the third target, the extension's `chrome.storage`
 *    adapter, is the host's own suite — §7.5);
 *  - `createTestPage` throws `invalid_options` with an install hint when happy-dom is absent.
 */

import { describe, expect, it, test } from 'vitest'

import type { CommentStore, StorageLike } from '../src/index.ts'

import { CommentError, createLocalStorageStore, createMemoryStore } from '../src/index.ts'
import { createTestPage, engineConformance } from '../src/testing/index.ts'

function fakeStorage(): StorageLike {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    key: (index) => [...map.keys()][index] ?? null,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key),
  }
}

const targets: Array<[string, () => CommentStore]> = [
  ['createMemoryStore', () => createMemoryStore()],
  [
    'createLocalStorageStore',
    () => createLocalStorageStore({ storage: fakeStorage(), namespace: `dod-${Math.random()}` }),
  ],
]

for (const [name, factory] of targets) {
  describe(`engineConformance against ${name}`, () => {
    for (const testCase of engineConformance(factory)) it(testCase.name, testCase.run)
  })
}

describe('§2.16 createTestPage', () => {
  test('it throws invalid_options with an install hint when no DOM is available', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Reflect.deleteProperty(globalThis, 'document')
    try {
      let thrown: unknown
      try {
        createTestPage('<p>x</p>')
      } catch (error) {
        thrown = error
      }
      expect(CommentError.is(thrown, 'invalid_options')).toBe(true)
      expect((thrown as CommentError).message).toContain('happy-dom')
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'document', descriptor)
    }
  })

  test('dispose() destroys every engine it built and clears the page', async () => {
    const page = createTestPage('<div id="t">x</div>', { url: 'https://example.com/fixture' })
    const engine = page.engine({ store: createMemoryStore() })
    await engine.ready()
    await page.dispose()
    expect(engine.status.get()).toBe('destroyed')
    expect(page.document.body.innerHTML).toBe('')
  })
})
