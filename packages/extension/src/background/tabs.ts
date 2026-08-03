/**
 * pageKey → tabId, recomputed from `tabs.query` on every call.
 *
 * **Not a cached map, deliberately.** A map in worker memory dies with the worker every 30 s,
 * and a run that outlives its worker would then find "no open tab" for a page that is right
 * there. `tabs.query` is the only source of truth that survives, and `defaultPageKey` over
 * `tab.url` is the same function the content script's engine used to derive the key — so the
 * two agree without either persisting anything.
 */

import { defaultPageKey } from '@astrale-os/comment-core/headless'

import type { TabsLike } from '../platform.ts'
import type { TabRouter } from './tools.ts'

export function createTabRouter(tabs: TabsLike): TabRouter {
  return {
    async tabsForPageKey(pageKey) {
      const open = await tabs.query({})
      const found: number[] = []
      for (const tab of open) {
        if (tab.id === undefined || !tab.url) continue
        let key: string
        try {
          key = defaultPageKey(new URL(tab.url))
        } catch {
          continue // chrome://, about:blank and friends are not pages we anchor to
        }
        // Plural: the same document open in two tabs must get the chip in both. A tool call
        // takes the first of these; a notification takes all of them.
        if (key === pageKey) found.push(tab.id)
      }
      return found
    },
  }
}
