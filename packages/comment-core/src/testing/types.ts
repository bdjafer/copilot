/** Types of `comment-core/testing` (§2.16). DOM-free. */

export type Awaitable<T> = T | Promise<T>

export interface ConformanceCase {
  name: string
  run: () => Promise<void>
}
