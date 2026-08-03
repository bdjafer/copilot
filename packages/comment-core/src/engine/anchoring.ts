/**
 * The engine's anchoring loop (§4.6.5): one shared `MutationObserver`, a debounced idle batch,
 * a per-thread `WeakRef<Element>` cache, the scoped cheap retry for added subtrees and the
 * idle full-document rescan.
 *
 * Everything observable is expressed as **transitions** (§4.2.6: "transitions only — no event
 * when `AnchorStatus` and element are unchanged"), and the pass itself is a **synchronous**
 * pure-ish function of the DOM. That is deliberate: it makes the whole subsystem testable
 * without leaning on `MutationObserver` delivery timing, which no DOM emulator reproduces
 * faithfully. The observer only ever decides *when* a pass runs, never what it computes.
 */

import type { AnchorExplanation, AnyStrategy } from '../anchor/types.ts'
import type { AnchorStatus, Thread } from '../types.ts'
import type { Anchoring, AnchoringOptions } from './types.ts'

import { documentRect, sameRect } from '../anchor/dom.ts'
import { explainAnchor } from '../anchor/resolve.ts'
import { asStrategyList, mergeStrategies } from '../anchor/strategies/index.ts'

export const DEFAULT_BATCH_MS = 100

/** The `Anchoring` every thread starts life with (§2.3 / comment-ui's "pending renders nothing"). */
export const PENDING: Anchoring = Object.freeze({
  status: 'pending' as AnchorStatus,
  element: null,
  range: null,
  confidence: 0,
  via: null,
  rect: null,
})

export interface AnchorTransition {
  threadId: string
  previous: AnchorStatus
  anchoring: Anchoring
}

interface Entry {
  anchoring: Anchoring
  ref: WeakRef<Element> | null
  explanation: AnchorExplanation | null
}

export interface PassOptions {
  /** Added subtrees to try first, cheap strategies only (§4.6.5). */
  scope?: readonly Element[]
  /**
   * Mutation targets from this batch. An anchored element is re-verified when a mutation
   * landed **at or inside** it — that is what makes the observer's `attributes` half worth
   * anything, since a `data-testid` that was renamed leaves the element connected and the
   * WeakRef short-circuit would otherwise keep a confidence of 1 forever. Mutations at an
   * *ancestor* are ignored: the element is still connected, so it was not removed.
   */
  dirty?: readonly Node[]
  /** Ignore the WeakRef short-circuit and re-resolve every thread. `reanchor()` sets this. */
  force?: boolean
  /** Restrict the pass to one thread. */
  only?: string
  /** Allow the full-document retry for already-orphaned threads. */
  fullRetry?: boolean
}

export interface StrategyStat {
  type: string
  weight: number
  hits: number
  misses: number
  totalMs: number
  runs: number
}

export interface AnchoringController {
  readonly batches: number
  readonly lastBatchMs: number
  readonly observing: boolean
  /** True once the first full-document pass completed — the `pending → orphaned` gate (§4.2.6). */
  readonly firstPassDone: boolean
  get(threadId: string): Anchoring
  explanationOf(threadId: string): AnchorExplanation | null
  /** A fresh trace for one thread; costs one budgetMs pass (`engine.explain({fresh:true})`). */
  trace(thread: Thread): AnchorExplanation
  track(threads: readonly Thread[]): void
  forget(threadId: string): void
  reset(): void
  pass(threads: readonly Thread[], options?: PassOptions): AnchorTransition[]
  /** Marks the first full-document pass complete; from then on misses orphan. */
  completeFirstPass(): void
  observe(): void
  disconnect(): void
  /** Run the debounced batch right now. Returns false when nothing was pending. */
  flush(): boolean
  readonly pending: number
  stats(): StrategyStat[]
}

export interface AnchoringDeps {
  document: Document
  options: AnchoringOptions | undefined
  /** The live thread list the batch resolves against. */
  threads: () => readonly Thread[]
  /** Called with the transitions a self-scheduled batch produced. */
  onBatch: (transitions: AnchorTransition[]) => void
  /** Called at the head of every batch (§4.6.6: the `location.href` poll). */
  onTick?: () => void
  onError: (error: unknown) => void
}

type IdleHandle = { cancel: () => void }

function scheduleIdle(fn: () => void, timeoutMs: number): IdleHandle {
  const g = globalThis as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    cancelIdleCallback?: (handle: number) => void
  }
  if (typeof g.requestIdleCallback === 'function') {
    const handle = g.requestIdleCallback(fn, { timeout: timeoutMs })
    return { cancel: () => g.cancelIdleCallback?.(handle) }
  }
  const handle = setTimeout(fn, timeoutMs)
  return { cancel: () => clearTimeout(handle) }
}

export function createAnchoringController(deps: AnchoringDeps): AnchoringController {
  const entries = new Map<string, Entry>()
  const stats = new Map<string, StrategyStat>()
  const options = deps.options ?? {}
  const batchMs = options.batchMs ?? DEFAULT_BATCH_MS
  const rescanIdle = options.rescanIdle ?? true
  const strategies = mergeStrategies(options.strategies as readonly AnyStrategy[] | undefined)
  const cheapStrategies = strategies.filter((s) => s.cost !== 'fuzzy')

  let firstPassDone = false
  let batches = 0
  let lastBatchMs = 0
  let observer: MutationObserver | null = null
  let scheduled: IdleHandle | null = null
  let dirty = false
  let addedScope: Element[] = []
  let dirtyNodes: Node[] = []

  const resolveOptions = {
    threshold: options.threshold,
    scanLimit: options.scanLimit,
    scoring: options.scoring,
    budgetMs: options.budgetMs,
  }

  function statFor(type: string, weight: number): StrategyStat {
    let stat = stats.get(type)
    if (!stat) {
      stat = { type, weight, hits: 0, misses: 0, totalMs: 0, runs: 0 }
      stats.set(type, stat)
    }
    return stat
  }

  function recordTrace(explanation: AnchorExplanation): void {
    for (const attempt of explanation.attempts) {
      const type =
        attempt.selector === 'fingerprint-scan' ? 'fingerprint-scan' : attempt.selector.type
      const weight = strategies.find((s) => s.type === type)?.weight ?? 0
      const stat = statFor(type, weight)
      stat.runs += 1
      stat.totalMs += attempt.ms
      if (attempt.accepted) stat.hits += 1
      else stat.misses += 1
    }
  }

  function entryFor(threadId: string): Entry {
    let entry = entries.get(threadId)
    if (!entry) {
      entry = { anchoring: PENDING, ref: null, explanation: null }
      entries.set(threadId, entry)
    }
    return entry
  }

  /** Build the next `Anchoring`, reusing the previous object when nothing observable moved. */
  function nextAnchoring(previous: Anchoring, candidate: Anchoring): Anchoring {
    if (
      previous.status === candidate.status &&
      previous.element === candidate.element &&
      previous.range === candidate.range &&
      previous.confidence === candidate.confidence &&
      previous.via === candidate.via &&
      sameRect(previous.rect, candidate.rect)
    ) {
      return previous
    }
    return Object.freeze(candidate)
  }

  function resolveOne(thread: Thread, plan: PassOptions): AnchorExplanation | null {
    // §4.6.5: added nodes ⇒ retry scoped to the added subtrees first, cheap strategies only.
    for (const root of plan.scope ?? []) {
      const trace = explainAnchor(thread.anchor, {
        ...resolveOptions,
        document: deps.document,
        root,
        strategies: asStrategyList(cheapStrategies),
      })
      recordTrace(trace)
      if (trace.result) return trace
    }
    // `rescanIdle: false` buys exactly this: an already-orphaned thread costs nothing but the
    // scoped retry above until something is added to the page again.
    if (!plan.fullRetry) return null
    const trace = explainAnchor(thread.anchor, {
      ...resolveOptions,
      document: deps.document,
      root: deps.document,
      strategies: asStrategyList(strategies),
    })
    recordTrace(trace)
    return trace
  }

  function pass(threads: readonly Thread[], passOptions: PassOptions = {}): AnchorTransition[] {
    const started = Date.now()
    const transitions: AnchorTransition[] = []
    const touched = passOptions.dirty ?? []
    const isTouched = (element: Element): boolean => {
      for (const node of touched) {
        try {
          if (element.contains(node)) return true
        } catch {
          return true // an unanswerable question is answered by re-verifying
        }
      }
      return false
    }

    for (const thread of threads) {
      if (passOptions.only && thread.id !== passOptions.only) continue
      const entry = entryFor(thread.id)
      const previous = entry.anchoring

      // §4.6.5: the WeakRef cache short-circuits an unchanged element.
      const cached = entry.ref?.deref()
      if (!passOptions.force && cached && cached.isConnected && !isTouched(cached)) {
        const rect = documentRect(cached)
        entry.anchoring = nextAnchoring(previous, { ...previous, rect })
        continue
      }

      let trace: AnchorExplanation | null = null
      try {
        trace = resolveOne(thread, {
          ...passOptions,
          fullRetry:
            passOptions.fullRetry ??
            (previous.status !== 'orphaned' || rescanIdle || !firstPassDone),
        })
      } catch (error) {
        deps.onError(error)
        trace = null
      }
      if (trace) entry.explanation = trace

      const match = trace?.result ?? null
      let candidate: Anchoring
      if (match) {
        entry.ref = new WeakRef(match.element)
        candidate = {
          status: 'anchored',
          element: match.element,
          range: match.range,
          confidence: match.confidence,
          via: match.via,
          rect: documentRect(match.element),
        }
      } else {
        entry.ref = null
        // §4.2.6: `pending → orphaned` fires only after the first full-document pass, so a cold
        // load never flashes orphans. `rect` is retained so an orphaned badge can still dock.
        const status: AnchorStatus = firstPassDone
          ? 'orphaned'
          : previous.status === 'anchored'
            ? 'orphaned'
            : 'pending'
        candidate = {
          status,
          element: null,
          range: null,
          confidence: 0,
          via: null,
          // A thread that orphans on the FIRST pass after a cold load has never had a live
          // rect — orphanhood is derived, never persisted, so nothing carried one across the
          // reload. `capture.rect` is that missing position: written once at placement time,
          // it is what makes PLAN §3.3's "docked at last-known position" true for a cold
          // orphan too (bench F1) instead of drawing no badge at all.
          rect: previous.rect ?? (status === 'orphaned' ? (thread.capture?.rect ?? null) : null),
        }
      }

      entry.anchoring = nextAnchoring(previous, candidate)
      if (
        entry.anchoring !== previous &&
        (previous.status !== entry.anchoring.status || previous.element !== entry.anchoring.element)
      ) {
        transitions.push({
          threadId: thread.id,
          previous: previous.status,
          anchoring: entry.anchoring,
        })
      }
    }

    // §2.15 `anchoring.batches` is a devtools signal for the coalesced batch loop, so only a
    // pass over the whole thread set counts. A single-thread `{ only, force }` pass — which the
    // engine runs after **every** local write, and which `reanchor(threadId)` triggers — is not
    // a batch, and counting it made the number unusable (and `lastBatchMs` measure the wrong
    // pass).
    const elapsed = Date.now() - started
    if (passOptions.only === undefined) {
      batches += 1
      lastBatchMs = elapsed
    }
    return transitions
  }

  function runScheduled(): void {
    scheduled = null
    if (!dirty) return
    dirty = false
    const scope = addedScope.filter((element) => element.isConnected)
    const touched = dirtyNodes
    addedScope = []
    dirtyNodes = []
    try {
      deps.onTick?.()
      // Always reported, even with zero transitions: a pass can change `confidence`, `range`
      // or `rect` without changing status or element, and §2.3 makes those part of the view's
      // identity — the engine has to re-derive its views either way.
      deps.onBatch(pass(deps.threads(), { scope, dirty: touched }))
    } catch (error) {
      deps.onError(error)
    }
  }

  function schedule(): void {
    if (scheduled) return
    scheduled = scheduleIdle(runScheduled, batchMs)
  }

  return {
    get batches() {
      return batches
    },
    get lastBatchMs() {
      return lastBatchMs
    },
    get observing() {
      return observer !== null
    },
    get firstPassDone() {
      return firstPassDone
    },
    get pending() {
      let count = 0
      for (const entry of entries.values()) if (entry.anchoring.status === 'pending') count++
      return count
    },

    get(threadId) {
      return entries.get(threadId)?.anchoring ?? PENDING
    },

    explanationOf(threadId) {
      return entries.get(threadId)?.explanation ?? null
    },

    trace(thread) {
      const explanation = explainAnchor(thread.anchor, {
        ...resolveOptions,
        document: deps.document,
        root: deps.document,
        strategies: asStrategyList(strategies),
      })
      entryFor(thread.id).explanation = explanation
      return explanation
    },

    track(threads) {
      const live = new Set(threads.map((thread) => thread.id))
      for (const id of Array.from(entries.keys())) if (!live.has(id)) entries.delete(id)
      for (const thread of threads) entryFor(thread.id)
    },

    forget(threadId) {
      entries.delete(threadId)
    },

    reset() {
      entries.clear()
      firstPassDone = false
      dirty = false
      addedScope = []
      dirtyNodes = []
    },

    pass,

    completeFirstPass() {
      firstPassDone = true
    },

    observe() {
      if (observer || options.observe === false) return
      const view = deps.document.defaultView as {
        MutationObserver?: typeof MutationObserver
      } | null
      const Ctor =
        view?.MutationObserver ??
        (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver
      const target = deps.document.documentElement ?? deps.document.body
      if (!Ctor || !target) return
      observer = new Ctor((records) => {
        for (const record of records) {
          for (const node of Array.from(record.addedNodes)) {
            if ((node as Element).nodeType === 1) addedScope.push(node as Element)
          }
          if (record.target) dirtyNodes.push(record.target)
        }
        dirty = true
        schedule()
      })
      observer.observe(target, { childList: true, subtree: true, attributes: true })
    },

    disconnect() {
      observer?.disconnect()
      observer = null
      scheduled?.cancel()
      scheduled = null
      dirty = false
      addedScope = []
      dirtyNodes = []
    },

    flush() {
      if (!dirty) return false
      scheduled?.cancel()
      scheduled = null
      runScheduled()
      return true
    },

    stats() {
      return [...stats.values()]
    },
  }
}
