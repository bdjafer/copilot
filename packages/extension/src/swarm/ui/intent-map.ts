/**
 * Head deviation **E4** — swarm's affordances mapped onto DESIGN's locked 18 glyphs.
 *
 * DESIGN §5 locks the sprite at eighteen marks and §10 forbids a drawn verb, so every control in
 * this head is one of those marks plus a native `title` **and** an `aria-label`. Swarm has
 * affordances comment-ui never had — land, verify, retract, kill — and inventing a nineteenth
 * glyph for each would be a design decision this head is not allowed to make (DESIGN's preamble:
 * "implementers must not make design decisions"). Reuse is already sanctioned inside the document
 * — `cc-i-check` is *both* resolve and saved, `cc-i-uturn` is *both* reopen and restore-defaults —
 * so the rule applied here is: **one glyph may serve several affordances as long as no two of them
 * are reachable in the same cluster**, and every one carries its own words in `title`.
 *
 * The table is data, not prose, because `test/swarm-design.test.ts` reads it: it asserts every
 * glyph named here exists in the sprite, that every destructive row arms (DESIGN §6.4 `arm`), and
 * that no two affordances in one cluster share a mark.
 *
 * The two affordances that are **not** glyphs at all are recorded here too, because their absence
 * is the design decision: `dispatch` and `follow` are booleans and take DESIGN §8.8's 30×18
 * switch, and `create` / `followUp` are D4's permanently-rendered collapsed fields, whose
 * placeholder is the only thing naming the box (§10 keeps `Labels.placeholder` for exactly this).
 */

import type { GlyphId } from './sprite.ts'

export interface AffordanceRow {
  /** Stable id; also the `data-affordance` written on the control, which the tests select by. */
  readonly id: string
  /** Which surface it lives in — no two rows in one cluster may share a glyph. */
  readonly cluster:
    | 'fleet-strip'
    | 'row'
    | 'detail'
    | 'attempt'
    | 'turn'
    | 'composer'
    | 'notice'
    | 'pairing'
  readonly glyph: GlyphId
  /** The `title` **and** `aria-label`: a sentence, because it is the only place the verb exists. */
  readonly label: string
  /** DESIGN §6.4 `arm`: two clicks in place, 4 s, `data-confirm` tints and rings. */
  readonly arms: boolean
}

export const AFFORDANCES = [
  /* ------------------------------------------------------------------ fleet strip */
  {
    id: 'kill-switch',
    cluster: 'fleet-strip',
    glyph: 'cc-i-warn',
    // Q16/§5.3.11 in one sentence, because the whole failure mode of this control is a user who
    // believes it deletes their work — or believes it stopped something it did not.
    label:
      'kill switch — cancel every in-flight turn and pause dispatch fleet-wide. No delegation is terminated and no worktree is touched.',
    arms: true,
  },
  {
    id: 'kill-instances',
    cluster: 'fleet-strip',
    glyph: 'cc-i-trash',
    label:
      'hard kill the executor instances as well — the only true stop, and it is reported as partial when a daemon cannot be confirmed dead',
    arms: true,
  },
  {
    id: 'honesty',
    cluster: 'fleet-strip',
    glyph: 'cc-i-info',
    label: 'what this product cannot do',
    arms: false,
  },
  /* ------------------------------------------------------------------------- rows */
  {
    id: 'row-open',
    cluster: 'row',
    glyph: 'cc-i-chevron',
    label: 'open this delegation',
    arms: false,
  },
  /* ----------------------------------------------------------------------- detail */
  {
    id: 'close',
    cluster: 'detail',
    glyph: 'cc-i-close',
    label: 'close this delegation',
    arms: false,
  },
  {
    id: 'verify',
    cluster: 'detail',
    glyph: 'cc-i-check',
    label: 'run the acceptance criteria now',
    arms: false,
  },
  {
    id: 'accept',
    cluster: 'detail',
    glyph: 'cc-i-pencil',
    // §4.3 rule 3 / D14: a zero-criteria delegation reaches `succeeded` only through this note.
    label: 'accept with a written verdict — the only path to succeeded without criteria',
    arms: false,
  },
  {
    id: 'retry',
    cluster: 'detail',
    glyph: 'cc-i-uturn',
    label:
      'retry — a new attempt with the prior failure injected; prior evidence is never destroyed',
    arms: false,
  },
  {
    id: 'cancel-delegation',
    cluster: 'detail',
    glyph: 'cc-i-pin-off',
    label: 'cancel this delegation — terminal, and the only path to cancelled',
    arms: true,
  },
  {
    id: 'hard-kill',
    cluster: 'detail',
    glyph: 'cc-i-warn',
    label: 'hard kill this delegation — terminate the executor instance and its children',
    arms: true,
  },
  {
    id: 'reconcile',
    cluster: 'detail',
    glyph: 'cc-i-tilde',
    label: 'reconcile an unknown delivery against the evidence',
    arms: false,
  },
  {
    id: 'archive',
    cluster: 'detail',
    glyph: 'cc-i-stack',
    label: 'archive this delegation',
    arms: true,
  },
  /* ---------------------------------------------------------------------- attempt */
  {
    id: 'attempt-select',
    cluster: 'attempt',
    glyph: 'cc-i-chevron',
    label: 'watch this attempt',
    arms: false,
  },
  {
    id: 'land',
    cluster: 'attempt',
    glyph: 'cc-i-send',
    label: 'land this attempt as a commit on the target branch',
    arms: false,
  },
  {
    id: 'branch',
    cluster: 'attempt',
    glyph: 'cc-i-reply',
    label: 'branch this attempt into a new delegation, seeded from the normalized transcript',
    arms: false,
  },
  {
    id: 'discard',
    cluster: 'attempt',
    glyph: 'cc-i-trash',
    label: 'discard this attempt — the worktree goes, the evidence and transcript stay',
    arms: true,
  },
  {
    id: 'recommended',
    cluster: 'attempt',
    glyph: 'cc-i-sparkle',
    label: 'best passing attempt by criteria and cost — a suggestion, never a landing',
    arms: false,
  },
  /* ------------------------------------------------------------------------- turn */
  {
    id: 'send',
    cluster: 'turn',
    glyph: 'cc-i-send',
    label: 'send this message',
    arms: false,
  },
  {
    id: 'cancel-turn',
    cluster: 'turn',
    glyph: 'cc-i-close',
    label: 'cancel the turn in flight — the session survives',
    arms: false,
  },
  {
    id: 'retract',
    cluster: 'turn',
    glyph: 'cc-i-uturn',
    // §4.3.9 / T9: `cancelSoftInterrupts` is session-wide and there is no per-message primitive.
    label:
      'retract this message — for an interrupt this retracts every pending interrupt on the session',
    arms: false,
  },
  {
    id: 'older',
    cluster: 'turn',
    glyph: 'cc-i-chevron',
    label: 'load older transcript entries',
    arms: false,
  },
  /* --------------------------------------------------------------------- composer */
  {
    id: 'create',
    cluster: 'composer',
    glyph: 'cc-i-send',
    label: 'start this delegation',
    arms: false,
  },
  {
    id: 'criterion-remove',
    cluster: 'composer',
    glyph: 'cc-i-close',
    label: 'remove this acceptance criterion',
    arms: false,
  },
  /* ----------------------------------------------------------------------- notice */
  {
    id: 'dismiss',
    cluster: 'notice',
    glyph: 'cc-i-close',
    label: 'dismiss this notice',
    arms: false,
  },
  {
    id: 'confirm',
    cluster: 'notice',
    glyph: 'cc-i-check',
    label: 'confirm this copilot request',
    arms: false,
  },
  {
    id: 'deny',
    cluster: 'notice',
    glyph: 'cc-i-pin-off',
    label: 'deny this copilot request',
    arms: false,
  },
  /* ---------------------------------------------------------------------- pairing */
  {
    id: 'pair',
    cluster: 'pairing',
    glyph: 'cc-i-send',
    label: 'pair this head with the swarm server',
    arms: false,
  },
  {
    id: 'unpair',
    cluster: 'pairing',
    glyph: 'cc-i-pin-off',
    label: 'unpair this head — the token is deleted from this browser',
    arms: true,
  },
] as const satisfies readonly AffordanceRow[]

export type AffordanceId = (typeof AFFORDANCES)[number]['id']

const BY_ID = new Map<string, AffordanceRow>(AFFORDANCES.map((row) => [row.id, row]))

export function affordance(id: AffordanceId): AffordanceRow {
  const row = BY_ID.get(id)
  /* Unreachable through the typed id; total anyway, because a renderer must never throw. */
  return row ?? { id, cluster: 'detail', glyph: 'cc-i-info', label: id, arms: false }
}
