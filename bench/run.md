# bench/run.md — the real-browser anchoring bench

PLAN §3.8's benchmark, as actually executed: a real Chromium driven by
[`agent-browser`](https://github.com/agent-browser/agent-browser) over CDP, placing real comment
threads with real keystrokes and real clicks, then asserting against the live DOM.

Results — including the three failures — are in [`results.md`](./results.md). Raw evidence is in
`results.json` (demo pages) and `results-sites.json` (real sites); screenshots in `shots/`.

## What this bench proves, and what it does not

It proves that a thread placed on an element **comes back on the same element** across reload,
list reordering, unmount/remount, feed recycling, SPA route changes and attribute churn — and
that when the element is genuinely gone the thread **orphans** rather than attaching to something
else. That last half matters more than the first: a badge that silently moves to a different
element is worse than a badge that disappears, so the mis-anchor check runs on *every* assertion
that has a baseline, not only on the ones that expect a match.

It does **not** prove anything about multi-user sync, auth-walled pages, cross-origin iframes, or
long-lived (days-old) records against a site that has since been redesigned. It is a robustness
bench, not a soak test.

## Prerequisites

```bash
npm i -g agent-browser && agent-browser install   # Chromium for CDP
pnpm install                                      # at the exp-spec root
```

Versions this bench was last run on are recorded at the top of `results.md`.

## Running it

```bash
# 1. Build the demo (the bench runs against the built output, not a dev server)
pnpm --filter exp-spec-demo build

# 2. Serve it on a free port
cd apps/demo && pnpm exec sirv dist --dev --port 4272 --host 127.0.0.1 &

# 3. Demo-page scenarios (all seven), then the real-site smoke
BENCH_BASE=http://127.0.0.1:4272 node bench/run.mjs
node bench/sites.mjs

# a subset, by name:
BENCH_BASE=http://127.0.0.1:4272 node bench/run.mjs popover spa
```

| Env var | Default | Meaning |
| --- | --- | --- |
| `BENCH_BASE` | `http://127.0.0.1:4271` | Where `apps/demo/dist` is served |
| `BENCH_SESSION` | `expspec-bench` | `agent-browser` session name (one browser per session) |
| `BENCH_BIN` | `agent-browser` | CLI binary |

`run.mjs` **overwrites `results.json` with only the scenarios it ran** — a subset run replaces the
full table. Always run it without arguments before quoting numbers.

Outputs: `bench/results.json`, `bench/results-sites.json`, `bench/shots/*.png`.
`bench/results.md` is written by hand from those files.

### Repeat count — the bench records one run, so say so

`run.mjs` has no repeat mode and `results.json` holds a single execution. A scenario is only
known to be deterministic once it has been run more than once, so **`results.md` must state the
repeat count behind every claim of stability** and must not promote an n = 1 pass to a general
statement. Not hypothetical: `attribute-churn` reads 5/6 in the recorded run and scores 2/6–5/6
across four (`results.md` F4), and the page's headline conclusion had to be withdrawn. Before
quoting a scenario as stable:

```bash
for i in 1 2 3 4; do BENCH_BASE=http://127.0.0.1:4272 node bench/run.mjs <scenario>; done
```

and compare the pass counts. Each iteration overwrites `results.json`, so re-run the full bench
afterwards to restore the recorded evidence.

## Method

### Placement is real, not programmatic

No scenario calls `engine.placement.start()` / `submit()` or `engine.createThread()`. Every
thread in this bench is placed the way a human places one (`lib/driver.mjs → placeComment`):

1. `agent-browser press c` — a real `keydown` through CDP, caught by `comment-core`'s
   capture-phase `window` listener (registered at `document_start`);
2. assert `engine.placement.get().phase === 'picking'` — proof the key landed;
3. `agent-browser click <selector>` — a real mouse click at the element's centre;
4. assert `phase === 'composing'` **and** that `shadowRoot.activeElement` is the composer's
   `TEXTAREA` — proof the click landed on the intended element and comment-ui focused the input;
5. `agent-browser keyboard type "…"` — real keystrokes, through the shadow boundary;
6. `agent-browser press Control+Enter` — submit.

Key events through CDP were **not** flaky; the programmatic seam was never needed. If it ever
becomes necessary, it must be recorded per-scenario in `results.json`, because "placed through the
API" and "placed through the UI" are different claims.

Two ergonomic traps this discovered, both handled in the driver and worth knowing before reading
the code:

- **A focused `<input type="checkbox">` swallows the trigger key.** `isEditableTarget`
  (`placement.ts`) treats every `<input>` as editable regardless of `type`, so after a scenario
  clicks a demo checkbox it must call `blurActive()` before pressing `c`. Recorded as an
  observation in `results.md`, not as an assertion.
- **A second press of the same trigger key cancels placement** (`placement.ts`, §4.5 toggle). Two
  `press c` in a row leave you in no placement mode at all, which looks exactly like "the key
  never worked".

### Assertions are DOM assertions

Every check is JSON returned from `agent-browser eval`, never a pixel comparison. The probe reads,
for one thread: the engine's live view (`getThreadView` → status, confidence, `via`, resolved
element), the badge in comment-ui's shadow root (`data-anchor`, `data-status`, `hidden`, opacity,
border style, orphan glyph, bounding box), and the thread panel row (section + section counts).
Screenshots are evidence for a human reader; they are never the test.

### "The same element" is defined by content, not position

`idOf()` keys an element on `TAG|normalized textContent` and reports its structural path
*separately*. That is what makes "re-anchored to the same element" checkable after a reload
rebuilt every node, after a shuffle moved it to another slot, and after a popover re-mounted it
under a different parent — all cases where the DOM path legitimately changes and the identity does
not.

Badge tracking is asserted geometrically: comment-ui places a badge `top-end` with offset
`[6, -6]`, so the badge centre must sit within ±80 px horizontally and ±40 px vertically of the
element's top-right corner.

### The invariant that runs everywhere

```
an anchored badge must never sit on a DIFFERENT element than the one it was placed on
```

`evaluate()` applies it to every check that has a baseline, including the ones that only expected
"still anchored". Orphaning is a survivable outcome; pointing confidently at the wrong thing is
not (PLAN §3.1). This is the check that caught the mis-anchor in `results.md`.

### Perturbations use the page's own controls

Each demo page ships the buttons that perturb it (`#shuffle`, `#trim`, `#churn-all`, …). The bench
scrolls the control into view and clicks it through CDP — a CDP click whose target centre is
outside the viewport reports success and does nothing. If the real click throws, the driver falls
back to a synthetic `.click()` **and records `how: 'js-click'` in `results.json`**, so a scenario
can never quietly stop being real. Every perturbation in the recorded run is `cdp-click`.

The viewport is pinned to 1440×900 for the same reason: at the default 1280×577 the demo pages'
control rows sit on the fold.

## The scenario matrix

Seven scenarios in `run.mjs`, one per demo page plus one extra for identical siblings.

| # | Scenario | Page | What it perturbs |
| --- | --- | --- | --- |
| 1 | `static` | `basic.html` | nothing — reload + scroll only (the floor) |
| 1b | `ambiguous` | `basic.html` | three byte-identical sibling cards; the fingerprint must break the tie |
| 2 | `reorder` | `reorder.html` | shuffle, sort, single-row move, row removal, restore |
| 3 | `popover` | `popover.html` | **flagship** — portalled popover unmount/remount, in-place re-render, reload while closed |
| 4 | `infinite-scroll` | `infinite-scroll.html` | off-screen badges, appended posts, feed trimmed to the last 10, restore |
| 5 | `spa` | `spa.html` | `pushState` route changes, browser Back/Forward, hard reload on a route |
| 6 | `attribute-churn` | `attribute-churn.html` | re-hashed classes, then regenerated ids + `data-*`, then rewritten text |

Every scenario runs `load()` first: open → pin viewport → wait for `engine.status === 'ready'` →
clear `localStorage` → reload. So each starts from an empty store.

### 1 — `static`

Place on `#intro` → assert anchored, badge tracking, confidence ≥ 0.99 → reload → re-assert
(+ panel section `open`) → scroll to the bottom and back → re-assert tracking. Exercises
floating-ui's `autoUpdate` and the `IntersectionObserver` off-screen skip.

### 1b — `ambiguous`

Place on the middle of three cards whose markup is byte-identical → reload → assert the badge is
on card "Two" and not on "One"/"Three". A pure fingerprint-disambiguation test.

### 2 — `reorder`

Place on the "Kiwi" row → reload → **Shuffle** (may or may not move the row) → **Sort A→Z** →
**Move first row down** → **Remove Kiwi** (must orphan, dock, and land in the panel's
`unanchored` section, with the raw `localStorage` bytes proven unchanged) → **Restore all rows**
(must re-anchor) → reload. The DOM path before/after the shuffle is recorded so the write-up can
say **whether** the row moved — a shuffle is not required to move any particular row, and in the
recorded run it left Kiwi at `li:nth-child(3)` (`moved: false`). Relocation is proven by the
sort and single-row-move steps instead, where `via` degrades to `fingerprint-scan`.

### 3 — `popover` (flagship)

1. open the portalled popover → place a thread on a row **inside** it (confidence ≥ 0.9);
2. close it — the content unmounts. Assert **orphaned**: badge `data-anchor="orphaned"`, visible,
   dimmed (`opacity < 1`), dashed border, orphan glyph, docked at the last-known rect, listed in
   the panel's `unanchored` section — and assert the persisted bytes did not change (orphanhood is
   a render-time condition, never a write — PLAN §3.2);
3. reopen it — **brand-new nodes** (`sameNodeObject: false`), though the rebuilt popover lands at
   the same DOM path (`samePath: true`), so the re-anchor is proven by node identity, not by the
   path. Assert **re-anchored to the same row**;
4. re-render the open popover in place (`#churn`) → still anchored;
5. close it, **reload the page**, assert the record survives as an orphan, and separately assert
   the badge docks (this second assertion is the one that fails — see `results.md`);
6. reopen after the reload → re-anchored.

### 4 — `infinite-scroll`

Auto-append is switched off first for determinism (then `blurActive()`, see above). Place on
Post #2 → reload → scroll it off-screen (badge must be `hidden` but still `anchored` and still
listed in the panel) → scroll back → **Load 10 more** → **Trim to the last 10** (Post #2 is gone;
must orphan) → **Restore every post** (must re-anchor).

### 5 — `spa`

Place on a row of the `?route=inbox` view → route to `settings` (thread must vanish from the page
*view* while the record stays in the store, asserted on the raw bytes) → back to `inbox`
(re-anchored) → browser **Back** (gone) → **Forward** (re-anchored) → hard reload on the route URL.

### 6 — `attribute-churn`

Place on a paragraph carrying a React-style `id` (`:r01:`), `data-testid`, `data-reactid`,
`aria-describedby` and hashed class names → reload (classes are re-hashed on every render) →
**Churn hashed classes** → **Churn ids and data attributes too** → **Reset** → **Rewrite the text**
(the baseline key legitimately cannot match here, so only "still resolves" is asserted).

**This is the one scenario that does not reproduce** — 2/6 to 5/6 across four runs, because the
page's per-render `Math.random()` class hashes pass finder's word-like filter about one time in
seventeen (`results.md` F4). Never quote a single run of it.

## Real-site smoke (`sites.mjs`)

Best effort, no auth, no login walls: `en.wikipedia.org/wiki/Anchor` and
`developer.mozilla.org/.../MutationObserver`.

Per site: open → probe the site's CSP → inject the two IIFE bundles from `apps/demo/dist/vendor`
→ boot `createCommentEngine` on a `localStorage` store in the bench's own namespace → pick a
target **by content** and derive an `:nth-child` path to click it → place a thread with the
keyboard → **reload** → re-inject, re-boot → probe the thread, and re-resolve the *stored* record
with the exported `Comments.resolveAnchor(anchor, { threshold })` at 0.62 / 0.85 / 0.9.

Three honesty notes that belong next to the numbers:

- The bundles go in through CDP `Runtime.evaluate`, which is **not** subject to the page's CSP.
  That models the extension's isolated world (and a devtools paste), **not** the standalone
  `<script src>` story. The CSP probe is therefore run and reported separately: it appends a real
  inline `<script>` and reports whether it executed.
- Targets are chosen by content, not by a hand-written site selector, because real sites wrap
  prose in generated containers (Parsoid's `<section id="mwAQ">`, MDN's `.content-section`) that
  are as volatile as the thing being located. The derived path is the *bench's* pointer for the
  click; the engine never sees it and stores whatever `captureTarget` decides.
- Only keys under the bench's `exp-spec-bench` `localStorage` namespace are written, and they are
  removed at the end (`cleanup.removed` in `results-sites.json`). Nothing else on those origins is
  touched.

MDN's target is deliberately a **link-free** paragraph with no id, no class and no `data-*`: a CDP
click at a paragraph's centre otherwise lands on an inline `<a>`, and anchoring a link with an
`href` is a much easier problem than anchoring bare prose.

## Extension smoke

`agent-browser` can load an unpacked extension into its Chromium with `--extension`, so the MV3
build is smoke-tested for real rather than documented as manual steps:

```bash
pnpm --filter exp-spec-extension build     # → packages/extension/.output/chrome-mv3

EXT="$PWD/packages/extension/.output/chrome-mv3"
agent-browser --session expspec-ext --extension "$EXT" open https://example.com
agent-browser --session expspec-ext set viewport 1280 900

# the content script mounts a WXT shadow host; comment-ui mounts its own root next to it
agent-browser --session expspec-ext eval \
  "[...document.documentElement.children].filter(n => n.shadowRoot).map(n => n.tagName)"

agent-browser --session expspec-ext press c          # extension default trigger (settings.ts)
agent-browser --session expspec-ext click h1
agent-browser --session expspec-ext keyboard type "bench: extension smoke"
agent-browser --session expspec-ext press Control+Enter

# badge is in comment-ui's root (the first one), not in <exp-spec-host> (the bridge's pill chrome)
agent-browser --session expspec-ext reload
agent-browser --session expspec-ext eval \
  "[...document.documentElement.children].filter(n=>n.shadowRoot)[0].shadowRoot.querySelectorAll('.cc-badge').length"
agent-browser --session expspec-ext close
```

It is deliberately run on a page with **no** demo engine: every demo page boots its own engine on
`c`, and two engines racing the same keypress makes the result meaningless.

Note the two shadow roots. `mountCommentUI` appends its own root to `documentElement`; the
extension's WXT `createShadowRootUi` mounts `<exp-spec-host>` for the *bridge's* chrome (the batch
pill and toasts). Badges live in the first one.
