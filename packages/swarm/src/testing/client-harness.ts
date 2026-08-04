/**
 * A client wired to a scripted transport, plus one builder per stream-family snapshot
 * (SPEC-swarm §2.3, §6.1).
 *
 * The clock is the point. `SwarmClientOptions.now` is injectable precisely so a projection pass
 * is a pure function of its inputs (§6.2's determinism, §6.4–6.6's age term), and a harness that
 * left it as `Date.now` would make every attention assertion a tolerance and every offline
 * staleness test a ten-minute wait.
 *
 * DOM-free and Node-free.
 */

import type { SwarmError } from '../errors.ts'
import type { SwarmEvent } from '../protocol/events.ts'
import type { HeadKind } from '../protocol/frames.ts'
import type {
  AttemptSnapshot,
  DelegationSnapshot,
  FleetSnapshot,
  ServerSnapshot,
} from '../protocol/snapshots.ts'
import type { SwarmClient } from '../types.ts'
import type { FakeTransport, HandshakeOptions } from './fake-transport.ts'

import { createSwarmClient } from '../client/index.ts'
import { emptySpendCounters } from '../domain/budget.ts'
import { createFakeTransport } from './fake-transport.ts'
import { makeDelegationVM, makeHealthVM } from './fixtures.ts'

export interface TestClock {
  now(): number
  /** Move the injected clock forward. Host timers are the runner's business, not this one's. */
  advance(ms: number): void
  set(ms: number): void
}

export interface TestClient {
  readonly client: SwarmClient
  readonly transport: FakeTransport
  readonly clock: TestClock
  /** Every `SwarmError` the client raised through `onError`. */
  readonly errors: readonly SwarmError[]
  /** `handshake()` + the two pinned snapshots, so a test starts from a live, empty fleet. */
  start(options?: HandshakeOptions): void
  destroy(): void
}

export interface TestClientOptions {
  readonly head?: HeadKind
  readonly clientName?: string
  readonly startAtMs?: number
  readonly autoAccept?: boolean
}

export function createTestClock(startAtMs = 1_000): TestClock {
  let ms = startAtMs
  return {
    now: () => ms,
    advance(delta) {
      ms += delta
    },
    set(next) {
      ms = next
    },
  }
}

export function makeServerSnapshot(overrides: Partial<ServerSnapshot> = {}): ServerSnapshot {
  return { health: makeHealthVM(), notices: [], confirmations: [], ...overrides }
}

export function makeFleetSnapshot(overrides: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    delegations: [],
    concurrency: { runningAttempts: 0, cap: 4, queued: 0 },
    dispatchPaused: false,
    spend: { ...emptySpendCounters(), capUsd: null },
    ...overrides,
  }
}

export function makeDelegationSnapshot(
  overrides: Partial<DelegationSnapshot> = {},
): DelegationSnapshot {
  return { delegation: makeDelegationVM(), ...overrides }
}

export function makeAttemptSnapshot(overrides: Partial<AttemptSnapshot> = {}): AttemptSnapshot {
  return { attemptId: 'attempt-1', entries: [], hasOlder: false, diff: null, ...overrides }
}

export function createTestClient(options: TestClientOptions = {}): TestClient {
  const clock = createTestClock(options.startAtMs)
  const transport = createFakeTransport({
    ...(options.autoAccept === undefined ? {} : { autoAccept: options.autoAccept }),
  })
  const errors: SwarmError[] = []
  const client = createSwarmClient({
    transport,
    clientName: options.clientName ?? 'test/0.1',
    head: options.head ?? 'test',
    now: () => clock.now(),
    onError: (error) => errors.push(error),
  })

  return {
    client,
    transport,
    clock,
    errors,
    start(handshakeOptions) {
      transport.handshake(handshakeOptions)
      transport.snap('server', 0, makeServerSnapshot())
      transport.snap('fleet', 0, makeFleetSnapshot())
    },
    destroy() {
      client.destroy()
    },
  }
}

/** A `fleet.delegation_created` for the given (or default) VM — the usual way a test seeds one. */
export function delegationCreated(
  overrides: Parameters<typeof makeDelegationVM>[0] = {},
): SwarmEvent {
  return { k: 'fleet.delegation_created', delegation: makeDelegationVM(overrides) }
}
