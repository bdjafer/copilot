/**
 * `fingerprintElement` (§2.5) — the verification signal every candidate is checked against
 * (§4.6.2). A selector says *where* to look; the fingerprint says *whether what was found is
 * still the same thing*, which is what stops a stale-but-valid CSS path silently attaching to
 * the wrong element.
 *
 * Class filtering is finder v4's own `className` heuristic **and** a corroboration test
 * (§2.5, decision log #28): word-like rejects `p-4`, `_3xKq`, `sc-bdVaJa`; corroboration — the
 * class must be carried by more than one element in the document — rejects the per-render
 * random hash that happens to come out word-like. The bench measured `css-<base36×6>` passing
 * word-like **5.8 %** of the time, which is one render in seventeen leaking a class that is
 * gone by the next one; the same coin flip on the resolve side is what made `attribute-churn`
 * score 2/6–5/6 across four runs (bench F4). A per-render hash is unique in the document by
 * construction, so "seen twice" is the cheapest signal that separates it from `card`.
 */

import { className as finderClassName } from '@medv/finder'

import type { ElementFingerprint } from '../types.ts'

import { normalizeText, ownerDocumentOf } from './dom.ts'

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

/** Word-like: finder v4's own heuristic. Necessary for a stable class, never sufficient. */
export function isWordLikeClass(className: string): boolean {
  try {
    return finderClassName(className)
  } catch {
    return false
  }
}

/**
 * Default class filter (§2.5): word-like **and** corroborated by a second element.
 *
 * Without a document there is nothing to corroborate against, so the filter degrades to the
 * word-like half — that keeps `fingerprintElement` working on a detached node, which §2.5
 * requires ("never throws: a detached node yields a low-signal descriptor").
 */
export function isStableClass(className: string, document?: Document | null): boolean {
  if (!isWordLikeClass(className)) return false
  if (!document) return true
  return classFrequency(document, className) > 1
}

/** How many elements in `document` carry this class, capped at 2 (all callers ask 0/1/many). */
function classFrequency(document: Document, className: string): number {
  try {
    // `getElementsByClassName` takes a bare class name — no selector escaping to get wrong.
    return Math.min(2, document.getElementsByClassName(className).length)
  } catch {
    return 2 // an unanswerable question must not silently delete evidence
  }
}

/** The class filter `fingerprintElement` uses when the caller supplies none. */
export function stableClassFilter(document: Document | null | undefined) {
  return (className: string): boolean => isStableClass(className, document)
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
  const classFilter = options?.classFilter ?? stableClassFilter(ownerDocumentOf(element))
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

/**
 * The **raw** class list of a live element.
 *
 * Deliberately unfiltered: `scoreCandidate` compares by coverage of the stored (already vetted)
 * class set, so an extra per-render class on the live element is simply not looked at, instead
 * of shrinking a symmetric Jaccard the way it did before (bench F4).
 */
export function classListOf(element: Element): string[] {
  try {
    return Array.from(element.classList ?? [])
  } catch {
    return []
  }
}
