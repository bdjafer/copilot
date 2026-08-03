import { describe, expect, it, vi } from 'vitest'

import { LEGACY_SETTINGS_KEY, SETTINGS_KEY } from '../src/keys.ts'
import { createStorageKv } from '../src/kv.ts'
import {
  BATCH_PROMPT,
  chordOf,
  DEFAULT_FAST_MODEL,
  DEFAULT_PRIMARY_MODEL,
  DEFAULT_PROMPTS,
  defaultSettings,
  isKind,
  KINDS,
  loadSettings,
  MODEL_CHOICES,
  modesFromSettings,
  normalizeSettings,
  saveSettings,
  watchSettings,
} from '../src/settings.ts'
import { createFakeStorage } from './support/fake-chrome.ts'

const kv = () => createStorageKv(createFakeStorage())

describe('defaults (PLAN §4.6 / §5)', () => {
  it('ships the two PLAN §5 modes and nothing else', () => {
    expect([...KINDS]).toEqual(['comment', 'ask'])
  })

  it('defaults comment to manual batching and ask to immediate', () => {
    // The GitHub-review pattern: a question wants its answer now; a review accumulates.
    const settings = defaultSettings()
    expect(settings.dispatch).toEqual({ comment: 'manual', ask: 'immediate' })
  })

  it('defaults to claude-opus-5 with claude-haiku-4-5 as the fast tier', () => {
    const settings = defaultSettings()
    expect(settings.model).toBe('claude-opus-5')
    expect(settings.fastModel).toBe('claude-haiku-4-5')
    expect(MODEL_CHOICES.map((choice) => choice.id)).toEqual([
      DEFAULT_PRIMARY_MODEL,
      DEFAULT_FAST_MODEL,
    ])
  })

  it('ships a distinct prompt per kind plus a batch prompt', () => {
    expect(DEFAULT_PROMPTS.comment).not.toBe(DEFAULT_PROMPTS.ask)
    // The review-participant prompt must forbid resolving: "the copilot may suggest, never execute".
    expect(DEFAULT_PROMPTS.comment).toMatch(/never resolve/i)
    // The answerer prompt leads with the answer rather than a discussion turn.
    expect(DEFAULT_PROMPTS.ask).toMatch(/answer the question/i)
    // The batch prompt is the only one that names the batch-only tool.
    expect(BATCH_PROMPT).toContain('reply_to_thread')
    expect(DEFAULT_PROMPTS.comment).not.toContain('reply_to_thread')
  })

  it('defaults the trigger keys to c and a', () => {
    const settings = defaultSettings()
    expect(settings.triggers.comment.key).toBe('c')
    expect(settings.triggers.ask.key).toBe('a')
  })

  it('starts with no API key and enabled', () => {
    expect(defaultSettings().apiKey).toBe('')
    expect(defaultSettings().enabled).toBe(true)
  })
})

describe('normalizeSettings is total', () => {
  it('accepts null, undefined and a non-object', () => {
    for (const bad of [null, undefined, 42, 'nope', []]) {
      expect(normalizeSettings(bad)).toEqual(defaultSettings())
    }
  })

  it('keeps valid members and defaults the invalid ones alongside them', () => {
    const out = normalizeSettings({
      apiKey: '  sk-ant-x  ',
      model: 'claude-haiku-4-5',
      dispatch: { comment: 'immediate', ask: 'nonsense' },
      triggers: { comment: { key: 'zz' }, ask: { key: 'q', modifiers: { shift: true, bogus: 1 } } },
      prompts: { comment: '   ', ask: 'answer things' },
    })
    expect(out.apiKey).toBe('sk-ant-x')
    expect(out.model).toBe('claude-haiku-4-5')
    // `ask` was garbage, so it falls back to its own default (`immediate`) — not to the other
    // kind's, and not to a hard-coded 'manual'.
    expect(out.dispatch).toEqual({ comment: 'immediate', ask: 'immediate' })
    // A two-character key would never match `KeyboardEvent.key` for a letter press.
    expect(out.triggers.comment.key).toBe('c')
    expect(out.triggers.ask).toEqual({ key: 'q', modifiers: { shift: true } })
    // An empty prompt is a configuration accident, not "no system prompt".
    expect(out.prompts.comment).toBe(DEFAULT_PROMPTS.comment)
    expect(out.prompts.ask).toBe('answer things')
  })

  it('treats a missing `enabled` as true and an explicit false as false', () => {
    expect(normalizeSettings({}).enabled).toBe(true)
    expect(normalizeSettings({ enabled: false }).enabled).toBe(false)
    expect(normalizeSettings({ enabled: 'yes' }).enabled).toBe(true)
  })

  it('drops an empty modifiers object rather than storing one', () => {
    expect(
      normalizeSettings({ triggers: { comment: { key: 'c', modifiers: {} } } }).triggers.comment,
    ).toEqual({ key: 'c' })
  })

  it('never shares mutable state with the defaults', () => {
    const a = defaultSettings()
    a.prompts.comment = 'mutated'
    a.triggers.comment.key = 'z'
    expect(defaultSettings().prompts.comment).toBe(DEFAULT_PROMPTS.comment)
    expect(defaultSettings().triggers.comment.key).toBe('c')
  })
})

describe('persistence', () => {
  it('loads defaults from an empty store', async () => {
    expect(await loadSettings(kv())).toEqual(defaultSettings())
  })

  it('save is a normalized read-modify-write and survives the JSON round trip', async () => {
    const storage = createFakeStorage()
    const store = createStorageKv(storage)
    await saveSettings(store, { apiKey: 'sk-1' })
    const saved = await saveSettings(store, { dispatch: { comment: 'immediate', ask: 'manual' } })
    expect(saved.apiKey).toBe('sk-1')
    expect(saved.dispatch.comment).toBe('immediate')
    expect(await loadSettings(store)).toEqual(saved)
    expect(Object.keys(storage.dump())).toEqual([SETTINGS_KEY])
  })

  it('save normalizes garbage the options page might collect', async () => {
    const store = kv()
    const saved = await saveSettings(store, { model: 42 as unknown as string })
    expect(saved.model).toBe(DEFAULT_PRIMARY_MODEL)
  })

  it('watchSettings fires only for the settings key', async () => {
    const store = kv()
    const onChange = vi.fn()
    const off = watchSettings(store, onChange)
    await store.set({ 'exp-spec:t:x:y': 1 })
    expect(onChange).not.toHaveBeenCalled()
    await store.set({ [SETTINGS_KEY]: {} })
    expect(onChange).toHaveBeenCalledTimes(1)
    off()
    await store.set({ [SETTINGS_KEY]: {} })
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  it('watchSettings degrades to a no-op when the adapter cannot watch', () => {
    const bare = { ...kv(), watch: undefined }
    expect(() => watchSettings(bare, () => {})()).not.toThrow()
  })
})

describe('modesFromSettings', () => {
  it('maps the trigger settings onto comment-core Mode entries', () => {
    const modes = modesFromSettings(defaultSettings())
    expect(modes.map((mode) => mode.kind)).toEqual(['comment', 'ask'])
    expect(modes[0]!.trigger).toEqual({ key: 'c', interaction: 'pick' })
    expect(modes[1]!.badge).toEqual({ icon: '?', label: 'Ask' })
  })

  it('carries a custom key and modifiers through', () => {
    const settings = defaultSettings()
    settings.triggers.ask = { key: 'q', modifiers: { alt: true } }
    const modes = modesFromSettings(settings)
    expect(modes[1]!.trigger).toEqual({ key: 'q', modifiers: { alt: true }, interaction: 'pick' })
  })
})

describe('isKind', () => {
  it('narrows only the two shipped kinds', () => {
    expect(isKind('comment')).toBe(true)
    expect(isKind('ask')).toBe(true)
    expect(isKind('triage')).toBe(false)
    expect(isKind(undefined)).toBe(false)
  })
})

describe('trigger chords must be unique', () => {
  it('resolves two modes on one key instead of handing the engine an ambiguity', () => {
    // `setModes` would otherwise register two modes matching the same KeyboardEvent, and which
    // one placed a thread would depend on registration order. The options form has no way to
    // express "the same key twice" deliberately.
    const out = normalizeSettings({
      triggers: { comment: { key: 'x' }, ask: { key: 'x' } },
    })
    expect(out.triggers.comment.key).toBe('x')
    expect(out.triggers.ask.key).toBe('a') // its default, which cannot collide
  })

  it('treats case as the same chord, and a different modifier set as a different one', () => {
    expect(
      normalizeSettings({ triggers: { comment: { key: 'x' }, ask: { key: 'X' } } }).triggers.ask
        .key,
    ).toBe('a')
    const distinct = normalizeSettings({
      triggers: { comment: { key: 'x' }, ask: { key: 'x', modifiers: { alt: true } } },
    })
    expect(distinct.triggers.ask).toEqual({ key: 'x', modifiers: { alt: true } })
  })

  it('chordOf is what both the normalizer and the options page compare on', () => {
    expect(chordOf({ key: 'C' })).toBe(chordOf({ key: 'c' }))
    expect(chordOf({ key: 'c', modifiers: { alt: true } })).not.toBe(chordOf({ key: 'c' }))
  })
})

describe('the settings key moved into the host range', () => {
  it('reads a profile written at the old top-level key', async () => {
    // Otherwise the move silently resets an existing install — API key included — to defaults.
    const adapter = kv()
    await adapter.set({ [LEGACY_SETTINGS_KEY]: { ...defaultSettings(), apiKey: 'sk-legacy' } })
    expect((await loadSettings(adapter)).apiKey).toBe('sk-legacy')
  })

  it('prefers the new key once anything has been saved', async () => {
    const adapter = kv()
    await adapter.set({ [LEGACY_SETTINGS_KEY]: { ...defaultSettings(), apiKey: 'sk-legacy' } })
    await saveSettings(adapter, { apiKey: 'sk-new' })
    expect((await loadSettings(adapter)).apiKey).toBe('sk-new')
    // …and the legacy key is never written again.
    expect(SETTINGS_KEY).not.toBe(LEGACY_SETTINGS_KEY)
  })
})
