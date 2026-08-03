/** Shared scaffolding for the comment-ui suite. Not a test file. */

import type {
  CommentEngine,
  CommentEngineOptions,
  MemoryStore,
  Mode,
} from '@astrale-os/comment-core'

import { captureTarget, createMemoryStore } from '@astrale-os/comment-core'
import { createTestPage } from '@astrale-os/comment-core/testing'

import type { CommentUI, CommentUIOptions } from '../src/index.ts'

import { mountCommentUI } from '../src/index.ts'

export const PAGE_URL = 'https://example.com/doc'

export const MODES: readonly Mode[] = [
  { kind: 'comment', trigger: { key: 'c', interaction: 'pick' } },
  { kind: 'ask', trigger: { key: 'a', interaction: 'pick' }, badge: { icon: '?', label: 'Ask' } },
  { kind: 'triage', trigger: false },
]

export interface Scene {
  page: ReturnType<typeof createTestPage>
  engine: CommentEngine
  store: MemoryStore
  ui: CommentUI
  root: ShadowRoot
  doc: Document
  /** Seed a thread anchored on `selector`. Returns the thread id. */
  seed(selector: string, body?: string, over?: { kind?: string }): Promise<string>
  /** Flush the anchoring batch and the renderer's coalesced microtask. */
  settle(): Promise<void>
  dispose(): Promise<void>
}

/** The renderer coalesces onto a microtask; floating-ui resolves on a promise. */
export async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export async function scene(
  html: string,
  options?: {
    engine?: CommentEngineOptions
    ui?: CommentUIOptions
    url?: string
  },
): Promise<Scene> {
  const page = createTestPage(html, { url: options?.url ?? PAGE_URL })
  const store = createMemoryStore()
  const engine = page.engine({ store, modes: MODES, ...options?.engine })
  await engine.ready()
  await page.flush()

  const ui = mountCommentUI(engine, options?.ui)
  await tick()

  const settle = async (): Promise<void> => {
    await page.flush()
    await tick()
  }

  return {
    page,
    engine,
    store,
    ui,
    root: ui.root,
    doc: page.document,
    async seed(selector, body = 'first comment', over) {
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
      await settle()
      return result.thread.id
    },
    settle,
    async dispose() {
      ui.unmount()
      await page.dispose()
    },
  }
}

export function $(root: ParentNode, selector: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(selector)
}

export function $$(root: ParentNode, selector: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector))
}

export function badges(root: ParentNode): HTMLElement[] {
  return $$(root, '.cc-badge')
}

export function badgeOf(root: ParentNode, threadId: string): HTMLElement | null {
  return $(root, `.cc-badge[data-thread="${threadId}"]`)
}

export function click(node: Element | null): void {
  if (!node) throw new Error('click target missing')
  node.dispatchEvent(
    new (node.ownerDocument.defaultView as Window & typeof globalThis).MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      composed: true,
    }),
  )
}

export function press(node: Element | null, key: string, init: KeyboardEventInit = {}): boolean {
  if (!node) throw new Error('keydown target missing')
  const view = node.ownerDocument.defaultView as Window & typeof globalThis
  return node.dispatchEvent(
    new view.KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ...init,
    }),
  )
}

export function type(input: HTMLTextAreaElement, value: string): void {
  input.value = value
  const view = input.ownerDocument.defaultView as Window & typeof globalThis
  input.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }))
}

/* --------------------------------------------------------------- IntersectionObserver stub */

export interface FakeIntersection {
  /** Drive every observer watching `element`. */
  set(element: Element, isIntersecting: boolean): void
  readonly observed: Set<Element>
  /** Total `observe()` calls — a re-observation is a leaked/restarted watcher. */
  readonly observeCalls: () => number
  restore(): void
}

/**
 * happy-dom ships an `IntersectionObserver` that never invokes its callback, so the off-screen
 * skip is unobservable without a stub. This one records observations and lets a test drive
 * them, which is exactly the seam `watchVisibility` is written against.
 */
export function fakeIntersectionObserver(): FakeIntersection {
  const target = globalThis as unknown as { IntersectionObserver: unknown }
  const original = target.IntersectionObserver
  const entries = new Map<Element, Set<(isIntersecting: boolean) => void>>()
  const observed = new Set<Element>()
  let calls = 0

  class Fake {
    constructor(private readonly callback: (records: { isIntersecting: boolean }[]) => void) {}
    observe(element: Element): void {
      calls += 1
      observed.add(element)
      const set = entries.get(element) ?? new Set()
      set.add((isIntersecting) => {
        this.callback([{ isIntersecting }])
      })
      entries.set(element, set)
    }
    unobserve(): void {}
    disconnect(): void {
      entries.clear()
    }
  }

  target.IntersectionObserver = Fake

  return {
    observed,
    observeCalls: () => calls,
    set(element, isIntersecting) {
      for (const notify of entries.get(element) ?? []) notify(isIntersecting)
    },
    restore() {
      target.IntersectionObserver = original
    },
  }
}
