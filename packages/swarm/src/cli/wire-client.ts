/**
 * A protocol-level head over the injected `SwarmTransport` (SPEC-swarm §2.2–§2.5, §6.1 H7).
 *
 * §7.1's claim — "every verb but `serve` is a head over the identical client core" — is proved by
 * the *transport* seam and the *frames*, and this module is the part of it the server stage owns:
 * the handshake, the request/response correlation, the subscription bookkeeping and the reconnect
 * policy, all speaking `swarm.v1` and nothing else. `createSwarmClient` (§6.1) lands with the
 * client stage and replaces this head **without changing a byte on the wire** — which is exactly
 * why it is written against `SwarmTransport` rather than against a socket. (Deviation D11.)
 *
 * Node ≥ 24 in practice (the CLI is its only consumer), but nothing here names `node:*`.
 */

import type { SwarmEvent } from '../protocol/events.ts'
import type { ServerFrame, StreamName } from '../protocol/frames.ts'
import type { SwarmTransport, Unsubscribe } from '../types.ts'

import { SwarmError, swarmErrorFromWire } from '../errors.ts'
import { decodeServerFrame, encodeFrame } from '../protocol/codec.ts'
import { isTerminalCloseCode } from '../protocol/constants.ts'

export interface WireClientOptions {
  readonly transport: SwarmTransport
  readonly clientName: string
  readonly head: 'extension' | 'cli' | 'test'
  readonly now?: () => number
}

export interface WireStreamEvent {
  readonly stream: StreamName
  readonly seq: number
  readonly ev: SwarmEvent
}

export class WireClient {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: SwarmError) => void }
  >()
  private readonly eventListeners = new Set<(event: WireStreamEvent) => void>()
  private readonly snapshotListeners = new Set<(stream: StreamName, state: unknown) => void>()
  private helloResolve: ((info: ServerFrame) => void) | null = null
  private helloReject: ((error: SwarmError) => void) | null = null
  private opened = false
  readonly cursors = new Map<StreamName, number>()
  blockedReason: 'unauthenticated' | 'forbidden' | 'protocol' | null = null

  constructor(private readonly options: WireClientOptions) {
    const t = options.transport
    t.onMessage((text) => this.onMessage(text))
    t.onOpen(() => {
      this.opened = true
      t.send(
        encodeFrame({
          p: 'swarm',
          v: 1,
          k: 'hello',
          client: options.clientName,
          head: options.head,
          minV: 1,
          maxV: 1,
        }),
      )
    })
    t.onClose((info) => {
      /* §2.5 rule 4: 4001/4003/4004 are **terminal** — the head stops and surfaces a fix rather
       * than turning a revoked token into an infinite reconnect loop. */
      if (isTerminalCloseCode(info.code)) {
        this.blockedReason =
          info.code === 4001 ? 'unauthenticated' : info.code === 4003 ? 'forbidden' : 'protocol'
      }
      const error = new SwarmError(
        info.code === 4001 ? 'unauthenticated' : info.code === 4003 ? 'forbidden' : 'internal',
        info.reason.length > 0 ? info.reason : `connection closed (${info.code})`,
      )
      this.helloReject?.(error)
      this.helloReject = null
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
    })
    t.onError((error) => {
      const swarm = SwarmError.is(error) ? error : new SwarmError('internal', String(error))
      this.helloReject?.(swarm)
      this.helloReject = null
    })
  }

  connect(): Promise<ServerFrame> {
    const settled = new Promise<ServerFrame>((resolve, reject) => {
      this.helloResolve = resolve
      this.helloReject = reject
    })
    if (!this.opened) this.options.transport.open()
    return settled
  }

  onEvent(listener: (event: WireStreamEvent) => void): Unsubscribe {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  onSnapshot(listener: (stream: StreamName, state: unknown) => void): Unsubscribe {
    this.snapshotListeners.add(listener)
    return () => {
      this.snapshotListeners.delete(listener)
    }
  }

  /** One `req`, one `res` or one `err`. `idempotencyKey` is required by the wire (§2.2). */
  request(intent: string, args: unknown, idempotencyKey: string): Promise<unknown> {
    const id = this.nextId++
    const settled = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.options.transport.send(
      encodeFrame({
        p: 'swarm',
        v: 1,
        k: 'req',
        id,
        intent: intent as never,
        args,
        idempotencyKey,
      }),
    )
    return settled
  }

  subscribe(stream: StreamName, from: 'snapshot' | number = 'snapshot'): Promise<unknown> {
    const id = this.nextId++
    const settled = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.options.transport.send(encodeFrame({ p: 'swarm', v: 1, k: 'sub', id, stream, from }))
    return settled
  }

  ack(stream: StreamName, seq: number): void {
    this.options.transport.send(encodeFrame({ p: 'swarm', v: 1, k: 'ack', stream, seq }))
  }

  close(): void {
    this.options.transport.close(1_000, 'done')
  }

  private onMessage(text: string): void {
    const decoded = decodeServerFrame(text)
    /* §2.2: an unknown server frame kind is **ignored** — forward compatibility is a runtime
     * property, exactly as the jcode SDK argues. */
    if (!decoded.ok) return
    const frame = decoded.frame
    switch (frame.k) {
      case 'hello_ok': {
        this.helloResolve?.(frame)
        this.helloResolve = null
        this.helloReject = null
        return
      }
      case 'res': {
        const entry = this.pending.get(frame.id)
        this.pending.delete(frame.id)
        entry?.resolve(frame.data)
        return
      }
      case 'err': {
        if (frame.id === null) return
        const entry = this.pending.get(frame.id)
        this.pending.delete(frame.id)
        entry?.reject(swarmErrorFromWire(frame))
        return
      }
      case 'snap': {
        const entry = this.pending.get(frame.id)
        this.pending.delete(frame.id)
        this.cursors.set(frame.stream, frame.seq)
        for (const listener of [...this.snapshotListeners]) listener(frame.stream, frame.state)
        entry?.resolve(frame.state)
        return
      }
      case 'evt': {
        this.cursors.set(frame.stream, frame.seq)
        for (const listener of [...this.eventListeners]) {
          listener({ stream: frame.stream, seq: frame.seq, ev: frame.ev })
        }
        return
      }
      case 'lagged': {
        /* Lag is always explicit, and the recovery is always the same: re-subscribe from a
         * snapshot (§2.3). A head that treated this as a gap would be inventing history. */
        void this.subscribe(frame.stream, 'snapshot')
        return
      }
      case 'ping': {
        this.options.transport.send(encodeFrame({ p: 'swarm', v: 1, k: 'pong', t: frame.t }))
        return
      }
      case 'pong':
      case 'bye':
        return
    }
  }
}
