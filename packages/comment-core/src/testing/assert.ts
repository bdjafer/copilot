/**
 * Minimal assertions for the conformance suites.
 *
 * The suites are runner-agnostic arrays of `{ name, run }` (§2.16, decision log #24), so they
 * cannot reach for `expect`. Failures are plain `Error`s with a message the host runner prints.
 *
 * DOM-free.
 */

import { CommentError, type CommentErrorCode } from '../errors.ts'

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`conformance: ${message}`)
}

export function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`conformance: ${message} (expected ${show(expected)}, got ${show(actual)})`)
  }
}

export function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`conformance: ${message} (expected ${b}, got ${a})`)
}

export function assertIds(
  actual: ReadonlyArray<{ id: string }>,
  expected: readonly string[],
  message: string,
): void {
  assertDeepEqual(
    actual.map((r) => r.id),
    expected,
    message,
  )
}

/** Asserts the promise rejects with a `CommentError` carrying exactly `code`. */
export async function assertRejects(
  run: () => Promise<unknown>,
  code: CommentErrorCode,
  message: string,
): Promise<CommentError> {
  try {
    await run()
  } catch (error) {
    if (CommentError.is(error, code)) return error
    throw new Error(`conformance: ${message} (expected CommentError '${code}', got ${show(error)})`)
  }
  throw new Error(`conformance: ${message} (expected a rejection with '${code}', got none)`)
}

function show(value: unknown): string {
  if (value instanceof Error) return `${value.name}(${(value as { code?: string }).code ?? ''})`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
