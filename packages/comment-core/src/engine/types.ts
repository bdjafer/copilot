/**
 * DOM-dependent engine, view, placement and event types (§2.3, §2.11, §2.12, §2.13, §2.15).
 *
 * Same rule as `anchor/types.ts`: everything here names `Element`, `Range`, `Document` or
 * `Selection`, so it must not be reachable from `src/types.ts` (the type half of
 * `comment-core/headless`, §1.1). `StoreEventMap` and every DOM-free option type stay there.
 */

import type { AnchorExplanation, CaptureOptions, ResolveOptions } from '../anchor/types.ts'
import type { CommentError } from '../errors.ts'
import type {
  AnchorStatus,
  Author,
  Comment,
  CommentDomain,
  CommentStore,
  DocumentRect,
  ElementCapture,
  ErrorPhase,
  EventEnvelope,
  MatchVia,
  PageKeyFn,
  ReadableStore,
  StoreEventMap,
  Thread,
  ThreadFilter,
  Unsubscribe,
  WriteResult,
} from '../types.ts'

/* -------------------------------------------------------------------------------------- §2.3 */

export interface Anchoring {
  readonly status: AnchorStatus
  /** The live element, or null while pending/orphaned. */
  readonly element: Element | null
  /** Non-null only when anchor.mode === 'text' and the quote re-anchored. */
  readonly range: Range | null
  /** 0..1. UI flags "approximately re-anchored" when < 0.85 and >= threshold. */
  readonly confidence: number
  /** Which signal won, or null when not anchored. */
  readonly via: MatchVia | null
  /** Last known document-space rect. Retained while orphaned so the badge can dock. */
  readonly rect: DocumentRect | null
}

/**
 * A Thread plus its live derivations. Structural superset of Thread, so
 * `listThreads(): ThreadView[]` still satisfies PLAN §3.7's `Thread[]`.
 */
export interface ThreadView extends Thread {
  /** Never empty: a thread with zero comments is skipped from the view entirely (§4.1 rule 2). */
  readonly comments: readonly Comment[]
  readonly anchoring: Anchoring
  /** anchoring.status === 'orphaned' */
  readonly isOrphaned: boolean
  /** status === 'resolved' */
  readonly isResolved: boolean
  /** Newest comment. Non-nullable by invariant (rules 2 and 7). */
  readonly lastComment: Comment
  /** `max(comment.createdAt, comment.editedAt)` — derived, never persisted. */
  readonly lastActivityAt: string
}

/**
 * Engine-only filter. `anchor` is a live derivation, so it exists only where a DOM does —
 * rather than sitting on `ThreadFilter` as a field one of the two implementations silently
 * ignores.
 */
export interface EngineThreadFilter extends ThreadFilter {
  anchor?: AnchorStatus
}

/* ------------------------------------------------------------------------------ §2.11 modes */

export interface TriggerSpec {
  /** Single character, matched case-insensitively against KeyboardEvent.key. */
  key: string
  modifiers?: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }
  /**
   * 'pick'  — enter placement mode: highlight under cursor, click to place, Esc cancels.
   * 'hover' — place immediately on the last-hovered element.
   * Default 'pick'.
   */
  interaction?: 'pick' | 'hover'
}

export interface Mode {
  /** Stamped verbatim onto `Thread.kind`. The engine attaches zero behavior to it. */
  kind: string
  /** false ⇒ no built-in trigger; the host calls startPlacement(kind). */
  trigger?: TriggerSpec | false
  /** Passed through to comment-ui for badge decoration. Ignored by the engine. */
  badge?: { icon?: string; label?: string }
}

export interface AnchoringOptions extends Omit<ResolveOptions, 'root' | 'document'> {
  /** Shared MutationObserver. Default true. */
  observe?: boolean
  /** Batch coalescing window, idle-scheduled. Default 100. */
  batchMs?: number
  /** Full-document retry for orphans when idle. Default true. */
  rescanIdle?: boolean
}

/* -------------------------------------------------------------------------------- §2.12 */

export type PlacementTarget =
  | { element: Element }
  | { selection: Selection | Range }
  /** Reply composer. Kind is inherited from the thread. */
  | { threadId: string }
  /** Current selection if non-collapsed, else last hovered element. */
  | { auto: true }

export type PlacementState =
  | { phase: 'idle' }
  | {
      phase: 'picking'
      kind: string
      interaction: 'pick' | 'hover'
      /** Element under the cursor right now; the UI draws the highlight from this. */
      candidate: Element | null
    }
  | {
      phase: 'composing'
      kind: string
      mode: 'element' | 'text'
      element: Element
      range: Range | null
      draft: string
      capture: ElementCapture
      /** Non-null ⇒ reply composer for that thread. */
      replyTo: string | null
    }
  | {
      phase: 'submitting'
      kind: string
      mode: 'element' | 'text'
      element: Element
      draft: string
      replyTo: string | null
    }

export interface PlacementController extends ReadableStore<PlacementState> {
  /**
   * No target ⇒ enter 'picking' per the mode's interaction (unless a non-collapsed selection
   * exists, which wins and goes straight to 'composing' in text mode).
   * With a target ⇒ go straight to 'composing'.
   * Returns false when the kind is unknown or no target could be derived.
   */
  start(kind?: string, target?: PlacementTarget): boolean
  setDraft(body: string): void
  /** Persists. Resolves with the domain result (discriminated on `kind`). Empty body rejects. */
  submit(body?: string): Promise<WriteResult>
  /** Safe from any phase. No-op when idle. */
  cancel(reason?: string): void
}

/* -------------------------------------------------------------------------------- §2.13 */

/** The engine-only half: live derivations, DOM values, and UI-flow events. */
export interface EngineOnlyEventMap {
  'thread:anchored': {
    thread: Thread
    view: ThreadView
    element: Element
    confidence: number
    via: MatchVia
    previous: AnchorStatus
  }
  'thread:orphaned': { thread: Thread; view: ThreadView; lastRect: DocumentRect | null }
  'thread:click': { thread: Thread; view: ThreadView; element: Element | null }

  'placement:start': { kind: string; interaction: 'pick' | 'hover' | 'direct' }
  'placement:end': { kind: string; reason: 'placed' | 'cancelled'; threadId: string | null }
  /** A user-flow rejection, NOT a fault. See §2.12. */
  'placement:rejected': { kind: string; reason: 'busy' | 'no_target' | 'unknown_kind' }

  'page:change': { pageKey: string; previous: string | null; url: string }
  error: { error: CommentError; phase: ErrorPhase; threadId?: string }
}

export interface CommentEventMap extends StoreEventMap, EngineOnlyEventMap {}

export type CommentEventName = keyof CommentEventMap

export type CommentEvent = EventEnvelope<CommentEventMap>

/* -------------------------------------------------------------------------------- §2.15 */

export interface EngineInspection {
  version: string
  pageKey: string
  modes: readonly Mode[]
  /** `reads`/`writes` are counted BY THE ENGINE (calls it made through the port). */
  store: { name: string; reads?: number; writes?: number; lastError: string | null }
  threads: Array<{
    id: string
    kind: string
    status: Thread['status']
    comments: number
    anchor: AnchorStatus
    confidence: number
    via: MatchVia | null
  }>
  anchoring: { observing: boolean; batches: number; lastBatchMs: number; pending: number }
  listeners: Record<CommentEventName | '*', number>
  strategies: Array<{ type: string; weight: number; hits: number; misses: number; avgMs: number }>
}

/* -------------------------------------------------------------------------------- §2.11 */

export interface CommentEngineOptions<S extends CommentStore = CommentStore> {
  /** Default: createLocalStorageStore(). */
  store?: S
  /** Default: defaultPageKey. */
  pageKey?: string | PageKeyFn
  /** Default: [{ kind: 'comment', trigger: { key: 'c', interaction: 'pick' } }]. */
  modes?: readonly Mode[]
  anchoring?: AnchoringOptions
  /** Capture-side options. `document` is supplied by the engine and cannot be overridden. */
  capture?: Omit<CaptureOptions, 'document' | 'strategies'>
  /** Default: { watch: true } — see §4.6.6: patching history is NOT part of this contract. */
  navigation?: { watch?: boolean; source?: 'auto' | ((cb: () => void) => Unsubscribe) } | false
  /** Default true. When false, call start() yourself. */
  autoStart?: boolean
  /** Receives every `error` event, including ones thrown by `error` listeners. */
  onError?: (error: CommentError, phase: ErrorPhase) => void
  /**
   * Test/SSR seam. Default: `globalThis.document`, read at `start()`. `start()` with no usable
   * `document` throws `CommentError('no_document')` synchronously.
   */
  document?: Document
  now?: () => Date
  createId?: () => string
  reopensOnReply?: (author: Author) => boolean
}

export interface CommentEngine<S extends CommentStore = CommentStore> extends CommentDomain {
  readonly store: S
  /** Current page key. Updates on SPA navigation. */
  readonly pageKey: string
  readonly page: ReadableStore<{ key: string; url: string }>
  readonly modes: readonly Mode[]
  readonly status: ReadableStore<'idle' | 'loading' | 'ready' | 'destroyed'>
  /** Live, sorted by createdAt ascending. Frozen array of frozen views. */
  readonly threads: ReadableStore<readonly ThreadView[]>
  /** The thread whose popover the UI currently shows, or null. */
  readonly active: ReadableStore<string | null>
  readonly placement: PlacementController

  /* --- synchronous reads over the live view; never hit the store --- */
  listThreads(filter?: EngineThreadFilter): ThreadView[]
  getThreadView(id: string): ThreadView | null
  /** Resolves after the first store load + first anchoring pass. */
  ready(): Promise<void>

  /* --- placement --- */
  /** Locked alias for `placement.start(kind)`. Returns false when the kind is unknown. */
  startPlacement(kind?: string): boolean
  /** Re-configure trigger modes at runtime. Throws `invalid_options` on a duplicate binding. */
  setModes(modes: readonly Mode[]): void

  /* --- anchoring control --- */
  /** Force a resolution pass. Omit id for all threads on the page. */
  reanchor(threadId?: string): Promise<void>
  /** Scroll to + mark active + emit `thread:click`. False when unknown or not anchored. */
  focus(threadId: string, options?: { scroll?: boolean | ScrollIntoViewOptions }): boolean
  /** Per-selector trace. Cached by default; `{ fresh: true }` re-runs resolution now. */
  explain(threadId: string, options?: { fresh?: boolean }): AnchorExplanation | null

  /* --- events --- */
  on<E extends CommentEventName>(
    event: E,
    listener: (payload: CommentEventMap[E]) => void,
    options?: { once?: boolean; signal?: AbortSignal },
  ): Unsubscribe
  once<E extends CommentEventName>(
    event: E,
    listener: (payload: CommentEventMap[E]) => void,
  ): Unsubscribe
  off<E extends CommentEventName>(event: E, listener: (payload: CommentEventMap[E]) => void): void
  /** The `*` firehose. Receives each event AFTER its typed listeners. */
  subscribe(listener: (event: CommentEvent) => void): Unsubscribe

  start(): void
  stop(): void
  destroy(): void
  /** Serializable snapshot for devtools / the options page. */
  inspect(): EngineInspection
}
