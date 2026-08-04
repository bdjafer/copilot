/**
 * The `glass` stylesheet for the swarm head (DESIGN §2–§6, §8, §11).
 *
 * It is the same sheet DESIGN specifies for `comment-ui/glass`, applied to a fleet console: the
 * eleven public tokens read as `var(--cc-x, <default>)` into private `--_*` aliases and **never
 * declared on `:host`** (§13 ruling 3), the derived ramp comes out of relative colour, hairlines
 * are `box-shadow` spreads and never `border` (§3.3), glass never takes the keyline sandwich
 * (§0 D1), elevation is the four steps of §3.4, and only `opacity` / `transform` / `clip-path`
 * animate (§6.3).
 *
 * Four §0 rulings are visible in the code below rather than only in the document:
 *
 *  - **D1** — no surface declares `border`; `--_line-out` is α .10 light / .16 dark and the edge
 *    is `--_e3`'s full inset specular, not a darker outer ring.
 *  - **D2** — every metadata row (time, counts, effective config, channel) is unconditionally
 *    drawn. There is no `opacity: 0` on information anywhere in this sheet; the only hover-gated
 *    things are *actions* (`.cc-cluster`).
 *  - **D4** — the composer and the follow-up bar are permanently rendered collapsed fields at the
 *    bottom edge of their surface, expanding **in place** on focus. Never a second floating
 *    surface, never a popover on a popover.
 *  - **D6** — there is no header, no logo row and no title bar. The close and the honesty marks
 *    float as a corner cluster over a reserved gutter.
 *
 * It is a string rather than a `.css` file because the head mounts into a shadow root it owns and
 * WXT would otherwise emit a stylesheet the page has to fetch — and because the sheet is then
 * assertable: `test/swarm-design.test.ts` greps it for the two bans that matter (`border:` as a
 * declaration, and any transition or animation of `backdrop-filter`) and for the presence of the
 * three kill switches. `!important` appears exactly twice, and both must beat every author rule
 * by construction: `[hidden] { display: none }`, whose UA original loses to any class that
 * declares `display`, and `prefers-reduced-motion`, which must beat
 * every inline and component rule by construction (§6.7).
 */

export const swarmGlassStyles = `
:host {
  /* ---- §2.1 the eleven public tokens, read never declared ---- */
  --_accent: var(--cc-accent, oklch(59.6% 0.211 254));
  --_surface: var(--cc-surface, oklch(99.2% 0.002 264));
  --_surface-2: var(--cc-surface-2, oklch(96.4% 0.004 264));
  --_text: var(--cc-text, oklch(19.0% 0.012 264));
  --_muted: var(--cc-muted, oklch(55.0% 0.014 264));
  --_border: var(--cc-border, oklch(89.0% 0.005 264));
  --_danger: var(--cc-danger, oklch(58.5% 0.222 27.3));
  --_radius: var(--cc-radius, 10px);
  --_font: var(--cc-font, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI Variable Text', 'Segoe UI', Inter, system-ui, sans-serif);
  --_shadow: var(--cc-shadow, 0 0.5px 1px oklch(0% 0 0/.06), 0 8px 20px -6px oklch(0% 0 0/.14), 0 24px 56px -16px oklch(0% 0 0/.18));

  /* ---- §2.2 the derived ramp ---- */
  --_accent-hi: oklch(from var(--_accent) calc(l + 0.055) c h);
  --_accent-lo: oklch(from var(--_accent) calc(l - 0.055) c h);
  --_accent-text: oklch(from var(--_accent) calc(l - 0.10) calc(c * 0.95) h);
  --_accent-06: oklch(from var(--_accent) l c h / .06);
  --_accent-14: oklch(from var(--_accent) l c h / .14);
  --_accent-22: oklch(from var(--_accent) l c h / .22);
  --_ring: oklch(from var(--_accent) l c h / .38);
  --_on-accent: oklch(from var(--_accent) clamp(0, (0.62 - l) * 1000, 1) 0 h);
  --_danger-fill: oklch(from var(--_danger) calc(l + 0.05) c h);
  --_danger-14: oklch(from var(--_danger) l c h / .14);
  --_warn: oklch(76.0% 0.166 62.4);
  --_ok: oklch(74.5% 0.180 145.6);
  --_line-out: oklch(from var(--_text) l c h / .10);
  --_line-in: oklch(100% 0 0 / .55);
  --_line-sep: oklch(from var(--_border) l c h / .70);

  /* ---- §3.1 materials ---- */
  --_glass-bg: color-mix(in oklab, var(--_surface) 74%, transparent);
  --_glass-bg-2: color-mix(in oklab, var(--_surface-2) 78%, transparent);
  --_glass-fx: blur(28px) saturate(180%) brightness(1.02);

  /* ---- §3.4 elevation ---- */
  --_e0: 0 0 0 .5px var(--_line-out), 0 1px 2px -1px oklch(0% 0 0/.16);
  --_e1: 0 0 0 .5px var(--_line-out), 0 1px 1.5px oklch(0% 0 0/.07), 0 4px 10px -3px oklch(0% 0 0/.15);
  --_e2: 0 0 0 .5px var(--_line-out), 0 2px 4px -1px oklch(0% 0 0/.08), 0 10px 24px -8px oklch(0% 0 0/.19);
  --_e3: 0 0 0 .5px var(--_line-out), inset 0 0 0 .5px var(--_line-in), 0 1px 2px oklch(0% 0 0/.06), var(--_shadow);
  --_focus: 0 0 0 3px var(--_ring);

  /* ---- §3.5 radii, concentric ---- */
  --_r-xs: 4px; --_r-sm: 6px; --_r-md: 8px; --_r-lg: var(--_radius);
  --_r-xl: calc(var(--_r-lg) + 4px); --_r-pill: 999px;

  /* ---- §6.1–6.2 motion ---- */
  --_spring-1: linear(0, .234 10%, .589 20%, .839 30%, .967 40%, 1.012 50%, 1.020 60%, 1.014 70%, 1.007 80%, 1.003 90%, 1);
  --_spring-2: linear(0, .255 10%, .662 20%, .947 30%, 1.068 40%, 1.080 50%, 1.049 60%, 1.018 70%, .999 80%, .995 90%, .998 95%, 1);
  --_ease-enter: cubic-bezier(0.16, 1, 0.30, 1);
  --_ease-exit: cubic-bezier(0.40, 0, 0.90, 0.25);
  --_ease-std: cubic-bezier(0.32, 0.72, 0, 1);
  --_d1: 90ms; --_d2: 160ms; --_d3: 220ms; --_d4: 320ms;
  --_ambient: 3400ms;

  all: initial;
  display: block;
  font-family: var(--_font);
  font-size: 13px;
  font-synthesis: none;
  font-optical-sizing: auto;
  color: var(--_text);
  block-size: 100%;
}

@media (prefers-color-scheme: dark) {
  :host {
    --_accent: var(--cc-accent, oklch(64.2% 0.191 253));
    --_surface: var(--cc-surface, oklch(24.5% 0.012 264));
    --_surface-2: var(--cc-surface-2, oklch(29.0% 0.013 264));
    --_text: var(--cc-text, oklch(96.0% 0.004 264));
    --_muted: var(--cc-muted, oklch(70.5% 0.012 264));
    --_border: var(--cc-border, oklch(38.0% 0.012 264));
    --_danger: var(--cc-danger, oklch(66.0% 0.214 28));
    --_shadow: var(--cc-shadow, 0 0.5px 1px oklch(0% 0 0/.5), 0 10px 22px -8px oklch(0% 0 0/.55), 0 28px 64px -20px oklch(0% 0 0/.72));
    /* §0 D1: dark keeps the same black shadows and lifts the surface — the ring never thickens. */
    --_line-out: oklch(0% 0 0 / .16);
    --_line-in: oklch(100% 0 0 / .10);
    --_glass-bg: color-mix(in oklab, var(--_surface) 64%, transparent);
    --_glass-fx: blur(28px) saturate(170%) brightness(0.86);
    -webkit-font-smoothing: antialiased;
  }
}

/* §2.2 fallback: relative colour is the keystone, so its absence is handled once, explicitly. */
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
    --_danger-14: color-mix(in oklab, var(--_danger) 14%, transparent);
  }
}

/* §3.2 the three kill switches — hardcoded, no host opt-out. */
@media (prefers-reduced-transparency: reduce) { :host { --_glass-bg: var(--_surface); --_glass-fx: none } }
@media (prefers-contrast: more) {
  :host { --_glass-bg: var(--_surface); --_glass-fx: none; --_line-out: oklch(from var(--_text) l c h / .38) }
}
@supports not (backdrop-filter: blur(1px)) { :host { --_glass-bg: var(--_surface) } }
@media (forced-colors: active) {
  /* The ONE sanctioned border in the whole sheet (§3.2): forced colours drop every shadow, so a
     surface whose entire edge is elevation would have no edge at all. */
  .cc-glass { background: Canvas; color: CanvasText; border: 1px solid CanvasText;
              backdrop-filter: none; box-shadow: none }
  :focus-visible { outline: 2px solid Highlight; outline-offset: 2px }
}

*, *::before, *::after { box-sizing: border-box }

/*
 * "hidden" must actually hide. The UA sheet's [hidden] rule has specificity 0-1-0, so EVERY author
 * class rule below that declares display beat it: .cc-pair, .cc-app, .cc-detail, .cc-lagged,
 * .cc-notices, .cc-background, .cc-empty, .cc-metric, .cc-compose-row and .cc-btn all do. Without
 * this rule, setAttr(el, 'hidden', '') set an attribute and changed nothing on screen — the
 * pairing card and the fleet drew simultaneously in both directions, the empty detail pane painted
 * unpopulated frames, the "lagged" banner never went away, and the fixed notice stack kept its
 * footprint with nothing in it. Four of the open questions in bench/ux-shots/swarm/README.md were
 * this one missing rule; the surface tests could not see it because they assert the attribute,
 * never the effect.
 *
 * !important because the class rules it must beat are more specific by construction, and appending
 * [hidden] to each of them is a list that goes stale the first time a class is added.
 * packages/extension/src/content/pill.ts carries the same rule for the same reason.
 */
[hidden] { display: none !important }

.cc-glass {
  background: var(--_glass-bg);
  backdrop-filter: var(--_glass-fx);
  -webkit-backdrop-filter: var(--_glass-fx);
  contain: layout style paint;
  box-shadow: var(--_e3);
  border-radius: var(--_r-xl);
}

/* ---- §4 type ---- */
.cc-t10 { font-size: 10px; line-height: 13px; letter-spacing: .01em; font-weight: 500 }
.cc-t11 { font-size: 11px; line-height: 15px; letter-spacing: .006em; font-weight: 500 }
.cc-t12 { font-size: 12px; line-height: 16px; letter-spacing: .003em; font-weight: 500 }
.cc-t13 { font-size: 13px; line-height: 19px; font-weight: 400 }
.cc-t15 { font-size: 15px; line-height: 21px; letter-spacing: -.006em; font-weight: 400 }
.cc-t17 { font-size: 17px; line-height: 23px; letter-spacing: -.012em; font-weight: 600 }
.cc-num { font-variant-numeric: tabular-nums }
.cc-muted { color: var(--_muted) }
.cc-section-title {
  font-size: 11px; line-height: 15px; letter-spacing: .06em; font-weight: 500;
  text-transform: uppercase; color: var(--_muted);
}

/* ---- controls ---- */
.cc-icon { fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; vector-effect: non-scaling-stroke }

.cc-btn {
  position: relative; display: inline-grid; place-items: center;
  inline-size: 26px; block-size: 26px; padding: 0;
  border: 0; background: transparent; color: var(--_text);
  border-radius: var(--_r-sm); cursor: pointer; opacity: .72;
  transition: opacity var(--_d1) var(--_ease-std), background-color var(--_d1) var(--_ease-std);
}
/* §3.6: ≥44px of hit area, never via visual size. */
.cc-btn::after { content: ''; position: absolute; inset: -9px }
.cc-btn:hover { opacity: 1; background: var(--_accent-06) }
.cc-btn:focus-visible { outline: none; opacity: 1; box-shadow: var(--_focus) }
.cc-btn[aria-disabled='true'] { opacity: .3; cursor: default }
.cc-btn[aria-disabled='true']:hover { background: transparent }
/* §6.4 arm — the armed state is a SHAPE (a ring), not only a colour. */
.cc-btn[data-confirm] {
  color: var(--_danger); background: var(--_danger-14);
  box-shadow: 0 0 0 1.5px var(--_danger);
}
.cc-btn[data-tone='accent'] { color: var(--_accent-text) }

.cc-disc {
  inline-size: 26px; block-size: 26px; border-radius: var(--_r-pill);
  background: var(--_accent); color: var(--_on-accent); opacity: .26;
  transition: opacity var(--_d2) var(--_spring-2), scale var(--_d2) var(--_spring-2);
}
.cc-disc[data-ready='1'] { opacity: 1 }
.cc-disc:hover { background: var(--_accent-hi) }

/* segmented picker — values, never verbs (§10): the effort ladder and the delivery modes. */
.cc-seg { display: flex; gap: 2px; padding: 2px; border-radius: var(--_r-sm); background: var(--_accent-06) }
.cc-seg > button {
  font: inherit; font-size: 11px; line-height: 15px; font-weight: 500;
  padding: 2px 7px; border: 0; border-radius: var(--_r-xs);
  background: transparent; color: var(--_muted); cursor: pointer;
  transition: color var(--_d1) var(--_ease-std), background-color var(--_d1) var(--_ease-std);
}
.cc-seg > button[aria-pressed='true'] { background: var(--_accent); color: var(--_on-accent) }
.cc-seg > button:focus-visible { outline: none; box-shadow: var(--_focus) }
.cc-seg[data-locked='1'] { opacity: .4 }
.cc-seg[data-locked='1'] > button { cursor: default }

/* §8.8's 30×18 switch: one node + ::before, 14px thumb. Booleans are switches, not glyphs. */
.cc-switch {
  position: relative; inline-size: 30px; block-size: 18px; padding: 0; flex: none;
  border: 0; border-radius: var(--_r-pill); cursor: pointer;
  background: var(--_line-sep); box-shadow: var(--_e0);
  transition: background-color var(--_d2) var(--_ease-std);
}
.cc-switch::before {
  content: ''; position: absolute; inset-block-start: 2px; inset-inline-start: 2px;
  inline-size: 14px; block-size: 14px; border-radius: var(--_r-pill);
  background: var(--_surface); box-shadow: var(--_e0);
  transition: translate var(--_d2) var(--_ease-std);
}
.cc-switch[aria-checked='true'] { background: var(--_accent) }
.cc-switch[aria-checked='true']::before { translate: 12px 0 }
.cc-switch:focus-visible { outline: none; box-shadow: var(--_focus) }

.cc-field {
  inline-size: 100%; padding: 6px 8px; font: inherit; font-size: 13px; line-height: 19px;
  color: var(--_text); background: var(--_surface-2); border: 0; border-radius: var(--_r-md);
  box-shadow: var(--_e0);
}
.cc-field:focus-visible { outline: none; box-shadow: var(--_focus), var(--_e0) }
textarea.cc-field { resize: none; min-block-size: 32px; max-block-size: 168px }
select.cc-field { padding-block: 5px }

/* ---- layout: two planes, no header (§0 D6) ---- */
.cc-app { display: grid; grid-template-columns: minmax(300px, 360px) 1fr; gap: 12px; block-size: 100%; padding: 12px }
.cc-app[data-detail='0'] { grid-template-columns: minmax(300px, 420px) 1fr }
.cc-col { min-block-size: 0; display: flex; flex-direction: column; gap: 10px }

/* the fleet strip: a floating cluster, not a header bar. */
.cc-strip {
  display: flex; align-items: center; gap: 10px; padding: 8px 10px;
  background: var(--_glass-bg); backdrop-filter: var(--_glass-fx); -webkit-backdrop-filter: var(--_glass-fx);
  box-shadow: var(--_e2); border-radius: var(--_r-lg); contain: layout style paint;
}
.cc-strip-metrics { display: flex; align-items: center; gap: 10px; flex: 1; min-inline-size: 0; flex-wrap: wrap }
.cc-metric { display: inline-flex; align-items: baseline; gap: 4px; color: var(--_muted) }
.cc-metric > b { font-weight: 590; color: var(--_text) }
.cc-dot { inline-size: 8px; block-size: 8px; border-radius: var(--_r-pill); background: var(--_muted); flex: none }
.cc-dot[data-ok='1'] { background: var(--_ok) }
.cc-dot[data-ok='0'] { background: var(--_warn) }

/* ---- fleet list: macOS inset grouped lists (§8.5) ---- */
.cc-fleet { overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; flex: 1; min-block-size: 0 }
.cc-bucket + .cc-bucket { margin-block-start: 14px }
.cc-bucket-head { display: flex; align-items: baseline; gap: 6px; padding: 0 10px 6px }
.cc-bucket-card { background: color-mix(in oklab, var(--_surface-2) 55%, transparent); border-radius: var(--_r-lg); box-shadow: var(--_e0) }
.cc-row {
  display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; align-items: center;
  padding: 8px 10px; cursor: pointer; position: relative;
  transition: background-color var(--_d1) var(--_ease-std);
}
.cc-row + .cc-row { box-shadow: inset 0 .5px 0 var(--_line-sep) }
.cc-row:hover { background: var(--_accent-06) }
.cc-row[aria-current='true'] { background: var(--_accent-14) }
.cc-row:focus-visible { outline: none; box-shadow: var(--_focus) }
.cc-row-title { grid-column: 1; min-inline-size: 0; overflow: hidden; white-space: nowrap; mask-image: linear-gradient(90deg, #000 calc(100% - 24px), transparent) }
/* §0 D2: the row's metadata is permanent — never a hover gate, never a breakpoint drop. */
.cc-row-meta { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; color: var(--_muted); flex-wrap: wrap }
.cc-row-now { min-inline-size: 0; overflow: hidden; white-space: nowrap; mask-image: linear-gradient(90deg, #000 calc(100% - 16px), transparent) }
.cc-badge { padding: 1px 6px; border-radius: var(--_r-xs); background: var(--_accent-14); color: var(--_accent-text) }
.cc-badge[data-tone='warn'] { background: color-mix(in oklab, var(--_warn) 22%, transparent); color: inherit }
.cc-badge[data-tone='danger'] { background: var(--_danger-14); color: var(--_danger) }
.cc-empty { display: grid; place-items: center; gap: 8px; padding: 64px 0; opacity: .26 }

/* ---- detail sheet ---- */
.cc-detail { position: relative; display: flex; flex-direction: column; min-block-size: 0; flex: 1; padding: 10px; gap: 8px }
/* §0 D6: the corner cluster floats over a reserved gutter so no text runs under it. */
.cc-corner { position: absolute; inset-block-start: 8px; inset-inline-end: 8px; display: flex; gap: 2px; z-index: 2 }
.cc-corner .cc-btn { opacity: .55 }
.cc-detail:hover .cc-corner .cc-btn, .cc-corner .cc-btn:focus-visible { opacity: 1 }
.cc-objective { padding-inline-end: 84px; white-space: pre-wrap; overflow-wrap: anywhere }
.cc-meta-grid { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--_muted) }
.cc-panel { background: color-mix(in oklab, var(--_surface-2) 55%, transparent); border-radius: var(--_r-lg); box-shadow: var(--_e0); padding: 8px 10px }
.cc-panel + .cc-panel { margin-block-start: 8px }
.cc-scroll { overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; min-block-size: 0; flex: 1 }
.cc-line { display: flex; align-items: center; gap: 8px; padding: 4px 0 }
.cc-line + .cc-line { box-shadow: inset 0 .5px 0 var(--_line-sep) }
.cc-grow { flex: 1; min-inline-size: 0 }
.cc-mark { flex: none; opacity: .8 }
.cc-mark[data-status='pass'] { color: var(--_ok) }
.cc-mark[data-status='fail'], .cc-mark[data-status='error'] { color: var(--_warn) }
.cc-cluster { display: flex; gap: 2px; flex: none }

/* attempt rows carry their own selection state; the timeline is a list, not a tab bar. */
.cc-attempt[aria-current='true'] { background: var(--_accent-06); border-radius: var(--_r-sm) }

/* ---- transcript (W1, W2, W11, W12) ---- */
.cc-transcript { display: flex; flex-direction: column; gap: 2px; padding-block: 4px }
.cc-entry { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; padding: 3px 0 }
.cc-entry-head { grid-column: 1 / -1; display: flex; align-items: center; gap: 6px; color: var(--_muted) }
.cc-entry-body { grid-column: 1 / -1; white-space: pre-wrap; overflow-wrap: anywhere }
.cc-entry[data-k='user'] .cc-entry-body { box-shadow: inset 2px 0 0 var(--_accent); padding-inline-start: 8px }
.cc-entry[data-k='reasoning'] > summary { list-style: none; cursor: pointer; color: var(--_muted) }
.cc-entry[data-k='reasoning'] > summary::-webkit-details-marker { display: none }
.cc-entry[data-k='tool'] { grid-template-columns: auto 1fr auto }
.cc-tool-out { grid-column: 1 / -1; color: var(--_muted); white-space: pre-wrap; overflow-wrap: anywhere; max-block-size: 132px; overflow: hidden; mask-image: linear-gradient(#000 calc(100% - 20px), transparent) }
/* W11: background progress is its own plane and never merges into the transcript. */
.cc-background { display: flex; align-items: center; gap: 8px; color: var(--_muted) }
.cc-bar { block-size: 2px; border-radius: var(--_r-pill); background: var(--_accent); transform-origin: left center }
.cc-lagged { color: var(--_warn); display: flex; align-items: center; gap: 6px }

/* ---- composer + follow-up (§0 D4): collapsed at rest, expanding IN PLACE ---- */
.cc-compose { box-shadow: inset 0 .5px 0 var(--_line-sep); padding-block-start: 8px; margin-block-start: 4px }
.cc-compose-row { display: flex; align-items: flex-end; gap: 8px }
.cc-compose-more { display: none; flex-direction: column; gap: 8px; padding-block-start: 8px }
.cc-compose[data-open='1'] .cc-compose-more { display: flex }
.cc-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding-block-end: 6px }
.cc-hint { color: var(--_muted); opacity: .8 }
.cc-crit { display: flex; gap: 6px; align-items: center }
.cc-crit + .cc-crit { margin-block-start: 6px }

/* ---- notices, confirmations (§6.7) ---- */
.cc-notices { position: fixed; inset-block-end: 12px; inset-inline-end: 12px; display: flex; flex-direction: column; gap: 8px; max-inline-size: 380px; z-index: 3 }
.cc-notice {
  display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px;
  background: var(--_glass-bg); backdrop-filter: var(--_glass-fx); -webkit-backdrop-filter: var(--_glass-fx);
  box-shadow: var(--_e2); border-radius: var(--_r-lg); contain: layout style paint;
}
.cc-notice[data-severity='warn'] { box-shadow: var(--_e2), inset 2px 0 0 var(--_warn) }
.cc-notice[data-severity='error'] { box-shadow: var(--_e2), inset 2px 0 0 var(--_danger) }
.cc-confirm { display: flex; flex-direction: column; gap: 6px; padding: 10px; box-shadow: var(--_e2), inset 2px 0 0 var(--_accent); border-radius: var(--_r-lg); background: var(--_glass-bg-2) }

/* ---- pairing (§2.1) ---- */
.cc-pair { display: grid; place-items: center; block-size: 100%; padding: 24px }
.cc-pair-card { display: flex; flex-direction: column; gap: 10px; inline-size: 360px; padding: 16px }
.cc-pair-row { display: flex; gap: 8px; align-items: center }
.cc-error { color: var(--_danger) }

/* §6.4 breathe: a copilot/agent that is working says "I'm here", never "wait" — no rotation. */
@keyframes cc-breathe { 0%, 100% { opacity: .35 } 50% { opacity: .7 } }
.cc-live { animation: cc-breathe var(--_ambient) var(--_ease-std) infinite }

/* §6.7 reduced motion: an exact mapping, not "turn it off". */
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 1ms !important; animation-duration: 1ms !important; animation-iteration-count: 1 !important }
  .cc-live { animation: none; opacity: .5 }
}
`
