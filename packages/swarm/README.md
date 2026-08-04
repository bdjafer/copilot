# @astrale-os/swarm

**A server-scheduled fleet of coding-agent delegations.** You give it an objective, a workspace and
the criteria that would make it *done*. It runs the agent in an isolated git worktree, streams
everything it does into a durable log, and — when the agent says it is finished — **checks for
itself** whether the criteria are met, because the agent's opinion of its own work is not evidence.

The daemon owns the fleet. Heads are disposable: a browser page, a CLI, a second laptop-lid-close
later — they hold nothing but `(stream, seq)`, and the server replays from there. Close the laptop
mid-turn and the work is still running when you open it. Kill the server mid-stream and the head
reconnects, resumes from its cursor, and misses nothing.

```
head (browser / CLI)                 server (one per machine)              executor
────────────────────                 ────────────────────────              ────────
createDelegation ──── intent ─────►  admit ─► worktree ─► session ─────►  jcode api-bridge
                                          │                                    │
  fleet · delegation · attempt:*  ◄── durable log (SQLite, gapless seq) ◄── normalized events
        ▲                                 │
        └── snapshot, then from:<seq> ◄───┘   verifier runs YOUR criteria, not the agent's word
```

Four entry points, one dependency-free presentation seam, and a `swarm` binary. The client core is
**headless**: no DOM, no `node:*`, no framework. It runs in a browser page, in Node, and in a
service worker.

---

## Why the verdict is the whole design

Every "let an agent do it" product hits the same wall: the agent says it is done. There are three
ways to handle that and only one of them survives contact with a fleet you are not watching.

| Approach | What happens at 3 a.m. |
| --- | --- |
| Trust the agent's summary | The agent "fixed" the failing test by editing the test. Your fleet reports six green delegations and one of them is a lie you will find next week. |
| Show the diff and make the human decide, every time | The fleet's throughput is your attention span. Four parallel attempts are four times the reading, and the product is a diff viewer with extra steps. |
| **What swarm does** | Acceptance criteria are declared at create time and executed **by swarm**, in the worktree, after the turn ends. `succeeded` is terminal and carries a permanent discriminator: `verified` (the criteria passed) or `accepted` (a human said so, on the record). An agent never transitions state. |

The second criterion in the seeded demo is the one that earns its place. It is
`git diff --exit-code -- test/slugify.test.js`. An agent that fixes the failing test by rewriting
the expectation satisfies criterion 1 completely — the suite really is green — and fails criterion 2,
because the evidence changed rather than the code.

Delegations with nothing machine-checkable are **first-class**, not second-class: they are created
with the flag, routed to `needs-you` at turn end, and never auto-succeed. Swarm would rather ask you
than guess.

---

## Install

> **Not published yet.** `package.json` says `version: "0.0.0"`, and while it does, this package is
> **unreleased and unpublished** — `npm i @astrale-os/swarm` and `npx swarm …` resolve to nothing on
> the registry. Everything below is runnable **today from a clone**; the registry forms are what
> they will be at the first tagged release. The tarball itself is ready (`publint` clean,
> `npm pack` carries `dist/**`, `dist/types/**`, `src/**`, `README.md` and `LICENSE`) — what is
> missing is a version, not a build.

```sh
# from a clone of this repository
pnpm install
pnpm --filter @astrale-os/swarm build

# at the first tagged release
npm i @astrale-os/swarm
```

Runtime dependencies: `ws`, `ulid`, and `@1jehuang/jcode-sdk` (server entry only). Node ≥ 24 for
anything under `/server` — it uses `node:sqlite`.

### Entry points

| Subpath | Contents | Runtime | Imports |
| --- | --- | --- | --- |
| `@astrale-os/swarm` | the client core, protocol, domain machines, durable-log types | ES2022 — **no DOM, no `node:*`** | `ulid` |
| `@astrale-os/swarm/presentation` | the §6.8 view-model / intents seam a renderer implements | anything | **nothing at all** |
| `@astrale-os/swarm/server` | the daemon: engine, scheduler, verifier, SQLite store, jcode adapter | Node ≥ 24 | `ws`, `node:*`, jcode SDK |
| `@astrale-os/swarm/testing` | `MockExecutor`, conformance suites, fixtures, the seeded demo | dual; only `testing/node/**` names `node:*` | — |
| `swarm` (bin) | `serve` is the daemon; every other verb is a head over the wire | Node ≥ 24 | — |

The split is a boundary, not packaging taste. The root entry must load in an MV3 service worker, so
nothing it imports may reach `src/server/**`; `presentation` emits a chunk with **zero imports**, so
a renderer can depend on the seam without pulling the protocol in.

---

## Quick start 1 — the server

```sh
# from a clone — `npx swarm …` works once the package is published (see Install)
node packages/swarm/src/cli.ts doctor    # 0 healthy / 1 blocked / 2 degraded
node packages/swarm/src/cli.ts serve     # binds 127.0.0.1, prints a one-time pairing code
```

`serve` writes `$SWARM_HOME/cli-token` (mode `0600`, rewritten on every start, deleted on a clean
shutdown) and prints a pairing code valid for five minutes and one use. Everything else is a head:

```sh
swarm status                                        # attempts running/cap, queued, dispatch state
swarm ls                                            # every delegation, by bucket
swarm new "make parseDuration accept 1h30m" --workspace myrepo
swarm say <delegationId> "plan it first" --effort max
swarm verify <delegationId>
swarm land <delegationId> <attemptId> --mode commit
swarm cancel <delegationId> --scope delegation
swarm tokens ls | swarm tokens revoke <id>
```

Filesystem ownership *is* the authentication: a process that can read a `0600` file in your home can
already run `jcode` directly. There is no second secret to manage.

Or embed it:

```ts
import { createSwarmServer } from '@astrale-os/swarm/server'
import { createJcodeAdapter } from '@astrale-os/swarm/server'

const server = await createSwarmServer({
  config,                  // see `$SWARM_HOME/config.json` below
  adapter: createJcodeAdapter({ transport, versionFloor: '0.66.0' }),
  swarmHome: process.env.SWARM_HOME!,
})
await server.listen()
```

### `$SWARM_HOME`

`~/.astrale/swarm` by default, `SWARM_HOME` overrides. Layout: `config.json`, `tokens.json`,
`cli-token`, `runtime.json`, `swarm.db`, and directories for `instances/`, `worktrees/`,
`evidence/`, `skills/`, `log/` — all created `0700`.

```jsonc
{
  "configVersion": 1,
  "port": 7717,
  "workspaces": [
    {
      "workspaceId": "myrepo",
      "root": "/absolute/path/to/repo",
      "label": "my repo",
      "writeMode": "worktree",   // "in-place" writes your tree directly
      "sensitive": false          // true forces "worktree" and refuses "in-place" outright
    }
  ],
  "executor": { "inheritLogins": false }
}
```

A malformed `config.json` is a refusal, not a silent default — a server that quietly ignored a typo
in `workspaces` would refuse every delegation with `workspace_denied` and never say why.

---

## Quick start 2 — the head

The same client core drives the CLI and the browser. The only difference is which transport it was
handed.

```ts
import { createSwarmClient } from '@astrale-os/swarm'

const client = createSwarmClient({
  transport,                      // anything with open/send/close + on{Open,Message,Close,Error}
  clientName: 'my-head/1.0',
  head: 'extension',              // 'extension' | 'cli' | 'test'
  onError: (error) => report(error),
})

// Stores. Every one is a `ReadableStore<T>`: `.get()` and `.subscribe(fn)`.
client.connection.subscribe((vm) => render(vm.status))    // pinned from construction
client.fleet.subscribe((vm) => renderBuckets(vm.buckets)) // nine attention-ordered buckets
client.delegations.subscribe((map) => renderRows(map))

// Detail is opt-in: focus subscribes `delegation:<id>`, a transcript handle subscribes `attempt:<id>`.
client.focus(delegationId)
const transcript = client.transcript(attemptId)   // ref-counted; release() when the view closes

// Intents. None throws for a domain refusal — a refusal is a value (#24).
const created = await client.createDelegation({ idempotencyKey, spec })
if (!created.ok) show(created.error.code)         // 'workspace_denied', 'turn_in_flight', …
```

`fleet` and `server` are pinned from construction and re-subscribed on every `hello_ok`, in that
order — **attention before transcripts**. A head that re-subscribes `attempt:*` first spends its
whole backlog budget on the one stream that is allowed to lag, and learns last which delegation is
asking for it.

### Resume, in one paragraph

Each stream carries a gapless `seq`. After a drop, the head re-subscribes `from:<lastSeq>` and the
server replays `lastSeq + 1 …` exactly once. A stream that never completed its first subscription
resumes from `'snapshot'` instead, because there is no state to apply a delta to. A **gap is a bug**,
not a lag signal: the projection is never founded on a hole, and the stream re-snapshots. Lag is
always explicit — `lagged{fromSeq, reason}` — and only `attempt:*` may lag.

### Rendering through the seam

`@astrale-os/swarm/presentation` declares the view model and intents a renderer needs and imports
nothing, so a renderer never depends on the protocol.

```ts
import type { SwarmPresentation, SwarmViewModel } from '@astrale-os/swarm/presentation'
```

---

## Per-turn controls — the Turn Directive

jcode has no per-message configuration: effort and model are *session state*, set by separate
requests, sticky until changed. Swarm implements per-turn control as a **reconciler** — acquire the
writer lease, drive session state to the directive, send, record what was actually declared on the
turn record.

| Control | Field | Mechanism | Fidelity |
| --- | --- | --- | --- |
| Reasoning effort | `reasoningEffort` | set → send under the writer lease, **idle only**; re-asserted before every turn where it matters | **emulated, unverifiable** |
| Model | `model` | set → send under the lease; confirmed by a `model_info` broadcast | **emulated, confirmed** |
| Structured output | `structured` | the SDK's schema-validated run, with the retry cost shown before send | **true** |
| Delivery — `after-turn` | `delivery` | queued by swarm, sent when the session is idle; the ack is observed on swarm's own stream under swarm's own timeout | **true** |
| Delivery — `next-safe-point` | `delivery` | a soft interrupt injected at the next safe point | **true**; landing unobservable |
| Delivery — `interrupt` | `delivery` | an urgent soft interrupt | **true**; landing unobservable |
| Delivery — `context-only` | `delivery` | persisted without starting a turn | **true** |
| Retract | `retract(turnId)` | queue removal for `after-turn`/`context-only`; for interrupts the only primitive is **session-wide**, and the report names every message it un-delivered | true / session-wide |
| Per-turn budget | `budget` | a swarm-owned deadline; jcode has none | **true** (swarm-side) |
| Idempotency + `expectedVersion` | every intent | swarm-owned; jcode has none | **true** |
| Per-turn tool restriction | — | **does not exist.** See the honesty notes below. | none |

Four rules govern all of it:

1. **Cascade** — fleet default → delegation default → turn override. The effective value is shown
   before send.
2. **Non-sticky.** An override applies to that turn only. When the next directive omits the field,
   swarm reconciles back to the **delegation default**, never to the previous override. This is the
   rule that stops a one-off `max` from silently costing money for the next forty turns.
3. **Effort and model are legal only with `delivery: 'after-turn'`.** The other three modes exist
   only while a turn is in flight, and a config change mid-turn is refused — so the combination is
   always a conflict, never a rare one. Swarm refuses the *field*, not the turn, and records
   `'inherited'`.
4. **Effort is declared, never confirmed.** jcode's bridge discards the daemon's applied value and
   exposes no getter, so `TurnVM.effortConfirmed` is the literal `false`, and the UI must render it.
   `ok` from the underlying call means *accepted*, not *in force*; clamping is undetectable.

The effort ladder is a **closed union derived from provider + model** — and swarm validates against
its own ladder at three layers, because the two values it must refuse (`swarm`, `swarm-deep`, which
mean "max effort plus jcode's internal swarm tool") are values jcode is perfectly happy to accept.
A backend's `ok` cannot serve as validation when the dangerous inputs are the legal ones.

---

## The browser head, under MV3

The reference head is an extension **page**, not the service worker, and that is a ruling rather than
a convenience.

MV3 offers two homes for a long-lived socket and only one of them is honest. The service worker is
event-driven and torn down on idle; WebSocket traffic resets the timer on current Chrome, but
nothing resets it across a browser-managed shutdown, a profile suspend or a laptop sleep. Swarm's
confirmation seam says **no head connected ⇒ no confirmation ⇒ no write** — so a head that can die
mid-turn and re-snapshot on wake is not a head a *human* is watching, and being watched is the entire
authority a confirmation carries. Add `attempt:*`, the highest-volume stream in the protocol and the
only one allowed to degrade, and the worker would be paying to buffer a transcript nobody is looking
at.

So the page is open exactly while a human is watching the fleet:

- Its socket lives as long as the tab. Its resume is the ordinary reconnect — backoff with ±25 %
  jitter, snapshot or `from:<seq>`, idempotent re-send — all of it the client core's.
- The token lives in `chrome.storage.local`, not page memory, so a future badge poller (a
  `chrome.alarms` wake → re-snapshot `fleet` → rewrite the badge) needs no second pairing.
- That poller is **not built**, and the head does not pretend otherwise: with the page closed there
  is no head, and the confirmation rule makes that correct behaviour rather than a gap.
- `host_permissions` needs `http://127.0.0.1/*` and `http://localhost/*` for `POST /pair` only. The
  WebSocket needs none — an extension page's `connect-src` is unrestricted, and the token rides in
  the subprotocol.

Everything the head touches — storage, `fetch`, the socket constructor — is narrowed to structural
types and injected, which is what lets the whole head run in a test runner with no browser.

---

## The real bridge

Swarm drives [jcode](https://github.com/1jehuang/jcode) through its `api-bridge`, and that is the
entire integration surface.

**Floor: jcode ≥ 0.66** — the first version with `api-bridge`. `swarm doctor` reports it and exits
`1` when the floor is not met; the fix string is `jcode update`. (`jcode upgrade` is not a command —
it errors with `unrecognized subcommand`.) Verified against `jcode v0.67.0`, protocol v1.

### Authentication caveats

Swarm never handles your credentials, never prompts for them and never stores them. Authenticate
jcode itself before starting the server. Two things you need to know:

- **`inheritLogins` has no default and swarm writes `false`.** The SDK defaults it to `true`, which
  silently spends your subscription quota. Swarm keeps it required in the config type so it is an
  explicit, persisted setup decision either way.
- **A throwaway `JCODE_HOME` does not isolate your credentials.** This was measured, not assumed: on
  a home containing no credentials at all, the `chatgpt-web` route reports `available: true`, because
  it authenticates from your browser profile under `$HOME`. "Fresh home" therefore does not mean
  "cannot spend". Swarm surfaces this in-product as `honesty.ambient-credentials`.

### What the adapter has to work around

Each of these is a verified limitation with a mitigation in `src/server/executor/jcode.ts`:

| Reality | What swarm does |
| --- | --- |
| The SDK's `waitForAccept` **resolves on timeout** by design, so a send returns identically whether the ack arrived or never came | Never used. `SubmitReceipt.ack` comes from a `message_accepted` event observed on *this session's own* stream under swarm's own timeout — and when it does not arrive, delivery is `unknown` and swarm says so instead of guessing. |
| `create_session` on an attached connection creates nothing and returns the attachment | Sessions are created on a fresh connection, and the returned id is compared. Without the comparison the whole fleet collapses onto one jcode session while reporting distinct ids. |
| `attach_session` never fails on an unknown id — it *manufactures* a session in the bridge's cwd | Adoption compares ids and hard-fails. Both answers otherwise look like success. |
| `tool_input_delta` always carries `call_id: ''` | Input deltas are attributed to the most recent `tool_start` **on that session**; the wire id never reaches a buffer key, which would merge every concurrent tool's arguments into one bucket. |
| `error` frames carry no `session_id` | Attributable only because one connection is bound to one session. A topology change silently breaks it, so the binding is enforced. |
| The daemon `setsid()`s away from the bridge | A hard kill signals **two** groups: the one swarm created for the bridge and the daemon's own, resolved from the instance's `servers.json`. A kill that signals only the bridge stops nothing and *reports success* — the worst outcome available to a panic button. A kill that cannot name the daemon reports itself **partial**, never as a stop. |
| Neither history read is lossless — one returns `content: ""` for block-array messages, the other flattens to text | Swarm records the effective configuration on the turn record itself. If it did not, the answer to "what ran this turn?" would not exist anywhere. |

Run the real-bridge conformance suite against a live jcode:

```sh
SWARM_REAL_BRIDGE=1 pnpm test:real-bridge     # 42 pass, 16 skip — the skips need a model turn
```

The 16 skips are self-classifying: the harness throws a branded error the moment a case reaches for
a scripted turn, so a new conformance case can never silently *not* run against the real bridge.

---

## Honesty notes

These are not disclaimers. Each is a direct consequence of a recorded decision, each was re-confirmed
against a live bridge, and each is surfaced **in-product** as a `NoticeKind: 'honesty'` row rather
than only in this file.

**There is no tool authority.** jcode has no read-only mode. The only lever that exists is a
launch-time tool profile, and it is not merely launch-time — it is undeliverable on this topology:
the flag parses on `api-bridge`, and the bridge does not run the agent. It forwards only
provider/profile/model to the daemon that does. An agent can run any command you can, including
writes outside its worktree.

`writeMode: 'readonly'` was **deleted rather than shipped** for exactly this reason. A workspace
labelled read-only while the agent holds bash with your privileges is a gate that does not gate, and
pretending to gate is worse than admitting we do not — it converts an honest product into a lying one
at the precise moment the user is deciding how much to trust it. A workspace marked `sensitive`
instead forces `worktree`, refuses `in-place` outright, and shows the statement inline at create
time.

**This is isolation by structure, not a sandbox.** What actually constrains an agent: an explicit
path allowlist re-resolved (realpath + symlink guard) on **every** use rather than once at
registration; a git worktree per attempt; a scrubbed child environment delivered by swarm's own
spawn; and the two-group kill. There is no container and no VM, and **network allowlisting is
unenforceable without one — so swarm does not claim it.**

**The server is local-only by construction.** It binds `127.0.0.1`; any other bind requires an
explicit flag and prints a persistent warning. `Host` is validated on every endpoint including the
upgrade, not just on the upgrade, because DNS rebinding does not care which verb it arrives on.
Pairing is token-exempt because requiring the output as input would make pairing impossible — it
still requires a permitted `Origin`, a literal-IP `Host`, a custom header that makes the request
non-simple (defeating form-post CSRF), the one-time code, and a rate limit. The token travels in the
WebSocket subprotocol, never in a URL: query strings land in server logs, browser history and
referrers, and a credential that ends up in a log has been shared.

**Approvals are shipped dark.** `permission_request`/`permission_response` exist in protocol v1, but
the bridge advertises no `permissions` capability and replies `invalid_request`. The queue is
designed and rendered only when a runtime probe says the capability is there.

**The audit trail does not expire.** Every intent, the actor (which head), the timestamp, the
effective config and the result — in its own store, outside the event log's retention, so it survives
compaction and archival. "Who did what, with what effective config" must not expire a month later,
least of all for landed work. It is read over HTTP and is deliberately not a stream.

**Data at rest is plaintext** under your account. Swarm makes no encryption claim.

---

## Try it without risking anything

```sh
pnpm --filter @astrale-os/swarm demo          # seeded repo, real failing test, criteria that run
pnpm --filter @astrale-os/swarm demo:serve    # a real server + real pairing, mock executor
```

The seeded demo exists so that nobody dogfoods on real work on day one. It materializes a throwaway
git repository, runs its suite so you watch the bug fail, then runs both criteria against the cheat
and against the fix. The full walkthrough — including pairing the extension and driving one
delegation against the real bridge — is in [`docs/DEMO-swarm.md`](../../docs/DEMO-swarm.md).

---

## Testing

`@astrale-os/swarm/testing` is not fixtures. It is the contract, as runnable data:

```ts
import { executorConformance, MockExecutor, storeConformance } from '@astrale-os/swarm/testing'

for (const c of executorConformance(harness)) it(c.name, c.run)
```

The suites are **runner-agnostic** arrays of `{ name, run }`, so vitest, `node:test` and bun all
work — and a host embedding swarm can hold its own adapter to the same contract in whatever it
already uses. `MockExecutor` defaults to the **jcode capability row**, so a test that does not opt out
is testing against the shape of the real backend rather than a friendlier fiction, and
`executorConformance` checks the declared row against observed behaviour. That is what makes a lying
adapter fail CI.

`createFakeTransport()` writes frame sequences a correct server never produces — a `seq` gap, a
`snap` before `hello_ok` — which is exactly what the reconnect rules are legislated for.
`createInMemoryTransport()` runs a head against a real embedded server instead.

---

## License

Apache-2.0 © Astrale.
