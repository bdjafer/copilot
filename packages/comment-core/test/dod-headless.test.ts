// @vitest-environment node
/**
 * §9 definition-of-done gates for the headless half.
 *
 *  1. the root entry imports with every platform global deleted, and its headless surface is
 *     callable;
 *  2. a fixture importing `comment-core/headless` typechecks under `lib: ["ES2022",
 *     "WebWorker"]` — runtime-global deletion is not enough, the failure this catches is a
 *     compile error;
 *  3. no platform API is named anywhere in `src`.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PLATFORM_GLOBALS = ['document', 'window', 'navigator', 'localStorage', 'chrome'] as const

describe('DoD — the root entry loads with no platform globals', () => {
  test('createDomain, observeStore, createMemoryStore, createKeyValueStore and defaultPageKey are callable', async () => {
    const saved = new Map<string, PropertyDescriptor | undefined>()
    for (const name of PLATFORM_GLOBALS) {
      saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
      Reflect.deleteProperty(globalThis, name)
      if (name in globalThis) {
        Object.defineProperty(globalThis, name, { value: undefined, configurable: true })
      }
    }

    try {
      for (const name of PLATFORM_GLOBALS) {
        expect((globalThis as Record<string, unknown>)[name]).toBeUndefined()
      }

      // Module evaluation itself must not touch any of them.
      const api = await import('../src/index.ts')

      const store = api.createMemoryStore()
      expect(typeof api.createDomain(store).list).toBe('function')
      expect(typeof api.observeStore(store, () => {})).toBe('function')
      expect(
        typeof api.createKeyValueStore({
          get: async () => ({}),
          set: async () => {},
          remove: async () => {},
          keys: async () => [],
        }).listAllThreads,
      ).toBe('function')
      expect(api.defaultPageKey(new URL('https://example.com/a/'))).toBe('https://example.com/a')

      // The demo adapter constructs without a DOM too; only its first call needs storage.
      expect(typeof api.createLocalStorageStore().getThread).toBe('function')
      expect(
        typeof api.createKeyValueCursor({
          get: async () => ({}),
          set: async () => {},
          remove: async () => {},
          keys: async () => [],
        }).load,
      ).toBe('function')
      expect(api.CommentError.is(new api.CommentError('empty_body'))).toBe(true)
      expect(api.THREAD_VERSION).toBe(1)
    } finally {
      for (const [name, descriptor] of saved) {
        Reflect.deleteProperty(globalThis, name)
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      }
    }
  })
})

describe('DoD — comment-core/headless compiles without lib.dom', () => {
  test('the WebWorker-lib fixture typechecks', () => {
    const tsgo = resolve(packageRoot, '../../node_modules/.bin/tsgo')
    expect(existsSync(tsgo)).toBe(true)
    // Throws (and prints the diagnostics) when a `lib.dom` identifier leaks into the headless
    // type surface.
    execFileSync(tsgo, ['--noEmit', '-p', 'test/fixtures/worker/tsconfig.json'], {
      cwd: packageRoot,
      encoding: 'utf8',
    })
  }, 120_000)
})

describe('DoD — no platform API is named in src', () => {
  test('the extension/platform grep returns nothing', () => {
    let output = ''
    try {
      output = execFileSync('grep', ['-rE', "chrome\\.|wxt/|from 'copilot'", 'src'], {
        cwd: packageRoot,
        encoding: 'utf8',
      })
    } catch (error) {
      // grep exits 1 when there is no match — the passing case.
      expect((error as { status?: number }).status).toBe(1)
      return
    }
    expect(output).toBe('')
  })
})
