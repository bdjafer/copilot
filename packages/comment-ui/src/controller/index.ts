/**
 * `createCommentUIController` (§3.1) — lifecycle, subscriptions, the decoration map, the five
 * state slots, teardown, and the presentation lifecycle with its fault isolation.
 *
 * This is the whole of `comment-ui`'s behaviour. Everything §3 says the package owns is owned
 * here — the shadow root, the `pointer-events: none` layer, never mutating the host page,
 * positioning, the off-screen skip, `pending` renders nothing, the `decorate()` lifecycle, the
 * Esc chain, the a11y policy — and **a presentation cannot opt out of any of it, because none
 * of it is reachable from the presentation's surface** (decision log #30).
 *
 * Render is coalesced onto a microtask: `engine.threads`, `engine.placement`, `engine.active`
 * and `decorate()` can all move within one turn (a submit fires `thread:create`, a view swap and
 * a `placement:end` back to back), and a pass per notification would rebuild the popover 3×
 * mid-interaction.
 *
 * Pass order is fixed and load-bearing:
 *   1. transitions (composer open/close focus capture, popover open, placement announce);
 *   2. build the model and publish it;
 *   3. `presentation.update(vm)` — where a presentation registers its nodes;
 *   4. positioning + the off-screen observers, against the nodes step 3 just registered.
 */

import type {
  CommentEngine,
  ReadableStore,
  ThreadView,
  Unsubscribe,
} from '@astrale-os/comment-core'
import type { ReferenceElement } from '@floating-ui/dom'

import type { SurfaceRef, VisibilityWatcher } from '../position.ts'
import type {
  Intents,
  PresentationHost,
  PresentationInstance,
  UIViewModel,
} from '../presentation.ts'
import type {
  CommentUIController,
  CommentUIOptions,
  Decoration,
  PanelSection,
  ResolvedOptions,
} from '../types.ts'
import type { ControllerState, UISlots } from './model.ts'

import { deepActiveElement, safeFocus, setAttr, setText } from '../dom.ts'
import { resolveLabels } from '../labels.ts'
import { centerReference, createPositioner, dockedReference, watchVisibility } from '../position.ts'
import { createLayer } from '../shadow.ts'
import { createFocusPolicy } from './focus.ts'
import { createIntents } from './intents.ts'
import { createModelBuilder, sectionOf } from './model.ts'

const ALL_SECTIONS: readonly PanelSection[] = ['open', 'resolved', 'unanchored']

/** A composer reference, plus whether it is docked to the popover it is replying into (§7). */
interface ComposerRef {
  token: unknown
  reference: ReferenceElement
  docked?: boolean
}

export function resolveOptions(
  options: CommentUIOptions | undefined,
  fallbackPresentation: ResolvedOptions['presentation'],
): ResolvedOptions {
  const doc = (globalThis as { document?: Document }).document
  const container = options?.container ?? doc?.documentElement
  if (!container) {
    throw new TypeError('comment-ui: no container — pass `container` when there is no document')
  }
  const panel = options?.panel ?? {}
  const badge = options?.badge ?? {}
  return {
    container,
    css: options?.css ?? '',
    labels: resolveLabels(options?.labels),
    panel: {
      enabled: panel.enabled ?? true,
      corner: panel.corner ?? 'br',
      defaultOpen: panel.defaultOpen ?? false,
      sections: panel.sections ?? ALL_SECTIONS,
    },
    badge: {
      showResolved: badge.showResolved ?? false,
      orphaned: badge.orphaned ?? 'dock',
      offset: badge.offset ?? [6, -6],
      hideOffscreen: badge.hideOffscreen ?? true,
    },
    isolateEvents: options?.isolateEvents ?? true,
    zIndex: options?.zIndex ?? 2147483000,
    rootFontSize: options?.rootFontSize ?? '16px',
    onError:
      options?.onError ??
      (() => {
        /* swallowed by default: a renderer fault must never break the host page */
      }),
    // `undefined` takes the default; an explicit `null` mounts headless.
    presentation: options?.presentation === undefined ? fallbackPresentation : options.presentation,
  }
}

export function createController(
  resolved: ResolvedOptions,
  engine: CommentEngine,
): CommentUIController {
  const layer = createLayer(resolved)

  const onError = (error: unknown): void => {
    try {
      resolved.onError(error)
    } catch {
      /* an onError that throws must not take the renderer with it */
    }
  }

  const positioner = createPositioner({ onError })
  const model = createModelBuilder()
  const decorations = new Map<string, Decoration>()
  const offscreen = new Set<string>()
  const watchers = new Map<string, { element: Element; watcher: VisibilityWatcher | null }>()

  const slots: UISlots = {
    activeId: null,
    panelOpen: resolved.panel.enabled && resolved.panel.defaultOpen,
    section: resolved.panel.sections[0] ?? null,
    editing: null,
    announce: '',
    focus: null,
  }

  let destroyed = false
  let rendering = false
  let renderQueued = false
  let dirtyWhileRendering = false
  let composerOpen = false
  let lastOpenThread: string | null = null
  let picking = false
  let composerRef: ComposerRef | null = null
  let placementJustCancelled = false
  /** The section the *active* thread was last in, so a transition can follow it (§8.5). */
  let activeSection: { threadId: string; section: PanelSection | null } | null = null

  function schedule(): void {
    if (destroyed) return
    if (rendering) {
      dirtyWhileRendering = true
      return
    }
    if (renderQueued) return
    renderQueued = true
    queueMicrotask(() => {
      if (renderQueued) render()
    })
  }

  const focus = createFocusPolicy({
    doc: layer.doc,
    root: layer.root,
    slot: slots,
    keyOf: (node) => positioner.keyOf(node),
    schedule,
  })

  function closeThread(restoreFocus: boolean): void {
    if (slots.activeId === null) return
    const previous = slots.activeId
    slots.activeId = null
    slots.editing = null
    schedule()
    if (restoreFocus) focus.request({ kind: 'badge', threadId: previous })
  }

  const intents: Intents = createIntents({
    engine,
    options: resolved,
    slots,
    focus,
    schedule,
    onError,
    placementJustCancelled: () => placementJustCancelled,
    closeThread,
  })

  /* ------------------------------------------------------------------- the model store */

  let current: UIViewModel | null = null
  const listeners = new Set<(value: UIViewModel, previous: UIViewModel) => void>()

  const vm: ReadableStore<UIViewModel> = {
    get: () => {
      if (!current) current = model.build(snapshot())
      return current
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }

  function snapshot(): ControllerState {
    return {
      options: resolved,
      win: layer.win,
      modes: engine.modes,
      views: engine.threads.get(),
      placement: engine.placement.get(),
      activeId: slots.activeId,
      panelOpen: slots.panelOpen,
      section: slots.section,
      editing: slots.editing,
      decorations,
      offscreen,
      announce: slots.announce,
      focus: slots.focus,
      placementOf: (key) => positioner.placementOf(key),
    }
  }

  /* --------------------------------------------------------------------- the render pass */

  const host: PresentationHost = {
    root: layer.root,
    layer: layer.layer,
    doc: layer.doc,
    win: layer.win,
    anchor(key, node) {
      positioner.anchor(key, node)
    },
    announce(message) {
      setText(layer.status, message)
    },
  }

  let instance: PresentationInstance | null = null
  if (resolved.presentation) {
    try {
      instance = resolved.presentation.create(host, intents)
    } catch (error) {
      onError(error)
    }
  }

  /** Transitions that must be decided before the model is built, so this pass carries them. */
  function transitions(): void {
    const placement = engine.placement.get()

    const nowPicking = placement.phase === 'picking'
    if (nowPicking !== picking) {
      picking = nowPicking
      // `data-picking` is a pointer-events safety invariant, never a style choice (§3.1.5): the
      // engine resolves the pick target from `composedPath()[0]` and does not filter shadow
      // trees, so anything of ours under the cursor would otherwise become the candidate.
      setAttr(layer.layer, 'data-picking', nowPicking ? 'true' : null)
      // The region is cleared when placement ends, so re-entering re-announces: `setText` is
      // idempotent, and without the clear the second entry would change no DOM at all.
      slots.announce = nowPicking ? resolved.labels.pickHint : ''
    }

    const composing = placement.phase === 'composing' || placement.phase === 'submitting'
    if (composing && !composerOpen) {
      composerOpen = true
      focus.capture(placement.replyTo)
      focus.request({ kind: 'composer-input' })
    } else if (!composing && composerOpen) {
      composerOpen = false
      composerRef = null
      focus.restore()
    }

    const view = slots.activeId === null ? null : engine.getThreadView(slots.activeId)
    // A pending thread renders nothing anywhere (§3), popover included.
    const openThread = view && view.anchoring.status !== 'pending' ? view.id : null
    if (openThread !== lastOpenThread) {
      lastOpenThread = openThread
      slots.editing = null
      if (openThread !== null) focus.request({ kind: 'thread-close' })
    }

    // §8.5: the panel follows its own data. A resolve, a reopen, an orphan or a re-anchor moves
    // the *active* thread between sections, and a panel left sitting on the section it just left
    // shows an empty list while the count it is watching moved elsewhere. Only a transition of
    // the thread the user is acting on moves the selection — an explicit click still wins,
    // because nothing here fires unless the section genuinely changed under it.
    const section = view ? sectionOf(view) : null
    if (
      view &&
      section &&
      activeSection?.threadId === view.id &&
      activeSection.section !== section
    ) {
      if (resolved.panel.enabled && resolved.panel.sections.includes(section)) {
        slots.section = section
      }
    }
    activeSection = view ? { threadId: view.id, section } : null
  }

  function referenceForThread(view: ThreadView): { token: unknown; reference: ReferenceElement } {
    const badge = positioner.node(`badge:${view.id}`)
    if (badge) return { token: badge, reference: badge }
    if (view.anchoring.element) {
      return { token: view.anchoring.element, reference: view.anchoring.element }
    }
    if (view.anchoring.rect) {
      return { token: view.id, reference: dockedReference(view.anchoring.rect, layer.win) }
    }
    return { token: view.id, reference: centerReference(layer.win) }
  }

  function referenceForComposer(): ComposerRef | null {
    const state = engine.placement.get()
    if (state.phase === 'submitting') return composerRef
    if (state.phase !== 'composing') return null
    if (state.replyTo !== null) {
      const view = engine.getThreadView(state.replyTo)
      // §7's mutual exclusion: "a reply docks the composer to the popover's bottom edge and
      // matches its width, so reply reads as one sheet growing downward". Against the *badge*
      // it opened as a second box beside the popover, over its own close control.
      const popover = lastOpenThread === state.replyTo ? positioner.node('thread') : null
      if (popover) return { token: popover, reference: popover, docked: true }
      const badge = positioner.node(`badge:${state.replyTo}`)
      if (badge) return { token: badge, reference: badge }
      if (view?.anchoring.element) {
        return { token: view.anchoring.element, reference: view.anchoring.element }
      }
      if (view?.anchoring.rect) {
        return { token: state.replyTo, reference: dockedReference(view.anchoring.rect, layer.win) }
      }
      return { token: state.replyTo, reference: centerReference(layer.win) }
    }
    const range = state.range as { getBoundingClientRect?: () => DOMRect } | null
    if (range && typeof range.getBoundingClientRect === 'function') {
      const read = range.getBoundingClientRect.bind(range)
      return { token: state.range, reference: { getBoundingClientRect: () => read() } }
    }
    return { token: state.element, reference: state.element }
  }

  /**
   * DESIGN §8.7's collision contract, as a live read: while the panel is open it owns its rect,
   * and a badge that resolves underneath it is a badge nobody can click. The rect is read at
   * positioning time (so rail mode, the corner option and the hover peek are all accounted for)
   * and only while the sheet is actually on screen.
   */
  function panelObstacle(): DOMRect | null {
    if (!slots.panelOpen) return null
    const node = positioner.node('panel')
    if (!node) return null
    try {
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 ? rect : null
    } catch {
      return null
    }
  }

  /** §3.1.5: the controller decides what every registered surface is positioned against. */
  function syncPositions(visible: readonly ThreadView[]): void {
    const refs = new Map<string, SurfaceRef>()
    for (const view of visible) {
      const element = view.anchoring.element
      if (element) {
        refs.set(`badge:${view.id}`, {
          token: element,
          reference: element,
          placement: 'top-end',
          offset: resolved.badge.offset,
          active: !offscreen.has(view.id) || slots.activeId === view.id,
          avoid: panelObstacle,
        })
        continue
      }
      const rect = view.anchoring.rect
      if (!rect) continue
      refs.set(`badge:${view.id}`, {
        // Serialized, so a re-render only rebuilds the tracker when the dock actually moved.
        token: `${String(rect.top)}:${String(rect.left)}:${String(rect.width)}:${String(rect.height)}`,
        reference: dockedReference(rect, layer.win),
        placement: 'top-end',
        offset: resolved.badge.offset,
        active: true,
        avoid: panelObstacle,
      })
    }

    if (lastOpenThread !== null) {
      const view = engine.getThreadView(lastOpenThread)
      if (view) {
        const ref = referenceForThread(view)
        refs.set('thread', { ...ref, placement: 'bottom-end', offset: [0, 8], active: true })
      }
    }

    const composer = referenceForComposer()
    if (composer) {
      composerRef = composer
      refs.set('composer', {
        token: composer.token,
        reference: composer.reference,
        placement: 'bottom-start',
        // Flush against the popover's bottom edge, so the reply reads as the same sheet growing
        // downward rather than as a second box that happens to be nearby.
        offset: composer.docked ? [0, 0] : [0, 8],
        active: true,
      })
    }

    positioner.sync(refs)
  }

  /** The off-screen skip (§3). Observers are keyed on the element, never rebuilt per pass. */
  function syncWatchers(visible: readonly ThreadView[]): void {
    if (!resolved.badge.hideOffscreen) return
    const wanted = new Set<string>()
    for (const view of visible) {
      const element = view.anchoring.element
      // A view that lost its element is a dock, and a dock is never off-screen: its position is
      // ours, not the page's. Forgetting the flag here is what left an orphan permanently
      // `hidden` — the observer's last `isIntersecting: false` for the element that was just
      // removed can land after the teardown, and nothing would ever clear it again.
      if (!element) {
        const stale = watchers.get(view.id)
        if (stale) {
          stale.watcher?.destroy()
          watchers.delete(view.id)
        }
        offscreen.delete(view.id)
        continue
      }
      wanted.add(view.id)
      const entry = watchers.get(view.id)
      if (entry?.element === element) continue
      entry?.watcher?.destroy()
      offscreen.delete(view.id)
      const next: { element: Element; watcher: VisibilityWatcher | null } = {
        element,
        watcher: null,
      }
      watchers.set(view.id, next)
      next.watcher = watchVisibility(element, layer.win, (isVisible) => {
        // …and a callback that outlives its own registration is ignored outright, so a
        // disconnect that raced a queued record cannot resurrect the flag.
        if (watchers.get(view.id) !== next) return
        if (isVisible) offscreen.delete(view.id)
        else offscreen.add(view.id)
        schedule()
      })
    }
    for (const [id, entry] of Array.from(watchers)) {
      if (wanted.has(id)) continue
      entry.watcher?.destroy()
      watchers.delete(id)
      offscreen.delete(id)
    }
  }

  function publish(next: UIViewModel): void {
    const previous = current ?? next
    current = next
    for (const listener of Array.from(listeners)) {
      try {
        listener(next, previous)
      } catch (error) {
        onError(error)
      }
    }
  }

  function render(): void {
    if (destroyed) return
    renderQueued = false
    rendering = true
    try {
      transitions()
      const next = model.build(snapshot())
      publish(next)
      setText(layer.status, next.announce)
      // §3.1.4 step 5: a presentation fault is caught, reported and the pass abandoned — it must
      // never break the host page or the engine.
      if (instance) {
        try {
          instance.update(next)
        } catch (error) {
          onError(error)
          return
        }
      }
      const visible = model.visible()
      syncWatchers(visible)
      syncPositions(visible)
    } catch (error) {
      onError(error)
    } finally {
      rendering = false
      if (dirtyWhileRendering) {
        dirtyWhileRendering = false
        schedule()
      }
    }
  }

  /* ------------------------------------------------------------------------- wiring */

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (intents.escape()) event.preventDefault()
  }
  layer.layer.addEventListener('keydown', onKeydown)

  const subscriptions: Unsubscribe[] = [
    engine.threads.subscribe(schedule),
    engine.placement.subscribe(schedule),
    engine.active.subscribe((value, previous) => {
      // `engine.active` is the source of truth whenever the engine moved it (focus(), a page
      // unload, a deleted thread). It clears the UI's own selection only when the two agree:
      // an orphan opened from the panel never reached `engine.focus`, so `engine.active` is
      // stale for it, and a clear meant for a *different* thread must not close it.
      if (value !== null) slots.activeId = value
      else if (slots.activeId === previous) slots.activeId = null
      schedule()
    }),
    engine.on('thread:click', ({ thread }) => {
      // Fires on every `engine.focus()`, including a re-focus of the already-active thread —
      // `engine.active` would not notify for that, so this is what makes re-open work.
      slots.activeId = thread.id
      schedule()
    }),
    engine.on('thread:delete', ({ thread }) => {
      // §3 decoration lifecycle: a decoration is dropped on its thread's deletion.
      decorations.delete(thread.id)
      if (slots.activeId === thread.id) slots.activeId = null
      schedule()
    }),
    engine.on('placement:end', ({ reason }) => {
      if (reason !== 'cancelled') return
      placementJustCancelled = true
      // A microtask cannot run in the middle of a synchronous event dispatch, so clearing the
      // flag here is exact.
      queueMicrotask(() => {
        placementJustCancelled = false
      })
    }),
    engine.on('page:change', () => {
      // §3 decoration lifecycle: the whole map is cleared on navigation, so a stale chip
      // cannot survive it.
      decorations.clear()
      slots.activeId = null
      schedule()
    }),
  ]

  // §3.1.4 step 2: the first `update(vm)` is synchronous, before this function returns.
  render()

  return {
    root: layer.root,
    engine,
    vm,
    intents,

    panel: {
      open(section) {
        intents.openPanel(section)
      },
      close() {
        intents.closePanel()
      },
      toggle() {
        intents.togglePanel()
      },
      get isOpen() {
        return slots.panelOpen
      },
    },

    focus(threadId) {
      intents.openThread(threadId)
    },

    decorate(threadId, decoration) {
      if (decoration === null) decorations.delete(threadId)
      else decorations.set(threadId, decoration)
      schedule()
    },

    unmount() {
      if (destroyed) return
      destroyed = true
      const focused = deepActiveElement(layer.doc)
      for (const unsubscribe of subscriptions) unsubscribe()
      subscriptions.length = 0
      layer.layer.removeEventListener('keydown', onKeydown)
      // §3.1.4 step 4: `destroy()` runs BEFORE the layer is torn down, and `update` is never
      // called after it.
      if (instance) {
        try {
          instance.destroy()
        } catch (error) {
          onError(error)
        }
        instance = null
      }
      positioner.destroy()
      for (const entry of watchers.values()) entry.watcher?.destroy()
      watchers.clear()
      offscreen.clear()
      decorations.clear()
      listeners.clear()
      layer.destroy()
      if (focused && !focused.isConnected) safeFocus(layer.doc.body)
    },
  }
}
