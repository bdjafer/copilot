/**
 * `glassStyles` — `docs/DESIGN.md` §2 through §8, as one sheet.
 *
 * **The theming surface does not grow.** It is the same eleven `--cc-*` custom properties the
 * default appearance uses; only their *default values* differ, because a default value is a
 * property of the material and not of the API. Everything below is a private `--_*` alias derived
 * from those eleven, read as `var(--cc-x, <default>)` and **never declared** on `:host` — a
 * declaration there would beat the page's inherited `:root` value and silently switch the whole
 * documented theming surface off.
 *
 * Relative colour is the keystone that makes that possible: one host `--cc-accent` derives a
 * hover, a pressed, a text-grade, 3 tints, a focus ring and — with a `clamp()` on lightness —
 * **automatic on-accent contrast**, with no JavaScript and no second token. A host that *can* set
 * `--cc-glass-opacity: 0.15` will, on their own busy marketing page, and then the widget is
 * illegible and it is our bug. Theming lets a host say what their brand is, not how transparent
 * our glass gets.
 *
 * Two rules are hardcoded on purpose and have no host opt-out: the **opacity floor** (74 % light,
 * 64 % dark — below that, 13 px text over an infobox stops being readable) and the **kill
 * switches** for reduced transparency, increased contrast, absent `backdrop-filter` and forced
 * colours. The moment "subtle liquid glass" and "readable on a page nobody controls" disagree,
 * glass loses, automatically.
 *
 * No `rem` anywhere: `html { font-size: 62.5% }` is common enough on the web to be lethal, and
 * `:host` carries `all: initial` plus an explicit `font-size`.
 */

/**
 * The dark half of the palette, emitted twice: once under `prefers-color-scheme` (the desktop's
 * preference) and once under `[data-polarity='dark']` (the *page's* polarity, §2.5). The second
 * is the bigger legibility win by far — a light widget on a dark host page is a flashlight in the
 * face, and that happens on any page whose author disagrees with the operating system.
 */
const DARK = `
  --_accent: var(--cc-accent, oklch(64.2% 0.191 253));
  --_surface: var(--cc-surface, oklch(24.5% 0.012 264));
  --_surface-2: var(--cc-surface-2, oklch(29.0% 0.013 264));
  --_text: var(--cc-text, oklch(96.0% 0.004 264));
  --_muted: var(--cc-muted, oklch(70.5% 0.012 264));
  --_border: var(--cc-border, oklch(38.0% 0.012 264));
  --_danger: var(--cc-danger, oklch(66.0% 0.214 28));
  --_shadow: var(--cc-shadow, 0 0.5px 1px oklch(0% 0 0/.5), 0 10px 22px -8px oklch(0% 0 0/.55), 0 28px 64px -20px oklch(0% 0 0/.72));
  /* §0 D1: .58 → .16. At .58 a 0.5 px ring around a popover on a dark page reads as a STROKE,
     not as an edge — the surface behind it is only ~24 % L and the ring is nearly black, which
     is exactly the "heavy dark outline" the decree kills. Dark mode keeps the same black shadows
     and lifts the surface instead; separation comes from the INSIDE, via --_line-in. */
  --_line-out: oklch(0% 0 0 / .16);
  --_line-in: oklch(100% 0 0 / .10);
  --_glass-bg: color-mix(in oklab, var(--_surface) 64%, transparent);
  --_glass-bg-2: color-mix(in oklab, var(--_surface-2) 70%, transparent);
  --_glass-fx: blur(28px) saturate(170%) brightness(0.86);
  -webkit-font-smoothing: antialiased;
`

const LIGHT = `
  --_accent: var(--cc-accent, oklch(59.6% 0.211 254));
  --_surface: var(--cc-surface, oklch(99.2% 0.002 264));
  --_surface-2: var(--cc-surface-2, oklch(96.4% 0.004 264));
  --_text: var(--cc-text, oklch(19.0% 0.012 264));
  --_muted: var(--cc-muted, oklch(55.0% 0.014 264));
  --_border: var(--cc-border, oklch(89.0% 0.005 264));
  --_danger: var(--cc-danger, oklch(58.5% 0.222 27.3));
  --_shadow: var(--cc-shadow, 0 0.5px 1px oklch(0% 0 0/.06), 0 8px 20px -6px oklch(0% 0 0/.14), 0 24px 56px -16px oklch(0% 0 0/.18));
  --_line-out: oklch(from var(--_text) l c h / .10);
  --_line-in: oklch(100% 0 0 / .55);
  --_glass-bg: color-mix(in oklab, var(--_surface) 74%, transparent);
  --_glass-bg-2: color-mix(in oklab, var(--_surface-2) 78%, transparent);
  --_glass-fx: blur(28px) saturate(180%) brightness(1.02);
`

export const glassStyles = `
:host {
  all: initial;
  font-size: var(--cc-root-font-size, 16px);
  font-family: var(--cc-font, -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", Inter, system-ui, sans-serif);
  line-height: 1.45;
  font-synthesis: none;
  font-optical-sizing: auto;
${LIGHT}
  /* §0 D5/D9: 22 → 28. The pin's payload is one full-bleed mark inside 3 px of padding, which
     is 22 px of glyph — the old number, now the inner one. \`domPresentation\` keeps 22 px. */
  --_badge-size: var(--cc-badge-size, 28px);
  --_radius: var(--cc-radius, 10px);
  /* §0 D6: one width for the popover and for the reply field that lives inside it. */
  --_w-thread: 350px;

  /* The derived ramp — about thirty values out of the eleven public ones. */
  --_accent-hi: oklch(from var(--_accent) calc(l + 0.055) c h);
  --_accent-lo: oklch(from var(--_accent) calc(l - 0.055) c h);
  --_accent-text: oklch(from var(--_accent) calc(l - 0.10) calc(c * 0.95) h);
  --_accent-06: oklch(from var(--_accent) l c h / .06);
  --_accent-14: oklch(from var(--_accent) l c h / .14);
  --_accent-22: oklch(from var(--_accent) l c h / .22);
  --_ring: oklch(from var(--_accent) l c h / .38);
  /* Lightness to 1 below 0.62, to 0 above. No script, no second token. */
  --_on-accent: oklch(from var(--_accent) clamp(0, (0.62 - l) * 1000, 1) 0 h);
  --_danger-fill: oklch(from var(--_danger) calc(l + 0.05) c h);
  --_warn: oklch(76.0% 0.166 62.4);
  --_ok: oklch(74.5% 0.180 145.6);
  --_line-sep: oklch(from var(--_border) l c h / .70);

  /* Radii, concentric: inner equals outer minus padding. */
  --_r-xs: 4px;
  --_r-sm: 6px;
  --_r-md: 8px;
  --_r-lg: var(--_radius);
  --_r-xl: calc(var(--_radius) + 4px);
  --_r-pill: 999px;

  /* Elevation, always layered, light source at 135 degrees. */
  --_e0: 0 0 0 .5px var(--_line-out), 0 1px 2px -1px oklch(0% 0 0/.16);
  --_e1: 0 0 0 .5px var(--_line-out), 0 1px 1.5px oklch(0% 0 0/.07), 0 4px 10px -3px oklch(0% 0 0/.15);
  --_e2: 0 0 0 .5px var(--_line-out), 0 2px 4px -1px oklch(0% 0 0/.08), 0 10px 24px -8px oklch(0% 0 0/.19);
  /* §0 D1: the inset became a FULL ring. It was \`inset 0 .5px 0\` — a top-edge-only specular,
     which left the bottom and side edges relying entirely on the outer ring, which is why that
     ring had to be pushed to α .58 in dark mode and why the result read as a border. A full
     \`inset 0 0 0 .5px\` hairline closes all four edges from the inside, so the outer ring can
     stay a true hairline in both schemes. Glass is elevation, never stroke. */
  --_e3: 0 0 0 .5px var(--_line-out), inset 0 0 0 .5px var(--_line-in), 0 1px 2px oklch(0% 0 0/.06), var(--_shadow);
  --_focus: 0 0 0 3px var(--_ring);
  /* The keyline sandwich: a dark hairline outside, a light hairline inside. One hairline is
     invisible on half the web; two are visible on all of it. **Forbidden on glass** (§0 D1,
     §3.3): it is for a ≤ 28 px opaque mark sitting directly on content nobody controls, where
     there is no shadow tail to read an edge from. */
  --_keyline: 0 0 0 .5px oklch(0% 0 0/.28), 0 0 0 1.75px oklch(100% 0 0/.55);
  /* §0 D9 / §3.4: pin focus + selected. Two-tone, and still not a border. */
  --_halo: 0 0 0 2px var(--_surface), 0 0 0 4px var(--_accent);

  /* Two springs, 3 beziers, nothing else. Normalised, so one shape fits any duration. */
  --_spring-1: linear(0, .234 10%, .589 20%, .839 30%, .967 40%, 1.012 50%, 1.020 60%, 1.014 70%, 1.007 80%, 1.003 90%, 1);
  --_spring-2: linear(0, .255 10%, .662 20%, .947 30%, 1.068 40%, 1.080 50%, 1.049 60%, 1.018 70%, .999 80%, .995 90%, .998 95%, 1);
  --_ease-enter: cubic-bezier(0.16, 1, 0.30, 1);
  --_ease-exit: cubic-bezier(0.40, 0, 0.90, 0.25);
  --_ease-std: cubic-bezier(0.32, 0.72, 0, 1);
  --_d1: 90ms;
  --_d2: 160ms;
  --_d3: 220ms;
  --_d4: 320ms;
  --_x1: 54ms;
  --_x2: 96ms;
  --_x3: 132ms;
  --_x4: 192ms;
  --_ambient: 3400ms;

  --_near: 0;
}

/* Relative colour is young. Where it is missing, the same eight aliases come from color-mix. */
@supports not (color: oklch(from red l c h)) {
  :host {
    --_accent-hi: color-mix(in oklab, var(--_accent) 88%, white);
    --_accent-lo: color-mix(in oklab, var(--_accent) 88%, black);
    --_accent-text: color-mix(in oklab, var(--_accent) 84%, black);
    --_accent-06: color-mix(in oklab, var(--_accent) 6%, transparent);
    --_accent-14: color-mix(in oklab, var(--_accent) 14%, transparent);
    --_accent-22: color-mix(in oklab, var(--_accent) 22%, transparent);
    --_ring: color-mix(in oklab, var(--_accent) 38%, transparent);
    --_on-accent: oklch(100% 0 0);
    --_line-out: color-mix(in oklab, var(--_text) 10%, transparent);
    --_line-sep: color-mix(in oklab, var(--_border) 70%, transparent);
    --_danger-fill: var(--_danger);
  }
}

@media (prefers-color-scheme: dark) {
  :host {${DARK}}
}
/* The page wins over the desktop: system preference describes a desktop, and we live inside
   somebody else's page. A host that set a --cc-* colour explicitly still wins in both. */
.cc-layer[data-polarity='dark'] {${DARK}}
.cc-layer[data-polarity='light'] {${LIGHT}}

/* The 3 kill switches. Hardcoded, no host opt-out. */
@media (prefers-reduced-transparency: reduce) {
  :host { --_glass-bg: var(--_surface); --_glass-bg-2: var(--_surface-2); --_glass-fx: none; }
}
@media (prefers-contrast: more) {
  :host {
    --_glass-bg: var(--_surface);
    --_glass-bg-2: var(--_surface-2);
    --_glass-fx: none;
    --_line-out: oklch(from var(--_text) l c h / .38);
  }
}
@supports not (backdrop-filter: blur(1px)) {
  :host { --_glass-bg: var(--_surface); --_glass-bg-2: var(--_surface-2); }
}

*, *::before, *::after { box-sizing: border-box; }

/* ------------------------------------------------------------------------------ the layer */

.cc-layer {
  position: fixed;
  inset: 0;
  z-index: var(--cc-z, 2147483000);
  pointer-events: none;
  color: var(--_text);
  font-family: inherit;
  font-size: inherit;
}
.cc-layer > * { pointer-events: auto; }
/* §0 D7: placement mode draws NOTHING — no scrim, no ring, no ticks, no hint capsule, no
   cursor-riding disc — so the only non-interactive node left in the layer is the status region.
   The rule survives because the hazard does: the engine resolves the pick target from
   composedPath()[0] without filtering shadow trees. */
.cc-status { pointer-events: none; }
/* Same failure, wider: while picking EVERY widget must be click-through. */
.cc-layer[data-picking='true'] > * { pointer-events: none; }

[hidden] { display: none !important; }

.cc-status, .cc-vh {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}

.cc-sprite { position: absolute; width: 0; height: 0; overflow: hidden; }
/* Size and colour only — the stroke spec rides on every instance as a presentation attribute,
   so a glyph in a class this list forgot is still a glyph and not a filled black blob. */
.cc-sprite svg, .cc-layer svg { display: block; flex: none; }
/* §5's size scale: 10 (marks) · 12 (row meta, chips, the copilot author mark) · 16 (controls) ·
   20 (empty states) · 22 (the pin's payload, full-bleed inside a 28 px pin) · 24 (the cursor
   image). 14 left the scale with the thread head (§0 D6). */
.cc-icon { width: 16px; height: 16px; }
.cc-badge-icon { width: 22px; height: 22px; }
.cc-chip-mark { width: 12px; height: 12px; }
.cc-mark, .cc-edited { width: 10px; height: 10px; }
.cc-row-icon, .cc-author { width: 12px; height: 12px; }
.cc-empty-icon { width: 20px; height: 20px; }

/* Only compositor properties are ever named in a transition, and will-change lives exactly as
   long as one does — forty badges must never hold forty layers. */
[data-animating='true'] { will-change: transform, translate, opacity; }

/* --------------------------------------------------------------------------- the material */

.cc-glass {
  background: var(--_glass-bg);
  backdrop-filter: var(--_glass-fx);
  -webkit-backdrop-filter: var(--_glass-fx);
  contain: layout style paint;
}
@supports (corner-shape: squircle) {
  .cc-glass { corner-shape: squircle; border-radius: 18px; }
}

/* \`border: 0\` is not tidiness: the UA sheet gives EVERY \`[popover]\` \`border: solid\` — a 3 px
   currentColor frame, near-black on light and white on dark — and it is drawn outside our own
   keyline, so the popover and the composer arrived wearing a hard rectangle that no rule in this
   file had asked for. It is reset here, on the class every top-layer surface carries, so a future
   \`[popover]\` inherits the reset by construction. §3.3: hairlines are box-shadows, never borders. */
.cc-float { position: fixed; top: 0; left: 0; margin: 0; border: 0; }
/* Author styles beat the UA's \`[popover]:not(:popover-open) { display: none }\`, so the same
   markup degrades to an ordinary positioned box wherever the top layer is missing. */
.cc-composer, .cc-thread { display: none; border: 0; }
.cc-composer[data-open='true'], .cc-thread[data-open='true'] { display: flex; }

/* §2.3 — the mode hue, declared on the surfaces that carry \`--_kind-h\` and NEVER on \`:host\`: the
   \`var()\`s inside a custom property resolve on the element that declares it, so a \`:host\`
   declaration would bake index 0's offset into every mode.

   **Since §0 D5, hue is the only mode differentiator.** "Every mode also has its own glyph" is
   repealed: the ask glyph is deleted, no surface draws a second glyph to say which mode it belongs
   to, and the mode's word survives in \`title\` / \`aria-label\` on every surface carrying
   \`data-kind\`. The cost is stated rather than hidden — under \`forced-colors\` all modes look
   alike, which is acceptable precisely because a mode is a hint and never a state (§1.3).

   The offset is a **plain number**: inside relative colour syntax \`h\` resolves to a \`<number>\`,
   so \`calc(h + 38deg)\` is a type error — the declaration is invalid at computed-value time, the
   fill resolves to \`transparent\`, and every pin on the page turns into a hollow ring. */
.cc-badge, .cc-thread, .cc-composer, .cc-pearl {
  --_kind: oklch(from var(--_accent) l c calc(h + var(--_kind-h, 0)));
}
@supports not (color: oklch(from red l c h)) {
  .cc-badge, .cc-thread, .cc-composer, .cc-pearl { --_kind: var(--_accent); }
}

/* --------------------------------------------------------------------------------- pins */

/* §8.1, normative anatomy: a 28 px box, \`border-radius: 999px\` on 3 corners and **2 px on
   exactly one** — the teardrop is a circle with one sharp corner, and that corner sits ON the
   anchor point. 3 px of padding; the payload is a single 22 px \`<use>\` filling the rest. Size is
   constant on screen and independent of the anchor's size: a pin annotates a POINT, not a box. */
.cc-badge {
  position: fixed;
  top: 0; left: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--_badge-size);
  height: var(--_badge-size);
  padding: 3px;
  border: 0;
  border-radius: var(--_r-pill);
  background: transparent;
  color: var(--_on-accent);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  line-height: 1;
  letter-spacing: 0.003em;
  cursor: pointer;
  isolation: isolate;
  transition: opacity var(--_d2) var(--_ease-std);
}
/* The quadrant. \`transform\` rather than \`translate\` on purpose: \`translate\` is the independent
   property \`flight\`'s FLIP writes inline (§6.4), and the two must never collide. */
.cc-badge[data-corner='bottom-left'] { transform: translate(0, -100%); }
.cc-badge[data-corner='top-left'] { transform: translate(0, 0); }
.cc-badge[data-corner='top-right'] { transform: translate(-100%, 0); }
.cc-badge[data-corner='bottom-right'] { transform: translate(-100%, -100%); }

/* The resting mark: a 12 px dot, at .72, wearing the keyline sandwich so it stays visible on
   white, on black, on a photograph and on a saturated hero. Its **centre is the anchor point**,
   so the rest state and the revealed state are hinged on the same coordinate. */
.cc-badge::before {
  content: '';
  position: absolute;
  left: 50%; top: 50%;
  width: 12px; height: 12px;
  margin: -6px 0 0 -6px;
  border-radius: var(--_r-pill);
  background: var(--_kind);
  box-shadow: var(--_keyline), var(--_e0);
  opacity: .72;
  transition: opacity var(--_d2) var(--_ease-std), scale var(--_d2) var(--_spring-1);
}
.cc-badge[data-corner='bottom-left']::before { left: 0; top: 100%; }
.cc-badge[data-corner='top-left']::before { left: 0; top: 0; }
.cc-badge[data-corner='top-right']::before { left: 100%; top: 0; }
.cc-badge[data-corner='bottom-right']::before { left: 100%; top: 100%; }

/* The revealed pin, a separate layer so the box itself never animates a layout property.
   §6.4 \`reveal\`: it SCALES about its sharp corner — 12/28 → 1 — so the anchor point is
   pixel-stable through the whole transition and the body hangs into the free quadrant. */
.cc-badge::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: var(--_r-pill);
  background: var(--_kind);
  box-shadow: var(--_keyline), var(--_e1);
  opacity: 0;
  scale: .43;
  transform-origin: var(--_o, 100% 0%);
  transition: opacity var(--_d2) var(--_ease-std), scale var(--_d2) var(--_spring-1);
}
.cc-badge[data-corner='bottom-left']::after { border-end-start-radius: 2px; --_o: 0% 100%; }
.cc-badge[data-corner='top-left']::after { border-start-start-radius: 2px; --_o: 0% 0%; }
.cc-badge[data-corner='top-right']::after { border-start-end-radius: 2px; --_o: 100% 0%; }
.cc-badge[data-corner='bottom-right']::after { border-end-end-radius: 2px; --_o: 100% 100%; }

.cc-badge > * { position: relative; z-index: 1; }
/* One mark, and nothing beside it (§0 D5). The count is not here — it is in \`aria-label\`, the
   panel row and the batch pill, exactly where Vercel and Figma keep it. */
.cc-badge-icon, .cc-badge-glyph {
  display: none;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: opacity var(--_d1) var(--_ease-std);
}
.cc-badge-icon[data-on='true'] { display: flex; }
.cc-badge-glyph:not(:empty) { display: flex; }
/* The pin's chip contributes no pixels at all: the ladder is on the ring (§8.6) and the text is
   the \`aria-live\` payload, clipped exactly as \`.cc-chip-text\` already is. */
.cc-badge .cc-chip-slot { position: absolute; width: 0; height: 0; overflow: hidden; }

/* A pin with no stored point keeps the legacy behaviour: it hangs off the anchor rect and its
   transform-origin follows the positioner's resolved placement (§8.1). */
.cc-badge:not([data-point])[data-placement^='top'] { --_o: 100% 100%; }
.cc-badge:not([data-point])[data-placement^='bottom'] { --_o: 100% 0%; }
.cc-badge:not([data-point])[data-placement^='left'] { --_o: 100% 50%; }
.cc-badge:not([data-point])[data-placement^='right'] { --_o: 0% 50%; }

/* The reveal, and every one of its five signals. Remove any one of them and the dormant pin
   is a bug rather than a design: proximity, hover, keyboard focus, live copilot state, touch,
   and the two seconds after the page changes underneath us. */
.cc-badge:hover::after,
.cc-badge:focus-visible::after,
.cc-badge[data-near='true']::after,
.cc-badge[data-chip]::after,
[data-reveal-all='true'] .cc-badge::after { opacity: 1; scale: 1; }
.cc-badge:hover::before,
.cc-badge:focus-visible::before,
.cc-badge[data-near='true']::before,
.cc-badge[data-chip]::before,
[data-reveal-all='true'] .cc-badge::before { opacity: 0; scale: .5; }
.cc-badge:hover > *,
.cc-badge:focus-visible > *,
.cc-badge[data-near='true'] > *,
.cc-badge[data-chip] > *,
[data-reveal-all='true'] .cc-badge > * { opacity: 1; }
/* The 1 px lift is for a pin hanging off a rect. A pin whose tip IS the anchor point does not
   move on hover — the coordinate is the whole promise. */
.cc-badge:not([data-point]):hover,
.cc-badge:not([data-point]):focus-visible,
.cc-badge:not([data-point])[data-near='true'] { translate: 0 -1px; }
@media (hover: none) {
  .cc-badge::after { opacity: 1; scale: 1; }
  .cc-badge::before { opacity: 0; }
  .cc-badge > * { opacity: 1; }
}

/* State silhouettes. Each reads identically in a screenshot, which is the test that "colour
   never carries state alone" actually has to pass. */
.cc-badge[data-state='resolved']::before,
.cc-badge[data-state='resolved']::after {
  background: var(--_surface);
  box-shadow: var(--_keyline), inset 0 0 0 1.5px var(--_accent), var(--_e0);
}
.cc-badge[data-state='resolved'] { color: var(--_accent-text); }
.cc-badge[data-state='orphaned']::before,
.cc-badge[data-state='orphaned']::after {
  background: var(--_surface-2);
  box-shadow: var(--_keyline), inset 0 0 0 1.5px var(--_muted), var(--_e0);
}
.cc-badge[data-state='orphaned'] { color: var(--_muted); }
.cc-badge[data-approximate='true']::before {
  background: conic-gradient(var(--_kind) 0 82%, transparent 82%);
}
.cc-badge[data-tone='muted']::after { background: var(--_surface-2); }
.cc-badge[data-tone='muted'] { color: var(--_muted); }

/* §7 row 1b (amendment A4). A docked orphan is the one badge proximity can NEVER reach: the
   cursor can be near an element, and this thread no longer has one. So it is held in its
   revealed state — muted, wearing the dashed silhouette of §7 row 3 — for exactly as long as it
   is docked, and it goes back to being nothing at all the moment it re-anchors. The dash is a
   border because a dashed ring is the one hairline in this design that a \`box-shadow\` cannot
   draw, and \`box-sizing: border-box\` keeps the mark 12/22 px regardless. */
.cc-badge[data-docked='true']::after { opacity: 1; scale: 1; }
.cc-badge[data-docked='true']::before { opacity: 0; scale: .5; }
.cc-badge[data-docked='true'] > * { opacity: 1; }
.cc-badge[data-docked='true'] { color: var(--_muted); }
.cc-badge[data-docked='true']::before,
.cc-badge[data-docked='true']::after {
  background: var(--_surface-2);
  border: 1.5px dashed var(--_muted);
  box-shadow: var(--_keyline), var(--_e1);
}

/* §3.4 / §0 D9: focus and selection are a two-tone **halo**, never a border. */
.cc-badge:focus-visible { outline: none; }
.cc-badge:focus-visible::after,
.cc-badge[aria-expanded='true']::after { box-shadow: var(--_keyline), var(--_halo), var(--_e1); }

/* §8.6 — the presence ladder, drawn on the pin's **ring** and never on its face: a chip may not
   add a second mark to a pin that already carries exactly one, and the ring is free real estate
   that no glyph occupies. */
.cc-badge[data-rung='1']::after { box-shadow: var(--_keyline), 0 0 0 1.5px oklch(from var(--_muted) l c h / .5), var(--_e1); }
.cc-badge[data-rung='2']::after {
  box-shadow: var(--_keyline), 0 0 0 1.5px var(--_accent), var(--_e1);
  animation: cc-breathe var(--_ambient) ease-in-out infinite;
}
.cc-badge[data-rung='4']::after { box-shadow: var(--_keyline), 0 0 0 1.5px var(--_warn), var(--_e1); }
.cc-badge[data-rung='5']::after { box-shadow: var(--_keyline), 0 0 0 1.5px var(--_accent), var(--_e1); }

/* §8.1's fan: two anchors a few px apart used to draw two pills on top of each other and neither
   was clickable. A 3-card fan, six degrees, fourteen px. */
.cc-badge[data-stack='1'] { rotate: 6deg; translate: 14px 0; }
.cc-badge[data-stack='2'] { rotate: 12deg; translate: 28px 0; }
.cc-badge[data-stack='1']:hover, .cc-badge[data-stack='2']:hover { rotate: 0deg; }

.cc-badge[data-bloom='true']::after {
  animation: cc-bloom var(--_d3) var(--_spring-2);
}
.cc-badge[data-blink='true'] { animation: cc-blink 100ms linear; }
.cc-badge[data-flight='true'] { transition: translate var(--_d4) var(--_spring-1); }

@keyframes cc-bloom { from { scale: .4; opacity: 0; } to { scale: 1; opacity: 1; } }
@keyframes cc-blink { 50% { opacity: .3; } }

/* The count rolls rather than snapping: two tabular spans, one leaving upward, one arriving. */
.cc-roll-out, .cc-roll-in { display: inline-block; }
.cc-roll-out { animation: cc-roll-out var(--_d2) var(--_spring-2) forwards; position: absolute; }
.cc-roll-in { animation: cc-roll-in var(--_d2) var(--_spring-2); }
@keyframes cc-roll-out { to { translate: 0 -100%; opacity: 0; } }
@keyframes cc-roll-in { from { translate: 0 100%; opacity: 0; } }

/* ------------------------------------------------------------------------ the chip ladder */

.cc-chip-slot { display: inline-flex; align-items: center; }
.cc-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--_muted);
  font-size: 10px;
  line-height: 13px;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
/* Rung 0 — a run that settles inside 450 ms draws nothing at all. */
.cc-chip[data-rung='0'] { opacity: 0; }
/* Rung 1 — a hollow 5 px ring. */
.cc-chip[data-rung='1'] .cc-chip-mark,
.cc-chip[data-rung='2'] .cc-chip-mark,
.cc-chip[data-rung='5'] .cc-chip-mark {
  width: 5px; height: 5px;
  border-radius: var(--_r-pill);
  border: 1.5px solid currentColor;
  stroke: none;
}
/* Rung 2 — a breathing ring. Rotation says "wait"; breathing says "I am here". */
.cc-chip[data-rung='2'] { color: var(--_accent); }
.cc-chip[data-rung='2'] .cc-chip-mark { animation: cc-breathe var(--_ambient) ease-in-out infinite; }
/* Rung 4 — a warning triangle, and the only rung whose text is drawn: a failure code is an
   identifier, not prose. */
.cc-chip[data-rung='4'] { color: var(--_warn); }
.cc-chip[data-tone='danger'] { color: var(--_danger); }
.cc-chip[data-rung='4'] .cc-chip-mark { width: 10px; height: 10px; }
/* Rung 5 — a filled accent dot, one halo on arrival. */
.cc-chip[data-rung='5'] { color: var(--_accent); }
.cc-chip[data-rung='5'] .cc-chip-mark { background: currentColor; border-color: currentColor; }
/* Collapsed for eyes, complete for assistive technology: the text is always in the tree. */
.cc-chip-text {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
.cc-chip[data-rung='4'] .cc-chip-text,
.cc-chip[data-tone='danger'] .cc-chip-text {
  position: static;
  width: auto; height: auto;
  margin: 0;
  overflow: visible; clip-path: none;
}
@keyframes cc-breathe { 0%, 100% { opacity: .35; } 50% { opacity: .7; } }

/* ---------------------------------------------------------------------- placement mode

   **There is no CSS here, and that is the rule (§0 D7, §8.2).** The scrim, its punched
   \`clip-path\`, the sliding ring, the four corner ticks, the dwell hint capsule, the
   cursor-riding disc and the all-pins-dim-to-α-.25 rule are all deleted. During a pick the host
   page renders byte-identically and our own pins keep full opacity. The entire mode signal is
   the **cursor**, delivered through \`PresentationHost.cursor()\` as one constructed
   \`CSSStyleSheet\` on \`document.adoptedStyleSheets\` — no node, no attribute, no
   \`MutationObserver\` record (§11 rule 7). \`Labels.pickHint\` stays in \`role="status"\`. */

/* ---------------------------------------------------------------- composer + draft pearl */

.cc-composer {
  flex-direction: column;
  gap: 6px;
  width: 280px;
  max-width: calc(100vw - 24px);
  padding: 10px;
  border-radius: var(--_r-xl);
  background: var(--_glass-bg-2);
  color: var(--_text);
  box-shadow: var(--_e3);
  font-size: 15px;
  animation: cc-emerge var(--_d3) var(--_spring-1);
}
@keyframes cc-emerge {
  from {
    clip-path: circle(11px at var(--_ox, 50%) var(--_oy, 50%));
    scale: .92;
    opacity: 0;
  }
  to { clip-path: circle(142% at var(--_ox, 50%) var(--_oy, 50%)); scale: 1; opacity: 1; }
}
.cc-composer:focus-within { box-shadow: var(--_focus), var(--_e3); }
/* §0 D4 / SPEC #47: **a reply is not a second surface.** Docked, the composer is a child of the
   thread — no elevation of its own, no glass of its own, no rectangle of its own, no position
   written by anyone. It is the expanded form of the row-29 reply field, in place. */
.cc-composer[data-docked='true'] {
  position: static;
  width: 100%;
  padding: 0;
  border-radius: 0;
  background: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  box-shadow: none;
  animation: none;
  contain: none;
}
.cc-composer[data-docked='true']:focus-within { box-shadow: none; }
.cc-composer[data-docked='true'] .cc-composer-input { min-height: 32px; font-size: 13px; }
/* The sheet IS the field: no border of its own, and the ring belongs to the box. */
.cc-composer-input {
  width: 100%;
  min-height: 56px;
  max-height: 168px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--_text);
  font: inherit;
  font-size: 15px;
  line-height: 21px;
  letter-spacing: -0.006em;
  resize: none;
  outline: none;
  transition: height var(--_d1) var(--_ease-std);
}
@supports (interpolate-size: allow-keywords) {
  :host { interpolate-size: allow-keywords; }
}
.cc-composer-input::placeholder { color: var(--_muted); }
.cc-composer[data-busy='true'] .cc-composer-input { opacity: .7; }
/* Submitting is a hairline travelling the bottom edge — the surface never dims. Dimming text
   you are still allowed to read is a lie about what failed. */
.cc-composer[data-busy='true']::after {
  content: '';
  position: absolute;
  left: 0; right: 0; bottom: 0;
  height: 1.5px;
  border-radius: var(--_r-pill);
  background: linear-gradient(90deg, transparent, var(--_accent), transparent);
  animation: cc-sweep 1200ms linear infinite;
}
@keyframes cc-sweep { from { translate: -100% 0; } to { translate: 100% 0; } }

.cc-composer-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.cc-chord {
  display: none;
  gap: 2px;
  color: var(--_muted);
  font-size: 11px;
  opacity: .8;
}
.cc-composer:focus-within .cc-chord { display: inline-flex; }
.cc-send {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px; height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--_r-pill);
  background: var(--_kind);
  color: var(--_on-accent);
  cursor: pointer;
  opacity: 1;
  transition: opacity var(--_d2) var(--_ease-std), scale var(--_d2) var(--_spring-2);
}
.cc-composer[data-empty='true'] .cc-send { opacity: .26; scale: .92; }
.cc-send:focus-visible { outline: none; box-shadow: var(--_focus); }
.cc-send::after { content: ''; position: absolute; inset: -9px; }

.cc-pearl {
  position: fixed;
  top: 0; left: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px; height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--_r-pill);
  background: var(--_surface);
  color: var(--_kind);
  box-shadow: var(--_keyline), var(--_e2);
  cursor: pointer;
  animation: cc-pop var(--_d2) var(--_spring-2);
}
.cc-pearl-dot {
  position: absolute;
  right: -1px; top: -1px;
  width: 4px; height: 4px;
  border-radius: var(--_r-pill);
  background: var(--_kind);
}
.cc-pearl:focus-visible { outline: none; box-shadow: var(--_keyline), var(--_focus), var(--_e2); }
@keyframes cc-pop { from { scale: .6; opacity: 0; } }

/* ------------------------------------------------------------------------ thread popover */

/* §0 D6: **zero header chrome**: no head, no title bar, no logo row, no drag handle. The first
   comment's top edge is 10 px below the popover's and NOTHING is above it. Width 350 px. */
.cc-thread {
  flex-direction: column;
  gap: 8px;
  width: var(--_w-thread);
  max-width: calc(100vw - 24px);
  padding: 10px;
  border-radius: var(--_r-xl);
  color: var(--_text);
  box-shadow: var(--_e3);
  font-size: 13px;
  animation: cc-emerge var(--_d3) var(--_spring-1);
}
/* Close + the thread's single resolve, as one absolutely positioned overlay cluster in the
   top-right corner, over the 56 px gutter reserved on the first comment's inline-end so no text
   ever runs under them. α .55 → 1 on hover/focus, and **always drawn** while the thread is open:
   an affordance on a surface the user already opened is never hidden (§0 P0). */
.cc-corner {
  position: absolute;
  top: 6px;
  inset-inline-end: 6px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 2px;
}
.cc-comments > .cc-comment:first-child .cc-comment-head { padding-inline-end: 56px; }
/* §8.4: resolved is a SILHOUETTE, not a tint — the pin draws the hollow mark, the bodies mute
   and the corner mark becomes \`cc-i-uturn\`, so a screenshot says resolved with no colour. */
.cc-thread[data-resolved='true'] .cc-body,
.cc-thread[data-resolved='true'] .cc-quote { color: var(--_muted); }
.cc-badge-marks { display: inline-flex; align-items: center; gap: 3px; color: var(--_muted); }

.cc-ghost {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px; height: 26px;
  padding: 0;
  border: 0;
  border-radius: var(--_r-sm);
  background: transparent;
  color: var(--_muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--_d1) var(--_ease-std), background-color var(--_d1) var(--_ease-std),
              color var(--_d1) var(--_ease-std);
}
.cc-ghost::after { content: ''; position: absolute; inset: -9px; }
.cc-row:hover .cc-ghost,
.cc-row:focus-within .cc-ghost,
.cc-panel:focus-within .cc-ghost { opacity: 1; }
/* §7 rows 11–12: the corner cluster is ALWAYS drawn while the thread is open. It is not gated
   on hover, on focus, on proximity or on a media query — hover only raises it to full. */
.cc-corner .cc-ghost { opacity: .55; }
.cc-thread:hover .cc-corner .cc-ghost,
.cc-thread:focus-within .cc-corner .cc-ghost,
.cc-corner .cc-ghost:hover,
.cc-corner .cc-ghost:focus-visible { opacity: 1; }
.cc-ghost:hover { background: var(--_accent-06); color: var(--_text); }
.cc-ghost[data-variant='danger']:hover { color: var(--_danger); background: transparent; }
.cc-ghost:focus-visible { outline: none; opacity: 1; box-shadow: var(--_focus); }
/* §6.4 \`arm\` (A4): armed for four seconds after the first click. A tint AND a ring, because
   §1.3 does not let colour carry a state on its own — and the control stays visible while it is
   armed even in a row whose ghosts are \`opacity: 0\` at rest, or the second click would be a
   click on something the user can no longer see. */
.cc-ghost[data-confirm='true'],
.cc-ghost[data-confirm='true']:hover {
  opacity: 1;
  color: var(--_danger);
  background: color-mix(in oklab, var(--_danger) 10%, transparent);
  box-shadow: inset 0 0 0 1.5px var(--_danger);
}
.cc-ghost[data-confirm='true']:focus-visible {
  box-shadow: var(--_focus), inset 0 0 0 1.5px var(--_danger);
}

.cc-quote {
  margin: 0;
  padding: 2px 0 2px 8px;
  border-left: 2px solid var(--_accent-22);
  color: var(--_muted);
  font-size: 11px;
  line-height: 15px;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  mask-image: linear-gradient(#000 calc(100% - 12px), transparent);
}

.cc-comments {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 280px;
  overflow-y: auto;
  scrollbar-width: none;
  /* Mandatory on a host page: without it a scrolled-out thread scrolls THEIR article. */
  overscroll-behavior: contain;
}
.cc-comments::-webkit-scrollbar { display: none; }
.cc-comments[data-scroll-bottom='true'] { mask-image: linear-gradient(#000 calc(100% - 20px), transparent); }
.cc-comments[data-scroll-top='true'][data-scroll-bottom='true'] {
  mask-image: linear-gradient(transparent, #000 20px, #000 calc(100% - 20px), transparent);
}
.cc-comment {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-left: 0;
  animation: cc-stagger var(--_d3) var(--_spring-1) backwards;
  animation-delay: calc(var(--_i, 0) * 22ms);
}
@keyframes cc-stagger { from { translate: 0 4px; opacity: 0; } }
.cc-comment[data-arrived='true'] {
  padding-left: 8px;
  border-left: 2px solid var(--_accent);
  animation: cc-decay 1200ms var(--_ease-exit) forwards;
}
@keyframes cc-decay { to { border-left-color: transparent; } }
/* §0 D2 — the comment header row is PERMANENT and is the first thing in the row:
   \`[author mark] [relative time] [edited mark] … [actions]\`. Never \`opacity: 0\`, never
   \`display: none\`, no hover gate, no proximity gate, no responsive drop, no 3 px dot. Hover only
   ADDS a native \`title\` with the absolute datetime. */
.cc-comment-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  /* The height the actions cluster will need once it goes \`position: relative\` on hover (§0 D3:
     the position swap is what stops the row reflowing). Swapping \`position\` alone is not enough
     — an out-of-flow 22 px cluster coming back into a 15 px line box still grows it by 7 px, and
     the body under it visibly jumps. Reserving the taller of the two here makes hover free. */
  min-height: 22px;
  color: var(--_muted);
  font-size: 11px;
  line-height: 15px;
  letter-spacing: 0.006em;
}
.cc-author { color: var(--_accent); }
/* \`.cc-time\` is now permanent, so tabular figures are load-bearing: a re-tick between two
   relative labels of different widths must not reflow the row (§4). */
.cc-time { font-variant-numeric: tabular-nums; white-space: nowrap; }
.cc-edited { color: var(--_muted); opacity: .7; }

/* §0 D3 — one right-aligned actions cluster per comment row. Mounted at all times so keyboard
   and AT reach it; \`position: absolute → relative\` swaps WITH the opacity, which is what stops
   the row from reflowing on hover. Transition: opacity only. */
.cc-comment-actions {
  position: absolute;
  inset-inline-end: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--_d1) var(--_ease-std);
}
.cc-comment:hover .cc-comment-actions,
.cc-comment:focus-within .cc-comment-actions,
.cc-comment-actions:has([data-confirm='true']) {
  position: relative;
  margin-inline-start: auto;
  opacity: 1;
}
/* The cluster owns the reveal (§0 D3), so its buttons must not ALSO carry \`.cc-ghost\`'s own
   \`opacity: 0\` — nothing in the sheet lifts that for a comment row (\`.cc-row\` is the panel,
   \`.cc-corner\` is the thread), and 0 × 1 left the pencil invisible even on hover, which is not
   "discreet", it is absent. */
.cc-comment-actions .cc-ghost { width: 22px; height: 22px; opacity: 1; }

.cc-body { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 19px; }
.cc-edit { display: flex; flex-direction: column; gap: 4px; }
.cc-edit .cc-composer-input { min-height: 44px; }
.cc-row-actions { display: flex; align-items: center; gap: 4px; }

/* §7 row 29 / §0 D4 — the permanently rendered, collapsed reply field at the thread's bottom
   edge, above a \`--_line-sep\` hairline. Focus expands it IN PLACE into the full composer; the
   popover grows downward as one sheet. Never a side panel, never a second floating surface. */
.cc-thread-foot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 8px;
  box-shadow: inset 0 .5px 0 var(--_line-sep);
}
.cc-reply {
  display: flex;
  align-items: center;
  width: 100%;
  min-height: 32px;
  padding: 0 8px;
  border: 0;
  border-radius: var(--_r-sm);
  background: color-mix(in oklab, var(--_surface-2) 55%, transparent);
  color: var(--_muted);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: text;
}
.cc-reply:hover { color: var(--_text); }
.cc-reply:focus-visible { outline: none; box-shadow: var(--_focus); }
.cc-reply-label { overflow: hidden; white-space: nowrap; }
.cc-reply-slot:empty { display: none; }

/* -------------------------------------------------------------------------------- panel */

.cc-seed {
  position: fixed;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 30px; height: 30px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--_r-pill);
  background: transparent;
  color: var(--_muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: scale var(--_d1) var(--_spring-1);
}
/* Zero threads is zero pixels. Discoverability is a moment, not a permanent tax. */
.cc-seed[data-count='zero'] { opacity: 0; pointer-events: none; }
.cc-seed::before {
  content: '';
  position: absolute;
  left: 50%; top: 50%;
  width: 8px; height: 8px;
  margin: -4px 0 0 -4px;
  border-radius: var(--_r-pill);
  background: var(--_muted);
  opacity: .4;
  transition: opacity var(--_d2) var(--_ease-std);
}
.cc-seed::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: var(--_r-pill);
  background: var(--_glass-bg);
  backdrop-filter: var(--_glass-fx);
  -webkit-backdrop-filter: var(--_glass-fx);
  box-shadow: var(--_e2);
  opacity: 0;
  scale: .7;
  transition: opacity var(--_d2) var(--_ease-std), scale var(--_d2) var(--_spring-1);
}
.cc-seed > * { position: relative; z-index: 1; max-width: 0; overflow: hidden; opacity: 0; transition: max-width var(--_d2) var(--_spring-1), opacity var(--_d1) var(--_ease-std); }
.cc-seed-count { font-variant-numeric: tabular-nums; }
.cc-seed[data-near='true']::after, .cc-seed:hover::after, .cc-seed:focus-visible::after,
.cc-seed[aria-expanded='true']::after { opacity: 1; scale: 1; }
.cc-seed[data-near='true']::before, .cc-seed:hover::before, .cc-seed:focus-visible::before,
.cc-seed[aria-expanded='true']::before { opacity: 0; }
.cc-seed[data-near='true'] > *, .cc-seed:hover > *, .cc-seed:focus-visible > *,
.cc-seed[aria-expanded='true'] > * { max-width: 3ch; opacity: 1; }
.cc-seed:hover, .cc-seed:focus-visible { scale: 1.133; }
.cc-seed:focus-visible { outline: none; }
.cc-seed:focus-visible::after { box-shadow: var(--_focus), var(--_e2); }
@media (hover: none) {
  .cc-seed::after { opacity: 1; scale: 1; }
  .cc-seed::before { opacity: 0; }
  .cc-seed > * { max-width: 3ch; opacity: 1; }
}

.cc-panel {
  position: fixed;
  display: none;
  flex-direction: column;
  gap: 8px;
  width: 300px;
  max-width: calc(100vw - 24px);
  max-height: min(62vh, 540px);
  padding: 10px;
  border-radius: var(--_r-xl);
  color: var(--_text);
  box-shadow: var(--_e3);
  font-size: 13px;
  overflow-y: auto;
  overscroll-behavior: contain;
  scrollbar-width: none;
  transition: translate var(--_d4) var(--_spring-1), clip-path var(--_d4) var(--_spring-1);
  animation: cc-emerge var(--_d4) var(--_spring-1);
}
.cc-panel::-webkit-scrollbar { display: none; }
.cc-panel[data-open='true'] { display: flex; }
/* Rail mode (§8.5, amendment A2): a popover makes attention singular without costing the panel
   its state. The sheet slides out AND is clipped to the 44 px that remain, so what is left is a
   rail with its own rounded corners rather than a 300 px slab hanging half off the right edge of
   the viewport — which is what "translate and fade the content" produced in a browser, and it
   reads as a rendering bug rather than as a design. \`clip-path\` is on §6.3's animate list, so the
   clip travels with the slide on the compositor. */
.cc-panel[data-rail='true'] {
  translate: calc(100% - 44px) 0;
  clip-path: inset(0 calc(100% - 44px) 0 0 round var(--_r-xl));
  overflow: hidden;
}
.cc-panel[data-rail='true']:hover {
  translate: 0 0;
  clip-path: inset(0 round var(--_r-xl));
}
.cc-panel[data-rail='true'] .cc-panel-head, .cc-panel[data-rail='true'] .cc-section {
  opacity: 0;
  transition: opacity 200ms var(--_ease-exit);
}
.cc-panel[data-rail='true']:hover .cc-panel-head, .cc-panel[data-rail='true']:hover .cc-section { opacity: 1; }

/* …and the rail is not empty: the total count over the current section's glyph, which is the
   smallest pair that says "your threads are still here, and this is the one you were reading". */
.cc-rail {
  position: absolute;
  left: 0; top: 0;
  z-index: 1;
  display: none;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 44px;
  padding: 12px 0;
  color: var(--_muted);
  opacity: 1;
  transition: opacity var(--_d2) var(--_ease-std);
}
.cc-rail-count { color: var(--_text); font-size: 12px; font-variant-numeric: tabular-nums; }
.cc-panel[data-rail='true'] .cc-rail { display: flex; }
.cc-panel[data-rail='true']:hover .cc-rail { opacity: 0; }

.cc-seed[data-corner='br'] { right: 16px; bottom: 16px; }
.cc-seed[data-corner='bl'] { left: 16px; bottom: 16px; }
.cc-seed[data-corner='tr'] { right: 16px; top: 16px; }
.cc-seed[data-corner='tl'] { left: 16px; top: 16px; }
.cc-panel[data-corner='br'] { right: 16px; bottom: 60px; }
.cc-panel[data-corner='bl'] { left: 16px; bottom: 60px; }
.cc-panel[data-corner='tr'] { right: 16px; top: 60px; }
.cc-panel[data-corner='tl'] { left: 16px; top: 60px; }
@media (max-width: 480px) {
  .cc-seed[data-corner='br'], .cc-seed[data-corner='bl'] { bottom: 12px; }
  .cc-seed[data-corner='br'], .cc-seed[data-corner='tr'] { right: 12px; }
}

.cc-panel-head { display: flex; align-items: center; gap: 6px; }
.cc-panel-title {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
.cc-section-title {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}
.cc-segmented {
  position: relative;
  display: inline-flex;
  flex: 1;
  gap: 2px;
  padding: 2px;
  border-radius: var(--_r-md);
  background: color-mix(in oklab, var(--_surface-2) 55%, transparent);
}
.cc-segment {
  display: inline-flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--_r-sm);
  background: transparent;
  color: var(--_muted);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background-color var(--_d3) var(--_spring-1), color var(--_d1) var(--_ease-std);
}
.cc-segment[aria-pressed='true'] {
  flex: 1.9;
  background: var(--_surface);
  color: var(--_text);
  box-shadow: var(--_e0);
}
.cc-segment:focus-visible { outline: none; box-shadow: var(--_focus); }
.cc-segment-count { font-variant-numeric: tabular-nums; font-size: 11px; }
/* Amendment A1 — the one noun §10 puts back, on the selected segment only. 3 unlabelled
   icon-pills in an unlabelled box is a puzzle; ten characters on the pill you are already looking
   at is the smallest thing that answers it, and it costs no public token and no \`Labels\` key. */
.cc-segment-label { display: none; overflow: hidden; white-space: nowrap; }
.cc-segment[aria-pressed='true'] .cc-segment-label { display: inline; }

.cc-section { display: none; flex-direction: column; }
.cc-section[data-current='true'] { display: flex; }
.cc-section:not([data-current='true']) { content-visibility: auto; }
.cc-rows {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  border-radius: var(--_r-md);
  background: color-mix(in oklab, var(--_surface-2) 55%, transparent);
  overflow: hidden;
}
.cc-row { display: flex; align-items: center; gap: 4px; padding-right: 6px; }
.cc-row + .cc-row { box-shadow: inset 0 .5px 0 var(--_line-sep); }
.cc-row-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--_r-md);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.cc-row-main:hover { background: var(--_accent-06); }
.cc-row-main:focus-visible { outline: none; box-shadow: var(--_focus); }
.cc-row-meta { display: flex; align-items: center; gap: 6px; color: var(--_muted); font-size: 12px; }
.cc-row-count { font-variant-numeric: tabular-nums; }
/* A mask, never text-overflow: it reads softer and it does not eat a character. */
.cc-row-body {
  white-space: nowrap;
  overflow: hidden;
  mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent);
}
.cc-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 64px;
  margin: 0;
  color: var(--_muted);
  opacity: .26;
}

/* --------------------------------------------------------------------- reduced motion */

/* An exact mapping, not "turn it off": transform keyframes are DROPPED, opacity is kept at
   100 ms, stagger is zero, and a re-anchor still blinks so the move is noticed. Durations
   collapse to 1 ms and never to 0 — the discrete transitions must still complete so exits fire. */
@media (prefers-reduced-motion: reduce) {
  :host {
    --_d1: 1ms; --_d2: 100ms; --_d3: 100ms; --_d4: 100ms;
    --_x1: 1ms; --_x2: 1ms; --_x3: 1ms; --_x4: 1ms;
    --_spring-1: linear; --_spring-2: linear; --_ease-enter: linear; --_ease-exit: linear;
  }
  .cc-composer, .cc-thread, .cc-panel { animation: cc-fade 100ms linear; }
  .cc-comment { animation: none; }
  .cc-badge[data-bloom='true']::after { animation: none; }
  .cc-pearl { animation: none; }
  .cc-badge::before, .cc-badge::after, .cc-seed::before, .cc-seed::after { transition-property: opacity; }
  .cc-badge, .cc-seed { transition: none; }
  .cc-chip[data-rung='2'] .cc-chip-mark,
  .cc-badge[data-rung='2']::after { animation: none; opacity: 1; }
  .cc-composer[data-busy='true']::after { animation: none; background: var(--_accent); }
  .cc-roll-out, .cc-roll-in { animation: none; }
}
.cc-layer[data-motion='reduce'] .cc-composer,
.cc-layer[data-motion='reduce'] .cc-thread,
.cc-layer[data-motion='reduce'] .cc-panel { animation: cc-fade 100ms linear; }
.cc-layer[data-motion='reduce'] .cc-comment,
.cc-layer[data-motion='reduce'] .cc-pearl,
.cc-layer[data-motion='reduce'] .cc-roll-out,
.cc-layer[data-motion='reduce'] .cc-roll-in,
.cc-layer[data-motion='reduce'] .cc-badge[data-rung='2']::after,
.cc-layer[data-motion='reduce'] .cc-badge[data-bloom='true']::after { animation: none; }
.cc-layer[data-motion='reduce'] .cc-badge,
.cc-layer[data-motion='reduce'] .cc-seed { transition: none; }
.cc-layer[data-motion='reduce'] .cc-chip[data-rung='2'] .cc-chip-mark { animation: none; opacity: .5; }
@keyframes cc-fade { from { opacity: 0; } }

/* ---------------------------------------------------------------------- forced colours */

@media (forced-colors: active) {
  .cc-glass, .cc-badge::after, .cc-badge::before, .cc-seed::after {
    background: Canvas;
    color: CanvasText;
    border: 1px solid CanvasText;
    backdrop-filter: none;
    box-shadow: none;
  }
  .cc-badge > *, .cc-seed > * { max-width: none; opacity: 1; }
  :focus-visible { outline: 2px solid Highlight; outline-offset: 2px; }
}
`
