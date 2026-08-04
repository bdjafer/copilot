/**
 * The jcode `ExecutorAdapter` (SPEC-swarm §5.1–§5.4).
 *
 * Every jcode-specific wound lives in this file, which is the whole point of the seam. The five
 * that shape the code, each a verified limitation with a normative mitigation:
 *
 *  1. **The ack cannot come from the call** ([F2], V5). `waitForEvent` *resolves* on timeout by
 *     design, so `sendMessage` returns identically whether or not `message_accepted` arrived.
 *     `submit()` therefore sends with the accept-wait flag **absent** and derives
 *     `SubmitReceipt.ack` from an event observed on *this session's own* stream inside swarm's
 *     `acceptTimeoutMs`. The observation sits on the fan-out, not on an iterator, so it holds
 *     whether or not anyone is draining.
 *  2. **One connection, one session** (§5.3, [F5]). `create_session` and `attach_session` are the
 *     same bridge branch and both subscribe, so a connection that creates a session *becomes*
 *     attached to it — and the client-side detach is a verified no-op (#10). So: a probe
 *     connection attached to a long-lived probe session, which also creates sessions and
 *     immediately re-attaches to its own; one dedicated connection per active session; and
 *     liveness only from a `ping` on the **attached** probe connection, because an unattached
 *     ping is answered bridge-locally and stays green with a dead daemon.
 *  3. **`tool_input_delta` always carries `call_id: ''`** ([F11]). Input deltas are attributed to
 *     the most recent `tool_start` **on that session**; keying a buffer by the id would merge
 *     every concurrent tool's argument stream into one bucket.
 *  4. **`error` frames carry no `session_id`** ([F6], V11). They are attributable *only* because
 *     rule 2 binds one connection to one session — a topology change silently breaks V11.
 *  5. **The hard kill must reach two groups** ([F1]). See `spawn.ts`.
 *
 * The effort ladder is validated **here as well** (§4.1, #9, layer 3): `swarm`/`swarm-deep` are
 * values jcode *accepts*, so `ok` from `setReasoningEffort` validates nothing and the only gate
 * is the one swarm owns — at all three layers, or at none.
 *
 * Node ≥ 24, server-only.
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { SwarmErrorCode } from '../../errors.ts'
import type {
  AdapterId,
  Fence,
  InstanceKey,
  PreflightReport,
  ReasoningEffort,
} from '../../types.ts'
import type { JcodeApiEvent, JcodeSdkClient, JcodeTransport } from './sdk.ts'
import type { BridgeLauncher, HomeLock, SpawnedBridge, VersionProbe } from './spawn.ts'
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
} from './types.ts'

import { DEFAULT_TIMEOUTS, SERVER_POLICY } from '../../domain/constants.ts'
import { BANNED_EFFORTS } from '../../domain/directive.ts'
import { checkFence, sessionLease } from '../../domain/leases.ts'
import { SwarmError } from '../../errors.ts'
import {
  acquireHomeLock,
  assertChildStillAlive,
  killTwoGroups,
  launchBridge,
  preflightJcode,
  resolveDaemonPid,
} from './spawn.ts'
import { JCODE_CAPABILITIES } from './types.ts'

/**
 * The literal header jcode's TUI writes, which [B7] read background progress out of.
 *
 * **Obsolete against jcode 0.67.0** and kept only so a backend that must reverse-engineer
 * progress has one implementation to point at: protocol v1 has a first-class
 * `background_progress` event and no `notification` event kind at all, so nothing on the real
 * bridge reaches `scrapeBackgroundProgress` any more.
 */
export const BACKGROUND_PROGRESS_HEADER = '**Background task progress** '

const BANNED_SET: ReadonlySet<string> = new Set<string>(BANNED_EFFORTS)

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })

/* ---------------------------------------------------------------------------- normalization */

export interface ToolAttribution {
  /** The id of the most recent `tool_start` on this session — [F11]'s entire mitigation. */
  lastToolStart: string | null
}

/**
 * One raw bridge event → zero or one `ExecutorEvent`. Untranslated daemon events are silently
 * dropped by the bridge itself (`_ => vec![]`, §5.4 #2); the ones that do arrive are normalized
 * and appended to the durable log **before** fan-out, so what was not received never existed.
 *
 * Every tag and field here is protocol v1 as verified against jcode 0.67.0 — `call_id` (not
 * `id`), `token_usage` (not `usage`), `background_progress` as a first-class event, and no
 * `notification` and no `closed` at all. `closed` is synthesized by the pump when the iterator
 * ends, because the SDK's stream carries no terminal frame.
 */
export function normalizeJcodeEvent(
  raw: JcodeApiEvent,
  attribution: ToolAttribution,
): ExecutorEvent | null {
  switch (raw.ev) {
    case 'text_delta':
      return { k: 'text', text: raw.text }
    case 'reasoning_delta':
      return { k: 'reasoning', text: raw.text }
    case 'reasoning_done':
      return raw.duration_secs === undefined
        ? { k: 'reasoning_done' }
        : { k: 'reasoning_done', durationSecs: raw.duration_secs }
    case 'tool_start':
      attribution.lastToolStart = raw.call_id
      return { k: 'tool_start', callId: raw.call_id, name: raw.name }
    case 'tool_exec':
      return { k: 'tool_exec', callId: raw.call_id, name: raw.name }
    case 'tool_input_delta':
      /* [F11]'s mitigation, applied only where it is needed: an empty wire id is attributed to
       * the most recent `tool_start` on this session, a real one is carried through. The wire
       * value never reaches a buffer key either way (§6.4). */
      return {
        k: 'tool_input',
        callId: raw.call_id === '' ? (attribution.lastToolStart ?? '') : raw.call_id,
        delta: raw.delta,
      }
    case 'tool_done':
      return {
        k: 'tool_done',
        callId: raw.call_id,
        name: raw.name,
        output: raw.output,
        ...(raw.error === undefined ? {} : { error: raw.error }),
      }
    case 'token_usage':
      return {
        k: 'usage',
        input: raw.input,
        output: raw.output,
        ...(raw.cache_read_input === undefined ? {} : { cacheReadInput: raw.cache_read_input }),
      }
    case 'message_accepted':
      return { k: 'accepted' }
    case 'turn_done':
      return { k: 'turn_done' }
    case 'background_progress':
      /* Native, not scraped — and still barred from state, budget and completion (§6.4). */
      return {
        k: 'background',
        taskId: raw.task_id,
        label: raw.label,
        summary: raw.summary,
        provenance: 'native',
        ...(raw.percent === undefined ? {} : { percent: raw.percent }),
        ...(raw.done === undefined ? {} : { done: raw.done }),
      }
    case 'model_info':
      /* No `solicited` on the wire: a broadcast cannot be told from an answer (§4.2). */
      return {
        k: 'model_info',
        solicited: false,
        ...(raw.provider === undefined ? {} : { provider: raw.provider }),
        ...(raw.model === undefined ? {} : { model: raw.model }),
      }
    case 'session_status':
      /* Carried, never used: the vocabulary lies for running sessions (#18, §5.4 #4). */
      return { k: 'session_status', status: raw.status, trusted: false }
    case 'session_renamed':
      /* A title change is not a turn event and has no member in §5.1's union. Dropped, not
       * smuggled in as something else. */
      return null
    case 'error':
      return { k: 'error', code: raw.code, message: raw.message }
  }
}

/**
 * [B7]'s reverse-engineering of background progress out of a markdown header in a `notification`
 * body — **dead against jcode 0.67.0**, where `background_progress` is a first-class event and
 * `notification` is not an event kind at all.
 *
 * Retained, exported and tested because the rule it encodes outlives the bridge that forced it:
 * a signal recovered from a UI string is carried with `provenance:'scraped'`, rendered in its own
 * plane, and never feeds state, budget or completion — its disappearance is not an error, which
 * is the only honest way to depend on a TUI string.
 */
export function scrapeBackgroundProgress(body: string, title?: string): ExecutorEvent | null {
  if (!body.startsWith(BACKGROUND_PROGRESS_HEADER)) return null
  const summary = body.slice(BACKGROUND_PROGRESS_HEADER.length).trim()
  const percent = /(\d{1,3})\s*%/.exec(summary)
  const label = title ?? summary.split('\n')[0] ?? 'background task'
  return {
    k: 'background',
    taskId: label,
    label,
    summary,
    provenance: 'scraped',
    ...(percent === null ? {} : { percent: Number(percent[1]) }),
  }
}

/* ------------------------------------------------------------------------------- fan-out */

/**
 * Multi-consumer fan-out with off-iterator observation. The ack observer must not depend on
 * anyone draining the stream — that is exactly the property [F2] needs and the property a plain
 * `for await` cannot provide.
 */
class EventFanout {
  private readonly consumers = new Set<{ queue: ExecutorEvent[]; wake: (() => void) | null }>()
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

/* --------------------------------------------------------------------------------- session */

class JcodeSession implements ExecutorSessionHandle {
  private readonly fanout = new EventFanout()
  private readonly attribution: ToolAttribution = { lastToolStart: null }
  private turnInFlight = false
  private closed = false

  readonly sessionId: string
  /** The **dedicated** connection: attached once, never re-targeted (§5.3). */
  private readonly client: JcodeSdkClient
  private readonly instance: JcodeInstance

  /* Spelled out rather than declared as TypeScript parameter properties. Node ≥ 24 runs `.ts` in
   * **strip-only** mode and a parameter property is the one class syntax that cannot be erased
   * without emitting code, so a single one of them makes `node src/cli.ts` — the documented dev
   * and demo entry, and what `test/e2e-journey.test.ts` spawns — fail to load the whole module
   * graph. Semantics are identical: TypeScript emits exactly these assignments, in this order,
   * after the field initializers above. */
  constructor(sessionId: string, client: JcodeSdkClient, instance: JcodeInstance) {
    this.sessionId = sessionId
    this.client = client
    this.instance = instance
    void this.pump()
  }

  /**
   * X7: the pump drains at full speed and **never awaits head IO**. Head slowness reaches the
   * durable log's writer, never jcode — and on this path the real hazard is not a jcode-side
   * buffer kill (there is none) but `write_all` stalling the bridge's select loop for every
   * session on the instance ([F7]).
   */
  private async pump(): Promise<void> {
    let sawClosed = false
    try {
      for await (const raw of this.client.events()) {
        const event = normalizeJcodeEvent(raw, this.attribution)
        if (event === null) continue
        if (event.k === 'turn_done' || event.k === 'closed') this.turnInFlight = false
        this.fanout.emit(event)
        if (event.k === 'closed') {
          sawClosed = true
          break
        }
      }
    } catch (error) {
      this.fanout.emit({ k: 'error', code: 'internal', message: String(error) })
    }
    /* **Exactly one** `closed`, and the stream ends on it. A synthesized second one would make
     * `closed` a value a consumer has to count rather than a terminal it can stop at — and §5.4 #2
     * has no replay, so a consumer that read past the end would be reading nothing forever. */
    if (this.fanout.closed) return
    if (!sawClosed) this.fanout.emit({ k: 'closed', reason: 'stream ended' })
    this.fanout.end()
  }

  private guardOpen(): void {
    if (this.closed) {
      throw new SwarmError('executor_unavailable', `session ${this.sessionId} is closed`)
    }
  }

  private guardFence(fence: Fence): void {
    const key = sessionLease(this.sessionId)
    const error = checkFence(fence, key, this.instance.highestFence(key))
    if (error) throw error
    this.instance.observeFence(key, fence.token)
  }

  events(): AsyncIterableIterator<ExecutorEvent> {
    return this.fanout.iterator()
  }

  /**
   * §4.2's config half of `applyAndSubmit`: `setModel` then `setReasoningEffort`, both **before**
   * `sendMessage`, both with the session idle, both under the fence.
   *
   * The mid-turn refusal is not caution. The daemon parks on `agent.try_lock()` and sends **no
   * reply until the turn ends** ([F10]), so the SDK rejects at its 30 s request timeout *while
   * the setting still lands at turn end* — an error whose side effect succeeds, applied to a turn
   * the user never targeted, having burned the session's only request slot for 30 s.
   */
  async applyConfig(patch: SessionConfigPatch, fence: Fence): Promise<ConfigApplyReport> {
    this.guardOpen()
    this.guardFence(fence)
    if (this.turnInFlight) {
      throw new SwarmError('turn_in_flight', 'a turn is in flight; configuration cannot change')
    }
    const applied: ('model' | 'reasoningEffort')[] = []
    const confirmed: ('model' | 'reasoningEffort')[] = []
    const refused: { field: string; reason: string }[] = []

    if (patch.model !== undefined) {
      const wanted = patch.model
      /* `model_info` is broadcast to every attached client and is what sets `modelConfirmed` —
       * asynchronously, **on the stream**, never from the return value (§4.2). Observed the same
       * way the ack is, and for the same reason: a call that resolves proves only that it was
       * accepted, and `observableModel: true` is a claim this file has to be able to back. */
      const observed = this.fanout.observe(
        (e) => e.k === 'model_info' && e.model === wanted,
        this.instance.configConfirmMs,
        this.instance.sleep,
      )
      try {
        await this.client.setModel(this.sessionId, wanted)
        applied.push('model')
        if ((await observed) !== null) confirmed.push('model')
      } catch (error) {
        refused.push({ field: 'model', reason: reasonOf(error) })
      }
    }
    if (patch.reasoningEffort !== undefined) {
      const banned = assertEffortAllowed(patch.reasoningEffort)
      if (banned !== null) throw banned
      /* The wire has no "unset": `effort` is a required non-empty string, and the bridge refuses
       * an empty one before any provider lookup with
       * `invalid_request: set_reasoning_effort needs a non-empty \`effort\`` (verified). A patch
       * of `null` means "the delegation default applies and no effort is driven", so nothing is
       * sent and nothing is claimed — reporting it as `applied` would be the one lie §4.3.4
       * exists to prevent. */
      if (patch.reasoningEffort === null) {
        refused.push({ field: 'reasoningEffort', reason: 'no_effort_to_set' })
        return { applied, confirmed, refused }
      }
      try {
        await this.client.setReasoningEffort(this.sessionId, patch.reasoningEffort)
        applied.push('reasoningEffort')
        /* NEVER confirmed: the bridge discards the daemon's applied value, there is no getter,
         * and neither `runtime_info` nor `model_info` carries effort (§5.4 #11). */
      } catch (error) {
        refused.push({ field: 'reasoningEffort', reason: reasonOf(error) })
      }
    }
    return { applied, confirmed, refused }
  }

  async submit(msg: ExecutorSubmission, fence: Fence): Promise<SubmitReceipt> {
    this.guardOpen()
    this.guardFence(fence)
    if (this.turnInFlight) {
      throw new SwarmError(
        'turn_in_flight',
        'one in-flight turn per session under the writer lease',
      )
    }
    const awaitAckMs = msg.awaitAckMs ?? this.instance.acceptTimeoutMs

    /* Observe FIRST: an ack that arrives while `sendMessage` is still resolving is still an ack,
     * and a race that loses it would report `unknown` for a turn that landed. */
    const observed = this.fanout.observe((e) => e.k === 'accepted', awaitAckMs, this.instance.sleep)

    if (msg.contextOnly !== true) this.turnInFlight = true
    try {
      await this.client.sendMessage(this.sessionId, msg.text, {
        ...(msg.images === undefined ? {} : { images: msg.images }),
        ...(msg.contextOnly === true ? { noReply: true } : {}),
        /* Explicit, never defaulted: 1.1.0 defaults `waitForAccept` to `true` with a 10 s accept
         * timeout, which would block this call for ten seconds on exactly the send whose ack
         * never comes — and still resolve, so the wait buys nothing ([F2], §4.2). */
        waitForAccept: false,
      })
    } catch (error) {
      this.turnInFlight = false
      throw asSwarmError(error, 'executor_refused')
    }

    /**
     * A context-only message is acknowledged by the **request**, not by the stream.
     *
     * Verified against jcode 0.67.0: `no_reply` takes a different path through the SDK — it
     * `await`s a real reply frame (`requestOk`) instead of writing fire-and-forget and watching
     * for `message_accepted` — and **no `message_accepted` and no `turn_done` ever arrive** for
     * it. So the observation above can only ever time out, and waiting for it would report
     * `unknown` for a message the bridge positively confirmed it persisted. For this one kind of
     * submission the call returning *is* the receipt.
     */
    if (msg.contextOnly === true) {
      return { ack: 'accepted', ackAtMs: this.instance.now(), correlated: false }
    }

    const ack = await observed
    if (ack === null) {
      return { ack: 'unknown', ackAtMs: null, correlated: false }
    }
    /* `correlated` is always false: the ack carries only `session_id` — no content, no index —
     * so it can never be tied to *which* message (§5.4 #3). */
    return { ack: 'accepted', ackAtMs: this.instance.now(), correlated: false }
  }

  async interrupt(
    kind: 'soft' | 'urgent' | 'cancel' | 'retract',
    content: string | null,
    fence: Fence,
  ): Promise<void> {
    this.guardOpen()
    this.guardFence(fence)
    switch (kind) {
      case 'soft':
        await this.client.softInterrupt(this.sessionId, content ?? '')
        return
      case 'urgent':
        await this.client.softInterrupt(this.sessionId, content ?? '', true)
        return
      case 'cancel':
        await this.client.cancel(this.sessionId)
        this.turnInFlight = false
        return
      case 'retract':
        /* Session-wide, because the primitive takes only a session id (§5.4 #16, V14). The
         * caller returns `RetractReport{requested, alsoRetracted}` naming everything it undid. */
        await this.client.cancelSoftInterrupts(this.sessionId)
        return
    }
  }

  /**
   * `runStructured` is the only *true* per-turn control jcode has, and it has **no timeout of its
   * own** (decision log #19) — so it is wrapped in a swarm deadline and a `cancel`. Its turns
   * count against the budget: up to `maxRetries + 1`.
   */
  async structured<T>(
    msg: ExecutorSubmission,
    schema: unknown,
    maxRetries: number,
    fence: Fence,
  ): Promise<StructuredResult<T>> {
    this.guardOpen()
    this.guardFence(fence)
    const deadline = this.instance.structuredDeadlineMs
    let timedOut = false
    const result = await Promise.race([
      this.client.runStructured<T>(this.sessionId, msg.text, { schema, maxRetries }),
      this.instance.sleep(deadline).then(() => {
        timedOut = true
        return null
      }),
    ])
    if (timedOut || result === null) {
      await this.client.cancel(this.sessionId).catch(() => undefined)
      this.turnInFlight = false
      return {
        value: null,
        attempts: 0,
        raw: [],
        failed: true,
        error: { code: 'timeout', message: `structured run exceeded ${deadline} ms` },
      }
    }
    return result
  }

  /**
   * The transcript read behind §5.5's prompt-digest match — **both** reads, merged, on this
   * session's own connection.
   *
   * [F8]/#45 pinned swarm to `peekSession` alone because `get_history` does
   * `content.as_str().unwrap_or("")` and flattens a block-array message to `""`: a digest match
   * against `""` makes every `unknown` turn look un-landed, the one direction Q5 says must never
   * auto-act. That hazard is real and unchanged.
   *
   * What changed is the other half. Against jcode 0.67.0, `peek_session` is the **stored** tail
   * and it does not carry what swarm sends: a `noReply` message was still absent from it three
   * seconds later while `get_history` already had it, and a fresh session's stored tail holds
   * jcode's own injected session-context reminder instead. `peekSession` alone would therefore
   * match the digest against a transcript the prompt is never in — failing *closed* on every
   * turn, which is a different way of being wrong, not a safe one.
   *
   * So both are read and merged: the stored tail first, then any live row the stored tail has not
   * flushed. A `''` row from the flattening bug is dropped rather than merged, because an empty
   * row is exactly the false negative [F8] warned about.
   *
   * Both run on `this.client`, never the probe's: `get_history` is attachment-scoped and answers
   * only for the session its connection holds — the bridge's own words, verbatim from 0.67.0, are
   * `unknown_session: this connection is attached to <a>, not <b>; attach to it first or use
   * another connection`. (`peek_session` happens to be connection-agnostic, but routing one read
   * through the probe and one through the session would make the pair's failure modes differ for
   * no gain.)
   */
  async tail(limit: number): Promise<{ role: string; content: string }[]> {
    this.guardOpen()
    const stored = await this.client.peekSession(this.sessionId, limit)
    const merged = stored.map((row) => ({ role: row.role, content: row.content }))
    /* Never fatal: the digest match degrades to the stored tail rather than failing the turn. */
    const live = await this.client.getHistory(this.sessionId).catch(() => [])
    for (const row of live) {
      if (row.content === '') continue
      if (merged.some((seen) => seen.content === row.content)) continue
      merged.push({ role: row.role, content: row.content })
    }
    return merged.slice(-limit)
  }

  /**
   * `title === null` restores the generated one, which the wire expresses by **omitting** the
   * field — there is no null on `rename_session`. Attachment-scoped, so it runs on this session's
   * own connection.
   */
  async rename(title: string | null): Promise<void> {
    await this.client.renameSession(this.sessionId, title ?? undefined)
  }

  /** Connection-agnostic on the real bridge, but kept on this session's own connection so every
   * session-scoped call in this class has one answer to "which connection?" (§5.3). */
  async archive(): Promise<void> {
    await this.client.archiveSession(this.sessionId)
  }

  /** The **only** lease release (§5.4 #9). There is no detach: it is a verified client-side no-op. */
  async close(reason: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.turnInFlight = false
    this.fanout.emit({ k: 'closed', reason })
    this.fanout.end()
    this.instance.forget(this.sessionId)
    await this.client.close().catch(() => undefined)
  }
}

function reasonOf(error: unknown): string {
  if (SwarmError.is(error)) return error.code
  const message = error instanceof Error ? error.message : String(error)
  return /invalid_request/i.test(message) ? 'invalid_request' : message
}

function asSwarmError(error: unknown, fallback: SwarmErrorCode): SwarmError {
  return SwarmError.is(error)
    ? error
    : new SwarmError(fallback, error instanceof Error ? error.message : String(error))
}

/** Layer 3 of §4.1's triple validation — the last one before the value would reach the daemon. */
export function assertEffortAllowed(effort: ReasoningEffort | null | string): SwarmError | null {
  if (effort === null) return null
  if (BANNED_SET.has(String(effort).toLowerCase())) {
    return new SwarmError(
      'banned_effort',
      `reasoning effort '${String(effort)}' is banned: it hands orchestration to jcode's own swarm`,
      { details: { effort, banned: [...BANNED_EFFORTS], layer: 'jcode-adapter' } },
    )
  }
  return null
}

/* -------------------------------------------------------------------------------- instance */

interface ProbeConnection {
  readonly client: JcodeSdkClient
  readonly sessionId: string
}

class JcodeInstance implements ExecutorInstance {
  readonly adapterId: AdapterId = 'jcode'
  private readonly sessions = new Map<string, JcodeSession>()
  private readonly fences = new Map<string, number>()
  private disposed = false

  readonly key: InstanceKey
  readonly pgid: number | null
  readonly daemonPid: number | null
  private readonly probe: ProbeConnection
  private readonly socketPath: string
  private readonly options: JcodeAdapterOptions
  private readonly instanceOptions: InstanceOptions
  private readonly child: SpawnedBridge | null
  /** §3.4 rule 3 / §7.2 `instances/<hash>/lock`; released with the instance, never before. */
  private readonly homeLock: HomeLock | null

  /* Not parameter properties — see `JcodeSession`: strip-only `.ts` execution cannot erase them,
   * and `this.options` is read by the `now`/`sleep` fields below only when they are *called*, so
   * assigning in the body preserves the order TypeScript itself emits. */
  constructor(
    key: InstanceKey,
    pgid: number | null,
    daemonPid: number | null,
    probe: ProbeConnection,
    socketPath: string,
    options: JcodeAdapterOptions,
    instanceOptions: InstanceOptions,
    child: SpawnedBridge | null,
    homeLock: HomeLock | null = null,
  ) {
    this.key = key
    this.pgid = pgid
    this.daemonPid = daemonPid
    this.probe = probe
    this.socketPath = socketPath
    this.options = options
    this.instanceOptions = instanceOptions
    this.child = child
    this.homeLock = homeLock
  }

  readonly now = (): number => (this.options.now ?? Date.now)()
  readonly sleep = (ms: number): Promise<void> => (this.options.sleep ?? wait)(ms)

  get acceptTimeoutMs(): number {
    return this.options.acceptTimeoutMs ?? DEFAULT_TIMEOUTS.acceptTimeoutMs
  }

  get structuredDeadlineMs(): number {
    return this.options.structuredDeadlineMs ?? 10 * 60_000
  }

  /**
   * How long `applyConfig` waits for the `model_info` that confirms a `setModel` (§4.2). Short by
   * design: the value is a *confirmation*, and an unconfirmed model is a legitimate outcome that
   * `ConfigApplyReport.confirmed` reports honestly — it is never a reason to fail a turn.
   */
  get configConfirmMs(): number {
    return this.options.configConfirmMs ?? 250
  }

  probeClient(): JcodeSdkClient {
    return this.probe.client
  }

  highestFence(key: string): number {
    return this.fences.get(key) ?? 0
  }

  observeFence(key: string, token: number): void {
    if (token > this.highestFence(key)) this.fences.set(key, token)
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /**
   * **Liveness** — a plain `ping()` on the probe connection.
   *
   * [F5] required the ping to name an attached session, on the theory that an unattached one is
   * answered bridge-locally while five other requests are answered from disk, so all six stay
   * green with a dead daemon. Both halves were re-tested against jcode 0.67.0 and **neither
   * holds**: `ping` takes no session id in protocol v1 at all, and when the daemon is killed the
   * bridge emits `error{code:'internal', message:'daemon connection closed'}` on every attached
   * connection, closes it, and fails every subsequent request — `list_sessions`, `peek_session`,
   * `archive_session`, `set_retention_policy` and `get_runtime_info` included. A connection
   * opened *after* the death completes its handshake from the bridge's own state and then fails
   * `EPIPE` on its first request, which is the one way a caller could still be fooled.
   *
   * So the cheap probe is the honest one, and the expensive mitigation is retired. The **stream**
   * is the other half: that `error` frame reaches the session's own consumer before the close
   * does, so a dead daemon is observable without polling at all.
   */
  async probeLiveness(): Promise<boolean> {
    try {
      await this.probe.client.ping()
      return true
    } catch {
      return false
    }
  }

  async runtimeInfo(): Promise<ExecutorRuntimeInfo> {
    /* `get_runtime_info` takes a session id in protocol v1 — the probe session's — and the SDK
     * pings before it, which is what makes the call itself a health check. */
    const info = await this.probe.client.getRuntimeInfo(this.probe.sessionId)
    /* A DELIBERATE SUBSET ([F14]): `healthy` is a hard-coded literal and `sessionId` names the
     * probe session — neither is instance state, and carrying `healthy` would invite reading a
     * cached value as a health check. */
    return {
      server: info.server,
      protocolVersion: info.protocolVersion,
      capabilities: info.capabilities ?? [],
      ...(info.provider === undefined ? {} : { provider: info.provider }),
      ...(info.model === undefined ? {} : { model: info.model }),
      providers: info.providers ?? [],
      routes: (info.routes ?? []).map((route) => ({
        model: route.model,
        provider: route.provider,
        apiMethod: route.apiMethod ?? '',
        available: route.available ?? false,
        detail: route.detail ?? '',
      })),
    }
  }

  /**
   * Session creation runs on a **fresh connection**, which then becomes that session's dedicated
   * one. It must not run on the probe's.
   *
   * Verified against jcode 0.67.0: `create_session` on a connection that is **already attached**
   * creates nothing and returns the attached session. Three creates on one connection produced
   * one session id and one row in `list_sessions`. Routing creation through the shared probe
   * connection — which `create_session` itself attaches ([F5]) — therefore collapses the entire
   * fleet onto the probe session: every delegation would share one transcript, one working
   * directory and one agent, while `ExecutorSessionHandle.sessionId` reported distinct ids only
   * because swarm never compared them.
   *
   * A title is a separate `rename_session` (there is no title on `create_session`), so it is
   * applied after the handle exists, on that handle's own connection.
   */
  async createSession(req: { workingDir: string; title?: string }): Promise<ExecutorSessionHandle> {
    this.assertUsable()
    const client = await this.options.transport.connect(this.socketPath)
    let created: { sessionId: string }
    try {
      created = await client.createSession({ workingDir: req.workingDir })
    } catch (error) {
      await client.close().catch(() => undefined)
      throw error
    }
    const session = new JcodeSession(created.sessionId, client, this)
    this.sessions.set(created.sessionId, session)
    if (req.title !== undefined) await session.rename(req.title).catch(() => undefined)
    return session
  }

  async openSession(sessionId: string): Promise<ExecutorSessionHandle> {
    this.assertUsable()
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return existing
    return this.adoptSession(sessionId)
  }

  /**
   * Attach a fresh connection to an **existing** session, and prove it landed.
   *
   * `attach_session` never fails on an unknown id (verified): on an already-attached connection it
   * answers with the session it is *already* holding, and on a virgin one it **manufactures a new
   * session** whose working directory is the bridge's cwd — outside the workspace, outside the
   * worktree, outside every guarantee §5.5 makes. Both answers look like success. Comparing the
   * returned id against the requested one is the only thing standing between a stale session id
   * and an agent quietly running somewhere else, so a mismatch is a hard failure and the
   * connection is closed rather than kept.
   */
  private async adoptSession(sessionId: string): Promise<ExecutorSessionHandle> {
    const client = await this.options.transport.connect(this.socketPath)
    let attached: { sessionId: string }
    try {
      attached = await client.attachSession(sessionId)
    } catch (error) {
      await client.close().catch(() => undefined)
      throw error
    }
    if (attached.sessionId !== sessionId) {
      await client.close().catch(() => undefined)
      throw new SwarmError(
        'executor_unavailable',
        `attach_session(${sessionId}) attached to ${attached.sessionId} instead; the session is gone`,
        { details: { requested: sessionId, attached: attached.sessionId } },
      )
    }
    const session = new JcodeSession(sessionId, client, this)
    this.sessions.set(sessionId, session)
    return session
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new SwarmError('executor_unavailable', `instance ${this.key} is disposed`)
    }
  }

  /** A **disk inventory** ([F16]) — swarm's own attempt records are authoritative for the fleet. */
  async listSessions(): Promise<ExecutorSessionInfo[]> {
    const rows = await this.probe.client.listSessions()
    return rows.map((row) => ({
      sessionId: row.sessionId,
      status: row.status ?? 'idle',
      trusted: false as const,
      archived: row.archived ?? false,
      ...(row.workingDir === undefined ? {} : { workingDir: row.workingDir }),
      ...(row.title === undefined ? {} : { title: row.title }),
      ...(row.transcriptBytes === undefined ? {} : { transcriptBytes: row.transcriptBytes }),
      ...(row.archivedAtMs === undefined ? {} : { archivedAtMs: row.archivedAtMs }),
    }))
  }

  /**
   * Instance-global — which is precisely why credentials are a pool dimension of `InstanceKey`
   * (R10). The provider must be one of the bridge's six ids, and a key with surrounding
   * whitespace, a newline or a NUL is refused before it reaches the wire ([F17]).
   */
  async setCredential(provider: InstanceCredentialProvider, apiKey: string): Promise<void> {
    if (apiKey !== apiKey.trim() || apiKey.includes('\n') || apiKey.includes('\0')) {
      throw new SwarmError('executor_refused', 'invalid_request: malformed api key')
    }
    await this.probe.client.setApiKey(provider, apiKey)
  }

  async dispose(reason: string): Promise<void> {
    this.disposed = true
    for (const session of Array.from(this.sessions.values())) await session.close(reason)
    await this.probe.client.close().catch(() => undefined)
    /* The singleton is released only here: while this instance lives, no second daemon may take
     * the same `JCODE_HOME` (§3.4 rule 3, R9). */
    this.homeLock?.release()
  }

  /**
   * §5.3's five steps. Step 1 is `dispose()`; step 2 re-resolves `daemonPid` from `servers.json`
   * so a server restart that reclaimed the instance can still kill it (R13); steps 3–5 live in
   * `killTwoGroups`.
   */
  async hardKill(reason: string): Promise<KillOutcomeReport> {
    if (this.pgid === null) {
      throw new SwarmError(
        'capability_absent',
        'no swarm-created process group to signal; refusing to guess a target (§4.3.7)',
      )
    }
    await this.dispose(reason)
    const daemonPid =
      this.daemonPid ??
      resolveDaemonPid(
        this.instanceOptions.jcodeHome,
        join(runtimeDirOf(this.instanceOptions), 'jcode.sock'),
      )
    const result = await killTwoGroups({
      pgid: this.pgid,
      daemonPid,
      ...(this.options.kill === undefined ? {} : { kill: this.options.kill }),
      ...(this.options.now === undefined ? {} : { now: this.options.now }),
      ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
      ...(this.options.killGraceMs === undefined ? {} : { graceMs: this.options.killGraceMs }),
    })
    this.child?.kill('SIGKILL')
    return { pgid: this.pgid, daemonPid, ...result }
  }
}

function runtimeDirOf(options: InstanceOptions): string {
  return join(options.jcodeHome, '..', 'runtime')
}

/* --------------------------------------------------------------------------------- adapter */

export interface JcodeAdapterOptions {
  /** How a connection is obtained. Injected so the adapter is testable with no binary at all. */
  readonly transport: JcodeTransport
  /** `undefined` ⇒ swarm spawns the bridge itself (§5.3); a launcher is injected by tests. */
  readonly launcher?: BridgeLauncher
  /** `undefined` ⇒ `jcode --version` under one second. */
  readonly versionProbe?: VersionProbe
  readonly socketExists?: (path: string) => boolean
  readonly binary?: string
  readonly versionFloor?: string
  readonly acceptTimeoutMs?: number
  readonly structuredDeadlineMs?: number
  /** How long `applyConfig` waits for the confirming `model_info` (§4.2). */
  readonly configConfirmMs?: number
  readonly killGraceMs?: number
  readonly kill?: (pid: number, signal: NodeJS.Signals | number) => void
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  /** Skip the spawn entirely and connect to an existing socket — the fake-transport path. */
  readonly socketPathOverride?: string
  readonly readServersJson?: (path: string) => string
  /** Written into `instances/<hash>/lock` beside the pid (§3.4 rule 3, §7.2). */
  readonly bootId?: string
  /** Injected by tests so the singleton can be driven with no second process. */
  readonly homeLockHooks?: Parameters<typeof acquireHomeLock>[2]
}

/** One boot id per server process — the half of the home lock a stale pid cannot forge. */
const PROCESS_BOOT_ID = `boot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

export class JcodeAdapter implements ExecutorAdapter {
  readonly id: AdapterId = 'jcode'
  readonly capabilities: ExecutorCapabilities = JCODE_CAPABILITIES
  private readonly instances = new Map<InstanceKey, ExecutorInstance>()

  private readonly options: JcodeAdapterOptions

  /* Declared, not a TypeScript parameter property: Node ≥ 24 runs `.ts` strip-only and cannot
   * erase one, which would break `node src/cli.ts` and the spawned demo server. */
  constructor(options: JcodeAdapterOptions) {
    this.options = options
  }

  preflight(): Promise<PreflightReport> {
    return Promise.resolve(
      preflightJcode({
        ...(this.options.binary === undefined ? {} : { binary: this.options.binary }),
        floor: this.options.versionFloor ?? SERVER_POLICY.jcodeVersionFloor,
        ...(this.options.versionProbe === undefined ? {} : { probe: this.options.versionProbe }),
      }),
    )
  }

  async acquireInstance(key: InstanceKey, opts: InstanceOptions): Promise<ExecutorInstance> {
    const existing = this.instances.get(key)
    if (existing !== undefined) return existing

    const report = await this.preflight()
    if (!report.ok) {
      throw new SwarmError(
        report.blocked === 'version_floor' ? 'version_floor' : 'executor_unavailable',
        `${report.detail} — fix: ${report.fix ?? 'see `swarm doctor`'}`,
        { details: { blocked: report.blocked, fix: report.fix, versions: report.versions } },
      )
    }

    const runtimeDir = runtimeDirOf(opts)
    const socketPath = this.options.socketPathOverride ?? join(runtimeDir, 'api.sock')
    const daemonSocket = join(runtimeDir, 'jcode.sock')

    /* §7.2's `instances/<hash>/lock`, taken **before** anything is spawned into that home. Two
     * daemons on one state dir corrupt `active_pids`/`internal_pids`/`streaming_pids` (§5.3, R9),
     * and the second one need not be a swarm process at all — hence a file, not only a store row. */
    const homeLock = acquireHomeLock(
      join(opts.jcodeHome, '..', 'lock'),
      { pid: process.pid, bootId: this.options.bootId ?? PROCESS_BOOT_ID },
      ...(this.options.homeLockHooks === undefined ? [] : [this.options.homeLockHooks]),
    )

    try {
      return await this.launchInstance(key, opts, {
        runtimeDir,
        socketPath,
        daemonSocket,
        homeLock,
      })
    } catch (error) {
      /* Nothing was ever started in that home, so nothing may keep claiming it. */
      homeLock.release()
      throw error
    }
  }

  private async launchInstance(
    key: InstanceKey,
    opts: InstanceOptions,
    paths: {
      readonly runtimeDir: string
      readonly socketPath: string
      readonly daemonSocket: string
      readonly homeLock: HomeLock
    },
  ): Promise<ExecutorInstance> {
    const { runtimeDir, socketPath, daemonSocket } = paths
    let child: SpawnedBridge | null = null
    let pgid: number | null = null
    if (this.options.socketPathOverride === undefined) {
      const launched = await launchBridge({
        binary: opts.binary ?? this.options.binary ?? 'jcode',
        socketPath,
        jcodeHome: opts.jcodeHome,
        runtimeDir,
        daemonSocket,
        bridgeArgv: opts.argv ?? [],
        env: opts.env,
        startupTimeoutMs: opts.startupTimeoutMs,
        inheritStderr: opts.inheritStderr,
        ...(this.options.launcher === undefined ? {} : { launcher: this.options.launcher }),
        ...(this.options.socketExists === undefined
          ? {}
          : { socketExists: this.options.socketExists }),
        ...(this.options.sleep === undefined ? {} : { sleep: this.options.sleep }),
      })
      child = launched.child
      pgid = launched.pgid
    }

    /* One probe connection, attached to a long-lived probe session in a scratch dir (§5.3).
     *
     * The scratch dir is not cosmetic: `create_session` binds the session's working directory,
     * and the probe session is the one session on the instance that no delegation owns. Pointing
     * it at a directory inside the instance's own home keeps the bridge's cwd — which is swarm's
     * cwd, i.e. wherever the operator happened to launch `swarm serve` — out of it. There is no
     * `title` on `create_session`; the probe carries none rather than a fake one. */
    const probeClient = await this.options.transport.connect(socketPath)
    const scratch = join(opts.jcodeHome, 'probe')
    mkdirSync(scratch, { recursive: true, mode: 0o700 })
    const probeSession = await probeClient.createSession({ workingDir: scratch })

    /* [F9]: the handshake has completed; only now may a pgid be recorded, and only if the child
     * that produced the socket is still the one serving it. */
    if (child !== null) assertChildStillAlive(child)

    /* [F12]: pin the retention policy rather than assume the default, because when a policy IS
     * set, `list_sessions` archives as a side effect of listing (R11). */
    await probeClient.setRetentionPolicy(undefined).catch(() => undefined)

    const daemonPid = resolveDaemonPid(
      opts.jcodeHome,
      daemonSocket,
      ...(this.options.readServersJson === undefined ? [] : [this.options.readServersJson]),
    )

    const instance = new JcodeInstance(
      key,
      pgid,
      daemonPid,
      { client: probeClient, sessionId: probeSession.sessionId },
      socketPath,
      this.options,
      opts,
      child,
      paths.homeLock,
    )
    this.instances.set(key, instance)
    return instance
  }

  /** For the health projection: `ok` comes from a ping on the ATTACHED probe connection ([F5]). */
  static async liveness(instance: ExecutorInstance): Promise<boolean> {
    return instance instanceof JcodeInstance ? instance.probeLiveness() : true
  }
}

export function createJcodeAdapter(options: JcodeAdapterOptions): JcodeAdapter {
  return new JcodeAdapter(options)
}
