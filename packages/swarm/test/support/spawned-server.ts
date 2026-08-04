/**
 * Spawn `swarm serve` as a **child process** (SPEC-swarm §7.1, §13's crash-resume row).
 *
 * Every other server suite embeds the daemon in the test process, which is the right trade for
 * asserting admission or fencing — but it cannot express the two things this helper exists for:
 *
 *  1. **A crash is `SIGKILL`, not `close()`.** An embedded server always gets to run its shutdown
 *     path; a killed one does not. §13 asks for a head that survives *"a mid-turn kill"*, and a
 *     graceful close is not a kill — it flushes, releases leases and writes `runtime.json` on the
 *     way out. Everything the recovery path exists to handle only happens when none of that ran.
 *  2. **The port outlives the process.** A restart the client can reconnect *to* has to come back
 *     on the same address, from the same `$SWARM_HOME`, with the same `swarm.db` and the same
 *     `tokens.json` — which is what makes the token from `POST /pair` still valid afterwards.
 *
 * The child is the real CLI: `src/testing/node/serve-mock.ts` calls `runCli(['serve', …])` and
 * substitutes only the executor.
 *
 * Node ≥ 24; testing-only.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { WebSocket } from 'ws'

import type { ServeMockReady } from '../../src/testing/node/serve-mock.ts'

import { SWARM_SUBPROTOCOL, SWARM_TOKEN_SUBPROTOCOL_PREFIX } from '../../src/protocol/frames.ts'
import { SERVE_MOCK_READY_PREFIX } from '../../src/testing/node/serve-mock.ts'

const ENTRY = resolve(import.meta.dirname, '../../src/testing/node/serve-mock.ts')

export interface SpawnedServer extends ServeMockReady {
  readonly pid: number
  /** Everything the child wrote, for a failure message that says what actually happened. */
  readonly output: readonly string[]
  readonly exited: boolean
  /** `SIGKILL` — the crash. No shutdown path runs. */
  kill(): Promise<void>
  /** `SIGTERM` — the clean stop `serve` handles, which removes the `cli-token`. */
  stop(): Promise<void>
}

export interface SpawnServerOptions {
  readonly home: string
  readonly workspaceRoot: string
  readonly workspaceId?: string
  /** `0` ⇒ ephemeral. Pass the previous port to bring a killed server back where it was. */
  readonly port?: number
  readonly readyTimeoutMs?: number
}

export async function spawnServeMock(options: SpawnServerOptions): Promise<SpawnedServer> {
  const child: ChildProcess = spawn(
    process.execPath,
    [
      ENTRY,
      '--home',
      options.home,
      '--workspace-root',
      options.workspaceRoot,
      '--workspace',
      options.workspaceId ?? 'scratch',
      '--port',
      String(options.port ?? 0),
      '--quiet',
      '1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )

  const output: string[] = []
  let ready: ServeMockReady | null = null
  let settle: ((value: ServeMockReady) => void) | null = null
  let exited = false

  const consume = (chunk: string): void => {
    for (const line of chunk.split('\n')) {
      if (line.length === 0) continue
      output.push(line)
      if (ready !== null || !line.startsWith(SERVE_MOCK_READY_PREFIX)) continue
      ready = JSON.parse(line.slice(SERVE_MOCK_READY_PREFIX.length)) as ServeMockReady
      settle?.(ready)
    }
  }
  child.stdout?.setEncoding('utf8').on('data', consume)
  child.stderr?.setEncoding('utf8').on('data', consume)
  child.once('exit', () => {
    exited = true
  })

  const announced = await Promise.race([
    new Promise<ServeMockReady>((resolveReady) => {
      if (ready !== null) resolveReady(ready)
      else settle = resolveReady
    }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `the spawned server never announced itself:\n${output.join('\n') || '(no output)'}`,
            ),
          ),
        options.readyTimeoutMs ?? 30_000,
      )
      timer.unref?.()
    }),
  ])

  const end = async (signal: 'SIGKILL' | 'SIGTERM'): Promise<void> => {
    if (exited) return
    child.kill(signal)
    await once(child, 'exit')
  }

  return {
    ...announced,
    pid: child.pid ?? -1,
    output,
    get exited() {
      return exited
    },
    kill: () => end('SIGKILL'),
    stop: () => end('SIGTERM'),
  }
}

/**
 * A stand-in for a real unpacked-extension id: 32 letters in `a`–`p`, which is the alphabet Chrome
 * derives an id in. Its exact value is the point — nothing in the shipped config knows it, so a
 * default that admits this request is a default that admits any extension (**[E2]**).
 */
export const EXTENSION_ORIGIN = `chrome-extension://${'abcdefghijklmnop'.repeat(2)}`

/**
 * `POST /pair`, over real HTTP, exactly as the extension does it (§2.1, R15).
 *
 * Two headers, both load-bearing.
 *
 * `x-swarm-client` is what makes the request non-simple and therefore not reachable from a form
 * post, and it is required even though the endpoint is token-exempt. Sending it here rather than
 * letting a helper add it keeps the header a property of the *protocol* in this test rather than
 * a property of the test harness.
 *
 * `Origin` is what makes this claim true at all. Node's `fetch` sends none, so before it was set
 * here every journey took `originAllowed`'s *absent* branch — the CLI path — and "exactly as the
 * extension does it" was the one thing this helper did not do. The shipped `origins` default
 * carries `chrome-extension://*` precisely because a real MV3 head was refused `403: forbidden
 * origin` in Chrome, and the default that fixed it was covered only by unit tests over
 * `originAllowed` with hand-written strings. It is now on the journey's own path.
 */
export async function pair(
  port: number,
  code: string,
  options: {
    clientName?: string
    clientKind?: 'extension' | 'cli' | 'test'
    /** `null` sends no `Origin` at all — the CLI/Node head. */
    origin?: string | null
  } = {},
): Promise<{ status: number; tokenId?: string; token?: string; error?: string }> {
  const origin = options.origin === undefined ? EXTENSION_ORIGIN : options.origin
  const response = await fetch(`http://127.0.0.1:${port}/pair`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-swarm-client': options.clientName ?? 'e2e-journey/0.1',
      ...(origin === null ? {} : { origin }),
    },
    body: JSON.stringify({
      code,
      clientName: options.clientName ?? 'e2e-journey',
      clientKind: options.clientKind ?? 'extension',
    }),
  })
  return { status: response.status, ...((await response.json()) as Record<string, string>) }
}

/**
 * Attempt the `swarm.v1` upgrade with a chosen `Origin`; resolve the close code, or `null` if the
 * connection was still open after `graceMs`.
 *
 * The upgrade is the second door `originAllowed` guards, and `ws` sends no `Origin` of its own —
 * so, like `pair` above, the journey took the *absent* branch and never exercised the header that
 * the shipped `chrome-extension://*` default exists for (**[E2]**).
 *
 * Reading `'open'` as "admitted" would be **wrong**, and wrong in the direction that reports
 * success: §2.1 requires an auth or origin failure to *complete* the upgrade and then close with
 * the numbered code, precisely so the head learns why rather than seeing a bare socket error. A
 * refused handshake therefore opens first. The close code is the only answer.
 */
export function handshakeCloseCode(
  port: number,
  token: string,
  origin: string,
  graceMs = 250,
): Promise<number | null> {
  return new Promise((resolve) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}/swarm`,
      [SWARM_SUBPROTOCOL, `${SWARM_TOKEN_SUBPROTOCOL_PREFIX}${token}`],
      { headers: { origin } },
    )
    let timer: NodeJS.Timeout | null = null
    const settle = (code: number | null): void => {
      if (timer !== null) clearTimeout(timer)
      socket.removeAllListeners()
      socket.close()
      resolve(code)
    }
    socket.on('open', () => {
      timer = setTimeout(() => settle(null), graceMs)
    })
    socket.on('close', (code: number) => settle(code))
    socket.on('error', () => settle(-1))
    socket.on('unexpected-response', () => settle(-1))
  })
}

/** `GET` a token-gated endpoint on the spawned server. */
export async function get(port: number, path: string, token: string): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { 'x-swarm-client': 'e2e-journey/0.1', 'x-swarm-token': token },
  })
  return response.json()
}
