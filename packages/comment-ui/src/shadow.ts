/**
 * The one shadow root (§5.2 `shadow.ts`, PLAN §3.3).
 *
 * Normative, none of it configurable: **one open shadow root** on `document.documentElement`
 * (open, for debuggability — a closed root would make the UI un-inspectable from devtools and
 * un-assertable from a test); a `pointer-events: none` layer with `auto` on the interactive
 * bits; **the host page's DOM is never mutated** beyond appending this single host element;
 * an explicit `font-size` on `:host` next to `all: initial`.
 *
 * Sheet order is the presentation contract's (§3.1.4 step 1): the dynamic `:host` vars first,
 * then `presentation.css`, then `CommentUIOptions.css`. A presentation that ships no sheet
 * simply skips the middle one — the layer, the vars and the `role="status"` region exist either
 * way, which is what makes `presentation: null` a usable mount rather than a broken one.
 *
 * `isolateEvents` (default true) is WXT's `isolateEvents` by hand: keyboard events bubble out
 * of a shadow root even with retargeting, so a page-level `keydown` handler would otherwise
 * see every character typed into the composer. They are stopped **in the bubble phase at the
 * shadow host**, which is the only interception point that exists for a shadow tree.
 *
 * Residual, documented gap: a **capture-phase** `window` listener still runs before the event
 * reaches the host, so it cannot be stopped from here. That is deliberate — `comment-core`'s
 * own trigger handler is exactly such a listener (§4.5), and it already guards itself with
 * `composedPath()[0]` being an `input`/`textarea`/contenteditable, which the composer is.
 */

import type { ResolvedOptions } from './types.ts'

/** WXT's default isolated set: the events that carry typed input out of the shadow tree. */
const ISOLATED_EVENTS = ['keydown', 'keyup', 'keypress'] as const

export interface Layer {
  host: HTMLElement
  root: ShadowRoot
  /** The `pointer-events: none` container every widget is appended to. */
  layer: HTMLElement
  /** Visually-hidden `role="status"` region for placement hints. */
  status: HTMLElement
  doc: Document
  win: Window
  destroy(): void
}

export function createLayer(options: ResolvedOptions): Layer {
  const container = options.container
  const doc = container.ownerDocument
  const win = doc.defaultView ?? (globalThis as unknown as Window)

  const host = doc.createElement('div')
  host.setAttribute('data-comment-ui', '')
  const root = host.attachShadow({ mode: 'open' })

  // Dynamic `:host` bits kept OUT of any exported sheet so the importable `.css` files stay
  // static and complete. Custom properties survive `all: initial`.
  const vars = doc.createElement('style')
  vars.setAttribute('data-cc', 'vars')
  vars.textContent = `:host{--cc-root-font-size:${options.rootFontSize};--cc-z:${String(options.zIndex)}}`
  root.append(vars)

  const presentationCss = options.presentation?.css
  if (presentationCss) {
    const sheet = doc.createElement('style')
    sheet.setAttribute('data-cc', 'base')
    sheet.textContent = presentationCss
    root.append(sheet)
  }

  if (options.css) {
    const extra = doc.createElement('style')
    extra.setAttribute('data-cc', 'custom')
    extra.textContent = options.css
    root.append(extra)
  }

  const layer = doc.createElement('div')
  layer.className = 'cc-layer'
  root.append(layer)

  const status = doc.createElement('div')
  status.className = 'cc-status'
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  layer.append(status)

  container.append(host)

  const stop = (event: Event): void => {
    event.stopPropagation()
  }
  if (options.isolateEvents) {
    for (const name of ISOLATED_EVENTS) host.addEventListener(name, stop)
  }

  return {
    host,
    root,
    layer,
    status,
    doc,
    win,
    destroy() {
      if (options.isolateEvents) {
        for (const name of ISOLATED_EVENTS) host.removeEventListener(name, stop)
      }
      host.remove()
    },
  }
}
