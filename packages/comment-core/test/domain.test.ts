/**
 * §4.1 edge-case table via `domainConformance`, against every shipped adapter and against a
 * store that has `transaction` — plus the domain behaviour the suite cannot express because it
 * needs a custom `DomainOptions`.
 */

import { describe, expect, test } from 'vitest'

import {
  CommentError,
  createDomain,
  createKeyValueStore,
  createLocalStorageStore,
  createMemoryStore,
  type CommentStore,
  type Thread,
} from '../src/headless.ts'
import {
  countingIds,
  domainConformance,
  makeCreateInput,
  makeThreadRecord,
  tickingClock,
} from '../src/testing/index.ts'
import { createFakeStorage, createMemoryKv, withTransaction } from './helpers.ts'

const suites: Array<[string, () => CommentStore]> = [
  ['createMemoryStore', () => createMemoryStore()],
  ['createKeyValueStore', () => createKeyValueStore(createMemoryKv(), { namespace: 'ns' })],
  ['createLocalStorageStore', () => createLocalStorageStore({ storage: createFakeStorage() })],
  ['a store with transaction', () => withTransaction(createMemoryStore())],
]

for (const [name, factory] of suites) {
  describe(`domainConformance — ${name}`, () => {
    for (const c of domainConformance(factory)) test(c.name, c.run)
  })
}

describe('DomainOptions (§2.9)', () => {
  const domainOf = (store: CommentStore, over?: Parameters<typeof createDomain>[1]) =>
    createDomain(store, { now: tickingClock(), createId: countingIds(), ...over })

  test('reopensOnReply is the behavioural axis behind the Author union', async () => {
    const store = createMemoryStore()
    // A host that models the machine as the reopening actor — without comment-core learning
    // a third actor's name.
    const domain = domainOf(store, { reopensOnReply: (author) => author === 'copilot' })
    const { thread } = await domain.createThread(makeCreateInput())
    await domain.resolve(thread.id)

    const user = await domain.appendComment(thread.id, { author: 'user', body: 'hi' })
    expect(user.reopened).toBe(false)
    expect(user.thread.status).toBe('resolved')

    const copilot = await domain.appendComment(thread.id, { author: 'copilot', body: 'hi' })
    expect(copilot.reopened).toBe(true)
    expect(copilot.thread.status).toBe('open')
  })

  test('createId and now are the only sources of ids and timestamps', async () => {
    const store = createMemoryStore()
    const domain = createDomain(store, {
      now: () => new Date('2030-05-05T00:00:00.000Z'),
      createId: countingIds('fixed'),
    })
    const { thread, comment } = await domain.createThread(makeCreateInput())
    expect(thread.id).toBe('fixed-1')
    expect(comment.id).toBe('fixed-2')
    expect(thread.createdAt).toBe('2030-05-05T00:00:00.000Z')
    expect(comment.createdAt).toBe('2030-05-05T00:00:00.000Z')
  })

  test('a throwing onError cannot break the call that reported to it', async () => {
    const store = createMemoryStore()
    const domain = domainOf(store, {
      onError: () => {
        throw new Error('pager is down')
      },
    })
    await store.putThread({ ...makeThreadRecord('t-future'), v: 7 } as unknown as Thread)
    await expect(domain.list()).resolves.toEqual([])
  })

  test('a write to an unknown-version thread rejects instead of rewriting it', async () => {
    const store = createMemoryStore()
    const errors: CommentError[] = []
    const domain = domainOf(store, { onError: (e) => errors.push(e) })
    await store.putThread({ ...makeThreadRecord('t-future'), v: 7 } as unknown as Thread)

    await expect(
      domain.appendComment('t-future', { author: 'user', body: 'hi' }),
    ).rejects.toSatisfy((e: unknown) => CommentError.is(e, 'unsupported_version'))
    expect((await store.getThread('t-future'))?.v).toBe(7)
    expect(errors.map((e) => e.code)).toEqual(['unsupported_version'])
  })

  test('delete works on an unknown-version record — deleting is not rewriting', async () => {
    const store = createMemoryStore()
    const domain = domainOf(store)
    await store.putThread({ ...makeThreadRecord('t-future'), v: 7 } as unknown as Thread)
    await domain.delete('t-future')
    expect(await store.getThread('t-future')).toBe(null)
  })
})

describe('domain error contract (§4.4)', () => {
  test('a store failure surfaces as store_failed with the original on .cause', async () => {
    const failure = new Error('disk on fire')
    const store: CommentStore = {
      ...createMemoryStore(),
      putComment: () => Promise.reject(failure),
    }
    const domain = createDomain(store, { now: tickingClock(), createId: countingIds() })
    const error = await domain.createThread(makeCreateInput()).catch((e: unknown) => e)
    expect(CommentError.is(error, 'store_failed')).toBe(true)
    expect((error as CommentError).cause).toBe(failure)
  })

  test('a quota failure surfaces as quota_exceeded — the one a host can act on', async () => {
    const store: CommentStore = {
      ...createMemoryStore(),
      putComment: () =>
        Promise.reject(Object.assign(new Error('full'), { name: 'QuotaExceededError' })),
    }
    const domain = createDomain(store, { now: tickingClock(), createId: countingIds() })
    await expect(domain.createThread(makeCreateInput())).rejects.toSatisfy((e: unknown) =>
      CommentError.is(e, 'quota_exceeded'),
    )
  })

  test('an unknown CommentRef rejects with comment_not_found in both ref forms', async () => {
    const domain = createDomain(createMemoryStore(), {
      now: tickingClock(),
      createId: countingIds(),
    })
    await expect(domain.editComment('nope', 'x')).rejects.toSatisfy((e: unknown) =>
      CommentError.is(e, 'comment_not_found'),
    )
    await expect(domain.deleteComment({ threadId: 't1', id: 'nope' })).rejects.toSatisfy(
      (e: unknown) => CommentError.is(e, 'comment_not_found'),
    )
  })

  test('the bare-id CommentRef form still resolves on a store without getComment', async () => {
    const base = createMemoryStore()
    const store: CommentStore = {
      getThread: (id) => base.getThread(id),
      listThreads: (k) => base.listThreads(k),
      listAllThreads: () => base.listAllThreads(),
      putThread: (t) => base.putThread(t),
      deleteThread: (id) => base.deleteThread(id),
      listComments: (id) => base.listComments(id),
      putComment: (c) => base.putComment(c),
      deleteComment: (id) => base.deleteComment(id),
      subscribe: (k, cb) => base.subscribe(k, cb),
    }
    const domain = createDomain(store, { now: tickingClock(), createId: countingIds() })
    const { comment } = await domain.createThread(makeCreateInput())
    expect((await domain.editComment(comment.id, 'edited')).body).toBe('edited')
  })
})
