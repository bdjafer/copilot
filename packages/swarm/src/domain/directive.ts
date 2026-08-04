/**
 * `TurnDirective` semantics (SPEC-swarm §4.1, §4.3): the effort ladder, the alias table, the
 * mode gate, the image cap and the non-sticky cascade.
 *
 * Everything here runs in the **client core**, before any frame is built (§4.3.8), and again at
 * the server intent boundary. The duplication is the point: `swarm`/`swarm-deep` are refused at
 * three layers (§4.1, #9) because they are values jcode **accepts** — `ok` from
 * `setReasoningEffort` cannot validate anything, so the only gate is the one swarm owns.
 *
 * DOM-free and Node-free.
 */

import type {
  AttemptId,
  EffectiveTurnConfig,
  ReasoningEffort,
  TurnDeliveryMode,
  TurnDirective,
} from '../types.ts'

import { SwarmError } from '../errors.ts'
import { base64DecodedBytes } from '../protocol/codec.ts'
import { LIMITS } from '../protocol/constants.ts'

/**
 * Accepted by jcode and meaning "max effort + use jcode's internal swarm tool" — orchestration
 * handed to jcode inside a session swarm believes it owns. `JCODE_SWARM_ENABLED=false` does
 * **not** block them ([Bnew], §12 #9), which is why they are refused by name.
 */
export const BANNED_EFFORTS = ['swarm', 'swarm-deep'] as const

export const REASONING_EFFORTS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly ReasoningEffort[]

export const TURN_DELIVERY_MODES = [
  'after-turn',
  'next-safe-point',
  'interrupt',
  'context-only',
] as const satisfies readonly TurnDeliveryMode[]

/** §4.1: normalized **before** validation, so `auto` never reaches a ladder lookup. */
const EFFORT_ALIASES: Readonly<Record<string, ReasoningEffort | null>> = {
  off: 'none',
  disabled: 'none',
  default: null,
  auto: null,
}

const EFFORT_SET: ReadonlySet<string> = new Set<string>(REASONING_EFFORTS)
const BANNED_SET: ReadonlySet<string> = new Set<string>(BANNED_EFFORTS)

/**
 * Static ladders, verified from `jcode-provider-core/src/reasoning.rs` (§4.1). Keyed by the
 * `ModelSpec.provider` vocabulary — *not* the six credential-provider ids the bridge accepts,
 * which are a different vocabulary the adapter maps ([F17], §5.3).
 */
export const EFFORT_LADDERS = {
  /** OpenAI / Codex: the full ladder. */
  openai: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  /** OpenRouter: no `max` — it is an alias of `xhigh` there. */
  openrouter: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  deepseek: ['none', 'low', 'medium', 'high', 'max'],
  /** Anthropic: model-derived, and notably **no `minimal`**. */
  anthropic: ['none', 'low', 'medium', 'high'],
} as const satisfies Record<string, readonly ReasoningEffort[]>

/**
 * The Anthropic model ids whose capability row adds **both** `xhigh` and `max` (§4.1).
 *
 * Deviation D3 left this empty until an id could be read from jcode's own capability table rather
 * than guessed. It has now been read, from the shipped `jcode v0.67.0 (156ae4092)` binary, and
 * these are the four source strings it was derived from — quoted so the derivation is checkable
 * and so the day jcode changes its mind the constant is falsifiable rather than folklore:
 *
 *  1. `"Anthropic xhigh effort is not supported by this model (available on Opus 4.7+, Sonnet 5+,
 *     and Fable 5+)"` — the runtime refusal, and the authority for the `xhigh` set.
 *  2. `"# xhigh needs Opus 4.7/4.8 or Fable 5; max needs an output_config effort model
 *     (Opus/Sonnet 4.6+)."` — the shipped config template, and the authority for `max`.
 *  3. `"# Anthropic reasoning effort for Claude reasoning models (none|low|medium|high|xhigh|max)"`
 *     — confirming the Anthropic ladder has **no `minimal`**, as `EFFORT_LADDERS.anthropic` says.
 *  4. `"Reasoning effort is only supported for Claude 3.7 reasoning models and Claude 4.5+ models
 *     that expose Anthropic thinking/output_config"` — the floor below which no effort applies.
 *
 * The two extensions do **not** have the same membership: `max` reaches down to Opus/Sonnet 4.6
 * while `xhigh` starts at Opus 4.7. This constant grants both at once, so it holds only the
 * intersection — the models where both are attested. `claude-opus-4-6` and `claude-sonnet-4-6`
 * are therefore **deliberately excluded** even though jcode would likely accept `max` for them:
 * including them would hand `xhigh` to a model whose own error message says it is unsupported,
 * and D3's stated bias is to refuse a value jcode might accept rather than to send one it will
 * refuse. Widening this is a table edit with a source line, which is exactly the point.
 *
 * The ids are the wire ids from the live route catalog (`get_runtime_info`), not marketing names.
 */
export const ANTHROPIC_EXTENDED_EFFORT_MODELS: readonly string[] = [
  /* Opus 4.7+ — "Opus 4.7/4.8" in the template, and 5 is above 4.8. */
  'claude-opus-4-8',
  'claude-opus-5',
  /* Sonnet 5+. */
  'claude-sonnet-5',
  /* Fable 5+. */
  'claude-fable-5',
]

/**
 * The values every declared ladder contains. Used for a provider this table does not know:
 * refusing an unknown provider outright would make swarm unusable the day jcode routes to a new
 * one, and accepting anything would delete the gate.
 */
export const BASE_EFFORT_LADDER = [
  'none',
  'low',
  'medium',
  'high',
] as const satisfies readonly ReasoningEffort[]

function providerFamily(provider: string): keyof typeof EFFORT_LADDERS | null {
  const p = provider.toLowerCase()
  if (p.includes('openrouter')) return 'openrouter'
  if (p.includes('deepseek')) return 'deepseek'
  if (p.includes('anthropic') || p.includes('claude')) return 'anthropic'
  if (p.includes('openai') || p.includes('codex') || p.includes('gpt')) return 'openai'
  return null
}

export function effortLadder(provider: string, model: string): readonly ReasoningEffort[] {
  const family = providerFamily(provider)
  if (family === null) return BASE_EFFORT_LADDER
  if (family !== 'anthropic') return EFFORT_LADDERS[family]
  return ANTHROPIC_EXTENDED_EFFORT_MODELS.includes(model)
    ? [...EFFORT_LADDERS.anthropic, 'xhigh', 'max']
    : EFFORT_LADDERS.anthropic
}

/**
 * Alias, then validate against the closed union. **Throws** on a banned or unknown value (§4.1)
 * — this is the one place in the client core that throws, because a banned effort is a
 * programmer error in the caller, not a domain refusal the user can act on.
 */
export function normalizeEffort(raw: string): ReasoningEffort | null {
  const key = raw.trim().toLowerCase()
  if (key in EFFORT_ALIASES) return EFFORT_ALIASES[key] ?? null
  if (BANNED_SET.has(key)) {
    throw new SwarmError('banned_effort', `reasoning effort '${key}' is banned`, {
      details: { effort: key, banned: [...BANNED_EFFORTS] },
    })
  }
  if (!EFFORT_SET.has(key)) {
    throw new SwarmError('unknown_effort', `unknown reasoning effort '${raw}'`, {
      details: { effort: raw },
    })
  }
  return key as ReasoningEffort
}

/** Ladder membership, as a refusal rather than a throw — the intent boundary returns it. */
export function checkEffortOnLadder(
  provider: string,
  model: string,
  effort: ReasoningEffort | null,
): SwarmError | null {
  if (effort === null) return null
  const ladder = effortLadder(provider, model)
  if (ladder.includes(effort)) return null
  return new SwarmError(
    'unknown_effort',
    `'${effort}' is not on the ${provider} ladder for ${model}`,
    { details: { effort, provider, model, ladder: [...ladder] } },
  )
}

/* ---------------------------------------------------------------------- §4.3.8 the mode gate */

/**
 * `model` and `reasoningEffort` are legal **only** with `delivery: 'after-turn'` (#30).
 *
 * The other three modes are not unlucky, they are unsatisfiable: `next-safe-point` and
 * `interrupt` exist only while a turn is in flight — exactly the states §4.3.3 refuses — and
 * `context-only` starts no turn, so a recorded effort would describe nothing.
 */
export function modeAllowsConfig(mode: TurnDeliveryMode): boolean {
  return mode === 'after-turn'
}

/* ------------------------------------------------------------------------ §2.4 the image cap */

export interface ImageBudgetResult {
  readonly totalBytes: number
  readonly perImageBytes: readonly number[]
}

/**
 * 700 KiB decoded per image **and** per turn (§2.4). Refused here, in the client core, with
 * `invalid_spec` — never `frame_too_large` from the transport, which is a transport error for a
 * product-level refusal raised after the user already waited for the upload.
 */
export function checkImageBudget(
  images: readonly { readonly mediaType: string; readonly base64: string }[] | undefined,
): { readonly error: SwarmError | null; readonly budget: ImageBudgetResult } {
  const perImageBytes: number[] = []
  let totalBytes = 0
  for (let i = 0; i < (images?.length ?? 0); i++) {
    const image = images![i]!
    const bytes = base64DecodedBytes(image.base64)
    if (bytes === null) {
      return {
        error: new SwarmError('invalid_spec', `image ${i} is not valid base64`, {
          details: { index: i, mediaType: image.mediaType },
        }),
        budget: { totalBytes, perImageBytes },
      }
    }
    perImageBytes.push(bytes)
    totalBytes += bytes
    if (bytes > LIMITS.imageBytesPerImage) {
      return {
        error: new SwarmError(
          'invalid_spec',
          `image ${i} is ${bytes} decoded bytes, over the ${LIMITS.imageBytesPerImage} cap`,
          { details: { index: i, bytes, cap: LIMITS.imageBytesPerImage } },
        ),
        budget: { totalBytes, perImageBytes },
      }
    }
  }
  if (totalBytes > LIMITS.imageBytesPerTurn) {
    return {
      error: new SwarmError(
        'invalid_spec',
        `images total ${totalBytes} decoded bytes, over the ${LIMITS.imageBytesPerTurn} per-turn cap`,
        { details: { totalBytes, cap: LIMITS.imageBytesPerTurn } },
      ),
      budget: { totalBytes, perImageBytes },
    }
  }
  return { error: null, budget: { totalBytes, perImageBytes } }
}

/* --------------------------------------------------------------- §4.3 validation and cascade */

export interface DelegationDefaults {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: ReasoningEffort | null
  readonly delivery: TurnDeliveryMode
}

export interface DirectiveContext {
  readonly defaults: DelegationDefaults
  /** Non-terminal attempts. Length > 1 makes `attemptId` mandatory (§4.3.10). */
  readonly liveAttempts: readonly AttemptId[]
}

/**
 * Every refusal the client core owes a directive, in the order the DoD asserts them.
 *
 * Order is contractual, not incidental: `{delivery:'interrupt', reasoningEffort:'max'}` must
 * report `config_not_available_in_mode`, so the mode gate runs before the ladder — otherwise a
 * user steering mid-turn would be told their effort was wrong when the real answer is that
 * steering and configuring are different acts.
 *
 * Returns `null` when the directive may be sent. Never throws for a domain refusal (§9).
 */
export function validateTurnDirective(
  directive: TurnDirective,
  context: DirectiveContext,
): SwarmError | null {
  if (context.liveAttempts.length > 1 && directive.attemptId === undefined) {
    return new SwarmError(
      'attempt_ambiguous',
      `this delegation has ${context.liveAttempts.length} live attempts; attemptId is required`,
      { details: { liveAttempts: [...context.liveAttempts] } },
    )
  }

  const mode = directive.delivery ?? context.defaults.delivery
  const namesConfig = directive.model !== undefined || directive.reasoningEffort !== undefined
  if (namesConfig && !modeAllowsConfig(mode)) {
    return new SwarmError(
      'config_not_available_in_mode',
      `model and reasoningEffort require delivery: 'after-turn', not '${mode}'`,
      { details: { mode, fields: configFieldsNamed(directive) } },
    )
  }

  if (directive.reasoningEffort !== undefined && directive.reasoningEffort !== null) {
    /* The union already excludes the banned values at compile time; the wire does not. */
    let normalized: ReasoningEffort | null
    try {
      normalized = normalizeEffort(directive.reasoningEffort)
    } catch (error) {
      return SwarmError.is(error) ? error : new SwarmError('unknown_effort', String(error))
    }
    const model = directive.model ?? context.defaults.model
    const onLadder = checkEffortOnLadder(context.defaults.provider, model, normalized)
    if (onLadder) return onLadder
  }

  const images = checkImageBudget(directive.images)
  if (images.error) return images.error

  return null
}

function configFieldsNamed(directive: TurnDirective): readonly string[] {
  const fields: string[] = []
  if (directive.model !== undefined) fields.push('model')
  if (directive.reasoningEffort !== undefined) fields.push('reasoningEffort')
  return fields
}

/**
 * §4.3.2, **non-sticky**: an omitted field reconciles the session back to the *delegation*
 * default, not to the previous override. A turn with `effort:'max'` followed by a turn without
 * `effort` issues `setReasoningEffort(delegationDefault)` before its send.
 *
 * `null` ⇒ the mode gate applied and **no** session config is driven at all: the turn runs under
 * whatever the previous turn set, which is what `'inherited'` records.
 */
export function reconciliationTarget(
  directive: TurnDirective,
  defaults: DelegationDefaults,
): { readonly model: string; readonly reasoningEffort: ReasoningEffort | null } | null {
  const mode = directive.delivery ?? defaults.delivery
  if (!modeAllowsConfig(mode)) return null
  return {
    model: directive.model ?? defaults.model,
    reasoningEffort:
      directive.reasoningEffort === undefined
        ? defaults.reasoningEffort
        : directive.reasoningEffort,
  }
}

export const DEFAULT_STRUCTURED_MAX_RETRIES = 2

export interface EffectiveConfigInput {
  readonly directive: TurnDirective
  readonly defaults: DelegationDefaults
  readonly executorVersions: Record<string, string>
  /** sha256 of the structured schema, computed by the caller (the client core has no hasher). */
  readonly structuredSchemaDigest?: string
}

/**
 * The turn's configuration **as declared** (§4.3.1, §4.3.4). `effortConfirmed` is a literal
 * `false` in the type, so this function cannot claim otherwise and neither can any future one.
 */
export function effectiveTurnConfig(input: EffectiveConfigInput): EffectiveTurnConfig {
  const { directive, defaults } = input
  const deliveryMode = directive.delivery ?? defaults.delivery
  const inherited = !modeAllowsConfig(deliveryMode)
  const structured =
    directive.structured === undefined
      ? null
      : {
          schemaDigest: input.structuredSchemaDigest ?? '',
          maxRetries: directive.structured.maxRetries ?? DEFAULT_STRUCTURED_MAX_RETRIES,
        }

  return {
    provider: defaults.provider,
    model: inherited ? 'inherited' : (directive.model ?? defaults.model),
    reasoningEffort: inherited
      ? 'inherited'
      : directive.reasoningEffort === undefined
        ? defaults.reasoningEffort
        : directive.reasoningEffort,
    effortConfirmed: false,
    /* Never true at declaration time: `model_info` is what confirms it, and it has not arrived. */
    modelConfirmed: false,
    deliveryMode,
    structured,
    budget: directive.budget ?? null,
    executorVersions: input.executorVersions,
  }
}
