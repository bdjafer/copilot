/**
 * SPEC-swarm §2.1 (transport and admission) and §7.4 (observability) — the loopback boundary.
 *
 * The named §13 row this file exists for: *"An unpaired page, a rebound DNS `Host`, and a
 * disallowed `Origin` are each refused (4001/4003) — and `POST /pair` **succeeds without
 * `x-swarm-token`** while every other HTTP endpoint but `/healthz` refuses without it (#40)."*
 *
 * Everything here runs against a real socket on an ephemeral port, because a rebound `Host` is a
 * header on a real request and an in-process transport has none.
 */

import { afterEach, describe, expect, it } from 'vitest'

import type { ServerHarness } from './support/server-harness.ts'

import { CLOSE_CODES } from '../src/protocol/constants.ts'
import { defaultServerConfig } from '../src/server/config.ts'
import { CLI_TOKEN_ID, sha256Hex } from '../src/server/tokens.ts'
import { hostAllowed, originAllowed } from '../src/server/ws.ts'
import { createServerHarness, openRawSocket } from './support/server-harness.ts'

let harness: ServerHarness | null = null

afterEach(async () => {
  await harness?.dispose()
  harness = null
})

async function serve(config?: Parameters<typeof createServerHarness>[0]): Promise<ServerHarness> {
  harness = await createServerHarness(config)
  return harness
}

describe('§2.1 the admission table, in its order', () => {
  it('refuses a handshake without the `swarm.v1` subprotocol (HTTP 400, before the upgrade)', async () => {
    const h = await serve()
    const socket = await openRawSocket({
      port: h.port(),
      protocols: [`swarm.tok.${h.token()}`],
    })
    /* A 400 never becomes a WebSocket, so there is no close code to read — only the absence of
     * an open connection and of any frame. */
    expect(socket.frames).toEqual([])
  })

  it('refuses a missing `swarm.tok.<token>` subprotocol with close 4001 (S4 — never a query param)', async () => {
    const h = await serve()
    const socket = await openRawSocket({ port: h.port(), protocols: ['swarm.v1'] })
    const closed = await socket.waitForClose()
    expect(closed.code).toBe(CLOSE_CODES.unauthenticated)
  })

  it('refuses an unknown or revoked token with close 4001', async () => {
    const h = await serve()
    const unknown = await openRawSocket({ port: h.port(), token: 'not-a-token' })
    expect((await unknown.waitForClose()).code).toBe(CLOSE_CODES.unauthenticated)

    const issued = h.server.tokens.issueToken('doomed', 'test')
    expect(h.server.tokens.revoke(issued.tokenId)).toBe(true)
    const revoked = await openRawSocket({ port: h.port(), token: issued.token })
    expect((await revoked.waitForClose()).code).toBe(CLOSE_CODES.unauthenticated)
  })

  it('refuses a rebound DNS `Host` with close 4003 — the only check that notices', async () => {
    const h = await serve()
    const socket = await openRawSocket({
      port: h.port(),
      token: h.token(),
      host: `evil.example.com:${h.port()}`,
    })
    expect((await socket.waitForClose()).code).toBe(CLOSE_CODES.forbidden)
  })

  it('refuses a disallowed `Origin` with close 4003 and admits an allowlisted extension', async () => {
    const h = await serve({ config: { origins: ['chrome-extension://abcdefgh'] } })
    const denied = await openRawSocket({
      port: h.port(),
      token: h.token(),
      origin: 'https://evil.example.com',
    })
    expect((await denied.waitForClose()).code).toBe(CLOSE_CODES.forbidden)

    const allowed = await openRawSocket({
      port: h.port(),
      token: h.token(),
      origin: 'chrome-extension://abcdefgh',
    })
    const hello = await allowed.hello('extension')
    expect(hello.k).toBe('hello_ok')
    allowed.close()
  })

  it('admits an absent `Origin` — a CLI or Node head sends none', async () => {
    const h = await serve()
    const socket = await openRawSocket({ port: h.port(), token: h.token() })
    expect((await socket.hello('cli')).k).toBe('hello_ok')
    socket.close()
  })

  it('echoes exactly `swarm.v1` and never the token subprotocol back', () => {
    /* Echoing `swarm.tok.<token>` would put the credential into the response headers of every
     * handshake, where a proxy log is happy to keep it. */
    expect(hostAllowed('127.0.0.1:7717', 7717)).toBe(true)
    expect(hostAllowed('localhost:7717', 7717)).toBe(true)
    expect(hostAllowed('swarm.internal:7717', 7717)).toBe(false)
    expect(originAllowed(undefined, [])).toBe(true)
    expect(originAllowed('https://evil.test', [])).toBe(false)
    expect(originAllowed('chrome-extension://xyz', ['chrome-extension://xyz'])).toBe(true)
  })

  it('the port-less `Host` forms are refused — §2.1 lists `<authority>:<port>` and nothing else', () => {
    /* A rebound name resolving to loopback on port 80 walked past the one check that defeats DNS
     * rebinding, because `127.0.0.1` and `localhost` were accepted bare. */
    expect(hostAllowed('127.0.0.1', 7717)).toBe(false)
    expect(hostAllowed('localhost', 7717)).toBe(false)
    expect(hostAllowed('[::1]:7717', 7717)).toBe(true)
  })

  it('the origin allowlist is authoritative — loopback is allowed because it is *on* the list', () => {
    /* `originAllowed` used to accept any `http://localhost:*` / `http://127.0.0.1:*` regardless of
     * `config.origins`, which made the allowlist advisory for the whole loopback origin space. */
    expect(originAllowed('http://localhost:5173', [])).toBe(false)
    expect(originAllowed('http://127.0.0.1:5173', [])).toBe(false)
    expect(originAllowed('http://localhost:5173', ['http://localhost:*'])).toBe(true)
    expect(originAllowed('http://localhost', ['http://localhost:*'])).toBe(true)
    expect(originAllowed('http://localhost.evil.test', ['http://localhost:*'])).toBe(false)
  })

  /**
   * The regression a real browser found and no fake could.
   *
   * `origins` shipped with the two loopback entries and nothing else, so a freshly installed
   * extension — the product's *primary* head — sent `Origin: chrome-extension://<id>` to
   * `POST /pair` and got `403 forbidden origin`. There was no first-run route to pairing that did
   * not involve hand-editing `config.json` with an id the user first has to go and look up. The
   * case above covers the mechanism with an explicit id; nothing covered the **default**, which is
   * the only list a first run actually has.
   */
  it('the DEFAULT allowlist admits an extension origin — a head that cannot pair is not a head', () => {
    const { origins } = defaultServerConfig()
    expect(originAllowed('chrome-extension://gciijahjlpkkapcdfmpoanepfadnolgg', origins)).toBe(true)
    /* And the concession is scoped to that one scheme. A web page is still refused, which is the
     * threat the origin check exists for: "any web page in the user's browser reaching a localhost
     * port". */
    expect(originAllowed('https://evil.test', origins)).toBe(false)
    expect(originAllowed('http://evil.test', origins)).toBe(false)
    expect(originAllowed('moz-extension://anything', origins)).toBe(false)
  })

  it('`<scheme>://*` matches any authority on that scheme, and never a bare scheme or another one', () => {
    const list = ['chrome-extension://*']
    expect(originAllowed('chrome-extension://abc', list)).toBe(true)
    expect(originAllowed('chrome-extension://abc/', list)).toBe(true)
    /* No authority at all is not an origin, and must not be admitted by the wildcard. */
    expect(originAllowed('chrome-extension://', list)).toBe(false)
    expect(originAllowed('chrome-extension', list)).toBe(false)
    /* Prefix confusion: a scheme that merely starts the same way is a different scheme. */
    expect(originAllowed('chrome-extension-evil://abc', list)).toBe(false)
    expect(originAllowed('https://chrome-extension://abc', list)).toBe(false)
  })

  it('an unpaired client with a stale `Host` is refused 4001, not 4003 (§2.1s order)', async () => {
    const h = await serve()
    const socket = await openRawSocket({
      port: h.port(),
      protocols: ['swarm.v1'],
      host: `evil.example.com:${h.port()}`,
    })
    /* Protocol → Token → Origin → Host. 4003 is terminal in the client (§2.5 #4) and carries a
     * different fix string, so an unpaired page told "forbidden host" never learns to pair. */
    expect((await socket.waitForClose()).code).toBe(CLOSE_CODES.unauthenticated)
  })
})

describe('§2.1 pairing — the one endpoint that cannot require what it issues', () => {
  it('POST /pair succeeds WITHOUT x-swarm-token and issues a usable token (#40)', async () => {
    const h = await serve()
    const code = h.server.tokens.issuePairingCode()
    const response = await h.http('/pair', {
      method: 'POST',
      headers: { 'x-swarm-client': 'ext/0.1' },
      body: { code: code.code, clientName: 'Chrome', clientKind: 'extension' },
    })
    expect(response.status).toBe(200)
    const issued = response.json as { token: string; tokenId: string }
    expect(typeof issued.token).toBe('string')

    const socket = await openRawSocket({ port: h.port(), token: issued.token })
    expect((await socket.hello('extension')).k).toBe('hello_ok')
    socket.close()
  })

  it('POST /pair still requires `x-swarm-client` — the non-simple-request proof (CSRF)', async () => {
    const h = await serve()
    const code = h.server.tokens.issuePairingCode()
    const response = await h.http('/pair', {
      method: 'POST',
      body: { code: code.code, clientName: 'Chrome', clientKind: 'extension' },
    })
    expect(response.status).toBe(403)
  })

  it('POST /pair refuses a rebound `Host` like every other endpoint', async () => {
    const h = await serve()
    const code = h.server.tokens.issuePairingCode()
    /* Raw, because `fetch` will not set `Host` — and `Host` is the whole of the check. */
    const rebound = await h.raw('/pair', {
      method: 'POST',
      headers: { 'x-swarm-client': 'ext/0.1', host: `evil.example.com:${h.port()}` },
      body: { code: code.code, clientName: 'Chrome', clientKind: 'extension' },
    })
    expect(rebound.status).toBe(403)
    /* The very same request with the literal loopback authority succeeds, so the refusal above
     * is the `Host` check and not the code, the body or the client header. */
    const straight = await h.raw('/pair', {
      method: 'POST',
      headers: { 'x-swarm-client': 'ext/0.1' },
      body: { code: code.code, clientName: 'Chrome', clientKind: 'extension' },
    })
    expect(straight.status).toBe(200)
  })

  it('GET /healthz refuses a rebound `Host` too — token-exempt is not check-exempt', async () => {
    const h = await serve()
    const rebound = await h.raw('/healthz', { headers: { host: 'evil.example.com' } })
    expect(rebound.status).toBe(403)
    expect((await h.raw('/healthz')).status).toBe(200)
  })

  it('a pairing code is single use and dies with the first success', async () => {
    const h = await serve()
    const code = h.server.tokens.issuePairingCode()
    const body = { code: code.code, clientName: 'Chrome', clientKind: 'extension' }
    const headers = { 'x-swarm-client': 'ext/0.1' }
    expect((await h.http('/pair', { method: 'POST', headers, body })).status).toBe(200)
    expect((await h.http('/pair', { method: 'POST', headers, body })).status).toBe(401)
  })

  it('a wrong code burns one of five attempts and the sixth is rate_limited', async () => {
    const h = await serve()
    h.server.tokens.issuePairingCode()
    const headers = { 'x-swarm-client': 'ext/0.1' }
    const wrong = { code: 'AAAAAAAA', clientName: 'Chrome', clientKind: 'extension' }
    for (let i = 0; i < 5; i++) {
      expect((await h.http('/pair', { method: 'POST', headers, body: wrong })).status).toBe(401)
    }
    const spent = await h.http('/pair', { method: 'POST', headers, body: wrong })
    expect(spent.status).toBe(429)
  })

  it('stores only sha256(token) at rest — reading tokens.json grants nothing (S5)', async () => {
    const h = await serve()
    const issued = h.server.tokens.issueToken('a head', 'extension')
    const record = h.server.tokens.list().find((row) => row.tokenId === issued.tokenId)!
    expect(record.hash).toBe(sha256Hex(issued.token))
    expect(JSON.stringify(h.server.tokens.list())).not.toContain(issued.token)
    /* Tokens never expire; they are revoked (S5) — there is no `expiresAt` to read. */
    expect(record).not.toHaveProperty('expiresAt')
    expect(record.revokedAt).toBeNull()
  })

  it('DELETE /pair/:tokenId is token-gated and revokes', async () => {
    const h = await serve()
    const gate = h.token('gate')
    const doomed = h.server.tokens.issueToken('doomed', 'extension')
    const unauthenticated = await h.http(`/pair/${doomed.tokenId}`, {
      method: 'DELETE',
      headers: { 'x-swarm-client': 'ext/0.1' },
    })
    expect(unauthenticated.status).toBe(401)

    const revoked = await h.http(`/pair/${doomed.tokenId}`, {
      method: 'DELETE',
      headers: { 'x-swarm-client': 'ext/0.1', 'x-swarm-token': gate },
    })
    expect(revoked.status).toBe(200)
    expect((revoked.json as { revoked: boolean }).revoked).toBe(true)
  })

  it('writes a 0600 cli-token whose tokenId is fixed at `local-cli` (H10, R13)', async () => {
    const h = await serve()
    const record = h.server.tokens.list().find((row) => row.tokenId === CLI_TOKEN_ID)
    expect(record?.clientKind).toBe('cli')
  })
})

describe('§7.4 observability — loopback, token-gated except /healthz', () => {
  it('GET /healthz needs no token and returns {ok, version} and nothing else', async () => {
    const h = await serve()
    const response = await h.http('/healthz')
    expect(response.status).toBe(200)
    expect(Object.keys(response.json as object).sort()).toEqual(['ok', 'version'])
  })

  it('every other endpoint refuses without `x-swarm-token`', async () => {
    const h = await serve()
    for (const path of ['/readyz', '/metrics', '/debug/streams', '/debug/leases', '/debug/log']) {
      const response = await h.http(path, { headers: { 'x-swarm-client': 'test/0.1' } })
      expect({ path, status: response.status }).toEqual({ path, status: 401 })
    }
  })

  it('serves metrics, streams, leases, log and the retention-exempt audit trail with one', async () => {
    const h = await serve()
    const headers = { 'x-swarm-client': 'test/0.1', 'x-swarm-token': h.token() }

    const metrics = await h.http('/metrics', { headers })
    expect(metrics.status).toBe(200)
    expect(metrics.text).toContain('swarm_backpressure_drops_total')
    expect(metrics.text).toContain('swarm_lease_conflicts_total')
    expect(metrics.text).toContain('swarm_spend_usd')
    expect(metrics.text).toContain('swarm_executor_events_total')

    const streams = await h.http('/debug/streams', { headers })
    expect(streams.status).toBe(200)
    expect(Array.isArray(streams.json)).toBe(true)

    expect((await h.http('/debug/leases', { headers })).status).toBe(200)
    expect((await h.http('/debug/log?stream=fleet&from=0&limit=10', { headers })).status).toBe(200)

    /* §2.3, S13: the audit trail is **not** a stream — it is read here and never through `sub`. */
    expect((await h.http('/debug/audit?from=0&limit=10', { headers })).status).toBe(200)
  })

  it('GET /readyz reports the doctor summary and the version floor', async () => {
    const h = await serve()
    const response = await h.http('/readyz', {
      headers: { 'x-swarm-client': 'test/0.1', 'x-swarm-token': h.token() },
    })
    expect(response.status).toBe(200)
    expect((response.json as { versionFloor: string }).versionFloor).toBe('0.66.0')
  })
})
