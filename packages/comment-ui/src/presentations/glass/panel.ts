/**
 * The corner panel — DESIGN §7 rows 5–9 and §8.5.
 *
 * **Zero threads is zero pixels.** A permanent corner pill on every page the widget touches is
 * the most invasive thing in the product and it buys discoverability exactly once per user;
 * discoverability is a *moment* (the first-run breath, the summon chord, the seed the instant
 * content exists), not a permanent tax. From one thread the seed is an 8 px muted dot, and it
 * becomes a 30 px glass disc with a tabular count when the cursor comes within 140 px.
 *
 * The sheet is a macOS inset grouped list: an uppercase 11 px section title with a tabular count
 * above a translucent card, rows separated by hairlines inset 10 px. Row bodies fade out under a
 * mask rather than `text-overflow: ellipsis` — a mask reads softer and does not eat a character.
 * Section words leave the screen for a segmented control of icons and counts, and survive as
 * `title` / `aria-label`; the `<h3>`s stay as visually-hidden `aria-labelledby` targets, so the
 * heading-labelled-list shape of the accessibility contract is untouched.
 *
 * **Rail mode** is the mutual-exclusion rule made non-destructive: when a popover opens the panel
 * does not close, it slides out to a 44 px rail that peeks back on hover. Attention becomes
 * singular; state is preserved.
 */

import type {
  Intents,
  Labels,
  PanelRowVM,
  PanelSection,
  PanelSectionVM,
  PanelVM,
  PresentationHost,
} from '../../presentation.ts'

import { el, reconcile, setAttr, setText } from '../../dom.ts'
import { createChip, createChipSlot, type ChipSlot } from './chip.ts'
import { icon, kindIcon, setIcon } from './icons.ts'
import { roll } from './motion.ts'

export interface Panel {
  /** The corner seed. It outlives every thread, so it is the focus fallback. */
  readonly toggle: HTMLElement
  render(panel: PanelVM, labels: Labels, rail: boolean, reduced: boolean): void
  /** The seed, for the proximity tracker's 140 px ring. */
  proximity(): { node: HTMLElement; radius: number }[]
  destroy(): void
}

interface SectionParts {
  wrapper: HTMLElement
  heading: HTMLElement
  list: HTMLElement
  empty: HTMLElement
  emptyText: HTMLElement
  segment: HTMLButtonElement
  segmentCount: HTMLElement
}

const SECTION_GLYPH: Record<PanelSection, string> = {
  open: 'cc-i-comment',
  resolved: 'cc-i-check',
  unanchored: 'cc-i-pin-off',
}

let sectionIds = 0

export function createPanel(host: PresentationHost, intents: Intents, panel: PanelVM): Panel {
  const { doc } = host

  const seedCount = el(doc, 'span', { class: 'cc-seed-count', 'aria-hidden': 'true' })
  const toggle = el(
    doc,
    'button',
    {
      type: 'button',
      class: 'cc-seed',
      'data-corner': panel.corner,
      'data-near': 'false',
      'aria-expanded': 'false',
    },
    [icon(doc, 'cc-i-stack', 'cc-icon'), seedCount],
  )
  toggle.addEventListener('click', () => {
    intents.togglePanel()
  })

  const closeButton = el(
    doc,
    'button',
    { type: 'button', class: 'cc-ghost', 'data-variant': 'icon', 'data-action': 'close-panel' },
    [icon(doc, 'cc-i-close', 'cc-icon')],
  )
  closeButton.addEventListener('click', () => {
    intents.closePanel()
  })

  const heading = el(doc, 'h2', { class: 'cc-panel-title' })
  const segmented = el(doc, 'div', { class: 'cc-segmented', role: 'group' })
  const element = el(
    doc,
    'section',
    {
      class: 'cc-panel cc-glass',
      'data-corner': panel.corner,
      'data-open': 'false',
      role: 'region',
    },
    [el(doc, 'div', { class: 'cc-panel-head' }, [heading, segmented, closeButton])],
  )

  const parts = new Map<string, SectionParts>()
  const order: PanelSection[] = []

  for (const section of panel.sections) {
    sectionIds += 1
    const headingId = `cc-section-${String(sectionIds)}`
    order.push(section.id)

    const segmentCount = el(doc, 'span', { class: 'cc-segment-count', 'aria-hidden': 'true' })
    const segment = el(
      doc,
      'button',
      { type: 'button', class: 'cc-segment', 'data-section': section.id },
      [icon(doc, SECTION_GLYPH[section.id], 'cc-icon'), segmentCount],
    )
    segment.addEventListener('click', () => {
      intents.selectSection(section.id)
    })
    segmented.append(segment)

    const sectionHeading = el(doc, 'h3', { class: 'cc-section-title', id: headingId }, [
      section.label,
    ])
    const list = el(doc, 'ul', { class: 'cc-rows', 'aria-labelledby': headingId })
    // §8.5: the empty sentence leaves the screen and stays in the accessibility tree. It cannot
    // ride on the list's `aria-label` — `aria-labelledby` is already there and would shadow it —
    // so it is visually-hidden text inside the placeholder, which nothing can shadow.
    const emptyText = el(doc, 'span', { class: 'cc-vh' }, [section.empty])
    const empty = el(doc, 'p', { class: 'cc-empty' }, [
      icon(doc, SECTION_GLYPH[section.id], 'cc-empty-icon'),
      emptyText,
    ])
    const wrapper = el(doc, 'div', { class: 'cc-section', 'data-section': section.id }, [
      sectionHeading,
      list,
      empty,
    ])
    element.append(wrapper)
    parts.set(section.id, {
      wrapper,
      heading: sectionHeading,
      list,
      empty,
      emptyText,
      segment,
      segmentCount,
    })
  }

  /** §7 row 8 and §7's keyboard table: `←`/`→` walk the segments, no bare letters anywhere. */
  segmented.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    const current = order.findIndex((id) => parts.get(id)?.segment === doc.activeElement)
    const index = current === -1 ? order.indexOf(currentSection) : current
    const step = event.key === 'ArrowRight' ? 1 : -1
    const next = order[(index + step + order.length) % order.length]
    if (!next) return
    event.preventDefault()
    intents.selectSection(next)
    parts.get(next)?.segment.focus()
  })

  host.layer.append(toggle, element)
  host.anchor('panel-toggle', toggle)
  host.anchor('panel', element)

  let currentSection: PanelSection = order[0] ?? 'open'
  const chips = new WeakMap<HTMLElement, ChipSlot>()

  function createRow(row: PanelRowVM): HTMLElement {
    const label = el(doc, 'span', { class: 'cc-row-body' })
    const glyph = icon(doc, kindIcon(row.kind), 'cc-row-icon')
    const count = el(doc, 'span', { class: 'cc-row-count', 'aria-hidden': 'true' })
    // A documented narrowing of "chips live in an aria-live region": the SAME chip renders into
    // up to 3 slots at once (badge, popover, this row). Making all of them live would announce
    // one transition 3 times, so the two the user is looking at carry it and this one is silent.
    const slot = createChipSlot(doc, false)
    const meta = el(doc, 'span', { class: 'cc-row-meta' }, [glyph, count, slot])
    const main = el(
      doc,
      'button',
      { type: 'button', class: 'cc-row-main', 'data-thread': row.threadId },
      [meta, label],
    )
    main.addEventListener('click', () => {
      intents.openThread(row.threadId)
    })
    const node = el(doc, 'li', { class: 'cc-row', 'data-thread': row.threadId }, [
      main,
      el(doc, 'div', { class: 'cc-row-actions' }),
    ])
    chips.set(node, createChip(doc, slot))
    return node
  }

  function updateRow(node: HTMLElement, row: PanelRowVM, labels: Labels): void {
    const main = node.querySelector<HTMLButtonElement>('.cc-row-main')
    const label = node.querySelector<HTMLElement>('.cc-row-body')
    const glyph = node.querySelector('.cc-row-icon')
    const count = node.querySelector<HTMLElement>('.cc-row-count')
    const secondary = node.querySelector<HTMLElement>('.cc-row-actions')
    if (!main || !label || !glyph || !count || !secondary) return

    setText(label, row.body)
    setIcon(glyph, kindIcon(row.kind))
    // §10 keeps a per-row count, because a count is a *value* — the one class of string the
    // zero-text audit never cuts.
    setText(count, row.count >= 2 ? String(row.count) : '')
    setAttr(main, 'aria-label', row.ariaLabel)
    setAttr(main, 'title', row.title)
    setAttr(node, 'data-anchor', row.anchor)
    setAttr(node, 'data-status', row.status)
    setAttr(node, 'data-approximate', row.approximate ? 'true' : null)
    chips.get(node)?.render(row.chip)

    let button = secondary.querySelector<HTMLButtonElement>('button')
    if (!row.action) {
      button?.remove()
      return
    }
    if (!button) {
      button = el(doc, 'button', { type: 'button', class: 'cc-ghost' }, [
        icon(doc, 'cc-i-uturn', 'cc-icon'),
      ])
      secondary.append(button)
    }
    const action = row.action
    if (button.getAttribute('data-action') !== action) {
      setAttr(button, 'data-action', action)
      setAttr(button, 'data-variant', action === 'delete' ? 'danger' : null)
      setIcon(button, action === 'reopen' ? 'cc-i-uturn' : 'cc-i-trash')
      button.onclick = () => {
        if (action === 'reopen') intents.reopenThread(row.threadId)
        else intents.deleteThread(row.threadId)
      }
    }
    const name = action === 'reopen' ? labels.reopen : labels.delete
    setAttr(button, 'aria-label', name)
    setAttr(button, 'title', name)
  }

  function renderSection(
    part: SectionParts,
    section: PanelSectionVM,
    labels: Labels,
    reduced: boolean,
  ): void {
    setAttr(part.wrapper, 'data-current', section.current ? 'true' : 'false')
    setAttr(part.segment, 'aria-pressed', section.current ? 'true' : 'false')
    setAttr(part.segment, 'aria-label', section.label)
    setAttr(part.segment, 'title', section.label)
    roll(part.segmentCount, String(section.rows.length), reduced)
    setAttr(part.empty, 'hidden', section.rows.length > 0)
    setText(part.emptyText, section.empty)
    if (part.heading.firstChild) part.heading.firstChild.textContent = section.label
    if (section.current) currentSection = section.id
    reconcile(
      part.list,
      section.rows,
      (row) => row.threadId,
      (row) => createRow(row),
      (node, row) => {
        updateRow(node as HTMLElement, row, labels)
      },
      (node) => {
        chips.get(node as HTMLElement)?.destroy()
      },
    )
  }

  return {
    toggle,

    render(next, labels, rail, reduced) {
      setText(heading, next.title)
      setAttr(element, 'aria-label', next.title)
      setAttr(toggle, 'aria-label', next.title)
      setAttr(toggle, 'title', next.title)
      setAttr(closeButton, 'aria-label', labels.dismiss)
      setAttr(closeButton, 'title', labels.dismiss)
      setAttr(element, 'data-open', next.open ? 'true' : 'false')
      // Mutual exclusion without loss: a popover slides the sheet to a 44 px rail rather than
      // closing it, so reopening it costs nothing and the section you were reading survives.
      setAttr(element, 'data-rail', next.open && rail ? 'true' : null)
      setAttr(toggle, 'aria-expanded', next.open ? 'true' : 'false')
      // Zero threads is zero pixels — a CSS state, never the `hidden` attribute, because the
      // seed stays a focusable, nameable control for a keyboard user at all times.
      setAttr(toggle, 'data-count', next.total === 0 ? 'zero' : 'some')
      roll(seedCount, String(next.total), reduced)
      for (const section of next.sections) {
        const part = parts.get(section.id)
        if (part) renderSection(part, section, labels, reduced)
      }
    },

    proximity() {
      return [{ node: toggle, radius: 140 }]
    },

    destroy() {
      host.anchor('panel-toggle', null)
      host.anchor('panel', null)
      toggle.remove()
      element.remove()
    },
  }
}
