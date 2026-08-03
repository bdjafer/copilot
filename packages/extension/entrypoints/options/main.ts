/**
 * The options page (PLAN §4.6). Plain TS, no framework, deliberately minimal: API key, model
 * picker, per-kind system prompt, per-kind dispatch policy, per-kind trigger key.
 *
 * The DOM wiring lives here; every rule about *what a valid setting is* lives in
 * `src/settings.ts`, which is pure and tested. This file is the part a browser has to run.
 */

import { browser } from 'wxt/browser'

import type { StorageLike } from '../../src/platform.ts'
import type { Kind, Settings } from '../../src/settings.ts'

import { createStorageKv } from '../../src/kv.ts'
import {
  chordOf,
  defaultSettings,
  KINDS,
  loadSettings,
  MODEL_CHOICES,
  saveSettings,
} from '../../src/settings.ts'

const kv = createStorageKv((browser as unknown as { storage: StorageLike }).storage)

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id)
  if (!node) throw new Error(`options: missing #${id}`)
  return node as T
}

const KIND_LABEL: Record<Kind, string> = {
  comment: 'comment — review participant',
  ask: 'ask — question answerer',
}

interface KindControls {
  prompt: HTMLTextAreaElement
  dispatch: HTMLSelectElement
  key: HTMLInputElement
}

function buildKinds(): Record<Kind, KindControls> {
  const host = el<HTMLDivElement>('kinds')
  const controls = {} as Record<Kind, KindControls>

  for (const kind of KINDS) {
    const box = document.createElement('div')
    box.className = 'kind'

    const title = document.createElement('h3')
    title.textContent = KIND_LABEL[kind]
    box.append(title)

    const row = document.createElement('div')
    row.className = 'row field'

    const dispatchWrap = document.createElement('div')
    const dispatchLabel = document.createElement('label')
    dispatchLabel.htmlFor = `dispatch-${kind}`
    dispatchLabel.textContent = 'Dispatch'
    const dispatch = document.createElement('select')
    dispatch.id = `dispatch-${kind}`
    for (const [value, text] of [
      ['immediate', 'immediate — run on every comment'],
      ['manual', 'manual — batch, sent from the pill'],
    ] as const) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = text
      dispatch.append(option)
    }
    dispatchWrap.append(dispatchLabel, dispatch)

    const keyWrap = document.createElement('div')
    const keyLabel = document.createElement('label')
    keyLabel.htmlFor = `key-${kind}`
    keyLabel.textContent = 'Trigger key'
    const key = document.createElement('input')
    key.id = `key-${kind}`
    key.type = 'text'
    key.maxLength = 1
    key.size = 3
    key.autocomplete = 'off'
    const keyHint = document.createElement('p')
    keyHint.className = 'hint'
    keyHint.textContent = 'One character. Ignored while an editable field has focus.'
    keyWrap.append(keyLabel, key, keyHint)

    row.append(dispatchWrap, keyWrap)

    const promptLabel = document.createElement('label')
    promptLabel.htmlFor = `prompt-${kind}`
    promptLabel.textContent = 'System prompt'
    const prompt = document.createElement('textarea')
    prompt.id = `prompt-${kind}`
    prompt.spellcheck = false
    const promptField = document.createElement('div')
    promptField.className = 'field'
    promptField.append(promptLabel, prompt)

    box.append(row, promptField)
    host.append(box)
    controls[kind] = { prompt, dispatch, key }
  }

  return controls
}

function fillModelSelect(select: HTMLSelectElement): void {
  for (const choice of MODEL_CHOICES) {
    const option = document.createElement('option')
    option.value = choice.id
    option.textContent = choice.label
    select.append(option)
  }
}

const apiKey = el<HTMLInputElement>('apiKey')
const model = el<HTMLSelectElement>('model')
const fastModel = el<HTMLSelectElement>('fastModel')
const enabled = el<HTMLInputElement>('enabled')
const status = el<HTMLSpanElement>('status')
const kinds = buildKinds()

fillModelSelect(model)
fillModelSelect(fastModel)

/**
 * The last settings this page loaded or saved.
 *
 * `collect()` reads it for the parts of `Settings` the form has no control for — today the
 * trigger **modifiers**. Rebuilding a trigger from the text input alone silently dropped any
 * stored `{ alt, ctrl, meta, shift }` on every Save, so a modifier set anywhere but here (or in
 * a future control) survived exactly until the next click.
 */
let current: Settings = defaultSettings()

function render(settings: Settings): void {
  current = settings
  apiKey.value = settings.apiKey
  model.value = settings.model
  fastModel.value = settings.fastModel
  enabled.checked = settings.enabled
  for (const kind of KINDS) {
    kinds[kind].prompt.value = settings.prompts[kind]
    kinds[kind].dispatch.value = settings.dispatch[kind]
    kinds[kind].key.value = settings.triggers[kind].key
  }
}

function collect(): Partial<Settings> {
  const prompts = {} as Settings['prompts']
  const dispatch = {} as Settings['dispatch']
  const triggers = {} as Settings['triggers']
  for (const kind of KINDS) {
    prompts[kind] = kinds[kind].prompt.value
    dispatch[kind] = kinds[kind].dispatch.value === 'immediate' ? 'immediate' : 'manual'
    const modifiers = current.triggers[kind].modifiers
    triggers[kind] = { key: kinds[kind].key.value, ...(modifiers ? { modifiers } : {}) }
  }
  return {
    apiKey: apiKey.value,
    model: model.value,
    fastModel: fastModel.value,
    enabled: enabled.checked,
    prompts,
    dispatch,
    triggers,
  }
}

function say(text: string, tone: 'ok' | 'warn' | '' = ''): void {
  status.textContent = text
  if (tone) status.setAttribute('data-tone', tone)
  else status.removeAttribute('data-tone')
}

el<HTMLButtonElement>('save').addEventListener('click', () => {
  void (async () => {
    const patch = collect()
    // Two modes on one chord have no defined precedence in the engine, so `normalizeSettings`
    // resolves it by falling back to the default key — silently. Saying so is the difference
    // between "my key did not stick" and a rule the user can act on.
    const chords = KINDS.map((kind) => chordOf(patch.triggers![kind]))
    const collided = new Set(chords).size !== chords.length
    // Normalization is `saveSettings`'s job, and it rewrites what it stored back into the form —
    // so a rejected trigger key visibly snaps back rather than looking accepted.
    const saved = await saveSettings(kv, patch)
    render(saved)
    if (collided) {
      say('Each mode needs its own trigger key — the duplicate was reset to its default.', 'warn')
      return
    }
    say(
      saved.apiKey ? 'Saved.' : 'Saved — but the copilot needs an API key to run.',
      saved.apiKey ? 'ok' : 'warn',
    )
  })()
})

el<HTMLButtonElement>('reset').addEventListener('click', () => {
  void (async () => {
    // The key is a credential, not a preference: "restore defaults" must not silently wipe it.
    const saved = await saveSettings(kv, { ...defaultSettings(), apiKey: apiKey.value })
    render(saved)
    say('Defaults restored (API key kept).', 'ok')
  })()
})

void loadSettings(kv).then((settings) => {
  render(settings)
  if (!settings.apiKey) say('Add an Anthropic API key to enable the copilot.', 'warn')
})
