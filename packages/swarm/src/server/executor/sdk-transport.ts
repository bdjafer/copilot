/**
 * The **real** `JcodeTransport`: `@1jehuang/jcode-sdk`'s `JcodeClient` behind swarm's port
 * (SPEC-swarm §5.3).
 *
 * This is the only file in the package that imports the SDK, which is the whole point of the port
 * next door: everything above it is testable with `fakeJcodeTransport()`, and an SDK bump breaks
 * exactly here.
 *
 * It does four jobs and no more — every one of them a shape mismatch verified against
 * `@1jehuang/jcode-sdk@1.1.0` and a live `jcode v0.67.0 (156ae4092)` bridge on 2026-08-04:
 *
 *  1. **snake_case → camelCase**, once. `session_id`, `working_dir`, `transcript_bytes`,
 *     `archived_at_ms`, `api_method`. Reading `sessionId` off a `SessionInfo` yields `undefined`
 *     silently, which is the failure mode this rename exists to make impossible.
 *  2. **`waitForAccept: false`, always.** The 1.1.0 default is `true` with a 10 s accept timeout,
 *     so omitting the flag blocks `sendMessage` on the un-acked send ([F2], §4.2). The receipt is
 *     derived from the stream; the call must not wait.
 *  3. **`runStructured`'s throw becomes a value.** The SDK raises `StructuredOutputError` after
 *     the last invalid attempt, carrying every attempt — which is the evidence §4.3.6 wants, so
 *     it is unpacked rather than swallowed.
 *  4. **A closed client yields a closed iterator.** The SDK's `events()` registers
 *     `once('close')`; on a client whose close already fired, `done` stays false and `next()`
 *     never settles (verified: it hangs). The close is tracked here so the adapter's pump always
 *     terminates.
 *
 * Node ≥ 24, server-only.
 */

import {
  type ApiEvent,
  type HistoryMessage,
  JcodeClient,
  type SessionInfo,
  StructuredOutputError,
} from '@1jehuang/jcode-sdk'

import type {
  JcodeApiEvent,
  JcodeRuntimeInfo,
  JcodeSdkClient,
  JcodeSendOptions,
  JcodeSessionInfo,
  JcodeStructuredOutcome,
  JcodeTransport,
} from './sdk.ts'

export interface RealJcodeTransportOptions {
  /** Sent in the handshake. Identifies swarm in the bridge's logs. */
  readonly clientName?: string
  /**
   * The SDK's per-request deadline. Left at its default (30 s) because [F10]'s mid-turn park is
   * exactly what it is for: swarm refuses mid-turn config *before* the call, so nothing swarm
   * issues should ever reach it.
   */
  readonly requestTimeoutMs?: number
}

const sessionInfo = (info: SessionInfo): JcodeSessionInfo => ({
  sessionId: info.session_id,
  ...(info.working_dir === undefined ? {} : { workingDir: info.working_dir }),
  ...(info.title === undefined ? {} : { title: info.title }),
  ...(info.status === undefined ? {} : { status: info.status }),
  ...(info.transcript_bytes === undefined ? {} : { transcriptBytes: info.transcript_bytes }),
  ...(info.archived === undefined ? {} : { archived: info.archived }),
  ...(info.archived_at_ms === undefined ? {} : { archivedAtMs: info.archived_at_ms }),
})

const historyRow = (row: HistoryMessage): { role: string; content: string } => ({
  role: row.role,
  content: row.content,
})

/**
 * The SDK's `ApiEvent` union is wider than swarm's: it also carries every *reply* frame, which
 * this connection consumes through the request methods. Anything not in the port's union is
 * dropped here rather than at the normalizer, so `normalizeJcodeEvent` stays total.
 */
const STREAM_EVENTS: ReadonlySet<string> = new Set([
  'text_delta',
  'reasoning_delta',
  'reasoning_done',
  'tool_start',
  'tool_exec',
  'tool_input_delta',
  'tool_done',
  'token_usage',
  'message_accepted',
  'turn_done',
  'background_progress',
  'model_info',
  'session_status',
  'session_renamed',
  'error',
])

class RealJcodeClient implements JcodeSdkClient {
  /**
   * Set from the SDK's `close` event. The SDK exposes no public `closed`, and an `events()` call
   * made after the close would hang forever — so the close is observed here, once, at
   * construction.
   */
  private closed = false

  private readonly client: JcodeClient

  /* Declared, not a TypeScript parameter property: Node ≥ 24 runs `.ts` strip-only and cannot
   * erase one, which would break `node src/cli.ts` and the spawned demo server. */
  constructor(client: JcodeClient) {
    this.client = client
    client.on('close', () => {
      this.closed = true
    })
  }

  events(): AsyncIterableIterator<JcodeApiEvent> {
    if (this.closed) {
      const done: AsyncIterableIterator<JcodeApiEvent> = {
        [Symbol.asyncIterator]: () => done,
        next: () => Promise.resolve({ value: undefined, done: true }),
        return: () => Promise.resolve({ value: undefined, done: true }),
      }
      return done
    }
    const source = this.client.events()
    const iterator: AsyncIterableIterator<JcodeApiEvent> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async (): Promise<IteratorResult<JcodeApiEvent>> => {
        for (;;) {
          const next = await source.next()
          if (next.done === true) return { value: undefined, done: true }
          const event = next.value as ApiEvent
          if (STREAM_EVENTS.has(event.ev)) {
            return { value: event as unknown as JcodeApiEvent, done: false }
          }
        }
      },
      return: async (): Promise<IteratorResult<JcodeApiEvent>> => {
        await source.return?.()
        return { value: undefined, done: true }
      },
    }
    return iterator
  }

  async createSession(req: { workingDir: string }): Promise<JcodeSessionInfo> {
    return sessionInfo(await this.client.createSession(req.workingDir))
  }

  async attachSession(sessionId: string): Promise<JcodeSessionInfo> {
    return sessionInfo(await this.client.attachSession(sessionId))
  }

  async sendMessage(sessionId: string, text: string, options?: JcodeSendOptions): Promise<void> {
    await this.client.sendMessage(sessionId, text, {
      ...(options?.images === undefined
        ? {}
        : { images: [...options.images] as [string, string][] }),
      ...(options?.noReply === undefined ? {} : { noReply: options.noReply }),
      /* Never omitted: the 1.1.0 default is `true` and would block the send (§4.2, [F2]). */
      waitForAccept: options?.waitForAccept ?? false,
    })
  }

  async setModel(sessionId: string, model: string): Promise<void> {
    await this.client.setModel(sessionId, model)
  }

  async setReasoningEffort(sessionId: string, effort: string): Promise<void> {
    await this.client.setReasoningEffort(sessionId, effort)
  }

  async softInterrupt(sessionId: string, text: string, urgent?: boolean): Promise<void> {
    await this.client.softInterrupt(sessionId, text, urgent === true)
  }

  async cancel(sessionId: string): Promise<void> {
    await this.client.cancel(sessionId)
  }

  async cancelSoftInterrupts(sessionId: string): Promise<void> {
    await this.client.cancelSoftInterrupts(sessionId)
  }

  async runStructured<T>(
    sessionId: string,
    text: string,
    options: { schema: unknown; maxRetries?: number },
  ): Promise<JcodeStructuredOutcome<T>> {
    try {
      const result = await this.client.runStructured<T>(sessionId, text, {
        schema: options.schema as never,
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
      })
      return {
        value: result.data,
        attempts: result.attempts.length,
        raw: result.attempts.map((attempt) => attempt.text),
        failed: false,
      }
    } catch (error) {
      /* Every attempt is on the error, and every attempt is evidence (§4.3.6) — a `failed` result
       * with an empty `raw` would throw away the only record of what the model actually said. */
      if (error instanceof StructuredOutputError) {
        return {
          value: null,
          attempts: error.attempts.length,
          raw: error.attempts.map((attempt) => attempt.text),
          failed: true,
          error: { code: error.code, message: error.message },
        }
      }
      return {
        value: null,
        attempts: 0,
        raw: [],
        failed: true,
        error: {
          code: (error as { code?: string }).code ?? 'internal',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }

  async peekSession(
    sessionId: string,
    limit: number,
  ): Promise<readonly { role: string; content: string }[]> {
    return (await this.client.peekSession(sessionId, limit)).map(historyRow)
  }

  async getHistory(sessionId: string): Promise<readonly { role: string; content: string }[]> {
    return (await this.client.getHistory(sessionId)).map(historyRow)
  }

  async listSessions(): Promise<readonly JcodeSessionInfo[]> {
    return (await this.client.listSessions({ includeArchived: true })).map(sessionInfo)
  }

  async archiveSession(sessionId: string): Promise<void> {
    await this.client.archiveSession(sessionId)
  }

  async renameSession(sessionId: string, title?: string): Promise<void> {
    await this.client.renameSession(sessionId, title)
  }

  async setRetentionPolicy(archiveAfterDays?: number): Promise<void> {
    await this.client.setRetentionPolicy(archiveAfterDays)
  }

  async setApiKey(provider: string, apiKey: string): Promise<void> {
    await this.client.setApiKey(provider, apiKey)
  }

  async getRuntimeInfo(sessionId: string): Promise<JcodeRuntimeInfo> {
    const info = await this.client.getRuntimeInfo(sessionId)
    return {
      server: info.server,
      protocolVersion: info.protocolVersion,
      capabilities: info.capabilities,
      ...(info.provider === undefined ? {} : { provider: info.provider }),
      ...(info.model === undefined ? {} : { model: info.model }),
      providers: info.providers,
      routes: info.routes.map((route) => ({
        model: route.model,
        provider: route.provider,
        apiMethod: route.api_method,
        available: route.available,
        detail: route.detail,
      })),
      healthy: info.healthy,
    }
  }

  async ping(): Promise<void> {
    await this.client.ping()
  }

  supports(capability: string): boolean {
    return this.client.supports(capability)
  }

  async close(): Promise<void> {
    this.closed = true
    await this.client.close()
  }
}

/**
 * One connection per call — never a shared client, because §5.3's whole attribution argument for
 * an untagged `error` frame ([F6]) rests on one connection serving one session, and because
 * `create_session` on an attached connection returns the attachment instead of creating anything.
 *
 * `JcodeClient.launch()` is **never** used (R12): it inherits the user's provider logins by
 * default (S10), spawns `detached: false` into swarm's own process group, and merges rather than
 * replaces the child env. Swarm spawns the bridge itself in `spawn.ts` and connects here.
 */
export function createRealJcodeTransport(options: RealJcodeTransportOptions = {}): JcodeTransport {
  return {
    async connect(socketPath: string) {
      const client = await JcodeClient.connect({
        socketPath,
        clientName: options.clientName ?? 'astrale-swarm/0.1',
        ...(options.requestTimeoutMs === undefined
          ? {}
          : { requestTimeoutMs: options.requestTimeoutMs }),
      })
      return new RealJcodeClient(client)
    },
  }
}
