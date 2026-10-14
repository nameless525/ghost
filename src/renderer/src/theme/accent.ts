// Drives the --accent* CSS variables from useUI.accent, interpolating in OKLab over ~600 ms
// so colour changes glide instead of snapping. `accentNow` exposes the live interpolated
// colour for GPU/canvas code (PixiJS tints, visualisers) without touching the DOM.
//
// Performance: the accent family lives on :root and nearly everything inherits it, so every
// write restyles (and repaints the accent-coloured parts of) the whole document. The GPU side
// (`accentNow`) still glides every frame, but the CSS side is written in CSS_STEPS equal colour
// steps instead of once per frame: 4 document restyles per accent change (~2–3 ms each on
// Browse) instead of ~36 at 60 Hz (~72 at 120 Hz). Measured on Browse (16 selections, 6 s):
// per-frame writes 572 ms of style recalc, 6 steps 198 ms, a single snap 166 ms. Elements that
// transition their accent-derived colours smooth the steps; the rest change in a few quick
// increments (at ~25, 90, 170 and 300 ms with the outCubic glide) that still read as a glide.

import { DEFAULT_ACCENT, useUI } from '../state/ui'
import { easings } from '../motion/easing'
import { motionPrefs } from '../motion/prefs'
import { ticker, TickPriority } from '../motion/ticker'
import { accentFamily, hexToRgb, normalizeAccent, oklabToRgb, rgbToHex, rgbToNumber, rgbToOklab, rgbTriplet, type Lab, type RGB } from './color'

export const ACCENT_TRANSITION_MS = 600
/** CSS writes per glide (the last one lands exactly on the target). */
export const CSS_STEPS = 4

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
/** Index of the last CSS step written during the current glide. */
let cssStep = 0
let lastCss = ''
let lastInk = ''
/** Debug/measurement: CSS steps per glide (window.__ghostAccent.steps). */
let steps = CSS_STEPS

function setGpu(lab: Lab): void {
  current = lab
  oklabToRgb(lab, accentNow.rgb)
  const [r, g, b] = accentNow.rgb
  accentNow.hex = rgbToHex(r, g, b)
  accentNow.number = rgbToNumber(accentNow.rgb)
}

function writeCss(lab: Lab): void {
  const rgb = oklabToRgb(lab)
  const hex = rgbToHex(rgb[0], rgb[1], rgb[2])
  if (hex === lastCss) return
  lastCss = hex
  const fam = accentFamily(hex)
  const st = document.documentElement.style
  st.setProperty('--accent', hex)
  st.setProperty('--accent-rgb', rgbTriplet(fam.base))
  st.setProperty('--accent-hi', rgbToHex(...fam.hi))
  st.setProperty('--accent-hi-rgb', rgbTriplet(fam.hi))
  st.setProperty('--accent-lo', rgbToHex(...fam.lo))
  st.setProperty('--accent-lo-rgb', rgbTriplet(fam.lo))
  if (fam.ink !== lastInk) st.setProperty('--accent-ink', (lastInk = fam.ink))
}

const lerp = (e: number): Lab => [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e, from[2] + (to[2] - from[2]) * e]

function step(_dt: number, now: number): void {
  const p = Math.min(1, (now - t0) / ACCENT_TRANSITION_MS)
  const e = easings.outCubic(p)
  setGpu(lerp(e))
  // CSS: equal-sized colour steps, each written when the eased glide reaches it (so 60 and
  // 120 Hz write the same number of times; with outCubic the last lands at ~340 ms).
  const n = Math.max(1, steps)
  const k = p >= 1 ? n : Math.min(n, Math.floor(e * n + 0.5))
  if (k > cssStep) {
    cssStep = k
    writeCss(lerp(k / n))
  }
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
    setGpu(to)
    writeCss(to)
    return
  }
  from = current
  t0 = performance.now()
  cssStep = 0
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
  if (typeof window !== 'undefined')
    (window as unknown as { __ghostAccent: unknown }).__ghostAccent = {
      get steps() {
        return steps
      },
      set steps(v: number) {
        steps = Math.max(1, Math.round(v))
      }
    }
  return () => {
    unsub()
    started = false
  }
}
