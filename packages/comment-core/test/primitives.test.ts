/** §2.1 `ReadableStore` and the typed bus behind §2.11's `on/once/off/subscribe`. */

import { describe, expect, test } from 'vitest'

import { createEmitter } from '../src/emitter.ts'
import { readonlyStore, writable } from '../src/readable.ts'

describe('ReadableStore (§2.1)', () => {
  test('get() returns the current value and never throws', () => {
    const store = writable(1)
    expect(store.get()).toBe(1)
    store.set(2)
    expect(store.get()).toBe(2)
  })

  test('subscribe does not fire on subscribe, and reports (value, previous)', () => {
    const store = writable('a')
    const seen: Array<[string, string]> = []
    store.subscribe((value, previous) => void seen.push([value, previous]))
    expect(seen).toEqual([])
    store.set('b')
    expect(seen).toEqual([['b', 'a']])
  })

  test('an unchanged value notifies nobody', () => {
    const store = writable({ n: 1 })
    let calls = 0
    store.subscribe(() => void calls++)
    store.set(store.get())
    expect(calls).toBe(0)
  })

  test('the unsubscriber is idempotent', () => {
    const store = writable(0)
    let calls = 0
    const off = store.subscribe(() => void calls++)
    off()
    off()
    store.set(1)
    expect(calls).toBe(0)
  })

  test('readonlyStore exposes only the read half', () => {
    const store = writable(1)
    const view = readonlyStore(store)
    expect(view.get()).toBe(1)
    expect('set' in view).toBe(false)
  })
})

interface TestMap {
  a: { n: number }
  b: { s: string }
}

describe('typed bus (§2.11)', () => {
  test('on/off deliver typed payloads and detach', () => {
    const bus = createEmitter<TestMap>()
    const seen: number[] = []
    const listener = (payload: { n: number }): void => void seen.push(payload.n)
    bus.on('a', listener)
    bus.emit('a', { n: 1 })
    bus.off('a', listener)
    bus.emit('a', { n: 2 })
    expect(seen).toEqual([1])
  })

  test('once fires exactly once', () => {
    const bus = createEmitter<TestMap>()
    let calls = 0
    bus.once('a', () => void calls++)
    bus.emit('a', { n: 1 })
    bus.emit('a', { n: 2 })
    expect(calls).toBe(1)
  })

  test('an AbortSignal detaches the listener', () => {
    const bus = createEmitter<TestMap>()
    const controller = new AbortController()
    let calls = 0
    bus.on('a', () => void calls++, { signal: controller.signal })
    bus.emit('a', { n: 1 })
    controller.abort()
    bus.emit('a', { n: 2 })
    expect(calls).toBe(1)
  })

  test('counts() reports live listeners per type plus the firehose', () => {
    const bus = createEmitter<TestMap>()
    bus.on('a', () => {})
    bus.on('a', () => {})
    bus.subscribe(() => {})
    expect(bus.counts()).toMatchObject({ a: 2, '*': 1 })
    bus.clear()
    expect(bus.counts()).toEqual({ '*': 0 })
  })
})
