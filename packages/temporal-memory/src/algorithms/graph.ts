import { compareUnicode } from '../internal/value.ts'

export interface StructuralEdge {
  id: string
  source: string
  target: string
}

export interface StructuralGraphOptions {
  damping?: number
  iterations?: number
  tolerance?: number
  seeds?: readonly { id: string; weight?: number }[]
}

export interface StructuralNodeMetric {
  id: string
  degree: number
  inDegree: number
  outDegree: number
  pageRank: number
  component: number
}

export interface StructuralGraphReport {
  nodes: readonly StructuralNodeMetric[]
  /** Entity-valued fact edges; parallel facts remain distinct PageRank links. */
  edgeCount: number
  /** Unique directed source/target pairs used for bounded adjacency density. */
  arcCount: number
  componentCount: number
  density: number
  damping: number
  iterations: number
  tolerance: number
  converged: boolean
  personalized: boolean
  seedCount: number
}

/**
 * Deterministic structural analysis only. Scores describe graph position; they are never truth,
 * confidence, authority, or source quality.
 */
export function analyzeStructuralGraph(
  nodeIds: readonly string[],
  inputEdges: readonly StructuralEdge[],
  options: StructuralGraphOptions = {},
): StructuralGraphReport {
  const damping = options.damping ?? 0.85
  const maximumIterations = options.iterations ?? 40
  const tolerance = options.tolerance ?? 1e-10
  if (!Number.isFinite(damping) || damping <= 0 || damping >= 1) {
    throw new RangeError('pagerank damping must be between 0 and 1')
  }
  if (!Number.isInteger(maximumIterations) || maximumIterations < 1 || maximumIterations > 1_000) {
    throw new RangeError('pagerank iterations must be between 1 and 1000')
  }
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= 1) {
    throw new RangeError('pagerank tolerance must be between 0 and 1')
  }

  const ids = [...new Set(nodeIds)].sort(compareUnicode)
  const known = new Set(ids)
  if (ids.length === 0) {
    if (options.seeds !== undefined && options.seeds.length > 0) {
      throw new RangeError('pagerank seeds must reference graph nodes')
    }
    return {
      nodes: [],
      edgeCount: 0,
      arcCount: 0,
      componentCount: 0,
      density: 0,
      damping,
      iterations: 0,
      tolerance,
      converged: true,
      personalized: false,
      seedCount: 0,
    }
  }

  const teleport = new Map<string, number>()
  if (options.seeds === undefined) {
    const probability = 1 / ids.length
    for (const id of ids) teleport.set(id, probability)
  } else {
    if (!Array.isArray(options.seeds) || options.seeds.length < 1 || options.seeds.length > 1_000) {
      throw new RangeError('pagerank seeds must contain between 1 and 1000 entries')
    }
    let totalWeight = 0
    for (const seed of options.seeds) {
      if (
        typeof seed !== 'object' ||
        seed === null ||
        Array.isArray(seed) ||
        Object.keys(seed).some((key) => key !== 'id' && key !== 'weight') ||
        typeof seed.id !== 'string' ||
        seed.id.length === 0 ||
        !known.has(seed.id) ||
        teleport.has(seed.id)
      ) {
        throw new RangeError('pagerank seeds must be unique graph-node ids')
      }
      const weight = seed.weight ?? 1
      if (!Number.isFinite(weight) || weight <= 0) {
        throw new RangeError('pagerank seed weights must be positive and finite')
      }
      teleport.set(seed.id, weight)
      totalWeight += weight
      if (!Number.isFinite(totalWeight)) {
        throw new RangeError('pagerank seed weight total must be finite')
      }
    }
    for (const [id, weight] of teleport) teleport.set(id, weight / totalWeight)
  }

  const edgeById = new Map<string, StructuralEdge>()
  for (const edge of inputEdges) {
    if (known.has(edge.source) && known.has(edge.target)) edgeById.set(edge.id, edge)
  }
  const edges = [...edgeById.values()].sort(
    (left, right) =>
      compareUnicode(left.source, right.source) ||
      compareUnicode(left.target, right.target) ||
      compareUnicode(left.id, right.id),
  )
  const incoming = new Map<string, string[]>()
  const outgoing = new Map<string, string[]>()
  const neighbors = new Map<string, Set<string>>()
  const arcTargets = new Map<string, Set<string>>()
  for (const id of ids) {
    incoming.set(id, [])
    outgoing.set(id, [])
    neighbors.set(id, new Set())
    arcTargets.set(id, new Set())
  }
  for (const edge of edges) {
    outgoing.get(edge.source)!.push(edge.target)
    incoming.get(edge.target)!.push(edge.source)
    neighbors.get(edge.source)!.add(edge.target)
    neighbors.get(edge.target)!.add(edge.source)
    arcTargets.get(edge.source)!.add(edge.target)
  }
  for (const values of [...incoming.values(), ...outgoing.values()]) {
    values.sort(compareUnicode)
  }

  const componentById = new Map<string, number>()
  let componentCount = 0
  for (const root of ids) {
    if (componentById.has(root)) continue
    const queue = [root]
    componentById.set(root, componentCount)
    for (let index = 0; index < queue.length; index += 1) {
      for (const adjacent of [...neighbors.get(queue[index]!)!].sort(compareUnicode)) {
        if (componentById.has(adjacent)) continue
        componentById.set(adjacent, componentCount)
        queue.push(adjacent)
      }
    }
    componentCount += 1
  }

  const count = ids.length
  let ranks = new Map(ids.map((id) => [id, teleport.get(id) ?? 0]))
  let converged = false
  let completedIterations = 0
  for (let iteration = 1; iteration <= maximumIterations; iteration += 1) {
    let dangling = 0
    for (const id of ids) {
      if (outgoing.get(id)!.length === 0) dangling += ranks.get(id)!
    }
    const next = new Map<string, number>()
    let delta = 0
    for (const id of ids) {
      const inbound = incoming
        .get(id)!
        .reduce((total, source) => total + ranks.get(source)! / outgoing.get(source)!.length, 0)
      const teleportProbability = teleport.get(id) ?? 0
      const rank =
        (1 - damping) * teleportProbability +
        damping * dangling * teleportProbability +
        damping * inbound
      next.set(id, rank)
      delta += Math.abs(rank - ranks.get(id)!)
    }
    ranks = next
    completedIterations = iteration
    if (delta <= tolerance) {
      converged = true
      break
    }
  }

  let arcCount = 0
  for (const targets of arcTargets.values()) arcCount += targets.size
  const possibleArcs = count * count
  return {
    nodes: ids.map((id) => ({
      id,
      degree: neighbors.get(id)!.size,
      inDegree: incoming.get(id)!.length,
      outDegree: outgoing.get(id)!.length,
      pageRank: ranks.get(id)!,
      component: componentById.get(id)!,
    })),
    edgeCount: edges.length,
    arcCount,
    componentCount,
    density: possibleArcs === 0 ? 0 : arcCount / possibleArcs,
    damping,
    iterations: completedIterations,
    tolerance,
    converged,
    personalized: options.seeds !== undefined,
    seedCount: options.seeds?.length ?? 0,
  }
}
