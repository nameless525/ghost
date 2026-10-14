// "Scope": a glowing oscilloscope trace of frame().waveform with phosphor-like afterglow.
//
// The beam is a textured triangle strip: one strip carries both the white-hot core and its
// bloom (see makeBeamTexture), so there are no blur filters. A rising-zero-crossing trigger
// keeps periodic signals standing still, like a real scope. Afterglow: the last ~16 traces
// are kept as frozen strips (vertex data written once at capture) that fade, cool towards
// the deep accent and spread outwards, so the phosphor "remembers" where the beam has been.
// No feedback render-targets, so there's no 8-bit decay smear and no full-screen passes.
import { Container, MeshSimple, Sprite } from 'pixi.js'
import { easings } from '../../motion/easing'
import { mixNumber } from '../../theme/color'
import type { VisTextures } from './textures'
import type { EmitPoint, VisFrame, VisLayer, VisLayout } from './types'

const POINTS = 220
const SPAN = 384 // samples shown (of 512), leaving room to trigger
const TRAILS = 16
const CAPTURE_MS = 15
const HALF_W = 13

interface Trail {
  mesh: MeshSimple
  at: number
  used: boolean
}

function stripIndices(): Uint32Array {
  const idx = new Uint32Array((POINTS - 1) * 6)
  for (let i = 0; i < POINTS - 1; i++) {
    const a = i * 2
    idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6)
  }
  return idx
}

function stripUvs(): Float32Array {
  const uv = new Float32Array(POINTS * 4)
  for (let i = 0; i < POINTS; i++) {
    const u = i / (POINTS - 1)
    uv[i * 4] = u
    uv[i * 4 + 1] = 0
    uv[i * 4 + 2] = u
    uv[i * 4 + 3] = 1
  }
  return uv
}

export class ScopeVisualizer implements VisLayer {
  readonly root = new Container()
  private bloom: Sprite
  private axis: Sprite
  private trailRoot = new Container()
  private trails: Trail[] = []
  private live: MeshSimple
  private mirror: MeshSimple
  private L: VisLayout = { w: 0, h: 0, cx: 0, cy: 0, radius: 100, baseline: 0, scopeY: 0 }
  /** Displayed (smoothed) values per point, -1..1 after gain. */
  private disp = new Float32Array(POINTS)
  private target = new Float32Array(POINTS)
  private xs = new Float32Array(POINTS)
  private ys = new Float32Array(POINTS)
  private win = new Float32Array(POINTS)
  private peakTrack = 0.3
  private lastCapture = 0
  private idle = 1
  private uvs = stripUvs()
  private indices = stripIndices()

  constructor(private tex: VisTextures) {
    this.bloom = new Sprite(tex.blob)
    this.bloom.anchor.set(0.5)
    this.bloom.blendMode = 'add'
    this.axis = new Sprite(tex.line)
    this.axis.anchor.set(0.5)
    this.axis.blendMode = 'add'
    for (let i = 0; i < TRAILS; i++) {
      const mesh = this.makeStrip()
      mesh.autoUpdate = false
      mesh.visible = false
      this.trailRoot.addChild(mesh)
      this.trails.push({ mesh, at: -1e9, used: false })
    }
    this.mirror = this.makeStrip()
    this.live = this.makeStrip()
    this.root.addChild(this.bloom, this.axis, this.trailRoot, this.mirror, this.live)
    for (let i = 0; i < POINTS; i++) {
      const u = i / (POINTS - 1)
      this.win[i] = Math.pow(Math.sin(Math.PI * u), 0.55)
    }
  }

  private makeStrip(): MeshSimple {
    const m = new MeshSimple({ texture: this.tex.beam, vertices: new Float32Array(POINTS * 4), uvs: this.uvs, indices: this.indices })
    m.blendMode = 'add'
    return m
  }

  layout(l: VisLayout): void {
    this.L = l
  }

  private span() {
    const { w } = this.L
    const W = Math.min(w * 0.84, 2000)
    return { x0: (w - W) / 2, W }
  }

  emitter(i: number, n: number, out: EmitPoint): void {
    const { x0, W } = this.span()
    const u = (i + Math.random()) / n
    const k = Math.min(POINTS - 1, Math.round(u * (POINTS - 1)))
    out.x = x0 + u * W
    out.y = this.ys[k] || this.L.scopeY
    const up = Math.random() < 0.5 ? -1 : 1
    const sx = (Math.random() - 0.5) * 0.8
    const len = Math.hypot(sx, 1)
    out.dx = sx / len
    out.dy = up / len
  }

  /** Trigger on a rising zero crossing so periodic waves stand still. */
  private trigger(wave: Float32Array): number {
    const maxStart = Math.max(1, wave.length - SPAN)
    for (let i = 1; i < maxStart; i++) {
      if (wave[i - 1] < 0 && wave[i] >= 0 && wave[Math.min(wave.length - 1, i + 3)] > wave[i]) return i
    }
    return maxStart >> 1
  }

  /** Write a strip around the polyline (xs, ys) into `out`. */
  private writeStrip(out: Float32Array, hw: number, sign: number, cy: number): void {
    const { xs, ys } = this
    for (let i = 0; i < POINTS; i++) {
      const a = i > 0 ? i - 1 : i
      const b = i < POINTS - 1 ? i + 1 : i
      const tx = xs[b] - xs[a]
      const ty = (ys[b] - ys[a]) * sign
      const inv = hw / (Math.hypot(tx, ty) || 1)
      const nx = -ty * inv
      const ny = tx * inv
      const y = sign > 0 ? ys[i] : 2 * cy - ys[i]
      const o = i * 4
      out[o] = xs[i] + nx
      out[o + 1] = y + ny
      out[o + 2] = xs[i] - nx
      out[o + 3] = y - ny
    }
  }

  update(f: VisFrame, mix: number): void {
    const { dt, now } = f
    const visible = mix > 0.002
    this.root.visible = visible
    if (!visible) {
      for (const t of this.trails) t.used = false
      return
    }
    const { x0, W } = this.span()
    const cy = this.L.scopeY
    const e = easings.outCubic(mix)
    const pulse = f.reduce ? 0 : f.pulse
    const hasSignal = !!f.frame && f.playing
    this.idle += ((hasSignal ? 0 : 1) - this.idle) * (1 - Math.exp(-dt / 500))

    // 1. sample + trigger + adaptive gain
    const wave = f.frame?.waveform
    const target = this.target
    if (wave && wave.length > 8) {
      const start = this.trigger(wave)
      const span = Math.min(SPAN, wave.length - start - 1)
      let pk = 0
      for (let i = 0; i < POINTS; i++) {
        const s = start + (i / (POINTS - 1)) * span
        const k = s | 0
        const fr = s - k
        const v = wave[k] + (wave[k + 1] - wave[k]) * fr
        target[i] = v
        const av = v < 0 ? -v : v
        if (av > pk) pk = av
      }
      this.peakTrack = Math.max(this.peakTrack * Math.exp(-dt / 1400), pk, 0.05)
      const gain = Math.min(6, 0.92 / this.peakTrack) * f.drive
      for (let i = 0; i < POINTS; i++) target[i] *= gain
    } else {
      target.fill(0)
    }
    const t = now / 1000
    const k = 1 - Math.exp(-dt / (hasSignal ? 12 : 220))
    const A = Math.min(this.L.h * 0.2, 230) * (1 + 0.1 * pulse) * e
    for (let i = 0; i < POINTS; i++) {
      const u = i / (POINTS - 1)
      const idleWave = this.idle * 0.06 * Math.sin(u * Math.PI * 4 + t * 1.6) * Math.sin(t * 0.7 + u * 3)
      this.disp[i] += (target[i] + idleWave - this.disp[i]) * k
      this.xs[i] = x0 + u * W
      this.ys[i] = cy - this.disp[i] * this.win[i] * A
    }

    // 2. live beam (+ a faint inverted twin for depth)
    this.writeStrip(this.live.vertices as Float32Array, HALF_W * (1 + f.kiai * 0.25), 1, cy)
    this.live.tint = mixNumber(f.accentHi, f.white, 0.5 + f.kiai * 0.2)
    this.live.alpha = mix * Math.min(1, 0.85 + f.level * 0.3 + pulse * 0.12)
    this.writeStrip(this.mirror.vertices as Float32Array, HALF_W * 0.8, -1, cy)
    this.mirror.tint = f.accentLo
    this.mirror.alpha = mix * (0.2 + f.kiai * 0.12)

    // 3. phosphor afterglow
    const life = 230 + 220 * f.kiai
    if (!f.reduce && hasSignal && now - this.lastCapture >= CAPTURE_MS) {
      this.lastCapture = now
      // recycle the oldest trace (unused slots are the oldest of all)
      let slot = this.trails[0]
      for (const tr of this.trails) if ((tr.used ? tr.at : -Infinity) < (slot.used ? slot.at : -Infinity)) slot = tr
      const buf = slot.mesh.geometry.getBuffer('aPosition')
      ;(buf.data as Float32Array).set(this.live.vertices as Float32Array)
      buf.update()
      slot.at = now
      slot.used = true
    }
    for (const tr of this.trails) {
      const age = now - tr.at
      if (!tr.used || age > life) {
        tr.mesh.visible = false
        continue
      }
      const p = age / life
      const m = tr.mesh
      m.visible = true
      const spread = 1 + p * (0.1 + 0.16 * f.kiai)
      m.position.set(0, cy * (1 - spread))
      m.scale.set(1, spread)
      m.tint = mixNumber(f.accent, f.accentLo, p)
      m.alpha = mix * 0.42 * Math.pow(1 - p, 1.7) * (1 + f.kiai * 0.5)
    }

    // 4. bloom + axis
    this.bloom.position.set(this.L.w / 2, cy)
    this.bloom.scale.set((W * 0.95) / this.tex.blob.width, (A * 2.6 + 80) / this.tex.blob.height)
    this.bloom.tint = f.accent
    this.bloom.alpha = mix * (0.05 + f.level * 0.16 + pulse * 0.05) * (1 + f.kiai * 0.8)
    this.axis.position.set(this.L.w / 2, cy)
    this.axis.scale.set((W * 1.05) / this.tex.line.width, 1)
    this.axis.tint = f.accentLo
    this.axis.alpha = mix * 0.22
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }
}
