/**
 * The whole "framework" (§5.2 `dom.ts`): an `el()` helper, a keyed list reconciler and two
 * focus utilities. No virtual DOM, no reactivity — a presentation is handed a frozen
 * `UIViewModel` and re-reads it on every coalesced pass.
 *
 * **Shared by the controller and by every presentation**, which is why it lives above
 * `src/presentations/` and imports nothing: a helper that reached the engine would put the
 * engine one `import` away from a presentation, and the dependency rule would stop being a
 * mechanical property of the tree.
 *
 * Keyed reconciliation (rather than `innerHTML = ''` + rebuild) is not a performance nicety:
 * blowing away the subtree on every notification would destroy the element that has focus,
 * which breaks the composer, the inline comment editor and every keyboard user.
 */

export type AttrValue = string | number | boolean | null | undefined

export function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs?: Record<string, AttrValue>,
  children?: readonly (Node | string)[],
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag)
  if (attrs) setAttrs(node, attrs)
  if (children) for (const child of children) node.append(child as Node | string)
  return node
}

export function setAttrs(node: Element, attrs: Record<string, AttrValue>): void {
  for (const [name, value] of Object.entries(attrs)) setAttr(node, name, value)
}

/** `false` / `null` / `undefined` remove the attribute; `true` sets it to `''`. */
export function setAttr(node: Element, name: string, value: AttrValue): void {
  if (value === null || value === undefined || value === false) {
    if (node.hasAttribute(name)) node.removeAttribute(name)
    return
  }
  const next = value === true ? '' : String(value)
  if (node.getAttribute(name) !== next) node.setAttribute(name, next)
}

/** Idempotent text write — never touches the DOM when the text is unchanged. */
export function setText(node: Element, text: string): void {
  if (node.textContent !== text) node.textContent = text
}

const registry = new WeakMap<Element, Map<string, Element>>()

/**
 * Keyed list reconcile. Existing nodes are reused (and reordered) rather than recreated, so a
 * focused control inside a row survives a re-render.
 */
export function reconcile<T, E extends Element>(
  parent: Element,
  items: readonly T[],
  key: (item: T) => string,
  create: (item: T) => E,
  update: (node: E, item: T) => void,
  destroy?: (node: E) => void,
): Map<string, E> {
  const previous = (registry.get(parent) ?? new Map()) as Map<string, E>
  const next = new Map<string, E>()

  for (const item of items) {
    const id = key(item)
    if (next.has(id)) continue // duplicate keys would corrupt the ordering pass
    const node = previous.get(id) ?? create(item)
    update(node, item)
    next.set(id, node)
  }

  for (const [id, node] of previous) {
    if (next.has(id)) continue
    destroy?.(node)
    node.remove()
  }

  let index = 0
  for (const node of next.values()) {
    if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null)
    index += 1
  }

  registry.set(parent, next as Map<string, Element>)
  return next
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])'

export function focusables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (node) => !node.hasAttribute('hidden') && node.getAttribute('aria-hidden') !== 'true',
  )
}

/**
 * The deepest active element. `document.activeElement` retargets to the shadow **host**, so
 * restoring focus after the composer closes needs the real node, not its host.
 */
export function deepActiveElement(doc: Document): HTMLElement | null {
  let node: Element | null = doc.activeElement
  while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement
  return node instanceof (doc.defaultView?.HTMLElement ?? HTMLElement) ? node : null
}

/** `focus()` must never take down a render pass (jsdom/happy-dom quirks, detached nodes). */
export function safeFocus(node: HTMLElement | null | undefined): void {
  if (!node) return
  try {
    node.focus()
  } catch {
    /* best effort */
  }
}

/**
 * `lib.dom` types `showPopover` as always present; the runtimes this has to survive
 * (happy-dom, pre-2024 Safari) do not have it, so it is re-typed as optional for the guard.
 */
interface PopoverElement {
  showPopover?: () => void
  hidePopover?: () => void
}

/**
 * Top-layer show/hide for the composer and the thread popover.
 *
 * `[popover]` is what escapes every page stacking context — no z-index wars, whatever the host
 * page's CSS does. It is **not** the visibility mechanism though: `data-open` is, because the
 * author stylesheet beats the UA's `[popover]:not(:popover-open) { display: none }` in every
 * origin, so the same markup degrades to an ordinary absolutely-positioned box wherever
 * `showPopover` is missing (happy-dom, pre-2024 Safari) instead of rendering nothing.
 */
export function showFloating(node: HTMLElement): void {
  if (node.getAttribute('data-open') === 'true') return
  node.setAttribute('data-open', 'true')
  const popover = node as unknown as PopoverElement
  if (typeof popover.showPopover !== 'function') return
  try {
    popover.showPopover()
  } catch {
    /* already open, or no top-layer support */
  }
}

export function hideFloating(node: HTMLElement): void {
  if (node.getAttribute('data-open') !== 'true') return
  node.setAttribute('data-open', 'false')
  const popover = node as unknown as PopoverElement
  if (typeof popover.hidePopover !== 'function') return
  try {
    popover.hidePopover()
  } catch {
    /* already closed */
  }
}
