/**
 * §3.1.9 — `presentationConformance()` run against every shipped presentation.
 *
 * This is the executable form of "themes are swappable at mount": the same contract-level cases,
 * the same assertions, one `for` loop per presentation. `glassPresentation` joining the table
 * below was the entire cost of proving the second appearance obeys the contract — nothing else
 * in this file changed, which is the whole point.
 *
 * The kit itself is runner-agnostic (`ConformanceCase[]`, decision log #24); this file is the
 * three lines of vitest that consume it.
 */

import { afterEach, describe, expect, test } from 'vitest'

import type { Presentation } from '../src/presentation.ts'

import { glassPresentation } from '../src/glass.ts'
import { domPresentation } from '../src/index.ts'
import { presentationConformance } from '../src/testing/index.ts'

const PRESENTATIONS: ReadonlyArray<[string, () => Presentation]> = [
  ['dom', domPresentation],
  ['glass', () => glassPresentation()],
]

afterEach(() => {
  document.querySelectorAll('[data-comment-ui]').forEach((node) => {
    node.remove()
  })
})

for (const [name, factory] of PRESENTATIONS) {
  describe(`presentationConformance — ${name}`, () => {
    for (const conformanceCase of presentationConformance(factory)) {
      test(conformanceCase.name, conformanceCase.run)
    }
  })
}

describe('the kit itself', () => {
  test('exposes the full case list without mounting anything', () => {
    // §3.1.9 budgeted 27; the shipped kit is 31, because four rules that the estimate folded
    // together fail for genuinely different reasons and are worth naming separately.
    const cases = presentationConformance(domPresentation)
    expect(cases).toHaveLength(31)
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(cases.length)
    for (const entry of cases) expect(typeof entry.run).toBe('function')
    expect(document.querySelectorAll('[data-comment-ui]')).toHaveLength(0)
  })

  test('no case asserts a class name — the second §3.1.9 migration rule', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../src/testing/presentation-conformance.ts'), 'utf8')
    // Not one `.cc-*` anywhere, and not one class selector: the vocabulary is element names,
    // `role`, `aria-*` and accessible names built from `Labels`. (`#id` selectors survive —
    // they address the *page's* fixture and the heading `aria-labelledby` names, which are the
    // a11y contract itself.)
    expect(source).not.toMatch(/\.cc-[a-z-]+/)
    expect(source).not.toMatch(/querySelector(All)?\(\s*['"`]\./)
  })
})
