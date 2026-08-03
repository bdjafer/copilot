/**
 * A hand-rolled MV3 platform fake.
 *
 * **Why not `@webext-core/fake-browser`** (which is already in the tree via WXT): its
 * `storage.local` does not implement `getKeys()` — the exact API the §2.8 "key-only, never
 * `get(null)`" rule is built on — so every prefix scan would silently exercise the degraded
 * path rather than the real one. It also gives no way to *drive* the pieces this bridge's whole
 * design rests on: firing an alarm, connecting a port pair, or simulating a worker death. This
 * fake does all four in ~200 lines and is the thing the tests actually need.
 *
 * `set` round-trips through JSON exactly as `chrome.storage` serializes, so a test that stores a
 * non-serializable value fails here the way it would fail in a browser.
 */

import type {
  AlarmsLike,
  BackgroundPlatform,
  PortLike,
  RuntimeLike,
  StorageChange,
  StorageLike,
  TabLike,
  TabsLike,
} from '../../src/platform.ts'

/* ------------------------------------------------------------------ events */

function createEvent<Args extends unknown[]>() {
  const listeners = new Set<(...args: Args) => void>()
  return {
    addListener(listener: (...args: Args) => void) {
      listeners.add(listener)
    },
    removeListener(listener: (...args: Args) => void) {
      listeners.delete(listener)
    },
    emit(...args: Args) {
      // Snapshot: a listener may unsubscribe from inside its own callback, and mutating the
      // Set mid-iteration would skip the next one.
      // eslint-disable-next-line unicorn/no-useless-spread -- the copy is the point
      for (const listener of [...listeners]) listener(...args)
    },
    get size() {
      return listeners.size
    },
  }
}

/* ----------------------------------------------------------------- storage */

export interface FakeStorage extends StorageLike {
  /** Direct peek, bypassing the API. For assertions about what actually landed on disk. */
  dump(): Record<string, unknown>
  /** Wipe without firing change events, as a fresh profile would look. */
  reset(): void
  /** Count of `get` calls, so a test can prove a scan stayed key-only. */
  readonly getCalls: number
  readonly getNullCalls: number
}

export function createFakeStorage(options?: { getKeys?: boolean }): FakeStorage {
  const data = new Map<string, unknown>()
  const onChanged = createEvent<[Record<string, StorageChange>, string]>()
  let getCalls = 0
  let getNullCalls = 0

  const area = {
    async get(keys: string[] | null): Promise<Record<string, unknown>> {
      getCalls++
      if (keys === null) {
        getNullCalls++
        return Object.fromEntries(data)
      }
      const out: Record<string, unknown> = {}
      // Real `chrome.storage.local.get(keys)` omits absent keys rather than yielding undefined.
      for (const key of keys) if (data.has(key)) out[key] = data.get(key)
      return out
    },
    async set(items: Record<string, unknown>): Promise<void> {
      const changes: Record<string, StorageChange> = {}
      for (const [key, value] of Object.entries(items)) {
        const serialized: unknown = JSON.parse(JSON.stringify(value))
        changes[key] = { oldValue: data.get(key), newValue: serialized }
        data.set(key, serialized)
      }
      onChanged.emit(changes, 'local')
    },
    async remove(keys: string[]): Promise<void> {
      const changes: Record<string, StorageChange> = {}
      for (const key of keys) {
        if (!data.has(key)) continue
        changes[key] = { oldValue: data.get(key), newValue: undefined }
        data.delete(key)
      }
      if (Object.keys(changes).length > 0) onChanged.emit(changes, 'local')
    },
    ...(options?.getKeys === false
      ? {}
      : {
          async getKeys(): Promise<string[]> {
            return [...data.keys()]
          },
        }),
  }

  return {
    local: area,
    onChanged,
    dump: () => Object.fromEntries(data),
    reset: () => data.clear(),
    get getCalls() {
      return getCalls
    },
    get getNullCalls() {
      return getNullCalls
    },
  }
}

/* -------------------------------------------------------------------- port */

export interface FakePort extends PortLike {
  readonly received: unknown[]
  disconnected: boolean
}

/** The two hooks the peer end drives. Not on `PortLike`: a real port has no such surface. */
interface LinkedPort extends FakePort {
  peer?: LinkedPort
  deliver(message: unknown): void
  fireDisconnect(): void
}

/** A connected pair. `a.postMessage(x)` is delivered to `b`'s message listeners, and back. */
export function createPortPair(name = 'copilot-relay'): { a: FakePort; b: FakePort } {
  const make = (): LinkedPort => {
    const onMessage = createEvent<[unknown]>()
    const onDisconnect = createEvent<[]>()
    const received: unknown[] = []

    const port: LinkedPort = {
      name,
      received,
      disconnected: false,
      onMessage,
      onDisconnect,
      postMessage(message: unknown) {
        if (port.disconnected) throw new Error('Attempting to use a disconnected port object')
        // The same serialization a real port applies — which is why a live CopilotError posted
        // here loses `code`, exactly as it would in a browser.
        port.peer?.deliver(JSON.parse(JSON.stringify(message)))
      },
      disconnect() {
        if (port.disconnected) return
        port.disconnected = true
        const peer = port.peer
        if (peer) {
          peer.disconnected = true
          peer.fireDisconnect()
        }
        port.fireDisconnect()
      },
      deliver(message: unknown) {
        received.push(message)
        onMessage.emit(message)
      },
      fireDisconnect() {
        onDisconnect.emit()
      },
    }
    return port
  }

  const a = make()
  const b = make()
  a.peer = b
  b.peer = a
  return { a, b }
}

/* ----------------------------------------------------------------- runtime */

export interface FakeRuntime extends RuntimeLike {
  readonly pings: number
  /** Simulates a page opening the relay port; returns the page-side end. */
  connectFromPage(name?: string): FakePort
  fireStartup(): void
  fireInstalled(): void
}

export function createFakeRuntime(): FakeRuntime {
  const onConnect = createEvent<[PortLike]>()
  const onStartup = createEvent<[]>()
  const onInstalled = createEvent<[]>()
  let pings = 0

  return {
    async getPlatformInfo() {
      pings++
      return { os: 'mac' }
    },
    connect() {
      const { a } = createPortPair()
      return a
    },
    onConnect,
    onStartup,
    onInstalled,
    get pings() {
      return pings
    },
    connectFromPage(name = 'copilot-relay') {
      const { a, b } = createPortPair(name)
      onConnect.emit(b)
      return a
    },
    fireStartup: () => onStartup.emit(),
    fireInstalled: () => onInstalled.emit(),
  }
}

/* ------------------------------------------------------------------ alarms */

export interface FakeAlarms extends AlarmsLike {
  readonly created: Array<{ name: string; periodInMinutes?: number }>
  /** Drives the watchdog without waiting 30 s. */
  fire(name: string): void
}

/**
 * `create` replaces any alarm of the same name, exactly as `chrome.alarms.create` does — so a
 * `get`-less re-create shows up as a *second* `created` entry, which is the point: a replaced
 * alarm is one whose 30 s countdown just restarted.
 */
export function createFakeAlarms(options?: { get?: boolean }): FakeAlarms {
  const onAlarm = createEvent<[{ name: string }]>()
  const created: Array<{ name: string; periodInMinutes?: number }> = []
  const live = new Map<string, { name: string }>()
  return {
    create(name, info) {
      created.push({ name, ...info })
      live.set(name, { name })
    },
    // Optional in the type because a polyfill may not have it; omitted here on request so the
    // degraded path (always create) is testable too.
    ...(options?.get === false
      ? {}
      : {
          async get(name: string) {
            return live.get(name)
          },
        }),
    onAlarm,
    created,
    fire: (name) => onAlarm.emit({ name }),
  }
}

/* -------------------------------------------------------------------- tabs */

export interface FakeTabs extends TabsLike {
  set(tabs: TabLike[]): void
}

export function createFakeTabs(initial: TabLike[] = []): FakeTabs {
  let tabs = initial
  return {
    async query() {
      return tabs
    },
    set(next) {
      tabs = next
    },
  }
}

/* ------------------------------------------------------------------ timers */

export interface FakeTimers {
  setInterval(handler: () => void, ms: number): number
  clearInterval(handle: number): void
  /** Runs every live interval once. */
  tick(): void
  readonly active: number
  readonly periods: number[]
}

export function createFakeTimers(): FakeTimers {
  const handlers = new Map<number, { fn: () => void; ms: number }>()
  const periods: number[] = []
  let next = 1
  return {
    setInterval(fn, ms) {
      const handle = next++
      handlers.set(handle, { fn, ms })
      periods.push(ms)
      return handle
    },
    clearInterval(handle) {
      handlers.delete(handle)
    },
    tick() {
      // Snapshot: a handler may clear its own interval.
      // eslint-disable-next-line unicorn/no-useless-spread -- the copy is the point
      for (const { fn } of [...handlers.values()]) fn()
    },
    get active() {
      return handlers.size
    },
    periods,
  }
}

/* ---------------------------------------------------------------- assembly */

export interface FakePlatform extends BackgroundPlatform {
  storage: FakeStorage
  runtime: FakeRuntime
  alarms: FakeAlarms
  tabs: FakeTabs
  timers: FakeTimers
}

export function createFakePlatform(options?: {
  tabs?: TabLike[]
  getKeys?: boolean
  alarmsGet?: boolean
}): FakePlatform {
  const storage = createFakeStorage({ getKeys: options?.getKeys ?? true })
  const runtime = createFakeRuntime()
  const alarms = createFakeAlarms({ get: options?.alarmsGet ?? true })
  const tabs = createFakeTabs(options?.tabs ?? [])
  const timers = createFakeTimers()
  return {
    storage,
    runtime,
    alarms,
    tabs,
    timers,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
  }
}
