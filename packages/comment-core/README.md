# @astrale-os/comment-core

**Anchored comment threads for any page on the web.** Drop a thread on any element — or any
text selection — of any HTML document. It survives reloads, re-renders, list reorders, hashed
class names, popovers that unmount and remount, and SPA route changes. When the element really
is gone, the thread does not disappear and does not lie: it goes **orphaned**, keeps its badge
docked at the last place it was seen, and silently re-attaches the moment the element comes
back.

No framework. No extension. No server. No AI. `comment-core` is the headless half — domain,
anchoring, store, events, placement state machine. [`@astrale-os/comment-ui`](../comment-ui) is
the optional renderer.

```
┌─ capture ────────────────┐        ┌─ resolve ─────────────────────┐
│ 5 selectors, cheap→fuzzy │        │ race them, weight order       │
│ + element fingerprint    │  ───►  │ verify EVERY candidate        │
│ + sanitized HTML snapshot│        │ against the fingerprint       │
└──────────────────────────┘        │ ≥ 0.62 wins, else scan, else  │
                                    │ null — it never guesses       │
                                    └───────────────────────────────┘
```

---

## Why the orphan story is the whole design

Every comment-on-a-page product eventually hits the same wall: the element you anchored to is
not there any more. There are three ways to handle it and only one of them is honest.

| Approach | What the user sees |
|---|---|
| Store one CSS selector | After a re-render the selector still matches — a *different* element. The comment silently moves to the wrong paragraph. |
| Delete the thread when the selector misses | A popover closes and a week of review notes evaporates. |
| **What `comment-core` does** | The thread is never written to on an anchoring change. Orphanhood is a **render-time derivation**, so a missing element is a presentational state (`anchoring.status === 'orphaned'`), the badge docks at the last known document rect, and the next MutationObserver batch re-anchors it for free. |

There is deliberately **no field on `Thread` in which orphanhood could be persisted.** That is
what makes "the popover reopened and my comment came back" a property of the data model rather
than a lucky code path.

The same discipline runs through resolution: every candidate an anchoring strategy produces is
scored against the stored fingerprint (tag must match; `role` / `aria-*` / `data-*` weigh above
class names, which weigh above DOM structure, which weighs above text). A stale-but-valid CSS
path cannot silently attach to the wrong element, because a CSS path is a *candidate*, never a
verdict.

---

## Install

```sh
npm i @astrale-os/comment-core
# optional renderer
npm i @astrale-os/comment-ui
```

Runtime dependencies: `@medv/finder`, `approx-string-match`, `nanoid`, plus a vendored copy of
Hypothesis's `annotator/anchoring` (BSD-2). Nothing else. `happy-dom` is an **optional** peer,
needed only by `createTestPage` from `@astrale-os/comment-core/testing`.

### Entry points

| Subpath | Contents | Needs a DOM | DOM types in its `.d.ts` |
|---|---|---|---|
| `@astrale-os/comment-core` | everything below, plus the engine | engine only | yes |
| `@astrale-os/comment-core/headless` | domain, stores, `observeStore`, page key, errors, DOM-free types | no | **no** |
| `@astrale-os/comment-core/anchor` | capture / resolve / score / fingerprint / strategies | yes (injectable `Document`) | yes |
| `@astrale-os/comment-core/testing` | conformance suites + `createTestPage` | only `createTestPage` | mixed |

`/headless` is not a convenience — it is the entry point a **service worker** must use. The
root entry's *type* surface names `Element`, `Range`, `Document`, `ParentNode` and `Selection`,
so under `lib: ["ES2022", "WebWorker"]` importing the root does not compile.

---

## 60-second quick start

### With a bundler

```ts
import { createCommentEngine } from '@astrale-os/comment-core'
import { mountCommentUI } from '@astrale-os/comment-ui'

const engine = createCommentEngine() // localStorage store, defaultPageKey, `c` places a comment
mountCommentUI(engine)

// A 4-line "copilot": every user comment gets an echo reply 800 ms later.
engine.on('thread:create', ({ thread, comment }) => {
  setTimeout(() => {
    void engine.appendComment(thread.id, {
      author: 'copilot',
      body: `echo: ${comment.body}`,
      id: `echo:${comment.id}`, // idempotency key — a reload cannot double-post
    })
  }, 800)
})
```

Press <kbd>C</kbd>, click an element, type, hit Send. Reload — the badge comes back.

### With no build step at all

```html
<script src="/comment-core.iife.js"></script>
<script src="/comment-ui.iife.js"></script>
<script>CommentsUI.mount()</script>
```

Order matters: `comment-ui.iife.js` declares `comment-core` external and reads it off
`globalThis.Comments`. (That is also why `CommentError.is()` is brand-based rather than
`instanceof` — the guard has to stay true across bundle and realm boundaries.)

---

## Core concepts

### 1. Threads and comments

A `Thread` is an anchor plus a status. A `Comment` is a body plus an author. They are stored as
**separate records**, and that split is load-bearing: a comment write never touches the thread
record — not its capture, not its `updatedAt`. Recency is derived (`ThreadView.lastActivityAt`),
so every reply is a single-record write.

```ts
interface Thread {
  id: string
  v: 1
  pageKey: string
  kind: string                      // consumer-defined ('comment', 'ask', …); opaque to the engine
  anchor: AnchorDescriptor
  capture: ElementCapture
  status: 'open' | 'resolved'
  resolvedAt: string | null
  resolvedBy: Author | null         // always 'user' — see below
  createdAt: string
  updatedAt: string                 // moves ONLY on a status transition
}

interface Comment {
  id: string
  threadId: string
  author: 'user' | 'copilot'
  body: string
  createdAt: string
  editedAt: string | null
}
```

`Thread` and `Comment` gain no further fields, ever. Host state (run linkage, unread, pending
dispatch) lives in a host-owned side map keyed by `threadId`.

**An empty thread cannot exist.** `createThread` writes the thread *and* its first comment
atomically; deleting the last comment deletes the thread; an empty body rejects with
`empty_body` before any write.

### 2. The auto-reopen matrix

The single most-asked question about a resolve/reopen model is "does a reply reopen a resolved
thread?" Here is the whole answer, and it is enforced in `createDomain`, once, for both the
browser engine and a service worker:

| Thread status | Reply author | Thread record written? | `reopened` | Events emitted, in order |
|---|---|---|---|---|
| `open` | `user` | **no** | `false` | `thread:reply` |
| `open` | `copilot` | **no** | `false` | `thread:reply` |
| `resolved` | `user` | yes — `status: 'open'`, `resolvedAt`/`resolvedBy` cleared, `updatedAt` bumped | `true` | `thread:reopen` (`reason: 'reply'`) **then** `thread:reply` |
| `resolved` | `copilot` | **no** — status untouched | `false` | `thread:reply` |

A slow machine reply can never resurrect a thread a human resolved. The axis is configurable
without changing the `Author` union: `DomainOptions.reopensOnReply`, default
`(a) => a === 'user'`.

`resolve(threadId)` takes **no** `by` parameter — `resolvedBy` is always `'user'`. "The copilot
may suggest, never execute" is enforced by the type: it is a sentence you cannot write.

### 3. Anchoring

`captureTarget(element | range)` snapshots five ordered selectors, an element fingerprint and a
sanitized HTML/text capture in one call. `resolveAnchor(anchor)` races them back to a live
element.

| Strategy | `type` | Weight | Cost | What it stores |
|---|---|---|---|---|
| attribute | `attr` | 90 | cheap | `id`, `data-testid`, `aria-label`, `role` + accessible name |
| CSS path | `css` | 80 | cheap | a robust generated selector (`@medv/finder`) |
| text quote | `textQuote` | 70 | fuzzy | `exact` + `prefix` + `suffix` (Hypothesis + `approx-string-match`) |
| structural path | `nthPath` | 40 | cheap | an `nth-child` chain — last-resort exact |
| text position | `textPosition` | 30 | fuzzy | character offsets |

Resolution order is **cheap before fuzzy, then weight descending**; capture order is weight
descending. `cheap` strategies are the only ones run on the MutationObserver fast path.

Defaults: `threshold` 0.62 · `scanLimit` 500 · `budgetMs` 12 · `batchMs` 100.

`Anchoring` is the derived, never-persisted view of all this:

| Field | Type | Meaning |
|---|---|---|
| `status` | `'pending' \| 'anchored' \| 'orphaned'` | `pending` renders **nothing** — that is what stops a cold-load orphan flash |
| `element` | `Element \| null` | live element, `null` while pending/orphaned |
| `range` | `Range \| null` | non-null only for a re-anchored text quote |
| `confidence` | `number` | 0..1; UI flags "approximately re-anchored" below 0.85 |
| `via` | `MatchVia \| null` | which signal won (`'attr'`, `'css'`, …, or `'fingerprint-scan'`) |
| `rect` | `DocumentRect \| null` | **document-space** rect, retained while orphaned so a badge can dock without drifting on scroll |

`engine.explain(threadId)` returns the per-selector trace from the last resolution pass —
cached, so it is free to call from a `thread:anchored` listener and free to map over every
thread for a benchmark table.

### 4. Modes and kinds

One engine, many trigger modes. `kind` is stamped verbatim onto `Thread.kind` and the engine
attaches **zero** behaviour to it — it never validates it, never branches on it.

```ts
createCommentEngine({
  modes: [
    { kind: 'comment', trigger: { key: 'c', interaction: 'pick' } },
    { kind: 'ask', trigger: { key: 'a', interaction: 'hover' }, badge: { icon: '?' } },
    { kind: 'triage', trigger: false }, // programmatic only: engine.startPlacement('triage')
  ],
})
```

* `interaction: 'pick'` — highlight under the cursor, click to place, <kbd>Esc</kbd> cancels.
* `interaction: 'hover'` — place immediately on the last-hovered element.
* **A non-collapsed selection always wins** and composes a text-mode thread instead.
* Bare-letter triggers are ignored inside `input` / `textarea` / `contenteditable`. Triggers
  with a modifier bypass that guard.
* Two modes may not claim the same key + modifier combination — `invalid_options`, thrown
  synchronously from `createCommentEngine` and from `setModes`.

### 5. Stores

Everything durable goes through one nine-method port, `CommentStore`. Three adapters ship:

| Factory | Backing | Use it for |
|---|---|---|
| `createMemoryStore(seed?)` | a `Map` | tests; adds `snapshot()`, `restore()`, `reads`, `writes` |
| `createKeyValueStore(kv, { namespace })` | any `KeyValueAdapter` | production — `chrome.storage`, IndexedDB, a server |
| `createLocalStorageStore({ namespace, storage })` | `localStorage` | demos and single-origin pages **only** |

`createLocalStorageStore` is per-origin: in a content script that is the **host page's** storage
— evictable, wiped by "clear site data", readable by the page. Extensions and any multi-page
product pass `createKeyValueStore(kv)` over storage they own.

The key layout has **no shared mutable key**: `{ns}:t:{pageKey}:{threadId}` and
`{ns}:c:{threadId}:{commentId}`. `listThreads(pageKey)` is a prefix scan, so two concurrent
creates on one page can never last-writer-wins an index and drop a thread.

### 6. Events

Two halves. `StoreEventMap` is what a **store diff** can reconstruct — no DOM values, no
`view`, structurally cloneable, so a cross-context relay forwards it verbatim.
`EngineOnlyEventMap` is what needs a live document.

| Event | Half | Payload |
|---|---|---|
| `thread:create` | store | `{ thread, comment, source }` |
| `thread:reply` | store | `{ thread, comment, source }` |
| `thread:resolve` | store | `{ thread, source }` |
| `thread:reopen` | store | `{ thread, reason: 'explicit' \| 'reply', source }` |
| `thread:delete` | store | `{ thread, comments, reason: 'explicit' \| 'empty', source }` |
| `comment:edit` | store | `{ thread, comment, previousBody, source }` |
| `comment:delete` | store | `{ thread, comment, threadDeleted, source }` |
| `thread:anchored` | engine | `{ thread, view, element, confidence, via, previous }` |
| `thread:orphaned` | engine | `{ thread, view, lastRect }` |
| `thread:click` | engine | `{ thread, view, element }` |
| `placement:start` | engine | `{ kind, interaction: 'pick' \| 'hover' \| 'direct' }` |
| `placement:end` | engine | `{ kind, reason: 'placed' \| 'cancelled', threadId }` |
| `placement:rejected` | engine | `{ kind, reason: 'busy' \| 'no_target' \| 'unknown_kind' }` |
| `page:change` | engine | `{ pageKey, previous, url }` |
| `error` | engine | `{ error, phase, threadId? }` |

Ordering guarantees you can build on:

1. **Persist-then-notify.** No event fires for a write that did not land. The live view never
   optimistically mutates.
2. **View-before-listeners.** Inside any listener, `engine.getThreadView(id)` and
   `engine.threads.get()` already reflect the event being delivered.
3. **First comment is `thread:create`, never `thread:reply`.** Exactly one of the two, ever.
4. **State precedes content** — `thread:reopen` before `thread:reply` on an auto-reopen.
5. **Anchoring batches** coalesce at `batchMs` on `requestIdleCallback`; within a batch all
   `thread:orphaned` fire before all `thread:anchored`, and only on *transitions*.
6. **`pending → orphaned` waits for a parsed document.** With `document.readyState === 'loading'`
   the first full pass is deferred to `DOMContentLoaded`, so a `document_start` content script
   never orphans every thread on every page load.
7. **Remote echoes** (another tab's write, arriving via `store.subscribe`) re-emit with
   `source: 'remote'`, deduped by a per-write origin token — never by timestamp.

Guard trigger loops on **`comment.author`**, never on `source`.

### 7. Errors

One class, one code union, one guard.

```ts
try {
  await engine.appendComment(id, { author: 'user', body })
} catch (error) {
  if (CommentError.is(error, 'quota_exceeded')) offerExport()
  else if (CommentError.is(error, 'thread_not_found')) refresh()
  else throw error
}
```

| Code | Thrown by |
|---|---|
| `thread_not_found` / `comment_not_found` | a write against a record that is gone |
| `empty_body` | `createThread` / `appendComment` / `editComment` with a blank body |
| `store_failed` | adapter I/O failure (original on `.cause`) |
| `quota_exceeded` | storage full — the one store failure a host can act on |
| `unsupported_version` | a stored record whose `v` this build does not know |
| `unknown_kind` | `startPlacement` with a kind not in `modes` |
| `no_target` / `placement_busy` | reported on `startPlacement`'s return + `placement:rejected` |
| `invalid_options` | duplicate trigger binding, unusable option combination |
| `no_document` | `start()` found no usable `document` (thrown synchronously) |
| `engine_destroyed` | any call after `destroy()` |

**User-flow rejections are not errors.** Pressing the trigger key twice, or hovering nothing,
returns `false` and emits `placement:rejected` — not `error`. That keeps `onError` bindable
straight to a pager.

---

## API reference

### Engine

| Export | Signature | One-liner |
|---|---|---|
| `createCommentEngine` | `(options?: CommentEngineOptions<S>) => CommentEngine<S>` | The DOM runtime. Extends `CommentDomain`, so every write obeys the same rules a worker's domain does. |

`CommentEngineOptions`:

| Option | Type | Default |
|---|---|---|
| `store` | `CommentStore` | `createLocalStorageStore()` |
| `pageKey` | `string \| PageKeyFn` | `defaultPageKey` |
| `modes` | `readonly Mode[]` | `[{ kind: 'comment', trigger: { key: 'c', interaction: 'pick' } }]` |
| `anchoring` | `AnchoringOptions` | `{ threshold: 0.62, scanLimit: 500, budgetMs: 12, observe: true, batchMs: 100, rescanIdle: true }` |
| `capture` | `Omit<CaptureOptions, 'document' \| 'strategies'>` | `{ htmlLimit: 8192, textLimit: 2000 }` |
| `navigation` | `{ watch?, source? } \| false` | `{ watch: true }` — polls `location.href`, listens to `popstate`/`hashchange`. **Never patches `history`.** |
| `autoStart` | `boolean` | `true` |
| `onError` | `(e: CommentError, phase: ErrorPhase) => void` | — |
| `document` | `Document` | `globalThis.document`, read at `start()` |
| `now` / `createId` | `() => Date` / `() => string` | `new Date()` / `nanoid(12)` |
| `reopensOnReply` | `(author: Author) => boolean` | `(a) => a === 'user'` |

`CommentEngine` members (in addition to every `CommentDomain` method):

| Member | Signature | One-liner |
|---|---|---|
| `store` | `S` | The store you passed. |
| `pageKey` | `string` | Current page key; updates on SPA navigation. |
| `page` | `ReadableStore<{ key, url }>` | Live page identity. |
| `modes` | `readonly Mode[]` | Active modes. |
| `status` | `ReadableStore<'idle' \| 'loading' \| 'ready' \| 'destroyed'>` | Lifecycle. |
| `threads` | `ReadableStore<readonly ThreadView[]>` | Frozen array of frozen views, referentially stable until something actually changed. |
| `active` | `ReadableStore<string \| null>` | Thread the engine last focused. |
| `placement` | `PlacementController` | `ReadableStore<PlacementState>` + `start` / `setDraft` / `submit` / `cancel`. |
| `listThreads` | `(filter?: EngineThreadFilter) => ThreadView[]` | Synchronous, over the live view. Defaults to the current page. |
| `getThreadView` | `(id: string) => ThreadView \| null` | Synchronous lookup; fresh inside any listener. |
| `ready` | `() => Promise<void>` | Resolves after the first store load + first anchoring pass. |
| `startPlacement` | `(kind?: string) => boolean` | Alias for `placement.start(kind)`. |
| `setModes` | `(modes: readonly Mode[]) => void` | Re-bind triggers at runtime; keeps threads, decorations and listeners. |
| `reanchor` | `(threadId?: string) => Promise<void>` | Force a resolution pass. |
| `focus` | `(id, options?: { scroll? }) => boolean` | Scroll to + mark active + emit `thread:click`. |
| `explain` | `(id, options?: { fresh? }) => AnchorExplanation \| null` | Cached per-selector trace; `{ fresh: true }` re-resolves now. |
| `on` / `once` / `off` | `(event, listener, options?) => Unsubscribe` | Typed bus; `options` takes `{ once, signal }`. |
| `subscribe` | `(listener: (e: CommentEvent) => void) => Unsubscribe` | The `*` firehose, after typed listeners, with a monotonic `seq`. |
| `start` / `stop` / `destroy` | `() => void` | All idempotent; `destroy()` is synchronous and final. |
| `inspect` | `() => EngineInspection` | Serializable snapshot for devtools / an options page. |

### Domain (DOM-free)

| Export | Signature | One-liner |
|---|---|---|
| `createDomain` | `(store: CommentStore, options?: DomainOptions) => CommentDomain` | The edge-case table, implemented once. |

| `CommentDomain` method | Signature |
|---|---|
| `createThread` | `(input: CreateThreadInput) => Promise<CreateResult>` |
| `appendComment` | `(threadId: string, input: AppendCommentInput) => Promise<AppendResult>` |
| `editComment` | `(ref: CommentRef, body: string) => Promise<Comment>` |
| `deleteComment` | `(ref: CommentRef) => Promise<DeleteCommentResult>` |
| `resolve` | `(threadId: string) => Promise<Thread>` |
| `reopen` | `(threadId: string) => Promise<Thread>` |
| `delete` | `(threadId: string) => Promise<void>` |
| `get` | `(threadId: string) => Promise<ThreadRecord \| null>` |
| `list` | `(filter?: ThreadFilter) => Promise<ThreadRecord[]>` |

`CreateResult` / `AppendResult` are discriminated on `kind` (`'created'` / `'replied'`) and both
carry `reopened` and `deduped`, so a bridge replaying a write always knows whether it wrote.

### Stores and observation

| Export | Signature | One-liner |
|---|---|---|
| `createMemoryStore` | `(seed?: readonly ThreadRecord[]) => MemoryStore` | In-memory store + `snapshot()` / `restore()` / `reads` / `writes`. |
| `createKeyValueStore` | `(kv: KeyValueAdapter, options?: { namespace?: string }) => CommentStore` | The general adapter. Namespace-filters `watch` so a sibling module's writes never wake it. |
| `createLocalStorageStore` | `(options?: { storage?: StorageLike; namespace?: string }) => CommentStore` | Demo default. Touches `localStorage` lazily, never at module scope. |
| `defineCommentStore` | `<const S extends CommentStore>(store: S) => S` | Identity; preserves the literal type of your adapter. |
| `observeStore` | `(store, listener: (e: StoreEvent) => void, options?: ObserveOptions) => Unsubscribe` | Emit domain events by diffing store snapshots — in **every** context watching the store. |
| `createKeyValueCursor` | `(kv, options?: { namespace?; id? }) => ObserveCursor` | Durable cursor for `observeStore`. Required in a service worker. |

### Page key

| Export | Signature | One-liner |
|---|---|---|
| `defaultPageKey` | `(url: URL, options?: PageKeyOptions) => string` | origin + pathname + non-volatile query, hash and trailing slash stripped, params sorted. |
| `createPageKey` | `(options?: PageKeyOptions) => PageKeyFn` | Curried form for `createCommentEngine({ pageKey })`. |
| `volatileParams` | `readonly RegExp[]` | `utm_*`, `gclid`, `fbclid`, `msclkid`, `ref`, session/token-looking params. |

### Anchoring

| Export | Signature | One-liner |
|---|---|---|
| `captureTarget` | `(target: Element \| Range, options?: CaptureOptions) => { anchor, capture }` | Snapshot everything a thread needs, in one call. Never throws. |
| `captureElement` | `(target: Element \| Range, options?: CaptureOptions) => ElementCapture` | Sanitized, truncated HTML/text snapshot. |
| `resolveAnchor` | `(anchor: AnchorDescriptor, options?: ResolveOptions) => AnchorMatch \| null` | Race selectors, verify every candidate, fall back to a bounded scan. Never throws, never guesses. |
| `explainAnchor` | `(anchor, options?) => AnchorExplanation` | Same, with a per-selector trace (`attempts`, `totalMs`, `budgetExceeded`). |
| `scoreCandidate` | `(element: Element, fingerprint: ElementFingerprint) => number` | Fingerprint similarity 0..1. Tag mismatch ⇒ 0. |
| `fingerprintElement` | `(element, options?: { classFilter? }) => ElementFingerprint` | Build a fingerprint; filters hashed/utility class names. |
| `defineSelectorStrategy` | `(strategy) => SelectorStrategy<{ type: TType } & TPayload>` | Author a custom locator with the payload inferred from `describe`. |
| `defaultStrategies` | `readonly SelectorStrategy<BuiltinSelector>[]` | The five builtins, in weight order. |

### Errors and constants

| Export | One-liner |
|---|---|
| `CommentError` | `Error` subclass with `code`, `threadId?`, `commentId?`, `cause?`, and a **brand-based** `static is(e, code?)`. |
| `THREAD_VERSION` | `1` — stamped on every written thread. |

### Testing (`@astrale-os/comment-core/testing`)

| Export | Signature | One-liner |
|---|---|---|
| `storeConformance` | `(factory: () => Awaitable<CommentStore>) => ConformanceCase[]` | 35 cases: sorting, cascade delete, subscribe fan-out, upsert, durability. |
| `domainConformance` | `(factory) => ConformanceCase[]` | 24 cases: the store-observable edge-case rows + idempotency + empty-body rejection. |
| `engineConformance` | `(factory) => ConformanceCase[]` | 13 cases: orphaning and unknown-kind rows + DOM-dependent ordering. Needs `happy-dom`. |
| `createTestPage` | `(html: string, options?: { url? }) => TestPage` | happy-dom fixture: `engine()`, `mutate()`, `navigate()`, `flush()`, `dispose()`. |
| `makeThreadRecord` / `makeCommentRecord` / `makeCreateInput` | fixture builders | Build records without a DOM. |
| `tickingClock` / `countingIds` | `() => Date` / `() => string` | Deterministic `now` and id seams. |

Suites are runner-agnostic arrays of `{ name, run }`, so vitest, `node:test` and bun all work:

```ts
import { domainConformance, engineConformance, storeConformance } from '@astrale-os/comment-core/testing'
import { describe, it } from 'vitest'

describe('my store', () => {
  for (const c of storeConformance(() => createMyStore())) it(c.name, c.run)
  for (const c of domainConformance(() => createMyStore())) it(c.name, c.run)
  // Rows 14 and 17 need a DOM; this suite drives createTestPage (happy-dom).
  for (const c of engineConformance(() => createMyStore())) it(c.name, c.run)
})
```

---

## Guides

### Write a custom store adapter

Implement `KeyValueAdapter` — four methods and an optional `watch` — and `createKeyValueStore`
gives you a conforming `CommentStore`.

```ts
import type { KeyValueAdapter, Unsubscribe } from '@astrale-os/comment-core'
import { createKeyValueStore } from '@astrale-os/comment-core'

const kv: KeyValueAdapter = {
  async get(keys) {
    const values = await idb.getMany(keys)
    return Object.fromEntries(keys.map((key, i) => [key, values[i]]))
  },
  set: (entries) => idb.setMany(Object.entries(entries)),
  remove: (keys) => idb.delMany(keys),
  // MUST be key-only: the engine calls this on every store notification.
  keys: (prefix) => idb.listKeys(prefix),
  watch: (cb): Unsubscribe => idb.onChange(cb),
}

export const store = createKeyValueStore(kv, { namespace: 'my-app' })
```

`keys(prefix)` being **key-only** is normative, not a hint. An implementation that enumerates
keys by deserializing values (`Object.keys(await chrome.storage.local.get(null))`) reads every
8 KB capture on every notification. Use `chrome.storage.local.getKeys()`, a key range, or an
adapter-side key cache maintained from `watch`.

Writing a `CommentStore` from scratch instead? Wrap it in `defineCommentStore` and run
`storeConformance()` against it. The contract in one paragraph: lists come back sorted by
`createdAt` then `id`; `putThread` / `putComment` are upserts that resolve only when durable;
`deleteThread` cascades comments and `deleteComment` does not touch the thread; `subscribe`
must fire for local writes too, may over-notify, must never under-notify; map storage-full
failures to `quota_exceeded`.

### Write a custom selector strategy

The known failure mode of generic anchoring is a virtualized list: rows are recycled, so
`nth-child` and CSS paths point at whoever moved into the slot. A row key is ground truth.

```ts
import { createCommentEngine, defaultStrategies, defineSelectorStrategy } from '@astrale-os/comment-core'

// `describe`'s return type IS the selector payload: `resolve` sees `{ type: 'x-row-id'; rowId: string }`.
const rowId = defineSelectorStrategy({
  type: 'x-row-id',
  weight: 120, // beats attr (90) and css (80)
  cost: 'cheap',
  describe: (target, { closest }) => {
    const row = closest(target, '[data-row-id]') as HTMLElement | null
    return row?.dataset.rowId === undefined ? null : { rowId: row.dataset.rowId }
  },
  resolve: (sel, { root }) => root.querySelector(`[data-row-id="${CSS.escape(sel.rowId)}"]`),
})

export const engine = createCommentEngine({
  // ONE list serves both halves: `describe` at capture time, `resolve` at anchoring time.
  anchoring: { strategies: [rowId, ...defaultStrategies], threshold: 0.72, scanLimit: 2000 },
})
```

Custom selector types must be `x-`prefixed (which keeps `switch` statements over
`BuiltinSelector` exhaustive), or exactly a builtin `type` to replace that builtin. Merging is
by `type`: a supplied strategy always beats a builtin, and re-listing `...defaultStrategies` is
a no-op, so `[rowId]`, `[rowId, ...defaultStrategies]` and `[...defaultStrategies, replacement]`
all mean what they read like.

`verify` is not a choice. Every candidate a strategy produces is still fingerprint-scored.

### Run headless — service worker, Node, anywhere without a DOM

```ts
import type { KeyValueAdapter } from '@astrale-os/comment-core/headless'
import {
  createDomain, createKeyValueCursor, createKeyValueStore, observeStore,
} from '@astrale-os/comment-core/headless'

const store = createKeyValueStore(kv, { namespace: 'my-app' })
const comments = createDomain(store) // the same rules the page engine runs

observeStore(
  store,
  async (event) => {
    if (event.type !== 'thread:create' && event.type !== 'thread:reply') return
    const { thread, comment } = event.payload
    if (comment.author !== 'user') return // the author field is the ONLY loop guard
    await dispatch(thread.id, comment.body) // awaited: a throw replays the event
  },
  { cursor: createKeyValueCursor(kv, { namespace: 'my-app:host', id: 'dispatch' }) },
)

export async function reply(threadId: string, body: string, runId: string): Promise<void> {
  if (!(await comments.get(threadId))) return // deleted mid-run → drop the output
  await comments.appendComment(threadId, { author: 'copilot', body, id: `r:${runId}` })
}
```

### `observeStore` as a cross-context bridge

`observeStore` diffs consecutive store snapshots and emits the store half of the event map. It
fires in **every** context watching that store — the tab that wrote, other tabs, and a service
worker — which is why hooks in a background context need no messaging channel at all.

Four rules that make it safe:

1. **The cursor must be durable in a service worker.** `chrome.storage.onChanged` wakes a
   dormant worker, so a fresh worker's in-memory baseline is taken *after* the write that woke
   it, and that write would be invisible. `createKeyValueCursor(kv, …)` persists
   `{ lastSeenAt, seen }` (a bounded 200-id tie-breaker set).
2. **Delivery is at-least-once.** The cursor advances only after the listener's returned promise
   settles, so a listener that throws re-receives the event on the next notification. Make your
   handler idempotent — which is exactly what `AppendCommentInput.id` is for.
3. **Work is bounded.** A notification reads the thread-key prefix, compares it against the
   cursor, and reads comments only for threads whose key set changed. Cost is O(changed), not
   O(store).
4. **Every emitted event carries `source: 'remote'`** — it cannot know origin. Guard loops on
   `comment.author`.

`observeStore` never emits `thread:anchored`, `thread:orphaned`, `thread:click`, `placement:*`
or `page:change`: a service worker has no `Element`, so a `ThreadView` there would be fiction.

### Bind the live view to a framework

`ReadableStore<T>` is the only reactive primitive in the package: `get()` + `subscribe()`, and
`subscribe` does **not** fire on subscribe. Every `ThreadView` is frozen and referentially
stable until that thread's record, comment list or `Anchoring` actually changes, so `===`
memoization is correct without selectors.

```ts
// Hoist these: an inline closure makes React resubscribe on every commit,
// and SSR/hydration throws without a server snapshot.
const EMPTY: readonly ThreadView[] = Object.freeze([])
const subscribeThreads = (cb: () => void) => engine.threads.subscribe(cb)
const getThreads = () => engine.threads.get()
const getServerThreads = () => EMPTY

const useThreads = () => useSyncExternalStore(subscribeThreads, getThreads, getServerThreads)
```

There is no `comment-core/react` subpath, no `select()`, no `derived()`. A Svelte store is
`ReadableStore` shape adaptation in three lines.

---

## FAQ

**A thread's element vanished. Did anything get written to the store?**
No. Never. Orphanhood is derived at render time and there is no field to write it into. The
thread re-anchors automatically when the element returns.

**Can the copilot resolve a thread?**
No. `resolve(threadId)` takes no author parameter and `resolvedBy` is always `'user'`.

**A copilot reply landed on a thread I already resolved. Did it reopen?**
No — `reopened === false`, `status` untouched, and only `thread:reply` fires. A human reply to
the same thread *would* reopen it. See the matrix above.

**What happens if I delete the first comment of a thread?**
Nothing dramatic: the thread, its anchor, its capture and the remaining comments survive, and
the thread record is not even written. Deleting the **last** comment deletes the thread
(`comment:delete` with `threadDeleted: true`, then `thread:delete` with `reason: 'empty'`).

**I replayed a message after a service-worker restart. Will it double-post?**
Not if you pass an id. `appendComment(threadId, { id })` and
`createThread({ id, commentId })` are idempotent: a reused id is a no-op that returns the
existing record with `deduped: true` and emits **no** event.

**I wrote to a thread another tab deleted. What do I get?**
A rejection — `thread_not_found`. Not a silent no-op: a silent no-op hides bugs in the 99%
non-bridge case, and idempotency keys already cover the redelivery case.

**Does resolving an already-resolved thread re-stamp `resolvedAt`?**
No. It is a no-op that resolves with the unchanged thread and emits nothing. Reopening an open
thread is the mirror image.

**Two tabs are open. Do I get the other tab's writes?**
Yes — re-emitted with `source: 'remote'`, deduped against your own writes by a per-write origin
token (never by timestamp, which would collapse two writes in the same millisecond and silently
drop a real edit).

**My app upgraded and there are old records on disk.**
A `Thread` whose `v` is not `THREAD_VERSION` is skipped from every list and from the live view,
and is **never rewritten**. You hear about it once per record via `DomainOptions.onError`, or as
an `error` / `unsupported_version` event on the engine.

**Does `kind` do anything?**
Only in your code. The domain never reads it, never validates it against `modes`, never branches
on it. `startPlacement(kind)` with an unregistered kind returns `false` and emits
`placement:rejected` *and* `error` — that one is a programming mistake.

**Where does copilot / unread / pending-dispatch state live?**
In a side map you own, keyed by `threadId`. `Thread` and `Comment` gain no fields. If you are
sharing a `KeyValueAdapter` with other modules, give each one its own key prefix —
`createKeyValueStore` ignores changed keys outside its own namespace precisely so a sibling's
10-second heartbeat does not trigger a thread re-read in every tab.

**Does it patch `history.pushState`?**
No, and it will not. In an MV3 content script the isolated world has its own `history` binding,
so a patch installed there never intercepts the page's own calls. `comment-core` listens to
`popstate` / `hashchange` and compares `location.href` at the head of every anchoring batch. If
you have a better signal — a router hook, `chrome.webNavigation.onHistoryStateUpdated` — pass
`navigation.source` and the poll is skipped entirely.

**Can I use it server-side / in SSR?**
Import `@astrale-os/comment-core/headless`, or construct the engine with `autoStart: false`
(construction succeeds, `status` stays `'idle'`, DOM-bound methods are documented no-ops).
Calling `start()` with no usable document throws `no_document` synchronously.

---

## License

Apache-2.0 © Astrale. Vendored Hypothesis `annotator/anchoring` sources under
`src/anchor/vendor/hypothesis/` are BSD-2-Clause; see the `LICENSE` file in that directory.
