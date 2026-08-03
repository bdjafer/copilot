// SPEC-copilot §2.11 — the run-store conformance suite. Returns `ConformanceCase[]` rather than
// taking `{ describe, it, expect }` so it runs in vitest, node:test and bun alike (decision #24).
import type { Awaitable, Run, RunStore } from '../types.ts'

export interface ConformanceCase {
  name: string
  run: () => Promise<void>
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`run-store conformance: ${message}`)
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  assert(a === b, `${message} (got ${a}, expected ${b})`)
}

const ISO = (ms: number) => new Date(ms).toISOString()

function makeRun(over: Partial<Run> & { id: string }): Run {
  return {
    state: 'queued',
    input: 'hello',
    attempts: 0,
    heartbeat: ISO(1_000),
    createdAt: ISO(1_000),
    ...over,
  }
}

/** ~25 assertions: durability, sorting, filtering, upsert, optional claim semantics. */
export function runStoreConformance(factory: () => Awaitable<RunStore>): ConformanceCase[] {
  const cases: ConformanceCase[] = []
  const add = (name: string, run: (store: RunStore) => Promise<void>) => {
    cases.push({
      name,
      run: async () => {
        await run(await factory())
      },
    })
  }

  add('get() of an unknown id resolves null', async (store) => {
    assertEqual(await store.get('nope'), null, 'unknown id must be null')
  })

  add('put() then get() round-trips the record', async (store) => {
    const run = makeRun({ id: 'a' })
    await store.put(run)
    assertEqual(await store.get('a'), run, 'record must round-trip')
  })

  add('put() resolves only when the write is durable', async (store) => {
    await store.put(makeRun({ id: 'a' }))
    const read = await store.get('a')
    assert(read !== null, 'a resolved put() must be readable immediately')
  })

  add('put() upserts on the same id', async (store) => {
    await store.put(makeRun({ id: 'a' }))
    await store.put(makeRun({ id: 'a', state: 'done', output: 'out' }))
    const read = await store.get('a')
    assertEqual(read?.state, 'done', 'state must be overwritten')
    assertEqual(read?.output, 'out', 'output must be stored')
    assertEqual((await store.list()).length, 1, 'upsert must not duplicate')
  })

  add('get() returns a detached copy (mutating it cannot corrupt the store)', async (store) => {
    await store.put(makeRun({ id: 'a' }))
    const first = await store.get('a')
    assert(first !== null, 'record must exist')
    first.input = 'mutated'
    assertEqual((await store.get('a'))?.input, 'hello', 'store must be isolated from callers')
  })

  add(
    'put() stores a detached copy (mutating the argument cannot corrupt the store)',
    async (store) => {
      const run = makeRun({ id: 'a' })
      await store.put(run)
      run.input = 'mutated'
      assertEqual((await store.get('a'))?.input, 'hello', 'store must snapshot on write')
    },
  )

  add('all ten Run fields survive the round trip (nine + the `spec` snapshot)', async (store) => {
    const run = makeRun({
      id: 'a',
      state: 'error',
      input: 'in',
      output: 'out',
      error: 'timeout: slow',
      attempts: 2,
      heartbeat: ISO(5_000),
      createdAt: ISO(4_000),
      context: { threadId: 't1' },
      spec: { model: 'fast', tools: ['read_thread'], maxSteps: 12 },
    })
    await store.put(run)
    assertEqual(await store.get('a'), run, 'every field must survive')
  })

  add('the `spec` snapshot survives a JSON round trip verbatim (§2.2)', async (store) => {
    // A resume in another process resolves the run's model tier, tool subset and step cap from
    // exactly this value: a store that drops or reshapes it silently changes what the run is.
    await store.put(makeRun({ id: 'a', spec: { tools: [], maxSteps: 1 } }))
    const read = await store.get('a')
    assertEqual(read?.spec, { tools: [], maxSteps: 1 }, 'spec must survive verbatim')
    assert(Array.isArray(read?.spec?.tools), 'an empty tool subset must stay an array, not vanish')
  })

  add('a run without a spec stays without one', async (store) => {
    await store.put(makeRun({ id: 'a' }))
    assert((await store.get('a'))?.spec === undefined, 'absent spec must stay absent')
  })

  add('context survives a JSON round trip for a nested plain object (§2.2)', async (store) => {
    const context = { a: { b: [1, 2, { c: 'd' }] }, e: null, f: true }
    await store.put(makeRun({ id: 'a', context }))
    assertEqual((await store.get('a'))?.context, context, 'nested context must survive')
  })

  add('a run without context stays without context', async (store) => {
    await store.put(makeRun({ id: 'a' }))
    const read = await store.get('a')
    assert(read?.context === undefined, 'absent context must stay absent')
  })

  add('list() of an empty store is []', async (store) => {
    assertEqual(await store.list(), [], 'empty store lists nothing')
  })

  add('list() returns every run', async (store) => {
    await store.put(makeRun({ id: 'a' }))
    await store.put(makeRun({ id: 'b' }))
    assertEqual((await store.list()).length, 2, 'both runs must be listed')
  })

  add('list() sorts by createdAt ascending', async (store) => {
    await store.put(makeRun({ id: 'c', createdAt: ISO(3_000) }))
    await store.put(makeRun({ id: 'a', createdAt: ISO(1_000) }))
    await store.put(makeRun({ id: 'b', createdAt: ISO(2_000) }))
    assertEqual(
      (await store.list()).map((run) => run.id),
      ['a', 'b', 'c'],
      'list must be createdAt-ascending',
    )
  })

  add('list({ state }) filters on a single state', async (store) => {
    await store.put(makeRun({ id: 'a', state: 'queued' }))
    await store.put(makeRun({ id: 'b', state: 'done' }))
    assertEqual(
      (await store.list({ state: 'done' })).map((run) => run.id),
      ['b'],
      'single-state filter',
    )
  })

  add('list({ state: [...] }) filters on a set of states', async (store) => {
    await store.put(makeRun({ id: 'a', state: 'queued', createdAt: ISO(1_000) }))
    await store.put(makeRun({ id: 'b', state: 'processing', createdAt: ISO(2_000) }))
    await store.put(makeRun({ id: 'c', state: 'done', createdAt: ISO(3_000) }))
    assertEqual(
      (await store.list({ state: ['queued', 'processing'] })).map((run) => run.id),
      ['a', 'b'],
      'multi-state filter',
    )
  })

  add('list({ idPrefix }) filters on the host-composed id', async (store) => {
    await store.put(makeRun({ id: 'c:t1:1' }))
    await store.put(makeRun({ id: 'c:t1:2', createdAt: ISO(2_000) }))
    await store.put(makeRun({ id: 'c:t2:1', createdAt: ISO(3_000) }))
    assertEqual(
      (await store.list({ idPrefix: 'c:t1:' })).map((run) => run.id),
      ['c:t1:1', 'c:t1:2'],
      'idPrefix filter',
    )
  })

  add('list({ before }) keeps runs with createdAt < before', async (store) => {
    await store.put(makeRun({ id: 'a', createdAt: ISO(1_000) }))
    await store.put(makeRun({ id: 'b', createdAt: ISO(2_000) }))
    assertEqual(
      (await store.list({ before: ISO(2_000) })).map((run) => run.id),
      ['a'],
      'before is exclusive',
    )
  })

  add('list({ limit }) truncates after sorting', async (store) => {
    await store.put(makeRun({ id: 'b', createdAt: ISO(2_000) }))
    await store.put(makeRun({ id: 'a', createdAt: ISO(1_000) }))
    assertEqual(
      (await store.list({ limit: 1 })).map((run) => run.id),
      ['a'],
      'limit applies to the sorted list',
    )
  })

  add('list() combines state, idPrefix, before and limit', async (store) => {
    await store.put(makeRun({ id: 'c:t1:1', state: 'queued', createdAt: ISO(1_000) }))
    await store.put(makeRun({ id: 'c:t1:2', state: 'done', createdAt: ISO(2_000) }))
    await store.put(makeRun({ id: 'c:t1:3', state: 'queued', createdAt: ISO(3_000) }))
    await store.put(makeRun({ id: 'c:t2:1', state: 'queued', createdAt: ISO(1_500) }))
    assertEqual(
      (
        await store.list({
          state: 'queued',
          idPrefix: 'c:t1:',
          before: ISO(9_000),
          limit: 5,
        })
      ).map((run) => run.id),
      ['c:t1:1', 'c:t1:3'],
      'combined filters',
    )
  })

  add('list() returns detached copies', async (store) => {
    await store.put(makeRun({ id: 'a' }))
    const [first] = await store.list()
    assert(first !== undefined, 'record must be listed')
    first.state = 'cancelled'
    assertEqual((await store.get('a'))?.state, 'queued', 'list results must be detached')
  })

  add('terminal runs remain retrievable — the runtime never deletes', async (store) => {
    await store.put(makeRun({ id: 'a', state: 'done', output: 'x' }))
    assertEqual((await store.get('a'))?.output, 'x', 'terminal runs must persist')
  })

  add('a done run keeps output and an error run keeps error', async (store) => {
    await store.put(makeRun({ id: 'a', state: 'done', output: 'the answer' }))
    await store.put(makeRun({ id: 'b', state: 'error', error: 'max_attempts: dead' }))
    assertEqual((await store.get('a'))?.output, 'the answer', 'output persists')
    assertEqual((await store.get('b'))?.error, 'max_attempts: dead', 'error persists')
  })

  add('attempts and heartbeat survive an update', async (store) => {
    await store.put(makeRun({ id: 'a' }))
    await store.put(makeRun({ id: 'a', attempts: 3, heartbeat: ISO(9_000) }))
    const read = await store.get('a')
    assertEqual(read?.attempts, 3, 'attempts must update')
    assertEqual(read?.heartbeat, ISO(9_000), 'heartbeat must update')
  })

  add('name, when present, is a human-readable string', async (store) => {
    assert(
      store.name === undefined || typeof store.name === 'string',
      'name must be a string when present',
    )
  })

  add('claim() (optional): a fresh lease blocks another owner', async (store) => {
    if (store.claim === undefined) return
    await store.put(makeRun({ id: 'a' }))
    assertEqual(await store.claim('a', 'owner-1', 60_000), true, 'first claim wins')
    assertEqual(await store.claim('a', 'owner-2', 60_000), false, 'second owner is blocked')
  })

  add('claim() (optional): the holder can renew its own lease', async (store) => {
    if (store.claim === undefined) return
    await store.put(makeRun({ id: 'a' }))
    assertEqual(await store.claim('a', 'owner-1', 60_000), true, 'first claim wins')
    assertEqual(await store.claim('a', 'owner-1', 60_000), true, 'renewal by the holder')
  })

  add('claim() (optional): an expired lease is re-claimable', async (store) => {
    if (store.claim === undefined) return
    await store.put(makeRun({ id: 'a' }))
    assertEqual(await store.claim('a', 'owner-1', 0), true, 'first claim wins')
    await new Promise((resolve) => setTimeout(resolve, 1))
    assertEqual(await store.claim('a', 'owner-2', 60_000), true, 'expired lease is free')
  })

  return cases
}
