// The single full-window PixiJS canvas behind the DOM, shared by every screen.
// Layers (bottom → top): procedural gradient · blurred art · drifting pixels · kiai flash.
// Vignette and film grain are static CSS layers above the canvas (zero per-frame cost).
// Rendering is driven by the global ticker (no Pixi ticker), so it shares the one rAF loop
// and stops while the window is hidden.
import { autoDetectRenderer, Container, Sprite, type Renderer } from 'pixi.js'
import { artUrl } from '../../lib/art'
import { beat } from '../../motion/beat'
import { damp } from '../../motion/easing'
import { levels, retainLevels } from '../../motion/frame'
import { motionPrefs } from '../../motion/prefs'
import { ticker, TickPriority } from '../../motion/ticker'
import { accentNow } from '../../theme/accent'
import { mixNumber } from '../../theme/color'
import { ArtLayer } from './artLayer'
import { GradientField } from './gradient'
import { PixelField } from './pixels'
import { makeBlobTexture, makePixelTexture } from './textures'

const BASE_COLOR = 0x0f0d17

export class BackgroundEngine {
  private renderer: Renderer | null = null
  private stage = new Container()
  private art = new ArtLayer()
  private gradient: GradientField | null = null
  private pixels: PixelField | null = null
  private flash: Sprite | null = null
  private flashAlpha = 0
  private w = 0
  private h = 0
  private res = 1
  private quality: 'low' | 'high' = 'high'
  private mouse = { tx: 0, ty: 0, x: 0, y: 0 }
  private offs: (() => void)[] = []
  private host: HTMLElement | null = null
  private destroyed = false
  private shown = false
  readonly ready: Promise<void>

  constructor() {
    this.ready = this.init()
  }

  private resolutionFor(q: 'low' | 'high'): number {
    return q === 'high' ? Math.min(2, window.devicePixelRatio || 1) : 1
  }

  private async init(): Promise<void> {
    this.res = this.resolutionFor(this.quality)
    const r = await autoDetectRenderer({
      preference: 'webgl',
      width: window.innerWidth,
      height: window.innerHeight,
      resolution: this.res,
      autoDensity: true,
      antialias: false,
      background: BASE_COLOR,
      hello: false,
      powerPreference: 'high-performance'
    })
    if (this.destroyed) {
      r.destroy()
      return
    }
    this.renderer = r
    r.canvas.classList.add('g-bg__gl')
    const blob = makeBlobTexture()
    this.gradient = new GradientField(blob)
    this.pixels = new PixelField(makePixelTexture())
    this.flash = new Sprite(blob)
    this.flash.anchor.set(0.5)
    this.flash.blendMode = 'add'
    this.flash.visible = false
    this.stage.addChild(this.gradient.root, this.art.root, this.pixels.root, this.flash)
    this.resize()
    if (this.host) this.mount()
  }

  attach(host: HTMLElement): void {
    this.host = host
    if (this.renderer) this.mount()
  }

  detach(): void {
    this.host = null
    this.renderer?.canvas.remove()
    this.offs.forEach((f) => f())
    this.offs = []
  }

  private mount(): void {
    if (!this.renderer || !this.host) return
    if (this.renderer.canvas.parentElement !== this.host) this.host.appendChild(this.renderer.canvas)
    if (this.offs.length) return
    const onMove = (e: PointerEvent) => {
      this.mouse.tx = (e.clientX / window.innerWidth) * 2 - 1
      this.mouse.ty = (e.clientY / window.innerHeight) * 2 - 1
    }
    const onLeave = () => {
      this.mouse.tx = 0
      this.mouse.ty = 0
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', onLeave)
    this.offs.push(
      () => window.removeEventListener('pointermove', onMove),
      () => document.documentElement.removeEventListener('pointerleave', onLeave),
      retainLevels(),
      beat.onBeat((e) => {
        if (motionPrefs.reduce || !e.kiai) return
        this.flashAlpha = Math.max(this.flashAlpha, e.downbeat ? 0.15 : 0.045)
      }),
      beat.onKiai((on) => {
        if (on && !motionPrefs.reduce) this.flashAlpha = Math.max(this.flashAlpha, 0.24)
      }),
      ticker.add(this.tick, TickPriority.render)
    )
  }

  private resize(): void {
    const r = this.renderer
    if (!r) return
    const w = window.innerWidth
    const h = window.innerHeight
    const res = this.resolutionFor(this.quality)
    if (w === this.w && h === this.h && res === this.res) return
    this.w = w
    this.h = h
    this.res = res
    r.resize(w, h, res)
    this.pixels?.layout(w, h)
  }

  setArt(url: string | null): void {
    void this.ready.then(() => this.art.setArt(artUrl(url)))
  }

  setDim(dim: number, blur: number): void {
    this.art.setDim(dim, blur)
  }

  setQuality(q: 'low' | 'high'): void {
    this.quality = q
    this.art.quality = q
    this.resize()
  }

  private tick = (dt: number, now: number): void => {
    const r = this.renderer
    if (!r || !this.pixels || !this.gradient || !this.flash) return
    if (window.innerWidth !== this.w || window.innerHeight !== this.h) this.resize()
    const { w, h } = this
    const reduce = motionPrefs.reduce
    const m = this.mouse
    const tx = motionPrefs.parallax ? m.tx : 0
    const ty = motionPrefs.parallax ? m.ty : 0
    m.x = damp(m.x, tx, 160, dt)
    m.y = damp(m.y, ty, 160, dt)

    const pulse = reduce ? 0 : beat.pulse
    const kiai = reduce ? 0 : beat.kiai
    const level = levels.level
    const accent = accentNow.number

    this.art.update(dt, now, w, h, m.x, m.y)
    const showGradient = this.art.coverage < 0.999
    this.gradient.root.visible = showGradient
    if (showGradient) this.gradient.update(now, w, h, accent, level, pulse, m.x, m.y, reduce)
    this.pixels.update(dt, now, pulse, kiai, level, accent, m.x, m.y, reduce)

    this.flashAlpha *= Math.exp(-dt / 210)
    const f = this.flash
    f.visible = this.flashAlpha > 0.004
    if (f.visible) {
      f.alpha = this.flashAlpha
      f.tint = mixNumber(0xffffff, accent, 0.45)
      f.position.set(w / 2, h * 0.4)
      f.scale.set((Math.max(w, h) * 1.7) / f.texture.width)
    }
    r.render(this.stage)
    if (!this.shown) {
      // first real frame: fade the canvas in instead of popping
      this.shown = true
      r.canvas.classList.add('g-bg__gl--ready')
    }
  }

  destroy(): void {
    this.destroyed = true
    this.detach()
    this.art.destroy()
    this.stage.destroy({ children: true })
    this.renderer?.destroy()
    this.renderer = null
  }
}

let engine: BackgroundEngine | null = null

/** The app-wide background engine (created on first use). */
export function getBackgroundEngine(): BackgroundEngine {
  if (!engine) engine = new BackgroundEngine()
  return engine
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    engine?.destroy()
    engine = null
  })
}
