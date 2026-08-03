# SPEC — `@astrale-os/swarm` (LOCKED)

> **Status: LOCKED.** This is the implementation contract. Every export, signature, wire tag, state
> transition, default and error path below is normative. Implementers must not make API decisions;
> if something appears underspecified, it is a spec bug — fix the spec, then the code. Product
> contract: [`PRODUCT-swarm.md`](./PRODUCT-swarm.md). Decision log §12, DoD §13. No open questions.
>
> **Inherited locks this spec never renegotiates** (PRODUCT-swarm §3–§11): the package identity and
> its **four** entries (H1, amended by Q15); DOM-free *and* Node-free client core (H2);
> `ReadableStore` re-declared, never imported (H3); the intent names (H4) and view models (H5);
> injected `SwarmPresentation` (H6) and `SwarmTransport` (H7); server-as-scheduler (H8, Q7); the ten
> `DelegationState`, nine `ChannelState` and seven `DeliveryState` values; the law of done; the
> closed effort ladder excluding `swarm`/`swarm-deep`; non-sticky turn overrides (Q4); `unknown`
> never auto-resends by default (Q5); worktree-write default authority (Q6); hard cap pauses
> dispatch (Q11); local-only `127.0.0.1` (Q13); jcode floor `>= 0.66.0`; swarm owns the bridge
> spawn (Q14); the kill switch never terminalizes (Q16); parallel attempts are structural (Q9).
>
> **Ground truth.** Every jcode claim is **source-read** against `@1jehuang/jcode-sdk@1.0.1`
> (`dist/*.d.ts`, `dist/*.js`) and jcode source at branch `master`. It is **not
> runtime-observed**: the installed `jcode v0.64.2` predates `api-bridge`, so no harness call below
> has been executed — release gate 1a closes that gap by updating to **≥ 0.66.0** (latest at time of
> writing **0.67.1**, tagged `88a19f38e` the day after 0.67.0) and re-tagging every §5.1 row
> *observed* or *source-read*. Two claims are already runtime-observed and marked **[obs]**:
> `api-bridge` and `upgrade` are absent from 0.64.2's subcommand list; `update` is present.
> **The version floor is entirely swarm's**: `@1jehuang/jcode-sdk@1.0.1` declares and checks no jcode
> version anywhere — no `engines`-style floor, no `--version` parse, no runtime gate in `dist/*` — so
> nothing but §5.3's preflight stands between a 0.64.2 binary and a `startup_failed` with no
> explanation. Quoted SDK signatures are quoted, not paraphrased. Where the
> input briefing disagreed with reality, reality won; §12 rows tagged **[B*n*]** correct briefing
> limitation *n*. Rows **[R*n*]** record changes forced by the first (2026-08-04) adversarial review;
> rows **[F*n*]** record changes forced by the second (2026-08-04, feasibility), which read the
> bridge, daemon and SDK sources the first review had only inferred from.
>
> **One deliberate deviation from the briefing's bones, called out rather than hidden:** its
> `DelegationState` (`queued/provisioning/active/verifying/waiting/reconciling/succeeded/failed/
> cancelling/cancelled`) is replaced by the product's ten. `reconciling` and `cancelling` become
> orthogonal flags — a delegation can be reconciling *and* waiting, and a machine that cannot
> express that lies. `needs-you` and `abandoned` are added: the product has an attention plane and
> an unverifiable-work plane.

---

## 1. Package, entry points, boundaries

### 1.1 Entries

One package, `packages/swarm`, **four** exports. H1 originally locked three; PRODUCT Q15 amends it to
four because H6 named an interface no module declared. This spec adds no fifth.

| Subpath | Contents | Runtime | `.d.ts` may name |
|---|---|---|---|
| `@astrale-os/swarm` | protocol types + codec, `createSwarmClient`, stores, intents, view models, errors, `SwarmTransport` | ES2022 only — no DOM, no `node:*`, no `chrome.*` | nothing platform-specific |
| `@astrale-os/swarm/presentation` | `SwarmPresentation`, `SwarmViewModel`, `SwarmIntents`, `SwarmLabels` (§6.8). **This module imports nothing** — not the barrel, not the protocol, not the domain types; every type it needs is declared in it | ES2022; may name `lib.dom` globals, since a DOM renderer is the expected consumer | DOM globals only |
| `@astrale-os/swarm/server` | `createSwarmServer`, executor adapters, store, verifier, workspace, leases, scheduler | Node ≥ 24 (`node:sqlite`) | `node:*` |
| `@astrale-os/swarm/testing` | `MockExecutor`, `createInMemoryTransport`, `executorConformance()`, `storeConformance()`, `protocolConformance()`, `fakeJcodeTransport()` | ES2022; Node only for the jcode tape | both |

`./presentation` duplicates a handful of shapes (`FleetBucket`, the state unions, VM fields) on
purpose: the whole value of the seam is that a presentation can see these types and **nothing else**,
so it cannot reach the client, the wire or the store. A type-level test in `src/__tests__` asserts
structural compatibility between the duplicated shapes and the canonical ones; CI greps
`src/presentation.ts` and its emitted `.d.ts` for `import` and fails on a hit. This is
`comment-ui/presentation`'s contract, verbatim in shape.

The wire protocol lives at `src/protocol/*`, is re-exported **whole** from `.`, and is imported by
`./server` via relative path, never through the client barrel — it is types plus a pure codec with
zero dependencies, so a Node-only consumer pays nothing at runtime. `bin: { "swarm": "./dist/cli.js" }`
— a bin is not an export entry, so H1 holds and the CLI head (H10) costs no surface.

### 1.2 Dependencies and forbidden imports

`.` and `./presentation` have no dependencies. `./server`: `@1jehuang/jcode-sdk >=1.0.1 <2`, `ws ^8`,
`ulid ^3`. No native module, no ORM (#12). **Grep-gated (§13):** `comment-core`, `comment-ui`,
`browser-copilot`, `temporal-memory`, `wxt/*` and `chrome.*` are forbidden anywhere in
`packages/swarm/src`; `node:*` and DOM globals are forbidden outside `src/server/**`, `src/cli/**`,
`src/testing/node/**`, with `src/presentation.ts` additionally allowed to name DOM globals and
allowed **no `import` at all**.
`ReadableStore`, `Unsubscribe` and `ContextProvider` are **re-declared** in `src/types.ts`;
structural compatibility with `comment-core`'s `ReadableStore<T>` is asserted by a type-level test
that imports it *in the test file only*.

### 1.3 The temporal-memory seam

Boundary-only, never imported. One interface, declared here, implemented by the head:

```ts
interface ContextProvider { id: string
  /** Resolve a ref to inline prompt material. MUST be pure w.r.t. swarm state. */
  resolve(ref: ContextRef, budget: { maxChars: number }): Promise<ContextBundle> }
interface ContextBundle { kind: ContextRef['kind']; text: string
  provenance: { sourceId: string; snapshotRevision?: string; generatedAt: number
                digest: string /* sha256 hex of `text` */ }
  citations?: { id: string; label: string }[] }
type ContextRef = { kind: 'file'; path: string } | { kind: 'page'; url: string; title: string }
  | { kind: 'thread'; threadId: string } | { kind: 'screenshot'; digest: string }
  | { kind: 'attempt'; attemptId: AttemptId } | { kind: 'memory'; query: string; sourceId: string }
```

Bundles cross the wire **by value**. The server stores bundle text + digest on the turn record and
never calls a provider during reconciliation, replay or verification.

---

## 2. Wire protocol — `swarm.v1`

### 2.1 Transport and admission

WebSocket over loopback HTTP: `ws://127.0.0.1:<port>/swarm`, default port **7717** (`0` = ephemeral,
written to `runtime.json`). Binding to anything but `127.0.0.1`/`::1` requires `--unsafe-bind` and
prints a persistent warning (S1).

| Check | Rule | Failure |
|---|---|---|
| Protocol | handshake subprotocols MUST include `swarm.v1`; server echoes exactly `swarm.v1` | HTTP 400 |
| Token | subprotocols MUST include `swarm.tok.<token>` (S4 — never a query param) | close **4001** |
| `Origin` | in the allowlist (`chrome-extension://<id>`, dev `http://localhost:*`) or absent (CLI/Node) | close **4003** |
| `Host` | literal `127.0.0.1:<port>` or `localhost:<port>` — defeats DNS rebinding | close **4003** |
| Header | `Sec-WebSocket-Protocol` is itself the non-simple-request proof; HTTP endpoints additionally require `x-swarm-token` + `x-swarm-client`, **except `POST /pair` and `GET /healthz`** | HTTP 403 |

**Pairing.** `swarm serve` prints an 8-char code (Crockford base32, TTL 300 s, single use, 5
attempts). `POST /pair {code, clientName, clientKind}` → `{tokenId, token, issuedAt}`; `token` is 32
random bytes base64url and only `sha256(token)` is stored, in `$SWARM_HOME/tokens.json` (0600).
`DELETE /pair/:tokenId` revokes. Tokens never expire; they are revoked (S5).

`/pair` is **exempt from `x-swarm-token`** — it is the only way to obtain one, and requiring the
output as input makes pairing impossible. It still requires `x-swarm-client` (non-simple request,
defeating form-post CSRF), a permitted `Origin`, a literal-IP `Host`, and the one-time code itself;
it is rate-limited to 5 attempts per code and 20 per minute per connection. `GET /healthz` is exempt
because it returns `{ok, version}` and nothing else (§7.4).

**Local CLI trust (H10).** `swarm serve` writes `$SWARM_HOME/cli-token` (0600, owner-only, rewritten
with a fresh token on every start, deleted on clean shutdown) containing a normal token whose
`tokenId` is fixed at `local-cli` and whose `clientKind` is `cli`. Every CLI verb but `serve` reads
it and connects over WebSocket exactly like any other head. Filesystem ownership *is* the
authentication: a process that can read a 0600 file in the user's home can already run `jcode`
directly. Without it the CLI head cannot authenticate against a real server at all, and H10's proof
collapses to an in-process fake (§13). `--token` overrides the file; a missing file yields
`unauthenticated` with the fix `swarm serve` or `swarm pair`.

### 2.2 Envelope

One JSON object per text message. `p` and `v` are on **every** frame so a mis-wired peer fails on
frame 1.

```ts
export const SWARM_PROTOCOL = 'swarm' as const; export const SWARM_PROTOCOL_VERSION = 1 as const
type E = { p: 'swarm'; v: 1 }                       // envelope, spread into every frame below
export type ClientFrame =
  | E & { k: 'hello'; client: string; head: HeadKind; minV: 1; maxV: 1 }
  | E & { k: 'req'; id: number; intent: IntentName; args: unknown; idempotencyKey: string
          expectedVersion?: number }
  | E & { k: 'sub'; id: number; stream: StreamName; from: 'snapshot' | number }
  | E & { k: 'unsub'; stream: StreamName } | E & { k: 'ack'; stream: StreamName; seq: number }
  | E & { k: 'ping' | 'pong'; t: number }
export type ServerFrame =
  | E & { k: 'hello_ok'; server: string; serverVersion: string; connectionId: string
          capabilities: readonly ServerCapability[]; serverTimeMs: number }
  | E & { k: 'res'; id: number; data: unknown }
  | E & { k: 'err'; id: number | null; code: SwarmErrorCode; message: string; retryable: boolean
          details?: Record<string, unknown> }
  | E & { k: 'snap'; id: number; stream: StreamName; seq: number; state: unknown }
  | E & { k: 'evt'; stream: StreamName; seq: number; ts: number; ev: SwarmEvent }
  | E & { k: 'lagged'; stream: StreamName; fromSeq: number; reason: LagReason }
  | E & { k: 'ping' | 'pong'; t: number } | E & { k: 'bye'; reason: string; retryAfterMs?: number }
export type HeadKind = 'extension' | 'cli' | 'test'
export type LagReason = 'backpressure' | 'retention' | 'server_restart'
export type ServerCapability = 'replay' | 'snapshot' | 'landing' | 'verify' | 'structured'
                             | 'approvals' | 'images' | 'parallel-attempts' | 'confirmations'
export type StreamName = 'server' | 'fleet' | `delegation:${DelegationId}` | `attempt:${AttemptId}`
export type IntentName =
  | 'createDelegation' | 'sendTurn' | 'retract' | 'cancel' | 'retry' | 'branch' | 'verify'
  | 'accept' | 'land' | 'discard' | 'archive' | 'reconcile' | 'pauseDispatch' | 'killSwitch'
  | 'updateDefaults' | 'confirm' | 'deny'
```

`setFilter` and `focus` are **not** `IntentName`s: they are local-only view selections and never
reach the wire (§6.3). `StreamName` is a template-literal union, so `sub{stream}` is validated by
shape on ingest and an unroutable stream yields `err{code:'stream_unknown'}`.

`hello` MUST be the first client frame; anything else closes **4004**. An unknown `k` from a client
→ `err{code:'unknown_frame'}`, connection survives. An unknown `k` from the server is ignored by the
client — forward compatibility is a runtime property, exactly as the jcode SDK argues.

### 2.3 Streams, sequences, snapshot + replay

Four stream families. **Each carries its own gapless monotonic `seq`, assigned by the durable log
writer inside the same transaction that persists the record, before any acknowledgement** (X2).

| Stream | Volume | Contents | Retention |
|---|---|---|---|
| `server` | trivial | health, doctor, pairing, notices | 30 d |
| `fleet` | low | delegation create/state/summary, budgets, caps | forever |
| `delegation:<id>` | low | attempts, turn records, delivery, verification, landing, drift, evidence | delegation lifetime |
| `attempt:<id>` | **high** | text/reasoning deltas, tool timeline, usage, background progress | 7 d or 200 MB, then the floor rises |

`seq` starts at 1 per stream, is never reused and never sparse: a gap observed by a client is a
**bug**, not a lag signal — lag is always explicit (`lagged`). `sub{stream, from:'snapshot'}` →
`snap{seq, state}` (the fully materialized view at `seq`) then `evt` from `seq+1`; snapshot and
cursor are read in one transaction, so no event is both in the snapshot and re-delivered.
`sub{from:<n>}` → `res{{from:n}}` then `evt` from `n+1`; `n < replayFloor` → `lagged` and the client
MUST re-subscribe with `'snapshot'`; `n > head` → `err{code:'bad_cursor'}`.

**The audit trail is not a stream** (S13, Q20). Every intent — actor, timestamp, effective config,
result, causation — is written to its own `audit` table in the same transaction as the log rows, and
is **exempt from every retention rule in the table above**. It is never GC'd by the `server` stream's
30-day floor, never dropped by compaction, and survives `archive` and `purge` of the delegation it
describes (a purge writes an `audit` row recording the purge). It is read through
`GET /debug/audit?from=&limit=` and `swarm logs --audit`, never through `sub`. S13's entire value is
answering "who did this, and with what effective config" about work that landed months ago; riding a
30-day stream made it a log with an expiry date.

**Replay is durable, not connection-scoped.** Connections hold no resumable state; a head offline
for a day resumes with `from:<lastSeq>` and receives everything, in order, exactly once, provided
`lastSeq >= replayFloor` — unconditional for `server`/`fleet`/`delegation:*`, best-effort with
honest lag for `attempt:*`. This is the property jcode's protocol cannot provide at all.

### 2.4 Backpressure and heartbeat

The server consumes every executor event stream at full speed into the durable log **regardless of
head liveness** (X7). Head slowness can never reach jcode.

**What is actually at the other end** (**[F7]**): the SDK's `events()` iterator buffers into an
**unbounded** in-memory array — no cap, no drop, no kill (`dist/client.js:496-544`). The 10 000-event
`event_buffer_overflow` kill belongs to `globalEvents()`, which §12 #11 bans and swarm never calls.
The bridge itself holds no fan-in buffer at all. So a stalled pump does not "kill the stream"; it
grows the adapter's array without bound and, once the socket's write buffer fills, backpressures the
**bridge's select loop** at `write_all` — one blocked session's consumer can therefore stall the
bridge for every session on that instance. That is the failure the full-speed drain prevents, and it
is a different mechanism from the one the previous text named.

| Rule | Value | On breach |
|---|---|---|
| Per-connection outbound queue | 4 MiB or 4 000 frames | drop the highest-volume subscribed `attempt:*`, send `lagged{reason:'backpressure'}` |
| Unacked window per stream | 512 frames | pause `attempt:*` for that connection until an `ack`; `fleet`/`delegation:*`/`server` are never paused |
| `ack` cadence | every 128 frames or 1 s | none — the server simply stops sending `attempt:*` |
| Delta coalescing | `text.delta`/`reasoning.delta` may merge in the outbound queue while paused, order preserved, **last** `seq` kept | the log retains them unmerged; replay is exact |
| Server ping / client ping | 15 s / 20 s idle | no `pong` and no frame within 30 s → close **4008** (server) / reconnect (client) |
| Frame size | 1 MiB | `err{code:'frame_too_large'}`; oversize event payloads truncate with `truncated:true` |
| Image attachments | **700 KB decoded per image, 700 KB decoded per turn** | refused in the client core with `invalid_spec` **before** any frame is built (§4.2) |

The image cap is derived from the frame cap, not chosen: base64 inflates by ~33 %, so 700 KB decoded
is ~933 KB on the wire, which fits one 1 MiB frame with room for the envelope and the prompt. The
former "4 MiB total" would have died at ~750 KB decoded with `frame_too_large` — a transport error
for a product-level refusal, raised after the user had already waited for the upload.

Only `attempt:*` — the transcript, which is evidence and not the product (Q12) — degrades.

### 2.5 Reconnect contract

1. Backoff 250 ms, ×1.8, cap 30 s, ±25 % jitter; reset on `hello_ok`.
2. On `hello_ok`, a changed `serverVersion` or `capabilities` raises `server-changed` and forces
   `from:'snapshot'` on every stream (X14). Re-subscribe in order `server`, `fleet`,
   `delegation:*`, then `attempt:*` — attention before transcripts.
3. Every in-flight `req` without an observed `res` is **re-sent with the same `idempotencyKey`**;
   the durable idempotency cache (keyed `(tokenId, idempotencyKey)`, TTL 24 h) returns the original
   `res`, including the original error. `bye{retryAfterMs}` (close **4013**) suppresses retry.
4. Close codes: `4001` unauthenticated, `4003` forbidden origin/host, `4004` protocol, `4008`
   heartbeat, `4009` unrecoverable backpressure, `4013` shutting down. `4001`/`4003`/`4004` are
   **terminal** — the client stops retrying and surfaces a fix.

---

## 3. Domain model

### 3.1 Records (all versioned)

**Convention, normative for every type block in this document:** each declared field is `readonly`,
each array is `readonly T[]`, and each named type is `export`ed from the entry listed in §1.1. The
modifiers are elided for density and are part of the contract; `DeepReadonly` is not used — they
are written out in the implementation.

```ts
export type DelegationId = string; export type AttemptId = string; export type TurnId = string
export type InstanceKey = string          // `<provider>/<credentialScope>` — two dimensions (#26)

interface DelegationSpec { specVersion: 1; objective: string; constraints?: string
  acceptance: AcceptanceCriterion[]           // [] ⇒ unverifiable (Q1)
  workspace: WorkspaceSpec; model: ModelSpec; budget: BudgetSpec; execution: ExecutionSpec
  context: ContextRef[]; delivery: DeliveryDefaults
  parallelAttempts: 1 | 2 | 3                 // default 1 (Q9); N live attempts, N slots
  autoResendOnStrongEvidence?: boolean        // default false (Q5)
  reviewIsAuthoritative?: boolean }           // default false (§3.2)
interface WorkspaceSpec { workspaceId: string
  baseRevision: string                        // full 40-char sha, RESOLVED by the server at create
  writeMode: 'worktree' | 'in-place'          // default 'worktree'; 'readonly' deleted (Q6, #28)
  subPath?: string
  allowDirty?: { actor: ActorRef; at: number; note: string } }   // the only 'in-place' escape (C6)
interface ModelSpec { provider: string; model: string; reasoningEffort: ReasoningEffort | null }
interface BudgetSpec { maxWallMs: number; maxTurns: number; maxToolCalls: number
  maxInputTokens: number; maxOutputTokens: number; maxSpendUsd?: number
  onBreach: 'pause-dispatch' | 'needs-you' }  // never 'kill' (Q11)
interface ExecutionSpec { nativeSwarm: false; jcodeMemory: false   // literals — not configurable
  autoPoke: boolean                           // no toolProfile in wave 1 (T17, #26)
  skills: SkillRef[]; mcp?: McpServerRef[] }
interface SkillRef { name: string; source: string; digest: string }
interface McpServerRef { name: string; enabled: boolean; config: Record<string, unknown>
  transport: 'stdio' | 'http' | 'sse' | 'streamable-http' }          // all four (#25)
interface DeliveryDefaults { mode: TurnDeliveryMode; notify: 'silent' | 'notify' }

interface DelegationRecord { recordVersion: 1; id: DelegationId; version: number  // +1/mutation
  spec: DelegationSpec; title: string; state: DelegationState   // ROLLUP over liveAttempts (§3.3)
  verdict: 'verified' | 'accepted' | null     // set iff state === 'succeeded'
  unverifiable: boolean                       // frozen at create
  dispatchPaused: boolean; landed: LandingRecord | null
  attempts: AttemptId[]                       // append-only, all attempts ever
  liveAttempts: AttemptId[]                   // non-terminal attempts, length ≤ parallelAttempts
  focusedAttempt: AttemptId | null            // the head's current selection; presentation only
  origin: { delegationId: DelegationId; attemptId: AttemptId } | null   // set by `branch` (A6)
  priority: number
  createdAt: number; updatedAt: number; createdBy: ActorRef; spend: SpendCounters
  lastNeedsYouReason: NeedsYouReason | null }
interface AttemptRecord { recordVersion: 1; id: AttemptId; delegationId: DelegationId
  attemptNo: number                           // 1-based, append-only (A1)
  spec: DelegationSpec                        // frozen copy; a retry may edit it (A2)
  executor: { adapterId: string; instanceKey: InstanceKey; sessionId: string | null
              versions: Record<string, string> }
  workspace: { root: string; worktree: string | null; baseRevision: string; staleBase: boolean }
  channel: ChannelState; turns: TurnId[]; verifications: VerificationRun[]
  evidence: string | null; startedAt: number; endedAt: number | null
  outcome: 'open'|'interrupted'|'exhausted'|'verified'|'accepted'|'failed'|'cancelled'|'abandoned' }
interface TurnRecord { recordVersion: 1; id: TurnId; attemptId: AttemptId; ordinal: number
  directive: TurnDirective                    // as requested
  effective: EffectiveTurnConfig              // as declared (§4.3)
  promptDigest: string; attachmentDigests: string[]
  contextBundles: ContextBundle['provenance'][]
  delivery: DeliveryState; deliveryDetail: DeliveryDetail
  usage: { input: number; output: number; cacheReadInput?: number } | null
  toolCallCount: number; startedAt: number; endedAt: number | null; actor: ActorRef }
interface EffectiveTurnConfig { provider: string
  model: string | 'inherited'                 // 'inherited' iff deliveryMode !== 'after-turn' (#30)
  reasoningEffort: ReasoningEffort | null | 'inherited'
  effortConfirmed: false            // literal — never observable through protocol v1 (#7)
  modelConfirmed: boolean           // true once `model_info` echoes it; false when 'inherited'
  deliveryMode: TurnDeliveryMode
  structured: { schemaDigest: string; maxRetries: number } | null
  budget: TurnBudget | null; executorVersions: Record<string, string> }
interface DeliveryDetail { ackAtMs: number | null; correlated: false; reason?: string
  landing: 'confirmed' | 'unconfirmed' | 'n/a' }   // 'unconfirmed' for every soft interrupt
type NeedsYouReason = 'question' | 'manual-criterion' | 'verification-failed' | 'budget'
  | 'delivery-unknown' | 'landing-conflict' | 'drift' | 'unverifiable-turn-end'
type ActorRef = { kind: 'user'; head: HeadKind; tokenId: string }
  | { kind: 'copilot'; confirmedBy: string | null } | { kind: 'server'; reason: string }
interface LandingRecord { mode: 'commit' | 'patch'; attemptId: AttemptId; ref: string
  sha?: string; patchPath?: string; at: number }

/** What a head submits. `spec` differs from `DelegationSpec` in exactly one field. */
interface CreateDelegationInput { delegationId?: DelegationId    // client-generated (C11)
  title?: string                              // omitted ⇒ auto-generated from the objective (C15)
  idempotencyKey: string; priority?: number
  spec: Omit<DelegationSpec, 'workspace'> & { workspace: WorkspaceInput } }
interface WorkspaceInput { workspaceId: string
  baseRef?: string                            // revision EXPRESSION; default 'HEAD' (C4b, #29)
  writeMode?: 'worktree' | 'in-place'; subPath?: string
  allowDirty?: { note: string } }             // actor + timestamp are stamped by the server
```

**Base revision resolution, normative (C4b).** The head submits `baseRef`, a revision *expression*
(`'HEAD'`, a branch, a tag, a short sha). Inside the create transaction the server runs
`git rev-parse --verify <baseRef>^{commit}` in the registered root and stores the resulting **full
40-char sha** as `WorkspaceSpec.baseRevision`. An unresolvable ref refuses with `invalid_spec`. No
record ever holds a symbolic ref: drift detection (X13), verification locking (§8.6) and landing
(§8) all key off a fixed sha, so storing `'HEAD'` would silently disable all three while every
surface still claimed they worked. `DelegationVM.baseRef` reports the expression the user typed
alongside the sha it resolved to, so "which base?" has a human answer as well as a correct one.

### 3.2 `AcceptanceCriterion`

```ts
type AcceptanceCriterion =                     // every member also carries `id` and `label`
  | { kind: 'command'; command: string; cwd?: string; timeoutMs: number
      expectExit?: number; env?: Record<string, string> }
  | { kind: 'file'; path: string; must: 'exist'|'absent'|'match'|'changed'; pattern?: string }
  | { kind: 'artifact'; path: string; sha256?: string; minBytes?: number
      producedDuringAttempt: boolean }
  | { kind: 'review'; rubric: string; model?: string; effort?: ReasoningEffort
      threshold: number }                      // 0..1, default 0.7
  | { kind: 'manual'; instructions: string }
```

`command`/`file`/`artifact` are **machine-checkable**; ≥1 of them makes `verified` reachable.
`review` is machine-run but advisory: it contributes a score and evidence and cannot alone produce
`verified` unless it is the only non-`manual` kind present **and** `reviewIsAuthoritative` is set.
`manual` never satisfies anything automatically; it routes to `needs-you`.

### 3.3 State machines — every transition and who fires it

**DelegationState** (10; terminal: `succeeded`, `failed`, `cancelled`, `abandoned`).

**Rollup rule, normative (Q9).** Execution belongs to the attempt. With `parallelAttempts > 1` the
delegation state is derived from `liveAttempts` on every attempt-state change, by taking the
highest-attention member of

`needs-you > verifying > running > waiting > provisioning > queued`

and reaching a terminal state only when `liveAttempts` is empty. The transition table below is
therefore read as *attempt* transitions that the delegation projects; the trigger column names who
fires the underlying attempt event. Two consequences that would otherwise be discovered in
production: (a) one attempt reaching `needs-you` shows the delegation as `needs-you` while its
siblings keep running, which is correct — the user *is* needed; (b) the first attempt to reach
`verified` does **not** terminate its siblings. They run to their own end unless the user cancels
them, because A5's comparison needs their evidence and killing them mid-turn wastes tokens already
spent (the same reasoning as Q11).

| # | From → To | Trigger (fired by) |
|---|---|---|
| D1 | — → `queued` | `createDelegation` persisted (server) |
| D2 | `queued` → `provisioning` | concurrency slot + instance lease + worktree lease all available **for one attempt**; with `parallelAttempts: n` the scheduler admits up to *n* attempts independently and the delegation leaves `queued` on the first (scheduler) |
| D3 | `queued` → `cancelled` | `cancel{scope:'delegation'}` (user) |
| D4 | `provisioning` → `running` | attempt created, session created + attached, first turn submitted (executor) |
| D5 | `provisioning` → `failed` | preflight/worktree/instance error after 3 bounded retries (server) |
| D6 | `running` → `waiting` | `turn_done`, no queued follow-up, criteria present (executor) |
| D7 | `running` → `needs-you` | turn ended with a question, a `manual` criterion, or a breach with `onBreach:'needs-you'` (server) |
| D8 | `waiting` → `verifying` | auto-verify at `turn_done` (VE5) or `verify` intent (server/user) |
| D9 | `running` → `verifying` | `verify` intent while streaming → queued, applied at turn end (user) |
| D10 | `verifying` → `succeeded` | every machine-checkable criterion passed ⇒ `verdict='verified'` (verifier) |
| D11 | `verifying` → `needs-you` | a criterion failed with budget remaining, or the result is indeterminate (verifier) |
| D12 | `verifying` → `failed` | criteria failed, budget exhausted, `autoRetry` off (verifier) |
| D13 | `needs-you` → `running` | `sendTurn` (user, or copilot with per-call confirmation) |
| D14 | `needs-you` → `succeeded` | `accept{note}` ⇒ `verdict='accepted'` — the **only** path for `unverifiable` (user, Q1) |
| D15 | `needs-you` → `abandoned` | `archive{abandon:true}` (user) |
| D16 | `waiting` → `running` | `sendTurn` (user/copilot-confirmed) |
| D17 | any non-terminal → `cancelled` | `cancel{scope:'delegation'}` **only** (user). The kill switch is *not* a trigger here (#31): it cancels in-flight turns and sets `dispatchPaused`, and every delegation keeps its state and its worktree |
| D18 | `running`/`verifying` → `waiting` | executor disconnect; attempt annotated `interrupted`; reconciliation lease taken (server) |
| D19 | any terminal → `queued` | `retry`, or a late follow-up `sendTurn` — **reopens** as attempt *N+1* (Q2); `verdict` cleared, `landed` retained (user) |
| D20 | `succeeded` → `succeeded` | `land` sets `landed`; landing is a facet, not a state (user) |
| D21 | `failed` → `failed` | re-verification appends a run; a pass reaches `succeeded` only via D19 then D10 (verifier) |
| D22 | `provisioning`/`running` → `queued` | hard spend cap ⇒ `dispatchPaused=true`; the in-flight turn is **not** killed and the state moves at turn end (budget monitor, Q11) |
| D23 | *(no transition)* | `killSwitch` — every live attempt's turn is cancelled (`cancel(sessionId)`), `dispatchPaused` is set at fleet scope, instances are optionally killed via swarm's own pgid (R13), and **no delegation changes state and no worktree is touched** (server, Q16). Attempts whose channel dies land in `waiting` via D18, which is the honest description of what happened |

`dispatchPaused` and `landed` are orthogonal flags settable in any non-terminal state (`landed` also
in `succeeded`). The fleet renders `succeeded && !landed` as **done-unlanded** (F1).

**ChannelState** (9) — per attempt, per executor session.

| # | From → To | Trigger (fired by) |
|---|---|---|
| C1 | `detached` → `attaching` | connection opened, `attach_session` written (adapter) |
| C2 | `attaching` → `idle` | `attached` received; writer lease held with fence *f* (adapter) |
| C3 | `attaching` → `disconnected` | socket error or 10 s timeout (adapter) |
| C4 | `idle` → `submitting` | `submit()` under fence *f* (server) |
| C5 | `submitting` → `accepted` | `message_accepted` for this session (jcode) |
| C6 | `submitting` → `disconnected` | write error or `acceptTimeoutMs` elapsed ⇒ delivery `unknown` (adapter) |
| C7 | `accepted` → `streaming` | first `text_delta`/`reasoning_delta`/`tool_start` (jcode) |
| C8 | `streaming` → `idle` | `turn_done` (jcode) |
| C9 | `streaming` → `interrupting` | `cancel` or `softInterrupt` issued (server) |
| C10 | `interrupting` → `idle` | `turn_done` after the interrupt (jcode) |
| C11 | `interrupting` → `streaming` | 3 s of continued deltas with no `turn_done` — the interrupt merged into the turn (server timer) |
| C12 | any → `disconnected` | socket close, instance death, heartbeat loss (adapter) |
| C13 | `disconnected` → `attaching` | supervised reconnect, 500 ms ×2 cap 30 s, 8 tries (supervisor) |
| C14 | `disconnected` → `closed` | attempt terminal or reconnect budget exhausted (server) |
| C15 | `idle` → `closed` | `close()` — **the only lease release**; `detachSession` is never called (server, #10) |

**DeliveryState** (7) — per turn; `unknown` is first-class and user-visible (X4).

| # | From → To | Trigger (fired by) |
|---|---|---|
| V1 | — → `prepared` | turn record persisted with prompt digest, **before** any wire write (server) |
| V2 | `prepared` → `sent` | frame written to the executor (adapter) |
| V3 | `prepared` → `failed` | refused pre-flight: lease lost, banned effort, live-turn config change, budget (server) |
| V4 | `sent` → `accepted` | `message_accepted` observed (jcode) |
| V5 | `sent` → `unknown` | **swarm's own** `acceptTimeoutMs` (default 10 000) elapsed with no `message_accepted` observed on the session's `events()` stream, or disconnect before ack (adapter). **[F2]** The SDK's `waitForAccept` cannot produce this edge: `waitForEvent` *resolves* on timeout rather than rejecting (`dist/client.js:342`, "Resolving on timeout rather than rejecting keeps a missing ack from failing an otherwise healthy turn"), so `sendMessage` returns `undefined` identically whether the ack arrived or not. The adapter therefore sends with `waitForAccept:false` and observes the ack itself (§4.2) |
| V6 | `accepted` → `running` | first stream event of this turn (jcode) |
| V7 | `running` → `ended` | `turn_done` (jcode) |
| V8 | `running` → `unknown` | disconnect before `turn_done` (adapter) |
| V9 | `unknown` → `accepted`/`running`/`ended` | reconciliation found positive evidence (reconciler, §5.5) |
| V10 | `unknown` → `failed` | strong evidence it never landed **and** the user confirmed a resend or discarded it (user) |
| V11 | `sent`/`accepted` → `failed` | an `error` frame **on this session's dedicated connection** (jcode). **[F6]** `ApiEvent::Error` is `{ev:'error', code, message}` and carries **no `session_id`** (`protocol.d.ts:167-170`); it is attributable only because §5.3 binds one connection to one session, so a topology change that multiplexes sessions onto a connection silently breaks this edge. A daemon-originated failure arrives as `code:'internal'`, not `invalid_request` |
| V12 | `prepared` → *(deleted)* | `retract` before the write — queue row removed, audit row kept (user) |
| V13 | `accepted` → `ended` | the turn is `contextOnly` and its ack was observed. **No `turn_done` exists for a `noReply` message**, so this is the only path to `ended` for the fourth delivery mode (server, #32) |
| V14 | `sent`/`accepted` → `prepared` | `retract` on an interrupt-mode turn: `cancelSoftInterrupts(sessionId)` returned, so **every** pending interrupt on that session goes back to `prepared` (user, §6.3) |

`context-only` turns (`noReply`) go `prepared → sent → accepted → ended` via **V13** and never enter
`running`. Without V13 the only route to `ended` was V7 (`running → ended` on `turn_done`) and the
only route to `running` was V6 (a stream event); a `noReply` message produces neither, so the turn
sat in `accepted` forever and T8 was unusable in practice.

### 3.4 Budgets, leases, fencing

```ts
interface TurnBudget { maxWallMs?: number; maxToolCalls?: number }
interface SpendCounters { wallMs: number; monotonicMs: number   // tracked separately (X10)
  sleptMs: number                 // Σ(Δwall − Δmono) over detected gaps — excluded from maxWallMs
  turns: number; toolCalls: number; inputTokens: number; outputTokens: number; estUsd: number }
type LeaseKey = `session:${string}` | `home:${string}` | `worktree:${string}`
              | `delegation:${DelegationId}` | `repo:${string}`
interface Lease { key: LeaseKey; holder: string; token: number   // fencing token
                  acquiredAt: number; expiresAt: number }
interface Fence { key: LeaseKey; token: number }
```

(1) Every mutating executor call carries a `Fence`; the adapter refuses a call whose token is below
the highest observed for that key (`stale_fence`). (2) `session:*` is the writer lease — one holder,
TTL 60 s, renewed at 20 s; expiry never releases while a turn streams, it marks the holder `suspect`
and blocks new submissions. (3) `home:*` is the singleton per `jcodeHome`: an `O_EXCL` lock file
holding pid + boot id, reclaimed only after a liveness probe fails (R9). (4) `worktree:*`/`repo:*`
implement F4 — one writing attempt per working tree, 8 worktrees per repo. (5) `delegation:*` is the
reconciliation lease. (6) Tokens come from one monotonic counter in the durable store, so they are
globally comparable and survive restart. **Breach ladder:** soft (80 %) → `fleet.budget` warning;
hard → `dispatchPaused=true`, no new turns in scope, **the in-flight turn is never cancelled**
(Q11); a `TurnBudget` breach `cancel`s that turn only and records `budget-breach` on it.

### 3.5 Event log schema

One append-only table, one writer.

```ts
interface LogRecord { seq: number        // per-stream, gapless, assigned in-transaction
  stream: StreamName; ts: number; mono: number     // monotonic ms since boot (X10)
  ev: SwarmEvent; actor: ActorRef
  delegationId?: DelegationId; attemptId?: AttemptId; turnId?: TurnId
  causationId?: string                   // originating intent / executor event id
  correlationId?: string }               // idempotency key of the originating intent
```

DDL (`node:sqlite`, WAL, `synchronous=FULL` on the log): `log(stream, seq, ts, mono, kind,
delegation_id, attempt_id, turn_id, actor JSON, causation, correlation, payload JSON, PRIMARY
KEY(stream, seq))`; `stream_head(stream PK, head, floor)`; `records(kind, id, version, json)`;
`idem(token_id, key, response JSON, created_at)`; `leases(key, holder, token, expires_at)`;
`counters(name, value)`; `schema_version(v)`; and — outside every retention rule —
`audit(id INTEGER PK AUTOINCREMENT, ts, mono, intent, actor JSON, delegation_id, attempt_id,
turn_id, effective JSON, result JSON, correlation)`.

**Audit rows are never deleted** by retention, compaction, archive, discard or purge (S13, Q20). GC
(A12) may delete worktrees, transcripts, artifacts and `attempt:*` log rows; it MUST NOT touch
`audit`. A purge appends an audit row describing the purge, so the record of what was removed
outlives what was removed.

**Write ordering, normative:** persist (record mutation + log rows + audit row + head bump) in one
`BEGIN IMMEDIATE` → emit to subscribers → reply `res`. An intent that returns `ok` is durable; an
executor event that is fanned out is durable; no head ever sees what the disk does not have.
`SwarmEvent` is a closed union of **34** kinds, enumerated in §6.4 — unknown kinds are rejected on
ingest and tolerated on egress.

---

## 4. `TurnDirective` — the per-message control block

### 4.1 Type

```ts
export type TurnDeliveryMode = 'after-turn' | 'next-safe-point' | 'interrupt' | 'context-only'
export type ReasoningEffort = 'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'
export const BANNED_EFFORTS = ['swarm', 'swarm-deep'] as const
export function effortLadder(provider: string, model: string): readonly ReasoningEffort[]
export function normalizeEffort(raw: string): ReasoningEffort | null   // throws on banned/unknown

interface TurnDirective { text: string
  attemptId?: AttemptId                           // required when liveAttempts.length > 1 (Q9)
  delivery?: TurnDeliveryMode                     // default spec.delivery.mode
  model?: string                                  // 'after-turn' ONLY (#30); omission ⇒ deleg. default
  reasoningEffort?: ReasoningEffort | null        // 'after-turn' ONLY (#30); omission ⇒ deleg. default
  structured?: { schema: unknown; maxRetries?: number }        // maxRetries default 2
  images?: { mediaType: string; base64: string }[]             // ≤ 700 KB decoded total (§2.4)
  context?: ContextRef[]; budget?: TurnBudget
  notify?: 'silent' | 'notify' | { thread: string }
  idempotencyKey: string; expectedVersion?: number }
```

**`model`/`reasoningEffort` are legal only with `delivery: 'after-turn'`** (§4.3.8, PRODUCT Q17). A
directive carrying either field with `next-safe-point`, `interrupt` or `context-only` is refused in
the **client core** with `err{code:'config_not_available_in_mode', retryable:false}` — before any
frame is built, and again at the server intent boundary. `attemptId` is optional while a delegation
has one live attempt and **required** when it has more; omitting it with two live attempts refuses
with `invalid_spec` naming both, because "send this to the delegation" has no meaning once the
delegation is three concurrent sessions.

Ladders (static table, verified from `jcode-provider-core/src/reasoning.rs`): OpenAI/Codex
`none…max`; OpenRouter `none…xhigh` (no `max` — it is an alias of `xhigh`); DeepSeek
`none,low,medium,high,max`; Anthropic model-derived `none,low,medium,high` plus `xhigh`/`max` only
for model ids in the capability table, and **no `minimal`**. Aliases normalized before validation:
`off|disabled → none`, `default|auto → null`. `swarm`/`swarm-deep` are refused in the **client
core**, again at the **server intent boundary**, and again in the **jcode adapter** (#9).

### 4.2 Exact mapping to verified jcode calls

| Field | jcode call, in order | Native / emulated | Failure modes and normative handling |
|---|---|---|---|
| `model` | `setModel(sessionId, model)` **before** `sendMessage`, session idle, under fence | emulated (session-sticky) | rejects `invalid_request` on unknown/refused model ⇒ turn `failed` before any send; confirmed asynchronously by `model_info`, which is broadcast to every attached client ⇒ `modelConfirmed = true` |
| `reasoningEffort` | `setReasoningEffort(sessionId, effort)` **before** `sendMessage`, session idle, under fence | emulated, **unverifiable** | returns `Promise<void>`; the bridge discards the daemon's applied value (`translate.rs:936`) and there is no getter, so clamping (`max`→`xhigh`) is undetectable. **[F3]** Unknown values are **rejected**, not logged-and-ignored: both provider runtimes `bail!` before normalization (`jcode-provider-anthropic-runtime/src/lib.rs:1181-1204`, `jcode-provider-openai-runtime/src/openai_provider_impl.rs:883-911`) and the failure surfaces as `ReasoningEffortChanged{error}` → `invalid_request`. That does **not** make `ok` a validation signal: `swarm`/`swarm-deep` are inside the accepted set and return `ok`, which is exactly why the ladder is validated three times client-side (§4.1). **[F10]** A mid-turn call does not merely defer: the daemon parks on `agent.try_lock()` failure and **sends no reply until the turn ends** (`provider_control.rs:773-836`), so the SDK's `requestTimeoutMs` (default **30 000**) rejects with `HarnessError('timeout')` while the setting still lands at turn end — an error whose side effect succeeds. Hence the client-side refusal of §4.3.3. Always recorded with `effortConfirmed:false` |
| `delivery:'after-turn'` | swarm queue → `sendMessage(id, text, {images, waitForAccept:false})` when `ChannelState==='idle'`; the adapter observes `message_accepted{session_id}` on its own `events()` stream under **swarm's** `acceptTimeoutMs` | **native** | the ack `message_accepted{session_id}` carries no content and no index. **[F2]** `waitForAccept:true` is **forbidden**: the SDK resolves rather than rejects on ack timeout (`client.js:342`), so `accepted` and `unknown` are indistinguishable through the call, and its timer is `.unref()`'d, so in an otherwise-idle process the await may never settle at all. `SubmitReceipt.ack` and V5 are derived from the observed event, never from the call returning |
| `delivery:'next-safe-point'` | `softInterrupt(sessionId, text)` | **native**, landing unobservable | the daemon's `soft_interrupt_injected{point:'A'\|'B'\|'C'\|'D', tools_skipped}` is **not translated by the bridge** ⇒ `deliveryDetail.landing='unconfirmed'` permanently |
| `delivery:'interrupt'` | `softInterrupt(sessionId, text, true)` | **native**, landing unobservable | same; `urgent` may skip remaining tool calls and swarm cannot learn how many |
| `delivery:'context-only'` | `sendMessage(id, text, {noReply:true})` | **native** | persists context without starting a turn; no `turn_done` ever arrives (§3.3 note) |
| `structured` | `runStructured(sessionId, text, {schema, maxRetries, onEvent})` | **native, true per-turn** (SDK-level Ajv + corrective prompts) | costs up to `maxRetries+1` turns against the budget and the cost MUST be shown before send; `StructuredOutputError` ⇒ turn `ended` with `structuredFailed` and the attempts stored as evidence; wrapped in a swarm deadline + `cancel` because it has no timeout of its own |
| `images` | `images: [[mediaType, base64], …]` (`ImageAttachment = [string, string]`) | **native, true per-turn** | **> 700 KB decoded total refused client-side** with `invalid_spec`, derived from the 1 MiB frame cap plus base64's ~33 % inflation (§2.4). The previous 4 MiB allowance died at ~750 KB with `frame_too_large` |
| `budget` | none — swarm timer + `cancel(sessionId)` | swarm-owned | `cancel` ends the turn; the session survives |
| retract | queue removal for `after-turn`/`context-only`; `cancelSoftInterrupts(sessionId)` for interrupts | **native, session-wide** | the primitive takes only a `sessionId`: there is no per-message retract. Retracting one interrupt drops **every** pending interrupt on that session, so swarm returns `RetractReport` naming all affected turns and resets each to `prepared` (V14). Leaving their records at `sent` would assert a delivery that swarm itself cancelled |
| tool restriction | **impossible per turn, and impossible on the `api-bridge` path at all** | none | **[F4]** `--tools`/`--tool-profile`/`--disable-base-tools`/`--disabled-tools` are `global = true` clap args (`src/cli/args.rs:92-116`), so `jcode api-bridge --tool-profile minimal` *parses* — and is **inert**. The agent runs in the daemon, and `api-bridge` reaches it through `spawn_server`, which forwards **only** `--provider`, `--provider-profile` and `--model` to `jcode serve` (`src/cli/dispatch.rs:157-175, 1263-1320`). The flags never leave the bridge process, which hosts no agent. Delivering them requires pre-starting `jcode serve` with them and having the bridge attach to that daemon — a topology wave 1 does not adopt. Swarm therefore claims **no** tool authority, and `bridgeArgv` is documented as bridge-process-only (§7.3). `InstanceKey` drops its third dimension |
| approvals | `respondToPermission` always replies `invalid_request`; `permission_request` is never emitted; `autoApprove` is a dead branch | dark | gated on `supports('permissions')`, probed every connect (R6) |

**Submission sequence, normative** (`applyAndSubmit`): assert lease held with fence *f* → assert
`ChannelState === 'idle'` → if `directive.model ≠ shadow.model` `setModel` (await) → if
`directive.effort ≠ shadow.effort` `setReasoningEffort` (await) → **persist `TurnRecord` with
`delivery:'prepared'` and `effective`** → `sendMessage`/`softInterrupt`/`runStructured` → `sent`.
The persist sits between config and send deliberately: a crash after `setModel` and before
`sendMessage` leaves a session whose state matches no turn, and the reconciler must see that. The
shadow copies of model/effort are **declared** and are invalidated — forcing a re-assert — on
reconnect, on any unsolicited `model_info`, and on instance restart.

### 4.3 Normative turn semantics

1. **Cascade** fleet default → delegation default → turn override; the effective value appears on
   `TurnVM` before send and is stored on the turn record.
2. **Non-sticky**: an omitted field reconciles the session back to the *delegation* default, not to
   the previous override — a turn with `effort:'max'` followed by a turn without `effort` issues
   `setReasoningEffort(delegationDefault)` before its send.
3. A directive changing `model` or `reasoningEffort` while `ChannelState ∈ {submitting, accepted,
   streaming, interrupting}` is **refused** with `err{code:'turn_in_flight', retryable:true}` and
   delivery `failed` (V3). Never queued, never deferred, and **never issued optimistically**: the
   daemon takes the agent mutex before replying, so a mid-turn `setReasoningEffort` (or `compact`,
   which does `agent.lock().await` at `client_actions.rs:1036`) blocks for the **whole remaining
   turn**, the SDK rejects it at `requestTimeoutMs` (30 s) with `HarnessError('timeout')`, and the
   setting **still applies at turn end** (**[F10]**). The observable is therefore not "resolves and
   does nothing" but "fails, then silently takes effect on a turn the user never targeted" — a worse
   failure than the one this rule was written for, and one that would also burn a 30 s request slot
   on the session's only connection.
4. Effort is presented as **declared**; any UI rendering it must render `effortConfirmed:false`,
   which `SwarmPresentation` receives as a boolean it cannot omit.
5. An unsolicited `model_info` differing from the shadow raises `drift` on the delegation stream and
   sets `modelConfirmed:false` until re-asserted.
6. Answering a question and sending a follow-up are the same intent (`sendTurn`); there is no
   separate `answer`.
7. Three distinctly-named interrupts: `cancel{scope:'turn'}` → `cancel()`;
   `{scope:'delegation'}` → stop dispatch, session survives; `{scope:'hard'}` → `dispose()` +
   **`kill(-pgid)` on the process group swarm created for that instance AND `kill(-daemonPid)` on
   the daemon's own group** (§5.3) — the only true stop, since jcode exposes no background-task
   control. **[F1] Killing the bridge alone stops nothing.** `jcode api-bridge` spawns the daemon
   (`src/cli/dispatch.rs:157-175` → `spawn_server`), and the daemon is spawned through a `pre_exec`
   that calls `libc::setsid()` (`crates/jcode-app-core/src/server/socket.rs:267`): it leads its own
   session and process group by design, and the agent, its tools and every bash child live **there**,
   not in the bridge's group. The SDK says so in as many words (`dist/launch.js:536`): *"The daemon
   calls setsid(), so it leads its own session and no signal aimed at the bridge can reach it.
   Killing the bridge alone is exactly the leak this handler exists to prevent."* A hard kill that
   signals only `-pgid` returns `KillOutcome.survivors: []` while the agent keeps writing to the
   worktree — the failure mode looks like success. Signalling a group swarm did not create is still
   forbidden: `launchInstance()` spawns with `detached: false`, so its bridge sits in the swarm
   server's own group and `kill(-pgid)` there kills the server. An adapter that cannot name a pgid
   it created MUST fail the hard kill with `capability_absent` rather than guess; an adapter that
   cannot resolve a `daemonPid` MUST report it in `KillOutcome.daemonPid: null` and raise
   `notice{kind:'capability-absent'}`, because a kill that left the daemon alive must never be
   reported as a completed stop.
8. **Mode gate.** `model` and `reasoningEffort` are accepted only with `delivery:'after-turn'`.
   `next-safe-point` and `interrupt` exist only while a turn is in flight — exactly the states rule 3
   refuses — so the combination is not unlucky, it is unsatisfiable; `context-only` starts no turn,
   so a recorded effort would describe nothing. All three record
   `EffectiveTurnConfig.reasoningEffort = 'inherited'` and `model = 'inherited'`, which reads as
   "this turn ran under whatever the previous turn set" and is the only honest value available.
   Refusal is `config_not_available_in_mode`, raised in the client core (no wire traffic) and again
   at the server boundary.
9. **Retract is session-scoped for interrupts.** `retract(turnId)` on a turn whose delivery mode is
   `next-safe-point` or `interrupt` calls `cancelSoftInterrupts(sessionId)` and therefore un-delivers
   every pending interrupt on that session. Swarm resets each affected turn to `prepared` (V14),
   writes one audit row per affected turn, and returns `RetractReport{ requested, alsoRetracted }`.
   The head MUST render `alsoRetracted`; a silent un-delivery whose records still read `sent` is the
   failure X4 exists to prevent, arriving through the front door.
10. **Attempt targeting.** Every turn belongs to an attempt, never to a delegation. With one live
    attempt `attemptId` may be omitted and is filled in; with more it is required. `TurnRecord`
    already keys on `attemptId`, so nothing else changes — but a head that assumes "one delegation,
    one channel" will send the right words to the wrong agent.

---

## 5. `ExecutorAdapter` — the backend-neutral seam

### 5.1 Interface

```ts
interface ExecutorAdapter { id: AdapterId
  capabilities: ExecutorCapabilities
  preflight(): Promise<PreflightReport>
  acquireInstance(key: InstanceKey, opts: InstanceOptions): Promise<ExecutorInstance> }
type AdapterId = 'jcode' | 'mock'             // no third backend (#27; §10 non-goal)
interface InstanceOptions { jcodeHome: string; workingDir: string
  inheritLogins: boolean                      // explicit, never defaulted (S10)
  binary?: string; env: Record<string, string>          // the WHOLE env — not a patch (§5.3)
  argv?: readonly string[]   // extra args to the BRIDGE PROCESS ONLY. Tool flags are inert here:
                             // the agent lives in the daemon and `spawn_server` forwards only
                             // --provider/--provider-profile/--model to `jcode serve` ([F4], §7.3)
  startupTimeoutMs: number; cleanupTimeoutMs: number; inheritStderr: boolean }
interface ExecutorCapabilities { nativeReplay: boolean; idempotentSubmit: boolean
  submitAckCorrelates: boolean          // does the ack identify *which* message?
  observableEffort: boolean; observableModel: boolean
  perTurnConfig: boolean                // config attached to the message itself
  programmaticApprovals: boolean; perTurnToolRestriction: boolean
  structuredOutput: boolean; contextOnlyMessage: boolean
  softInterrupt: boolean; interruptLandingObservable: boolean
  history: 'lossless' | 'text-only' | 'none'
  sessionsPerConnection: number | 'many'; usageEvents: boolean }
interface PreflightReport { ok: boolean; detail: string; versions: Record<string, string>
  blocked: 'version_floor'|'binary_missing'|'socket_dir'|'credentials'|'no_route'|null
  fix: string | null }                  // copy-pasteable (R2, R3)
interface ExecutorInstance { key: InstanceKey; adapterId: AdapterId
  pgid: number | null                         // swarm-created BRIDGE group; null ⇒ no hard kill
  daemonPid: number | null                    // the setsid() daemon, from servers.json ([F1])
  runtimeInfo(): Promise<ExecutorRuntimeInfo>            // protocolVersion, caps, routes
  createSession(req: { workingDir: string; title?: string }): Promise<ExecutorSessionHandle>
  openSession(sessionId: string): Promise<ExecutorSessionHandle>
  /** DISK INVENTORY, not a live-session list ([F16]): the bridge merges every persisted record
   *  under JCODE_HOME with its own snapshot, so short-lived and stray sessions appear here.
   *  Swarm's own attempt records are authoritative for the fleet; this is used for GC only. */
  listSessions(): Promise<ExecutorSessionInfo[]>
  /** instance-global (R10). `provider` MUST be one of the six ids the bridge accepts ([F17]):
   *  claude-api | openai-api | openrouter | cursor | gemini | jcode. Anything else, or a key with
   *  surrounding whitespace, a newline or a NUL, is refused `invalid_request`. */
  setCredential(provider: InstanceCredentialProvider, apiKey: string): Promise<void>
  dispose(reason: string): Promise<void>
  /** dispose(), then kill(-pgid) on the bridge group, then kill(-daemonPid) on the daemon group.
   *  Rejects `capability_absent` when `pgid === null` (§4.3.7). */
  hardKill(reason: string): Promise<KillOutcome> }
type InstanceCredentialProvider = 'claude-api' | 'openai-api' | 'openrouter' | 'cursor'
                                | 'gemini' | 'jcode'          // the bridge's closed set ([F17])
interface KillOutcome { pgid: number; daemonPid: number | null
  signalled: readonly NodeJS.Signals[]
  survivors: readonly number[]          // scanned in BOTH groups; a live daemon lands here
  daemonStopped: boolean                // false ⇒ the agent may still be running ([F1])
  durationMs: number }
interface ExecutorRuntimeInfo { server: string; protocolVersion: number
  capabilities: readonly string[]; provider?: string; model?: string
  providers: readonly string[]
  routes: readonly ModelRoute[] }
/* A DELIBERATE SUBSET of the SDK's `RuntimeInfo` (`client.d.ts:9-19`), not a shape-for-shape copy
 * ([F14]). Two fields are dropped on purpose: `healthy: true` is a hard-coded literal — the only
 * real liveness signal is the `await this.ping()` `getRuntimeInfo()` performs first, which §5.3
 * requires on an ATTACHED connection; and `sessionId` names the probe session, which is an artifact
 * of the topology, not instance state. `provider`/`model`/`routes` are served from the bridge's
 * cache with no daemon round trip, so they are as fresh as the last attach — never a health check. */
interface ModelRoute { model: string; provider: string; apiMethod: string
  available: boolean; detail: string }        // `ModelRouteInfo`, camelCased at the seam
interface ExecutorSessionInfo { sessionId: string; workingDir?: string; title?: string
  status: string; trusted: false              // `SessionInfo.status` is untyped and lies (#18)
  transcriptBytes?: number; archived: boolean; archivedAtMs?: number }
interface StructuredResult<T> { value: T | null; attempts: number
  raw: readonly string[]                      // every response, valid or not — stored as evidence
  failed: boolean; error?: { code: string; message: string } }
interface ExecutorSessionHandle { sessionId: string
  /** Hot stream. The server MUST drain it without awaiting head IO (X7). */
  events(): AsyncIterableIterator<ExecutorEvent>
  applyConfig(patch: SessionConfigPatch, fence: Fence): Promise<ConfigApplyReport>
  submit(msg: ExecutorSubmission, fence: Fence): Promise<SubmitReceipt>
  interrupt(k: 'soft'|'urgent'|'cancel'|'retract', content: string|null, f: Fence): Promise<void>
  structured<T>(m: ExecutorSubmission, schema: unknown, maxRetries: number,
                f: Fence): Promise<StructuredResult<T>>
  tail(limit: number): Promise<{ role: string; content: string }[]>
  rename(title: string | null): Promise<void>; archive(): Promise<void>
  close(reason: string): Promise<void> }               // the ONLY release (§5.4 #9)
interface SessionConfigPatch { model?: string; reasoningEffort?: ReasoningEffort | null }
interface ConfigApplyReport { applied: ('model'|'reasoningEffort')[]
  confirmed: ('model'|'reasoningEffort')[]             // jcode: never 'reasoningEffort'
  refused: { field: string; reason: string }[] }
interface ExecutorSubmission { text: string; contextOnly?: boolean; awaitAckMs?: number
  images?: (readonly [string, string])[] }
/** `ack` is derived from a `message_accepted{session_id}` observed on the session's own `events()`
 *  stream within `awaitAckMs`, NEVER from `sendMessage` returning ([F2]): the SDK's
 *  `waitForAccept:true` resolves on timeout, so the call cannot distinguish these two values.
 *  `tail(limit)` — i.e. `peekSession` — is what proves delivery afterwards, not `getHistory`. */
interface SubmitReceipt { ack: 'accepted' | 'unknown'; ackAtMs: number | null
  correlated: boolean }                                // always false for jcode
type ExecutorEvent =
  | { k: 'text' | 'reasoning'; text: string } | { k: 'reasoning_done'; durationSecs?: number }
  | { k: 'tool_start' | 'tool_exec'; callId: string; name: string }
  /** jcode: `callId` is ALWAYS `''` — the bridge hard-codes `call_id: String::new()` for
   *  `tool_input_delta` (`translate.rs:783`) while `tool_start`/`tool_exec`/`tool_done` carry
   *  `event["id"]` ([F11]). The adapter MUST attribute the delta to the most recent `tool_start`
   *  on that session and MUST NOT key input buffers by `callId`, or every concurrent tool's
   *  argument stream merges into one bucket. */
  | { k: 'tool_input'; callId: '' | string; delta: string }
  | { k: 'tool_done'; callId: string; name: string; output: string; error?: string }
  | { k: 'usage'; input: number; output: number; cacheReadInput?: number }
  | { k: 'accepted' } | { k: 'turn_done' } | { k: 'closed'; reason: string }
  | { k: 'background'; taskId: string; label: string; percent?: number; summary: string
      done?: boolean; provenance: 'scraped' }                       // literal for jcode
  | { k: 'model_info'; provider?: string; model?: string; solicited: boolean }
  | { k: 'session_status'; status: string; trusted: false }         // never feeds a state machine
  | { k: 'error'; code: string; message: string }
```

### 5.2 Adapter capability matrix (normative)

| Capability | `jcode` | `mock` |
|---|---|---|
| `nativeReplay` / `idempotentSubmit` / `submitAckCorrelates` | **false / false / false** | configurable |
| `observableEffort` / `observableModel` | **false** / true (`model_info` broadcast) | configurable |
| `perTurnConfig` | **false** (session-sticky) | configurable |
| `programmaticApprovals` / `perTurnToolRestriction` | **false / false** — and *no* tool restriction at any scope on this topology, per turn or per instance ([F4]) | configurable |
| `structuredOutput` / `contextOnlyMessage` / `softInterrupt` | true / true (`noReply`) / true | configurable |
| `interruptLandingObservable` | **false** (event untranslated) | configurable |
| `history` | **`'text-only'`** — and only via `peekSession`; `getHistory` is `'none'` for any block-array message ([F8]) | configurable |
| `sessionsPerConnection` / `usageEvents` | **1** / true | configurable |

There is **no `claude-agent-sdk` column and no such `AdapterId`** (#27). §10 rules out "pluggable
non-jcode agent backends" as a non-goal; a normative capability column for a backend the product
declines is a contradiction that would have taken 15 flags and a conformance suite with it. The seam
stays — it is what makes `MockExecutor` and `executorConformance()` possible, and it is what keeps
the jcode-specific damage in one file — but it serves one real backend and one fake, and says so.

Every bold value above is a mitigation obligation, discharged in §5.4.
`executorConformance(factory)` asserts declared capabilities against observed behaviour, so a lying
adapter fails CI.

### 5.3 Instance and connection topology (jcode)

* **One instance per `InstanceKey`** = `provider/credentialScope` — **two** dimensions (#26).
  `setApiKey` is instance-global (no session id), so credentials are a pool dimension (R10) — and
  `credentialScope` names one of the **six** provider ids the bridge accepts (`claude-api`,
  `openai-api`, `openrouter`, `cursor`, `gemini`, `jcode`), which is a different vocabulary from
  `ModelRouteInfo.provider`; the mapping between them is the adapter's job (**[F17]**). The
  tool profile is **not** a third dimension, in wave 1 or later on this topology: the flags never
  reach the process that runs the agent (**[F4]**, §4.2).
* `JCODE_HOME = $SWARM_HOME/instances/<hash>/home`, stable across restarts, guarded by the `home:*`
  singleton lease — jcode writes `active_pids`/`internal_pids`/`streaming_pids` there and two
  daemons on one state dir corrupt it (R9).
* **Launch is swarm's, not the SDK's** (R12, Q14, #25). `launchInstance()` is **never called**:

  ```ts
  // dist/launch.js:430-441, verbatim in shape — the three facts that rule it out.
  spawn(options.binary ?? "jcode", ["api-bridge", "--api-socket", socketPath], {
    env: { ...process.env, JCODE_HOME, JCODE_RUNTIME_DIR, JCODE_API_SOCKET, JCODE_SOCKET,
           ...options.env },        // (a) additive only — no variable can be REMOVED
    stdio: ["ignore", "ignore", inheritStderr ? "inherit" : "pipe"],
    detached: false })              // (b) child stays in the SERVER's process group
  // (c) the argv array is a literal: no --tools, --tool-profile or --disable-base-tools can pass
  //     — moot as of [F4]: those flags are inert on `api-bridge` however they are delivered.
  //     (a) and (b) are what still rule this launcher out.
  ```

  Swarm therefore spawns the bridge itself:
  `spawn(binary, ['api-bridge', '--api-socket', sock, ...argv], { env: <complete allowlisted map>,
  detached: true, stdio: ['ignore','ignore','pipe'] })`, records `child.pid` as the pgid (the leader
  of the new group), waits for the socket exactly as the SDK does, then hands the socket path to
  `JcodeClient.connect()`. The SDK is still used for everything above the socket, plus
  `inheritCredentials()`/`userJcodeHome()` — those are the parts that carry knowledge swarm would
  otherwise duplicate. `inheritLogins` remains an explicit, persisted setup decision, because the
  SDK default of `true` silently spends the user's subscription quota (S10).
* `env` is a **complete map**, never a patch: `PATH`, `HOME`, `LANG`, `TZ`, opt-in `SSH_AUTH_SOCK`,
  the four jcode paths (`JCODE_HOME`, `JCODE_RUNTIME_DIR`, `JCODE_API_SOCKET`, `JCODE_SOCKET`), and
  `JCODE_SWARM_ENABLED=false`, `JCODE_MEMORY_ENABLED=false`, `JCODE_NO_TELEMETRY=1`,
  `JCODE_NON_INTERACTIVE=1`, `JCODE_AUTO_POKE` from the spec. Nothing else reaches the agent. This is
  the "scrubbed child env" S9 claims, and it is unreachable through an additive `env` option — which
  is the whole reason for the previous bullet.
* **Hard kill — two groups, not one** (§4.3.7, **[F1]**). `jcode api-bridge` calls `spawn_server`
  before it listens, and the daemon detaches via `libc::setsid()` in a `pre_exec`
  (`crates/jcode-app-core/src/server/socket.rs:267`). The agent, its tools and its bash children run
  in the **daemon's** session, which no signal aimed at the bridge can reach. Sequence:

  1. `dispose()` (clean SDK shutdown of the sessions);
  2. resolve `daemonPid` — read `$JCODE_HOME/servers.json`, take the entry whose `socket` equals
     `$JCODE_RUNTIME_DIR/jcode.sock`, use its `pid`. This is exactly what the SDK's own
     `readDaemonPidSync`/`stopInstanceDaemon` do (`dist/launch.js:258-310`), and the registry is
     scoped to this instance's home, so it can never name the user's own daemon;
  3. `kill(-daemonPid, 'SIGTERM')` **then** `kill(-pgid, 'SIGTERM')`;
  4. after 5 s, `SIGKILL` to both, falling back to `kill(daemonPid, …)` if the group signal throws;
  5. survivor scan **across both groups**; `daemonStopped` is false if the daemon is still alive.

  `pgid` **and** `daemonPid` are recorded in `runtime.json` and re-read after a server restart, so a
  reclaimed instance is still killable (R13). An instance whose `pgid` is unknown refuses `hardKill`
  with `capability_absent`; it never falls back to `kill(-process.pid)`, which is what signalling a
  `launchInstance`-spawned bridge's group amounts to — swarm killing itself while the agent it meant
  to stop keeps running. Because R12 declines `launchInstance()` wholesale, swarm also declines the
  SDK's `shutdown()`/`stopInstanceDaemon`/`reapOnExit` — **the only code that knows how to stop the
  daemon** — so re-implementing step 2 is not optional garnish, it is the entire feature.
* **Connections** (**[F5]**): the "admin" connection is **not** a permanently detached one.
  `create_session` and `attach_session` are the *same* bridge branch and both emit a daemon
  `subscribe` (`translate.rs:273-315`), so any connection that creates a session **becomes attached
  to it** and starts receiving its full event stream — and `detach_session` is a no-op (§5.4 #9), so
  it can never be released. Therefore:
  - one *probe* connection per instance, attached to a long-lived probe session in a scratch dir. It
    answers `get_runtime_info`/`list_models` (both in `REQUIRES_ATTACH`) **and** is the only
    connection whose `ping` proves the daemon is alive;
  - session creation runs on that same probe connection, which immediately re-`attach_session`es
    back to the probe session and hands the new session id to its own dedicated connection;
  - **one dedicated connection per active session**, attached once and never re-targeted;
  - `set_api_key`/`set_retention_policy`/`list_sessions`/`peek_session`/`archive_session` may run on
    the probe connection: they are answered from disk without touching the daemon.

  **Liveness is never inferred from an unattached connection.** `ping` with `session_id === None` is
  answered *bridge-locally* (`translate.rs:397`), and the five disk-served requests above answer
  happily with a dead daemon — so an "admin" connection can look perfectly healthy while nothing is
  running. `HealthVM.instances[].ok` MUST come from a `ping` on the attached probe connection.
* `setRetentionPolicy(undefined)` runs once per instance at startup to **disable** auto-archive.
  **[F12]** This is defence-in-depth, not a fix for a live hazard: the policy lives in a state file
  inside the instance's own `JCODE_HOME` — which swarm creates — and `ArchiveState::default()` has
  `archive_after_days: None`, so auto-archive is **off by default**. What is real is the mechanism:
  when a policy *is* set, `list_sessions` archives as a side effect of listing (`translate.rs:424`),
  which is why swarm pins the value rather than assuming the default (R11).
* Version gate: parse `jcode --version`; `< 0.66.0` ⇒ `PreflightReport{blocked:'version_floor'}` in
  under one second. The SDK enforces no floor of its own, so this check is the only one there is.
  A spawn `ENOENT`, a socket that never appears within `startupTimeoutMs`, or a
  child that exits during startup all map to the same message with the child's captured stderr
  attached (the SDK's `startup_failed`/`connect_failed` behaviour, reimplemented with the spawn).
  A hang is the forbidden failure mode (R1).
* **A child that exits `0` during startup is a failure, not a success** (**[F9]**). The bridge takes
  an exclusive `flock` on `<api_socket>.lock` and, if another bridge already owns it, prints
  `"harness API bridge: another bridge already owns …; exiting"` and **returns `Ok(())` — exit code
  0** (`crates/jcode-harness-api-server/src/lib.rs:113-122`). Spawn-then-wait-for-socket-then-connect
  would then find the *incumbent's* socket, connect successfully, and record a `pgid` for a corpse:
  `hardKill` would later signal a group that serves nothing while the real bridge and daemon keep
  running. The `home:*` lease covers the `JCODE_HOME` collision but **not** this one — the lock is
  keyed on the api-socket path. Normative: any child exit before the connect handshake completes,
  **including exit 0**, is `blocked:'socket_dir'` with the child's stderr in `detail`; and the
  adapter asserts `child.pid` is still alive immediately after `hello_ok` before recording the pgid.

### 5.4 Normative mitigations, one per confirmed limitation

| # | jcode limitation (verified) | Adapter/server obligation |
|---|---|---|
| 1 | Single attach per connection; 18 request tags refuse before attach and refuse cross-session; **`create_session` silently attaches the creating connection** and `detach_session` cannot undo it ([F5]) | The topology of §5.3: a probe connection that creates then re-attaches to its own probe session, one dedicated connection per active session, and liveness proven only by `ping` on an **attached** connection — an unattached `ping` is answered by the bridge itself and proves nothing |
| 2 | No replay on `events()`; untranslated daemon events are silently dropped (`_ => vec![]`) | Every event is normalized and appended to the durable log **before** fan-out. What was not received never existed for swarm; workspace + verifier are the post-reconnect truth |
| 3 | `sendMessage` has no idempotency key; `message_accepted` carries only `session_id` | Durable intent record before the send (`prepared`) carrying `idempotencyKey` + `promptDigest`; the ack sets `accepted` but is **not** treated as correlating (`correlated:false`); one in-flight turn per session under the writer lease |
| 4 | `SessionInfo.status` vocabulary is exactly `attached\|idle\|processing`, and `listSessions` reports `idle` for running sessions | Carried as `trusted:false`; forbidden from every state machine. State comes from lease + ack + tool events + `turn_done` + transport + workspace + swarm deadlines |
| 5 | A native goal subsystem exists (`goal.rs`, `<home>/goals/sessions/*.json`) but is agent-owned and unreachable | **Declined**: no goal tool, no goal read, no dependency on those files |
| 6 | A native swarm exists in the daemon (~30 `comm_*`, `jcode-swarm-core`); none is translated, but `swarm`/`swarm-deep` reach it via `setReasoningEffort` | Triple ladder validation (§4.1) + `JCODE_SWARM_ENABLED=false`. `RunSubagent` unused |
| 7 | `background_progress` is reverse-engineered from the literal markdown header `"**Background task progress** "` in a notification body | Carried with `provenance:'scraped'`, rendered in its own plane, never used for state, budget or completion; its disappearance is not an error |
| 8 | Approvals non-functional: no `permissions` capability, no `permission_request`, `permission_response` always `invalid_request`, `autoApprove` dead | Authority is structural (§5.5). The approvals surface ships dark, enabled only by the runtime probe |
| 9 | `detachSession()` is a client-side no-op — the daemon is never told, `session_id` is never cleared | **Never called.** `close()` is the sole lease release; a grep test enforces it |
| 10 | Soft-interrupt landing invisible (`soft_interrupt_injected` untranslated) | `deliveryDetail.landing='unconfirmed'`, surfaced verbatim |
| 11 | Applied effort discarded; no getter; absent from `runtime_info` and `model_info` | `effortConfirmed:false` is a literal type; no code path may claim otherwise |
| 12 | The two history reads are **not** equally lossy ([F8]): `getHistory` does `m["content"].as_str().unwrap_or("")` with **no** flattening (`translate.rs:865`), so any message stored as a content-block array comes back as an **empty string**; only `peekSession`/`stored_tail` calls `flatten_content` (`translate.rs:1805`), which keeps text and drops the rest | Swarm's normalized transcript is authoritative. **`tail()` is pinned normatively to `peekSession`** and used **only** for prompt-digest matching — never to rebuild a transcript or seed a fork (A6 forks from swarm's log). `getHistory` is **never called**; a grep test enforces it, because switching `tail()` to it would turn §5.5's digest match into a comparison against `""` and make every `unknown` turn look un-landed |
| 13 | `compact()` refuses below **10 %** context usage (`MANUAL_COMPACT_MIN_THRESHOLD = 0.10`, `crates/jcode-compaction-core/src/lib.rs:16`) with `invalid_request` + usage text | Surfaced as information, not an error. **[F15]** Note the refusal is not the only readout: `request_manual_compaction` prefixes **both** its refusal and its success with `Token usage: ~Xk / Yk (Z.Z%)` (`agent/compaction.rs:33-88`), so context pressure *is* obtainable — as unstructured prose, from a call with a side effect. W14 stays **W** on that basis, not on "unavailable" |
| 14 | `launchInstance()`'s `env` is additive (`{...process.env, ...options.env}`) and its argv is a literal | Swarm spawns `api-bridge` itself with a **complete** env map and its own argv (§5.3). A test asserts a sentinel variable present in the server's environment is **absent** from the child's |
| 15 | `launchInstance()` spawns `detached: false`, leaving the bridge in the caller's process group | Swarm spawns `detached: true` and records the pgid; `hardKill` signals that group and refuses when it has none. A test asserts the swarm server survives a hard kill and still answers an intent |
| 16 | `cancelSoftInterrupts(sessionId)` is the only retract primitive and is session-wide | `retract` on an interrupt returns `RetractReport{requested, alsoRetracted}`, resets every affected turn to `prepared` (V14), and the head renders the list. No record is left claiming `sent` for a message swarm cancelled |
| 17 | `sendMessage(noReply:true)` produces no `turn_done` | V13 ends the turn on its ack. Without it the fourth delivery mode never leaves `accepted` |

### 5.5 Reconciliation — the `unknown` protocol

Take the `delegation:*` lease → reattach → `tail(12)` — **`peekSession`, never `getHistory`**
([F8]) → compare against the persisted `promptDigest` → read workspace revision and
`git status --porcelain` against the post-dispatch snapshot → run non-mutating acceptance criteria →
decide:

| Evidence | Action |
|---|---|
| digest in tail, **or** workspace mutated after dispatch, **or** any tool event logged for this turn | delivery → `running`/`ended`; **resume observation automatically** |
| session observed `streaming` on reattach | resume observation; do not resend |
| all four of: no `message_accepted` logged; digest absent from tail; no workspace mutation since dispatch; session idle | offer **resend with the same idempotency key**, requiring confirmation unless `autoResendOnStrongEvidence` (default **false**) |
| anything else | stay `unknown`; surface the four evidence lines and a Reconcile action (X4) |

Structural authority (S9), the only real kind today: allowlisted roots (realpath + symlink guard,
re-checked on every use), a per-attempt worktree, a **complete scrubbed env delivered by swarm's own
spawn**, no secrets in prompts, explicit `inheritLogins`, and `dispose()` + `kill(-pgid)` **plus
`kill(-daemonPid)`** as the working hard stop — the bridge group alone stops nothing, because the
daemon `setsid()`s away from it (**[F1]**, §5.3). A launch-time tool profile is **permanently** off
this list on the `api-bridge` topology, not merely unobserved: the flags parse on the bridge and are
never forwarded to the process that runs the agent (**[F4]**). Claiming it would be exactly the gate
that does not gate that S8 forbids. Note also that the scrubbed env *does* reach the agent — the
daemon is `current_exe()`-re-exec'd from the bridge and inherits its environment — which is why
`JCODE_SWARM_ENABLED=false`/`JCODE_MEMORY_ENABLED=false` work while `--tool-profile` does not.

**Sleep detection (X16), normative.** A monitor samples `Date.now()` and `performance.now()` every
5 s. When `Δwall − Δmono > sleepDetectThresholdMs` (default 90 000) the server, before accepting any
mutating intent: (1) marks every channel `disconnected` (C12); (2) marks every turn in `sent`,
`accepted` or `running` as `unknown` (V5/V8) — after hours of suspend the provider stream is gone and
"in flight" is a claim swarm cannot support; (3) adds the gap to `SpendCounters.sleptMs` and excludes
it from `maxWallMs`; (4) runs the reconciliation above for every affected delegation; (5) emits one
`notice{kind:'resumed-from-sleep', wallGapMs, monoGapMs}`. **The sleep signature is a large wall gap
with a near-zero monotonic gap** — Darwin's `CLOCK_UPTIME_RAW`-backed and Linux's `CLOCK_MONOTONIC`
both exclude suspend. A large gap in *both* clocks is not sleep: it is a process that ran for hours
producing nothing, which is the **stall** signature (W5). Reporting equal gaps as "asleep" would hide
the exact failure stall detection exists to catch, and would make tracking two clocks pointless.

---

## 6. Client core — headless surface

### 6.1 Construction

```ts
export function createSwarmClient(options: SwarmClientOptions): SwarmClient
interface SwarmClientOptions { transport: SwarmTransport; clientName: string; head: HeadKind
  now?: () => number; contextProviders?: ContextProvider[]; onError?: (e: SwarmError) => void }
interface SwarmTransport {                       // injected (H7): WS, in-process, or fake
  open(): void; send(text: string): void; close(code?: number, reason?: string): void
  onOpen(cb: () => void): Unsubscribe; onMessage(cb: (text: string) => void): Unsubscribe
  onClose(cb: (i: { code: number; reason: string; wasClean: boolean }) => void): Unsubscribe
  onError(cb: (e: unknown) => void): Unsubscribe }
interface ReadableStore<T> {                     // re-declared, never imported (H3)
  get(): T; subscribe(listener: (value: T, previous: T) => void): Unsubscribe }
type Unsubscribe = () => void
```

### 6.2 Stores and view models

```ts
interface SwarmClient extends SwarmClientIntents {
  connection: ReadableStore<ConnectionVM>; fleet: ReadableStore<FleetVM>
  delegations: ReadableStore<ReadonlyMap<DelegationId, DelegationVM>>
  focus: ReadableStore<DelegationId | null>; health: ReadableStore<HealthVM>
  notices: ReadableStore<NoticeVM[]>
  /** Ref-counted: the attempt stream is subscribed on first handle, released on last. */
  transcript(attemptId: AttemptId): TranscriptHandle; diff(attemptId: AttemptId): DiffHandle
  on<K extends keyof SwarmClientEvents>(k: K, cb: (e: SwarmClientEvents[K]) => void): Unsubscribe
  once<K extends keyof SwarmClientEvents>(k: K, cb: (e: SwarmClientEvents[K]) => void): Unsubscribe
  subscribe(cb: (k: keyof SwarmClientEvents, e: unknown) => void): Unsubscribe
  inspect(): SwarmClientInspection; destroy(): void }
interface ConnectionVM { attempt: number; nextRetryAtMs: number | null
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'blocked'
  blockedReason: 'unauthenticated' | 'forbidden' | 'protocol' | null
  serverVersion: string | null; capabilities: ServerCapability[]
  pendingIntents: number; queuedOffline: number
  streams: { stream: StreamName; seq: number; lagged: boolean }[] }
type FleetBucket = 'needs-you' | 'failed' | 'stalled' | 'working' | 'queued'
                 | 'done-unlanded' | 'done-landed' | 'cancelled' | 'abandoned'
interface FleetVM { buckets: Record<FleetBucket, DelegationId[]>      // attention-sorted
  counts: Record<FleetBucket, number>; dispatchPaused: boolean
  concurrency: { runningAttempts: number; cap: number; queued: number }
  spend: SpendCounters & { capUsd: number | null } }
interface DelegationVM { id: DelegationId; version: number; title: string
  state: DelegationState; verdict: 'verified' | 'accepted' | null
  bucket: FleetBucket                       // the same total mapping the fleet used (§6.2.1)
  unverifiable: boolean; dispatchPaused: boolean; landed: boolean
  attentionScore: number                    // F2 sort key, §6.4–6.6
  nowDoing: string | null                   // W4: latest tool + target, one line
  stalledForMs: number | null; staleBase: boolean; needsYou: NeedsYouReason | null
  /* Everything a composer needs to compute the effective config locally (C7b, Q18): */
  spec: DelegationSpec                      // frozen copy of the record's spec
  defaults: { provider: string; model: string; reasoningEffort: ReasoningEffort | null
              delivery: TurnDeliveryMode }  // the cascade's middle rung, pre-resolved
  baseRef: string; baseRevision: string     // what the user typed / what it resolved to (C4b)
  liveAttemptIds: AttemptId[]; focusedAttemptId: AttemptId | null
  origin: { delegationId: DelegationId; attemptId: AttemptId } | null   // A6 lineage
  currentTurn: TurnVM | null                // the FOCUSED attempt's turn; null with none focused
  attempts: AttemptVM[]                     // each carries its own channel and currentTurn
  comparison: AttemptComparisonVM | null    // non-null once ≥2 attempts have evidence (A5)
  budget: { used: SpendCounters; limit: BudgetSpec; worstFraction: number }
  acceptance: { id: string; label: string
                status: 'unrun'|'pass'|'fail'|'error'|'manual' }[] }
interface AttemptVM { id: AttemptId; attemptNo: number; live: boolean
  channel: ChannelState; outcome: AttemptRecord['outcome']
  sessionId: string | null; worktree: string | null; staleBase: boolean
  nowDoing: string | null; startedAt: number; endedAt: number | null
  turns: number; toolCalls: number; spend: SpendCounters
  currentTurn: TurnVM | null
  verification: { runNo: number; verdict: 'pass'|'fail'|'indeterminate'; at: number } | null
  evidenceRef: string | null }
interface AttemptComparisonVM {            // A5, promoted to M by Q9
  attempts: readonly { id: AttemptId; attemptNo: number
    verdict: 'pass'|'fail'|'indeterminate'|'unrun'
    filesChanged: number; insertions: number; deletions: number
    criteria: readonly { id: string; status: 'unrun'|'pass'|'fail'|'error'|'manual' }[]
    estUsd: number; durationMs: number; turns: number; toolCalls: number }[]
  recommendation: AttemptId | null }        // best passing attempt by (criteria, cost); never auto-lands
interface TurnVM { id: TurnId; attemptId: AttemptId
  delivery: DeliveryState; effective: EffectiveTurnConfig
  landing: 'confirmed' | 'unconfirmed' | 'n/a'
  effortConfirmed: false                    // the presentation MUST render it (§4.3.4)
  configInherited: boolean                  // true when the mode gate applied (§4.3.8)
  elapsedMs: number; toolCalls: number }
interface HealthVM { server: { ok: boolean; version: string; uptimeMs: number }
  executor: { ok: boolean; adapterId: AdapterId; versions: Record<string, string>
              blocked: PreflightReport['blocked']; fix: string | null }
  instances: readonly { key: InstanceKey; pgid: number | null; daemonPid: number | null
                        sessions: number
                        ok: boolean                 // from `ping` on the ATTACHED probe connection
                                                    // only — an unattached ping is bridge-local and
                                                    // answers with a dead daemon ([F5])
                        detail: string }[]
  routes: readonly ModelRoute[]             // C7's picker source, and there is no other (Q18)
  approvalsAvailable: boolean               // the `supports('permissions')` probe (R6)
  lastDoctorAt: number | null }
interface NoticeVM { id: string; kind: NoticeKind; severity: 'info'|'warn'|'error'
  title: string; detail: string; at: number
  delegationId?: DelegationId; attemptId?: AttemptId; turnId?: TurnId
  actions: readonly { intent: IntentName | 'dismiss'; label: string }[]
  dismissible: boolean }
type NoticeKind = 'doctor-blocked' | 'version-floor' | 'server-changed' | 'stale-queued-turn'
  | 'resumed-from-sleep' | 'delivery-unknown' | 'drift' | 'budget-soft' | 'budget-hard'
  | 'landing-conflict' | 'retract-cascade' | 'capability-absent' | 'honesty'   // S8/S10/S11 (gate 10)
interface TranscriptVM { attemptId: AttemptId; following: boolean
  entries: readonly TranscriptEntry[]; hasOlder: boolean; lagged: boolean }
type TranscriptEntry =
  | { k: 'user'; turnId: TurnId; text: string; at: number; images: number }
  | { k: 'text'; text: string; at: number }
  | { k: 'reasoning'; text: string; at: number; collapsed: true }   // W1: separate channel
  | { k: 'tool'; callId: string; name: string; target: string | null
      status: 'start'|'exec'|'done'|'error'; output: string | null; durationMs: number | null }
  | { k: 'background'; taskId: string; label: string; percent?: number
      provenance: 'scraped' }                                        // W11, never state (#16)
  | { k: 'usage'; input: number; output: number }
  | { k: 'notice'; text: string }
interface DiffVM { attemptId: AttemptId; baseRevision: string; staleBase: boolean
  files: readonly { path: string; status: 'added'|'modified'|'deleted'|'renamed'
                    insertions: number; deletions: number; binary: boolean
                    hunks: readonly { header: string; lines: readonly string[] }[] | null }[]
  totals: { files: number; insertions: number; deletions: number }; truncated: boolean }
interface TranscriptHandle { vm: ReadableStore<TranscriptVM>
  follow(on: boolean): void; loadOlder(n: number): Promise<void>; release(): void }
interface DiffHandle { vm: ReadableStore<DiffVM>
  expand(path: string, expanded: boolean): void; refresh(): Promise<void>; release(): void }
interface SwarmClientInspection {           // diagnostics only — never a control surface
  protocolVersion: 1; clientVersion: string; connection: ConnectionVM
  streams: readonly { stream: StreamName; seq: number; subscribers: number; lagged: boolean }[]
  pending: readonly { id: number; intent: IntentName; idempotencyKey: string; sentAt: number }[]
  offlineQueue: readonly { intent: IntentName; idempotencyKey: string; queuedAt: number }[]
  handles: { transcripts: number; diffs: number }
  counters: Record<string, number> }
```

#### 6.2.1 Bucket mapping (total, normative)

`FleetVM.buckets` and `DelegationVM.bucket` are produced by one exported pure function,
`bucketOf(vm): FleetBucket`, so the fleet list and the row badge can never disagree:

| Delegation state | Facet | Bucket |
|---|---|---|
| `queued` | — | `queued` |
| `provisioning` | — | `working` |
| `running` | `stalledForMs === null` | `working` |
| `running` | `stalledForMs !== null` (W5) | `stalled` |
| `waiting` | — | `working` |
| `verifying` | — | `working` |
| `needs-you` | — | `needs-you` |
| `succeeded` | `!landed` | `done-unlanded` |
| `succeeded` | `landed` | `done-landed` |
| `failed` | — | `failed` |
| `cancelled` | — | `cancelled` |
| `abandoned` | — | `abandoned` |

Every one of the ten states maps, so no delegation can vanish from the dashboard — previously
`provisioning`, `waiting`, `verifying` and `abandoned` mapped to no bucket at all, which made a
delegation invisible during verification, the exact moment the law of done exists for.
`dispatchPaused` is a badge on the row, never a bucket. `bucketOf` is exported from `./testing` and
a test asserts totality over the cross product of states and facets.

`FleetVM`, `DelegationVM`, `AttemptVM`, `AttemptComparisonVM`, `TurnVM`, `HealthVM`, `NoticeVM`,
`TranscriptVM`, `DiffVM` and `ConnectionVM` are frozen and `structuredClone`-able; no head ever
receives a raw executor or wire frame (H5), and store values are referentially stable when unchanged
so `===` memoization is correct.

### 6.3 Intents

Every intent returns `Promise<IntentResult<T>>` and none throws for a domain refusal. Every mutating
intent carries `idempotencyKey` (generated if omitted) and optional `expectedVersion`.

```ts
type IntentResult<T> = { ok: true; value: T; version: number } | { ok: false; error: SwarmError }
interface SwarmClientIntents {
  createDelegation(i: CreateDelegationInput): Promise<IntentResult<DelegationId>>
  sendTurn(id: DelegationId, d: TurnDirective): Promise<IntentResult<TurnId>>
  retract(turnId: TurnId): Promise<IntentResult<RetractReport>>          // session-wide (§4.3.9)
  cancel(id: DelegationId, o: { scope: 'turn'|'delegation'|'hard'
                                attemptId?: AttemptId }): Promise<IntentResult<void>>
  retry(id: DelegationId, o?: { spec?: Partial<DelegationSpec>
                                parallel?: 1 | 2 | 3          // default spec.parallelAttempts (Q9)
                                injectPriorFailure?: boolean }): Promise<IntentResult<AttemptId[]>>
  branch(attemptId: AttemptId, o?: { title?: string }): Promise<IntentResult<DelegationId>>
  verify(id: DelegationId, o?: { attemptId?: AttemptId
                                 criteria?: readonly string[] }): Promise<IntentResult<string>>
  accept(id: DelegationId, o: { note: string; attemptId?: AttemptId }): Promise<IntentResult<void>>
  land(id: DelegationId, o: LandOptions): Promise<IntentResult<LandingRecord>>
  discard(attemptId: AttemptId): Promise<IntentResult<void>>
  archive(id: DelegationId, o?: { abandon?: boolean }): Promise<IntentResult<void>>
  reconcile(id: DelegationId): Promise<IntentResult<ReconcileReport>>
  pauseDispatch(scope: { fleet: true } | { delegationId: DelegationId },
                paused: boolean): Promise<IntentResult<void>>
  killSwitch(o: { killInstances: boolean }): Promise<IntentResult<KillReport>>
  /** Q4's delegation default is the load-bearing knob; without this it is immutable (#35). */
  updateDefaults(id: DelegationId, patch: DelegationDefaultsPatch,
                 expectedVersion?: number): Promise<IntentResult<void>>
  confirm(requestId: string): Promise<IntentResult<void>>   // copilot write-tool gate (§6.7, Q8)
  deny(requestId: string, reason?: string): Promise<IntentResult<void>>
  setFilter(f: FleetFilter): void        // local only — a view's own selection is not fleet state
  focus(id: DelegationId | null, attemptId?: AttemptId): void }          // local only
interface LandOptions { attemptId: AttemptId; mode: 'commit' | 'patch'  // 'pr' is wave 2 (Q3)
  targetBranch?: string; message?: string; outPath?: string }
interface DelegationDefaultsPatch { model?: string; reasoningEffort?: ReasoningEffort | null
  delivery?: TurnDeliveryMode; budget?: Partial<BudgetSpec>; priority?: number
  autoResendOnStrongEvidence?: boolean }
interface RetractReport { requested: TurnId
  alsoRetracted: readonly TurnId[]        // every other pending interrupt on the same session
  sessionWide: boolean                    // true for interrupt modes, false for a queue removal
  restoredTo: 'prepared' | 'deleted' }
interface ReconcileReport { delegationId: DelegationId; attemptId: AttemptId; turnId: TurnId | null
  outcome: 'resumed' | 'ended' | 'still-unknown' | 'resend-offered' | 'resent'
  evidence: { ackLogged: boolean; digestInTail: boolean; workspaceMutated: boolean
              toolEventsLogged: number; sessionIdle: boolean }   // the four clauses, verbatim (§5.5)
  deliveryBefore: DeliveryState; deliveryAfter: DeliveryState; at: number }
interface KillReport { at: number
  turnsCancelled: readonly TurnId[]; attemptsAffected: readonly AttemptId[]
  instancesKilled: readonly KillOutcome[]
  dispatchPausedFleetWide: true            // literal — the switch always pauses (Q16)
  delegationsTerminated: readonly []       // literal empty: the kill switch NEVER terminalizes
  worktreesRemoved: readonly [] }          // literal empty: worktrees are never touched
interface FleetFilter { buckets?: readonly FleetBucket[]; workspaceIds?: readonly string[]
  providers?: readonly string[]; text?: string; tags?: readonly string[]
  sort?: 'attention' | 'updated' | 'created' | 'spend' }   // default 'attention' (F2)
```

**`killSwitch` is a brake, not a delete** (Q16, #31). It cancels every in-flight turn, sets
`dispatchPaused` at fleet scope, optionally hard-kills instances, and returns the report above.
`delegationsTerminated` and `worktreesRemoved` are **literal empty tuples**, so a future
implementation that terminalizes a delegation from the kill switch fails to typecheck. The only path
to `cancelled` is `cancel{scope:'delegation'}` (D17). A panic stop that destroys N delegations and
forces N retries is not a panic stop.

**`updateDefaults`** exists because Q4 makes omission reset to the *delegation* default, which makes
that default the knob users actually reach for ("high from now on"). Without it, the only ways to
change it were repeating the override on every turn or burning an attempt through `retry({spec})` —
turning the rule that protects users from a runaway `max` into a chore that teaches them to route
around it. It bumps `version`, writes an audit row, and applies from the next turn; it never touches
a turn in flight.

### 6.4–6.6 Events, attention score, offline

**`SwarmEvent` — the closed union, all 34 kinds**, with the stream each is routed to. This is the
list `protocolConformance()` iterates; ingest rejects anything else.

```ts
export type SwarmEvent =
  // stream `server` (7)
  | { k: 'server.hello'; version: string; bootId: string }
  | { k: 'server.health'; health: HealthVM }
  | { k: 'server.doctor'; report: PreflightReport }
  | { k: 'server.notice'; notice: NoticeVM }
  | { k: 'server.pairing'; tokenId: string; action: 'issued' | 'revoked'; clientName: string }
  | { k: 'server.confirmation'; request: ConfirmationRequest }          // §6.7
  | { k: 'server.confirmation_resolved'; requestId: string; decision: 'confirm' | 'deny' }
  // stream `fleet` (6)
  | { k: 'fleet.delegation_created'; delegation: DelegationVM }
  | { k: 'fleet.delegation_state'; delegationId: DelegationId; state: DelegationState
      bucket: FleetBucket; version: number }
  | { k: 'fleet.delegation_summary'; delegation: DelegationVM }
  | { k: 'fleet.spend'; spend: SpendCounters & { capUsd: number | null } }
  | { k: 'fleet.caps'; concurrency: FleetVM['concurrency']; dispatchPaused: boolean }
  | { k: 'fleet.kill_switch'; report: KillReport }
  // stream `delegation:<id>` (13)
  | { k: 'deleg.attempt_started'; attempt: AttemptVM }
  | { k: 'deleg.attempt_ended'; attemptId: AttemptId; outcome: AttemptRecord['outcome'] }
  | { k: 'deleg.channel'; attemptId: AttemptId; channel: ChannelState }
  | { k: 'deleg.turn_prepared'; turn: TurnVM }
  | { k: 'deleg.turn_delivery'; turnId: TurnId; delivery: DeliveryState
      detail: DeliveryDetail }
  | { k: 'deleg.turn_ended'; turnId: TurnId; usage: TurnRecord['usage']; toolCalls: number }
  | { k: 'deleg.turn_retracted'; report: RetractReport }
  | { k: 'deleg.verify_started'; attemptId: AttemptId; runId: string
      reason: VerificationInput['reason'] }
  | { k: 'deleg.verify_result'; run: VerificationRun }
  | { k: 'deleg.landed'; landing: LandingRecord }
  | { k: 'deleg.drift'; attemptId: AttemptId
      kind: 'model' | 'workspace' | 'base' ; detail: string }
  | { k: 'deleg.evidence'; attemptId: AttemptId; evidenceRef: string; manifestDigest: string }
  | { k: 'deleg.defaults_updated'; patch: DelegationDefaultsPatch; version: number }
  // stream `attempt:<id>` (8)
  | { k: 'att.text'; text: string } | { k: 'att.reasoning'; text: string }
  // `callId` is always the id from `tool_start`/`tool_exec`/`tool_done`. Input deltas arrive with
  // an EMPTY call_id from the bridge ([F11]) and are attributed by the adapter to the most recent
  // `tool_start` on that session BEFORE they reach this event — the wire never carries `''`.
  | { k: 'att.tool'; callId: string; name: string; target: string | null
      status: 'start' | 'exec' | 'done' | 'error'; output?: string; durationMs?: number }
  | { k: 'att.usage'; input: number; output: number; cacheReadInput?: number }
  | { k: 'att.background'; taskId: string; label: string; percent?: number
      provenance: 'scraped' }
  | { k: 'att.turn_boundary'; turnId: TurnId; edge: 'start' | 'end' }
  | { k: 'att.diff'; totals: DiffVM['totals']; staleBase: boolean }
  | { k: 'att.error'; code: string; message: string }
```

`SwarmClientEvents` is the head-facing projection — 22 keys, each with a declared payload. The
mapping from the 34 wire kinds is many-to-one and is asserted by a test, because "31 kinds project
onto these" was previously an unverifiable sentence with two different numbers in it.

```ts
export interface SwarmClientEvents {
  'delegation:create': { delegationId: DelegationId; vm: DelegationVM }
  'delegation:state': { delegationId: DelegationId; state: DelegationState
                        bucket: FleetBucket; previous: DelegationState }
  'delegation:update': { delegationId: DelegationId; vm: DelegationVM }
  'attempt:start': { delegationId: DelegationId; attempt: AttemptVM }
  'attempt:end': { delegationId: DelegationId; attemptId: AttemptId
                   outcome: AttemptRecord['outcome'] }
  'turn:prepared': { delegationId: DelegationId; turn: TurnVM }
  'turn:delivery': { delegationId: DelegationId; turnId: TurnId
                     delivery: DeliveryState; detail: DeliveryDetail }
  'turn:end': { delegationId: DelegationId; turnId: TurnId; toolCalls: number }
  'turn:retracted': { delegationId: DelegationId; report: RetractReport }
  'verify:start': { delegationId: DelegationId; attemptId: AttemptId; runId: string }
  'verify:result': { delegationId: DelegationId; run: VerificationRun }
  'land:result': { delegationId: DelegationId; landing: LandingRecord }
  drift: { delegationId: DelegationId; attemptId: AttemptId; kind: string; detail: string }
  evidence: { delegationId: DelegationId; attemptId: AttemptId; evidenceRef: string }
  'needs-you': { delegationId: DelegationId; reason: NeedsYouReason; vm: DelegationVM }
  budget: { scope: 'fleet' | DelegationId; level: 'soft' | 'hard'; fraction: number }
  health: HealthVM
  notice: NoticeVM
  confirmation: ConfirmationRequest                                      // §6.7
  connection: ConnectionVM
  'stream:lagged': { stream: StreamName; fromSeq: number; reason: LagReason }
  'server-changed': { serverVersion: string; capabilities: readonly ServerCapability[] }
  error: SwarmError
}
```

Payloads are VM deltas, never wire frames.

`attentionScore = 1000·needsYou + 900·failed + 800·(succeeded && !landed) + 700·stalled +
600·deliveryUnknown + 500·budgetBreached + 400·staleBase + min(199, ageMinutes)`; ties break by
`updatedAt` desc then `id`. Pure function, exported from `./testing` for assertion (F2).

Offline (H9, X12): intents issued while disconnected queue locally, are counted in
`ConnectionVM.queuedOffline`, and flush in order on reconnect with their original
`idempotencyKey`. `createDelegation` and `sendTurn` apply an optimistic record with `version: -1`;
nothing else is optimistic. A queued turn older than 10 minutes at flush is held behind
`notice{kind:'stale-queued-turn'}`. Server reconciliation always wins; the client core never
resolves a conflict itself (X11).

### 6.7 Copilot tool surface and the confirmation seam (Q8)

Q8 mandates read-only tools unasked and **per-call user confirmation** for the write tools. A
confirmation requirement needs a frame that can carry a confirmation to a human; these are it.

```ts
export interface ConfirmationRequest { requestId: string; at: number; expiresAt: number
  tool: 'swarm.start' | 'swarm.followUp' | 'swarm.cancel'
  requestedBy: { kind: 'copilot'; conversationId: string; pageUrl?: string }
  summary: string                           // one line, rendered verbatim
  payload: CreateDelegationInput | { delegationId: DelegationId; directive: TurnDirective }
         | { delegationId: DelegationId; scope: 'turn' | 'delegation' }
  effective: { provider: string; model: string; reasoningEffort: ReasoningEffort | null
               workspace: string; writeMode: WorkspaceSpec['writeMode'] } }
```

| Tool | Kind | Authority | Pri |
|---|---|---|---|
| `swarm.list(filter?)` | read | none — returns `FleetVM` counts + rows | **M** |
| `swarm.inspect(delegationId)` | read | none — returns `DelegationVM` without transcript text | **M** |
| `swarm.wait({delegationId, until, timeoutMs})` | read | none — event-driven, `until: 'idle'\|'waiting'\|'terminal'\|'event'` | **M** |
| `swarm.start(input)` | write | `ConfirmationRequest` → `confirm` | **S** |
| `swarm.followUp(id, directive)` | write | `ConfirmationRequest` → `confirm` | **S** |
| `swarm.cancel(id, scope)` | write | `ConfirmationRequest` → `confirm`; **refused outright** when the delegation's `createdBy.kind !== 'copilot'` | **S** |

Flow: the copilot calls a write tool → the server persists a pending confirmation and emits
`server.confirmation` → every head raises `confirmation` and renders it → a human calls
`confirm(requestId)` or `deny(requestId, reason)` → the intent executes with
`ActorRef{kind:'copilot', confirmedBy: <tokenId>}` or is refused. Unanswered requests expire after
`confirmationTtlMs` (default 120 000) and are denied automatically. **No head connected ⇒ no
confirmation ⇒ no write**: the copilot cannot act while nobody is watching, which is the entire point
of the ruling. `swarm.complete`, `swarm.verify`, `swarm.land` and `swarm.retry` do not exist and
MUST NOT be added — a verdict a conversation can write is not a verdict.

### 6.8 `@astrale-os/swarm/presentation` — the injected seam (H6, Q15)

**This module imports nothing.** It is `comment-ui/presentation`'s contract applied to a fleet: one
frozen view model in, one void-returning intents object out, and no way to reach the client, the
wire or the store. A head that wants swarm's default look wires a `SwarmPresentation`; the extension,
which owns rendering (PRODUCT §3), may ignore it entirely — the seam exists so that "headless" is
demonstrable rather than asserted.

```ts
export interface SwarmPresentation {
  /** Called once. Return value is passed back to every later call as `handle`. */
  mount(host: SwarmHost, vm: SwarmViewModel, intents: SwarmIntents, labels: SwarmLabels): unknown
  /** Called on every VM change. The VM is frozen, total and pre-resolved. */
  render(handle: unknown, vm: SwarmViewModel): void
  /** Called once. MUST release every listener and node it created. */
  destroy(handle: unknown): void }
export interface SwarmHost { root: ShadowRoot | HTMLElement; theme: 'light' | 'dark' | 'auto' }

/** Every write a presentation can perform. Every method returns `void`, never throws, and is a
 *  documented no-op against stale state — so a presentation needs no promises and no try/catch. */
export interface SwarmIntents {
  focus(delegationId: string | null): void
  setFilter(f: { buckets?: readonly string[]; text?: string; sort?: string }): void
  send(delegationId: string, text: string, opts?: {
    attemptId?: string; delivery?: string; model?: string; reasoningEffort?: string | null }): void
  retract(turnId: string): void
  cancel(delegationId: string, scope: 'turn' | 'delegation' | 'hard'): void
  retry(delegationId: string, parallel?: 1 | 2 | 3): void
  verify(delegationId: string, attemptId?: string): void
  accept(delegationId: string, note: string): void
  land(delegationId: string, attemptId: string, mode: 'commit' | 'patch'): void
  compare(delegationId: string): void
  pauseDispatch(delegationId: string | null, paused: boolean): void
  killSwitch(killInstances: boolean): void
  confirm(requestId: string): void; deny(requestId: string, reason?: string): void
  dismissNotice(noticeId: string): void
  openTranscript(attemptId: string): void; openDiff(attemptId: string): void
  escape(): void }

/** Ordered, total, pre-resolved. Structurally compatible with §6.2's VMs, declared independently
 *  so this module keeps its zero imports; a type-level test asserts the compatibility. */
export interface SwarmViewModel {
  connection: { status: string; blockedReason: string | null; queuedOffline: number }
  fleet: { buckets: readonly SwarmBucketVM[]; dispatchPaused: boolean
           concurrency: { runningAttempts: number; cap: number; queued: number }
           spend: { estUsd: number; capUsd: number | null } }
  focused: SwarmDelegationVM | null
  notices: readonly SwarmNoticeVM[]
  confirmations: readonly SwarmConfirmationVM[]
  health: { ok: boolean; detail: string; fix: string | null
            routes: readonly { model: string; provider: string; available: boolean
                               detail: string }[]
            /** S8/S10/S11 in the product, not only in the spec (release gate 10). */
            honesty: readonly { id: string; title: string; detail: string }[] } }
export interface SwarmBucketVM { id: string; label: string; count: number
  rows: readonly SwarmRowVM[] }
export interface SwarmRowVM { id: string; title: string; bucket: string; badge: string | null
  nowDoing: string | null; attention: number; attempts: number; paused: boolean }
export interface SwarmDelegationVM extends SwarmRowVM {
  objective: string; state: string; verdict: string | null; baseRef: string; baseRevision: string
  defaults: { model: string; reasoningEffort: string | null; delivery: string }
  effective: { model: string; reasoningEffort: string | null
               effortConfirmed: false            // MUST be rendered (§4.3.4)
               inherited: boolean }              // true ⇒ the mode gate applied (§4.3.8)
  attempts: readonly { id: string; attemptNo: number; live: boolean; channel: string
                       verdict: string | null; filesChanged: number; estUsd: number }[]
  acceptance: readonly { id: string; label: string; status: string }[]
  budget: { worstFraction: number; label: string } }
export interface SwarmNoticeVM { id: string; kind: string; severity: string
  title: string; detail: string; dismissible: boolean }
export interface SwarmConfirmationVM { requestId: string; summary: string; detail: string
  expiresInMs: number }
/** i18n — every user-visible string a presentation needs. Locked interface. */
export interface SwarmLabels { send: string; cancel: string; cancelTurn: string; hardKill: string
  retry: string; verify: string; accept: string; land: string; compare: string; pause: string
  resume: string; confirm: string; deny: string; dismiss: string; killSwitch: string
  effortDeclared: string      // "declared, not confirmed" — the honest label (§4.3.4)
  effortInherited: string; emptyFleet: string; placeholder: string }
```

The reference presentation ships as `@astrale-os/swarm-ui`, its own package, in wave 2 (H6b) —
exactly as `comment-ui` ships beside `comment-core`, and for the same reason: a renderer in the core
package is a renderer everyone depends on.

---

## 7. Server — lifecycle, layout, observability

### 7.1 CLI and scheduler

```
swarm serve [--port 7717] [--config <path>] [--unsafe-bind] [--install-unit]
swarm doctor [--json]        # R2 — exit 0 healthy / 1 blocked / 2 degraded
swarm pair [--name <label>] | swarm tokens ls|revoke <id>
swarm status | ls | new | say | watch | verify | land | logs | gc
```

`serve` is the daemon; **every other verb is a head over the identical client core** (H10 — the only
real proof that headless is true). Each such verb connects over **WebSocket to `127.0.0.1:<port>`,
authenticating with `$SWARM_HOME/cli-token`** (§2.1); `--in-process` runs the same code against an
embedded server and is used by tests. Proving H10 only in-process proves that the client core can be
called from Node, which was never in doubt; proving it over the wire proves the server is a server.

Scheduler: single loop, tick on every state change and every 1 s. **The unit of admission is an
attempt, not a delegation** (Q9): a delegation with `parallelAttempts: 3` presents three admission
candidates and occupies three slots when all three are admitted. Admission order is `priority` desc
then `queued` age asc (aging guard, F7), and among equal-priority candidates a *first* attempt
outranks a *sibling* attempt, so parallel exploration never starves a delegation that has not started
at all. An attempt is admitted only when *all* hold: global slot, per-workspace slot,
per-provider/model slot, its own `worktree:*` lease, `home:*` lease, `!dispatchPaused` at both
scopes, budget not hard-breached. Sibling attempts of one delegation take **distinct worktrees** and
distinct sessions by construction. Copilot-created delegations count against the fleet cap **and**
`copilotConcurrency` (Q8).

### 7.2 `$SWARM_HOME` layout (default `~/.astrale/swarm`, override `SWARM_HOME`)

```
config.json | tokens.json 0600 | cli-token 0600     # local CLI trust (§2.1)
runtime.json 0600 {pid,port,bootId,startedAt,version,
                   instances:[{key,pgid,daemonPid,socket,jcodeHome}]}   # daemonPid: [F1]
swarm.db                        # node:sqlite WAL: log, records, leases, idem, counters, audit
instances/<hash>/home/          # JCODE_HOME (sessions, goals, logs, skills)
instances/<hash>/lock           # O_EXCL singleton lease (pid + bootId)
worktrees/<delegationId>/<n>/   # per-attempt git worktree
evidence/<attemptId>/           # acceptance output, artifacts, diffs, structured attempts
skills/<name>/SKILL.md          # materialized before session start, digests recorded (C13)
log/server-YYYYMMDD.jsonl       # process log, distinct from the event log
```

### 7.3 `config.json`

```ts
interface SwarmServerConfig { configVersion: 1; port: number; bind: '127.0.0.1'
  origins: string[]; workspaces: WorkspaceRegistration[]
  defaults: { model: ModelSpec; budget: BudgetSpec; delivery: DeliveryDefaults
              writeMode: 'worktree'; parallelAttempts: 1 }
  caps: { globalConcurrency: number          // default 4 (Q9) — counts ATTEMPTS, not delegations
    perWorkspace: number                     // default 2
    perProviderModel: Record<string, number>; worktreesPerRepo: number   // default 8
    copilotConcurrency: number               // default 1 (Q8)
    maxParallelAttempts: 1 | 2 | 3           // default 3 — the ceiling a spec may request
    softSpendUsd: number | null; hardSpendUsd: number | null }
  executor: { adapterId: 'jcode'; binary?: string; versionFloor: '0.66.0'; autoUpdate: false
              inheritLogins: boolean         // explicit, no default (S10)
              envAllowlist: string[]         // added to the mandatory base set (§5.3)
              /** Extra args to the BRIDGE PROCESS. EMPTY, and it is not a staging decision:
               *  tool flags parse here and never reach the daemon that runs the agent ([F4]).
               *  A non-empty value MUST NOT be read as a tool-authority claim (S8). */
              bridgeArgv: string[] }
  timeouts: { sleepDetectThresholdMs: number      // default 90 000 (X16)
              confirmationTtlMs: number           // default 120 000 (§6.7)
              acceptTimeoutMs: number }           // default 10 000 (V5)
  retention: { attemptStreamDays: number; attemptStreamMb: number } }   // audit is exempt (§2.3)
interface WorkspaceRegistration { workspaceId: string; root: string; label: string
  writeMode: 'worktree' | 'in-place'         // 'readonly' does not exist (Q6, #28)
  sensitive: boolean }                       // sensitive ⇒ 'worktree' forced, 'in-place' refused
```

**Workspace allowlist (S6 — the one real boundary).** On every session creation *and* every verifier
run: `realpath` the requested path; assert it equals a registered root or begins with `root + sep`;
assert no component is a symlink escaping the root; assert the root is a git repository; else refuse
with `workspace_denied`. Checked on the resolved path, every time — never once at registration.

**There is no `readonly` write mode** (Q6, #28). jcode has no read-only mode; the only lever is a
launch-time tool profile that cannot reach the agent's process on this topology at all — not "not
yet", **not on `api-bridge`** (T17, #43). A workspace marked
`readonly` would have told the user "this repo is safe" while the agent held bash with their
privileges — a gate that does not gate, which S8 names as worse than admitting we have none. A
`sensitive: true` workspace instead: forces `writeMode: 'worktree'`, refuses `'in-place'` with
`workspace_denied`, refuses `allowDirty`, and makes the S8 honesty notice non-dismissible on every
delegation created against it. That set is enforceable with what exists today, which is the only
kind of authority this spec is allowed to claim.

**`in-place` on a dirty tree (C6).** Refused with `workspace_dirty` unless
`WorkspaceSpec.allowDirty` is present, in which case the server stamps `{actor, at}` from the
authenticated caller, stores it on the record, writes an audit row, and surfaces it on
`DelegationVM.spec`. The one escape hatch from the one destructive mode is therefore attributable;
previously it had nowhere to live at all, so exercising it left no trace.

### 7.4 Observability (loopback; token-gated except `/healthz`)

| Endpoint | Returns |
|---|---|
| `GET /healthz` | `{ok, version}` only — no fleet data, no token |
| `GET /readyz` | doctor summary: version floor, socket, credentials, ≥1 available route |
| `GET /metrics` | Prometheus: `swarm_delegations{state}`, `swarm_turns_total{delivery}`, `swarm_stream_head{stream}`, `swarm_log_write_seconds`, `swarm_backpressure_drops_total`, `swarm_lease_conflicts_total`, `swarm_spend_usd`, `swarm_executor_events_total{kind}` |
| `GET /debug/streams` \| `/debug/leases` | per-stream head/floor/subscribers/lag; live leases with fencing tokens |
| `GET /debug/log?stream=&from=&limit=` | raw `LogRecord[]` — the replay primitive, for support |
| `GET /debug/audit?from=&limit=` | the retention-exempt audit trail (§2.3, S13) |
| `POST /pair` | **token-exempt** (§2.1) — it issues tokens. Still requires `x-swarm-client`, a permitted `Origin`, a literal-IP `Host`, and the one-time code |
| `DELETE /pair/:tokenId` | token-gated, §2.1 |

---

## 8. Verifier contract

```ts
interface Verifier { run(input: VerificationInput): Promise<VerificationRun> }
interface VerificationInput { attemptId: AttemptId; criteria: AcceptanceCriterion[]
  workspace: { cwd: string; baseRevision: string }; deadlineMs: number
  reason: 'auto-turn-end' | 'manual' | 'pre-land' | 're-verify' }
interface VerificationRun { runId: string; attemptId: AttemptId; runNo: number   // append-only
  startedAt: number; endedAt: number; verdict: 'pass' | 'fail' | 'indeterminate'
  results: CriterionResult[]; baseRevisionAtRun: string; staleBase: boolean
  evidenceRef: string }                      // $SWARM_HOME/evidence/<attemptId>/<runId>
type CriterionResult =                         // every member also carries `id`
  | { kind:'command'; status:'pass'|'fail'|'error'|'timeout'; exitCode:number|null
      durationMs:number; stdoutRef:string; stderrRef:string; truncated:boolean }
  | { kind:'file'; status:'pass'|'fail'|'error'; observed:string }
  | { kind:'artifact'; status:'pass'|'fail'|'error'; sha256:string|null; bytes:number|null
      producedDuringAttempt:boolean }
  | { kind:'review'; status:'pass'|'fail'|'error'; score:number; rationale:string
      judgeSessionId:string; judgeModel:string }
  | { kind:'manual'; status:'manual' }
```

1. **Where.** `command`, `file` and `artifact` checks run **in the attempt's worktree**, in a child
   process spawned by the server under the same structural constraints as the agent: same scrubbed
   env, same allowlisted root, `cwd` inside the worktree, no inheritance of the server's env (VE7) —
   acceptance commands are agent-influenced code.
2. **`review` isolation.** An independent executor session on a read-only clone, created for the run
   and closed after (VE6). It never shares the working session or its transcript; its own transcript
   is stored as evidence. `runStructured` with the fixed rubric schema
   `{score:number, rationale:string, failures:string[]}`.
3. **Caps.** Per-criterion timeout (default 120 s, max 900 s), killed by process group; run deadline
   `min(Σ timeouts, 20 min)`; output captured to files and truncated in the record at 64 KiB with
   `truncated:true` (VE8).
4. **Verdict.** `pass` iff every machine-checkable criterion passed and none is `error`/`timeout`.
   Any `manual` ⇒ `indeterminate`. `indeterminate` routes to `needs-you`, never to `succeeded` and
   never to `failed`.
5. **Evidence bundle** (VE3) under `evidence/<attemptId>/`: `diff.patch` (vs `baseRevision`),
   `runs/<runId>.json`, `runs/<runId>/<criterionId>.{out,err}`, `artifacts/*` + `sha256`,
   `transcript.jsonl` (swarm's normalized slice), `tools.jsonl`, `cost.json`, `timings.json`,
   `manifest.json` with every digest. **Reconstructable from the durable log alone** after a
   mid-turn server restart.
6. Re-verification appends a `runNo`; nothing is overwritten. A run whose `baseRevisionAtRun`
   differs from the spec's sets `staleBase` and the evidence is labelled "verified against a base
   that has moved" — never invalidated (Q10).

---

## 9. Errors

```ts
export type SwarmErrorCode =
  | 'unauthenticated' | 'forbidden' | 'unknown_frame' | 'bad_protocol' | 'frame_too_large'
  | 'bad_cursor' | 'stream_unknown' | 'rate_limited' | 'not_found' | 'version_conflict'
  | 'invalid_spec' | 'banned_effort' | 'unknown_effort' | 'turn_in_flight' | 'lease_held'
  | 'config_not_available_in_mode'        // model/effort outside `after-turn` (§4.3.8)
  | 'attempt_ambiguous'                   // ≥2 live attempts and no `attemptId` (§4.3.10)
  | 'base_unresolvable'                   // `baseRef` did not rev-parse at create (C4b)
  | 'confirmation_required' | 'confirmation_expired'   // copilot write tools (§6.7)
  | 'stale_fence' | 'budget_exhausted' | 'dispatch_paused' | 'workspace_denied'
  | 'workspace_dirty' | 'worktree_failed' | 'base_moved' | 'executor_unavailable'
  | 'version_floor' | 'executor_refused' | 'delivery_unknown' | 'verification_failed'
  | 'landing_conflict' | 'capability_absent' | 'internal'
export class SwarmError extends Error { readonly code: SwarmErrorCode
  readonly retryable: boolean; readonly details?: Record<string, unknown>
  static is(e: unknown, code?: SwarmErrorCode): e is SwarmError }
```

One class narrowed by `code`, serializable across the wire — the trade `comment-core` made.
`retryable` is set by the server and is authoritative: the client retries only when it is true.

---

## 10. Module layout and LOC budget

| File(s) | ~LOC | Contents |
|---|---|---|
| `src/{index,types,errors,readable,emitter}.ts` | 560 | barrel; every domain/VM/directive type (zero logic); `SwarmError`; `ReadableStore` + internal `writable()`; typed bus with listener isolation |
| `src/presentation.ts` | 180 | the seam (§6.8): `SwarmPresentation`, `SwarmViewModel`, `SwarmIntents`, `SwarmLabels`. **Zero imports, zero logic** — grep-enforced |
| `src/protocol/{frames,events,codec}.ts` | 560 | envelope + close codes; **34** `SwarmEvent` kinds + stream routing; strict ingest codec |
| `src/client/{connection,streams}.ts` | 470 | handshake, backoff, heartbeat, resume, close-code policy; subscribe/snapshot/replay, ack windows, ref-counted attempt streams |
| `src/client/{intents,projections}.ts` | 640 | the 19 intents, idempotency, offline queue, optimistic records; events → `FleetVM`/`DelegationVM`/`AttemptVM`/`TurnVM`/`HealthVM`/`NoticeVM`, `bucketOf`, attempt comparison, attention score |
| `src/client/{transcript,directive,index}.ts` | 410 | handles + coalescing + diff; ladder/cascade/banned-effort; `createSwarmClient` |
| `src/server/{index,http,ws}.ts` | 590 | composition root; pairing, origin/`Host`, observability; subscriptions + backpressure |
| `src/server/{store,leases,scheduler}.ts` | 750 | SQLite schema, single-writer log, snapshots, idempotency, retention; fencing counter + file lock; admission, caps, aging, dispatch pause |
| `src/server/{delegation,turn,reconcile}.ts` | 790 | intent handlers + the three state machines + budget monitor; `applyAndSubmit` and delivery tracking; the `unknown` protocol and resend gate |
| `src/server/{workspace,verifier,notify}.ts` | 650 | allowlist, realpath/symlink guard, worktrees, diff, drift, landing; criterion runners, judge session, evidence bundle; OS notification with no head (F12) |
| `src/server/executor/{types,jcode,spawn}.ts` | 860 | the seam; **swarm's own `api-bridge` spawn, env allowlist, pgid + `servers.json` daemon-pid tracking, the two-group `hardKill`, and the exit-before-handshake check** (§5.3, [F1], [F9]); instance pool, probe/dedicated connection topology, ack observation ([F2]), `tool_input` attribution ([F11]), event normalization, the §5.4 mitigations |
| `src/server/{copilot,confirm}.ts` | 220 | the six tools, the confirmation request/response lifecycle, TTL expiry (§6.7) |
| `src/cli/*.ts` | 430 | 12 verbs over the client core, WS transport + `cli-token`, `--in-process` |
| `src/testing/*` | 980 | `MockExecutor`, the three conformance suites, `fakeJcodeTransport`, `bucketOf` + attention-score exports, barrel |
| `src/testing/demo/*` | 260 | **the seeded demo scenario** (release gate 10): a scratch repo, a failing test, two acceptance criteria, a scripted three-attempt run — so nobody dogfoods on real work on day one |
| in-product honesty surface | 120 | the S8/S10/S11 notices (`NoticeKind: 'honesty'`), the "declared, not confirmed" effort label, the `inherited` badge, the no-tool-authority statement — rendered by the head from `HealthVM.honesty` (release gate 10) |

**Total ≈ 8 160 LOC** — client core ≈ 2 400, presentation seam ≈ 180, server ≈ 4 260, testing ≈
1 240, honesty surface ≈ 120. The part that can be wrong in a way the user notices — `turn.ts`,
`reconcile.ts`, `delegation.ts`, `executor/jcode.ts`, `executor/spawn.ts` — is ≈ 1 560 and carries
the named tests of §13. The demo scenario and the honesty surface get their own lines because
release gate 10 depends on both and a gate with no budget is a gate that slips.

---

## 11. Quick start

```bash
swarm doctor
# ✓ binary ~/.local/bin/jcode   ✗ version 0.64.2 < 0.66.0 — fix: jcode update
#   (`jcode upgrade` does not exist: `error: unrecognized subcommand 'upgrade'`. The one
#    copy-pasteable string in the whole first-run screen has to be the one that works.)
jcode update            # → ≥ 0.66.0 (0.67.1 is the latest tag at time of writing).
                        # The SDK checks no version at all — this gate is swarm's alone.
swarm serve --port 7717
# swarm 0.1.0 on 127.0.0.1:7717 — pairing code K7QF-2M9X (5 min, one use)
# cli token written to ~/.astrale/swarm/cli-token (0600)

swarm ls                # a second head, over WS, authenticated from cli-token — no pairing
```

```ts
// 2. Extension pairing, then one client over the injected transport.
//    /pair is token-exempt (§2.1) — it is where tokens come from. `x-swarm-client` still required.
const { token } = await (await fetch('http://127.0.0.1:7717/pair', { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-swarm-client': 'ext/0.1' },
  body: JSON.stringify({ code: 'K7QF-2M9X', clientName: 'Chrome', clientKind: 'extension' }) })).json()
await chrome.storage.local.set({ swarmToken: token })
const client = createSwarmClient({ clientName: 'ext/0.1', head: 'extension',
  transport: webSocketTransport('ws://127.0.0.1:7717/swarm', ['swarm.v1', `swarm.tok.${token}`]) })
client.connection.subscribe(renderBadge)

// 3. One delegation, end to end. Three attempts at one objective — the flagship loop (Q9).
const created = await client.createDelegation({ title: 'Fix flaky auth test',
  idempotencyKey: crypto.randomUUID(), spec: { specVersion: 1,
  objective: 'Make test/auth.spec.ts deterministic. Do not weaken the assertions.',
  acceptance: [{ kind: 'command', id: 'unit', label: 'unit suite',
                 command: 'pnpm test -- auth', timeoutMs: 300_000 },
               { kind: 'file', id: 'nofocus', label: 'no .only', path: 'test/auth.spec.ts',
                 must: 'match', pattern: '^(?!.*\\.only).*$' }],
  // `baseRef` is an EXPRESSION; the server resolves it to a full sha in the create transaction
  // and the record never holds 'HEAD' (C4b) — drift, verification locking and landing need a sha.
  workspace: { workspaceId: 'exp-spec', baseRef: 'HEAD', writeMode: 'worktree' },
  model: { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: 'medium' },
  budget: { maxWallMs: 45 * 60_000, maxTurns: 30, maxToolCalls: 200, maxInputTokens: 2_000_000,
            maxOutputTokens: 200_000, onBreach: 'pause-dispatch' },
  execution: { nativeSwarm: false, jcodeMemory: false, autoPoke: true, skills: [] },
  context: [{ kind: 'file', path: 'test/auth.spec.ts' }],
  parallelAttempts: 3,
  delivery: { mode: 'after-turn', notify: 'notify' } } })
if (!created.ok) throw created.error
const id = created.value
client.on('needs-you', (e) => e.delegationId === id && focusIt(e))

// The three attempts occupy three scheduler slots, three worktrees, three sessions.
const d = () => client.delegations.get().get(id)!
d().spec.workspace.baseRevision   // '9f2c1ab…' — the resolved sha, not 'HEAD'
d().liveAttemptIds                // [a1, a2, a3] while they run
d().comparison                    // AttemptComparisonVM once ≥2 have evidence (A5, M)

// verifier runs at each attempt's turn end; verdict 'verified' ⇒ succeeded && !landed
// ⇒ bucket 'done-unlanded' (§6.2.1). Landing names an attempt explicitly — there is no
// "current attempt" to guess at when three of them exist.
const winner = d().comparison!.recommendation ?? d().attempts.find(a => a.verdict === 'pass')!.id
await client.land(id, { attemptId: winner, mode: 'commit', targetBranch: 'fix/flaky-auth' })

// 4. A per-turn effort change on one attempt. The delegation default is 'medium'.
await client.sendTurn(id, { text: 'Plan the fix first.', attemptId: winner,
                            reasoningEffort: 'max', idempotencyKey: k1 })
//   server: assert idle → setReasoningEffort(sid,'max') → persist turn → sendMessage
//   TurnVM.effective.reasoningEffort === 'max', effortConfirmed === false — never observable
await client.sendTurn(id, { text: 'Now apply step 1.', attemptId: winner, idempotencyKey: k2 })
//   omission ⇒ reconcile to the DELEGATION default: setReasoningEffort(sid,'medium')
await client.sendTurn(id, { text: 'switch model', attemptId: winner, model: 'gpt-5.4',
                            idempotencyKey: k3 })
//   while streaming ⇒ { ok:false, error: SwarmError('turn_in_flight') } — refused, never deferred
await client.sendTurn(id, { text: 'stop touching the fixtures', attemptId: winner,
                            delivery: 'interrupt', reasoningEffort: 'max', idempotencyKey: k4 })
//   ⇒ { ok:false, error: SwarmError('config_not_available_in_mode') } — refused in the CLIENT CORE,
//   no wire traffic. Steering happens mid-turn; config changes cannot. (§4.3.8)
await client.sendTurn(id, { text: 'stop touching the fixtures', attemptId: winner,
                            delivery: 'interrupt', idempotencyKey: k5 })
//   accepted; effective.reasoningEffort === 'inherited', landing === 'unconfirmed'

// 5. "High from now on" — the delegation default is mutable, or Q4's rule becomes a chore.
await client.updateDefaults(id, { reasoningEffort: 'high' }, d().version)

// 6. Retract an interrupt. The primitive is session-wide, so the report says what else went.
const r = await client.retract(t5)
if (r.ok) console.log(r.value.alsoRetracted)   // every other pending interrupt on that session
```

---

## 12. Decision log

| # | Contested point | Chosen | Rejected | Why |
|---|---|---|---|---|
| 1 | Package shape | One package, **four** entries (`.`, `./presentation`, `./server`, `./testing`), protocol as an internal module re-exported from `.` | a `swarm-host`/`swarm-client`/`swarm-protocol` triplet; a `./protocol` entry; a fifth entry of any kind | A triplet forces three versions to move together forever and gives a two-runtime product three release trains. The protocol is ~560 LOC of types plus a pure codec — an entry point for it buys nothing. The fourth entry is `./presentation` and only that: **superseded by #34**, which amends H1's "three" via PRODUCT Q15, because a seam that imports nothing cannot live in a barrel that imports everything. |
| 2 | Where policy lives | Server owns scheduling, budgets, leases, verification, landing; the client core owns projection and intents only | policy in the client core with the server as a relay | H8 and Q7: the fleet must progress with no head attached. Any policy in the head makes closing a tab a scheduling event. |
| 3 | Sequencing | **Per-stream gapless `seq`** over four stream families | one global sequence; per-connection sequence | A global sequence forces a head watching one delegation to receive the whole fleet's transcript volume. Per-connection sequence makes resume impossible after a server restart — which is the case replay exists for. Per-stream costs one `stream_head` row each and makes `attempt:*` independently droppable. |
| 4 | What degrades under backpressure | Only `attempt:*`, with an explicit `lagged` frame and a forced re-snapshot | silent oldest-frame drops; blocking the executor pump; killing the connection | Q12 rules the transcript evidence, not the product. Silent drops make a gap indistinguishable from a bug, and §2.3 forbids gaps. Blocking the pump would let a slow head reach jcode — **corrected [F7]**: not by tripping a jcode-side buffer kill (there is none on this path; the 10 000-event `event_buffer_overflow` belongs to `globalEvents()`, banned by #11), but by growing `events()`'s **unbounded** adapter array until the socket's write buffer fills and `write_all` stalls the **bridge's select loop** for every session on that instance. Same conclusion, real mechanism. |
| 5 | Resume model | Durable-log replay from `seq`; connections hold no resumable state | connection-scoped resume windows; "stream and hope" | A service worker dies without warning and a laptop sleeps for hours. A resume window shorter than a lunch break is a resume window that does not exist. Statelessness also deletes a class of leak. |
| 6 | `unknown` delivery | First-class state, four-clause strong-evidence gate, **never** auto-resends by default | auto-resend on timeout; hiding `unknown` behind a spinner | Q5. **[B3]** `sendMessage` has no idempotency key and `message_accepted` carries only `session_id` — it does not even echo an index, so an ack can never be correlated to a send. A duplicated destructive turn is unrecoverable; a confirmation is annoying. |
| 7 | Effort as state | `effortConfirmed: false` is a **literal type**, not a boolean field | modelling effort as observed state; polling; inferring from latency | The bridge discards the daemon's applied value (`translate.rs:936`), the SDK returns `Promise<void>`, there is no getter, and neither `runtime_info` nor `model_info` carries effort. A literal makes the lie unwriteable rather than a convention that regresses. |
| 8 | Mid-turn config change | **Refuse** with `turn_in_flight` | queue it for the next turn; pass it through | jcode defers it to turn end, so a pass-through applies a setting to a turn the user never targeted. **Sharpened [F10]:** the deferral is not silent-and-immediate-`ok` — the daemon holds the reply until it can take the agent mutex, so the call **hangs for the rest of the turn** and the SDK rejects it at `requestTimeoutMs` (30 s) with `HarnessError('timeout')` *while the setting still lands at turn end*. A pass-through therefore produces an error the caller must ignore and a side effect the caller cannot see, and burns a 30 s slot on the session's only connection. Queueing hides the refusal and re-invents the stickiness Q4 forbids. |
| 9 | Effort ladder | Closed union from a static provider+model table; `swarm`/`swarm-deep` refused at three layers | passing the user's string through; runtime ladder discovery | **[Bnew]** `swarm` is a real accepted effort meaning "max effort + use jcode's internal swarm tool"; it would hand orchestration to jcode inside a session swarm believes it owns, and `JCODE_SWARM_ENABLED=false` does **not** block it (`append_swarm_effort_directive` is called unconditionally from `agent/prompting.rs:119`). There is no ladder-discovery request. **Corrected [F3]:** the earlier justification — "the Anthropic path logs-and-ignores unknown values" — is **false**. Both provider runtimes `bail!` on an unknown effort *before* normalization and the bridge maps it to `invalid_request`; the log-and-ignore branch (`normalize_reasoning_effort`) is unreachable from `set_reasoning_effort`. The decision is unchanged and the reason is stronger stated correctly: `ok` still cannot validate, because the values swarm must refuse — `swarm`/`swarm-deep` — are precisely the ones jcode **accepts**. And error handling on `setReasoningEffort` is *not* pointless, which the old wording implied. |
| 10 | `detachSession` | **Never called**; `close()` on the dedicated connection is the only lease release, enforced by grep | using it as a lease release, as the briefing's topology implies | **[B1]** Verified no-op: the daemon is never told and `session_id` is never cleared. It would produce a lease that appears released and is not — the worst failure mode for a one-writer invariant. |
| 11 | `globalEvents()` | **Banned**; one dedicated connection per session drained by a pump that never awaits head IO | using it for fleet-wide streaming | It spawns child connections outside lease accounting, polls ~1 s for discovery, and *fails the iterator* at 10 000 buffered events rather than dropping. Banning it removes X7's failure mode at the source and deletes X15's discovery latency. |
| 12 | Durable store | `node:sqlite` (built-in), WAL, one writer, one `log` table | JSONL + a side index; LevelDB; an ORM | R8 forbids extra runtime requirements. The atomicity we need is "record mutation + log rows + head bump in one transaction, before the ack" — one `BEGIN IMMEDIATE`. A JSONL log cannot provide it without reimplementing a WAL. |
| 13 | History as truth | Swarm's normalized log is authoritative; `tail()` — pinned to **`peekSession`** — only for prompt-digest matching; `getHistory` **never called**, grep-enforced | rebuilding a transcript from `getHistory`; seeding forks from it; treating the two reads as equivalent | **[Bnew]** `flatten_content` drops every non-text block — tool calls and images contribute nothing, not even a placeholder. A fork seeded from it silently loses the work. **Corrected and worsened [F8]:** the two reads are not equally lossy, and the *worse* one is the one the name suggests you would use. `getHistory` does `m["content"].as_str().unwrap_or("")` with **no** flattening, so a block-array message returns `""` — not text-only, *empty*. `flatten_content` is used at exactly one site, serving `peekSession`. §5.5's digest match is only sound because `tail()` is `peekSession`; the pin is now normative rather than incidental. |
| 14 | Approvals | Built, shipped **dark**, gated on `supports('permissions')` probed every connect | shipping an approvals UI now; deleting the surface | **[B8]** Confirmed verbatim: the bridge replies `invalid_request` to every `permission_response`, never emits a request, and `autoApprove` is a dead branch. A gate that does not gate is worse than an honest statement (S8); the dark surface makes shipping day a probe flip, not a redesign. |
| 15 | Authority model | Structural: allowlist + worktree + scrubbed env + launch-time tool profile + process-group kill | container/VM sandboxing; enforced network allowlists; read-only default | Q6, S11. A container is a different product and R8 forbids requiring one; network allowlisting without one is unenforceable and must not be claimed. Read-only default makes the agent unable to do the job. |
| 16 | `background_progress` | Carried with `provenance:'scraped'`; never feeds state or budget | treating it as a task API; hiding it | **[B7]** jcode derives it by string-matching the literal header `"**Background task progress** "` in a notification body. Any TUI copy change kills it silently. Rendering it is useful; depending on it is a time bomb. |
| 17 | Goals and native swarm | **Declined**, explicitly | adopting jcode's goal subsystem; using `comm_*` | **[B5][B6]** Both exist and are rich (`goal.rs` + `jcode_task_types`; ~30 `comm_*` and `jcode-swarm-core`) but no `comm_*` is translated by the bridge and goals are agent-owned and unobservable. We decline a native implementation rather than fill a void — and ownership must sit with swarm regardless, because a verdict the agent can write is not a verdict. |
| 18 | `SessionInfo.status` | Typed `trusted:false`, forbidden from every state machine | using it for `running`/`idle` | **[B4]** The whole vocabulary is `attached\|idle\|processing`; `processing` appears only in the attach reply and `listSessions` reports `idle` for sessions that are actively running. A field that lies in the common case is worse than no field. |
| 19 | `run()` vs `sendMessage()` | `sendMessage` + `events()` everywhere; `run()` never; `runStructured` wrapped in a swarm deadline | using `run()` for simple turns | `run()` has no timeout, no budget and no abort signal. `runStructured` is the only *true* per-turn control and is worth its retry cost, but its turns must count against the budget and stay cancellable — so it is wrapped, never trusted to terminate. |
| 20 | Instance pooling key | ~~`provider/credentialScope/toolProfile`~~ → **`provider/credentialScope`** (**superseded by #26, closed by [F4]**), one `JCODE_HOME` per key under an `O_EXCL` singleton lease | one instance for everything; one per delegation | `setApiKey` is instance-global, so credentials are a pool dimension (R10) — and `credentialScope` is one of six fixed provider ids ([F17], §5.3). The third dimension was justified by "tool profiles are process args, so authority is one too" — true of `jcode serve`, false of `api-bridge`: the flags are `global = true` and parse on the bridge, but `spawn_server` forwards only `--provider`/`--provider-profile`/`--model` to the daemon that actually runs the agent. It does **not** return "the day a run observes the flag"; it returns only if swarm adopts a pre-started-`jcode serve` topology, which is a different design, not a test result. The lease is required because jcode writes `active_pids`/`streaming_pids` into the home and two daemons on one state dir corrupt it. |
| 21 | `review` criteria | Independent session, read-only clone, `runStructured` rubric, non-authoritative by default | judging in the working session; letting `review` alone produce `verified` | VE6. A judge sharing the working context grades its own homework, and an LLM verdict promoted to `verified` re-introduces the "agent says done" failure the product exists to remove. |
| 22 | Retry semantics | `retry` and a late follow-up both **reopen** the delegation as attempt *N+1*; attempts append-only | a new delegation per retry; mutating attempt *N* | Q2. Attempt comparison — Q9's flagship loop — requires one objective with N attempts under one id, and mutating an attempt destroys the evidence that justified its verdict. |
| 23 | Landing scope | `commit` + `patch` are M, `pr` is C; conflicts never agent-resolved | agent-driven rebase; no landing at all | Q3, Q10. `git apply` + a branch is an afternoon; owning review and git identity is a second product. A moved base annotates (`staleBase`) and surfaces `needs-you`; it never silently invalidates evidence. |
| 24 | Client-core error handling | One `SwarmError` + code union; domain refusals return `{ok:false}` rather than throwing | throwing everywhere; per-code subclasses | Intents are called from a service worker and a CLI. Refusals (`turn_in_flight`, `budget_exhausted`) are expected outcomes, and expected outcomes that throw produce `try`/`catch` at every call site and swallowed bugs. |
| 25 | Remaining briefing corrections carried into fields | branch `master`; MCP transports `stdio\|http\|sse\|streamable-http` on `McpServerRef`; `skill_manage` exists but is agent-facing, so materialize-then-name stays correct on `SkillRef` | trusting `main`, stdio-only MCP, and "no skill API" | Reality wins over input material, and each correction changes a concrete field in this spec rather than a footnote. |

### Rows 26–40 — the 2026-08-04 adversarial review

Rows 26–29 and 31 invalidate previously **locked** text; they are recorded here rather than edited in
silently, because a locked spec that changes without a ruling is not locked.

| # | Contested point | Chosen | Rejected | Why |
|---|---|---|---|---|
| 26 | Who spawns `api-bridge` | **[R1]** Swarm spawns it: complete allowlisted `env`, own argv, `detached: true`, recorded pgid (§5.3). `launchInstance()` is used for nothing but `inheritCredentials`/`userJcodeHome` | using the SDK's documented entry point; keeping `toolProfile` in `InstanceKey` | `dist/launch.js:430-441` is `spawn(binary, ["api-bridge","--api-socket",socketPath], { env: {...process.env, ..., ...options.env}, detached: false })`. `env` is **additive** — no variable can be removed, so S9's "scrubbed child env" is unreachable. The argv is a **literal** — `--tools`/`--tool-profile`/`--disable-base-tools` cannot be delivered at all, so `InstanceKey`'s third dimension, `ExecutionSpec.toolProfile` and T16's "launch-time only" mitigation described a capability that did not exist. Twenty lines of `spawn` restore all three. |
| 27 | The hard kill's target | **[R2]**, amended by **[F1]**: `kill(-pgid)` on a group **swarm created** **and** `kill(-daemonPid)` on the `setsid()` daemon's group, `daemonPid` resolved from `$JCODE_HOME/servers.json` by socket path; `hardKill` refuses with `capability_absent` when it has no pgid and reports `daemonStopped:false` when the daemon outlives it | `kill(-pgid)` on the SDK-spawned bridge's group; **and — the [F1] correction — signalling only the bridge group swarm created** | `detached: false` leaves the bridge in the *server's* process group, so R2's first half stands: performed against that group the kill takes down the swarm server. But R2's replacement was still wrong, and wrong in the direction that reports success. `jcode api-bridge` spawns the daemon via `spawn_server`, and the daemon `libc::setsid()`s in a `pre_exec` (`socket.rs:267`) — it leads its **own** session, and the agent, its tools and its bash children live there. `kill(-bridgePgid)` reaches none of them; `KillOutcome.survivors` comes back empty while the agent keeps writing. The SDK states this verbatim in `reapOnExit` and its own stop path reads the daemon pid from `servers.json` and signals `-daemonPid` — code swarm discarded when R12 banned `launchInstance()` wholesale. §13's old assertion ("bridge is a process-group leader, server survives") passes on a broken feature; it is replaced by an assertion that the **daemon process is gone**. |
| 28 | `writeMode: 'readonly'` | **[R3]** **Deleted.** `'worktree' \| 'in-place'`; `sensitive` forces `worktree`, refuses `in-place` and `allowDirty`, and pins a non-dismissible honesty notice | shipping `readonly` as a default for sensitive workspaces (S7, Q6 as written) | jcode has no read-only mode. The only lever is a launch-time tool profile, which per row 26 could not be delivered by the SDK launcher and which row 43 ([F4]) shows cannot be delivered by swarm's own spawn either — the flag parses on `api-bridge` and never reaches the daemon that runs the agent. A workspace labelled read-only while the agent holds bash is exactly the gate that does not gate — which S8, in this same document, calls worse than admitting we have none. Deleting a value is cheaper than defending a lie. |
| 29 | Parallel attempts | **[R4]** Structural and wave 1: `parallelAttempts: 1\|2\|3`; execution state lives on the attempt; `liveAttempts` replaces `currentAttempt`; the scheduler admits **attempts**; delegation state is a rollup; A5 becomes **M** with `AttemptComparisonVM` | keeping one `currentAttempt` and one delegation-level channel; demoting Q9's flagship claim to wave 2 | Q9 calls "3 parallel attempts at one objective" the flagship behaviour that justifies the name. With a singular `currentAttempt`, one `ChannelState` per delegation, and admission by delegation, three attempts could only run in sequence — a retry log wearing the word "swarm". The cost is one array, one rollup rule and an `attemptId` on the directive; the alternative was deleting the product's headline. |
| 30 | Per-turn config vs delivery mode | **[R5]** Legal only with `after-turn`; the other three modes refuse the field (`config_not_available_in_mode`) and record `'inherited'` | letting them compose and refusing at dispatch; silently ignoring the field | `next-safe-point` and `interrupt` exist only while a turn is in flight — precisely the states §4.3.3 refuses — so `{delivery:'interrupt', reasoningEffort:'max'}` was *always* `turn_in_flight`, and steering always silently ran at the previous turn's effort. `context-only` never reasons, so a recorded effort named nothing. Neither document said so anywhere, and §5.2's rows implied they composed. |
| 31 | Kill switch semantics | **[R6]** A brake: cancel in-flight turns, `dispatchPaused` fleet-wide, optional instance kill, **no state change, no worktree touched**, `KillReport` with literal-empty `delegationsTerminated`/`worktreesRemoved` | D17's "any non-terminal → `cancelled` … or the kill switch" | The kill switch was specified twice with opposite semantics: F5 said "stop turns and dispatch", D17 said it reached the terminal `cancelled`. Under D17, panic-stopping a fleet of eight destroyed eight delegations and cost eight retries at the exact moment the user was trying to *stop* losing work. The panic button and the delete button cannot be the same button. |
| 32 | `context-only`'s terminal edge | **[R7]** V13: `accepted → ended` on the ack when `contextOnly` | leaving §3.3's prose to imply a path the table did not contain | The only route to `ended` was V7 (`running → ended` on `turn_done`) and the only route to `running` was V6 (a stream event). `sendMessage(noReply:true)` produces neither, so a fourth-delivery-mode turn sat in `accepted` forever. |
| 33 | Undeclared surface | **[R8]** All twenty referenced-but-undeclared types declared (§5.1, §6.2, §6.3, §6.4, §6.8), `SwarmEvent` enumerated at **34** kinds, `SwarmClientEvents` given payloads and reconciled to 22 keys | keeping the DoD's "every symbol … with exactly the listed signature" over a surface that did not exist | §13 asserted the whole surface was exported verbatim while `HealthVM`, `NoticeVM`, `TranscriptVM`, `DiffVM`, `DiffHandle`, `AttemptVM`, `SwarmClientInspection`, `SwarmClientEvents`, `FleetFilter`, `ReconcileReport`, `KillReport`, `CreateDelegationInput`, `StreamName`, `IntentName`, `SwarmEvent`, `InstanceOptions`, `ExecutorRuntimeInfo`, `ExecutorSessionInfo`, `StructuredResult` and `SwarmPresentation` were never declared — and "a closed union of 31 kinds (§6.4)" pointed at a list of 21 different keys, so `protocolConformance()` could not be written. A LOCKED spec saying "implementers must not make API decisions" was forcing twenty of them. |
| 34 | The presentation seam | **[R9]** A fourth entry, `./presentation`, importing nothing; `SwarmPresentation` + void-returning `SwarmIntents` + `SwarmViewModel` + `SwarmLabels`; reference presentation is a separate wave-2 package | leaving H6 as prose; deleting H6 and giving rendering to the head outright | `SwarmPresentation` appeared three times and was declared zero times: absent from `SwarmClientOptions`, absent from §1.1's entries, absent from the LOC table, and contradicted by §3's ownership table, which gave *all* presentation to the extension. `comment-ui` has `./presentation` (imports nothing, CI-grepped) + `./glass` + `./styles.css`; swarm had none of that shape while claiming the same house style. H1's "three entries" is amended by PRODUCT Q15 rather than quietly violated. |
| 35 | Mutable delegation defaults | **[R10]** `updateDefaults(id, patch, expectedVersion)` | leaving the delegation default immutable | Q4 makes omission reset to the *delegation* default, which makes that default the knob users reach for. Without an intent, "high from now on" meant repeating the override on every turn or burning an attempt via `retry({spec})` — teaching users to route around the rule that protects them from a runaway `max`. |
| 36 | Retract's real scope | **[R11]** Session-wide for interrupts: `RetractReport{requested, alsoRetracted}`, every affected turn back to `prepared` (V14), the head renders the list | `retract(turnId)` implying one message | `cancelSoftInterrupts(sessionId)` is the only primitive and takes no message identity. The previous contract silently un-delivered every other pending interrupt while their records still read `sent` — swarm asserting a delivery it had itself cancelled. |
| 37 | Fleet bucket totality | **[R12]** Nine buckets, `working` + `abandoned` added, one exported `bucketOf()` and a published state×facet table (§6.2.1) | eight buckets with `provisioning`, `waiting`, `verifying`, `abandoned` mapping to none | `FleetVM.buckets` was `Record<FleetBucket, …>` — total in the *type* and partial in *fact*. Four of ten states rendered nowhere, including `verifying`, the moment the entire law of done exists for. Success criterion 2 is "knows within five seconds which one needs them"; a delegation that vanishes for the duration of its verification defeats it. |
| 38 | Local CLI authentication | **[R13]** `serve` writes `$SWARM_HOME/cli-token` (0600); every CLI verb reads it and connects over WS; the DoD adds a real-server CLI run | pairing from the CLI; a peer-credential handshake; leaving the CLI in-process only | `tokens.json` stores only `sha256(token)`, there was no CLI issuance path, and §7.1 said every verb but `serve` is a head over WS — so the CLI could not authenticate against a real server, and CI never noticed because the DoD only drove it in-process against `MockExecutor`. H10 is called "the only real proof that headless is true"; it was proof against a fake. Filesystem ownership is the right primitive: a process that can read that file can already run `jcode`. |
| 39 | Copilot's confirmation mechanism | **[R14]** `ConfirmationRequest` + `server.confirmation` event + `confirm`/`deny` intents + a six-tool table (§6.7); read-only tools **M**, write tools **S** | leaving Q8 as a ruling with no schema; moving Q8 wholly to wave 2 | Q8 mandated per-call confirmation while the spec defined no tool schemas, no confirmation event, no confirm/deny intent and no frame that could carry a confirmation to a human. `browser-copilot` is a named planned consumer. A mandate with no mechanism is decided by whoever writes the code first. |
| 40 | Small corrections with outsized blast radius | **[R15]** `jcode update` (not `upgrade`, which does not exist); `/pair` and `/healthz` token-exempt; images capped at 700 KB decoded (derived from the 1 MiB frame cap + base64's 33 %); `baseRef` expression resolved to a full sha at create; audit in its own retention-exempt table; sleep = wall ≫ monotonic with X16 server-side wake handling; `allowDirty{actor, at, note}`; `origin` on branched delegations; Node ≥ 24 in both documents; `AdapterId = 'jcode' \| 'mock'`; HTTP+SSE fallback demoted to **C** | the previous values | Each was independently fatal to something the documents promised: the one copy-pasteable fix printed a command that errors; pairing required the token it issues; a 4 MiB image allowance died at ~750 KB with a *transport* error; `baseRevision: 'HEAD'` disabled drift detection, verification locking and landing at once; the audit expired 30 days after the fact including for landed work; the named sleep test asserted the *stall* signature; C6's "explicit override" had no field to live in; `branch` threw away the lineage Q2 and A5 both need; `node:sqlite` does not exist on Node 20; a 15-flag capability matrix served one real backend plus a column for a backend §10 explicitly rules out; and H7's fallback transport was **M** with no endpoint, no frame and no `SwarmTransport` variant anywhere in §2. |

### Rows 41–47 — the 2026-08-04 feasibility review

The first review reasoned about jcode from the SDK's surface and the briefing. This one read
`crates/jcode-harness-api-server/src/translate.rs`, `crates/jcode-app-core/src/server/*`,
`src/cli/{args,dispatch}.rs` and the SDK's compiled `dist/*.js`. Rows 41–43 invalidate text that rows
26–40 had just locked; they are recorded rather than edited in silently, for the same reason.

| # | Contested point | Chosen | Rejected | Why |
|---|---|---|---|---|
| 41 | Whether the hard kill works at all | **[F1]** Two-group kill: bridge pgid **and** `daemonPid` from `$JCODE_HOME/servers.json`; `daemonPid` persisted in `runtime.json`; `KillOutcome` gains `daemonPid` + `daemonStopped`; §13 asserts the **daemon** is gone | row 27's bridge-pgid-only kill; relying on the SDK's `shutdown()`, which R12 already declined | See #27. The short version: the daemon `setsid()`s, so the only stop swarm claims to have reached nothing, and the test written to prove it tested the wrong process. This is the review's highest-value finding because it fails **silently and positively** — `survivors: []` on a running agent. |
| 42 | How `accepted` is observed | **[F2]** `sendMessage(..., {waitForAccept:false})`; the adapter watches `message_accepted{session_id}` on the session's own `events()` under swarm's `acceptTimeoutMs` | `waitForAccept:true` + `acceptTimeoutMs` as §4.2 specified | The SDK's `waitForEvent` **resolves** on timeout by design (`client.js:342`: "Resolving on timeout rather than rejecting keeps a missing ack from failing an otherwise healthy turn"), so `sendMessage` returns `undefined` whether or not the ack came. `SubmitReceipt.ack` and V5 — the whole `unknown`-delivery machinery, which is X4, Q5 and success criterion 5 — were being derived from a value that carries no information. The ack timer is also `.unref()`'d, so in an idle process the await can never settle. |
| 43 | Tool-flag delivery | **[F4]** Impossible on this topology, permanently. `bridgeArgv` is documented bridge-process-only; T17's "promoted the day a run observes it" is withdrawn | keeping the escape hatch open pending an empirical run | `--tools`/`--tool-profile`/`--disable-base-tools` are `global = true`, so they *parse* on `api-bridge` — which is why a run would have been read as encouraging. They are inert: the agent lives in the daemon, and `spawn_server` forwards only `--provider`/`--provider-profile`/`--model` to `jcode serve`. A knob that accepts input and does nothing is worse than a missing knob, and "we will promote it when a test observes it" was a promise no test on this path can keep. |
| 44 | Connection topology | **[F5]** Probe connection attached to a long-lived probe session, which also creates sessions and re-attaches; liveness only from a `ping` on an **attached** connection | a permanently unattached "admin" connection | `create_session` and `attach_session` are the same bridge branch and both `subscribe`, so the admin connection silently became attached to whatever it last created — and `detach_session` cannot release it (#10). Worse for health: an unattached `ping` is answered *bridge-locally*, and `list_sessions`/`peek_session`/`archive_session`/`set_retention_policy` are answered from disk, so the admin connection stayed green with a dead daemon. `HealthVM.instances[].ok` was measuring the bridge. |
| 45 | Which history read is safe | **[F8]** `tail()` pinned to `peekSession`; `getHistory` never called, grep-enforced | "both flatten to text-only", the assumption in #13 and §5.4 #12 | `getHistory` does not flatten at all — a block-array message becomes `""`. §5.5's `unknown` protocol compares a prompt digest against that tail; against `""` every turn looks un-landed, which is the one direction Q5 says must never auto-act. The safe read is the one with the less obvious name. |
| 46 | Startup success detection | **[F9]** A child exit **before the connect handshake completes, including exit 0**, is `blocked:'socket_dir'`; `child.pid` liveness is asserted after `hello_ok` before the pgid is recorded | "exit code 0 means the bridge is up" | The bridge `flock`s `<api_socket>.lock` and, if another bridge holds it, prints a message and **exits 0**. Swarm would find the incumbent's socket, connect, and record a pgid for a dead child — then `hardKill` signals a group serving nothing while the real bridge and daemon keep running. The `home:*` lease does not cover this: the lock is keyed on the socket path, not the home. |
| 47 | Honest citations | **[F3][F7][F11][F12][F13][F14][F16][F17]** Unknown efforts are **rejected**, not logged-and-ignored (the ladder decision survives on the `swarm`/`swarm-deep`-are-accepted reason instead); the 10 000-event kill is the SDK's banned `globalEvents()`, not jcode, and the real backpressure path is `write_all` on the bridge's select loop; `tool_input.callId` is always `''`; `setRetentionPolicy` is defence-in-depth because auto-archive defaults off; 0.67.1 is the latest tag and the SDK enforces **no** version floor; `ExecutorRuntimeInfo` is a deliberate subset of `RuntimeInfo`, not shape-for-shape; `listSessions()` is a disk inventory; `setCredential` takes one of six fixed provider ids | the previous wordings | None of these changes a decision; each was a load-bearing *reason* that an implementer would have coded against. Three were actively misleading: "logs and ignores" says error handling on `setReasoningEffort` is pointless; "jcode's buffer kills the stream" points the mitigation at a component that has no such buffer; "shape-for-shape `RuntimeInfo`" invites a cast that drops `healthy`/`sessionId` and, worse, invites treating the cached `routes` as a health signal. |

---

## 13. Definition of done

**Surface and boundaries.** Every symbol in §1.3, §2.2, §3.1–3.5, §4.1, §5.1, §6.1–6.4, §6.7, §6.8,
§7.3, §8 and §9 is exported with exactly the listed signature from the listed entry — this is now a
satisfiable claim, because every type those sections reference is declared in them (#33). A CI test
asserts the export list is **exhaustive in both directions**: nothing listed is missing, and nothing
exported is unlisted. A second test greps `src/presentation.ts` and its emitted `.d.ts` for `import`
and fails on any hit (#34). A CI test imports
`@astrale-os/swarm` with `document`, `window`, `navigator`, `chrome`, `localStorage` and `process`
deleted from `globalThis` and asserts `createSwarmClient`, `encodeFrame`, `decodeFrame` and
`effortLadder` are callable; a second typechecks a fixture importing it under `lib:["ES2022"]` with
no `dom` and no `@types/node` — that failure is a compile error, not a crash, so global deletion is
not enough. `grep -rE "chrome\.|wxt/|comment-core|comment-ui|browser-copilot|temporal-memory"
packages/swarm/src` returns nothing; `grep -rE "node:|\bprocess\b" packages/swarm/src --include=*.ts`
matches only under `src/server/`, `src/cli/`, `src/testing/node/`; `grep -rn
"detachSession\|globalEvents" packages/swarm/src/server` returns nothing (#10, #11).

**Protocol.** `protocolConformance()` enumerates the **34** `SwarmEvent` kinds of §6.4 by name,
asserts each routes to its declared stream, and asserts the 34→22 projection onto
`SwarmClientEvents` is total (#33). It further asserts: `hello` first or close 4004; an unknown client `k`
errors without closing; `sub{from:'snapshot'}` yields a snapshot whose `seq` is the exact
predecessor of the first event; `sub{from:n}` with `n < floor` yields `lagged` and never a gap; no
`seq` gap is observed under any of the 12 scripted interleavings; frames > 1 MiB error. A test
drives 100 000 executor events into a connection accepting 10 frames/s and asserts the log head
advances at full speed, `fleet`/`delegation:*` are never dropped, `attempt:*` is dropped with
`lagged{reason:'backpressure'}`, and re-subscription from snapshot reproduces byte-identical state.
A test kills the server mid-turn, restarts it, and asserts a head resuming from its last `seq`
receives every pre-crash record exactly once and none twice.

**Executor seam.** `executorConformance(factory)` passes against `MockExecutor` in every capability
configuration it declares and against the jcode adapter over `fakeJcodeTransport()`, asserting
declared `ExecutorCapabilities` against observed behaviour so a lying adapter fails CI. The
binary-free resilience matrix runs in CI over the SDK's injectable `Transport`: mid-turn disconnect,
ambiguous send, instance death, **slow-consumer backlog** (the `events()` array is unbounded — the
assertion is that the server's pump never awaits head IO and the array never grows, *not* that a
10 000-event kill fires; that belongs to the banned `globalEvents()` and cannot occur here, [F7]),
sleep gap, two-head conflict, `setReasoningEffort` accepted-then-ignored, mid-turn
`setReasoningEffort` timing out and applying anyway, and `model_info` drift from a foreign writer.
Note the matrix is only viable because `globalEvents()` is banned: it throws `unsupported_transport`
against an injected `Transport`. A **real-jcode
smoke test** runs create → turn → cancel → verify → land against a seeded scratch repo; it is
env-gated in ordinary CI but **required at least once per release**, with its transcript archived —
a release whose only jcode evidence is a skipped test has never executed a single harness call, and
this specification's entire risk sits on the far side of a version floor nobody has crossed (#40).
A stub binary reporting 0.64.2 produces `version_floor` from `doctor` and from `serve` in under one
second, with the fix command in the message, and that message says **`jcode update`** — a test
asserts the string, because `jcode upgrade` errors with `unrecognized subcommand`.

**Spawn and kill.** A test asserts a sentinel variable present in the server's `process.env` is
**absent** from the bridge child's environment (#26). A test asserts the bridge is a process-group
leader (`pgid === child.pid`), that `hardKill` signals `-pgid`, that the **swarm server survives and
answers an intent afterwards** (#27), and that an instance with `pgid === null` refuses `hardKill`
with `capability_absent` rather than falling back to any other target.

**That set is necessary and was never sufficient** (#41, **[F1]**). Three more, in the real-jcode
smoke run because they cannot be faked over a `Transport`:

* `hardKill` resolves `daemonPid` from `$JCODE_HOME/servers.json` by socket path, signals **both**
  groups, and **the daemon process is gone afterwards** — asserted by `process.kill(daemonPid, 0)`
  throwing `ESRCH`, not by `survivors.length === 0`, which the bridge-only kill also satisfied.
* A tool-spawned child (a `sleep` started by the agent's bash tool) is gone after the hard kill.
* An instance whose `servers.json` yields no matching entry returns `daemonPid: null`,
  `daemonStopped: false`, and raises `notice{kind:'capability-absent'}` — a partial stop is never
  reported as a stop.

A test also asserts that a second `api-bridge` spawned against a socket an incumbent already owns
(the `flock` case) is treated as `blocked:'socket_dir'` **despite exiting 0**, and that no pgid is
recorded for it (#46).

**Named behavioural tests** (one each, named after the rule):

* `unknown` never auto-resends with the flag off, and resends only when all four strong-evidence
  clauses hold with the flag on.
* A turn override does not leak: turn 2 issues `setReasoningEffort(delegationDefault)` before send.
* An effort or model change while `ChannelState ∈ {submitting, accepted, streaming, interrupting}`
  returns `turn_in_flight` and produces **zero** executor calls.
* `swarm` / `swarm-deep` are rejected in the client core, at the server intent boundary, and in the
  jcode adapter — three assertions, three layers.
* A second writer on one session is refused with `lease_held`; a stale fence after a handover is
  refused with `stale_fence`.
* A delegation with zero acceptance criteria never reaches `succeeded` without a recorded
  `accept{note}` carrying an actor and a timestamp; `turn_done` alone never reaches `succeeded`.
* A hard spend cap sets `dispatchPaused` and the in-flight turn still reaches `turn_done`.
* A symlink inside an allowlisted root pointing outside it is refused with `workspace_denied`, on
  session creation **and** on a verifier run.
* An unpaired page, a rebound DNS `Host`, and a disallowed `Origin` are each refused (4001/4003) —
  and `POST /pair` **succeeds without `x-swarm-token`** while every other HTTP endpoint but
  `/healthz` refuses without it (#40).
* **A 4 h wall gap with a ≈0 monotonic gap reports "asleep"; a 4 h gap in *both* clocks reports
  "stalled"** (#40). The old assertion had it backwards: equal gaps are the stall signature — the
  process ran for four hours emitting nothing — and if sleep and stall were indistinguishable,
  tracking two clocks (X10) would buy nothing at all.
* On a detected sleep gap, every `streaming` attempt's turn becomes `unknown`, reconciliation runs,
  and no mutating intent is accepted until it completes (X16).
* Three attempts of one delegation run **concurrently**: three scheduler slots, three worktrees,
  three sessions, three evidence bundles; the delegation state is the rollup; `comparison` is
  populated; and a `sendTurn` without `attemptId` is refused `attempt_ambiguous` (#29).
* `{delivery:'interrupt', reasoningEffort:'max'}` is refused `config_not_available_in_mode` **in the
  client core with zero frames written**; the same turn without the field is accepted and records
  `reasoningEffort: 'inherited'` (#30).
* `killSwitch` leaves every delegation non-terminal and every worktree present, and its
  `KillReport.delegationsTerminated` is empty; `cancel{scope:'delegation'}` is the only path to
  `cancelled` (#31).
* A `context-only` turn reaches `ended` on its ack and never enters `running` (#32).
* `retract` on one of three pending interrupts returns all three in `RetractReport` and leaves all
  three at `prepared` — none at `sent` (#36).
* `bucketOf` is total: every (state × stalled × landed) combination maps to exactly one bucket, and
  a delegation in `verifying` is visible in `working` (#37).
* `createDelegation({baseRef:'HEAD'})` stores a 40-char sha; an unresolvable ref refuses
  `base_unresolvable`; no persisted record contains a symbolic ref (#40).
* `in-place` on a dirty tree refuses `workspace_dirty`; with `allowDirty` it proceeds and the record
  carries `{actor, at, note}` plus an audit row (#40).
* A `sensitive` workspace refuses `in-place` and `allowDirty`, and there is no `readonly` value to
  request (#28).
* An audit row survives retention advancement, archive, discard and purge of its delegation; a purge
  appends an audit row of its own (#40).
* `updateDefaults` changes the reconciliation target for the *next* turn and does not touch a turn
  in flight (#35).
* A copilot write tool without a `confirm` never executes, expires after `confirmationTtlMs`, and
  a copilot `cancel` of a user-created delegation is refused outright (#39).
* Images totalling 700 KB decoded are accepted; 701 KB is refused `invalid_spec` in the client core,
  never `frame_too_large` from the transport (#40).
* **`sendMessage` is called with `waitForAccept:false`** and a `SubmitReceipt.ack` of `'accepted'` is
  produced only by an observed `message_accepted` on the session's `events()` stream. Driven over
  `fakeJcodeTransport()`: a transport that never emits the ack yields `ack:'unknown'` and V5 at
  `acceptTimeoutMs`; one that emits it yields `ack:'accepted'`. A grep asserts `waitForAccept` never
  appears in `src/server` (#42) — with it set true the SDK resolves either way and both cases would
  report `accepted`.
* `getHistory` is never called: `grep -rn "getHistory" packages/swarm/src` returns nothing, and
  `tail()` is asserted to route to `peekSession` (#45).
* A mid-turn `setReasoningEffort` is **never issued**: with `ChannelState:'streaming'` the refusal
  produces zero executor calls (already asserted above) — plus a `fakeJcodeTransport()` case proving
  why, in which the reply is withheld until turn end and the SDK raises `HarnessError('timeout')`
  after 30 s while a later `get_history` shows the effort applied anyway (#8, [F10]).
* Two concurrent tools on one session produce correctly attributed `att.tool` input deltas even
  though every `tool_input_delta` arrives with `call_id: ''` (#47, [F11]).
* `HealthVM.instances[].ok` goes false when the daemon dies while the bridge stays up: a
  `fakeJcodeTransport()` that answers `list_sessions` from disk and drops `ping` on the **attached**
  probe connection must produce `ok:false` (#44). Answering an unattached `ping` must not.

**Records, evidence, heads.** Every `TurnRecord` round-trips `EffectiveTurnConfig` through the store
and the wire with `effortConfirmed === false` in every persisted record without exception. An
evidence bundle is reconstructable from the durable log alone after a mid-turn restart and its
`manifest.json` digests match the files on disk. Landing produces a commit or patch that applies
cleanly to the recorded `baseRevision`; a moved base produces `needs-you` with
rebase/report/abandon, never a silent failure. `storeConformance()` passes against the SQLite store
and the in-memory test store, covering write ordering (persist → emit → reply), per-stream head
monotonicity, idempotency-cache hits returning the original response *including the original error*,
retention-floor advancement, and lease fencing-token monotonicity across restart, **and audit-row
survival across every one of those operations**. The CLI head drives `new → say → cancel → verify →
land` over the identical client core **twice**: once with an in-process transport against
`MockExecutor`, and once over **WebSocket against a real `swarm serve`**, authenticating from
`$SWARM_HOME/cli-token` (#38) — the in-process run alone only proves the client core can be called
from Node. `structuredClone()` succeeds on every published view model. `swarm doctor --json` exits
0/1/2 and its blocked reasons are exactly the `PreflightReport` discriminants, each with a
copy-pasteable fix that a test executes.

---

## 14. Deferred review notes

Findings from the 2026-08-04 adversarial and feasibility reviews that were **not** applied, recorded
so the next reviewer does not re-derive them. L1–L3 come from the first review, L4–L5 from the
second. Each is real (or, for L4, was checked and found not to be); each is judged cheaper to carry
than to fix now.

| # | Finding | Disposition |
|---|---|---|
| L1 | **The `M` count is not right-sized for "one power user on one laptop."** 79 **M** requirements, now ≈ 8 160 LOC, three conformance suites, a 100 000-event backpressure test, "12 scripted interleavings" (still never enumerated), Prometheus `/metrics` and three `/debug/*` endpoints. The suggested trade was demoting `/metrics` and two conformance suites to **S**. | **Deferred, partially addressed.** The half of the finding that touched a release gate *was* applied: the seeded demo scenario and the in-product honesty surface now carry LOC lines (§10) and gate 10 depends on both. The demotions are not applied in this pass — `executorConformance` and `storeConformance` are what keep the jcode-specific damage falsifiable, and demoting them to **S** in the same wave that deletes `readonly` and rewrites the spawn would remove the evidence that those rewrites are correct. Revisit after the first real-jcode run: if `/metrics` and `/debug/streams` go untouched during dogfooding, demote both to **S** and enumerate the 12 interleavings or delete the phrase. |
| L2 | **"12 scripted interleavings" is never enumerated.** | **Deferred with L1.** The phrase is unfalsifiable as written. Either the twelve are listed in §13 or the count is dropped in favour of "every interleaving the fake executor can produce". Not fixed here because the list should be written by whoever writes the fake, not guessed by the spec. |
| L3 | **`/debug/*` endpoints and `/metrics` as **M**.** | **Deferred.** Token-gated on loopback, ~40 LOC, and the primary tool for diagnosing the very failures §5.4 catalogues. Cost is low enough that removing them is not obviously a saving. |

| L4 | **The "~10 %" compaction floor was flagged as uncited.** The 2026-08-04 feasibility review could not locate the threshold and proposed dropping the figure from §5.4 #13. | **Rejected — the figure is correct.** `MANUAL_COMPACT_MIN_THRESHOLD = 0.10` (`crates/jcode-compaction-core/src/lib.rs:16`), read by `force_compact_with` (`crates/jcode-base/src/compaction.rs:1095`) and surfaced as `"Context usage too low ({:.1}%) - nothing to compact"`. §5.4 #13 now cites the constant instead of hedging with "~". The *other* half of that finding — that `compact()`'s reply is itself a context-pressure readout — **was** applied to §5.4 #13 and W14, because leaving "context pressure is unavailable" in a locked spec that had just been shown a `Token usage: ~Xk / Yk (Z.Z%)` string would be the kind of claim S8 exists to forbid. W14 stays **W**: prose from a call with a side effect is not a metric. |
| L5 | **`archiveSession`/`listSessions` accumulate stray sessions in the instance inventory.** Every bridge connection gets a fresh daemon session on `subscribe` before `attach_session` resumes the target, and `list_sessions` merges every persisted record under `JCODE_HOME`, so short-lived sessions pile up. | **Deferred; documented, not solved.** §5.1 now labels `listSessions()` a disk inventory and points at swarm's own attempt records as authoritative, which is enough to keep the fleet view correct ([F16]). Actively reaping the strays needs a GC pass keyed on sessions swarm never recorded, which belongs with A12's disk-usage work, not with the executor seam. Revisit if a dogfood run shows `instances/<hash>/home` growing without bound. |

Everything else both reviews raised is applied. Rows 26–40 of §12 record the contested changes from
the first; rows 41–47 record the second's. PRODUCT §14 tabulates the same changes against the product
contract they invalidated.
