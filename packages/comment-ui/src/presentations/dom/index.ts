/**
 * `domPresentation()` — the default presentation (§3.1.8). Today's markup, class names,
 * attributes and stylesheet, byte for byte, now driven by `UIViewModel` instead of by the
 * engine. **A host that upgrades and changes nothing sees no visual change, no DOM change and
 * no API change** (§3.1.7).
 *
 * It is **frozen**: bug and a11y fixes only, no new class names, no design changes. That is not
 * conservatism, it is what the compatibility promise costs — four tests exist purely to fail
 * when someone "improves" this markup.
 *
 * The dependency rule (§3.1, decision log #31) is mechanical and grep-enforced: nothing under
 * `src/presentations/` imports the engine package or the positioning library, directly or
 * transitively. This file sees `UIViewModel`, `Intents`, `PresentationHost` and an `el()`
 * helper, and there is no fourth thing it *could* see.
 */

import type {
  Intents,
  Presentation,
  PresentationHost,
  PresentationInstance,
  UIViewModel,
} from '../../presentation.ts'
import type { Panel } from './panel.ts'

import { safeFocus } from '../../dom.ts'
import { createBadgeLayer } from './badge.ts'
import { createComposer } from './composer.ts'
import { createPanel } from './panel.ts'
import { createPicker } from './picker.ts'
import { commentUIStyles } from './styles.ts'
import { createThreadPopover } from './thread.ts'

function createInstance(host: PresentationHost, intents: Intents): PresentationInstance {
  const badges = createBadgeLayer(host, intents)
  const composer = createComposer(host, intents)
  const thread = createThreadPopover(host, intents)
  const picker = createPicker(host.doc, host.layer)
  let panel: Panel | null = null
  let lastFocus = -1

  /**
   * §3.1.6: apply the target whenever `focus.seq` changes, then do nothing until it changes
   * again. Monotonic and idempotent, so a re-render can never re-steal focus and this needs no
   * acknowledgement channel back to the controller.
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
      badges.render(vm.badges)
      thread.render(vm.thread, vm.labels)
      composer.render(vm.composer, vm.labels)
      picker.render(vm.picker)
      if (vm.panel) {
        panel ??= createPanel(host, intents, vm.panel)
        panel.render(vm.panel, vm.labels)
      }
      applyFocus(vm)
    },

    destroy() {
      badges.destroy()
      thread.destroy()
      composer.destroy()
      picker.destroy()
      panel?.destroy()
      panel = null
    },
  }
}

/** The default presentation: today's markup, class names and `commentUIStyles`. Frozen. */
export function domPresentation(): Presentation {
  return { name: 'dom', css: commentUIStyles, create: createInstance }
}
