/**
 * Mode hues — DESIGN §2.3.
 *
 * `Mode.kind` is an opaque host string and modes carry no colour, so a mode's hue is **the design's
 * decision about its position in the list**, not a property of its name. The offset is taken by
 * index in `engine.modes` — `[0°, +38°, −34°, +72°, −68°]`, repeating from 0 beyond index 4 — and
 * never by hashing the string: a hash makes two modes' colours depend on what they are called,
 * which is unstable, untestable and invisible until a host renames one.
 *
 * The index is the one fact a presentation cannot re-derive (it never sees a `Mode`), so the
 * ordered kinds cross the seam as `UIViewModel.kinds` (decision log #41) and **this table stays
 * here**, in the design layer, where a second appearance is free to disagree with it.
 *
 * Colour is a hint, not an identifier: every mode also has its own glyph (§5), which is what keeps
 * §1.3 — "colour never carries state alone" — true for a colour-blind user, in a screenshot and
 * under `forced-colors`, where the hue is gone entirely.
 */

/** §2.3, in order. Index 5 and beyond wrap. */
export const KIND_HUES: readonly number[] = [0, 38, -34, 72, -68]

/**
 * Resolve a kind to the `--_kind-h` value it should carry, e.g. `'38'`.
 *
 * **Unitless, and that is not a style choice.** Inside relative colour syntax the `h` channel
 * keyword resolves to a `<number>`, so `calc(h + 38deg)` is a type error: the whole declaration
 * is invalid at computed-value time, the fill falls back to `transparent`, and every badge on the
 * page becomes a hollow ring. Found in a browser; there is no way to see it in a DOM emulator,
 * because nothing there parses a colour.
 */
export type HueOf = (kind: string) => string

export function createHueOf(kinds: readonly string[]): HueOf {
  return (kind) => {
    const index = kinds.indexOf(kind)
    // A kind that is no longer in `modes` renders with default chrome (§2.11) — the accent, i.e.
    // an offset of zero, which is also index 0's value.
    const hue = index < 0 ? 0 : (KIND_HUES[index % KIND_HUES.length] ?? 0)
    return String(hue)
  }
}

/**
 * Write the offset on the surface that carries `data-kind`. A custom property rather than a class:
 * the hue is computed *from the host's* `--cc-accent` with relative colour, so it has to be a
 * value the cascade can carry into a pseudo-element, not a rule this sheet could have enumerated.
 */
export function applyHue(node: HTMLElement, hueOf: HueOf, kind: string): void {
  const value = hueOf(kind)
  if (node.style.getPropertyValue('--_kind-h') === value) return
  node.style.setProperty('--_kind-h', value)
}
