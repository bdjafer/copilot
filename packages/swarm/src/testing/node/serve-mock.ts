/**
 * `swarm serve`, in a real process, against `MockExecutor` (SPEC-swarm §7.1, §10).
 *
 * This is the **daemon**, not a stand-in for it: it goes through `runCli(['serve', …])`, so it
 * binds a real socket, writes a real `cli-token`, issues a real pairing code and runs the real
 * scheduler. The single substitution is the one `RunCliOptions.adapter` exists for — the executor
 * — and it is the substitution that makes the thing runnable at all, because every other path
 * reaches a model and spends the user's quota (S10, §10's *"so nobody dogfoods on real work on
 * day one"*).
 *
 * Two consumers, one file, deliberately:
 *
 *  - `test/e2e-journey.test.ts` spawns it as a child process. §7.1 is explicit that in-process is
 *    not enough — *"proving H10 only in-process proves that the client core can be called from
 *    Node, which was never in doubt"* — and a server that is `import`ed by its own test is still
 *    in-process no matter how many sockets it opens. A child process can be `SIGKILL`ed, which is
 *    the only honest way to test a crash.
 *  - `pnpm demo:serve` runs it as a program, so a human can pair the extension against something
 *    that cannot touch their work or their quota.
 *
 * The seeded workspace defaults to a throwaway git repository under the OS temp dir
 * (`createDemoRepo`), never a path inside the user's tree.
 *
 * Node ≥ 24; testing-only.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { CliIo } from '../../cli/index.ts'
import type { WorkspaceRegistration } from '../../server/config.ts'

import { runCli } from '../../cli/index.ts'
import { defaultServerConfig, swarmHomeLayout, writeServerConfig } from '../../server/config.ts'
import { MockExecutor } from '../mock-executor.ts'
import { createDemoRepo } from './demo-repo.ts'

/**
 * The machine-readable handshake, printed on stdout once the socket is bound.
 *
 * `serve` prints a sentence for a human; a parent process needs the port and the pairing code
 * without pattern-matching prose that is allowed to change. One JSON line, one prefix.
 */
export const SERVE_MOCK_READY_PREFIX = 'SWARM_MOCK_READY '

export interface ServeMockReady {
  readonly port: number
  readonly pairingCode: string
  readonly home: string
  readonly workspaceId: string
  readonly workspaceRoot: string
}

export interface ServeMockOptions {
  /** `$SWARM_HOME`. A path that survives the process is what makes a restart a *restart*. */
  readonly home?: string
  /** Registered workspace root. Omitted ⇒ a fresh seeded demo repo under `os.tmpdir()`. */
  readonly workspaceRoot?: string
  readonly workspaceId?: string
  /** `0` ⇒ ephemeral; the bound port is reported on the ready line. */
  readonly port?: number
  readonly io?: CliIo
  /** Printed after the ready line, for the human-facing demo. */
  readonly banner?: (ready: ServeMockReady) => readonly string[]
}

const STDIO_IO: CliIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}

/** `swarm 0.1.0 on 127.0.0.1:<port> — pairing code <code> (5 min, one use)`. */
const READY_LINE = /on 127\.0\.0\.1:(?<port>\d+).*pairing code (?<code>\S+)/u

/**
 * Run the daemon until `SIGINT`/`SIGTERM`. Resolves with the CLI's exit code.
 *
 * The workspace is registered in `config.json` before `serve` reads it, because `serve` is a CLI
 * verb and takes its workspaces from disk — wiring one in through an argument would be a second
 * code path that production does not have.
 */
export async function serveMock(options: ServeMockOptions = {}): Promise<number> {
  const io = options.io ?? STDIO_IO
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'swarm-mock-home-'))
  const seeded = options.workspaceRoot === undefined ? createDemoRepo() : null
  const root = options.workspaceRoot ?? seeded!.root
  const workspaceId = options.workspaceId ?? 'demo'

  const registration: WorkspaceRegistration = {
    workspaceId,
    root,
    label: 'swarm demo (throwaway)',
    /* §7.3: a worktree per attempt, so nothing the agent does lands in the registered root. */
    writeMode: 'worktree',
    sensitive: false,
  }
  const layout = swarmHomeLayout(home)
  writeServerConfig(
    layout.configPath,
    defaultServerConfig({
      port: options.port ?? 0,
      workspaces: [registration],
      /* S10, restated where a reader of the demo will see it: never the SDK's `true`. */
      executor: { inheritLogins: false },
    }),
  )

  let announced = false
  const relay: CliIo = {
    out(line) {
      io.out(line)
      if (announced) return
      const match = READY_LINE.exec(line)
      if (match?.groups === undefined) return
      announced = true
      const ready: ServeMockReady = {
        port: Number(match.groups.port),
        pairingCode: match.groups.code!,
        home,
        workspaceId,
        workspaceRoot: root,
      }
      io.out(`${SERVE_MOCK_READY_PREFIX}${JSON.stringify(ready)}`)
      for (const extra of options.banner?.(ready) ?? []) io.out(extra)
    },
    err: (line) => io.err(line),
  }

  try {
    /* The adapter is the *only* injection. Everything else — the socket, the token file, the
     * pairing code, the scheduler, the verifier — is the production path. */
    return await runCli(['serve', '--home', home], {
      io: relay,
      adapter: new MockExecutor(),
    })
  } finally {
    seeded?.remove()
    if (options.home === undefined) rmSync(home, { recursive: true, force: true })
  }
}

const DEMO_BANNER = (ready: ServeMockReady): readonly string[] => [
  '',
  '  ── swarm demo server (mock executor — no model, no quota, no network) ──',
  '',
  `  server        ws://127.0.0.1:${ready.port}/swarm`,
  `  pairing code  ${ready.pairingCode}     (5 minutes, one use)`,
  `  workspace     ${ready.workspaceId} → ${ready.workspaceRoot}`,
  `  SWARM_HOME    ${ready.home}`,
  '',
  '  Drive it from the CLI:',
  '',
  `    export SWARM_HOME=${ready.home}`,
  `    pnpm --filter @astrale-os/swarm exec node src/cli.ts status --port ${ready.port}`,
  `    pnpm --filter @astrale-os/swarm exec node src/cli.ts new "fix slugify" --workspace ${ready.workspaceId} --port ${ready.port}`,
  '',
  '  Or pair the extension: open its swarm page, enter the code above, endpoint 127.0.0.1:' +
    `${ready.port}.`,
  '',
  '  The workspace is a throwaway git repo in the OS temp dir and is deleted on exit.',
  '  Ctrl-C to stop.',
  '',
]

function parseFlags(argv: readonly string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) continue
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[arg.slice(2)] = next
      i++
    }
  }
  return flags
}

/** `node src/testing/node/serve-mock.ts [--home <dir>] [--port <n>] [--workspace-root <dir>]`. */
export async function serveMockMain(argv: readonly string[]): Promise<number> {
  const flags = parseFlags(argv)
  return serveMock({
    ...(flags.home === undefined ? {} : { home: flags.home }),
    ...(flags['workspace-root'] === undefined ? {} : { workspaceRoot: flags['workspace-root'] }),
    ...(flags.workspace === undefined ? {} : { workspaceId: flags.workspace }),
    port: flags.port === undefined ? 0 : Number(flags.port),
    ...(flags.quiet === undefined ? { banner: DEMO_BANNER } : {}),
  })
}

if (import.meta.main) {
  process.exitCode = await serveMockMain(process.argv.slice(2))
}
