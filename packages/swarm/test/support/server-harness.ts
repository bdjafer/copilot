/**
 * Test support for the server suites: a scratch git workspace, an embedded `swarm serve`, and a
 * raw `swarm.v1` client socket.
 *
 * Two choices here are deliberate rather than convenient.
 *
 *  1. **A real git repository, not a stub.** `createDelegation` resolves `baseRef` with
 *     `git rev-parse --verify <ref>^{commit}` inside its own transaction (C4b) and refuses an
 *     unresolvable ref with `base_unresolvable`; the workspace guard asserts the root *is* a
 *     repository (S6). A fake root would make both checks vacuous, and they are two of the
 *     named tests of §13.
 *  2. **A raw socket, not the client core.** §7.1: "proving H10 only in-process proves that the
 *     client core can be called from Node, which was never in doubt; proving it over the wire
 *     proves the server is a server." A hand-written frame reader also lets a test send frames a
 *     correct client never would — `sub` before `hello`, an unknown `k`, a 2 MiB frame.
 *
 * Node ≥ 24; testing-only.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

import type { ClientFrame, ServerFrame } from '../../src/protocol/frames.ts'
import type { DeepPartialConfig, WorkspaceRegistration } from '../../src/server/config.ts'
import type { ExecutorAdapter } from '../../src/server/executor/types.ts'
import type { SwarmServer } from '../../src/server/server.ts'
import type { CreateDelegationInput, DelegationSpec, Verifier } from '../../src/types.ts'

import { defaultServerConfig } from '../../src/server/config.ts'
import { createSwarmServer } from '../../src/server/server.ts'
import { MockExecutor } from '../../src/testing/mock-executor.ts'

/* ------------------------------------------------------------------------------- scratch repo */

export interface ScratchRepo {
  readonly root: string
  readonly registration: WorkspaceRegistration
  /** The sha of the initial commit — what `baseRef: 'HEAD'` must resolve to (C4b). */
  readonly head: string
  write(relative: string, body: string): void
  commit(message: string): string
  dispose(): void
}

function git(cwd: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout.trim()
}

export function createScratchRepo(
  options: { workspaceId?: string; sensitive?: boolean; writeMode?: 'worktree' | 'in-place' } = {},
): ScratchRepo {
  const root = mkdtempSync(join(tmpdir(), 'swarm-repo-'))
  git(root, ['init', '--initial-branch=main'])
  git(root, ['config', 'user.email', 'swarm@example.test'])
  git(root, ['config', 'user.name', 'swarm test'])
  git(root, ['config', 'commit.gpgsign', 'false'])
  writeFileSync(join(root, 'README.md'), '# scratch\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-m', 'initial'])
  const head = git(root, ['rev-parse', 'HEAD'])

  return {
    root,
    head,
    registration: {
      workspaceId: options.workspaceId ?? 'scratch',
      root,
      label: 'scratch',
      writeMode: options.writeMode ?? 'worktree',
      sensitive: options.sensitive ?? false,
    },
    write(relative, body) {
      const path = join(root, relative)
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, body)
    },
    commit(message) {
      git(root, ['add', '-A'])
      git(root, ['commit', '--allow-empty', '-m', message])
      return git(root, ['rev-parse', 'HEAD'])
    },
    dispose() {
      rmSync(root, { recursive: true, force: true })
    },
  }
}

/* ------------------------------------------------------------------------------- the server */

export interface ServerHarnessOptions {
  readonly adapter?: ExecutorAdapter
  readonly config?: DeepPartialConfig
  readonly repo?: ScratchRepo
  readonly verifier?: Verifier
  readonly now?: () => number
  readonly listen?: boolean
  readonly autoTick?: boolean
  /** `':memory:'` by default; a path makes the store survive a restart (§13's crash-resume row). */
  readonly dbPath?: string
  /** Reuse a `$SWARM_HOME` across restarts, so `swarm.db` and `tokens.json` are the same files. */
  readonly home?: string
}

export interface ServerHarness {
  readonly server: SwarmServer
  readonly repo: ScratchRepo
  readonly adapter: ExecutorAdapter
  readonly home: string
  port(): number
  /** A paired token, exactly as `POST /pair` would have issued one. */
  token(name?: string): string
  http(
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown },
  ): Promise<{ status: number; json: unknown; text: string }>
  /**
   * `fetch` refuses to set `Host` — it is a forbidden header name — so DNS-rebinding coverage
   * needs the raw client. Any header, exactly as written.
   */
  raw(
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: unknown },
  ): Promise<{ status: number; json: unknown; text: string }>
  dispose(): Promise<void>
}

export async function createServerHarness(
  options: ServerHarnessOptions = {},
): Promise<ServerHarness> {
  const repo = options.repo ?? createScratchRepo()
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'swarm-home-'))
  const adapter = options.adapter ?? new MockExecutor()
  const config = defaultServerConfig({
    port: 0,
    workspaces: [repo.registration],
    ...options.config,
  })
  const server = await createSwarmServer({
    config,
    adapter,
    swarmHome: home,
    dbPath: options.dbPath ?? ':memory:',
    /* The scheduler is driven by explicit `engine.tick()` calls: a background loop makes every
     * admission assertion a race. */
    autoTick: options.autoTick ?? false,
    ...(options.verifier === undefined ? {} : { verifier: options.verifier }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })
  if (options.listen !== false) await server.listen()

  return {
    server,
    repo,
    adapter,
    home,
    port: () => server.port(),
    token: (name = 'test head') => server.tokens.issueToken(name, 'test').token,
    async http(path, init = {}) {
      const response = await fetch(`http://127.0.0.1:${server.port()}${path}`, {
        method: init.method ?? 'GET',
        headers: {
          host: `127.0.0.1:${server.port()}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
      const text = await response.text()
      let json: unknown = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      return { status: response.status, json, text }
    },
    raw(path, init = {}) {
      const body = init.body === undefined ? undefined : JSON.stringify(init.body)
      return new Promise((resolve, reject) => {
        const request = httpRequest(
          {
            host: '127.0.0.1',
            port: server.port(),
            path,
            method: init.method ?? 'GET',
            headers: {
              host: `127.0.0.1:${server.port()}`,
              ...(body === undefined
                ? {}
                : {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(body),
                  }),
              ...init.headers,
            },
          },
          (response) => {
            let text = ''
            response.setEncoding('utf8')
            response.on('data', (chunk: string) => {
              text += chunk
            })
            response.on('end', () => {
              let json: unknown = null
              try {
                json = JSON.parse(text)
              } catch {
                json = null
              }
              resolve({ status: response.statusCode ?? 0, json, text })
            })
          },
        )
        request.on('error', reject)
        if (body !== undefined) request.write(body)
        request.end()
      })
    },
    async dispose() {
      await server.close()
      if (options.home === undefined) rmSync(home, { recursive: true, force: true })
      if (options.repo === undefined) repo.dispose()
    },
  }
}

/* --------------------------------------------------------------------------- the raw socket */

export interface RawSocket {
  send(frame: ClientFrame | Record<string, unknown> | string): void
  /** Every server frame received, in order. */
  readonly frames: readonly ServerFrame[]
  readonly closes: readonly { code: number; reason: string }[]
  /** Resolve as soon as a frame matching `match` has been seen (including already-seen ones). */
  next<T extends ServerFrame>(
    match: (frame: ServerFrame) => frame is T,
    timeoutMs?: number,
  ): Promise<T>
  waitFor(match: (frame: ServerFrame) => boolean, timeoutMs?: number): Promise<ServerFrame>
  waitForClose(timeoutMs?: number): Promise<{ code: number; reason: string }>
  hello(head?: 'extension' | 'cli' | 'test'): Promise<ServerFrame>
  close(): void
}

export interface RawSocketOptions {
  readonly port: number
  readonly token?: string
  /** Omit `swarm.v1` to drive §2.1's protocol row. */
  readonly protocols?: readonly string[]
  readonly origin?: string
  readonly host?: string
  readonly path?: string
}

const envelope = { p: 'swarm', v: 1 } as const

export function openRawSocket(options: RawSocketOptions): Promise<RawSocket> {
  const protocols = options.protocols ?? [
    'swarm.v1',
    ...(options.token === undefined ? [] : [`swarm.tok.${options.token}`]),
  ]
  const headers: Record<string, string> = {}
  if (options.origin !== undefined) headers.origin = options.origin
  if (options.host !== undefined) headers.host = options.host

  const socket = new WebSocket(
    `ws://127.0.0.1:${options.port}${options.path ?? '/swarm'}`,
    [...protocols],
    { headers, ...(options.host === undefined ? {} : { host: options.host }) },
  )
  const frames: ServerFrame[] = []
  const closes: { code: number; reason: string }[] = []
  const waiters = new Set<{
    match: (f: ServerFrame) => boolean
    settle: (f: ServerFrame) => void
  }>()
  const closeWaiters = new Set<(info: { code: number; reason: string }) => void>()

  socket.on('message', (data) => {
    const frame = JSON.parse(data.toString()) as ServerFrame
    frames.push(frame)
    for (const waiter of Array.from(waiters)) {
      if (waiter.match(frame)) {
        waiters.delete(waiter)
        waiter.settle(frame)
      }
    }
  })
  socket.on('close', (code, reason) => {
    const info = { code, reason: reason.toString() }
    closes.push(info)
    for (const settle of Array.from(closeWaiters)) settle(info)
    closeWaiters.clear()
  })
  /* A refused upgrade ends as an `error` on this socket; the close listener still fires, and the
   * tests assert on the close code, so nothing here may throw. */
  socket.on('error', () => undefined)

  const waitFor = (
    match: (frame: ServerFrame) => boolean,
    timeoutMs = 2_000,
  ): Promise<ServerFrame> => {
    const seen = frames.find(match)
    if (seen !== undefined) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const entry = { match, settle: resolve }
      waiters.add(entry)
      setTimeout(() => {
        if (waiters.delete(entry)) reject(new Error('timed out waiting for a frame'))
      }, timeoutMs).unref?.()
    })
  }

  const api: RawSocket = {
    send(frame) {
      socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame))
    },
    frames,
    closes,
    next: <T extends ServerFrame>(match: (f: ServerFrame) => f is T, timeoutMs?: number) =>
      waitFor(match, timeoutMs) as Promise<T>,
    waitFor,
    waitForClose(timeoutMs = 2_000) {
      const seen = closes[0]
      if (seen !== undefined) return Promise.resolve(seen)
      return new Promise((resolve, reject) => {
        closeWaiters.add(resolve)
        setTimeout(() => reject(new Error('timed out waiting for a close')), timeoutMs).unref?.()
      })
    },
    async hello(head = 'test') {
      api.send({ ...envelope, k: 'hello', client: 'test/0.1', head, minV: 1, maxV: 1 })
      return waitFor((frame) => frame.k === 'hello_ok')
    },
    close() {
      socket.close()
    },
  }

  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve(api))
    socket.on('close', () => resolve(api))
    socket.on('error', () => resolve(api))
    setTimeout(() => reject(new Error('socket never settled')), 3_000).unref?.()
  })
}

/* ------------------------------------------------------------------------------ spec builders */

export function specFor(
  repo: ScratchRepo,
  overrides: Partial<DelegationSpec> = {},
): CreateDelegationInput['spec'] {
  return {
    specVersion: 1,
    objective: 'make the scratch repo do the thing',
    acceptance: [],
    model: { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: 'medium' },
    budget: {
      maxWallMs: 45 * 60_000,
      maxTurns: 30,
      maxToolCalls: 200,
      maxInputTokens: 2_000_000,
      maxOutputTokens: 200_000,
      onBreach: 'pause-dispatch',
    },
    execution: { nativeSwarm: false, jcodeMemory: false, autoPoke: true, skills: [] },
    context: [],
    delivery: { mode: 'after-turn', notify: 'notify' },
    parallelAttempts: 1,
    ...overrides,
    workspace: { workspaceId: repo.registration.workspaceId, baseRef: 'HEAD' },
  } as unknown as CreateDelegationInput['spec']
}

export function createInput(
  repo: ScratchRepo,
  overrides: Partial<CreateDelegationInput> = {},
  spec: Partial<DelegationSpec> = {},
): CreateDelegationInput {
  return {
    idempotencyKey: `idem-${Math.random().toString(36).slice(2, 10)}`,
    spec: specFor(repo, spec),
    ...overrides,
  }
}

/** A `flush` that yields to the microtask queue and to any injected zero-delay timers. */
export async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 1))
}

/**
 * Run the scheduler to quiescence.
 *
 * `tick()` is re-entrancy-guarded — a second call while one is in flight returns immediately, by
 * design, because §7.1 specifies **one** loop. Every intent that changes state also fires a
 * `void tick()`, so a test that ticks once races the tick its own `createDelegation` started.
 * Alternating `settle` and `tick` converges instead of guessing a delay.
 */
export async function drain(harness: ServerHarness, rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await settle(2)
    await harness.server.engine.tick()
  }
  await settle(4)
}
