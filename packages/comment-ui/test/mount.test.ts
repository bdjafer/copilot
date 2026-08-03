/**
 * §3 / PLAN §3.3 — the layer contract: one open shadow root, a `pointer-events: none` layer,
 * the host page's DOM never mutated, explicit `:host` font-size, and a teardown that leaves no
 * node and no subscription behind.
 */

import { createCommentEngine, createMemoryStore } from '@astrale-os/comment-core'
import { afterEach, describe, expect, test } from 'vitest'

import { commentUIStyles, mount, mountCommentUI } from '../src/index.ts'
import { $, $$, scene, tick } from './support.ts'

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

  test('the layer is pointer-events isolated and z-indexed from options', async () => {
    const s = await boot({ ui: { zIndex: 500 } })
    const layer = $(s.root, '.cc-layer')
    expect(layer).not.toBeNull()
    // The rules live in the sheet, which happy-dom does not cascade; assert the contract at
    // its source instead of asserting a computed style the emulator does not compute.
    expect(commentUIStyles).toMatch(/\.cc-layer\s*\{[^}]*pointer-events:\s*none/)
    expect(commentUIStyles).toMatch(/\.cc-layer\s*>\s*\*\s*\{\s*pointer-events:\s*auto/)
    expect($(s.root, 'style[data-cc="vars"]')?.textContent).toContain('--cc-z:500')
  })

  test(':host carries an explicit font-size — never a rem dependency', async () => {
    const s = await boot({ ui: { rootFontSize: '18px' } })
    expect($(s.root, 'style[data-cc="vars"]')?.textContent).toContain('--cc-root-font-size:18px')
    expect(commentUIStyles).toContain('font-size: var(--cc-root-font-size, 16px)')
    expect(commentUIStyles).toContain('all: initial')
    expect(commentUIStyles).not.toMatch(/\d\s*rem\b/)
  })

  test('the built-in sheet is injected and the css option is appended after it', async () => {
    const s = await boot({ ui: { css: '.cc-badge { font-weight: 600 }' } })
    const sheets = $$(s.root, 'style')
    expect(sheets.map((node) => node.getAttribute('data-cc'))).toEqual(['vars', 'base', 'custom'])
    expect(sheets[1]?.textContent).toBe(commentUIStyles)
    expect(sheets[2]?.textContent).toBe('.cc-badge { font-weight: 600 }')
  })

  test('the host page DOM is never mutated', async () => {
    const s = await boot()
    const before = s.doc.body.innerHTML
    await s.seed('#a')
    s.ui.panel.open()
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

describe('lifecycle', () => {
  test('unmount removes the host and stops rendering', async () => {
    const s = await scene(PAGE)
    const id = await s.seed('#a')
    expect($(s.root, `.cc-badge[data-thread="${id}"]`)).not.toBeNull()

    s.ui.unmount()
    expect(document.querySelectorAll('[data-comment-ui]')).toHaveLength(0)

    // Subscriptions are gone: a later store write must not resurrect anything.
    await s.seed('#b')
    await tick()
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
      ui: { panel: { defaultOpen: true } },
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
    const ui = mountCommentUI(engine)
    cleanup.push(() => {
      ui.unmount()
      engine.destroy()
    })
    expect(ui.engine).toBe(engine)
  })
})
