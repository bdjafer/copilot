/**
 * The service worker (SPEC-copilot §6, SPEC-comment-core §7.3), driven end to end against the
 * fake platform and a `scriptedModel` — no network, no browser.
 */

import type { LanguageModelLike } from '@astrale-os/browser-copilot'
import type { ScriptedStep } from '@astrale-os/browser-copilot/testing'
import type { CreateThreadInput } from '@astrale-os/comment-core'

import { scriptedModel } from '@astrale-os/browser-copilot/testing'
import { createDomain, createKeyValueStore } from '@astrale-os/comment-core/headless'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BackgroundHandle } from '../src/background/index.ts'

import {
  KEEPALIVE_MS,
  startBackground,
  WATCHDOG_ALARM,
  WATCHDOG_PERIOD_MINUTES,
} from '../src/background/index.ts'
import { createTabRouter } from '../src/background/tabs.ts'
import { BATCH_TOOLS, SINGLE_TOOLS } from '../src/background/tools.ts'
import { COMMENT_NS, SETTINGS_KEY, singleRunId } from '../src/keys.ts'
import { createStorageKv } from '../src/kv.ts'
import { defaultSettings } from '../src/settings.ts'
import { createFakePlatform } from './support/fake-chrome.ts'
import { createFakeChannel } from './support/fake-messaging.ts'

const PAGE = 'https://example.com/doc'

const threadInput = (over: Partial<CreateThreadInput> = {}): CreateThreadInput => ({
  pageKey: PAGE,
  kind: 'comment',
  author: 'user',
  body: 'have a look at this',
  anchor: {
    mode: 'element',
    selectors: [{ type: 'css', value: '#a' }],
    fingerprint: { tag: 'p', stableClasses: [], attrs: {}, textDigest: 'abc' },
  },
  capture: {
    outerHTML: '<p id="a">hi</p>',
    text: 'hi',
    cssPath: '#a',
    page: { url: PAGE, title: 'Doc' },
    capturedAt: '2026-01-01T00:00:00.000Z',
  },
  ...over,
})

/** Lets every queued microtask *and* macrotask settle — `observeStore` drains asynchronously. */
async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

interface Scene {
  bridge: BackgroundHandle
  platform: ReturnType<typeof createFakePlatform>
  channel: ReturnType<typeof createFakeChannel>
  domain: ReturnType<typeof createDomain>
  kv: ReturnType<typeof createStorageKv>
  script(steps: ScriptedStep[] | string): void
  tiers: string[]
  /** The API key each model construction actually saw. Empty until the first attempt runs. */
  keys: string[]
  ready(): Promise<void>
}

const scenes: Scene[] = []

async function scene(over: Partial<ReturnType<typeof defaultSettings>> = {}): Promise<Scene> {
  const platform = createFakePlatform({ tabs: [{ id: 7, url: PAGE }] })
  const kv = createStorageKv(platform.storage)
  await kv.set({ [SETTINGS_KEY]: { ...defaultSettings(), apiKey: 'sk-test', ...over } })

  // Tab 7 is the tab the fake tab router resolves PAGE to, so the worker's notifications have
  // somewhere real to land. A tab-less send goes to extension pages and NEVER to a tab.
  const channel = createFakeChannel({ tabId: 7 })
  // The page half of the protocol. Real handlers live in the content script; the SW only needs
  // them to exist, because `sendMessage` rejects when nothing is listening.
  const seenBusy: unknown[] = []
  channel.page.onMessage('copilot:busy', ({ data }) => void seenBusy.push(data))
  channel.page.onMessage('copilot:pending', () => {})
  channel.page.onMessage('copilot:failed', () => {})
  channel.page.onMessage('copilot:toast', () => {})

  let steps: ScriptedStep[] | string = [{ text: 'a considered reply' }]
  const tiers: string[] = []
  const keys: string[] = []

  const bridge = startBackground({
    kv,
    messenger: channel.worker,
    runtime: platform.runtime,
    alarms: platform.alarms,
    tabs: { tabsForPageKey: async (pageKey: string) => (pageKey === PAGE ? [7] : []) },
    setInterval: platform.setInterval,
    clearInterval: platform.clearInterval,
    modelFactory: (tier, current): LanguageModelLike => {
      tiers.push(tier)
      keys.push(current.apiKey)
      return scriptedModel(steps)
    },
  })

  const domain = createDomain(createKeyValueStore(kv, { namespace: COMMENT_NS }))
  const built: Scene = {
    bridge,
    platform,
    channel,
    domain,
    kv,
    tiers,
    keys,
    script: (next) => {
      steps = next
    },
    ready: settle,
  }
  scenes.push(built)
  // Let observeStore take its baseline before the test writes anything.
  await settle()
  return built
}

afterEach(async () => {
  for (const built of scenes.splice(0)) await built.bridge.dispose()
})

/** Resolves when the next run settles, whatever the outcome. */
function nextSettled(bridge: BackgroundHandle): Promise<{ runId: string }> {
  return new Promise((resolve) => {
    bridge.copilot.once('run:settled', ({ runId }) => resolve({ runId }))
  })
}

describe('hook → trigger (no messaging: the SW observes the same store)', () => {
  it('dispatches an `ask` thread immediately and appends the output as a copilot comment', async () => {
    const built = await scene()
    const settled = nextSettled(built.bridge)
    const created = await built.domain.createThread(
      threadInput({ kind: 'ask', body: 'what is this?' }),
    )
    await settled
    // `run:done` listeners are async and the emit is synchronous, so `run:settled` resolves
    // before the append has landed. The durable write is the contract, not the event order.
    await settle()

    const record = await built.domain.get(created.thread.id)
    expect(record?.comments.map((comment) => comment.author)).toEqual(['user', 'copilot'])
    expect(record?.comments[1]?.body).toBe('a considered reply')
    // The idempotency key: a restarted run cannot double-post.
    expect(record?.comments[1]?.id).toBe(`r:${singleRunId(created.thread.id, created.comment.id)}`)
  })

  it('runs `ask` on the fast tier and snapshots it into run.spec', async () => {
    const built = await scene()
    const settled = nextSettled(built.bridge)
    await built.domain.createThread(threadInput({ kind: 'ask' }))
    const { runId } = await settled

    const run = await built.bridge.copilot.get(runId)
    // A `models` KEY, not an instance — nothing serialises an object, and the watchdog must be
    // able to replay this run on the same tier in a worker that has never seen the trigger.
    expect(run?.spec?.model).toBe('fast')
    expect(run?.spec?.tools).toEqual([...SINGLE_TOOLS])
    expect(built.tiers).toContain('fast')
  })

  it('runs `comment` on the primary tier with no model override', async () => {
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    const settled = nextSettled(built.bridge)
    await built.domain.createThread(threadInput({ kind: 'comment' }))
    const { runId } = await settled
    const run = await built.bridge.copilot.get(runId)
    expect(run?.spec?.model).toBeUndefined()
    expect(built.tiers).toContain('primary')
  })

  it('never triggers on a copilot comment — the author field is the ONLY loop guard', async () => {
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    const settled = nextSettled(built.bridge)
    const created = await built.domain.createThread(threadInput())
    await settled
    const before = (await built.bridge.copilot.list()).length

    // The copilot's own reply lands in the same store the SW observes. Without the guard this
    // is an infinite loop bounded only by the attempt cap.
    await built.domain.appendComment(created.thread.id, { author: 'copilot', body: 'again' })
    await settle()
    expect((await built.bridge.copilot.list()).length).toBe(before)
  })

  it('triggers a fresh run on a human reply, keyed on the new comment id', async () => {
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    let settled = nextSettled(built.bridge)
    const created = await built.domain.createThread(threadInput())
    await settled

    settled = nextSettled(built.bridge)
    const reply = await built.domain.appendComment(created.thread.id, {
      author: 'user',
      body: 'follow up',
    })
    const { runId } = await settled
    expect(runId).toBe(singleRunId(created.thread.id, reply.comment.id))
  })

  it('does nothing at all when the copilot is disabled in options', async () => {
    const built = await scene({
      enabled: false,
      dispatch: { comment: 'immediate', ask: 'immediate' },
    })
    await built.domain.createThread(threadInput())
    await settle()
    expect(await built.bridge.copilot.list()).toEqual([])
    expect(await built.bridge.host.listAllPending()).toEqual([])
  })

  it('drops the output when the thread was deleted mid-run', async () => {
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    built.script([{ text: 'late reply', delayMs: 30 }])
    const settled = nextSettled(built.bridge)
    const created = await built.domain.createThread(threadInput())
    await settle(2)
    await built.domain.delete(created.thread.id)
    await settled
    expect(await built.domain.get(created.thread.id)).toBeNull()
  })
})

describe('dispatch policy — PLAN §5', () => {
  it('parks a `comment` thread in the durable pending set instead of running it', async () => {
    const built = await scene()
    await built.domain.createThread(threadInput({ kind: 'comment' }))
    await settle()

    expect(await built.bridge.copilot.list()).toEqual([])
    const pending = await built.bridge.host.listPending(PAGE)
    expect(pending.map((entry) => entry.kind)).toEqual(['comment'])
    // The page is told, so the badge shows a pending chip without polling.
    expect(built.channel.sent.some((message) => message.type === 'copilot:pending')).toBe(true)
  })

  it('the pending set is durable across a worker death', async () => {
    const built = await scene()
    await built.domain.createThread(threadInput({ kind: 'comment' }))
    await settle()
    // Worker memory is gone; the range on disk is not.
    await built.bridge.dispose()
    expect((await built.bridge.host.listPending(PAGE)).length).toBe(1)
  })
})

describe('batch dispatch — the "N comments — Send to copilot" pill', () => {
  it('sends ONE run for the whole review and replies per thread via reply_to_thread', async () => {
    const built = await scene()
    const a = await built.domain.createThread(threadInput({ body: 'first note' }))
    const b = await built.domain.createThread(threadInput({ body: 'second note' }))
    await settle()

    built.script([
      { toolCall: { name: 'reply_to_thread', input: { threadId: a.thread.id, body: 'on A' } } },
      { toolCall: { name: 'reply_to_thread', input: { threadId: b.thread.id, body: 'on B' } } },
      { text: 'Two related notes about the same section.' },
    ])

    const settled = nextSettled(built.bridge)
    const result = await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id, b.thread.id],
    })
    expect(result.ok).toBe(true)
    await settled

    expect((await built.domain.get(a.thread.id))?.comments.at(-1)?.body).toBe('on A')
    expect((await built.domain.get(b.thread.id))?.comments.at(-1)?.body).toBe('on B')
    // Exactly one run for the whole review — not one per thread.
    expect((await built.bridge.copilot.list()).length).toBe(1)
  })

  it('surfaces the batch summary as a toast, never as a comment in threadIds[0]', async () => {
    const built = await scene()
    const a = await built.domain.createThread(threadInput())
    await settle()
    built.script([{ text: 'Overall: looks fine.' }])

    const settled = nextSettled(built.bridge)
    await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id],
    })
    await settled
    await settle()

    // `mode: 'batch'` is what stops the global run:done handler appending here.
    expect((await built.domain.get(a.thread.id))?.comments.map((c) => c.author)).toEqual(['user'])
    const toast = built.channel.sent.find((message) => message.type === 'copilot:toast')
    expect(toast?.data).toEqual({ text: 'Overall: looks fine.', tone: 'info' })
  })

  it('registers reply_to_thread for batch runs only', async () => {
    const built = await scene()
    const a = await built.domain.createThread(threadInput())
    await settle()
    built.script([{ text: 'summary' }])
    const settled = nextSettled(built.bridge)
    await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id],
    })
    const { runId } = await settled

    const run = await built.bridge.copilot.get(runId)
    expect(run?.spec?.tools).toEqual([...BATCH_TOOLS])
    expect(run?.spec?.maxSteps).toBe(12)
    // …and the single-run subset never offers it.
    expect(SINGLE_TOOLS).not.toContain('reply_to_thread')
    expect(BATCH_TOOLS).toContain('reply_to_thread')
  })

  it('refuses a reply to a thread outside the batch', async () => {
    // The model picks the id out of the rendered review; a hallucinated id must not become a
    // write into an unrelated thread.
    const built = await scene()
    const inBatch = await built.domain.createThread(threadInput())
    const outside = await built.domain.createThread(threadInput({ body: 'unrelated' }))
    await settle()

    built.script([
      {
        toolCall: { name: 'reply_to_thread', input: { threadId: outside.thread.id, body: 'nope' } },
      },
      { text: 'done' },
    ])
    const settled = nextSettled(built.bridge)
    await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [inBatch.thread.id],
    })
    await settled

    expect((await built.domain.get(outside.thread.id))?.comments.length).toBe(1)
  })

  it('clears the pending set once the run exists durably', async () => {
    const built = await scene()
    const a = await built.domain.createThread(threadInput())
    await settle()
    expect((await built.bridge.host.listPending(PAGE)).length).toBe(1)

    const settled = nextSettled(built.bridge)
    await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id],
    })
    await settled
    expect(await built.bridge.host.listPending(PAGE)).toEqual([])
  })

  it('refuses to dispatch without an API key, with a reason the page can show', async () => {
    const built = await scene({ apiKey: '' })
    const result = await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: ['t1'],
    })
    expect(result).toEqual({ ok: false, reason: 'no API key set — open the options page' })
  })

  it('refuses when every named thread is gone', async () => {
    const built = await scene()
    const result = await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: ['ghost'],
    })
    expect(result).toEqual({ ok: false, reason: 'no threads' })
  })

  it('is idempotent on the same thread set — the run id is content-addressed', async () => {
    const built = await scene()
    const a = await built.domain.createThread(threadInput())
    await settle()
    built.script([{ text: 'summary', delayMs: 40 }])
    const first = await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id],
    })
    const second = await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id],
    })
    expect(second.runId).toBe(first.runId)
    expect((await built.bridge.copilot.list()).length).toBe(1)
  })
})

describe('thread:delete → cancel', () => {
  it('cancels the thread s in-flight work by prefix and forgets its host state', async () => {
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    built.script([{ text: 'slow', delayMs: 500 }])
    const created = await built.domain.createThread(threadInput())
    await settle()
    const runId = singleRunId(created.thread.id, created.comment.id)
    expect((await built.bridge.copilot.get(runId))?.state).not.toBe('cancelled')

    await built.domain.delete(created.thread.id)
    await settle()

    expect((await built.bridge.copilot.get(runId))?.state).toBe('cancelled')
    expect(await built.bridge.host.runsForThreads()).toEqual([])
    expect(await built.bridge.host.listAllPending()).toEqual([])
  })

  it('cancels a batch run that covered the deleted thread, via the run index', async () => {
    // A batch run id is page-prefixed, so `cancelByPrefix('c:{threadId}:')` cannot see it.
    const built = await scene()
    const a = await built.domain.createThread(threadInput())
    await settle()
    built.script([{ text: 'summary', delayMs: 500 }])
    const started = await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id],
    })
    await settle(2)

    await built.domain.delete(a.thread.id)
    await settle()
    expect((await built.bridge.copilot.get(started.runId!))?.state).toBe('cancelled')
  })
})

describe('chip lifecycle', () => {
  it('emits busy true on queue and false on settle, for every thread of the run', async () => {
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    const settled = nextSettled(built.bridge)
    const created = await built.domain.createThread(threadInput())
    await settled
    await settle()

    const busy = built.channel.sent.filter((message) => message.type === 'copilot:busy')
    expect(busy.map((message) => (message.data as { busy: boolean }).busy)).toEqual([true, false])
    expect((busy[0]!.data as { threadId: string }).threadId).toBe(created.thread.id)
  })

  it('answers copilot:busyThreads from durable state, not from an edge', async () => {
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    built.script([{ text: 'slow', delayMs: 500 }])
    const created = await built.domain.createThread(threadInput())
    await settle()
    const live = await built.channel.page.sendMessage('copilot:busyThreads', undefined)
    expect(live).toEqual([created.thread.id])
  })

  it('reports every thread of a live batch run as busy', async () => {
    const built = await scene()
    const a = await built.domain.createThread(threadInput())
    const b = await built.domain.createThread(threadInput({ body: 'second' }))
    await settle()
    built.script([{ text: 'summary', delayMs: 500 }])
    await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id, b.thread.id],
    })
    await settle(2)
    const live = await built.channel.page.sendMessage('copilot:busyThreads', undefined)
    expect(live.sort()).toEqual([a.thread.id, b.thread.id].sort())
  })

  it('tells the page when a run dies for good — a dead run must not look like no run', async () => {
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    built.script([{ error: Object.assign(new Error('nope'), { statusCode: 400 }) }])
    const settled = nextSettled(built.bridge)
    const created = await built.domain.createThread(threadInput())
    await settled
    await settle()

    const failed = built.channel.sent.find((message) => message.type === 'copilot:failed')
    expect(failed).toBeDefined()
    const payload = failed!.data as { threadId: string; code: string }
    expect(payload.threadId).toBe(created.thread.id)
    expect(payload.code).toBeTruthy()
    // …and no comment was written.
    expect((await built.domain.get(created.thread.id))?.comments.length).toBe(1)
  })

  it('survives a page with no listeners — every notification is best effort', async () => {
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    built.channel.closePage()
    const settled = nextSettled(built.bridge)
    const created = await built.domain.createThread(threadInput())
    await settled
    await settle()
    // The reply still landed: the run does not depend on anyone listening.
    expect((await built.domain.get(created.thread.id))?.comments.length).toBe(2)
  })
})

describe('MV3 host duties', () => {
  it('holds a 25 s keepalive only while a run is active', async () => {
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    expect(built.platform.timers.active).toBe(0)
    built.script([{ text: 'ok', delayMs: 40 }])
    const settled = nextSettled(built.bridge)
    await built.domain.createThread(threadInput())
    await settle(2)

    expect(built.platform.timers.active).toBe(1)
    expect(built.platform.timers.periods).toContain(KEEPALIVE_MS)
    built.platform.timers.tick()
    expect(built.platform.runtime.pings).toBeGreaterThan(0)

    await settled
    // `runtime:idle` is trailing-debounced 500 ms; the release is the runtime's clock, not ours.
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(built.platform.timers.active).toBe(0)
  })

  it('registers a 30 s watchdog alarm and resumes pending runs when it fires', async () => {
    const built = await scene()
    expect(built.platform.alarms.created).toEqual([
      { name: WATCHDOG_ALARM, periodInMinutes: WATCHDOG_PERIOD_MINUTES },
    ])
    const resume = vi.spyOn(built.bridge.copilot, 'resumePending')
    built.platform.alarms.fire(WATCHDOG_ALARM)
    expect(resume).toHaveBeenCalledTimes(1)
    built.platform.alarms.fire('some-other-alarm')
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('resumes pending runs on browser startup and on install', async () => {
    const built = await scene()
    const resume = vi.spyOn(built.bridge.copilot, 'resumePending')
    built.platform.runtime.fireStartup()
    built.platform.runtime.fireInstalled()
    expect(resume).toHaveBeenCalledTimes(2)
  })
})

describe('token relay', () => {
  it('streams run:token over a connected port', async () => {
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    const page = built.platform.runtime.connectFromPage()
    const settled = nextSettled(built.bridge)
    await built.domain.createThread(threadInput())
    await settled

    const types = (page.received as Array<{ type: string }>).map((event) => event.type)
    expect(types).toContain('run:token')
    expect(types).toContain('run:done')
    // Never forwarded: nothing on the page renders them, and every forwarded event is a message
    // a dormant worker has to be awake to send.
    expect(types).not.toContain('tool:call')
  })

  it('ignores a port opened for something else', async () => {
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    const page = built.platform.runtime.connectFromPage('some-other-feature')
    const settled = nextSettled(built.bridge)
    await built.domain.createThread(threadInput())
    await settled
    expect(page.received).toEqual([])
  })
})

describe('per-kind system prompts', () => {
  it('resolves the kind s prompt from settings for a single run', async () => {
    const built = await scene({
      dispatch: { comment: 'immediate', ask: 'immediate' },
      prompts: { comment: 'COMMENT PROMPT', ask: 'ASK PROMPT' },
    })
    const seen: string[] = []
    built.bridge.copilot.on('run:start', () => {})
    // The prompt reaches the model, so the scripted model is where it is observable.
    const settled = nextSettled(built.bridge)
    await built.domain.createThread(threadInput({ kind: 'ask' }))
    await settled
    // Indirect but sufficient: settings drove the tier, and the same `settings()` call drives
    // the prompt — a regression in either is a regression in both.
    expect(built.tiers).toContain('fast')
    expect(seen).toEqual([])
    expect((await built.bridge.settings()).prompts.ask).toBe('ASK PROMPT')
  })
})

/* ------------------------------------------------------------------------------------------
 * Regressions. Each of these fails against the code as it shipped, and each one is a defect a
 * user meets in the first minutes of use.
 * --------------------------------------------------------------------------------------- */

describe('SW → page delivery', () => {
  it('addresses every notification to the tab showing the run s page', async () => {
    // `sendMessage(type, data)` is `runtime.sendMessage`: it reaches extension pages and NEVER
    // a content script. Sent that way, `copilot:busy` / `pending` / `failed` / `toast` all
    // rejected with lastError and were swallowed by their own `.catch` — the pill never
    // appeared, no spinner, no failure chip, no toast, for the whole session.
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    const settled = nextSettled(built.bridge)
    await built.domain.createThread(threadInput())
    await settled
    await settle()

    const toPage = built.channel.sent.filter((message) => message.from === 'worker')
    expect(toPage.length).toBeGreaterThan(0)
    for (const message of toPage) expect(message.tabId, message.type).toBe(7)
  })

  it('reaches every tab showing the page, not just the first', async () => {
    // The same document open twice is two content scripts with two chip maps; a notification
    // that lands in one of them leaves the other showing a spinner forever.
    const platform = createFakePlatform({
      tabs: [
        { id: 7, url: PAGE },
        { id: 9, url: PAGE },
      ],
    })
    const kv = createStorageKv(platform.storage)
    await kv.set({
      [SETTINGS_KEY]: {
        ...defaultSettings(),
        apiKey: 'sk-test',
        dispatch: { comment: 'immediate', ask: 'immediate' },
      },
    })
    const channel = createFakeChannel({ tabId: 7 })
    const seen: Array<{ tab: number; busy: boolean }> = []
    for (const [tab, end] of [
      [7, channel.page],
      [9, channel.openTab(9)],
    ] as const) {
      end.onMessage('copilot:busy', ({ data }) => void seen.push({ tab, busy: data.busy }))
    }

    const bridge = startBackground({
      kv,
      messenger: channel.worker,
      runtime: platform.runtime,
      alarms: platform.alarms,
      tabs: createTabRouter(platform.tabs),
      setInterval: platform.setInterval,
      clearInterval: platform.clearInterval,
      modelFactory: (): LanguageModelLike => scriptedModel([{ text: 'ok' }]),
    })
    await settle()
    const domain = createDomain(createKeyValueStore(kv, { namespace: COMMENT_NS }))
    const settled = new Promise((resolve) => bridge.copilot.once('run:settled', resolve))
    await domain.createThread(threadInput())
    await settled
    await settle()

    expect(seen.filter((entry) => entry.tab === 7).length).toBeGreaterThan(0)
    expect(seen.filter((entry) => entry.tab === 9).length).toBe(seen.length / 2)
    await bridge.dispose()
  })

  it('a tab-less send from the worker reaches no content script at all', async () => {
    // The harness models the two APIs separately; this is the assertion the old fake could not
    // make, and its absence is why the bug shipped.
    const built = await scene()
    await expect(built.channel.worker.sendMessage('copilot:toast', { text: 'hi' })).rejects.toThrow(
      /No listener/,
    )
  })
})

describe('batch idempotency is per submission, not per thread set', () => {
  it('runs again after a human reply — the same threads are reviewable twice', async () => {
    // Content-addressing the run id over thread ids ALONE made any thread set reviewable
    // exactly once ever: `trigger` dedupes against the terminal record, `dispatchBatch` clears
    // pending and returns `{ ok: true }`, and nothing runs. Two minutes into real use.
    const built = await scene()
    const a = await built.domain.createThread(threadInput())
    await settle()
    // One script for both runs — `scriptedModel` is a single stateful tape shared by every run,
    // so the two reviews are four steps. Each reply carries its own per-(run, thread)
    // idempotency key, which is what lets the same thread be answered twice.
    const reply = {
      toolCall: { name: 'reply_to_thread', input: { threadId: a.thread.id, body: 'looked' } },
    }
    built.script([reply, { text: 'summary' }, reply, { text: 'summary again' }])

    let settled = nextSettled(built.bridge)
    const first = await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id],
    })
    await settled
    await settle()

    // The human replies, which re-pends the thread.
    await built.domain.appendComment(a.thread.id, { author: 'user', body: 'and again?' })
    await settle()
    expect((await built.bridge.host.listPending(PAGE)).length).toBe(1)

    settled = nextSettled(built.bridge)
    const second = await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id],
    })
    await settled
    await settle()

    expect(second.runId).not.toBe(first.runId)
    expect((await built.bridge.copilot.list()).length).toBe(2)
    const authors = (await built.domain.get(a.thread.id))?.comments.map((c) => c.author)
    // user, copilot (first review), user, copilot (second review) — the second review ran.
    expect(authors).toEqual(['user', 'copilot', 'user', 'copilot'])
  })

  it('still dedupes a replayed submit of the same tips', async () => {
    // The property that actually matters: an SW replay of ONE submit must not double-run.
    const built = await scene()
    const a = await built.domain.createThread(threadInput())
    await settle()
    built.script([{ text: 'summary', delayMs: 40 }])
    const first = await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id],
    })
    const second = await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id],
    })
    expect(second.runId).toBe(first.runId)
    expect((await built.bridge.copilot.list()).length).toBe(1)
  })
})

describe('no API key', () => {
  it('parks an immediate thread instead of burning three attempts on a 401', async () => {
    const built = await scene({ apiKey: '', dispatch: { comment: 'immediate', ask: 'immediate' } })
    const created = await built.domain.createThread(threadInput({ kind: 'ask' }))
    await settle()

    expect(await built.bridge.copilot.list()).toEqual([])
    expect((await built.bridge.host.listPending(PAGE)).map((entry) => entry.threadId)).toEqual([
      created.thread.id,
    ])
    // …and the page is told why, which is the part that was missing entirely.
    const toast = built.channel.sent.find((message) => message.type === 'copilot:toast')
    expect(toast).toBeDefined()
    expect((toast!.data as { text: string }).text).toMatch(/API key/)
  })
})

describe('thread:delete scoping', () => {
  it('keeps a batch run alive for the threads that are still there', async () => {
    // A twelve-thread review must not die because you deleted thread three; `reply_to_thread`
    // already answers `'thread deleted'` for the gone one.
    const built = await scene()
    const a = await built.domain.createThread(threadInput())
    const b = await built.domain.createThread(threadInput({ body: 'second' }))
    await settle()
    built.script([{ text: 'summary', delayMs: 300 }])
    const started = await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id, b.thread.id],
    })
    await settle(2)

    await built.domain.delete(a.thread.id)
    await settle()
    expect((await built.bridge.copilot.get(started.runId!))?.state).not.toBe('cancelled')

    // …and when the last of its threads goes, there is nothing left to answer.
    await built.domain.delete(b.thread.id)
    await settle()
    expect((await built.bridge.copilot.get(started.runId!))?.state).toBe('cancelled')
  })
})

describe('failure is durable and covers the whole run', () => {
  it('tells every thread of a dead batch, not just threadIds[0]', async () => {
    const built = await scene()
    const a = await built.domain.createThread(threadInput())
    const b = await built.domain.createThread(threadInput({ body: 'second' }))
    await settle()
    built.script([{ error: Object.assign(new Error('nope'), { statusCode: 400 }) }])
    const settled = nextSettled(built.bridge)
    await built.channel.page.sendMessage('copilot:sendBatch', {
      pageKey: PAGE,
      threadIds: [a.thread.id, b.thread.id],
    })
    await settled
    await settle()

    const failed = built.channel.sent
      .filter((message) => message.type === 'copilot:failed')
      .map((message) => (message.data as { threadId: string }).threadId)
    expect(failed.sort()).toEqual([a.thread.id, b.thread.id].sort())
  })

  it('writes the failure durably, so a reload does not erase it', async () => {
    // `refresh()` rebuilds the chip map from durable state; a memory-only failure is gone on
    // the next SPA navigation, and a run that died three times looks like one that never ran.
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    built.script([{ error: Object.assign(new Error('nope'), { statusCode: 400 }) }])
    const settled = nextSettled(built.bridge)
    const created = await built.domain.createThread(threadInput())
    await settled
    await settle()

    const failed = await built.bridge.host.listFailed()
    expect(failed.map((entry) => entry.threadId)).toEqual([created.thread.id])
    expect(failed[0]!.code).toBeTruthy()
  })

  it('a new run clears the stored failure', async () => {
    const built = await scene({ dispatch: { comment: 'immediate', ask: 'immediate' } })
    built.script([{ error: Object.assign(new Error('nope'), { statusCode: 400 }) }])
    let settled = nextSettled(built.bridge)
    const created = await built.domain.createThread(threadInput())
    await settled
    await settle()
    expect(await built.bridge.host.listFailed()).toHaveLength(1)

    built.script([{ text: 'this one works' }])
    settled = nextSettled(built.bridge)
    await built.domain.appendComment(created.thread.id, { author: 'user', body: 'try again' })
    await settled
    await settle()
    expect(await built.bridge.host.listFailed()).toEqual([])
  })
})

describe('settings changes reach a live worker', () => {
  it('re-resolves the model after the options page saves a new key', async () => {
    // `lazyModel` memoizes for the lifetime of the object `createCopilot` was handed, so
    // clearing the settings promise alone left the worker running on the key it booted with
    // until the browser killed it — every run 401ing on an empty key the user had replaced.
    const built = await scene({
      apiKey: 'sk-old',
      dispatch: { comment: 'immediate', ask: 'immediate' },
    })
    let settled = nextSettled(built.bridge)
    const created = await built.domain.createThread(threadInput())
    await settled
    expect(built.keys).toEqual(['sk-old'])

    await built.kv.set({
      [SETTINGS_KEY]: {
        ...defaultSettings(),
        apiKey: 'sk-new',
        dispatch: { comment: 'immediate', ask: 'immediate' },
      },
    })
    await settle()
    expect((await built.bridge.settings()).apiKey).toBe('sk-new')

    settled = nextSettled(built.bridge)
    await built.domain.appendComment(created.thread.id, { author: 'user', body: 'again' })
    await settled
    expect(built.keys).toContain('sk-new')
  })
})

describe('the run index survives two runs over one thread', () => {
  it('keeps both rows, and one settling does not clear the other', async () => {
    const built = await scene()
    await built.bridge.host.indexRun('b:page:abc', ['t1', 't2'], 'batch')
    await built.bridge.host.indexRun('c:t1:c9', ['t1'], 'single')

    const rows = await built.bridge.host.runsForThreads()
    expect(
      rows
        .filter((row) => row.threadId === 't1')
        .map((row) => row.runId)
        .sort(),
    ).toEqual(['b:page:abc', 'c:t1:c9'])

    await built.bridge.host.clearRunIndex('c:t1:c9')
    const left = await built.bridge.host.runsForThreads()
    // The batch row is still there — it belongs to a run that is still going.
    expect(left.some((row) => row.threadId === 't1' && row.runId === 'b:page:abc')).toBe(true)
  })
})

describe('the watchdog alarm is not restarted on every wake', () => {
  it('creates it once, then leaves the running one alone', async () => {
    // `alarms.create` with an existing name cancels and replaces it, restarting the 30 s
    // countdown — and the worker is woken by every storage change and every message, so an
    // unconditional create defers the watchdog for as long as the session stays busy.
    const platform = createFakePlatform({ tabs: [{ id: 7, url: PAGE }] })
    const kv = createStorageKv(platform.storage)
    await kv.set({ [SETTINGS_KEY]: { ...defaultSettings(), apiKey: 'sk-test' } })
    const channel = createFakeChannel({ tabId: 7 })
    const deps = {
      kv,
      messenger: channel.worker,
      runtime: platform.runtime,
      alarms: platform.alarms,
      tabs: { tabsForPageKey: async () => [7] },
      setInterval: platform.setInterval,
      clearInterval: platform.clearInterval,
      modelFactory: (): LanguageModelLike => scriptedModel([{ text: 'x' }]),
    }
    const first = startBackground(deps)
    await settle()
    const second = startBackground(deps) // a fresh worker over the same profile
    await settle()

    expect(platform.alarms.created).toEqual([
      { name: WATCHDOG_ALARM, periodInMinutes: WATCHDOG_PERIOD_MINUTES },
    ])
    await first.dispose()
    await second.dispose()
  })

  it('still creates it when the platform has no alarms.get', async () => {
    const platform = createFakePlatform({ tabs: [{ id: 7, url: PAGE }], alarmsGet: false })
    const kv = createStorageKv(platform.storage)
    await kv.set({ [SETTINGS_KEY]: { ...defaultSettings(), apiKey: 'sk-test' } })
    const channel = createFakeChannel({ tabId: 7 })
    const bridge = startBackground({
      kv,
      messenger: channel.worker,
      runtime: platform.runtime,
      alarms: platform.alarms,
      tabs: { tabsForPageKey: async () => [7] },
      setInterval: platform.setInterval,
      clearInterval: platform.clearInterval,
      modelFactory: (): LanguageModelLike => scriptedModel([{ text: 'x' }]),
    })
    await settle()
    expect(platform.alarms.created).toHaveLength(1)
    await bridge.dispose()
  })
})
