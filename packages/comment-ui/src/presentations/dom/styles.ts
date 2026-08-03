/**
 * The single built-in stylesheet (§5.2 `styles.ts`) and the whole theming surface.
 *
 * **Theming is CSS custom properties, not API (§3).** They inherit through the shadow
 * boundary, so a host themes `comment-ui` entirely from its own page:
 *
 * ```css
 * :root {
 *   --cc-accent: #6366f1;  --cc-surface: #fff;  --cc-surface-2: #f6f6f8;
 *   --cc-text: #111;       --cc-muted: #6b7280; --cc-border: #e5e7eb;
 *   --cc-danger: #dc2626;  --cc-badge-size: 22px; --cc-radius: 8px;
 *   --cc-font: system-ui, sans-serif; --cc-shadow: 0 4px 16px rgb(0 0 0 / 0.14);
 * }
 * ```
 *
 * Every default is expressed as `var(--cc-x, <default>)` **read into a private `--_x` alias**,
 * never as a bare `--cc-x: <default>` declaration on `:host`. That distinction is load-bearing:
 * a declaration on `:host` would *win over* the page's inherited `:root` value and silently
 * disable the entire documented theming surface. Dark defaults are applied the same way, so a
 * host that sets `--cc-surface` explicitly keeps it in both colour schemes.
 *
 * `:host` carries `all: initial` (the WXT caveat) plus an **explicit `font-size`** — the sheet
 * therefore uses `px`/`em` only and never depends on the page's root font size. `all` does not
 * reset custom properties, so the theming layer above survives it.
 *
 * Two consumption modes, same bytes (the "cssInjectionMode" contract):
 *  - **injected** — `mountCommentUI` appends this string as a `<style>` inside the shadow root
 *    (the default; nothing to configure, nothing to ship);
 *  - **importable** — the same string is emitted to `dist/comment-ui.css` by the build and
 *    exported as `@astrale-os/comment-ui/styles.css`, for a host that ships its own CSS
 *    pipeline or a CSP that forbids inline `<style>`.
 */

export const commentUIStyles = `
:host {
  all: initial;
  font-size: var(--cc-root-font-size, 16px);
  font-family: var(--cc-font, system-ui, sans-serif);
  line-height: 1.45;

  /* Private aliases: read the page's value if it set one, else the default. */
  --_accent: var(--cc-accent, #6366f1);
  --_surface: var(--cc-surface, #fff);
  --_surface-2: var(--cc-surface-2, #f6f6f8);
  --_text: var(--cc-text, #111);
  --_muted: var(--cc-muted, #6b7280);
  --_border: var(--cc-border, #e5e7eb);
  --_danger: var(--cc-danger, #dc2626);
  --_badge-size: var(--cc-badge-size, 22px);
  --_radius: var(--cc-radius, 8px);
  --_shadow: var(--cc-shadow, 0 4px 16px rgb(0 0 0 / 0.14));
  --_on-accent: #fff;
}

@media (prefers-color-scheme: dark) {
  :host {
    --_surface: var(--cc-surface, #18181b);
    --_surface-2: var(--cc-surface-2, #232327);
    --_text: var(--cc-text, #f4f4f5);
    --_muted: var(--cc-muted, #a1a1aa);
    --_border: var(--cc-border, #3f3f46);
    --_shadow: var(--cc-shadow, 0 4px 16px rgb(0 0 0 / 0.45));
  }
}

*, *::before, *::after { box-sizing: border-box; }

/* The layer never eats page clicks; only its interactive descendants do. */
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
/* Non-interactive overlays. The pick hint is drawn 26px above the candidate — i.e. directly on
   the cursor's path into it — so an \`auto\` here would make comment-ui's own shadow node the
   engine's \`candidate\` (it resolves \`composedPath()[0]\` and does not filter shadow trees) and
   anchor the thread on the overlay. */
.cc-picker, .cc-pick-hint, .cc-status { pointer-events: none; }
/* Same failure, wider: while picking, EVERY widget must be click-through — a badge, the panel
   or an open popover under the cursor would otherwise be picked as the target. Set from
   \`picker.ts\` off \`engine.placement.phase === 'picking'\` and cleared with it. */
.cc-layer[data-picking='true'] > * { pointer-events: none; }

[hidden] { display: none !important; }

.cc-status {
  position: absolute;
  width: 1px; height: 1px;
  margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap;
}

/* ------------------------------------------------------------------ floating primitives */

.cc-float { position: fixed; top: 0; left: 0; margin: 0; }

/* Author styles beat the UA \`[popover]:not(:popover-open) { display: none }\` rule, so the
   same attribute works with and without top-layer support (happy-dom has no showPopover). */
.cc-composer, .cc-thread { display: none; }
.cc-composer[data-open='true'], .cc-thread[data-open='true'] { display: flex; }

/* ------------------------------------------------------------------------------- badges */

.cc-badge {
  position: fixed;
  top: 0; left: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: var(--_badge-size);
  height: var(--_badge-size);
  padding: 0 6px;
  border: 1px solid var(--_border);
  border-radius: calc(var(--_badge-size) / 2);
  background: var(--_accent);
  color: var(--_on-accent);
  font: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  box-shadow: var(--_shadow);
  transition: opacity 120ms ease;
}
.cc-badge:focus-visible { outline: 2px solid var(--_text); outline-offset: 2px; }
.cc-badge[data-tone='muted'] { background: var(--_surface-2); color: var(--_muted); }
.cc-badge[data-tone='accent'] { background: var(--_accent); color: var(--_on-accent); }
.cc-badge[data-status='resolved'] { background: var(--_surface-2); color: var(--_muted); }
.cc-badge[data-anchor='orphaned'] { opacity: 0.55; border-style: dashed; }
.cc-badge-icon { font-size: 12px; }
.cc-badge-count { font-variant-numeric: tabular-nums; }

/* Shape/text markers — colour never carries state alone (§3 a11y). */
.cc-mark { font-size: 10px; line-height: 1; }
.cc-mark[data-mark='approximate']::before { content: '~'; }
.cc-mark[data-mark='orphaned']::before { content: '⚑'; }
.cc-mark[data-mark='resolved']::before { content: '✓'; }

/* --------------------------------------------------------------------------- chips */

.cc-chip-slot { display: inline-flex; }
.cc-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  height: 16px;
  border-radius: 8px;
  background: var(--_surface-2);
  color: var(--_text);
  font-size: 10px;
  white-space: nowrap;
}
.cc-chip[data-tone='info'] { background: color-mix(in srgb, var(--_accent) 18%, transparent); }
.cc-chip[data-tone='busy'] { background: color-mix(in srgb, var(--_accent) 26%, transparent); }
.cc-chip[data-tone='warn'] { background: #fde68a; color: #713f12; }
.cc-chip[data-tone='danger'] { background: var(--_danger); color: #fff; }
.cc-spinner {
  width: 8px; height: 8px;
  border: 1.5px solid currentColor;
  border-right-color: transparent;
  border-radius: 50%;
  animation: cc-spin 700ms linear infinite;
}
@keyframes cc-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .cc-spinner { animation-duration: 2400ms; } }

/* ------------------------------------------------------------------------ picker overlay */

.cc-picker {
  position: fixed;
  top: 0; left: 0;
  border: 2px solid var(--_accent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--_accent) 10%, transparent);
}
.cc-pick-hint {
  position: fixed;
  padding: 4px 8px;
  border-radius: var(--_radius);
  background: var(--_text);
  color: var(--_surface);
  font-size: 12px;
  white-space: nowrap;
}

/* ------------------------------------------------------------------- composer + popover */

.cc-composer, .cc-thread {
  flex-direction: column;
  gap: 8px;
  width: 300px;
  max-width: calc(100vw - 24px);
  padding: 10px;
  border: 1px solid var(--_border);
  border-radius: var(--_radius);
  background: var(--_surface);
  color: var(--_text);
  box-shadow: var(--_shadow);
  font-size: 13px;
}
.cc-thread { width: 320px; }

.cc-composer-input {
  width: 100%;
  min-height: 64px;
  padding: 6px 8px;
  border: 1px solid var(--_border);
  border-radius: 6px;
  background: var(--_surface);
  color: var(--_text);
  font: inherit;
  resize: vertical;
}
.cc-composer-input:focus-visible { outline: 2px solid var(--_accent); outline-offset: -1px; }
.cc-composer[data-busy='true'] { opacity: 0.7; }

.cc-row-actions, .cc-composer-actions, .cc-thread-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
.cc-composer-actions { justify-content: flex-end; }

.cc-btn {
  padding: 4px 10px;
  border: 1px solid var(--_border);
  border-radius: 6px;
  background: var(--_surface-2);
  color: var(--_text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.cc-btn:focus-visible { outline: 2px solid var(--_accent); outline-offset: 1px; }
.cc-btn[disabled] { opacity: 0.5; cursor: default; }
.cc-btn[data-variant='primary'] {
  background: var(--_accent);
  border-color: var(--_accent);
  color: var(--_on-accent);
}
.cc-btn[data-variant='danger'] { color: var(--_danger); }
.cc-btn[data-variant='icon'] { padding: 2px 6px; background: transparent; border-color: transparent; }

/* -------------------------------------------------------------------------- thread body */

.cc-head { display: flex; align-items: center; gap: 6px; }
.cc-head-title { flex: 1; font-weight: 600; font-size: 12px; }
.cc-comments { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; max-height: 260px; overflow-y: auto; }
.cc-comment { display: flex; flex-direction: column; gap: 2px; }
.cc-comment-head { display: flex; align-items: baseline; gap: 6px; font-size: 11px; color: var(--_muted); }
.cc-author { font-weight: 600; color: var(--_text); }
.cc-author[data-author='copilot'] { color: var(--_accent); }
.cc-body { white-space: pre-wrap; overflow-wrap: anywhere; }
.cc-quote {
  margin: 0;
  padding: 4px 8px;
  border-left: 2px solid var(--_border);
  color: var(--_muted);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.cc-edit { display: flex; flex-direction: column; gap: 4px; }

/* ------------------------------------------------------------------------------- panel */

.cc-panel-toggle {
  position: fixed;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--_border);
  border-radius: 999px;
  background: var(--_surface);
  color: var(--_text);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  box-shadow: var(--_shadow);
}
.cc-panel {
  position: fixed;
  display: none;
  flex-direction: column;
  gap: 8px;
  width: 300px;
  max-width: calc(100vw - 24px);
  max-height: min(60vh, 520px);
  padding: 10px;
  border: 1px solid var(--_border);
  border-radius: var(--_radius);
  background: var(--_surface);
  color: var(--_text);
  box-shadow: var(--_shadow);
  font-size: 13px;
  overflow-y: auto;
}
.cc-panel[data-open='true'] { display: flex; }

.cc-panel-toggle[data-corner='br'] { right: 16px; bottom: 16px; }
.cc-panel-toggle[data-corner='bl'] { left: 16px; bottom: 16px; }
.cc-panel-toggle[data-corner='tr'] { right: 16px; top: 16px; }
.cc-panel-toggle[data-corner='tl'] { left: 16px; top: 16px; }
.cc-panel[data-corner='br'] { right: 16px; bottom: 60px; }
.cc-panel[data-corner='bl'] { left: 16px; bottom: 60px; }
.cc-panel[data-corner='tr'] { right: 16px; top: 60px; }
.cc-panel[data-corner='tl'] { left: 16px; top: 60px; }

.cc-panel-title { margin: 0; font-size: 13px; font-weight: 600; }
.cc-section { display: flex; flex-direction: column; gap: 4px; }
.cc-section-title { margin: 6px 0 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--_muted); }
.cc-rows { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.cc-row { display: flex; align-items: center; gap: 6px; }
.cc-row-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border: 1px solid var(--_border);
  border-radius: 6px;
  background: var(--_surface-2);
  color: inherit;
  font: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.cc-row-main:focus-visible { outline: 2px solid var(--_accent); outline-offset: 1px; }
.cc-row-meta { display: flex; align-items: center; gap: 6px; color: var(--_muted); font-size: 11px; }
.cc-row-body { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-empty { margin: 0; padding: 4px 0; color: var(--_muted); font-size: 12px; }
`
