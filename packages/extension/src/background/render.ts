/**
 * Prompt input assembly (SPEC-copilot §3.5: `TriggerInput.input` is the user message).
 *
 * Stateless per run by design — a submit and a follow-up share one code path, and a restarted
 * run rebuilds the same text from the same records. Nothing here is persisted.
 */

import type { ThreadRecord } from '@astrale-os/comment-core/headless'

/** Keep a capture excerpt from swallowing the prompt when a page dumps a wall of text. */
const CAPTURE_LIMIT = 600

function trim(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`
}

function captureLines(record: ThreadRecord): string[] {
  const { capture, anchor } = record.thread
  const lines = [`element: <${anchor.fingerprint.tag}>`, `page: ${capture.page.title}`]
  if (capture.cssPath) lines.push(`selector: ${capture.cssPath}`)
  if (capture.selectionText) {
    lines.push(`selection: "${trim(capture.selectionText, CAPTURE_LIMIT)}"`)
  }
  if (capture.text) lines.push(`text: "${trim(capture.text, CAPTURE_LIMIT)}"`)
  return lines
}

/**
 * One thread as the run input. Comments are labelled by author because the model's own prior
 * replies are in here — without the labels a follow-up reads as one undifferentiated wall and
 * the copilot answers its own last message.
 */
export function renderThread(record: ThreadRecord): string {
  const lines: string[] = [
    `Thread ${record.thread.id} (kind: ${record.thread.kind}, status: ${record.thread.status})`,
    `page: ${record.thread.pageKey}`,
    ...captureLines(record),
    '',
    'Conversation, oldest first:',
  ]
  for (const comment of record.comments) {
    lines.push(`[${comment.author}] ${comment.body}`)
  }
  lines.push('', 'Write the next reply.')
  return lines.join('\n')
}

/**
 * PLAN §5: one batch run with every pending thread in context — strictly better than N isolated
 * runs, because the copilot sees the whole review at once and can connect related comments.
 * Thread ids are stated verbatim: they are the argument `reply_to_thread` takes.
 */
export function renderReview(records: readonly ThreadRecord[], pageKey: string): string {
  const lines: string[] = [
    `Review of ${records.length} thread${records.length === 1 ? '' : 's'} on ${pageKey}.`,
    '',
  ]
  records.forEach((record, index) => {
    lines.push(`--- thread ${index + 1}/${records.length} — id: ${record.thread.id} ---`)
    lines.push(...captureLines(record))
    for (const comment of record.comments) lines.push(`[${comment.author}] ${comment.body}`)
    lines.push('')
  })
  lines.push(
    'Reply to the threads that warrant a reply by calling reply_to_thread with the id above.',
    'Then write a short overall summary as your final message.',
  )
  return lines.join('\n')
}

/**
 * `CopilotOptions.renderContext` — how the opaque trigger context reaches the prompt. Kept to
 * one line: the context is routing metadata, and the substance is already in `input`.
 */
export function renderContext(context: {
  threadId: string
  kind: string
  pageKey: string
  mode: string
}): string {
  return `thread=${context.threadId} kind=${context.kind} page=${context.pageKey} mode=${context.mode}`
}
