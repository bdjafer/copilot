/**
 * `glassSwarmPresentation` — the head's renderer, and a **real** `SwarmPresentation` (§6.8, H6).
 *
 * `mount(host, vm, intents, labels)` / `render(handle, vm)` / `destroy(handle)` is the whole
 * interface, and this module honours it literally: it receives one frozen view model and one
 * void-returning intents object, and it can reach neither the client, nor the wire, nor the store.
 * PRODUCT §3 gives the extension ownership of rendering, so this renderer is richer than the seam's
 * reference would be — but it is still *only* a renderer, and the compile-time proof lives in
 * `../types.ts`.
 *
 * Two things the seam has no field for arrive as constructor options rather than as intents, on
 * purpose: **pairing** and **unpairing** are credential operations, not fleet operations, and a
 * `SwarmIntents` that could drop a token would make every renderer a security surface.
 *
 * The surface is DESIGN's, applied to a fleet console:
 *
 *  - **§0 D6** — no header, no logo row, no title bar. The fleet strip floats; the detail sheet's
 *    close mark floats in its corner over a reserved gutter.
 *  - **§0 D4** — the composer and the follow-up bar are permanently rendered collapsed fields at
 *    the bottom edge of their own surface, expanding in place. There is no modal anywhere.
 *  - **§0 D2 / P0** — nothing inside an opened surface is hidden and then restored on hover. Every
 *    metadata row (state, effective config, base revision, spend, channel, timestamps) is drawn
 *    unconditionally; hover only ever *adds* a native `title`.
 *  - **§7's dismissal chain** — one `Esc` does exactly one thing: an expanded composer collapses,
 *    else the open delegation closes, else the event is left alone and the page keeps it.
 *  - **§3.2's kill switches** — glass degrades to solid under reduced transparency, more contrast
 *    and `forced-colors`, without a host opt-out.
 */

import type { SwarmLabels } from '@astrale-os/swarm/presentation'

import type { SwarmHeadIntents, SwarmHeadPresentation, SwarmHeadViewModel } from '../types.ts'

import { createComposer } from './composer.ts'
import { createDetailView } from './detail.ts'
import { createArmRegistry, el, setAttr } from './dom.ts'
import { createFleetView } from './fleet.ts'
import { createHonestyPanel, createNoticeStack } from './notices.ts'
import { createPairingView } from './pairing.ts'
import { buildSprite } from './sprite.ts'
import { swarmGlassStyles } from './styles.ts'

export interface SwarmPresentationOptions {
  /** Credential operations — session-level, deliberately not on `SwarmIntents`. */
  pair(endpoint: string, code: string): void
  unpair(): void
  /** Injected, as everywhere else in this head. */
  now?: () => number
}

interface Handle {
  readonly render: (vm: SwarmHeadViewModel) => void
  readonly destroy: () => void
}

export function glassSwarmPresentation(options: SwarmPresentationOptions): SwarmHeadPresentation {
  return {
    mount(host, vm, intents, labels) {
      return build(host.root, vm, intents, labels, host.theme, options)
    },
    render(handle, vm) {
      ;(handle as Handle).render(vm)
    },
    destroy(handle) {
      ;(handle as Handle).destroy()
    },
  }
}

function build(
  root: ShadowRoot | HTMLElement,
  initial: SwarmHeadViewModel,
  intents: SwarmHeadIntents,
  labels: SwarmLabels,
  theme: 'light' | 'dark' | 'auto',
  options: SwarmPresentationOptions,
): Handle {
  /* The one place a `Document` is obtained, and it comes from the host's own node — no module in
   * this head ever names a platform global (`test/dod.test.ts`). */
  const doc = root.ownerDocument
  const now = options.now ?? (() => Date.now())

  const style = doc.createElement('style')
  style.textContent = swarmGlassStyles
  const sprite = buildSprite(doc)

  const surface = el(doc, 'div', 'cc-app')
  /* §2.5: polarity is a data attribute on our own layer, never a write to the host. */
  if (theme !== 'auto') surface.dataset.polarity = theme

  const arm = createArmRegistry(doc)
  const honesty = createHonestyPanel(doc)
  const composer = createComposer({ doc, intents })
  const fleet = createFleetView({
    doc,
    intents,
    arm,
    onHonesty: () => {
      honesty.toggle()
      paint()
    },
    onUnpair: options.unpair,
  })
  const detail = createDetailView({ doc, intents, arm, now })
  const notices = createNoticeStack({ doc, intents })
  const pairing = createPairingView({ doc, onPair: options.pair })

  const left = el(doc, 'div', 'cc-col')
  left.append(fleet.node, honesty.node, composer.node)
  surface.append(left, detail.node, notices.node)

  const app = el(doc, 'div')
  app.style.blockSize = '100%'
  app.append(pairing.node, surface)

  /* One `Esc` does exactly one thing (DESIGN §7): the expanded composer collapses first, then the
   * open delegation closes, and with neither open the event is left untouched for the page. */
  const onKeyDown = (event: Event): void => {
    if ((event as KeyboardEvent).key !== 'Escape') return
    arm.disarm()
    const active = doc.activeElement
    if (active !== null && app.contains(active) && active.tagName === 'TEXTAREA') return
    if (current.focused === null) return
    event.preventDefault()
    intents.escape()
  }
  /* Any click in the surface disarms whatever was armed (§6.4). The listener is on the container,
   * in the bubble phase, so a confirming click on the armed control itself still lands first. */
  const onPointerDown = (event: Event): void => {
    const target = event.target
    if (target instanceof Element && target.closest('[data-confirm]') !== null) return
    arm.disarm()
  }

  app.addEventListener('keydown', onKeyDown)
  app.addEventListener('pointerdown', onPointerDown)

  root.append(style, sprite, app)

  let current = initial
  const render = (vm: SwarmHeadViewModel): void => {
    current = vm
    const live = vm.pairing.phase === 'live'
    setAttr(pairing.node, 'hidden', live ? '' : null)
    setAttr(surface, 'hidden', live ? null : '')
    pairing.render(vm)
    if (!live) return
    setAttr(surface, 'data-detail', vm.focused === null ? '0' : '1')
    fleet.render(vm)
    honesty.render(vm)
    composer.render(vm)
    detail.render(vm)
    notices.render(vm)
  }
  const paint = (): void => {
    render(current)
  }

  /* `labels` is the accessibility layer, not a visual one (§10) — the composer's placeholder is
   * one of the three strings that are actually drawn. */
  const placeholder = app.querySelector('textarea')
  if (placeholder !== null) placeholder.placeholder = labels.placeholder

  render(initial)

  return {
    render,
    destroy() {
      app.removeEventListener('keydown', onKeyDown)
      app.removeEventListener('pointerdown', onPointerDown)
      arm.destroy()
      style.remove()
      sprite.remove()
      app.remove()
    },
  }
}
