/**
 * The `Intents` implementation (§3.1.3) — every write the UI can perform, and the only channel
 * a presentation has into anything.
 *
 * Contractually, 3 properties hold, and all of them are what make a presentation writable in any
 * framework or language binding:
 *
 *  - **every method returns `void`** (`escape` returns `boolean`);
 *  - **nothing throws, ever** — an intent fired against stale state is a documented no-op, not
 *    an error, so a presentation needs no guards and no `try`/`catch`;
 *  - **no promise ever escapes** — every engine rejection is routed to `CommentUIOptions.onError`
 *    here, so a presentation never handles one.
 *
 * Everything still goes through a `CommentEngine` method. There is no privileged path to the
 * store from this file, and there is none from anywhere above it either.
 */

import type { CommentEngine } from '@astrale-os/comment-core'

import type { Intents, PanelSection } from '../presentation.ts'
import type { ResolvedOptions } from '../types.ts'
import type { FocusPolicy } from './focus.ts'
import type { UISlots } from './model.ts'

export interface IntentDeps {
  readonly engine: CommentEngine
  readonly options: ResolvedOptions
  readonly slots: UISlots
  readonly focus: FocusPolicy
  schedule(): void
  onError(error: unknown): void
  /**
   * The engine's own capture-phase `Escape` listener runs **before** ours and leaves no mark on
   * the event — only a synchronous `placement:end`. Without this, one keystroke would cancel
   * placement *and* close the popover.
   */
  placementJustCancelled(): boolean
  /** Close the popover; `restoreFocus: false` is the delete path, whose badge is about to go. */
  closeThread(restoreFocus: boolean): void
}

export function createIntents(deps: IntentDeps): Intents {
  const { engine, options, slots, focus } = deps
  const fail = (error: unknown): void => {
    deps.onError(error)
  }

  return {
    openThread(threadId) {
      const view = engine.getThreadView(threadId)
      if (!view) return
      slots.activeId = threadId
      // `engine.focus` scrolls, marks active and emits `thread:click`; it returns false for a
      // thread that is not anchored, which is exactly the orphan the panel exists to reach —
      // so the popover still opens, docked at the last known rect.
      engine.focus(threadId)
      deps.schedule()
    },

    closeThread() {
      deps.closeThread(true)
    },

    startReply(threadId) {
      const view = engine.getThreadView(threadId)
      if (!view) return
      // A reply reaches `appendComment` through the same composer, the same draft state machine
      // and the same `placement:*` events as a fresh thread (decision log #21).
      engine.placement.start(view.kind, { threadId })
    },

    resolveThread(threadId) {
      if (!engine.getThreadView(threadId)) return
      engine.resolve(threadId).catch(fail)
    },

    reopenThread(threadId) {
      if (!engine.getThreadView(threadId)) return
      engine.reopen(threadId).catch(fail)
    },

    deleteThread(threadId) {
      if (!engine.getThreadView(threadId)) return
      // Deleting is the one action whose focus cannot go back to the badge: that badge is
      // removed with the thread a tick later and focus would land on `<body>`, dropping the
      // keyboard user out of the widget. The target is chosen before the write and applied
      // after it lands, so it is never a node the delete is about to detach. A presentation
      // must not attempt this dance (§3.1.3).
      const fallback = options.panel.enabled
      if (slots.activeId === threadId) deps.closeThread(false)
      void engine
        .delete(threadId)
        .catch(fail)
        .finally(() => {
          if (fallback) focus.request({ kind: 'panel-toggle' })
        })
    },

    beginEdit(threadId, commentId) {
      if (!engine.getThreadView(threadId)) return
      slots.editing = { threadId, commentId }
      deps.schedule()
    },

    cancelEdit() {
      if (slots.editing === null) return
      slots.editing = null
      deps.schedule()
    },

    commitEdit(threadId, commentId, body) {
      slots.editing = null
      const current = engine
        .getThreadView(threadId)
        ?.comments.find((comment) => comment.id === commentId)
      if (!current || body.trim() === '' || body === current.body) {
        deps.schedule()
        return
      }
      engine
        .editComment({ threadId, id: commentId }, body)
        .catch(fail)
        .finally(() => {
          deps.schedule()
        })
      deps.schedule()
    },

    setDraft(text) {
      if (engine.placement.get().phase !== 'composing') return
      engine.placement.setDraft(text)
    },

    submitDraft() {
      const state = engine.placement.get()
      if (state.phase !== 'composing' || state.draft.trim() === '') return
      // §2.12: on failure the controller returns to `composing` with the draft intact, so the
      // box stays open and the user keeps their text.
      engine.placement.submit(state.draft).catch(fail)
    },

    cancelComposer() {
      engine.placement.cancel('dismiss')
    },

    openPanel(section) {
      if (!options.panel.enabled) return
      if (section && options.panel.sections.includes(section)) slots.section = section
      slots.panelOpen = true
      deps.schedule()
    },

    closePanel() {
      if (!slots.panelOpen) return
      slots.panelOpen = false
      deps.schedule()
    },

    togglePanel() {
      if (slots.panelOpen) this.closePanel()
      else this.openPanel()
    },

    selectSection(section: PanelSection) {
      if (!options.panel.enabled || !options.panel.sections.includes(section)) return
      slots.section = section
      deps.schedule()
    },

    /**
     * One Esc must do exactly one thing, and 3 handlers can see the same keystroke: the
     * engine's capture-phase `window` listener (which cancels placement), the presentation's own
     * dialog handler, and the controller's layer-level fallback for when a badge or a panel row
     * has focus. This method is the single arbiter; a presentation only reports the keystroke.
     */
    escape() {
      if (engine.placement.get().phase !== 'idle') {
        engine.placement.cancel('escape')
        return true
      }
      if (deps.placementJustCancelled()) return false
      if (slots.activeId !== null) {
        deps.closeThread(true)
        return true
      }
      if (slots.panelOpen) {
        slots.panelOpen = false
        deps.schedule()
        return true
      }
      return false
    },

    error(error) {
      deps.onError(error)
    },
  }
}
