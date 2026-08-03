// SPEC-copilot §2.7 (adapter contract) + §9 DoD: `runStoreConformance()` passes against
// `createMemoryRunStore` and `createKeyValueRunStore`.
import { describe, expect, test, vi } from 'vitest'

import type { Run, RunStore } from '../src/types.ts'

import {
  createKeyValueRunStore,
  createMemoryKeyValueAdapter,
  defineRunStore,
} from '../src/store/kv.ts'
import { createMemoryRunStore } from '../src/store/memory.ts'
import { runStoreConformance } from '../src/testing/store-conformance.ts'

const run = (over: Partial<Run> & { id: string }): Run => ({
  state: 'done',
  input: 'x',
  attempts: 1,
  heartbeat: new Date(0).toISOString(),
  createdAt: new Date(0).toISOString(),
  ...over,
})

describe('runStoreConformance / createMemoryRunStore', () => {
  const cases = runStoreConformance(() => createMemoryRunStore())
  test('has ~25 cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(25)
  })
  for (const item of cases) test(item.name, item.run)
})

describe('runStoreConformance / createKeyValueRunStore', () => {
  const cases = runStoreConformance(() => createKeyValueRunStore(createMemoryKeyValueAdapter()))
  for (const item of cases) test(item.name, item.run)
})

describe('runStoreConformance / a store without claim()', () => {
  // The contract is three methods; `claim` is optional and its cases must simply not run.
  const cases = runStoreConformance(() => {
    const inner = createMemoryRunStore()
    return {
      get: inner.get,
      put: inner.put,
      list: inner.list,
    } satisfies RunStore
  })
  for (const item of cases) test(item.name, item.run)
})

describe('§2.7 createKeyValueRunStore specifics', () => {
  test('uses the `{ns}:r:{runId}` key layout', async () => {
    const kv = createMemoryKeyValueAdapter()
    const store = createKeyValueRunStore(kv, { namespace: 'runs' })
    await store.put(run({ id: 'c:t1:1' }))
    expect(await kv.keys('runs:r:')).toEqual(['runs:r:c:t1:1'])
  })

  test('`keep` ring-buffers terminal runs on write', async () => {
    const kv = createMemoryKeyValueAdapter()
    const store = createKeyValueRunStore(kv, { namespace: 'runs', keep: 2 })
    for (const index of [1, 2, 3, 4]) {
      await store.put(run({ id: `r${index}`, createdAt: new Date(index * 1000).toISOString() }))
    }
    const ids = (await store.list()).map((record) => record.id)
    expect(ids).toEqual(['r3', 'r4'])
  })

  test('`keep` never evicts a non-terminal run', async () => {
    const kv = createMemoryKeyValueAdapter()
    const store = createKeyValueRunStore(kv, { namespace: 'runs', keep: 1 })
    await store.put(run({ id: 'live', state: 'processing', createdAt: new Date(0).toISOString() }))
    await store.put(run({ id: 'a', createdAt: new Date(1000).toISOString() }))
    await store.put(run({ id: 'b', createdAt: new Date(2000).toISOString() }))
    expect((await store.list()).map((record) => record.id)).toEqual(['live', 'b'])
  })

  test('idPrefix narrows the key scan', async () => {
    const kv = createMemoryKeyValueAdapter()
    const store = createKeyValueRunStore(kv, { namespace: 'runs' })
    await store.put(run({ id: 'c:t1:1' }))
    await store.put(run({ id: 'c:t2:1' }))
    expect((await store.list({ idPrefix: 'c:t2:' })).map((record) => record.id)).toEqual(['c:t2:1'])
  })

  test('defineRunStore is an identity that preserves the literal type', () => {
    const store = createMemoryRunStore()
    expect(defineRunStore(store)).toBe(store)
  })

  test('lease expiry follows the host clock — the store factories take no clock, by design', async () => {
    // §2.7 / decision log #31: a lease coordinates PROCESSES and every one of them reads
    // `Date.now()`. `CopilotOptions.now` drives heartbeats, staleness and `at` inside a single
    // instance; letting it move leases would let a test clock take a lease a live offscreen
    // document still holds. Normative, not silently assumed.
    vi.useFakeTimers()
    try {
      for (const store of [
        createMemoryRunStore(),
        createKeyValueRunStore(createMemoryKeyValueAdapter()),
      ]) {
        expect(await store.claim?.('r1', 'owner-a', 1_000)).toBe(true)
        expect(await store.claim?.('r1', 'owner-b', 1_000)).toBe(false)
        vi.advanceTimersByTime(1_001)
        expect(await store.claim?.('r1', 'owner-b', 1_000)).toBe(true)
      }
    } finally {
      vi.useRealTimers()
    }
  })

  test('createMemoryRunStore exposes snapshot()', async () => {
    const store = createMemoryRunStore()
    await store.put(run({ id: 'a' }))
    expect(store.snapshot().map((record) => record.id)).toEqual(['a'])
  })
})
