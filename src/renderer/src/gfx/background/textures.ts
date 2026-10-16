// Procedurally generated textures (made once, on a 2D canvas).
import { Texture } from 'pixi.js'

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!]
}

/** Soft rounded square with a faint inner sheen: the "drifting pixel". White, tint in Pixi. */
export function makePixelTexture(): Texture {
  const S = 96
  const [c, g] = canvas(S, S)
  const r = 18
  const inset = 16
  // outer glow
  g.filter = 'blur(6px)'
  g.fillStyle = 'rgba(255,255,255,0.45)'
  g.beginPath()
  g.roundRect(inset, inset, S - inset * 2, S - inset * 2, r)
  g.fill()
  // body
  g.filter = 'blur(1.2px)'
  const grad = g.createLinearGradient(inset, inset, S - inset, S - inset)
  grad.addColorStop(0, 'rgba(255,255,255,0.95)')
  grad.addColorStop(1, 'rgba(255,255,255,0.62)')
  g.fillStyle = grad
  g.beginPath()
  g.roundRect(inset + 2, inset + 2, S - inset * 2 - 4, S - inset * 2 - 4, r - 2)
  g.fill()
  g.filter = 'none'
  return Texture.from(c)
}

/** Large soft radial blob (near-Gaussian falloff) for the procedural gradient and flashes. */
export function makeBlobTexture(size = 256): Texture {
  const [c, g] = canvas(size, size)
  const h = size / 2
  const rg = g.createRadialGradient(h, h, 0, h, h, h)
  // sampled exp(-3.2 r²): smooth, no visible ring
  for (let i = 0; i <= 12; i++) {
    const t = i / 12
    rg.addColorStop(t, `rgba(255,255,255,${(Math.exp(-3.2 * t * t) - Math.exp(-3.2)) / (1 - Math.exp(-3.2))})`)
  }
  g.fillStyle = rg
  g.fillRect(0, 0, size, size)
  return Texture.from(c)
}
