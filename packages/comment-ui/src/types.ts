/**
 * Public types — SPEC-comment-core §3 verbatim, plus the internal resolved-option shape the
 * controller actually reads.
 *
 * `Labels` and `PanelSection` now live in `./presentation.ts` (decision log #37) and are
 * re-exported from here and from the barrel unchanged: the view model carries resolved labels,
 * so the types module needs the interface, and duplicating a locked 17-key interface is how the
 * two copies drift.
 *
 * The §3 "pure renderer" clause is now the **controller's** obligation (§3.1): its only state is
 * which panel section is open, which thread popover is open (mirrored from `engine.active`), the
 * host-supplied `decorate()` map, the comment being edited inline, and the element focus returns
 * to on close. Everything else is read from `engine.threads`, `engine.placement` and
 * `engine.modes`, and every write goes through a `CommentEngine` method — there is no privileged
 * path to the store.
 */

import type { CommentEngine, ReadableStore } from '@astrale-os/comment-core'

import type { Intents, Labels, PanelSection, Presentation, UIViewModel } from './presentation.ts'

export type { Labels, PanelSection }

/* -------------------------------------------------------------------------------- §3 types */

export interface Decoration {
  chip?: {
    text: string
    tone?: 'neutral' | 'info' | 'busy' | 'warn' | 'danger'
    spinner?: boolean
  } | null
  tone?: 'default' | 'muted' | 'accent'
  /** title attribute on the badge. */
  title?: string
}

export interface CommentUIOptions {
  /** Default: document.documentElement. */
  container?: HTMLElement
  /** Raw CSS appended inside the shadow root, after the built-in sheet. */
  css?: string
  /** i18n — every user-visible string lives here. */
  labels?: Partial<Labels>
  panel?: {
    /** default true */
    enabled?: boolean
    /** default 'br' */
    corner?: 'br' | 'bl' | 'tr' | 'tl'
    /** default false */
    defaultOpen?: boolean
    /** default: every section */
    sections?: readonly PanelSection[]
  }
  badge?: {
    /** default false (Figma/Docs behavior) */
    showResolved?: boolean
    /** default 'dock' */
    orphaned?: 'dock' | 'panel-only' | 'hidden'
    /** default [6, -6] — `[crossAxis, mainAxis]` in CSS px, fed to the positioner's offset. */
    offset?: [number, number]
    /** default true (IntersectionObserver) */
    hideOffscreen?: boolean
  }
  /** default true (stopPropagation at the shadow boundary; WXT isolateEvents equivalent). */
  isolateEvents?: boolean
  /** default 2147483000. The composer uses the top layer regardless. */
  zIndex?: number
  /** default '16px'. The documented WXT `all: initial` caveat — no rem-dependent styling. */
  rootFontSize?: string
  onError?: (error: unknown) => void
  /**
   * The presentation adapter (§3.1). Default `domPresentation()`. `null` mounts the controller
   * with **no** presentation — the shadow root, the layer and the `role="status"` region still
   * exist, and `vm` / `intents` still work. This is the one new field on this interface.
   */
  presentation?: Presentation | null
}

export interface CommentUI {
  /** Open shadow root, for debuggability. */
  readonly root: ShadowRoot
  readonly engine: CommentEngine
  readonly panel: {
    open(section?: PanelSection): void
    close(): void
    toggle(): void
    readonly isOpen: boolean
  }
  /** Scroll to + open the thread popover. Delegates to engine.focus(). */
  focus(threadId: string): void
  /**
   * Host-driven badge chrome — pass null to clear.
   *
   * Lifecycle (§3): dropped automatically on that thread's `thread:delete` and on
   * `page:change` (the whole map is cleared). Otherwise sticky, no TTL.
   */
  decorate(threadId: string, decoration: Decoration | null): void
  unmount(): void
}

/** The headless seam (§3.1). `mountCommentUI` is this, with a narrower return type. */
export interface CommentUIController extends CommentUI {
  /** The frozen, structured-cloneable view model. Notifies once per coalesced render. */
  readonly vm: ReadableStore<UIViewModel>
  /** Every write the UI can perform. All methods return `void` and never throw. */
  readonly intents: Intents
}

/* ------------------------------------------------------------------------------- internals */

export interface ResolvedPanelOptions {
  enabled: boolean
  corner: 'br' | 'bl' | 'tr' | 'tl'
  defaultOpen: boolean
  sections: readonly PanelSection[]
}

export interface ResolvedBadgeOptions {
  showResolved: boolean
  orphaned: 'dock' | 'panel-only' | 'hidden'
  offset: readonly [number, number]
  hideOffscreen: boolean
}

export interface ResolvedOptions {
  container: HTMLElement
  css: string
  labels: Labels
  panel: ResolvedPanelOptions
  badge: ResolvedBadgeOptions
  isolateEvents: boolean
  zIndex: number
  rootFontSize: string
  onError: (error: unknown) => void
  presentation: Presentation | null
}
