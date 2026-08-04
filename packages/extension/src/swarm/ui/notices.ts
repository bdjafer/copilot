/**
 * Notices, copilot confirmations and the honesty surface.
 *
 * **Confirmations are not notifications** (§6.7, Q8). A copilot write tool cannot execute until a
 * human answers, unanswered requests are auto-denied at `expiresAt`, and "no head connected ⇒ no
 * confirmation ⇒ no write" is the whole authority the mechanism carries. So the request is drawn
 * with its effective configuration — model, effort, workspace, write mode — and the remaining time
 * is a **value that counts down**, because a request whose deadline is invisible is one the user
 * discovers by watching it expire.
 *
 * **The honesty surface is a release gate** (S8/S10/S11, gate 10), not an about box. Four
 * statements, each one a thing this product *cannot* do — structural authority, dark approvals,
 * unconfirmable effort, unenforceable network isolation — plus whatever the server adds from its
 * own configuration. It is disclosed by one 16 px `cc-i-info`, exactly as DESIGN §7 row 26
 * discloses an options hint, and it is never a wall of text on first run.
 */

import type { SwarmConfirmationVM, SwarmNoticeVM } from '@astrale-os/swarm/presentation'

import type { SwarmHeadIntents, SwarmHeadViewModel } from '../types.ts'

import { duration, el, glyphButton, reconcile, setAttr, setText } from './dom.ts'

export interface NoticeStack {
  readonly node: HTMLElement
  render(vm: SwarmHeadViewModel): void
}

export function createNoticeStack(options: {
  doc: Document
  intents: SwarmHeadIntents
}): NoticeStack {
  const { doc, intents } = options

  const node = el(doc, 'div', 'cc-notices')
  node.setAttribute('role', 'status')
  node.setAttribute('aria-live', 'polite')

  const confirmations = el(doc, 'div', 'cc-notices')
  confirmations.style.position = 'static'
  const confirmationRows = new Map<
    string,
    { node: Element; render: (c: SwarmConfirmationVM) => void }
  >()

  const notices = el(doc, 'div', 'cc-notices')
  notices.style.position = 'static'
  const noticeRows = new Map<string, { node: Element; render: (n: SwarmNoticeVM) => void }>()

  node.append(confirmations, notices)

  return {
    node,
    render(vm) {
      reconcile(
        confirmations,
        vm.confirmations,
        (c) => c.requestId,
        createConfirmation,
        confirmationRows,
      )
      reconcile(notices, vm.notices, (n) => n.id, createNotice, noticeRows)
      setAttr(node, 'hidden', vm.confirmations.length + vm.notices.length === 0 ? '' : null)
    },
  }

  function createConfirmation(request: SwarmConfirmationVM): {
    node: Element
    render: (next: SwarmConfirmationVM) => void
  } {
    const card = el(doc, 'div', 'cc-confirm')
    const summary = el(doc, 'div', 'cc-t13')
    const detail = el(doc, 'div', 'cc-t11 cc-muted')
    const foot = el(doc, 'div', 'cc-line')
    const expires = el(doc, 'span', 'cc-t11 cc-muted cc-num cc-grow')
    const deny = glyphButton(doc, {
      id: 'deny',
      onPress: () => {
        intents.deny(request.requestId, 'denied from the extension head')
      },
    })
    const confirm = glyphButton(doc, {
      id: 'confirm',
      tone: 'accent',
      onPress: () => {
        intents.confirm(request.requestId)
      },
    })
    foot.append(expires, deny, confirm)
    card.append(summary, detail, foot)
    return {
      node: card,
      render(next) {
        /* Rendered verbatim (§6.7): the server wrote one line and it is not the head's to rewrite. */
        setText(summary, next.summary)
        setText(detail, next.detail)
        setText(expires, `${duration(next.expiresInMs)} left`)
        setAttr(
          expires,
          'title',
          'unanswered requests are denied automatically when this reaches zero — the copilot cannot act while nobody is watching',
        )
      },
    }
  }

  function createNotice(notice: SwarmNoticeVM): {
    node: Element
    render: (next: SwarmNoticeVM) => void
  } {
    const card = el(doc, 'div', 'cc-notice')
    const body = el(doc, 'div', 'cc-grow')
    const title = el(doc, 'div', 'cc-t12')
    const detail = el(doc, 'div', 'cc-t11 cc-muted')
    body.append(title, detail)
    const dismiss = glyphButton(doc, {
      id: 'dismiss',
      size: 12,
      onPress: () => {
        intents.dismissNotice(notice.id)
      },
    })
    card.append(body, dismiss)
    return {
      node: card,
      render(next) {
        setAttr(card, 'data-severity', next.severity)
        setAttr(card, 'data-kind', next.kind)
        setText(title, next.title)
        setText(detail, next.detail)
        setAttr(dismiss, 'hidden', next.dismissible ? null : '')
      },
    }
  }
}

export interface HonestyPanel {
  readonly node: HTMLElement
  toggle(): void
  render(vm: SwarmHeadViewModel): void
}

export function createHonestyPanel(doc: Document): HonestyPanel {
  let open = false
  const node = el(doc, 'section', 'cc-panel cc-t11')
  node.setAttribute('aria-label', 'what this product cannot do')
  const list = el(doc, 'div')
  const routes = el(doc, 'div')
  node.append(list, routes)

  return {
    node,
    toggle() {
      open = !open
      setAttr(node, 'hidden', open ? null : '')
    },
    render(vm) {
      setAttr(node, 'hidden', open ? null : '')
      if (!open) return
      list.replaceChildren()
      for (const entry of vm.health.honesty) {
        const line = el(doc, 'div', 'cc-line')
        line.append(
          el(doc, 'b', 'cc-t12', entry.title),
          el(doc, 'span', 'cc-muted cc-grow', entry.detail),
        )
        list.append(line)
      }
      routes.replaceChildren()
      for (const route of vm.health.routes) {
        const line = el(doc, 'div', 'cc-line cc-muted')
        line.append(
          el(doc, 'span', 'cc-t12', `${route.provider}/${route.model}`),
          el(doc, 'span', 'cc-grow', route.available ? 'available' : route.detail),
        )
        routes.append(line)
      }
    },
  }
}
