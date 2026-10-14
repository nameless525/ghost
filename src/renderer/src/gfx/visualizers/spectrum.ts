// Turns the engine's 96 smoothed log bands into N display amplitudes for bar visualizers:
// instant rise, smooth exponential fall, per-bar adaptive gain (so the whole spectrum moves,
// not just the bass), a gentle treble tilt, and osu!-style peak caps that hold, then fall
// under gravity. Allocation-free per frame.

export interface SpectrumOptions {
  /** How many of the 96 bands to use (the top of the spectrum is mostly air). Default 84. */
  usedBands?: number
  /** Release time constant in ms. Default 150. */
  release?: number
  /** Peak-cap hold in ms. Default 260. */
  hold?: number
  /** Peak-cap gravity in amplitude units per s². Default 3.2. */
  gravity?: number
}

export class Spectrum {
  /** Displayed amplitude per bar, ~0..1.15. */
  readonly amp: Float32Array
  /** Peak-cap position per bar. */
  readonly peak: Float32Array
  /** Loudest bar this frame. */
  max = 0
  /** Mean amplitude this frame. */
  mean = 0

  private ref: Float32Array
  private vel: Float32Array
  private holdLeft: Float32Array
  private lo: Uint8Array
  private hi: Uint8Array
  private tilt: Float32Array
  private release: number
  private hold: number
  private gravity: number

  constructor(readonly n: number, opts: SpectrumOptions = {}) {
    const used = opts.usedBands ?? 84
    this.release = opts.release ?? 150
    this.hold = opts.hold ?? 260
    this.gravity = opts.gravity ?? 3.2
    this.amp = new Float32Array(n)
    this.peak = new Float32Array(n)
    this.ref = new Float32Array(n).fill(0.2)
    this.vel = new Float32Array(n)
    this.holdLeft = new Float32Array(n)
    this.lo = new Uint8Array(n)
    this.hi = new Uint8Array(n)
    this.tilt = new Float32Array(n)
    for (let j = 0; j < n; j++) {
      const a = Math.floor((j / n) * used)
      this.lo[j] = a
      this.hi[j] = Math.max(a + 1, Math.floor(((j + 1) / n) * used))
      this.tilt[j] = 0.7 + 0.8 * (j / n)
    }
  }

  /** @param bands the frame's 96 bands, or null to let everything decay. @param gain extra drive (kiai). */
  update(dt: number, bands: Float32Array | null, gain = 1): void {
    const { n, amp, peak, ref, vel, holdLeft } = this
    const decay = Math.exp(-dt / this.release)
    const refDecay = Math.exp(-dt / 2500)
    const sec = dt / 1000
    let max = 0
    let sum = 0
    for (let j = 0; j < n; j++) {
      let v = 0
      if (bands) {
        for (let i = this.lo[j]; i < this.hi[j]; i++) if (bands[i] > v) v = bands[i]
        ref[j] = Math.max(ref[j] * refDecay, v, 0.06)
        // half raw (loud stays loud), half normalised to this bar's own recent peak
        const norm = v / ref[j]
        const raw = v * this.tilt[j]
        v = Math.pow(0.5 * raw + 0.5 * norm * Math.min(1, ref[j] * 2.5), 1.15) * gain
        if (v > 1.15) v = 1.15
      }
      const a = Math.max(amp[j] * decay, v)
      amp[j] = a
      // peak caps
      if (a >= peak[j]) {
        peak[j] = a
        vel[j] = 0
        holdLeft[j] = this.hold
      } else if (holdLeft[j] > 0) {
        holdLeft[j] -= dt
      } else {
        vel[j] += this.gravity * sec
        peak[j] = Math.max(a, peak[j] - vel[j] * sec)
      }
      if (a > max) max = a
      sum += a
    }
    this.max = max
    this.mean = sum / n
  }
}
