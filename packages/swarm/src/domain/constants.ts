/**
 * Normative defaults that are not wire constants: timeouts (§7.3), lease TTLs (§3.4), the
 * channel reconnect ladder (C13), scheduler caps (§7.3) and verifier caps (§8.3).
 *
 * They live in one table for the same reason the wire constants do — two peers, a scheduler and
 * a test all have to agree on the number, and a number typed twice is a number that drifts.
 *
 * DOM-free and Node-free.
 */

/** §7.3 `timeouts`. */
export const DEFAULT_TIMEOUTS = {
  /**
   * **Swarm's own** ack deadline (V5). It is not the SDK's: `waitForAccept` *resolves* on
   * timeout ([F2]), so a `sendMessage` that returns proves nothing. The adapter sends with
   * `waitForAccept:false` and observes `message_accepted` on the session's own stream inside
   * this window.
   */
  acceptTimeoutMs: 10_000,
  /** Unanswered copilot confirmations are denied automatically after this (§6.7). */
  confirmationTtlMs: 120_000,
  /** Δwall − Δmono above this is a suspend, not a stall (X16). */
  sleepDetectThresholdMs: 90_000,
} as const

/** §3.4 leases. */
export const LEASES = {
  /** `session:*` — the writer lease. One holder. */
  sessionTtlMs: 60_000,
  sessionRenewMs: 20_000,
  /**
   * Expiry never releases while a turn streams (§3.4 rule 2): it marks the holder `suspect` and
   * blocks new submissions. A lease that releases mid-stream would hand the session to a second
   * writer while the first is still receiving its turn.
   */
  reconciliationTtlMs: 60_000,
} as const

/** C13 — the channel supervisor's reconnect ladder. */
export const CHANNEL_RECONNECT = {
  baseMs: 500,
  factor: 2,
  capMs: 30_000,
  maxTries: 8,
} as const

/** C3 attach deadline and C11's interrupt-merge window. */
export const CHANNEL_TIMEOUTS = {
  attachTimeoutMs: 10_000,
  /** 3 s of continued deltas with no `turn_done` ⇒ the interrupt merged into the turn (C11). */
  interruptMergeMs: 3_000,
} as const

/** §7.3 `caps` — the unit of admission is an **attempt**, not a delegation (Q9). */
export const DEFAULT_CAPS = {
  globalConcurrency: 4,
  perWorkspace: 2,
  worktreesPerRepo: 8,
  copilotConcurrency: 1,
  /** The ceiling a spec may request. */
  maxParallelAttempts: 3,
} as const

/** §8.3 verifier caps. */
export const VERIFIER_CAPS = {
  criterionTimeoutMs: 120_000,
  maxCriterionTimeoutMs: 900_000,
  runDeadlineMs: 20 * 60_000,
  /** Output is captured to files and truncated **in the record** at 64 KiB (VE8). */
  recordTruncateBytes: 64 * 1024,
  /** `review` threshold default (§3.2). */
  reviewThreshold: 0.7,
} as const

/** Assorted server-side deadlines named in §2.5, §3.3, §5.3 and §6.6. */
export const SERVER_POLICY = {
  /** `(tokenId, idempotencyKey)` cache TTL (§2.5 rule 3). */
  idempotencyTtlMs: 24 * 60 * 60_000,
  /** D5 — provisioning gives up after this many bounded retries. */
  provisionRetries: 3,
  /** A queued turn older than this at flush is held behind `notice{kind:'stale-queued-turn'}`. */
  staleQueuedTurnMs: 10 * 60_000,
  /** §2.1 pairing code: 8 chars Crockford base32, one use, 5 attempts. */
  pairingCodeTtlMs: 300_000,
  pairingCodeAttempts: 5,
  defaultPort: 7717,
  /** §5.3, §11: below this, `PreflightReport{blocked:'version_floor'}` in under a second. */
  jcodeVersionFloor: '0.66.0',
  /**
   * The fix string is asserted verbatim by §13, because `jcode upgrade` errors with
   * `unrecognized subcommand` and the one copy-pasteable string on the first-run screen has to
   * be the one that works.
   */
  jcodeUpdateCommand: 'jcode update',
} as const
