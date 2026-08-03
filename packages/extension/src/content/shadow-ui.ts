/**
 * The WXT `createShadowRootUi` glue — the only file in `src/` that imports `wxt/*`.
 *
 * Kept to a thin adapter on purpose: everything it wraps (`mountHostChrome`) renders into any
 * `ParentNode`, so the pill, the toast and their behaviour are unit-tested without a browser
 * and only this shell is manual-test territory.
 *
 * The stylesheet is handed over inline as the `css` option, so it lives inside this shadow root
 * and the entrypoint declares **no** `cssInjectionMode`: `'ui'` makes WXT `fetch` a per-
 * entrypoint `content-scripts/content.css` that this entrypoint never emits (it imports no
 * stylesheet), which logged a "Failed to load styles" warning on every page for no benefit.
 * `isolateEvents` stops the pill's keystrokes from reaching the page's own shortcut handlers.
 */

import type { ContentScriptContext } from 'wxt/utils/content-script-context'

import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root'

import type { HostChrome, HostChromeOptions } from './pill.ts'

import { hostChromeStyles, mountHostChrome } from './pill.ts'

export async function mountShadowHostChrome(
  ctx: ContentScriptContext,
  options: HostChromeOptions,
): Promise<HostChrome> {
  let chrome: HostChrome | undefined

  const ui = await createShadowRootUi(ctx, {
    name: 'exp-spec-host',
    position: 'inline',
    // The content script runs at `document_start`, where `document.body` is **null** — and
    // WXT's default anchor is exactly `document.body`, so `mountUi` throws "could not find
    // anchor element" whenever the parser has not reached `<body>` yet. The only thing between
    // the two is `createShadowRootUi`'s own awaits, which is a race against the page's `<head>`,
    // not a guarantee. `documentElement` exists from the first byte, and the overlay is
    // `position: fixed`, so what it hangs off is irrelevant.
    anchor: 'html',
    // WXT's default `all: initial` reset does not cover the page's `<html>` font-size, so
    // `hostChromeStyles` pins `font-size: 16px` on the host and uses no rem-relative units.
    css: hostChromeStyles,
    isolateEvents: true,
    onMount: (container) => {
      chrome = mountHostChrome(container, options)
      return chrome
    },
    onRemove: (mounted) => mounted?.destroy(),
  })

  ui.mount()
  if (!chrome) throw new Error('exp-spec: shadow host chrome failed to mount')

  const mounted = chrome
  return {
    ...mounted,
    get pendingCount() {
      return mounted.pendingCount
    },
    destroy() {
      // `ui.remove()` runs `onRemove`, which already calls `mounted.destroy()`; calling both
      // would remove an already-detached node (harmless) and clear an already-cleared timer.
      ui.remove()
    },
  }
}
