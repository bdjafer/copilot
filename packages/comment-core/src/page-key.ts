/**
 * Page key (SPEC-comment-core §2.6).
 *
 * origin + pathname + query minus volatile params; hash stripped; trailing slash stripped;
 * remaining params sorted alphabetically so `?a=1&b=2` and `?b=2&a=1` produce one key.
 *
 * DOM-free: `URL` / `URLSearchParams` are ES/WHATWG globals present in `lib.webworker`.
 */

import type { PageKeyFn, PageKeyOptions } from './types.ts'

/**
 * utm_*, gclid, fbclid, msclkid, ref, and session/token-looking params. Extendable by hosts
 * through `PageKeyOptions.dropParams`; individual names can be rescued with `keepParams`.
 * No `g` flag anywhere: a stateful `lastIndex` would make the same param drop only every
 * other call.
 */
export const volatileParams: readonly RegExp[] = Object.freeze([
  /^utm_/i,
  /^gclid$/i,
  /^fbclid$/i,
  /^msclkid$/i,
  /^ref$/i,
  /^(sid|sess|session|session_id|sessionid|token|access_token|id_token|refresh_token|auth|authtoken|api_key|apikey|nonce|state)$/i,
  /(^|[_-])(session|token)([_-]|$)/i,
])

function isDropped(name: string, dropParams: readonly (string | RegExp)[]): boolean {
  for (const rule of volatileParams) if (rule.test(name)) return true
  for (const rule of dropParams) {
    if (typeof rule === 'string' ? rule === name : rule.test(name)) return true
  }
  return false
}

/** origin + pathname + query minus volatileParams; hash stripped; trailing slash stripped. */
export function defaultPageKey(url: URL, options?: PageKeyOptions): string {
  const dropParams = options?.dropParams ?? []
  const keep = new Set(options?.keepParams ?? [])
  const keepHash = options?.keepHash ?? false
  const trailingSlash = options?.trailingSlash ?? 'strip'

  const pathname = trailingSlash === 'strip' ? url.pathname.replace(/\/+$/, '') : url.pathname

  const params: [string, string][] = []
  for (const [name, value] of url.searchParams) {
    // keepParams wins over every drop rule, volatile or host-supplied.
    if (keep.has(name) || !isDropped(name, dropParams)) params.push([name, value])
  }
  params.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0,
  )

  const search = new URLSearchParams(params).toString()
  return `${url.origin}${pathname}${search ? `?${search}` : ''}${keepHash ? url.hash : ''}`
}

/** Curried `defaultPageKey`, for `createCommentEngine({ pageKey: createPageKey({...}) })`. */
export function createPageKey(options?: PageKeyOptions): PageKeyFn {
  return (url: URL) => defaultPageKey(url, options)
}
