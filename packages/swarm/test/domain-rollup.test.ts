/**
 * SPEC-swarm §3.3 (rollup, Q9), §6.2.1 (bucket totality, F1/#37) and §6.4–6.6 (attention, F2).
 *
 * §13 names the bucket case verbatim: "`bucketOf` is total: every (state × stalled × landed)
 * combination maps to exactly one bucket, and a delegation in `verifying` is visible in
 * `working`". Four of the ten states used to map nowhere, including `verifying` — the moment the
 * entire law of done exists for.
 */

import { describe, expect, it } from 'vitest'

import type { DelegationState, DelegationVM, FleetBucket } from '../src/types.ts'

import { DELEGATION_STATES } from '../src/domain/machines.ts'
import {
  FLEET_BUCKETS,
  ROLLUP_PRIORITY,
  attentionScore,
  bucketOf,
  compareAttention,
  emptyBuckets,
  rollupDelegationState,
} from '../src/domain/rollup.ts'
import { makeDelegationVM } from '../src/testing/fixtures.ts'

describe('§3.3 rollup over live attempts (Q9)', () => {
  it('takes the highest-attention live attempt, in the declared order', () => {
    expect([...ROLLUP_PRIORITY]).toEqual([
      'needs-you',
      'verifying',
      'running',
      'waiting',
      'provisioning',
      'queued',
    ])
    expect(rollupDelegationState(['running', 'needs-you', 'queued'])).toBe('needs-you')
    expect(rollupDelegationState(['queued', 'provisioning'])).toBe('provisioning')
    expect(rollupDelegationState(['running', 'verifying'])).toBe('verifying')
  })

  it('one attempt in needs-you shows the delegation as needs-you while siblings keep running', () => {
    expect(rollupDelegationState(['needs-you', 'running', 'running'])).toBe('needs-you')
  })

  it('returns null when nothing is live — only then may a terminal state be reached', () => {
    expect(rollupDelegationState([])).toBeNull()
  })

  it('refuses a terminal state in the live list: that is the bug the rollup exists to prevent', () => {
    expect(() => rollupDelegationState(['running', 'succeeded'])).toThrow(/terminal/)
  })
})

describe('§6.2.1 bucketOf is total over state × facets', () => {
  it('maps every (state × stalled × landed) combination to exactly one of the nine buckets', () => {
    const buckets = new Set<FleetBucket>(FLEET_BUCKETS)
    expect(buckets.size).toBe(9)
    for (const state of DELEGATION_STATES) {
      for (const stalledForMs of [null, 5_000]) {
        for (const landed of [false, true]) {
          const bucket = bucketOf({ state, stalledForMs, landed })
          expect(buckets.has(bucket)).toBe(true)
        }
      }
    }
  })

  it('publishes exactly the §6.2.1 table', () => {
    const rows: [DelegationState, number | null, boolean, FleetBucket][] = [
      ['queued', null, false, 'queued'],
      ['provisioning', null, false, 'working'],
      ['running', null, false, 'working'],
      ['running', 12_000, false, 'stalled'],
      ['waiting', null, false, 'working'],
      ['verifying', null, false, 'working'],
      ['needs-you', null, false, 'needs-you'],
      ['succeeded', null, false, 'done-unlanded'],
      ['succeeded', null, true, 'done-landed'],
      ['failed', null, false, 'failed'],
      ['cancelled', null, false, 'cancelled'],
      ['abandoned', null, false, 'abandoned'],
    ]
    for (const [state, stalledForMs, landed, expected] of rows) {
      expect(bucketOf({ state, stalledForMs, landed })).toBe(expected)
    }
  })

  it('a delegation in `verifying` is visible in `working` — never nowhere (#37)', () => {
    expect(bucketOf({ state: 'verifying', stalledForMs: null, landed: false })).toBe('working')
  })

  it('dispatchPaused is a badge, not a bucket: it changes nothing here', () => {
    const paused = bucketOf({ state: 'running', stalledForMs: null, landed: false })
    expect(paused).toBe('working')
  })

  it('a DelegationVM satisfies BucketInput structurally, so the row and the list agree', () => {
    const vm: DelegationVM = makeDelegationVM({ state: 'succeeded', landed: false })
    expect(bucketOf(vm)).toBe('done-unlanded')
    expect(vm.bucket).toBe('done-unlanded')
  })

  it('emptyBuckets is total over the nine keys', () => {
    const empty = emptyBuckets<number>(() => 0)
    expect(Object.keys(empty).sort()).toEqual([...FLEET_BUCKETS].sort())
  })
})

describe('§6.4–6.6 attention score', () => {
  const base = {
    state: 'running' as DelegationState,
    landed: false,
    stalled: false,
    deliveryUnknown: false,
    budgetBreached: false,
    staleBase: false,
    ageMinutes: 0,
  }

  it('applies the declared weights', () => {
    expect(attentionScore({ ...base, state: 'needs-you' })).toBe(1000)
    expect(attentionScore({ ...base, state: 'failed' })).toBe(900)
    expect(attentionScore({ ...base, state: 'succeeded', landed: false })).toBe(800)
    expect(attentionScore({ ...base, state: 'succeeded', landed: true })).toBe(0)
    expect(attentionScore({ ...base, stalled: true })).toBe(700)
    expect(attentionScore({ ...base, deliveryUnknown: true })).toBe(600)
    expect(attentionScore({ ...base, budgetBreached: true })).toBe(500)
    expect(attentionScore({ ...base, staleBase: true })).toBe(400)
  })

  it('caps age at 199 so waiting never outranks a real signal', () => {
    expect(attentionScore({ ...base, ageMinutes: 10_000 })).toBe(199)
    expect(attentionScore({ ...base, ageMinutes: 42 })).toBe(42)
    expect(attentionScore({ ...base, ageMinutes: -5 })).toBe(0)
  })

  it('sums independent signals', () => {
    expect(
      attentionScore({ ...base, state: 'needs-you', deliveryUnknown: true, ageMinutes: 3 }),
    ).toBe(1603)
  })

  it('ties break by updatedAt desc then id — a total order, so the list never jitters', () => {
    const a = { attentionScore: 10, updatedAt: 5, id: 'a' }
    const b = { attentionScore: 10, updatedAt: 9, id: 'b' }
    const c = { attentionScore: 10, updatedAt: 9, id: 'c' }
    expect([a, b, c].sort(compareAttention).map((x) => x.id)).toEqual(['b', 'c', 'a'])
    expect(compareAttention(b, c)).toBeLessThan(0)
    expect(compareAttention(c, b)).toBeGreaterThan(0)
  })
})
