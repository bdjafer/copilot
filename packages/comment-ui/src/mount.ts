/**
 * The 3 entry points (§3, §3.1.1). All of the behaviour lives in `./controller/`; this file
 * is the option-resolution seam and the backward-compatibility promise.
 *
 * `mount()` and `mountCommentUI()` keep their **exact outer signatures and return types**
 * (§3.1.7, decision log #33): `mountCommentUI` *is* `createCommentUIController` with a narrower
 * return type — one implementation, not two — and the default presentation stays
 * `domPresentation()`, because a design change is not something a patch upgrade should perform
 * on a host's users.
 */

import type { CommentEngine, CommentEngineOptions } from '@astrale-os/comment-core'

import { createCommentEngine } from '@astrale-os/comment-core'

import type { CommentUI, CommentUIController, CommentUIOptions } from './types.ts'

import { createController, resolveOptions } from './controller/index.ts'
import { domPresentation } from './presentations/dom/index.ts'

/**
 * The full seam (§3.1): the controller owns all logic and state and publishes a serializable
 * `UIViewModel`; a `Presentation` is the only thing that draws.
 */
export function createCommentUIController(
  engine: CommentEngine,
  options?: CommentUIOptions,
): CommentUIController {
  return createController(resolveOptions(options, domPresentation()), engine)
}

/** Attach the shadow-root UI to an engine you already own. */
export function mountCommentUI(engine: CommentEngine, options?: CommentUIOptions): CommentUI {
  return createCommentUIController(engine, options)
}

/**
 * Zero-config bootstrap for `<script>` tags: builds the engine too. Global: `CommentsUI.mount()`.
 *
 * The two option bags are **nested, not intersected** (§3): `CommentUIOptions['onError']` is
 * `(error: unknown) => void` while `CommentEngineOptions['onError']` is
 * `(error, phase) => void`, and an intersection of those two makes the two-parameter form
 * uncallable — on the one entry point whose whole purpose is being callable with no types.
 */
export function mount(options?: {
  ui?: CommentUIOptions
  engine?: CommentEngineOptions
}): CommentUI & { engine: CommentEngine } {
  const engine = createCommentEngine(options?.engine)
  const ui = mountCommentUI(engine, options?.ui)
  return Object.assign(ui, { engine })
}
