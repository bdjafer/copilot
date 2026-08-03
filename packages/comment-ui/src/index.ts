/**
 * `@astrale-os/comment-ui` — public barrel (§3, §5.2).
 *
 * Six runtime names, and that is the entire surface: `mount`, `mountCommentUI`,
 * `createCommentUIController`, `domPresentation`, `commentUIStyles`, `defaultLabels`. There are
 * still no slots, no renderer registry, no `tokens`, no `defineTheme` and no
 * `theme: 'auto' | 'light' | 'dark'` (decision log #22 stands): custom properties inherit
 * through the shadow boundary, so the whole theming API is CSS the host page already knows how
 * to write.
 *
 * The presentation seam (§3.1) is **not** a slot system, and the distinction is the whole
 * argument (decision log #30): slots let a host inject *into* our renderer, which is a second
 * execution plane inside our DOM. A `Presentation` replaces the renderer wholesale, behind a
 * contract the host cannot partially occupy.
 *
 * Host chrome is still the host's own overlay (§3): PLAN §5's "N comments — Send to copilot"
 * pill, multi-select and every batch affordance are mounted by the host, in its own shadow root,
 * below `CommentUIOptions.zIndex`, driven from `engine.threads` / `engine.on(...)` /
 * `ui.decorate()`.
 */

export { createCommentUIController, mount, mountCommentUI } from './mount.ts'

/** The default presentation: today's markup, class names and `commentUIStyles`. Frozen (§3.1.8). */
export { domPresentation } from './presentations/dom/index.ts'

export { defaultLabels } from './labels.ts'

/** The built-in stylesheet, for a host that ships CSS itself. */
export { commentUIStyles } from './presentations/dom/styles.ts'

export type {
  CommentUI,
  CommentUIController,
  CommentUIOptions,
  Decoration,
  Labels,
  PanelSection,
} from './types.ts'

/**
 * The seam, re-exported for convenience. The authoritative import for a presentation author is
 * `@astrale-os/comment-ui/presentation`, which pulls in **no runtime code at all**.
 */
export type {
  AnchorState,
  BadgeVM,
  ChipTone,
  ChipVM,
  CommentVM,
  ComposerVM,
  FocusTarget,
  Intents,
  PanelRowVM,
  PanelSectionVM,
  PanelVM,
  PickerVM,
  Presentation,
  PresentationHost,
  PresentationInstance,
  Rect,
  ThreadVM,
  UIViewModel,
} from './presentation.ts'
