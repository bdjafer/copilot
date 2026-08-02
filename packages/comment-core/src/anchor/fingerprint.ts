/**
 * `fingerprintElement` (§2.5) — the verification signal every candidate is checked against
 * (§4.6.2). A selector says *where* to look; the fingerprint says *whether what was found is
 * still the same thing*, which is what stops a stale-but-valid CSS path silently attaching to
 * the wrong element.
 *
 * Class filtering uses finder v4's own `className` heuristic (§2.5: "Filters hashed/utility
 * class names (finder v4 heuristics)"), which rejects anything that is not word-like —
 * `css-1a2b3c`, `sc-bdVaJa`, `p-4`, `_3xKq` — and keeps `card`, `article-body`, `sidebar`.
 */

import { className as finderClassName } from '@medv/finder'

import type { ElementFingerprint } from '../types.ts'

import { normalizeText } from './dom.ts'

/**
 * Semantic attributes worth remembering, in the order they are written. `data-*` is admitted
 * wholesale below — it is the one namespace an app owns deliberately.
 */
const SEMANTIC_ATTRS: readonly string[] = [
  'role',
  'name',
  'type',
  'href',
  'rel',
  'alt',
  'title',
  'placeholder',
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
]

/** Cap on how much evidence one fingerprint carries. Keeps a Thread record small. */
const MAX_ATTRS = 12
const MAX_ATTR_VALUE = 100

/**
 * `textDigest` is a **lossy normalized prefix**, not a cryptographic hash: whitespace-collapsed,
 * lowercased, capped. §2.5 leaves the format open, and a hash would only ever answer
 * "identical?", while `scoreCandidate` needs "how close?" for a paragraph whose wording moved.
 */
const MAX_DIGEST = 160

export function textDigestOf(element: Element): string {
  return normalizeText(element.textContent).toLowerCase().slice(0, MAX_DIGEST)
}

/** Default class filter: finder v4's word-like heuristic. */
export function isStableClass(className: string): boolean {
  try {
    return finderClassName(className)
  } catch {
    return false
  }
}

function attrsOf(element: Element): Record<string, string> {
  const out: Record<string, string> = {}
  const push = (name: string, value: string | null): void => {
    if (value === null || value === '' || value.length > MAX_ATTR_VALUE) return
    if (Object.keys(out).length >= MAX_ATTRS) return
    out[name] = value
  }

  for (const name of SEMANTIC_ATTRS) push(name, safeAttr(element, name))
  // `data-*` last so the semantic allowlist always survives the MAX_ATTRS cap.
  for (const name of attributeNames(element)) {
    if (name.startsWith('data-')) push(name, safeAttr(element, name))
  }
  return out
}

function safeAttr(element: Element, name: string): string | null {
  try {
    return element.getAttribute(name)
  } catch {
    return null
  }
}

function attributeNames(element: Element): string[] {
  try {
    if (typeof element.getAttributeNames === 'function') return element.getAttributeNames().sort()
    return []
  } catch {
    return []
  }
}

/** Build a fingerprint. Filters hashed/utility class names (finder v4 heuristics). */
export function fingerprintElement(
  element: Element,
  options?: { classFilter?: (className: string) => boolean },
): ElementFingerprint {
  const classFilter = options?.classFilter ?? isStableClass
  const tag = (element.tagName ?? '').toLowerCase()

  const stableClasses: string[] = []
  try {
    for (const name of Array.from(element.classList ?? [])) {
      if (classFilter(name)) stableClasses.push(name)
    }
  } catch {
    // A node with no classList (or a hostile one) simply contributes no class evidence.
  }
  stableClasses.sort()

  const fingerprint: ElementFingerprint = {
    tag,
    stableClasses,
    attrs: attrsOf(element),
    textDigest: textDigestOf(element),
  }

  const id = safeAttr(element, 'id')
  if (id) fingerprint.id = id

  // A detached element measures 0×0 everywhere, which is noise rather than a hint.
  try {
    const rect = element.getBoundingClientRect?.()
    if (rect && (rect.width > 0 || rect.height > 0)) {
      fingerprint.rectHint = { w: Math.round(rect.width), h: Math.round(rect.height) }
    }
  } catch {
    // No layout (happy-dom, a detached node) — the structural component is simply absent.
  }

  return fingerprint
}

/** The class list of a live element, filtered the same way a fingerprint's was. */
export function stableClassesOf(
  element: Element,
  classFilter: (className: string) => boolean = isStableClass,
): string[] {
  try {
    return Array.from(element.classList ?? []).filter(classFilter)
  } catch {
    return []
  }
}
