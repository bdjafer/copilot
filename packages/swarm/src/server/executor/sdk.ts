/**
 * The **structural** subset of `@1jehuang/jcode-sdk`'s client that swarm uses (SPEC-swarm §4.2,
 * §5.3), declared here rather than imported.
 *
 * Why declared: §1.2 lists `@1jehuang/jcode-sdk >=1.0.1 <2` as a `./server` dependency, but the
 * registry copy is suppressed by this workspace's supply-chain minimum-package-age policy, so
 * nothing may `import` it today (foundation deviation D7). Declaring the surface structurally
 * costs one interface and buys three things the import would not: the adapter is testable against
 * `fakeJcodeTransport()` with no binary, the version floor stays swarm's (the SDK enforces none),
 * and a future SDK bump is a compile error at exactly one seam instead of a runtime surprise.
 *
 * Every signature below is quoted from the verified surface, not paraphrased. Three absences are
 * deliberate and permanent:
 *
 *  - the fan-in event iterator (decision log #11) — banned; one dedicated connection per session;
 *  - the client-side detach (#10) — a verified no-op; `close()` is the only lease release;
 *  - the lossy history read ([F8], #45) — `peekSession` is the only transcript read swarm makes.
 *
 * Node ≥ 24, server-only. Types plus one enum-shaped constant; no runtime behaviour.
 */

/** `ApiEvent` as the bridge emits it. `session_id` is absent on `error` frames ([F6], V11). */
export type JcodeApiEvent =
  | { readonly ev: 'text_delta'; readonly session_id: string; readonly text: string }
  | { readonly ev: 'reasoning_delta'; readonly session_id: string; readonly text: string }
  | {
      readonly ev: 'reasoning_done'
      readonly session_id: string
      readonly duration_secs?: number
    }
  | {
      readonly ev: 'tool_start' | 'tool_exec'
      readonly session_id: string
      readonly id: string
      readonly name: string
    }
  /**
   * `call_id` is **always** `''`: the bridge hard-codes `call_id: String::new()` for
   * `tool_input_delta` ([F11]). The adapter attributes it to the most recent `tool_start` on the
   * session and MUST NOT key input buffers by it.
   */
  | {
      readonly ev: 'tool_input_delta'
      readonly session_id: string
      readonly call_id: ''
      readonly delta: string
    }
  | {
      readonly ev: 'tool_done'
      readonly session_id: string
      readonly id: string
      readonly name: string
      readonly output: string
      readonly error?: string
    }
  | {
      readonly ev: 'usage'
      readonly session_id: string
      readonly input_tokens: number
      readonly output_tokens: number
      readonly cache_read_input_tokens?: number
    }
  | { readonly ev: 'message_accepted'; readonly session_id: string }
  | { readonly ev: 'turn_done'; readonly session_id: string }
  | {
      readonly ev: 'model_info'
      readonly session_id: string
      readonly provider?: string
      readonly model?: string
      readonly solicited?: boolean
    }
  | { readonly ev: 'session_status'; readonly session_id: string; readonly status: string }
  /** Reverse-engineered from a literal markdown header in a notification body ([B7], #16). */
  | {
      readonly ev: 'notification'
      readonly session_id: string
      readonly body: string
      readonly title?: string
    }
  /** **No `session_id`** ([F6]) — attributable only because one connection serves one session. */
  | { readonly ev: 'error'; readonly code: string; readonly message: string }
  | { readonly ev: 'closed'; readonly reason?: string }

export interface JcodeSessionInfo {
  readonly sessionId: string
  readonly workingDir?: string
  readonly title?: string
  /** The vocabulary is `attached|idle|processing` and it **lies** for running sessions (#18). */
  readonly status?: string
  readonly transcriptBytes?: number
  readonly archived?: boolean
  readonly archivedAtMs?: number
}

export interface JcodeRuntimeInfo {
  readonly server: string
  readonly protocolVersion: number
  readonly capabilities?: readonly string[]
  readonly provider?: string
  readonly model?: string
  readonly providers?: readonly string[]
  readonly routes?: readonly {
    readonly model: string
    readonly provider: string
    readonly apiMethod?: string
    readonly available?: boolean
    readonly detail?: string
  }[]
  /**
   * Present on the SDK's `RuntimeInfo` and deliberately **not** carried through the seam ([F14]):
   * it is a hard-coded literal, and the only real liveness signal is the `ping` the call makes
   * first — which §5.3 requires on an **attached** connection.
   */
  readonly healthy?: boolean
}

export interface JcodeStructuredOutcome<T> {
  readonly value: T | null
  readonly attempts: number
  readonly raw: readonly string[]
  readonly failed: boolean
  readonly error?: { readonly code: string; readonly message: string }
}

/**
 * `sendMessage`'s third argument.
 *
 * The accept-wait flag is **absent by name and by use** (#42, §13). Its default is "do not wait",
 * which is exactly what §4.2 requires, and passing it explicitly would be indistinguishable in a
 * grep from passing it `true` — with which the SDK *resolves* on timeout ([F2]) and `accepted`
 * and `unknown` become the same value. `SubmitReceipt.ack` is derived from an observed
 * `message_accepted` on this session's own stream, never from this call returning.
 */
export interface JcodeSendOptions {
  /** `[mediaType, base64]` pairs — `ImageAttachment = [string, string]`. */
  readonly images?: readonly (readonly [string, string])[]
  /** Persists context without starting a turn; **no `turn_done` ever arrives** (§4.2, #32). */
  readonly noReply?: boolean
}

/** The six provider ids the bridge accepts; anything else is `invalid_request` ([F17]). */
export const JCODE_CREDENTIAL_PROVIDERS = [
  'claude-api',
  'openai-api',
  'openrouter',
  'cursor',
  'gemini',
  'jcode',
] as const

/**
 * One bridge connection. §5.3's topology binds **one connection to one session**, which is what
 * makes an `error` frame with no `session_id` attributable at all ([F6]).
 */
export interface JcodeSdkClient {
  /** The hot stream for this connection. Never fan-in — the fan-in iterator is banned (#11). */
  events(): AsyncIterableIterator<JcodeApiEvent>
  createSession(req: { workingDir: string; title?: string }): Promise<{ sessionId: string }>
  attachSession(sessionId: string): Promise<void>
  sendMessage(sessionId: string, text: string, options?: JcodeSendOptions): Promise<void>
  setModel(sessionId: string, model: string): Promise<void>
  /**
   * Returns `Promise<void>`; the bridge discards the daemon's applied value and there is no
   * getter (§5.4 #11), so `effortConfirmed` is a literal `false`. Unknown values are **rejected**
   * ([F3]) — but `swarm`/`swarm-deep` are inside the accepted set, which is why the ladder is
   * validated three times on swarm's side (§4.1, #9).
   */
  setReasoningEffort(sessionId: string, effort: string | null): Promise<void>
  softInterrupt(sessionId: string, text: string, urgent?: boolean): Promise<void>
  cancel(sessionId: string): Promise<void>
  /** The **only** retract primitive, and it is session-wide (§5.4 #16, V14). */
  cancelSoftInterrupts(sessionId: string): Promise<void>
  runStructured<T>(
    sessionId: string,
    text: string,
    options: { schema: unknown; maxRetries?: number },
  ): Promise<JcodeStructuredOutcome<T>>
  /** `stored_tail` — the read that flattens, and the only one swarm makes ([F8], #45). */
  peekSession(
    sessionId: string,
    limit: number,
  ): Promise<readonly { role: string; content: string }[]>
  /** A **disk inventory**, not a live-session list ([F16]). */
  listSessions(): Promise<readonly JcodeSessionInfo[]>
  archiveSession(sessionId: string): Promise<void>
  renameSession(sessionId: string, title: string | null): Promise<void>
  /**
   * `undefined` **disables** auto-archive. Defence in depth ([F12]): the default is already off,
   * but when a policy *is* set, `list_sessions` archives as a side effect of listing (R11).
   */
  setRetentionPolicy(policy: { archiveAfterDays?: number } | undefined): Promise<void>
  setApiKey(provider: string, apiKey: string): Promise<void>
  getRuntimeInfo(): Promise<JcodeRuntimeInfo>
  /**
   * With no session id this is answered **bridge-locally** and proves nothing ([F5]). Liveness
   * MUST come from a ping on the attached probe connection.
   */
  ping(sessionId?: string): Promise<void>
  supports(capability: string): boolean
  close(): Promise<void>
}

/** How the adapter obtains a connection. One call, one connection, one session (§5.3). */
export interface JcodeTransport {
  connect(socketPath: string): Promise<JcodeSdkClient>
}
