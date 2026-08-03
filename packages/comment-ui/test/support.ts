/**
 * Shared scaffolding for the comment-ui suite. Not a test file.
 *
 * Two scenes, and the split is the migration (§3.1.9):
 *
 *  - `scene()` mounts with `presentation: null` and hands back `vm` + `intents`. **A controller
 *    test drives those and never queries presentation markup** — the only shadow nodes it may
 *    look at are the two the *controller* owns, `.cc-layer` (which it marks `data-picking`) and
 *    `.cc-status` (which it writes announcements into).
 *  - `domScene()` mounts the default presentation, for the four cases that exist to pin its now
 *    frozen markup.
 */

import type {
  CommentEngine,
  CommentEngineOptions,
  MemoryStore,
  Mode,
} from '@astrale-os/comment-core'

import { captureTarget, createMemoryStore } from '@astrale-os/comment-core'
import { createTestPage } from '@astrale-os/comment-core/testing'

import type { CommentUI, CommentUIController, CommentUIOptions } from '../src/index.ts'
import type { Intents, Presentation, UIViewModel } from '../src/presentation.ts'

import { createCommentUIController, mountCommentUI } from '../src/index.ts'

export const PAGE_URL = 'https://example.com/doc'

export const MODES: readonly Mode[] = [
  { kind: 'comment', trigger: { key: 'c', interaction: 'pick' } },
  { kind: 'ask', trigger: { key: 'a', interaction: 'pick' }, badge: { icon: '?', label: 'Ask' } },
  { kind: 'triage', trigger: false },
]

export interface SceneOptions {
  engine?: CommentEngineOptions
  ui?: CommentUIOptions
  url?: string
}

export interface BaseScene {
  page: ReturnType<typeof createTestPage>
  engine: CommentEngine
  store: MemoryStore
  root: ShadowRoot
  doc: Document
  /**
   * Seed a thread anchored on `selector`. Returns the thread id. `point` is the click that
   * placed it (SPEC §2.4 `AnchorDescriptor.point`); without it the record is a pre-#42 one and
   * every surface falls back to the anchor rect exactly as it did.
   */
  seed(
    selector: string,
    body?: string,
    over?: { kind?: string; point?: { clientX: number; clientY: number } },
  ): Promise<string>
  /** Flush the anchoring batch and the controller's coalesced microtask. */
  settle(): Promise<void>
  dispose(): Promise<void>
}

export interface Scene extends BaseScene {
  ui: CommentUIController
  /** The last published model. */
  vm(): UIViewModel
  intents: Intents
}

export interface DomScene extends BaseScene {
  ui: CommentUI
}

/** The controller coalesces onto a microtask; the positioner resolves on a promise. */
export async function tick(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

async function base(
  html: string,
  options: SceneOptions | undefined,
  mount: (engine: CommentEngine, ui: CommentUIOptions | undefined) => CommentUI,
): Promise<BaseScene & { ui: CommentUI }> {
  const page = createTestPage(html, { url: options?.url ?? PAGE_URL })
  const store = createMemoryStore()
  const engine = page.engine({ store, modes: MODES, ...options?.engine })
  await engine.ready()
  await page.flush()

  const ui = mount(engine, options?.ui)
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
      const { anchor, capture } = captureTarget(target, {
        document: page.document,
        ...(over?.point ? { point: over.point } : {}),
      })
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

/** A headless mount: no presentation at all, `vm` and `intents` fully live. */
export async function scene(html: string, options?: SceneOptions): Promise<Scene> {
  // `presentation: null` is the default here and an explicit one in `options.ui` wins, so a
  // controller test that needs the probe can ask for it without a second scene helper.
  const built = await base(html, options, (engine, ui) =>
    createCommentUIController(engine, { presentation: null, ...ui }),
  )
  const controller = built.ui as CommentUIController
  return {
    ...built,
    ui: controller,
    vm: () => controller.vm.get(),
    intents: controller.intents,
  }
}

/** A mount with the default presentation, for the frozen-markup cases. */
export async function domScene(html: string, options?: SceneOptions): Promise<DomScene> {
  return base(html, options, (engine, ui) => mountCommentUI(engine, ui))
}

export function $(root: ParentNode, selector: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(selector)
}

export function $$(root: ParentNode, selector: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector))
}

export function badgeOf(vm: UIViewModel, threadId: string): UIViewModel['badges'][number] | null {
  return vm.badges.find((badge) => badge.threadId === threadId) ?? null
}

export function rowsOf(vm: UIViewModel, section: string): readonly string[] {
  const found = vm.panel?.sections.find((entry) => entry.id === section)
  return (found?.rows ?? []).map((row) => row.threadId)
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

/* ------------------------------------------------------------------- the probe presentation */

export interface Probe {
  presentation: Presentation
  /** Every model handed to `update()`, in order. */
  updates: UIViewModel[]
  creates: number
  destroys: number
  /** The nodes it registered through `host.anchor()`, by surface key. */
  nodes: Map<string, HTMLElement>
}

/**
 * A presentation that draws **nothing**: it records the models it is handed and, optionally,
 * registers one bare `<div>` per surface so the controller's positioning has something to
 * position. It exists so the *controller's* lifecycle, fault isolation and coordinate contract
 * are testable without a single assertion on anybody's markup.
 */
export function probePresentation(options?: {
  css?: string
  throwOn?: 'create' | 'update'
  anchor?: boolean
  /**
   * Hand the controller a placement cursor for as long as `vm.picker` is non-null (§3.1.4
   * `host.cursor`). Draws nothing — the point of §0 D7 is that there is nothing to draw.
   */
  cursor?: string
}): Probe {
  const probe: Probe = {
    updates: [],
    creates: 0,
    destroys: 0,
    nodes: new Map(),
    presentation: {
      name: 'probe',
      css: options?.css,
      create(host) {
        probe.creates += 1
        if (options?.throwOn === 'create') throw new Error('probe: create failed')
        const claim = (key: string): HTMLElement => {
          let node = probe.nodes.get(key)
          if (!node) {
            node = host.doc.createElement('div')
            host.layer.append(node)
            probe.nodes.set(key, node)
            host.anchor(key, node)
          }
          return node
        }
        return {
          update(vm) {
            probe.updates.push(vm)
            if (options?.cursor !== undefined) host.cursor(vm.picker ? options.cursor : null)
            if (options?.throwOn === 'update') throw new Error('probe: update failed')
            if (!options?.anchor) return
            const wanted = new Set(vm.badges.map((badge) => `badge:${badge.threadId}`))
            if (vm.thread) wanted.add('thread')
            if (vm.composer) wanted.add('composer')
            for (const key of wanted) claim(key)
            for (const [key, node] of Array.from(probe.nodes)) {
              if (wanted.has(key)) continue
              host.anchor(key, null)
              node.remove()
              probe.nodes.delete(key)
            }
          },
          destroy() {
            probe.destroys += 1
            for (const [key, node] of probe.nodes) {
              host.anchor(key, null)
              node.remove()
            }
            probe.nodes.clear()
          },
        }
      },
    },
  }
  return probe
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
