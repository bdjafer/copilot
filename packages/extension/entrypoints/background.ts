/**
 * MV3 service worker entrypoint.
 *
 * All it does is call `startBackground` **synchronously**, with the real platform objects. That
 * is the whole point of the split: MV3 only wakes a terminated worker for listeners registered
 * in the first turn of initial evaluation, and a `defineBackground` body that awaited anything
 * before `startBackground` would forfeit every wake event.
 */

import { browser } from 'wxt/browser'

import type { BackgroundPlatform } from '../src/platform.ts'

import { startBackground } from '../src/background/index.ts'
import { createTabRouter } from '../src/background/tabs.ts'
import { createStorageKv } from '../src/kv.ts'
import { createMessenger } from '../src/messaging.ts'

const COMMAND_KINDS: Record<string, string> = {
  'place-comment': 'comment',
  'place-ask': 'ask',
}

export default defineBackground({
  // A module worker keeps `import` working and matches how vite builds the bundle.
  type: 'module',
  main() {
    // `browser` is `globalThis.chrome` in Chrome; the structural port types in `src/platform.ts`
    // are satisfied by the real object, so nothing is adapted at this boundary.
    const platform = browser as unknown as BackgroundPlatform
    const messenger = createMessenger()

    startBackground({
      kv: createStorageKv(platform.storage, {
        // The one place a console line earns its keep: `getKeys()` is missing, so every
        // prefix scan now deserializes the whole storage area. There is no other channel to
        // say so — and staying silent is how a 10× slowdown becomes "the extension feels slow".
        // eslint-disable-next-line no-console -- deliberate one-shot degradation notice
        onDegraded: (reason) => console.warn('[exp-spec]', reason),
      }),
      messenger,
      runtime: platform.runtime,
      alarms: platform.alarms,
      tabs: createTabRouter(platform.tabs),
      setInterval: (handler, ms) => setInterval(handler, ms) as unknown as number,
      clearInterval: (handle) => clearInterval(handle),
    })

    // `chrome.commands` cannot bind a bare letter (PLAN §8), so the manifest's two commands are
    // a backup path into the same `startPlacement` the page's key listener uses.
    platform.commands?.onCommand.addListener((command) => {
      const kind = COMMAND_KINDS[command]
      if (kind === undefined) return
      void browser.tabs
        .query({ active: true, currentWindow: true })
        .then((tabs) => {
          const tabId = tabs[0]?.id
          return tabId === undefined ? undefined : messenger.sendMessage('trigger', { kind }, tabId)
        })
        .catch(() => {})
    })
  },
})
