/**
 * §3 composer: a `[popover]` box driven entirely by `engine.placement` (decision log #21 — the
 * composer owns no state of its own), focus moved to the textarea on open and returned on
 * close, `Esc` cancelling placement, and a focus trap while it is open.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'

import { $, badgeOf, click, press, scene, tick, type } from './support.ts'

const PAGE =
  '<article id="a" data-testid="a">alpha text</article><div id="b" data-testid="b">beta</div>'

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
  const composer = (): HTMLElement => $(s.root, '.cc-composer')!
  const input = (): HTMLTextAreaElement => $(s.root, '.cc-composer-input') as HTMLTextAreaElement
  const send = (): HTMLButtonElement => $(s.root, '[data-action="send"]') as HTMLButtonElement
  const dismiss = (): HTMLButtonElement =>
    $(s.root, '.cc-composer [data-action="dismiss"]') as HTMLButtonElement
  return { ...s, composer, input, send, dismiss }
}

describe('open / close is a projection of engine.placement', () => {
  test('idle renders a closed popover element', async () => {
    const s = await boot()
    expect(s.composer().getAttribute('popover')).toBe('manual')
    expect(s.composer().getAttribute('role')).toBe('dialog')
    expect(s.composer().getAttribute('data-open')).toBe('false')
  })

  test('composing opens it, focuses the textarea and carries the kind', async () => {
    const s = await boot()
    s.engine.placement.start('ask', { element: s.doc.querySelector('#a')! })
    await tick()
    expect(s.composer().getAttribute('data-open')).toBe('true')
    expect(s.composer().getAttribute('data-kind')).toBe('ask')
    expect(s.root.activeElement).toBe(s.input())
  })

  test('cancel closes it and returns focus to where it was', async () => {
    const s = await boot()
    const other = await s.seed('#b')
    const badge = badgeOf(s.root, other)!
    badge.focus()

    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    expect(s.root.activeElement).toBe(s.input())

    s.engine.placement.cancel('test')
    await tick()
    expect(s.composer().getAttribute('data-open')).toBe('false')
    expect(s.root.activeElement).toBe(badge)
  })

  test('a reply composer returns focus to the invoking badge', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.engine.placement.start('comment', { threadId: id })
    await tick()
    expect(s.composer().getAttribute('data-reply')).toBe(id)

    s.engine.placement.cancel('test')
    await tick()
    expect(s.root.activeElement).toBe(badgeOf(s.root, id))
  })
})

describe('wiring to engine calls', () => {
  test('typing writes through placement.setDraft — the UI keeps no draft of its own', async () => {
    const s = await boot()
    const setDraft = vi.spyOn(s.engine.placement, 'setDraft')
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()

    type(s.input(), 'hello there')
    expect(setDraft).toHaveBeenCalledWith('hello there')
    expect(s.engine.placement.get()).toMatchObject({ phase: 'composing', draft: 'hello there' })
  })

  test('Send submits through the controller and persists exactly one thread', async () => {
    const s = await boot()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    type(s.input(), 'a real comment')
    click(s.send())
    await s.settle()

    const threads = s.engine.listThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0]?.lastComment.body).toBe('a real comment')
    expect(s.composer().getAttribute('data-open')).toBe('false')
  })

  test('Send is disabled while the draft is blank, and nothing is persisted', async () => {
    const s = await boot()
    const submit = vi.spyOn(s.engine.placement, 'submit')
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    expect(s.send().disabled).toBe(true)

    click(s.send())
    await tick()
    expect(submit).not.toHaveBeenCalled()

    type(s.input(), '  ')
    expect(s.send().disabled).toBe(true)
    type(s.input(), ' x ')
    expect(s.send().disabled).toBe(false)
  })

  test('Dismiss cancels placement', async () => {
    const s = await boot()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    click(s.dismiss())
    await tick()
    expect(s.engine.placement.get().phase).toBe('idle')
  })

  test('a reply lands on the thread, not as a new one', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.engine.placement.start('comment', { threadId: id })
    await tick()
    type(s.input(), 'the reply')
    click(s.send())
    await s.settle()

    expect(s.engine.listThreads()).toHaveLength(1)
    expect(s.engine.getThreadView(id)?.comments.map((c) => c.body)).toEqual([
      'first comment',
      'the reply',
    ])
  })

  test('submitting disables the controls and keeps the box open', async () => {
    const s = await boot()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    type(s.input(), 'slow write')

    const pending = s.engine.placement.submit()
    await tick(1)
    expect(s.composer().getAttribute('data-busy')).toBe('true')
    expect(s.input().disabled).toBe(true)
    expect(s.send().disabled).toBe(true)
    await pending
    await s.settle()
    expect(s.composer().getAttribute('data-open')).toBe('false')
  })

  test('a submit failure surfaces through onError and keeps the draft', async () => {
    const onError = vi.fn()
    const s = await boot({ ui: { onError } })
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    type(s.input(), 'doomed')
    vi.spyOn(s.store, 'putComment').mockRejectedValueOnce(new Error('disk on fire'))

    click(s.send())
    await s.settle()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(s.engine.placement.get()).toMatchObject({ phase: 'composing', draft: 'doomed' })
    expect(s.input().value).toBe('doomed')
  })
})

describe('keyboard', () => {
  test('Escape cancels placement from inside the composer', async () => {
    const s = await boot()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    press(s.input(), 'Escape')
    await tick()
    expect(s.engine.placement.get().phase).toBe('idle')
    expect(s.composer().getAttribute('data-open')).toBe('false')
  })

  test('Cmd/Ctrl+Enter submits', async () => {
    const s = await boot()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    type(s.input(), 'via keyboard')
    press(s.input(), 'Enter', { metaKey: true })
    await s.settle()
    expect(s.engine.listThreads()[0]?.lastComment.body).toBe('via keyboard')
  })

  test('Tab is trapped inside the dialog', async () => {
    const s = await boot()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    type(s.input(), 'x') // a disabled Send is not a focus stop

    s.send().focus()
    expect(s.root.activeElement).toBe(s.send())
    // Last stop + Tab wraps to the first.
    expect(press(s.send(), 'Tab')).toBe(false)
    expect(s.root.activeElement).toBe(s.input())
    // First stop + Shift+Tab wraps to the last.
    expect(press(s.input(), 'Tab', { shiftKey: true })).toBe(false)
    expect(s.root.activeElement).toBe(s.send())
  })

  test('isolateEvents stops keyboard events at the shadow host', async () => {
    const s = await boot()
    const seen: string[] = []
    const listener = (): void => {
      seen.push('page')
    }
    s.doc.addEventListener('keydown', listener)
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()

    press(s.input(), 'x')
    expect(seen).toEqual([])
    s.doc.removeEventListener('keydown', listener)
  })

  test('isolateEvents: false lets them through', async () => {
    const s = await boot({ ui: { isolateEvents: false } })
    const seen: string[] = []
    const listener = (): void => {
      seen.push('page')
    }
    s.doc.addEventListener('keydown', listener)
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()

    press(s.input(), 'x')
    expect(seen).toEqual(['page'])
    s.doc.removeEventListener('keydown', listener)
  })
})
