/**
 * §2.7 adapter contract via `storeConformance`, against every shipped adapter, plus the
 * adapter-specific rules of §2.8 (key layout, namespace-filtered watch, lazy localStorage).
 */

import { describe, expect, test, vi } from 'vitest'

import {
  CommentError,
  createKeyValueStore,
  createLocalStorageStore,
  createMemoryStore,
  defineCommentStore,
  type CommentStore,
} from '../src/headless.ts'
import { makeCommentRecord, makeThreadRecord, storeConformance } from '../src/testing/index.ts'
import { createFakeStorage, createMemoryKv, withTransaction } from './helpers.ts'

const suites: Array<[string, () => CommentStore]> = [
  ['createMemoryStore', () => createMemoryStore()],
  ['createKeyValueStore', () => createKeyValueStore(createMemoryKv(), { namespace: 'ns' })],
  ['createLocalStorageStore', () => createLocalStorageStore({ storage: createFakeStorage() })],
  ['a store with transaction', () => withTransaction(createMemoryStore())],
]

for (const [name, factory] of suites) {
  describe(`storeConformance — ${name}`, () => {
    for (const c of storeConformance(factory)) test(c.name, c.run)
  })
}

describe('createMemoryStore extras (§2.8)', () => {
  test('seeds from thread records', async () => {
    const store = createMemoryStore([
      { thread: makeThreadRecord('t1'), comments: [makeCommentRecord('c1', 't1')] },
    ])
    expect((await store.listAllThreads()).map((t) => t.id)).toEqual(['t1'])
    expect((await store.listComments('t1')).map((c) => c.id)).toEqual(['c1'])
  })

  test('snapshot() is a deep copy and restore() replaces the contents', async () => {
    const store = createMemoryStore()
    await store.putThread(makeThreadRecord('t1'))
    await store.putComment(makeCommentRecord('c1', 't1'))
    const snapshot = store.snapshot()
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0]!.comments).toHaveLength(1)

    snapshot[0]!.thread.kind = 'mutated'
    expect((await store.getThread('t1'))?.kind).toBe('comment')

    store.restore([])
    expect(await store.listAllThreads()).toEqual([])
    store.restore(snapshot)
    expect((await store.getThread('t1'))?.kind).toBe('mutated')
  })

  test('counts reads and writes', async () => {
    const store = createMemoryStore()
    await store.putThread(makeThreadRecord('t1'))
    await store.getThread('t1')
    await store.listAllThreads()
    expect(store.writes).toBe(1)
    expect(store.reads).toBe(2)
  })

  test('returned records are copies, not live handles into the store', async () => {
    const store = createMemoryStore()
    await store.putThread(makeThreadRecord('t1'))
    const read = await store.getThread('t1')
    read!.kind = 'mutated'
    expect((await store.getThread('t1'))?.kind).toBe('comment')
  })
})

describe('createKeyValueStore key layout (§2.8)', () => {
  test('uses one immutable key per record, with no shared index key', async () => {
    const kv = createMemoryKv()
    const store = createKeyValueStore(kv, { namespace: 'exp-spec' })
    await store.putThread(makeThreadRecord('t1', { pageKey: 'https://x.test/a?b=1' }))
    await store.putComment(makeCommentRecord('c1', 't1'))
    expect([...kv.data.keys()].sort()).toEqual([
      'exp-spec:c:t1:c1',
      `exp-spec:t:${encodeURIComponent('https://x.test/a?b=1')}:t1`,
    ])
  })

  test('a comment write never rewrites the thread record', async () => {
    const kv = createMemoryKv()
    const store = createKeyValueStore(kv, { namespace: 'ns' })
    await store.putThread(makeThreadRecord('t1'))
    const threadKey = [...kv.data.keys()].find((k) => k.startsWith('ns:t:'))!
    const before = kv.data.get(threadKey)
    await store.putComment(makeCommentRecord('c1', 't1'))
    expect(kv.data.get(threadKey)).toEqual(before)
  })

  test('ids containing a colon (idempotency keys) round-trip', async () => {
    const kv = createMemoryKv()
    const store = createKeyValueStore(kv, { namespace: 'ns' })
    await store.putThread(makeThreadRecord('t:1'))
    await store.putComment(makeCommentRecord('r:run-1', 't:1'))
    expect((await store.getThread('t:1'))?.id).toBe('t:1')
    expect((await store.listComments('t:1')).map((c) => c.id)).toEqual(['r:run-1'])
    await store.deleteComment('r:run-1')
    expect(await store.listComments('t:1')).toEqual([])
  })

  test('moving a thread to another pageKey writes the new key before removing the old', async () => {
    const kv = createMemoryKv()
    const store = createKeyValueStore(kv, { namespace: 'ns' })
    await store.putThread(makeThreadRecord('t1', { pageKey: 'p1' }))
    await store.putThread(makeThreadRecord('t1', { pageKey: 'p2' }))
    expect([...kv.data.keys()]).toEqual(['ns:t:p2:t1'])
  })

  test('deleteThread removes the record and its comment keys in one sweep', async () => {
    const kv = createMemoryKv()
    const store = createKeyValueStore(kv, { namespace: 'ns' })
    await store.putThread(makeThreadRecord('t1'))
    await store.putComment(makeCommentRecord('c1', 't1'))
    await store.putComment(makeCommentRecord('c2', 't1'))
    await store.deleteThread('t1')
    expect([...kv.data.keys()]).toEqual([])
  })

  test('a foreign value under our prefix is ignored rather than surfaced', async () => {
    const kv = createMemoryKv()
    const store = createKeyValueStore(kv, { namespace: 'ns' })
    kv.data.set('ns:t:page:garbage', { not: 'a thread' })
    expect(await store.listAllThreads()).toEqual([])
  })
})

describe('createKeyValueStore watch filtering (§2.8, normative)', () => {
  test('ignores changed keys outside its own ranges', async () => {
    const kv = createMemoryKv()
    const store = createKeyValueStore(kv, { namespace: 'exp-spec' })
    let notifications = 0
    store.subscribe(null, () => {
      notifications++
    })

    // A sibling module's run heartbeat, and the bridge's own host range.
    kv.emit(['runs:run-1'])
    kv.emit(['exp-spec:host:pending'])
    expect(notifications).toBe(0)

    kv.emit(['exp-spec:t:page:t1'])
    expect(notifications).toBe(1)
    kv.emit(['exp-spec:c:t1:c1'])
    expect(notifications).toBe(2)
  })

  test('detaches the adapter watch when the last subscriber leaves', async () => {
    const kv = createMemoryKv()
    const store = createKeyValueStore(kv, { namespace: 'ns' })
    let notifications = 0
    const off = store.subscribe(null, () => {
      notifications++
    })
    off()
    kv.emit(['ns:t:page:t1'])
    expect(notifications).toBe(0)
  })

  test('maps a quota failure from the adapter to quota_exceeded', async () => {
    const kv = createMemoryKv()
    const store = createKeyValueStore(kv, { namespace: 'ns' })
    kv.set = async () => {
      throw Object.assign(new Error('nope'), { name: 'QuotaExceededError' })
    }
    await expect(store.putThread(makeThreadRecord('t1'))).rejects.toSatisfy((e: unknown) =>
      CommentError.is(e, 'quota_exceeded'),
    )
  })
})

describe('createLocalStorageStore (§2.8)', () => {
  test('touches localStorage lazily, on the first call and never at module scope', async () => {
    vi.stubGlobal('localStorage', undefined)
    try {
      // Construction must succeed even with no localStorage at all; the first call is what
      // fails, with a typed error.
      const store = createLocalStorageStore()
      await expect(store.listAllThreads()).rejects.toSatisfy((e: unknown) =>
        CommentError.is(e, 'store_failed'),
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('persists into the supplied Storage as JSON under its namespace', async () => {
    const storage = createFakeStorage()
    const store = createLocalStorageStore({ storage, namespace: 'demo' })
    await store.putThread(makeThreadRecord('t1', { pageKey: 'p' }))
    expect([...storage.map.keys()]).toEqual(['demo:t:p:t1'])
    expect(JSON.parse(storage.map.get('demo:t:p:t1')!).id).toBe('t1')
    expect((await store.getThread('t1'))?.id).toBe('t1')
  })

  test('enumerates keys without deserializing values', async () => {
    const storage = createFakeStorage()
    const store = createLocalStorageStore({ storage, namespace: 'demo' })
    await store.putThread(makeThreadRecord('t1'))
    storage.map.set('other-app:x', 'not json at all')
    expect((await store.listAllThreads()).map((t) => t.id)).toEqual(['t1'])
  })
})

describe('defineCommentStore (§2.7)', () => {
  test('is an identity function that preserves the concrete type', () => {
    const store = createMemoryStore()
    expect(defineCommentStore(store)).toBe(store)
  })
})
