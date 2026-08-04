/**
 * SPEC-swarm §2.3, §3.5 — `storeConformance()` against **both** implementations (§13), plus the
 * DDL check and the SQLite-specific properties (WAL, `synchronous=FULL`, the eight tables).
 *
 * Running one suite against two stores is what keeps `src/log/types.ts` an interface rather than
 * a description of whatever SQLite happened to do.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import type { SwarmStore } from '../src/log/types.ts'

import { DDL, PRAGMAS, SCHEMA_VERSION, TABLES } from '../src/log/ddl.ts'
import { createSqliteStore } from '../src/server/store.ts'
import { makeActor, sampleEvent } from '../src/testing/fixtures.ts'
import { createMemoryBackend, createMemoryStore } from '../src/testing/memory-store.ts'
import { storeConformance, type StoreHarness } from '../src/testing/store-conformance.ts'

const roots: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'swarm-store-'))
  roots.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

function sqliteHarness(): StoreHarness {
  const path = join(tempDir(), 'swarm.db')
  let store = createSqliteStore(path)
  return {
    get store() {
      return store
    },
    reopen() {
      store = createSqliteStore(path)
      return store
    },
    dispose() {
      store.close()
    },
  } as StoreHarness
}

function memoryHarness(): StoreHarness {
  const backend = createMemoryBackend()
  let store: SwarmStore = createMemoryStore({ backend })
  return {
    get store() {
      return store
    },
    reopen() {
      store = createMemoryStore({ backend })
      return store
    },
    dispose() {
      store.close()
    },
  } as StoreHarness
}

describe('storeConformance() — node:sqlite', () => {
  for (const testCase of storeConformance(sqliteHarness)) {
    it(testCase.name, testCase.run)
  }
})

describe('storeConformance() — in-memory', () => {
  for (const testCase of storeConformance(memoryHarness)) {
    it(testCase.name, testCase.run)
  }
})

describe('§3.5 the DDL is the schema the spec names', () => {
  it('declares exactly the eight tables', () => {
    expect([...TABLES]).toEqual([
      'log',
      'stream_head',
      'records',
      'idem',
      'leases',
      'counters',
      'schema_version',
      'audit',
    ])
    expect(DDL).toHaveLength(TABLES.length)
    for (const [index, table] of TABLES.entries()) {
      expect(DDL[index]).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
  })

  it('keys the log on (stream, seq), which makes a reused seq unwritable', () => {
    expect(DDL[0]).toContain('PRIMARY KEY (stream, seq)')
  })

  it('runs WAL with synchronous=FULL, so an `ok` intent is durable (§3.5)', () => {
    expect([...PRAGMAS]).toContain('PRAGMA journal_mode = WAL')
    expect([...PRAGMAS]).toContain('PRAGMA synchronous = FULL')
  })

  it('gives audit its own autoincrement id and an effective column (S13)', () => {
    const audit = DDL[TABLES.indexOf('audit')]!
    expect(audit).toContain('id            INTEGER PRIMARY KEY AUTOINCREMENT')
    expect(audit).toContain('effective')
    expect(audit).toContain('correlation')
  })
})

describe('the SQLite store', () => {
  it('creates the eight tables and stamps the schema version', () => {
    const path = join(tempDir(), 'schema.db')
    const store = createSqliteStore(path)
    expect(store.schemaVersion).toBe(SCHEMA_VERSION)
    store.close()
    /* Reopening an existing file must not re-stamp or refuse. */
    const again = createSqliteStore(path)
    expect(again.schemaVersion).toBe(SCHEMA_VERSION)
    again.close()
  })

  it('refuses to nest transactions — one writer, one transaction (§3.5)', () => {
    const store = createSqliteStore(join(tempDir(), 'nest.db'))
    try {
      expect(() =>
        store.commit(() => {
          store.commit(() => undefined)
        }),
      ).toThrow(/do not nest/)
    } finally {
      store.close()
    }
  })

  it('refuses use after close', () => {
    const store = createSqliteStore(join(tempDir(), 'closed.db'))
    store.close()
    expect(() => store.read((tx) => tx.heads())).toThrow(/closed/)
  })

  it('keeps the payload and the kind in separate columns, and reassembles the event exactly', () => {
    const store = createSqliteStore(join(tempDir(), 'payload.db'))
    try {
      const event = sampleEvent('deleg.verify_result')
      store.commit((tx) =>
        tx.appendLog({
          stream: 'delegation:d-1',
          ev: event,
          actor: makeActor(),
          delegationId: 'd-1',
        }),
      )
      const [record] = store.read((tx) => tx.readLog('delegation:d-1', 0, 10))
      expect(record?.ev).toEqual(event)
      expect(record?.delegationId).toBe('d-1')
      expect(typeof record?.mono).toBe('number')
    } finally {
      store.close()
    }
  })
})
