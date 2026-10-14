// "Radial": a large mirrored ring spectrum hugging the cover disc (bass at the top, highs
// flowing down both sides), with additive bloom columns, sparkling bar tips, a halo that
// breathes with the bass, and shockwave rings on downbeats (every beat during kiai).
// Three ParticleContainers = three draw calls for ~360 quads; everything else is sprites.
import { Container, Particle, ParticleContainer, Sprite } from 'pixi.js'
import type { BeatEvent } from '../../motion/beat'
import { easings } from '../../motion/easing'
import { mixNumber } from '../../theme/color'
import { Spectrum } from './spectrum'
import { pcolor } from './util'
import { RING_RADIUS_FRAC, type VisTextures } from './textures'
import type { EmitPoint, VisFrame, VisLayer, VisLayout } from './types'

const PER_SIDE = 60
const N = PER_SIDE * 2
const GAP = 9 // px between cover edge and bar roots
/** The DOM cover pulses by this much (usePulse amount); bars follow so they never overlap it. */
export const RADIAL_PULSE = 0.035

interface Wave {
  s: Sprite
  t: number
  life: number
  strength: number
  alive: boolean
}

export class RadialVisualizer implements VisLayer {
  readonly root = new Container()
  private halo: Sprite
  private ring: Sprite
  private glow: ParticleContainer
  private bars: ParticleContainer
  private tips: ParticleContainer
  private glowP: Particle[] = []
  private barP: Particle[] = []
  private tipP: Particle[] = []
  private waves: Wave[] = []
  private spec = new Spectrum(PER_SIDE, { release: 170, hold: 200 })
  private L: VisLayout = { w: 0, h: 0, cx: 0, cy: 0, radius: 100, baseline: 0, scopeY: 0 }
  private rot = 0
  private idle = 1

  constructor(private tex: VisTextures) {
    this.halo = new Sprite(tex.blob)
    this.halo.anchor.set(0.5)
    this.halo.blendMode = 'add'
    const dyn = { position: true, vertex: true, rotation: true, color: true, uvs: false }
    this.glow = new ParticleContainer({ texture: tex.glow, dynamicProperties: dyn })
    this.glow.blendMode = 'add'
    this.bars = new ParticleContainer({ texture: tex.bar, dynamicProperties: dyn })
    this.bars.blendMode = 'add'
    this.tips = new ParticleContainer({ texture: tex.dot, dynamicProperties: { position: true, vertex: true, rotation: false, color: true, uvs: false } })
    this.tips.blendMode = 'add'
    this.ring = new Sprite(tex.ring)
    this.ring.anchor.set(0.5)
    this.ring.blendMode = 'add'
    for (let i = 0; i < N; i++) {
      const g = new Particle({ texture: tex.glow, anchorX: 0.5, anchorY: 1 })
      const b = new Particle({ texture: tex.bar, anchorX: 0.5, anchorY: 1 })
      const t = new Particle({ texture: tex.dot, anchorX: 0.5, anchorY: 0.5 })
      this.glowP.push(g)
      this.barP.push(b)
      this.tipP.push(t)
    }
    this.glow.addParticle(...this.glowP)
    this.bars.addParticle(...this.barP)
    this.tips.addParticle(...this.tipP)
    const waveRoot = new Container()
    for (let i = 0; i < 8; i++) {
      const s = new Sprite(tex.ring)
      s.anchor.set(0.5)
      s.blendMode = 'add'
      s.visible = false
      waveRoot.addChild(s)
      this.waves.push({ s, t: 0, life: 1, strength: 0, alive: false })
    }
    this.root.addChild(this.halo, waveRoot, this.glow, this.bars, this.tips, this.ring)
  }

  layout(l: VisLayout): void {
    this.L = l
    const area = { x: 0, y: 0, width: l.w, height: l.h }
    this.glow.boundsArea = area as never
    this.bars.boundsArea = area as never
    this.tips.boundsArea = area as never
  }

  onBeat(e: BeatEvent, f: VisFrame): void {
    if (f.reduce) return
    const kiai = f.kiai > 0.5
    if (!e.downbeat && !kiai) return
    const w = this.waves.find((x) => !x.alive) ?? this.waves.reduce((a, b) => (a.t / a.life > b.t / b.life ? a : b))
    w.alive = true
    w.t = 0
    w.life = Math.min(1400, Math.max(650, e.beatLength * (kiai ? 1.6 : 2.2)))
    w.strength = (e.downbeat ? 1 : 0.55) * (kiai ? 1 : 0.55) * Math.min(1.3, e.strength)
    w.s.visible = true
  }

  emitter(i: number, n: number, out: EmitPoint): void {
    const { cx, cy, radius } = this.L
    const th = (i / n) * Math.PI * 2 + Math.random() * 0.3
    out.dx = Math.cos(th)
    out.dy = Math.sin(th)
    out.x = cx + out.dx * (radius + GAP + 8)
    out.y = cy + out.dy * (radius + GAP + 8)
  }

  update(f: VisFrame, mix: number): void {
    const { cx, cy, radius } = this.L
    const { dt } = f
    const visible = mix > 0.002
    this.root.visible = visible
    this.spec.update(dt, f.frame ? f.frame.bands : null, f.drive)
    if (!visible) return

    const e = easings.outCubic(mix)
    const pulse = f.reduce ? 0 : f.pulse
    const idleTarget = f.playing && f.frame ? 0 : 1
    this.idle += (idleTarget - this.idle) * (1 - Math.exp(-dt / 600))
    this.rot += (dt / 1000) * (f.reduce ? 0 : f.playing ? 0.045 + f.kiai * 0.11 : 0.012)

    const grow = 0.8 + 0.2 * e
    const R0 = radius * (1 + RADIAL_PULSE * pulse) * grow
    const r0 = R0 + GAP * grow
    const maxLen = radius * (0.66 + 0.22 * f.kiai) * grow
    const step = Math.PI / PER_SIDE
    const barW = Math.max(2, ((2 * Math.PI * r0) / N) * 0.46)
    const t = f.now / 1000
    const swirl = (1 - e) * 0.9

    // halo + base ring
    const hs = (radius * 3.6 * (1 + f.bass * 0.18 + pulse * 0.05)) / this.tex.blob.width
    this.halo.position.set(cx, cy)
    this.halo.scale.set(hs)
    this.halo.tint = f.accent
    this.halo.alpha = mix * (0.12 + f.bass * 0.22 + pulse * 0.08) * (1 + f.kiai * 0.7)
    const ringScale = (R0 + 2) / (this.tex.ring.width * RING_RADIUS_FRAC)
    this.ring.position.set(cx, cy)
    this.ring.scale.set(ringScale)
    this.ring.tint = f.accentHi
    this.ring.alpha = mix * (0.35 + 0.25 * f.level + pulse * 0.15)

    // spectrum bars, glows and tips
    const amp = this.spec.amp
    const kiaiGlow = 1 + f.kiai * 0.8
    const tipScale = 1 / this.tex.dot.width
    for (let side = 0; side < 2; side++) {
      const sgn = side === 0 ? -1 : 1
      for (let j = 0; j < PER_SIDE; j++) {
        const k = side * PER_SIDE + j
        const shimmer = this.idle * radius * (0.03 + 0.025 * (1 + Math.sin(t * 1.5 + j * 0.42 + side * 2.1)))
        const a = amp[j]
        const len = Math.max(1.5, a * maxLen + shimmer) * e
        const th = -Math.PI / 2 + sgn * (j + 0.5) * step + this.rot + sgn * swirl
        const c = Math.cos(th)
        const s = Math.sin(th)
        const x = cx + c * r0
        const y = cy + s * r0
        const rotation = th + Math.PI / 2
        const brightness = Math.min(1, a * 1.3 + this.idle * 0.25)

        const b = this.barP[k]
        b.x = x
        b.y = y
        b.rotation = rotation
        b.scaleX = barW / 16
        b.scaleY = len / 128
        b.color = pcolor(mixNumber(f.accentHi, f.white, 0.15 + brightness * 0.55), mix * (0.42 + 0.58 * brightness))

        const g = this.glowP[k]
        g.x = x
        g.y = y
        g.rotation = rotation
        g.scaleX = (barW * 4.2) / 48
        g.scaleY = (len * 1.18 + 6) / 128
        g.color = pcolor(f.accent, mix * Math.min(1, (0.1 + 0.42 * a) * kiaiGlow))

        const tp = this.tipP[k]
        const tipR = r0 + len + 3
        tp.x = cx + c * tipR
        tp.y = cy + s * tipR
        const ts = (barW * (1.9 + a * 1.6 + f.kiai * 0.8)) * tipScale
        tp.scaleX = ts
        tp.scaleY = ts
        tp.color = pcolor(f.white, mix * Math.min(1, a * a * 1.4 + pulse * a * 0.3) * (0.55 + f.kiai * 0.45))
      }
    }

    // shockwaves
    for (const w of this.waves) {
      if (!w.alive) continue
      w.t += dt
      const p = w.t / w.life
      if (p >= 1) {
        w.alive = false
        w.s.visible = false
        continue
      }
      const rr = R0 * (1 + 0.95 * easings.outQuad(p))
      w.s.position.set(cx, cy)
      w.s.scale.set(rr / (this.tex.ring.width * RING_RADIUS_FRAC))
      w.s.tint = mixNumber(f.accentHi, f.white, 0.3)
      w.s.alpha = mix * w.strength * 0.55 * Math.pow(1 - p, 1.6)
    }
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }
}
