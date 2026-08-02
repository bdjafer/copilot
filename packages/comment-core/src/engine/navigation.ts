/**
 * SPA navigation (§4.6.6) — **poll, do not patch.**
 *
 * `history.pushState` / `replaceState` are deliberately NOT patched: in an MV3 content script
 * the isolated world has its own `history` binding, so a patch installed there never intercepts
 * the page's own calls and `page:change` would silently never fire on exactly the React/Next
 * apps this targets. Instead `popstate` / `hashchange` are listened to, and `location.href` is
 * compared at the head of every anchoring batch and on every `mouseover` / `keydown` the engine
 * already handles — a URL change is observed within one batch with no extra timer.
 *
 * A host with a better signal passes `navigation.source` and the poll is skipped entirely.
 */

import type { Unsubscribe } from '../types.ts'
import type { CommentEngineOptions } from './types.ts'

export interface NavigationWatcher {
  /** Current href, '' when there is no view. */
  href(): string
  /** Compare `location.href` against the last seen value. Cheap; called from hot paths. */
  poll(): void
  /** True when this watcher does its own polling (i.e. no injected source). */
  readonly polling: boolean
  stop(): void
}

type NavigationConfig = CommentEngineOptions['navigation']

export function createNavigationWatcher(deps: {
  document: Document
  config: NavigationConfig
  onChange: (href: string) => void
  onError: (error: unknown) => void
}): NavigationWatcher {
  const { document: doc, config } = deps
  const view = doc.defaultView

  const readHref = (): string => {
    try {
      return view?.location?.href ?? doc.URL ?? ''
    } catch {
      return ''
    }
  }

  let last = readHref()
  const disposers: Unsubscribe[] = []

  const enabled = config !== false && (config?.watch ?? true)
  const source = config === false ? undefined : config?.source
  const injected = typeof source === 'function' ? source : undefined

  function poll(): void {
    if (!enabled) return
    const href = readHref()
    if (href === last) return
    last = href
    try {
      deps.onChange(href)
    } catch (error) {
      deps.onError(error)
    }
  }

  if (enabled) {
    if (injected) {
      // A host signal replaces the poll entirely (§4.6.6).
      try {
        const unsubscribe = injected(() => {
          const href = readHref()
          if (href === last) return
          last = href
          deps.onChange(href)
        })
        if (typeof unsubscribe === 'function') disposers.push(unsubscribe)
      } catch (error) {
        deps.onError(error)
      }
    } else if (view) {
      const handler = (): void => poll()
      view.addEventListener('popstate', handler)
      view.addEventListener('hashchange', handler)
      disposers.push(() => {
        view.removeEventListener('popstate', handler)
        view.removeEventListener('hashchange', handler)
      })
    }
  }

  return {
    href: readHref,
    poll: injected ? () => {} : poll,
    polling: enabled && !injected,
    stop() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {
          // A host unsubscriber that throws must not block teardown.
        }
      }
    },
  }
}
