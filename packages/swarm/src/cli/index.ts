/**
 * The `swarm` CLI head (SPEC-swarm §7.1, §7.2, §11, H10, R13).
 *
 * `serve` is the daemon; **every other verb is a head over the wire**, authenticating from
 * `$SWARM_HOME/cli-token` — a 0600 file rewritten on every start and deleted on clean shutdown.
 * Filesystem ownership *is* the authentication: a process that can read a 0600 file in the user's
 * home can already run `jcode` directly. `--in-process` runs the identical code against an
 * embedded server and is used by tests; §7.1 is explicit that it is not sufficient on its own,
 * because "proving H10 only in-process proves that the client core can be called from Node, which
 * was never in doubt".
 *
 * `doctor` exits **0 healthy / 1 blocked / 2 degraded**, and its fix string is asserted verbatim
 * by §13: `jcode update`. `jcode upgrade` errors with `unrecognized subcommand`, and the one
 * copy-pasteable string on the first-run screen has to be the one that works (R15, §11).
 *
 * Node ≥ 24, CLI-only.
 */

import { randomUUID } from 'node:crypto'

import type { SwarmServerConfig } from '../server/config.ts'
import type { ExecutorAdapter } from '../server/executor/types.ts'
import type { SwarmServer } from '../server/server.ts'
import type { PreflightReport } from '../types.ts'

import { SwarmError } from '../errors.ts'
import { loadServerConfig, resolveSwarmHome, swarmHomeLayout } from '../server/config.ts'
import { createJcodeAdapter } from '../server/executor/jcode.ts'
import { preflightJcode } from '../server/executor/spawn.ts'
import { createInProcessTransport } from '../server/in-process.ts'
import { createSwarmServer } from '../server/server.ts'
import { TokenStore } from '../server/tokens.ts'
import { WireClient } from './wire-client.ts'
import { webSocketTransport } from './ws-transport.ts'

export interface CliIo {
  out(line: string): void
  err(line: string): void
}

export interface RunCliOptions {
  readonly io?: CliIo
  /** Injected by tests; production builds a jcode adapter from the config. */
  readonly adapter?: ExecutorAdapter
  /** Injected by tests: an already-running server for `--in-process`. */
  readonly server?: SwarmServer
  readonly now?: () => number
}

const CONSOLE_IO: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}

export interface ParsedArgs {
  readonly verb: string
  readonly positionals: readonly string[]
  readonly flags: Readonly<Record<string, string | true>>
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) {
      positionals.push(arg)
      continue
    }
    const name = arg.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[name] = next
      i++
    } else {
      flags[name] = true
    }
  }
  return { verb: positionals[0] ?? 'help', positionals: positionals.slice(1), flags }
}

const USAGE = `swarm — a server-scheduled fleet of coding-agent delegations

  swarm serve   [--port 7717] [--config <path>] [--unsafe-bind] [--install-unit]
  swarm doctor  [--json]                       # 0 healthy / 1 blocked / 2 degraded
  swarm pair    [--name <label>]
  swarm tokens  ls | revoke <id>
  swarm status | ls | new | say | watch | verify | land | logs | gc

Every verb but \`serve\` is a head over ws://127.0.0.1:<port>/swarm, authenticating from
$SWARM_HOME/cli-token. --in-process runs the same code against an embedded server.`

/** Returns the process exit code; it never calls `process.exit` itself, so tests can drive it. */
export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<number> {
  const io = options.io ?? CONSOLE_IO
  const parsed = parseArgs(argv)
  const home = resolveSwarmHome(flagString(parsed.flags.home))
  const layout = swarmHomeLayout(home)
  const config = loadServerConfig(
    flagString(parsed.flags.config) ?? layout.configPath,
    parsed.flags.port === undefined ? {} : { port: Number(parsed.flags.port) },
  )

  switch (parsed.verb) {
    case 'help':
      io.out(USAGE)
      return 0

    case 'doctor':
      return doctor(parsed, io, config)

    case 'serve':
      return serve(parsed, io, config, home, options)

    case 'pair': {
      /* A code is issued by the running server, so `pair` is a head like every other verb — but
       * the code itself is printed by `serve`, so this verb asks the server for a fresh one. */
      const server = options.server
      if (server === undefined) {
        io.err('swarm pair requires a running server; start one with `swarm serve`')
        return 1
      }
      const code = server.tokens.issuePairingCode()
      io.out(`pairing code ${code.code} (valid 5 min, one use)`)
      return 0
    }

    case 'tokens': {
      const server = options.server
      if (server === undefined) {
        io.err('swarm tokens requires a running server')
        return 1
      }
      const action = parsed.positionals[0] ?? 'ls'
      if (action === 'revoke') {
        const id = parsed.positionals[1]
        if (id === undefined) {
          io.err('usage: swarm tokens revoke <id>')
          return 1
        }
        io.out(server.tokens.revoke(id) ? `revoked ${id}` : `no token ${id}`)
        return 0
      }
      for (const record of server.tokens.list()) {
        io.out(
          `${record.tokenId}\t${record.clientKind}\t${record.clientName}\t${
            record.revokedAt === null ? 'active' : 'revoked'
          }`,
        )
      }
      return 0
    }

    default:
      return head(parsed, io, config, layout.cliTokenPath, options)
  }
}

/* ------------------------------------------------------------------------------- the daemon */

async function serve(
  parsed: ParsedArgs,
  io: CliIo,
  config: SwarmServerConfig,
  home: string,
  options: RunCliOptions,
): Promise<number> {
  const adapter =
    options.adapter ??
    createJcodeAdapter({
      transport: {
        connect: () => {
          throw new SwarmError(
            'executor_unavailable',
            'no jcode transport is configured; the api-bridge client is supplied at composition',
          )
        },
      },
      ...(config.executor.binary === undefined ? {} : { binary: config.executor.binary }),
      versionFloor: config.executor.versionFloor,
    })

  const report = await adapter.preflight()
  if (!report.ok && report.blocked === 'version_floor') {
    io.err(`✗ ${report.detail} — fix: ${report.fix ?? ''}`)
    return 1
  }

  const server = await createSwarmServer({
    config,
    adapter,
    swarmHome: home,
    unsafeBind: parsed.flags['unsafe-bind'] === true,
    onWarning: (message) => io.err(`! ${message}`),
  })
  const port = await server.listen()
  const code = server.tokens.issuePairingCode()
  io.out(`swarm 0.1.0 on 127.0.0.1:${port} — pairing code ${code.code} (5 min, one use)`)
  io.out(`cli token written to ${swarmHomeLayout(home).cliTokenPath} (0600)`)

  if (parsed.flags['install-unit'] === true) {
    io.out(
      '--install-unit is not implemented in wave 1; run `swarm serve` under your own supervisor',
    )
  }

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void server.close().then(resolve)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return 0
}

/* ------------------------------------------------------------------------------- the doctor */

function doctor(parsed: ParsedArgs, io: CliIo, config: SwarmServerConfig): number {
  const report: PreflightReport = preflightJcode({
    ...(config.executor.binary === undefined ? {} : { binary: config.executor.binary }),
    floor: config.executor.versionFloor,
  })
  if (parsed.flags.json === true) {
    io.out(JSON.stringify(report))
  } else if (report.ok) {
    io.out(`✓ ${report.detail}`)
  } else {
    io.out(`✗ ${report.detail} — fix: ${report.fix ?? ''}`)
  }
  /* §13: 0 healthy / 1 blocked / 2 degraded, and the blocked reasons are exactly the
   * `PreflightReport` discriminants. */
  if (report.ok) return 0
  return report.blocked === null ? 2 : 1
}

/* --------------------------------------------------------------------------------- the head */

async function head(
  parsed: ParsedArgs,
  io: CliIo,
  config: SwarmServerConfig,
  cliTokenPath: string,
  options: RunCliOptions,
): Promise<number> {
  const inProcess = parsed.flags['in-process'] === true && options.server !== undefined
  let token: string
  try {
    token = flagString(parsed.flags.token) ?? readToken(inProcess, options.server, cliTokenPath)
  } catch (error) {
    io.err(SwarmError.is(error) ? error.message : String(error))
    return 1
  }

  const transport =
    inProcess && options.server !== undefined
      ? createInProcessTransport({ server: options.server, token })
      : webSocketTransport({
          url: `ws://127.0.0.1:${options.server?.port() ?? config.port}/swarm`,
          token,
        })

  const client = new WireClient({ transport, clientName: 'swarm-cli/0.1', head: 'cli' })
  try {
    await client.connect()
  } catch (error) {
    io.err(SwarmError.is(error) ? `${error.code}: ${error.message}` : String(error))
    return 1
  }

  try {
    return await verb(parsed, io, client)
  } catch (error) {
    io.err(SwarmError.is(error) ? `${error.code}: ${error.message}` : String(error))
    return 1
  } finally {
    client.close()
  }
}

function readToken(
  inProcess: boolean,
  server: SwarmServer | undefined,
  cliTokenPath: string,
): string {
  if (inProcess && server !== undefined) {
    /* The in-process head still authenticates: an unknown token still closes 4001 (§2.1). */
    return server.tokens.issueToken('swarm cli', 'cli').token
  }
  return TokenStore.readCliToken(cliTokenPath)
}

async function verb(parsed: ParsedArgs, io: CliIo, client: WireClient): Promise<number> {
  const key = (): string => randomUUID()
  switch (parsed.verb) {
    case 'status': {
      const state = (await client.subscribe('fleet', 'snapshot')) as {
        counts: Record<string, number>
        concurrency: { runningAttempts: number; cap: number; queued: number }
        dispatchPaused: boolean
      }
      io.out(
        `attempts ${state.concurrency.runningAttempts}/${state.concurrency.cap}` +
          ` · queued ${state.concurrency.queued}` +
          ` · dispatch ${state.dispatchPaused ? 'PAUSED' : 'running'}`,
      )
      for (const [bucket, count] of Object.entries(state.counts)) {
        if (count > 0) io.out(`  ${bucket.padEnd(14)} ${count}`)
      }
      return 0
    }

    case 'ls': {
      const state = (await client.subscribe('fleet', 'snapshot')) as {
        buckets: Record<string, string[]>
      }
      for (const [bucket, ids] of Object.entries(state.buckets)) {
        for (const id of ids) io.out(`${bucket.padEnd(14)} ${id}`)
      }
      return 0
    }

    case 'new': {
      const objective = parsed.positionals.join(' ')
      if (objective.length === 0) {
        io.err('usage: swarm new <objective> --workspace <id>')
        return 1
      }
      const id = await client.request(
        'createDelegation',
        {
          idempotencyKey: key(),
          spec: {
            specVersion: 1,
            objective,
            acceptance: [],
            workspace: { workspaceId: flagString(parsed.flags.workspace) ?? 'default' },
            model: { provider: 'anthropic', model: 'claude-opus-5', reasoningEffort: null },
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
            parallelAttempts: Number(parsed.flags.parallel ?? 1),
          },
        },
        key(),
      )
      io.out(String(id))
      return 0
    }

    case 'say': {
      const [delegationId, ...rest] = parsed.positionals
      if (delegationId === undefined || rest.length === 0) {
        io.err('usage: swarm say <delegationId> <text>')
        return 1
      }
      const turnId = await client.request(
        'sendTurn',
        {
          delegationId,
          directive: {
            text: rest.join(' '),
            idempotencyKey: key(),
            ...(parsed.flags.attempt === undefined
              ? {}
              : { attemptId: flagString(parsed.flags.attempt) }),
            ...(parsed.flags.delivery === undefined
              ? {}
              : { delivery: flagString(parsed.flags.delivery) }),
          },
        },
        key(),
      )
      io.out(String(turnId))
      return 0
    }

    case 'cancel': {
      const delegationId = parsed.positionals[0]
      if (delegationId === undefined) {
        io.err('usage: swarm cancel <delegationId> [--scope turn|delegation|hard]')
        return 1
      }
      await client.request(
        'cancel',
        { delegationId, options: { scope: flagString(parsed.flags.scope) ?? 'delegation' } },
        key(),
      )
      io.out(`cancelled ${delegationId}`)
      return 0
    }

    case 'verify': {
      const delegationId = parsed.positionals[0]
      if (delegationId === undefined) {
        io.err('usage: swarm verify <delegationId>')
        return 1
      }
      const runId = await client.request('verify', { delegationId, options: {} }, key())
      io.out(String(runId))
      return 0
    }

    case 'land': {
      const [delegationId, attemptId] = parsed.positionals
      if (delegationId === undefined || attemptId === undefined) {
        io.err('usage: swarm land <delegationId> <attemptId> [--mode commit|patch]')
        return 1
      }
      const landing = await client.request(
        'land',
        {
          delegationId,
          options: {
            attemptId,
            mode: flagString(parsed.flags.mode) ?? 'commit',
            ...(parsed.flags.branch === undefined
              ? {}
              : { targetBranch: flagString(parsed.flags.branch) }),
          },
        },
        key(),
      )
      io.out(JSON.stringify(landing))
      return 0
    }

    case 'watch': {
      const delegationId = parsed.positionals[0]
      const stream = delegationId === undefined ? 'fleet' : (`delegation:${delegationId}` as const)
      client.onEvent((event) => io.out(`${event.seq}\t${event.ev.k}`))
      await client.subscribe(stream, 'snapshot')
      await new Promise<void>((resolve) => setTimeout(resolve, Number(parsed.flags.ms ?? 2_000)))
      return 0
    }

    case 'logs': {
      /* §2.3: the audit trail is **not** a stream — it is read over HTTP, never through `sub`. */
      io.out('swarm logs --audit reads GET /debug/audit; the audit trail is not a stream (S13)')
      return 0
    }

    case 'gc': {
      io.out('gc removes worktrees, transcripts and attempt:* log rows; it never touches audit')
      return 0
    }

    default:
      io.err(`unknown verb '${parsed.verb}'\n\n${USAGE}`)
      return 1
  }
}

function flagString(value: string | true | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}
