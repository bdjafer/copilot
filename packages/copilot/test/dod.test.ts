// SPEC-copilot §9 — the definition-of-done checklist, one test per item.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import * as api from '../src/index.ts'
import { createCopilot, defineTool, MAX_ATTEMPTS, retryDelayMs } from '../src/index.ts'
import { createMemoryRunStore } from '../src/store/memory.ts'
import { createTestCopilot } from '../src/testing/harness.ts'
import * as testingApi from '../src/testing/index.ts'
import { scriptedModel } from '../src/testing/scripted-model.ts'
import { httpError } from './support.ts'

const SRC = fileURLToPath(new URL('../src', import.meta.url))

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

describe('§9 definition of done', () => {
  test('the entry points export the §2 value surface — and nothing that is not in §2', () => {
    // §2's value exports, in spec order. The type surface is asserted at compile time in
    // test/types.test.ts; a namespace object cannot carry type-only exports.
    const root = [
      'lazyModel',
      'MAX_ATTEMPTS',
      'STALE_AFTER_MS',
      'HEARTBEAT_MS',
      'retryDelayMs',
      'defineTool',
      'remoteTool',
      'toolsFor',
      'serveTools',
      'createCopilot',
      'defineRunStore',
      'createMemoryRunStore',
      'createKeyValueRunStore',
      'CopilotError',
      'isRetryable',
    ]
    for (const name of root) expect(api).toHaveProperty(name)
    expect(Object.keys(api).sort()).toEqual([...root].sort())

    const testing = ['runStoreConformance', 'scriptedModel', 'createTestCopilot']
    for (const name of testing) expect(testingApi).toHaveProperty(name)
    expect(Object.keys(testingApi).sort()).toEqual([...testing].sort())
  })

  test('§2.6 deliberate absences really are absent from the runtime surface', () => {
    const copilot = createCopilot({ provider: scriptedModel() })
    const handle = copilot.trigger({ input: 'hi' })
    for (const name of [
      'ask',
      'triggerMany',
      'simulate',
      'drain',
      'queue',
      'undoRun',
      'watchdog',
      'explain',
      'cancelAll',
      'metrics',
      'use',
    ]) {
      expect(name in copilot).toBe(false)
    }
    expect('ok' in handle).toBe(false)
    expect(Symbol.asyncIterator in handle).toBe(false)
    expect('then' in handle).toBe(false)
    expect('setEnabled' in copilot.tools).toBe(false)
    void handle.result()
    void copilot.destroy()
  })

  test('§7.4 kill() / revive() / resumePending() — and the host append runs exactly once', async () => {
    const appended: string[] = []
    let killed = false
    const t = createTestCopilot({
      tools: [
        defineTool({
          name: 'read_thread',
          description: 'stub',
          inputSchema: z.object({}),
          // The pre-kill attempt hangs inside the tool, so the worker dies mid-loop and the
          // record is left `processing` — deterministically, with no wall-clock races.
          execute: (_input, ctx) => {
            if (killed) return { comments: [] }
            return new Promise<{ comments: never[] }>((resolve) => {
              ctx.signal.addEventListener('abort', () => resolve({ comments: [] }))
            })
          },
        }),
      ] as const,
      script: [{ toolCall: { name: 'read_thread', input: {} } }, { text: 'done' }],
    })
    t.copilot.trigger({ runId: 'c:t1:1', input: 'hi', context: { threadId: 't1' } })
    await t.events.waitFor('run:start')
    await t.events.waitFor('tool:call')
    killed = true
    await t.kill() // the SW dies mid-loop; the record stays `processing` with a stale heartbeat
    expect((await t.runStore.get('c:t1:1'))?.state).toBe('processing')

    const revived = t.revive()
    // The revived instance replays from step 1 with a script that finishes.
    const report = await revived.resumePending({ staleAfterMs: 0 })
    expect(report.restarted).toEqual(['c:t1:1'])

    // The host's append is idempotent on runId.
    revived.on('run:done', ({ runId, output }) => {
      if (!appended.includes(`r:${runId}`)) appended.push(`r:${runId}:${output}`)
    })
    const result = await revived.attach('c:t1:1').result()
    expect(result.ok).toBe(true)
    expect(result.restarted).toBe(true)
    expect(appended).toHaveLength(1)
    await t.dispose()
  }, 20_000)

  test('concurrency 1: the watchdog does not burn attempts on runs waiting in the local queue', async () => {
    vi.useFakeTimers()
    try {
      const copilot = createCopilot({
        provider: scriptedModel([
          { text: 'one', delayMs: 25_000 },
          { text: 'two', delayMs: 25_000 },
          { text: 'three', delayMs: 25_000 },
        ]),
        concurrency: 1,
      })
      const ids = ['a', 'b', 'c']
      const starts: number[] = []
      copilot.on('run:start', ({ attempt }) => starts.push(attempt))
      const handles = ids.map((id) => copilot.trigger({ runId: id, input: id }))
      const settled = Promise.all(handles.map((handle) => handle.result()))

      // The watchdog fires every 30 s, well past STALE_AFTER_MS. `staleAfterMs: 0` makes EVERY
      // record stale, so the only thing standing between the two queued runs and a burnt attempt
      // is §3.1's "resumePending skips run ids the local queue holds" clause — which is the
      // property this DoD item names. With the heartbeat ticker alone the test would pass even
      // if that clause were deleted.
      for (let tick = 0; tick < 5; tick += 1) {
        await vi.advanceTimersByTimeAsync(30_000)
        expect((await copilot.resumePending()).restarted).toEqual([])
        const strict = await copilot.resumePending({ staleAfterMs: 0 })
        expect(strict.restarted).toEqual([])
        expect(strict.skipped).toBe(strict.scanned)
      }

      const results = await settled
      expect(results.every((result) => result.ok)).toBe(true)
      for (const id of ids) expect((await copilot.get(id))?.attempts).toBe(1)
      expect(starts).toEqual([1, 1, 1])
      await copilot.destroy()
    } finally {
      vi.useRealTimers()
    }
  })

  test('attach() from a second instance settles after the owner writes a terminal state', async () => {
    vi.useFakeTimers()
    try {
      const runStore = createMemoryRunStore()
      const owner = createCopilot({
        provider: scriptedModel([{ text: 'the answer', delayMs: 20_000 }]),
        runStore,
      })
      const observer = createCopilot({ provider: scriptedModel('unused'), runStore })

      owner.trigger({ runId: 'shared', input: 'hi' })
      await vi.advanceTimersByTimeAsync(10)
      const attached = observer.attach('shared')
      const settled = attached.result()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(attached.run.get()?.state).toBe('processing')

      await vi.advanceTimersByTimeAsync(30_000)
      const result = await settled
      expect(result.ok && result.output).toBe('the answer')
      await Promise.all([owner.destroy(), observer.destroy()])
    } finally {
      vi.useRealTimers()
    }
  })

  test('destroy() settles every outstanding result() and leaves the record resumable', async () => {
    const runStore = createMemoryRunStore()
    const first = createCopilot({
      provider: scriptedModel([{ text: 'never', delayMs: 60_000 }]),
      runStore,
    })
    const handle = first.trigger({ runId: 'r1', input: 'hi' })
    await vi.waitFor(async () => expect((await runStore.get('r1'))?.state).toBe('processing'))
    await first.destroy()

    const result = await handle.result()
    expect(result.ok).toBe(false)
    expect(!result.ok && result.reason).toBe('cancelled')
    expect(!result.ok && result.error?.code).toBe('destroyed')
    // The durable record is untouched — a later resumePending() picks it up.
    expect((await runStore.get('r1'))?.state).toBe('processing')

    const second = createCopilot({ provider: scriptedModel('recovered'), runStore })
    const report = await second.resumePending({ staleAfterMs: 0 })
    expect(report.restarted).toEqual(['r1'])
    const revivedResult = await second.attach('r1').result()
    expect(revivedResult.ok && revivedResult.output).toBe('recovered')
    await second.destroy()
  })

  test('a rate_limited run waits retryDelayMs(attempt) between attempts', async () => {
    vi.useFakeTimers()
    try {
      const at: number[] = []
      const t = createTestCopilot({
        provider: scriptedModel([
          { error: httpError(429) },
          { error: httpError(429) },
          { error: httpError(429) },
        ]),
      })
      t.copilot.on('run:start', () => at.push(Date.now()))
      const settled = t.copilot.trigger({ runId: 'r1', input: 'hi' }).result()

      await vi.advanceTimersByTimeAsync(100)
      expect(at).toHaveLength(1) // the retries did NOT burn inside one tick

      await vi.advanceTimersByTimeAsync(retryDelayMs(1))
      expect(at).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(retryDelayMs(2))
      expect(at).toHaveLength(MAX_ATTEMPTS)

      const result = await settled
      expect(!result.ok && result.error?.code).toBe('max_attempts')
      expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(retryDelayMs(1))
      expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(retryDelayMs(2))
      await t.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('both entry points import with document/window/navigator/localStorage/chrome deleted', async () => {
    const keys = ['document', 'window', 'navigator', 'localStorage', 'chrome'] as const
    const saved = new Map<string, PropertyDescriptor | undefined>()
    for (const key of keys) {
      saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key))
      Reflect.deleteProperty(globalThis, key)
    }
    try {
      for (const key of keys) expect(key in globalThis).toBe(false)
      vi.resetModules()
      const fresh = await import('../src/index.ts')
      const freshTesting = await import('../src/testing/index.ts')
      const copilot = fresh.createCopilot({ provider: freshTesting.scriptedModel() })
      expect(typeof copilot.trigger).toBe('function')
      const result = await copilot.trigger({ input: 'hi' }).result()
      expect(result.ok && result.output).toBe('ok')
      await copilot.destroy()
    } finally {
      for (const [key, descriptor] of saved) {
        if (descriptor !== undefined) Object.defineProperty(globalThis, key, descriptor)
      }
    }
  })

  test('publishConfig.exports names files the build actually produces (§1, decision log #33)', () => {
    // A `types` condition pointing at a .d.ts no build step writes is invisible here — the
    // workspace resolves `exports`, which points at src — and resolves to `any` for every
    // published consumer. So: every subpath maps to `dist/<entry>.js` (vite lib mode) and
    // `dist/types/<src path>.d.ts` (tsgo -p tsconfig.build.json), and when a build is present on
    // disk, the files are really there.
    const root = fileURLToPath(new URL('..', import.meta.url))
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      exports: Record<string, string>
      publishConfig: { exports: Record<string, { types: string; import: string }> }
    }
    const build = readFileSync(join(root, 'tsconfig.build.json'), 'utf8')
    expect(build).toContain('"outDir": "dist/types"')
    expect(pkg.publishConfig.exports).toEqual({
      '.': { types: './dist/types/index.d.ts', import: './dist/index.js' },
      './testing': { types: './dist/types/testing/index.d.ts', import: './dist/testing.js' },
    })
    // The publish map must cover exactly the subpaths the workspace map declares.
    expect(Object.keys(pkg.publishConfig.exports)).toEqual(Object.keys(pkg.exports))
    for (const [subpath, source] of Object.entries(pkg.exports)) {
      const published = pkg.publishConfig.exports[subpath]!
      // `./src/testing/index.ts` → `./dist/types/testing/index.d.ts`
      expect(published.types).toBe(
        source.replace('./src/', './dist/types/').replace(/\.ts$/, '.d.ts'),
      )
    }
    if (!existsSync(join(root, 'dist'))) return // no build in this working tree
    for (const entry of Object.values(pkg.publishConfig.exports)) {
      expect({ [entry.types]: existsSync(join(root, entry.types)) }).toEqual({
        [entry.types]: true,
      })
      expect({ [entry.import]: existsSync(join(root, entry.import)) }).toEqual({
        [entry.import]: true,
      })
    }
  })

  test('src/ contains no chrome., wxt/, comment-core, document. or window.', () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8')
      for (const pattern of [
        /chrome\./,
        /wxt\//,
        /from 'comment-core'/,
        /document\./,
        /window\./,
      ]) {
        if (pattern.test(source)) offenders.push(`${file}: ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
