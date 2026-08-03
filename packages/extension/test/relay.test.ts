/**
 * SPEC-copilot §3.3.13 (projection) and §3.3.5/§3.3.8 (dedupe keys) as executable assertions.
 *
 * The failure this file exists to catch is silent: structured clone drops an `Error` subclass's
 * own fields, so an unprojected relay delivers `error.code === undefined` — exactly the field
 * §7.1 and §7.3 branch on — with no exception anywhere.
 */

import type { CopilotEvent } from '@astrale-os/browser-copilot'

import { CopilotError } from '@astrale-os/browser-copilot'
import { describe, expect, it, vi } from 'vitest'

import type { RelayEnvelope } from '../src/content/relay-client.ts'
import type { FakePort } from './support/fake-chrome.ts'

import { attachRelay, CLONE_SAFE_EVENTS, projectEvent } from '../src/background/relay.ts'
import { createRelayClient } from '../src/content/relay-client.ts'
import { createRelayLink, RECONNECT_DELAYS } from '../src/content/relay-link.ts'
import { createPortPair } from './support/fake-chrome.ts'

const envelope = <T extends CopilotEvent['type']>(
  type: T,
  payload: unknown,
  over: Partial<{ runId: string | null; seq: number; instanceId: string; at: number }> = {},
) =>
  ({
    type,
    runId: 'r1',
    seq: 1,
    instanceId: 'i1',
    at: 0,
    payload,
    ...over,
  }) as unknown as CopilotEvent

const RUN = {
  id: 'r1',
  state: 'done',
  input: 'hi',
  attempts: 1,
  heartbeat: '2026-01-01T00:00:00.000Z',
  createdAt: '2026-01-01T00:00:00.000Z',
  spec: { model: 'fast', tools: ['read_thread'] },
  context: { threadId: 't1', kind: 'comment', pageKey: 'p', mode: 'single' },
}

describe('projectEvent — the four clone-safe payloads', () => {
  it('is exactly run:token | run:queued | run:done | run:cancelled', () => {
    expect([...CLONE_SAFE_EVENTS].sort()).toEqual([
      'run:cancelled',
      'run:done',
      'run:queued',
      'run:token',
    ])
  })

  it('posts each of them verbatim, spec and context included', () => {
    for (const type of CLONE_SAFE_EVENTS) {
      const event = envelope(type as CopilotEvent['type'], { runId: 'r1', run: RUN, delta: 'x' })
      const projected = projectEvent(event)
      expect(projected).toBe(event)
      // The Run — `context` and `spec` included — is JSON by contract, so it survives the wire.
      expect(JSON.parse(JSON.stringify(projected))).toEqual(event)
    }
  })
})

describe('projectEvent — the events the relay must project by hand', () => {
  it('run:error carries a live CopilotError, and toJSON keeps code/retryable', () => {
    const error = new CopilotError('rate_limited', 'slow down', { runId: 'r1' })
    const projected = projectEvent(
      envelope('run:error', { runId: 'r1', run: RUN, error, attempt: 1, willRetry: true }),
    ) as { payload: { error: { code: string; retryable: boolean } } }

    expect(projected.payload.error.code).toBe('rate_limited')
    expect(projected.payload.error.retryable).toBe(true)
    // The failure being prevented, demonstrated on the real mechanism: `port.postMessage` uses
    // structured clone, which serializes an Error as name/message/stack and drops every own
    // property — `code`, `retryable`, `runId`, `toolName`. It does not call `toJSON()`.
    const cloned = structuredClone(error) as unknown as { code?: string; message: string }
    expect(cloned.message).toBe('slow down')
    expect(cloned.code).toBeUndefined()
  })

  it('run:settled projects result.error and nulls it on success', () => {
    const failed = projectEvent(
      envelope('run:settled', {
        runId: 'r1',
        run: RUN,
        result: {
          ok: false,
          runId: 'r1',
          reason: 'error',
          error: new CopilotError('max_attempts'),
          run: RUN,
          restarted: true,
        },
      }),
    ) as { payload: { result: { error: { code: string } } } }
    expect(failed.payload.result.error.code).toBe('max_attempts')

    const ok = projectEvent(
      envelope('run:settled', {
        runId: 'r1',
        run: RUN,
        result: {
          ok: true,
          runId: 'r1',
          output: 'x',
          steps: 1,
          usage: {},
          run: RUN,
          restarted: false,
        },
      }),
    ) as { payload: { result: { error: null } } }
    expect(ok.payload.result.error).toBeNull()
  })

  it('run:settled with an error-less failure projects null, not undefined', () => {
    // `RunResult.error` is `CopilotError | null` — a cancel carries no error.
    const projected = projectEvent(
      envelope('run:settled', {
        runId: 'r1',
        run: RUN,
        result: {
          ok: false,
          runId: 'r1',
          reason: 'cancelled',
          error: null,
          run: RUN,
          restarted: false,
        },
      }),
    ) as { payload: { result: { error: null } } }
    expect(projected.payload.result.error).toBeNull()
  })

  it('run:step projects the error on every failed ToolCall and leaves ok calls alone', () => {
    const projected = projectEvent(
      envelope('run:step', {
        runId: 'r1',
        run: RUN,
        step: 1,
        text: '',
        usage: {},
        finishReason: 'tool-calls',
        calls: [
          { name: 'read_thread', ok: true, input: { threadId: 't1' }, output: null },
          {
            name: 'get_thread_element_html',
            ok: false,
            input: { threadId: 't1' },
            error: new CopilotError('tool_timeout', 'slow', {
              toolName: 'get_thread_element_html',
            }),
          },
        ],
      }),
    ) as { payload: { calls: Array<{ ok: boolean; error?: { code: string; toolName?: string } }> } }

    expect(projected.payload.calls[0]!.ok).toBe(true)
    expect(projected.payload.calls[1]!.error?.code).toBe('tool_timeout')
    expect(projected.payload.calls[1]!.error?.toolName).toBe('get_thread_element_html')
  })

  it('drops everything else — tool:*, runtime:*, error', () => {
    for (const type of ['tool:call', 'tool:result', 'runtime:active', 'runtime:idle', 'error']) {
      expect(projectEvent(envelope(type as CopilotEvent['type'], {}))).toBeNull()
    }
  })

  it('a projected event survives a real port round trip', () => {
    const { a, b } = createPortPair()
    const projected = projectEvent(
      envelope('run:error', {
        runId: 'r1',
        run: RUN,
        error: new CopilotError('provider_error', 'boom'),
        attempt: 1,
        willRetry: false,
      }),
    )
    a.postMessage(projected)
    const received = b.received[0] as { payload: { error: { code: string } } }
    expect(received.payload.error.code).toBe('provider_error')
  })
})

describe('attachRelay', () => {
  const source = () => {
    const listeners = new Set<(event: CopilotEvent) => void>()
    return {
      subscribe(listener: (event: CopilotEvent) => void) {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      emit(event: CopilotEvent) {
        // Snapshot: `attachRelay` unsubscribes from inside its own listener on a dead port.
        // eslint-disable-next-line unicorn/no-useless-spread -- the copy is the point
        for (const listener of [...listeners]) listener(event)
      },
      get size() {
        return listeners.size
      },
    }
  }

  it('forwards projected events and skips dropped ones', () => {
    const { a, b } = createPortPair()
    const bus = source()
    attachRelay(a, bus)
    bus.emit(envelope('run:token', { runId: 'r1', delta: 'he', step: 1 }))
    bus.emit(envelope('tool:call', { runId: 'r1', step: 1, name: 'x', input: {} }))
    bus.emit(
      envelope('run:done', {
        runId: 'r1',
        run: RUN,
        output: 'ok',
        steps: 1,
        usage: {},
        durationMs: 5,
      }),
    )
    expect((b.received as Array<{ type: string }>).map((e) => e.type)).toEqual([
      'run:token',
      'run:done',
    ])
  })

  it('unsubscribes on disconnect so a closed tab stops costing the worker', () => {
    const { a } = createPortPair()
    const bus = source()
    attachRelay(a, bus)
    expect(bus.size).toBe(1)
    a.disconnect()
    expect(bus.size).toBe(0)
  })

  it('a throwing postMessage detaches instead of escaping into the emit loop', () => {
    // The runtime emits synchronously (§3.3.10); a throw here would surface as a
    // `scope: 'listener'` error on an otherwise healthy run.
    const bus = source()
    const port = {
      name: 'copilot-relay',
      postMessage: vi.fn(() => {
        throw new Error('disconnected')
      }),
      disconnect: () => {},
      onMessage: { addListener: () => {}, removeListener: () => {} },
      onDisconnect: { addListener: () => {}, removeListener: () => {} },
    }
    attachRelay(port, bus)
    expect(() =>
      bus.emit(envelope('run:token', { runId: 'r1', delta: 'x', step: 1 })),
    ).not.toThrow()
    expect(bus.size).toBe(0)
    bus.emit(envelope('run:token', { runId: 'r1', delta: 'y', step: 1 }))
    expect(port.postMessage).toHaveBeenCalledTimes(1)
  })

  it('the returned disposer is idempotent', () => {
    const { a } = createPortPair()
    const bus = source()
    const dispose = attachRelay(a, bus)
    dispose()
    dispose()
    expect(bus.size).toBe(0)
  })
})

describe('createRelayClient — (runId, instanceId, seq) dedupe', () => {
  it('accepts each key once', () => {
    const seen: unknown[] = []
    const client = createRelayClient({ onEvent: (event) => seen.push(event) })
    const event = { type: 'run:token', runId: 'r1', seq: 1, instanceId: 'i1', at: 0, payload: {} }
    expect(client.accept(event)).toBe(true)
    expect(client.accept({ ...event })).toBe(false)
    expect(seen).toHaveLength(1)
  })

  it('does NOT collapse two instances of the same run — §3.3.5 run:settled', () => {
    // An SW that owns a run and an options page attached to it each emit their own
    // `run:settled` with their own seq. Deduping on runId alone would drop the second; keying
    // on the instance keeps both, which is what "cross-context uniqueness is the relay's
    // dedupe duty" actually means.
    const seen: Array<{ instanceId: string }> = []
    const client = createRelayClient({ onEvent: (event) => seen.push(event) })
    const base = { type: 'run:settled', runId: 'r1', seq: 4, at: 0, payload: {} }
    expect(client.accept({ ...base, instanceId: 'sw' })).toBe(true)
    expect(client.accept({ ...base, instanceId: 'options' })).toBe(true)
    expect(seen.map((e) => e.instanceId)).toEqual(['sw', 'options'])
    expect(client.streams).toBe(2)
  })

  it('distinguishes two runs from one instance', () => {
    const client = createRelayClient({ onEvent: () => {} })
    const base = { type: 'run:token', seq: 1, instanceId: 'i1', at: 0, payload: {} }
    expect(client.accept({ ...base, runId: 'r1' })).toBe(true)
    expect(client.accept({ ...base, runId: 'r2' })).toBe(true)
    expect(client.streams).toBe(2)
  })

  it('does not merge two event types that arrive at the same seq', () => {
    // §3.3.8 makes `seq` monotonic per run per instance across *all* its events, so this should
    // never happen. The key includes the type anyway: the cost of being wrong in that direction
    // is a duplicate token, and the cost of the other is a silently swallowed terminal.
    const client = createRelayClient({ onEvent: () => {} })
    const base = { runId: 'r1', seq: 7, instanceId: 'i1', at: 0, payload: {} }
    expect(client.accept({ ...base, type: 'run:token' })).toBe(true)
    expect(client.accept({ ...base, type: 'run:settled' })).toBe(true)
    expect(client.accept({ ...base, type: 'run:settled' })).toBe(false)
  })

  it('keeps a null runId from collapsing every instance into one stream', () => {
    const client = createRelayClient({ onEvent: () => {} })
    const base = { type: 'runtime:active', runId: null, seq: 1, at: 0, payload: {} }
    expect(client.accept({ ...base, instanceId: 'a' })).toBe(true)
    expect(client.accept({ ...base, instanceId: 'b' })).toBe(true)
    expect(client.streams).toBe(2)
  })

  it('rejects a non-envelope without throwing', () => {
    const client = createRelayClient({ onEvent: () => {} })
    for (const bad of [null, undefined, 42, 'x', {}, { type: 'run:token' }]) {
      expect(client.accept(bad)).toBe(false)
    }
  })

  it('bounds its key memory and still drops a replayed prefix past the window', () => {
    const seen: number[] = []
    const client = createRelayClient({ cap: 8, onEvent: (event) => seen.push(event.seq) })
    for (let seq = 1; seq <= 40; seq++) {
      client.accept({ type: 'run:token', runId: 'r1', seq, instanceId: 'i1', at: 0, payload: {} })
    }
    expect(seen).toHaveLength(40)
    // seq 1 fell out of the remembered set long ago, but the high-water mark still knows it is
    // not new — an unbounded Set is not the only way to be correct here.
    expect(
      client.accept({
        type: 'run:token',
        runId: 'r1',
        seq: 1,
        instanceId: 'i1',
        at: 0,
        payload: {},
      }),
    ).toBe(false)
  })

  it('reset forgets everything', () => {
    const client = createRelayClient({ onEvent: () => {} })
    const event = { type: 'run:token', runId: 'r1', seq: 1, instanceId: 'i1', at: 0, payload: {} }
    client.accept(event)
    client.reset()
    expect(client.accept(event)).toBe(true)
  })
})

/* ---------------------------------------------------------------------- relay link */

describe('createRelayLink — the page end that was missing', () => {
  const link = (over: Partial<Parameters<typeof createRelayLink>[0]> = {}) => {
    const workerEnds: FakePort[] = []
    const timers: Array<{ run: () => void; ms: number }> = []
    const events: RelayEnvelope[] = []
    const made = createRelayLink({
      runtime: {
        connect: () => {
          const { a, b } = createPortPair()
          workerEnds.push(b)
          return a
        },
      },
      onEvent: (event) => events.push(event),
      setTimeout: (handler, ms) => timers.push({ run: handler, ms }) as unknown as number,
      clearTimeout: () => {},
      ...over,
    })
    return { made, workerEnds, timers, events }
  }

  it('connects only when asked, and disconnects when the work is done', () => {
    const { made, workerEnds } = link()
    expect(made.connected).toBe(false)
    made.want(true)
    expect(made.connected).toBe(true)
    made.want(true) // idempotent — not a second port
    expect(workerEnds).toHaveLength(1)
    made.want(false)
    expect(made.connected).toBe(false)
    expect(workerEnds[0]!.disconnected).toBe(true)
  })

  it('delivers deduped events', () => {
    const { made, workerEnds, events } = link()
    made.want(true)
    const envelope = {
      type: 'run:token',
      runId: 'r1',
      seq: 1,
      instanceId: 'sw',
      at: 1,
      payload: { text: 'hi' },
    }
    workerEnds[0]!.postMessage(envelope)
    workerEnds[0]!.postMessage(envelope) // a replayed tail must not double-render
    expect(events).toHaveLength(1)
  })

  it('reconnects with backoff after the worker dies, and not after a deliberate close', () => {
    const { made, workerEnds, timers } = link()
    made.want(true)
    workerEnds[0]!.disconnect()
    expect(made.connected).toBe(false)
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(RECONNECT_DELAYS[0])
    timers[0]!.run()
    expect(made.connected).toBe(true)
    expect(workerEnds).toHaveLength(2)

    made.want(false)
    workerEnds[1]!.disconnect()
    // Nothing is running any more; reconnecting would hold the worker awake for no reason.
    expect(timers).toHaveLength(1)
  })

  it('survives a runtime that refuses to connect (extension context invalidated)', () => {
    const timers: Array<() => void> = []
    const made = createRelayLink({
      runtime: {
        connect: () => {
          throw new Error('Extension context invalidated')
        },
      },
      onEvent: () => {},
      setTimeout: (handler) => timers.push(handler) as unknown as number,
      clearTimeout: () => {},
    })
    expect(() => made.want(true)).not.toThrow()
    expect(made.connected).toBe(false)
    expect(timers).toHaveLength(1)
    made.destroy()
  })
})
