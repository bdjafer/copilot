/**
 * The placement cursor (§3.1.4 `PresentationHost.cursor`, decision log #46, DESIGN §0 D7, §8.2).
 *
 * §0 D7 makes the cursor the entire placement-mode signal, and a `pointer-events: none` layer
 * cannot set a cursor — so this is the one thing in `comment-ui` that reaches the host document,
 * and it is deliberately owned by the **controller** rather than by a presentation: a
 * presentation supplies a string, so "no presentation touches the host document" stays a rule
 * the type system enforces, and the lifetime — the part that actually risks leaving a comment
 * cursor on someone's page forever — lives in the layer that already owns every other teardown.
 *
 * **Why `adoptedStyleSheets` and nothing else.** §3's rule is "the host page's DOM is never
 * mutated", and DESIGN §11 rule 7 defines that literally: no node inserted or removed, no
 * attribute written, **no `MutationObserver` record generated**. A constructed stylesheet pushed
 * onto `document.adoptedStyleSheets` satisfies every clause — it is a document *property*, invisible
 * to the page's own observers, which is exactly what the React and Next apps this ships onto
 * would otherwise react to. An injected `<style>` node is observable and survives a crash; a
 * `documentElement.style` write collides with the page's own and cannot be reverted precisely.
 * Both stay forbidden.
 *
 * Every exit pops it: a new value, `null`, `Esc`, `page:change`, `unmount()`, a presentation
 * fault, and the `finally` of the render pass.
 */

export interface CursorSheet {
  /** Apply a complete CSS `cursor` value to the host document, or `null` to clear it. */
  set(value: string | null): void
  /** Current value, for diagnostics and tests. */
  readonly value: string | null
  destroy(): void
}

interface AdoptingDocument extends Document {
  adoptedStyleSheets: CSSStyleSheet[]
}

export function createCursorSheet(doc: Document, win: Window): CursorSheet {
  const Ctor = (win as { CSSStyleSheet?: typeof CSSStyleSheet }).CSSStyleSheet
  let sheet: CSSStyleSheet | null = null
  let current: string | null = null

  const host = doc as Partial<AdoptingDocument>

  function pop(): void {
    if (!sheet || !Array.isArray(host.adoptedStyleSheets)) return
    host.adoptedStyleSheets = host.adoptedStyleSheets.filter((entry) => entry !== sheet)
    sheet = null
  }

  return {
    get value() {
      return current
    },

    set(value) {
      if (value === current) return
      current = value
      if (value === null) {
        pop()
        return
      }
      // `!important` because the host page's own `cursor` declarations are more specific than
      // anything we could write, and this must win for the seconds a pick lasts.
      const css = `*, *::before, *::after { cursor: ${value} !important; }`
      try {
        if (!sheet) {
          if (typeof Ctor !== 'function' || !Array.isArray(host.adoptedStyleSheets)) return
          sheet = new Ctor()
          sheet.replaceSync(css)
          host.adoptedStyleSheets = [...host.adoptedStyleSheets, sheet]
          return
        }
        sheet.replaceSync(css)
      } catch {
        // A document that refuses a constructed sheet (an old engine, a stubbed DOM) simply
        // keeps its own cursor. `Labels.pickHint` is in `role="status"` either way.
        sheet = null
      }
    },

    destroy() {
      current = null
      pop()
    },
  }
}
