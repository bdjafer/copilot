# exp-spec — Plan

> Status: **v1 — ready for review.** Technology choices are grounded in a 2026 survey of
> the annotation/anchoring OSS landscape, Chrome built-in AI status, and MV3 architecture
> (sources in PR description).

## 0. Context & goals

Internal Chrome extension (never published, minimal security constraints) to improve the
experience of reviewing/authoring specs in the browser — but built as **two decoupled,
independently testable modules**:

1. **Marker engine** (`marker-core`) — drop a persistent "marker" on any element of any
   HTML page via a keyboard trigger, with a composer popover, robust re-anchoring across
   reloads and dynamic DOM, and a clean hook-based API. Fully agnostic: usable via a plain
   `<script>` tag on any page, no extension required.
2. **Browser copilot** (`copilot`) — a small LLM agent running in the extension. When a
   marker is submitted, the copilot receives it as context, runs a tool-using loop in the
   background (survives page refresh), and can reply in the marker's thread, inspect the
   page, list/read markers, or surface a modal to the user.

Module 2 depends on Module 1 **only through its public hooks and the shared
`MarkerStore` interface** (§3.6–3.7). Module 1 has zero knowledge of the copilot.

Out of scope (for now, explicitly deferred): protocol to local coding agents
(Claude Code / Codex), multi-user sync, auth, Chrome Web Store hardening.

---

## 1. The experience (walkthrough)

1. On any page, hover an element (or select text) and press the trigger key (default:
   `A`, configurable — only fires outside editable fields). The engine continuously
   tracks the last-hovered element (`mouseover`); on trigger it draws a highlight
   outline on that element so you can confirm the target (an active text selection wins
   over hover and creates a text-mode marker).
2. A badge is pinned to the element and a small popover composer opens. Type a note
   (optional), press **Send** — or dismiss (nothing is persisted until Send).
3. On send, the marker is persisted and the `marker:submit` hook fires. In the extension,
   this enqueues a copilot job. The badge shows a "processing" state.
4. You can navigate away, refresh, close the tab. The job keeps processing in the
   background. When you come back to the page, the marker re-anchors to its element
   (even if the element was removed and re-added, e.g. a popover) and shows the copilot's
   reply as a thread under the marker.
5. Clicking a badge opens the thread: read replies, send follow-ups (each follow-up
   enqueues a new copilot job with the full thread + capture as context), delete the
   marker. Deleting removes badge + record everywhere and cancels any in-flight job.

---

## 2. Architecture

pnpm monorepo (workspace conventions: `@astrale-os/ox` for lint/format/typecheck — oxlint,
oxfmt, tsgo; no prettier/eslint/tsc).

```
exp-spec/
  packages/
    marker-core/     # headless engine: anchoring, storage, lifecycle, events (no UI, no extension APIs)
    marker-ui/       # badges + composer popover + thread panel, rendered in a shadow root
    copilot/         # agent runtime: loop, tools registry, providers, job queue (no DOM access)
    extension/       # MV3 extension wiring everything (WXT)
  apps/
    demo/            # static test pages loading marker-core+ui via <script> — no extension needed
  bench/             # agent-browser scenarios + site corpus for anchoring robustness
```

Dependency rule: `extension → {marker-core, marker-ui, copilot}`;
`marker-ui → marker-core`; `copilot → marker-core` (types + `MarkerStore` only). Nothing
depends on `extension`.

Build discipline: `marker-core`/`marker-ui`/`copilot` never import `chrome.*` or `wxt/*`
— storage, messaging, and transport are injected interfaces. The extension supplies
chrome-backed adapters; the demo page supplies in-memory/localStorage ones. Core packages
build with Vite lib mode (ESM + IIFE) so the demo loads them via `<script src>`.

---

## 3. Module 1 — Marker engine

### 3.1 Anchoring model

The hard problem: re-attach a marker to "the same element" after reload, DOM mutation, or
element removal/re-insertion. Research verdict (2026 survey): **text anchoring is solved
OSS (reuse), element anchoring is not (rebuild)**. No single selector survives all of
that, so each marker stores an **ordered fallback chain of selectors plus a fingerprint**
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

**Resolution** (`resolve(anchor): { element, confidence } | null`): resolve selectors
independently; every candidate is **verified against the fingerprint** with a similarity
score (tag match required; semantic signals — role/name/data-* — weighted above
classes/structure; text digest as final verifier). Accept above a threshold, else
continue; final fallback is a fingerprint scan over a bounded candidate set (elements of
same tag). This mirrors Hypothesis's `maybeAssertQuote` trick: **never let a
stale-but-valid CSS path silently attach to the wrong element** — cheap selectors are
always checked against ground truth. Confidence is stored on the live marker so the UI
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
  ceremony for an internal tool — skipped; a W3C exporter can be added later if interop
  ever matters.

### 3.2 Lifecycle & dynamic DOM (the key differentiator)

Markers are state machines: `anchored ⇄ orphaned`, plus `detached` (persisted but page
not open). The engine keeps trying:

- One shared `MutationObserver` (subtree, childList + attributes) with debounced batches
  (`requestIdleCallback`, coalesced ~100 ms).
- On nodes **removed**: any marker whose element is no longer connected → `orphaned`
  (badge hidden, record kept).
- On nodes **added**: re-run `resolve()` for all orphaned markers scoped to the added
  subtrees first (cheap), full-document retry as idle fallback.
- This handles the canonical hard case: marker placed on a popover's content → popover
  closes (element removed, marker orphans) → popover reopens (subtree re-added, marker
  re-anchors and the badge reappears).
- SPA navigation: wrap `history.pushState/replaceState` + `popstate` + `hashchange`;
  on URL-key change, unload/load the page's marker set.
- Page key: configurable `pageKey(url)` normalizer; default `origin + pathname + query`
  **minus a denylist** of volatile params (`utm_*`, gclid, session/token-looking params)
  — internal tools routinely address documents via `?id=…`, so stripping the whole query
  would merge distinct documents into one marker set. Hash stripped by default.

### 3.3 Rendering (badges & popover)

- All UI lives in **one shadow root** appended to `document.documentElement` (open root
  for debuggability; style fully isolated, `pointer-events: none` layer with
  `pointer-events: auto` on interactive bits). The host page's DOM is **never mutated**
  (no wrapper spans, no attributes) — anchoring is observational only.
- Positioning: **`@floating-ui/dom` with `autoUpdate`** for both badges (tracking the
  anchored page element) and the composer popover (`flip`/`shift` middleware for viewport
  collisions). `autoUpdate` already composes the loop we'd hand-roll: capture-phase
  passive scroll listeners (catches nested scrollers), `resize`, `ResizeObserver`, and an
  `animationFrame` mode for elements moved by page JS. `IntersectionObserver` per anchor
  to cheaply skip off-screen badges. (Note: CSS Anchor Positioning is Baseline 2026 but
  `anchor-name` is tree-scoped — a shadow-root element can't anchor to an arbitrary page
  element, so it doesn't fit; usable later for popovers anchored to our own badges.)
- The composer uses the **`popover` attribute** (top layer — escapes every page stacking
  context, no z-index wars). Keyboard/input events bubble out of shadow roots even with
  retargeting, so the composer stops propagation at the shadow boundary (WXT's
  `isolateEvents` in the extension; manual `stopPropagation` in the standalone build).
- Composer: minimal — textarea, Send, Dismiss; thread panel on badge click. Vanilla TS,
  framework-free, to keep `marker-ui` embeddable anywhere.
- Keyboard trigger: capture-phase `keydown` on `window` from `document_start`; use
  `event.composedPath()[0]` (not the retargeted `event.target`) to detect the real focus
  element, and ignore plain-letter triggers when it is `input`/`textarea`/
  `contenteditable`. A secondary `chrome.commands` shortcut (modifier combo — commands
  can't bind a bare letter, and they fire in the SW so they round-trip to the content
  script, losing nothing since hover state lives there) as user-remappable backup.
- **Orphaned markers stay reachable**: an orphan is shown as a dimmed badge docked at
  its last-known position (or in the page-corner marker panel), so a copilot reply to a
  permanently-gone element is never invisible. The panel (list of all markers on the
  page, incl. orphans) ships with the extension shell, not as a later nice-to-have.

### 3.4 Canonical capture

At creation time the marker snapshots what it points at, so the copilot (and the user)
always has context even if the element is gone forever:

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

### 3.5 Marker record & thread

```ts
interface MarkerRecord {
  id: string;                 // nanoid
  v: 1;
  pageKey: string;
  anchor: AnchorDescriptor;
  capture: ElementCapture;
  note: string;               // user's initial text ('' allowed)
  thread: ThreadMessage[];    // { id, role: 'user'|'copilot'|'system', text, at }
  status: 'submitted' | 'processing' | 'replied' | 'error';  // composer drafts are in-memory only
  createdAt: string;
  updatedAt: string;
}
```

### 3.6 Storage abstraction

`marker-core` only sees a store interface; reactivity is part of the contract so
cross-tab and background updates flow to the UI. The same interface is used by the
page-side engine **and** by the copilot in the service worker — it is the real seam
between the two modules:

```ts
interface MarkerStore {
  get(id: string): Promise<MarkerRecord | null>;
  list(pageKey: string): Promise<MarkerRecord[]>;
  listAll(): Promise<MarkerRecord[]>;                 // copilot: cross-page view
  put(record: MarkerRecord): Promise<void>;
  delete(id: string): Promise<void>;
  subscribe(pageKey: string | null, cb: (records: MarkerRecord[]) => void): () => void;
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
  data"), a documented MV3 trap. Same `MarkerStore` interface; the swap is invisible to
  both modules.

### 3.7 Public API — and the exact copilot seam

The engine is a **page-level view** over the shared `MarkerStore`; the store is the
source of truth. Two contracts, cleanly split:

```ts
// Page side (content script / demo page)
const engine = createMarkerEngine({ store, pageKey?, trigger?: { key: 'a' } });

engine.on('marker:submit',   ({ marker }) => {});          // initial Send
engine.on('marker:followup', ({ marker, message }) => {}); // new user message in a thread
engine.on('marker:anchored' | 'marker:orphaned' | 'marker:click' | 'marker:deleted', ...);

engine.list(): MarkerRecord[];       // this page's markers (live view)
engine.delete(id): Promise<void>;
engine.destroy(): void;
```

- **The copilot never sees the engine.** Its contract is the `MarkerStore` (§3.6): it
  reads records with `get`/`list`/`listAll` and replies by `put`-ing updated records
  (thread append + status). Store reactivity propagates the reply to any open page —
  including replies written while the page was closed, which appear on next load.
- The `extension` package is the only glue: it listens to `marker:submit` /
  `marker:followup` in the content script and forwards `{ markerId, pageKey }` to the
  SW job queue over `@webext-core/messaging`. On the demo page, the same hooks feed a
  trivial **echo responder** (canned reply after a delay) so Module 1 is fully
  exercisable without the extension — and the hook contract gets tested for free.
- Jobs are **stateless with respect to the loop**: each job rebuilds its LLM context
  from `capture` + the full `thread`, so submit and follow-up share one code path.

### 3.8 Testing & robustness benchmark

- Unit: anchoring/resolution/fingerprint scoring in vitest + happy-dom with synthetic DOM
  mutations.
- `apps/demo`: static pages covering the scenario matrix (static page, list reorder,
  popover open/close, infinite scroll, SPA route change, attribute churn).
- `bench/`: **agent-browser**-driven scenarios against a real-site corpus (e.g. GitHub PR
  page, MDN, Wikipedia, a Radix/shadcn demo with popovers, a React SPA) — script: place
  markers → perturb (reload / mutate / navigate) → assert badge is on the right element.
  Output a re-anchor success-rate table per site per scenario; iterate visually with
  agent-browser screenshots. This bench is the main iteration loop for M2.

---

## 4. Module 2 — Browser copilot

### 4.1 Agent runtime

**Vercel AI SDK (`ai`, v6+) in the background service worker** — confirmed to run
cleanly in MV3 SWs (fetch-based, worker-runtime support; community extensions ship on
it). Use the **`ToolLoopAgent`** abstraction (model + tools + system prompt +
`stopWhen: stepCountIs(n)`, tool-approval hooks, streaming) — or drop to
`generateText` + `stopWhen` if we want zero abstraction. Cap at ~8–10 steps. Not
LangChain (nanobrowser's stack — far more machinery than a 4-tool copilot needs), and
not a hand-rolled loop (the SDK loop costs the same to call and is better tested).
Tools are `tool({ description, inputSchema: z.object(...), execute })` — `execute` in
the SW messages content scripts or touches storage.

### 4.2 Providers & models (config, not code)

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

### 4.3 Tools (initial set)

| Tool | Runs in | Notes |
|---|---|---|
| `get_page_context` | content script | url, title, heading outline, selection |
| `list_markers` / `read_marker` | SW (`MarkerStore`) | works even if tab closed |
| `reply_to_marker` | SW (`MarkerStore`) | appends to thread, sets status |
| `get_marker_element_html` | content script, fallback: stored capture | live DOM if available |
| `show_message` | content script | toast/modal to the user on the page |

DOM-touching tools go through a **typed RPC bridge**: `@webext-core/messaging`
(protocol-map typed messages) + `@webext-core/proxy-service` (call SW-hosted services
from content scripts as plain async functions) — actively maintained, same author as
WXT, and WXT's officially suggested stack. If the marker's tab is gone, DOM tools
degrade to the stored `capture`.

### 4.4 Statefulness: job queue that survives the service worker

MV3 service workers die: 30 s idle kill, ~5 min cap per event, and a `fetch()` whose
response takes > 30 s to first byte can kill the SW (streaming mitigates — first token
arrives fast). Design: jobs are **data, not promises**.

- `marker:submit` / `marker:followup` → persist `{ jobId, markerId, state, attempts,
  heartbeat }`, then run the loop in the SW.
- **No mid-loop checkpoint/resume — deliberately.** For 8–10-step jobs on an internal
  tool, resuming a half-done LLM loop is maximum fiddliness for minimum payoff. If the
  SW dies mid-job, the watchdog **restarts the job from scratch** (costs tokens, not
  correctness): the reply is tagged with `jobId`, so appending it is idempotent.
- **Keepalive** while a job runs: the documented 25 s API-ping pattern
  (`setInterval(chrome.runtime.getPlatformInfo, 25_000)`).
- **Watchdog**: a repeating `chrome.alarms` (min 30 s period, survives SW death and
  browser restart) restarts jobs whose heartbeat went stale — bounded by
  `attempts <= 3`, after which the marker goes to `status: 'error'` with a system
  message in the thread (badge shows the error state; retry = send a follow-up).
- **Delete cancels**: deleting a marker marks its job cancelled; the loop checks marker
  existence before every store write, so a deleted marker is never resurrected.
- **UI updates**: the durable channel is the store (status transitions + replies via
  `onChanged`). Token-level streaming is a best-effort `chrome.runtime` Port from SW to
  the open page (which also extends SW lifetime); if no page is listening nothing is
  lost — the store stays the source of truth.
- **Escape hatch** if jobs ever exceed ~4–5 min or need robust long streaming: run the
  LLM fetch in an **offscreen document** (no SW lifetime limits, and its messages keep
  the SW alive) — the established pattern for AI-agent extensions. Not expected for
  v1's short loops.

### 4.5 Configuration (options page)

API key, model, system prompt (textarea), tool toggles, trigger key. Stored in
`chrome.storage.local`. Deliberately minimal.

---

## 5. Extension shell (MV3)

- **Scaffold: WXT** — the 2026 consensus default (active, Vite-based, manifest
  generation, `createShadowRootUi` with `cssInjectionMode: 'ui'` and `isolateEvents`
  doing exactly what §3.3 needs). Plasmo is stalled (14+ months without a release,
  Parcel lock-in); CRXJS survived its near-archival but offers no content-script UI
  helpers. Known WXT caveat: `all: initial` reset doesn't cover the page's `<html>`
  font-size — set an explicit `font-size` on `:host` (no rem-dependent styling).
- Content script on `<all_urls>` (`document_start` for the key listener): instantiate
  `marker-core` + `marker-ui` with the `chrome.storage`-backed store; expose the RPC
  endpoints for copilot DOM tools; forward submit/follow-up hooks to the SW job queue.
- Background SW: copilot runtime + job queue (+ store owner only if/when Dexie lands).
- Options page: config (§4.5). Popup (later): marker list for current page.

## 6. Reuse vs rebuild — final decisions

| Concern | Decision | Why |
|---|---|---|
| CSS selector generation | **reuse `@medv/finder`** (or `css-selector-generator`) | 2.9 KB, filters unstable class names; one signal among several |
| Fuzzy text anchoring | **vendor Hypothesis `annotator/anchoring` + `approx-string-match`** | only battle-tested fuzzy anchoring in existence; BSD-2/MIT; not on npm |
| Element fingerprint + scored re-identification | **rebuild** (~300–500 LOC) | exists nowhere in OSS; Playwright priority order + puppeteer-replay redundancy pattern |
| MutationObserver re-anchoring lifecycle | **rebuild** (~200 LOC) | the genuinely novel part; no library has it |
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
| M1 | `marker-core` v0 + UI: hotkey → badge + composer, localStorage, reload-safe on static pages, **demo echo responder** on the hooks | demo page walkthrough incl. Send→reply |
| M2 | Robust anchoring: orphan/re-anchor lifecycle, SPA nav, bench harness | bench success table ≥ target on corpus |
| M3 | Extension shell: works on any site, chrome.storage store, cross-tab, thread panel, **marker panel incl. orphans**, delete | manual run on 5 real sites |
| M4 | Copilot MVP: submit/follow-up → background agent → threaded reply; 4 core tools; survives refresh mid-job; **minimal config (API key + model)** | scripted E2E with agent-browser |
| M5 | Full options page (prompt, tools, trigger), Prompt API provider (if viable), polish | — |

## 8. Risks & open questions

- **Anchoring is best-effort by nature** — canvas-rendered UIs, closed shadow roots, and
  heavily virtualized lists will defeat it; the bench defines "good enough".
- **Iframes**: out of scope v1 (markers attach per-frame document only).
- **Hotkey collisions** with page shortcuts — capture-phase + editable-field guard +
  configurable key should cover the internal-tool bar.
- **SW death mid-agent-loop** — mitigated by the persisted job queue + alarms watchdog;
  worst case a job restarts from scratch (bounded attempts). Offscreen document as
  escape hatch for long jobs.
- **Slow first token** — a fetch taking > 30 s to first byte can kill the SW; always
  stream, keep prompts small.
- To decide with user: default trigger key; text-selection mode in v1 or element-only;
  default model (`claude-opus-5` quality-first vs `claude-haiku-4-5` latency-first).
