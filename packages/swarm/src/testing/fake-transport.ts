/**
 * A scripted `SwarmTransport` with no server behind it (SPEC-swarm §6.1's H7, §13).
 *
 * `createInMemoryTransport()` (§1.1) is the *other* fake: it runs the real client against a real
 * embedded server and lands with the server stage. This one is the opposite tool and is worth
 * having on its own — it lets a test write the exact frame sequence a server would have to
 * produce to trigger a rule, **including the sequences a correct server never produces**: a `seq`
 * gap, a `lagged` on a stream nobody asked to lag, a `snap` before `hello_ok`. Those are the
 * cases §2.2–§2.3 legislate for, and a real server cannot be asked to perform them.
 *
 * Nothing here is a mock of the client: the client under test is the shipped one, and every
 * assertion is made against the bytes it wrote.
 *
 * DOM-free and Node-free.
 */

import type { SwarmErrorCode } from '../errors.ts'
import type { SwarmEvent } from '../protocol/events.ts'
import type {
  ClientFrame,
  ReqFrame,
  ServerCapability,
  ServerFrame,
  StreamName,
  SubFrame,
} from '../protocol/frames.ts'
import type { SwarmTransport, Unsubscribe } from '../types.ts'

import { decodeClientFrame, encodeFrame } from '../protocol/codec.ts'
import { SWARM_PROTOCOL, SWARM_PROTOCOL_VERSION } from '../protocol/frames.ts'

const envelope = { p: SWARM_PROTOCOL, v: SWARM_PROTOCOL_VERSION } as const

export interface FakeTransportOptions {
  /** `open()` fires `onOpen` synchronously. Default `true` — most tests want a live socket. */
  readonly autoAccept?: boolean
}

export interface HandshakeOptions {
  readonly serverVersion?: string
  readonly capabilities?: readonly ServerCapability[]
  readonly connectionId?: string
  readonly serverTimeMs?: number
}

export interface FakeTransport extends SwarmTransport {
  /** Every frame the client wrote, decoded. A frame that fails to decode is a client bug. */
  readonly sent: readonly ClientFrame[]
  readonly sentText: readonly string[]
  readonly opens: number
  readonly closes: readonly { code?: number; reason?: string }[]
  readonly isOpen: boolean

  /** Fire `onOpen` — only needed with `autoAccept: false`. */
  accept(): void
  /** `accept()` (if needed) then `hello_ok`. */
  handshake(options?: HandshakeOptions): void
  deliver(frame: ServerFrame): void
  /** Raw text, for malformed-envelope cases §2.2 makes fatal. */
  deliverText(text: string): void
  serverClose(code: number, reason?: string): void
  raiseError(error: unknown): void

  /** Client frames of one kind, in order. */
  of<K extends ClientFrame['k']>(kind: K): readonly Extract<ClientFrame, { k: K }>[]
  /** The most recent `req` for an intent, or the most recent `req` at all. */
  lastReq(intent?: string): ReqFrame | undefined
  /** The most recent `sub` for a stream. */
  lastSub(stream: StreamName): SubFrame | undefined

  /** `res{id, data:{value, version}}`. */
  respond(id: number, value: unknown, version?: number): void
  fail(id: number | null, code: SwarmErrorCode, message?: string, retryable?: boolean): void
  /** `snap` answering the outstanding `sub` for that stream. */
  snap(stream: StreamName, seq: number, state: unknown): void
  evt(stream: StreamName, seq: number, event: SwarmEvent, ts?: number): void
  lagged(
    stream: StreamName,
    fromSeq: number,
    reason?: 'backpressure' | 'retention' | 'server_restart',
  ): void

  /** Forget everything written so far; the socket state is untouched. */
  clearSent(): void
}

export function createFakeTransport(options: FakeTransportOptions = {}): FakeTransport {
  const autoAccept = options.autoAccept ?? true
  const sent: ClientFrame[] = []
  const sentText: string[] = []
  const closes: { code?: number; reason?: string }[] = []
  const openCbs = new Set<() => void>()
  const messageCbs = new Set<(text: string) => void>()
  const closeCbs = new Set<(info: { code: number; reason: string; wasClean: boolean }) => void>()
  const errorCbs = new Set<(error: unknown) => void>()
  let opens = 0
  let isOpen = false
  let ts = 1_000

  const subscribeTo = <T>(set: Set<T>, cb: T): Unsubscribe => {
    set.add(cb)
    return () => {
      set.delete(cb)
    }
  }

  const push = (frame: ServerFrame): void => {
    const text = encodeFrame(frame)
    for (const cb of Array.from(messageCbs)) cb(text)
  }

  const transport: FakeTransport = {
    open() {
      opens += 1
      if (autoAccept) transport.accept()
    },
    send(text) {
      sentText.push(text)
      const decoded = decodeClientFrame(text)
      if (!decoded.ok)
        throw new Error(`fake transport: client wrote an invalid frame — ${decoded.message}`)
      sent.push(decoded.frame)
    },
    close(code, reason) {
      closes.push({
        ...(code === undefined ? {} : { code }),
        ...(reason === undefined ? {} : { reason }),
      })
      if (!isOpen) return
      isOpen = false
      for (const cb of Array.from(closeCbs)) {
        cb({ code: code ?? 1000, reason: reason ?? '', wasClean: true })
      }
    },
    onOpen: (cb) => subscribeTo(openCbs, cb),
    onMessage: (cb) => subscribeTo(messageCbs, cb),
    onClose: (cb) => subscribeTo(closeCbs, cb),
    onError: (cb) => subscribeTo(errorCbs, cb),

    get sent() {
      return sent
    },
    get sentText() {
      return sentText
    },
    get opens() {
      return opens
    },
    get closes() {
      return closes
    },
    get isOpen() {
      return isOpen
    },

    accept() {
      if (isOpen) return
      isOpen = true
      for (const cb of Array.from(openCbs)) cb()
    },

    handshake(handshakeOptions = {}) {
      transport.accept()
      push({
        ...envelope,
        k: 'hello_ok',
        server: 'swarm-fake',
        serverVersion: handshakeOptions.serverVersion ?? '0.1.0',
        connectionId: handshakeOptions.connectionId ?? 'conn-1',
        capabilities: handshakeOptions.capabilities ?? ['replay', 'snapshot'],
        serverTimeMs: handshakeOptions.serverTimeMs ?? 1_000,
      })
    },

    deliver: push,

    deliverText(text) {
      for (const cb of Array.from(messageCbs)) cb(text)
    },

    serverClose(code, reason = '') {
      if (!isOpen) return
      isOpen = false
      for (const cb of Array.from(closeCbs)) cb({ code, reason, wasClean: false })
    },

    raiseError(error) {
      for (const cb of Array.from(errorCbs)) cb(error)
    },

    of(kind) {
      return sent.filter(
        (frame): frame is Extract<ClientFrame, { k: typeof kind }> => frame.k === kind,
      )
    },

    lastReq(intent) {
      const reqs = sent.filter((frame): frame is ReqFrame => frame.k === 'req')
      const matching = intent === undefined ? reqs : reqs.filter((frame) => frame.intent === intent)
      return matching[matching.length - 1]
    },

    lastSub(stream) {
      const subs = sent.filter(
        (frame): frame is SubFrame => frame.k === 'sub' && frame.stream === stream,
      )
      return subs[subs.length - 1]
    },

    respond(id, value, version = 1) {
      push({ ...envelope, k: 'res', id, data: { value, version } })
    },

    fail(id, code, message = code, retryable = false) {
      push({ ...envelope, k: 'err', id, code, message, retryable })
    },

    snap(stream, seq, state) {
      const sub = transport.lastSub(stream)
      if (sub === undefined) throw new Error(`fake transport: no sub observed for ${stream}`)
      push({ ...envelope, k: 'snap', id: sub.id, stream, seq, state })
    },

    evt(stream, seq, event, at) {
      ts += 1
      push({ ...envelope, k: 'evt', stream, seq, ts: at ?? ts, ev: event })
    },

    lagged(stream, fromSeq, reason = 'retention') {
      push({ ...envelope, k: 'lagged', stream, fromSeq, reason })
    },

    clearSent() {
      sent.length = 0
      sentText.length = 0
    },
  }

  return transport
}
