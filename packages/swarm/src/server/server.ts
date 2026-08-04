/**
 * `createSwarmServer` — the composition root (SPEC-swarm §2.1, §7.1, §7.2, §7.4).
 *
 * `serve` is the daemon, and **every other CLI verb is a head over the identical client core**
 * (H10, §7.1). That is only true if this is a real server: it binds `127.0.0.1`, speaks
 * `swarm.v1` over WebSocket, writes a `cli-token` so the CLI can authenticate against it like any
 * other head (R13), and prints a pairing code for the extension.
 *
 * **Local-only by construction** (Q13, S1): binding to anything but `127.0.0.1`/`::1` requires
 * `--unsafe-bind` and prints a persistent warning, and the `Host` check refuses a rebound DNS name
 * on every endpoint including the upgrade.
 *
 * Node ≥ 24, server-only.
 */

import type { AddressInfo } from 'node:net'

import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'

import type { CommitResult } from '../log/types.ts'
import type { Verifier } from '../types.ts'
import type { SwarmServerConfig } from './config.ts'
import type { ExecutorAdapter } from './executor/types.ts'
import type { TokenRecord } from './tokens.ts'

import { CLOSE_CODES } from '../protocol/constants.ts'
import { ensureSwarmHome, swarmHomeLayout, writeRuntimeFile } from './config.ts'
import { SwarmEngine } from './engine.ts'
import { createHttpHandler } from './http.ts'
import { createSqliteStore } from './store.ts'
import { TokenStore } from './tokens.ts'
import { WorkspaceGuard } from './workspace.ts'
import { admit, SwarmConnection } from './ws.ts'

export interface CreateSwarmServerOptions {
  readonly config: SwarmServerConfig
  readonly adapter: ExecutorAdapter
  readonly swarmHome: string
  readonly version?: string
  readonly verifier?: Verifier
  readonly now?: () => number
  readonly ids?: () => string
  /** S1: anything but a loopback bind requires this **and** prints a persistent warning. */
  readonly unsafeBind?: boolean
  /** `false` in tests — the scheduler and heartbeats are then driven explicitly. */
  readonly autoTick?: boolean
  /** `':memory:'` in tests; production opens `$SWARM_HOME/swarm.db`. */
  readonly dbPath?: string
  readonly onWarning?: (message: string) => void
}

export interface SwarmServer {
  readonly engine: SwarmEngine
  readonly tokens: TokenStore
  readonly guard: WorkspaceGuard
  readonly bootId: string
  /** The bound port; `0` in the config means ephemeral, and this is the resolved value. */
  port(): number
  url(): string
  connections(): readonly SwarmConnection[]
  listen(): Promise<number>
  close(): Promise<void>
}

export async function createSwarmServer(options: CreateSwarmServerOptions): Promise<SwarmServer> {
  const layout = swarmHomeLayout(options.swarmHome)
  ensureSwarmHome(layout)

  const version = options.version ?? '0.1.0'
  const bootId = randomUUID()
  const store = createSqliteStore(options.dbPath ?? layout.dbPath, {
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const tokens = new TokenStore({
    path: layout.tokensPath,
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  const guard = new WorkspaceGuard(options.config.workspaces)
  const engine = new SwarmEngine({
    store,
    config: options.config,
    adapter: options.adapter,
    guard,
    layout,
    version,
    bootId,
    ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ids === undefined ? {} : { ids: options.ids }),
    ...(options.autoTick === undefined ? {} : { autoTick: options.autoTick }),
  })

  const connections = new Set<SwarmConnection>()
  let boundPort = options.config.port

  const http: Server = createServer(
    createHttpHandler({
      engine,
      tokens,
      config: options.config,
      version,
      port: () => boundPort,
      connections: () => [...connections],
    }),
  )
  const wss = new WebSocketServer({ noServer: true })

  /**
   * Fan-out. Every committed log record is offered to every connection, which decides for itself
   * whether it is subscribed — the connection holds a cursor and nothing more, so a head that
   * disconnects mid-fan-out leaves nothing behind to clean up (§2.3).
   */
  const unsubscribe = store.onCommit((result: CommitResult<unknown>) => {
    for (const record of result.emitted) {
      for (const connection of connections) connection.deliver(record)
    }
  })

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/swarm') {
      socket.destroy()
      return
    }
    const protocols = (req.headers['sec-websocket-protocol'] ?? '')
      .toString()
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0)

    const outcome = admit({
      protocols,
      origin: headerOf(req.headers.origin),
      host: headerOf(req.headers.host),
      port: boundPort,
      allowedOrigins: options.config.origins,
      verify: (token) => tokens.verify(token),
    })

    if (!outcome.ok) {
      /* §2.1: a protocol mismatch is HTTP 400 before the upgrade; an auth or origin failure
       * completes the upgrade and closes with the numbered code, so the head learns *why*. */
      if (outcome.httpStatus === 400) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(outcome.close, outcome.reason)
      })
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      attach(ws, outcome.token)
    })
  })

  function attach(ws: WebSocket, token: TokenRecord): void {
    const connection = new SwarmConnection({
      id: randomUUID(),
      socket: {
        send: (text) => ws.send(text),
        close: (code, reason) => ws.close(code, reason),
        bufferedAmount: () => ws.bufferedAmount,
      },
      engine,
      token,
      serverVersion: version,
      ...(options.now === undefined ? {} : { now: options.now }),
    })
    connections.add(connection)
    ws.on('message', (data) => {
      void connection.receive(data.toString())
    })
    ws.on('close', () => {
      connections.delete(connection)
    })
    ws.on('error', () => {
      connections.delete(connection)
    })
  }

  const server: SwarmServer = {
    engine,
    tokens,
    guard,
    bootId,
    port: () => boundPort,
    url: () => `ws://127.0.0.1:${boundPort}/swarm`,
    connections: () => [...connections],

    listen(): Promise<number> {
      const bind = options.unsafeBind === true ? '0.0.0.0' : '127.0.0.1'
      if (options.unsafeBind === true) {
        options.onWarning?.(
          'swarm is bound to 0.0.0.0 — every process on your network can reach this fleet (S1)',
        )
      }
      return new Promise((resolve, reject) => {
        http.once('error', reject)
        http.listen(options.config.port, bind, () => {
          const address = http.address() as AddressInfo | null
          boundPort = address?.port ?? options.config.port
          /* R13: `pgid` and `daemonPid` are re-read after a restart, so a reclaimed instance is
           * still killable — which is why they live in `runtime.json` and not only in memory. */
          writeRuntimeFile(layout.runtimePath, {
            pid: process.pid,
            port: boundPort,
            bootId,
            startedAt: Date.now(),
            version,
            instances: [],
          })
          /* H10: a fresh CLI token on every start, deleted on clean shutdown (§2.1). */
          tokens.writeCliToken(layout.cliTokenPath)
          resolve(boundPort)
        })
      })
    },

    async close(): Promise<void> {
      for (const connection of connections) connection.shutdown(1_000)
      connections.clear()
      unsubscribe()
      await engine.close()
      wss.close()
      await new Promise<void>((resolve) => http.close(() => resolve()))
      TokenStore.removeCliToken(layout.cliTokenPath)
      store.close()
    },
  }

  return server
}

function headerOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export { CLOSE_CODES }
