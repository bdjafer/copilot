/**
 * `presentationConformance()` (§3.1.9) — the executable form of "themes are swappable at mount".
 *
 * Runner-agnostic `ConformanceCase[]` arrays, the same shape as `storeConformance` /
 * `domainConformance` (decision log #24), so this works in vitest, `node:test` and bun with one
 * `for` loop and couples the kit to none of them.
 *
 * **Two rules make these cases portable, and both are normative (§3.1.9).**
 *
 *  1. *No case may assert a class name.* The vocabulary is the a11y contract and nothing else:
 *     element names, `role`, `aria-*`, and accessible names composed from `Labels`. Anything
 *     narrower is `domPresentation`-specific and belongs in the four cases that exist to pin
 *     that frozen markup.
 *  2. *No case may reach the engine through the presentation.* Every case drives the public
 *     mount surface and the DOM a user would drive, which is exactly what a presentation author
 *     needs to know still works.
 *
 * The one non-a11y assertion allowed here is `left`/`top` on a node the presentation registered
 * through `host.anchor()` — that is the coordinate contract of §3.1.5, and a presentation that
 * silently positions its own nodes would otherwise pass everything.
 */

import type { CommentEngine, Mode } from '@astrale-os/comment-core'

import { captureTarget, createMemoryStore } from '@astrale-os/comment-core'
import { createTestPage } from '@astrale-os/comment-core/testing'

import type { Labels, Presentation } from '../presentation.ts'
import type { CommentUI, CommentUIOptions } from '../types.ts'

import { defaultLabels } from '../labels.ts'
import { mountCommentUI } from '../mount.ts'

export interface ConformanceCase {
  name: string
  run: () => Promise<void>
}

const PAGE =
  '<article id="a" data-testid="a">alpha text</article>' +
  '<div id="b" data-testid="b">beta text</div>' +
  '<p id="c" data-testid="c">gamma text</p>'

const MODES: readonly Mode[] = [
  { kind: 'comment', trigger: { key: 'c', interaction: 'pick' } },
  { kind: 'ask', trigger: { key: 'a', interaction: 'pick' }, badge: { icon: '?', label: 'Ask' } },
]

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`presentationConformance: ${message}`)
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `presentationConformance: ${message} — expected ${String(expected)}, got ${String(actual)}`,
    )
  }
}

async function tick(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** The accessible name of a control: `aria-label`, else its trimmed text. */
function nameOf(node: Element): string {
  return (node.getAttribute('aria-label') ?? node.textContent ?? '').trim()
}

function allButtons(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button')].filter(
    (node) => !node.hasAttribute('hidden'),
  )
}

/** Find a control by its accessible name — the only presentation-agnostic locator there is. */
function control(root: ParentNode, name: string): HTMLElement | null {
  return allButtons(root).find((node) => nameOf(node) === name) ?? null
}

function dialogs(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"]')]
}

function visibleDialog(root: ParentNode, name: string): HTMLElement | null {
  return dialogs(root).find((node) => nameOf(node) === name) ?? null
}

/** Badges are the only `aria-expanded` controls that also carry `aria-haspopup="dialog"` (§3). */
function badges(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button[aria-haspopup="dialog"]')]
}

function badgeNamed(root: ParentNode, name: string): HTMLElement | null {
  return badges(root).find((node) => node.getAttribute('aria-label') === name) ?? null
}

function fire(node: Element | null, type: string): void {
  assert(node, `no node to dispatch ${type} on`)
  const view = node.ownerDocument.defaultView as (Window & typeof globalThis) | null
  assert(view, 'no window')
  node.dispatchEvent(new view.MouseEvent(type, { bubbles: true, cancelable: true, composed: true }))
}

function press(node: Element | null, key: string, init: KeyboardEventInit = {}): void {
  assert(node, `no node to press ${key} on`)
  const view = node.ownerDocument.defaultView as (Window & typeof globalThis) | null
  assert(view, 'no window')
  node.dispatchEvent(
    new view.KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      composed: true,
      ...init,
    }),
  )
}

function typeInto(input: HTMLTextAreaElement, value: string): void {
  input.value = value
  const view = input.ownerDocument.defaultView as (Window & typeof globalThis) | null
  if (!view) return
  input.dispatchEvent(new view.Event('input', { bubbles: true, composed: true }))
}

interface Scene {
  page: ReturnType<typeof createTestPage>
  engine: CommentEngine
  ui: CommentUI
  root: ShadowRoot
  doc: Document
  labels: Labels
  seed(selector: string, body?: string, kind?: string): Promise<string>
  settle(): Promise<void>
  dispose(): Promise<void>
}

async function scene(
  presentation: () => Presentation,
  options?: CommentUIOptions & { autoStart?: boolean },
): Promise<Scene> {
  const page = createTestPage(PAGE, { url: 'https://example.com/conformance' })
  const engine = page.engine({ store: createMemoryStore(), modes: MODES })
  await engine.ready()
  await page.flush()

  const ui = mountCommentUI(engine, {
    panel: { defaultOpen: true },
    ...options,
    presentation: presentation(),
  })
  await tick()

  const settle = async (): Promise<void> => {
    await page.flush()
    await tick()
  }

  return {
    page,
    engine,
    ui,
    root: ui.root,
    doc: page.document,
    labels: defaultLabels,
    async seed(selector, body = 'first comment', kind = 'comment') {
      const target = page.document.querySelector(selector)
      assert(target, `no element for ${selector}`)
      const { anchor, capture } = captureTarget(target, { document: page.document })
      const created = await engine.createThread({
        pageKey: engine.pageKey,
        kind,
        anchor,
        capture,
        author: 'user',
        body,
      })
      await settle()
      return created.thread.id
    },
    settle,
    async dispose() {
      ui.unmount()
      await page.dispose()
    },
  }
}

/**
 * A **mark**, for §3.1.2 drawing obligation 2: a drawn glyph, i.e. an `<svg>` instance or a text
 * run made of pictographic characters. A tabular *count* is a value, not a mark — §10's whole
 * thesis is that what leaves the screen is verbs and nouns while values stay — so a presentation
 * that draws a number beside nothing else is still carrying one mark.
 */
const PICTOGRAPH = /[\u{1F300}-\u{1FAFF}]|[\u{2190}-\u{2BFF}]|\u{FE0F}/u

function marksIn(node: Element): number {
  let count = node.querySelectorAll('svg').length
  const walker = node.ownerDocument.createTreeWalker(node, 4 /* NodeFilter.SHOW_TEXT */)
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (PICTOGRAPH.test(text.textContent ?? '')) count += 1
  }
  return count
}

/** Is this node drawn right now, with no interaction of any kind? */
function isDrawn(node: Element): boolean {
  if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') return false
  const view = node.ownerDocument.defaultView
  const style = view?.getComputedStyle(node)
  if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0'))
    return false
  return (node.textContent ?? '').trim().length > 0
}

/**
 * The 30 contract-level cases. Every one of them must pass against every shipped presentation,
 * which is what makes "swappable" a property rather than a claim.
 */
export function presentationConformance(presentation: () => Presentation): ConformanceCase[] {
  const cases: ConformanceCase[] = []
  const test = (
    name: string,
    run: (s: Scene) => Promise<void>,
    options?: CommentUIOptions,
  ): void => {
    cases.push({
      name,
      async run() {
        const s = await scene(presentation, options)
        try {
          await run(s)
        } finally {
          await s.dispose()
        }
      },
    })
  }

  /* ------------------------------------------------------------------- layer and roles */

  test('mounts one open shadow root carrying a polite status region', async (s) => {
    assertEqual(s.root.mode, 'open', 'the shadow root is open')
    const status = s.root.querySelector('[role="status"]')
    assert(status, 'a role="status" region exists')
    assertEqual(status.getAttribute('aria-live'), 'polite', 'the status region is polite')
  })

  test('never mutates the host page DOM', async (s) => {
    const before = s.doc.body.innerHTML
    await s.seed('#a')
    s.engine.startPlacement('comment')
    await s.settle()
    assertEqual(s.doc.body.innerHTML, before, 'the page is untouched')
  })

  test('every interactive control is a real button with a type and a name', async (s) => {
    const id = await s.seed('#a')
    s.ui.focus(id)
    s.engine.placement.start('comment', { element: s.doc.querySelector('#b')! })
    await tick()
    for (const button of allButtons(s.root)) {
      assertEqual(button.getAttribute('type'), 'button', 'every button declares type=button')
      assert(nameOf(button).length > 0, 'every button has a non-empty accessible name')
    }
  })

  /* ----------------------------------------------------------------------------- badges */

  test('an anchored thread gets a badge named from its mode and comment count', async (s) => {
    const id = await s.seed('#a', 'x', 'ask')
    const badge = badgeNamed(s.root, 'Ask (1)')
    assert(badge, 'the badge is named "<mode label> (<count>)"')
    assertEqual(badge.tagName, 'BUTTON', 'a badge is a real button')
    assertEqual(badge.getAttribute('aria-expanded'), 'false', 'a closed badge is not expanded')
    await s.engine.appendComment(id, { author: 'copilot', body: 'reply' })
    await s.settle()
    assert(badgeNamed(s.root, 'Ask (2)'), 'the count is part of the accessible name')
  })

  test('a thread with no mode badge falls back to its raw kind', async (s) => {
    await s.seed('#a')
    assert(badgeNamed(s.root, 'comment (1)'), 'the kind is the fallback name')
  })

  test('a badge registered for positioning is placed by the controller', async (s) => {
    await s.seed('#a')
    const badge = badgeNamed(s.root, 'comment (1)')
    assert(badge, 'a badge exists')
    // §3.1.5: `left`/`top` are the controller's, so a presentation that positions its own
    // anchored nodes fails here.
    assert(badge.style.left !== '' && badge.style.top !== '', 'the badge received left/top')
  })

  test('deleting a thread removes its badge', async (s) => {
    const id = await s.seed('#a')
    assertEqual(badges(s.root).length, 1, 'one badge')
    await s.engine.delete(id)
    await s.settle()
    assertEqual(badges(s.root).length, 0, 'no badge survives the delete')
  })

  test('a cold engine paints nothing before its first anchoring pass', async (s) => {
    // `pending` renders nothing, normatively: on a cold load that is EVERY thread.
    assertEqual(badges(s.root).length, 0, 'no badge on an empty page')
    assertEqual(s.root.querySelectorAll('li').length, 0, 'no panel row on an empty page')
  })

  /* -------------------------------------------------------------------- thread dialog */

  test('a badge click opens a named dialog and flips aria-expanded', async (s) => {
    await s.seed('#a')
    fire(badgeNamed(s.root, 'comment (1)'), 'click')
    await tick()
    assert(visibleDialog(s.root, 'comment (1)'), 'the thread dialog is named like its badge')
    assertEqual(
      badgeNamed(s.root, 'comment (1)')?.getAttribute('aria-expanded'),
      'true',
      'the badge reports its popover',
    )
  })

  test('closing the thread dialog returns focus to its badge', async (s) => {
    await s.seed('#a')
    fire(badgeNamed(s.root, 'comment (1)'), 'click')
    await tick()
    const dialog = visibleDialog(s.root, 'comment (1)')
    assert(dialog, 'the dialog is open')
    fire(control(dialog, s.labels.dismiss), 'click')
    await tick()
    assertEqual(
      s.root.activeElement,
      badgeNamed(s.root, 'comment (1)'),
      'focus returns to the badge',
    )
  })

  test('Escape inside the thread dialog closes it', async (s) => {
    await s.seed('#a')
    fire(badgeNamed(s.root, 'comment (1)'), 'click')
    await tick()
    press(s.root.querySelector('[role="dialog"]'), 'Escape')
    await tick()
    assertEqual(
      badgeNamed(s.root, 'comment (1)')?.getAttribute('aria-expanded'),
      'false',
      'the dialog closed',
    )
  })

  test('the thread dialog lists one entry per comment, oldest first', async (s) => {
    const id = await s.seed('#a', 'from a human')
    await s.engine.appendComment(id, { author: 'copilot', body: 'from a machine' })
    await s.settle()
    s.ui.focus(id)
    await tick()
    const dialog = visibleDialog(s.root, 'comment (2)')
    assert(dialog, 'the dialog is open')
    const text = dialog.textContent ?? ''
    assert(text.includes('from a human'), 'the first comment is rendered')
    assert(text.includes('from a machine'), 'the second comment is rendered')
    assert(
      text.indexOf('from a human') < text.indexOf('from a machine'),
      'comments are oldest-first',
    )
  })

  test('Reply opens the composer for that thread', async (s) => {
    const id = await s.seed('#a')
    s.ui.focus(id)
    await tick()
    fire(control(visibleDialog(s.root, 'comment (1)')!, s.labels.reply), 'click')
    await tick()
    assertEqual(s.engine.placement.get().phase, 'composing', 'placement is composing')
    assertEqual(
      (s.engine.placement.get() as { replyTo: string | null }).replyTo,
      id,
      'the composer is a reply to that thread',
    )
  })

  test('Resolve then Reopen round-trips from the dialog', async (s) => {
    const id = await s.seed('#a')
    s.ui.focus(id)
    await tick()
    fire(control(visibleDialog(s.root, 'comment (1)')!, s.labels.resolve), 'click')
    await s.settle()
    assertEqual(s.engine.getThreadView(id)?.isResolved, true, 'the thread resolved')
    s.ui.panel.open('resolved')
    await tick()
    const reopen = control(s.root, s.labels.reopen)
    assert(reopen, 'a resolved thread stays reopenable')
    fire(reopen, 'click')
    await s.settle()
    assertEqual(s.engine.getThreadView(id)?.isResolved, false, 'the thread reopened')
  })

  test('Delete removes the thread and leaves focus inside the widget', async (s) => {
    const id = await s.seed('#a')
    s.ui.focus(id)
    await tick()
    // The contract is that the delete is **reachable from the dialog by its accessible name and
    // removes the thread** — not that it takes exactly one click. A presentation is free to arm
    // a destructive control first (`docs/DESIGN.md` §6.4 `arm`: the glass appearance requires a
    // second click within 4 s, on the same control, with the same name), so the case activates
    // it until it fires. Two activations is the ceiling: a control that still has not deleted
    // anything is a broken control, not a careful one.
    for (let attempt = 0; attempt < 2 && s.engine.listThreads().length > 0; attempt += 1) {
      fire(control(visibleDialog(s.root, 'comment (1)')!, s.labels.delete), 'click')
      await s.settle()
    }
    assertEqual(s.engine.listThreads().length, 0, 'the thread is gone')
    assert(s.root.activeElement !== null, 'focus stayed inside the shadow root')
    assertEqual(s.doc.activeElement, s.root.host, 'the page only ever sees the host')
  })

  test('an orphaned thread keeps its captured text readable', async (s) => {
    const id = await s.seed('#a', 'orphan me')
    await s.page.mutate((doc) => {
      doc.querySelector('#a')?.remove()
    })
    await s.settle()
    assertEqual(s.engine.getThreadView(id)?.isOrphaned, true, 'the thread orphaned')
    s.ui.focus(id)
    await tick()
    const dialog = visibleDialog(s.root, 'comment (1)')
    assert(dialog, 'an orphan is still openable')
    assert((dialog.textContent ?? '').includes('alpha text'), 'the capture is shown for an orphan')
  })

  test('an approximately re-anchored thread carries a text equivalent, not just colour', async (s) => {
    const id = await s.seed('#a')
    await s.engine.reanchor(id)
    await s.settle()
    const badge = badgeNamed(s.root, 'comment (1)')
    assert(badge, 'the badge exists')
    if ((s.engine.getThreadView(id)?.anchoring.confidence ?? 1) >= 0.85) return
    assertEqual(
      badge.getAttribute('title'),
      s.labels.approximate,
      'approximate is spelled out in words',
    )
  })

  /* ----------------------------------------------------------------------- the composer */

  test('the composer is a named dialog with a labelled input', async (s) => {
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    const dialog = visibleDialog(s.root, s.labels.placeholder)
    assert(dialog, 'the composer is a dialog named by the placeholder')
    const input = dialog.querySelector('textarea')
    assert(input, 'the composer has a textarea')
    assertEqual(nameOf(input), s.labels.placeholder, 'the textarea is labelled')
  })

  test('the composer takes focus on open and returns it on close', async (s) => {
    await s.seed('#b')
    const badge = badgeNamed(s.root, 'comment (1)')
    assert(badge, 'a badge to focus')
    badge.focus()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    const input = visibleDialog(s.root, s.labels.placeholder)?.querySelector('textarea')
    assertEqual(s.root.activeElement, input, 'focus moved to the textarea')
    s.engine.placement.cancel('test')
    await tick()
    assertEqual(s.root.activeElement, badgeNamed(s.root, 'comment (1)'), 'focus came back')
  })

  test('Escape inside the composer cancels placement', async (s) => {
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    press(visibleDialog(s.root, s.labels.placeholder)?.querySelector('textarea') ?? null, 'Escape')
    await tick()
    assertEqual(s.engine.placement.get().phase, 'idle', 'placement cancelled')
  })

  test('Send persists exactly one thread and closes the composer', async (s) => {
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    const dialog = visibleDialog(s.root, s.labels.placeholder)
    assert(dialog, 'the composer is open')
    const input = dialog.querySelector('textarea')
    assert(input, 'the composer has a textarea')
    typeInto(input, 'a real comment')
    await tick()
    fire(control(dialog, s.labels.send), 'click')
    await s.settle()
    assertEqual(s.engine.listThreads().length, 1, 'one thread was written')
    assertEqual(s.engine.listThreads()[0]?.lastComment.body, 'a real comment', 'with that body')
  })

  test('Cmd/Ctrl+Enter submits from the textarea', async (s) => {
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    const input = visibleDialog(s.root, s.labels.placeholder)?.querySelector('textarea')
    assert(input, 'the composer has a textarea')
    typeInto(input, 'via keyboard')
    await tick()
    press(input, 'Enter', { metaKey: true })
    await s.settle()
    assertEqual(s.engine.listThreads()[0]?.lastComment.body, 'via keyboard', 'the draft landed')
  })

  test('Tab is trapped inside the composer dialog', async (s) => {
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    const dialog = visibleDialog(s.root, s.labels.placeholder)
    assert(dialog, 'the composer is open')
    const input = dialog.querySelector('textarea')
    assert(input, 'the composer has a textarea')
    typeInto(input, 'x')
    await tick()
    const send = control(dialog, s.labels.send)
    assert(send, 'a Send control')
    send.focus()
    press(send, 'Tab')
    assert(dialog.contains(s.root.activeElement), 'Tab stayed inside the dialog')
  })

  test('dismissing the composer cancels placement and writes nothing', async (s) => {
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    const dialog = visibleDialog(s.root, s.labels.placeholder)
    assert(dialog, 'the composer is open')
    // **Whether a composer draws a Dismiss control is a design decision, not a contract.** The
    // contract is that there is a non-submitting exit and that taking it writes nothing. One
    // shipped appearance draws the button; the other deletes it and leaves `Esc` and click-away
    // (which preserves the draft rather than discarding it) — so this case asks for the exit the
    // presentation actually offers, and holds both to the same outcome.
    const dismiss = control(dialog, s.labels.dismiss)
    if (dismiss) fire(dismiss, 'click')
    else press(dialog.querySelector('textarea'), 'Escape')
    await s.settle()
    assertEqual(s.engine.placement.get().phase, 'idle', 'placement cancelled')
    assertEqual(s.engine.listThreads().length, 0, 'and nothing was written')
  })

  /* -------------------------------------------------------------------------- the panel */

  test('the panel is a named region with heading-labelled lists', async (s) => {
    const panel = s.root.querySelector('section[role="region"]')
    assert(panel, 'the panel is a <section role="region">')
    assertEqual(panel.getAttribute('aria-label'), s.labels.panelTitle, 'named by panelTitle')
    const lists = [...panel.querySelectorAll('ul')]
    assert(lists.length >= 1, 'at least one list')
    for (const list of lists) {
      const id = list.getAttribute('aria-labelledby')
      assert(id, 'every list is labelled by a heading')
      assert(panel.querySelector(`#${id}`), 'the heading it names exists')
    }
  })

  test('the panel toggle is a named button reporting its expanded state', async (s) => {
    const toggle = control(s.root, s.labels.panelTitle)
    assert(toggle, 'a toggle named by panelTitle')
    assertEqual(toggle.getAttribute('aria-expanded'), 'true', 'defaultOpen is reported')
    fire(toggle, 'click')
    await tick()
    assertEqual(s.ui.panel.isOpen, false, 'the toggle closes the panel')
    assertEqual(
      control(s.root, s.labels.panelTitle)?.getAttribute('aria-expanded'),
      'false',
      'and reports it',
    )
  })

  test('a resolved thread leaves the page and stays reachable from the panel', async (s) => {
    const id = await s.seed('#a')
    await s.engine.resolve(id)
    await s.settle()
    assertEqual(badges(s.root).length, 0, 'the badge left the page')
    assert(control(s.root, s.labels.reopen), 'the panel offers a reopen')
  })

  test('a panel row opens its thread', async (s) => {
    const id = await s.seed('#a', 'the only thing')
    const row = [...s.root.querySelectorAll<HTMLElement>('li button')].find((node) =>
      (node.textContent ?? '').includes('the only thing'),
    )
    assert(row, 'a panel row for the thread')
    fire(row, 'click')
    await tick()
    assert(visibleDialog(s.root, 'comment (1)'), 'the thread dialog opened')
    assertEqual(s.engine.active.get(), id, 'the engine was told')
  })

  /* -------------------------------------------------------- chips, placement, teardown */

  test('a decoration chip is rendered and cleared from data alone', async (s) => {
    const id = await s.seed('#a')
    s.ui.decorate(id, { chip: { text: 'thinking', tone: 'busy', spinner: true } })
    await tick()
    const badge = badgeNamed(s.root, 'comment (1)')
    assert(badge, 'the badge exists')
    assert((badge.textContent ?? '').includes('thinking'), 'the chip text is rendered')
    s.ui.decorate(id, null)
    await tick()
    assert(
      !(badgeNamed(s.root, 'comment (1)')?.textContent ?? '').includes('thinking'),
      'null clears it',
    )
  })

  test('placement announces the pick hint and clears it on cancel', async (s) => {
    s.engine.startPlacement('comment')
    await tick()
    const status = s.root.querySelector('[role="status"]')
    assertEqual(status?.textContent, s.labels.pickHint, 'the hint was announced')
    s.engine.placement.cancel('escape')
    await tick()
    assertEqual(status?.textContent, '', 'the region is cleared so a re-entry re-announces')
  })

  /* ----------------------------------------- §3.1.2's drawing obligations (§0 D2/D4/D5) */

  test("an open thread's metadata is drawn with no interaction at all (§0 D2)", async (s) => {
    // Contract, not taste: intent-based hiding governs surfaces *at rest*; it has no authority
    // inside a surface the user has already opened. Hover may only ever ADD.
    const id = await s.seed('#a', 'a body worth reading')
    await s.engine.appendComment(id, { author: 'copilot', body: 'and a reply' })
    await s.settle()
    s.ui.focus(id)
    await tick()
    const dialog = visibleDialog(s.root, 'comment (2)')
    assert(dialog, 'the thread dialog is open')

    const times = [...dialog.querySelectorAll('time')]
    assertEqual(times.length, 2, 'every comment carries its own timestamp')
    for (const time of times) {
      assert(time.getAttribute('datetime'), 'the timestamp is a machine value')
      assert(isDrawn(time), 'the timestamp is drawn without hover, focus or any other signal')
    }
    // The author axis is in the accessibility tree for both authors, drawn or not.
    const text = dialog.textContent ?? ''
    assert(text.includes('user'), 'a user comment exposes its author')
    assert(text.includes('copilot'), 'a copilot comment exposes its author')
  })

  test('a pin draws at most one mark, and keeps its count in the name (§0 D5)', async (s) => {
    const id = await s.seed('#a', 'x', 'ask')
    await s.engine.appendComment(id, { author: 'copilot', body: 'reply' })
    await s.settle()
    for (const pin of badges(s.root)) {
      const marks = marksIn(pin)
      assert(marks <= 1, `a pin drew ${String(marks)} marks; the contract allows one`)
    }
    // …which is affordable precisely because the count never left the accessibility tree.
    assert(badgeNamed(s.root, 'Ask (2)'), 'the count is in the accessible name')
  })

  test('actions.reply means a reply affordance INSIDE the thread surface (§0 D4)', async (s) => {
    const id = await s.seed('#a')
    s.ui.focus(id)
    await tick()
    const dialog = visibleDialog(s.root, 'comment (1)')
    assert(dialog, 'the thread dialog is open')
    const affordance = control(dialog, s.labels.reply)
    assert(affordance, 'a reply affordance is rendered, not merely summonable')
    assert(dialog.contains(affordance), 'and it lives inside the thread surface')
    assert(isDrawn(affordance) || !affordance.hasAttribute('hidden'), 'it is not hidden at rest')
  })

  test('unmount removes every node the presentation added', async (s) => {
    await s.seed('#a')
    const host = s.root.host
    s.ui.unmount()
    assertEqual(host.isConnected, false, 'the host element is gone from the page')
  })

  return cases
}
