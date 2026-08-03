/**
 * PLAN §5's host chrome: the "N comments — Send to copilot" pill, plus the toast a batch run's
 * summary is surfaced in.
 *
 * This is the **host's own overlay**, not a `comment-ui` widget — decision log #22 rejects slots,
 * and §3 of SPEC-comment-core states normatively that host chrome is the host's. It renders into
 * whatever container it is handed (a WXT shadow root in the extension, a bare `<div>` in a test),
 * so nothing here needs a browser to exercise.
 *
 * Rendered **below** `CommentUIOptions.zIndex` (default 2147483000) so a thread popover always
 * wins the stacking contest against the pill.
 */

export const HOST_CHROME_Z_INDEX = 2147482000

/**
 * Written as a string rather than a file so it can be handed to `createShadowRootUi`'s `css`
 * option, injected into a plain container in a test, and asserted on — the same shape
 * `comment-ui` uses for its own sheet.
 *
 * **No `rem` anywhere below, and that rule is load-bearing.** `all: initial` on `:host` does not
 * reach the page's `<html>`, and `rem` always resolves against the document root — so on any
 * site using the `html { font-size: 62.5% }` idiom every `rem` here would render at 10px-scale.
 * The `font-size: 16px` pin below only fixes the host's own inherited size; absolute `px` on
 * each rule is what makes the rest safe. `test/content.test.ts` asserts the absence, not just
 * the pin, because the pin alone is what the old comment claimed and it was not enough.
 */
export const hostChromeStyles = `
:host, .cc-host {
  all: initial;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  font-size: 16px;
  color-scheme: light dark;
}
.cc-host {
  position: fixed;
  inset: auto 16px 16px auto;
  z-index: ${HOST_CHROME_Z_INDEX};
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  pointer-events: none;
}
.cc-host > * { pointer-events: auto; }
.cc-pill[hidden], .cc-toast[hidden] { display: none; }
.cc-pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 8px 14px;
  border-radius: 999px;
  background: var(--cc-surface, #ffffff);
  color: var(--cc-text, #111827);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  font-size: 14px;
  line-height: 1.2;
}
.cc-pill-count { font-weight: 600; }
.cc-pill-send {
  all: unset;
  cursor: pointer;
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--cc-accent, #6366f1);
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
}
.cc-pill-send[disabled] { opacity: 0.55; cursor: default; }
.cc-pill-dismiss {
  all: unset;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 999px;
  color: var(--cc-muted, #6b7280);
  font-size: 13px;
}
.cc-toast {
  max-width: 380px;
  padding: 10px 14px;
  border-radius: 10px;
  background: var(--cc-surface, #ffffff);
  color: var(--cc-text, #111827);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
  font-size: 14px;
  line-height: 1.4;
  white-space: pre-wrap;
}
.cc-toast[data-tone="warn"] { border-left: 3px solid var(--cc-warn, #d97706); }
@media (prefers-color-scheme: dark) {
  .cc-pill, .cc-toast { background: #1f2430; color: #e5e7eb; }
  .cc-pill-dismiss { color: #9ca3af; }
}
`

export interface HostChromeOptions {
  onSend(): void
  onDismiss?(): void
  /** Injected so the toast timer is assertable without real timers. */
  setTimeout?(handler: () => void, ms: number): number
  clearTimeout?(handle: number): void
}

/**
 * Constants, not an option. This overlay is bridge-owned chrome with exactly one caller and no
 * localization story; a `labels` override would be a second place for the pill's wording to live
 * and a second thing to keep in step with `defaultLabels` in `comment-ui`.
 */
const LABELS = { send: 'Send to copilot', dismiss: 'Dismiss', sending: 'Sending…' }

/** Toast dwell time. Long enough to read two sentences, short enough not to sit on the page. */
export const TOAST_MS = 8000

export function mountHostChrome(container: ParentNode & Node, options: HostChromeOptions) {
  // A ParentNode is either a Document (ownerDocument is null, per DOM) or a node inside one.
  const doc = container.ownerDocument ?? (container as Document)
  const setTimer = options.setTimeout ?? ((handler, ms) => setTimeout(handler, ms) as never)
  const clearTimer = options.clearTimeout ?? ((handle: number) => clearTimeout(handle))

  const root = doc.createElement('div')
  root.className = 'cc-host'
  root.setAttribute('data-copilot-host', '')

  const pill = doc.createElement('div')
  pill.className = 'cc-pill'
  pill.setAttribute('role', 'status')
  // aria-live on the pill, not the toast: the count changes as you comment, and that is the
  // thing a screen-reader user needs announced without moving focus.
  pill.setAttribute('aria-live', 'polite')
  pill.hidden = true

  const count = doc.createElement('span')
  count.className = 'cc-pill-count'

  const send = doc.createElement('button')
  send.type = 'button'
  send.className = 'cc-pill-send'
  send.textContent = LABELS.send
  send.addEventListener('click', () => {
    if (send.disabled) return
    options.onSend()
  })

  const dismiss = doc.createElement('button')
  dismiss.type = 'button'
  dismiss.className = 'cc-pill-dismiss'
  dismiss.textContent = LABELS.dismiss
  dismiss.setAttribute('aria-label', LABELS.dismiss)
  dismiss.addEventListener('click', () => options.onDismiss?.())

  pill.append(count, send, dismiss)

  const toast = doc.createElement('div')
  toast.className = 'cc-toast'
  toast.setAttribute('role', 'status')
  toast.hidden = true

  root.append(toast, pill)
  container.appendChild(root)

  let toastTimer: number | undefined
  let pending = 0

  const render = (): void => {
    pill.hidden = pending === 0
    count.textContent = `${pending} comment${pending === 1 ? '' : 's'}`
  }

  return {
    root,
    setPendingCount(next: number): void {
      pending = Math.max(0, next)
      render()
    },
    setSending(sending: boolean): void {
      send.disabled = sending
      send.textContent = sending ? LABELS.sending : LABELS.send
    },
    toast(text: string, tone: 'info' | 'warn' = 'info'): void {
      if (toastTimer !== undefined) clearTimer(toastTimer)
      toast.textContent = text
      toast.setAttribute('data-tone', tone)
      toast.hidden = false
      toastTimer = setTimer(() => {
        toast.hidden = true
        toastTimer = undefined
      }, TOAST_MS)
    },
    get pendingCount(): number {
      return pending
    },
    destroy(): void {
      if (toastTimer !== undefined) clearTimer(toastTimer)
      toastTimer = undefined
      root.remove()
    },
  }
}

export type HostChrome = ReturnType<typeof mountHostChrome>

/**
 * A host chrome that renders nowhere, for the one case where mounting fails.
 *
 * The overlay is the *least* important of the content script's four duties, and it is the only
 * one that touches the page's DOM at `document_start` — so a mount failure must cost the pill
 * and nothing else. Without this, the rejected `mountChrome` propagates out of `startContent`
 * and takes the DOM tool endpoints, the chip handlers, the trigger route and the settings watch
 * with it: a page where comments still work and the copilot is silently absent.
 */
export function nullHostChrome(doc: Document): HostChrome {
  const root = doc.createElement('div')
  let pending = 0
  return {
    root,
    setPendingCount(next: number): void {
      pending = Math.max(0, next)
    },
    setSending(): void {},
    toast(): void {},
    get pendingCount(): number {
      return pending
    },
    destroy(): void {},
  }
}
