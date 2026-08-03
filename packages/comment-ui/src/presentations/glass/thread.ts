/**
 * The thread popover — DESIGN §7 rows 10–14 and §8.4.
 *
 * The head is a kind glyph, the state silhouette, the chip and a close control. **The title text
 * is deleted**: the mode *is* the glyph, and it is the same glyph, at the same size and colour,
 * that the badge was carrying a moment ago — which is what makes the morph read as one object
 * growing rather than two boxes swapping (§6.6).
 *
 * Comments stagger in oldest-first, in reading order, 22 ms apart and capped at six. A newly
 * arrived copilot comment gets an accent rail that decays over 1.2 s, so a reply that lands while
 * you are reading announces itself without moving anything. Timestamps are a 3 px dot until the
 * row is hovered, then `Intl.RelativeTimeFormat` — built from **values**, so it needs no `Labels`
 * key and is translated by the platform.
 *
 * Two rules here exist because this runs on someone else's page: `overscroll-behavior: contain`
 * on the comment list, or a scrolled-out thread scrolls *their* article; and the scroll affordance
 * is a mask, not a scrollbar, because a mask cannot be styled away by an inherited rule.
 *
 * Orphan-while-open never jumps. The head silhouette crossfades to the dashed pin, the quote rail
 * reveals, and the action row swaps resolve for delete — the box does not move.
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
import { createChip, createChipSlot, renderMarks, type ChipSlot } from './chip.ts'
import { icon, kindIcon, setIcon } from './icons.ts'
import { applyHue } from './kind.ts'
import { transferOrigin, type Rectish } from './motion.ts'

/** §6.2: 22 ms per item, capped at six; the remainder enters together. */
const STAGGER_CAP = 6

export interface ThreadPopover {
  readonly element: HTMLElement
  readonly close: HTMLElement
  render(thread: ThreadVM | null, labels: Labels, origin: Rectish | null, hueOf: HueOf): void
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

export function createThreadPopover(host: PresentationHost, intents: Intents): ThreadPopover {
  const { doc } = host

  const headGlyph = icon(doc, 'cc-i-comment', 'cc-head-icon')
  const marks = el(doc, 'span', { class: 'cc-badge-marks', 'aria-hidden': 'true' })
  const chipSlot = createChipSlot(doc, true)
  const chip: ChipSlot = createChip(doc, chipSlot)
  const close = el(
    doc,
    'button',
    { type: 'button', class: 'cc-ghost', 'data-variant': 'icon', 'data-action': 'close' },
    [icon(doc, 'cc-i-close', 'cc-icon')],
  )
  const head = el(doc, 'div', { class: 'cc-head' }, [headGlyph, marks, chipSlot, close])
  const quote = el(doc, 'p', { class: 'cc-quote', hidden: true })
  const list = el(doc, 'ul', { class: 'cc-comments' })

  const reply = el(doc, 'button', { type: 'button', class: 'cc-ghost', 'data-action': 'reply' }, [
    icon(doc, 'cc-i-reply', 'cc-icon'),
  ])
  // `data-action` flips between resolve and reopen, so the stable hook is `data-role`.
  const resolveGlyph = icon(doc, 'cc-i-check', 'cc-icon')
  const resolve = el(
    doc,
    'button',
    { type: 'button', class: 'cc-ghost', 'data-role': 'status', 'data-action': 'resolve' },
    [resolveGlyph],
  )
  const remove = el(
    doc,
    'button',
    { type: 'button', class: 'cc-ghost', 'data-variant': 'danger', 'data-action': 'delete' },
    [icon(doc, 'cc-i-trash', 'cc-icon')],
  )
  const actions = el(doc, 'div', { class: 'cc-thread-actions' }, [reply, resolve, remove])

  const element = el(
    doc,
    'div',
    {
      class: 'cc-thread cc-glass cc-float',
      popover: 'manual',
      role: 'dialog',
      'data-open': 'false',
    },
    [head, quote, list, actions],
  )
  host.layer.append(element)
  host.anchor('thread', element)

  let openId: string | null = null
  let current: ThreadVM | null = null
  let labels: Labels | null = null
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
  // §6.4 `arm` / A4: the first click arms, the second deletes. Everything else disarms.
  const arm = createArm(remove)
  remove.addEventListener('click', () => {
    if (!openId) return
    if (arm.click()) intents.deleteThread(openId)
  })
  element.addEventListener('click', (event: Event) => {
    if (!event.composedPath().includes(remove)) arm.disarm()
  })
  element.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    arm.disarm()
    if (intents.escape()) event.preventDefault()
  })

  /**
   * The mask *is* the scroll affordance (§8.4), so it has to know where the list is — and it has
   * to ask again once the list has a size. Bound to `scroll` alone, it was evaluated while the
   * popover was still `display: none`, where `clientHeight` is 0 and *every* list looks
   * overflowing: the mask then faded out the tail of the newest comment with nothing to scroll
   * to. `clientHeight > 0` is the guard, and the observer is what re-asks after layout, after an
   * append, and after the textarea inside an inline edit grows.
   */
  function syncScroll(): void {
    const height = list.clientHeight
    setAttr(list, 'data-scroll-top', list.scrollTop > 2 ? 'true' : null)
    const bottom = height > 0 && list.scrollHeight - height - list.scrollTop > 2
    setAttr(list, 'data-scroll-bottom', bottom ? 'true' : null)
  }
  list.addEventListener('scroll', syncScroll, { passive: true })
  // …and once more when the entrance finishes. `cc-stagger` translates each comment 4 px on its
  // way in, and a translated child **counts toward its scroll container's overflow** — so a list
  // that fits exactly reports 4 px of scrollable height for the length of the animation, turns
  // the mask on, and then never resizes again to turn it off. `animationend` bubbles, so one
  // listener on the list covers every comment in it.
  list.addEventListener('animationend', syncScroll)

  const view = doc.defaultView
  const Observer = (view as { ResizeObserver?: typeof ResizeObserver } | null)?.ResizeObserver
  /**
   * **Held in a variable that `destroy()` reads, and that is load-bearing twice over.** An
   * observer nothing references is collectable, and a browser will collect it: the callback fires
   * once and then silently stops, which looks exactly like a mask that is broken again.
   * Disconnecting it is also the ordinary teardown obligation for a per-mount observer.
   */
  const resize = typeof Observer === 'function' ? new Observer(syncScroll) : null
  resize?.observe(list)

  function renderComment(node: HTMLElement, comment: CommentVM, index: number): void {
    const author = node.querySelector<HTMLElement>('.cc-author')
    const time = node.querySelector<HTMLElement>('.cc-time')
    const body = node.querySelector<HTMLElement>('.cc-body')
    const edit = node.querySelector<HTMLButtonElement>('[data-action="edit"]')
    if (!author || !time || !body || !edit || !labels) return

    setAttr(node, 'data-comment', comment.id)
    setAttr(node, 'data-author', comment.author)
    setAttr(node, 'data-edited', comment.editedAt ? 'true' : null)
    setAttr(node, 'style', `--_i:${String(Math.min(index, STAGGER_CAP))}`)
    setIcon(author, comment.author === 'copilot' ? 'cc-i-sparkle' : 'cc-i-comment')
    setAttr(author, 'data-author', comment.author)
    setAttr(author, 'aria-label', comment.author)
    // No prose: the timestamp is a machine value, so it needs no `Labels` key to be i18n-clean.
    setAttr(time, 'datetime', comment.createdAt)
    setAttr(time, 'title', comment.editedAt ?? comment.createdAt)
    setText(time, relative(doc, comment.editedAt ?? comment.createdAt))
    setAttr(edit, 'aria-label', labels.edit)
    setAttr(edit, 'title', labels.edit)

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
    // A node this layer created this pass, so focusing it needs no `vm.focus` round trip — the
    // four `FocusTarget`s are the ones policy has an opinion about.
    safeFocus(input)
  }

  function createComment(): HTMLElement {
    const author = icon(doc, 'cc-i-comment', 'cc-author')
    const time = el(doc, 'time', { class: 'cc-time' })
    const edit = el(
      doc,
      'button',
      { type: 'button', class: 'cc-ghost', 'data-variant': 'icon', 'data-action': 'edit' },
      [icon(doc, 'cc-i-pencil', 'cc-icon')],
    )
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

    render(thread, next, origin, hueOf) {
      labels = next
      setAttr(close, 'aria-label', next.dismiss)
      setAttr(close, 'title', next.dismiss)
      setAttr(reply, 'aria-label', next.reply)
      setAttr(reply, 'title', next.reply)
      setAttr(remove, 'aria-label', next.delete)
      setAttr(remove, 'title', next.delete)

      if (!thread) {
        if (openId === null) return
        openId = null
        current = null
        known = new Set()
        arm.disarm()
        chip.render(null)
        hideFloating(element)
        return
      }

      const opening = openId !== thread.threadId
      if (opening) {
        openId = thread.threadId
        known = new Set()
        arm.disarm()
        showFloating(element)
        transferOrigin(element, origin)
      }
      current = thread

      setAttr(element, 'aria-label', thread.ariaLabel)
      setAttr(element, 'data-thread', thread.threadId)
      setAttr(element, 'data-status', thread.status)
      // §8.4: resolved is a *silhouette*, not a tint. The head draws the hollow disc + check the
      // badge draws, and the sheet mutes — so a screenshot of a resolved thread says so.
      setAttr(element, 'data-resolved', thread.resolved ? 'true' : null)
      setAttr(element, 'data-anchor', thread.anchor)
      setAttr(element, 'data-kind', thread.kind)
      applyHue(element, hueOf, thread.kind)
      setAttr(element, 'title', thread.title)
      setIcon(headGlyph, kindIcon(thread.kind))
      renderMarks(doc, marks, thread)
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
      syncScroll()
      // …and again on the next frame, when the sheet the popover just became actually has one.
      if (opening) view?.requestAnimationFrame(syncScroll)

      const reopening = thread.actions.reopen
      setAttr(resolve, 'data-action', reopening ? 'reopen' : 'resolve')
      setAttr(resolve, 'aria-label', reopening ? next.reopen : next.resolve)
      setAttr(resolve, 'title', reopening ? next.reopen : next.resolve)
      setIcon(resolveGlyph, reopening ? 'cc-i-uturn' : 'cc-i-check')
      setAttr(reply, 'hidden', !thread.actions.reply)
      setAttr(resolve, 'hidden', !(thread.actions.resolve || thread.actions.reopen))
      setAttr(remove, 'hidden', !thread.actions.delete)
    },

    destroy() {
      chip.destroy()
      arm.destroy()
      resize?.disconnect()
      list.removeEventListener('scroll', syncScroll)
      list.removeEventListener('animationend', syncScroll)
      host.anchor('thread', null)
      element.remove()
    },
  }
}
