/**
 * `@astrale-os/swarm/server` — Node ≥ 24 (SPEC-swarm §1.1).
 *
 * The server owns scheduling, budgets, leases, verification and landing (H8, Q7, decision log
 * #2): the fleet must progress with no head attached, and any policy in the head makes closing a
 * tab a scheduling event.
 *
 * `createSwarmServer` is the composition root: it owns the store, the token file, the workspace
 * guard, the engine and one WebSocket per head. Everything below it is reachable on its own, so a
 * host can embed the scheduler without the socket, or the verifier without either. The protocol
 * and domain modules are reached through relative paths and never through the client barrel
 * (§1.1), so a Node-only consumer pays nothing for the client core.
 */

export { createSwarmServer } from './server.ts'
export type { CreateSwarmServerOptions, SwarmServer } from './server.ts'

export { SwarmEngine } from './engine.ts'
export type { AttemptMeta, IntentContext, IntentResult, SwarmEngineOptions } from './engine.ts'

export { createSqliteStore } from './store.ts'
export type { SqliteStoreOptions } from './store.ts'

/* The log contract the store implements (§3.5) — re-exported so `./server` is self-sufficient. */
export { DDL, FENCE_COUNTER, PRAGMAS, SCHEMA_VERSION, TABLES } from '../log/ddl.ts'
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
} from '../log/types.ts'

/* The executor seam (§5.1) and the normative jcode capability row (§5.2). */
export { INSTANCE_CREDENTIAL_PROVIDERS, JCODE_CAPABILITIES } from './executor/types.ts'
export type {
  ConfigApplyReport,
  ExecutorAdapter,
  ExecutorCapabilities,
  ExecutorEvent,
  ExecutorInstance,
  ExecutorRuntimeInfo,
  ExecutorSessionHandle,
  ExecutorSessionInfo,
  ExecutorSubmission,
  InstanceCredentialProvider,
  InstanceOptions,
  KillOutcomeReport,
  SessionConfigPatch,
  StructuredResult,
  SubmitReceipt,
} from './executor/types.ts'
