/**
 * The client core's only scheduling primitive (SPEC-swarm §2.4, §2.5).
 *
 * The reconnect ladder and the heartbeat both need a timer, and the client core must typecheck
 * under `lib: ["ES2022"]` with **no `dom` and no `@types/node`** (§13) — where neither
 * `setTimeout` nor `setInterval` is declared. Naming either identifier directly would make the
 * §13 fixture a compile error, which is the failure mode that section exists to catch: a runtime
 * probe with the globals deleted would still pass, because the call never runs in that test.
 *
 * So the host's timer is reached through `globalThis`, looked up **at call time**. That is not a
 * style choice either: a module-level capture would freeze the reference before a test installs
 * fake timers, and every backoff assertion in the suite would then be a real four-second wait.
 *
 * A host with no timer at all (no realistic one exists — service workers, Node and browsers all
 * have `setTimeout`) degrades to "never fires" rather than throwing, because a client that cannot
 * schedule a reconnect must still deliver the intents it can.
 *
 * DOM-free and Node-free.
 */

/** Cancels the pending callback. Idempotent, and safe after it has already fired. */
export type CancelTimer = () => void

type TimerHost = {
  setTimeout?: (callback: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

export const NOOP_CANCEL: CancelTimer = () => {}

export function scheduleAfter(ms: number, callback: () => void): CancelTimer {
  const host = globalThis as TimerHost
  const set = host.setTimeout
  if (typeof set !== 'function') return NOOP_CANCEL
  const handle = set.call(globalThis, callback, Math.max(0, ms))
  let live = true
  return () => {
    if (!live) return
    live = false
    host.clearTimeout?.call(globalThis, handle)
  }
}

/**
 * A self-rearming tick. One of these runs while a client is alive and drives both the heartbeat
 * deadline (§2.4) and the `ack` cadence (§2.4's "every 128 frames **or 1 s**") — two deadlines
 * that would otherwise be two timers racing to fire in an order nothing defines.
 */
export function scheduleEvery(ms: number, callback: () => void): CancelTimer {
  let cancel = NOOP_CANCEL
  let live = true
  const arm = (): void => {
    cancel = scheduleAfter(ms, () => {
      if (!live) return
      callback()
      if (live) arm()
    })
  }
  arm()
  return () => {
    if (!live) return
    live = false
    cancel()
  }
}
