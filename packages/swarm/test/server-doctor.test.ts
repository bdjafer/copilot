/**
 * SPEC-swarm §7.1, §11 and §13's doctor row: *"A stub binary reporting 0.64.2 produces
 * `version_floor` from `doctor` and from `serve` in under one second, with the fix command in the
 * message, and that message says **`jcode update`** — a test asserts the string, because
 * `jcode upgrade` errors with `unrecognized subcommand`."*
 *
 * Driven through a **real stub binary on disk** rather than an injected probe, because the thing
 * under test is the whole path: config → `executor.binary` → `spawnSync` → parse → exit code. An
 * injected probe would assert the parser, which `server-jcode.test.ts` already does.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { PreflightReport } from '../src/types.ts'

import { runCli } from '../src/cli/index.ts'
import { SERVER_POLICY } from '../src/domain/constants.ts'
import { writeServerConfig, defaultServerConfig } from '../src/server/config.ts'

const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

/** A `$SWARM_HOME` whose `config.json` points `executor.binary` at a stub that prints `version`. */
function homeWithStub(version: string | null): string {
  const home = mkdtempSync(join(tmpdir(), 'swarm-doctor-'))
  homes.push(home)
  const binDir = join(home, 'bin')
  mkdirSync(binDir, { recursive: true })
  const binary = join(binDir, 'jcode-stub')
  writeFileSync(
    binary,
    version === null
      ? '#!/bin/sh\nexit 127\n'
      : `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "jcode ${version}"; exit 0; fi\nexit 1\n`,
    { mode: 0o755 },
  )
  chmodSync(binary, 0o755)
  writeServerConfig(
    join(home, 'config.json'),
    defaultServerConfig({ port: 0, executor: { binary } }),
  )
  return home
}

function io(): { io: { out(l: string): void; err(l: string): void }; lines: string[] } {
  const lines: string[] = []
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(l) }, lines }
}

describe('§13 `swarm doctor` — exit 0 healthy / 1 blocked / 2 degraded', () => {
  it('a stub reporting 0.64.2 exits 1 with `version_floor` in under a second', async () => {
    const home = homeWithStub('0.64.2')
    const { io: sink, lines } = io()
    const started = Date.now()
    const code = await runCli(['doctor', '--home', home], { io: sink })
    const elapsed = Date.now() - started

    expect(code).toBe(1)
    expect(elapsed).toBeLessThan(1_000)
    const text = lines.join('\n')
    expect(text).toContain('0.64.2')
    expect(text).toContain('0.66.0')
    /* The one copy-pasteable string on the first-run screen has to be the one that works: `jcode
     * upgrade` errors with `unrecognized subcommand` (R15, §11). */
    expect(text).toContain(SERVER_POLICY.jcodeUpdateCommand)
    expect(text).toContain('jcode update')
    expect(text).not.toContain('jcode upgrade')
  })

  it('a stub reporting 0.67.1 exits 0', async () => {
    const home = homeWithStub('0.67.1')
    const { io: sink, lines } = io()
    expect(await runCli(['doctor', '--home', home], { io: sink })).toBe(0)
    expect(lines.join('\n')).toContain('0.67.1')
  })

  it('a missing binary exits 1 with `binary_missing`, never a hang (R1)', async () => {
    const home = homeWithStub(null)
    const { io: sink } = io()
    const started = Date.now()
    expect(await runCli(['doctor', '--home', home], { io: sink })).toBe(1)
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('`--json` emits the `PreflightReport` discriminants and nothing invented', async () => {
    const home = homeWithStub('0.64.2')
    const { io: sink, lines } = io()
    await runCli(['doctor', '--json', '--home', home], { io: sink })
    const report = JSON.parse(lines[0]!) as PreflightReport
    expect(Object.keys(report).sort()).toEqual(['blocked', 'detail', 'fix', 'ok', 'versions'])
    expect(report.ok).toBe(false)
    /* Exactly the discriminants §5.1 declares — a doctor that invents a reason is a doctor whose
     * exit code means nothing. */
    expect([
      'version_floor',
      'binary_missing',
      'socket_dir',
      'credentials',
      'no_route',
      null,
    ]).toContain(report.blocked)
    expect(report.fix).toBe('jcode update')
    expect(report.versions).toEqual({ jcode: '0.64.2' })
  })

  it('`serve` refuses to start below the floor, with the same message', async () => {
    const home = homeWithStub('0.64.2')
    const { io: sink, lines } = io()
    const started = Date.now()
    const code = await runCli(['serve', '--home', home, '--port', '0'], { io: sink })
    expect(code).toBe(1)
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(lines.join('\n')).toContain('jcode update')
  })
})

describe('`swarm help` names every verb the CLI actually implements', () => {
  /*
   * The usage block is the only discovery surface the binary has, and it drifts silently: `cancel`
   * has been a real verb since the intent existed and was missing from `--help` the whole time, so
   * the one destructive-adjacent command in the product was undiscoverable from the product.
   *
   * Read out of the source rather than a hand-kept list, so a verb added tomorrow is covered by
   * this test on the day it is added.
   */
  it('lists every `case` in the verb switch, and invents none', async () => {
    const source = readFileSync(new URL('../src/cli/index.ts', import.meta.url).pathname, 'utf8')
    const body = source.slice(source.indexOf('switch (parsed.verb)'))
    const implemented = new Set(
      [...body.matchAll(/^\s{4}case '([a-z]+)':/gm)].map((match) => match[1]!),
    )
    implemented.delete('help')
    expect(implemented.size).toBeGreaterThan(10)

    const { io: sink, lines } = io()
    expect(await runCli(['help'], { io: sink })).toBe(0)
    const usage = lines.join('\n')

    const missing = [...implemented]
      .filter((verb) => !new RegExp(`(^|[\\s|])${verb}([\\s|]|$)`, 'm').test(usage))
      .sort()
    expect(missing).toEqual([])
  })
})
