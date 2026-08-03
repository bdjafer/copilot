/**
 * SPEC-comment-core §6's key-range table, as executable assertions. The binding claim is that
 * the three ranges are disjoint *and* that each store's `watch` filter never sees the others.
 */

import { createKeyValueRunStore } from '@astrale-os/browser-copilot'
import { createKeyValueStore } from '@astrale-os/comment-core'
import { createKeyValueCursor } from '@astrale-os/comment-core/headless'
import { describe, expect, it } from 'vitest'

import {
  batchRunId,
  batchToken,
  COMMENT_NS,
  CURSOR_DISPATCH,
  FAILED_PREFIX,
  hashIds,
  HOST_NS,
  idFromKey,
  LEGACY_SETTINGS_KEY,
  parseRunIndexKey,
  pendingKey,
  pendingPagePrefix,
  PENDING_PREFIX,
  RUN_INDEX_PREFIX,
  RUN_NS,
  runIndexKey,
  runIndexThreadPrefix,
  SETTINGS_KEY,
  singleRunId,
  threadRunPrefix,
  UNREAD_PREFIX,
  unreadKey,
} from '../src/keys.ts'
import { createStorageKv } from '../src/kv.ts'
import { createFakeStorage } from './support/fake-chrome.ts'

describe('§6 key ranges', () => {
  it('the three owners write into three disjoint prefixes', async () => {
    const storage = createFakeStorage()
    const kv = createStorageKv(storage)

    const store = createKeyValueStore(kv, { namespace: COMMENT_NS })
    const runs = createKeyValueRunStore(kv, { namespace: RUN_NS })
    const cursor = createKeyValueCursor(kv, { namespace: HOST_NS, id: CURSOR_DISPATCH })

    await store.putThread({
      id: 't1',
      v: 1,
      pageKey: 'https://example.com/a',
      kind: 'comment',
      anchor: {
        mode: 'element',
        selectors: [],
        fingerprint: { tag: 'p', stableClasses: [], attrs: {}, textDigest: '' },
      },
      capture: {
        outerHTML: '',
        text: '',
        cssPath: 'p',
        page: { url: '', title: '' },
        capturedAt: '',
      },
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
    await runs.put({
      id: 'c:t1:c1',
      state: 'queued',
      input: 'hi',
      attempts: 0,
      heartbeat: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await cursor.save({ lastSeenAt: 'x', seen: [] })
    await kv.set({ [pendingKey('https://example.com/a', 't1')]: { threadId: 't1' } })

    const keys = Object.keys(storage.dump())
    const commentKeys = keys.filter(
      (k) => k.startsWith('exp-spec:t:') || k.startsWith('exp-spec:c:'),
    )
    const runKeys = keys.filter((k) => k.startsWith('runs:'))
    const hostKeys = keys.filter((k) => k.startsWith('exp-spec:host:'))

    expect(commentKeys.length).toBeGreaterThan(0)
    expect(runKeys.length).toBeGreaterThan(0)
    expect(hostKeys.length).toBe(2)
    expect(commentKeys.length + runKeys.length + hostKeys.length).toBe(keys.length)
  })

  it('the host range is inside exp-spec: but outside the store watch filter', async () => {
    // This is the whole reason `createKeyValueStore` filters on `{ns}:t:`/`{ns}:c:` and not on
    // the bare `{ns}:`. A pending-set write must not wake a thread re-read in every tab.
    const storage = createFakeStorage()
    const kv = createStorageKv(storage)
    const store = createKeyValueStore(kv, { namespace: COMMENT_NS })

    let notified = 0
    store.subscribe('https://example.com/a', () => notified++)

    await kv.set({ [pendingKey('https://example.com/a', 't1')]: { threadId: 't1' } })
    await kv.set({ [runIndexKey('t1', 'c:t1:c1')]: { runId: 'c:t1:c1' } })
    await kv.set({ [unreadKey('t1')]: { threadId: 't1' } })
    expect(notified).toBe(0)

    await kv.set({ 'exp-spec:c:t1:c1': { id: 'c1' } })
    expect(notified).toBe(1)
  })

  it('URL-encodes every id component so a `:` in an id cannot split a key', () => {
    // `r:${runId}` idempotency keys contain colons by construction (SPEC-comment-core §7.3).
    const key = pendingKey('https://example.com/a?x=1', 'r:c:t1:c1')
    expect(idFromKey(key)).toBe('r:c:t1:c1')
    expect(key.startsWith(pendingPagePrefix('https://example.com/a?x=1'))).toBe(true)
  })

  it('idFromKey round-trips through unreadKey', () => {
    for (const id of ['t1', 'a:b', 'ünïcode', 'with space']) {
      expect(idFromKey(unreadKey(id))).toBe(id)
    }
  })

  it('the run index is keyed on (thread, run), and both halves survive a colon', () => {
    // One slot per thread lost a live run whenever a second one covered the same thread — a
    // human reply during a batch review — and let the first run's settle clear the second's row.
    for (const threadId of ['t1', 'a:b', 'ünïcode', 'with space']) {
      for (const runId of ['c:t1:c9', 'b:https://x/y:abc']) {
        expect(parseRunIndexKey(runIndexKey(threadId, runId))).toEqual({ threadId, runId })
      }
    }
    expect(runIndexKey('t1', 'r1')).not.toBe(runIndexKey('t1', 'r2'))
    expect(runIndexKey('t1', 'r1').startsWith(runIndexThreadPrefix('t1'))).toBe(true)
    expect(runIndexKey('t1x', 'r1').startsWith(runIndexThreadPrefix('t1'))).toBe(false)
  })
})

describe('settings live in the host range, not a fourth one', () => {
  it('is under exp-spec:host:, so §6 s three namespaces stay exhaustive', () => {
    expect(SETTINGS_KEY.startsWith(`${HOST_NS}:`)).toBe(true)
    // …and it collides with none of the range's per-record prefixes.
    for (const prefix of [PENDING_PREFIX, RUN_INDEX_PREFIX, UNREAD_PREFIX, FAILED_PREFIX]) {
      expect(SETTINGS_KEY.startsWith(prefix)).toBe(false)
    }
  })

  it('the old top-level key is still readable, so a profile does not reset itself', () => {
    expect(LEGACY_SETTINGS_KEY).toBe('exp-spec:settings')
    expect(LEGACY_SETTINGS_KEY).not.toBe(SETTINGS_KEY)
  })
})

describe('run ids', () => {
  it('single run ids are thread-prefixed so cancelByPrefix is a prefix operation', () => {
    const id = singleRunId('t1', 'c9')
    expect(id).toBe('c:t1:c9')
    expect(id.startsWith(threadRunPrefix('t1'))).toBe(true)
    // Keying on the comment id alone would make cancelByPrefix a permanent no-op.
    expect(singleRunId('t2', 'c9').startsWith(threadRunPrefix('t1'))).toBe(false)
  })

  it('batch run ids are content-addressed and order-insensitive', () => {
    const a = batchRunId('https://x/y', ['t1', 't2', 't3'])
    const b = batchRunId('https://x/y', ['t3', 't1', 't2'])
    expect(a).toBe(b)
    expect(a).not.toBe(batchRunId('https://x/y', ['t1', 't2']))
    expect(a.startsWith('b:https://x/y:')).toBe(true)
  })

  it('hashIds distinguishes a concatenation collision', () => {
    // Without the separator byte, ['ab','c'] and ['a','bc'] would hash identically.
    expect(hashIds(['ab', 'c'])).not.toBe(hashIds(['a', 'bc']))
  })

  it('a batch run id moves when a thread gets a new tip comment', () => {
    // Content-addressing over the thread ids ALONE made a thread set reviewable exactly once:
    // the second Send deduped against the first run's terminal record, cleared pending and
    // reported success without running anything.
    const before = batchRunId('p', [batchToken('t1', 'c1'), batchToken('t2', 'c2')])
    const afterReply = batchRunId('p', [batchToken('t1', 'c9'), batchToken('t2', 'c2')])
    expect(afterReply).not.toBe(before)
    // …and a replay of the same submit is still the same run.
    expect(batchRunId('p', [batchToken('t2', 'c2'), batchToken('t1', 'c1')])).toBe(before)
  })

  it('batchToken keeps "no comments" distinct from every possible comment id', () => {
    // The token is hashed, so an ambiguity here would be an undetectable run-id collision.
    expect(batchToken('t1')).not.toBe(batchToken('t1', ''))
    expect(batchToken('t1')).not.toBe(batchToken('t1', 'c1'))
    expect(batchToken('t1', 'c1')).not.toBe(batchToken('t1c', '1'))
  })

  it('a batch run id is not matched by any thread prefix', () => {
    expect(batchRunId('p', ['t1']).startsWith(threadRunPrefix('t1'))).toBe(false)
  })
})
