/**
 * `@astrale-os/swarm` — the client core (SPEC-swarm §1.1).
 *
 * **ES2022 only: no DOM, no `node:*`, no `chrome.*`.** The entry is loaded by a browser
 * extension's service worker, by the CLI under Node and by tests, so a single `document` or
 * `process` reference anywhere in its import graph breaks one of the three. §13 asserts it two
 * ways: a grep over `src/`, and a fixture that typechecks this entry under `lib: ["ES2022"]`
 * with no `dom` and no `@types/node`.
 *
 * The wire protocol is re-exported **whole** from here (§1.1) and imported by `./server` through
 * a relative path — never back through this barrel.
 *
 * `createSwarmClient` is the whole runtime surface; everything else here is either the
 * vocabulary it is built from or the pure derivations (`bucketOf`, `attentionScore`,
 * `validateTurnDirective`) a head may need to compute the same answer locally.
 */

/* ------------------------------------------------------------------------------------ §9 */
export { SWARM_ERROR_CODES, SwarmError, isSwarmErrorCode, swarmErrorFromWire } from './errors.ts'
export type { SwarmErrorCode, SwarmErrorInit } from './errors.ts'

/* -------------------------------------------------------------------------- §6.1–6.6 client */
export { SWARM_CLIENT_VERSION, createSwarmClient } from './client/index.ts'
export { NOTICE_RETENTION } from './client/projections.ts'
export { TRANSCRIPT_RING, TRANSCRIPT_WINDOW } from './client/transcript.ts'
export { readonlyStore, writable } from './readable.ts'
export type { WritableStore } from './readable.ts'
export { createEmitter } from './emitter.ts'
export type { Emitter, EmitterOptions } from './emitter.ts'

/* ------------------------------------------------------------------- §1.3, §3.x, §6.x, §8 */
export { SWARM_CLIENT_EVENT_KEYS } from './types.ts'
export type {
  AcceptanceCriterion,
  ActorRef,
  AdapterId,
  AttemptComparisonVM,
  AttemptId,
  AttemptOutcome,
  AttemptRecord,
  AttemptVM,
  BudgetSpec,
  ChannelState,
  ConfirmationRequest,
  ConnectionVM,
  ContextBundle,
  ContextProvider,
  ContextRef,
  CreateDelegationInput,
  CriterionResult,
  CriterionStatus,
  DelegationDefaultsPatch,
  DelegationId,
  DelegationRecord,
  DelegationSpec,
  DelegationState,
  DelegationVM,
  DeliveryDefaults,
  DeliveryDetail,
  DeliveryState,
  DiffHandle,
  DiffVM,
  EffectiveTurnConfig,
  ExecutionSpec,
  Fence,
  FleetBucket,
  FleetFilter,
  FleetVM,
  FocusStore,
  HealthVM,
  IntentResult,
  InstanceKey,
  KillOutcome,
  KillReport,
  LandOptions,
  LandingRecord,
  Lease,
  LeaseKey,
  McpServerRef,
  ModelRoute,
  ModelSpec,
  NeedsYouReason,
  NoticeKind,
  NoticeVM,
  PreflightReport,
  ReadableStore,
  ReasoningEffort,
  ReconcileReport,
  RetractReport,
  SkillRef,
  SpendCounters,
  SwarmClient,
  SwarmClientEvents,
  SwarmClientInspection,
  SwarmClientIntents,
  SwarmClientOptions,
  SwarmTransport,
  TranscriptEntry,
  TranscriptHandle,
  TranscriptVM,
  TurnBudget,
  TurnDeliveryMode,
  TurnDirective,
  TurnId,
  TurnRecord,
  TurnVM,
  Unsubscribe,
  VerificationInput,
  VerificationRun,
  Verifier,
  WorkspaceInput,
  WorkspaceSpec,
} from './types.ts'

/* ------------------------------------------------------------------------------ §2 protocol */
export * from './protocol/index.ts'

/* ------------------------------------------------- §3.3, §3.4, §4.1, §4.3, §6.2.1 domain */
export * from './domain/index.ts'

/* --------------------------------------------------------------------------- §2.3, §3.5 log */
export * from './log/index.ts'
