/**
 * The bridge's view of the extension platform (MV3).
 *
 * Every `chrome.*` / `browser.*` surface the bridge touches is declared here as a **narrow
 * structural type**, and every module under `src/` takes one of these as a parameter rather
 * than reaching for a global. Two reasons, both load-bearing:
 *
 * 1. **Testability.** `startBackground` / `startContent` are ordinary functions over ordinary
 *    objects, so the whole bridge — dispatch policy, relay projection, keepalive, watchdog,
 *    tool routing — runs in vitest against `test/support/fake-chrome.ts` with no browser and
 *    no WXT test plumbing.
 * 2. **Honesty about the contract.** The real `Browser.storage.local` and `chrome.storage.local`
 *    both satisfy these types structurally, so the entrypoints hand over the genuine object;
 *    nothing is adapted or wrapped at the boundary.
 *
 * The only files allowed to name a platform global are `entrypoints/*` and
 * `src/content/shadow-ui.ts` (WXT's `createShadowRootUi` glue).
 */

/* ------------------------------------------------------------------ storage */

export interface StorageChange {
  oldValue?: unknown
  newValue?: unknown
}

/**
 * `chrome.storage.StorageArea`, minus everything the bridge does not call.
 *
 * `getKeys()` is optional because it only exists from Chrome 130 (Firefox 136). Its absence is
 * the one case where the §2.8 "key-only, never `get(null)`" rule cannot be honoured; `kv.ts`
 * degrades explicitly rather than silently.
 */
export interface StorageAreaLike {
  get(keys: string[] | null): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string[]): Promise<void>
  getKeys?(): Promise<string[]>
}

export interface StorageChangedEvent {
  addListener(listener: (changes: Record<string, StorageChange>, areaName: string) => void): void
  removeListener(listener: (changes: Record<string, StorageChange>, areaName: string) => void): void
}

export interface StorageLike {
  local: StorageAreaLike
  onChanged: StorageChangedEvent
}

/* ------------------------------------------------------------------ runtime */

export interface PortLike {
  name?: string
  postMessage(message: unknown): void
  disconnect(): void
  onMessage: {
    addListener(listener: (message: unknown) => void): void
    removeListener(listener: (message: unknown) => void): void
  }
  onDisconnect: {
    addListener(listener: () => void): void
    removeListener(listener: () => void): void
  }
}

export interface RuntimeLike {
  /** The 25 s keepalive ping of PLAN §4.5. Any extension-API call works; this one is free. */
  getPlatformInfo(): Promise<unknown>
  connect(info?: { name?: string }): PortLike
  onConnect: { addListener(listener: (port: PortLike) => void): void }
  onStartup: { addListener(listener: () => void): void }
  onInstalled: { addListener(listener: () => void): void }
}

/* ------------------------------------------------------------------ alarms */

export interface AlarmLike {
  name: string
}

export interface AlarmsLike {
  create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): void
  /**
   * Optional only because a polyfill may not expose it. Without it the watchdog cannot be made
   * idempotent: `alarms.create` with an existing name *cancels and replaces* that alarm, so
   * re-creating it on every worker wake restarts the 30 s countdown — and in an active session
   * the worker is woken constantly, which defers the alarm indefinitely.
   */
  get?(name: string): Promise<AlarmLike | undefined>
  onAlarm: { addListener(listener: (alarm: AlarmLike) => void): void }
}

/* ------------------------------------------------------------------ tabs */

export interface TabLike {
  id?: number
  url?: string
}

export interface TabsLike {
  query(filter: { url?: string | string[] }): Promise<TabLike[]>
}

/* ------------------------------------------------------------------ commands */

export interface CommandsLike {
  onCommand: { addListener(listener: (command: string) => void): void }
}

/**
 * Everything the service worker needs. `commands` is optional: the manifest declares it, but a
 * profile can unbind every shortcut and Firefox may not expose the namespace at all.
 */
export interface BackgroundPlatform {
  storage: StorageLike
  runtime: RuntimeLike
  alarms: AlarmsLike
  tabs: TabsLike
  commands?: CommandsLike
  /** `setInterval`, injected so the keepalive is assertable without real timers. */
  setInterval(handler: () => void, ms: number): number
  clearInterval(handle: number): void
}
