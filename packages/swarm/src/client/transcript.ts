/**
 * The two ref-counted handles: `transcript(attemptId)` and `diff(attemptId)` (SPEC-swarm §6.2).
 *
 * "Ref-counted: the attempt stream is subscribed on first handle, released on last." Both handles
 * share one subscription, because both are projections of the same `attempt:*` stream — the
 * transcript from `att.text`/`att.reasoning`/`att.tool`/`att.usage`/`att.background`, the diff
 * from `att.diff` plus the stream's snapshot. Two subscriptions for one stream would double the
 * only traffic §2.4 allows to lag.
 *
 * **Coalescing** (§2.4's delta-merge rule, applied on the receiving side): consecutive text or
 * reasoning deltas merge into the entry they extend. The log keeps them unmerged and replay is
 * exact; what a head renders is one paragraph, not four hundred entries.
 *
 * **`loadOlder` is local.** `swarm.v1` has no history-paging frame — a transcript is served whole
 * by the stream's snapshot and then extended by deltas — so the handle keeps a ring larger than
 * it publishes and `loadOlder(n)` reveals more of it. Inventing a paging request here would put a
 * frame on the wire that no server answers, which is worse than a bounded local window that says
 * so through `hasOlder`.
 *
 * DOM-free and Node-free.
 */

import type { SwarmError } from '../errors.ts'
import type { SwarmEvent } from '../protocol/events.ts'
import type { StreamName } from '../protocol/frames.ts'
import type { AttemptSnapshot } from '../protocol/snapshots.ts'
import type { WritableStore } from '../readable.ts'
import type {
  AttemptId,
  DiffHandle,
  DiffVM,
  TranscriptEntry,
  TranscriptHandle,
  TranscriptVM,
  TurnId,
} from '../types.ts'

import { attemptStream } from '../protocol/codec.ts'
import { readonlyStore, writable } from '../readable.ts'
import { deepFreeze } from './freeze.ts'

/** What the handle retains. Ten times the default window: enough to scroll, bounded by design. */
export const TRANSCRIPT_RING = 4000
/** What it publishes until `loadOlder` asks for more. */
export const TRANSCRIPT_WINDOW = 400

interface AttemptView {
  readonly attemptId: AttemptId
  readonly stream: StreamName
  entries: TranscriptEntry[]
  /** The ring dropped entries the server had sent — `hasOlder` must stay true afterwards. */
  trimmed: boolean
  serverHasOlder: boolean
  /**
   * A turn boundary was seen that produced no entry, so the next delta MUST start a new one
   * (§6.2, §13's two-head row). Only a turn *this* head sent has a prompt to render, and without
   * this flag `appendText` coalesced the last delta of turn N with the first delta of turn N+1
   * into a single entry carrying turn N's timestamp.
   */
  turnBreak: boolean
  visible: number
  following: boolean
  lagged: boolean
  files: DiffVM['files']
  expanded: Set<string>
  baseRevision: string
  staleBase: boolean
  totals: DiffVM['totals']
  truncated: boolean
  transcriptRefs: number
  diffRefs: number
  readonly transcriptStore: WritableStore<TranscriptVM>
  readonly diffStore: WritableStore<DiffVM>
}

export interface HandleRegistryOptions {
  readonly now: () => number
  acquire(stream: StreamName): void
  release(stream: StreamName): void
  resnapshot(stream: StreamName): Promise<void>
  /** The prompt of a turn this client sent — the only source of a `{k:'user'}` entry (§6.2). */
  turnPrompt(turnId: TurnId): { readonly text: string; readonly images: number } | undefined
  onError(error: SwarmError): void
}

export interface HandleRegistry {
  transcript(attemptId: AttemptId): TranscriptHandle
  diff(attemptId: AttemptId): DiffHandle
  applySnapshot(attemptId: AttemptId, snapshot: AttemptSnapshot): void
  applyEvent(attemptId: AttemptId, event: SwarmEvent, ts: number): void
  markLagged(attemptId: AttemptId, lagged: boolean): void
  counts(): { readonly transcripts: number; readonly diffs: number }
  destroy(): void
}

function emptyTranscript(attemptId: AttemptId): TranscriptVM {
  return deepFreeze({ attemptId, following: true, entries: [], hasOlder: false, lagged: false })
}

function emptyDiff(attemptId: AttemptId): DiffVM {
  return deepFreeze({
    attemptId,
    baseRevision: '',
    staleBase: false,
    files: [],
    totals: { files: 0, insertions: 0, deletions: 0 },
    truncated: false,
  })
}

export function createHandleRegistry(options: HandleRegistryOptions): HandleRegistry {
  const views = new Map<AttemptId, AttemptView>()

  const ensure = (attemptId: AttemptId): AttemptView => {
    const existing = views.get(attemptId)
    if (existing) return existing
    const view: AttemptView = {
      attemptId,
      stream: attemptStream(attemptId),
      entries: [],
      trimmed: false,
      serverHasOlder: false,
      turnBreak: false,
      visible: TRANSCRIPT_WINDOW,
      following: true,
      lagged: false,
      files: [],
      expanded: new Set<string>(),
      baseRevision: '',
      staleBase: false,
      totals: { files: 0, insertions: 0, deletions: 0 },
      truncated: false,
      transcriptRefs: 0,
      diffRefs: 0,
      transcriptStore: writable<TranscriptVM>(emptyTranscript(attemptId)),
      diffStore: writable<DiffVM>(emptyDiff(attemptId)),
    }
    views.set(attemptId, view)
    return view
  }

  const publishTranscript = (view: AttemptView): void => {
    const start = Math.max(0, view.entries.length - view.visible)
    view.transcriptStore.set(
      deepFreeze({
        attemptId: view.attemptId,
        following: view.following,
        entries: view.entries.slice(start),
        hasOlder: start > 0 || view.trimmed || view.serverHasOlder,
        lagged: view.lagged,
      }),
    )
  }

  const publishDiff = (view: AttemptView): void => {
    view.diffStore.set(
      deepFreeze({
        attemptId: view.attemptId,
        baseRevision: view.baseRevision,
        staleBase: view.staleBase,
        /* A collapsed file publishes `hunks: null` — the type's own way of saying "not here". */
        files: view.files.map((file) =>
          view.expanded.has(file.path) ? file : { ...file, hunks: null },
        ),
        totals: view.totals,
        truncated: view.truncated,
      }),
    )
  }

  const trim = (view: AttemptView): void => {
    if (view.entries.length <= TRANSCRIPT_RING) return
    view.entries = view.entries.slice(view.entries.length - TRANSCRIPT_RING)
    view.trimmed = true
  }

  const dropIfIdle = (view: AttemptView): void => {
    if (view.transcriptRefs > 0 || view.diffRefs > 0) return
    options.release(view.stream)
    views.delete(view.attemptId)
  }

  const appendText = (
    view: AttemptView,
    kind: 'text' | 'reasoning',
    text: string,
    at: number,
  ): void => {
    const last = view.entries[view.entries.length - 1]
    const coalesce = last !== undefined && last.k === kind && !view.turnBreak
    view.turnBreak = false
    if (coalesce && last !== undefined && last.k === kind) {
      view.entries[view.entries.length - 1] =
        kind === 'text'
          ? { k: 'text', text: last.text + text, at: last.at }
          : { k: 'reasoning', text: last.text + text, at: last.at, collapsed: true }
      return
    }
    view.entries.push(
      kind === 'text' ? { k: 'text', text, at } : { k: 'reasoning', text, at, collapsed: true },
    )
    trim(view)
  }

  return {
    transcript(attemptId) {
      const view = ensure(attemptId)
      view.transcriptRefs += 1
      if (view.transcriptRefs + view.diffRefs === 1) options.acquire(view.stream)
      let live = true
      return {
        vm: readonlyStore(view.transcriptStore),
        follow(on) {
          if (!live) return
          view.following = on
          publishTranscript(view)
        },
        loadOlder(n) {
          if (!live) return Promise.resolve()
          view.visible = Math.min(TRANSCRIPT_RING, view.visible + Math.max(1, n))
          publishTranscript(view)
          return Promise.resolve()
        },
        release() {
          if (!live) return /* idempotent (§6.2's handles are safe to release twice) */
          live = false
          view.transcriptRefs = Math.max(0, view.transcriptRefs - 1)
          dropIfIdle(view)
        },
      } satisfies TranscriptHandle
    },

    diff(attemptId) {
      const view = ensure(attemptId)
      view.diffRefs += 1
      if (view.transcriptRefs + view.diffRefs === 1) options.acquire(view.stream)
      let live = true
      return {
        vm: readonlyStore(view.diffStore),
        expand(path, expanded) {
          if (!live) return
          if (expanded) view.expanded.add(path)
          else view.expanded.delete(path)
          publishDiff(view)
        },
        refresh() {
          if (!live) return Promise.resolve()
          /* The only way to re-read materialized state is a snapshot (§2.3). */
          return options.resnapshot(view.stream)
        },
        release() {
          if (!live) return
          live = false
          view.diffRefs = Math.max(0, view.diffRefs - 1)
          dropIfIdle(view)
        },
      } satisfies DiffHandle
    },

    applySnapshot(attemptId, snapshot) {
      const view = views.get(attemptId)
      if (!view) return
      view.entries = [...snapshot.entries]
      view.trimmed = false
      view.turnBreak = false
      view.serverHasOlder = snapshot.hasOlder
      trim(view)
      view.lagged = false
      if (snapshot.diff !== null) {
        view.files = snapshot.diff.files
        view.baseRevision = snapshot.diff.baseRevision
        view.staleBase = snapshot.diff.staleBase
        view.totals = snapshot.diff.totals
        view.truncated = snapshot.diff.truncated
      }
      publishTranscript(view)
      publishDiff(view)
    },

    applyEvent(attemptId, event, ts) {
      const view = views.get(attemptId)
      if (!view) return
      switch (event.k) {
        case 'att.text':
          appendText(view, 'text', event.text, ts)
          break
        case 'att.reasoning':
          appendText(view, 'reasoning', event.text, ts)
          break
        case 'att.tool': {
          /* Upsert by `callId`: one tool call is one entry that moves start → exec → done, not
           * four. The wire never carries an empty `callId` — the adapter attributes input deltas
           * to the most recent `tool_start` before they become an event ([F11], §6.4). */
          const index = view.entries.findIndex(
            (entry) => entry.k === 'tool' && entry.callId === event.callId,
          )
          const next: TranscriptEntry = {
            k: 'tool',
            callId: event.callId,
            name: event.name,
            target: event.target,
            status: event.status,
            output: event.output ?? null,
            durationMs: event.durationMs ?? null,
          }
          if (index >= 0) view.entries[index] = next
          else {
            view.entries.push(next)
            trim(view)
          }
          break
        }
        case 'att.usage':
          view.entries.push({ k: 'usage', input: event.input, output: event.output })
          trim(view)
          break
        case 'att.background':
          view.entries.push({
            k: 'background',
            taskId: event.taskId,
            label: event.label,
            ...(event.percent === undefined ? {} : { percent: event.percent }),
            provenance: 'scraped',
          })
          trim(view)
          break
        case 'att.turn_boundary': {
          if (event.edge !== 'start') break
          /* The boundary is real whether or not this head can render it: the wire carries no
           * prompt text, so a turn another head sent has no honest `{k:'user'}` entry — but it
           * still ends the previous turn's paragraph. */
          view.turnBreak = true
          const prompt = options.turnPrompt(event.turnId)
          if (prompt === undefined) break
          view.turnBreak = false
          view.entries.push({
            k: 'user',
            turnId: event.turnId,
            text: prompt.text,
            at: ts,
            images: prompt.images,
          })
          trim(view)
          break
        }
        case 'att.diff':
          view.totals = event.totals
          view.staleBase = event.staleBase
          publishDiff(view)
          return
        case 'att.error':
          view.entries.push({ k: 'notice', text: `${event.code}: ${event.message}` })
          trim(view)
          break
        default:
          return
      }
      publishTranscript(view)
    },

    markLagged(attemptId, lagged) {
      const view = views.get(attemptId)
      if (!view) return
      view.lagged = lagged
      publishTranscript(view)
    },

    counts() {
      let transcripts = 0
      let diffs = 0
      for (const view of views.values()) {
        transcripts += view.transcriptRefs
        diffs += view.diffRefs
      }
      return { transcripts, diffs }
    },

    destroy() {
      views.clear()
    },
  }
}
