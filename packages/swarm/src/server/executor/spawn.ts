/**
 * Swarm's own `api-bridge` spawn, the env allowlist, the version gate, the `servers.json` daemon
 * pid and the two-group hard kill (SPEC-swarm §5.3, §4.3.7, [F1], [F9], decision log #26/#27).
 *
 * The SDK's launcher is **never called** (R12), and the reasons are three lines of its own source:
 * its `env` is `{...process.env, ...options.env}` — **additive**, so no variable can be *removed*
 * and S9's scrubbed child env is unreachable; its `argv` is a literal; and it spawns
 * `detached: false`, which leaves the bridge in the swarm server's own process group, where
 * `kill(-pgid)` is swarm killing itself. Twenty lines of `spawn` restore all three.
 *
 * **The kill signals two groups, not one** ([F1]). `jcode api-bridge` spawns the daemon through
 * `spawn_server`, and the daemon `libc::setsid()`s in a `pre_exec`: it leads its own session, and
 * the agent, its tools and its bash children live *there*. A kill that signals only the bridge
 * group returns `survivors: []` while the agent keeps writing to the worktree — a failure that
 * looks exactly like success, which is why `daemonStopped` is a field and not an assumption.
 *
 * Node ≥ 24, server-only.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { PreflightReport } from '../../types.ts'

import { SERVER_POLICY } from '../../domain/constants.ts'
import { SwarmError } from '../../errors.ts'

/* --------------------------------------------------------------------------- the env allowlist */

/**
 * The mandatory base set of §5.3. This is the **whole** environment the bridge — and therefore
 * the daemon it re-execs, which inherits it — will see. Nothing else reaches the agent.
 *
 * Note what this *does* buy and what it does not: `JCODE_SWARM_ENABLED=false` and
 * `JCODE_MEMORY_ENABLED=false` work precisely because the daemon inherits this environment,
 * while `--tool-profile` does not work at all, because flags stop at the bridge ([F4], §5.5).
 */
export interface BridgeEnvInput {
  readonly jcodeHome: string
  readonly runtimeDir: string
  readonly apiSocket: string
  readonly daemonSocket: string
  readonly autoPoke: boolean
  /** Opt-in only (§5.3): an agent with the user's agent socket has the user's git identity. */
  readonly sshAuthSock?: string
  /** `config.executor.envAllowlist` — names copied from the server env, values and all. */
  readonly allowlist?: readonly string[]
  readonly sourceEnv?: Readonly<Record<string, string | undefined>>
}

export function buildBridgeEnv(input: BridgeEnvInput): Record<string, string> {
  const source = input.sourceEnv ?? process.env
  const env: Record<string, string> = {
    PATH: source.PATH ?? '/usr/bin:/bin',
    HOME: source.HOME ?? '',
    LANG: source.LANG ?? 'C.UTF-8',
    TZ: source.TZ ?? 'UTC',
    JCODE_HOME: input.jcodeHome,
    JCODE_RUNTIME_DIR: input.runtimeDir,
    JCODE_API_SOCKET: input.apiSocket,
    JCODE_SOCKET: input.daemonSocket,
    JCODE_SWARM_ENABLED: 'false',
    JCODE_MEMORY_ENABLED: 'false',
    JCODE_NO_TELEMETRY: '1',
    JCODE_NON_INTERACTIVE: '1',
    JCODE_AUTO_POKE: input.autoPoke ? '1' : '0',
  }
  if (input.sshAuthSock !== undefined && input.sshAuthSock.length > 0) {
    env.SSH_AUTH_SOCK = input.sshAuthSock
  }
  for (const name of input.allowlist ?? []) {
    const value = source[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/* ------------------------------------------------------------------------------ version gate */

export interface VersionProbe {
  (
    binary: string,
    timeoutMs: number,
  ): { readonly code: number; readonly stdout: string; readonly stderr: string }
}

const defaultVersionProbe: VersionProbe = (binary, timeoutMs) => {
  const result = spawnSync(binary, ['--version'], { timeout: timeoutMs, encoding: 'utf8' })
  return {
    code: result.status ?? (result.error === undefined ? -1 : 127),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error === undefined ? '' : String(result.error)),
  }
}

export function parseSemver(text: string): readonly [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  if (match === null) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareSemver(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!
  }
  return 0
}

/**
 * §5.3's version gate — **the only floor there is**: `@1jehuang/jcode-sdk@1.0.1` declares and
 * checks no jcode version anywhere, so without this a 0.64.2 binary reaches a `startup_failed`
 * with no explanation.
 *
 * Under one second, and the fix string is asserted verbatim by §13: `jcode update`. `jcode
 * upgrade` errors with `unrecognized subcommand`, and the one copy-pasteable string on the
 * first-run screen has to be the one that works (R15, §11).
 */
export function preflightJcode(
  options: {
    readonly binary?: string
    readonly floor?: string
    readonly probe?: VersionProbe
    readonly timeoutMs?: number
  } = {},
): PreflightReport {
  const binary = options.binary ?? 'jcode'
  const floorText = options.floor ?? SERVER_POLICY.jcodeVersionFloor
  const floor = parseSemver(floorText) ?? ([0, 66, 0] as const)
  const probe = options.probe ?? defaultVersionProbe
  const result = probe(binary, options.timeoutMs ?? 1_000)

  if (result.code === 127 || /ENOENT|not found|no such file/i.test(result.stderr)) {
    return {
      ok: false,
      detail: `jcode binary '${binary}' was not found on PATH`,
      versions: {},
      blocked: 'binary_missing',
      fix: `install jcode, or set executor.binary in config.json`,
    }
  }
  const version = parseSemver(`${result.stdout}\n${result.stderr}`)
  if (version === null) {
    return {
      ok: false,
      detail: `could not parse a version from \`${binary} --version\``,
      versions: {},
      blocked: 'version_floor',
      fix: SERVER_POLICY.jcodeUpdateCommand,
    }
  }
  const versions = { jcode: version.join('.') }
  if (compareSemver(version, floor) < 0) {
    return {
      ok: false,
      detail: `jcode ${versions.jcode} is below the ${floorText} floor`,
      versions,
      blocked: 'version_floor',
      fix: SERVER_POLICY.jcodeUpdateCommand,
    }
  }
  return { ok: true, detail: `jcode ${versions.jcode}`, versions, blocked: null, fix: null }
}

/* ---------------------------------------------------------------------------- the bridge spawn */

export interface SpawnedBridge {
  /** The **leader** of the new group: `detached: true` makes `pgid === child.pid` (#26). */
  readonly pid: number
  readonly socketPath: string
  /** Captured stderr, attached to every startup failure so a hang is never the failure mode (R1). */
  stderr(): string
  /** `true` while the child is still alive — checked after the handshake, before the pgid is kept. */
  alive(): boolean
  /** Resolves with the exit code if the child dies; `null` while it lives. */
  exitCode(): number | null
  kill(signal: NodeJS.Signals | number): boolean
}

export interface BridgeLauncher {
  (input: {
    readonly binary: string
    readonly argv: readonly string[]
    readonly env: Record<string, string>
    readonly inheritStderr: boolean
  }): SpawnedBridge
}

const defaultLauncher: BridgeLauncher = (input) => {
  const child = spawn(input.binary, input.argv, {
    env: input.env,
    /* (b) of §5.3's verbatim quote, inverted: swarm's bridge leads its own group, so
     * `kill(-pgid)` reaches the bridge and never the swarm server. */
    detached: true,
    stdio: ['ignore', 'ignore', input.inheritStderr ? 'inherit' : 'pipe'],
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })
  let exit: number | null = null
  child.on('exit', (code) => {
    exit = code ?? -1
  })
  child.on('error', (error) => {
    stderr += String(error)
    exit = 127
  })
  return {
    pid: child.pid ?? -1,
    socketPath: '',
    stderr: () => stderr,
    alive: () => exit === null,
    exitCode: () => exit,
    kill: (signal) => child.kill(signal as NodeJS.Signals),
  }
}

export interface LaunchBridgeInput {
  readonly binary: string
  readonly socketPath: string
  readonly jcodeHome: string
  readonly runtimeDir: string
  readonly daemonSocket: string
  readonly bridgeArgv: readonly string[]
  readonly env: Record<string, string>
  readonly startupTimeoutMs: number
  readonly inheritStderr: boolean
  readonly launcher?: BridgeLauncher
  readonly socketExists?: (path: string) => boolean
  readonly sleep?: (ms: number) => Promise<void>
}

export interface LaunchedBridge {
  readonly child: SpawnedBridge
  readonly pgid: number
  readonly socketPath: string
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })

/**
 * Spawn the bridge and wait for its socket.
 *
 * **A child that exits `0` during startup is a failure, not a success** ([F9]). The bridge takes
 * an exclusive `flock` on `<api_socket>.lock` and, when another bridge already owns it, prints a
 * message and returns `Ok(())` — exit code 0. Spawn-then-wait-for-socket-then-connect would find
 * the *incumbent's* socket, connect happily, and record a pgid for a corpse; `hardKill` would
 * later signal a group that serves nothing while the real bridge and daemon keep running. So any
 * exit before the handshake completes, **including 0**, is `blocked:'socket_dir'`.
 */
export async function launchBridge(input: LaunchBridgeInput): Promise<LaunchedBridge> {
  mkdirSync(input.runtimeDir, { recursive: true, mode: 0o700 })
  mkdirSync(input.jcodeHome, { recursive: true, mode: 0o700 })
  const launcher = input.launcher ?? defaultLauncher
  const socketExists = input.socketExists ?? ((path: string) => existsSync(path))
  const sleep = input.sleep ?? wait

  const child = launcher({
    binary: input.binary,
    argv: ['api-bridge', '--api-socket', input.socketPath, ...input.bridgeArgv],
    env: input.env,
    inheritStderr: input.inheritStderr,
  })

  const deadline = Date.now() + input.startupTimeoutMs
  for (;;) {
    if (!child.alive()) {
      throw new SwarmError(
        'executor_unavailable',
        `api-bridge exited with ${String(child.exitCode())} before the handshake`,
        {
          details: {
            blocked: 'socket_dir',
            exitCode: child.exitCode(),
            stderr: child.stderr().slice(-4096),
          },
        },
      )
    }
    if (socketExists(input.socketPath)) break
    if (Date.now() > deadline) {
      child.kill('SIGKILL')
      throw new SwarmError(
        'executor_unavailable',
        `api-bridge socket ${input.socketPath} did not appear in ${input.startupTimeoutMs} ms`,
        { details: { blocked: 'socket_dir', stderr: child.stderr().slice(-4096) } },
      )
    }
    await sleep(10)
  }

  return { child, pgid: child.pid, socketPath: input.socketPath }
}

/**
 * The liveness assertion of [F9], run **after** the connect handshake and **before** the pgid is
 * recorded. A dead child at this point means the socket belongs to an incumbent bridge.
 */
export function assertChildStillAlive(child: SpawnedBridge): void {
  if (child.alive()) return
  throw new SwarmError(
    'executor_unavailable',
    'api-bridge exited during startup — the socket belongs to another bridge (flock, exit 0)',
    { details: { blocked: 'socket_dir', exitCode: child.exitCode(), stderr: child.stderr() } },
  )
}

/* -------------------------------------------------------------- [F1] the daemon pid and the kill */

export interface ServersJsonEntry {
  readonly socket?: string
  readonly pid?: number
}

/**
 * Resolve the `setsid()` daemon's pid the way the SDK's own stop path does: read
 * `$JCODE_HOME/servers.json`, take the entry whose `socket` equals `$JCODE_RUNTIME_DIR/jcode.sock`,
 * use its `pid`. The registry is scoped to *this instance's* home, so it can never name the
 * user's own daemon.
 *
 * `null` is a first-class answer: `KillOutcome.daemonPid: null` plus
 * `notice{kind:'capability-absent'}` is how a partial stop refuses to be reported as a stop.
 */
export function resolveDaemonPid(
  jcodeHome: string,
  daemonSocket: string,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): number | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(read(join(jcodeHome, 'servers.json')))
  } catch {
    return null
  }
  const entries: ServersJsonEntry[] = Array.isArray(parsed)
    ? (parsed as ServersJsonEntry[])
    : typeof parsed === 'object' && parsed !== null
      ? Object.values(parsed as Record<string, ServersJsonEntry>)
      : []
  for (const entry of entries) {
    if (entry?.socket === daemonSocket && typeof entry.pid === 'number') return entry.pid
  }
  return null
}

export interface KillHooks {
  /** `process.kill`, injected so a test can drive both groups without owning a process. */
  readonly kill?: (pid: number, signal: NodeJS.Signals | number) => void
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  /** Grace before `SIGKILL` (§5.3 step 4). */
  readonly graceMs?: number
}

export interface TwoGroupKillInput extends KillHooks {
  readonly pgid: number
  readonly daemonPid: number | null
}

export interface TwoGroupKillResult {
  readonly signalled: readonly string[]
  readonly survivors: readonly number[]
  readonly daemonStopped: boolean
  readonly durationMs: number
}

const alive = (
  kill: (pid: number, signal: NodeJS.Signals | number) => void,
  pid: number,
): boolean => {
  try {
    kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * §5.3's sequence, steps 3–5: `kill(-daemonPid, SIGTERM)` **then** `kill(-pgid, SIGTERM)`; after
 * the grace, `SIGKILL` to both, falling back to `kill(daemonPid, …)` if the *group* signal
 * throws; survivor scan across **both** groups.
 *
 * `dispose()` (step 1) and the pid resolution (step 2) belong to the caller: the adapter owns the
 * SDK handles, and this function owns only the signalling, so it can be driven by a test that has
 * no process to kill.
 */
export async function killTwoGroups(input: TwoGroupKillInput): Promise<TwoGroupKillResult> {
  const kill = input.kill ?? ((pid, signal) => process.kill(pid, signal))
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? wait
  const graceMs = input.graceMs ?? 5_000
  const startedAt = now()
  const signalled: string[] = []

  const signalGroup = (pid: number, signal: NodeJS.Signals): void => {
    try {
      kill(-pid, signal)
      signalled.push(signal)
    } catch {
      /* A group that no longer exists is a group that no longer needs signalling; a group signal
       * that throws for another reason falls back to the bare pid below. */
      try {
        kill(pid, signal)
        signalled.push(signal)
      } catch {
        /* nothing left to signal */
      }
    }
  }

  if (input.daemonPid !== null) signalGroup(input.daemonPid, 'SIGTERM')
  signalGroup(input.pgid, 'SIGTERM')

  await sleep(graceMs)

  const survivors: number[] = []
  if (input.daemonPid !== null && alive(kill, input.daemonPid)) {
    signalGroup(input.daemonPid, 'SIGKILL')
  }
  if (alive(kill, input.pgid)) signalGroup(input.pgid, 'SIGKILL')

  if (input.daemonPid !== null && alive(kill, input.daemonPid)) survivors.push(input.daemonPid)
  if (alive(kill, input.pgid)) survivors.push(input.pgid)

  return {
    signalled,
    survivors,
    /* [F1]: false whenever the daemon outlives the kill OR was never resolvable. A kill that left
     * the daemon alive must never be reported as a completed stop. */
    daemonStopped: input.daemonPid !== null && !survivors.includes(input.daemonPid),
    durationMs: Math.max(0, now() - startedAt),
  }
}
