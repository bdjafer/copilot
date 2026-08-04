/**
 * Subscription management, per-stream `seq` tracking and the client's half of the durable-replay
 * contract (SPEC-swarm §2.3, §2.4, §2.5 rule 2).
 *
 * Three rules from §2.3 are enforced here and nowhere else, because they are the difference
 * between a head that is behind and a head that is *wrong*:
 *
 *  1. **A gap is a bug, not a lag signal.** `seq` is gapless per stream and lag is always
 *     explicit, so an `evt` whose `seq` is more than one past the cursor cannot be "we missed
 *     some". It is raised as an error, the event is **not applied** — applying it would silently
 *     found the projection on a hole — and the stream re-subscribes from `'snapshot'`, which is
 *     the only state the client can still prove.
 *  2. **`lagged` forces a re-snapshot.** Both the retention floor and a backpressure drop arrive
 *     as `lagged{fromSeq, reason}`, and §2.3 says the client MUST re-subscribe with `'snapshot'`.
 *  3. **Resume is from the durable cursor, not from the connection.** After a drop, a stream
 *     re-subscribes `from:<lastSeq>` and the server replays `lastSeq + 1 …` exactly once. A
 *     stream that never completed its first subscription resumes from `'snapshot'` instead —
 *     there is no state for a delta to be applied to.
 *
 * Ref counting exists for one family: `attempt:*` is subscribed on the first `transcript()` or
 * `diff()` handle and released on the last (§6.2). `server` and `fleet` are pinned for the life
 * of the client, and `delegation:*` is acquired by focus. Only `attempt:*` may lag (§2.4, Q12).
 *
 * DOM-free and Node-free.
 */

import type { SwarmError } from '../errors.ts'
import type { SwarmEvent } from '../protocol/events.ts'
import type {
  ClientFrame,
  EvtFrame,
  LagReason,
  LaggedFrame,
  ResFrame,
  ServerFrame,
  SnapFrame,
  StreamFamily,
  StreamName,
} from '../protocol/frames.ts'
import type { SwarmClientInspection } from '../types.ts'

import { SwarmError as SwarmErrorClass } from '../errors.ts'
import { parseStreamName } from '../protocol/codec.ts'
import { BACKPRESSURE, RESUBSCRIBE_ORDER } from '../protocol/constants.ts'
import { SWARM_PROTOCOL, SWARM_PROTOCOL_VERSION } from '../protocol/frames.ts'

const envelope = { p: SWARM_PROTOCOL, v: SWARM_PROTOCOL_VERSION } as const

export interface StreamSnapshotEvent {
  readonly stream: StreamName
  readonly family: StreamFamily
  /** The delegation or attempt id; `null` for `server` and `fleet`. */
  readonly id: string | null
  readonly seq: number
  readonly state: unknown
}

export interface StreamEventDelivery {
  readonly stream: StreamName
  readonly family: StreamFamily
  readonly id: string | null
  readonly seq: number
  readonly ts: number
  readonly event: SwarmEvent
}

export interface StreamsOptions {
  readonly now: () => number
  send(frame: ClientFrame): boolean
  nextRequestId(): number
  onSnapshot(snapshot: StreamSnapshotEvent): void
  onEvent(delivery: StreamEventDelivery): void
  onLagged(info: { stream: StreamName; fromSeq: number; reason: LagReason }): void
  onError(error: SwarmError): void
  /** A field `ConnectionVM.streams` reads has changed. */
  onChange(): void
}

interface StreamEntry {
  readonly stream: StreamName
  readonly family: StreamFamily
  readonly id: string | null
  /** Last `seq` applied. `0` ⇒ nothing yet, which is a legal cursor (§2.3). */
  seq: number
  lagged: boolean
  /** `server`/`fleet` are never released. */
  pinned: boolean
  refs: number
  /** The outstanding `sub` request id, or `null` when the subscription is settled. */
  subId: number | null
  /** A snapshot (or an accepted replay) has been observed, so `seq` is a resumable cursor. */
  ready: boolean
  /** Forced by `lagged`, by a gap, or by §2.5 rule 2's `server-changed`. */
  needsSnapshot: boolean
  unacked: number
  lastAckAtMs: number
  /** Resolvers waiting on the next snapshot — `DiffHandle.refresh()` (§6.2). */
  awaitingSnapshot: (() => void)[]
}

export interface Streams {
  /** Ref-count a stream up; sends `sub` on the first reference. */
  acquire(stream: StreamName): void
  /** Ref-count down; sends `unsub` and forgets the cursor when the last reference goes. */
  release(stream: StreamName): void
  /** `server` and `fleet`: subscribed for the life of the client (§2.5 rule 2). */
  pin(stream: StreamName): void
  /** Re-subscribe from `'snapshot'`, resolving when it lands. */
  resnapshot(stream: StreamName): Promise<void>
  has(stream: StreamName): boolean
  /** `true` when the frame belonged to a subscription and was consumed. */
  handleFrame(frame: ServerFrame): boolean
  /** §2.5 rule 2: attention before transcripts. `force` ⇒ every stream from `'snapshot'` (X14). */
  resubscribeAll(force: boolean): void
  /** The socket is gone: every subscription is un-settled until it is re-sent. */
  onDisconnected(): void
  /** §2.4's "every 128 frames **or 1 s**" — the time half. */
  flushAcks(nowMs: number): void
  view(): readonly { stream: StreamName; seq: number; lagged: boolean }[]
  inspect(): SwarmClientInspection['streams']
  destroy(): void
}

export function createStreams(options: StreamsOptions): Streams {
  const entries = new Map<StreamName, StreamEntry>()
  const bySubId = new Map<number, StreamName>()
  let destroyed = false

  const familyRank = (family: StreamFamily): number => RESUBSCRIBE_ORDER.indexOf(family)

  const ensure = (stream: StreamName): StreamEntry | null => {
    const existing = entries.get(stream)
    if (existing) return existing
    const parsed = parseStreamName(stream)
    if (parsed === null) {
      options.onError(
        new SwarmErrorClass('stream_unknown', `unroutable stream ${stream}`, { retryable: false }),
      )
      return null
    }
    const entry: StreamEntry = {
      stream,
      family: parsed.family,
      id: parsed.id,
      seq: 0,
      lagged: false,
      pinned: false,
      refs: 0,
      subId: null,
      ready: false,
      needsSnapshot: true,
      unacked: 0,
      lastAckAtMs: options.now(),
      awaitingSnapshot: [],
    }
    entries.set(stream, entry)
    return entry
  }

  const sendSub = (entry: StreamEntry): void => {
    const id = options.nextRequestId()
    if (entry.subId !== null) bySubId.delete(entry.subId)
    entry.subId = id
    bySubId.set(id, entry.stream)
    /* Resume from the durable cursor unless there is no state to apply a delta to (§2.3). */
    const from = entry.needsSnapshot || !entry.ready ? ('snapshot' as const) : entry.seq
    const sent = options.send({ ...envelope, k: 'sub', id, stream: entry.stream, from })
    if (!sent) {
      /* Offline: the subscription is re-sent by `resubscribeAll` on the next `hello_ok`. */
      bySubId.delete(id)
      entry.subId = null
    }
  }

  const sendUnsub = (entry: StreamEntry): void => {
    options.send({ ...envelope, k: 'unsub', stream: entry.stream })
  }

  const ack = (entry: StreamEntry, nowMs: number): void => {
    if (entry.unacked === 0 || entry.seq === 0) return
    if (options.send({ ...envelope, k: 'ack', stream: entry.stream, seq: entry.seq })) {
      entry.unacked = 0
      entry.lastAckAtMs = nowMs
    }
  }

  const forceSnapshot = (entry: StreamEntry): void => {
    entry.needsSnapshot = true
    entry.ready = false
    sendSub(entry)
  }

  const settleSnapshotWaiters = (entry: StreamEntry): void => {
    const waiters = entry.awaitingSnapshot
    entry.awaitingSnapshot = []
    for (const resolve of waiters) resolve()
  }

  const handleSnap = (frame: SnapFrame): boolean => {
    const entry = entries.get(frame.stream)
    if (!entry) return false
    if (entry.subId !== null) bySubId.delete(entry.subId)
    entry.subId = null
    entry.seq = frame.seq
    entry.ready = true
    entry.needsSnapshot = false
    entry.lagged = false
    entry.unacked = 0
    entry.lastAckAtMs = options.now()
    options.onSnapshot({
      stream: entry.stream,
      family: entry.family,
      id: entry.id,
      seq: frame.seq,
      state: frame.state,
    })
    settleSnapshotWaiters(entry)
    options.onChange()
    return true
  }

  const handleSubRes = (frame: ResFrame): boolean => {
    const stream = bySubId.get(frame.id)
    if (stream === undefined) return false
    bySubId.delete(frame.id)
    const entry = entries.get(stream)
    if (!entry) return true
    entry.subId = null
    entry.ready = true
    entry.needsSnapshot = false
    entry.lagged = false
    options.onChange()
    return true
  }

  const handleEvt = (frame: EvtFrame): boolean => {
    const entry = entries.get(frame.stream)
    if (!entry) return false
    const expected = entry.seq + 1
    if (frame.seq < expected) {
      /* A re-delivery. Exactly-once is the server's promise, but dropping a duplicate costs
       * nothing and applying one would double-count usage and tool calls. */
      return true
    }
    if (frame.seq > expected) {
      /* Rule 1: a gap is a bug (§2.3). Do not apply, do not guess — re-snapshot. */
      entry.lagged = true
      options.onError(
        new SwarmErrorClass(
          'internal',
          `gap on ${entry.stream}: expected seq ${expected}, received ${frame.seq}`,
          {
            retryable: false,
            details: { stream: entry.stream, expected, received: frame.seq },
          },
        ),
      )
      forceSnapshot(entry)
      options.onChange()
      return true
    }
    entry.seq = frame.seq
    entry.unacked += 1
    options.onEvent({
      stream: entry.stream,
      family: entry.family,
      id: entry.id,
      seq: frame.seq,
      ts: frame.ts,
      event: frame.ev,
    })
    if (entry.unacked >= BACKPRESSURE.ackEveryFrames) ack(entry, options.now())
    options.onChange()
    return true
  }

  const handleLagged = (frame: LaggedFrame): boolean => {
    const entry = entries.get(frame.stream)
    if (!entry) return false
    entry.lagged = true
    options.onLagged({ stream: frame.stream, fromSeq: frame.fromSeq, reason: frame.reason })
    /* §2.3: the client MUST re-subscribe with `'snapshot'`. */
    forceSnapshot(entry)
    options.onChange()
    return true
  }

  return {
    acquire(stream) {
      if (destroyed) return
      const entry = ensure(stream)
      if (!entry) return
      entry.refs += 1
      if (entry.refs === 1 && entry.subId === null && !entry.ready) sendSub(entry)
      options.onChange()
    },

    release(stream) {
      const entry = entries.get(stream)
      if (!entry) return
      entry.refs = Math.max(0, entry.refs - 1)
      if (entry.refs === 0 && !entry.pinned) {
        sendUnsub(entry)
        if (entry.subId !== null) bySubId.delete(entry.subId)
        settleSnapshotWaiters(entry)
        entries.delete(stream)
      }
      options.onChange()
    },

    pin(stream) {
      if (destroyed) return
      const entry = ensure(stream)
      if (!entry) return
      entry.pinned = true
      if (entry.subId === null && !entry.ready) sendSub(entry)
      options.onChange()
    },

    resnapshot(stream) {
      const entry = entries.get(stream)
      if (!entry) return Promise.resolve()
      return new Promise<void>((resolve) => {
        entry.awaitingSnapshot.push(resolve)
        forceSnapshot(entry)
      })
    },

    has(stream) {
      return entries.has(stream)
    },

    handleFrame(frame) {
      switch (frame.k) {
        case 'snap':
          return handleSnap(frame)
        case 'res':
          return handleSubRes(frame)
        case 'evt':
          return handleEvt(frame)
        case 'lagged':
          return handleLagged(frame)
        default:
          return false
      }
    },

    resubscribeAll(force) {
      /* Attention before transcripts (§2.5 rule 2): `server`, `fleet`, `delegation:*`, then
       * `attempt:*`. A head that re-subscribes transcripts first spends its whole backlog budget
       * on the one stream that is allowed to lag and learns last which delegation is asking. */
      const ordered = [...entries.values()].sort(
        (a, b) => familyRank(a.family) - familyRank(b.family),
      )
      for (const entry of ordered) {
        if (force) {
          entry.needsSnapshot = true
          entry.ready = false
        }
        entry.unacked = 0
        sendSub(entry)
      }
      options.onChange()
    },

    onDisconnected() {
      bySubId.clear()
      for (const entry of entries.values()) {
        entry.subId = null
        entry.unacked = 0
      }
      options.onChange()
    },

    flushAcks(nowMs) {
      for (const entry of entries.values()) {
        if (entry.unacked > 0 && nowMs - entry.lastAckAtMs >= BACKPRESSURE.ackEveryMs) {
          ack(entry, nowMs)
        }
      }
    },

    view() {
      return [...entries.values()]
        .sort(
          (a, b) => familyRank(a.family) - familyRank(b.family) || (a.stream < b.stream ? -1 : 1),
        )
        .map((entry) => ({ stream: entry.stream, seq: entry.seq, lagged: entry.lagged }))
    },

    inspect() {
      return [...entries.values()].map((entry) => ({
        stream: entry.stream,
        seq: entry.seq,
        subscribers: entry.pinned ? entry.refs + 1 : entry.refs,
        lagged: entry.lagged,
      }))
    },

    destroy() {
      destroyed = true
      for (const entry of entries.values()) settleSnapshotWaiters(entry)
      entries.clear()
      bySubId.clear()
    },
  }
}
