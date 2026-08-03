/**
 * §3.1.2's four normative properties of the model — serializable, frozen, referentially stable,
 * total — plus §3 "the controller is a pure renderer" and the §9 dependency-rule greps.
 *
 * Serializability is not a nicety: it is the *enforcement mechanism* for the whole seam. It is
 * impossible to smuggle an `Element`, a `Range` or a method through `structuredClone`, so the
 * rule "a presentation cannot reach the engine" tests itself here, once, for every presentation
 * that will ever exist.
 *
 * Residual browser-only gaps this suite deliberately does NOT cover (happy-dom has no layout,
 * no top layer and no real cascade), listed here rather than left implicit:
 *  - actual positioning coordinates: every rect is 0×0, so a positioning pass is exercised for
 *    "runs and writes left/top" only, never for flip/shift correctness;
 *  - `showPopover()` / the top layer / `:popover-open`: `HTMLElement.showPopover` is absent, so
 *    the `data-open` degradation path is what runs here;
 *  - the cascade itself — `pointer-events`, `all: initial`, `prefers-color-scheme`: asserted
 *    against the sheet's text, not a computed style;
 *  - the frame loop's re-projection of the orphan dock after a scroll;
 *  - the `pending` window, which this DOM closes inside one microtask.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { probePresentation, scene, tick } from '../support.ts'

const PAGE = '<article id="a" data-testid="a">alpha</article><div id="b">beta</div>'

// `new URL(…)` here would be happy-dom's URL, which `fileURLToPath` rejects.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SRC = resolve(packageRoot, 'src')

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

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

describe('the model is a wire format', () => {
  test('structuredClone succeeds on every published model', async () => {
    const probe = probePresentation()
    const s = await scene(PAGE, {
      ui: { panel: { defaultOpen: true }, presentation: probe.presentation },
    })
    cleanup.push(s.dispose)
    const id = await s.seed('#a')
    s.ui.decorate(id, { chip: { text: 'copilot', tone: 'busy', spinner: true } })
    s.ui.focus(id)
    s.engine.placement.start('comment', { element: s.doc.querySelector('#b')! })
    await s.settle()
    await s.page.mutate((doc) => {
      doc.querySelector('#a')?.remove()
    })
    await s.settle()

    expect(probe.updates.length).toBeGreaterThan(3)
    for (const vm of probe.updates) {
      expect(() => structuredClone(vm)).not.toThrow()
    }
  })

  test('every object and array in it is frozen', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    s.ui.decorate(id, { chip: { text: 'x' } })
    s.ui.focus(id)
    await tick()

    const seen = new Set<unknown>()
    const check = (value: unknown): void => {
      if (value === null || typeof value !== 'object' || seen.has(value)) return
      seen.add(value)
      expect(Object.isFrozen(value)).toBe(true)
      for (const child of Object.values(value as Record<string, unknown>)) check(child)
    }
    check(s.vm())
    expect(seen.size).toBeGreaterThan(5)
  })

  test('seq is monotonic and never resets', async () => {
    const s = await boot()
    const first = s.vm().seq
    await s.seed('#a')
    const second = s.vm().seq
    expect(second).toBeGreaterThan(first)
    await s.seed('#b')
    expect(s.vm().seq).toBeGreaterThan(second)
  })

  test('a member that did not change keeps its identity', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const first = await s.seed('#a')
    const before = s.vm()
    // Touch something that changes nothing observable about the badges.
    s.intents.selectSection('resolved')
    await tick()
    const after = s.vm()
    expect(after).not.toBe(before)
    expect(after.badges).toBe(before.badges)
    expect(after.labels).toBe(before.labels)

    await s.engine.appendComment(first, { author: 'user', body: 'now it changed' })
    await s.settle()
    expect(s.vm().badges).not.toBe(before.badges)
  })

  test('renders are coalesced: many notifications in one turn publish once', async () => {
    const probe = probePresentation()
    const s = await scene(PAGE, { ui: { presentation: probe.presentation } })
    cleanup.push(s.dispose)
    const id = await s.seed('#a')
    const before = probe.updates.length
    s.ui.decorate(id, { tone: 'muted' })
    s.ui.decorate(id, { tone: 'accent' })
    s.intents.openPanel()
    s.intents.closePanel()
    await tick()
    expect(probe.updates.length - before).toBe(1)
  })

  test('a subscriber that throws does not take the publication down', async () => {
    const onError = vi.fn()
    const s = await boot({ ui: { onError } })
    const seen: number[] = []
    s.ui.vm.subscribe(() => {
      throw new Error('bad listener')
    })
    s.ui.vm.subscribe((vm) => {
      seen.push(vm.seq)
    })
    await s.seed('#a')
    expect(seen.length).toBeGreaterThan(0)
    expect(onError).toHaveBeenCalled()
  })
})

describe('pure renderer', () => {
  test('every mutation reaches the store through the engine, never around it', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    const direct = vi.spyOn(s.store, 'putThread')
    const viaEngine = vi.spyOn(s.engine, 'resolve')

    s.intents.openThread(id)
    await tick()
    s.intents.resolveThread(id)
    await s.settle()

    expect(viaEngine).toHaveBeenCalledWith(id)
    // The write happened, and it happened underneath the engine call — not from the controller.
    expect(direct).toHaveBeenCalledTimes(1)
    expect(viaEngine.mock.invocationCallOrder[0]).toBeLessThan(direct.mock.invocationCallOrder[0]!)
  })

  test('the controller holds no thread state: clearing the engine clears the model', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    await s.seed('#a')
    await s.seed('#b')
    expect(s.vm().badges).toHaveLength(2)

    for (const view of s.engine.listThreads()) await s.engine.delete(view.id)
    await s.settle()
    expect(s.vm().badges).toHaveLength(0)
    expect(s.vm().panel?.sections.flatMap((section) => section.rows)).toHaveLength(0)
  })

  test('labels flow into every user-visible string in the model', async () => {
    const s = await boot({
      ui: {
        panel: { defaultOpen: true },
        labels: {
          panelTitle: 'Commentaires',
          sectionOpen: 'Ouverts',
          emptyResolved: 'Rien de résolu.',
          placeholder: 'Ajouter un commentaire…',
          pickHint: 'Choisissez un élément',
          approximate: 'Ancrage approximatif',
        },
      },
    })
    const id = await s.seed('#a')
    s.ui.focus(id)
    s.engine.placement.start('comment', { element: s.doc.querySelector('#b')! })
    await tick()

    expect(s.vm().labels.panelTitle).toBe('Commentaires')
    expect(s.vm().panel?.title).toBe('Commentaires')
    expect(s.vm().panel?.sections.find((section) => section.id === 'open')?.label).toBe('Ouverts')
    expect(s.vm().panel?.sections.find((section) => section.id === 'resolved')?.empty).toBe(
      'Rien de résolu.',
    )
    expect(s.vm().composer?.placeholder).toBe('Ajouter un commentaire…')
  })
})

describe('fault isolation', () => {
  test('an onError that throws does not take the controller down', async () => {
    const s = await boot({
      ui: {
        onError: () => {
          throw new Error('the reporter is also broken')
        },
      },
    })
    const id = await s.seed('#a')
    s.intents.openThread(id)
    await tick()
    vi.spyOn(s.store, 'putThread').mockRejectedValueOnce(new Error('nope'))
    s.intents.resolveThread(id)
    await s.settle()

    await s.engine.appendComment(id, { author: 'user', body: 'still rendering' })
    await s.settle()
    expect(s.vm().badges[0]?.count).toBe(2)
  })

  test('the default onError swallows rather than breaking the host page', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    vi.spyOn(s.store, 'putThread').mockRejectedValueOnce(new Error('nope'))
    expect(() => {
      s.intents.resolveThread(id)
    }).not.toThrow()
    await s.settle()
  })

  test('interacting after engine.destroy() is inert, not fatal', async () => {
    const s = await scene(PAGE)
    const id = await s.seed('#a')
    s.engine.destroy()
    await tick()
    expect(() => {
      s.intents.openThread(id)
      s.intents.escape()
    }).not.toThrow()
    s.ui.unmount()
    await s.page.dispose()
  })
})

describe('§9 definition of done — the dependency rules', () => {
  test('no chrome.*, no wxt/*, no copilot import anywhere in src', () => {
    const forbidden = /chrome\.|wxt\/|from '@?astrale-os\/?copilot'/
    for (const file of walk(SRC)) {
      expect({ file, hit: forbidden.test(readFileSync(file, 'utf8')) }).toEqual({
        file,
        hit: false,
      })
    }
  })

  test('no presentation imports engine, domain or positioning code', () => {
    // Decision log #31: total inverse DI. Anything a presentation *can* reach it will
    // eventually depend on, and then a theme is a fork.
    const forbidden = /comment-core|floating-ui/
    for (const file of walk(resolve(SRC, 'presentations'))) {
      expect({ file, hit: forbidden.test(readFileSync(file, 'utf8')) }).toEqual({
        file,
        hit: false,
      })
    }
  })

  test('presentation.ts contains no import or export-from statement', () => {
    const source = readFileSync(resolve(SRC, 'presentation.ts'), 'utf8')
    expect(source).not.toMatch(/^\s*import\b/m)
    expect(source).not.toMatch(/\bexport\b[^\n]*\bfrom\b/)
  })

  test('no three.js and no WebGL anywhere in src (decision log #40)', () => {
    const forbidden = /\bthree\b|webgl/i
    for (const file of walk(SRC)) {
      expect({ file, hit: forbidden.test(readFileSync(file, 'utf8')) }).toEqual({
        file,
        hit: false,
      })
    }
  })

  test('the IIFE bundle declares comment-core external and reads globalThis.Comments', () => {
    const config = readFileSync(resolve(packageRoot, 'vite.config.ts'), 'utf8')
    expect(config).toContain("name: 'CommentsUI'")
    expect(config).toContain("external: ['@astrale-os/comment-core'")
    expect(config).toContain("globals: { '@astrale-os/comment-core': 'Comments' }")
    expect(config).toContain("fileName: () => 'comment-ui.iife.js'")
    // The importable half of the CSS contract is emitted from the same string.
    expect(config).toContain("fileName: 'comment-ui.css'")
  })

  test('the public surface is exactly the six §3.1.7 runtime names', async () => {
    const barrel = await import('../../src/index.ts')
    expect(Object.keys(barrel).sort()).toEqual([
      'commentUIStyles',
      'createCommentUIController',
      'defaultLabels',
      'domPresentation',
      'mount',
      'mountCommentUI',
    ])
  })

  test('CommentUIController exposes exactly the §3 + §3.1 members', async () => {
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
    expect(typeof s.ui.vm.get).toBe('function')
    expect(typeof s.ui.vm.subscribe).toBe('function')
    expect(Object.keys(s.intents).sort()).toEqual([
      'beginEdit',
      'cancelComposer',
      'cancelEdit',
      'closePanel',
      'closeThread',
      'commitEdit',
      'deleteThread',
      'error',
      'escape',
      'openPanel',
      'openThread',
      'reopenThread',
      'resolveThread',
      'selectSection',
      'setDraft',
      'startReply',
      'submitDraft',
      'togglePanel',
    ])
  })

  test('a controller test never queries presentation markup', () => {
    // The first migration rule of §3.1.9, enforced rather than trusted. `.cc-layer` and
    // `.cc-status` are exempt: they are the CONTROLLER's own nodes and exist with no
    // presentation mounted at all.
    const dir = resolve(packageRoot, 'test/controller')
    for (const file of walk(dir)) {
      const source = readFileSync(file, 'utf8')
      const hits = [...source.matchAll(/\.cc-[a-z-]+/g)]
        .map((match) => match[0])
        .filter((name) => name !== '.cc-layer' && name !== '.cc-status')
      expect({ file, hits }).toEqual({ file, hits: [] })
    }
  })
})
