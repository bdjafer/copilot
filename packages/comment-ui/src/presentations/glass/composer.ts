/**
 * The composer (DESIGN §7 rows 15–17, §8.3) and the **draft pearl**, which is the one idea in
 * this design that is worth more than everything above it: *the composer never loses your words.*
 *
 * Clicking away from a composer with text in it does not discard it and does not leave a modal
 * box pinned over the page — it collapses to a 26 px disc at the anchor, carrying the mode glyph
 * and a 4 px accent dot. Clicking the pearl restores the sheet **and the caret**. `Esc` still
 * discards, because a deliberate cancel must stay one keystroke. The draft already lives in
 * `engine.placement` (the controller writes it on every keystroke), so this is a rendering state
 * and not a second store.
 *
 * The sheet **is** the field: the textarea has no border of its own and the focus ring is on the
 * sheet. `Labels.placeholder` survives as the only thing naming the box; `Labels.send` becomes a
 * 26 px accent disc with a native `title`, and `Labels.dismiss` loses its button entirely —
 * `Esc`, `⌘↵` and click-away are the 3 exits, and the label stays in use on the popover's
 * close control, so nothing leaves the accessibility tree.
 */

import type { ComposerVM, Intents, Labels, PresentationHost } from '../../presentation.ts'

import {
  deepActiveElement,
  el,
  focusables,
  hideFloating,
  safeFocus,
  setAttr,
  showFloating,
} from '../../dom.ts'
import { icon, kindIcon, setIcon } from './icons.ts'
import { transferOrigin, type Rectish } from './motion.ts'

export interface Composer {
  readonly element: HTMLElement
  readonly input: HTMLTextAreaElement
  render(composer: ComposerVM | null, labels: Labels, origin: Rectish | null): void
  destroy(): void
}

export function createComposer(host: PresentationHost, intents: Intents): Composer {
  const { doc, win } = host

  const input = el(doc, 'textarea', { class: 'cc-composer-input', rows: 2 })
  const hint = el(doc, 'span', { class: 'cc-chord', 'aria-hidden': 'true' }, ['⌘', '↵'])
  const send = el(doc, 'button', { type: 'button', class: 'cc-send', 'data-action': 'send' }, [
    icon(doc, 'cc-i-send', 'cc-icon'),
  ])
  const actions = el(doc, 'div', { class: 'cc-composer-actions' }, [hint, send])
  const element = el(
    doc,
    'div',
    {
      class: 'cc-composer cc-glass cc-float',
      popover: 'manual',
      role: 'dialog',
      'data-open': 'false',
    },
    [input, actions],
  )

  const pearlGlyph = icon(doc, 'cc-i-comment', 'cc-icon')
  const pearl = el(
    doc,
    'button',
    { type: 'button', class: 'cc-pearl cc-float', 'data-action': 'restore', hidden: true },
    [pearlGlyph, el(doc, 'span', { class: 'cc-pearl-dot', 'aria-hidden': 'true' })],
  )

  host.layer.append(element, pearl)
  host.anchor('composer', element)

  let open = false
  let busy = false
  let pearled = false
  let draft = ''

  const submit = (): void => {
    // The draft is the controller's. Write the last keystroke through before asking for the send,
    // so a submit can never race the `input` event that carried it.
    intents.setDraft(input.value)
    intents.submitDraft()
  }

  function collapse(next: boolean): void {
    if (next === pearled) return
    pearled = next
    setAttr(pearl, 'hidden', !next)
    setAttr(element, 'data-pearled', next ? 'true' : null)
    if (next) {
      hideFloating(element)
      // The pearl takes over the composer's positioning slot, so it lands exactly where the
      // sheet was rather than needing a second anchor key.
      host.anchor('composer', pearl)
    } else {
      host.anchor('composer', element)
      showFloating(element)
      safeFocus(input)
    }
  }

  pearl.addEventListener('click', () => {
    collapse(false)
    const end = input.value.length
    try {
      input.setSelectionRange(end, end)
    } catch {
      /* no selection model in this DOM */
    }
  })

  input.addEventListener('input', () => {
    draft = input.value
    intents.setDraft(input.value)
    // Optimistic, and load-bearing: the model catches up on the next coalesced pass, but a Send
    // *clicked in the same turn as the keystroke* would find a disabled control and fire nothing.
    // The model still governs — this only anticipates the value it is about to publish.
    setAttr(send, 'disabled', busy || input.value.trim() === '')
    setAttr(element, 'data-empty', input.value.trim() === '' ? 'true' : null)
    grow()
  })
  send.addEventListener('click', submit)

  /** §8.3: 2 → 8 rows. A real `height: auto` transition takes over where the browser has one. */
  function grow(): void {
    input.style.height = 'auto'
    input.style.height = `${String(Math.min(168, Math.max(56, input.scrollHeight)))}px`
  }

  element.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      if (intents.escape()) event.preventDefault()
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
    const active = deepActiveElement(doc)
    if (event.shiftKey && (active === first || !element.contains(active))) {
      event.preventDefault()
      safeFocus(last)
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      safeFocus(first)
    }
  })

  /**
   * Click-outside → pearl. Capture phase on the window, because the host page may stop
   * propagation of anything it likes and this must still be correct; `composedPath()` is what
   * sees through our own shadow boundary.
   */
  function onPointerDown(event: Event): void {
    if (!open || pearled) return
    const path = event.composedPath()
    if (path.includes(element)) return
    // An empty composer has nothing to preserve, so click-away is a plain cancel.
    if (input.value.trim() === '') intents.cancelComposer()
    else collapse(true)
  }
  win.addEventListener('pointerdown', onPointerDown, true)

  return {
    element,
    input,

    render(composer, labels, origin) {
      setAttr(send, 'aria-label', labels.send)
      setAttr(send, 'title', labels.send)
      setAttr(pearl, 'aria-label', labels.placeholder)
      setAttr(pearl, 'title', labels.placeholder)

      if (!composer) {
        draft = ''
        if (pearled) collapse(false)
        if (!open) return
        open = false
        hideFloating(element)
        return
      }

      setAttr(element, 'aria-label', composer.placeholder)
      setAttr(input, 'placeholder', composer.placeholder)
      setAttr(input, 'aria-label', composer.placeholder)
      setIcon(pearlGlyph, kindIcon(composer.kind))
      setAttr(pearl, 'data-kind', composer.kind)

      if (!open) {
        open = true
        input.value = composer.draft
        draft = composer.draft
        showFloating(element)
        // Two reads, once, at open (§6.6). The origin is expressed against the *final* rect, so
        // it survives the positioner's flip/shift for free.
        transferOrigin(element, origin)
        grow()
      }

      busy = composer.busy
      setAttr(element, 'data-busy', composer.busy ? 'true' : 'false')
      setAttr(element, 'data-reply', composer.replyTo)
      setAttr(element, 'data-kind', composer.kind)
      setAttr(element, 'data-empty', composer.draft.trim() === '' ? 'true' : null)
      setAttr(input, 'disabled', composer.busy)
      setAttr(send, 'disabled', !composer.canSubmit)
      // Only write the textarea when the model genuinely diverged: an unconditional assignment
      // would reset the caret on every keystroke.
      if (!composer.busy && input.value !== composer.draft && composer.draft !== draft) {
        input.value = composer.draft
        draft = composer.draft
      }
    },

    destroy() {
      win.removeEventListener('pointerdown', onPointerDown, true)
      host.anchor('composer', null)
      element.remove()
      pearl.remove()
    },
  }
}
