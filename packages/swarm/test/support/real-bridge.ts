/**
 * A throwaway `jcode api-bridge` instance, for the tests that must meet the real binary
 * (SPEC-swarm §5.3, §13).
 *
 * **Isolation is the whole contract of this file.** Every instance gets a fresh `JCODE_HOME` and
 * `JCODE_RUNTIME_DIR` under the OS temp dir, built by swarm's own `buildBridgeEnv`, so the user's
 * `~/.jcode` — their sessions, their `servers.json`, their `auth.json` — is never opened, never
 * written, and never inherited. `inheritLogins: false` is the same promise at the swarm layer:
 * nothing copies a credential in.
 *
 * That promise has **one verified hole**, and it is not swarm's to close. `get_runtime_info` on a
 * virgin home still reports
 * `{ model: 'gpt-5.6-pro[web]', api_method: 'chatgpt-web', available: true, detail: 'logged-in
 * Firefox ChatGPT session' }`: that route authenticates from the user's *browser profile* under
 * `$HOME`, which `buildBridgeEnv` passes through because a coding agent without `$HOME` cannot
 * run. A fresh `JCODE_HOME` does not isolate it. Consequences, in order:
 *
 *  - A turn started here could reach a live model on the user's own subscription, so **no test in
 *    this suite may start a model turn.** `sendMessage` is only ever called with `noReply: true`,
 *    which is verified not to start one.
 *  - Swarm's instance-pool key treats credentials as a pool dimension (R10) on the assumption
 *    that a home with no credentials has no reach. For `chatgpt-web` that assumption is false.
 *
 * Node ≥ 24; test-only, and deliberately outside `src/testing/**` so the shipped testing barrel
 * keeps its single import of the real SDK confined to `sdk-transport.ts`.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import type { JcodeSdkClient } from '../../src/server/executor/sdk.ts'

import { createRealJcodeTransport } from '../../src/server/executor/sdk-transport.ts'
import {
  buildBridgeEnv,
  killTwoGroups,
  launchBridge,
  resolveDaemonPid,
} from '../../src/server/executor/spawn.ts'

/** The env flag. CI stays hermetic unless it is explicitly set. */
export const REAL_BRIDGE_ENABLED = process.env.SWARM_REAL_BRIDGE === '1'

/**
 * Where the binary is. `SWARM_JCODE_BIN` wins, then `~/.local/bin/jcode`, then bare `jcode` on
 * `PATH` — the last so a CI image that installs jcode normally needs no configuration.
 */
export function jcodeBinary(): string {
  const configured = process.env.SWARM_JCODE_BIN
  if (configured !== undefined && configured.length > 0) return configured
  const local = join(homedir(), '.local', 'bin', 'jcode')
  return existsSync(local) ? local : 'jcode'
}

export interface RealBridge {
  readonly root: string
  readonly jcodeHome: string
  readonly runtimeDir: string
  readonly socketPath: string
  readonly daemonSocket: string
  readonly pgid: number
  readonly daemonPid: number | null
  /** A **fresh** connection, which is the only kind that may create a session. */
  connect(): Promise<JcodeSdkClient>
  /** A workspace directory inside the throwaway root. */
  workspace(name: string): string
  /** Two-group kill, then remove the temp root. Safe to call twice. */
  stop(): Promise<{ readonly survivors: readonly number[]; readonly daemonStopped: boolean }>
}

/**
 * Launch a bridge through **swarm's own spawn path** — `buildBridgeEnv` + `launchBridge`, not the
 * SDK's launcher (R12). Testing the real thing means testing the code that will run in
 * production, including `detached: true` and the replaced (not merged) environment.
 */
export async function startRealBridge(
  options: { readonly autoPoke?: boolean } = {},
): Promise<RealBridge> {
  const root = mkdtempSync(join(tmpdir(), 'swarm-real-bridge-'))
  const jcodeHome = join(root, 'home')
  const runtimeDir = join(root, 'runtime')
  const socketPath = join(runtimeDir, 'api.sock')
  const daemonSocket = join(runtimeDir, 'jcode.sock')

  const env = buildBridgeEnv({
    jcodeHome,
    runtimeDir,
    apiSocket: socketPath,
    daemonSocket,
    autoPoke: options.autoPoke ?? false,
  })

  const launched = await launchBridge({
    binary: jcodeBinary(),
    socketPath,
    jcodeHome,
    runtimeDir,
    daemonSocket,
    /* `--no-update` so a test run can never rewrite the user's installed binary. */
    bridgeArgv: ['--no-update'],
    env,
    startupTimeoutMs: 60_000,
    inheritStderr: false,
  })

  const transport = createRealJcodeTransport({ clientName: 'swarm-real-bridge-test/0.1' })
  const connections: JcodeSdkClient[] = []
  let stopped = false

  return {
    root,
    jcodeHome,
    runtimeDir,
    socketPath,
    daemonSocket,
    pgid: launched.pgid,
    daemonPid: resolveDaemonPid(jcodeHome, daemonSocket),
    async connect() {
      const client = await transport.connect(socketPath)
      connections.push(client)
      return client
    },
    workspace(name: string) {
      const dir = join(root, name)
      mkdirSync(dir, { recursive: true })
      return dir
    },
    async stop() {
      if (stopped) return { survivors: [], daemonStopped: true }
      stopped = true
      for (const client of connections) await client.close().catch(() => undefined)
      const result = await killTwoGroups({
        pgid: launched.pgid,
        /* Re-resolved: the daemon registers itself after the bridge comes up. */
        daemonPid: resolveDaemonPid(jcodeHome, daemonSocket),
        graceMs: 300,
      })
      rmSync(root, { recursive: true, force: true })
      return { survivors: result.survivors, daemonStopped: result.daemonStopped }
    },
  }
}

/** `true` while the pid exists. `ESRCH` is the only honest proof a process is gone. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code !== 'ESRCH'
  }
}

/** The binary's self-reported version, for the gate test. */
export function jcodeVersion(): string {
  return execFileSync(jcodeBinary(), ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim()
}
