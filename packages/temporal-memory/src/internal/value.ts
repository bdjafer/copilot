import type {
  AccessContext,
  EntityMentionInput,
  EpisodeAnchor,
  EpisodeContent,
  EpisodeEvidenceInput,
  JsonValue,
  Ontology,
  TimeInterval,
} from '../types.ts'

import { MemoryError } from '../errors.ts'

export const DEFAULT_ONTOLOGY: Ontology = Object.freeze({
  id: 'astrale.open',
  version: '1',
  mode: 'open',
  entityTypes: Object.freeze({}),
  factTypes: Object.freeze({}),
})

export const MAX_JSON_NODES = 100_000
export const MAX_JSON_DEPTH = 64
export const MAX_JSON_STRING_BYTES = 4_000_000

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return false
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return false
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false
    }
  }
  return true
}

/** Deterministic Unicode scalar-value ordering, matching SurrealDB's default text order. */
export function compareUnicode(left: string, right: string): number {
  let leftIndex = 0
  let rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftPoint = left.codePointAt(leftIndex)!
    const rightPoint = right.codePointAt(rightIndex)!
    if (leftPoint !== rightPoint) return leftPoint < rightPoint ? -1 : 1
    leftIndex += leftPoint > 0xffff ? 2 : 1
    rightIndex += rightPoint > 0xffff ? 2 : 1
  }
  if (leftIndex === left.length && rightIndex === right.length) return 0
  return leftIndex === left.length ? -1 : 1
}

export function assertString(
  value: unknown,
  field: string,
  maximum = 256,
): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MemoryError('invalid_input', `${field} must be a non-empty string`)
  }
  if (!isWellFormedUnicode(value)) {
    throw new MemoryError('invalid_input', `${field} must contain well-formed Unicode`)
  }
  if (new TextEncoder().encode(value).byteLength > maximum) {
    throw new MemoryError('invalid_input', `${field} exceeds ${maximum} UTF-8 bytes`)
  }
}

export function assertInstant(value: unknown, field: string): asserts value is string {
  assertString(value, field, 128)
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new MemoryError(
      'invalid_input',
      `${field} must be a canonical UTC RFC 3339 instant with millisecond precision`,
    )
  }
}

export function assertInterval(interval: TimeInterval | undefined, field: string): void {
  if (interval === undefined) return
  if (interval.from !== undefined) assertInstant(interval.from, `${field}.from`)
  if (interval.to !== undefined) assertInstant(interval.to, `${field}.to`)
  if (
    interval.from !== undefined &&
    interval.to !== undefined &&
    Date.parse(interval.from) >= Date.parse(interval.to)
  ) {
    throw new MemoryError('invalid_input', `${field}.from must be earlier than ${field}.to`)
  }
}

export interface JsonValidationMetrics {
  nodes: number
  stringBytes: number
}

export interface JsonValidationLimits {
  maxNodes?: number
  maxDepth?: number
  maxStringBytes?: number
}

export interface JsonSnapshotLimits extends JsonValidationLimits {
  /** Match JSON object serialization by treating a captured `undefined` property as absent. */
  omitUndefinedObjectProperties?: boolean
}

function* ownEnumerableEntries(value: object): Generator<readonly [string, unknown]> {
  for (const key in value) {
    if (Object.prototype.hasOwnProperty.call(value, key)) yield [key, Reflect.get(value, key)]
  }
}

export function validateJson(
  value: unknown,
  field = 'value',
  limits: JsonValidationLimits = {},
): JsonValidationMetrics {
  const maxNodes = limits.maxNodes ?? MAX_JSON_NODES
  const maxDepth = limits.maxDepth ?? MAX_JSON_DEPTH
  const maxStringBytes = limits.maxStringBytes ?? MAX_JSON_STRING_BYTES
  const ancestors = new Set<object>()
  type Frame =
    | { kind: 'value'; candidate: unknown; path: string; depth: number }
    | { kind: 'array'; candidate: readonly unknown[]; path: string; depth: number; index: number }
    | {
        kind: 'object'
        candidate: object
        path: string
        depth: number
        entries: Generator<readonly [string, unknown]>
      }
    | { kind: 'exit'; candidate: object }
  const stack: Frame[] = [{ kind: 'value', candidate: value, path: field, depth: 0 }]
  let nodes = 0
  let stringBytes = 0
  const encoder = new TextEncoder()
  while (stack.length > 0) {
    const frame = stack.pop()!
    if (frame.kind === 'exit') {
      ancestors.delete(frame.candidate)
      continue
    }
    if (frame.kind === 'array') {
      if (frame.index >= frame.candidate.length) continue
      stack.push({ ...frame, index: frame.index + 1 })
      stack.push({
        kind: 'value',
        candidate: frame.candidate[frame.index],
        path: `${frame.path}[${frame.index}]`,
        depth: frame.depth + 1,
      })
      continue
    }
    if (frame.kind === 'object') {
      const next = frame.entries.next()
      if (next.done) continue
      const [key, item] = next.value
      if (!isWellFormedUnicode(key)) {
        throw new MemoryError('invalid_input', `${frame.path} key must contain well-formed Unicode`)
      }
      stringBytes += encoder.encode(key).byteLength
      if (stringBytes > maxStringBytes) {
        throw new MemoryError(
          'invalid_input',
          `${field} exceeds ${maxStringBytes} UTF-8 string bytes`,
        )
      }
      stack.push(frame)
      stack.push({
        kind: 'value',
        candidate: item,
        path: `${frame.path}.${key}`,
        depth: frame.depth + 1,
      })
      continue
    }
    const { candidate, path, depth } = frame
    nodes += 1
    if (nodes > maxNodes) {
      throw new MemoryError('invalid_input', `${field} exceeds ${maxNodes} JSON nodes`)
    }
    if (depth > maxDepth) {
      throw new MemoryError('invalid_input', `${field} exceeds JSON depth ${maxDepth}`)
    }
    if (
      candidate === null ||
      typeof candidate === 'boolean' ||
      (typeof candidate === 'number' && Number.isFinite(candidate))
    ) {
      continue
    }
    if (typeof candidate === 'string') {
      if (!isWellFormedUnicode(candidate)) {
        throw new MemoryError('invalid_input', `${path} must contain well-formed Unicode`)
      }
      stringBytes += encoder.encode(candidate).byteLength
      if (stringBytes > maxStringBytes) {
        throw new MemoryError(
          'invalid_input',
          `${field} exceeds ${maxStringBytes} UTF-8 string bytes`,
        )
      }
      continue
    }
    if (typeof candidate !== 'object') {
      throw new MemoryError('invalid_input', `${path} must be JSON-round-trippable`)
    }
    if (ancestors.has(candidate)) {
      throw new MemoryError('invalid_input', `${path} contains a cycle`)
    }
    ancestors.add(candidate)
    stack.push({ kind: 'exit', candidate })
    if (Array.isArray(candidate)) {
      stack.push({ kind: 'array', candidate, path, depth, index: 0 })
    } else {
      const prototype = Object.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new MemoryError('invalid_input', `${path} must contain only plain objects`)
      }
      stack.push({
        kind: 'object',
        candidate,
        path,
        depth,
        entries: ownEnumerableEntries(candidate),
      })
    }
  }
  return { nodes, stringBytes }
}

export interface JsonSnapshot extends JsonValidationMetrics {
  value: JsonValue
}

/** Copy and validate a JSON value in one bounded traversal, reading each admitted property once. */
export function snapshotJson(
  value: unknown,
  field = 'value',
  limits: JsonSnapshotLimits = {},
): JsonSnapshot {
  const maxNodes = limits.maxNodes ?? MAX_JSON_NODES
  const maxDepth = limits.maxDepth ?? MAX_JSON_DEPTH
  const maxStringBytes = limits.maxStringBytes ?? MAX_JSON_STRING_BYTES
  const ancestors = new Set<object>()
  const encoder = new TextEncoder()
  let nodes = 0
  let stringBytes = 0

  const omitted = Symbol('omitted JSON object property')
  const visit = (
    candidate: unknown,
    path: string,
    depth: number,
    objectProperty = false,
  ): JsonValue | typeof omitted => {
    nodes += 1
    if (nodes > maxNodes) {
      throw new MemoryError('invalid_input', `${field} exceeds ${maxNodes} JSON nodes`)
    }
    if (depth > maxDepth) {
      throw new MemoryError('invalid_input', `${field} exceeds JSON depth ${maxDepth}`)
    }
    if (
      candidate === undefined &&
      objectProperty &&
      limits.omitUndefinedObjectProperties === true
    ) {
      return omitted
    }
    if (
      candidate === null ||
      typeof candidate === 'boolean' ||
      (typeof candidate === 'number' && Number.isFinite(candidate))
    ) {
      return candidate
    }
    if (typeof candidate === 'string') {
      if (!isWellFormedUnicode(candidate)) {
        throw new MemoryError('invalid_input', `${path} must contain well-formed Unicode`)
      }
      stringBytes += encoder.encode(candidate).byteLength
      if (stringBytes > maxStringBytes) {
        throw new MemoryError(
          'invalid_input',
          `${field} exceeds ${maxStringBytes} UTF-8 string bytes`,
        )
      }
      return candidate
    }
    if (typeof candidate !== 'object') {
      throw new MemoryError('invalid_input', `${path} must be JSON-round-trippable`)
    }
    if (ancestors.has(candidate)) {
      throw new MemoryError('invalid_input', `${path} contains a cycle`)
    }
    ancestors.add(candidate)
    try {
      if (Array.isArray(candidate)) {
        const result: JsonValue[] = []
        const length = candidate.length
        for (let index = 0; index < length; index += 1) {
          const item = visit(Reflect.get(candidate, String(index)), `${path}[${index}]`, depth + 1)
          if (item === omitted) throw new MemoryError('internal', 'array value was omitted')
          result.push(item)
        }
        return result
      }
      const prototype = Object.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new MemoryError('invalid_input', `${path} must contain only plain objects`)
      }
      const result: Record<string, JsonValue> = {}
      for (const [key, item] of ownEnumerableEntries(candidate)) {
        if (!isWellFormedUnicode(key)) {
          throw new MemoryError('invalid_input', `${path} key must contain well-formed Unicode`)
        }
        stringBytes += encoder.encode(key).byteLength
        if (stringBytes > maxStringBytes) {
          throw new MemoryError(
            'invalid_input',
            `${field} exceeds ${maxStringBytes} UTF-8 string bytes`,
          )
        }
        const copied = visit(item, `${path}.${key}`, depth + 1, true)
        if (copied === omitted) continue
        Object.defineProperty(result, key, {
          value: copied,
          enumerable: true,
          configurable: true,
          writable: true,
        })
      }
      return result
    } finally {
      ancestors.delete(candidate)
    }
  }

  try {
    const copied = visit(value, field, 0)
    if (copied === omitted) throw new MemoryError('internal', 'root JSON value was omitted')
    return { value: copied, nodes, stringBytes }
  } catch (error) {
    if (MemoryError.is(error)) throw error
    throw new MemoryError('invalid_input', `${field} could not be snapshotted as JSON`, {
      cause: error,
    })
  }
}

export function assertJson(value: unknown, field = 'value'): asserts value is JsonValue {
  validateJson(value, field)
}

export function assertContent(content: EpisodeContent): void {
  if (typeof content !== 'object' || content === null) {
    throw new MemoryError('invalid_input', 'content must be an episode content object')
  }
  switch (content.type) {
    case 'text':
      assertString(content.text, 'content.text', 2_000_000)
      return
    case 'message':
      assertString(content.text, 'content.text', 2_000_000)
      if (!['user', 'assistant', 'system', 'tool'].includes(content.role)) {
        throw new MemoryError('invalid_input', 'content.role is invalid')
      }
      return
    case 'structured':
      assertJson(content.value, 'content.value')
      return
    case 'event':
      assertString(content.name, 'content.name', 256)
      assertJson(content.value, 'content.value')
      return
    default:
      throw new MemoryError('invalid_input', 'content.type is invalid')
  }
}

const MAX_EVIDENCE_EXCERPT_BYTES = 4_096

export interface ResolvedEpisodeEvidence {
  anchor: EpisodeAnchor
  excerpt: string
  excerptTruncated?: true
}

function contentText(content: EpisodeContent): string | undefined {
  return content.type === 'text' || content.type === 'message' ? content.text : undefined
}

function isUtf16Boundary(value: string, offset: number): boolean {
  if (offset === 0 || offset === value.length) return true
  const before = value.charCodeAt(offset - 1)
  const after = value.charCodeAt(offset)
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff)
}

function assertExactKeys(value: object, allowed: readonly string[], field: string): void {
  const accepted = new Set(allowed)
  const unknown = Object.keys(value).find((key) => !accepted.has(key))
  if (unknown !== undefined) {
    throw new MemoryError('invalid_input', `${field}.${unknown} is not supported`)
  }
}

function resolveJsonPointer(value: JsonValue, pointer: string, field: string): JsonValue {
  if (new TextEncoder().encode(pointer).byteLength > 2_048) {
    throw new MemoryError('invalid_input', `${field}.pointer exceeds 2048 UTF-8 bytes`)
  }
  if (pointer === '') return value
  if (!pointer.startsWith('/')) {
    throw new MemoryError('invalid_input', `${field}.pointer must be an RFC 6901 JSON pointer`)
  }
  let current = value
  for (const encoded of pointer.slice(1).split('/')) {
    if (/~(?![01])/u.test(encoded)) {
      throw new MemoryError('invalid_input', `${field}.pointer contains an invalid escape`)
    }
    const segment = encoded.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        throw new MemoryError('invalid_input', `${field}.pointer has an invalid array index`)
      }
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index >= current.length) {
        throw new MemoryError('invalid_input', `${field}.pointer does not resolve`)
      }
      current = current[index]!
      continue
    }
    if (typeof current !== 'object' || current === null || !Object.hasOwn(current, segment)) {
      throw new MemoryError('invalid_input', `${field}.pointer does not resolve`)
    }
    current = (current as Readonly<Record<string, JsonValue>>)[segment]!
  }
  return current
}

function resolveAnchorValue(
  content: EpisodeContent,
  anchor: EpisodeAnchor,
  field: string,
): { anchor: EpisodeAnchor; value: string; jsonValue?: JsonValue } {
  if (typeof anchor !== 'object' || anchor === null) {
    throw new MemoryError('invalid_input', `${field} must be an episode anchor`)
  }
  if (anchor.kind === 'text') {
    assertExactKeys(anchor, ['kind', 'unit', 'start', 'end'], field)
    const text = contentText(content)
    if (text === undefined) {
      throw new MemoryError(
        'invalid_input',
        `${field} text anchors require text or message content`,
      )
    }
    if (anchor.unit !== 'utf16-code-unit') {
      throw new MemoryError('invalid_input', `${field}.unit must be utf16-code-unit`)
    }
    if (
      !Number.isInteger(anchor.start) ||
      !Number.isInteger(anchor.end) ||
      anchor.start < 0 ||
      anchor.end <= anchor.start ||
      anchor.end > text.length ||
      !isUtf16Boundary(text, anchor.start) ||
      !isUtf16Boundary(text, anchor.end)
    ) {
      throw new MemoryError(
        'invalid_input',
        `${field} must be a non-empty in-bounds UTF-16 range on scalar boundaries`,
      )
    }
    return {
      anchor: {
        kind: 'text',
        unit: 'utf16-code-unit',
        start: anchor.start,
        end: anchor.end,
      },
      value: text.slice(anchor.start, anchor.end),
    }
  }
  if (anchor.kind === 'json-pointer') {
    assertExactKeys(anchor, ['kind', 'pointer'], field)
    if (content.type !== 'structured' && content.type !== 'event') {
      throw new MemoryError(
        'invalid_input',
        `${field} JSON pointers require structured or event content`,
      )
    }
    if (typeof anchor.pointer !== 'string') {
      throw new MemoryError('invalid_input', `${field}.pointer must be a string`)
    }
    const jsonValue = resolveJsonPointer(content.value, anchor.pointer, field)
    return {
      anchor: { kind: 'json-pointer', pointer: anchor.pointer },
      value: stableStringify(jsonValue),
      jsonValue,
    }
  }
  throw new MemoryError('invalid_input', `${field}.kind is invalid`)
}

function truncateUtf8(value: string, maximum: number): { value: string; truncated: boolean } {
  const encoder = new TextEncoder()
  if (encoder.encode(value).byteLength <= maximum) return { value, truncated: false }
  let end = Math.min(value.length, maximum)
  while (end > 0) {
    if (!isUtf16Boundary(value, end)) {
      end -= 1
      continue
    }
    const candidate = value.slice(0, end)
    if (encoder.encode(candidate).byteLength <= maximum) {
      return { value: candidate, truncated: true }
    }
    end -= 1
  }
  return { value: '', truncated: true }
}

function uniqueTextAnchor(text: string, excerpt: string): EpisodeAnchor {
  const first = text.indexOf(excerpt)
  const second = first < 0 ? -1 : text.indexOf(excerpt, first + 1)
  if (
    first < 0 ||
    second >= 0 ||
    !isUtf16Boundary(text, first) ||
    !isUtf16Boundary(text, first + excerpt.length)
  ) {
    throw new MemoryError(
      'invalid_input',
      'an unanchored excerpt must occur exactly once on UTF-16 scalar boundaries',
    )
  }
  return {
    kind: 'text',
    unit: 'utf16-code-unit',
    start: first,
    end: first + excerpt.length,
  }
}

/** Resolve and verify a citation against immutable normalized episode content. */
export function resolveEpisodeEvidence(
  content: EpisodeContent,
  input: EpisodeEvidenceInput | undefined,
  field = 'evidence',
): ResolvedEpisodeEvidence {
  if (input !== undefined && (typeof input !== 'object' || input === null)) {
    throw new MemoryError('invalid_input', `${field} must be an object`)
  }
  if (input !== undefined) assertExactKeys(input, ['anchor', 'excerpt'], field)
  if (input?.excerpt !== undefined) {
    assertString(input.excerpt, `${field}.excerpt`, MAX_EVIDENCE_EXCERPT_BYTES)
  }

  let anchor = input?.anchor
  if (anchor === undefined && input?.excerpt !== undefined) {
    const text = contentText(content)
    if (text === undefined) {
      throw new MemoryError(
        'invalid_input',
        `${field}.anchor is required for structured or event excerpts`,
      )
    }
    anchor = uniqueTextAnchor(text, input.excerpt)
  }
  if (anchor === undefined) {
    const text = contentText(content)
    anchor =
      text === undefined
        ? { kind: 'json-pointer', pointer: '' }
        : { kind: 'text', unit: 'utf16-code-unit', start: 0, end: text.length }
  }

  const resolved = resolveAnchorValue(content, anchor, `${field}.anchor`)
  if (input?.excerpt !== undefined && input.excerpt !== resolved.value) {
    throw new MemoryError('invalid_input', `${field}.excerpt does not match its episode anchor`)
  }
  const excerpt = truncateUtf8(resolved.value, MAX_EVIDENCE_EXCERPT_BYTES)
  return {
    anchor: resolved.anchor,
    excerpt: excerpt.value,
    ...(excerpt.truncated ? { excerptTruncated: true } : {}),
  }
}

/** Resolve one literal entity mention; a fallback name is optional and never guessed if ambiguous. */
export function resolveEntityMention(
  content: EpisodeContent,
  input: EntityMentionInput | undefined,
  fallbackName?: string,
  field = 'mention',
): { text: string; anchor: EpisodeAnchor } | null {
  if (input !== undefined) {
    if (typeof input !== 'object' || input === null) {
      throw new MemoryError('invalid_input', `${field} must be an object`)
    }
    assertExactKeys(input, ['text', 'anchor'], field)
    assertString(input.text, `${field}.text`, MAX_EVIDENCE_EXCERPT_BYTES)
  }
  const text = input?.text ?? fallbackName
  if (text === undefined) return null
  if (input === undefined) assertString(text, `${field}.text`, MAX_EVIDENCE_EXCERPT_BYTES)
  if (input?.anchor !== undefined) {
    const resolved = resolveAnchorValue(content, input.anchor, `${field}.anchor`)
    const selected = resolved.jsonValue === undefined ? resolved.value : resolved.jsonValue
    if (selected !== text) {
      throw new MemoryError('invalid_input', `${field}.text does not match its episode anchor`)
    }
    return { text, anchor: resolved.anchor }
  }
  const source = contentText(content)
  if (source === undefined) {
    if (input === undefined) return null
    throw new MemoryError('invalid_input', `${field}.anchor is required for structured content`)
  }
  try {
    return { text, anchor: uniqueTextAnchor(source, text) }
  } catch (error) {
    if (input === undefined && MemoryError.is(error, 'invalid_input')) return null
    throw error
  }
}

export function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().replaceAll(/\s+/g, ' ').toLocaleLowerCase('en-US')
}

export function normalizeScopes(scopes: readonly string[] | undefined): string[] {
  const values = [...new Set(scopes ?? [])]
  for (const [index, value] of values.entries()) assertString(value, `scopes[${index}]`, 128)
  return values.sort()
}

export function isVisible(scopes: readonly string[], access: AccessContext): boolean {
  const allowed = new Set(access.allowedScopes)
  return scopes.every((scope) => allowed.has(scope))
}

export function assertAccess(access: AccessContext): void {
  if (typeof access !== 'object' || access === null || Array.isArray(access)) {
    throw new MemoryError('invalid_input', 'access.allowedScopes is required')
  }
  if (Object.keys(access).some((key) => key !== 'allowedScopes')) {
    throw new MemoryError('invalid_input', 'access contains an unsupported field')
  }
  if (!Array.isArray(access.allowedScopes)) {
    throw new MemoryError('invalid_input', 'access.allowedScopes is required')
  }
  normalizeScopes(access.allowedScopes)
}

function stable(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(stable)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareUnicode(left, right))
      .map(([key, item]) => [key, stable(item)]),
  )
}

export function stableStringify(value: JsonValue): string {
  return JSON.stringify(stable(value))
}

export async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value)
}

export function intervalContains(interval: TimeInterval | undefined, instant: string): boolean {
  const time = Date.parse(instant)
  if (interval?.from !== undefined && time < Date.parse(interval.from)) return false
  if (interval?.to !== undefined && time >= Date.parse(interval.to)) return false
  return true
}

export function intervalsEqual(
  left: TimeInterval | undefined,
  right: TimeInterval | undefined,
): boolean {
  return left?.from === right?.from && left?.to === right?.to
}

export function intervalsOverlap(
  left: TimeInterval | undefined,
  right: TimeInterval | undefined,
): boolean {
  const leftStart = left?.from === undefined ? Number.NEGATIVE_INFINITY : Date.parse(left.from)
  const leftEnd = left?.to === undefined ? Number.POSITIVE_INFINITY : Date.parse(left.to)
  const rightStart = right?.from === undefined ? Number.NEGATIVE_INFINITY : Date.parse(right.from)
  const rightEnd = right?.to === undefined ? Number.POSITIVE_INFINITY : Date.parse(right.to)
  return leftStart < rightEnd && rightStart < leftEnd
}

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    if (MemoryError.is(signal.reason)) throw signal.reason
    throw new MemoryError('cancelled', 'operation was cancelled', { retryable: false })
  }
}
