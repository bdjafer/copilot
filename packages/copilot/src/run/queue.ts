// SPEC-copilot §3.1 / §3.3.9 — the local FIFO, the `concurrency` gate, and the active-run edges
// that drive `runtime:active` (leading, undelayed) and `runtime:idle` (trailing, debounced 500 ms).
import { IDLE_DEBOUNCE_MS } from '../constants.ts'

export interface QueueOptions {
  concurrency: number
  now: () => number
  /** Called when a run leaves the FIFO for processing. */
  start: (runId: string) => void
  /** 0→1 edge. Emitted synchronously, before the first provider request is issued. */
  onActive: (activeRuns: number) => void
  /** 1→0 edge, trailing-debounced. */
  onIdle: () => void
  /** Called whenever the active count changes, so the heartbeat ticker can follow it. */
  onActiveCountChange?: (activeRuns: number) => void
}

export interface Queue {
  add(runId: string, notBefore?: number): void
  /** Removes a run from the FIFO. Returns true when it was queued (i.e. not yet processing). */
  remove(runId: string): boolean
  /** Queued in this instance's FIFO, or processing right now. */
  holds(runId: string): boolean
  isQueued(runId: string): boolean
  isProcessing(runId: string): boolean
  /** Marks the end of an attempt: the run either settled or is being re-queued by the caller. */
  finish(runId: string): void
  readonly active: number
  readonly processing: number
  pump(): void
  destroy(): void
}

interface Entry {
  runId: string
  notBefore: number
}

export function createQueue(options: QueueOptions): Queue {
  const fifo: Entry[] = []
  const processing = new Set<string>()
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  /** Deadline `retryTimer` is currently armed for. */
  let retryAt: number | undefined
  let destroyed = false
  let lastActive = 0

  const active = () => fifo.length + processing.size

  const settleEdges = () => {
    const current = active()
    options.onActiveCountChange?.(current)
    if (current > 0 && lastActive === 0) {
      lastActive = current
      if (idleTimer !== undefined) {
        // Still inside the trailing debounce: the host never saw `runtime:idle`, so it is still
        // in the active state and a second `runtime:active` would be thrash, not an edge.
        clearTimeout(idleTimer)
        idleTimer = undefined
        return
      }
      options.onActive(current)
      return
    }
    if (current === 0 && lastActive > 0) {
      lastActive = 0
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idleTimer = undefined
        if (active() === 0 && !destroyed) options.onIdle()
      }, IDLE_DEBOUNCE_MS)
      return
    }
    lastActive = current
  }

  /**
   * Arms the wake-up for the EARLIEST `notBefore` still in the FIFO. `retryDelayMs(attempt)` is
   * normative per run (§2.3 / §3.1), so a run whose 2 s backoff expires first must not wait out
   * another run's 4 s one: a timer already armed for a later deadline is re-armed, not kept.
   */
  const scheduleRetry = () => {
    const due = fifo
      .map((entry) => entry.notBefore)
      .filter((at) => at > options.now())
      .sort((a, b) => a - b)[0]
    if (due === undefined) {
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      retryTimer = undefined
      retryAt = undefined
      return
    }
    if (retryTimer !== undefined && retryAt !== undefined && retryAt <= due) return
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryAt = due
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined
        retryAt = undefined
        queue.pump()
      },
      Math.max(1, due - options.now()),
    )
  }

  const queue: Queue = {
    add(runId, notBefore = 0) {
      if (destroyed) return
      if (processing.has(runId) || fifo.some((entry) => entry.runId === runId)) return
      fifo.push({ runId, notBefore })
      settleEdges()
      queue.pump()
    },
    remove(runId) {
      const at = fifo.findIndex((entry) => entry.runId === runId)
      if (at < 0) return false
      fifo.splice(at, 1)
      settleEdges()
      return true
    },
    holds(runId) {
      return processing.has(runId) || fifo.some((entry) => entry.runId === runId)
    },
    isQueued(runId) {
      return fifo.some((entry) => entry.runId === runId)
    },
    isProcessing(runId) {
      return processing.has(runId)
    },
    finish(runId) {
      processing.delete(runId)
      settleEdges()
      queue.pump()
    },
    get active() {
      return active()
    },
    get processing() {
      return processing.size
    },
    pump() {
      if (destroyed) return
      const now = options.now()
      let index = 0
      while (processing.size < options.concurrency && index < fifo.length) {
        const entry = fifo[index]
        if (entry === undefined) break
        if (entry.notBefore > now) {
          index += 1
          continue
        }
        fifo.splice(index, 1)
        processing.add(entry.runId)
        options.start(entry.runId)
      }
      scheduleRetry()
    },
    destroy() {
      destroyed = true
      fifo.length = 0
      processing.clear()
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      if (retryTimer !== undefined) clearTimeout(retryTimer)
      idleTimer = undefined
      retryTimer = undefined
      retryAt = undefined
    },
  }

  return queue
}
