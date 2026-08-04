/**
 * The head's wiring: the token store, `POST /pair`, the socket transport, and the one clause of
 * the §2.5 reconnect contract that is the *head's* business rather than the client core's.
 *
 * The division of labour is the thing under test. The core owns reconnect entirely — backoff,
 * `from:'snapshot'` vs `from:<seq>`, the idempotent re-send — and this head re-implements none of
 * it; what it owns is the **credential**: load it, connect with it, and drop it the moment the
 * server says it is no longer valid. `4001` is the only close code that reaches that decision,
 * because it is the only one a reconnect can never fix and the only one whose remedy is a human
 * with a fresh pairing code. `4003` and `4004` are terminal too and are deliberately *not* treated
 * as revocations: a misconfigured dev origin must not cost the user their token.
 */

import type { ClientFrame, ServerFrame } from '@astrale-os/swarm'

import { encodeFrame } from '@astrale-os/swarm'
import { makeFleetSnapshot, makeServerSnapshot } from '@astrale-os/swarm/testing'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { normalizePairingCode, pairSwarm } from '../src/swarm/pairing.ts'
import { createSwarmHeadSession } from '../src/swarm/session.ts'
import {
  createSwarmTokenStore,
  normalizeEndpoint,
  swarmSocketUrl,
  SWARM_TOKEN_KEY,
} from '../src/swarm/token.ts'
import { createFakeStorage } from './support/fake-chrome.ts'
import { createFakeFetch, createFakeSockets } from './support/fake-socket.ts'

afterEach(() => {
  vi.useRealTimers()
})

const PAIRING = {
  endpoint: 'http://127.0.0.1:7717',
  token: 'tok-secret',
  tokenId: 'tk1',
  clientName: 'head',
  issuedAt: 5,
}

function frames(sent: readonly string[]): ClientFrame[] {
  return sent.map((text) => JSON.parse(text) as ClientFrame)
}

function serverFrame(frame: ServerFrame): string {
  return encodeFrame(frame)
}

function helloOk(serverVersion = '0.1.0'): string {
  return serverFrame({
    p: 'swarm',
    v: 1,
    k: 'hello_ok',
    server: 'swarm',
    serverVersion,
    connectionId: 'c1',
    capabilities: [],
    serverTimeMs: 1,
  })
}

describe('the token store', () => {
  it('round-trips a pairing and clears it', async () => {
    const storage = createFakeStorage()
    const tokens = createSwarmTokenStore(storage.local)

    expect(await tokens.read()).toBeNull()
    await tokens.write(PAIRING)
    expect(await tokens.read()).toEqual(PAIRING)
    expect(Object.keys(storage.dump())).toEqual([SWARM_TOKEN_KEY])

    await tokens.clear()
    expect(await tokens.read()).toBeNull()
  })

  it('reads a malformed record as unpaired rather than throwing on the first frame', async () => {
    const storage = createFakeStorage()
    await storage.local.set({ [SWARM_TOKEN_KEY]: { endpoint: 'x' } })
    expect(await createSwarmTokenStore(storage.local).read()).toBeNull()
  })

  it('derives the socket URL from the endpoint, and never takes one as configuration', () => {
    expect(swarmSocketUrl('http://127.0.0.1:7717')).toBe('ws://127.0.0.1:7717/swarm')
    expect(swarmSocketUrl('https://127.0.0.1:7717')).toBe('wss://127.0.0.1:7717/swarm')
    // A path, a query and a fragment are all dropped: the path is the protocol's, not the user's.
    expect(swarmSocketUrl('http://127.0.0.1:7717/x?y=1#z')).toBe('ws://127.0.0.1:7717/swarm')
  })

  it('normalizes what a human types into an origin', () => {
    expect(normalizeEndpoint('127.0.0.1:7717')).toBe('http://127.0.0.1:7717')
    expect(normalizeEndpoint(' http://127.0.0.1:7717/ ')).toBe('http://127.0.0.1:7717')
  })
})

describe('POST /pair', () => {
  it('sends the client header, the stripped code and the extension kind', async () => {
    const fetcher = createFakeFetch()
    fetcher.reply({ body: { token: 'tok', tokenId: 'tk', issuedAt: 9 } })

    const result = await pairSwarm(fetcher.fetch, {
      endpoint: '127.0.0.1:7717',
      code: 'k7qf-2m9x',
      clientName: 'head',
    })

    expect(result.ok).toBe(true)
    const call = fetcher.calls[0]!
    expect(call.url).toBe('http://127.0.0.1:7717/pair')
    // `/pair` is token-exempt but client-header-required: this header IS the CSRF defence (§2.1).
    expect(call.headers['x-swarm-client']).toBe('head')
    expect(call.body).toEqual({ code: 'K7QF2M9X', clientName: 'head', clientKind: 'extension' })
    if (result.ok) expect(result.pairing.token).toBe('tok')
  })

  it('normalizes the printed dash rather than spending one of the five attempts on it', () => {
    expect(normalizePairingCode('k7qf-2m9x')).toBe('K7QF2M9X')
  })

  it('resolves every failure — a screen must render a sentence, never catch an exception', async () => {
    const cases = [
      { status: 401, reason: 'bad-code' },
      { status: 429, reason: 'rate-limited' },
      { status: 500, reason: 'bad-response' },
    ] as const
    for (const { status, reason } of cases) {
      const fetcher = createFakeFetch()
      fetcher.reply({ ok: false, status, body: { message: 'nope' } })
      const result = await pairSwarm(fetcher.fetch, {
        endpoint: 'http://127.0.0.1:7717',
        code: 'AAAA1111',
        clientName: 'head',
      })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toBe(reason)
    }
  })

  it('reports a dead server as unreachable with the fix in the sentence', async () => {
    const fetcher = createFakeFetch()
    fetcher.fail(new Error('ECONNREFUSED'))
    const result = await pairSwarm(fetcher.fetch, {
      endpoint: 'http://127.0.0.1:7717',
      code: 'AAAA1111',
      clientName: 'head',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('unreachable')
      expect(result.detail).toContain('swarm serve')
    }
  })

  it('refuses a 200 that carries no token', async () => {
    const fetcher = createFakeFetch()
    fetcher.reply({ body: { tokenId: 'tk' } })
    const result = await pairSwarm(fetcher.fetch, {
      endpoint: 'http://127.0.0.1:7717',
      code: 'AAAA1111',
      clientName: 'head',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('bad-response')
  })
})

describe('the head session', () => {
  const build = () => {
    const storage = createFakeStorage()
    const fetcher = createFakeFetch()
    const sockets = createFakeSockets()
    const session = createSwarmHeadSession({
      storage: storage.local,
      fetch: fetcher.fetch,
      webSocket: sockets.factory,
      clientName: 'head',
      now: () => 5,
    })
    return { storage, fetcher, sockets, session }
  }

  it('starts unpaired with no token, and opens no socket', async () => {
    const { session, sockets } = build()
    await session.start()
    expect(session.state.get().phase).toBe('unpaired')
    expect(session.client.get()).toBeNull()
    expect(sockets.sockets).toHaveLength(0)
  })

  it('connects with the token in the subprotocol list, never in the URL (S4)', async () => {
    const { session, sockets, storage } = build()
    await storage.local.set({ [SWARM_TOKEN_KEY]: PAIRING })
    await session.start()

    expect(session.state.get().phase).toBe('live')
    const socket = sockets.last()!
    expect(socket.url).toBe('ws://127.0.0.1:7717/swarm')
    expect(socket.protocols).toEqual(['swarm.v1', 'swarm.tok.tok-secret'])
    expect(socket.url).not.toContain('tok-secret')
  })

  it('sends `hello` as the first client frame — anything else closes 4004 (§2.2)', async () => {
    const { session, sockets, storage } = build()
    await storage.local.set({ [SWARM_TOKEN_KEY]: PAIRING })
    await session.start()
    const socket = sockets.last()!
    socket.open()

    const first = frames(socket.sent)[0]!
    expect(first.k).toBe('hello')
    if (first.k === 'hello') expect(first.head).toBe('extension')
  })

  it('pairs, persists the token and connects in one pass', async () => {
    const { session, sockets, storage, fetcher } = build()
    fetcher.reply({ body: { token: 'fresh', tokenId: 'tk9' } })

    const result = await session.pair({
      endpoint: '127.0.0.1:7717',
      code: 'AAAA-1111',
      clientName: 'head',
    })

    expect(result.ok).toBe(true)
    expect(storage.dump()[SWARM_TOKEN_KEY]).toMatchObject({ token: 'fresh', tokenId: 'tk9' })
    expect(session.state.get()).toMatchObject({ phase: 'live', tokenId: 'tk9' })
    expect(sockets.last()!.protocols[1]).toBe('swarm.tok.fresh')
  })

  it('keeps the pairing screen and the reason when the code is refused', async () => {
    const { session, fetcher, sockets } = build()
    fetcher.reply({ ok: false, status: 401, body: { message: 'expired' } })

    await session.pair({ endpoint: '127.0.0.1:7717', code: 'AAAA1111', clientName: 'head' })

    expect(session.state.get().phase).toBe('unpaired')
    expect(session.state.get().error).toBe('expired')
    expect(sockets.sockets).toHaveLength(0)
  })

  it('drops the token on 4001 — the one close a reconnect can never fix', async () => {
    const { session, sockets, storage } = build()
    await storage.local.set({ [SWARM_TOKEN_KEY]: PAIRING })
    await session.start()

    sockets.last()!.serverClose(4001, 'unauthenticated')
    await Promise.resolve()
    await Promise.resolve()

    expect(storage.dump()[SWARM_TOKEN_KEY]).toBeUndefined()
    expect(session.state.get().phase).toBe('unpaired')
    expect(session.state.get().error).toContain('pair again')
    expect(session.client.get()).toBeNull()
  })

  it('keeps the token on 4003 — a forbidden origin is a wiring fault, not a revocation', async () => {
    const { session, sockets, storage } = build()
    await storage.local.set({ [SWARM_TOKEN_KEY]: PAIRING })
    await session.start()

    sockets.last()!.serverClose(4003, 'forbidden')
    await Promise.resolve()
    await Promise.resolve()

    expect(storage.dump()[SWARM_TOKEN_KEY]).toMatchObject({ token: 'tok-secret' })
    expect(session.state.get().phase).toBe('live')
  })

  it('unpairs locally: token gone, client torn down, pairing screen back', async () => {
    const { session, storage } = build()
    await storage.local.set({ [SWARM_TOKEN_KEY]: PAIRING })
    await session.start()

    await session.unpair()

    expect(storage.dump()[SWARM_TOKEN_KEY]).toBeUndefined()
    expect(session.client.get()).toBeNull()
    expect(session.state.get().phase).toBe('unpaired')
  })
})

describe('reconnect and resume — the core owns the ladder, the head owns nothing', () => {
  it('opens a NEW socket per attempt and resumes each stream from its last seq', async () => {
    vi.useFakeTimers()
    const storage = createFakeStorage()
    const sockets = createFakeSockets()
    const session = createSwarmHeadSession({
      storage: storage.local,
      fetch: createFakeFetch().fetch,
      webSocket: sockets.factory,
      clientName: 'head',
    })
    await storage.local.set({ [SWARM_TOKEN_KEY]: PAIRING })
    await session.start()

    const first = sockets.last()!
    first.open()
    first.message(helloOk())

    const subs = frames(first.sent).filter((frame) => frame.k === 'sub')
    // §2.5 rule 2: `server` before `fleet` — attention before transcripts.
    expect(subs.map((frame) => (frame.k === 'sub' ? frame.stream : ''))).toEqual([
      'server',
      'fleet',
    ])
    expect(subs.every((frame) => frame.k === 'sub' && frame.from === 'snapshot')).toBe(true)

    for (const [id, stream, state] of [
      [1, 'server', makeServerSnapshot()],
      [2, 'fleet', makeFleetSnapshot()],
    ] as const) {
      first.message(serverFrame({ p: 'swarm', v: 1, k: 'snap', id, stream, seq: 4, state }))
    }

    // A drop that is NOT terminal: the ladder runs and the transport must build a fresh socket —
    // a transport that reused a closed one would reconnect exactly once, silently, forever after.
    first.serverClose(1006, 'gone')
    expect(sockets.sockets).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets.sockets.length).toBeGreaterThan(1)

    const second = sockets.last()!
    second.open()
    second.message(helloOk())

    const resumed = frames(second.sent).filter((frame) => frame.k === 'sub')
    expect(resumed.map((frame) => (frame.k === 'sub' ? frame.from : null))).toEqual([4, 4])
    session.destroy()
  })

  it('a changed serverVersion forces every stream back to a snapshot (X14)', async () => {
    vi.useFakeTimers()
    const storage = createFakeStorage()
    const sockets = createFakeSockets()
    const session = createSwarmHeadSession({
      storage: storage.local,
      fetch: createFakeFetch().fetch,
      webSocket: sockets.factory,
      clientName: 'head',
    })
    await storage.local.set({ [SWARM_TOKEN_KEY]: PAIRING })
    await session.start()

    const first = sockets.last()!
    first.open()
    first.message(helloOk('0.1.0'))
    first.message(
      serverFrame({
        p: 'swarm',
        v: 1,
        k: 'snap',
        id: 1,
        stream: 'server',
        seq: 7,
        state: makeServerSnapshot(),
      }),
    )
    first.serverClose(1006)
    await vi.advanceTimersByTimeAsync(1000)

    const second = sockets.last()!
    second.open()
    second.message(helloOk('0.2.0'))

    const resumed = frames(second.sent).filter((frame) => frame.k === 'sub')
    expect(resumed.every((frame) => frame.k === 'sub' && frame.from === 'snapshot')).toBe(true)
    session.destroy()
  })
})
