/**
 * `captureElement` (§2.5) — the sanitized, truncated snapshot a Thread carries so an orphaned
 * comment can still say what it was about.
 *
 * Everything here is defensive: `captureTarget` is documented as never throwing, and a capture
 * of a detached node is a low-signal capture, not a failure.
 */

import { finder } from '@medv/finder'

import type { ElementCapture } from '../types.ts'
import type { CaptureOptions } from './types.ts'

import { elementOf, isRange, normalizeText, ownerDocumentOf } from './dom.ts'

/** §2.5 defaults. */
export const DEFAULT_HTML_LIMIT = 8192
export const DEFAULT_TEXT_LIMIT = 2000

const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/giu
const OPEN_SCRIPT_RE = /<\/?script\b[^>]*>/giu
const ON_ATTR_RE = /\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu
const JS_URL_RE =
  /((?:href|src|xlink:href|action|formaction)\s*=\s*)(["']?)\s*javascript:[^"'>\s]*/giu

/**
 * Built-in sanitizer: strips `<script>`, `on*` handler attributes and `javascript:` URLs.
 * String-in / string-out, because §2.5's `sanitize` seam is `(html: string) => string` — the
 * capture is persisted and re-rendered by a host that may not have a DOM at all.
 */
export function sanitizeHtml(html: string): string {
  return html
    .replace(SCRIPT_RE, '')
    .replace(OPEN_SCRIPT_RE, '')
    .replace(ON_ATTR_RE, '')
    .replace(JS_URL_RE, '$1$2about:blank')
}

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null

/** UTF-8 byte length, so `htmlLimit` means bytes on disk rather than UTF-16 code units. */
export function byteLength(value: string): number {
  if (encoder) return encoder.encode(value).length
  let bytes = 0
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/** Truncate to at most `limit` UTF-8 bytes, never splitting a code point. */
export function truncateBytes(value: string, limit: number): string {
  if (limit <= 0) return ''
  if (byteLength(value) <= limit) return value
  let out = ''
  let bytes = 0
  for (const char of value) {
    const size = byteLength(char)
    if (bytes + size > limit) break
    out += char
    bytes += size
  }
  return out
}

function cssPathOf(element: Element, doc: Document): string {
  try {
    const root = doc.body ?? doc.documentElement
    return root ? finder(element, { root }) : ''
  } catch {
    // finder throws on a detached node, on a timeout, and when no unique selector exists.
    return fallbackPath(element)
  }
}

/** Last-resort structural path, also the `nthPath` strategy's shape. */
export function fallbackPath(element: Element): string {
  const parts: string[] = []
  let current: Element | null = element
  while (current && current.tagName) {
    const tag = current.tagName.toLowerCase()
    const parent: Element | null = current.parentElement
    if (!parent) {
      parts.unshift(tag)
      break
    }
    const index = Array.prototype.indexOf.call(parent.children, current) + 1
    parts.unshift(`${tag}:nth-child(${index})`)
    current = parent
  }
  return parts.join(' > ')
}

/** Sanitized, truncated snapshot of an element or range. */
export function captureElement(target: Element | Range, options?: CaptureOptions): ElementCapture {
  const now = options?.now ?? (() => new Date())
  const capturedAt = now().toISOString()
  const htmlLimit = options?.htmlLimit ?? DEFAULT_HTML_LIMIT
  const textLimit = options?.textLimit ?? DEFAULT_TEXT_LIMIT
  const sanitize = options?.sanitize ?? sanitizeHtml

  const doc = options?.document ?? ownerDocumentOf(target) ?? undefined
  const element = elementOf(target)

  let outerHTML = ''
  try {
    outerHTML = element?.outerHTML ?? ''
  } catch {
    outerHTML = ''
  }
  try {
    outerHTML = sanitize(outerHTML)
  } catch {
    // A host sanitizer that throws must not cost the whole capture.
    outerHTML = ''
  }

  let text = ''
  try {
    text = normalizeText(element?.textContent)
  } catch {
    text = ''
  }

  const capture: ElementCapture = {
    outerHTML: truncateBytes(outerHTML, htmlLimit),
    text: text.slice(0, textLimit),
    cssPath: element && doc ? cssPathOf(element, doc) : element ? fallbackPath(element) : '',
    page: {
      url: pageUrl(doc),
      title: safeTitle(doc),
    },
    capturedAt,
  }

  if (isRange(target)) {
    let selectionText = ''
    try {
      selectionText = normalizeText(target.toString())
    } catch {
      selectionText = ''
    }
    capture.selectionText = selectionText.slice(0, textLimit)
  }

  if (!options?.redact) return capture
  try {
    return options.redact(capture)
  } catch {
    // §2.5: redact is "last chance to strip PII". If it throws we must not persist the
    // un-redacted capture, so the text-bearing fields are dropped instead.
    return { ...capture, outerHTML: '', text: '', selectionText: undefined }
  }
}

function pageUrl(doc: Document | undefined): string {
  try {
    return doc?.defaultView?.location?.href ?? doc?.URL ?? ''
  } catch {
    return ''
  }
}

function safeTitle(doc: Document | undefined): string {
  try {
    return doc?.title ?? ''
  } catch {
    return ''
  }
}
