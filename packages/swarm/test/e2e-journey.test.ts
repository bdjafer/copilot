/**
 * The whole journey, once, against a **spawned** `swarm serve` (SPEC-swarm §7.1 H10, §13).
 *
 * `test/server-e2e.test.ts` already proves the client core drives an embedded server over a real
 * socket. This proves the two things an embedded server structurally cannot:
 *
 *  - **Pairing is real.** The token is obtained by `POST /pair` with the one-time code the daemon
 *    printed on its own stdout — not by reaching into `server.tokens`. Every other suite hands
 *    itself a token, which makes §2.1's pairing path the one door in the product that only fakes
 *    have ever walked through.
 *  - **A crash is a crash.** The server is `SIGKILL`ed mid-stream, with an attempt live and an
 *    `attempt:*` subscription open. Nothing flushes, no lease is released, `runtime.json` is
 *    whatever it was. Then it comes back on the same port from the same `$SWARM_HOME`, and the
 *    head — which never learned any of this happened, and holds nothing but `(stream, seq)` —
 *    resumes from its durable cursor and catches up to the server's head exactly.
 *
 * One `it`, because the point is the *journey*: the state a beat leaves behind is the state the
 * next beat needs, and splitting it would replace that with a fixture. The executor is
 * `MockExecutor`; everything else — the process, the socket, the scheduler, the verifier, the
 * SQLite log, the token store — is production code.
 *
 * Node ≥ 24; testing-only.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { SwarmError } from '../src/errors.ts'
import type { StreamName } from '../src/protocol/frames.ts'
import type {
  AcceptanceCriterion,
  CreateDelegationInput,
  DelegationVM,
  SwarmClient,
  TurnDirective,
  TurnVM,
} from '../src/types.ts'
import type { ScratchRepo } from './support/server-harness.ts'
import type { SpawnedServer } from './support/spawned-server.ts'

import { webSocketTransport } from '../src/cli/ws-transport.ts'
import { createSwarmClient } from '../src/client/index.ts'
import { CLOSE_CODES } from '../src/protocol/constants.ts'
import { createScratchRepo } from './support/server-harness.ts'
import {
  EXTENSION_ORIGIN,
  get,
  handshakeCloseCode,
  pair,
  spawnServeMock,
} from './support/spawned-server.ts'

const servers: SpawnedServer[] = []
const repos: ScratchRepo[] = []
const clients: SwarmClient[] = []
const homes: string[] = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.destroy()
  for (const server of servers.splice(0)) await server.kill()
  for (const repo of repos.splice(0)) repo.dispose()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

async function waitUntil<T>(
  probe: () => T | null | undefined | false,
  what: string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = probe()
    if (value !== null && value !== undefined && value !== false) return value
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await new Promise((settle) => setTimeout(settle, 25))
  }
}

/**
 * `sendTurn`, with the refusal code in the failure message.
 *
 * §9/#24: a domain refusal is a **value**, not an exception — `turn_in_flight` and
 * `budget_exhausted` are expected outcomes. That is right for the product and wrong for a test
 * assertion, where `expect(result.ok).toBe(true)` reports `false` and swallows the one thing that
 * would explain it.
 */
async function say(
  client: SwarmClient,
  id: string,
  text: string,
  idempotencyKey: string,
  extra: Partial<TurnDirective> = {},
): Promise<string> {
  const result = await client.sendTurn(id, { text, idempotencyKey, ...extra })
  if (result.ok) return result.value
  throw new Error(
    `sendTurn(${idempotencyKey}) refused: ${result.error.code} — ${result.error.message}`,
  )
}

/**
 * Two criteria that a verifier can actually run, and that pass on an untouched scratch repo.
 *
 * The command is a **shell builtin**, deliberately: VE7 scrubs the environment the criterion runs
 * in, so a criterion that shells out to a binary is also testing whether `PATH` survived the
 * scrub. That is a real question, and it is a different one from this test's.
 */
const ACCEPTANCE: readonly AcceptanceCriterion[] = [
  { kind: 'file', id: 'readme', label: 'README.md is present', path: 'README.md', must: 'exist' },
  {
    kind: 'command',
    id: 'readme-readable',
    label: 'the worktree still has a readable README',
    command: 'test -r README.md',
    timeoutMs: 10_000,
    expectExit: 0,
  },
]

function inputFor(
  workspaceId: string,
  objective: string,
  key: string,
  acceptance: readonly AcceptanceCriterion[] = ACCEPTANCE,
): CreateDelegationInput {
  return {
    idempotencyKey: key,
    title: objective,
    spec: {
      specVersion: 1,
      objective,
      acceptance,
      workspace: { workspaceId, baseRef: 'HEAD' },
      /* The delegation default the ladder falls back to, so Q4's reset is observable. */
      model: { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: 'medium' },
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
      delivery: { mode: 'after-turn', notify: 'silent' },
      parallelAttempts: 1,
    },
  } as unknown as CreateDelegationInput
}

describe('§13 the full journey against a spawned `swarm serve`, over real pairing and a real socket', () => {
  it(
    'pairs → creates with acceptance → streams turns → changes effort per turn → verifies → ' +
      'reopens on a follow-up → cancels → survives a SIGKILL mid-stream and resumes gapless',
    async () => {
      const repo = createScratchRepo({ workspaceId: 'journey' })
      repos.push(repo)
      const home = mkdtempSync(join(tmpdir(), 'swarm-journey-'))
      homes.push(home)

      /* ------------------------------------------------------------------ 1. the daemon boots */
      let server = await spawnServeMock({ home, workspaceRoot: repo.root, workspaceId: 'journey' })
      servers.push(server)
      const port = server.port
      expect(port).toBeGreaterThan(0)

      /* ------------------------------------------- 2. pairing, over HTTP, with the printed code */
      /* The origin gate first, because it is the one that shipped broken (**[E2]**): a real MV3
       * head was refused `403: forbidden origin` in Chrome and could never pair. A page origin is
       * still refused — an allowlist that does not exclude is a gate that does not gate — and this
       * is also the control that proves the `Origin` header below is really being sent. */
      const fromAPage = await pair(port, server.pairingCode, { origin: 'https://evil.example' })
      expect(fromAPage.status).toBe(403)
      expect(fromAPage.token).toBeUndefined()

      /* A second use of a one-time code must fail, so the *first* use is proven to be the thing
       * that consumed it rather than an endpoint that hands out tokens to anyone who asks. */
      const paired = await pair(port, server.pairingCode)
      expect(paired.status).toBe(200)
      const token = paired.token!
      expect(token.length).toBeGreaterThan(0)

      const replay = await pair(port, server.pairingCode)
      expect(replay.status).toBe(401)
      expect(replay.token).toBeUndefined()

      /* The upgrade is the second door the same allowlist guards, and it is the one the head
       * actually lives behind. Both branches, over a real socket. `null` is "still open after the
       * grace window" — §2.1 refuses by completing the upgrade and closing 4003, so a refused
       * handshake opens first and only the close code separates the two. */
      expect(await handshakeCloseCode(port, token, EXTENSION_ORIGIN)).toBe(null)
      expect(await handshakeCloseCode(port, token, 'https://evil.example')).toBe(
        CLOSE_CODES.forbidden,
      )

      /* ------------------------------------------------ 3. the head, over the identical core */
      const errors: SwarmError[] = []
      const turnsPrepared: TurnVM[] = []
      const client = createSwarmClient({
        transport: webSocketTransport({ url: `ws://127.0.0.1:${port}/swarm`, token }),
        clientName: 'e2e-journey/0.1',
        head: 'extension',
        onError: (error) => errors.push(error),
      })
      clients.push(client)
      client.on('turn:prepared', (event) => turnsPrepared.push(event.turn))

      await waitUntil(() => client.connection.get().status === 'connected', 'the head to connect')
      /* The snapshot counter is the resume proof later, so it is read here as a baseline rather
       * than assumed: `server` and `fleet` are pinned from construction (§2.5 rule 2). */
      await waitUntil(() => (client.inspect().counters.snapshots ?? 0) >= 2, 'the pinned snapshots')

      /* --------------------------------------- 4. create, with acceptance criteria that run */
      const created = await client.createDelegation(
        inputFor('journey', 'leave the scratch repo exactly as it is', 'journey-create'),
      )
      expect(created.ok).toBe(true)
      if (!created.ok) return
      const id = created.value

      const vm = (): DelegationVM | undefined => client.delegations.get().get(id)
      const first = await waitUntil(vm, 'the delegation to reach the head')
      /* `fleet` is pinned and carries the summary; `delegation:<id>` — where `deleg.turn_prepared`
       * lives — is subscribed by FOCUS and only by focus (§6.2, §2.5 rule 2's resubscribe order).
       * A head that never focuses sees the fleet move and never learns why, which is exactly the
       * shape §2.3 intends: attention is pinned, detail is opt-in. */
      client.focus(id)
      await waitUntil(
        () => client.inspect().streams.some((s) => s.stream === `delegation:${id}`),
        'the delegation stream to be subscribed on focus',
      )
      /* C4b: what the user typed AND what it resolved to, both over the wire. */
      expect(first.baseRef).toBe('HEAD')
      expect(first.baseRevision).toBe(repo.head)
      expect(first.acceptance.map((c) => c.id)).toEqual(['readme', 'readme-readable'])

      /* ------------------------------------------- 5. the scheduler admits and the turns stream */
      const started = await waitUntil(
        () => vm()?.attempts[0]?.id,
        'the first attempt to be admitted',
      )
      /* Ref-counted: this is the `attempt:*` subscription that is open when the server dies. */
      const transcript = client.transcript(started)
      await waitUntil(
        () => client.inspect().streams.some((s) => s.stream === `attempt:${started}`),
        'the attempt stream to be subscribed',
      )

      /* -------------------------------------------------- 6. verification runs, verdict lands */
      await waitUntil(() => vm()?.verdict === 'verified', 'the first attempt to be verified')
      const verified = vm()!
      expect(verified.state).toBe('succeeded')
      /* Both criteria, actually run by swarm's verifier — not reported by the agent (§4.3.6). */
      expect(verified.acceptance.map((c) => c.status)).toEqual(['pass', 'pass'])
      /* `succeeded && !landed` is the bucket F1 exists for. */
      expect(verified.landed).toBe(false)
      expect(verified.bucket).toBe('done-unlanded')

      /* --------------------------------- 7. a follow-up REOPENS as attempt N+1 (D19, Q2, #22) */
      const reopen = await say(client, id, 'One more pass, please.', 'journey-reopen')
      await waitUntil(() => vm()?.verdict === null, 'the reopen to clear the verdict')
      await waitUntil(
        () => (vm()?.attempts.length ?? 0) >= 2,
        'the reopen to be admitted as attempt 2',
      )
      /* D19 again, on the other axis: the reopen clears the verdict and RETAINS `landed`. */
      expect(vm()!.landed).toBe(false)
      expect(
        (
          await waitUntil(
            () => turnsPrepared.find((turn) => turn.id === reopen),
            'the reopening turn to be prepared',
          )
        ).effective.reasoningEffort,
      ).toBe('medium')
      await waitUntil(() => vm()?.verdict === 'verified', 'the reopened attempt to be verified')

      /* ---------------------------- 8. a per-turn effort change, mid-delegation (§4.3.1, C7) */
      const raised = await say(client, id, 'Think harder about this one.', 'journey-effort-max', {
        reasoningEffort: 'max',
      })
      const maxTurn = await waitUntil(
        () => turnsPrepared.find((turn) => turn.id === raised),
        'the raised turn to be prepared',
      )
      expect(maxTurn.effective.reasoningEffort).toBe('max')
      /* Never observable through protocol v1 — a literal, not a convention (#7, §4.3.4). */
      expect(maxTurn.effortConfirmed).toBe(false)
      await waitUntil(() => vm()?.verdict === 'verified', 'the raised-effort turn to settle')

      /* Q4: the OMISSION on the next turn resets to the delegation default, never to `max`. That
       * reset is the whole reason the override is per-turn rather than a mode — a raise that
       * stuck would be a mode the user never chose and cannot see. */
      const relaxed = await say(client, id, 'Back to normal.', 'journey-effort-default')
      const defaultTurn = await waitUntil(
        () => turnsPrepared.find((turn) => turn.id === relaxed),
        'the un-overridden turn to be prepared',
      )
      expect(defaultTurn.effective.reasoningEffort).toBe('medium')
      await waitUntil(() => vm()?.verdict === 'verified', 'the last turn to be verified')
      /* Every turn since the reopen ran on its own attempt: a follow-up on a settled delegation
       * is a new attempt, never an edit of the one that already has a verdict (§3.3, D19). */
      expect(vm()!.attempts.length).toBeGreaterThanOrEqual(4)

      /* ------------------------------------------------------------------- 9. the cancel path */
      /* The brake first (Q16, §3.5), for two reasons. It is the only way to hold a delegation in
       * `queued` long enough to cancel it deterministically — `MockExecutor` runs a whole attempt
       * in single-digit milliseconds — and a pause that did not actually stop admission would
       * show up here as a delegation that ran anyway. */
      expect((await client.pauseDispatch({ fleet: true }, true)).ok).toBe(true)
      await waitUntil(() => client.fleet.get().dispatchPaused, 'the fleet brake to engage')

      const doomed = await client.createDelegation(
        inputFor('journey', 'never get to run at all', 'journey-cancel'),
      )
      expect(doomed.ok).toBe(true)
      if (!doomed.ok) return
      const doomedVm = (): DelegationVM | undefined => client.delegations.get().get(doomed.value)
      const queued = await waitUntil(doomedVm, 'the doomed delegation to reach the head')
      expect(queued.state).toBe('queued')
      expect(queued.attempts).toEqual([])

      const cancelled = await client.cancel(doomed.value, { scope: 'delegation' })
      expect(cancelled.ok ? null : cancelled.error.code).toBeNull()
      const afterCancel = await waitUntil(
        () => (doomedVm()?.state === 'cancelled' ? doomedVm() : null),
        'the cancellation to reach the head',
      )
      /* A cancel is terminal for the delegation and leaves nothing live behind (§3.3). */
      expect(afterCancel.liveAttemptIds).toEqual([])
      /* And it never ran: the brake held, so this is a cancellation rather than a race won. */
      expect(afterCancel.attempts).toEqual([])

      expect((await client.pauseDispatch({ fleet: true }, false)).ok).toBe(true)
      await waitUntil(() => !client.fleet.get().dispatchPaused, 'the fleet brake to release')

      /* ------------------------------------------- 10. a second delegation, live mid-stream */
      const running = await client.createDelegation(
        inputFor('journey', 'be running when the lights go out', 'journey-crash'),
      )
      expect(running.ok).toBe(true)
      if (!running.ok) return
      const crashId = running.value
      const crashAttempt = await waitUntil(
        () => client.delegations.get().get(crashId)?.attempts[0]?.id,
        'the second delegation to be admitted',
      )
      const crashTranscript = client.transcript(crashAttempt)
      await waitUntil(
        () => client.inspect().streams.some((s) => s.stream === `attempt:${crashAttempt}`),
        'the second attempt stream to be subscribed',
      )

      /* ----------------------------------------------------------- 11. SIGKILL, mid-stream */
      /* Every subscribed stream must have completed its FIRST subscription before the baseline is
       * taken. §2.3 rule 3 is explicit that a stream which never got its snapshot resumes from
       * `'snapshot'` rather than from a cursor — correctly, since there is no state to apply a
       * delta to — so a baseline taken mid-handshake would make the resume assertion below fail
       * for a reason that has nothing to do with the crash. */
      await waitUntil(() => {
        const state = client.inspect()
        return (state.counters.snapshots ?? 0) >= state.streams.length
      }, 'every subscribed stream to have received its snapshot')

      const beforeCrash = client.inspect()
      const snapshotsBefore = beforeCrash.counters.snapshots!
      const seqBefore = new Map(beforeCrash.streams.map((s) => [s.stream, s.seq]))
      expect(seqBefore.get('fleet')).toBeGreaterThan(0)

      await server.kill()
      servers.splice(servers.indexOf(server), 1)
      await waitUntil(
        () => client.connection.get().status !== 'connected',
        'the head to notice the server is gone',
      )
      /* A dropped socket is not a refusal: nothing here may be terminal (§2.5 rule 4). */
      expect(client.connection.get().blockedReason).toBeNull()

      /* An intent issued into the dark. §2.5 rule 3 queues it offline and re-sends it on the next
       * `hello_ok`, which is what makes the reconnect below produce log records the head has not
       * seen — the server writes nothing at boot on its own, so without this the "replay" would
       * have nothing to replay and the assertion would be vacuous. It also proves the thing a
       * user actually cares about after a crash: the button they pressed was not swallowed. */
      const queuedCancel = client.cancel(crashId, { scope: 'delegation' })
      await waitUntil(
        () => client.connection.get().queuedOffline > 0,
        'the cancel to be queued offline',
      )

      /* ------------------------- 12. same port, same $SWARM_HOME, same swarm.db, same tokens */
      server = await spawnServeMock({
        home,
        workspaceRoot: repo.root,
        workspaceId: 'journey',
        port,
      })
      servers.push(server)
      expect(server.port).toBe(port)

      await waitUntil(
        () => client.connection.get().status === 'connected',
        'the head to reconnect to the restarted server',
        90_000,
      )

      /* --------------------------------------------------- 13. resumed, replayed, and gapless */
      /* A gap is a bug, not a lag signal (§2.3 rule 1): the client raises one by name, and none
       * was raised. Asserting on the message is deliberate — the *absence* of a `stream:lagged`
       * event would also be satisfied by a client that stopped reading. */
      expect(errors.filter((error) => error.message.startsWith('gap on '))).toEqual([])
      expect(errors.filter((error) => error.code === 'bad_cursor')).toEqual([])

      /* The re-sent intent lands on the restarted server, which authenticated it with the token
       * `POST /pair` issued before the crash: `tokens.json`, not memory. */
      const replayed = await queuedCancel
      expect(replayed.ok ? null : replayed.error.code).toBeNull()
      const stopped = await waitUntil(
        () =>
          client.delegations.get().get(crashId)?.state === 'cancelled'
            ? client.delegations.get().get(crashId)
            : null,
        'the offline cancel to take effect after the reconnect',
      )
      expect(stopped.liveAttemptIds).toEqual([])

      /* The resume was from the durable cursor, not a re-snapshot. This is the load-bearing
       * assertion of the whole restart: a client that silently re-snapshotted everything would
       * also end up consistent, and would have proven nothing about §2.3's replay. `server` and
       * `fleet` were already pinned before the crash, so a forced re-snapshot of either would
       * show up here as a bump — and so would the `'snapshot'` a detected gap forces (rule 1). */
      const resumed = client.inspect()
      expect(resumed.counters.snapshots).toBe(snapshotsBefore)
      expect(resumed.connection.serverVersion).toBe(beforeCrash.connection.serverVersion)

      /* The numbering CONTINUED. A restarted server whose log had started over at `seq 1` would
       * have replayed nothing (every record at or below the cursor is dropped) or produced a gap;
       * a cursor strictly past the pre-crash value, reached without a snapshot, is only possible
       * if `swarm.db` came back with its sequence intact. */
      const fleetSeq = resumed.streams.find((s) => s.stream === 'fleet')!.seq
      expect(fleetSeq).toBeGreaterThan(seqBefore.get('fleet') ?? 0)

      /* And the cursor is the server's own head, not merely larger than it was — so nothing the
       * restarted server wrote is still outstanding. */
      const heads = (await get(port, '/debug/streams', token)) as {
        stream: string
        head: number
      }[]
      const fleetHead = heads.find((row) => row.stream === 'fleet')!.head
      await waitUntil(
        () => client.inspect().streams.find((s) => s.stream === 'fleet')!.seq === fleetHead,
        `the head cursor to reach the server's fleet head (${fleetHead})`,
      )

      /*
       * …and the same, for the `attempt:*` stream that was **live at the SIGKILL**.
       *
       * Every cursor assertion above is about `fleet`, which is the stream the restarted server is
       * guaranteed to write to. The attempt streams rode on the `snapshots >= streams.length`
       * inequality instead — which an attempt stream *dropped entirely* would also satisfy, since
       * a stream that is gone contributes to neither side. Named explicitly here: still
       * subscribed, cursor not rewound, and caught up to the server's own head for that stream.
       */
      const crashStream: StreamName = `attempt:${crashAttempt}`
      const crashCursor = resumed.streams.find((s) => s.stream === crashStream)
      expect(crashCursor, `${crashStream} must still be subscribed after the restart`).toBeDefined()
      expect(crashCursor!.seq).toBeGreaterThanOrEqual(seqBefore.get(crashStream) ?? 0)
      const crashHead = heads.find((row) => row.stream === crashStream)?.head
      if (crashHead !== undefined) {
        await waitUntil(
          () => client.inspect().streams.find((s) => s.stream === crashStream)!.seq === crashHead,
          `the head cursor to reach the server's ${crashStream} head (${crashHead})`,
        )
      }

      /* And what became of the attempt itself. One that was mid-stream when the process died must
       * not come back claiming to be live or streaming: the offline cancel landed, so it is off
       * the live list and out of every in-flight channel state. §3.3 leaves `unknown` resolvable
       * rather than resting; what must never survive a crash is `streaming`. */
      const crashAttemptVM = client.delegations
        .get()
        .get(crashId)
        ?.attempts.find((a) => a.id === crashAttempt)
      expect(crashAttemptVM?.live ?? false).toBe(false)
      expect(['streaming', 'submitting', 'accepted']).not.toContain(crashAttemptVM?.channel)

      /* The fleet survived the crash whole, including the delegation cancelled before it. */
      expect(client.delegations.get().get(id)?.state).toBe('succeeded')
      expect(client.delegations.get().get(doomed.value)?.state).toBe('cancelled')

      transcript.release()
      crashTranscript.release()
    },
    240_000,
  )
})
