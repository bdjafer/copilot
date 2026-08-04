/**
 * The watch plane (PRODUCT W1, W2, W11, W12): the live transcript, keyed and incremental.
 *
 * Every entry the client core publishes is rendered, and each one is rendered as **what it is**:
 *
 *  - **W1** — reasoning is a separate channel and is collapsed by default. It is a `<details>`, so
 *    the collapse is the platform's: it survives a re-render, it is keyboard reachable, and it
 *    costs no state.
 *  - **W2** — the tool timeline is one line per call: name, target, status mark, duration; the
 *    output hangs under it. `callId` is the key, which is what makes two concurrent tools two rows
 *    rather than one interleaved smear ([F11] is the adapter's half of that promise).
 *  - **W11** — background progress is its **own plane** above the transcript, never merged into
 *    it, and it carries its provenance: the executor reverse-engineers it from prose and it may
 *    vanish without notice, so it must never read as state (#16).
 *  - **W12** — follow-tail is a switch, and it is off the moment the reader scrolls up. The
 *    transcript is the one stream §2.4 degrades under backpressure, so `lagged` is drawn as a
 *    warning line rather than as a gap in content.
 *
 * The list is keyed (`u:<turnId>`, `text:<at>`, `t:<callId>`, `b:<taskId>`) rather than rebuilt,
 * because text deltas coalesce into the *last* entry in place: a wholesale rebuild would rebuild
 * four hundred nodes for every delta of a streaming turn.
 */

import type { TranscriptEntry } from '@astrale-os/swarm'

import type { SwarmHeadIntents, SwarmHeadTranscriptVM } from '../types.ts'

import {
  duration,
  el,
  glyphButton,
  reconcile,
  relativeTime,
  setAttr,
  setSwitch,
  setText,
  switchControl,
} from './dom.ts'
import { glyph, setGlyph } from './sprite.ts'

export interface TranscriptView {
  readonly node: HTMLElement
  render(vm: SwarmHeadTranscriptVM, now: number): void
}

interface Row {
  node: Element
  render: (entry: Keyed) => void
}

interface Keyed {
  readonly key: string
  readonly entry: TranscriptEntry
  readonly now: number
}

export function createTranscriptView(options: {
  doc: Document
  intents: SwarmHeadIntents
}): TranscriptView {
  const { doc, intents } = options

  const node = el(doc, 'section', 'cc-panel')
  const head = el(doc, 'div', 'cc-line cc-t11')
  const title = el(doc, 'h3', 'cc-section-title', 'transcript')
  const spacer = el(doc, 'span', 'cc-grow')
  const lagged = el(doc, 'span', 'cc-lagged cc-t11')
  lagged.append(
    glyph(doc, 'cc-i-warn', 12),
    doc.createTextNode(
      'lagged — entries were dropped under backpressure; re-subscribe from a snapshot to fill the gap',
    ),
  )
  const older = glyphButton(doc, {
    id: 'older',
    size: 12,
    onPress: () => {
      intents.loadOlder()
    },
  })
  const followLabel = el(doc, 'span', 'cc-muted', 'follow')
  const follow = switchControl(
    doc,
    'follow the tail — off pins the scroll where you left it',
    (next) => {
      intents.followTranscript(next)
    },
  )
  head.append(title, spacer, lagged, older, followLabel, follow)

  /* W11: its own plane. Never a transcript entry, never state. */
  const background = el(doc, 'div', 'cc-background cc-t11')
  const backgroundRows = new Map<string, Row>()

  const list = el(doc, 'div', 'cc-transcript')
  list.setAttribute('role', 'log')
  list.setAttribute('aria-live', 'polite')
  const rows = new Map<string, Row>()

  node.append(head, background, list)

  return {
    node,
    render(vm, now) {
      setAttr(lagged, 'hidden', vm.lagged ? null : '')
      setAttr(older, 'hidden', vm.hasOlder ? null : '')
      setSwitch(follow, vm.following)

      const keyed = vm.entries.map((entry, index) => ({ key: keyOf(entry, index), entry, now }))
      reconcile(
        background,
        keyed.filter((item) => item.entry.k === 'background'),
        (item) => item.key,
        createRow,
        backgroundRows,
      )
      reconcile(
        list,
        keyed.filter((item) => item.entry.k !== 'background'),
        (item) => item.key,
        createRow,
        rows,
      )
      setAttr(background, 'hidden', backgroundRows.size === 0 ? '' : null)
    },
  }

  function createRow(item: Keyed): Row {
    switch (item.entry.k) {
      case 'user':
        return createUserRow()
      case 'reasoning':
        return createReasoningRow()
      case 'tool':
        return createToolRow()
      case 'background':
        return createBackgroundRow()
      case 'usage':
        return createUsageRow()
      case 'notice':
        return createNoticeRow()
      default:
        return createTextRow()
    }
  }

  function createTextRow(): Row {
    const wrap = el(doc, 'div', 'cc-entry')
    wrap.dataset.k = 'text'
    const body = el(doc, 'div', 'cc-entry-body cc-t13')
    wrap.append(body)
    return {
      node: wrap,
      render(item) {
        if (item.entry.k !== 'text') return
        setText(body, item.entry.text)
      },
    }
  }

  function createUserRow(): Row {
    const wrap = el(doc, 'div', 'cc-entry')
    wrap.dataset.k = 'user'
    /* §0 D2: the header row is permanent and is the first thing in the row. */
    const header = el(doc, 'div', 'cc-entry-head cc-t11')
    const time = el(doc, 'span', 'cc-num')
    const images = el(doc, 'span', 'cc-num')
    header.append(time, images)
    const body = el(doc, 'div', 'cc-entry-body cc-t13')
    wrap.append(header, body)
    return {
      node: wrap,
      render(item) {
        if (item.entry.k !== 'user') return
        setText(time, relativeTime(item.entry.at, item.now))
        /* Hover ADDS the absolute datetime; it never restores something that was withheld. */
        setAttr(time, 'title', new Date(item.entry.at).toISOString())
        setText(images, item.entry.images > 0 ? `${item.entry.images} images` : '')
        setAttr(images, 'hidden', item.entry.images > 0 ? null : '')
        setText(body, item.entry.text)
      },
    }
  }

  function createReasoningRow(): Row {
    const wrap = doc.createElement('details')
    wrap.className = 'cc-entry'
    wrap.dataset.k = 'reasoning'
    const summary = doc.createElement('summary')
    summary.className = 'cc-t11'
    summary.append(glyph(doc, 'cc-i-chevron', 12), doc.createTextNode('reasoning'))
    const body = el(doc, 'div', 'cc-entry-body cc-t13 cc-muted')
    wrap.append(summary, body)
    return {
      node: wrap,
      render(item) {
        if (item.entry.k !== 'reasoning') return
        setText(body, item.entry.text)
      },
    }
  }

  function createToolRow(): Row {
    const wrap = el(doc, 'div', 'cc-entry')
    wrap.dataset.k = 'tool'
    const mark = glyph(doc, 'cc-i-arc', 12)
    mark.classList.add('cc-mark')
    const name = el(doc, 'span', 'cc-t12')
    const target = el(doc, 'span', 'cc-t11 cc-muted cc-grow')
    const took = el(doc, 'span', 'cc-t11 cc-muted cc-num')
    const output = el(doc, 'div', 'cc-tool-out cc-t11')
    wrap.append(mark, name, target, took, output)
    return {
      node: wrap,
      render(item) {
        if (item.entry.k !== 'tool') return
        const entry = item.entry
        setGlyph(
          mark,
          entry.status === 'done'
            ? 'cc-i-check'
            : entry.status === 'error'
              ? 'cc-i-warn'
              : 'cc-i-arc',
        )
        setAttr(
          mark,
          'data-status',
          entry.status === 'done' ? 'pass' : entry.status === 'error' ? 'fail' : null,
        )
        mark.classList.toggle('cc-live', entry.status === 'start' || entry.status === 'exec')
        setText(name, entry.name)
        setText(target, entry.target ?? '')
        setText(took, entry.durationMs === null ? '' : duration(entry.durationMs))
        setText(output, entry.output ?? '')
        setAttr(output, 'hidden', entry.output === null ? '' : null)
      },
    }
  }

  function createBackgroundRow(): Row {
    const wrap = el(doc, 'div', 'cc-line cc-t11')
    const label = el(doc, 'span', 'cc-grow')
    const bar = el(doc, 'div', 'cc-bar')
    bar.style.inlineSize = '80px'
    const provenance = el(doc, 'span', 'cc-hint cc-t10')
    wrap.append(label, bar, provenance)
    return {
      node: wrap,
      render(item) {
        if (item.entry.k !== 'background') return
        setText(label, item.entry.label)
        const percent = item.entry.percent ?? 0
        bar.style.scale = `${Math.max(0.02, Math.min(1, percent / 100))} 1`
        /* #16: provenance is drawn, because this event is scraped from prose and may disappear. */
        setText(provenance, item.entry.provenance)
        setAttr(
          provenance,
          'title',
          'reverse-engineered by the executor from prose — never feeds state, budget or completion',
        )
      },
    }
  }

  function createUsageRow(): Row {
    const wrap = el(doc, 'div', 'cc-entry-head cc-t11 cc-num')
    return {
      node: wrap,
      render(item) {
        if (item.entry.k !== 'usage') return
        setText(wrap, `${item.entry.input} in · ${item.entry.output} out`)
      },
    }
  }

  function createNoticeRow(): Row {
    const wrap = el(doc, 'div', 'cc-entry-head cc-t11')
    return {
      node: wrap,
      render(item) {
        if (item.entry.k !== 'notice') return
        setText(wrap, item.entry.text)
      },
    }
  }
}

/**
 * Stable within the sliding window: text and reasoning coalesce into the *last* entry keeping the
 * first delta's `at`, so `(kind, at)` names one growing paragraph rather than one delta.
 */
function keyOf(entry: TranscriptEntry, index: number): string {
  switch (entry.k) {
    case 'user':
      return `u:${entry.turnId}`
    case 'text':
      return `x:${entry.at}`
    case 'reasoning':
      return `r:${entry.at}`
    case 'tool':
      return `t:${entry.callId}`
    case 'background':
      return `b:${entry.taskId}`
    default:
      return `i:${index}`
  }
}
