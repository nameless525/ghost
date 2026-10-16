// "Skyline": a mirrored spectrum along the bottom of the screen (bass in the middle, highs
// towards both edges) standing on a glowing horizon line, with osu!-style peak caps that hold
// and fall, additive bloom columns, and a soft reflection below the horizon.
import { Container, Particle, ParticleContainer, Sprite } from 'pixi.js'
import { easings } from '../../motion/easing'
import { mixNumber } from '../../theme/color'
import { Spectrum } from './spectrum'
import type { VisTextures } from './textures'
import type { EmitPoint, VisFrame, VisLayer, VisLayout } from './types'
import { idleSeconds, pcolor } from './util'

const PER_SIDE = 44
const N = PER_SIDE * 2

export class SkylineVisualizer implements VisLayer {
  readonly root = new Container()
  private floor: Sprite
  private line: Sprite
  private reflect: ParticleContainer
  private glow: ParticleContainer
  private bars: ParticleContainer
  private caps: ParticleContainer
  private reflP: Particle[] = []
  private glowP: Particle[] = []
  private barP: Particle[] = []
  private capP: Particle[] = []
  private spec = new Spectrum(PER_SIDE, { release: 190, hold: 320, gravity: 2.6 })
  private L: VisLayout = { w: 0, h: 0, cx: 0, cy: 0, radius: 100, baseline: 0, scopeY: 0 }
  private idle = 1

  constructor(private tex: VisTextures) {
    const dyn = { position: true, vertex: true, rotation: false, color: true, uvs: false }
    this.floor = new Sprite(tex.blob)
    this.floor.anchor.set(0.5)
    this.floor.blendMode = 'add'
    this.reflect = new ParticleContainer({ texture: tex.reflection, dynamicProperties: dyn })
    this.glow = new ParticleContainer({ texture: tex.glow, dynamicProperties: dyn })
    this.bars = new ParticleContainer({ texture: tex.bar, dynamicProperties: dyn })
    this.caps = new ParticleContainer({ texture: tex.cap, dynamicProperties: dyn })
    for (const pc of [this.reflect, this.glow, this.bars, this.caps]) pc.blendMode = 'add'
    for (let i = 0; i < N; i++) {
      this.reflP.push(new Particle({ texture: tex.reflection, anchorX: 0.5, anchorY: 1 }))
      this.glowP.push(new Particle({ texture: tex.glow, anchorX: 0.5, anchorY: 1 }))
      this.barP.push(new Particle({ texture: tex.bar, anchorX: 0.5, anchorY: 1 }))
      this.capP.push(new Particle({ texture: tex.cap, anchorX: 0.5, anchorY: 0.5 }))
    }
    this.reflect.addParticle(...this.reflP)
    this.glow.addParticle(...this.glowP)
    this.bars.addParticle(...this.barP)
    this.caps.addParticle(...this.capP)
    this.line = new Sprite(tex.line)
    this.line.anchor.set(0.5)
    this.line.blendMode = 'add'
    this.root.addChild(this.floor, this.reflect, this.glow, this.bars, this.line, this.caps)
  }

  layout(l: VisLayout): void {
    this.L = l
    const area = { x: 0, y: 0, width: l.w, height: l.h }
    for (const pc of [this.reflect, this.glow, this.bars, this.caps]) pc.boundsArea = area as never
  }

  private geometry() {
    const { w, h, baseline } = this.L
    const W = Math.min(w * 0.92, 2200)
    const x0 = (w - W) / 2
    const slot = W / N
    const H = Math.max(80, Math.min(h * 0.33, baseline - 110))
    return { W, x0, slot, H, baseline }
  }

  emitter(i: number, n: number, out: EmitPoint): void {
    const { W, x0, H, baseline } = this.geometry()
    const u = (i + Math.random()) / n
    out.x = x0 + u * W
    const j = Math.min(PER_SIDE - 1, Math.floor(Math.abs(u - 0.5) * 2 * PER_SIDE))
    out.y = baseline - this.spec.amp[j] * H
    const spread = (u - 0.5) * 1.4
    const len = Math.hypot(spread, 1)
    out.dx = spread / len
    out.dy = -1 / len
  }

  update(f: VisFrame, mix: number): void {
    const { dt } = f
    this.spec.update(dt, f.frame ? f.frame.bands : null, f.drive)
    const visible = mix > 0.002
    this.root.visible = visible
    if (!visible) return

    const { W, x0, slot, H, baseline } = this.geometry()
    const e = easings.outCubic(mix)
    const pulse = f.reduce ? 0 : f.pulse
    const idleTarget = f.playing && f.frame ? 0 : 1
    this.idle += (idleTarget - this.idle) * (1 - Math.exp(-dt / 600))
    this.root.y = (1 - e) * 46
    const t = idleSeconds(f)
    const barW = Math.max(2, slot * 0.52)
    const amp = this.spec.amp
    const peak = this.spec.peak
    const kiaiGlow = 1 + f.kiai * 0.9

    // horizon glow + line
    this.floor.position.set(this.L.w / 2, baseline)
    this.floor.scale.set((W * 1.15) / this.tex.blob.width, (H * 0.9) / this.tex.blob.height)
    this.floor.tint = f.accent
    this.floor.alpha = mix * (0.08 + f.bass * 0.2 + pulse * 0.06) * kiaiGlow
    this.line.position.set(this.L.w / 2, baseline + 1)
    this.line.scale.set((W * 1.08) / this.tex.line.width, 1)
    this.line.tint = f.accentHi
    this.line.alpha = mix * (0.45 + f.level * 0.35 + pulse * 0.2)

    for (let k = 0; k < N; k++) {
      const left = k < PER_SIDE
      const j = left ? PER_SIDE - 1 - k : k - PER_SIDE
      const x = x0 + (k + 0.5) * slot
      const shimmer = this.idle * (0.02 + 0.018 * (1 + Math.sin(t * 1.4 + j * 0.5 + (left ? 0 : 1.3))))
      // a touch of extra contrast so the skyline reads as peaks, not a wall
      const a = Math.pow(amp[j], 1.3)
      const len = Math.max(2, (a + shimmer) * H * e)
      const bright = Math.min(1, a * 1.3 + this.idle * 0.2)

      const b = this.barP[k]
      b.x = x
      b.y = baseline
      b.scaleX = barW / 16
      b.scaleY = len / 128
      b.color = pcolor(mixNumber(f.accent, f.white, 0.06 + bright * 0.32 + pulse * 0.06), mix * (0.42 + 0.5 * bright))

      const g = this.glowP[k]
      g.x = x
      g.y = baseline
      g.scaleX = (barW * 3.6) / 48
      g.scaleY = (len * 1.12 + 10) / 128
      g.color = pcolor(f.accent, mix * Math.min(1, (0.08 + 0.36 * a) * kiaiGlow))

      const r = this.reflP[k]
      r.x = x
      r.y = baseline + 3
      r.scaleX = barW / 16
      r.scaleY = -(len * 0.45) / 128
      r.color = pcolor(mixNumber(f.accentLo, f.accent, bright), mix * (0.3 + 0.25 * bright))

      const c = this.capP[k]
      const py = baseline - Math.max(len, Math.pow(peak[j], 1.3) * H * e) - 5
      c.x = x
      c.y = py
      c.scaleX = (barW * 1.15) / 28
      c.scaleY = 0.85
      const capA = Math.min(1, 0.25 + peak[j] * 1.4) * (1 - this.idle * 0.6)
      c.color = pcolor(mixNumber(f.accentHi, f.white, 0.6 + f.kiai * 0.3), mix * capA)
    }
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }
}
