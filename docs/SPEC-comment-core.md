# SPEC — `comment-core` + `comment-ui` (LOCKED)

> **Status: LOCKED.** This document is the implementation contract. Every export, signature,
> default value, ordering rule and error path below is normative. Implementers must not make
> API decisions; if something appears underspecified, it is a spec bug — fix the spec, then
> the code. Converged from entropy+ proposals A (dx), B (minimal), C (capability) against
> `PLAN.md` v2. Decision log in §9.
>
> **Locked-by-PLAN invariants that this spec never renegotiates:** the `Thread` / `Comment` /
> `AnchorDescriptor` / `Selector` / `ElementFingerprint` / `ElementCapture` record shapes
> (PLAN §3.1, §3.4, §3.5); the 9-method `CommentStore` (§3.6); the engine surface
> `createCommentEngine({ store, pageKey?, modes })`, `startPlacement(kind)`, `appendComment`,
> `resolve`, `reopen`, `delete`, `listThreads(): Thread[]`, `destroy()`, `on(...)` (§3.7); the
> event names `thread:create | thread:reply | thread:resolve | thread:reopen | thread:delete |
> thread:anchored | thread:orphaned | thread:click` (§3.7); the edge-case table (§3.5);
> `resolveAnchor(anchor) → { element, confidence } | null` (§3.1); no `chrome.*` / `wxt/*`
> import anywhere (§2); `comment-core` never imports `copilot` (§2).
>
> **Two locked signatures are deliberately widened. Both are called out here rather than
> renegotiated by omission:**
> 1. `listThreads(): ThreadView[]` — `ThreadView extends Thread`, so this is a structural
>    superset and every PLAN §3.7 call site still typechecks.
> 2. `appendComment(...): Promise<AppendResult>` — this is **not** a superset of `Comment`.
>    PLAN §3.7 must be amended to `Promise<AppendResult>` in the same commit; PLAN-verbatim
>    call sites read `result.comment` instead of the bare comment. The wrapper exists because
>    `reopened` and `deduped` (§4.1 rules 3 and 15) are unrecoverable from the comment alone
>    and the bridge needs both.
>
> **One deliberate coupling to a sibling module is documented rather than hidden:** `Author`
> is the locked `'user' | 'copilot'` union (PLAN §3.5), and §4.1 rules 3/4 branch on it. The
> behavioural axis — "does a reply reopen a resolved thread?" — is exposed as
> `DomainOptions.reopensOnReply` so a host can model a third actor without the union changing.
> `comment-core` still never imports `copilot`.

---

## 1. Packages, entry points, dependencies

### 1.1 `comment-core`

| Subpath | Contents | DOM required | DOM **types** in its `.d.ts` |
|---|---|---|---|
| `comment-core` | domain, engine, store adapters, page key, events, errors, types | engine only | yes |
| `comment-core/headless` | domain, store adapters, `observeStore`, page key, errors, DOM-free types | no | **no** |
| `comment-core/anchor` | capture / resolve / score / fingerprint / strategies | yes (injectable `Document`) | yes |
| `comment-core/testing` | conformance suites (`storeConformance`, `domainConformance`) | no | no |
| `comment-core/testing` → `createTestPage` | happy-dom fixture | yes | yes |

`comment-core` (root) re-exports **everything** in `comment-core/anchor` and
`comment-core/headless`. `"sideEffects": false` plus pure top-level declarations make the DOM
half tree-shakeable. **`createDomain`, `observeStore`, all store adapters, `defaultPageKey`,
`createPageKey`, `CommentError` and every type must be reachable without touching
`document`, `window`, `navigator`, `chrome` or `localStorage` at module scope.** A CI test
imports the root entry with those globals deleted and asserts it loads.

**`comment-core/headless` is normative, not a convenience (runtime globals are not the only
constraint).** The root entry's *type* surface references `Element`, `Range`, `Document`,
`ParentNode` and `Selection`, so under a service-worker tsconfig
(`lib: ["ES2022", "WebWorker"]`) `import … from 'comment-core'` **does not compile** — the
identifiers do not exist. A service worker therefore imports from `comment-core/headless`,
whose emitted declarations must reference no `lib.dom` identifier at all. A CI test
typechecks a file that imports `comment-core/headless` under a DOM-free `lib`.

Build: Vite lib mode, ESM + IIFE. IIFE global: `Comments`. Declarations are emitted by
`tsgo -p tsconfig.build.json` into `dist/types/`, and **`publishConfig.exports` must name files the
build actually produces** — a `types` condition pointing at a `.d.ts` no build step writes is
invisible in the workspace (where `exports` resolves to `src`) and resolves to `any` for every
published consumer (SPEC-copilot decision log #33; this package's four subpaths were verified
against a real build and a consumer type-check, and needed no change).
Runtime deps: `@medv/finder`, `approx-string-match`, `nanoid`, and vendored Hypothesis
`annotator/anchoring` (BSD-2, `src/anchor/vendor/hypothesis/`). Nothing else.
One **optional peer** dependency: `happy-dom`, required only by `createTestPage` (§2.16),
which throws `CommentError('invalid_options')` with an install hint when it is absent.

### 1.2 `comment-ui`

Single entry `comment-ui`. Depends on `comment-core` and `@floating-ui/dom`. IIFE global:
`CommentsUI`. ESM + IIFE.

**IIFE build contract (normative).** `comment-ui.iife.js` declares `comment-core` **external**
and reads it from `globalThis.Comments`; it never bundles its own copy. `comment-core.iife.js`
must therefore be loaded first (§7.1). Consequently `CommentError.is` is **brand-based** (a
non-enumerable `Symbol.for('comment-core.error')` marker plus the `code` field), never
`instanceof` — so it stays correct across bundle, realm and structured-clone boundaries.

---

## 2. Public TypeScript API — `comment-core`

### 2.1 Primitives

```ts
/** Cancels a subscription. Idempotent: calling it twice is a no-op. */
export type Unsubscribe = () => void

/** The one reactive primitive in this codebase. Everything observable is one of these. */
export interface ReadableStore<T> {
  /** Current value. Never throws. Always returns the value the last listener call observed. */
  get(): T
  /** Subscribe to changes. Does NOT fire on subscribe. Returns an unsubscriber. */
  subscribe(listener: (value: T, previous: T) => void): Unsubscribe
}
```

There is no `select()`, no `derived()`, no framework adapter subpath. A `useSyncExternalStore`
binding is a handful of module-level constants at the call site (§7.4 — hoisted, with a server
snapshot); a Svelte store contract is satisfied by `ReadableStore` shape adaptation in 3 lines.

### 2.2 Domain types (locked, restated verbatim + `kind` from PLAN v2 §3.5)

```ts
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
export const THREAD_VERSION: 1
```

`Thread` and `Comment` gain **no** further fields, ever. Host/plugin state (copilot run
linkage, unread, pending-dispatch set) lives in a host-owned side map keyed by `threadId`.
Rejected: `Thread.meta`, sidecar stores, `Register` module augmentation of `Author`.

**That side map must be durable, and the bridge contract names where it lives (§6):** the
`{ns}:host:*` key range on the same `KeyValueAdapter`. In-memory host state in a service
worker dies with the worker every 30 s, which would silently lose PLAN §5's pending-dispatch
set — the one piece of host state whose loss is user-visible. `comment-core` owns no key in
that range and never reads it.

### 2.3 Derived view types (never persisted)

```ts
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
  /**
   * Newest comment. Non-nullable by invariant: rules 2 and 7 make an empty thread impossible,
   * and a thread that reads back with zero comments is skipped (and GC'd) exactly like an
   * unknown-version record, rather than being surfaced with a null here.
   */
  readonly lastComment: Comment
  /**
   * `max(comment.createdAt, comment.editedAt)` over the comment list — the recency key the UI
   * sorts and labels by. Comment writes deliberately do NOT bump `thread.updatedAt` (§4.1),
   * so this is derived, never persisted.
   */
  readonly lastActivityAt: string
}
```

**Identity guarantee (normative).** Every `ThreadView` is `Object.freeze`d and referentially
stable until that thread's record, its comment list, or its `Anchoring` changes. `===` diffing,
`React.memo` and `useSyncExternalStore` are correct without selectors. `engine.threads.get()`
returns a frozen array that is itself referentially stable when no view changed.

### 2.4 Anchoring types (locked)

```ts
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

export interface AnchorMatch {
  element: Element
  range: Range | null
  confidence: number
  via: MatchVia
}
```

### 2.5 Anchoring API (`comment-core/anchor`, re-exported from root)

```ts
/**
 * Snapshot a target into everything a Thread needs. A Thread never has an anchor without a
 * capture, so this is one call. Never throws: a detached node yields a low-signal descriptor.
 */
export function captureTarget(
  target: Element | Range,
  options?: CaptureOptions,
): { anchor: AnchorDescriptor; capture: ElementCapture }

export interface CaptureOptions {
  /** Defaults to target's ownerDocument. */
  document?: Document
  /** Extra strategies, merged with defaultStrategies and sorted by weight. */
  strategies?: readonly SelectorStrategy[]
  /** outerHTML byte cap after sanitization. Default 8192. */
  htmlLimit?: number
  /** capture.text char cap. Default 2000. */
  textLimit?: number
  /** Replaces the built-in sanitizer (strips <script>, on* attrs, javascript: URLs). */
  sanitize?: (html: string) => string
  /** Last chance to strip PII before persistence. Runs after sanitize. */
  redact?: (capture: ElementCapture) => ElementCapture
  now?: () => Date
}

/**
 * Re-attach a descriptor to a live element. Races all selectors, verifies every candidate
 * against the fingerprint, falls back to a bounded same-tag scan. Returns null below
 * threshold — never guesses. Never throws.
 */
export function resolveAnchor(
  anchor: AnchorDescriptor,
  options?: ResolveOptions,
): AnchorMatch | null

export interface ResolveOptions {
  /** Resolution scope. Default: `document`. Pass an added subtree for the cheap retry path. */
  root?: ParentNode
  document?: Document
  strategies?: readonly SelectorStrategy[]
  /** Accept score. Default 0.62. */
  threshold?: number
  /** fingerprint-scan candidate budget. Default 500. */
  scanLimit?: number
  /** Overrides scoreCandidate for every candidate. */
  scoring?: (element: Element, fingerprint: ElementFingerprint) => number
  /** Wall-clock budget in ms for one resolve. Default 12. Exceeded ⇒ return best-so-far/null. */
  budgetMs?: number
}

/** Same as resolveAnchor but returns a full per-selector trace. Powers `engine.explain()`. */
export function explainAnchor(
  anchor: AnchorDescriptor,
  options?: ResolveOptions,
): AnchorExplanation

export interface AnchorExplanation {
  anchor: AnchorDescriptor
  attempts: readonly AnchorAttempt[]
  result: AnchorMatch | null
  totalMs: number
  budgetExceeded: boolean
}

export interface AnchorAttempt {
  selector: Selector | 'fingerprint-scan'
  /** Candidates the selector produced. */
  candidates: number
  /** Best fingerprint score among them, 0 when none. */
  best: number
  accepted: boolean
  ms: number
}

/** Fingerprint similarity, 0..1. Tag mismatch ⇒ 0. Semantics > classes > structure > text. */
export function scoreCandidate(element: Element, fingerprint: ElementFingerprint): number

/** Build a fingerprint. Filters hashed/utility class names (finder v4 heuristics). */
export function fingerprintElement(
  element: Element,
  options?: { classFilter?: (className: string) => boolean },
): ElementFingerprint

/** Sanitized, truncated snapshot of an element or range. */
export function captureElement(
  target: Element | Range,
  options?: CaptureOptions,
): ElementCapture

/**
 * Custom locator. `verify` is not a choice: every candidate is fingerprint-verified.
 * `S` is constrained to `{ type: string }` rather than `Selector` so a synthesized
 * `{ type: 'x-row-id'; value: string }` from `defineSelectorStrategy` fits without the
 * implicit-index-signature dance; every persisted selector still satisfies `Selector`.
 */
export interface SelectorStrategy<S extends { type: string } = Selector> {
  /** Must be a BuiltinSelector['type'] to replace a builtin, or `x-*` for a custom one. */
  type: S['type']
  /** Higher runs first. Builtins: attr 90, css 80, textQuote 70, nthPath 40, textPosition 30. */
  weight: number
  /** 'fuzzy' strategies are skipped on the MutationObserver fast path. Default 'cheap'. */
  cost?: 'cheap' | 'fuzzy'
  /** Produce the selector payload (minus `type`) for a target, or null to abstain. */
  describe(target: Element | Range, ctx: DescribeContext): Omit<S, 'type'> | null
  /** Produce candidates. Returning a Range implies mode 'text'. */
  resolve(selector: S, ctx: ResolveContext): Element | Range | Iterable<Element> | null
}

export interface DescribeContext {
  document: Document
  /** target.closest() that also works for a Range (uses commonAncestorContainer). */
  closest(target: Element | Range, selector: string): Element | null
}

export interface ResolveContext {
  root: ParentNode
  document: Document
  /** Remaining ms in this resolve's budget. Strategies must respect it. */
  budgetMs: number
}

/**
 * Author a strategy. The payload is INFERRED from `describe`'s return type and the selector
 * type is synthesized as `{ type: TType } & TPayload`, so `resolve(sel, …)` sees the real
 * payload fields. (A single `<const S extends Selector>` parameter has no inference site —
 * `S['type']` is an indexed access and `Omit<S, 'type'>` is non-homomorphic — so `S` would
 * collapse to `Selector`, `Omit<Selector, 'type'>` to `{}`, and every payload access in
 * `resolve` would be a compile error. Hence two parameters.)
 */
export function defineSelectorStrategy<
  const TType extends BuiltinSelector['type'] | `x-${string}`,
  TPayload extends object,
>(strategy: {
  type: TType
  weight: number
  cost?: 'cheap' | 'fuzzy'
  describe(target: Element | Range, ctx: DescribeContext): TPayload | null
  resolve(
    selector: { type: TType } & TPayload,
    ctx: ResolveContext,
  ): Element | Range | Iterable<Element> | null
}): SelectorStrategy<{ type: TType } & TPayload>

/** The five PLAN §3.1 builtins, in weight order. */
export const defaultStrategies: readonly SelectorStrategy<BuiltinSelector>[]
```

### 2.6 Page key

```ts
export type PageKeyFn = (url: URL) => string

/** origin + pathname + query minus volatileParams; hash stripped; trailing slash stripped. */
export function defaultPageKey(url: URL, options?: PageKeyOptions): string

/** Curried defaultPageKey, for `createCommentEngine({ pageKey: createPageKey({...}) })`. */
export function createPageKey(options?: PageKeyOptions): PageKeyFn

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

/** utm_*, gclid, fbclid, msclkid, ref, and session/token-looking params. Extendable by hosts. */
export const volatileParams: readonly RegExp[]
```

Remaining params are sorted alphabetically before serialization so `?a=1&b=2` and `?b=2&a=1`
produce one key.

### 2.7 Store port (locked — PLAN §3.6)

```ts
/**
 * What a store can actually hand back: `v` is whatever is on disk, including versions this
 * build does not know. The literal `Thread['v'] = 1` would make an adapter returning a `v: 2`
 * record lie to the type system, and §4.1 rule 16 ("skip unknown versions, never rewrite")
 * would have nothing to narrow from. The domain narrows StoredThread → Thread.
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

/** Identity function; preserves the concrete literal type of a store object. */
export function defineCommentStore<const S extends CommentStore>(store: S): S
```

**Adapter contract (normative).**
1. `listThreads` / `listAllThreads` / `listComments` **must** return arrays sorted by
   `createdAt` ascending, ties broken by `id` ascending. Consumers never sort.
2. `putThread` / `putComment` are upserts keyed by `id`, and **must** resolve only when the
   write is durable.
3. `deleteThread` **must** cascade its comments. `deleteComment` **must not** touch the thread.
4. A write **must** notify local `subscribe` callbacks in this context as well as remote ones
   (the `storage` event does not fire in the writing tab). Notification may be coalesced.
5. `subscribe` **may over-notify; it must never under-notify.** Ignoring `pageKey` entirely is
   legal — the engine diffs snapshots anyway.
6. Adapters throw only on real I/O failure. Those propagate; the domain wraps them in
   `CommentError('store_failed')` with the original on `.cause`. A quota failure
   (`QuotaExceededError`, `DOMException` name `QuotaExceededError`, or a `chrome.runtime`
   `QUOTA_BYTES` message) **must** be mapped to `CommentError('quota_exceeded')` instead —
   it is the one store failure a host can act on (§2.14).
7. Threads and comments are stored as separate records (PLAN §3.6): **a comment write never
   writes the thread record at all** — not its capture and not its `updatedAt`. `updatedAt`
   moves only on a thread-level transition (status change on resolve / reopen). Comment
   recency is derived in `ThreadView.lastActivityAt`. This is what makes PLAN §3.6's split
   pay for itself, and it keeps every comment write a single-record write, which §4.3's
   crash-safety ordering already covers.

### 2.8 Shipped stores + the platform seam

```ts
/**
 * Storage-agnostic key/value seam. This is the ONLY thing standing between comment-core and
 * chrome.storage / Dexie / a server. `comment-core` never names a platform.
 */
export interface KeyValueAdapter {
  get(keys: readonly string[]): Promise<Record<string, unknown>>
  set(entries: Record<string, unknown>): Promise<void>
  remove(keys: readonly string[]): Promise<void>
  /**
   * All keys with this prefix. **Must be key-only (normative).** An implementation that
   * deserializes values to enumerate keys — `Object.keys(await chrome.storage.local.get(null))`
   * — is non-conforming: it reads every 8 KB capture and every run record on every call, and
   * the engine calls this on every store notification. Use `chrome.storage.local.getKeys()`,
   * an index key range, or an adapter-side key cache maintained from `watch`.
   */
  keys(prefix: string): Promise<string[]>
  /** Absent ⇒ single-context store, no cross-tab reactivity (local notify still works). */
  watch?(cb: (changedKeys: string[]) => void): Unsubscribe
}

/** In-memory store. Test default. */
export function createMemoryStore(seed?: readonly ThreadRecord[]): CommentStore & {
  /** Deep snapshot for assertions. */
  snapshot(): ThreadRecord[]
  restore(records: readonly ThreadRecord[]): void
  readonly reads: number
  readonly writes: number
}

/**
 * The general adapter. Key layout, all per-record — **there is no shared mutable key**:
 *   `{ns}:t:{pageKey}:{threadId}`   thread record (pageKey is in the key, URL-encoded)
 *   `{ns}:c:{threadId}:{commentId}` comment record
 * A comment write never rewrites a thread.
 */
export function createKeyValueStore(
  kv: KeyValueAdapter,
  options?: { namespace?: string },
): CommentStore

/**
 * Demo/standalone default. Built on createKeyValueStore + a `storage`-event watch.
 *
 * **Demo-only, and per-origin (normative caveat).** In a content script `localStorage` is the
 * HOST PAGE's origin storage — the same trap PLAN §3.6 documents for IndexedDB. Threads are
 * therefore per-site, evictable under storage pressure, wiped by "clear site data", and
 * readable by the page. Extensions and any multi-page product MUST pass
 * `createKeyValueStore(kv)` over extension-owned storage instead.
 */
export function createLocalStorageStore(options?: {
  storage?: Storage
  namespace?: string
}): CommentStore
```

`createLocalStorageStore()` accesses `localStorage` **lazily on first call**, never at module
scope. Absent `localStorage` ⇒ `CommentError('store_failed')` on first operation.

**Key-layout rationale (normative).** An earlier layout kept a `{ns}:i:{pageKey}` thread-id
index. It is deliberately gone: `chrome.storage` offers no CAS and no transaction, so a shared
index is a lock-free read-modify-write between the SW and every content script — two concurrent
creates on one page last-writer-wins the index and drop a thread from `listThreads(pageKey)`
forever while `listAllThreads()` still returns it. Putting `pageKey` in the thread key makes
`listThreads(pageKey)` a prefix scan (`keys('{ns}:t:{pageKey}:')`) over immutable-per-record
keys, so no write ever collides. `putThread` on a thread whose `pageKey` changed writes the new
key and removes the old one, comment-key-style: new key first, old key second.

**Namespace filtering of `watch` (normative).** `createKeyValueStore` **must** ignore changed
keys that do not start with its own `{ns}:`, and must not notify `subscribe` for them. Without
this rule a shared `KeyValueAdapter` (the bridge passes one adapter to both this store and
`copilot`'s `createKeyValueRunStore`) turns a 10 s run heartbeat into a full thread + comment
re-read and anchoring diff in every tab, forever, for a write that has nothing to do with
comments. "`subscribe` may over-notify" is a licence to coalesce, not a licence to fan in
another module's traffic.

### 2.9 Domain (headless — no DOM, no engine)

```ts
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
 * feature-detects (`'reopened' in r`) and a bridge replaying a create can tell whether it
 * actually wrote — the information §4.1 rule 15 exists to provide.
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
   * **Normative defaults, because "the implementation's default" must not be guessable:**
   * `createDomain` (no DOM, no current page) defaults to ALL pages;
   * `CommentEngine` defaults to the engine's CURRENT `pageKey`.
   * Refactoring between `engine.list()` and `createDomain(store).list()` therefore changes
   * the result set on purpose, and `pageKey: null` makes the two identical.
   */
  pageKey?: string | null
  kind?: string | readonly string[]
  status?: 'open' | 'resolved'
  /** Threads having ≥1 comment by this author. */
  author?: Author
  /** ISO string; thread.createdAt >= since. */
  since?: string
}

/**
 * Engine-only filter. `anchor` is a live derivation, so it exists only where a DOM does —
 * rather than sitting on `ThreadFilter` as a field one of the two implementations silently
 * ignores (a SW filtering `{ anchor: 'orphaned' }` would get every thread, with no error).
 */
export interface EngineThreadFilter extends ThreadFilter {
  anchor?: AnchorStatus
}

export interface DomainOptions {
  now?: () => Date
  /** Default: nanoid(12). */
  createId?: () => string
  /**
   * Does a reply by this author reopen a resolved thread? Default: `(a) => a === 'user'`,
   * which is §4.1 rules 3/4 verbatim. This is the behavioural axis behind the `Author` union,
   * exposed so a host can model a third actor without `comment-core` learning its name.
   */
  reopensOnReply?: (author: Author) => boolean
  /**
   * Receives every domain-level fault the caller cannot see, because a domain call cannot
   * reject for a record it never returned: `unsupported_version` (§4.1 rule 16) and read-time
   * GC failures. Required for `domainConformance()` to be able to assert rule 16 at all.
   */
  onError?: (error: CommentError) => void
}

export function createDomain(store: CommentStore, options?: DomainOptions): CommentDomain
```

### 2.10 Store-level observation (no engine, no DOM)

```ts
/**
 * Emit domain events by diffing consecutive store snapshots. Fires in EVERY context watching
 * the store — content script, other tabs, service worker — so a background context gets the
 * hooks without a messaging channel.
 */
export function observeStore(
  store: CommentStore,
  listener: (event: StoreEvent) => void,
  options?: ObserveOptions,
): Unsubscribe

export interface ObserveOptions {
  /** null = all pages (default). */
  pageKey?: string | null
  /** Emit `thread:create` for records that already existed at subscribe time. Default false. */
  replay?: boolean
  /**
   * Durable cursor. **Required in a service worker; without it `observeStore` cannot work.**
   * See "Cold-start correctness" below.
   */
  cursor?: ObserveCursor
}

/**
 * Where the last-seen position is persisted. `createKeyValueCursor(kv, { namespace })` is
 * shipped; it stores one record under `{ns}:cursor:{id}`. In-memory (the default) is correct
 * only for a context that outlives every write it must observe — i.e. a page, never an MV3
 * service worker.
 */
export interface ObserveCursor {
  load(): Promise<unknown>
  save(state: unknown): Promise<void>
}

export function createKeyValueCursor(
  kv: KeyValueAdapter,
  options?: { namespace?: string; id?: string },
): ObserveCursor
```

`observeStore` emits only the store-derived subset: `thread:create`, `thread:reply`,
`thread:resolve`, `thread:reopen`, `thread:delete`, `comment:edit`, `comment:delete` — the
`StoreEventMap` of §2.13, whose payloads contain **no** `view` and no DOM values (a service
worker has no `Element`, so a `ThreadView` there would be a fiction). It never emits
`thread:anchored`, `thread:orphaned`, `thread:click`, `placement:*`, `page:change`.
Every event it emits carries `source: 'remote'` — it cannot know origin. **Consumers must
guard trigger loops on `comment.author`, never on `source`** (PLAN §8).

**Cold-start correctness (normative).** A diff needs a baseline. If the baseline is taken at
subscribe time, then in the case `observeStore` exists for — `chrome.storage.onChanged` waking
a dormant service worker — the baseline is read *after* the write that caused the wake, the
write is invisible, and the run is never triggered. Since an MV3 worker is dormant after 30 s
of idle, that is the normal case, not an edge case. Therefore:

1. The cursor is **persisted, not in-memory**: `{ lastSeenAt, seen }` where `lastSeenAt` is the
   max `createdAt`/`editedAt`/`updatedAt` observed and `seen` is the set of record ids at or
   after `lastSeenAt` (a bounded tie-breaker set, capped at 200 ids).
2. On every notification, `observeStore` loads the cursor, diffs the store against it, emits,
   and saves the advanced cursor **after** the listener's returned promise settles. A listener
   that throws or rejects does not advance the cursor, so the event is re-delivered on the next
   notification rather than lost — at-least-once, which is exactly why §4.1 rule 15's
   idempotency keys exist.
3. With `replay: false` (default) and an empty cursor, the first load records the cursor and
   emits nothing; with `replay: true` it emits `thread:create` for everything.
4. **Bounded work.** A notification must not re-read every thread and every comment. The diff
   reads the thread-key prefix (`keys()` is key-only per §2.8), compares against the cursor,
   and reads comments only for threads whose key set changed. Cost is O(changed records), not
   O(store).
5. **Coalescing rules.** A notification carrying several new comments emits one `thread:reply`
   per new comment id, in `createdAt` order. A notification carrying both a status flip to
   `open` and a new comment emits `thread:reopen` then `thread:reply` (§4.2.4), with
   `reason: 'reply'` **iff** the same diff adds a comment whose author satisfies
   `reopensOnReply`, and `reason: 'explicit'` otherwise.

### 2.11 Engine

```ts
export function createCommentEngine<S extends CommentStore = CommentStore>(
  options?: CommentEngineOptions<S>,
): CommentEngine<S>

export interface CommentEngineOptions<S extends CommentStore = CommentStore> {
  /** Default: createLocalStorageStore(). */
  store?: S
  /** Default: defaultPageKey. */
  pageKey?: string | PageKeyFn
  /** Default: [{ kind: 'comment', trigger: { key: 'c', interaction: 'pick' } }]. */
  modes?: readonly Mode[]
  anchoring?: AnchoringOptions
  /**
   * Capture-side options (sanitize / redact / htmlLimit / textLimit). Separate from
   * `anchoring`, which is resolve-side only. Without this, `redact` — "last chance to strip
   * PII before persistence" — would be unreachable from the only entry point anyone uses.
   * `document` is supplied by the engine and cannot be overridden here.
   */
  capture?: Omit<CaptureOptions, 'document' | 'strategies'>
  /**
   * Default: { watch: true } — polls `location.href` inside the anchoring batch and listens
   * for `popstate` / `hashchange`. See §4.6.6: patching history is NOT part of this contract.
   */
  navigation?: { watch?: boolean; source?: 'auto' | ((cb: () => void) => Unsubscribe) } | false
  /** Default true. When false, call start() yourself. */
  autoStart?: boolean
  /** Receives every `error` event, including ones thrown by `error` listeners. */
  onError?: (error: CommentError, phase: ErrorPhase) => void
  /**
   * Test/SSR seam. Default: `globalThis.document`, read at `start()`.
   * **Missing-document behavior (normative).** `start()` with no usable `document` throws
   * `CommentError('no_document')` synchronously. Since `autoStart` defaults to `true`, that
   * throw comes out of `createCommentEngine()` itself — so an SSR/worker caller must pass
   * `autoStart: false` (construction then succeeds, `status` stays `'idle'`, every DOM-bound
   * method is a documented no-op) or use `createDomain` instead.
   */
  document?: Document
  now?: () => Date
  createId?: () => string
  reopensOnReply?: (author: Author) => boolean
}

export interface Mode {
  /** Stamped verbatim onto `Thread.kind`. The engine attaches zero behavior to it. */
  kind: string
  /** false ⇒ no built-in trigger; the host calls startPlacement(kind). */
  trigger?: TriggerSpec | false
  /** Passed through to comment-ui for badge chrome. Ignored by the engine. */
  badge?: { icon?: string; label?: string }
}

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

export interface AnchoringOptions extends Omit<ResolveOptions, 'root' | 'document'> {
  /** Shared MutationObserver. Default true. */
  observe?: boolean
  /** Batch coalescing window, idle-scheduled. Default 100. */
  batchMs?: number
  /** Full-document retry for orphans when idle. Default true. */
  rescanIdle?: boolean
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
  /** PLAN §3.7 signature preserved: ThreadView[] ⊆ Thread[]. Defaults to the current page. */
  listThreads(filter?: EngineThreadFilter): ThreadView[]
  /**
   * Synchronous live-view lookup — the sync counterpart of the async `CommentDomain.get(id)`,
   * which keeps returning a `ThreadRecord` from the store.
   */
  getThreadView(id: string): ThreadView | null
  /** Resolves after the first store load + first anchoring pass. */
  ready(): Promise<void>

  /* --- placement (PLAN §3.3 / §3.7) --- */
  /** Locked alias for `placement.start(kind)`. Returns false when the kind is unknown. */
  startPlacement(kind?: string): boolean
  /**
   * Re-configure trigger modes at runtime (options-page hotkey change, PLAN §4.6). Cancels any
   * in-flight placement, re-registers key listeners, and leaves threads, decorations and
   * listeners untouched. Throws `invalid_options` on a duplicate `key`+`modifiers` pair, same
   * as construction. Existing threads keep their stored `kind` even if its mode is gone; a
   * thread whose kind is no longer in `modes` renders with default badge chrome.
   */
  setModes(modes: readonly Mode[]): void

  /* --- anchoring control --- */
  /** Force a resolution pass. Omit id for all threads on the page. */
  reanchor(threadId?: string): Promise<void>
  /** Scroll to + mark active + emit `thread:click`. False when unknown or not anchored. */
  focus(threadId: string, options?: { scroll?: boolean | ScrollIntoViewOptions }): boolean
  /**
   * Per-selector trace. **Cached by default (normative): returns the trace recorded by the
   * last resolution pass for that thread, or `null` if it has not been resolved since
   * `start()`.** Free to call from a `thread:anchored` listener and free to map over every
   * thread for the M2 bench table (PLAN §3.8). `{ fresh: true }` re-runs resolution now and
   * costs one `budgetMs` pass per thread — never call that in a listener.
   */
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
  off<E extends CommentEventName>(
    event: E,
    listener: (payload: CommentEventMap[E]) => void,
  ): void
  /** The `*` firehose. Receives each event AFTER its typed listeners. */
  subscribe(listener: (event: CommentEvent) => void): Unsubscribe

  start(): void
  stop(): void
  destroy(): void
  /** Serializable snapshot for devtools / the options page. */
  inspect(): EngineInspection
}
```

`CommentEngine extends CommentDomain` is load-bearing: `engine.appendComment(...)` in the
content script and `createDomain(store).appendComment(...)` in the service worker are the
**same interface with the same rules**, tested once by `domainConformance()`.

### 2.12 Placement + composer

```ts
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
```

Nothing is persisted before `submit()` resolves. `submit()` while `submitting` is ignored
(resolves with the in-flight promise). On submit failure the state returns to `composing` with
the draft intact.

**User-flow rejections are not errors (normative).** `start()` while `composing`/`submitting`,
and a `hover` trigger with nothing hovered, are ordinary interactions — pressing the trigger
key twice is not a fault. Both return `false` and emit **`placement:rejected`**
(`{ kind, reason: 'busy' | 'no_target' | 'unknown_kind' }`), **not** `error`. The `error`
channel is reserved for faults, so `onError` stays bindable to a pager without filtering.
`unknown_kind` additionally still emits `error` (it is a programming mistake, §4.1 rule 17).

### 2.13 Events

```ts
/** 'local' = originated by this engine instance. 'remote' = observed via store.subscribe. */
export type EventSource = 'local' | 'remote'

/**
 * The store-derived half. **No DOM values and no `view`** — these are exactly the events
 * `observeStore` can construct in a service worker, and they are structurally cloneable, so a
 * cross-context relay forwards them unprojected.
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
  'error': { error: CommentError; phase: ErrorPhase; threadId?: string }
}

export interface CommentEventMap extends StoreEventMap, EngineOnlyEventMap {}

export type ErrorPhase = 'store' | 'anchor' | 'listener' | 'trigger' | 'placement'
export type CommentEventName = keyof CommentEventMap
export type StoreEventName = keyof StoreEventMap

export type CommentEvent = {
  [K in CommentEventName]: {
    type: K
    /** Monotonic per engine instance, starting at 1. Ordering key for cross-context relays. */
    seq: number
    /** Date.now() at emit. */
    at: number
    payload: CommentEventMap[K]
  }
}[CommentEventName]

/** What `observeStore` delivers. `StoreEvent` is assignable to `CommentEvent`. */
export type StoreEvent = Extract<CommentEvent, { type: StoreEventName }>
```

Every PLAN §3.7 listener compiles verbatim: `engine.on('thread:create', ({ thread, comment }) => {})`
typechecks because the payloads are structural supersets.

**Why no `view` on `thread:create` / `thread:reply`.** It was a per-event convenience that cost
two structural properties: (a) `observeStore` — which has no DOM and therefore no `Element`, no
`Range` and no meaningful `Anchoring` — could not construct one, and it is the load-bearing SW
mechanism (decision log #10); (b) since those two events always carried it, *no* domain event
was structured-cloneable and every relay had to project. Listeners that want the view call
`engine.getThreadView(id)`, which §4.2.2 already guarantees is fresh inside the listener.

### 2.14 Errors

```ts
export class CommentError extends Error {
  readonly name: 'CommentError'
  readonly code: CommentErrorCode
  readonly threadId?: string
  readonly commentId?: string
  readonly cause?: unknown
  /**
   * Narrowing type guard, optionally on a specific code. **Brand-based, never `instanceof`**
   * (§1.2): it must stay true across the IIFE/ESM boundary and across realms.
   */
  static is(e: unknown, code?: CommentErrorCode): e is CommentError
}

export type CommentErrorCode =
  | 'thread_not_found'
  | 'comment_not_found'
  | 'empty_body'
  | 'no_target'
  | 'placement_busy'
  | 'unknown_kind'
  | 'store_failed'
  /** Store is full. Distinguished from store_failed because it is the one a host can act on. */
  | 'quota_exceeded'
  | 'unsupported_version'
  | 'engine_destroyed'
  /** Bad construction/config: duplicate trigger binding, unusable option combination. */
  | 'invalid_options'
  /** start() found no usable `document`. Thrown synchronously. */
  | 'no_document'
```

`no_target` and `placement_busy` remain in the union because `startPlacement` still reports
them on its return value and in `placement:rejected`; they are no longer emitted as `error`
events (§2.12).

One class, one code union, one guard. Rejected: a subclass hierarchy; a zero-error design.

### 2.15 Introspection

```ts
export interface EngineInspection {
  version: string
  pageKey: string
  modes: readonly Mode[]
  /**
   * `reads`/`writes` are counted BY THE ENGINE (calls it made through the port), because
   * `CommentStore` exposes no counters — only `createMemoryStore` does, as an extra. They are
   * optional so a store-less inspection is still well-typed.
   */
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
```

### 2.16 `comment-core/testing`

```ts
export type Awaitable<T> = T | Promise<T>
export interface ConformanceCase { name: string; run: () => Promise<void> }

/** ~50 assertions: sorting, cascade delete, subscribe fan-out, upsert, durability. */
export function storeConformance(factory: () => Awaitable<CommentStore>): ConformanceCase[]

/**
 * The 15 store-observable rows of the §4.1 table, plus idempotency and empty-body rejection.
 * Rule 16 is observed through `DomainOptions.onError`.
 */
export function domainConformance(factory: () => Awaitable<CommentStore>): ConformanceCase[]

/**
 * The two engine-only rows of §4.1 (14 orphaning, 17 unknown kind) plus the §4.2 ordering
 * rules that need a DOM. Requires `happy-dom` (it drives `createTestPage`).
 */
export function engineConformance(factory: () => Awaitable<CommentStore>): ConformanceCase[]

/**
 * happy-dom fixture: build a page, drive the engine, flush the anchoring batch.
 * **The only DOM-requiring export of this subpath**, and the only reason `happy-dom` is an
 * optional peer dependency (§1.1). Absent ⇒ throws `CommentError('invalid_options')` with an
 * install hint. `storeConformance` / `domainConformance` remain DOM-free and need no peer.
 */
export function createTestPage(
  html: string,
  options?: { url?: string },
): {
  document: Document
  engine(options?: CommentEngineOptions): CommentEngine
  /** Applies the mutation and awaits the next anchoring flush. */
  mutate(fn: (doc: Document) => void): Promise<void>
  navigate(url: string): Promise<void>
  /** Awaits pending store writes + one anchoring flush. */
  flush(): Promise<void>
  dispose(): Promise<void>
}
```

Runner-agnostic on purpose (arrays of `{ name, run }`), so vitest / node:test / bun all work:
`for (const c of storeConformance(f)) it(c.name, c.run)`.

---

## 3. Public TypeScript API — `comment-ui`

```ts
import type { CommentEngine, CommentEngineOptions, ThreadView } from 'comment-core'

/** Attach the shadow-root UI to an engine you already own. */
export function mountCommentUI(engine: CommentEngine, options?: CommentUIOptions): CommentUI

/**
 * Zero-config bootstrap for <script> tags: builds the engine too. Global: CommentsUI.mount().
 * The two option bags are **nested, not intersected**: `CommentUIOptions['onError']` is
 * `(error: unknown) => void` and `CommentEngineOptions['onError']` is
 * `(error: CommentError, phase: ErrorPhase) => void`, and an intersection of those makes the
 * two-parameter form uncallable — on the zero-config entry point.
 */
export function mount(options?: {
  ui?: CommentUIOptions
  engine?: CommentEngineOptions
}): CommentUI & { engine: CommentEngine }

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
   * Host-driven badge chrome. This is how "copilot thinking" and "pending dispatch" are
   * rendered without comment-ui ever learning what a copilot is. Pass null to clear.
   *
   * **Lifecycle (normative).** A decoration is dropped automatically on that thread's
   * `thread:delete` and on `page:change` (the whole map is cleared), so the map cannot leak
   * and a stale chip cannot survive a navigation. Decorations are otherwise sticky and have
   * no TTL: a chip set from an edge event (e.g. "copilot busy") will outlive a service-worker
   * death unless the host re-derives it from durable state on mount — see SPEC-copilot §6.
   */
  decorate(threadId: string, decoration: Decoration | null): void
  unmount(): void
}

export interface Decoration {
  chip?: { text: string; tone?: 'neutral' | 'info' | 'busy' | 'warn' | 'danger'; spinner?: boolean } | null
  tone?: 'default' | 'muted' | 'accent'
  /** title attribute on the badge. */
  title?: string
}

export type PanelSection = 'open' | 'resolved' | 'unanchored'

export interface CommentUIOptions {
  /** Default: document.documentElement. */
  container?: HTMLElement
  /** Raw CSS appended inside the shadow root, after the built-in sheet. */
  css?: string
  /** i18n — every user-visible string lives here. */
  labels?: Partial<Labels>
  panel?: {
    enabled?: boolean // default true
    corner?: 'br' | 'bl' | 'tr' | 'tl' // default 'br'
    defaultOpen?: boolean // default false
    sections?: readonly PanelSection[] // default all three
  }
  badge?: {
    showResolved?: boolean // default false (Figma/Docs behavior)
    orphaned?: 'dock' | 'panel-only' | 'hidden' // default 'dock'
    offset?: [number, number] // default [6, -6]
    hideOffscreen?: boolean // default true (IntersectionObserver)
  }
  /** default true (stopPropagation at the shadow boundary; WXT isolateEvents equivalent). */
  isolateEvents?: boolean
  /** default 2147483000. The composer uses the top layer regardless. */
  zIndex?: number
  /** default '16px'. The documented WXT `all: initial` caveat — no rem-dependent styling. */
  rootFontSize?: string
  onError?: (error: unknown) => void
}

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
```

**Theming is CSS custom properties, not API.** They inherit through the shadow boundary, so
the entire theming surface is set on the host page. There is no `tokens` option, no
`defineTheme`, no `theme: 'auto' | 'light' | 'dark'`, and no slot/renderer system.

```css
:root {
  --cc-accent: #6366f1;
  --cc-surface: #fff;
  --cc-surface-2: #f6f6f8;
  --cc-text: #111;
  --cc-muted: #6b7280;
  --cc-border: #e5e7eb;
  --cc-danger: #dc2626;
  --cc-badge-size: 22px;
  --cc-radius: 8px;
  --cc-font: system-ui, sans-serif;
  --cc-shadow: 0 4px 16px rgb(0 0 0 / 0.14);
}
@media (prefers-color-scheme: dark) { :root { /* dark values */ } }
```

**`comment-ui` is a pure renderer (normative).** Its only state is which panel section is open,
which thread popover is open (mirrored into `engine.active`), and the host-supplied
`decorate()` map. Everything else is read from `engine.threads`, `engine.placement` and
`engine.modes`. It writes exclusively through `CommentEngine` methods — it has no privileged
path to the store.

Behavior it owns, none of it configurable (there is no second sane setting):
one open shadow root on `document.documentElement`; a `pointer-events: none` layer with
`auto` on interactive bits; the host page's DOM is never mutated; `@floating-ui/dom` +
`autoUpdate` (`flip`, `shift`, `animationFrame`) for badges and popover; `IntersectionObserver`
to skip off-screen badges; the composer uses the `popover` attribute (top layer, no z-index
wars); explicit `font-size` on `:host`; placement-mode highlight overlay drawn from
`engine.placement`'s `candidate`; resolved badges hidden from the page but listed in the panel;
orphaned threads shown as a dimmed badge docked at `anchoring.rect` (a `DocumentRect`,
re-projected to viewport coordinates on every scroll/resize by the same `autoUpdate` loop, so
the dock cannot drift after a scroll) plus the panel's "unanchored" section; an "approximately
re-anchored" marker when `anchoring.confidence < 0.85`; badge icon/label taken from the
thread's `Mode.badge`.

**`pending` renders nothing (normative).** A thread whose `anchoring.status` is `'pending'`
draws no badge on the page and appears in **no** panel section. On a cold load that is every
thread, for the length of the first resolution pass (§4.2.6) — anything else is exactly the
flash the anchoring rules exist to prevent.

**Host chrome is the host's own overlay (normative).** PLAN §5's floating
"N comments — Send to copilot" pill, thread multi-select and any batch affordance are **not**
`comment-ui` surface, and there is still no slot or renderer system (decision log #22 stands).
The host mounts its own overlay — its own shadow root, its own stacking context below
`CommentUIOptions.zIndex`, its own positioning — and drives it from `engine.threads`,
`engine.on(...)` and `ui.decorate()`. `comment-ui` renders badges, composer, thread popover and
panel, and nothing a host can inject into them.

**Accessibility (normative).** The composer popover moves focus to its textarea on open,
returns focus to the invoking badge (or the element that had focus at trigger time) on close,
and closes on `Esc`, which also cancels placement. Badges are real `<button>` elements:
keyboard reachable, `aria-label` composed from `Mode.badge.label` and the comment count,
`aria-expanded` reflecting their popover. The panel is a `<section>` named by
`Labels.panelTitle`, with heading-labelled lists per section. Decoration chips live in an
`aria-live="polite"` region so "copilot thinking" → settled is announced without stealing
focus; placement mode announces `Labels.pickHint` the same way. Colour never carries state
alone: resolved, orphaned and approximate each also have a shape or text marker.

---

## 4. Semantic contracts (normative)

### 4.1 The §3.5 edge-case table as normative behavior

All of it is implemented **once**, in `createDomain`. `createCommentEngine` inherits it by
extension. `domainConformance()` is the executable form of this table — **for the 15 rows a
headless domain can observe.** Rows 14 (orphaning) and 17 (`startPlacement`) are render-time
and trigger-time, so they belong to `engineConformance()` (§2.16), which runs against
`createTestPage`. Row 16 is asserted at the domain layer through `DomainOptions.onError`,
which exists for exactly that reason: a domain has no event bus, and a rule the conformance
suite cannot observe is a rule that will regress.

| # | Case | Normative behavior |
|---|---|---|
| 1 | Thread creation | `createThread` writes the first `Comment` **then** the `Thread` (or both inside `store.transaction` when available). `status: 'open'`, `resolvedAt: null`, `resolvedBy: null`, `kind` copied from input, `v: THREAD_VERSION`. Resolves with `CreateResult` (`kind: 'created'`). Exactly one `thread:create` event; never a `thread:reply` for a first comment. |
| 2 | Empty body | `body.trim() === ''` rejects with `empty_body` **before any write**, in `createThread`, `appendComment` and `editComment`. "An empty thread cannot exist" is enforced at the domain boundary, not the UI. |
| 3 | Human replies to a resolved thread | `appendComment` by an author for which `reopensOnReply(author)` is true (default: `'user'`) sets `status: 'open'`, `resolvedAt: null`, `resolvedBy: null`, and bumps `updatedAt` — this is a thread-level transition, so it is the one comment write that also writes the thread record. `AppendResult.reopened === true`. Emits `thread:reopen` (`reason: 'reply'`) **then** `thread:reply`. |
| 4 | Copilot replies to a resolved thread | `appendComment` by an author for which `reopensOnReply(author)` is false (default: `'copilot'`) appends the comment and leaves `status`, `resolvedAt`, `resolvedBy` **untouched** — no thread write at all. `reopened === false`. Emits only `thread:reply`. A slow machine reply can never resurrect a thread a human resolved. |
| 5 | Any reply to an open thread | Comment appended, `reopened === false`, and **the thread record is not written** — `updatedAt` does not move on a comment write (§2.7 rule 7). Recency comes from `ThreadView.lastActivityAt`. This is what keeps a comment write a single-record write. |
| 6 | Delete the first comment | Allowed. Thread, anchor, capture and remaining comments survive. **No thread write** (`updatedAt` unchanged), same as rule 5. Emits `comment:delete` with `threadDeleted: false`. |
| 7 | Delete the last remaining comment | Thread auto-deletes in the same operation. Emits `comment:delete` (`threadDeleted: true`) **then** `thread:delete` (`reason: 'empty'`). `DeleteCommentResult.threadDeleted === true`, `.thread === null`. |
| 8 | Delete a thread | Hard delete, cascades comments via `store.deleteThread`. Emits one `thread:delete` (`reason: 'explicit'`) carrying the full comment list, after the cascade resolves. Hosts cancel in-flight runs off this event. |
| 9 | Write to a deleted thread | `appendComment` / `resolve` / `reopen` / `editComment` reject with `thread_not_found` (or `comment_not_found`). No resurrection is possible: the domain never re-creates a thread from an append. |
| 10 | Resolve while a copilot run is in flight | `resolve` is unconditional; the later `appendComment({ author: 'copilot' })` lands under rule 4. No coordination needed. |
| 11 | Resolution actor | `resolve(threadId)` takes **no** `by` parameter. `resolvedBy` is always `'user'`. "The copilot may suggest, never execute" is enforced by the type — it is a sentence you cannot write. **Resolving an already-resolved thread is a no-op** that resolves with the unchanged thread, does not re-stamp `resolvedAt`, and emits nothing — the exact mirror of rule 12. (Rule 10's "unconditional" means "independent of any in-flight run", not "re-stamps".) |
| 12 | Reopen | `reopen` clears `resolvedAt` and `resolvedBy` **together** (CKEditor contract). Emits `thread:reopen` (`reason: 'explicit'`). Reopening an open thread is a no-op that resolves with the unchanged thread and emits nothing. |
| 13 | Comment edits | In-place; `editedAt` stamped; `body` replaced; **no thread write** (rule 5). No tombstones. Editing to an empty body rejects (`empty_body`). |
| 14 | Anchor element disappears | **No store write, ever.** Render-time orphan presentation only; auto re-attach when it returns. There is no field on `Thread` in which orphanhood could be written. **Engine-only row** — see the conformance note below the table. |
| 15 | Idempotent writes | Reusing `AppendCommentInput.id` (or `CreateThreadInput.id` / `.commentId`) is a **no-op** that returns the existing record with `deduped: true` and emits **no** event. This is what makes copilot delivery safe across service-worker restarts. |
| 16 | Unknown record version | A stored `Thread` (typed `StoredThread`, §2.7) whose `v` is not `THREAD_VERSION` is skipped from every list and from the live view, and is **never rewritten**. The domain reports it once per record per instance through `DomainOptions.onError`; the engine additionally emits `error`/`unsupported_version`. A thread that reads back with zero comments is skipped the same way (and GC'd per §4.3). |
| 17 | Kind | `kind` is opaque: the domain never reads it, never validates it against `modes`, and never branches on it. `startPlacement(kind)` with a kind not in `modes` returns false and emits `placement:rejected` (`reason: 'unknown_kind'`) **and** `error`/`unknown_kind`. **Engine-only row.** |

### 4.2 Event ordering guarantees

1. **Persist-then-notify.** No domain event is emitted for a write that did not land in the
   store. On store rejection: the imperative promise rejects, one `error` (phase `'store'`) is
   emitted, and the live view is left untouched (it never optimistically mutated).
2. **View-before-listeners.** Inside any listener, `engine.getThreadView(id)` and
   `engine.threads.get()` already reflect the event being delivered.
3. **First comment is `thread:create`, never `thread:reply`.** Exactly one of the two per
   comment, ever.
4. **State precedes content.** An auto-reopening human reply emits `thread:reopen`
   (`reason: 'reply'`) **then** `thread:reply`; both payloads carry the post-transition thread.
   A listener bound only to content events never observes a stale status.
5. **Deletion order.** `comment:delete` → (if last) `thread:delete` (`reason: 'empty'`).
   Explicit thread deletion emits only `thread:delete` (`reason: 'explicit'`).
6. **Anchoring batches.** Coalesced at `batchMs` (default 100) via `requestIdleCallback`.
   Within a batch: all `thread:orphaned` first, then all `thread:anchored`. **Transitions
   only** — no event when `AnchorStatus` and element are unchanged. `pending → orphaned` fires
   only after the first full-document pass completes, so a cold load never flashes orphans.
   **That pass is gated on a parsed document (normative).** The content script is registered at
   `document_start` and `autoStart` defaults to `true`, so `start()` normally runs against an
   empty `<html>`; a "first full pass" there would orphan every thread on every page load. When
   `document.readyState === 'loading'`, the engine loads threads and holds them in `pending`,
   and the first full-document pass — and with it the `pending → orphaned` gate and
   `ready()` — is deferred to `DOMContentLoaded`. Threads still anchor incrementally before
   then, via the MutationObserver, emitting only `thread:anchored`.
7. **Synchronous, snapshot-ordered emission.** Listeners run in registration order over a
   frozen list. Subscribing/unsubscribing during emission takes effect on the *next* emission.
   The `*` firehose receives each event **after** its typed listeners, with a per-engine
   monotonic `seq` starting at 1.
8. **Remote echoes.** Writes arriving via `store.subscribe` re-emit the same events with
   `source: 'remote'`, deduplicated against locally-originated writes by a **per-write origin
   token**, never by timestamps. Each engine holds an `instanceId` and a monotonic write
   counter; every write it performs is recorded in a bounded (500-entry) set of
   `{recordId, w}` tokens, where `w = \`${instanceId}:${n}\`` is written alongside the record
   by the store adapter's own key layout. An echo whose token is in the set is dropped once and
   the token retired. Wall-clock dedupe on `(id, updatedAt)` / `(id, editedAt ?? createdAt)` is
   **wrong**: two writes in the same millisecond — routine for a `resolve()` + auto-reopen
   sequence, and *guaranteed* under the spec-sanctioned `now: () => new Date(0)` test stub —
   collapse a genuine remote change into a "local echo" and silently drop another tab's edit,
   violating "`subscribe` must never under-notify". Guard trigger loops on `comment.author`
   (PLAN §8), never on `source`.
9. **Placement.** `placement:start` → (`picking`) → `composer` state visible in
   `engine.placement` → `placement:end`. `reason: 'placed'` fires **after** the
   `thread:create` / `thread:reply` for that submission, with `threadId` set.
   `reason: 'cancelled'` carries `threadId: null`.
10. **`page:change`** is emitted after the old page's threads are unloaded and the new set has
    completed its first resolution pass. `thread:anchored` for the new page always follows it.
11. **`destroy()`** stops the bus permanently, drops all listeners, disconnects the observer,
    stops navigation watching, and is idempotent. No event is emitted after it. There is no
    `engine:destroy` event — destruction is synchronous and observable from the return.
12. **Cross-context relay.** Every `StoreEventMap` event (§2.13) is structurally cloneable as
    emitted and relays forward it verbatim. Only the `EngineOnlyEventMap` events carry
    non-cloneable values — `payload.view` and `payload.element` on `thread:anchored` /
    `thread:click`, and the `CommentError` on `error` (whose own properties structured clone
    drops). Those must be projected before posting: `{ type, seq, at, payload }` with `view` /
    `element` replaced by `thread.id` and the error by
    `{ name, code, message, threadId, commentId }`. `lastRect` is a plain `DocumentRect` and
    clones fine.

### 4.3 Crash safety without `store.transaction`

`createThread` writes the **comment first, thread second**. A crash between them leaves an
orphan comment with no thread: invisible to every read path, and garbage-collected by the next
`list()` / engine load (which deletes comments whose `threadId` resolves to nothing). The
inverse order would leave an empty thread — a violation of the "empty thread cannot exist"
invariant. When `store.transaction` exists, both writes happen inside it and the question does
not arise.

Last-comment GC (`deleteComment` → `deleteThread`) uses the same ordering: comment first, then
thread. A crash between leaves an empty thread; the loader deletes any thread with zero
comments on read. Both GC passes are silent (no events).

### 4.4 Error behavior

* **Imperative calls reject** with `CommentError`. The underlying store failure is preserved on
  `.cause`. `resolve` / `reopen` / `appendComment` / `editComment` / `deleteComment` / `delete`
  on a missing record reject with `thread_not_found` / `comment_not_found`. This is deliberate:
  a silent no-op hides bugs in the 99% non-bridge case, and idempotency keys (§4.1 rule 15)
  already cover the redelivery case that a no-op was meant to solve.
* **Best-effort subsystems never throw.** Anchoring, the MutationObserver batch, the keyboard
  trigger, navigation watching, and listeners emit `error` and continue. A throwing listener
  cannot break the batch or the other listeners. Anchoring failure is not an error at all in
  the normal case — it produces `thread:orphaned`.
* **Error-loop breaker.** A listener that throws while handling `error` is routed to
  `options.onError`, then `console.error`. `error` never re-emits itself.
* **Post-`destroy()`** calls reject with `engine_destroyed`. `stop()`, `cancel()` and
  `destroy()` are always safe and idempotent.
* **No unhandled rejections.** Every internal promise the engine starts on its own initiative
  (anchoring passes, store reloads, remote-echo diffs) is `.catch`-ed into `error`.

### 4.5 Placement / trigger behavior

* Keyboard handling: capture-phase `keydown` on `window`, registered at `start()` (the
  extension registers the content script at `document_start`). The real focus element is read
  from `event.composedPath()[0]`, **not** the retargeted `event.target`.
* A bare-letter trigger is ignored when that element is `input`, `textarea`, or has
  `isContentEditable`. Triggers with any modifier bypass the guard.
* **Selection wins.** When a non-collapsed selection exists in the document at trigger time,
  `picking` is skipped entirely and a text-mode thread is composed on the selection's first
  range. This applies to `interaction: 'pick'` and `'hover'` alike.
* `interaction: 'pick'` → `placement:start` with `interaction: 'pick'`, phase `picking`,
  `candidate` updated on `mousemove` (throttled to one animation frame). Click places; `Esc`
  cancels; a second press of the same trigger key cancels.
* `interaction: 'hover'` → places immediately on the last element seen by the engine's
  `mouseover` tracker. No hovered element ⇒ returns false and emits `placement:rejected`
  (`reason: 'no_target'`) — a user-flow rejection, not an `error` (§2.12).
* `trigger: false` → no listener is attached for that mode; only `startPlacement(kind)` works.
  The `chrome.commands` backup shortcut (PLAN §3.3) is exactly this: the SW relays a message
  and the content script calls `engine.startPlacement(kind)`. There is no `TriggerAdapter`
  plugin interface.
* Two modes may not register the same `key` + `modifiers` combination; `createCommentEngine`
  and `setModes` throw `CommentError('invalid_options')` synchronously if they do.
* Placement is cancelled automatically on `page:change` and on `destroy()`.

### 4.6 Anchoring pipeline

1. `captureTarget` runs every strategy's `describe` (weight order), keeping non-null results as
   `AnchorDescriptor.selectors`, plus `fingerprintElement` and `captureElement`.
   **`anchoring.strategies` is one list used for both halves (normative):** the same strategy
   objects supply `describe` at capture time and `resolve` at anchoring time. A custom locator
   like §7.4's `x-row-id` is otherwise never written, only read. `capture.sanitize` /
   `redact` / `htmlLimit` / `textLimit` come from `CommentEngineOptions.capture`.
2. `resolveAnchor` runs strategies in weight order, `cheap` before `fuzzy`. Each candidate is
   **always** verified with `scoreCandidate` (tag match required; role/aria/data-* weighted
   above classes/structure; `textDigest` as final verifier). This is Hypothesis's
   `maybeAssertQuote` discipline as a property of the pipeline, not a per-strategy opt-in — a
   stale-but-valid CSS path can never silently attach to the wrong element.
3. First candidate at or above `threshold` (0.62) wins. Otherwise a fingerprint scan over the
   first `scanLimit` (500) same-tag elements in `root`. Below threshold ⇒ `null`.
4. Text mode additionally runs the vendored Hypothesis `TextQuote → TextPosition` chain with
   quote verification to produce `AnchorMatch.range`. A failed range with a successful element
   match yields `range: null` and `confidence` reduced by 0.15.
5. Engine loop: one shared `MutationObserver` (subtree, `childList` + `attributes`), debounced
   `batchMs` via `requestIdleCallback`. Removed nodes ⇒ affected threads go `orphaned` (record
   untouched). Added nodes ⇒ orphaned threads retried scoped to the added subtrees first
   (`cheap` strategies only), full-document retry when `rescanIdle` and the browser is idle.
   Per-thread `WeakRef<Element>` cache short-circuits an unchanged element.
6. **SPA navigation (normative): poll, do not patch.** `history.pushState` / `replaceState` are
   **not** patched. In an MV3 content script the isolated world has its own `history` binding,
   so a patch installed there never intercepts the page's own calls — `page:change` would
   silently never fire on exactly the React/Next apps M2 targets. Instead: `popstate` and
   `hashchange` are listened, and `location.href` is compared against the last seen value at
   the head of every anchoring batch (default 100 ms) and on every `mouseover`/`keydown` the
   engine already handles, so a URL change is observed within one batch with no extra timer.
   A host with a better signal (the SW relaying `chrome.webNavigation.onHistoryStateUpdated`,
   or a router hook) passes `navigation.source` and the poll is skipped entirely. A page-key
   change unloads the old thread set and loads the new one.

---

## 5. Internal module layout

### 5.1 `packages/comment-core/src`

| File | ~LOC | Contents |
|---|---|---|
| `index.ts` | 40 | Public barrel; re-exports `headless.ts` + `anchor/index.ts`. |
| `headless.ts` | 25 | DOM-free barrel (`comment-core/headless`): domain, stores, observe, page key, errors, DOM-free types. Its `.d.ts` must reference no `lib.dom` identifier. |
| `types.ts` | 140 | All domain / view / event / option types. Zero logic. |
| `errors.ts` | 60 | `CommentError`, codes, `is()`, `wrapStore()`. |
| `ids.ts` | 20 | nanoid(12) factory + injectable seam. |
| `readable.ts` | 45 | `ReadableStore` implementation + `writable()` internal. |
| `emitter.ts` | 95 | Typed bus: `on/once/off/subscribe`, seq, frozen snapshot iteration, listener isolation, error-loop breaker. |
| `domain/reduce.ts` | 150 | Pure reducers: append (auto-reopen), resolve, reopen, edit. Unit-test surface for §4.1. |
| `domain/index.ts` | 230 | `createDomain`: store IO, ordering, GC, idempotency, `CommentRef` resolution. |
| `domain/diff.ts` | 130 | Snapshot diff → `CommentEvent[]`; used by `observeStore` and the engine's remote path. |
| `observe.ts` | 110 | `observeStore`, durable cursor protocol, bounded diff, `createKeyValueCursor`. |
| `page-key.ts` | 80 | `defaultPageKey`, `createPageKey`, `volatileParams`. |
| `store/memory.ts` | 100 | `createMemoryStore` + counters + snapshot/restore. |
| `store/kv.ts` | 170 | `createKeyValueStore`, per-record key layout, namespace-filtered `watch` fan-out, quota mapping. |
| `store/local-storage.ts` | 70 | `createLocalStorageStore` over `kv.ts` + `storage` event. |
| `anchor/index.ts` | 45 | Anchor barrel. |
| `anchor/fingerprint.ts` | 150 | `fingerprintElement`, class filtering, attr subset, text digest. |
| `anchor/score.ts` | 120 | `scoreCandidate` weighting. |
| `anchor/capture.ts` | 120 | `captureElement`, sanitizer, truncation, cssPath. |
| `anchor/strategies/css.ts` | 60 | `@medv/finder` wrapper. |
| `anchor/strategies/attr.ts` | 80 | id / data-testid / aria-label / role+name. |
| `anchor/strategies/nth-path.ts` | 70 | Structural path. |
| `anchor/strategies/text-quote.ts` | 110 | Hypothesis + `approx-string-match`. |
| `anchor/strategies/text-position.ts` | 70 | Offset chain. |
| `anchor/strategies/index.ts` | 30 | `defaultStrategies`, `defineSelectorStrategy`. |
| `anchor/resolve.ts` | 200 | Strategy race, verification, scan fallback, budget, trace. |
| `anchor/target.ts` | 90 | `captureTarget`. |
| `anchor/vendor/hypothesis/**` | ~600 | Vendored BSD-2 `annotator/anchoring`. Never edited by hand. |
| `engine/index.ts` | 320 | `createCommentEngine`, view assembly, freezing, `inspect`, `explain`, `focus`. |
| `engine/anchoring.ts` | 230 | MutationObserver, batching, WeakRef cache, idle rescan, transition events. |
| `engine/placement.ts` | 220 | Modes, key handling, hover tracking, pick overlay state, composer state machine. |
| `engine/navigation.ts` | 75 | `location.href` poll + `popstate`/`hashchange` + injected source, page-key change. |
| `engine/remote.ts` | 90 | `store.subscribe` → reload → diff → origin-token dedupe → emit `source: 'remote'`. |
| `testing/index.ts` | 30 | Barrel. |
| `testing/store-conformance.ts` | 180 | ~50 cases. |
| `testing/domain-conformance.ts` | 220 | The 15 store-observable rows of §4.1. |
| `testing/engine-conformance.ts` | 90 | Rows 14 and 17 + DOM-dependent ordering rules. |
| `testing/test-page.ts` | 150 | happy-dom fixture. |

**Total: ~4,300 LOC + ~600 vendored.**

### 5.2 `packages/comment-ui/src`

| File | ~LOC | Contents |
|---|---|---|
| `index.ts` | 20 | Barrel: `mount`, `mountCommentUI`, types. |
| `mount.ts` | 140 | Lifecycle, subscriptions, decoration map, teardown. |
| `shadow.ts` | 80 | Open shadow root, isolateEvents, `:host` font-size, layer setup. |
| `styles.ts` | 230 | The single CSS string; all custom-property defaults. |
| `position.ts` | 90 | `@floating-ui/dom` + `autoUpdate` + `IntersectionObserver`. |
| `badge.ts` | 190 | Badge element, dock-when-orphaned, approximate marker, decoration, mode icon. |
| `picker.ts` | 120 | Placement-mode highlight overlay from `engine.placement`. |
| `composer.ts` | 200 | `popover` composer, textarea, Send/Dismiss, draft wiring. |
| `thread.ts` | 210 | Thread popover: comments, reply, resolve/reopen, delete, edit. |
| `panel.ts` | 210 | Corner panel: open / resolved / unanchored sections. |
| `labels.ts` | 50 | Default `Labels`. |
| `dom.ts` | 60 | Tiny `el()` helper, no framework. |

**Total: ~1,600 LOC.**

---

## 6. Extension-bridge contract (informative, but binding on the examples)

The bridge is the only place `comment-core` and `copilot` meet. Two seams carry it and neither
library ever names a platform:

* **`KeyValueAdapter`** — ~15 lines over `chrome.storage.local` + `chrome.storage.onChanged`
  gives a full `CommentStore` usable identically from the content script and the SW.
* **`observeStore`** — the SW gets `thread:create` / `thread:reply` by watching the same store,
  so the hook-forwarding messaging channel exists only for what is genuinely irreducible: DOM
  tools that must run in the page (PLAN §5 tool table). **In the SW it must be given a durable
  `cursor`** (§2.10): the write that wakes the worker happens before the worker exists, so an
  in-memory baseline would never see it.

**Key ranges on the shared adapter (binding).** One `KeyValueAdapter` carries three disjoint
namespaces and nothing else:

| Range | Owner | Contents |
|---|---|---|
| `exp-spec:*` | `comment-core` | thread and comment records |
| `runs:*` | `copilot` | run records, leases |
| `exp-spec:host:*` | **the bridge** | pending-dispatch set, thread→runId index, observe cursor, unread |

The third range is not optional bookkeeping. PLAN §5's default `manual` dispatch policy needs
the pending set to survive, and an MV3 service worker's memory does not survive 30 s of idle —
`markPending()` in worker memory loses it silently. The content script reads the same range on
mount to re-render its chips. Each store filters `watch` to its own prefix (§2.8), so the three
ranges never wake each other.

---

## 7. Examples

### 7.1 Quick start — demo page with an echo responder (7 lines)

```ts
import { createCommentEngine } from 'comment-core'
import { mountCommentUI } from 'comment-ui'

const engine = createCommentEngine() // localStorage, defaultPageKey, mode 'comment' on `c`
mountCommentUI(engine)

engine.on('thread:create', ({ thread, comment }) => {
  setTimeout(() => engine.appendComment(thread.id, { author: 'copilot', body: `echo: ${comment.body}` }), 800)
})
```

No build step at all:

```html
<script src="/comment-core.iife.js"></script>
<script src="/comment-ui.iife.js"></script>
<script>CommentsUI.mount()</script>
```

### 7.2 Extension bridge — content script

```ts
// entrypoints/content.ts (WXT, document_start)
import { createCommentEngine, createKeyValueStore, type KeyValueAdapter } from 'comment-core'
import { mountCommentUI } from 'comment-ui'
import { onMessage, sendMessage } from '@webext-core/messaging'

const kv: KeyValueAdapter = {
  get: (keys) => chrome.storage.local.get(keys as string[]),
  set: (entries) => chrome.storage.local.set(entries),
  remove: (keys) => chrome.storage.local.remove(keys as string[]),
  // Key-only, per §2.8: never `get(null)`, which would deserialize every capture and run record.
  keys: async (prefix) => (await chrome.storage.local.getKeys()).filter((k) => k.startsWith(prefix)),
  watch: (cb) => {
    const h = (changes: object, area: string) => { if (area === 'local') cb(Object.keys(changes)) }
    chrome.storage.onChanged.addListener(h)
    return () => chrome.storage.onChanged.removeListener(h)
  },
}

const engine = createCommentEngine({
  store: createKeyValueStore(kv, { namespace: 'exp-spec' }),
  modes: [
    { kind: 'comment', trigger: { key: 'c', interaction: 'pick' } },
    { kind: 'ask', trigger: { key: 'a', interaction: 'pick' }, badge: { icon: '?' } },
  ],
})
const ui = mountCommentUI(engine, { isolateEvents: true, rootFontSize: '16px' })

// chrome.commands backup (commands cannot bind a bare letter) — same entry point, no new API.
onMessage('trigger', ({ data }) => engine.startPlacement(data.kind))

// Options-page hotkey change (PLAN §4.6) — no remount, no lost state.
onMessage('modes', ({ data }) => engine.setModes(data.modes))

// Bridge-owned badge chrome. comment-ui has no idea what a copilot is.
onMessage('copilot:busy', ({ data }) =>
  ui.decorate(data.threadId, data.busy ? { chip: { text: 'copilot', tone: 'busy', spinner: true } } : null))
onMessage('copilot:pending', ({ data }) =>
  ui.decorate(data.threadId, { chip: { text: 'pending', tone: 'neutral' } }))
// A run that died three times must not look like a run that never happened.
onMessage('copilot:failed', ({ data }) =>
  ui.decorate(data.threadId, { chip: { text: data.code, tone: 'warn' }, title: 'copilot run failed' }))

// Chips are edge-driven, so re-derive them from durable state on every mount — otherwise a
// service-worker death between `busy: true` and `busy: false` leaves a chip spinning forever.
await engine.ready()
for (const threadId of await sendMessage('copilot:busyThreads', undefined))
  ui.decorate(threadId, { chip: { text: 'copilot', tone: 'busy', spinner: true } })
```

The DOM tools the SW calls back into are **not** here: they are `serveTools` in
SPEC-copilot §7.2, which is the single normative content-script tool half. Hand-rolling
`onMessage('tool:…')` handlers alongside it would collide on the same message keys and would
skip the arrival-side schema validation that §3.4 of that spec requires on both ends.

Note what is also **not** here: no `thread:create` → SW forwarding. The SW observes the same
store (§7.3), so hooks need no message channel.

### 7.3 Extension bridge — service worker (comment half)

```ts
// entrypoints/background.ts
// `comment-core/headless` — the root entry's types need lib.dom, which a SW tsconfig lacks.
import {
  createDomain, createKeyValueStore, createKeyValueCursor, observeStore,
} from 'comment-core/headless'
import { kv } from './kv'

const store = createKeyValueStore(kv, { namespace: 'exp-spec' })
const comments = createDomain(store) // same rules as the page engine, no DOM

// Hooks in the SW with zero messaging: chrome.storage.onChanged even wakes a dormant worker.
// The durable cursor is what makes that true — a fresh worker's in-memory baseline would be
// taken AFTER the write that woke it, and the create would be invisible.
observeStore(store, async (event) => {
  if (event.type !== 'thread:create' && event.type !== 'thread:reply') return
  const { thread, comment } = event.payload
  if (comment.author !== 'user') return // the author field is the ONLY trigger-loop guard
  await dispatch(thread, comment) // see SPEC-copilot §6; awaited, so a throw replays the event
}, { cursor: createKeyValueCursor(kv, { namespace: 'exp-spec:host', id: 'dispatch' }) })

observeStore(store, async (event) => {
  if (event.type === 'thread:delete') await cancelRunsForThread(event.payload.thread.id)
}, { cursor: createKeyValueCursor(kv, { namespace: 'exp-spec:host', id: 'cancel' }) })

// Writing a copilot reply from the SW with the tab closed. Store reactivity shows it on load.
export async function reply(threadId: string, body: string, runId: string) {
  if (!(await comments.get(threadId))) return // deleted mid-run → drop the output
  await comments.appendComment(threadId, { author: 'copilot', body, id: `r:${runId}` })
  // id is the idempotency key: a restarted run cannot double-post.
}
```

`cancelRunsForThread` is defined in SPEC-copilot §6: run ids are prefixed with the thread id,
so cancelling a thread's work is a prefix scan over `copilot.list({ state: [...] })`.

### 7.4 Advanced — virtualized table, custom locator, ask mode, React triage panel

```tsx
import {
  CommentError, createCommentEngine, createKeyValueStore, createPageKey,
  defaultStrategies, defineSelectorStrategy, type ThreadView,
} from 'comment-core'
import { mountCommentUI } from 'comment-ui'
import { useSyncExternalStore } from 'react'

// Rows are recycled, so nth-child and CSS paths lie. A row key is ground truth.
// `describe`'s return type IS the selector payload: `resolve` sees `{ type: 'x-row-id'; rowId: string }`.
const rowId = defineSelectorStrategy({
  type: 'x-row-id',
  weight: 120, // beats attr (90) and css (80)
  cost: 'cheap',
  describe: (target, { closest }) => {
    const row = closest(target, '[data-row-id]') as HTMLElement | null
    return row ? { rowId: row.dataset.rowId! } : null
  },
  resolve: (sel, { root }) => root.querySelector(`[data-row-id="${CSS.escape(sel.rowId)}"]`),
})

const engine = createCommentEngine({
  store: createKeyValueStore(dexieKv, { namespace: 'specs' }),
  pageKey: createPageKey({ keepParams: ['docId'], keepHash: true }),
  modes: [
    { kind: 'comment', trigger: { key: 'c' } },
    { kind: 'ask', trigger: { key: 'a', interaction: 'hover' }, badge: { icon: '?' } },
    { kind: 'triage', trigger: false }, // programmatic only
  ],
  // One strategy list, used for both describe (capture) and resolve (anchoring) — §4.6.1.
  anchoring: { strategies: [rowId, ...defaultStrategies], threshold: 0.72, scanLimit: 2000, batchMs: 60 },
  capture: { redact: (c) => ({ ...c, text: scrubPII(c.text) }), htmlLimit: 4096 },
  // Only faults reach here now: pressing the trigger twice emits `placement:rejected`, not `error`.
  onError: (e, phase) => report(e, phase),
})

mountCommentUI(engine, { badge: { orphaned: 'dock' }, css: '.cc-badge { font-weight: 600 }' })

// Low-confidence telemetry — one listener, no plugin system. `explain` returns the cached
// trace from the pass that just ran, so this costs nothing.
engine.on('thread:anchored', ({ thread, confidence }) => {
  if (confidence < 0.8) console.warn('approximate re-anchor', engine.explain(thread.id))
})

// ReadableStore → React. Hoisted out of the component: an inline `subscribe` closure makes
// React unsubscribe and resubscribe on every commit, and SSR/hydration throws without a
// server snapshot.
const EMPTY: readonly ThreadView[] = Object.freeze([])
const subscribeThreads = (cb: () => void) => engine.threads.subscribe(cb)
const getThreads = () => engine.threads.get()
const getServerThreads = () => EMPTY

function useThreads(): readonly ThreadView[] {
  return useSyncExternalStore(subscribeThreads, getThreads, getServerThreads)
}

function OrphanTriage() {
  const orphans = useThreads().filter((t) => t.isOrphaned && !t.isResolved)
  return (
    <ul>
      {orphans.map((t) => (
        <li key={t.id} title={t.capture.cssPath}>
          [{t.kind}] {t.lastComment.body} — was “{t.capture.text.slice(0, 60)}”
          {/* `delete` rejects with thread_not_found if a remote tab got there first: never float it. */}
          <button onClick={() => void engine.delete(t.id).catch((e) => report(e, 'store'))}>
            discard
          </button>
        </li>
      ))}
    </ul>
  )
}
```

### 7.5 Conformance in a host store

```ts
import { storeConformance, domainConformance, engineConformance } from 'comment-core/testing'
import { describe, it } from 'vitest'
import { chromeStore } from '../src/store'

describe('chrome.storage store', () => {
  for (const c of storeConformance(() => chromeStore())) it(c.name, c.run)
  for (const c of domainConformance(() => chromeStore())) it(c.name, c.run)
  // Rows 14 and 17 need a DOM; this suite drives createTestPage (happy-dom).
  for (const c of engineConformance(() => chromeStore())) it(c.name, c.run)
})
```

---

## 8. Decision log

| # | Contested point | Chosen | Rejected | Why |
|---|---|---|---|---|
| 1 | Where writes live | `CommentEngine extends CommentDomain` (A) | B's `apply(store, action)` with a read-only engine; C's Command bus + `dispatch` | PLAN §3.7 locks `engine.appendComment/resolve/reopen/delete`; B's shape deletes locked signatures. A's extension gives one interface, one implementation, two runtimes. |
| 2 | Domain rules location | `createDomain(store)` owns §3.5 once (A/C) | duplicating rules in engine + store helpers | Semantic drift here means a copilot resurrecting a resolved thread on an untested path. `domainConformance()` tests it once for both runtimes. |
| 3 | Store shape | Locked 9 methods + optional `transaction` (A/C) | B's 3-method `load/save/watch`; C's 6 capability interfaces + `probeStore` | PLAN §3.6 is locked. B's collapse is elegant but renegotiates a lock. C's zoo grows surface for zero PLAN requirement. Atomicity is solved by write ordering (§4.3) instead. |
| 4 | `resolve(threadId, by?)` | **No `by` parameter**; `resolvedBy` always `'user'` (B) | A's `by?: Author`; C's `by: Author` + `AuthorPolicy` | PLAN §3.5: "the copilot may suggest, never execute". Encoding it in the type makes the violation unwriteable rather than a runtime check that can regress. Best single idea in proposal B. |
| 5 | `author` defaulting | **Required** on create + append (B) | A's `author?: Author` defaulting to `'user'` | PLAN §8 names the author field as the sole trigger-loop guard. A defaultable guard is a forgettable guard. |
| 6 | Author extensibility | Locked `'user' \| 'copilot'` | A's `Register` module augmentation; C's `AuthorPolicy` | PLAN §3.5 locks the union. With two authors, `isHuman` is a constant — configuration with one sane value. |
| 7 | Derived state shape | `ThreadView extends Thread` (A) | B's nested `View { thread, comments, match }`; C's nested `LiveThread` | PLAN §3.7 pins `listThreads(): Thread[]`. Only the superset keeps that compiling. Frozen + referentially stable makes `===` memoization correct without selectors. |
| 8 | Orphanhood | `ThreadView.anchoring.status`, never persisted | any `Thread` field | PLAN §3.2/§3.5. There is deliberately no field in which it could be written. B's "`null` means gone" convention is preserved as `element: null` / `status: 'orphaned'`. |
| 9 | Event API | Typed map + `on/once/off/subscribe` (A) | B's single `on(handler)` over one union; C's `onAny` + `command:*` events | PLAN §3.7 locks `engine.on('thread:create', cb)` with named events. B's collapse (`status`, `anchor`) also erases the locked names `thread:resolve`/`reopen`/`anchored`/`orphaned`. |
| 10 | SW hooks transport | `observeStore(store, cb, { cursor })` — store-diff events over a durable cursor (B) | A/C's `@webext-core/messaging` forwarding of every hook | B's best structural idea: `chrome.storage.onChanged` fires in every context *and wakes a dormant SW*, so hooks need no channel. The cursor is what makes that survive the wake: an in-memory baseline is taken after the waking write and never sees it. Messaging survives only for DOM tools. Costs two exports. |
| 11 | Missing-record writes | **Reject** with `thread_not_found` (A/C) | B's silent `{}` no-op | Correctness/debuggability in the 99% non-bridge case. B's real target (redelivery safety) is met better by idempotency keys, which are explicit. |
| 12 | Idempotency | Caller-supplied `id` on create/append, `deduped: true` (C) | relying on the host to pre-check | PLAN §4.5's whole MV3 story is "restart from scratch, the host's append is idempotent". Making it a first-class input removes the guard from every call site. |
| 13 | Error model | One `CommentError` + code union + `static is()` (A) | C's 13 subclasses; B's zero error types | One class covers narrowing and serialization; subclasses buy nothing over `code`. Zero-errors loses rule 11. |
| 14 | Reactive primitive | `ReadableStore<T>` `{get, subscribe}` (A) | A's `select()` + `comment-core/react` subpath; C's `ViewModelStore` | The primitive is the seam; a React binding is four module-level constants at the call site (§7.4 — hoisted so React does not resubscribe every commit, with `getServerSnapshot` so SSR does not throw). A framework subpath adds a peer dep and an entry point for zero locked requirement. |
| 15 | Plugins / middleware | **None** | A's `defineCommentPlugin`; C's `CommandMiddleware`, `use()`, `registerCommand`, DI | `engine.on(...)` + `anchoring.strategies` cover every stated need. Middleware is a second execution plane, and PLAN has no interception requirement. Largest surface cut. |
| 16 | Undo / batch / streams / sidecars / store decorators | **None** (C only) | all of C §1.5/§1.6 | Nothing in PLAN asks for them; each is a new concept at tier 1 of the docs. Capability count is the lowest-priority tiebreaker. |
| 17 | Custom locators | `defineSelectorStrategy` + `x-*` namespaced selectors (A) | C's full `AnchorEngine` + `use()` registry; dropping extensibility entirely | PLAN §8 names virtualized lists as a known failure; a row-key strategy is the fix. It is opt-in via one option field and does not touch the entry surface. The `x-` prefix keeps builtin switches exhaustive. |
| 18 | Anchor introspection | `explainAnchor` + `engine.explain(id)` (A) | C's `AnchorTrace` + `onTrace` + `snapshot()`; no introspection | PLAN §3.8 makes the M2 bench table the main iteration loop; `threads.map((t) => engine.explain(t.id))` *is* that table. One method, no second API. |
| 19 | Capture API | `captureTarget()` returning `{anchor, capture}` (B's insight) | A's separate `describeAnchor` + `captureElement` at call sites | A thread never has one without the other; one call removes a class of bug. Both halves stay individually exported for the bench. |
| 20 | Trigger config | PLAN v2 `modes: Mode[]` with `kind` + `interaction: 'pick' \| 'hover'` | A's `TriggerOptions`/`TriggerAdapter`/`defineTrigger`; B's `key: string \| false`; C's `TriggerAdapter` | PLAN v2 §3.3/§3.5/§3.7 locks modes, `Thread.kind`, and `startPlacement(kind)` — all three proposals predate it. The `chrome.commands` backup is `startPlacement(kind)` from a message, so no adapter interface is needed. |
| 21 | Composer state | In core, exposed as `PlacementController extends ReadableStore` (A) | UI-owned composer state | Makes `comment-ui` a pure renderer, so the extension, the demo and a custom React host get byte-identical behavior. Placement and composition are one state machine, so they are one controller. |
| 22 | `comment-ui` surface | 2 functions + `decorate()` + CSS custom properties (B's theming) | A's `Slots`/`defineSlots`/`tokens`/`defineTheme`/`update()`; C's `Renderers` + `onUI` + `highlight` | PLAN §3.3 says "minimal, vanilla TS, framework-free". Custom properties inherit through shadow boundaries, so theming needs no JS API at all. `decorate()` is kept because PLAN §1 step 3 requires the "copilot thinking" chip and it keeps `comment-ui` copilot-ignorant. |
| 23 | Crash safety without transactions | Comment-first, thread-second + read-time GC (A) | thread-first; requiring `transaction` | The inverse order can create the empty thread the invariant forbids; this order can only create an invisible orphan comment. |
| 24 | Testing kit | Runner-agnostic `ConformanceCase[]` arrays (A) | C's `runStoreConformance(factory, { describe, it, expect })` | Passing the runner's globals in couples the kit to vitest; returning arrays works in vitest, node:test and bun with one `for` loop. |
| 25 | `inspect()` | Kept on the engine (A) | C's `snapshot()` + `metrics` + `EngineSnapshot` | One serializable method feeds the devtools panel and the options page. Two overlapping introspection APIs would not. |

---

## 9. Definition of done

* Every symbol in §2 and §3 is exported with exactly the listed signature.
* `domainConformance()` covers the 15 store-observable rows of §4.1 and `engineConformance()`
  covers rows 14 and 17; together they pass against `createMemoryStore`,
  `createLocalStorageStore` and the extension's `chrome.storage` adapter.
* `storeConformance()` passes against the same three.
* A CI test imports `comment-core` with `document`, `window`, `navigator`, `localStorage` and
  `chrome` deleted from `globalThis`, and asserts `createDomain`, `observeStore`,
  `createMemoryStore`, `createKeyValueStore` and `defaultPageKey` are callable.
* A CI test typechecks a fixture that imports `comment-core/headless` under
  `lib: ["ES2022", "WebWorker"]` (no `dom`) and calls `createDomain`, `observeStore`,
  `createKeyValueStore`, `createKeyValueCursor` and `defaultPageKey`. Runtime-global deletion
  is not enough: the failure this catches is a compile error, not a crash.
* A test kills and revives an `observeStore` consumer against a persisted cursor and asserts
  the write made while it was down is delivered exactly once on the next notification.
* `grep -rE "chrome\.|wxt/|from 'copilot'" packages/comment-core/src packages/comment-ui/src`
  returns nothing.
* Ordering rules §4.2.1–12 each have a named test.
* The IIFE bundle exposes `Comments` / `CommentsUI` and `CommentsUI.mount()` works on a bare
  HTML page with no build step.

---

## 10. Deferred review notes

Findings from the two adversarial reviews that were **not** applied to the body above. Each is
either not obviously right, or its fix would renegotiate a PLAN lock, or it is cosmetic churn
across a locked surface. They are recorded here so the next revision starts from the list
rather than from the reviews.

| # | Finding | Why deferred |
|---|---|---|
| D1 | *Model the author axis, not the actor: `Author = { id: string; human: boolean }`.* | The union is a PLAN §3.5 lock and decision log #6. **Partially applied instead:** the behavioural axis is now `DomainOptions.reopensOnReply`, and the coupling is documented in the preamble rather than hidden. Widening `Author` itself is a PLAN amendment, not a spec edit. |
| D2 | *`MatchVia` includes `` `x-${string}` `` so a `switch` over `via` can never be exhaustive.* | True, and inherent to the `x-` extension point (decision log #17). A `default:` arm is the intended shape. Revisit only if a `BuiltinMatchVia` alias earns its keep. |
| D3 | *Rename `engine.listThreads` → `views()` / `getView()`; align `engine.destroy(): void` with `copilot.destroy(): Promise<void>`.* | `listThreads` is a PLAN §3.7 locked name and `destroy()` being synchronous is §4.2.11's observable guarantee ("destruction is synchronous and observable from the return"). Renaming for symmetry with a sibling package is churn against two locks. |
| D4 | *Three unrelated `subscribe` signatures (`ReadableStore`, `CommentStore`, engine firehose).* | Each is locked or load-bearing on a different port. Cosmetic; no behavioural risk identified. |
| D5 | *Add `CommentUI.slot('panel-footer' \| 'page-corner', el)` for PLAN §5's batch pill.* | Decision log #22 rejects slots. **Addressed differently:** §3 now states normatively that host chrome is the host's own overlay, which is what the finding actually needs (a defined answer), without adding a rejected capability. |
| D6 | *Re-derive `timeoutMs` / offscreen guidance from MV3's 30 s idle timer rather than the removed 5-minute event cap.* | Belongs to SPEC-copilot §2.5/§3.6 and is marked PLAUSIBLE there; changing the default per-attempt wall clock is a tuning decision that wants a measurement, not an edit. Tracked in SPEC-copilot §10. |
