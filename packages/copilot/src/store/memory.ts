// SPEC-copilot §2.7 — the default run store. Records are stored as JSON snapshots so the memory
// adapter and a real key-value adapter agree on the round-trip contract of §2.2.
import type { Run, RunFilter, RunStore } from '../types.ts'

export function snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function matchesFilter(run: Run, filter: RunFilter | undefined): boolean {
  if (filter === undefined) return true
  if (filter.state !== undefined) {
    const states = Array.isArray(filter.state) ? filter.state : [filter.state]
    if (!states.includes(run.state)) return false
  }
  if (filter.idPrefix !== undefined && !run.id.startsWith(filter.idPrefix)) return false
  if (filter.before !== undefined && !(run.createdAt < filter.before)) return false
  return true
}

/** `list` returns runs sorted by `createdAt` ascending; ties keep insertion order. */
export function applyFilter<TContext>(
  runs: Array<{ run: Run<TContext>; seq: number }>,
  filter: RunFilter | undefined,
): Run<TContext>[] {
  const kept = runs.filter((entry) => matchesFilter(entry.run as Run, filter))
  kept.sort((a, b) =>
    a.run.createdAt === b.run.createdAt
      ? a.seq - b.seq
      : a.run.createdAt < b.run.createdAt
        ? -1
        : 1,
  )
  const limited = filter?.limit === undefined ? kept : kept.slice(0, Math.max(0, filter.limit))
  return limited.map((entry) => snapshot(entry.run))
}

export function createMemoryRunStore<TContext = unknown>(): RunStore<TContext> & {
  snapshot(): Run<TContext>[]
} {
  const runs = new Map<string, { run: Run<TContext>; seq: number }>()
  const leases = new Map<string, { owner: string; expiresAt: number }>()
  let seq = 0

  const all = () => [...runs.values()]

  return {
    name: 'memory',
    async get(id) {
      const entry = runs.get(id)
      return entry === undefined ? null : snapshot(entry.run)
    },
    async put(run) {
      const existing = runs.get(run.id)
      runs.set(run.id, {
        run: snapshot(run),
        seq: existing?.seq ?? (seq += 1),
      })
    },
    async list(filter) {
      return applyFilter(all(), filter)
    },
    async claim(id, owner, ttlMs) {
      const lease = leases.get(id)
      const now = Date.now()
      if (lease !== undefined && lease.owner !== owner && lease.expiresAt > now) return false
      leases.set(id, { owner, expiresAt: now + ttlMs })
      return true
    },
    snapshot() {
      return applyFilter(all(), undefined)
    },
  }
}
