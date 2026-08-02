/**
 * §2.11 engine construction, lifecycle, `inspect()` and the §4.4 error contract.
 */

import { afterEach, describe, expect, test } from 'vitest'

import type { CommentEngine } from '../src/index.ts'

import { CommentError, createCommentEngine, createMemoryStore } from '../src/index.ts'
import { harness, PAGE_URL } from './dom-helpers.ts'

const open: CommentEngine[] = []

function engineOn(options?: Parameters<typeof createCommentEngine>[0]): CommentEngine {
  const engine = createCommentEngine({ store: createMemoryStore(), ...options })
  open.push(engine)
  return engine
}

afterEach(() => {
  for (const engine of open.splice(0)) engine.destroy()
  document.body.innerHTML = ''
})

describe('§2.11 construction', () => {
  test('defaults: localStorage-free store injection, defaultPageKey, one `comment` mode on `c`', () => {
    const engine = engineOn()
    expect(engine.modes).toEqual([{ kind: 'comment', trigger: { key: 'c', interaction: 'pick' } }])
    expect(engine.pageKey).toBe(
      new URL(location.href).origin + new URL(location.href).pathname.replace(/\/+$/, ''),
    )
  })

  test('autoStart defaults to true: status leaves idle without an explicit start()', async () => {
    const engine = engineOn()
    await engine.ready()
    expect(engine.status.get()).toBe('ready')
  })

  test('autoStart: false leaves status idle and construction succeeds with no document', () => {
    const engine = createCommentEngine({
      store: createMemoryStore(),
      autoStart: false,
      document: undefined,
    })
    open.push(engine)
    expect(engine.status.get()).toBe('idle')
    expect(engine.listThreads()).toEqual([])
  })

  test('start() with no usable document throws no_document synchronously', () => {
    const engine = createCommentEngine({
      store: createMemoryStore(),
      autoStart: false,
      document: {} as Document,
    })
    open.push(engine)
    expect(() => engine.start()).toThrow(
      expect.objectContaining({ code: 'no_document' }) as unknown as Error,
    )
  })

  test('two modes binding the same key + modifiers throw invalid_options at construction', () => {
    expect(() =>
      createCommentEngine({
        store: createMemoryStore(),
        autoStart: false,
        modes: [
          { kind: 'a', trigger: { key: 'c' } },
          { kind: 'b', trigger: { key: 'C' } },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'invalid_options' }) as unknown as Error)
  })

  test('the same key with different modifiers is not a duplicate', () => {
    expect(() =>
      engineOn({
        autoStart: false,
        modes: [
          { kind: 'a', trigger: { key: 'c' } },
          { kind: 'b', trigger: { key: 'c', modifiers: { shift: true } } },
        ],
      }),
    ).not.toThrow()
  })

  test('setModes re-validates and throws invalid_options on a duplicate binding', () => {
    const engine = engineOn()
    expect(() =>
      engine.setModes([
        { kind: 'a', trigger: { key: 'x' } },
        { kind: 'b', trigger: { key: 'x' } },
      ]),
    ).toThrow(expect.objectContaining({ code: 'invalid_options' }) as unknown as Error)
    expect(engine.modes.map((m) => m.kind)).toEqual(['comment'])
  })
})

describe('§4.2.11 destroy()', () => {
  test('destroy() is idempotent, sets status and emits nothing afterwards', async () => {
    const h = await harness('<div id="t" data-testid="t">hello</div>')
    h.engine.destroy()
    expect(h.engine.status.get()).toBe('destroyed')
    expect(() => h.engine.destroy()).not.toThrow()
    expect(h.events).toHaveLength(0)
    await h.dispose()
  })

  test('post-destroy domain calls reject with engine_destroyed', async () => {
    const h = await harness('<div id="t" data-testid="t">hello</div>')
    h.engine.destroy()
    await expect(h.engine.resolve('x')).rejects.toMatchObject({ code: 'engine_destroyed' })
    await expect(h.engine.get('x')).rejects.toMatchObject({ code: 'engine_destroyed' })
    await h.dispose()
  })

  test('destroy() drops every listener and stops the bus permanently', async () => {
    const h = await harness('<div id="t" data-testid="t">hello</div>')
    let seen = 0
    h.engine.on('thread:create', () => seen++)
    expect(h.engine.inspect().listeners['thread:create']).toBe(1)
    h.engine.destroy()
    expect(h.engine.inspect().listeners['thread:create']).toBe(0)
    expect(seen).toBe(0)
    await h.dispose()
  })

  test('stop() then start() is safe and idempotent', async () => {
    const h = await harness('<div id="t" data-testid="t">hello</div>')
    h.engine.stop()
    expect(h.engine.status.get()).toBe('idle')
    h.engine.stop()
    h.engine.start()
    await h.engine.ready()
    expect(h.engine.status.get()).toBe('ready')
    await h.dispose()
  })
})

describe('§2.15 inspect()', () => {
  test('reports pageKey, modes, store name + engine-counted io, threads, anchoring and listeners', async () => {
    const h = await harness('<div id="t" data-testid="t">hello</div>', { url: PAGE_URL })
    await h.seed('#t', 'body')
    await h.flush()

    const report = h.engine.inspect()
    expect(report.version).toBe('0.0.0')
    expect(report.pageKey).toBe(PAGE_URL)
    expect(report.modes).toBe(h.engine.modes)
    expect(report.store.name).toBe('memory')
    expect(report.store.reads).toBeGreaterThan(0)
    expect(report.store.writes).toBeGreaterThan(0)
    expect(report.store.lastError).toBeNull()
    expect(report.threads).toEqual([
      expect.objectContaining({ kind: 'comment', status: 'open', comments: 1, anchor: 'anchored' }),
    ])
    expect(report.anchoring.observing).toBe(true)
    expect(report.anchoring.batches).toBeGreaterThan(0)
    expect(report.listeners['*']).toBe(1)
    expect(report.strategies.some((s) => s.type === 'attr' && s.hits > 0)).toBe(true)
    await h.dispose()
  })

  test('store.lastError records the last store failure', async () => {
    const store = createMemoryStore()
    const failing = {
      ...store,
      listThreads: async () => {
        throw new Error('disk on fire')
      },
    }
    const engine = engineOn({ store: failing })
    await engine.ready()
    expect(engine.inspect().store.lastError).toBe('disk on fire')
  })
})

describe('§4.4 error behavior', () => {
  test('a store failure on a write rejects, emits one `error` (phase store) and leaves the view untouched', async () => {
    const store = createMemoryStore()
    const h = await harness('<div id="t" data-testid="t">hello</div>', {
      store: Object.assign(store, {
        putComment: async () => {
          throw new Error('nope')
        },
      }),
    })
    await expect(h.seed('#t')).rejects.toMatchObject({ code: 'store_failed' })
    // §4.2.1 verbatim: "the imperative promise rejects, one `error` (phase 'store') is emitted,
    // and the live view is left untouched".
    expect(h.typed('error')).toHaveLength(1)
    expect(h.typed('error')[0]!.payload.phase).toBe('store')
    expect(h.typed('error')[0]!.payload.error.code).toBe('store_failed')
    expect(h.engine.threads.get()).toHaveLength(0)
    await h.dispose()
  })

  test('a throwing listener cannot break its peers and is reported once as `error`/listener', async () => {
    const h = await harness('<div id="t" data-testid="t">hello</div>')
    const seen: string[] = []
    h.engine.on('thread:create', () => {
      throw new Error('listener boom')
    })
    h.engine.on('thread:create', () => seen.push('second'))
    await h.seed('#t')
    expect(seen).toEqual(['second'])
    expect(h.typed('error')[0]!.payload.phase).toBe('listener')
    await h.dispose()
  })

  test('§4.4 error-loop breaker: a throwing `error` listener goes to onError, never back to the bus', async () => {
    const sink: Array<[string, string]> = []
    const h = await harness('<div id="t" data-testid="t">hello</div>', {
      onError: (error, phase) => sink.push([error.code, phase]),
    })
    h.engine.on('error', () => {
      throw new Error('error listener boom')
    })
    h.engine.on('thread:create', () => {
      throw new Error('first boom')
    })
    await h.seed('#t')
    // exactly one `error` event, and the throw from its own listener did not re-enter the bus
    expect(h.typed('error')).toHaveLength(1)
    expect(sink.map(([, phase]) => phase)).toEqual(['listener', 'listener'])
    await h.dispose()
  })

  test('onError receives every error event with its phase', async () => {
    const sink: string[] = []
    const h = await harness('<div id="t" data-testid="t">hello</div>', {
      onError: (_error, phase) => sink.push(phase),
    })
    h.engine.startPlacement('nope')
    expect(sink).toEqual(['placement'])
    await h.dispose()
  })

  test('CommentError.is narrows brand-based across the surface', () => {
    expect(CommentError.is(new CommentError('no_document'), 'no_document')).toBe(true)
    expect(CommentError.is(new CommentError('no_document'), 'empty_body')).toBe(false)
  })
})
