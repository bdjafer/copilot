/**
 * The follow-up bar — the **per-turn control block** (PRODUCT §5, T1–T10; SPEC §4.1, §4.3).
 *
 * This is the product's flagship interaction and the reason the turn is a first-class plane:
 * *changing the effort for one message is one click*. The ladder is drawn permanently, the
 * delegation's own default is the selected segment, and a click on another value applies to **this
 * message only** — omission on the next one reconciles the session back to the delegation default,
 * never to this override (Q4, §5.3.2). That non-stickiness is implemented literally: `pending` is
 * cleared on every successful hand-off to the intent layer.
 *
 * Four normative rules are rendered *before* the click rather than reported after it:
 *
 *  - **§4.3.10 / T1–T2** — `model` and `reasoningEffort` are legal **only** with
 *    `delivery: 'after-turn'`. Pick `interrupt` and both pickers lock, with the reason in `title`.
 *    A picker that lets you choose and then reports `config_not_available_in_mode` has spent the
 *    user's click to teach them a rule the head already knew.
 *  - **§4.3.6** — an effort or model change while the channel is `submitting | accepted |
 *    streaming | interrupting` is refused with `turn_in_flight` and **zero executor calls**. The
 *    same lock, a different sentence.
 *  - **§4.3.4 / S8** — effort is *declared*, never observed: the bar says so permanently, next to
 *    the picker, because a value the product cannot confirm must not be rendered as if it could.
 *  - **§5.3.1 / C7b** — the effective configuration is shown **before** send, computed locally
 *    from the view model with no round trip.
 *
 * The three delivery modes that are not `after-turn` are the steering modes, and steering is what
 * the bar is for while a turn streams: `next-safe-point` and `interrupt` inject into a running
 * turn (T6/T7, landing unobservable — the bar says so), `context-only` stores context and starts
 * no turn at all (T8).
 */

import type { SwarmHeadDelegationVM, SwarmHeadIntents, SwarmHeadViewModel } from '../types.ts'

import {
  el,
  glyphButton,
  segmented,
  setAttr,
  setLabel,
  setSwitch,
  setText,
  switchControl,
} from './dom.ts'

export interface FollowUpBar {
  readonly node: HTMLElement
  render(vm: SwarmHeadViewModel): void
}

const LOCKED_BY_MODE =
  "model and reasoning effort are legal only with delivery 'after-turn' — the other modes exist only while a turn is in flight, which is exactly when a config change is refused"
const LOCKED_BY_TURN =
  'a turn is in flight on this attempt; an effort or model change would be refused with turn_in_flight and would produce zero executor calls'

export function createFollowUpBar(options: {
  doc: Document
  intents: SwarmHeadIntents
}): FollowUpBar {
  const { doc, intents } = options

  let delegationId: string | null = null
  let attemptId: string | null = null
  let defaults: SwarmHeadDelegationVM['defaults'] | null = null
  let pendingEffort: string | null = null
  let pendingModel: string | null = null
  let pendingDelivery: string | null = null
  let sticky = false
  let structured = false
  let locked = false
  let lockReason = ''

  const node = el(doc, 'div', 'cc-compose')

  /* ------------------------------------------------------------------ per-turn controls */

  /* `cc-turn` marks the PER-TURN row: the detail sheet has a lifecycle row of the same shape. */
  const controls = el(doc, 'div', 'cc-controls cc-turn cc-t11')

  const effortLabel = el(doc, 'span', 'cc-muted', 'effort')
  const effort = segmented(doc, 'reasoning effort for this message', (value) => {
    pendingEffort = value
    if (sticky && delegationId !== null)
      intents.updateDefaults(delegationId, { reasoningEffort: value })
    paint()
  })

  /* §4.3.4: the honest label, permanently drawn — never a tooltip nobody opens. */
  const declared = el(doc, 'span', 'cc-hint cc-t10', 'declared, not confirmed')
  declared.title =
    'the executor discards the applied effort and exposes no getter, so this is what was asked for — never what ran'

  const stickyLabel = el(doc, 'span', 'cc-muted', 'default')
  const stickyToggle = switchControl(
    doc,
    'also write the next pick to this delegation’s default, so it applies from now on rather than to one message',
    (next) => {
      sticky = next
      paint()
    },
  )

  const modelLabel = el(doc, 'span', 'cc-muted', 'model')
  const model = el(doc, 'select', 'cc-field cc-t11')
  model.style.inlineSize = 'auto'
  model.setAttribute('aria-label', 'model for this message')
  model.addEventListener('change', () => {
    pendingModel = model.value
    if (sticky && delegationId !== null)
      intents.updateDefaults(delegationId, { model: model.value })
  })

  const deliveryLabel = el(doc, 'span', 'cc-muted', 'delivery')
  const delivery = segmented(doc, 'how this message is delivered', (value) => {
    pendingDelivery = value
    paint()
  })

  const structuredLabel = el(doc, 'span', 'cc-muted', 'structured')
  const structuredToggle = switchControl(
    doc,
    'demand a schema-valid report — true per-turn control, and it may burn corrective turns against this budget (T3)',
    (next) => {
      structured = next
      paint()
    },
  )

  controls.append(
    effortLabel,
    effort.node,
    declared,
    stickyLabel,
    stickyToggle,
    modelLabel,
    model,
    deliveryLabel,
    delivery.node,
    structuredLabel,
    structuredToggle,
  )

  /* ------------------------------------------------------------------------ the field */

  const row = el(doc, 'div', 'cc-compose-row')
  const text = el(doc, 'textarea', 'cc-field cc-t13')
  text.rows = 1
  text.placeholder = 'answer, steer, or ask for a change'
  text.setAttribute('aria-label', 'follow-up message')
  const retract = glyphButton(doc, {
    id: 'retract',
    onPress: () => {
      const turnId = currentTurnId
      if (turnId !== null) intents.retract(turnId)
    },
  })
  const cancelTurn = glyphButton(doc, {
    id: 'cancel-turn',
    onPress: () => {
      if (delegationId !== null) intents.cancel(delegationId, 'turn')
    },
  })
  const send = glyphButton(doc, { id: 'send', tone: 'accent', onPress: submit })
  send.classList.add('cc-disc')
  row.append(text, retract, cancelTurn, send)

  /* §5.3.1's "the effective value MUST be shown before send", and it has its own class because
   * it is the one line a reviewer should be able to find without reading the tree. */
  const effective = el(doc, 'div', 'cc-hint cc-effective cc-t11')

  node.append(controls, row, effective)

  let currentTurnId: string | null = null

  text.addEventListener('input', () => {
    /* Auto-grow 2→8 rows, in place (§8.3). The sheet is the field; the row count is the height. */
    const lines = Math.min(8, Math.max(1, text.value.split('\n').length))
    text.rows = text.value.length === 0 ? 1 : lines
    setAttr(send, 'data-ready', text.value.trim().length > 0 ? '1' : null)
  })
  text.addEventListener('keydown', (event) => {
    const key = event as KeyboardEvent
    if (key.key === 'Enter' && (key.metaKey || key.ctrlKey)) {
      event.preventDefault()
      submit()
      return
    }
    if (key.key === 'Escape' && text.value.length === 0) text.blur()
  })

  function submit(): void {
    const body = text.value.trim()
    if (body.length === 0 || delegationId === null) return
    const mode = pendingDelivery ?? defaults?.delivery ?? 'after-turn'
    const configurable = mode === 'after-turn' && !locked
    intents.sendTurn(delegationId, {
      text: body,
      ...(attemptId === null ? {} : { attemptId }),
      ...(pendingDelivery === null ? {} : { delivery: pendingDelivery }),
      /* Omitted unless the user actually picked: omission is what reconciles the session to the
       * delegation default (Q4), and sending the default back would look identical on the wire but
       * would make the record claim an override the user never asked for. */
      ...(configurable && pendingModel !== null ? { model: pendingModel } : {}),
      ...(configurable && pendingEffort !== null ? { reasoningEffort: pendingEffort } : {}),
      ...(structured ? { structured: true } : {}),
    })
    text.value = ''
    text.rows = 1
    setAttr(send, 'data-ready', null)
    /* Non-sticky at the product level (§5.3.2): the overrides die with the message. */
    pendingEffort = null
    pendingModel = null
    pendingDelivery = null
    structured = false
    paint()
  }

  let lastVm: SwarmHeadViewModel | null = null

  function paint(): void {
    if (lastVm !== null) render(lastVm)
  }

  function render(vm: SwarmHeadViewModel): void {
    lastVm = vm
    const focused = vm.focused
    setAttr(node, 'hidden', focused === null ? '' : null)
    if (focused === null) {
      delegationId = null
      return
    }
    delegationId = focused.id
    attemptId = focused.focusedAttemptId
    defaults = focused.defaults
    currentTurnId = focused.turn?.id ?? null

    const mode = pendingDelivery ?? focused.defaults.delivery
    const turnLocked = focused.turn?.configLocked === true
    locked = turnLocked
    const configLocked = turnLocked || mode !== 'after-turn'
    lockReason = turnLocked ? LOCKED_BY_TURN : LOCKED_BY_MODE

    effort.render(
      focused.ladder,
      pendingEffort ?? focused.defaults.reasoningEffort,
      configLocked,
      lockReason,
    )
    delivery.render(focused.deliveryModes, mode, false)
    setSwitch(stickyToggle, sticky)
    setSwitch(structuredToggle, structured)

    renderModels(vm, focused)
    setAttr(model, 'aria-disabled', configLocked ? 'true' : null)
    model.disabled = configLocked
    setLabel(model, configLocked ? lockReason : 'model for this message')

    /* Turn-scoped controls only exist while there is a turn to act on (§4.3.9, §5.3.8). */
    setAttr(retract, 'hidden', currentTurnId === null ? '' : null)
    setAttr(cancelTurn, 'hidden', focused.turn === null ? '' : null)

    setText(effective, effectiveLine(focused, mode, pendingEffort, pendingModel, structured))
  }

  function renderModels(vm: SwarmHeadViewModel, focused: SwarmHeadDelegationVM): void {
    /* C7/Q18: `HealthVM.routes` is the picker's only source. A route the server calls unavailable
     * is still listed, with its `detail` — hiding it would answer "why can I not pick GPT-5?" with
     * silence. The delegation's own default is always present even when no route reports it. */
    const options = [
      focused.defaults.model,
      ...vm.health.routes.map((route) => route.model),
    ].filter((value, index, all) => all.indexOf(value) === index)
    const signature = options.join(' ')
    if (model.dataset.signature !== signature) {
      model.replaceChildren()
      for (const value of options) {
        const route = vm.health.routes.find((candidate) => candidate.model === value)
        const option = el(doc, 'option', undefined, value)
        option.value = value
        if (route !== undefined && !route.available) {
          option.textContent = `${value} — ${route.detail}`
          option.disabled = true
        }
        model.append(option)
      }
      model.dataset.signature = signature
    }
    const selected = pendingModel ?? focused.defaults.model
    if (model.value !== selected) model.value = selected
  }

  return { node, render }
}

/** §5.3.1: the effective value, computed locally (C7b) and shown before send. */
function effectiveLine(
  focused: SwarmHeadDelegationVM,
  mode: string,
  pendingEffort: string | null,
  pendingModel: string | null,
  structured: boolean,
): string {
  if (mode !== 'after-turn') {
    /* All three record `inherited` — an honest "this turn ran under whatever the previous one
     * set", never a value swarm did not cause (§4.3.10). */
    const landing =
      mode === 'context-only'
        ? 'no turn starts; the message is stored as context'
        : 'landing is unconfirmed — the executor never reports where an interrupt was injected'
    return `${mode} · model and effort inherited · ${landing}`
  }
  const model = pendingModel ?? focused.defaults.model
  const effort = pendingEffort ?? focused.defaults.reasoningEffort ?? 'unset'
  const structure = structured ? ' · structured (up to 2 corrective turns)' : ''
  return `after-turn · ${model} · ${effort} (declared)${structure}`
}
