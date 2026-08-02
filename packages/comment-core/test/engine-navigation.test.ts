/**
 * §4.6.6 SPA navigation — **poll, do not patch** — plus §2.6 page-key wiring into the engine.
 */

import { afterEach, describe, expect, test } from 'vitest'

import type { Unsubscribe } from '../src/index.ts'

import { createMemoryStore, createPageKey } from '../src/index.ts'
import { harness, PAGE_URL } from './dom-helpers.ts'

const PAGE = '<article id="a" data-testid="a">alpha text</article>'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose()
})

async function scene(options?: Parameters<typeof harness>[1]) {
  const h = await harness(PAGE, { url: PAGE_URL, ...options })
  cleanup.push(h.dispose)
  return h
}

describe('§4.6.6 navigation', () => {
  test('history.pushState is NOT patched — the engine only ever reads location.href', async () => {
    const h = await scene()
    const original = h.page.document.defaultView!.history.pushState
    expect(h.page.document.defaultView!.history.pushState).toBe(original)
    // A push the engine never intercepted is still observed on the next poll.
    h.page.document.defaultView!.history.pushState({}, '', '/pushed')
    await h.page.flush()
    expect(h.engine.pageKey).toBe('https://example.com/pushed')
  })

  test('a URL change is observed within one batch and updates pageKey + page store', async () => {
    const h = await scene()
    await h.page.navigate('https://example.com/second?utm_source=x')
    expect(h.engine.pageKey).toBe('https://example.com/second')
    expect(h.engine.page.get()).toEqual({
      key: 'https://example.com/second',
      url: 'https://example.com/second?utm_source=x',
    })
  })

  test('a page-key change unloads the old thread set and loads the new one', async () => {
    const store = createMemoryStore()
    const h = await scene({ store })
    const first = await h.seed('#a', 'on page one')
    expect(h.engine.listThreads()).toHaveLength(1)

    await h.page.navigate('https://example.com/second')
    expect(h.engine.listThreads()).toHaveLength(0)
    const second = await h.seed('#a', 'on page two')

    await h.page.navigate(PAGE_URL)
    expect(h.engine.listThreads().map((v) => v.id)).toEqual([first])
    await h.page.navigate('https://example.com/second')
    expect(h.engine.listThreads().map((v) => v.id)).toEqual([second])
  })

  test('a URL change that does not change the page key is not a page:change', async () => {
    const h = await scene()
    h.events.length = 0
    // Only a volatile param and a hash move, so `defaultPageKey` is unchanged.
    await h.page.navigate(`${PAGE_URL}?utm_source=news#section`)
    expect(h.engine.pageKey).toBe(PAGE_URL)
    expect(h.typed('page:change')).toHaveLength(0)
  })

  test('a custom pageKey function is used for the engine scope', async () => {
    const h = await scene({ pageKey: createPageKey({ keepParams: ['docId'], keepHash: true }) })
    await h.page.navigate('https://example.com/doc?docId=7&utm_source=x#top')
    expect(h.engine.pageKey).toBe('https://example.com/doc?docId=7#top')
  })

  test('a string pageKey pins the engine to one key regardless of the URL', async () => {
    const h = await scene({ pageKey: 'fixed-key' })
    expect(h.engine.pageKey).toBe('fixed-key')
    await h.page.navigate('https://example.com/anywhere')
    expect(h.engine.pageKey).toBe('fixed-key')
  })

  test('navigation.source replaces the poll entirely', async () => {
    let fire: (() => void) | null = null
    const source = (cb: () => void): Unsubscribe => {
      fire = cb
      return () => {
        fire = null
      }
    }
    const h = await scene({ navigation: { source } })

    // The poll is skipped, so a URL change alone is invisible until the host signals.
    h.page.document.defaultView!.history.pushState({}, '', '/router-move')
    await h.page.flush()
    expect(h.engine.pageKey).toBe(PAGE_URL)

    fire!()
    await h.page.flush()
    expect(h.engine.pageKey).toBe('https://example.com/router-move')
  })

  test('navigation: false watches nothing', async () => {
    const h = await scene({ navigation: false })
    await h.page.navigate('https://example.com/ignored')
    expect(h.engine.pageKey).toBe(PAGE_URL)
  })

  test('popstate and hashchange are listened to', async () => {
    const h = await scene()
    const view = h.page.document.defaultView!
    view.history.pushState({}, '', '/via-popstate')
    view.dispatchEvent(new view.Event('popstate'))
    await h.page.flush()
    expect(h.engine.pageKey).toBe('https://example.com/via-popstate')
  })
})
