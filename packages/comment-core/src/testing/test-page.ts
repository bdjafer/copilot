/**
 * `createTestPage` (§2.16) — the happy-dom fixture: build a page, drive the engine, flush the
 * anchoring batch.
 *
 * **The only DOM-requiring export of `comment-core/testing`**, and the only reason `happy-dom`
 * is an optional peer dependency (§1.1). Absent ⇒ `CommentError('invalid_options')` with an
 * install hint.
 *
 * **Deviation, documented.** §2.16 locks `createTestPage` as a **synchronous** function that
 * hands back a `Document`. `happy-dom` is ESM-only, so its `Window` cannot be constructed from
 * a synchronous function without a top-level `import` — which would make the optional peer a
 * hard dependency of `comment-core/testing` and break `storeConformance` /
 * `domainConformance`'s "DOM-free, needs no peer" guarantee. The fixture therefore drives the
 * **ambient** happy-dom document (vitest `environment: 'happy-dom'`, or any host that installed
 * one), which is how every runner that can run this suite is configured anyway.
 */

import type { CommentEngine, CommentEngineOptions } from '../engine/types.ts'

import { createCommentEngine } from '../engine/index.ts'
import { engineInternals } from '../engine/internals.ts'
import { CommentError } from '../errors.ts'

const INSTALL_HINT =
  'createTestPage requires happy-dom: install it (`pnpm add -D happy-dom`) and run the suite ' +
  'under a happy-dom DOM environment (vitest: `test.environment = "happy-dom"`).'

export interface TestPage {
  document: Document
  engine(options?: CommentEngineOptions): CommentEngine
  /** Applies the mutation and awaits the next anchoring flush. */
  mutate(fn: (doc: Document) => void): Promise<void>
  navigate(url: string): Promise<void>
  /** Awaits pending store writes + one anchoring flush. */
  flush(): Promise<void>
  dispose(): Promise<void>
}

interface HappyDomHandle {
  setURL?: (url: string) => void
}

function ambientDocument(): Document {
  const doc = (globalThis as { document?: Document }).document
  if (!doc?.documentElement || typeof doc.createRange !== 'function') {
    throw new CommentError('invalid_options', INSTALL_HINT)
  }
  return doc
}

function setUrl(doc: Document, url: string): void {
  const handle = (globalThis as { happyDOM?: HappyDomHandle }).happyDOM
  if (typeof handle?.setURL === 'function') {
    handle.setURL(url)
    return
  }
  try {
    doc.defaultView?.history?.pushState({}, '', url)
  } catch {
    throw new CommentError('invalid_options', INSTALL_HINT)
  }
}

/** happy-dom delivers MutationObserver records on a microtask; give it both turns. */
async function settleDom(): Promise<void> {
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export function createTestPage(html: string, options?: { url?: string }): TestPage {
  const doc = ambientDocument()
  if (options?.url) setUrl(doc, options.url)
  doc.body.innerHTML = html

  const engines: CommentEngine[] = []

  async function flush(): Promise<void> {
    await settleDom()
    for (const engine of engines) {
      const internals = engineInternals(engine)
      if (!internals) continue
      await internals.settled()
      internals.poll()
      internals.flush()
      await internals.settled()
    }
    await settleDom()
    for (const engine of engines) {
      const internals = engineInternals(engine)
      if (!internals) continue
      // Deterministic tail. `MutationObserver` delivery timing is the one thing no DOM
      // emulator reproduces faithfully, and a fixture whose `mutate()` sometimes misses a
      // batch is worse than useless. When the observer has nothing pending, run the pass the
      // batch would have run — it emits transitions only, so the result is identical to the
      // observer-driven path, never additional events.
      if (!internals.flush()) internals.pass()
      await internals.settled()
    }
  }

  return {
    document: doc,

    engine(engineOptions) {
      const engine = createCommentEngine({ ...engineOptions, document: doc })
      engines.push(engine)
      return engine
    },

    async mutate(fn) {
      fn(doc)
      await flush()
    },

    async navigate(url) {
      setUrl(doc, url)
      for (const engine of engines) engineInternals(engine)?.poll()
      await flush()
    },

    flush,

    async dispose() {
      for (const engine of engines.splice(0)) engine.destroy()
      doc.body.innerHTML = ''
      await settleDom()
    },
  }
}
