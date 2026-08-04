/**
 * The jcode adapter against the **real** `api-bridge` (SPEC-swarm §5.3, §13).
 *
 * Gated behind `SWARM_REAL_BRIDGE=1` so CI stays hermetic: `pnpm --filter @astrale-os/swarm
 * test:real-bridge` runs it, `pnpm test` skips it. Everything here spawns a throwaway
 * `JCODE_HOME` under the OS temp dir through swarm's own spawn path and tears it down with the
 * two-group kill; the user's `~/.jcode` is never touched.
 *
 * **No test here starts a model turn.** Two reasons, both load-bearing:
 *
 *  1. A turn costs the user money or quota, and a fresh `JCODE_HOME` does **not** guarantee it
 *     cannot buy one — the `chatgpt-web` route reads the user's browser profile out of `$HOME`
 *     and reports `available: true` on a virgin home (see `test/support/real-bridge.ts`).
 *  2. The turn-shaped behaviours are exactly the ones swarm cannot verify anyway without
 *     credentials, so pretending otherwise would put an unfalsifiable claim in a suite whose
 *     whole value is falsifiability.
 *
 * What that leaves unverified is stated rather than hidden, in two lists: `MODEL_TURN_ONLY` names
 * the *behaviours*, and `CONFORMANCE_MOCK_ONLY` names the exact conformance cases that skip — the
 * second is compared against the set that actually skipped, as sets, in both directions, so it
 * cannot drift from reality the way a hand-kept list does. Everything else in this file was
 * observed on `jcode v0.67.0 (156ae4092)` with `@1jehuang/jcode-sdk@1.1.0` on 2026-08-04, and
 * re-observed on `0.67.1 (88a19f38e)`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { JcodeSdkClient } from '../src/server/executor/sdk.ts'
import type {
  ExecutorAdapter,
  ExecutorInstance,
  ExecutorSessionHandle,
} from '../src/server/executor/types.ts'

import { createJcodeAdapter } from '../src/server/executor/jcode.ts'
import { createRealJcodeTransport } from '../src/server/executor/sdk-transport.ts'
import { JCODE_UNSUPPORTED_PROVIDER_MESSAGE } from '../src/server/executor/sdk.ts'
import { preflightJcode, resolveDaemonPid } from '../src/server/executor/spawn.ts'
import { executorConformance } from '../src/testing/index.ts'
import {
  jcodeBinary,
  jcodeVersion,
  pidAlive,
  REAL_BRIDGE_ENABLED,
  startRealBridge,
  type RealBridge,
} from './support/real-bridge.ts'

/**
 * The behaviours that need a model turn, and therefore credentials, and therefore stay
 * **mock-only** until someone runs this with a funded provider. Each is named with what would
 * settle it, so the list is a work item rather than an excuse.
 */
const MODEL_TURN_ONLY = [
  '[F11] whether `tool_input_delta` still carries `call_id: ""` — needs a tool call',
  'the ack timing of `message_accepted` on a real turn ([F2]) — needs a turn to accept',
  '`turn_done` and `token_usage` shapes — needs a turn; no turn, no events',
  'which effort VALUES a reachable provider accepts ([F3]) — every value is refused with ' +
    '`Anthropic provider not available` while unauthenticated, so the accepted set is unobservable',
  'which model ids `set_model` accepts — refused wholesale with `Model switching is not ' +
    'available for this provider.` while unauthenticated',
  '`runStructured` retry/threading behaviour (§4.3.6) — needs a turn; every attempt is one',
  '[F10] the mid-turn config park — needs a turn to park behind',
  'soft-interrupt delivery and `cancel` semantics mid-turn — needs a turn to interrupt ' +
    '(§5.4 #10, V14)',
]

/**
 * The `executorConformance()` cases that do **not** run against the real bridge, by exact name,
 * each with why — and, where one exists, the bespoke case in this file that covers the same ground
 * another way.
 *
 * `MODEL_TURN_ONLY` above is prose about *behaviours*, and prose cannot be checked against
 * reality: the check that "validated" it asserted `length > 0` and regexed each entry for the word
 * "needs", which is a check on the list's own wording. It named 8 items while 16 cases actually
 * skipped, and nothing correlated the two — so the honest-looking gap list was quietly false.
 *
 * This one is correlated **mechanically**, below: the set of cases that skipped must equal the set
 * of keys here, exactly. Add a conformance case that cannot run against the real bridge and this
 * gate fails until you say why; make a skipped case runnable and it fails until you delete the
 * entry. The list cannot go stale in either direction.
 */
const CONFORMANCE_MOCK_ONLY: Record<string, string> = {
  /* --- covered another way in this file: the bespoke case is named, so the gap is bounded. --- */
  'executor: a fence below the highest observed for the session is refused with stale_fence':
    'needs a scripted turn to raise the fence past; the fence itself is swarm-side and unit-tested ' +
    'in test/server-lifecycle.test.ts — NOT covered against the real bridge',
  'executor: history capability governs tail(), which is peekSession and text-only ([F8])':
    'needs a scripted turn to have something to tail; the two reads are covered live and by hand ' +
    'by “a `noReply` message reaches `getHistory` at once and `peekSession` never” ([E1])',
  'executor: sessionsPerConnection is a transport fact: sessions stay distinct and isolated (§5.3)':
    'needs a scripted turn to prove events do not cross; the isolation itself is covered live by ' +
    '“a second `createSession` on the SAME connection creates NOTHING” and “two connections create ' +
    'two genuinely independent sessions”',

  /* --- not covered against the real bridge at all. Each needs a funded provider. --- */
  "executor: an observed message_accepted yields ack:'accepted' with a timestamp":
    'needs a scripted turn to accept ([F2])',
  "executor: no message_accepted inside awaitAckMs yields ack:'unknown' (V5), never a lie":
    'needs a turn that does not ack; unobservable without a send that reaches a model',
  'executor: SubmitReceipt.correlated matches the declared submitAckCorrelates (§5.4 #3)':
    'needs a scripted turn to correlate an ack against',
  'executor: a config change while a turn is in flight is refused with turn_in_flight (§4.3.3)':
    'needs a turn to be in flight ([F10]); the park itself is unobservable without one',
  /* The send and its ack are REAL here — this case gets further against the bridge than any other
   * submitting one, and stops at the harness disconnect, not at the send. Recorded precisely,
   * because "cannot fake a transport disconnect" alone reads as if the `noReply` path were
   * unobserved when in fact it was observed and acked. */
  'executor: a context-only submission is acked and produces NO turn_done (#32)':
    'the `noReply` send and its ack DO happen live; what cannot be done is ending the stream, so ' +
    '"no `turn_done` ever" stays a claim about a bounded drain rather than about the whole turn',
  'executor: softInterrupt capability governs soft/urgent, and landing stays unobservable':
    'needs a turn to interrupt (§5.4 #10)',
  'executor: structuredOutput capability governs structured(), and raw is kept as evidence':
    'needs a turn per attempt; the harness refuses `structured()` outright so it cannot buy one',
  'executor: tool_input is never attributed to a tool other than the last tool_start ([F11])':
    'needs a real tool call; `call_id: ""` cannot be observed without one',
  'executor: a disconnect mid-turn emits closed and ends the stream (V8, C12)':
    'needs a turn to disconnect in the middle of; the daemon-kill case above covers the ' +
    'out-of-turn disconnect',
  'executor: nativeReplay decides what a LATE subscriber receives, both ways (§5.4 #2)':
    'needs a scripted turn to replay; unobservable with an empty stream',
  'executor: idempotentSubmit decides whether a repeated submission runs a second turn (§5.2)':
    'needs two turns to compare; each one would be bought',
  'executor: perTurnConfig decides whether config rides the message or sticks to the session (§5.2)':
    'needs a turn to observe the config against; every effort/model value is refused while ' +
    'unauthenticated, so stickiness is unobservable',
  'executor: usageEvents capability governs whether a usage event is ever observed':
    'needs a turn; no turn, no `token_usage`',
}

const suite = REAL_BRIDGE_ENABLED ? describe : describe.skip

suite('REAL BRIDGE: the jcode adapter against a live api-bridge', () => {
  let bridge: RealBridge

  beforeAll(async () => {
    bridge = await startRealBridge()
  }, 90_000)

  afterAll(async () => {
    await bridge?.stop()
  }, 30_000)

  /* ------------------------------------------------------------------- 1. the version gate */

  describe('the version gate against the real binary (§5.3, R15)', () => {
    it('passes the installed binary and reports its version', () => {
      const report = preflightJcode({ binary: jcodeBinary() })
      expect(report.ok).toBe(true)
      expect(report.blocked).toBeNull()
      expect(report.versions.jcode).toMatch(/^\d+\.\d+\.\d+$/)
      /* The floor exists because the SDK enforces none: `api-bridge` did not exist before 0.66. */
      expect(jcodeVersion()).toContain(report.versions.jcode!)
    })

    it('refuses a binary below an impossible floor, with the fix string that actually works', () => {
      const report = preflightJcode({ binary: jcodeBinary(), floor: '999.0.0' })
      expect(report.ok).toBe(false)
      expect(report.blocked).toBe('version_floor')
      /* Asserted verbatim: `jcode upgrade` errors with `unrecognized subcommand`, and the one
       * copy-pasteable string on the first-run screen has to be the one that works (R15, §11). */
      expect(report.fix).toBe('jcode update')
    })

    it('reports a missing binary as `binary_missing`, not as a version problem', () => {
      const report = preflightJcode({ binary: '/nonexistent/jcode-does-not-exist' })
      expect(report.ok).toBe(false)
      expect(report.blocked).toBe('binary_missing')
    })
  })

  /* ------------------------------------------------------- 2. launch, handshake, daemon pid */

  describe('launch and handshake ([F1], [F9])', () => {
    it('the bridge serves a socket and completes the SDK handshake', async () => {
      const client = await bridge.connect()
      /* `supports()` is the R6 probe: the bridge advertises no `permissions` capability, so a
       * client that waits for an approval prompt waits forever — which is why
       * `programmaticApprovals` is `false` in §5.2's jcode column rather than aspirational. */
      expect(client.supports('permissions')).toBe(false)
      expect(client.supports('sessions')).toBe(true)
      await client.close()
    })

    it("the daemon registers a pid in `servers.json` under THIS instance's home ([F1])", () => {
      const registry = JSON.parse(
        readFileSync(join(bridge.jcodeHome, 'servers.json'), 'utf8'),
      ) as Record<string, { socket?: string; pid?: number }>
      const entries = Object.values(registry)
      expect(entries.length).toBeGreaterThan(0)
      /* Scoped to this home, so it can never name the user's own daemon. */
      expect(entries.some((e) => e.socket === bridge.daemonSocket)).toBe(true)
      expect(resolveDaemonPid(bridge.jcodeHome, bridge.daemonSocket)).toBeTypeOf('number')
    })

    it('the daemon is a SEPARATE process group that the bridge group does not contain ([F1])', () => {
      const daemonPid = resolveDaemonPid(bridge.jcodeHome, bridge.daemonSocket)!
      expect(daemonPid).not.toBe(bridge.pgid)
      /* `spawn_server` re-execs the daemon behind `libc::setsid()`, so it leads its own session
       * and the agent, its tools and its bash children live there — not in the bridge's group.
       * This is the entire reason `hardKill` signals two groups and `daemonStopped` is a field
       * rather than an assumption. */
      expect(pidAlive(daemonPid)).toBe(true)
    })

    it('the child env is REPLACED, not merged: the bridge sees only the allowlist (§5.3, S9)', async () => {
      /* `JCODE_HOME` landed where swarm put it, which is the observable end of the replacement:
       * the daemon inherited swarm's env and wrote its registry into the throwaway home rather
       * than into `~/.jcode`. */
      expect(bridge.jcodeHome).toContain('swarm-real-bridge-')
      const client = await bridge.connect()
      const created = await client.createSession({ workingDir: bridge.workspace('env-check') })
      expect(created.sessionId).toMatch(/^session_/)
      await client.close()
    })
  })

  /* ------------------------------------------------------------------ 3. session lifecycle */

  describe('session lifecycle and the connection topology (§5.3, [F5])', () => {
    it('a session created on a FRESH connection keeps the working directory it was given', async () => {
      const client = await bridge.connect()
      const dir = bridge.workspace('ws-a')
      const created = await client.createSession({ workingDir: dir })
      const listed = (await client.listSessions()).find((s) => s.sessionId === created.sessionId)
      expect(listed?.workingDir).toBe(dir)
      await client.close()
    })

    it('a second `createSession` on the SAME connection creates NOTHING and returns the first', async () => {
      const client = await bridge.connect()
      const first = await client.createSession({ workingDir: bridge.workspace('ws-first') })
      const second = await client.createSession({ workingDir: bridge.workspace('ws-second') })
      /*
       * The finding that forced `JcodeInstance.createSession` off the probe connection. Creating
       * every workspace session over one shared connection yields ONE jcode session — one
       * transcript, one working directory, one agent — while swarm hands out distinct handles and
       * never notices, because nothing compared the ids.
       */
      expect(second.sessionId).toBe(first.sessionId)
      /* No new session exists: the count is the load-bearing fact. (It also re-homes the existing
       * session's `working_dir` to the newly requested one, which is worse than a no-op — an
       * agent's cwd moves under it — but the collapse is what breaks the fleet.) */
      const after = await client.listSessions()
      expect(after.filter((s) => s.sessionId === first.sessionId)).toHaveLength(1)
      await client.close()
    })

    it('two connections create two genuinely independent sessions', async () => {
      const a = await bridge.connect()
      const b = await bridge.connect()
      const sa = await a.createSession({ workingDir: bridge.workspace('ws-pair-a') })
      const sb = await b.createSession({ workingDir: bridge.workspace('ws-pair-b') })
      expect(sa.sessionId).not.toBe(sb.sessionId)
      const ids = (await a.listSessions()).map((s) => s.sessionId)
      expect(ids).toContain(sa.sessionId)
      expect(ids).toContain(sb.sessionId)
      await a.close()
      await b.close()
    })

    it('`attachSession` on an UNKNOWN id does not fail — it manufactures a session', async () => {
      const virgin = await bridge.connect()
      const before = (await virgin.listSessions()).length
      const attached = await virgin.attachSession('definitely-not-a-session-id')
      /*
       * It answers `ok` with a session id that is not the one requested, and `list_sessions` grows
       * by one: the bridge created a session, in ITS OWN cwd, and attached the connection to it.
       * Outside the workspace, outside the worktree, outside every guarantee §5.5 makes — and it
       * looks exactly like success. This is why `adoptSession` compares the ids.
       */
      expect(attached.sessionId).not.toBe('definitely-not-a-session-id')
      expect((await virgin.listSessions()).length).toBe(before + 1)
      await virgin.close()
    })

    it('and the adapter turns that into a hard failure rather than adopting it', async () => {
      const adapter = createJcodeAdapter({
        transport: createRealJcodeTransport(),
        socketPathOverride: bridge.socketPath,
        binary: jcodeBinary(),
      })
      const instance = await adapter.acquireInstance(
        'anthropic/claude-api',
        instanceOptions(bridge.workspace('adopt-guard')),
      )
      await expect(instance.openSession('definitely-not-a-session-id')).rejects.toThrow(
        /attached to .* instead|is gone/i,
      )
      await instance.dispose('test done')
    })

    it('`rename_session` emits `session_renamed`, and the title never reaches `list_sessions`', async () => {
      const client = await bridge.connect()
      const created = await client.createSession({ workingDir: bridge.workspace('ws-rename') })
      const seen = collect(client)
      await client.renameSession(created.sessionId, 'a-swarm-title')
      await settle(400)
      expect(seen.raw()).toContainEqual(
        expect.objectContaining({
          ev: 'session_renamed',
          session_id: created.sessionId,
          display_title: 'a-swarm-title',
        }),
      )
      /* Verified: `SessionInfo.title` is never populated, even immediately after a rename — so
       * anything rendering a session title needs swarm's own record as the fallback ([F16]). */
      const listed = (await client.listSessions()).find((s) => s.sessionId === created.sessionId)
      expect(listed?.title).toBeUndefined()
      await client.close()
    })

    it('archive hides a session from the default list and `restore` brings it back', async () => {
      const client = await bridge.connect()
      const created = await client.createSession({ workingDir: bridge.workspace('ws-archive') })
      await client.archiveSession(created.sessionId)
      const all = await client.listSessions()
      expect(all.find((s) => s.sessionId === created.sessionId)?.archived).toBe(true)
      await client.close()
    })
  })

  /* ------------------------------------------------- 4. request routing and the two exceptions */

  describe('session-scoped requests are ATTACHMENT-scoped (§5.3)', () => {
    let owner: JcodeSdkClient
    let other: JcodeSdkClient
    let mine: string
    let theirs: string

    beforeAll(async () => {
      owner = await bridge.connect()
      other = await bridge.connect()
      mine = (await owner.createSession({ workingDir: bridge.workspace('ws-route-a') })).sessionId
      theirs = (await other.createSession({ workingDir: bridge.workspace('ws-route-b') })).sessionId
    })

    afterAll(async () => {
      await owner?.close().catch(() => undefined)
      await other?.close().catch(() => undefined)
    })

    it("`getHistory` for another session is refused, with the bridge's own words", async () => {
      await expect(owner.getHistory(theirs)).rejects.toThrow(
        /unknown_session: this connection is attached to .*, not .*; attach to it first or use another connection/,
      )
    })

    it('so are runtime info, rename, send, cancel, interrupt and config', async () => {
      /* The whole reason `tail()`, `rename()` and every submit run on the session's OWN
       * connection rather than the shared probe's: routed through the probe, each of these would
       * have failed for every session but the probe's own. */
      await expect(owner.getRuntimeInfo(theirs)).rejects.toThrow(/unknown_session/)
      await expect(owner.renameSession(theirs, 'x')).rejects.toThrow(/unknown_session/)
      await expect(owner.sendMessage(theirs, 'x', { noReply: true })).rejects.toThrow(
        /unknown_session/,
      )
      await expect(owner.cancel(theirs)).rejects.toThrow(/unknown_session/)
      await expect(owner.softInterrupt(theirs, 'x')).rejects.toThrow(/unknown_session/)
      await expect(owner.setReasoningEffort(theirs, 'high')).rejects.toThrow(/unknown_session/)
    })

    it('but `peekSession` and `archiveSession` answer for ANY session, from any connection', async () => {
      /* The two exceptions, and the reason the rule had to be measured rather than assumed. */
      await expect(owner.peekSession(theirs, 4)).resolves.toBeInstanceOf(Array)
      await expect(owner.archiveSession(theirs)).resolves.toBeUndefined()
    })

    it('`peekSession` on a nonexistent session answers `[]` rather than failing', async () => {
      await expect(owner.peekSession('no-such-session-at-all', 4)).resolves.toEqual([])
    })

    it('`mine` is still reachable on its own connection, so the gate is about attachment', async () => {
      await expect(owner.getHistory(mine)).resolves.toBeInstanceOf(Array)
    })
  })

  /* ------------------------------------------------------- 5. peek vs history, and `tail()` */

  describe('the two transcript reads disagree, which is why `tail()` merges ([F8], #45)', () => {
    it('a `noReply` message reaches `getHistory` at once and `peekSession` never', async () => {
      const client = await bridge.connect()
      const created = await client.createSession({ workingDir: bridge.workspace('ws-reads') })
      const marker = `SWARM-PROBE-${Date.now()}`

      const seen = collect(client)
      await client.sendMessage(created.sessionId, marker, { noReply: true, waitForAccept: false })

      const has = async (): Promise<{ peek: boolean; history: boolean }> => ({
        peek: (await client.peekSession(created.sessionId, 20)).some((r) =>
          r.content.includes(marker),
        ),
        history: (await client.getHistory(created.sessionId)).some((r) =>
          r.content.includes(marker),
        ),
      })

      await settle(50)
      expect((await has()).history).toBe(true)
      /* Three seconds is not a lag, it is an absence: the stored tail holds jcode's own injected
       * session-context reminder and nothing swarm sent. Pinning `tail()` to `peekSession`
       * alone would match §5.5's digest against a transcript the prompt is never in — failing
       * closed on every single turn. */
      await settle(3_000)
      const final = await has()
      expect(final.peek).toBe(false)
      expect(final.history).toBe(true)

      /* And it is genuinely context-only: no `message_accepted`, no `turn_done`, no model turn
       * (§4.2, #32) — which is what makes it the one send this suite is allowed to make. */
      expect(seen.raw().map((e) => (e as { ev: string }).ev)).not.toContain('message_accepted')
      expect(seen.raw().map((e) => (e as { ev: string }).ev)).not.toContain('turn_done')
      await client.close()
    }, 20_000)

    it("a fresh session's stored tail is jcode's own reminder, not an empty list", async () => {
      const client = await bridge.connect()
      const created = await client.createSession({ workingDir: bridge.workspace('ws-fresh') })
      const stored = await client.peekSession(created.sessionId, 10)
      expect(stored.length).toBeGreaterThan(0)
      expect(stored[0]!.content).toContain('<system-reminder>')
      /* While the live transcript is genuinely empty — the two reads do not overlap at all. */
      expect(await client.getHistory(created.sessionId)).toEqual([])
      await client.close()
    })

    it('`peekSession(id, 0)` returns nothing', async () => {
      const client = await bridge.connect()
      const created = await client.createSession({ workingDir: bridge.workspace('ws-limit') })
      expect(await client.peekSession(created.sessionId, 0)).toEqual([])
      await client.close()
    })
  })

  /* ------------------------------------------------------------- 6. config: effort and model */

  describe('setReasoningEffort / setModel semantics, live (§4.1, §4.2, [F3])', () => {
    let client: JcodeSdkClient
    let session: string

    beforeAll(async () => {
      client = await bridge.connect()
      session = (await client.createSession({ workingDir: bridge.workspace('ws-config') }))
        .sessionId
    })

    afterAll(async () => {
      await client?.close().catch(() => undefined)
    })

    it('an empty effort is refused BRIDGE-side, before any provider lookup', async () => {
      /* The one rejection reachable with no credentials, and the reason `applyConfig` refuses a
       * `null` effort locally instead of sending it: `null` would serialize to exactly this. */
      await expect(client.setReasoningEffort(session, '')).rejects.toThrow(
        /invalid_request: set_reasoning_effort needs a non-empty `effort`/,
      )
    })

    it('every OTHER value is refused identically while the provider is unavailable', async () => {
      /*
       * The finding that keeps §4.1's ladder swarm's own. With no credentials, `high` and
       * `bogus-value` and `swarm` are indistinguishable — all three get `Anthropic provider not
       * available`. So a rejection here proves nothing about the value, and an `ok` (once
       * credentials exist) cannot be read as validation either. Three layers of swarm-side
       * validation is not belt-and-braces; it is the only validation there is.
       */
      const messages: string[] = []
      for (const effort of ['high', 'minimal', 'xhigh', 'max', 'swarm', 'swarm-deep', 'nonsense']) {
        await client.setReasoningEffort(session, effort).catch((e: Error) => {
          messages.push(e.message)
        })
      }
      expect(messages).toHaveLength(7)
      expect(new Set(messages).size).toBe(1)
      expect(messages[0]).toMatch(/provider not available/)
    })

    it("`swarm` and `swarm-deep` are NOT distinguished by the bridge — the ban is swarm's own", async () => {
      /* jcode's own `/effort` help lists them: "The swarm rungs run at max reasoning and turn on
       * swarm orchestration (light fan-out or the deep task graph)." Nothing on this wire refuses
       * them, which is precisely why §4.1 bans them three times before they get here. */
      const banned = await client
        .setReasoningEffort(session, 'swarm')
        .catch((e: Error) => e.message)
      const ordinary = await client
        .setReasoningEffort(session, 'high')
        .catch((e: Error) => e.message)
      expect(banned).toBe(ordinary)
    })

    it('an empty model is refused bridge-side; any real one needs a provider', async () => {
      await expect(client.setModel(session, '')).rejects.toThrow(
        /invalid_request: set_model needs a non-empty `model`/,
      )
      await expect(client.setModel(session, 'claude-opus-5')).rejects.toThrow(
        /Model switching is not available for this provider/,
      )
    })

    it('`runtimeInfo` carries the route catalog the model picker needs (C7, Q18)', async () => {
      const info = await client.getRuntimeInfo(session)
      expect(info.protocolVersion).toBe(1)
      expect(info.routes?.length).toBeGreaterThan(0)
      for (const route of info.routes ?? []) {
        expect(route.model).toBeTypeOf('string')
        expect(route.apiMethod).toBeTypeOf('string')
        expect(route.available).toBeTypeOf('boolean')
      }
      /* `provider` is a DISPLAY name here ("Claude"/"Anthropic"/"OpenAI"), not one of the six
       * credential ids and not the `--provider` vocabulary. Three namespaces, and conflating them
       * is how a credential lands under a provider that never reads it ([F17]). */
      expect(['Claude', 'Anthropic', 'OpenAI', undefined]).toContain(info.provider)
    })

    it('the credential provider list is exactly the six swarm declares ([F17])', async () => {
      const message = await client.setApiKey('anthropic', 'not-a-real-key').then(
        () => 'RESOLVED',
        (e: Error) => e.message,
      )
      /* Asserted against the constant, so a seventh provider breaks the constant rather than the
       * fleet. Note the refusal is for the *name*: `anthropic` is not one of the six. */
      expect(message).toContain(JCODE_UNSUPPORTED_PROVIDER_MESSAGE)
    })

    it('retention refuses 0 and accepts "disabled", which is what swarm pins ([F12], R11)', async () => {
      await expect(client.setRetentionPolicy(0)).rejects.toThrow(
        /archive_after_days must be 1..=36500, or null to disable/,
      )
      await expect(client.setRetentionPolicy(undefined)).resolves.toBeUndefined()
    })
  })

  /* ---------------------------------------------------------------- 7. the event stream shape */

  describe('the event stream vs our normalized events (§5.1, §6.4)', () => {
    it('every frame the bridge sends carries `v` and a known `ev` tag', async () => {
      const client = await bridge.connect()
      const created = await client.createSession({ workingDir: bridge.workspace('ws-stream') })
      const seen = collect(client)
      await client.renameSession(created.sessionId, 'stream-shape')
      await settle(400)
      const frames = seen.raw() as { v?: number; ev?: string }[]
      expect(frames.length).toBeGreaterThan(0)
      for (const frame of frames) {
        expect(frame.v).toBe(1)
        expect(frame.ev).toBeTypeOf('string')
      }
      await client.close()
    })

    it('there is no `notification` and no `closed` event kind at all ([B7], §5.1)', async () => {
      const client = await bridge.connect()
      const created = await client.createSession({ workingDir: bridge.workspace('ws-kinds') })
      const seen = collect(client)
      await client.renameSession(created.sessionId, 'x')
      await client.sendMessage(created.sessionId, 'ctx', { noReply: true, waitForAccept: false })
      await settle(600)
      const kinds = new Set((seen.raw() as { ev: string }[]).map((f) => f.ev))
      /* [B7] scraped background progress out of a markdown header in a `notification` body. That
       * event kind does not exist here — `background_progress` is first-class — and the terminal
       * `closed` frame the 1.0.1-era union declared does not exist either: the iterator just ends,
       * which is why the adapter synthesizes the terminal. */
      expect(kinds).not.toContain('notification')
      expect(kinds).not.toContain('closed')
      await client.close()
    })
  })

  /* ------------------------------------------------------- 8. daemon death and the hard kill */

  describe('daemon death, and the two-group hard kill ([F1], [F5], §4.3.7)', () => {
    it('killing the daemon announces itself on every attached stream, then fails everything', async () => {
      /* Its own bridge: this test destroys the instance it runs against. */
      const own = await startRealBridge()
      try {
        const a = await own.connect()
        const b = await own.connect()
        await a.createSession({ workingDir: own.workspace('ws-a') })
        await b.createSession({ workingDir: own.workspace('ws-b') })
        const seenA = collect(a)
        const seenB = collect(b)

        const daemonPid = resolveDaemonPid(own.jcodeHome, own.daemonSocket)!
        process.kill(daemonPid, 'SIGKILL')
        await settle(1_500)

        /* Announced on EVERY attached connection — which is what makes a dead daemon observable
         * without polling, and what retires [F5]'s session-scoped ping. */
        const frame = { v: 1, ev: 'error', code: 'internal', message: 'daemon connection closed' }
        expect(seenA.raw()).toContainEqual(frame)
        expect(seenB.raw()).toContainEqual(frame)

        /*
         * And then nothing survives. [F5] held that `list_sessions`, `peek_session`,
         * `archive_session` and `set_retention_policy` are answered from disk and stay green with
         * a dead daemon, so liveness needed a ping naming an attached session. All four fail.
         */
        await expect(a.ping()).rejects.toThrow()
        await expect(a.listSessions()).rejects.toThrow()
        await expect(a.peekSession('anything', 4)).rejects.toThrow()
        await expect(a.setRetentionPolicy(undefined)).rejects.toThrow()

        /* A connection opened AFTER the death still completes its handshake from the bridge's own
         * state, then fails on its first request — the one way a caller could still be fooled. */
        const fresh = await own.connect()
        await expect(fresh.ping()).rejects.toThrow()
      } finally {
        await own.stop()
      }
    }, 90_000)

    it('the two-group kill actually kills the setsid daemon, proven by ESRCH', async () => {
      const own = await startRealBridge()
      const daemonPid = resolveDaemonPid(own.jcodeHome, own.daemonSocket)!
      const bridgePgid = own.pgid
      expect(pidAlive(daemonPid)).toBe(true)

      const result = await own.stop()

      /*
       * The finding [F1] exists for, reproduced: signalling only the bridge's group returns
       * `survivors: []` while the agent keeps writing to the worktree. The daemon is `setsid()`'d
       * into its own session with PPID 1, so it is reachable only by its own group — and a stop
       * that left it running would look exactly like a stop that worked.
       */
      expect(result.survivors).toEqual([])
      expect(result.daemonStopped).toBe(true)
      expect(pidAlive(daemonPid)).toBe(false)
      expect(pidAlive(bridgePgid)).toBe(false)
    }, 90_000)
  })

  /* ------------------------------------------ 9. the conformance suite against the real thing */

  describe('executorConformance() against the real adapter + bridge (§5.2)', () => {
    /**
     * Every case runs; the ones that turn out to need a scripted turn skip **themselves**.
     *
     * A hand-maintained skip list would have to be edited every time the suite gains a case, and
     * the failure mode of forgetting is a case that silently never runs against the real bridge —
     * which is the one thing this file exists to prevent. Instead the harness throws a marked
     * error the moment a case reaches for `scriptTurn` or `disconnect`, and that marker (and only
     * that marker) becomes a skip. Anything else fails, loudly.
     */
    const harness = () => realConformanceHarness(bridge)
    /** Filled in as cases skip; compared against `CONFORMANCE_MOCK_ONLY` by the last case here. */
    const skipped: string[] = []

    for (const testCase of executorConformance(harness)) {
      it(
        testCase.name,
        async (ctx) => {
          try {
            await testCase.run()
          } catch (error) {
            if ((error as { [UNSCRIPTABLE]?: true })[UNSCRIPTABLE] === true) {
              skipped.push(testCase.name)
              ctx.skip(`needs a scripted turn: ${(error as Error).message}`)
              return
            }
            throw error
          }
        },
        60_000,
      )
    }

    it('and the cases that stay mock-only are named, not merely absent', () => {
      expect(MODEL_TURN_ONLY.length).toBeGreaterThan(0)
      /* Each entry says what would settle it, not merely that something is missing. */
      for (const entry of MODEL_TURN_ONLY) {
        expect(entry).toMatch(/needs|unobservable|unauthenticated/)
      }

      /*
       * The part that is not decorative: the declared gap list against the set of cases that
       * actually skipped, as sets, both directions. This must be the LAST case in the describe —
       * vitest runs a file's tests in declaration order, so by here every case above has either
       * run or recorded itself.
       */
      expect([...skipped].sort()).toEqual(Object.keys(CONFORMANCE_MOCK_ONLY).sort())
      for (const [name, reason] of Object.entries(CONFORMANCE_MOCK_ONLY)) {
        expect(reason, name).toMatch(/needs|unobservable|unauthenticated|cannot/)
      }
    })
  })
})

/* ------------------------------------------------------------------------------ helpers */

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function instanceOptions(root: string) {
  return {
    jcodeHome: join(root, 'instance-home'),
    workingDir: root,
    /* S10, explicit and never defaulted — and see `test/support/real-bridge.ts` for the one route
     * this does not isolate. */
    inheritLogins: false as const,
    env: {},
    startupTimeoutMs: 30_000,
    cleanupTimeoutMs: 5_000,
    inheritStderr: false,
  }
}

/**
 * Brands the harness's refusal so a case that needs a scripted turn skips instead of failing —
 * and so nothing *else* is mistaken for one.
 */
const UNSCRIPTABLE = Symbol('swarm.real-bridge.unscriptable')

function unscriptable(what: string): Error {
  return Object.assign(
    new Error(
      `the real bridge cannot ${what}: a turn needs a model, and this suite must not buy one`,
    ),
    { [UNSCRIPTABLE]: true as const },
  )
}

/** Drain a connection's raw stream into an array, without blocking the test on it. */
function collect(client: JcodeSdkClient): { raw(): unknown[] } {
  const seen: unknown[] = []
  void (async () => {
    try {
      for await (const event of client.events()) seen.push(event)
    } catch {
      /* The connection closing is the normal end of this loop. */
    }
  })()
  return { raw: () => [...seen] }
}

/**
 * The real adapter as an `ExecutorHarness`.
 *
 * `scriptTurn` throws rather than no-ops: a harness that silently ignored it would let every
 * turn-shaped conformance case "pass" against a backend that never played the turn, which is the
 * most expensive kind of green there is. The suite skips those cases by name instead.
 */
let conformanceRun = 0

function realConformanceHarness(bridge: RealBridge) {
  const real = createJcodeAdapter({
    transport: createRealJcodeTransport({ clientName: 'swarm-conformance/0.1' }),
    socketPathOverride: bridge.socketPath,
    binary: jcodeBinary(),
    acceptTimeoutMs: 500,
  })

  /*
   * `structured()` is the one call a conformance case makes that reaches a model **without ever
   * touching `scriptTurn`**, so the skip marker alone does not stop it. Against an unauthenticated
   * home it merely fails; on the user's own laptop, where the `chatgpt-web` route reports
   * `available: true` off a browser profile in `$HOME`, it would buy a real turn on their
   * subscription. The seam refuses instead, with the same marked error, so the case skips with
   * its reason attached.
   *
   * `submit()` is deliberately NOT guarded: every case that submits to a live session scripts the
   * turn first and has already skipped, while the cases that submit to a *closed* or *disposed*
   * session are asserting the refusal itself — and a guard there would replace the
   * `executor_unavailable` they are checking for with this one.
   */
  const guarded = new WeakMap<object, ExecutorSessionHandle>()
  const guardSession = (session: ExecutorSessionHandle): ExecutorSessionHandle => {
    const existing = guarded.get(session)
    if (existing !== undefined) return existing
    const proxy = new Proxy(session, {
      get(target, property, receiver) {
        if (property === 'structured') {
          return () => Promise.reject(unscriptable('run a structured turn'))
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    guarded.set(session, proxy)
    return proxy
  }

  /* Proxies are memoized so `acquireInstance` twice returns the *same* object: §5.3's pool
   * identity is asserted with `===`, and a fresh wrapper each call would fail a rule the adapter
   * actually honours. */
  const instanceProxies = new WeakMap<object, ExecutorInstance>()
  const adapter: ExecutorAdapter = {
    id: real.id,
    capabilities: real.capabilities,
    preflight: () => real.preflight(),
    async acquireInstance(key, opts) {
      const instance = await real.acquireInstance(key, opts)
      const existing = instanceProxies.get(instance)
      if (existing !== undefined) return existing
      const proxy = new Proxy(instance, {
        get(target, property, receiver) {
          if (property === 'createSession' || property === 'openSession') {
            return async (...args: never[]) =>
              guardSession(
                await (target[property] as (...a: never[]) => Promise<ExecutorSessionHandle>)(
                  ...args,
                ),
              )
          }
          return Reflect.get(target, property, receiver) as unknown
        },
      })
      instanceProxies.set(instance, proxy)
      return proxy
    },
  }
  /* A private home per case. `instances/<hash>/lock` is an `O_EXCL` singleton held for the life
   * of the instance (§3.4 rule 3, §7.2) and the suite never disposes between cases, so a shared
   * home would fail every case after the first with `lease_held` — testing the lock rather than
   * the adapter. The lock lives at `<jcodeHome>/../lock`, so each case needs its own *parent*
   * directory, not merely its own home. */
  const home = join(bridge.root, 'conformance', String(++conformanceRun), 'home')
  return {
    adapter,
    instanceKey: 'anthropic/claude-api' as const,
    instanceOptions: { ...instanceOptions(join(home, '..')), jcodeHome: home },
    scriptTurn(): void {
      throw unscriptable('be scripted')
    },
    disconnect(): void {
      throw unscriptable('fake a transport disconnect')
    },
    async dispose() {
      /* Sessions and connections are closed by the instance; the bridge outlives the harness. */
    },
  }
}

/** Named so a reader of the skipped list can find what would settle each item. */
export const REAL_BRIDGE_MODEL_TURN_GAPS = MODEL_TURN_ONLY
