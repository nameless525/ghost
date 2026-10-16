// Radial spectrum ring around the logo, drawn on a 2D canvas each frame from frame().bands.
// Mirrored left/right (bass at the top, highs flowing down both sides), with osu!-style
// peak-hold decay so bars rise instantly and fall smoothly. When nothing plays, a faint
// breathing shimmer keeps the ring alive. Under Reduce motion only the bars follow the music:
// no rotation, a still shimmer, no beat or kiai boosts.
import type { AnalysisFrame } from '@shared/types'
import { idleSeconds } from '../../gfx/visualizers/util'

/** Max canvas resolution (window.__ghostGfx.ringRes in dev). */
const RING_MAX_RES = { v: 1.5 }
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const g = ((window as unknown as { __ghostGfx?: Record<string, unknown> }).__ghostGfx ??= {})
  Object.defineProperty(g, 'ringRes', { configurable: true, get: () => RING_MAX_RES.v, set: (v: number) => (RING_MAX_RES.v = v) })
}

const PER_SIDE = 72
const USED_BANDS = 84 // skip the top of the spectrum, it's mostly air

export class RingVisualiser {
  private ctx: CanvasRenderingContext2D
  private amp = new Float32Array(PER_SIDE)
  /** Slow per-bar running peak, for adaptive gain (whitens the spectrum so the whole ring moves). */
  private ref = new Float32Array(PER_SIDE).fill(0.2)
  private size = 0
  private dpr = 1
  private rot = 0
  private idle = 0

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: true, desynchronized: false })!
  }

  resize(cssSize: number): void {
    // 1.5× is plenty for soft additive bars (and ~56% of the fill of 2× on Retina/4K)
    const dpr = Math.min(RING_MAX_RES.v, window.devicePixelRatio || 1)
    if (cssSize === this.size && dpr === this.dpr) return
    this.size = cssSize
    this.dpr = dpr
    this.canvas.width = Math.round(cssSize * dpr)
    this.canvas.height = Math.round(cssSize * dpr)
    this.canvas.style.width = `${cssSize}px`
    this.canvas.style.height = `${cssSize}px`
  }

  /**
   * @param radius inner radius (css px) where bars start
   * @param rgb bar colour
   * @param notch 0..1: shorten the bars at the bottom of the ring, where the wordmark sits
   * @param reduce settings' Reduce motion
   */
  draw(dt: number, now: number, f: AnalysisFrame | null, radius: number, rgb: readonly number[], kiai: number, pulse: number, playing: boolean, notch = 0, reduce = false): void {
    const { ctx, size, dpr } = this
    if (!size) return
    if (reduce) kiai = pulse = 0
    const decay = Math.exp(-dt / 150)
    const amp = this.amp
    let peak = 0
    if (f) {
      const bands = f.bands
      const n = Math.min(USED_BANDS, bands.length)
      const refDecay = Math.exp(-dt / 2500)
      for (let j = 0; j < PER_SIDE; j++) {
        const a = Math.floor((j / PER_SIDE) * n)
        const b = Math.max(a + 1, Math.floor(((j + 1) / PER_SIDE) * n))
        let v = 0
        for (let i = a; i < b; i++) v = Math.max(v, bands[i])
        this.ref[j] = Math.max(this.ref[j] * refDecay, v, 0.06)
        // half raw (keeps loud/quiet honest), half normalised to the bar's own recent peak
        const norm = v / this.ref[j]
        const raw = v * (0.7 + 0.8 * (j / PER_SIDE))
        v = Math.pow(0.5 * raw + 0.5 * norm * Math.min(1, this.ref[j] * 2.5), 1.1)
        amp[j] = Math.max(amp[j] * decay, Math.min(1.1, v))
        if (amp[j] > peak) peak = amp[j]
      }
    } else {
      for (let j = 0; j < PER_SIDE; j++) {
        amp[j] *= decay
        if (amp[j] > peak) peak = amp[j]
      }
    }
    // idle shimmer fades in when there's no signal
    const idleTarget = !f || !playing ? 1 : 0
    this.idle += (idleTarget - this.idle) * (1 - Math.exp(-dt / 600))
    if (!reduce) this.rot += (dt / 1000) * (playing ? 0.07 + kiai * 0.12 : 0.025)

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size, size)
    if (peak < 0.002 && this.idle < 0.01) return

    const c = size / 2
    const maxLen = radius * 0.52
    const step = Math.PI / PER_SIDE
    const hw = radius * step * 0.36
    const t = idleSeconds({ now, reduce })
    ctx.globalCompositeOperation = 'lighter'
    const alpha = Math.min(0.9, 0.32 + kiai * 0.22 + pulse * 0.1)
    ctx.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
    ctx.beginPath()
    for (let side = -1; side <= 1; side += 2) {
      for (let j = 0; j < PER_SIDE; j++) {
        const shimmer = this.idle * radius * (0.012 + 0.012 * (1 + Math.sin(t * 1.6 + j * 0.45 + (side > 0 ? 0 : 2.1))))
        const theta = -Math.PI / 2 + side * (j + 0.5) * step + this.rot
        const cx = Math.cos(theta)
        const cy = Math.sin(theta)
        // a soft dip around the bottom (cy → 1) keeps the bars out of the wordmark
        const dip = notch > 0 && cy > 0 ? notch * 0.75 * cy ** 6 : 0
        const len = amp[j] * maxLen * (1 - dip) + shimmer
        if (len < 0.4) continue
        const r0 = radius
        const r1 = radius + len
        const nx = -cy * hw
        const ny = cx * hw
        ctx.moveTo(c + cx * r0 + nx, c + cy * r0 + ny)
        ctx.lineTo(c + cx * r1 + nx, c + cy * r1 + ny)
        ctx.lineTo(c + cx * r1 - nx, c + cy * r1 - ny)
        ctx.lineTo(c + cx * r0 - nx, c + cy * r0 - ny)
      }
    }
    ctx.fill()
    ctx.globalCompositeOperation = 'source-over'
  }
}
