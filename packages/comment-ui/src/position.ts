/**
 * Positioning (§5.2 `position.ts`, §3.1.5): `@floating-ui/dom` + `autoUpdate` for badges and
 * popovers, `IntersectionObserver` to cheaply skip off-screen badges, and the `host.anchor()`
 * registry that binds a presentation's node to a surface key.
 *
 * **The coordinate contract (§3.1.5, decision log #34).** Positioning is logic, not appearance:
 * it decides *where a thing is*, and it is the part that regressed against real pages in the
 * bench. So the controller owns all of it — `computePosition`, `autoUpdate`, the off-screen
 * skip, the docked-orphan reference, `left`/`top`, `data-placement` and `data-picking` — and a
 * presentation only ever hands over a node. The corollary is the gift: `transform`, `opacity`,
 * `clip-path` and friends on those same nodes are then entirely the presentation's, with zero
 * conflict, which is why a motion catalog needs no coordination with this file.
 *
 * `autoUpdate` already composes the loop we would hand-roll — capture-phase passive scroll
 * listeners (so nested scrollers are caught), `resize`, `ResizeObserver`, and `animationFrame`
 * for elements moved by page JS. `animationFrame: true` is what makes the **orphan dock**
 * correct: its reference is a virtual element derived from a `DocumentRect`, and only a
 * per-frame re-read re-projects document space into viewport space after a scroll, so the dock
 * cannot drift (§3).
 *
 * `strategy: 'fixed'` matches the `position: fixed` layer, so floating-ui's coordinates and the
 * layer's coordinate system are the same thing and no offset-parent maths is needed.
 */

import type { DocumentRect } from '@astrale-os/comment-core'
import type { Middleware, Placement, ReferenceElement } from '@floating-ui/dom'

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'

/** A rect a surface must not land on. Structurally a `DOMRect`'s read half. */
export interface Obstacle {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/**
 * DESIGN §8.7: **the panel owns its rect.** A badge that resolves underneath the sheet is a badge
 * nobody can click, and floating-ui has no concept of an obstacle that is not an ancestor — so
 * this is the one custom middleware in the package. It nudges along the anchor edge (x, the axis
 * a badge is already free on) to whichever side has room, and does nothing at all when neither
 * side does: a badge shifted somewhere arbitrary is worse than a badge behind a sheet the user
 * can close. It runs last, so `flip`/`shift` have already had their say.
 */
export function avoidRect(get: () => Obstacle | null, padding: number): Middleware {
  return {
    name: 'cc-avoid',
    fn({ x, y, rects, elements }) {
      const box = get()
      if (!box) return {}
      const { width, height } = rects.floating
      if (x >= box.right || x + width <= box.left || y >= box.bottom || y + height <= box.top) {
        return {}
      }
      const gap = 6
      const left = box.left - width - gap
      if (left >= padding) return { x: left }
      const right = box.right + gap
      const limit = elements.floating.ownerDocument.defaultView?.innerWidth ?? 0
      // Neither side has room: leave it where it was. A badge shoved somewhere arbitrary is
      // worse than one behind a sheet the user can close in a keystroke.
      return right + width + padding <= limit ? { x: right } : {}
    },
  }
}

export interface Tracker {
  /** Force a reposition (used when the reference's rect is known to have changed). */
  update(): void
  destroy(): void
}

export interface TrackOptions {
  placement?: Placement
  /** `[crossAxis, mainAxis]` in CSS px — the `CommentUIOptions.badge.offset` tuple. */
  offset?: readonly [number, number]
  padding?: number
  onError?: (error: unknown) => void
  /** Fired after every successful pass, with floating-ui's *resolved* placement. */
  onPlaced?: (placement: string) => void
  /** DESIGN §8.7: a rect this surface must not land on, re-read every pass. */
  avoid?: () => Obstacle | null
  /**
   * DESIGN §8.1: **the pin's tip is the origin.** A point-anchored pin is placed so its box's
   * top-left lands exactly on the click point, and which way the body hangs is `pinCorner` plus
   * the presentation's `translate` — so `flip` and `shift` must not run, or they would move the
   * tip off the coordinate the user chose. Every other surface keeps the full middleware stack.
   */
  exact?: boolean
}

export function track(
  reference: ReferenceElement,
  floating: HTMLElement,
  options: TrackOptions = {},
): Tracker {
  const [crossAxis, mainAxis] = options.offset ?? [0, 6]
  const padding = options.padding ?? 8
  const avoid = options.avoid
  let stopped = false

  const update = (): void => {
    if (stopped) return
    computePosition(reference, floating, {
      strategy: 'fixed',
      placement: options.placement ?? 'top-end',
      middleware: options.exact
        ? [offset({ mainAxis, crossAxis })]
        : [
            offset({ mainAxis, crossAxis }),
            flip({ padding }),
            // §8.7 / DESIGN amendment A3: `crossAxis` is what keeps a badge whose anchor sits at
            // the very top of the document *inside the viewport* — without it, a `top-end` badge
            // that cannot flip resolves at a negative y and paints a clipped half-dot.
            shift({ padding, crossAxis: true }),
            ...(avoid ? [avoidRect(avoid, padding)] : []),
          ],
    })
      .then((result) => {
        if (stopped) return
        floating.style.left = `${String(Math.round(result.x))}px`
        floating.style.top = `${String(Math.round(result.y))}px`
        // §3.1.5: `data-placement` is the controller's, so a presentation can grow a surface out
        // of the correct edge without ever computing where that edge is.
        const resolved = result.placement as string | undefined
        if (resolved && floating.getAttribute('data-placement') !== resolved) {
          floating.setAttribute('data-placement', resolved)
        }
        if (resolved) options.onPlaced?.(resolved)
      })
      .catch((error: unknown) => {
        options.onError?.(error)
      })
  }

  let cleanup: (() => void) | null = null
  try {
    cleanup = autoUpdate(reference, floating, update, { animationFrame: true })
  } catch (error) {
    options.onError?.(error)
    update()
  }

  return {
    update,
    destroy() {
      if (stopped) return
      stopped = true
      cleanup?.()
    },
  }
}

/**
 * A virtual reference for an orphaned thread's last-known **document-space** rect. Converting
 * on every read (rather than once, at dock time) is the whole point: `autoUpdate`'s frame loop
 * re-reads this, so scrolling re-projects instead of drifting.
 */
export function dockedReference(rect: DocumentRect, win: Window): ReferenceElement {
  return {
    getBoundingClientRect() {
      const left = rect.left - (win.scrollX || 0)
      const top = rect.top - (win.scrollY || 0)
      return {
        x: left,
        y: top,
        left,
        top,
        width: rect.width,
        height: rect.height,
        right: left + rect.width,
        bottom: top + rect.height,
      }
    },
  }
}

/**
 * A **virtual reference at the click point** (decision log #44, DESIGN §0 D8) — a 0×0 rect at the
 * live coordinate. floating-ui's whole middleware stack keeps working unmodified against it, so
 * "open exactly where I clicked, and flip near the edge" costs one reference rather than a fork
 * of the hardest positioning case in the package.
 *
 * The point is read on **every** pass, not captured once: `autoUpdate`'s frame loop is what makes
 * a coordinate anchored to a scrolling document stay put, exactly as for the orphan dock.
 */
export function pointReference(read: () => { x: number; y: number } | null): ReferenceElement {
  return {
    getBoundingClientRect() {
      const point = read() ?? { x: 0, y: 0 }
      return {
        x: point.x,
        y: point.y,
        left: point.x,
        top: point.y,
        width: 0,
        height: 0,
        right: point.x,
        bottom: point.y,
      }
    },
  }
}

/** Last-resort reference for a popover whose thread has neither a badge nor a live element. */
export function centerReference(win: Window): ReferenceElement {
  return {
    getBoundingClientRect() {
      const x = (win.innerWidth || 0) / 2
      const y = (win.innerHeight || 0) / 2
      return { x, y, left: x, top: y, width: 0, height: 0, right: x, bottom: y }
    },
  }
}

export interface VisibilityWatcher {
  destroy(): void
}

/**
 * Off-screen skip (§3). The callback is only ever invoked by the observer, so the caller's
 * initial state must be "visible" — a stubbed or absent `IntersectionObserver` (happy-dom,
 * old Safari) then degrades to "always tracked", never to "badge missing".
 */
export function watchVisibility(
  element: Element,
  win: Window,
  onChange: (visible: boolean) => void,
): VisibilityWatcher | null {
  const Ctor = (win as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver
  if (typeof Ctor !== 'function') return null
  try {
    const observer = new Ctor(
      (entries) => {
        const last = entries[entries.length - 1]
        if (last) onChange(last.isIntersecting)
      },
      { rootMargin: '96px' },
    )
    observer.observe(element)
    return {
      destroy() {
        observer.disconnect()
      },
    }
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------- the anchor registry */

/** What the controller wants a surface tracked against, this pass. */
export interface SurfaceRef {
  /**
   * Rebuild the tracker only when this changes — an unconditional teardown on every render
   * pass would restart the frame loop constantly.
   */
  token: unknown
  reference: ReferenceElement
  placement: Placement
  offset: readonly [number, number]
  /** False while the surface is deliberately un-tracked (an off-screen, un-pinned badge). */
  active: boolean
  /** DESIGN §8.7: a rect this surface must not land on, re-read every positioning pass. */
  avoid?: () => Obstacle | null
  /** DESIGN §8.1: offset only, no flip, no shift — the pin's tip must stay on its point. */
  exact?: boolean
}

interface Surface {
  node: HTMLElement | null
  token: unknown
  reference: ReferenceElement | null
  placement: Placement
  offset: readonly [number, number]
  active: boolean
  avoid: (() => Obstacle | null) | undefined
  exact: boolean
  tracker: Tracker | null
  resolved: string | null
}

export interface Positioner {
  /** `PresentationHost.anchor` — register (or clear) the node for a surface key. */
  anchor(key: string, node: HTMLElement | null): void
  node(key: string): HTMLElement | null
  /** The surface key a node (or one of its ancestors) was registered under. */
  keyOf(node: Node | null): string | null
  /** floating-ui's last resolved placement for a key. */
  placementOf(key: string): string | null
  /** Apply this pass's reference set. Keys absent from `refs` are torn down. */
  sync(refs: ReadonlyMap<string, SurfaceRef>): void
  destroy(): void
}

/**
 * The registry is deliberately tolerant of ordering: a presentation registers its nodes from
 * inside `update(vm)`, i.e. *after* the controller computed this pass's references, and a node
 * can also arrive between passes. Both halves (node, reference) are stored independently and a
 * tracker starts as soon as both exist — so neither side has to know about the other's timing.
 */
export function createPositioner(options: { onError: (error: unknown) => void }): Positioner {
  const surfaces = new Map<string, Surface>()
  let wanted: ReadonlySet<string> = new Set()

  function stop(surface: Surface): void {
    surface.tracker?.destroy()
    surface.tracker = null
  }

  function start(surface: Surface): void {
    if (surface.tracker || !surface.node || !surface.reference || !surface.active) return
    surface.tracker = track(surface.reference, surface.node, {
      placement: surface.placement,
      offset: surface.offset,
      // A getter, not a rect: the obstacle moves (rail mode, hover peek, a corner change) and
      // the tracker outlives every one of those without a rebuild.
      avoid: surface.avoid,
      exact: surface.exact,
      onError: options.onError,
      onPlaced: (placement) => {
        surface.resolved = placement
      },
    })
  }

  function ensure(key: string): Surface {
    let surface = surfaces.get(key)
    if (!surface) {
      surface = {
        node: null,
        token: null,
        reference: null,
        placement: 'top-end',
        offset: [0, 6],
        active: false,
        avoid: undefined,
        exact: false,
        tracker: null,
        resolved: null,
      }
      surfaces.set(key, surface)
    }
    return surface
  }

  return {
    anchor(key, node) {
      const surface = ensure(key)
      if (surface.node === node) return
      stop(surface)
      surface.node = node
      if (node) {
        start(surface)
        return
      }
      if (!wanted.has(key)) surfaces.delete(key)
    },

    node: (key) => surfaces.get(key)?.node ?? null,

    keyOf(node) {
      if (!node) return null
      for (const [key, surface] of surfaces) {
        if (surface.node && (surface.node === node || surface.node.contains(node))) return key
      }
      return null
    },

    placementOf: (key) => surfaces.get(key)?.resolved ?? null,

    sync(refs) {
      wanted = new Set(refs.keys())
      for (const [key, ref] of refs) {
        const surface = ensure(key)
        if (surface.token !== ref.token || surface.reference === null) {
          stop(surface)
          surface.token = ref.token
          surface.reference = ref.reference
          surface.resolved = null
        }
        surface.placement = ref.placement
        surface.offset = ref.offset
        surface.active = ref.active
        surface.avoid = ref.avoid
        surface.exact = ref.exact ?? false
        if (ref.active) start(surface)
        else stop(surface)
      }
      for (const [key, surface] of Array.from(surfaces)) {
        if (refs.has(key)) continue
        stop(surface)
        surface.reference = null
        surface.token = null
        surface.resolved = null
        surface.active = false
        if (!surface.node) surfaces.delete(key)
      }
    },

    destroy() {
      for (const surface of surfaces.values()) stop(surface)
      surfaces.clear()
      wanted = new Set()
    },
  }
}
