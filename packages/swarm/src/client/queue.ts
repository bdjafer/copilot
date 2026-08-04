/**
 * Intent dispatch: in-flight requests, the idempotent re-send and the offline queue
 * (SPEC-swarm §2.5 rule 3, §6.3, §6.6, H9, X12).
 *
 * The three rules this module exists for:
 *
 *  1. **An in-flight `req` without an observed `res` is re-sent with the same
 *     `idempotencyKey`** (§2.5 rule 3). The durable cache — keyed `(tokenId, idempotencyKey)`,
 *     TTL 24 h — replays the original response, *including the original error*. Minting a fresh
 *     key on the retry path is how one `land` becomes two commits.
 *  2. **Intents issued while disconnected queue locally and flush in order on reconnect**
 *     (§6.6). Order is the whole contract: a `sendTurn` that overtakes the `createDelegation` it
 *     belongs to is a `not_found`, and the head has no way to tell that from a real one.
 *  3. **A queued turn older than ten minutes is held behind
 *     `notice{kind:'stale-queued-turn'}`** (§6.6). Ten minutes of a laptop lid is enough for the
 *     instruction to be wrong; sending it silently is the one failure the notice exists to stop.
 *     The intent is refused rather than left pending, because `NoticeVM.actions` is how a head
 *     offers "send it anyway" and that action *is* a fresh `sendTurn`.
 *
 * A `bye{retryAfterMs}` suppresses rule 1 until the next `hello_ok` (§2.5 rule 3): re-sending
 * into a server that is closing is how a mutation is attempted twice.
 *
 * DOM-free and Node-free.
 */

import type { SwarmError } from '../errors.ts'
import type { ClientFrame, ErrFrame, IntentName, ResFrame } from '../protocol/frames.ts'
import type { IntentArgs, IntentResponse } from '../protocol/intents.ts'
import type { IntentResult, SwarmClientInspection } from '../types.ts'

import { SERVER_POLICY } from '../domain/constants.ts'
import { SwarmError as SwarmErrorClass, swarmErrorFromWire } from '../errors.ts'
import { SWARM_PROTOCOL, SWARM_PROTOCOL_VERSION } from '../protocol/frames.ts'
import { decodeIntentResponse } from '../protocol/intents.ts'

const envelope = { p: SWARM_PROTOCOL, v: SWARM_PROTOCOL_VERSION } as const

/** The intents §6.6 makes optimistic — and the only ones. Nothing else pre-empts the server. */
export const OPTIMISTIC_INTENTS = ['createDelegation', 'sendTurn'] as const

export interface DispatchRequest<K extends keyof IntentArgs> {
  readonly intent: K
  readonly args: IntentArgs[K]
  readonly idempotencyKey: string
  readonly expectedVersion?: number
  /**
   * Applied when the intent is queued offline and rolled forward by the server's own record on
   * reconnect — "server reconciliation always wins" (X11), so this never resolves a conflict.
   */
  readonly optimistic?: () => void
}

interface PendingRequest {
  readonly id: number
  readonly intent: IntentName
  readonly args: unknown
  readonly idempotencyKey: string
  readonly expectedVersion: number | undefined
  sentAt: number
  readonly settle: (result: IntentResult<unknown>) => void
}

interface QueuedRequest {
  readonly intent: IntentName
  readonly args: unknown
  readonly idempotencyKey: string
  readonly expectedVersion: number | undefined
  readonly queuedAt: number
  readonly settle: (result: IntentResult<unknown>) => void
}

export interface IntentQueueOptions {
  readonly now: () => number
  send(frame: ClientFrame): boolean
  nextRequestId(): number
  /** `err{id:null}` — an error that belongs to no request. */
  onUnattributedError(error: SwarmError): void
  /** A queued turn aged past `staleQueuedTurnMs` at flush time (§6.6). */
  onStaleQueuedTurn(info: { readonly idempotencyKey: string; readonly ageMs: number }): void
  /** `pendingIntents` or `queuedOffline` changed. */
  onChange(): void
}

export interface IntentQueue {
  dispatch<K extends keyof IntentArgs>(
    request: DispatchRequest<K>,
    connected: boolean,
  ): Promise<IntentResult<unknown>>
  /** `true` when the frame was an answer to a tracked request. */
  handleRes(frame: ResFrame): boolean
  handleErr(frame: ErrFrame): boolean
  /** §2.5 rule 3 then §6.6: re-send in flight, then drain the offline queue **in order**. */
  onReconnected(resendSuppressed: boolean): void
  /** Settle everything outstanding — a terminal close, or `destroy()`. */
  abortAll(error: SwarmError): void
  readonly pendingCount: number
  readonly queuedCount: number
  pending(): SwarmClientInspection['pending']
  offline(): SwarmClientInspection['offlineQueue']
  counters(): Record<string, number>
}

export function createIntentQueue(options: IntentQueueOptions): IntentQueue {
  const pending = new Map<number, PendingRequest>()
  const offline: QueuedRequest[] = []
  const counters = { sent: 0, resent: 0, queued: 0, drained: 0, held: 0, answered: 0, refused: 0 }

  const writeReq = (request: PendingRequest): boolean => {
    const frame: ClientFrame = {
      ...envelope,
      k: 'req',
      id: request.id,
      intent: request.intent as IntentName,
      args: request.args,
      idempotencyKey: request.idempotencyKey,
      ...(request.expectedVersion === undefined
        ? {}
        : { expectedVersion: request.expectedVersion }),
    }
    return options.send(frame)
  }

  const settleFromResponse = (
    request: PendingRequest,
    body: IntentResponse | null,
    raw: unknown,
  ): void => {
    if (body === null) {
      request.settle({
        ok: false,
        error: new SwarmErrorClass(
          'internal',
          `malformed response for ${request.intent}: res.data must be { value, version }`,
          { retryable: false, details: { intent: request.intent, data: raw } },
        ),
      })
      return
    }
    request.settle({ ok: true, value: body.value, version: body.version })
  }

  return {
    dispatch(request, connected) {
      return new Promise<IntentResult<unknown>>((resolve) => {
        const at = options.now()
        if (connected) {
          const entry: PendingRequest = {
            id: options.nextRequestId(),
            intent: request.intent as IntentName,
            args: request.args,
            idempotencyKey: request.idempotencyKey,
            expectedVersion: request.expectedVersion,
            sentAt: at,
            settle: resolve,
          }
          if (writeReq(entry)) {
            pending.set(entry.id, entry)
            counters.sent += 1
            options.onChange()
            return
          }
        }
        /* Offline (or the write failed): queue in order, count it, and apply the one optimistic
         * record §6.6 allows. `version: -1` is the marker the projection uses. */
        offline.push({
          intent: request.intent as IntentName,
          args: request.args,
          idempotencyKey: request.idempotencyKey,
          expectedVersion: request.expectedVersion,
          queuedAt: at,
          settle: resolve,
        })
        counters.queued += 1
        request.optimistic?.()
        options.onChange()
      })
    },

    handleRes(frame) {
      const request = pending.get(frame.id)
      if (!request) return false
      pending.delete(frame.id)
      counters.answered += 1
      settleFromResponse(request, decodeIntentResponse(frame.data), frame.data)
      options.onChange()
      return true
    },

    handleErr(frame) {
      if (frame.id === null) {
        options.onUnattributedError(swarmErrorFromWire(frame))
        return true
      }
      const request = pending.get(frame.id)
      if (!request) return false
      pending.delete(frame.id)
      counters.refused += 1
      request.settle({ ok: false, error: swarmErrorFromWire(frame) })
      options.onChange()
      return true
    },

    onReconnected(resendSuppressed) {
      if (!resendSuppressed) {
        for (const request of [...pending.values()].sort((a, b) => a.id - b.id)) {
          request.sentAt = options.now()
          if (writeReq(request)) counters.resent += 1
        }
      }

      /* Drain in order. A single failed write stops the drain: the rest stay queued rather than
       * being reordered behind whatever succeeded next. */
      while (offline.length > 0) {
        const head = offline[0]!
        const ageMs = options.now() - head.queuedAt
        if (head.intent === 'sendTurn' && ageMs > SERVER_POLICY.staleQueuedTurnMs) {
          offline.shift()
          counters.held += 1
          options.onStaleQueuedTurn({ idempotencyKey: head.idempotencyKey, ageMs })
          head.settle({
            ok: false,
            error: new SwarmErrorClass(
              'invalid_spec',
              `queued turn is ${Math.round(ageMs / 60_000)} min old; re-send it if it still applies`,
              {
                retryable: false,
                details: {
                  reason: 'stale-queued-turn',
                  ageMs,
                  idempotencyKey: head.idempotencyKey,
                },
              },
            ),
          })
          continue
        }
        const entry: PendingRequest = {
          id: options.nextRequestId(),
          intent: head.intent,
          args: head.args,
          idempotencyKey: head.idempotencyKey,
          expectedVersion: head.expectedVersion,
          sentAt: options.now(),
          settle: head.settle,
        }
        if (!writeReq(entry)) break
        offline.shift()
        pending.set(entry.id, entry)
        counters.drained += 1
        counters.sent += 1
      }
      options.onChange()
    },

    abortAll(error) {
      const outstanding = [...pending.values()]
      pending.clear()
      const queued = offline.splice(0, offline.length)
      for (const request of outstanding) request.settle({ ok: false, error })
      for (const request of queued) request.settle({ ok: false, error })
      options.onChange()
    },

    get pendingCount() {
      return pending.size
    },
    get queuedCount() {
      return offline.length
    },

    pending() {
      return [...pending.values()].map((request) => ({
        id: request.id,
        intent: request.intent,
        idempotencyKey: request.idempotencyKey,
        sentAt: request.sentAt,
      }))
    },

    offline() {
      return offline.map((request) => ({
        intent: request.intent,
        idempotencyKey: request.idempotencyKey,
        queuedAt: request.queuedAt,
      }))
    },

    counters() {
      return { ...counters }
    },
  }
}
