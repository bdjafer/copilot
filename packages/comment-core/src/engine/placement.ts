/**
 * Placement + composer (§2.12, §4.5) — one state machine, so `comment-ui`, the demo and a
 * custom React host get byte-identical behavior (decision log #21).
 *
 * Two rules from §2.12 shape everything here: **nothing is persisted before `submit()`
 * resolves**, and **user-flow rejections are not errors** — pressing the trigger key twice is
 * an interaction, not a fault, so it emits `placement:rejected`, never `error`. The one
 * exception is `unknown_kind`, which is a programming mistake and emits both (§4.1 rule 17).
 */

import type { AnchorDescriptor, ElementCapture, WriteResult } from '../types.ts'
import type {
  CommentEventMap,
  CommentEventName,
  Mode,
  PlacementController,
  PlacementState,
  PlacementTarget,
  TriggerSpec,
} from './types.ts'

import { assessTarget } from '../anchor/assess.ts'
import { isElement, isRange, isSelection } from '../anchor/dom.ts'
import { CommentError } from '../errors.ts'
import { readonlyStore, writable } from '../readable.ts'

const IDLE: PlacementState = Object.freeze({ phase: 'idle' })

/** A viewport coordinate, as the pick handlers and `PlacementTarget` spell it. */
export interface ClickPoint {
  readonly clientX: number
  readonly clientY: number
}

export interface PlacementDeps {
  document: () => Document | null
  modes: () => readonly Mode[]
  emit: <E extends CommentEventName>(event: E, payload: CommentEventMap[E]) => void
  emitError: (error: CommentError, phase: 'placement' | 'trigger', threadId?: string) => void
  /**
   * `point` is the click that ended the pick (§4.5, decision log #42). It reaches `captureTarget`
   * unchanged, which runs `assessTarget` and stores `AnchorDescriptor.point` relative to whatever
   * element it chose.
   */
  capture: (
    target: Element | Range,
    point?: ClickPoint,
  ) => { anchor: AnchorDescriptor; capture: ElementCapture }
  /** The mode kind a reply inherits from its thread, or null when the thread is unknown. */
  kindOfThread: (threadId: string) => string | null
  submitNew: (input: {
    kind: string
    anchor: AnchorDescriptor
    capture: ElementCapture
    body: string
  }) => Promise<WriteResult>
  submitReply: (threadId: string, body: string) => Promise<WriteResult>
  /** Called from the trigger handlers so a URL change is seen with no extra timer (§4.6.6). */
  tick: () => void
  /** False once the engine is destroyed (§4.4: post-`destroy()` calls no-op or reject). */
  alive: () => boolean
}

export interface PlacementInternals extends PlacementController {
  /** Attach the §4.5 keyboard / hover / pick listeners. */
  attach(): void
  detach(): void
  /** The element the `hover` interaction places on. */
  lastHovered(): Element | null
  /** Re-read `modes()` after `setModes` — cancels any in-flight placement. */
  refreshModes(): void
}

function hasModifier(trigger: TriggerSpec): boolean {
  const m = trigger.modifiers
  return Boolean(m && (m.alt || m.ctrl || m.meta || m.shift))
}

function matchesTrigger(event: KeyboardEvent, trigger: TriggerSpec): boolean {
  if ((event.key ?? '').toLowerCase() !== trigger.key.toLowerCase()) return false
  const m = trigger.modifiers ?? {}
  return (
    event.altKey === Boolean(m.alt) &&
    event.ctrlKey === Boolean(m.ctrl) &&
    event.metaKey === Boolean(m.meta) &&
    event.shiftKey === Boolean(m.shift)
  )
}

/** §4.5: a bare-letter trigger is ignored in an input, a textarea or a contenteditable. */
export function isEditableTarget(node: unknown): boolean {
  if (!isElement(node)) return false
  const tag = node.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return (node as HTMLElement).isContentEditable === true
}

/** §4.5: the real focus element is `composedPath()[0]`, not the retargeted `event.target`. */
function realTarget(event: Event): unknown {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  return path[0] ?? event.target
}

function liveSelectionRange(doc: Document | null): Range | null {
  try {
    const selection = doc?.getSelection?.()
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null
    const range = selection.getRangeAt(0)
    return range.toString().trim() === '' ? null : range
  } catch {
    return null
  }
}

export function createPlacementController(deps: PlacementDeps): PlacementInternals {
  const state = writable<PlacementState>(IDLE)
  const view = readonlyStore(state)

  let pendingAnchor: AnchorDescriptor | null = null
  let inflight: Promise<WriteResult> | null = null
  let hovered: Element | null = null
  /** §4.5: the hover interaction places on the tracker's last known coordinates. */
  let hoveredPoint: ClickPoint | null = null
  let frame: number | null = null
  /**
   * One placement flow = one `placement:start` … one `placement:end`. §4.2.9's `placed` /
   * `cancelled` pair is exclusive per flow, so a `cancel()` (Esc reaches this from
   * `submitting`) has to invalidate the in-flight submission's own terminal event rather than
   * letting both land for a single submission.
   */
  let flow = 0
  const disposers: Array<() => void> = []

  const modeFor = (kind: string): Mode | undefined => deps.modes().find((m) => m.kind === kind)

  function interactionOf(mode: Mode): 'pick' | 'hover' {
    return mode.trigger === false || !mode.trigger ? 'pick' : (mode.trigger.interaction ?? 'pick')
  }

  function reject(kind: string, reason: 'busy' | 'no_target' | 'unknown_kind'): false {
    deps.emit('placement:rejected', { kind, reason })
    // §2.12: only `unknown_kind` is also a fault — the other two are ordinary interactions.
    if (reason === 'unknown_kind') {
      deps.emitError(new CommentError('unknown_kind', `unknown mode kind "${kind}"`), 'placement')
    }
    return false
  }

  /**
   * @param interaction `null` ⇒ this flow already emitted its `placement:start` (the `pick`
   * flow emits on entering `picking`, and §4.2.9 describes exactly one `placement:start` →
   * composer → `placement:end` per placement — not one per state transition).
   */
  function compose(
    kind: string,
    target: Element | Range,
    replyTo: string | null,
    interaction: 'pick' | 'hover' | 'direct' | null,
    point: ClickPoint | null = null,
  ): boolean {
    const captured = deps.capture(target, point ?? undefined)
    pendingAnchor = captured.anchor
    const picked = isRange(target) ? null : isElement(target) ? target : null
    // §4.6 step 0 already redirected the descriptor; the state has to agree with it, so the
    // composer, the popover and the pin all name the element the thread is actually about.
    const anchored = point && picked ? assess(picked, point).anchor : null
    const element = isRange(target) ? (elementOfRange(target) ?? null) : (anchored ?? picked)
    if (!element) return reject(kind, 'no_target')

    if (interaction !== null) deps.emit('placement:start', { kind, interaction })
    state.set({
      phase: 'composing',
      kind,
      mode: captured.anchor.mode,
      element,
      picked: picked === element ? null : picked,
      range: isRange(target) ? target : null,
      draft: '',
      capture: captured.capture,
      point,
      replyTo,
    })
    return true
  }

  /** §2.5 is pure and never throws, but a heuristic fault must not cost a placement either. */
  function assess(
    element: Element,
    point: ClickPoint | null,
  ): { anchor: Element; confidence: number } {
    try {
      const doc = deps.document()
      const result = assessTarget(element, {
        ...(doc ? { document: doc } : {}),
        ...(point ? { point } : {}),
      })
      return { anchor: result.anchor, confidence: result.confidence }
    } catch {
      return { anchor: element, confidence: 1 }
    }
  }

  function elementOfRange(range: Range): Element | null {
    let node: Node | null = range.commonAncestorContainer
    while (node && node.nodeType !== 1) node = node.parentNode
    return isElement(node) ? node : null
  }

  function pointOfTarget(target: PlacementTarget): ClickPoint | null {
    if ('element' in target && target.point) {
      return { clientX: target.point.clientX, clientY: target.point.clientY }
    }
    return null
  }

  function resolveTarget(target: PlacementTarget): Element | Range | null {
    if ('element' in target) return isElement(target.element) ? target.element : null
    if ('selection' in target) {
      const value = target.selection
      if (isRange(value)) return value
      if (isSelection(value) && value.rangeCount > 0 && !value.isCollapsed)
        return value.getRangeAt(0)
      return null
    }
    if ('auto' in target) return liveSelectionRange(deps.document()) ?? hovered
    return null
  }

  function start(kind?: string, target?: PlacementTarget): boolean {
    // §4.4: post-`destroy()` this is a no-op, not a silent state mutation. `emit` is already
    // gated after destroy, so without this the controller would walk into `picking` invisibly.
    if (!deps.alive()) return false
    const modes = deps.modes()
    const wanted = kind ?? modes[0]?.kind
    if (wanted === undefined) return reject('', 'unknown_kind')

    // A reply composer inherits its kind from the thread, so it may name a kind that is no
    // longer in `modes` (§2.11 setModes) — resolve that before the mode lookup.
    let replyTo: string | null = null
    if (target && 'threadId' in target) {
      replyTo = target.threadId
      const inherited = deps.kindOfThread(target.threadId)
      if (!inherited) return reject(wanted, 'no_target')
      return startReply(target.threadId, inherited)
    }

    const mode = modeFor(wanted)
    if (!mode) return reject(wanted, 'unknown_kind')

    const phase = state.get().phase
    // §2.12: `start()` while composing/submitting is a `busy` rejection, not a fault. While
    // `picking` it is a re-entry — the old pick is abandoned, which is what a user pressing a
    // second mode's key means.
    if (phase === 'composing' || phase === 'submitting') return reject(wanted, 'busy')
    if (phase === 'picking') cancel('switch')

    if (target) {
      const resolved = resolveTarget(target)
      if (!resolved) return reject(wanted, 'no_target')
      return compose(wanted, resolved, replyTo, 'direct', pointOfTarget(target))
    }

    // §4.5 "Selection wins": a non-collapsed selection skips `picking` entirely, for both
    // `pick` and `hover`.
    const selection = liveSelectionRange(deps.document())
    if (selection) return compose(wanted, selection, null, 'direct')

    const interaction = interactionOf(mode)
    if (interaction === 'hover') {
      if (!hovered?.isConnected) return reject(wanted, 'no_target')
      return compose(wanted, hovered, null, 'hover', hoveredPoint)
    }

    deps.emit('placement:start', { kind: wanted, interaction: 'pick' })
    state.set({
      phase: 'picking',
      kind: wanted,
      interaction: 'pick',
      candidate: hovered,
      point: hoveredPoint,
      confidence: hovered ? assess(hovered, hoveredPoint).confidence : 1,
    })
    return true
  }

  function startReply(threadId: string, kind: string): boolean {
    const phase = state.get().phase
    if (phase === 'composing' || phase === 'submitting') return reject(kind, 'busy')
    if (phase === 'picking') cancel('switch')
    deps.emit('placement:start', { kind, interaction: 'direct' })
    pendingAnchor = null
    state.set({
      phase: 'composing',
      kind,
      mode: 'element',
      element: (deps.document()?.documentElement ?? null) as Element,
      picked: null,
      range: null,
      draft: '',
      capture: emptyCapture(),
      point: null,
      replyTo: threadId,
    })
    return true
  }

  function cancel(reason?: string): void {
    const current = state.get()
    if (current.phase === 'idle') return
    const kind = current.kind
    pendingAnchor = null
    // Invalidate the flow first: a cancel from `submitting` (Esc reaches it, §4.5) must not be
    // followed by that submission's own `placement:end{reason:'placed'}` — §4.2.9's pair is
    // exclusive per flow. The store write itself cannot be recalled, so the thread still lands
    // and shows up through `thread:create` / `thread:reply`; only the terminal event is one.
    flow += 1
    state.set(IDLE)
    deps.emit('placement:end', { kind, reason: 'cancelled', threadId: null })
    void reason
  }

  async function submit(body?: string): Promise<WriteResult> {
    if (!deps.alive()) throw new CommentError('engine_destroyed')
    const current = state.get()
    if (current.phase === 'submitting') {
      // §2.12: a second submit is ignored and resolves with the in-flight promise.
      return inflight ?? Promise.reject(new CommentError('placement_busy'))
    }
    if (current.phase !== 'composing') {
      throw new CommentError('no_target', 'submit() called outside the composer')
    }

    const draft = body ?? current.draft
    if (draft.trim() === '') throw new CommentError('empty_body')

    const composing = current
    state.set({
      phase: 'submitting',
      kind: composing.kind,
      mode: composing.mode,
      element: composing.element,
      draft,
      replyTo: composing.replyTo,
    })

    const run = async (): Promise<WriteResult> => {
      if (composing.replyTo) return deps.submitReply(composing.replyTo, draft)
      if (!pendingAnchor) throw new CommentError('no_target')
      return deps.submitNew({
        kind: composing.kind,
        anchor: pendingAnchor,
        capture: composing.capture,
        body: draft,
      })
    }

    const mine = flow
    inflight = run()
    try {
      const result = await inflight
      // A `cancel()` (or a `destroy()`) landed while the write was in flight: that flow already
      // emitted its single `placement:end{cancelled}` and reset the state, so neither the
      // terminal event nor the state reset may happen twice.
      if (mine !== flow) return result
      pendingAnchor = null
      state.set(IDLE)
      // §4.2.9: `placement:end` with `reason: 'placed'` fires AFTER the thread:create /
      // thread:reply for that submission.
      deps.emit('placement:end', {
        kind: composing.kind,
        reason: 'placed',
        threadId: result.thread.id,
      })
      return result
    } catch (error) {
      // §2.12: on submit failure the state returns to `composing` with the draft intact —
      // unless the flow was cancelled underneath, in which case idle is the truth.
      if (mine === flow) state.set({ ...composing, draft })
      throw error
    } finally {
      inflight = null
    }
  }

  /* ------------------------------------------------------------------- §4.5 trigger wiring */

  function onKeyDown(event: KeyboardEvent): void {
    deps.tick()
    try {
      if (event.key === 'Escape') {
        if (state.get().phase !== 'idle') cancel('escape')
        return
      }
      for (const mode of deps.modes()) {
        const trigger = mode.trigger
        if (!trigger) continue
        if (!matchesTrigger(event, trigger)) continue
        // Triggers with any modifier bypass the editable guard.
        if (!hasModifier(trigger) && isEditableTarget(realTarget(event))) continue

        const current = state.get()
        if (current.phase === 'picking' && current.kind === mode.kind) {
          event.preventDefault()
          cancel('toggle') // §4.5: a second press of the same trigger key cancels
          return
        }
        event.preventDefault()
        start(mode.kind)
        return
      }
    } catch (error) {
      deps.emitError(asCommentError(error), 'trigger')
    }
  }

  function onMouseOver(event: MouseEvent): void {
    deps.tick()
    const target = realTarget(event)
    if (isElement(target)) {
      hovered = target
      hoveredPoint = { clientX: event.clientX, clientY: event.clientY }
    }
  }

  function onMouseMove(event: MouseEvent): void {
    const current = state.get()
    if (current.phase !== 'picking') return
    const target = realTarget(event)
    if (!isElement(target)) return
    const point: ClickPoint = { clientX: event.clientX, clientY: event.clientY }
    // §4.5: `candidate`, `point` and `confidence` move together on one animation frame —
    // `assessTarget` runs on that frame and on no other.
    const apply = (): void => {
      const live = state.get()
      if (live.phase !== 'picking') return
      state.set({ ...live, candidate: target, point, confidence: assess(target, point).confidence })
    }
    const win = deps.document()?.defaultView
    if (frame !== null || typeof win?.requestAnimationFrame !== 'function') {
      if (frame === null) apply()
      return
    }
    frame = win.requestAnimationFrame(() => {
      frame = null
      apply()
    })
  }

  function onClick(event: MouseEvent): void {
    const current = state.get()
    if (current.phase !== 'picking') return
    const target = realTarget(event)
    if (!isElement(target)) return
    event.preventDefault()
    event.stopPropagation()
    const kind = current.kind
    state.set(IDLE) // leave `picking` first so `compose` is not seen as a re-entry
    // §4.5: **the placing click's coordinates are the anchor's point.** This is what makes a
    // click in a page's empty right margin produce a thread at the cursor rather than a thread
    // bolted to `<body>` (`docs/DESIGN.md` §0 D8).
    const point: ClickPoint = { clientX: event.clientX, clientY: event.clientY }
    // `null`: this flow's `placement:start` was emitted when it entered `picking` (§4.2.9 is
    // one start → composer → one end, and `interaction: 'pick'` is already on that event).
    if (!compose(kind, target, null, null, point)) {
      // The pick is over either way, so the flow gets its single terminal event.
      deps.emit('placement:end', { kind, reason: 'cancelled', threadId: null })
    }
  }

  function attach(): void {
    const doc = deps.document()
    const win = doc?.defaultView
    if (!doc || !win) return
    // Capture phase, on `window`, registered at start() — the content script runs at
    // document_start (§4.5).
    win.addEventListener('keydown', onKeyDown as EventListener, true)
    doc.addEventListener('mouseover', onMouseOver as EventListener, true)
    doc.addEventListener('mousemove', onMouseMove as EventListener, true)
    doc.addEventListener('click', onClick as EventListener, true)
    disposers.push(() => {
      win.removeEventListener('keydown', onKeyDown as EventListener, true)
      doc.removeEventListener('mouseover', onMouseOver as EventListener, true)
      doc.removeEventListener('mousemove', onMouseMove as EventListener, true)
      doc.removeEventListener('click', onClick as EventListener, true)
    })
  }

  function detach(): void {
    for (const dispose of disposers.splice(0)) dispose()
    if (frame !== null) {
      deps.document()?.defaultView?.cancelAnimationFrame?.(frame)
      frame = null
    }
  }

  return {
    get: view.get,
    subscribe: view.subscribe,
    start,
    setDraft(body) {
      const current = state.get()
      if (current.phase !== 'composing') return
      state.set({ ...current, draft: body })
    },
    submit,
    cancel,
    attach,
    detach,
    lastHovered: () => hovered,
    refreshModes() {
      // §2.11 setModes: "Cancels any in-flight placement".
      cancel('modes')
    },
  }
}

function emptyCapture(): ElementCapture {
  return {
    outerHTML: '',
    text: '',
    cssPath: '',
    page: { url: '', title: '' },
    capturedAt: new Date(0).toISOString(),
  }
}

function asCommentError(error: unknown): CommentError {
  return CommentError.is(error)
    ? error
    : new CommentError('invalid_options', error instanceof Error ? error.message : String(error), {
        cause: error,
      })
}
