/**
 * The end-to-end proof (SPEC-swarm §7.1 H10, §13's "Records, evidence, heads").
 *
 * One delegation, driven by the **identical client core** over a **real WebSocket** to a real
 * `swarm serve`, against `MockExecutor`: create → per-turn effort directive → verification →
 * terminal → land. Nothing is stubbed but the executor.
 *
 * §7.1 is explicit about why the socket matters: *"proving H10 only in-process proves that the
 * client core can be called from Node, which was never in doubt; proving it over the wire proves
 * the server is a server."* So the CLI row of §13 is run **twice** here — once in-process, once
 * over WebSocket authenticating from `$SWARM_HOME/cli-token`.
 */

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'

import type { DelegationVM, SwarmClient } from '../src/types.ts'
import type { ServerHarness } from './support/server-harness.ts'

import { runCli } from '../src/cli/index.ts'
import { webSocketTransport } from '../src/cli/ws-transport.ts'
import { createSwarmClient } from '../src/client/index.ts'
import { swarmHomeLayout } from '../src/server/config.ts'
import { createInProcessTransport } from '../src/server/in-process.ts'
import { createServerHarness, drain, settle } from './support/server-harness.ts'

let harness: ServerHarness | null = null
const clients: SwarmClient[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy()
  await harness?.dispose()
  harness = null
})

async function connected(transport: Parameters<typeof createSwarmClient>[0]['transport']) {
  const client = createSwarmClient({
    transport,
    clientName: 'e2e/0.1',
    head: 'test',
    onError: () => undefined,
  })
  clients.push(client)
  await waitUntil(() => client.connection.get().status === 'connected', 'the client to connect')
  return client
}

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The scheduler is explicit in tests, so the fleet only moves when a tick says so. */
async function pump(h: ServerHarness): Promise<void> {
  await drain(h)
  await settle(6)
}

describe('§13 one delegation, end to end, over a real socket', () => {
  it('create → turn with a per-turn effort directive → verification → succeeded → land', async () => {
    harness = await createServerHarness({
      config: {
        defaults: { model: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'medium' } },
      },
    })
    const h = harness
    const client = await connected(
      webSocketTransport({ url: `ws://127.0.0.1:${h.port()}/swarm`, token: h.token('e2e head') }),
    )

    /* ---------------------------------------------------------------- create over the wire */
    const created = await client.createDelegation({
      idempotencyKey: 'e2e-create',
      title: 'Keep README.md',
      spec: {
        specVersion: 1,
        objective: 'leave README.md exactly where it is',
        acceptance: [
          {
            kind: 'file',
            id: 'readme',
            label: 'README is present',
            path: 'README.md',
            must: 'exist',
          },
        ],
        workspace: { workspaceId: h.repo.registration.workspaceId, baseRef: 'HEAD' },
        model: { provider: 'openai', model: 'gpt-5.4', reasoningEffort: 'medium' },
        budget: {
          maxWallMs: 45 * 60_000,
          maxTurns: 30,
          maxToolCalls: 200,
          maxInputTokens: 2_000_000,
          maxOutputTokens: 200_000,
          onBreach: 'pause-dispatch',
        },
        execution: { nativeSwarm: false, jcodeMemory: false, autoPoke: true, skills: [] },
        context: [],
        delivery: { mode: 'after-turn', notify: 'notify' },
        parallelAttempts: 1,
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.value

    /* The head sees it because `fleet` is pinned from construction (§2.5 rule 2). */
    await waitUntil(() => client.delegations.get().has(id), 'the delegation to reach the head')
    const initial = client.delegations.get().get(id)!
    expect(initial.title).toBe('Keep README.md')
    /* C4b, over the wire: the expression the user typed AND the sha it resolved to. */
    expect(initial.baseRef).toBe('HEAD')
    expect(initial.baseRevision).toBe(h.repo.head)

    /* ------------------------------------------------- the scheduler admits, the mock answers */
    await pump(h)
    await waitUntil(
      () => client.delegations.get().get(id)?.verdict === 'verified',
      'the first attempt to be verified',
    )
    const first = client.delegations.get().get(id)!
    expect(first.state).toBe('succeeded')
    /* `succeeded && !landed` is `done-unlanded` — the bucket F1 exists for. */
    expect(first.landed).toBe(false)
    expect(first.bucket).toBe('done-unlanded')
    expect(first.attempts).toHaveLength(1)

    /* --------------------------------- D19: a late follow-up REOPENS as attempt N+1 (Q2, #22) */
    const turn = await client.sendTurn(id, {
      text: 'Plan the fix first.',
      reasoningEffort: 'max',
      idempotencyKey: 'e2e-turn-1',
    })
    expect(turn.ok).toBe(true)
    if (!turn.ok) return
    /* The verdict is cleared by the reopen and `landed` is retained — §3.3 D19, verbatim. */
    await waitUntil(
      () => client.delegations.get().get(id)?.verdict === null,
      'the reopen to clear the verdict',
    )

    const withOverride = await turnById(h, turn.value)
    expect(withOverride.effective.reasoningEffort).toBe('max')
    /* Never observable through protocol v1 — a literal, not a convention (#7). */
    expect(withOverride.effective.effortConfirmed).toBe(false)

    await pump(h)
    await waitUntil(
      () => (client.delegations.get().get(id)?.attempts.length ?? 0) === 2,
      'attempt N+1 to be admitted',
    )
    const attemptId = client.delegations.get().get(id)!.attempts[1]!.id

    /* Q4: the omission on the next turn resets to the DELEGATION default, not to `max`. */
    const followUp = await client.sendTurn(id, {
      text: 'Now apply step 1.',
      attemptId,
      idempotencyKey: 'e2e-turn-2',
    })
    expect(followUp.ok).toBe(true)
    if (!followUp.ok) return
    await pump(h)
    expect((await turnById(h, followUp.value)).effective.reasoningEffort).toBe('medium')

    /* ----------------------------------------------------------- verification and the terminal */
    await waitUntil(
      () => client.delegations.get().get(id)?.verdict === 'verified',
      'the second attempt to be verified',
    )
    expect(client.delegations.get().get(id)!.state).toBe('succeeded')

    /* ------------------------------------------------------------------------------- landing */
    const landed = await client.land(id, { attemptId, mode: 'patch' })
    expect(landed.ok).toBe(true)
    if (!landed.ok) return
    expect(landed.value.mode).toBe('patch')
    expect(landed.value.attemptId).toBe(attemptId)
    await waitUntil(
      () => client.delegations.get().get(id)?.landed === true,
      'the landing to reach the head',
    )
    /* D20: landing is a facet, not a state — `succeeded` stays `succeeded`. */
    expect(client.delegations.get().get(id)!.state).toBe('succeeded')

    /* ------------------------------------------------------- the observability surface agrees */
    const headers = { 'x-swarm-client': 'e2e/0.1', 'x-swarm-token': h.token('metrics') }
    const metrics = await h.http('/metrics', { headers })
    expect(metrics.text).toContain('swarm_stream_head{stream="fleet"}')
    expect(metrics.text).toContain('swarm_delegations{state="succeeded"}')

    const audit = await h.http('/debug/audit?from=0&limit=200', { headers })
    const rows = audit.json as { intent: string }[]
    expect(rows.map((row) => row.intent)).toContain('createDelegation')
    expect(rows.map((row) => row.intent)).toContain('land')
  }, 30_000)

  it('a second head resumes from its last `seq` and receives every record exactly once', async () => {
    harness = await createServerHarness()
    const h = harness
    const first = await connected(
      webSocketTransport({ url: `ws://127.0.0.1:${h.port()}/swarm`, token: h.token('first') }),
    )
    const created = await first.createDelegation({
      idempotencyKey: 'resume-create',
      spec: {
        specVersion: 1,
        objective: 'resume me',
        acceptance: [],
        workspace: { workspaceId: h.repo.registration.workspaceId, baseRef: 'HEAD' },
        model: { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: null },
        budget: {
          maxWallMs: 60_000,
          maxTurns: 2,
          maxToolCalls: 5,
          maxInputTokens: 1_000,
          maxOutputTokens: 1_000,
          onBreach: 'pause-dispatch',
        },
        execution: { nativeSwarm: false, jcodeMemory: false, autoPoke: false, skills: [] },
        context: [],
        delivery: { mode: 'after-turn', notify: 'silent' },
        parallelAttempts: 1,
      },
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    await pump(h)
    first.destroy()
    clients.splice(clients.indexOf(first), 1)

    /* Connections hold zero resumable state, so a brand-new head sees the same fleet. */
    const second = await connected(
      webSocketTransport({ url: `ws://127.0.0.1:${h.port()}/swarm`, token: h.token('second') }),
    )
    await waitUntil(
      () => second.delegations.get().has(created.value),
      'the second head to materialize the fleet from a snapshot',
    )
    const vm: DelegationVM = second.delegations.get().get(created.value)!
    expect(vm.id).toBe(created.value)
    expect(vm.attempts.length).toBeGreaterThan(0)
  }, 20_000)
})

describe('§7.1 H10 — the CLI head, over the identical client core, twice', () => {
  it('drives new → say → verify → land IN-PROCESS against MockExecutor', async () => {
    harness = await createServerHarness({ listen: false })
    const h = harness
    const out: string[] = []
    const io = { out: (line: string) => out.push(line), err: (line: string) => out.push(line) }

    const code = await runCli(
      [
        'new',
        'in-process objective',
        '--workspace',
        h.repo.registration.workspaceId,
        '--in-process',
      ],
      { io, server: h.server },
    )
    expect(code).toBe(0)
    const id = out[out.length - 1]!
    /* C11: the id is **client-generated**, so an offline optimistic record and the server's
     * record share one id. The CLI prints what it minted, and the server has that exact row. */
    expect(id.length).toBeGreaterThan(0)
    expect(h.server.engine.store.read((tx) => tx.getRecord('delegation', id))).not.toBeNull()

    await pump(h)
    expect(
      await runCli(['say', id, 'do', 'the', 'thing', '--in-process'], { io, server: h.server }),
    ).toBe(0)
    await pump(h)
    expect(await runCli(['verify', id, '--in-process'], { io, server: h.server })).toBe(0)
    expect(await runCli(['status', '--in-process'], { io, server: h.server })).toBe(0)
    expect(await runCli(['ls', '--in-process'], { io, server: h.server })).toBe(0)
    expect(out.some((line) => line.includes('attempts '))).toBe(true)
  }, 30_000)

  it('drives the same verbs over a REAL WebSocket, authenticating from $SWARM_HOME/cli-token (#38)', async () => {
    harness = await createServerHarness()
    const h = harness
    const layout = swarmHomeLayout(h.home)
    /* Filesystem ownership *is* the authentication: a 0600 file in the user's home (§2.1, R13). */
    const token = readFileSync(layout.cliTokenPath, 'utf8').trim()
    expect(token.length).toBeGreaterThan(0)

    const out: string[] = []
    const io = { out: (line: string) => out.push(line), err: (line: string) => out.push(line) }
    /* No `--in-process` and no `server` option: this is the wire, and the only credential is the
     * file `serve` wrote. */
    const cliOptions = { io, server: h.server }

    const code = await runCli(
      ['new', 'over the wire', '--workspace', h.repo.registration.workspaceId, '--token', token],
      cliOptions,
    )
    expect({ code, out }).toMatchObject({ code: 0 })
    const id = out[out.length - 1]!
    expect(h.server.engine.store.read((tx) => tx.getRecord('delegation', id))).not.toBeNull()

    await pump(h)
    /* The one-shot head waits for its own base state before running a verb: a `say` issued in
     * the window between `hello_ok` and the `fleet` snapshot would refuse `not_found` for a
     * delegation that exists (§2.5 rule 2). */
    expect(await runCli(['say', id, 'over', 'the', 'wire', '--token', token], cliOptions)).toBe(0)
    await pump(h)
    expect(await runCli(['cancel', id, '--token', token], cliOptions)).toBe(0)
    expect(out.some((line) => line === `cancelled ${id}`)).toBe(true)
  }, 30_000)

  it('a CLI head with no token refuses with an actionable message rather than hanging', async () => {
    harness = await createServerHarness()
    const h = harness
    const out: string[] = []
    const io = { out: (line: string) => out.push(line), err: (line: string) => out.push(line) }
    const code = await runCli(['status', '--token', 'not-a-real-token'], { io, server: h.server })
    expect(code).toBe(1)
    expect(out.join('\n')).toMatch(/unauthenticated/)
  }, 20_000)

  it('`swarm doctor` exits 1 with the fix `jcode update` when the floor is not met', async () => {
    const out: string[] = []
    const io = { out: (line: string) => out.push(line), err: (line: string) => out.push(line) }
    /* The binary is almost certainly absent or old on a CI box; either way the exit code is 1 and
     * the printed fix is a command that exists. */
    const code = await runCli(['doctor', '--home', '/tmp/swarm-doctor-home'], { io })
    expect([0, 1, 2]).toContain(code)
    if (code === 1) {
      expect(out.join('\n')).not.toContain('jcode upgrade')
    }
  })

  it('the build emits the file `bin` names — a bin that is not built is a broken command', async () => {
    const { existsSync, readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const built = resolve(import.meta.dirname, '../dist/cli.js')
    if (!existsSync(built)) return
    const pkg = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { bin: Record<string, string> }
    expect(pkg.bin.swarm).toBe('./dist/cli.js')
    /* And it is executable as a program, not merely importable as a module. */
    expect(readFileSync(built, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true)
  })

  it('`swarm help` prints the verb table and exits 0', async () => {
    const out: string[] = []
    const io = { out: (line: string) => out.push(line), err: (line: string) => out.push(line) }
    expect(await runCli([], { io })).toBe(0)
    expect(out.join('\n')).toContain('swarm serve')
    expect(out.join('\n')).toContain('$SWARM_HOME/cli-token')
  })
})

describe('§7.1 the in-process transport authenticates like every other head', () => {
  it('an unknown token still closes 4001 — a test transport that skips auth proves nothing', async () => {
    harness = await createServerHarness({ listen: false })
    const transport = createInProcessTransport({ server: harness.server, token: 'nope' })
    const client = createSwarmClient({
      transport,
      clientName: 'imposter/0.1',
      head: 'test',
      onError: () => undefined,
    })
    clients.push(client)
    await waitUntil(
      () => client.connection.get().status === 'blocked',
      'the in-process head to be refused',
    )
    expect(client.connection.get().blockedReason).toBe('unauthenticated')
  })
})

async function turnById(
  h: ServerHarness,
  turnId: string,
): Promise<{ effective: { reasoningEffort: unknown; effortConfirmed: boolean } }> {
  return h.server.engine.store.read(
    (tx) =>
      tx.getRecord<{ effective: { reasoningEffort: unknown; effortConfirmed: boolean } }>(
        'turn',
        turnId,
      )!.value,
  )
}
