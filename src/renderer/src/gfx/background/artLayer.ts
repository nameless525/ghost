// Background art: each image is decoded off the main thread (createImageBitmap) and pre-blurred
// ONCE (Gaussian, on a small canvas) into a texture; frames only draw two sprites. Images
// cross-fade (~650 ms), drift with a slow Ken Burns move, and shift with mouse parallax.
//
// Two textures per image, loaded at different sizes:
//   blurred  from a ~512 px copy of the art (the blur runs at 320–480 px anyway). This is all
//            Browse/Title ever show, so a selection change costs a ~50 KB fetch, an off-thread
//            decode and a tiny upload, never a 1600 px scan.
//   sharp    the capped full-size art, fetched only once a screen asks for less blur (Play).
//            It fades in over the blurred copy when it arrives.
// The blur quality setting is part of what's shown: changing it rebuilds the blurred copy of the
// art on screen, which cross-fades in like new art (over the same sharp copy, so Play doesn't flash).
import { Container, Sprite, Texture } from 'pixi.js'
import { artUrl } from '../../lib/art'
import { easings } from '../../motion/easing'
import { motionPrefs } from '../../motion/prefs'

type Quality = 'low' | 'high'
const QUALITIES: Quality[] = ['low', 'high']

/** One image (by URL). */
interface ArtEntry {
  url: string
  /** The pre-blurred copy, per blur quality it has been shown at. */
  blurred: Partial<Record<Quality, Texture>>
  /** Natural aspect of the art (width / height). */
  aspect: number
  sharp: Texture | null
  sharpBitmap: ImageBitmap | null
  sharpLoading: Promise<void> | null
  sharpFailed: boolean
  /** Evicted while a sharp load was in flight: destroy it when it lands. */
  dead: boolean
}

interface Slot {
  url: string
  quality: Quality
  root: Container
  sharp: Sprite
  blurred: Sprite
  art: ArtEntry
  fade: number
  fadeFrom: number
  fadeTo: number
  fadeStart: number
  /** 0..1 ramp once the sharp texture is in (it never pops in). */
  sharpIn: number
  seed: number
  born: number
}

const FADE_MS = 650
const SHARP_FADE_MS = 400
const CACHE = 8
/**
 * Full-size copies (up to ~10 MB decoded each) are only needed while a screen shows the art
 * sharp (Play): drop them this long after the blur is back, and keep one per image on screen.
 */
const SHARP_KEEP_MS = 10_000
/** Device-px width requested for the blur source. */
const BLUR_SRC_PX = 512

/** Decode an image off the main thread. Falls back to <img> (e.g. CORS-less URLs in the web mock). */
async function decode(url: string, resizeWidth?: number): Promise<ImageBitmap> {
  let res: Response | null = null
  try {
    res = await fetch(url)
  } catch {
    /* not fetchable (e.g. no CORS in the web mock): fall back to <img> below */
  }
  if (res?.status === 404) throw new Error(`background art not found: ${url.slice(0, 80)}`)
  const blob = res?.ok ? await res.blob() : null
  let src: ImageBitmapSource
  if (blob) src = blob
  else {
    const img = new Image()
    if (/^(https?|ghost-art):/i.test(url)) img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    img.src = url
    await img.decode().catch(() => {
      throw new Error(`background art failed to load: ${url.slice(0, 80)}`)
    })
    src = img
  }
  if (!resizeWidth) return createImageBitmap(src)
  // resize while decoding (only ever down); needs the natural size first for the aspect
  const probe = await createImageBitmap(src)
  if (probe.width <= resizeWidth) return probe
  const h = Math.max(1, Math.round((probe.height * resizeWidth) / probe.width))
  probe.close()
  return createImageBitmap(src, { resizeWidth, resizeHeight: h, resizeQuality: 'medium' })
}

function blurToCanvas(img: ImageBitmap, quality: 'low' | 'high'): HTMLCanvasElement {
  // render small, blur in 2D (one-off), upscale with linear filtering in GL: soft and cheap
  const targetW = quality === 'high' ? 480 : 320
  const scale = Math.min(1, targetW / img.width)
  const w = Math.max(32, Math.round(img.width * scale))
  const h = Math.max(18, Math.round(img.height * scale))
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

/** Position/size/tint a sprite (per frame; no allocation). */
function place(sp: Sprite, x: number, y: number, w: number, h: number, tint: number): void {
  sp.position.set(x, y)
  sp.tint = tint
  sp.width = w
  sp.height = h
}

function destroyEntry(e: ArtEntry): void {
  e.dead = true
  for (const q of QUALITIES) e.blurred[q]?.destroy(true)
  e.blurred = {}
  releaseSharp(e)
}

function releaseSharp(e: ArtEntry): void {
  e.sharp?.destroy(true)
  e.sharpBitmap?.close()
  e.sharp = null
  e.sharpBitmap = null
}

export class ArtLayer {
  readonly root = new Container()
  private slots: Slot[] = []
  private cache = new Map<string, ArtEntry>()
  /** The art (and the quality) the latest setArt asked for. */
  private pending: { url: string; quality: Quality } | null = null
  private dim = 0.55
  private dimTarget = 0.55
  private blur = 1
  private blurTarget = 1
  /** When the art went back to fully blurred (0 while a screen wants it sharp). */
  private blurredSince = 0
  private quality: Quality = 'high'

  /** 0..1: how opaque the topmost settled art is (lets the gradient layer sleep). */
  coverage = 0

  /** True while a screen shows the art (partly) unblurred, i.e. the sharp texture matters. */
  private get wantsSharp(): boolean {
    return this.blurTarget < 0.995 || this.blur < 0.995
  }

  setDim(dim: number, blur: number): void {
    this.dimTarget = Math.max(0, Math.min(1, dim))
    this.blurTarget = Math.max(0, Math.min(1, blur))
    if (this.wantsSharp) for (const s of this.slots) if (s.fadeTo === 1) this.ensureSharp(s.art)
  }

  /** `url`: raw art URL (http(s) or local); sizing/caching through ghost-art:// is handled here. */
  async setArt(url: string | null): Promise<void> {
    const quality = this.quality
    this.pending = url ? { url, quality } : null
    if (!url) {
      for (const s of this.slots) this.startFade(s, 0)
      return
    }
    const top = this.slots[this.slots.length - 1]
    if (top && top.url === url && top.quality === quality && top.fadeTo === 1) return
    let art = this.cache.get(url)
    if (!art?.blurred[quality]) {
      try {
        const bmp = await decode(artUrl(url, { w: BLUR_SRC_PX, dpr: 1 })!, BLUR_SRC_PX)
        const canvas = blurToCanvas(bmp, quality)
        const aspect = bmp.width / Math.max(1, bmp.height)
        bmp.close()
        const blurred = Texture.from(canvas)
        // the quality changed while this loaded: that change's own setArt shows the art
        if (quality !== this.quality) {
          blurred.destroy(true)
          return
        }
        // a concurrent call may have filled it meanwhile
        art = this.cache.get(url)
        if (art?.blurred[quality]) blurred.destroy(true)
        else if (art) art.blurred[quality] = blurred
        else {
          art = { url, blurred: { [quality]: blurred }, aspect, sharp: null, sharpBitmap: null, sharpLoading: null, sharpFailed: false, dead: false }
          this.remember(art)
        }
      } catch (err) {
        console.warn(String(err))
        if (this.isPending(url, quality)) for (const s of this.slots) this.startFade(s, 0)
        return
      }
    }
    // refresh LRU position
    this.cache.delete(url)
    this.cache.set(url, art)
    if (!this.isPending(url, quality)) return
    this.push(url, art, quality)
    if (this.wantsSharp) this.ensureSharp(art)
  }

  private isPending(url: string, quality: Quality): boolean {
    return this.pending?.url === url && this.pending.quality === quality
  }

  /** The blur quality (settings.interface.blurQuality): the art on screen is rebuilt at it. */
  setQuality(q: Quality): void {
    if (q === this.quality) return
    this.quality = q
    for (const e of this.cache.values()) for (const other of QUALITIES) if (other !== q) this.releaseBlurred(e, other)
    if (this.pending) void this.setArt(this.pending.url)
  }

  /** Free an image's blurred copy at `q` unless a slot still shows it (it's freed as it retires). */
  private releaseBlurred(e: ArtEntry, q: Quality): void {
    if (!e.blurred[q] || this.slots.some((s) => s.art === e && s.quality === q)) return
    e.blurred[q]!.destroy(true)
    delete e.blurred[q]
  }

  private ensureSharp(art: ArtEntry): void {
    if (art.sharp || art.sharpLoading || art.sharpFailed || art.dead) return
    art.sharpLoading = decode(artUrl(art.url)!)
      .then((bmp) => {
        if (art.dead) {
          bmp.close()
          return
        }
        art.sharpBitmap = bmp
        art.sharp = Texture.from(bmp)
        this.dropSharp((e) => e !== art)
      })
      .catch((err) => {
        art.sharpFailed = true
        console.warn(String(err))
      })
      .finally(() => {
        art.sharpLoading = null
      })
  }

  /** Free the full-size copies of cached art that `which` picks and no slot is showing sharp. */
  private dropSharp(which: (e: ArtEntry) => boolean): void {
    for (const e of this.cache.values()) {
      if (!e.sharp || !which(e)) continue
      if (this.slots.some((s) => s.art === e && s.sharp.visible)) continue
      for (const s of this.slots) {
        if (s.art !== e) continue
        s.sharp.texture = Texture.EMPTY
        s.sharpIn = 0
      }
      releaseSharp(e)
    }
  }

  private remember(art: ArtEntry): void {
    this.cache.set(art.url, art)
    while (this.cache.size > CACHE) {
      const [oldKey, old] = this.cache.entries().next().value as [string, ArtEntry]
      if (this.slots.some((s) => s.art === old)) {
        // in use: move it to the back and stop
        this.cache.delete(oldKey)
        this.cache.set(oldKey, old)
        break
      }
      this.cache.delete(oldKey)
      destroyEntry(old)
    }
  }

  private push(url: string, art: ArtEntry, quality: Quality): void {
    const root = new Container()
    const sharp = new Sprite(art.sharp ?? Texture.EMPTY)
    const blurred = new Sprite(art.blurred[quality])
    sharp.anchor.set(0.5)
    blurred.anchor.set(0.5)
    root.addChild(sharp, blurred)
    root.alpha = 0
    this.root.addChild(root)
    const now = performance.now()
    // the same image again (rebuilt at another blur quality): keep its drift, or the two copies
    // would cross-fade out of register
    const prev = this.slots[this.slots.length - 1]
    const same = prev?.art === art
    this.slots.push({
      url,
      quality,
      root,
      sharp,
      blurred,
      art,
      fade: 0,
      fadeFrom: 0,
      fadeTo: 1,
      fadeStart: now,
      sharpIn: art.sharp ? 1 : 0,
      seed: same ? prev.seed : Math.random() * 1000,
      born: same ? prev.born : now
    })
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
    if (Math.abs(this.blur - this.blurTarget) < 0.0005) this.blur = this.blurTarget
    const tintV = Math.round(255 * (1 - this.dim))
    const tint = (tintV << 16) | (tintV << 8) | tintV
    const reduce = motionPrefs.reduce

    let coverage = 0
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]
      const p = Math.min(1, (now - s.fadeStart) / (reduce ? 1 : FADE_MS))
      s.fade = s.fadeFrom + (s.fadeTo - s.fadeFrom) * easings.inOutSine(p)
      s.root.alpha = s.fade

      // the sharp copy arrived: swap it in under the blurred one and ramp it up
      if (s.art.sharp && s.sharp.texture !== s.art.sharp) s.sharp.texture = s.art.sharp
      if (s.art.sharp && s.sharpIn < 1) s.sharpIn = reduce ? 1 : Math.min(1, s.sharpIn + dt / SHARP_FADE_MS)

      // cover-fit with margin for parallax + drift (sizes in CSS px, independent of texture size)
      const aw = s.art.aspect
      const base = Math.max(w / aw, h) * 1.09
      const t = (now - s.born) / 1000
      const kb = reduce ? 0 : 1
      const zoom = 1 + kb * (0.025 + 0.025 * Math.sin(t / 23 + s.seed))
      const driftX = kb * Math.sin(t / 31 + s.seed * 1.7) * w * 0.012
      const driftY = kb * Math.cos(t / 37 + s.seed * 0.9) * h * 0.01
      const x = w / 2 + driftX - px * w * 0.022
      const y = h / 2 + driftY - py * h * 0.022
      const dw = aw * base * zoom
      const dh = base * zoom
      // blurred alpha: the configured blur amount, but never uncover a sharp copy that isn't in yet
      const sharpShown = this.blur < 0.995 && !!s.art.sharp
      const bAlpha = 1 - (1 - this.blur) * (s.art.sharp ? easings.inOutSine(s.sharpIn) : 0)
      place(s.sharp, x, y, dw, dh, tint)
      place(s.blurred, x, y, dw, dh, tint)
      s.blurred.alpha = bAlpha
      s.sharp.visible = sharpShown
      s.blurred.visible = bAlpha > 0.005
      if (s.fadeTo === 1) coverage = Math.max(coverage, s.fade)
    }
    this.coverage = coverage

    if (this.wantsSharp) this.blurredSince = 0
    else if (!this.blurredSince) this.blurredSince = now
    else if (now - this.blurredSince > SHARP_KEEP_MS) {
      this.dropSharp(() => true)
      this.blurredSince = Infinity // done until a screen asks for sharp art again
    }

    // retire slots that are fully hidden under a settled newer one, or faded out
    for (let i = this.slots.length - 1; i >= 0; i--) {
      const s = this.slots[i]
      let coveredByNewer = false
      for (let j = i + 1; j < this.slots.length; j++) {
        const n = this.slots[j]
        if (n.fade >= 0.999 && n.fadeTo === 1) {
          coveredByNewer = true
          break
        }
      }
      if ((s.fadeTo === 0 && s.fade <= 0.001) || coveredByNewer) {
        this.root.removeChild(s.root)
        s.root.destroy({ children: true })
        this.slots.splice(i, 1)
        if (s.quality !== this.quality) this.releaseBlurred(s.art, s.quality)
      }
    }
  }

  destroy(): void {
    for (const s of this.slots) s.root.destroy({ children: true })
    this.slots = []
    for (const e of this.cache.values()) destroyEntry(e)
    this.cache.clear()
  }
}
