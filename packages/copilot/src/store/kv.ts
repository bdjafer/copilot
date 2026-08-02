// SPEC-copilot §2.7 — a run store over the injected `KeyValueAdapter`. Key layout `{ns}:r:{runId}`;
// `keep` ring-buffers terminal runs on write; `claim` is a lease key.
import type { KeyValueAdapter, Run, RunStore } from '../types.ts'

import { applyFilter, snapshot } from './memory.ts'

const TERMINAL = new Set(['done', 'error', 'cancelled'])

/** Identity function; preserves the concrete literal type of a store object. */
// eslint-disable-next-line no-explicit-any -- the locked signature (§2.7)
export function defineRunStore<const S extends RunStore<any>>(store: S): S {
  return store
}

export function createKeyValueRunStore<TContext = unknown>(
  kv: KeyValueAdapter,
  options?: { namespace?: string; keep?: number },
): RunStore<TContext> {
  const ns = options?.namespace ?? 'copilot'
  const runPrefix = `${ns}:r:`
  const leasePrefix = `${ns}:l:`
  const keyFor = (id: string) => `${runPrefix}${id}`

  const readAll = async (idPrefix?: string): Promise<Run<TContext>[]> => {
    const keys = await kv.keys(idPrefix === undefined ? runPrefix : `${runPrefix}${idPrefix}`)
    if (keys.length === 0) return []
    const entries = await kv.get(keys)
    const runs: Run<TContext>[] = []
    for (const key of keys) {
      const value = entries[key]
      if (value !== undefined && value !== null) runs.push(value as Run<TContext>)
    }
    return runs
  }

  return {
    name: 'key-value',
    async get(id) {
      const entries = await kv.get([keyFor(id)])
      const value = entries[keyFor(id)]
      return value === undefined || value === null ? null : (snapshot(value) as Run<TContext>)
    },
    async put(run) {
      await kv.set({ [keyFor(run.id)]: snapshot(run) })
      const keep = options?.keep
      if (keep === undefined || !TERMINAL.has(run.state)) return
      const terminal = (await readAll())
        .filter((candidate) => TERMINAL.has(candidate.state))
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      if (terminal.length <= keep) return
      const doomed = terminal.slice(0, terminal.length - keep).map((candidate) => candidate.id)
      await kv.remove([...doomed.map(keyFor), ...doomed.map((id) => `${leasePrefix}${id}`)])
    },
    async list(filter) {
      const runs = await readAll(filter?.idPrefix)
      return applyFilter(
        runs.map((run, index) => ({ run, seq: index })),
        filter,
      )
    },
    async claim(id, owner, ttlMs) {
      const key = `${leasePrefix}${id}`
      const entries = await kv.get([key])
      const lease = entries[key] as { owner?: string; expiresAt?: number } | undefined | null
      const now = Date.now()
      if (
        lease !== undefined &&
        lease !== null &&
        lease.owner !== owner &&
        typeof lease.expiresAt === 'number' &&
        lease.expiresAt > now
      ) {
        return false
      }
      await kv.set({ [key]: { owner, expiresAt: now + ttlMs } })
      return true
    },
  }
}

/** In-memory `KeyValueAdapter`, used by tests and by hosts without a real store. */
export function createMemoryKeyValueAdapter(): KeyValueAdapter & { size(): number } {
  const map = new Map<string, unknown>()
  return {
    async get(keys) {
      const out: Record<string, unknown> = {}
      for (const key of keys) if (map.has(key)) out[key] = snapshot(map.get(key))
      return out
    },
    async set(entries) {
      for (const [key, value] of Object.entries(entries)) map.set(key, snapshot(value))
    },
    async remove(keys) {
      for (const key of keys) map.delete(key)
    },
    async keys(prefix) {
      return [...map.keys()].filter((key) => key.startsWith(prefix))
    },
    size() {
      return map.size
    },
  }
}
