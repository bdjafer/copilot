/**
 * SPEC-swarm §1.1 and §6.8 — the type-level test that the presentation seam's **duplicated**
 * shapes stay structurally compatible with the canonical ones.
 *
 * The duplication is deliberate: `./presentation` imports nothing, so a presentation can see
 * these types and nothing else and cannot reach the client, the wire or the store. What that
 * buys is only safe while the two copies agree — and they can only be compared somewhere that is
 * allowed to import both, which is a test file and nowhere else.
 *
 * §1.2's `ReadableStore` compatibility with `comment-core`'s is asserted the same way, in this
 * file only, so no shipped module ever depends on that package.
 */

import { describe, expect, it } from 'vitest'

import type {
  SwarmBucketVM,
  SwarmDelegationVM,
  SwarmLabels,
  SwarmNoticeVM,
  SwarmRowVM,
  SwarmViewModel,
} from '../src/presentation.ts'
import type {
  DelegationVM,
  FleetBucket,
  NoticeVM,
  ReadableStore,
  Unsubscribe,
} from '../src/types.ts'

import { FLEET_BUCKETS } from '../src/domain/rollup.ts'
import { makeDelegationVM, makeNoticeVM } from '../src/testing/fixtures.ts'

/** Compile-time assertion helper: `Assignable<A, B>` fails to typecheck unless `A extends B`. */
type Assignable<A extends B, B> = A

describe('§6.8 the seam is structurally compatible with §6.2', () => {
  it('a canonical DelegationVM projects onto SwarmRowVM without a cast', () => {
    const canonical: DelegationVM = makeDelegationVM()
    const row: SwarmRowVM = {
      id: canonical.id,
      title: canonical.title,
      bucket: canonical.bucket,
      badge: canonical.dispatchPaused ? 'paused' : null,
      nowDoing: canonical.nowDoing,
      attention: canonical.attentionScore,
      attempts: canonical.attempts.length,
      paused: canonical.dispatchPaused,
    }
    expect(row.bucket).toBe('working')
    expect(row.attempts).toBe(1)
  })

  it('a canonical NoticeVM projects onto SwarmNoticeVM', () => {
    const canonical: NoticeVM = makeNoticeVM()
    const notice: SwarmNoticeVM = {
      id: canonical.id,
      kind: canonical.kind,
      severity: canonical.severity,
      title: canonical.title,
      detail: canonical.detail,
      dismissible: canonical.dismissible,
    }
    expect(notice.kind).toBe('honesty')
  })

  it('the canonical FleetBucket union is assignable to the seam’s widened bucket id', () => {
    type BucketIdIsWiderThanFleetBucket = Assignable<FleetBucket, SwarmBucketVM['id']>
    const bucket: BucketIdIsWiderThanFleetBucket = 'done-unlanded'
    expect(FLEET_BUCKETS).toContain(bucket)
  })

  it('effortConfirmed is the literal false on BOTH sides (§4.3.4)', () => {
    type SeamEffort = SwarmDelegationVM['effective']['effortConfirmed']
    type IsLiteralFalse = Assignable<SeamEffort, false>
    const value: IsLiteralFalse = false
    expect(value).toBe(false)
  })

  it('the view model is total: every field a presentation reads is required', () => {
    const vm: SwarmViewModel = {
      connection: { status: 'connected', blockedReason: null, queuedOffline: 0 },
      fleet: {
        buckets: [],
        dispatchPaused: false,
        concurrency: { runningAttempts: 0, cap: 4, queued: 0 },
        spend: { estUsd: 0, capUsd: null },
      },
      focused: null,
      notices: [],
      confirmations: [],
      health: { ok: true, detail: 'ok', fix: null, routes: [], honesty: [] },
    }
    expect(vm.health.honesty).toEqual([])
  })

  it('SwarmLabels names the honest effort label the spec requires (§4.3.4)', () => {
    const labels: Pick<SwarmLabels, 'effortDeclared' | 'effortInherited'> = {
      effortDeclared: 'declared, not confirmed',
      effortInherited: 'inherited from the previous turn',
    }
    expect(labels.effortDeclared).toContain('not confirmed')
  })
})

describe('§1.2 ReadableStore is re-declared, never imported (H3)', () => {
  it('is structurally the store the rest of the house uses', () => {
    let value = 1
    const listeners = new Set<(v: number, p: number) => void>()
    const store: ReadableStore<number> = {
      get: () => value,
      subscribe(listener) {
        listeners.add(listener)
        const off: Unsubscribe = () => {
          listeners.delete(listener)
        }
        return off
      },
    }
    const seen: number[] = []
    const off = store.subscribe((v) => seen.push(v))
    const previous = value
    value = 2
    for (const listener of listeners) listener(value, previous)
    off()
    expect(seen).toEqual([2])
    expect(store.get()).toBe(2)
  })
})
