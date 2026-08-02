/**
 * `scoreCandidate` (§2.5) — fingerprint similarity, 0..1.
 *
 * §2.5 fixes two things and leaves the arithmetic open: **tag mismatch ⇒ 0**, and the weight
 * ordering **semantics > classes > structure > text**. The weights below are the smallest
 * assignment satisfying that ordering; they are normalized over the components the fingerprint
 * actually carries, so an element whose only evidence is its text is scored on its text alone
 * rather than being dragged to 0.3 by four vacuous components.
 *
 * This runs on **every** candidate from **every** strategy (§4.6.2) — Hypothesis's
 * `maybeAssertQuote` discipline as a property of the pipeline, not a per-strategy opt-in.
 */

import type { ElementFingerprint } from '../types.ts'

import { isStableClass, stableClassesOf, textDigestOf } from './fingerprint.ts'

/** semantics > classes > structure > text. Renormalized over the present components. */
const WEIGHTS = {
  id: 0.2,
  attrs: 0.3,
  classes: 0.22,
  structure: 0.16,
  text: 0.12,
} as const

function tokens(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 0)
}

/**
 * Text similarity over the normalized digests: exact match, then containment (a paragraph that
 * grew a sentence is still that paragraph), then token overlap.
 */
export function textSimilarity(a: string, b: string): number {
  if (a === b) return 1
  if (a === '' || b === '') return 0
  if (a.includes(b) || b.includes(a)) return 0.9

  const left = new Set(tokens(a))
  const right = new Set(tokens(b))
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return shared / (left.size + right.size - shared)
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  const left = new Set(a)
  const right = new Set(b)
  let shared = 0
  for (const value of left) if (right.has(value)) shared++
  const union = left.size + right.size - shared
  return union === 0 ? 1 : shared / union
}

function attrScore(element: Element, attrs: Record<string, string>): number {
  const names = Object.keys(attrs)
  if (names.length === 0) return 1
  let matched = 0
  for (const name of names) {
    let live: string | null = null
    try {
      live = element.getAttribute(name)
    } catch {
      live = null
    }
    if (live === attrs[name]) matched += 1
    else if (live !== null) matched += 0.25 // present but changed beats gone entirely
  }
  return matched / names.length
}

function rectScore(element: Element, hint: { w: number; h: number }): number {
  let rect: { width: number; height: number } | undefined
  try {
    rect = element.getBoundingClientRect?.()
  } catch {
    rect = undefined
  }
  if (!rect || (rect.width === 0 && rect.height === 0)) return 0.5 // unmeasurable ⇒ neutral
  const dw = Math.abs(rect.width - hint.w) / Math.max(hint.w, 1)
  const dh = Math.abs(rect.height - hint.h) / Math.max(hint.h, 1)
  return Math.max(0, 1 - (Math.min(dw, 2) + Math.min(dh, 2)) / 4)
}

/**
 * The score a fingerprint carrying **no** distinguishing evidence — no id, no attrs, no stable
 * classes, no rect hint and an empty text digest — can earn from a same-tag element.
 *
 * It must stay below the default `threshold` (0.62). Renormalizing over the *present*
 * components otherwise lets such a fingerprint score a perfect 1.0 against an arbitrary
 * same-tag element (`textSimilarity('', '') === 1` over a single present component), which is
 * the exact "attach to anything" case §4.6.2/.3 forbid — and `captureTarget` on a detached node
 * produces precisely that empty fingerprint.
 */
const TAG_ONLY_SCORE = 0.25

function signalCount(fingerprint: ElementFingerprint): number {
  return (
    (fingerprint.id !== undefined ? 1 : 0) +
    (Object.keys(fingerprint.attrs).length > 0 ? 1 : 0) +
    (fingerprint.stableClasses.length > 0 ? 1 : 0) +
    (fingerprint.rectHint ? 1 : 0) +
    (fingerprint.textDigest !== '' ? 1 : 0)
  )
}

/** Fingerprint similarity, 0..1. Tag mismatch ⇒ 0. Semantics > classes > structure > text. */
export function scoreCandidate(element: Element, fingerprint: ElementFingerprint): number {
  const tag = (element.tagName ?? '').toLowerCase()
  if (!tag || tag !== fingerprint.tag) return 0

  // §4.6.2/.3: the pipeline "never guesses". A fingerprint with nothing but a tag name can only
  // ever assert "some <div>", so it is capped below threshold instead of being renormalized to
  // certainty over the one vacuous component it does carry.
  if (signalCount(fingerprint) === 0) {
    return textDigestOf(element) === '' ? TAG_ONLY_SCORE : 0
  }

  let total = 0
  let weight = 0
  const add = (w: number, value: number): void => {
    total += w * value
    weight += w
  }

  if (fingerprint.id !== undefined) {
    let live: string | null = null
    try {
      live = element.getAttribute('id')
    } catch {
      live = null
    }
    add(WEIGHTS.id, live === fingerprint.id ? 1 : 0)
  }
  if (Object.keys(fingerprint.attrs).length > 0) {
    add(WEIGHTS.attrs, attrScore(element, fingerprint.attrs))
  }
  if (fingerprint.stableClasses.length > 0) {
    add(
      WEIGHTS.classes,
      jaccard(fingerprint.stableClasses, stableClassesOf(element, isStableClass)),
    )
  }
  if (fingerprint.rectHint) {
    add(WEIGHTS.structure, rectScore(element, fingerprint.rectHint))
  }
  // Text is always present: an empty digest matching an empty element is real evidence, and it
  // guarantees `weight > 0` so the normalization below can never divide by zero.
  add(WEIGHTS.text, textSimilarity(fingerprint.textDigest, textDigestOf(element)))

  return weight === 0 ? 0 : Math.min(1, Math.max(0, total / weight))
}
