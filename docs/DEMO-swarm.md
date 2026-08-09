# Running swarm locally

Three paths, in the order they are safe to take. Path 1 spends nothing and touches nothing. Path 2
runs the real server and a real head, still against a mock agent. Path 3 is the only one that
reaches a model, and it is the only one that can spend your quota or write to your code.

> **Read this first.** Swarm's agents run with your full privileges. There is no read-only mode and
> no per-turn tool restriction — jcode exposes neither, and the one launch-time lever that exists
> never reaches the process that runs the agent. What limits an agent is the workspace allowlist and
> the git worktree it was given, not a permission system. This is PRODUCT §8 S8, and swarm states it
> in-product as `honesty.no-tool-authority` rather than only here.

Prerequisites for paths 1 and 2: Node ≥ 24, `pnpm install` at the repo root, `git` on `PATH`.
Nothing else. Path 3 adds jcode ≥ 0.66 and an authenticated jcode.

---

## Path 1 — the seeded demo, no server (about one second)

```sh
pnpm --filter @astrale-os/swarm demo
```

It materializes a throwaway git repository under your OS temp dir, **runs** its test suite so you
watch the seeded bug fail, then runs both acceptance criteria twice: once against an agent that
"fixed" the failing test by editing the test, and once against the real fix. Then it plays the three
scripted attempts through `MockExecutor` and prints what the executor actually reported.

Nothing here reaches a model, a network, or any path outside the temp dir. The one thing to read
twice is attempt 2: the submission left and no acknowledgement came back, and no return value can
tell that apart from success — so the receipt is `unknown` and swarm asks before re-sending, because
a turn that *did* land would otherwise run twice.

---

## Path 2 — a real server and a real head, on the mock executor

This is the full product: a real daemon on a real socket, real pairing, the real scheduler, the real
verifier, a real SQLite event log. Only the agent is substituted.

### Start the server

```sh
pnpm --filter @astrale-os/swarm demo:serve
```

It prints everything you need:

```
swarm 0.1.0 on 127.0.0.1:7717 — pairing code 8FQ2K7RX (5 min, one use)
SWARM_MOCK_READY {"port":7717,"pairingCode":"8FQ2K7RX","home":"…","workspaceId":"demo", …}
```

The workspace is the same throwaway repo path 1 uses, registered `writeMode: 'worktree'`, and
`$SWARM_HOME` is a temp dir. Both are deleted on Ctrl-C. Nothing under `~/.astrale/swarm` or
`~/.jcode` is read or written.

### Drive it from the CLI

Every verb but `serve` is a head over the wire, authenticating from the `0600` `cli-token` the
daemon wrote into `$SWARM_HOME`. Export the home the banner printed, then:

```sh
export SWARM_HOME=/tmp/…                          # the path from the banner
cd packages/swarm

node src/cli.ts status --port 7717
node src/cli.ts new "fix slugify" --workspace demo --port 7717
node src/cli.ts ls --port 7717
node src/cli.ts say <delegationId> "try the other approach" --effort max --port 7717
node src/cli.ts cancel <delegationId> --port 7717
```

**Expect `swarm new` to land in `needs-you`.** The CLI's `new` sends no acceptance criteria, so
there is nothing for the verifier to check and the delegation reports `unverifiable` with
`needsYou: 'unverifiable-turn-end'`. That is the product working, not a gap: PRODUCT §11 Q1 makes
unverifiable delegations first-class and forbids them from auto-succeeding. Criteria are entered in
the extension's composer, which is what the next section is for.

### Pair the extension

```sh
pnpm --filter exp-spec-extension build
```

Load `packages/extension/.output/chrome-mv3` as an unpacked extension at `chrome://extensions`
(Developer mode → *Load unpacked*), then open the extension's **Swarm** page — it is linked from the
options page, or reachable directly at `chrome-extension://<id>/swarm.html`.

The pairing screen asks for two things:

| Field | Value |
| --- | --- |
| Endpoint | `127.0.0.1:7717` |
| Pairing code | the 8 characters the server printed |

The code is one-use and expires in five minutes; if you miss it, restart the server for a new one.
Pairing is `POST /pair` over loopback HTTP: the code is exchanged for a long-lived token that is
stored in `chrome.storage.local` and thereafter travels in the **WebSocket subprotocol**, never in a
URL. Once paired the screen is never shown again — *Unpair* lives in the fleet strip.

From the swarm page you can create a delegation **with acceptance criteria** (the composer's growing
criterion row), watch turns stream, change reasoning effort for one turn from the follow-up bar, and
land or discard an attempt.

### What to look at

- The **effort ladder** in the follow-up bar changes effort for the *next turn only*. Omit it on the
  turn after and it resets to the delegation default — never to your last override.
- Every turn shows **"declared, not confirmed"**. jcode's bridge discards the daemon's applied value
  and offers no getter, so `effortConfirmed` is a literal `false`. Any UI that rendered effort as
  settled would be inventing the confirmation.
- Kill the server with Ctrl-C while a delegation is running and start it again with the same
  `SWARM_HOME` and port. The head reconnects on its own and resumes from its durable cursor — it
  holds nothing but `(stream, seq)`, and the server replays from there.

---

## Path 3 — the real jcode bridge

**This path reaches a model and spends real quota, and the agent can write to real files.** Do not
point it at work you have not committed.

### 1. Check the executor

```sh
cd packages/swarm
node src/cli.ts doctor
```

`doctor` exits `0` healthy / `1` blocked / `2` degraded. The floor is **jcode ≥ 0.66** — the first
version with `api-bridge`, which is the entire integration surface. If it is too old the fix string
is `jcode update`. (`jcode upgrade` is not a command; it errors with `unrecognized subcommand`.)

### 2. Authenticate jcode

Swarm never handles your credentials and never prompts for them. Authenticate jcode itself, the way
you normally would, before starting the server.

Two things to know before you do:

- **`inheritLogins` is `false` by default and swarm will not change it for you.** The SDK's default
  is `true`, which silently spends your subscription; swarm makes it an explicit, persisted setting
  in `$SWARM_HOME/config.json`. If your logins are not inherited, the agent authenticates from
  whatever the `JCODE_HOME` you point it at has.
- **A throwaway `JCODE_HOME` does not isolate your credentials.** This was measured, not assumed:
  the `chatgpt-web` route reports `available: true` on a home containing no credentials at all,
  because it authenticates from your browser profile under `$HOME`. "Fresh home" therefore does not
  mean "cannot spend". Swarm surfaces this in-product as `honesty.ambient-credentials`.

### 3. Register a real workspace

Write `$SWARM_HOME/config.json` before the first start. The allowlist is the one authority boundary
swarm actually controls, and it is re-resolved (realpath, symlink guard) on every use rather than
once at registration.

```jsonc
{
  "configVersion": 1,
  "port": 7717,
  "workspaces": [
    {
      "workspaceId": "myrepo",
      "root": "/absolute/path/to/your/repo",
      "label": "my repo",
      "writeMode": "worktree",   // an isolated worktree per attempt; "in-place" writes your tree
      "sensitive": false          // true forces "worktree" and refuses "in-place" outright
    }
  ],
  "executor": { "inheritLogins": false }
}
```

### 4. Start the real daemon

```sh
export SWARM_HOME="$HOME/.astrale/swarm"
cd packages/swarm
node src/cli.ts serve --port 7717
```

Same output as path 2 — a pairing code and a `cli-token` — but the executor is now the jcode adapter
against a real `api-bridge`. Pair the extension exactly as above.

### 5. Drive one delegation

Do the first one from the extension, not the CLI, so it carries acceptance criteria and swarm can
give you a verdict instead of an `unverifiable` shrug. A good first objective is small, checkable and
already covered by a test:

- **Objective** — something one test can prove, e.g. *"make `parseDuration` accept `1h30m`"*.
- **Criterion 1** — `command`: the test command that currently fails.
- **Criterion 2** — `command`: `git diff --exit-code -- <path/to/the/test>`, so an agent that fixes
  the test instead of the code fails verification. This is the criterion that earns its place; the
  seeded demo exists to show it firing.

Then watch. When the attempt ends, swarm runs the criteria itself — the agent never reports its own
success — and the delegation lands in `done-unlanded` with a `verified` verdict, or in `needs-you`
with the criterion that failed.

### 6. Land or throw it away

From the attempt timeline: **land** as a commit on a branch or as an exported patch, or **discard**
the attempt and its worktree. Landing is a facet, not a state — a landed delegation is still
`succeeded`.

---

## What is still unproven end to end

Honest gaps, so nobody reads silence as coverage:

- The extension's real `POST /pair` and the real WebSocket handshake (subprotocol echo, the
  `chrome-extension://` origin allowlist, the `4001`/`4003` close codes) are asserted against fakes
  in the extension's own suite and against a spawned server in `packages/swarm/test/e2e-journey.test.ts`
  — but never with Chrome as the client.
- A real streaming transcript at volume: backpressure `lagged` and the keyed reconciler past ~400
  entries have not been driven by a real agent.
- Every path in `packages/swarm/test/real-bridge.test.ts` that would need a model turn is skipped by
  construction (`SWARM_REAL_BRIDGE=1` runs 42 cases against a live bridge and skips 16). Those 16
  are the ones only path 3 exercises.
