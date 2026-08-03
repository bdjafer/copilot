/**
 * The content script (SPEC-comment-core §7.2 + SPEC-copilot §6's content half).
 *
 * Runs on `<all_urls>` at `document_start`. It owns exactly five things:
 *
 * 1. the engine + `comment-ui`, over the shared `chrome.storage` store;
 * 2. the DOM tools the SW calls back into (`serveTools`);
 * 3. bridge-owned badge chrome — the copilot chips, re-derived from durable state on mount;
 * 4. PLAN §5's batch pill, the host's own overlay below `CommentUIOptions.zIndex`;
 * 5. the token-relay port, held open only while a thread on this page is busy.
 *
 * There is **no `thread:create` forwarding here**: the SW observes the same store, so the hooks
 * need no message channel at all.
 */

import type { CommentEngine, KeyValueAdapter } from '@astrale-os/comment-core'
import type { CommentUI } from '@astrale-os/comment-ui'

import { createCommentEngine, createKeyValueStore } from '@astrale-os/comment-core'
import { mountCommentUI } from '@astrale-os/comment-ui'

import type { HostState } from '../host-state.ts'
import type { BridgeMessenger } from '../messaging.ts'
import type { RuntimeLike } from '../platform.ts'
import type { Settings } from '../settings.ts'
import type { HostChrome } from './pill.ts'
import type { RelayEnvelope } from './relay-client.ts'
import type { RelayLink } from './relay-link.ts'

import { createHostState } from '../host-state.ts'
import { COMMENT_NS } from '../keys.ts'
import { toolMessageKey } from '../messaging.ts'
import { loadSettings, modesFromSettings, watchSettings } from '../settings.ts'
import { createChipStore } from './chips.ts'
import { nullHostChrome } from './pill.ts'
import { createRelayLink } from './relay-link.ts'
import { createToolServer } from './tools.ts'

export interface ContentDeps {
  kv: KeyValueAdapter
  messenger: BridgeMessenger
  /**
   * Builds the host overlay. The WXT `createShadowRootUi` glue in `shadow-ui.ts` supplies the
   * real one; a test supplies `mountHostChrome` over a bare `<div>`.
   */
  mountChrome(handlers: { onSend(): void; onDismiss(): void }): Promise<HostChrome> | HostChrome
  /**
   * `chrome.runtime`, for the token relay port (PLAN §4.5). Absent ⇒ no streaming channel; the
   * chips then run on the message channel alone, which is a degradation, not a failure.
   */
  runtime?: Pick<RuntimeLike, 'connect'>
}

export interface ContentHandle {
  engine: CommentEngine
  ui: CommentUI
  chrome: HostChrome
  host: HostState
  /** The token-relay port. Open only while a thread on this page is busy. */
  relay: RelayLink
  /** Re-derives chips and the pill count from durable state. Idempotent. */
  refresh(): Promise<void>
  destroy(): void
}

export async function startContent(deps: ContentDeps): Promise<ContentHandle> {
  const { kv, messenger } = deps
  // The content script owns one document — the one it was injected into. A `document` seam here
  // would have to agree with the one `createCommentEngine` and `mountCommentUI` resolve on their
  // own, and nothing (test or entrypoint) ever needed a second one.
  const doc = globalThis.document

  const store = createKeyValueStore(kv, { namespace: COMMENT_NS })
  const host = createHostState(kv)
  let settings: Settings = await loadSettings(kv)

  const engine = createCommentEngine({ store, modes: modesFromSettings(settings) })

  const ui = mountCommentUI(engine, {
    isolateEvents: true,
    // The documented WXT caveat: `all: initial` does not cover the page's `<html>`
    // font-size, so nothing here may be rem-dependent without an explicit anchor.
    rootFontSize: '16px',
  })

  const chips = createChipStore((threadId, decoration) => ui.decorate(threadId, decoration))

  // The overlay is the least important of this script's four duties and the only one that
  // touches the page's DOM at `document_start`. A throw here used to reject `startContent`
  // before a single tool endpoint, chip handler or trigger route was registered — a page where
  // comments work and the copilot is silently absent. It now costs the pill and nothing else.
  const hostChrome = await Promise.resolve()
    .then(() =>
      deps.mountChrome({
        onSend: () => void sendBatch(),
        onDismiss: () => void dismissPending(),
      }),
    )
    .catch(() => nullHostChrome(doc))

  /* ------------------------------------------------------------- DOM tools */

  const served = createToolServer({
    engine,
    document: doc,
    toast: (text) => hostChrome.toast(text),
  })
  const offTools = served.names.map((name) =>
    messenger.onMessage(toolMessageKey(name), ({ data }) => served.handle(name, data)),
  )

  /* --------------------------------------------------- bridge-owned chrome */

  const offBusy = messenger.onMessage('copilot:busy', ({ data }) => {
    chips.setBusy(data.threadId, data.busy)
    if (data.busy) hostChrome.setPendingCount(pendingCount)
    syncRelay()
  })
  const offPending = messenger.onMessage('copilot:pending', ({ data }) => {
    chips.setPending(data.threadId, data.pending)
    void refresh()
  })
  const offFailed = messenger.onMessage('copilot:failed', ({ data }) => {
    chips.setFailed(data.threadId, data.code)
    syncRelay()
  })
  const offToast = messenger.onMessage('copilot:toast', ({ data }) => {
    hostChrome.toast(data.text, data.tone ?? 'info')
  })
  // `chrome.commands` cannot bind a bare letter, so the manifest command routes here — the
  // same entry point the key listener uses, with no second API.
  const offTrigger = messenger.onMessage('trigger', ({ data }) => {
    engine.startPlacement(data.kind)
  })

  /* ---------------------------------------------------------------- relay */

  /**
   * PLAN §4.5's streaming channel. Open only while a thread on this page is busy: an open port
   * extends the service worker's lifetime, which is the point during a run and a leak outside
   * one — a content script on `<all_urls>` holding one would keep the worker alive from every
   * tab. It is also the reconnect path: the worker dies mid-run routinely, and re-opening the
   * port both re-establishes the stream and wakes the worker that owns the run.
   */
  const relay: RelayLink = deps.runtime
    ? createRelayLink({ runtime: deps.runtime, onEvent: (event) => onRelayEvent(event) })
    : { want: () => {}, connected: false, attempts: 0, destroy: () => {} }
  const syncRelay = (): void => {
    relay.want(chips.keys().some((threadId) => chips.get(threadId)?.busy))
  }

  function onRelayEvent(event: RelayEnvelope): void {
    const payload = event.payload as {
      run?: { context?: { threadId?: string; threadIds?: string[] } }
    }
    const context = payload.run?.context
    const threadIds = context?.threadIds ?? (context?.threadId ? [context.threadId] : [])
    const live = new Set(engine.listThreads().map((view) => view.id))
    switch (event.type) {
      case 'run:queued':
        for (const threadId of threadIds.filter((id) => live.has(id))) chips.setBusy(threadId, true)
        return
      case 'run:done':
      case 'run:cancelled':
        // The reply lands in the store, which the engine is already watching; `refresh` is what
        // turns "the run ended" into the right chip, unread flag and pill count.
        void refresh()
        return
      default:
        // `run:token` is the reason the port exists — the stream keeps the worker alive through
        // a long run. Nothing on the page renders partial text yet, so it is deliberately a
        // no-op rather than a fabricated UI.
        return
    }
  }

  /* -------------------------------------------------------------- refresh */

  let pendingCount = 0

  async function refresh(): Promise<void> {
    const pageKey = engine.pageKey
    const live = new Set(engine.listThreads().map((view) => view.id))
    // Storage reads: local, and they never wake the service worker.
    const [pending, unread, failed] = await Promise.all([
      host.listPending(pageKey),
      host.listUnread(),
      host.listFailed(),
    ])
    // Level-triggered: a worker death between `busy: true` and `busy: false` would otherwise
    // leave a chip spinning for the life of the tab. Skipped when this page has no threads at
    // all — otherwise every page load in every tab, on `<all_urls>`, spins up the worker to be
    // told about nothing.
    const busy =
      live.size === 0
        ? []
        : await messenger.sendMessage('copilot:busyThreads', undefined).catch((): string[] => [])
    const pendingIds = pending.map((entry) => entry.threadId).filter((id) => live.has(id))
    const busyIds = busy.filter((id) => live.has(id))
    chips.reset(
      busyIds,
      pendingIds,
      unread.filter((id) => live.has(id)),
      failed.filter((entry) => live.has(entry.threadId)),
    )
    pendingCount = pendingIds.length
    hostChrome.setPendingCount(pendingCount)
    syncRelay()
  }

  async function sendBatch(): Promise<void> {
    const pageKey = engine.pageKey
    const threadIds = (await host.listPending(pageKey)).map((entry) => entry.threadId)
    if (threadIds.length === 0) return
    hostChrome.setSending(true)
    try {
      const result = await messenger.sendMessage('copilot:sendBatch', { pageKey, threadIds })
      if (!result.ok) hostChrome.toast(result.reason ?? 'copilot could not start the run', 'warn')
    } catch {
      hostChrome.toast('copilot is unavailable — is the extension still installed?', 'warn')
    } finally {
      hostChrome.setSending(false)
      await refresh()
    }
  }

  async function dismissPending(): Promise<void> {
    const pageKey = engine.pageKey
    await host.clearPendingMany(await host.listPending(pageKey))
    await refresh()
  }

  /* ------------------------------------------------------------ lifecycle */

  const offSettings = watchSettings(kv, () => {
    void loadSettings(kv).then((next) => {
      settings = next
      // No remount, no lost state — `setModes` re-registers key listeners and leaves threads,
      // decorations and listeners untouched.
      engine.setModes(modesFromSettings(settings))
    })
  })

  // `page:change` clears every decoration in `comment-ui`, so the re-derivation is not a
  // startup nicety: it is what keeps chips correct across SPA navigation.
  const offPageChange = engine.on('page:change', () => {
    chips.clear()
    void refresh()
  })
  // A thread the user just opened is no longer an unread reply.
  const offClick = engine.on('thread:click', ({ thread }) => {
    if (chips.get(thread.id)?.unread) {
      chips.setUnread(thread.id, false)
      void host.clearUnread(thread.id)
    }
  })
  // The pending set is per page and per thread; a delete must not keep the pill counting it.
  const offDelete = engine.on('thread:delete', ({ thread }) => {
    void host.forgetThread(thread.id).then(refresh)
  })

  await engine.ready()
  // No `page:hello`: it stored nothing on the far end, and `refresh()` below already asks the
  // one question a fresh page has — so the announcement was a second service-worker wake per
  // page load, in every tab, on `<all_urls>`.
  await refresh()

  return {
    engine,
    ui,
    chrome: hostChrome,
    host,
    relay,
    refresh,
    destroy() {
      for (const off of offTools) off()
      offBusy()
      offPending()
      offFailed()
      offToast()
      offTrigger()
      offSettings()
      offPageChange()
      offClick()
      offDelete()
      relay.destroy()
      hostChrome.destroy()
      ui.unmount()
      engine.destroy()
    },
  }
}
