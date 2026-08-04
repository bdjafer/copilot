/**
 * The loopback HTTP surface: pairing and observability (SPEC-swarm §2.1, §7.4).
 *
 * Two exemptions are load-bearing and everything else is token-gated:
 *
 *  - **`POST /pair` is token-exempt** (§2.1, R15) — it is the only way to obtain a token, and
 *    requiring the output as input makes pairing impossible. It still requires `x-swarm-client`
 *    (which makes it a non-simple request, defeating form-post CSRF), a permitted `Origin`, a
 *    literal-IP `Host`, the one-time code, and the rate limiter.
 *  - **`GET /healthz` is token-exempt** because it returns `{ok, version}` and nothing else.
 *
 * `Host` is checked on every endpoint, not only on the upgrade: DNS rebinding does not care which
 * verb it arrives on.
 *
 * Node ≥ 24, server-only.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { AuditRow, LogRecord } from '../log/types.ts'
import type { SwarmServerConfig } from './config.ts'
import type { SwarmEngine } from './engine.ts'
import type { TokenStore } from './tokens.ts'
import type { SwarmConnection } from './ws.ts'

import { SwarmError } from '../errors.ts'
import { hostAllowed, originAllowed } from './ws.ts'

export interface HttpContext {
  readonly engine: SwarmEngine
  readonly tokens: TokenStore
  readonly config: SwarmServerConfig
  readonly version: string
  readonly port: () => number
  readonly connections: () => readonly SwarmConnection[]
}

/** Endpoints that do not require `x-swarm-token` (§2.1, §7.4). */
const TOKEN_EXEMPT = new Set(['POST /pair', 'GET /healthz'])

export function createHttpHandler(
  context: HttpContext,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void handle(context, req, res).catch((error: unknown) => {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  }
}

async function handle(
  context: HttpContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const route = `${req.method ?? 'GET'} ${url.pathname}`
  const port = context.port()

  /* Defeats DNS rebinding on every verb, not only on the upgrade (§2.1). */
  if (!hostAllowed(req.headers.host, port)) {
    send(res, 403, { error: 'forbidden host' })
    return
  }
  const origin = firstHeader(req.headers.origin)
  if (!originAllowed(origin, context.config.origins)) {
    send(res, 403, { error: 'forbidden origin' })
    return
  }

  const exempt = TOKEN_EXEMPT.has(route) || route.startsWith('GET /healthz')
  if (!exempt) {
    const token = firstHeader(req.headers['x-swarm-token'])
    const client = firstHeader(req.headers['x-swarm-client'])
    if (client === undefined) {
      send(res, 403, { error: 'x-swarm-client is required' })
      return
    }
    if (token === undefined || context.tokens.verify(token) === null) {
      send(res, 401, { error: 'unauthenticated' })
      return
    }
  }

  switch (true) {
    case route === 'GET /healthz':
      send(res, 200, { ok: true, version: context.version })
      return

    case route === 'GET /readyz': {
      const health = await context.engine.health()
      const ready = health.executor.ok && health.server.ok
      send(res, ready ? 200 : 503, {
        ok: ready,
        versionFloor: context.config.executor.versionFloor,
        blocked: health.executor.blocked,
        fix: health.executor.fix,
        routes: health.routes.filter((route_) => route_.available).length,
      })
      return
    }

    case route === 'POST /pair': {
      /* `x-swarm-client` is still required: it is what makes this a non-simple request. */
      const client = firstHeader(req.headers['x-swarm-client'])
      if (client === undefined) {
        send(res, 403, { error: 'x-swarm-client is required' })
        return
      }
      const body = (await readJson(req)) as {
        code?: string
        clientName?: string
        clientKind?: 'extension' | 'cli' | 'test'
      }
      try {
        const issued = context.tokens.pair({
          code: String(body.code ?? ''),
          clientName: String(body.clientName ?? 'unnamed'),
          clientKind: body.clientKind ?? 'extension',
          /* §2.1 rate-limits "20 per minute **per connection**". `remoteAddress` alone is
           * `127.0.0.1` for every loopback head, so one noisy CLI spent the budget of every
           * browser on the machine; the remote port is what makes the key a connection. */
          connectionId: `${req.socket.remoteAddress ?? 'local'}:${req.socket.remotePort ?? 0}`,
        })
        send(res, 200, issued)
      } catch (error) {
        const swarm = SwarmError.is(error) ? error : new SwarmError('internal', String(error))
        send(res, swarm.code === 'rate_limited' ? 429 : 401, swarm.toJSON())
      }
      return
    }

    case req.method === 'DELETE' && url.pathname.startsWith('/pair/'): {
      const tokenId = url.pathname.slice('/pair/'.length)
      send(res, 200, { revoked: context.tokens.revoke(tokenId) })
      return
    }

    case route === 'GET /metrics': {
      send(res, 200, metrics(context), 'text/plain; version=0.0.4')
      return
    }

    case route === 'GET /debug/streams': {
      const heads = context.engine.store.read((tx) => tx.heads())
      const subscribers = new Map<string, number>()
      for (const connection of context.connections()) {
        for (const stream of connection.streams) {
          subscribers.set(stream.stream, (subscribers.get(stream.stream) ?? 0) + 1)
        }
      }
      send(
        res,
        200,
        heads.map((row) => ({
          ...row,
          subscribers: subscribers.get(row.stream) ?? 0,
          lag: row.head - row.floor,
        })),
      )
      return
    }

    case route === 'GET /debug/leases': {
      send(
        res,
        200,
        context.engine.store.read((tx) => tx.listLeases()),
      )
      return
    }

    case route === 'GET /debug/log': {
      const stream = url.searchParams.get('stream') ?? 'fleet'
      const from = Number(url.searchParams.get('from') ?? 0)
      const limit = Math.min(1000, Number(url.searchParams.get('limit') ?? 100))
      const rows: readonly LogRecord[] = context.engine.store.read((tx) =>
        tx.readLog(stream as LogRecord['stream'], from, limit),
      )
      send(res, 200, rows)
      return
    }

    case route === 'GET /debug/audit': {
      /* The retention-exempt trail (§2.3, S13, Q20) — read here, never through `sub`. */
      const from = Number(url.searchParams.get('from') ?? 0)
      const limit = Math.min(1000, Number(url.searchParams.get('limit') ?? 100))
      const rows: readonly AuditRow[] = context.engine.store.read((tx) => tx.readAudit(from, limit))
      send(res, 200, rows)
      return
    }

    default:
      send(res, 404, { error: 'not found' })
  }
}

function metrics(context: HttpContext): string {
  const store = context.engine.store
  const lines: string[] = []
  const byState = new Map<string, number>()
  const byDelivery = new Map<string, number>()
  let spend = 0
  store.read((tx) => {
    for (const stored of tx.listRecords<{ state: string; spend: { estUsd: number } }>(
      'delegation',
    )) {
      byState.set(stored.value.state, (byState.get(stored.value.state) ?? 0) + 1)
      spend += stored.value.spend.estUsd
    }
    for (const stored of tx.listRecords<{ delivery: string }>('turn')) {
      byDelivery.set(stored.value.delivery, (byDelivery.get(stored.value.delivery) ?? 0) + 1)
    }
    for (const head of tx.heads()) {
      lines.push(`swarm_stream_head{stream="${head.stream}"} ${head.head}`)
    }
  })
  for (const [state, count] of byState) lines.push(`swarm_delegations{state="${state}"} ${count}`)
  for (const [delivery, count] of byDelivery) {
    lines.push(`swarm_turns_total{delivery="${delivery}"} ${count}`)
  }
  let drops = 0
  for (const connection of context.connections()) drops += connection.counters.dropped
  lines.push(`swarm_backpressure_drops_total ${drops}`)
  /* Three of these used to be inventions: `swarm_lease_conflicts_total` reported per-connection
   * *frame* errors, and the other two were hard-coded `0`. A metric that reports a different
   * quantity under a metric's name is worse than a missing metric — it is the one a responder
   * trusts at 3 a.m. The engine counts all three at their source (§7.4). */
  const observed = context.engine.metrics()
  lines.push(`swarm_lease_conflicts_total ${observed.leaseConflicts}`)
  lines.push(`swarm_spend_usd ${spend}`)
  lines.push(`swarm_log_write_seconds ${(observed.logWriteMs / 1000).toFixed(6)}`)
  const kinds = Object.entries(observed.executorEvents)
  let total = 0
  for (const [kind, count] of kinds) {
    total += count
    lines.push(`swarm_executor_events_total{kind="${kind}"} ${count}`)
  }
  /* The family is always present: a missing series and a zero series read very differently on a
   * dashboard, and only one of them is true here. */
  lines.push(`swarm_executor_events_total{kind="all"} ${total}`)
  return `${lines.join('\n')}\n`
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    bytes += buffer.length
    /* A pairing body is a code and two names; anything larger is not a pairing body. */
    if (bytes > 64 * 1024) throw new SwarmError('frame_too_large', 'request body is too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new SwarmError('invalid_spec', 'request body is not JSON')
  }
}

function send(res: ServerResponse, status: number, body: unknown, contentType?: string): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'content-type': contentType ?? 'application/json',
    'cache-control': 'no-store',
  })
  res.end(text)
}
