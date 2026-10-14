// Procedural gradient for when there's no art: big soft colour fields (accent, a hue-shifted
// companion, deep indigo, ocean blue) orbiting slowly on Lissajous paths and breathing with
// the music, added over the plum base. Cheap: five sprites.
import { Container, Sprite, type Texture } from 'pixi.js'
import { fromOklch, oklch } from '../../theme/color'

interface Blob {
  s: Sprite
  ax: number
  ay: number
  fx: number
  fy: number
  phase: number
  scale: number
  alpha: number
  role: 'accent' | 'shift' | 'deep' | 'cool' | 'lo'
}

const hexNum = (hex: string) => parseInt(hex.slice(1), 16)

export class GradientField {
  readonly root = new Container()
  private blobs: Blob[] = []
  private lastAccent = -1

  constructor(tex: Texture) {
    const defs: Omit<Blob, 's'>[] = [
      { role: 'deep', ax: 0.28, ay: 0.22, fx: 1 / 61, fy: 1 / 47, phase: 0.3, scale: 1.25, alpha: 0.55 },
      { role: 'accent', ax: 0.3, ay: 0.2, fx: 1 / 53, fy: 1 / 71, phase: 2.1, scale: 0.95, alpha: 0.3 },
      { role: 'shift', ax: 0.34, ay: 0.26, fx: 1 / 67, fy: 1 / 43, phase: 4.2, scale: 0.85, alpha: 0.22 },
      { role: 'cool', ax: 0.26, ay: 0.3, fx: 1 / 79, fy: 1 / 59, phase: 5.5, scale: 1.05, alpha: 0.26 },
      { role: 'lo', ax: 0.22, ay: 0.18, fx: 1 / 89, fy: 1 / 37, phase: 1.2, scale: 0.75, alpha: 0.28 }
    ]
    for (const d of defs) {
      const s = new Sprite(tex)
      s.anchor.set(0.5)
      s.blendMode = 'add'
      this.root.addChild(s)
      this.blobs.push({ ...d, s })
    }
  }

  private recolor(accent: number): void {
    const hex = '#' + accent.toString(16).padStart(6, '0')
    const { l, c, h } = oklch(hex)
    const colors: Record<Blob['role'], number> = {
      accent,
      shift: hexNum(fromOklch(Math.min(0.75, l), Math.max(0.12, c * 0.9), h + 0.75)),
      deep: hexNum(fromOklch(0.36, 0.13, h - 0.55)),
      cool: hexNum(fromOklch(0.42, 0.11, 4.1)),
      lo: hexNum(fromOklch(Math.max(0.3, l - 0.3), c, h - 0.2))
    }
    for (const b of this.blobs) b.s.tint = colors[b.role]
  }

  update(now: number, w: number, h: number, accent: number, level: number, pulse: number, px: number, py: number, reduce: boolean): void {
    if (accent !== this.lastAccent) {
      this.lastAccent = accent
      this.recolor(accent)
    }
    const t = reduce ? 0 : now / 1000
    const size = Math.max(w, h)
    const breathe = 1 + level * 0.06 + pulse * 0.02
    for (const b of this.blobs) {
      const x = w * (0.5 + b.ax * Math.sin(t * b.fx * Math.PI * 2 + b.phase)) - px * w * 0.012
      const y = h * (0.5 + b.ay * Math.cos(t * b.fy * Math.PI * 2 + b.phase * 1.3)) - py * h * 0.012
      b.s.position.set(x, y)
      const s = ((size * b.scale) / b.s.texture.width) * 1.25 * breathe
      b.s.scale.set(s)
      b.s.alpha = b.alpha * (0.85 + level * 0.3)
    }
  }
}
