/**
 * `@astrale-os/comment-ui/testing` — the conformance kit (§3.1.1, §3.1.9).
 *
 * It mirrors `comment-core/testing` (decision log #24): runner-agnostic arrays, so a host that
 * ships its own presentation proves it in 3 lines of whatever runner it already uses.
 */

export { presentationConformance } from './presentation-conformance.ts'
export type { ConformanceCase } from './presentation-conformance.ts'
