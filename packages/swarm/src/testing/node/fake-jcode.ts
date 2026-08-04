/**
 * `fakeJcodeTransport()` — an in-process bridge that reproduces the **verified** SDK and bridge
 * behaviours, so §13's jcode rows can be asserted with no binary (SPEC-swarm §13, [F2]–[F17]).
 *
 * Every behaviour below was re-derived on 2026-08-04 from `@1jehuang/jcode-sdk@1.1.0` and a live
 * `jcode v0.67.0 (156ae4092)` `api-bridge` — throwaway `JCODE_HOME`, no credentials, no model
 * turn. `test/real-bridge.test.ts` runs the same assertions against the real binary under
 * `SWARM_REAL_BRIDGE=1`; this file is what makes them runnable in a hermetic CI. Where the two
 * can diverge, the fake is the one that is wrong, so each rule names what it is imitating:
 *
 *  - **`sendMessage` resolves whether or not the ack arrives** ([F2]) — the SDK's `waitForEvent`
 *    resolves on timeout, so `ack:'unknown'` is derivable only from the observed event.
 *  - **`error` frames carry no `session_id`** ([F6]) — attributable only per-connection.
 *  - **`create_session` on an already-attached connection creates nothing** and returns the
 *    attached session. This is the one that collapses a fleet onto one agent if the adapter
 *    creates on a shared connection.
 *  - **`attach_session` never fails on an unknown id**: it returns the current attachment, or
 *    **manufactures a session** on a connection that has none.
 *  - **Session-scoped requests are attachment-scoped** and refuse with the bridge's verbatim
 *    `unknown_session: …` — except `peek_session` and `archive_session`, which answer for any
 *    session from any connection.
 *  - **`peek_session` is the stored tail and lags without bound**: it never carries what this
 *    session sent, only jcode's injected session-context reminder, while `get_history` has the
 *    message immediately — and flattens block content to `''` ([F8], #45).
 *  - **A dead daemon kills everything**: an `error{internal,'daemon connection closed'}` on every
 *    attached connection, then every request fails. [F5]'s "five disk-served requests stay green"
 *    does not hold, so the fake must not pretend it does.
 *  - **A mid-turn config change parks on the agent mutex** and the SDK rejects at
 *    `requestTimeoutMs` **while the setting still lands at turn end** ([F10]).
 *  - **`events()` on a closed client yields a closed iterator**, matching the mitigation
 *    `sdk-transport.ts` has to make because the real one hangs.
 *
 * DOM-free; lives under `src/testing/node/**` because that is where §1.2 puts the jcode tape.
 */

import type {
  JcodeApiEvent,
  JcodeErrorCode,
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
  /** The bridge's cwd — where `attach_session` puts a session it had to manufacture. */
  readonly bridgeCwd?: string
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })

/** The bridge's own words, verbatim from 0.67.0. */
const unknownSession = (attached: string | null, requested: string): Error =>
  Object.assign(
    new Error(
      `unknown_session: this connection is attached to \`${attached ?? ''}\`, not ` +
        `\`${requested}\`; attach to it first or use another connection`,
    ),
    { code: 'unknown_session' as JcodeErrorCode },
  )

const invalidRequest = (message: string): Error =>
  Object.assign(new Error(`invalid_request: ${message}`), {
    code: 'invalid_request' as JcodeErrorCode,
  })

/** What every request throws once the daemon is gone — including the "disk-served" ones. */
const daemonGone = (): Error => new Error('harness connection closed')

interface FakeSession {
  readonly sessionId: string
  workingDir: string
  title: string | null
  /** The generated title `rename_session(undefined)` restores. */
  readonly generatedTitle: string
  archived: boolean
  turnInFlight: boolean
  readonly scripts: ConformanceTurn[]
  /**
   * The **live** transcript — what `get_history` answers. Separate from `stored` because the two
   * genuinely disagree on the real bridge, which is the whole point of the peek/history merge.
   */
  readonly history: { role: string; content: string }[]
  /**
   * The **stored** tail — what `peek_session` answers. Seeded with jcode's injected
   * session-context reminder and never written to by a send, because that is what was observed:
   * a `noReply` message was still absent 3 s later.
   */
  readonly stored: { role: string; content: string }[]
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
  retentionPolicy: number | undefined | 'unset' = 'unset'
  readonly credentials = new Map<string, string>()
  /** In-flight `play()` calls, so a harness can await quiescence instead of a wall clock. */
  private readonly playing = new Set<Promise<void>>()

  readonly options: FakeJcodeOptions

  /* Declared, not a TypeScript parameter property: Node ≥ 24 runs `.ts` strip-only and cannot
   * erase one, which would break `node src/cli.ts` and the spawned demo server. */
  constructor(options: FakeJcodeOptions = {}) {
    this.options = options
  }

  readonly now = (): number => (this.options.now ?? Date.now)()
  readonly sleep = (ms: number): Promise<void> => (this.options.sleep ?? defaultSleep)(ms)

  get bridgeCwd(): string {
    return this.options.bridgeCwd ?? '/'
  }

  record(type: string, sessionId: string | null, params: Record<string, unknown> = {}): void {
    this.calls.push({ type, sessionId, params, at: this.now() })
  }

  callsOf(type: string): readonly RecordedCall[] {
    return this.calls.filter((c) => c.type === type)
  }

  createSession(workingDir: string): FakeSession {
    const generatedTitle = `fake-title-${this.counter + 1}`
    const sessionId = `fake-session-${++this.counter}`
    const session: FakeSession = {
      sessionId,
      workingDir,
      title: null,
      generatedTitle,
      archived: false,
      turnInFlight: false,
      scripts: [],
      history: [],
      /* jcode injects one of these on creation; it is what a fresh `peek_session` returns. */
      stored: [
        { role: 'user', content: '<system-reminder>\n# Session Context\n</system-reminder>' },
      ],
      pendingApply: null,
      effort: null,
      model: null,
    }
    this.sessions.set(sessionId, session)
    return session
  }

  require(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId)
    if (session === undefined) throw invalidRequest(`no session ${sessionId}`)
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

  /**
   * C12: kill the transport under a session. The stream ends; there is no replay (§5.4 #2).
   *
   * There is **no `closed` event** on protocol v1 — the iterator simply ends — so the fake ends
   * it rather than inventing a frame the real bridge never sends.
   */
  disconnect(sessionId: string, _reason = 'instance died'): void {
    const session = this.sessions.get(sessionId)
    if (session !== undefined) session.turnInFlight = false
    for (const close of Array.from(this.closers.get(sessionId) ?? [])) close()
  }

  /** [F6]: an error frame with **no** `session_id`, delivered on one session's connection. */
  emitError(sessionId: string, code: JcodeErrorCode, message: string): void {
    this.emit(sessionId, { ev: 'error', code, message })
  }

  /**
   * The daemon dies while the bridge process stays up.
   *
   * Verified shape: `error{code:'internal', message:'daemon connection closed'}` on **every**
   * attached connection, each connection then closed, and every subsequent request — including
   * the ones [F5] believed were served from disk — failing. Nothing stays green.
   */
  killDaemon(): void {
    this.daemonAlive = false
    for (const sessionId of Array.from(this.subscribers.keys())) {
      this.emit(sessionId, { ev: 'error', code: 'internal', message: 'daemon connection closed' })
    }
    for (const sessionId of Array.from(this.closers.keys())) {
      for (const close of Array.from(this.closers.get(sessionId) ?? [])) close()
    }
  }

  assertDaemon(): void {
    if (!this.daemonAlive) throw daemonGone()
  }

  /**
   * Resolves once every scripted turn this bridge is playing has finished.
   *
   * A **negative** claim about a stream ("no second turn ever ran") otherwise has to be made
   * against a wall-clock window, which is a race the moment CI is loaded. This is the barrier
   * that replaces it.
   */
  async quiesce(): Promise<void> {
    while (this.playing.size > 0) await Promise.all(Array.from(this.playing))
  }

  play(sessionId: string, turn: ConformanceTurn): void {
    const run = this.playTurn(sessionId, turn).finally(() => {
      this.playing.delete(run)
    })
    this.playing.add(run)
  }

  private async playTurn(sessionId: string, turn: ConformanceTurn): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) return
    await this.sleep(0)
    if (turn.ack !== false) this.emit(sessionId, { ev: 'message_accepted', session_id: sessionId })
    if (turn.text !== undefined) {
      await this.sleep(0)
      this.emit(sessionId, { ev: 'text_delta', session_id: sessionId, text: turn.text })
      session.history.push({ role: 'assistant', content: turn.text })
    }
    for (const tool of turn.tools ?? []) {
      await this.sleep(0)
      this.emit(sessionId, {
        ev: 'tool_start',
        session_id: sessionId,
        call_id: tool.callId,
        name: tool.name,
      })
      if (tool.input !== undefined) {
        /* [F11]: the bridge was verified to hard-code an EMPTY call id here. Whether 0.67.0 still
         * does is unreachable without a model turn, so the fake keeps emitting the empty one —
         * the case the adapter's attribution exists for. */
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
        call_id: tool.callId,
        name: tool.name,
      })
      this.emit(sessionId, {
        ev: 'tool_done',
        session_id: sessionId,
        call_id: tool.callId,
        name: tool.name,
        output: '',
      })
    }
    if (turn.usage === true) {
      await this.sleep(0)
      this.emit(sessionId, { ev: 'token_usage', session_id: sessionId, input: 10, output: 20 })
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

const infoOf = (session: FakeSession, status: string): JcodeSessionInfo => ({
  sessionId: session.sessionId,
  workingDir: session.workingDir,
  status,
  archived: session.archived,
  /* Verified: 0.67.0 never populates `title` on `SessionInfo`, even right after a rename. */
})

/** One connection. `attachedSessionId` is the whole of §5.3's topology, made observable. */
class FakeJcodeClient implements JcodeSdkClient {
  attachedSessionId: string | null = null
  private closed = false
  private readonly queue: JcodeApiEvent[] = []
  private wake: (() => void) | null = null
  private ended = false
  private release: (() => void) | null = null

  private readonly bridge: FakeJcodeBridge

  /* Declared, not a TypeScript parameter property: Node ≥ 24 runs `.ts` strip-only and cannot
   * erase one, which would break `node src/cli.ts` and the spawned demo server. */
  constructor(bridge: FakeJcodeBridge) {
    this.bridge = bridge
  }

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

  /**
   * The attachment gate every session-scoped request but `peek_session` and `archive_session`
   * passes through, with the bridge's verbatim refusal.
   */
  private scoped(sessionId: string): FakeSession {
    this.bridge.assertDaemon()
    if (this.attachedSessionId !== sessionId) {
      throw unknownSession(this.attachedSessionId, sessionId)
    }
    return this.bridge.require(sessionId)
  }

  events(): AsyncIterableIterator<JcodeApiEvent> {
    /* The real SDK's `events()` registers `once('close')`, so on an already-closed client the
     * iterator never settles. `sdk-transport.ts` mitigates that by returning a done iterator, and
     * the fake matches the mitigated shape so both sides of the port behave alike. */
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

  /**
   * On an **unattached** connection this creates a session. On an attached one it creates
   * nothing and returns the attachment — verified, and the reason the adapter must never create
   * on a shared connection.
   */
  createSession(req: { workingDir: string }): Promise<JcodeSessionInfo> {
    this.bridge.record('create_session', null, { ...req })
    this.bridge.assertDaemon()
    if (this.attachedSessionId !== null) {
      const current = this.bridge.require(this.attachedSessionId)
      return Promise.resolve(infoOf(current, 'idle'))
    }
    const session = this.bridge.createSession(req.workingDir)
    /* [F5]: `create_session` attaches the creating connection, and nothing can undo it. */
    this.attach(session.sessionId)
    return Promise.resolve(infoOf(session, 'idle'))
  }

  /**
   * Never fails on an unknown id. With an attachment it answers the attachment; without one it
   * **manufactures** a session in the bridge's cwd. Both look like success, which is why the
   * adapter compares the returned id with the requested one.
   */
  attachSession(sessionId: string): Promise<JcodeSessionInfo> {
    this.bridge.record('attach_session', sessionId)
    this.bridge.assertDaemon()
    const known = this.bridge.sessions.get(sessionId)
    if (known !== undefined) {
      this.attach(sessionId)
      return Promise.resolve(infoOf(known, 'idle'))
    }
    if (this.attachedSessionId !== null) {
      const current = this.bridge.require(this.attachedSessionId)
      return Promise.resolve(infoOf(current, 'idle'))
    }
    const manufactured = this.bridge.createSession(this.bridge.bridgeCwd)
    this.attach(manufactured.sessionId)
    return Promise.resolve(infoOf(manufactured, 'idle'))
  }

  /** Resolves whether or not the ack arrives — the whole of [F2] in one line. */
  sendMessage(sessionId: string, text: string, options?: JcodeSendOptions): Promise<void> {
    this.bridge.record('send_message', sessionId, { text, ...(options ?? {}) })
    const session = this.scoped(sessionId)
    /* The live transcript has it immediately; the stored tail never gets it (verified). */
    session.history.push({ role: 'user', content: text })
    const script = session.scripts.shift() ?? {
      ack: true,
      text: 'ok',
      turnDone: options?.noReply !== true,
    }
    if (options?.noReply !== true) session.turnInFlight = true
    /* A `noReply` message never starts a turn: no `message_accepted`, no `turn_done` (#32). */
    if (options?.noReply !== true) this.bridge.play(sessionId, script)
    return Promise.resolve()
  }

  setModel(sessionId: string, model: string): Promise<void> {
    this.bridge.record('set_model', sessionId, { model })
    const session = this.scoped(sessionId)
    if (model === '') return Promise.reject(invalidRequest('set_model needs a non-empty `model`'))
    return this.applyOrPark(session, () => {
      session.model = model
      this.bridge.emit(sessionId, { ev: 'model_info', session_id: sessionId, model })
    })
  }

  /**
   * `effort` is a required non-empty string on the wire — there is no "unset" — and the empty
   * check is bridge-side, ahead of any provider lookup, so it is the one rejection reachable
   * without credentials.
   */
  setReasoningEffort(sessionId: string, effort: string): Promise<void> {
    this.bridge.record('set_reasoning_effort', sessionId, { effort })
    const session = this.scoped(sessionId)
    if (effort === '') {
      return Promise.reject(invalidRequest('set_reasoning_effort needs a non-empty `effort`'))
    }
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
    this.scoped(sessionId)
    /* §5.4 #10: `soft_interrupt_injected` is NOT translated, so nothing is emitted and the
     * landing is permanently `'unconfirmed'`. */
    return Promise.resolve()
  }

  cancel(sessionId: string): Promise<void> {
    this.bridge.record('cancel', sessionId)
    this.scoped(sessionId)
    this.bridge.endTurn(sessionId)
    return Promise.resolve()
  }

  cancelSoftInterrupts(sessionId: string): Promise<void> {
    this.bridge.record('cancel_soft_interrupts', sessionId)
    this.scoped(sessionId)
    return Promise.resolve()
  }

  runStructured<T>(
    sessionId: string,
    text: string,
    options: { schema: unknown; maxRetries?: number },
  ): Promise<JcodeStructuredOutcome<T>> {
    this.bridge.record('run_structured', sessionId, { text, maxRetries: options.maxRetries ?? 2 })
    const session = this.scoped(sessionId)
    session.history.push({ role: 'user', content: text })
    const raw = JSON.stringify({ score: 1, rationale: 'fake judge', failures: [] })
    return Promise.resolve({
      value: JSON.parse(raw) as T,
      attempts: 1,
      raw: [raw],
      failed: false,
    })
  }

  /**
   * The **stored** tail: connection-agnostic, answers `[]` for an unknown id rather than failing,
   * and does not carry what this session sent. Verified — and the reason `tail()` merges.
   */
  peekSession(
    sessionId: string,
    limit: number,
  ): Promise<readonly { role: string; content: string }[]> {
    this.bridge.record('peek_session', sessionId, { limit })
    this.bridge.assertDaemon()
    const session = this.bridge.sessions.get(sessionId)
    if (session === undefined) return Promise.resolve([])
    return Promise.resolve(session.stored.slice(-limit).map((row) => ({ ...row })))
  }

  /**
   * The **live** transcript: attachment-scoped, and it flattens a block-array message to `''`
   * ([F8], #45) — modelled here by carrying through whatever was pushed, including the `''` rows
   * a test injects to exercise the flattening.
   */
  getHistory(sessionId: string): Promise<readonly { role: string; content: string }[]> {
    this.bridge.record('get_history', sessionId)
    const session = this.scoped(sessionId)
    return Promise.resolve(session.history.map((row) => ({ ...row })))
  }

  listSessions(): Promise<readonly JcodeSessionInfo[]> {
    this.bridge.record('list_sessions', null)
    this.bridge.assertDaemon()
    return Promise.resolve(
      [...this.bridge.sessions.values()].map((session) =>
        /* The vocabulary lies: `list_sessions` says `attached` for a held session and never says
         * whether a turn is running (#18, §5.4 #4). */
        infoOf(session, session.sessionId === this.attachedSessionId ? 'attached' : 'idle'),
      ),
    )
  }

  /** Connection-agnostic, like `peekSession` (verified). */
  archiveSession(sessionId: string): Promise<void> {
    this.bridge.record('archive_session', sessionId)
    this.bridge.assertDaemon()
    this.bridge.require(sessionId).archived = true
    return Promise.resolve()
  }

  /** `undefined` restores the generated title, and every rename emits `session_renamed`. */
  renameSession(sessionId: string, title?: string): Promise<void> {
    this.bridge.record('rename_session', sessionId, { title: title ?? null })
    const session = this.scoped(sessionId)
    session.title = title ?? null
    this.bridge.emit(sessionId, {
      ev: 'session_renamed',
      session_id: sessionId,
      ...(title === undefined ? {} : { title }),
      display_title: title ?? session.generatedTitle,
    })
    return Promise.resolve()
  }

  setRetentionPolicy(archiveAfterDays?: number): Promise<void> {
    this.bridge.record('set_retention_policy', null, { archiveAfterDays: archiveAfterDays ?? null })
    this.bridge.assertDaemon()
    if (archiveAfterDays !== undefined && (archiveAfterDays < 1 || archiveAfterDays > 36_500)) {
      return Promise.reject(
        invalidRequest('archive_after_days must be 1..=36500, or null to disable'),
      )
    }
    this.bridge.retentionPolicy = archiveAfterDays
    return Promise.resolve()
  }

  setApiKey(provider: string, apiKey: string): Promise<void> {
    this.bridge.record('set_api_key', null, { provider })
    this.bridge.assertDaemon()
    if (!JCODE_PROVIDER_SET.has(provider)) {
      return Promise.reject(invalidRequest(JCODE_UNSUPPORTED_PROVIDER_MESSAGE))
    }
    this.bridge.credentials.set(provider, apiKey)
    return Promise.resolve()
  }

  /** Takes a session id and is attachment-scoped, like every other session-scoped request. */
  getRuntimeInfo(sessionId: string): Promise<JcodeRuntimeInfo> {
    this.bridge.record('get_runtime_info', sessionId)
    this.scoped(sessionId)
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
        /* Typed `healthy: true` on the real one too, which is why [F14] drops it at the seam. */
        healthy: true,
      },
    )
  }

  /**
   * No session argument exists in protocol v1, and it is a real round trip: it fails once the
   * daemon is gone, which is what makes it swarm's liveness probe.
   */
  ping(): Promise<void> {
    this.bridge.record('ping', null)
    if (!this.bridge.daemonAlive) return Promise.reject(daemonGone())
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

const JCODE_UNSUPPORTED_PROVIDER_MESSAGE =
  'unsupported API-key provider; supported: claude-api, openai-api, openrouter, cursor, gemini, jcode'

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
