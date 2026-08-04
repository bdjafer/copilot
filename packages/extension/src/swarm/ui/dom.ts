/**
 * The renderer's primitives: node building, the one-glyph affordance, the arm/confirm gesture, the
 * 30×18 switch and the segmented value picker.
 *
 * **No platform global is named here.** Every function takes the `Document` it builds into, which
 * the presentation reads off `host.root.ownerDocument` — the same discipline `src/platform.ts`
 * imposes on the bridge, and the reason `test/dod.test.ts`'s "no module under src/ touches a
 * platform global" holds for this half of the head as well. It is also what lets the whole
 * rendering layer run under happy-dom with nothing stubbed.
 *
 * Three rules from DESIGN are implemented once, here, so no surface can get them wrong:
 *
 *  - **Every icon-only control carries a native `title` AND an `aria-label`** (§10). The tooltip is
 *    the browser's — zero bytes, OS-styled, positioned where it cannot cover content.
 *  - **A destructive control arms** (§6.4 `arm`): two clicks in place, the armed state is a *shape*
 *    (a 1.5 px danger ring) and not only a colour, and `Esc`, blur, any other click in the surface
 *    and a 4 s timeout all disarm. No second string, no dialog, no new label key.
 *  - **A boolean is a switch, never a glyph** (§8.8). Dispatch pause, follow-tail and the
 *    structured demand are all the same 30×18 control, and each keeps its sentence in `title`.
 */

import type { AffordanceId } from './intent-map.ts'
import type { GlyphId } from './sprite.ts'

import { affordance } from './intent-map.ts'
import { glyph } from './sprite.ts'

/** DESIGN §6.4: "the second, within 4 s, performs the delete". */
export const ARM_WINDOW_MS = 4000

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (className !== undefined) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** Write text only when it changed: a re-render must not reset a selection or blink a value. */
export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

export function setAttr(node: Element, name: string, value: string | null): void {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name)
    return
  }
  if (node.getAttribute(name) !== value) node.setAttribute(name, value)
}

/**
 * The arm registry — one per mount. It owns "which control is armed", because the disarm rules are
 * cross-control: arming a second destructive button must disarm the first, and any click anywhere
 * in the surface disarms whatever was armed.
 */
export interface ArmRegistry {
  /** Returns `true` when this click is the *confirming* one, `false` when it merely armed. */
  press(button: HTMLElement): boolean
  disarm(): void
  destroy(): void
}

export function createArmRegistry(doc: Document, windowMs = ARM_WINDOW_MS): ArmRegistry {
  const view = doc.defaultView
  let armed: HTMLElement | null = null
  let timer: number | null = null

  const clear = (): void => {
    if (timer !== null) view?.clearTimeout(timer)
    timer = null
    if (armed !== null) armed.removeAttribute('data-confirm')
    armed = null
  }

  return {
    press(button) {
      if (armed === button) {
        clear()
        return true
      }
      clear()
      armed = button
      button.setAttribute('data-confirm', '')
      /* A view is absent only in a detached document; the gesture still works, it just relies on
       * blur and the next click to disarm rather than on the clock. */
      timer = view?.setTimeout(clear, windowMs) ?? null
      return false
    },
    disarm: clear,
    destroy: clear,
  }
}

export interface GlyphButtonOptions {
  readonly id: AffordanceId
  readonly onPress: () => void
  readonly arm?: ArmRegistry
  /** Overrides the intent map's mark — the payload swap of §7 row 3, e.g. a failed verdict. */
  readonly glyphId?: GlyphId
  readonly size?: 10 | 12 | 16 | 20 | 22
  readonly tone?: 'accent'
}

/**
 * One mark, one sentence, one action. `data-affordance` is on the node so the suite can select a
 * control the way a user identifies it — by what it does — rather than by a CSS class.
 */
export function glyphButton(doc: Document, options: GlyphButtonOptions): HTMLButtonElement {
  const row = affordance(options.id)
  const button = el(doc, 'button', 'cc-btn')
  button.type = 'button'
  button.dataset.affordance = row.id
  button.title = row.label
  button.setAttribute('aria-label', row.label)
  if (options.tone !== undefined) button.dataset.tone = options.tone
  button.append(glyph(doc, options.glyphId ?? row.glyph, options.size ?? 16))
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    if (button.getAttribute('aria-disabled') === 'true') return
    if (row.arms && options.arm !== undefined && !options.arm.press(button)) return
    options.onPress()
  })
  return button
}

/**
 * The native tooltip and the accessible name are the **same sentence**, always. DESIGN §10 moves
 * every verb off the screen and into both of them at once; letting them drift would leave a
 * screen reader and a pointer user reading two different products.
 */
export function setLabel(node: Element, text: string): void {
  setAttr(node, 'title', text)
  setAttr(node, 'aria-label', text)
}

export function setDisabled(button: HTMLElement, disabled: boolean, why?: string): void {
  setAttr(button, 'aria-disabled', disabled ? 'true' : null)
  if (why !== undefined && disabled) setLabel(button, why)
}

/** DESIGN §8.8's switch. `label` is the sentence; the control draws no text (§10). */
export function switchControl(
  doc: Document,
  label: string,
  onToggle: (next: boolean) => void,
): HTMLButtonElement {
  const button = el(doc, 'button', 'cc-switch')
  button.type = 'button'
  button.setAttribute('role', 'switch')
  button.setAttribute('aria-checked', 'false')
  button.title = label
  button.setAttribute('aria-label', label)
  button.addEventListener('click', (event) => {
    event.stopPropagation()
    onToggle(button.getAttribute('aria-checked') !== 'true')
  })
  return button
}

export function setSwitch(button: HTMLElement, on: boolean): void {
  setAttr(button, 'aria-checked', on ? 'true' : 'false')
}

export interface Segmented {
  readonly node: HTMLDivElement
  /** Rebuilds only when the value list changed; selection is an attribute write. */
  render(values: readonly string[], selected: string | null, locked: boolean, why?: string): void
}

/**
 * The one-click picker. Effort, delivery mode and write mode are **values**, so §10 keeps their
 * words on screen — a picker whose options are unlabelled is the "unlabelled box with three
 * unlabelled icon-pills" DESIGN's own A1 amendment exists to prevent.
 */
export function segmented(
  doc: Document,
  label: string,
  onPick: (value: string) => void,
): Segmented {
  const node = el(doc, 'div', 'cc-seg')
  node.setAttribute('role', 'group')
  node.setAttribute('aria-label', label)
  let current: readonly string[] = []

  return {
    node,
    render(values, selected, locked, why) {
      if (values.length !== current.length || values.some((v, i) => v !== current[i])) {
        node.replaceChildren()
        for (const value of values) {
          const button = el(doc, 'button', undefined, value)
          button.type = 'button'
          button.dataset.value = value
          button.setAttribute('aria-pressed', 'false')
          button.addEventListener('click', (event) => {
            event.stopPropagation()
            if (node.dataset.locked === '1') return
            onPick(value)
          })
          node.append(button)
        }
        current = [...values]
      }
      for (const child of node.children) {
        setAttr(
          child,
          'aria-pressed',
          child.getAttribute('data-value') === selected ? 'true' : 'false',
        )
        setAttr(child, 'aria-disabled', locked ? 'true' : null)
      }
      setAttr(node, 'data-locked', locked ? '1' : null)
      setAttr(node, 'title', locked && why !== undefined ? why : label)
    },
  }
}

/**
 * A relative time, built from a **value** and therefore needing no label key (§10, §0 D2). Hover
 * *adds* the absolute datetime as a native `title` — additive only, per P0.
 */
export function relativeTime(at: number, now: number, locale?: string): string {
  const deltaMs = at - now
  const abs = Math.abs(deltaMs)
  const format = (value: number, unit: Intl.RelativeTimeFormatUnit): string =>
    new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.round(value), unit)
  if (abs < 60_000) return format(deltaMs / 1000, 'second')
  if (abs < 3_600_000) return format(deltaMs / 60_000, 'minute')
  if (abs < 86_400_000) return format(deltaMs / 3_600_000, 'hour')
  return format(deltaMs / 86_400_000, 'day')
}

/** `4 m 12 s`, tabular. Elapsed time is a value the watch surfaces show always (W8). */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${total % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function usd(value: number): string {
  return `$${value.toFixed(2)}`
}

/** A keyed list reconciler: the rows are stable across a render, so focus and scroll survive. */
export function reconcile<T>(
  parent: Element,
  items: readonly T[],
  keyOf: (item: T) => string,
  create: (item: T) => { node: Element; render: (item: T) => void },
  cache: Map<string, { node: Element; render: (item: T) => void }>,
): void {
  const seen = new Set<string>()
  let cursor: Element | null = parent.firstElementChild
  for (const item of items) {
    const key = keyOf(item)
    seen.add(key)
    let entry = cache.get(key)
    if (entry === undefined) {
      entry = create(item)
      cache.set(key, entry)
    }
    entry.render(item)
    if (cursor === entry.node) {
      cursor = cursor.nextElementSibling
      continue
    }
    parent.insertBefore(entry.node, cursor)
  }
  for (const [key, entry] of cache) {
    if (seen.has(key)) continue
    entry.node.remove()
    cache.delete(key)
  }
}
