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

/* §6.7 (Q8, #39) — six tools, and the confirmation seam that gates the three that write. */
export { ConfirmationRegistry, COPILOT_READ_TOOLS, COPILOT_WRITE_TOOLS } from './confirm.ts'
export type { ConfirmationDecision, ConfirmationRegistryOptions } from './confirm.ts'
export { createCopilotSurface } from './copilot.ts'
export type { CopilotSurfaceOptions, CopilotTools, CopilotWaitUntil } from './copilot.ts'

/* §8 — the verifier and its evidence bundle. */
export { createVerifier, verdictOf, writeEvidenceBundle, REVIEW_RUBRIC_SCHEMA } from './verifier.ts'
export type { CommandRunner, ReviewRunner, VerifierOptions } from './verifier.ts'

/* §7.3 — the workspace allowlist, worktrees, diff and landing. */
export {
  assertPathInsideRoot,
  createWorktree,
  diffAgainstBase,
  land,
  resolveBaseRevision,
  WorkspaceGuard,
} from './workspace.ts'
export type { ResolvedWorkspace, WorktreeSpec } from './workspace.ts'

/* §7.2/§7.3 — `$SWARM_HOME`, `config.json` and `runtime.json`. */
export {
  defaultServerConfig,
  loadServerConfig,
  resolveSwarmHome,
  swarmHomeLayout,
  writeServerConfig,
} from './config.ts'
export type {
  RuntimeFile,
  SwarmHomeLayout,
  SwarmServerConfig,
  WorkspaceRegistration,
} from './config.ts'

/* §2.1 — pairing, tokens and the local CLI trust file. */
export { CLI_TOKEN_ID, TokenStore } from './tokens.ts'
export type { IssuedToken, PairingCode, TokenRecord } from './tokens.ts'

/* §2.1–§2.5 — one connection, and the admission table it is admitted by. */
export { admit, SwarmConnection, SERVER_CAPABILITY_SET } from './ws.ts'
export type { AdmissionOutcome, ConnectionSocket, ConnectionOptions } from './ws.ts'

/* §6.1 H7, §7.1 `--in-process` — the same connection over a pipe. */
export { createInProcessTransport } from './in-process.ts'

/* §5.1/§5.3 — the jcode adapter, swarm's own bridge spawn and the two-group kill. */
export { createJcodeAdapter, JcodeAdapter } from './executor/jcode.ts'
export type { JcodeAdapterOptions } from './executor/jcode.ts'
export {
  buildBridgeEnv,
  killTwoGroups,
  launchBridge,
  preflightJcode,
  resolveDaemonPid,
} from './executor/spawn.ts'
export type { BridgeLauncher, SpawnedBridge, VersionProbe } from './executor/spawn.ts'

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
