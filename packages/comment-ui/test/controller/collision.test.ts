/**
 * DESIGN §8.7's collision contract, amendment A3 — "the panel owns its rect".
 *
 * The middleware is unit-tested rather than driven through `computePosition`, and that is
 * deliberate: happy-dom has no layout, so every rect in this runtime is zero and a positioning
 * pass proves nothing. What *is* worth pinning is the decision — which way a badge is nudged,
 * when it is left alone, and that it is never pushed off the edge of the viewport, which is the
 * failure a browser found (fan members measured at y = −16, painting clipped half-dots over the
 * page title, and badges resolving underneath the panel where nothing can click them).
 */

import { describe, expect, test } from 'vitest'

import type { Obstacle } from '../../src/position.ts'

import { avoidRect } from '../../src/position.ts'

const PADDING = 8

interface Args {
  x: number
  y: number
  width?: number
  height?: number
  viewport?: number
}

/** The middleware's arguments, narrowed to the four fields this one reads. */
function run(obstacle: Obstacle | null, args: Args): { x?: number } {
  const width = args.width ?? 22
  const height = args.height ?? 22
  const floating = {
    ownerDocument: { defaultView: { innerWidth: args.viewport ?? 1000 } },
  } as unknown as HTMLElement
  const middleware = avoidRect(() => obstacle, PADDING)
  const result = middleware.fn({
    x: args.x,
    y: args.y,
    rects: { floating: { width, height }, reference: { width: 0, height: 0, x: 0, y: 0 } },
    elements: { floating },
  } as unknown as Parameters<typeof middleware.fn>[0])
  return result as { x?: number }
}

const panel: Obstacle = { left: 700, top: 400, right: 1000, bottom: 900 }

describe('a badge that resolves on the panel', () => {
  test('is nudged to the free side, clear of the sheet', () => {
    // Underneath the sheet: unclickable, and invisible under a surface with a backdrop filter.
    expect(run(panel, { x: 780, y: 500 })).toEqual({ x: panel.left - 22 - 6 })
  })

  test('is left exactly where it was when it never touched the sheet', () => {
    expect(run(panel, { x: 120, y: 500 })).toEqual({})
    // Adjacent on the y axis, clear on the x axis: still not a collision.
    expect(run(panel, { x: 780, y: 100 })).toEqual({})
    // Sharing an edge is not overlapping — nudging here would move a badge for nothing.
    expect(run(panel, { x: panel.left - 22, y: 500 })).toEqual({})
  })

  test('goes the other way when the left side has no room', () => {
    const edge: Obstacle = { left: 0, top: 0, right: 300, bottom: 900 }
    expect(run(edge, { x: 10, y: 100 })).toEqual({ x: 306 })
  })

  test('and stays put when neither side has room, rather than leaving the viewport', () => {
    // A badge shoved somewhere arbitrary is worse than one behind a sheet the user can close in
    // a keystroke — and A3's floor is that nothing is ever positioned outside the viewport.
    const wide: Obstacle = { left: 0, top: 0, right: 980, bottom: 900 }
    expect(run(wide, { x: 10, y: 100, viewport: 1000 })).toEqual({})
  })

  test('does nothing at all while the panel is closed', () => {
    expect(run(null, { x: 780, y: 500 })).toEqual({})
  })
})
