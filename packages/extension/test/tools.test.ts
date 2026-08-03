/**
 * The SW half of PLAN §5's tool table: the transport that routes by the RUN's page, and the
 * prompt assembly the run input is built from.
 */

import type { ThreadRecord } from '@astrale-os/comment-core'

import { CopilotError } from '@astrale-os/browser-copilot'
import { describe, expect, it, vi } from 'vitest'

import { renderContext, renderReview, renderThread } from '../src/background/render.ts'
import {
  BATCH_MAX_STEPS,
  BATCH_TOOLS,
  buildTools,
  createToolTransport,
  SINGLE_TOOLS,
} from '../src/background/tools.ts'
import { createFakeChannel } from './support/fake-messaging.ts'

const CTX = { threadId: 't1', kind: 'comment', pageKey: 'https://x/y', mode: 'single' as const }

const toolCtx = (over: Partial<{ signal: AbortSignal; context: typeof CTX }> = {}) => ({
  runId: 'c:t1:c1',
  step: 1,
  attempt: 1,
  signal: over.signal ?? new AbortController().signal,
  context: over.context ?? CTX,
})

describe('createToolTransport', () => {
  it('routes by the run s page, not by the focused tab', async () => {
    const channel = createFakeChannel({ tabId: 42 })
    channel.page.onMessage('tool:get_page_context', () => ({ url: 'https://x/y' }))
    const transport = createToolTransport(channel.worker, {
      tabsForPageKey: async (pageKey: string) => (pageKey === 'https://x/y' ? [42] : []),
    })

    const result = await transport.call('get_page_context', {}, toolCtx())
    expect(result).toEqual({ url: 'https://x/y' })
    expect(channel.sent.at(-1)?.tabId).toBe(42)
  })

  it('fails with tool_failed when no tab shows that page', async () => {
    // A real failure the model can react to, rather than `null`, which it cannot distinguish
    // from "the element is gone".
    const channel = createFakeChannel()
    const transport = createToolTransport(channel.worker, { tabsForPageKey: async () => [] })
    await expect(transport.call('get_page_context', {}, toolCtx())).rejects.toSatisfy(
      (error: unknown) => CopilotError.is(error, 'tool_failed'),
    )
  })

  it('rejects immediately when the run was already cancelled', async () => {
    const channel = createFakeChannel({ tabId: 1 })
    channel.page.onMessage('tool:get_page_context', () => ({}))
    const transport = createToolTransport(channel.worker, { tabsForPageKey: async () => [1] })
    const controller = new AbortController()
    controller.abort()
    await expect(
      transport.call('get_page_context', {}, toolCtx({ signal: controller.signal })),
    ).rejects.toSatisfy((error: unknown) => CopilotError.is(error, 'aborted'))
  })

  it('aborts a call in flight — v4 messaging has no per-call signal, so we race it', async () => {
    const channel = createFakeChannel({ tabId: 1 })
    channel.page.onMessage('tool:get_page_context', () => new Promise(() => {})) // never resolves
    const transport = createToolTransport(channel.worker, { tabsForPageKey: async () => [1] })
    const controller = new AbortController()
    const call = transport.call('get_page_context', {}, toolCtx({ signal: controller.signal }))
    controller.abort()
    await expect(call).rejects.toSatisfy((error: unknown) => CopilotError.is(error, 'aborted'))
  })
})

describe('the tool table', () => {
  const domain = {
    get: vi.fn(async (id: string) =>
      id === 'live' ? ({ thread: { id }, comments: [] } as never) : null,
    ),
    list: vi.fn(async () => [] as never),
    appendComment: vi.fn(async () => ({}) as never),
  }
  const build = (onReply?: (threadId: string, runId: string) => void) =>
    buildTools({
      comments: domain as never,
      transport: { call: async () => 'remote' },
      ...(onReply ? { onReply } : {}),
    })

  it('get_thread_element_html falls back to the stored capture, as PLAN §5 promises', async () => {
    // The tool table has always documented the fallback; nothing implemented it. A closed tab
    // or an orphaned element was a `tool_failed` the model had to recover from by knowing to
    // call `read_thread` instead.
    const captured = {
      get: async (id: string) =>
        id === 'live'
          ? ({ thread: { id, capture: { outerHTML: '<p>as captured</p>' } } } as never)
          : null,
      list: async () => [] as never,
      appendComment: async () => ({}) as never,
    }
    const tools = buildTools({
      comments: captured as never,
      transport: {
        call: async () => {
          throw new CopilotError('tool_failed', 'no open tab for https://x/y')
        },
      },
    })
    const tool = tools.find((entry) => entry.name === 'get_thread_element_html')!
    expect(await tool.execute({ threadId: 'live' }, toolCtx() as never)).toEqual({
      source: 'capture',
      html: '<p>as captured</p>',
      note: expect.stringContaining('capture'),
    })
    // A thread that is simply gone says so rather than inventing HTML.
    expect(await tool.execute({ threadId: 'ghost' }, toolCtx() as never)).toEqual({
      source: 'capture',
      html: null,
      note: 'thread not found',
    })
  })

  it('returns the live element, marked as live, when the page answers', async () => {
    const tools = buildTools({
      comments: domain as never,
      transport: { call: async () => '<p>live</p>' },
    })
    const tool = tools.find((entry) => entry.name === 'get_thread_element_html')!
    expect(await tool.execute({ threadId: 'live' }, toolCtx() as never)).toEqual({
      source: 'live',
      html: '<p>live</p>',
    })
  })

  it('propagates a cancellation rather than answering from the capture', async () => {
    // A cancelled run silently succeeding with stale HTML is worse than a failed tool call.
    const tools = buildTools({
      comments: domain as never,
      transport: {
        call: async () => {
          throw new CopilotError('aborted', 'run cancelled before tool call')
        },
      },
    })
    const tool = tools.find((entry) => entry.name === 'get_thread_element_html')!
    await expect(tool.execute({ threadId: 'live' }, toolCtx() as never)).rejects.toSatisfy(
      (error: unknown) => CopilotError.is(error, 'aborted'),
    )
  })

  it('registers exactly the six tools of PLAN §5', () => {
    expect(build().map((tool) => tool.name)).toEqual([
      'get_page_context',
      'get_thread_element_html',
      'show_message',
      'read_thread',
      'list_threads',
      'reply_to_thread',
    ])
  })

  it('offers reply_to_thread to batch runs only — the entire tool-set difference', () => {
    expect(SINGLE_TOOLS).not.toContain('reply_to_thread')
    expect(BATCH_TOOLS).toContain('reply_to_thread')
    // A batch run reads more before it writes, so it gets a bigger step cap.
    expect(BATCH_MAX_STEPS).toBeGreaterThan(8)
  })

  it('every SINGLE_TOOLS / BATCH_TOOLS name is actually registered', () => {
    const names = new Set(build().map((tool) => tool.name))
    for (const name of [...SINGLE_TOOLS, ...BATCH_TOOLS]) expect(names.has(name)).toBe(true)
  })

  it('reply_to_thread refuses a thread outside the batch before touching the store', async () => {
    domain.get.mockClear()
    const reply = build().find((tool) => tool.name === 'reply_to_thread')!
    const result = await reply.execute(
      { threadId: 'outsider', body: 'x' },
      toolCtx({ context: { ...CTX, mode: 'batch', threadIds: ['live'] } as never }) as never,
    )
    expect(result).toBe('thread outsider is not part of this review')
    expect(domain.get).not.toHaveBeenCalled()
  })

  it('reply_to_thread reports a deleted thread rather than failing the run', async () => {
    const reply = build().find((tool) => tool.name === 'reply_to_thread')!
    const result = await reply.execute(
      { threadId: 'gone', body: 'x' },
      toolCtx({ context: { ...CTX, mode: 'batch', threadIds: ['gone'] } as never }) as never,
    )
    expect(result).toBe('thread deleted')
  })

  it('reply_to_thread writes with a per-(run, thread) idempotency key', async () => {
    domain.appendComment.mockClear()
    const onReply = vi.fn()
    const reply = build(onReply).find((tool) => tool.name === 'reply_to_thread')!
    await reply.execute(
      { threadId: 'live', body: 'on it' },
      toolCtx({ context: { ...CTX, mode: 'batch', threadIds: ['live'] } as never }) as never,
    )
    expect(domain.appendComment).toHaveBeenCalledWith('live', {
      author: 'copilot',
      body: 'on it',
      // A restarted batch run replays every reply and must not double-post.
      id: 't:c:t1:c1:live',
    })
    expect(onReply).toHaveBeenCalledWith('live', 'c:t1:c1')
  })
})

/* ------------------------------------------------------------------- prompts */

const record = (
  over: Partial<ThreadRecord['thread']> = {},
  comments: Array<{ author: string; body: string }> = [],
): ThreadRecord =>
  ({
    thread: {
      id: 't1',
      v: 1,
      pageKey: 'https://x/y',
      kind: 'comment',
      status: 'open',
      resolvedAt: null,
      resolvedBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      anchor: {
        mode: 'element',
        selectors: [],
        fingerprint: { tag: 'section', stableClasses: [], attrs: {}, textDigest: '' },
      },
      capture: {
        outerHTML: '<section>hi</section>',
        text: 'the   captured    text',
        cssPath: 'main > section',
        page: { url: 'https://x/y', title: 'A Doc' },
        capturedAt: '2026-01-01T00:00:00.000Z',
      },
      ...over,
    },
    comments: comments.map((comment, index) => ({
      id: `c${index}`,
      threadId: 't1',
      createdAt: '2026-01-01T00:00:00.000Z',
      editedAt: null,
      ...comment,
    })),
  }) as ThreadRecord

describe('renderThread', () => {
  it('labels every comment by author so a follow-up is not answered by itself', () => {
    const text = renderThread(
      record({}, [
        { author: 'user', body: 'why is this red?' },
        { author: 'copilot', body: 'because of the theme' },
        { author: 'user', body: 'can we change it?' },
      ]),
    )
    expect(text).toContain('[user] why is this red?')
    expect(text).toContain('[copilot] because of the theme')
    expect(text.indexOf('[user] why')).toBeLessThan(text.indexOf('[user] can we'))
  })

  it('carries the element, the selector and the collapsed capture text', () => {
    const text = renderThread(record({}, [{ author: 'user', body: 'x' }]))
    expect(text).toContain('element: <section>')
    expect(text).toContain('selector: main > section')
    expect(text).toContain('text: "the captured text"')
  })

  it('truncates a wall of captured text', () => {
    const text = renderThread(
      record({ capture: { ...record().thread.capture, text: 'y'.repeat(5000) } as never }, [
        { author: 'user', body: 'x' },
      ]),
    )
    expect(text.length).toBeLessThan(1500)
    expect(text).toContain('…')
  })

  it('includes the selection when the capture had one', () => {
    const text = renderThread(
      record({ capture: { ...record().thread.capture, selectionText: 'just this bit' } as never }, [
        { author: 'user', body: 'x' },
      ]),
    )
    expect(text).toContain('selection: "just this bit"')
  })
})

describe('renderReview', () => {
  it('states every thread id verbatim — it is the argument reply_to_thread takes', () => {
    const text = renderReview(
      [
        record({ id: 'alpha' }, [{ author: 'user', body: 'first' }]),
        record({ id: 'beta' }, [{ author: 'user', body: 'second' }]),
      ],
      'https://x/y',
    )
    expect(text).toContain('id: alpha')
    expect(text).toContain('id: beta')
    expect(text).toContain('reply_to_thread')
    expect(text).toContain('thread 1/2')
  })

  it('pluralises the header honestly', () => {
    expect(renderReview([record({}, [{ author: 'user', body: 'x' }])], 'p')).toContain(
      '1 thread on p',
    )
  })
})

describe('renderContext', () => {
  it('stays one line — the substance is already in the input', () => {
    const text = renderContext({ ...CTX, mode: 'batch' })
    expect(text.split('\n')).toHaveLength(1)
    expect(text).toBe('thread=t1 kind=comment page=https://x/y mode=batch')
  })
})
