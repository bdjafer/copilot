/**
 * The composer — a `[popover]` box driven **entirely** by `ComposerVM`. Composer state was never
 * this layer's (decision log #21) and after the split it is not even reachable: this file owns
 * pixels, focus mechanics and key handling, and nothing else.
 *
 * Accessibility contract (§3, normative, enforced by the conformance suite): focus moves to the
 * textarea on open — on the controller's instruction, via `vm.focus` — is trapped inside the
 * dialog while it is open, and `Esc` closes it. Where focus *returns* is policy, so it is the
 * controller's; this file only ever reports the keystroke through `intents.escape()`.
 */

import type { ComposerVM, Intents, Labels, PresentationHost } from '../../presentation.ts'

import {
  deepActiveElement,
  el,
  focusables,
  hideFloating,
  safeFocus,
  setAttr,
  setText,
  showFloating,
} from '../../dom.ts'

export interface Composer {
  readonly element: HTMLElement
  readonly input: HTMLTextAreaElement
  render(composer: ComposerVM | null, labels: Labels): void
  destroy(): void
}

export function createComposer(host: PresentationHost, intents: Intents): Composer {
  const { doc } = host
  const input = el(doc, 'textarea', { class: 'cc-composer-input', rows: 3 })
  const dismiss = el(doc, 'button', {
    type: 'button',
    class: 'cc-btn',
    'data-action': 'dismiss',
  })
  const send = el(doc, 'button', {
    type: 'button',
    class: 'cc-btn',
    'data-variant': 'primary',
    'data-action': 'send',
  })
  const actions = el(doc, 'div', { class: 'cc-composer-actions' }, [dismiss, send])
  const element = el(
    doc,
    'div',
    {
      class: 'cc-composer cc-float',
      popover: 'manual',
      role: 'dialog',
      'data-open': 'false',
    },
    [input, actions],
  )
  host.layer.append(element)
  host.anchor('composer', element)

  let open = false
  let busy = false

  const submit = (): void => {
    // The draft is the controller's; write the last keystroke through before asking for the
    // send, so a submit can never race the `input` event that carried it.
    intents.setDraft(input.value)
    intents.submitDraft()
  }

  input.addEventListener('input', () => {
    intents.setDraft(input.value)
    // Optimistic, and load-bearing: the model catches up on the next coalesced pass, but a Send
    // *clicked in the same turn as the keystroke* would find a disabled button and fire nothing.
    // The model still governs — this only ever anticipates the value it is about to publish.
    setAttr(send, 'disabled', busy || input.value.trim() === '')
  })
  send.addEventListener('click', submit)
  dismiss.addEventListener('click', () => {
    intents.cancelComposer()
  })

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

  return {
    element,
    input,

    render(composer, labels) {
      setText(dismiss, labels.dismiss)
      setText(send, labels.send)
      if (!composer) {
        if (!open) return
        open = false
        hideFloating(element)
        return
      }

      setAttr(element, 'aria-label', composer.placeholder)
      setAttr(input, 'placeholder', composer.placeholder)
      setAttr(input, 'aria-label', composer.placeholder)
      if (!open) {
        open = true
        input.value = composer.draft
        showFloating(element)
      }

      busy = composer.busy
      setAttr(element, 'data-busy', composer.busy ? 'true' : 'false')
      setAttr(element, 'data-reply', composer.replyTo)
      setAttr(element, 'data-kind', composer.kind)
      setAttr(input, 'disabled', composer.busy)
      setAttr(dismiss, 'disabled', composer.busy)
      setAttr(send, 'disabled', !composer.canSubmit)
      // Only write the textarea when the model's draft genuinely diverged: an unconditional
      // assignment would reset the caret on every keystroke.
      if (!composer.busy && input.value !== composer.draft) input.value = composer.draft
    },

    destroy() {
      host.anchor('composer', null)
      element.remove()
    },
  }
}
