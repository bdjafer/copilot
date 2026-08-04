/**
 * SPEC-swarm §4.1 and §4.3 — the effort ladder, the mode gate, the image cap and the non-sticky
 * cascade, with the §13 named behavioural tests spelled out:
 *
 *  - "`swarm` / `swarm-deep` are rejected in the client core" (layer 1 of 3, #9);
 *  - "a turn override does not leak: turn 2 issues `setReasoningEffort(delegationDefault)`" (Q4);
 *  - "`{delivery:'interrupt', reasoningEffort:'max'}` is refused `config_not_available_in_mode`
 *    **in the client core with zero frames written**; the same turn without the field is accepted
 *    and records `reasoningEffort: 'inherited'`" (#30);
 *  - "images totalling 700 KB decoded are accepted; 701 KB is refused `invalid_spec` in the
 *    client core, never `frame_too_large` from the transport" (#40).
 */

import { describe, expect, it } from 'vitest'

import type { ReasoningEffort } from '../src/types.ts'

import {
  ANTHROPIC_EXTENDED_EFFORT_MODELS,
  BANNED_EFFORTS,
  EFFORT_LADDERS,
  checkEffortOnLadder,
  checkImageBudget,
  effectiveTurnConfig,
  effortLadder,
  modeAllowsConfig,
  normalizeEffort,
  reconciliationTarget,
  validateTurnDirective,
  type DelegationDefaults,
} from '../src/domain/directive.ts'
import { SwarmError } from '../src/errors.ts'
import { LIMITS } from '../src/protocol/constants.ts'
import { makeTurnDirective } from '../src/testing/fixtures.ts'

const defaults: DelegationDefaults = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  reasoningEffort: 'medium',
  delivery: 'after-turn',
}

/** Exactly `n` decoded bytes of base64: 4 characters carry 3 bytes, the tail is padded. */
function base64OfBytes(bytes: number): string {
  const groups = Math.floor(bytes / 3)
  const remainder = bytes % 3
  const body = 'A'.repeat(groups * 4)
  if (remainder === 1) return `${body}AA==`
  if (remainder === 2) return `${body}AAA=`
  return body
}

describe('§4.1 the effort ladder', () => {
  it('bans swarm and swarm-deep by name, in the client core (#9, layer 1 of 3)', () => {
    expect([...BANNED_EFFORTS]).toEqual(['swarm', 'swarm-deep'])
    for (const banned of BANNED_EFFORTS) {
      expect(() => normalizeEffort(banned)).toThrow(SwarmError)
      try {
        normalizeEffort(banned)
      } catch (error) {
        expect(SwarmError.is(error, 'banned_effort')).toBe(true)
      }
    }
  })

  it('normalizes the alias table BEFORE validating', () => {
    expect(normalizeEffort('off')).toBe('none')
    expect(normalizeEffort('disabled')).toBe('none')
    expect(normalizeEffort('default')).toBeNull()
    expect(normalizeEffort('auto')).toBeNull()
    expect(normalizeEffort('HIGH')).toBe('high')
    expect(normalizeEffort(' medium ')).toBe('medium')
  })

  it('throws unknown_effort for a value outside the closed union', () => {
    try {
      normalizeEffort('ludicrous')
      expect.unreachable('an unknown effort must throw')
    } catch (error) {
      expect(SwarmError.is(error, 'unknown_effort')).toBe(true)
    }
  })

  it('publishes the per-provider ladders §4.1 verified from reasoning.rs', () => {
    expect([...effortLadder('openai', 'gpt-5.4')]).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(effortLadder('openrouter', 'anything')).not.toContain('max')
    expect([...effortLadder('deepseek', 'r2')]).toEqual(['none', 'low', 'medium', 'high', 'max'])
    /* Anthropic is model-derived and notably has NO `minimal`. */
    expect(effortLadder('anthropic', 'claude-opus-5')).not.toContain('minimal')
  })

  it('refuses an effort that is off the provider ladder with unknown_effort', () => {
    expect(checkEffortOnLadder('anthropic', 'claude-opus-5', 'minimal')?.code).toBe(
      'unknown_effort',
    )
    expect(checkEffortOnLadder('openrouter', 'x', 'max')?.code).toBe('unknown_effort')
    expect(checkEffortOnLadder('openai', 'gpt-5.4', 'max')).toBeNull()
    expect(checkEffortOnLadder('anthropic', 'claude-opus-5', null)).toBeNull()
  })

  it('falls back to the conservative shared ladder for a provider the table does not know', () => {
    expect([...effortLadder('brand-new-provider', 'm')]).toEqual(['none', 'low', 'medium', 'high'])
  })
})

describe('§4.3.8 the mode gate (#30)', () => {
  it('allows model and reasoningEffort only with after-turn', () => {
    expect(modeAllowsConfig('after-turn')).toBe(true)
    expect(modeAllowsConfig('next-safe-point')).toBe(false)
    expect(modeAllowsConfig('interrupt')).toBe(false)
    expect(modeAllowsConfig('context-only')).toBe(false)
  })

  it("{delivery:'interrupt', reasoningEffort:'max'} is refused config_not_available_in_mode", () => {
    const error = validateTurnDirective(
      makeTurnDirective({ delivery: 'interrupt', reasoningEffort: 'max' }),
      { defaults, liveAttempts: ['a1'] },
    )
    expect(error?.code).toBe('config_not_available_in_mode')
    expect(error?.retryable).toBe(false)
    expect(error?.details?.mode).toBe('interrupt')
  })

  it('the same turn WITHOUT the field is accepted and records reasoningEffort: inherited', () => {
    const directive = makeTurnDirective({ delivery: 'interrupt' })
    expect(validateTurnDirective(directive, { defaults, liveAttempts: ['a1'] })).toBeNull()
    const effective = effectiveTurnConfig({ directive, defaults, executorVersions: {} })
    expect(effective.reasoningEffort).toBe('inherited')
    expect(effective.model).toBe('inherited')
    expect(effective.deliveryMode).toBe('interrupt')
  })

  it('refuses the mode gate BEFORE the ladder, so steering is not blamed on the effort value', () => {
    const error = validateTurnDirective(
      makeTurnDirective({ delivery: 'context-only', reasoningEffort: 'minimal' }),
      { defaults, liveAttempts: ['a1'] },
    )
    expect(error?.code).toBe('config_not_available_in_mode')
  })

  it('a model override in a non-after-turn mode is refused too', () => {
    const error = validateTurnDirective(
      makeTurnDirective({ delivery: 'next-safe-point', model: 'gpt-5.4' }),
      { defaults, liveAttempts: ['a1'] },
    )
    expect(error?.code).toBe('config_not_available_in_mode')
    expect(error?.details?.fields).toEqual(['model'])
  })
})

describe('§4.3.10 attempt targeting (#29)', () => {
  it('refuses attempt_ambiguous when two attempts are live and no attemptId is given', () => {
    const error = validateTurnDirective(makeTurnDirective(), {
      defaults,
      liveAttempts: ['a1', 'a2'],
    })
    expect(error?.code).toBe('attempt_ambiguous')
    expect(error?.details?.liveAttempts).toEqual(['a1', 'a2'])
  })

  it('allows the omission with exactly one live attempt', () => {
    expect(
      validateTurnDirective(makeTurnDirective(), { defaults, liveAttempts: ['a1'] }),
    ).toBeNull()
  })

  it('accepts a named attempt with several live', () => {
    const directive = makeTurnDirective({ attemptId: 'a2' })
    expect(validateTurnDirective(directive, { defaults, liveAttempts: ['a1', 'a2'] })).toBeNull()
  })
})

describe('§2.4 the image cap (#40)', () => {
  it('accepts images totalling exactly 700 KB decoded', () => {
    const budget = checkImageBudget([
      { mediaType: 'image/png', base64: base64OfBytes(LIMITS.imageBytesPerTurn) },
    ])
    expect(budget.error).toBeNull()
    expect(budget.budget.totalBytes).toBeGreaterThanOrEqual(LIMITS.imageBytesPerTurn)
  })

  it('refuses 701 KB with invalid_spec in the client core, never frame_too_large', () => {
    /* §13's row names the boundary in KB: 700 KB accepted, **701 KB** refused. 701 000 bytes is
     * BELOW 700 KiB, so a KiB cap accepts the exact size the DoD names as the refusal. */
    expect(LIMITS.imageBytesPerTurn).toBe(700_000)
    const oversize = checkImageBudget([{ mediaType: 'image/png', base64: base64OfBytes(701_000) }])
    expect(oversize.error?.code).toBe('invalid_spec')
    expect(oversize.error?.code).not.toBe('frame_too_large')
  })

  it('refuses a per-turn total over the cap even when each image is under it', () => {
    const half = base64OfBytes(400_000)
    const result = checkImageBudget([
      { mediaType: 'image/png', base64: half },
      { mediaType: 'image/png', base64: half },
    ])
    expect(result.error?.code).toBe('invalid_spec')
    expect(result.error?.details?.cap).toBe(LIMITS.imageBytesPerTurn)
  })

  it('refuses a malformed base64 body rather than sizing it at zero', () => {
    const result = checkImageBudget([{ mediaType: 'image/png', base64: 'not base64!!' }])
    expect(result.error?.code).toBe('invalid_spec')
  })

  it('validateTurnDirective surfaces the image refusal', () => {
    const directive = makeTurnDirective({
      images: [{ mediaType: 'image/png', base64: base64OfBytes(701_000) }],
    })
    expect(validateTurnDirective(directive, { defaults, liveAttempts: ['a1'] })?.code).toBe(
      'invalid_spec',
    )
  })
})

describe('§4.3.1–4.3.2 the cascade is non-sticky (Q4)', () => {
  it('a turn override does not leak: the next turn reconciles to the DELEGATION default', () => {
    const withOverride = reconciliationTarget(
      makeTurnDirective({ reasoningEffort: 'max' }),
      defaults,
    )
    expect(withOverride).toEqual({ model: 'claude-opus-5', reasoningEffort: 'max' })

    const withoutOverride = reconciliationTarget(makeTurnDirective(), defaults)
    expect(withoutOverride).toEqual({ model: 'claude-opus-5', reasoningEffort: 'medium' })
  })

  it('an explicit null override is not an omission: it reconciles to null, not to the default', () => {
    expect(reconciliationTarget(makeTurnDirective({ reasoningEffort: null }), defaults)).toEqual({
      model: 'claude-opus-5',
      reasoningEffort: null,
    })
  })

  it('a gated mode drives NO session config at all — the turn inherits whatever was set', () => {
    expect(reconciliationTarget(makeTurnDirective({ delivery: 'interrupt' }), defaults)).toBeNull()
  })

  it('effortConfirmed is a literal false in every produced config (§4.3.4, #7)', () => {
    const effective = effectiveTurnConfig({
      directive: makeTurnDirective({ reasoningEffort: 'high' }),
      defaults,
      executorVersions: { jcode: '0.67.0' },
    })
    expect(effective.effortConfirmed).toBe(false)
    expect(effective.modelConfirmed).toBe(false)
    expect(effective.reasoningEffort).toBe('high')
    expect(effective.executorVersions).toEqual({ jcode: '0.67.0' })
  })

  it('structured defaults maxRetries to 2 and records the schema digest', () => {
    const effective = effectiveTurnConfig({
      directive: makeTurnDirective({ structured: { schema: {} } }),
      defaults,
      executorVersions: {},
      structuredSchemaDigest: 'sha256:abc',
    })
    expect(effective.structured).toEqual({ schemaDigest: 'sha256:abc', maxRetries: 2 })
  })

  it('a banned effort arriving from the wire is refused by validateTurnDirective, not passed on', () => {
    const directive = makeTurnDirective({ reasoningEffort: 'swarm' as unknown as ReasoningEffort })
    expect(validateTurnDirective(directive, { defaults, liveAttempts: ['a1'] })?.code).toBe(
      'banned_effort',
    )
  })
})

describe("§4.1 the Anthropic effort ladder — deviation D3, now filled from jcode's own table", () => {
  /*
   * D3 shipped `ANTHROPIC_EXTENDED_EFFORT_MODELS` **empty**, which made §11's worked example
   * (`{reasoningEffort:'max'}` on `claude-opus-5`) fail in the client core with `unknown_effort`
   * and zero frames. That was the safe direction while the table was a guess, and the note said
   * so: filling it is the whole fix.
   *
   * It is now filled from the shipped `jcode v0.67.0 (156ae4092)` binary — see the four quoted
   * source strings on the constant. These cases pin both halves: what the table grants, and what
   * it deliberately withholds.
   */
  it("accepts §11's `max` on claude-opus-5, which is what filling the table was for", () => {
    expect(ANTHROPIC_EXTENDED_EFFORT_MODELS).toContain('claude-opus-5')
    expect(effortLadder('anthropic', 'claude-opus-5')).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(checkEffortOnLadder('anthropic', 'claude-opus-5', 'max')).toBeNull()
    expect(checkEffortOnLadder('anthropic', 'claude-opus-5', 'xhigh')).toBeNull()
  })

  it('still has no `minimal`: the Anthropic ladder never gains one (§4.1)', () => {
    /* jcode's own config template: "Anthropic reasoning effort for Claude reasoning models
     * (none|low|medium|high|xhigh|max)" — no `minimal` anywhere in it. */
    expect(checkEffortOnLadder('anthropic', 'claude-opus-5', 'minimal')?.code).toBe(
      'unknown_effort',
    )
    expect(EFFORT_LADDERS.anthropic).not.toContain('minimal')
  })

  it('grants the extension to exactly the four attested ids, and no others', () => {
    /* "available on Opus 4.7+, Sonnet 5+, and Fable 5+" — the runtime refusal string. */
    expect([...ANTHROPIC_EXTENDED_EFFORT_MODELS].sort()).toEqual([
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5',
    ])
  })

  it('withholds it from 4.6, which gets `max` from jcode but NOT `xhigh` (the intersection rule)', () => {
    /*
     * The template splits the two: "xhigh needs Opus 4.7/4.8 or Fable 5; max needs an
     * output_config effort model (Opus/Sonnet 4.6+)". One constant grants both, so it can only
     * hold the intersection. Including 4.6 would hand `xhigh` to a model whose own error message
     * says it is unsupported — and D3's bias is to refuse a value jcode might accept rather than
     * to send one it will certainly refuse.
     */
    for (const model of ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5']) {
      expect(effortLadder('anthropic', model)).toEqual(['none', 'low', 'medium', 'high'])
      expect(checkEffortOnLadder('anthropic', model, 'xhigh')?.code).toBe('unknown_effort')
      expect(checkEffortOnLadder('anthropic', model, 'max')?.code).toBe('unknown_effort')
    }
  })
})
