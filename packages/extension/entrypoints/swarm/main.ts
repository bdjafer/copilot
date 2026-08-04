/**
 * The swarm head's page (SPEC-swarm §6.1, H7; PRODUCT §3).
 *
 * ## Ruling: the client core lives in a PAGE, not in the service worker
 *
 * MV3 offers two homes for a long-lived socket and only one of them is honest. The **service
 * worker** is event-driven and torn down on idle; WebSocket traffic resets the 30 s timer on
 * current Chrome, but nothing resets it across a browser-managed shutdown, a profile suspend or a
 * laptop sleep. Swarm's confirmation seam is explicit that "no head connected ⇒ no confirmation ⇒
 * no write" (§6.7): a head that can die mid-turn and re-snapshot on wake is not a head a *human* is
 * watching, and being watched is the entire authority a confirmation carries. Add `attempt:*` — the
 * highest-volume stream in the protocol (§2.3) and the only one §2.4 degrades — and the worker
 * would be paying to buffer a transcript nobody is looking at.
 *
 * This **page** is open exactly while a human is watching the fleet. Its socket lives as long as
 * the tab, its resume is the ordinary §2.5 reconnect (backoff, snapshot or `from:<seq>`, idempotent
 * re-send — all of it the client core's, none of it re-implemented here), and its rendering needs a
 * DOM anyway. The token lives in `chrome.storage.local` rather than page memory precisely so F11's
 * badge poller (a `chrome.alarms` wake → re-snapshot `fleet` → rewrite the badge) can read it later
 * without a second pairing dance. That poller is **not** built here, and this head does not pretend
 * otherwise: with the page closed there is no head, and §6.7 makes that the correct behaviour
 * rather than a gap.
 *
 * This file is an **entrypoint**, so it is one of the two places allowed to name a platform global
 * (`test/dod.test.ts`). Everything it touches — storage, `fetch`, the socket constructor — is
 * narrowed to the structural types in `src/swarm/platform.ts` and handed to code that never sees a
 * global, which is what lets the entire head run in vitest with no browser.
 */

import { browser } from 'wxt/browser'

import type { SwarmStorageArea, WebSocketFactory, WebSocketLike } from '../../src/swarm/platform.ts'

import { createSwarmHead } from '../../src/swarm/head.ts'
import { createSwarmHeadSession } from '../../src/swarm/session.ts'
import { SWARM_LABELS } from '../../src/swarm/ui/labels.ts'
import { glassSwarmPresentation } from '../../src/swarm/ui/presentation.ts'

/**
 * The DOM `WebSocket` narrowed to `WebSocketLike`. It is a real adapter rather than a cast: the
 * browser's handler signatures take `MessageEvent` / `CloseEvent`, and a transport that could read
 * either could reach for a binary frame or an event target — neither of which `swarm.v1` has
 * (§2.2: one JSON object per **text** message).
 */
const webSocketFactory: WebSocketFactory = (url, protocols) => {
  const socket = new WebSocket(url, [...protocols])
  const shim: WebSocketLike = {
    send: (data) => {
      socket.send(data)
    },
    close: (code, reason) => {
      socket.close(code, reason)
    },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  socket.onopen = () => shim.onopen?.(undefined)
  socket.onmessage = (event: MessageEvent<unknown>) => shim.onmessage?.({ data: event.data })
  socket.onclose = (event: CloseEvent) =>
    shim.onclose?.({ code: event.code, reason: event.reason, wasClean: event.wasClean })
  socket.onerror = (event: Event) => shim.onerror?.(event)
  return shim
}

function main(): void {
  const host = document.getElementById('swarm')
  if (host === null) return

  const session = createSwarmHeadSession({
    storage: (browser as unknown as { storage: { local: SwarmStorageArea } }).storage.local,
    /* `http://127.0.0.1/*` is in `host_permissions`, so the extension-context POST bypasses CORS
     * entirely — the swarm server sends no `Access-Control-Allow-Origin` and needs none (§2.1). */
    fetch: (url, init) => fetch(url, init),
    webSocket: webSocketFactory,
    clientName: 'exp-spec extension',
  })

  const head = createSwarmHead({ session })
  const presentation = glassSwarmPresentation({
    pair: (endpoint, code) => {
      void session.pair({ endpoint, code, clientName: 'exp-spec extension' })
    },
    unpair: () => {
      void session.unpair()
    },
  })

  /* A shadow root, so DESIGN's `:host` token discipline is literal and the sheet is contained. */
  const root = host.attachShadow({ mode: 'open' })
  const handle = presentation.mount(
    { root, theme: 'auto' },
    head.vm.get(),
    head.intents,
    SWARM_LABELS,
  )
  /* Kept and called on teardown. `head.destroy()` below stops the head publishing, so dropping
   * this would be benign *today* — which is exactly the kind of reasoning that stops being true
   * the first time someone reorders these three lines. Every other handle here is released
   * symmetrically; this one is not an exception. */
  const unsubscribe = head.vm.subscribe((vm) => {
    presentation.render(handle, vm)
  })

  window.addEventListener('pagehide', () => {
    unsubscribe()
    presentation.destroy(handle)
    head.destroy()
    session.destroy()
  })

  void session.start()
}

main()
