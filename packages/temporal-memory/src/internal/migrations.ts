import type {
  StorageMigrationChange,
  StoredSchemaMigration,
  StoredSpace,
} from '../storage/driver.ts'
import type { JsonValue, SchemaMigration } from '../types.ts'

import { MemoryError } from '../errors.ts'
import { MAX_SCHEMA_MIGRATION_RECORDS } from '../storage/driver.ts'
import { assertInstant, cloneJson, sha256, stableStringify } from './value.ts'

interface SchemaMigrationDefinition {
  id: string
  sequence: number
  fromSchemaVersion: string
  toSchemaVersion: string
  defaults: StorageMigrationChange['defaults']
}

export interface SchemaMigrationPlan {
  migration: StoredSchemaMigration
  defaults: StorageMigrationChange['defaults']
}

const MIGRATION_HASH_DOMAIN = 'astrale.temporal-memory.schema-migration/v1'

/**
 * These declarations are append-only. Changing an existing declaration changes its checksum and
 * intentionally makes already-migrated storage fail closed.
 */
const DEFINITIONS: readonly SchemaMigrationDefinition[] = [
  {
    id: 'canonical-schema-5-to-6-signal-journal',
    sequence: 6,
    fromSchemaVersion: '5',
    toSchemaVersion: '6',
    defaults: { signalChangesCompactedThrough: 0 },
  },
  {
    id: 'canonical-schema-6-to-7-derivations',
    sequence: 7,
    fromSchemaVersion: '6',
    toSchemaVersion: '7',
    defaults: { metadataRevision: 0, canonicalRevision: 0 },
  },
]

function checksumDocument(definition: SchemaMigrationDefinition): JsonValue {
  return {
    domain: MIGRATION_HASH_DOMAIN,
    id: definition.id,
    sequence: definition.sequence,
    fromSchemaVersion: definition.fromSchemaVersion,
    toSchemaVersion: definition.toSchemaVersion,
    defaults: cloneJson(definition.defaults) as JsonValue,
  }
}

async function definitionChecksum(definition: SchemaMigrationDefinition): Promise<string> {
  return sha256(stableStringify(checksumDocument(definition)))
}

export async function schemaMigrationPlan(
  space: StoredSpace,
  appliedAt: string,
): Promise<SchemaMigrationPlan | null> {
  const definition = DEFINITIONS.find(
    (candidate) => candidate.fromSchemaVersion === space.schemaVersion,
  )
  if (definition === undefined) return null
  return {
    migration: {
      id: definition.id,
      spaceId: space.spaceId,
      sequence: definition.sequence,
      fromSchemaVersion: definition.fromSchemaVersion,
      toSchemaVersion: definition.toSchemaVersion,
      checksum: await definitionChecksum(definition),
      state: 'succeeded',
      appliedAt,
    },
    defaults: cloneJson(definition.defaults),
  }
}

export async function assertSchemaMigrationHistory(
  history: readonly StoredSchemaMigration[],
  expectedSpaceId: string,
  currentSchemaVersion: string,
): Promise<void> {
  if (history.length >= MAX_SCHEMA_MIGRATION_RECORDS) {
    throw new MemoryError('incompatible_schema', 'schema migration history exceeds its hard bound')
  }
  const ids = new Set<string>()
  let previous: StoredSchemaMigration | undefined
  for (const migration of history) {
    const definition = DEFINITIONS.find((candidate) => candidate.id === migration.id)
    if (
      definition === undefined ||
      migration.spaceId !== expectedSpaceId ||
      migration.state !== 'succeeded' ||
      migration.sequence !== definition.sequence ||
      migration.fromSchemaVersion !== definition.fromSchemaVersion ||
      migration.toSchemaVersion !== definition.toSchemaVersion ||
      migration.checksum !== (await definitionChecksum(definition)) ||
      ids.has(migration.id) ||
      (previous !== undefined && previous.sequence >= migration.sequence) ||
      (previous !== undefined && previous.toSchemaVersion !== migration.fromSchemaVersion)
    ) {
      throw new MemoryError(
        'incompatible_schema',
        'schema migration history is unknown, reordered, or checksum-invalid',
      )
    }
    try {
      assertInstant(migration.appliedAt, 'migration.appliedAt')
    } catch (error) {
      throw new MemoryError('incompatible_schema', 'schema migration history has invalid time', {
        cause: error,
      })
    }
    ids.add(migration.id)
    previous = migration
  }
  if (previous !== undefined && previous.toSchemaVersion !== currentSchemaVersion) {
    throw new MemoryError(
      'incompatible_schema',
      'schema version does not match its latest atomic migration checkpoint',
    )
  }
}

export function publicSchemaMigration(migration: StoredSchemaMigration): SchemaMigration {
  return {
    id: migration.id,
    sequence: migration.sequence,
    fromSchemaVersion: migration.fromSchemaVersion,
    toSchemaVersion: migration.toSchemaVersion,
    checksum: migration.checksum,
    state: migration.state,
    appliedAt: migration.appliedAt,
  }
}
