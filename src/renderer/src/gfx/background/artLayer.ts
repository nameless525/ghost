// Background art: each image is decoded once and pre-blurred ONCE (Gaussian, on a small
// canvas) into a texture; frames only draw two sprites. Images cross-fade (~600 ms), drift
// with a slow Ken Burns move, and shift with mouse parallax.
import { Container, Sprite, Texture } from 'pixi.js'
import { easings } from '../../motion/easing'
import { motionPrefs } from '../../motion/prefs'

interface ArtTextures {
  sharp: Texture
  blurred: Texture
  w: number
  h: number
}

interface Slot {
  url: string
  root: Container
  sharp: Sprite
  blurred: Sprite
  tex: ArtTextures
  fade: number
  fadeFrom: number
  fadeTo: number
  fadeStart: number
  seed: number
  born: number
}

const FADE_MS = 650
const CACHE = 8

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    if (/^(https?|ghost-art):/i.test(url)) img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.onload = () => {
      img
        .decode()
        .catch(() => {})
        .then(() => resolve(img))
    }
    img.onerror = () => reject(new Error(`background art failed to load: ${url.slice(0, 80)}`))
    img.src = url
  })
}

function blurToCanvas(img: HTMLImageElement, quality: 'low' | 'high'): HTMLCanvasElement {
  // render small, blur in 2D (one-off), upscale with linear filtering in GL: soft and cheap
  const targetW = quality === 'high' ? 480 : 320
  const scale = Math.min(1, targetW / img.naturalWidth)
  const w = Math.max(32, Math.round(img.naturalWidth * scale))
  const h = Math.max(18, Math.round(img.naturalHeight * scale))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d')!
  const radius = Math.max(4, Math.round(w * (quality === 'high' ? 0.022 : 0.03)))
  g.filter = `blur(${radius}px) saturate(1.25)`
  // overshoot so the blur never pulls transparent edges in
  const over = radius * 3
  g.drawImage(img, -over, -over, w + over * 2, h + over * 2)
  g.filter = 'none'
  return c
}

export class ArtLayer {
  readonly root = new Container()
  private slots: Slot[] = []
  private cache = new Map<string, ArtTextures>()
  private pending: string | null = null
  private dim = 0.55
  private dimTarget = 0.55
  private blur = 1
  private blurTarget = 1
  quality: 'low' | 'high' = 'high'

  /** 0..1: how opaque the topmost settled art is (lets the gradient layer sleep). */
  coverage = 0

  setDim(dim: number, blur: number): void {
    this.dimTarget = Math.max(0, Math.min(1, dim))
    this.blurTarget = Math.max(0, Math.min(1, blur))
  }

  async setArt(url: string | null): Promise<void> {
    this.pending = url
    if (!url) {
      for (const s of this.slots) this.startFade(s, 0)
      return
    }
    if (this.slots.length && this.slots[this.slots.length - 1].url === url && this.slots[this.slots.length - 1].fadeTo === 1) return
    let tex = this.cache.get(url)
    if (!tex) {
      try {
        const img = await loadImage(url)
        const sharp = Texture.from(img)
        const blurred = Texture.from(blurToCanvas(img, this.quality))
        tex = { sharp, blurred, w: img.naturalWidth, h: img.naturalHeight }
        this.remember(url, tex)
      } catch (err) {
        console.warn(String(err))
        if (this.pending === url) for (const s of this.slots) this.startFade(s, 0)
        return
      }
    } else {
      // refresh LRU position
      this.cache.delete(url)
      this.cache.set(url, tex)
    }
    if (this.pending !== url) return
    this.push(url, tex)
  }

  private remember(url: string, tex: ArtTextures): void {
    this.cache.set(url, tex)
    while (this.cache.size > CACHE) {
      const [oldUrl, old] = this.cache.entries().next().value as [string, ArtTextures]
      if (this.slots.some((s) => s.tex === old)) {
        // in use: move it to the back and stop
        this.cache.delete(oldUrl)
        this.cache.set(oldUrl, old)
        break
      }
      this.cache.delete(oldUrl)
      old.sharp.destroy(true)
      old.blurred.destroy(true)
    }
  }

  private push(url: string, tex: ArtTextures): void {
    const root = new Container()
    const sharp = new Sprite(tex.sharp)
    const blurred = new Sprite(tex.blurred)
    sharp.anchor.set(0.5)
    blurred.anchor.set(0.5)
    root.addChild(sharp, blurred)
    root.alpha = 0
    this.root.addChild(root)
    const slot: Slot = { url, root, sharp, blurred, tex, fade: 0, fadeFrom: 0, fadeTo: 1, fadeStart: performance.now(), seed: Math.random() * 1000, born: performance.now() }
    this.slots.push(slot)
  }

  private startFade(s: Slot, to: number): void {
    if (s.fadeTo === to) return
    s.fadeFrom = s.fade
    s.fadeTo = to
    s.fadeStart = performance.now()
  }

  update(dt: number, now: number, w: number, h: number, px: number, py: number): void {
    const k = 1 - Math.exp(-dt / 140)
    this.dim += (this.dimTarget - this.dim) * k
    this.blur += (this.blurTarget - this.blur) * k
    const tintV = Math.round(255 * (1 - this.dim))
    const tint = (tintV << 16) | (tintV << 8) | tintV
    const reduce = motionPrefs.reduce

    let coverage = 0
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]
      const p = Math.min(1, (now - s.fadeStart) / (reduce ? 1 : FADE_MS))
      s.fade = s.fadeFrom + (s.fadeTo - s.fadeFrom) * easings.inOutSine(p)
      s.root.alpha = s.fade

      // cover-fit with margin for parallax + drift
      const base = Math.max(w / s.tex.w, h / s.tex.h) * 1.09
      const t = (now - s.born) / 1000
      const kb = reduce ? 0 : 1
      const zoom = 1 + kb * (0.025 + 0.025 * Math.sin(t / 23 + s.seed))
      const driftX = kb * Math.sin(t / 31 + s.seed * 1.7) * w * 0.012
      const driftY = kb * Math.cos(t / 37 + s.seed * 0.9) * h * 0.01
      const x = w / 2 + driftX - px * w * 0.022
      const y = h / 2 + driftY - py * h * 0.022
      for (const sp of [s.sharp, s.blurred]) {
        sp.position.set(x, y)
        sp.tint = tint
      }
      s.sharp.scale.set(base * zoom)
      s.blurred.width = s.tex.w * base * zoom
      s.blurred.height = s.tex.h * base * zoom
      s.blurred.alpha = this.blur
      s.sharp.visible = this.blur < 0.995
      s.blurred.visible = this.blur > 0.005
      if (s.fadeTo === 1) coverage = Math.max(coverage, s.fade)
    }
    this.coverage = coverage

    // retire slots that are fully hidden under a settled newer one, or faded out
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const s = this.slots[i]
      const coveredByNewer = this.slots.slice(i + 1).some((n) => n.fade >= 0.999 && n.fadeTo === 1)
      if ((s.fadeTo === 0 && s.fade <= 0.001) || coveredByNewer) {
        this.root.removeChild(s.root)
        s.root.destroy({ children: true })
        this.slots.splice(i, 1)
      }
    }
  }

  destroy(): void {
    for (const s of this.slots) s.root.destroy({ children: true })
    this.slots = []
    for (const t of this.cache.values()) {
      t.sharp.destroy(true)
      t.blurred.destroy(true)
    }
    this.cache.clear()
  }
}
