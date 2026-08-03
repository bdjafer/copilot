# bench/results.md — real-browser anchoring results

Method, scenario definitions and how to reproduce: [`run.md`](./run.md).
Raw evidence: `results.json`, `results-sites.json`, `shots/`.

## Run

| | |
| --- | --- |
| Date | 2026-08-03 |
| Demo run | `results.json`, `ranAt 2026-08-03T04:54:36.981Z` |
| Site run | `results-sites.json`, `ranAt 2026-08-03T05:00:11.793Z` |
| Browser | HeadlessChrome/149.0.0.0 (macOS 26.5.2, arm64), viewport 1440×900 |
| Driver | `agent-browser` 0.32.2 over CDP |
| Node / pnpm | v26.0.0 / 11.13.1 |
| Base URL | `http://127.0.0.1:4272` (`sirv apps/demo/dist`) |
| Store | `localStorage` adapter, namespace `exp-spec-demo` (cleared before every scenario) |

**37 / 40 assertions passed across 7 scenarios.** Three failures, all real, all analysed below.

**Read that as one sample, not as a fixed point.** Every table below is the single recorded run
named above, and `results.json` holds exactly that run. Six of the seven scenarios reproduced
identically on re-run — `static`, `ambiguous`, `reorder` 8/8, `popover` 6/7 with the same single
failure, `infinite-scroll` 6/7 with the same mis-anchor, `spa` 6/6. `attribute-churn` does
**not**: it is genuinely non-deterministic, 5/6 · 4/6 · 4/6 · 2/6 across four runs, which is
**F4** below. Where a section states a repeat count, that is how many runs back it; where it
does not, treat it as n = 1.

## Scenario × outcome

| Scenario | Assertions | Re-anchored after reload? | Confidence | Survived the perturbation? | Notes |
| --- | --- | --- | --- | --- | --- |
| `static` | 4/4 | ✅ same element | 1.000 (`attr`) | ✅ scroll to bottom and back | floor case; badge tracked within tolerance throughout |
| `ambiguous` | 2/2 | ✅ correct sibling | 1.000 (`css`) | — | three byte-identical cards; the middle one was picked back out |
| `reorder` | 8/8 | ✅ same row | 0.999 (`css`) | ✅ shuffle, sort, single-row move, remove→orphan, restore→re-anchor | `via` degrades `css` → `fingerprint-scan` after sort, which is where relocation is actually proven (the shuffle left the row in its slot, `moved: false`); store bytes unchanged by orphaning |
| `popover` **(flagship)** | 6/7 | ✅ (warm) / ⚠️ (cold) | 0.999 (`css`) | ✅ unmount→orphan, remount→re-anchor, in-place re-render | ❌ **F1** — after a reload with the popover closed the orphan has no docked badge (record and panel row survive) |
| `infinite-scroll` | 6/7 | ✅ same post | 1.000 (`css`) | ✅ off-screen hide, +10 posts, restore | ❌ **F2** — trimming the feed **mis-anchored** the thread to a different post at 0.946 |
| `spa` | 6/6 | ✅ same row | 0.999 (`css`) | ✅ route change hides / restores, Back, Forward, hard reload | leaving a route deletes nothing (`storeUnchanged: true`, record still stored) |
| `attribute-churn` | 5/6 *(this run; 2/6–5/6 across four)* | ⚠️ usually | 1.000 (`attr`) | ⚠️ class re-hashing, reset and text rewrite passed **here** but each orphans in some runs | ❌ **F3** — regenerating ids + `data-*` orphans it: every strategy finds the right element and scores it 0.575. ❌ **F4** — the scenario is not reproducible |

Legend: *re-anchored* means the badge came back on the element with the same
`TAG|normalized-text` identity, asserted in the DOM (`run.md` § "The same element").

## Per-scenario detail

Confidence / `via` as recorded by the engine at each step.

### `static` — 4/4

| Step | Status | Conf | Via |
| --- | --- | --- | --- |
| placed on `#intro` | anchored | 1.000 | `attr` |
| after reload | anchored | 1.000 | `attr` |
| scrolled to bottom | anchored | 1.000 | `attr` |
| scrolled back | anchored | 1.000 | `attr` |

Resolution cost: 0.0–0.1 ms, one strategy attempt. Shots: `static-02-placed.png`,
`static-06-after-scroll.png`.

### `ambiguous` — 2/2

Middle of three byte-identical `.card` siblings. Placed 1.000 (`css`), after reload 1.000 (`css`),
still on card "Two". Shot: `ambiguous-03-after-reload.png`.

### `reorder` — 8/8

| Step | Status | Conf | Via |
| --- | --- | --- | --- |
| placed on "Kiwi" | anchored | 0.999 | `css` |
| after reload | anchored | 0.999 | `css` |
| after Shuffle | anchored | 0.999 | `css` |
| after Sort A→Z | anchored | 0.999 | `fingerprint-scan` |
| after single-row move | anchored | 0.999 | `fingerprint-scan` |
| after Remove Kiwi | **orphaned** (expected) | 0 | — |
| after Restore all rows | anchored | 0.999 | `css` |
| reload after the round trip | anchored | 0.999 | `css` |

The row's DOM path did **not** change across the shuffle in this run: `results.json`'s
`DOM path across the shuffle` records `placed` and `shuffled` as the same
`…>ul:nth-child(4)>li:nth-child(3)` and `moved: false` — a shuffle is free to leave a given row
in its slot, and here it did. So this step is evidence that the anchor survives *a re-render of
every sibling*, not evidence that it survives *relocation*. Relocation is covered by the next
two steps, where `via` degrades to `fingerprint-scan`. Orphaning wrote nothing:
raw `localStorage` bytes identical before and after (`store untouched by orphaning: equal: true`).
The `fingerprint-scan` fallback is the interesting part: after a sort, the stored `css` and
`nthPath` selectors both point at the wrong slot, are rejected by fingerprint verification, and
the bounded same-tag scan finds the right row — exactly the pipeline PLAN §3.1 describes.
Shots: `reorder-03-placed.png`, `reorder-09-after-shuffle.png`, `reorder-17-orphaned.png`,
`reorder-20-re-anchored.png`.

### `popover` — 6/7 (flagship)

| Step | Status | Conf | Via | |
| --- | --- | --- | --- | --- |
| placed inside the open portalled popover | anchored | 0.999 | `css` | ✅ |
| popover closed (content unmounts) | **orphaned**, docked, dimmed, dashed, orphan glyph, panel `unanchored` | 0 | — | ✅ |
| — store bytes across the orphaning | unchanged (1504 bytes both sides) | | | ✅ |
| popover reopened (brand-new nodes) | anchored, same row | 0.999 | `css` | ✅ |
| open popover re-rendered in place | anchored | 0.999 | `css` | ✅ |
| reload with the popover closed — record survives | orphaned, listed in panel `unanchored (1)` | 0 | — | ✅ |
| reload with the popover closed — badge docks | **no badge at all** | 0 | — | ❌ **F1** |
| popover reopened after the reload | anchored, same row | 0.999 | `css` | ✅ |

The flagship claim holds: **orphan on close, re-anchor on reopen**, with no write to the store in
between, and it survives a full page reload as long as the popover is opened again. The single
failure is the *cold-load* dock (F1). Shots: `popover-03-anchored-open.png`,
`popover-06-orphaned-closed.png`, `popover-10-re-anchored-reopen.png`,
`popover-15-orphaned-after-reload.png`, `popover-18-re-anchored-after-reload.png`.

### `infinite-scroll` — 6/7

| Step | Status | Conf | Via | |
| --- | --- | --- | --- | --- |
| placed on Post #2 | anchored | 1.000 | `css` | ✅ |
| after reload | anchored | 1.000 | `css` | ✅ |
| scrolled off-screen | anchored, badge `hidden`, panel `open` | 1.000 | `css` | ✅ |
| scrolled back | anchored, badge visible and tracking | 1.000 | `css` | ✅ |
| after Load 10 more | anchored | 1.000 | `css` | ✅ |
| after Trim to the last 10 | anchored **on Post #14** | 0.946 | `css` | ❌ **F2** |
| after Restore every post | anchored on Post #2 | 1.000 | `css` | ✅ |

The off-screen behaviour is exactly as specified: `IntersectionObserver` hides the badge while the
thread stays anchored and stays listed in the panel. Shots: `infinite-scroll-04-placed.png`,
`infinite-scroll-06-offscreen.png`, `infinite-scroll-13-orphaned.png` (labelled "orphaned" — it is
the mis-anchor, see F2), `infinite-scroll-16-re-anchored.png`.

### `spa` — 6/6

| Step | Status | Conf | Via |
| --- | --- | --- | --- |
| placed on `?route=inbox` | anchored | 0.999 | `css` |
| route → settings | absent from the page (0 threads) | — | — |
| route → inbox | anchored | 0.999 | `css` |
| browser Back → settings | absent (0 threads) | — | — |
| browser Forward → inbox | anchored | 0.999 | `css` |
| hard reload on `?route=inbox` | anchored | 0.999 | `css` |

`pageKey` changed, the store did not (`storeUnchanged: true`, `recordStillStored: true`) — a route
change is a view change, never a delete. Shots: `spa-02-placed-inbox.png`,
`spa-05-other-route.png`, `spa-11-re-anchored.png`.

### `attribute-churn` — 5/6 in the recorded run, **2/6–5/6 over four runs**

| Step | Status *(recorded run)* | Conf | Via | | Stable across four runs? |
| --- | --- | --- | --- | --- | --- |
| placed (React-style `id`, `data-testid`, `data-reactid`, `aria-describedby`, hashed classes) | anchored | 1.000 | `attr` | ✅ | yes |
| after reload (classes re-hashed every render) | anchored | 1.000 | `attr` | ✅ | **no** — orphans in some runs |
| after Churn hashed classes | anchored | 1.000 | `attr` | ✅ | **no** — orphans in some runs |
| after Churn ids **and** `data-*` | **orphaned** | 0 | — | ❌ **F3** | yes — fails 4/4 |
| after Reset to the original markup | anchored | 1.000 | `attr` | ✅ | **no** — orphans in some runs |
| after the text is rewritten | anchored | 0.988 | `attr` | ✅ | **no** — orphans in some runs |

**The "hashed-class churn is a non-event" conclusion this section used to draw is withdrawn.**
It was read off a single run. Four runs of `node bench/run.mjs attribute-churn` scored 5/6, 4/6,
4/6 and 2/6; run 2 orphaned on all four class-churn steps consecutively. F3 is the only stable
result on the page — see **F4** for the mechanism, which is in the engine's class filter, not in
the harness. Shots: `attribute-churn-02-placed.png`, `attribute-churn-07-after-class-churn.png`,
`attribute-churn-11-after-id-churn.png`, `attribute-churn-16-after-retext.png` — all from the
recorded 5/6 run, so they show the passing case only.

## Findings

Four findings. **F2 is a real anchoring bug** and the most serious result in this bench; **F4** is
the second real one and was only visible once the bench was re-run. Engine code was not touched —
these are filed, not fixed.

### F2 — MIS-ANCHOR: a recycled feed attaches the thread to a *different* post at 0.946

**Severity: high.** This is the exact failure mode PLAN §3.1 promises cannot happen ("never let a
stale-but-valid CSS path silently attach to the wrong element"). The user sees their comment,
badge and all, sitting on someone else's post.

*Repro* (`node bench/run.mjs infinite-scroll`, or by hand):

1. open `/pages/infinite-scroll.html`, untick **Auto-append**;
2. place a thread on **Post #2**;
3. click **Load 10 more** (feed now holds posts #1…#22);
4. click **Trim to the last 10** (feed now holds posts #13…#22 — Post #2 is gone).

*Expected*: the thread orphans (element genuinely removed), badge docks dimmed, panel
`unanchored`.
*Actual*: the thread stays `anchored` at **confidence 0.946**, `via: css`, on **Post #14**.

*Why.* The demo's feed cycles 12 body texts (`BODIES[n % BODIES.length]`), so Post #2 and Post #14
carry the same body and differ only in the `<h3>` number and a trailing `(post N)`. The stored
fingerprint for a feed card has **no id and no attributes** — only `stableClasses: ["card"]`, a
`rectHint`, and the text digest. `scoreCandidate` (`packages/comment-core/src/anchor/score.ts`)
normalizes over *present* components, so the weights available are classes 0.22, structure 0.16,
text 0.12 — total 0.50:

| component | weight | value on Post #14 | contribution |
| --- | --- | --- | --- |
| `stableClasses` (`["card"]` vs `["card"]`) | 0.22 | 1.00 | 0.220 |
| `rectHint` (same-size card) | 0.16 | ≈0.92 | ≈0.147 |
| `textDigest` (token Jaccard, 15 of 17 tokens shared) | 0.12 | 0.882 | ≈0.106 |
| | **0.50** | | **≈0.473 → 0.946** |

The two components that carry **no identity at all** on a templated feed (class list, box size)
supply 0.38 of the 0.50 available weight — a **0.76 floor for every sibling card in the list**,
before text is considered. Measured directly with `Comments.scoreCandidate` against the live DOM
after the trim:

| candidate | score |
| --- | --- |
| **Post #14** (accepted) | **0.946** |
| Post #19 | 0.797 |
| Post #16 | 0.793 |
| Post #13 / #21 / #22 | 0.776 |
| Post #15 / #17 | 0.768 |

Re-resolving the stored record with the exported API confirms it is not a threshold-tuning
problem: `Comments.resolveAnchor(anchor, { threshold })` returns Post #14 at **0.62 (library
default), 0.85 and 0.9 (the demo's raised value)** alike. Nothing below ~0.95 rejects it.

Control: the same trim **without** the "Load 10 more" step (feed → posts #3…#12, no text twin
present) correctly orphans — top candidate 0.797, below the accept score. So the trigger is
specifically a near-duplicate, not list churn in general.

*Suggested directions* (not applied): (a) treat `textDigest` as a **discriminator** rather than a
similarity contribution — require the best candidate to beat the runner-up by a margin before
accepting, which here is 0.946 vs 0.797 and would still accept, so more usefully (b) refuse to
accept any candidate when the fingerprint carries no identity signal (`id`/`attrs` both empty) and
the text digest is not an exact/containment match, or (c) stop letting identity-free components
(class list, rect) renormalize to 76% of the weight when they are shared by every sibling — score
them only as corroboration of a discriminating signal, never as the signal.

*Note for whoever fixes it*: `infinite-scroll.html` carries a comment claiming its bodies are
distinct enough for this not to happen. With 12 bodies and a 22-post feed, they are not.

### F3 — regenerating ids + `data-*` orphans an otherwise perfectly identifiable element

**Severity: medium (calibration).** Symmetric to F2 and caused by the same arithmetic.

*Repro*: open `/pages/attribute-churn.html`, place a thread on the second paragraph, click
**Churn ids and data attributes too** (regenerates `id`, `data-testid`, `data-reactid`,
`aria-describedby`; text, tag and the stable `card` class are untouched).

*Expected* (bench's reading of PLAN §3.1 — "visible text weighted above DOM structure, which
churns"): re-anchor, possibly flagged approximate.
*Actual*: orphaned. Every strategy located the correct element and every one was rejected —
`attr: 0 (0 candidates)`, `css: 0.575`, `nthPath: 0.575`, `fingerprint-scan: 0.575 (5 candidates)`
— and `resolveAnchor` returns `null` at 0.62, 0.85 and 0.9.

*Why*, exactly (all five components present ⇒ weights sum to 1.0):

| component | weight | value | contribution |
| --- | --- | --- | --- |
| `id` (`:r01:` → `:r11:`) | 0.20 | 0 | 0 |
| `attrs` (3 attrs, all *present but changed* ⇒ 0.25 each) | 0.30 | 0.25 | 0.075 |
| `stableClasses` | 0.22 | 1 | 0.220 |
| `rectHint` | 0.16 | 1 | 0.160 |
| `textDigest` (identical) | 0.12 | 1 | 0.120 |
| | **1.00** | | **0.575** |

An element whose **text is byte-identical** scores below the library's own default accept
threshold because a framework rewrote four bookkeeping attributes. Note the asymmetry with F2: an
element with *different* text but no attributes scores 0.946 and is accepted; an element with
*identical* text but churned attributes scores 0.575 and is rejected. Both follow from the same
normalize-over-present-components rule.

**Open question, flagged rather than resolved:** the demo page's own log line for this button says
`expect an orphan`, while `bench/run.mjs` asserts a re-anchor. Those two artifacts encode opposite
readings of the spec, and this bench does not have the authority to pick one. If "React
regenerated its ids ⇒ new element" is the intended semantics, the fix is a one-line expectation
change in `run.mjs` — but then the same rule should be stated in `SPEC-comment-core`, because a
tool that orphans every thread on a React re-render with a new key is not the tool PLAN §3.2
describes.

### F1 — an orphan that has never resolved once draws no badge (PLAN §3.3 / SPEC §5.1)

**Severity: medium (spec claim vs implementation).**

*Repro*: `/pages/popover.html` → open the portalled popover → place a thread inside it → close the
popover → **reload the page**.

*Expected* (PLAN §3.3: "Orphaned threads stay reachable: dimmed badge docked at last-known
position + listed in the panel's unanchored section"): a dimmed, dashed, docked badge.
*Actual*: the thread is `orphaned`, the record survives, the panel lists it under
`unanchored (1)` — but `anchoring.rect` is `null` and comment-ui therefore renders **no badge at
all** (`badgeVisible`, `badge.ts`).

*Why*: `anchoring.rect` is a live derivation, never persisted. A thread that orphans on the
**first** resolution pass after a cold load has no last-known position to dock at. Warm orphaning
(close the popover without reloading) docks correctly — asserted and passing in the same scenario.

*Impact*: the thread is not lost (panel row, store record, and re-anchor on reopen all work), but
"docked at last-known position" is not true across a reload. Either the rect must be persisted
alongside the record, or the claim should be narrowed to warm orphans. This is the bench's only
failure that is a documentation-vs-code disagreement rather than a scoring bug.

### F4 — hashed-class churn is **not** a non-event: `attribute-churn` does not reproduce

**Severity: high** (the finding), **medium** (the underlying instability). Four consecutive runs
of `node bench/run.mjs attribute-churn` scored **5/6, 4/6, 4/6, 2/6**. Only F3 (`after id +
data-* churn`) failed in all four; `after reload (classes re-hashed)`, `after class churn` and
`after reset` each orphaned in at least one run, and run 2 orphaned on all four consecutively.
The recorded 5/6 is therefore the best of four, and the conclusion this page used to draw from
it — "class regeneration never touches the anchor" — was false.

*Mechanism (engine, not harness).* The page renders `class="card css-<hash> sc-<hash>"` with
`hash = Math.random().toString(36).slice(2, 8)` and regenerates both hashes on every render.
`isStableClass` (`packages/comment-core/src/anchor/fingerprint.ts:52`) delegates to finder v4's
`className`, i.e. `wordLike`: letters and hyphens only, every hyphen-separated segment longer
than two characters, no run of four consecutive non-vowels. A base-36 hash that happens to come
out digit-free and vowel-spread satisfies all three. Measured over 200 000 generated names:

| Generated class | Kept as "stable" |
| --- | --- |
| `css-<hash>` | **5.8 %** |
| `sc-<hash>` | 0 % (the two-letter `sc` segment is rejected outright) |

So roughly one render in seventeen leaks a per-render-random class into `stableClasses` — on the
capture side it is baked into the stored fingerprint, on the resolve side it appears in
`stableClassesOf(live)`, and either way the Jaccard term in `scoreCandidate` drops and the
`css` selector finder generated can stop matching. That is a coin flip, per render, per element,
and it is exactly what the variance above looks like.

*What this costs a real app.* Only frameworks that regenerate class hashes **per render** (some
CSS-in-JS runtimes, dev-mode Emotion/styled-components) are exposed; a build-time hash is stable
across renders and is harmless — as is Tailwind, whose classes are word-like *and* stable. The
page's own claim to model "Tailwind/CSS-in-JS" conflates the two.

*Suggested fix, not applied here* (this bench files, it does not fix): require a class to be
word-like **and** to be present on more than one element, or to survive a second observation,
before it is admitted as evidence — a per-render-random class is unique in the document by
construction. Any change here is a §2.5 decision and belongs with the SPEC, not with the bench.

*Repro*: `for i in 1 2 3 4; do node bench/run.mjs attribute-churn; done` and compare the pass
counts. The measurement above: filter `Math.random().toString(36).slice(2, 8)` names through
`isStableClass` and count.

### Non-failures worth recording

- **A focused `<input type="checkbox">` swallows the trigger key.** `isEditableTarget`
  (`placement.ts:76`) returns `true` for every `<input>` regardless of `type`, so pressing `c`
  right after ticking a checkbox does nothing. The bench works around it (`blurActive()`); a user
  cannot. Cheap fix: exclude non-text input types.
- **A second press of the same trigger key cancels placement** (documented toggle, §4.5) — worth
  knowing because it looks identical to "the key never fired".
- Resolution is fast: every recorded `explain()` totalled **0.0–0.4 ms**, usually one attempt.

## Real-site smoke

Best effort, no auth. Injection is CDP `Runtime.evaluate` (the extension's isolated world), so the
CSP column reports the **separate** question "would a plain `<script>` tag work here?".

| Site | Target | Inline `<script>` allowed? | Placed | After reload + re-inject | Same element? | Stored-record re-resolve @0.62 / 0.85 / 0.9 |
| --- | --- | --- | --- | --- | --- | --- |
| `en.wikipedia.org/wiki/Anchor` | body `<p>` ("Anchors can either be temporary or permanent…"), Parsoid `id="mwPg"`, no classes | ✅ yes | anchored 1.000 (`attr`) | anchored **1.000** (`attr`) | ✅ | 1.000 / 1.000 / 1.000 (`attr`) |
| `developer.mozilla.org/…/MutationObserver` | link-free `<p>` ("Creates and returns a new MutationObserver…") — **no id, no class, no `data-*`** | ❌ **blocked by CSP** | anchored 1.000 (`css`) | anchored **1.000** (`css`) | ✅ | 1.000 / 1.000 / 1.000 (`css`) |

Both re-anchored to the same element at full confidence after a real reload — the engine booted
with 0 threads and came back with 1 loaded from `localStorage` (`boot.threads: 0` →
`reboot.threads: 1`), so this is genuine persistence, not a live object surviving in memory. The
MDN case is the stronger one: the fingerprint carried nothing but tag, text and box, and the
generated selector (`section:nth-of-type(1) > dl p`) still verified at 1.000.

Caveats, honestly:

- **MDN's CSP blocks inline `<script>`.** The standalone `<script src>` story from
  SPEC-comment-core §7.1 does **not** work on that origin; the extension (isolated world) does.
  Wikipedia allows it.
- **Wikipedia's win partly rests on a volatile id.** The winning `attr` selector used Parsoid's
  generated `id="mwPg"`, which changes when the article is re-parsed. This run reloaded within
  seconds against the same cached parse, so it is a best case. The `css`/`nthPath` fallbacks were
  never exercised there.
- Only reload was tested. Neither site was perturbed (no edits, no A/B redesign, no
  days-later re-visit), and no logged-in or auth-walled page was touched.
- Bench keys were removed afterwards (`cleanup.removed: 2` on both origins).
- `site-*-01-placed.png` and `site-*-02-after-reload.png` are byte-identical per site: Chrome
  restores the scroll position on reload and both renders are deterministic. The DOM probe, not
  the pixels, is the evidence.

## Extension smoke

Loaded the real MV3 build into agent-browser's Chromium with `--extension` (no manual steps
needed — the harness supports it; commands in `run.md`).

| Check | Result |
| --- | --- |
| `pnpm --filter exp-spec-extension build` | ✅ `.output/chrome-mv3`, 749 kB total |
| content script injected at `document_start` on `https://example.com` | ✅ `<exp-spec-host>` shadow host + comment-ui's own shadow root both present |
| keyboard trigger `c` → click → type → `Ctrl+Enter` | ✅ composer opened (`data-open="true"`, textarea focused), thread created |
| badge anchored on the clicked `<h1>` | ✅ `data-anchor="anchored"`, `data-status="open"`, centre 41 px left / 5 px above the element's top-right corner |
| **reload** → re-anchor from `chrome.storage` | ✅ same thread id `nnIT4X5eAhOL`, `data-anchor="anchored"`, `data-approximate` unset, identical badge position |

Shots: `ext-01-placed.png`, `ext-02-after-reload.png` (byte-identical for the same reason as the
site pair). Not covered: the copilot bridge (needs an API key), the batch pill, `chrome.commands`
shortcuts, and the options page.

## Screenshot index

`shots/` — 29 PNGs, 26 distinct (the three duplicate pairs are the placed/after-reload pairs
explained above), all from the single run recorded at the top of this file. Demo scenarios are named
`<scenario>-<step>-<label>.png`; real sites `site-<name>-0N-*.png`; extension `ext-0N-*.png`.
