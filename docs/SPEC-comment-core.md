# SPEC — `comment-core` + `comment-ui` (LOCKED)

> **Status: LOCKED.** This document is the implementation contract. Every export, signature,
> default value, ordering rule and error path below is normative. Implementers must not make
> API decisions; if something appears underspecified, it is a spec bug — fix the spec, then
> the code. Converged from entropy+ proposals A (dx), B (minimal), C (capability) against
> `PLAN.md` v2. Decision log in §8. `comment-ui`'s presentation contract is §3.1 and its design
> system is `docs/DESIGN.md`, which is locked on the same terms as this document.
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

| Subpath | Contents | Runtime deps | IIFE global |
|---|---|---|---|
| `comment-ui` | controller + `domPresentation` (the default) | `comment-core`, `@floating-ui/dom` | `CommentsUI` |
| `comment-ui/presentation` | **types only** — the presentation seam (§3.1) | **none** | — |
| `comment-ui/glass` | `glassPresentation`, `glassStyles` (`docs/DESIGN.md`) | **none at runtime** | `CommentsUIGlass` |
| `comment-ui/glass.css` | the same sheet as a file | — | — |
| `comment-ui/testing` | `presentationConformance()` | `comment-ui`, `comment-core/testing` | — |

ESM + IIFE. The root entry depends on `comment-core` and `@floating-ui/dom`; **no other subpath
depends on either**, which is what makes the presentation seam of §3.1 enforceable by a grep
rather than by discipline.

**IIFE build contract (normative).** `comment-ui.iife.js` declares `comment-core` **external**
and reads it from `globalThis.Comments`; it never bundles its own copy. `comment-core.iife.js`
must therefore be loaded first (§7.1). Consequently `CommentError.is` is **brand-based** (a
non-enumerable `Symbol.for('comment-core.error')` marker plus the `code` field), never
`instanceof` — so it stays correct across bundle, realm and structured-clone boundaries.
`comment-ui-glass.iife.js` applies the same rule one level up: it declares `comment-ui` external
and reads `globalThis.CommentsUI`, so a bare page loads `comment-core` → `comment-ui` →
`comment-ui-glass` and never ships a second copy of anything.

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
  /**
   * Document-space rect of the target at capture time — the dock position of last resort
   * (decision log #29). `Anchoring.rect` is a live derivation and orphanhood is never a write,
   * so a thread that orphans on the FIRST pass after a cold load has no last-known position at
   * all. Written once, by `captureElement`, never updated. Additive and optional: a record
   * written before this field existed simply has none and behaves exactly as it did.
   */
  rect?: DocumentRect
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

/**
 * Fingerprint similarity, 0..1. Tag mismatch ⇒ 0. Semantics > classes > structure > text.
 *
 * That weight ordering governs the *average*; two rules govern what a component's mismatch
 * proves, and both can veto it (decision log #26, #27):
 *
 *  - **The text digest is the final verifier.** A candidate that no live identity signal
 *    confirms — no `id` and no attribute value that both matches AND is unique in the
 *    document — must score ≥ 0.90 on the digest (exact match or containment) or the whole
 *    candidate is refused. A candidate that IS identified is refused only on a total
 *    contradiction: two non-empty digests with no word in common.
 *  - **Regenerated evidence is absent, not contradicted.** An `id`/attribute the candidate
 *    carries under a *different* value scores 0.5 ("no information") when the stored value
 *    matches nothing anywhere in the document; a value the candidate does not carry at all
 *    still scores 0.
 *
 * `stableClasses` is compared by **coverage of the stored set** — extra classes on the live
 * element are not looked at, so a per-render hash or a `is-selected` state class costs nothing.
 */
export function scoreCandidate(element: Element, fingerprint: ElementFingerprint): number

/**
 * Build a fingerprint. A class is admitted as evidence only when it is **word-like** (finder v4
 * heuristics) **and corroborated** — carried by more than one element in the document
 * (decision log #28). Without a document (a detached node) only the word-like half applies.
 */
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
import type { CommentEngine, CommentEngineOptions, ReadableStore, ThreadView } from 'comment-core'
import type { Intents, Presentation, UIViewModel } from 'comment-ui/presentation'

/** Attach the shadow-root UI to an engine you already own. */
export function mountCommentUI(engine: CommentEngine, options?: CommentUIOptions): CommentUI

/**
 * The same lifecycle, plus the headless seam (§3.1): the controller owns all logic and state
 * and publishes a serializable `UIViewModel`; a `Presentation` is the only thing that draws.
 * `mountCommentUI` is this function with a narrower return type — one implementation, not two.
 */
export function createCommentUIController(
  engine: CommentEngine,
  options?: CommentUIOptions,
): CommentUIController

export interface CommentUIController extends CommentUI {
  /** The frozen, structured-cloneable view model. Notifies once per coalesced render. */
  readonly vm: ReadableStore<UIViewModel>
  /** Every write the UI can perform. All methods return `void` and never throw. */
  readonly intents: Intents
}

/** The default presentation: today's markup, class names and `commentUIStyles`. Frozen (§3.1.9). */
export function domPresentation(): Presentation

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
  /**
   * The presentation adapter (§3.1). Default `domPresentation()`. `null` mounts the controller
   * with **no** presentation — the shadow root, the layer and the `role="status"` region still
   * exist, and `vm` / `intents` still work. This is the one new field on this interface.
   */
  presentation?: Presentation | null
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
which thread popover is open (mirrored into `engine.active`), the host-supplied `decorate()` map,
the comment being edited inline, and the element focus returns to on close. Everything else is
read from `engine.threads`, `engine.placement` and `engine.modes`. It writes exclusively through
`CommentEngine` methods — it has no privileged path to the store.

*(The last two entries are a correction, not a widening: `editing` already lived in `thread.ts`
and `returnFocus` in `composer.ts` from the first implementation. §3.1 moves both into the
controller, where the other three already were, so that the list is exhaustive and one layer
owns all of it.)*

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

### 3.1 The presentation contract (normative)

`comment-ui` splits into a **headless controller** and an **injected presentation**. The
controller subscribes to the engine, owns every piece of logic and state named in §3, and
publishes a serializable `UIViewModel`. The presentation draws it. Total inverse DI: **the
presentation layer imports zero engine and zero domain code** — it sees only the types in
`comment-ui/presentation`, a module that imports nothing at all.

Everything §3 says about `comment-ui` still holds and is now the **controller's** obligation:
one open shadow root, the `pointer-events: none` layer, never mutating the host page, floating-ui
+ `autoUpdate`, the `IntersectionObserver` off-screen skip, `pending` renders nothing, the
`decorate()` lifecycle, the `Esc` chain, the a11y contract. A presentation cannot opt out of any
of it, because none of it is reachable from the presentation's surface.

#### 3.1.1 Entry points

| Subpath | Contents | Imports | IIFE global |
|---|---|---|---|
| `comment-ui` | `mount`, `mountCommentUI`, `createCommentUIController`, `domPresentation`, `commentUIStyles`, `defaultLabels` | `comment-core`, `@floating-ui/dom` | `CommentsUI` |
| `comment-ui/presentation` | **types only** — `UIViewModel` and every VM member, `Intents`, `Presentation`, `PresentationInstance`, `PresentationHost`, `Labels`, `PanelSection` | **nothing** | — |
| `comment-ui/glass` | `glassPresentation`, `glassStyles` | `comment-ui/presentation` (types, erased) — **nothing at runtime** | `CommentsUIGlass` |
| `comment-ui/glass.css` | `dist/comment-ui-glass.css`, byte-identical to `glassStyles` | — | — |
| `comment-ui/testing` | `presentationConformance(): ConformanceCase[]` | `comment-ui`, `comment-core/testing` | — |

`comment-ui/presentation` emits declarations that reference no identifier from `comment-core`,
`comment-ui` or `@floating-ui/dom`. It may reference `lib.dom` (`ShadowRoot`, `HTMLElement`,
`Document`, `Window`) — `comment-ui` is a DOM renderer and pretending otherwise buys nothing. A CI
test greps the emitted `.d.ts` for `import` and expects none.

`comment-ui-glass.iife.js` declares `comment-ui` **external** and reads it from
`globalThis.CommentsUI`, exactly as `comment-ui.iife.js` does for `Comments` (§1.2). Load order
for a bare page is `comment-core` → `comment-ui` → `comment-ui-glass`.

#### 3.1.2 The view model

```ts
// comment-ui/presentation — this module imports nothing.

export type PanelSection = 'open' | 'resolved' | 'unanchored'
export type AnchorState = 'pending' | 'anchored' | 'orphaned'
export type ChipTone = 'neutral' | 'info' | 'busy' | 'warn' | 'danger'

export interface Rect { readonly x: number; readonly y: number
                        readonly width: number; readonly height: number }

export interface ChipVM { readonly text: string; readonly tone: ChipTone; readonly spinner: boolean }

export interface BadgeVM {
  readonly threadId: string
  readonly kind: string
  /** `Mode.badge.label`, else the raw kind. Already resolved — the presentation never sees `Mode`. */
  readonly label: string
  /** `Mode.badge.icon` when the host supplied one, else `null`: draw your own glyph. */
  readonly icon: string | null
  readonly count: number
  readonly anchor: AnchorState
  readonly resolved: boolean
  readonly orphaned: boolean
  readonly approximate: boolean
  /** Positioned from `capture.rect`, not from a live element. */
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
  /** floating-ui's resolved placement, so a morph can grow out of its anchor. */
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
  /** `capture.text`, first 160 chars, for orphans only. Else `null`. */
  readonly quote: string | null
  readonly chip: ChipVM | null
  readonly comments: readonly CommentVM[]
  readonly actions: { readonly reply: boolean; readonly resolve: boolean
                      readonly reopen: boolean; readonly delete: boolean }
}

export interface ComposerVM {
  readonly kind: string
  readonly draft: string
  /** `placement.phase === 'submitting'`. */
  readonly busy: boolean
  readonly replyTo: string | null
  readonly canSubmit: boolean
  readonly placeholder: string
}

export interface PickerVM { readonly kind: string; readonly rect: Rect | null; readonly hint: string }

export interface PanelRowVM {
  readonly threadId: string; readonly kind: string; readonly label: string
  readonly ariaLabel: string; readonly body: string; readonly count: number
  readonly anchor: AnchorState; readonly approximate: boolean; readonly status: string
  readonly title: string; readonly chip: ChipVM | null
  readonly action: 'reopen' | 'delete' | null
}

export interface PanelSectionVM {
  readonly id: PanelSection; readonly label: string; readonly empty: string
  readonly current: boolean; readonly rows: readonly PanelRowVM[]
}

export interface PanelVM {
  readonly open: boolean; readonly title: string
  readonly corner: 'br' | 'bl' | 'tr' | 'tl'
  readonly total: number; readonly sections: readonly PanelSectionVM[]
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
   * A presentation has no mode list, so the *index* of a kind is the one fact about modes it
   * cannot re-derive, and a per-mode hue or ordinal is exactly that fact (decision log #41,
   * `docs/DESIGN.md` §2.3).
   */
  readonly kinds: readonly string[]
  readonly badges: readonly BadgeVM[]
  readonly thread: ThreadVM | null
  readonly composer: ComposerVM | null
  readonly picker: PickerVM | null
  /** `null` when `panel.enabled` is false. */
  readonly panel: PanelVM | null
  /** What the controller wants announced; `''` clears the region. */
  readonly announce: string
  /** Apply when `focus.seq` changes; idempotent. `null` means "nothing to do". */
  readonly focus: { readonly seq: number; readonly target: FocusTarget } | null
}
```

**Normative properties of the model.**

* **Serializable.** `structuredClone(vm)` succeeds: no functions, no DOM nodes, no `Element`, no
  `Range`, no class instances. This is what makes a worker-, iframe- or wire-hosted presentation
  possible, and it is what forces the controller to keep the DOM on its own side.
* **Frozen.** Every object and array is `Object.freeze`d, recursively.
* **Referentially stable.** A member that did not change is the same object identity between
  publications, so `===` memoization in a presentation is correct without selectors — the same
  rule `ThreadView` already lives under (decision log #7).
* **Ordered.** `badges` follows document order of the anchored elements (docked orphans last, by
  creation time). `comments` is oldest-first. `sections` is `CommentUIOptions.panel.sections`
  order. `rows` is engine order within a section.
* **Total.** A presentation that renders `vm` and nothing else is a complete UI. There is no
  second channel, no escape hatch, and no way to reach the engine.
* **Pre-resolved.** Mode labels, `aria-label`s, chip tone/spinner defaults, the 160-char quote
  truncation, section assignment, `approximate` (`confidence < 0.85`) and every visibility rule of
  §3 are computed by the controller. A presentation that re-derives any of them is wrong by
  construction, because it cannot: it has no `Mode`, no `ThreadView` and no `engine`.

#### 3.1.3 Intents

```ts
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

  /** The §3 Esc chain, in one call. Returns true when the controller consumed it. */
  escape(): boolean
  /** Route a presentation-side fault into `CommentUIOptions.onError`. */
  error(error: unknown): void
}
```

**Every method returns `void`** (`escape` returns `boolean`), **never throws, and is safe to call
in any state** — an intent fired against stale state is a documented no-op, not an error. Promise
rejections from the engine are routed to `CommentUIOptions.onError` by the controller, so a
presentation never handles a promise and never needs `try`/`catch`. This is the property that
makes a presentation writable in any language or framework binding.

`deleteThread` performs the focus dance of §3 itself (close without restoring focus, choose the
fallback before the write, apply it after it lands). A presentation must not attempt it.

#### 3.1.4 `Presentation`, `PresentationInstance`, `PresentationHost`

```ts
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
```

**Lifecycle, normative.**

1. `createCommentUIController` builds the layer, injects `:host` vars, then `presentation.css`,
   then `CommentUIOptions.css`, then calls `create(host, intents)` exactly once.
2. The first `update(vm)` is **synchronous**, inside `createCommentUIController`, before it
   returns — matching today's `render()` at mount.
3. Every subsequent `update(vm)` is on the coalesced microtask, one per publication, with
   `vm.seq` strictly increasing.
4. `unmount()` calls `instance.destroy()` **before** tearing down the layer, then removes the
   host element. `update` is never called after `destroy`.
5. A throw from `create` or `update` is caught, routed to `onError`, and the render pass is
   abandoned — a presentation fault must never break the host page or the engine.
6. `update` / `destroy` live on the **instance**, not on the `Presentation` object, so one
   `Presentation` value can be mounted more than once (two engines, two iframes, a test matrix)
   without a shared-state bug that a top-level `update` would silently create.

#### 3.1.5 Positioning — the coordinate contract

The **controller** owns `@floating-ui/dom`, `autoUpdate({ flip, shift, animationFrame })`, the
`IntersectionObserver` off-screen skip, the docked-orphan reference and the `data-picking`
click-through attribute on the layer. For every node registered through `host.anchor()` it writes
`style.left` / `style.top` and the `data-placement` attribute.

Therefore, normatively:

* A presentation **must not** write `left`, `top`, `width` or `height` on any node it registered
  through `host.anchor()`, and must not attach its own `autoUpdate`.
* `transform`, `translate`, `scale`, `rotate`, `opacity`, `filter`, `clip-path` and `mask` on
  those nodes are **entirely the presentation's**, with zero conflict.
* The picker overlay is **not** an anchored node — it is positioned by the presentation from
  `PickerVM.rect`, because the controller already has the candidate rect and floating-ui adds
  nothing to a rect that is recomputed every frame anyway.
* `data-picking` is written by the controller, never by a presentation: it is a pointer-events
  safety invariant (§3, the `composedPath()[0]` hazard), not a style choice.

#### 3.1.6 Focus

Focus **policy** is the controller's; focus **execution** is split. The controller focuses
elements it captured itself (the host page element that had focus at trigger time). It asks the
presentation for its own nodes via `vm.focus`: apply the target whenever `focus.seq` changes, then
do nothing until it changes again. `seq` is monotonic and idempotent, so a re-render cannot
re-steal focus and a presentation needs no acknowledgement channel.

The a11y contract of §3 is unchanged and is enforced by `presentationConformance()`: the composer
moves focus to its textarea on open and returns it on close, badges are real `<button>`s with
`aria-label` and `aria-expanded`, the panel is a `<section>` named by `Labels.panelTitle` with
heading-labelled lists, chips live in an `aria-live="polite"` region, and placement announces
`Labels.pickHint` through `host.announce`.

#### 3.1.7 Backward compatibility

`mount()` and `mountCommentUI()` keep their **exact outer signatures and return types**. The
default presentation is `domPresentation()`, whose markup, class names, attributes and stylesheet
are byte-identical to today's. **A host that upgrades and changes nothing sees no visual change,
no DOM change and no API change.** This was cheap, so there is no breaking ruling to record for
the mount surface.

Three additive changes are recorded instead (decision log #36, #37):

* `CommentUIOptions` gains one optional field, `presentation`.
* The root barrel gains two runtime names, `createCommentUIController` and `domPresentation`, so
  the §9 DoD assertion on the IIFE's exported key list becomes
  `['commentUIStyles', 'createCommentUIController', 'defaultLabels', 'domPresentation', 'mount', 'mountCommentUI']`.
* `Labels` and `PanelSection` **declarations** move to `comment-ui/presentation` and are
  re-exported from the root unchanged. Structurally identical, so no consumer changes.

#### 3.1.8 Shipped presentations

| Name | Subpath | Governed by | Status |
|---|---|---|---|
| `domPresentation` | `comment-ui` (default) | this document | **Frozen.** Bug and a11y fixes only. No new class names, no design changes. Removed at 1.0 at the earliest, and only with a deprecation cycle. |
| `glassPresentation` | `comment-ui/glass` | `docs/DESIGN.md` | Active. The product's intended appearance; the extension, the demo and the options page opt in with `presentation: glassPresentation()`. |

**The eleven `--cc-*` property names are the theming surface for every presentation. Their
*default values* are per-presentation:** `domPresentation` keeps §3's table verbatim;
`glassPresentation` ships the OKLCH defaults of DESIGN.md §2.1. Both obey the same two rules —
read as `var(--cc-x, <default>)`, never declared on `:host` — and the existing `styles.test.ts`
property-contract assertions run against **both** sheets.

`glassPresentation(options?)` takes one optional bag, and it is not part of the theming surface:
`{ reduceMotion?: boolean; polarity?: 'auto' | 'light' | 'dark'; icons?: 'sprite' | 'none' }`.
Each is a *rendering* choice with a defensible default (`auto`, `auto`, `'sprite'`), and none of
them is reachable from the controller.

#### 3.1.9 Conformance and the test migration

`comment-ui/testing` exports `presentationConformance(): ConformanceCase[]` — runner-agnostic
arrays, the same shape as `storeConformance` / `domainConformance` (decision log #24), so it works
in vitest, `node:test` and bun with one `for` loop. It is the executable form of "themes are
swappable at mount": every case mounts the presentation under test against a `createTestPage`
engine and asserts contract-level behaviour only — never a class name, never a selector that is
not part of the a11y contract.

The 135 committed-green `comment-ui` tests migrate as follows. **Nothing is deleted; the split is
by what each test was actually about.**

| Today | Cases | Where they go |
|---|---|---|
| `mount.test.ts` | 10 | 10 → controller (lifecycle, teardown, `onError` isolation, the `presentation: null` path) |
| `decorate.test.ts` | 11 | 11 → controller (`vm.badges[i].chip`, the drop-on-delete / clear-on-page-change lifecycle) |
| `panel.test.ts` | 15 | 11 → controller (`vm.panel` sections, totals, exclusivity, `scrollIntoView` intent) · 4 → conformance |
| `picker.test.ts` | 7 | 5 → controller (`vm.picker`, `data-picking`, the announce string) · 2 → conformance |
| `badge.test.ts` | 16 | 11 → controller (visibility rules, marks, tone, `aria-label` composition) · 5 → conformance |
| `composer.test.ts` | 16 | 10 → controller (draft, submit, cancel, busy, reply anchoring choice) · 6 → conformance (focus trap, `⌘↵`, `Esc`) |
| `thread.test.ts` | 16 | 10 → controller (comments, edit state machine, resolve/reopen/delete intents) · 6 → conformance |
| `a11y.test.ts` | 10 | 10 → conformance (this file *is* the presentation contract's a11y half) |
| `badge-tracking.test.ts` | 4 | 4 → controller (the tracker/observer lifecycle is controller-owned) |
| `renderer.test.ts` | 10 | 10 → controller (coalescing, idempotency, referential stability of the VM) |
| `styles.test.ts` | 10 | 6 parameterised over **both** sheets (property contract, no-declaration, rem-free, `all: initial`) · 4 stay label tests |
| `dod-bundle.test.ts` | 9 (+1 generated) | stays, +3 rows: the `/glass` IIFE reads `globalThis.CommentsUI`; `comment-ui-glass.css` is byte-identical to `glassStyles`; `comment-ui/presentation`'s `.d.ts` contains no `import` |

Net: **72 controller cases, 27 conformance cases × 2 presentations = 54 executions, 4 label
tests, 13 build/DoD cases** — 143 executions from 103 case definitions, against 135 today. The
suite gets *more* coverage from *fewer* definitions, because the 27 conformance cases run twice.

Two migration rules are normative, because they are what keeps the migration honest:

1. **A controller test may not touch the shadow root.** It mounts with `presentation: null`,
   drives `intents`, and asserts on `vm`. If a test needs a DOM node to say what it means, it is
   a conformance test, not a controller test.
2. **A conformance case may not assert a class name.** It may assert roles, `aria-*`, `<button>`,
   focus location, and that a node registered through `host.anchor()` received `left`/`top`.
   Anything else is `domPresentation`-specific and belongs in the four remaining
   `dom-presentation.test.ts` cases that exist precisely to pin the frozen markup.

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
   **"Final verifier" is a veto, not a weight (normative).** A candidate no live identity signal
   confirms is refused outright below a 0.90 digest similarity, whatever the other components
   say; a candidate that is identified is refused on a total text contradiction. The bench's F2
   is the case this exists for: `class` and `rect` are shared by every card of a templated feed,
   so without the veto they carried a *different* post to 0.946 and the badge moved to it.
   Resolution asks the document at most `1 + min(attrs, 8)` questions per resolve — "does this
   stored id / attribute value still match anything?" — and shares the answers across every
   candidate of that resolve, including all `scanLimit` of the scan.
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
   **The orphan dock (normative).** An orphaned thread keeps the last `Anchoring.rect` it had;
   a thread that orphans with no rect at all — the first pass after a cold load, where the
   element was already absent — docks at `capture.rect` instead. Both are reads: orphanhood is
   still never a write (§4.1 row 14). Only a record captured before `ElementCapture.rect`
   existed can end up with `rect: null`, and comment-ui draws no badge for it.
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
| `anchor/fingerprint.ts` | 175 | `fingerprintElement`, word-like + corroborated class filtering, attr subset, text digest. |
| `anchor/score.ts` | 275 | `scoreCandidate` weighting, the text verifier (#26), the evidence index (#27). |
| `anchor/capture.ts` | 130 | `captureElement`, sanitizer, truncation, cssPath, dock rect. |
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
| `index.ts` | 30 | Barrel: `mount`, `mountCommentUI`, `createCommentUIController`, `domPresentation`, `commentUIStyles`, `defaultLabels`, types. |
| `presentation.ts` | 220 | **`comment-ui/presentation`.** Types only, zero imports: `UIViewModel` + members, `Intents`, `Presentation`, `PresentationInstance`, `PresentationHost`, `Labels`, `PanelSection`. |
| `controller/index.ts` | 200 | `createCommentUIController`: lifecycle, subscriptions, decoration map, the five state slots, teardown, presentation lifecycle + fault isolation. |
| `controller/model.ts` | 260 | `engine.threads`/`placement`/`modes` + state → frozen, referentially stable `UIViewModel`. All §3 visibility, section and label rules live here, once. |
| `controller/intents.ts` | 120 | The `Intents` implementation. Every engine promise's rejection routed to `onError`; every method a no-op against stale state. |
| `controller/focus.ts` | 70 | Focus policy, the `vm.focus` seq, the Esc chain, the delete focus dance. |
| `shadow.ts` | 90 | Open shadow root, isolateEvents, `:host` vars, layer + `role="status"` setup, sheet ordering. |
| `position.ts` | 130 | `@floating-ui/dom` + `autoUpdate` + `IntersectionObserver` + `host.anchor()` registry + `data-placement` + `data-picking`. |
| `dom.ts` | 60 | Tiny `el()` helper, no framework. Shared by both presentations. |
| `labels.ts` | 50 | Default `Labels`. |
| `presentations/dom/*.ts` | 700 | `domPresentation` — today's `badge`/`picker`/`composer`/`thread`/`panel`/`chip` markup, verbatim. **Frozen.** |
| `presentations/dom/styles.ts` | 230 | `commentUIStyles`. **Frozen.** |
| `presentations/glass/*.ts` | 520 | `glassPresentation` per `docs/DESIGN.md`: surfaces, icon sprite, intent tracker, motion helpers. |
| `presentations/glass/styles.ts` | 380 | `glassStyles`. |
| `testing/index.ts` | 20 | `comment-ui/testing` barrel. |
| `testing/presentation-conformance.ts` | 240 | The 27 contract-level cases of §3.1.9. |

**Total: ~3,300 LOC**, of which ~930 is the frozen default presentation and ~900 the glass one.
The controller — the part that can be wrong in a way a user notices — is ~650.

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
| `exp-spec:host:*` | **the bridge** | pending-dispatch set, observe cursors, unread, failed, settings |

The third range is not optional bookkeeping. PLAN §5's default `manual` dispatch policy needs
the pending set to survive, and an MV3 service worker's memory does not survive 30 s of idle —
`markPending()` in worker memory loses it silently. The content script reads the same range on
mount to re-render its chips. Each store filters `watch` to its own prefix (§2.8), so the three
ranges never wake each other.

It holds no thread→run index. One was specified here and built; it is deleted (SPEC-copilot
§8.2 D11). Every question it answered is a projection of
`copilot.list({ state: ['queued', 'processing'] })` over `run.context` — the same durability, in
the range that already owns run records, with no second write path to fall out of step.

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
| 26 | The `textDigest`'s role in `scoreCandidate` | **Final verifier (a veto), in two tiers**: a candidate no live identity signal confirms needs ≥ 0.90 digest similarity (exact or containment) or is refused; an identified candidate is refused only on a total contradiction (two non-empty digests, no shared word) | leaving it a fifth weighted contribution at 0.12; requiring a margin over the runner-up; raising the global `threshold` | §4.6.2 already called it "the final verifier" and the code made it 0.12 of a weighted average, so it could never refuse anything. Bench F2: after a feed was trimmed, `stableClasses` + `rectHint` — identical for every card of a templated list — supplied 0.38 of the 0.50 available weight and carried the thread to a **different post at 0.946**, accepted at thresholds 0.62/0.85/0.9 alike. A margin rule does not help (0.946 vs 0.797 is a wide margin); raising the threshold breaks every honest low-signal anchor. The cost is explicit: an element with **no** id/attrs whose prose was substantially rewritten now orphans instead of re-anchoring approximately — the direction PLAN §3.1 demands. |
| 27 | A regenerated `id` / attribute value | **No information (0.5), not a mismatch** — but only when the candidate carries the attribute under a *different* value AND the stored value matches nothing in the document | scoring it 0 / 0.25 unconditionally (the old rule); dropping volatile-looking values at capture with finder's `idName`/`attr` word-like tests | Bench F3: a paragraph whose text was byte-identical scored 0.575 and orphaned because React regenerated four bookkeeping attributes — an element cannot be "not itself" on the strength of a value that now identifies nothing. Capture-side filtering was rejected because finder's word-like test also throws away every legitimate value containing a digit (`data-testid="row-3"`, `href="/docs/page-2"`), which is a much larger loss of discrimination. The rescue is deliberately narrow: an attribute the candidate does not carry **at all** still scores 0, so "the app stopped emitting it" is not confused with "the app renamed it". Residual risk, accepted and recorded: two elements with byte-identical text and per-element ids, where the anchored one was deleted, now match the survivor. |
| 28 | What makes a class stable evidence | **Word-like AND corroborated** — carried by a second element in the document — at capture; **coverage of that vetted set** (not a symmetric Jaccard) at resolve | word-like alone (finder v4, the old rule); filtering the live class list at resolve; "survive a second observation" over time | Bench F4 measured `css-<base36×6>` passing finder's word-like test **5.8 %** of the time, and such a class is unique in the document by construction. One render in seventeen therefore baked a per-render-random class into the fingerprint, and the symmetric Jaccard punished the *live* element for carrying new ones — `attribute-churn` scored 5/6, 4/6, 4/6, 2/6 over four runs of the same scenario. Corroboration is the cheapest signal that separates a hash from `card`; coverage makes the resolve side ignore new classes entirely, which also stops a `is-selected` state class from costing anything. The cost: a genuinely singleton semantic class (`sidebar`) is no longer evidence. Classes are 0.22 and, since #26, never decisive on their own — a fair trade for a deterministic anchor. |
| 29 | Where an orphan's dock position comes from after a reload | **`ElementCapture.rect`** — additive optional field, written once at capture, read only when a thread orphans with no live rect | persisting `Anchoring.rect` on every pass; docking to the panel edge; narrowing PLAN §3.3's claim to warm orphans | PLAN §3.3 promises "dimmed badge docked at last-known position". Bench F1: after a reload with the anchor element absent, `anchoring.rect` was `null` — the rect is a live derivation and orphanhood is never persisted (§4.1 row 14) — so comment-ui drew **no badge at all**. Persisting the live rect would make orphaning a write and break the property the popover scenario asserts on raw bytes; docking to the panel edge answers a different question ("where is the panel") than the one PLAN asks ("where was it"). Capture time is the one moment the element is guaranteed present, and one field on a snapshot type that already exists to survive the element is the smallest correct place for it. |
| 30 | `comment-ui`'s internal shape | **Headless controller + injected presentation.** The controller subscribes to the engine, owns all logic and the five state slots, and publishes a serializable `UIViewModel`; a `Presentation` draws it and nothing else | keeping one monolithic renderer; a `Renderers` map per widget (proposal C, rejected as #22); slots (#22, D5) | This is not the slot system #22 rejected, and the distinction is the whole argument. Slots let a host *inject into* our renderer, which is a second execution plane inside our DOM. This replaces the renderer wholesale behind a contract the host cannot partially occupy. The forcing reason is that we now ship **two** appearances (`domPresentation`, `glassPresentation`) and a third-party could ship a React or canvas one; without the split, every design decision in `docs/DESIGN.md` would be a fork of the logic that took 135 tests to get right. The split makes the logic testable without a DOM and the pixels swappable without touching it. |
| 31 | What crosses the seam | **A frozen, structured-cloneable `UIViewModel` + an `Intents` interface whose every method returns `void` and never throws**, both declared in `comment-ui/presentation`, a module that imports **nothing** | passing `ThreadView[]` / `PlacementState` / the engine straight through; a callback bag; an event emitter | Total inverse DI was the requirement: the presentation must not be able to reach the engine, the store or the domain types, because anything it *can* reach it will eventually depend on, and then a theme is a fork. Serializability is the enforcement mechanism — it is impossible to smuggle an `Element` or a method through `structuredClone`, so the rule tests itself. The `void`-only, never-throws intent surface is what makes a presentation writable with no promise handling and no error plumbing, which is the difference between "a theme" and "a port". |
| 32 | Where `update` / `destroy` live | **On `PresentationInstance`**, returned by `create(host, intents)` | the brief's literal `{ create, update, destroy }` flat shape | A flat shape forces one `Presentation` value to hold the state of every mount it is used for. Two engines on one page, an iframe matrix, or a conformance suite that mounts the same presentation 27 times would share it silently. Instance-per-mount costs one closure and removes an entire class of bug. Recorded as a deliberate refinement of the brief. |
| 33 | Whether the mount surface breaks | **It does not.** `mount()` / `mountCommentUI()` keep their exact outer signatures and return types; `presentation` is one optional field on `CommentUIOptions`, defaulting to `domPresentation()` | a new `mountWith(engine, presentation, options)`; making `glassPresentation` the default | Backward compatibility was cheap here, so the breaking ruling is simply not needed. And the default stays `domPresentation` because a design change is not something a patch upgrade should perform on a host's users: the glass appearance is opt-in, one field, and the extension / demo / options page take it. |
| 34 | Who positions | **The controller**, exclusively: floating-ui, `autoUpdate`, the `IntersectionObserver` skip, `left`/`top`, `data-placement`, `data-picking`. A presentation registers nodes through `host.anchor(key, node)` and never writes a layout property on them | letting each presentation own its own positioning; passing rects only | Positioning is logic (it decides *where a thing is*, and it is the part that regressed against real pages in the bench), not appearance. Splitting it per presentation would fork the one part of this package that took a benchmark suite to make correct. The corollary is the gift: `transform`/`opacity`/`clip-path` on those same nodes are then entirely the presentation's, with zero conflict, which is why `docs/DESIGN.md`'s whole motion catalog needs no coordination. |
| 35 | Focus | **Policy in the controller, execution split**: the controller focuses elements it captured itself; presentation-owned nodes are named by `vm.focus` with a monotonic `seq` the presentation applies idempotently | a `focus(node)` callback on the host; letting the presentation own the return-focus element | The §3 a11y contract is normative and must be identical across presentations, so its *policy* cannot live in a swappable layer. A monotonic seq is the smallest thing that survives re-renders without an acknowledgement channel, and it keeps `vm` serializable — a node reference would not. |
| 36 | Export surface growth | **+2 root runtime names** (`createCommentUIController`, `domPresentation`), **+3 subpaths** (`/presentation` types-only, `/glass` + `/glass.css`, `/testing`), **+1 IIFE** (`CommentsUIGlass`, reading `globalThis.CommentsUI` as an external) | one flat root export of everything; a separate `@astrale-os/comment-ui-glass` package | The types module must be separately importable or the "zero engine code" rule is unenforceable. `/glass` must be separate or the default bundle pays 7.5 KB gz for an appearance most consumers never select. `/testing` mirrors `comment-core/testing` (#24) and is what makes "themes are swappable" executable instead of claimed. A second npm package was rejected: it would version-skew against the contract it implements. The §9 DoD's exact exported-key assertion is amended in the same commit. |
| 37 | `Labels` / `PanelSection` declarations | **Moved into `comment-ui/presentation`, re-exported from the root** | duplicating the 17-key interface in both modules; passing labels as `Record<string, string>` | The VM carries the resolved labels, so the types module needs the interface; duplicating a locked 17-key interface is how the two copies drift. Structurally identical and still exported from the root, so no consumer changes and no test changes. |
| 38 | What happens to the 135 tests | **72 controller cases (no shadow root) + 27 conformance cases run against both presentations + 4 label + 13 build/DoD**, per §3.1.9's table. Two normative rules: a controller test may not touch the shadow root; a conformance case may not assert a class name | rewriting the suite against the glass DOM; keeping every test on `domPresentation` and testing glass by hand | The tests' value was never the selectors — it was the rules (`pending` renders nothing, resolved hides, orphans dock, the Esc chain, chip precedence, decoration lifecycle, coalescing). Those are all controller behaviour and become cheaper and faster to assert against `vm`. The a11y file is the one that *is* the presentation contract, so it becomes the conformance suite's spine and runs twice. Four cases stay pinned to `domPresentation`'s markup on purpose: that markup is now a frozen compatibility surface and needs a test that fails when someone "improves" it. |
| 39 | Two presentations, one theming surface | **The eleven `--cc-*` names are shared; their default *values* are per-presentation.** `domPresentation` keeps §3's table verbatim; `glassPresentation` ships OKLCH defaults (`docs/DESIGN.md` §2.1), including `--cc-radius` 10px and a layered `--cc-shadow` | one global default table; new `--cc-*` tokens for glass (blur, glass opacity, elevation) | A default value is a property of the material, not of the API — and the read-with-fallback rule means a host that themed explicitly is unaffected in either presentation. New public tokens were refused outright: each is a permanent compatibility obligation, and a host that *can* set `--cc-glass-opacity: 0.15` will, on their own busy page, and then the widget is illegible and it is our bug. Theming lets a host say what their brand is, not how transparent our glass gets. `styles.test.ts`'s property contract is parameterised over both sheets. |
| 40 | `three.js` | **Banned in `comment-ui`, `comment-ui/glass` and the extension content script. Sanctioned in exactly one place: `apps/demo/site/material.html`**, ≤ 45 KB gz lazy chunk behind five gates, with an always-correct CSS fallback (`docs/DESIGN.md` §9) | a lazy WebGL "thinking orb" in the content script; a hand-rolled ~3.2 KB GLSL orb; a decorative canvas on the options page | 148 KB gz for the smallest useful renderer, against a 40 KB gz ceiling for everything injected into a third party's page, is a 3.7× miss for ambience. The one effect a GPU genuinely buys — edge refraction, which `backdrop-filter` provably cannot produce — is ~700 bytes of inline SVG filter, off by default. The hand-rolled GLSL orb was rejected too: it is new surface in the content script for a signal a 6-line CSS ring already carries, and browsers evict the oldest of ~16 WebGL contexts, which would silently kill thread 1's canvas when thread 17 appears. A DoD grep enforces it. |
| 41 | How a presentation learns a mode's **index** | **One additive field on the model: `UIViewModel.kinds`** — `engine.modes`' kinds in declaration order, nothing else about a `Mode` | a `hue: number` on each of `BadgeVM` / `ThreadVM` / `ComposerVM` / `PickerVM` / `PanelRowVM`; hashing the kind string in the presentation; exposing `Mode` across the seam | `docs/DESIGN.md` §2.3 derives each mode's hue offset from its **index in `engine.modes`**, deliberately never from a hash — a hash makes the colours of two modes depend on their names, which is unstable and untestable. The index is the one fact a presentation cannot re-derive (#31 keeps `Mode` on the engine's side). Five `hue` fields would put a *design* constant (`[0, +38, −34, +72, −68]`) into the model, where a second presentation could not disagree with it; one ordered `string[]` puts the ordering in the model and leaves the table in the design layer. Additive, still `structuredClone`-able, still frozen and referentially stable. Found by a first-touch UX pass: `ask` and `comment` were the same blue everywhere, and §2.3's mechanism had never been implemented. |


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
  HTML page with no build step. `CommentsUI`'s exported key list is exactly
  `['commentUIStyles', 'createCommentUIController', 'defaultLabels', 'domPresentation', 'mount', 'mountCommentUI']`,
  and `comment-ui-glass.iife.js` reads `globalThis.CommentsUI` as an external the same way
  `comment-ui.iife.js` reads `Comments` (§1.2, §3.1.1).
* `presentationConformance()` passes against **both** `domPresentation()` and
  `glassPresentation()`, and no case in it asserts a class name (§3.1.9).
* Every controller test mounts with `presentation: null` and never queries the shadow root, and
  `structuredClone(controller.vm.get())` succeeds on every published model.
* `packages/comment-ui/src/presentation.ts` contains no `import` or `export … from` statement,
  and its emitted `.d.ts` names no `comment-core`, `comment-ui` or `@floating-ui/dom` identifier.
* `grep -rE "comment-core|floating-ui" packages/comment-ui/src/presentations` returns nothing:
  no presentation imports engine, domain or positioning code.
* `grep -rEi "\bthree\b|webgl" packages/comment-ui/src packages/extension/src` returns nothing
  (decision log #40).
* `styles.test.ts`'s eleven-property contract (consumed with a fallback, never declared,
  rem-free, `all: initial`, explicit `:host` font-size) passes against `commentUIStyles` **and**
  `glassStyles`, and each is byte-identical to the `.css` file its build emits.

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
