/**
 * SPEC-swarm §5.1–§5.4 and §13's jcode rows — the adapter, over `fakeJcodeTransport()`.
 *
 * The fake is the hermetic evidence: every behaviour it reproduces was verified against a live
 * `jcode v0.67.0` `api-bridge` on 2026-08-04 and is re-derived from the real binary by
 * `test/real-bridge.test.ts` under `SWARM_REAL_BRIDGE=1`. The rows asserted here are the ones
 * §13 names:
 *
 *  - `sendMessage` is called with `waitForAccept: false` — explicitly, because 1.1.0 defaults it
 *    to `true` — and `ack:'accepted'` is produced only by an observed `message_accepted` on the
 *    session's own `events()` stream ([F2], #42).
 *  - Two concurrent tools produce correctly attributed input deltas even though every
 *    `tool_input_delta` arrives with `call_id: ''` ([F11], #47).
 *  - `HealthVM.instances[].ok` goes false when the daemon dies while the bridge stays up — which
 *    a plain `ping()` does detect, because nothing survives a dead daemon ([F5], #44).
 *  - A mid-turn config change is never issued: the reply is withheld until turn end and the SDK
 *    raises `HarnessError('timeout')` **while the setting still lands** ([F10], #8).
 *  - `hardKill` signals two groups and refuses `capability_absent` with no pgid ([F1], §4.3.7).
 *  - A child that exits **0** before the handshake is `blocked:'socket_dir'` ([F9], #46).
 *  - A stub binary reporting 0.64.2 produces `version_floor` in under a second, with the fix
 *    string `jcode update` — asserted verbatim, because `jcode upgrade` does not exist (R15).
 */

import { describe, expect, it } from 'vitest'

import type { ExecutorInstance, ExecutorSessionHandle } from '../src/server/executor/types.ts'
import type { Fence } from '../src/types.ts'

import { sessionLease } from '../src/domain/leases.ts'
import { SwarmError } from '../src/errors.ts'
import {
  assertEffortAllowed,
  createJcodeAdapter,
  normalizeJcodeEvent,
  scrapeBackgroundProgress,
} from '../src/server/executor/jcode.ts'
import {
  buildBridgeEnv,
  killTwoGroups,
  launchBridge,
  preflightJcode,
  resolveDaemonPid,
  type SpawnedBridge,
} from '../src/server/executor/spawn.ts'
import { JCODE_CAPABILITIES } from '../src/server/executor/types.ts'
import { executorConformance } from '../src/testing/executor-conformance.ts'
import { jcodeExecutorHarness } from '../src/testing/node/jcode-harness.ts'

/* ------------------------------------------------------- §13: the suite, against the adapter */

describe('§5.2 `executorConformance()` against the jcode adapter over `fakeJcodeTransport()`', () => {
  for (const conformanceCase of executorConformance(() => jcodeExecutorHarness())) {
    it(conformanceCase.name, conformanceCase.run)
  }
})

/* -------------------------------------------------------------------- helpers for the rows */

interface Wired {
  readonly harness: ReturnType<typeof jcodeExecutorHarness>
  readonly instance: ExecutorInstance
  readonly session: ExecutorSessionHandle
  readonly fence: Fence
}

async function wire(options: Parameters<typeof jcodeExecutorHarness>[0] = {}): Promise<Wired> {
  const harness = jcodeExecutorHarness(options)
  const instance = await harness.adapter.acquireInstance(
    harness.instanceKey,
    harness.instanceOptions,
  )
  const session = await instance.createSession({ workingDir: harness.instanceOptions.workingDir })
  return { harness, instance, session, fence: { key: sessionLease(session.sessionId), token: 1 } }
}

/* ------------------------------------------------------------------- [F2] the ack, observed */

describe('[F2] the ack can only come from the stream (#42, V5)', () => {
  it('`sendMessage` is called with `waitForAccept: false`, explicitly', async () => {
    const w = await wire()
    w.harness.scriptTurn(w.session, { ack: true, text: 'hi' })
    await w.session.submit({ text: 'go', awaitAckMs: 60 }, w.fence)

    const send = w.harness.bridge.callsOf('send_message')[0]!
    /* §13 used to require the flag to be ABSENT, on the 1.0.1 default of "do not wait". The
     * installed 1.1.0 defaults it to `true` with a 10 s accept timeout, so absence now means ten
     * seconds of blocking on exactly the un-acked send whose latency matters most. It is passed,
     * and it is passed false. */
    expect(send.params.waitForAccept).toBe(false)
    await w.harness.dispose()
  })

  it('a transport that emits the ack yields `ack:"accepted"`', async () => {
    const w = await wire()
    w.harness.scriptTurn(w.session, { ack: true, text: 'hi' })
    const receipt = await w.session.submit({ text: 'go', awaitAckMs: 80 }, w.fence)
    expect(receipt.ack).toBe('accepted')
    expect(receipt.ackAtMs).not.toBeNull()
    /* Always false for jcode: the ack carries only `session_id` — no content, no index (§5.4 #3). */
    expect(receipt.correlated).toBe(false)
    await w.harness.dispose()
  })

  it('a transport that never emits it yields `ack:"unknown"` at `acceptTimeoutMs`', async () => {
    const w = await wire()
    w.harness.scriptTurn(w.session, { ack: false, text: 'hi', turnDone: false })
    const started = Date.now()
    const receipt = await w.session.submit({ text: 'go', awaitAckMs: 40 }, w.fence)
    expect(receipt.ack).toBe('unknown')
    expect(receipt.ackAtMs).toBeNull()
    /* Swarm's own deadline, not the SDK's: the SDK's timer is `.unref()`'d and its await may never
     * settle at all in an idle process. */
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
    await w.harness.dispose()
  })
})

/* ---------------------------------------------------------- [F11] tool input attribution */

describe('[F11] an empty `tool_input_delta` call id is attributed, a real one is kept (#47)', () => {
  it('two concurrent tools produce correctly attributed input deltas', async () => {
    const attribution = { lastToolStart: null as string | null }
    const events = [
      { ev: 'tool_start', session_id: 's', call_id: 'call-a', name: 'bash' },
      { ev: 'tool_input_delta', session_id: 's', call_id: '', delta: 'ls -la' },
      { ev: 'tool_start', session_id: 's', call_id: 'call-b', name: 'read' },
      { ev: 'tool_input_delta', session_id: 's', call_id: '', delta: 'README.md' },
    ] as const

    const normalized = events.map((raw) => normalizeJcodeEvent(raw, attribution))
    const inputs = normalized.filter((e) => e?.k === 'tool_input')
    /* Keying a buffer by the id the bridge sends would merge both tools' argument streams into
     * one bucket — the failure the attribution rule exists to prevent. */
    expect(inputs.map((e) => (e as { callId: string }).callId)).toEqual(['call-a', 'call-b'])
    expect(inputs.map((e) => (e as { delta: string }).delta)).toEqual(['ls -la', 'README.md'])
  })

  it('a NON-empty wire call id is taken at face value, not overwritten by attribution', () => {
    /* Protocol v1 types `call_id` as a plain string. [F11] observed the bridge emptying it, but
     * an adapter that *always* substituted the last `tool_start` would corrupt a bridge that
     * fixed the bug — so the mitigation is conditional, and both directions are pinned. */
    const attribution = { lastToolStart: null as string | null }
    const normalized = [
      { ev: 'tool_start', session_id: 's', call_id: 'call-a', name: 'bash' },
      { ev: 'tool_input_delta', session_id: 's', call_id: 'call-b', delta: 'from b' },
    ].map((raw) => normalizeJcodeEvent(raw as never, attribution))
    expect(normalized[1]).toEqual({ k: 'tool_input', callId: 'call-b', delta: 'from b' })
  })

  it('the same holds end-to-end through the adapter', async () => {
    const w = await wire()
    w.harness.scriptTurn(w.session, {
      ack: true,
      tools: [
        { callId: 'call-a', name: 'bash', input: 'ls' },
        { callId: 'call-b', name: 'read', input: 'README' },
      ],
    })
    const iterator = w.session.events()
    await w.session.submit({ text: 'go', awaitAckMs: 60 }, w.fence)
    const seen: string[] = []
    for (let i = 0; i < 40; i++) {
      const next = await iterator.next()
      if (next.done === true) break
      if (next.value.k === 'tool_input') seen.push(next.value.callId)
      if (next.value.k === 'turn_done') break
    }
    expect(seen).toEqual(['call-a', 'call-b'])
    /* The wire never carries `''`: attribution happens in the adapter, once (§6.4). */
    expect(seen).not.toContain('')
    await w.harness.dispose()
  })
})

/* -------------------------------------------------------------- [F5] the connection topology */

describe('[F5] the probe connection, and the only liveness signal there is (#44)', () => {
  it("every `create_session` runs on its OWN fresh connection, never the probe's", async () => {
    const w = await wire()
    const creates = w.harness.bridge.callsOf('create_session')
    /* Two: the probe session, and the workspace session `wire()` opened. On the real bridge a
     * second `create_session` over one connection returns the FIRST session and creates nothing,
     * so sharing a connection here would silently collapse the fleet onto the probe session —
     * one transcript, one working directory, one agent, with distinct ids reported anyway. */
    expect(creates.length).toBeGreaterThanOrEqual(2)
    const attached = w.harness.transport.clients.map((c) => c.attachedSessionId)
    expect(new Set(attached).size).toBe(attached.length)
    expect(attached).toContain(w.session.sessionId)
    await w.harness.dispose()
  })

  it('`attachSession` returning a DIFFERENT session id is a hard failure, not a silent adoption', async () => {
    const w = await wire()
    /* The bridge never fails an unknown id: it answers with the current attachment, or
     * manufactures a session in the bridge's cwd — outside the worktree and outside every
     * guarantee §5.5 makes. Both look like success on the wire. */
    await expect(w.instance.openSession('no-such-session')).rejects.toThrow(
      /attached to .* instead|is gone/i,
    )
    await w.harness.dispose()
  })

  it('`detachSession` and `globalEvents` are never called — there is no call to make', async () => {
    const w = await wire()
    const kinds = new Set(w.harness.bridge.calls.map((call) => call.type))
    expect([...kinds]).not.toContain('detach_session')
    expect([...kinds]).not.toContain('global_events')
    await w.harness.dispose()
  })

  it('`setRetentionPolicy(undefined)` runs once at startup — pinned, never assumed ([F12], R11)', async () => {
    const w = await wire()
    const calls = w.harness.bridge.callsOf('set_retention_policy')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params.archiveAfterDays).toBeNull()
    await w.harness.dispose()
  })

  it('a dead daemon fails EVERY request, including the ones [F5] believed were disk-served', async () => {
    const w = await wire()
    w.harness.bridge.killDaemon()

    /* [F5] held that `list_sessions`/`peek_session`/`archive_session`/`set_retention_policy` are
     * answered from disk and stay green while the daemon is gone, so liveness needed a ping
     * naming an attached session. Re-tested against 0.67.0: none of them survive. The bridge
     * closes every attached connection and fails everything afterwards. */
    await expect(w.instance.listSessions()).rejects.toThrow(/closed/i)
    await expect(w.session.tail(4)).rejects.toThrow(/closed/i)
    await expect(w.instance.runtimeInfo()).rejects.toThrow(/closed/i)
    await w.harness.dispose()
  })

  it('a plain `ping()` IS the liveness signal — there is no session-scoped ping to make', async () => {
    const w = await wire()
    const client = await w.harness.transport.connect('ignored')
    await expect(client.ping()).resolves.toBeUndefined()
    w.harness.bridge.killDaemon()
    /* `ping` takes no session id in protocol v1 at all, and it is a real round trip: it fails the
     * moment the daemon is gone, which is the whole of what [F5]'s expensive mitigation bought. */
    await expect(client.ping()).rejects.toThrow(/closed/i)
    await w.harness.dispose()
  })

  it('the daemon death is announced on the STREAM before the connection closes', async () => {
    const w = await wire()
    const events = w.session.events()
    w.harness.bridge.killDaemon()
    const seen = []
    for (let i = 0; i < 10; i++) {
      const next = await events.next()
      if (next.done === true) break
      seen.push(next.value)
      if (next.value.k === 'closed') break
    }
    /* `error{code:'internal', message:'daemon connection closed'}` reaches every attached
     * connection, so a dead daemon is observable without polling at all. */
    expect(seen).toContainEqual({
      k: 'error',
      code: 'internal',
      message: 'daemon connection closed',
    })
    await w.harness.dispose()
  })
})

/* ------------------------------------------------------------------ [F10] the mid-turn config */

describe('[F10] a mid-turn config change fails AND lands (#8, §4.3.3)', () => {
  it('the reply is withheld until turn end, the SDK times out, and the setting applies anyway', async () => {
    const w = await wire({
      requestTimeoutMs: 30,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    })
    w.harness.scriptTurn(w.session, { ack: true, text: 'thinking', turnDone: false })
    await w.session.submit({ text: 'go', awaitAckMs: 60 }, w.fence)

    /* The adapter refuses this itself (`turn_in_flight`) — which is §4.3.3 — so the fake is
     * driven directly here to prove *why* the refusal exists rather than that it happens. */
    const client = await w.harness.transport.connect('ignored')
    await client.attachSession(w.session.sessionId)
    const parked = client.setReasoningEffort(w.session.sessionId, 'high')
    await expect(parked).rejects.toThrow(/timeout/i)

    /* And the side effect succeeded, on a turn the user never targeted. */
    w.harness.bridge.endTurn(w.session.sessionId)
    expect(w.harness.bridge.sessions.get(w.session.sessionId)?.effort).toBe('high')
    await w.harness.dispose()
  })

  it('the adapter refuses a mid-turn config change with `turn_in_flight` and calls nothing', async () => {
    const w = await wire()
    w.harness.scriptTurn(w.session, { ack: true, text: 'thinking', turnDone: false })
    await w.session.submit({ text: 'go', awaitAckMs: 60 }, w.fence)
    const before = w.harness.bridge.calls.length

    await expect(w.session.applyConfig({ reasoningEffort: 'high' }, w.fence)).rejects.toMatchObject(
      { code: 'turn_in_flight' },
    )
    expect(w.harness.bridge.calls.length).toBe(before)
    await w.harness.dispose()
  })
})

/* ------------------------------------------------------------------------ the effort ladder */

describe('§4.1 #9 — layer 3, the last gate before the daemon', () => {
  it('`swarm` and `swarm-deep` are refused in the adapter, with `banned_effort`', () => {
    for (const effort of ['swarm', 'swarm-deep', 'SWARM']) {
      const refusal = assertEffortAllowed(effort)
      expect(refusal?.code).toBe('banned_effort')
    }
    expect(assertEffortAllowed('high')).toBeNull()
    expect(assertEffortAllowed(null)).toBeNull()
  })

  it('`applyConfig` refuses a banned effort before any call reaches the bridge', async () => {
    const w = await wire()
    const before = w.harness.bridge.callsOf('set_reasoning_effort').length
    await expect(
      w.session.applyConfig({ reasoningEffort: 'swarm' as never }, w.fence),
    ).rejects.toMatchObject({ code: 'banned_effort' })
    /* `ok` from `setReasoningEffort` validates nothing: `swarm` is inside the accepted set, which
     * is exactly why the ladder is swarm's to enforce at all three layers. */
    expect(w.harness.bridge.callsOf('set_reasoning_effort').length).toBe(before)
    await w.harness.dispose()
  })
})

/* ----------------------------------------------------------------- capabilities and history */

describe('§5.2 the declared jcode capability row', () => {
  it('claims exactly what §5.2 makes it claim', () => {
    expect(JCODE_CAPABILITIES).toMatchObject({
      nativeReplay: false,
      idempotentSubmit: false,
      submitAckCorrelates: false,
      observableEffort: false,
      observableModel: true,
      perTurnConfig: false,
      programmaticApprovals: false,
      perTurnToolRestriction: false,
      structuredOutput: true,
      contextOnlyMessage: true,
      softInterrupt: true,
      interruptLandingObservable: false,
      history: 'text-only',
      sessionsPerConnection: 1,
      usageEvents: true,
    })
  })

  it("`tail()` merges the stored tail with the live one, on this session's own connection", async () => {
    const w = await wire()
    w.harness.scriptTurn(w.session, { ack: true, text: 'the answer' })
    await w.session.submit({ text: 'the question', awaitAckMs: 60 }, w.fence)
    await w.harness.bridge.quiesce()
    const tail = await w.session.tail(8)

    /* Both reads, every time. `peek_session` is the stored tail and — verified against 0.67.0 —
     * never carries what this session sent: a `noReply` message was still absent 3 s later while
     * `get_history` already had it. Pinning `tail()` to `peekSession` alone ([F8], #45) would
     * therefore match §5.5's digest against a transcript the prompt is never in, failing closed
     * on every turn. */
    expect(w.harness.bridge.callsOf('peek_session')).toHaveLength(1)
    expect(w.harness.bridge.callsOf('get_history')).toHaveLength(1)
    expect(tail.some((row) => row.content.includes('the question'))).toBe(true)

    /* And it is this session's connection, not the probe's: `get_history` is attachment-scoped
     * and answers `unknown_session` for anything else. */
    expect(w.harness.bridge.callsOf('get_history')[0]!.sessionId).toBe(w.session.sessionId)
    await w.harness.dispose()
  })

  it("`tail()` drops the `''` rows [F8] warned about rather than merging them", async () => {
    const w = await wire()
    /* `get_history` does `content.as_str().unwrap_or("")`, so a block-array message arrives as an
     * empty string. A digest match against `''` makes every `unknown` turn look un-landed — the
     * one direction Q5 says must never auto-act — so an empty row is never merged in. */
    const session = w.harness.bridge.sessions.get(w.session.sessionId)!
    session.history.push({ role: 'assistant', content: '' })
    session.history.push({ role: 'assistant', content: 'real content' })
    const tail = await w.session.tail(8)
    expect(tail.every((row) => row.content !== '')).toBe(true)
    expect(tail.some((row) => row.content === 'real content')).toBe(true)
    await w.harness.dispose()
  })

  it('`background_progress` is a FIRST-CLASS event on protocol v1, carried as `native`', () => {
    const normalized = normalizeJcodeEvent(
      {
        ev: 'background_progress',
        session_id: 's',
        task_id: 't-1',
        label: 'indexing',
        summary: 'indexing the repo',
        percent: 42,
        done: false,
      },
      { lastToolStart: null },
    )
    /* [B7] reverse-engineered this out of a markdown header in a `notification` body. There is no
     * `notification` event kind on 0.67.0 at all, so the scrape is dead and the signal is real —
     * but it still feeds no state, no budget and no completion (§6.4). */
    expect(normalized).toMatchObject({
      k: 'background',
      provenance: 'native',
      taskId: 't-1',
      percent: 42,
      done: false,
    })
  })

  it('the [B7] scrape survives as a rule for backends that still need it (#16)', () => {
    const scraped = scrapeBackgroundProgress('**Background task progress** indexing 42%', 'index')
    expect(scraped).toMatchObject({ k: 'background', provenance: 'scraped', percent: 42 })
    /* Any TUI copy change kills it silently, so its disappearance must not be an error. */
    expect(scrapeBackgroundProgress('some other notification body')).toBeNull()
  })

  it('`session_renamed` is dropped: it is not a turn event and §5.1 has no member for it', () => {
    expect(
      normalizeJcodeEvent(
        { ev: 'session_renamed', session_id: 's', title: 't', display_title: 't' },
        { lastToolStart: null },
      ),
    ).toBeNull()
  })

  it('`session_status` is carried with `trusted:false` and feeds no machine (#18)', () => {
    const normalized = normalizeJcodeEvent(
      { ev: 'session_status', session_id: 's', status: 'idle' },
      { lastToolStart: null },
    )
    expect(normalized).toEqual({ k: 'session_status', status: 'idle', trusted: false })
  })

  it('an `error` frame carries no `session_id` and is attributable only per-connection ([F6])', () => {
    const normalized = normalizeJcodeEvent(
      { ev: 'error', code: 'internal', message: 'the daemon fell over' },
      { lastToolStart: null },
    )
    expect(normalized).toEqual({ k: 'error', code: 'internal', message: 'the daemon fell over' })
  })
})

/* -------------------------------------------------------------- §5.3 the spawn and the kill */

describe('§5.3 the version gate — the only floor there is', () => {
  it('a stub binary reporting 0.64.2 is `version_floor` in under a second, fixed by `jcode update`', () => {
    const started = Date.now()
    const report = preflightJcode({
      binary: 'jcode',
      floor: '0.66.0',
      probe: () => ({ code: 0, stdout: 'jcode 0.64.2\n', stderr: '' }),
    })
    expect(report.ok).toBe(false)
    expect(report.blocked).toBe('version_floor')
    /* Asserted verbatim: `jcode upgrade` errors with `unrecognized subcommand`, and the one
     * copy-pasteable string on the first-run screen has to be the one that works (R15, §11). */
    expect(report.fix).toBe('jcode update')
    expect(report.fix).not.toContain('upgrade')
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  it('0.67.1 passes, and a missing binary is `binary_missing` rather than a hang (R1)', () => {
    expect(
      preflightJcode({ probe: () => ({ code: 0, stdout: 'jcode 0.67.1', stderr: '' }) }).ok,
    ).toBe(true)
    const missing = preflightJcode({
      probe: () => ({ code: 127, stdout: '', stderr: 'spawn jcode ENOENT' }),
    })
    expect(missing.blocked).toBe('binary_missing')
  })
})

describe('§5.3 the env allowlist — a complete map, never a patch (#26, S9)', () => {
  it('a sentinel in the server environment is ABSENT from the child environment', () => {
    const env = buildBridgeEnv({
      jcodeHome: '/home/j',
      runtimeDir: '/run/j',
      apiSocket: '/run/j/api.sock',
      daemonSocket: '/run/j/jcode.sock',
      autoPoke: true,
      sourceEnv: { PATH: '/usr/bin', HOME: '/home/me', AWS_SECRET_ACCESS_KEY: 'sentinel' },
    })
    /* The SDK's launcher spreads `process.env`, so no variable can be *removed* — which is the
     * whole reason swarm spawns the bridge itself (§5.3, R12). */
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(Object.values(env)).not.toContain('sentinel')
    expect(env).toMatchObject({
      JCODE_HOME: '/home/j',
      JCODE_SWARM_ENABLED: 'false',
      JCODE_MEMORY_ENABLED: 'false',
      JCODE_NO_TELEMETRY: '1',
      JCODE_NON_INTERACTIVE: '1',
      JCODE_AUTO_POKE: '1',
    })
  })

  it('the allowlist is additive and `SSH_AUTH_SOCK` is opt-in only', () => {
    const base = buildBridgeEnv({
      jcodeHome: '/h',
      runtimeDir: '/r',
      apiSocket: '/r/a',
      daemonSocket: '/r/d',
      autoPoke: false,
      sourceEnv: { GH_TOKEN: 'gho_x', SSH_AUTH_SOCK: '/tmp/agent' },
    })
    expect(base.GH_TOKEN).toBeUndefined()
    expect(base.SSH_AUTH_SOCK).toBeUndefined()

    const widened = buildBridgeEnv({
      jcodeHome: '/h',
      runtimeDir: '/r',
      apiSocket: '/r/a',
      daemonSocket: '/r/d',
      autoPoke: false,
      allowlist: ['GH_TOKEN'],
      sshAuthSock: '/tmp/agent',
      sourceEnv: { GH_TOKEN: 'gho_x' },
    })
    expect(widened.GH_TOKEN).toBe('gho_x')
    expect(widened.SSH_AUTH_SOCK).toBe('/tmp/agent')
  })
})

describe('§5.3 [F9] a child that exits 0 before the handshake is a FAILURE', () => {
  it('the flock case is `blocked:"socket_dir"` despite exit 0, and records no pgid (#46)', async () => {
    /* The bridge `flock`s `<api_socket>.lock` and, when another bridge owns it, prints a message
     * and returns `Ok(())`. Spawn-then-wait-for-socket would find the *incumbent's* socket and
     * record a pgid for a corpse. */
    const dead: SpawnedBridge = {
      pid: 4242,
      socketPath: '/tmp/x.sock',
      stderr: () => 'harness API bridge: another bridge already owns /tmp/x.sock; exiting',
      alive: () => false,
      exitCode: () => 0,
      kill: () => true,
    }
    await expect(
      launchBridge({
        binary: 'jcode',
        socketPath: '/tmp/swarm-flock-test.sock',
        jcodeHome: '/tmp/swarm-flock-home',
        runtimeDir: '/tmp/swarm-flock-runtime',
        daemonSocket: '/tmp/swarm-flock-runtime/jcode.sock',
        bridgeArgv: [],
        env: {},
        startupTimeoutMs: 100,
        inheritStderr: false,
        launcher: () => dead,
        /* The incumbent's socket is right there, and connecting to it is the trap. */
        socketExists: () => true,
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({ code: 'executor_unavailable' })
  })
})

describe('§5.3/§4.3.7 [F1] the hard kill reaches TWO groups', () => {
  it('signals the daemon group first, then the bridge group, and scans both', async () => {
    const signals: { pid: number; signal: string }[] = []
    const alive = new Set([700, 900])
    const result = await killTwoGroups({
      pgid: 700,
      daemonPid: 900,
      kill: (pid, signal) => {
        if (signal === 0) {
          if (!alive.has(Math.abs(pid))) throw new Error('ESRCH')
          return
        }
        signals.push({ pid, signal: String(signal) })
        if (signal === 'SIGTERM') alive.delete(Math.abs(pid))
      },
      sleep: () => Promise.resolve(),
      now: () => 0,
    })
    /* Order is normative: `kill(-daemonPid)` **then** `kill(-pgid)` (§5.3 step 3). */
    expect(signals.slice(0, 2)).toEqual([
      { pid: -900, signal: 'SIGTERM' },
      { pid: -700, signal: 'SIGTERM' },
    ])
    expect(result.survivors).toEqual([])
    expect(result.daemonStopped).toBe(true)
  })

  it('a daemon that survives lands in `survivors` and `daemonStopped:false` — never a stop', async () => {
    const result = await killTwoGroups({
      pgid: 700,
      daemonPid: 900,
      kill: (pid, signal) => {
        /* The immortal daemon: every liveness probe succeeds. */
        if (signal === 0 && Math.abs(pid) === 900) return
        if (signal === 0) throw new Error('ESRCH')
      },
      sleep: () => Promise.resolve(),
      now: () => 0,
    })
    expect(result.survivors).toEqual([900])
    /* `survivors: []` on a running agent is the failure this field exists to make impossible. */
    expect(result.daemonStopped).toBe(false)
  })

  it('no resolvable daemon pid ⇒ `daemonStopped:false`, because a partial stop is not a stop', async () => {
    const result = await killTwoGroups({
      pgid: 700,
      daemonPid: null,
      kill: (_pid, signal) => {
        if (signal === 0) throw new Error('ESRCH')
      },
      sleep: () => Promise.resolve(),
      now: () => 0,
    })
    expect(result.daemonStopped).toBe(false)
  })

  it('an instance with `pgid === null` refuses `hardKill` with `capability_absent`', async () => {
    const w = await wire()
    /* No spawn happened (the fake connects to a socket path), so there is no group swarm created
     * — and swarm never guesses a target, because the guess is its own process group. */
    await expect(w.instance.hardKill('test')).rejects.toMatchObject({ code: 'capability_absent' })
    await w.harness.dispose()
  })

  it('`daemonPid` is resolved from `servers.json` by socket path, exactly as the SDK does', () => {
    const registry = JSON.stringify([
      { socket: '/run/other/jcode.sock', pid: 111 },
      { socket: '/run/mine/jcode.sock', pid: 222 },
    ])
    expect(resolveDaemonPid('/home/j', '/run/mine/jcode.sock', () => registry)).toBe(222)
    /* `null` is a first-class answer, and the caller raises `notice{kind:'capability-absent'}`. */
    expect(resolveDaemonPid('/home/j', '/run/nobody/jcode.sock', () => registry)).toBeNull()
    expect(
      resolveDaemonPid('/home/j', '/run/mine/jcode.sock', () => {
        throw new Error('ENOENT')
      }),
    ).toBeNull()
  })
})

describe('§5.1 the adapter refuses a stale fence (§3.4 rule 1)', () => {
  it('a call whose token is below the highest observed for that key is `stale_fence`', async () => {
    const w = await wire()
    const key = sessionLease(w.session.sessionId)
    await w.session.applyConfig({ model: 'claude-opus-5' }, { key, token: 5 })
    await expect(
      w.session.applyConfig({ model: 'gpt-5.4' }, { key, token: 4 }),
    ).rejects.toMatchObject({ code: 'stale_fence' })
    await w.harness.dispose()
  })
})

describe('§5.1 `setCredential` takes one of the six ids the bridge accepts ([F17])', () => {
  it('refuses a key with surrounding whitespace, a newline or a NUL before the wire', async () => {
    const w = await wire()
    for (const bad of [' sk-x', 'sk-x\n', 'sk-x\0y']) {
      await expect(w.instance.setCredential('claude-api', bad)).rejects.toBeInstanceOf(SwarmError)
    }
    await w.instance.setCredential('claude-api', 'sk-good')
    expect(w.harness.bridge.credentials.get('claude-api')).toBe('sk-good')
    await w.harness.dispose()
  })
})

describe('§5.1 the adapter never claims a jcode adapter without a jcode binary', () => {
  it('`acquireInstance` refuses with `version_floor` when the gate fails', async () => {
    const adapter = createJcodeAdapter({
      transport: { connect: () => Promise.reject(new Error('never reached')) },
      versionProbe: () => ({ code: 0, stdout: 'jcode 0.64.2', stderr: '' }),
      socketPathOverride: '/tmp/never',
    })
    await expect(
      adapter.acquireInstance('anthropic/claude-api', {
        jcodeHome: '/tmp/nope',
        workingDir: '/tmp',
        inheritLogins: false,
        env: {},
        startupTimeoutMs: 10,
        cleanupTimeoutMs: 10,
        inheritStderr: false,
      }),
    ).rejects.toMatchObject({ code: 'version_floor' })
  })
})
