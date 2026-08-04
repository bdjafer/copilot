/**
 * The surfaces, in a DOM, against a fake client whose stores are driven by the spec's fixtures.
 *
 * Nothing is mocked between the store and the pixel: the real `createSwarmHead`, the real
 * projection and the real `glassSwarmPresentation` are wired exactly as `entrypoints/swarm/main.ts`
 * wires them, and the only fake is the `SwarmClient` boundary. So an assertion here is an assertion
 * about the product — "one click changes the effort of the next message", "a destructive control
 * takes two clicks", "the pickers lock in the modes where a config change would be refused" — and
 * not about a component's props.
 *
 * The surface is selected the way a user identifies a control: by what it does
 * (`[data-affordance]`) and by its accessible name, never by a CSS class.
 */

import type { DelegationVM } from '@astrale-os/swarm'

import {
  makeAttemptVM,
  makeDelegationVM,
  makeHealthVM,
  makeNoticeVM,
  makeTurnVM,
} from '@astrale-os/swarm/testing'
import { beforeEach, describe, expect, it } from 'vitest'

import { createSwarmHead } from '../src/swarm/head.ts'
import { SWARM_LABELS } from '../src/swarm/ui/labels.ts'
import { glassSwarmPresentation } from '../src/swarm/ui/presentation.ts'
import {
  createFakeSession,
  createFakeSwarmClient,
  emptyTranscriptVM,
} from './support/fake-swarm.ts'

function mountSurface(list: readonly DelegationVM[] = [], phase: 'live' | 'unpaired' = 'live') {
  const fake = createFakeSwarmClient()
  const session = createFakeSession({ phase, ...(phase === 'live' ? {} : { tokenId: null }) })
  const head = createSwarmHead({ session: session.session, now: () => 10_000 })
  if (phase === 'live') session.client.set(fake.client)
  fake.setDelegations(list)

  const pairs: { endpoint: string; code: string }[] = []
  let unpairs = 0
  const presentation = glassSwarmPresentation({
    pair: (endpoint, code) => pairs.push({ endpoint, code }),
    unpair: () => {
      unpairs += 1
    },
    now: () => 10_000,
  })

  const host = document.createElement('div')
  document.body.append(host)
  const root = host.attachShadow({ mode: 'open' })
  const handle = presentation.mount(
    { root, theme: 'auto' },
    head.vm.get(),
    head.intents,
    SWARM_LABELS,
  )
  const unsubscribe = head.vm.subscribe((vm) => {
    presentation.render(handle, vm)
  })

  const press = (affordance: string): void => {
    const node = root.querySelector<HTMLElement>(`[data-affordance="${affordance}"]`)
    if (node === null) throw new Error(`no affordance ${affordance}`)
    node.click()
  }
  const seg = (label: string, value: string): HTMLElement => {
    const group = root.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`)
    if (group === null) throw new Error(`no picker ${label}`)
    const button = group.querySelector<HTMLElement>(`[data-value="${value}"]`)
    if (button === null) throw new Error(`no value ${value} on ${label}`)
    return button
  }
  const type = (ariaLabel: string, text: string): HTMLTextAreaElement | HTMLInputElement => {
    const field = root.querySelector<HTMLTextAreaElement>(`[aria-label="${ariaLabel}"]`)
    if (field === null) throw new Error(`no field ${ariaLabel}`)
    field.value = text
    field.dispatchEvent(new Event('input', { bubbles: true }))
    return field
  }

  return {
    fake,
    session,
    head,
    root,
    pairs,
    press,
    seg,
    type,
    get unpairs() {
      return unpairs
    },
    directive: (): Record<string, unknown> => {
      const call = fake.calls.filter((entry) => entry.intent === 'sendTurn').at(-1)
      if (call === undefined) throw new Error('no sendTurn')
      return call.args[1] as Record<string, unknown>
    },
    destroy() {
      unsubscribe()
      presentation.destroy(handle)
      head.destroy()
      host.remove()
    },
  }
}

const focused = (): DelegationVM =>
  makeDelegationVM({
    id: 'd1',
    title: 'Fix flaky auth test',
    nowDoing: 'bash · pnpm test',
    attempts: [makeAttemptVM({ channel: 'idle' })],
  })

beforeEach(() => {
  document.body.replaceChildren()
})

describe('the pairing screen', () => {
  it('is the only surface an unpaired head shows', () => {
    const ui = mountSurface([], 'unpaired')
    expect(ui.root.querySelector('.cc-pair')!.hasAttribute('hidden')).toBe(false)
    expect(ui.root.querySelector('.cc-app')!.hasAttribute('hidden')).toBe(true)
    ui.destroy()
  })

  it('hands the endpoint and the printed code to the session, dashes and all', () => {
    const ui = mountSurface([], 'unpaired')
    ui.type('server endpoint', 'http://127.0.0.1:7717')
    ui.type('pairing code', 'K7QF-2M9X')
    ui.press('pair')

    expect(ui.pairs).toEqual([{ endpoint: 'http://127.0.0.1:7717', code: 'K7QF-2M9X' }])
    ui.destroy()
  })

  it('renders the refusal verbatim rather than a generic failure', () => {
    const ui = mountSurface([], 'unpaired')
    ui.session.state.set({ ...ui.session.state.get(), error: 'that code has expired' })
    expect(ui.root.querySelector('.cc-error')!.textContent).toBe('that code has expired')
    ui.destroy()
  })
})

describe('the fleet', () => {
  it('draws a row per delegation with its permanent metadata', () => {
    const ui = mountSurface([focused()])
    const row = ui.root.querySelector<HTMLElement>('[data-delegation="d1"]')!

    expect(row.querySelector('.cc-row-title')!.textContent).toBe('Fix flaky auth test')
    expect(row.querySelector('.cc-row-now')!.textContent).toBe('bash · pnpm test')
    // §0 D2: metadata is never hidden behind a hover gate.
    expect(row.querySelector('.cc-row-meta')!.hasAttribute('hidden')).toBe(false)
    ui.destroy()
  })

  it('opens a delegation on click and closes it with the corner mark', () => {
    const ui = mountSurface([focused()])
    ui.root.querySelector<HTMLElement>('[data-delegation="d1"]')!.click()

    expect(ui.fake.calls.filter((call) => call.intent === 'focus').at(-1)!.args[0]).toBe('d1')
    expect(ui.root.querySelector('.cc-detail')!.hasAttribute('hidden')).toBe(false)

    ui.press('close')
    expect(ui.fake.calls.filter((call) => call.intent === 'focus').at(-1)!.args[0]).toBeNull()
    ui.destroy()
  })

  it('pauses dispatch fleet-wide from the strip switch', () => {
    const ui = mountSurface([focused()])
    ui.root.querySelector<HTMLElement>('[role="switch"]')!.click()

    const call = ui.fake.calls.find((entry) => entry.intent === 'pauseDispatch')!
    expect(call.args).toEqual([{ fleet: true }, true])
    ui.destroy()
  })

  it('shows the empty state as one glyph with the sentence in the accessible name', () => {
    const ui = mountSurface([])
    const empty = ui.root.querySelector('.cc-empty')!
    expect(empty.hasAttribute('hidden')).toBe(false)
    expect(empty.textContent).toBe('')
    expect(empty.getAttribute('aria-label')).toContain('no delegations')
    ui.destroy()
  })
})

describe('the follow-up bar — per-turn control', () => {
  it('changes the effort of the next message in ONE click', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')

    expect(ui.seg('reasoning effort for this message', 'medium').getAttribute('aria-pressed')).toBe(
      'true',
    )
    ui.seg('reasoning effort for this message', 'high').click()
    expect(ui.seg('reasoning effort for this message', 'high').getAttribute('aria-pressed')).toBe(
      'true',
    )

    ui.type('follow-up message', 'keep going')
    ui.press('send')

    expect(ui.directive()).toMatchObject({ text: 'keep going', reasoningEffort: 'high' })
    ui.destroy()
  })

  it('forgets the override afterwards — omission reconciles to the delegation default (Q4)', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')
    ui.seg('reasoning effort for this message', 'high').click()
    ui.type('follow-up message', 'one')
    ui.press('send')

    ui.type('follow-up message', 'two')
    ui.press('send')

    expect('reasoningEffort' in ui.directive()).toBe(false)
    expect(ui.seg('reasoning effort for this message', 'medium').getAttribute('aria-pressed')).toBe(
      'true',
    )
    ui.destroy()
  })

  it('writes the delegation default too when the sticky switch is on (#35)', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')
    ui.root.querySelectorAll<HTMLElement>('[role="switch"]').forEach((node) => {
      if (node.getAttribute('aria-label')?.includes('applies from now on') === true) node.click()
    })
    ui.seg('reasoning effort for this message', 'low').click()

    expect(ui.fake.calls.find((call) => call.intent === 'updateDefaults')!.args[1]).toEqual({
      reasoningEffort: 'low',
    })
    ui.destroy()
  })

  it('locks effort and model on every delivery mode but after-turn (§4.3.10)', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')
    ui.seg('reasoning effort for this message', 'high').click()
    ui.seg('how this message is delivered', 'interrupt').click()

    const ladder = ui.root.querySelector<HTMLElement>(
      '[aria-label="reasoning effort for this message"]',
    )!
    expect(ladder.dataset.locked).toBe('1')
    expect(ladder.getAttribute('title')).toContain('after-turn')

    ui.type('follow-up message', 'stop and look at this')
    ui.press('send')

    const directive = ui.directive()
    expect(directive.delivery).toBe('interrupt')
    // The field is refused, never the turn: the steering message still goes.
    expect('reasoningEffort' in directive).toBe(false)
    expect('model' in directive).toBe(false)
    ui.destroy()
  })

  it('locks the pickers while a turn is in flight (§4.3.6, turn_in_flight)', () => {
    const ui = mountSurface([
      makeDelegationVM({
        id: 'd1',
        attempts: [makeAttemptVM({ channel: 'streaming' })],
        currentTurn: makeTurnVM(),
      }),
    ])
    ui.fake.client.focus('d1')

    const ladder = ui.root.querySelector<HTMLElement>(
      '[aria-label="reasoning effort for this message"]',
    )!
    expect(ladder.dataset.locked).toBe('1')
    expect(ladder.getAttribute('title')).toContain('turn_in_flight')
    ui.destroy()
  })

  it('renders the effective config before send, and says the effort is only declared', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')

    const line = ui.root.querySelector('.cc-effective')!
    expect(ui.root.querySelector('.cc-turn')!.textContent).toContain('declared, not confirmed')
    expect(line.textContent).toContain('after-turn')
    expect(line.textContent).toContain('claude-opus-5')
    expect(line.textContent).toContain('medium (declared)')
    ui.destroy()
  })

  it('demands a structured answer and discloses the retry cost', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')
    ui.root.querySelectorAll<HTMLElement>('[role="switch"]').forEach((node) => {
      if (node.getAttribute('aria-label')?.includes('schema-valid') === true) node.click()
    })
    ui.type('follow-up message', 'report')
    ui.press('send')

    expect(ui.directive().structured).toMatchObject({ maxRetries: 2 })
    expect(ui.root.querySelector('.cc-notices')!.textContent).toContain('corrective turns')
    ui.destroy()
  })

  it('cancels the turn in flight without touching the delegation', () => {
    const ui = mountSurface([
      makeDelegationVM({
        id: 'd1',
        attempts: [makeAttemptVM({ channel: 'streaming' })],
        currentTurn: makeTurnVM(),
      }),
    ])
    ui.fake.client.focus('d1')
    ui.press('cancel-turn')

    expect(ui.fake.calls.find((call) => call.intent === 'cancel')!.args[1]).toEqual({
      scope: 'turn',
    })
    ui.destroy()
  })
})

describe('destructive controls arm', () => {
  it('takes two clicks to cancel a delegation, and shows the armed state as a shape', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')

    ui.press('cancel-delegation')
    expect(ui.fake.calls.filter((call) => call.intent === 'cancel')).toHaveLength(0)
    expect(
      ui.root.querySelector('[data-affordance="cancel-delegation"]')!.hasAttribute('data-confirm'),
    ).toBe(true)

    ui.press('cancel-delegation')
    expect(ui.fake.calls.find((call) => call.intent === 'cancel')!.args[1]).toEqual({
      scope: 'delegation',
    })
    ui.destroy()
  })

  it('takes two clicks for the kill switch, and says it is a brake rather than a delete', () => {
    const ui = mountSurface([focused()])
    const button = ui.root.querySelector<HTMLElement>('[data-affordance="kill-switch"]')!
    expect(button.title).toContain('No delegation is terminated')

    button.click()
    expect(ui.fake.calls.filter((call) => call.intent === 'killSwitch')).toHaveLength(0)
    button.click()
    expect(ui.fake.calls.find((call) => call.intent === 'killSwitch')!.args[0]).toEqual({
      killInstances: false,
    })
    ui.destroy()
  })

  it('disarms one destructive control when another is armed', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')
    ui.press('cancel-delegation')
    ui.press('hard-kill')

    expect(
      ui.root.querySelector('[data-affordance="cancel-delegation"]')!.hasAttribute('data-confirm'),
    ).toBe(false)
    expect(ui.fake.calls.filter((call) => call.intent === 'cancel')).toHaveLength(0)
    ui.destroy()
  })
})

describe('the delegation detail', () => {
  it('draws the acceptance criteria, and says what zero of them means', () => {
    const ui = mountSurface([makeDelegationVM({ id: 'd1', acceptance: [], unverifiable: true })])
    ui.fake.client.focus('d1')

    expect(ui.root.querySelector('.cc-detail .cc-panel')!.textContent).toContain('unverifiable')
    ui.destroy()
  })

  it('reaches `accepted` only through a written note', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')

    ui.press('accept')
    ui.type('acceptance note', 'reviewed the diff by hand')
    ui.press('accept-submit')

    expect(ui.fake.calls.find((call) => call.intent === 'accept')!.args[1]).toEqual({
      note: 'reviewed the diff by hand',
    })
    ui.destroy()
  })

  it('lists every attempt with its channel, cost and evidence', () => {
    const ui = mountSurface([
      makeDelegationVM({
        id: 'd1',
        attempts: [
          makeAttemptVM({
            id: 'a1',
            attemptNo: 1,
            live: false,
            outcome: 'failed',
            evidenceRef: 'evidence/a1',
          }),
          makeAttemptVM({ id: 'a2', attemptNo: 2, channel: 'streaming' }),
        ],
        liveAttemptIds: ['a2'],
        focusedAttemptId: 'a2',
      }),
    ])
    ui.fake.client.focus('d1')

    const rows = [...ui.root.querySelectorAll('.cc-attempt')]
    expect(rows).toHaveLength(2)
    expect(rows[0]!.textContent).toContain('#1')
    expect(rows[0]!.textContent).toContain('failed')
    expect(rows[1]!.textContent).toContain('streaming')
    ui.destroy()
  })

  it('lands the selected attempt in the mode the picker names', () => {
    const ui = mountSurface([
      makeDelegationVM({
        id: 'd1',
        attempts: [makeAttemptVM({ id: 'a1', live: false })],
        liveAttemptIds: [],
      }),
    ])
    ui.fake.client.focus('d1')
    ui.seg('how a landing is written', 'patch').click()
    ui.press('land')

    expect(ui.fake.calls.find((call) => call.intent === 'land')!.args[1]).toEqual({
      attemptId: 'a1',
      mode: 'patch',
    })
    ui.destroy()
  })
})

describe('the transcript', () => {
  it('renders each entry as what it is, with reasoning collapsed and progress on its own plane', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')
    ui.fake.setTranscript('attempt-1', {
      ...emptyTranscriptVM('attempt-1'),
      entries: [
        { k: 'user', turnId: 't1', text: 'please fix it', at: 9000, images: 0 },
        { k: 'reasoning', text: 'thinking', at: 9100, collapsed: true },
        { k: 'text', text: 'on it', at: 9200 },
        {
          k: 'tool',
          callId: 'c1',
          name: 'bash',
          target: 'pnpm test',
          status: 'done',
          output: 'ok',
          durationMs: 1200,
        },
        { k: 'background', taskId: 'b1', label: 'indexing', percent: 40, provenance: 'scraped' },
        { k: 'usage', input: 10, output: 20 },
      ],
    })

    const transcript = ui.root.querySelector('.cc-transcript')!
    expect(transcript.querySelector('[data-k="user"]')!.textContent).toContain('please fix it')
    const reasoning = transcript.querySelector<HTMLDetailsElement>('[data-k="reasoning"]')!
    expect(reasoning.open).toBe(false)
    expect(transcript.querySelector('[data-k="tool"]')!.textContent).toContain('bash')
    // W11: background progress is never a transcript entry.
    expect(transcript.querySelector('[data-k="background"]')).toBeNull()
    expect(ui.root.querySelector('.cc-background')!.textContent).toContain('indexing')
    expect(ui.root.querySelector('.cc-background')!.textContent).toContain('scraped')
    ui.destroy()
  })

  it('draws a lag as a warning, never as a gap in content', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')
    ui.fake.setTranscript('attempt-1', {
      ...emptyTranscriptVM('attempt-1'),
      lagged: true,
      hasOlder: true,
    })

    expect(ui.root.querySelector('.cc-lagged')!.hasAttribute('hidden')).toBe(false)
    ui.press('older')
    expect(ui.fake.calls.some((call) => call.intent === 'loadOlder')).toBe(true)
    ui.destroy()
  })
})

describe('the composer', () => {
  it('creates a delegation from the objective, the criteria and the pickers', () => {
    const ui = mountSurface([])
    ui.fake.health.set(
      makeHealthVM({
        routes: [
          {
            model: 'claude-opus-5',
            provider: 'anthropic',
            apiMethod: 'messages',
            available: true,
            detail: 'ok',
          },
        ],
      }),
    )
    const objective = ui.type('objective', 'make the suite deterministic') as HTMLTextAreaElement
    objective.dispatchEvent(new Event('focus', { bubbles: true }))
    ui.type('workspace id', 'exp-spec')
    ui.type('criterion', 'pnpm test')
    ui.press('create')

    const input = ui.fake.calls.find((call) => call.intent === 'createDelegation')!.args[0] as {
      spec: { objective: string; acceptance: unknown[]; workspace: { workspaceId: string } }
    }
    expect(input.spec.objective).toBe('make the suite deterministic')
    expect(input.spec.workspace.workspaceId).toBe('exp-spec')
    expect(input.spec.acceptance).toHaveLength(1)
    ui.destroy()
  })

  it('grows a fresh criterion row as soon as the last one is filled — no add affordance exists', () => {
    const ui = mountSurface([])
    expect(ui.root.querySelectorAll('[aria-label="criterion"]')).toHaveLength(1)
    ui.type('criterion', 'pnpm test')
    expect(ui.root.querySelectorAll('[aria-label="criterion"]').length).toBeGreaterThan(1)
    ui.destroy()
  })
})

describe('notices and the copilot gate', () => {
  it('dismisses a server notice', () => {
    const ui = mountSurface([focused()])
    ui.fake.notices.set([makeNoticeVM({ id: 'n1', kind: 'drift', title: 'model drifted' })])
    expect(ui.root.querySelector('.cc-notice')!.textContent).toContain('model drifted')

    ui.press('dismiss')
    expect(ui.root.querySelector('.cc-notice')).toBeNull()
    ui.destroy()
  })

  it('renders a copilot confirmation with its deadline and answers it', () => {
    const ui = mountSurface([focused()])
    ui.session.confirmations.set([
      {
        requestId: 'r1',
        at: 0,
        expiresAt: 130_000,
        tool: 'swarm.start',
        requestedBy: { kind: 'copilot', conversationId: 'c1' },
        summary: 'start a delegation on exp-spec',
        payload: { delegationId: 'd1', scope: 'turn' },
        effective: {
          provider: 'anthropic',
          model: 'claude-opus-5',
          reasoningEffort: 'medium',
          workspace: 'exp-spec',
          writeMode: 'worktree',
        },
      },
    ])

    const card = ui.root.querySelector('.cc-confirm')!
    expect(card.textContent).toContain('start a delegation on exp-spec')
    expect(card.textContent).toContain('left')

    ui.press('confirm')
    expect(ui.fake.calls.find((call) => call.intent === 'confirm')!.args[0]).toBe('r1')
    ui.destroy()
  })
})

describe('the dismissal chain (DESIGN §7)', () => {
  it('one Escape closes the open delegation, and does nothing when none is open', () => {
    const ui = mountSurface([focused()])
    const app = ui.root.querySelector('.cc-app')!

    app.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(ui.fake.calls.filter((call) => call.intent === 'focus')).toHaveLength(0)

    ui.fake.client.focus('d1')
    app.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(ui.fake.calls.filter((call) => call.intent === 'focus').at(-1)!.args[0]).toBeNull()
    ui.destroy()
  })

  it('leaves a typed message alone — the composer never loses your words', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')
    const field = ui.type('follow-up message', 'half a thought') as HTMLTextAreaElement
    field.focus()

    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(field.value).toBe('half a thought')
    ui.destroy()
  })
})

describe('the accessibility contract', () => {
  it('gives every icon-only control a native title AND an accessible name (§10)', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')

    const controls = [...ui.root.querySelectorAll<HTMLElement>('.cc-btn, .cc-switch')]
    expect(controls.length).toBeGreaterThan(10)
    for (const control of controls) {
      expect(control.title.length, control.dataset.affordance ?? control.outerHTML).toBeGreaterThan(
        0,
      )
      expect(control.getAttribute('aria-label')).toBe(control.title)
      // §10, the whole audit in one line: a verb is never drawn. Every one of these controls is a
      // mark plus a sentence that lives only in the tooltip and the accessibility tree.
      expect(control.textContent, control.dataset.affordance ?? control.outerHTML).toBe('')
    }
    ui.destroy()
  })

  it('destroys cleanly: no listeners, no nodes, no live transcript handle', () => {
    const ui = mountSurface([focused()])
    ui.fake.client.focus('d1')
    expect(ui.fake.liveHandles).toBe(1)
    ui.destroy()
    expect(ui.root.childElementCount).toBe(0)
    expect(ui.fake.liveHandles).toBe(0)
  })
})
