/**
 * SPEC-swarm §6.2 — `TranscriptHandle` and `DiffHandle`, the two ref-counted surfaces.
 *
 * `client-streams` proves the *subscription* is ref-counted; this file proves the view models
 * those handles publish are the ones §6.2 declares. Four rules carry the weight:
 *
 *  - **reasoning is its own channel** (W1): `{k:'reasoning', collapsed:true}`, never merged into
 *    the assistant's text, because a head that renders them as one paragraph is claiming the model
 *    said something it only thought.
 *  - **one tool call is one entry** that moves `start → exec → done`, keyed by `callId` — the id
 *    the adapter has already attributed, since `tool_input_delta` reaches it with `call_id: ''`
 *    ([F11], §6.4). Four entries per call would make a two-tool turn unreadable.
 *  - **background progress is scraped, never state** (#16, W11): it carries
 *    `provenance:'scraped'` verbatim so a head can label it honestly.
 *  - **`loadOlder` is local** — `swarm.v1` has no history-paging frame, so the handle reveals more
 *    of a ring it already holds and says so through `hasOlder`, instead of writing a frame no
 *    server answers.
 */

import { describe, expect, it } from 'vitest'

import type { TranscriptEntry } from '../src/types.ts'

import { TRANSCRIPT_WINDOW } from '../src/client/transcript.ts'
import { createTestClient, makeAttemptSnapshot } from '../src/testing/client-harness.ts'
import { makeDelegationVM, makeTurnDirective } from '../src/testing/fixtures.ts'

const TS = 5_000

function attemptClient(): ReturnType<typeof createTestClient> {
  const harness = createTestClient({ startAtMs: TS })
  harness.start()
  return harness
}

describe('§6.2 TranscriptVM — the entry kinds', () => {
  it('keeps reasoning on its own collapsed channel and never merges it into text (W1)', () => {
    const harness = attemptClient()
    const handle = harness.client.transcript('a1')
    harness.transport.snap('attempt:a1', 0, makeAttemptSnapshot({ attemptId: 'a1' }))
    harness.transport.evt('attempt:a1', 1, { k: 'att.text', text: 'I will ' }, TS)
    harness.transport.evt('attempt:a1', 2, { k: 'att.reasoning', text: 'the flake is a clock' }, TS)
    harness.transport.evt('attempt:a1', 3, { k: 'att.text', text: 'change the clock.' }, TS)

    const entries = handle.vm.get().entries
    expect(entries.map((entry) => entry.k)).toEqual(['text', 'reasoning', 'text'])
    const reasoning = entries[1] as Extract<TranscriptEntry, { k: 'reasoning' }>
    expect(reasoning.collapsed).toBe(true)
    /* The text either side is NOT coalesced across the reasoning that interrupted it. */
    expect((entries[0] as Extract<TranscriptEntry, { k: 'text' }>).text).toBe('I will ')
    expect((entries[2] as Extract<TranscriptEntry, { k: 'text' }>).text).toBe('change the clock.')
    handle.release()
    harness.destroy()
  })

  it('upserts one entry per `callId` across start → exec → done ([F11])', () => {
    const harness = attemptClient()
    const handle = harness.client.transcript('a1')
    harness.transport.snap('attempt:a1', 0, makeAttemptSnapshot({ attemptId: 'a1' }))
    for (const [seq, status] of [
      [1, 'start'],
      [2, 'exec'],
      [3, 'done'],
    ] as const) {
      harness.transport.evt(
        'attempt:a1',
        seq,
        { k: 'att.tool', callId: 'call-1', name: 'bash', target: 'pnpm test', status },
        TS,
      )
    }
    const tools = handle.vm.get().entries.filter((entry) => entry.k === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0]).toMatchObject({ callId: 'call-1', status: 'done', target: 'pnpm test' })
    handle.release()
    harness.destroy()
  })

  it('keeps two concurrent tools apart, since the callId is what distinguishes them (#47)', () => {
    const harness = attemptClient()
    const handle = harness.client.transcript('a1')
    harness.transport.snap('attempt:a1', 0, makeAttemptSnapshot({ attemptId: 'a1' }))
    harness.transport.evt(
      'attempt:a1',
      1,
      { k: 'att.tool', callId: 'call-1', name: 'bash', target: 'pnpm test', status: 'start' },
      TS,
    )
    harness.transport.evt(
      'attempt:a1',
      2,
      { k: 'att.tool', callId: 'call-2', name: 'read', target: 'src/a.ts', status: 'start' },
      TS,
    )
    harness.transport.evt(
      'attempt:a1',
      3,
      { k: 'att.tool', callId: 'call-1', name: 'bash', target: 'pnpm test', status: 'done' },
      TS,
    )
    const tools = handle.vm.get().entries.filter((entry) => entry.k === 'tool')
    expect(tools.map((tool) => [tool.callId, tool.status])).toEqual([
      ['call-1', 'done'],
      ['call-2', 'start'],
    ])
    handle.release()
    harness.destroy()
  })

  it('carries `provenance:"scraped"` on background progress verbatim (#16, W11)', () => {
    const harness = attemptClient()
    const handle = harness.client.transcript('a1')
    harness.transport.snap('attempt:a1', 0, makeAttemptSnapshot({ attemptId: 'a1' }))
    harness.transport.evt(
      'attempt:a1',
      1,
      {
        k: 'att.background',
        taskId: 'bg-1',
        label: 'indexing',
        percent: 40,
        provenance: 'scraped',
      },
      TS,
    )
    const entry = handle.vm.get().entries[0] as Extract<TranscriptEntry, { k: 'background' }>
    expect(entry).toMatchObject({ k: 'background', taskId: 'bg-1', percent: 40 })
    expect(entry.provenance).toBe('scraped')
    handle.release()
    harness.destroy()
  })

  it('renders the prompt this client sent as the `user` entry of the turn it opened', async () => {
    const harness = attemptClient()
    harness.transport.evt(
      'fleet',
      1,
      { k: 'fleet.delegation_created', delegation: makeDelegationVM() },
      TS,
    )
    const pending = harness.client.sendTurn(
      'delegation-1',
      makeTurnDirective({ text: 'Plan the fix first.' }),
    )
    const req = harness.transport.lastReq('sendTurn')!
    harness.transport.respond(req.id, 'turn-42', 2)
    await pending

    const handle = harness.client.transcript('attempt-1')
    harness.transport.snap('attempt:attempt-1', 0, makeAttemptSnapshot({ attemptId: 'attempt-1' }))
    harness.transport.evt(
      'attempt:attempt-1',
      1,
      { k: 'att.turn_boundary', turnId: 'turn-42', edge: 'start' },
      TS,
    )
    const entry = handle.vm.get().entries[0] as Extract<TranscriptEntry, { k: 'user' }>
    expect(entry).toMatchObject({ k: 'user', turnId: 'turn-42', text: 'Plan the fix first.' })
    handle.release()
    harness.destroy()
  })

  it('an `att.error` becomes a notice entry and a client `error`, not silent truncation', () => {
    const harness = attemptClient()
    const handle = harness.client.transcript('a1')
    harness.transport.snap('attempt:a1', 0, makeAttemptSnapshot({ attemptId: 'a1' }))
    harness.transport.evt(
      'attempt:a1',
      1,
      { k: 'att.error', code: 'daemon_gone', message: 'the daemon closed the connection' },
      TS,
    )
    expect(handle.vm.get().entries[0]).toEqual({
      k: 'notice',
      text: 'daemon_gone: the daemon closed the connection',
    })
    /* jcode's vocabulary is not §9's, so the code rides in `details` (§6.4). */
    const raised = harness.errors.find((error) => error.code === 'executor_refused')
    expect(raised?.details).toMatchObject({ attemptId: 'a1', executorCode: 'daemon_gone' })
    handle.release()
    harness.destroy()
  })
})

describe('§6.2 the handle controls', () => {
  it('`follow(false)` is published, so a head can stop auto-scrolling without losing the stream', () => {
    const harness = attemptClient()
    const handle = harness.client.transcript('a1')
    expect(handle.vm.get().following).toBe(true)
    handle.follow(false)
    expect(handle.vm.get().following).toBe(false)
    handle.follow(true)
    expect(handle.vm.get().following).toBe(true)
    handle.release()
    harness.destroy()
  })

  it('`loadOlder` widens the local window and writes no frame (there is no paging frame)', async () => {
    const harness = attemptClient()
    const handle = harness.client.transcript('a1')
    const entries: TranscriptEntry[] = Array.from({ length: TRANSCRIPT_WINDOW + 10 }, (_, i) => ({
      k: 'text',
      text: `line ${i}`,
      at: TS,
    }))
    harness.transport.snap(
      'attempt:a1',
      0,
      makeAttemptSnapshot({ attemptId: 'a1', entries, hasOlder: false }),
    )
    expect(handle.vm.get().entries).toHaveLength(TRANSCRIPT_WINDOW)
    expect(handle.vm.get().hasOlder).toBe(true)

    harness.transport.clearSent()
    await handle.loadOlder(50)
    expect(handle.vm.get().entries).toHaveLength(TRANSCRIPT_WINDOW + 10)
    expect(handle.vm.get().hasOlder).toBe(false)
    expect(harness.transport.sent).toHaveLength(0)
    handle.release()
    harness.destroy()
  })

  it('`hasOlder` stays true when the SERVER says there is more, however wide the window', () => {
    const harness = attemptClient()
    const handle = harness.client.transcript('a1')
    harness.transport.snap(
      'attempt:a1',
      0,
      makeAttemptSnapshot({ attemptId: 'a1', entries: [], hasOlder: true }),
    )
    expect(handle.vm.get().hasOlder).toBe(true)
    handle.release()
    harness.destroy()
  })

  it('`refresh()` re-subscribes from `snapshot` — the only way to re-read materialized state', async () => {
    const harness = attemptClient()
    const handle = harness.client.diff('a1')
    harness.transport.snap('attempt:a1', 4, makeAttemptSnapshot({ attemptId: 'a1' }))
    harness.transport.clearSent()
    const pending = handle.refresh()
    expect(harness.transport.lastSub('attempt:a1')?.from).toBe('snapshot')
    harness.transport.snap('attempt:a1', 9, makeAttemptSnapshot({ attemptId: 'a1' }))
    await pending
    handle.release()
    harness.destroy()
  })

  it('`expand` decides which files carry hunks; a collapsed file publishes `hunks: null`', () => {
    const harness = attemptClient()
    const handle = harness.client.diff('a1')
    harness.transport.snap(
      'attempt:a1',
      0,
      makeAttemptSnapshot({
        attemptId: 'a1',
        diff: {
          attemptId: 'a1',
          baseRevision: 'abc',
          staleBase: false,
          files: [
            {
              path: 'src/a.ts',
              status: 'modified',
              insertions: 2,
              deletions: 1,
              binary: false,
              hunks: [{ header: '@@ -1 +1 @@', lines: ['-a', '+b'] }],
            },
          ],
          totals: { files: 1, insertions: 2, deletions: 1 },
          truncated: false,
        },
      }),
    )
    expect(handle.vm.get().files[0]?.hunks).toBeNull()
    handle.expand('src/a.ts', true)
    expect(handle.vm.get().files[0]?.hunks).toHaveLength(1)
    handle.expand('src/a.ts', false)
    expect(handle.vm.get().files[0]?.hunks).toBeNull()
    handle.release()
    harness.destroy()
  })

  it('a released handle is inert: its controls are no-ops, not throws (§6.2)', async () => {
    const harness = attemptClient()
    const transcript = harness.client.transcript('a1')
    const diff = harness.client.diff('a1')
    transcript.release()
    diff.release()
    transcript.follow(false)
    await transcript.loadOlder(10)
    diff.expand('src/a.ts', true)
    await diff.refresh()
    transcript.release()
    diff.release()
    expect(harness.client.inspect().handles).toEqual({ transcripts: 0, diffs: 0 })
    harness.destroy()
  })

  it('`lagged` is rendered as lag, never as a gap in the content (§2.4, Q12)', () => {
    const harness = attemptClient()
    const handle = harness.client.transcript('a1')
    harness.transport.snap('attempt:a1', 3, makeAttemptSnapshot({ attemptId: 'a1' }))
    harness.transport.evt('attempt:a1', 4, { k: 'att.text', text: 'partial' }, TS)
    harness.transport.lagged('attempt:a1', 4, 'backpressure')
    expect(handle.vm.get().lagged).toBe(true)
    /* And the forced snapshot clears it, because the state is provable again. */
    harness.transport.snap('attempt:a1', 40, makeAttemptSnapshot({ attemptId: 'a1' }))
    expect(handle.vm.get().lagged).toBe(false)
    handle.release()
    harness.destroy()
  })
})

describe('§6.2 a turn boundary ends a paragraph even when the prompt is another head’s', () => {
  it('never merges two turns’ text into one entry carrying the older turn’s timestamp', () => {
    const harness = attemptClient()
    const handle = harness.client.transcript('a1')
    harness.transport.snap('attempt:a1', 0, makeAttemptSnapshot({ attemptId: 'a1' }))
    harness.transport.evt('attempt:a1', 1, { k: 'att.text', text: 'end of turn one.' }, TS)
    /* §13's two-head row: this head did not send `turn-99`, so there is no prompt on the wire to
     * render — but the boundary is still real. */
    harness.transport.evt(
      'attempt:a1',
      2,
      { k: 'att.turn_boundary', turnId: 'turn-99', edge: 'start' },
      TS + 1_000,
    )
    harness.transport.evt(
      'attempt:a1',
      3,
      { k: 'att.text', text: 'start of turn two.' },
      TS + 2_000,
    )

    const entries = handle.vm.get().entries
    expect(entries.map((entry) => entry.k)).toEqual(['text', 'text'])
    expect(entries[0]).toEqual({ k: 'text', text: 'end of turn one.', at: TS })
    expect(entries[1]).toEqual({ k: 'text', text: 'start of turn two.', at: TS + 2_000 })
    handle.release()
    harness.destroy()
  })

  it('still coalesces consecutive deltas WITHIN a turn (§2.4’s merge rule, receiving side)', () => {
    const harness = attemptClient()
    const handle = harness.client.transcript('a1')
    harness.transport.snap('attempt:a1', 0, makeAttemptSnapshot({ attemptId: 'a1' }))
    harness.transport.evt(
      'attempt:a1',
      1,
      { k: 'att.turn_boundary', turnId: 'turn-99', edge: 'start' },
      TS,
    )
    harness.transport.evt('attempt:a1', 2, { k: 'att.text', text: 'one ' }, TS)
    harness.transport.evt('attempt:a1', 3, { k: 'att.text', text: 'paragraph' }, TS + 10)
    expect(handle.vm.get().entries).toEqual([{ k: 'text', text: 'one paragraph', at: TS }])
    handle.release()
    harness.destroy()
  })

  it('an `end` boundary is not a break — only `start` opens a turn', () => {
    const harness = attemptClient()
    const handle = harness.client.transcript('a1')
    harness.transport.snap('attempt:a1', 0, makeAttemptSnapshot({ attemptId: 'a1' }))
    harness.transport.evt('attempt:a1', 1, { k: 'att.text', text: 'a' }, TS)
    harness.transport.evt(
      'attempt:a1',
      2,
      { k: 'att.turn_boundary', turnId: 'turn-99', edge: 'end' },
      TS,
    )
    harness.transport.evt('attempt:a1', 3, { k: 'att.text', text: 'b' }, TS)
    expect(handle.vm.get().entries).toEqual([{ k: 'text', text: 'ab', at: TS }])
    handle.release()
    harness.destroy()
  })
})
