/**
 * The open DoD item, closed.
 *
 * SPEC-comment-core §9: "`storeConformance()` / `domainConformance()` / `engineConformance()`
 * pass against `createMemoryStore`, `createLocalStorageStore` **and the extension's
 * `chrome.storage` adapter**."
 * SPEC-copilot §9: "`runStoreConformance()` passes against `createMemoryRunStore`,
 * `createKeyValueRunStore`, **and the extension's `chrome.storage` adapter**."
 *
 * All four suites run against the *same* `KeyValueAdapter` construction the extension actually
 * ships (`createStorageKv` over a `chrome.storage.local` fake), so the thing under test is the
 * adapter, not a stand-in for it.
 */

import { createKeyValueRunStore } from '@astrale-os/browser-copilot'
import { runStoreConformance } from '@astrale-os/browser-copilot/testing'
import { createKeyValueStore } from '@astrale-os/comment-core'
import {
  domainConformance,
  engineConformance,
  storeConformance,
} from '@astrale-os/comment-core/testing'
import { describe, expect, it } from 'vitest'

import { COMMENT_NS, RUN_NS } from '../src/keys.ts'
import { createStorageKv } from '../src/kv.ts'
import { createFakeStorage } from './support/fake-chrome.ts'

/** A fresh profile per case: the suites assume an empty store. */
const chromeKv = () => createStorageKv(createFakeStorage())
const chromeStore = () => createKeyValueStore(chromeKv(), { namespace: COMMENT_NS })
const chromeRunStore = () => createKeyValueRunStore(chromeKv(), { namespace: RUN_NS })

describe('chrome.storage CommentStore — storeConformance', () => {
  for (const testCase of storeConformance(chromeStore)) it(testCase.name, testCase.run)
})

describe('chrome.storage CommentStore — domainConformance', () => {
  for (const testCase of domainConformance(chromeStore)) it(testCase.name, testCase.run)
})

describe('chrome.storage CommentStore — engineConformance', () => {
  for (const testCase of engineConformance(chromeStore)) it(testCase.name, testCase.run)
})

describe('chrome.storage RunStore — runStoreConformance', () => {
  for (const testCase of runStoreConformance(chromeRunStore)) it(testCase.name, testCase.run)
})

describe('the adapter the suites ran against is the one the extension ships', () => {
  it('is built by createStorageKv over chrome.storage.local, with getKeys', async () => {
    const storage = createFakeStorage()
    const kv = createStorageKv(storage)
    await kv.set({ 'exp-spec:t:a:b': { id: 'b' } })
    // Key-only: a prefix scan must never deserialize the area.
    const before = storage.getNullCalls
    expect(await kv.keys('exp-spec:t:')).toEqual(['exp-spec:t:a:b'])
    expect(storage.getNullCalls).toBe(before)
  })

  it('enforces chrome.storage JSON serialization on write', async () => {
    const kv = createStorageKv(createFakeStorage())
    // A Map survives structured clone but not chrome.storage's JSON round trip. The conformance
    // suites only store plain records, so this is what proves the fake is not more permissive
    // than the platform.
    await kv.set({ k: { map: new Map([['a', 1]]) } })
    expect(await kv.get(['k'])).toEqual({ k: { map: {} } })
  })
})
