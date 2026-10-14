// Kiai particle bursts: GHOST "pixels" (soft rounded squares) flung out of the active
// visualizer when a kiai section starts, plus small sprays on kiai downbeats. Pooled, one
// ParticleContainer, additive; nothing is allocated while bursting.
import { Particle, ParticleContainer } from 'pixi.js'
import { mixNumber } from '../../theme/color'
import type { VisTextures } from './textures'
import type { EmitPoint, VisFrame } from './types'
import { pcolor } from './util'

const POOL = 260
const TEX_CONTENT = 36 // px of the 64px pixel texture that the square occupies

interface Bit {
  p: Particle
  alive: boolean
  x: number
  y: number
  vx: number
  vy: number
  age: number
  life: number
  size: number
  spin: number
  white: number
  peak: number
}

export interface BurstOptions {
  count: number
  speed: [number, number]
  size: [number, number]
  life: [number, number]
  /** 0..1 peak alpha. */
  alpha: number
}

const rand = (a: number, b: number) => a + Math.random() * (b - a)

export class Burst {
  readonly root: ParticleContainer
  private bits: Bit[] = []
  private live = 0
  private pt: EmitPoint = { x: 0, y: 0, dx: 0, dy: -1 }

  constructor(tex: VisTextures) {
    this.root = new ParticleContainer({
      texture: tex.pixel,
      dynamicProperties: { position: true, vertex: true, rotation: true, color: true, uvs: false }
    })
    this.root.blendMode = 'add'
    for (let i = 0; i < POOL; i++) {
      const p = new Particle({ texture: tex.pixel, anchorX: 0.5, anchorY: 0.5 })
      p.color = 0
      this.bits.push({ p, alive: false, x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 1, size: 8, spin: 0, white: 0, peak: 1 })
    }
    this.root.addParticle(...this.bits.map((b) => b.p))
  }

  layout(w: number, h: number): void {
    this.root.boundsArea = { x: 0, y: 0, width: w, height: h } as never
  }

  emit(source: (i: number, n: number, out: EmitPoint) => void, o: BurstOptions): void {
    let spawned = 0
    for (let i = 0; i < this.bits.length && spawned < o.count; i++) {
      const b = this.bits[i]
      if (b.alive) continue
      source(spawned, o.count, this.pt)
      const jitter = rand(-0.38, 0.38)
      const c = Math.cos(jitter)
      const s = Math.sin(jitter)
      const dx = this.pt.dx * c - this.pt.dy * s
      const dy = this.pt.dx * s + this.pt.dy * c
      const sp = rand(o.speed[0], o.speed[1])
      b.alive = true
      b.x = this.pt.x
      b.y = this.pt.y
      b.vx = dx * sp
      b.vy = dy * sp
      b.age = 0
      b.life = rand(o.life[0], o.life[1])
      b.size = rand(o.size[0], o.size[1]) * (Math.random() < 0.12 ? 1.8 : 1)
      b.spin = rand(-3.2, 3.2)
      b.white = Math.random() * 0.7
      b.peak = o.alpha * rand(0.6, 1)
      b.p.rotation = Math.random() * Math.PI
      spawned++
      this.live++
    }
  }

  update(f: VisFrame): void {
    if (this.live === 0) {
      this.root.visible = false
      return
    }
    this.root.visible = true
    const dt = f.dt
    const sec = dt / 1000
    const drag = Math.exp(-dt / 520)
    for (const b of this.bits) {
      if (!b.alive) continue
      b.age += dt
      const p = b.age / b.life
      if (p >= 1) {
        b.alive = false
        b.p.color = 0
        this.live--
        continue
      }
      b.vx *= drag
      b.vy = b.vy * drag - 30 * sec // a little lift, like the background's rising pixels
      b.x += b.vx * sec
      b.y += b.vy * sec
      const q = b.p
      q.x = b.x
      q.y = b.y
      q.rotation += b.spin * sec
      const s = (b.size * (1 - 0.35 * p)) / TEX_CONTENT
      q.scaleX = s
      q.scaleY = s
      const fadeIn = Math.min(1, b.age / 70)
      q.color = pcolor(mixNumber(f.accent, f.white, b.white), b.peak * fadeIn * Math.pow(1 - p, 1.35))
    }
  }

  clear(): void {
    for (const b of this.bits) {
      b.alive = false
      b.p.color = 0
    }
    this.live = 0
  }

  destroy(): void {
    this.root.destroy({ children: true })
  }
}
