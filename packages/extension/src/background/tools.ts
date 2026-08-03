/**
 * PLAN §5's tool table, wired to the two runtimes it spans (SPEC-copilot §6).
 *
 * | Tool                        | Runs in        |
 * |-----------------------------|----------------|
 * | `get_page_context`          | content script |
 * | `get_thread_element_html`   | content script, **falling back in the SW to the stored capture** |
 * | `show_message`              | content script |
 * | `list_threads` / `read_thread` | SW (`CommentDomain`) — works with the tab closed |
 * | `reply_to_thread`           | SW, **batch runs only** |
 *
 * Replying is not a tool for a *single* run: the `run:done` output is the reply. It is a tool
 * for a batch run, because one run's output cannot be N threads' replies.
 */

import type { ToolTransport } from '@astrale-os/browser-copilot'
import type { CommentDomain } from '@astrale-os/comment-core/headless'

import { CopilotError, toolsFor } from '@astrale-os/browser-copilot'
import { z } from 'zod'

import type { BridgeMessenger } from '../messaging.ts'

import { toolMessageKey } from '../messaging.ts'

/** The opaque payload every tool and the prompt renderer receives. */
export interface RunCtx {
  threadId: string
  kind: string
  pageKey: string
  mode: 'single' | 'batch'
  /** Batch runs only: every thread this run may reply to. */
  threadIds?: string[]
}

const { defineTool, remoteTool } = toolsFor<RunCtx>()

/**
 * The tool subset a *single* run gets. `reply_to_thread` is excluded here and only here —
 * a single run's reply is its `run:done` output, and offering both would let one run post the
 * same text twice. Snapshotted into `run.spec.tools`, so a restart in a fresh worker keeps the
 * subset even though the worker that chose it is gone.
 */
export const SINGLE_TOOLS = [
  'get_page_context',
  'get_thread_element_html',
  'show_message',
  'read_thread',
  'list_threads',
] as const

/** PLAN §5: `reply_to_thread` is registered batch-only. That is the entire tool-set difference. */
export const BATCH_TOOLS = [
  'read_thread',
  'list_threads',
  'get_page_context',
  'reply_to_thread',
] as const

export const BATCH_MAX_STEPS = 12

export interface TabRouter {
  /**
   * Every tab currently showing this page key — plural, because the same document can be open in
   * two tabs and a notification that reaches only one of them is a bug in the other.
   *
   * This is the bridge's **only** tab lookup on purpose. A `sendMessage` from the worker with no
   * tab target silently goes nowhere (see `src/messaging.ts`); making the plural form the one
   * available primitive is what stops that from being re-introduced.
   */
  tabsForPageKey(pageKey: string): Promise<number[]>
}

/**
 * Routes by the RUN's page, not by whatever tab happens to be focused: a background run outlives
 * tab focus and tab existence. No tab ⇒ a real tool failure the model can react to, rather than
 * `null`, which it cannot distinguish from "the element is gone".
 *
 * `@webext-core/messaging` v4 has no per-call `signal` (the third argument is the tab target),
 * so the abort is raced here. Without it a cancelled run would keep an open port to a page that
 * may never answer, and `serveTools` only enforces its timeout on the far end — which is exactly
 * the end that is unreachable when the tab is wedged.
 */
export function createToolTransport(
  messenger: BridgeMessenger,
  router: TabRouter,
): ToolTransport<RunCtx> {
  return {
    async call(name, input, { signal, context }) {
      // First tab wins: a tool answers about *the* page, and two tabs on the same URL are the
      // same document as far as the anchor is concerned.
      const tabId = (await router.tabsForPageKey(context.pageKey))[0]
      if (tabId === undefined) {
        throw new CopilotError('tool_failed', `no open tab for ${context.pageKey}`, {
          toolName: name,
        })
      }
      const send = messenger.sendMessage(toolMessageKey(name), input, tabId)
      if (signal.aborted) throw new CopilotError('aborted', 'run cancelled before tool call')
      return Promise.race([
        send,
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new CopilotError('aborted', `tool ${name} aborted`, { toolName: name })),
            { once: true },
          )
        }),
      ])
    },
  }
}

/** What `get_thread_element_html` answers with. `source` is the part the model must read. */
export interface ThreadElementHtml {
  source: 'live' | 'capture'
  html: string | null
  note?: string
}

export interface BuildToolsOptions {
  comments: CommentDomain
  transport: ToolTransport<RunCtx>
  /** Called after a successful `reply_to_thread` write, so the page can drop the busy chip. */
  onReply?: (threadId: string, runId: string) => void
}

export function buildTools(options: BuildToolsOptions) {
  const { comments, transport, onReply } = options

  return [
    remoteTool(
      {
        name: 'get_page_context',
        description: 'URL, title, heading outline and current selection of the live page.',
        inputSchema: z.object({}),
      },
      transport,
    ),
    defineTool({
      name: 'get_thread_element_html',
      description:
        'HTML of the element a thread is anchored to. Returns { source, html }: source ' +
        '"live" is the element as it is on the page right now; source "capture" is the ' +
        'snapshot taken when the thread was created, returned when the element is gone (the ' +
        'thread is orphaned) or no tab has that page open. Never guess which one you got — ' +
        'read `source`.',
      inputSchema: z.object({ threadId: z.string() }),
      execute: async ({ threadId }, ctx): Promise<ThreadElementHtml> => {
        // PLAN §5's tool table promises this fallback. Doing it here rather than telling the
        // model to "call read_thread instead" is what makes a closed tab a degraded answer
        // instead of a tool failure the model has to recover from.
        let live: unknown = null
        try {
          live = await transport.call(
            'get_thread_element_html',
            { threadId },
            {
              runId: ctx.runId,
              step: ctx.step,
              attempt: ctx.attempt,
              signal: ctx.signal,
              context: ctx.context,
            },
          )
        } catch (error) {
          // A cancelled run is not a page that failed to answer: propagate it untouched, or a
          // cancel would silently turn into a successful capture read.
          if (CopilotError.is(error, 'aborted')) throw error
          live = null
        }
        if (typeof live === 'string') return { source: 'live', html: live }

        const record = await comments.get(threadId)
        if (!record) return { source: 'capture', html: null, note: 'thread not found' }
        return {
          source: 'capture',
          html: record.thread.capture.outerHTML,
          note: 'the live element is gone or the page is not open; this is the capture taken when the thread was created',
        }
      },
    }),
    remoteTool(
      {
        name: 'show_message',
        description: 'Show a short message to the user on the page.',
        inputSchema: z.object({ text: z.string() }),
      },
      transport,
    ),
    defineTool({
      name: 'read_thread',
      description: 'Full thread with every comment. Works even when the tab is closed.',
      inputSchema: z.object({ threadId: z.string() }),
      execute: ({ threadId }) => comments.get(threadId),
    }),
    defineTool({
      name: 'list_threads',
      description: 'Threads on a page, optionally filtered by kind.',
      inputSchema: z.object({ pageKey: z.string(), kind: z.string().optional() }),
      execute: (filter) => comments.list(filter),
    }),
    defineTool({
      name: 'reply_to_thread',
      description: 'Post a reply into one thread of the current review batch.',
      inputSchema: z.object({ threadId: z.string(), body: z.string() }),
      execute: async ({ threadId, body }, ctx) => {
        // The model picks the id out of the rendered review; nothing stops it from naming a
        // thread that is not in this batch. Scoping the write is the only guard that survives
        // a hallucinated id — a domain-level check would happily write to any live thread.
        const allowed = ctx.context.threadIds
        if (allowed && !allowed.includes(threadId)) {
          return `thread ${threadId} is not part of this review`
        }
        if (!(await comments.get(threadId))) return 'thread deleted'
        // Idempotency key: a restarted batch run replays every reply and must not double-post.
        await comments.appendComment(threadId, {
          author: 'copilot',
          body,
          id: `t:${ctx.runId}:${threadId}`,
        })
        onReply?.(threadId, ctx.runId)
        return 'posted'
      },
    }),
  ] as const
}

export type BridgeTools = ReturnType<typeof buildTools>
