/**
 * An in-process `BridgeMessenger` pair that models **which API each direction uses**, because
 * that is the contract, not an implementation detail of it.
 *
 * `@webext-core/messaging`'s `sendMessage(type, data)` with no third argument is
 * `chrome.runtime.sendMessage`, which reaches extension pages (options, popup) and **never** a
 * content script; only `sendMessage(type, data, tabId)` becomes `chrome.tabs.sendMessage` and
 * reaches one. A fake that delivered worker → page regardless of the target made the one mistake
 * that matters — a tab-less notification from the service worker — invisible, which is exactly
 * what happened: `copilot:busy`, `copilot:pending`, `copilot:failed` and `copilot:toast` were
 * all undeliverable in the shipped extension while every test passed.
 *
 * So, here:
 *
 * * worker → **no tabId** goes to the extension-page listeners, and rejects when nothing is
 *   listening there — as `runtime.sendMessage` does with no receiver;
 * * worker → **tabId** goes to that tab's content script, and rejects for an unknown tab — as
 *   `tabs.sendMessage` does;
 * * page → worker ignores any target, as `runtime.sendMessage` from a content script does.
 *
 * Payloads are JSON round-tripped, so a test that passes a non-cloneable value fails here the
 * way it would over a real port. A send with no registered listener rejects, matching the
 * library ("if you haven't setup a listener for the sent `type`, an error will be thrown") —
 * which is why every `sendMessage` in the bridge that targets a page is `.catch()`ed.
 */

import type { BridgeMessenger, ProtocolMap } from '../../src/messaging.ts'

type Key = keyof ProtocolMap
type Handler = (message: { data: unknown; id: number; type: Key; timestamp: number }) => unknown

export interface FakeChannel {
  /** What the service worker holds. A send needs a tab target to reach a content script. */
  worker: BridgeMessenger
  /** What the content script in `tabId` holds. */
  page: BridgeMessenger
  /** The tab the default page end lives in. */
  readonly tabId: number
  /** A second content script, in another tab. */
  openTab(tabId: number): BridgeMessenger
  /** An extension page (options/popup) — the only receiver a tab-less send has. */
  extensionPage: BridgeMessenger
  /** Every message sent, in order, for ordering assertions. */
  readonly sent: Array<{ from: 'worker' | 'page'; type: Key; data: unknown; tabId?: number }>
  /** Drop a tab's listeners, as a closed tab would. Defaults to the primary tab. */
  closePage(tabId?: number): void
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

export function createFakeChannel(options?: { tabId?: number }): FakeChannel {
  const primaryTab = options?.tabId ?? 7
  const workerHandlers = new Map<Key, Handler>()
  const tabHandlers = new Map<number, Map<Key, Handler>>()
  const extensionHandlers = new Map<Key, Handler>()
  const sent: FakeChannel['sent'] = []
  let id = 0

  const handlersFor = (tabId: number): Map<Key, Handler> => {
    const own = tabHandlers.get(tabId) ?? new Map<Key, Handler>()
    tabHandlers.set(tabId, own)
    return own
  }

  const deliver = async (
    target: Map<Key, Handler> | undefined,
    type: Key,
    data: unknown,
  ): Promise<unknown> => {
    const handler = target?.get(type)
    if (!handler) throw new Error(`No listener for ${String(type)}`)
    return clone(await handler({ data: clone(data), id: ++id, type, timestamp: 0 }))
  }

  const listen = (own: Map<Key, Handler>) => (type: Key, handler: Handler) => {
    own.set(type, handler)
    return () => {
      if (own.get(type) === handler) own.delete(type)
    }
  }

  const worker = {
    async sendMessage(type: Key, data?: unknown, tabId?: number) {
      sent.push({
        from: 'worker',
        type,
        data: clone(data),
        ...(tabId === undefined ? {} : { tabId }),
      })
      // `chrome.runtime.sendMessage` from the worker: extension pages only, never a tab.
      if (tabId === undefined) return deliver(extensionHandlers, type, data)
      const target = tabHandlers.get(tabId)
      if (!target) throw new Error(`Could not establish connection to tab ${tabId}`)
      return deliver(target, type, data)
    },
    onMessage: listen(workerHandlers),
  }

  const pageEnd = (tabId: number): BridgeMessenger => {
    const own = handlersFor(tabId)
    return {
      async sendMessage(type: Key, data?: unknown) {
        // A content script's `sendMessage` always goes to the worker; there is no tab target.
        sent.push({ from: 'page', type, data: clone(data), tabId })
        return deliver(workerHandlers, type, data)
      },
      onMessage: listen(own),
    } as unknown as BridgeMessenger
  }

  const extensionPage = {
    async sendMessage(type: Key, data?: unknown) {
      sent.push({ from: 'page', type, data: clone(data) })
      return deliver(workerHandlers, type, data)
    },
    onMessage: listen(extensionHandlers),
  } as unknown as BridgeMessenger

  return {
    worker: worker as unknown as BridgeMessenger,
    page: pageEnd(primaryTab),
    tabId: primaryTab,
    openTab: (tabId) => pageEnd(tabId),
    extensionPage,
    sent,
    closePage(tabId = primaryTab) {
      tabHandlers.delete(tabId)
    },
  }
}
