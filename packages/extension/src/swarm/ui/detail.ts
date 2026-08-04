/**
 * The delegation plane: objective, effective configuration, acceptance, attempts, comparison,
 * evidence — and, as a child of this surface rather than a second one, the follow-up bar.
 *
 * The law of done is what this surface renders (PRODUCT §4.3, VE1–VE4): `turn_done` is not
 * success, only the verifier or an explicit human verdict reaches `succeeded`, and a delegation
 * with zero criteria is `unverifiable` and can be closed **only** through `accept{note}`. So the
 * acceptance list is drawn even when it is empty (the empty case is the one that matters), the
 * accept control opens a note field rather than writing a verdict on click, and every attempt
 * carries its own verdict, evidence reference and cost.
 *
 * Three interrupts, three distinctly labelled actions (§5.3.8): **cancel turn** lives on the
 * follow-up bar because it is turn-scoped, **cancel delegation** and **hard kill** live here and
 * both arm. Nothing in this head can reach `cancelled` except `cancel{scope:'delegation'}` (D17),
 * and the kill switch says so in its own label.
 *
 * Parallel attempts (Q9, C12b, A5) are why the attempts panel is a list and not a tab bar: N
 * attempts run **concurrently**, each with its own session, worktree and channel, and the
 * comparison panel is the surface that makes that flagship loop worth its slots — "a flagship loop
 * with no comparison surface is a retry log".
 */

import type { SwarmHeadDelegationVM, SwarmHeadIntents, SwarmHeadViewModel } from '../types.ts'
import type { ArmRegistry } from './dom.ts'

import {
  duration,
  el,
  glyphButton,
  reconcile,
  segmented,
  setAttr,
  setSwitch,
  setText,
  switchControl,
  usd,
} from './dom.ts'
import { createFollowUpBar } from './followup.ts'
import { glyph, setGlyph } from './sprite.ts'
import { createTranscriptView } from './transcript.ts'

export interface DetailView {
  readonly node: HTMLElement
  render(vm: SwarmHeadViewModel): void
}

type AttemptVM = SwarmHeadDelegationVM['attempts'][number]
type ComparisonVM = SwarmHeadDelegationVM['comparison'][number]
type CriterionVM = SwarmHeadDelegationVM['acceptance'][number]

export function createDetailView(options: {
  doc: Document
  intents: SwarmHeadIntents
  arm: ArmRegistry
  /** Injected, as everywhere else in this head: a projection pass is a function of its inputs. */
  now: () => number
}): DetailView {
  const { doc, intents, arm } = options

  let id: string | null = null
  let landMode: 'commit' | 'patch' = 'commit'
  let acceptOpen = false

  const node = el(doc, 'div', 'cc-detail cc-glass')
  node.setAttribute('role', 'region')
  node.setAttribute('aria-label', 'delegation')

  /* §0 D6: no head, no title bar, no logo row — the close mark floats in the corner. */
  const corner = el(doc, 'div', 'cc-corner')
  corner.append(
    glyphButton(doc, {
      id: 'close',
      onPress: () => {
        intents.escape()
      },
    }),
  )

  const objective = el(doc, 'div', 'cc-objective cc-t15')
  const meta = el(doc, 'div', 'cc-meta-grid cc-t11')
  const state = chip(doc)
  const verdict = chip(doc)
  const base = chip(doc)
  const workspace = chip(doc)
  const budget = chip(doc)
  const effective = chip(doc)
  const flags = chip(doc)
  meta.append(
    state.node,
    verdict.node,
    base.node,
    workspace.node,
    budget.node,
    effective.node,
    flags.node,
  )

  /* ------------------------------------------------------------------- lifecycle controls */

  const controls = el(doc, 'div', 'cc-controls cc-t11')
  const dispatchLabel = el(doc, 'span', 'cc-muted', 'dispatch')
  const dispatch = switchControl(
    doc,
    'dispatch for this delegation — off stops new work; a turn in flight always finishes',
    (next) => {
      if (id !== null) intents.pauseDispatch(id, !next)
    },
  )
  const verify = glyphButton(doc, {
    id: 'verify',
    onPress: () => {
      if (id !== null) intents.verify(id)
    },
  })
  const accept = glyphButton(doc, {
    id: 'accept',
    onPress: () => {
      acceptOpen = !acceptOpen
      paint()
      if (acceptOpen) acceptNote.focus()
    },
  })
  const retry = glyphButton(doc, {
    id: 'retry',
    onPress: () => {
      if (id !== null) intents.retry(id)
    },
  })
  const reconcileButton = glyphButton(doc, {
    id: 'reconcile',
    onPress: () => {
      if (id !== null) intents.reconcile(id)
    },
  })
  const archive = glyphButton(doc, {
    id: 'archive',
    arm,
    onPress: () => {
      if (id !== null) intents.archive(id)
    },
  })
  const cancelDelegation = glyphButton(doc, {
    id: 'cancel-delegation',
    arm,
    onPress: () => {
      if (id !== null) intents.cancel(id, 'delegation')
    },
  })
  const hardKill = glyphButton(doc, {
    id: 'hard-kill',
    arm,
    onPress: () => {
      if (id !== null) intents.cancel(id, 'hard')
    },
  })
  controls.append(
    dispatchLabel,
    dispatch,
    verify,
    accept,
    retry,
    reconcileButton,
    archive,
    cancelDelegation,
    hardKill,
  )

  /* The human verdict (§4.3 rule 3): a note, an actor and a timestamp — never a click alone. */
  const acceptRow = el(doc, 'div', 'cc-compose-row')
  const acceptNote = el(doc, 'input', 'cc-field cc-t13')
  acceptNote.type = 'text'
  acceptNote.placeholder =
    'why this is done — recorded as the verdict, with your identity and the time'
  acceptNote.setAttribute('aria-label', 'acceptance note')
  const acceptSend = glyphButton(doc, {
    id: 'accept',
    tone: 'accent',
    onPress: submitAccept,
  })
  acceptSend.classList.add('cc-disc')
  acceptSend.dataset.affordance = 'accept-submit'
  acceptRow.append(acceptNote, acceptSend)
  acceptNote.addEventListener('input', () => {
    setAttr(acceptSend, 'data-ready', acceptNote.value.trim().length > 0 ? '1' : null)
  })
  acceptNote.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Enter') return
    event.preventDefault()
    submitAccept()
  })

  function submitAccept(): void {
    const note = acceptNote.value.trim()
    if (note.length === 0 || id === null) return
    intents.accept(id, note)
    acceptNote.value = ''
    setAttr(acceptSend, 'data-ready', null)
    acceptOpen = false
    paint()
  }

  /* ------------------------------------------------------------------------- the panels */

  const scroll = el(doc, 'div', 'cc-scroll')

  const acceptance = el(doc, 'section', 'cc-panel')
  const acceptanceHead = el(doc, 'div', 'cc-line')
  acceptanceHead.append(el(doc, 'h3', 'cc-section-title', 'acceptance'))
  const acceptanceEmpty = el(doc, 'div', 'cc-hint cc-t11')
  acceptanceEmpty.textContent =
    'no criteria — this delegation is unverifiable and can only be closed by an accepted verdict'
  const acceptanceList = el(doc, 'div')
  acceptance.append(acceptanceHead, acceptanceEmpty, acceptanceList)
  const criteria = new Map<string, { node: Element; render: (c: CriterionVM) => void }>()

  const attempts = el(doc, 'section', 'cc-panel')
  const attemptsHead = el(doc, 'div', 'cc-line')
  const landPicker = segmented(doc, 'how a landing is written', (value) => {
    landMode = value === 'patch' ? 'patch' : 'commit'
    paint()
  })
  attemptsHead.append(
    el(doc, 'h3', 'cc-section-title', 'attempts'),
    el(doc, 'span', 'cc-grow'),
    landPicker.node,
  )
  const attemptsList = el(doc, 'div')
  attempts.append(attemptsHead, attemptsList)
  const attemptRows = new Map<string, { node: Element; render: (a: AttemptVM) => void }>()

  const comparison = el(doc, 'section', 'cc-panel')
  comparison.append(el(doc, 'h3', 'cc-section-title', 'comparison'))
  const comparisonList = el(doc, 'div')
  comparison.append(comparisonList)
  const comparisonRows = new Map<string, { node: Element; render: (c: ComparisonVM) => void }>()

  const transcript = createTranscriptView({ doc, intents })

  scroll.append(acceptance, attempts, comparison, transcript.node)

  const followUp = createFollowUpBar({ doc, intents })

  node.append(corner, objective, meta, controls, acceptRow, scroll, followUp.node)

  let lastVm: SwarmHeadViewModel | null = null
  const paint = (): void => {
    if (lastVm !== null) render(lastVm)
  }

  function render(vm: SwarmHeadViewModel): void {
    lastVm = vm
    const focused = vm.focused
    setAttr(node, 'hidden', focused === null ? '' : null)
    followUp.render(vm)
    if (focused === null) {
      id = null
      return
    }
    id = focused.id

    setText(objective, focused.objective)
    state.set(focused.state, focused.needsYou ?? focused.bucket)
    verdict.set(
      focused.verdict ?? (focused.unverifiable ? 'unverifiable' : 'no verdict'),
      focused.verdict === null
        ? 'turn_done is not success: only the verifier or a written human verdict reaches succeeded'
        : `verdict: ${focused.verdict}`,
    )
    /* C4b: what the user typed and what it resolved to — both, because drift, verification and
     * landing all key off the sha and an unresolved ref silently disables all three. */
    base.set(
      `${focused.baseRef}@${focused.baseRevision.slice(0, 7)}`,
      `base ref ${focused.baseRef} resolved to ${focused.baseRevision}${focused.staleBase ? ' — the base has moved since' : ''}`,
    )
    workspace.set(`${focused.workspaceId} · ${focused.writeMode}`, 'workspace and write mode')
    budget.set(focused.budget.label, 'spend against the declared budget')
    effective.set(
      `${focused.effective.model} · ${focused.effective.reasoningEffort ?? 'unset'}`,
      focused.effective.inherited
        ? 'inherited — this turn ran under whatever the previous one set, because its delivery mode forbids a config change'
        : 'declared, never confirmed: the executor discards the applied effort and exposes no getter',
    )
    const flagWords = [
      focused.staleBase ? 'stale base' : '',
      focused.stalledForMs === null ? '' : `stalled ${duration(focused.stalledForMs)}`,
      focused.landed ? 'landed' : '',
    ].filter((word) => word.length > 0)
    flags.set(flagWords.join(' · '), 'facets the row badge cannot hold at once')
    setAttr(flags.node, 'hidden', flagWords.length === 0 ? '' : null)

    setSwitch(dispatch, !focused.paused)
    setAttr(acceptRow, 'hidden', acceptOpen ? null : '')

    reconcile(acceptanceList, focused.acceptance, (c) => c.id, createCriterion, criteria)
    setAttr(acceptanceEmpty, 'hidden', focused.acceptance.length === 0 ? null : '')

    landPicker.render(['commit', 'patch'], landMode, false)
    reconcile(attemptsList, focused.attempts, (a) => a.id, createAttempt, attemptRows)

    reconcile(comparisonList, focused.comparison, (c) => c.id, createComparison, comparisonRows)
    setAttr(comparison, 'hidden', focused.comparison.length === 0 ? '' : null)

    transcript.render(focused.transcript, options.now())
    if (focused.transcript.following) scroll.scrollTop = scroll.scrollHeight
  }

  return { node, render }

  function createCriterion(): { node: Element; render: (next: CriterionVM) => void } {
    const row = el(doc, 'div', 'cc-line cc-t12')
    const mark = glyph(doc, 'cc-i-tilde', 12)
    mark.classList.add('cc-mark')
    const label = el(doc, 'span', 'cc-grow')
    const status = el(doc, 'span', 'cc-t11 cc-muted')
    row.append(mark, label, status)
    return {
      node: row,
      render(next) {
        setGlyph(mark, criterionGlyph(next.status))
        setAttr(mark, 'data-status', next.status)
        setText(label, next.label)
        setText(status, next.status)
      },
    }
  }

  function createAttempt(attempt: AttemptVM): { node: Element; render: (next: AttemptVM) => void } {
    const row = el(doc, 'div', 'cc-line cc-attempt cc-t12')
    const number = el(doc, 'span', 'cc-num')
    const channel = el(doc, 'span', 'cc-t11 cc-muted')
    const now = el(doc, 'span', 'cc-t11 cc-muted cc-grow')
    const stats = el(doc, 'span', 'cc-t11 cc-muted cc-num')
    const evidence = el(doc, 'span', 'cc-t10 cc-muted')
    const cluster = el(doc, 'div', 'cc-cluster')
    const select = glyphButton(doc, {
      id: 'attempt-select',
      size: 12,
      onPress: () => {
        if (id !== null) intents.selectAttempt(id, attempt.id)
      },
    })
    const land = glyphButton(doc, {
      id: 'land',
      size: 12,
      onPress: () => {
        if (id !== null) intents.land(id, attempt.id, landMode)
      },
    })
    const branch = glyphButton(doc, {
      id: 'branch',
      size: 12,
      onPress: () => {
        intents.branch(attempt.id)
      },
    })
    const discard = glyphButton(doc, {
      id: 'discard',
      size: 12,
      arm,
      onPress: () => {
        intents.discard(attempt.id)
      },
    })
    cluster.append(select, land, branch, discard)
    row.append(number, channel, now, stats, evidence, cluster)
    row.addEventListener('click', () => {
      if (id !== null) intents.selectAttempt(id, attempt.id)
    })

    return {
      node: row,
      render(next) {
        setText(number, `#${next.attemptNo}`)
        setText(channel, next.live ? next.channel : next.outcome)
        row.classList.toggle('cc-live', next.live && next.channel === 'streaming')
        setText(now, next.nowDoing ?? '')
        setText(
          stats,
          `${next.turns} turns · ${next.toolCalls} tools · ${usd(next.estUsd)}${next.verdict === null ? '' : ` · ${next.verdict}`}`,
        )
        setText(evidence, next.evidenceRef === null ? '' : 'evidence')
        setAttr(evidence, 'title', next.evidenceRef ?? '')
        setAttr(evidence, 'hidden', next.evidenceRef === null ? '' : null)
        setAttr(row, 'aria-current', lastVm?.focused?.focusedAttemptId === next.id ? 'true' : null)
        setAttr(land, 'hidden', next.live ? '' : null)
      },
    }
  }

  function createComparison(): { node: Element; render: (next: ComparisonVM) => void } {
    const row = el(doc, 'div', 'cc-line cc-t12')
    const number = el(doc, 'span', 'cc-num')
    const verdictText = el(doc, 'span', 'cc-t11 cc-muted cc-grow')
    const stats = el(doc, 'span', 'cc-t11 cc-muted cc-num')
    const recommended = glyph(doc, 'cc-i-sparkle', 12)
    recommended.classList.add('cc-mark')
    recommended.setAttribute(
      'aria-label',
      'best passing attempt by criteria and cost — a suggestion, never a landing',
    )
    row.append(number, verdictText, stats, recommended)
    return {
      node: row,
      render(next) {
        setText(number, `#${next.attemptNo}`)
        setText(verdictText, next.verdict)
        setText(stats, `${next.filesChanged} files · ${usd(next.estUsd)}`)
        setAttr(recommended, 'hidden', next.recommended ? null : '')
      },
    }
  }
}

function chip(doc: Document): { node: HTMLElement; set(text: string, title: string): void } {
  const node = el(doc, 'span', 'cc-metric cc-t11')
  const value = el(doc, 'b')
  node.append(value)
  return {
    node,
    set(text, title) {
      setText(value, text)
      setAttr(node, 'title', title)
    },
  }
}

function criterionGlyph(status: string): 'cc-i-check' | 'cc-i-warn' | 'cc-i-pencil' | 'cc-i-tilde' {
  if (status === 'pass') return 'cc-i-check'
  if (status === 'fail' || status === 'error') return 'cc-i-warn'
  if (status === 'manual') return 'cc-i-pencil'
  return 'cc-i-tilde'
}
