/**
 * `SwarmServerConfig` and the `$SWARM_HOME` layout (SPEC-swarm §7.2, §7.3).
 *
 * Two things live here that look like plumbing and are not:
 *
 *  - **`inheritLogins` has no default** (S10). The SDK's default of `true` silently spends the
 *    user's subscription quota, so the config type keeps it required and `defaultServerConfig()`
 *    writes `false` — an explicit, persisted setup decision either way.
 *  - **`bridgeArgv` ships empty and is documented bridge-process-only** ([F4], §7.3). Tool flags
 *    parse on `api-bridge` and never reach the daemon that runs the agent, so a non-empty value
 *    MUST NOT be read as a tool-authority claim (S8).
 *
 * Node ≥ 24, server-only.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import type { BudgetSpec, DeliveryDefaults, ModelSpec } from '../types.ts'

import { DEFAULT_CAPS, DEFAULT_TIMEOUTS, SERVER_POLICY } from '../domain/constants.ts'
import { SwarmError } from '../errors.ts'

export interface WorkspaceRegistration {
  readonly workspaceId: string
  readonly root: string
  readonly label: string
  /** `'readonly'` does not exist (Q6, #28) — jcode has no read-only mode to back it. */
  readonly writeMode: 'worktree' | 'in-place'
  /** `sensitive` ⇒ `'worktree'` forced, `'in-place'` and `allowDirty` refused (§7.3). */
  readonly sensitive: boolean
}

export interface SwarmServerConfig {
  readonly configVersion: 1
  readonly port: number
  readonly bind: '127.0.0.1'
  readonly origins: readonly string[]
  readonly workspaces: readonly WorkspaceRegistration[]
  readonly defaults: {
    readonly model: ModelSpec
    readonly budget: BudgetSpec
    readonly delivery: DeliveryDefaults
    readonly writeMode: 'worktree'
    readonly parallelAttempts: 1
  }
  readonly caps: {
    /** Default 4 (Q9) — counts **attempts**, not delegations. */
    readonly globalConcurrency: number
    readonly perWorkspace: number
    readonly perProviderModel: Readonly<Record<string, number>>
    readonly worktreesPerRepo: number
    readonly copilotConcurrency: number
    /** The ceiling a spec may request. */
    readonly maxParallelAttempts: 1 | 2 | 3
    readonly softSpendUsd: number | null
    readonly hardSpendUsd: number | null
  }
  readonly executor: {
    readonly adapterId: 'jcode'
    readonly binary?: string
    readonly versionFloor: '0.66.0'
    readonly autoUpdate: false
    /** Explicit, no default (S10). */
    readonly inheritLogins: boolean
    /** Added to the mandatory base set (§5.3). */
    readonly envAllowlist: readonly string[]
    /**
     * Extra args to the **bridge process**. EMPTY, and it is not a staging decision: tool flags
     * parse here and never reach the daemon that runs the agent ([F4]). A non-empty value MUST
     * NOT be read as a tool-authority claim (S8).
     */
    readonly bridgeArgv: readonly string[]
  }
  readonly timeouts: {
    readonly sleepDetectThresholdMs: number
    readonly confirmationTtlMs: number
    readonly acceptTimeoutMs: number
  }
  /** Audit is exempt from all of it (§2.3, S13, Q20). */
  readonly retention: { readonly attemptStreamDays: number; readonly attemptStreamMb: number }
}

/** §7.2's layout, as one resolved record — nothing else in the server joins these paths by hand. */
export interface SwarmHomeLayout {
  readonly root: string
  readonly configPath: string
  readonly tokensPath: string
  readonly cliTokenPath: string
  readonly runtimePath: string
  readonly dbPath: string
  readonly instancesDir: string
  readonly worktreesDir: string
  readonly evidenceDir: string
  readonly skillsDir: string
  readonly logDir: string
}

/** `~/.astrale/swarm`, overridden by `SWARM_HOME` (§7.2). */
export function resolveSwarmHome(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return resolve(explicit)
  const fromEnv = process.env.SWARM_HOME
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv)
  return join(homedir(), '.astrale', 'swarm')
}

export function swarmHomeLayout(root: string): SwarmHomeLayout {
  return {
    root,
    configPath: join(root, 'config.json'),
    tokensPath: join(root, 'tokens.json'),
    cliTokenPath: join(root, 'cli-token'),
    runtimePath: join(root, 'runtime.json'),
    dbPath: join(root, 'swarm.db'),
    instancesDir: join(root, 'instances'),
    worktreesDir: join(root, 'worktrees'),
    evidenceDir: join(root, 'evidence'),
    skillsDir: join(root, 'skills'),
    logDir: join(root, 'log'),
  }
}

export function ensureSwarmHome(layout: SwarmHomeLayout): void {
  for (const dir of [
    layout.root,
    layout.instancesDir,
    layout.worktreesDir,
    layout.evidenceDir,
    layout.skillsDir,
    layout.logDir,
  ]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
}

export function defaultServerConfig(overrides: DeepPartialConfig = {}): SwarmServerConfig {
  const base: SwarmServerConfig = {
    configVersion: 1,
    port: SERVER_POLICY.defaultPort,
    bind: '127.0.0.1',
    /* §2.1's "dev `http://localhost:*`", as data. It has to be *in* the list, because the list is
     * now authoritative: the loopback origin space used to be allowed unconditionally, which made
     * `origins` advisory for exactly the clients it was written to constrain. */
    origins: ['http://localhost:*', 'http://127.0.0.1:*'],
    workspaces: [],
    defaults: {
      model: { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: 'medium' },
      budget: {
        maxWallMs: 45 * 60_000,
        maxTurns: 30,
        maxToolCalls: 200,
        maxInputTokens: 2_000_000,
        maxOutputTokens: 200_000,
        onBreach: 'pause-dispatch',
      },
      delivery: { mode: 'after-turn', notify: 'notify' },
      writeMode: 'worktree',
      parallelAttempts: 1,
    },
    caps: {
      globalConcurrency: DEFAULT_CAPS.globalConcurrency,
      perWorkspace: DEFAULT_CAPS.perWorkspace,
      perProviderModel: {},
      worktreesPerRepo: DEFAULT_CAPS.worktreesPerRepo,
      copilotConcurrency: DEFAULT_CAPS.copilotConcurrency,
      maxParallelAttempts: DEFAULT_CAPS.maxParallelAttempts,
      softSpendUsd: null,
      hardSpendUsd: null,
    },
    executor: {
      adapterId: 'jcode',
      versionFloor: SERVER_POLICY.jcodeVersionFloor as '0.66.0',
      autoUpdate: false,
      /* S10: never defaulted to the SDK's `true`, which spends the user's subscription. */
      inheritLogins: false,
      envAllowlist: [],
      /* [F4]: empty, permanently, and not because wave 1 is cautious. */
      bridgeArgv: [],
    },
    timeouts: {
      sleepDetectThresholdMs: DEFAULT_TIMEOUTS.sleepDetectThresholdMs,
      confirmationTtlMs: DEFAULT_TIMEOUTS.confirmationTtlMs,
      acceptTimeoutMs: DEFAULT_TIMEOUTS.acceptTimeoutMs,
    },
    retention: { attemptStreamDays: 7, attemptStreamMb: 200 },
  }
  return mergeConfig(base, overrides)
}

export type DeepPartialConfig = {
  readonly [K in keyof SwarmServerConfig]?: SwarmServerConfig[K] extends object
    ? Partial<SwarmServerConfig[K]>
    : SwarmServerConfig[K]
}

function mergeConfig(base: SwarmServerConfig, patch: DeepPartialConfig): SwarmServerConfig {
  return {
    ...base,
    ...patch,
    defaults: { ...base.defaults, ...patch.defaults },
    caps: { ...base.caps, ...patch.caps },
    executor: { ...base.executor, ...patch.executor },
    timeouts: { ...base.timeouts, ...patch.timeouts },
    retention: { ...base.retention, ...patch.retention },
  } as SwarmServerConfig
}

/**
 * Read `config.json`, falling back to the defaults when it does not exist. A malformed file is a
 * refusal rather than a silent default: a server that quietly ignores a typo in `workspaces`
 * would refuse every delegation with `workspace_denied` and give no reason for it.
 */
export function loadServerConfig(
  path: string,
  overrides: DeepPartialConfig = {},
): SwarmServerConfig {
  let onDisk: DeepPartialConfig = {}
  try {
    onDisk = JSON.parse(readFileSync(path, 'utf8')) as DeepPartialConfig
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') {
      throw new SwarmError('invalid_spec', `config at ${path} is not readable JSON`, {
        cause: error,
      })
    }
  }
  return mergeConfig(defaultServerConfig(onDisk), overrides)
}

export function writeServerConfig(path: string, config: SwarmServerConfig): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

/** §7.2's `runtime.json` — `daemonPid` is on it because of [F1], so a reclaimed instance is killable. */
export interface RuntimeFile {
  readonly pid: number
  readonly port: number
  readonly bootId: string
  readonly startedAt: number
  readonly version: string
  readonly instances: readonly {
    readonly key: string
    readonly pgid: number | null
    readonly daemonPid: number | null
    readonly socket: string
    readonly jcodeHome: string
  }[]
}

export function writeRuntimeFile(path: string, runtime: RuntimeFile): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 })
}

export function readRuntimeFile(path: string): RuntimeFile | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RuntimeFile
  } catch {
    return null
  }
}
