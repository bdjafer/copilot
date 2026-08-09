import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const packageRoot = dirname(fileURLToPath(import.meta.url)) + '/..'
const temporaryRoot = mkdtempSync(join(tmpdir(), 'temporal-memory-package-'))
const nodeOnly = process.argv.includes('--node-only')
const wasmReleaseUrl =
  'https://github.com/astrale-os/surrealdb.js/releases/download/surrealdb-wasm-v3.0.4-astrale.1/astrale-os-surrealdb-wasm-3.0.4-astrale.1.tgz'
const wasmSha256 = '5211b20f09a4834febff0d21d0f83c468e8275a4d36a333151fed5c2dd57c634'
const wasmInventorySha256 = '65a1d2f14a2d370680ab2b79cf67b62c69a17f2ae77e27dba8af67476d92ab6b'
const expectedWasmLicenses = [
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BUSL-1.1',
  'ISC',
  'MIT',
  'MPL-2.0',
  'Unicode-3.0',
  'Unlicense',
  'Zlib',
].map((id) => ({ license: { id } }))
const rootSbomRef = 'pkg:npm/%40astrale-os/temporal-memory@0.1.0-alpha.1'
const expectedSbomDependencies = new Map([
  [
    rootSbomRef,
    ['pkg:npm/%40astrale-os/surrealdb-wasm@3.0.4-astrale.1', 'pkg:npm/surrealdb@2.0.8'],
  ],
  ['pkg:npm/%40astrale-os/surrealdb-wasm@3.0.4-astrale.1', ['pkg:npm/surrealdb@2.0.8']],
  ['pkg:npm/%40surrealdb/cbor@2.0.0-alpha.4', []],
  [
    'pkg:npm/%40surrealdb/sqon@0.1.0',
    [
      'pkg:npm/%40surrealdb/cbor@2.0.0-alpha.4',
      'pkg:npm/tslib@2.8.1',
      'pkg:npm/typescript@6.0.3',
      'pkg:npm/uuidv7@1.2.1',
    ],
  ],
  [
    'pkg:npm/surrealdb@2.0.8',
    ['pkg:npm/%40surrealdb/sqon@0.1.0', 'pkg:npm/tslib@2.8.1', 'pkg:npm/typescript@6.0.3'],
  ],
  ['pkg:npm/tslib@2.8.1', []],
  ['pkg:npm/typescript@6.0.3', []],
  ['pkg:npm/uuidv7@1.2.1', []],
])

function requirePath(path, description) {
  if (!existsSync(path)) throw new Error(`packed package is missing ${description}: ${path}`)
}

function propertyMap(component) {
  return new Map((component?.properties ?? []).map((property) => [property.name, property.value]))
}

function verifySbom(path) {
  const serialized = readFileSync(path, 'utf8')
  if (
    serialized.includes(packageRoot) ||
    /\/(?:Users|home\/runner\/work)\//.test(serialized) ||
    /[A-Za-z]:\\\\/.test(serialized)
  ) {
    throw new Error('SBOM contains a machine-local path')
  }
  const sbom = JSON.parse(serialized)
  if (
    sbom.$schema !== 'http://cyclonedx.org/schema/bom-1.6.schema.json' ||
    sbom.bomFormat !== 'CycloneDX' ||
    sbom.specVersion !== '1.6' ||
    sbom.version !== 1 ||
    !/^urn:uuid:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(sbom.serialNumber)
  ) {
    throw new Error('SBOM does not have the expected CycloneDX 1.6 identity')
  }
  if (
    sbom.metadata?.component?.['bom-ref'] !== rootSbomRef ||
    sbom.metadata.component.name !== 'temporal-memory' ||
    sbom.metadata.component.version !== '0.1.0-alpha.1'
  ) {
    throw new Error('SBOM root component identity is unexpected')
  }

  const components = new Map(
    (sbom.components ?? []).map((component) => [component['bom-ref'], component]),
  )
  const expectedComponentRefs = [...expectedSbomDependencies.keys()].filter(
    (reference) => reference !== rootSbomRef,
  )
  if (
    components.size !== expectedComponentRefs.length ||
    expectedComponentRefs.some((reference) => !components.has(reference))
  ) {
    throw new Error('SBOM npm production inventory is incomplete or contains unexpected components')
  }
  const dependencies = new Map(
    (sbom.dependencies ?? []).map((dependency) => [dependency.ref, dependency.dependsOn ?? []]),
  )
  if (dependencies.size !== expectedSbomDependencies.size) {
    throw new Error('SBOM npm dependency graph has an unexpected node count')
  }
  for (const [reference, expected] of expectedSbomDependencies) {
    if (JSON.stringify(dependencies.get(reference)) !== JSON.stringify(expected)) {
      throw new Error(`SBOM dependency edges are unexpected for ${reference}`)
    }
  }

  const wasm = components.get('pkg:npm/%40astrale-os/surrealdb-wasm@3.0.4-astrale.1')
  if (JSON.stringify(wasm?.licenses) !== JSON.stringify(expectedWasmLicenses)) {
    throw new Error('SBOM collapses or misstates the mixed-license WASM boundary')
  }
  const wasmProperties = propertyMap(wasm)
  if (
    wasmProperties.get('astrale:inventory:cargo-components') !== '337' ||
    wasmProperties.get('astrale:inventory:third-party-sha256') !== wasmInventorySha256 ||
    wasmProperties.get('astrale:surrealdb:core-version') !== '3.0.5' ||
    wasmProperties.get('astrale:surrealdb:protocol-version') !== '0.8.3' ||
    wasmProperties.get('astrale:wasm:sha256') !== wasmSha256
  ) {
    throw new Error('SBOM WASM inventory or provenance properties are unexpected')
  }
  const cargo = (wasm.components ?? []).filter((component) => component.type === 'library')
  const cargoRefs = new Set(cargo.map((component) => component['bom-ref']))
  if (cargo.length !== 337 || cargoRefs.size !== 337) {
    throw new Error('SBOM does not contain the complete unique Cargo inventory')
  }
  const core = cargo.find(
    (component) => component.name === 'surrealdb-core' && component.version === '3.0.5',
  )
  const protocol = cargo.find(
    (component) => component.name === 'surrealdb-protocol' && component.version === '0.8.3',
  )
  if (
    JSON.stringify(core?.licenses) !== JSON.stringify([{ license: { id: 'BUSL-1.1' } }]) ||
    propertyMap(core).get('astrale:license:change-date') !== '2030-01-01' ||
    JSON.stringify(protocol?.licenses) !== JSON.stringify([{ license: { id: 'BUSL-1.1' } }]) ||
    propertyMap(protocol).get('astrale:license:change-date') !== '2029-09-17'
  ) {
    throw new Error('SBOM does not preserve the distinct embedded BUSL boundaries')
  }
  const wasmFile = (wasm.components ?? []).find(
    (component) => component['bom-ref'] === `file:surrealdb_bg.wasm@sha256:${wasmSha256}`,
  )
  if (
    JSON.stringify(wasmFile?.hashes) !== JSON.stringify([{ alg: 'SHA-256', content: wasmSha256 }])
  ) {
    throw new Error('SBOM does not bind the exact embedded WASM file')
  }
  const completeRelationships = (sbom.compositions ?? []).find(
    (composition) => composition.aggregate === 'complete',
  )
  const unknownRelationships = (sbom.compositions ?? []).find(
    (composition) => composition.aggregate === 'unknown',
  )
  const expectedUnknownRelationships = (wasm.components ?? [])
    .map((component) => component['bom-ref'])
    .sort()
  if (
    sbom.compositions?.length !== 2 ||
    JSON.stringify(completeRelationships?.dependencies) !==
      JSON.stringify([...expectedSbomDependencies.keys()]) ||
    JSON.stringify(unknownRelationships?.dependencies) !==
      JSON.stringify(expectedUnknownRelationships)
  ) {
    throw new Error('SBOM does not declare exact npm and unknown intra-Cargo relationship coverage')
  }
  return serialized
}

async function verifyBrowserConsumer(consumerRoot) {
  const requireFromConsumer = createRequire(join(consumerRoot, 'package.json'))
  const { createServer } = await import(pathToFileURL(requireFromConsumer.resolve('vite')).href)
  const entry = join(consumerRoot, 'browser-smoke.mjs')
  writeFileSync(
    entry,
    `import { createMemory, openSyncBundle } from '@astrale-os/temporal-memory'\n` +
      `import { createSurrealMemoryCapabilities, createSurrealMemoryStorage } from '@astrale-os/temporal-memory/surreal'\n` +
      `async function run() {\n` +
      `  window.__packedTemporalMemoryStage = 'starting'\n` +
      `  const worker = new URL(location.href).searchParams.get('worker') === 'true'\n` +
      `  const endpoint = \`indxdb://packedconsumer\${crypto.randomUUID().replaceAll('-', '')}\`\n` +
      `  const constructionStorage = createSurrealMemoryStorage({ endpoint, worker }); const constructionReads = {}; const constructionCapture = (name, value, later = value) => () => { const count = (constructionReads[name] ?? 0) + 1; constructionReads[name] = count; return count === 1 ? value : later }; const constructionOntology = { id: 'packed.browser.construction', version: '1', mode: 'open', entityTypes: {}, factTypes: {} }; const constructionOptions = {}; Object.defineProperties(constructionOptions, { spaceId: { enumerable: true, get: constructionCapture('spaceId', 'packed-browser-construction', '') }, storage: { enumerable: true, get: constructionCapture('storage', constructionStorage) }, ontology: { enumerable: true, get: constructionCapture('ontology', constructionOntology) }, operationTimeoutMs: { enumerable: true, get: constructionCapture('operationTimeoutMs', 5000, 0) } }); const constructionMemory = createMemory(constructionOptions); constructionOntology.id = 'mutated-after-construction'; const constructionSpace = await constructionMemory.open({ create: true }); let constructionUnknownRejected = false; try { createMemory({ spaceId: 'packed-browser-construction-unknown', storage: constructionStorage, unsupported: true }) } catch (error) { constructionUnknownRejected = error?.code === 'invalid_input' }; const constructionOptionsSnapshotted = constructionSpace.id === 'packed-browser-construction' && constructionSpace.ontology.id === 'packed.browser.construction' && constructionUnknownRejected && Object.keys(constructionReads).length === 4 && Object.values(constructionReads).every((count) => count === 1); await constructionMemory.close()\n` +
      `  const first = createMemory({ spaceId: 'packed-browser', storage: createSurrealMemoryStorage({ endpoint, worker }) })\n` +
      `  await first.open({ create: true })\n` +
      `  window.__packedTemporalMemoryStage = 'first-open'\n` +
      `  const signalSnapshotMemory = createMemory({ spaceId: 'packed-browser-signal-snapshot', storage: createSurrealMemoryStorage({ endpoint: \`indxdb://packedsignalsnapshot\${crypto.randomUUID().replaceAll('-', '')}\`, worker }) })\n` +
      `  const facadeOpenOptions = { create: true, metadata: { owner: 'packed-browser-original', nested: { state: 'ready' } } }; const facadeOpenPromise = signalSnapshotMemory.open(facadeOpenOptions); facadeOpenOptions.create = false; facadeOpenOptions.metadata.owner = 'packed-browser-mutated'; facadeOpenOptions.metadata.nested.state = 'mutated'; const facadeSpace = await facadeOpenPromise\n` +
      `  const facadeOpenInputSnapshotted = facadeSpace.metadata?.owner === 'packed-browser-original' && facadeSpace.metadata?.nested?.state === 'ready'; facadeSpace.metadata.owner = 'returned-value-mutation'; facadeSpace.metadata.nested.state = 'returned-value-mutation'; const facadeReopenedSpace = await signalSnapshotMemory.open(); let facadeListenerIsolated = false; let facadeListenerState; let facadeListenerWarnings; signalSnapshotMemory.on('operation:settled', (event) => { event.operation.state = 'failed'; event.operation.warnings.push('first-listener-mutation') }); signalSnapshotMemory.on('operation:settled', (event) => { facadeListenerState = event.operation.state; facadeListenerWarnings = event.operation.warnings; facadeListenerIsolated = event.operation.state !== 'failed' && !event.operation.warnings.includes('first-listener-mutation') })\n` +
      `  const facadeRemember = await signalSnapshotMemory.remember({ id: 'packed-signal-snapshot-target', kind: 'event', content: { type: 'event', name: 'snapshot-target', value: true }, source: { kind: 'packed-signal-snapshot', metadata: { owner: 'original' } } }, { operationId: 'packed-browser-output-operation' }); facadeRemember.episode.content.value = false; facadeRemember.episode.source.metadata.owner = 'returned-value-mutation'; facadeRemember.operation.warnings.push('returned-report-mutation')\n` +
      `  const signalSnapshotRevision = (await signalSnapshotMemory.stats()).snapshotRevision\n` +
      `  const snapshotSignal = { namespace: 'packed.snapshot.original', target: { kind: 'episode', id: 'packed-signal-snapshot-target' }, producer: { kind: 'algorithm', id: 'packed-snapshot', version: '1' }, scopes: [], basis: { episodeIds: ['packed-signal-snapshot-target'] }, value: { state: 'original' } }\n` +
      `  const snapshotPutRequest = { access: { allowedScopes: [] }, expectedRevision: signalSnapshotRevision, signals: [snapshotSignal] }\n` +
      `  const snapshotPutPromise = signalSnapshotMemory.putSignals(snapshotPutRequest)\n` +
      `  snapshotSignal.namespace = 'packed.snapshot.mutated'; snapshotSignal.target.id = 'missing-mutated-target'; snapshotSignal.basis.episodeIds[0] = 'missing-mutated-target'; snapshotSignal.value.state = 'mutated'\n` +
      `  const snapshotPut = await snapshotPutPromise\n` +
      `  const snapshotBrowseRequest = { access: { allowedScopes: [] }, where: { namespaces: ['packed.snapshot.original'] } }\n` +
      `  const snapshotBrowsePromise = signalSnapshotMemory.browseSignals(snapshotBrowseRequest)\n` +
      `  snapshotBrowseRequest.where.namespaces[0] = 'packed.snapshot.mutated'\n` +
      `  const snapshotBrowse = await snapshotBrowsePromise\n` +
      `  const snapshotDeleteRequest = { access: { allowedScopes: [] }, mode: 'withdraw', where: { namespaces: ['packed.snapshot.original'] }, expectedRevision: snapshotPut.revision, maxMatches: 1, reason: 'original retirement' }\n` +
      `  const snapshotDeletePromise = signalSnapshotMemory.deleteSignals(snapshotDeleteRequest)\n` +
      `  snapshotDeleteRequest.mode = 'purge'; snapshotDeleteRequest.where.namespaces[0] = 'packed.snapshot.mutated'; snapshotDeleteRequest.reason = 'mutated retirement'; snapshotDeleteRequest.maxRevisions = 1\n` +
      `  const snapshotDelete = await snapshotDeletePromise\n` +
      `  const signalRequestSnapshotted = snapshotPut.signals[0]?.namespace === 'packed.snapshot.original' && snapshotPut.signals[0]?.state === 'active' && snapshotPut.signals[0]?.value.state === 'original' && snapshotBrowse.signals[0]?.id === snapshotPut.signals[0]?.id && snapshotDelete.mode === 'withdraw' && snapshotDelete.withdrawn[0]?.state === 'withdrawn' && snapshotDelete.withdrawn[0]?.withdrawalReason === 'original retirement'\n` +
      `  const facadeLiveSignal = new AbortController().signal; let facadeManagementReads = 0; const facadeManagementOptions = { signal: facadeLiveSignal }; Object.defineProperty(facadeManagementOptions, 'scanLimits', { enumerable: true, get: () => { facadeManagementReads += 1; return facadeManagementReads === 1 ? { maxRecords: 10000, maxBytes: 16777216 } : { maxRecords: 0, maxBytes: 0 } } }); const facadeStatsPromise = signalSnapshotMemory.stats(facadeManagementOptions); facadeManagementOptions.signal = AbortSignal.abort(); const facadeStats = await facadeStatsPromise\n` +
      `  const facadePointOptions = { signal: facadeLiveSignal }; const facadePointPromise = signalSnapshotMemory.getEpisode('packed-signal-snapshot-target', { allowedScopes: [] }, facadePointOptions); facadePointOptions.signal = AbortSignal.abort(); const facadePoint = await facadePointPromise\n` +
      `  const facadeOutputOperation = await signalSnapshotMemory.operation('packed-browser-output-operation')\n` +
      `  const facadeBaseline = await signalSnapshotMemory.snapshot({ access: { allowedScopes: [] } }); const facadeRegistrationOptions = { signal: facadeLiveSignal }; const facadeRegistrationPromise = signalSnapshotMemory.registerJournalConsumer({ id: 'packed-browser-facade-consumer', journal: 'semantic', cursor: facadeBaseline.changesCursor }, facadeRegistrationOptions); facadeRegistrationOptions.signal = AbortSignal.abort(); const facadeConsumer = await facadeRegistrationPromise; const facadeRetirementOptions = { signal: facadeLiveSignal }; const facadeRetirementPromise = signalSnapshotMemory.retireJournalConsumer({ id: facadeConsumer.id, journal: 'semantic' }, facadeRetirementOptions); facadeRetirementOptions.signal = AbortSignal.abort(); const facadeRetirement = await facadeRetirementPromise\n` +
      `  let facadeIntegrityReads = 0; const facadeIntegrityOptions = { signal: facadeLiveSignal }; Object.defineProperty(facadeIntegrityOptions, 'limits', { enumerable: true, get: () => { facadeIntegrityReads += 1; return facadeIntegrityReads === 1 ? { maxRecords: 10000, maxBytes: 16777216, maxGraphNodes: 10000, maxGraphEdges: 10000, maxIssues: 100 } : { maxRecords: 0 } } }); const facadeIntegrityPromise = signalSnapshotMemory.verifyIntegrity(facadeIntegrityOptions); facadeIntegrityOptions.signal = AbortSignal.abort(); const facadeIntegrity = await facadeIntegrityPromise\n` +
      `  const facadeOptionsSnapshotted = facadeOpenInputSnapshotted && facadeManagementReads === 1 && facadeStats.episodes === 1 && facadePoint?.id === 'packed-signal-snapshot-target' && facadeConsumer.state === 'active' && facadeRetirement.state === 'retired' && facadeIntegrityReads === 1 && facadeIntegrity.ok\n` +
      `  const publicOutputsDetached = facadeReopenedSpace.metadata?.owner === 'packed-browser-original' && facadeReopenedSpace.metadata?.nested?.state === 'ready' && facadeListenerIsolated && facadePoint?.content?.type === 'event' && facadePoint.content.value === true && facadePoint.source.metadata?.owner === 'original' && facadeOutputOperation?.state === facadeListenerState && JSON.stringify(facadeOutputOperation.warnings) === JSON.stringify(facadeListenerWarnings) && !facadeOutputOperation.warnings.includes('returned-report-mutation')\n` +
      `  await signalSnapshotMemory.close()\n` +
      `  let contextProviderCalls = 0\n` +
      `  const contextEndpoint = \`indxdb://packedcontext\${crypto.randomUUID().replaceAll('-', '')}\`\n` +
      `  const contextMemory = createMemory({ spaceId: 'packed-browser-context', storage: createSurrealMemoryStorage({ endpoint: contextEndpoint, worker }), inference: { lineage: { provider: 'packed-fixture', model: 'bounded-context-v1', destination: 'local' }, infer: async () => { contextProviderCalls += 1; return { entities: [], facts: [] } } }, ingestion: { contextLimit: 1 } })\n` +
      `  await contextMemory.open({ create: true })\n` +
      `  await contextMemory.remember({ id: 'packed-context-source', kind: 'assertion', content: { type: 'text', text: 'Packed browser context source.' }, source: { kind: 'packed-browser-smoke' }, assertions: { entities: [{ id: 'packed-context-entity', name: 'Context entity' }] } })\n` +
      `  const contextLimit = await contextMemory.remember({ id: 'packed-context-target', kind: 'text', content: { type: 'text', text: 'Bound packed browser context.' }, source: { kind: 'packed-browser-smoke' } }, { operationId: 'packed-context-limit', contextScanLimits: { maxRecords: 1, maxBytes: 1048576 } })\n` +
      `  const contextRetry = await contextMemory.retryEpisode('packed-context-target', { operationId: 'packed-context-retry', contextScanLimits: { maxRecords: 100, maxBytes: 1048576 } })\n` +
      `  const contextScanOk = contextLimit.operation.state === 'failed' && contextLimit.operation.error?.code === 'result_too_large' && contextLimit.contextScan.records === 1 && contextProviderCalls === 1 && contextRetry.operation.state === 'succeeded' && contextRetry.contextScan.records > 1 && contextRetry.contextScan.bytes > 0\n` +
      `  await contextMemory.close()\n` +
      `  const resetEndpoint = \`indxdb://packedreset\${crypto.randomUUID().replaceAll('-', '')}\`\n` +
      `  const resetMemory = createMemory({ spaceId: 'packed-browser-reset', storage: createSurrealMemoryStorage({ endpoint: resetEndpoint, worker }) })\n` +
      `  await resetMemory.open({ create: true })\n` +
      `  await resetMemory.remember({ id: 'packed-reset-episode', kind: 'assertion', content: { type: 'text', text: 'Bound packed reset.' }, source: { kind: 'packed-browser-smoke' }, assertions: { entities: [{ id: 'packed-reset-entity', name: 'Reset entity' }] } })\n` +
      `  const resetRevision = (await resetMemory.stats()).snapshotRevision\n` +
      `  const resetRejected = await resetMemory.resetSpace({ confirmSpaceId: 'packed-browser-reset', scanLimits: { maxRecords: 1, maxBytes: 1048576 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'reset_scan' && error?.details?.dimension === 'records' && error?.details?.required > 1 && error?.details?.maximum === 1)\n` +
      `  const resetAtomic = (await resetMemory.stats()).snapshotRevision === resetRevision\n` +
      `  const resetSnapshotRequest = { confirmSpaceId: 'packed-browser-reset', scanLimits: { maxRecords: 100, maxBytes: 1048576 } }; const resetSnapshotPromise = resetMemory.resetSpace(resetSnapshotRequest); resetSnapshotRequest.confirmSpaceId = 'mutated-packed-browser-reset'; resetSnapshotRequest.scanLimits.maxRecords = 0; const resetReport = await resetSnapshotPromise\n` +
      `  const resetRequestSnapshotOk = resetReport.purged && resetReport.scan.records > 1\n` +
      `  const resetScanOk = resetRejected && resetAtomic && resetReport.scan.records > 1 && resetReport.scan.bytes > 0\n` +
      `  const report = await first.remember({ id: 'packed-browser-episode', kind: 'assertion', content: { type: 'text', text: 'Packed Surreal artifact works.' }, source: { kind: 'packed-browser-smoke' }, tags: ['packed', 'browser'], assertions: { entities: [{ id: 'packed-browser-entity', name: 'Packed Surreal artifact' }], facts: [{ subject: { id: 'packed-browser-entity' }, predicate: 'works-as', object: { scalar: worker ? 'worker' : 'direct' } }] } })\n` +
      `  const factId = report.facts.created[0]\n` +
      `  const baseline = await first.snapshot({ access: { allowedScopes: [] }, scanLimits: { maxRecords: 100, maxBytes: 1048576 } })\n` +
      `  const snapshotScanRejected = await first.snapshot({ access: { allowedScopes: [] }, scanLimits: { maxRecords: 1, maxBytes: 1048576 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'snapshot_scan' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `  const signalBaseline = await first.browseSignals({ access: { allowedScopes: [] } })\n` +
      `  const signalBasisRejected = await first.putSignals({ access: { allowedScopes: [] }, expectedRevision: signalBaseline.snapshotRevision, basisScanLimits: { maxRecords: 1, maxBytes: 1048576 }, signals: [{ namespace: 'packed.basis-limit', target: { kind: 'episode', id: 'packed-browser-episode' }, producer: { kind: 'algorithm', id: 'packed-fixture', version: '1' }, scopes: [], basis: { episodeIds: ['packed-browser-episode'] }, value: { worker } }] }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'signal_basis_scan' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `  const signalBasisAtomic = (await first.stats()).snapshotRevision === signalBaseline.snapshotRevision\n` +
      `  const signalWrite = await first.putSignals({ access: { allowedScopes: [] }, expectedRevision: signalBaseline.snapshotRevision, basisScanLimits: { maxRecords: 100, maxBytes: 1048576 }, signals: [{ namespace: 'packed.persistence', target: { kind: 'episode', id: 'packed-browser-episode' }, producer: { kind: 'algorithm', id: 'packed-fixture', version: '1' }, scopes: [], basis: { episodeIds: ['packed-browser-episode'] }, value: { worker } }] })\n` +
      `  const signalBasisScanOk = signalBasisRejected && signalBasisAtomic && signalWrite.basisScan.records > 1 && signalWrite.basisScan.bytes > 0\n` +
      `  const packedBatchRevision = (await first.stats()).snapshotRevision\n` +
      `  const packedBatchInput = { derivations: [{ conclusion: { id: 'packed-browser-batch-one', subjectId: 'packed-browser-entity', predicate: 'packed_browser_batch_one', object: { kind: 'scalar', value: true } }, rule: { id: 'packed/browser-batch', version: '1' }, premises: [{ kind: 'fact', id: factId }] }, { conclusion: { id: 'packed-browser-batch-two', subjectId: 'packed-browser-entity', predicate: 'packed_browser_batch_two', object: { kind: 'scalar', value: true } }, rule: { id: 'packed/browser-batch', version: '1' }, premises: [{ kind: 'fact', id: factId }] }], access: { allowedScopes: [] }, expectedRevision: packedBatchRevision, workLimits: { maxRecords: 64 } }\n` +
      `  const packedBatch = await first.deriveFacts(packedBatchInput, { operationId: 'packed-browser-derive-batch' })\n` +
      `  const packedBatchReplay = await first.deriveFacts(packedBatchInput, { operationId: 'packed-browser-derive-batch' })\n` +
      `  const packedBatchOk = packedBatch.results.map((result) => result.conclusion.id).join(',') === 'packed-browser-batch-one,packed-browser-batch-two' && packedBatch.results.every((result) => result.outcome === 'created' && result.derivation.operationId === 'packed-browser-derive-batch' && result.derivation.recordedRevision === packedBatchRevision + 1) && packedBatchReplay.results[1]?.derivation.id === packedBatch.results[1]?.derivation.id\n` +
      `  const packedWithdrawalBatchPreview = await first.previewDerivationWithdrawals({ where: { ruleIds: ['packed/browser-batch'], ruleVersions: ['1'] }, access: { allowedScopes: [] }, maxMatches: 2, workLimits: { maxRecords: 64 } })\n` +
      `  const packedWithdrawalBatchRevision = packedWithdrawalBatchPreview.snapshotRevision\n` +
      `  const packedWithdrawalBatchInput = { where: { ruleIds: ['packed/browser-batch'], ruleVersions: ['1'] }, access: { allowedScopes: [] }, expectedRevision: packedWithdrawalBatchRevision, maxMatches: 2, selectionCursor: packedWithdrawalBatchPreview.selectionCursor, reason: 'Packed browser rule-set retirement.', workLimits: { maxRecords: 64 } }\n` +
      `  const packedWithdrawalBatch = await first.withdrawDerivations(packedWithdrawalBatchInput, { operationId: 'packed-browser-withdraw-batch' })\n` +
      `  const packedWithdrawalBatchReplay = await first.withdrawDerivations(packedWithdrawalBatchInput, { operationId: 'packed-browser-withdraw-batch' })\n` +
      `  const packedWithdrawalBatchOk = packedWithdrawalBatchPreview.derivations.length === 2 && typeof packedWithdrawalBatchPreview.selectionCursor === 'string' && (await first.stats()).snapshotRevision === packedWithdrawalBatchRevision + 1 && packedWithdrawalBatch.withdrawals.length === 2 && packedWithdrawalBatch.withdrawals.map((item) => item.conclusionFactId).sort().join(',') === 'packed-browser-batch-one,packed-browser-batch-two' && packedWithdrawalBatch.unsupportedFacts.join(',') === 'packed-browser-batch-one,packed-browser-batch-two' && packedWithdrawalBatchReplay.withdrawals.map((item) => item.withdrawalId).join(',') === packedWithdrawalBatch.withdrawals.map((item) => item.withdrawalId).join(',') && await first.getFact('packed-browser-batch-one', { allowedScopes: [] }) === null && await first.getFact('packed-browser-batch-two', { allowedScopes: [] }) === null\n` +
      `  await first.remember({ id: 'packed-browser-preview-delete', kind: 'event', content: { type: 'event', name: 'temporary-preview', value: true }, source: { kind: 'packed-browser-preview-delete' }, tags: ['preview-delete'] })\n` +
      `  const episodeDeletionPreview = await first.previewEpisodeDeletions({ where: { tags: { all: ['preview-delete'] } }, access: { allowedScopes: [] }, maxMatches: 1, workLimits: { maxRecords: 16 } })\n` +
      `  const episodeDeletion = await first.deleteEpisodes({ where: { tags: { all: ['preview-delete'] } }, access: { allowedScopes: [] }, expectedRevision: episodeDeletionPreview.snapshotRevision, maxMatches: 1, selectionCursor: episodeDeletionPreview.selectionCursor, workLimits: { maxRecords: 64 } }, { operationId: 'packed-browser-preview-delete' })\n` +
      `  const episodeDeletionPreviewOk = episodeDeletionPreview.episodes[0]?.id === 'packed-browser-preview-delete' && typeof episodeDeletionPreview.selectionCursor === 'string' && episodeDeletionPreview.work.records === 1 && episodeDeletion.affectedEpisodes.join(',') === 'packed-browser-preview-delete' && await first.getEpisode('packed-browser-preview-delete', { allowedScopes: [] }) === null\n` +
      `  await first.close()\n` +
      `  window.__packedTemporalMemoryStage = 'first-closed'\n` +
      `  const { storage: reopenedStorage, admin: reopenedAdmin } = createSurrealMemoryCapabilities({ endpoint, worker }, { dangerouslyAllowRawQueries: true })\n` +
      `  const reopened = createMemory({ spaceId: 'packed-browser', storage: reopenedStorage })\n` +
      `  await reopened.open()\n` +
      `  window.__packedTemporalMemoryStage = 'reopened'\n` +
      `  const pointReadRejected = await reopened.read({ kind: 'entity', id: 'packed-browser-entity', access: { allowedScopes: [] }, scanLimits: { maxRecords: 1, maxBytes: 1048576 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'point_read_scan' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `  const pointRead = await reopened.read({ kind: 'entity', id: 'packed-browser-entity', access: { allowedScopes: [] }, scanLimits: { maxRecords: 100, maxBytes: 1048576 } })\n` +
      `  const pointReadScanOk = pointReadRejected && pointRead.value?.id === 'packed-browser-entity' && pointRead.scan.records > 1 && pointRead.scan.bytes > 0\n` +
      `  const projectionSetBefore = (await reopened.stats()).activeProjectionSets.find((set) => set.kind === 'lexical')?.setId\n` +
      `  const projectionSnapshotRequest = { kinds: ['lexical'], scanLimits: { maxRecords: 10000, maxBytes: 16777216 } }; const projectionSnapshotOptions = { operationId: 'packed-browser-projection-rebuild' }; const projectionSnapshotPromise = reopened.rebuildProjections(projectionSnapshotRequest, projectionSnapshotOptions); projectionSnapshotRequest.kinds[0] = 'summary'; projectionSnapshotRequest.scanLimits.maxRecords = 0; projectionSnapshotOptions.operationId = 'mutated-packed-browser-projection'; const projectionRebuild = await projectionSnapshotPromise\n` +
      `  const projectionRequestSnapshotOk = projectionRebuild.operation.id === 'packed-browser-projection-rebuild'\n` +
      `  const projectionSetAfter = projectionRebuild.activeProjectionSets.find((set) => set.kind === 'lexical')?.setId\n` +
      `  const projectionSetOk = projectionRebuild.failed === 0 && projectionRebuild.staleRemaining === 0 && projectionSetBefore !== undefined && projectionSetAfter !== undefined && projectionSetAfter !== projectionSetBefore\n` +
      `  const projectionScanRejected = await reopened.rebuildProjections({ kinds: ['lexical'], entityIds: ['packed-browser-entity'], scanLimits: { maxRecords: 1, maxBytes: 1048576 } }, { operationId: 'packed-browser-projection-scan-limit' }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'projection_scan' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `  const projectionScanOk = projectionRebuild.scan.records > 0 && projectionRebuild.scan.records <= projectionRebuild.scan.limits.maxRecords && projectionRebuild.scan.bytes > 0 && projectionRebuild.scan.bytes <= projectionRebuild.scan.limits.maxBytes && projectionScanRejected && (await reopened.stats()).activeProjectionSets.find((set) => set.kind === 'lexical')?.setId === projectionSetAfter\n` +
      `  const raw = await reopenedAdmin.rawQuery({ query: 'RETURN { space: $space, worker: $worker };', bindings: { space: 'packed-browser', worker }, confirmNamespace: 'astrale', confirmDatabase: 'temporal_memory' })\n` +
      `  const rawOk = !('rawQuery' in reopenedStorage) && Object.isFrozen(reopenedAdmin) && raw.allSucceeded && raw.statements[0]?.success === true && raw.statements[0].result.space === 'packed-browser' && raw.statements[0].result.worker === worker\n` +
      `  const legacy = createMemory({ spaceId: 'packed-legacy', storage: reopenedStorage })\n` +
      `  await legacy.open({ create: true })\n` +
      `  const legacyRewrite = await reopenedAdmin.rawQuery({ query: "UPDATE tm_space SET payload.schemaVersion = '6', payload.canonicalRevision = NONE WHERE space_id = $space;", bindings: { space: 'packed-legacy' }, confirmNamespace: 'astrale', confirmDatabase: 'temporal_memory' })\n` +
      `  await legacy.close()\n` +
      `  const migrated = createMemory({ spaceId: 'packed-legacy', storage: reopenedStorage })\n` +
      `  await migrated.open({ migrate: true })\n` +
      `  const migrationInspection = await migrated.inspect()\n` +
      `  const migrationOk = legacyRewrite.allSucceeded && migrationInspection.space?.schemaVersion === '7' && migrationInspection.schemaMigrations.length === 1 && migrationInspection.schemaMigrations[0]?.fromSchemaVersion === '6' && /^[a-f0-9]{64}$/.test(migrationInspection.schemaMigrations[0]?.checksum ?? '')\n` +
      `  await migrated.close()\n` +
      `  const fact = await reopened.getFact(factId, { allowedScopes: [] })\n` +
      `  const packedBatchPersisted = (await Promise.all(packedWithdrawalBatch.withdrawals.map((item) => reopened.getDerivation(item.withdrawalId, { allowedScopes: [] })))).every((item) => item?.state === 'withdrawn' && item.operationId === 'packed-browser-withdraw-batch') && await reopened.getFact('packed-browser-batch-one', { allowedScopes: [] }) === null && await reopened.getFact('packed-browser-batch-two', { allowedScopes: [] }) === null\n` +
      `  const recalled = await reopened.recall({ query: 'Packed Surreal artifact', access: { allowedScopes: [] }, channels: { exact: true, lexical: true, semantic: false, graph: true, temporal: false } })\n` +
      `  const installedPointSnapshotRequest = { kind: 'episode', id: 'packed-browser-episode', access: { allowedScopes: [] } }; const installedPointSnapshotPromise = reopened.read(installedPointSnapshotRequest); installedPointSnapshotRequest.id = 'missing-mutated-target'; installedPointSnapshotRequest.access.allowedScopes.push('private'); const installedPointSnapshot = await installedPointSnapshotPromise\n` +
      `  const installedRecallSnapshotRequest = { anchors: { entityIds: ['packed-browser-entity'] }, access: { allowedScopes: [] }, filters: { episodes: { ids: ['packed-browser-episode'] } }, channels: { exact: true, lexical: false, semantic: false, graph: false, temporal: false } }; const installedRecallSnapshotPromise = reopened.recall(installedRecallSnapshotRequest); installedRecallSnapshotRequest.anchors.entityIds[0] = 'missing-mutated-entity'; installedRecallSnapshotRequest.filters.episodes.ids[0] = 'missing-mutated-target'; const installedRecallSnapshot = await installedRecallSnapshotPromise\n` +
      `  const installedSearchSnapshotRequest = { anchors: { entityIds: ['packed-browser-entity'] }, access: { allowedScopes: [] }, channels: { exact: true, lexical: false, semantic: false, graph: false, temporal: false }, target: 'all' }; const installedSearchSnapshotPromise = reopened.search(installedSearchSnapshotRequest); installedSearchSnapshotRequest.anchors.entityIds[0] = 'missing-mutated-entity'; installedSearchSnapshotRequest.target = 'episodes'; const installedSearchSnapshot = await installedSearchSnapshotPromise\n` +
      `  const installedNeighborhoodSnapshotRequest = { entityId: 'packed-browser-entity', access: { allowedScopes: [] } }; const installedNeighborhoodSnapshotPromise = reopened.neighborhood(installedNeighborhoodSnapshotRequest); installedNeighborhoodSnapshotRequest.entityId = 'missing-mutated-entity'; const installedNeighborhoodSnapshot = await installedNeighborhoodSnapshotPromise\n` +
      `  const installedBrowseSnapshotRequest = { kind: 'episode', access: { allowedScopes: [] }, filters: { episodes: { ids: ['packed-browser-episode'] } }, limit: 10 }; const installedBrowseSnapshotPromise = reopened.browse(installedBrowseSnapshotRequest); installedBrowseSnapshotRequest.filters.episodes.ids[0] = 'missing-mutated-target'; const installedBrowseSnapshot = await installedBrowseSnapshotPromise\n` +
      `  const installedGraphSnapshotRequest = { access: { allowedScopes: [] }, filters: { episodes: { ids: ['packed-browser-episode'] } }, maxRecords: 100 }; const installedGraphSnapshotPromise = reopened.snapshot(installedGraphSnapshotRequest); installedGraphSnapshotRequest.filters.episodes.ids[0] = 'missing-mutated-target'; const installedGraphSnapshot = await installedGraphSnapshotPromise\n` +
      `  const installedAnalysisSnapshotRequest = { access: { allowedScopes: [] }, filters: { episodes: { ids: ['packed-browser-episode'] } }, pagerank: { seeds: [{ id: 'packed-browser-entity' }] } }; const installedAnalysisSnapshotPromise = reopened.analyze(installedAnalysisSnapshotRequest); installedAnalysisSnapshotRequest.filters.episodes.ids[0] = 'missing-mutated-target'; installedAnalysisSnapshotRequest.pagerank.seeds[0].id = 'missing-mutated-entity'; const installedAnalysisSnapshot = await installedAnalysisSnapshotPromise\n` +
      `  const installedArchiveSnapshotRequest = { access: { allowedScopes: [] }, episodeIds: ['packed-browser-episode'] }; const installedArchiveSnapshotPromise = reopened.export(installedArchiveSnapshotRequest); installedArchiveSnapshotRequest.episodeIds[0] = 'missing-mutated-target'; const installedArchiveSnapshot = await installedArchiveSnapshotPromise\n` +
      `  const installedChangesSnapshotRequest = { access: { allowedScopes: [] }, limit: 1000 }; const installedChangesSnapshotPromise = reopened.changes(installedChangesSnapshotRequest); installedChangesSnapshotRequest.limit = 1; const installedChangesSnapshot = await installedChangesSnapshotPromise\n` +
      `  const installedSignalChangesSnapshotRequest = { access: { allowedScopes: [] }, limit: 1000 }; const installedSignalChangesSnapshotPromise = reopened.signalChanges(installedSignalChangesSnapshotRequest); installedSignalChangesSnapshotRequest.limit = 1; const installedSignalChangesSnapshot = await installedSignalChangesSnapshotPromise\n` +
      `  const installedUnknownReadRejected = await reopened.analyze({ access: { allowedScopes: [] }, unexpected: true }).then(() => false, (error) => error?.code === 'invalid_input')\n` +
      `  const coreReadRequestSnapshotOk = installedPointSnapshot.value?.id === 'packed-browser-episode' && installedRecallSnapshot.episodes[0]?.episodeId === 'packed-browser-episode' && installedSearchSnapshot.context.entities.some((entity) => entity.id === 'packed-browser-entity') && installedNeighborhoodSnapshot.center.id === 'packed-browser-entity' && installedBrowseSnapshot.items[0]?.id === 'packed-browser-episode' && installedGraphSnapshot.episodes[0]?.id === 'packed-browser-episode' && installedAnalysisSnapshot.overview.episodes === 1 && installedAnalysisSnapshot.algorithms.personalized && installedArchiveSnapshot.canonical.episodes[0]?.id === 'packed-browser-episode' && JSON.stringify(installedChangesSnapshot.changes).includes('packed-browser-episode') && JSON.stringify(installedSignalChangesSnapshot.changes).includes('packed-browser-episode') && installedUnknownReadRejected\n` +
      `  const recallScanRejected = await reopened.recall({ anchors: { entityIds: ['packed-browser-entity'] }, access: { allowedScopes: [] }, channels: { exact: true, lexical: false, semantic: false, graph: true, temporal: false }, scanLimits: { maxRecords: 1, maxBytes: 1048576 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'recall_scan' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `  const entityPage = await reopened.browse({ kind: 'entity', access: { allowedScopes: [] }, order: 'id', limit: 1, scanLimits: { maxRecords: 100, maxBytes: 1048576 } })\n` +
      `  const browseScanRejected = await reopened.browse({ kind: 'entity', access: { allowedScopes: [] }, order: 'id', limit: 1, scanLimits: { maxRecords: 1, maxBytes: 1048576 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'browse_scan' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `  const neighborhood = await reopened.neighborhood({ entityId: 'packed-browser-entity', access: { allowedScopes: [] }, depth: 2, scanLimits: { maxRecords: 100, maxBytes: 1048576 } })\n` +
      `  const retrievalScanOk = recalled.scan.records > 0 && recalled.scan.records <= recalled.scan.limits.maxRecords && recalled.scan.bytes > 0 && recalled.scan.bytes <= recalled.scan.limits.maxBytes && entityPage.scan.records > 0 && entityPage.scan.records <= entityPage.scan.limits.maxRecords && entityPage.scan.bytes > 0 && entityPage.scan.bytes <= entityPage.scan.limits.maxBytes && neighborhood.scan.records > 0 && neighborhood.scan.records <= neighborhood.scan.limits.maxRecords && neighborhood.scan.bytes > 0 && neighborhood.scan.bytes <= neighborhood.scan.limits.maxBytes && recallScanRejected && browseScanRejected\n` +
      `  const episodePage = await reopened.browse({ kind: 'episode', access: { allowedScopes: [] }, order: 'id', filters: { episodes: { source: { kinds: ['packed-browser-smoke'] }, tags: { all: ['packed'], none: ['excluded'] } } }, limit: 1 })\n` +
      `  const signals = await reopened.browseSignals({ access: { allowedScopes: [] }, where: { namespaces: ['packed.persistence'] } })\n` +
      `  const signalChanges = await reopened.signalChanges({ access: { allowedScopes: [] }, cursor: signalBaseline.signalChangesCursor })\n` +
      `  const signalAnalysis = await reopened.analyze({ access: { allowedScopes: [] }, pagerank: { seeds: [{ id: 'packed-browser-entity' }] }, budgets: { maxScannedRecords: 100, maxScannedBytes: 1048576, maxAnalyzedRecords: 100, maxGraphNodes: 100, maxGraphEdges: 100, maxPageRankSteps: 10000, maxTemporalComparisons: 100 } })\n` +
      `  const analysisScanRejected = await reopened.analyze({ access: { allowedScopes: [] }, budgets: { maxScannedRecords: 1, maxScannedBytes: 1048576 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'analysis_scan' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `  const deltaReport = await reopened.remember({ id: 'packed-browser-delta', kind: 'assertion', content: { type: 'text', text: 'Packed cursor handoff works.' }, source: { kind: 'packed-browser-smoke' }, assertions: { entities: [{ id: 'packed-browser-entity', name: 'Packed Surreal artifact' }], facts: [{ subject: { id: 'packed-browser-entity' }, predicate: 'cursor-handoff', object: { scalar: worker ? 'worker' : 'direct' } }] } })\n` +
      `  const deltaFactId = deltaReport.facts.created[0]\n` +
      `  const ingestionLimit = await reopened.reprocessEpisode('packed-browser-delta', { operationId: \`packed-browser-ingestion-limit-\${worker ? 'worker' : 'direct'}\`, workLimits: { maxRecords: 1 } })\n` +
      `  const ingestionOk = deltaReport.work.records > 1 && deltaReport.work.bytes > 0 && ingestionLimit.operation.state === 'failed' && ingestionLimit.operation.error?.code === 'result_too_large' && ingestionLimit.work.records === 1 && ingestionLimit.work.limits.maxRecords === 1\n` +
      `  const ingestionProjectionLimit = await reopened.reprocessEpisode('packed-browser-delta', { operationId: \`packed-browser-ingestion-projection-limit-\${worker ? 'worker' : 'direct'}\`, projectionScanLimits: { maxRecords: 1, maxBytes: 1048576 } })\n` +
      `  const ingestionProjectionOk = deltaReport.projectionScan.records > 1 && deltaReport.projectionScan.bytes > 0 && ingestionProjectionLimit.operation.state === 'partial' && ingestionProjectionLimit.operation.stage === 'projection_scan_failed' && ingestionProjectionLimit.operation.error?.code === 'result_too_large' && ingestionProjectionLimit.projectionScan.records === 1 && ingestionProjectionLimit.projectionScan.limits.maxRecords === 1\n` +
      `  await reopened.remember({ id: 'packed-browser-governance', kind: 'assertion', content: { type: 'text', text: 'Packed bounded correction, retraction, and entity reconciliation work.' }, source: { kind: 'packed-browser-smoke' }, assertions: { entities: [{ id: 'packed-browser-entity', name: 'Packed Surreal artifact' }, { id: 'packed-browser-merge-alias', name: 'Packed artifact duplicate' }], facts: [{ id: 'packed-browser-correction-fact', subject: { id: 'packed-browser-entity' }, predicate: 'correction-probe', object: { scalar: true } }, { id: 'packed-browser-retraction-fact', subject: { id: 'packed-browser-entity' }, predicate: 'retraction-probe', object: { scalar: true } }] } })\n` +
      `  const correctionRevision = (await reopened.stats()).snapshotRevision\n` +
      `  const correctionRejected = await reopened.correctFact({ factId: 'packed-browser-correction-fact', replacement: { id: 'packed-browser-correction-replacement', subject: { id: 'packed-browser-entity' }, predicate: 'correction-probe', object: { scalar: false } }, access: { allowedScopes: [] }, workLimits: { maxRecords: 1 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'derivation' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `  const correctionAtomic = (await reopened.stats()).snapshotRevision === correctionRevision\n` +
      `  const correctionSnapshotRequest = { factId: 'packed-browser-correction-fact', replacement: { id: 'packed-browser-correction-replacement', subject: { id: 'packed-browser-entity' }, predicate: 'correction-probe', object: { scalar: false } }, access: { allowedScopes: [] }, workLimits: { maxRecords: 64 } }; const correctionSnapshotOptions = { operationId: 'packed-browser-correction-snapshot' }; const correctionSnapshotPromise = reopened.correctFact(correctionSnapshotRequest, correctionSnapshotOptions); correctionSnapshotRequest.factId = 'mutated-packed-browser-fact'; correctionSnapshotRequest.replacement.id = 'mutated-packed-browser-replacement'; correctionSnapshotRequest.replacement.object.scalar = true; correctionSnapshotRequest.access.allowedScopes.push('private'); correctionSnapshotRequest.workLimits.maxRecords = 0; correctionSnapshotOptions.operationId = 'mutated-packed-browser-correction'; const correction = await correctionSnapshotPromise\n` +
      `  const correctionRequestSnapshotOk = correction.operation.id === 'packed-browser-correction-snapshot' && correction.affectedFacts.includes('packed-browser-correction-replacement')\n` +
      `  const correctionOk = correctionRejected && correctionAtomic && correction.work.records > 0 && correction.work.records <= 64 && correction.work.bytes > 0 && (await reopened.getFact('packed-browser-correction-fact', { allowedScopes: [] }))?.status === 'superseded' && (await reopened.getFact('packed-browser-correction-replacement', { allowedScopes: [] }))?.status === 'active'\n` +
      `  const retractionRevision = (await reopened.stats()).snapshotRevision\n` +
      `  const retractionRejected = await reopened.retractFact({ factId: 'packed-browser-retraction-fact', allSupport: true, access: { allowedScopes: [] }, workLimits: { maxRecords: 1 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'derivation' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `  const retractionAtomic = (await reopened.stats()).snapshotRevision === retractionRevision\n` +
      `  const retraction = await reopened.retractFact({ factId: 'packed-browser-retraction-fact', allSupport: true, access: { allowedScopes: [] }, workLimits: { maxRecords: 32 } })\n` +
      `  const retractionOk = retractionRejected && retractionAtomic && retraction.work.records > 0 && retraction.work.records <= 32 && retraction.work.bytes > 0 && await reopened.getFact('packed-browser-retraction-fact', { allowedScopes: [] }) === null\n` +
      `  await reopened.remember({ id: 'packed-browser-deletion', kind: 'assertion', content: { type: 'text', text: 'Packed bounded episode deletion works.' }, source: { kind: 'packed-browser-smoke' }, assertions: { entities: [{ id: 'packed-browser-entity', name: 'Packed Surreal artifact' }], facts: [{ id: 'packed-browser-deletion-fact', subject: { id: 'packed-browser-entity' }, predicate: 'deletion-probe', object: { scalar: true } }] } })\n` +
      `  const deletionRevision = (await reopened.stats()).snapshotRevision\n` +
      `  const deletionRejected = await reopened.deleteEpisode({ episodeId: 'packed-browser-deletion', access: { allowedScopes: [] }, workLimits: { maxRecords: 1 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'derivation' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `  const deletionAtomic = (await reopened.stats()).snapshotRevision === deletionRevision\n` +
      `  const deletion = await reopened.deleteEpisode({ episodeId: 'packed-browser-deletion', access: { allowedScopes: [] }, workLimits: { maxRecords: 64 } })\n` +
      `  const deletionOk = deletionRejected && deletionAtomic && deletion.work.records > 0 && deletion.work.records <= 64 && deletion.work.bytes > 0 && await reopened.getEpisode('packed-browser-deletion', { allowedScopes: [] }) === null && await reopened.getFact('packed-browser-deletion-fact', { allowedScopes: [] }) === null\n` +
      `  const entityMergeRevision = (await reopened.stats()).snapshotRevision\n` +
      `  const entityMergeRejected = await reopened.mergeEntities({ targetId: 'packed-browser-entity', sourceIds: ['packed-browser-merge-alias'], access: { allowedScopes: [] }, workLimits: { maxRecords: 1 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'derivation' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `  const entityMergeAtomic = (await reopened.stats()).snapshotRevision === entityMergeRevision\n` +
      `  const entityMerge = await reopened.mergeEntities({ targetId: 'packed-browser-entity', sourceIds: ['packed-browser-merge-alias'], access: { allowedScopes: [] }, workLimits: { maxRecords: 64 } })\n` +
      `  const entityMergeId = entityMerge.operation.id.replace(/^op_/, 'merge_')\n` +
      `  const entitySplitRevision = (await reopened.stats()).snapshotRevision\n` +
      `  const entitySplitRejected = await reopened.splitEntityMerge({ mergeId: entityMergeId, access: { allowedScopes: [] }, workLimits: { maxRecords: 1 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'derivation' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `  const entitySplitAtomic = (await reopened.stats()).snapshotRevision === entitySplitRevision\n` +
      `  const entitySplit = await reopened.splitEntityMerge({ mergeId: entityMergeId, access: { allowedScopes: [] }, workLimits: { maxRecords: 64 } })\n` +
      `  const entityMergeOk = entityMergeRejected && entityMergeAtomic && entitySplitRejected && entitySplitAtomic && entityMerge.work.records > 0 && entityMerge.work.records <= 64 && entityMerge.work.bytes > 0 && entitySplit.work.records > 0 && entitySplit.work.records <= 64 && entitySplit.work.bytes > 0 && (await reopened.getEntity('packed-browser-merge-alias', { allowedScopes: [] }))?.mergedInto === undefined\n` +
      `  const changes = await reopened.changes({ access: { allowedScopes: [] }, cursor: baseline.changesCursor })\n` +
      `  const signalCompactionBaseline = await reopened.browseSignals({ access: { allowedScopes: [] } })\n` +
      `  await reopened.registerJournalConsumer({ id: 'packed-browser-signal-consumer', journal: 'signal', cursor: signalCompactionBaseline.signalChangesCursor })\n` +
      `  const signalCompaction = await reopened.compactSignalChanges({ confirmSpaceId: 'packed-browser', registeredConsumers: true, expectedRevision: signalCompactionBaseline.snapshotRevision, maxChanges: 1000 })\n` +
      `  const compactionBaseline = await reopened.snapshot({ access: { allowedScopes: [] } })\n` +
      `  await reopened.registerJournalConsumer({ id: 'packed-browser-semantic-consumer', journal: 'semantic', cursor: compactionBaseline.changesCursor })\n` +
      `  const compaction = await reopened.compactChanges({ confirmSpaceId: 'packed-browser', registeredConsumers: true, expectedRevision: compactionBaseline.snapshotRevision, maxChanges: 1000 })\n` +
      `  const journalConsumers = [...(await reopened.journalConsumers({ journal: 'semantic' })).consumers, ...(await reopened.journalConsumers({ journal: 'signal' })).consumers]\n` +
      `  const compactedStats = await reopened.stats()\n` +
      `  const boundedStats = await reopened.stats({ scanLimits: { maxRecords: compactedStats.scan.records, maxBytes: compactedStats.scan.bytes } })\n` +
      `  const statsScanRejected = await reopened.stats({ scanLimits: { maxRecords: compactedStats.scan.records - 1, maxBytes: compactedStats.scan.bytes } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'stats_scan' && error?.details?.dimension === 'records' && error?.details?.required === compactedStats.scan.records && error?.details?.maximum === compactedStats.scan.records - 1)\n` +
      `  const inspection = await reopened.inspect()\n` +
      `  const boundedInspection = await reopened.inspect({ scanLimits: { maxRecords: inspection.scan.records, maxBytes: inspection.scan.bytes } })\n` +
      `  const inspectionScanRejected = await reopened.inspect({ scanLimits: { maxRecords: inspection.scan.records - 1, maxBytes: inspection.scan.bytes } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'inspection_scan' && error?.details?.dimension === 'records' && error?.details?.required === inspection.scan.records && error?.details?.maximum === inspection.scan.records - 1)\n` +
      `  const managementScanOk = compactedStats.scan.records > 1 && compactedStats.scan.bytes > 0 && boundedStats.scan.records === compactedStats.scan.records && boundedStats.scan.bytes === compactedStats.scan.bytes && statsScanRejected && inspection.scan.records > 1 && inspection.scan.bytes > 0 && boundedInspection.scan.records === inspection.scan.records && boundedInspection.scan.bytes === inspection.scan.bytes && inspectionScanRejected\n` +
      `  const afterCompaction = await reopened.changes({ access: { allowedScopes: [] }, cursor: compactionBaseline.changesCursor })\n` +
      `  const afterSignalCompaction = await reopened.signalChanges({ access: { allowedScopes: [] }, cursor: signalCompactionBaseline.signalChangesCursor })\n` +
      `  const integrityRevision = compactedStats.snapshotRevision\n` +
      `  const integrityRejected = await reopened.verifyIntegrity({ limits: { maxRecords: 1, maxBytes: 1048576, maxGraphNodes: 100, maxGraphEdges: 100, maxIssues: 10 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'integrity' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `  const integrity = await reopened.verifyIntegrity({ limits: { maxRecords: 10000, maxBytes: 16777216, maxGraphNodes: 10000, maxGraphEdges: 10000, maxIssues: 100 } })\n` +
      `  const integrityOk = integrityRejected && (await reopened.stats()).snapshotRevision === integrityRevision && integrity.ok && integrity.issues.length === 0 && integrity.work.records > 0 && integrity.work.records <= integrity.work.limits.maxRecords && integrity.work.bytes > 0 && integrity.work.bytes <= integrity.work.limits.maxBytes && integrity.work.graphNodes <= integrity.work.limits.maxGraphNodes && integrity.work.graphEdges <= integrity.work.limits.maxGraphEdges && integrity.work.issuesDetected === 0 && !integrity.work.issuesTruncated\n` +
      `  let checkpointAccessReads = 0; const checkpointAccess = {}; Object.defineProperty(checkpointAccess, 'allowedScopes', { enumerable: true, get: () => { checkpointAccessReads += 1; if (checkpointAccessReads > 1) throw new Error('packed browser checkpoint access read twice'); return [] } }); const checkpointRequest = { access: checkpointAccess, confirmSpaceId: 'packed-browser', maxChunkBytes: 65536 }; const checkpointOptions = { operationId: 'packed-browser-checkpoint' }; const checkpointPromise = reopened.createSyncCheckpoint(checkpointRequest, checkpointOptions); const checkpointRequestCaptured = checkpointAccessReads === 1; checkpointRequest.confirmSpaceId = 'mutated-packed-browser'; checkpointRequest.maxChunkBytes = 1; checkpointOptions.operationId = 'mutated-packed-browser-checkpoint'; const checkpoint = await checkpointPromise\n` +
      `  const replicaEndpoint = \`indxdb://packedconsumerreplica\${crypto.randomUUID().replaceAll('-', '')}\`\n` +
      `  const replica = createMemory({ spaceId: 'packed-browser', storage: createSurrealMemoryStorage({ endpoint: replicaEndpoint, worker }) })\n` +
      `  await replica.open({ create: true })\n` +
      `  let pullAccessReads = 0; const pullAccess = {}; Object.defineProperty(pullAccess, 'allowedScopes', { enumerable: true, get: () => { pullAccessReads += 1; if (pullAccessReads > 1) throw new Error('packed browser pull access read twice'); return [] } }); const pullRequest = { access: pullAccess, confirmSpaceId: 'packed-browser', strategy: 'fast-forward-only', maxAncestry: 10000, receiveLimits: { maxBytes: 67108864, maxRecords: 10000, maxChunks: 1000 } }; const pullOptions = { operationId: 'packed-browser-sync' }; const pullPromise = replica.syncFrom(reopened, pullRequest, pullOptions); const pullRequestCaptured = pullAccessReads === 1; pullRequest.confirmSpaceId = 'mutated-packed-browser'; pullRequest.maxAncestry = 0; pullRequest.receiveLimits.maxRecords = 0; pullOptions.operationId = 'mutated-packed-browser-sync'; const sync = await pullPromise\n` +
      `  const syncUnknownFieldRejected = await reopened.syncHistory({ access: { allowedScopes: [] }, unexpected: true }).then(() => false, (error) => error?.code === 'invalid_input'); const syncRequestSnapshotsOk = checkpointRequestCaptured && pullRequestCaptured && sync.operation?.id === 'packed-browser-sync' && syncUnknownFieldRejected\n` +
      `  const replicaFact = await replica.getFact(factId, { allowedScopes: [] })\n` +
      `  const replicaHead = await replica.syncHead({ allowedScopes: [] })\n` +
      `  await reopened.remember({ id: 'packed-browser-sync-compaction-sentinel', kind: 'text', content: { type: 'text', text: 'Packed sync compaction works.' }, source: { kind: 'packed-browser-smoke' } })\n` +
      `  const compactedHead = await reopened.createSyncCheckpoint({ access: { allowedScopes: [] }, confirmSpaceId: 'packed-browser', maxChunkBytes: 65536 }, { operationId: 'packed-browser-compacted-head' })\n` +
      `  const syncCompactionBaseline = await reopened.snapshot({ access: { allowedScopes: [] } })\n` +
      `  const syncCompaction = await reopened.compactSyncHistory({ access: { allowedScopes: [] }, confirmSpaceId: 'packed-browser', expectedRevision: syncCompactionBaseline.snapshotRevision, expectedHead: compactedHead.id, before: new Date(Date.now() + 60000).toISOString(), maxCheckpoints: 64 })\n` +
      `  const compactedPayloadUnavailable = await reopened.syncChunks({ access: { allowedScopes: [] }, checkpointId: checkpoint.id }).then(() => false, (error) => error?.code === 'not_found' && error?.details?.requiresReseed === true)\n` +
      `  const syncHistory = await reopened.syncHistory({ access: { allowedScopes: [] }, limit: 100 })\n` +
      `  let syncBundleCursor\n  let syncBundleCommit = false\n  let syncBundleChunks = 0\n  const syncBundleFrames = []\n  do { const page = await reopened.exportSyncBundle({ access: { allowedScopes: [] }, confirmSpaceId: 'packed-browser', checkpointId: compactedHead.id, cursor: syncBundleCursor, maxCheckpoints: 64, maxCheckpointBytes: 131072, limit: 2, maxBytes: 131072 }); syncBundleFrames.push(...page.frames); syncBundleCommit ||= page.frames.some((frame) => frame.type === 'commit' && frame.checkpointId === compactedHead.id); syncBundleChunks += page.frames.filter((frame) => frame.type === 'chunk').length; syncBundleCursor = page.nextCursor } while (syncBundleCursor !== undefined)\n` +
      `  const syncBundlePeer = await openSyncBundle({ readCommit: async () => syncBundleFrames.find((frame) => frame.type === 'commit') ?? null, readCheckpoint: async (index) => syncBundleFrames.find((frame) => frame.type === 'checkpoint' && frame.index === index) ?? null, readChunk: async (index) => syncBundleFrames.find((frame) => frame.type === 'chunk' && frame.chunk.index === index) ?? null }, { maxCheckpoints: 64, maxCheckpointBytes: 131072 })\n` +
      `  const syncBundleHead = await syncBundlePeer.syncHead({ allowedScopes: [] })\n` +
      `  const sessionCompaction = await reopened.compactSyncSessions({ access: { allowedScopes: [] }, confirmSpaceId: 'packed-browser', expectedRevision: syncCompactionBaseline.snapshotRevision, expectedHead: compactedHead.id, before: new Date(Date.now() + 60000).toISOString(), maxSessions: 64 })\n` +
      `  const syncSessions = await reopened.syncSessions({ access: { allowedScopes: [] }, limit: 100 })\n` +
      `  const retainedHeadPayload = await reopened.syncChunks({ access: { allowedScopes: [] }, checkpointId: compactedHead.id })\n` +
      `  await replica.close()\n` +
      `  await reopened.close()\n` +
      `  window.__packedTemporalMemoryStage = 'verified'\n` +
      `  if (!contextScanOk) throw new Error('packed bounded inference context failed')\n` +
      `  if (!ingestionOk) throw new Error('packed bounded ingestion failed')\n` +
      `  if (!ingestionProjectionOk) throw new Error('packed bounded automatic projection failed')\n` +
      `  if (!constructionOptionsSnapshotted || !publicOutputsDetached || !facadeOptionsSnapshotted || !signalRequestSnapshotted || !coreReadRequestSnapshotOk || !resetRequestSnapshotOk || !projectionRequestSnapshotOk || !correctionRequestSnapshotOk || !syncRequestSnapshotsOk || !pointReadScanOk || !resetScanOk || !signalBasisScanOk || !packedBatchOk || !packedWithdrawalBatchOk || !episodeDeletionPreviewOk || !packedBatchPersisted || !projectionSetOk || !projectionScanOk || !managementScanOk || !rawOk || !migrationOk || baseline.scan.records < 1 || baseline.scan.records > baseline.scan.limits.maxRecords || baseline.scan.bytes < 1 || baseline.scan.bytes > baseline.scan.limits.maxBytes || !snapshotScanRejected || fact?.status !== 'active' || !recalled.facts.some((item) => item.id === factId) || !Number.isInteger(recalled.snapshotRevision) || typeof recalled.generatedAt !== 'string' || !retrievalScanOk || episodePage.items[0]?.id !== 'packed-browser-episode' || signals.total !== 1 || signals.signals[0]?.namespace !== 'packed.persistence' || typeof signals.targetSelectionCursor !== 'string' || signalChanges.changes.length !== 1 || signalChanges.changes[0]?.action !== 'put' || signalAnalysis.signals.active !== 1 || signalAnalysis.algorithms.graph !== 'personalized-pagerank-v1' || signalAnalysis.algorithms.seedCount !== 1 || signalAnalysis.findingSummary.returned !== signalAnalysis.findings.length || signalAnalysis.findingSummary.total < signalAnalysis.findingSummary.returned || signalAnalysis.findingSummary.returned > 20 || signalAnalysis.work.scannedRecords < 1 || signalAnalysis.work.scannedRecords > signalAnalysis.work.limits.maxScannedRecords || signalAnalysis.work.scannedBytes < 1 || signalAnalysis.work.scannedBytes > signalAnalysis.work.limits.maxScannedBytes || !analysisScanRejected || signalAnalysis.work.pageRankSteps > signalAnalysis.work.limits.maxPageRankSteps || !correctionOk || !retractionOk || !deletionOk || !entityMergeOk || !integrityOk || changes.changes.some((change) => change.revision <= baseline.snapshotRevision) || !changes.changes.some((change) => change.phase === 'canonical' && change.partitions.some((partition) => partition.affected.factIds.includes(deltaFactId))) || signalCompaction.deletedChanges !== 1 || compactedStats.signalChanges !== 0 || compactedStats.signalChangesCompactedThrough !== signalCompactionBaseline.snapshotRevision || afterSignalCompaction.changes.length !== 0 || compaction.deletedChanges < 1 || compactedStats.changes !== 0 || compactedStats.signals !== 1 || compactedStats.signalRevisions !== 1 || afterCompaction.changes.length !== 0 || journalConsumers.length !== 2 || journalConsumers.some((consumer) => consumer.state !== 'active') || sync.state !== 'succeeded' || sync.diagnosticsTruncated !== false || sync.error !== undefined || sync.checkpoint?.id !== checkpoint.id || replicaHead.id !== checkpoint.id || replicaFact?.status !== 'active' || syncCompaction.compactedCheckpoints !== 1 || syncCompaction.selected[0]?.checkpointId !== checkpoint.id || !compactedPayloadUnavailable || syncHistory.checkpoints.find((item) => item.checkpoint.id === checkpoint.id)?.payloadState !== 'pruned' || !syncBundleCommit || syncBundleChunks !== compactedHead.chunkCount || syncBundleHead.id !== compactedHead.id || sessionCompaction.compactedSessions < 1 || !syncSessions.sessions.every((session) => session.detailsState === 'pruned' && typeof session.diagnosticsTruncated === 'boolean') || retainedHeadPayload.chunks.length < 1) throw new Error('packed Surreal migration, projection cutover/scan, persistence, raw query, construction/public-output and facade/signal/core-read/mutation/sync request snapshots, bounded derivation activation/withdrawal batch/episode preview/management/point/reset/signal basis/retrieval/integrity/snapshot/analysis/correction/retraction/deletion/merge, journals, bundle export, compaction, inventory, or whole-memory sync failed')\n` +
      `  window.__packedTemporalMemoryResult = { ok: true, worker }\n` +
      `}\n` +
      `void run().catch((error) => { window.__packedTemporalMemoryResult = { ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) } })\n`,
  )
  writeFileSync(
    join(consumerRoot, 'browser-smoke.html'),
    '<!doctype html><meta charset="utf-8"><script type="module" src="/browser-smoke.mjs"></script>\n',
  )
  writeFileSync(
    join(consumerRoot, 'browser-independent.mjs'),
    `import { createMemory } from '@astrale-os/temporal-memory'\n` +
      `import { createSurrealMemoryStorage } from '@astrale-os/temporal-memory/surreal'\n` +
      `const access = { allowedScopes: [] }\n` +
      `const spaceId = 'packed-independent-space'\n` +
      `let memory\n` +
      `const required = () => { if (memory === undefined) throw new Error('packed independent memory is not open'); return memory }\n` +
      `const stats = async () => { const result = await required().stats(); return { revision: result.snapshotRevision, episodes: result.episodes, signals: result.signals } }\n` +
      `const failure = (error) => ({ ok: false, error: { code: error?.code ?? 'unexpected', retryable: error?.retryable === true, details: error?.details } })\n` +
      `window.__packedIndependent = {\n` +
      `  open: async ({ endpoint, worker, create }) => { memory = createMemory({ spaceId, storage: createSurrealMemoryStorage({ endpoint, worker }) }); await memory.open({ create }); return stats() },\n` +
      `  seed: async () => { await required().remember({ id: 'shared-episode', kind: 'text', content: { type: 'text', text: 'Packed tabs share durable memory.' }, source: { kind: 'packed-independent' } }); return stats() },\n` +
      `  stats,\n` +
      `  baseline: async () => { const page = await required().browseSignals({ access }); return { cursor: page.signalChangesCursor, revision: page.snapshotRevision } },\n` +
      `  put: async ({ suffix, expectedRevision }) => { try { const report = await required().putSignals({ access, expectedRevision, signals: [{ namespace: 'packed-independent', slot: suffix, target: { kind: 'episode', id: 'shared-episode' }, producer: { kind: 'manual', id: 'page-' + suffix, version: '1' }, scopes: [], value: suffix }] }); return { ok: true, revision: report.revision } } catch (error) { return failure(error) } },\n` +
      `  signals: async () => { const page = await required().browseSignals({ access, order: 'key', limit: 100 }); return { revision: page.snapshotRevision, total: page.total, ids: page.signals.map((signal) => signal.id).sort(), slots: page.signals.map((signal) => signal.slot).sort() } },\n` +
      `  changes: async ({ cursor }) => { try { const page = await required().signalChanges({ access, cursor, limit: 100 }); return { ok: true, actions: page.changes.map((change) => change.action) } } catch (error) { return failure(error) } },\n` +
      `  compact: async ({ expectedRevision, cursor }) => required().compactSignalChanges({ confirmSpaceId: spaceId, consumerCursors: [cursor], expectedRevision, maxChanges: 100 }),\n` +
      `  reset: async () => { await required().resetSpace({ confirmSpaceId: spaceId }); await required().open({ create: true }); return stats() },\n` +
      `  attemptStats: async () => { try { return { ok: true, ...(await stats()) } } catch (error) { return failure(error) } },\n` +
      `  reopen: async () => { await required().close(); await required().open(); return stats() },\n` +
      `  close: async () => { if (memory !== undefined) await memory.close(); memory = undefined; return true },\n` +
      `}\n`,
  )
  writeFileSync(
    join(consumerRoot, 'browser-independent.html'),
    '<!doctype html><meta charset="utf-8"><script type="module" src="/browser-independent.mjs"></script>\n',
  )

  const server = await createServer({
    configFile: false,
    root: consumerRoot,
    logLevel: 'error',
    optimizeDeps: {
      exclude: ['@astrale-os/surrealdb-wasm'],
    },
    server: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    await server.listen()
    const origin = server.resolvedUrls?.local[0]
    if (origin === undefined) throw new Error('Vite did not expose a packed-consumer URL')
    for (const worker of [false, true]) {
      const page = await browser.newPage()
      const diagnostics = []
      page.on('console', (message) =>
        diagnostics.push(`console:${message.type()}: ${message.text()}`),
      )
      page.on('pageerror', (error) =>
        diagnostics.push(`pageerror: ${error.stack ?? error.message}`),
      )
      page.on('requestfailed', (request) =>
        diagnostics.push(
          `requestfailed: ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`,
        ),
      )
      try {
        const url = new URL('browser-smoke.html', origin)
        url.searchParams.set('worker', String(worker))
        await page.goto(url.href)
        try {
          await page.waitForFunction(
            () => window.__packedTemporalMemoryResult !== undefined,
            null,
            { timeout: 30_000 },
          )
        } catch (error) {
          const stage = await page.evaluate(() => window.__packedTemporalMemoryStage)
          throw new Error(
            `packed ${worker ? 'worker' : 'direct'} browser smoke stalled at ${stage ?? 'module-load'}${diagnostics.length === 0 ? '' : `\n${diagnostics.join('\n')}`}`,
            { cause: error },
          )
        }
        const result = await page.evaluate(() => window.__packedTemporalMemoryResult)
        if (result?.ok !== true || result.worker !== worker) {
          throw new Error(
            `packed ${worker ? 'worker' : 'direct'} browser smoke failed: ${JSON.stringify(result)}`,
          )
        }
      } finally {
        await page.close()
      }
    }
    const context = await browser.newContext()
    const left = await context.newPage()
    const right = await context.newPage()
    try {
      const url = new URL('browser-independent.html', origin).href
      await Promise.all([left.goto(url), right.goto(url)])
      await Promise.all([
        left.waitForFunction(() => window.__packedIndependent !== undefined),
        right.waitForFunction(() => window.__packedIndependent !== undefined),
      ])
      const command = (page, method, input) =>
        page.evaluate(
          async ({ method, input }) => {
            const api = window.__packedIndependent
            if (api === undefined || typeof api[method] !== 'function') {
              throw new Error(`packed independent command is unavailable: ${method}`)
            }
            return api[method](input)
          },
          { method, input },
        )
      const endpoint = `indxdb://packedindependent${randomUUID().replaceAll('-', '')}`
      await command(left, 'open', { endpoint, worker: false, create: true })
      await command(left, 'seed')
      await command(right, 'open', { endpoint, worker: true, create: false })
      const baseline = await command(left, 'baseline')
      const attempts = await Promise.all([
        command(left, 'put', { suffix: 'left', expectedRevision: baseline.revision }),
        command(right, 'put', { suffix: 'right', expectedRevision: baseline.revision }),
      ])
      const winnerCount = attempts.filter((attempt) => attempt.ok === true).length
      const loser = attempts.find((attempt) => attempt.ok === false)
      if (
        winnerCount !== 1 ||
        loser?.error?.code !== 'conflict' ||
        loser.error.retryable !== true
      ) {
        throw new Error(`packed independent commit race failed: ${JSON.stringify(attempts)}`)
      }
      const afterRace = await command(left, 'signals')
      const firstChanges = await command(left, 'changes', { cursor: baseline.cursor })
      if (afterRace.total !== 1 || firstChanges.ok !== true || firstChanges.actions.length !== 1) {
        throw new Error('packed independent losing commit left partial rows')
      }
      const loserPage = attempts[0].ok === false ? left : right
      const retryBaseline = await command(loserPage, 'stats')
      const retry = await command(loserPage, 'put', {
        suffix: attempts[0].ok === false ? 'left' : 'right',
        expectedRevision: retryBaseline.revision,
      })
      if (retry.ok !== true || retry.revision !== retryBaseline.revision + 1) {
        throw new Error(`packed independent retry failed: ${JSON.stringify(retry)}`)
      }
      const [leftSignals, rightSignals] = await Promise.all([
        command(left, 'signals'),
        command(right, 'signals'),
      ])
      if (
        leftSignals.total !== 2 ||
        leftSignals.slots.join(',') !== 'left,right' ||
        JSON.stringify(leftSignals) !== JSON.stringify(rightSignals)
      ) {
        throw new Error('packed independent clients did not converge')
      }
      const compactionBaseline = await command(right, 'baseline')
      const compaction = await command(right, 'compact', {
        expectedRevision: leftSignals.revision,
        cursor: compactionBaseline.cursor,
      })
      const expired = await command(left, 'changes', { cursor: baseline.cursor })
      if (
        compaction.deletedChanges !== 2 ||
        expired.ok !== false ||
        expired.error?.details?.requiresSignalBaseline !== true
      ) {
        throw new Error('packed independent compaction floor was not observed')
      }
      const recreated = await command(right, 'reset')
      const stale = await command(left, 'attemptStats')
      const reopened = await command(left, 'reopen')
      if (
        recreated.revision !== 0 ||
        stale.ok !== false ||
        stale.error?.details?.requiresReopen !== true ||
        reopened.revision !== 0 ||
        reopened.episodes !== 0 ||
        reopened.signals !== 0
      ) {
        throw new Error('packed independent reset incarnation was not fenced')
      }
      await Promise.all([command(left, 'close'), command(right, 'close')])
    } finally {
      await context.close()
    }
  } finally {
    await browser.close()
    await server.close()
  }
}

try {
  execFileSync('pnpm', ['pack', '--pack-destination', temporaryRoot], {
    cwd: packageRoot,
    stdio: 'inherit',
  })
  const tarballs = readdirSync(temporaryRoot).filter((name) => name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`expected exactly one packed tarball, found ${tarballs.length}`)
  }

  const consumerRoot = join(temporaryRoot, 'consumer')
  mkdirSync(consumerRoot)
  const tarball = join(temporaryRoot, tarballs[0])
  writeFileSync(
    join(consumerRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'temporal-memory-packed-consumer',
        private: true,
        type: 'module',
        dependencies: { '@astrale-os/temporal-memory': `file:${tarball}` },
        ...(nodeOnly
          ? {}
          : {
              devDependencies: {
                vite: JSON.parse(
                  readFileSync(join(packageRoot, 'node_modules/vite/package.json'), 'utf8'),
                ).version,
              },
            }),
      },
      null,
      2,
    )}\n`,
  )
  const storePath = join(temporaryRoot, 'pnpm-store')
  execFileSync('pnpm', ['install', '--store-dir', storePath], {
    cwd: consumerRoot,
    stdio: 'inherit',
  })

  const installedRoot = join(consumerRoot, 'node_modules', '@astrale-os', 'temporal-memory')
  const manifest = JSON.parse(readFileSync(join(installedRoot, 'package.json'), 'utf8'))
  const expectedExports = {
    '.': { import: './dist/index.js', types: './dist/types/index.d.ts' },
    './surreal': { import: './dist/surreal.js', types: './dist/types/surreal/index.d.ts' },
    './testing': { import: './dist/testing.js', types: './dist/types/testing/index.d.ts' },
  }
  for (const [subpath, expected] of Object.entries(expectedExports)) {
    if (manifest.exports?.[subpath]?.import !== expected.import) {
      throw new Error(`packed export ${subpath} does not resolve to ${expected.import}`)
    }
    if (manifest.exports?.[subpath]?.types !== expected.types) {
      throw new Error(`packed types ${subpath} do not resolve to ${expected.types}`)
    }
  }
  if (manifest.dependencies?.['@astrale-os/surrealdb-wasm'] !== wasmReleaseUrl) {
    throw new Error('packed manifest does not pin the verified WASM release asset')
  }
  const installedWasmPaths = execFileSync(
    'pnpm',
    ['list', '@astrale-os/surrealdb-wasm', '--parseable', '--depth', 'Infinity'],
    { cwd: consumerRoot, encoding: 'utf8' },
  )
    .trim()
    .split('\n')
    .filter((path) => basename(path) === 'surrealdb-wasm')
  if (installedWasmPaths.length !== 1) {
    throw new Error(`expected one installed WASM dependency, found ${installedWasmPaths.length}`)
  }
  const installedWasmRoot = installedWasmPaths[0]
  const wasmManifest = JSON.parse(readFileSync(join(installedWasmRoot, 'package.json'), 'utf8'))
  if (
    wasmManifest.name !== '@astrale-os/surrealdb-wasm' ||
    wasmManifest.version !== '3.0.4-astrale.1' ||
    wasmManifest.surreal !== '3.0.5'
  ) {
    throw new Error('installed WASM release metadata is unexpected')
  }
  const installedWasmHash = createHash('sha256')
    .update(readFileSync(join(installedWasmRoot, 'wasm', 'surrealdb_bg.wasm')))
    .digest('hex')
  if (installedWasmHash !== wasmSha256) {
    throw new Error(`installed WASM hash mismatch: ${installedWasmHash}`)
  }
  if (existsSync(join(installedRoot, 'src'))) {
    throw new Error('packed package unexpectedly contains source files')
  }
  for (const file of [
    'README.md',
    'LICENSE',
    'CHANGELOG.md',
    'dist/index.js',
    'dist/sbom.cdx.json',
    'dist/surreal.js',
    'dist/testing.js',
    'dist/types/index.d.ts',
    'dist/types/surreal/index.d.ts',
    'dist/types/testing/index.d.ts',
  ]) {
    requirePath(join(installedRoot, file), file)
  }
  const sourceSbom = verifySbom(join(packageRoot, 'dist', 'sbom.cdx.json'))
  const installedSbom = verifySbom(join(installedRoot, 'dist', 'sbom.cdx.json'))
  if (installedSbom !== sourceSbom) {
    throw new Error('packed SBOM differs from the deterministic build artifact')
  }

  const smokePath = join(consumerRoot, 'smoke.mjs')
  writeFileSync(
    smokePath,
    `import { createMemory, openSyncBundle } from '@astrale-os/temporal-memory'\n` +
      `import { createSurrealMemoryStorage } from '@astrale-os/temporal-memory/surreal'\n` +
      `import { createInMemoryStorage } from '@astrale-os/temporal-memory/testing'\n` +
      `if (typeof createSurrealMemoryStorage !== 'function') throw new Error('surreal export missing')\n` +
      `const constructionStorage = createInMemoryStorage(); const constructionReads = {}; const constructionCapture = (name, value, later = value) => () => { const count = (constructionReads[name] ?? 0) + 1; constructionReads[name] = count; return count === 1 ? value : later }; const constructionOntology = { id: 'packed.node.construction', version: '1', mode: 'open', entityTypes: {}, factTypes: {} }; const constructionOptions = {}; Object.defineProperties(constructionOptions, { spaceId: { enumerable: true, get: constructionCapture('spaceId', 'packed-node-construction', '') }, storage: { enumerable: true, get: constructionCapture('storage', constructionStorage) }, ontology: { enumerable: true, get: constructionCapture('ontology', constructionOntology) }, operationTimeoutMs: { enumerable: true, get: constructionCapture('operationTimeoutMs', 5000, 0) } }); const constructionMemory = createMemory(constructionOptions); constructionOntology.id = 'mutated-after-construction'; const constructionSpace = await constructionMemory.open({ create: true }); let constructionUnknownRejected = false; try { createMemory({ spaceId: 'packed-node-construction-unknown', storage: constructionStorage, unsupported: true }) } catch (error) { constructionUnknownRejected = error?.code === 'invalid_input' }; if (constructionSpace.id !== 'packed-node-construction' || constructionSpace.ontology.id !== 'packed.node.construction' || !constructionUnknownRejected || Object.keys(constructionReads).length !== 4 || !Object.values(constructionReads).every((count) => count === 1)) throw new Error('packed construction option snapshot failed'); await constructionMemory.close()\n` +
      `const memory = createMemory({ spaceId: 'packed-smoke', storage: createInMemoryStorage() })\n` +
      `await memory.open({ create: true })\n` +
      `const signalSnapshotMemory = createMemory({ spaceId: 'packed-signal-snapshot', storage: createInMemoryStorage() })\n` +
      `const facadeOpenOptions = { create: true, metadata: { owner: 'packed-node-original', nested: { state: 'ready' } } }; const facadeOpenPromise = signalSnapshotMemory.open(facadeOpenOptions); facadeOpenOptions.create = false; facadeOpenOptions.metadata.owner = 'packed-node-mutated'; facadeOpenOptions.metadata.nested.state = 'mutated'; const facadeSpace = await facadeOpenPromise\n` +
      `const facadeOpenInputSnapshotted = facadeSpace.metadata?.owner === 'packed-node-original' && facadeSpace.metadata?.nested?.state === 'ready'; facadeSpace.metadata.owner = 'returned-value-mutation'; facadeSpace.metadata.nested.state = 'returned-value-mutation'; const facadeReopenedSpace = await signalSnapshotMemory.open(); let facadeListenerIsolated = false; let facadeListenerState; let facadeListenerWarnings; signalSnapshotMemory.on('operation:settled', (event) => { event.operation.state = 'failed'; event.operation.warnings.push('first-listener-mutation') }); signalSnapshotMemory.on('operation:settled', (event) => { facadeListenerState = event.operation.state; facadeListenerWarnings = event.operation.warnings; facadeListenerIsolated = event.operation.state !== 'failed' && !event.operation.warnings.includes('first-listener-mutation') })\n` +
      `const facadeRemember = await signalSnapshotMemory.remember({ id: 'packed-signal-snapshot-target', kind: 'assertion', content: { type: 'text', text: 'Packed request snapshot target.' }, source: { kind: 'packed-signal-snapshot', metadata: { owner: 'original' } }, assertions: { entities: [{ id: 'packed-signal-snapshot-entity', name: 'Packed Snapshot Entity' }] } }, { operationId: 'packed-node-output-operation' }); facadeRemember.episode.content.text = 'Returned value mutation.'; facadeRemember.episode.source.metadata.owner = 'returned-value-mutation'; facadeRemember.operation.warnings.push('returned-report-mutation')\n` +
      `const signalSnapshotRevision = (await signalSnapshotMemory.stats()).snapshotRevision\n` +
      `const snapshotSignal = { namespace: 'packed.snapshot.original', target: { kind: 'episode', id: 'packed-signal-snapshot-target' }, producer: { kind: 'algorithm', id: 'packed-snapshot', version: '1' }, scopes: [], basis: { episodeIds: ['packed-signal-snapshot-target'] }, value: { state: 'original' } }\n` +
      `const snapshotPutRequest = { access: { allowedScopes: [] }, expectedRevision: signalSnapshotRevision, signals: [snapshotSignal] }\n` +
      `const snapshotPutPromise = signalSnapshotMemory.putSignals(snapshotPutRequest)\n` +
      `snapshotSignal.namespace = 'packed.snapshot.mutated'; snapshotSignal.target.id = 'missing-mutated-target'; snapshotSignal.basis.episodeIds[0] = 'missing-mutated-target'; snapshotSignal.value.state = 'mutated'\n` +
      `const snapshotPut = await snapshotPutPromise\n` +
      `const snapshotBrowseRequest = { access: { allowedScopes: [] }, where: { namespaces: ['packed.snapshot.original'] } }\n` +
      `const snapshotBrowsePromise = signalSnapshotMemory.browseSignals(snapshotBrowseRequest)\n` +
      `snapshotBrowseRequest.where.namespaces[0] = 'packed.snapshot.mutated'\n` +
      `const snapshotBrowse = await snapshotBrowsePromise\n` +
      `const snapshotDeleteRequest = { access: { allowedScopes: [] }, mode: 'withdraw', where: { namespaces: ['packed.snapshot.original'] }, expectedRevision: snapshotPut.revision, maxMatches: 1, reason: 'original retirement' }\n` +
      `const snapshotDeletePromise = signalSnapshotMemory.deleteSignals(snapshotDeleteRequest)\n` +
      `snapshotDeleteRequest.mode = 'purge'; snapshotDeleteRequest.where.namespaces[0] = 'packed.snapshot.mutated'; snapshotDeleteRequest.reason = 'mutated retirement'; snapshotDeleteRequest.maxRevisions = 1\n` +
      `const snapshotDelete = await snapshotDeletePromise\n` +
      `if (snapshotPut.signals[0]?.namespace !== 'packed.snapshot.original' || snapshotPut.signals[0]?.state !== 'active' || snapshotPut.signals[0]?.value.state !== 'original' || snapshotBrowse.signals[0]?.id !== snapshotPut.signals[0]?.id || snapshotDelete.mode !== 'withdraw' || snapshotDelete.withdrawn[0]?.state !== 'withdrawn' || snapshotDelete.withdrawn[0]?.withdrawalReason !== 'original retirement') throw new Error('packed signal request snapshot failed')\n` +
      `const packedPointRequest = { kind: 'episode', id: 'packed-signal-snapshot-target', access: { allowedScopes: [] } }; const packedPointPromise = signalSnapshotMemory.read(packedPointRequest); packedPointRequest.id = 'missing-mutated-target'; packedPointRequest.access.allowedScopes.push('private'); const packedPoint = await packedPointPromise\n` +
      `const packedRecallRequest = { anchors: { entityIds: ['packed-signal-snapshot-entity'] }, access: { allowedScopes: [] }, filters: { episodes: { ids: ['packed-signal-snapshot-target'] } }, channels: { exact: true, lexical: false, semantic: false, graph: false, temporal: false } }; const packedRecallPromise = signalSnapshotMemory.recall(packedRecallRequest); packedRecallRequest.anchors.entityIds[0] = 'missing-mutated-entity'; packedRecallRequest.filters.episodes.ids[0] = 'missing-mutated-target'; packedRecallRequest.access.allowedScopes.push('private'); const packedRecall = await packedRecallPromise\n` +
      `const packedSearchRequest = { anchors: { entityIds: ['packed-signal-snapshot-entity'] }, access: { allowedScopes: [] }, channels: { exact: true, lexical: false, semantic: false, graph: false, temporal: false }, target: 'all' }; const packedSearchPromise = signalSnapshotMemory.search(packedSearchRequest); packedSearchRequest.anchors.entityIds[0] = 'missing-mutated-entity'; packedSearchRequest.target = 'episodes'; const packedSearch = await packedSearchPromise\n` +
      `const packedNeighborhoodRequest = { entityId: 'packed-signal-snapshot-entity', access: { allowedScopes: [] } }; const packedNeighborhoodPromise = signalSnapshotMemory.neighborhood(packedNeighborhoodRequest); packedNeighborhoodRequest.entityId = 'missing-mutated-entity'; const packedNeighborhood = await packedNeighborhoodPromise\n` +
      `const packedBrowseRequest = { kind: 'episode', access: { allowedScopes: [] }, filters: { episodes: { ids: ['packed-signal-snapshot-target'] } }, limit: 10 }; const packedBrowsePromise = signalSnapshotMemory.browse(packedBrowseRequest); packedBrowseRequest.filters.episodes.ids[0] = 'missing-mutated-target'; const packedBrowse = await packedBrowsePromise\n` +
      `const packedGraphRequest = { access: { allowedScopes: [] }, filters: { episodes: { ids: ['packed-signal-snapshot-target'] } }, maxRecords: 100 }; const packedGraphPromise = signalSnapshotMemory.snapshot(packedGraphRequest); packedGraphRequest.filters.episodes.ids[0] = 'missing-mutated-target'; const packedGraph = await packedGraphPromise\n` +
      `const packedAnalysisRequest = { access: { allowedScopes: [] }, filters: { episodes: { ids: ['packed-signal-snapshot-target'] } }, pagerank: { seeds: [{ id: 'packed-signal-snapshot-entity' }] } }; const packedAnalysisPromise = signalSnapshotMemory.analyze(packedAnalysisRequest); packedAnalysisRequest.filters.episodes.ids[0] = 'missing-mutated-target'; packedAnalysisRequest.pagerank.seeds[0].id = 'missing-mutated-entity'; const packedAnalysis = await packedAnalysisPromise\n` +
      `const packedArchiveRequest = { access: { allowedScopes: [] }, episodeIds: ['packed-signal-snapshot-target'] }; const packedArchivePromise = signalSnapshotMemory.export(packedArchiveRequest); packedArchiveRequest.episodeIds[0] = 'missing-mutated-target'; const packedArchive = await packedArchivePromise\n` +
      `const packedChangesRequest = { access: { allowedScopes: [] }, limit: 100 }; const packedChangesPromise = signalSnapshotMemory.changes(packedChangesRequest); packedChangesRequest.limit = 1; const packedChanges = await packedChangesPromise\n` +
      `const packedSignalChangesRequest = { access: { allowedScopes: [] }, limit: 100 }; const packedSignalChangesPromise = signalSnapshotMemory.signalChanges(packedSignalChangesRequest); packedSignalChangesRequest.limit = 1; const packedSignalChanges = await packedSignalChangesPromise\n` +
      `const packedUnknownReadRejected = await signalSnapshotMemory.analyze({ access: { allowedScopes: [] }, unexpected: true }).then(() => false, (error) => error?.code === 'invalid_input')\n` +
      `if (packedPoint.value?.id !== 'packed-signal-snapshot-target' || packedRecall.episodes[0]?.episodeId !== 'packed-signal-snapshot-target' || !packedSearch.context.entities.some((entity) => entity.id === 'packed-signal-snapshot-entity') || packedNeighborhood.center.id !== 'packed-signal-snapshot-entity' || packedBrowse.items[0]?.id !== 'packed-signal-snapshot-target' || packedGraph.episodes[0]?.id !== 'packed-signal-snapshot-target' || packedAnalysis.overview.episodes !== 1 || !packedAnalysis.algorithms.personalized || packedArchive.canonical.episodes[0]?.id !== 'packed-signal-snapshot-target' || !JSON.stringify(packedChanges.changes).includes('packed-signal-snapshot-target') || !JSON.stringify(packedSignalChanges.changes).includes('packed-signal-snapshot-target') || !packedUnknownReadRejected) throw new Error('packed core read request snapshot failed')\n` +
      `const facadeLiveSignal = new AbortController().signal; let facadeManagementReads = 0; const facadeManagementOptions = { signal: facadeLiveSignal }; Object.defineProperty(facadeManagementOptions, 'scanLimits', { enumerable: true, get: () => { facadeManagementReads += 1; return facadeManagementReads === 1 ? { maxRecords: 10000, maxBytes: 16777216 } : { maxRecords: 0, maxBytes: 0 } } }); const facadeStatsPromise = signalSnapshotMemory.stats(facadeManagementOptions); facadeManagementOptions.signal = AbortSignal.abort(); const facadeStats = await facadeStatsPromise\n` +
      `const facadePointOptions = { signal: facadeLiveSignal }; const facadePointPromise = signalSnapshotMemory.getEpisode('packed-signal-snapshot-target', { allowedScopes: [] }, facadePointOptions); facadePointOptions.signal = AbortSignal.abort(); const facadePoint = await facadePointPromise\n` +
      `const facadeOutputOperation = await signalSnapshotMemory.operation('packed-node-output-operation')\n` +
      `const facadeBaseline = await signalSnapshotMemory.snapshot({ access: { allowedScopes: [] } }); const facadeRegistrationOptions = { signal: facadeLiveSignal }; const facadeRegistrationPromise = signalSnapshotMemory.registerJournalConsumer({ id: 'packed-node-facade-consumer', journal: 'semantic', cursor: facadeBaseline.changesCursor }, facadeRegistrationOptions); facadeRegistrationOptions.signal = AbortSignal.abort(); const facadeConsumer = await facadeRegistrationPromise; const facadeRetirementOptions = { signal: facadeLiveSignal }; const facadeRetirementPromise = signalSnapshotMemory.retireJournalConsumer({ id: facadeConsumer.id, journal: 'semantic' }, facadeRetirementOptions); facadeRetirementOptions.signal = AbortSignal.abort(); const facadeRetirement = await facadeRetirementPromise\n` +
      `let facadeIntegrityReads = 0; const facadeIntegrityOptions = { signal: facadeLiveSignal }; Object.defineProperty(facadeIntegrityOptions, 'limits', { enumerable: true, get: () => { facadeIntegrityReads += 1; return facadeIntegrityReads === 1 ? { maxRecords: 10000, maxBytes: 16777216, maxGraphNodes: 10000, maxGraphEdges: 10000, maxIssues: 100 } : { maxRecords: 0 } } }); const facadeIntegrityPromise = signalSnapshotMemory.verifyIntegrity(facadeIntegrityOptions); facadeIntegrityOptions.signal = AbortSignal.abort(); const facadeIntegrity = await facadeIntegrityPromise\n` +
      `if (!facadeOpenInputSnapshotted || facadeManagementReads !== 1 || facadeStats.episodes !== 1 || facadePoint?.id !== 'packed-signal-snapshot-target' || facadeConsumer.state !== 'active' || facadeRetirement.state !== 'retired' || facadeIntegrityReads !== 1 || !facadeIntegrity.ok) throw new Error('packed facade option snapshot failed')\n` +
      `if (facadeReopenedSpace.metadata?.owner !== 'packed-node-original' || facadeReopenedSpace.metadata?.nested?.state !== 'ready' || !facadeListenerIsolated || facadePoint?.content?.type !== 'text' || facadePoint.content.text !== 'Packed request snapshot target.' || facadePoint.source.metadata?.owner !== 'original' || facadeOutputOperation?.state !== facadeListenerState || JSON.stringify(facadeOutputOperation.warnings) !== JSON.stringify(facadeListenerWarnings) || facadeOutputOperation.warnings.includes('returned-report-mutation')) throw new Error('packed public output detachment failed')\n` +
      `await signalSnapshotMemory.close()\n` +
      `let contextProviderCalls = 0\n` +
      `let contextSensitivities = ''\n` +
      `const contextMemory = createMemory({ spaceId: 'packed-context', storage: createInMemoryStorage(), inference: { lineage: { provider: 'packed-fixture', model: 'bounded-context-v1', destination: 'local' }, infer: async () => { contextProviderCalls += 1; return { entities: [], facts: [] } } }, policy: { authorizeDisclosure: (request) => { contextSensitivities = request.sensitivities.join(','); return { action: 'allow' } } }, ingestion: { contextLimit: 1 } })\n` +
      `await contextMemory.open({ create: true })\n` +
      `await contextMemory.remember({ id: 'packed-context-source', kind: 'assertion', content: { type: 'text', text: 'Packed bounded context source.' }, source: { kind: 'smoke' }, sensitivity: 'packed-secret', assertions: { entities: [{ id: 'packed-context-entity', name: 'Context entity' }] } })\n` +
      `const contextLimit = await contextMemory.remember({ id: 'packed-context-target', kind: 'text', content: { type: 'text', text: 'Bound packed context.' }, source: { kind: 'smoke' } }, { operationId: 'packed-context-limit', contextScanLimits: { maxRecords: 1, maxBytes: 1048576 } })\n` +
      `const contextRetry = await contextMemory.retryEpisode('packed-context-target', { operationId: 'packed-context-retry', contextScanLimits: { maxRecords: 100, maxBytes: 1048576 } })\n` +
      `if (contextLimit.operation.state !== 'failed' || contextLimit.operation.error?.code !== 'result_too_large' || contextLimit.contextScan.records !== 1 || contextProviderCalls !== 1 || contextSensitivities !== 'packed-secret' || contextRetry.operation.state !== 'succeeded' || contextRetry.contextScan.records <= 1 || contextRetry.contextScan.bytes < 1) throw new Error('packed bounded inference context failed')\n` +
      `await contextMemory.close()\n` +
      `let disclosureProviderCalls = 0\n` +
      `const disclosureMemory = createMemory({ spaceId: 'packed-disclosure', storage: createInMemoryStorage(), embeddings: { lineage: { provider: 'packed-fixture', model: 'bounded-disclosure-v1', destination: 'local', dimensions: 2 }, embed: async ({ texts }) => { disclosureProviderCalls += 1; return texts.map(() => [1, 0]) } }, disclosureLimits: { maxBytes: 1048576, maxTokens: 1, countTokens: () => 2 } })\n` +
      `await disclosureMemory.open({ create: true })\n` +
      `const disclosureRejected = await disclosureMemory.recall({ query: 'packed disclosure budget', access: { allowedScopes: [] }, channels: { exact: false, lexical: false, semantic: true, graph: false, temporal: false } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'provider_disclosure' && error?.details?.dimension === 'tokens' && error?.details?.measurement === 'provider_counter')\n` +
      `if (!disclosureRejected || disclosureProviderCalls !== 0) throw new Error('packed provider disclosure budget failed')\n` +
      `await disclosureMemory.close()\n` +
      `let latePolicyProviderCalls = 0\n` +
      `let releaseLatePolicy\n` +
      `const latePolicyMemory = createMemory({ spaceId: 'packed-policy-timeout', storage: createInMemoryStorage(), operationTimeoutMs: 20, inference: { lineage: { provider: 'packed-fixture', model: 'late-policy-v1', destination: 'remote' }, infer: async () => { latePolicyProviderCalls += 1; return { entities: [], facts: [] } } }, policy: { authorizeDisclosure: () => new Promise((resolve) => { releaseLatePolicy = resolve }) } })\n` +
      `await latePolicyMemory.open({ create: true })\n` +
      `const latePolicyReport = await latePolicyMemory.remember({ id: 'packed-policy-timeout', kind: 'text', content: { type: 'text', text: 'Detach late policy work.' }, source: { kind: 'smoke' } })\n` +
      `releaseLatePolicy?.({ action: 'allow' })\n` +
      `await Promise.resolve()\n` +
      `if (latePolicyReport.operation.error?.code !== 'timeout' || latePolicyReport.operation.retryable !== true || latePolicyReport.privacy.calls[0]?.outcome !== 'failed' || latePolicyProviderCalls !== 0) throw new Error('packed disclosure policy deadline failed')\n` +
      `await latePolicyMemory.close()\n` +
      `const resetMemory = createMemory({ spaceId: 'packed-reset', storage: createInMemoryStorage() })\n` +
      `await resetMemory.open({ create: true })\n` +
      `await resetMemory.remember({ id: 'packed-reset-episode', kind: 'assertion', content: { type: 'text', text: 'Bound packed reset.' }, source: { kind: 'smoke' }, assertions: { entities: [{ id: 'packed-reset-entity', name: 'Reset entity' }] } })\n` +
      `const resetRevision = (await resetMemory.stats()).snapshotRevision\n` +
      `const resetIdentityRejected = await resetMemory.resetSpace({ confirmSpaceId: 'packed-reset' }, { operationId: 'packed-reset-ignored' }).then(() => false, (error) => error?.code === 'invalid_input')\n` +
      `const resetRejected = await resetMemory.resetSpace({ confirmSpaceId: 'packed-reset', scanLimits: { maxRecords: 1, maxBytes: 1048576 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'reset_scan' && error?.details?.dimension === 'records' && error?.details?.required > 1 && error?.details?.maximum === 1)\n` +
      `const resetAtomic = (await resetMemory.stats()).snapshotRevision === resetRevision\n` +
      `const resetSnapshotRequest = { confirmSpaceId: 'packed-reset', scanLimits: { maxRecords: 100, maxBytes: 1048576 } }; const resetSnapshotPromise = resetMemory.resetSpace(resetSnapshotRequest); resetSnapshotRequest.confirmSpaceId = 'mutated-packed-reset'; resetSnapshotRequest.scanLimits.maxRecords = 0; const resetReport = await resetSnapshotPromise\n` +
      `if (!resetIdentityRejected || !resetRejected || !resetAtomic || !resetReport.purged || resetReport.scan.records <= 1 || resetReport.scan.bytes < 1) throw new Error('packed bounded reset or request snapshot failed')\n` +
      `const ingestionSnapshotRequest = { id: 'episode', kind: 'assertion', content: { type: 'text', text: 'Packed artifact works.' }, source: { kind: 'smoke' }, assertions: { entities: [{ id: 'artifact', name: 'Packed artifact' }], facts: [{ id: 'packed-source-fact', subject: { id: 'artifact' }, predicate: 'works', object: { scalar: true } }] } }; const ingestionSnapshotOptions = { operationId: 'packed-ingest-operation', workLimits: { maxRecords: 10000 } }; const ingestionSnapshotPromise = memory.remember(ingestionSnapshotRequest, ingestionSnapshotOptions); ingestionSnapshotRequest.id = 'mutated-packed-episode'; ingestionSnapshotRequest.content.text = 'Mutated packed input.'; ingestionSnapshotRequest.assertions.entities[0].id = 'mutated-packed-artifact'; ingestionSnapshotOptions.operationId = 'mutated-packed-ingest'; ingestionSnapshotOptions.workLimits.maxRecords = 0; const ingestion = await ingestionSnapshotPromise\n` +
      `if (ingestion.episode.id !== 'episode' || ingestion.operation.id !== 'packed-ingest-operation' || await memory.getEntity('artifact', { allowedScopes: [] }) === null) throw new Error('packed ingestion request snapshot failed')\n` +
      `const ingestionLimit = await memory.reprocessEpisode('episode', { operationId: 'packed-ingestion-limit', workLimits: { maxRecords: 1 } })\n` +
      `if (ingestion.work.records < 1 || ingestion.work.bytes < 1 || ingestionLimit.operation.state !== 'failed' || ingestionLimit.operation.error?.code !== 'result_too_large' || ingestionLimit.work.records !== 1 || ingestionLimit.work.limits.maxRecords !== 1) throw new Error('packed bounded ingestion failed')\n` +
      `const ingestionProjectionLimit = await memory.reprocessEpisode('episode', { operationId: 'packed-ingestion-projection-limit', projectionScanLimits: { maxRecords: 1, maxBytes: 1048576 } })\n` +
      `if (ingestion.projectionScan.records <= 1 || ingestion.projectionScan.bytes < 1 || ingestionProjectionLimit.operation.state !== 'partial' || ingestionProjectionLimit.operation.stage !== 'projection_scan_failed' || ingestionProjectionLimit.operation.error?.code !== 'result_too_large' || ingestionProjectionLimit.projectionScan.records !== 1 || ingestionProjectionLimit.projectionScan.limits.maxRecords !== 1) throw new Error('packed bounded automatic projection failed')\n` +
      `const operationReuseBlocked = await memory.remember({ id: 'operation-rebind-attempt', kind: 'assertion', content: { type: 'text', text: 'Operation identity must be create-once.' }, source: { kind: 'smoke' }, assertions: { entities: [] } }, { operationId: 'packed-ingest-operation' }).then(() => false, (error) => error?.code === 'idempotency_conflict')\n` +
      `const unboundEpisodeReplayBlocked = await memory.remember({ id: 'episode', kind: 'assertion', content: { type: 'text', text: 'Packed artifact works.' }, source: { kind: 'smoke' }, assertions: { entities: [{ id: 'artifact', name: 'Packed artifact' }], facts: [{ id: 'packed-source-fact', subject: { id: 'artifact' }, predicate: 'works', object: { scalar: true } }] } }, { operationId: 'packed-unbound-replay-operation' }).then(() => false, (error) => error?.code === 'idempotency_conflict' && error?.operationId === 'packed-unbound-replay-operation')\n` +
      `const publicOperation = await memory.operation('packed-ingest-operation')\n` +
      `if (!operationReuseBlocked || !unboundEpisodeReplayBlocked || await memory.getEpisode('operation-rebind-attempt', { allowedScopes: [] }) !== null || await memory.operation('packed-unbound-replay-operation') !== null || publicOperation?.episodeId !== 'episode' || publicOperation.diagnosticsTruncated !== false || 'bindingId' in publicOperation) throw new Error('packed operation identity sealing failed')\n` +
      `const pointReadRejected = await memory.read({ kind: 'entity', id: 'artifact', access: { allowedScopes: [] }, scanLimits: { maxRecords: 1, maxBytes: 1048576 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'point_read_scan' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `const pointRead = await memory.read({ kind: 'entity', id: 'artifact', access: { allowedScopes: [] }, scanLimits: { maxRecords: 100, maxBytes: 1048576 } })\n` +
      `if (!pointReadRejected || pointRead.value?.id !== 'artifact' || pointRead.scan.records <= 1 || pointRead.scan.bytes < 1) throw new Error('packed bounded point read failed')\n` +
      `const result = await memory.recall({ query: 'artifact', access: { allowedScopes: [] } })\n` +
      `const recallScanRejected = await memory.recall({ anchors: { entityIds: ['artifact'] }, access: { allowedScopes: [] }, channels: { exact: true, lexical: false, semantic: false, graph: true, temporal: false }, scanLimits: { maxRecords: 1, maxBytes: 1048576 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'recall_scan' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `const entityPage = await memory.browse({ kind: 'entity', access: { allowedScopes: [] }, order: 'id', limit: 1, scanLimits: { maxRecords: 100, maxBytes: 1048576 } })\n` +
      `const browseScanRejected = await memory.browse({ kind: 'entity', access: { allowedScopes: [] }, order: 'id', limit: 1, scanLimits: { maxRecords: 1, maxBytes: 1048576 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'browse_scan' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `const neighborhood = await memory.neighborhood({ entityId: 'artifact', access: { allowedScopes: [] }, depth: 2, scanLimits: { maxRecords: 100, maxBytes: 1048576 } })\n` +
      `if (!result.entities.some((entity) => entity.id === 'artifact') || !Number.isInteger(result.snapshotRevision) || typeof result.generatedAt !== 'string' || result.scan.records < 1 || result.scan.records > result.scan.limits.maxRecords || result.scan.bytes < 1 || result.scan.bytes > result.scan.limits.maxBytes || entityPage.items[0]?.id !== 'artifact' || entityPage.scan.records < 1 || entityPage.scan.bytes < 1 || neighborhood.center.id !== 'artifact' || neighborhood.scan.records < 1 || neighborhood.scan.bytes < 1 || !recallScanRejected || !browseScanRejected) throw new Error('packed bounded recall, browse, neighborhood, or lineage failed')\n` +
      `const derivationWrite = await memory.deriveFact({ conclusion: { id: 'packed-derived-fact', subjectId: 'artifact', predicate: 'verified', object: { kind: 'scalar', value: true } }, rule: { id: 'packed/source-implies-verified', version: '1' }, premises: [{ kind: 'fact', id: 'packed-source-fact' }], access: { allowedScopes: [] }, expectedRevision: result.snapshotRevision, workLimits: { maxRecords: 32 } })\n` +
      `const derivedFact = await memory.getFact('packed-derived-fact', { allowedScopes: [] })\n` +
      `const persistedDerivation = await memory.getDerivation(derivationWrite.derivation.id, { allowedScopes: [] })\n` +
      `if (derivationWrite.outcome !== 'created' || derivationWrite.work.records < 1 || derivationWrite.work.records > 32 || derivationWrite.work.graphNodes !== 2 || derivationWrite.work.graphEdges !== 1 || derivedFact?.derivations[0]?.id !== derivationWrite.derivation.id || persistedDerivation?.state !== 'active') throw new Error('packed bounded derivation API failed')\n` +
      `const derivationBatchRevision = (await memory.stats()).snapshotRevision\n` +
      `const derivationBatchInput = { derivations: [{ conclusion: { id: 'packed-derived-batch-one', subjectId: 'artifact', predicate: 'verified-batch-one', object: { kind: 'scalar', value: true } }, rule: { id: 'packed/source-implies-batch', version: '1' }, premises: [{ kind: 'fact', id: 'packed-source-fact' }] }, { conclusion: { id: 'packed-derived-batch-two', subjectId: 'artifact', predicate: 'verified-batch-two', object: { kind: 'scalar', value: true } }, rule: { id: 'packed/source-implies-batch', version: '1' }, premises: [{ kind: 'fact', id: 'packed-source-fact' }] }], access: { allowedScopes: [] }, expectedRevision: derivationBatchRevision, workLimits: { maxRecords: 64 } }\n` +
      `const derivationBatch = await memory.deriveFacts(derivationBatchInput, { operationId: 'packed-derive-batch' })\n` +
      `const derivationBatchReplay = await memory.deriveFacts(derivationBatchInput, { operationId: 'packed-derive-batch' })\n` +
      `if (derivationBatch.results.map((item) => item.conclusion.id).join(',') !== 'packed-derived-batch-one,packed-derived-batch-two' || derivationBatch.results.some((item) => item.outcome !== 'created' || item.derivation.operationId !== 'packed-derive-batch' || item.derivation.recordedRevision !== derivationBatchRevision + 1) || derivationBatchReplay.results[1]?.derivation.id !== derivationBatch.results[1]?.derivation.id) throw new Error('packed bounded derivation batch API failed')\n` +
      `const derivationWithdrawalBatchPreview = await memory.previewDerivationWithdrawals({ where: { ruleIds: ['packed/source-implies-batch'], ruleVersions: ['1'] }, access: { allowedScopes: [] }, maxMatches: 2, workLimits: { maxRecords: 64 } })\n` +
      `const derivationWithdrawalBatchRevision = derivationWithdrawalBatchPreview.snapshotRevision\n` +
      `const derivationWithdrawalBatchInput = { where: { ruleIds: ['packed/source-implies-batch'], ruleVersions: ['1'] }, access: { allowedScopes: [] }, expectedRevision: derivationWithdrawalBatchRevision, maxMatches: 2, selectionCursor: derivationWithdrawalBatchPreview.selectionCursor, reason: 'Packed rule-set retirement.', workLimits: { maxRecords: 64 } }\n` +
      `const derivationWithdrawalBatch = await memory.withdrawDerivations(derivationWithdrawalBatchInput, { operationId: 'packed-withdraw-derivation-batch' })\n` +
      `const derivationWithdrawalBatchReplay = await memory.withdrawDerivations(derivationWithdrawalBatchInput, { operationId: 'packed-withdraw-derivation-batch' })\n` +
      `if (derivationWithdrawalBatchPreview.derivations.length !== 2 || typeof derivationWithdrawalBatchPreview.selectionCursor !== 'string' || (await memory.stats()).snapshotRevision !== derivationWithdrawalBatchRevision + 1 || derivationWithdrawalBatch.withdrawals.length !== 2 || derivationWithdrawalBatch.withdrawals.map((item) => item.conclusionFactId).sort().join(',') !== 'packed-derived-batch-one,packed-derived-batch-two' || derivationWithdrawalBatch.unsupportedFacts.join(',') !== 'packed-derived-batch-one,packed-derived-batch-two' || derivationWithdrawalBatchReplay.withdrawals.map((item) => item.withdrawalId).join(',') !== derivationWithdrawalBatch.withdrawals.map((item) => item.withdrawalId).join(',') || await memory.getFact('packed-derived-batch-one', { allowedScopes: [] }) !== null || await memory.getFact('packed-derived-batch-two', { allowedScopes: [] }) !== null) throw new Error('packed bounded derivation withdrawal batch API failed')\n` +
      `await memory.remember({ id: 'packed-governance-source', kind: 'assertion', content: { type: 'text', text: 'Packed bounded correction and retraction work.' }, source: { kind: 'smoke' }, assertions: { entities: [{ id: 'artifact', name: 'Packed artifact' }], facts: [{ id: 'packed-correction-fact', subject: { id: 'artifact' }, predicate: 'correction-probe', object: { scalar: true } }, { id: 'packed-retraction-fact', subject: { id: 'artifact' }, predicate: 'retraction-probe', object: { scalar: true } }] } })\n` +
      `const correctionRevision = (await memory.stats()).snapshotRevision\n` +
      `const correctionRejected = await memory.correctFact({ factId: 'packed-correction-fact', replacement: { id: 'packed-correction-replacement', subject: { id: 'artifact' }, predicate: 'correction-probe', object: { scalar: false } }, access: { allowedScopes: [] }, workLimits: { maxRecords: 1 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'derivation' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `const correctionAtomic = (await memory.stats()).snapshotRevision === correctionRevision\n` +
      `const correctionSnapshotRequest = { factId: 'packed-correction-fact', replacement: { id: 'packed-correction-replacement', subject: { id: 'artifact' }, predicate: 'correction-probe', object: { scalar: false } }, access: { allowedScopes: [] }, workLimits: { maxRecords: 64 } }; const correctionSnapshotOptions = { operationId: 'packed-correction-snapshot' }; const correctionSnapshotPromise = memory.correctFact(correctionSnapshotRequest, correctionSnapshotOptions); correctionSnapshotRequest.factId = 'mutated-packed-correction'; correctionSnapshotRequest.replacement.id = 'mutated-packed-replacement'; correctionSnapshotRequest.replacement.object.scalar = true; correctionSnapshotRequest.access.allowedScopes.push('private'); correctionSnapshotRequest.workLimits.maxRecords = 0; correctionSnapshotOptions.operationId = 'mutated-packed-correction-operation'; const correction = await correctionSnapshotPromise\n` +
      `if (!correctionRejected || !correctionAtomic || correction.operation.id !== 'packed-correction-snapshot' || !correction.affectedFacts.includes('packed-correction-replacement') || correction.work.records < 1 || correction.work.records > 64 || correction.work.bytes < 1 || (await memory.getFact('packed-correction-fact', { allowedScopes: [] }))?.status !== 'superseded' || (await memory.getFact('packed-correction-replacement', { allowedScopes: [] }))?.status !== 'active') throw new Error('packed bounded correction or request snapshot API failed')\n` +
      `const retractionRevision = (await memory.stats()).snapshotRevision\n` +
      `const retractionRejected = await memory.retractFact({ factId: 'packed-retraction-fact', allSupport: true, access: { allowedScopes: [] }, workLimits: { maxRecords: 1 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'derivation' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `const retractionAtomic = (await memory.stats()).snapshotRevision === retractionRevision\n` +
      `const retraction = await memory.retractFact({ factId: 'packed-retraction-fact', allSupport: true, access: { allowedScopes: [] }, workLimits: { maxRecords: 32 } })\n` +
      `if (!retractionRejected || !retractionAtomic || retraction.work.records < 1 || retraction.work.records > 32 || retraction.work.bytes < 1 || await memory.getFact('packed-retraction-fact', { allowedScopes: [] }) !== null) throw new Error('packed bounded retraction API failed')\n` +
      `await memory.remember({ id: 'packed-deletion-source', kind: 'assertion', content: { type: 'text', text: 'Packed bounded episode deletion works.' }, source: { kind: 'smoke' }, assertions: { entities: [{ id: 'artifact', name: 'Packed artifact' }], facts: [{ id: 'packed-deletion-fact', subject: { id: 'artifact' }, predicate: 'deletion-probe', object: { scalar: true } }] } })\n` +
      `const deletionRevision = (await memory.stats()).snapshotRevision\n` +
      `const deletionRejected = await memory.deleteEpisode({ episodeId: 'packed-deletion-source', access: { allowedScopes: [] }, workLimits: { maxRecords: 1 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'derivation' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `const deletionAtomic = (await memory.stats()).snapshotRevision === deletionRevision\n` +
      `const deletion = await memory.deleteEpisode({ episodeId: 'packed-deletion-source', access: { allowedScopes: [] }, workLimits: { maxRecords: 64 } })\n` +
      `if (!deletionRejected || !deletionAtomic || deletion.work.records < 1 || deletion.work.records > 64 || deletion.work.bytes < 1 || await memory.getEpisode('packed-deletion-source', { allowedScopes: [] }) !== null || await memory.getFact('packed-deletion-fact', { allowedScopes: [] }) !== null) throw new Error('packed bounded episode deletion API failed')\n` +
      `await memory.remember({ id: 'packed-preview-delete', kind: 'event', content: { type: 'event', name: 'temporary-preview', value: true }, source: { kind: 'packed-preview-delete' }, tags: ['preview-delete'] })\n` +
      `const episodeDeletionPreview = await memory.previewEpisodeDeletions({ where: { source: { kinds: ['packed-preview-delete'] }, tags: { all: ['preview-delete'] } }, access: { allowedScopes: [] }, maxMatches: 1, workLimits: { maxRecords: 16 } })\n` +
      `const episodeDeletionBatch = await memory.deleteEpisodes({ where: { source: { kinds: ['packed-preview-delete'] }, tags: { all: ['preview-delete'] } }, access: { allowedScopes: [] }, expectedRevision: episodeDeletionPreview.snapshotRevision, maxMatches: 1, selectionCursor: episodeDeletionPreview.selectionCursor, workLimits: { maxRecords: 64 } }, { operationId: 'packed-preview-delete-batch' })\n` +
      `if (episodeDeletionPreview.episodes[0]?.id !== 'packed-preview-delete' || typeof episodeDeletionPreview.selectionCursor !== 'string' || episodeDeletionPreview.work.records !== 1 || episodeDeletionBatch.affectedEpisodes.join(',') !== 'packed-preview-delete' || await memory.getEpisode('packed-preview-delete', { allowedScopes: [] }) !== null) throw new Error('packed bounded episode deletion preview API failed')\n` +
      `await memory.remember({ id: 'packed-merge-source', kind: 'assertion', content: { type: 'text', text: 'Packed bounded merge and split work.' }, source: { kind: 'smoke' }, assertions: { entities: [{ id: 'packed-merge-target', name: 'Merge target' }, { id: 'packed-merge-redirect', name: 'Merge redirect' }] } })\n` +
      `const entityMergeRevision = (await memory.stats()).snapshotRevision\n` +
      `const entityMergeRejected = await memory.mergeEntities({ targetId: 'packed-merge-target', sourceIds: ['packed-merge-redirect'], access: { allowedScopes: [] }, workLimits: { maxRecords: 1 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'derivation' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `const entityMergeAtomic = (await memory.stats()).snapshotRevision === entityMergeRevision\n` +
      `const entityMerge = await memory.mergeEntities({ targetId: 'packed-merge-target', sourceIds: ['packed-merge-redirect'], access: { allowedScopes: [] }, workLimits: { maxRecords: 64 } })\n` +
      `const entityMergeId = entityMerge.operation.id.replace(/^op_/, 'merge_')\n` +
      `const entitySplitRevision = (await memory.stats()).snapshotRevision\n` +
      `const entitySplitRejected = await memory.splitEntityMerge({ mergeId: entityMergeId, access: { allowedScopes: [] }, workLimits: { maxRecords: 1 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'derivation' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `const entitySplitAtomic = (await memory.stats()).snapshotRevision === entitySplitRevision\n` +
      `const entitySplit = await memory.splitEntityMerge({ mergeId: entityMergeId, access: { allowedScopes: [] }, workLimits: { maxRecords: 64 } })\n` +
      `if (!entityMergeRejected || !entityMergeAtomic || !entitySplitRejected || !entitySplitAtomic || entityMerge.work.records < 1 || entityMerge.work.records > 64 || entityMerge.work.bytes < 1 || entitySplit.work.records < 1 || entitySplit.work.records > 64 || entitySplit.work.bytes < 1 || (await memory.getEntity('packed-merge-redirect', { allowedScopes: [] }))?.mergedInto !== undefined) throw new Error('packed bounded entity merge API failed')\n` +
      `const baseline = await memory.snapshot({ access: { allowedScopes: [] } })\n` +
      `await memory.remember({ id: 'packed-purge-candidate', kind: 'event', content: { type: 'event', name: 'temporary', value: true }, source: { kind: 'smoke' } }, { operationId: 'packed-purge-operation' })\n` +
      `await memory.remember({ id: 'packed-delete-candidate', kind: 'event', content: { type: 'event', name: 'temporary', value: true }, source: { kind: 'smoke' } })\n` +
      `const signalBaseline = await memory.browseSignals({ access: { allowedScopes: [] } })\n` +
      `const signalBasisRejected = await memory.putSignals({ access: { allowedScopes: [] }, expectedRevision: signalBaseline.snapshotRevision, basisScanLimits: { maxRecords: 1, maxBytes: 1048576 }, signals: [{ namespace: 'packed.basis-limit', target: { kind: 'episode', id: 'episode' }, producer: { kind: 'algorithm', id: 'packed-fixture', version: '1' }, scopes: [], basis: { episodeIds: ['episode'] }, value: true }] }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'signal_basis_scan' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `const signalBasisAtomic = (await memory.stats()).snapshotRevision === signalBaseline.snapshotRevision\n` +
      `const signalWrite = await memory.putSignals({ access: { allowedScopes: [] }, expectedRevision: signalBaseline.snapshotRevision, basisScanLimits: { maxRecords: 1000, maxBytes: 1048576 }, signals: [{ namespace: 'packed.signal', target: { kind: 'entity', id: 'artifact' }, producer: { kind: 'algorithm', id: 'packed-fixture', version: '1' }, scopes: [], basis: { episodeIds: ['episode'] }, value: { salience: 0.9 } }, { namespace: 'packed.purge', target: { kind: 'episode', id: 'packed-purge-candidate' }, producer: { kind: 'algorithm', id: 'packed-fixture', version: '1' }, scopes: [], basis: { episodeIds: ['packed-purge-candidate'] }, value: { recommendation: 'forget' } }, { namespace: 'packed.delete', target: { kind: 'episode', id: 'packed-delete-candidate' }, producer: { kind: 'algorithm', id: 'packed-fixture', version: '1' }, scopes: [], basis: { episodeIds: ['packed-delete-candidate'] }, value: { recommendation: 'forget' } }] })\n` +
      `if (!signalBasisRejected || !signalBasisAtomic || signalWrite.basisScan.records <= 1 || signalWrite.basisScan.bytes < 1) throw new Error('packed bounded signal basis failed')\n` +
      `const deleteWhere = { namespaces: ['packed.delete'] }\n` +
      `const deletePreview = await memory.browseSignals({ access: { allowedScopes: [] }, where: deleteWhere })\n` +
      `const deleteSemanticBaseline = await memory.snapshot({ access: { allowedScopes: [] } })\n` +
      `if (typeof deletePreview.targetSelectionCursor !== 'string') throw new Error('packed signal target delete preview failed')\n` +
      `const signalDeleteRevision = (await memory.stats()).snapshotRevision\n` +
      `const signalDeleteRejected = await memory.deleteEpisodes({ access: { allowedScopes: [] }, signalTargets: { where: deleteWhere, selectionCursor: deletePreview.targetSelectionCursor }, maxMatches: 1, workLimits: { maxRecords: 1 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'derivation' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `const signalDeleteAtomic = (await memory.stats()).snapshotRevision === signalDeleteRevision\n` +
      `const signalDelete = await memory.deleteEpisodes({ access: { allowedScopes: [] }, signalTargets: { where: deleteWhere, selectionCursor: deletePreview.targetSelectionCursor }, maxMatches: 1, workLimits: { maxRecords: 64 } })\n` +
      `const deleteSemanticDelta = await memory.changes({ access: { allowedScopes: [] }, cursor: deleteSemanticBaseline.changesCursor })\n` +
      `const deleteSignalDelta = await memory.signalChanges({ access: { allowedScopes: [] }, cursor: deletePreview.signalChangesCursor })\n` +
      `if (!signalDeleteRejected || !signalDeleteAtomic || signalDelete.work.records < 1 || signalDelete.work.records > 64 || signalDelete.work.bytes < 1 || await memory.getEpisode('packed-delete-candidate', { allowedScopes: [] }) !== null || (await memory.browseSignals({ access: { allowedScopes: [] }, where: deleteWhere })).total !== 0 || deleteSemanticDelta.changes.length !== 1 || deleteSemanticDelta.changes[0]?.phase !== 'governance' || deleteSignalDelta.changes.length !== 1 || deleteSignalDelta.changes[0]?.action !== 'withdraw' || deleteSignalDelta.changes[0]?.revision !== deleteSemanticDelta.changes[0]?.revision) throw new Error('packed bounded signal target soft delete failed')\n` +
      `const purgeWhere = { namespaces: ['packed.purge'] }\n` +
      `const purgePreview = await memory.browseSignals({ access: { allowedScopes: [] }, where: purgeWhere })\n` +
      `if (typeof purgePreview.targetSelectionCursor !== 'string') throw new Error('packed signal target preview failed')\n` +
      `const signalTargetPurge = await memory.hardPurge({ access: { allowedScopes: [] }, signalTargets: { where: purgeWhere, selectionCursor: purgePreview.targetSelectionCursor }, maxMatches: 1, workLimits: { maxRecords: 500, maxBytes: 2097152, maxGraphNodes: 500, maxGraphEdges: 500 } })\n` +
      `if (!signalTargetPurge.affectedEpisodes.includes('packed-purge-candidate') || signalTargetPurge.work.records < 1 || signalTargetPurge.work.records > 500 || signalTargetPurge.work.bytes < 1 || await memory.getEpisode('packed-purge-candidate', { allowedScopes: [] }) !== null) throw new Error('packed bounded signal target purge failed')\n` +
      `const purgedOperation = await memory.operation('packed-purge-operation')\n` +
      `if (purgedOperation?.diagnosticsState !== 'purged' || purgedOperation.diagnosticsTruncated !== false || purgedOperation.episodeId !== undefined || purgedOperation.warnings.length !== 0 || purgedOperation.remoteCalls.length !== 0) throw new Error('packed purge operation diagnostics failed')\n` +
      `const signalPage = await memory.browseSignals({ access: { allowedScopes: [] }, where: { namespaces: ['packed.signal'] } })\n` +
      `const signalChanges = await memory.signalChanges({ access: { allowedScopes: [] }, cursor: signalBaseline.signalChangesCursor })\n` +
      `if (signalWrite.signals[0]?.version !== 1 || signalPage.total !== 1 || signalPage.byteLength < 1 || signalPage.signals[0]?.namespace !== 'packed.signal' || signalChanges.changes.map((change) => change.action).join(',') !== 'put,withdraw,purge') throw new Error('packed signal API or journal failed')\n` +
      `await memory.remember({ id: 'episode-after-snapshot', kind: 'assertion', content: { type: 'text', text: 'Packed cursor handoff works.' }, source: { kind: 'smoke' }, assertions: { entities: [{ id: 'cursor-handoff', name: 'Cursor handoff' }] } })\n` +
      `const changes = await memory.changes({ access: { allowedScopes: [] }, cursor: baseline.changesCursor })\n` +
      `if (!changes.changes.some((change) => change.phase === 'accepted') || !changes.changes.some((change) => change.phase === 'canonical')) throw new Error('packed changes failed')\n` +
      `if (changes.changes.some((change) => change.revision <= baseline.snapshotRevision)) throw new Error('packed snapshot cursor replayed baseline history')\n` +
      `const signalCompactionBaseline = await memory.browseSignals({ access: { allowedScopes: [] } })\n` +
      `await memory.registerJournalConsumer({ id: 'packed-signal-consumer', journal: 'signal', cursor: signalCompactionBaseline.signalChangesCursor })\n` +
      `const signalCompaction = await memory.compactSignalChanges({ confirmSpaceId: 'packed-smoke', registeredConsumers: true, expectedRevision: signalCompactionBaseline.snapshotRevision, maxChanges: 1000 })\n` +
      `const compactionBaseline = await memory.snapshot({ access: { allowedScopes: [] } })\n` +
      `await memory.registerJournalConsumer({ id: 'packed-semantic-consumer', journal: 'semantic', cursor: compactionBaseline.changesCursor })\n` +
      `const compaction = await memory.compactChanges({ confirmSpaceId: 'packed-smoke', registeredConsumers: true, expectedRevision: compactionBaseline.snapshotRevision, maxChanges: 1000 })\n` +
      `const journalConsumers = [...(await memory.journalConsumers({ journal: 'semantic' })).consumers, ...(await memory.journalConsumers({ journal: 'signal' })).consumers]\n` +
      `const compactedStats = await memory.stats()\n` +
      `const boundedStats = await memory.stats({ scanLimits: { maxRecords: compactedStats.scan.records, maxBytes: compactedStats.scan.bytes } })\n` +
      `const statsScanRejected = await memory.stats({ scanLimits: { maxRecords: compactedStats.scan.records - 1, maxBytes: compactedStats.scan.bytes } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'stats_scan' && error?.details?.dimension === 'records' && error?.details?.required === compactedStats.scan.records && error?.details?.maximum === compactedStats.scan.records - 1)\n` +
      `const inspection = await memory.inspect()\n` +
      `const boundedInspection = await memory.inspect({ scanLimits: { maxRecords: inspection.scan.records, maxBytes: inspection.scan.bytes } })\n` +
      `const inspectionScanRejected = await memory.inspect({ scanLimits: { maxRecords: inspection.scan.records - 1, maxBytes: inspection.scan.bytes } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'inspection_scan' && error?.details?.dimension === 'records' && error?.details?.required === inspection.scan.records && error?.details?.maximum === inspection.scan.records - 1)\n` +
      `if (compactedStats.scan.records <= 1 || compactedStats.scan.bytes < 1 || boundedStats.scan.records !== compactedStats.scan.records || boundedStats.scan.bytes !== compactedStats.scan.bytes || !statsScanRejected || inspection.scan.records <= 1 || inspection.scan.bytes < 1 || boundedInspection.scan.records !== inspection.scan.records || boundedInspection.scan.bytes !== inspection.scan.bytes || !inspectionScanRejected) throw new Error('packed bounded management scans failed')\n` +
      `const afterCompaction = await memory.changes({ access: { allowedScopes: [] }, cursor: compactionBaseline.changesCursor })\n` +
      `const afterSignalCompaction = await memory.signalChanges({ access: { allowedScopes: [] }, cursor: signalCompactionBaseline.signalChangesCursor })\n` +
      `if (signalCompaction.deletedChanges !== 3 || compactedStats.signalChanges !== 0 || compactedStats.signalChangesCompactedThrough !== signalCompactionBaseline.snapshotRevision || afterSignalCompaction.changes.length !== 0 || compaction.deletedChanges < 1 || compactedStats.changes !== 0 || compactedStats.changesCompactedThrough !== compactionBaseline.snapshotRevision || compactedStats.signals !== 1 || compactedStats.signalRevisions !== 3 || afterCompaction.changes.length !== 0 || journalConsumers.length !== 2 || journalConsumers.some((consumer) => consumer.state !== 'active')) throw new Error('packed semantic or signal change compaction failed')\n` +
      `const archive = await memory.export({ access: { allowedScopes: [] }, complete: true, scanLimits: { maxRecords: 1000, maxBytes: 1048576 }, limits: { maxRecords: 1000, maxBytes: 1048576 } })\n` +
      `const integrityRevision = compactedStats.snapshotRevision\n` +
      `const integrityRejected = await memory.verifyIntegrity({ limits: { maxRecords: 1, maxBytes: 1048576, maxGraphNodes: 100, maxGraphEdges: 100, maxIssues: 10 } }).then(() => false, (error) => error?.code === 'result_too_large' && error?.details?.phase === 'integrity' && error?.details?.dimension === 'records' && error?.details?.required === 2 && error?.details?.maximum === 1)\n` +
      `const integrity = await memory.verifyIntegrity({ limits: { maxRecords: 10000, maxBytes: 16777216, maxGraphNodes: 10000, maxGraphEdges: 10000, maxIssues: 100 } })\n` +
      `if (!integrityRejected || archive.formatVersion !== 4 || !archive.canonical.episodes.some((episode) => episode.assertions !== undefined) || (await memory.stats()).snapshotRevision !== integrityRevision || archive.snapshotRevision !== compactedStats.snapshotRevision || integrity.snapshotRevision !== archive.snapshotRevision || typeof archive.exportedAt !== 'string' || typeof compactedStats.generatedAt !== 'string' || !integrity.ok || integrity.issues.length !== 0 || integrity.work.records < 1 || integrity.work.records > integrity.work.limits.maxRecords || integrity.work.bytes < 1 || integrity.work.bytes > integrity.work.limits.maxBytes || integrity.work.graphNodes > integrity.work.limits.maxGraphNodes || integrity.work.graphEdges > integrity.work.limits.maxGraphEdges || integrity.work.issuesDetected !== 0 || integrity.work.issuesTruncated) throw new Error('packed bounded integrity, archive identity, or aggregate read lineage failed')\n` +
      `let checkpointAccessReads = 0; const checkpointAccess = {}; Object.defineProperty(checkpointAccess, 'allowedScopes', { enumerable: true, get: () => { checkpointAccessReads += 1; if (checkpointAccessReads > 1) throw new Error('packed checkpoint access read twice'); return [] } }); const checkpointRequest = { access: checkpointAccess, confirmSpaceId: 'packed-smoke', maxChunkBytes: 65536 }; const checkpointOptions = { operationId: 'packed-checkpoint' }; const checkpointPromise = memory.createSyncCheckpoint(checkpointRequest, checkpointOptions); const checkpointRequestCaptured = checkpointAccessReads === 1; checkpointRequest.confirmSpaceId = 'mutated-packed-space'; checkpointRequest.maxChunkBytes = 1; checkpointOptions.operationId = 'mutated-packed-checkpoint'; const checkpoint = await checkpointPromise\n` +
      `const syncReplica = createMemory({ spaceId: 'packed-smoke', storage: createInMemoryStorage() })\n` +
      `await syncReplica.open({ create: true })\n` +
      `let pullAccessReads = 0; const pullAccess = {}; Object.defineProperty(pullAccess, 'allowedScopes', { enumerable: true, get: () => { pullAccessReads += 1; if (pullAccessReads > 1) throw new Error('packed pull access read twice'); return [] } }); const pullRequest = { access: pullAccess, confirmSpaceId: 'packed-smoke', strategy: 'fast-forward-only', maxAncestry: 10000, receiveLimits: { maxBytes: 67108864, maxRecords: 10000, maxChunks: 1000 } }; const pullOptions = { operationId: 'packed-sync' }; const pullPromise = syncReplica.syncFrom(memory, pullRequest, pullOptions); const pullRequestCaptured = pullAccessReads === 1; pullRequest.confirmSpaceId = 'mutated-packed-space'; pullRequest.maxAncestry = 0; pullRequest.receiveLimits.maxRecords = 0; pullOptions.operationId = 'mutated-packed-sync'; const syncReport = await pullPromise\n` +
      `const syncUnknownFieldRejected = await memory.syncHistory({ access: { allowedScopes: [] }, unexpected: true }).then(() => false, (error) => error?.code === 'invalid_input'); const syncRequestSnapshotsOk = checkpointRequestCaptured && pullRequestCaptured && syncReport.operation?.id === 'packed-sync' && syncUnknownFieldRejected\n` +
      `if (!syncRequestSnapshotsOk || syncReport.state !== 'succeeded' || syncReport.diagnosticsTruncated !== false || syncReport.error !== undefined || syncReport.checkpoint?.id !== checkpoint.id || (await syncReplica.syncHead({ allowedScopes: [] })).id !== checkpoint.id || (await syncReplica.getFact('packed-derived-fact', { allowedScopes: [] }))?.derivations[0]?.state !== 'active') throw new Error('packed whole-memory sync request snapshot or transfer failed')\n` +
      `await memory.remember({ id: 'packed-sync-compaction-sentinel', kind: 'text', content: { type: 'text', text: 'Packed checkpoint payload compaction works.' }, source: { kind: 'smoke' } })\n` +
      `const compactedHead = await memory.createSyncCheckpoint({ access: { allowedScopes: [] }, confirmSpaceId: 'packed-smoke', maxChunkBytes: 65536 }, { operationId: 'packed-compacted-head' })\n` +
      `const syncCompactionBaseline = await memory.snapshot({ access: { allowedScopes: [] } })\n` +
      `const syncCompaction = await memory.compactSyncHistory({ access: { allowedScopes: [] }, confirmSpaceId: 'packed-smoke', expectedRevision: syncCompactionBaseline.snapshotRevision, expectedHead: compactedHead.id, before: new Date(Date.now() + 60000).toISOString(), maxCheckpoints: 64 })\n` +
      `const compactedPayloadUnavailable = await memory.syncChunks({ access: { allowedScopes: [] }, checkpointId: checkpoint.id }).then(() => false, (error) => error?.code === 'not_found' && error?.details?.requiresReseed === true)\n` +
      `const syncHistory = await memory.syncHistory({ access: { allowedScopes: [] }, limit: 100 })\n` +
      `let syncBundleCursor\nlet syncBundleCommit = false\nlet syncBundleChunks = 0\nconst syncBundleFrames = []\ndo { const page = await memory.exportSyncBundle({ access: { allowedScopes: [] }, confirmSpaceId: 'packed-smoke', checkpointId: compactedHead.id, cursor: syncBundleCursor, maxCheckpoints: 64, maxCheckpointBytes: 131072, limit: 2, maxBytes: 131072 }); syncBundleFrames.push(...page.frames); syncBundleCommit ||= page.frames.some((frame) => frame.type === 'commit' && frame.checkpointId === compactedHead.id); syncBundleChunks += page.frames.filter((frame) => frame.type === 'chunk').length; syncBundleCursor = page.nextCursor } while (syncBundleCursor !== undefined)\n` +
      `const syncBundlePeer = await openSyncBundle({ readCommit: async () => syncBundleFrames.find((frame) => frame.type === 'commit') ?? null, readCheckpoint: async (index) => syncBundleFrames.find((frame) => frame.type === 'checkpoint' && frame.index === index) ?? null, readChunk: async (index) => syncBundleFrames.find((frame) => frame.type === 'chunk' && frame.chunk.index === index) ?? null }, { maxCheckpoints: 64, maxCheckpointBytes: 131072 })\n` +
      `const syncBundleHead = await syncBundlePeer.syncHead({ allowedScopes: [] })\n` +
      `const sessionCompaction = await memory.compactSyncSessions({ access: { allowedScopes: [] }, confirmSpaceId: 'packed-smoke', expectedRevision: syncCompactionBaseline.snapshotRevision, expectedHead: compactedHead.id, before: new Date(Date.now() + 60000).toISOString(), maxSessions: 64 })\n` +
      `const syncSessions = await memory.syncSessions({ access: { allowedScopes: [] }, limit: 100 })\n` +
      `const retainedHeadPayload = await memory.syncChunks({ access: { allowedScopes: [] }, checkpointId: compactedHead.id })\n` +
      `if (syncCompaction.compactedCheckpoints !== 1 || syncCompaction.selected[0]?.checkpointId !== checkpoint.id || !compactedPayloadUnavailable || (await memory.syncCheckpoint(checkpoint.id, { allowedScopes: [] }))?.id !== checkpoint.id || syncHistory.checkpoints.find((item) => item.checkpoint.id === checkpoint.id)?.payloadState !== 'pruned' || !syncBundleCommit || syncBundleChunks !== compactedHead.chunkCount || syncBundleHead.id !== compactedHead.id || sessionCompaction.compactedSessions < 1 || !syncSessions.sessions.every((session) => session.detailsState === 'pruned') || retainedHeadPayload.chunks.length < 1) throw new Error('packed sync bundle, history, or session compaction failed')\n` +
      `const resolveIdentityRejected = await memory.resolveSync({ sessionId: 'missing', access: { allowedScopes: [] }, confirmSpaceId: 'packed-smoke', resolutions: [{ key: 'episode\\u0000missing', choice: 'local' }] }, { operationId: 'packed-resolve-ignored' }).then(() => false, (error) => error?.code === 'invalid_input')\n` +
      `const abortIdentityRejected = await memory.abortSync({ sessionId: 'missing', access: { allowedScopes: [] }, confirmSpaceId: 'packed-smoke' }, { operationId: 'packed-abort-ignored' }).then(() => false, (error) => error?.code === 'invalid_input')\n` +
      `if (!resolveIdentityRejected || !abortIdentityRejected) throw new Error('packed sync continuation identity boundary failed')\n` +
      `await syncReplica.close()\n` +
      `await memory.close()\n` +
      `const restored = createMemory({ spaceId: 'packed-smoke', storage: createInMemoryStorage() })\n` +
      `await restored.open({ create: true })\n` +
      `const archiveSchemaRejected = await restored.import({ ...archive, unexpected: true }, { dryRun: true, limits: { maxRecords: 1000, maxBytes: 1048576 }, prepareLimits: { maxRecords: 1000, maxBytes: 1048576 } }).then(() => false, (error) => error?.code === 'import_invalid' && error.message.includes('unexpected'))\n` +
      `const dryRunIdentityRejected = await restored.import(archive, { dryRun: true, operationId: 'packed-dry-run-ignored' }).then(() => false, (error) => error?.code === 'invalid_input')\n` +
      `const importSnapshotArchive = structuredClone(archive); const importSnapshotOptions = { dryRun: true, limits: { maxRecords: 1000, maxBytes: 1048576 }, prepareLimits: { maxRecords: 1000, maxBytes: 1048576 } }; const importSnapshotPromise = restored.import(importSnapshotArchive, importSnapshotOptions); importSnapshotArchive.manifest.digest = '0'.repeat(64); importSnapshotOptions.dryRun = false; importSnapshotOptions.limits.maxRecords = 0; const dryRun = await importSnapshotPromise\n` +
      `if (!archiveSchemaRejected || !dryRunIdentityRejected || !dryRun.valid || !dryRun.dryRun) throw new Error('packed archive schema, dry-run, or import request snapshot failed')\n` +
      `await restored.import(archive, { limits: { maxRecords: 1000, maxBytes: 1048576 }, prepareLimits: { maxRecords: 1000, maxBytes: 1048576 } })\n` +
      `const restoredResult = await restored.recall({ query: 'artifact', access: { allowedScopes: [] } })\n` +
      `if (!restoredResult.entities.some((entity) => entity.id === 'artifact')) throw new Error('packed archive import failed')\n` +
      `const restoredDerived = await restored.getFact('packed-derived-fact', { allowedScopes: [] })\n` +
      `if (restoredDerived?.derivations[0]?.state !== 'active') throw new Error('packed derivation archive import failed')\n` +
      `const restoredChanges = await restored.changes({ access: { allowedScopes: [] } })\n` +
      `if (restoredChanges.changes.length !== 1 || restoredChanges.changes[0].phase !== 'import') throw new Error('packed import change failed')\n` +
      `await restored.close()\n`,
  )
  execFileSync(process.execPath, [smokePath], { cwd: consumerRoot, stdio: 'inherit' })
  const typeSmokePath = join(consumerRoot, 'smoke.ts')
  writeFileSync(
    typeSmokePath,
    `import { createMemory, openSyncBundle, type AbortSyncRequest, type AnalysisPageRankSeed, type AnalysisReport, type AnalysisWorkBudgets, type ArchiveCounts, type ArchiveEpisode, type ArchiveLimits, type ArchiveMerge, type BrowsePage, type BulkDeletionReport, type ChangesPage, type CompactChangesReport, type CompactChangesRequest, type CompactSignalChangesReport, type CompactSignalChangesRequest, type CompactSyncHistoryReport, type CompactSyncHistoryRequest, type CompactSyncSessionsReport, type CompactSyncSessionsRequest, type CorrectFactInput, type CorrectionReport, type CreateSyncCheckpointRequest, type DeleteEpisodeInput, type DeleteEpisodesBySignalTargetsInput, type DeleteSignalsRequest, type Derivation, type DerivationBatchReport, type DerivationFilter, type DerivationInput, type DerivationReport, type DerivationResult, type DerivationWithdrawalBatchReport, type DerivationWithdrawalPreview, type DerivationWithdrawalResult, type DerivationWork, type DerivationWorkLimits, type DeriveFactInput, type DeriveFactsInput, type DisclosureLimits, type DisclosureRequest, type EntityMergeReport, type EpisodeDeletionReport, type ExportSyncBundleRequest, type IntegrityLimits, type IntegrityOptions, type IntegrityReport, type IntegrityWork, type MaintenanceReport, type ManagementOptions, type MemoryChange, type MemoryPolicy, type MemorySignal, type MemorySignalChange, type MemorySnapshot, type MemorySyncPeer, type MergeEntitiesInput, type OpenOptions, type OpenSyncBundleOptions, type PhysicalScanWork, type PointReadOptions, type PointReadRequest, type PointReadResult, type PreviewDerivationWithdrawalsInput, type ProcessingOperation, type ProjectionSetStatus, type PurgeInput, type PurgeReport, type PutSignalsReport, type PutSignalsRequest, type ResetSpaceInput, type ResetSpaceReport, type ResolveSyncRequest, type RetractFactInput, type RetractionReport, type SchemaMigration, type SignalChangesPage, type SignalPage, type SplitEntityMergeInput, type SyncBundleFrame, type SyncBundlePage, type SyncBundleReader, type SyncCheckpoint, type SyncCheckpointPayloadState, type SyncConflictDetail, type SyncConflictDetailRequest, type SyncConflictPage, type SyncConflictsRequest, type SyncFromRequest, type SyncHistoryCompactionItem, type SyncHistoryItem, type SyncHistoryPage, type SyncHistoryRequest, type SyncReceiveLimits, type SyncReport, type SyncSessionCompactionItem, type SyncSessionDetailsState, type SyncSessionSummary, type SyncSessionsPage, type SyncSessionsRequest, type WithdrawDerivationInput, type WithdrawDerivationsInput } from '@astrale-os/temporal-memory'\n` +
      `import type { IngestionOptions, IngestionReport } from '@astrale-os/temporal-memory'\n` +
      `import type { DeleteEpisodesByFilterInput, EpisodeDeletionPreview, PreviewEpisodeDeletionsInput } from '@astrale-os/temporal-memory'\n` +
      `import type { AcknowledgeJournalConsumerRequest, JournalConsumer, JournalConsumersPage, RegisterJournalConsumerRequest, RetireJournalConsumerRequest } from '@astrale-os/temporal-memory'\n` +
      `import { createSurrealMemoryCapabilities, createSurrealMemoryStorage, type SurrealMemoryAdmin, type SurrealMemoryAdminOptions, type SurrealMemoryCapabilities, type SurrealMemoryStorageOptions, type SurrealRawQueryRequest, type SurrealRawQueryResult } from '@astrale-os/temporal-memory/surreal'\n` +
      `import { createInMemoryStorage } from '@astrale-os/temporal-memory/testing'\n` +
      `const memory = createMemory({ spaceId: 'typed-consumer', storage: createInMemoryStorage() })\n` +
      `const disclosureLimits: DisclosureLimits = { maxBytes: 1048576, maxTokens: 128000, countTokens: (request: DisclosureRequest) => request.sensitivities.length }\n` +
      `const disclosurePolicy: MemoryPolicy = { authorizeDisclosure: (request) => request.sensitivities.length > 10 ? { action: 'deny', reason: 'classified' } : { action: 'allow' } }\n` +
      `const disclosureMemory = createMemory({ spaceId: 'typed-disclosure', storage: createInMemoryStorage(), disclosureLimits, policy: disclosurePolicy })\n` +
      `const openOptions: OpenOptions = { migrate: true }\n` +
      `const schemaMigration: SchemaMigration | undefined = (await memory.inspect()).schemaMigrations[0]\n` +
      `const page: Promise<BrowsePage<'entity'>> = memory.browse({ kind: 'entity', access: { allowedScopes: [] } })\n` +
      `const browseScan: Promise<PhysicalScanWork> = page.then((result) => result.scan)\n` +
      `const pointReadRequest: PointReadRequest<'entity'> = { kind: 'entity', id: 'entity', access: { allowedScopes: [] }, scanLimits: { maxRecords: 100, maxBytes: 1048576 } }\n` +
      `const pointRead: Promise<PointReadResult<'entity'>> = memory.read(pointReadRequest)\n` +
      `const pointReadScan: Promise<PhysicalScanWork> = pointRead.then((result) => result.scan)\n` +
      `const pointReadOptions: PointReadOptions = { scanLimits: { maxRecords: 100, maxBytes: 1048576 } }\n` +
      `const pointEntity = memory.getEntity('entity', { allowedScopes: [] }, pointReadOptions)\n` +
      `const recallScan: Promise<PhysicalScanWork> = memory.recall({ query: 'typed', access: { allowedScopes: [] }, scanLimits: { maxRecords: 100, maxBytes: 1048576 } }).then((result) => result.scan)\n` +
      `const neighborhoodScan: Promise<PhysicalScanWork> = memory.neighborhood({ entityId: 'entity', access: { allowedScopes: [] }, scanLimits: { maxRecords: 100, maxBytes: 1048576 } }).then((result) => result.scan)\n` +
      `const analysisSeed: AnalysisPageRankSeed = { id: 'entity', weight: 1 }\n` +
      `const analysisBudgets: AnalysisWorkBudgets = { maxScannedRecords: 100, maxScannedBytes: 1048576, maxAnalyzedRecords: 100, maxGraphNodes: 100, maxGraphEdges: 100, maxPageRankSteps: 10000, maxTemporalComparisons: 100 }\n` +
      `const archiveLimits: ArchiveLimits = { maxRecords: 100, maxBytes: 1048576 }\n` +
      `const managementOptions: ManagementOptions = { scanLimits: archiveLimits }\n` +
      `const statsScan: Promise<PhysicalScanWork> = memory.stats(managementOptions).then((report) => report.scan)\n` +
      `const inspectionScan: Promise<PhysicalScanWork> = memory.inspect(managementOptions).then((report) => report.scan)\n` +
      `const archive = memory.export({ access: { allowedScopes: [] }, scanLimits: archiveLimits, limits: archiveLimits })\n` +
      `const archiveEpisode: ArchiveEpisode | undefined = (await archive).canonical.episodes[0]\n` +
      `const archiveMerge: ArchiveMerge | undefined = (await archive).canonical.merges[0]\n` +
      `const archiveCounts: ArchiveCounts = (await archive).manifest.counts\n` +
      `const integrityLimits: IntegrityLimits = { maxRecords: 100, maxBytes: 1048576, maxGraphNodes: 100, maxGraphEdges: 100, maxIssues: 10 }\n` +
      `const integrityOptions: IntegrityOptions = { limits: integrityLimits }\n` +
      `const integrity: Promise<IntegrityReport> = memory.verifyIntegrity(integrityOptions)\n` +
      `const integrityWork: Promise<IntegrityWork> = integrity.then((report) => report.work)\n` +
      `const analysis: Promise<AnalysisReport> = memory.analyze({ access: { allowedScopes: [] }, pagerank: { seeds: [analysisSeed] }, budgets: analysisBudgets })\n` +
      `const findingSummary: AnalysisReport['findingSummary'] = (await analysis).findingSummary\n` +
      `const scannedAnalysisBytes: number = (await analysis).work.scannedBytes\n` +
      `const derivationWorkLimits: DerivationWorkLimits = { maxRecords: 100, maxBytes: 1048576, maxGraphNodes: 100, maxGraphEdges: 100 }\n` +
      `const ingestionOptions: IngestionOptions = { operationId: 'typed-ingestion', contextScanLimits: archiveLimits, projectionScanLimits: archiveLimits, workLimits: derivationWorkLimits }\n` +
      `const ingestionResult: Promise<IngestionReport> = memory.remember({ id: 'typed-episode', kind: 'text', content: { type: 'text', text: 'typed' }, source: { kind: 'typed' } }, ingestionOptions)\n` +
      `const ingestionContextScan: Promise<PhysicalScanWork> = ingestionResult.then((report) => report.contextScan)\n` +
      `const ingestionProjectionScan: Promise<PhysicalScanWork> = ingestionResult.then((report) => report.projectionScan)\n` +
      `const ingestionWork: Promise<DerivationWork> = ingestionResult.then((report) => report.work)\n` +
      `const deriveInput: DeriveFactInput = { conclusion: { subjectId: 'entity', predicate: 'derived', object: { kind: 'scalar', value: true } }, rule: { id: 'typed-rule', version: '1' }, premises: [{ kind: 'fact', id: 'source-fact' }], access: { allowedScopes: [] }, expectedRevision: 0, workLimits: derivationWorkLimits }\n` +
      `const deriveResult: Promise<DerivationReport> = memory.deriveFact(deriveInput)\n` +
      `const derivationInput: DerivationInput = { conclusion: { subjectId: 'entity', predicate: 'derived-batch', object: { kind: 'scalar', value: true } }, rule: { id: 'typed-batch-rule', version: '1' }, premises: [{ kind: 'fact', id: 'source-fact' }] }\n` +
      `const deriveFactsInput: DeriveFactsInput = { derivations: [derivationInput], access: { allowedScopes: [] }, expectedRevision: 0, workLimits: derivationWorkLimits }\n` +
      `const deriveFactsResult: Promise<DerivationBatchReport> = memory.deriveFacts(deriveFactsInput)\n` +
      `const firstDerivationResult: DerivationResult | undefined = (await deriveFactsResult).results[0]\n` +
      `const derivationWork: Promise<DerivationWork> = deriveResult.then((report) => report.work)\n` +
      `const derivation: Promise<Derivation | null> = memory.getDerivation('derivation', { allowedScopes: [] })\n` +
      `const withdrawInput: WithdrawDerivationInput = { derivationId: 'derivation', access: { allowedScopes: [] }, expectedRevision: 0, workLimits: derivationWorkLimits }\n` +
      `const withdrawResult: Promise<DerivationReport> = memory.withdrawDerivation(withdrawInput)\n` +
      `const derivationFilter: DerivationFilter = { ruleIds: ['typed-batch-rule'], ruleVersions: ['1'] }\n` +
      `const previewDerivationWithdrawalsInput: PreviewDerivationWithdrawalsInput = { where: derivationFilter, access: { allowedScopes: [] }, expectedRevision: 0, maxMatches: 10, workLimits: derivationWorkLimits }\n` +
      `const previewDerivationWithdrawalsResult: Promise<DerivationWithdrawalPreview> = memory.previewDerivationWithdrawals(previewDerivationWithdrawalsInput)\n` +
      `const withdrawDerivationsInput: WithdrawDerivationsInput = { where: derivationFilter, access: { allowedScopes: [] }, expectedRevision: 0, maxMatches: 10, selectionCursor: (await previewDerivationWithdrawalsResult).selectionCursor, workLimits: derivationWorkLimits }\n` +
      `const withdrawDerivationsResult: Promise<DerivationWithdrawalBatchReport> = memory.withdrawDerivations(withdrawDerivationsInput)\n` +
      `const firstDerivationWithdrawal: DerivationWithdrawalResult | undefined = (await withdrawDerivationsResult).withdrawals[0]\n` +
      `const correctionInput: CorrectFactInput = { factId: 'source-fact', replacement: { subject: { id: 'entity' }, predicate: 'corrected', object: { scalar: false } }, access: { allowedScopes: [] }, workLimits: derivationWorkLimits }\n` +
      `const correctionResult: Promise<CorrectionReport> = memory.correctFact(correctionInput)\n` +
      `const correctionWork: Promise<DerivationWork> = correctionResult.then((report) => report.work)\n` +
      `const retractInput: RetractFactInput = { factId: 'source-fact', allSupport: true, access: { allowedScopes: [] }, workLimits: derivationWorkLimits }\n` +
      `const retractResult: Promise<RetractionReport> = memory.retractFact(retractInput)\n` +
      `const retractionWork: Promise<DerivationWork> = retractResult.then((report) => report.work)\n` +
      `const signalPage: Promise<SignalPage> = memory.browseSignals({ access: { allowedScopes: [] }, maxBytes: 1024 * 1024 })\n` +
      `const putSignals: PutSignalsRequest = { access: { allowedScopes: [] }, expectedRevision: 0, basisScanLimits: archiveLimits, signals: [{ namespace: 'typed', target: { kind: 'episode', id: 'episode' }, producer: { kind: 'manual', id: 'typed', version: '1' }, scopes: [], value: true }] }\n` +
      `const putSignalsResult: Promise<PutSignalsReport> = memory.putSignals(putSignals)\n` +
      `const signalBasisScan: Promise<PhysicalScanWork> = putSignalsResult.then((report) => report.basisScan)\n` +
      `const resetSpaceInput: ResetSpaceInput = { confirmSpaceId: 'typed-consumer', scanLimits: archiveLimits }\n` +
      `const resetSpaceResult: Promise<ResetSpaceReport> = memory.resetSpace(resetSpaceInput)\n` +
      `const resetSpaceScan: Promise<PhysicalScanWork> = resetSpaceResult.then((report) => report.scan)\n` +
      `// @ts-expect-error reset cannot durably bind a caller operationId after deleting the space\n` +
      `memory.resetSpace(resetSpaceInput, { operationId: 'invalid-reset-operation' })\n` +
      `const deleteSignals: DeleteSignalsRequest = { access: { allowedScopes: [] }, mode: 'purge', where: { namespaces: ['typed'] }, expectedRevision: 0, maxMatches: 1, maxRevisions: 1 }\n` +
      `const signal: MemorySignal | undefined = (await signalPage).signals[0]\n` +
      `const signalChanges: Promise<SignalChangesPage> = memory.signalChanges({ access: { allowedScopes: [] }, cursor: (await signalPage).signalChangesCursor })\n` +
      `const signalChange: MemorySignalChange | undefined = (await signalChanges).changes[0]\n` +
      `const registerJournalConsumer: RegisterJournalConsumerRequest = { id: 'typed-signal-consumer', journal: 'signal', cursor: (await signalPage).signalChangesCursor }\n` +
      `const registeredJournalConsumer: Promise<JournalConsumer> = memory.registerJournalConsumer(registerJournalConsumer)\n` +
      `const acknowledgeJournalConsumer: AcknowledgeJournalConsumerRequest = { id: 'typed-signal-consumer', journal: 'signal', cursor: (await signalPage).signalChangesCursor }\n` +
      `const acknowledgedJournalConsumer: Promise<JournalConsumer> = memory.acknowledgeJournalConsumer(acknowledgeJournalConsumer)\n` +
      `const journalConsumers: Promise<JournalConsumersPage> = memory.journalConsumers({ journal: 'signal', state: 'all' })\n` +
      `const retireJournalConsumer: RetireJournalConsumerRequest = { id: 'typed-signal-consumer', journal: 'signal' }\n` +
      `const retiredJournalConsumer: Promise<JournalConsumer> = memory.retireJournalConsumer(retireJournalConsumer)\n` +
      `const signalTargetPurge: PurgeInput = { access: { allowedScopes: [] }, signalTargets: { where: { namespaces: ['typed'] }, selectionCursor: (await signalPage).targetSelectionCursor! }, maxMatches: 1 }\n` +
      `const purgeResult: Promise<PurgeReport> = memory.hardPurge({ ...signalTargetPurge, workLimits: derivationWorkLimits })\n` +
      `const purgeWork: Promise<DerivationWork> = purgeResult.then((report) => report.work)\n` +
      `const signalTargetDelete: DeleteEpisodesBySignalTargetsInput = { access: { allowedScopes: [] }, signalTargets: { where: { namespaces: ['typed'] }, selectionCursor: (await signalPage).targetSelectionCursor! }, maxMatches: 1, workLimits: derivationWorkLimits }\n` +
      `const bulkDeletion: Promise<BulkDeletionReport> = memory.deleteEpisodes(signalTargetDelete)\n` +
      `const bulkDeletionWork: Promise<DerivationWork> = bulkDeletion.then((report) => report.work)\n` +
      `const compactSignalRequest: CompactSignalChangesRequest = { confirmSpaceId: 'typed-consumer', registeredConsumers: true, expectedRevision: 0, maxChanges: 100 }\n` +
      `const signalCompaction: Promise<CompactSignalChangesReport> = memory.compactSignalChanges(compactSignalRequest)\n` +
      `const snapshot: Promise<MemorySnapshot> = memory.snapshot({ access: { allowedScopes: [] }, scanLimits: archiveLimits })\n` +
      `const snapshotScanBytes: number = (await snapshot).scan.bytes\n` +
      `const changes: Promise<ChangesPage> = memory.changes({ access: { allowedScopes: [] } })\n` +
      `const changesAfterSnapshot: Promise<ChangesPage> = memory.changes({ access: { allowedScopes: [] }, cursor: (await snapshot).changesCursor })\n` +
      `const compactRequest: CompactChangesRequest = { confirmSpaceId: 'typed-consumer', registeredConsumers: true, expectedRevision: 0, maxChanges: 100 }\n` +
      `const compaction: Promise<CompactChangesReport> = memory.compactChanges(compactRequest)\n` +
      `const change: MemoryChange | undefined = (await changes).changes[0]\n` +
      `const operation: Promise<ProcessingOperation | null> = memory.operation('operation')\n` +
      `const diagnosticsState: ProcessingOperation['diagnosticsState'] | undefined = (await operation)?.diagnosticsState\n` +
      `const diagnosticsTruncated: ProcessingOperation['diagnosticsTruncated'] | undefined = (await operation)?.diagnosticsTruncated\n` +
      `const projectionRebuild: Promise<MaintenanceReport> = memory.rebuildProjections({ kinds: ['lexical'], scanLimits: archiveLimits })\n` +
      `const projectionSet: ProjectionSetStatus | undefined = (await projectionRebuild).activeProjectionSets[0]\n` +
      `const projectionScan: PhysicalScanWork = (await projectionRebuild).scan\n` +
      `const deletion: DeleteEpisodeInput = { episodeId: 'episode', access: { allowedScopes: [] }, workLimits: derivationWorkLimits }\n` +
      `const episodeDeletion: Promise<EpisodeDeletionReport> = memory.deleteEpisode(deletion)\n` +
      `const deletionWork: Promise<DerivationWork> = episodeDeletion.then((report) => report.work)\n` +
      `const episodeDeletionPreviewInput: PreviewEpisodeDeletionsInput = { where: { tags: { all: ['typed-preview-delete'] } }, access: { allowedScopes: [] }, expectedRevision: 0, maxMatches: 10, workLimits: derivationWorkLimits }\n` +
      `const episodeDeletionPreview: Promise<EpisodeDeletionPreview> = memory.previewEpisodeDeletions(episodeDeletionPreviewInput)\n` +
      `const filterDeletion: DeleteEpisodesByFilterInput = { where: episodeDeletionPreviewInput.where, access: { allowedScopes: [] }, expectedRevision: (await episodeDeletionPreview).snapshotRevision, maxMatches: 10, selectionCursor: (await episodeDeletionPreview).selectionCursor, workLimits: derivationWorkLimits }\n` +
      `const filterDeletionResult: Promise<BulkDeletionReport> = memory.deleteEpisodes(filterDeletion)\n` +
      `const mergeInput: MergeEntitiesInput = { targetId: 'target', sourceIds: ['source'], access: { allowedScopes: [] }, workLimits: derivationWorkLimits }\n` +
      `const mergeResult: Promise<EntityMergeReport> = memory.mergeEntities(mergeInput)\n` +
      `const mergeWork: Promise<DerivationWork> = mergeResult.then((report) => report.work)\n` +
      `const splitInput: SplitEntityMergeInput = { mergeId: 'merge', access: { allowedScopes: [] }, workLimits: derivationWorkLimits }\n` +
      `const splitResult: Promise<EntityMergeReport> = memory.splitEntityMerge(splitInput)\n` +
      `const splitWork: Promise<DerivationWork> = splitResult.then((report) => report.work)\n` +
      `const checkpointRequest: CreateSyncCheckpointRequest = { access: { allowedScopes: [] }, confirmSpaceId: 'typed-consumer' }\n` +
      `const checkpoint: Promise<SyncCheckpoint> = memory.createSyncCheckpoint(checkpointRequest)\n` +
      `const syncBundleRequest: ExportSyncBundleRequest = { access: { allowedScopes: [] }, confirmSpaceId: 'typed-consumer', maxCheckpoints: 100, maxCheckpointBytes: 1048576, limit: 16 }\n` +
      `const syncBundle: Promise<SyncBundlePage> = memory.exportSyncBundle(syncBundleRequest)\n` +
      `const syncBundleFrame: SyncBundleFrame | undefined = (await syncBundle).frames[0]\n` +
      `const syncBundleReader: SyncBundleReader = { readCommit: async () => null, readCheckpoint: async () => null, readChunk: async () => null }\n` +
      `const openSyncBundleOptions: OpenSyncBundleOptions = { maxCheckpoints: 100, maxCheckpointBytes: 1048576 }\n` +
      `const syncBundlePeer: Promise<MemorySyncPeer> = openSyncBundle(syncBundleReader, openSyncBundleOptions)\n` +
      `const syncCompactionRequest: CompactSyncHistoryRequest = { access: { allowedScopes: [] }, confirmSpaceId: 'typed-consumer', expectedRevision: 0, expectedHead: 'a'.repeat(64), before: '2026-08-04T00:00:00.000Z', maxCheckpoints: 64 }\n` +
      `const syncCompaction: Promise<CompactSyncHistoryReport> = memory.compactSyncHistory(syncCompactionRequest)\n` +
      `const syncCompactionItem: SyncHistoryCompactionItem | undefined = (await syncCompaction).selected[0]\n` +
      `const syncHistoryRequest: SyncHistoryRequest = { access: { allowedScopes: [] }, limit: 50 }\n` +
      `const syncHistory: Promise<SyncHistoryPage> = memory.syncHistory(syncHistoryRequest)\n` +
      `const syncHistoryItem: SyncHistoryItem | undefined = (await syncHistory).checkpoints[0]\n` +
      `const checkpointPayloadState: SyncCheckpointPayloadState | undefined = syncHistoryItem?.payloadState\n` +
      `const syncSessionsRequest: SyncSessionsRequest = { access: { allowedScopes: [] }, limit: 50 }\n` +
      `const syncSessions: Promise<SyncSessionsPage> = memory.syncSessions(syncSessionsRequest)\n` +
      `const syncSession: SyncSessionSummary | undefined = (await syncSessions).sessions[0]\n` +
      `const syncSessionDetailsState: SyncSessionDetailsState | undefined = syncSession?.detailsState\n` +
      `const syncSessionCompactionRequest: CompactSyncSessionsRequest = { access: { allowedScopes: [] }, confirmSpaceId: 'typed-consumer', expectedRevision: 0, expectedHead: 'a'.repeat(64), before: '2026-08-04T00:00:00.000Z', maxSessions: 64 }\n` +
      `const syncSessionCompaction: Promise<CompactSyncSessionsReport> = memory.compactSyncSessions(syncSessionCompactionRequest)\n` +
      `const syncSessionCompactionItem: SyncSessionCompactionItem | undefined = (await syncSessionCompaction).selected[0]\n` +
      `const peer: MemorySyncPeer = memory\n` +
      `const syncReceiveLimits: SyncReceiveLimits = { maxBytes: 1024, maxRecords: 10, maxChunks: 2 }\n` +
      `const syncRequest: SyncFromRequest = { access: { allowedScopes: [] }, confirmSpaceId: 'typed-consumer', strategy: 'merge', receiveLimits: syncReceiveLimits }\n` +
      `const sync: Promise<SyncReport> = memory.syncFrom(peer, syncRequest)\n` +
      `const syncStatus: Promise<SyncReport | null> = memory.syncStatus('session', { allowedScopes: [] })\n` +
      `const syncDiagnosticsTruncated: SyncReport['diagnosticsTruncated'] = (await sync).diagnosticsTruncated\n` +
      `const syncError: SyncReport['error'] = (await sync).error\n` +
      `const syncConflictsRequest: SyncConflictsRequest = { sessionId: 'session', access: { allowedScopes: [] }, maxBytes: 1048576 }\n` +
      `const syncConflictPage: Promise<SyncConflictPage> = memory.syncConflicts(syncConflictsRequest)\n` +
      `const syncConflictPageBytes: SyncConflictPage['byteLength'] = (await syncConflictPage).byteLength\n` +
      `const syncConflictDetailRequest: SyncConflictDetailRequest = { sessionId: 'session', key: 'fact\\u0000id', access: { allowedScopes: [] }, maxBytes: 1024 }\n` +
      `const syncConflictDetail: Promise<SyncConflictDetail> = memory.syncConflict(syncConflictDetailRequest)\n` +
      `const resolveSyncRequest: ResolveSyncRequest = { sessionId: 'session', access: { allowedScopes: [] }, confirmSpaceId: 'typed-consumer', resolutions: [{ key: 'fact\\u0000id', choice: 'local' }] }\n` +
      `const abortSyncRequest: AbortSyncRequest = { sessionId: 'session', access: { allowedScopes: [] }, confirmSpaceId: 'typed-consumer' }\n` +
      `// @ts-expect-error sync resolution continues the sessionId and accepts no separate operationId\n` +
      `memory.resolveSync(resolveSyncRequest, { operationId: 'invalid-resolve-operation' })\n` +
      `// @ts-expect-error sync abort continues the sessionId and accepts no separate operationId\n` +
      `memory.abortSync(abortSyncRequest, { operationId: 'invalid-abort-operation' })\n` +
      `const surrealOptions: SurrealMemoryStorageOptions = { endpoint: 'mem://', worker: false }\n` +
      `const surrealStorage = createSurrealMemoryStorage(surrealOptions)\n` +
      `const surrealAdminOptions: SurrealMemoryAdminOptions = { dangerouslyAllowRawQueries: true }\n` +
      `const surrealCapabilities: SurrealMemoryCapabilities = createSurrealMemoryCapabilities(surrealOptions, surrealAdminOptions)\n` +
      `const surrealAdmin: SurrealMemoryAdmin = surrealCapabilities.admin\n` +
      `const rawQueryRequest: SurrealRawQueryRequest = { query: 'RETURN $value', bindings: { value: true }, confirmNamespace: 'astrale', confirmDatabase: 'temporal_memory' }\n` +
      `const rawQuery: Promise<SurrealRawQueryResult<[boolean]>> = surrealAdmin.rawQuery<[boolean]>(rawQueryRequest)\n` +
      `// @ts-expect-error raw-query result assertions must remain JSON-compatible\n` +
      `surrealAdmin.rawQuery<[Date]>(rawQueryRequest)\n` +
      `// @ts-expect-error rawQuery is available only on the separate admin capability\n` +
      `surrealStorage.rawQuery(rawQueryRequest)\n` +
      `// @ts-expect-error an application storage capability cannot be elevated after construction\n` +
      `createSurrealMemoryCapabilities(surrealStorage, surrealAdminOptions)\n` +
      `void disclosureMemory\nvoid openOptions\nvoid schemaMigration\nvoid page\nvoid browseScan\nvoid pointReadRequest\nvoid pointRead\nvoid pointReadScan\nvoid pointReadOptions\nvoid pointEntity\nvoid recallScan\nvoid neighborhoodScan\nvoid analysis\nvoid findingSummary\nvoid managementOptions\nvoid statsScan\nvoid inspectionScan\nvoid archive\nvoid archiveEpisode\nvoid archiveMerge\nvoid archiveCounts\nvoid integrity\nvoid integrityWork\nvoid ingestionContextScan\nvoid ingestionProjectionScan\nvoid ingestionWork\nvoid deriveResult\nvoid derivation\nvoid withdrawResult\nvoid correctionResult\nvoid correctionWork\nvoid signalPage\nvoid putSignals\nvoid putSignalsResult\nvoid signalBasisScan\nvoid resetSpaceInput\nvoid resetSpaceResult\nvoid resetSpaceScan\nvoid deleteSignals\nvoid signal\nvoid signalChanges\nvoid signalChange\nvoid signalTargetPurge\nvoid signalTargetDelete\nvoid signalCompaction\nvoid changesAfterSnapshot\nvoid compaction\nvoid change\nvoid projectionSet\nvoid projectionScan\nvoid deletion\nvoid episodeDeletion\nvoid deletionWork\nvoid episodeDeletionPreview\nvoid filterDeletion\nvoid filterDeletionResult\nvoid mergeResult\nvoid mergeWork\nvoid splitResult\nvoid splitWork\nvoid checkpoint\nvoid syncBundleFrame\nvoid syncCompactionItem\nvoid syncHistoryItem\nvoid checkpointPayloadState\nvoid syncSession\nvoid syncSessionDetailsState\nvoid syncSessionCompactionItem\nvoid syncReceiveLimits\nvoid sync\nvoid syncStatus\nvoid syncConflictsRequest\nvoid syncConflictPage\nvoid syncConflictPageBytes\nvoid syncConflictDetail\nvoid resolveSyncRequest\nvoid abortSyncRequest\nvoid surrealStorage\nvoid surrealAdminOptions\nvoid surrealAdmin\nvoid rawQuery\n`,
  )
  execFileSync(
    'tsgo',
    [
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      typeSmokePath,
    ],
    { cwd: consumerRoot, stdio: 'inherit' },
  )
  if (!nodeOnly) await verifyBrowserConsumer(consumerRoot)
  process.stdout.write(`verified packed consumer: ${tarballs[0]}\n`)
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true })
}
