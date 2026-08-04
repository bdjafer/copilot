/**
 * The 18-glyph icon sprite (DESIGN §5), verbatim.
 *
 * The paths are **normative** — every stroke centerline lands on a ¼-pixel offset, which is why
 * they read as cut rather than drawn at 10/12/16/20 px — so they are copied character for
 * character rather than re-drawn, and `test/swarm-design.test.ts` asserts the count is 18 and that
 * `cc-i-ask` (deleted by §0 D5, and the "?" with it) is not among them.
 *
 * **The swarm head draws no glyph of its own.** DESIGN locks the sprite at 18 and §10 forbids a
 * drawn verb, so every affordance in this head is one of these marks plus a native `title`. The
 * mapping from swarm's affordances onto them is head deviation **E4**, and it is the table in
 * `intent-map.ts` rather than a comment here, so a test can read it.
 *
 * Delivery is DESIGN §5's: one `<symbol>` sprite injected once into the shadow root, referenced as
 * `<use href="#cc-i-check">` — not `mask-image` (loses multi-path), not an icon library (there is
 * none in this product, by rule).
 */

/** `viewBox="0 0 16 16"`, live area 13×13 inset 1.5. Multi-path glyphs list their paths in order. */
export const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  'cc-i-comment': [
    'M13.25 7.75a5.25 5.25 0 0 1-7.35 4.87L2.75 13.5l.9-2.85A5.25 5.25 0 1 1 13.25 7.75Z',
  ],
  'cc-i-check': ['M3.25 8.25 6.5 11.5 12.75 4.75'],
  'cc-i-uturn': ['M8 2.75A5.25 5.25 0 1 1 2.75 8', 'M1.25 9.75 2.75 8 4.25 9.75'],
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

export type GlyphId = keyof typeof GLYPHS & string

const SVG_NS = 'http://www.w3.org/2000/svg'

/** The `<svg>` holding every `<symbol>`. Injected once per mount, `display:none`, `aria-hidden`. */
export function buildSprite(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden')
  for (const [id, paths] of Object.entries(GLYPHS)) {
    const symbol = doc.createElementNS(SVG_NS, 'symbol')
    symbol.setAttribute('id', id)
    symbol.setAttribute('viewBox', '0 0 16 16')
    for (const d of paths) {
      const path = doc.createElementNS(SVG_NS, 'path')
      path.setAttribute('d', d)
      symbol.append(path)
    }
    svg.append(symbol)
  }
  return svg
}

/**
 * One `<use>` at one of DESIGN §5's sanctioned sizes (10, 12, 16, 20, 22, 24 — "nothing else").
 * Always `aria-hidden`: the accessible name lives on the control, never on its mark (§10).
 */
export function glyph(
  doc: Document,
  id: GlyphId,
  size: 10 | 12 | 16 | 20 | 22 = 16,
): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('class', 'cc-icon')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const use = doc.createElementNS(SVG_NS, 'use')
  use.setAttribute('href', `#${id}`)
  svg.append(use)
  return svg
}

/** Swap a mounted glyph in place — the payload swap of DESIGN §7 row 3, without rebuilding a node. */
export function setGlyph(node: SVGSVGElement, id: GlyphId): void {
  const use = node.firstElementChild
  if (use === null) return
  if (use.getAttribute('href') === `#${id}`) return
  use.setAttribute('href', `#${id}`)
}
