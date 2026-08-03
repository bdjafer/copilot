/**
 * `scoreCandidate` (§2.5) — fingerprint similarity, 0..1.
 *
 * §2.5 fixes two things and leaves the arithmetic open: **tag mismatch ⇒ 0**, and the weight
 * ordering **semantics > classes > structure > text**. The weights below are the smallest
 * assignment satisfying that ordering; they are normalized over the components the fingerprint
 * actually carries, so an element whose only evidence is its text is scored on its text alone
 * rather than being dragged to 0.3 by four vacuous components.
 *
 * Two rules on top of the weighted average, both from the real-browser bench (decision log #26
 * and #27), and both about what a component's *mismatch* actually proves:
 *
 *  - **The text digest is the final verifier, not a fifth contribution.** A candidate that no
 *    live identity signal confirms must be corroborated by what the element *says*; below
 *    `TEXT_VERIFY_MIN` it is refused outright. Without this the identity-free components — a
 *    class list and a box size, which every card in a templated feed shares — supplied 0.38 of
 *    the 0.50 available weight and carried a *different* post to 0.946 (bench F2).
 *  - **Evidence the document no longer contains is absent, not contradicted.** A stored `id` or
 *    attribute value that matches nothing anywhere in the document was regenerated wholesale;
 *    it can no longer tell two elements apart, so it is scored as "no information" (0.5) rather
 *    than as a mismatch. Without this a framework re-render that rewrote four bookkeeping
 *    attributes dropped a byte-identical paragraph to 0.575 and orphaned it (bench F3).
 *
 * The two compose: when identity has been regenerated there is no live identity signal left, so
 * the text verifier is what decides — which is the only honest reading of that state.
 *
 * This runs on **every** candidate from **every** strategy (§4.6.2) — Hypothesis's
 * `maybeAssertQuote` discipline as a property of the pipeline, not a per-strategy opt-in.
 */

import type { ElementFingerprint } from '../types.ts'

import { classListOf, textDigestOf } from './fingerprint.ts'

/** semantics > classes > structure > text. Renormalized over the present components. */
const WEIGHTS = {
  id: 0.2,
  attrs: 0.3,
  classes: 0.22,
  structure: 0.16,
  text: 0.12,
} as const

/**
 * What a candidate's text must score for a match nothing else confirms to be accepted.
 *
 * `textSimilarity` returns 1 for an exact digest and 0.9 for containment (a paragraph that grew
 * a sentence is still that paragraph), so this admits both, plus token sets that differ by less
 * than roughly one token in twenty. It refuses the shape that produced bench F2: two rows of the
 * same template whose numbers differ, sharing 15 of 17 tokens (0.882).
 */
export const TEXT_VERIFY_MIN = 0.9

/** A stored identity value that matches nothing in the document: no information, not a miss. */
const STALE_EVIDENCE = 0.5

/** Present but changed, while the stored value still identifies something else in the document. */
const CHANGED_ATTR = 0.25

/**
 * How many identity lookups one resolve may spend. Each is a document-wide `querySelectorAll`,
 * paid once per stored value (not per candidate) and shared by every candidate in the run, so
 * the cap only ever bites a fingerprint carrying more than eight attributes.
 */
const IDENTITY_QUERY_BUDGET = 8

/** Result of asking the document how many elements still carry a stored identity value. */
const UNKNOWN = -1

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

/**
 * Coverage of the stored class set, **not** a symmetric Jaccard.
 *
 * The stored set was already vetted at capture time (word-like + corroborated), so the question
 * at resolve time is only "does this candidate still carry those classes?". Extra classes on the
 * live element — a per-render hash, a `selected`/`is-open` state class — are noise the score
 * must not be paid for; penalizing them is what made a class churn orphan a live thread.
 */
function classCoverage(stored: readonly string[], live: readonly string[]): number {
  if (stored.length === 0) return 1
  const present = new Set(live)
  let shared = 0
  for (const name of new Set(stored)) if (present.has(name)) shared++
  return shared / new Set(stored).size
}

function safeAttr(element: Element, name: string): string | null {
  try {
    return element.getAttribute(name)
  } catch {
    return null
  }
}

/**
 * How many elements still carry a stored identity value: `0` (regenerated / gone), `1` (still
 * identifies exactly one element ⇒ discriminating) or `2` meaning "many" (shared boilerplate
 * like `role="listitem"`, which confirms nothing about *which* element this is). `UNKNOWN` when
 * the question could not be asked.
 *
 * Lives outside `scoreCandidate` because the answer depends on the *fingerprint and document*,
 * never on the candidate: one lookup per stored value serves every candidate in a resolve.
 */
export interface EvidenceIndex {
  identifies(name: string, value: string): number
}

const ATTR_NAME_RE = /^[A-Za-z_:][-A-Za-z0-9_:.]*$/u

function escapeValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
}

export function createEvidenceIndex(document: Document | null | undefined): EvidenceIndex {
  const memo = new Map<string, number>()
  let spent = 0

  return {
    identifies(name, value) {
      if (!document || value === '') return UNKNOWN
      const key = `${name}\0${value}`
      const cached = memo.get(key)
      if (cached !== undefined) return cached

      let count = UNKNOWN
      try {
        if (name === 'id') {
          // O(1), and duplicate ids are invalid HTML — so "found" always means exactly one.
          count = document.getElementById(value) ? 1 : 0
        } else if (spent < IDENTITY_QUERY_BUDGET && ATTR_NAME_RE.test(name)) {
          spent += 1
          count = Math.min(2, document.querySelectorAll(`[${name}="${escapeValue(value)}"]`).length)
        }
      } catch {
        count = UNKNOWN
      }
      memo.set(key, count)
      return count
    },
  }
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

/** One identity component's contribution, plus whether it *identified* this candidate. */
interface IdentityScore {
  value: number
  /** The candidate carries the stored value AND that value is unique in the document. */
  discriminating: boolean
}

/**
 * One stored name/value pair against the candidate.
 *
 * `changed` is what a genuine contradiction is worth when the candidate still carries the
 * attribute under a different value: 0 for `id` (an element cannot hold two, so a different id
 * IS a different element unless the stored one is gone), `CHANGED_ATTR` for the rest.
 *
 * The staleness rescue applies **only** to a rewritten value, never to a missing one: an
 * attribute the candidate does not carry at all is absent evidence with nothing to explain it,
 * while a *rewritten* value whose original matches nothing in the document is the signature of
 * a framework regenerating its bookkeeping (bench F3).
 */
function identityScore(
  element: Element,
  name: string,
  stored: string,
  index: EvidenceIndex,
  changed: number,
): IdentityScore {
  const live = safeAttr(element, name)
  if (live === stored) return { value: 1, discriminating: index.identifies(name, stored) === 1 }
  if (live === null) return { value: 0, discriminating: false }
  if (index.identifies(name, stored) === 0) {
    return { value: STALE_EVIDENCE, discriminating: false }
  }
  return { value: changed, discriminating: false }
}

function attrsScore(
  element: Element,
  attrs: Record<string, string>,
  index: EvidenceIndex,
): IdentityScore {
  const names = Object.keys(attrs)
  if (names.length === 0) return { value: 1, discriminating: false }
  let matched = 0
  let discriminating = false
  for (const name of names) {
    const one = identityScore(element, name, attrs[name] ?? '', index, CHANGED_ATTR)
    matched += one.value
    if (one.discriminating) discriminating = true
  }
  return { value: matched / names.length, discriminating }
}

/** Fingerprint similarity, 0..1. Tag mismatch ⇒ 0. Semantics > classes > structure > text. */
export function scoreCandidate(element: Element, fingerprint: ElementFingerprint): number {
  const document = (element as Partial<Element>).ownerDocument ?? null
  return scoreAgainst(element, fingerprint, createEvidenceIndex(document))
}

/**
 * `scoreCandidate` with the per-resolve evidence index threaded through, so a fingerprint-scan
 * over 500 candidates pays for its document lookups once instead of 500 times. The public
 * two-argument form builds a throwaway index and is otherwise identical.
 */
export function scoreAgainst(
  element: Element,
  fingerprint: ElementFingerprint,
  index: EvidenceIndex,
): number {
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

  /** Did any identity component both match AND still identify exactly one element? */
  let identified = false

  if (fingerprint.id !== undefined) {
    const scored = identityScore(element, 'id', fingerprint.id, index, 0)
    add(WEIGHTS.id, scored.value)
    if (scored.discriminating) identified = true
  }
  if (Object.keys(fingerprint.attrs).length > 0) {
    const scored = attrsScore(element, fingerprint.attrs, index)
    add(WEIGHTS.attrs, scored.value)
    if (scored.discriminating) identified = true
  }
  if (fingerprint.stableClasses.length > 0) {
    add(WEIGHTS.classes, classCoverage(fingerprint.stableClasses, classListOf(element)))
  }
  if (fingerprint.rectHint) {
    add(WEIGHTS.structure, rectScore(element, fingerprint.rectHint))
  }
  // Text is always present: an empty digest matching an empty element is real evidence, and it
  // guarantees `weight > 0` so the normalization below can never divide by zero.
  const text = textSimilarity(fingerprint.textDigest, textDigestOf(element))
  add(WEIGHTS.text, text)

  // §4.6.2 — the text digest is the FINAL VERIFIER, in two tiers.
  //
  // Nothing identified this candidate ⇒ a class list and a box size are all that is left, and a
  // templated feed hands those to every sibling: refuse rather than attach to whatever is shaped
  // the same (bench F2).
  //
  // Something did identify it ⇒ the element is allowed to have been edited, but not to have
  // become a different subject: two non-empty digests with **no word in common** mean the id or
  // the test id was recycled for other content, which is exactly the stale-but-valid match
  // PLAN §3.1 forbids attaching to.
  if (identified) {
    if (text === 0 && fingerprint.textDigest !== '' && textDigestOf(element) !== '') return 0
  } else if (text < TEXT_VERIFY_MIN) {
    return 0
  }

  return weight === 0 ? 0 : Math.min(1, Math.max(0, total / weight))
}
