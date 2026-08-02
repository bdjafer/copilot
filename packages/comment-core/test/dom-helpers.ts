/** Shared DOM-half test scaffolding. Not a test file. */

import type {
  CommentEngine,
  CommentEngineOptions,
  CommentEvent,
  MemoryStore,
} from '../src/index.ts'

import { captureTarget, createMemoryStore } from '../src/index.ts'
import { createTestPage } from '../src/testing/test-page.ts'

export const PAGE_URL = 'https://example.com/doc'

export interface Harness {
  page: ReturnType<typeof createTestPage>
  engine: CommentEngine
  store: MemoryStore
  events: CommentEvent[]
  /** Events of one type, in emission order. */
  typed<T extends CommentEvent['type']>(type: T): Array<Extract<CommentEvent, { type: T }>>
  /** Event type names in emission order. */
  names(): string[]
  seed(selector: string, body?: string, over?: { kind?: string }): Promise<string>
  flush(): Promise<void>
  dispose(): Promise<void>
}

export async function harness(
  html: string,
  options?: CommentEngineOptions & { url?: string; store?: MemoryStore },
): Promise<Harness> {
  const page = createTestPage(html, { url: options?.url ?? PAGE_URL })
  const store = options?.store ?? createMemoryStore()
  const engine = page.engine({ ...options, store })
  const events: CommentEvent[] = []
  engine.subscribe((event) => events.push(event))
  await engine.ready()
  await page.flush()
  events.length = 0

  return {
    page,
    engine,
    store,
    events,
    typed(type) {
      return events.filter((event) => event.type === type) as never
    },
    names: () => events.map((event) => event.type),
    async seed(selector, body = 'first', over) {
      const target = page.document.querySelector(selector)
      if (!target) throw new Error(`no element for ${selector}`)
      const { anchor, capture } = captureTarget(target, { document: page.document })
      const result = await engine.createThread({
        pageKey: engine.pageKey,
        kind: over?.kind ?? 'comment',
        anchor,
        capture,
        author: 'user',
        body,
      })
      return result.thread.id
    },
    flush: () => page.flush(),
    dispose: () => page.dispose(),
  }
}

/** A store whose `subscribe` fan-out is under the test's control, to simulate another tab. */
export function remoteEcho(store: MemoryStore): () => void {
  return () => {
    // `createMemoryStore` already notifies on every write; this is the explicit poke a test
    // uses after mutating the store behind the engine's back.
    void store.listAllThreads()
  }
}
