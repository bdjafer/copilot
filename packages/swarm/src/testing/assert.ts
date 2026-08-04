/**
 * Minimal assertions for the conformance suites.
 *
 * The suites are runner-agnostic (§1.1), so they cannot reach for `expect`. Failures are plain
 * `Error`s whose message names the rule that was broken — the host runner prints it.
 *
 * DOM-free and Node-free.
 */

import { SwarmError, type SwarmErrorCode } from '../errors.ts'

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

/** Asserts the promise rejects with a `SwarmError` carrying exactly `code`. */
export async function assertRejects(
  promise: Promise<unknown>,
  code: SwarmErrorCode,
  message: string,
): Promise<void> {
  let thrown: unknown
  let resolved = false
  try {
    await promise
    resolved = true
  } catch (error) {
    thrown = error
  }
  if (resolved) throw new Error(`conformance: ${message} (resolved instead of rejecting)`)
  if (!SwarmError.is(thrown, code)) {
    const seen = SwarmError.is(thrown) ? thrown.code : show(thrown)
    throw new Error(`conformance: ${message} (expected SwarmError '${code}', got ${seen})`)
  }
}

export function show(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value instanceof Error) return `${value.name}(${value.message})`
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
