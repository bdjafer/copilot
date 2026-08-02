/**
 * DoD fixture: a service-worker-shaped consumer of `comment-core/headless`.
 *
 * Typechecked under `lib: ["ES2022", "WebWorker"]` with `types: []` — no `lib.dom` anywhere.
 * The failure this catches is a compile error, not a crash, so deleting runtime globals is not
 * enough: if any type reachable from `headless.ts` named `Element`, `Range`, `Document`,
 * `ParentNode` or `Selection`, this file would not compile.
 *
 * It is deliberately the §7.3 bridge sketch, minus the platform.
 */

// Engine-internal, but both are supposed to be DOM-free too.
import { createEmitter } from '../../../src/emitter.ts'
import {
  createDomain,
  createKeyValueCursor,
  createKeyValueStore,
  createLocalStorageStore,
  createMemoryStore,
  defaultPageKey,
  observeStore,
  type Author,
  type CommentStore,
  type KeyValueAdapter,
  type StoreEvent,
  type Thread,
  type ThreadRecord,
} from '../../../src/headless.ts'
import { writable } from '../../../src/readable.ts'

declare const kv: KeyValueAdapter

const store: CommentStore = createKeyValueStore(kv, { namespace: 'exp-spec' })
const comments = createDomain(store, { reopensOnReply: (author: Author) => author === 'user' })

export async function dispatch(thread: Thread, body: string, runId: string): Promise<void> {
  if (!(await comments.get(thread.id))) return // deleted mid-run → drop the output
  await comments.appendComment(thread.id, { author: 'copilot', body, id: `r:${runId}` })
}

export const unsubscribe = observeStore(
  store,
  async (event: StoreEvent) => {
    if (event.type !== 'thread:create' && event.type !== 'thread:reply') return
    const { thread, comment } = event.payload
    if (comment.author !== 'user') return // the author field is the ONLY trigger-loop guard
    await dispatch(thread, comment.body, thread.id)
  },
  { cursor: createKeyValueCursor(kv, { namespace: 'exp-spec:host', id: 'dispatch' }) },
)

export async function report(): Promise<ThreadRecord[]> {
  return comments.list({ pageKey: defaultPageKey(new URL('https://example.com/a?utm_source=x')) })
}

export const scratch = {
  memory: createMemoryStore(),
  local: createLocalStorageStore(),
  bus: createEmitter<{ ping: number }>(),
  cell: writable(0),
}
