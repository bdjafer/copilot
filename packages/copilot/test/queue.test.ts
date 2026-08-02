// SPEC-copilot §3.1 / §2.3 — the local FIFO: `concurrency`, the per-run `retryDelayMs` deadline
// and the active-run edges. `retryDelayMs(attempt)` is normative PER RUN, so an earlier deadline
// must never wait on an already-armed later one.
import { describe, expect, test, vi } from 'vitest'

import type { Queue, QueueOptions } from '../src/run/queue.ts'

import { createQueue } from '../src/run/queue.ts'

function harness(over: Partial<QueueOptions> = {}): { queue: Queue; started: string[] } {
  const started: string[] = []
  const queue = createQueue({
    concurrency: 1,
    now: () => Date.now(),
    start: (runId) => started.push(runId),
    onActive: () => undefined,
    onIdle: () => undefined,
    ...over,
  })
  return { queue, started }
}

describe('§3.1 run queue', () => {
  test('an earlier notBefore is not starved by an already-armed later timer', () => {
    vi.useFakeTimers()
    try {
      const { queue, started } = harness()
      queue.add('a', Date.now() + 4_000) // attempt-2 backoff, armed first
      queue.add('b', Date.now() + 2_000) // a sooner deadline arrives afterwards
      vi.advanceTimersByTime(2_100)
      expect(started).toEqual(['b'])
      queue.finish('b')
      vi.advanceTimersByTime(2_000)
      expect(started).toEqual(['b', 'a'])
      queue.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a later notBefore added after an armed earlier one does not re-arm the timer early', () => {
    vi.useFakeTimers()
    try {
      const { queue, started } = harness({ concurrency: 2 })
      queue.add('b', Date.now() + 2_000)
      queue.add('a', Date.now() + 4_000)
      vi.advanceTimersByTime(2_100)
      expect(started).toEqual(['b'])
      vi.advanceTimersByTime(2_000)
      expect(started).toEqual(['b', 'a'])
      queue.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a due run runs immediately and `concurrency` gates the rest', () => {
    vi.useFakeTimers()
    try {
      const { queue, started } = harness()
      queue.add('a')
      queue.add('b')
      expect(started).toEqual(['a'])
      expect(queue.holds('b')).toBe(true)
      queue.finish('a')
      expect(started).toEqual(['a', 'b'])
      queue.destroy()
    } finally {
      vi.useRealTimers()
    }
  })
})
