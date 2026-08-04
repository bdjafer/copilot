/**
 * The composer — the product's front door (PRODUCT C1–C12b).
 *
 * It is DESIGN §0 D4's shape, applied to creation rather than to a reply: a **permanently
 * rendered, collapsed, single-line field at the bottom edge** of the fleet column, which expands
 * **in place** into the full form on focus. Never a second floating surface, never a modal, never a
 * dialog on a dialog — and it needs no "+" glyph, which matters because DESIGN locks the sprite at
 * eighteen marks and none of them is a plus.
 *
 * What it collects is exactly what §3.1's `DelegationSpec` needs and nothing more:
 *
 *  - **C1** objective — free text, required, and the only field that is.
 *  - **C2/C3** typed acceptance criteria, built one row at a time. Zero criteria is *allowed* and
 *    is drawn as what it means: `unverifiable`, closable only by a written verdict (Q1, D14). The
 *    empty trailing row is how a criterion is added — a growing list needs no add affordance.
 *  - **C4/C4b/C5** workspace id, base **ref expression** (never a sha — the server resolves it
 *    inside the create transaction and stores only the sha), and write mode.
 *  - **C7/C7b/Q18** model + effort seeded from `HealthVM.routes`, the picker's only source, with
 *    the effort ladder derived from the **selected route's** provider — not from the closed union,
 *    which would offer `xhigh` on a provider that has no such rung.
 *  - **C8** budgets, each with its declared breach action (`pause-dispatch`, never `kill`).
 *  - **C12b** parallel attempts, 1–3, because N attempts occupy N scheduler slots.
 *
 * `effortLadder` is imported from the client core deliberately: §1.1 exports the pure derivations
 * "a head may need to compute the same answer locally", and computing a ladder is the difference
 * between a picker that refuses your click and one that never offered the value.
 */

import { effortLadder } from '@astrale-os/swarm'

import type { SwarmHeadIntents, SwarmHeadViewModel } from '../types.ts'

import { el, glyphButton, reconcile, segmented, setAttr } from './dom.ts'

export interface ComposerView {
  readonly node: HTMLElement
  render(vm: SwarmHeadViewModel): void
}

interface CriterionDraft {
  key: string
  kind: 'command' | 'file' | 'manual'
  value: string
}

const WRITE_MODES = ['worktree', 'in-place']
const PARALLEL = ['1', '2', '3']

export function createComposer(options: {
  doc: Document
  intents: SwarmHeadIntents
}): ComposerView {
  const { doc, intents } = options

  let open = false
  let provider = ''
  let drafts: CriterionDraft[] = [{ key: 'c0', kind: 'command', value: '' }]
  let seq = 1
  let writeMode = 'worktree'
  let parallel = '1'
  let delivery = 'after-turn'
  let effort: string | null = null

  const node = el(doc, 'div', 'cc-compose')

  const row = el(doc, 'div', 'cc-compose-row')
  const objective = el(doc, 'textarea', 'cc-field cc-t13')
  objective.rows = 1
  objective.placeholder = 'what should be done, and what must be true when it is'
  objective.setAttribute('aria-label', 'objective')
  const submit = glyphButton(doc, { id: 'create', tone: 'accent', onPress: create })
  submit.classList.add('cc-disc')
  row.append(objective, submit)

  const more = el(doc, 'div', 'cc-compose-more cc-t11')

  /* ----------------------------------------------------------------- acceptance (C2, C3) */

  const acceptance = el(doc, 'div')
  const acceptanceHead = el(doc, 'div', 'cc-line')
  acceptanceHead.append(el(doc, 'h3', 'cc-section-title', 'acceptance'))
  const unverifiable = el(doc, 'span', 'cc-hint cc-t10')
  unverifiable.textContent = 'unverifiable — never auto-succeeds; only a written verdict closes it'
  acceptanceHead.append(unverifiable)
  const criterionList = el(doc, 'div')
  acceptance.append(acceptanceHead, criterionList)
  const criterionRows = new Map<string, { node: Element; render: (d: CriterionDraft) => void }>()

  /* ------------------------------------------------------------------ workspace (C4, C4b) */

  const workspaceRow = el(doc, 'div', 'cc-crit')
  const workspace = el(doc, 'input', 'cc-field cc-t12')
  workspace.setAttribute('aria-label', 'workspace id')
  workspace.placeholder = 'workspace id'
  workspace.setAttribute('list', 'cc-workspaces')
  const workspaceOptions = doc.createElement('datalist')
  workspaceOptions.id = 'cc-workspaces'
  const baseRef = el(doc, 'input', 'cc-field cc-t12')
  baseRef.setAttribute('aria-label', 'base ref expression')
  baseRef.placeholder = 'HEAD'
  baseRef.title =
    'a revision EXPRESSION — HEAD, a branch, a tag. The server resolves it to a full sha inside the create transaction and stores only the sha.'
  const writeModePicker = segmented(doc, 'write mode', (value) => {
    writeMode = value
    paint()
  })
  workspaceRow.append(workspace, workspaceOptions, baseRef, writeModePicker.node)

  /* ------------------------------------------------------------------ model + effort (C7) */

  const modelRow = el(doc, 'div', 'cc-crit')
  const model = el(doc, 'select', 'cc-field cc-t12')
  model.setAttribute('aria-label', 'model')
  model.addEventListener('change', () => {
    provider = model.selectedOptions[0]?.dataset.provider ?? provider
    effort = null
    paint()
  })
  const effortPicker = segmented(doc, 'default reasoning effort', (value) => {
    effort = value
    paint()
  })
  const declared = el(doc, 'span', 'cc-hint cc-t10', 'declared, not confirmed')
  declared.title =
    'the executor discards the applied effort and exposes no getter — this is intent, never observed state'
  const deliveryPicker = segmented(doc, 'default delivery mode', (value) => {
    delivery = value
    paint()
  })
  const parallelPicker = segmented(
    doc,
    'parallel attempts — N attempts occupy N scheduler slots',
    (value) => {
      parallel = value
      paint()
    },
  )
  modelRow.append(model, effortPicker.node, declared, deliveryPicker.node, parallelPicker.node)

  /* ------------------------------------------------------------------------ budgets (C8) */

  const budgetRow = el(doc, 'div', 'cc-crit')
  const wallMinutes = numberField(doc, 'wall minutes', '45')
  const maxTurns = numberField(doc, 'turns', '30')
  const maxToolCalls = numberField(doc, 'tool calls', '200')
  const maxSpend = numberField(doc, 'usd cap', '')
  const breach = el(doc, 'span', 'cc-hint cc-t10', 'on breach: pause dispatch')
  breach.title =
    'a hard breach pauses dispatch and never cancels a running turn — the in-flight turn still reaches turn_done'
  budgetRow.append(wallMinutes.node, maxTurns.node, maxToolCalls.node, maxSpend.node, breach)

  more.append(acceptance, workspaceRow, modelRow, budgetRow)
  node.append(row, more)

  objective.addEventListener('focus', () => {
    open = true
    paint()
  })
  objective.addEventListener('input', () => {
    objective.rows = Math.min(8, Math.max(2, objective.value.split('\n').length))
    setAttr(submit, 'data-ready', objective.value.trim().length > 0 ? '1' : null)
  })
  objective.addEventListener('keydown', (event) => {
    const key = event as KeyboardEvent
    if (key.key === 'Enter' && (key.metaKey || key.ctrlKey)) {
      event.preventDefault()
      create()
      return
    }
    /* §7's dismissal chain: `Esc` collapses the expanded field back to its rest state first, and
     * an empty draft is the only one that closes — the composer never loses your words. */
    if (key.key === 'Escape' && objective.value.length === 0) {
      open = false
      objective.rows = 1
      paint()
    }
  })

  function create(): void {
    const text = objective.value.trim()
    if (text.length === 0) return
    intents.create({
      objective: text,
      workspaceId: workspace.value.trim(),
      baseRef: baseRef.value.trim(),
      writeMode: writeMode === 'in-place' ? 'in-place' : 'worktree',
      acceptance: drafts
        .filter((draft) => draft.value.trim().length > 0)
        .map((draft) => ({ kind: draft.kind, label: '', value: draft.value.trim() })),
      provider,
      model: model.value,
      reasoningEffort: effort,
      delivery,
      parallelAttempts: parallel === '3' ? 3 : parallel === '2' ? 2 : 1,
      budget: {
        maxWallMs: Math.max(1, wallMinutes.value(45)) * 60_000,
        maxTurns: Math.max(1, maxTurns.value(30)),
        maxToolCalls: Math.max(1, maxToolCalls.value(200)),
        ...(maxSpend.raw().length === 0 ? {} : { maxSpendUsd: maxSpend.value(0) }),
      },
    })
    objective.value = ''
    objective.rows = 1
    setAttr(submit, 'data-ready', null)
    drafts = [{ key: `c${seq++}`, kind: 'command', value: '' }]
    open = false
    paint()
  }

  let lastVm: SwarmHeadViewModel | null = null
  const paint = (): void => {
    if (lastVm !== null) render(lastVm)
  }

  function render(vm: SwarmHeadViewModel): void {
    lastVm = vm
    setAttr(node, 'data-open', open ? '1' : null)

    /* E3: there is no `WorkspaceRegistration` on any view model — the allowlist lives in the
     * server's `config.json` — so the picker is seeded from the ids already in use and otherwise
     * accepts free text, with the server's `workspace_denied` as the authority. */
    const ids = vm.workspaces.map((entry) => entry.id)
    if (workspaceOptions.dataset.signature !== ids.join(' ')) {
      workspaceOptions.replaceChildren()
      for (const id of ids) {
        const option = doc.createElement('option')
        option.value = id
        workspaceOptions.append(option)
      }
      workspaceOptions.dataset.signature = ids.join(' ')
      if (workspace.value.length === 0 && ids[0] !== undefined) workspace.value = ids[0]
    }

    const signature = vm.health.routes.map((route) => `${route.provider}/${route.model}`).join(' ')
    if (model.dataset.signature !== signature) {
      model.replaceChildren()
      for (const route of vm.health.routes) {
        const option = el(
          doc,
          'option',
          undefined,
          route.available ? route.model : `${route.model} — ${route.detail}`,
        )
        option.value = route.model
        option.dataset.provider = route.provider
        option.disabled = !route.available
        model.append(option)
      }
      model.dataset.signature = signature
      provider = model.selectedOptions[0]?.dataset.provider ?? ''
    }

    writeModePicker.render(WRITE_MODES, writeMode, false)
    deliveryPicker.render(vm.deliveryModes, delivery, false)
    parallelPicker.render(PARALLEL, parallel, false)
    effortPicker.render(effortLadder(provider, model.value), effort, false)

    reconcile(
      criterionList,
      visibleDrafts(),
      (draft) => draft.key,
      createCriterionRow,
      criterionRows,
    )
    setAttr(
      unverifiable,
      'hidden',
      drafts.some((draft) => draft.value.trim().length > 0) ? '' : null,
    )
  }

  /** Always one empty trailing row: that row *is* the add affordance (§10 — no drawn verb). */
  function visibleDrafts(): CriterionDraft[] {
    const last = drafts[drafts.length - 1]
    if (last === undefined || last.value.trim().length > 0) {
      drafts = [...drafts, { key: `c${seq++}`, kind: 'command', value: '' }]
    }
    return drafts
  }

  function createCriterionRow(draft: CriterionDraft): {
    node: Element
    render: (next: CriterionDraft) => void
  } {
    const line = el(doc, 'div', 'cc-crit')
    const kind = segmented(doc, 'criterion kind', (value) => {
      draft.kind = value as CriterionDraft['kind']
      paint()
    })
    const value = el(doc, 'input', 'cc-field cc-t12')
    value.setAttribute('aria-label', 'criterion')
    const remove = glyphButton(doc, {
      id: 'criterion-remove',
      size: 12,
      onPress: () => {
        drafts = drafts.filter((entry) => entry.key !== draft.key)
        paint()
      },
    })
    value.addEventListener('input', () => {
      draft.value = value.value
      paint()
    })
    line.append(kind.node, value, remove)
    return {
      node: line,
      render(next) {
        kind.render(['command', 'file', 'manual'], next.kind, false)
        value.placeholder = PLACEHOLDER[next.kind]
        if (value.value !== next.value) value.value = next.value
        setAttr(remove, 'hidden', next.value.trim().length === 0 ? '' : null)
      },
    }
  }

  return { node, render }
}

const PLACEHOLDER: Record<CriterionDraft['kind'], string> = {
  command: 'a command that must exit 0',
  file: 'a path that must exist',
  manual: 'what a human must check',
}

function numberField(
  doc: Document,
  label: string,
  placeholder: string,
): { node: HTMLElement; value(fallback: number): number; raw(): string } {
  const wrap = el(doc, 'label', 'cc-metric cc-t11')
  const name = el(doc, 'span', 'cc-muted', label)
  const input = el(doc, 'input', 'cc-field cc-t12 cc-num')
  input.type = 'number'
  input.placeholder = placeholder
  input.style.inlineSize = '76px'
  input.setAttribute('aria-label', label)
  wrap.append(name, input)
  return {
    node: wrap,
    value(fallback) {
      const parsed = Number(input.value.length === 0 ? placeholder : input.value)
      return Number.isFinite(parsed) ? parsed : fallback
    },
    raw: () => input.value,
  }
}
