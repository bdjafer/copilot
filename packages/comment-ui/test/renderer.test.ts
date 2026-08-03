/**
 * §3 "`comment-ui` is a pure renderer", the §9 definition-of-done greps, and the §1.2 build
 * contract.
 *
 * Residual browser-only gaps this suite deliberately does NOT cover (happy-dom has no layout,
 * no top layer and no real cascade), listed here rather than left implicit:
 *  - actual `@floating-ui/dom` coordinates: every rect is 0×0, so `computePosition` is
 *    exercised for "runs and writes left/top" only, never for flip/shift correctness;
 *  - `showPopover()` / the top layer / `:popover-open`: `HTMLElement.showPopover` is absent, so
 *    the `data-open` degradation path is what runs here;
 *  - the cascade itself — `pointer-events`, `all: initial`, `prefers-color-scheme`, the
 *    off-screen `hidden` rule: asserted against the sheet's text, not a computed style;
 *  - `autoUpdate`'s scroll/resize/`animationFrame` re-projection of the orphan dock;
 *  - the `pending` window, which this DOM closes inside one microtask (see badge.test.ts).
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { $, $$, badgeOf, click, scene, tick } from './support.ts'

const PAGE = '<article id="a" data-testid="a">alpha</article><div id="b">beta</div>'

// `new URL(…)` here would be happy-dom's URL, which `fileURLToPath` rejects.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = resolve(packageRoot, 'src')
const SOURCES = [
  'index.ts',
  'mount.ts',
  'shadow.ts',
  'styles.ts',
  'position.ts',
  'badge.ts',
  'picker.ts',
  'composer.ts',
  'thread.ts',
  'panel.ts',
  'labels.ts',
  'dom.ts',
  'chip.ts',
  'context.ts',
  'types.ts',
]

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

describe('pure renderer', () => {
  test('every mutation reaches the store through the engine, never around it', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    const direct = vi.spyOn(s.store, 'putThread')
    const viaEngine = vi.spyOn(s.engine, 'resolve')

    click(badgeOf(s.root, id))
    await tick()
    click($(s.root, '[data-role="status"]'))
    await s.settle()

    expect(viaEngine).toHaveBeenCalledWith(id)
    // The write happened, and it happened underneath the engine call — not from the renderer.
    expect(direct).toHaveBeenCalledTimes(1)
    expect(viaEngine.mock.invocationCallOrder[0]).toBeLessThan(direct.mock.invocationCallOrder[0]!)
  })

  test('the UI holds no thread state: clearing the engine clears the render', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    await s.seed('#a')
    await s.seed('#b')
    expect($$(s.root, '.cc-badge')).toHaveLength(2)

    for (const view of s.engine.listThreads()) await s.engine.delete(view.id)
    await s.settle()
    expect($$(s.root, '.cc-badge')).toHaveLength(0)
    expect($$(s.root, '.cc-row')).toHaveLength(0)
  })

  test('labels flow into every user-visible string', async () => {
    const s = await boot({
      ui: {
        panel: { defaultOpen: true },
        labels: {
          send: 'Envoyer',
          dismiss: 'Annuler',
          reply: 'Répondre',
          resolve: 'Résoudre',
          delete: 'Supprimer',
          panelTitle: 'Commentaires',
          sectionOpen: 'Ouverts',
          emptyResolved: 'Rien de résolu.',
        },
      },
    })
    const id = await s.seed('#a')
    s.ui.focus(id)
    s.engine.placement.start('comment', { element: s.doc.querySelector('#b')! })
    await tick()

    expect($(s.root, '.cc-panel')?.getAttribute('aria-label')).toBe('Commentaires')
    expect($(s.root, '[data-section="open"] h3')?.textContent).toContain('Ouverts')
    expect($(s.root, '[data-section="resolved"] .cc-empty')?.textContent).toBe('Rien de résolu.')
    expect($(s.root, '[data-action="reply"]')?.textContent).toBe('Répondre')
    expect($(s.root, '[data-role="status"]')?.textContent).toBe('Résoudre')
    expect($(s.root, '.cc-thread [data-action="delete"]')?.textContent).toBe('Supprimer')
    expect($(s.root, '.cc-composer [data-action="send"]')?.textContent).toBe('Envoyer')
    expect($(s.root, '.cc-composer [data-action="dismiss"]')?.textContent).toBe('Annuler')
  })
})

describe('fault isolation', () => {
  test('an onError that throws does not take the renderer down', async () => {
    const s = await boot({
      ui: {
        onError: () => {
          throw new Error('the reporter is also broken')
        },
      },
    })
    const id = await s.seed('#a')
    click(badgeOf(s.root, id))
    await tick()
    vi.spyOn(s.store, 'putThread').mockRejectedValueOnce(new Error('nope'))
    click($(s.root, '[data-role="status"]'))
    await s.settle()

    await s.engine.appendComment(id, { author: 'user', body: 'still rendering' })
    await s.settle()
    expect($(badgeOf(s.root, id)!, '.cc-badge-count')?.textContent).toBe('2')
  })

  test('the default onError swallows rather than breaking the host page', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    click(badgeOf(s.root, id))
    await tick()
    vi.spyOn(s.store, 'putThread').mockRejectedValueOnce(new Error('nope'))
    expect(() => {
      click($(s.root, '[data-role="status"]'))
    }).not.toThrow()
    await s.settle()
  })

  test('interacting after engine.destroy() is inert, not fatal', async () => {
    const s = await scene(PAGE)
    const id = await s.seed('#a')
    const badge = badgeOf(s.root, id)!
    s.engine.destroy()
    await tick()
    expect(() => {
      click(badge)
    }).not.toThrow()
    s.ui.unmount()
    await s.page.dispose()
  })
})

describe('§9 definition of done', () => {
  test('no chrome.*, no wxt/*, no copilot import anywhere in src', () => {
    const forbidden = /chrome\.|wxt\/|from '@?astrale-os\/?copilot'/
    for (const file of SOURCES) {
      const source = readFileSync(`${SRC}/${file}`, 'utf8')
      expect({ file, hit: forbidden.test(source) }).toEqual({ file, hit: false })
    }
  })

  test('the IIFE bundle declares comment-core external and reads globalThis.Comments', () => {
    const config = readFileSync(resolve(packageRoot, 'vite.config.ts'), 'utf8')
    expect(config).toContain("name: 'CommentsUI'")
    expect(config).toContain("external: ['@astrale-os/comment-core']")
    expect(config).toContain("globals: { '@astrale-os/comment-core': 'Comments' }")
    expect(config).toContain("fileName: () => 'comment-ui.iife.js'")
    // The importable half of the CSS contract is emitted from the same string.
    expect(config).toContain("fileName: 'comment-ui.css'")
  })

  test('the public surface is exactly §3 plus the two additive exports', async () => {
    const barrel = await import('../src/index.ts')
    expect(Object.keys(barrel).sort()).toEqual([
      'commentUIStyles',
      'defaultLabels',
      'mount',
      'mountCommentUI',
    ])
  })

  test('CommentUI exposes exactly the §3 members', async () => {
    const s = await boot()
    expect(typeof s.ui.root).toBe('object')
    expect(typeof s.ui.engine).toBe('object')
    expect(typeof s.ui.focus).toBe('function')
    expect(typeof s.ui.decorate).toBe('function')
    expect(typeof s.ui.unmount).toBe('function')
    expect(typeof s.ui.panel.open).toBe('function')
    expect(typeof s.ui.panel.close).toBe('function')
    expect(typeof s.ui.panel.toggle).toBe('function')
    expect(typeof s.ui.panel.isOpen).toBe('boolean')
  })
})
