/**
 * The composer (§5.2 `composer.ts`) — a `[popover]` box driven **entirely** by
 * `engine.placement`. Composer state lives in `comment-core` (decision log #21), so the
 * extension, the demo and a custom React host get byte-identical behavior; this file owns
 * pixels, focus and key handling, and nothing else.
 *
 * Accessibility contract (§3, normative): focus moves to the textarea on open, is trapped
 * inside the dialog while it is open, returns to the invoking badge — or to whatever had focus
 * at trigger time — on close, and `Esc` closes it, which also cancels placement.
 */

import type { PlacementState, ThreadView } from '@astrale-os/comment-core'
import type { ReferenceElement } from '@floating-ui/dom'

import type { UIContext } from './context.ts'
import type { Tracker } from './position.ts'

import {
  deepActiveElement,
  el,
  focusables,
  hideFloating,
  safeFocus,
  setAttr,
  showFloating,
} from './dom.ts'
import { centerReference, dockedReference, track } from './position.ts'

export interface Composer {
  readonly element: HTMLElement
  render(state: PlacementState): void
  /** True while the composer owns focus — the Esc chain checks this first. */
  isOpen(): boolean
  destroy(): void
}

interface RangeLike {
  getBoundingClientRect?: () => DOMRect
}

export function createComposer(ctx: UIContext): Composer {
  const input = el(ctx.doc, 'textarea', {
    class: 'cc-composer-input',
    rows: 3,
    placeholder: ctx.labels.placeholder,
    'aria-label': ctx.labels.placeholder,
  })
  const dismiss = el(
    ctx.doc,
    'button',
    { type: 'button', class: 'cc-btn', 'data-action': 'dismiss' },
    [ctx.labels.dismiss],
  )
  const send = el(
    ctx.doc,
    'button',
    { type: 'button', class: 'cc-btn', 'data-variant': 'primary', 'data-action': 'send' },
    [ctx.labels.send],
  )
  const actions = el(ctx.doc, 'div', { class: 'cc-composer-actions' }, [dismiss, send])
  const element = el(
    ctx.doc,
    'div',
    {
      class: 'cc-composer cc-float',
      popover: 'manual',
      role: 'dialog',
      'aria-label': ctx.labels.placeholder,
      'data-open': 'false',
    },
    [input, actions],
  )
  ctx.layer.append(element)

  let tracker: Tracker | null = null
  let refToken: unknown = null
  let open = false
  let returnFocus: HTMLElement | null = null

  function submit(): void {
    if (ctx.engine.placement.get().phase !== 'composing') return
    if (input.value.trim() === '') return
    ctx.engine.placement.submit(input.value).catch((error: unknown) => {
      // §2.12: on failure the controller returns to `composing` with the draft intact, so the
      // box stays open and the user keeps their text. Nothing to render here beyond the error.
      ctx.onError(error)
    })
  }

  function cancel(): void {
    ctx.engine.placement.cancel('dismiss')
  }

  input.addEventListener('input', () => {
    ctx.engine.placement.setDraft(input.value)
    setAttr(send, 'disabled', input.value.trim() === '')
  })
  send.addEventListener('click', submit)
  dismiss.addEventListener('click', cancel)

  element.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      cancel()
      return
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
      return
    }
    if (event.key !== 'Tab') return
    // Focus trap: the composer is a dialog, and Tab must not walk out into the host page.
    const stops = focusables(element)
    if (stops.length === 0) return
    const first = stops[0]
    const last = stops[stops.length - 1]
    const active = deepActiveElement(ctx.doc)
    if (event.shiftKey && (active === first || !element.contains(active))) {
      event.preventDefault()
      safeFocus(last)
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      safeFocus(first)
    }
  })

  function referenceFor(state: Extract<PlacementState, { phase: 'composing' }>): ReferenceElement {
    if (state.replyTo) {
      const badge = ctx.badgeFor(state.replyTo)
      if (badge) return badge
      const view: ThreadView | null = ctx.viewOf(state.replyTo)
      if (view?.anchoring.element) return view.anchoring.element
      if (view?.anchoring.rect) return dockedReference(view.anchoring.rect, ctx.win)
      return centerReference(ctx.win)
    }
    const range = state.range as RangeLike | null
    if (range && typeof range.getBoundingClientRect === 'function') {
      return { getBoundingClientRect: () => range.getBoundingClientRect!() }
    }
    return state.element
  }

  function retrack(state: Extract<PlacementState, { phase: 'composing' }>): void {
    // Rebuild the tracker only when the reference actually changed — an unconditional
    // `autoUpdate` teardown on every render pass would restart the frame loop constantly.
    const token: unknown = state.replyTo
      ? (ctx.badgeFor(state.replyTo) ?? state.replyTo)
      : (state.range ?? state.element)
    if (token === refToken && tracker) return
    refToken = token
    tracker?.destroy()
    tracker = track(referenceFor(state), element, {
      placement: 'bottom-start',
      offset: [0, 8],
      onError: ctx.onError,
    })
  }

  function close(): void {
    if (!open) return
    open = false
    refToken = null
    tracker?.destroy()
    tracker = null
    hideFloating(element)
    const target = returnFocus
    returnFocus = null
    if (target?.isConnected) safeFocus(target)
  }

  return {
    element,

    render(state) {
      if (state.phase !== 'composing' && state.phase !== 'submitting') {
        close()
        return
      }

      if (!open) {
        open = true
        returnFocus =
          (state.replyTo ? ctx.badgeFor(state.replyTo) : null) ?? deepActiveElement(ctx.doc)
        input.value = state.draft
        showFloating(element)
        safeFocus(input)
      }

      const busy = state.phase === 'submitting'
      setAttr(element, 'data-busy', busy ? 'true' : 'false')
      setAttr(element, 'data-reply', state.replyTo ?? null)
      setAttr(element, 'data-kind', state.kind)
      setAttr(input, 'disabled', busy)
      setAttr(dismiss, 'disabled', busy)
      setAttr(send, 'disabled', busy || input.value.trim() === '')

      if (state.phase === 'composing') {
        // Only write the textarea when the controller's draft genuinely diverged: an
        // unconditional assignment would reset the caret on every keystroke.
        if (input.value !== state.draft) input.value = state.draft
        retrack(state)
      }
    },

    isOpen: () => open,

    destroy() {
      close()
      element.remove()
    },
  }
}
