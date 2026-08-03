/**
 * The lazy chunk. **Nothing imports this at module scope** — `material.js` reaches it through a
 * dynamic `import()`, and only after all five gates of DESIGN §9 have passed. If it never loads,
 * the page is already finished: the lozenge is CSS, and the shader is strictly an upgrade that is
 * never load-bearing for meaning.
 *
 * What it adds is the one effect a GPU would genuinely buy and `backdrop-filter` provably cannot
 * produce on its own: **edge refraction at a glass rim**, as `feTurbulence` + `feDisplacementMap`
 * referenced from `backdrop-filter: url(#demo-lens) …`. About 700 bytes of markup, behind a
 * capability check, off by default — which is the whole ruling in one sentence: *if an effect
 * cannot fit in a kilobyte on somebody else's page, it is not worth having.*
 *
 * The runtime contract is the one §9 wrote for the renderer it replaced, because those rules were
 * never about the library: one instance, a 30 fps cap, paused on `visibilitychange`, and torn
 * down when the stage leaves the viewport.
 */

const NS = 'http://www.w3.org/2000/svg'
const FRAME_MS = 1000 / 30

/** Everything a browser needs before a displacement map is worth injecting. */
export function supported(win = globalThis) {
  return typeof win.SVGFEDisplacementMapElement === 'function'
}

/**
 * @param {HTMLElement} stage
 * @returns {{ destroy(): void, paused(): boolean }}
 */
export function createLens(stage) {
  const doc = stage.ownerDocument
  const win = doc.defaultView

  const svg = doc.createElementNS(NS, 'svg')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('width', '0')
  svg.setAttribute('height', '0')
  svg.style.position = 'absolute'

  const filter = doc.createElementNS(NS, 'filter')
  filter.setAttribute('id', 'demo-lens')
  filter.setAttribute('x', '-12%')
  filter.setAttribute('y', '-12%')
  filter.setAttribute('width', '124%')
  filter.setAttribute('height', '124%')

  const turbulence = doc.createElementNS(NS, 'feTurbulence')
  turbulence.setAttribute('type', 'fractalNoise')
  turbulence.setAttribute('baseFrequency', '0.006 0.011')
  turbulence.setAttribute('numOctaves', '2')
  turbulence.setAttribute('seed', '7')
  turbulence.setAttribute('result', 'noise')

  const displace = doc.createElementNS(NS, 'feDisplacementMap')
  displace.setAttribute('in', 'SourceGraphic')
  displace.setAttribute('in2', 'noise')
  displace.setAttribute('scale', '16')
  displace.setAttribute('xChannelSelector', 'R')
  displace.setAttribute('yChannelSelector', 'G')

  filter.append(turbulence, displace)
  svg.append(filter)
  stage.append(svg)
  stage.dataset.lens = 'on'

  let frame = 0
  let last = 0
  let stopped = false
  let isPaused = doc.visibilityState === 'hidden'

  function tick(now) {
    frame = 0
    if (stopped) return
    // The cap is the point: a marketing surface has no business asking for 120 Hz of a laptop's
    // battery to wobble a rim by two pixels.
    if (now - last >= FRAME_MS) {
      last = now
      const drift = 0.0008 * Math.sin(now / 2600)
      turbulence.setAttribute('baseFrequency', `${(0.006 + drift).toFixed(5)} 0.011`)
    }
    if (!isPaused) frame = win.requestAnimationFrame(tick)
  }

  function onVisibility() {
    isPaused = doc.visibilityState === 'hidden'
    if (!isPaused && !stopped && !frame) frame = win.requestAnimationFrame(tick)
  }
  doc.addEventListener('visibilitychange', onVisibility)
  if (!isPaused) frame = win.requestAnimationFrame(tick)

  return {
    paused: () => isPaused,
    destroy() {
      stopped = true
      if (frame) win.cancelAnimationFrame(frame)
      frame = 0
      doc.removeEventListener('visibilitychange', onVisibility)
      delete stage.dataset.lens
      svg.remove()
    },
  }
}
