/**
 * The jcode adapter wired as an `ExecutorHarness`, so `executorConformance()` runs against it
 * over `fakeJcodeTransport()` (SPEC-swarm §13).
 *
 * §13 requires the suite to pass "against `MockExecutor` in every capability configuration it
 * declares **and** against the jcode adapter over `fakeJcodeTransport()`". That second half is
 * the one that matters: the mock is a fiction swarm wrote, while the adapter is the code that
 * will meet the real bridge, and the fake reproduces the behaviours the spec cites source lines
 * for. The local jcode is 0.64.2 and has no `api-bridge`, so this is the only executable evidence
 * available until the version floor is crossed.
 *
 * Node ≥ 24 (temp dirs for `JCODE_HOME`); testing-only.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ExecutorSessionHandle, InstanceOptions } from '../../server/executor/types.ts'
import type { ConformanceTurn, ExecutorHarness } from '../executor-conformance.ts'
import type { FakeJcodeOptions } from './fake-jcode.ts'

import { createJcodeAdapter } from '../../server/executor/jcode.ts'
import { fakeJcodeTransport } from './fake-jcode.ts'

export interface JcodeHarnessOptions extends FakeJcodeOptions {
  /** `null` ⇒ no swarm-created group ⇒ `hardKill` refuses `capability_absent` (§4.3.7). */
  readonly pgid?: number | null
  readonly daemonPid?: number | null
  readonly acceptTimeoutMs?: number
}

export interface JcodeHarness extends ExecutorHarness {
  readonly bridge: ReturnType<typeof fakeJcodeTransport>['bridge']
  readonly transport: ReturnType<typeof fakeJcodeTransport>
  readonly home: string
}

export function jcodeExecutorHarness(options: JcodeHarnessOptions = {}): JcodeHarness {
  const home = mkdtempSync(join(tmpdir(), 'swarm-jcode-'))
  const transport = fakeJcodeTransport(options)
  const adapter = createJcodeAdapter({
    transport,
    /* The spawn is skipped: `socketPathOverride` connects to the fake instead, which is what lets
     * the whole adapter be exercised with no binary on a machine whose jcode predates the bridge. */
    socketPathOverride: join(home, 'api.sock'),
    /* The version gate still runs — with an injected probe, because the point is that the gate is
     * swarm's and unconditional, not that a binary happens to be present. */
    versionProbe: () => ({ code: 0, stdout: 'jcode 0.67.1', stderr: '' }),
    acceptTimeoutMs: options.acceptTimeoutMs ?? 40,
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.now === undefined ? {} : { now: options.now }),
  })

  const instanceOptions: InstanceOptions = {
    jcodeHome: join(home, 'home'),
    workingDir: home,
    /* S10: explicit, never defaulted. */
    inheritLogins: false,
    env: { PATH: '/usr/bin' },
    startupTimeoutMs: 2_000,
    cleanupTimeoutMs: 1_000,
    inheritStderr: false,
  }

  return {
    adapter,
    bridge: transport.bridge,
    transport,
    home,
    instanceKey: 'anthropic/claude-api',
    instanceOptions,
    scriptTurn(session: ExecutorSessionHandle, turn: ConformanceTurn) {
      transport.bridge.script(session.sessionId, turn)
    },
    disconnect(session: ExecutorSessionHandle) {
      transport.bridge.disconnect(session.sessionId)
    },
    dispose() {
      rmSync(home, { recursive: true, force: true })
    },
  }
}
