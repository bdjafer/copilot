/**
 * The thread popover (§5.2 `thread.ts`): comments, reply, resolve/reopen, delete, edit.
 *
 * Every mutation goes through a `CommentEngine` method — `appendComment` is reached through
 * `placement.start(kind, { threadId })` so a reply uses the same composer, the same draft state
 * machine and the same `placement:*` events as a fresh thread (decision log #21). The popover
 * itself renders `engine.threads` and holds no copy of it.
 *
 * The capture is shown for an orphaned thread (`ElementCapture.text`, PLAN §3.4's
 * "original content deleted" pattern) so a copilot reply to a permanently-gone element is
 * still readable.
 */

import type { Comment, ThreadView } from '@astrale-os/comment-core'
import type { ReferenceElement } from '@floating-ui/dom'

import type { UIContext } from './context.ts'
import type { Tracker } from './position.ts'

import { createChipSlot, renderChip } from './chip.ts'
import { isApproximate, threadLabel } from './context.ts'
import { el, hideFloating, reconcile, safeFocus, setAttr, setText, showFloating } from './dom.ts'
import { centerReference, dockedReference, track } from './position.ts'

export interface ThreadPopover {
  readonly element: HTMLElement
  render(views: readonly ThreadView[]): void
  isOpen(): boolean
  destroy(): void
}

export function createThreadPopover(ctx: UIContext): ThreadPopover {
  const title = el(ctx.doc, 'span', { class: 'cc-head-title' })
  const marks = el(ctx.doc, 'span', { class: 'cc-badge-marks', 'aria-hidden': 'true' })
  const chipSlot = createChipSlot(ctx, true)
  const close = el(
    ctx.doc,
    'button',
    {
      type: 'button',
      class: 'cc-btn',
      'data-variant': 'icon',
      'data-action': 'close',
      'aria-label': ctx.labels.dismiss,
    },
    ['✕'],
  )
  const head = el(ctx.doc, 'div', { class: 'cc-head' }, [title, marks, chipSlot, close])
  const quote = el(ctx.doc, 'p', { class: 'cc-quote', hidden: true })
  const list = el(ctx.doc, 'ul', { class: 'cc-comments' })

  const reply = el(ctx.doc, 'button', { type: 'button', class: 'cc-btn', 'data-action': 'reply' }, [
    ctx.labels.reply,
  ])
  // `data-action` flips between resolve/reopen, so the stable hook for a test (or a host's
  // CSS) is `data-role`.
  const resolve = el(
    ctx.doc,
    'button',
    { type: 'button', class: 'cc-btn', 'data-role': 'status', 'data-action': 'resolve' },
    [ctx.labels.resolve],
  )
  const remove = el(
    ctx.doc,
    'button',
    { type: 'button', class: 'cc-btn', 'data-variant': 'danger', 'data-action': 'delete' },
    [ctx.labels.delete],
  )
  const actions = el(ctx.doc, 'div', { class: 'cc-thread-actions' }, [reply, resolve, remove])

  const element = el(
    ctx.doc,
    'div',
    {
      class: 'cc-thread cc-float',
      popover: 'manual',
      role: 'dialog',
      'data-open': 'false',
    },
    [head, quote, list, actions],
  )
  ctx.layer.append(element)

  let tracker: Tracker | null = null
  let refToken: unknown = null
  let openId: string | null = null
  /** Comment id currently being edited inline, if any. */
  let editing: string | null = null

  close.addEventListener('click', () => {
    ctx.closeThread()
  })
  reply.addEventListener('click', () => {
    const id = openId
    if (!id) return
    const view = ctx.viewOf(id)
    if (!view) return
    ctx.engine.placement.start(view.kind, { threadId: id })
  })
  resolve.addEventListener('click', () => {
    const id = openId
    if (!id) return
    const view = ctx.viewOf(id)
    if (!view) return
    const run = view.isResolved ? ctx.engine.reopen(id) : ctx.engine.resolve(id)
    run.catch(ctx.onError)
  })
  remove.addEventListener('click', () => {
    const id = openId
    if (!id) return
    // Deleting is the one popover action whose focus cannot go back to the badge: that badge is
    // removed with the thread a tick later and focus would land on `<body>`, dropping the
    // keyboard user out of the widget. The target is chosen before the write and applied after
    // it lands, so it is never a node the delete is about to detach.
    const fallback = ctx.focusFallback()
    ctx.closeThread({ restoreFocus: false })
    void ctx.engine
      .delete(id)
      .catch(ctx.onError)
      .finally(() => {
        if (fallback?.isConnected) safeFocus(fallback)
      })
  })
  element.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    ctx.closeThread()
  })

  function renderComment(node: HTMLElement, comment: Comment, view: ThreadView): void {
    const author = node.querySelector<HTMLElement>('.cc-author')
    const time = node.querySelector<HTMLElement>('.cc-time')
    const body = node.querySelector<HTMLElement>('.cc-body')
    const edit = node.querySelector<HTMLButtonElement>('[data-action="edit"]')
    if (!author || !time || !body || !edit) return

    setAttr(author, 'data-author', comment.author)
    setText(author, comment.author)
    // No prose: the timestamp is a machine value, so it needs no `Labels` key to be i18n-clean.
    setAttr(time, 'datetime', comment.createdAt)
    setAttr(time, 'title', comment.editedAt ?? comment.createdAt)
    setAttr(node, 'data-edited', comment.editedAt ? 'true' : null)
    setAttr(node, 'data-comment', comment.id)

    const isEditing = editing === comment.id
    setAttr(body, 'hidden', isEditing)
    setAttr(edit, 'hidden', isEditing)
    if (!isEditing) {
      setText(body, comment.body)
      node.querySelector('.cc-edit')?.remove()
      return
    }
    if (node.querySelector('.cc-edit')) return

    const input = el(ctx.doc, 'textarea', {
      class: 'cc-composer-input',
      rows: 2,
      'aria-label': ctx.labels.edit,
    })
    input.value = comment.body
    const save = el(
      ctx.doc,
      'button',
      { type: 'button', class: 'cc-btn', 'data-variant': 'primary', 'data-action': 'save' },
      [ctx.labels.send],
    )
    const cancel = el(
      ctx.doc,
      'button',
      { type: 'button', class: 'cc-btn', 'data-action': 'cancel-edit' },
      [ctx.labels.dismiss],
    )
    save.addEventListener('click', () => {
      const next = input.value
      editing = null
      if (next.trim() === '' || next === comment.body) {
        ctx.requestRender()
        return
      }
      ctx.engine
        .editComment({ threadId: view.id, id: comment.id }, next)
        .catch(ctx.onError)
        .finally(() => {
          ctx.requestRender()
        })
    })
    cancel.addEventListener('click', () => {
      editing = null
      ctx.requestRender()
    })
    const box = el(ctx.doc, 'div', { class: 'cc-edit' }, [
      input,
      el(ctx.doc, 'div', { class: 'cc-row-actions' }, [cancel, save]),
    ])
    node.append(box)
    safeFocus(input)
  }

  function createComment(comment: Comment): HTMLElement {
    const author = el(ctx.doc, 'span', { class: 'cc-author' })
    const time = el(ctx.doc, 'time', { class: 'cc-time' })
    const edit = el(
      ctx.doc,
      'button',
      {
        type: 'button',
        class: 'cc-btn',
        'data-variant': 'icon',
        'data-action': 'edit',
        'aria-label': ctx.labels.edit,
      },
      [ctx.labels.edit],
    )
    edit.addEventListener('click', () => {
      editing = comment.id
      ctx.requestRender()
    })
    const body = el(ctx.doc, 'div', { class: 'cc-body' })
    return el(ctx.doc, 'li', { class: 'cc-comment' }, [
      el(ctx.doc, 'div', { class: 'cc-comment-head' }, [author, time, edit]),
      body,
    ])
  }

  function referenceFor(view: ThreadView): ReferenceElement {
    const badge = ctx.badgeFor(view.id)
    if (badge) return badge
    if (view.anchoring.element) return view.anchoring.element
    if (view.anchoring.rect) return dockedReference(view.anchoring.rect, ctx.win)
    return centerReference(ctx.win)
  }

  function retrack(view: ThreadView): void {
    const token: unknown = ctx.badgeFor(view.id) ?? view.anchoring.element ?? view.id
    if (token === refToken && tracker) return
    refToken = token
    tracker?.destroy()
    tracker = track(referenceFor(view), element, {
      placement: 'bottom-end',
      offset: [0, 8],
      onError: ctx.onError,
    })
  }

  function hide(): void {
    if (openId === null) return
    openId = null
    editing = null
    refToken = null
    tracker?.destroy()
    tracker = null
    hideFloating(element)
  }

  return {
    element,

    render(views) {
      const id = ctx.activeThread()
      const view = id ? (views.find((candidate) => candidate.id === id) ?? null) : null
      // A pending thread renders nothing anywhere (§3), popover included.
      if (!view || view.anchoring.status === 'pending') {
        hide()
        return
      }

      const opening = openId !== view.id
      if (opening) {
        openId = view.id
        editing = null
        showFloating(element)
      }

      setAttr(element, 'aria-label', threadLabel(ctx, view))
      setAttr(element, 'data-thread', view.id)
      setAttr(element, 'data-status', view.status)
      setAttr(element, 'data-anchor', view.anchoring.status)
      setText(title, ctx.modeLabel(view.kind))

      const approximate = isApproximate(view)
      const glyphs = [
        view.isResolved ? 'resolved' : null,
        view.isOrphaned ? 'orphaned' : null,
        approximate ? 'approximate' : null,
      ].filter((mark): mark is string => mark !== null)
      if (marks.getAttribute('data-marks') !== glyphs.join(',')) {
        marks.setAttribute('data-marks', glyphs.join(','))
        marks.replaceChildren(
          ...glyphs.map((mark) => el(ctx.doc, 'span', { class: 'cc-mark', 'data-mark': mark })),
        )
      }
      setAttr(element, 'title', approximate ? ctx.labels.approximate : null)
      renderChip(ctx, chipSlot, ctx.decorationOf(view.id))

      const captured = view.isOrphaned ? view.capture.text.slice(0, 160) : ''
      setAttr(quote, 'hidden', captured === '')
      if (captured !== '') setText(quote, captured)

      reconcile(
        list,
        view.comments,
        (comment) => comment.id,
        (comment) => createComment(comment),
        (node, comment) => {
          renderComment(node as HTMLElement, comment, view)
        },
      )

      setText(resolve, view.isResolved ? ctx.labels.reopen : ctx.labels.resolve)
      setAttr(resolve, 'data-action', view.isResolved ? 'reopen' : 'resolve')

      retrack(view)
      if (opening) safeFocus(close)
    },

    isOpen: () => openId !== null,

    destroy() {
      hide()
      element.remove()
    },
  }
}
