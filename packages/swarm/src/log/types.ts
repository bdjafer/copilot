/**
 * The durable log and store contract (SPEC-swarm §2.3, §3.5).
 *
 * **One append-only table, one writer** (§3.5). Two properties are structural here rather than
 * documented, because both are the kind of thing that is true in review and false under load:
 *
 *  - **`seq` is allocated inside the same transaction that persists the record, before any
 *    acknowledgement** (X2). `appendLog` is only reachable from a write transaction, and it is
 *    the only thing that can move a stream head, so a gapless per-stream sequence is not a
 *    convention the writer follows — it is the only sequence available.
 *  - **persist → emit → reply** (§3.5): `commit()` returns the records it wrote *after* the
 *    transaction has committed, and `onCommit` listeners run before `commit()` returns. A caller
 *    that replies `res` after `commit()` therefore replies after the disk and after the fan-out,
 *    in that order, without having to remember to.
 *
 * The interface is Node-free on purpose: `./server` implements it over `node:sqlite`, `./testing`
 * implements it in memory, and `storeConformance()` runs the same suite against both. Nothing in
 * this file may import `node:*`, or the client entry stops being loadable in a service worker.
 */

import type { SwarmEvent } from '../protocol/events.ts'
import type { StreamName } from '../protocol/frames.ts'
import type {
  ActorRef,
  DelegationId,
  AttemptId,
  Lease,
  LeaseKey,
  TurnId,
  Unsubscribe,
} from '../types.ts'

/** §3.5. `mono` is monotonic ms since boot (X10) — the other half of the sleep/stall signature. */
export interface LogRecord {
  /** Per-stream, gapless, assigned in-transaction. Starts at 1; never reused, never sparse. */
  readonly seq: number
  readonly stream: StreamName
  readonly ts: number
  readonly mono: number
  readonly ev: SwarmEvent
  readonly actor: ActorRef
  readonly delegationId?: DelegationId
  readonly attemptId?: AttemptId
  readonly turnId?: TurnId
  /** Originating intent / executor event id. */
  readonly causationId?: string
  /** Idempotency key of the originating intent. */
  readonly correlationId?: string
}

/** What a writer hands `appendLog`; `seq`, `ts` and `mono` are the store's to assign. */
export interface LogAppend {
  readonly stream: StreamName
  readonly ev: SwarmEvent
  readonly actor: ActorRef
  readonly delegationId?: DelegationId
  readonly attemptId?: AttemptId
  readonly turnId?: TurnId
  readonly causationId?: string
  readonly correlationId?: string
  /** Override the store clock — tests only; production leaves it undefined. */
  readonly ts?: number
}

export interface StreamHeadRow {
  readonly stream: StreamName
  /** Highest assigned `seq`; 0 for a stream nothing has been written to. */
  readonly head: number
  /**
   * The lowest cursor still honoured. `sub{from:n}` with `n < floor` yields `lagged`; records
   * with `seq <= floor` may have been reclaimed.
   */
  readonly floor: number
}

/** The kinds swarm writes today. Deliberately not a closed union — §3.5's DDL keeps `kind` free. */
export type RecordKind = string

export const RECORD_KINDS = [
  'delegation',
  'attempt',
  'turn',
  'verification',
  'confirmation',
] as const

export interface StoredRecord<T = unknown> {
  readonly kind: RecordKind
  readonly id: string
  readonly version: number
  /**
   * An **unchecked** cast at the storage boundary, exactly as any JSON store: the writer owns
   * `recordVersion` on the value and is responsible for narrowing on read.
   */
  readonly value: T
}

export interface IdempotentEntry {
  readonly tokenId: string
  readonly key: string
  /**
   * The original response — **including the original error** (§13). A retry that re-executes and
   * succeeds where the first attempt failed is a duplicate side effect wearing an `ok`.
   */
  readonly response: unknown
  readonly createdAt: number
}

/** §3.5 `audit` — outside every retention rule (S13, Q20). */
export interface AuditAppend {
  readonly intent: string
  readonly actor: ActorRef
  readonly delegationId?: DelegationId
  readonly attemptId?: AttemptId
  readonly turnId?: TurnId
  /** The effective config the intent ran with — the half of S13 that answers "with what". */
  readonly effective?: unknown
  readonly result?: unknown
  readonly correlation?: string
  readonly ts?: number
}

export interface AuditRow extends AuditAppend {
  readonly id: number
  readonly ts: number
  readonly mono: number
}

export interface ReadTx {
  head(stream: StreamName): StreamHeadRow
  heads(): readonly StreamHeadRow[]
  /** Records with `seq > fromExclusive`, ascending, at most `limit`. */
  readLog(stream: StreamName, fromExclusive: number, limit: number): readonly LogRecord[]
  getRecord<T = unknown>(kind: RecordKind, id: string): StoredRecord<T> | null
  listRecords<T = unknown>(kind: RecordKind): readonly StoredRecord<T>[]
  getIdempotent(tokenId: string, key: string): IdempotentEntry | null
  getLease(key: LeaseKey): Lease | null
  listLeases(): readonly Lease[]
  readAudit(fromIdExclusive: number, limit: number): readonly AuditRow[]
  counter(name: string): number
}

export interface WriteTx extends ReadTx {
  /** Allocates the next `seq` for the stream and bumps its head, in this transaction. */
  appendLog(entry: LogAppend): LogRecord
  putRecord<T>(kind: RecordKind, id: string, version: number, value: T): StoredRecord<T>
  deleteRecord(kind: RecordKind, id: string): boolean
  appendAudit(entry: AuditAppend): AuditRow
  putIdempotent(tokenId: string, key: string, response: unknown): IdempotentEntry
  /**
   * Acquire or steal a lease, taking the next fencing token from the single monotonic counter.
   * Returns `null` when `key` is held by a different, unexpired holder — the caller raises
   * `lease_held` rather than the store throwing, because contention is an expected outcome.
   */
  acquireLease(key: LeaseKey, holder: string, ttlMs: number): Lease | null
  renewLease(key: LeaseKey, holder: string, ttlMs: number): Lease | null
  releaseLease(key: LeaseKey, holder: string): boolean
  /** The monotonic fencing counter (§3.4 rule 6) — globally comparable, survives restart. */
  nextFenceToken(): number
  bumpCounter(name: string, by: number): number
  /**
   * Retention (§2.3): raise a stream's floor and reclaim `seq <= floor`. Returns the number of
   * log rows removed. **Never touches `audit`** (S13, Q20) — GC may delete worktrees,
   * transcripts, artifacts and `attempt:*` log rows, and MUST NOT delete an audit row.
   */
  advanceFloor(stream: StreamName, floor: number): number
  /**
   * Drop a stream entirely (a purge). The caller MUST append an audit row describing the purge,
   * so the record of what was removed outlives what was removed (§3.5).
   */
  deleteStream(stream: StreamName): number
}

export interface CommitResult<T> {
  readonly value: T
  /** Everything `appendLog` produced, in write order — already durable when this is readable. */
  readonly emitted: readonly LogRecord[]
  readonly audited: readonly AuditRow[]
}

export interface Snapshot<T> {
  /** The head at the moment `state` was materialized; the next `evt` a subscriber sees is +1. */
  readonly seq: number
  readonly state: T
}

export interface SwarmStore {
  readonly schemaVersion: number
  /**
   * One `BEGIN IMMEDIATE`: record mutation + log rows + audit row + head bump. An intent that
   * returns `ok` is durable; no head ever sees what the disk does not have (§3.5).
   *
   * A throw inside `fn` rolls the whole transaction back and propagates — a partially applied
   * intent is the one outcome the single-writer log cannot represent.
   */
  commit<T>(fn: (tx: WriteTx) => T): CommitResult<T>
  read<T>(fn: (tx: ReadTx) => T): T
  /**
   * Snapshot and cursor read in **one** transaction (§2.3), so no event is both in the snapshot
   * and re-delivered after it.
   */
  snapshot<T>(stream: StreamName, materialize: (tx: ReadTx) => T): Snapshot<T>
  /**
   * Fan-out hook. Listeners run **after** the commit and **before** `commit()` returns, which is
   * what makes "persist → emit → reply" the only possible order for a caller that replies with
   * the return value.
   */
  onCommit(listener: (result: CommitResult<unknown>) => void): Unsubscribe
  close(): void
}

export interface SwarmStoreOptions {
  /** Wall clock; defaults to `Date.now`. */
  readonly now?: () => number
  /** Monotonic clock in ms; defaults to `performance.now`. */
  readonly mono?: () => number
}
