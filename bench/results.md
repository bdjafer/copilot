# bench/results.md — real-browser anchoring results

Method, scenario definitions and how to reproduce: [`run.md`](./run.md).
Raw evidence: `results.json`, `results-sites.json`, `shots/`.

## Run

| | |
| --- | --- |
| Date | 2026-08-03 (**wave 4** — the four findings below are fixed; see [Findings](#findings)) |
| Demo run | `results.json`, `ranAt 2026-08-03T07:13:47.683Z` |
| Site run | `results-sites.json`, `ranAt 2026-08-03T06:44:49.427Z` |
| Browser | HeadlessChrome/149.0.0.0 (macOS 26.5.2, arm64), viewport 1440×900 |
| Driver | `agent-browser` 0.32.2 over CDP |
| Node / pnpm | v26.0.0 / 10.28.0 |
| Base URL | `http://127.0.0.1:4272` (`sirv apps/demo/dist`) |
| Store | `localStorage` adapter, namespace `exp-spec-demo` (cleared before every scenario) |
| Accept threshold | **0.62 — the library default.** The demo used to raise it to 0.9; see [The threshold the demo no longer needs](#the-threshold-the-demo-no-longer-needs). |

**40 / 40 assertions passed across 7 scenarios.** The previous run was 37/40, and all three
failures plus the reproducibility finding are now fixed at the engine level.

**Repeat counts, because one run proves nothing** (`run.md` § "Repeat count"):

| What was re-run | Runs | Result |
| --- | --- | --- |
| the whole bench (7 scenarios, 40 assertions) | 5 | 40/40 every time |
| `attribute-churn` alone — the scenario that used to be non-deterministic | 4 | **6/6 every time** (was 5/6 · 4/6 · 4/6 · 2/6) |
| `infinite-scroll` + `popover` — the two that carried F2 and F1 | 3 | 14/14 every time |
| `static` + `ambiguous` + `reorder` + `spa` — the untouched controls | 2 | 20/20 both |

One earlier full run, made *before* the demo's accept threshold was reverted, scored 39/40: the
`attribute-churn` id step re-anchors at **0.75**, which a page demanding 0.9 is entitled to
refuse. That is the honest reason the demo went back to the library default, and it is recorded
here rather than deleted — see F3's status below. Two of the five full runs above also predate
the `settledStoreBytes()` harness fix described under [`spa`](#spa--66); their assertions were
identical, only the store-byte *notes* were racy.

## What changed since the previous run

Four engine changes, three of them one rule each, plus one demo-side revert. All four are
locked into `SPEC-comment-core` (§2.4, §2.5, §4.6) with decision-log rows **#26–#29**, and each
has a unit test in `packages/comment-core/test/bench-findings.test.ts` that fails before it and
passes after.

| Finding | Rule | Where |
| --- | --- | --- |
| F2 | **The text digest is a verifier, not a fifth weighted contribution.** A candidate that no live identity signal confirms is refused below 0.90 digest similarity, whatever else matches. An identified candidate is refused on a total contradiction (two non-empty digests, no shared word). | §2.5, #26 |
| F3 | **Regenerated evidence is absent, not contradicted.** An `id`/attribute the candidate carries under a *different* value scores 0.5 ("no information") when the stored value matches nothing in the document. An attribute the candidate does not carry at all still scores 0. | §2.5, #27 |
| F4 | **A class is evidence only when word-like AND corroborated** by a second element in the document, and is compared at resolve time by **coverage of that vetted set** rather than a symmetric Jaccard. | §2.5, #28 |
| F1 | **`ElementCapture.rect`** — the target's document-space rect, written once at capture. An orphan with no live rect docks there. Additive optional field; orphaning still writes nothing. | §2.4, #29 |

### The threshold the demo no longer needs

`apps/demo/site/assets/demo.js` raised `anchoring.threshold` to 0.9 on every page, with a
measurement behind it: a positional selector that keeps matching after a list mutation points at
whoever moved into the slot, and that wrong element scored **0.76** (nothing in common but
shape) or **~0.97** on a feed whose rows share boilerplate. The page could only defend itself by
demanding near-certainty of every match.

Decision #26 moves that defence into the engine. Both of those measurements are now **0** —
`results.json`'s `trace @ shuffle` records `css: 0`, `nthPath: 0`, then `fingerprint-scan: 0.999`
on the real row, and `trace @ trim` records `css: 0`, `nthPath: 0`, `fingerprint-scan: 0`. So the
demo is back on 0.62, which is also what makes F3's honest 0.75 re-anchor visible instead of
being refused by the page. Anything quoted from a run before this one was measured at 0.9.

## Scenario × outcome

| Scenario | Assertions | Re-anchored after reload? | Confidence | Survived the perturbation? | Notes |
| --- | --- | --- | --- | --- | --- |
| `static` | 4/4 | ✅ same element | 1.000 (`attr`) | ✅ scroll to bottom and back | floor case; badge tracked within tolerance throughout |
| `ambiguous` | 2/2 | ✅ correct sibling | 1.000 (`css`) | — | three byte-identical cards; the middle one was picked back out |
| `reorder` | 8/8 | ✅ same row | 0.999 (`css`) | ✅ shuffle, sort, single-row move, remove→orphan, restore→re-anchor | the shuffle **did** move the row this run (`li:nth-child(3)` → `li:nth-child(2)`, `moved: true`), and `via` degraded to `fingerprint-scan` there; store bytes unchanged by orphaning |
| `popover` **(flagship)** | 7/7 | ✅ (warm **and** cold) | 0.999 (`css`) | ✅ unmount→orphan, remount→re-anchor, in-place re-render, reload while closed | **F1 fixed** — the cold-load orphan now docks at `capture.rect` |
| `infinite-scroll` | 7/7 | ✅ same post | 1.000 (`css`) | ✅ off-screen hide, +10 posts, trim→orphan, restore | **F2 fixed** — trimming the feed now orphans; every candidate scores 0 |
| `spa` | 6/6 | ✅ same row | 0.999 (`css`) | ✅ route change hides / restores, Back, Forward, hard reload | leaving a route deletes nothing (`recordStillStored: true`) |
| `attribute-churn` | 6/6 *(4/4 runs)* | ✅ | 1.000 (`attr`) | ✅ class re-hashing, id + `data-*` regeneration, reset, text rewrite | **F3 + F4 fixed** — the id step re-anchors at 0.75 flagged approximate; the class steps are deterministic |

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
still on card "Two". Worth stating explicitly against #26: three identical cards means the text
digest verifies *all* of them, and the disambiguation is the `css` selector's job — the verifier
refuses wrong content, it does not demand uniqueness. Shot: `ambiguous-03-after-reload.png`.

### `reorder` — 8/8

| Step | Status | Conf | Via |
| --- | --- | --- | --- |
| placed on "Kiwi" | anchored | 0.999 | `css` |
| after reload | anchored | 0.999 | `css` |
| after Shuffle | anchored | 0.999 | `fingerprint-scan` |
| after Sort A→Z | anchored | 0.999 | `fingerprint-scan` |
| after single-row move | anchored | 0.999 | `fingerprint-scan` |
| after Remove Kiwi | **orphaned** (expected) | 0 | — |
| after Restore all rows | anchored | 0.999 | `css` |
| reload after the round trip | anchored | 0.999 | `css` |

This run the shuffle **did** relocate the row — `DOM path across the shuffle` records
`li:nth-child(3)` → `li:nth-child(2)`, `moved: true` — so the shuffle step is genuine relocation
evidence here rather than the "every sibling re-rendered" case the previous run happened to
record. The trace is the clearest single piece of evidence for #26: `css: 0`, `nthPath: 0`,
`fingerprint-scan: 0.999`. Both positional selectors still *match* an element after the shuffle;
that element used to score ≈0.76 and win, and now scores **0**, so the scan runs and finds the
real row. Orphaning wrote nothing: raw `localStorage` bytes identical before and after.
Shots: `reorder-03-placed.png`, `reorder-09-after-shuffle.png`, `reorder-17-orphaned.png`,
`reorder-20-re-anchored.png`.

### `popover` — 7/7 (flagship)

| Step | Status | Conf | Via | |
| --- | --- | --- | --- | --- |
| placed inside the open portalled popover | anchored | 0.999 | `css` | ✅ |
| popover closed (content unmounts) | **orphaned**, docked, dimmed (0.55), dashed, orphan glyph, panel `unanchored` | 0 | — | ✅ |
| — store bytes across the orphaning | unchanged (1580 bytes both sides) | | | ✅ |
| popover reopened (brand-new nodes) | anchored, same row | 0.999 | `css` | ✅ |
| open popover re-rendered in place | anchored | 0.999 | `css` | ✅ |
| reload with the popover closed — record survives | orphaned, listed in panel `unanchored (1)` | 0 | — | ✅ |
| reload with the popover closed — **badge docks** | docked at `{top: 866, left: 57, 1366×52}`, dimmed, dashed, orphan glyph | 0 | — | ✅ **F1 fixed** |
| popover reopened after the reload | anchored, same row | 0.999 | `css` | ✅ |

The flagship claim now holds end to end, cold as well as warm: **orphan on close, re-anchor on
reopen**, with no write to the store in between, and a docked badge across a full page reload.
The cold dock is `capture.rect`, i.e. where the element was **when the thread was placed** — on
this page that is 39 px above where it sat at the moment of orphaning, because the demo's log
panel had grown in between. "Last-known position" is therefore precise about *which* known
position, and the alternative (persisting the live rect) would make orphaning a write, which the
row above proves it is not. Shots: `popover-03-anchored-open.png`,
`popover-06-orphaned-closed.png`, `popover-10-re-anchored-reopen.png`,
`popover-15-orphaned-after-reload.png`, `popover-18-re-anchored-after-reload.png`.

### `infinite-scroll` — 7/7

| Step | Status | Conf | Via | |
| --- | --- | --- | --- | --- |
| placed on Post #2 | anchored | 1.000 | `css` | ✅ |
| after reload | anchored | 1.000 | `css` | ✅ |
| scrolled off-screen | anchored, badge `hidden`, panel `open` | 1.000 | `css` | ✅ |
| scrolled back | anchored, badge visible and tracking | 1.000 | `css` | ✅ |
| after Load 10 more | anchored | 1.000 | `css` | ✅ |
| after Trim to the last 10 | **orphaned**, docked, panel `unanchored` | 0 | — | ✅ **F2 fixed** |
| after Restore every post | anchored on Post #2 | 1.000 | `css` | ✅ |

`trace @ trim` records `css: 0`, `nthPath: 0`, `fingerprint-scan: 0` — not "below threshold" but
**zero**: every one of the ten surviving cards, Post #14 included, is refused by the verifier
rather than scored and rejected. Re-resolving the stored record with the exported API returns
`null` at 0.62, 0.85 and 0.9 alike (`stored anchor re-resolved after trim`). Shots:
`infinite-scroll-04-placed.png`, `infinite-scroll-06-offscreen.png`,
`infinite-scroll-13-orphaned.png` (now genuinely an orphan), `infinite-scroll-16-re-anchored.png`.

### `spa` — 6/6

| Step | Status | Conf | Via |
| --- | --- | --- | --- |
| placed on `?route=inbox` | anchored | 0.999 | `css` |
| route → settings | absent from the page (0 threads) | — | — |
| route → inbox | anchored | 0.999 | `css` |
| browser Back → settings | absent (0 threads) | — | — |
| browser Forward → inbox | anchored | 0.999 | `css` |
| hard reload on `?route=inbox` | anchored | 0.999 | `css` |

`pageKey` changed and the store did not (`storeUnchanged: true`, `recordStillStored: true`) — a
route change is a view change, never a delete.

**One harness bug was found and fixed while re-benching this.** Every demo page attaches the echo
responder, which replies to a new thread on an **800 ms timer** — and a reply is a store write.
The three "the store did not change" notes (here, `popover`, `reorder`) read the raw bytes across
a perturbation, and if the responder's write landed inside that window they reported a change
that had nothing to do with the perturbation. A run recorded exactly that: `storeUnchanged:
false` here and `equal: false` on `popover`, while the thread's comment count went 1 → 2 across
the same step. `run.mjs` now takes the "before" reading through `settledStoreBytes()`, which
waits for the store to stop changing first, and all three notes are `true` in three consecutive
full runs. This is a bench honesty fix, not an engine change — the same property has a
deterministic unit test in `engine-anchoring.test.ts` (`store.writes` unchanged across an
orphaning). Shots: `spa-02-placed-inbox.png`, `spa-05-other-route.png`, `spa-11-re-anchored.png`.

### `attribute-churn` — 6/6, in **4 runs out of 4**

| Step | Status | Conf | Via | | Stable across four runs? |
| --- | --- | --- | --- | --- | --- |
| placed (React-style `id`, `data-testid`, `data-reactid`, `aria-describedby`, hashed classes) | anchored | 1.000 | `attr` | ✅ | yes |
| after reload (classes re-hashed every render) | anchored | 1.000 | `attr` | ✅ | **yes** — was a coin flip |
| after Churn hashed classes | anchored | 1.000 | `attr` | ✅ | **yes** — was a coin flip |
| after Churn ids **and** `data-*` | **anchored, flagged approximate** | 0.750 | `css` | ✅ **F3 fixed** | yes |
| after Reset to the original markup | anchored | 1.000 | `attr` | ✅ | **yes** — was a coin flip |
| after the text is rewritten | anchored | 0.988 | `attr` | ✅ | yes |

The id/`data-*` step is the one worth reading closely. `attr` finds nothing (its selector is
built from the old id and testid), `css` finds the right paragraph, and the fingerprint scores it
**0.750**: the id and all three attributes were *rewritten* to values whose originals match
nothing in the document, so each contributes 0.5 rather than 0 (#27), and the byte-identical text
is what licenses the match at all (#26). comment-ui renders it with `data-approximate="true"` —
`badge.approximate` is `true` in `results.json`, the only step in the whole bench where it is.
Re-resolving the stored record returns 0.750 at threshold 0.62 and `null` at 0.85 and 0.9, which
is the correct shape: an app that wants only near-certain matches can still refuse it.

Four consecutive runs of `node bench/run.mjs attribute-churn` scored **6/6, 6/6, 6/6, 6/6**
(previously 5/6, 4/6, 4/6, 2/6). Shots: `attribute-churn-02-placed.png`,
`attribute-churn-07-after-class-churn.png`, `attribute-churn-11-after-id-churn.png`,
`attribute-churn-16-after-retext.png`.

## Findings

All four are **fixed in wave 4**. The diagnoses are kept verbatim below — they are the evidence
the fixes were designed against — each with its measured status appended.

### F2 — MIS-ANCHOR: a recycled feed attaches the thread to a *different* post at 0.946

**Severity: high. Status: FIXED in wave 4 (SPEC §2.5, decision log #26).** This was the exact
failure mode PLAN §3.1 promises cannot happen ("never let a stale-but-valid CSS path silently
attach to the wrong element"). The user saw their comment, badge and all, sitting on someone
else's post.

*Repro* (`node bench/run.mjs infinite-scroll`, or by hand):

1. open `/pages/infinite-scroll.html`, untick **Auto-append**;
2. place a thread on **Post #2**;
3. click **Load 10 more** (feed now holds posts #1…#22);
4. click **Trim to the last 10** (feed now holds posts #13…#22 — Post #2 is gone).

*Expected*: the thread orphans (element genuinely removed), badge docks dimmed, panel
`unanchored`.
*Was*: the thread stayed `anchored` at **confidence 0.946**, `via: css`, on **Post #14**.

*Why.* The demo's feed cycles 12 body texts (`BODIES[n % BODIES.length]`), so Post #2 and Post #14
carry the same body and differ only in the `<h3>` number and a trailing `(post N)`. The stored
fingerprint for a feed card has **no id and no attributes** — only `stableClasses: ["card"]`, a
`rectHint`, and the text digest. `scoreCandidate` normalized over *present* components, so the
weights available were classes 0.22, structure 0.16, text 0.12 — total 0.50:

| component | weight | value on Post #14 | contribution |
| --- | --- | --- | --- |
| `stableClasses` (`["card"]` vs `["card"]`) | 0.22 | 1.00 | 0.220 |
| `rectHint` (same-size card) | 0.16 | ≈0.92 | ≈0.147 |
| `textDigest` (token Jaccard, 15 of 17 tokens shared) | 0.12 | 0.882 | ≈0.106 |
| | **0.50** | | **≈0.473 → 0.946** |

The two components that carry **no identity at all** on a templated feed (class list, box size)
supplied 0.38 of the 0.50 available weight — a **0.76 floor for every sibling card in the list**,
before text was considered. Measured directly with `Comments.scoreCandidate` against the live DOM
after the trim: Post #14 **0.946** (accepted), then 0.797, 0.793, 0.776, 0.768 for the rest. It
was not a threshold-tuning problem either: `resolveAnchor` returned Post #14 at **0.62, 0.85 and
0.9** alike.

**Status — fixed.** §4.6.2 already called `textDigest` "the final verifier" and the code made it
0.12 of a weighted average, so it could never refuse anything: that is exactly why it did not
catch this. It is now a veto (#26). Re-measured on the same repro, this run:

| | before | after |
| --- | --- | --- |
| Post #14 (the near-duplicate) | 0.946, accepted | **0** |
| every other surviving card | 0.768–0.797 | **0** |
| `resolveAnchor` @ 0.62 / 0.85 / 0.9 | Post #14 / Post #14 / Post #14 | **null / null / null** |
| scenario | orphan assertion failed | `orphaned`, docked, panel `unanchored` |

The control still holds the other way: **Restore every post** re-anchors on Post #2 itself at
1.000. The cost of the rule is stated in decision log #26 — an element with no id and no
attributes whose prose was substantially rewritten now orphans instead of re-anchoring
approximately.

*Note for the record*: `infinite-scroll.html` used to carry a comment claiming its bodies were
distinct enough for this not to happen. With 12 bodies and a 22-post feed they are not, and the
page now says so — the near-duplicate is deliberate, and is what the verifier is tested against.

### F3 — regenerating ids + `data-*` orphans an otherwise perfectly identifiable element

**Severity: medium (calibration). Status: FIXED in wave 4 (SPEC §2.5, decision log #27).**
Symmetric to F2 and caused by the same arithmetic.

*Repro*: open `/pages/attribute-churn.html`, place a thread on the second paragraph, click
**Churn ids and data attributes too** (regenerates `id`, `data-testid`, `data-reactid`,
`aria-describedby`; text, tag and the stable `card` class are untouched).

*Expected* (bench's reading of PLAN §3.1 — "visible text weighted above DOM structure, which
churns"): re-anchor, possibly flagged approximate.
*Was*: orphaned. Every strategy located the correct element and every one was rejected —
`attr: 0 (0 candidates)`, `css: 0.575`, `nthPath: 0.575`, `fingerprint-scan: 0.575 (5 candidates)`
— and `resolveAnchor` returned `null` at 0.62, 0.85 and 0.9.

*Why*, exactly (all five components present ⇒ weights sum to 1.0):

| component | weight | value | contribution |
| --- | --- | --- | --- |
| `id` (`:r01:` → `:r11:`) | 0.20 | 0 | 0 |
| `attrs` (3 attrs, all *present but changed* ⇒ 0.25 each) | 0.30 | 0.25 | 0.075 |
| `stableClasses` | 0.22 | 1 | 0.220 |
| `rectHint` | 0.16 | 1 | 0.160 |
| `textDigest` (identical) | 0.12 | 1 | 0.120 |
| | **1.00** | | **0.575** |

An element whose **text is byte-identical** scored below the library's own default accept
threshold because a framework rewrote four bookkeeping attributes.

**Status — fixed, and the open question is answered.** The finding flagged that the demo page's
own log said `expect an orphan` while `run.mjs` asserted a re-anchor, and refused to pick between
them without authority. Decision log #27 picks: **a value that was rewritten and whose original
matches nothing anywhere in the document cannot mean "not this element"** — it identifies
nothing, so it carries no information (0.5) rather than a contradiction (0/0.25). The demo page's
copy and its log line were wrong and have been corrected; a tool that orphans every thread on a
React re-render is not the tool PLAN §3.2 describes. Re-measured:

| component | weight | value before | value after |
| --- | --- | --- | --- |
| `id` (`:r01:` → `:r11:`, and `:r01:` is now nowhere in the document) | 0.20 | 0 | **0.5** |
| `attrs` (3, all rewritten, all originals gone) | 0.30 | 0.25 | **0.5** |
| `stableClasses` / `rectHint` / `textDigest` | 0.50 | 1 / 1 / 1 | 1 / 1 / 1 |
| | | **0.575 → orphaned** | **0.750 → anchored, approximate** |

The rescue is deliberately narrow, and the bench asserts both edges: an attribute the candidate
does **not carry at all** still scores 0 (removing a `data-testid` still drops the confidence to
the approximate band — `engine-anchoring.test.ts`), and if the *original* ids are still present
in the document the regeneration story does not apply, so a sibling is not taken
(`bench-findings.test.ts`). Rewriting the text as well as the attributes still orphans.

*One consequence worth stating*: at the demo's old 0.9 threshold this honest 0.75 is refused,
which is a page's prerogative and is exactly what a full run measured (39/40) before the demo
went back to the library default. See [The threshold the demo no longer needs](#the-threshold-the-demo-no-longer-needs).

### F1 — an orphan that has never resolved once draws no badge (PLAN §3.3 / SPEC §5.1)

**Severity: medium (spec claim vs implementation). Status: FIXED in wave 4 (SPEC §2.4, decision
log #29).**

*Repro*: `/pages/popover.html` → open the portalled popover → place a thread inside it → close the
popover → **reload the page**.

*Expected* (PLAN §3.3: "Orphaned threads stay reachable: dimmed badge docked at last-known
position + listed in the panel's unanchored section"): a dimmed, dashed, docked badge.
*Was*: the thread was `orphaned`, the record survived, the panel listed it under
`unanchored (1)` — but `anchoring.rect` was `null` and comment-ui therefore rendered **no badge at
all** (`badgeVisible`, `badge.ts`).

*Why*: `anchoring.rect` is a live derivation, never persisted. A thread that orphans on the
**first** resolution pass after a cold load had no last-known position to dock at. Warm orphaning
(close the popover without reloading) docked correctly.

**Status — fixed.** `ElementCapture.rect` is written once, at capture, by `captureElement`; an
orphan with no live rect docks there. Both alternatives were rejected in decision log #29:
persisting the live rect would make orphaning a write, and the same scenario asserts on raw bytes
that it is not (`orphaning wrote nothing to the store: equal: true, 1580 bytes`); docking to the
panel edge answers a different question than the one PLAN asks. Measured this run: the cold
orphan docks at `{top: 866, left: 57, 1366×52}` with `opacity 0.55`, a dashed border and the
orphan glyph, and the assertion that used to be the bench's only documentation-vs-code
disagreement now passes. The field is additive and optional — a record written before it existed
still has `rect: null` and behaves exactly as it did.

### F4 — hashed-class churn is **not** a non-event: `attribute-churn` does not reproduce

**Severity: high** (the finding), **medium** (the underlying instability). **Status: FIXED in
wave 4 (SPEC §2.5, decision log #28).** Four consecutive runs of
`node bench/run.mjs attribute-churn` scored **5/6, 4/6, 4/6, 2/6**. Only F3 failed in all four;
`after reload (classes re-hashed)`, `after class churn` and `after reset` each orphaned in at
least one run, and run 2 orphaned on all four consecutively.

*Mechanism (engine, not harness).* The page renders `class="card css-<hash> sc-<hash>"` with
`hash = Math.random().toString(36).slice(2, 8)` and regenerates both hashes on every render.
`isStableClass` (`packages/comment-core/src/anchor/fingerprint.ts`) delegated to finder v4's
`className`, i.e. `wordLike`: letters and hyphens only, every hyphen-separated segment longer
than two characters, no run of four consecutive non-vowels. A base-36 hash that happens to come
out digit-free and vowel-spread satisfies all three. Measured over 200 000 generated names:

| Generated class | Kept as "stable" |
| --- | --- |
| `css-<hash>` | **5.8 %** |
| `sc-<hash>` | 0 % (the two-letter `sc` segment is rejected outright) |

So roughly one render in seventeen leaked a per-render-random class into `stableClasses` — on the
capture side it was baked into the stored fingerprint, on the resolve side it appeared in
`stableClassesOf(live)`, and either way the Jaccard term in `scoreCandidate` dropped.

**Status — fixed, exactly as the finding proposed.** A class is admitted only when it is
word-like **and** carried by a second element in the document: a per-render hash is unique by
construction, so corroboration separates it from `card` at zero extra cost (one
`getElementsByClassName` per class, at capture only). The resolve side no longer filters the live
class list at all — it scores **coverage of the vetted stored set**, so new classes on the live
element are not looked at. Measured: the fingerprint for the churn page's paragraph is
`stableClasses: ["card"]` in every run, and the three class-churn steps report 1.000 `via attr`
in **4 runs out of 4** (6/6 each). The `bench-findings.test.ts` suite drives 72 render pairs over
the word-like hash pool the 5.8 % figure describes, and asserts 1.000 on all of them.

The cost, stated in decision log #28: a genuinely singleton semantic class (`sidebar`) is no
longer evidence either — the engine cannot tell it from a hash without a second observation.
Classes are 0.22 of the weight and, since #26, never decisive on their own.

*What this costs a real app* (unchanged): only frameworks that regenerate class hashes **per
render** were ever exposed; a build-time hash is stable across renders and was always harmless,
as is Tailwind.

### Non-failures worth recording

- **A focused `<input type="checkbox">` swallows the trigger key.** `isEditableTarget`
  (`placement.ts:76`) returns `true` for every `<input>` regardless of `type`, so pressing `c`
  right after ticking a checkbox does nothing. The bench works around it (`blurActive()`); a user
  cannot. Cheap fix: exclude non-text input types. **Still open** — not touched in wave 4.
- **A second press of the same trigger key cancels placement** (documented toggle, §4.5) — worth
  knowing because it looks identical to "the key never fired".
- Resolution is still fast: every recorded `explain()` totalled **0.0–0.4 ms**, usually one or
  two attempts, unchanged by #26/#27 despite the added document lookups. Those are bounded at
  `1 + min(attrs, 8)` per *resolve* (not per candidate) and are only issued for a component that
  actually mismatches, so the common path issues none at all.

## Real-site smoke

Re-run in wave 4. Best effort, no auth. Injection is CDP `Runtime.evaluate` (the extension's
isolated world), so the CSP column reports the **separate** question "would a plain `<script>` tag
work here?".

| Site | Target | Inline `<script>` allowed? | Placed | After reload + re-inject | Same element? | Stored-record re-resolve @0.62 / 0.85 / 0.9 |
| --- | --- | --- | --- | --- | --- | --- |
| `en.wikipedia.org/wiki/Anchor` | body `<p>` ("Anchors can either be temporary or permanent…"), Parsoid `id="mwPg"`, no classes | ✅ yes | anchored 1.000 (`attr`) | anchored **1.000** (`attr`) | ✅ | 1.000 / 1.000 / 1.000 (`attr`) |
| `developer.mozilla.org/…/MutationObserver` | link-free `<p>` ("Creates and returns a new MutationObserver…") — **no id, no class, no `data-*`** | ❌ **blocked by CSP** | anchored 1.000 (`css`) | anchored **1.000** (`css`) | ✅ | 1.000 / 1.000 / 1.000 (`css`) |

Identical to the previous run, which is the point: MDN's fingerprint carries **nothing but tag,
text and box** (`{id: null, attrs: {}, stableClasses: []}`), so it is the case #26's verifier is
most likely to have broken — the digest is the only thing that can license the match, and it
matches exactly, so it still resolves at 1.000 through the generated selector.

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

## Extension smoke

**Not re-run in wave 4** — the numbers below are from the 2026-08-03T04:5x run and the shots are
that run's. Nothing in #26–#29 touches the bridge, and what this smoke exercises (place on an
`<h1>` with an id, reload, re-anchor) resolves `via attr` on a confirmed unique id, the one path
none of the four rules can change. Re-running it needs a fresh MV3 build and a second browser
session, which is worth doing next to a bridge change, not next to a scoring change.

| Check | Result |
| --- | --- |
| `pnpm --filter exp-spec-extension build` | ✅ `.output/chrome-mv3`, 749 kB total |
| content script injected at `document_start` on `https://example.com` | ✅ `<exp-spec-host>` shadow host + comment-ui's own shadow root both present |
| keyboard trigger `c` → click → type → `Ctrl+Enter` | ✅ composer opened (`data-open="true"`, textarea focused), thread created |
| badge anchored on the clicked `<h1>` | ✅ `data-anchor="anchored"`, `data-status="open"`, centre 41 px left / 5 px above the element's top-right corner |
| **reload** → re-anchor from `chrome.storage` | ✅ same thread id `nnIT4X5eAhOL`, `data-anchor="anchored"`, `data-approximate` unset, identical badge position |

Shots: `ext-01-placed.png`, `ext-02-after-reload.png` (byte-identical: Chrome restores the scroll
position and both renders are deterministic). Not covered: the copilot bridge (needs an API key),
the batch pill, `chrome.commands` shortcuts, and the options page.

## Screenshot index

`shots/` — 29 PNGs, 28 distinct. Demo scenarios (`<scenario>-<step>-<label>.png`) and real sites
(`site-<name>-0N-*.png`) are from the wave-4 runs recorded at the top of this file; the two
`ext-0N-*.png` are the earlier run's and are the only remaining byte-identical pair.
`infinite-scroll-13-orphaned.png` is now what its name says — it was the mis-anchor before.
