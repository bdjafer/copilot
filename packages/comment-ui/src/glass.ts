/**
 * `@astrale-os/comment-ui/glass` — the product's intended appearance (§1.2, §3.1.1).
 *
 * Two names, and **zero runtime imports**: everything this subpath needs from the rest of the
 * package is a type, and types are erased. That is not a coincidence, it is the seam working —
 * a presentation sees `UIViewModel`, `Intents` and `PresentationHost`, and there is no fourth
 * thing it *could* see. The consequence a consumer can measure: selecting the default appearance
 * costs nothing, and selecting this one pulls in no second copy of the engine, the controller or
 * the positioning library.
 *
 * ```ts
 * import { mountCommentUI } from '@astrale-os/comment-ui'
 * import { glassPresentation } from '@astrale-os/comment-ui/glass'
 *
 * mountCommentUI(engine, { presentation: glassPresentation() })
 * ```
 *
 * On a bare page the IIFE global is `CommentsUIGlass`, loaded third:
 *
 * ```html
 * <script src="comment-core.iife.js"></script>
 * <script src="comment-ui.iife.js"></script>
 * <script src="comment-ui-glass.iife.js"></script>
 * ```
 *
 * The sheet is exported too, for a host that ships its own CSS pipeline or a policy that forbids
 * an inline `<style>`; `dist/comment-ui-glass.css` is the same bytes as a file.
 */

export type { GlassOptions } from './presentations/glass/index.ts'
export { glassPresentation } from './presentations/glass/index.ts'
export { glassStyles } from './presentations/glass/styles.ts'
