// Drives the --accent* CSS variables from useUI.accent, interpolating in OKLab over ~600 ms
// so colour changes glide instead of snapping. `accentNow` exposes the live interpolated
// colour for GPU/canvas code (PixiJS tints, visualisers) without touching the DOM.

import { DEFAULT_ACCENT, useUI } from '../state/ui'
import { easings } from '../motion/easing'
import { motionPrefs } from '../motion/prefs'
import { ticker, TickPriority } from '../motion/ticker'
import { accentFamily, hexToRgb, normalizeAccent, oklabToRgb, rgbToHex, rgbToNumber, rgbToOklab, rgbTriplet, type Lab, type RGB } from './color'

export const ACCENT_TRANSITION_MS = 600

/** Live accent (mutated in place every frame while transitioning). */
export const accentNow = {
  rgb: hexToRgb(DEFAULT_ACCENT) as RGB,
  hex: DEFAULT_ACCENT,
  /** 0xRRGGBB for PixiJS tints. */
  number: 0xff66aa,
  /** The normalised colour we're heading to. */
  target: DEFAULT_ACCENT
}

let current: Lab = rgbToOklab(accentNow.rgb)
let from: Lab = current
let to: Lab = current
let t0 = 0
let off: (() => void) | null = null
let lastInk = ''

function write(lab: Lab): void {
  current = lab
  oklabToRgb(lab, accentNow.rgb)
  const [r, g, b] = accentNow.rgb
  accentNow.hex = rgbToHex(r, g, b)
  accentNow.number = rgbToNumber(accentNow.rgb)
  const fam = accentFamily(accentNow.hex)
  const st = document.documentElement.style
  st.setProperty('--accent', accentNow.hex)
  st.setProperty('--accent-rgb', rgbTriplet(fam.base))
  st.setProperty('--accent-hi', rgbToHex(...fam.hi))
  st.setProperty('--accent-hi-rgb', rgbTriplet(fam.hi))
  st.setProperty('--accent-lo', rgbToHex(...fam.lo))
  st.setProperty('--accent-lo-rgb', rgbTriplet(fam.lo))
  if (fam.ink !== lastInk) st.setProperty('--accent-ink', (lastInk = fam.ink))
}

function step(_dt: number, now: number): void {
  const p = Math.min(1, (now - t0) / ACCENT_TRANSITION_MS)
  const e = easings.outCubic(p)
  write([from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e, from[2] + (to[2] - from[2]) * e])
  if (p >= 1 && off) {
    off()
    off = null
  }
}

/** Move the theme accent to `hex` (normalised for legibility). Prefer useUI.setAccent(). */
export function transitionAccent(hex: string | null | undefined, instant = false): void {
  const norm = normalizeAccent(hex, DEFAULT_ACCENT)
  if (norm === accentNow.target && !instant) return
  accentNow.target = norm
  to = rgbToOklab(hexToRgb(norm))
  if (instant || motionPrefs.reduce) {
    off?.()
    off = null
    write(to)
    return
  }
  from = current
  t0 = performance.now()
  if (!off) off = ticker.add(step, TickPriority.audio)
}

let started = false

/** Called once by App: applies the current accent and follows useUI.accent from then on. */
export function startAccentDriver(): () => void {
  if (started) return () => {}
  started = true
  transitionAccent(useUI.getState().accent, true)
  const unsub = useUI.subscribe((s, prev) => {
    if (s.accent !== prev.accent) transitionAccent(s.accent)
  })
  return () => {
    unsub()
    started = false
  }
}
