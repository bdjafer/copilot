import type {
  StoredDerivation,
  StoredEpisode,
  StoredEvidence,
  StoredFact,
  StoredLifecycle,
  StoredRecord,
} from '../storage/driver.ts'
import type { DerivationPremise, JsonValue, OperationKind } from '../types.ts'

import { MemoryError } from '../errors.ts'

export function derivationPremiseKey(premise: DerivationPremise): string {
  return `${premise.kind}\u0000${premise.id}`
}

export function canonicalDerivationPremises(
  premises: readonly DerivationPremise[],
): DerivationPremise[] {
  return [
    ...new Map(
      premises.map((premise) => [derivationPremiseKey(premise), structuredClone(premise)]),
    ).values(),
  ].sort((left, right) => {
    const leftKey = derivationPremiseKey(left)
    const rightKey = derivationPremiseKey(right)
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0
  })
}

export function latestDerivationsByKey(
  derivations: readonly StoredDerivation[],
  recordedAtOrBefore?: string,
): Map<string, StoredDerivation> {
  const limit = recordedAtOrBefore === undefined ? undefined : Date.parse(recordedAtOrBefore)
  const latest = new Map<string, StoredDerivation>()
  for (const derivation of derivations) {
    if (limit !== undefined && Date.parse(derivation.recordedAt) > limit) continue
    const previous = latest.get(derivation.key)
    if (
      previous === undefined ||
      derivation.version > previous.version ||
      (derivation.version === previous.version && derivation.id > previous.id)
    ) {
      latest.set(derivation.key, derivation)
    }
  }
  return latest
}

export interface SupportCandidate {
  factId: string
  unsupportedStatus: 'retracted' | 'deleted'
  relatedId?: string
}

export interface TruthMaintenancePlan {
  puts: readonly (StoredDerivation | StoredFact | StoredLifecycle)[]
  invalidatedDerivations: readonly string[]
  unsupportedFacts: readonly string[]
  retainedFacts: readonly string[]
}

function overlayRecords(
  records: readonly StoredRecord[],
  puts: readonly StoredRecord[],
  deletes: readonly { kind: StoredRecord['kindRecord']; id: string }[],
): StoredRecord[] {
  const values = new Map<string, StoredRecord>()
  const key = (kind: StoredRecord['kindRecord'], id: string): string => `${kind}\u0000${id}`
  for (const record of records) values.set(key(record.kindRecord, record.id), record)
  for (const deletion of deletes) values.delete(key(deletion.kind, deletion.id))
  for (const record of puts) values.set(key(record.kindRecord, record.id), record)
  return [...values.values()]
}

function premiseAvailable(
  premise: DerivationPremise,
  facts: ReadonlyMap<string, StoredFact>,
  evidence: ReadonlyMap<string, StoredEvidence>,
  episodes: ReadonlyMap<string, StoredEpisode>,
): boolean {
  if (premise.kind === 'fact') return facts.get(premise.id)?.status === 'active'
  const link = evidence.get(premise.id)
  return link?.status === 'active' && episodes.get(link.episodeId)?.retentionState === 'retained'
}

function hasDirectSupport(
  factId: string,
  evidence: Iterable<StoredEvidence>,
  episodes: ReadonlyMap<string, StoredEpisode>,
): boolean {
  for (const link of evidence) {
    if (
      link.target.kind === 'fact' &&
      link.target.id === factId &&
      link.status === 'active' &&
      (link.relation === 'supports' || link.relation === 'corrects') &&
      episodes.get(link.episodeId)?.retentionState === 'retained'
    ) {
      return true
    }
  }
  return false
}

/**
 * Invalidates rule supports whose premises disappeared and retracts unsupported conclusions to a
 * fixpoint. The caller commits this plan atomically with the mutation that changed the premises.
 */
export function planTruthMaintenance(input: {
  records: readonly StoredRecord[]
  plannedPuts?: readonly StoredRecord[]
  plannedDeletes?: readonly { kind: StoredRecord['kindRecord']; id: string }[]
  supportCandidates?: readonly SupportCandidate[]
  operation: { id: string; kind: OperationKind }
  inputRevision: number
  recordedAt: string
}): TruthMaintenancePlan {
  let overlay = overlayRecords(input.records, input.plannedPuts ?? [], input.plannedDeletes ?? [])
  const resultPuts = new Map<string, StoredDerivation | StoredFact | StoredLifecycle>()
  const invalidatedDerivations: string[] = []
  const unsupportedFacts = new Set<string>()
  const retainedFacts = new Set<string>()
  const candidates = new Map<string, SupportCandidate>()
  for (const candidate of input.supportCandidates ?? []) candidates.set(candidate.factId, candidate)

  for (;;) {
    const facts = new Map(
      overlay
        .filter((record): record is StoredFact => record.kindRecord === 'fact')
        .map((record) => [record.id, record]),
    )
    const evidence = new Map(
      overlay
        .filter((record): record is StoredEvidence => record.kindRecord === 'evidence')
        .map((record) => [record.id, record]),
    )
    const episodes = new Map(
      overlay
        .filter((record): record is StoredEpisode => record.kindRecord === 'episode')
        .map((record) => [record.id, record]),
    )
    const derivations = overlay.filter(
      (record): record is StoredDerivation => record.kindRecord === 'derivation',
    )
    const latest = latestDerivationsByKey(derivations)
    let changed = false

    for (const derivation of [...latest.values()].sort((left, right) =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
    )) {
      if (derivation.state !== 'active') continue
      const invalidPremises = derivation.premises.filter(
        (premise) => !premiseAvailable(premise, facts, evidence, episodes),
      )
      if (invalidPremises.length === 0) continue
      if (derivation.recordedRevision === input.inputRevision + 1) {
        throw new MemoryError(
          'integrity_failed',
          'a new derivation was created with an unavailable premise',
          { operationId: input.operation.id },
        )
      }
      const version = derivation.version + 1
      const invalidated: StoredDerivation = {
        ...derivation,
        id: `derivation_${derivation.key}_${version.toString().padStart(8, '0')}`,
        version,
        inputRevision: input.inputRevision,
        recordedRevision: input.inputRevision + 1,
        recordedAt: input.recordedAt,
        operationId: input.operation.id,
        supersedes: derivation.id,
        state: 'invalidated',
        invalidPremises: canonicalDerivationPremises(invalidPremises),
        reason: 'premise-unavailable',
      }
      resultPuts.set(`derivation\u0000${invalidated.id}`, invalidated)
      invalidatedDerivations.push(invalidated.id)
      candidates.set(derivation.conclusionFactId, {
        factId: derivation.conclusionFactId,
        unsupportedStatus: 'retracted',
      })
      overlay.push(invalidated)
      changed = true
    }

    const refreshedLatest = latestDerivationsByKey(
      overlay.filter((record): record is StoredDerivation => record.kindRecord === 'derivation'),
    )
    const activeDerivedConclusions = new Set(
      [...refreshedLatest.values()]
        .filter((derivation) => derivation.state === 'active')
        .map((derivation) => derivation.conclusionFactId),
    )
    const pendingCandidates = [...candidates.values()]
    candidates.clear()
    for (const candidate of pendingCandidates.sort((left, right) =>
      left.factId < right.factId ? -1 : left.factId > right.factId ? 1 : 0,
    )) {
      const fact = facts.get(candidate.factId)
      if (fact === undefined) continue
      const supported =
        hasDirectSupport(fact.id, evidence.values(), episodes) ||
        activeDerivedConclusions.has(fact.id)
      if (supported) {
        retainedFacts.add(fact.id)
        continue
      }
      unsupportedFacts.add(fact.id)
      retainedFacts.delete(fact.id)
      if (!['active', 'disputed'].includes(fact.status)) continue
      const updated: StoredFact = {
        ...fact,
        status: candidate.unsupportedStatus,
        conflictGroup: undefined,
        ...(candidate.unsupportedStatus === 'deleted'
          ? { deletedAt: input.recordedAt }
          : { retractedAt: input.recordedAt }),
      }
      const lifecycle: StoredLifecycle = {
        kindRecord: 'lifecycle',
        id: `life_${input.operation.id}_fact_${fact.id}_support-unavailable`,
        spaceId: fact.spaceId,
        target: { kind: 'fact', id: fact.id },
        action: 'support-unavailable',
        recordedAt: input.recordedAt,
        operationId: input.operation.id,
        fromStatus: fact.status,
        toStatus: updated.status,
        ...(candidate.relatedId === undefined ? {} : { relatedId: candidate.relatedId }),
        snapshot: updated as unknown as JsonValue,
      }
      resultPuts.set(`fact\u0000${fact.id}`, updated)
      resultPuts.set(`lifecycle\u0000${lifecycle.id}`, lifecycle)
      overlay = overlayRecords(overlay, [updated, lifecycle], [])
      changed = true
    }
    if (!changed) break
  }

  return {
    puts: [...resultPuts.values()],
    invalidatedDerivations: [...new Set(invalidatedDerivations)].sort(),
    unsupportedFacts: [...unsupportedFacts].sort(),
    retainedFacts: [...retainedFacts].sort(),
  }
}
