/**
 * The **structural** subset of `@1jehuang/jcode-sdk`'s client that swarm uses (SPEC-swarm §4.2,
 * §5.3), declared here rather than imported.
 *
 * Why declared rather than imported: the adapter must be testable against `fakeJcodeTransport()`
 * with no binary, the version floor stays swarm's (the SDK enforces none), and an SDK bump is a
 * compile error at exactly one seam instead of a runtime surprise. `sdk-transport.ts` is the one
 * file that imports the real package and satisfies this port.
 *
 * **Every signature and every field below was verified on 2026-08-04 against the installed
 * `@1jehuang/jcode-sdk@1.1.0` and a live `jcode v0.67.0 (156ae4092)` `api-bridge`** — a throwaway
 * `JCODE_HOME` under `/tmp`, no credentials, no model turn. The spec was written against the
 * 1.0.1 surface; where the two disagree, reality wins and the divergence is named on the member.
 * `test/real-bridge.test.ts` re-derives every claim from the running binary under
 * `SWARM_REAL_BRIDGE=1`, so this comment is checkable rather than merely asserted.
 *
 * The audited-vs-real deltas, in the order they bite:
 *
 *  1. **`sendMessage` waits for the ack by default** in 1.1.0 (`waitForAccept ?? true`,
 *     `acceptTimeoutMs ?? 10_000`), where 1.0.1 defaulted to "do not wait". Omitting the flag
 *     blocks the call up to 10 s on an un-acked send. It is passed **explicitly `false`** (§4.2,
 *     [F2]); the receipt still comes from an observed `message_accepted`, never from the call.
 *  2. **`ping()` takes no session id.** [F5]'s "liveness only from a ping naming the attached
 *     session" is unexpressible — and unnecessary (see 3).
 *  3. **The "disk-served" set is not disk-served.** With the daemon killed and the bridge alive,
 *     `ping`, `list_sessions`, `peek_session`, `archive_session`, `set_retention_policy` and
 *     `get_runtime_info` **all** fail (`harness connection closed`; `EPIPE` on a connection
 *     opened afterwards). [F5]'s "these stay green with a dead daemon" does not hold on 0.67.0.
 *  4. **`create_session` takes only `working_dir`**, and only on a connection that is **not yet
 *     attached**: on an attached connection it returns *that* session unchanged (verified — three
 *     creates on one connection yielded one session id and one row in `list_sessions`). A title
 *     is a separate `rename_session`.
 *  5. **`attach_session` with an unknown id does not fail.** On an attached connection it answers
 *     with the session already attached; on a virgin connection it **manufactures a new session**
 *     (verified: `attachSession('no-such-session')` produced a fresh id whose `working_dir` was
 *     the bridge's cwd). Callers MUST compare the returned id with the requested one.
 *  6. **`get_runtime_info` requires a session id**, and is attachment-scoped.
 *  7. **The wire is snake_case**: `session_id`, `working_dir`, `transcript_bytes`, `api_method`,
 *     `call_id`. Every 1.0.1-era camelCase read would have been `undefined`, silently.
 *  8. **`usage` is `token_usage`** with `input`/`output`/`cache_read_input`.
 *  9. **`background_progress` is a first-class event.** [B7]'s markdown-header scrape of a
 *     `notification` body is obsolete: `notification` is not an event kind on 0.67.0.
 * 10. **There is no `closed` event.** The iterator simply ends; the adapter synthesizes the
 *     terminal.
 * 11. **`runStructured` throws `StructuredOutputError`** after the last attempt and returns
 *     `{ data, attempts: StructuredOutputAttempt[] }` on success — not an outcome record.
 * 12. **`model_info` carries no `solicited`.**
 * 13. **Session-scoped requests are attachment-scoped, with two exceptions.** `get_history`,
 *     `get_runtime_info`, `rename_session`, `send_message`, `cancel`, `soft_interrupt`,
 *     `set_reasoning_effort`, `set_model`, `compact` and `list_models` all refuse a session the
 *     connection is not attached to, with `unknown_session: this connection is attached to `<a>`,
 *     not `<b>`; attach to it first or use another connection`. **`peek_session` and
 *     `archive_session` answer for any session, from any connection** (verified).
 *
 * Three absences remain deliberate and permanent:
 *
 *  - the fan-in event iterator (`globalEvents`, decision log #11) — banned; one connection per
 *    session, which is the whole of [F6]'s attribution argument;
 *  - the client-side detach (#10) — `close()` is the only lease release;
 *  - `run`/`runStructured`'s convenience turn loop, except where §4.3.6 needs the structured one.
 *
 * Node ≥ 24, server-only. Types plus enum-shaped constants; no runtime behaviour.
 */

/**
 * `ApiEvent` as the bridge emits it — **the wire shape, snake_case, protocol v1**.
 *
 * Only the members swarm normalizes are listed. The bridge emits more (`hello_ok`, `ok`,
 * `sessions`, `attached`, `history`, `pong`, `models`, `runtime_info`, `credential_updated`,
 * `file_*`, `compacted`, `permission_request`); those are all *replies*, correlated by `reply_to`
 * and consumed by the request methods rather than by the stream.
 */
export type JcodeApiEvent =
  | { readonly ev: 'text_delta'; readonly session_id: string; readonly text: string }
  | { readonly ev: 'reasoning_delta'; readonly session_id: string; readonly text: string }
  | {
      readonly ev: 'reasoning_done'
      readonly session_id: string
      readonly duration_secs?: number
    }
  /** `call_id`, **not** `id` — the 1.0.1-era `event["id"]` read was wrong for all four. */
  | {
      readonly ev: 'tool_start' | 'tool_exec'
      readonly session_id: string
      readonly call_id: string
      readonly name: string
    }
  /**
   * [F11] said the bridge hard-codes `call_id: String::new()` here. Protocol v1 types it as a
   * plain `string`, and whether 0.67.0 still empties it is **not reachable without a model turn**
   * — so the adapter keeps the mitigation either way: the delta is attributed to the most recent
   * `tool_start` on that session whenever `call_id` is empty, and taken at face value when it is
   * not. Both directions are conformance-tested.
   */
  | {
      readonly ev: 'tool_input_delta'
      readonly session_id: string
      readonly call_id: string
      readonly delta: string
    }
  | {
      readonly ev: 'tool_done'
      readonly session_id: string
      readonly call_id: string
      readonly name: string
      readonly output: string
      readonly error?: string
    }
  /** `token_usage`, not `usage`; `input`/`output`/`cache_read_input`, not `*_tokens`. */
  | {
      readonly ev: 'token_usage'
      readonly session_id: string
      readonly input: number
      readonly output: number
      readonly cache_read_input?: number
    }
  | { readonly ev: 'message_accepted'; readonly session_id: string }
  | { readonly ev: 'turn_done'; readonly session_id: string }
  /**
   * **First-class in protocol v1.** [B7]'s scrape of a markdown header in a `notification` body
   * described a bridge that no longer exists, so background progress is carried with
   * `provenance:'native'` and is a real signal — still barred from state, budget and completion.
   */
  | {
      readonly ev: 'background_progress'
      readonly session_id: string
      readonly task_id: string
      readonly label: string
      readonly percent?: number
      readonly summary: string
      readonly done?: boolean
    }
  | {
      readonly ev: 'model_info'
      readonly session_id: string
      readonly provider?: string
      readonly model?: string
    }
  | { readonly ev: 'session_status'; readonly session_id: string; readonly status: string }
  /**
   * Emitted on every `rename_session` (verified). `title` is absent when the generated title was
   * restored, and `display_title` then carries the generated one. Not a turn event: §5.1's union
   * has no member for it, so the normalizer drops it rather than smuggling it in as something
   * else.
   */
  | {
      readonly ev: 'session_renamed'
      readonly session_id: string
      readonly title?: string
      readonly display_title: string
    }
  /**
   * **No `session_id`** ([F6], re-verified) — attributable only because one connection serves one
   * session. The daemon-death frame is `{code:'internal', message:'daemon connection closed'}`,
   * delivered to **every** attached connection and immediately followed by the connection
   * closing.
   */
  | { readonly ev: 'error'; readonly code: JcodeErrorCode; readonly message: string }

/** `ErrorCode` from protocol v1. `unknown_session` is what an attachment mismatch produces. */
export type JcodeErrorCode =
  | 'unsupported_version'
  | 'unknown_request'
  | 'unknown_session'
  | 'invalid_request'
  | 'internal'

/**
 * `SessionInfo`, camelCased at this seam. The wire is snake_case (`session_id`, `working_dir`,
 * `transcript_bytes`, `archived_at_ms`) and `sdk-transport.ts` is where the rename happens, once.
 *
 * `title` is declared because the wire declares it, but **0.67.0 never populates it**: a session
 * renamed to `"my-title"` still lists with no `title` field. Anything that renders a title must
 * therefore have a fallback, and swarm's own attempt records are that fallback ([F16]).
 */
export interface JcodeSessionInfo {
  readonly sessionId: string
  readonly workingDir?: string
  readonly title?: string
  /**
   * Verified vocabulary: `create_session` and `attach_session` answer `idle`, while
   * `list_sessions` reports `attached` for a session some connection holds. Neither says whether
   * a turn is running, which is the whole of #18 — carried, never used.
   */
  readonly status?: string
  readonly transcriptBytes?: number
  readonly archived?: boolean
  readonly archivedAtMs?: number
}

export interface JcodeRuntimeInfo {
  readonly server: string
  readonly protocolVersion: number
  readonly capabilities?: readonly string[]
  /**
   * A **display** name (`"Claude"`, `"Anthropic"`, `"OpenAI"`), not one of the six credential
   * provider ids and not the `--provider` vocabulary. Three distinct namespaces, verified.
   */
  readonly provider?: string
  readonly model?: string
  readonly providers?: readonly string[]
  /** `api_method` on the wire. */
  readonly routes?: readonly {
    readonly model: string
    readonly provider: string
    readonly apiMethod?: string
    readonly available?: boolean
    readonly detail?: string
  }[]
  /**
   * Present on the SDK's `RuntimeInfo` and deliberately **not** carried through the seam ([F14]):
   * it is typed `healthy: true` — a literal, not a measurement. The real liveness signal is the
   * `ping()` the call makes first, which does fail once the daemon is gone.
   */
  readonly healthy?: boolean
}

/** What `runStructured` yields once the SDK's throw has been turned back into a value. */
export interface JcodeStructuredOutcome<T> {
  readonly value: T | null
  readonly attempts: number
  /** Every attempt's raw text, valid or not — stored as evidence (§4.3.6). */
  readonly raw: readonly string[]
  readonly failed: boolean
  readonly error?: { readonly code: string; readonly message: string }
}

/**
 * `sendMessage`'s third argument.
 *
 * `waitForAccept` is present **and always passed `false`** (§4.2, [F2]). In 1.0.1 its default was
 * "do not wait" and §13 could require the flag to be absent; in 1.1.0 the default is `true`, so
 * absence now means up to ten seconds of blocking on exactly the un-acked send whose latency
 * matters most. Either way the SDK's `waitForEvent` **resolves** on timeout, so the call can
 * never distinguish `accepted` from `unknown` — `SubmitReceipt.ack` comes from the stream.
 */
export interface JcodeSendOptions {
  /** `[mediaType, base64]` pairs — `ImageAttachment = [string, string]`. */
  readonly images?: readonly (readonly [string, string])[]
  /**
   * Persists context without starting a turn. Verified on 0.67.0: **no `message_accepted` and no
   * `turn_done` ever arrive**, the message is visible in `get_history` immediately, and it is
   * **never** visible in `peek_session` (still absent after 3 s — see `peekSession`).
   */
  readonly noReply?: boolean
  /** Swarm always passes `false`; see above. */
  readonly waitForAccept?: boolean
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
 * The bridge's own refusal, verbatim from 0.67.0 — the oracle that keeps the list above honest.
 * `test/real-bridge.test.ts` asserts the live message equals this string, so the day the bridge
 * adds a seventh provider the constant fails rather than the fleet.
 */
export const JCODE_UNSUPPORTED_PROVIDER_MESSAGE =
  'unsupported API-key provider; supported: claude-api, openai-api, openrouter, cursor, gemini, jcode'

/**
 * One bridge connection. §5.3's topology binds **one connection to one session**, which is what
 * makes an `error` frame with no `session_id` attributable at all ([F6]).
 */
export interface JcodeSdkClient {
  /**
   * The hot stream for this connection. Never fan-in — `globalEvents` is banned (#11).
   *
   * Ends when the connection closes and emits **no terminal event**; the adapter synthesizes
   * `closed`. Calling it on an already-closed client is an SDK hazard — its `once('close')` has
   * already fired, so `done` stays false and `next()` never settles (verified: it hangs) — which
   * is why `sdk-transport.ts` tracks the close itself and returns an already-done iterator.
   */
  events(): AsyncIterableIterator<JcodeApiEvent>
  /**
   * Only `working_dir`; a title is a separate `renameSession`.
   *
   * **MUST be called on a connection with no attachment.** On an attached connection the bridge
   * returns the attached session unchanged and creates nothing (verified), so a caller that
   * creates on a shared connection silently gets one session for every workspace.
   */
  createSession(req: { workingDir: string }): Promise<JcodeSessionInfo>
  /**
   * Returns the session the connection **actually ends up attached to** — which for an unknown id
   * is either the previous attachment or a freshly manufactured session. Callers MUST compare it
   * with what they asked for.
   */
  attachSession(sessionId: string): Promise<JcodeSessionInfo>
  sendMessage(sessionId: string, text: string, options?: JcodeSendOptions): Promise<void>
  /**
   * Verified rejection shapes: `''` ⇒ `invalid_request: set_model needs a non-empty `model``
   * (bridge-side, before any provider lookup, so it is reachable with no credentials); any other
   * value with the provider unavailable ⇒ `invalid_request: Model switching is not available for
   * this provider.` Which model ids a *reachable* provider accepts is not observable without
   * credentials.
   */
  setModel(sessionId: string, model: string): Promise<void>
  /**
   * Returns `Promise<void>`; the bridge discards the daemon's applied value and there is no
   * getter (§5.4 #11), so `effortConfirmed` is a literal `false`.
   *
   * Verified rejection shapes on 0.67.0, in the order the bridge checks them:
   *  - `''` ⇒ `invalid_request: set_reasoning_effort needs a non-empty `effort`` — bridge-side,
   *    before any provider lookup, so it is reachable with no credentials;
   *  - anything else with the provider unavailable ⇒ `invalid_request: Anthropic provider not
   *    available` — **including `swarm`/`swarm-deep`**, which is why an `ok` from this call can
   *    never be read as validation, and why §4.1's ladder is swarm's own, three times over.
   *
   * Which *values* a reachable provider accepts is **not observable without credentials**, and is
   * the one thing this port cannot verify against the real bridge today.
   */
  setReasoningEffort(sessionId: string, effort: string): Promise<void>
  softInterrupt(sessionId: string, text: string, urgent?: boolean): Promise<void>
  cancel(sessionId: string): Promise<void>
  /** The **only** retract primitive, and it is session-wide (§5.4 #16, V14). */
  cancelSoftInterrupts(sessionId: string): Promise<void>
  /**
   * The SDK **throws** `StructuredOutputError` when every bounded attempt fails validation;
   * `sdk-transport.ts` turns that back into `failed: true` so this seam stays total.
   */
  runStructured<T>(
    sessionId: string,
    text: string,
    options: { schema: unknown; maxRetries?: number },
  ): Promise<JcodeStructuredOutcome<T>>
  /**
   * `stored_tail`, and **connection-agnostic**: it answers for any session from any connection,
   * and an unknown id answers `[]` rather than failing (verified).
   *
   * It is not the live transcript and it **lags without bound**: a message sent with `noReply`
   * was still absent 3 s later while `get_history` already carried it, and a fresh session's
   * stored tail holds jcode's own injected session-context reminder rather than anything the
   * caller sent. `limit: 0` returns `[]`.
   */
  peekSession(
    sessionId: string,
    limit: number,
  ): Promise<readonly { role: string; content: string }[]>
  /**
   * The live transcript, and **attachment-scoped** — it refuses any session but this connection's
   * with `unknown_session` (verified).
   *
   * [F8]/#45 pinned swarm to `peekSession` because `get_history` does
   * `content.as_str().unwrap_or("")` and flattens a block-array message to `""`. That is still
   * true and still the reason it is never the *only* read. But it is the only read that reflects
   * a message the stored tail has not flushed — which, per `peekSession` above, is every message
   * swarm sends — so §5.5's digest match needs both.
   */
  getHistory(sessionId: string): Promise<readonly { role: string; content: string }[]>
  /** A session inventory, merged from disk and the bridge's snapshot ([F16]). */
  listSessions(): Promise<readonly JcodeSessionInfo[]>
  /** Connection-agnostic, like `peekSession` (verified). */
  archiveSession(sessionId: string): Promise<void>
  /** `undefined` restores the generated title; the wire field is simply omitted. */
  renameSession(sessionId: string, title?: string): Promise<void>
  /**
   * `undefined` **disables** auto-archive. Defence in depth ([F12]): the default is already off,
   * but when a policy *is* set, `list_sessions` archives as a side effect of listing (R11). The
   * wire takes a bare `archive_after_days`, not an object, and rejects `0` with
   * `invalid_request: archive_after_days must be 1..=36500, or null to disable` (verified).
   */
  setRetentionPolicy(archiveAfterDays?: number): Promise<void>
  setApiKey(provider: string, apiKey: string): Promise<void>
  /** Requires a session id, is attachment-scoped, and pings first — a real health check. */
  getRuntimeInfo(sessionId: string): Promise<JcodeRuntimeInfo>
  /**
   * No session argument exists. It is a bridge round trip that **fails once the daemon is gone**
   * (verified: the connection is closed out from under it), so it is swarm's liveness probe.
   */
  ping(): Promise<void>
  supports(capability: string): boolean
  close(): Promise<void>
}

/** How the adapter obtains a connection. One call, one connection, one session (§5.3). */
export interface JcodeTransport {
  connect(socketPath: string): Promise<JcodeSdkClient>
}
