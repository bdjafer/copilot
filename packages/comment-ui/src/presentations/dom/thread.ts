/**
 * The thread popover: comments, reply, resolve/reopen, delete, edit.
 *
 * Every mutation leaves through an intent, and every one of them returns `void` and never
 * throws — there is not a single `catch` in this file, and there is nothing here that could
 * float a promise. The delete focus dance in particular is deliberately **not** attempted here:
 * it is policy, so the controller performs it (§3.1.3).
 *
 * The capture quote is shown for an orphaned thread (PLAN §3.4's "original content deleted"
 * pattern) so a reply to a permanently-gone element is still readable; it arrives pre-truncated.
 */

import type { CommentVM, Intents, Labels, PresentationHost, ThreadVM } from '../../presentation.ts'

import {
  el,
  hideFloating,
  reconcile,
  safeFocus,
  setAttr,
  setText,
  showFloating,
} from '../../dom.ts'
import { createChipSlot, renderChip, renderMarks } from './chip.ts'

export interface ThreadPopover {
  readonly element: HTMLElement
  readonly close: HTMLElement
  render(thread: ThreadVM | null, labels: Labels): void
  destroy(): void
}

export function createThreadPopover(host: PresentationHost, intents: Intents): ThreadPopover {
  const { doc } = host
  const title = el(doc, 'span', { class: 'cc-head-title' })
  const marks = el(doc, 'span', { class: 'cc-badge-marks', 'aria-hidden': 'true' })
  const chipSlot = createChipSlot(doc, true)
  const close = el(
    doc,
    'button',
    { type: 'button', class: 'cc-btn', 'data-variant': 'icon', 'data-action': 'close' },
    ['✕'],
  )
  const head = el(doc, 'div', { class: 'cc-head' }, [title, marks, chipSlot, close])
  const quote = el(doc, 'p', { class: 'cc-quote', hidden: true })
  const list = el(doc, 'ul', { class: 'cc-comments' })

  const reply = el(doc, 'button', { type: 'button', class: 'cc-btn', 'data-action': 'reply' })
  // `data-action` flips between resolve/reopen, so the stable hook for a test (or a host's CSS)
  // is `data-role`.
  const resolve = el(doc, 'button', {
    type: 'button',
    class: 'cc-btn',
    'data-role': 'status',
    'data-action': 'resolve',
  })
  const remove = el(doc, 'button', {
    type: 'button',
    class: 'cc-btn',
    'data-variant': 'danger',
    'data-action': 'delete',
  })
  const actions = el(doc, 'div', { class: 'cc-thread-actions' }, [reply, resolve, remove])

  const element = el(
    doc,
    'div',
    { class: 'cc-thread cc-float', popover: 'manual', role: 'dialog', 'data-open': 'false' },
    [head, quote, list, actions],
  )
  host.layer.append(element)
  host.anchor('thread', element)

  let openId: string | null = null
  let current: ThreadVM | null = null
  let labels: Labels | null = null

  close.addEventListener('click', () => {
    intents.closeThread()
  })
  reply.addEventListener('click', () => {
    if (openId) intents.startReply(openId)
  })
  resolve.addEventListener('click', () => {
    if (!openId || !current) return
    if (current.actions.reopen) intents.reopenThread(openId)
    else intents.resolveThread(openId)
  })
  remove.addEventListener('click', () => {
    if (openId) intents.deleteThread(openId)
  })
  element.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    if (intents.escape()) event.preventDefault()
  })

  function renderComment(node: HTMLElement, comment: CommentVM): void {
    const author = node.querySelector<HTMLElement>('.cc-author')
    const time = node.querySelector<HTMLElement>('.cc-time')
    const body = node.querySelector<HTMLElement>('.cc-body')
    const edit = node.querySelector<HTMLButtonElement>('[data-action="edit"]')
    if (!author || !time || !body || !edit || !labels) return

    setAttr(author, 'data-author', comment.author)
    setText(author, comment.author)
    // No prose: the timestamp is a machine value, so it needs no `Labels` key to be i18n-clean.
    setAttr(time, 'datetime', comment.createdAt)
    setAttr(time, 'title', comment.editedAt ?? comment.createdAt)
    setAttr(node, 'data-edited', comment.editedAt ? 'true' : null)
    setAttr(node, 'data-comment', comment.id)
    setAttr(edit, 'aria-label', labels.edit)
    setText(edit, labels.edit)

    setAttr(body, 'hidden', comment.editing)
    setAttr(edit, 'hidden', comment.editing)
    if (!comment.editing) {
      setText(body, comment.body)
      node.querySelector('.cc-edit')?.remove()
      return
    }
    if (node.querySelector('.cc-edit')) return

    const threadId = openId
    const input = el(doc, 'textarea', {
      class: 'cc-composer-input',
      rows: 2,
      'aria-label': labels.edit,
    })
    input.value = comment.body
    const save = el(
      doc,
      'button',
      { type: 'button', class: 'cc-btn', 'data-variant': 'primary', 'data-action': 'save' },
      [labels.send],
    )
    const cancel = el(
      doc,
      'button',
      { type: 'button', class: 'cc-btn', 'data-action': 'cancel-edit' },
      [labels.dismiss],
    )
    save.addEventListener('click', () => {
      if (threadId) intents.commitEdit(threadId, comment.id, input.value)
    })
    cancel.addEventListener('click', () => {
      intents.cancelEdit()
    })
    node.append(
      el(doc, 'div', { class: 'cc-edit' }, [
        input,
        el(doc, 'div', { class: 'cc-row-actions' }, [cancel, save]),
      ]),
    )
    // The inline editor is a node this layer created this pass, so focusing it needs no
    // `vm.focus` round trip — the four `FocusTarget`s are the ones policy has an opinion about.
    safeFocus(input)
  }

  function createComment(): HTMLElement {
    const author = el(doc, 'span', { class: 'cc-author' })
    const time = el(doc, 'time', { class: 'cc-time' })
    const edit = el(doc, 'button', {
      type: 'button',
      class: 'cc-btn',
      'data-variant': 'icon',
      'data-action': 'edit',
    })
    const node = el(doc, 'li', { class: 'cc-comment' }, [
      el(doc, 'div', { class: 'cc-comment-head' }, [author, time, edit]),
      el(doc, 'div', { class: 'cc-body' }),
    ])
    edit.addEventListener('click', () => {
      const commentId = node.getAttribute('data-comment')
      if (openId && commentId) intents.beginEdit(openId, commentId)
    })
    return node
  }

  return {
    element,
    close,

    render(thread, next) {
      labels = next
      setAttr(close, 'aria-label', next.dismiss)
      setText(reply, next.reply)
      if (!thread) {
        if (openId === null) return
        openId = null
        current = null
        hideFloating(element)
        return
      }

      if (openId !== thread.threadId) {
        openId = thread.threadId
        showFloating(element)
      }
      current = thread

      setAttr(element, 'aria-label', thread.ariaLabel)
      setAttr(element, 'data-thread', thread.threadId)
      setAttr(element, 'data-status', thread.status)
      setAttr(element, 'data-anchor', thread.anchor)
      setAttr(element, 'title', thread.title)
      setText(title, thread.label)
      renderMarks(doc, marks, thread)
      renderChip(doc, chipSlot, thread.chip)

      setAttr(quote, 'hidden', thread.quote === null)
      if (thread.quote !== null) setText(quote, thread.quote)

      reconcile(
        list,
        thread.comments,
        (comment) => comment.id,
        () => createComment(),
        (node, comment) => {
          renderComment(node as HTMLElement, comment)
        },
      )

      setText(resolve, thread.actions.reopen ? next.reopen : next.resolve)
      setAttr(resolve, 'data-action', thread.actions.reopen ? 'reopen' : 'resolve')
      setText(remove, next.delete)
      setAttr(reply, 'hidden', !thread.actions.reply)
      setAttr(remove, 'hidden', !thread.actions.delete)
    },

    destroy() {
      host.anchor('thread', null)
      element.remove()
    },
  }
}
