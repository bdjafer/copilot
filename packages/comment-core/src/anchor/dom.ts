/**
 * Tiny DOM helpers shared by capture, fingerprinting, scoring and the strategies.
 *
 * Two rules hold everywhere in this file:
 *  1. **No `instanceof`.** A content script, an IIFE bundle and a happy-dom fixture can all be
 *     handed nodes from another realm, where `node instanceof Range` is false for a real Range.
 *     Everything here duck-types on the properties the DOM spec guarantees.
 *  2. **Nothing throws.** `captureTarget` is documented as "never throws: a detached node
 *     yields a low-signal descriptor" (§2.5), and it is built out of these.
 */

import type { DocumentRect } from '../types.ts'

/** Node.ELEMENT_NODE, spelled out so no global `Node` is needed. */
const ELEMENT_NODE = 1
const TEXT_NODE = 3
/** NodeFilter.SHOW_TEXT, likewise. */
const SHOW_TEXT = 4

export function isElement(value: unknown): value is Element {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Node).nodeType === ELEMENT_NODE &&
    typeof (value as Element).tagName === 'string'
  )
}

export function isTextNode(value: unknown): value is Text {
  return typeof value === 'object' && value !== null && (value as Node).nodeType === TEXT_NODE
}

/** A `Range` is the one target shape with a `commonAncestorContainer`. */
export function isRange(value: unknown): value is Range {
  return (
    typeof value === 'object' &&
    value !== null &&
    'commonAncestorContainer' in (value as object) &&
    'startContainer' in (value as object)
  )
}

/** A `Selection` is the one shape with `getRangeAt` + `rangeCount`. */
export function isSelection(value: unknown): value is Selection {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Selection).getRangeAt === 'function' &&
    typeof (value as Selection).rangeCount === 'number'
  )
}

/** The nearest element for any node: itself when it is one, else its parent element. */
export function elementOfNode(node: Node | null | undefined): Element | null {
  let current: Node | null = node ?? null
  while (current && !isElement(current)) current = current.parentNode
  return isElement(current) ? current : null
}

/** The element a target is anchored to: the element itself, or a range's common ancestor. */
export function elementOf(target: Element | Range): Element | null {
  if (isRange(target)) return elementOfNode(target.commonAncestorContainer)
  return isElement(target) ? target : null
}

export function ownerDocumentOf(target: Element | Range | null | undefined): Document | null {
  if (!target) return null
  const element = elementOf(target)
  return element?.ownerDocument ?? (isRange(target) ? nodeDocument(target.startContainer) : null)
}

function nodeDocument(node: Node | null): Document | null {
  return node?.ownerDocument ?? null
}

/** `target.closest()` that also works for a Range (§2.5 `DescribeContext`). */
export function closestOf(target: Element | Range, selector: string): Element | null {
  const element = elementOf(target)
  if (!element) return null
  try {
    return element.closest(selector)
  } catch {
    return null // an invalid selector is a caller bug, not a reason to lose the capture
  }
}

/** Whitespace-collapsed, trimmed text. The one normalization every text comparison uses. */
export function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim()
}

/**
 * Document-space rect (§2.3): viewport rect plus the current scroll offsets, so it stays
 * meaningful after the page scrolls. Returns null for a detached element.
 */
export function documentRect(element: Element): DocumentRect | null {
  try {
    const rect = element.getBoundingClientRect()
    const view = element.ownerDocument?.defaultView
    const scrollX = view?.scrollX ?? 0
    const scrollY = view?.scrollY ?? 0
    return {
      top: rect.top + scrollY,
      left: rect.left + scrollX,
      width: rect.width,
      height: rect.height,
    }
  } catch {
    return null
  }
}

export function sameRect(a: DocumentRect | null, b: DocumentRect | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height
}

/** `root.contains(node)` without requiring `root` to be typed as a `Node`. */
export function rootContains(root: ParentNode, node: Node): boolean {
  const container = root as unknown as { contains?: (other: Node) => boolean }
  if (typeof container.contains !== 'function') return true
  try {
    return container.contains(node)
  } catch {
    return false
  }
}

/**
 * `root.querySelectorAll(selector)` **plus the root itself when it matches**.
 *
 * `querySelectorAll` only ever returns descendants, so on the scoped retry path of §4.6.5 —
 * where `root` IS the node the MutationObserver just reported as added — the added element
 * could never be its own match, and only `nthPath` (which falls back to the document) would
 * ever re-anchor it. Including a matching root is what makes "retried scoped to the added
 * subtrees" mean the subtrees rather than their interiors.
 */
export function queryWithin(root: ParentNode, selector: string): Element[] {
  const out: Element[] = []
  try {
    if (isElement(root) && root.matches(selector)) out.push(root)
  } catch {
    return [] // an invalid selector cannot match anything
  }
  try {
    for (const element of Array.from(root.querySelectorAll(selector))) out.push(element)
  } catch {
    // A selector that was valid when written can be invalid for another parser.
  }
  return out
}

/** Every text node under `root`, in document order. */
export function textNodesOf(root: Node): Text[] {
  const doc = root.ownerDocument ?? (root as Document)
  if (typeof doc?.createTreeWalker !== 'function') return []
  const walker = doc.createTreeWalker(root, SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (isTextNode(node)) nodes.push(node)
  }
  return nodes
}

/** The element a `ParentNode` root should be text-scanned from. */
export function textRootOf(root: ParentNode, doc: Document): Node {
  const asDocument = root as Partial<Document>
  if (asDocument.body) return asDocument.body
  if (asDocument.documentElement) return asDocument.documentElement
  if (isElement(root)) return root
  return doc.body ?? doc.documentElement ?? doc
}
