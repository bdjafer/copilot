/**
 * Lifecycle (§5.2 `mount.ts`): subscriptions, the decoration map, teardown — and the three
 * pieces of state §3 allows a pure renderer to own (which panel section is open, which thread
 * popover is open, the `decorate()` map).
 *
 * Render is coalesced onto a microtask: `engine.threads`, `engine.placement`, `engine.active`
 * and `decorate()` can all move within one turn (a submit fires `thread:create`, a view swap
 * and a `placement:end` back to back), and a pass per notification would rebuild the popover
 * three times mid-interaction.
 */

import type { CommentEngine, CommentEngineOptions, Unsubscribe } from '@astrale-os/comment-core'

import { createCommentEngine } from '@astrale-os/comment-core'

import type { UIContext } from './context.ts'
import type {
  CommentUI,
  CommentUIOptions,
  Decoration,
  PanelSection,
  ResolvedOptions,
} from './types.ts'

import { createBadgeLayer } from './badge.ts'
import { createComposer } from './composer.ts'
import { deepActiveElement, safeFocus, setText } from './dom.ts'
import { resolveLabels } from './labels.ts'
import { createPanel } from './panel.ts'
import { createPicker } from './picker.ts'
import { createLayer } from './shadow.ts'
import { createThreadPopover } from './thread.ts'

const ALL_SECTIONS: readonly PanelSection[] = ['open', 'resolved', 'unanchored']

function resolveOptions(options: CommentUIOptions | undefined): ResolvedOptions {
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
  }
}

/** Attach the shadow-root UI to an engine you already own. */
export function mountCommentUI(engine: CommentEngine, options?: CommentUIOptions): CommentUI {
  const resolved = resolveOptions(options)
  const layer = createLayer(resolved)

  const decorations = new Map<string, Decoration>()
  let activeId: string | null = null
  let panelIsOpen = resolved.panel.enabled && resolved.panel.defaultOpen
  let currentSection: PanelSection | null = resolved.panel.sections[0] ?? null
  let renderQueued = false
  let destroyed = false

  const onError = (error: unknown): void => {
    try {
      resolved.onError(error)
    } catch {
      /* an onError that throws must not take the renderer with it */
    }
  }

  const ctx: UIContext = {
    doc: layer.doc,
    win: layer.win,
    root: layer.root,
    layer: layer.layer,
    engine,
    options: resolved,
    labels: resolved.labels,

    decorationOf: (threadId) => decorations.get(threadId) ?? null,
    modeOf: (kind) => engine.modes.find((mode) => mode.kind === kind),
    modeLabel(kind) {
      // A thread whose kind is no longer in `modes` renders with default chrome (§2.11).
      return engine.modes.find((mode) => mode.kind === kind)?.badge?.label ?? kind
    },
    viewOf: (threadId) => engine.getThreadView(threadId),

    activeThread: () => activeId,
    focusThread(threadId) {
      const view = engine.getThreadView(threadId)
      if (!view) return
      activeId = threadId
      // `engine.focus` scrolls, marks active and emits `thread:click`; it returns false for a
      // thread that is not anchored, which is exactly the orphan the panel exists to reach —
      // so the popover still opens, docked at the last known rect.
      engine.focus(threadId)
      render()
    },
    /**
     * The mirror into `engine.active` is one-directional by construction: `engine.active` is a
     * `ReadableStore` and `engine.focus()` is its only public writer, so closing the popover
     * cannot clear it — after a close, `engine.active.get()` still names the thread the engine
     * last focused. That is why §3 points hosts at `engine.threads` / `engine.on(...)` for their
     * own chrome; `engine.active` answers "what did the engine last focus", not "what is open".
     * The engine clears it itself on delete, page change and destroy.
     */
    closeThread(options) {
      if (activeId === null) return
      const badge = badges.elementFor(activeId)
      activeId = null
      render()
      if (options?.restoreFocus === false) return
      if (badge?.isConnected) safeFocus(badge)
    },
    focusFallback: () => panel?.toggle ?? null,

    panelOpen: () => panelIsOpen,
    panelSection: () => currentSection,
    openPanel(section) {
      if (!resolved.panel.enabled) return
      if (section && resolved.panel.sections.includes(section)) currentSection = section
      panelIsOpen = true
      render()
    },
    closePanel() {
      if (!panelIsOpen) return
      panelIsOpen = false
      render()
    },

    badgeFor: (threadId) => badges.elementFor(threadId),
    announce(message) {
      setText(layer.status, message)
    },
    requestRender: schedule,
    onError,
  }

  const badges = createBadgeLayer(ctx)
  const composer = createComposer(ctx)
  const popover = createThreadPopover(ctx)
  const picker = createPicker(ctx)
  const panel = resolved.panel.enabled ? createPanel(ctx) : null

  function render(): void {
    if (destroyed) return
    renderQueued = false
    try {
      const views = engine.threads.get()
      const placement = engine.placement.get()
      badges.sync(views)
      popover.render(views)
      picker.render(placement)
      composer.render(placement)
      panel?.render(views)
    } catch (error) {
      onError(error)
    }
  }

  function schedule(): void {
    if (destroyed || renderQueued) return
    renderQueued = true
    queueMicrotask(() => {
      if (renderQueued) render()
    })
  }

  /**
   * One Esc must do exactly one thing, and three handlers can see the same keystroke:
   * `comment-core`'s capture-phase `window` listener (§4.5, which cancels placement), the
   * composer/popover's own handler, and this layer-level fallback for when a badge or a panel
   * row has focus. Two guards keep them from stacking:
   *
   *  - `defaultPrevented` — the composer and the popover `preventDefault()` when they act, and
   *    their event still bubbles to this layer;
   *  - `placementJustCancelled` — the engine's listener runs **before** this one (capture on
   *    `window`, registered at `start()`) and does not mark the event, so the only trace it
   *    leaves is a synchronous `placement:end`. Clearing the flag on a microtask is exact: a
   *    microtask cannot run in the middle of a synchronous event dispatch.
   */
  let placementJustCancelled = false

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return
    if (engine.placement.get().phase !== 'idle') {
      event.preventDefault()
      engine.placement.cancel('escape')
      return
    }
    if (placementJustCancelled) return
    if (activeId !== null) {
      event.preventDefault()
      ctx.closeThread()
      return
    }
    if (panelIsOpen) {
      event.preventDefault()
      ctx.closePanel()
    }
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
      if (value !== null) activeId = value
      else if (activeId === previous) activeId = null
      schedule()
    }),
    engine.on('thread:click', ({ thread }) => {
      // Fires on every `engine.focus()`, including a re-focus of the already-active thread —
      // `engine.active` would not notify for that, so this is what makes re-open work.
      activeId = thread.id
      schedule()
    }),
    engine.on('thread:delete', ({ thread }) => {
      // §3 decoration lifecycle: a decoration is dropped on its thread's deletion.
      decorations.delete(thread.id)
      if (activeId === thread.id) activeId = null
      schedule()
    }),
    engine.on('placement:end', ({ reason }) => {
      if (reason !== 'cancelled') return
      placementJustCancelled = true
      queueMicrotask(() => {
        placementJustCancelled = false
      })
    }),
    engine.on('page:change', () => {
      // §3 decoration lifecycle: the whole map is cleared on navigation, so a stale chip
      // cannot survive it.
      decorations.clear()
      activeId = null
      schedule()
    }),
  ]

  render()

  const ui: CommentUI = {
    root: layer.root,
    engine,

    panel: {
      open(section) {
        ctx.openPanel(section)
      },
      close() {
        ctx.closePanel()
      },
      toggle() {
        if (panelIsOpen) ctx.closePanel()
        else ctx.openPanel()
      },
      get isOpen() {
        return panelIsOpen
      },
    },

    focus(threadId) {
      ctx.focusThread(threadId)
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
      badges.destroy()
      composer.destroy()
      popover.destroy()
      picker.destroy()
      panel?.destroy()
      decorations.clear()
      layer.destroy()
      if (focused && !focused.isConnected) safeFocus(layer.doc.body)
    },
  }

  return ui
}

/**
 * Zero-config bootstrap for `<script>` tags: builds the engine too. Global: `CommentsUI.mount()`.
 *
 * The two option bags are **nested, not intersected** (§3): `CommentUIOptions['onError']` is
 * `(error: unknown) => void` while `CommentEngineOptions['onError']` is
 * `(error, phase) => void`, and an intersection of those two makes the two-parameter form
 * uncallable — on the one entry point whose whole purpose is being callable with no types.
 */
export function mount(options?: {
  ui?: CommentUIOptions
  engine?: CommentEngineOptions
}): CommentUI & { engine: CommentEngine } {
  const engine = createCommentEngine(options?.engine)
  const ui = mountCommentUI(engine, options?.ui)
  return Object.assign(ui, { engine })
}
