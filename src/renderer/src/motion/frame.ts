// Per-frame access to the engine's real-time analysis.
//
// `frame()` reads the engine at most ONCE per ticker frame and caches the result for every
// caller in that frame. Call it from ticker callbacks (useTicker), never from React render.
// `levels` holds a few smoothed, ready-to-use loudness values.
//
// The frame object and its arrays are reused: the packed reader (one Float32Array across the
// context bridge) is unpacked into them, so reading allocates nothing on this side. Treat the
// result as valid for the current frame only (copy what you need to keep).

import { unpackFrame } from '@shared/analysis-pack'
import type { AnalysisFrame } from '@shared/types'
import { ghost } from '../ghost'
import { ticker, TickPriority } from './ticker'

// The engine computes the live analysis only while it can be seen: tell it whenever the window
// is hidden (minimised, fully covered) or back. Sent once at start too, so a new page (a reload
// after a crash) never inherits an old "hidden".
if (typeof document !== 'undefined') {
  const report = () => void ghost()?.player.setAnalysisDemand?.(!document.hidden).catch(() => {})
  document.addEventListener('visibilitychange', report)
  report()
}

let cached: AnalysisFrame | null = null
let cachedFrame = -1
const reused: AnalysisFrame = { bands: new Float32Array(96), waveform: new Float32Array(512), rms: 0, peak: 0, onset: 0, positionMs: 0, trackSeq: 0 }

/** Latest analysis frame (96 bands, waveform, rms, onset, …) or null when nothing plays. */
export function frame(): AnalysisFrame | null {
  if (cachedFrame !== ticker.frameId) {
    cachedFrame = ticker.frameId
    try {
      const a = ghost()?.analysis
      if (a?.readPacked) {
        const p = a.readPacked()
        cached = p ? unpackFrame(p, reused) : null
      } else cached = a?.read() ?? null
    } catch {
      cached = null
    }
  }
  return cached
}

/** Smoothed audio levels, 0..1, updated every frame while anyone ticks. */
export const levels = {
  /** Overall loudness (smoothed RMS, gently normalised). */
  level: 0,
  /** Low bands (≈30–150 Hz). */
  bass: 0,
  /** Mid bands. */
  mid: 0,
  /** High bands. */
  high: 0,
  /** Onset strength, fast attack / fast release. */
  onset: 0
}

function avg(b: Float32Array, from: number, to: number): number {
  let s = 0
  for (let i = from; i < to; i++) s += b[i]
  return s / (to - from)
}

const approach = (cur: number, target: number, attack: number, release: number, dt: number) => {
  const k = target > cur ? attack : release
  return cur + (target - cur) * (1 - Math.exp(-dt / k))
}

let levelsOff: (() => void) | null = null
let levelSubscribers = 0

/** Keep `levels` updated while at least one consumer is mounted. Returns a release fn. */
export function retainLevels(): () => void {
  levelSubscribers++
  if (!levelsOff) {
    levelsOff = ticker.add((dt) => {
      const f = frame()
      const L = levels
      if (!f) {
        L.level = approach(L.level, 0, 60, 300, dt)
        L.bass = approach(L.bass, 0, 40, 250, dt)
        L.mid = approach(L.mid, 0, 40, 250, dt)
        L.high = approach(L.high, 0, 40, 250, dt)
        L.onset = approach(L.onset, 0, 10, 120, dt)
        return
      }
      const n = f.bands.length
      L.level = approach(L.level, Math.min(1, f.rms * 1.6), 40, 260, dt)
      L.bass = approach(L.bass, avg(f.bands, 0, Math.max(1, Math.floor(n * 0.12))), 25, 200, dt)
      L.mid = approach(L.mid, avg(f.bands, Math.floor(n * 0.12), Math.floor(n * 0.6)), 30, 220, dt)
      L.high = approach(L.high, Math.min(1, avg(f.bands, Math.floor(n * 0.6), n) * 1.8), 30, 220, dt)
      L.onset = approach(L.onset, f.onset, 8, 110, dt)
    }, TickPriority.audio)
  }
  let released = false
  return () => {
    if (released) return
    released = true
    if (--levelSubscribers === 0 && levelsOff) {
      levelsOff()
      levelsOff = null
    }
  }
}
