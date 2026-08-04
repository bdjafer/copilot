/**
 * The durable store over `node:sqlite` (SPEC-swarm §3.5, decision log #12).
 *
 * `node:sqlite` and not an ORM, LevelDB or JSONL: R8 forbids extra runtime requirements, and the
 * atomicity swarm actually needs is one sentence — *record mutation + log rows + audit row + head
 * bump in one transaction, before the ack* — which is one `BEGIN IMMEDIATE`. A JSONL log cannot
 * provide it without reimplementing a WAL.
 *
 * Three properties this file is responsible for, all asserted by `storeConformance()`:
 *
 *  1. **`seq` is allocated in-transaction, gapless, per stream** (X2). `PRIMARY KEY(stream, seq)`
 *     makes a duplicate unwritable, and `BEGIN IMMEDIATE` takes the write lock before the head is
 *     read, so two writers cannot both read the same head and both append.
 *  2. **persist → emit → reply.** `commit()` runs the transaction to completion, *then* fans out
 *     to `onCommit` listeners, *then* returns. A caller replying with the return value replies
 *     last, by construction rather than by discipline.
 *  3. **audit rows are never deleted** — not by `advanceFloor`, not by `deleteStream`, not by
 *     anything here (S13, Q20). A purge appends an audit row of its own, so the record of what
 *     was removed outlives what was removed.
 *
 * Node ≥ 24 (`node:sqlite`), server-only.
 */

import { DatabaseSync } from 'node:sqlite'

import type {
  AuditAppend,
  AuditRow,
  CommitResult,
  IdempotentEntry,
  LogAppend,
  LogRecord,
  ReadTx,
  RecordKind,
  Snapshot,
  StoredRecord,
  StreamHeadRow,
  SwarmStore,
  SwarmStoreOptions,
  WriteTx,
} from '../log/types.ts'
import type { StreamName } from '../protocol/frames.ts'
import type { ActorRef, Lease, LeaseKey, Unsubscribe } from '../types.ts'

import { DDL, FENCE_COUNTER, PRAGMAS, SCHEMA_VERSION } from '../log/ddl.ts'

export interface SqliteStoreOptions extends SwarmStoreOptions {
  /** Receives a throw from an `onCommit` listener. The commit itself is already durable. */
  readonly onListenerError?: (error: unknown) => void
}

interface LogRow {
  stream: string
  seq: number
  ts: number
  mono: number
  kind: string
  delegation_id: string | null
  attempt_id: string | null
  turn_id: string | null
  actor: string
  causation: string | null
  correlation: string | null
  payload: string
}

interface AuditDbRow {
  id: number
  ts: number
  mono: number
  intent: string
  actor: string
  delegation_id: string | null
  attempt_id: string | null
  turn_id: string | null
  effective: string | null
  result: string | null
  correlation: string | null
}

const nullable = (value: string | undefined): string | null => value ?? null

/**
 * `':memory:'` is a legitimate path and is what the conformance suite runs against for the
 * cases that do not need a restart; the disk path is what `swarm serve` opens.
 */
export function createSqliteStore(path: string, options: SqliteStoreOptions = {}): SwarmStore {
  const db = new DatabaseSync(path)
  const now = options.now ?? (() => Date.now())
  const mono = options.mono ?? (() => performance.now())

  for (const pragma of PRAGMAS) db.exec(pragma)
  for (const statement of DDL) db.exec(statement)

  const versionRow = db.prepare('SELECT v FROM schema_version LIMIT 1').get() as
    | { v: number }
    | undefined
  if (versionRow === undefined) {
    db.prepare('INSERT INTO schema_version (v) VALUES (?)').run(SCHEMA_VERSION)
  } else if (versionRow.v !== SCHEMA_VERSION) {
    db.close()
    throw new Error(
      `swarm store at ${path} has schema version ${versionRow.v}, expected ${SCHEMA_VERSION}`,
    )
  }

  const q = {
    head: db.prepare('SELECT stream, head, floor FROM stream_head WHERE stream = ?'),
    heads: db.prepare('SELECT stream, head, floor FROM stream_head ORDER BY stream'),
    upsertHead: db.prepare(
      `INSERT INTO stream_head (stream, head, floor) VALUES (?, ?, ?)
       ON CONFLICT(stream) DO UPDATE SET head = excluded.head, floor = excluded.floor`,
    ),
    insertLog: db.prepare(
      `INSERT INTO log
         (stream, seq, ts, mono, kind, delegation_id, attempt_id, turn_id,
          actor, causation, correlation, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    readLog: db.prepare('SELECT * FROM log WHERE stream = ? AND seq > ? ORDER BY seq ASC LIMIT ?'),
    trimLog: db.prepare('DELETE FROM log WHERE stream = ? AND seq <= ?'),
    dropStream: db.prepare('DELETE FROM log WHERE stream = ?'),
    dropHead: db.prepare('DELETE FROM stream_head WHERE stream = ?'),
    getRecord: db.prepare('SELECT kind, id, version, json FROM records WHERE kind = ? AND id = ?'),
    listRecords: db.prepare(
      'SELECT kind, id, version, json FROM records WHERE kind = ? ORDER BY id',
    ),
    putRecord: db.prepare(
      `INSERT INTO records (kind, id, version, json) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET version = excluded.version, json = excluded.json`,
    ),
    deleteRecord: db.prepare('DELETE FROM records WHERE kind = ? AND id = ?'),
    getIdem: db.prepare(
      'SELECT token_id, key, response, created_at FROM idem WHERE token_id = ? AND key = ?',
    ),
    putIdem: db.prepare(
      `INSERT INTO idem (token_id, key, response, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(token_id, key) DO NOTHING`,
    ),
    getLease: db.prepare(
      'SELECT key, holder, token, acquired_at, expires_at FROM leases WHERE key = ?',
    ),
    listLeases: db.prepare(
      'SELECT key, holder, token, acquired_at, expires_at FROM leases ORDER BY key',
    ),
    putLease: db.prepare(
      `INSERT INTO leases (key, holder, token, acquired_at, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET holder = excluded.holder, token = excluded.token,
         acquired_at = excluded.acquired_at, expires_at = excluded.expires_at`,
    ),
    touchLease: db.prepare('UPDATE leases SET expires_at = ? WHERE key = ? AND holder = ?'),
    deleteLease: db.prepare('DELETE FROM leases WHERE key = ? AND holder = ?'),
    bumpCounter: db.prepare(
      `INSERT INTO counters (name, value) VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET value = counters.value + excluded.value`,
    ),
    getCounter: db.prepare('SELECT value FROM counters WHERE name = ?'),
    insertAudit: db.prepare(
      `INSERT INTO audit
         (ts, mono, intent, actor, delegation_id, attempt_id, turn_id, effective, result, correlation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    readAudit: db.prepare('SELECT * FROM audit WHERE id > ? ORDER BY id ASC LIMIT ?'),
  }

  const listeners = new Set<(result: CommitResult<unknown>) => void>()
  let inTransaction = false
  let closed = false

  const assertOpen = (): void => {
    if (closed) throw new Error('swarm store is closed')
  }

  const decodeLog = (row: LogRow): LogRecord => {
    const record: {
      -readonly [K in keyof LogRecord]: LogRecord[K]
    } = {
      seq: row.seq,
      stream: row.stream as StreamName,
      ts: row.ts,
      mono: row.mono,
      /* `k` first: the column split must not reorder the JSON, or a replay that is exact in
       * content reads as different bytes to anything comparing serialized forms. */
      ev: { k: row.kind, ...(JSON.parse(row.payload) as object) } as LogRecord['ev'],
      actor: JSON.parse(row.actor) as ActorRef,
    }
    if (row.delegation_id !== null) record.delegationId = row.delegation_id
    if (row.attempt_id !== null) record.attemptId = row.attempt_id
    if (row.turn_id !== null) record.turnId = row.turn_id
    if (row.causation !== null) record.causationId = row.causation
    if (row.correlation !== null) record.correlationId = row.correlation
    return record
  }

  const decodeAudit = (row: AuditDbRow): AuditRow => {
    const record: { -readonly [K in keyof AuditRow]: AuditRow[K] } = {
      id: row.id,
      ts: row.ts,
      mono: row.mono,
      intent: row.intent,
      actor: JSON.parse(row.actor) as ActorRef,
    }
    if (row.delegation_id !== null) record.delegationId = row.delegation_id
    if (row.attempt_id !== null) record.attemptId = row.attempt_id
    if (row.turn_id !== null) record.turnId = row.turn_id
    if (row.effective !== null) record.effective = JSON.parse(row.effective) as unknown
    if (row.result !== null) record.result = JSON.parse(row.result) as unknown
    if (row.correlation !== null) record.correlation = row.correlation
    return record
  }

  const decodeLease = (row: {
    key: string
    holder: string
    token: number
    acquired_at: number
    expires_at: number
  }): Lease => ({
    key: row.key as LeaseKey,
    holder: row.holder,
    token: row.token,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  })

  const readTx: ReadTx = {
    head(stream) {
      const row = q.head.get(stream) as StreamHeadRow | undefined
      return row === undefined ? { stream, head: 0, floor: 0 } : row
    },
    heads: () => q.heads.all() as unknown as readonly StreamHeadRow[],
    readLog: (stream, fromExclusive, limit) =>
      (q.readLog.all(stream, fromExclusive, limit) as unknown as LogRow[]).map(decodeLog),
    getRecord<T>(kind: RecordKind, id: string) {
      const row = q.getRecord.get(kind, id) as
        | { kind: string; id: string; version: number; json: string }
        | undefined
      if (row === undefined) return null
      return { kind: row.kind, id: row.id, version: row.version, value: JSON.parse(row.json) as T }
    },
    listRecords<T>(kind: RecordKind) {
      const rows = q.listRecords.all(kind) as unknown as {
        kind: string
        id: string
        version: number
        json: string
      }[]
      return rows.map((row) => ({
        kind: row.kind,
        id: row.id,
        version: row.version,
        value: JSON.parse(row.json) as T,
      }))
    },
    getIdempotent(tokenId, key) {
      const row = q.getIdem.get(tokenId, key) as
        | { token_id: string; key: string; response: string; created_at: number }
        | undefined
      if (row === undefined) return null
      return {
        tokenId: row.token_id,
        key: row.key,
        response: JSON.parse(row.response) as unknown,
        createdAt: row.created_at,
      }
    },
    getLease(key) {
      const row = q.getLease.get(key) as
        | { key: string; holder: string; token: number; acquired_at: number; expires_at: number }
        | undefined
      return row === undefined ? null : decodeLease(row)
    },
    listLeases: () =>
      (
        q.listLeases.all() as unknown as {
          key: string
          holder: string
          token: number
          acquired_at: number
          expires_at: number
        }[]
      ).map(decodeLease),
    readAudit: (fromIdExclusive, limit) =>
      (q.readAudit.all(fromIdExclusive, limit) as unknown as AuditDbRow[]).map(decodeAudit),
    counter(name) {
      const row = q.getCounter.get(name) as { value: number } | undefined
      return row?.value ?? 0
    },
  }

  function makeWriteTx(emitted: LogRecord[], audited: AuditRow[]): WriteTx {
    return {
      ...readTx,

      appendLog(entry: LogAppend): LogRecord {
        const current = readTx.head(entry.stream)
        const seq = current.head + 1
        const ts = entry.ts ?? now()
        const m = mono()
        const { k, ...payload } = entry.ev
        q.insertLog.run(
          entry.stream,
          seq,
          ts,
          m,
          k,
          nullable(entry.delegationId),
          nullable(entry.attemptId),
          nullable(entry.turnId),
          JSON.stringify(entry.actor),
          nullable(entry.causationId),
          nullable(entry.correlationId),
          JSON.stringify(payload),
        )
        q.upsertHead.run(entry.stream, seq, current.floor)
        const record: { -readonly [K in keyof LogRecord]: LogRecord[K] } = {
          seq,
          stream: entry.stream,
          ts,
          mono: m,
          ev: entry.ev,
          actor: entry.actor,
        }
        if (entry.delegationId !== undefined) record.delegationId = entry.delegationId
        if (entry.attemptId !== undefined) record.attemptId = entry.attemptId
        if (entry.turnId !== undefined) record.turnId = entry.turnId
        if (entry.causationId !== undefined) record.causationId = entry.causationId
        if (entry.correlationId !== undefined) record.correlationId = entry.correlationId
        emitted.push(record)
        return record
      },

      putRecord<T>(kind: RecordKind, id: string, version: number, value: T): StoredRecord<T> {
        q.putRecord.run(kind, id, version, JSON.stringify(value))
        return { kind, id, version, value }
      },

      deleteRecord: (kind, id) => Number(q.deleteRecord.run(kind, id).changes) > 0,

      appendAudit(entry: AuditAppend): AuditRow {
        const ts = entry.ts ?? now()
        const m = mono()
        const result = q.insertAudit.run(
          ts,
          m,
          entry.intent,
          JSON.stringify(entry.actor),
          nullable(entry.delegationId),
          nullable(entry.attemptId),
          nullable(entry.turnId),
          entry.effective === undefined ? null : JSON.stringify(entry.effective),
          entry.result === undefined ? null : JSON.stringify(entry.result),
          nullable(entry.correlation),
        )
        const row: AuditRow = { ...entry, id: Number(result.lastInsertRowid), ts, mono: m }
        audited.push(row)
        return row
      },

      putIdempotent(tokenId, key, response): IdempotentEntry {
        const createdAt = now()
        q.putIdem.run(tokenId, key, JSON.stringify(response), createdAt)
        /* `DO NOTHING` above: the stored response is the ORIGINAL, error included (§13). */
        return readTx.getIdempotent(tokenId, key) ?? { tokenId, key, response, createdAt }
      },

      acquireLease(key, holder, ttlMs): Lease | null {
        const at = now()
        const existing = readTx.getLease(key)
        if (existing !== null && existing.expiresAt > at) {
          /* An idempotent re-acquire by the live holder keeps its fence: a token that moved on
           * every call would invalidate the fence the holder is mid-call with. */
          return existing.holder === holder ? existing : null
        }
        const token = this.nextFenceToken()
        const lease: Lease = { key, holder, token, acquiredAt: at, expiresAt: at + ttlMs }
        q.putLease.run(key, holder, token, at, lease.expiresAt)
        return lease
      },

      renewLease(key, holder, ttlMs): Lease | null {
        const existing = readTx.getLease(key)
        if (existing === null || existing.holder !== holder) return null
        const expiresAt = now() + ttlMs
        q.touchLease.run(expiresAt, key, holder)
        return { ...existing, expiresAt }
      },

      releaseLease: (key, holder) => Number(q.deleteLease.run(key, holder).changes) > 0,

      nextFenceToken(): number {
        q.bumpCounter.run(FENCE_COUNTER, 1)
        return readTx.counter(FENCE_COUNTER)
      },

      bumpCounter(name, by): number {
        q.bumpCounter.run(name, by)
        return readTx.counter(name)
      },

      advanceFloor(stream, floor): number {
        const current = readTx.head(stream)
        const next = Math.max(current.floor, Math.min(floor, current.head))
        const removed = q.trimLog.run(stream, next).changes
        q.upsertHead.run(stream, current.head, next)
        return Number(removed)
      },

      deleteStream(stream): number {
        const removed = q.dropStream.run(stream).changes
        q.dropHead.run(stream)
        return Number(removed)
      },
    }
  }

  const store: SwarmStore = {
    schemaVersion: SCHEMA_VERSION,

    commit<T>(fn: (tx: WriteTx) => T): CommitResult<T> {
      assertOpen()
      if (inTransaction) throw new Error('swarm store: transactions do not nest')
      const emitted: LogRecord[] = []
      const audited: AuditRow[] = []
      inTransaction = true
      db.exec('BEGIN IMMEDIATE')
      let value: T
      try {
        value = fn(makeWriteTx(emitted, audited))
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        inTransaction = false
        throw error
      }
      inTransaction = false

      const result: CommitResult<T> = { value, emitted, audited }
      /* Durable first, then fan-out, then return: the caller's `res` cannot precede either. */
      for (const listener of Array.from(listeners)) {
        try {
          listener(result as CommitResult<unknown>)
        } catch (error) {
          options.onListenerError?.(error)
          /* A faulty subscriber must not undo a committed write or silence its peers. */
        }
      }
      return result
    },

    read<T>(fn: (tx: ReadTx) => T): T {
      assertOpen()
      if (inTransaction) return fn(readTx)
      inTransaction = true
      db.exec('BEGIN DEFERRED')
      try {
        const value = fn(readTx)
        db.exec('COMMIT')
        return value
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      } finally {
        inTransaction = false
      }
    },

    snapshot<T>(stream: StreamName, materialize: (tx: ReadTx) => T): Snapshot<T> {
      /* One transaction for the cursor AND the state (§2.3), so no event is both in the
       * snapshot and re-delivered as an `evt` after it. */
      return store.read((tx) => ({ seq: tx.head(stream).head, state: materialize(tx) }))
    },

    onCommit(listener): Unsubscribe {
      listeners.add(listener)
      let active = true
      return () => {
        if (!active) return
        active = false
        listeners.delete(listener)
      }
    },

    close(): void {
      if (closed) return
      closed = true
      listeners.clear()
      db.close()
    },
  }

  return store
}
