# exp-spec — Plan

> Status: **v2 — ready for review.** v2 renames the domain to **comment threads**
> (`comment-core`), adopts the thread lifecycle best practices surveyed across Google
> Docs / Figma / GitHub / Liveblocks / Velt / TipTap / CKEditor, and makes the copilot a
> **fully independent module** with a generic trigger/listen API — the extension is the
> only bridge. Technology choices are grounded in 2026 surveys of the annotation OSS
> landscape, comment-thread domain models, Chrome built-in AI status, and MV3
> architecture (sources in PR description).

## 0. Context & goals

Internal Chrome extension (never published, minimal security constraints) to improve the
experience of reviewing/authoring specs in the browser — built as **two independent
modules, each usable as a standalone open-source-style library**:

1. **Comment engine** (`comment-core` + `comment-ui`) — drop a persistent **comment
   thread** on any element of any HTML page via a keyboard trigger: composer popover,
   flat replies, resolve/reopen lifecycle, robust re-anchoring across reloads and
   dynamic DOM, clean hook-based API. Fully agnostic: usable via a plain `<script>` tag
   on any page, no extension, no AI.
2. **Copilot** (`copilot`) — a small, generic LLM agent runtime for the browser:
   trigger/listen API, host-registered tools, background job queue. **Zero knowledge of
   comments** — it could power any other feature.

**The two modules never import each other.** The `extension` package is the only bridge:
it forwards comment hooks into copilot triggers, registers comment-flavored tools on the
copilot, and writes copilot output back into threads.

Out of scope (for now, explicitly deferred): protocol to local coding agents
(Claude Code / Codex), multi-user sync, auth, Chrome Web Store hardening.

---

## 1. The experience (walkthrough)

1. On any page, press a mode key — the extension registers two **modes** on the same
   engine: `C` → **comment**, `A` → **ask** (only fires outside editable fields). The
   page enters *placement mode*: elements highlight under the cursor; click to place
   (Esc cancels). A quicker variant (configurable per mode): press while hovering to
   place directly on the last-hovered element. An active text selection wins and
   creates a text-mode thread.
2. A badge is pinned to the element and a small popover composer opens. Type your
   comment, press **Send** — or dismiss (nothing is persisted until Send; a thread is
   created atomically with its first comment, an empty thread cannot exist).
3. On send, the thread is persisted and the `thread:create` hook fires. In the
   extension, this triggers a copilot run. The badge shows a "copilot thinking" chip.
4. You can navigate away, refresh, close the tab. The run keeps processing in the
   background. When you come back, the thread re-anchors to its element (even if it was
   removed and re-added, e.g. a popover) and shows the copilot's reply in the thread.
5. Clicking a badge opens the thread: read, **reply** (each human reply triggers a new
   copilot run with the full thread as context), **resolve** when done, **reopen** a
   resolved thread (explicitly, or implicitly by replying to it), or **delete**.
   Deleting removes badge + record everywhere and cancels any in-flight run.

---

## 2. Architecture

pnpm monorepo (workspace conventions: `@astrale-os/ox` for lint/format/typecheck — oxlint,
oxfmt, tsgo; no prettier/eslint/tsc).

```
exp-spec/
  packages/
    comment-core/    # headless engine: anchoring, Thread/Comment domain, store, lifecycle, hooks
    comment-ui/      # badges + composer popover + thread panel, rendered in a shadow root
    copilot/         # generic agent runtime: trigger/listen, loop, tool registry, run queue
    extension/       # MV3 extension — THE bridge wiring the two modules (WXT)
  apps/
    demo/            # static test pages loading comment-core+ui via <script> — no extension needed
  bench/             # agent-browser scenarios + site corpus for anchoring robustness
```

Dependency rule — the load-bearing one:

```
extension → { comment-core, comment-ui, copilot }
comment-ui → comment-core
copilot    → (nothing internal)        ← NO import of comment-core, ever
comment-core → (nothing internal)      ← NO import of copilot, ever
```

Both `comment-core` and `copilot` must make sense published standalone on npm. Anything
that needs both sides lives in `extension` (or the demo's tiny glue).

Build discipline: `comment-core`/`comment-ui`/`copilot` never import `chrome.*` or
`wxt/*` — storage, messaging, and transport are injected interfaces. The extension
supplies chrome-backed adapters; the demo page supplies in-memory/localStorage ones.
Core packages build with Vite lib mode (ESM + IIFE) so the demo loads them via
`<script src>`.

---

## 3. Module 1 — Comment engine (`comment-core`)

### 3.1 Anchoring model

The hard problem: re-attach a thread to "the same element" after reload, DOM mutation, or
element removal/re-insertion. Research verdict (2026 survey): **text anchoring is solved
OSS (reuse), element anchoring is not (rebuild)**. No single selector survives all of
that, so each thread stores an **ordered fallback chain of selectors plus a fingerprint**
— the redundant-selector pattern proven by Chrome DevTools Recorder / `@puppeteer/replay`
(store many independent locators, race them at resolve time), with Playwright's priority
order (user-facing semantics — role + accessible name, `data-testid`, visible text —
weighted above DOM structure, which churns):

```ts
interface AnchorDescriptor {
  mode: 'element' | 'text';
  selectors: Selector[];          // ordered, cheap→fuzzy
  fingerprint: ElementFingerprint; // used to score candidates
}

type Selector =
  | { type: 'css'; value: string }              // robust generated selector (prefer ids/data-* /aria)
  | { type: 'attr'; tag: string; attrs: Record<string, string> } // id, data-testid, aria-label, role+name
  | { type: 'nthPath'; value: string }          // structural nth-child path (fragile, last-resort exact)
  | { type: 'textQuote'; exact: string; prefix: string; suffix: string } // text mode + fuzzy element match
  | { type: 'textPosition'; start: number; end: number };

interface ElementFingerprint {
  tag: string;
  id?: string;
  stableClasses: string[];        // filtered: drop hashed/utility-looking classes
  attrs: Record<string, string>;  // subset: role, aria-*, data-*, name, href/src (normalized)
  textDigest: string;             // normalized trimmed textContent (first ~200 chars)
  rectHint?: { w: number; h: number };
}
```

**Resolution** (`resolveAnchor(anchor): { element, confidence } | null`): resolve
selectors independently; every candidate is **verified against the fingerprint** with a
similarity score (tag match required; semantic signals — role/name/data-* — weighted
above classes/structure; text digest as final verifier). Accept above a threshold, else
continue; final fallback is a fingerprint scan over a bounded candidate set (elements of
same tag). This mirrors Hypothesis's `maybeAssertQuote` trick: **never let a
stale-but-valid CSS path silently attach to the wrong element** — cheap selectors are
always checked against ground truth. Confidence is exposed on the live thread so the UI
can flag "approximately re-anchored".

**Reused bricks** (all permissive licenses, content-script safe):

- **`@medv/finder`** (MIT, 2.9 KB, v4 filters unstable CSS-in-JS/Tailwind class names) —
  generates the `css` selector signal. `css-selector-generator` is the livelier
  alternative if we need its configurability.
- **Hypothesis client anchoring** (`src/annotator/anchoring/`, BSD-2 — **vendored**, it
  is not published on npm) + **`approx-string-match`** (MIT) for `mode: 'text'`: the
  only battle-tested fuzzy text-anchoring code in existence (Range → TextPosition →
  TextQuote fallback chain with quote verification). The legacy `dom-anchor-*` packages
  and Apache Annotator (retired from the Apache Incubator in 2025) are dead — do not use.
- Storage format: **our plain TS shapes, version-tagged** (`v: 1`). The selector
  *vocabulary* borrows W3C Web Annotation concepts (quote/position/css selectors,
  redundant selector arrays), but serializing to the actual W3C JSON-LD model is pure
  ceremony for an internal tool — skipped; an exporter can be added later if interop
  ever matters.

### 3.2 Anchor lifecycle & dynamic DOM (the key differentiator)

Live threads are **`anchored ⇄ orphaned`** — a render-time condition, **never persisted**
(CKEditor's insight: *unlinked ≠ resolved* — content removal is reversible, resolution is
a human judgment; deriving orphanhood makes recovery free). The engine keeps trying:

- One shared `MutationObserver` (subtree, childList + attributes) with debounced batches
  (`requestIdleCallback`, coalesced ~100 ms).
- On nodes **removed**: any thread whose element is no longer connected → orphaned
  (badge dimmed/docked, record untouched).
- On nodes **added**: re-run `resolveAnchor()` for all orphaned threads scoped to the
  added subtrees first (cheap), full-document retry as idle fallback.
- This handles the canonical hard case: thread placed on a popover's content → popover
  closes (element removed, thread orphans) → popover reopens (subtree re-added, thread
  re-anchors and the badge reappears).
- SPA navigation: wrap `history.pushState/replaceState` + `popstate` + `hashchange`;
  on URL-key change, unload/load the page's thread set.
- Page key: configurable `pageKey(url)` normalizer; default `origin + pathname + query`
  **minus a denylist** of volatile params (`utm_*`, gclid, session/token-looking params)
  — internal tools routinely address documents via `?id=…`, so stripping the whole query
  would merge distinct documents into one thread set. Hash stripped by default.

### 3.3 Rendering (badges, composer, thread panel)

- All UI lives in **one shadow root** appended to `document.documentElement` (open root
  for debuggability; style fully isolated, `pointer-events: none` layer with
  `pointer-events: auto` on interactive bits). The host page's DOM is **never mutated**
  (no wrapper spans, no attributes) — anchoring is observational only.
- Positioning: **`@floating-ui/dom` with `autoUpdate`** for both badges (tracking the
  anchored page element) and the composer popover (`flip`/`shift` middleware for viewport
  collisions). `autoUpdate` already composes the loop we'd hand-roll: capture-phase
  passive scroll listeners (catches nested scrollers), `resize`, `ResizeObserver`, and an
  `animationFrame` mode for elements moved by page JS. `IntersectionObserver` per anchor
  to cheaply skip off-screen badges. (CSS Anchor Positioning is Baseline 2026 but
  `anchor-name` is tree-scoped — a shadow-root element can't anchor to an arbitrary page
  element, so it doesn't fit here.)
- The composer uses the **`popover` attribute** (top layer — escapes every page stacking
  context, no z-index wars). Keyboard/input events bubble out of shadow roots even with
  retargeting, so the composer stops propagation at the shadow boundary (WXT's
  `isolateEvents` in the extension; manual `stopPropagation` in the standalone build).
- Composer + thread panel: minimal — textarea, Send, Dismiss; thread view on badge click
  with replies, Resolve/Reopen, Delete. Vanilla TS, framework-free, embeddable anywhere.
- **Resolved threads**: badge hidden from the page by default (Figma/Docs behavior);
  still listed in the page-corner **thread panel** ("resolved" section) where they can
  be reopened. **Orphaned threads stay reachable**: dimmed badge docked at last-known
  position + listed in the panel's "unanchored" section — a copilot reply to a
  permanently-gone element is never invisible. The panel ships with the extension shell
  (M3), not as a later nice-to-have.
- **Trigger system — modes, fully overridable.** The engine is configured with a list
  of *modes*: `{ kind, trigger, badge? }`. `kind` is an **opaque consumer-defined
  string** stamped on created threads (§3.5) — the engine attaches zero behavior to it;
  the host does (that's how one engine powers "comment", "ask", or anything else).
  `trigger` strategies: `{ key, interaction: 'pick' }` (press key → placement mode with
  live element highlight → click to place, Esc cancels — the default) or
  `'hover'` (press while hovering places on the last-hovered element), or `false`
  (no built-in trigger — the host calls `engine.startPlacement(kind)` /
  `engine.createThread(...)` programmatically). Key handling: capture-phase `keydown`
  on `window` from `document_start`; use `event.composedPath()[0]` (not the retargeted
  `event.target`) to detect the real focus element, and ignore plain-letter triggers
  when it is `input`/`textarea`/`contenteditable`. A secondary `chrome.commands`
  shortcut (modifier combo — commands can't bind a bare letter; fires in the SW and
  round-trips to the content script) as user-remappable backup.

### 3.4 Canonical capture

At creation time the thread snapshots what it points at, so any consumer (and the user)
always has context even if the element is gone forever (Google Docs'
`quotedFileContent` / "original content deleted" pattern):

```ts
interface ElementCapture {
  outerHTML: string;      // sanitized (scripts/handlers stripped), truncated (~8 KB)
  text: string;           // normalized textContent
  selectionText?: string; // when mode === 'text'
  cssPath: string;        // human-readable locator
  page: { url: string; title: string };
  capturedAt: string;     // ISO
}
```

### 3.5 Domain model — Thread & Comment

Survey verdict: **thread-as-container wins**. Every modern comment SDK (GitHub review
threads, Liveblocks, Velt, TipTap, CKEditor) models a `Thread` entity owning anchor +
lifecycle, containing a **flat** list of comments; only the two oldest APIs (Google
Drive, Figma) use comment-with-replies and both pay for it (Google structurally cannot
delete the first message without killing the thread). Nobody nests replies. Resolution
is a **flag + who/when**, never a status enum.

```ts
type Author = 'user' | 'copilot';

interface Thread {
  id: string;                 // nanoid
  v: 1;
  pageKey: string;
  kind: string;               // consumer-defined mode discriminator ('comment', 'ask', …)
                              // opaque to comment-core; hosts key behavior on it
  anchor: AnchorDescriptor;
  capture: ElementCapture;
  status: 'open' | 'resolved';       // the ONLY lifecycle dimension
  resolvedAt: string | null;         // set together with status…
  resolvedBy: Author | null;         // …and nulled together on reopen (CKEditor contract)
  createdAt: string;
  updatedAt: string;
  // NO copilot state, NO unread, NO orphaned flag — orthogonal or derived at render time
}

interface Comment {
  id: string;
  threadId: string;
  author: Author;
  body: string;
  createdAt: string;
  editedAt: string | null;    // edited = timestamp; no placeholders needed single-user
}
```

**Thread state machine:**

| Transition | Trigger | Actor |
|---|---|---|
| *(created)* `→ open` | Send in composer — thread + first comment created **atomically** | user |
| `open → resolved` | explicit Resolve | user (the copilot may *suggest*, never execute) |
| `resolved → open` | explicit Reopen, **or** a *human* reply into a resolved thread (auto-reopen) | user only |
| `* → (gone)` | Delete thread (hard), or last comment deleted (auto-GC — Liveblocks rule) | user |

**Edge-case decisions** (from the survey — these are the non-obvious ones):

| Case | Behavior | Rationale |
|---|---|---|
| Human replies to a resolved thread | **auto-reopen** (clear `resolvedAt`/`By`) | a lone user replying to their own resolved thread unambiguously means "not done" (Google models reopen as a reply-carried action) |
| **Copilot** replies to a resolved thread | reply lands, thread **stays resolved** | GitHub semantics: a machine never flips a state the human set — a slow AI reply must not resurrect a thread resolved mid-flight |
| Delete the first comment | allowed; thread, anchor, replies survive | the payoff of thread-as-container |
| Delete the last remaining comment | thread auto-deletes | an empty thread is an invariant violation, not a state |
| Delete thread while copilot is processing | run cancelled; writers guard against dead threads | never resurrect a deleted thread to receive an AI reply |
| Resolve while copilot is processing | run finishes; reply posts **without** reopening | don't waste paid work; the stay-resolved rule makes it harmless |
| Anchor element disappears | no DB write — render-time orphan presentation, auto-reattach when it returns | unlinked ≠ resolved |
| Comment edits | in-place, `editedAt` stamped; hard delete (no tombstones) | placeholders preserve context *between people*; single-user tool doesn't need them — Liveblocks-style `deletedAt` soft delete is the upgrade path |

Auto-reopen lives in `comment-core`'s domain helper (`appendComment(threadId, {author,
body})` applies the author-aware rule), so every consumer gets the semantics for free.

### 3.6 Store abstraction

`comment-core` only sees a store interface; reactivity is part of the contract so
cross-tab and background updates flow to the UI. Threads and comments are stored
separately (comments keyed by `threadId`) so a comment write never rewrites the thread:

```ts
interface CommentStore {
  getThread(id: string): Promise<Thread | null>;
  listThreads(pageKey: string): Promise<Thread[]>;
  listAllThreads(): Promise<Thread[]>;
  putThread(t: Thread): Promise<void>;
  deleteThread(id: string): Promise<void>;          // cascades comments
  listComments(threadId: string): Promise<Comment[]>;
  putComment(c: Comment): Promise<void>;
  deleteComment(id: string): Promise<void>;
  subscribe(pageKey: string | null, cb: () => void): () => void;
}
```

Shipped implementations:

- `memory` (tests) and `localStorage` (demo pages, per-origin).
- **Extension: `chrome.storage.local` used directly from every context** (content
  scripts and SW read/write the same extension-scoped store — no RPC layer needed for
  storage). `chrome.storage.onChanged` fires in every extension context, giving
  cross-tab + SW→page reactivity for free and implementing `subscribe()`. Add
  `unlimitedStorage` to the manifest from day one (10 MB default otherwise).
- If querying/size ever outgrows JSON-in-storage: move records to **Dexie/IndexedDB
  owned by the SW** (4.4.x runs fine in SWs), fronted by `@webext-core/proxy-service`
  RPC — at that point content scripts must go through the SW, because IndexedDB in a
  content script hits the **host page's origin** (per-site quota, eviction, "Clear site
  data"), a documented MV3 trap. Same `CommentStore` interface; the swap is invisible.

### 3.7 Public API & hooks

The engine is a **page-level view** over the shared `CommentStore`; the store is the
source of truth.

```ts
const engine = createCommentEngine({
  store, pageKey?,
  modes: [                                   // default: [{ kind: 'comment', trigger: { key: 'c' } }]
    { kind: 'comment', trigger: { key: 'c' } },
    { kind: 'ask',     trigger: { key: 'a' }, badge: { icon: '?' } },
  ],
});
engine.startPlacement(kind): void;           // programmatic entry — same flow as a key trigger

// Domain hooks — everything a consumer needs to build on top:
engine.on('thread:create',  ({ thread, comment }) => {});   // Send (thread + first comment)
engine.on('thread:reply',   ({ thread, comment }) => {});   // any appended comment (author on the comment)
engine.on('thread:resolve' | 'thread:reopen' | 'thread:delete', ({ thread }) => {});
engine.on('thread:anchored' | 'thread:orphaned' | 'thread:click', ({ thread }) => {});

// Programmatic surface (used by hosts writing on behalf of others, e.g. the extension
// appending a copilot reply — same author-aware auto-reopen rules apply):
engine.appendComment(threadId, { author, body }): Promise<Comment>;
engine.resolve(threadId) / engine.reopen(threadId) / engine.delete(threadId);
engine.listThreads(): Thread[];      // this page's threads (live view)
engine.destroy(): void;
```

Domain helpers (`appendComment` etc.) are also exported **store-level** (no engine/DOM
required) so a background context can apply the same rules against the raw store —
e.g. the extension SW appending a copilot reply while the page is closed; store
reactivity makes it appear on next load. `comment-core` knows nothing about who its
consumers are — "copilot" is just an `Author` value.

### 3.8 Testing & robustness benchmark

- Unit: anchoring/resolution/fingerprint scoring + domain rules (auto-reopen matrix,
  auto-GC, cascade delete) in vitest + happy-dom with synthetic DOM mutations.
- `apps/demo`: static pages covering the scenario matrix (static page, list reorder,
  popover open/close, infinite scroll, SPA route change, attribute churn).
- `bench/`: **agent-browser**-driven scenarios against a real-site corpus (e.g. GitHub PR
  page, MDN, Wikipedia, a Radix/shadcn demo with popovers, a React SPA) — script: place
  threads → perturb (reload / mutate / navigate) → assert badge is on the right element.
  Output a re-anchor success-rate table per site per scenario; iterate visually with
  agent-browser screenshots. This bench is the main iteration loop for M2.

---

## 4. Module 2 — Copilot (generic agent runtime)

### 4.1 Independence contract: trigger/listen, host-registered everything

`copilot` is a **standalone browser agent runtime** — publishable on its own, zero
imports from `comment-core`. It knows about: providers, tools, runs. It does **not**
know about: threads, comments, anchors, pages.

```ts
const copilot = createCopilot({
  provider,                        // AI SDK model instance (injected)
  systemPrompt: string,
  tools: ToolDefinition[],         // host-registered: name, description, zod schema, execute
  runStore: RunStore,              // injected persistence for runs (memory | chrome.storage)
});

// Trigger: fire a run with an input + opaque context payload
const handle = copilot.trigger({ input: string, context?: unknown, runId?: string });

// Listen: run lifecycle events (the host bridges these wherever it wants)
copilot.on('run:start' | 'run:step' | 'run:token' | 'run:done' | 'run:error' | 'run:cancelled', cb);
copilot.cancel(runId);
copilot.resumePending();           // host calls on wake — restarts stale runs
```

- **Tools are the host's.** The runtime ships with none. The extension registers
  comment-flavored tools (§5); a different host could register totally different ones.
- **Output is an event, not a side effect.** `run:done` carries the final text; the
  *host* decides what to do with it (append to a thread, show a toast, ignore). Tools
  let the model act mid-run; `run:done` is the guaranteed terminal signal.
- `context` is opaque to the runtime — it is serialized into the prompt by a
  host-provided `renderContext(context) => string` (default: JSON). The copilot never
  interprets it.

### 4.2 Runs — the processing state machine

Survey conclusion applied: AI processing state **never pollutes the domain lifecycle**
of whatever the host manages (exactly how GitHub keeps `isOutdated` out of resolution).
Runs are the copilot's own records:

```ts
interface Run {
  id: string;
  state: 'queued' | 'processing' | 'done' | 'error' | 'cancelled';
  input: string;
  context?: unknown;
  output?: string;            // set on done
  error?: string;             // set on error; retry = a new run
  attempts: number;
  heartbeat: string;
  createdAt: string;
}
```

`queued → processing → done | error`; `→ cancelled` from queued/processing (host calls
`cancel`, e.g. when a thread is deleted). Errors are delivery failures of one run, not
properties of the conversation — retry is a fresh trigger.

### 4.3 Agent loop

**Vercel AI SDK (`ai`, v6+)** — confirmed to run cleanly in MV3 SWs (fetch-based,
worker-runtime support; community extensions ship on it). Use the **`ToolLoopAgent`**
abstraction (model + tools + system prompt + `stopWhen: stepCountIs(n)`, tool-approval
hooks, streaming) — or drop to `generateText` + `stopWhen` if we want zero abstraction.
Cap at ~8–10 steps. Not LangChain (nanobrowser's stack — far more machinery than a
4-tool copilot needs), and not a hand-rolled loop (the SDK loop costs the same to call
and is better tested). Tools are `tool({ description, inputSchema: z.object(...),
execute })`.

### 4.4 Providers & models (config, not code)

- **Primary brain: Anthropic API, called directly from the SW.** With
  `https://api.anthropic.com/*` in `host_permissions`, extension-context requests bypass
  CORS entirely — no proxy server. (`@ai-sdk/anthropic` via
  `createAnthropic({ headers: { 'anthropic-dangerous-direct-browser-access': 'true' } })`
  as belt-and-suspenders; only strictly needed from page contexts.) Key entered in the
  options page, stored in `chrome.storage` — never bundled (a CRX is unzippable).
  Default model `claude-opus-5`; a "fast" tier (`claude-haiku-4-5`) selectable per
  config since latency is a stated priority — though per research, perceived speed comes
  mostly from streaming-first UI + low step counts, not the model tier.
- **Chrome built-in Prompt API (Gemini Nano): opportunistic accelerator only, not the
  loop's brain.** Stable for extensions since Chrome 138 (incl. the SW as
  `self.LanguageModel`), but: **no stable tool calling** (function-calling proposal still
  experimental), **~6K-token context** with silent eviction mid-loop, multi-GB model
  download + hardware gates. Integration: `@built-in-ai/core` (AI SDK provider for the
  stable `LanguageModel` API, with server-model fallback) for one-shot subtasks
  (summarize selection, title a thread, pre-classify) when
  `LanguageModel.availability() === 'available'` — same call sites, silent fallback to
  remote otherwise. Re-evaluate as loop runtime when native function calling hits
  stable. Skip WebLLM entirely (multi-GB, WebGPU, weak tool calling).

### 4.5 Surviving the MV3 service worker

MV3 service workers die: 30 s idle kill, ~5 min cap per event, and a `fetch()` whose
response takes > 30 s to first byte can kill the SW (streaming mitigates — first token
arrives fast). Design: runs are **data, not promises** (§4.2), and the runtime stays
host-agnostic — the MV3 specifics are host duties, documented as such:

- **No mid-loop checkpoint/resume — deliberately.** For 8–10-step runs on an internal
  tool, resuming a half-done LLM loop is maximum fiddliness for minimum payoff. If the
  SW dies mid-run, `resumePending()` **restarts the run from scratch** (costs tokens,
  not correctness): `run:done` carries `runId`, so the host's append is idempotent.
- **Keepalive** while a run is active (host: the documented 25 s API-ping pattern,
  `setInterval(chrome.runtime.getPlatformInfo, 25_000)`).
- **Watchdog** (host): a repeating `chrome.alarms` (min 30 s period, survives SW death
  and browser restart) calls `resumePending()`, which restarts runs with stale
  heartbeats — bounded by `attempts <= 3`, then `run:error`.
- **Streaming**: `run:token` events are best-effort (host relays over a
  `chrome.runtime` Port to the open page — which also extends SW lifetime); `run:done`
  via the run store is the durable channel. If no page is listening nothing is lost.
- **Escape hatch** if runs ever exceed ~4–5 min: host the LLM fetch in an **offscreen
  document** (no SW lifetime limits, and its messages keep the SW alive) — the
  established pattern for AI-agent extensions. Not expected for v1's short loops.

### 4.6 Configuration (options page)

API key, model, system prompt (textarea), tool toggles, trigger key. Stored in
`chrome.storage.local`. Deliberately minimal.

---

## 5. Extension shell (MV3) — the bridge

The only place where the two modules meet:

- **Two entrypoints, one engine**: the extension registers two modes —
  `comment` (`C`) and `ask` (`A`). Both leave the same kind of anchored trace via the
  engine; **the difference is entirely bridge-side behavior keyed on `thread.kind`**:
  `comment` runs the copilot as a discussion participant (review/feedback prompt),
  `ask` runs it as a question-answerer/actor (different system prompt, possibly
  different tool set or model tier). Adding a third behavior later = one more mode
  entry + one more bridge branch; `comment-core` doesn't change.
- **Hook → trigger**: content script listens to `thread:create` / `thread:reply`
  (human-authored comments only — copilot replies must not re-trigger the copilot) and
  sends `{ threadId, kind, pageKey }` to the SW over `@webext-core/messaging`. The SW
  builds the run input from `capture` + the full comment list (stateless per run —
  submit and follow-up share one code path) and calls
  `copilot.trigger({ input, context })` with the kind-specific config.
- **Tools registration** (SW side, wrapping the `CommentStore` + content-script RPC):

  | Tool | Runs in | Notes |
  |---|---|---|
  | `get_page_context` | content script | url, title, heading outline, selection |
  | `list_threads` / `read_thread` | SW (`CommentStore`) | works even if tab closed |
  | `get_thread_element_html` | content script, fallback: stored capture | live DOM if available |
  | `show_message` | content script | toast/modal to the user on the page |

  Replying is **not a tool**: the `run:done` output is the reply. The bridge appends it
  via the store-level `appendComment(threadId, { author: 'copilot', body })` — which
  applies the domain rules (never reopens a resolved thread) — and checks the thread
  still exists first (deleted → drop the output). `thread:delete` → `copilot.cancel`.
- **Scaffold: WXT** — the 2026 consensus default (active, Vite-based, manifest
  generation, `createShadowRootUi` with `cssInjectionMode: 'ui'` and `isolateEvents`
  doing exactly what §3.3 needs). Plasmo is stalled (14+ months without a release,
  Parcel lock-in); CRXJS survived its near-archival but offers no content-script UI
  helpers. Known WXT caveat: `all: initial` reset doesn't cover the page's `<html>`
  font-size — set an explicit `font-size` on `:host` (no rem-dependent styling).
- Content script on `<all_urls>` (`document_start` for the key listener): instantiate
  `comment-core` + `comment-ui` with the `chrome.storage`-backed store; expose the RPC
  endpoints for copilot DOM tools; forward create/reply hooks to the SW.
- Background SW: copilot runtime + run store + watchdog.
- Options page: config (§4.6). On the **demo page**, the bridge is replaced by a tiny
  echo responder wired to the same hooks (canned reply after a delay) — Module 1 fully
  exercisable without extension or AI, and the hook contract tested for free.

## 6. Reuse vs rebuild — final decisions

| Concern | Decision | Why |
|---|---|---|
| CSS selector generation | **reuse `@medv/finder`** (or `css-selector-generator`) | 2.9 KB, filters unstable class names; one signal among several |
| Fuzzy text anchoring | **vendor Hypothesis `annotator/anchoring` + `approx-string-match`** | only battle-tested fuzzy anchoring in existence; BSD-2/MIT; not on npm |
| Element fingerprint + scored re-identification | **rebuild** (~300–500 LOC) | exists nowhere in OSS; Playwright priority order + puppeteer-replay redundancy pattern |
| MutationObserver re-anchoring lifecycle | **rebuild** (~200 LOC) | the genuinely novel part; no library has it |
| Thread/comment domain model | **rebuild, following the surveyed consensus** (thread-as-container, flat replies, flag-based resolution, separate Run entity) | comment SDKs (Liveblocks/Velt/TipTap) drag in collab infra we don't want; the model itself is small |
| Storage format | **plain version-tagged TS records** (W3C-inspired selector vocabulary, no JSON-LD) | interop ceremony is dead weight for an internal tool |
| Badge/popover positioning | **reuse `@floating-ui/dom`** | `autoUpdate` is exactly the tracking loop we'd hand-roll |
| CS ⇄ SW messaging | **reuse `@webext-core/messaging` + `proxy-service`** | typed, tiny, maintained, WXT-aligned |
| Agent loop | **reuse AI SDK `ToolLoopAgent`** | maintained loop + zod tools + provider abstraction; MV3-SW-proven |
| Local model | **reuse `@built-in-ai/core`** (optional path) | stable `LanguageModel` wrapper with remote fallback |
| Dead ends ruled out | Apache Annotator (retired 2025), `dom-anchor-*` (2017), annotator.js, rangy, web-highlighter, `chrome-ai` (defunct `window.ai` era), WebLLM, LangChain-in-extension | all dead, stale, or oversized |

## 7. Milestones

| # | Deliverable | Proof |
|---|---|---|
| M0 | Scaffold: pnpm workspace, ox tooling, extension skeleton, demo page | `pnpm ci` green; extension loads |
| M1 | `comment-core` v0 + UI: hotkey → badge + composer + thread view (reply/resolve/reopen/delete, full domain rules), localStorage, reload-safe on static pages, **demo echo responder** on the hooks | demo walkthrough incl. Send→reply→resolve→reopen |
| M2 | Robust anchoring: orphan/re-anchor lifecycle, SPA nav, bench harness | bench success table ≥ target on corpus |
| M3 | Extension shell: works on any site, chrome.storage store, cross-tab, **thread panel (resolved + unanchored sections)** | manual run on 5 real sites |
| M4 | Copilot MVP: create/reply → background run → reply in thread; 4 tools; survives refresh mid-run; **minimal config (API key + model)** | scripted E2E with agent-browser |
| M5 | Full options page (prompt, tools, trigger), Prompt API provider (if viable), polish | — |

## 8. Risks & open questions

- **Anchoring is best-effort by nature** — canvas-rendered UIs, closed shadow roots, and
  heavily virtualized lists will defeat it; the bench defines "good enough".
- **Iframes**: out of scope v1 (threads attach per-frame document only).
- **Hotkey collisions** with page shortcuts — capture-phase + editable-field guard +
  configurable key should cover the internal-tool bar.
- **SW death mid-run** — mitigated by the persisted run queue + alarms watchdog; worst
  case a run restarts from scratch (bounded attempts). Offscreen document as escape
  hatch for long runs.
- **Slow first token** — a fetch taking > 30 s to first byte can kill the SW; always
  stream, keep prompts small.
- **Trigger loops** — the bridge must only trigger on *human* comments; the author field
  is the guard. Watch for other feedback loops as tools grow (e.g. a tool that writes
  comments).
- To decide with user: text-selection mode in v1 or element-only; default model
  (`claude-opus-5` quality-first vs `claude-haiku-4-5` latency-first); exact `ask`-mode
  behavior (answer inline in thread vs modal vs page action).
