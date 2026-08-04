/**
 * The design contract, as assertions.
 *
 * `docs/DESIGN.md` is LOCKED and says implementers must not make design decisions — which is only
 * enforceable if the decisions it already made are checkable. These are the ones a behavioural test
 * cannot see: a sprite that grew a nineteenth glyph, a `border` sneaking back onto glass (§0 D1's
 * whole complaint), a `backdrop-filter` that animates (the single most expensive thing you can do
 * on someone else's compositor), a kill switch that got dropped, or a destructive control that
 * stopped arming.
 *
 * The seam is asserted here too, because "the extension renders through the locked presentation
 * types" is a claim, and `HEAD_RENDERS_THROUGH_THE_SEAM` is the compile-time half of its proof.
 */

import type { SwarmPresentation } from '@astrale-os/swarm/presentation'

import { describe, expect, it } from 'vitest'

import { HEAD_RENDERS_THROUGH_THE_SEAM } from '../src/swarm/types.ts'
import { AFFORDANCES } from '../src/swarm/ui/intent-map.ts'
import { SWARM_LABELS } from '../src/swarm/ui/labels.ts'
import { glassSwarmPresentation } from '../src/swarm/ui/presentation.ts'
import { GLYPHS } from '../src/swarm/ui/sprite.ts'
import { swarmGlassStyles } from '../src/swarm/ui/styles.ts'

describe('the sprite (DESIGN §5)', () => {
  it('is exactly eighteen glyphs', () => {
    expect(Object.keys(GLYPHS)).toHaveLength(18)
  })

  it('does not contain `cc-i-ask`, which §0 D5 deleted along with the "?"', () => {
    expect(Object.keys(GLYPHS)).not.toContain('cc-i-ask')
  })

  it('draws every glyph on the ¼-pixel grid the spec pins them to', () => {
    for (const [id, paths] of Object.entries(GLYPHS)) {
      expect(paths.length, id).toBeGreaterThan(0)
      for (const path of paths) expect(path.length, id).toBeGreaterThan(4)
    }
  })
})

describe('the intent map (head deviation E4)', () => {
  it('names only glyphs that exist', () => {
    for (const row of AFFORDANCES) expect(Object.keys(GLYPHS), row.id).toContain(row.glyph)
  })

  it('never gives two affordances in one cluster the same mark', () => {
    const seen = new Map<string, string>()
    for (const row of AFFORDANCES) {
      const key = `${row.cluster}/${row.glyph}`
      expect(seen.get(key), `${row.id} collides with ${seen.get(key) ?? ''}`).toBeUndefined()
      seen.set(key, row.id)
    }
  })

  it('arms every destructive control, and only those', () => {
    const arming = AFFORDANCES.filter((row) => row.arms)
      .map((row) => row.id)
      .sort()
    expect(arming).toEqual(
      [
        'archive',
        'cancel-delegation',
        'discard',
        'hard-kill',
        'kill-instances',
        'kill-switch',
        'unpair',
      ].sort(),
    )
  })

  it('gives every affordance a sentence, because the verb exists nowhere else (§10)', () => {
    for (const row of AFFORDANCES) {
      expect(row.label.length, row.id).toBeGreaterThan(8)
      expect(row.label, row.id).toBe(row.label.trim())
    }
  })

  it('states what the kill switch is, in the kill switch’s own label (Q16)', () => {
    const kill = AFFORDANCES.find((row) => row.id === 'kill-switch')!
    expect(kill.label).toContain('No delegation is terminated')
    expect(kill.label).toContain('no worktree is touched')
  })
})

describe('the stylesheet (DESIGN §2–§6, §11)', () => {
  it('declares no visible `border` — glass is elevation, never stroke (§0 D1)', () => {
    // `border: 0` is a reset on a native control, not a stroke. The only *visible* border allowed
    // anywhere is the `forced-colors` one, which §3.2 mandates because that mode drops shadows.
    // `(?<![-\w])` keeps `--_border` and `border-radius` out of it: the ban is on the shorthand.
    const borders = [...swarmGlassStyles.matchAll(/(?<![-\w])border:\s*([^;}]+)/g)].map((m) =>
      m[1]!.trim(),
    )
    expect(borders.filter((value) => value !== '0' && value !== '1px solid CanvasText')).toEqual([])
    expect(borders).toContain('1px solid CanvasText')
  })

  it('never animates or transitions `backdrop-filter` (§6.3)', () => {
    expect(swarmGlassStyles).not.toMatch(/transition:[^;]*backdrop-filter/)
    expect(swarmGlassStyles).not.toMatch(/animation:[^;]*backdrop-filter/)
  })

  it('keeps the opacity floor at 74 % light and 64 % dark (§3.1)', () => {
    expect(swarmGlassStyles).toContain('var(--_surface) 74%')
    expect(swarmGlassStyles).toContain('var(--_surface) 64%')
  })

  it('ships all three kill switches plus forced-colors, with no host opt-out (§3.2)', () => {
    expect(swarmGlassStyles).toContain('prefers-reduced-transparency: reduce')
    expect(swarmGlassStyles).toContain('prefers-contrast: more')
    expect(swarmGlassStyles).toContain('@supports not (backdrop-filter: blur(1px))')
    expect(swarmGlassStyles).toContain('forced-colors: active')
  })

  it('reads the eleven public tokens and declares none of them (§13 ruling 3)', () => {
    for (const token of ['--cc-accent', '--cc-surface', '--cc-text', '--cc-muted', '--cc-shadow']) {
      expect(swarmGlassStyles).toContain(`var(${token},`)
      expect(swarmGlassStyles).not.toMatch(new RegExp(`\\n\\s*${token}\\s*:`))
    }
  })

  it('closes all four edges from the inside, so the outer ring stays a hairline (§0 D1)', () => {
    expect(swarmGlassStyles).toContain('inset 0 0 0 .5px var(--_line-in)')
    expect(swarmGlassStyles).toContain('--_line-out: oklch(0% 0 0 / .16)')
  })

  it('carries the two springs and the four durations, and nothing else (§6.1, §6.2)', () => {
    expect(swarmGlassStyles).toContain('--_spring-1: linear(')
    expect(swarmGlassStyles).toContain('--_spring-2: linear(')
    for (const duration of ['--_d1: 90ms', '--_d2: 160ms', '--_d3: 220ms', '--_d4: 320ms']) {
      expect(swarmGlassStyles).toContain(duration)
    }
  })

  it('maps reduced motion rather than turning it off, and never to 0 ms (§6.7)', () => {
    expect(swarmGlassStyles).toContain('prefers-reduced-motion: reduce')
    expect(swarmGlassStyles).toContain('transition-duration: 1ms')
  })

  it('never loops an animation forever except the ambient presence ring (§6.8)', () => {
    const infinite = swarmGlassStyles.match(/animation:[^;]*infinite/g) ?? []
    expect(infinite).toHaveLength(1)
    expect(infinite[0]).toContain('cc-breathe')
  })

  /*
   * `hidden` is the head's ONLY hiding mechanism — `setAttr(el, 'hidden', …)` in `ui/dom.ts` is
   * what the pairing card, the fleet surface, the detail pane, the lag banner, the notice stack,
   * the background strip, the empty state, the metric row, the composer row and every
   * `glyphButton` use. The UA's `[hidden]` rule is specificity 0-1-0, so a single class rule
   * declaring `display` silently defeats it, and the surface suite could not tell: it asserts
   * `hasAttribute('hidden')`, which is true either way. The head shipped with `hidden` inert.
   *
   * This asserts the EFFECT, over every class in the sheet that declares `display` — so a class
   * added tomorrow is covered without anyone remembering to extend a list.
   */
  it('makes `hidden` actually hide, for every class the sheet styles', () => {
    /* Every class the sheet names, not only the ones that declare `display` today: a rule that
     * gains one tomorrow must not silently re-break `hidden`. */
    const classes = new Set(
      [...swarmGlassStyles.matchAll(/\.(cc-[a-z0-9-]+)/g)].map((match) => match[1]!),
    )
    expect(classes.size).toBeGreaterThan(20)
    for (const known of ['cc-app', 'cc-pair', 'cc-detail', 'cc-lagged', 'cc-notices', 'cc-btn']) {
      expect([...classes]).toContain(known)
    }

    const host = document.createElement('div')
    document.body.append(host)
    const root = host.attachShadow({ mode: 'open' })
    const sheet = document.createElement('style')
    sheet.textContent = swarmGlassStyles
    root.append(sheet)

    const inert: string[] = []
    for (const className of classes) {
      const el = document.createElement('div')
      el.className = className
      el.setAttribute('hidden', '')
      root.append(el)
      if (globalThis.getComputedStyle(el).display !== 'none') inert.push(className)
      el.remove()
    }
    expect(inert).toEqual([])
    host.remove()
  })
})

describe('the seam (§6.8, H6)', () => {
  it('the head’s view model and intents are still assignable to the locked types', () => {
    expect(HEAD_RENDERS_THROUGH_THE_SEAM).toEqual([true, true, true])
  })

  it('the renderer is a `SwarmPresentation`, structurally', () => {
    const presentation: SwarmPresentation = glassSwarmPresentation({
      pair: () => {},
      unpair: () => {},
    })
    expect(typeof presentation.mount).toBe('function')
    expect(typeof presentation.render).toBe('function')
    expect(typeof presentation.destroy).toBe('function')
  })

  it('fills every key of the locked 19-key `SwarmLabels`', () => {
    expect(Object.keys(SWARM_LABELS)).toHaveLength(19)
    for (const [key, value] of Object.entries(SWARM_LABELS)) {
      expect(typeof value, key).toBe('string')
      expect(value.length, key).toBeGreaterThan(0)
    }
  })
})
