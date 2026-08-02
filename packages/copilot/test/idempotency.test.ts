// SPEC-copilot §3.2 — the idempotency table. One test per row.
import { describe, expect, test, vi } from 'vitest'

import type { Run, RunStore } from '../src/types.ts'

import { createCopilot } from '../src/index.ts'
import { createMemoryRunStore } from '../src/store/memory.ts'
import { scriptedModel } from '../src/testing/scripted-model.ts'

const record = (over: Partial<Run> & { id: string }): Run => ({
  state: 'queued',
  input: 'stored input',
  attempts: 0,
  heartbeat: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  ...over,
})

describe('§3.2 idempotency', () => {
  test('trigger({ runId }) on an existing NON-terminal run: no new work, deduped, no run:queued', async () => {
    const store = createMemoryRunStore()
    await store.put(record({ id: 'r1', state: 'processing', input: 'already running' }))
    const copilot = createCopilot({ provider: scriptedModel('never'), runStore: store })
    const queued: string[] = []
    copilot.on('run:queued', ({ runId }) => queued.push(runId))

    const handle = copilot.trigger({ runId: 'r1', input: 'new input' })
    await vi.waitFor(() => expect(handle.run.get()).not.toBeNull())
    expect(handle.deduped).toBe(true)
    expect(handle.run.get()?.input).toBe('already running')
    expect(queued).toEqual([])
    expect(copilot.inspect().runs.processing).toBe(1)
    await copilot.destroy()
  })

  test('trigger({ runId }) on an existing TERMINAL run: result() resolves from the record', async () => {
    const store = createMemoryRunStore()
    await store.put(record({ id: 'r1', state: 'done', output: 'stored output', attempts: 1 }))
    const copilot = createCopilot({ provider: scriptedModel('fresh'), runStore: store })
    const handle = copilot.trigger({ runId: 'r1', input: 'ignored' })
    const result = await handle.result()
    expect(handle.deduped).toBe(true)
    expect(result.ok && result.output).toBe('stored output')
    expect(result.ok && result.restarted).toBe(false)
    await copilot.destroy()
  })

  test('trigger() with no runId mints a fresh id from createId()', async () => {
    let index = 0
    const copilot = createCopilot({
      provider: scriptedModel([{ text: 'a' }, { text: 'b' }]),
      createId: () => `generated-${(index += 1)}`,
    })
    const first = copilot.trigger({ input: 'one' })
    const second = copilot.trigger({ input: 'two' })
    expect([first.id, second.id]).toEqual(['generated-1', 'generated-2'])
    expect(first.deduped).toBe(false)
    await Promise.all([first.result(), second.result()])
    await copilot.destroy()
  })

  test('a second trigger() with the same runId in the same process dedupes onto the live run', async () => {
    const copilot = createCopilot({ provider: scriptedModel([{ text: 'one', delayMs: 5 }]) })
    const first = copilot.trigger({ runId: 'r1', input: 'hi' })
    const second = copilot.trigger({ runId: 'r1', input: 'hi again' })
    expect(second.deduped).toBe(true)
    const [a, b] = await Promise.all([first.result(), second.result()])
    expect(a).toEqual(b)
    await copilot.destroy()
  })

  test('cancel(unknownId) resolves false and never throws', async () => {
    const copilot = createCopilot({ provider: scriptedModel('ok') })
    await expect(copilot.cancel('nope')).resolves.toBe(false)
    await copilot.destroy()
  })

  test('cancel(terminalId) resolves false and emits nothing', async () => {
    const copilot = createCopilot({ provider: scriptedModel('ok') })
    const events: string[] = []
    await copilot.trigger({ runId: 'r1', input: 'hi' }).result()
    copilot.subscribe((event) => events.push(event.type))
    await expect(copilot.cancel('r1')).resolves.toBe(false)
    expect(events).toEqual([])
    await copilot.destroy()
  })

  test('attach(unknownId): run store stays null, result() resolves run_not_found, never throws', async () => {
    const copilot = createCopilot({ provider: scriptedModel('ok') })
    const handle = copilot.attach('missing')
    expect(handle.run.get()).toBeNull()
    const result = await handle.result()
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe('error')
    expect(!result.ok && result.error?.code).toBe('run_not_found')
    await copilot.destroy()
  })

  test('attach(id) for a run owned by another context polls until the record is terminal', async () => {
    vi.useFakeTimers()
    try {
      const store = createMemoryRunStore()
      await store.put(record({ id: 'r1', state: 'processing', attempts: 1 }))
      const copilot = createCopilot({ provider: scriptedModel('ok'), runStore: store })
      const handle = copilot.attach('r1')
      const settled = handle.result()
      await vi.advanceTimersByTimeAsync(10)
      expect(handle.run.get()?.state).toBe('processing')

      // The owning context finishes the run — there is no cross-instance channel.
      await store.put(record({ id: 'r1', state: 'done', output: 'from elsewhere', attempts: 1 }))
      await vi.advanceTimersByTimeAsync(5_000)
      const result = await settled
      expect(result.ok && result.output).toBe('from elsewhere')
      await copilot.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('row 1: a deduped handle onto a run owned by ANOTHER instance still settles', async () => {
    // Ownership is decided synchronously (`owned`) but corrected asynchronously by the store
    // lookup; without re-arming the poll, `result()` on the deduping instance never settles.
    vi.useFakeTimers()
    try {
      const store = createMemoryRunStore()
      const owner = createCopilot({
        provider: scriptedModel([{ text: 'the answer', delayMs: 20_000 }]),
        runStore: store,
      })
      const observer = createCopilot({ provider: scriptedModel('unused'), runStore: store })
      owner.trigger({ runId: 'r1', input: 'hi' })
      await vi.advanceTimersByTimeAsync(10)

      // §7.2's batch shape: trigger with a known id, then await the handle straight away.
      const handle = observer.trigger({ runId: 'r1', input: 'hi' })
      const settled = handle.result()
      await vi.advanceTimersByTimeAsync(30_000)
      const result = await settled
      expect(handle.deduped).toBe(true)
      expect(result.ok && result.output).toBe('the answer')
      await Promise.all([owner.destroy(), observer.destroy()])
    } finally {
      vi.useRealTimers()
    }
  })

  test('row 3: attach(id) before trigger({ runId: id }) does not turn the trigger into a no-op', async () => {
    const copilot = createCopilot({ provider: scriptedModel('fresh') })
    const observer = copilot.attach('r1') // nothing in the store: no record to attach to yet
    const handle = copilot.trigger({ runId: 'r1', input: 'hi' })
    expect(handle.deduped).toBe(false)
    const result = await handle.result()
    expect(result.ok && result.output).toBe('fresh')
    expect((await copilot.get('r1'))?.state).toBe('done')
    expect(observer.id).toBe('r1')
    await copilot.destroy()
  })

  test('row 3: a settled attach(unknownId) handle does not block a later trigger of that id', async () => {
    const copilot = createCopilot({ provider: scriptedModel('fresh') })
    const observer = copilot.attach('r1')
    const missing = await observer.result()
    expect(!missing.ok && missing.error?.code).toBe('run_not_found')

    const handle = copilot.trigger({ runId: 'r1', input: 'hi' })
    expect(handle.deduped).toBe(false)
    const result = await handle.result()
    expect(result.ok && result.output).toBe('fresh')
    // The already-settled handle keeps its own answer; it is not retro-actively rewritten.
    expect(await observer.result()).toBe(missing)
    await copilot.destroy()
  })

  test('§2.6 `deduped` is per handle: the handle that started the work never flips to true', async () => {
    const copilot = createCopilot({ provider: scriptedModel([{ text: 'one', delayMs: 5 }]) })
    const first = copilot.trigger({ runId: 'r1', input: 'hi' })
    const second = copilot.trigger({ runId: 'r1', input: 'hi again' })
    const observer = copilot.attach('r1')
    expect(second.deduped).toBe(true)
    expect(observer.deduped).toBe(true)
    expect(first.deduped).toBe(false)
    await Promise.all([first.result(), second.result()])
    expect(first.deduped).toBe(false)
    await copilot.destroy()
  })

  test('a lost store claim hands the run to the poller instead of dropping its result()', async () => {
    vi.useFakeTimers()
    try {
      const inner = createMemoryRunStore()
      const store: RunStore = {
        name: 'leased-elsewhere',
        get: (id) => inner.get(id),
        put: (run) => inner.put(run),
        list: (filter) => inner.list(filter),
        // Another context holds the lease for the whole test.
        claim: async () => false,
      }
      const copilot = createCopilot({ provider: scriptedModel('never'), runStore: store })
      const handle = copilot.trigger({ runId: 'r1', input: 'hi' })
      const settled = handle.result()
      await vi.advanceTimersByTimeAsync(10)
      expect((await inner.get('r1'))?.state).toBe('queued')

      // The lease holder finishes the run in its own context; nothing pushes that across.
      await inner.put({ ...(await inner.get('r1'))!, state: 'done', output: 'from the owner' })
      await vi.advanceTimersByTimeAsync(5_000)
      const result = await settled
      expect(result.ok && result.output).toBe('from the owner')
      await copilot.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('resumePending() from two instances: the loser reports the run under skipped', async () => {
    const store = createMemoryRunStore()
    await store.put(
      record({ id: 'r1', state: 'processing', attempts: 1, heartbeat: new Date(0).toISOString() }),
    )
    const a = createCopilot({
      provider: scriptedModel([{ text: 'a', delayMs: 50 }]),
      runStore: store,
    })
    const b = createCopilot({
      provider: scriptedModel([{ text: 'b', delayMs: 50 }]),
      runStore: store,
    })
    const [reportA, reportB] = await Promise.all([a.resumePending(), b.resumePending()])
    const restarted = [...reportA.restarted, ...reportB.restarted]
    expect(restarted).toEqual(['r1'])
    expect(reportA.skipped + reportB.skipped).toBe(1)
    await Promise.all([a.destroy(), b.destroy()])
  })
})
