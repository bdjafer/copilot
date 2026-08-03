/**
 * `material.html`'s loader — the five gates of DESIGN §9, and nothing else.
 *
 * The page is **complete before this file runs**: the lozenge, its rim, its shadow and its drift
 * are CSS, and they are correct on their own. What is below decides whether the page has earned
 * the right to spend a little more of the machine on an upgrade, and it says no by default.
 *
 * All five must hold, and they are checked in cheapest-first order so a machine that fails on
 * `hardwareConcurrency` never installs an observer:
 *
 *   1. `prefers-reduced-motion: no-preference`  — a stated preference outranks a design.
 *   2. `navigator.deviceMemory >= 4`
 *   3. `navigator.hardwareConcurrency > 4`
 *   4. the effect is actually supported by this engine
 *   5. the stage is at least 25 % visible, and then the browser goes idle
 *
 * The import is **dynamic and it is the last line** — a static import would defeat every gate
 * above it, because the bytes would already be on the wire before the first one was evaluated.
 * That is the difference this file exists to make, and it is what the test asserts.
 */

const GATES = ['motion', 'memory', 'cores', 'support', 'viewport']

/**
 * @param {HTMLElement} stage
 * @param {(state: { loaded: boolean, blockedBy: string | null }) => void} report
 * @returns {() => void} teardown
 */
export function upgradeMaterial(stage, report = () => {}) {
  const win = stage.ownerDocument.defaultView ?? globalThis
  let lens = null
  let observer = null
  let disposed = false

  const fail = (gate) => {
    report({ loaded: false, blockedBy: gate })
    return () => {}
  }

  if (!win.matchMedia?.('(prefers-reduced-motion: no-preference)').matches) return fail('motion')
  if ((win.navigator.deviceMemory ?? 0) < 4) return fail('memory')
  if ((win.navigator.hardwareConcurrency ?? 0) <= 4) return fail('cores')

  const idle = win.requestIdleCallback ?? ((fn) => win.setTimeout(fn, 200))

  observer = new win.IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (disposed) return
        if (entry.isIntersecting && entry.intersectionRatio >= 0.25) {
          if (lens) continue
          idle(() => {
            if (disposed || lens) return
            // The one dynamic import on this page. Nothing above it has touched the module.
            void import('./material-lens.js')
              .then((module) => {
                if (disposed || lens) return
                if (!module.supported(win)) {
                  report({ loaded: false, blockedBy: 'support' })
                  return
                }
                lens = module.createLens(stage)
                report({ loaded: true, blockedBy: null })
              })
              .catch(() => {
                // A chunk the build declined to ship is not an error: the page never needed it.
                report({ loaded: false, blockedBy: 'support' })
              })
          })
        } else if (lens) {
          // Leaving the viewport tears it down rather than merely pausing it — an upgrade that
          // survives off-screen is a cost with no viewer.
          lens.destroy()
          lens = null
          report({ loaded: false, blockedBy: 'viewport' })
        }
      }
    },
    { threshold: [0, 0.25, 0.5] },
  )
  observer.observe(stage)
  report({ loaded: false, blockedBy: 'viewport' })

  return () => {
    disposed = true
    observer?.disconnect()
    lens?.destroy()
    lens = null
  }
}

/** The gate names, so the page can explain itself rather than merely failing quietly. */
export const GATE_NAMES = GATES
