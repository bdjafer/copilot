/**
 * `fakeJcodeTransport()` — an in-process bridge that reproduces the **verified** SDK and bridge
 * behaviours, so §13's jcode rows can be asserted with no binary (SPEC-swarm §13, [F2]–[F17]).
 *
 * The local jcode is 0.64.2 and has no `api-bridge` at all, so the real executor cannot run here.
 * That makes the fake load-bearing rather than convenient: every behaviour below is one the spec
 * cites a source line for, and each is the *reason* a rule exists.
 *
 *  - **`sendMessage` resolves whether or not the ack arrives** ([F2]). The fake never rejects on a
 *    missing ack, which is what makes `ack:'unknown'` derivable only from the observed event.
 *  - **`error` frames carry no `session_id`** ([F6]) — attributable only per-connection.
 *  - **`tool_input_delta` always carries `call_id: ''`** ([F11]), including with two tools running.
 *  - **`create_session` attaches the creating connection** ([F5]); there is no way to detach.
 *  - **An unattached `ping` is answered bridge-locally** and the five disk-served requests answer
 *    happily with a dead daemon ([F5]) — so a fake daemon death must be invisible to all of them
 *    and visible **only** to a ping naming an attached session.
 *  - **A mid-turn config change parks on the agent mutex** and the SDK rejects at
 *    `requestTimeoutMs` **while the setting still lands at turn end** ([F10]).
 *
 * DOM-free; lives under `src/testing/node/**` because that is where §1.2 puts the jcode tape.
 */

import type {
  JcodeApiEvent,
  JcodeRuntimeInfo,
  JcodeSdkClient,
  JcodeSendOptions,
  JcodeSessionInfo,
  JcodeStructuredOutcome,
  JcodeTransport,
} from '../../server/executor/sdk.ts'
import type { ConformanceTurn } from '../executor-conformance.ts'

/** Every call the fake saw, in order — the assertion surface for §13's "was it called with…" rows. */
export interface RecordedCall {
  readonly type: string
  readonly sessionId: string | null
  readonly params: Readonly<Record<string, unknown>>
  readonly at: number
}

export interface FakeJcodeOptions {
  /** The SDK's `requestTimeoutMs` default (§4.3.3, [F10]). */
  readonly requestTimeoutMs?: number
  readonly sleep?: (ms: number) => Promise<void>
  readonly now?: () => number
  readonly runtimeInfo?: JcodeRuntimeInfo
  readonly capabilities?: readonly string[]
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })

interface FakeSession {
  readonly sessionId: string
  readonly workingDir: string
  title: string | null
  archived: boolean
  turnInFlight: boolean
  readonly scripts: ConformanceTurn[]
  readonly transcript: { role: string; content: string }[]
  /** The config change the daemon parked on, applied at turn end ([F10]). */
  pendingApply: (() => void) | null
  effort: string | null
  model: string | null
}

/**
 * The shared bridge. One per `fakeJcodeTransport()`; every `connect()` returns a *new* client
 * bound to it, exactly as one bridge serves many connections.
 */
export class FakeJcodeBridge {
  readonly calls: RecordedCall[] = []
  readonly sessions = new Map<string, FakeSession>()
  /** Consumers of each session's raw stream, keyed by session id. */
  private readonly subscribers = new Map<string, Set<(e: JcodeApiEvent) => void>>()
  private readonly closers = new Map<string, Set<() => void>>()
  private counter = 0
  daemonAlive = true
  /** [F10]: hold every config reply until the in-flight turn ends. */
  parkConfigMidTurn = true
  retentionPolicy: { archiveAfterDays?: number } | undefined | 'unset' = 'unset'
  readonly credentials = new Map<string, string>()

  constructor(readonly options: FakeJcodeOptions = {}) {}

  readonly now = (): number => (this.options.now ?? Date.now)()
  readonly sleep = (ms: number): Promise<void> => (this.options.sleep ?? defaultSleep)(ms)

  record(type: string, sessionId: string | null, params: Record<string, unknown> = {}): void {
    this.calls.push({ type, sessionId, params, at: this.now() })
  }

  callsOf(type: string): readonly RecordedCall[] {
    return this.calls.filter((c) => c.type === type)
  }

  createSession(workingDir: string, title?: string): FakeSession {
    const sessionId = `fake-session-${++this.counter}`
    const session: FakeSession = {
      sessionId,
      workingDir,
      title: title ?? null,
      archived: false,
      turnInFlight: false,
      scripts: [],
      transcript: [],
      pendingApply: null,
      effort: null,
      model: null,
    }
    this.sessions.set(sessionId, session)
    return session
  }

  require(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw new Error(`invalid_request: no session ${sessionId}`)
    return session
  }

  subscribe(
    sessionId: string,
    listener: (e: JcodeApiEvent) => void,
    onClose: () => void,
  ): () => void {
    let listeners = this.subscribers.get(sessionId)
    if (listeners === undefined) {
      listeners = new Set()
      this.subscribers.set(sessionId, listeners)
    }
    listeners.add(listener)
    let closers = this.closers.get(sessionId)
    if (closers === undefined) {
      closers = new Set()
      this.closers.set(sessionId, closers)
    }
    closers.add(onClose)
    return () => {
      listeners.delete(listener)
      closers.delete(onClose)
    }
  }

  emit(sessionId: string, event: JcodeApiEvent): void {
    for (const listener of Array.from(this.subscribers.get(sessionId) ?? [])) listener(event)
  }

  /** Queue the script the session's next `sendMessage` plays back. */
  script(sessionId: string, turn: ConformanceTurn): void {
    this.require(sessionId).scripts.push(turn)
  }

  /** C12: kill the transport under a session. The stream ends; there is no replay (§5.4 #2). */
  disconnect(sessionId: string, reason = 'instance died'): void {
    const session = this.sessions.get(sessionId)
    if (session !== undefined) session.turnInFlight = false
    this.emit(sessionId, { ev: 'closed', reason })
    for (const close of Array.from(this.closers.get(sessionId) ?? [])) close()
  }

  /** [F6]: an error frame with **no** `session_id`, delivered on one session's connection. */
  emitError(sessionId: string, code: string, message: string): void {
    this.emit(sessionId, { ev: 'error', code, message })
  }

  /**
   * The daemon dies while the bridge stays up ([F5], §13). Disk-served requests keep answering;
   * only a `ping` naming an attached session may notice.
   */
  killDaemon(): void {
    this.daemonAlive = false
  }

  async play(sessionId: string, turn: ConformanceTurn): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    await this.sleep(0)
    if (turn.ack !== false) this.emit(sessionId, { ev: 'message_accepted', session_id: sessionId })
    if (turn.text !== undefined) {
      await this.sleep(0)
      this.emit(sessionId, { ev: 'text_delta', session_id: sessionId, text: turn.text })
      session.transcript.push({ role: 'assistant', content: turn.text })
    }
    for (const tool of turn.tools ?? []) {
      await this.sleep(0)
      this.emit(sessionId, {
        ev: 'tool_start',
        session_id: sessionId,
        id: tool.callId,
        name: tool.name,
      })
      if (tool.input !== undefined) {
        /* [F11]: the bridge hard-codes an EMPTY call id here, always. */
        this.emit(sessionId, {
          ev: 'tool_input_delta',
          session_id: sessionId,
          call_id: '',
          delta: tool.input,
        })
      }
      this.emit(sessionId, {
        ev: 'tool_exec',
        session_id: sessionId,
        id: tool.callId,
        name: tool.name,
      })
      this.emit(sessionId, {
        ev: 'tool_done',
        session_id: sessionId,
        id: tool.callId,
        name: tool.name,
        output: '',
      })
    }
    if (turn.usage === true) {
      await this.sleep(0)
      this.emit(sessionId, {
        ev: 'usage',
        session_id: sessionId,
        input_tokens: 10,
        output_tokens: 20,
      })
    }
    if (turn.disconnectMidTurn === true) {
      await this.sleep(0)
      this.disconnect(sessionId, 'mid-turn disconnect')
      return
    }
    if (turn.turnDone !== false) {
      await this.sleep(0)
      this.endTurn(sessionId)
    }
  }

  /** Ends the turn and applies whatever the daemon parked on ([F10]) — the side effect that lands. */
  endTurn(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    session.turnInFlight = false
    const pending = session.pendingApply
    session.pendingApply = null
    pending?.()
    this.emit(sessionId, { ev: 'turn_done', session_id: sessionId })
  }
}

/** One connection. `attachedSessionId` is the whole of §5.3's topology, made observable. */
class FakeJcodeClient implements JcodeSdkClient {
  attachedSessionId: string | null = null
  private closed = false
  private readonly queue: JcodeApiEvent[] = []
  private wake: (() => void) | null = null
  private ended = false
  private release: (() => void) | null = null

  constructor(private readonly bridge: FakeJcodeBridge) {}

  private attach(sessionId: string): void {
    this.release?.()
    this.attachedSessionId = sessionId
    this.release = this.bridge.subscribe(
      sessionId,
      (event) => {
        this.queue.push(event)
        this.wake?.()
      },
      () => {
        this.ended = true
        this.wake?.()
      },
    )
  }

  events(): AsyncIterableIterator<JcodeApiEvent> {
    const iterator: AsyncIterableIterator<JcodeApiEvent> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async (): Promise<IteratorResult<JcodeApiEvent>> => {
        for (;;) {
          const value = this.queue.shift()
          if (value !== undefined) return { value, done: false }
          if (this.ended || this.closed) return { value: undefined, done: true }
          await new Promise<void>((resolve) => {
            this.wake = resolve
          })
          this.wake = null
        }
      },
      return: async (): Promise<IteratorResult<JcodeApiEvent>> => {
        this.ended = true
        return { value: undefined, done: true }
      },
    }
    return iterator
  }

  createSession(req: { workingDir: string; title?: string }): Promise<{ sessionId: string }> {
    this.bridge.record('create_session', null, { ...req })
    const session = this.bridge.createSession(req.workingDir, req.title)
    /* [F5]: `create_session` and `attach_session` are the same branch — the creating connection
     * becomes attached, and nothing can undo it. */
    this.attach(session.sessionId)
    return Promise.resolve({ sessionId: session.sessionId })
  }

  attachSession(sessionId: string): Promise<void> {
    this.bridge.record('attach_session', sessionId)
    this.bridge.require(sessionId)
    this.attach(sessionId)
    return Promise.resolve()
  }

  /** Resolves whether or not the ack arrives — the whole of [F2] in one line. */
  sendMessage(sessionId: string, text: string, options?: JcodeSendOptions): Promise<void> {
    this.bridge.record('send_message', sessionId, { text, ...(options ?? {}) })
    const session = this.bridge.require(sessionId)
    session.transcript.push({ role: 'user', content: text })
    const script = session.scripts.shift() ?? {
      ack: true,
      text: 'ok',
      turnDone: options?.noReply !== true,
    }
    if (options?.noReply !== true) session.turnInFlight = true
    /* A `noReply` message never starts a turn and never produces `turn_done` (#32). */
    void this.bridge.play(sessionId, options?.noReply === true ? { ack: script.ack } : script)
    return Promise.resolve()
  }

  setModel(sessionId: string, model: string): Promise<void> {
    this.bridge.record('set_model', sessionId, { model })
    const session = this.bridge.require(sessionId)
    return this.applyOrPark(session, () => {
      session.model = model
      this.bridge.emit(sessionId, {
        ev: 'model_info',
        session_id: sessionId,
        model,
        solicited: true,
      })
    })
  }

  setReasoningEffort(sessionId: string, effort: string | null): Promise<void> {
    this.bridge.record('set_reasoning_effort', sessionId, { effort })
    const session = this.bridge.require(sessionId)
    return this.applyOrPark(session, () => {
      session.effort = effort
    })
  }

  /**
   * [F10]: mid-turn, the daemon parks on `agent.try_lock()` and sends **no reply until the turn
   * ends**, so the SDK rejects at `requestTimeoutMs` — *and the setting still lands*. The reject
   * and the side effect are both real, which is exactly why §4.3.3 refuses client-side.
   */
  private applyOrPark(session: FakeSession, apply: () => void): Promise<void> {
    if (!session.turnInFlight || !this.bridge.parkConfigMidTurn) {
      apply()
      return Promise.resolve()
    }
    /* The side effect is registered now and lands at turn end, whatever the caller does with the
     * rejection below — an error whose side effect succeeds, on a turn the user never targeted. */
    session.pendingApply = apply
    return new Promise<void>((_, reject) => {
      void this.bridge
        .sleep(this.bridge.options.requestTimeoutMs ?? 30_000)
        .then(() => reject(new Error("HarnessError('timeout')")))
    })
  }

  softInterrupt(sessionId: string, text: string, urgent?: boolean): Promise<void> {
    this.bridge.record('soft_interrupt', sessionId, { text, urgent: urgent === true })
    this.bridge.require(sessionId)
    /* §5.4 #10: `soft_interrupt_injected` is NOT translated, so nothing is emitted and the
     * landing is permanently `'unconfirmed'`. */
    return Promise.resolve()
  }

  cancel(sessionId: string): Promise<void> {
    this.bridge.record('cancel', sessionId)
    this.bridge.endTurn(sessionId)
    return Promise.resolve()
  }

  cancelSoftInterrupts(sessionId: string): Promise<void> {
    this.bridge.record('cancel_soft_interrupts', sessionId)
    return Promise.resolve()
  }

  runStructured<T>(
    sessionId: string,
    text: string,
    options: { schema: unknown; maxRetries?: number },
  ): Promise<JcodeStructuredOutcome<T>> {
    this.bridge.record('run_structured', sessionId, { text, maxRetries: options.maxRetries ?? 2 })
    const session = this.bridge.require(sessionId)
    session.transcript.push({ role: 'user', content: text })
    const raw = JSON.stringify({ score: 1, rationale: 'fake judge', failures: [] })
    return Promise.resolve({
      value: JSON.parse(raw) as T,
      attempts: 1,
      raw: [raw],
      failed: false,
    })
  }

  /** Answered from disk — happily, with a dead daemon ([F5]). */
  peekSession(
    sessionId: string,
    limit: number,
  ): Promise<readonly { role: string; content: string }[]> {
    this.bridge.record('peek_session', sessionId, { limit })
    const session = this.bridge.require(sessionId)
    return Promise.resolve(session.transcript.slice(-limit).map((row) => ({ ...row })))
  }

  listSessions(): Promise<readonly JcodeSessionInfo[]> {
    this.bridge.record('list_sessions', null)
    return Promise.resolve(
      [...this.bridge.sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        workingDir: session.workingDir,
        /* The vocabulary lies: a running session reports `idle` (#18, §5.4 #4). */
        status: 'idle',
        archived: session.archived,
        ...(session.title === null ? {} : { title: session.title }),
      })),
    )
  }

  archiveSession(sessionId: string): Promise<void> {
    this.bridge.record('archive_session', sessionId)
    this.bridge.require(sessionId).archived = true
    return Promise.resolve()
  }

  renameSession(sessionId: string, title: string | null): Promise<void> {
    this.bridge.record('rename_session', sessionId, { title })
    this.bridge.require(sessionId).title = title
    return Promise.resolve()
  }

  setRetentionPolicy(policy: { archiveAfterDays?: number } | undefined): Promise<void> {
    this.bridge.record('set_retention_policy', null, { policy: policy ?? null })
    this.bridge.retentionPolicy = policy
    return Promise.resolve()
  }

  setApiKey(provider: string, apiKey: string): Promise<void> {
    this.bridge.record('set_api_key', null, { provider })
    if (!JCODE_PROVIDER_SET.has(provider)) return Promise.reject(new Error('invalid_request'))
    this.bridge.credentials.set(provider, apiKey)
    return Promise.resolve()
  }

  getRuntimeInfo(): Promise<JcodeRuntimeInfo> {
    this.bridge.record('get_runtime_info', this.attachedSessionId)
    return Promise.resolve(
      this.bridge.options.runtimeInfo ?? {
        server: 'fake-bridge',
        protocolVersion: 1,
        capabilities: this.bridge.options.capabilities ?? [],
        providers: ['anthropic'],
        routes: [
          {
            model: 'claude-opus-5',
            provider: 'anthropic',
            apiMethod: 'messages',
            available: true,
            detail: 'fake',
          },
        ],
        /* Hard-coded on the real one too, which is why [F14] drops it at the seam. */
        healthy: true,
      },
    )
  }

  /**
   * With **no** session id this is answered bridge-locally and proves nothing ([F5]) — it must
   * keep resolving with a dead daemon, or a test could not tell the two pings apart. With one, it
   * is a round trip to the daemon and fails when the daemon is gone.
   */
  ping(sessionId?: string): Promise<void> {
    this.bridge.record('ping', sessionId ?? null)
    if (sessionId === undefined) return Promise.resolve()
    if (!this.bridge.daemonAlive) return Promise.reject(new Error('daemon is not responding'))
    return Promise.resolve()
  }

  supports(capability: string): boolean {
    return (this.bridge.options.capabilities ?? []).includes(capability)
  }

  close(): Promise<void> {
    this.closed = true
    this.ended = true
    this.release?.()
    this.wake?.()
    return Promise.resolve()
  }
}

const JCODE_PROVIDER_SET: ReadonlySet<string> = new Set([
  'claude-api',
  'openai-api',
  'openrouter',
  'cursor',
  'gemini',
  'jcode',
])

export interface FakeJcodeTransport extends JcodeTransport {
  readonly bridge: FakeJcodeBridge
  /** Every client this transport handed out — one per connection, exactly as §5.3 requires. */
  readonly clients: readonly { readonly attachedSessionId: string | null }[]
}

export function fakeJcodeTransport(options: FakeJcodeOptions = {}): FakeJcodeTransport {
  const bridge = new FakeJcodeBridge(options)
  const clients: FakeJcodeClient[] = []
  return {
    bridge,
    clients,
    connect(): Promise<JcodeSdkClient> {
      const client = new FakeJcodeClient(bridge)
      clients.push(client)
      return Promise.resolve(client)
    },
  }
}
