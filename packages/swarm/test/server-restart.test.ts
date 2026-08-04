/**
 * SPEC-swarm §2.3, §2.5 and §13's crash-resume row: *"A test kills the server mid-turn, restarts
 * it, and asserts a head resuming from its last `seq` receives every pre-crash record exactly once
 * and none twice."*
 *
 * This is the property decision #5 exists for: **connections hold no resumable state**, so the
 * only thing that has to survive a crash is the durable log — and it does, on disk, keyed
 * `(stream, seq)`. Everything here runs against a file-backed `swarm.db` in a `$SWARM_HOME` that
 * outlives the process that wrote it.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { EvtFrame, ServerFrame } from '../src/protocol/frames.ts'
import type { ServerHarness } from './support/server-harness.ts'

import { LEASES } from '../src/domain/constants.ts'
import { sessionLease } from '../src/domain/leases.ts'
import { createSqliteStore } from '../src/server/store.ts'
import {
  createScratchRepo,
  createServerHarness,
  drain,
  openRawSocket,
  specFor,
} from './support/server-harness.ts'

const isEvt = (frame: ServerFrame): frame is EvtFrame => frame.k === 'evt'

let live: ServerHarness | null = null
let home: string | null = null
const repos: { dispose(): void }[] = []

afterEach(async () => {
  await live?.dispose()
  live = null
  if (home !== null) rmSync(home, { recursive: true, force: true })
  home = null
  for (const repo of repos.splice(0)) repo.dispose()
})

const ctx = (key: string) => ({
  actor: { kind: 'user', head: 'test', tokenId: 'tok' } as const,
  tokenId: 'tok',
  idempotencyKey: key,
})

describe('§13 a head resuming after a restart receives every record exactly once', () => {
  it('survives a mid-turn kill and replays from the last `seq` with no gap and no duplicate', async () => {
    const repo = createScratchRepo()
    repos.push(repo)
    home = mkdtempSync(join(tmpdir(), 'swarm-restart-'))
    const dbPath = join(home, 'swarm.db')

    /* ------------------------------------------------------------------- the pre-crash server */
    let harness = await createServerHarness({ repo, home, dbPath })
    live = harness

    const created = await harness.server.engine.dispatch(
      'createDelegation',
      { spec: specFor(repo) },
      ctx('restart-create'),
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await drain(harness)

    const before = await openRawSocket({ port: harness.port(), token: harness.token('first') })
    await before.hello()
    before.send({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'fleet', from: 0 })
    const head = harness.server.engine.store.read((tx) => tx.head('fleet').head)
    expect(head).toBeGreaterThan(0)
    await before.waitFor((frame) => frame.k === 'evt' && frame.seq === head)
    const seenBefore = before.frames.filter(isEvt).map((frame) => frame.seq)
    expect(seenBefore).toEqual(Array.from({ length: head }, (_, i) => i + 1))

    /* The head stops here — a crash, a closed laptop, a killed service worker. It remembers only
     * `(stream, seq)`; §2.3 promises that is enough. */
    const cursor = seenBefore[seenBefore.length - 1]!
    before.close()

    /* ------------------------------------------------------------------------- kill and restart */
    await harness.dispose()
    live = null

    harness = await createServerHarness({ repo, home, dbPath })
    live = harness
    /* The log is the same log: the pre-crash head is still there. */
    expect(harness.server.engine.store.read((tx) => tx.head('fleet').head)).toBe(head)

    /* Something happens after the restart, so the resume has to deliver *new* records too. */
    const second = await harness.server.engine.dispatch(
      'createDelegation',
      { spec: specFor(repo) },
      ctx('restart-create-2'),
    )
    expect(second.ok).toBe(true)
    await drain(harness)
    const afterHead = harness.server.engine.store.read((tx) => tx.head('fleet').head)
    expect(afterHead).toBeGreaterThan(head)

    const after = await openRawSocket({ port: harness.port(), token: harness.token('resumed') })
    await after.hello()
    after.send({ p: 'swarm', v: 1, k: 'sub', id: 1, stream: 'fleet', from: cursor })
    await after.waitFor((frame) => frame.k === 'evt' && frame.seq === afterHead)

    const replayed = after.frames.filter(isEvt).map((frame) => frame.seq)
    /* Exactly once: no gap (§2.3 forbids them) and no duplicate (a replayed mutation is a second
     * side effect wearing a first one's identity). */
    expect(replayed).toEqual(Array.from({ length: afterHead - cursor }, (_, i) => cursor + i + 1))
    expect(new Set(replayed).size).toBe(replayed.length)
    after.close()
  }, 30_000)

  it('a channel left mid-flight by a crash comes back `disconnected`, never still `submitting`', async () => {
    /*
     * `this.live` is memory; the channel record is disk. Nothing moves a channel except executor
     * events, and after a kill there is no executor and no stream — so the durable record went on
     * saying `submitting` (or `accepted`, or `streaming`) about a connection that no process held,
     * and a head reconnecting to the restarted server read "sending…" indefinitely. That is the
     * exact shape of the "did my message land?" spinner §5.5 exists to abolish, and it survived
     * the whole delivery because the crash-resume test above asserts `(stream, seq)` and the
     * journey asserted cursors on `fleet` alone.
     *
     * The rules are the sleep path's, for the same physics: `disconnected` (C12), and an in-flight
     * turn to `unknown` — never `failed`, which asserts a non-delivery swarm cannot observe
     * (V8, Q5).
     */
    const repo = createScratchRepo()
    repos.push(repo)
    home = mkdtempSync(join(tmpdir(), 'swarm-boot-channel-'))
    const dbPath = join(home, 'swarm.db')

    let harness = await createServerHarness({ repo, home, dbPath, listen: false })
    live = harness
    const created = await harness.server.engine.dispatch(
      'createDelegation',
      { spec: specFor(repo) },
      ctx('boot-channel'),
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await drain(harness)

    const id = created.value as string
    const attemptId = harness.server.engine.store.read(
      (tx) => tx.getRecord<{ liveAttempts: string[] }>('delegation', id)!.value.liveAttempts[0],
    )
    expect(attemptId).toBeDefined()
    const channelOf = (h: ServerHarness): string =>
      h.server.engine.store.read(
        (tx) => tx.getRecord<{ channel: string }>('attempt', attemptId!)!.value.channel,
      )

    /*
     * The forced write happens with **no server running**, which is what makes this a crash rather
     * than a shutdown: `close()` walks `this.live` and closes each session, and the `closed` event
     * that produces moves the channel by itself. A record written between the two boots is the
     * only way to express "the process died holding this".
     */
    await harness.dispose()
    live = null

    const between = createSqliteStore(dbPath)
    between.commit((tx) => {
      const stored = tx.getRecord<Record<string, unknown>>('attempt', attemptId!)!
      tx.putRecord('attempt', attemptId!, stored.version, {
        ...stored.value,
        channel: 'submitting',
      })
    })
    expect(
      between.read((tx) => tx.getRecord<{ channel: string }>('attempt', attemptId!)!.value.channel),
    ).toBe('submitting')
    between.close()

    harness = await createServerHarness({ repo, home, dbPath, listen: false })
    live = harness

    expect(channelOf(harness)).toBe('disconnected')
  }, 20_000)

  it('the fencing counter is monotonic across a restart, so an old writer is `stale_fence`', async () => {
    const repo = createScratchRepo()
    repos.push(repo)
    home = mkdtempSync(join(tmpdir(), 'swarm-fence-'))
    const dbPath = join(home, 'swarm.db')

    let harness = await createServerHarness({ repo, home, dbPath, listen: false })
    live = harness
    const first = harness.server.engine.store.commit((tx) =>
      tx.acquireLease(sessionLease('s-1'), 'holder-a', LEASES.sessionTtlMs),
    ).value
    expect(first).not.toBeNull()

    await harness.dispose()
    live = null
    harness = await createServerHarness({ repo, home, dbPath, listen: false })
    live = harness

    const afterRestart = harness.server.engine.store.commit((tx) =>
      tx.acquireLease(sessionLease('s-2'), 'holder-b', LEASES.sessionTtlMs),
    ).value
    expect(afterRestart).not.toBeNull()
    /* One monotonic counter in the durable store (§3.4 rule 6): tokens are globally comparable
     * and survive restart, which is what makes `stale_fence` mean anything after a handover. */
    expect(afterRestart!.token).toBeGreaterThan(first!.token)
  }, 20_000)

  it('the audit trail survives the restart that the retention floor did not spare', async () => {
    const repo = createScratchRepo()
    repos.push(repo)
    home = mkdtempSync(join(tmpdir(), 'swarm-audit-'))
    const dbPath = join(home, 'swarm.db')

    let harness = await createServerHarness({ repo, home, dbPath, listen: false })
    live = harness
    await harness.server.engine.dispatch(
      'createDelegation',
      { spec: specFor(repo) },
      ctx('audit-create'),
    )
    harness.server.engine.store.commit((tx) => {
      for (const row of tx.heads()) tx.advanceFloor(row.stream, row.head)
    })
    const beforeRows = harness.server.engine.store.read((tx) => tx.readAudit(0, 100)).length
    expect(beforeRows).toBeGreaterThan(0)

    await harness.dispose()
    live = null
    harness = await createServerHarness({ repo, home, dbPath, listen: false })
    live = harness
    /* S13/Q20: audit is outside every retention rule, and "outside" includes a restart. */
    expect(harness.server.engine.store.read((tx) => tx.readAudit(0, 100)).length).toBe(beforeRows)
  }, 20_000)

  it('a fresh `cli-token` is written on every start and removed on a clean shutdown (H10)', async () => {
    const repo = createScratchRepo()
    repos.push(repo)
    home = mkdtempSync(join(tmpdir(), 'swarm-clitoken-'))
    const dbPath = join(home, 'swarm.db')

    let harness = await createServerHarness({ repo, home, dbPath })
    live = harness
    const { readFileSync, existsSync } = await import('node:fs')
    const path = join(home, 'cli-token')
    const first = readFileSync(path, 'utf8').trim()
    expect(first.length).toBeGreaterThan(0)

    await harness.dispose()
    live = null
    /* Deleted on clean shutdown: a token file that outlives its server is a credential nobody
     * revoked (§2.1). */
    expect(existsSync(path)).toBe(false)

    harness = await createServerHarness({ repo, home, dbPath })
    live = harness
    const second = readFileSync(path, 'utf8').trim()
    expect(second).not.toBe(first)
  }, 20_000)
})
