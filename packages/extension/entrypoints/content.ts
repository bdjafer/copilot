/**
 * Content script entrypoint — `<all_urls>`, `document_start`.
 *
 * `document_start` is for the key listener: `comment-core` registers its trigger on `window` in
 * the capture phase, and a script that runs at `document_idle` misses every keypress a
 * slow-loading page swallows first. The engine itself waits for the store load and the first
 * anchoring pass, so nothing here needs `DOMContentLoaded`.
 *
 * There is deliberately **no `cssInjectionMode`**. `'ui'` makes `createShadowRootUi` `fetch`
 * `/content-scripts/content.css`, which this entrypoint never emits (it imports no stylesheet):
 * the host-chrome sheet is handed to `createShadowRootUi` inline as its `css` option instead.
 * The setting bought nothing and logged "Failed to load styles @ …" on every page on the web.
 */

import { browser } from 'wxt/browser'

import type { RuntimeLike, StorageLike } from '../src/platform.ts'

import { startContent } from '../src/content/index.ts'
import { mountShadowHostChrome } from '../src/content/shadow-ui.ts'
import { createStorageKv } from '../src/kv.ts'
import { createMessenger } from '../src/messaging.ts'

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  async main(ctx) {
    const platform = browser as unknown as { storage: StorageLike; runtime: RuntimeLike }

    const handle = await startContent({
      kv: createStorageKv(platform.storage, {
        // The one place a console line earns its keep: `getKeys()` is missing, so every
        // prefix scan now deserializes the whole storage area. There is no other channel to
        // say so — and staying silent is how a 10× slowdown becomes "the extension feels slow".
        // eslint-disable-next-line no-console -- deliberate one-shot degradation notice
        onDegraded: (reason) => console.warn('[exp-spec]', reason),
      }),
      messenger: createMessenger(),
      // The token-relay port (PLAN §4.5). `startContent` opens it only while a thread on this
      // page is busy — an always-open port from every tab would keep the worker alive forever.
      runtime: platform.runtime,
      mountChrome: (handlers) => mountShadowHostChrome(ctx, handlers),
    })

    // SPA navigation inside the same document tears the script down without unloading it.
    ctx.onInvalidated(() => handle.destroy())
  },
})
