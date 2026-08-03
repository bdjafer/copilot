# JCode integration briefing (input material — UNVERIFIED)

> Provenance: architecture briefing pasted by the user on 2026-08-03, produced by another
> research session. Treat every claim as a hypothesis to verify against the actual
> installed jcode (v0.64.2 at ~/.local/bin/jcode) and the published SDK
> (@1jehuang/jcode-sdk@1.0.1, published 2026-08-03). Where this document and reality
> disagree, reality wins and the discrepancy must be recorded.

## Summary of claims

- Official TypeScript SDK `@1jehuang/jcode-sdk`; protocol v1 over NDJSON via Unix socket
  (macOS/Linux) / named pipe (Windows). Semver, GA.
- Entry points: `JcodeClient.launch({workingDir, jcodeHome})` (private embedded instance),
  `JcodeClient.connect({socketPath})` (attach to user's interactive instance),
  lower-level `launchInstance()` (instance not bound to one client's lifetime).
- SDK surface: runtime (launch/connect/close/ping/getRuntimeInfo); sessions
  (createSession/listSessions/attachSession/detachSession); retention
  (archiveSession/restoreSession/setRetentionPolicy); conversation
  (sendMessage/run/events/globalEvents); interruption
  (cancel/softInterrupt/cancelSoftInterrupts); history
  (getHistory/peekSession/clear/rewind/rewindUndo); configuration
  (listModels/setModel/setReasoningEffort); context (compact/renameSession); workspace
  inspection (readFile/findFiles/searchText/fileStatus); structured output
  (runStructured with Ajv + bounded corrective turns); credentials (setApiKey/clearApiKey).
- `run(sessionId, prompt, {onEvent})` → turn with text/reasoning/toolCalls/usage; events:
  text_delta, reasoning_delta, tool_start, tool_done, token_usage, background_progress,
  turn_done.
- Authoritative schemas: crates/jcode-harness-api/src/requests.rs and events.rs in
  github.com/1jehuang/jcode.

## Claimed protocol v1 limitations

1. One connection attaches to one session; stateful calls naming another session are
   rejected. Pattern: one private instance per trust domain; one admin connection for
   discovery/creation; one dedicated connection per active session; one writer per
   session; use launchInstance() for pools; singleton lease around each persistent
   jcodeHome (two daemons must not share a state dir).
2. events()/globalEvents() have NO replay — events during a disconnect are lost;
   per-session order only. Parent must persist normalized events immediately; workspace +
   verifier are the source of truth after reconnect.
3. sendMessage() has NO idempotency key (ack carries only session id; one in-flight
   message per connection). Parent must enforce: one in-flight turn/session, writer
   lease, durable intent record + attemptId before sending, reconcile before resending
   after ambiguous disconnect.
4. SessionInfo.status is a weak string — derive execution state from lease +
   message_accepted + tool events + turn_done + transport + workspace evidence +
   parent-owned deadlines.
5. NO native goal API (no goal/acceptance/budget/completion-evaluator/blocked/
   continuation objects). turn_done ≠ objective satisfied.
6. NO native swarm management over the protocol (internal RunSubagent is client-internal).
   Recommended: copilot-managed agents (one JCode session per child), native swarm
   disabled via JCODE_SWARM_ENABLED=false.
7. background_progress events are exposed, but no background.list/tail/wait/cancel for
   the parent. Hard cancellation happens at the sandbox/runtime boundary.
8. Programmatic approvals NOT functional: permission_request/response defined but the
   bridge does not advertise the `permissions` capability and never emits prompts;
   run({autoApprove:false}) creates no barrier today. Authority must be structural
   (container/VM, mounts, network allowlists, secrets scoping, rlimits, kill-the-sandbox).
   Check client.supports('permissions') when it ships.

## Recommended ownership model (from the briefing)

Copilot owns: conversation, delegation, goal+acceptance, attempt, evidence, memory
(the workspace's own memory package; JCODE_MEMORY_ENABLED=false), budgets, verification,
recovery. JCode owns: session transcript, turn, its internal todos/auto-poke. Runtime
owns: workspace/filesystem/processes.

Suggested contracts (bones to adapt, not gospel): DelegationSpec {idempotencyKey,
objective{instruction, acceptance: AcceptanceCriterion[] (command|file|artifact|review),
constraints}, workspace{workspaceId, root, baseRevision, writeMode}, model{provider,
model, reasoningEffort}, authority{filesystem, network, allowedHosts, secretRefs},
budget{maxWallMs, maxTurns, maxInput/OutputTokens}, execution{autoPoke,
nativeSwarm:false, skills}, context: ContextRef[]}; JcodeBinding {instanceKey, sessionId,
workingDirectory, streamEpoch, model}; DelegationRecord versioned with state.

Three separate state machines: DelegationState (queued/provisioning/active/verifying/
waiting/reconciling/succeeded/failed/cancelling/cancelled — turn_done → verifying, NEVER
→ succeeded), ChannelState (detached/attaching/idle/submitting/accepted/streaming/
interrupting/disconnected/closed), DeliveryState (prepared/sent/accepted/running/ended/
unknown/failed — `unknown` is essential).

Parent tools surface: start (idempotent via operationId+idempotencyKey), inspect,
followUp (expectedVersion; delivery: after-turn|next-safe-point|interrupt), wait
(event-driven, until idle|waiting|terminal|event), cancel (turn|delegation|hard), list.
No `complete` tool — only the verifier transitions to succeeded.

Recovery after disconnect: mark attempt unknown → reconciliation lease → reconnect +
attach → getHistory()/peekSession() tail vs persisted prompt digest → workspace
revision/diff → acceptance checks → resume observation | verify | resend only on strong
evidence the message never landed.

Skills: no SDK list/activate/restrict — materialize before session start
(.jcode/skills/<name>/SKILL.md, versioned, digests recorded in the spec; name required
skills in the rendered prompt; project-local .jcode/mcp.json; stdio MCP only today).

Config recommendation: one private instance per trust domain; stable jcodeHome; one
session per delegated task; one connection per active session; one writer lease;
JCODE_MEMORY_ENABLED=false; JCODE_SWARM_ENABLED=false; JCODE_AUTO_POKE=true bounded by
parent budgets; versioned project-local skills; isolated worktree/overlay; parent-owned
event log + task DB; host-owned verifier; hard cancel at sandbox boundary.

## User's additional product requirements (authoritative)

- New module "swarm": a package (client<>server) in this monorepo. The Chrome extension
  connects to a PRIVATE SERVER on the user's machine which embeds jcode, and remotely
  manages an agent-swarm interface. Testable locally (jcode is installed).
- Per-message control of the agent's THINKING EFFORT is a hard requirement (the SDK
  lists setReasoningEffort — verify whether it can vary between messages on a live
  session). This is one example of a whole class of per-turn controls to design
  (non-exhaustive: model, delivery mode, budgets...).
- The swarm must be designed as headless as possible (same inverse-DI philosophy as
  comment-ui: headless state/intents, presentation injected).
- Full step back first: PRD before API; deep-search OSS best practices, then do better.
