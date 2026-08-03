/**
 * Positioning (§5.2 `position.ts`, PLAN §3.3): `@floating-ui/dom` + `autoUpdate` for badges
 * and popovers, `IntersectionObserver` to cheaply skip off-screen badges.
 *
 * `autoUpdate` already composes the loop we would hand-roll — capture-phase passive scroll
 * listeners (so nested scrollers are caught), `resize`, `ResizeObserver`, and `animationFrame`
 * for elements moved by page JS. `animationFrame: true` is what makes the **orphan dock**
 * correct: its reference is a virtual element derived from a `DocumentRect`, and only a
 * per-frame re-read re-projects document space into viewport space after a scroll, so the
 * dock cannot drift (§3).
 *
 * `strategy: 'fixed'` matches the `position: fixed` layer, so floating-ui's coordinates and
 * the layer's coordinate system are the same thing and no offset-parent maths is needed.
 */

import type { DocumentRect } from '@astrale-os/comment-core'
import type { Placement, ReferenceElement } from '@floating-ui/dom'

import { autoUpdate, computePosition, flip, offset, shift } from '@floating-ui/dom'

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
}

export function track(
  reference: ReferenceElement,
  floating: HTMLElement,
  options: TrackOptions = {},
): Tracker {
  const [crossAxis, mainAxis] = options.offset ?? [0, 6]
  const padding = options.padding ?? 8
  let stopped = false

  const update = (): void => {
    if (stopped) return
    computePosition(reference, floating, {
      strategy: 'fixed',
      placement: options.placement ?? 'top-end',
      middleware: [offset({ mainAxis, crossAxis }), flip({ padding }), shift({ padding })],
    })
      .then(({ x, y }) => {
        if (stopped) return
        floating.style.left = `${String(Math.round(x))}px`
        floating.style.top = `${String(Math.round(y))}px`
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
