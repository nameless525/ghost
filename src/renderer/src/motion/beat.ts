// The beat clock: where are we in the music, rhythmically?
//
// Uses the offline beat grid (PlayerState.currentAnalysis.beats/downbeats/kiai) against the
// latency-compensated live position (livePositionMs()). When a track has no grid (ambient,
// rubato), it falls back to onset peaks detected from the real-time analysis frames. So does an
// audible preview: the grid and position belong to the queue track it holds.
//
//   beat.phase      0..1 progress through the current beat
//   beat.pulse      0..1 envelope: jumps on each beat, decays OutQuint over ~80% of a beat
//                   (downbeats and kiai are stronger). Ideal for scale/brightness pulses.
//   beat.inKiai     inside a high-energy section; beat.kiai is a smoothed 0..1 blend of it
//   beat.onBeat(cb) subscribe to beats; beat.onKiai(cb) to kiai start/end
//
// Everything updates once per ticker frame at TickPriority.audio, before anyone reads it.

import type { TrackAnalysis } from '@shared/types'
import { livePositionMs, usePlayer } from '../state/player'
import { clamp01, easings } from './easing'
import { frame } from './frame'
import { ticker, TickPriority } from './ticker'

export interface BeatEvent {
  /** Beat index in the grid (or onset counter in fallback mode). */
  index: number
  downbeat: boolean
  kiai: boolean
  bpm: number
  /** ms between this beat and the next. */
  beatLength: number
  /** 0..~1.6 relative strength (1 = normal beat). */
  strength: number
  /** performance.now() of detection. */
  time: number
  /** True when produced by the onset fallback rather than the beat grid. */
  fromOnset: boolean
}

type BeatCb = (e: BeatEvent) => void
type KiaiCb = (active: boolean) => void
/** What the speakers play: the queue's current track, or a preview holding it. */
type Voice = 'main' | 'preview'

const DOWNBEAT_STRENGTH = 1.35
const KIAI_BOOST = 1.2

export class BeatClock {
  /** Current beat index (-1 before the first beat). */
  index = -1
  /** 0..1 progress through the current beat. */
  phase = 0
  /** Whether the current beat is a downbeat. */
  isDownbeat = false
  /** Inside a kiai (high-energy) section right now. */
  inKiai = false
  /** Smoothed 0..1 kiai blend (≈350 ms in/out) for visuals. */
  kiai = 0
  /** Tempo in BPM (grid or estimated). 0 when unknown. */
  bpm = 0
  /** Beat length in ms. */
  beatLength = 500
  /** True when a beat grid is driving the clock. */
  hasGrid = false
  /** True while music is actually playing. */
  playing = false
  /** 0..~1.6 beat envelope (see header). */
  pulse = 0

  private beatsMs: Float64Array = new Float64Array(0)
  private downFlags: Uint8Array = new Uint8Array(0)
  private kiaiMs: [number, number][] = []
  private analysis: TrackAnalysis | null = null
  private voice: Voice = 'main'
  private pulseStart = -1e9
  private pulseStrength = 0
  private pulseLen = 500
  private beatCbs = new Set<BeatCb>()
  private kiaiCbs = new Set<KiaiCb>()

  // onset fallback state
  private onMean = 0.1
  private onVar = 0.01
  private onPrev = 0
  private lastOnsetAt = -1e9
  private onsetCount = 0
  private intervals: number[] = []

  private off: (() => void) | null = null
  private refs = 0

  /** Subscribe to beats. Keeps the clock running while subscribed. */
  onBeat(cb: BeatCb): () => void {
    this.beatCbs.add(cb)
    const release = this.retain()
    return () => {
      this.beatCbs.delete(cb)
      release()
    }
  }

  /** Subscribe to kiai section changes. */
  onKiai(cb: KiaiCb): () => void {
    this.kiaiCbs.add(cb)
    const release = this.retain()
    return () => {
      this.kiaiCbs.delete(cb)
      release()
    }
  }

  /** Keep the clock updating (usePulse/useBeat do this for you). Returns a release fn. */
  retain(): () => void {
    this.refs++
    if (!this.off) this.off = ticker.add((dt, now) => this.update(dt, now), TickPriority.audio)
    let done = false
    return () => {
      if (done) return
      done = true
      if (--this.refs === 0 && this.off) {
        this.off()
        this.off = null
      }
    }
  }

  private rebuild(a: TrackAnalysis | null): void {
    this.analysis = a
    const beats = a?.beats ?? []
    this.beatsMs = Float64Array.from(beats, (b) => b * 1000)
    this.downFlags = new Uint8Array(beats.length)
    const downs = a?.downbeats ?? []
    let j = 0
    for (let i = 0; i < beats.length && j < downs.length; i++) {
      while (j < downs.length && downs[j] < beats[i] - 0.04) j++
      if (j < downs.length && Math.abs(downs[j] - beats[i]) <= 0.04) this.downFlags[i] = 1
    }
    this.kiaiMs = (a?.kiai ?? []).map(([s, e]) => [s * 1000, e * 1000])
    this.hasGrid = this.beatsMs.length > 1
    if (this.hasGrid) {
      if (a?.bpm) this.bpm = a.bpm
      else {
        const n = Math.min(64, this.beatsMs.length - 1)
        const iv: number[] = []
        for (let i = 0; i < n; i++) iv.push(this.beatsMs[i + 1] - this.beatsMs[i])
        iv.sort((x, y) => x - y)
        this.bpm = 60000 / iv[iv.length >> 1]
      }
      this.beatLength = 60000 / this.bpm
    }
    this.index = -1
  }

  private search(pos: number): number {
    const b = this.beatsMs
    // fast path: incremental from the last index
    let i = this.index
    if (i >= -1 && i < b.length) {
      if ((i < 0 || b[i] <= pos) && (i + 1 >= b.length || b[i + 1] > pos)) return i
      if (i + 2 <= b.length && b[i + 1] <= pos && (i + 2 >= b.length || b[i + 2] > pos)) return i + 1
    }
    let lo = 0
    let hi = b.length - 1
    if (b.length === 0 || pos < b[0]) return -1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (b[mid] <= pos) lo = mid
      else hi = mid - 1
    }
    return lo
  }

  private fire(e: BeatEvent): void {
    this.pulseStart = e.time
    this.pulseStrength = e.strength
    this.pulseLen = e.beatLength
    for (const cb of this.beatCbs) {
      try {
        cb(e)
      } catch (err) {
        console.error('[beat] onBeat callback threw', err)
      }
    }
  }

  private setKiai(active: boolean): void {
    if (active === this.inKiai) return
    this.inKiai = active
    for (const cb of this.kiaiCbs) cb(active)
  }

  /** The audible voice changed: neither its grid position nor its onset statistics carry over. */
  private switchVoice(voice: Voice): void {
    this.voice = voice
    this.bpm = 0
    this.beatLength = 500
    this.rebuild(this.analysis)
    this.phase = 0
    this.isDownbeat = false
    this.onMean = 0.1
    this.onVar = 0.01
    this.onPrev = 0
    this.lastOnsetAt = -1e9
    this.intervals = []
  }

  private update(dt: number, now: number): void {
    const ps = usePlayer.getState()
    if (ps.currentAnalysis !== this.analysis) this.rebuild(ps.currentAnalysis)
    // a preview is audible once it has paused the queue (until then it is still loading)
    const voice: Voice = ps.preview && ps.status !== 'playing' ? 'preview' : 'main'
    if (voice !== this.voice) this.switchVoice(voice)
    this.playing = ps.status === 'playing'

    if (voice === 'main' && this.hasGrid && ps.current) {
      const pos = livePositionMs(ps)
      const b = this.beatsMs
      const i = this.search(pos)
      if (i !== this.index) {
        const prev = this.index
        this.index = i
        // fire only for natural forward progress (not seeks), and only for a beat we just crossed
        if (this.playing && i >= 0 && i > prev && i - prev <= 2 && pos - b[i] < 150) {
          const down = this.downFlags[i] === 1
          const len = i + 1 < b.length ? b[i + 1] - b[i] : this.beatLength
          const k = this.kiaiAt(pos)
          const strength = (down ? DOWNBEAT_STRENGTH : 1) * (k ? KIAI_BOOST : 1)
          this.fire({ index: i, downbeat: down, kiai: k, bpm: this.bpm, beatLength: len, strength, time: now, fromOnset: false })
        }
      }
      if (i >= 0) {
        const len = i + 1 < b.length ? b[i + 1] - b[i] : this.beatLength
        this.beatLength = len
        this.phase = clamp01((pos - b[i]) / len)
        this.isDownbeat = this.downFlags[i] === 1
      } else {
        this.phase = 0
        this.isDownbeat = false
      }
      this.setKiai(this.playing && this.kiaiAt(pos))
    } else {
      // a preview's own analysis carries its tempo (not its beat positions)
      this.onsetFallback(now, voice === 'preview' ? (ps.preview?.track.analysis?.bpm ?? null) : null)
      this.setKiai(false)
    }

    // envelopes
    const kiaiTarget = this.inKiai ? 1 : 0
    this.kiai += (kiaiTarget - this.kiai) * (1 - Math.exp(-dt / 120))
    const p = (now - this.pulseStart) / (0.8 * this.pulseLen)
    this.pulse = p >= 1 || p < 0 ? 0 : this.pulseStrength * (1 - easings.outQuint(p))
  }

  private kiaiAt(pos: number): boolean {
    for (const [s, e] of this.kiaiMs) if (pos >= s && pos < e) return true
    return false
  }

  /** @param bpm the tempo when known (a preview's analysis), else estimated from the onsets */
  private onsetFallback(now: number, bpm: number | null): void {
    const f = frame()
    const ps = usePlayer.getState()
    const live = !!f && (ps.status === 'playing' || !!ps.preview)
    this.playing = live
    if (!f || !live) {
      this.phase = 0
      this.onPrev = 0
      return
    }
    const x = f.onset
    // running mean/variance of onset strength (≈1 s window)
    const a = 0.02
    const d = x - this.onMean
    this.onMean += a * d
    this.onVar = (1 - a) * (this.onVar + a * d * d)
    const thr = Math.max(0.12, this.onMean + 1.6 * Math.sqrt(this.onVar))
    const since = now - this.lastOnsetAt
    if (x > thr && this.onPrev <= thr && since > 220) {
      if (since < 2000) {
        this.intervals.push(since)
        if (this.intervals.length > 8) this.intervals.shift()
      }
      this.lastOnsetAt = now
      this.onsetCount++
      if (bpm && bpm > 0) {
        this.beatLength = 60000 / bpm
        this.bpm = bpm
      } else {
        const sorted = [...this.intervals].sort((p, q) => p - q)
        const med = sorted.length ? sorted[sorted.length >> 1] : 500
        this.beatLength = Math.min(1000, Math.max(300, med))
        this.bpm = Math.round(60000 / this.beatLength)
      }
      this.index = this.onsetCount
      this.isDownbeat = false
      const strength = Math.min(1.4, 0.75 + (x - thr) * 2)
      this.fire({ index: this.onsetCount, downbeat: false, kiai: false, bpm: this.bpm, beatLength: this.beatLength, strength, time: now, fromOnset: true })
    }
    this.onPrev = x
    this.phase = clamp01((now - this.lastOnsetAt) / this.beatLength)
  }
}

/** The global beat clock. Call `beat.retain()` (or use usePulse/useBeat) to keep it running. */
export const beat = new BeatClock()
