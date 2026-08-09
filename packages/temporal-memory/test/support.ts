import { createMemory, type MemoryOptions, type Ontology } from '../src/index.ts'
import { createInMemoryStorage } from '../src/testing/index.ts'

export const OPEN_ONTOLOGY: Ontology = {
  id: 'test.open',
  version: '1',
  mode: 'open',
  entityTypes: {},
  factTypes: {},
}

export const WORK_ONTOLOGY: Ontology = {
  id: 'test.work',
  version: '1',
  mode: 'prescribed',
  entityTypes: {
    Person: {},
    Company: {},
  },
  factTypes: {
    Employment: {
      predicate: 'works_at',
      subjectTypes: ['Person'],
      object: { kind: 'entity', types: ['Company'] },
      cardinality: 'one',
      temporal: 'interval',
    },
  },
}

export function harness(options: Partial<MemoryOptions> = {}) {
  let next = 0
  const storage = options.storage ?? createInMemoryStorage()
  const memory = createMemory({
    spaceId: 'space-1',
    storage,
    ontology: OPEN_ONTOLOGY,
    now: () => new Date('2026-08-03T10:00:00.000Z'),
    createId: () => `id-${++next}`,
    ...options,
  })
  return { memory, storage }
}
