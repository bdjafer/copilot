/**
 * §3 composer, asserted on `vm.composer` and driven through `intents`: a projection of
 * `engine.placement` (decision log #21 — the composer owns no state of its own), the draft, the
 * submit path, the busy state and the reply anchoring choice.
 *
 * Focus and the key bindings are the *presentation's* half of the contract and live in the
 * conformance suite; what is here is everything a presentation cannot change.
 */

import { afterEach, describe, expect, test, vi } from 'vitest'

import { $, press, scene, tick } from '../support.ts'

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

describe('open / close is a projection of engine.placement', () => {
  test('idle publishes no composer', async () => {
    const s = await boot()
    expect(s.vm().composer).toBeNull()
  })

  test('composing publishes the kind, the draft and the placeholder', async () => {
    const s = await boot()
    s.engine.placement.start('ask', { element: s.doc.querySelector('#a')! })
    await tick()
    expect(s.vm().composer).toEqual({
      kind: 'ask',
      draft: '',
      busy: false,
      replyTo: null,
      canSubmit: false,
      placeholder: 'Add a comment…',
    })
  })

  test('opening asks the presentation to focus the composer input', async () => {
    const s = await boot()
    const before = s.vm().focus?.seq ?? 0
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    expect(s.vm().focus?.target).toEqual({ kind: 'composer-input' })
    expect(s.vm().focus?.seq).toBeGreaterThan(before)
  })

  test('a reply composer names the thread it replies to', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.engine.placement.start('comment', { threadId: id })
    await tick()
    expect(s.vm().composer?.replyTo).toBe(id)
  })

  test('closing a reply composer asks for focus back on the invoking badge', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.engine.placement.start('comment', { threadId: id })
    await tick()
    s.engine.placement.cancel('test')
    await tick()
    expect(s.vm().focus?.target).toEqual({ kind: 'badge', threadId: id })
    expect(s.vm().composer).toBeNull()
  })
})

describe('wiring to engine calls', () => {
  test('setDraft writes through placement — the controller keeps no draft of its own', async () => {
    const s = await boot()
    const setDraft = vi.spyOn(s.engine.placement, 'setDraft')
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()

    s.intents.setDraft('hello there')
    expect(setDraft).toHaveBeenCalledWith('hello there')
    await tick()
    expect(s.vm().composer).toMatchObject({ draft: 'hello there', canSubmit: true })
  })

  test('submitDraft persists exactly one thread and closes the composer', async () => {
    const s = await boot()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    s.intents.setDraft('a real comment')
    s.intents.submitDraft()
    await s.settle()

    const threads = s.engine.listThreads()
    expect(threads).toHaveLength(1)
    expect(threads[0]?.lastComment.body).toBe('a real comment')
    expect(s.vm().composer).toBeNull()
  })

  test('canSubmit is false on a blank draft, and submitting it writes nothing', async () => {
    const s = await boot()
    const submit = vi.spyOn(s.engine.placement, 'submit')
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    expect(s.vm().composer?.canSubmit).toBe(false)

    s.intents.submitDraft()
    await tick()
    expect(submit).not.toHaveBeenCalled()

    s.intents.setDraft('  ')
    await tick()
    expect(s.vm().composer?.canSubmit).toBe(false)
    s.intents.setDraft(' x ')
    await tick()
    expect(s.vm().composer?.canSubmit).toBe(true)
  })

  test('cancelComposer cancels placement', async () => {
    const s = await boot()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    s.intents.cancelComposer()
    await tick()
    expect(s.engine.placement.get().phase).toBe('idle')
  })

  test('a reply lands on the thread, not as a new one', async () => {
    const s = await boot()
    const id = await s.seed('#a')
    s.intents.startReply(id)
    await tick()
    s.intents.setDraft('the reply')
    s.intents.submitDraft()
    await s.settle()

    expect(s.engine.listThreads()).toHaveLength(1)
    expect(s.engine.getThreadView(id)?.comments.map((comment) => comment.body)).toEqual([
      'first comment',
      'the reply',
    ])
  })

  test('submitting publishes busy and keeps the composer open', async () => {
    const s = await boot()
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    s.intents.setDraft('slow write')

    // A real write is slow; a memory store is not, so the `submitting` window is held open
    // explicitly rather than raced against the scheduler.
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = s.store.putThread.bind(s.store)
    vi.spyOn(s.store, 'putThread').mockImplementation(async (record) => {
      await gate
      return write(record)
    })

    const pending = s.engine.placement.submit()
    await tick()
    expect(s.vm().composer).toMatchObject({ busy: true, canSubmit: false })
    release()
    await pending
    await s.settle()
    expect(s.vm().composer).toBeNull()
  })

  test('a submit failure surfaces through onError and keeps the draft', async () => {
    const onError = vi.fn()
    const s = await boot({ ui: { onError } })
    s.engine.placement.start('comment', { element: s.doc.querySelector('#a')! })
    await tick()
    s.intents.setDraft('doomed')
    vi.spyOn(s.store, 'putComment').mockRejectedValueOnce(new Error('disk on fire'))

    s.intents.submitDraft()
    await s.settle()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(s.vm().composer).toMatchObject({ draft: 'doomed', busy: false })
  })

  test('an intent fired against stale state is a documented no-op, never a throw', async () => {
    const s = await boot()
    expect(() => {
      s.intents.setDraft('nothing is composing')
      s.intents.submitDraft()
      s.intents.cancelComposer()
      s.intents.startReply('nope')
      s.intents.resolveThread('nope')
      s.intents.reopenThread('nope')
      s.intents.deleteThread('nope')
      s.intents.beginEdit('nope', 'nope')
      s.intents.commitEdit('nope', 'nope', 'x')
      s.intents.openThread('nope')
      s.intents.closeThread()
    }).not.toThrow()
    await s.settle()
    expect(s.engine.listThreads()).toHaveLength(0)
  })
})

describe('the shadow boundary', () => {
  test('isolateEvents stops keyboard events at the shadow host', async () => {
    const s = await boot()
    const seen: string[] = []
    const listener = (): void => {
      seen.push('page')
    }
    s.doc.addEventListener('keydown', listener)
    press($(s.root, '.cc-layer'), 'x')
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
    press($(s.root, '.cc-layer'), 'x')
    expect(seen).toEqual(['page'])
    s.doc.removeEventListener('keydown', listener)
  })
})
