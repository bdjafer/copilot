/**
 * `comment-ui/presentation` — the seam (SPEC §3.1). **This module imports nothing**, and it
 * must stay that way: the whole point of the split is that a presentation can see these types
 * and nothing else, so it cannot reach the engine, the domain types or the positioning layer.
 * A CI test greps this file for `import` and greps its emitted `.d.ts` for the same.
 *
 * It may name `lib.dom` globals (`ShadowRoot`, `HTMLElement`, `Document`, `Window`) — this is a
 * DOM renderer and pretending otherwise buys nothing.
 *
 * Two objects cross the seam:
 *
 *  - `UIViewModel` — frozen, structured-cloneable, referentially stable, ordered, total and
 *    pre-resolved. A presentation that draws it and nothing else is a complete UI.
 *  - `Intents` — every write the UI can perform. Every method returns `void` (except `escape`),
 *    never throws, and is a documented no-op against stale state, so a presentation needs no
 *    promise handling and no `try`/`catch`.
 */

/* ------------------------------------------------------------------ shared vocabulary */

export type PanelSection = 'open' | 'resolved' | 'unanchored'
export type AnchorState = 'pending' | 'anchored' | 'orphaned'
export type ChipTone = 'neutral' | 'info' | 'busy' | 'warn' | 'danger'

/** i18n — every user-visible string lives here. Locked 17-key interface. */
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

/** Viewport-space rect. A plain object, never a `DOMRect` — the model is cloneable. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface ChipVM {
  readonly text: string
  readonly tone: ChipTone
  readonly spinner: boolean
}

/* --------------------------------------------------------------------- the view model */

export interface BadgeVM {
  readonly threadId: string
  readonly kind: string
  /** `Mode.badge.label`, else the raw kind. Already resolved — the presentation never sees a mode. */
  readonly label: string
  /** `Mode.badge.icon` when the host supplied one, else `null`: draw your own glyph. */
  readonly icon: string | null
  readonly count: number
  readonly anchor: AnchorState
  readonly resolved: boolean
  readonly orphaned: boolean
  readonly approximate: boolean
  /** Positioned from the capture's rect, not from a live element. */
  readonly docked: boolean
  /** The off-screen skip decided this badge is not visible. */
  readonly offscreen: boolean
  readonly open: boolean
  readonly tone: 'default' | 'muted' | 'accent'
  readonly title: string | null
  readonly ariaLabel: string
  readonly chip: ChipVM | null
  /** Last known viewport rect of the *reference*. For non-DOM presentations and for FLIP. */
  readonly rect: Rect | null
  /** The resolved placement of the last positioning pass, so a morph can grow out of its anchor. */
  readonly placement: string | null
}

export interface CommentVM {
  readonly id: string
  readonly author: 'user' | 'copilot'
  readonly body: string
  readonly createdAt: string
  readonly editedAt: string | null
  readonly editing: boolean
}

export interface ThreadVM {
  readonly threadId: string
  readonly kind: string
  readonly label: string
  readonly ariaLabel: string
  readonly status: string
  readonly anchor: AnchorState
  readonly resolved: boolean
  readonly orphaned: boolean
  readonly approximate: boolean
  readonly title: string | null
  /** The capture's text, first 160 chars, for orphans only. Else `null`. */
  readonly quote: string | null
  readonly chip: ChipVM | null
  readonly comments: readonly CommentVM[]
  readonly actions: {
    readonly reply: boolean
    readonly resolve: boolean
    readonly reopen: boolean
    readonly delete: boolean
  }
}

export interface ComposerVM {
  readonly kind: string
  readonly draft: string
  /** The write is in flight. */
  readonly busy: boolean
  readonly replyTo: string | null
  readonly canSubmit: boolean
  readonly placeholder: string
}

export interface PickerVM {
  readonly kind: string
  readonly rect: Rect | null
  readonly hint: string
}

export interface PanelRowVM {
  readonly threadId: string
  readonly kind: string
  readonly label: string
  readonly ariaLabel: string
  readonly body: string
  readonly count: number
  readonly anchor: AnchorState
  readonly approximate: boolean
  readonly status: string
  readonly title: string
  readonly chip: ChipVM | null
  readonly action: 'reopen' | 'delete' | null
}

export interface PanelSectionVM {
  readonly id: PanelSection
  readonly label: string
  readonly empty: string
  readonly current: boolean
  readonly rows: readonly PanelRowVM[]
}

export interface PanelVM {
  readonly open: boolean
  readonly title: string
  readonly corner: 'br' | 'bl' | 'tr' | 'tl'
  readonly total: number
  readonly sections: readonly PanelSectionVM[]
}

export type FocusTarget =
  | { readonly kind: 'composer-input' }
  | { readonly kind: 'thread-close' }
  | { readonly kind: 'badge'; readonly threadId: string }
  | { readonly kind: 'panel-toggle' }

export interface UIViewModel {
  /** Monotonic. Increments on every published model, never resets. */
  readonly seq: number
  readonly labels: Labels
  /**
   * `engine.modes`' kinds, in declaration order — the ordering, and nothing else about a `Mode`.
   * A presentation has no mode list, so a kind's *index* is the one fact about modes it cannot
   * re-derive, and a per-mode hue is exactly that fact (decision log #41, DESIGN §2.3). The
   * offset table stays in the presentation, where a second appearance is free to disagree.
   */
  readonly kinds: readonly string[]
  readonly badges: readonly BadgeVM[]
  readonly thread: ThreadVM | null
  readonly composer: ComposerVM | null
  readonly picker: PickerVM | null
  /** `null` when the panel is disabled. */
  readonly panel: PanelVM | null
  /** What the controller wants announced; `''` clears the region. */
  readonly announce: string
  /** Apply when `focus.seq` changes; idempotent. `null` means "nothing to do". */
  readonly focus: { readonly seq: number; readonly target: FocusTarget } | null
}

/* -------------------------------------------------------------------------- the writes */

export interface Intents {
  openThread(threadId: string): void
  closeThread(): void
  startReply(threadId: string): void
  resolveThread(threadId: string): void
  reopenThread(threadId: string): void
  deleteThread(threadId: string): void

  beginEdit(threadId: string, commentId: string): void
  cancelEdit(): void
  commitEdit(threadId: string, commentId: string, body: string): void

  setDraft(text: string): void
  submitDraft(): void
  cancelComposer(): void

  openPanel(section?: PanelSection): void
  closePanel(): void
  togglePanel(): void
  selectSection(section: PanelSection): void

  /** The Esc chain, in one call. Returns true when the controller consumed it. */
  escape(): boolean
  /** Route a presentation-side fault into `CommentUIOptions.onError`. */
  error(error: unknown): void
}

/* -------------------------------------------------------------------- the presentation */

export interface PresentationHost {
  readonly root: ShadowRoot
  /** The `pointer-events: none` container. Append here; nothing else is yours. */
  readonly layer: HTMLElement
  readonly doc: Document
  readonly win: Window
  /**
   * Register the node the controller should position for a surface key, or `null` to clear.
   * Keys: `badge:<threadId>` | `thread` | `composer` | `panel` | `panel-toggle`.
   * A presentation that does not want engine positioning simply never calls this and uses
   * `BadgeVM.rect` / `PickerVM.rect` instead.
   */
  anchor(key: string, node: HTMLElement | null): void
  /** Write into the controller's visually-hidden `role="status"` region. */
  announce(message: string): void
}

export interface PresentationInstance {
  /** Called once per coalesced render, with a frozen model. Never called after `destroy()`. */
  update(vm: UIViewModel): void
  destroy(): void
}

export interface Presentation {
  /** Stable identity, for diagnostics and conformance reporting. */
  readonly name: string
  /** Injected into the shadow root before `create()`, after the base vars and before `options.css`. */
  readonly css?: string
  create(host: PresentationHost, intents: Intents): PresentationInstance
}
