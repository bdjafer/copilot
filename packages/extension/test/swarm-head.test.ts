/**
 * The head controller and its projection: client-core stores in, one frozen view model out, and
 * every intent a **translation** rather than a decision.
 *
 * What is asserted here is the boundary PRODUCT §3 and H8 draw: the head renders and translates,
 * the server decides. So the tests check that the projection re-uses what the core already
 * derived (buckets, attention order, counts), that the three things it *does* compute are the
 * three it is allowed to (bucket order, `configLocked`, the honesty list), and that the intent
 * layer refuses exactly what the client core would refuse anyway — one round trip earlier, and
 * with the reason on screen.
 */

import type { DelegationVM } from '@astrale-os/swarm'

import {
  makeAttemptVM,
  makeDelegationSpec,
  makeDelegationVM,
  makeNoticeVM,
  makeTurnVM,
} from '@astrale-os/swarm/testing'
import { describe, expect, it } from 'vitest'

import { createSwarmHead } from '../src/swarm/head.ts'
import { BUCKET_ORDER } from '../src/swarm/view-model.ts'
import {
  createFakeSession,
  createFakeSwarmClient,
  emptyTranscriptVM,
} from './support/fake-swarm.ts'

function mount(list: readonly DelegationVM[] = []) {
  const fake = createFakeSwarmClient()
  const session = createFakeSession()
  const head = createSwarmHead({ session: session.session, now: () => 1000 })
  session.client.set(fake.client)
  fake.setDelegations(list)
  return { fake, session, head }
}

describe('the projection', () => {
  it('is total before a client exists — a renderer never sees a hole', () => {
    const session = createFakeSession({ phase: 'unpaired', tokenId: null })
    const head = createSwarmHead({ session: session.session })
    const vm = head.vm.get()

    expect(vm.pairing.phase).toBe('unpaired')
    expect(vm.fleet.buckets).toHaveLength(9)
    expect(vm.focused).toBeNull()
    expect(vm.health.honesty.length).toBeGreaterThan(0)
    expect(Object.isFrozen(vm)).toBe(true)
  })

  it('orders the nine buckets by attention and keeps the core’s own counts', () => {
    const { fake, head } = mount([
      makeDelegationVM({ id: 'd1', state: 'needs-you', needsYou: 'question' }),
      makeDelegationVM({ id: 'd2', state: 'running' }),
    ])
    const vm = head.vm.get()

    expect(vm.fleet.buckets.map((bucket) => bucket.id)).toEqual([...BUCKET_ORDER])
    const needsYou = vm.fleet.buckets.find((bucket) => bucket.id === 'needs-you')!
    expect(needsYou.rows.map((row) => row.id)).toEqual(['d1'])
    expect(needsYou.count).toBe(1)
    expect(vm.fleet.buckets.find((bucket) => bucket.id === 'working')!.rows).toHaveLength(1)
    expect(fake.calls.filter((call) => call.intent === 'setFilter')).toHaveLength(0)
  })

  it('badges the row with the one fact that outranks the rest', () => {
    const { head, fake } = mount()
    const badge = (vm: DelegationVM): string | null => {
      fake.setDelegations([vm])
      return head.vm.get().fleet.buckets.flatMap((bucket) => bucket.rows)[0]?.badge ?? null
    }

    expect(badge(makeDelegationVM({ state: 'needs-you', needsYou: 'budget' }))).toBe('budget')
    expect(badge(makeDelegationVM({ state: 'succeeded', verdict: 'verified' }))).toBe('verified')
    expect(badge(makeDelegationVM({ state: 'running', stalledForMs: 42_000 }))).toBe('stalled 42s')
    expect(badge(makeDelegationVM({ state: 'running', staleBase: true }))).toBe('stale base')
    expect(
      badge(
        makeDelegationVM({
          state: 'running',
          spec: makeDelegationSpec({ acceptance: [] }),
          unverifiable: true,
        }),
      ),
    ).toBe('unverifiable')
  })

  it('shows the delegation default until a turn is in flight, then the turn’s own config', () => {
    const { fake, head } = mount([makeDelegationVM({ id: 'd1' })])
    fake.client.focus('d1')

    expect(head.vm.get().focused!.effective).toMatchObject({
      model: 'claude-opus-5',
      reasoningEffort: 'medium',
      effortConfirmed: false,
      inherited: false,
    })

    fake.setDelegations([
      makeDelegationVM({
        id: 'd1',
        currentTurn: makeTurnVM({
          configInherited: true,
          effective: {
            ...makeTurnVM().effective,
            model: 'inherited',
            reasoningEffort: 'inherited',
          },
        }),
      }),
    ])
    const effective = head.vm.get().focused!.effective
    expect(effective.model).toBe('inherited')
    expect(effective.inherited).toBe(true)
    /* §4.3.4: a literal `false` in the type — no code path may ever claim otherwise. */
    expect(effective.effortConfirmed).toBe(false)
  })

  it('locks the config pickers exactly in the four channel states that refuse a change', () => {
    const { fake, head } = mount()
    const lockedFor = (channel: string): boolean => {
      fake.setDelegations([
        makeDelegationVM({
          id: 'd1',
          attempts: [makeAttemptVM({ channel: channel as never })],
          currentTurn: makeTurnVM(),
        }),
      ])
      fake.client.focus('d1')
      return head.vm.get().focused!.turn!.configLocked
    }

    for (const channel of ['submitting', 'accepted', 'streaming', 'interrupting']) {
      expect(lockedFor(channel), channel).toBe(true)
    }
    for (const channel of ['idle', 'detached', 'attaching', 'disconnected', 'closed']) {
      expect(lockedFor(channel), channel).toBe(false)
    }
  })

  it('derives the effort ladder from the delegation’s provider, not from the closed union', () => {
    const { fake, head } = mount([makeDelegationVM({ id: 'd1' })])
    fake.client.focus('d1')
    // The fixture is `anthropic`/`claude-opus-5`. Anthropic's ladder still has no `minimal`
    // (§4.1), and it now carries `xhigh`/`max` because D3's capability table was filled from
    // jcode 0.67.0's own strings — "available on Opus 4.7+, Sonnet 5+, and Fable 5+".
    expect(head.vm.get().focused!.ladder).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(head.vm.get().focused!.ladder).not.toContain('minimal')
  })

  it('and a model OUTSIDE that table keeps the short ladder', () => {
    const { fake, head } = mount([
      makeDelegationVM({
        id: 'd2',
        spec: {
          ...makeDelegationVM({ id: 'd2' }).spec,
          model: { provider: 'anthropic', model: 'claude-opus-4-6', reasoningEffort: 'medium' },
        },
      }),
    ])
    fake.client.focus('d2')
    // 4.6 gets `max` from jcode but not `xhigh`, and one constant grants both — so it gets
    // neither. Refusing a value jcode might accept is D3's stated safe direction.
    expect(head.vm.get().focused!.ladder).toEqual(['none', 'low', 'medium', 'high'])
  })

  it('reads `filesChanged` from the comparison and never invents one (A5, S8)', () => {
    const { fake, head } = mount([
      makeDelegationVM({
        id: 'd1',
        attempts: [makeAttemptVM({ id: 'a1' }), makeAttemptVM({ id: 'a2', attemptNo: 2 })],
        comparison: {
          attempts: [
            {
              id: 'a2',
              attemptNo: 2,
              verdict: 'pass',
              filesChanged: 7,
              insertions: 40,
              deletions: 3,
              criteria: [],
              estUsd: 0.4,
              durationMs: 1000,
              turns: 2,
              toolCalls: 9,
            },
          ],
          recommendation: 'a2',
        },
      }),
    ])
    fake.client.focus('d1')

    const attempts = head.vm.get().focused!.attempts
    expect(attempts.find((attempt) => attempt.id === 'a2')!.filesChanged).toBe(7)
    // No comparison row ⇒ no measurement ⇒ 0, never a guess.
    expect(attempts.find((attempt) => attempt.id === 'a1')!.filesChanged).toBe(0)
    expect(head.vm.get().focused!.comparison[0]).toMatchObject({ id: 'a2', recommended: true })
  })

  it('seeds the workspace picker from the ids in use, because no view model carries the allowlist', () => {
    const { head } = mount([
      makeDelegationVM({ id: 'd1' }),
      makeDelegationVM({
        id: 'd2',
        spec: makeDelegationSpec({
          workspace: { workspaceId: 'other', baseRevision: 'x'.repeat(40), writeMode: 'worktree' },
        }),
      }),
    ])
    expect(head.vm.get().workspaces.map((entry) => entry.id)).toEqual(['exp-spec', 'other'])
  })

  it('states four things this product cannot do, and folds in the server’s own', () => {
    const { fake, head } = mount()
    fake.notices.set([makeNoticeVM({ id: 'srv', kind: 'honesty', title: 'sensitive workspace' })])

    const honesty = head.vm.get().health.honesty
    expect(honesty.map((entry) => entry.id)).toEqual([
      'authority',
      'approvals',
      'effort',
      'network',
      'srv',
    ])
    expect(honesty.find((entry) => entry.id === 'effort')!.detail).toContain('not what ran')
  })

  it('acquires one transcript handle per focused attempt and releases the previous one', () => {
    const { fake, head } = mount([
      makeDelegationVM({ id: 'd1' }),
      makeDelegationVM({
        id: 'd2',
        attempts: [makeAttemptVM({ id: 'attempt-2' })],
        liveAttemptIds: ['attempt-2'],
        focusedAttemptId: 'attempt-2',
      }),
    ])

    fake.client.focus('d1')
    expect(fake.liveHandles).toBe(1)
    fake.client.focus('d2')
    expect(fake.liveHandles).toBe(1)

    fake.setTranscript('attempt-2', {
      ...emptyTranscriptVM('attempt-2'),
      entries: [{ k: 'text', text: 'hello', at: 1 }],
    })
    expect(head.vm.get().focused!.transcript.entries).toHaveLength(1)

    head.destroy()
    expect(fake.liveHandles).toBe(0)
  })
})

describe('the intent layer', () => {
  it('translates a follow-up into a directive and keeps omission meaning “the delegation default”', () => {
    const { fake, head } = mount([makeDelegationVM({ id: 'd1' })])
    head.intents.sendTurn('d1', { text: 'go on' })

    const call = fake.calls.find((entry) => entry.intent === 'sendTurn')!
    expect(call.args[0]).toBe('d1')
    const directive = call.args[1] as Record<string, unknown>
    expect(directive.text).toBe('go on')
    expect('reasoningEffort' in directive).toBe(false)
    expect(typeof directive.idempotencyKey).toBe('string')
  })

  it('carries a per-turn effort override when the user picked one', () => {
    const { fake, head } = mount([makeDelegationVM({ id: 'd1' })])
    head.intents.sendTurn('d1', { text: 'go on', reasoningEffort: 'high' })

    const directive = fake.calls.find((entry) => entry.intent === 'sendTurn')!.args[1] as Record<
      string,
      unknown
    >
    expect(directive.reasoningEffort).toBe('high')
  })

  it('refuses `swarm` and `swarm-deep` in the head — the fourth layer, and the cheapest', () => {
    const { fake, head } = mount([makeDelegationVM({ id: 'd1' })])
    head.intents.sendTurn('d1', { text: 'go on', reasoningEffort: 'swarm-deep' })

    expect(fake.calls.filter((entry) => entry.intent === 'sendTurn')).toHaveLength(0)
    const notice = head.vm.get().notices[0]!
    expect(notice.kind).toBe('banned-effort')
    expect(notice.detail).toContain('banned')
  })

  it('discloses the structured-answer cost at send time, not in a tooltip', () => {
    const { fake, head } = mount([makeDelegationVM({ id: 'd1' })])
    head.intents.sendTurn('d1', { text: 'report', structured: true })

    const directive = fake.calls.find((entry) => entry.intent === 'sendTurn')!.args[1] as Record<
      string,
      unknown
    >
    expect(directive.structured).toMatchObject({ maxRetries: 2 })
    expect(head.vm.get().notices.some((notice) => notice.kind === 'structured-cost')).toBe(true)
  })

  it('drops an empty message rather than sending a turn nobody wrote', () => {
    const { fake, head } = mount([makeDelegationVM({ id: 'd1' })])
    head.intents.sendTurn('d1', { text: '   ' })
    expect(fake.calls.filter((entry) => entry.intent === 'sendTurn')).toHaveLength(0)
  })

  it('builds a create input whose breach action is never `kill`', () => {
    const { fake, head } = mount()
    head.intents.create({
      objective: 'make the suite deterministic',
      workspaceId: 'exp-spec',
      baseRef: '',
      writeMode: 'worktree',
      acceptance: [
        { kind: 'command', label: '', value: 'pnpm test' },
        { kind: 'manual', label: 'eyeball it', value: 'read the diff' },
      ],
      provider: 'anthropic',
      model: 'claude-opus-5',
      reasoningEffort: 'medium',
      delivery: 'after-turn',
      parallelAttempts: 2,
      budget: { maxWallMs: 60_000, maxTurns: 3, maxToolCalls: 4 },
    })

    const input = fake.calls.find((entry) => entry.intent === 'createDelegation')!.args[0] as {
      spec: {
        acceptance: { kind: string; id: string }[]
        budget: { onBreach: string }
        workspace: { baseRef: string }
        parallelAttempts: number
      }
    }
    expect(input.spec.acceptance.map((c) => c.kind)).toEqual(['command', 'manual'])
    expect(input.spec.acceptance.map((c) => c.id)).toEqual(['c1', 'c2'])
    // Q11: a hard breach pauses dispatch; it never cancels a running turn.
    expect(input.spec.budget.onBreach).toBe('pause-dispatch')
    // C4b: the head submits an EXPRESSION and never resolves a ref itself.
    expect(input.spec.workspace.baseRef).toBe('HEAD')
    expect(input.spec.parallelAttempts).toBe(2)
  })

  it('maps the three interrupts onto the three scopes, and nothing else reaches `cancelled`', () => {
    const { fake, head } = mount([makeDelegationVM({ id: 'd1' })])
    head.intents.cancel('d1', 'turn')
    head.intents.cancel('d1', 'delegation')
    head.intents.cancel('d1', 'hard')
    head.intents.killSwitch(true)

    expect(
      fake.calls.filter((entry) => entry.intent === 'cancel').map((entry) => entry.args[1]),
    ).toEqual([{ scope: 'turn' }, { scope: 'delegation' }, { scope: 'hard' }])
    expect(fake.calls.find((entry) => entry.intent === 'killSwitch')!.args[0]).toEqual({
      killInstances: true,
    })
  })

  it('scopes pause to the fleet with a null delegation and to one otherwise', () => {
    const { fake, head } = mount([makeDelegationVM({ id: 'd1' })])
    head.intents.pauseDispatch(null, true)
    head.intents.pauseDispatch('d1', false)

    const calls = fake.calls.filter((entry) => entry.intent === 'pauseDispatch')
    expect(calls[0]!.args).toEqual([{ fleet: true }, true])
    expect(calls[1]!.args).toEqual([{ delegationId: 'd1' }, false])
  })

  it('is a documented no-op with no client, rather than a throw a renderer must catch', () => {
    const session = createFakeSession()
    const head = createSwarmHead({ session: session.session })
    expect(() => {
      head.intents.sendTurn('d1', { text: 'hi' })
      head.intents.killSwitch(false)
      head.intents.escape()
    }).not.toThrow()
  })
})
