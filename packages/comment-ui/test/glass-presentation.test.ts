/**
 * `glassPresentation` against `docs/DESIGN.md` — the rules the conformance suite deliberately
 * cannot see.
 *
 * `presentationConformance` asserts what every appearance owes the contract, and by rule it may
 * not name a class. That is exactly why it cannot test *this* design: "rest state is a 12 px dot
 * until intent is expressed" is not a contract, it is a **decision**, and a decision with five
 * mandatory mitigations attached. Ship it without any one of them and the dormant badge stops
 * being a design and becomes a bug — silently, with the conformance suite still green.
 *
 * So this file is allowed to be specific. It asserts the intent/disclosure map of §7 row by row,
 * the reduced-motion mapping of §6.7, the glyph inventory of §5, the page-polarity read of §2.5,
 * and the one thing the byte budget of §12 actually rests on: that selecting this appearance adds
 * **zero** public tokens and **zero** runtime dependencies.
 *
 * It is not a replacement for looking at it. Nothing in happy-dom has layout, a cascade, a top
 * layer or a compositor, so what is asserted here is the *state machine* the CSS reacts to —
 * which attribute is on which node, and when.
 */

import { afterEach, describe, expect, test } from 'vitest'

import type { DomScene } from './support.ts'

import { glassPresentation, glassStyles } from '../src/glass.ts'
import { BUSY_QUIET_MS, rungOf } from '../src/presentations/glass/chip.ts'
import { ICON_IDS, ICONS } from '../src/presentations/glass/icons.ts'
import { createPolarityWatcher, lightnessOf } from '../src/presentations/glass/intent.ts'
import { $, $$, click, domScene, press, tick, type } from './support.ts'

const PAGE =
  '<article id="a" data-testid="a">alpha text</article>' +
  '<div id="b" data-testid="b">beta text</div>' +
  '<p id="c" data-testid="c">gamma text</p>'

const cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
  document.querySelectorAll('[data-comment-ui]').forEach((node) => {
    node.remove()
  })
})

async function boot(ui?: Parameters<typeof glassPresentation>[0]): Promise<DomScene> {
  const s = await domScene(PAGE, {
    ui: { panel: { defaultOpen: false }, presentation: glassPresentation(ui) },
  })
  cleanup.push(s.dispose)
  return s
}

/** The proximity tracker coalesces onto a frame, so a move needs one to land. */
async function movePointer(s: DomScene, x: number, y: number): Promise<void> {
  const view = s.doc.defaultView as Window & typeof globalThis
  view.dispatchEvent(new view.MouseEvent('pointermove', { clientX: x, clientY: y }))
  await new Promise<void>((done) => setTimeout(done, 32))
  await tick()
}

/* ------------------------------------------------------------------ §7, the disclosure map */

describe('§7 — nothing exists until intent is expressed', () => {
  test('row 1: a resting badge carries no reveal signal, and its full name regardless', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'x', { kind: 'ask' })
    const badge = $(s.root, `.cc-badge[data-thread="${id}"]`)
    expect(badge?.getAttribute('data-near')).toBe('false')
    expect(badge?.hasAttribute('data-chip')).toBe(false)
    // The fifth mitigation is unconditional: the accessible name is complete in EVERY state,
    // including the 12 px dot. A badge nobody can see must still be a badge somebody can hear.
    expect(badge?.getAttribute('aria-label')).toBe('Ask (1)')
    expect(badge?.getAttribute('aria-haspopup')).toBe('dialog')
  })

  test('row 1: signal S1 — the pointer coming within 96 px reveals, leaving un-reveals', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    const badge = $(s.root, `.cc-badge[data-thread="${id}"]`)!

    await movePointer(s, 4, 4)
    expect(badge.getAttribute('data-near')).toBe('true')
    await movePointer(s, 900, 900)
    expect(badge.getAttribute('data-near')).toBe('false')
  })

  test('row 1: the proximity listener is detached while the picker owns the cursor', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    const badge = $(s.root, `.cc-badge[data-thread="${id}"]`)!
    await movePointer(s, 4, 4)
    expect(badge.getAttribute('data-near')).toBe('true')

    s.engine.startPlacement('comment')
    await s.settle()
    // Suspended, and every badge reset — during a pick every one of them washes out anyway,
    // and one `pointermove` listener on someone else's page is one too many when it is useless.
    expect(badge.getAttribute('data-near')).toBe('false')
    await movePointer(s, 4, 4)
    expect(badge.getAttribute('data-near')).toBe('false')
  })

  test('row 2: the count is absent at one and present from two', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    const count = $(s.root, `.cc-badge[data-thread="${id}"] .cc-badge-count`)
    expect(count?.textContent).toBe('')
    await s.engine.appendComment(id, { author: 'copilot', body: 'second' })
    await s.settle()
    expect($(s.root, `.cc-badge[data-thread="${id}"] .cc-badge-count`)?.textContent).toBe('2')
  })

  test('row 3: the state silhouette is drawn unconditionally, never colour alone', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    const badge = $(s.root, `.cc-badge[data-thread="${id}"]`)!
    expect(badge.getAttribute('data-state')).toBe('open')
    expect($(badge, '.cc-badge-marks')?.getAttribute('data-marks')).toBe('')

    await s.page.mutate((doc) => {
      doc.querySelector('#a')?.remove()
    })
    await s.settle()
    const orphan = $(s.root, `.cc-badge[data-thread="${id}"]`)!
    expect(orphan.getAttribute('data-state')).toBe('orphaned')
    // A drawn glyph, not a CSS `content` string: the guarantee has to survive a missing font.
    const mark = $(orphan, '.cc-mark')
    expect(mark?.getAttribute('data-mark')).toBe('orphaned')
    expect(mark?.querySelector('use')?.getAttribute('href')).toBe('#cc-i-pin-off')
  })

  test('row 4 / §8.6: a run under 450 ms draws nothing, and says everything', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.decorate(id, { chip: { text: 'thinking', tone: 'busy', spinner: true } })
    await tick()
    const chip = $(s.root, `.cc-badge[data-thread="${id}"] .cc-chip`)!
    expect(chip.getAttribute('data-rung')).toBe('0')
    // Collapsed for eyes, complete for assistive technology — and the slot is the live region,
    // so a chip that announced by disappearing would announce nothing at all.
    expect($(chip, '.cc-chip-text')?.textContent).toBe('thinking')
    expect(chip.getAttribute('title')).toBe('thinking')
    expect(
      $(s.root, `.cc-badge[data-thread="${id}"] .cc-chip-slot`)?.getAttribute('aria-live'),
    ).toBe('polite')
    // S6: a badge carrying live copilot state is never allowed to hide behind the reveal rules.
    expect($(s.root, `.cc-badge[data-thread="${id}"]`)?.getAttribute('data-chip')).toBe('busy')

    await new Promise<void>((done) => setTimeout(done, BUSY_QUIET_MS + 40))
    expect(chip.getAttribute('data-rung')).toBe('2')
  })

  test('§8.6: the ladder is a total function of the chip, and only failure draws text', () => {
    const now = 10_000
    const chip = (tone: string, spinner = false) =>
      ({ text: 't', tone, spinner }) as Parameters<typeof rungOf>[0]
    expect(rungOf(chip('busy', true), now, now)).toBe('0')
    expect(rungOf(chip('busy', true), now - BUSY_QUIET_MS, now)).toBe('2')
    expect(rungOf(chip('neutral'), 0, now)).toBe('1')
    expect(rungOf(chip('info'), 0, now)).toBe('5')
    expect(rungOf(chip('warn'), 0, now)).toBe('4')
    expect(rungOf(chip('danger'), 0, now)).toBe('4')
    // A spinner without the busy tone is still a run in flight: precedence is the host's, and
    // it already collapsed into this one object.
    expect(rungOf(chip('neutral', true), now, now)).toBe('0')
    // Only rungs 4 and the danger tone un-hide the text; the sheet is where that is spelled.
    expect(glassStyles).toContain(".cc-chip[data-rung='4'] .cc-chip-text")
  })

  test('row 5: zero threads is zero pixels, and the seed appears with the first one', async () => {
    const s = await boot()
    const seed = $(s.root, '.cc-seed')!
    expect(seed.getAttribute('data-count')).toBe('zero')
    // A CSS state, never the `hidden` attribute: the seed stays focusable and nameable at all
    // times, which is the whole reason hiding it is defensible.
    expect(seed.hasAttribute('hidden')).toBe(false)
    expect(seed.getAttribute('aria-label')).toBe('Comments')

    await s.seed('#a')
    expect($(s.root, '.cc-seed')?.getAttribute('data-count')).toBe('some')
    // The count is mid-roll for 220 ms — two spans, one leaving and one arriving — so the
    // settled value lives on the attribute the roll is keyed by, not on `textContent`.
    expect($(s.root, '.cc-seed-count')?.getAttribute('data-value')).toBe('1')
  })

  test('row 5: signal S1 reaches the seed at its own 140 px radius', async () => {
    const s = await boot()
    await s.seed('#a')
    const seed = $(s.root, '.cc-seed')!
    await movePointer(s, 0, 0)
    expect(seed.getAttribute('data-near')).toBe('true')
  })

  test('row 8: the section switch is a segmented control of glyphs and counts', async () => {
    const s = await boot()
    await s.seed('#a')
    s.ui.panel.open('open')
    await tick()
    const segments = $$(s.root, '.cc-segment')
    expect(segments).toHaveLength(3)
    expect(segments.map((node) => node.getAttribute('data-section'))).toEqual([
      'open',
      'resolved',
      'unanchored',
    ])
    // Words leave the screen and stay in the accessibility tree, exactly as §10 requires — with
    // amendment A1's single exception, the *selected* segment, which draws its own word.
    for (const segment of segments) {
      expect(segment.getAttribute('aria-label')).toBeTruthy()
      expect(segment.getAttribute('title')).toBe(segment.getAttribute('aria-label'))
      const label = $(segment, '.cc-segment-label')
      expect(label?.getAttribute('aria-hidden')).toBe('true')
      // Written on every segment, *drawn* on one: which one is a CSS state, so switching
      // sections costs no DOM write and the accessible name never depends on the selection.
      expect(label?.textContent).toBe(segment.getAttribute('aria-label'))
    }
    expect(glassStyles).toContain('.cc-segment-label { display: none;')
    expect(glassStyles).toContain(
      ".cc-segment[aria-pressed='true'] .cc-segment-label { display: inline; }",
    )
    expect(segments[0].getAttribute('aria-pressed')).toBe('true')
    expect($(segments[0], '.cc-segment-count')?.getAttribute('data-value')).toBe('1')

    press(segments[0], 'ArrowRight')
    await tick()
    expect($$(s.root, '.cc-segment')[1].getAttribute('aria-pressed')).toBe('true')
  })

  test('§8.5: a popover rails the panel rather than closing it', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.panel.open()
    await tick()
    const panel = $(s.root, '.cc-panel')!
    expect(panel.getAttribute('data-open')).toBe('true')
    expect(panel.hasAttribute('data-rail')).toBe(false)

    s.ui.focus(id)
    await s.settle()
    // Attention becomes singular; state is preserved — the panel is still open underneath.
    expect(panel.getAttribute('data-rail')).toBe('true')
    expect(panel.getAttribute('data-open')).toBe('true')
    expect(s.ui.panel.isOpen).toBe(true)
  })

  test('rows 15–16: click-away collapses a written draft to a pearl instead of losing it', async () => {
    const s = await boot()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    const input = $(s.root, '.cc-composer-input') as HTMLTextAreaElement
    type(input, 'half a thought')
    await tick()

    const view = s.doc.defaultView as Window & typeof globalThis
    s.doc.body.dispatchEvent(new view.MouseEvent('pointerdown', { bubbles: true, composed: true }))
    await tick()

    // The placement is untouched — this is a rendering state, not a second store, and the draft
    // is already the controller's.
    expect(s.engine.placement.get().phase).toBe('composing')
    expect($(s.root, '.cc-composer')?.getAttribute('data-open')).toBe('false')
    const pearl = $(s.root, '.cc-pearl')!
    expect(pearl.hasAttribute('hidden')).toBe(false)

    click(pearl)
    await tick()
    expect($(s.root, '.cc-composer')?.getAttribute('data-open')).toBe('true')
    expect((($(s.root, '.cc-composer-input') as HTMLTextAreaElement) || input).value).toBe(
      'half a thought',
    )
  })

  test('row 15: an EMPTY composer clicked away is a plain cancel, with nothing to preserve', async () => {
    const s = await boot()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    const view = s.doc.defaultView as Window & typeof globalThis
    s.doc.body.dispatchEvent(new view.MouseEvent('pointerdown', { bubbles: true, composed: true }))
    await s.settle()
    expect(s.engine.placement.get().phase).toBe('idle')
    expect($(s.root, '.cc-pearl')?.hasAttribute('hidden')).toBe(true)
  })

  test('row 17: the send disc is the only composer control, and it reports empty', async () => {
    const s = await boot()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    const composer = $(s.root, '.cc-composer')!
    expect(composer.getAttribute('data-empty')).toBe('true')
    // §8.3 / §10: the Dismiss button is deleted outright. `Esc` and click-away are the exits,
    // and `Labels.dismiss` stays in use on the popover's close control.
    expect($$(composer, 'button').map((node) => node.getAttribute('data-action'))).toEqual(['send'])

    type($(s.root, '.cc-composer-input') as HTMLTextAreaElement, 'x')
    await tick()
    expect(composer.getAttribute('data-empty')).toBeNull()
  })

  test('rows 18–19: the pick overlay is drawn, and every node of it is click-through', async () => {
    const s = await boot()
    expect($(s.root, '.cc-scrim')?.hasAttribute('hidden')).toBe(true)
    const view = s.doc.defaultView as Window & typeof globalThis
    s.doc
      .querySelector('#a')!
      .dispatchEvent(new view.MouseEvent('mouseover', { bubbles: true, composed: true }))
    expect(s.engine.startPlacement('comment')).toBe(true)
    await s.settle()

    // The cursor glyph rides from the first frame of the session; the scrim and its ring wait
    // for a candidate, because there is nothing to punch a hole in until there is one.
    expect($(s.root, '.cc-cursor')?.hasAttribute('hidden')).toBe(false)
    expect($(s.root, '.cc-scrim')?.hasAttribute('hidden')).toBe(false)
    expect($(s.root, '.cc-ring')?.hasAttribute('hidden')).toBe(false)
    // The engine resolves the candidate from `composedPath()[0]` and does not filter shadow
    // trees, so a single `pointer-events: auto` node here would anchor the thread on our own
    // highlight. The rule is in the sheet, and it is not negotiable.
    expect(glassStyles).toContain(
      '.cc-scrim, .cc-ring, .cc-pick-hint, .cc-cursor, .cc-status { pointer-events: none; }',
    )
    expect(glassStyles).toContain(".cc-layer[data-picking='true'] > * { pointer-events: none; }")
  })

  test('§10: the popover draws no verb and no noun, and loses none of them', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.focus(id)
    await s.settle()
    const popover = $(s.root, '.cc-thread')!
    for (const button of $$(popover, 'button')) {
      expect({
        action: button.getAttribute('data-action'),
        text: (button.textContent ?? '').trim(),
      }).toEqual({ action: button.getAttribute('data-action'), text: '' })
      // Every icon-only control carries a native `title` AND an `aria-label`. The tooltip is the
      // browser's: zero bytes, above the top layer, OS-styled, and it cannot cover content on a
      // busy host page because the OS positions it.
      expect(button.getAttribute('aria-label')).toBeTruthy()
      expect(button.getAttribute('title')).toBe(button.getAttribute('aria-label'))
    }
    // The head is a glyph, not a title — and it is the same glyph the badge was carrying.
    expect($(popover, '.cc-head-icon')?.querySelector('use')?.getAttribute('href')).toBe(
      '#cc-i-comment',
    )
    expect($(popover, '.cc-head-title')).toBeNull()
  })

  test('§10: the panel keeps every empty sentence in the tree and none of them on screen', async () => {
    const s = await boot()
    s.ui.panel.open('resolved')
    await tick()
    const empty = $(s.root, '.cc-section[data-section="resolved"] .cc-empty')!
    expect(empty.hasAttribute('hidden')).toBe(false)
    expect($(empty, '.cc-empty-icon')).not.toBeNull()
    expect($(empty, '.cc-vh')?.textContent).toBe('No resolved comments.')
    // A visually-hidden node rather than the list's `aria-label`, which `aria-labelledby` — the
    // heading-labelled-list shape the a11y contract requires — would shadow.
    expect(
      $(s.root, '.cc-section[data-section="resolved"] .cc-rows')?.getAttribute('aria-label'),
    ).toBeNull()
  })
})

/* ------------------------------------------------------ the first-touch pass (amendments A1–A4) */

/**
 * What a browser said and this environment could not. Every case below is a finding from a
 * real-Chromium walk of the demo, and each one was green in happy-dom while being wrong on
 * screen — which is exactly why the assertions here reach for the emitted **sheet** as often as
 * for the DOM: there is no cascade, no top layer and no UA stylesheet in this runtime, so a rule
 * that exists is the strongest statement this suite can make about a rule that renders.
 */
describe('§3.3 / A4 — the UA popover border, and the states the sheet forgot to draw', () => {
  test('every top-layer surface resets `border`, because the UA gives it a 3 px frame', async () => {
    const s = await boot()
    // The UA sheet styles EVERY `[popover]` with `border: solid` — a 3 px currentColor rectangle,
    // near-black on light and white on dark, drawn outside our own keyline. happy-dom ships no UA
    // stylesheet, so 256 green tests said nothing at all about it. §3.3 also bans borders on our
    // own surfaces: hairlines are box-shadow spreads, always.
    expect(glassStyles).toContain(
      '.cc-float { position: fixed; top: 0; left: 0; margin: 0; border: 0; }',
    )
    expect(glassStyles).toContain('.cc-composer, .cc-thread { display: none; border: 0; }')
    for (const node of [$(s.root, '.cc-composer'), $(s.root, '.cc-thread')]) {
      expect(node?.classList.contains('cc-float')).toBe(true)
    }
  })

  test('a resolved thread draws a silhouette and mutes, rather than swapping one colour', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.focus(id)
    await s.settle()
    await s.engine.resolve(id)
    await s.settle()
    const popover = $(s.root, '.cc-thread')!
    expect(popover.getAttribute('data-resolved')).toBe('true')
    // The check is a drawn 10 px glyph beside the head — §1.3's guarantee is made of shapes.
    expect($(popover, '.cc-mark')?.getAttribute('data-mark')).toBe('resolved')
    expect(glassStyles).toContain(".cc-thread[data-resolved='true'] .cc-head-icon")
    expect(glassStyles).toContain(
      ".cc-thread[data-resolved='true'] .cc-body,\n.cc-thread[data-resolved='true'] .cc-quote { color: var(--_muted); }",
    )
  })

  test('delete arms on the first click and fires on the second (§6.4 `arm`)', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.focus(id)
    await s.settle()
    const remove = $(s.root, '.cc-thread [data-action="delete"]')!

    click(remove)
    await s.settle()
    // Nothing was deleted, and the control says so with a tint AND a ring — 26 px, unlabelled,
    // adjacent to Resolve, is not a control that may destroy a thread on one click.
    expect(remove.getAttribute('data-confirm')).toBe('true')
    expect(s.engine.listThreads()).toHaveLength(1)
    // The name is unchanged: no eighteenth `Labels` key, no second string, no dialog.
    expect(remove.getAttribute('aria-label')).toBe('Delete')

    click(remove)
    await s.settle()
    expect(s.engine.listThreads()).toHaveLength(0)
    expect(remove.hasAttribute('data-confirm')).toBe(false)
  })

  test('…and anything else disarms it: another click in the sheet, or `Esc`', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.focus(id)
    await s.settle()
    const remove = $(s.root, '.cc-thread [data-action="delete"]')!

    click(remove)
    expect(remove.getAttribute('data-confirm')).toBe('true')
    click($(s.root, '.cc-thread [data-action="reply"]'))
    expect(remove.hasAttribute('data-confirm')).toBe(false)
    expect(s.engine.listThreads()).toHaveLength(1)

    click(remove)
    expect(remove.getAttribute('data-confirm')).toBe('true')
    press($(s.root, '.cc-thread'), 'Escape')
    expect(remove.hasAttribute('data-confirm')).toBe(false)
    expect(s.engine.listThreads()).toHaveLength(1)
  })

  test('the panel row that deletes an invisible thread arms too', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    await s.page.mutate((doc) => {
      doc.querySelector('#a')?.remove()
    })
    await s.settle()
    s.ui.panel.open('unanchored')
    await tick()
    const remove = $(s.root, `.cc-row[data-thread="${id}"] [data-action="delete"]`)!

    click(remove)
    await s.settle()
    expect(remove.getAttribute('data-confirm')).toBe('true')
    expect(s.engine.listThreads()).toHaveLength(1)
    click(remove)
    await s.settle()
    expect(s.engine.listThreads()).toHaveLength(0)
  })

  test('row 1b: a docked orphan is drawn, held revealed, and never `hidden`', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    await s.page.mutate((doc) => {
      doc.querySelector('#a')?.remove()
    })
    await s.settle()

    const badge = $(s.root, `.cc-badge[data-thread="${id}"]`)!
    expect(badge.getAttribute('data-docked')).toBe('true')
    // The off-screen skip is about elements scrolling away. A dock has no element, so nothing can
    // ever report it back on screen — and a `hidden` badge is the only mark an orphaned thread
    // has on the page.
    expect(badge.hasAttribute('hidden')).toBe(false)
    // …and the sheet actually draws the state the attribute names.
    expect(glassStyles).toContain(".cc-badge[data-docked='true']::after { opacity: 1; scale: 1; }")
    expect(glassStyles).toContain('border: 1.5px dashed var(--_muted);')
  })

  test('the scroll mask is only drawn when there is something to scroll to', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.focus(id)
    await s.settle()
    const list = $(s.root, '.cc-comments')!
    // A popover that has not been laid out reports `clientHeight: 0`, and every list looks
    // overflowing at zero height — which is how the mask came to fade out the tail of the newest
    // comment with nothing scrollable underneath it.
    Object.defineProperty(list, 'scrollHeight', { value: 300, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 0, configurable: true })
    list.dispatchEvent(new (s.doc.defaultView as Window & typeof globalThis).Event('scroll'))
    expect(list.hasAttribute('data-scroll-bottom')).toBe(false)

    Object.defineProperty(list, 'clientHeight', { value: 120, configurable: true })
    list.dispatchEvent(new (s.doc.defaultView as Window & typeof globalThis).Event('scroll'))
    expect(list.getAttribute('data-scroll-bottom')).toBe('true')

    // …and it is asked again when the entrance ends. `cc-stagger` translates each comment 4 px on
    // the way in, and **a translated child counts toward its scroll container's overflow** — so a
    // list that fits exactly reports 4 px of scrollable height for the length of the animation,
    // turns the mask on, and then never resizes again to turn it off. Found in a browser, on a
    // two-comment thread whose last line was faded to grey with nothing to scroll to.
    Object.defineProperty(list, 'scrollHeight', { value: 120, configurable: true })
    list.dispatchEvent(new (s.doc.defaultView as Window & typeof globalThis).Event('animationend'))
    expect(list.hasAttribute('data-scroll-bottom')).toBe(false)
  })

  test('the pick hint has one fixed home for the session, and is never moved per candidate', async () => {
    const s = await boot()
    s.engine.startPlacement('comment')
    await s.settle()
    const hint = $(s.root, '.cc-pick-hint')!
    // §7 row 19 rations the hint and gives it a rise; it never said where it lives. Riding the
    // candidate covered the line above the target, and a keyboard-opened session with the pointer
    // at rest left it at 0,0 under the host's own chrome.
    expect(hint.getAttribute('style') ?? '').not.toContain('translate')
    expect(glassStyles).toContain('  left: 50%;\n  bottom: 24px;')
    expect(glassStyles).toContain(
      '@keyframes cc-rise { from { translate: -50% 4px; opacity: 0; } }',
    )
  })

  test('A2: rail mode is clipped to the rail, and the rail carries count + section glyph', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.panel.open()
    await tick()
    s.ui.focus(id)
    await s.settle()

    const panel = $(s.root, '.cc-panel')!
    expect(panel.getAttribute('data-rail')).toBe('true')
    const rail = $(panel, '.cc-rail')!
    expect($(rail, '.cc-rail-count')?.getAttribute('data-value')).toBe('1')
    expect($(rail, 'use')?.getAttribute('href')).toBe('#cc-i-comment')
    expect(rail.getAttribute('aria-hidden')).toBe('true')
    // The sheet is clipped so nothing renders outside the viewport — the old rule translated a
    // 300 px sheet 256 px to the right and left the remainder hanging off the edge.
    expect(glassStyles).toContain('clip-path: inset(0 calc(100% - 44px) 0 0 round var(--_r-xl));')
  })

  test('§2.3: a mode carries its own hue, by index in `engine.modes`', async () => {
    const s = await boot()
    const comment = await s.seed('#a')
    const ask = await s.seed('#b', 'x', { kind: 'ask' })
    // Index 0 and index 1 of the scene's mode list: 0 and +38. Never a hash of the string — that
    // would make two modes' colours depend on what a host called them. And **unitless**: `h` is a
    // `<number>` in relative colour syntax, so `calc(h + 38deg)` is invalid at computed-value
    // time and resolves the badge fill to `transparent` — every badge a hollow ring, in a
    // browser, with this suite green behind it.
    expect(
      $(s.root, `.cc-badge[data-thread="${comment}"]`)?.style.getPropertyValue('--_kind-h'),
    ).toBe('0')
    expect($(s.root, `.cc-badge[data-thread="${ask}"]`)?.style.getPropertyValue('--_kind-h')).toBe(
      '38',
    )

    s.ui.focus(ask)
    await s.settle()
    expect($(s.root, '.cc-thread')?.style.getPropertyValue('--_kind-h')).toBe('38')

    s.engine.startPlacement('ask')
    await s.settle()
    expect($(s.root, '.cc-ring')?.style.getPropertyValue('--_kind-h')).toBe('38')
    expect($(s.root, '.cc-cursor')?.style.getPropertyValue('--_kind-h')).toBe('38')

    // …and the five places §2.3 says spend it, spend it. `--_kind` is declared on the surfaces
    // that carry `--_kind-h` and never on `:host`, where a `var()` would resolve once, at index 0.
    expect(glassStyles).toContain(
      '.cc-badge, .cc-thread, .cc-composer, .cc-pearl, .cc-ring, .cc-cursor {\n  --_kind: oklch(from var(--_accent) l c calc(h + var(--_kind-h, 0)));\n}',
    )
    expect(glassStyles).toContain('background: var(--_kind);')
    expect(glassStyles).toContain('.cc-head-icon { color: var(--_kind); }')
    expect(glassStyles).toContain(
      'box-shadow: 0 0 0 1.5px var(--_kind), inset 0 0 0 1px oklch(100% 0 0/.6);',
    )
  })

  test('a kind that is no longer a mode falls back to the accent rather than a random hue', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'x', { kind: 'gone' })
    expect($(s.root, `.cc-badge[data-thread="${id}"]`)?.style.getPropertyValue('--_kind-h')).toBe(
      '0',
    )
  })

  test('a reply is one sheet growing downward: it docks to the popover and matches its width', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.focus(id)
    await s.settle()
    // The same path `intents.startReply` takes — a reply is the composer, the draft state machine
    // and the `placement:*` events a fresh thread uses (decision log #21).
    s.engine.placement.start('comment', { threadId: id })
    await s.settle()
    const composer = $(s.root, '.cc-composer')!
    expect(composer.getAttribute('data-reply')).toBe(id)
    // One width for both, so "matches its width" is a fact rather than two numbers that agree.
    expect(glassStyles).toContain('  width: var(--_w-thread);\n  border-top-left-radius: 0;')
    // …and the seam follows the positioner when the popover is low enough to flip the reply above
    // it — `data-placement` is the controller's, so the sheet only has to know which edge it is.
    expect(glassStyles).toContain(".cc-composer[data-reply][data-placement^='top']")
    expect(glassStyles).toContain(
      '.cc-thread {\n  flex-direction: column;\n  gap: 8px;\n  width: var(--_w-thread);',
    )
  })
})

/* -------------------------------------------------------------------------- §5, the glyphs */

describe('§5 — 19 hand-drawn glyphs, one sprite, no font', () => {
  test('the sprite is injected once into the shadow root with the whole inventory', async () => {
    const s = await boot()
    const sprites = $$(s.root as unknown as ParentNode, '.cc-sprite')
    expect(sprites).toHaveLength(1)
    const symbols = [...sprites[0].querySelectorAll('symbol')]
    expect(symbols).toHaveLength(19)
    expect(ICON_IDS).toHaveLength(19)
    expect(symbols.map((node) => node.id).sort()).toEqual([...ICON_IDS].sort())
    for (const symbol of symbols) expect(symbol.getAttribute('viewBox')).toBe('0 0 16 16')
  })

  test('one stroke spec for the whole set, and every path is non-scaling', async () => {
    const s = await boot()
    const sprite = $$(s.root as unknown as ParentNode, '.cc-sprite')[0]
    // Set on the sprite root, not per path: `<use>` clones inherit it, and `currentColor` then
    // resolves at the *referencing* site — one definition draws an accent badge and a muted row.
    expect(sprite.getAttribute('stroke')).toBe('currentColor')
    expect(sprite.getAttribute('stroke-width')).toBe('1.5')
    expect(sprite.getAttribute('stroke-linecap')).toBe('round')
    expect(sprite.getAttribute('fill')).toBe('none')
    expect(sprite.getAttribute('aria-hidden')).toBe('true')
    const paths = [...sprite.querySelectorAll('path')]
    expect(paths.length).toBeGreaterThan(19)
    for (const path of paths) {
      expect(path.getAttribute('vector-effect')).toBe('non-scaling-stroke')
    }
  })

  test('every drawn instance carries the stroke spec itself, not by class', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.focus(id)
    s.ui.panel.open()
    await s.settle()
    const drawn = [...s.root.querySelectorAll('svg')].filter(
      (node) => !node.classList.contains('cc-sprite'),
    )
    expect(drawn.length).toBeGreaterThan(6)
    for (const node of drawn) {
      // An `<svg>` with no `fill` renders BLACK. Leaving the spec to a class list means one
      // forgotten class draws a filled blob at one size in one place — which is what the author
      // glyph did until a browser showed it. The attributes make that impossible.
      expect({ cls: node.getAttribute('class'), fill: node.getAttribute('fill') }).toEqual({
        cls: node.getAttribute('class'),
        fill: 'none',
      })
      expect(node.getAttribute('stroke')).toBe('currentColor')
      expect(node.getAttribute('stroke-width')).toBe('1.5')
    }
  })

  test('every `use` in the layer names a symbol that exists', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'x', { kind: 'ask' })
    s.ui.focus(id)
    s.ui.panel.open()
    s.ui.decorate(id, { chip: { text: 'run failed', tone: 'warn' } })
    await s.settle()
    const uses = [...s.root.querySelectorAll('use')]
    expect(uses.length).toBeGreaterThan(8)
    for (const use of uses) {
      const href = use.getAttribute('href') ?? ''
      expect({ href, known: ICON_IDS.includes(href.slice(1)) }).toEqual({ href, known: true })
    }
  })

  test('every emoji dies: the layer draws no pictographic character', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.ui.focus(id)
    s.ui.panel.open()
    await s.settle()
    // A different font, a different baseline and a different colour on every operating system —
    // which is exactly what a 12 px status marker cannot afford.
    expect(s.root.textContent ?? '').not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}✓✕⚑]/u)
  })

  test('reopen and reply differ by SILHOUETTE, not by a few px of tail', async () => {
    const reply = ICONS['cc-i-reply']
    const reopen = ICONS['cc-i-uturn']
    // Both were left-curving arrows, adjacent in the same 14 px action row, and §1.3 requires the
    // shape to carry the state — "answer it" and "put it back" are not the same gesture and must
    // not be the same drawing. The ring is the difference a screenshot can see.
    expect(reopen.some((path) => /A5\.25 5\.25 0 1 1/.test(path))).toBe(true)
    expect(reply.some((path) => /A5\.25/.test(path))).toBe(false)
    expect(reopen[0]).not.toBe(reply[0])
  })

  test('every glyph in the sprite is the path DESIGN §5 documents, character for character', async () => {
    const { readFileSync } = await import('node:fs')
    const { dirname, resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const design = readFileSync(resolve(here, '../../../docs/DESIGN.md'), 'utf8')

    // §5's table IS the spec — "implementers must not make design decisions; if something appears
    // underspecified, it is a design bug: fix this document, then the code". A glyph redrawn in
    // the code and not in the table is exactly that drift, and it is invisible in every other test.
    const documented = new Map<string, string[]>()
    for (const [, id, cell] of design.matchAll(/^\| `(cc-i-[a-z-]+)` \| [^|]+ \| (.+?) \|$/gm)) {
      const paths = cell.split(' + ').flatMap((token) => {
        const value = token.trim().replace(/^`|`$/g, '')
        return value.startsWith('cc-i-') ? (documented.get(value) ?? []) : [value]
      })
      documented.set(id, paths)
    }
    expect(documented.size).toBe(19)
    for (const [id, paths] of documented) {
      expect({ id, paths }).toEqual({ id, paths: [...(ICONS[id] ?? [])] })
    }
  })

  test('`icons: none` hands the sprite over to a host that already ships one', async () => {
    const s = await boot({ icons: 'none' })
    expect($$(s.root as unknown as ParentNode, '.cc-sprite')).toHaveLength(0)
    // …and the references are unchanged, so the host's own `cc-i-*` symbols simply resolve.
    await s.seed('#a')
    expect($(s.root, '.cc-badge-icon use')?.getAttribute('href')).toBe('#cc-i-comment')
  })
})

/* ------------------------------------------------------------------ §6.7, reduced motion */

describe('§6.7 — an exact reduced-motion mapping, not "turn it off"', () => {
  test('the explicit override is a layer attribute, so it needs no second sheet', async () => {
    const s = await boot({ reduceMotion: true })
    expect($(s.root, '.cc-layer')?.getAttribute('data-motion')).toBe('reduce')
    const plain = await boot()
    expect($(plain.root, '.cc-layer')?.hasAttribute('data-motion')).toBe(false)
  })

  test('a count that would roll simply changes, and a re-anchor still blinks', async () => {
    const s = await boot({ reduceMotion: true })
    const id = await s.seed('#a')
    await s.engine.appendComment(id, { author: 'user', body: 'second' })
    await s.settle()
    const count = $(s.root, `.cc-badge[data-thread="${id}"] .cc-badge-count`)!
    // No two-span roll: one text node, changed in place.
    expect(count.textContent).toBe('2')
    expect($$(count, 'span')).toHaveLength(0)
  })

  test('durations collapse to 1 ms and never to 0, so exits still fire', () => {
    expect(glassStyles).toContain('@media (prefers-reduced-motion: reduce)')
    expect(glassStyles).toMatch(/--_d1: 1ms; --_d2: 100ms; --_d3: 100ms; --_d4: 100ms;/)
    expect(glassStyles).not.toMatch(/--_d[1-4]: 0ms/)
    // Transform keyframes are DROPPED rather than shortened; opacity is kept at 100 ms.
    expect(glassStyles).toContain('.cc-comment { animation: none; }')
    expect(glassStyles).toContain('@keyframes cc-fade { from { opacity: 0; } }')
    // …and the ambient ring becomes a static one rather than vanishing: the state still reads.
    expect(glassStyles).toContain(
      ".cc-chip[data-rung='2'] .cc-chip-mark { animation: none; opacity: .5; }",
    )
  })
})

/* ------------------------------------------------- §2.5, the page's polarity beats the OS's */

describe('§2.5 — the widget follows the page, not the desktop', () => {
  function watcher(background: string, forced: 'auto' | 'light' | 'dark' = 'auto'): string | null {
    const layer = document.createElement('div')
    layer.className = 'cc-layer'
    document.body.append(layer)
    const previous = document.body.style.backgroundColor
    document.body.style.backgroundColor = background
    try {
      createPolarityWatcher(document, window, layer, forced)
      return layer.getAttribute('data-polarity')
    } finally {
      document.body.style.backgroundColor = previous
      layer.remove()
    }
  }

  test('a dark page turns the widget dark whatever the desktop says', () => {
    expect(watcher('rgb(8, 10, 14)')).toBe('dark')
    expect(watcher('#111827')).toBe('dark')
  })

  test('every colour space a computed value can arrive in is read, not just rgb()', () => {
    // A computed `background-color` is serialised in the space the author wrote it in, so a page
    // styled in `oklch()` — increasingly most of them — hands back `oklch(…)`. Reading only
    // `rgb()` answered "unknown" on exactly the pages most likely to be dark by design, and the
    // whole of §2.5 quietly stopped working. Found in a browser, not in this suite.
    expect(lightnessOf('oklch(0.245 0.012 264)')).toBeLessThan(0.45)
    expect(lightnessOf('oklch(99.2% 0.002 264)')).toBeGreaterThan(0.9)
    expect(lightnessOf('oklab(0.28 0.02 -0.04)')).toBeLessThan(0.45)
    expect(lightnessOf('lab(18 3 -9)')).toBeLessThan(0.45)
    expect(lightnessOf('hsl(220 14% 12%)')).toBeLessThan(0.45)
    expect(lightnessOf('color(srgb 0.05 0.06 0.08)')).toBeLessThan(0.45)
    expect(lightnessOf('color(srgb 1 1 1)')).toBeGreaterThan(0.9)
    expect(lightnessOf('#fff')).toBeGreaterThan(0.9)
    // Alpha, in every form it can take, still means "this says nothing about the page".
    expect(lightnessOf('oklch(0.2 0 0 / 0.1)')).toBeNull()
    expect(lightnessOf('rgba(0, 0, 0, 0.2)')).toBeNull()
    expect(lightnessOf('#11182700')).toBeNull()
    expect(lightnessOf('')).toBeNull()
    expect(lightnessOf('var(--nope)')).toBeNull()
  })

  test('a light page turns it light', () => {
    expect(watcher('rgb(255, 255, 255)')).toBe('light')
    expect(watcher('#f6f7f9')).toBe('light')
  })

  test('a transparent body says nothing, so neither do we — `prefers-color-scheme` decides', () => {
    expect(watcher('rgba(0, 0, 0, 0)')).toBeNull()
    expect(watcher('transparent')).toBeNull()
  })

  test('an explicit polarity wins over both, and is not part of the theming surface', () => {
    expect(watcher('rgb(255,255,255)', 'dark')).toBe('dark')
    expect(watcher('rgb(0,0,0)', 'light')).toBe('light')
  })

  test('the sheet redeclares the dark ramp for the page as well as for the desktop', () => {
    expect(glassStyles).toContain('@media (prefers-color-scheme: dark)')
    expect(glassStyles).toContain(".cc-layer[data-polarity='dark']")
    // …and a light override, or a dark desktop would keep a light page dark.
    expect(glassStyles).toContain(".cc-layer[data-polarity='light']")
  })
})

/* ------------------------------------------------------------- §12 / decision log #39, #3 */

describe('the budget the design actually rests on', () => {
  test('zero new public tokens: the theming surface is the same eleven names', () => {
    const names = new Set([...glassStyles.matchAll(/--cc-[a-z0-9-]+/g)].map((match) => match[0]))
    expect([...names].sort()).toEqual([
      '--cc-accent',
      '--cc-badge-size',
      '--cc-border',
      '--cc-danger',
      '--cc-font',
      '--cc-muted',
      '--cc-radius',
      // The two the controller writes on `:host` at mount, read here and never declared.
      '--cc-root-font-size',
      '--cc-shadow',
      '--cc-surface',
      '--cc-surface-2',
      '--cc-text',
      '--cc-z',
    ])
  })

  test('no rendering surface reaches for a shader, a canvas or a 3D library', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { dirname, join, resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      )
    // Decision log #40. The one effect a GPU genuinely buys on a host page is edge refraction,
    // and 148 KB gz against a 40 KB gz ceiling for everything injected into a third party's page
    // is a 3.7x miss for ambience. The in-product "alive" moment is a 6-line ambient ring.
    for (const file of walk(resolve(here, '../src/presentations/glass'))) {
      const source = readFileSync(file, 'utf8')
      // `background: Canvas` in the forced-colours block is a system colour keyword, not a
      // drawing surface, so the grep names the APIs rather than the word.
      const forbidden = /getContext|createElement\('canvas'\)|shaderSource|GLSL/i
      expect({ file, hit: forbidden.test(source) }).toEqual({ file, hit: false })
    }
  })

  test('the glass sources import nothing but the seam and the shared DOM helpers', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { dirname, join, resolve } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const here = dirname(fileURLToPath(import.meta.url))
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
      )
    for (const file of walk(resolve(here, '../src/presentations/glass'))) {
      for (const [, specifier] of readFileSync(file, 'utf8').matchAll(
        /^\s*import[^\n]*?from\s*'([^']+)'/gm,
      )) {
        // Relative only, and out of the presentations tree only as far as the two modules that
        // themselves import nothing: the types seam and `dom.ts`.
        expect({ file, specifier, ok: /^\.{1,2}\//.test(specifier) }).toEqual({
          file,
          specifier,
          ok: true,
        })
        expect({ file, specifier, escapes: specifier.startsWith('../../') }).toEqual({
          file,
          specifier,
          escapes: /^\.\.\/\.\.\/(presentation|dom)\.ts$/.test(specifier),
        })
      }
    }
  })
})
