/**
 * The typed CS ⇄ SW channel (PLAN §6: `@webext-core/messaging`).
 *
 * **What is deliberately NOT here:** `thread:create` / `thread:reply` forwarding. The service
 * worker observes the same `chrome.storage` range through `observeStore`, and
 * `storage.onChanged` wakes a dormant worker — so the hooks need no message at all
 * (SPEC-comment-core §6/§7.3). The only irreducible traffic is what must run *in the page*:
 * the three DOM tools, plus bridge-owned badge chrome that the SW is the only source of.
 *
 * `BridgeMessenger` is `Pick<ExtensionMessenger<…>, 'sendMessage' | 'onMessage'>` — the library
 * type, not a re-declaration — so a fake used in tests is held to the real contract.
 */

import type { ExtensionMessenger } from '@webext-core/messaging'

import { defineExtensionMessaging } from '@webext-core/messaging'

/** What `copilot:busy` renders. Bridge-owned; `comment-ui` has no idea what a copilot is. */
export interface BusyPayload {
  threadId: string
  busy: boolean
}

/**
 * The relay port name, declared here rather than next to `attachRelay` so the page end can open
 * the port without importing the service worker's relay module — which would drag the whole
 * copilot runtime into the content-script bundle.
 */
export const RELAY_PORT_NAME = 'copilot-relay'

export interface ProtocolMap {
  /* -----------------------------------------------------------------------------------------
   * SW → page: **every one of these MUST carry a tab target.**
   *
   * `sendMessage(type, data)` with no third argument is `chrome.runtime.sendMessage`, which
   * dispatches to extension *pages* (options, popup) and never to a content script; only
   * `chrome.tabs.sendMessage(tabId, …)` reaches one. A tab-less send from the worker therefore
   * rejects with `lastError` and — since every one of these is best-effort and `.catch`ed —
   * fails **silently**: no chip, no pill, no toast, no failure state, for the whole session.
   * `background/index.ts` resolves targets through `TabRouter.tabsForPageKey` for exactly this
   * reason, and `test/support/fake-messaging.ts` models the two APIs separately so a tab-less
   * send fails in tests the way it fails in Chrome.
   * --------------------------------------------------------------------------------------- */

  /* --- SW → page: bridge-owned badge chrome (SPEC-comment-core §7.2) --- */
  'copilot:busy': (data: BusyPayload) => void
  'copilot:pending': (data: { threadId: string; pending: boolean }) => void
  /** A run that died three times must not look like a run that never happened. */
  'copilot:failed': (data: { threadId: string; code: string }) => void
  /** A batch run's `run:done` output is a summary over many threads — a toast, not a comment. */
  'copilot:toast': (data: { text: string; tone?: 'info' | 'warn' }) => void

  /* --- page → SW --- */
  /**
   * Level-triggered chip recovery. `run:queued`/`run:settled` are edges emitted by ONE instance;
   * after a worker death a content script has no other way to ask "who is busy?".
   */
  'copilot:busyThreads': () => string[]
  /** PLAN §5's "N comments — Send to copilot" pill. */
  'copilot:sendBatch': (data: { pageKey: string; threadIds: string[] }) => {
    ok: boolean
    runId?: string
    reason?: string
  }
  /* --- SW → page: the `chrome.commands` fallback (a command cannot bind a bare letter) --- */
  trigger: (data: { kind: string }) => void

  /* --- DOM tools (SPEC-copilot §6: `remoteTool` ⇄ `serveTools`) --- */
  'tool:get_page_context': (data: unknown) => unknown
  'tool:get_thread_element_html': (data: unknown) => unknown
  'tool:show_message': (data: unknown) => unknown
}

/** The tool half of the protocol, kept in one place so both ends agree on the key format. */
export const TOOL_MESSAGE_PREFIX = 'tool:' as const
export const toolMessageKey = (name: string): keyof ProtocolMap =>
  `${TOOL_MESSAGE_PREFIX}${name}` as keyof ProtocolMap

/**
 * The injectable seam. Every bridge module takes one of these; only the entrypoints construct
 * the real one, so `startBackground` / `startContent` run under vitest unmodified.
 */
export type BridgeMessenger = Pick<ExtensionMessenger<ProtocolMap>, 'sendMessage' | 'onMessage'>

/**
 * Built at module scope on purpose. `onMessage` installs `runtime.onMessage` lazily on first
 * use, and MV3 only wakes a terminated worker for listeners registered in the first turn of
 * initial evaluation — so the entrypoint must call `onMessage` synchronously, which it does.
 */
export function createMessenger(): ExtensionMessenger<ProtocolMap> {
  // The default logger writes every message to the console — of every page on the web, at
  // `document_start`. The documented "set to null" escape hatch is not in the v4 type
  // (`logger?: Logger`), so a no-op logger is the typed equivalent.
  const silent = { debug: () => {}, log: () => {}, warn: () => {}, error: () => {} }
  return defineExtensionMessaging<ProtocolMap>({ logger: silent })
}
