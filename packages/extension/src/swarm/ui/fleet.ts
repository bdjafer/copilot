/**
 * The fleet plane (PRODUCT F1–F6, DESIGN §8.5): the strip, the nine buckets, the rows.
 *
 * Everything on screen here is a **value**: a count, a spend, a one-line "what it is doing right
 * now" (W4). The only words that are not values are the nine section titles, which DESIGN §10
 * keeps because they are navigation, and the row badges, which are the delegation's own state
 * words (`needs-you`'s reason, a verdict, `stalled 42s`) — the thing the user came to read.
 *
 * The rows arrive **already bucketed and already attention-sorted** from the client core (§6.2.1,
 * F2): this module never calls `bucketOf`, never re-sorts, and never decides what needs attention.
 * It is a list renderer over `vm.fleet.buckets`, and that is the whole of the head's authority
 * over the fleet.
 *
 * Two controls live in the strip and nowhere else, because they are fleet-scoped:
 *
 *  - **Dispatch** is a switch (§8.8), not a glyph — it is a boolean, and its sentence lives in
 *    `title`. Pausing dispatch stops *new* work; it never touches a turn in flight.
 *  - **The kill switch** arms (§6.4). Its label states what it is — a brake, not a delete (Q16) —
 *    because the failure mode of this control is a user who believes it deleted their worktrees,
 *    or one who believes it stopped something it could not confirm dead (F5).
 */

import type { SwarmBucketVM, SwarmRowVM } from '@astrale-os/swarm/presentation'

import type { SwarmHeadIntents, SwarmHeadViewModel } from '../types.ts'
import type { ArmRegistry } from './dom.ts'

import {
  el,
  glyphButton,
  reconcile,
  setAttr,
  setLabel,
  setSwitch,
  setText,
  switchControl,
  usd,
} from './dom.ts'
import { glyph } from './sprite.ts'

export interface FleetView {
  readonly node: HTMLElement
  render(vm: SwarmHeadViewModel): void
}

export interface FleetViewOptions {
  readonly doc: Document
  readonly intents: SwarmHeadIntents
  readonly arm: ArmRegistry
  /** The honesty disclosure is owned by the presentation, which also renders the list. */
  readonly onHonesty: () => void
  /**
   * Session-level, not fleet-level (§2.1, S5). It lives in the strip because the pairing screen is
   * never shown again once a head is paired, and a control reachable only by first losing the
   * credential is not a control.
   */
  readonly onUnpair: () => void
}

export function createFleetView(options: FleetViewOptions): FleetView {
  const { doc, intents } = options

  const node = el(doc, 'div', 'cc-col')

  /* --------------------------------------------------------------------- the strip */

  const strip = el(doc, 'div', 'cc-strip')
  const metrics = el(doc, 'div', 'cc-strip-metrics')

  const healthDot = el(doc, 'span', 'cc-dot')
  const connection = el(doc, 'span', 'cc-t11 cc-muted')
  const running = metric(doc, 'running')
  const queued = metric(doc, 'queued')
  const spend = metric(doc, 'spend')
  metrics.append(healthDot, connection, running.node, queued.node, spend.node)

  const dispatch = switchControl(
    doc,
    'dispatch — off pauses admission fleet-wide; a turn already in flight always finishes',
    (next) => {
      intents.pauseDispatch(null, !next)
    },
  )
  const honestyButton = glyphButton(doc, { id: 'honesty', onPress: options.onHonesty })
  const killInstances = glyphButton(doc, {
    id: 'kill-instances',
    arm: options.arm,
    onPress: () => {
      intents.killSwitch(true)
    },
  })
  const killSwitch = glyphButton(doc, {
    id: 'kill-switch',
    arm: options.arm,
    onPress: () => {
      intents.killSwitch(false)
    },
  })
  const unpair = glyphButton(doc, { id: 'unpair', arm: options.arm, onPress: options.onUnpair })
  strip.append(metrics, dispatch, honestyButton, unpair, killInstances, killSwitch)

  /* -------------------------------------------------------------------- the buckets */

  const list = el(doc, 'div', 'cc-fleet')
  list.setAttribute('role', 'list')
  const empty = el(doc, 'div', 'cc-empty')
  empty.append(glyph(doc, 'cc-i-stack', 20))
  /* §8.5: "one 20 px glyph at 26 % opacity in 64 px of air"; the sentence moves to `aria-label`. */
  empty.setAttribute('aria-label', 'no delegations yet — describe one below to start')
  const buckets = new Map<string, { node: Element; render: (bucket: SwarmBucketVM) => void }>()

  node.append(strip, list, empty)

  let focusedId: string | null = null

  return {
    node,
    render(vm) {
      focusedId = vm.focused?.id ?? null

      setAttr(healthDot, 'data-ok', vm.health.ok ? '1' : '0')
      setAttr(healthDot, 'title', vm.health.detail)
      setText(connection, connectionWord(vm))
      setAttr(connection, 'title', connectionDetail(vm))
      running.set(`${vm.fleet.concurrency.runningAttempts}/${vm.fleet.concurrency.cap}`)
      queued.set(String(vm.fleet.concurrency.queued))
      spend.set(
        vm.fleet.spend.capUsd === null
          ? usd(vm.fleet.spend.estUsd)
          : `${usd(vm.fleet.spend.estUsd)}/${usd(vm.fleet.spend.capUsd)}`,
      )
      setSwitch(dispatch, !vm.fleet.dispatchPaused)
      setLabel(
        unpair,
        `paired as ${vm.pairing.clientName}${vm.pairing.tokenId === null ? '' : ` · ${vm.pairing.tokenId}`} — unpair deletes this token from this browser`,
      )

      const populated = vm.fleet.buckets.filter((bucket) => bucket.rows.length > 0)
      reconcile(list, populated, (bucket) => bucket.id, createBucket, buckets)
      setAttr(empty, 'hidden', populated.length === 0 ? null : '')
    },
  }

  function createBucket(bucket: SwarmBucketVM): {
    node: Element
    render: (next: SwarmBucketVM) => void
  } {
    const section = el(doc, 'section', 'cc-bucket')
    const head = el(doc, 'div', 'cc-bucket-head')
    const title = el(doc, 'h2', 'cc-section-title', bucket.label)
    const count = el(doc, 'span', 'cc-t11 cc-num cc-muted')
    head.append(title, count)
    const card = el(doc, 'div', 'cc-bucket-card')
    card.setAttribute('role', 'list')
    section.append(head, card)
    const rows = new Map<string, { node: Element; render: (row: SwarmRowVM) => void }>()

    return {
      node: section,
      render(next) {
        setText(title, next.label)
        /* The core's own count, not `rows.length`: a filtered head still says "2 of 7". */
        setText(
          count,
          next.rows.length === next.count
            ? String(next.count)
            : `${next.rows.length}/${next.count}`,
        )
        setAttr(count, 'title', `${next.rows.length} shown of ${next.count}`)
        reconcile(card, next.rows, (row) => row.id, createRow, rows)
      },
    }
  }

  function createRow(row: SwarmRowVM): { node: Element; render: (next: SwarmRowVM) => void } {
    const item = el(doc, 'div', 'cc-row')
    item.setAttribute('role', 'listitem')
    item.tabIndex = 0
    const title = el(doc, 'div', 'cc-row-title cc-t13')
    const open = glyphButton(doc, {
      id: 'row-open',
      size: 12,
      onPress: () => {
        intents.focus(row.id)
      },
    })
    const meta = el(doc, 'div', 'cc-row-meta cc-t11')
    const badge = el(doc, 'span', 'cc-badge cc-t11')
    const attempts = el(doc, 'span', 'cc-num')
    const paused = el(doc, 'span', 'cc-badge cc-t11', 'paused')
    const now = el(doc, 'span', 'cc-row-now')
    meta.append(badge, attempts, paused, now)
    item.append(title, open, meta)

    const focus = (): void => {
      intents.focus(row.id)
    }
    item.addEventListener('click', focus)
    item.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key
      if (key !== 'Enter' && key !== ' ') return
      event.preventDefault()
      focus()
    })

    return {
      node: item,
      render(next) {
        setText(title, next.title)
        setAttr(item, 'aria-current', next.id === focusedId ? 'true' : null)
        setAttr(item, 'data-delegation', next.id)
        /* Every state a screenshot must carry is also in the accessible name (§7's five
         * discoverability mitigations, applied to a list instead of a pin). */
        item.setAttribute(
          'aria-label',
          [
            next.title,
            next.bucket,
            next.badge ?? '',
            `${next.attempts} attempts`,
            next.paused ? 'dispatch paused' : '',
            next.nowDoing ?? '',
          ]
            .filter((part) => part.length > 0)
            .join(' · '),
        )
        setText(badge, next.badge ?? '')
        setAttr(badge, 'hidden', next.badge === null ? '' : null)
        setAttr(badge, 'data-tone', badgeTone(next))
        setText(attempts, next.attempts > 1 ? `${next.attempts} attempts` : '')
        setAttr(attempts, 'hidden', next.attempts > 1 ? null : '')
        setAttr(paused, 'hidden', next.paused ? null : '')
        setText(now, next.nowDoing ?? '')
        setAttr(now, 'title', next.nowDoing ?? '')
        setAttr(now, 'hidden', next.nowDoing === null ? '' : null)
      },
    }
  }
}

function metric(doc: Document, label: string): { node: HTMLElement; set(value: string): void } {
  const node = el(doc, 'span', 'cc-metric cc-t11')
  const value = el(doc, 'b', 'cc-num')
  const name = el(doc, 'span', undefined, label)
  node.append(value, name)
  return {
    node,
    set(next) {
      setText(value, next)
    },
  }
}

/** The connection is a value too: `blocked` and `reconnecting` are things the user must see. */
function connectionWord(vm: SwarmHeadViewModel): string {
  if (vm.connection.queuedOffline > 0)
    return `${vm.connection.status} · ${vm.connection.queuedOffline} queued`
  return vm.connection.status
}

function connectionDetail(vm: SwarmHeadViewModel): string {
  if (vm.connection.blockedReason !== null) {
    return `the connection is blocked: ${vm.connection.blockedReason}. 4001/4003/4004 are terminal — this head stops retrying and needs a fix.`
  }
  return `${vm.connection.status}; ${vm.connection.queuedOffline} intents queued offline and will flush in order on reconnect with their original idempotency key`
}

function badgeTone(row: SwarmRowVM): string {
  if (row.bucket === 'failed' || row.bucket === 'cancelled' || row.bucket === 'abandoned') {
    return 'danger'
  }
  if (row.bucket === 'needs-you' || row.bucket === 'stalled') return 'warn'
  return 'accent'
}
