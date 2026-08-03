/**
 * PLAN §4.6 — the options-page configuration, and the only shape either half of the bridge
 * reads for policy. Deliberately minimal: API key, model tier, per-kind system prompts,
 * per-kind dispatch policy, per-kind trigger key.
 *
 * Pure over a `KeyValueAdapter`: no `chrome.*`, no DOM. `normalizeSettings` is total — every
 * malformed shape on disk resolves to a usable value — because the service worker reads these
 * inside a `storage.onChanged` handler with no opportunity to prompt anyone.
 */

import type { KeyValueAdapter } from '@astrale-os/comment-core/headless'

import { LEGACY_SETTINGS_KEY, SETTINGS_KEY } from './keys.ts'

/* ------------------------------------------------------------------- kinds */

/**
 * PLAN §5's two modes. `comment` runs the copilot as a review participant, `ask` as a
 * question-answerer. The engine attaches no behaviour to `kind` — every difference below is
 * bridge-side, which is the property that makes a third mode one more entry here.
 */
export const KINDS = ['comment', 'ask'] as const
export type Kind = (typeof KINDS)[number]

export const isKind = (value: unknown): value is Kind =>
  typeof value === 'string' && (KINDS as readonly string[]).includes(value)

export type DispatchPolicy = 'immediate' | 'manual'

/* ------------------------------------------------------------------ models */

/**
 * PLAN §4.4 / SPEC-copilot §6. `primary` is the run's default brain; `fast` is what an `ask`
 * run is triggered with (`TriggerInput.model: 'fast'`), and is snapshotted into `run.spec` by
 * KEY, so a watchdog restart in a fresh worker still replays on the fast tier.
 */
export const MODEL_CHOICES = [
  { id: 'claude-opus-5', label: 'Claude Opus 5 — quality (default)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 — fast' },
] as const

export const DEFAULT_PRIMARY_MODEL = 'claude-opus-5'
export const DEFAULT_FAST_MODEL = 'claude-haiku-4-5'

/* ---------------------------------------------------------------- prompts */

export const DEFAULT_PROMPTS: Record<Kind, string> = {
  // PLAN §5: `comment` runs the copilot as a discussion participant.
  comment: [
    'You are a copilot participating in a review thread anchored to an element on a web page.',
    'You are one voice in a discussion, not a narrator: respond to what the humans actually said.',
    '',
    'Rules:',
    '- Reply with the comment body only. No greeting, no sign-off, no "Here is".',
    '- Be concrete and short. Two or three sentences unless asked for more.',
    '- Ground every claim in the thread, the captured element, or a tool result. If you are',
    '  guessing, say so in the same sentence.',
    '- Use get_page_context and get_thread_element_html when the anchored element matters; the',
    '  stored capture may be stale and the live DOM may be gone. Either outcome is information.',
    '- You may suggest resolving a thread. You may never resolve one.',
  ].join('\n'),
  // PLAN §5: `ask` runs the copilot as a question-answerer/actor.
  ask: [
    'You are a copilot answering a direct question about an element on a web page.',
    '',
    'Rules:',
    '- Answer the question. Lead with the answer, then the reason if one is needed.',
    '- Reply with the answer body only. No preamble, no restating the question.',
    '- Read the page before answering when the answer depends on it: call get_page_context for',
    '  the URL, title and outline, and get_thread_element_html for the anchored element.',
    '- If the element is gone the tool returns null — say what you can from the stored capture',
    '  rather than pretending you saw it.',
    '- If you genuinely cannot answer, say that in one sentence.',
  ].join('\n'),
}

/**
 * PLAN §5's batch prompt. A batch run sees the whole review at once and replies per thread via
 * `reply_to_thread`; its `run:done` output is an overall summary, surfaced as a toast — which is
 * why the global `run:done` handler must not append it to a thread.
 */
export const BATCH_PROMPT = [
  'You are a copilot receiving a whole review at once: several comment threads on one page,',
  'submitted together.',
  '',
  'Rules:',
  '- Read every thread before replying to any of them. Connect related comments — that is the',
  '  entire reason these arrived as a batch rather than one at a time.',
  '- Reply to each thread that warrants a reply by calling reply_to_thread(threadId, body).',
  '  That tool is the only way to answer a thread here; ordinary text is not a reply.',
  '- Skip threads that need nothing. Silence is a valid response to a note.',
  '- Your final message is a short overall summary shown once as a toast. Two sentences at most.',
  '  Do not repeat the per-thread replies in it.',
].join('\n')

/* --------------------------------------------------------------- triggers */

export interface TriggerSetting {
  /** Single character, matched case-insensitively against `KeyboardEvent.key`. */
  key: string
  modifiers?: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean }
}

export const DEFAULT_TRIGGERS: Record<Kind, TriggerSetting> = {
  comment: { key: 'c' },
  ask: { key: 'a' },
}

/* --------------------------------------------------------------- settings */

export interface Settings {
  apiKey: string
  /** A `MODEL_CHOICES` id. Used for the primary provider. */
  model: string
  /** A `MODEL_CHOICES` id. Used for the `fast` entry of `CopilotOptions.models`. */
  fastModel: string
  prompts: Record<Kind, string>
  /** PLAN §5: `ask` defaults to immediate, `comment` to manual (the GitHub-review pattern). */
  dispatch: Record<Kind, DispatchPolicy>
  triggers: Record<Kind, TriggerSetting>
  /** Master switch. False ⇒ the SW observes writes but never triggers a run. */
  enabled: boolean
}

export function defaultSettings(): Settings {
  return {
    apiKey: '',
    model: DEFAULT_PRIMARY_MODEL,
    fastModel: DEFAULT_FAST_MODEL,
    prompts: { ...DEFAULT_PROMPTS },
    dispatch: { comment: 'manual', ask: 'immediate' },
    triggers: { comment: { ...DEFAULT_TRIGGERS.comment }, ask: { ...DEFAULT_TRIGGERS.ask } },
    enabled: true,
  }
}

const asString = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : fallback

function asTrigger(value: unknown, fallback: TriggerSetting): TriggerSetting {
  if (typeof value !== 'object' || value === null) return { ...fallback }
  const raw = value as { key?: unknown; modifiers?: unknown }
  // A multi-character key would never match `KeyboardEvent.key` for a letter press, and an
  // empty one would match nothing at all; both fall back rather than disabling the mode.
  const key = typeof raw.key === 'string' && raw.key.length === 1 ? raw.key : fallback.key
  const mods =
    typeof raw.modifiers === 'object' && raw.modifiers !== null
      ? (raw.modifiers as Record<string, unknown>)
      : undefined
  if (!mods) return { key }
  const modifiers: TriggerSetting['modifiers'] = {}
  for (const name of ['alt', 'ctrl', 'meta', 'shift'] as const) {
    if (mods[name] === true) modifiers[name] = true
  }
  return Object.keys(modifiers).length > 0 ? { key, modifiers } : { key }
}

/** Total: every malformed member degrades to its default rather than throwing at a host. */
export function normalizeSettings(raw: unknown): Settings {
  const base = defaultSettings()
  if (typeof raw !== 'object' || raw === null) return base

  const input = raw as Record<string, unknown>
  const prompts = (input.prompts ?? {}) as Record<string, unknown>
  const dispatch = (input.dispatch ?? {}) as Record<string, unknown>
  const triggers = (input.triggers ?? {}) as Record<string, unknown>

  const out: Settings = {
    apiKey: asString(input.apiKey, base.apiKey).trim(),
    model: asString(input.model, base.model),
    fastModel: asString(input.fastModel, base.fastModel),
    prompts: { ...base.prompts },
    dispatch: { ...base.dispatch },
    triggers: { ...base.triggers },
    enabled: input.enabled === undefined ? base.enabled : input.enabled !== false,
  }

  for (const kind of KINDS) {
    const prompt = prompts[kind]
    // An empty prompt is a configuration accident, not "no system prompt": §3.5 would then
    // send the model a blank system message, which is strictly worse than the default.
    if (typeof prompt === 'string' && prompt.trim().length > 0) out.prompts[kind] = prompt
    if (dispatch[kind] === 'immediate' || dispatch[kind] === 'manual') {
      out.dispatch[kind] = dispatch[kind]
    }
    out.triggers[kind] = asTrigger(triggers[kind], base.triggers[kind])
  }

  // Two modes bound to the same chord is not a preference, it is an ambiguity: `setModes` would
  // hand `createCommentEngine` two modes matching one `KeyboardEvent` with no defined
  // precedence, and which one placed a thread would depend on registration order. First kind
  // wins; the loser falls back to its default, which by construction does not collide.
  const claimed = new Set<string>()
  for (const kind of KINDS) {
    const chord = chordOf(out.triggers[kind])
    if (!claimed.has(chord)) {
      claimed.add(chord)
      continue
    }
    out.triggers[kind] = { ...out.triggers[kind], key: base.triggers[kind].key }
    claimed.add(chordOf(out.triggers[kind]))
  }

  return out
}

/** Case-insensitive key plus its modifier set — what actually has to be unique across modes. */
export function chordOf(trigger: TriggerSetting): string {
  const mods = (['alt', 'ctrl', 'meta', 'shift'] as const)
    .filter((name) => trigger.modifiers?.[name])
    .join('+')
  return `${trigger.key.toLowerCase()}|${mods}`
}

/* ------------------------------------------------------------------- i/o */

export async function loadSettings(kv: KeyValueAdapter): Promise<Settings> {
  // The legacy read is what stops the key's move into `exp-spec:host:*` from silently resetting
  // an existing profile — API key included — to defaults. Nothing ever writes that key again.
  const entries = await kv.get([SETTINGS_KEY, LEGACY_SETTINGS_KEY])
  return normalizeSettings(entries[SETTINGS_KEY] ?? entries[LEGACY_SETTINGS_KEY])
}

/** Read-modify-write, normalized on both ends. The options page is the only writer. */
export async function saveSettings(
  kv: KeyValueAdapter,
  patch: Partial<Settings>,
): Promise<Settings> {
  const next = normalizeSettings({ ...(await loadSettings(kv)), ...patch })
  await kv.set({ [SETTINGS_KEY]: next })
  return next
}

/**
 * Fires when the settings key itself changes. Deliberately narrower than a store subscription:
 * a thread write must not re-read settings in every tab.
 */
export function watchSettings(kv: KeyValueAdapter, onChange: () => void): () => void {
  if (!kv.watch) return () => {}
  return kv.watch((changed) => {
    if (changed.includes(SETTINGS_KEY)) onChange()
  })
}

/* ----------------------------------------------------------------- modes */

/** `Mode[]` for `createCommentEngine` / `engine.setModes`, derived from the trigger settings. */
export function modesFromSettings(settings: Settings): Array<{
  kind: string
  trigger: { key: string; modifiers?: TriggerSetting['modifiers']; interaction: 'pick' }
  badge?: { icon?: string; label?: string }
}> {
  return [
    {
      kind: 'comment',
      trigger: { ...settings.triggers.comment, interaction: 'pick' },
    },
    {
      kind: 'ask',
      trigger: { ...settings.triggers.ask, interaction: 'pick' },
      badge: { icon: '?', label: 'Ask' },
    },
  ]
}
