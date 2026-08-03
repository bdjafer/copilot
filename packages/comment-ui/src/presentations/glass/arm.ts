/**
 * `arm` — DESIGN §6.4, amendment A4.
 *
 * Delete is the one action in this product that cannot be undone, and it was reachable in one
 * click of an unlabelled 26 px icon sitting next to Resolve. §6.4 already ruled that a beautiful
 * animation is a *reward* and that an irreversible action must not get one; the same reasoning
 * says it must not get a hair trigger either.
 *
 * So the confirmation happens **in place, in the control itself**: the first click arms it
 * (`data-confirm`, which the sheet draws as a danger tint *and* a danger ring — a shape, because
 * §1.3 forbids colour carrying a state alone), and the second click within four seconds performs
 * it. Blur disarms, `Esc` disarms, any other click in the same surface disarms, and the four
 * seconds disarm. **No new string, no dialog, no eighteenth `Labels` key** — the accessible name
 * is still `Labels.delete`, which is what the control still does.
 */

/** §6.4: how long an armed control remembers the first click. */
export const CONFIRM_MS = 4000

export interface Arm {
  /** Report a click. `true` means it was already armed — perform the action. */
  click(): boolean
  disarm(): void
  destroy(): void
}

export function createArm(button: HTMLElement, ms: number = CONFIRM_MS): Arm {
  const view = button.ownerDocument.defaultView
  let timer = 0

  const disarm = (): void => {
    if (timer && view) view.clearTimeout(timer)
    timer = 0
    if (button.hasAttribute('data-confirm')) button.removeAttribute('data-confirm')
  }

  // A control that lost focus lost the gesture with it: coming back to it later and clicking
  // once must not delete something the user armed a minute ago and forgot about.
  button.addEventListener('blur', disarm)

  return {
    click() {
      if (button.getAttribute('data-confirm') === 'true') {
        disarm()
        return true
      }
      button.setAttribute('data-confirm', 'true')
      timer = view?.setTimeout(disarm, ms) ?? 0
      return false
    },
    disarm,
    destroy() {
      disarm()
      button.removeEventListener('blur', disarm)
    },
  }
}
