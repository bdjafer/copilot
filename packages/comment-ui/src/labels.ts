/**
 * Default `Labels` (§3). Every user-visible string in `comment-ui` lives here — the renderer
 * never builds a sentence out of a template. Composed strings that a translator cannot reach
 * (a badge's accessible name, a comment's timestamp) are built out of **values**, not prose:
 * `aria-label="comment (2)"`, `<time datetime="…">`. `Labels` is a locked interface, so the
 * renderer must not invent a key for one.
 */

import type { Labels } from './types.ts'

export const defaultLabels: Labels = Object.freeze({
  send: 'Send',
  dismiss: 'Dismiss',
  reply: 'Reply',
  resolve: 'Resolve',
  reopen: 'Reopen',
  delete: 'Delete',
  edit: 'Edit',
  placeholder: 'Add a comment…',
  panelTitle: 'Comments',
  sectionOpen: 'Open',
  sectionResolved: 'Resolved',
  sectionUnanchored: 'Unanchored',
  emptyOpen: 'No open comments on this page.',
  emptyResolved: 'No resolved comments.',
  emptyUnanchored: 'Nothing unanchored.',
  approximate: 'Approximately re-anchored',
  pickHint: 'Click an element to comment on it — Esc to cancel',
})

export function resolveLabels(overrides?: Partial<Labels>): Labels {
  if (!overrides) return defaultLabels
  const merged = { ...defaultLabels }
  for (const key of Object.keys(defaultLabels) as (keyof Labels)[]) {
    const value = overrides[key]
    if (typeof value === 'string') merged[key] = value
  }
  return Object.freeze(merged)
}
