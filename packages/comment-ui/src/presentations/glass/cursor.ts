/**
 * The placement cursor — DESIGN §0 D7, §7 rows 18–20, §8.2.
 *
 * Placement mode draws **nothing**. No scrim, no punched hole, no ring, no corner ticks, no dwell
 * capsule, no cursor-riding disc, and our own pins keep full opacity — during a pick the host page
 * is not merely unmutated, it is pixel-identical. The cursor is the entire mode signal, and it is
 * the honest one: **its hotspot is the pin's sharp corner**, so what the user is aiming with *is*
 * the point that will be stored.
 *
 * ```
 * image   24×24 CSS px pin outline, filled at the mode hue, white keyline (the §3.3 sandwich,
 *         drawn into the SVG because a cursor cannot take a box-shadow); 48×48 twin at 2×
 * hotspot 2 22 — the sharp bottom-left corner
 * value   cursor: image-set(url("data:image/svg+xml,…") 1x, url("…") 2x) 2 22, crosshair
 * ```
 *
 * The low-confidence variant (§7 row 20) is the same outline unfilled plus a 2 px landmark tick:
 * *"this will attach to the block, not to that"* — wordlessly, and still without a pixel drawn on
 * the page.
 *
 * Two data URIs are built per (kind, variant) and **cached**, because this is the most
 * latency-sensitive surface in the product and the `cursor` property is not animatable: swapping
 * the image mid-move is the one thing that would make placement feel laggy (§6.3).
 */

/**
 * The glass default accent's hue (`oklch(59.6% 0.211 254)`, §2.1). A `cursor: url(…)` data URI is
 * the one consumer in the design that cannot read a custom property, so the hue is templated in
 * (§2.3) — which also means a host that re-themed `--cc-accent` keeps the default cursor tint.
 * That is the documented cost of the mechanism, and it is bounded to 24 px of cursor.
 */
const ACCENT_L = '59.6%'
const ACCENT_C = '0.211'
const ACCENT_H = 254

/**
 * The teardrop, in one path: from the sharp corner at `2 22` up the left edge and around a
 * 10 px circle the long way. Every other corner is round; this one is the anchor point.
 */
const TEARDROP = 'M2 22V12a10 10 0 1 1 10 10Z'
/** §7 row 20's landmark tick: the horizontal bar of a "this attaches to the block" mark. */
const TICK = 'M8 15h8'

export type CursorVariant = 'solid' | 'hollow'

function hueFor(offset: string): number {
  const parsed = Number.parseFloat(offset)
  return ACCENT_H + (Number.isFinite(parsed) ? parsed : 0)
}

function svg(size: number, fill: string, variant: CursorVariant): string {
  const body =
    variant === 'solid'
      ? `<path d="${TEARDROP}" fill="${fill}" stroke="white" stroke-width="1.75" stroke-linejoin="round"/>`
      : `<path d="${TEARDROP}" fill="white" fill-opacity=".55" stroke="${fill}" stroke-width="1.75" stroke-linejoin="round"/>` +
        `<path d="${TICK}" stroke="${fill}" stroke-width="2" stroke-linecap="round"/>`
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${String(size)}" height="${String(size)}" ` +
    `viewBox="0 0 24 24">${body}</svg>`
  )
}

function uri(size: number, fill: string, variant: CursorVariant): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg(size, fill, variant))}")`
}

/**
 * Build the complete CSS `cursor` value for a mode + confidence verdict. Handed to the controller
 * through `PresentationHost.cursor()`; the presentation never touches the host document itself
 * (SPEC decision log #46).
 */
export function createCursorFactory(): (hueOffset: string, variant: CursorVariant) => string {
  const cache = new Map<string, string>()
  return (hueOffset, variant) => {
    const key = `${hueOffset}:${variant}`
    const hit = cache.get(key)
    if (hit) return hit
    let value = 'crosshair'
    try {
      const fill = `oklch(${ACCENT_L} ${ACCENT_C} ${String(hueFor(hueOffset))})`
      // `2 22` is the sharp corner: the hotspot IS the anchor point, which is what makes the
      // placement gesture honest. `crosshair` is the keyword fallback for an engine that
      // refuses the image (and the whole value, for one that refuses `image-set`).
      value = `image-set(${uri(24, fill, variant)} 1x, ${uri(48, fill, variant)} 2x) 2 22, crosshair`
    } catch {
      value = 'crosshair'
    }
    cache.set(key, value)
    return value
  }
}
