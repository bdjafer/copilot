import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(fileURLToPath(import.meta.url)) + '/..'
const defaultOutput = join(packageRoot, 'dist', 'sbom.cdx.json')
const wasmPackageName = '@astrale-os/surrealdb-wasm'
const wasmPackageVersion = '3.0.4-astrale.1'
const wasmCoreVersion = '3.0.5'
const wasmProtocolVersion = '0.8.3'
const wasmSha256 = '5211b20f09a4834febff0d21d0f83c468e8275a4d36a333151fed5c2dd57c634'
const wasmInventorySha256 = '65a1d2f14a2d370680ab2b79cf67b62c69a17f2ae77e27dba8af67476d92ab6b'
const expectedCargoComponents = 337

const licenseHeadingToSpdx = new Map([
  ['Apache License 2.0', 'Apache-2.0'],
  ['BSD 2-Clause "Simplified" License', 'BSD-2-Clause'],
  ['BSD 3-Clause "New" or "Revised" License', 'BSD-3-Clause'],
  ['Business Source License 1.1', 'BUSL-1.1'],
  ['ISC License', 'ISC'],
  ['MIT License', 'MIT'],
  ['Mozilla Public License 2.0', 'MPL-2.0'],
  ['The Unlicense', 'Unlicense'],
  ['Unicode License v3', 'Unicode-3.0'],
  ['zlib License', 'Zlib'],
])

function fail(message) {
  throw new Error(`SBOM generation failed: ${message}`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function decodeHtml(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

function parseArguments(argv) {
  let check = false
  let output = defaultOutput
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--check') {
      check = true
      continue
    }
    if (argument === '--output') {
      const next = argv[index + 1]
      if (next === undefined || next.startsWith('--')) fail('--output requires a path')
      output = resolve(packageRoot, next)
      index += 1
      continue
    }
    fail(`unknown argument ${JSON.stringify(argument)}`)
  }
  return { check, output }
}

function npmCoordinates(packageName, version) {
  if (packageName.startsWith('@')) {
    const separator = packageName.indexOf('/')
    if (separator < 2 || separator === packageName.length - 1) {
      fail(`invalid scoped npm package name ${JSON.stringify(packageName)}`)
    }
    const group = packageName.slice(0, separator)
    const name = packageName.slice(separator + 1)
    return {
      group,
      name,
      purl: `pkg:npm/${encodeURIComponent(group)}/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
    }
  }
  return {
    name: packageName,
    purl: `pkg:npm/${encodeURIComponent(packageName)}@${encodeURIComponent(version)}`,
  }
}

function cargoCoordinates(packageId) {
  const separator = packageId.lastIndexOf('@')
  if (separator < 1 || separator === packageId.length - 1) {
    fail(`invalid Cargo package identity ${JSON.stringify(packageId)}`)
  }
  const name = packageId.slice(0, separator)
  const version = packageId.slice(separator + 1)
  return {
    name,
    version,
    purl: `pkg:cargo/${encodeURIComponent(name)}@${encodeURIComponent(version)}`,
  }
}

function repositoryUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  return raw.replace(/^git\+/, '').replace(/^git:\/\//, 'https://')
}

function externalReferences(manifest, resolvedUrl) {
  const references = []
  if (typeof manifest.homepage === 'string' && manifest.homepage.length > 0) {
    references.push({ type: 'website', url: manifest.homepage })
  }
  const vcs = repositoryUrl(manifest.repository)
  if (vcs !== undefined) references.push({ type: 'vcs', url: vcs })
  if (typeof resolvedUrl === 'string' && /^https:\/\//.test(resolvedUrl)) {
    references.push({ type: 'distribution', url: resolvedUrl })
  }
  return references
    .filter(
      (reference, index, all) =>
        all.findIndex(
          (candidate) => candidate.type === reference.type && candidate.url === reference.url,
        ) === index,
    )
    .sort((left, right) =>
      `${left.type}\u0000${left.url}`.localeCompare(`${right.type}\u0000${right.url}`),
    )
}

function licenseChoice(license) {
  if (typeof license !== 'string' || license.length === 0)
    fail('package license metadata is missing')
  if (/\b(?:AND|OR|WITH)\b|[()]/.test(license)) return [{ expression: license }]
  return [{ license: { id: license } }]
}

function properties(entries) {
  return entries
    .map(([name, value]) => ({ name, value: String(value) }))
    .sort((left, right) =>
      `${left.name}\u0000${left.value}`.localeCompare(`${right.name}\u0000${right.value}`),
    )
}

function componentFromManifest(manifest, resolvedUrl) {
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    fail('a resolved npm component has incomplete identity metadata')
  }
  const coordinates = npmCoordinates(manifest.name, manifest.version)
  const component = {
    type: 'library',
    'bom-ref': coordinates.purl,
    ...(coordinates.group === undefined ? {} : { group: coordinates.group }),
    name: coordinates.name,
    version: manifest.version,
    scope: 'required',
    ...(typeof manifest.description === 'string' && manifest.description.length > 0
      ? { description: manifest.description }
      : {}),
    licenses: licenseChoice(manifest.license),
    purl: coordinates.purl,
  }
  const references = externalReferences(manifest, resolvedUrl)
  if (references.length > 0) component.externalReferences = references
  return component
}

function parseCargoInventory(inventoryHtml) {
  const packages = new Map()
  const sections = inventoryHtml.matchAll(/<section>\s*<h2>([\s\S]*?)<\/h2>([\s\S]*?)<\/section>/g)
  for (const match of sections) {
    const heading = decodeHtml(match[1].trim())
    const spdx = licenseHeadingToSpdx.get(heading)
    if (spdx === undefined) fail(`unrecognized Cargo license heading ${JSON.stringify(heading)}`)
    for (const item of match[2].matchAll(
      /<li data-package="([^"]+)">[\s\S]*?<a href="([^"]*)">[\s\S]*?<\/li>/g,
    )) {
      const packageId = decodeHtml(item[1])
      const website = decodeHtml(item[2])
      const existing = packages.get(packageId) ?? { licenses: new Set(), website }
      if (existing.website !== website) fail(`Cargo package ${packageId} has conflicting websites`)
      existing.licenses.add(spdx)
      packages.set(packageId, existing)
    }
  }

  if (packages.size !== expectedCargoComponents) {
    fail(`expected ${expectedCargoComponents} Cargo components, found ${packages.size}`)
  }
  for (const required of [
    `surrealdb-core@${wasmCoreVersion}`,
    `surrealdb-types@${wasmCoreVersion}`,
    `surrealdb-types-derive@${wasmCoreVersion}`,
    `surrealdb-protocol@${wasmProtocolVersion}`,
  ]) {
    if (!packages.has(required)) fail(`the locked WASM inventory is missing ${required}`)
  }

  return [...packages.entries()]
    .map(([packageId, metadata]) => {
      const coordinates = cargoCoordinates(packageId)
      const component = {
        type: 'library',
        'bom-ref': coordinates.purl,
        name: coordinates.name,
        version: coordinates.version,
        scope: 'required',
        licenses: [...metadata.licenses].sort().map((id) => ({ license: { id } })),
        purl: coordinates.purl,
      }
      if (/^https:\/\//.test(metadata.website)) {
        component.externalReferences = [{ type: 'website', url: metadata.website }]
      }
      if (
        ['surrealdb-core', 'surrealdb-types', 'surrealdb-types-derive'].includes(
          coordinates.name,
        ) &&
        coordinates.version === wasmCoreVersion
      ) {
        component.properties = properties([
          ['astrale:license:additional-use-grant', 'Database Service excluded'],
          ['astrale:license:change-date', '2030-01-01'],
          ['astrale:license:change-license', 'Apache-2.0'],
        ])
      }
      if (
        coordinates.name === 'surrealdb-protocol' &&
        coordinates.version === wasmProtocolVersion
      ) {
        component.properties = properties([
          ['astrale:license:additional-use-grant', 'SurrealDB 2.0 Database Service excluded'],
          ['astrale:license:change-date', '2029-09-17'],
          ['astrale:license:change-license', 'Apache-2.0'],
        ])
      }
      return component
    })
    .sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']))
}

function resolveInstalledPackage(packageName, ownerManifestPath) {
  let searchRoot = dirname(ownerManifestPath)
  while (searchRoot !== dirname(searchRoot)) {
    const candidate = join(searchRoot, 'node_modules', ...packageName.split('/'))
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    searchRoot = dirname(searchRoot)
  }
  const requireFromOwner = createRequire(ownerManifestPath)
  try {
    return realpathSync(dirname(requireFromOwner.resolve(`${packageName}/package.json`)))
  } catch (packageJsonError) {
    let current
    try {
      current = dirname(realpathSync(requireFromOwner.resolve(packageName)))
    } catch (entryError) {
      fail(
        `cannot resolve production dependency ${packageName} from ${ownerManifestPath}: ${entryError.message}`,
      )
    }
    while (current !== dirname(current)) {
      const candidate = join(current, 'package.json')
      if (existsSync(candidate)) {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8'))
        if (manifest.name === packageName) return current
      }
      current = dirname(current)
    }
    fail(
      `cannot find package metadata for ${packageName} resolved from ${ownerManifestPath}: ${packageJsonError.message}`,
    )
  }
}

function runtimeDependencyNames(manifest) {
  const requiredPeers = Object.keys(manifest.peerDependencies ?? {}).filter(
    (name) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
  )
  return [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...requiredPeers,
    ]),
  ].sort()
}

function buildNpmInventory(rootManifest) {
  const nodes = new Map()

  function visit(packageName, ownerManifestPath, resolvedUrl) {
    const packagePath = resolveInstalledPackage(packageName, ownerManifestPath)
    const manifestPath = join(packagePath, 'package.json')
    if (!existsSync(manifestPath))
      fail(`resolved dependency manifest is missing at ${manifestPath}`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.name !== packageName) {
      fail(`resolved ${packageName} to package metadata for ${manifest.name}`)
    }
    const coordinates = npmCoordinates(manifest.name, manifest.version)
    const reference = coordinates.purl
    const existing = nodes.get(reference)
    if (existing !== undefined) {
      if (existing.path !== packagePath) {
        fail(`resolved npm component ${reference} from multiple installed artifacts`)
      }
      return reference
    }
    nodes.set(reference, {
      component: componentFromManifest(manifest, resolvedUrl),
      dependsOn: [],
      manifest,
      path: packagePath,
    })
    const dependsOn = runtimeDependencyNames(manifest)
      .map((name) => visit(name, manifestPath))
      .sort()
    nodes.get(reference).dependsOn = dependsOn
    return reference
  }

  const rootManifestPath = join(packageRoot, 'package.json')
  const direct = Object.entries(rootManifest.dependencies ?? {})
    .map(([name, specifier]) =>
      visit(name, rootManifestPath, /^https:\/\//.test(specifier) ? specifier : undefined),
    )
    .sort()
  return { direct, nodes }
}

function contentUuid(hexDigest) {
  const bytes = Buffer.from(hexDigest.slice(0, 32), 'hex')
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function buildBom() {
  const rootManifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
  const rootComponent = componentFromManifest(rootManifest)
  const { direct, nodes } = buildNpmInventory(rootManifest)
  const wasmCoordinates = npmCoordinates(wasmPackageName, wasmPackageVersion)
  const wasmNode = nodes.get(wasmCoordinates.purl)
  if (wasmNode === undefined)
    fail(`resolved graph is missing ${wasmPackageName}@${wasmPackageVersion}`)
  if (wasmNode.manifest.surreal !== wasmCoreVersion) {
    fail(`WASM package does not declare embedded SurrealDB ${wasmCoreVersion}`)
  }

  const inventoryPath = join(wasmNode.path, 'THIRD_PARTY_LICENSES.html')
  const wasmPath = join(wasmNode.path, 'wasm', 'surrealdb_bg.wasm')
  const inventory = readFileSync(inventoryPath)
  const wasm = readFileSync(wasmPath)
  if (sha256(inventory) !== wasmInventorySha256) fail('WASM Cargo inventory hash is unexpected')
  if (sha256(wasm) !== wasmSha256) fail('embedded WASM hash is unexpected')

  const cargoComponents = parseCargoInventory(inventory.toString('utf8'))
  const wasmLicenseIds = new Set(['Apache-2.0'])
  for (const component of cargoComponents) {
    for (const choice of component.licenses) wasmLicenseIds.add(choice.license.id)
  }
  wasmNode.component.licenses = [...wasmLicenseIds].sort().map((id) => ({ license: { id } }))
  wasmNode.component.properties = properties([
    ['astrale:inventory:cargo-components', expectedCargoComponents],
    ['astrale:inventory:third-party-sha256', wasmInventorySha256],
    ['astrale:license:boundary', 'not wholly open source before applicable change dates'],
    ['astrale:surrealdb:core-version', wasmCoreVersion],
    ['astrale:surrealdb:protocol-version', wasmProtocolVersion],
    ['astrale:wasm:sha256', wasmSha256],
  ])
  wasmNode.component.components = [
    ...cargoComponents,
    {
      type: 'file',
      'bom-ref': `file:surrealdb_bg.wasm@sha256:${wasmSha256}`,
      name: 'surrealdb_bg.wasm',
      scope: 'required',
      hashes: [{ alg: 'SHA-256', content: wasmSha256 }],
      properties: properties([['astrale:file:size', wasm.byteLength]]),
    },
  ]

  const components = [...nodes.values()]
    .map((node) => node.component)
    .sort((left, right) => left['bom-ref'].localeCompare(right['bom-ref']))
  const dependencies = [
    { ref: rootComponent['bom-ref'], dependsOn: direct },
    ...[...nodes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([ref, node]) => ({ ref, dependsOn: node.dependsOn })),
  ]
  const compositions = [
    {
      aggregate: 'complete',
      dependencies: dependencies.map((dependency) => dependency.ref),
    },
    {
      aggregate: 'unknown',
      dependencies: wasmNode.component.components.map((component) => component['bom-ref']).sort(),
    },
  ]
  const content = {
    $schema: 'http://cyclonedx.org/schema/bom-1.6.schema.json',
    bomFormat: 'CycloneDX',
    specVersion: '1.6',
    version: 1,
    metadata: {
      component: rootComponent,
      properties: properties([
        ['astrale:sbom:dependency-relationships', 'npm complete; embedded Cargo inventory only'],
        ['astrale:sbom:generator', 'packages/temporal-memory/scripts/generate-sbom.mjs'],
        [
          'astrale:sbom:inventory-boundary',
          'resolved production npm graph plus shipped locked wasm32-unknown-unknown Cargo inventory',
        ],
        ['astrale:sbom:reproducible', 'timestamp omitted; serial derived from content'],
      ]),
    },
    components,
    dependencies,
    compositions,
  }
  return {
    ...content,
    serialNumber: contentUuid(sha256(JSON.stringify(content))),
  }
}

const { check, output } = parseArguments(process.argv.slice(2))
const serialized = `${JSON.stringify(buildBom(), null, 2)}\n`
if (
  serialized.includes(packageRoot) ||
  /\/(?:Users|home\/runner\/work)\//.test(serialized) ||
  /[A-Za-z]:\\\\/.test(serialized)
) {
  fail('generated output contains a machine-local path')
}
if (check) {
  if (!existsSync(output)) fail(`expected SBOM does not exist at ${output}`)
  const existing = readFileSync(output, 'utf8')
  if (existing !== serialized) fail(`generated SBOM is stale: ${output}`)
  process.stdout.write(`verified deterministic CycloneDX SBOM: ${output}\n`)
} else {
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, serialized)
  process.stdout.write(`generated deterministic CycloneDX SBOM: ${output}\n`)
}
