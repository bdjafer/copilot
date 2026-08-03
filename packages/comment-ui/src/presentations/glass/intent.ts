/**
 * Signal **S1** of DESIGN §7 (cursor proximity) and the page-polarity read of §2.5 — the two
 * things that make "nothing exists until intent is expressed" work without lying about where the
 * widget is.
 *
 * **Cost discipline is the whole design here.** One passive `pointermove` on `win`, coalesced
 * onto a single `requestAnimationFrame`, attached only while there is something to reveal and
 * detached entirely while the picker owns the cursor. The per-target distance test reads the
 * `left`/`top` the controller already wrote as inline style — **never `getBoundingClientRect`** —
 * so a 40-badge page costs 40 string parses per frame and provokes exactly zero layout.
 *
 * Two outputs:
 *  - `data-near="true"` on each target inside its own radius (96 px badges, 140 px panel seed);
 *  - `--_near: 0…1` on the layer, quantised to tenths so it changes ~10× per traversal rather
 *    than every frame — an ambient dial for anything that wants to fade with approach.
 *
 * Polarity is the other half of legibility on a page nobody controls: a light widget on a dark
 * host page is a flashlight in the face, and that happens whenever the OS is light and the page
 * is not. The body's computed background luminance decides it, the answer is written as
 * `data-polarity` on our own layer, and every dark block in the sheet reads
 * `@media (prefers-color-scheme: dark), :host([data-polarity='dark'])`.
 */

export interface ProximityTarget {
  readonly node: HTMLElement
  /** Reveal radius in CSS px, measured from the target's centre. */
  readonly radius: number
}

export interface IntentTracker {
  /** Replace the tracked set. Attaches the listener on the first target, detaches on the last. */
  track(targets: readonly ProximityTarget[]): void
  /** While the picker owns the cursor there is nothing to reveal, so the listener comes off. */
  suspend(suspended: boolean): void
  destroy(): void
}

/** The widest radius any target asks for, used for the ambient `--_near` ramp. */
const AMBIENT_RADIUS = 240

export function createIntentTracker(win: Window, layer: HTMLElement): IntentTracker {
  let targets: readonly ProximityTarget[] = []
  let attached = false
  let suspended = false
  let frame = 0
  let x = -1e5
  let y = -1e5
  let lastNear = -1
  let destroyed = false

  /**
   * The centre of a controller-positioned node, from the inline `left`/`top` it was given plus
   * its declared box. `offsetWidth` would be exact and would also force layout on every badge on
   * every frame; the reveal radius is 96 px, so a few px of box error cannot change the answer.
   */
  function centre(node: HTMLElement): [number, number] {
    const left = Number.parseFloat(node.style.left)
    const top = Number.parseFloat(node.style.top)
    if (Number.isNaN(left) || Number.isNaN(top)) {
      // Not positioned by the controller (the panel seed sits in a corner): one read, and only
      // for the handful of nodes in that class.
      const rect = node.getBoundingClientRect()
      return [rect.left + rect.width / 2, rect.top + rect.height / 2]
    }
    return [left + 11, top + 11]
  }

  function apply(): void {
    frame = 0
    if (destroyed) return
    let closest = Number.POSITIVE_INFINITY
    for (const target of targets) {
      const [cx, cy] = centre(target.node)
      const dx = cx - x
      const dy = cy - y
      const distance = Math.sqrt(dx * dx + dy * dy)
      if (distance < closest) closest = distance
      const near = distance <= target.radius
      if ((target.node.getAttribute('data-near') === 'true') !== near) {
        target.node.setAttribute('data-near', near ? 'true' : 'false')
      }
    }
    // Quantised to tenths: a custom property write is a style invalidation, and a continuous
    // one would be a repaint per frame for a value nothing can perceive at that resolution.
    const ambient = Math.round(Math.max(0, 1 - closest / AMBIENT_RADIUS) * 10) / 10
    if (ambient !== lastNear) {
      lastNear = ambient
      layer.style.setProperty('--_near', String(ambient))
    }
  }

  function onMove(event: PointerEvent): void {
    x = event.clientX
    y = event.clientY
    if (frame) return
    frame = win.requestAnimationFrame(apply)
  }

  const listener = onMove as (event: Event) => void

  function attach(want: boolean): void {
    if (want === attached || destroyed) return
    attached = want
    if (want) win.addEventListener('pointermove', listener, { passive: true })
    else win.removeEventListener('pointermove', listener)
  }

  function sync(): void {
    attach(!suspended && targets.length > 0)
    if (attached) apply()
  }

  return {
    track(next) {
      targets = next
      sync()
    },
    suspend(next) {
      suspended = next
      if (next) {
        for (const target of targets) target.node.setAttribute('data-near', 'false')
        lastNear = -1
      }
      sync()
    },
    destroy() {
      destroyed = true
      attach(false)
      if (frame) win.cancelAnimationFrame(frame)
      frame = 0
      targets = []
    },
  }
}

/* ------------------------------------------------------------------------------- polarity */

export interface PolarityWatcher {
  /** Re-read the page. Throttled internally, so calling it from every render pass is free. */
  refresh(): void
}

/**
 * How light is this colour, 0…1, and is it opaque enough to mean anything? `null` when the answer
 * is "nothing useful" — a transparent body, or a syntax this does not read.
 *
 * **Every modern colour space has to be handled, not just `rgb()`.** A computed
 * `background-color` is serialised in whatever space the author wrote, so a page styled in
 * `oklch()` — increasingly most of them, including this repository's own demo — hands back
 * `oklch(0.99 0.002 264)`. A parser that only knows `rgb()` silently answers "unknown" on exactly
 * the pages most likely to be dark by design, and the whole point of §2.5 quietly stops working.
 *
 * For the perceptual spaces the first component **is** lightness, which is a better answer than
 * anything derivable from sRGB bytes; for the others, Rec. 709 luma.
 */
function lightnessOf(value: string): number | null {
  const input = value.trim().toLowerCase()
  if (input === '' || input === 'transparent' || input === 'none') return null

  const numbers = [...input.matchAll(/-?[\d.]+%?/g)].map((match) => match[0])
  const at = (index: number): number => {
    const token = numbers[index] ?? ''
    const raw = Number.parseFloat(token)
    if (Number.isNaN(raw)) return Number.NaN
    return token.endsWith('%') ? raw / 100 : raw
  }
  // Alpha is the last component after a slash in the modern syntax, and the fourth argument in
  // the legacy comma syntax `rgba()` / `hsla()` — which is still what most engines serialise.
  const legacyAlpha = /^(rgba?|hsla?)\(/.test(input) && numbers.length >= 4
  const alpha = input.includes('/') ? at(numbers.length - 1) : legacyAlpha ? at(3) : 1
  if (Number.isNaN(alpha) || alpha < 0.5) return null

  if (input.startsWith('oklch(') || input.startsWith('oklab(') || input.startsWith('lch(')) {
    const l = at(0)
    return Number.isNaN(l) ? null : Math.min(1, Math.max(0, l))
  }
  if (input.startsWith('lab(')) {
    const l = at(0)
    // CIE L* is 0…100 when written without a percent sign.
    return Number.isNaN(l) ? null : Math.min(1, Math.max(0, l > 1 ? l / 100 : l))
  }
  if (input.startsWith('hsl')) {
    const l = at(2)
    return Number.isNaN(l) ? null : Math.min(1, Math.max(0, l))
  }
  if (input.startsWith('color(')) {
    // `color(srgb r g b)` and friends: components are already 0…1.
    const [r, g, b] = [at(0), at(1), at(2)]
    if ([r, g, b].some(Number.isNaN)) return null
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  if (input.startsWith('rgb')) {
    const [r, g, b] = [at(0), at(1), at(2)]
    if ([r, g, b].some(Number.isNaN)) return null
    const scale = (channel: number): number => (numbers[0].endsWith('%') ? channel : channel / 255)
    return 0.2126 * scale(r) + 0.7152 * scale(g) + 0.0722 * scale(b)
  }
  if (input.startsWith('#')) {
    const hex = input.slice(1)
    if (hex.length < 3) return null
    const wide = hex.length >= 6
    const byte = (index: number): number =>
      wide
        ? Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
        : Number.parseInt(hex[index] + hex[index], 16)
    if (wide ? hex.length >= 8 && byte(3) < 128 : hex.length >= 4 && byte(3) < 128) return null
    return (0.2126 * byte(0) + 0.7152 * byte(1) + 0.0722 * byte(2)) / 255
  }
  return null
}

export { lightnessOf }

export function createPolarityWatcher(
  doc: Document,
  win: Window,
  layer: HTMLElement,
  forced: 'auto' | 'light' | 'dark',
): PolarityWatcher {
  let last = 0

  function write(value: 'light' | 'dark' | null): void {
    if (value === null) {
      if (layer.hasAttribute('data-polarity')) layer.removeAttribute('data-polarity')
      return
    }
    if (layer.getAttribute('data-polarity') !== value) layer.setAttribute('data-polarity', value)
  }

  function read(): void {
    if (forced !== 'auto') {
      write(forced)
      return
    }
    let background = ''
    try {
      background = win.getComputedStyle(doc.body).backgroundColor
    } catch {
      /* no cascade in this DOM */
    }
    const lightness = lightnessOf(background)
    // A transparent body says nothing about the page, so it says nothing about us either: fall
    // through to `prefers-color-scheme` by leaving the attribute off.
    if (lightness === null) {
      write(null)
      return
    }
    write(lightness < 0.45 ? 'dark' : 'light')
  }

  read()

  return {
    refresh() {
      const now = Date.now()
      if (now - last < 1000) return
      last = now
      read()
    },
  }
}
