# DESIGN — the `glass` presentation (LOCKED)

> **Status: LOCKED.** This document is the design contract for
> `@astrale-os/comment-ui/glass` (`glassPresentation`), the extension's host chrome
> (`packages/extension/src/content/`), the extension options page and `apps/demo`. Every token,
> curve, duration, path, px value and disclosure rule below is normative. Implementers must not
> make design decisions; if something appears underspecified, it is a design bug — fix this
> document, then the code.
>
> **It does not govern `domPresentation`.** The default presentation (today's markup,
> class names and `commentUIStyles`) is **frozen**: bug fixes and a11y fixes only, no design
> changes, no new class names. See SPEC-comment-core §3.1.9.
>
> **It never renegotiates the API.** The theming surface stays the eleven `--cc-*` custom
> properties of SPEC §3. **Zero new public tokens.** Everything below is a private `--_*` alias
> derived from those eleven, read as `var(--cc-x, <default>)` and **never declared** on `:host`.
> `Labels` stays a locked 17-key interface; this document renders fewer of them *visually* and
> demotes the rest to `title` / `aria-label`, where they remain 100 % used and 100 % translatable.
>
> Converged from three entropy− visions (materials, motion & depth, intent minimalism).
> Rulings in §13.
>
> **§0 outranks every other section of this document.** It records nine rulings the user issued
> after testing the shipped product. Where §0 and any later section disagree, §0 wins — and the
> disagreement is a bug in the later section, which has been edited in place rather than left to
> be reconciled by a reader.

---

## 0. User decree (2026-08-03) — NORMATIVE, TOP PRIORITY

The user tested the real product and issued nine rulings. **They override this document, the
tester consensus recorded in §15, and every prior ruling in §13 where they conflict.** Every
contradicted section has been edited in place; §0 is the record of *why* and the anchor those
edits point back to. Where a ruling moves the controller ↔ presentation seam, the decision row
lives in `docs/SPEC-comment-core.md` §8 (**#42–#48**) and is named in the row below.

**P0 — the principle the nine rulings are instances of.** Read out of the three products the
decree names as the target (Vercel preview comments, Figma comment pins, and — for thread
internals only — Google Docs): **hover only ever ADDS; it never CONCEALS.** Vercel hovers a
timestamp to *gain* session data; Figma hovers a pin to *gain* a preview; Docs hovers a comment to
*gain* the action cluster. In none of them does hover restore information that was withheld.

§1's first law is therefore **scoped, not repealed**: intent-based hiding applies to *surfaces at
rest* and to *actions*. It **never** applies to information inside a surface the user has already
opened. P0 decides D2, D3 and D7 at once and is the tiebreaker for anything §7 does not name.

| # | Ruling | Concrete decision (normative) | Sections edited |
|---|---|---|---|
| **D1** | The heavy dark outline around the thread popover is ugly. Hairline + soft shadow, never a visible thick border. | Glass is **elevation, never stroke**. No glass surface carries `border:` and **no glass surface ever takes the §3.3 keyline sandwich** — the sandwich is for opaque marks sitting on unknown content, and doubling a ring on a surface that already has a 56 px shadow tail is exactly the "thick dark outline" complained about. `--_e3` is one 0.5 px hairline (α .10 light / .16 dark) + the `--_line-in` specular inset + `--_shadow`'s three-layer tail. Dark mode keeps the **same black shadows** and lifts the surface, rather than thickening the ring: `--_line-out` dark drops **.58 → .16** and separation comes from `--_line-in` at α .10. Internal separations are `--_line-sep` hairlines only. | §2.2, §3.3, §3.4, §11.2 |
| **D2** | Hiding "x minutes ago" until hover is disturbing. Metadata of an OPEN thread is always visible. | The comment header row is **permanently rendered** and is the first thing in the row: `[author mark] [relative time] [edited mark] … [actions]`. `--_t-11`, `--_muted`, `tabular-nums`. **Never `opacity: 0`, never `display: none`, no hover gate, no proximity gate, no responsive drop, no 3 px dot.** Hover *adds* a native `title` with the absolute datetime — additive only, per P0. The author mark is a 12 px `cc-i-sparkle` on copilot rows and **nothing** on user rows: `Author` is a locked two-value union with no name and no avatar (SPEC §2.2, decision #6), so the mark is a difference marker and its absence is the majority case; both authors keep the word in `aria-label`. | §1.1, §7 rows 13–14, §8.4, §10 |
| **D3** | The pencil is far too prominent — one per row is noise. Edit becomes discreet; timestamps stay permanent. | One right-aligned **actions cluster per comment row**, `opacity: 0; position: absolute; inset-inline-end: 0` → `opacity: 1; position: relative` on `:hover`, `:focus-within`, `[data-confirm]`. Contents: 16 px `cc-i-pencil` (own comments) + 16 px `cc-i-trash` (arms, §6.4). Always **mounted** — keyboard and AT reach it, and swapping `position` alongside `opacity` is what stops the row from reflowing on hover. Transition: `opacity` only, `--_d1`. No pencil at rest at any breakpoint or pointer type. **Deliberately not the reference products' `⋯` menu**: `⋯` exists there to host *text* items (`Edit`, `Copy link`, `Delete`), and §10 forbids drawn verbs — two icons at α 0 is strictly less chrome than a menu that opens a text list, and it adds no `Labels` key. | §7 rows 12–13, §8.4 |
| **D4** | Reply must not open to the side. Inline field at the bottom of the thread. | Thread = `[comments] → --_line-sep hairline → composer`. A **permanently rendered, collapsed, single-line reply field** sits at the thread's bottom edge whenever `ThreadVM.actions.reply`; focus expands it in place into the full composer (auto-grow 2→8 rows, `⌘↵` hint on `:focus-within`). Never a side panel, never a second floating surface, never a popover on a popover. The reply composer is a **child of the thread surface**: the presentation registers `host.anchor('composer', null)` so the controller positions nothing for it (SPEC #47). `⌘↵` submits, `Esc` collapses it back (and only then continues the §7 dismissal chain). | §7 rows 15, 29, §8.3, §8.4 |
| **D5** | The "?" glyph is disturbing; two icons + a count on one badge is ugly. One glyph per pin; comment vs ask by hue only. | The pin's payload is **exactly one mark, always**: the host's `Mode.badge.icon` when supplied, else `cc-i-comment`. **`cc-i-ask` is deleted** (§5 drops to 18 glyphs) and the "?" with it — mode differentiation is `--_kind-h` (§2.3) and nothing else, on every surface. **The count never draws on the pin**; it lives in `aria-label`, the panel row and the batch pill, exactly as Vercel keeps the count in the Inbox and not on the dot. The **state mark replaces the payload** rather than riding beside it (resolved ⇒ `cc-i-check`, failed ⇒ `cc-i-warn`), and the chip leaves the pin's face for the pin's **ring** (unread ⇒ accent ring, busy ⇒ breathing ring, failed ⇒ `--_warn` ring). **Mode is not state:** §1.3 still binds every state (each keeps its silhouette, screenshot-legible with no hue), and mode is explicitly exempt — it is a hint, not an identifier (§2.3), and it keeps its word in `title` / `aria-label` where `forced-colors` cannot erase it. | §1.3, §2.1, §2.3, §5, §7 rows 1–4, §8.1, §10 |
| **D6** | The top of the popover is wasted by a logo row. First message at the very top; close floats; zero header chrome. | The §8.4 head (kind glyph · state silhouette · chip · close) is **deleted outright**. The first comment's top edge is **10 px** below the popover's top edge and nothing is above it. Close (`cc-i-close`) and **thread-level** resolve (`cc-i-check`) float as one **overlay cluster in the top-right corner**, absolutely positioned over a 56 px gutter reserved on the first comment's inline-end so text never runs under them; α .55, → 1 on `:hover`/`:focus-visible`, **always visible while the thread is open** (it is an affordance on an opened surface, so P0 forbids gating it). Resolve appears **once per thread**, never per reply — both reference products put a single thread-level ✓ in exactly that corner. Delete leaves the corner for the per-comment cluster (D3), which also retires the A4 adjacency hazard. Popover width **350 px**. | §7 rows 10–12, §8.4, §10 |
| **D7** | Placement mode must not draw an inspect-element frame. Fully transparent; a custom cursor is the only signal. | The picker outline, the scrim, the `--_wash`, the four corner ticks, the dwell hint capsule, the cursor-riding disc and the all-badges-dim-to-α-.25 rule are **all deleted**. During placement the host page renders **byte-identically** and our own pins stay at full opacity. The only signal is the **cursor**: a 24×24 CSS-px pin image (48×48 via `image-set()` at 2×), **hotspot on the pin's sharp corner at `2 22`** so the cursor tip *is* the anchor point, tinted by `--_kind-h`, `crosshair` as the keyword fallback. It is delivered by pushing **one constructed `CSSStyleSheet`** onto `document.adoptedStyleSheets` for the duration of picking, via `PresentationHost.cursor()` (SPEC #46) — never an injected `<style>` node, never an inline style write. §11 rule 7 is restated, not weakened: *"never mutated"* = no node inserted or removed, no attribute written, **no `MutationObserver` record generated**; `adoptedStyleSheets` is a document property, is unobservable by the page's own observers, and is popped in a `finally` and on `destroy()`. `Labels.pickHint` stays in `role="status"`. Drag stays unbound, reserved for region capture. | §7 rows 18–20, §8.2, §11.7 |
| **D8** | Clicking a generic area does nonsense. The composer opens at the exact click point; store the click offset; add a target-confidence heuristic. | **The raw point is always stored** — `AnchorDescriptor.point` (`dx/dy` px from the anchor's border-box top-left, `fx/fy` as fractions of it, `docX/docY` document-space, plus the viewport `w/h/dpr` at capture; SPEC §2.4, #42). **Confidence heuristic** (SPEC §2.5 `assessTarget`, #43) — Figma's "attach to the top-level frame, never a nested layer" rule ported to the DOM. Rejections and weights: root (`html`/`body`) **fatal**, ≥ **55 %** of viewport area **0.45**, no own content **0.35**, no own identity **0.30**, pass-through wrapper **0.25**; `confidence = clamp(1 − Σw, 0, 1)`, **low-confidence below 0.50**. On rejection the thread does **not** anchor to the giant element: it anchors to the nearest landmark (`closest()` over the landmark set, ≤ 8 hops; else the nearest confident descendant within **240 px** of the click point, depth ≤ 3, ≤ 200 elements; else `document.scrollingElement` with a document-space point) and the click point is stored relative to *that*. **In every branch the composer opens at the literal click coordinates** — the heuristic changes only what the point is stored *relative to*, never where a pixel lands. Positioning is a controller-owned floating-ui **virtual reference** at the live point, `placement: 'right-start'`, `offset(6)`, `flip()`, `shift({ padding: 8 })` (SPEC #44). A low-confidence pick swaps the **cursor**, never draws a frame (D7). | §7 rows 15, 20, §8.1, §8.2, §8.3 |
| **D9** | Model the experience on Vercel preview comments and Figma comment pins. No patterns from unrelated products. | The composite target, and the only sanctioned reference set: **floating puck toolbar** (host chrome, §8.7) → **transparent placement mode with a pin cursor** (D7) → **28 px teardrop pin whose one 2 px corner sits on the click point**, avatar-slot payload, `translate()` per quadrant so the pin never covers its own anchor (D5, §8.1) → **350 px chrome-less elevated popover, 6 px to its right, top-aligned, flipping at edges** (D1, D6, D8) → **permanent author + time, hover-only per-row actions, one thread-level ✓ in the corner, collapsed inline reply at the bottom** (D2, D3, D4, D6) → **panel mirroring the pins with sections and counts** (§8.5). Only Google Docs' *thread internals* are imported (single thread-level resolve, resolved threads keep an audit trail). Nothing from unrelated products: **no side drawer, no per-row pencil at rest, no inspect-mode chrome, no logo row.** | §8.1–§8.5, §13 |

**Two conventions lifted from the references that the decree does not name, adopted here:**
(a) the viewport `width/height/dpr` and the page key are captured **with** each thread (Vercel's
per-comment session payload) — that is what keeps a coordinate anchor legible when the same page
is reopened at another width, and it is what the timestamp's `title` can surface; (b) threads are
**deep-linkable** — `engine.focus()` is already the mechanism, and the host owns the URL.

---

## 1. The five laws

1. **Nothing exists until intent is expressed — at rest.** Rest state is the smallest legible mark
   that still says "something is here". Everything else is summoned. §7 is the normative map.
   **Scoped by §0's P0:** this law governs *surfaces at rest* and *actions*. It has no authority
   inside a surface the user has already opened — there, hover may only ever *add* (a tooltip, a
   preview, an action cluster), and **information is never withheld and then restored**. An open
   thread's author, relative time, body and count are unconditionally drawn.
2. **Legibility is contract; glass is decoration.** The moment "subtle liquid glass" and
   "readable on top of a page nobody controls" disagree, glass loses — automatically, via three
   hardcoded kill switches (§3.2) and an opacity floor that the design never crosses.
3. **Colour never carries state alone; motion never carries state alone.** Every state also has
   a drawn glyph or a silhouette that reads identically in a screenshot, under
   `prefers-reduced-motion`, and under `forced-colors`. **Mode is not state (§0 D5).** Which mode a
   thread belongs to is carried by hue alone (`--_kind-h`, §2.3) plus the word in
   `title` / `aria-label`; it earns no second glyph, because a mode is a hint about *which kind of
   conversation this is*, never a condition the user must be able to read off a screenshot. Open,
   resolved, orphaned and approximate keep their silhouettes, unchanged.
4. **We are spending someone else's frame budget.** Only `transform`, `translate`, `scale`,
   `opacity`, `clip-path` and `mask-image` animate. Never `backdrop-filter`, never `filter` on a
   tracked node, never a layout property on a controller-positioned node (§6.5).
5. **Text is the failure mode.** A visible string must be a *value* (a count, a body, a result)
   or the only thing naming a box. Verbs and nouns are icons with a native `title`. §10 is the
   audit and it is normative — a string not in §10's "keep" column may not be drawn.

---

## 2. Colour

### 2.1 The eleven public tokens — glass defaults

Read as `var(--cc-x, <default>)` into a private alias. Light is the base block; dark is the same
reads inside `@media (prefers-color-scheme: dark)`, so a host that sets a token explicitly keeps
it in both schemes.

| Alias | Public token | Light default | Dark default | Notes |
|---|---|---|---|---|
| `--_accent` | `--cc-accent` | `oklch(59.6% 0.211 254)` | `oklch(64.2% 0.191 253)` | systemBlue, light/dark twins |
| `--_surface` | `--cc-surface` | `oklch(99.2% 0.002 264)` | `oklch(24.5% 0.012 264)` | dark is **never** near-black (§2.4) |
| `--_surface-2` | `--cc-surface-2` | `oklch(96.4% 0.004 264)` | `oklch(29.0% 0.013 264)` | nested fills, inset lists |
| `--_text` | `--cc-text` | `oklch(19.0% 0.012 264)` | `oklch(96.0% 0.004 264)` | |
| `--_muted` | `--cc-muted` | `oklch(55.0% 0.014 264)` | `oklch(70.5% 0.012 264)` | ≥ 4.5:1 on both surfaces |
| `--_border` | `--cc-border` | `oklch(89.0% 0.005 264)` | `oklch(38.0% 0.012 264)` | separators only, never an outline |
| `--_danger` | `--cc-danger` | `oklch(58.5% 0.222 27.3)` | `oklch(66.0% 0.214 28)` | **text-grade**, see §2.4 |
| `--_badge-size` | `--cc-badge-size` | `28px` | — | the *revealed* **pin** size; rest is a 12px dot (§7 row 1). 22 → 28 by §0 D5/D9: the pin's payload is now one full-bleed mark inside 3px of padding, which is 22px of glyph — the old number, now the inner one. Glass-only; `domPresentation` keeps 22px (SPEC decision #39) |
| `--_radius` | `--cc-radius` | `10px` | — | "a floating box"; §3.4 derives the rest |
| `--_font` | `--cc-font` | `-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif` | — | no web fonts, ever (bytes + CSP) |
| `--_shadow` | `--cc-shadow` | `0 0.5px 1px oklch(0% 0 0/.06), 0 8px 20px -6px oklch(0% 0 0/.14), 0 24px 56px -16px oklch(0% 0 0/.18)` | `0 0.5px 1px oklch(0% 0 0/.5), 0 10px 22px -8px oklch(0% 0 0/.55), 0 28px 64px -20px oklch(0% 0 0/.72)` | drives `--_e3`'s long tail |

### 2.2 The derived ramp — private, ~30 values from those eleven

Relative colour is the keystone: it is why the public surface does not have to grow. A host that
sets one `--cc-accent` gets a correct hover, pressed, text-grade, three tints, a focus ring and
**automatic on-accent contrast** for free.

```css
:host {
  --_accent-hi:   oklch(from var(--_accent) calc(l + 0.055) c h);
  --_accent-lo:   oklch(from var(--_accent) calc(l - 0.055) c h);
  --_accent-text: oklch(from var(--_accent) calc(l - 0.10) calc(c * 0.95) h);
  --_accent-06:   oklch(from var(--_accent) l c h / .06);
  --_accent-14:   oklch(from var(--_accent) l c h / .14);
  --_accent-22:   oklch(from var(--_accent) l c h / .22);
  --_ring:        oklch(from var(--_accent) l c h / .38);
  /* L→1 below 0.62, L→0 above. No JS, no second token. */
  --_on-accent:   oklch(from var(--_accent) clamp(0, (0.62 - l) * 1000, 1) 0 h);

  --_danger-fill: oklch(from var(--_danger) calc(l + 0.05) c h);
  --_warn:        oklch(76.0% 0.166 62.4);
  --_ok:          oklch(74.5% 0.180 145.6);

  --_line-out: oklch(from var(--_text) l c h / .10);   /* hairline, outside — see §0 D1 */
  --_line-in:  oklch(100% 0 0 / .55);                  /* light hairline, inside */
  --_line-sep: oklch(from var(--_border) l c h / .70); /* list separators        */
}
@media (prefers-color-scheme: dark), :host([data-polarity='dark']) {
  :host { --_line-out: oklch(0% 0 0 / .16); --_line-in: oklch(100% 0 0 / .10); }
}
```

**`--_line-out`'s alphas are a §0 D1 amendment.** They were `.13` light / **`.58`** dark. At .58,
a 0.5 px ring around a 14 px popover on a dark page is the "heavy dark outline" the decree kills —
it reads as a stroke, not as an edge, because the surface behind it is only ~24 % L and the ring is
nearly black. The rule copied from the reference implementation instead: **dark mode keeps the same
black shadows and lifts the surface** (`--_surface` 24.5 % L, `--_surface-2` 29 %), and its edge
comes from the *inside* — `--_line-in` at α .10 — not from a darker outside ring. Light drops
.13 → .10 for the same reason at smaller amplitude. Nothing else in the palette moves.

**Fallback (mandatory, one block, ~14 lines).** `@supports not (color: oklch(from red l c h))`
redeclares the eight accent-derived aliases with `color-mix(in oklab, …)` at 88 % / 84 % / 6 % /
14 % / 22 % / 38 %, and `--_on-accent: oklch(100% 0 0)`.

### 2.3 Mode hues

`Mode.kind` is an opaque string and modes carry no colour. Each mode takes a deterministic hue
offset **by index in `engine.modes`** (never a hash of the string): `[0, +38, −34, +72, −68]`,
applied as `oklch(from var(--_accent) l c calc(h + var(--_kind-h, 0)))`. **The offset is a plain
number, not an angle** (corrected, A5): inside relative colour syntax `h` resolves to a
`<number>`, so `calc(h + 38deg)` is a type error — the declaration is invalid at computed-value
time, the fill resolves to `transparent`, and every badge on the page becomes a hollow ring. `comment` is the
accent; `ask` is a warm violet; a third mode is teal. Beyond index 4 the offset repeats from 0 —
colour is a hint, not an identifier.

**Hue is now the *only* mode differentiator (§0 D5).** The sentence this paragraph used to end
with — "and every mode also has its own glyph" — is repealed. `cc-i-ask` is deleted (§5), no
surface draws a second glyph to say which mode it belongs to, and the mode's word survives in
`title` / `aria-label` on every surface that carries `data-kind`. The cost is stated rather than
hidden: under `forced-colors: active` all modes look alike, which is acceptable precisely because
a mode is a hint and never a state (§1.3) — nothing a user must act on is encoded in it.

The index is the one thing a presentation cannot re-derive (it has no mode list), so the ordered
kinds cross the seam as `UIViewModel.kinds` (SPEC-comment-core §3.1.2, decision log #41) and the
**offset table stays here**, in the design layer. `--_kind-h` is written on the surface that
carries `data-kind` — pin, thread, composer, panel row — and the five places that spend it are
**the pin's fill, the pin's ring, the placement cursor image, the composer send disc, and the
thread's accent** (the reply field's focus ring and the `--_accent` left rail of a new comment).
The pick ring and the cursor disc are gone with §0 D7; the thread head glyph is gone with D6.
Everything else stays `--_accent`: a hue is a hint about *which mode*, not a second palette.

The cursor image is the one consumer that cannot read a custom property — a `cursor: url(…)` data
URI is not styleable — so its hue is **templated into the SVG string once per `placement:start`
and cached by kind** (~380 bytes, built by the presentation, handed to the controller through
`PresentationHost.cursor()`; SPEC #46).

### 2.4 Two calls inside the palette, stated so they are not "fixed" later

- **`--_danger` is text-grade, not fill-grade.** systemRed at 63.3 % L hits ~3.4:1 on white at
  12 px and fails. 58.5 % clears 4.5:1. The fill red is derived (`--_danger-fill`) and private.
- **Dark surface is 24.5 % L, never near-black.** macOS vibrancy sits *above* the desktop, not on
  it. A `#000` popover over a black host page has no edge at all.

### 2.5 Page polarity (not a token, not an API)

At `create()` and on every `page:change`, `glassPresentation` reads
`getComputedStyle(doc.body).backgroundColor`, computes relative luminance, and if it contradicts
`prefers-color-scheme` writes `data-polarity="dark" | "light"` **on its own layer**. Every dark
block is `@media (prefers-color-scheme: dark), :host([data-polarity='dark'])`. A host that set a
`--cc-*` colour explicitly still wins, in both polarities, because the `var(--cc-x, default)`
chain is untouched. This is the single biggest legibility win on arbitrary pages: a light widget
on a dark host page is a flashlight in the face, and today it happens whenever the OS is light
and the page is not.

---

## 3. Materials

Three materials and nothing else.

| Material | Where | Rule |
|---|---|---|
| **Glass** | thread popover, composer, panel sheet, pick hint, host pill, toast, options footer bar | Blurs the *host page*. Owns its own rectangle in the top layer. Has a floor and three kill switches. |
| **Solid** | pins, panel seed/disc, chips, marks | Anything sitting **on** unknown content is opaque. You cannot guarantee legibility over a photograph. |
| **Ink** | type + 16px stroke icons | One family, one stroke width, `currentColor`. |

### 3.1 The glass recipe (exact)

```css
:host {
  --_glass-bg:   color-mix(in oklab, var(--_surface) 74%, transparent);
  --_glass-bg-2: color-mix(in oklab, var(--_surface-2) 78%, transparent);  /* nested */
  --_glass-fx:   blur(28px) saturate(180%) brightness(1.02);
}
@media (prefers-color-scheme: dark), :host([data-polarity='dark']) {
  :host { --_glass-bg: color-mix(in oklab, var(--_surface) 64%, transparent);
          --_glass-fx: blur(28px) saturate(170%) brightness(0.86); }
}
.cc-glass {
  background: var(--_glass-bg);
  backdrop-filter: var(--_glass-fx);
  -webkit-backdrop-filter: var(--_glass-fx);
  contain: layout style paint;
}
```

**Opacity floor: 74 % light / 64 % dark.** The design never crosses it, even where it would look
better. Below that, 13 px text over a Wikipedia infobox stops being readable.

**Glass budget: two composited blurred surfaces at once, maximum** (a popover and the panel, or
the pill and a toast). The blur radius never animates and is at full strength on frame 1 —
animating `backdrop-filter` is the single most expensive thing you can do on someone else's page.

### 3.2 The three kill switches (hardcoded, no host opt-out)

```css
@media (prefers-reduced-transparency: reduce) { :host { --_glass-bg: var(--_surface); --_glass-fx: none; } }
@media (prefers-contrast: more) { :host { --_glass-bg: var(--_surface); --_glass-fx: none;
                                          --_line-out: oklch(from var(--_text) l c h / .38); } }
@supports not (backdrop-filter: blur(1px)) { :host { --_glass-bg: var(--_surface); } }
@media (forced-colors: active) {
  .cc-glass { background: Canvas; color: CanvasText; border: 1px solid CanvasText;
              backdrop-filter: none; box-shadow: none; }
  :focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
}
```

### 3.3 Hairlines are `box-shadow` spreads, never `border`

`border: 1px solid` is invisible on half the web — dark-on-dark or light-on-light depending on
the token. A `box-shadow` hairline costs no layout, renders sub-pixel, composes with elevation in
one property, removes every `calc()` from the concentric-radius rule (there is no border box to
subtract), and **can be doubled**.

**The keyline sandwich — normative on every opaque-on-unknown element** (pin, panel seed, chips,
marks): a dark hairline outside, a light hairline inside.

```css
box-shadow: 0 0 0 .5px oklch(0% 0 0/.28), 0 0 0 1.75px oklch(100% 0 0/.55), var(--_e0);
```

The pin stays visible on white, on black, on a photograph and on a `#4f46e5` hero. One hairline
does not.

**And it is forbidden on glass (§0 D1).** The sandwich exists for a ≤ 28 px opaque mark sitting
directly on content nobody controls, where there is no shadow tail to read an edge from. A glass
surface owns its own rectangle in the top layer and already carries 56 px of ambient shadow; a
2.25 px doubled ring on top of that is not an edge, it is a stroke — and it is precisely the
"heavy dark outline" the decree kills. **Normative:** `.cc-glass` never declares `border`, never
takes the sandwich, and its entire edge is `--_e3` (one 0.5 px `--_line-out` hairline + the
`--_line-in` inset specular + `--_shadow`). The picker outline is not on this list any more
because it no longer exists (§0 D7, §8.2).

### 3.4 Elevation — four steps, always layered

| Level | Use | Value |
|---|---|---|
| `--_e0` | pin at rest, chip, seed | `0 0 0 .5px var(--_line-out), 0 1px 2px -1px oklch(0% 0 0/.16)` |
| `--_e1` | pin revealed, row hover | `0 0 0 .5px var(--_line-out), 0 1px 1.5px oklch(0% 0 0/.07), 0 4px 10px -3px oklch(0% 0 0/.15)` |
| `--_e2` | panel disc, host pill, toast | `0 0 0 .5px var(--_line-out), 0 2px 4px -1px oklch(0% 0 0/.08), 0 10px 24px -8px oklch(0% 0 0/.19)` |
| `--_e3` | composer, thread popover, panel sheet | `0 0 0 .5px var(--_line-out), inset 0 0 0 .5px var(--_line-in), 0 1px 2px oklch(0% 0 0/.06), var(--_shadow)` |
| `--_ring` | focus | `0 0 0 3px var(--_ring)` |
| `--_halo` | pin focus / selected (§0 D9) | `0 0 0 2px var(--_surface), 0 0 0 4px var(--_accent)` — two-tone, still no border |

**Light source is 135° (top-left) everywhere**: specular on the top edge (`--_line-in` inset),
shadow down-right. In dark scheme, separation comes from the light rim, not a darker shadow.

**`--_e3`'s inset became a full ring (§0 D1).** It was `inset 0 .5px 0 var(--_line-in)` — a
top-edge-only specular, which left the popover's bottom and side edges relying entirely on the
outer ring, which is exactly why that ring had to be pushed to α .58 in dark mode and why the
result read as a border. A full `inset 0 0 0 .5px` hairline at α .10 closes all four edges from
the inside, so the outer ring can stay a true hairline in both schemes. The 135° light story is
unchanged: the *specular* still reads top-left because `--_line-in` is a light colour over a
surface that is lighter at the top.

**Focus rule:** `outline: none` + `box-shadow: var(--_ring), <its elevation>` on `:focus-visible`,
so the ring follows the exact radius; plus the `forced-colors` outline in §3.2. A focus ring is
never removed and never the browser default.

### 3.5 Radii — concentric

```
--_r-xs: 4px    chip, mark, inner control inside a padded card
--_r-sm: 6px    small buttons, reply field at rest
--_r-md: 8px    inputs, panel rows, comment cards
--_r-lg: var(--cc-radius, 10px)
--_r-xl: calc(var(--_r-lg) + 4px)     /* 14px — panel, composer, thread */
--_r-pill: 999px
```

**Rule: `inner = outer − padding`.** A 14 px popover with 10 px padding gets 4 px internals.
Concentricity is the one detail that makes a nested stack look machined rather than assembled.

Progressive enhancement, free: `@supports (corner-shape: squircle) { .cc-glass { corner-shape: squircle; border-radius: 18px } }`.

### 3.6 Spacing

4 px grid with a 2 px sub-grid: `2 4 6 8 10 12 16 20 24 32`. Floating boxes pad `10px`. Lists
bleed to the box edge with separators inset `10px` (macOS list inset). Corner insets `16px`,
dropping to `12px` under 480 px viewport width. Every control has ≥ 44 px of hit area via
`::after { position:absolute; inset:-11px }` — never via visual size.

---

## 4. Type

No `rem`, anywhere (`html { font-size: 62.5% }` is common enough to be lethal, and `:host` carries
`all: initial` + an explicit `font-size`). Tracking tightens as size grows — that is SF's optical
axis reproduced with the one lever the web gives us.

| Token | Size / line-height / tracking / weight | Where |
|---|---|---|
| `--_t-10` | 10px / 13px / +0.01em / 500 | state marks, the edited mark's row |
| `--_t-11` | 11px / 15px / +0.006em / 500 | timestamps, counts in meta, section titles (uppercase, +0.06em) |
| `--_t-12` | 12px / 16px / +0.003em / 500 | buttons, chips, panel row meta, batch-pill count |
| `--_t-13` | 13px / 19px / 0 / 400 | comment bodies, panel row bodies — the reading size |
| `--_t-15` | 15px / 21px / −0.006em / 400 | composer textarea; popover title at 600 |
| `--_t-17` | 17px / 23px / −0.012em / 600 | panel heading, options section headers |
| `--_t-22` | 22px / 27px / −0.018em / 640 | options page title only |

Global: `font-synthesis: none`, `-webkit-font-smoothing: antialiased` **only** inside the dark
block (on light backgrounds it thins system fonts below intent), `font-optical-sizing: auto`,
`font-variant-numeric: tabular-nums` on every count and every timestamp (`.cc-row-meta`,
`.cc-pill-count`, `.cc-time`) — counts change in place and must never jitter, and `.cc-time` is
now permanent (§0 D2) so a re-tick from "5 minutes ago" to "6 minutes ago" must not reflow the
row. `.cc-badge-count` leaves the list because the pin no longer draws one (§0 D5). Emphasis weight is
`font-variation-settings: 'wght' 590` guarded by `@supports`, else 600.

---

## 5. Icons — 18 hand-drawn glyphs

**Spec.** `viewBox="0 0 16 16"`, live area 13×13 inset 1.5, `fill: none; stroke: currentColor;
stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke`.
**Every stroke centerline lands on a ¼-pixel offset (`n.25` / `n.75`)** — at 2× DPR a 1.5 px stroke
is exactly 3 device pixels and a half-integer device centerline covers three whole pixels. That
is why these read as cut rather than drawn, and why they stay crisp at 10 / 12 / 14 / 16 / 20 px.

**Delivery.** One `<symbol>` sprite, injected **once** into the shadow root by `glassPresentation`,
referenced as `<use href="#cc-i-check">`. Not `mask-image` (loses multi-path and two-tone), not an
icon library (there is none in this product, by rule). **≈ 2.2 KB raw / 0.9 KB gz for all 18.**

| id | Meaning | Path (normative) |
|---|---|---|
| `cc-i-comment` | the pin's default payload, the placement cursor, panel "open" — **for every mode** | `M13.25 7.75a5.25 5.25 0 0 1-7.35 4.87L2.75 13.5l.9-2.85A5.25 5.25 0 1 1 13.25 7.75Z` |
| `cc-i-check` | resolve, saved | `M3.25 8.25 6.5 11.5 12.75 4.75` |
| `cc-i-uturn` | reopen, restore defaults | `M8 2.75A5.25 5.25 0 1 1 2.75 8` + `M1.25 9.75 2.75 8 4.25 9.75` |
| `cc-i-close` | dismiss | `M4.25 4.25 11.75 11.75` + `M11.75 4.25 4.25 11.75` |
| `cc-i-reply` | reply | `M6.25 3.75 2.75 7.25l3.5 3.5` + `M2.75 7.25h6a3.5 3.5 0 0 1 3.5 3.5v1.5` |
| `cc-i-pencil` | edit | `M10.9 2.85a1.63 1.63 0 0 1 2.3 2.3L5.6 12.75l-3.1.6.6-3.1Z` + `M9.75 4 12 6.25` |
| `cc-i-trash` | delete | `M2.75 4.25h10.5` + `M6.25 4.25V2.75h3.5v1.5` + `M4.25 4.25l.55 8.5h6.4l.55-8.5` |
| `cc-i-send` | send, dispatch | `M8 12.75V3.75` + `M4.25 7.5 8 3.75l3.75 3.75` |
| `cc-i-sparkle` | copilot author | `M8 2.25l1.2 3.3 3.3 1.2-3.3 1.2L8 11.25 6.8 7.95 3.5 6.75l3.3-1.2Z` + `M12.25 11.25l.5 1.25 1.25.5-1.25.5-.5 1.25-.5-1.25-1.25-.5 1.25-.5Z` |
| `cc-i-tilde` | approximate | `M3.25 8.5c1.2-2.1 2.6-2.1 3.9 0s2.7 2.1 4.1 0` |
| `cc-i-pin-off` | orphaned, panel "unanchored" | `M8 2.75a3.25 3.25 0 0 1 3.25 3.25c0 2.4-3.25 6.25-3.25 6.25S4.75 8.4 4.75 6A3.25 3.25 0 0 1 8 2.75Z` + `M3.25 3.25 12.75 12.75` |
| `cc-i-chevron` | disclosure, row affordance | `M6.25 4.25 9.75 8l-3.5 3.75` |
| `cc-i-warn` | failed run, invalid input | `M8 2.75 14.25 13.25H1.75Z` + `M8 6.75v2.5` + `M8 11.5h.01` |
| `cc-i-eye` | reveal key | `M1.75 8S4.25 3.75 8 3.75 14.25 8 14.25 8 11.75 12.25 8 12.25 1.75 8 1.75 8Z` + `M8 6.25a1.75 1.75 0 1 0 0 3.5 1.75 1.75 0 0 0 0-3.5Z` |
| `cc-i-eye-off` | hide key | `cc-i-eye` + `M2.75 2.75 13.25 13.25` |
| `cc-i-arc` | spinner / determinate ring base | `M8 2.25a5.75 5.75 0 0 1 5.75 5.75` |
| `cc-i-stack` | panel toggle, panel heading | `M2.75 5.25 8 2.75l5.25 2.5L8 7.75Z` + `M2.75 8.5 8 11l5.25-2.5` + `M2.75 11.25 8 13.75l5.25-2.5` |
| `cc-i-info` | options hint reveal | `M8 2.25a5.75 5.75 0 1 1 0 11.5 5.75 5.75 0 0 1 0-11.5Z` + `M8 7.25v3.5` + `M8 5.25h.01` |

**Sizes in use:** 10 (marks), 12 (row meta, chips, the copilot author mark), 16 (all controls),
20 (empty states), 22 (the pin's payload, full-bleed inside a 28 px pin), 24 (the cursor image).
Nothing else. 14 leaves the scale with the thread head (§0 D6).

`Mode.badge.icon` is untouched but its arity is now normative: a host string renders as text and
**replaces** the payload; **absent** renders `cc-i-comment` — *for every mode, including `ask`*.
A pin never draws a host icon *and* a glyph, and never a glyph *and* a count (§0 D5).
**Every emoji dies** (`💬 ✕ ✓ ⚑ ~ ?`) — a different font, a different baseline, a different colour
on every OS. `apps/demo` drops its explicit `icon: '?'`.

**`cc-i-ask` is deleted (§0 D5).** It was `cc-i-comment` + a "?" bowl and dot, and the "?" is the
glyph the decree names. Ask threads now differ from comment threads by hue alone (§2.3). The
sprite drops from 19 symbols to 18; `kindIcon()` collapses to a constant.

State marks (`.cc-mark`) are 10 px `<use>` glyphs, not CSS `content` — so "colour never carries
state alone" keeps its guarantee with drawn shapes. **On the pin the mark replaces the payload
rather than riding beside it** (§0 D5, §7 row 3): the pin's face holds exactly one 22 px `<use>`
at any moment, and which symbol that is *is* the state.

---

## 6. Motion

### 6.1 Curve catalog — two springs, three beziers, nothing else

`linear()` shapes are normalized and duration-independent: one shape × any duration.

```css
--_spring-1: linear(0, .234 10%, .589 20%, .839 30%, .967 40%, 1.012 50%,
                    1.020 60%, 1.014 70%, 1.007 80%, 1.003 90%, 1);   /* 2% overshoot  */
--_spring-2: linear(0, .255 10%, .662 20%, .947 30%, 1.068 40%, 1.080 50%,
                    1.049 60%, 1.018 70%, .999 80%, .995 90%, .998 95%, 1); /* 8%       */
--_ease-enter: cubic-bezier(0.16, 1, 0.30, 1);      /* expo-out; things arriving */
--_ease-exit:  cubic-bezier(0.40, 0, 0.90, 0.25);   /* accelerate; things leaving */
--_ease-std:   cubic-bezier(0.32, 0.72, 0, 1);      /* state on one element, morphs, snaps */
```

`--_spring-1` is the workhorse: surfaces, morphs, lists. `--_spring-2` is for **small joyful pops
only** — badge bloom, send-enable, count roll — and **never on anything larger than 40 px**;
overshoot on a big surface reads cheap.

### 6.2 Duration catalog — chosen by travel distance, curve chosen by what the thing is

```css
--_d1: 90ms;    /* ≤4px: tint, hover, pressed, icon swap, tone crossfade */
--_d2: 160ms;   /* ≤24px: badge reveal, count reveal, chip open, focus ring */
--_d3: 220ms;   /* ≤120px: popover emerge, composer, badge bloom, morph */
--_d4: 320ms;   /* ≥240px: panel unfurl, FLIP re-anchor flight */
--_ambient-slow: 5700ms; --_ambient: 3400ms; --_ambient-fast: 1600ms;
```

**Law: exit = enter × 0.6, on `--_ease-exit`.** 54 / 96 / 132 / 192 ms. Things arrive softly and
leave decisively; the reverse is what makes UI feel sticky. **Nothing exceeds 340 ms** except
ambient loops. **Stagger: 22 ms per item, capped at 6 items (132 ms), remainder enters together.**

### 6.3 What animates, what never does

| Animates | Never animates |
|---|---|
| `opacity` | `backdrop-filter` (full strength on frame 1, forever) |
| `transform` / `translate` / `scale` | `filter` on any tracked node |
| `clip-path`, `mask-image` position | `left` / `top` / `width` / `height` on a controller-positioned node (§6.5) |
| `box-shadow` **colour** (via a pseudo-element's opacity) | `box-shadow` blur radius, `font-size`, body-text `color` |
| chip fill (90 ms crossfade — a chip going busy→warn must not blink) | the `cursor` property (it is not animatable, and swapping the image mid-drag is the one thing that would make placement feel laggy) |

`will-change` is applied **only** via `[data-animating]`, set at transition start and removed on
`transitionend` — 40 badges must never hold 40 GPU layers. `contain: layout style paint` on every
floating box; `content-visibility: auto` on non-current panel sections.

### 6.4 The motion catalog (named, normative)

| Name | Trigger | Spec |
|---|---|---|
| `bloom` | pin genuine creation only | `scale .4→1` + opacity, `--_d3` `--_spring-2`, `transform-origin` at **the pin's sharp corner** (which is the anchor point itself), + a `::after` ripple `scale 1→2.2, α .35→0` over 420 ms `--_spring-1`. **Never** on the `IntersectionObserver` re-show path — a scroll-back that re-blooms the page reads as a bug. |
| `reveal` | proximity / hover / focus | 12 px dot → 28 px pin: `scale calc(12/28) → 1` + opacity on the pin box, `--_d2` `--_spring-1`, `transform-origin` at **the sharp corner**. Amended by §0 D5/D9: it was a `max-width 0 → 2.4ch` pill growing leftward, which only made sense while the revealed state was `glyph + count`. A pin has no width to grow — it scales about its tip, so the anchor point is pixel-stable through the whole transition and the pin still never covers the content it annotates (the body hangs into the quadrant `pinCorner` chose). |
| `emerge` | composer, thread, panel open | `clip-path: circle(11px at var(--_ox) var(--_oy)) → circle(142% …)` + `scale .92→1` + opacity, `--_d3` (`--_d4` for the panel) `--_spring-1`. `--_ox/--_oy` come from **origin transfer** (§6.6). |
| `collapse` | any overlay close | reverse of `emerge` at ×0.6 on `--_ease-exit`. |
| ~~`snap`~~ | ~~picker outline retargets~~ | **Deleted (§0 D7).** There is no picker outline to retarget: placement mode draws nothing. The name is retired rather than reused. |
| `flight` | pin reference swap (re-anchor) | FLIP on the independent `translate` property (so it never collides with hover `transform`): capture Δ, set `translate: Δx Δy` untransitioned, next frame `translate: 0 0` over `--_d4` `--_spring-1`. |
| `roll` | count change **in the panel row, the panel rail and the batch pill** | two `tabular-nums` spans; old translates up and out, new up and in, `--_d2` `--_spring-2`. Container width transitions `--_d2` `--_ease-std` — it never snaps. **Not on the pin**, which no longer draws a count (§0 D5). |
| `breathe` | copilot busy | `opacity .35 ↔ .7` ring, `--_ambient`, **no rotation**. Rotation says "wait"; breathing says "I'm here". |
| `sweep` | submitting / sending | a 1.5 px `--_accent` hairline travels the box's bottom edge, 1200 ms loop. The surface does **not** dim to `.7` — dimming text you are still allowed to read is a lie about what failed. |
| `sink` | resolve | 3 beats: check draws (`stroke-dashoffset 22→0`, `--_d3`); surface desaturates 100→45 % at +160 ms; at +300 ms a 10 px glass ghost detaches and arcs to the panel seed over `--_d4` `--_spring-1` while the thread dissolves. Total 780 ms. |
| `cut` | delete | 110 ms dissolve. No sink, no ghost, no ceremony. |
| `arm` | destructive confirm | **two clicks, in place** (A4): the first sets `data-confirm` on the control — it tints `--_danger` and draws a 1.5 px danger ring, so the armed state is a *shape* and not only a colour — and the second, within 4 s, performs the delete. `Esc`, blur, any other click in the surface, and the 4 s timeout all disarm. No second string, no dialog, no new `Labels` key. `⌘⌫` bypasses. |

**`sink` vs `cut` is the design's thesis about consequence.** Motion encodes reversibility: the
thing you can undo gets a story that teaches you where it went; the thing you cannot gets a cut,
because a beautiful animation is a *reward* and we must not reward an irreversible action.

### 6.5 The coordinate contract (normative, and the reason motion is free)

The controller writes `left` / `top` on every node it positions (`@floating-ui/dom` +
`autoUpdate`, SPEC §3.1.7). Therefore **`transform`, `translate`, `scale`, `opacity`, `filter`,
`clip-path` are entirely the presentation's**, on the same node, with zero conflict — and **no
presentation may animate a layout property on a controller-positioned node.** Every reposition is
FLIP-on-`translate`.

### 6.6 Origin transfer — the morph mechanism, ~40 lines, no library

The morph endpoints are different DOM nodes. Rather than FLIP between them, transfer the
*origin*: read the source rect once at open (2 reads, not per-frame), express it as the
destination's `transform-origin`, grow from it.

```ts
const r = to.getBoundingClientRect()
to.style.setProperty('--_ox', `${Math.round(from.left + from.width / 2 - r.left)}px`)
to.style.setProperty('--_oy', `${Math.round(from.top + from.height / 2 - r.top)}px`)
```

Survives `flip()`/`shift()` for free (the origin is computed from the *final* rect) and works with
no pin — **the origin is then the click point itself** (§0 D8), which is the case the picker rect
used to cover and is strictly better: it is the one coordinate the user actually chose.

**What completes the illusion, now that the thread has no head (§0 D6).** Glyph persistence is
gone with the head glyph; **point persistence replaces it**, and it is the stronger trick. The
pin's sharp corner, the composer's `emerge` origin and the popover's `align: start` edge are all
the *same screen point*. The box grows out of the pin and stays hinged to it; nothing has to be
matched in size, colour and position across two nodes, because the thing being conserved is a
coordinate, not a drawing. `--_ox/--_oy` are set to that point.

### 6.7 `prefers-reduced-motion: reduce` — an exact mapping, not "turn it off"

| Full | Reduced |
|---|---|
| `transform` / `scale` / `clip-path` keyframes | **property dropped** (not shortened) |
| `opacity` | kept, 100 ms linear |
| stagger | 0 |
| origin transfer / morph | crossfade, 100 ms |
| `flight` | instant jump + one 100 ms opacity blink, so it is still *noticed* |
| `breathe` | static ring at `opacity .5` |
| `cc-i-arc` rotation | 3-step opacity breath at 2400 ms |
| `sweep` | static 1.5 px accent hairline |
| `sink` | single 100 ms fade + the seed count tick |
| `arm` | unchanged (it is a gesture, not decoration) |
| `engine.focus()` scroll | `behavior: 'auto'` |

Transition durations collapse to **1 ms, never 0** — the discrete `display`/`overlay` transitions
must still complete so exits fire.

### 6.8 Two bans

- **`document.startViewTransition` is banned in the content script.** It snapshots and freezes the
  *host page* to cross-fade it. On a page running its own 60 fps animation that is a visible hitch
  we caused, and it is a mutation of the user's page in every sense except the DOM's.
- **No animation loops forever.** The unread dot breathes exactly 3 cycles then holds solid; the
  busy ring dies the instant the run does; there is no spinner before 450 ms (§7, `chip`).
  An infinite loop is a bug that never fires.

---

## 7. The intent / disclosure map (NORMATIVE)

Reveal signals: **S1** cursor proximity (one rAF-coalesced passive `pointermove` on `win`,
bounding-box early-out, writes a quantised `--_near: 0…1`; attached only when there is something
to reveal; detached while `[data-picking]`) · **S2** `:hover` on our own node · **S3**
`:focus-visible` — *always reveals more than hover*, because a keyboard user has no proximity
signal · **S4** mode key (`c`/`a`, core §4.5) · **S5** text selection · **S6** copilot activity
(`decorate()`) · **S7** `⌥⇧C` / `ui.panel.open()` · **S8** touch (`@media (hover: none)`) — always
revealed, no exceptions.

| # | Surface | Rest state | Reveal signal | Revealed state | Dismiss |
|---|---|---|---|---|---|
| 1 | **Pin** | **12 px dot**, mode-hue fill, keyline sandwich, `--_e0`, α .72, its centre on the anchor point | S1 ≤ 96 px, S2, S3, S6, S8, or 2 s after `page:change` | **28 px teardrop pin** (§8.1): one 22 px payload mark, keyline sandwich, `--_e1`, `reveal` about its sharp corner, `--_d2`. **No count, ever** | pointer leaves + 96 px, blur |
| 1b | Pin, **docked** (A4) | the revealed pin, muted, wearing the dashed orphan silhouette | none needed — it is never at rest | — | never, while it is docked |
| 2 | Pin count | **never drawn (§0 D5)** | — | — | it lives in `aria-label`, the panel row and the batch pill — where Vercel and Figma put it too |
| 3 | Pin state | silhouette, always: filled = open · hollow = resolved · dashed = orphaned · 82 % ring arc = approximate | — | the 22 px payload **is** the mark and the state chooses it: resolved ⇒ `cc-i-check`, failed ⇒ `cc-i-warn`, otherwise the payload glyph. One mark at a time, never two (§0 D5) | — |
| 4 | Pin chip | **the pin's ring, not a second mark**: unread ⇒ accent-tinted 1.5 px ring · busy ≥ 450 ms ⇒ that ring `breathe`s · failed ⇒ `--_warn` ring + the payload swaps to `cc-i-warn` · pending and busy < 450 ms ⇒ nothing | `warn`/`danger` tone auto-announces once (2.4 s) | chip **text** appears only in the thread and the panel row, never on the pin | pin blur; text stays in the DOM for `aria-live` throughout |
| 5 | Panel seed | **0 threads → zero pixels.** ≥ 1 thread → 8 px `--_muted` dot at α .40 | S1 ≤ 140 px, S7, S8 | 30 px glass disc + tabular count, `--_e2` | pointer leaves + 140 px |
| 6 | Panel disc | (from #5) | S2/S3 | 34 px, `--_e2`, `scale 1.02`, `--_d1` | blur |
| 7 | Panel sheet | closed | click disc, S7, `panel.defaultOpen` | 300 px × `min(62vh, 540px)`, glass `--_e3`, `emerge` from the corner over `--_d4` | `Esc` · click outside · disc click · a thread opening → **rail mode** (§8.5) |
| 8 | Panel section switch | segmented control, 3 icon segments + counts | click / `←→` | selected pill slides `--_d3` `--_spring-1` | — |
| 9 | Panel row action | `opacity 0` | row S2/S3 | icon-only, right-aligned, native `title`; a destructive one **arms** (§6.4) | row blur |
| 10 | Thread popover | closed | pin click · panel row click · `ui.focus()` | **350 px** glass `--_e3`, **zero header chrome** — the first comment's top edge is 10 px below the popover's, nothing above it (§0 D6); `emerge` from the pin; 6 px to the right of the anchor point, `align: start`, flipping at edges (§0 D8) | `Esc` · `✕` · click outside · pin re-click |
| 11 | Popover close `✕` | **α .55, always drawn while the thread is open** — an affordance on an opened surface is never hidden (§0 P0) | S2/S3 anywhere in the popover | α 1, `--_d1` | thread closes |
| 12 | Popover **resolve ✓** (thread-level, **once per thread**) | α .55, always drawn, sharing the floating top-right corner cluster with #11 over a 56 px reserved gutter | S2/S3 anywhere in the popover | α 1, `--_d1` | thread closes. **Delete is not here** — it moved to #13, which retires the A4 adjacency hazard |
| 13 | Comment actions cluster (`✎` edit + `🗑` delete) | `opacity: 0; position: absolute; inset-inline-end: 0` — **mounted, not removed**, so keyboard and AT reach it and the row never reflows | comment row S2/S3, `[data-confirm]` | `opacity: 1; position: relative`, two 16 px ghosts, `--_d1`, opacity only; delete **arms** (§6.4) | row blur — which also disarms |
| 14 | Timestamp + author | **permanent, unconditional (§0 D2)**: 12 px copilot mark (user rows draw none) · `Intl.RelativeTimeFormat(navigator.language)` · a 10 px `cc-i-pencil` when `editedAt` — all built from **values**, so none needs a `Labels` key | — (nothing is hidden) | hover **adds** a native `title` with the absolute datetime and the capture viewport — additive only | — |
| 15 | Composer (new thread) | closed | pick click · selection + mode key | 280 px, `--_glass-bg-2` at 94 %, `emerge` from **the exact click point**, positioned on it by a virtual reference (§0 D8, §8.3), caret already in | `Esc` · `⌘↵` · click outside → **draft pearl** (#16) |
| 16 | Draft pearl | — | click-outside on a non-empty composer | 26 px pin-shaped disc **at the click point**, carrying the same single payload mark as a pin; "unsaved" is its **accent ring**, not a second dot — a pearl sits where a pin sits and obeys the same one-mark rule (§0 D5) | click restores composer + caret; `Esc` discards |
| 17 | Composer send | 26 px accent disc, α .26 while empty | first character | α 1, fill blooms from centre `--_d2` `--_spring-2` | — |
| 18 | Placement mode | **zero pixels (§0 D7)** — no outline, no scrim, no wash, no corner ticks, no hover highlight, no dimming of our own pins. The host page renders byte-identically | S4 | the **cursor** and nothing else: 24×24 pin image, hotspot `2 22` on its sharp corner, `--_kind-h` tinted, `crosshair` fallback, delivered through `PresentationHost.cursor()` (§8.2, SPEC #46) | `Esc` · click · `page:change` · `destroy()` — the sheet is popped in a `finally` |
| 19 | Placement hint | **absent from the screen** | — | `Labels.pickHint` in `role="status"` only; the cursor *is* the affordance, exactly as in both reference products | placement end |
| 20 | Low-confidence target | — | `assessTarget` scores the element under the cursor **< 0.50** (§0 D8, SPEC §2.5) | the **cursor swaps** to the hollow variant (open pin outline + a 2 px landmark tick) — "this will attach to the block, not to that" — wordlessly, and still without a single pixel drawn on the page | — |
| 21 | Batch pill (host chrome) | **absent at `pendingCount === 0`** | pending ≥ 1 | 30 px glass capsule, `--_e2`: mode glyph + tabular count + 22 px accent send disc | send · `✕` |
| 22 | Pill `✕` | α .40 | pill S2/S3 | α 1 | blur |
| 23 | Toast | absent | run result | 2-line clamp, glass `--_e2`, 2 px dwell hairline `scaleX` over 8000 ms that **pauses on S2/S3** | dwell end · click |
| 24 | Selection nub | absent | S5 + 240 ms dwell (never in `input`/`textarea`/`contenteditable`) | 18 px glyph disc 6 px below the last client rect | selection collapse · 4 s pointer stillness |
| 25 | Off-screen beacon | absent | S6 lands a reply on a thread outside the viewport | 10 px chevron on the nearest viewport edge, α .28, one 900 ms accent halo on arrival | click → `engine.focus()` · thread read |
| 26 | Options hint | 14 px `cc-i-info` | S2/S3 on the field or the icon | 240 px glass popover | blur |
| 27 | Options restore-defaults | absent | card S2/S3 | 16 px `cc-i-uturn` at the card's bottom-right | blur |
| 28 | First-run breath | — | once per install (`chrome.storage.local` flag) | one 900 ms pulse of the seed. **Never again.** | self |
| 29 | Thread reply field (§0 D4) | **permanently rendered** whenever `actions.reply`: one 32 px line at the thread's bottom edge, above a `--_line-sep` hairline, `Labels.placeholder`, `--_muted` | `:focus` / click on the line | expands **in place** into the full composer (auto-grow 2→8 rows, send disc, `⌘↵` hint) over `--_d2`; the popover grows downward as one sheet | `Esc` collapses it back (and only then does the §7 chain continue) · blur while empty |

**Discoverability mitigations, all five mandatory together** — remove any one and the dormant
pin is a bug: revealed on `(hover: none)`; revealed on `:focus-visible`; revealed whenever a
`decorate()` chip is present (a working copilot must never hide); revealed for 2 s after every
`page:change`; and the full `aria-label` — mode word, count, state — present in **every** state,
including the 12 px dot, which is also where the count that left the pin's face still lives.

**Dismissal chain — one `Esc` does exactly one thing** (preserving `mount.ts`'s four guards):
`picking → idle` · `composing → cancelled` · `popover → closed, focus → pin` · `panel → closed,
focus → seed` · nothing → the event is left untouched and the page keeps it. **The expanded reply
field is a fifth rung, ahead of the popover** (§0 D4): an expanded, empty reply collapses back to
its one-line rest state and the popover stays open; a non-empty one keeps its draft (the composer
never loses your words) and collapses on the second `Esc`.

**Click-outside dismisses the topmost surface — except the composer**, which becomes the draft
pearl. The draft already lives in `engine.placement` (`setDraft` on every keystroke), so this is a
rendering state, not new persistence. *The composer never loses your words.*

**Mutual exclusion:** panel ↔ popover are never both expanded (the panel slides to a 44 px rail).
Composer ↔ popover are never both primary — and **a reply is not a second surface at all (§0 D4)**:
it is row 29, a child of the thread, so there is nothing to position, nothing to flip and nothing
to dismiss separately. The presentation registers `host.anchor('composer', null)` while
`ComposerVM.replyTo` is non-null (SPEC #47), and the popover grows downward as one sheet.

**Keyboard, five chords, no bare letters inside our surfaces** (core's trigger handler is a
capture-phase `window` listener and would fire first): `c`/`a` pick · `Tab` pins in **document
order** (pin DOM is reordered by `compareDocumentPosition` after each sync) · `⏎`/`Space` open ·
`⌘↵` submit · `⌥↑`/`⌥↓` prev/next pin · `⌘⌫` delete · `Esc` the chain · `⌥⇧C` summon.

---

## 8. Per-surface notes not implied by §7

**8.1 Pin.** Solid, never glass — 40 pins each running an `autoUpdate` frame loop, each forcing a
backdrop-root readback, over MDN or Wikipedia, is a jank machine. Depth on the resting layer comes
from the keyline sandwich and elevation; **material is a reward for expressing intent.**

**Anatomy (§0 D5/D9, normative).** 28 px box (`--_badge-size`), `border-radius: 999px` on three
corners and **`2px` on exactly one** — the teardrop is a circle with one sharp corner, and that
corner sits *on the anchor point*. 3 px padding; the payload is a single 22 px `<use>` filling the
rest. Which corner is sharp is `BadgeVM.pinCorner` (the controller decides it from the same flip /
shift pass that positions the pin; SPEC #45), and the pin carries the matching `translate` so the
tip lands on the point and the body hangs into the free quadrant:

```css
.cc-pin[data-corner='bottom-left']  { border-end-start-radius:  2px; translate: 0 -100%;    }
.cc-pin[data-corner='top-left']     { border-start-start-radius:2px; translate: 0 0;        }
.cc-pin[data-corner='top-right']    { border-start-end-radius:  2px; translate: -100% 0;    }
.cc-pin[data-corner='bottom-right'] { border-end-end-radius:    2px; translate: -100% -100%;}
```

Default `bottom-left` (body up-and-right of the point), which is what both reference products do.
`translate` is the independent property, so it composes with `flight`'s FLIP and never collides
with a hover `transform` (§6.3). Focus / selected = `--_halo`, never a border. Size is constant on
screen and independent of the anchor's size — a pin annotates a *point*, not a box. A thread with
no stored point (a record written before §0 D8, or a text-mode anchor) keeps the old behaviour: it
hangs off the anchor rect's top-right at `badge.offset`, and `pinCorner` is `null`.

Pins whose rects overlap within 24 px coalesce into a stack; hover fans them (3-card fan, 6°,
14 px offset, 200 ms `--_spring-1`). **The stack shows no count** (§0 D5) — the fan *is* the
count, and the exact number is in the stack's `aria-label` and in the panel.

**8.2 Placement mode.** **Nothing is drawn (§0 D7).** No scrim, no punched hole, no ring, no
corner ticks, no dwell capsule, no cursor-riding disc, and our own pins keep full opacity. The
whole layer stays `pointer-events: none` — non-negotiable; the engine resolves `composedPath()[0]`
and the controller's `data-picking` rule makes every widget click-through.

The **cursor is the entire mode signal**, and it is the honest one: its hotspot is the pin's sharp
corner, so what the user is aiming with *is* the point that will be stored.

```
image   24×24 CSS px pin outline, filled at --_kind-h, white keyline (the §3.3 sandwich, drawn
        into the SVG since a cursor cannot take a box-shadow); 48×48 twin via image-set() at 2×
hotspot 2 22  — the sharp bottom-left corner
value   cursor: image-set(url("data:image/svg+xml,…") 1x, url("…") 2x) 2 22, crosshair
low-confidence variant: the same outline unfilled + a 2 px landmark tick (§7 row 20)
```

**Delivery (normative).** The presentation builds the two data URIs once per `placement:start`
(hue templated in, cached by kind, ~380 B each) and hands the whole `cursor:` value to
`PresentationHost.cursor(value)`; the **controller** owns applying it, by pushing one constructed
`CSSStyleSheet` (`* { cursor: <value> !important }`) onto `document.adoptedStyleSheets` and popping
it in a `finally`, on `Esc`, on `page:change` and on `destroy()`. A presentation never touches the
host document. See §11 rule 7 for why this does not breach "the host page's DOM is never mutated",
and SPEC #46 for the seam.

On click the cursor is released **while** the composer emerges at the click point — the two overlap
by 60 ms, and that overlap is what makes the click *become* the composer. Drag stays unbound and
reserved for region capture, exactly as in both reference products.

**8.3 Composer.** Input has no visible border — the sheet **is** the field; the focus ring is on
the sheet. `Labels.placeholder` survives (the only thing naming the box). Textarea auto-grows
2→8 rows (`min-height: 56px; max-height: 168px`), height at `--_d1`, upgraded to a real
`height: auto` transition behind `@supports (interpolate-size: allow-keywords)`. Dismiss button
deleted. `⌘↵` hint (`⌘ ↵` glyph pair, `--_t-11`, α .8) appears on `:focus-within` only.

**It opens on the click point, in every branch (§0 D8).** The controller positions it against a
floating-ui **virtual reference** — a 0×0 rect at the live click point — with `placement:
'right-start'`, `offset(6)`, `flip()`, `shift({ padding: 8 })`, so the composer sits 6 px to the
right of the point with its top edge on it, and flips to the left / above only at a viewport edge.
This is true whether the target scored 0.98 or 0.03: **the confidence heuristic changes what the
point is stored relative to, never where a pixel lands.** `emerge`'s `--_ox/--_oy` come from the
same point, so the sheet grows out of exactly where the user clicked.

**A reply is not this surface.** The reply composer is row 29 — a child of the thread, expanded in
place, positioned by nobody (§0 D4).

**8.4 Thread popover.** **No head, no title bar, no logo row, no drag handle, no chrome of any
kind (§0 D6).** The first comment's top edge is 10 px below the popover's top edge and *nothing* is
above it. Width **350 px**.

Close (`cc-i-close`) and the thread's single resolve (`cc-i-check`) float as one absolutely
positioned corner cluster, top-right, over a 56 px gutter reserved on the first comment's
inline-end so no text ever runs under them; α .55 → 1 on hover/focus, but **always drawn** while
the thread is open (§0 P0). Resolve is thread-level and appears exactly once, never per reply.

**Comment row anatomy (§0 D2/D3), normative and permanent:**

```
[12px copilot mark?] [relative time] [10px cc-i-pencil if edited]   ·····   [✎] [🗑]
[13px body                                                                        ]
```

The header line is never hidden, never gated, never dropped at a breakpoint; the trailing cluster
is `opacity: 0` until row hover / focus-within and swaps `position: absolute → relative` with it,
so nothing reflows. Hover on the time *adds* a native `title` (absolute datetime + the capture
viewport) — additive only.

A resolved thread is not a colour change: the pin draws the §7-row-3 hollow silhouette, the body
mutes, and the corner ✓ becomes `cc-i-uturn` (reopen) — the sheet keeps that state in a screenshot
with no motion and no hue. Comments stagger in **oldest-first** (reading order) at 22 ms. A newly
arrived copilot comment gets a 2 px `--_accent` left rail decaying to transparent over 1200 ms.
Comment list `max-height: 280px` with scroll-fade masks
(`mask-image: linear-gradient(#000 calc(100% - 20px), transparent)` toggled by
`data-scroll-top/bottom`), `scrollbar-width: none` — the mask *is* the affordance — and
**`overscroll-behavior: contain`**, mandatory on a host page or a scrolled-out thread scrolls
*their* article. **A thread opens scrolled to its latest message** (the reference products'
behavior — the newest row must never sit under the bottom fade on open); a late-arriving
copilot reply follows only when the reader was already at the bottom — never yank someone
reading history. Below the list: the `--_line-sep` hairline and the row-29 reply field, always.
Orphan-while-open never jumps: the pin's silhouette crossfades to dashed, the quote rail reveals,
the reply field and the corner ✓ retire, and delete stays where it already is (the first comment's
row cluster).

**8.5 Panel.** Sections are macOS inset grouped lists: `--_t-11` uppercase title + tabular count
above a `--_surface-2` @ 55 % card, rows separated by `--_line-sep` inset 10 px. Row = 12 px meta
(mode · count · chip) + 13 px one-line body with a **mask fade**, never
`text-overflow: ellipsis` — a mask reads softer and does not eat a character. **Empty state = one
20 px glyph at 26 % opacity in 64 px of air**; the four `Labels.empty*` strings move to
`aria-label` on the list, so screen readers keep the sentence and the eye gets nothing. Section
`<h3>`s survive as visually-hidden `aria-labelledby` targets — the §3 a11y shape holds.
**Rail mode (A2):** when a popover opens, the panel does not close; it slides to
`translateX(calc(100% - 44px))` with its content fading over 200 ms, leaving a 44 px rail that
peeks back on hover. **The rail is not empty and the sheet never hangs off the screen**: the sheet
is clipped to the rail (`clip-path: inset(0 calc(100% - 44px) 0 0 round var(--_r-xl))` — an
animatable property, §6.3), so no part of it renders outside the viewport, and the rail keeps the
panel's total count above the current section's glyph. Attention becomes singular; state is
preserved; nothing reads as a rendering glitch.

**The selected segment carries its word (A1).** §10 cuts the three section nouns from the screen;
this is the one exception, and it costs ≤ 10 characters: the **selected** segment renders its
`Labels.section*` word beside its tabular count, unselected segments stay glyph + count, and all
three keep the word in `title` / `aria-label` regardless. Without it the panel is an unlabelled
box with three unlabelled icon-pills, which is the one place §10's audit over-cut.

**8.6 Chips → the presence ladder.** `Decoration` is locked and unchanged; only its rendering
changes, and `chips.ts`'s precedence (busy > failed > pending > unread) is preserved.

**The ladder is drawn on the pin's ring, never on its face (§0 D5).** A chip may not add a second
mark to a pin that already carries exactly one; the ring is free real estate that no glyph
occupies, and "unread state = an accent-tinted ring, not an added badge" is what both reference
products do.

| Rung | Trigger | Visual (on the pin's 1.5 px ring, unless stated) | Motion |
|---|---|---|---|
| 0 | `busy` < 450 ms | **nothing** | — |
| 1 | `pending` | ring at `--_muted`, α .5 | static |
| 2 | `busy` ≥ 450 ms | ring at `--_accent` (the pin does **not** grow) | `breathe` |
| 3 | `tool:call` / `tool:result` | 1 px tick on the ring at the step angle; fills on result | `--_d2` `--_spring-2` |
| 4 | `failed` | ring at `--_warn` **and the payload swaps to `cc-i-warn`** — the state mark replaces the payload, it never joins it; **chip text shown in the thread and the panel row** (a code is an identifier, not prose), never on the pin | auto-expand once, 2.4 s |
| 5 | `unread` | ring at `--_accent`, filled | one 900 ms halo on arrival, then `breathe` ×3, then solid |

Chip text renders visually **only** for `warn` / `danger`, and only in the thread and the panel
row. For `neutral` / `info` / `busy` the shape plus the native `title` carries it while `aria-live`
announces `chip.text` verbatim. Collapsed for eyes, complete for AT.

**8.7 Host chrome (pill + toast).** Sending is **determinate**: SPEC-copilot emits
`run:step { step, steps }`; feed it into `--_p` and render the send disc as
`conic-gradient(var(--_accent) calc(var(--_p) * 360deg), transparent 0)`. An indeterminate spinner
where a real progress number exists is a design failure, not a style choice. Stays below
`CommentUIOptions.zIndex` at 2147482000, unchanged. **Collision contract (A3):** the pill owns the
corner; the panel seed/sheet shifts 44 px inward while `pendingCount > 0`; and **the panel owns
its rect** — a badge whose resolved rect intersects the panel sheet or its rail is nudged along
its anchor edge to the free side, and **no badge is ever positioned outside the viewport**,
including the §8.1 fan members, whose 14/28 px offsets are part of the rect that must fit.

**8.8 Options page.** macOS System Settings: 220 px icon+label sidebar, right pane of cards with
hairline dividers, labels left / controls right, 44 px rows. **The footer dies** — autosave,
400 ms debounced, with a 14 px `cc-i-check` fading in over 160 ms and out after 1.2 s in the
`role="status"` region. Lede paragraph dies; hints collapse to `cc-i-info`. Native checkbox →
30×18 CSS switch (1 node + `::before`, 14 px thumb, `--_e0`, `--_d2` `--_ease-std`, accent when
on). API key: `-webkit-text-security: disc` + `cc-i-eye`, revealed **while held**, never a toggle;
a 2 px underline turns accent when the value is shape-valid — validation with no sentence. Field
**labels stay** (a settings form without labels is a puzzle). Native `<select>` stays (platform
a11y beats a custom listbox).

**8.9 Demo.** Same palette and type scale so screenshots read as one product. Toolbar becomes a
glass sticky bar; the event log is `--_t-11` mono at α .60, rising to 1 on hover — the log is the
demo's whole argument and it should be legible and quiet at the same time.

---

## 9. The three.js ruling

**Sanctioned in exactly one place: `apps/demo/site/material.html`.**

A standalone page — **not** linked from, and not loaded by, any `bench/` scenario page, so paint
timings stay clean — showing one thing: the design system's glass material as a live, refracting
lozenge under real light at 135°, i.e. the same light vector as `--_e3`. That page is the
marketing surface where a 3D render *is* the content ("this is what the overlay is made of"), it
is our own origin, and it costs a host page nothing.

| Rule | Value |
|---|---|
| Byte budget | ≤ 45 KB gz for the lazy chunk (tree-shaken `WebGLRenderer` slice). Exceeding it deletes the page, not the budget. |
| Lazy-load gate | `import()` fires only when **all** hold: `IntersectionObserver` reports the canvas ≥ 25 % visible · `requestIdleCallback` · `matchMedia('(prefers-reduced-motion: no-preference)')` · `navigator.deviceMemory >= 4` · `hardwareConcurrency > 4`. |
| Runtime | one context, 30 fps cap, paused on `visibilitychange`, `destroy()` on `webglcontextlost` and on leaving the viewport. |
| Fallback | a static CSS glass lozenge that is **always correct on its own**. The shader is strictly an upgrade and is never load-bearing for meaning. |

**No-go zones (normative).**

| Place | Why |
|---|---|
| any path reachable from `import '@astrale-os/comment-ui'` or `/glass` | the package must import cleanly in happy-dom with no WebGL, for the whole suite |
| the extension content script, at any time | 148 KB gz for the smallest useful renderer, against a 40 KB gz total host-page ceiling (§11) — a 3.7× miss |
| badges, chips, marks | one context per thread; browsers cap ~16 live contexts per page and **evict the oldest**, so thread 17 silently kills thread 1 |
| placement mode | it draws nothing at all (§0 D7) — there is not even a surface to put a canvas on, and the native cursor costs zero frames |
| composer / thread / panel backgrounds | a canvas **cannot sample the page behind it**; reproducing backdrop blur would need screen capture, a privacy non-starter. `backdrop-filter` already does it natively, for free |
| pill / toast | must appear in < 16 ms; GL context creation is 3–12 ms on a cold GPU process |
| the options page | extension-origin, so bytes are nearly free — but it would be decoration, and the first rule is *nothing superfluous* |
| anything at `document_start` | our boot cost lands on the host page's LCP and must stay single-digit ms |
| `bench/` scenario pages | they are anchoring evidence, not a showcase |

**And the in-product "alive" moment is CSS, not GL.** The copilot presence is `breathe` (§6.4) —
a 6-line ambient ring. The one effect a GPU would genuinely buy on a host page is edge refraction
at a glass rim, and that is ~700 bytes of inline `<svg><filter>` (`feTurbulence` +
`feDisplacementMap`, referenced as `backdrop-filter: url(#cc-lens) blur(28px) saturate(180%)`,
behind `@supports`, **off by default**). If a shader cannot fit in a kilobyte on someone else's
page, the effect is not worth having.

**A DoD row enforces this:** `grep -rE "three|webgl|WebGL" packages/comment-ui/src packages/extension/src`
returns nothing.

---

## 10. Zero-text audit (NORMATIVE)

A visible string not in the **keep** column may not be drawn. `Labels` stays a 17-key locked
interface — it stops being a visual layer and becomes the accessibility layer, which is exactly
what a locked i18n interface should be.

| Surface | String today | Verdict | Where it lives now |
|---|---|---|---|
| pin | `💬` emoji, and the `?` of `cc-i-ask` | ✂ | `cc-i-comment`, **for every mode** (§0 D5) |
| pin | count `0`, `1`, `n` | ✂ **entirely** (§0 D5) | `aria-label`, the panel row, the batch pill |
| pin | `~` `⚑` `✓` marks | ✂ all three | silhouette + the payload swap (§7 row 3) |
| pin | `title` = `Labels.approximate` | ✔ **keep** | native tooltip |
| placement | `Labels.pickHint` sentence | ✂ from screen **entirely** (§0 D7) | `role="status"` only — the cursor is the affordance |
| composer | `Labels.placeholder` | ✔ **keep** | the only thing naming the box, and now also the reply field's rest label (§7 row 29) |
| composer | `Labels.send` | ✂ | `cc-i-send` disc + `title` / `aria-label` |
| composer | `Labels.dismiss` | ✂ **button deleted** | `Esc` + click-away → draft pearl |
| popover | title "Comment" / "Ask" | ✂ **and the head with it** (§0 D6) | the accent hue + `aria-label`; no head, no glyph, no chrome |
| popover | `reply` `resolve` `reopen` `delete` `edit` | ✂ all five | icons + native `title` |
| popover | `✕` | ✂ glyph | `cc-i-close`, floating in the corner cluster |
| popover | timestamp | ✔ **keep — permanent (§0 D2)** | `Intl.RelativeTimeFormat(navigator.language)` on every row, always drawn; hover *adds* the absolute datetime as a native `title`. Built from **values**, so it still needs no `Labels` key |
| popover | copilot author name | ✂ | 12 px `cc-i-sparkle` on copilot rows, drawn permanently beside the time; user rows draw nothing |
| popover | orphan quote (`capture.text`) | ✔ **keep** | 2 px rail, 11 px `--_muted`, 3-line clamp, mask fade — the only place the deleted content still exists |
| panel | `Labels.panelTitle` `<h2>` | ✂ visually | already `aria-label`; heading visually hidden |
| panel | `sectionOpen` / `sectionResolved` / `sectionUnanchored` | ✂ **except the selected segment** (A1) | segmented control: icons + tabular counts; the selected segment also draws its word; words in `title` / `aria-label` for all three |
| panel | 3 × `empty*` sentences | ✂ | one 20 px glyph @ 26 % + `aria-label` |
| panel | `(2)` per row | ✔ **keep as a value** | glyph + tabular count |
| pill | `3 comments` | → `3` | glyph + tabular count |
| pill | "Send to copilot" / "Sending…" / "Dismiss" | ✂ | glyph + determinate ring; `title` |
| toast | copilot summary | ✔ **keep** | it is the result; 2-line clamp, expands on hover |
| options | lede paragraph | ✂ | — |
| options | field hints | ✂ inline | `cc-i-info` reveal |
| options | `Save` | ✂ | autosave + check flash |
| options | field labels | ✔ **keep** | a settings form without labels is a puzzle |
| options | section headers | ✔ **keep** | navigation, not prose |

**Net: 24 strings leave the screen. Zero leave the accessibility tree.** §0 moves one row from ✂ to
✔ (the timestamp, D2) and hardens three others to a stricter ✂ (the pin's count, the pick hint, the
popover head), so the count is unchanged and the audit's thesis is intact: **what leaves the screen
is verbs and nouns; what stays is values.** A relative time is a value. That is the whole reason
D2 is not a relaxation of §10 but a correction to it — hiding a value was always out of policy.

Every icon-only control carries a native `title` **and** an `aria-label`. The tooltip is the
**browser's**, never ours: zero bytes, zero z-index (it is above the top layer, which our own
tooltip could never guarantee against a host page), OS-styled to the user's platform and their
accessibility settings, honours their delay preference, and — decisively — it **cannot cover
content on a busy host page**, because the OS positions it.

---

## 11. Legibility on arbitrary host pages — the contract

`bench/results.md` says this ships onto MDN, Wikipedia, infinite feeds, and pages that re-hash
every class between renders. Eight rules, all normative:

1. **Anything sitting on unknown content is opaque.** Glass is only for chrome that owns its own
   rectangle in the top layer.
2. **Keyline sandwich** on every opaque-on-unknown element — **and on nothing else** (§3.3). A
   glass surface never takes it and never takes a `border`; its edge is `--_e3` (§0 D1).
3. **Glass floor 74 % / 64 % + three kill switches + `forced-colors`** (§3.1, §3.2).
4. **Compositor-only animation**, always (§6.3, §6.5).
5. `contain: layout style paint` on every floating box; `content-visibility: auto` on non-current
   panel lists; `will-change` only for the duration of an animation.
6. **`isolateEvents` and `pointer-events` behaviour is untouched.** The `data-picking`
   click-through rule, the `pointer-events: none` layer and the `composedPath()[0]` hazard are
   preserved verbatim. No node inside `.cc-layer` is ever `pointer-events: auto` except an
   interactive control.
7. **The host page's DOM is never mutated**, and it is never dimmed, blurred, outlined or frozen.
   Depth is built inside our own layer. **Placement mode draws nothing at all** — the scrim, the
   ring and the corner ticks are deleted (§0 D7), so during a pick the page is not merely
   unmutated, it is pixel-identical.

   **"Never mutated", defined, and the one sanctioned exception.** *Never mutated* means: **no
   node inserted or removed, no attribute written, no text changed — nothing that produces a
   `MutationObserver` record in the page's own world.** The placement cursor is delivered by
   pushing one constructed `CSSStyleSheet` onto `document.adoptedStyleSheets` and popping it in a
   `finally`, which satisfies that definition literally (`adoptedStyleSheets` is a document
   property; it emits no mutation record and no node) and in spirit (one declaration, scoped to
   the seconds the user is placing a comment, removed on `Esc`, click, `page:change`, `destroy()`
   and page unload). An injected `<style>` node, a `documentElement.style` write, or a class on
   `<body>` remain **forbidden** — each is observable, each survives a crash, and each is exactly
   the kind of footprint this rule exists to prevent. The controller owns the sheet; a
   presentation only supplies the `cursor:` value (§8.2, SPEC #46).
8. **Colour never carries state alone; motion never carries state alone** (§1.3) — noting that
   **mode is not state** (§0 D5) and is hue-only by decree.

---

## 12. Byte budget

| | now (gz) | after | Δ |
|---|---|---|---|
| `comment-ui` root (controller + `domPresentation`) | 26.0 KB | ≤ 26.4 KB | +0.4 |
| `comment-ui/glass` (sheet + sprite + intent + motion) | — | **≤ 7.5 KB** | lazy / opt-in |
| ├ stylesheet (tokens, materials, states, keyframes) | | ≤ 4.2 KB | |
| ├ **18**-glyph `<symbol>` sprite (`cc-i-ask` deleted, §0 D5) | | ≤ 0.95 KB | |
| ├ intent tracker (`--_near`, `--_lx/--_ly`, polarity) | | ≤ 0.6 KB | |
| ├ **placement cursor** (2 SVG templates + hue interpolation, cached by kind; §0 D7) | | ≤ 0.5 KB | |
| └ motion (origin transfer, FLIP, exit lifecycle, clustering) | | ≤ 1.7 KB | |
| `comment-core` | 43.3 KB | **unchanged** | 0 |
| new runtime dependencies | — | **zero** | |
| `three.js` on a host page | 0 | **0** | — |

**Hard ceiling: 40 KB gz total for everything injected into an arbitrary third party's page.**
Glass-on-host is 33.9 KB. No motion library: Motion One (4 KB) and GSAP (24 KB) both buy less than
the `linear()` springs above, because the controller is attribute-driven and idempotent — CSS
transitions fire exactly when state genuinely changes. The only imperative animation in the whole
design is **two `getBoundingClientRect()` calls per morph** and **one `translate` write per FLIP**.

Runtime rules: ≤ 5 concurrently animating nodes; ≤ 2 composited glass surfaces.

**§0 is byte-neutral by construction, and the budget does not move.** It adds the cursor
templates (+0.5 KB), the pin's corner geometry and the point plumbing (≈ +0.4 KB of stylesheet and
controller). It deletes the scrim, the punched `clip-path`, the ring, the corner ticks, the dwell
timer, the cursor-follower node, the hint capsule, the badge-dim rule, the popover head, the
`cc-i-ask` symbol, the badge count element and the `roll` wiring on it (≈ −1.1 KB across the sheet
and `picker.ts` / `badge.ts` / `thread.ts`). **The decree removes more code than it adds** — which
is the expected shape when a ruling deletes an entire surface, and the reason `glass` stays inside
7.5 KB with no renegotiation.

---

## 13. The rulings (what was contested, and what won)

1. **Default pin state is a 12 px dot.** Figma, Docs and Notion all keep pins at full size,
   and hiding an affordance is how features die. Taken anyway, because the brief's "hide until
   intent" is the *whole* difference between an annotation layer and a tool that vandalises
   someone's page with twelve permanent blue pills — and it is defensible only with all five
   mitigations of §7 shipped together. **Survives §0 intact** (D2 scopes intent-based hiding to
   surfaces *at rest*, and a pin at rest is the paradigm case), and is the one place this document
   still departs from the reference products by choice.
2. **Zero pixels at zero threads.** The permanent `💬 0` corner pill on every page the extension
   touches is the most invasive thing in the product and it buys discoverability exactly once per
   user. Discoverability is a *moment* (first-run breath, `⌥⇧C`, the seed the instant content
   exists), not a permanent tax.
3. **Eleven public tokens, and they must not grow.** Relative colour derives ~30 values from one
   host `--cc-accent`. Every new `--cc-*` is a locked-spec addition with a permanent compatibility
   obligation — and a host that *can* set `--cc-glass-opacity: 0.15` **will**, on their own busy
   marketing page, and then the widget is illegible and it is our bug. Theming lets a host say
   what their brand is, not how transparent our glass gets.
4. **Glass is a budget of one-or-two, and badges are never glass.** Material is a reward for
   expressing intent. That is also why it reads as *subtle* liquid glass rather than a
   frosted-everything mood board: you only ever see one pane of glass at a time, and you
   summoned it.
5. **The widget follows the page's polarity, not the OS's** (§2.5). System preference describes
   the *desktop*; we live inside someone else's page.
6. **three.js ships on exactly one page we own, and nowhere a user's page can reach** (§9).
   A library that costs a sixth of a megabyte on every page on the web to render a highlight is
   not a design decision, it is a tax we levy on someone else's users.
7. **Exit = enter × 0.6, and destructive exits get no choreography at all** (§6.4). Motion
   encodes reversibility.
8. **Native `title` beats a custom tooltip**, everywhere, forever (§10).
9. **Hover adds; it never conceals** (§0 P0). The one rule that decides D2, D3 and D7 together, and
   the tiebreaker for every disclosure question §7 does not name. Contested against ruling 1 and
   ruling 1 lost *inside* opened surfaces and won *outside* them — the boundary is "has the user
   opened this?", not "is this important?".
10. **A pin carries exactly one mark and mode is hue-only** (§0 D5). Contested against §1.3, which
    survives untouched for *state*; the exemption is for *mode*, which was never a condition a user
    must read off a screenshot. The count went with it, to `aria-label` and the panel, exactly
    where Vercel and Figma keep it.
11. **Placement mode draws zero pixels on the page** (§0 D7). Contested against the "hole is the
    highlight" scrim, which was the most admired thing in the original document and also the thing
    that made the product feel like an inspect-element tool. The cursor carries the mode, the tip
    carries the point, and the page stays the user's.

---

## 14. Deliberately unchanged

The `Esc` chain and its four guards · the `pointer-events: none` layer + `[data-picking]`
click-through · `pending` renders nothing · the pin/popover `aria-live` topology ·
`hideOffscreen` + the 96 px `rootMargin` · orphan docking at `capture.rect` with per-frame
re-projection · the controller's ownership of `left`/`top` · the `var(--cc-x, default)` → `--_x`
alias discipline (never a declaration on `:host`) · `isolateEvents` · `all: initial` + explicit
`font-size` + no `rem` · IIFE globals · the `Decoration`, `CommentUIOptions`, `CommentUI` and
`Labels` type surfaces · `domPresentation`, which is frozen.

**Unchanged by §0 in particular:** `Labels` stays a 17-key interface, 100 % used (the decree adds
no string and deletes no key); the eleven `--cc-*` tokens stay eleven (D5 changes one *default
value*, which decision #39 already scopes per-presentation); `domPresentation` is untouched, so a
consumer that never opted into `glass` sees none of this; the `pointer-events: none` layer and the
`composedPath()[0]` hazard survive D7 verbatim — deleting the scrim *removes* a node from that
layer, it does not add one.

**Terminology.** The resting 12 px dot and its revealed 28 px form are together **the pin**. The
API names do not follow the word: `BadgeVM`, `--cc-badge-size`, `CommentUIOptions.badge` and
`badge:<threadId>` are locked and keep their spelling. Where this document still says "badge", it
means the pin.

---

## 15. Amendments

This document is locked, so it changes by amendment and never by drift. Each row below was
written **before** the code that implements it, and each is backed by a first-touch UX pass whose
evidence lives in `bench/ux-shots/`. `Labels` stays a 17-key interface, 100 % used; the eleven
`--cc-*` tokens stay eleven.

| # | Where | What changed | Why |
|---|---|---|---|
| **A1** | §8.5, §10 | The **selected** panel segment draws its `Labels.section*` word beside its count; unselected segments stay glyph + count. | Three independent testers read the panel as "an unlabelled box with three unlabelled icon-pills" (`first-touch/06-basic-light-virgin.png`, `43-orphan-docked.png`). Chosen over restoring the `<h2>` title and the three empty-state sentences: one word answers the same complaint as five sentences, adds no public token and keeps `Labels` at 17 keys. |
| **A2** | §8.5 | Rail mode clips the sheet to the 44 px rail so no part renders outside the viewport, and the rail carries the total count + the current section glyph. | The old text ("content fading over 200 ms, leaving a 44 px rail") produced, in a browser, a large empty slab half off the right edge that reads as a rendering bug (`first-touch/28-panel-railed-sliver.png`). |
| **A3** | §8.7 | The collision contract extends from "the pill owns the corner" to "**the panel owns its rect**", and no badge — fan members included — is ever positioned outside the viewport. | Fan members were measured at y = −16/−17/−18, painting clipped half-dots over the page title, and badges were painting underneath the panel sheet where they cannot be clicked. |
| **A5** | §2.3 | The hue offset is a plain number (`calc(h + 38)`), not an angle (`calc(h + 38deg)`). | A typing bug in the formula, not a design change. `h` is a `<number>` in relative colour syntax; the angle form is invalid at computed-value time, which resolves the badge fill to `transparent` — every badge on the page a hollow ring, in a browser, with a green suite behind it. |
| **A4** | §6.4 `arm`, §7 rows 1b, 9, 12 | Destructive confirm is **two clicks in place** rather than a 420 ms hold; a **docked** badge is held in its revealed, muted, dashed state instead of resting as a dot. | The hold gesture was never implemented and an unlabelled 26 px trash icon adjacent to Resolve deleted a thread on the first click. A docked orphan has no anchor for the cursor to be *near*, so proximity can never reveal it — resting it as a 12 px dot means the only affordance for a thread the user cannot see is invisible too. Both are the disclosure map applied more strictly, not relaxed: nothing gains a permanent label, and the docked mark exists only while the thread is orphaned. |
| **A6** | **§0**, and in place: §1.1, §1.3, §2.1, §2.2, §2.3, §3.3, §3.4, §5, §6.4, §6.6, §6.7, §7 (rows 1–4, 10–15, 18–20, +29), §8.1–§8.4, §8.6, §9, §10, §11.2, §11.7, §11.8, §12, §13, §14 | **The user decree of 2026-08-03**, nine rulings, recorded in full as §0 and applied to every section that contradicted them. Summary of what died: the popover head, the badge count, `cc-i-ask` and the "?", the picker outline / scrim / wash / corner ticks / dwell hint / cursor-follower disc, the badge-dim-while-picking rule, the hover-gated timestamp, the standalone per-row pencil at rest, the `snap` motion. What arrived: the teardrop pin with one 2 px corner on the click point, the stored click offset + target-confidence heuristic (SPEC #42–#43), the `adoptedStyleSheets` placement cursor (SPEC #46), the permanent comment header, the permanent collapsed reply field, and the floating corner cluster. | The user tested the shipped product. This amendment outranks the A1–A5 tester consensus and §13's rulings where they conflict; §0 states each conflict and which way it resolved rather than silently rewriting history. Its seam consequences are decision rows **#42–#48** in `docs/SPEC-comment-core.md` §8, written in the same pass. Byte-negative on net (§12). |

The redrawn `cc-i-uturn` (§5) is documentation, not an amendment: `reply` and `reopen` were two
left-curving arrows a few px apart at 14 px, and §1.3 requires the *shape* to carry the state.
