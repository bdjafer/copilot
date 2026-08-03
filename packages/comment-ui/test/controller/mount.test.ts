/**
 * §3 / §3.1.4 / PLAN §3.3 — the layer contract and the presentation lifecycle: one open shadow
 * root, a `pointer-events: none` layer, the host page's DOM never mutated, explicit `:host`
 * font-size, sheet ordering, and a teardown that leaves no node and no subscription behind.
 *
 * Everything here is the **controller's**, so every case mounts headless (`presentation: null`)
 * or with the probe. Nothing in this file asserts markup — there is none to assert.
 */

import { createCommentEngine, createMemoryStore } from '@astrale-os/comment-core'
import { afterEach, describe, expect, test } from 'vitest'

import { createCommentUIController, mount, mountCommentUI } from '../../src/index.ts'
import { $, $$, probePresentation, scene, tick } from '../support.ts'

const PAGE = '<article id="a" data-testid="a">alpha</article><div id="b">beta</div>'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  document.querySelectorAll('[data-comment-ui]').forEach((node) => {
    node.remove()
  })
})

async function boot(options?: Parameters<typeof scene>[1]) {
  const s = await scene(PAGE, options)
  cleanup.push(s.dispose)
  return s
}

describe('the single shadow-root layer', () => {
  test('mounts one OPEN shadow root on document.documentElement', async () => {
    const s = await boot()
    const hosts = document.querySelectorAll('[data-comment-ui]')
    expect(hosts).toHaveLength(1)
    expect(hosts[0]?.parentElement).toBe(document.documentElement)
    expect(s.root.mode).toBe('open')
    expect(s.ui.root).toBe(hosts[0]?.shadowRoot)
  })

  test('the layer and the status region exist with NO presentation at all', async () => {
    // §3.1: `presentation: null` still gets the shadow root, the layer and the `role="status"`
    // region — a headless mount is a usable mount, not a broken one.
    const s = await boot({ ui: { zIndex: 500 } })
    expect($(s.root, '.cc-layer')).not.toBeNull()
    expect($(s.root, '.cc-status')?.getAttribute('role')).toBe('status')
    expect($(s.root, 'style[data-cc="vars"]')?.textContent).toContain('--cc-z:500')
  })

  test(':host carries an explicit font-size — never a rem dependency', async () => {
    const s = await boot({ ui: { rootFontSize: '18px' } })
    expect($(s.root, 'style[data-cc="vars"]')?.textContent).toContain('--cc-root-font-size:18px')
  })

  test('sheet order is vars → presentation → options.css (§3.1.4)', async () => {
    const probe = probePresentation({ css: '.probe{}' })
    const s = await scene(PAGE, {
      ui: { css: '.host{}', presentation: probe.presentation },
    })
    cleanup.push(s.dispose)
    const sheets = $$(s.root, 'style')
    expect(sheets.map((node) => node.getAttribute('data-cc'))).toEqual(['vars', 'base', 'custom'])
    expect(sheets[1]?.textContent).toBe('.probe{}')
    expect(sheets[2]?.textContent).toBe('.host{}')
  })

  test('the host page DOM is never mutated', async () => {
    const s = await boot()
    const before = s.doc.body.innerHTML
    await s.seed('#a')
    s.intents.openPanel()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#b')! })
    await s.settle()
    expect(s.doc.body.innerHTML).toBe(before)
    expect(s.doc.querySelector('#a')?.attributes.length).toBe(2)
  })

  test('container option redirects the host element', async () => {
    const host = document.createElement('section')
    document.body.append(host)
    const s = await boot({ ui: { container: host } })
    expect(s.root.host.parentElement).toBe(host)
    host.remove()
  })
})

describe('the presentation lifecycle', () => {
  test('create runs once and the FIRST update is synchronous, before mount returns', async () => {
    const probe = probePresentation()
    const page = document.createElement('div')
    const engine = createCommentEngine({ store: createMemoryStore(), document })
    const ui = createCommentUIController(engine, { presentation: probe.presentation })
    cleanup.push(() => {
      ui.unmount()
      engine.destroy()
      page.remove()
    })
    expect(probe.creates).toBe(1)
    expect(probe.updates).toHaveLength(1)
    expect(probe.updates[0]?.seq).toBe(1)
  })

  test('destroy runs BEFORE the layer is torn down, and update never runs after it', async () => {
    const probe = probePresentation()
    const s = await scene(PAGE, { ui: { presentation: probe.presentation } })
    await s.seed('#a')
    const seen = probe.updates.length
    s.ui.unmount()
    expect(probe.destroys).toBe(1)
    await s.seed('#b')
    await tick()
    expect(probe.updates).toHaveLength(seen)
    await s.page.dispose()
  })

  test('a throw from create is reported and the controller still works', async () => {
    const errors: unknown[] = []
    const probe = probePresentation({ throwOn: 'create' })
    const s = await scene(PAGE, {
      ui: {
        presentation: probe.presentation,
        onError: (error) => {
          errors.push(error)
        },
      },
    })
    cleanup.push(s.dispose)
    expect(errors).toHaveLength(1)
    const id = await s.seed('#a')
    expect(s.vm().badges.map((badge) => badge.threadId)).toEqual([id])
  })

  test('a throw from update is reported and never reaches the host page', async () => {
    const errors: unknown[] = []
    const probe = probePresentation({ throwOn: 'update' })
    const s = await scene(PAGE, {
      ui: {
        presentation: probe.presentation,
        onError: (error) => {
          errors.push(error)
        },
      },
    })
    cleanup.push(s.dispose)
    expect(errors.length).toBeGreaterThan(0)
    // The model was still published: the pass is abandoned after the fault, not before it.
    await s.seed('#a')
    expect(s.vm().badges).toHaveLength(1)
  })
})

describe('lifecycle', () => {
  test('unmount removes the host and stops rendering', async () => {
    const s = await scene(PAGE)
    const id = await s.seed('#a')
    expect(s.vm().badges.map((badge) => badge.threadId)).toEqual([id])

    s.ui.unmount()
    expect(document.querySelectorAll('[data-comment-ui]')).toHaveLength(0)

    // Subscriptions are gone: a later store write must not resurrect anything.
    const before = s.vm().seq
    await s.seed('#b')
    await tick()
    expect(s.vm().seq).toBe(before)
    expect(document.querySelectorAll('[data-comment-ui]')).toHaveLength(0)
    await s.page.dispose()
  })

  test('unmount is idempotent', async () => {
    const s = await scene(PAGE)
    s.ui.unmount()
    expect(() => {
      s.ui.unmount()
    }).not.toThrow()
    await s.page.dispose()
  })

  test('mount() builds the engine too and returns it', async () => {
    const engineStore = createMemoryStore()
    const ui = mount({
      engine: { store: engineStore, document, autoStart: true },
      ui: { panel: { defaultOpen: true }, presentation: null },
    })
    cleanup.push(() => {
      ui.unmount()
      ui.engine.destroy()
    })
    await ui.engine.ready()
    await tick()
    expect(ui.engine.store).toBe(engineStore)
    expect(ui.root.mode).toBe('open')
    expect(ui.panel.isOpen).toBe(true)
  })

  test('mountCommentUI accepts an engine the caller already owns', async () => {
    const engine = createCommentEngine({ store: createMemoryStore(), document })
    const ui = mountCommentUI(engine, { presentation: null })
    cleanup.push(() => {
      ui.unmount()
      engine.destroy()
    })
    expect(ui.engine).toBe(engine)
  })
})
