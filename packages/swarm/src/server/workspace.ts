/**
 * The workspace guard, git plumbing, worktrees, diff and landing (SPEC-swarm §3.1 C4b, §7.3, §8,
 * decision log #23).
 *
 * **S6 — the one real boundary.** On every session creation *and* every verifier run: `realpath`
 * the requested path; assert it equals a registered root or begins with `root + sep`; assert no
 * component is a symlink escaping the root; assert the root is a git repository; else refuse with
 * `workspace_denied`. Checked on the **resolved** path, **every time** — never once at
 * registration, because a symlink planted after registration is exactly the attack the check is
 * for, and the agent can plant one.
 *
 * **C4b — no record ever holds a symbolic ref.** `resolveBaseRevision` runs
 * `git rev-parse --verify <baseRef>^{commit}` and stores the **full 40-char sha**; drift
 * detection (X13), verification locking (§8.6) and landing all key off a fixed sha, so storing
 * `'HEAD'` would silently disable all three while every surface still claimed they worked.
 *
 * Node ≥ 24, server-only.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { DiffVM, LandOptions, LandingRecord } from '../types.ts'
import type { WorkspaceRegistration } from './config.ts'

import { SwarmError } from '../errors.ts'

export interface GitResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/**
 * A scrubbed git invocation (S9, VE7). The env is a **complete map**, not a patch: acceptance
 * commands and worktree operations are agent-influenced, and inheriting the server's environment
 * hands the agent whatever the user exported into the shell that started `swarm serve`.
 */
export function runGit(cwd: string, args: readonly string[], timeoutMs = 30_000): GitResult {
  const result = spawnSync('git', args, {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    env: scrubbedEnv(),
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    code: result.status ?? (result.error === undefined ? -1 : 127),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? (result.error === undefined ? '' : String(result.error)),
  }
}

/** The base env every swarm-spawned child gets. Nothing else reaches it (§5.3, S9). */
export function scrubbedEnv(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    TZ: process.env.TZ ?? 'UTC',
  }
  for (const [key, value] of Object.entries(extra)) env[key] = value
  return env
}

/* ------------------------------------------------------------------------- S6 the allowlist */

export interface ResolvedWorkspace {
  readonly registration: WorkspaceRegistration
  /** The realpath of the registered root. */
  readonly root: string
  /** The realpath of the requested path, inside `root`. */
  readonly path: string
}

export class WorkspaceGuard {
  constructor(private registrations: readonly WorkspaceRegistration[]) {}

  update(registrations: readonly WorkspaceRegistration[]): void {
    this.registrations = registrations
  }

  list(): readonly WorkspaceRegistration[] {
    return this.registrations
  }

  find(workspaceId: string): WorkspaceRegistration | null {
    return this.registrations.find((w) => w.workspaceId === workspaceId) ?? null
  }

  /**
   * §7.3's algorithm, run **on every use**. `subPath` is joined before resolution, so
   * `../../etc` is refused by the prefix test rather than by a string check that
   * `..%2f..%2fetc` would walk straight past.
   */
  resolve(workspaceId: string, subPath?: string): ResolvedWorkspace {
    const registration = this.find(workspaceId)
    if (registration === null) {
      throw new SwarmError('workspace_denied', `workspace '${workspaceId}' is not registered`, {
        details: { workspaceId },
      })
    }
    const root = realpathOrRefuse(registration.root, workspaceId)
    const requested = subPath === undefined ? root : join(root, subPath)
    if (subPath !== undefined && isAbsolute(subPath)) {
      throw new SwarmError('workspace_denied', 'subPath must be relative to the workspace root', {
        details: { workspaceId, subPath },
      })
    }
    const resolved = realpathOrRefuse(requested, workspaceId)
    assertInside(root, resolved, workspaceId)
    assertNoEscapingSymlink(root, requested, workspaceId)
    assertGitRepository(root, workspaceId)
    return { registration, root, path: resolved }
  }

  /**
   * The verifier's entry point (§8 rule 1, §13). Identical algorithm, deliberately: a guard that
   * ran only at session creation would let a worktree the agent symlinked out of run acceptance
   * commands anywhere on disk.
   */
  assertInsideWorkspace(workspaceId: string, path: string): string {
    const registration = this.find(workspaceId)
    if (registration === null) {
      throw new SwarmError('workspace_denied', `workspace '${workspaceId}' is not registered`)
    }
    const root = realpathOrRefuse(registration.root, workspaceId)
    const resolved = realpathOrRefuse(path, workspaceId)
    assertInside(root, resolved, workspaceId)
    assertNoEscapingSymlink(root, path, workspaceId)
    return resolved
  }
}

function realpathOrRefuse(path: string, workspaceId: string): string {
  try {
    return realpathSync(resolve(path))
  } catch (error) {
    throw new SwarmError('workspace_denied', `path '${path}' does not resolve`, {
      details: { workspaceId, path },
      cause: error,
    })
  }
}

function assertInside(root: string, resolved: string, workspaceId: string): void {
  if (resolved === root) return
  if (resolved.startsWith(root.endsWith(sep) ? root : root + sep)) return
  throw new SwarmError('workspace_denied', `'${resolved}' is outside the workspace root`, {
    details: { workspaceId, root, resolved },
  })
}

/**
 * Walk every component of the *unresolved* path and refuse the first symlink whose target leaves
 * the root. The realpath prefix test above already catches the common case; this catches the one
 * where the final realpath lands back inside the root by way of a component that did not.
 */
function assertNoEscapingSymlink(root: string, requested: string, workspaceId: string): void {
  const rel = relative(root, resolve(requested))
  if (rel.length === 0) return
  let cursor = root
  for (const part of rel.split(sep)) {
    if (part.length === 0 || part === '.') continue
    cursor = join(cursor, part)
    let stat
    try {
      stat = lstatSync(cursor)
    } catch {
      /* A path that does not exist yet (a worktree about to be created) cannot be a symlink. */
      return
    }
    if (!stat.isSymbolicLink()) continue
    const target = realpathOrRefuse(cursor, workspaceId)
    assertInside(root, target, workspaceId)
  }
}

function assertGitRepository(root: string, workspaceId: string): void {
  const result = runGit(root, ['rev-parse', '--git-dir'])
  if (result.code !== 0) {
    throw new SwarmError('workspace_denied', `'${root}' is not a git repository`, {
      details: { workspaceId, root, detail: result.stderr.trim() },
    })
  }
}

/* --------------------------------------------------------------- C4b base revision resolution */

/** `git rev-parse --verify <ref>^{commit}` → the full 40-char sha, or `base_unresolvable`. */
export function resolveBaseRevision(root: string, baseRef: string): string {
  const result = runGit(root, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`])
  const sha = result.stdout.trim()
  if (result.code !== 0 || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new SwarmError('base_unresolvable', `baseRef '${baseRef}' did not resolve to a commit`, {
      details: { baseRef, detail: result.stderr.trim() },
    })
  }
  return sha
}

export function isDirty(root: string): boolean {
  return runGit(root, ['status', '--porcelain']).stdout.trim().length > 0
}

export function porcelainStatus(cwd: string): string {
  return runGit(cwd, ['status', '--porcelain']).stdout
}

/** The current HEAD sha of a working tree, or `null` when it has none (a fresh repo). */
export function headRevision(cwd: string): string | null {
  const result = runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const sha = result.stdout.trim()
  return result.code === 0 && sha.length === 40 ? sha : null
}

/* ------------------------------------------------------------------------------- worktrees */

export interface WorktreeSpec {
  readonly root: string
  readonly path: string
  readonly baseRevision: string
  readonly branch: string
}

/**
 * One worktree per attempt (F4). `git worktree add --detach` and not a branch: a branch name is a
 * shared namespace, and three parallel attempts on one objective would collide on it before the
 * `worktree:*` lease ever saw them.
 */
export function createWorktree(spec: WorktreeSpec): string {
  mkdirSync(dirname(spec.path), { recursive: true, mode: 0o700 })
  const result = runGit(spec.root, [
    'worktree',
    'add',
    '--detach',
    '--force',
    spec.path,
    spec.baseRevision,
  ])
  if (result.code !== 0) {
    throw new SwarmError('worktree_failed', `git worktree add failed: ${result.stderr.trim()}`, {
      details: { path: spec.path, baseRevision: spec.baseRevision },
    })
  }
  return spec.path
}

export function removeWorktree(root: string, path: string): void {
  runGit(root, ['worktree', 'remove', '--force', path])
  rmSync(path, { recursive: true, force: true })
  runGit(root, ['worktree', 'prune'])
}

/* ------------------------------------------------------------------------------------ diff */

/** `--numstat` + `--name-status` in one pass; hunks are read lazily by the head, never eagerly. */
export function diffAgainstBase(cwd: string, baseRevision: string, attemptId: string): DiffVM {
  const numstat = runGit(cwd, ['diff', '--numstat', baseRevision])
  const nameStatus = runGit(cwd, ['diff', '--name-status', baseRevision])
  const statusOf = new Map<string, DiffVM['files'][number]['status']>()
  for (const line of nameStatus.stdout.split('\n')) {
    const [code, path] = line.split('\t')
    if (code === undefined || path === undefined) continue
    statusOf.set(
      path,
      code.startsWith('A')
        ? 'added'
        : code.startsWith('D')
          ? 'deleted'
          : code.startsWith('R')
            ? 'renamed'
            : 'modified',
    )
  }

  const files: DiffVM['files'][number][] = []
  let insertions = 0
  let deletions = 0
  for (const line of numstat.stdout.split('\n')) {
    if (line.trim().length === 0) continue
    const [added, removed, path] = line.split('\t')
    if (path === undefined) continue
    const binary = added === '-' || removed === '-'
    const plus = binary ? 0 : Number(added ?? 0)
    const minus = binary ? 0 : Number(removed ?? 0)
    insertions += plus
    deletions += minus
    files.push({
      path,
      status: statusOf.get(path) ?? 'modified',
      insertions: plus,
      deletions: minus,
      binary,
      hunks: null,
    })
  }

  const current = headRevision(cwd)
  return {
    attemptId,
    baseRevision,
    staleBase: current !== null && current !== baseRevision,
    files,
    totals: { files: files.length, insertions, deletions },
    truncated: false,
  }
}

/* --------------------------------------------------------------------------------- landing */

export interface LandInput extends LandOptions {
  readonly root: string
  readonly worktree: string
  readonly baseRevision: string
  readonly at: number
}

/**
 * `commit` + `patch` only; `pr` is wave 2 (Q3). A moved base is surfaced as `base_moved` and
 * routed to `needs-you` — **never** silently rebased, because owning review and git identity is a
 * second product (decision log #23).
 */
export function land(input: LandInput): LandingRecord {
  if (input.mode === 'patch') {
    const diff = runGit(input.worktree, ['diff', input.baseRevision])
    if (diff.code !== 0) {
      throw new SwarmError('landing_conflict', `git diff failed: ${diff.stderr.trim()}`)
    }
    const outPath = input.outPath ?? join(input.worktree, `swarm-${input.attemptId}.patch`)
    mkdirSync(dirname(outPath), { recursive: true, mode: 0o700 })
    writeFileSync(outPath, diff.stdout, { mode: 0o600 })
    return {
      mode: 'patch',
      attemptId: input.attemptId,
      ref: input.baseRevision,
      patchPath: outPath,
      at: input.at,
    }
  }

  const branch = input.targetBranch ?? `swarm/${input.attemptId}`
  const add = runGit(input.worktree, ['add', '-A'])
  if (add.code !== 0) {
    throw new SwarmError('landing_conflict', `git add failed: ${add.stderr.trim()}`)
  }
  const message = input.message ?? `swarm: land attempt ${input.attemptId}`
  const commit = runGit(input.worktree, ['commit', '--no-verify', '-m', message])
  const nothingToCommit = /nothing to commit/i.test(commit.stdout + commit.stderr)
  if (commit.code !== 0 && !nothingToCommit) {
    throw new SwarmError('landing_conflict', `git commit failed: ${commit.stderr.trim()}`)
  }
  const sha = headRevision(input.worktree)
  if (sha === null) throw new SwarmError('landing_conflict', 'the worktree has no commit to land')
  const branchResult = runGit(input.root, ['branch', '--force', branch, sha])
  if (branchResult.code !== 0) {
    throw new SwarmError('landing_conflict', `git branch failed: ${branchResult.stderr.trim()}`)
  }
  return { mode: 'commit', attemptId: input.attemptId, ref: branch, sha, at: input.at }
}

/** Q10/§13: a base that has moved annotates; it never invalidates the evidence. */
export function baseHasMoved(root: string, baseRevision: string, ref = 'HEAD'): boolean {
  const current = runGit(root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${ref}^{commit}`,
  ]).stdout.trim()
  return current.length === 40 && current !== baseRevision
}

export function pathExists(path: string): boolean {
  return existsSync(path)
}
