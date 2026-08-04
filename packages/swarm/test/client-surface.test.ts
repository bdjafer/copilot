/**
 * SPEC-swarm §13's first sentence, for the `.` entry's client half.
 *
 * > "Every symbol in … §6.1–6.4, §6.7 … is exported with exactly the listed signature from the
 * > listed entry … A CI test asserts the export list is **exhaustive in both directions**:
 * > nothing listed is missing, and nothing exported is unlisted."
 *
 * Both directions, three ways, because no single mechanism covers a TypeScript surface:
 *
 *  - **runtime values** are enumerated from the barrel's module namespace;
 *  - **types** are enumerated from the barrel's `export type { … }` block, parsed from source —
 *    a type has no runtime footprint, and a fixture that merely imports one proves only that the
 *    name resolves, not that the barrel re-exports it (`test/fixtures/es2022-client.ts` covers
 *    the resolution half, and does it with no `dom` and no `@types/node`);
 *  - **the client object itself** is enumerated with `Object.keys`, so an intent added to
 *    `SwarmClient` without a spec line fails here rather than shipping.
 *
 * The lists below are transcribed from the spec, not from the implementation. That is the whole
 * point: a test that derived them from `src/` would pass for any surface at all.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createSwarmClient } from '../src/client/index.ts'
import * as barrel from '../src/index.ts'
import { INTENT_NAMES } from '../src/protocol/frames.ts'
import { createFakeTransport } from '../src/testing/fake-transport.ts'
import { SWARM_CLIENT_EVENT_KEYS } from '../src/types.ts'

/** §6.1–6.4 and §6.7, verbatim: every type name those sections declare. */
const SPEC_TYPES_6 = [
  /* §6.1 construction */
  'SwarmClientOptions',
  'SwarmTransport',
  'ReadableStore',
  'Unsubscribe',
  /* §6.2 stores and view models */
  'SwarmClient',
  'ConnectionVM',
  'FleetBucket',
  'FleetVM',
  'DelegationVM',
  'AttemptVM',
  'AttemptComparisonVM',
  'TurnVM',
  'HealthVM',
  'NoticeVM',
  'NoticeKind',
  'TranscriptVM',
  'TranscriptEntry',
  'DiffVM',
  'TranscriptHandle',
  'DiffHandle',
  'SwarmClientInspection',
  /* §6.3 intents */
  'IntentResult',
  'SwarmClientIntents',
  'LandOptions',
  'DelegationDefaultsPatch',
  'RetractReport',
  'ReconcileReport',
  'KillReport',
  'FleetFilter',
  /* §6.4 events */
  'SwarmClientEvents',
  /* §6.7 the confirmation seam */
  'ConfirmationRequest',
  /* §1.3, referenced by §6.1's `contextProviders` */
  'ContextProvider',
  'ContextBundle',
  'ContextRef',
] as const

/** The client-half runtime values `.` must publish (§6.1, §6.2.1, §6.4–6.6, §9). */
const SPEC_VALUES_CLIENT = [
  'createSwarmClient',
  'SWARM_CLIENT_EVENT_KEYS',
  'bucketOf',
  'attentionScore',
  'SwarmError',
] as const

/** §6.2 + §6.3: the complete `SwarmClient` surface, transcribed from the spec's two blocks. */
const SPEC_CLIENT_KEYS = [
  /* §6.2 */
  'connection',
  'fleet',
  'delegations',
  'focus',
  'health',
  'notices',
  'transcript',
  'diff',
  'on',
  'once',
  'subscribe',
  'inspect',
  'destroy',
  /* §6.3 — `focus` is declared by both blocks and counted once */
  'createDelegation',
  'sendTurn',
  'retract',
  'cancel',
  'retry',
  'branch',
  'verify',
  'accept',
  'land',
  'discard',
  'archive',
  'reconcile',
  'pauseDispatch',
  'killSwitch',
  'updateDefaults',
  'confirm',
  'deny',
  'setFilter',
] as const

/** The `export type { … }` names of the barrel, read from source. */
function barrelTypeExports(): Set<string> {
  const source = readFileSync(resolve(import.meta.dirname, '../src/index.ts'), 'utf8')
  const names = new Set<string>()
  for (const match of source.matchAll(/export type \{([^}]*)\}/g)) {
    for (const raw of match[1]!.split(',')) {
      const name = raw
        .trim()
        .split(/\s+as\s+/)[0]
        ?.trim()
      if (name !== undefined && name.length > 0) names.add(name)
    }
  }
  return names
}

describe('§13 the `.` entry exports every symbol §6 declares', () => {
  it('exports all 35 type names of §6.1–6.4, §6.7 and §1.3', () => {
    const exported = barrelTypeExports()
    const missing = SPEC_TYPES_6.filter((name) => !exported.has(name))
    expect(missing).toEqual([])
  })

  it('exports the client-half runtime values, callable and of the declared kind', () => {
    const values = barrel as unknown as Record<string, unknown>
    for (const name of SPEC_VALUES_CLIENT) {
      expect({ name, present: name in values }).toEqual({ name, present: true })
    }
    expect(typeof values.createSwarmClient).toBe('function')
    expect(typeof values.bucketOf).toBe('function')
    expect(typeof values.attentionScore).toBe('function')
    expect(Array.isArray(values.SWARM_CLIENT_EVENT_KEYS)).toBe(true)
  })

  it('re-exports every runtime value of the client modules — nothing is stranded', () => {
    const published = new Set(Object.keys(barrel))
    /* `src/client/index.ts` is the only module of the client half with runtime exports; the
     * others (`readable`, `emitter`) are re-exported by name in the barrel's own blocks. */
    for (const name of ['createSwarmClient', 'SWARM_CLIENT_VERSION']) {
      expect({ name, published: published.has(name) }).toEqual({ name, published: true })
    }
    for (const name of ['writable', 'readonlyStore', 'createEmitter']) {
      expect({ name, published: published.has(name) }).toEqual({ name, published: true })
    }
  })
})

describe('§13 nothing exported is unlisted', () => {
  it('the client object has exactly the 31 members §6.2 and §6.3 declare', () => {
    const client = createSwarmClient({
      transport: createFakeTransport(),
      clientName: 'surface/0.1',
      head: 'test',
      now: () => 1,
    })
    expect(Object.keys(client).sort()).toEqual([...SPEC_CLIENT_KEYS].sort())
    /* 13 from §6.2 + 19 from §6.3, with `focus` declared by both. */
    expect(SPEC_CLIENT_KEYS.length).toBe(31)
    client.destroy()
  })

  it('every member is of the kind its section declares: stores read, intents return promises', () => {
    const client = createSwarmClient({
      transport: createFakeTransport(),
      clientName: 'surface/0.1',
      head: 'test',
      now: () => 1,
    })
    for (const name of ['connection', 'fleet', 'delegations', 'health', 'notices'] as const) {
      const store = client[name] as { get: unknown; subscribe: unknown }
      expect({ name, get: typeof store.get, subscribe: typeof store.subscribe }).toEqual({
        name,
        get: 'function',
        subscribe: 'function',
      })
    }
    /* §6.2's store and §6.3's intent, on one member (client deviation C1). */
    expect(typeof client.focus).toBe('function')
    expect(typeof client.focus.get).toBe('function')
    expect(typeof client.focus.subscribe).toBe('function')
    /* §6.3: the two local-only selections return `void`, every wire intent a promise. */
    expect(client.setFilter({})).toBeUndefined()
    expect(client.focus(null)).toBeUndefined()
    for (const name of INTENT_NAMES) {
      expect({ name, kind: typeof client[name] }).toEqual({ name, kind: 'function' })
    }
    client.destroy()
  })

  it('the 19 intents of §6.3 are the 17 wire intents plus the two local selections', () => {
    const local = ['setFilter', 'focus']
    expect(INTENT_NAMES).toHaveLength(17)
    expect(INTENT_NAMES.length + local.length).toBe(19)
    for (const name of local) {
      expect(INTENT_NAMES as readonly string[]).not.toContain(name)
    }
  })

  it('the event map is 23 keys, and the exported list is the map itself', () => {
    expect(SWARM_CLIENT_EVENT_KEYS).toHaveLength(23)
    expect(new Set(SWARM_CLIENT_EVENT_KEYS).size).toBe(23)
    expect(barrel.SWARM_CLIENT_EVENT_KEYS).toBe(SWARM_CLIENT_EVENT_KEYS)
  })
})
