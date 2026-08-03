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
  --_line-out: oklch(0% 0 0 / .58);
  --_line-in: oklch(100% 0 0 / .09);
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
  --_line-out: oklch(from var(--_text) l c h / .13);
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
  --_badge-size: var(--cc-badge-size, 22px);
  --_radius: var(--cc-radius, 10px);
  /* One width for the popover and for the reply composer that docks under it: §7's mutual
     exclusion asks for one sheet growing downward, and two numbers cannot promise that. */
  --_w-thread: 320px;

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
  --_wash: color-mix(in oklab, var(--_surface) 26%, transparent);

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
  --_e3: 0 0 0 .5px var(--_line-out), inset 0 .5px 0 var(--_line-in), 0 1px 2px oklch(0% 0 0/.06), var(--_shadow);
  --_focus: 0 0 0 3px var(--_ring);
  /* The keyline sandwich: a dark hairline outside, a light hairline inside. One hairline is
     invisible on half the web; two are visible on all of it. */
  --_keyline: 0 0 0 .5px oklch(0% 0 0/.28), 0 0 0 1.75px oklch(100% 0 0/.55);

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
    --_line-out: color-mix(in oklab, var(--_text) 13%, transparent);
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
/* Non-interactive overlays. The pick surfaces sit directly on the cursor's path into the
   candidate, and the engine resolves the target from composedPath()[0] without filtering shadow
   trees — an \`auto\` here would anchor the thread on our own overlay. */
.cc-scrim, .cc-ring, .cc-pick-hint, .cc-cursor, .cc-status { pointer-events: none; }
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
.cc-icon { width: 16px; height: 16px; }
.cc-badge-icon, .cc-chip-mark { width: 12px; height: 12px; }
.cc-mark { width: 10px; height: 10px; }
.cc-row-icon { width: 12px; height: 12px; }
.cc-head-icon { width: 14px; height: 14px; }
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
   declaration would bake index 0's offset into every mode. Colour is a hint here and nothing
   more; every mode also has its own glyph, which is what keeps §1.3 true under \`forced-colors\`,
   in a screenshot and for a colour-blind reader.

   The offset is a **plain number**: inside relative colour syntax \`h\` resolves to a \`<number>\`,
   so \`calc(h + 38deg)\` is a type error — the declaration is invalid at computed-value time, the
   fill resolves to \`transparent\`, and every badge on the page turns into a hollow ring. */
.cc-badge, .cc-thread, .cc-composer, .cc-pearl, .cc-ring, .cc-cursor {
  --_kind: oklch(from var(--_accent) l c calc(h + var(--_kind-h, 0)));
}
@supports not (color: oklch(from red l c h)) {
  .cc-badge, .cc-thread, .cc-composer, .cc-pearl, .cc-ring, .cc-cursor { --_kind: var(--_accent); }
}

/* ------------------------------------------------------------------------------- badges */

.cc-badge {
  position: fixed;
  top: 0; left: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  height: var(--_badge-size);
  min-width: var(--_badge-size);
  padding: 0 5px;
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
  transition: translate var(--_d2) var(--_spring-1), opacity var(--_d2) var(--_ease-std);
}
/* The resting mark: a 12 px dot, at .72, wearing the keyline sandwich so it stays visible on
   white, on black, on a photograph and on a saturated hero. */
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
/* The revealed pill, a separate layer so the box itself never animates a layout property. */
.cc-badge::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: var(--_r-pill);
  background: var(--_kind);
  box-shadow: var(--_keyline), var(--_e1);
  opacity: 0;
  scale: .7;
  transform-origin: var(--_o, 100% 0%);
  transition: opacity var(--_d2) var(--_ease-std), scale var(--_d2) var(--_spring-1);
}
.cc-badge > * { position: relative; z-index: 1; }
.cc-badge-icon, .cc-badge-glyph, .cc-badge-count, .cc-badge-marks, .cc-badge .cc-chip-slot {
  display: inline-flex;
  align-items: center;
  max-width: 0;
  overflow: hidden;
  opacity: 0;
  transition: max-width var(--_d2) var(--_spring-1), opacity var(--_d1) var(--_ease-std);
}
.cc-badge-icon[data-on='true'] { display: block; }
.cc-badge-count { font-variant-numeric: tabular-nums; }

/* §8.1: transform-origin follows the positioner's resolved placement, so a badge grows out of
   its anchor rather than out of itself, and never over the element it annotates. */
.cc-badge[data-placement^='top'] { --_o: 100% 100%; }
.cc-badge[data-placement^='bottom'] { --_o: 100% 0%; }
.cc-badge[data-placement^='left'] { --_o: 100% 50%; }
.cc-badge[data-placement^='right'] { --_o: 0% 50%; }

/* The reveal, and every one of its five signals. Remove any one of them and the dormant badge
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
[data-reveal-all='true'] .cc-badge > * { max-width: 2.4ch; opacity: 1; }
.cc-badge:hover, .cc-badge:focus-visible, .cc-badge[data-near='true'] { translate: 0 -1px; }
@media (hover: none) {
  .cc-badge::after { opacity: 1; scale: 1; }
  .cc-badge::before { opacity: 0; }
  .cc-badge > * { max-width: 2.4ch; opacity: 1; }
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
.cc-badge[data-docked='true'] > * { max-width: 2.4ch; opacity: 1; }
.cc-badge[data-docked='true'] { color: var(--_muted); }
.cc-badge[data-docked='true']::before,
.cc-badge[data-docked='true']::after {
  background: var(--_surface-2);
  border: 1.5px dashed var(--_muted);
  box-shadow: var(--_keyline), var(--_e1);
}

.cc-badge:focus-visible { outline: none; }
.cc-badge:focus-visible::after { box-shadow: var(--_keyline), var(--_focus), var(--_e1); }

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

/* ----------------------------------------------------------------------------- the picker */

.cc-scrim {
  position: fixed;
  inset: 0;
  background: var(--_wash);
  backdrop-filter: saturate(.75) brightness(.985);
  -webkit-backdrop-filter: saturate(.75) brightness(.985);
  /* The hole IS the highlight: one evenodd path, the viewport minus the candidate. */
  clip-path: polygon(evenodd,
    0 0, 100% 0, 100% 100%, 0 100%, 0 0,
    var(--_hx) var(--_hy),
    var(--_hx) calc(var(--_hy) + var(--_hh)),
    calc(var(--_hx) + var(--_hw)) calc(var(--_hy) + var(--_hh)),
    calc(var(--_hx) + var(--_hw)) var(--_hy),
    var(--_hx) var(--_hy));
}
.cc-layer[data-picking='true'] .cc-badge { opacity: .25; filter: saturate(.35); }
.cc-ring {
  position: fixed;
  top: 0; left: 0;
  border-radius: var(--_r-sm);
  box-shadow: 0 0 0 1.5px var(--_kind), inset 0 0 0 1px oklch(100% 0 0/.6);
  contain: layout size paint;
  /* Snap: the outline slides between candidates. One instrument scanning, not twelve boxes
     flickering. */
  transition: translate var(--_d1) var(--_ease-std), width var(--_d1) var(--_ease-std),
              height var(--_d1) var(--_ease-std), opacity var(--_d1) var(--_ease-std);
}
.cc-ring[data-bad='true'] { opacity: .3; }
.cc-ring[data-bad='true'] .cc-tick { opacity: 0; }
.cc-tick {
  position: absolute;
  width: 6px; height: 6px;
  border: 1.5px solid var(--_kind);
}
.cc-tick[data-corner='tl'] { top: -3px; left: -3px; border-width: 1.5px 0 0 1.5px; }
.cc-tick[data-corner='tr'] { top: -3px; right: -3px; border-width: 1.5px 1.5px 0 0; }
.cc-tick[data-corner='bl'] { bottom: -3px; left: -3px; border-width: 0 0 1.5px 1.5px; }
.cc-tick[data-corner='br'] { bottom: -3px; right: -3px; border-width: 0 1.5px 1.5px 0; }
/* §7 row 19 rations the hint and gives it a rise; it never said where it lives, and riding the
   candidate was the wrong answer twice over — it covered the line ABOVE the target (the one the
   eye is using to decide), and a session opened from the keyboard with the pointer at rest left
   it at 0,0, clipped under whatever the host page puts in its own top-left. One fixed slot for
   the whole session: the eye learns it once, and it never covers a candidate. */
.cc-pick-hint {
  position: fixed;
  left: 50%;
  bottom: 24px;
  padding: 4px 8px;
  border-radius: var(--_r-sm);
  box-shadow: var(--_e2);
  color: var(--_text);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.006em;
  white-space: nowrap;
  translate: -50% 0;
  animation: cc-rise var(--_d2) var(--_spring-1);
}
@keyframes cc-rise { from { translate: -50% 4px; opacity: 0; } }
.cc-cursor {
  position: fixed;
  top: 0; left: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}
.cc-cursor .cc-icon {
  width: 20px; height: 20px;
  padding: 3px;
  border-radius: var(--_r-pill);
  background: var(--_kind);
  color: var(--_on-accent);
  box-shadow: var(--_e2);
}
.cc-cursor-esc { font-size: 10px; opacity: .4; }

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
/* §7's mutual exclusion, drawn: "a reply docks the composer to the popover's bottom edge and
   matches its width, so reply reads as one sheet growing downward". The controller docks it with
   a zero offset; this is the other half — the same width, and a flush top edge, so there is no
   seam where the two boxes meet. Positioned against the badge instead, it opened as a second
   sheet BESIDE the popover, over its own close control, clipped at the viewport edge. */
.cc-composer[data-reply] {
  width: var(--_w-thread);
  border-top-left-radius: 0;
  border-top-right-radius: 0;
}
/* …and when the popover is near the bottom of the viewport the positioner flips the reply above
   it, so the flush edge flips too. \`data-placement\` is the controller's (§3.1.5) — the sheet only
   has to know which edge is the seam. */
.cc-composer[data-reply][data-placement^='top'] {
  border-top-left-radius: var(--_r-xl);
  border-top-right-radius: var(--_r-xl);
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
}
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
.cc-head { display: flex; align-items: center; gap: 6px; }
.cc-head-icon { color: var(--_kind); }
/* §8.4: resolved is a SILHOUETTE, not a tint. The head glyph moves inside the hollow disc the
   badge draws for the same state, the check rides beside it as a 10 px mark, and the bodies mute
   — so a screenshot of a resolved thread says "resolved" with no colour, no motion and no word.
   Before this the only response in the whole sheet was one \`color\` swap on a 14 px glyph. */
.cc-thread[data-resolved='true'] .cc-head-icon {
  width: 20px; height: 20px;
  padding: 3px;
  border-radius: var(--_r-pill);
  color: var(--_muted);
  box-shadow: inset 0 0 0 1.5px var(--_muted);
}
.cc-thread[data-resolved='true'] .cc-body,
.cc-thread[data-resolved='true'] .cc-quote { color: var(--_muted); }
.cc-thread[data-status='resolved'] .cc-head-icon { color: var(--_muted); }
.cc-badge-marks { display: inline-flex; align-items: center; gap: 3px; color: var(--_muted); }
.cc-head .cc-chip-slot { margin-left: auto; }

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
.cc-thread:hover .cc-ghost,
.cc-thread:focus-within .cc-ghost,
.cc-comment:hover .cc-ghost,
.cc-row:hover .cc-ghost,
.cc-row:focus-within .cc-ghost,
.cc-panel:focus-within .cc-ghost { opacity: 1; }
.cc-head .cc-ghost { opacity: .4; }
.cc-thread:hover .cc-head .cc-ghost, .cc-thread:focus-within .cc-head .cc-ghost { opacity: 1; }
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
.cc-comment-head { display: flex; align-items: center; gap: 6px; color: var(--_muted); font-size: 11px; }
.cc-author { width: 12px; height: 12px; color: var(--_muted); }
.cc-author[data-author='copilot'] { color: var(--_accent); }
/* A timestamp is a 3 px dot until the row is hovered, then a value the platform translates. */
.cc-time { font-variant-numeric: tabular-nums; max-width: 0; overflow: hidden; white-space: nowrap; transition: max-width var(--_d2) var(--_ease-std); }
.cc-comment:hover .cc-time, .cc-comment:focus-within .cc-time { max-width: 12ch; }
.cc-comment-head::before {
  content: '';
  width: 3px; height: 3px;
  border-radius: var(--_r-pill);
  background: currentColor;
  opacity: .5;
  order: 1;
}
.cc-body { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 19px; }
.cc-edit { display: flex; flex-direction: column; gap: 4px; }
.cc-edit .cc-composer-input { min-height: 44px; }
.cc-thread-actions { display: flex; align-items: center; gap: 4px; justify-content: flex-end; }
.cc-row-actions { display: flex; align-items: center; gap: 4px; }

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
  .cc-pearl, .cc-pick-hint { animation: none; }
  .cc-badge::before, .cc-badge::after, .cc-seed::before, .cc-seed::after { transition-property: opacity; }
  .cc-badge, .cc-seed { transition: none; }
  .cc-ring { transition: none; }
  .cc-chip[data-rung='2'] .cc-chip-mark { animation: none; opacity: .5; }
  .cc-composer[data-busy='true']::after { animation: none; background: var(--_accent); }
  .cc-roll-out, .cc-roll-in { animation: none; }
}
.cc-layer[data-motion='reduce'] .cc-composer,
.cc-layer[data-motion='reduce'] .cc-thread,
.cc-layer[data-motion='reduce'] .cc-panel { animation: cc-fade 100ms linear; }
.cc-layer[data-motion='reduce'] .cc-comment,
.cc-layer[data-motion='reduce'] .cc-pearl,
.cc-layer[data-motion='reduce'] .cc-pick-hint,
.cc-layer[data-motion='reduce'] .cc-roll-out,
.cc-layer[data-motion='reduce'] .cc-roll-in,
.cc-layer[data-motion='reduce'] .cc-badge[data-bloom='true']::after { animation: none; }
.cc-layer[data-motion='reduce'] .cc-badge,
.cc-layer[data-motion='reduce'] .cc-seed,
.cc-layer[data-motion='reduce'] .cc-ring { transition: none; }
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
