/** Types of `@astrale-os/swarm/testing` (§1.1). DOM-free and Node-free. */

export type Awaitable<T> = T | Promise<T>

/**
 * Runner-agnostic case, the shape `comment-core/testing` established: the suites are arrays of
 * `{ name, run }`, so `for (const c of suite()) it(c.name, c.run)` works in vitest, node:test and
 * bun alike, and a host embedding swarm can run the same contract in whatever it already uses.
 */
export interface ConformanceCase {
  readonly name: string
  run(): Promise<void>
}
