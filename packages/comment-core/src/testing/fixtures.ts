/**
 * Record fixtures for the conformance suites and the package's own tests.
 *
 * DOM-free: an `AnchorDescriptor` / `ElementCapture` is plain data, so a headless context can
 * build one without ever having captured an element.
 */

import type {
  AnchorDescriptor,
  Comment,
  CreateThreadInput,
  ElementCapture,
  Thread,
} from '../types.ts'

import { THREAD_VERSION } from '../types.ts'

export const anchor: AnchorDescriptor = {
  mode: 'element',
  selectors: [{ type: 'css', value: '#target' }],
  fingerprint: {
    tag: 'div',
    id: 'target',
    stableClasses: ['card'],
    attrs: { 'data-testid': 'target' },
    textDigest: 'target',
  },
}

export const capture: ElementCapture = {
  outerHTML: '<div id="target">target</div>',
  text: 'target',
  cssPath: '#target',
  page: { url: 'https://example.com/doc', title: 'doc' },
  capturedAt: '2026-01-01T00:00:00.000Z',
}

export function makeThreadRecord(id: string, over?: Partial<Thread>): Thread {
  return {
    id,
    v: THREAD_VERSION,
    pageKey: 'https://example.com/doc',
    kind: 'comment',
    anchor,
    capture,
    status: 'open',
    resolvedAt: null,
    resolvedBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

export function makeCommentRecord(id: string, threadId: string, over?: Partial<Comment>): Comment {
  return {
    id,
    threadId,
    author: 'user',
    body: `body ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    editedAt: null,
    ...over,
  }
}

export function makeCreateInput(over?: Partial<CreateThreadInput>): CreateThreadInput {
  return {
    pageKey: 'https://example.com/doc',
    kind: 'comment',
    anchor,
    capture,
    author: 'user',
    body: 'first',
    ...over,
  }
}

/** Monotonic ISO clock: one second per tick, so `createdAt` ordering is never ambiguous. */
export function tickingClock(startMs = Date.UTC(2026, 0, 1)): () => Date {
  let t = startMs
  return () => new Date((t += 1000))
}

/** Deterministic ids: `id-1`, `id-2`, … */
export function countingIds(prefix = 'id'): () => string {
  let n = 0
  return () => `${prefix}-${++n}`
}
