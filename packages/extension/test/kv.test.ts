import { describe, expect, it, vi } from 'vitest'

import { createStorageAreaKv, createStorageKv, KV_SATISFIES_BOTH } from '../src/kv.ts'
import { createFakeStorage } from './support/fake-chrome.ts'

describe('createStorageKv', () => {
  it('round-trips get/set/remove', async () => {
    const kv = createStorageKv(createFakeStorage())
    await kv.set({ a: 1, b: { nested: true } })
    expect(await kv.get(['a', 'b'])).toEqual({ a: 1, b: { nested: true } })
    await kv.remove(['a'])
    expect(await kv.get(['a', 'b'])).toEqual({ b: { nested: true } })
  })

  it('omits absent keys rather than yielding undefined values', async () => {
    // `createKeyValueRunStore.get` reads `value === undefined ⇒ null`; a present-but-undefined
    // entry would make an absent run look like a corrupt one.
    const kv = createStorageKv(createFakeStorage())
    const read = await kv.get(['nope'])
    expect(read).toEqual({})
    expect('nope' in read).toBe(false)
  })

  it('short-circuits an empty get without touching storage', async () => {
    const storage = createFakeStorage()
    const kv = createStorageKv(storage)
    expect(await kv.get([])).toEqual({})
    expect(storage.getCalls).toBe(0)
  })

  it('short-circuits an empty remove', async () => {
    const storage = createFakeStorage()
    const kv = createStorageKv(storage)
    const spy = vi.spyOn(storage.local, 'remove')
    await kv.remove([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('keys() is key-only when getKeys exists — never get(null)', async () => {
    const storage = createFakeStorage()
    const kv = createStorageKv(storage)
    await kv.set({ 'ns:a': 1, 'ns:b': 2, other: 3 })
    expect((await kv.keys('ns:')).sort()).toEqual(['ns:a', 'ns:b'])
    expect(storage.getNullCalls).toBe(0)
  })

  it('degrades loudly to get(null) when getKeys is unavailable, once', async () => {
    const storage = createFakeStorage({ getKeys: false })
    const onDegraded = vi.fn()
    const kv = createStorageKv(storage, { onDegraded })
    await kv.set({ 'ns:a': 1, zzz: 2 })
    expect(await kv.keys('ns:')).toEqual(['ns:a'])
    await kv.keys('ns:')
    expect(storage.getNullCalls).toBe(2)
    // Loud once, not once per scan: a content script scans on every render pass.
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onDegraded.mock.calls[0]?.[0]).toContain('getKeys')
  })

  it('watch fires with the changed keys and unsubscribes', async () => {
    const storage = createFakeStorage()
    const kv = createStorageKv(storage)
    const seen: string[][] = []
    const off = kv.watch!((keys) => seen.push(keys))
    await kv.set({ x: 1 })
    await kv.remove(['x'])
    off()
    await kv.set({ y: 2 })
    expect(seen).toEqual([['x'], ['x']])
  })

  it('watch ignores changes in another storage area', async () => {
    // A `sync` write must not wake every tab's thread re-read.
    const storage = createFakeStorage()
    const kv = createStorageKv(storage, { areaName: 'local' })
    const seen: string[][] = []
    kv.watch!((keys) => seen.push(keys))
    ;(storage.onChanged as unknown as { emit(c: object, a: string): void }).emit(
      { foo: { newValue: 1 } },
      'sync',
    )
    expect(seen).toEqual([])
  })

  it('remove of an absent key fires no change event', async () => {
    const storage = createFakeStorage()
    const kv = createStorageKv(storage)
    const seen: string[][] = []
    kv.watch!((keys) => seen.push(keys))
    await kv.remove(['never-existed'])
    expect(seen).toEqual([])
  })

  it('createStorageAreaKv is the area-level form of the same adapter', async () => {
    const storage = createFakeStorage()
    const kv = createStorageAreaKv(storage.local, storage.onChanged, { areaName: 'local' })
    await kv.set({ k: 'v' })
    expect(await kv.get(['k'])).toEqual({ k: 'v' })
  })

  it('one adapter satisfies both packages KeyValueAdapter declarations', () => {
    // comment-core and copilot each declare their own; the const is the compile-time proof.
    expect(KV_SATISFIES_BOTH).toBe(true)
  })
})
