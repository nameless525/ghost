// "Drifting pixels": GHOST's answer to osu!'s triangles. Soft rounded squares of varied
// sizes rise slowly, tinted towards the accent. They brighten on beats, and during kiai the
// field swarms (wider sway), accelerates, and extra pixels fade in. One ParticleContainer =
// one draw call; vertex data is static (sizes never change), only position+colour stream.
import { Particle, ParticleContainer, type Texture } from 'pixi.js'
import { mixNumber } from '../../theme/color'

interface Px {
  p: Particle
  baseX: number
  y: number
  size: number
  speed: number
  depth: number
  alpha: number
  tintMix: number
  phase: number
  sway: number
  beatSens: number
  extra: boolean
}

const TEX_CONTENT = 64 / 96 // the square occupies ~64px of the 96px texture

export class PixelField {
  readonly root: ParticleContainer
  private px: Px[] = []
  private w = 0
  private h = 0
  private lastAccent = -1
  private speedMul = 1

  constructor(private tex: Texture) {
    this.root = new ParticleContainer({
      texture: tex,
      dynamicProperties: { position: true, color: true, vertex: false, rotation: false, uvs: false }
    })
    this.root.blendMode = 'add'
  }

  layout(w: number, h: number): void {
    if (Math.abs(w - this.w) < 2 && Math.abs(h - this.h) < 2) return
    const first = this.w === 0
    this.w = w
    this.h = h
    this.root.boundsArea = { x: 0, y: 0, width: w, height: h } as never
    const base = Math.round(Math.min(150, Math.max(55, (w * h) / 15000)))
    const extra = Math.round(base * 0.6)
    const want = base + extra
    // rebuild: cheap and only on resize
    this.root.removeParticles()
    this.px = []
    for (let i = 0; i < want; i++) this.px.push(this.spawn(i >= base, first ? Math.random() * (h + 120) - 60 : Math.random() * (h + 120) - 60))
    this.root.addParticle(...this.px.map((x) => x.p))
    this.root.update()
    this.lastAccent = -1
  }

  private spawn(extra: boolean, y: number): Px {
    const r = Math.random()
    const size = 6 + 50 * Math.pow(r, 2.4)
    const depth = Math.min(1, size / 56)
    const p = new Particle({ texture: this.tex, anchorX: 0.5, anchorY: 0.5 })
    const s = size / (this.tex.width * TEX_CONTENT)
    p.scaleX = s
    p.scaleY = s
    return {
      p,
      baseX: Math.random() * this.w,
      y,
      size,
      speed: 7 + 26 * depth + Math.random() * 6,
      depth,
      alpha: (0.05 + Math.random() * 0.11) * (1 - depth * 0.35),
      tintMix: 0.45 + Math.random() * 0.55,
      phase: Math.random() * Math.PI * 2,
      sway: 0.15 + Math.random() * 0.35,
      beatSens: Math.random() < 0.35 ? 1.6 + Math.random() : 0.3 + Math.random() * 0.6,
      extra
    }
  }

  /**
   * @param pulse beat envelope 0..~1.6   @param kiai 0..1   @param level loudness 0..1
   * @param px,py smoothed mouse -1..1    @param reduce reduced motion
   */
  update(dt: number, now: number, pulse: number, kiai: number, level: number, accent: number, px: number, py: number, reduce: boolean): void {
    const w = this.w
    const h = this.h
    if (!w) return
    const sec = dt / 1000
    const targetMul = reduce ? 0.35 : 1 + 2.6 * kiai + 0.5 * level
    this.speedMul += (targetMul - this.speedMul) * (1 - Math.exp(-dt / 260))
    const kick = reduce ? 0 : pulse * (0.9 + kiai * 1.6)
    const t = now / 1000
    const recolor = accent !== this.lastAccent
    this.lastAccent = accent
    const glow = 1 + level * 0.6 + kiai * 0.9

    for (let i = 0; i < this.px.length; i++) {
      const q = this.px[i]
      q.y -= q.speed * (this.speedMul + kick) * sec
      if (q.y < -q.size - 20) {
        q.y = h + q.size + Math.random() * 60
        q.baseX = Math.random() * w
      }
      const swayAmp = reduce ? 0 : (8 + 34 * kiai) * q.sway * (0.6 + q.depth)
      const x = q.baseX + Math.sin(t * (0.25 + q.sway * 0.5) + q.phase) * swayAmp - px * q.depth * w * 0.03
      const y = q.y - py * q.depth * h * 0.03
      q.p.x = x
      q.p.y = y
      // fade in from the bottom, out towards the top
      const edge = Math.min(1, (h + 40 - q.y) / (h * 0.25), (q.y + 40) / (h * 0.35))
      let a = q.alpha * glow * (1 + q.beatSens * pulse * 1.1) * Math.max(0, edge)
      if (q.extra) a *= kiai
      q.p.alpha = a > 1 ? 1 : a < 0 ? 0 : a
      if (recolor) q.p.tint = mixNumber(0xffffff, accent, q.tintMix)
    }
  }
}
