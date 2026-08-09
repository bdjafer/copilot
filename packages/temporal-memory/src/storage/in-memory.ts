import type { MemoryStorage, StorageInspection } from '../types.ts'

import { MemoryError } from '../errors.ts'
import { compareUnicode } from '../internal/value.ts'
import {
  assertStorageRuntimeOwnerId,
  assertStorageMigrationChange,
  assertStorageCommitSemantics,
  CANONICAL_SCHEMA_VERSION,
  defineMemoryStorage,
  LOCAL_METADATA_KINDS,
  MAX_SCHEMA_MIGRATION_RECORDS,
  materializeStoredChange,
  materializeStoredSignalChange,
  type RankedStoredRecord,
  type RecordOfKind,
  type StorageCountQuery,
  type StorageCommit,
  type StorageDriver,
  type StorageFilter,
  type StorageMigrationChange,
  type StorageQuery,
  type StorageRuntimeLease,
  type StoredProjection,
  type StoredRecord,
  type StoredRecordKind,
  type StoredSchemaMigration,
  type StoredSpace,
} from './driver.ts'

function clone<T>(value: T): T {
  return structuredClone(value)
}

function key(spaceId: string, id: string): string {
  return `${spaceId}\u0000${id}`
}

const LOGICAL_QUERY_PATHS: Readonly<Record<string, string>> = {
  episodeKind: 'kind',
  retentionState: 'retentionState',
  retentionPolicy: 'retention',
  sensitivity: 'sensitivity',
  observedAt: 'observedAt',
  sourceKind: 'source.kind',
  sourceOrigin: 'source.origin',
  sourceExternalId: 'source.externalId',
  sourceThreadId: 'source.threadId',
  sourceDocumentId: 'source.documentId',
  sourceCapturedAt: 'source.capturedAt',
  tags: 'tags',
}

function valueAt(record: object, path: string): unknown {
  if ('kindRecord' in record && record.kindRecord === 'derivation') {
    const premises = (record as { premises?: readonly { kind: string; id: string }[] }).premises
    if (path === 'premiseFactIds') {
      return premises?.filter((premise) => premise.kind === 'fact').map((premise) => premise.id)
    }
    if (path === 'premiseEvidenceIds') {
      return premises?.filter((premise) => premise.kind === 'evidence').map((premise) => premise.id)
    }
  }
  let value: unknown = record
  for (const part of (LOGICAL_QUERY_PATHS[path] ?? path).split('.')) {
    if (typeof value !== 'object' || value === null) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false
  }
  return JSON.stringify(left) === JSON.stringify(right)
}

function compare(left: unknown, right: unknown): number {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return compareUnicode(String(left), String(right))
}

function matches(record: StoredRecord, filter: StorageFilter): boolean {
  const actual = valueAt(record, filter.field)
  if (filter.op === 'defined') return actual !== undefined
  switch (filter.op) {
    case 'eq':
      return equal(actual, filter.value)
    case 'ne':
      return !equal(actual, filter.value)
    case 'lt':
      return compare(actual, filter.value) < 0
    case 'lte':
      return compare(actual, filter.value) <= 0
    case 'gt':
      return compare(actual, filter.value) > 0
    case 'gte':
      return compare(actual, filter.value) >= 0
    case 'in':
      return filter.value.some((candidate) => equal(actual, candidate))
    case 'contains':
      if (Array.isArray(actual)) return actual.some((candidate) => equal(candidate, filter.value))
      return typeof actual === 'string' && typeof filter.value === 'string'
        ? actual.includes(filter.value)
        : false
    case 'all_inside':
      return (
        Array.isArray(actual) &&
        actual.every((candidate) => filter.value.some((allowed) => equal(candidate, allowed)))
      )
    case 'contains_all':
      return (
        Array.isArray(actual) &&
        filter.value.every((required) => actual.some((candidate) => equal(candidate, required)))
      )
    case 'contains_any':
      return (
        Array.isArray(actual) &&
        filter.value.some((required) => actual.some((candidate) => equal(candidate, required)))
      )
    case 'contains_none':
      return (
        Array.isArray(actual) &&
        filter.value.every((excluded) => !actual.some((candidate) => equal(candidate, excluded)))
      )
  }
}

function words(value: string): string[] {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
}

function lexicalScore(text: string, query: string): number {
  const queryWords = words(query)
  if (queryWords.length === 0) return 0
  const textWords = words(text)
  const counts = new Map<string, number>()
  for (const word of textWords) counts.set(word, (counts.get(word) ?? 0) + 1)
  let score = 0
  for (const word of queryWords) score += counts.get(word) ?? 0
  if (text.toLocaleLowerCase('en-US').includes(query.toLocaleLowerCase('en-US'))) score += 2
  return score / Math.max(1, Math.sqrt(textWords.length))
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return Number.NEGATIVE_INFINITY
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    dot += a * b
    leftNorm += a * a
    rightNorm += b * b
  }
  if (leftNorm === 0 || rightNorm === 0) return Number.NEGATIVE_INFINITY
  return dot / Math.sqrt(leftNorm * rightNorm)
}

class InMemoryDriver implements StorageDriver {
  readonly name: string
  readonly #spaces = new Map<string, StoredSpace>()
  readonly #migrations = new Map<string, StoredSchemaMigration>()
  readonly #records = new Map<StoredRecordKind, Map<string, StoredRecord>>()
  readonly #runtimeOwners = new Set<string>()
  #openCount = 0
  #tail: Promise<void> = Promise.resolve()

  constructor(name: string) {
    this.name = name
  }

  async #locked<T>(run: () => T | Promise<T>): Promise<T> {
    const previous = this.#tail
    let release: () => void = () => undefined
    this.#tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await run()
    } finally {
      release()
    }
  }

  #table(kind: StoredRecordKind): Map<string, StoredRecord> {
    let table = this.#records.get(kind)
    if (table === undefined) {
      table = new Map()
      this.#records.set(kind, table)
    }
    return table
  }

  #assertOpen(): void {
    if (this.#openCount === 0) throw new MemoryError('storage_failed', 'storage is not open')
  }

  async open(): Promise<void> {
    this.#openCount += 1
  }

  async close(): Promise<void> {
    this.#openCount = Math.max(0, this.#openCount - 1)
  }

  async acquireRuntimeLease(ownerId: string): Promise<StorageRuntimeLease> {
    this.#assertOpen()
    assertStorageRuntimeOwnerId(ownerId)
    await this.#locked(() => {
      if (this.#runtimeOwners.has(ownerId)) {
        throw new MemoryError('integrity_failed', 'runtime owner lease is already held')
      }
      this.#runtimeOwners.add(ownerId)
    })
    let active = true
    return {
      release: async () => {
        if (!active) return
        active = false
        await this.#locked(() => {
          this.#runtimeOwners.delete(ownerId)
        })
      },
    }
  }

  async runtimeLeaseActive(ownerId: string): Promise<boolean> {
    this.#assertOpen()
    assertStorageRuntimeOwnerId(ownerId)
    return this.#runtimeOwners.has(ownerId)
  }

  async inspect(): Promise<StorageInspection> {
    return {
      name: this.name,
      open: this.#openCount > 0,
      persistent: false,
      engine: 'memory',
      schemaVersion: CANONICAL_SCHEMA_VERSION,
    }
  }

  async createSpace(space: StoredSpace): Promise<void> {
    this.#assertOpen()
    await this.#locked(() => {
      if (this.#spaces.has(space.spaceId)) {
        throw new MemoryError('space_exists', `memory space already exists: ${space.spaceId}`)
      }
      this.#spaces.set(space.spaceId, clone(space))
    })
  }

  async getSpace(spaceId: string): Promise<StoredSpace | null> {
    this.#assertOpen()
    const space = this.#spaces.get(spaceId)
    return space === undefined ? null : clone(space)
  }

  async migrationHistory(spaceId: string): Promise<StoredSchemaMigration[]> {
    this.#assertOpen()
    return clone(
      [...this.#migrations.values()]
        .filter((migration) => migration.spaceId === spaceId)
        .sort((left, right) => left.sequence - right.sequence || compareUnicode(left.id, right.id))
        .slice(0, MAX_SCHEMA_MIGRATION_RECORDS),
    )
  }

  async applyMigration(change: StorageMigrationChange): Promise<StoredSpace> {
    this.#assertOpen()
    assertStorageMigrationChange(change)
    return this.#locked(() => {
      const current = this.#spaces.get(change.spaceId)
      if (current === undefined) throw new MemoryError('space_not_found')
      const migrationKey = key(change.spaceId, change.migration.id)
      const existing = this.#migrations.get(migrationKey)
      if (
        existing !== undefined &&
        existing.checksum === change.migration.checksum &&
        current.schemaVersion === change.migration.toSchemaVersion
      ) {
        return clone(current)
      }
      if (existing !== undefined) {
        throw new MemoryError('integrity_failed', 'schema migration checkpoint already differs')
      }
      if (
        current.revision !== change.expectedRevision ||
        (current.metadataRevision ?? 0) !== change.expectedMetadataRevision ||
        current.schemaVersion !== change.expectedSchemaVersion
      ) {
        throw new MemoryError('conflict', 'schema migration premise changed', { retryable: true })
      }
      const updated: StoredSpace = {
        ...current,
        schemaVersion: change.migration.toSchemaVersion,
        metadataRevision: (current.metadataRevision ?? change.defaults.metadataRevision ?? 0) + 1,
        canonicalRevision: current.canonicalRevision ?? change.defaults.canonicalRevision,
        signalChangesCompactedThrough:
          current.signalChangesCompactedThrough ??
          change.defaults.signalChangesCompactedThrough ??
          0,
      }
      this.#spaces.set(change.spaceId, clone(updated))
      this.#migrations.set(migrationKey, clone(change.migration))
      return clone(updated)
    })
  }

  async deleteSpace(spaceId: string, expectedRevision: number): Promise<void> {
    this.#assertOpen()
    await this.#locked(() => {
      const space = this.#spaces.get(spaceId)
      if (space === undefined) throw new MemoryError('space_not_found')
      if (space.revision !== expectedRevision) throw new MemoryError('conflict', 'revision changed')
      this.#spaces.delete(spaceId)
      for (const [migrationKey, migration] of this.#migrations) {
        if (migration.spaceId === spaceId) this.#migrations.delete(migrationKey)
      }
      for (const table of this.#records.values()) {
        for (const [recordKey, record] of table) {
          if (record.spaceId === spaceId) table.delete(recordKey)
        }
      }
    })
  }

  async get<K extends StoredRecordKind>(
    kind: K,
    spaceId: string,
    id: string,
  ): Promise<RecordOfKind<K> | null> {
    this.#assertOpen()
    const record = this.#table(kind).get(key(spaceId, id))
    return record === undefined ? null : (clone(record) as RecordOfKind<K>)
  }

  async query<K extends StoredRecordKind>(query: StorageQuery<K>): Promise<RecordOfKind<K>[]> {
    this.#assertOpen()
    if (
      query.startAfter !== undefined &&
      (query.order === undefined || query.startAfter.length !== query.order.length)
    ) {
      throw new MemoryError('invalid_input', 'storage startAfter must match query order')
    }
    let records = [...this.#table(query.kind).values()].filter(
      (record): record is RecordOfKind<K> =>
        record.spaceId === query.spaceId &&
        (query.filters?.every((filter) => matches(record, filter)) ?? true),
    )
    if (query.startAfter !== undefined) {
      records = records.filter((record) => {
        for (const [index, order] of query.order!.entries()) {
          const compared = compare(valueAt(record, order.field), query.startAfter![index])
          if (compared !== 0) return order.direction === 'asc' ? compared > 0 : compared < 0
        }
        return false
      })
    }
    if (query.order !== undefined) {
      records.sort((left, right) => {
        for (const order of query.order ?? []) {
          const compared = compare(valueAt(left, order.field), valueAt(right, order.field))
          if (compared !== 0) return order.direction === 'asc' ? compared : -compared
        }
        return compareUnicode(left.id, right.id)
      })
    }
    if (query.limit !== undefined) records = records.slice(0, query.limit)
    return clone(records)
  }

  async count<K extends StoredRecordKind>(query: StorageCountQuery<K>): Promise<number> {
    this.#assertOpen()
    return [...this.#table(query.kind).values()].filter(
      (record) =>
        record.spaceId === query.spaceId &&
        (query.filters?.every((filter) => matches(record, filter)) ?? true),
    ).length
  }

  async commit(change: StorageCommit): Promise<number> {
    this.#assertOpen()
    assertStorageCommitSemantics(change)
    return this.#locked(() => {
      const space = this.#spaces.get(change.spaceId)
      if (space === undefined) throw new MemoryError('space_not_found')
      if (space.revision !== change.expectedRevision) {
        throw new MemoryError('conflict', 'memory space changed during the operation', {
          retryable: true,
        })
      }
      if (
        change.expectedCanonicalRevision !== undefined &&
        (space.canonicalRevision ?? 0) !== change.expectedCanonicalRevision
      ) {
        throw new MemoryError('conflict', 'canonical memory changed during the operation', {
          retryable: true,
        })
      }
      if (
        change.changeCompaction !== undefined &&
        change.changeCompaction.throughRevision < space.changesCompactedThrough
      ) {
        throw new MemoryError(
          'integrity_failed',
          'semantic change compaction floor moved backwards',
        )
      }
      if (
        change.signalChangeCompaction !== undefined &&
        change.signalChangeCompaction.throughRevision < space.signalChangesCompactedThrough
      ) {
        throw new MemoryError('integrity_failed', 'signal change compaction floor moved backwards')
      }
      for (const record of change.puts ?? []) {
        if (record.spaceId !== change.spaceId) {
          throw new MemoryError('integrity_failed', 'cross-space record in commit')
        }
      }
      for (const guard of change.metadataGuards ?? []) {
        const current = this.#table(guard.kind).get(key(change.spaceId, guard.id))
        if (
          (guard.expected === null && current !== undefined) ||
          (guard.expected !== null && (current === undefined || !equal(current, guard.expected)))
        ) {
          throw new MemoryError('conflict', 'local metadata changed', { retryable: true })
        }
      }
      if (change.changeCompaction !== undefined) {
        const changes = this.#table('change')
        for (const [recordKey, record] of changes) {
          if (
            record.spaceId === change.spaceId &&
            record.kindRecord === 'change' &&
            record.revision <= change.changeCompaction.throughRevision
          ) {
            changes.delete(recordKey)
          }
        }
      }
      if (change.signalChangeCompaction !== undefined) {
        const changes = this.#table('signal_change')
        for (const [recordKey, record] of changes) {
          if (
            record.spaceId === change.spaceId &&
            record.kindRecord === 'signal_change' &&
            record.revision <= change.signalChangeCompaction.throughRevision
          ) {
            changes.delete(recordKey)
          }
        }
      }
      if (change.signalKeyDeletes !== undefined) {
        const selectedKeys = new Set(change.signalKeyDeletes)
        const signals = this.#table('signal')
        for (const [recordKey, record] of signals) {
          if (
            record.spaceId === change.spaceId &&
            record.kindRecord === 'signal' &&
            selectedKeys.has(record.key)
          ) {
            signals.delete(recordKey)
          }
        }
      }
      for (const deletion of change.deletes ?? []) {
        this.#table(deletion.kind).delete(key(change.spaceId, deletion.id))
      }
      for (const record of change.puts ?? []) {
        this.#table(record.kindRecord).set(key(change.spaceId, record.id), clone(record))
      }
      for (const activation of change.projectionSetActivations ?? []) {
        const projections = this.#table('projection')
        for (const [recordKey, record] of projections) {
          if (
            record.kindRecord === 'projection' &&
            record.spaceId === change.spaceId &&
            record.projectionKind === activation.kind &&
            record.setId === activation.set.id &&
            record.state === 'building'
          ) {
            projections.set(recordKey, clone({ ...record, state: 'ready' }))
          }
        }
      }
      const updatedAt = new Date().toISOString()
      const metadataRevision = (space.metadataRevision ?? 0) + 1
      if (change.metadataOnly === true) {
        this.#spaces.set(change.spaceId, { ...space, metadataRevision, updatedAt })
        return space.revision
      }
      const revision = space.revision + 1
      const canonicalRevision =
        (space.canonicalRevision ?? 0) + (change.semanticChange === undefined ? 0 : 1)
      if (change.semanticChange !== undefined) {
        const record = materializeStoredChange(
          change.spaceId,
          revision,
          updatedAt,
          change.semanticChange,
        )
        this.#table('change').set(key(change.spaceId, record.id), clone(record))
      }
      if (change.signalChange !== undefined) {
        const record = materializeStoredSignalChange(
          change.spaceId,
          revision,
          updatedAt,
          change.signalChange,
        )
        this.#table('signal_change').set(key(change.spaceId, record.id), clone(record))
      }
      this.#spaces.set(change.spaceId, {
        ...space,
        revision,
        canonicalRevision,
        metadataRevision,
        updatedAt,
        changesCompactedThrough:
          change.changeCompaction?.throughRevision ?? space.changesCompactedThrough,
        signalChangesCompactedThrough:
          change.signalChangeCompaction?.throughRevision ?? space.signalChangesCompactedThrough,
        ...(change.projectionSetActivations === undefined
          ? {}
          : {
              projectionSets: {
                ...space.projectionSets,
                ...Object.fromEntries(
                  change.projectionSetActivations.map(({ kind, set }) => [kind, clone(set)]),
                ),
              },
            }),
      })
      return revision
    })
  }

  async lexicalSearch(
    spaceId: string,
    query: string,
    generation: string,
    allowedScopes: readonly string[],
    limit: number,
    setId?: string,
  ): Promise<RankedStoredRecord<'projection'>[]> {
    const projections = await this.query({
      kind: 'projection',
      spaceId,
      filters: [
        { field: 'projectionKind', op: 'eq', value: 'lexical' },
        { field: 'generation', op: 'eq', value: generation },
        { field: 'state', op: 'eq', value: 'ready' },
      ],
    })
    return projections
      .filter((record) => record.setId === setId)
      .filter((record) => record.scopes.every((scope) => allowedScopes.includes(scope)))
      .map((record) => ({ record, score: lexicalScore(record.text ?? '', query) }))
      .filter((result) => result.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || compareUnicode(left.record.id, right.record.id),
      )
      .slice(0, limit)
  }

  async vectorSearch(
    spaceId: string,
    vector: readonly number[],
    generation: string,
    allowedScopes: readonly string[],
    limit: number,
    setId?: string,
  ): Promise<RankedStoredRecord<'projection'>[]> {
    const projections = await this.query({
      kind: 'projection',
      spaceId,
      filters: [
        { field: 'projectionKind', op: 'eq', value: 'embedding' },
        { field: 'generation', op: 'eq', value: generation },
        { field: 'state', op: 'eq', value: 'ready' },
      ],
    })
    return projections
      .filter((record) => record.setId === setId)
      .filter((record) => record.scopes.every((scope) => allowedScopes.includes(scope)))
      .map((record) => ({ record, score: cosine(record.vector ?? [], vector) }))
      .filter((result) => Number.isFinite(result.score))
      .sort(
        (left, right) =>
          right.score - left.score || compareUnicode(left.record.id, right.record.id),
      )
      .slice(0, limit)
  }

  async exportRecords(spaceId: string): Promise<StoredRecord[]> {
    this.#assertOpen()
    const records: StoredRecord[] = []
    for (const [kind, table] of this.#records) {
      if (LOCAL_METADATA_KINDS.has(kind)) continue
      for (const record of table.values()) {
        if (record.spaceId === spaceId) records.push(clone(record))
      }
    }
    return records.sort(
      (left, right) =>
        compareUnicode(left.kindRecord, right.kindRecord) || compareUnicode(left.id, right.id),
    )
  }
}

export function createInMemoryStorage(options: { name?: string } = {}): MemoryStorage {
  return defineMemoryStorage(new InMemoryDriver(options.name ?? 'memory'))
}

export function projectionText(record: StoredProjection): string {
  return record.text ?? ''
}
