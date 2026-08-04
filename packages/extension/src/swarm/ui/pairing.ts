/**
 * The pairing screen (SPEC-swarm §2.1, PRODUCT S2–S5).
 *
 * `swarm serve` prints an 8-char code; this exchanges it, once, for a token that never expires and
 * is only revoked. Everything about that flow is one screen because it is one decision, and it is
 * the **only** screen this head shows while unpaired: a fleet console that renders empty buckets
 * to a user who has not paired is a console that looks broken.
 *
 * Two honesty details are drawn rather than assumed:
 *
 *  - the endpoint is part of the credential — a token issued by the server on :7717 means nothing
 *    to another one, and re-pointing the head with the old token is an `unauthenticated` close;
 *  - the code is normalized before it is sent (dashes stripped, upper-cased), because the server
 *    prints `K7QF-2M9X` and compares `K7QF2M9X`, and making the human delete the dash the product
 *    printed is a way to spend one of their five attempts.
 *
 * `pair` and `unpair` are **not** `SwarmHeadIntents` — they are session-level, not fleet-level, and
 * putting them on the intents object would let a renderer drop a credential. This screen owns
 * pairing; **unpairing lives in the fleet strip**, because a paired head never shows this screen
 * again and a control you can only reach by first losing your credential is not a control.
 */

import type { SwarmHeadViewModel } from '../types.ts'

import { el, glyphButton, setAttr, setText } from './dom.ts'
import { glyph } from './sprite.ts'

export interface PairingView {
  readonly node: HTMLElement
  render(vm: SwarmHeadViewModel): void
}

export function createPairingView(options: {
  doc: Document
  onPair(endpoint: string, code: string): void
}): PairingView {
  const { doc } = options

  const node = el(doc, 'div', 'cc-pair')
  const card = el(doc, 'div', 'cc-pair-card cc-glass')

  const mark = glyph(doc, 'cc-i-stack', 20)
  mark.classList.add('cc-mark')
  const heading = el(doc, 'div', 'cc-t17', 'swarm')
  const lede = el(doc, 'div', 'cc-t11 cc-muted')
  lede.textContent =
    'run `swarm serve` on this machine; it prints an 8-character code that is good for five minutes and one use'

  const endpoint = el(doc, 'input', 'cc-field cc-t13')
  endpoint.setAttribute('aria-label', 'server endpoint')
  endpoint.placeholder = 'http://127.0.0.1:7717'

  const codeRow = el(doc, 'div', 'cc-pair-row')
  const code = el(doc, 'input', 'cc-field cc-t15 cc-num')
  code.setAttribute('aria-label', 'pairing code')
  code.placeholder = 'K7QF-2M9X'
  code.autocapitalize = 'characters'
  code.spellcheck = false
  const submit = glyphButton(doc, {
    id: 'pair',
    tone: 'accent',
    onPress: pair,
  })
  submit.classList.add('cc-disc')
  codeRow.append(code, submit)

  const error = el(doc, 'div', 'cc-error cc-t11')
  const status = el(doc, 'div', 'cc-t11 cc-muted')

  card.append(mark, heading, lede, endpoint, codeRow, error, status)
  node.append(card)

  code.addEventListener('input', () => {
    setAttr(submit, 'data-ready', code.value.trim().length > 0 ? '1' : null)
  })
  code.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Enter') return
    event.preventDefault()
    pair()
  })

  function pair(): void {
    const value = code.value.trim()
    if (value.length === 0) return
    options.onPair(
      endpoint.value.trim().length === 0 ? endpoint.placeholder : endpoint.value.trim(),
      value,
    )
    code.value = ''
    setAttr(submit, 'data-ready', null)
  }

  return {
    node,
    render(vm) {
      const pairing = vm.pairing
      if (endpoint.value.length === 0 && pairing.endpoint.length > 0)
        endpoint.value = pairing.endpoint
      setText(error, pairing.error ?? '')
      setAttr(error, 'hidden', pairing.error === null ? '' : null)
      setText(status, pairing.phase === 'pairing' ? 'exchanging the code…' : '')
      mark.classList.toggle('cc-live', pairing.phase === 'pairing' || pairing.phase === 'loading')
    },
  }
}
