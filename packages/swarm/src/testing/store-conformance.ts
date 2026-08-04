/**
 * `storeConformance(factory)` — the durable-log contract as executable cases (§2.3, §3.5, §13).
 *
 * §13 names what it must cover, and each row below is one of them: **write ordering
 * (persist → emit → reply)**, **per-stream head monotonicity**, **idempotency-cache hits
 * returning the original response including the original error**, **retention-floor
 * advancement**, **lease fencing-token monotonicity across restart**, and **audit-row survival
 * across every one of those operations**.
 *
 * It runs against the SQLite store and the in-memory one, which is the only reason
 * `src/log/types.ts` is an interface rather than a description of whatever SQLite happened to do.
 *
 * DOM-free and Node-free.
 */

import type { LogRecord, SwarmStore } from '../log/types.ts'
import type { StreamName } from '../protocol/frames.ts'
import type { Awaitable, ConformanceCase } from './types.ts'

import { assert, assertDeepEqual, assertEqual } from './assert.ts'
import { makeActor, sampleEvent } from './fixtures.ts'

export interface StoreHarness {
  readonly store: SwarmStore
  /**
   * Close and reopen over the **same durable state**. This is what makes "fencing tokens survive
   * restart" a claim about persistence rather than about a counter in a closure.
   */
  reopen(): Awaitable<SwarmStore>
  dispose(): Awaitable<void>
}

const FLEET: StreamName = 'fleet'
const SERVER: StreamName = 'server'
const DELEG: StreamName = 'delegation:d-1'

export function storeConformance(factory: () => Awaitable<StoreHarness>): ConformanceCase[] {
  const cases: ConformanceCase[] = []

  const test = (name: string, run: (h: StoreHarness) => Promise<void>): void => {
    cases.push({
      name: `store: ${name}`,
      run: async () => {
        const harness = await factory()
        try {
          await run(harness)
        } finally {
          await harness.dispose()
        }
      },
    })
  }

  /* ------------------------------------------------------------------ X2 sequence allocation */

  test('seq starts at 1, is gapless, and is per stream', async ({ store }) => {
    store.commit((tx) => {
      tx.appendLog({ stream: FLEET, ev: sampleEvent('fleet.caps'), actor: makeActor() })
      tx.appendLog({ stream: FLEET, ev: sampleEvent('fleet.spend'), actor: makeActor() })
      tx.appendLog({ stream: SERVER, ev: sampleEvent('server.hello'), actor: makeActor() })
    })
    const fleet = store.read((tx) => tx.readLog(FLEET, 0, 10))
    const server = store.read((tx) => tx.readLog(SERVER, 0, 10))
    assertDeepEqual(
      fleet.map((r) => r.seq),
      [1, 2],
      'fleet seq must start at 1 and be gapless',
    )
    assertDeepEqual(
      server.map((r) => r.seq),
      [1],
      'each stream carries its own sequence',
    )
    assertEqual(
      store.read((tx) => tx.head(FLEET).head),
      2,
      'the head is the highest assigned seq',
    )
  })

  test('an unwritten stream reads as head 0, floor 0 — never as an error', async ({ store }) => {
    const head = store.read((tx) => tx.head('attempt:never-written'))
    assertEqual(head.head, 0, 'an empty stream has head 0')
    assertEqual(head.floor, 0, 'an empty stream has floor 0')
  })

  /* ------------------------------------------------------- §3.5 persist → emit → reply order */

  test('persist → emit → reply: the log is durable before a listener sees it', async ({
    store,
  }) => {
    let observedInsideListener: readonly LogRecord[] = []
    let listenerRan = false
    const off = store.onCommit((result) => {
      listenerRan = true
      /* Read through a *fresh* transaction: if the write were not committed, this would be empty. */
      observedInsideListener = store.read((tx) => tx.readLog(FLEET, 0, 10))
      assertEqual(result.emitted.length, 1, 'the commit result carries what it wrote')
    })
    store.commit((tx) => {
      tx.appendLog({ stream: FLEET, ev: sampleEvent('fleet.caps'), actor: makeActor() })
    })
    off()
    assert(listenerRan, 'onCommit listeners run before commit() returns, so a reply follows them')
    assertEqual(observedInsideListener.length, 1, 'no head ever sees what the disk does not have')
  })

  test('a throw inside a commit rolls the whole transaction back', async ({ store }) => {
    let threw = false
    try {
      store.commit((tx) => {
        tx.appendLog({ stream: FLEET, ev: sampleEvent('fleet.caps'), actor: makeActor() })
        tx.putRecord('delegation', 'd-1', 1, { id: 'd-1' })
        throw new Error('intent failed halfway')
      })
    } catch {
      threw = true
    }
    assert(threw, 'a failing intent must propagate, not be swallowed')
    assertEqual(
      store.read((tx) => tx.head(FLEET).head),
      0,
      'a rolled-back append leaves no seq',
    )
    assertEqual(
      store.read((tx) => tx.getRecord('delegation', 'd-1')),
      null,
      'a partially applied intent is the one outcome the single-writer log cannot represent',
    )
  })

  test('a throwing onCommit listener breaks neither the commit nor its peers', async ({
    store,
  }) => {
    let second = 0
    const offA = store.onCommit(() => {
      throw new Error('faulty subscriber')
    })
    const offB = store.onCommit(() => {
      second++
    })
    store.commit((tx) => {
      tx.appendLog({ stream: FLEET, ev: sampleEvent('fleet.caps'), actor: makeActor() })
    })
    offA()
    offB()
    assertEqual(second, 1, 'a faulty subscriber must not silence its peers')
    assertEqual(
      store.read((tx) => tx.head(FLEET).head),
      1,
      'nor undo a committed write',
    )
  })

  /* ------------------------------------------------------------------------ §3.1 records */

  test('records round-trip by (kind, id) and upsert by version', async ({ store }) => {
    store.commit((tx) => tx.putRecord('delegation', 'd-1', 1, { id: 'd-1', title: 'first' }))
    store.commit((tx) => tx.putRecord('delegation', 'd-1', 2, { id: 'd-1', title: 'second' }))
    const record = store.read((tx) => tx.getRecord<{ title: string }>('delegation', 'd-1'))
    assert(record !== null, 'a written record must read back')
    assertEqual(record.version, 2, 'putRecord is an upsert keyed by (kind, id)')
    assertEqual(record.value.title, 'second', 'the later write wins')
    assertEqual(
      store.read((tx) => tx.listRecords('delegation').length),
      1,
      'an upsert must not add a second row',
    )
  })

  /* ------------------------------------------------------------------- §2.5 idempotency */

  test('an idempotency hit returns the ORIGINAL response, error included', async ({ store }) => {
    const original = {
      ok: false,
      error: { code: 'workspace_dirty', message: 'uncommitted changes' },
    }
    store.commit((tx) => tx.putIdempotent('tok-1', 'idem-1', original))
    store.commit((tx) => tx.putIdempotent('tok-1', 'idem-1', { ok: true, value: 'd-2' }))
    const entry = store.read((tx) => tx.getIdempotent('tok-1', 'idem-1'))
    assert(entry !== null, 'the cache must hit for the same (tokenId, key)')
    assertDeepEqual(
      entry.response,
      original,
      'a retry that re-executes and succeeds is a duplicate side effect wearing an ok (§2.5 rule 3)',
    )
  })

  test('the idempotency cache is scoped to (tokenId, key), not to key alone', async ({ store }) => {
    store.commit((tx) => tx.putIdempotent('tok-1', 'shared', { ok: true, value: 'a' }))
    assertEqual(
      store.read((tx) => tx.getIdempotent('tok-2', 'shared')),
      null,
      'another token must not read the first one’s response',
    )
  })

  /* ------------------------------------------------------------ §3.4 leases and fencing */

  test('a lease is refused to a second holder and granted after expiry with a HIGHER token', async ({
    store,
  }) => {
    const first = store.commit((tx) => tx.acquireLease('session:s-1', 'holder-a', 50)).value
    assert(first !== null, 'an unheld lease must be grantable')
    const contended = store.commit((tx) => tx.acquireLease('session:s-1', 'holder-b', 50)).value
    assertEqual(contended, null, 'a held lease is refused to a second writer (lease_held)')
    const reacquired = store.commit((tx) => tx.acquireLease('session:s-1', 'holder-a', 50)).value
    assertEqual(
      reacquired?.token,
      first.token,
      'an idempotent re-acquire keeps the fence the holder is mid-call with',
    )
    store.commit((tx) => tx.releaseLease('session:s-1', 'holder-a'))
    const stolen = store.commit((tx) => tx.acquireLease('session:s-1', 'holder-b', 50)).value
    assert(stolen !== null, 'a released lease must be grantable')
    assert(
      stolen.token > first.token,
      'every acquisition takes a higher fencing token, so the new holder always outranks the old',
    )
  })

  test('fencing tokens are monotonic ACROSS RESTART', async (harness) => {
    const before = harness.store.commit((tx) => tx.acquireLease('home:h-1', 'a', 10)).value
    assert(before !== null, 'the first acquisition must succeed')
    harness.store.close()
    const reopened = await harness.reopen()
    const after = reopened.commit((tx) => tx.acquireLease('worktree:w-1', 'b', 10)).value
    assert(after !== null, 'the reopened store must grant a free lease')
    assert(
      after.token > before.token,
      'the counter is durable, so a lease taken after a crash outranks the one the crash was holding',
    )
  })

  /* --------------------------------------------------------------- §2.3 retention floor */

  test('advanceFloor raises the floor, reclaims below it, and never moves the head', async ({
    store,
  }) => {
    store.commit((tx) => {
      for (let i = 0; i < 5; i++) {
        tx.appendLog({ stream: DELEG, ev: sampleEvent('deleg.channel'), actor: makeActor() })
      }
    })
    const removed = store.commit((tx) => tx.advanceFloor(DELEG, 3)).value
    assertEqual(removed, 3, 'rows at or below the new floor are reclaimed')
    const head = store.read((tx) => tx.head(DELEG))
    assertEqual(head.head, 5, 'retention never rewinds the head')
    assertEqual(head.floor, 3, 'the floor is what a resume is compared against')
    assertDeepEqual(
      store.read((tx) => tx.readLog(DELEG, 0, 10)).map((r) => r.seq),
      [4, 5],
      'what survives is exactly the replayable window',
    )
  })

  test('advanceFloor is monotonic and clamped to the head', async ({ store }) => {
    store.commit((tx) => {
      tx.appendLog({ stream: DELEG, ev: sampleEvent('deleg.channel'), actor: makeActor() })
      tx.appendLog({ stream: DELEG, ev: sampleEvent('deleg.channel'), actor: makeActor() })
    })
    store.commit((tx) => tx.advanceFloor(DELEG, 2))
    store.commit((tx) => tx.advanceFloor(DELEG, 1))
    assertEqual(
      store.read((tx) => tx.head(DELEG).floor),
      2,
      'a floor never goes backwards',
    )
    store.commit((tx) => tx.advanceFloor(DELEG, 99))
    assertEqual(
      store.read((tx) => tx.head(DELEG).floor),
      2,
      'a floor above the head would strand every future cursor',
    )
  })

  test('seq is never reused after reclamation', async ({ store }) => {
    store.commit((tx) => {
      tx.appendLog({ stream: FLEET, ev: sampleEvent('fleet.caps'), actor: makeActor() })
      tx.appendLog({ stream: FLEET, ev: sampleEvent('fleet.caps'), actor: makeActor() })
    })
    store.commit((tx) => tx.advanceFloor(FLEET, 2))
    const next = store.commit((tx) =>
      tx.appendLog({ stream: FLEET, ev: sampleEvent('fleet.caps'), actor: makeActor() }),
    ).value
    assertEqual(next.seq, 3, 'a reclaimed seq is gone, not free — a gap must never be observable')
  })

  /* ------------------------------------------------------------ §2.3 snapshot atomicity */

  test('snapshot reports the head it materialized at', async ({ store }) => {
    store.commit((tx) => {
      tx.appendLog({ stream: FLEET, ev: sampleEvent('fleet.caps'), actor: makeActor() })
      tx.putRecord('delegation', 'd-1', 1, { id: 'd-1' })
    })
    const snap = store.snapshot(FLEET, (tx) => tx.listRecords('delegation').map((r) => r.id))
    assertEqual(snap.seq, 1, 'the snapshot cursor is the stream head at materialization time')
    assertDeepEqual(snap.state, ['d-1'], 'the state is read in the same transaction as the cursor')
  })

  /* --------------------------------------------------------- S13/Q20 audit is exempt */

  test('audit rows survive floor advancement, stream deletion and record deletion', async ({
    store,
  }) => {
    store.commit((tx) => {
      tx.appendLog({ stream: DELEG, ev: sampleEvent('deleg.channel'), actor: makeActor() })
      tx.putRecord('delegation', 'd-1', 1, { id: 'd-1' })
      tx.appendAudit({
        intent: 'createDelegation',
        actor: makeActor(),
        delegationId: 'd-1',
        effective: { model: 'claude-opus-5', reasoningEffort: 'medium' },
        result: { ok: true },
        correlation: 'idem-1',
      })
    })
    store.commit((tx) => tx.advanceFloor(DELEG, 1))
    store.commit((tx) => tx.deleteStream(DELEG))
    store.commit((tx) => {
      tx.deleteRecord('delegation', 'd-1')
      /* A purge appends an audit row of its own, so what was removed outlives its removal. */
      tx.appendAudit({
        intent: 'purge',
        actor: { kind: 'server', reason: 'gc' },
        delegationId: 'd-1',
      })
    })
    const audit = store.read((tx) => tx.readAudit(0, 100))
    assertEqual(audit.length, 2, 'audit rows are exempt from every retention rule (S13, Q20)')
    assertEqual(audit[0]!.intent, 'createDelegation', 'the original intent survives its delegation')
    assertEqual(audit[1]!.intent, 'purge', 'and the purge that removed it is itself recorded')
    assertDeepEqual(
      audit[0]!.effective,
      { model: 'claude-opus-5', reasoningEffort: 'medium' },
      'S13 answers "with what effective config" — the field must round-trip',
    )
  })

  test('audit rows survive a restart and keep their order', async (harness) => {
    harness.store.commit((tx) => {
      tx.appendAudit({ intent: 'createDelegation', actor: makeActor() })
      tx.appendAudit({ intent: 'sendTurn', actor: makeActor() })
    })
    harness.store.close()
    const reopened = await harness.reopen()
    const audit = reopened.read((tx) => tx.readAudit(0, 100))
    assertDeepEqual(
      audit.map((r) => r.intent),
      ['createDelegation', 'sendTurn'],
      'the audit trail answers questions about work that landed months ago',
    )
  })

  /* -------------------------------------------------------------------- durability */

  test('log records survive a restart with their stream, seq and payload intact', async (harness) => {
    harness.store.commit((tx) => {
      tx.appendLog({
        stream: DELEG,
        ev: sampleEvent('deleg.turn_delivery'),
        actor: makeActor(),
        delegationId: 'd-1',
        turnId: 't-1',
        correlationId: 'idem-1',
      })
    })
    harness.store.close()
    const reopened = await harness.reopen()
    const [record] = reopened.read((tx) => tx.readLog(DELEG, 0, 10))
    assert(record !== undefined, 'a committed record must survive the process that wrote it')
    assertEqual(record.seq, 1, 'seq survives')
    assertEqual(record.turnId, 't-1', 'the turn correlation survives')
    assertEqual(record.correlationId, 'idem-1', 'the idempotency key survives')
    assertEqual(record.ev.k, 'deleg.turn_delivery', 'the event kind survives')
    assertDeepEqual(
      record.ev,
      sampleEvent('deleg.turn_delivery'),
      'the payload round-trips byte-identically — replay is exact (§2.4)',
    )
  })

  return cases
}
