/**
 * The corner thread panel (§5.2 `panel.ts`, PLAN §3.3) — "open" / "resolved" / "unanchored".
 *
 * The panel is what makes two page-invisible states reachable: a **resolved** thread hides its
 * badge (Figma/Docs behavior) but can be reopened from here, and an **orphaned** thread —
 * whose element is gone from the DOM — is listed here even when `badge.orphaned` is
 * `'panel-only'`. A **pending** thread appears in no section at all (§3).
 *
 * Section assignment is total and exclusive, so one thread is never listed twice:
 * resolved → `resolved`; else orphaned → `unanchored`; else → `open`. `'hidden'` orphan mode
 * removes them from the page *and* the panel, which is the only reading that distinguishes it
 * from `'panel-only'`.
 *
 * Markup is a `<section>` named by `Labels.panelTitle` with a heading-labelled list per
 * section (§3 a11y).
 */

import type { ThreadView } from '@astrale-os/comment-core'

import type { UIContext } from './context.ts'
import type { Labels, PanelSection } from './types.ts'

import { createChipSlot, renderChip } from './chip.ts'
import { isApproximate, threadLabel } from './context.ts'
import { el, reconcile, setAttr, setText } from './dom.ts'

export interface Panel {
  /** The corner toggle. It outlives every thread, so it is the focus fallback (§3 a11y). */
  readonly toggle: HTMLElement
  render(views: readonly ThreadView[]): void
  destroy(): void
}

const SECTION_LABEL: Record<PanelSection, keyof Labels> = {
  open: 'sectionOpen',
  resolved: 'sectionResolved',
  unanchored: 'sectionUnanchored',
}

const SECTION_EMPTY: Record<PanelSection, keyof Labels> = {
  open: 'emptyOpen',
  resolved: 'emptyResolved',
  unanchored: 'emptyUnanchored',
}

/** §3: pending is in no section; otherwise resolved wins over orphaned wins over open. */
export function sectionOf(view: ThreadView): PanelSection | null {
  if (view.anchoring.status === 'pending') return null
  if (view.isResolved) return 'resolved'
  if (view.isOrphaned) return 'unanchored'
  return 'open'
}

interface SectionParts {
  wrapper: HTMLElement
  list: HTMLElement
  empty: HTMLElement
  count: HTMLElement
}

export function createPanel(ctx: UIContext): Panel {
  const { corner, sections } = ctx.options.panel
  let counter = 0

  const toggleCount = el(ctx.doc, 'span', { class: 'cc-badge-count' })
  const toggle = el(
    ctx.doc,
    'button',
    {
      type: 'button',
      class: 'cc-panel-toggle',
      'data-corner': corner,
      'aria-label': ctx.labels.panelTitle,
      'aria-expanded': 'false',
    },
    [el(ctx.doc, 'span', { 'aria-hidden': 'true' }, ['💬']), toggleCount],
  )
  toggle.addEventListener('click', () => {
    if (ctx.panelOpen()) ctx.closePanel()
    else ctx.openPanel()
  })

  const closeButton = el(
    ctx.doc,
    'button',
    {
      type: 'button',
      class: 'cc-btn',
      'data-variant': 'icon',
      'data-action': 'close-panel',
      'aria-label': ctx.labels.dismiss,
    },
    ['✕'],
  )
  closeButton.addEventListener('click', () => {
    ctx.closePanel()
  })

  const heading = el(ctx.doc, 'h2', { class: 'cc-panel-title' }, [ctx.labels.panelTitle])
  const element = el(
    ctx.doc,
    'section',
    {
      class: 'cc-panel',
      'data-corner': corner,
      'data-open': 'false',
      role: 'region',
      'aria-label': ctx.labels.panelTitle,
    },
    [el(ctx.doc, 'div', { class: 'cc-head' }, [heading, closeButton])],
  )

  const parts = new Map<PanelSection, SectionParts>()
  for (const section of sections) {
    counter += 1
    const headingId = `cc-section-${String(counter)}`
    const count = el(ctx.doc, 'span', { class: 'cc-row-meta' })
    const sectionHeading = el(ctx.doc, 'h3', { class: 'cc-section-title', id: headingId }, [
      ctx.labels[SECTION_LABEL[section]],
      ' ',
      count,
    ])
    const list = el(ctx.doc, 'ul', { class: 'cc-rows', 'aria-labelledby': headingId })
    const empty = el(ctx.doc, 'p', { class: 'cc-empty' }, [ctx.labels[SECTION_EMPTY[section]]])
    const wrapper = el(ctx.doc, 'div', { class: 'cc-section', 'data-section': section }, [
      sectionHeading,
      list,
      empty,
    ])
    element.append(wrapper)
    parts.set(section, { wrapper, list, empty, count })
  }

  ctx.layer.append(toggle, element)

  function createRow(view: ThreadView): HTMLElement {
    const label = el(ctx.doc, 'span', { class: 'cc-row-body' })
    const meta = el(ctx.doc, 'span', { class: 'cc-row-meta' })
    // Documented narrowing of §3's "chips live in an aria-live region": the SAME decoration is
    // rendered into up to three slots at once (badge, popover, this row). Making all three live
    // would announce one transition three times, so the two the user is looking at when a chip
    // changes carry the live region and the panel row is a silent duplicate of them.
    const chipSlot = createChipSlot(ctx, false)
    meta.append(chipSlot)
    const main = el(
      ctx.doc,
      'button',
      { type: 'button', class: 'cc-row-main', 'data-thread': view.id },
      [meta, label],
    )
    main.addEventListener('click', () => {
      ctx.focusThread(view.id)
    })

    const secondary = el(ctx.doc, 'div', { class: 'cc-row-actions' })
    return el(ctx.doc, 'li', { class: 'cc-row', 'data-thread': view.id }, [main, secondary])
  }

  function updateRow(row: HTMLElement, view: ThreadView, section: PanelSection): void {
    const main = row.querySelector<HTMLButtonElement>('.cc-row-main')
    const label = row.querySelector<HTMLElement>('.cc-row-body')
    const meta = row.querySelector<HTMLElement>('.cc-row-meta')
    const chipSlot = row.querySelector<HTMLElement>('.cc-chip-slot')
    const secondary = row.querySelector<HTMLElement>('.cc-row-actions')
    if (!main || !label || !meta || !chipSlot || !secondary) return

    setText(label, view.lastComment.body)
    setAttr(main, 'aria-label', threadLabel(ctx, view))
    setAttr(main, 'title', view.capture.text.slice(0, 160))
    setAttr(row, 'data-anchor', view.anchoring.status)
    setAttr(row, 'data-status', view.status)
    setAttr(row, 'data-approximate', isApproximate(view) ? 'true' : null)

    let name = meta.querySelector<HTMLElement>('.cc-row-kind')
    if (!name) {
      name = el(ctx.doc, 'span', { class: 'cc-row-kind' })
      meta.prepend(name)
    }
    setText(name, `${ctx.modeLabel(view.kind)} (${String(view.comments.length)})`)
    renderChip(ctx, chipSlot, ctx.decorationOf(view.id))

    // Resolved rows offer the reopen the hidden badge cannot; unanchored rows offer discard.
    const action = section === 'resolved' ? 'reopen' : section === 'unanchored' ? 'delete' : null
    let button = secondary.querySelector<HTMLButtonElement>('button')
    if (!action) {
      button?.remove()
      return
    }
    if (!button) {
      button = el(ctx.doc, 'button', { type: 'button', class: 'cc-btn' })
      secondary.append(button)
    }
    if (button.getAttribute('data-action') !== action) {
      setAttr(button, 'data-action', action)
      setAttr(button, 'data-variant', action === 'delete' ? 'danger' : null)
      setText(button, action === 'reopen' ? ctx.labels.reopen : ctx.labels.delete)
      button.onclick = () => {
        const run = action === 'reopen' ? ctx.engine.reopen(view.id) : ctx.engine.delete(view.id)
        run.catch(ctx.onError)
      }
    }
  }

  return {
    toggle,

    render(views) {
      const open = ctx.panelOpen()
      setAttr(element, 'data-open', open ? 'true' : 'false')
      setAttr(toggle, 'aria-expanded', open ? 'true' : 'false')

      const buckets = new Map<PanelSection, ThreadView[]>()
      for (const section of sections) buckets.set(section, [])
      let total = 0
      for (const view of views) {
        const section = sectionOf(view)
        if (!section) continue
        if (section === 'unanchored' && ctx.options.badge.orphaned === 'hidden') continue
        const bucket = buckets.get(section)
        if (!bucket) continue
        bucket.push(view)
        if (section === 'open') total += 1
      }
      setText(toggleCount, String(total))

      const current = ctx.panelSection()
      for (const [section, part] of parts) {
        const rows = buckets.get(section) ?? []
        const wasCurrent = part.wrapper.getAttribute('data-current') === 'true'
        setAttr(part.wrapper, 'data-current', section === current ? 'true' : 'false')
        // `panel.open('resolved')` must land on that section, not just show the panel.
        if (open && section === current && !wasCurrent) {
          try {
            part.wrapper.scrollIntoView({ block: 'nearest' })
          } catch {
            /* no scroller in this DOM */
          }
        }
        setText(part.count, `(${String(rows.length)})`)
        setAttr(part.empty, 'hidden', rows.length > 0)
        reconcile(
          part.list,
          rows,
          (view) => view.id,
          (view) => createRow(view),
          (node, view) => {
            updateRow(node as HTMLElement, view, section)
          },
        )
      }
    },

    destroy() {
      toggle.remove()
      element.remove()
    },
  }
}
