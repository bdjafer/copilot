/**
 * `@astrale-os/comment-ui` — public barrel (§3, §5.2).
 *
 * Two functions plus `decorate()` and CSS custom properties, and that is the entire surface
 * (decision log #22): no slots, no renderer registry, no `tokens`, no `defineTheme`, no
 * `theme: 'auto' | 'light' | 'dark'`. Custom properties inherit through the shadow boundary,
 * so the whole theming API is CSS the host page already knows how to write.
 *
 * Host chrome is the host's own overlay (§3): PLAN §5's "N comments — Send to copilot" pill,
 * multi-select and every batch affordance are mounted by the host, in its own shadow root,
 * below `CommentUIOptions.zIndex`, driven from `engine.threads` / `engine.on(...)` /
 * `ui.decorate()`. There is nothing to inject into these widgets.
 */

export { mount, mountCommentUI } from './mount.ts'

export { defaultLabels } from './labels.ts'

/** The built-in stylesheet, for a host that ships CSS itself (see `styles.ts`). */
export { commentUIStyles } from './styles.ts'

export type { CommentUI, CommentUIOptions, Decoration, Labels, PanelSection } from './types.ts'
