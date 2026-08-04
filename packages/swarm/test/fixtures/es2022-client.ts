/**
 * SPEC-swarm §13's second boundary proof, and the one deleting globals cannot give.
 *
 * > "a second [test] typechecks a fixture importing it under `lib:["ES2022"]` with no `dom` and no
 * > `@types/node` — that failure is a compile error, not a crash, so global deletion is not
 * > enough."
 *
 * `tsconfig.es2022.json` compiles **only this file**, with `lib: ["ES2022"]` and `types: []`. It is
 * run by `pnpm typecheck`, so a `document`, a `NodeJS.Timeout` or a `Buffer` anywhere in the `.`
 * entry's import graph fails the gate here rather than in a consumer's service worker.
 *
 * The file exercises the surface rather than merely importing it: an unused type import can be
 * erased before it is ever checked, while a call whose argument and return types are both
 * inspected cannot.
 */

import type {
  ConnectionVM,
  DelegationVM,
  FleetVM,
  IntentResult,
  ReadableStore,
  SwarmClient,
  SwarmClientEvents,
  SwarmTransport,
  TurnId,
  Unsubscribe,
} from '../../src/index.ts'

import {
  SWARM_CLIENT_EVENT_KEYS,
  SWARM_PROTOCOL_VERSION,
  SwarmError,
  attentionScore,
  bucketOf,
  createSwarmClient,
  decodeServerFrame,
  effortLadder,
  encodeFrame,
} from '../../src/index.ts'

/** A transport with no `WebSocket`, no `node:*` and no DOM event type in sight (H7). */
function makeTransport(): SwarmTransport {
  const noop: Unsubscribe = () => {}
  return {
    open() {},
    send(_text: string) {},
    close(_code?: number, _reason?: string) {},
    onOpen: () => noop,
    onMessage: () => noop,
    onClose: () => noop,
    onError: () => noop,
  }
}

export function buildClient(): SwarmClient {
  return createSwarmClient({
    transport: makeTransport(),
    clientName: 'es2022-fixture/0.1',
    head: 'test',
    /* `now` is a plain number source — no `performance`, no `process.hrtime`. */
    now: () => Date.now(),
    onError: (error: SwarmError) => {
      if (SwarmError.is(error, 'unauthenticated')) return
    },
  })
}

export function readStores(client: SwarmClient): {
  connection: ConnectionVM
  fleet: FleetVM
  delegations: ReadonlyMap<string, DelegationVM>
  focused: string | null
} {
  const connection: ReadableStore<ConnectionVM> = client.connection
  return {
    connection: connection.get(),
    fleet: client.fleet.get(),
    delegations: client.delegations.get(),
    focused: client.focus.get(),
  }
}

export function listen(client: SwarmClient): Unsubscribe {
  const off: Unsubscribe[] = []
  for (const key of SWARM_CLIENT_EVENT_KEYS) {
    off.push(client.on(key, () => {}))
  }
  off.push(
    client.on('delegation:state', (event: SwarmClientEvents['delegation:state']) => {
      void event.bucket
    }),
  )
  return () => {
    for (const unsubscribe of off) unsubscribe()
  }
}

export async function sendOne(client: SwarmClient): Promise<IntentResult<TurnId>> {
  return client.sendTurn('delegation-1', { text: 'hello', idempotencyKey: 'fixture-1' })
}

export function pureDerivations(): { bucket: string; score: number; ladder: number; wire: string } {
  const wire = encodeFrame({ p: 'swarm', v: SWARM_PROTOCOL_VERSION, k: 'ping', t: 0 })
  const decoded = decodeServerFrame(wire)
  return {
    bucket: bucketOf({ state: 'verifying', stalledForMs: null, landed: false }),
    score: attentionScore({
      state: 'needs-you',
      landed: false,
      stalled: false,
      deliveryUnknown: false,
      budgetBreached: false,
      staleBase: false,
      ageMinutes: 3,
    }),
    ladder: effortLadder('openai', 'gpt-5.4').length,
    wire: decoded.ok ? decoded.frame.k : 'undecodable',
  }
}
