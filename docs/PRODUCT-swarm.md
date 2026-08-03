# Headless Local Agent Swarm

## Product contract and status

| Field                 | Value                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------- |
| Contract status       | Normative product contract — locked                                                    |
| Implementation status | None. Design wave; no package source exists yet.                                       |
| Package               | `@astrale-os/swarm`, entries `.` (client core), `./presentation` (seam, imports nothing), `./server` (Node), `./testing` |
| Date                  | 2026-08-04 (amended after adversarial review — §14)                                    |
| Runtime               | Client core: DOM-free, Node-free ES2022. Server: Node.js 24+, macOS/Linux.             |
| Agent runtime         | jcode via `@1jehuang/jcode-sdk@^1.0.1`, harness API protocol v1                        |
| **jcode version floor** | **`>= 0.66.0`** required, `>= 0.67.0` recommended and **currently the latest release**. The SDK spawns `jcode api-bridge`, which does not exist in the installed **v0.64.2** (`error: unrecognized subcommand 'api-bridge'`), so `launchInstance()` fails `startup_failed`. Wave 1 opens with `jcode update` to 0.67.0 — the loop is runnable on this machine today. |
| Heads                 | Chrome extension (wave 1), CLI (wave 1, proof of headlessness)                          |
| Planned consumers     | `exp-spec-extension`, `@astrale-os/browser-copilot` (as tool caller)                    |

This document owns product semantics, boundaries, ownership, priorities, and release gates for the
swarm module. `SPEC-swarm.md` will own exact TypeScript contracts, records, state tables, wire
protocol, defaults, ordering, and errors; it does not silently weaken the locks here.

**MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, **MAY** describe requirement strength. A
normative requirement is not a claim that any artifact satisfies it. Priorities are MoSCoW:
**M** = wave 1 blocking, **S** = wave 1 if the wave holds, **C** = wave 2 candidate, **W** = ruled
out for this product line. Every requirement below carries a decided priority. There are no open
questions in this document; contested points are ruled in §11.

Claims about jcode in this document are **source-read** against SDK tarball `1.0.1`
(`dist/*.d.ts`, `dist/launch.js`), jcode source at branch `master`, and the installed binary's CLI
surface. They are **not runtime-observed**: the installed **v0.64.2 predates `api-bridge`**, so no
harness call in this document has been executed. Two claims *are* runtime-observed and are labelled
as such: `api-bridge` and `upgrade` are absent from 0.64.2's subcommand list, and `update` is
present. Closing that gap is release gate 1a: update to 0.67.0, then re-run §5.1 and re-tag each row
**observed** or **source-read**. Where the input briefing and reality disagreed, reality won and §13
records the correction; §14 records the corrections the adversarial review forced on *this* document.

## 1. Vision

A single developer should be able to put five machine-scale jobs in flight from the browser they
are already working in, and know at a glance which one needs them. Swarm is a private server on the
user's own machine that embeds jcode, plus a headless client core that any head can drive. It turns
a coding agent from a terminal you babysit into a fleet you delegate to: each job carries an
objective, machine-checkable acceptance, an isolated worktree, a budget, and an evidence bundle —
and the machine, never the agent, decides whether it worked.

The wager is that the missing product is not a better agent but a better *contract around* an
agent. jcode owns transcripts, turns, and tool execution and is very good at them; it owns no
notion of an objective, of "done", of a budget, or of what happened while you were disconnected.
Swarm owns exactly those, and owns them durably, so that a closed laptop lid, a dead service
worker, or a crashed daemon is a recoverable event rather than a lost afternoon.

## 2. Personas and scope

One persona, wave 1: **a single power user on one local machine** — the author of the code being
worked on, their own sysadmin, with no support desk and no colleagues sharing the server. They run
3–8 concurrent agents against repos they own, from a Chrome extension on whatever page they happen
to be on, and occasionally from a terminal.

| In scope                                                              | Out of scope (wave 1)                                         |
| --------------------------------------------------------------------- | ------------------------------------------------------------- |
| One OS user, one server process, one machine                          | Multi-tenancy, shared servers, team fleets, RBAC              |
| Local git repositories on allowlisted roots                           | Remote machines, cloud runners, `jcode serve --server-name`   |
| jcode as the only agent runtime                                       | Pluggable agent backends                                      |
| Extension head + CLI head over one client core                        | Mobile, native desktop app, hosted web UI                     |
| Personal subscription quota (Claude Max / ChatGPT Pro) or own API keys | Billing, cost allocation, org quota                           |

Design point: **3–8 concurrent delegations**, default global cap **4** (§F3). The UI is
summary-first with transcripts on demand; it is not a terminal multiplexer.

## 3. Ownership and boundaries

| Concern                                                        | swarm             | jcode                   | browser-copilot        | extension             | temporal-memory      |
| ---------------------------------------------------------------- | ----------------- | ----------------------- | ---------------------- | --------------------- | -------------------- |
| Objective, acceptance criteria, verdict                        | **Owns**          | None                    | May propose            | Renders               | None                 |
| Delegation / attempt / turn records                            | **Owns**          | None                    | Reads via tools        | Renders               | None                 |
| Normalized durable event log + replay                          | **Owns**          | None (no replay at all) | None                   | Consumes              | None                 |
| Session transcript, turn execution, tool calls                 | Mirrors           | **Owns**                | None                   | Renders mirror        | None                 |
| Reasoning effort / model as *applied* state                    | Declares intent   | **Owns** (write-only)   | None                   | None                  | None                 |
| Turn directive (effort, model, delivery, structure, budget)    | **Owns**          | Executes fragments      | May supply             | Composes              | None                 |
| Agent todos, auto-poke, internal goals, native swarm, memory   | Disables          | **Owns** (unreachable)  | None                   | None                  | None                 |
| Workspace, worktrees, base revision, diff, artifacts, landing  | **Owns**          | Read-only inspection    | None                   | Renders               | None                 |
| Verification execution and evidence bundles                    | **Owns**          | None                    | **MUST NOT**           | Renders               | None                 |
| Budgets, concurrency, leases, scheduling                       | **Owns**          | None                    | Constrained by         | Renders               | None                 |
| Process lifecycle, instance pool, credentials to jcode         | **Owns**          | Consumes                | None                   | None                  | None                 |
| Page/DOM context, screenshots, anchors, comment threads        | Consumes by value | None                    | Produces               | **Owns**              | None                 |
| Page-context conversation, browser-side reasoning              | None              | None                    | **Owns**               | Hosts                 | None                 |
| Recall / episodic context bundles                              | Consumes by value | None                    | Consumes               | Hosts                 | **Owns**             |
| Presentation *seam* (`SwarmPresentation` + `SwarmIntents` types) | **Owns** (types only, zero rendering) | None | None | Implements | None |
| Presentation, notifications, badges, keyboard, layout          | None              | None                    | None                   | **Owns**              | None                 |

Locks that follow:

- Swarm MUST NOT import `@astrale-os/temporal-memory`, `@astrale-os/browser-copilot`, or
  `@astrale-os/comment-core` — a browser-WASM package, a browser runtime package, and a DOM package;
  swarm's server is Node and its client is neither. Shared interfaces are **re-declared, never
  imported** (house rule). Memory and page context arrive only as a **detached bundle by value**
  carrying provenance (`snapshotRevision`, `generatedAt`, source id); swarm never queries a store.
- Swarm MUST disable jcode's competing subsystems on every launched instance
  (`JCODE_SWARM_ENABLED=false`, `JCODE_MEMORY_ENABLED=false`) and MUST reject the effort values
  `swarm`/`swarm-deep` (§5.3). `JCODE_AUTO_POKE` stays `true`, bounded by swarm budgets.
- `turn_done` is not success. Only the verifier or an explicit human verdict reaches `succeeded`
  (§4.3). No `complete` intent is exposed to any agent, ever.
- The browser copilot runs in a tab with no filesystem; swarm agents run on the machine with bash
  and write access. This boundary MUST be visible in the UI and MUST NOT be blurred by shared
  chrome, iconography, or a shared "assistant" metaphor.

## 4. Product model

### 4.1 Three planes

| Plane          | Unit         | Owns                                                                             |
| -------------- | ------------ | -------------------------------------------------------------------------------- |
| **Fleet**      | the machine  | concurrency, queue, attention ranking, spend, health, kill switch                |
| **Delegation** | one objective| acceptance, budget, attempts, verdict, evidence, landing, audit                  |
| **Turn**       | one message  | the **Turn Directive**: effort, model, delivery, structure, attachments, context |

An **attempt** binds one delegation to one jcode session and one isolated workspace:
`(delegationId, attemptNo, sessionId, instanceKey, worktree, baseRevision, spec, channel, verdict,
evidence)`. Attempts are append-only; a retry creates attempt *N+1* and never mutates *N*. **Several
attempts of one delegation may be live at once** (Q9): execution state — session, channel, worktree,
turns, budget draw — belongs to the *attempt*, and the delegation holds a rollup over its live
attempts. The scheduler admits **attempts**, not delegations, so N parallel attempts occupy N slots.

### 4.2 State machines

Three, never conflated. **DelegationState** (10, terminal †): `queued`, `provisioning`, `running`,
`waiting`, `verifying`, `needs-you`, `succeeded`†, `failed`†, `cancelled`†, `abandoned`†.
`succeeded` permanently carries `verdict: 'verified' | 'accepted'`. Dispatch suspension is an
orthogonal flag `dispatchPaused`; landing is an orthogonal facet `landed` — the fleet renders
`succeeded && !landed` as **done-unlanded**, the state that silently wastes whole runs.
**ChannelState**: `detached`, `attaching`, `idle`, `submitting`, `accepted`, `streaming`,
`interrupting`, `disconnected`, `closed`. **DeliveryState**: `prepared`, `sent`, `accepted`,
`running`, `ended`, `unknown`, `failed` — `unknown` first-class and user-visible (§9).

**Rollup, normative.** With N live attempts the delegation state is the highest-attention state
among them, in the order `needs-you` > `verifying` > `running` > `waiting` > `provisioning` >
`queued`; it reaches a terminal state only when every live attempt has ended. **`ChannelState` is
per attempt**, never per delegation.

**Fleet buckets are a total function of state and facets** (F1) — every delegation is in exactly one:

| State (+ facet) | Bucket |
| --- | --- |
| `queued` | `queued` |
| `provisioning`, `waiting`, `verifying` | `working` |
| `running`, not stalled | `working` |
| `running`, stalled (W5) | `stalled` |
| `needs-you` | `needs-you` |
| `succeeded` && `!landed` | `done-unlanded` |
| `succeeded` && `landed` | `done-landed` |
| `failed` | `failed` |
| `cancelled` | `cancelled` |
| `abandoned` | `abandoned` |

`dispatchPaused` is a badge on the row, not a bucket — a paused delegation is still whatever it is.

Execution state MUST be derived from the writer lease, `message_accepted`, tool events, `turn_done`,
transport health, workspace evidence, and swarm-owned deadlines. It MUST NOT be derived from
`SessionInfo.status`, whose entire verified vocabulary is `attached | idle | processing` and which
reports `idle` for every non-attached session even while it is running.

### 4.3 The law of done

1. The agent MAY assert completion in prose. That assertion is **never** a state transition.
2. A delegation with ≥1 machine-checkable acceptance criterion reaches `succeeded / verified` only
   when the swarm-owned verifier runs those criteria in the attempt workspace and stores exit codes
   and output as evidence.
3. A delegation with zero criteria is created as `unverifiable`, reaches `needs-you` at turn end,
   and may reach `succeeded / accepted` only by an explicit human verdict recorded with an actor
   and a timestamp. It MUST NOT auto-succeed and MUST NOT be forbidden.
4. `review` criteria (LLM judge) MUST execute in an independent session and MUST NOT share the
   working session's context.
5. Verification results are versioned; re-verification appends, never overwrites.

## 5. Per-turn controls — the Turn Directive (first-class requirement family)

Every message carries a **TurnDirective**. jcode has no per-message configuration: effort and model
are *session state*, set by separate requests, sticky until changed. Swarm therefore implements
per-turn control as a **reconciler**: acquire the writer lease → drive session state to the
directive → send → record the effective configuration on the turn record.

### 5.1 Verified jcode reality (load-bearing)

| Fact | Consequence |
| --- | --- |
| `setReasoningEffort(sessionId, effort)` returns `void`; the daemon's applied value is discarded by the bridge; there is no getter and neither `runtime_info` nor `model_info` carries effort | Effort is **declared intent, never observed state**. `ok` means *accepted*, not *in force*. Clamping (`max`→`xhigh`) is undetectable. |
| Applied immediately when the agent mutex is free (idle); **silently deferred to turn end** when a turn is in flight, with no deferral signal | Effort changes MUST be issued only while the session is idle, serialized by the writer lease. |
| Unknown effort values are logged and ignored on the Anthropic path rather than rejected | Swarm MUST validate against its own closed ladder before sending. |
| `swarm` / `swarm-deep` are accepted effort values meaning "max effort + use jcode's internal swarm tool" | **Banned inputs** (§5.3). `JCODE_SWARM_ENABLED=false` does not block them. |
| `setModel` has the same shape but broadcasts `model_info` to every attached client | Model is observable; effort is not. Drift from another writer is detectable for model only. |
| `sendMessage` has no idempotency key; `message_accepted` carries only `session_id` — not content, not an index | Acks cannot be correlated to a specific send. Swarm owns idempotency (§T13). |
| `sendMessage(noReply: true)` persists content without starting a turn | A genuine fourth delivery mode. |
| `softInterrupt(content, urgent?)` injects at points A–D; the daemon's `soft_interrupt_injected` event is **not translated by the bridge** | Steering lands blind: swarm never learns whether, when, or how many tools were skipped. Must be surfaced as "delivery unconfirmed". |
| `runStructured` is SDK-level (Ajv + bounded corrective retries) | The only **true** per-turn control that needs no reconciliation — and it burns extra turns. |
| Tool allow/deny exists only as process arguments (`--tools`, `--tool-profile`, `--disable-base-tools`) | Instance-scoped, launch-time only. MUST NOT appear as a per-turn dial. |
| `permission_request` / `permission_response` exist in protocol v1 but the bridge advertises no `permissions` capability and replies `invalid_request`; `autoApprove` is a dead branch | Approvals are designed and shipped dark, gated on a runtime probe. |
| `launchInstance()` spawns `spawn(binary, ['api-bridge','--api-socket',sock], { env: { ...process.env, …, ...options.env } })` — **no argv passthrough**, and `env` can only add or override, never remove (`dist/launch.js:430-441`) | Swarm **MUST NOT** obtain its instances from `launchInstance`. A scrubbed child environment is unreachable through it, and `--tools`/`--tool-profile`/`--disable-base-tools` cannot be delivered at all. Swarm owns the spawn (R12). |
| The same spawn passes `detached: false`, so the bridge stays in the **caller's process group** | A `kill(-pgid)` on that group kills the swarm server itself. The hard kill (§5.3.8, F5) requires swarm's own `detached: true` spawn and its own recorded pgid — otherwise the only mitigation for "jcode exposes no background-task control" is a self-inflicted outage. |

### 5.2 Controls and emulation strategy

| ID | Control | Mechanism | Per-turn fidelity | Priority |
| --- | --- | --- | --- | --- |
| T1 | Reasoning effort | set→send under lease, idle only; re-assert before every turn where it matters. **Legal only with `delivery:'after-turn'`** (§5.3.10) | **Emulated**, unverifiable | **M** |
| T2 | Model | set→send under lease; confirmed by `model_info`. **Legal only with `delivery:'after-turn'`** (§5.3.10) | **Emulated**, confirmed | **M** |
| T3 | Structured-output demand (JSON Schema) | `runStructured`, retry cost disclosed to the user before send | **True** | **S** |
| T4 | Attachments (images, screenshots, region captures) | `images` on `sendMessage`/`run` | **True** | **S** |
| T5 | Delivery mode — `after-turn` | swarm queue → `sendMessage` when idle | **True** | **M** |
| T6 | Delivery mode — `next-safe-point` | `softInterrupt(content)` | **True**, landing unobservable | **M** |
| T7 | Delivery mode — `interrupt` | `softInterrupt(content, urgent: true)` | **True**, landing unobservable | **M** |
| T8 | Delivery mode — `context-only` | `sendMessage(noReply: true)` | **True** | **S** |
| T9 | Retract an undelivered message | swarm queue removal for `after-turn`/`context-only`; for interrupts the only primitive is `cancelSoftInterrupts(sessionId)`, which is **session-wide** — retracting one interrupt retracts every pending interrupt on that session, and swarm MUST report the full list it un-delivered | **True** for queued turns, **session-wide** for interrupts | **M** |
| T10 | Per-turn budget override (wall-clock, tool calls) | swarm-owned deadline; no native support | **True** (swarm-side) | **C** |
| T11 | Per-turn context refs (files, threads, memory bundles, prior attempt output) | rendered into the prompt by a named renderer, provenance recorded | **True** | **S** |
| T12 | Per-turn response destination (`silent` / `notify` / `post to thread`) | swarm-side routing | **True** | **C** |
| T13 | Idempotency key + `expectedVersion` on every mutating intent | swarm-owned; jcode has none | **True** | **M** |
| T14 | `autoApprove` / approvals | gated on `supports('permissions')`; rendered unavailable otherwise | dark | **S** |
| T15 | Auto-effort policy (cheap for short follow-ups, high for planning) | opt-in, always overridable, always shown before send | derived | **C** |
| T16 | Per-turn tool restriction | **impossible** — instance-scoped, launch-time only. Worse than instance-scoped in wave 1: the SDK's launcher passes no argv, so swarm can only deliver `--tools`/`--tool-profile` through its **own** spawn (R12), and no swarm run has yet observed those flags on an `api-bridge` process. MUST be stated in-product, never rendered as a dial | none | **M** (as a stated limit) |
| T17 | Launch-time tool profile as an *authority* claim | Deliverable only via R12's own spawn, and **unverified** against 0.67.0's `api-bridge` argv. Until a test observes a denied tool, swarm claims no tool-level authority | none in wave 1 | **C** (promoted to **M** the day a test observes it) |

### 5.3 Normative turn semantics

1. **Cascade**: fleet default → delegation default → turn override. The *effective* value MUST be
   shown before send.
2. **Non-sticky at the product level**: a turn override applies to that turn only. When the next
   directive omits a field, swarm reconciles the session back to the **delegation default**, not to
   the previous turn's override. jcode's stickiness is an implementation detail swarm hides.
3. **Every turn record MUST store the declared effective configuration** — model, effort, delivery
   mode, structure demand, budget, prompt digest, attachment digests, jcode + SDK versions. jcode's
   `getHistory` returns `{role, content}` with all non-text blocks dropped; if swarm does not record
   it, the answer to "what ran this turn?" does not exist anywhere.
4. Effort and model MUST be presented as **declared**, with an explicit in-product statement that
   the applied effort is not observable through protocol v1.
5. The effort ladder is a **closed union derived from provider + model**, excluding `swarm` and
   `swarm-deep`. Ladders: OpenAI/Codex `none|minimal|low|medium|high|xhigh|max`; OpenRouter the same
   minus `max`; DeepSeek `none|low|medium|high|max`; Anthropic model-derived `none|low|medium|high`
   plus `xhigh`/`max` by capability, no `minimal`. Aliases: `off|disabled`→`none`, `default|auto`→
   unset.
6. A directive changing effort or model while a turn streams MUST be **refused with a reason**, not
   silently deferred — deferral is jcode's behaviour and it is invisible. Drift caused by another
   writer (an unrequested `model_info`) MUST be surfaced (**S**).
7. Answering an agent's question MUST use the same affordance as any follow-up (**M**); agents end
   turns with questions constantly and this is the dominant interaction.
8. Interrupts are three distinctly labelled actions (**M**): **cancel turn** (`cancel`, session
   survives), **cancel delegation** (stop dispatch, session survives), **hard kill** (terminate the
   instance and children — the only true stop, since jcode exposes no background-task control). The
   hard kill MUST signal the **process group swarm created for that instance** (R12: swarm spawns
   the bridge itself with `detached: true` and records the pgid). Signalling the server's own group —
   which is what a `launchInstance`-spawned bridge sits in — is a self-inflicted outage and is
   forbidden.
9. `rewind`/`rewindUndo` are exposed as "undo the last N exchanges", reversible within a bounded
   window (**S**); `clear` as "start over from the current code" (**C**); `compact` as "free up
   context", with its sub-10%-usage refusal shown as information, not an error (**C**).
10. **Effort and model are legal only with `delivery:'after-turn'`** (**M**). `next-safe-point` and
    `interrupt` exist *only* while a turn is in flight, and rule 6 refuses config changes in exactly
    those states — so a directive combining them is not a rare conflict, it is always a conflict.
    Swarm refuses the *field*, not the turn: a steering message carrying `model`/`reasoningEffort`
    is rejected at the client core with a reason naming the mode. `context-only` starts no turn, so
    an effort recorded on it would have no referent. All three modes record
    `reasoningEffort: 'inherited'` and `model: 'inherited'` on the turn record — an honest "this
    turn ran under whatever the previous turn set", never a value swarm did not cause.
11. **Kill switch ≠ cancel.** The fleet kill switch (F5) cancels every in-flight *turn*, sets
    `dispatchPaused` fleet-wide, optionally kills instances, and **leaves every delegation in a
    non-terminal state with its worktree untouched** (**M**). Only an explicit
    `cancel{scope:'delegation'}` reaches the terminal `cancelled`. A panic stop that terminalizes
    the fleet costs the user N retries and is the opposite of a panic stop.
12. **Retract is session-wide for interrupts** (**M**). jcode's only primitive is
    `cancelSoftInterrupts(sessionId)`. Retracting one pending interrupt therefore retracts all of
    them on that session; every affected turn returns to `prepared` and the full list is returned to
    the caller and shown. Silently un-delivering messages whose records still read "sent" is
    forbidden.

## 6. Requirements catalog

### 6.1 Environment and preflight (R)

| ID | Requirement | Pri |
| --- | --- | --- |
| R1 | Enforce the jcode version floor (`>= 0.66.0`) at server start; a hang is the forbidden failure mode | **M** |
| R2 | Preflight doctor: binary present, version, `api-bridge` present, socket dir writable, credentials present, ≥1 route `available` — each with a distinct message | **M** |
| R3 | Surface doctor results as a first-run/blocked screen with copy-pasteable fixes | **M** |
| R4 | Pin the embedded instance's jcode version and disable its auto-update (defaults to on for release builds) | **M** |
| R5 | Re-read `getRuntimeInfo` on every reconnect; compare `protocolVersion` + `capabilities`; degrade explicitly on drift | **S** |
| R6 | Probe `supports('permissions')` on every connect; switch the approvals UX from the probe, never from a build-time assumption | **M** |
| R7 | Record jcode + SDK version on every attempt | **S** |
| R8 | Never require Rust, Docker, or a cloud account to run swarm locally | **M** |
| R9 | Instance pool: one private instance per trust domain, stable `jcodeHome`, **singleton lease per home** (jcode keeps pid files there; two daemons on one state dir corrupt it) | **M** |
| R10 | `setApiKey` is instance-global (no session id) — credential scoping is therefore a **pool dimension**; different keys ⇒ different instances. `InstanceKey = provider/credentialScope` in wave 1: the third dimension (`toolProfile`) is deleted until argv delivery is observed (T17) | **M** |
| R11 | Own `setRetentionPolicy` explicitly and default it off; auto-archive otherwise fires as a side effect of *listing* and mutates the fleet view | **M** |
| R12 | **Swarm owns the bridge spawn.** Swarm MUST NOT use `launchInstance()`: it inherits the full server environment, exposes no argv, and leaves the child in the server's process group. Swarm spawns `<binary> api-bridge --api-socket <sock>` itself with an allowlisted env, `detached: true`, and a recorded pgid, then connects the SDK client to the socket. The SDK's `inheritCredentials`/`userJcodeHome` helpers are still used | **M** |
| R13 | Record the spawned instance's pgid and boot id in `runtime.json`, and reclaim/kill through it; a hard kill that cannot name a pgid it created MUST refuse rather than guess | **M** |

### 6.2 Create (C)

| ID | Requirement | Pri |
| --- | --- | --- |
| C1 | Objective: free text, required, editable before first dispatch | **M** |
| C2 | Typed acceptance criteria: `command` (exit 0), `file`, `artifact` (produced + hash), `review` (independent judge), `manual` | **M** |
| C3 | Zero criteria allowed → `unverifiable`; never auto-succeeds (§4.3) | **M** |
| C4 | Workspace: root from an allowlist, base revision, write mode **`worktree` / `in-place`**. `readonly` is **deleted** — jcode has no read-only mode and the only lever (a launch-time tool profile) is undeliverable and unobserved (T17); a mode that does not gate is exactly what S8 forbids | **M** |
| C4b | The head submits a **base ref expression** (`'HEAD'`, a branch, a tag); the server resolves it to a **full sha inside the create transaction** and stores only the sha. Drift detection, verification locking and landing all key off a fixed sha, so an unresolved `'HEAD'` on a record silently disables all three | **M** |
| C5 | Default to an isolated git worktree per attempt, branched from the base revision | **M** |
| C6 | Refuse `in-place` on a dirty tree unless the spec carries an **auditable** override — actor + timestamp, stored on the record, rendered wherever the delegation is | **M** |
| C7 | Model + effort picker seeded from `getRuntimeInfo().routes`, showing `available` + `detail` for unusable routes. The routes MUST reach the head as a view model (`HealthVM.routes`); a picker the head cannot populate is not a requirement, it is a wish | **M** |
| C7b | The head MUST be able to compute the effective per-turn config **without a round trip**: the delegation's spec, its `provider`/`model`/effort defaults, its current attempt id, and the route catalog are all on view models (§5.3.1's "the effective value MUST be shown before send" has no other mechanism) | **M** |
| C8 | Budgets: wall-clock, turns, tool calls, input/output tokens — each with a declared breach action | **M** |
| C9 | Running spend per delegation and per fleet, against a soft cap | **S** |
| C10 | `ContextRef[]` — page URL/title, comment thread, files, screenshot, prior attempt output, memory bundle — each with provenance and a named renderer | **M** |
| C11 | Client-generated `delegationId` + `idempotencyKey`; creation is idempotent and composable offline | **M** |
| C12 | Execution flags per delegation: native swarm off, jcode memory off, auto-poke. Tool profile is **not** a wave-1 flag (T17) | **M** |
| C12b | **Parallel attempts**: `parallelAttempts` (default 1, max 3) on create and on retry. N attempts of one delegation run concurrently, each with its own session, worktree and channel; the delegation state is a rollup (§4.2) | **M** |
| C13 | Skills materialized to `.jcode/skills/<name>/SKILL.md` before session start, digests recorded (no client-facing skill API exists) | **S** |
| C14 | MCP via project-local `.jcode/mcp.json`; transports `stdio`, `http`, `sse`, `streamable-http` are all supported | **C** |
| C15 | Title auto-generated from the objective, editable, mapped to `renameSession` | **S** |
| C16 | Templates: objective + acceptance + budget + model/effort + workspace + skills | **S** |
| C17 | Plan-first mode: first turn produces a plan; the delegation halts at `needs-you` before executing | **S** |
| C18 | Dry-run: show the exact rendered prompt and effective config before dispatch | **S** |
| C19 | Priority + `now` / `queued` dispatch | **S** |
| C20 | Scheduled and recurring delegations | **C** |
| C21 | Tags and labels | **C** |

### 6.3 Watch (W)

| ID | Requirement | Pri |
| --- | --- | --- |
| W1 | Live transcript from `text_delta`; `reasoning_delta` in a separate channel, collapsed by default | **M** |
| W2 | Tool timeline: `tool_start → tool_input_delta → tool_exec → tool_done`, with name, args, output, error, duration | **M** |
| W3 | Derived execution state per §4.2 — never `SessionInfo.status` | **M** |
| W4 | One-line "what it is doing right now" per delegation (latest tool + target) — the fleet's atomic unit | **M** |
| W5 | Stall detection: no event for N seconds while `streaming` → `stalled`, with elapsed time and last activity | **M** |
| W6 | Live diff vs `baseRevision`, per file, expandable — jcode's workspace API is read-only and has no diff | **M** |
| W7 | Token/cost meter per turn and cumulative from `token_usage`, against budget | **M** |
| W8 | Wall-clock elapsed, turn count, tool count, always visible | **S** |
| W9 | Artifact collection: new/changed files, test output, build logs, screenshots, with hashes | **S** |
| W10 | Per-tool renderers keyed by tool name with a raw-string fallback that can never break the view | **S** |
| W11 | Background-progress rendered as its own plane, not merged into the transcript. Note: this event is reverse-engineered by jcode from TUI markdown prose and may vanish without notice | **S** |
| W12 | Follow-tail vs pinned scroll; transcript virtualization | **S** |
| W13 | Multi-delegation watch with preserved scroll per delegation | **S** |
| W14 | Context-pressure indicator | **W** — obtainable only by provoking a `compact` refusal and parsing prose. Swarm states that context pressure is unavailable rather than faking it. |
| W15 | Full-text search within a transcript | **C** |

### 6.4 Verify (VE)

| ID | Requirement | Pri |
| --- | --- | --- |
| VE1 | Swarm-owned verifier runs criteria in the attempt workspace; exit code + stdout/stderr stored as evidence | **M** |
| VE2 | No `complete` intent exposed to any agent; only the verifier or a human verdict reaches `succeeded` | **M** |
| VE3 | Evidence bundle per attempt: diff, acceptance runs, artifacts + hashes, transcript excerpt, tool log, cost, timings | **M** |
| VE4 | `needs-human` reachable when criteria are absent, indeterminate, or the agent is blocked | **M** |
| VE5 | Verification runs on demand and automatically at `turn_done`; results versioned, append-only | **S** |
| VE6 | `review` criteria execute in an independent session/model | **S** |
| VE7 | Acceptance commands are agent-influenced code and MUST run under the same structural constraints as the agent | **S** |
| VE8 | Timeout + resource cap on every acceptance run | **S** |

### 6.5 Attempt, land, archive (A)

| ID | Requirement | Pri |
| --- | --- | --- |
| A1 | Attempt is a first-class append-only record; retry never destroys prior evidence | **M** |
| A2 | Retry = new attempt, fresh session, same spec, optionally edited, with the prior failure injected as context | **M** |
| A3 | **Land**: apply the winning attempt's diff to a target branch — commit or patch export | **M** |
| A4 | Landing conflict handling: base moved → rebase / report / abandon, surfaced as `needs-you` | **S** |
| A5 | Compare attempts side by side: diff, acceptance results, cost, duration, turns. Promoted from **S** — Q9 calls parallel attempts the flagship loop, and a flagship loop with no comparison surface is a retry log | **M** |
| A6 | Branch = fork into a **new delegation** with a **new** session seeded from swarm's normalized transcript (jcode's `rewind` mutates in place and `getHistory` is lossy). The new delegation records its `origin` (source delegation + attempt) so Q2's objective lineage and A5's comparison survive the fork | **S** |
| A7 | Discard: delete worktree, archive session, keep evidence and transcript | **M** |
| A8 | Archive via native `archiveSession` plus swarm-side archive of record and evidence | **S** |
| A9 | Purge: transcript + worktree + evidence, with confirmation and an explicit statement that provider-side data is not purged | **S** |
| A10 | Open a PR | **C** |
| A11 | Export a delegation as one self-contained artifact (objective, config, transcript, diff, evidence) | **C** |
| A12 | Disk-usage view and GC policy for worktrees, transcripts, artifacts | **C** |

### 6.6 Fleet (F)

| ID | Requirement | Pri |
| --- | --- | --- |
| F1 | Dashboard surfaces nine buckets — `needs-you`, `failed`, `stalled`, **`working`**, `queued`, **`done-unlanded`**, `done-landed`, `cancelled`, **`abandoned`** — under a published **total** state→bucket mapping. `working` covers `provisioning`, `running`, `waiting` and `verifying`, because a delegation being verified is the moment the law of done exists for and must not be invisible. Every delegation is in exactly one bucket, always | **M** |
| F2 | Default sort is **attention required**, not recency | **M** |
| F3 | Concurrency caps: global (default 4), per-workspace, per-provider/model | **M** |
| F4 | One writing agent per working tree; worktrees exempt, capped per repo | **M** |
| F5 | Kill-everything switch: cancel every in-flight turn, set `dispatchPaused` fleet-wide, optionally kill instances (through swarm's own pgid, R13). **Worktrees are untouched, no delegation becomes terminal**, and the switch returns a report naming exactly what it stopped. It is a panic brake, not a delete (§5.3.11) | **M** |
| F6 | Health strip: server, instance, socket, provider routes with `available` + `detail` | **S** |
| F7 | Queue with priority and an aging guard against starvation | **S** |
| F8 | Bulk cancel / retry / archive | **S** |
| F9 | Filter and search across delegations | **S** |
| F10 | Cost dashboard: spend today, per delegation, per model, against a soft cap | **S** |
| F11 | Notifications: extension badge count of `needs-you`, level-triggered and derived from a snapshot. "Survives SW death" has a named mechanism: a `chrome.alarms` period of N minutes that wakes the worker, re-snapshots `fleet`, and rewrites the badge, plus a re-snapshot on every worker start. A badge is never assumed to be current across an idle gap | **S** |
| F12 | Server-side OS notification whenever **no socket is attached** — a dead service worker is "no head connected", not "a head that will catch up". The server never waits for a head that may never wake | **S** |
| F13 | Cross-delegation dependencies ("start B when A lands") | **C** |

## 7. The headless principle

`@astrale-os/swarm` (client core) is **stores + intents, zero UI**. It is the same inverse-DI
contract as `comment-ui`: the head calls intents and renders view-models; the core renders nothing.

| ID | Requirement | Pri |
| --- | --- | --- |
| H1 | Four entry points: `.` (client core), **`./presentation`** (the seam — types only, imports nothing, grep-enforced), `./server` (Node), `./testing` (fakes + conformance). The fourth exists because H6 is a requirement and a requirement with no module has no contract | **M** |
| H2 | Client core contains zero `chrome.*`, `wxt/*`, DOM globals, and zero `node:*`. A CI test imports it with those globals deleted; a grep gate enforces it | **M** |
| H3 | State exposed as `ReadableStore<T>`; the interface is **re-declared, not imported** from comment-core or copilot | **M** |
| H4 | Intents, not setters: `createDelegation`, `sendTurn`, `cancel`, `retry`, `branch`, `verify`, `land`, `archive`, `reconcile`, `setFilter`, `focus` | **M** |
| H5 | Derived view-models (`FleetVM`, `DelegationVM`, `TurnVM`, `AttemptVM`, `TranscriptVM`, `DiffVM`, `HealthVM`, `NoticeVM`, `ConnectionVM`); every one is declared in the spec, frozen and `structuredClone`-able; no head ever touches a raw jcode event | **M** |
| H6 | Presentation injected via a `SwarmPresentation` interface declared in `./presentation` — a module that imports nothing, receives one frozen `SwarmViewModel` and one void-returning `SwarmIntents`, and can therefore see neither the client nor the wire. Exactly `comment-ui/presentation`'s shape. The extension still **owns** rendering; the seam exists so it is not the only thing that can render | **M** |
| H6b | A reference presentation (`@astrale-os/swarm-ui`, its own package, as `comment-ui` is to `comment-core`) ships in wave 2 | **C** |
| H7 | Transport injected via `SwarmTransport`: WebSocket in the extension, in-process in tests. **The HTTP+SSE fallback is wave 2** (**C**) — one protocol is specified in wave 1 and there is no second implementation to keep honest | **M** (WS + in-process) |
| H8 | Policy (budgets, leases, verification, concurrency, landing) lives in the server; rendering lives in the head; the client core holds neither. The extension is never the source of truth | **M** |
| H9 | Optimistic local state + server reconciliation, so intents are accepted offline | **S** |
| H10 | **CLI as a second head over the identical client core** — the only real proof that "headless" is true. It MUST be provable against a **real `swarm serve` over WebSocket**, not only against an in-process fake: `serve` writes `$SWARM_HOME/cli-token` (0600) at startup and the CLI reads it, so a local head needs no pairing dance and CI can run the loop end to end | **S** |
| H11 | Server protocol versioned and capability-negotiated; head and server update independently | **S** |

## 8. Security model — right-sized for one local user

The threat model is not a malicious user. It is (a) **any web page in the user's browser** reaching
a localhost port, and (b) **the agent itself**, which runs arbitrary bash with the user's
privileges and whose approval mechanism does not exist.

| ID | Requirement | Pri |
| --- | --- | --- |
| S1 | Server binds `127.0.0.1` only; `0.0.0.0` requires an explicit, documented opt-in | **M** |
| S2 | Authenticated pairing: the server prints a one-time code; the head exchanges it for a long-lived token held in `chrome.storage`. An unauthenticated agent server on localhost is remote code execution for every page you visit | **M** |
| S3 | Origin + extension-id allowlist, a required custom header (defeats simple-request CSRF), and `Host` validation (defeats DNS rebinding) | **M** |
| S4 | Token travels in the WebSocket handshake, never in a URL query string | **S** |
| S5 | Pairing management: list, revoke, rotate | **S** |
| S6 | **Workspace allowlist**: explicit roots; `createSession` outside them is refused; symlink escape refused. This is the one authority boundary swarm actually controls | **M** |
| S7 | Write mode per workspace: `worktree` (default) or `in-place`. **`readonly` is deleted** — see S8. A workspace marked `sensitive` forces `worktree`, refuses `in-place` outright, and renders the S8 statement inline at create time | **M** |
| S8 | **Honest capability statement in-product**: jcode's agent runs arbitrary bash with the user's privileges; programmatic approvals are non-functional in protocol v1; authority is structural. Pretending to gate is worse than admitting we do not — and this is why `readonly` was deleted rather than shipped: it would have marked a workspace safe while handing the agent bash | **M** |
| S9 | Structural authority that **works today**: worktree isolation, allowlisted roots (realpath + symlink guard, re-checked every time), a **scrubbed child env delivered by swarm's own spawn** (R12 — `launchInstance` cannot remove a variable), no secrets in prompts, explicit `inheritLogins`, and a **process-group kill of a group swarm created** (R13). Launch-time tool profile is *not* on this list in wave 1 (T17) | **M** |
| S10 | `inheritLogins` defaults to `true` in the SDK and silently spends the user's subscription quota. Swarm MUST make it an explicit, visible setup decision | **M** |
| S11 | Network allowlisting is stated as **unenforceable** without a container. Swarm MUST NOT claim it | **M** |
| S12 | Secrets never traverse a head; keys are set server-side; secret-shaped strings are redacted from stored transcripts and exports | **S** |
| S13 | Append-only audit log: every intent, actor (which head), timestamp, effective config, result — in its **own store outside the event log's retention**, so it survives compaction, archival and the 30-day `server` stream floor. "Who did what, with what effective config" MUST NOT expire a month after the fact, least of all for landed work | **S** |
| S14 | Approvals queue designed and shipped dark; rendered only when `supports('permissions')` | **S** |
| S15 | Post-hoc danger detection: flag `tool_start` bash commands matching destructive/network patterns, labelled as detection, never as prevention | **C** |
| S16 | Data at rest is plaintext under the user's account; swarm makes no encryption claim | **S** (as a statement) |
| S17 | Multi-user, multi-tenant, or remote-machine operation | **W** |

## 9. Resilience

jcode offers no replay, no idempotency, and no durable client-facing history. Every resilience
property this product has, swarm builds.

| ID | Requirement | Pri |
| --- | --- | --- |
| X1 | Durable delegation / attempt / turn store; a server restart loses no delegation | **M** |
| X2 | Server persists a **normalized event log with its own monotonic sequence and timestamps, written before acknowledging** — swarm's protocol has replay even though jcode's has none | **M** |
| X3 | Head resume = **snapshot, then stream from `seq`**. Never "stream and hope" | **M** |
| X4 | `unknown` delivery is user-visible — "I do not know whether your message landed" — with a Reconcile action and an evidence summary | **M** |
| X5 | Reconciliation: reconnect → attach → compare `peekSession` tail against the persisted prompt digest → workspace revision/diff → acceptance checks → resume observation, verify, or resend **only on strong evidence it never landed** (§11 Q5) | **M** |
| X6 | One writer lease per session, one in-flight turn per session, enforced server-side. `detachSession()` is a verified client-side no-op and MUST NOT be used as a lease release; re-target with `attachSession` | **M** |
| X7 | The server consumes jcode event streams at full speed into its own log; a head can never backpressure jcode. The SDK's fan-in buffer **kills the stream** on overflow rather than dropping | **M** |
| X8 | Head state is derived, never authoritative. On service-worker wake: re-subscribe, re-snapshot; badge recovery is level-triggered | **M** |
| X9 | jcode crash / instance death: supervised restart with backoff; affected attempts → `interrupted` with a resume-with-context offer | **M** |
| X10 | Laptop sleep: budgets track monotonic and wall clock separately. The **sleep signature is wall ≫ monotonic** — both Darwin's `CLOCK_UPTIME_RAW`-backed and Linux's `CLOCK_MONOTONIC` exclude suspend. A large wall gap with a near-zero monotonic gap reports "asleep"; a large gap in **both** clocks is the *stall* signature and reports "stalled" | **S** |
| X11 | Two heads on one delegation: `expectedVersion` on every mutating intent; conflict → explicit "someone else changed this" | **S** |
| X12 | Offline composition: queue locally as `queued-locally`, deliver on reconnect, prompt if older than N minutes | **S** |
| X13 | Workspace drift detection: user hand-edits, base moved while the agent ran | **S** |
| X14 | Every reconnect re-verifies protocol version, capabilities, and current model — not just the socket | **S** |
| X15 | New-session discovery latency (~1 s poll) hidden behind an optimistic local row reconciled on discovery | **C** |
| X16 | **Server-side wake handling.** The server, jcode, and the provider stream all live on the laptop that closes; on resume every session socket is dead and every in-flight turn is genuinely `unknown`. A wall-vs-monotonic divergence greater than `sleepDetectThresholdMs` (default 90 s) MUST: mark every `streaming` attempt's turn `unknown`, mark every channel `disconnected`, run reconciliation (X5) before accepting any mutating intent, and emit one `notice{kind:'resumed-from-sleep'}` naming the gap. X8 covers the service worker and X10 covers accounting; without X16 nothing on the machine reacts to the lid, and success criterion 3 has no mechanism | **M** |

## 10. Non-goals

Explicit, ruled, not deferred-by-omission: multi-user or team fleets; remote-machine or cloud
execution; a hosted web UI; pluggable non-jcode agent backends; container/VM sandboxing and enforced
network allowlists; a general workflow/DAG engine; agent-authored acceptance criteria; a `complete`
capability for agents; reimplementing jcode's transcript, todos, memory, internal goals, or native
swarm; encryption at rest; billing and cost allocation; mobile heads; any claim that swarm prevents
an agent from damaging its own worktree; and becoming a chat product — a delegation is a unit of
work with a verdict, not a conversation that accumulates objectives (§11 Q2).

## 11. Rulings

| # | Question | **Ruling** | Why |
| --- | --- | --- | --- |
| Q1 | What does "done" mean, and who may say it? | `succeeded` is terminal with a permanent discriminator: **`verified`** (verifier passed criteria) or **`accepted`** (explicit human verdict). Unverifiable delegations are **first-class**: created with the flag, routed to `needs-you` at turn end, never auto-succeeding. Agents never transition state. | Verifier-only is correct and, alone, product-hostile — most real objectives have no machine-checkable acceptance. Two verdict kinds keep the state machine at 10 states while making "a human said so" auditable rather than invisible. |
| Q2 | Delegation or conversation? | **Delegation.** The conversation is a property of an attempt. A follow-up on a terminal delegation **reopens** it as attempt *N+1* — same delegation, same objective lineage — reusing the session if it is alive, otherwise a fresh session seeded from swarm's normalized transcript. | The fleet is a list of jobs with verdicts. A chat thread that accumulates objectives has no verdict, no budget boundary, and no comparable attempts — a different product. |
| Q3 | Does swarm land the work? | **Yes**, minimally: commit-to-branch and patch export are **M**. PR creation is **C**. Conflict resolution is never agent-driven; a moved base surfaces as `needs-you` with rebase / report / abandon. | Without landing, `done-unlanded` becomes the fleet's largest state and swarm is a monitoring surface for work that dies in a worktree. Owning git *identity* and review would be a second product; owning `git apply` and a branch is one afternoon. |
| Q4 | Sticky or per-message? | **Per-turn declared, session-reconciled, non-sticky at the product level.** Omission resets to the *delegation* default, not the previous override. Effort is a **control**; auto-effort routing is opt-in and **C**. Effort is recorded as declared and stated as unobservable. | jcode's session-sticky effort with a discarded applied value cannot support a truthful "per-message" claim without a reconciler and an honest label. Resetting to the delegation default is the only rule that prevents a one-off `max` from silently costing money for the next forty turns. |
| Q5 | Who decides to resend on `unknown`? | **Never auto-resend by default.** Auto-action is permitted in one direction only: auto-**resume observation** when evidence shows the turn landed. Resend requires user confirmation, unless the delegation opts into `autoResendOnStrongEvidence` (default **off**), where strong evidence is the conjunction: no recorded `message_accepted`, prompt digest absent from the transcript tail, no workspace mutation since dispatch, and the session is idle. | A duplicated destructive turn is unrecoverable; a confirmation prompt is merely annoying. The asymmetry decides it. At 3 a.m. the user sees one row: "message status unknown — reconcile", with the four evidence lines that produced the verdict. |
| Q6 | How much authority by default? | **Write, inside an isolated git worktree, on an allowlisted root, with a scrubbed child environment, no network claim, and a working hard-kill.** `readonly` is **deleted**, not defaulted: jcode has no read-only mode, the only lever is a launch-time tool profile that swarm cannot yet deliver or observe (T17), and a workspace labelled read-only while the agent holds bash is precisely the fake gate S8 forbids. A `sensitive` workspace instead forces `worktree`, refuses `in-place`, and shows the S8 statement at create time. | Read-only-by-default is safe and useless: the agent cannot do the job, and the product is a demo. This ruling is what makes swarm a tool. Shipping an unenforceable `readonly` would have been worse than either: it converts an honest product into a lying one at the exact point the user is deciding how much to trust it. |
| Q7 | What is swarm when the browser is closed? | **The server is the scheduler; heads are views.** Delegations keep progressing with no head attached. Wave 1: user-launched server with an optional launchd/systemd unit (**S**) and server-side OS notification when no head is connected (**S**). Scheduling and recurring runs are **C**. | "Headless-first" is a lie if closing a tab stops the fleet. This is also what makes the CLI head cheap and the badge purely derived. |
| Q8 | Does the copilot drive the swarm, and may it act unasked? | **Read-only tools unasked** (`list`, `inspect`, `wait` — event-driven, `until: idle \| waiting \| terminal \| event`) — **M**. **Write tools (`start`, `followUp`, `cancel`) require per-call user confirmation** delivered over a named request/response pair on the swarm protocol, and are **S**: the confirmation frame, the `confirmation-required` client event and the `confirm`/`deny` intents are specified in wave 1 (SPEC §6.7) so the ruling has a contract, but the write half may slip to wave 2 without reopening the ruling. Copilot has **no** `complete`, `verify`, `land`, or `retry-with-edited-spec`. Copilot delegations draw on the fleet budget under a copilot sub-cap. A copilot `cancel` of a user-started delegation is refused. | A page-context conversation that can spawn processes writing to your repos needs a human in the loop at exactly one place, and creation is that place. But a confirmation requirement with no frame that can carry a confirmation to a human is a ruling with no mechanism — so the mechanism is specified even where the tools are staged. |
| Q9 | How many concurrent agents? | **Design point 3–8; hard default 4.** UI is summary-first, transcript-on-demand. Attention budget per agent is one line in the fleet, expanded on focus. **Parallel attempts are wave 1 and structural, not sequential retries**: `parallelAttempts` (default 1, max 3) admits N attempts of one delegation to N slots, each with its own session, worktree and channel; delegation state is a rollup over live attempts. **Compare attempts (A5) is therefore M, not S.** | On one laptop, worktrees, CPU, and provider rate limits bind long before 30. Committing to a number is what lets the dashboard be a triage list rather than a wall of terminals. And if "3 parallel attempts at one objective" is the flagship behaviour that justifies the name, it cannot be a delegation with one `currentAttempt` and one channel — that machine can only run attempts in sequence, which is a retry log with better wording. |
| Q10 | What about a delegation whose world moved on? | `baseRevision` is a **lock for verification and a hint for landing**. Drift detection is **M**. On drift the attempt is annotated `stale-base`; its evidence stays valid and is labelled "verified against a base that has moved"; landing offers rebase / report / abandon. Attempts are **never** silently invalidated. | With long-running agents this is the normal case. Invalidation throws away real work; silence produces a diff that lies. Annotation is the only honest option. |
| Q11 | Who watches spend, and what happens at the cap? | Soft cap warns; **hard cap pauses dispatch** and never cancels a turn mid-flight. Caps are per fleet and per delegation. | `inheritLogins` defaults to spending the user's own subscription quota. A mid-turn kill wastes the tokens already spent — pausing dispatch is the only breach action that saves money. |
| Q12 | Is the transcript the product or the evidence? | **Evidence.** It is retained for the delegation's life, exportable (**C**), searchable (**C**), and it is not the primary view. The primary view is state + diff + evidence. | Decides the whole investment split: virtualization and renderers are **S**, search and export are **C**, and the fleet view never renders a transcript to answer "what is happening". |
| Q13 | Does swarm ever manage a remote machine's jcode? | **No** (**W**). Local, single machine, `127.0.0.1`. | Every right-sizing decision in §8 depends on it. Remote operation would invalidate the pairing model, the workspace allowlist, and the plaintext-at-rest statement simultaneously. |
| Q14 | Who spawns the jcode bridge? | **Swarm does** (R12). `launchInstance()` is used for nothing but its credential helpers. | It hard-codes `{...process.env}` (additive only), passes no argv, and leaves the child in the caller's process group. Three of §8's structural-authority claims — scrubbed env, tool profile, working hard kill — are unreachable through it, and the third is actively dangerous: killing that process group kills the swarm server. Owning ~20 lines of `spawn` buys back the entire authority model. |
| Q15 | Where does the presentation seam live? | **A fourth entry, `./presentation`** — types only, importing nothing, grep-enforced, mirroring `comment-ui/presentation`. The extension still owns rendering; the reference presentation is a separate package in wave 2. | H6 was a **M** requirement naming an interface that appeared three times and was declared zero times. Either the seam gets a module or the requirement gets deleted; a locked contract cannot hold a requirement with no contract. Adding a fourth entry breaks H1's "three" — so H1 is amended here rather than quietly violated in the spec. |
| Q16 | What does the kill switch destroy? | **Nothing.** It cancels in-flight turns, pauses dispatch fleet-wide, optionally kills instances, and leaves states non-terminal and worktrees intact. Only `cancel{scope:'delegation'}` reaches `cancelled`. | The panic button and the delete button cannot be the same button. A fleet-wide stop that terminalizes every delegation costs the user N retries at the exact moment they were trying to stop losing work. |
| Q17 | Do per-turn effort and model compose with steering? | **No.** They are legal only with `delivery:'after-turn'`; the other three modes reject the field and record `inherited`. | `next-safe-point` and `interrupt` exist only mid-turn, which is precisely when a config change is refused — so the combination is never merely unlucky, it is always impossible. `context-only` starts no turn, so a recorded effort would name nothing. Saying so is one table row; discovering it is a support thread. |
| Q18 | Can the head compute the effective config it must display? | **Yes, locally.** The delegation spec, its provider/model/effort defaults, its live attempt ids and the route catalog are all on view models (C7, C7b). | §5.3.1 makes "show the effective value before send" normative twice. If the head must ask the server what it is about to send, the requirement is not implementable in the composer, which is where it matters. |
| Q19 | When does the machine notice it slept? | **On wall-vs-monotonic divergence > 90 s** (X16), before any mutating intent is accepted. | The server sleeps with the laptop. Handling sleep only in the service worker (X8) and the budget accounting (X10) leaves the component that owns every socket doing nothing about the event, while success criterion 3 promises the opposite. |
| Q20 | How long does the audit survive? | **Longer than everything else.** Audit rows live outside the event log's retention and are never GC'd by the `server` stream's 30-day floor. | S13's value is answering "who did this, with what config" about work that landed months ago. An audit that expires before the code review does is a log, not an audit. |

## 12. Success criteria

**Product success (dogfood, wave 1).** The author runs real work through swarm for two weeks and:
(1) routinely holds 3+ delegations in flight without opening a terminal; (2) knows within five
seconds of opening the fleet which one needs them; (3) never loses a delegation to a laptop sleep,
a service-worker death, or a jcode crash; (4) never finds a finished-but-unlanded delegation more
than a day old; (5) never asks "did my message land?" without the UI already answering; (6) can
state, for any completed delegation, what verified it and what it changed, from the record alone.

**Release gates.** Swarm MUST NOT be described as stable until all of the following hold:

1. Version floor, preflight doctor, and capability probes ship; a machine with jcode 0.64.2 gets an
   actionable upgrade message within one second, never a hang.
2. The client core imports clean with `document`, `window`, `navigator`, `chrome`, and `node:*`
   absent, and a grep gate over the core returns nothing.
1a. jcode on the development machine is **≥ 0.67.0** and every §5.1 row is re-tagged **observed** or
   **source-read**. Shipping a version floor whose far side has never been executed is not a
   verified product.
3. A **CLI head** drives create → turn → cancel → verify → land over the identical client core,
   **twice**: once in-process against `MockExecutor`, and once over a **WebSocket against a real
   `swarm serve`**, authenticating from `$SWARM_HOME/cli-token`. The in-process run alone proves
   nothing about headlessness against a real server.
4. A scripted **fake jcode** over the SDK's injectable `Transport` drives the resilience matrix in
   CI with no binary: mid-turn disconnect, ambiguous send, instance death, event-buffer overflow,
   sleep gap, two-head conflict. A **real-jcode smoke test** runs the same loop against a seeded
   scratch repo; it is env-gated in ordinary CI but **required at least once per release**, with its
   output archived as evidence. A release whose only jcode proof is a skipped test is not released.
5. A named test asserts each of: `unknown` never auto-resends by default; a turn override does not
   leak into the next turn; an effort or model change during a live turn is refused, not deferred;
   `swarm` / `swarm-deep` are rejected before reaching jcode; `detachSession` is never used as a
   lease release; a second writer on one session is refused by the lease.
6. Every turn record round-trips its declared effective configuration, and an evidence bundle is
   reconstructable from the durable log alone after a server restart mid-turn.
7. The fleet never shows `succeeded` for a delegation with zero acceptance criteria and no recorded
   human verdict.
8. Landing produces a commit or patch that applies cleanly to the recorded base; a moved base
   produces `needs-you`, not a silent failure.
9. Pairing, origin/`Host` validation, and the workspace allowlist each have an adversarial test: an
   unpaired page, a rebound DNS name, and a symlink escape are all refused.
10. S8, S10, and S11 are visible in the product, not only in this document, and a demo scenario runs
    the whole loop against a seeded scratch repo so no one dogfoods on real work on day one. Both
    the in-product honesty surface and the seeded demo carry an explicit LOC line in SPEC §10 —
    a release gate with no budget is a release gate that slips.
11. Three attempts of one delegation run **concurrently** in a test, occupy three scheduler slots,
    produce three worktrees and three evidence bundles, and are rendered side by side (A5).
12. The fleet kill switch leaves every delegation non-terminal and every worktree on disk, and its
    report names what it stopped; a separate test asserts `cancel{scope:'delegation'}` is the only
    path to `cancelled`.
13. The hard kill terminates a bridge and its children and the swarm server is still serving
    afterwards — asserted by a test that kills an instance and then completes an intent.

## 13. Corrections to the input briefing

`docs/research/jcode-briefing.md` is input material, not truth. Binding corrections: protocol docs
live on branch `master`; MCP supports `stdio`/`http`/`sse`/`streamable-http`, not stdio only; a
`skill_manage` tool exists (agent-facing, still no client API); jcode has rich **native goal and
swarm subsystems**, unexposed by the bridge rather than absent — swarm therefore *declines* a native
implementation rather than filling a void.

Missed entirely, all load-bearing above: the **v0.66.0 floor**; `swarm`/`swarm-deep` as reachable
effort values; `detachSession()` as a no-op; invisible soft-interrupt landing; discarded applied
effort; `background_progress` scraped from TUI prose; `getHistory` dropping every non-text block;
`sendMessage(noReply)` as a fourth delivery mode; instance-global `setApiKey`; `inheritLogins`
defaulting to true; `setRetentionPolicy` applying as a side effect of listing sessions; and — found
only by the adversarial review — `launchInstance()`'s **additive-only `env`, absent argv, and
`detached: false`**, which between them made three of §8's structural-authority claims
unimplementable and the fourth suicidal (§14, Q14).

## 14. Amendments from adversarial review (2026-08-04)

The review's jcode research stood; the product line did not. What changed, and what it invalidated:

| Was | Now | Invalidated |
| --- | --- | --- |
| Instances come from `launchInstance()` | Swarm spawns `api-bridge` itself, `detached: true`, allowlisted env, recorded pgid (R12, R13, Q14) | S9's "scrubbed child env" and "launch-time tool profile"; the hard kill in §5.3.8, F5 and SPEC §5.5 |
| `InstanceKey = provider/credentialScope/toolProfile`; `ExecutionSpec.toolProfile` | `InstanceKey = provider/credentialScope`; tool profile is **C** and unclaimed (T17) | R10, C12, SPEC §5.3 and decision #20 |
| `writeMode: 'readonly' \| 'worktree' \| 'in-place'`; `sensitive ⇒ readonly` | `'worktree' \| 'in-place'`; `sensitive ⇒ worktree`, `in-place` refused (S7, Q6) | C4, S7, Q6, SPEC §3.1 and §7.3 |
| One live attempt per delegation | `parallelAttempts` (1–3); scheduler admits attempts; delegation state is a rollup; A5 is **M** (C12b, Q9, §4.1–4.2) | §4.1, §4.2, Q9, A5, SPEC §3.1, §3.3 and §7.1 |
| `SwarmPresentation` named, never declared | Fourth entry `./presentation`, seam declared, reference presentation is a separate wave-2 package (H1, H6, H6b, Q15) | H1's "three entries", §3's ownership table |
| Kill switch reaches `cancelled` | Kill switch never terminalizes; only `cancel{scope:'delegation'}` does (F5, §5.3.11, Q16) | F5, SPEC D17 |
| Effort/model compose with any delivery mode | `after-turn` only; other modes record `inherited` (T1, T2, §5.3.10, Q17) | §5.2, §5.3, SPEC §4.3 |
| Fleet buckets: 8, partial | 9 buckets under a published total mapping, `working` + `abandoned` added (F1, §4.2) | F1, SPEC §6.2 |
| Sleep = "a long gap"; the named test asserted equal gaps | Sleep = wall ≫ monotonic; equal gaps are a **stall**; X16 adds server-side wake handling (X10, X16, Q19) | X10, SPEC §13's sleep test |
| Retract targets one turn | Interrupt retraction is session-wide and reports every message it un-delivered (T9, §5.3.12) | T9, SPEC §6.3 |
| Audit rides the 30-day `server` stream | Audit has its own store, exempt from retention (S13, Q20) | S13, SPEC §2.3 and §3.5 |
| CLI head proven in-process only | CLI proven over WS against a real `serve` via `$SWARM_HOME/cli-token` (H10, gate 3) | H10, SPEC §7.1 and §13 |
| Copilot ruling with no contract | Confirmation frames, events and intents specified; write tools **S** (Q8) | Q8, SPEC §6.3 |
| Badge "survives SW death" | `chrome.alarms` re-snapshot; server notifies whenever no socket is attached (F11, F12) | F11, F12 |
| Node 20+ | Node 24+ everywhere (`node:sqlite`) | §1, SPEC §1.1 |
| HTTP+SSE fallback transport (**M**) | Wave 2 (**C**); WS + in-process only in wave 1 (H7) | H7 |
| "Verified against the installed binary" | Source-read, not runtime-observed; 0.67.0 is released; gate 1a and a required real-jcode run | §1, gate 4 |

## Final product statement

Swarm is a headless, local-first agent fleet: a private Node server that embeds jcode and owns the
objective, the acceptance, the budget, the evidence, the durable event log, and the verdict; plus a
DOM-free client core of stores and intents that any head — the Chrome extension today, a CLI beside
it — can drive without becoming the source of truth. It exposes per-turn control over effort, model,
delivery, and structure by reconciling a session-sticky protocol turn by turn, and it says out loud
which of those controls it can confirm and which it can only declare. It never lets an agent tell
you it is done.
