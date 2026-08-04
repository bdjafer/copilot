/**
 * The SQLite schema of SPEC-swarm §3.5, as text.
 *
 * It lives here — beside the store *contract*, not beside the `node:sqlite` implementation — so
 * a test can assert the tables and columns against the spec without importing a Node builtin,
 * and so the in-memory store can be checked against the same column list it claims to emulate.
 *
 * DOM-free and Node-free: this module is strings.
 */

export const SCHEMA_VERSION = 1

/**
 * `synchronous = FULL` on the log (§3.5) is not the usual WAL trade. Every other table can
 * afford `NORMAL`, but the log is what makes "an intent that returns `ok` is durable" true, and
 * a fsync skipped there turns a power cut into a head that acknowledged work it never wrote.
 */
export const PRAGMAS = [
  'PRAGMA journal_mode = WAL',
  'PRAGMA synchronous = FULL',
  'PRAGMA foreign_keys = ON',
  'PRAGMA busy_timeout = 5000',
] as const

/**
 * `PRIMARY KEY(stream, seq)` is the gapless-sequence guarantee expressed as a constraint: a
 * second row claiming an assigned `seq` cannot be written, whatever the writer believes.
 */
export const DDL = [
  `CREATE TABLE IF NOT EXISTS log (
     stream        TEXT    NOT NULL,
     seq           INTEGER NOT NULL,
     ts            INTEGER NOT NULL,
     mono          REAL    NOT NULL,
     kind          TEXT    NOT NULL,
     delegation_id TEXT,
     attempt_id    TEXT,
     turn_id       TEXT,
     actor         TEXT    NOT NULL,
     causation     TEXT,
     correlation   TEXT,
     payload       TEXT    NOT NULL,
     PRIMARY KEY (stream, seq)
   )`,
  `CREATE TABLE IF NOT EXISTS stream_head (
     stream TEXT    PRIMARY KEY,
     head   INTEGER NOT NULL,
     floor  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS records (
     kind    TEXT    NOT NULL,
     id      TEXT    NOT NULL,
     version INTEGER NOT NULL,
     json    TEXT    NOT NULL,
     PRIMARY KEY (kind, id)
   )`,
  `CREATE TABLE IF NOT EXISTS idem (
     token_id   TEXT    NOT NULL,
     key        TEXT    NOT NULL,
     response   TEXT    NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (token_id, key)
   )`,
  `CREATE TABLE IF NOT EXISTS leases (
     key         TEXT    PRIMARY KEY,
     holder      TEXT    NOT NULL,
     token       INTEGER NOT NULL,
     acquired_at INTEGER NOT NULL,
     expires_at  INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS counters (
     name  TEXT    PRIMARY KEY,
     value INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS schema_version (
     v INTEGER NOT NULL
   )`,
  /*
   * Outside every retention rule (§2.3, §3.5, S13, Q20). Audit rows are never deleted by
   * retention, compaction, archive, discard or purge; a purge appends an audit row of its own,
   * so the record of what was removed outlives what was removed.
   */
  `CREATE TABLE IF NOT EXISTS audit (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     ts            INTEGER NOT NULL,
     mono          REAL    NOT NULL,
     intent        TEXT    NOT NULL,
     actor         TEXT    NOT NULL,
     delegation_id TEXT,
     attempt_id    TEXT,
     turn_id       TEXT,
     effective     TEXT,
     result        TEXT,
     correlation   TEXT
   )`,
] as const

/** The eight tables §3.5 names, in DDL order — asserted by `test/log-ddl.test.ts`. */
export const TABLES = [
  'log',
  'stream_head',
  'records',
  'idem',
  'leases',
  'counters',
  'schema_version',
  'audit',
] as const

/** The one counter the store keeps: §3.4's monotonic fencing-token source. */
export const FENCE_COUNTER = 'fence'
