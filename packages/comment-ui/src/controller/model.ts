/**
 * `engine.threads` / `engine.placement` / `engine.modes` + the controller's five state slots →
 * a frozen, referentially stable `UIViewModel` (§3.1.2). **Every §3 visibility, section, label
 * and marker rule lives here, once.**
 *
 * Four properties are load-bearing and each is enforced by a test:
 *
 *  - **Serializable.** No functions, no DOM nodes, no `Range`, no class instances — the model is
 *    `structuredClone`-able, which is what makes a worker-, iframe- or wire-hosted presentation
 *    possible and what mechanically prevents smuggling an `Element` across the seam.
 *  - **Frozen**, recursively.
 *  - **Referentially stable.** A member that did not change keeps its identity between
 *    publications, so `===` memoisation in a presentation is correct without selectors — the
 *    same rule `ThreadView` already lives under.
 *  - **Pre-resolved.** Mode labels, `aria-label`s, chip defaults, the 160-char quote, section
 *    assignment and `approximate` are computed here. A presentation cannot re-derive them: it
 *    has no mode list, no `ThreadView` and no engine.
 */

import type { Mode, PlacementState, ThreadView } from '@astrale-os/comment-core'

import type {
  BadgeVM,
  ChipVM,
  CommentVM,
  ComposerVM,
  FocusTarget,
  Labels,
  PanelRowVM,
  PanelSection,
  PanelSectionVM,
  PanelVM,
  PickerVM,
  Rect,
  ThreadVM,
  UIViewModel,
} from '../presentation.ts'
import type { Decoration, ResolvedOptions } from '../types.ts'

/** §3: "approximately re-anchored" marker when the winning confidence is below 0.85. */
export const APPROXIMATE_BELOW = 0.85

/** The quote and the panel row's `title` both show the capture's first 160 characters. */
const QUOTE_LIMIT = 160

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

/**
 * The five state slots §3 allows the UI to own — which panel section is open, which thread
 * popover is open, the `decorate()` map (held beside this, as a `Map`), the comment being
 * edited inline, and where focus returns to — plus the two derived signals the controller
 * publishes. Mutated by `controller/intents.ts` and the render pass, nowhere else.
 */
export interface UISlots {
  activeId: string | null
  panelOpen: boolean
  section: PanelSection | null
  editing: { threadId: string; commentId: string } | null
  announce: string
  focus: { seq: number; target: FocusTarget } | null
}

/** Everything the model reads: the slots plus a fresh read of the engine, once per pass. */
export interface ControllerState extends UISlots {
  readonly options: ResolvedOptions
  readonly win: Window
  readonly modes: readonly Mode[]
  readonly views: readonly ThreadView[]
  readonly placement: PlacementState
  readonly decorations: ReadonlyMap<string, Decoration>
  /** Thread ids the off-screen skip currently considers invisible. */
  readonly offscreen: ReadonlySet<string>
  placementOf(key: string): string | null
}

export function isApproximate(view: ThreadView): boolean {
  return view.anchoring.status === 'anchored' && view.anchoring.confidence < APPROXIMATE_BELOW
}

/** §3: `pending` draws nothing, resolved is hidden unless asked for, orphan mode decides docks. */
export function badgeVisible(options: ResolvedOptions, view: ThreadView): boolean {
  const status = view.anchoring.status
  if (status === 'pending') return false
  if (view.isResolved && !options.badge.showResolved) return false
  if (status === 'orphaned') {
    return options.badge.orphaned === 'dock' && view.anchoring.rect !== null
  }
  return true
}

/** §3: pending is in no section; otherwise resolved wins over orphaned wins over open. */
export function sectionOf(view: ThreadView): PanelSection | null {
  if (view.anchoring.status === 'pending') return null
  if (view.isResolved) return 'resolved'
  if (view.isOrphaned) return 'unanchored'
  return 'open'
}

/* ---------------------------------------------------- referential stability primitives */

function sameShallow(previous: object, next: object): boolean {
  const keys = Object.keys(next)
  if (keys.length !== Object.keys(previous).length) return false
  const before = previous as Record<string, unknown>
  const after = next as Record<string, unknown>
  for (const key of keys) if (!Object.is(before[key], after[key])) return false
  return true
}

/** Reuse the previous frozen object when nothing observable changed. */
function stable<T extends object>(previous: T | null | undefined, next: T): T {
  if (previous && sameShallow(previous, next)) return previous
  return Object.freeze(next)
}

function stableList<T>(
  previous: readonly T[] | null | undefined,
  next: readonly T[],
): readonly T[] {
  if (previous && previous.length === next.length) {
    let identical = true
    for (let i = 0; i < next.length; i += 1) {
      if (previous[i] !== next[i]) {
        identical = false
        break
      }
    }
    if (identical) return previous
  }
  return Object.freeze(next)
}

/* ------------------------------------------------------------------------------ ordering */

/** `Node.DOCUMENT_POSITION_FOLLOWING` — spelled as a literal so this file needs no DOM global. */
const FOLLOWING = 4

/**
 * §3.1.2 "ordered": badges follow document order of the anchored elements, docked orphans last
 * by creation time. Document order is what makes a staggered reveal read top-to-bottom instead
 * of in whatever sequence the store happened to load.
 */
function orderBadges(views: readonly ThreadView[]): ThreadView[] {
  const live: ThreadView[] = []
  const docked: ThreadView[] = []
  for (const view of views) (view.anchoring.element ? live : docked).push(view)
  live.sort((a, b) => {
    const left = a.anchoring.element
    const right = b.anchoring.element
    if (!left || !right || left === right) return 0
    return (left.compareDocumentPosition(right) & FOLLOWING) !== 0 ? -1 : 1
  })
  docked.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
  return [...live, ...docked]
}

/* -------------------------------------------------------------------------------- builder */

interface Cache {
  vm: UIViewModel | null
  badges: Map<string, BadgeVM>
  chips: Map<string, ChipVM>
  rects: Map<string, Rect>
  comments: Map<string, CommentVM>
  rows: Map<string, PanelRowVM>
  sections: Map<PanelSection, PanelSectionVM>
  thread: ThreadVM | null
  threadActions: ThreadVM['actions'] | null
  composer: ComposerVM | null
  picker: PickerVM | null
  panel: PanelVM | null
  focus: UIViewModel['focus']
}

export interface ModelBuilder {
  build(state: ControllerState): UIViewModel
  /** The badges the last build considered visible, in publication order. */
  visible(): readonly ThreadView[]
}

export function createModelBuilder(): ModelBuilder {
  const cache: Cache = {
    vm: null,
    badges: new Map(),
    chips: new Map(),
    rects: new Map(),
    comments: new Map(),
    rows: new Map(),
    sections: new Map(),
    thread: null,
    threadActions: null,
    composer: null,
    picker: null,
    panel: null,
    focus: null,
  }
  let seq = 0
  let visibleViews: readonly ThreadView[] = []

  return {
    visible: () => visibleViews,

    build(state) {
      const { options } = state
      const { labels } = options
      const modeOf = (kind: string): Mode | undefined =>
        state.modes.find((mode) => mode.kind === kind)
      // A thread whose kind is no longer in `modes` renders with default chrome (§2.11).
      const modeLabel = (kind: string): string => modeOf(kind)?.badge?.label ?? kind
      const nameOf = (view: ThreadView): string =>
        `${modeLabel(view.kind)} (${String(view.comments.length)})`

      const chipOf = (threadId: string, key: string): ChipVM | null => {
        const chip = state.decorations.get(threadId)?.chip
        if (!chip) return null
        return stable(cache.chips.get(key), {
          text: chip.text,
          tone: chip.tone ?? 'neutral',
          spinner: chip.spinner ?? false,
        })
      }
      const nextChips = new Map<string, ChipVM>()
      const keepChip = (key: string, chip: ChipVM | null): ChipVM | null => {
        if (chip) nextChips.set(key, chip)
        return chip
      }

      const rectOf = (key: string, view: ThreadView): Rect | null => {
        const element = view.anchoring.element
        if (element) {
          try {
            const box = element.getBoundingClientRect()
            return stable(cache.rects.get(key), {
              x: box.left,
              y: box.top,
              width: box.width,
              height: box.height,
            })
          } catch {
            return null
          }
        }
        const docked = view.anchoring.rect
        if (!docked) return null
        return stable(cache.rects.get(key), {
          x: docked.left - (state.win.scrollX || 0),
          y: docked.top - (state.win.scrollY || 0),
          width: docked.width,
          height: docked.height,
        })
      }
      const nextRects = new Map<string, Rect>()

      /* ------------------------------------------------------------------------- badges */

      const visible = orderBadges(state.views.filter((view) => badgeVisible(options, view)))
      visibleViews = visible
      const nextBadges = new Map<string, BadgeVM>()
      const badges: BadgeVM[] = []
      for (const view of visible) {
        const decoration = state.decorations.get(view.id)
        const approximate = isApproximate(view)
        const rect = rectOf(view.id, view)
        if (rect) nextRects.set(view.id, rect)
        const badge: BadgeVM = {
          threadId: view.id,
          kind: view.kind,
          label: modeLabel(view.kind),
          icon: modeOf(view.kind)?.badge?.icon ?? null,
          count: view.comments.length,
          anchor: view.anchoring.status,
          resolved: view.isResolved,
          orphaned: view.isOrphaned,
          approximate,
          docked: view.anchoring.element === null,
          offscreen: state.offscreen.has(view.id) && state.activeId !== view.id,
          open: state.activeId === view.id,
          tone: decoration?.tone ?? 'default',
          title: decoration?.title ?? (approximate ? labels.approximate : null),
          ariaLabel: nameOf(view),
          chip: keepChip(view.id, chipOf(view.id, view.id)),
          rect,
          placement: state.placementOf(`badge:${view.id}`),
        }
        const kept = stable(cache.badges.get(view.id), badge)
        nextBadges.set(view.id, kept)
        badges.push(kept)
      }

      /* ------------------------------------------------------------------- thread popover */

      const openView =
        state.activeId === null
          ? null
          : (state.views.find((view) => view.id === state.activeId) ?? null)
      // A pending thread renders nothing anywhere (§3), popover included.
      const threadView = openView && openView.anchoring.status !== 'pending' ? openView : null
      const nextComments = new Map<string, CommentVM>()
      let thread: ThreadVM | null = null
      if (threadView) {
        const approximate = isApproximate(threadView)
        const comments: CommentVM[] = threadView.comments.map((comment) => {
          const next: CommentVM = {
            id: comment.id,
            author: comment.author,
            body: comment.body,
            createdAt: comment.createdAt,
            editedAt: comment.editedAt,
            editing:
              state.editing !== null &&
              state.editing.threadId === threadView.id &&
              state.editing.commentId === comment.id,
          }
          const kept = stable(cache.comments.get(comment.id), next)
          nextComments.set(comment.id, kept)
          return kept
        })
        const quote = threadView.isOrphaned ? threadView.capture.text.slice(0, QUOTE_LIMIT) : ''
        const actions = stable(cache.threadActions, {
          reply: true,
          resolve: !threadView.isResolved,
          reopen: threadView.isResolved,
          delete: true,
        })
        cache.threadActions = actions
        thread = stable(cache.thread, {
          threadId: threadView.id,
          kind: threadView.kind,
          label: modeLabel(threadView.kind),
          ariaLabel: nameOf(threadView),
          status: threadView.status,
          anchor: threadView.anchoring.status,
          resolved: threadView.isResolved,
          orphaned: threadView.isOrphaned,
          approximate,
          title: approximate ? labels.approximate : null,
          quote: quote === '' ? null : quote,
          chip: keepChip(
            `thread:${threadView.id}`,
            chipOf(threadView.id, `thread:${threadView.id}`),
          ),
          comments: stableList(cache.thread?.comments, comments),
          actions,
        })
      }

      /* ------------------------------------------------------------ composer and picker */

      const placement = state.placement
      let composer: ComposerVM | null = null
      if (placement.phase === 'composing' || placement.phase === 'submitting') {
        const busy = placement.phase === 'submitting'
        composer = stable(cache.composer, {
          kind: placement.kind,
          draft: placement.draft,
          busy,
          replyTo: placement.replyTo,
          canSubmit: !busy && placement.draft.trim() !== '',
          placeholder: labels.placeholder,
        })
      }

      let picker: PickerVM | null = null
      if (placement.phase === 'picking') {
        const candidate = placement.candidate
        let rect: Rect | null = null
        if (candidate) {
          try {
            const box = candidate.getBoundingClientRect()
            rect = stable(cache.picker?.rect, {
              x: box.left,
              y: box.top,
              width: box.width,
              height: box.height,
            })
          } catch {
            rect = null
          }
        }
        picker = stable(cache.picker, { kind: placement.kind, rect, hint: labels.pickHint })
      }

      /* -------------------------------------------------------------------------- panel */

      const nextRows = new Map<string, PanelRowVM>()
      const nextSections = new Map<PanelSection, PanelSectionVM>()
      let panel: PanelVM | null = null
      if (options.panel.enabled) {
        const buckets = new Map<PanelSection, ThreadView[]>()
        for (const section of options.panel.sections) buckets.set(section, [])
        let total = 0
        for (const view of state.views) {
          const section = sectionOf(view)
          if (!section) continue
          // `'hidden'` orphan mode removes them from the page *and* the panel, which is the
          // only reading that distinguishes it from `'panel-only'`.
          if (section === 'unanchored' && options.badge.orphaned === 'hidden') continue
          const bucket = buckets.get(section)
          if (!bucket) continue
          bucket.push(view)
          if (section === 'open') total += 1
        }

        const sections: PanelSectionVM[] = []
        for (const id of options.panel.sections) {
          const rows: PanelRowVM[] = (buckets.get(id) ?? []).map((view) => {
            const key = `${id}:${view.id}`
            const next: PanelRowVM = {
              threadId: view.id,
              kind: view.kind,
              label: modeLabel(view.kind),
              ariaLabel: nameOf(view),
              body: view.lastComment.body,
              count: view.comments.length,
              anchor: view.anchoring.status,
              approximate: isApproximate(view),
              status: view.status,
              title: view.capture.text.slice(0, QUOTE_LIMIT),
              // Resolved rows offer the reopen the hidden badge cannot; unanchored rows discard.
              chip: keepChip(key, chipOf(view.id, key)),
              action: id === 'resolved' ? 'reopen' : id === 'unanchored' ? 'delete' : null,
            }
            const kept = stable(cache.rows.get(key), next)
            nextRows.set(key, kept)
            return kept
          })
          const section = stable(cache.sections.get(id), {
            id,
            label: labels[SECTION_LABEL[id]],
            empty: labels[SECTION_EMPTY[id]],
            current: state.section === id,
            rows: stableList(cache.sections.get(id)?.rows, rows),
          })
          nextSections.set(id, section)
          sections.push(section)
        }

        panel = stable(cache.panel, {
          open: state.panelOpen,
          title: labels.panelTitle,
          corner: options.panel.corner,
          total,
          sections: stableList(cache.panel?.sections, sections),
        })
      }

      /* --------------------------------------------------------------------- assembly */

      const focus = state.focus
        ? stable(cache.focus, {
            seq: state.focus.seq,
            target: stable(cache.focus?.target, { ...state.focus.target }) as FocusTarget,
          })
        : null

      seq += 1
      const vm: UIViewModel = Object.freeze({
        seq,
        labels,
        badges: stableList(cache.vm?.badges, badges),
        thread,
        composer,
        picker,
        panel,
        announce: state.announce,
        focus,
      })

      cache.vm = vm
      cache.badges = nextBadges
      cache.chips = nextChips
      cache.rects = nextRects
      cache.comments = nextComments
      cache.rows = nextRows
      cache.sections = nextSections
      cache.thread = thread
      cache.composer = composer
      cache.picker = picker
      cache.panel = panel
      cache.focus = focus
      return vm
    },
  }
}
