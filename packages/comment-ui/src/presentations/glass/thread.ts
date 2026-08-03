/**
 * The thread popover — DESIGN §0 D1/D2/D3/D4/D6, §7 rows 10–15 and 29, §8.4.
 *
 * **No head, no title bar, no logo row, no drag handle, no chrome of any kind (§0 D6).** The first
 * comment's top edge is 10 px below the popover's and *nothing* is above it. Close and the
 * thread's single resolve float as one absolutely positioned corner cluster over a 56 px gutter
 * reserved on the first comment's inline-end, so no text ever runs under them — α .55 → 1 on
 * hover/focus, but **always drawn** while the thread is open, because an affordance on a surface
 * the user has already opened is never hidden (§0 P0).
 *
 * **Metadata is permanent (§0 D2).** Author and relative time are the first thing in every comment
 * row, unconditionally: never `opacity: 0`, never `display: none`, no hover gate, no proximity
 * gate, no 3 px dot. Hover *adds* a native `title` with the absolute datetime — additive only.
 * The pencil is the thing that hides instead (§0 D3): one right-aligned actions cluster per row,
 * `opacity: 0` until the row is hovered or focused, always **mounted** so keyboard and AT reach
 * it, and swapping `position: absolute → relative` with the opacity is what stops the row from
 * reflowing.
 *
 * **Reply is inline, at the bottom (§0 D4).** A permanently rendered, collapsed one-line field
 * sits at the thread's bottom edge whenever `actions.reply`; focusing it expands the composer *in
 * place*, as a child of this surface — never a side panel, never a second floating box, never a
 * popover on a popover. The presentation registers `host.anchor('composer', null)` while it is
 * docked, so the controller positions nothing for it (SPEC #47).
 *
 * Two rules here exist because this runs on someone else's page: `overscroll-behavior: contain` on
 * the comment list, or a scrolled-out thread scrolls *their* article; and the scroll affordance is
 * a mask, not a scrollbar, because a mask cannot be styled away by an inherited rule.
 */

import type { CommentVM, Intents, Labels, PresentationHost, ThreadVM } from '../../presentation.ts'
import type { HueOf } from './kind.ts'

import {
  el,
  hideFloating,
  reconcile,
  safeFocus,
  setAttr,
  setText,
  showFloating,
} from '../../dom.ts'
import { createArm } from './arm.ts'
import { createChip, createChipSlot, type ChipSlot } from './chip.ts'
import { icon, setIcon } from './icons.ts'
import { applyHue } from './kind.ts'
import { transferOrigin, type Rectish } from './motion.ts'

/** §6.2: 22 ms per item, capped at six; the remainder enters together. */
const STAGGER_CAP = 6

export interface ThreadPopover {
  readonly element: HTMLElement
  readonly close: HTMLElement
  /** Where a reply composer docks (§0 D4). The composer is a child of this surface. */
  readonly replySlot: HTMLElement
  render(thread: ThreadVM | null, labels: Labels, origin: Rectish | null, hueOf: HueOf): void
  /** Hide the collapsed rest field while the expanded composer occupies its place. */
  setReplying(replying: boolean): void
  destroy(): void
}

function relative(doc: Document, iso: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const seconds = Math.round((at - Date.now()) / 1000)
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ]
  let value = seconds
  for (const [unit, span] of units) {
    if (Math.abs(value) < span || unit === 'year') {
      try {
        const language = doc.defaultView?.navigator.language ?? 'en'
        return new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(
          Math.round(value),
          unit,
        )
      } catch {
        return ''
      }
    }
    value /= span
  }
  return ''
}

/** §7 row 14: hover *adds* the absolute datetime, and the viewport the thread was captured at. */
function absolute(doc: Document, iso: string): string {
  try {
    const language = doc.defaultView?.navigator.language ?? 'en'
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso),
    )
  } catch {
    return iso
  }
}

export function createThreadPopover(host: PresentationHost, intents: Intents): ThreadPopover {
  const { doc } = host

  /* §0 D6: the corner cluster is the ONLY chrome, it floats over the content, and it is drawn
     for as long as the thread is open. `data-role="status"` is the stable hook, because
     `data-action` flips between resolve and reopen. */
  const resolveGlyph = icon(doc, 'cc-i-check', 'cc-icon')
  const resolve = el(
    doc,
    'button',
    { type: 'button', class: 'cc-ghost', 'data-role': 'status', 'data-action': 'resolve' },
    [resolveGlyph],
  )
  const close = el(
    doc,
    'button',
    { type: 'button', class: 'cc-ghost', 'data-variant': 'icon', 'data-action': 'close' },
    [icon(doc, 'cc-i-close', 'cc-icon')],
  )
  const corner = el(doc, 'div', { class: 'cc-corner' }, [resolve, close])

  const list = el(doc, 'ul', { class: 'cc-comments' })
  // §10 keeps the orphan quote — it is the only place the deleted content still exists — but §0
  // D6 forbids anything above the first comment, so the audit trail sits below the thread.
  const quote = el(doc, 'p', { class: 'cc-quote', hidden: true })
  const chipSlot = createChipSlot(doc, true)
  const chip: ChipSlot = createChip(doc, chipSlot)

  /* §7 row 29: the permanently rendered, collapsed reply field, and the slot the expanded
     composer docks into. `Labels.placeholder` is its visible rest label (§10 keeps it);
     `Labels.reply` is its accessible name, so the verb never has to be drawn. */
  const replyLabel = el(doc, 'span', { class: 'cc-reply-label', 'aria-hidden': 'true' })
  const reply = el(doc, 'button', { type: 'button', class: 'cc-reply', 'data-action': 'reply' }, [
    replyLabel,
  ])
  const replySlot = el(doc, 'div', { class: 'cc-reply-slot' })
  const foot = el(doc, 'div', { class: 'cc-thread-foot' }, [chipSlot, reply, replySlot])

  const element = el(
    doc,
    'div',
    {
      class: 'cc-thread cc-glass cc-float',
      popover: 'manual',
      role: 'dialog',
      'data-open': 'false',
    },
    [corner, list, quote, foot],
  )
  host.layer.append(element)
  host.anchor('thread', element)

  let openId: string | null = null
  let current: ThreadVM | null = null
  let labels: Labels | null = null
  let replying = false
  /** Comment ids already drawn for the open thread, so a late arrival can be told apart. */
  let known = new Set<string>()

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
  element.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    disarmAll()
    if (intents.escape()) event.preventDefault()
  })

  /**
   * §6.4 `arm` / A4: the first click arms, the second deletes. Delete lives in the **first
   * comment's** row cluster now (§0 D6 took it out of the corner), so the arm follows the node
   * that row reuses across renders rather than a single control this file owns.
   */
  const arms = new Map<HTMLElement, ReturnType<typeof createArm>>()
  function armFor(node: HTMLElement): ReturnType<typeof createArm> {
    let existing = arms.get(node)
    if (!existing) {
      existing = createArm(node)
      arms.set(node, existing)
    }
    return existing
  }
  function disarmAll(): void {
    for (const entry of arms.values()) entry.disarm()
  }
  element.addEventListener('click', (event: Event) => {
    const path = event.composedPath()
    for (const [node, entry] of arms) if (!path.includes(node)) entry.disarm()
  })

  /**
   * The mask *is* the scroll affordance (§8.4), so it has to know where the list is — and it has
   * to ask again once the list has a size. `clientHeight > 0` is the guard, and the observer is
   * what re-asks after layout, after an append, and after the textarea inside an inline edit grows.
   */
  function syncScroll(): void {
    const height = list.clientHeight
    setAttr(list, 'data-scroll-top', list.scrollTop > 2 ? 'true' : null)
    const bottom = height > 0 && list.scrollHeight - height - list.scrollTop > 2
    setAttr(list, 'data-scroll-bottom', bottom ? 'true' : null)
  }
  list.addEventListener('scroll', syncScroll, { passive: true })
  // …and once more when the entrance finishes: `cc-stagger` translates each comment 4 px on its
  // way in, and a translated child counts toward its scroll container's overflow.
  list.addEventListener('animationend', syncScroll)

  const view = doc.defaultView
  const Observer = (view as { ResizeObserver?: typeof ResizeObserver } | null)?.ResizeObserver
  /** Held in a variable `destroy()` reads: an observer nothing references is collectable. */
  const resize = typeof Observer === 'function' ? new Observer(syncScroll) : null
  resize?.observe(list)

  function renderComment(node: HTMLElement, comment: CommentVM, index: number): void {
    const author = node.querySelector<HTMLElement>('.cc-author')
    const authorWord = node.querySelector<HTMLElement>('.cc-author-word')
    const time = node.querySelector<HTMLElement>('.cc-time')
    const edited = node.querySelector<HTMLElement>('.cc-edited')
    const body = node.querySelector<HTMLElement>('.cc-body')
    const edit = node.querySelector<HTMLButtonElement>('[data-action="edit"]')
    const remove = node.querySelector<HTMLButtonElement>('[data-action="delete"]')
    if (!author || !authorWord || !time || !edited || !body || !edit || !remove || !labels) return

    setAttr(node, 'data-comment', comment.id)
    setAttr(node, 'data-author', comment.author)
    setAttr(node, 'data-edited', comment.editedAt ? 'true' : null)
    setAttr(node, 'style', `--_i:${String(Math.min(index, STAGGER_CAP))}`)

    // §0 D2: the author mark is a 12 px difference marker — `cc-i-sparkle` on a copilot row and
    // **nothing** on a user row, because `Author` is a two-value union with no name and no avatar
    // and the majority case is "a person wrote this". Both keep the word in the a11y tree.
    setAttr(author, 'hidden', comment.author !== 'copilot')
    setText(authorWord, comment.author)

    // No prose: the timestamp is a machine value, so it needs no `Labels` key to be i18n-clean.
    // It is drawn on every row, always — hover only ADDS the absolute datetime.
    setAttr(time, 'datetime', comment.createdAt)
    setAttr(time, 'title', absolute(doc, comment.editedAt ?? comment.createdAt))
    setText(time, relative(doc, comment.editedAt ?? comment.createdAt))
    setAttr(edited, 'hidden', comment.editedAt === null)

    setAttr(edit, 'aria-label', labels.edit)
    setAttr(edit, 'title', labels.edit)
    setAttr(remove, 'aria-label', labels.delete)
    setAttr(remove, 'title', labels.delete)
    // §8.4: delete stays where it already is — the **first** comment's row cluster, once per
    // thread, exactly as resolve appears once per thread in the corner.
    setAttr(remove, 'hidden', index !== 0 || !(current?.actions.delete ?? false))

    setAttr(body, 'hidden', comment.editing)
    // §0 D3 names the cluster's contents as the pencil for **own comments**. A copilot reply is
    // not the user's to rewrite, and it is the one row whose text the host regenerates.
    setAttr(edit, 'hidden', comment.editing || comment.author !== 'user')
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
      { type: 'button', class: 'cc-send', 'data-action': 'save', 'aria-label': labels.send },
      [icon(doc, 'cc-i-send', 'cc-icon')],
    )
    const cancel = el(
      doc,
      'button',
      {
        type: 'button',
        class: 'cc-ghost',
        'data-action': 'cancel-edit',
        'aria-label': labels.dismiss,
      },
      [icon(doc, 'cc-i-close', 'cc-icon')],
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
    // A node this layer created this pass, so focusing it needs no `vm.focus` round trip.
    safeFocus(input)
  }

  function createComment(): HTMLElement {
    const author = icon(doc, 'cc-i-sparkle', 'cc-author')
    author.setAttribute('data-author', 'copilot')
    // §10: the author *word* leaves the screen and stays in the accessibility tree.
    const authorWord = el(doc, 'span', { class: 'cc-author-word cc-vh' })
    const time = el(doc, 'time', { class: 'cc-time' })
    const edited = icon(doc, 'cc-i-pencil', 'cc-edited')
    edited.setAttribute('aria-hidden', 'true')
    const edit = el(
      doc,
      'button',
      { type: 'button', class: 'cc-ghost', 'data-variant': 'icon', 'data-action': 'edit' },
      [icon(doc, 'cc-i-pencil', 'cc-icon')],
    )
    const remove = el(
      doc,
      'button',
      { type: 'button', class: 'cc-ghost', 'data-variant': 'danger', 'data-action': 'delete' },
      [icon(doc, 'cc-i-trash', 'cc-icon')],
    )
    // §0 D3: one cluster per row, mounted at all times, `opacity: 0` until the row is hovered or
    // focused. Deliberately not the reference products' `⋯` menu — `⋯` exists there to host a
    // *text* list, and §10 forbids drawn verbs.
    const actions = el(doc, 'span', { class: 'cc-comment-actions' }, [edit, remove])
    const node = el(doc, 'li', { class: 'cc-comment' }, [
      el(doc, 'div', { class: 'cc-comment-head' }, [author, authorWord, time, edited, actions]),
      el(doc, 'div', { class: 'cc-body' }),
    ])
    edit.addEventListener('click', () => {
      const commentId = node.getAttribute('data-comment')
      if (openId && commentId) intents.beginEdit(openId, commentId)
    })
    remove.addEventListener('click', () => {
      if (openId && armFor(remove).click()) intents.deleteThread(openId)
    })
    return node
  }

  return {
    element,
    close,
    replySlot,

    setReplying(next) {
      replying = next
      setAttr(element, 'data-replying', next ? 'true' : null)
      setAttr(reply, 'hidden', next || !(current?.actions.reply ?? false))
    },

    render(thread, next, origin, hueOf) {
      labels = next
      setAttr(close, 'aria-label', next.dismiss)
      setAttr(close, 'title', next.dismiss)
      setAttr(reply, 'aria-label', next.reply)
      setAttr(reply, 'title', next.reply)
      setText(replyLabel, next.placeholder)

      if (!thread) {
        if (openId === null) return
        openId = null
        current = null
        known = new Set()
        disarmAll()
        chip.render(null)
        hideFloating(element)
        return
      }

      const opening = openId !== thread.threadId
      if (opening) {
        openId = thread.threadId
        known = new Set()
        disarmAll()
        showFloating(element)
        transferOrigin(element, origin)
      }
      current = thread

      setAttr(element, 'aria-label', thread.ariaLabel)
      setAttr(element, 'data-thread', thread.threadId)
      setAttr(element, 'data-status', thread.status)
      // §8.4: a resolved thread is not a colour change — the pin draws the hollow silhouette, the
      // bodies mute, and the corner ✓ becomes `cc-i-uturn`. A screenshot still says "resolved".
      setAttr(element, 'data-resolved', thread.resolved ? 'true' : null)
      setAttr(element, 'data-anchor', thread.anchor)
      setAttr(element, 'data-kind', thread.kind)
      applyHue(element, hueOf, thread.kind)
      setAttr(element, 'title', thread.title)
      chip.render(thread.chip)

      setAttr(quote, 'hidden', thread.quote === null)
      if (thread.quote !== null) setText(quote, thread.quote)

      const arrived = new Set<string>()
      for (const comment of thread.comments) {
        if (!opening && !known.has(comment.id) && comment.author === 'copilot') {
          arrived.add(comment.id)
        }
        known.add(comment.id)
      }
      // §8.4: a thread opens at its latest message (the 280px list would otherwise hide the
      // newest rows under the bottom fade). A late arrival only follows if the reader was
      // already at the bottom — never yank someone reading history.
      const wasAtBottom = list.scrollHeight - list.clientHeight - list.scrollTop <= 24

      reconcile(
        list,
        thread.comments,
        (comment) => comment.id,
        () => createComment(),
        (node, comment) => {
          const element = node as HTMLElement
          renderComment(element, comment, thread.comments.indexOf(comment))
          if (!arrived.has(comment.id)) return
          element.setAttribute('data-arrived', 'true')
          doc.defaultView?.setTimeout(() => {
            element.removeAttribute('data-arrived')
          }, 1200)
        },
      )
      if (opening || (arrived.size > 0 && wasAtBottom)) list.scrollTop = list.scrollHeight
      syncScroll()
      // …and again on the next frame, when the sheet the popover just became actually has one.
      if (opening) {
        view?.requestAnimationFrame(() => {
          list.scrollTop = list.scrollHeight
          syncScroll()
        })
      }

      // §7 row 12: **one** resolve per thread, in the corner, always drawn while it is open.
      const reopening = thread.actions.reopen
      setAttr(resolve, 'data-action', reopening ? 'reopen' : 'resolve')
      setAttr(resolve, 'aria-label', reopening ? next.reopen : next.resolve)
      setAttr(resolve, 'title', reopening ? next.reopen : next.resolve)
      setIcon(resolveGlyph, reopening ? 'cc-i-uturn' : 'cc-i-check')
      setAttr(resolve, 'hidden', !(thread.actions.resolve || thread.actions.reopen))
      setAttr(reply, 'hidden', replying || !thread.actions.reply)
    },

    destroy() {
      chip.destroy()
      for (const entry of arms.values()) entry.destroy()
      arms.clear()
      resize?.disconnect()
      list.removeEventListener('scroll', syncScroll)
      list.removeEventListener('animationend', syncScroll)
      host.anchor('thread', null)
      element.remove()
    },
  }
}
