// Synthesised UI sounds (Web Audio, no assets). Every pitch comes from one D-major
// pentatonic set (D E F# A B) so cues never clash with each other. Peaks sit around
// −18 dBFS at the default UI volume; a tiny procedural room reverb gives them air.
//
//   sfx.play('hover')         sfx.play('confirm')        sfx.play('open', { volume: 0.5 })
//
// Honours settings.audio.uiSounds / uiSoundVolume. Calls are throttled per cue and capped
// in polyphony, so it's safe to fire them from pointer handlers.

import { useSettings } from '../state/settings'

export type SfxName =
  | 'hover'
  | 'select'
  | 'back'
  | 'confirm'
  | 'open'
  | 'close'
  | 'notify'
  | 'toggleOn'
  | 'toggleOff'
  | 'tick'
  | 'error'
  | 'expand'
  | 'collapse'

// D major pentatonic, Hz
const N = {
  D4: 293.66,
  F4s: 369.99,
  A4: 440,
  B4: 493.88,
  D5: 587.33,
  E5: 659.26,
  F5s: 739.99,
  A5: 880,
  B5: 987.77,
  D6: 1174.66,
  E6: 1318.51,
  F6s: 1479.98,
  A6: 1760,
  B6: 1975.53,
  D7: 2349.32
}

const THROTTLE_MS: Partial<Record<SfxName, number>> = { hover: 45, tick: 28 }
const DEFAULT_THROTTLE = 70
const MAX_VOICES = 10
/** −18 dBFS at the default uiSoundVolume (0.6). */
const REF_GAIN = Math.pow(10, -18 / 20)
const REF_VOLUME = 0.6

interface Bus {
  ctx: BaseAudioContext
  master: GainNode
  dry: GainNode
  wet: GainNode
  noise: AudioBuffer
  /** Live context only: cap polyphony. */
  live: boolean
}

let bus: Bus | null = null
let voices = 0
const lastPlayed = new Map<SfxName, number>()

/** master ← (dry + reverb(wet)) on any context (live or offline). Polyphony is capped instead of compressed. */
function buildBus(c: BaseAudioContext, gain: number, live: boolean): Bus {
  const master = c.createGain()
  master.gain.value = gain
  const dry = c.createGain()
  const wet = c.createGain()
  wet.gain.value = 0.16
  const verb = c.createConvolver()
  verb.buffer = impulse(c, 0.9, 3.2)
  dry.connect(master)
  wet.connect(verb).connect(master)
  master.connect(c.destination)
  const noise = c.createBuffer(1, c.sampleRate, c.sampleRate)
  const d = noise.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  return { ctx: c, master, dry, wet, noise, live }
}

function ensure(): Bus | null {
  if (bus) return bus
  try {
    bus = buildBus(new AudioContext({ latencyHint: 'interactive' }), currentGain(), true)
  } catch {
    return null
  }
  return bus
}

function impulse(c: BaseAudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(c.sampleRate * seconds)
  const buf = c.createBuffer(2, len, c.sampleRate)
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch)
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
  }
  return buf
}

function currentGain(): number {
  const a = useSettings.getState().audio
  if (!a.uiSounds) return 0
  return REF_GAIN * Math.max(0, Math.min(1.6, a.uiSoundVolume / REF_VOLUME))
}

useSettings.subscribe((s, p) => {
  if (s.audio.uiSoundVolume !== p.audio.uiSoundVolume || s.audio.uiSounds !== p.audio.uiSounds) {
    if (bus) bus.master.gain.setTargetAtTime(currentGain(), bus.ctx.currentTime, 0.02)
  }
})

// Browsers start AudioContexts suspended until a user gesture; resume on the first one.
if (typeof window !== 'undefined') {
  const resume = () => {
    const c = bus?.ctx as AudioContext | undefined
    if (c && c.state === 'suspended') void c.resume()
  }
  window.addEventListener('pointerdown', resume, { capture: true })
  window.addEventListener('keydown', resume, { capture: true })
}

// ---- voices ------------------------------------------------------------------

interface ToneOpts {
  freq: number
  at?: number
  /** Seconds. */
  attack?: number
  decay?: number
  gain?: number
  type?: OscillatorType
  /** Glide to this frequency over `glide` seconds. */
  to?: number
  glide?: number
  /** Extra bell partials [ratio, relGain, decayScale][]. */
  partials?: [number, number, number][]
  wet?: number
}

function voiceStart(b: Bus): boolean {
  if (!b.live) return true
  if (voices >= MAX_VOICES) return false
  voices++
  return true
}
const voiceEnd = (b: Bus) => {
  if (b.live) voices--
}

function tone(b: Bus, o: ToneOpts): void {
  const c = b.ctx
  const t = c.currentTime + (o.at ?? 0)
  const attack = o.attack ?? 0.004
  const decay = o.decay ?? 0.18
  const partials: [number, number, number][] = [[1, 1, 1], ...(o.partials ?? [])]
  for (const [ratio, rel, dScale] of partials) {
    if (!voiceStart(b)) return
    const osc = c.createOscillator()
    osc.type = o.type ?? 'sine'
    osc.frequency.setValueAtTime(o.freq * ratio, t)
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to * ratio, t + (o.glide ?? decay * 0.6))
    const g = c.createGain()
    const peak = (o.gain ?? 0.5) * rel
    const d = decay * dScale
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(peak, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + d)
    osc.connect(g)
    g.connect(b.dry)
    let w: GainNode | null = null
    if (o.wet !== 0) {
      w = c.createGain()
      w.gain.value = o.wet ?? 1
      g.connect(w).connect(b.wet)
    }
    osc.onended = () => {
      voiceEnd(b)
      osc.disconnect()
      g.disconnect()
      w?.disconnect()
    }
    osc.start(t)
    osc.stop(t + attack + d + 0.05)
  }
}

interface NoiseOpts {
  at?: number
  dur: number
  attack?: number
  gain?: number
  type?: BiquadFilterType
  from: number
  to: number
  q?: number
}

function whoosh(b: Bus, o: NoiseOpts): void {
  if (!voiceStart(b)) return
  const c = b.ctx
  const t = c.currentTime + (o.at ?? 0)
  const src = c.createBufferSource()
  src.buffer = b.noise
  src.loop = true
  const f = c.createBiquadFilter()
  f.type = o.type ?? 'bandpass'
  f.Q.value = o.q ?? 1.1
  f.frequency.setValueAtTime(o.from, t)
  f.frequency.exponentialRampToValueAtTime(o.to, t + o.dur)
  const g = c.createGain()
  const attack = o.attack ?? o.dur * 0.35
  g.gain.setValueAtTime(0, t)
  g.gain.linearRampToValueAtTime(o.gain ?? 0.3, t + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur)
  src.connect(f).connect(g)
  g.connect(b.dry)
  g.connect(b.wet)
  src.onended = () => {
    voiceEnd(b)
    src.disconnect()
    f.disconnect()
    g.disconnect()
  }
  src.start(t, Math.random() * 0.5)
  src.stop(t + o.dur + 0.05)
}

const bell: [number, number, number][] = [
  [2, 0.28, 0.55],
  [3, 0.1, 0.35]
]

const cues: Record<SfxName, (c: Bus, v: number) => void> = {
  hover: (c, v) => {
    const f = Math.random() < 0.5 ? N.A6 : N.B6
    tone(c, { freq: f, attack: 0.002, decay: 0.045, gain: 0.16 * v, wet: 0.3 })
    tone(c, { freq: f / 2, attack: 0.002, decay: 0.03, gain: 0.06 * v, type: 'triangle', wet: 0 })
  },
  select: (c, v) => {
    tone(c, { freq: N.D6, attack: 0.003, decay: 0.16, gain: 0.34 * v, partials: bell })
    tone(c, { freq: N.A6, at: 0.035, attack: 0.003, decay: 0.2, gain: 0.26 * v, partials: bell })
  },
  back: (c, v) => {
    tone(c, { freq: N.A5, attack: 0.003, decay: 0.12, gain: 0.3 * v, partials: bell })
    tone(c, { freq: N.D5, at: 0.045, attack: 0.003, decay: 0.2, gain: 0.26 * v, partials: bell })
    whoosh(c, { dur: 0.16, from: 3200, to: 700, gain: 0.08 * v, q: 0.9 })
  },
  confirm: (c, v) => {
    const seq = [N.D5, N.F5s, N.A5, N.D6]
    seq.forEach((f, i) => tone(c, { freq: f, at: i * 0.045, attack: 0.003, decay: 0.32 + i * 0.06, gain: (0.24 + i * 0.03) * v, partials: bell }))
  },
  open: (c, v) => {
    whoosh(c, { dur: 0.32, from: 420, to: 3600, gain: 0.22 * v, q: 1.3, attack: 0.12 })
    tone(c, { freq: N.D4, to: N.A4, glide: 0.22, attack: 0.03, decay: 0.3, gain: 0.08 * v, wet: 0.6 })
  },
  close: (c, v) => {
    whoosh(c, { dur: 0.28, from: 3200, to: 380, gain: 0.18 * v, q: 1.3, attack: 0.06 })
    tone(c, { freq: N.A4, to: N.D4, glide: 0.2, attack: 0.02, decay: 0.26, gain: 0.07 * v, wet: 0.6 })
  },
  notify: (c, v) => {
    tone(c, { freq: N.E6, attack: 0.004, decay: 0.35, gain: 0.24 * v, partials: bell })
    tone(c, { freq: N.B6, at: 0.08, attack: 0.004, decay: 0.5, gain: 0.2 * v, partials: bell })
  },
  toggleOn: (c, v) => {
    tone(c, { freq: N.A5, attack: 0.002, decay: 0.07, gain: 0.24 * v })
    tone(c, { freq: N.D6, at: 0.04, attack: 0.002, decay: 0.12, gain: 0.24 * v, partials: bell })
  },
  toggleOff: (c, v) => {
    tone(c, { freq: N.D6, attack: 0.002, decay: 0.07, gain: 0.2 * v })
    tone(c, { freq: N.A5, at: 0.04, attack: 0.002, decay: 0.12, gain: 0.2 * v })
  },
  tick: (c, v) => {
    tone(c, { freq: N.F6s, attack: 0.001, decay: 0.022, gain: 0.12 * v, wet: 0 })
  },
  error: (c, v) => {
    tone(c, { freq: N.B4, to: N.F4s, glide: 0.14, attack: 0.004, decay: 0.22, gain: 0.32 * v, type: 'triangle' })
    tone(c, { freq: N.D4, at: 0.07, attack: 0.004, decay: 0.26, gain: 0.26 * v, type: 'triangle' })
  },
  expand: (c, v) => {
    whoosh(c, { dur: 0.36, from: 500, to: 4200, gain: 0.12 * v, q: 1.1, attack: 0.15 })
    ;[N.D5, N.A5, N.D6, N.E6].forEach((f, i) => tone(c, { freq: f, at: 0.02 + i * 0.05, attack: 0.004, decay: 0.3, gain: 0.18 * v, partials: bell }))
  },
  collapse: (c, v) => {
    whoosh(c, { dur: 0.3, from: 3600, to: 500, gain: 0.1 * v, q: 1.1, attack: 0.08 })
    ;[N.E6, N.D6, N.A5].forEach((f, i) => tone(c, { freq: f, at: i * 0.045, attack: 0.004, decay: 0.22, gain: 0.15 * v, partials: bell }))
  }
}

/**
 * Per-cue calibration (linear), measured with sfx.measure() so that at the default UI volume
 * the main cues peak around −18…−20 dBFS, whooshes/toggles a little under, and the constant
 * hover/tick cues well below (they fire all the time).
 */
const LEVEL: Record<SfxName, number> = {
  confirm: 1.81, // → −18 dBFS
  select: 2.36, // → −19
  notify: 3.39, // → −19
  expand: 3.16, // → −19
  back: 2.19, // → −20
  collapse: 3.35, // → −20
  error: 2.57, // → −20
  toggleOn: 2.77, // → −21
  toggleOff: 3.2, // → −22
  open: 8.5, // → −21
  close: 5.6, // → −22
  hover: 1.7, // → −28
  tick: 1.78 // → −32
}

export const sfx = {
  /** Play a cue. `volume` scales this one cue (0..1+). */
  play(name: SfxName, opts?: { volume?: number }): void {
    const s = useSettings.getState().audio
    if (!s.uiSounds || s.uiSoundVolume <= 0) return
    const now = performance.now()
    const last = lastPlayed.get(name) ?? -1e9
    if (now - last < (THROTTLE_MS[name] ?? DEFAULT_THROTTLE)) return
    lastPlayed.set(name, now)
    const b = ensure()
    if (!b) return
    const live = b.ctx as AudioContext
    if (live.state === 'suspended') {
      void live.resume()
      // a cue fired before the first gesture would be silent anyway; skip it
      if (name === 'hover') return
    }
    try {
      cues[name](b, (opts?.volume ?? 1) * LEVEL[name])
    } catch (err) {
      console.warn('[sfx] failed', name, err)
    }
  },
  /** Names of all cues (for a settings preview list). */
  names: Object.keys(cues) as SfxName[],
  /**
   * Render a cue offline at the default UI volume and report its level (dBFS).
   * Dev/tuning aid: `await sfx.measure('confirm')` → { peakDb, rmsDb }.
   */
  async measure(name: SfxName): Promise<{ peakDb: number; rmsDb: number }> {
    const sr = 48000
    const off = new OfflineAudioContext(2, Math.round(sr * 1.6), sr)
    cues[name](buildBus(off, REF_GAIN, false), LEVEL[name])
    const out = await off.startRendering()
    let peak = 0
    let sum = 0
    let n = 0
    for (let ch = 0; ch < out.numberOfChannels; ch++) {
      const d = out.getChannelData(ch)
      for (let i = 0; i < d.length; i++) {
        const a = Math.abs(d[i])
        if (a > peak) peak = a
        if (a > 1e-4) {
          sum += a * a
          n++
        }
      }
    }
    const db = (x: number) => Math.round(20 * Math.log10(Math.max(1e-9, x)) * 10) / 10
    return { peakDb: db(peak), rmsDb: db(Math.sqrt(sum / Math.max(1, n))) }
  }
}
