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

---

## 1. The five laws

1. **Nothing exists until intent is expressed.** Rest state is the smallest legible mark that
   still says "something is here". Everything else is summoned. §7 is the normative map.
2. **Legibility is contract; glass is decoration.** The moment "subtle liquid glass" and
   "readable on top of a page nobody controls" disagree, glass loses — automatically, via three
   hardcoded kill switches (§3.2) and an opacity floor that the design never crosses.
3. **Colour never carries state alone; motion never carries state alone.** Every state also has
   a drawn glyph or a silhouette that reads identically in a screenshot, under
   `prefers-reduced-motion`, and under `forced-colors`.
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
| `--_badge-size` | `--cc-badge-size` | `22px` | — | the *revealed* pill height; rest is 12px (§7) |
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

  --_line-out: oklch(from var(--_text) l c h / .13);   /* dark hairline, outside */
  --_line-in:  oklch(100% 0 0 / .55);                  /* light hairline, inside */
  --_line-sep: oklch(from var(--_border) l c h / .70); /* list separators        */
}
@media (prefers-color-scheme: dark) {
  :host { --_line-out: oklch(0% 0 0 / .58); --_line-in: oklch(100% 0 0 / .09); }
}
```

**Fallback (mandatory, one block, ~14 lines).** `@supports not (color: oklch(from red l c h))`
redeclares the eight accent-derived aliases with `color-mix(in oklab, …)` at 88 % / 84 % / 6 % /
14 % / 22 % / 38 %, and `--_on-accent: oklch(100% 0 0)`.

### 2.3 Mode hues

`Mode.kind` is an opaque string and modes carry no colour. Each mode takes a deterministic hue
offset **by index in `engine.modes`** (never a hash of the string): `[0°, +38°, −34°, +72°, −68°]`,
applied as `oklch(from var(--_accent) l c calc(h + var(--_kind-h, 0deg)))`. `comment` is the
accent; `ask` is a warm violet; a third mode is teal. Beyond index 4 the offset repeats from 0 —
colour is a hint, not an identifier, and every mode also has its own glyph.

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
| **Solid** | badges, panel seed/disc, picker outline, chips, marks | Anything sitting **on** unknown content is opaque. You cannot guarantee legibility over a photograph. |
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

**The keyline sandwich — normative on every opaque-on-unknown element** (badges, seed, chips,
picker outline): a dark hairline outside, a light hairline inside.

```css
box-shadow: 0 0 0 .5px oklch(0% 0 0/.28), 0 0 0 1.75px oklch(100% 0 0/.55), var(--_e0);
```

The badge stays visible on white, on black, on a photograph and on a `#4f46e5` hero. One hairline
does not.

### 3.4 Elevation — four steps, always layered

| Level | Use | Value |
|---|---|---|
| `--_e0` | badge at rest, chip, seed | `0 0 0 .5px var(--_line-out), 0 1px 2px -1px oklch(0% 0 0/.16)` |
| `--_e1` | badge revealed, row hover | `0 0 0 .5px var(--_line-out), 0 1px 1.5px oklch(0% 0 0/.07), 0 4px 10px -3px oklch(0% 0 0/.15)` |
| `--_e2` | panel disc, host pill, toast, pick hint | `0 0 0 .5px var(--_line-out), 0 2px 4px -1px oklch(0% 0 0/.08), 0 10px 24px -8px oklch(0% 0 0/.19)` |
| `--_e3` | composer, thread popover, panel sheet | `0 0 0 .5px var(--_line-out), inset 0 .5px 0 var(--_line-in), 0 1px 2px oklch(0% 0 0/.06), var(--_shadow)` |
| `--_ring` | focus | `0 0 0 3px var(--_ring)` |

**Light source is 135° (top-left) everywhere**: specular on the top edge (`--_line-in` inset),
shadow down-right. In dark scheme, separation comes from the light rim, not a darker shadow.

**Focus rule:** `outline: none` + `box-shadow: var(--_ring), <its elevation>` on `:focus-visible`,
so the ring follows the exact radius; plus the `forced-colors` outline in §3.2. A focus ring is
never removed and never the browser default.

### 3.5 Radii — concentric

```
--_r-xs: 4px    chip, mark, inner control inside a padded card
--_r-sm: 6px    small buttons, picker box
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
| `--_t-10` | 10px / 13px / +0.01em / 500 | state marks, dwell hairline labels |
| `--_t-11` | 11px / 15px / +0.006em / 500 | timestamps, counts in meta, section titles (uppercase, +0.06em) |
| `--_t-12` | 12px / 16px / +0.003em / 500 | buttons, chips, badge count, panel row meta |
| `--_t-13` | 13px / 19px / 0 / 400 | comment bodies, panel row bodies — the reading size |
| `--_t-15` | 15px / 21px / −0.006em / 400 | composer textarea; popover title at 600 |
| `--_t-17` | 17px / 23px / −0.012em / 600 | panel heading, options section headers |
| `--_t-22` | 22px / 27px / −0.018em / 640 | options page title only |

Global: `font-synthesis: none`, `-webkit-font-smoothing: antialiased` **only** inside the dark
block (on light backgrounds it thins system fonts below intent), `font-optical-sizing: auto`,
`font-variant-numeric: tabular-nums` on every count (`.cc-badge-count`, `.cc-row-meta`,
`.cc-pill-count`, `.cc-time`) — counts change in place and must never jitter. Emphasis weight is
`font-variation-settings: 'wght' 590` guarded by `@supports`, else 600.

---

## 5. Icons — 19 hand-drawn glyphs

**Spec.** `viewBox="0 0 16 16"`, live area 13×13 inset 1.5, `fill: none; stroke: currentColor;
stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke`.
**Every stroke centerline lands on a ¼-pixel offset (`n.25` / `n.75`)** — at 2× DPR a 1.5 px stroke
is exactly 3 device pixels and a half-integer device centerline covers three whole pixels. That
is why these read as cut rather than drawn, and why they stay crisp at 10 / 12 / 14 / 16 / 20 px.

**Delivery.** One `<symbol>` sprite, injected **once** into the shadow root by `glassPresentation`,
referenced as `<use href="#cc-i-check">`. Not `mask-image` (loses multi-path and two-tone), not an
icon library (there is none in this product, by rule). **≈ 2.4 KB raw / 1.0 KB gz for all 19.**

| id | Meaning | Path (normative) |
|---|---|---|
| `cc-i-comment` | comment mode, thread head, panel "open" | `M13.25 7.75a5.25 5.25 0 0 1-7.35 4.87L2.75 13.5l.9-2.85A5.25 5.25 0 1 1 13.25 7.75Z` |
| `cc-i-ask` | ask mode | `cc-i-comment` + `M6.9 6.4a1.15 1.15 0 1 1 1.6 1.06c-.45.2-.6.55-.6.99` + `M8 10.75h.01` |
| `cc-i-check` | resolve, saved | `M3.25 8.25 6.5 11.5 12.75 4.75` |
| `cc-i-uturn` | reopen, restore defaults | `M12.75 10.25A3.5 3.5 0 0 0 9.25 6.75H3.25` + `M5.75 4.25 3.25 6.75l2.5 2.5` |
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

**Sizes in use:** 10 (marks), 12 (row meta, chips), 14 (thread head, composer mode), 16 (all
controls), 20 (empty states, cursor glyph). Nothing else.

`Mode.badge.icon` is untouched: a host string renders as text; **absent** renders `cc-i-comment`,
or `cc-i-ask` for `kind: 'ask'`. **Every emoji dies** (`💬 ✕ ✓ ⚑ ~`) — a different font, a
different baseline, a different colour on every OS. `apps/demo` drops its explicit `icon: '?'`.

State marks (`.cc-mark`) become 10 px `<use>` glyphs, not CSS `content` — so "colour never carries
state alone" keeps its guarantee with drawn shapes.

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
| chip fill (90 ms crossfade — a chip going busy→warn must not blink) | the picker outline's stroke width |

`will-change` is applied **only** via `[data-animating]`, set at transition start and removed on
`transitionend` — 40 badges must never hold 40 GPU layers. `contain: layout style paint` on every
floating box; `content-visibility: auto` on non-current panel sections.

### 6.4 The motion catalog (named, normative)

| Name | Trigger | Spec |
|---|---|---|
| `bloom` | badge genuine creation only | `scale .4→1` + opacity, `--_d3` `--_spring-2`, `transform-origin` at the anchor corner, + a `::after` ripple `scale 1→2.2, α .35→0` over 420 ms `--_spring-1`. **Never** on the `IntersectionObserver` re-show path — a scroll-back that re-blooms the page reads as a bug. |
| `reveal` | proximity / hover / focus | width via `max-width 0 → 2.4ch` + opacity, `--_d2` `--_spring-1`, `transform-origin: right` (badges hang top-right, so the pill grows *leftward*, never over the element it annotates). |
| `emerge` | composer, thread, panel open | `clip-path: circle(11px at var(--_ox) var(--_oy)) → circle(142% …)` + `scale .92→1` + opacity, `--_d3` (`--_d4` for the panel) `--_spring-1`. `--_ox/--_oy` come from **origin transfer** (§6.6). |
| `collapse` | any overlay close | reverse of `emerge` at ×0.6 on `--_ease-exit`. |
| `snap` | picker outline retargets | `translate` + `width/height` (on a `contain: layout size paint` node) `--_d1` `--_ease-std`. The outline **slides** — one instrument scanning, not twelve boxes flickering. |
| `flight` | badge reference swap (re-anchor) | FLIP on the independent `translate` property (so it never collides with hover `transform`): capture Δ, set `translate: Δx Δy` untransitioned, next frame `translate: 0 0` over `--_d4` `--_spring-1`. |
| `roll` | any count change | two `tabular-nums` spans; old translates up and out, new up and in, `--_d2` `--_spring-2`. Container width transitions `--_d2` `--_ease-std` — it never snaps. |
| `breathe` | copilot busy | `opacity .35 ↔ .7` ring, `--_ambient`, **no rotation**. Rotation says "wait"; breathing says "I'm here". |
| `sweep` | submitting / sending | a 1.5 px `--_accent` hairline travels the box's bottom edge, 1200 ms loop. The surface does **not** dim to `.7` — dimming text you are still allowed to read is a lie about what failed. |
| `sink` | resolve | 3 beats: check draws (`stroke-dashoffset 22→0`, `--_d3`); surface desaturates 100→45 % at +160 ms; at +300 ms a 10 px glass ghost detaches and arcs to the panel seed over `--_d4` `--_spring-1` while the thread dissolves. Total 780 ms. |
| `cut` | delete | 110 ms dissolve. No sink, no ghost, no ceremony. |
| `arm` | destructive confirm | hold 420 ms; a `conic-gradient` fills the button ring; release early cancels. `⌘⌫` bypasses. |

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
no badge (origin = the picker rect). **Glyph persistence completes the illusion:** the thread
head carries the *same* 16 px kind glyph at the same size, colour and screen point (± 6 px) as the
badge. The box grows; the icon barely moves; the eye reads one object.

### 6.7 `prefers-reduced-motion: reduce` — an exact mapping, not "turn it off"

| Full | Reduced |
|---|---|
| `transform` / `scale` / `clip-path` keyframes | **property dropped** (not shortened) |
| `opacity` | kept, 100 ms linear |
| stagger | 0 |
| origin transfer / morph | crossfade, 100 ms |
| `flight` | instant jump + one 100 ms opacity blink, so it is still *noticed* |
| `snap` | instant |
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
| 1 | Badge | **12 px dot**, accent fill, keyline sandwich, `--_e0`, α .72 | S1 ≤ 96 px, S2, S3, S6, S8, or 2 s after `page:change` | 22 px pill: glyph + count, `--_e1`, `translateY(-1px)`, `--_d2` | pointer leaves + 96 px, blur |
| 2 | Badge count | absent (and absent at count 1 — a badge reading "1" is noise) | with #1, at count ≥ 2 | `reveal` + `roll` on change | with #1 |
| 3 | Badge state | silhouette, always: filled = open · hollow + check = resolved · dashed = orphaned · open-ring 82 % arc = approximate | — | 10 px `.cc-mark` glyph rides the pill | — |
| 4 | Badge chip | 5 px dot (hollow = pending, filled accent = unread, triangle = failed); **nothing at all for busy < 450 ms** | S2/S3 on the badge, or `warn`/`danger` tone (auto-expands once, 2.4 s) | full pill via `clip-path: inset(0 100% 0 0 round 8px) → inset(0)`, `--_d2` | badge blur; text stays in the DOM for `aria-live` throughout |
| 5 | Panel seed | **0 threads → zero pixels.** ≥ 1 thread → 8 px `--_muted` dot at α .40 | S1 ≤ 140 px, S7, S8 | 30 px glass disc + tabular count, `--_e2` | pointer leaves + 140 px |
| 6 | Panel disc | (from #5) | S2/S3 | 34 px, `--_e2`, `scale 1.02`, `--_d1` | blur |
| 7 | Panel sheet | closed | click disc, S7, `panel.defaultOpen` | 300 px × `min(62vh, 540px)`, glass `--_e3`, `emerge` from the corner over `--_d4` | `Esc` · click outside · disc click · a thread opening → **rail mode** (§8.5) |
| 8 | Panel section switch | segmented control, 3 icon segments + counts | click / `←→` | selected pill slides `--_d3` `--_spring-1` | — |
| 9 | Panel row action | `opacity 0` | row S2/S3 | icon-only, right-aligned, native `title` | row blur |
| 10 | Thread popover | closed | badge click · panel row click · `ui.focus()` | 320 px glass `--_e3`, `emerge` from the badge | `Esc` · `✕` · click outside · badge re-click |
| 11 | Popover close `✕` | α .40 | popover S2/S3 | α 1, `--_d1` | blur |
| 12 | Popover resolve / delete | `opacity 0` | popover S2/S3 | 26 px icon ghosts; delete tints `--_danger` on hover only | blur |
| 13 | Comment edit `✎` | `opacity 0` | comment row S2/S3 | 16 px ghost | blur |
| 14 | Timestamp | a 3 px dot | comment row S2 | `Intl.RelativeTimeFormat(navigator.language)` — built from **values**, so it needs no `Labels` key | blur |
| 15 | Composer | closed | pick click · reply · selection + mode key | 280 px, `--_glass-bg-2` at 94 %, `emerge` from the click point, caret already in | `Esc` · `⌘↵` · click outside → **draft pearl** (#16) |
| 16 | Draft pearl | — | click-outside on a non-empty composer | 26 px disc, mode glyph + 4 px accent dot, at the anchor | click restores composer + caret; `Esc` discards |
| 17 | Composer send | 26 px accent disc, α .26 while empty | first character | α 1, fill blooms from centre `--_d2` `--_spring-2` | — |
| 18 | Picker outline | absent | S4 | 1.5 px accent ring + 1 px inner keyline, radius copied from the candidate's own computed radius, `snap` between candidates; scrim `saturate(.75) brightness(.985)` + `--_wash`; all badges drop to α .25 `saturate(.35)` | `Esc` · click · blur |
| 19 | Picker hint | absent | first pick session per mount (2.5 s), **or** 700 ms dwell on one candidate | glass `--_e2` capsule, `--_t-11`, rises `y+4→0` over `--_d2`; a 20 px accent disc with the mode glyph rides the cursor at (+14, +14) with a 10 px `⎋` beneath at α .40 | placement end |
| 20 | Bad target | — | candidate covers > 72 % of the viewport | ring dims to 30 %, corner ticks vanish — "probably not what you want", wordlessly | — |
| 21 | Batch pill (host chrome) | **absent at `pendingCount === 0`** | pending ≥ 1 | 30 px glass capsule, `--_e2`: mode glyph + tabular count + 22 px accent send disc | send · `✕` |
| 22 | Pill `✕` | α .40 | pill S2/S3 | α 1 | blur |
| 23 | Toast | absent | run result | 2-line clamp, glass `--_e2`, 2 px dwell hairline `scaleX` over 8000 ms that **pauses on S2/S3** | dwell end · click |
| 24 | Selection nub | absent | S5 + 240 ms dwell (never in `input`/`textarea`/`contenteditable`) | 18 px glyph disc 6 px below the last client rect | selection collapse · 4 s pointer stillness |
| 25 | Off-screen beacon | absent | S6 lands a reply on a thread outside the viewport | 10 px chevron on the nearest viewport edge, α .28, one 900 ms accent halo on arrival | click → `engine.focus()` · thread read |
| 26 | Options hint | 14 px `cc-i-info` | S2/S3 on the field or the icon | 240 px glass popover | blur |
| 27 | Options restore-defaults | absent | card S2/S3 | 16 px `cc-i-uturn` at the card's bottom-right | blur |
| 28 | First-run breath | — | once per install (`chrome.storage.local` flag) | one 900 ms pulse of the seed. **Never again.** | self |

**Discoverability mitigations, all five mandatory together** — remove any one and the dormant
badge is a bug: revealed on `(hover: none)`; revealed on `:focus-visible`; revealed whenever a
`decorate()` chip is present (a working copilot must never hide); revealed for 2 s after every
`page:change`; and the full `aria-label` present in **every** state, including the 12 px dot.

**Dismissal chain — one `Esc` does exactly one thing** (preserving `mount.ts`'s four guards):
`picking → idle` · `composing → cancelled` · `popover → closed, focus → badge` · `panel → closed,
focus → seed` · nothing → the event is left untouched and the page keeps it.

**Click-outside dismisses the topmost surface — except the composer**, which becomes the draft
pearl. The draft already lives in `engine.placement` (`setDraft` on every keystroke), so this is a
rendering state, not new persistence. *The composer never loses your words.*

**Mutual exclusion:** panel ↔ popover are never both expanded (the panel slides to a 44 px rail).
Composer ↔ popover are never both primary (a reply docks the composer to the popover's bottom edge
and matches its width, so reply reads as one sheet growing downward).

**Keyboard, five chords, no bare letters inside our surfaces** (core's trigger handler is a
capture-phase `window` listener and would fire first): `c`/`a` pick · `Tab` badges in **document
order** (badge DOM is reordered by `compareDocumentPosition` after each sync) · `⏎`/`Space` open ·
`⌘↵` submit · `⌥↑`/`⌥↓` prev/next badge · `⌘⌫` delete · `Esc` the chain · `⌥⇧C` summon.

---

## 8. Per-surface notes not implied by §7

**8.1 Badge.** Solid, never glass — 40 badges each running an `autoUpdate` frame loop, each
forcing a backdrop-root readback, over MDN or Wikipedia, is a jank machine. Depth on the resting
layer comes from the collar and elevation; **material is a reward for expressing intent.**
`transform-origin` follows floating-ui's resolved placement (the controller writes
`data-placement`), so a badge grows *out of its anchor*, never out of itself. Badges whose rects
overlap within 24 px coalesce into a stack showing the count; hover fans them (3-card fan, 6°,
14 px offset, 200 ms `--_spring-1`).

**8.2 Picker.** The hole **is** the highlight: the scrim is punched with `clip-path` evenodd,
4 px outset, 6 px round, plus four 6 px corner ticks (ticks survive on backgrounds where a full
ring dissolves). The whole layer stays `pointer-events: none` — non-negotiable; the engine
resolves `composedPath()[0]` and the controller's `data-picking` rule makes every widget
click-through. On click: the outline flashes `--_accent-22` for 90 ms then dissolves over 132 ms
**while** the composer emerges — the two overlap by 60 ms, and that overlap is what makes the
click *become* the composer.

**8.3 Composer.** Input has no visible border — the sheet **is** the field; the focus ring is on
the sheet. `Labels.placeholder` survives (the only thing naming the box). Textarea auto-grows
2→8 rows (`min-height: 56px; max-height: 168px`), height at `--_d1`, upgraded to a real
`height: auto` transition behind `@supports (interpolate-size: allow-keywords)`. Dismiss button
deleted. `⌘↵` hint (`⌘ ↵` glyph pair, `--_t-11`, α .8) appears on `:focus-within` only.

**8.4 Thread popover.** Head = kind glyph · state silhouette · chip · close. **Title text
deleted** — the mode is the glyph. Comments stagger in **oldest-first** (reading order) at 22 ms.
A newly arrived copilot comment gets a 2 px `--_accent` left rail decaying to transparent over
1200 ms. Comment list `max-height: 280px` with scroll-fade masks
(`mask-image: linear-gradient(#000 calc(100% - 20px), transparent)` toggled by
`data-scroll-top/bottom`), `scrollbar-width: none` — the mask *is* the affordance — and
**`overscroll-behavior: contain`**, mandatory on a host page or a scrolled-out thread scrolls
*their* article. Orphan-while-open never jumps: the head silhouette crossfades to dashed, the
quote rail reveals, the action row swaps resolve for delete.

**8.5 Panel.** Sections are macOS inset grouped lists: `--_t-11` uppercase title + tabular count
above a `--_surface-2` @ 55 % card, rows separated by `--_line-sep` inset 10 px. Row = 12 px meta
(mode · count · chip) + 13 px one-line body with a **mask fade**, never
`text-overflow: ellipsis` — a mask reads softer and does not eat a character. **Empty state = one
20 px glyph at 26 % opacity in 64 px of air**; the four `Labels.empty*` strings move to
`aria-label` on the list, so screen readers keep the sentence and the eye gets nothing. Section
`<h3>`s survive as visually-hidden `aria-labelledby` targets — the §3 a11y shape holds.
**Rail mode:** when a popover opens, the panel does not close; it slides to
`translateX(calc(100% - 44px))` with its content fading over 200 ms, leaving a 44 px rail that
peeks back on hover. Attention becomes singular; state is preserved.

**8.6 Chips → the presence ladder.** `Decoration` is locked and unchanged; only its rendering
changes, and `chips.ts`'s precedence (busy > failed > pending > unread) is preserved.

| Rung | Trigger | Visual | Motion |
|---|---|---|---|
| 0 | `busy` < 450 ms | **nothing** | — | 
| 1 | `pending` | 5 px hollow ring, `--_muted` | static |
| 2 | `busy` ≥ 450 ms | breathing ring around the badge (badge does **not** grow) | `breathe` |
| 3 | `tool:call` / `tool:result` | 1 px tick on the ring at the step angle; fills on result | `--_d2` `--_spring-2` |
| 4 | `failed` | 5 px `cc-i-warn` triangle, `--_warn`; **chip text shown** (a code is an identifier, not prose) | auto-expand once, 2.4 s |
| 5 | `unread` | 5 px filled accent dot | one 900 ms halo on arrival, then `breathe` ×3, then solid |

Chip text renders visually **only** for `warn` / `danger`. For `neutral` / `info` / `busy` the
shape plus the native `title` carries it while `aria-live` announces `chip.text` verbatim.
Collapsed for eyes, complete for AT.

**8.7 Host chrome (pill + toast).** Sending is **determinate**: SPEC-copilot emits
`run:step { step, steps }`; feed it into `--_p` and render the send disc as
`conic-gradient(var(--_accent) calc(var(--_p) * 360deg), transparent 0)`. An indeterminate spinner
where a real progress number exists is a design failure, not a style choice. Stays below
`CommentUIOptions.zIndex` at 2147482000, unchanged. **Collision contract:** the pill owns the
corner; the panel seed/sheet shifts 44 px inward while `pendingCount > 0`.

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
| picker overlay | it follows a 60 fps cursor; a GL frame adds a frame of latency to the most latency-sensitive surface we have |
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
| badge | `💬` emoji | ✂ | `cc-i-comment` / `cc-i-ask` |
| badge | count `0`, `1` | ✂ below 2 | hidden; `aria-label` still says it |
| badge | `~` `⚑` `✓` marks | ✂ all three | silhouette + 10 px glyph |
| badge | `title` = `Labels.approximate` | ✔ **keep** | native tooltip |
| picker | `Labels.pickHint` sentence | ✂ from screen | `role="status"` (§3-required) + once per mount, 2.5 s, + 700 ms dwell |
| composer | `Labels.placeholder` | ✔ **keep** | the only thing naming the box |
| composer | `Labels.send` | ✂ | `cc-i-send` disc + `title` / `aria-label` |
| composer | `Labels.dismiss` | ✂ **button deleted** | `Esc` + click-away → draft pearl |
| popover | title "Comment" / "Ask" | ✂ | 14 px head glyph |
| popover | `reply` `resolve` `reopen` `delete` `edit` | ✂ all five | icons + native `title` |
| popover | `✕` | ✂ glyph | `cc-i-close` |
| popover | timestamp | ✔ already invisible | 3 px dot → `Intl.RelativeTimeFormat` on row hover |
| popover | copilot author name | ✂ | `cc-i-sparkle` |
| popover | orphan quote (`capture.text`) | ✔ **keep** | 2 px rail, 11 px `--_muted`, 3-line clamp, mask fade — the only place the deleted content still exists |
| panel | `Labels.panelTitle` `<h2>` | ✂ visually | already `aria-label`; heading visually hidden |
| panel | `sectionOpen` / `sectionResolved` / `sectionUnanchored` | ✂ | segmented control: icons + tabular counts; words in `title` / `aria-label` |
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

**Net: 24 strings leave the screen. Zero leave the accessibility tree.**

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
2. **Keyline sandwich** on every opaque-on-unknown element (§3.3).
3. **Glass floor 74 % / 64 % + three kill switches + `forced-colors`** (§3.1, §3.2).
4. **Compositor-only animation**, always (§6.3, §6.5).
5. `contain: layout style paint` on every floating box; `content-visibility: auto` on non-current
   panel lists; `will-change` only for the duration of an animation.
6. **`isolateEvents` and `pointer-events` behaviour is untouched.** The `data-picking`
   click-through rule, the `pointer-events: none` layer and the `composedPath()[0]` hazard are
   preserved verbatim. No node inside `.cc-layer` is ever `pointer-events: auto` except an
   interactive control.
7. **The host page's DOM is never mutated**, and it is never dimmed, blurred or frozen. Depth is
   built inside our own layer; the pick scrim is our own fixed node at
   `pointer-events: none`.
8. **Colour never carries state alone; motion never carries state alone** (§1.3).

---

## 12. Byte budget

| | now (gz) | after | Δ |
|---|---|---|---|
| `comment-ui` root (controller + `domPresentation`) | 26.0 KB | ≤ 26.4 KB | +0.4 |
| `comment-ui/glass` (sheet + sprite + intent + motion) | — | **≤ 7.5 KB** | lazy / opt-in |
| ├ stylesheet (tokens, materials, states, keyframes) | | ≤ 4.2 KB | |
| ├ 19-glyph `<symbol>` sprite | | ≤ 1.0 KB | |
| ├ intent tracker (`--_near`, `--_lx/--_ly`, polarity) | | ≤ 0.6 KB | |
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

---

## 13. The rulings (what was contested, and what won)

1. **Default badge state is a 12 px dot.** Figma, Docs and Notion all keep badges at full size,
   and hiding an affordance is how features die. Taken anyway, because the brief's "hide until
   intent" is the *whole* difference between an annotation layer and a tool that vandalises
   someone's page with twelve permanent blue pills — and it is defensible only with all five
   mitigations of §7 shipped together.
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

---

## 14. Deliberately unchanged

The `Esc` chain and its four guards · the `pointer-events: none` layer + `[data-picking]`
click-through · `pending` renders nothing · the badge/popover `aria-live` topology ·
`hideOffscreen` + the 96 px `rootMargin` · orphan docking at `capture.rect` with per-frame
re-projection · the controller's ownership of `left`/`top` · the `var(--cc-x, default)` → `--_x`
alias discipline (never a declaration on `:host`) · `isolateEvents` · `all: initial` + explicit
`font-size` + no `rem` · IIFE globals · the `Decoration`, `CommentUIOptions`, `CommentUI` and
`Labels` type surfaces · `domPresentation`, which is frozen.
