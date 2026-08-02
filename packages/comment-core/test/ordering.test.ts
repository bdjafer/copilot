/**
 * §4.2 event-ordering guarantees — the rules a headless build can observe.
 *
 * §4.2.3 (create-not-reply), §4.2.4 (state precedes content), §4.2.5 (deletion order) and
 * §4.2.12 (cross-context relay) are named in `observe.test.ts`, which is where the store diff
 * that produces them lives. §4.2.2, .6, .8, .9, .10 and .11 are engine-only.
 */

import { describe, expect, test } from 'vitest'

import { createEmitter } from '../src/emitter.ts'
import {
  createDomain,
  createMemoryStore,
  observeStore,
  type CommentStore,
  type StoreEvent,
} from '../src/headless.ts'
import { countingIds, makeCreateInput, tickingClock } from '../src/testing/index.ts'
import { flush } from './helpers.ts'

describe('§4.2.1 persist-then-notify', () => {
  test('a write that does not land in the store emits nothing and leaves state untouched', async () => {
    const base = createMemoryStore()
    let failing = false
    const store: CommentStore = {
      ...base,
      putThread: (thread) => (failing ? Promise.reject(new Error('io')) : base.putThread(thread)),
      subscribe: (pageKey, cb) => base.subscribe(pageKey, cb),
    }
    const domain = createDomain(store, { now: tickingClock(), createId: countingIds() })
    const events: StoreEvent[] = []
    const stop = observeStore(store, (event) => void events.push(event))
    await flush()

    const { thread } = await domain.createThread(makeCreateInput())
    await flush()
    events.length = 0

    failing = true
    await expect(domain.resolve(thread.id)).rejects.toMatchObject({ code: 'store_failed' })
    await flush()

    expect(events).toEqual([])
    expect((await store.getThread(thread.id))?.status).toBe('open')
    stop()
  })
})

describe('§4.2.7 synchronous, snapshot-ordered emission', () => {
  test('listeners run in registration order', () => {
    const bus = createEmitter<{ e: number }>()
    const order: string[] = []
    bus.on('e', () => void order.push('first'))
    bus.on('e', () => void order.push('second'))
    bus.on('e', () => void order.push('third'))
    bus.emit('e', 1)
    expect(order).toEqual(['first', 'second', 'third'])
  })

  test('subscribing during emission takes effect on the NEXT emission', () => {
    const bus = createEmitter<{ e: number }>()
    const order: string[] = []
    bus.on('e', () => {
      order.push('outer')
      bus.on('e', () => void order.push('late'))
    })
    bus.emit('e', 1)
    expect(order).toEqual(['outer'])
    bus.emit('e', 2)
    expect(order).toEqual(['outer', 'outer', 'late'])
  })

  test('unsubscribing during emission takes effect on the NEXT emission', () => {
    const bus = createEmitter<{ e: number }>()
    const order: string[] = []
    const off = bus.on('e', () => void order.push('doomed'))
    bus.on('e', () => off())
    bus.emit('e', 1)
    expect(order).toEqual(['doomed'])
    bus.emit('e', 2)
    expect(order).toEqual(['doomed'])
  })

  test('a throwing listener breaks neither its peers nor the batch', () => {
    const faults: string[] = []
    const bus = createEmitter<{ e: number }>({
      onListenerError: (_error, type) => void faults.push(type),
    })
    const order: string[] = []
    bus.on('e', () => {
      throw new Error('boom')
    })
    bus.on('e', () => void order.push('survivor'))
    bus.emit('e', 1)
    expect(order).toEqual(['survivor'])
    expect(faults).toEqual(['e'])
  })

  test('a throwing error sink cannot re-enter the bus (error-loop breaker)', () => {
    const bus = createEmitter<{ e: number }>({
      onListenerError: () => {
        throw new Error('the sink is down too')
      },
    })
    bus.on('e', () => {
      throw new Error('boom')
    })
    expect(() => bus.emit('e', 1)).not.toThrow()
  })

  test('the * firehose receives each event AFTER its typed listeners, with seq from 1', () => {
    const bus = createEmitter<{ e: number }>()
    const order: string[] = []
    bus.subscribe((event) => void order.push(`*:${event.type}:${event.seq}`))
    bus.on('e', () => void order.push('typed'))
    bus.emit('e', 1)
    bus.emit('e', 2)
    expect(order).toEqual(['typed', '*:e:1', 'typed', '*:e:2'])
  })

  test('emit stamps a monotonic seq and a wall clock', () => {
    const bus = createEmitter<{ e: number }>({ now: () => 1234 })
    expect(bus.emit('e', 1)).toMatchObject({ type: 'e', seq: 1, at: 1234, payload: 1 })
    expect(bus.emit('e', 2).seq).toBe(2)
    expect(bus.seq).toBe(2)
  })
})
