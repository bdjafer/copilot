/**
 * Public types — SPEC-comment-core §3 verbatim, plus the internal resolved-option shape the
 * renderer actually reads.
 *
 * `comment-ui` is a **pure renderer** (§3): its only state is which panel section is open,
 * which thread popover is open (mirrored from `engine.active`), and the host-supplied
 * `decorate()` map. Everything else is read from `engine.threads`, `engine.placement` and
 * `engine.modes`, and every write goes through a `CommentEngine` method — there is no
 * privileged path to the store.
 */

import type { CommentEngine } from '@astrale-os/comment-core'

/* -------------------------------------------------------------------------------- §3 types */

export type PanelSection = 'open' | 'resolved' | 'unanchored'

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

/** i18n — every user-visible string lives here. */
export interface Labels {
  send: string
  dismiss: string
  reply: string
  resolve: string
  reopen: string
  delete: string
  edit: string
  placeholder: string
  panelTitle: string
  sectionOpen: string
  sectionResolved: string
  sectionUnanchored: string
  emptyOpen: string
  emptyResolved: string
  emptyUnanchored: string
  approximate: string
  pickHint: string
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
    /** default all three */
    sections?: readonly PanelSection[]
  }
  badge?: {
    /** default false (Figma/Docs behavior) */
    showResolved?: boolean
    /** default 'dock' */
    orphaned?: 'dock' | 'panel-only' | 'hidden'
    /** default [6, -6] — `[crossAxis, mainAxis]` in CSS px, fed to `@floating-ui/dom` offset. */
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
}
