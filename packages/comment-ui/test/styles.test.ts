/**
 * §3 theming + the CSS injection contract, **parameterised over every shipped sheet** (§3.1.8,
 * decision log #39).
 *
 * The eleven `--cc-*` names are the theming surface for every presentation; only their default
 * *values* are per-presentation. So the contract below is a property of the package, not of one
 * appearance, and adding a sheet to `SHEETS` is the entire cost of proving the new one obeys it.
 *
 * The one rule that is easy to break and impossible to notice without a test: internal styling
 * must read `var(--cc-x, <default>)`, and must **never** declare `--cc-x: <default>` on `:host`.
 * A declaration on `:host` wins over the page's inherited `:root` value and silently disables
 * the entire documented theming surface.
 */

import { describe, expect, test } from 'vitest'

import { glassStyles } from '../src/glass.ts'
import { commentUIStyles, defaultLabels } from '../src/index.ts'
import { resolveLabels } from '../src/labels.ts'

const THEME_PROPERTIES = [
  '--cc-accent',
  '--cc-surface',
  '--cc-surface-2',
  '--cc-text',
  '--cc-muted',
  '--cc-border',
  '--cc-danger',
  '--cc-badge-size',
  '--cc-radius',
  '--cc-font',
  '--cc-shadow',
] as const

/** Every sheet the package ships. Adding one to this list is the whole cost of proving it. */
const SHEETS: ReadonlyArray<[string, string]> = [
  ['commentUIStyles', commentUIStyles],
  ['glassStyles', glassStyles],
]

describe.each(SHEETS)('the custom-property contract — %s', (_name, sheet) => {
  test('every documented property is consumed with a fallback', () => {
    for (const property of THEME_PROPERTIES) {
      expect(sheet).toContain(`var(${property},`)
    }
  })

  test('no documented property is ever DECLARED — that would beat the page', () => {
    for (const property of THEME_PROPERTIES) {
      // `--cc-x: value` (a declaration) vs `--_x: var(--cc-x, value)` (a read).
      const declaration = new RegExp(`(^|[;{\\s])${property}\\s*:(?!\\s*var\\()`, 'm')
      expect(sheet).not.toMatch(declaration)
    }
  })

  test('dark defaults are applied as reads too, so an explicit host value survives', () => {
    expect(sheet).toContain('@media (prefers-color-scheme: dark)')
    expect(sheet).toMatch(/--_surface:\s*var\(--cc-surface,/)
  })

  test('the sheet is rem-free and pins :host font-size', () => {
    expect(sheet).not.toMatch(/\d\s*rem\b/)
    expect(sheet).toContain('all: initial')
    expect(sheet).toContain('font-size: var(--cc-root-font-size, 16px)')
  })

  test('the dynamic host vars are NOT in the exported sheet, so it stays static', () => {
    expect(sheet).not.toContain('--cc-root-font-size:')
    expect(sheet).not.toContain('--cc-z:')
  })

  test('it is exported as a plain string — the importable half of the contract', () => {
    expect(typeof sheet).toBe('string')
    expect(sheet.length).toBeGreaterThan(1000)
  })
})

/**
 * The rules the *runtime* cannot check. happy-dom ships no UA stylesheet and no cascade, so a
 * sheet that forgot to reset something the browser sets for us is invisible here in every way
 * except one: the text of the sheet itself.
 */
describe('glassStyles — what a real browser adds behind our back', () => {
  test('the UA `[popover]` border is reset on every top-layer surface', () => {
    // Every `[popover]` gets `border: solid` from the UA sheet — a 3 px currentColor rectangle,
    // near-black on light, white on dark, outside our own keyline. It was on the thread popover
    // and the composer in both schemes, and 256 green tests said nothing about it because there
    // is no UA stylesheet in this runtime.
    expect(glassStyles).toContain(
      '.cc-float { position: fixed; top: 0; left: 0; margin: 0; border: 0; }',
    )
    expect(glassStyles).toContain('.cc-composer, .cc-thread { display: none; border: 0; }')
  })

  test('§3.3 holds: the only `border` declarations are the ones that draw something', () => {
    // Hairlines are `box-shadow` spreads, never borders (§3.3), and since §0 D1 **no glass
    // surface takes one at all** — its whole edge is `--_e3`. The survivors are drawn marks:
    // the resets above, the chip ring, the quote rail and the dashed orphan silhouette, each of
    // which IS the shape rather than a hairline around a surface. The picker's corner ticks left
    // the list with the picker itself (§0 D7: placement mode draws nothing).
    const declarations = [...glassStyles.matchAll(/(?:^|[;{\s])border:\s*([^;]+);/g)].map((match) =>
      match[1].trim(),
    )
    const drawn = [...new Set(declarations.filter((value) => value !== '0'))].sort()
    expect(drawn).toEqual([
      // The dashed orphan silhouette (§7 row 3): the one hairline in this design a `box-shadow`
      // cannot draw, and it is a *state mark*, not an outline around a surface.
      '1.5px dashed var(--_muted)',
      // The chip's 5 px ring — the shape itself.
      '1.5px solid currentColor',
      // …and the `forced-colors` fallback, which is where a border is the only tool there is.
      '1px solid CanvasText',
    ])
    expect(declarations.filter((value) => value === '0').length).toBeGreaterThan(8)
  })
})

describe('labels', () => {
  test('the default set is frozen and complete', () => {
    expect(Object.isFrozen(defaultLabels)).toBe(true)
    expect(Object.keys(defaultLabels)).toHaveLength(17)
    for (const value of Object.values(defaultLabels)) expect(value).not.toBe('')
  })

  test('a partial override merges over the defaults', () => {
    const merged = resolveLabels({ send: 'Envoyer', resolve: 'Résoudre' })
    expect(merged.send).toBe('Envoyer')
    expect(merged.resolve).toBe('Résoudre')
    expect(merged.dismiss).toBe(defaultLabels.dismiss)
  })

  test('a non-string override is ignored rather than rendered', () => {
    const merged = resolveLabels({ send: undefined })
    expect(merged.send).toBe(defaultLabels.send)
  })

  test('no overrides returns the shared frozen default', () => {
    expect(resolveLabels()).toBe(defaultLabels)
  })
})
