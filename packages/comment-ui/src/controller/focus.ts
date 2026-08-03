/**
 * Focus policy (§3.1.6, decision log #35) and the Esc chain.
 *
 * Focus **policy** is the controller's; focus **execution** is split. The controller focuses
 * elements it captured itself — the host page element that had focus at trigger time, which no
 * presentation can name. It asks the presentation for its own nodes through `vm.focus`: apply
 * the target whenever `focus.seq` changes, then do nothing until it changes again. A monotonic
 * seq is the smallest thing that survives a re-render without an acknowledgement channel, and it
 * keeps the model serializable — a node reference would not.
 *
 * The a11y contract of §3 is normative and identical across presentations, which is exactly why
 * its policy cannot live in a swappable layer.
 */

import type { FocusTarget } from '../presentation.ts'

import { deepActiveElement, safeFocus } from '../dom.ts'

export interface FocusSlot {
  focus: { seq: number; target: FocusTarget } | null
}

export interface FocusDeps {
  readonly doc: Document
  readonly root: ShadowRoot
  readonly slot: FocusSlot
  /** The surface key a node was registered under, or null when it is not ours. */
  keyOf(node: Node | null): string | null
  schedule(): void
}

export interface FocusPolicy {
  /** Ask the presentation to move focus. Idempotent for the presentation; monotonic here. */
  request(target: FocusTarget): void
  /**
   * Remember where focus goes when the composer closes: the invoking badge for a reply, else
   * whatever had focus at trigger time — ours (named by surface key) or the host page's (held
   * as a node, because only the controller can focus it).
   */
  capture(replyTo: string | null): void
  restore(): void
  clear(): void
}

function targetForKey(key: string): FocusTarget | null {
  if (key.startsWith('badge:')) return { kind: 'badge', threadId: key.slice('badge:'.length) }
  if (key === 'panel-toggle') return { kind: 'panel-toggle' }
  if (key === 'thread') return { kind: 'thread-close' }
  return null
}

export function createFocusPolicy(deps: FocusDeps): FocusPolicy {
  let seq = 0
  let pendingTarget: FocusTarget | null = null
  let pendingElement: HTMLElement | null = null

  const request = (target: FocusTarget): void => {
    seq += 1
    deps.slot.focus = { seq, target }
    deps.schedule()
  }

  return {
    request,

    capture(replyTo) {
      pendingTarget = null
      pendingElement = null
      if (replyTo !== null) {
        pendingTarget = { kind: 'badge', threadId: replyTo }
        return
      }
      // `document.activeElement` retargets to the shadow HOST, so restoring focus after the
      // composer closes needs the real node, not its host.
      const node = deepActiveElement(deps.doc)
      const key = deps.keyOf(node)
      if (key) {
        pendingTarget = targetForKey(key)
        if (pendingTarget) return
      }
      if (node && !deps.root.contains(node)) pendingElement = node
    },

    restore() {
      const target = pendingTarget
      const element = pendingElement
      pendingTarget = null
      pendingElement = null
      if (target) {
        request(target)
        return
      }
      if (element?.isConnected) safeFocus(element)
    },

    clear() {
      pendingTarget = null
      pendingElement = null
    },
  }
}
