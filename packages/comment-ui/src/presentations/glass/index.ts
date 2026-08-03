/**
 * `glassPresentation()` — the product's intended appearance, and the executable form of
 * `docs/DESIGN.md`.
 *
 * It is a **second** implementation of the same `Presentation` contract the default appearance
 * implements, which is the whole payoff of the inverse-DI split: every rule that took the
 * controller suite to get right — `pending` renders nothing, resolved hides, orphans dock, the
 * Esc chain, chip precedence, the decoration lifecycle, coalescing — is untouched here and
 * cannot be opted out of, because none of it is reachable from this file. What is left is
 * pixels, and pixels are all this directory contains.
 *
 * The design's five laws, and where each one lives:
 *
 *  1. *Nothing exists until intent is expressed.* `intent.ts` (proximity) plus the `data-reveal`
 *     / `data-near` / `:hover` / `:focus-visible` cascade in `styles.ts`.
 *  2. *Legibility is contract; glass is decoration.* A trio of hardcoded kill switches plus an
 *     opacity floor the sheet never crosses, in `styles.ts`. No host opt-out, deliberately.
 *  3. *Colour never carries state alone.* Every state also draws a glyph (`chip.ts`, `icons.ts`).
 *  4. *We are spending someone else's frame budget.* Only compositor properties animate, and
 *     `will-change` lives exactly as long as a transition does (`motion.ts`).
 *  5. *Text is the failure mode.* Verbs and nouns are icons with a native `title`; the visible
 *     strings are values (a body, a count, a result) and the one string naming the composer.
 *
 * The options bag is **not** part of the theming surface. Theming is the eleven `--cc-*` custom
 * properties and nothing else: a host says what their brand is, not how transparent our glass
 * gets. All 3 fields below are rendering choices with defensible defaults, and none of them is
 * reachable from the controller.
 */

import type {
  Intents,
  Point,
  Presentation,
  PresentationHost,
  PresentationInstance,
  UIViewModel,
} from '../../presentation.ts'
import type { ProximityTarget } from './intent.ts'
import type { HueOf } from './kind.ts'
import type { Rectish } from './motion.ts'
import type { Panel } from './panel.ts'

import { safeFocus, setAttr } from '../../dom.ts'
import { createBadgeLayer } from './badge.ts'
import { createComposer } from './composer.ts'
import { createSprite } from './icons.ts'
import { createIntentTracker, createPolarityWatcher } from './intent.ts'
import { createHueOf } from './kind.ts'
import { prefersReducedMotion } from './motion.ts'
import { createPanel } from './panel.ts'
import { createPicker } from './picker.ts'
import { glassStyles } from './styles.ts'
import { createThreadPopover } from './thread.ts'

export interface GlassOptions {
  /** Force the reduced-motion mapping on or off. Default: follow `prefers-reduced-motion`. */
  reduceMotion?: boolean
  /** Force the widget's polarity. Default `auto`: follow the *page*, not the desktop (§2.5). */
  polarity?: 'auto' | 'light' | 'dark'
  /** `none` skips the sprite, for a host that already ships the 18 `cc-i-*` symbol ids. */
  icons?: 'sprite' | 'none'
}

/** §6.6: a click point is a zero-size rect, so origin transfer needs no second code path. */
function pointOrigin(point: Point): Rectish {
  return { x: point.x, y: point.y, width: 0, height: 0 }
}

function createInstance(
  host: PresentationHost,
  intents: Intents,
  options: GlassOptions,
): PresentationInstance {
  const reduced = prefersReducedMotion(host.win, options.reduceMotion)
  const polarity = createPolarityWatcher(host.doc, host.win, host.layer, options.polarity ?? 'auto')
  setAttr(host.layer, 'data-motion', reduced ? 'reduce' : null)

  let sprite: SVGSVGElement | null = null
  if (options.icons !== 'none') {
    sprite = createSprite(host.doc)
    host.root.append(sprite)
  }

  const badges = createBadgeLayer(host, intents)
  const composer = createComposer(host, intents)
  const thread = createThreadPopover(host, intents)
  const picker = createPicker(host)
  const tracker = createIntentTracker(host.win, host.layer)
  let panel: Panel | null = null
  let lastFocus = -1
  /** The last cursor point of a pick — the composer's morph origin after the click (§8.3). */
  let pickPoint: Point | null = null
  /** §2.3's hue table, rebuilt only when the engine's mode list itself changes identity. */
  let kinds: readonly string[] = []
  let hueOf: HueOf = createHueOf(kinds)

  /**
   * Apply the target whenever `focus.seq` changes, then do nothing until it changes again.
   * Monotonic and idempotent, so a re-render can never re-steal focus.
   */
  function applyFocus(vm: UIViewModel): void {
    const request = vm.focus
    if (!request || request.seq === lastFocus) return
    lastFocus = request.seq
    const target = request.target
    if (target.kind === 'composer-input') safeFocus(composer.input)
    else if (target.kind === 'thread-close') safeFocus(thread.close)
    else if (target.kind === 'panel-toggle') safeFocus(panel?.toggle)
    else safeFocus(badges.elementFor(target.threadId))
  }

  return {
    update(vm) {
      polarity.refresh()
      // The model is referentially stable, so this rebuilds only when `engine.modes` did.
      if (vm.kinds !== kinds) {
        kinds = vm.kinds
        hueOf = createHueOf(kinds)
      }
      badges.render(vm.badges, hueOf, reduced)

      // §6.6 **point persistence**: the pin's sharp corner, the composer's `emerge` origin and
      // the popover's top edge are all the *same screen point*, so the box grows out of the pin
      // and stays hinged to it. Glyph persistence went with the head (§0 D6); a coordinate is
      // the stronger thing to conserve, because it is the one the user actually chose.
      const pin = vm.thread
        ? vm.badges.find((badge) => badge.threadId === vm.thread?.threadId)
        : null
      const threadOrigin = pin?.point
        ? pointOrigin(pin.point)
        : vm.thread
          ? badges.rectFor(vm.thread.threadId)
          : null
      thread.render(vm.thread, vm.labels, threadOrigin, hueOf)

      // §0 D4: while a reply is open it is a **child of the thread**, so it is docked into the
      // popover's own slot and the controller positions nothing for it (SPEC #47).
      const replyingHere =
        vm.composer?.replyTo !== undefined &&
        vm.composer.replyTo !== null &&
        vm.composer.replyTo === vm.thread?.threadId
      composer.dock(replyingHere ? thread.replySlot : null)
      thread.setReplying(replyingHere)
      // §8.3: the placement composer grows out of **the exact click point**, in every branch —
      // the coordinate survives the pick because `vm.picker` is gone by the time the composer
      // opens, exactly as the candidate rect used to.
      if (vm.picker?.point) pickPoint = vm.picker.point
      const replyPin = vm.composer?.replyTo
        ? (vm.badges.find((badge) => badge.threadId === vm.composer?.replyTo) ?? null)
        : null
      const composerOrigin = replyingHere
        ? null
        : pickPoint
          ? pointOrigin(pickPoint)
          : replyPin?.point
            ? pointOrigin(replyPin.point)
            : vm.composer?.replyTo
              ? badges.rectFor(vm.composer.replyTo)
              : null
      composer.render(vm.composer, vm.labels, composerOrigin, hueOf)
      if (!vm.composer) pickPoint = null

      picker.render(vm.picker, hueOf)
      if (vm.panel) {
        panel ??= createPanel(host, intents, vm.panel)
        // Rail mode: a popover makes attention singular without costing the panel its state.
        panel.render(vm.panel, vm.labels, vm.thread !== null, reduced)
      }

      const targets: ProximityTarget[] = [...badges.proximity(), ...(panel?.proximity() ?? [])]
      tracker.track(targets)
      // While the picker owns the cursor there is nothing to reveal, and every badge is washed
      // out anyway — so the listener comes off the host page entirely.
      tracker.suspend(vm.picker !== null)

      applyFocus(vm)
    },

    destroy() {
      tracker.destroy()
      badges.destroy()
      thread.destroy()
      composer.destroy()
      picker.destroy()
      panel?.destroy()
      panel = null
      sprite?.remove()
      sprite = null
    },
  }
}

/**
 * The glass presentation. Pass it as `presentation` at mount:
 *
 * ```ts
 * mountCommentUI(engine, { presentation: glassPresentation() })
 * ```
 */
export function glassPresentation(options: GlassOptions = {}): Presentation {
  return {
    name: 'glass',
    css: glassStyles,
    create: (host, intents) => createInstance(host, intents, options),
  }
}
