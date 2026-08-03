/**
 * The content-script tool half — `serveTools`, the other end of `remoteTool` (SPEC-copilot §6).
 *
 * This is the **single normative content-script tool half**: hand-rolling `onMessage('tool:…')`
 * handlers alongside it would collide on the same message keys and skip the arrival-side schema
 * validation §3.4 requires on both ends. `handle` also builds the `AbortSignal` and enforces
 * `timeoutMs` on this side, so a wedged page cannot hang a run that the SW cannot reach.
 */

import type { CommentEngine } from '@astrale-os/comment-core'

import { defineTool, serveTools } from '@astrale-os/browser-copilot'
import { z } from 'zod'

/** Cap the outline so a documentation site with 400 headings does not become the prompt. */
const MAX_HEADINGS = 60
/** Cap live HTML the same way the capture is capped: a `<main>` can be megabytes. */
const HTML_LIMIT = 8192

export interface PageContext {
  url: string
  title: string
  headings: Array<{ level: number; text: string }>
  selection: string | null
}

export interface ContentToolDeps {
  engine: Pick<CommentEngine, 'getThreadView'>
  document: Document
  /** Renders `show_message`. The host chrome's toast in the extension. */
  toast(text: string): void
  /** Test seam for `window.getSelection()`. */
  getSelection?: () => string | null
}

export function buildContentTools(deps: ContentToolDeps) {
  const { engine, document: doc, toast } = deps
  const readSelection =
    deps.getSelection ??
    (() => {
      const view = doc.defaultView
      const text = view?.getSelection?.()?.toString() ?? ''
      return text.length > 0 ? text : null
    })

  return [
    defineTool({
      name: 'get_page_context',
      description: 'URL, title, heading outline and current selection of the live page.',
      inputSchema: z.object({}),
      execute: (): PageContext => ({
        url: doc.defaultView?.location.href ?? doc.URL,
        title: doc.title,
        headings: [...doc.querySelectorAll('h1, h2, h3')]
          .slice(0, MAX_HEADINGS)
          .map((heading) => ({
            level: Number(heading.tagName.slice(1)),
            text: (heading.textContent ?? '').replace(/\s+/g, ' ').trim(),
          }))
          .filter((heading) => heading.text.length > 0),
        selection: readSelection(),
      }),
    }),
    defineTool({
      name: 'get_thread_element_html',
      description: 'Live outerHTML of the element a thread is anchored to, or null if orphaned.',
      inputSchema: z.object({ threadId: z.string() }),
      execute: ({ threadId }): string | null => {
        const view = engine.getThreadView(threadId)
        // → tool_failed, fed back to the model, which can then read the stored capture instead.
        if (!view) throw new Error(`unknown thread ${threadId}`)
        const html = view.anchoring.element?.outerHTML
        // `null` means "orphaned", precisely — a value the model can act on, unlike a throw.
        if (html === undefined) return null
        return html.length <= HTML_LIMIT ? html : `${html.slice(0, HTML_LIMIT)}…`
      },
    }),
    defineTool({
      name: 'show_message',
      description: 'Show a short message to the user on the page.',
      inputSchema: z.object({ text: z.string() }),
      execute: ({ text }): string => {
        toast(text)
        return 'shown'
      },
    }),
  ] as const
}

export function createToolServer(deps: ContentToolDeps) {
  return serveTools(buildContentTools(deps))
}

export type ToolServer = ReturnType<typeof createToolServer>
