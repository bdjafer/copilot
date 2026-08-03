/**
 * The `exp-spec:host:*` range (SPEC-comment-core §6). The property under test throughout is
 * durability: everything here must survive a worker death, which in these tests is modelled by
 * building a *second* `createHostState` over the same storage.
 */

import { describe, expect, it } from 'vitest'

import { createHostState } from '../src/host-state.ts'
import { failedKey, pendingKey } from '../src/keys.ts'
import { createStorageKv } from '../src/kv.ts'
import { createFakeStorage } from './support/fake-chrome.ts'

const PAGE = 'https://example.com/doc'
const OTHER = 'https://example.com/other'

function scene() {
  const storage = createFakeStorage()
  const kv = createStorageKv(storage)
  let tick = 0
  const host = createHostState(kv, () => new Date(1_700_000_000_000 + tick++ * 1000))
  return { storage, kv, host, revive: () => createHostState(kv) }
}

describe('pending set', () => {
  it('survives a worker death — the entire reason it is not in memory', async () => {
    const { host, revive } = scene()
    await host.markPending({ threadId: 't1', pageKey: PAGE, kind: 'comment' })
    // The worker dies here. A `Set` in its memory would be gone; PLAN §5's pill would then
    // silently under-count and the user's comments would never be dispatched.
    const afterDeath = revive()
    expect((await afterDeath.listPending(PAGE)).map((entry) => entry.threadId)).toEqual(['t1'])
  })

  it('is per-record, so two contexts writing concurrently do not clobber each other', async () => {
    const { host, storage } = scene()
    await Promise.all([
      host.markPending({ threadId: 't1', pageKey: PAGE, kind: 'comment' }),
      host.markPending({ threadId: 't2', pageKey: PAGE, kind: 'comment' }),
      host.markPending({ threadId: 't3', pageKey: PAGE, kind: 'comment' }),
    ])
    expect((await host.listPending(PAGE)).length).toBe(3)
    expect(
      Object.keys(storage.dump()).filter((key) => key.startsWith('exp-spec:host:pending:')),
    ).toHaveLength(3)
  })

  it('scopes listPending to one page', async () => {
    const { host } = scene()
    await host.markPending({ threadId: 't1', pageKey: PAGE, kind: 'comment' })
    await host.markPending({ threadId: 't2', pageKey: OTHER, kind: 'comment' })
    expect((await host.listPending(PAGE)).map((e) => e.threadId)).toEqual(['t1'])
    expect((await host.listAllPending()).map((e) => e.threadId)).toEqual(['t1', 't2'])
  })

  it('orders by insertion time so the batch run id is stable across contexts', async () => {
    const { host } = scene()
    await host.markPending({ threadId: 'zz', pageKey: PAGE, kind: 'comment' })
    await host.markPending({ threadId: 'aa', pageKey: PAGE, kind: 'comment' })
    expect((await host.listPending(PAGE)).map((e) => e.threadId)).toEqual(['zz', 'aa'])
  })

  it('markPending is idempotent per thread', async () => {
    const { host } = scene()
    await host.markPending({ threadId: 't1', pageKey: PAGE, kind: 'comment' })
    await host.markPending({ threadId: 't1', pageKey: PAGE, kind: 'ask' })
    const pending = await host.listPending(PAGE)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.kind).toBe('ask')
  })

  it('clearPending of an unknown thread is a no-op, not an error', async () => {
    const { host } = scene()
    await expect(host.clearPending(PAGE, 'ghost')).resolves.toBeUndefined()
  })

  it('clearPendingMany removes exactly the listed entries', async () => {
    const { host } = scene()
    await host.markPending({ threadId: 't1', pageKey: PAGE, kind: 'comment' })
    await host.markPending({ threadId: 't2', pageKey: PAGE, kind: 'comment' })
    const [first] = await host.listPending(PAGE)
    await host.clearPendingMany([first!])
    expect((await host.listPending(PAGE)).map((e) => e.threadId)).toEqual(['t2'])
  })

  it('dropPendingThread finds the entry without being told the page', async () => {
    const { host, storage } = scene()
    await host.markPending({ threadId: 't1', pageKey: OTHER, kind: 'comment' })
    await host.dropPendingThread('t1')
    expect(storage.dump()[pendingKey(OTHER, 't1')]).toBeUndefined()
  })

  it('ignores a corrupt record rather than throwing at a host', async () => {
    const { host, kv } = scene()
    await kv.set({ [pendingKey(PAGE, 'bad')]: 'not-an-entry' })
    await host.markPending({ threadId: 'good', pageKey: PAGE, kind: 'comment' })
    expect((await host.listPending(PAGE)).map((e) => e.threadId)).toEqual(['good'])
  })
})

describe('failed', () => {
  it('survives a worker death, which is the whole reason it is not a chip flag', async () => {
    // The chip map is rebuilt from durable state on every refresh: an in-memory failure is
    // erased by the next SPA navigation, and a run that died three times then looks like a run
    // that never happened.
    const { host, revive } = scene()
    await host.markFailed('t1', 'max_attempts')
    expect(await revive().listFailed()).toEqual([{ threadId: 't1', code: 'max_attempts' }])
  })

  it('keeps only the most recent failure per thread, and clears on demand', async () => {
    const { host } = scene()
    await host.markFailed('t1', 'rate_limited')
    await host.markFailed('t1', 'max_attempts')
    expect(await host.listFailed()).toEqual([{ threadId: 't1', code: 'max_attempts' }])
    await host.clearFailed('t1')
    expect(await host.listFailed()).toEqual([])
  })

  it('ignores a corrupt row rather than throwing at a host', async () => {
    const { host, kv } = scene()
    await kv.set({ [failedKey('bad')]: { threadId: 'bad' } })
    await host.markFailed('good', 'timeout')
    expect((await host.listFailed()).map((entry) => entry.threadId)).toEqual(['good'])
  })
})

describe('unread', () => {
  it('marks, lists and clears', async () => {
    const { host } = scene()
    await host.markUnread('t1')
    await host.markUnread('t2')
    expect((await host.listUnread()).sort()).toEqual(['t1', 't2'])
    await host.clearUnread('t1')
    expect(await host.listUnread()).toEqual(['t2'])
  })

  it('round-trips an id containing a colon', async () => {
    const { host } = scene()
    await host.markUnread('a:b:c')
    expect(await host.listUnread()).toEqual(['a:b:c'])
  })
})

describe('forgetThread', () => {
  it('drops everything the range holds about one thread', async () => {
    const { host, storage } = scene()
    await host.markPending({ threadId: 't1', pageKey: PAGE, kind: 'comment' })
    await host.markUnread('t1')
    await host.markFailed('t1', 'max_attempts')
    await host.markPending({ threadId: 't2', pageKey: PAGE, kind: 'comment' })

    await host.forgetThread('t1')

    const keys = Object.keys(storage.dump())
    expect(keys.some((key) => key.includes('t1'))).toBe(false)
    expect(keys.some((key) => key.includes('t2'))).toBe(true)
  })
})
