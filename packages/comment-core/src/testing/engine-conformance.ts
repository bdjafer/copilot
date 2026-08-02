/**
 * `engineConformance` (§2.16) — the two engine-only rows of §4.1 (14 orphaning, 17 unknown
 * kind) plus the §4.2 ordering rules that need a DOM.
 *
 * Runner-agnostic on purpose (decision log #24): an array of `{ name, run }` works in vitest,
 * node:test and bun with one `for` loop, and couples the kit to no runner's globals.
 *
 * Requires `happy-dom` — it drives `createTestPage`.
 */

import type { CommentStore } from '../types.ts'
import type { Awaitable, ConformanceCase } from './types.ts'

import { captureTarget } from '../anchor/target.ts'
import { CommentError } from '../errors.ts'
import { assert, assertEqual } from './assert.ts'
import { createTestPage } from './test-page.ts'

const PAGE =
  '<article id="a" data-testid="a">alpha text</article>' +
  '<div id="b" data-testid="b">beta text</div>' +
  '<input id="field" />'

const URL_A = 'https://conformance.test/page-a'
const URL_B = 'https://conformance.test/page-b'

type Factory = () => Awaitable<CommentStore>

interface Scene {
  page: ReturnType<typeof createTestPage>
  engine: ReturnType<ReturnType<typeof createTestPage>['engine']>
  events: Array<{ type: string; payload: unknown }>
  seed(selector: string, body?: string, kind?: string): Promise<string>
  dispose(): Promise<void>
}

async function scene(factory: Factory, url = URL_A): Promise<Scene> {
  const page = createTestPage(PAGE, { url })
  const store = await factory()
  const engine = page.engine({
    store,
    modes: [
      { kind: 'comment', trigger: { key: 'c', interaction: 'pick' } },
      { kind: 'ask', trigger: { key: 'a', interaction: 'hover' } },
    ],
  })
  const events: Array<{ type: string; payload: unknown }> = []
  engine.subscribe((event) => events.push({ type: event.type, payload: event.payload }))
  await engine.ready()
  await page.flush()
  events.length = 0

  return {
    page,
    engine,
    events,
    async seed(selector, body = 'first', kind = 'comment') {
      const target = page.document.querySelector(selector)
      if (!target) throw new CommentError('no_target', `no element for ${selector}`)
      const { anchor, capture } = captureTarget(target, { document: page.document })
      const result = await engine.createThread({
        pageKey: engine.pageKey,
        kind,
        anchor,
        capture,
        author: 'user',
        body,
      })
      return result.thread.id
    },
    dispose: () => page.dispose(),
  }
}

/**
 * The two engine-only rows of §4.1 (14 orphaning, 17 unknown kind) plus the §4.2 ordering
 * rules that need a DOM. Requires `happy-dom` (it drives `createTestPage`).
 */
export function engineConformance(factory: Factory): ConformanceCase[] {
  const cases: ConformanceCase[] = []
  const add = (name: string, run: (s: Scene) => Promise<void>): void => {
    cases.push({
      name,
      async run() {
        const s = await scene(factory)
        try {
          await run(s)
        } finally {
          await s.dispose()
        }
      },
    })
  }

  /* ------------------------------------------------------------------ §4.1 row 14 */

  add(
    'engine: rule 14 — the anchor element disappearing orphans at render time, with NO store write',
    async (s) => {
      const id = await s.seed('#a')
      const before = JSON.stringify(await s.engine.get(id))
      await s.page.mutate((doc) => doc.querySelector('#a')!.remove())

      const view = s.engine.getThreadView(id)
      assert(view !== null, 'the thread survives its element')
      assertEqual(view!.anchoring.status, 'orphaned', 'anchoring.status')
      assertEqual(view!.isOrphaned, true, 'isOrphaned')
      assertEqual(view!.anchoring.element, null, 'anchoring.element')
      assertEqual(JSON.stringify(await s.engine.get(id)), before, 'the stored record is untouched')
    },
  )

  add('engine: rule 14 — the thread auto re-attaches when the element returns', async (s) => {
    const id = await s.seed('#a')
    await s.page.mutate((doc) => doc.querySelector('#a')!.remove())
    assertEqual(s.engine.getThreadView(id)!.anchoring.status, 'orphaned', 'orphaned first')

    await s.page.mutate((doc) => {
      const restored = doc.createElement('article')
      restored.id = 'a'
      restored.setAttribute('data-testid', 'a')
      restored.textContent = 'alpha text'
      doc.body.prepend(restored)
    })
    assertEqual(s.engine.getThreadView(id)!.anchoring.status, 'anchored', 're-attached')
  })

  add(
    'engine: rule 14 — thread:orphaned carries the last known rect so the badge can dock',
    async (s) => {
      const id = await s.seed('#a')
      const rect = s.engine.getThreadView(id)!.anchoring.rect
      s.events.length = 0
      await s.page.mutate((doc) => doc.querySelector('#a')!.remove())

      const event = s.events.find((e) => e.type === 'thread:orphaned')
      assert(event !== undefined, 'thread:orphaned was emitted')
      assertEqual(
        JSON.stringify((event!.payload as { lastRect: unknown }).lastRect),
        JSON.stringify(rect),
        'lastRect',
      )
    },
  )

  /* ------------------------------------------------------------------ §4.1 row 17 */

  add(
    'engine: rule 17 — startPlacement with an unknown kind returns false and emits placement:rejected AND error',
    async (s) => {
      assertEqual(s.engine.startPlacement('not-a-mode'), false, 'startPlacement returns false')
      const rejected = s.events.find((e) => e.type === 'placement:rejected')
      assert(rejected !== undefined, 'placement:rejected was emitted')
      assertEqual(
        (rejected!.payload as { reason: string }).reason,
        'unknown_kind',
        'placement:rejected reason',
      )
      const failure = s.events.find((e) => e.type === 'error')
      assert(failure !== undefined, 'error was emitted')
      assertEqual(
        (failure!.payload as { error: CommentError }).error.code,
        'unknown_kind',
        'error code',
      )
    },
  )

  add(
    'engine: rule 17 — kind is opaque: the domain never validates it against modes',
    async (s) => {
      const id = await s.seed('#a', 'first', 'a-kind-with-no-mode')
      assertEqual(s.engine.getThreadView(id)!.kind, 'a-kind-with-no-mode', 'stored kind')
      assertEqual(s.engine.listThreads({ kind: 'a-kind-with-no-mode' }).length, 1, 'filterable')
    },
  )

  /* ------------------------------------------------------- §4.2 DOM-dependent ordering */

  add('engine: §4.2.2 — the live view already reflects the event inside a listener', async (s) => {
    let observed: { count: number; listed: boolean } | null = null
    s.engine.on('thread:create', ({ thread }) => {
      observed = {
        count: s.engine.getThreadView(thread.id)?.comments.length ?? 0,
        listed: s.engine.threads.get().some((view) => view.id === thread.id),
      }
    })
    await s.seed('#a')
    assertEqual(JSON.stringify(observed), JSON.stringify({ count: 1, listed: true }), 'view state')
  })

  add(
    'engine: §4.2.6 — within a batch, all thread:orphaned precede all thread:anchored',
    async (s) => {
      await s.seed('#a')
      await s.seed('#b')
      s.events.length = 0

      await s.page.mutate((doc) => {
        doc.querySelector('#a')!.remove()
        const b = doc.querySelector('#b')!
        const wrapper = doc.createElement('section')
        b.replaceWith(wrapper)
        wrapper.append(b)
      })

      const names = s.events
        .map((event) => event.type)
        .filter((type) => type === 'thread:orphaned' || type === 'thread:anchored')
      const lastOrphan = names.lastIndexOf('thread:orphaned')
      const firstAnchor = names.indexOf('thread:anchored')
      assert(lastOrphan !== -1, 'at least one thread:orphaned')
      assert(firstAnchor === -1 || lastOrphan < firstAnchor, 'orphaned before anchored')
    },
  )

  add(
    'engine: §4.2.6 — transitions only: an unrelated mutation emits no anchoring event',
    async (s) => {
      await s.seed('#a')
      s.events.length = 0
      await s.page.mutate((doc) => doc.body.append(doc.createElement('hr')))
      assertEqual(
        s.events.filter((e) => e.type === 'thread:anchored' || e.type === 'thread:orphaned').length,
        0,
        'anchoring events',
      )
    },
  )

  add('engine: §4.2.8 — a local write is not re-emitted as a remote echo', async (s) => {
    const id = await s.seed('#a')
    await s.engine.appendComment(id, { author: 'copilot', body: 'reply' })
    await s.page.flush()

    const domainEvents = s.events.filter(
      (e) => e.type.startsWith('thread:') && e.type !== 'thread:anchored',
    )
    assertEqual(domainEvents.length, 2, 'exactly thread:create + thread:reply')
    assert(
      domainEvents.every((e) => (e.payload as { source: string }).source === 'local'),
      'every echo is local',
    )
  })

  add(
    'engine: §4.2.9 — placement:end(placed) follows the thread:create for that submission',
    async (s) => {
      const target = s.page.document.querySelector('#a')!
      assertEqual(
        s.engine.placement.start('comment', { element: target }),
        true,
        'placement started',
      )
      const result = await s.engine.placement.submit('placed body')
      assertEqual(
        JSON.stringify(s.events.map((e) => e.type)),
        JSON.stringify(['placement:start', 'thread:create', 'placement:end']),
        'event order',
      )
      assertEqual(
        (s.events.at(-1)!.payload as { threadId: string }).threadId,
        result.thread.id,
        'placement:end threadId',
      )
    },
  )

  add(
    'engine: §4.2.10 — page:change follows the unload+load, and thread:anchored follows it',
    async (s) => {
      await s.seed('#a')
      s.events.length = 0

      await s.page.navigate(URL_B)
      assertEqual(s.engine.listThreads().length, 0, 'the old page was unloaded')
      assert(
        s.events.some((e) => e.type === 'page:change'),
        'page:change was emitted',
      )

      s.events.length = 0
      await s.page.navigate(URL_A)
      const names = s.events.map((e) => e.type)
      const change = names.indexOf('page:change')
      const anchored = names.indexOf('thread:anchored')
      assert(change !== -1, 'page:change on the way back')
      assert(anchored === -1 || change < anchored, 'thread:anchored follows page:change')
      assertEqual(s.engine.listThreads().length, 1, 'the page-a thread came back')
    },
  )

  add('engine: §4.2.11 — destroy() stops the bus permanently and is idempotent', async (s) => {
    await s.seed('#a')
    s.engine.destroy()
    s.engine.destroy()
    s.events.length = 0
    await s.page.mutate((doc) => doc.querySelector('#a')!.remove())
    assertEqual(s.events.length, 0, 'no event after destroy()')
    assertEqual(s.engine.status.get(), 'destroyed', 'status')
  })

  add('engine: §4.5 — a bare-letter trigger is ignored inside an input', async (s) => {
    const doc = s.page.document
    const fire = (target: Element): void => {
      target.dispatchEvent(
        new doc.defaultView!.KeyboardEvent('keydown', {
          key: 'c',
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      )
    }
    fire(doc.querySelector('#field')!)
    assertEqual(s.engine.placement.get().phase, 'idle', 'ignored in an input')
    fire(doc.body)
    assertEqual(s.engine.placement.get().phase, 'picking', 'honoured outside one')
  })

  return cases
}
