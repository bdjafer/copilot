/**
 * `createCommentEngine` (§2.11) — the DOM runtime of `comment-core`.
 *
 * `CommentEngine extends CommentDomain` is load-bearing (decision log #1): every write goes
 * through the same `createDomain` the service worker runs, so the §4.1 table is implemented
 * once. What the engine adds on top is exactly four things:
 *
 *   1. the **live view** — `ThreadView`s that are frozen and referentially stable (§2.3), so
 *      `React.memo` / `useSyncExternalStore` are correct without selectors;
 *   2. the **anchoring lifecycle** (§4.6.5–6) and its transition events;
 *   3. the **event bus** on top of the store events, with the §4.2 ordering guarantees;
 *   4. **placement** (§2.12, §4.5).
 *
 * Nothing here touches `document` at module scope: the whole file is reachable with the
 * platform globals deleted (§9), and `start()` is the single place a `Document` is read.
 */

import type { AnchorExplanation, CaptureOptions } from '../anchor/types.ts'
import type { StoreEventInput } from '../domain/diff.ts'
import type {
  AppendCommentInput,
  AppendResult,
  Comment,
  CommentRef,
  CommentStore,
  CreateResult,
  CreateThreadInput,
  DeleteCommentResult,
  ErrorPhase,
  PageKeyFn,
  Thread,
  ThreadFilter,
  ThreadRecord,
} from '../types.ts'
import type { AnchorTransition } from './anchoring.ts'
import type { EngineInternals } from './internals.ts'
import type {
  Anchoring,
  CommentEngine,
  CommentEngineOptions,
  CommentEventMap,
  CommentEventName,
  EngineInspection,
  EngineThreadFilter,
  Mode,
  ThreadView,
} from './types.ts'

import { captureTarget } from '../anchor/target.ts'
import { diffSnapshots, emptySnapshot } from '../domain/diff.ts'
import { createDomain } from '../domain/index.ts'
import { defaultReopensOnReply } from '../domain/reduce.ts'
import { createEmitter } from '../emitter.ts'
import { CommentError } from '../errors.ts'
import { defaultPageKey } from '../page-key.ts'
import { readonlyStore, writable } from '../readable.ts'
import { compareRecords } from '../store/common.ts'
import { createLocalStorageStore } from '../store/local-storage.ts'
import { PENDING, createAnchoringController } from './anchoring.ts'
import { INTERNALS } from './internals.ts'
import { createNavigationWatcher } from './navigation.ts'
import { createPlacementController } from './placement.ts'
import { createOriginTokens } from './remote.ts'

/** Stamped into `inspect().version`. Module-private: §2 lists no `VERSION` export. */
const VERSION = '0.0.0'

const DEFAULT_MODES: readonly Mode[] = Object.freeze([
  Object.freeze({ kind: 'comment', trigger: Object.freeze({ key: 'c', interaction: 'pick' }) }),
] as Mode[])

const EMPTY_VIEWS: readonly ThreadView[] = Object.freeze([])

const ALL_EVENT_NAMES: readonly CommentEventName[] = Object.freeze([
  'thread:create',
  'thread:reply',
  'thread:resolve',
  'thread:reopen',
  'thread:delete',
  'comment:edit',
  'comment:delete',
  'thread:anchored',
  'thread:orphaned',
  'thread:click',
  'placement:start',
  'placement:end',
  'placement:rejected',
  'page:change',
  'error',
] as CommentEventName[])

/** §4.5 / §2.11: two modes may not register the same key + modifiers combination. */
function assertUniqueTriggers(modes: readonly Mode[]): void {
  const seen = new Set<string>()
  for (const mode of modes) {
    const trigger = mode.trigger
    if (!trigger) continue
    const m = trigger.modifiers ?? {}
    const key = [
      trigger.key.toLowerCase(),
      m.alt ? 'a' : '',
      m.ctrl ? 'c' : '',
      m.meta ? 'm' : '',
      m.shift ? 's' : '',
    ].join('|')
    if (seen.has(key)) {
      throw new CommentError('invalid_options', `two modes bind the same trigger "${trigger.key}"`)
    }
    seen.add(key)
  }
}

interface CountingStore {
  reads: number
  writes: number
  lastError: string | null
}

/**
 * §2.15: `reads`/`writes` are counted BY THE ENGINE, because `CommentStore` exposes no
 * counters. The wrapper is what `createDomain` is handed; `engine.store` still returns the
 * caller's own object.
 */
function countingStore(store: CommentStore, counters: CountingStore): CommentStore {
  const track = <T>(kind: 'reads' | 'writes', run: () => Promise<T>): Promise<T> => {
    counters[kind] += 1
    return run().catch((error: unknown) => {
      counters.lastError = error instanceof Error ? error.message : String(error)
      throw error
    })
  }

  const wrapped: CommentStore = {
    getThread: (id) => track('reads', () => store.getThread(id)),
    listThreads: (pageKey) => track('reads', () => store.listThreads(pageKey)),
    listAllThreads: () => track('reads', () => store.listAllThreads()),
    listComments: (threadId) => track('reads', () => store.listComments(threadId)),
    putThread: (thread) => track('writes', () => store.putThread(thread)),
    putComment: (comment) => track('writes', () => store.putComment(comment)),
    deleteThread: (id) => track('writes', () => store.deleteThread(id)),
    deleteComment: (id) => track('writes', () => store.deleteComment(id)),
    subscribe: (pageKey, cb) => store.subscribe(pageKey, cb),
  }
  if (store.name !== undefined) Object.defineProperty(wrapped, 'name', { value: store.name })
  if (store.getComment) wrapped.getComment = (id) => track('reads', () => store.getComment!(id))
  if (store.transaction) {
    wrapped.transaction = (fn) => store.transaction!((tx) => fn(countingStore(tx, counters)))
  }
  return wrapped
}

function lastActivityOf(comments: readonly Comment[]): string {
  let latest = ''
  for (const comment of comments) {
    const at =
      comment.editedAt && comment.editedAt > comment.createdAt
        ? comment.editedAt
        : comment.createdAt
    if (at > latest) latest = at
  }
  return latest
}

/**
 * §2.3's identity guarantee has to survive the reload path: `domain.list()` hands back fresh
 * objects on every store notification, and adopting them wholesale would give every
 * `ThreadView` a new identity on every unrelated write in any tab — exactly the churn
 * `React.memo` and `useSyncExternalStore` are supposed to be spared.
 *
 * `anchor` and `capture` are deliberately not compared: they are written once at creation and
 * §2.2 forbids any later mutation of a `Thread`.
 */
function sameThread(a: Thread, b: Thread): boolean {
  return (
    a.id === b.id &&
    a.v === b.v &&
    a.pageKey === b.pageKey &&
    a.kind === b.kind &&
    a.status === b.status &&
    a.resolvedAt === b.resolvedAt &&
    a.resolvedBy === b.resolvedBy &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt
  )
}

function sameComment(a: Comment, b: Comment): boolean {
  return (
    a.id === b.id &&
    a.threadId === b.threadId &&
    a.author === b.author &&
    a.body === b.body &&
    a.createdAt === b.createdAt &&
    a.editedAt === b.editedAt
  )
}

function reconcile(
  previous: ReadonlyMap<string, ThreadRecord>,
  next: ReadonlyMap<string, ThreadRecord>,
): Map<string, ThreadRecord> {
  const out = new Map<string, ThreadRecord>()
  for (const [id, record] of next) {
    const before = previous.get(id)
    if (!before) {
      out.set(id, record)
      continue
    }
    const thread = sameThread(before.thread, record.thread) ? before.thread : record.thread
    const comments =
      before.comments.length === record.comments.length &&
      record.comments.every((comment, index) => sameComment(before.comments[index]!, comment))
        ? before.comments
        : record.comments
    out.set(
      id,
      thread === before.thread && comments === before.comments ? before : { thread, comments },
    )
  }
  return out
}

function snapshotOf(records: ReadonlyMap<string, ThreadRecord>): ReturnType<typeof emptySnapshot> {
  const snapshot = emptySnapshot()
  for (const record of records.values()) {
    snapshot.threads.set(record.thread.id, record.thread)
    snapshot.comments.set(record.thread.id, new Map(record.comments.map((c) => [c.id, c])))
  }
  return snapshot
}

export function createCommentEngine<S extends CommentStore = CommentStore>(
  options?: CommentEngineOptions<S>,
): CommentEngine<S> {
  const opts = options ?? {}
  const store = (opts.store ?? (createLocalStorageStore() as CommentStore)) as S
  const counters: CountingStore = { reads: 0, writes: 0, lastError: null }
  const tracked = countingStore(store, counters)

  const pageKeyFn: PageKeyFn =
    typeof opts.pageKey === 'function'
      ? opts.pageKey
      : typeof opts.pageKey === 'string'
        ? () => opts.pageKey as string
        : (url) => defaultPageKey(url)

  let modes: readonly Mode[] = opts.modes ?? DEFAULT_MODES
  assertUniqueTriggers(modes)

  const reopensOnReply = opts.reopensOnReply ?? defaultReopensOnReply
  const bus = createEmitter<CommentEventMap>({
    onListenerError(error, type) {
      const wrapped = asCommentError(error)
      if (type === 'error') {
        // §4.4 error-loop breaker: `error` never re-emits itself.
        try {
          opts.onError?.(wrapped, 'listener')
        } catch {
          /* the sink is the last stop */
        }
        // eslint-disable-next-line no-console
        console.error(wrapped)
        return
      }
      emitError(wrapped, 'listener')
    },
  })

  const domain = createDomain(tracked, {
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.createId ? { createId: opts.createId } : {}),
    reopensOnReply,
    // §4.1 rule 16: the engine additionally emits `error`/`unsupported_version`.
    onError: (error) => emitError(error, 'store', error.threadId),
  })

  /**
   * §4.4: a `ReadableStore` subscriber is a best-effort subsystem like any listener. Without
   * this sink a `useSyncExternalStore` consumer that faults during a commit would propagate out
   * of `destroy()` (which sets `threads` to the empty list) and out of every imperative write
   * (which commits through `refreshViews`), so neither would be "always safe".
   */
  const onStoreListenerError = (error: unknown): void => reportUnknown(error, 'listener')

  const statusStore = writable<'idle' | 'loading' | 'ready' | 'destroyed'>(
    'idle',
    onStoreListenerError,
  )
  const threadsStore = writable<readonly ThreadView[]>(EMPTY_VIEWS, onStoreListenerError)
  const activeStore = writable<string | null>(null, onStoreListenerError)
  const pageStore = writable<{ key: string; url: string }>(
    { key: '', url: '' },
    onStoreListenerError,
  )
  const tokens = createOriginTokens()

  let doc: Document | null = null
  let startedWhileParsing = false
  let started = false
  let destroyed = false
  let primed = false
  let currentPageKey = ''
  let records = new Map<string, ThreadRecord>()
  const viewCache = new Map<
    string,
    { view: ThreadView; thread: Thread; comments: readonly Comment[]; anchoring: Anchoring }
  >()

  let anchoring: ReturnType<typeof createAnchoringController> | null = null
  let navigation: ReturnType<typeof createNavigationWatcher> | null = null
  let storeUnsubscribe: (() => void) | null = null
  let reloadQueue: Promise<void> = Promise.resolve()

  let readyResolve: () => void = () => {}
  let readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve
  })

  /* ------------------------------------------------------------------------------ emission */

  function emit<E extends CommentEventName>(event: E, payload: CommentEventMap[E]): void {
    if (destroyed) return // §4.2.11: no event is emitted after destroy()
    bus.emit(event, payload)
  }

  function emitError(error: CommentError, phase: ErrorPhase, threadId?: string): void {
    if (destroyed) return
    try {
      opts.onError?.(error, phase)
    } catch {
      // A faulty error sink must not take the engine down.
    }
    bus.emit('error', threadId === undefined ? { error, phase } : { error, phase, threadId })
  }

  function reportUnknown(error: unknown, phase: ErrorPhase, threadId?: string): void {
    emitError(asCommentError(error), phase, threadId)
  }

  /* --------------------------------------------------------------------------------- views */

  function sortedRecords(): ThreadRecord[] {
    return [...records.values()].sort((a, b) => compareRecords(a.thread, b.thread))
  }

  function makeView(record: ThreadRecord, anchor: Anchoring): ThreadView {
    const comments = Object.freeze([...record.comments])
    return Object.freeze({
      ...record.thread,
      comments,
      anchoring: anchor,
      isOrphaned: anchor.status === 'orphaned',
      isResolved: record.thread.status === 'resolved',
      lastComment: comments[comments.length - 1]!,
      lastActivityAt: lastActivityOf(comments),
    }) as ThreadView
  }

  /**
   * §2.3 identity guarantee: every view is frozen and referentially stable until its record,
   * its comment list or its `Anchoring` changes, and the array itself is stable when no view
   * changed — so `===` diffing is correct without selectors.
   */
  function refreshViews(): void {
    const next: ThreadView[] = []
    const live = new Set<string>()
    for (const record of sortedRecords()) {
      const id = record.thread.id
      // §2.3: `ThreadView.lastComment` is non-nullable **by invariant**, so a record that has
      // no comments is skipped from the view entirely rather than surfaced with an undefined
      // `lastComment` behind a non-null assertion. `comment-ui` reads `t.lastComment.body`.
      if (record.comments.length === 0) continue
      live.add(id)
      const anchor = anchoring?.get(id) ?? PENDING
      const cached = viewCache.get(id)
      if (
        cached &&
        cached.thread === record.thread &&
        cached.comments === record.comments &&
        cached.anchoring === anchor
      ) {
        next.push(cached.view)
        continue
      }
      const view = makeView(record, anchor)
      viewCache.set(id, {
        view,
        thread: record.thread,
        comments: record.comments,
        anchoring: anchor,
      })
      next.push(view)
    }
    for (const id of Array.from(viewCache.keys())) if (!live.has(id)) viewCache.delete(id)

    const current = threadsStore.get()
    if (current.length === next.length && current.every((view, i) => view === next[i])) return
    threadsStore.set(Object.freeze(next))
  }

  function viewOf(threadId: string): ThreadView | null {
    return viewCache.get(threadId)?.view ?? null
  }

  /* ---------------------------------------------------------------------------- anchoring */

  function threadList(): Thread[] {
    return sortedRecords().map((record) => record.thread)
  }

  /** §4.2.6: within a batch, all `thread:orphaned` first, then all `thread:anchored`. */
  function emitTransitions(transitions: readonly AnchorTransition[]): void {
    // §4.2.2: the view already reflects the event when the listener runs. Unconditional,
    // because a pass with no *transition* can still have moved `confidence` or `range`.
    refreshViews()
    if (transitions.length === 0) return
    for (const transition of transitions) {
      if (transition.anchoring.status !== 'orphaned') continue
      const view = viewOf(transition.threadId)
      const record = records.get(transition.threadId)
      if (!view || !record) continue
      emit('thread:orphaned', {
        thread: record.thread,
        view,
        lastRect: transition.anchoring.rect,
      })
    }
    for (const transition of transitions) {
      const element = transition.anchoring.element
      if (transition.anchoring.status !== 'anchored' || !element) continue
      const view = viewOf(transition.threadId)
      const record = records.get(transition.threadId)
      if (!view || !record) continue
      emit('thread:anchored', {
        thread: record.thread,
        view,
        element,
        confidence: transition.anchoring.confidence,
        via: transition.anchoring.via!,
        previous: transition.previous,
      })
    }
  }

  function runPass(
    passOptions?: Parameters<NonNullable<typeof anchoring>['pass']>[1],
  ): AnchorTransition[] {
    if (!anchoring) return []
    anchoring.track(threadList())
    return anchoring.pass(threadList(), passOptions)
  }

  /* -------------------------------------------------------------------------- store loading */

  async function loadRecords(): Promise<Map<string, ThreadRecord>> {
    const list = await domain.list({ pageKey: currentPageKey })
    return new Map(list.map((record) => [record.thread.id, record]))
  }

  /**
   * §4.2.8 remote path: reload, diff against what we already hold, drop our own echoes by
   * origin token, then emit with `source: 'remote'`.
   */
  async function reload(): Promise<void> {
    if (destroyed || !started) return
    // Claim the tokens recorded so far. Local writes share this queue, so a write that raised
    // the notification behind this pass has already recorded its token by now.
    tokens.beginPass()
    const next = await loadRecords()
    if (destroyed) return

    let inputs: StoreEventInput[] = []
    if (primed) {
      inputs = diffSnapshots(snapshotOf(records), snapshotOf(next), {
        source: 'remote',
        isNew: () => true,
        reopensOnReply,
      }).filter((input) => !tokens.consume(input))
    }
    // §4.2.8: retire tokens whose echo never arrived, so a stale one cannot swallow the next
    // genuine remote change with the same key. A local write applies to `records` before this
    // pass takes its baseline, so its echo diff is usually empty and its token unconsumed.
    tokens.sweep()

    records = reconcile(records, next)
    const transitions = runPass()
    refreshViews()

    for (const input of inputs) {
      emit(input.type, input.payload as CommentEventMap[typeof input.type])
    }
    emitTransitions(transitions)
    primed = true
  }

  /**
   * One serial lane for everything that touches `records`: store reloads, page changes and the
   * engine's own imperative writes.
   *
   * Without it a store notification raised *by* a local write can be diffed while that write is
   * still between `store.putX()` and its local `upsertRecord`, so the engine re-emits its own
   * write as `source: 'remote'` before emitting it as `source: 'local'` — two events for one
   * write, in the wrong order, with §4.2.2's "the view already reflects the event" false for the
   * first one. Origin tokens cannot close that window on their own: they are recorded after the
   * domain call resolves, which is after the notification fires.
   */
  function enqueue<T>(run: () => Promise<T>): Promise<T> {
    const task = reloadQueue.then(run, run)
    reloadQueue = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  function scheduleReload(): void {
    void enqueue(() => reload()).catch((error: unknown) => reportUnknown(error, 'store'))
  }

  /* ------------------------------------------------------------------------ local mutations */

  function assertAlive(): void {
    if (destroyed) throw new CommentError('engine_destroyed')
  }

  /**
   * §4.2.1 persist-then-notify. A store rejection must (a) reject the imperative promise,
   * (b) emit exactly one `error` with phase `'store'`, and (c) leave the live view untouched —
   * (c) is free here because nothing optimistically mutates before the domain resolves.
   *
   * Only a genuine store fault takes the `error` channel: `thread_not_found` / `empty_body` /
   * `comment_not_found` are caller-visible rejections (§4.4) and `unsupported_version` already
   * reaches the bus once per record through `DomainOptions.onError` (§4.1 rule 16). Fanning
   * those into `error` would make `onError` unbindable to a pager, which is what §2.12 protects.
   */
  async function guarded<T>(threadId: string | undefined, run: () => Promise<T>): Promise<T> {
    try {
      return await run()
    } catch (error) {
      const wrapped = asCommentError(error)
      if (wrapped.code === 'store_failed' || wrapped.code === 'quota_exceeded') {
        emitError(wrapped, 'store', threadId ?? wrapped.threadId)
      }
      throw wrapped
    }
  }

  /** True when a thread belongs to the page this engine is currently showing. */
  function onCurrentPage(thread: { pageKey: string }): boolean {
    return thread.pageKey === currentPageKey
  }

  /**
   * Insert / replace a record locally and re-derive its anchoring before any event fires.
   *
   * Returns whether the record is now part of the live view. **The caller must not emit when it
   * is false**: §4.2.2 guarantees `getThreadView(id)` already reflects the event inside the
   * listener, and an off-page write has no view to reflect (the remote path cannot see one
   * either — it lists the current page only, so suppressing keeps local and remote symmetric).
   */
  function upsertRecord(thread: Thread, comments: readonly Comment[]): boolean {
    if (!onCurrentPage(thread)) return false
    // §2.3: a zero-comment record is not a view. Rules 2 and 7 make it impossible in the store;
    // it can still be *observed* transiently here when another context created the thread and
    // this engine's reload has not committed the comments yet.
    if (comments.length === 0) return false
    records.set(thread.id, { thread, comments: [...comments] })
    runPass({ only: thread.id, force: true })
    refreshViews()
    return true
  }

  function dropRecord(threadId: string): void {
    records.delete(threadId)
    anchoring?.forget(threadId)
    viewCache.delete(threadId)
    if (activeStore.get() === threadId) activeStore.set(null)
    refreshViews()
  }

  async function recordOf(threadId: string): Promise<ThreadRecord | null> {
    return records.get(threadId) ?? (await domain.get(threadId))
  }

  /**
   * The record straight off the port, unnarrowed. §4.1 rule 8 mandates one `thread:delete` for
   * every delete, and rule 16 makes `domain.get` return `null` for an unknown-version record —
   * but `delete()` is deliberately version-agnostic, so the host still needs the event
   * (§7.3 hangs `cancelRunsForThread` off it, and an uncancellable run is worse than a payload
   * carrying an unfamiliar `v`). `v` is carried through verbatim rather than restamped, so the
   * payload is never falsified.
   */
  async function rawRecordOf(threadId: string): Promise<ThreadRecord | null> {
    const stored = await tracked.getThread(threadId)
    if (!stored) return null
    return { thread: stored as Thread, comments: await tracked.listComments(threadId) }
  }

  async function doCreateThread(input: CreateThreadInput): Promise<CreateResult> {
    assertAlive()
    const result = await guarded(input.id, () => domain.createThread(input))
    // §4.1 rule 15: a deduped write performed nothing and emits nothing.
    if (result.deduped) return result
    tokens.record('t', result.thread.id)
    tokens.record('c', result.comment.id)
    if (!upsertRecord(result.thread, [result.comment])) return result
    emit('thread:create', { thread: result.thread, comment: result.comment, source: 'local' })
    return result
  }

  async function doAppendComment(
    threadId: string,
    input: AppendCommentInput,
  ): Promise<AppendResult> {
    assertAlive()
    const before = records.get(threadId)
    const result = await guarded(threadId, () => domain.appendComment(threadId, input))
    if (result.deduped) return result
    if (result.reopened) tokens.record('t', threadId)
    tokens.record('c', result.comment.id)

    const known =
      before?.comments ?? (await guarded(threadId, () => domain.get(threadId)))?.comments ?? []
    const comments = [...known]
    if (!comments.some((c) => c.id === result.comment.id)) comments.push(result.comment)
    if (!upsertRecord(result.thread, comments.sort(compareRecords))) return result

    // §4.2.4 state precedes content.
    if (result.reopened) {
      emit('thread:reopen', { thread: result.thread, reason: 'reply', source: 'local' })
    }
    emit('thread:reply', { thread: result.thread, comment: result.comment, source: 'local' })
    return result
  }

  async function doEditComment(ref: CommentRef, body: string): Promise<Comment> {
    assertAlive()
    const previous = findLocalComment(ref)
    const comment = await guarded(undefined, () => domain.editComment(ref, body))
    tokens.record('e', comment.id)
    const record = await guarded(comment.threadId, () => recordOf(comment.threadId))
    if (record) {
      const comments = record.comments.map((c) => (c.id === comment.id ? comment : c))
      if (upsertRecord(record.thread, comments)) {
        emit('comment:edit', {
          thread: record.thread,
          comment,
          previousBody: previous?.body ?? '',
          source: 'local',
        })
      }
    }
    return comment
  }

  async function doDeleteComment(ref: CommentRef): Promise<DeleteCommentResult> {
    assertAlive()
    const before = findLocalComment(ref)
    const threadIdHint = before?.threadId ?? (typeof ref === 'object' ? ref.threadId : undefined)
    const priorRecord = threadIdHint ? records.get(threadIdHint) : undefined
    const result = await guarded(threadIdHint, () => domain.deleteComment(ref))
    tokens.record('x', result.comment.id)

    const threadId = result.comment.threadId
    const record = priorRecord ?? records.get(threadId)
    if (result.threadDeleted) {
      tokens.record('d', threadId)
      const thread = result.thread ?? record?.thread ?? null
      const visible = records.has(threadId)
      dropRecord(threadId)
      if (!visible) return result
      // §4.2.5 deletion order: comment:delete → thread:delete (reason 'empty').
      emit('comment:delete', {
        thread: null,
        comment: result.comment,
        threadDeleted: true,
        source: 'local',
      })
      if (thread) {
        emit('thread:delete', {
          thread,
          comments: [result.comment],
          reason: 'empty',
          source: 'local',
        })
      }
      return result
    }

    if (!record) return result
    if (
      !upsertRecord(
        result.thread ?? record.thread,
        record.comments.filter((c) => c.id !== result.comment.id),
      )
    ) {
      return result
    }
    emit('comment:delete', {
      thread: result.thread,
      comment: result.comment,
      threadDeleted: false,
      source: 'local',
    })
    return result
  }

  function findLocalComment(ref: CommentRef): Comment | null {
    const id = typeof ref === 'string' ? ref : ref.id
    if (typeof ref === 'object') {
      return records.get(ref.threadId)?.comments.find((c) => c.id === id) ?? null
    }
    for (const record of records.values()) {
      const hit = record.comments.find((c) => c.id === id)
      if (hit) return hit
    }
    return null
  }

  /**
   * The record is carried whole, not just its `thread`: `upsertRecord` needs the comment list,
   * and `records.get(id)` can legitimately be empty here (another context created the thread and
   * this engine's reload has not committed yet) — feeding it `[]` builds a `ThreadView` whose
   * `lastComment` is `undefined`, which §2.3 declares impossible.
   */
  async function transitionThread(
    threadId: string,
    apply: () => Promise<Thread>,
    event: 'thread:resolve' | 'thread:reopen',
  ): Promise<Thread> {
    const before = await guarded(threadId, () => recordOf(threadId))
    const thread = await guarded(threadId, apply)
    if (!before || before.thread.status === thread.status) return thread
    tokens.record('t', threadId)
    const comments = records.get(threadId)?.comments ?? before.comments
    if (!upsertRecord(thread, comments)) return thread
    if (event === 'thread:resolve') emit('thread:resolve', { thread, source: 'local' })
    else emit('thread:reopen', { thread, reason: 'explicit', source: 'local' })
    return thread
  }

  async function doResolveThread(threadId: string): Promise<Thread> {
    assertAlive()
    return transitionThread(threadId, () => domain.resolve(threadId), 'thread:resolve')
  }

  async function doReopenThread(threadId: string): Promise<Thread> {
    assertAlive()
    return transitionThread(threadId, () => domain.reopen(threadId), 'thread:reopen')
  }

  async function doDeleteThread(threadId: string): Promise<void> {
    assertAlive()
    const record = await guarded(
      threadId,
      async () => (await recordOf(threadId)) ?? (await rawRecordOf(threadId)),
    )
    await guarded(threadId, () => domain.delete(threadId))
    tokens.record('d', threadId)
    dropRecord(threadId)
    // §4.1 rule 8: one `thread:delete` carrying the full comment list, after the cascade —
    // including for a record `domain.get` refuses to narrow (rule 16), which `delete()` is
    // deliberately allowed to remove.
    if (record && onCurrentPage(record.thread)) {
      emit('thread:delete', {
        thread: record.thread,
        comments: record.comments,
        reason: 'explicit',
        source: 'local',
      })
    }
  }

  /**
   * The §2.9 write surface. Every one of these runs inside `enqueue`, so a store notification
   * raised by the write can never be diffed and re-emitted before the write's own local event.
   * `assertAlive()` lives in the inner body, so a post-`destroy()` call **rejects** rather than
   * throwing synchronously (§4.4) and no call site needs a try/catch as well as a `.catch()`.
   */
  const createThread = (input: CreateThreadInput): Promise<CreateResult> =>
    enqueue(() => doCreateThread(input))
  const appendComment = (threadId: string, input: AppendCommentInput): Promise<AppendResult> =>
    enqueue(() => doAppendComment(threadId, input))
  const editComment = (ref: CommentRef, body: string): Promise<Comment> =>
    enqueue(() => doEditComment(ref, body))
  const deleteComment = (ref: CommentRef): Promise<DeleteCommentResult> =>
    enqueue(() => doDeleteComment(ref))
  const resolveThread = (threadId: string): Promise<Thread> =>
    enqueue(() => doResolveThread(threadId))
  const reopenThread = (threadId: string): Promise<Thread> =>
    enqueue(() => doReopenThread(threadId))
  const deleteThread = (threadId: string): Promise<void> => enqueue(() => doDeleteThread(threadId))

  /* -------------------------------------------------------------------------- placement */

  const captureOptions = (): CaptureOptions => ({
    ...opts.capture,
    ...(doc ? { document: doc } : {}),
    ...(opts.anchoring?.strategies ? { strategies: opts.anchoring.strategies } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  })

  const placement = createPlacementController({
    document: () => doc,
    modes: () => modes,
    emit,
    emitError: (error, phase, threadId) => emitError(error, phase, threadId),
    // §4.6 step 0: the click point rides along, so `captureTarget` can assess the target and
    // store `AnchorDescriptor.point` relative to whatever element it decides the thread is about.
    capture: (target, point) =>
      captureTarget(target, point ? { ...captureOptions(), point } : captureOptions()),
    kindOfThread: (threadId) => records.get(threadId)?.thread.kind ?? null,
    submitNew: (input) =>
      createThread({
        pageKey: currentPageKey,
        kind: input.kind,
        anchor: input.anchor,
        capture: input.capture,
        author: 'user',
        body: input.body,
      }),
    submitReply: (threadId, body) => appendComment(threadId, { author: 'user', body }),
    tick: () => navigation?.poll(),
    alive: () => !destroyed,
  })

  /* -------------------------------------------------------------------------- navigation */

  async function applyPage(href: string, initial: boolean): Promise<void> {
    const previous = currentPageKey || null
    let key = currentPageKey
    try {
      key = pageKeyFn(new URL(href))
    } catch {
      key = href
    }
    const changed = key !== currentPageKey
    currentPageKey = key
    pageStore.set({ key, url: href })
    if (!changed && !initial) return

    if (!initial) {
      // §4.5: placement is cancelled automatically on page:change.
      placement.cancel('navigation')
      records = new Map()
      viewCache.clear()
      activeStore.set(null)
      anchoring?.reset()
      primed = false
      threadsStore.set(EMPTY_VIEWS)
      // The page-scoped subscription has to follow the page.
      storeUnsubscribe?.()
      storeUnsubscribe = tracked.subscribe(currentPageKey, scheduleReload)
    }

    records = await loadRecords()
    primed = true
    refreshViews()

    // §4.2.10: `page:change` is emitted after the old page's threads are unloaded and the new
    // set has completed its first resolution pass; `thread:anchored` always follows it.
    anchoring?.completeFirstPass()
    const transitions = runPass({ force: true })
    refreshViews()
    if (!initial) emit('page:change', { pageKey: key, previous, url: href })
    emitTransitions(transitions)
  }

  /* -------------------------------------------------------------------------- lifecycle */

  async function bootstrap(): Promise<void> {
    const document_ = doc
    if (!document_) return
    statusStore.set('loading')
    records = await loadRecords()
    if (destroyed) return
    primed = true
    refreshViews() // every thread is `pending`: comment-ui renders nothing for it (§3)

    const finish = async (): Promise<void> => {
      if (destroyed || !started) return
      // §4.2.6: opening the gate immediately before the first full-document pass is what makes
      // "pending → orphaned fires only after the first full pass" observable — no batch before
      // this point can emit an orphan.
      anchoring?.completeFirstPass()
      const transitions = runPass({ force: true })
      refreshViews()
      emitTransitions(transitions)
      statusStore.set('ready')
      readyResolve()
    }

    // §4.2.6: the content script is registered at document_start, so `start()` normally runs
    // against an empty <html>. Threads still anchor incrementally via the observer (emitting
    // only `thread:anchored`); the first FULL pass waits for a parsed document.
    // Both halves of the test matter: `readyState` is sampled at `start()` (the content script
    // runs at document_start) AND re-checked here, because parsing can finish during the store
    // load — and a `DOMContentLoaded` listener registered after the event has fired would never
    // run, leaving `ready()` pending forever.
    if (startedWhileParsing && document_.readyState === 'loading') {
      document_.addEventListener(
        'DOMContentLoaded',
        () => void finish().catch((error: unknown) => reportUnknown(error, 'anchor')),
        {
          once: true,
        },
      )
      // An incremental pass right away, so anything already parsed anchors without waiting.
      emitTransitions(runPass())
      refreshViews()
    } else {
      await finish()
    }
  }

  function start(): void {
    if (destroyed) throw new CommentError('engine_destroyed')
    if (started) return
    const document_ = opts.document ?? (globalThis as { document?: Document }).document
    if (!document_?.documentElement) {
      throw new CommentError('no_document', 'start() found no usable document')
    }
    doc = document_
    started = true
    startedWhileParsing = document_.readyState === 'loading'
    // `ready()` describes *this* run: a stop()/start() cycle re-arms it rather than handing
    // back a promise that settled for the previous document.
    readyPromise = new Promise<void>((resolve) => {
      readyResolve = resolve
    })

    navigation = createNavigationWatcher({
      document: document_,
      config: opts.navigation,
      // Queued with the reloads: a page change and a store notification must never interleave,
      // and `ready()`-style callers can await the same tail.
      onChange: (href) => {
        void enqueue(() => applyPage(href, false)).catch((error: unknown) =>
          reportUnknown(error, 'store'),
        )
      },
      onError: (error) => reportUnknown(error, 'anchor'),
    })

    anchoring = createAnchoringController({
      document: document_,
      options: opts.anchoring,
      threads: threadList,
      onBatch: (transitions) => emitTransitions(transitions),
      onTick: () => navigation?.poll(),
      onError: (error) => reportUnknown(error, 'anchor'),
    })

    let href = navigation.href()
    if (!href) href = document_.URL ?? ''
    try {
      currentPageKey = pageKeyFn(new URL(href))
    } catch {
      currentPageKey = href
    }
    pageStore.set({ key: currentPageKey, url: href })

    storeUnsubscribe = tracked.subscribe(currentPageKey, scheduleReload)
    anchoring.observe()
    placement.attach()

    // Same lane as reloads and writes: a write issued straight after `createCommentEngine()`
    // must not race the initial load into overwriting `records` behind its back.
    void enqueue(() => bootstrap()).catch((error: unknown) => {
      reportUnknown(error, 'store')
      statusStore.set('ready')
      readyResolve()
    })
  }

  function stop(): void {
    if (!started) return
    started = false
    placement.cancel('stop')
    placement.detach()
    anchoring?.disconnect()
    navigation?.stop()
    storeUnsubscribe?.()
    storeUnsubscribe = null
    navigation = null
    if (!destroyed) statusStore.set('idle')
  }

  function destroy(): void {
    if (destroyed) return
    stop()
    destroyed = true
    anchoring?.reset()
    anchoring = null
    tokens.clear()
    records = new Map()
    viewCache.clear()
    threadsStore.set(EMPTY_VIEWS)
    activeStore.set(null)
    statusStore.set('destroyed')
    // §4.2.11: destruction is synchronous and observable from the return; no event follows it.
    readyResolve()
    bus.clear()
  }

  /* -------------------------------------------------------------------------- public API */

  function matchesFilter(view: ThreadView, filter?: EngineThreadFilter): boolean {
    if (!filter) return true
    if (
      filter.pageKey !== undefined &&
      filter.pageKey !== null &&
      filter.pageKey !== view.pageKey
    ) {
      return false
    }
    if (filter.status && view.status !== filter.status) return false
    if (filter.anchor && view.anchoring.status !== filter.anchor) return false
    if (filter.since && view.createdAt < filter.since) return false
    if (filter.kind !== undefined) {
      const kinds = typeof filter.kind === 'string' ? [filter.kind] : filter.kind
      if (!kinds.includes(view.kind)) return false
    }
    if (filter.author && !view.comments.some((c) => c.author === filter.author)) return false
    return true
  }

  const engine: CommentEngine<S> = {
    store,
    get pageKey() {
      return currentPageKey
    },
    page: readonlyStore(pageStore),
    get modes() {
      return modes
    },
    status: readonlyStore(statusStore),
    threads: readonlyStore(threadsStore),
    active: readonlyStore(activeStore),
    placement,

    /* --- CommentDomain --- */
    createThread,
    appendComment,
    editComment,
    deleteComment,
    resolve: resolveThread,
    reopen: reopenThread,
    delete: deleteThread,
    // §4.4: post-`destroy()` calls **reject** — they never throw synchronously, so a caller's
    // `.catch()` is enough and no call site needs a try/catch as well.
    async get(threadId) {
      assertAlive()
      return domain.get(threadId)
    },
    async list(filter?: ThreadFilter) {
      assertAlive()
      // §2.9: `CommentEngine` defaults to the engine's CURRENT pageKey.
      return domain.list(
        filter?.pageKey === undefined ? { ...filter, pageKey: currentPageKey } : filter,
      )
    },

    /* --- live reads --- */
    listThreads(filter) {
      return threadsStore.get().filter((view) => matchesFilter(view, filter))
    },
    getThreadView: (id) => viewOf(id),
    ready: () => readyPromise,

    /* --- placement --- */
    // §4.4: after `destroy()` this is a no-op returning false — `placement.start` is gated on
    // the engine being alive, so it can neither drive the controller nor emit.
    startPlacement: (kind) => placement.start(kind),
    setModes(next) {
      // §4.4: post-`destroy()` calls report `engine_destroyed`. Synchronous, like `start()`.
      assertAlive()
      assertUniqueTriggers(next)
      modes = next
      placement.refreshModes()
      if (started) {
        placement.detach()
        placement.attach()
      }
    },

    /* --- anchoring --- */
    async reanchor(threadId) {
      assertAlive()
      if (!anchoring) return
      const transitions = runPass(threadId ? { only: threadId, force: true } : { force: true })
      emitTransitions(transitions)
    },

    focus(threadId, focusOptions) {
      const view = viewOf(threadId)
      if (!view) return false
      const element = view.anchoring.element
      if (view.anchoring.status !== 'anchored' || !element) return false
      activeStore.set(threadId)
      const scroll = focusOptions?.scroll ?? true
      if (scroll !== false) {
        try {
          element.scrollIntoView(typeof scroll === 'object' ? scroll : { block: 'center' })
        } catch {
          // A DOM without a scroller must not fail a focus().
        }
      }
      const record = records.get(threadId)
      if (record) emit('thread:click', { thread: record.thread, view, element })
      return true
    },

    explain(threadId, explainOptions): AnchorExplanation | null {
      const record = records.get(threadId)
      if (!anchoring || !record) return null
      // §2.11: cached by default — free to call from a `thread:anchored` listener.
      if (!explainOptions?.fresh) return anchoring.explanationOf(threadId)
      return anchoring.trace(record.thread)
    },

    /* --- events --- */
    on: (event, listener, listenerOptions) => bus.on(event, listener, listenerOptions),
    once: (event, listener) => bus.once(event, listener),
    off: (event, listener) => bus.off(event, listener),
    subscribe: (listener) => bus.subscribe(listener),

    start,
    stop,
    destroy,

    inspect(): EngineInspection {
      const counts = bus.counts()
      const listeners = {} as Record<CommentEventName | '*', number>
      listeners['*'] = counts['*'] ?? 0
      for (const name of ALL_EVENT_NAMES) listeners[name] = counts[name] ?? 0

      return {
        version: VERSION,
        pageKey: currentPageKey,
        modes,
        store: {
          name: store.name ?? 'anonymous',
          reads: counters.reads,
          writes: counters.writes,
          lastError: counters.lastError,
        },
        threads: threadsStore.get().map((view) => ({
          id: view.id,
          kind: view.kind,
          status: view.status,
          comments: view.comments.length,
          anchor: view.anchoring.status,
          confidence: view.anchoring.confidence,
          via: view.anchoring.via,
        })),
        anchoring: {
          observing: anchoring?.observing ?? false,
          batches: anchoring?.batches ?? 0,
          lastBatchMs: anchoring?.lastBatchMs ?? 0,
          pending: anchoring?.pending ?? 0,
        },
        listeners,
        strategies: (anchoring?.stats() ?? []).map((stat) => ({
          type: stat.type,
          weight: stat.weight,
          hits: stat.hits,
          misses: stat.misses,
          avgMs: stat.runs === 0 ? 0 : stat.totalMs / stat.runs,
        })),
      }
    },
  }

  /**
   * Internal test/fixture seam (`engine/internals.ts` — kept out of `engine/index.ts` precisely
   * so the public barrel's `export *` cannot pick it up).
   */
  Object.defineProperty(engine, INTERNALS, {
    value: {
      flush(): boolean {
        return anchoring?.flush() ?? false
      },
      pass(): void {
        emitTransitions(runPass({ force: true }))
      },
      poll(): void {
        navigation?.poll()
      },
      settled(): Promise<void> {
        return reloadQueue
      },
    } satisfies EngineInternals,
    enumerable: false,
  })

  if (opts.autoStart !== false) start()
  return engine
}

function asCommentError(error: unknown): CommentError {
  if (CommentError.is(error)) return error
  return new CommentError('store_failed', error instanceof Error ? error.message : String(error), {
    cause: error,
  })
}

/* The engine's public type surface (§2.3, §2.11–§2.15). Everything here names a `lib.dom`
   identifier, which is why it lives beside the engine rather than in `src/types.ts` (§1.1). */
export type {
  Anchoring,
  AnchoringOptions,
  CommentEngine,
  CommentEngineOptions,
  CommentEvent,
  CommentEventMap,
  CommentEventName,
  EngineInspection,
  EngineOnlyEventMap,
  EngineThreadFilter,
  Mode,
  PlacementController,
  PlacementState,
  PlacementTarget,
  ThreadView,
  TriggerSpec,
} from './types.ts'
