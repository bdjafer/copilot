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
