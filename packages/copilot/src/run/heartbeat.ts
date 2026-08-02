// SPEC-copilot §3.1 — the heartbeat ticker. A queued run in a live queue is NOT abandoned: its
// heartbeat is bumped exactly as a processing run's is, otherwise `concurrency: 1` plus a 30 s
// watchdog terminates every run but the first as `max_attempts` without ever calling the model.
import { HEARTBEAT_MS } from '../constants.ts'

export interface Ticker {
  /** Runs the tick every HEARTBEAT_MS while `active` is true; stops when it is not. */
  sync(active: boolean): void
  stop(): void
}

export function createTicker(onTick: () => void, intervalMs: number = HEARTBEAT_MS): Ticker {
  let timer: ReturnType<typeof setInterval> | undefined
  return {
    sync(active) {
      if (active && timer === undefined) {
        timer = setInterval(onTick, intervalMs)
      } else if (!active && timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    },
    stop() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
