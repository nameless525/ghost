// Procedural textures for the visualizers, drawn once on a 2D canvas (white; tinted in Pixi).
import { Texture } from 'pixi.js'

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!]
}

/** Horizontal alpha mask: 1px feathered edges so stretched bars stay antialiased. */
function featherX(g: CanvasRenderingContext2D, w: number, h: number, feather: number): void {
  g.globalCompositeOperation = 'destination-in'
  const m = g.createLinearGradient(0, 0, w, 0)
  const f = feather / w
  m.addColorStop(0, 'rgba(255,255,255,0)')
  m.addColorStop(f, 'rgba(255,255,255,1)')
  m.addColorStop(1 - f, 'rgba(255,255,255,1)')
  m.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = m
  g.fillRect(0, 0, w, h)
  g.globalCompositeOperation = 'source-over'
}

/**
 * Spectrum bar (16×128): feathered sides, bright tip fading to a dimmer root. Anchor it at
 * the bottom (anchorY = 1) and stretch with scaleY.
 */
export function makeBarTexture(): Texture {
  const W = 16
  const H = 128
  const [c, g] = canvas(W, H)
  const v = g.createLinearGradient(0, 0, 0, H)
  v.addColorStop(0, 'rgba(255,255,255,1)')
  v.addColorStop(0.06, 'rgba(255,255,255,0.96)')
  v.addColorStop(1, 'rgba(255,255,255,0.42)')
  g.fillStyle = v
  g.fillRect(0, 0, W, H)
  featherX(g, W, H, 2.5)
  return Texture.from(c)
}

/** Reflection bar: brightest at its root (bottom), transparent at its tip. Flip with scaleY < 0. */
export function makeReflectionTexture(): Texture {
  const W = 16
  const H = 128
  const [c, g] = canvas(W, H)
  const v = g.createLinearGradient(0, 0, 0, H)
  v.addColorStop(0, 'rgba(255,255,255,0)')
  v.addColorStop(0.55, 'rgba(255,255,255,0.18)')
  v.addColorStop(1, 'rgba(255,255,255,0.75)')
  g.fillStyle = v
  g.fillRect(0, 0, W, H)
  featherX(g, W, H, 2.5)
  return Texture.from(c)
}

/** Soft glow column (gaussian across, gently fading at both ends): additive bloom behind bars. */
export function makeGlowTexture(): Texture {
  const W = 48
  const H = 128
  const [c, g] = canvas(W, H)
  const img = g.createImageData(W, H)
  for (let y = 0; y < H; y++) {
    const ty = y / (H - 1)
    const vy = Math.min(1, ty / 0.18, (1 - ty) / 0.08)
    for (let x = 0; x < W; x++) {
      const dx = (x + 0.5) / W - 0.5
      const a = Math.exp(-dx * dx * 26) * Math.max(0, vy)
      const i = (y * W + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
      img.data[i + 3] = Math.round(a * 255)
    }
  }
  g.putImageData(img, 0, 0)
  return Texture.from(c)
}

/** Small rounded cap for skyline peak markers. */
export function makeCapTexture(): Texture {
  const W = 32
  const H = 12
  const [c, g] = canvas(W, H)
  g.filter = 'blur(0.6px)'
  g.fillStyle = '#fff'
  g.beginPath()
  g.roundRect(2, 3, W - 4, H - 6, 3)
  g.fill()
  g.filter = 'none'
  return Texture.from(c)
}

/** Soft round dot (near-gaussian). */
export function makeDotTexture(size = 64): Texture {
  const [c, g] = canvas(size, size)
  const h = size / 2
  const rg = g.createRadialGradient(h, h, 0, h, h, h)
  rg.addColorStop(0, 'rgba(255,255,255,1)')
  rg.addColorStop(0.25, 'rgba(255,255,255,0.85)')
  rg.addColorStop(0.6, 'rgba(255,255,255,0.22)')
  rg.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = rg
  g.fillRect(0, 0, size, size)
  return Texture.from(c)
}

/** Thin ring with a soft halo, for shockwaves and the radial base ring. Radius = 0.42 × size. */
export const RING_RADIUS_FRAC = 0.42
export function makeRingTexture(size = 512, thickness = 3): Texture {
  const [c, g] = canvas(size, size)
  const h = size / 2
  const r = size * RING_RADIUS_FRAC
  g.strokeStyle = 'rgba(255,255,255,0.35)'
  g.filter = 'blur(10px)'
  g.lineWidth = thickness * 5
  g.beginPath()
  g.arc(h, h, r, 0, Math.PI * 2)
  g.stroke()
  g.filter = 'blur(0.7px)'
  g.strokeStyle = 'rgba(255,255,255,1)'
  g.lineWidth = thickness
  g.beginPath()
  g.arc(h, h, r, 0, Math.PI * 2)
  g.stroke()
  g.filter = 'none'
  return Texture.from(c)
}

/**
 * Cross-section of an oscilloscope beam (8×64), sampled along v (0..1 across the strip):
 * a wide gaussian glow plus a narrow white-hot core. One textured strip = line + bloom.
 */
export function makeBeamTexture(): Texture {
  const W = 8
  const H = 64
  const [c, g] = canvas(W, H)
  const img = g.createImageData(W, H)
  for (let y = 0; y < H; y++) {
    const d = ((y + 0.5) / H - 0.5) * 2 // -1..1
    const glow = Math.exp(-d * d * 7) * 0.42
    const core = Math.exp(-d * d * 260)
    const a = Math.min(1, glow + core)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255
      img.data[i + 3] = Math.round(a * 255)
    }
  }
  g.putImageData(img, 0, 0)
  return Texture.from(c)
}

/** Screen-edge kiai flash: opaque at the left edge, fading out to the right (mirror for the right edge). */
export function makeEdgeTexture(): Texture {
  const W = 256
  const H = 8
  const [c, g] = canvas(W, H)
  const lg = g.createLinearGradient(0, 0, W, 0)
  for (let i = 0; i <= 10; i++) {
    const t = i / 10
    lg.addColorStop(t, `rgba(255,255,255,${Math.pow(1 - t, 2.2).toFixed(3)})`)
  }
  g.fillStyle = lg
  g.fillRect(0, 0, W, H)
  return Texture.from(c)
}

/** Horizontal hairline with soft halo (skyline baseline). */
export function makeLineTexture(): Texture {
  const W = 256
  const H = 24
  const [c, g] = canvas(W, H)
  const fadeX = g.createLinearGradient(0, 0, W, 0)
  fadeX.addColorStop(0, 'rgba(255,255,255,0)')
  fadeX.addColorStop(0.2, 'rgba(255,255,255,1)')
  fadeX.addColorStop(0.8, 'rgba(255,255,255,1)')
  fadeX.addColorStop(1, 'rgba(255,255,255,0)')
  for (let y = 0; y < H; y++) {
    const d = (y + 0.5 - H / 2) / (H / 2)
    const a = Math.exp(-d * d * 10) * 0.35 + Math.exp(-d * d * 400)
    g.globalAlpha = Math.min(1, a)
    g.fillStyle = fadeX
    g.fillRect(0, y, W, 1)
  }
  g.globalAlpha = 1
  return Texture.from(c)
}

/** Large soft radial blob (exp falloff) for halos and blooms. */
export function makeBlobTexture(size = 256): Texture {
  const [c, g] = canvas(size, size)
  const h = size / 2
  const rg = g.createRadialGradient(h, h, 0, h, h, h)
  for (let i = 0; i <= 12; i++) {
    const t = i / 12
    rg.addColorStop(t, `rgba(255,255,255,${((Math.exp(-3.2 * t * t) - Math.exp(-3.2)) / (1 - Math.exp(-3.2))).toFixed(4)})`)
  }
  g.fillStyle = rg
  g.fillRect(0, 0, size, size)
  return Texture.from(c)
}

/** Soft rounded square: GHOST's "pixel" motif, for kiai bursts. */
export function makePixelTexture(): Texture {
  const S = 64
  const [c, g] = canvas(S, S)
  const inset = 12
  g.filter = 'blur(4px)'
  g.fillStyle = 'rgba(255,255,255,0.5)'
  g.beginPath()
  g.roundRect(inset, inset, S - inset * 2, S - inset * 2, 10)
  g.fill()
  g.filter = 'blur(0.8px)'
  g.fillStyle = 'rgba(255,255,255,0.95)'
  g.beginPath()
  g.roundRect(inset + 2, inset + 2, S - inset * 2 - 4, S - inset * 2 - 4, 8)
  g.fill()
  g.filter = 'none'
  return Texture.from(c)
}

export interface VisTextures {
  bar: Texture
  reflection: Texture
  glow: Texture
  cap: Texture
  dot: Texture
  ring: Texture
  beam: Texture
  edge: Texture
  line: Texture
  blob: Texture
  pixel: Texture
}

export function makeTextures(): VisTextures {
  return {
    bar: makeBarTexture(),
    reflection: makeReflectionTexture(),
    glow: makeGlowTexture(),
    cap: makeCapTexture(),
    dot: makeDotTexture(),
    ring: makeRingTexture(),
    beam: makeBeamTexture(),
    edge: makeEdgeTexture(),
    line: makeLineTexture(),
    blob: makeBlobTexture(),
    pixel: makePixelTexture()
  }
}

export function destroyTextures(t: VisTextures): void {
  for (const tex of Object.values(t)) tex.destroy(true)
}
