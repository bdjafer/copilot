/**
 * `@astrale-os/swarm/testing` (§1.1) — the mock executor, the conformance suites and the
 * fixtures they are built from.
 *
 * The suites are **runner-agnostic** arrays of `{ name, run }`, so
 * `for (const c of suite()) it(c.name, c.run)` works in vitest, node:test and bun alike — and a
 * host embedding swarm can hold its own adapter to the same contract in whatever it already uses.
 *
 * Everything here is DOM-free and Node-free; only `src/testing/node/**` may name `node:*` (the
 * jcode tape lands with the server stage, alongside `createInMemoryTransport` and
 * `fakeJcodeTransport`, which need the client and adapter code they exercise).
 */

export type { Awaitable, ConformanceCase } from './types.ts'

export { assert, assertDeepEqual, assertEqual, assertRejects, show } from './assert.ts'

export { MOCK_DEFAULT_CAPABILITIES, MockExecutor, mockInstanceOptions } from './mock-executor.ts'
export type {
  MockExecutorCall,
  MockExecutorOptions,
  MockStep,
  MockTurnScript,
} from './mock-executor.ts'

export { mockExecutorHarness, toMockScript } from './mock-harness.ts'

export { executorConformance } from './executor-conformance.ts'
export type { ConformanceTurn, ExecutorHarness } from './executor-conformance.ts'

export { storeConformance } from './store-conformance.ts'
export type { StoreHarness } from './store-conformance.ts'

export { protocolConformance } from './protocol-conformance.ts'

/** `SPEC_CLIENT_MEMBERS` is the §6.2/§6.3 surface as data, so a host can assert it directly. */
export { SPEC_CLIENT_MEMBERS, clientConformance } from './client-conformance.ts'

/**
 * The scripted transport and the client harness. `createFakeTransport()` is deliberately *not*
 * `createInMemoryTransport()` (§1.1): that one runs the client against a real embedded server and
 * lands with the server stage. This one writes frame sequences a correct server never produces —
 * a `seq` gap, a `snap` before `hello_ok` — which is exactly what §2.2–§2.3 legislate for.
 */
export { createFakeTransport } from './fake-transport.ts'
export type { FakeTransport, FakeTransportOptions, HandshakeOptions } from './fake-transport.ts'

export {
  createTestClient,
  createTestClock,
  delegationCreated,
  makeAttemptSnapshot,
  makeDelegationSnapshot,
  makeFleetSnapshot,
  makeServerSnapshot,
} from './client-harness.ts'
export type { TestClient, TestClientOptions, TestClock } from './client-harness.ts'

export { createMemoryBackend, createMemoryStore } from './memory-store.ts'
export type { MemoryBackend, MemoryStoreOptions } from './memory-store.ts'

/* Fixtures, so a host suite can build valid records and events without a server. */
export {
  BASE_REVISION,
  allSampleEvents,
  makeActor,
  makeAttemptVM,
  makeConfirmationRequest,
  makeCreateInput,
  makeDelegationSpec,
  makeDelegationVM,
  makeHealthVM,
  makeKillReport,
  makeLandingRecord,
  makeNoticeVM,
  makePreflightReport,
  makeRetractReport,
  makeTurnDirective,
  makeTurnVM,
  makeVerificationRun,
  sampleEvent,
} from './fixtures.ts'

/**
 * Pure derivations §6.2.1 and §6.4–6.6 require to be exported from `./testing` for assertion:
 * the fleet list and the row badge must be produced by one function, and the attention sort must
 * be checkable without rendering anything.
 */
export {
  ATTENTION_WEIGHTS,
  FLEET_BUCKETS,
  ROLLUP_PRIORITY,
  attentionScore,
  bucketOf,
  compareAttention,
  emptyBuckets,
  rollupDelegationState,
} from '../domain/rollup.ts'
export type { AttentionInput, BucketInput } from '../domain/rollup.ts'

/**
 * The jcode tape and the embedded-server transport (§1.1: "Node only for the jcode tape").
 *
 * `fakeJcodeTransport()` names no Node builtin — it is an in-process bridge — but it reproduces
 * behaviours the spec cites source lines for ([F2] resolve-on-timeout, [F5] create-attaches,
 * [F6] error frames with no `session_id`, [F10] the parked mid-turn config, [F11] the empty
 * `call_id`), which is what makes the jcode adapter falsifiable on a machine whose jcode predates
 * `api-bridge`. `createInMemoryTransport()` runs a head against a **real embedded server** over
 * the identical frames — §7.1 is explicit that this proves less than the socket does, so it is a
 * convenience for tests and never the CLI's default path.
 */
export { FakeJcodeBridge, fakeJcodeTransport } from './node/fake-jcode.ts'
export type { FakeJcodeOptions, FakeJcodeTransport, RecordedCall } from './node/fake-jcode.ts'
export { jcodeExecutorHarness } from './node/jcode-harness.ts'
export type { JcodeHarness, JcodeHarnessOptions } from './node/jcode-harness.ts'
export { createInMemoryTransport, createTestServer } from './node/in-memory-transport.ts'
export type { InMemoryTransportOptions, TestServerOptions } from './node/in-memory-transport.ts'

/**
 * The seeded demo scenario (§10, release gate 10) — a scratch repo, a real failing test, two
 * acceptance criteria and a scripted three-attempt run, so a first delegation is never against
 * the user's own work. Data and the scripted run only; `createDemoRepo` needs `node:fs` and
 * therefore lives under `./node`.
 */
export {
  DEMO_ATTEMPTS,
  DEMO_CRITERIA,
  DEMO_FILES,
  DEMO_FIX,
  DEMO_OBJECTIVE,
  DEMO_SCENARIO,
  demoTurns,
  runDemoAttempts,
} from './demo/index.ts'
export type {
  DemoAttempt,
  DemoAttemptResult,
  DemoCriterion,
  DemoFile,
  DemoRunOptions,
} from './demo/index.ts'
