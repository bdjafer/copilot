/**
 * The whole imperative half of DESIGN §6 — and it is deliberately tiny: **two
 * `getBoundingClientRect()` calls per morph and one `translate` write per re-anchor**. Everything
 * else in the design is a CSS transition fired by an attribute the render pass already had to
 * write, which is why no motion library appears in the dependency list (Motion One and GSAP both
 * buy less than the `linear()` springs in the sheet, because the presentation is attribute-driven
 * and idempotent).
 *
 * §6.5 is what makes that free: the controller owns `left`/`top` on every node it positions, so
 * `transform`, `translate`, `scale`, `opacity` and `clip-path` are entirely ours on the same
 * node, with zero conflict — and no presentation may animate a layout property on a
 * controller-positioned node. Re-anchoring is therefore FLIP on the **independent `translate`
 * property**, which cannot collide with a hover `transform`.
 */

/** `prefers-reduced-motion`, resolved once per mount with an explicit override (§3.1.8). */
export function prefersReducedMotion(win: Window, forced: boolean | undefined): boolean {
  if (forced !== undefined) return forced
  try {
    return win.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * `will-change` for the duration of an animation and **not one frame longer** (§6.3): 40 badges
 * must never hold 40 GPU layers. Set at transition start, cleared on `transitionend`, with a
 * wall-clock backstop because a transition on a node that never becomes visible never fires one.
 */
export function markAnimating(node: HTMLElement, ms = 400): void {
  if (node.getAttribute('data-animating') === 'true') return
  node.setAttribute('data-animating', 'true')
  const clear = (): void => {
    node.removeAttribute('data-animating')
    node.removeEventListener('transitionend', clear)
  }
  node.addEventListener('transitionend', clear)
  const view = node.ownerDocument.defaultView
  view?.setTimeout(clear, ms)
}

export interface Rectish {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * **Origin transfer** (§6.6) — the morph mechanism, and the reason there is no FLIP between the
 * badge and the popover it becomes. The endpoints are different nodes, so rather than tween one
 * into the other, express the *source's* centre as the destination's `transform-origin` and grow
 * from it. Two reads at open, none per frame; it survives the positioner's flip/shift for free,
 * because the origin is computed from the **final** rect; and with no badge at all (a fresh pick)
 * the source is simply the picked rect.
 *
 * Glyph persistence completes the illusion: the popover head carries the same kind glyph at the
 * same size and colour, within a few px of the same screen point. The box grows, the icon barely
 * moves, and the eye reads one object rather than two.
 */
export function transferOrigin(to: HTMLElement, from: Rectish | null): void {
  if (!from) {
    to.style.removeProperty('--_ox')
    to.style.removeProperty('--_oy')
    return
  }
  const rect = to.getBoundingClientRect()
  to.style.setProperty('--_ox', `${String(Math.round(from.x + from.width / 2 - rect.left))}px`)
  to.style.setProperty('--_oy', `${String(Math.round(from.y + from.height / 2 - rect.top))}px`)
}

/**
 * `flight` (§6.4) — FLIP on `translate` when a badge's reference swaps out from under it. The
 * controller has already written the new `left`/`top`; this puts the node back where the eye last
 * saw it and lets one transition carry it home.
 *
 * Under reduced motion the jump is instant and gets a single 100 ms opacity blink instead, so the
 * move is still *noticed* — which is the point of the animation, and the part that a plain
 * "turn it off" mapping throws away.
 */
export function flight(
  node: HTMLElement,
  previous: Rectish,
  next: Rectish,
  reduced: boolean,
): void {
  const dx = previous.x - next.x
  const dy = previous.y - next.y
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
  if (reduced) {
    node.setAttribute('data-blink', 'true')
    const view = node.ownerDocument.defaultView
    view?.setTimeout(() => {
      node.removeAttribute('data-blink')
    }, 120)
    return
  }
  node.setAttribute('data-flight', 'true')
  node.style.translate = `${String(dx)}px ${String(dy)}px`
  const view = node.ownerDocument.defaultView
  const release = (): void => {
    node.removeAttribute('data-flight')
    node.style.translate = ''
  }
  if (!view) {
    release()
    return
  }
  view.requestAnimationFrame(() => {
    markAnimating(node)
    node.style.translate = '0px 0px'
    view.setTimeout(release, 360)
  })
}

/**
 * `roll` (§6.4) — a count that changes in place. Two `tabular-nums` spans: the old one leaves
 * upward, the new one arrives from below. The container's width transitions rather than snapping,
 * which is the difference between a number changing and the layout twitching.
 *
 * Returns silently when the value is unchanged, so this is safe to call from every render pass.
 */
export function roll(node: HTMLElement, value: string, reduced: boolean): void {
  const current = node.getAttribute('data-value')
  if (current === value) return
  node.setAttribute('data-value', value)
  const doc = node.ownerDocument
  if (current === null || reduced) {
    node.textContent = value
    return
  }
  const previous = doc.createElement('span')
  previous.className = 'cc-roll-out'
  previous.textContent = current
  const next = doc.createElement('span')
  next.className = 'cc-roll-in'
  next.textContent = value
  node.replaceChildren(previous, next)
  doc.defaultView?.setTimeout(() => {
    if (node.getAttribute('data-value') === value) node.textContent = value
  }, 220)
}

/**
 * `bloom` (§6.4) — reserved for a **genuine** creation. Never on the `IntersectionObserver`
 * re-show path: a scroll-back that re-blooms the page reads as a bug, and the re-show is the
 * commonest badge event there is.
 */
export function bloom(node: HTMLElement, reduced: boolean): void {
  if (reduced) return
  node.setAttribute('data-bloom', 'true')
  const view = node.ownerDocument.defaultView
  view?.setTimeout(() => {
    node.removeAttribute('data-bloom')
  }, 440)
}
