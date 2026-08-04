/**
 * The durable log's contract and schema. Node-free by construction — `./server` implements it
 * over `node:sqlite` and `./testing` implements it in memory, and `storeConformance()` is the
 * only thing that decides whether either is right.
 */

export { DDL, FENCE_COUNTER, PRAGMAS, SCHEMA_VERSION, TABLES } from './ddl.ts'
export { RECORD_KINDS } from './types.ts'
export type {
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
} from './types.ts'
