/**
 * The domain layer: the three state machines (§3.3), the rollup and bucket mapping (§3.3,
 * §6.2.1), turn-directive semantics (§4.1, §4.3), budgets and clocks (§3.4, X16) and leases with
 * fencing tokens (§3.4).
 *
 * Every export is pure. The client core and the server both derive from these, which is what
 * keeps H8's split — "server owns policy, client owns projection" — from meaning the two sides
 * implement the same table twice and disagree in production.
 */

export {
  ALL_TRANSITION_ROWS,
  CHANNEL_STATES,
  CHANNEL_TERMINAL_STATES,
  CHANNEL_TRANSITIONS,
  DELEGATION_STATES,
  DELEGATION_TERMINAL_STATES,
  DELEGATION_TRANSITIONS,
  DELIVERY_STATES,
  DELIVERY_TERMINAL_STATES,
  DELIVERY_TRANSITIONS,
  channelMachine,
  delegationMachine,
  deliveryMachine,
} from './machines.ts'
export type {
  ChannelTrigger,
  DelegationTrigger,
  DeliveryTrigger,
  FromSpec,
  Machine,
  TransitionActor,
  TransitionOutcome,
  TransitionRejection,
  TransitionRow,
} from './machines.ts'

export {
  ATTENTION_WEIGHTS,
  FLEET_BUCKETS,
  ROLLUP_PRIORITY,
  attentionScore,
  bucketOf,
  compareAttention,
  emptyBuckets,
  rollupDelegationState,
} from './rollup.ts'
export type { AttentionInput, BucketInput } from './rollup.ts'

export {
  AMBIENT_AUTH_METHODS,
  HONESTY_IDS,
  ambientRoutesOf,
  honestyNotices,
  honestyStatements,
} from './honesty.ts'
export type { HonestyInput, HonestyStatement } from './honesty.ts'

export {
  ANTHROPIC_EXTENDED_EFFORT_MODELS,
  BANNED_EFFORTS,
  BASE_EFFORT_LADDER,
  DEFAULT_STRUCTURED_MAX_RETRIES,
  EFFORT_LADDERS,
  REASONING_EFFORTS,
  TURN_DELIVERY_MODES,
  checkEffortOnLadder,
  checkImageBudget,
  effectiveTurnConfig,
  effortLadder,
  modeAllowsConfig,
  normalizeEffort,
  reconciliationTarget,
  validateTurnDirective,
} from './directive.ts'
export type {
  DelegationDefaults,
  DirectiveContext,
  EffectiveConfigInput,
  ImageBudgetResult,
} from './directive.ts'

export {
  SOFT_BREACH_FRACTION,
  addSpend,
  budgetFractions,
  classifyBudget,
  classifyClockGap,
  emptySpendCounters,
  turnBudgetBreached,
  worstFraction,
} from './budget.ts'
export type {
  BudgetBreach,
  BudgetDimension,
  BudgetFractions,
  BudgetLevel,
  ClockGap,
  ClockGapKind,
} from './budget.ts'

export {
  LEASE_KINDS,
  admissionLeases,
  checkFence,
  delegationLease,
  fenceOf,
  homeLease,
  isExpired,
  leaseStatus,
  parseLeaseKey,
  repoLease,
  sessionLease,
  worktreeLease,
} from './leases.ts'
export type { AdmissionLeases, LeaseKind } from './leases.ts'

export {
  CHANNEL_RECONNECT,
  CHANNEL_TIMEOUTS,
  DEFAULT_CAPS,
  DEFAULT_TIMEOUTS,
  LEASES,
  SERVER_POLICY,
  VERIFIER_CAPS,
} from './constants.ts'
