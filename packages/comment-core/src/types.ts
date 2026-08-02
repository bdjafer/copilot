/**
 * DOM-free type surface (SPEC-comment-core §2).
 *
 * Everything in this file must typecheck under `lib: ["ES2022", "WebWorker"]`: it is the type
 * half of `comment-core/headless`, whose emitted declarations must reference no `lib.dom`
 * identifier (§1.1). Types that genuinely need a DOM — `Anchoring`, `ThreadView`,
 * `AnchorMatch`, `SelectorStrategy`, the engine/placement surface and `EngineOnlyEventMap` —
 * live with the DOM half.
 *
 * Zero logic, one constant.
 */

import type { CommentError } from './errors.ts'

/* -------------------------------------------------------------------------------------- §2.1 */

/** Cancels a subscription. Idempotent: calling it twice is a no-op. */
export type Unsubscribe = () => void

/** The one reactive primitive in this codebase. Everything observable is one of these. */
export interface ReadableStore<T> {
  /** Current value. Never throws. Always returns the value the last listener call observed. */
  get(): T
  /** Subscribe to changes. Does NOT fire on subscribe. Returns an unsubscriber. */
  subscribe(listener: (value: T, previous: T) => void): Unsubscribe
}

/* -------------------------------------------------------------------------------------- §2.2 */

/** Who wrote a comment. Locked union — no extension point, no module augmentation. */
export type Author = 'user' | 'copilot'

export interface Thread {
  id: string
  v: 1
  pageKey: string
  /** Consumer-defined mode discriminator ('comment', 'ask', …). Opaque to comment-core. */
  kind: string
  anchor: AnchorDescriptor
  capture: ElementCapture
  status: 'open' | 'resolved'
  resolvedAt: string | null
  resolvedBy: Author | null
  createdAt: string
  updatedAt: string
}

export interface Comment {
  id: string
  threadId: string
  author: Author
  body: string
  createdAt: string
  editedAt: string | null
}

/** A thread plus its comments, comments sorted by createdAt ascending. */
export interface ThreadRecord {
  thread: Thread
  comments: Comment[]
}

/** Record format version stamped on every written Thread. */
export const THREAD_VERSION = 1 as const

/* -------------------------------------------------------------------------------------- §2.3 */

/** Live anchoring condition. Derived at render time, never written to the store. */
export type AnchorStatus = 'pending' | 'anchored' | 'orphaned'

/**
 * Document-space rect: viewport rect + current scroll offsets, so it stays meaningful after
 * the page scrolls. NOT a DOMRect — `getBoundingClientRect()` is viewport-relative and would
 * dock an orphaned badge in the wrong place after any scroll. DOM-free type, on purpose.
 */
export interface DocumentRect {
  /** All values are document-space CSS pixels. */
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

/* -------------------------------------------------------------------------------------- §2.4 */

export interface AnchorDescriptor {
  mode: 'element' | 'text'
  /** Ordered cheap → fuzzy. Produced by captureTarget(); never hand-built. */
  selectors: Selector[]
  fingerprint: ElementFingerprint
}

export type BuiltinSelector =
  | { type: 'css'; value: string }
  | { type: 'attr'; tag: string; attrs: Record<string, string> }
  | { type: 'nthPath'; value: string }
  | { type: 'textQuote'; exact: string; prefix: string; suffix: string }
  | { type: 'textPosition'; start: number; end: number }

/** Custom-strategy selectors. The `x-` prefix keeps builtin switches exhaustive. */
export interface CustomSelector {
  type: `x-${string}`
  [key: string]: unknown
}

export type Selector = BuiltinSelector | CustomSelector

export type MatchVia = Selector['type'] | 'fingerprint-scan'

export interface ElementFingerprint {
  tag: string
  id?: string
  stableClasses: string[]
  attrs: Record<string, string>
  textDigest: string
  rectHint?: { w: number; h: number }
}

export interface ElementCapture {
  outerHTML: string
  text: string
  selectionText?: string
  cssPath: string
  page: { url: string; title: string }
  capturedAt: string
}

/* -------------------------------------------------------------------------------------- §2.6 */

export type PageKeyFn = (url: URL) => string

export interface PageKeyOptions {
  /** Extra params to drop, merged with volatileParams. */
  dropParams?: readonly (string | RegExp)[]
  /** Params kept even if a drop rule matches. Wins over drops. */
  keepParams?: readonly string[]
  /** Default false. */
  keepHash?: boolean
  /** Default 'strip'. */
  trailingSlash?: 'keep' | 'strip'
}

/* -------------------------------------------------------------------------------------- §2.7 */

/**
 * What a store can actually hand back: `v` is whatever is on disk, including versions this
 * build does not know. The domain narrows StoredThread → Thread (§4.1 rule 16).
 */
export type StoredThread = Omit<Thread, 'v'> & { v: number }

export interface CommentStore {
  getThread(id: string): Promise<StoredThread | null>
  listThreads(pageKey: string): Promise<StoredThread[]>
  listAllThreads(): Promise<StoredThread[]>
  putThread(t: Thread): Promise<void>
  deleteThread(id: string): Promise<void> // cascades comments
  listComments(threadId: string): Promise<Comment[]>
  putComment(c: Comment): Promise<void>
  deleteComment(id: string): Promise<void>
  subscribe(pageKey: string | null, cb: () => void): () => void

  /* --- optional; every one has a documented fallback --- */
  /** Human-readable name for inspect(). Default: 'anonymous'. */
  readonly name?: string
  /** O(1) comment lookup. Fallback: listComments over the owning thread found by scan. */
  getComment?(id: string): Promise<Comment | null>
  /**
   * Atomic multi-write. When present, createThread/deleteThread/last-comment-GC run inside it
   * and fire `subscribe` once. When absent, see §4.3 crash-safety ordering.
   */
  transaction?<T>(fn: (tx: CommentStore) => Promise<T>): Promise<T>
}

/* -------------------------------------------------------------------------------------- §2.8 */

/**
 * Storage-agnostic key/value seam. This is the ONLY thing standing between comment-core and
 * extension storage / Dexie / a server. `comment-core` never names a platform.
 */
export interface KeyValueAdapter {
  get(keys: readonly string[]): Promise<Record<string, unknown>>
  set(entries: Record<string, unknown>): Promise<void>
  remove(keys: readonly string[]): Promise<void>
  /** All keys with this prefix. **Must be key-only (normative).** */
  keys(prefix: string): Promise<string[]>
  /** Absent ⇒ single-context store, no cross-tab reactivity (local notify still works). */
  watch?(cb: (changedKeys: string[]) => void): Unsubscribe
}

/* -------------------------------------------------------------------------------------- §2.9 */

export interface CreateThreadInput {
  pageKey: string
  /** Consumer-defined mode discriminator. Required — there is no default kind. */
  kind: string
  anchor: AnchorDescriptor
  capture: ElementCapture
  /** Comment author. Required — the trigger-loop guard must not be forgettable (PLAN §8). */
  author: Author
  body: string
  /** Caller-supplied thread id ⇒ idempotent create. */
  id?: string
  /** Caller-supplied first-comment id ⇒ idempotent create. */
  commentId?: string
}

export interface AppendCommentInput {
  /** Required. No default. */
  author: Author
  body: string
  /** Caller-supplied id ⇒ idempotent append across service-worker restarts. */
  id?: string
}

/**
 * Both write paths return the SAME shape, discriminated on `kind`, so a caller never
 * feature-detects (`'reopened' in r`).
 */
export interface CreateResult {
  kind: 'created'
  thread: Thread
  comment: Comment
  /** Always false on create; present so `WriteResult` is uniform. */
  reopened: false
  /** True iff `input.id` / `input.commentId` already existed ⇒ no write performed. */
  deduped: boolean
}

export interface AppendResult {
  kind: 'replied'
  /** Post-transition thread (already reopened when applicable). */
  thread: Thread
  comment: Comment
  /** True iff the §3.5 auto-reopen rule fired. */
  reopened: boolean
  /** True iff `input.id` already existed ⇒ no write performed, existing comment returned. */
  deduped: boolean
}

export type WriteResult = CreateResult | AppendResult

export interface DeleteCommentResult {
  comment: Comment
  /** True when this was the last comment and the thread was auto-GC'd. */
  threadDeleted: boolean
  /** Post-state thread, or null when threadDeleted. */
  thread: Thread | null
}

/** A bare id costs an O(n) store scan; the tuple form is O(1). Both are accepted everywhere. */
export type CommentRef = string | { threadId: string; id: string }

export interface ThreadFilter {
  /**
   * `undefined` = the implementation's default scope; `null` = explicitly all pages.
   * `createDomain` (no DOM, no current page) defaults to ALL pages;
   * `CommentEngine` defaults to the engine's CURRENT `pageKey`.
   */
  pageKey?: string | null
  kind?: string | readonly string[]
  status?: 'open' | 'resolved'
  /** Threads having ≥1 comment by this author. */
  author?: Author
  /** ISO string; thread.createdAt >= since. */
  since?: string
}

export interface DomainOptions {
  now?: () => Date
  /** Default: nanoid(12). */
  createId?: () => string
  /**
   * Does a reply by this author reopen a resolved thread? Default: `(a) => a === 'user'`,
   * which is §4.1 rules 3/4 verbatim.
   */
  reopensOnReply?: (author: Author) => boolean
  /**
   * Receives every domain-level fault the caller cannot see, because a domain call cannot
   * reject for a record it never returned: `unsupported_version` (§4.1 rule 16) and read-time
   * GC failures. Required for `domainConformance()` to be able to assert rule 16 at all.
   */
  onError?: (error: CommentError) => void
}

export interface CommentDomain {
  /** Creates thread + first comment atomically. Empty body rejects before any write. */
  createThread(input: CreateThreadInput): Promise<CreateResult>
  /** Applies the §3.5 author-aware auto-reopen rule. Idempotent when `input.id` is reused. */
  appendComment(threadId: string, input: AppendCommentInput): Promise<AppendResult>
  /** In-place edit; stamps editedAt. Empty body rejects. */
  editComment(ref: CommentRef, body: string): Promise<Comment>
  /** Hard delete. Deleting the last comment cascades to deleting the thread. */
  deleteComment(ref: CommentRef): Promise<DeleteCommentResult>
  /** open → resolved. resolvedBy is always 'user' — the copilot may suggest, never execute. */
  resolve(threadId: string): Promise<Thread>
  /** resolved → open, clearing resolvedAt/resolvedBy together. */
  reopen(threadId: string): Promise<Thread>
  /** Hard delete, cascading comments. Hosts cancel in-flight work off `thread:delete`. */
  delete(threadId: string): Promise<void>
  /** Thread + comments, or null. */
  get(threadId: string): Promise<ThreadRecord | null>
  /** Filtered records, sorted by thread.createdAt ascending. */
  list(filter?: ThreadFilter): Promise<ThreadRecord[]>
}

/* ------------------------------------------------------------------------------------- §2.10 */

export interface ObserveOptions {
  /** null = all pages (default). */
  pageKey?: string | null
  /** Emit `thread:create` for records that already existed at subscribe time. Default false. */
  replay?: boolean
  /** Durable cursor. **Required in a service worker; without it `observeStore` cannot work.** */
  cursor?: ObserveCursor
}

/**
 * Where the last-seen position is persisted. `createKeyValueCursor(kv, { namespace })` is
 * shipped; it stores one record under `{ns}:cursor:{id}`. In-memory (the default) is correct
 * only for a context that outlives every write it must observe.
 */
export interface ObserveCursor {
  load(): Promise<unknown>
  save(state: unknown): Promise<void>
}

/* ------------------------------------------------------------------------------------- §2.13 */

/** 'local' = originated by this engine instance. 'remote' = observed via store.subscribe. */
export type EventSource = 'local' | 'remote'

/**
 * The store-derived half. **No DOM values and no `view`** — these are exactly the events
 * `observeStore` can construct in a service worker, and they are structurally cloneable.
 */
export interface StoreEventMap {
  'thread:create': { thread: Thread; comment: Comment; source: EventSource }
  'thread:reply': { thread: Thread; comment: Comment; source: EventSource }
  'thread:resolve': { thread: Thread; source: EventSource }
  'thread:reopen': { thread: Thread; reason: 'explicit' | 'reply'; source: EventSource }
  'thread:delete': {
    thread: Thread
    comments: readonly Comment[]
    reason: 'explicit' | 'empty'
    source: EventSource
  }
  'comment:edit': { thread: Thread; comment: Comment; previousBody: string; source: EventSource }
  'comment:delete': {
    thread: Thread | null
    comment: Comment
    threadDeleted: boolean
    source: EventSource
  }
}

export type ErrorPhase = 'store' | 'anchor' | 'listener' | 'trigger' | 'placement'
export type StoreEventName = keyof StoreEventMap

/**
 * Envelope shared by `StoreEvent` and (DOM half) `CommentEvent`. Spec §2.13 writes
 * `StoreEvent = Extract<CommentEvent, { type: StoreEventName }>`; that formulation routes a
 * DOM-free type through `CommentEventMap`, which references `Element` — so `headless.d.ts`
 * would reference `lib.dom`, which §1.1 forbids. Factoring the envelope keeps both types
 * structurally identical to the spec's and keeps `StoreEvent` assignable to `CommentEvent`.
 */
export type EventEnvelope<M> = {
  [K in keyof M]: {
    type: K
    /** Monotonic per emitting instance, starting at 1. Ordering key for cross-context relays. */
    seq: number
    /** Date.now() at emit. */
    at: number
    payload: M[K]
  }
}[keyof M]

/** What `observeStore` delivers. `StoreEvent` is assignable to `CommentEvent`. */
export type StoreEvent = EventEnvelope<StoreEventMap>
