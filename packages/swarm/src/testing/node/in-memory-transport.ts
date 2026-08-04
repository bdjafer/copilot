/**
 * `createInMemoryTransport()` and `createTestServer()` (SPEC-swarm §1.1, §7.1).
 *
 * A head against a **real embedded server**: the same `SwarmConnection`, the same admission, the
 * same frames, the same durable store. Nothing is stubbed except the socket.
 *
 * §7.1 rules on how much that proves, and the ruling is worth repeating where the convenience
 * lives: *"proving H10 only in-process proves that the client core can be called from Node, which
 * was never in doubt; proving it over the wire proves the server is a server."* So this is a test
 * convenience, and §13's CLI row is satisfied only by the WebSocket run beside it.
 *
 * Node ≥ 24; testing-only.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { DeepPartialConfig, SwarmServerConfig } from '../../server/config.ts'
import type { ExecutorAdapter } from '../../server/executor/types.ts'
import type { SwarmServer } from '../../server/server.ts'
import type { SwarmTransport, Verifier } from '../../types.ts'

import { defaultServerConfig } from '../../server/config.ts'
import { createInProcessTransport } from '../../server/in-process.ts'
import { createSwarmServer } from '../../server/server.ts'
import { MockExecutor } from '../mock-executor.ts'

export interface InMemoryTransportOptions {
  readonly server: SwarmServer
  /** Omitted ⇒ a fresh token is issued, exactly as a paired head would hold one. */
  readonly token?: string
}

export function createInMemoryTransport(options: InMemoryTransportOptions): SwarmTransport {
  const token = options.token ?? options.server.tokens.issueToken('in-memory head', 'test').token
  return createInProcessTransport({ server: options.server, token })
}

export interface TestServerOptions {
  readonly adapter?: ExecutorAdapter
  readonly config?: DeepPartialConfig
  readonly verifier?: Verifier
  readonly now?: () => number
  readonly ids?: () => string
  /** Default `false`: the scheduler is driven by explicit `engine.tick()` calls in tests. */
  readonly autoTick?: boolean
  /** Default `true`: bind a real socket so a WebSocket head can be driven against it. */
  readonly listen?: boolean
}

export interface TestServer {
  readonly server: SwarmServer
  readonly config: SwarmServerConfig
  readonly home: string
  readonly adapter: ExecutorAdapter
  port(): number
  /** A paired token, as `POST /pair` would have issued. */
  token(name?: string): string
  dispose(): Promise<void>
}

/**
 * A server on an **ephemeral port** with a temp `$SWARM_HOME` and a `:memory:` store. Port `0` is
 * §2.1's own answer to "what if 7717 is taken", and the resolved value is what `runtime.json`
 * records — so a test binds a real socket without owning a fixed port.
 */
export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const home = mkdtempSync(join(tmpdir(), 'swarm-home-'))
  const adapter = options.adapter ?? new MockExecutor()
  const config = defaultServerConfig({ port: 0, ...options.config })
  const server = await createSwarmServer({
    config,
    adapter,
    swarmHome: home,
    dbPath: ':memory:',
    autoTick: options.autoTick ?? false,
    ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.ids === undefined ? {} : { ids: options.ids }),
  })
  if (options.listen !== false) await server.listen()

  return {
    server,
    config,
    home,
    adapter,
    port: () => server.port(),
    token: (name = 'test head') => server.tokens.issueToken(name, 'test').token,
    async dispose(): Promise<void> {
      await server.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}
