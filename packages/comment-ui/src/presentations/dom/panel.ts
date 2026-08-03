/**
 * The corner thread panel (PLAN §3.3) — "open" / "resolved" / "unanchored".
 *
 * The panel is what makes two page-invisible states reachable: a **resolved** thread hides its
 * badge (Figma/Docs behavior) but can be reopened from here, and an **orphaned** thread — whose
 * element is gone from the DOM — is listed here even when its badge is suppressed. Which section
 * a thread belongs to, and whether it belongs to any, is decided in the model; this file draws
 * `PanelVM` and holds no rules of its own.
 *
 * Markup is a `<section>` named by `Labels.panelTitle` with a heading-labelled list per section
 * (§3 a11y).
 */

import type {
  Intents,
  Labels,
  PanelRowVM,
  PanelSectionVM,
  PanelVM,
  PresentationHost,
} from '../../presentation.ts'

import { el, reconcile, setAttr, setText } from '../../dom.ts'
import { createChipSlot, renderChip } from './chip.ts'

export interface Panel {
  /** The corner toggle. It outlives every thread, so it is the focus fallback (§3 a11y). */
  readonly toggle: HTMLElement
  render(panel: PanelVM, labels: Labels): void
  destroy(): void
}

interface SectionParts {
  wrapper: HTMLElement
  heading: HTMLElement
  list: HTMLElement
  empty: HTMLElement
  count: HTMLElement
}

let sectionIds = 0

export function createPanel(host: PresentationHost, intents: Intents, panel: PanelVM): Panel {
  const { doc } = host

  const toggleCount = el(doc, 'span', { class: 'cc-badge-count' })
  const toggle = el(
    doc,
    'button',
    {
      type: 'button',
      class: 'cc-panel-toggle',
      'data-corner': panel.corner,
      'aria-expanded': 'false',
    },
    [el(doc, 'span', { 'aria-hidden': 'true' }, ['💬']), toggleCount],
  )
  toggle.addEventListener('click', () => {
    intents.togglePanel()
  })

  const closeButton = el(
    doc,
    'button',
    {
      type: 'button',
      class: 'cc-btn',
      'data-variant': 'icon',
      'data-action': 'close-panel',
    },
    ['✕'],
  )
  closeButton.addEventListener('click', () => {
    intents.closePanel()
  })

  const heading = el(doc, 'h2', { class: 'cc-panel-title' })
  const element = el(
    doc,
    'section',
    {
      class: 'cc-panel',
      'data-corner': panel.corner,
      'data-open': 'false',
      role: 'region',
    },
    [el(doc, 'div', { class: 'cc-head' }, [heading, closeButton])],
  )

  const parts = new Map<string, SectionParts>()
  for (const section of panel.sections) {
    sectionIds += 1
    const headingId = `cc-section-${String(sectionIds)}`
    const count = el(doc, 'span', { class: 'cc-row-meta' })
    const sectionHeading = el(doc, 'h3', { class: 'cc-section-title', id: headingId }, [
      section.label,
      ' ',
      count,
    ])
    const list = el(doc, 'ul', { class: 'cc-rows', 'aria-labelledby': headingId })
    const empty = el(doc, 'p', { class: 'cc-empty' }, [section.empty])
    const wrapper = el(doc, 'div', { class: 'cc-section', 'data-section': section.id }, [
      sectionHeading,
      list,
      empty,
    ])
    element.append(wrapper)
    parts.set(section.id, { wrapper, heading: sectionHeading, list, empty, count })
  }

  host.layer.append(toggle, element)
  host.anchor('panel-toggle', toggle)
  host.anchor('panel', element)

  function createRow(row: PanelRowVM): HTMLElement {
    const label = el(doc, 'span', { class: 'cc-row-body' })
    // Documented narrowing of §3's "chips live in an aria-live region": the SAME chip renders
    // into up to 3 slots at once (badge, popover, this row). Making all of them live would
    // announce one transition 3 times, so the two the user is looking at when a chip changes
    // carry the live region and the panel row is a silent duplicate of them.
    const meta = el(doc, 'span', { class: 'cc-row-meta' }, [createChipSlot(doc, false)])
    const main = el(
      doc,
      'button',
      { type: 'button', class: 'cc-row-main', 'data-thread': row.threadId },
      [meta, label],
    )
    main.addEventListener('click', () => {
      intents.openThread(row.threadId)
    })
    const secondary = el(doc, 'div', { class: 'cc-row-actions' })
    return el(doc, 'li', { class: 'cc-row', 'data-thread': row.threadId }, [main, secondary])
  }

  function updateRow(node: HTMLElement, row: PanelRowVM, labels: Labels): void {
    const main = node.querySelector<HTMLButtonElement>('.cc-row-main')
    const label = node.querySelector<HTMLElement>('.cc-row-body')
    const meta = node.querySelector<HTMLElement>('.cc-row-meta')
    const chipSlot = node.querySelector<HTMLElement>('.cc-chip-slot')
    const secondary = node.querySelector<HTMLElement>('.cc-row-actions')
    if (!main || !label || !meta || !chipSlot || !secondary) return

    setText(label, row.body)
    setAttr(main, 'aria-label', row.ariaLabel)
    setAttr(main, 'title', row.title)
    setAttr(node, 'data-anchor', row.anchor)
    setAttr(node, 'data-status', row.status)
    setAttr(node, 'data-approximate', row.approximate ? 'true' : null)

    let name = meta.querySelector<HTMLElement>('.cc-row-kind')
    if (!name) {
      name = el(doc, 'span', { class: 'cc-row-kind' })
      meta.prepend(name)
    }
    setText(name, row.ariaLabel)
    renderChip(doc, chipSlot, row.chip)

    let button = secondary.querySelector<HTMLButtonElement>('button')
    if (!row.action) {
      button?.remove()
      return
    }
    if (!button) {
      button = el(doc, 'button', { type: 'button', class: 'cc-btn' })
      secondary.append(button)
    }
    const action = row.action
    if (button.getAttribute('data-action') !== action) {
      setAttr(button, 'data-action', action)
      setAttr(button, 'data-variant', action === 'delete' ? 'danger' : null)
      button.onclick = () => {
        if (action === 'reopen') intents.reopenThread(row.threadId)
        else intents.deleteThread(row.threadId)
      }
    }
    setText(button, action === 'reopen' ? labels.reopen : labels.delete)
  }

  function renderSection(part: SectionParts, section: PanelSectionVM, labels: Labels): void {
    const wasCurrent = part.wrapper.getAttribute('data-current') === 'true'
    setAttr(part.wrapper, 'data-current', section.current ? 'true' : 'false')
    if (section.current && !wasCurrent) {
      try {
        part.wrapper.scrollIntoView({ block: 'nearest' })
      } catch {
        /* no scroller in this DOM */
      }
    }
    setText(part.count, `(${String(section.rows.length)})`)
    setAttr(part.empty, 'hidden', section.rows.length > 0)
    setText(part.empty, section.empty)
    if (part.heading.firstChild) part.heading.firstChild.textContent = section.label
    reconcile(
      part.list,
      section.rows,
      (row) => row.threadId,
      (row) => createRow(row),
      (node, row) => {
        updateRow(node as HTMLElement, row, labels)
      },
    )
  }

  return {
    toggle,

    render(next, labels) {
      setText(heading, next.title)
      setAttr(element, 'aria-label', next.title)
      setAttr(toggle, 'aria-label', next.title)
      setAttr(closeButton, 'aria-label', labels.dismiss)
      setAttr(element, 'data-open', next.open ? 'true' : 'false')
      setAttr(toggle, 'aria-expanded', next.open ? 'true' : 'false')
      setText(toggleCount, String(next.total))
      for (const section of next.sections) {
        const part = parts.get(section.id)
        if (part) renderSection(part, section, labels)
      }
    },

    destroy() {
      host.anchor('panel-toggle', null)
      host.anchor('panel', null)
      toggle.remove()
      element.remove()
    },
  }
}
