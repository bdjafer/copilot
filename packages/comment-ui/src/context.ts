/**
 * The seam every widget is built against. `mount.ts` owns the three pieces of state the §3
 * "pure renderer" clause allows — open panel section, open thread popover, decoration map —
 * and hands the widgets read accessors plus the intents they may fire. Nothing below this
 * file holds state that outlives a render pass, and nothing below it writes to the store.
 */

import type { CommentEngine, Mode, ThreadView } from '@astrale-os/comment-core'

import type { Decoration, Labels, PanelSection, ResolvedOptions } from './types.ts'

export interface UIContext {
  readonly doc: Document
  readonly win: Window
  readonly root: ShadowRoot
  readonly layer: HTMLElement
  readonly engine: CommentEngine
  readonly options: ResolvedOptions
  readonly labels: Labels

  decorationOf(threadId: string): Decoration | null
  modeOf(kind: string): Mode | undefined
  /** The visible name of a thread's mode: `Mode.badge.label`, else the raw `kind`. */
  modeLabel(kind: string): string
  viewOf(threadId: string): ThreadView | null

  /** Which thread popover is open. */
  activeThread(): string | null
  /** Scroll to + open the thread popover (`CommentUI.focus`). */
  focusThread(threadId: string): void
  /**
   * Close it. Focus returns to the invoking badge (§3) unless `restoreFocus: false` — the one
   * caller that opts out is Delete, whose badge is about to be removed with the thread.
   */
  closeThread(options?: { restoreFocus?: boolean }): void
  /**
   * Where focus goes when the element it would return to is being destroyed: the panel toggle,
   * the one control of ours that outlives every thread. `null` when the panel is disabled.
   */
  focusFallback(): HTMLElement | null

  panelOpen(): boolean
  /** The section `panel.open(section)` last selected — the one the panel scrolls to. */
  panelSection(): PanelSection | null
  openPanel(section?: PanelSection): void
  closePanel(): void

  /** The badge button for a thread, when one is rendered. Popovers anchor to it. */
  badgeFor(threadId: string): HTMLElement | null
  /** Announce into the visually-hidden `role="status"` region. */
  announce(message: string): void
  /** Coalesced re-render. */
  requestRender(): void
  onError(error: unknown): void
}

/** `aria-label` for a thread's badge and popover: mode name + comment count, no prose. */
export function threadLabel(ctx: UIContext, view: ThreadView): string {
  return `${ctx.modeLabel(view.kind)} (${String(view.comments.length)})`
}

/** §3: "approximately re-anchored" marker when the winning confidence is below 0.85. */
export const APPROXIMATE_BELOW = 0.85

export function isApproximate(view: ThreadView): boolean {
  return view.anchoring.status === 'anchored' && view.anchoring.confidence < APPROXIMATE_BELOW
}
