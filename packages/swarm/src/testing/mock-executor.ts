/**
 * `MockExecutor` — a full `ExecutorAdapter` (§5.1) with scriptable turns and injectable failures.
 *
 * It exists because the failures that matter cannot be produced on demand by a real backend, and
 * every one of them is a rule in this spec: a **disconnect mid-turn** (V8, C12, D18), an
 * **ambiguous ack** (V5 — the ack that never arrives, which `waitForAccept` cannot distinguish
 * from success, [F2]), a **refused effort change** (§4.2's `invalid_request`), tool events with
 * concurrent call ids ([F11]) and background progress that is scraped and may vanish ([B7]).
 *
 * Its capability row is §5.2's `mock` column — *configurable* — and it defaults to the **jcode**
 * row, so a test that does not opt out is testing against the shape of the real backend rather
 * than against a friendlier fiction. `executorConformance()` then checks the declared row against
 * observed behaviour, which is what makes a lying adapter fail CI.
 *
 * DOM-free and Node-free.
 */

import type {
  ConfigApplyReport,
  ExecutorAdapter,
  ExecutorCapabilities,
  ExecutorEvent,
  ExecutorInstance,
  ExecutorRuntimeInfo,
  ExecutorSessionHandle,
  ExecutorSessionInfo,
  ExecutorSubmission,
  InstanceCredentialProvider,
  InstanceOptions,
  KillOutcomeReport,
  SessionConfigPatch,
  StructuredResult,
  SubmitReceipt,
} from '../server/executor/types.ts'
import type { AdapterId, Fence, InstanceKey, PreflightReport, ReasoningEffort } from '../types.ts'

import { DEFAULT_TIMEOUTS } from '../domain/constants.ts'
import { checkFence, sessionLease } from '../domain/leases.ts'
import { SwarmError } from '../errors.ts'
import { JCODE_CAPABILITIES } from '../server/executor/types.ts'

/** §5.2's `mock` column: configurable in every row, defaulting to the `jcode` column. */
export const MOCK_DEFAULT_CAPABILITIES: ExecutorCapabilities = { ...JCODE_CAPABILITIES }

export type MockStep =
  | { readonly k: 'text' | 'reasoning'; readonly text: string }
  | { readonly k: 'reasoning_done'; readonly durationSecs?: number }
  | {
      readonly k: 'tool'
      readonly callId: string
      readonly name: string
      /** Emitted as `tool_input` with an EMPTY call id, exactly as the bridge does ([F11]). */
      readonly input?: string
      readonly output?: string
      readonly error?: string
    }
  | {
      readonly k: 'usage'
      readonly input: number
      readonly output: number
      readonly cacheReadInput?: number
    }
  | {
      readonly k: 'background'
      readonly taskId: string
      readonly label: string
      readonly percent?: number
      readonly summary?: string
      readonly done?: boolean
    }
  | {
      readonly k: 'model_info'
      readonly provider?: string
      readonly model?: string
      readonly solicited?: boolean
    }
  | { readonly k: 'session_status'; readonly status: string }
  | { readonly k: 'error'; readonly code: string; readonly message: string }
  | { readonly k: 'turn_done' }
  /** Injectable failure: close the stream where the step sits — a disconnect mid-turn. */
  | { readonly k: 'disconnect'; readonly reason?: string }

export interface MockTurnScript {
  /**
   * Emit `message_accepted`? `false` is the **ambiguous ack** (V5): the submission left, nothing
   * came back, and no call return value can tell the two apart.
   */
  readonly ack?: boolean
  readonly steps?: readonly MockStep[]
}

export interface MockExecutorOptions {
  readonly capabilities?: Partial<ExecutorCapabilities>
  readonly preflight?: PreflightReport
  /** `null` ⇒ `hardKill` refuses with `capability_absent` (§4.3.7). */
  readonly pgid?: number | null
  readonly daemonPid?: number | null
  readonly versions?: Record<string, string>
  /** Fields `applyConfig` refuses — the "refused effort change" injection (§4.2). */
  readonly refuseConfig?: readonly ('model' | 'reasoningEffort')[]
  readonly now?: () => number
  /** Injectable timer, so a runner with fake timers can drive `acceptTimeoutMs` (V5). */
  readonly sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

/**
 * Multi-consumer event fan-out. Each `events()` call gets its own queue, and the ack observer
 * sits on the *emitter* rather than on an iterator — because §5.1 derives `SubmitReceipt.ack`
 * from an event **observed on the session's stream**, and that observation must be independent
 * of whether anyone is draining it.
 */
class EventChannel {
  private readonly consumers = new Set<{
    queue: ExecutorEvent[]
    wake: (() => void) | null
  }>()
  private readonly observers = new Set<{
    match: (e: ExecutorEvent) => boolean
    settle: (e: ExecutorEvent) => void
  }>()
  private ended = false

  emit(event: ExecutorEvent): void {
    if (this.ended) return
    for (const observer of Array.from(this.observers)) {
      if (observer.match(event)) {
        this.observers.delete(observer)
        observer.settle(event)
      }
    }
    for (const consumer of this.consumers) {
      consumer.queue.push(event)
      consumer.wake?.()
    }
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const consumer of this.consumers) consumer.wake?.()
    this.observers.clear()
  }

  get closed(): boolean {
    return this.ended
  }

  /** Resolves with the first matching event, or `null` when the deadline passes first. */
  observe(
    match: (e: ExecutorEvent) => boolean,
    timeoutMs: number,
    sleep: (ms: number) => Promise<void>,
  ): Promise<ExecutorEvent | null> {
    return new Promise((resolve) => {
      const entry = { match, settle: (e: ExecutorEvent) => resolve(e) }
      this.observers.add(entry)
      void sleep(timeoutMs).then(() => {
        if (this.observers.delete(entry)) resolve(null)
      })
    })
  }

  iterator(): AsyncIterableIterator<ExecutorEvent> {
    const consumer: { queue: ExecutorEvent[]; wake: (() => void) | null } = {
      queue: [],
      wake: null,
    }
    this.consumers.add(consumer)
    /* Arrow members, so `this` stays the channel and the iterator needs no alias for it. */
    const iterator: AsyncIterableIterator<ExecutorEvent> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async (): Promise<IteratorResult<ExecutorEvent>> => {
        for (;;) {
          const value = consumer.queue.shift()
          if (value !== undefined) return { value, done: false }
          if (this.ended) {
            this.consumers.delete(consumer)
            return { value: undefined, done: true }
          }
          await new Promise<void>((resolve) => {
            consumer.wake = resolve
          })
          consumer.wake = null
        }
      },
      return: async (): Promise<IteratorResult<ExecutorEvent>> => {
        this.consumers.delete(consumer)
        return { value: undefined, done: true }
      },
    }
    return iterator
  }
}

class MockSession implements ExecutorSessionHandle {
  readonly sessionId: string
  readonly channel = new EventChannel()
  /** `role`/`content` pairs, the only thing `tail()` may ever return (§5.4 #12). */
  readonly transcript: { role: string; content: string }[] = []
  readonly scripts: MockTurnScript[] = []
  shadow: { model: string | null; reasoningEffort: ReasoningEffort | null } = {
    model: null,
    reasoningEffort: null,
  }
  turnInFlight = false
  closed = false
  archived = false
  title: string | null

  constructor(
    sessionId: string,
    readonly workingDir: string,
    title: string | undefined,
    private readonly instance: MockInstance,
  ) {
    this.sessionId = sessionId
    this.title = title ?? null
  }

  private get capabilities(): ExecutorCapabilities {
    return this.instance.capabilities
  }

  private guardFence(fence: Fence): void {
    const key = sessionLease(this.sessionId)
    const error = checkFence(fence, key, this.instance.highestFence(key))
    if (error) throw error
    this.instance.observeFence(key, fence.token)
  }

  private guardOpen(): void {
    if (this.closed) {
      throw new SwarmError('executor_unavailable', `session ${this.sessionId} is closed`)
    }
  }

  events(): AsyncIterableIterator<ExecutorEvent> {
    return this.channel.iterator()
  }

  applyConfig(patch: SessionConfigPatch, fence: Fence): Promise<ConfigApplyReport> {
    this.guardOpen()
    this.guardFence(fence)
    if (this.turnInFlight) {
      /*
       * §4.3.3: refused, never queued, never issued optimistically. The daemon takes the agent
       * mutex before replying, so a mid-turn set hangs for the rest of the turn, times out, and
       * still applies to a turn the user never targeted ([F10]).
       */
      return Promise.reject(new SwarmError('turn_in_flight', 'a turn is in flight'))
    }
    const applied: ('model' | 'reasoningEffort')[] = []
    const confirmed: ('model' | 'reasoningEffort')[] = []
    const refused: { field: string; reason: string }[] = []
    const refusals = this.instance.options.refuseConfig ?? []

    if (patch.model !== undefined) {
      if (refusals.includes('model')) {
        refused.push({ field: 'model', reason: 'invalid_request' })
      } else {
        this.shadow.model = patch.model
        applied.push('model')
        if (this.capabilities.observableModel) {
          confirmed.push('model')
          this.channel.emit({ k: 'model_info', model: patch.model, solicited: true })
        }
      }
    }
    if (patch.reasoningEffort !== undefined) {
      if (refusals.includes('reasoningEffort')) {
        refused.push({ field: 'reasoningEffort', reason: 'invalid_request' })
      } else {
        this.shadow.reasoningEffort = patch.reasoningEffort
        applied.push('reasoningEffort')
        /* Never confirmed on jcode: the bridge discards the applied value and there is no
         * getter, which is why `effortConfirmed` is a literal `false` (§12 #7). */
        if (this.capabilities.observableEffort) confirmed.push('reasoningEffort')
      }
    }
    return Promise.resolve({ applied, confirmed, refused })
  }

  /** Queue the script the next `submit` plays back. */
  script(script: MockTurnScript): void {
    this.scripts.push(script)
  }

  async submit(msg: ExecutorSubmission, fence: Fence): Promise<SubmitReceipt> {
    this.guardOpen()
    this.guardFence(fence)
    if (msg.contextOnly === true && !this.capabilities.contextOnlyMessage) {
      throw new SwarmError('capability_absent', 'this executor has no context-only message')
    }
    if (this.turnInFlight) {
      throw new SwarmError(
        'turn_in_flight',
        'one in-flight turn per session under the writer lease',
      )
    }

    this.transcript.push({ role: 'user', content: msg.text })
    const script = this.scripts.shift() ?? this.defaultScript(msg)
    const awaitAckMs = msg.awaitAckMs ?? DEFAULT_TIMEOUTS.acceptTimeoutMs

    /* Observe the ack on the stream, exactly as the adapter must ([F2]) — never from a return
     * value, which carries no information about whether the ack arrived. */
    const observed = this.channel.observe(
      (e) => e.k === 'accepted',
      awaitAckMs,
      this.instance.sleep,
    )

    if (msg.contextOnly !== true) this.turnInFlight = true
    void this.play(script, msg)

    const ack = await observed
    if (ack === null) {
      /* V5: swarm's own deadline elapsed with no `message_accepted` on the stream. */
      return { ack: 'unknown', ackAtMs: null, correlated: this.capabilities.submitAckCorrelates }
    }
    return {
      ack: 'accepted',
      ackAtMs: this.instance.now(),
      correlated: this.capabilities.submitAckCorrelates,
    }
  }

  private defaultScript(msg: ExecutorSubmission): MockTurnScript {
    if (msg.contextOnly === true) return { ack: true, steps: [] }
    const steps: MockStep[] = [{ k: 'text', text: 'ok' }]
    if (this.capabilities.usageEvents) steps.push({ k: 'usage', input: 10, output: 20 })
    steps.push({ k: 'turn_done' })
    return { ack: true, steps }
  }

  private async play(script: MockTurnScript, msg: ExecutorSubmission): Promise<void> {
    await this.instance.sleep(0)
    if (this.channel.closed) return
    if (script.ack !== false) this.channel.emit({ k: 'accepted' })

    for (const step of script.steps ?? []) {
      if (this.channel.closed) return
      await this.instance.sleep(0)
      switch (step.k) {
        case 'text':
        case 'reasoning':
          this.channel.emit({ k: step.k, text: step.text })
          if (step.k === 'text') this.transcript.push({ role: 'assistant', content: step.text })
          break
        case 'reasoning_done':
          this.channel.emit(
            step.durationSecs === undefined
              ? { k: 'reasoning_done' }
              : { k: 'reasoning_done', durationSecs: step.durationSecs },
          )
          break
        case 'tool': {
          this.channel.emit({ k: 'tool_start', callId: step.callId, name: step.name })
          if (step.input !== undefined) {
            /* The bridge hard-codes an EMPTY call id on input deltas ([F11]); an adapter that
             * keys buffers by it merges every concurrent tool's arguments into one bucket. */
            this.channel.emit({ k: 'tool_input', callId: '', delta: step.input })
          }
          this.channel.emit({ k: 'tool_exec', callId: step.callId, name: step.name })
          this.channel.emit({
            k: 'tool_done',
            callId: step.callId,
            name: step.name,
            output: step.output ?? '',
            ...(step.error === undefined ? {} : { error: step.error }),
          })
          break
        }
        case 'usage':
          if (!this.capabilities.usageEvents) break
          this.channel.emit({
            k: 'usage',
            input: step.input,
            output: step.output,
            ...(step.cacheReadInput === undefined ? {} : { cacheReadInput: step.cacheReadInput }),
          })
          break
        case 'background':
          this.channel.emit({
            k: 'background',
            taskId: step.taskId,
            label: step.label,
            summary: step.summary ?? step.label,
            provenance: 'scraped',
            ...(step.percent === undefined ? {} : { percent: step.percent }),
            ...(step.done === undefined ? {} : { done: step.done }),
          })
          break
        case 'model_info':
          this.channel.emit({
            k: 'model_info',
            solicited: step.solicited ?? false,
            ...(step.provider === undefined ? {} : { provider: step.provider }),
            ...(step.model === undefined ? {} : { model: step.model }),
          })
          break
        case 'session_status':
          this.channel.emit({ k: 'session_status', status: step.status, trusted: false })
          break
        case 'error':
          this.channel.emit({ k: 'error', code: step.code, message: step.message })
          break
        case 'turn_done':
          this.turnInFlight = false
          this.channel.emit({ k: 'turn_done' })
          break
        case 'disconnect':
          this.turnInFlight = false
          this.channel.emit({ k: 'closed', reason: step.reason ?? 'mock disconnect' })
          this.channel.end()
          return
      }
    }
    /*
     * Deliberately nothing here. A script that omits `turn_done` leaves the turn **in flight**,
     * which is the state §4.3.3's refusal is about; and a `contextOnly` submission produces no
     * `turn_done` at all (§4.2, #32), so V13 is the only path to `ended` for it. A mock that
     * helpfully closed either case would delete the reason both rules exist.
     */
    void msg
  }

  interrupt(
    kind: 'soft' | 'urgent' | 'cancel' | 'retract',
    _content: string | null,
    fence: Fence,
  ): Promise<void> {
    this.guardOpen()
    this.guardFence(fence)
    if ((kind === 'soft' || kind === 'urgent') && !this.capabilities.softInterrupt) {
      return Promise.reject(new SwarmError('capability_absent', 'no soft interrupt'))
    }
    if (kind === 'cancel') {
      this.turnInFlight = false
      this.channel.emit({ k: 'turn_done' })
    }
    /*
     * Landing is unobservable (§5.4 #10): `soft_interrupt_injected` is not translated, so no
     * event is emitted here and `deliveryDetail.landing` stays `'unconfirmed'` forever.
     */
    return Promise.resolve()
  }

  async structured<T>(
    msg: ExecutorSubmission,
    _schema: unknown,
    maxRetries: number,
    fence: Fence,
  ): Promise<StructuredResult<T>> {
    this.guardOpen()
    this.guardFence(fence)
    if (!this.capabilities.structuredOutput) {
      throw new SwarmError('capability_absent', 'this executor has no structured output')
    }
    this.transcript.push({ role: 'user', content: msg.text })
    const raw = [JSON.stringify({ ok: true })]
    return {
      value: JSON.parse(raw[0]!) as T,
      attempts: Math.min(1, maxRetries + 1),
      raw,
      failed: false,
    }
  }

  tail(limit: number): Promise<{ role: string; content: string }[]> {
    this.guardOpen()
    if (this.capabilities.history === 'none') return Promise.resolve([])
    return Promise.resolve(this.transcript.slice(-limit).map((e) => ({ ...e })))
  }

  rename(title: string | null): Promise<void> {
    this.title = title
    return Promise.resolve()
  }

  archive(): Promise<void> {
    this.archived = true
    return Promise.resolve()
  }

  /** The **only** lease release (§5.4 #9): there is no `detach`, here or in the real adapter. */
  close(reason: string): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    this.channel.emit({ k: 'closed', reason })
    this.channel.end()
    this.instance.forget(this.sessionId)
    return Promise.resolve()
  }
}

class MockInstance implements ExecutorInstance {
  readonly adapterId: AdapterId = 'mock'
  readonly sessions = new Map<string, MockSession>()
  private readonly fences = new Map<string, number>()
  private sessionCounter = 0
  private disposed = false
  readonly credentials = new Map<InstanceCredentialProvider, string>()

  constructor(
    readonly key: InstanceKey,
    readonly options: MockExecutorOptions,
    readonly capabilities: ExecutorCapabilities,
    readonly instanceOptions: InstanceOptions,
  ) {}

  get pgid(): number | null {
    return this.options.pgid === undefined ? 4242 : this.options.pgid
  }

  get daemonPid(): number | null {
    return this.options.daemonPid === undefined ? 4243 : this.options.daemonPid
  }

  readonly now = (): number => (this.options.now ?? Date.now)()
  readonly sleep = (ms: number): Promise<void> => (this.options.sleep ?? defaultSleep)(ms)

  highestFence(key: string): number {
    return this.fences.get(key) ?? 0
  }

  observeFence(key: string, token: number): void {
    if (token > this.highestFence(key)) this.fences.set(key, token)
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  runtimeInfo(): Promise<ExecutorRuntimeInfo> {
    return Promise.resolve({
      server: 'mock',
      protocolVersion: 1,
      capabilities: ['structured'],
      providers: ['mock'],
      routes: [
        {
          model: 'mock-model',
          provider: 'mock',
          apiMethod: 'mock',
          available: true,
          detail: 'in-process',
        },
      ],
    })
  }

  createSession(req: { workingDir: string; title?: string }): Promise<ExecutorSessionHandle> {
    if (this.disposed) {
      return Promise.reject(new SwarmError('executor_unavailable', 'instance disposed'))
    }
    const sessionId = `mock-session-${++this.sessionCounter}`
    const session = new MockSession(sessionId, req.workingDir, req.title, this)
    this.sessions.set(sessionId, session)
    return Promise.resolve(session)
  }

  openSession(sessionId: string): Promise<ExecutorSessionHandle> {
    const session = this.sessions.get(sessionId)
    if (session === undefined) {
      return Promise.reject(new SwarmError('not_found', `no session ${sessionId}`))
    }
    return Promise.resolve(session)
  }

  /** A disk inventory, not a live-session list ([F16]) — archived sessions stay in it. */
  listSessions(): Promise<ExecutorSessionInfo[]> {
    return Promise.resolve(
      [...this.sessions.values()].map((s) => ({
        sessionId: s.sessionId,
        workingDir: s.workingDir,
        status: 'idle',
        trusted: false as const,
        archived: s.archived,
        ...(s.title === null ? {} : { title: s.title }),
      })),
    )
  }

  setCredential(provider: InstanceCredentialProvider, apiKey: string): Promise<void> {
    if (apiKey !== apiKey.trim() || apiKey.includes('\n') || apiKey.includes('\0')) {
      return Promise.reject(new SwarmError('executor_refused', 'invalid_request: malformed key'))
    }
    this.credentials.set(provider, apiKey)
    return Promise.resolve()
  }

  async dispose(reason: string): Promise<void> {
    this.disposed = true
    /* A copy: `close()` removes the session from the map it is being iterated from. */
    const open = Array.from(this.sessions.values())
    for (const session of open) await session.close(reason)
  }

  async hardKill(reason: string): Promise<KillOutcomeReport> {
    const startedAt = this.now()
    const pgid = this.pgid
    if (pgid === null) {
      /*
       * §4.3.7: an adapter that cannot name a process group it created MUST fail rather than
       * guess. Signalling a group swarm did not create is swarm killing itself while the agent
       * it meant to stop keeps running.
       */
      throw new SwarmError('capability_absent', 'no swarm-created process group to signal')
    }
    await this.dispose(reason)
    const daemonPid = this.daemonPid
    return {
      pgid,
      daemonPid,
      signalled: daemonPid === null ? ['SIGTERM'] : ['SIGTERM', 'SIGTERM'],
      survivors: [],
      /* A kill that left the daemon alive must never be reported as a completed stop ([F1]). */
      daemonStopped: daemonPid !== null,
      durationMs: Math.max(0, this.now() - startedAt),
    }
  }
}

export class MockExecutor implements ExecutorAdapter {
  readonly id: AdapterId = 'mock'
  readonly capabilities: ExecutorCapabilities
  private readonly instances = new Map<InstanceKey, MockInstance>()

  constructor(readonly options: MockExecutorOptions = {}) {
    this.capabilities = { ...MOCK_DEFAULT_CAPABILITIES, ...options.capabilities }
  }

  preflight(): Promise<PreflightReport> {
    return Promise.resolve(
      this.options.preflight ?? {
        ok: true,
        detail: 'mock executor',
        versions: this.options.versions ?? { mock: '1' },
        blocked: null,
        fix: null,
      },
    )
  }

  acquireInstance(key: InstanceKey, opts: InstanceOptions): Promise<ExecutorInstance> {
    const existing = this.instances.get(key)
    if (existing !== undefined) return Promise.resolve(existing)
    const instance = new MockInstance(key, this.options, this.capabilities, opts)
    this.instances.set(key, instance)
    return Promise.resolve(instance)
  }

  /** Queue the script the session's next `submit` plays back. Test-only, not part of the seam. */
  script(session: ExecutorSessionHandle, script: MockTurnScript): void {
    ;(session as MockSession).script(script)
  }

  /** Force a disconnect outside a turn — instance death, heartbeat loss (C12). */
  disconnect(session: ExecutorSessionHandle, reason = 'instance died'): void {
    const s = session as MockSession
    s.turnInFlight = false
    s.channel.emit({ k: 'closed', reason })
    s.channel.end()
  }
}

/** Default instance options, so a test that does not care about the spawn does not spell one. */
export function mockInstanceOptions(overrides: Partial<InstanceOptions> = {}): InstanceOptions {
  return {
    jcodeHome: '/tmp/swarm-mock/home',
    workingDir: '/tmp/swarm-mock/work',
    inheritLogins: false,
    env: { PATH: '/usr/bin' },
    startupTimeoutMs: 5_000,
    cleanupTimeoutMs: 5_000,
    inheritStderr: false,
    ...overrides,
  }
}
