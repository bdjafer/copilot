# @astrale-os/comment-ui

**The renderer for [`@astrale-os/comment-core`](../comment-core).** Badges, a composer popover,
a thread popover and a corner panel — one open shadow root, ~2,500 lines of vanilla TypeScript
(~1,900 excluding blanks and comments), no framework, no build-time CSS, and it never mutates
the host page's DOM.

The entire public surface is **two functions, one method and a handful of CSS custom
properties**:

```ts
mountCommentUI(engine, options?)  // attach to an engine you own
mount({ ui?, engine? })           // zero-config: build the engine too
ui.decorate(threadId, decoration) // host-driven badge chrome
```

There are no slots, no renderer registry, no `tokens` object, no `defineTheme`, no
`theme: 'auto' | 'light' | 'dark'`. Theming is CSS custom properties, which already inherit
through the shadow boundary — so the whole theming API is CSS your page knows how to write.

---

## Install

```sh
npm i @astrale-os/comment-ui @astrale-os/comment-core
```

Dependencies: `@astrale-os/comment-core` and `@floating-ui/dom`. That is all.

---

## Quick start

### Mount onto an engine you own

```ts
import { createCommentEngine } from '@astrale-os/comment-core'
import { mountCommentUI } from '@astrale-os/comment-ui'

const engine = createCommentEngine()
const ui = mountCommentUI(engine, {
  panel: { corner: 'bl', defaultOpen: false, sections: ['open', 'unanchored'] },
  badge: { orphaned: 'dock', showResolved: false, offset: [6, -6] },
  labels: { send: 'Post', panelTitle: 'Notes' },
  css: '.cc-badge { font-weight: 600 }',
  onError: (error) => console.warn(error),
})
```

### Zero-config, including the engine

```ts
import { mount } from '@astrale-os/comment-ui'

const ui = mount({
  engine: { modes: [{ kind: 'comment', trigger: { key: 'c' } }] },
  ui: { panel: { defaultOpen: true } },
})
ui.engine.on('thread:create', ({ thread }) => console.log(thread.id))
```

The two option bags are **nested, not intersected** — `CommentUIOptions['onError']` is
`(error: unknown) => void` and `CommentEngineOptions['onError']` is
`(error, phase) => void`, and an intersection of those makes the two-parameter form uncallable.

### No build step at all

```html
<script src="/comment-core.iife.js"></script>
<script src="/comment-ui.iife.js"></script>
<script>CommentsUI.mount()</script>
```

Load order is load-bearing: `comment-ui.iife.js` declares `comment-core` external and reads it
off `globalThis.Comments`.

---

## What it renders (and what it will not)

`comment-ui` is a **pure renderer**. Its only state is which panel section is open, which thread
popover is open, and the host-supplied `decorate()` map. Everything else is read from
`engine.threads`, `engine.placement` and `engine.modes`, and every write goes through a
`CommentEngine` method — there is no privileged path to the store.

| Anchoring status | On the page | In the panel |
|---|---|---|
| `pending` | **nothing** | **nothing** |
| `anchored` | badge tracked to the element (`@floating-ui/dom` + `autoUpdate`, `flip` + `shift`) | "Open" / "Resolved" |
| `orphaned` | dimmed dashed badge docked at `anchoring.rect`, re-projected on every scroll | "Unanchored" |
| resolved | hidden by default (Figma/Docs behaviour); `badge.showResolved: true` to show | "Resolved" |
| `confidence < 0.85` | an "approximate" marker glyph + a `title` of `Labels.approximate` | — |

`pending` rendering nothing is deliberate: on a cold load *every* thread is pending for the
length of the first resolution pass, and drawing them would be exactly the flash the anchoring
rules exist to prevent.

Off-screen badges are skipped via `IntersectionObserver` (`badge.hideOffscreen`, default true).
The composer uses the native `popover` attribute, so it is in the top layer and wins no z-index
wars.

**Host chrome is the host's own overlay.** A "3 comments — send to copilot" pill, multi-select,
a batch affordance — none of those are `comment-ui` surface, and there is no slot system to
inject them. Mount your own shadow root below `CommentUIOptions.zIndex` and drive it from
`engine.threads`, `engine.on(...)` and `ui.decorate()`.

---

## Theming contract

Set custom properties anywhere they inherit from — `:root` is the usual place. They cross the
shadow boundary; the sheet reads each one through `var(--cc-x, <default>)` into a private alias
rather than declaring `--cc-x` on `:host`, precisely so a page value always wins.

| Property | Default (light) | Default (dark) | Controls |
|---|---|---|---|
| `--cc-accent` | `#6366f1` | *(same)* | badge fill, primary button, focus ring |
| `--cc-surface` | `#fff` | `#18181b` | popover and panel background |
| `--cc-surface-2` | `#f6f6f8` | `#232327` | secondary rows, comment bodies, chips |
| `--cc-text` | `#111` | `#f4f4f5` | body text |
| `--cc-muted` | `#6b7280` | `#a1a1aa` | metadata, timestamps, empty states |
| `--cc-border` | `#e5e7eb` | `#3f3f46` | hairlines and dividers |
| `--cc-danger` | `#dc2626` | *(same)* | delete affordances |
| `--cc-badge-size` | `22px` | *(same)* | badge diameter |
| `--cc-radius` | `8px` | *(same)* | corner radius |
| `--cc-font` | `system-ui, sans-serif` | *(same)* | font family for the whole tree |
| `--cc-shadow` | `0 4px 16px rgb(0 0 0 / 0.14)` | `0 4px 16px rgb(0 0 0 / 0.45)` | popover/panel elevation |

```css
:root {
  --cc-accent: #0f766e;
  --cc-radius: 4px;
  --cc-font: 'Inter', system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root { --cc-accent: #2dd4bf; }
}
```

Dark values are applied under `@media (prefers-color-scheme: dark)` the same way — through
`var(--cc-x, <dark default>)` — so a page that sets `--cc-surface` explicitly keeps it in both
schemes.

**Two properties are set by the API, not by CSS**, because the renderer writes them onto `:host`
where a page-level `:root` value cannot reach them:

| Property | Set via | Default |
|---|---|---|
| `--cc-root-font-size` | `CommentUIOptions.rootFontSize` | `'16px'` |
| `--cc-z` | `CommentUIOptions.zIndex` | `2147483000` |

`:host` carries `all: initial` plus that explicit `font-size`, so the sheet uses `px`/`em` only
and never depends on the page's root font size. (`all: initial` does not reset custom
properties, which is what keeps the table above working.)

### Beyond custom properties

Two escape hatches, in order of preference:

1. **`options.css`** — raw CSS appended inside the shadow root *after* the built-in sheet. The
   class names are stable: `.cc-layer`, `.cc-badge`, `.cc-badge-icon`, `.cc-badge-count`,
   `.cc-mark`, `.cc-chip`, `.cc-chip-slot`, `.cc-spinner`, `.cc-composer`, `.cc-composer-input`,
   `.cc-thread`, `.cc-comment`, `.cc-panel`, `.cc-row`, `.cc-section`, `.cc-btn`, `.cc-picker`,
   `.cc-pick-hint`, `.cc-status`.
2. **`@astrale-os/comment-ui/styles.css`** — the same bytes the renderer injects, emitted to
   `dist/comment-ui.css` by the build, for a host with its own CSS pipeline or a CSP that
   forbids inline `<style>`. It is also exported from the barrel as the string
   `commentUIStyles`.

---

## `decorate()` recipes

`decorate()` is the one seam a host uses to put its own state on a badge — and it is why
`comment-ui` never learns what a "copilot" is. It renders `{ text, tone, spinner }` and nothing
else.

```ts
interface Decoration {
  chip?: { text: string; tone?: 'neutral' | 'info' | 'busy' | 'warn' | 'danger'; spinner?: boolean } | null
  tone?: 'default' | 'muted' | 'accent'
  title?: string // title attribute on the badge
}
```

### A "thinking" chip with a spinner

```ts
copilot.on('run:queued', ({ run }) =>
  ui.decorate(run.context.threadId, { chip: { text: 'copilot', tone: 'busy', spinner: true } }))

copilot.on('run:settled', ({ run }) => ui.decorate(run.context.threadId, null)) // null clears
```

### A pending-dispatch pill

```ts
ui.decorate(threadId, { chip: { text: `pending · ${count}`, tone: 'neutral' }, tone: 'muted' })
```

### A failure that stays visible

```ts
copilot.on('run:error', ({ run, error, willRetry }) => {
  if (willRetry) return
  ui.decorate(run.context.threadId, { chip: { text: error.code, tone: 'warn' }, title: 'copilot run failed' })
})
```

A run that died three times must not look like a run that never happened.

### Lifecycle — and the one trap

Decorations are dropped automatically on that thread's `thread:delete`, and the whole map is
cleared on `page:change`. So the map cannot leak and a stale chip cannot survive a navigation.

Otherwise they are **sticky and have no TTL**. That matters when the thing setting them is edge
triggered: if a service worker dies between `busy: true` and `busy: false`, the chip spins
forever. Re-derive from durable state on mount:

```ts
await engine.ready()
for (const threadId of await askWhoIsBusy()) {
  ui.decorate(threadId, { chip: { text: 'copilot', tone: 'busy', spinner: true } })
}
```

The same decoration renders in up to three places at once — the badge, the thread popover and
the panel row — and only the badge's slot is an `aria-live` region, so an announcement fires
once rather than three times.

---

## API

| Export | Signature | One-liner |
|---|---|---|
| `mountCommentUI` | `(engine: CommentEngine, options?: CommentUIOptions) => CommentUI` | Attach the shadow-root UI to an engine you already own. |
| `mount` | `(options?: { ui?: CommentUIOptions; engine?: CommentEngineOptions }) => CommentUI & { engine: CommentEngine }` | Zero-config bootstrap; builds the engine too. IIFE global: `CommentsUI.mount()`. |
| `defaultLabels` | `Labels` | The frozen default string table. |
| `commentUIStyles` | `string` | The built-in stylesheet, for a host that ships CSS itself. |
| *types* | `CommentUI`, `CommentUIOptions`, `Decoration`, `Labels`, `PanelSection` | — |

### `CommentUIOptions`

| Option | Type | Default |
|---|---|---|
| `container` | `HTMLElement` | `document.documentElement` |
| `css` | `string` | `''` |
| `labels` | `Partial<Labels>` | `defaultLabels` |
| `panel.enabled` | `boolean` | `true` |
| `panel.corner` | `'br' \| 'bl' \| 'tr' \| 'tl'` | `'br'` |
| `panel.defaultOpen` | `boolean` | `false` |
| `panel.sections` | `readonly PanelSection[]` | `['open', 'resolved', 'unanchored']` |
| `badge.showResolved` | `boolean` | `false` |
| `badge.orphaned` | `'dock' \| 'panel-only' \| 'hidden'` | `'dock'` |
| `badge.offset` | `[number, number]` | `[6, -6]` |
| `badge.hideOffscreen` | `boolean` | `true` |
| `isolateEvents` | `boolean` | `true` |
| `zIndex` | `number` | `2147483000` |
| `rootFontSize` | `string` | `'16px'` |
| `onError` | `(error: unknown) => void` | swallow |

### `CommentUI`

| Member | Signature | One-liner |
|---|---|---|
| `root` | `ShadowRoot` | The **open** shadow root — inspectable from devtools, assertable from a test. |
| `engine` | `CommentEngine` | The engine it renders. |
| `panel.open` / `close` / `toggle` / `isOpen` | `(section?: PanelSection) => void` … | Corner panel control. |
| `focus` | `(threadId: string) => void` | Scroll to + open the thread popover. Delegates to `engine.focus()`. |
| `decorate` | `(threadId: string, decoration: Decoration \| null) => void` | Host-driven badge chrome; `null` clears. |
| `unmount` | `() => void` | Removes the shadow host, all listeners, all trackers. Idempotent. |

### `Labels`

Every user-visible string lives here — the renderer never builds a sentence from a template.
Keys: `send`, `dismiss`, `reply`, `resolve`, `reopen`, `delete`, `edit`, `placeholder`,
`panelTitle`, `sectionOpen`, `sectionResolved`, `sectionUnanchored`, `emptyOpen`,
`emptyResolved`, `emptyUnanchored`, `approximate`, `pickHint`.

Composed strings a translator cannot reach are built from **values**, not prose: a badge's
accessible name is `"Ask (2)"` (mode label + count), a timestamp is `<time datetime="…">`.

---

## Accessibility

Verified by `test/a11y.test.ts`, not aspirational.

**Roles and names**
* Every interactive node is a real `<button type="button">` with a non-empty accessible name.
* Badges: `aria-label` composed from the mode label and the comment count (`"Ask (1)"`),
  `aria-haspopup="dialog"`, `aria-expanded` reflecting their popover. The icon glyph is
  `aria-hidden` — the name carries the meaning.
* Both popovers are `role="dialog"` with an `aria-label`: the thread popover is named
  `"comment (1)"`, the composer by `Labels.placeholder`.
* The panel is a `<section>` named by `Labels.panelTitle`, with heading-labelled lists per
  section.

**Announcements**
* A visually-hidden `role="status" aria-live="polite"` region announces placement-mode hints
  (`Labels.pickHint`).
* Decoration chips sit in an `aria-live="polite"` slot, so "copilot thinking" → settled is
  announced without stealing focus. Rendering is idempotent: an unchanged decoration touches no
  node, so an unrelated render cannot re-announce.

**Focus**
* Opening the composer moves focus to its textarea and traps Tab inside it; closing returns
  focus to the invoking badge — or to the element that had focus at trigger time.
* Opening a thread popover moves focus to its close button; closing returns focus to the badge.
* Deleting a thread is the one action whose focus cannot go back to its badge, so it falls back
  to the panel toggle.

**Escape does exactly one thing**, in this order: cancel placement → close the thread popover →
close the panel.

**Colour never carries state alone.** Resolved, orphaned and approximate each also render a
`.cc-mark` glyph, and approximate additionally sets `title="Approximately re-anchored"`.

**Event isolation.** `isolateEvents` (default true) stops `keydown` / `keyup` / `keypress` in
the bubble phase at the shadow host, so a page-level handler never sees what you type into the
composer. One documented residual: a **capture-phase** `window` listener still runs first — by
design, since `comment-core`'s own trigger handler is exactly that, and it already ignores
keystrokes whose `composedPath()[0]` is an input, textarea or contenteditable.

---

## License

Apache-2.0 © Astrale.
