/**
 * The `exp-spec:host:*` range (SPEC-comment-core §6). The property under test throughout is
 * durability: everything here must survive a worker death, which in these tests is modelled by
 * building a *second* `createHostState` over the same storage.
 */

import { describe, expect, it } from 'vitest'

import { createHostState } from '../src/host-state.ts'
import { failedKey, pendingKey, runIndexKey } from '../src/keys.ts'
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

describe('thread → run index', () => {
  it('records one entry per thread a batch run covers', async () => {
    const { host } = scene()
    await host.indexRun('b:page:abc', ['t1', 't2', 't3'], 'batch')
    const rows = await host.runsForThreads()
    expect(rows.map((row) => row.threadId).sort()).toEqual(['t1', 't2', 't3'])
    expect(rows.every((row) => row.runId === 'b:page:abc' && row.mode === 'batch')).toBe(true)
  })

  it('is what makes a batch run findable — its id is not thread-prefixed', async () => {
    const { host } = scene()
    await host.indexRun('b:page:abc', ['t7'], 'batch')
    const rows = await host.runsForThreads()
    // `cancelByPrefix('c:t7:')` cannot see this; the index can.
    expect(rows[0]!.runId.startsWith('c:t7:')).toBe(false)
    expect(rows[0]!.threadId).toBe('t7')
  })

  it('indexRun with no threads writes nothing', async () => {
    const { host, storage } = scene()
    await host.indexRun('r', [], 'single')
    expect(Object.keys(storage.dump())).toEqual([])
  })

  it('clearRunIndex removes every thread of one run and leaves others', async () => {
    const { host } = scene()
    await host.indexRun('r1', ['t1', 't2'], 'batch')
    await host.indexRun('r2', ['t3'], 'single')
    await host.clearRunIndex('r1')
    expect((await host.runsForThreads()).map((row) => row.threadId)).toEqual(['t3'])
  })

  it('defaults a missing mode to single rather than dropping the row', async () => {
    const { host, kv } = scene()
    await kv.set({ [runIndexKey('t1', 'r1')]: { runId: 'r1' } })
    expect(await host.runsForThreads()).toEqual([{ threadId: 't1', runId: 'r1', mode: 'single' }])
  })

  it('falls back to the key when the value lost its runId', async () => {
    const { host, kv } = scene()
    await kv.set({ [runIndexKey('t1', 'r1')]: { mode: 'batch' } })
    // The key is the authority on the pair, so a value with no runId still yields the row it
    // was written under — what must never happen is losing a live run from the index.
    expect(await host.runsForThreads()).toEqual([{ threadId: 't1', runId: 'r1', mode: 'batch' }])
  })
})

describe('two runs over one thread', () => {
  it('keeps a row per run, so neither can erase the other', async () => {
    // One slot per thread lost the batch row the moment a human reply triggered a single run —
    // and the single run's settle then cleared an index row for a batch that was still live.
    const { host } = scene()
    await host.indexRun('b:page:abc', ['t1', 't2'], 'batch')
    await host.indexRun('c:t1:c9', ['t1'], 'single')
    const rows = (await host.runsForThreads()).filter((row) => row.threadId === 't1')
    expect(rows.map((row) => row.runId).sort()).toEqual(['b:page:abc', 'c:t1:c9'])
    expect(rows.find((row) => row.runId === 'b:page:abc')?.mode).toBe('batch')
  })

  it('clearRunIndex removes one run s rows and leaves the other run s', async () => {
    const { host } = scene()
    await host.indexRun('b:page:abc', ['t1'], 'batch')
    await host.indexRun('c:t1:c9', ['t1'], 'single')
    await host.clearRunIndex('c:t1:c9')
    expect((await host.runsForThreads()).map((row) => row.runId)).toEqual(['b:page:abc'])
  })

  it('clearRunIndexForThread drops every run covering that thread', async () => {
    const { host } = scene()
    await host.indexRun('b:page:abc', ['t1'], 'batch')
    await host.indexRun('c:t1:c9', ['t1'], 'single')
    await host.indexRun('c:t2:c1', ['t2'], 'single')
    await host.clearRunIndexForThread('t1')
    expect((await host.runsForThreads()).map((row) => row.threadId)).toEqual(['t2'])
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
    await host.indexRun('r1', ['t1'], 'single')
    await host.indexRun('b:page:x', ['t1'], 'batch')
    await host.markUnread('t1')
    await host.markFailed('t1', 'max_attempts')
    await host.markPending({ threadId: 't2', pageKey: PAGE, kind: 'comment' })

    await host.forgetThread('t1')

    const keys = Object.keys(storage.dump())
    expect(keys.some((key) => key.includes('t1'))).toBe(false)
    expect(keys.some((key) => key.includes('t2'))).toBe(true)
  })
})
