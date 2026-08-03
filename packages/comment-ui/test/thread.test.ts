/**
 * §3 thread popover: comments, reply (through the same composer), resolve/reopen, delete,
 * edit — all of it written through `CommentEngine` methods, none of it through the store.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'

import { $, $$, badgeOf, click, press, scene, tick, type } from './support.ts'

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
  return { ...s, popover: (): HTMLElement => $(s.root, '.cc-thread')! }
}

describe('opening', () => {
  test('a badge click opens the popover and flips aria-expanded', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    expect(s.popover().getAttribute('data-open')).toBe('false')
    expect(badgeOf(s.root, id)?.getAttribute('aria-expanded')).toBe('false')

    click(badgeOf(s.root, id))
    await tick()
    expect(s.popover().getAttribute('data-open')).toBe('true')
    expect(s.popover().getAttribute('data-thread')).toBe(id)
    expect(badgeOf(s.root, id)?.getAttribute('aria-expanded')).toBe('true')
    expect(s.engine.active.get()).toBe(id)
  })

  test('a second click on the same badge closes it', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    click(badgeOf(s.root, id))
    await tick()
    click(badgeOf(s.root, id))
    await tick()
    expect(s.popover().getAttribute('data-open')).toBe('false')
    expect(badgeOf(s.root, id)?.getAttribute('aria-expanded')).toBe('false')
  })

  test('re-opening the same thread works (engine.active would not re-notify)', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    click(badgeOf(s.root, id))
    await tick()
    click($(s.root, '.cc-thread [data-action="close"]'))
    await tick()
    expect(s.popover().getAttribute('data-open')).toBe('false')

    s.ui.focus(id)
    await tick()
    expect(s.popover().getAttribute('data-open')).toBe('true')
  })

  test('ui.focus delegates to engine.focus and still opens an unanchored thread', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    const focus = vi.spyOn(s.engine, 'focus')
    await s.page.mutate((doc) => {
      doc.querySelector('#a')?.remove()
    })
    await s.settle()
    expect(s.engine.getThreadView(id)?.isOrphaned).toBe(true)

    s.ui.focus(id)
    await tick()
    expect(focus).toHaveBeenCalledWith(id)
    expect(s.popover().getAttribute('data-open')).toBe('true')
    expect(s.popover().getAttribute('data-anchor')).toBe('orphaned')
    // PLAN §3.4's "original content deleted" pattern: the capture stays readable.
    expect($(s.root, '.cc-quote')?.hasAttribute('hidden')).toBe(false)
    expect($(s.root, '.cc-quote')?.textContent).toContain('alpha text')
  })
})

describe('contents', () => {
  test('renders one row per comment, author-tagged, with a machine timestamp', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'from a human')
    await s.engine.appendComment(id, { author: 'copilot', body: 'from a machine' })
    await s.settle()
    click(badgeOf(s.root, id))
    await tick()

    const rows = $$(s.root, '.cc-comment')
    expect(rows).toHaveLength(2)
    expect($$(s.root, '.cc-author').map((n) => n.getAttribute('data-author'))).toEqual([
      'user',
      'copilot',
    ])
    expect($$(s.root, '.cc-body').map((n) => n.textContent)).toEqual([
      'from a human',
      'from a machine',
    ])
    const stamp = $(s.root, '.cc-time')?.getAttribute('datetime')
    expect(stamp).toBe(s.engine.getThreadView(id)?.comments[0]?.createdAt)
  })

  test('a new reply appends without rebuilding the existing rows', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    click(badgeOf(s.root, id))
    await tick()
    const first = $(s.root, '.cc-comment')

    await s.engine.appendComment(id, { author: 'copilot', body: 'second' })
    await s.settle()
    expect($$(s.root, '.cc-comment')).toHaveLength(2)
    expect($(s.root, '.cc-comment')).toBe(first)
  })
})

describe('actions call the engine', () => {
  test('Reply opens the composer for that thread', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    click(badgeOf(s.root, id))
    await tick()
    click($(s.root, '[data-action="reply"]'))
    await tick()
    expect(s.engine.placement.get()).toMatchObject({ phase: 'composing', replyTo: id })
    expect($(s.root, '.cc-composer')?.getAttribute('data-open')).toBe('true')
  })

  test('Resolve → Reopen round-trips and relabels the button', async () => {
    const s = await boot({ ui: { badge: { showResolved: true } } })
    const id = await s.seed('#a')
    click(badgeOf(s.root, id))
    await tick()

    const button = (): HTMLElement => $(s.root, '[data-role="status"]')!
    expect($(s.root, '[data-action="resolve"]')?.textContent).toBe('Resolve')
    click($(s.root, '[data-action="resolve"]'))
    await s.settle()
    expect(s.engine.getThreadView(id)?.isResolved).toBe(true)
    expect($(s.root, '[data-action="reopen"]')?.textContent).toBe('Reopen')

    click($(s.root, '[data-action="reopen"]'))
    await s.settle()
    expect(s.engine.getThreadView(id)?.isResolved).toBe(false)
    expect(button().getAttribute('data-action')).toBe('resolve')
  })

  test('Delete removes the thread and closes the popover', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    click(badgeOf(s.root, id))
    await tick()
    click($(s.root, '.cc-thread [data-action="delete"]'))
    await s.settle()
    expect(s.engine.listThreads()).toHaveLength(0)
    expect(s.popover().getAttribute('data-open')).toBe('false')
  })

  test('Delete leaves focus inside the widget, not on the badge it just destroyed', async () => {
    // The normal close returns focus to the invoking badge (§3). Delete is the one action that
    // removes that badge, so returning focus to it drops the keyboard user onto <body> a tick
    // later — the only path out of the widget in the whole popover.
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    click(badgeOf(s.root, id))
    await tick()
    click($(s.root, '.cc-thread [data-action="delete"]'))
    await s.settle()

    expect(badgeOf(s.root, id)).toBeNull()
    expect(s.root.activeElement).toBe($(s.root, '.cc-panel-toggle'))
    // Retargeted through the shadow boundary: the page sees the host, never <body>.
    expect(s.doc.activeElement).toBe(s.root.host)
  })

  test('editing a comment writes through engine.editComment', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'typo heer')
    click(badgeOf(s.root, id))
    await tick()

    click($(s.root, '.cc-comment [data-action="edit"]'))
    await tick()
    const input = $(s.root, '.cc-edit textarea') as HTMLTextAreaElement
    expect(input.value).toBe('typo heer')
    type(input, 'typo here')
    click($(s.root, '[data-action="save"]'))
    await s.settle()

    const comment = s.engine.getThreadView(id)?.comments[0]
    expect(comment?.body).toBe('typo here')
    expect(comment?.editedAt).not.toBeNull()
    expect($(s.root, '.cc-edit')).toBeNull()
    expect($(s.root, '.cc-body')?.textContent).toBe('typo here')
  })

  test('cancelling an edit restores the original body', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'keep me')
    click(badgeOf(s.root, id))
    await tick()
    click($(s.root, '.cc-comment [data-action="edit"]'))
    await tick()
    type($(s.root, '.cc-edit textarea') as HTMLTextAreaElement, 'discarded')
    click($(s.root, '[data-action="cancel-edit"]'))
    await tick()
    expect(s.engine.getThreadView(id)?.comments[0]?.body).toBe('keep me')
    expect($(s.root, '.cc-body')?.textContent).toBe('keep me')
  })

  test('an engine rejection is routed to onError, never floated', async () => {
    const onError = vi.fn()
    const s = await boot({ ui: { onError } })
    const id = await s.seed('#a')
    click(badgeOf(s.root, id))
    await tick()
    vi.spyOn(s.store, 'putThread').mockRejectedValueOnce(new Error('nope'))
    click($(s.root, '[data-action="resolve"]'))
    await s.settle()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe('closing', () => {
  test('Escape inside the popover closes it and restores focus to the badge', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    click(badgeOf(s.root, id))
    await tick()
    press($(s.root, '.cc-thread [data-action="close"]'), 'Escape')
    await tick()
    expect(s.popover().getAttribute('data-open')).toBe('false')
    expect(s.root.activeElement).toBe(badgeOf(s.root, id))
  })

  test('deleting a DIFFERENT thread does not close an orphan popover', async () => {
    // `engine.active` never learned about the orphan (engine.focus returns false for it), so a
    // clear meant for the other thread must not be mirrored onto this one.
    const s = await boot()
    const anchored = await s.seed('#b')
    const orphan = await s.seed('#a')
    s.ui.focus(anchored)
    await tick()
    await s.page.mutate((doc) => {
      doc.querySelector('#a')?.remove()
    })
    await s.settle()

    s.ui.focus(orphan)
    await tick()
    expect(s.popover().getAttribute('data-thread')).toBe(orphan)

    await s.engine.delete(anchored)
    await s.settle()
    expect(s.popover().getAttribute('data-open')).toBe('true')
    expect(s.popover().getAttribute('data-thread')).toBe(orphan)
  })

  test('deleting the open thread from elsewhere closes the popover', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    click(badgeOf(s.root, id))
    await tick()
    await s.engine.delete(id)
    await s.settle()
    expect(s.popover().getAttribute('data-open')).toBe('false')
  })
})
