/**
 * §3 thread popover, asserted on `vm.thread` and driven through `intents`: comments, the inline
 * edit state machine, resolve/reopen/delete, and the focus policy around all of it.
 *
 * Every mutation goes through a `CommentEngine` method — none of it through the store — and no
 * intent ever throws or returns a promise, which is what makes a presentation writable with no
 * error plumbing at all.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'

import { badgeOf, scene, tick } from '../support.ts'

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
  return s
}

describe('opening', () => {
  test('openThread publishes the thread and marks its badge expanded', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    expect(s.vm().thread).toBeNull()
    expect(badgeOf(s.vm(), id)?.open).toBe(false)

    s.intents.openThread(id)
    await tick()
    expect(s.vm().thread).toMatchObject({
      threadId: id,
      kind: 'comment',
      label: 'comment',
      ariaLabel: 'comment (1)',
      status: 'open',
      anchor: 'anchored',
      actions: { reply: true, resolve: true, reopen: false, delete: true },
    })
    expect(badgeOf(s.vm(), id)?.open).toBe(true)
    expect(s.engine.active.get()).toBe(id)
  })

  test('opening asks for focus on the dialog close control, once', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.intents.openThread(id)
    await tick()
    const first = s.vm().focus
    expect(first?.target).toEqual({ kind: 'thread-close' })

    // A re-render for an unrelated reason must not re-steal focus (§3.1.6).
    await s.engine.appendComment(id, { author: 'user', body: 'noise' })
    await s.settle()
    expect(s.vm().focus?.seq).toBe(first?.seq)
  })

  test('closeThread asks for focus back on the badge', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.intents.openThread(id)
    await tick()
    s.intents.closeThread()
    await tick()
    expect(s.vm().thread).toBeNull()
    expect(s.vm().focus?.target).toEqual({ kind: 'badge', threadId: id })
  })

  test('re-opening the same thread works (engine.active would not re-notify)', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.intents.openThread(id)
    await tick()
    s.intents.closeThread()
    await tick()
    expect(s.vm().thread).toBeNull()

    s.ui.focus(id)
    await tick()
    expect(s.vm().thread?.threadId).toBe(id)
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
    // PLAN §3.4's "original content deleted" pattern: the capture stays readable, pre-truncated.
    expect(s.vm().thread).toMatchObject({ threadId: id, anchor: 'orphaned', orphaned: true })
    expect(s.vm().thread?.quote).toContain('alpha text')
  })
})

describe('contents', () => {
  test('publishes one entry per comment, author-tagged, oldest first', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'from a human')
    await s.engine.appendComment(id, { author: 'copilot', body: 'from a machine' })
    await s.settle()
    s.intents.openThread(id)
    await tick()

    expect(s.vm().thread?.comments.map((comment) => [comment.author, comment.body])).toEqual([
      ['user', 'from a human'],
      ['copilot', 'from a machine'],
    ])
    expect(s.vm().thread?.comments[0]?.createdAt).toBe(
      s.engine.getThreadView(id)?.comments[0]?.createdAt,
    )
  })

  test('an unchanged comment keeps its identity when a sibling arrives', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.intents.openThread(id)
    await tick()
    const first = s.vm().thread?.comments[0]

    await s.engine.appendComment(id, { author: 'copilot', body: 'second' })
    await s.settle()
    expect(s.vm().thread?.comments).toHaveLength(2)
    expect(s.vm().thread?.comments[0]).toBe(first)
  })

  test('a quote is published for orphans only', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.intents.openThread(id)
    await tick()
    expect(s.vm().thread?.quote).toBeNull()
  })
})

describe('actions call the engine', () => {
  test('startReply opens the composer for that thread', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.intents.openThread(id)
    await tick()
    s.intents.startReply(id)
    await tick()
    expect(s.engine.placement.get()).toMatchObject({ phase: 'composing', replyTo: id })
    expect(s.vm().composer?.replyTo).toBe(id)
  })

  test('resolve → reopen round-trips and flips the published action', async () => {
    const s = await boot({ ui: { badge: { showResolved: true } } })
    const id = await s.seed('#a')
    s.intents.openThread(id)
    await tick()
    expect(s.vm().thread?.actions).toMatchObject({ resolve: true, reopen: false })

    s.intents.resolveThread(id)
    await s.settle()
    expect(s.engine.getThreadView(id)?.isResolved).toBe(true)
    expect(s.vm().thread).toMatchObject({
      resolved: true,
      status: 'resolved',
      actions: { resolve: false, reopen: true },
    })

    s.intents.reopenThread(id)
    await s.settle()
    expect(s.engine.getThreadView(id)?.isResolved).toBe(false)
    expect(s.vm().thread?.actions).toMatchObject({ resolve: true, reopen: false })
  })

  test('deleteThread removes the thread, closes the popover and moves focus to the panel', async () => {
    // The normal close returns focus to the invoking badge (§3). Delete is the one action that
    // removes that badge, so returning focus to it would drop the keyboard user onto <body> a
    // tick later. The controller performs the dance; a presentation must not (§3.1.3).
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')
    s.intents.openThread(id)
    await tick()
    s.intents.deleteThread(id)
    await s.settle()

    expect(s.engine.listThreads()).toHaveLength(0)
    expect(s.vm().thread).toBeNull()
    expect(badgeOf(s.vm(), id)).toBeNull()
    expect(s.vm().focus?.target).toEqual({ kind: 'panel-toggle' })
  })

  test('the inline edit state machine: begin, commit, and the body changes', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'typo heer')
    s.intents.openThread(id)
    await tick()
    const commentId = s.vm().thread?.comments[0]?.id
    expect(commentId).toBeTruthy()
    expect(s.vm().thread?.comments[0]?.editing).toBe(false)

    s.intents.beginEdit(id, commentId!)
    await tick()
    expect(s.vm().thread?.comments[0]?.editing).toBe(true)

    s.intents.commitEdit(id, commentId!, 'typo here')
    await s.settle()
    const comment = s.engine.getThreadView(id)?.comments[0]
    expect(comment?.body).toBe('typo here')
    expect(comment?.editedAt).not.toBeNull()
    expect(s.vm().thread?.comments[0]).toMatchObject({ body: 'typo here', editing: false })
  })

  test('cancelling an edit leaves the original body untouched', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'keep me')
    s.intents.openThread(id)
    await tick()
    const commentId = s.vm().thread?.comments[0]?.id
    s.intents.beginEdit(id, commentId!)
    await tick()
    s.intents.cancelEdit()
    await tick()
    expect(s.engine.getThreadView(id)?.comments[0]?.body).toBe('keep me')
    expect(s.vm().thread?.comments[0]).toMatchObject({ body: 'keep me', editing: false })
  })

  test('committing a blank or unchanged body writes nothing', async () => {
    const s = await boot()
    const id = await s.seed('#a', 'keep me')
    s.intents.openThread(id)
    await tick()
    const commentId = s.vm().thread?.comments[0]?.id
    const edit = vi.spyOn(s.engine, 'editComment')
    s.intents.commitEdit(id, commentId!, '   ')
    s.intents.commitEdit(id, commentId!, 'keep me')
    await s.settle()
    expect(edit).not.toHaveBeenCalled()
  })

  test('an engine rejection is routed to onError, never floated', async () => {
    const onError = vi.fn()
    const s = await boot({ ui: { onError } })
    const id = await s.seed('#a')
    s.intents.openThread(id)
    await tick()
    vi.spyOn(s.store, 'putThread').mockRejectedValueOnce(new Error('nope'))
    s.intents.resolveThread(id)
    await s.settle()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe('closing', () => {
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
    expect(s.vm().thread?.threadId).toBe(orphan)

    await s.engine.delete(anchored)
    await s.settle()
    expect(s.vm().thread?.threadId).toBe(orphan)
  })

  test('deleting the open thread from elsewhere closes the popover', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.intents.openThread(id)
    await tick()
    await s.engine.delete(id)
    await s.settle()
    expect(s.vm().thread).toBeNull()
  })

  test('a pending thread publishes no popover, even when it is active', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.intents.openThread(id)
    await tick()
    expect(s.vm().thread).not.toBeNull()
    await s.page.navigate('https://example.com/elsewhere')
    await s.settle()
    expect(s.vm().thread).toBeNull()
  })
})

describe('the Escape chain', () => {
  test('cancels placement first, then the popover, then the panel', async () => {
    const s = await boot({ ui: { panel: { defaultOpen: true } } })
    const id = await s.seed('#a')

    s.ui.focus(id)
    s.engine.startPlacement('comment')
    await tick()
    expect(s.engine.placement.get().phase).toBe('picking')

    expect(s.intents.escape()).toBe(true)
    await tick()
    expect(s.engine.placement.get().phase).toBe('idle')
    expect(s.vm().thread?.threadId).toBe(id)

    expect(s.intents.escape()).toBe(true)
    await tick()
    expect(s.vm().thread).toBeNull()
    expect(s.ui.panel.isOpen).toBe(true)

    expect(s.intents.escape()).toBe(true)
    await tick()
    expect(s.ui.panel.isOpen).toBe(false)

    // Nothing left to consume: the keystroke belongs to the page again.
    expect(s.intents.escape()).toBe(false)
  })
})
