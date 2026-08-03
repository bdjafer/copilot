/**
 * The content script (SPEC-comment-core §7.2 + SPEC-copilot §6's content half), under happy-dom.
 * Real engine, real `comment-ui`, real `serveTools` — only the platform is faked.
 */

import type { CreateThreadInput } from '@astrale-os/comment-core'

import { CopilotError } from '@astrale-os/browser-copilot'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ContentHandle } from '../src/content/index.ts'
import type { FakePort } from './support/fake-chrome.ts'

import { createChipStore, decorationFor } from '../src/content/chips.ts'
import { startContent } from '../src/content/index.ts'
import {
  HOST_CHROME_Z_INDEX,
  hostChromeStyles,
  mountHostChrome,
  TOAST_MS,
} from '../src/content/pill.ts'
import { createToolServer } from '../src/content/tools.ts'
import { createHostState } from '../src/host-state.ts'
import { SETTINGS_KEY } from '../src/keys.ts'
import { createStorageKv } from '../src/kv.ts'
import { defaultSettings } from '../src/settings.ts'
import { createFakeStorage, createPortPair } from './support/fake-chrome.ts'
import { createFakeChannel } from './support/fake-messaging.ts'

const flush = async (times = 6): Promise<void> => {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** The minimum a `createThread` call needs; the anchor points at `<body>`, which always exists. */
const threadFixture = (pageKey: string, kind = 'comment'): CreateThreadInput => ({
  pageKey,
  kind,
  author: 'user',
  body: 'note',
  anchor: {
    mode: 'element' as const,
    selectors: [{ type: 'css' as const, value: 'body' }],
    fingerprint: { tag: 'body', stableClasses: [], attrs: {}, textDigest: '' },
  },
  capture: {
    outerHTML: '<body></body>',
    text: '',
    cssPath: 'body',
    page: { url: 'x', title: 'y' },
    capturedAt: '2026-01-01T00:00:00.000Z',
  },
})

/* --------------------------------------------------------------------- chips */

describe('decorationFor — the chip precedence', () => {
  it('renders nothing for an empty state', () => {
    expect(decorationFor(undefined)).toBeNull()
    expect(decorationFor({})).toBeNull()
  })

  it('busy beats everything — it is the only state that changes on its own', () => {
    const decoration = decorationFor({ busy: true, pending: true, failed: 'timeout', unread: true })
    expect(decoration?.chip).toEqual({ text: 'copilot', tone: 'busy', spinner: true })
  })

  it('a dead run outranks a pending one', () => {
    expect(decorationFor({ failed: 'max_attempts', pending: true })?.chip).toEqual({
      text: 'max_attempts',
      tone: 'warn',
    })
  })

  it('pending outranks unread', () => {
    expect(decorationFor({ pending: true, unread: true })?.chip?.text).toBe('pending')
  })

  it('renders unread on its own', () => {
    expect(decorationFor({ unread: true })?.chip).toEqual({ text: 'new reply', tone: 'info' })
  })

  it('only ever emits tones comment-ui declares', () => {
    const tones = new Set(['neutral', 'info', 'busy', 'warn', 'danger'])
    for (const state of [{ busy: true }, { failed: 'x' }, { pending: true }, { unread: true }]) {
      expect(tones.has(decorationFor(state)!.chip!.tone!)).toBe(true)
    }
  })
})

describe('createChipStore', () => {
  const scene = () => {
    const applied: Array<[string, unknown]> = []
    const chips = createChipStore((threadId, decoration) => applied.push([threadId, decoration]))
    return { chips, applied }
  }

  it('applies a decoration and clears it with null', () => {
    const { chips, applied } = scene()
    chips.setBusy('t1', true)
    chips.setBusy('t1', false)
    expect(applied[0]?.[1]).toMatchObject({ chip: { tone: 'busy' } })
    expect(applied[1]?.[1]).toBeNull()
    expect(chips.keys()).toEqual([])
  })

  it('a new run clears the previous run s failure code', () => {
    // Otherwise a retry that succeeds leaves the old error showing forever.
    const { chips } = scene()
    chips.setFailed('t1', 'rate_limited')
    chips.setBusy('t1', true)
    expect(chips.get('t1')?.failed).toBeUndefined()
  })

  it('setFailed also clears busy — a dead run is not a running one', () => {
    const { chips } = scene()
    chips.setBusy('t1', true)
    chips.setFailed('t1', 'max_attempts')
    expect(chips.get('t1')).toEqual({ failed: 'max_attempts' })
  })

  it('reset re-derives the whole map and clears threads that fell out', () => {
    // §7.2: chips are edge-driven, so a worker death between busy:true and busy:false leaves a
    // chip spinning forever unless the page re-derives from durable state.
    const { chips, applied } = scene()
    chips.setBusy('stale', true)
    applied.length = 0
    chips.reset(['t1'], ['t2'], ['t3'])
    const byThread = new Map(applied)
    expect(byThread.get('stale')).toBeNull()
    expect(byThread.get('t1')).toMatchObject({ chip: { tone: 'busy' } })
    expect(byThread.get('t2')).toMatchObject({ chip: { text: 'pending' } })
    expect(byThread.get('t3')).toMatchObject({ chip: { text: 'new reply' } })
  })

  it('reset merges a thread that is both pending and unread', () => {
    const { chips } = scene()
    chips.reset([], ['t1'], ['t1'])
    expect(chips.get('t1')).toEqual({ pending: true, unread: true })
  })

  it('clear drops everything it was showing', () => {
    const { chips, applied } = scene()
    chips.setBusy('t1', true)
    chips.setPending('t2', true)
    applied.length = 0
    chips.clear()
    expect(applied.map(([id, decoration]) => [id, decoration])).toEqual([
      ['t1', null],
      ['t2', null],
    ])
  })
})

/* ---------------------------------------------------------------------- pill */

describe('host chrome (PLAN §5 pill + toast)', () => {
  const scene = () => {
    const container = document.createElement('div')
    document.body.append(container)
    const onSend = vi.fn()
    const onDismiss = vi.fn()
    const timers: Array<() => void> = []
    const chrome = mountHostChrome(container, {
      onSend,
      onDismiss,
      setTimeout: (handler) => timers.push(handler),
      clearTimeout: () => {},
    })
    return { container, chrome, onSend, onDismiss, timers }
  }

  it('is hidden at zero and shows a pluralised count', () => {
    const { chrome, container } = scene()
    const pill = container.querySelector('.cc-pill') as HTMLElement
    expect(pill.hidden).toBe(true)
    chrome.setPendingCount(1)
    expect(pill.hidden).toBe(false)
    expect(container.querySelector('.cc-pill-count')?.textContent).toBe('1 comment')
    chrome.setPendingCount(3)
    expect(container.querySelector('.cc-pill-count')?.textContent).toBe('3 comments')
    chrome.setPendingCount(0)
    expect(pill.hidden).toBe(true)
  })

  it('clamps a negative count instead of rendering it', () => {
    const { chrome, container } = scene()
    chrome.setPendingCount(-4)
    expect(chrome.pendingCount).toBe(0)
    expect((container.querySelector('.cc-pill') as HTMLElement).hidden).toBe(true)
  })

  it('fires onSend, and not while sending', () => {
    const { chrome, container, onSend } = scene()
    chrome.setPendingCount(2)
    const send = container.querySelector('.cc-pill-send') as HTMLButtonElement
    send.click()
    chrome.setSending(true)
    send.click()
    expect(onSend).toHaveBeenCalledTimes(1)
    expect(send.disabled).toBe(true)
    chrome.setSending(false)
    expect(send.disabled).toBe(false)
  })

  it('fires onDismiss', () => {
    const { chrome, container, onDismiss } = scene()
    chrome.setPendingCount(1)
    ;(container.querySelector('.cc-pill-dismiss') as HTMLButtonElement).click()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('shows a toast and hides it on the timer', () => {
    const { chrome, container, timers } = scene()
    chrome.toast('all done')
    const toast = container.querySelector('.cc-toast') as HTMLElement
    expect(toast.hidden).toBe(false)
    expect(toast.textContent).toBe('all done')
    expect(toast.getAttribute('data-tone')).toBe('info')
    timers.pop()!()
    expect(toast.hidden).toBe(true)
  })

  it('a second toast replaces the first rather than stacking', () => {
    const { chrome, container, timers } = scene()
    chrome.toast('one')
    chrome.toast('two', 'warn')
    expect(container.querySelectorAll('.cc-toast')).toHaveLength(1)
    const toast = container.querySelector('.cc-toast') as HTMLElement
    expect(toast.textContent).toBe('two')
    expect(toast.getAttribute('data-tone')).toBe('warn')
    expect(timers).toHaveLength(2)
  })

  it('every control is a typed, named button', () => {
    const { container } = scene()
    for (const button of container.querySelectorAll('button')) {
      expect(button.type).toBe('button')
      expect((button.textContent ?? '').trim().length).toBeGreaterThan(0)
    }
  })

  it('announces the count without moving focus', () => {
    const { container } = scene()
    const pill = container.querySelector('.cc-pill') as HTMLElement
    expect(pill.getAttribute('role')).toBe('status')
    expect(pill.getAttribute('aria-live')).toBe('polite')
  })

  it('destroy removes the overlay from the page', () => {
    const { chrome, container } = scene()
    chrome.destroy()
    expect(container.querySelector('.cc-host')).toBeNull()
  })

  it('sits below comment-ui in the stacking order', () => {
    // Host chrome is the host's own overlay, and a thread popover must always win.
    expect(HOST_CHROME_Z_INDEX).toBeLessThan(2147483000)
    expect(hostChromeStyles).toContain(`z-index: ${HOST_CHROME_Z_INDEX}`)
  })

  it('pins its own font-size — the documented WXT `all: initial` caveat', () => {
    expect(hostChromeStyles).toMatch(/font-size:\s*16px/)
    expect(hostChromeStyles).toContain('all: initial')
  })

  it('uses no rem unit anywhere, which is what the caveat actually requires', () => {
    // `rem` resolves against the page's `<html>`, which `all: initial` on `:host` does not
    // reach — so on any site using the `html { font-size: 62.5% }` idiom every rem here renders
    // at 10px-scale. The old assertion checked only the pin, and four rem values sat under it.
    expect(hostChromeStyles).not.toMatch(/\d\s*rem\b/)
    expect(hostChromeStyles).toMatch(/font-size:\s*14px/)
  })

  it('lets pointer events through everywhere except its own controls', () => {
    expect(hostChromeStyles).toContain('pointer-events: none')
    expect(hostChromeStyles).toContain('.cc-host > * { pointer-events: auto; }')
  })

  it('has a dwell time long enough to read and short enough to leave', () => {
    expect(TOAST_MS).toBeGreaterThanOrEqual(4000)
    expect(TOAST_MS).toBeLessThanOrEqual(15000)
  })
})

/* ------------------------------------------------------------------ DOM tools */

describe('serveTools — the single normative content-script tool half', () => {
  const server = (over: Partial<Parameters<typeof createToolServer>[0]> = {}) => {
    const toast = vi.fn()
    const served = createToolServer({
      engine: { getThreadView: () => null },
      document,
      toast,
      ...over,
    })
    return { served, toast }
  }

  it('serves exactly the three DOM tools of PLAN §5', () => {
    expect([...server().served.names]).toEqual([
      'get_page_context',
      'get_thread_element_html',
      'show_message',
    ])
  })

  it('get_page_context reports url, title, outline and selection', async () => {
    document.title = 'A Doc'
    document.body.innerHTML = '<h1>One</h1><h2>  Two  </h2><h3></h3><p>body</p>'
    const { served } = server({ getSelection: () => 'picked text' })
    const context = (await served.handle('get_page_context', {})) as {
      title: string
      headings: Array<{ level: number; text: string }>
      selection: string | null
    }
    expect(context.title).toBe('A Doc')
    expect(context.headings).toEqual([
      { level: 1, text: 'One' },
      { level: 2, text: 'Two' }, // whitespace collapsed
    ]) // the empty h3 is dropped
    expect(context.selection).toBe('picked text')
  })

  it('get_page_context reports a null selection rather than an empty string', async () => {
    const { served } = server({ getSelection: () => null })
    const context = (await served.handle('get_page_context', {})) as { selection: string | null }
    expect(context.selection).toBeNull()
  })

  it('get_thread_element_html returns live HTML for an anchored thread', async () => {
    const element = document.createElement('p')
    element.id = 'anchored'
    element.textContent = 'live'
    const { served } = server({
      engine: { getThreadView: () => ({ anchoring: { element } }) as never },
    })
    expect(await served.handle('get_thread_element_html', { threadId: 't1' })).toBe(
      '<p id="anchored">live</p>',
    )
  })

  it('returns null — precisely "orphaned" — when the element is gone', async () => {
    // `null` is a value the model can act on; a throw is not.
    const { served } = server({
      engine: { getThreadView: () => ({ anchoring: { element: null } }) as never },
    })
    expect(await served.handle('get_thread_element_html', { threadId: 't1' })).toBeNull()
  })

  it('throws tool_failed for an unknown thread', async () => {
    const { served } = server()
    await expect(served.handle('get_thread_element_html', { threadId: 'ghost' })).rejects.toThrow(
      /unknown thread ghost/,
    )
  })

  it('truncates a huge element rather than shipping a megabyte into the prompt', async () => {
    const element = document.createElement('div')
    element.textContent = 'x'.repeat(20000)
    const { served } = server({
      engine: { getThreadView: () => ({ anchoring: { element } }) as never },
    })
    const html = (await served.handle('get_thread_element_html', { threadId: 't1' })) as string
    expect(html.length).toBeLessThan(9000)
    expect(html.endsWith('…')).toBe(true)
  })

  it('show_message reaches the page and acknowledges', async () => {
    const { served, toast } = server()
    expect(await served.handle('show_message', { text: 'heads up' })).toBe('shown')
    expect(toast).toHaveBeenCalledWith('heads up')
  })

  it('validates on arrival — §3.4 requires it on both ends', async () => {
    const { served } = server()
    await expect(served.handle('get_thread_element_html', { threadId: 42 })).rejects.toSatisfy(
      (error: unknown) => CopilotError.is(error, 'tool_input_invalid'),
    )
  })

  it('rejects an unknown tool name with tool_not_found', async () => {
    const { served } = server()
    await expect(served.handle('delete_everything', {})).rejects.toSatisfy((error: unknown) =>
      CopilotError.is(error, 'tool_not_found'),
    )
  })
})

/* ------------------------------------------------------------------ end to end */

describe('startContent', () => {
  const handles: ContentHandle[] = []

  afterEach(() => {
    for (const handle of handles.splice(0)) handle.destroy()
    document.body.innerHTML = ''
    for (const host of document.querySelectorAll('[data-comment-ui]')) host.remove()
  })

  async function scene(over: { runtime?: { connect: () => FakePort } } = {}) {
    const storage = createFakeStorage()
    const kv = createStorageKv(storage)
    await kv.set({ [SETTINGS_KEY]: defaultSettings() })
    const channel = createFakeChannel()
    const host = createHostState(kv)

    const busyThreads: string[] = []
    channel.worker.onMessage('copilot:busyThreads', () => busyThreads)
    const batches: Array<{ pageKey: string; threadIds: string[] }> = []
    channel.worker.onMessage('copilot:sendBatch', ({ data }) => {
      batches.push(data)
      return { ok: true, runId: 'b:1' }
    })

    const container = document.createElement('div')
    document.body.append(container)

    const handle = await startContent({
      kv,
      messenger: channel.page,
      mountChrome: (handlers) => mountHostChrome(container, handlers),
      ...(over.runtime ? { runtime: over.runtime } : {}),
    })
    handles.push(handle)
    return { handle, kv, host, channel, container, busyThreads, batches }
  }

  it('mounts one comment-ui shadow root and the host overlay beside it', async () => {
    const { handle, container } = await scene()
    expect(handle.ui.root).toBeTruthy()
    expect(container.querySelector('[data-copilot-host]')).toBeTruthy()
  })

  it('registers the three DOM tool endpoints under `tool:` keys', async () => {
    const { channel } = await scene()
    document.title = 'Served'
    const context = (await channel.worker.sendMessage(
      'tool:get_page_context',
      {},
      channel.tabId,
    )) as { title: string }
    expect(context.title).toBe('Served')
  })

  it('does not announce itself — page:hello was a second worker wake per page load', async () => {
    // The handler on the far end stored nothing, and `tabs.query` re-derives the routing it
    // claimed to enable. On `<all_urls>` at `document_start` that was one spurious service
    // worker start per page, in every tab.
    const { channel } = await scene()
    expect(channel.sent.map((message) => message.type)).not.toContain('page:hello')
  })

  it('asks the worker who is busy only when the page actually has threads', async () => {
    const { channel } = await scene()
    // A page with no threads has nothing a busy answer could decorate; asking anyway wakes the
    // worker from every tab on the web.
    expect(channel.sent.map((message) => message.type)).not.toContain('copilot:busyThreads')
  })

  it('re-derives chips from durable state on mount — §7.2 is mandatory, not optional', async () => {
    const { handle, host, busyThreads } = await scene()
    const created = await handle.engine.createThread({
      pageKey: handle.engine.pageKey,
      kind: 'comment',
      author: 'user',
      body: 'note',
      anchor: {
        mode: 'element',
        selectors: [{ type: 'css', value: 'body' }],
        fingerprint: { tag: 'body', stableClasses: [], attrs: {}, textDigest: '' },
      },
      capture: {
        outerHTML: '<body></body>',
        text: '',
        cssPath: 'body',
        page: { url: 'x', title: 'y' },
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    await flush()

    // A worker death between busy:true and busy:false is exactly this shape.
    busyThreads.push(created.thread.id)
    const decorate = vi.spyOn(handle.ui, 'decorate')
    await handle.refresh()
    expect(decorate).toHaveBeenCalledWith(
      created.thread.id,
      expect.objectContaining({ chip: expect.objectContaining({ tone: 'busy' }) }),
    )
    void host
  })

  it('counts only this page s pending threads on the pill', async () => {
    const { handle, host } = await scene()
    const created = await handle.engine.createThread({
      pageKey: handle.engine.pageKey,
      kind: 'comment',
      author: 'user',
      body: 'note',
      anchor: {
        mode: 'element',
        selectors: [{ type: 'css', value: 'body' }],
        fingerprint: { tag: 'body', stableClasses: [], attrs: {}, textDigest: '' },
      },
      capture: {
        outerHTML: '<body></body>',
        text: '',
        cssPath: 'body',
        page: { url: 'x', title: 'y' },
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    await host.markPending({
      threadId: created.thread.id,
      pageKey: handle.engine.pageKey,
      kind: 'comment',
    })
    // A pending entry for another page must not inflate this page's pill.
    await host.markPending({
      threadId: 'elsewhere',
      pageKey: 'https://other/page',
      kind: 'comment',
    })
    await handle.refresh()
    expect(handle.chrome.pendingCount).toBe(1)
  })

  it('the pill sends the page s pending set and refreshes afterwards', async () => {
    const { handle, host, container, batches } = await scene()
    const created = await handle.engine.createThread({
      pageKey: handle.engine.pageKey,
      kind: 'comment',
      author: 'user',
      body: 'note',
      anchor: {
        mode: 'element',
        selectors: [{ type: 'css', value: 'body' }],
        fingerprint: { tag: 'body', stableClasses: [], attrs: {}, textDigest: '' },
      },
      capture: {
        outerHTML: '<body></body>',
        text: '',
        cssPath: 'body',
        page: { url: 'x', title: 'y' },
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
    })
    await host.markPending({
      threadId: created.thread.id,
      pageKey: handle.engine.pageKey,
      kind: 'comment',
    })
    await handle.refresh()
    ;(container.querySelector('.cc-pill-send') as HTMLButtonElement).click()
    await flush()

    expect(batches).toEqual([{ pageKey: handle.engine.pageKey, threadIds: [created.thread.id] }])
  })

  it('renders a copilot toast pushed from the service worker', async () => {
    const { channel, container } = await scene()
    await channel.worker.sendMessage(
      'copilot:toast',
      { text: 'batch done', tone: 'warn' },
      channel.tabId,
    )
    const toast = container.querySelector('.cc-toast') as HTMLElement
    expect(toast.hidden).toBe(false)
    expect(toast.textContent).toBe('batch done')
    expect(toast.getAttribute('data-tone')).toBe('warn')
  })

  it('applies busy / pending / failed chips pushed from the service worker', async () => {
    const { handle, channel } = await scene()
    const decorate = vi.spyOn(handle.ui, 'decorate')
    await channel.worker.sendMessage('copilot:busy', { threadId: 't1', busy: true }, channel.tabId)
    expect(decorate).toHaveBeenLastCalledWith(
      't1',
      expect.objectContaining({ chip: expect.objectContaining({ tone: 'busy' }) }),
    )
    await channel.worker.sendMessage(
      'copilot:failed',
      { threadId: 't1', code: 'max_attempts' },
      channel.tabId,
    )
    expect(decorate).toHaveBeenLastCalledWith(
      't1',
      expect.objectContaining({ chip: { text: 'max_attempts', tone: 'warn' } }),
    )
  })

  it('routes the chrome.commands fallback into startPlacement', async () => {
    const { handle, channel } = await scene()
    const start = vi.spyOn(handle.engine, 'startPlacement')
    await channel.worker.sendMessage('trigger', { kind: 'ask' }, channel.tabId)
    expect(start).toHaveBeenCalledWith('ask')
  })

  it('re-applies modes when the options page changes a trigger key — no remount', async () => {
    const { handle, kv } = await scene()
    const setModes = vi.spyOn(handle.engine, 'setModes')
    await kv.set({
      [SETTINGS_KEY]: {
        ...defaultSettings(),
        triggers: { comment: { key: 'k' }, ask: { key: 'j' } },
      },
    })
    await flush()
    expect(setModes).toHaveBeenCalledTimes(1)
    expect(setModes.mock.calls[0]?.[0]?.[0]?.trigger).toMatchObject({ key: 'k' })
    // The same UI instance is still mounted — decorations and listeners are untouched.
    expect(handle.ui.root.isConnected).toBe(true)
  })

  it('destroy tears down the UI, the overlay and the engine', async () => {
    const { handle, container } = await scene()
    handles.length = 0
    handle.destroy()
    expect(container.querySelector('[data-copilot-host]')).toBeNull()
    expect(handle.engine.status.get()).toBe('destroyed')
  })

  describe('the token relay has a client (PLAN §4.5)', () => {
    const flushRelay = () => flush(2)

    it('opens the port when a thread on this page goes busy, and closes it when it settles', async () => {
      // Without a caller `relay-client.ts` is dead code: the service worker broadcasts into a
      // channel nobody opened, no tokens stream, and the port's service-worker-lifetime benefit —
      // the entire reason the streaming channel is a port — is never obtained.
      const runtime = fakeRelayRuntime()
      const { handle, channel } = await scene({ runtime })
      expect(handle.relay.connected).toBe(false)

      await channel.worker.sendMessage(
        'copilot:busy',
        { threadId: 't1', busy: true },
        channel.tabId,
      )
      expect(handle.relay.connected).toBe(true)
      expect(runtime.connects).toBe(1)

      await channel.worker.sendMessage(
        'copilot:busy',
        { threadId: 't1', busy: false },
        channel.tabId,
      )
      // A content script on `<all_urls>` holding a port open would keep the worker alive from
      // every tab, forever — the opposite of what MV3's idle timer is for.
      expect(handle.relay.connected).toBe(false)
    })

    it('stays open while any thread is still running', async () => {
      const runtime = fakeRelayRuntime()
      const { handle, channel } = await scene({ runtime })
      await channel.worker.sendMessage('copilot:busy', { threadId: 'a', busy: true }, channel.tabId)
      await channel.worker.sendMessage('copilot:busy', { threadId: 'b', busy: true }, channel.tabId)
      await channel.worker.sendMessage(
        'copilot:busy',
        { threadId: 'a', busy: false },
        channel.tabId,
      )
      expect(handle.relay.connected).toBe(true)
      await channel.worker.sendMessage(
        'copilot:busy',
        { threadId: 'b', busy: false },
        channel.tabId,
      )
      expect(handle.relay.connected).toBe(false)
    })

    it('reconnects after the service worker dies mid-run', async () => {
      // The port dies with the worker; a run that outlives three worker deaths would otherwise
      // stream into nothing, and the reconnect is also what wakes the worker that owns the run.
      const runtime = fakeRelayRuntime()
      const { handle, channel } = await scene({ runtime })
      await channel.worker.sendMessage(
        'copilot:busy',
        { threadId: 't1', busy: true },
        channel.tabId,
      )
      expect(runtime.connects).toBe(1)

      runtime.workerEnds[0]!.disconnect() // the worker was killed
      expect(handle.relay.connected).toBe(false)
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(runtime.connects).toBe(2)
      expect(handle.relay.connected).toBe(true)
    })

    it('drives busy chips from relayed run:queued, not only from the message channel', async () => {
      const runtime = fakeRelayRuntime()
      const { handle, channel } = await scene({ runtime })
      const created = await handle.engine.createThread(threadFixture(handle.engine.pageKey))
      await flush()
      await channel.worker.sendMessage(
        'copilot:busy',
        { threadId: 'other', busy: true },
        channel.tabId,
      )

      const decorate = vi.spyOn(handle.ui, 'decorate')
      runtime.workerEnds[0]!.postMessage({
        type: 'run:queued',
        runId: 'c:1',
        seq: 1,
        instanceId: 'sw',
        at: 1,
        payload: { run: { context: { threadId: created.thread.id } } },
      })
      await flushRelay()
      expect(decorate).toHaveBeenCalledWith(
        created.thread.id,
        expect.objectContaining({ chip: expect.objectContaining({ tone: 'busy' }) }),
      )
    })

    it('never opens a port when the platform gives it no runtime', async () => {
      const { handle } = await scene()
      expect(handle.relay.connected).toBe(false)
      expect(() => handle.relay.want(true)).not.toThrow()
    })
  })

  describe('a mount failure costs the pill and nothing else', () => {
    it('still registers the tool endpoints and the chip handlers', async () => {
      // The overlay mounts through WXT at `document_start`, where `document.body` is null and
      // WXT's default anchor throws. A rejected `mountChrome` used to reject `startContent`
      // before a single listener existed: comments alive, copilot silently absent.
      const storage = createFakeStorage()
      const kv = createStorageKv(storage)
      await kv.set({ [SETTINGS_KEY]: defaultSettings() })
      const channel = createFakeChannel()
      channel.worker.onMessage('copilot:busyThreads', () => [])

      const handle = await startContent({
        kv,
        messenger: channel.page,
        mountChrome: () => Promise.reject(new Error('could not find anchor element')),
      })
      handles.push(handle)

      document.title = 'Still Served'
      const context = (await channel.worker.sendMessage(
        'tool:get_page_context',
        {},
        channel.tabId,
      )) as { title: string }
      expect(context.title).toBe('Still Served')
      // The trigger route survives too — the keyboard half of the product.
      const start = vi.spyOn(handle.engine, 'startPlacement')
      await channel.worker.sendMessage('trigger', { kind: 'ask' }, channel.tabId)
      expect(start).toHaveBeenCalledWith('ask')
      // …and the pill degrades to a no-op rather than throwing on every count update.
      expect(() => handle.chrome.setPendingCount(3)).not.toThrow()
      expect(handle.chrome.pendingCount).toBe(3)
    })
  })

  describe('the failure chip is durable', () => {
    it('is re-derived by refresh, so it survives SPA navigation and reload', async () => {
      const { handle, host } = await scene()
      const created = await handle.engine.createThread(threadFixture(handle.engine.pageKey))
      await flush()
      await host.markFailed(created.thread.id, 'max_attempts')

      const decorate = vi.spyOn(handle.ui, 'decorate')
      await handle.refresh()
      expect(decorate).toHaveBeenCalledWith(
        created.thread.id,
        expect.objectContaining({ chip: { text: 'max_attempts', tone: 'warn' } }),
      )
    })
  })
})

/** A `runtime.connect` that hands back the page end and keeps the worker end to drive. */
function fakeRelayRuntime() {
  const workerEnds: FakePort[] = []
  return {
    workerEnds,
    get connects() {
      return workerEnds.length
    },
    connect: (): FakePort => {
      const { a, b } = createPortPair()
      workerEnds.push(b)
      return a
    },
  }
}
