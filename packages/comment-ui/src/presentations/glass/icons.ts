/**
 * The 19 hand-drawn glyphs of DESIGN §5, as one `<symbol>` sprite.
 *
 * Spec, normative and identical for every glyph: `viewBox="0 0 16 16"`, a 13×13 live area inset
 * 1.5, `fill: none`, `stroke: currentColor`, `stroke-width: 1.5`, round caps and joins, and
 * `vector-effect: non-scaling-stroke`. Every centerline lands on a ¼-pixel offset (`n.25` /
 * `n.75`), so at 2× DPR a 1.5 px stroke covers exactly 3 device pixels with a half-integer
 * centerline. That is why these read as cut rather than drawn, and why they stay crisp at
 * 10 / 12 / 14 / 16 / 20 px — the five sizes in use, and the only five.
 *
 * Delivery is a sprite injected **once** into the shadow root and referenced as
 * `<use href="#cc-i-check">`. Not `mask-image` (it loses multi-path glyphs), not an icon
 * library (there is none in this product, by rule): the whole set is ~2.4 KB raw.
 *
 * The stroke presentation attributes live on the sprite's root `<svg>`, not per path, because
 * `<use>` clones inherit them and `currentColor` then resolves against the *referencing* site —
 * which is what lets one sprite draw an accent badge glyph and a muted panel glyph.
 */

/** Glyph id → its path data, in draw order. Ids are the public `<use href>` targets. */
export const ICONS: Readonly<Record<string, readonly string[]>> = {
  'cc-i-comment': [
    'M13.25 7.75a5.25 5.25 0 0 1-7.35 4.87L2.75 13.5l.9-2.85A5.25 5.25 0 1 1 13.25 7.75Z',
  ],
  'cc-i-ask': [
    'M13.25 7.75a5.25 5.25 0 0 1-7.35 4.87L2.75 13.5l.9-2.85A5.25 5.25 0 1 1 13.25 7.75Z',
    'M6.9 6.4a1.15 1.15 0 1 1 1.6 1.06c-.45.2-.6.55-.6.99',
    'M8 10.75h.01',
  ],
  'cc-i-check': ['M3.25 8.25 6.5 11.5 12.75 4.75'],
  'cc-i-uturn': ['M12.75 10.25A3.5 3.5 0 0 0 9.25 6.75H3.25', 'M5.75 4.25 3.25 6.75l2.5 2.5'],
  'cc-i-close': ['M4.25 4.25 11.75 11.75', 'M11.75 4.25 4.25 11.75'],
  'cc-i-reply': ['M6.25 3.75 2.75 7.25l3.5 3.5', 'M2.75 7.25h6a3.5 3.5 0 0 1 3.5 3.5v1.5'],
  'cc-i-pencil': ['M10.9 2.85a1.63 1.63 0 0 1 2.3 2.3L5.6 12.75l-3.1.6.6-3.1Z', 'M9.75 4 12 6.25'],
  'cc-i-trash': ['M2.75 4.25h10.5', 'M6.25 4.25V2.75h3.5v1.5', 'M4.25 4.25l.55 8.5h6.4l.55-8.5'],
  'cc-i-send': ['M8 12.75V3.75', 'M4.25 7.5 8 3.75l3.75 3.75'],
  'cc-i-sparkle': [
    'M8 2.25l1.2 3.3 3.3 1.2-3.3 1.2L8 11.25 6.8 7.95 3.5 6.75l3.3-1.2Z',
    'M12.25 11.25l.5 1.25 1.25.5-1.25.5-.5 1.25-.5-1.25-1.25-.5 1.25-.5Z',
  ],
  'cc-i-tilde': ['M3.25 8.5c1.2-2.1 2.6-2.1 3.9 0s2.7 2.1 4.1 0'],
  'cc-i-pin-off': [
    'M8 2.75a3.25 3.25 0 0 1 3.25 3.25c0 2.4-3.25 6.25-3.25 6.25S4.75 8.4 4.75 6A3.25 3.25 0 0 1 8 2.75Z',
    'M3.25 3.25 12.75 12.75',
  ],
  'cc-i-chevron': ['M6.25 4.25 9.75 8l-3.5 3.75'],
  'cc-i-warn': ['M8 2.75 14.25 13.25H1.75Z', 'M8 6.75v2.5', 'M8 11.5h.01'],
  'cc-i-eye': [
    'M1.75 8S4.25 3.75 8 3.75 14.25 8 14.25 8 11.75 12.25 8 12.25 1.75 8 1.75 8Z',
    'M8 6.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5Z',
  ],
  'cc-i-eye-off': [
    'M1.75 8S4.25 3.75 8 3.75 14.25 8 14.25 8 11.75 12.25 8 12.25 1.75 8 1.75 8Z',
    'M8 6.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5Z',
    'M2.75 2.75 13.25 13.25',
  ],
  'cc-i-arc': ['M8 2.25a5.75 5.75 0 0 1 5.75 5.75'],
  'cc-i-stack': [
    'M2.75 5.25 8 2.75l5.25 2.5L8 7.75Z',
    'M2.75 8.5 8 11l5.25-2.5',
    'M2.75 11.25 8 13.75l5.25-2.5',
  ],
  'cc-i-info': [
    'M8 2.25a5.75 5.75 0 1 1 0 11.5 5.75 5.75 0 0 1 0-11.5Z',
    'M8 7.25v3.5',
    'M8 5.25h.01',
  ],
}

/** Every id in the set, for the sprite build and for the presence assertions. */
export const ICON_IDS: readonly string[] = Object.keys(ICONS)

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * The sprite, built once per mount. `aria-hidden` and out of flow: it is a definition block, so
 * it must never be reachable by a screen reader or affect layout.
 */
export function createSprite(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'cc-sprite')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')

  for (const [id, paths] of Object.entries(ICONS)) {
    const symbol = doc.createElementNS(SVG_NS, 'symbol')
    symbol.setAttribute('id', id)
    symbol.setAttribute('viewBox', '0 0 16 16')
    for (const data of paths) {
      const path = doc.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', data)
      path.setAttribute('vector-effect', 'non-scaling-stroke')
      symbol.append(path)
    }
    svg.append(symbol)
  }
  return svg
}

/**
 * An icon instance. `<use>` rather than an inline copy: 40 badges then cost 40 references and
 * one definition, and `currentColor` still resolves per site.
 *
 * **The stroke spec is a presentation attribute here, not a stylesheet rule**, and that is a
 * correctness decision rather than a stylistic one. An `<svg>` with no `fill` renders `black`,
 * so an instance the sheet forgot to name draws every one of these glyphs as a **filled black
 * blob** — a bug that looks like a design choice, in one place, at one size, and nowhere else.
 * Putting the six attributes on the element makes a forgotten class impossible by construction;
 * the sheet is then only responsible for size and colour, and it cannot be silently wrong.
 * (`<use>` clones inherit these, which is what keeps one definition serving every site.)
 */
export function icon(doc: Document, id: string, className: string): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', className)
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.5')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  const use = doc.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', `#${id}`)
  svg.append(use)
  return svg
}

/** Repoint an existing icon. Idempotent, so a re-render of an unchanged glyph touches nothing. */
export function setIcon(node: Element, id: string): void {
  const use = node.querySelector('use')
  if (!use || use.getAttribute('href') === `#${id}`) return
  use.setAttribute('href', `#${id}`)
}

/** The kind glyph for a badge/thread/row: the host's own string wins, else the mode's own mark. */
export function kindIcon(kind: string): string {
  return kind === 'ask' ? 'cc-i-ask' : 'cc-i-comment'
}
