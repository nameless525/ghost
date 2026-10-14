// The Play screen's GPU visualizer stage: one transparent PixiJS canvas (separate from the
// shared background canvas) hosting three visualizer modes, kiai FX (screen-edge flashes on
// downbeats, pixel bursts on kiai entry) and animated mode switching.
//
// Driven by the global ticker at TickPriority.render; reads frame() / beat / levels once per
// tick into one shared VisFrame. The renderer is a lazily created singleton that survives
// Play screen remounts (no WebGL context churn); it only ticks while attached to a host.
import { autoDetectRenderer, Container, Sprite, type Renderer } from 'pixi.js'
import { beat, type BeatEvent } from '../../motion/beat'
import { easings } from '../../motion/easing'
import { frame, levels, retainLevels } from '../../motion/frame'
import { motionPrefs } from '../../motion/prefs'
import { ticker, TickPriority } from '../../motion/ticker'
import { usePlayer } from '../../state/player'
import { accentNow } from '../../theme/accent'
import { mixNumber } from '../../theme/color'
import { uiZoom } from '../../ui/util'
import { Burst } from './burst'
import { RadialVisualizer } from './radial'
import { ScopeVisualizer } from './scope'
import { SkylineVisualizer } from './skyline'
import { destroyTextures, makeTextures, type VisTextures } from './textures'
import { computeLayout, HUD_HEIGHT, VISUALIZER_MODES, type VisFrame, type VisLayer, type VisLayout, type VisualizerMode } from './types'
import { vivid } from './util'

/** Max canvas resolution (device px per CSS px). */
const VIS_MAX_RES = { v: 1.5 }
// Dev handle for A/B-ing the resolution: window.__ghostGfx.visRes = 2
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const g = ((window as unknown as { __ghostGfx?: Record<string, unknown> }).__ghostGfx ??= {})
  Object.defineProperty(g, 'visRes', { configurable: true, get: () => VIS_MAX_RES.v, set: (v: number) => (VIS_MAX_RES.v = v) })
}

interface MixAnim {
  v: number
  from: number
  to: number
  start: number
  dur: number
  delay: number
  inbound: boolean
}

export class VisualizerStage {
  private renderer: Renderer | null = null
  private stage = new Container()
  private tex: VisTextures | null = null
  private layers: Record<VisualizerMode, VisLayer> | null = null
  private burst: Burst | null = null
  private edgeL: Sprite | null = null
  private edgeR: Sprite | null = null
  private flash = 0
  private flashLen = 400
  private mode: VisualizerMode = 'radial'
  private mix: Record<VisualizerMode, MixAnim> = {
    radial: { v: 1, from: 1, to: 1, start: 0, dur: 1, delay: 0, inbound: true },
    skyline: { v: 0, from: 0, to: 0, start: 0, dur: 1, delay: 0, inbound: false },
    scope: { v: 0, from: 0, to: 0, start: 0, dur: 1, delay: 0, inbound: false }
  }
  private presence = 0
  private presenceTarget = 0
  private host: HTMLElement | null = null
  private offs: (() => void)[] = []
  private ro: ResizeObserver | null = null
  private size = { w: 0, h: 0 }
  private bottomInset = HUD_HEIGHT
  private layoutDirty = true
  private L: VisLayout = computeLayout(1, 1)
  private destroyed = false
  private shown = false
  private lastAccentKey = -1
  private F: VisFrame = {
    dt: 16,
    now: 0,
    frame: null,
    playing: false,
    pulse: 0,
    kiai: 0,
    phase: 0,
    level: 0,
    bass: 0,
    high: 0,
    reduce: false,
    accent: 0xff66aa,
    accentHi: 0xff8cc0,
    accentLo: 0xb23a78,
    white: 0xffffff,
    drive: 1
  }
  readonly ready: Promise<void>

  constructor() {
    this.ready = this.init()
  }

  /**
   * Canvas resolution. Additive glows, soft bars and particles look the same at 1.5× as at 2×,
   * at ~56% of the fill (the stage covers the whole window).
   */
  private resolution(): number {
    return Math.min(VIS_MAX_RES.v, (window.devicePixelRatio || 1) * uiZoom())
  }

  private async init(): Promise<void> {
    const r = await autoDetectRenderer({
      preference: 'webgl',
      width: Math.max(1, window.innerWidth),
      height: Math.max(1, window.innerHeight),
      resolution: this.resolution(),
      autoDensity: true,
      antialias: false,
      backgroundAlpha: 0,
      hello: false,
      powerPreference: 'high-performance'
    })
    if (this.destroyed) {
      r.destroy()
      return
    }
    this.renderer = r
    r.canvas.classList.add('pl-vis__gl')
    const tex = (this.tex = makeTextures())
    this.layers = { radial: new RadialVisualizer(tex), skyline: new SkylineVisualizer(tex), scope: new ScopeVisualizer(tex) }
    this.burst = new Burst(tex)
    this.edgeL = new Sprite(tex.edge)
    this.edgeR = new Sprite(tex.edge)
    for (const s of [this.edgeL, this.edgeR]) {
      s.blendMode = 'add'
      s.visible = false
    }
    this.stage.addChild(this.edgeL, this.edgeR, this.layers.skyline.root, this.layers.scope.root, this.layers.radial.root, this.burst.root)
    if (this.host) this.mount()
  }

  /** Mount the canvas into `host` (fills it) and start ticking. */
  attach(host: HTMLElement): void {
    this.host = host
    if (this.renderer) this.mount()
  }

  detach(host?: HTMLElement): void {
    if (host && host !== this.host) return
    this.host = null
    this.renderer?.canvas.remove()
    this.ro?.disconnect()
    this.ro = null
    this.offs.forEach((f) => f())
    this.offs = []
    this.burst?.clear()
    this.flash = 0
    this.presence = 0
    this.shown = false
    this.renderer?.canvas.classList.remove('pl-vis__gl--ready')
  }

  private mount(): void {
    const r = this.renderer
    const host = this.host
    if (!r || !host) return
    if (r.canvas.parentElement !== host) host.appendChild(r.canvas)
    if (this.offs.length) return
    this.ro = new ResizeObserver(() => {
      this.size.w = host.clientWidth
      this.size.h = host.clientHeight
    })
    this.ro.observe(host)
    this.size.w = host.clientWidth
    this.size.h = host.clientHeight
    this.offs.push(
      retainLevels(),
      beat.onBeat((e) => this.onBeat(e)),
      beat.onKiai((on) => this.onKiai(on)),
      ticker.add(this.tick, TickPriority.render)
    )
  }

  /** Switch mode with a choreographed cross-transition (instant when `animate` is false). */
  setMode(mode: VisualizerMode, animate = true): void {
    if (mode === this.mode && this.mix[mode].to === 1) return
    this.mode = mode
    const now = performance.now()
    const reduce = motionPrefs.reduce
    for (const m of VISUALIZER_MODES) {
      const a = this.mix[m]
      const target = m === mode ? 1 : 0
      a.from = a.v
      a.to = target
      a.start = now
      a.inbound = target === 1
      a.dur = !animate || reduce ? 0 : target ? 900 : 380
      a.delay = !animate || reduce ? 0 : target ? 160 : 0
      if (!animate) a.v = target
    }
  }

  getMode(): VisualizerMode {
    return this.mode
  }

  /** 0 hides every layer (e.g. behind the title card), 1 shows the active mode. */
  setPresence(v: number, instant = false): void {
    this.presenceTarget = v
    if (instant) this.presence = v
  }

  /** Height of the HUD over the bottom of the stage (skyline stands on it). */
  setBottomInset(px: number): void {
    if (Math.abs(px - this.bottomInset) < 1) return
    this.bottomInset = px
    this.layoutDirty = true
  }

  /** Current layout (css px of the host), shared with the DOM. */
  get layout(): VisLayout {
    return this.L
  }

  private onBeat(e: BeatEvent): void {
    const f = this.F
    if (motionPrefs.reduce || !this.layers) return
    const k = beat.inKiai
    const s = k ? (e.downbeat ? 0.85 : 0.3) : e.downbeat ? 0.1 : 0
    if (s > this.flash) {
      this.flash = s
      this.flashLen = Math.max(180, e.beatLength * (e.downbeat ? 0.9 : 0.55))
    }
    for (const m of VISUALIZER_MODES) if (this.mix[m].v > 0.05) this.layers[m].onBeat?.(e, f)
    if (k && e.downbeat && this.burst && this.presence > 0.5) {
      const layer = this.layers[this.mode]
      this.burst.emit((i, n, out) => layer.emitter(i, n, out), { count: 10, speed: [120, 340], size: [4, 10], life: [500, 1000], alpha: 0.6 })
    }
  }

  private onKiai(on: boolean): void {
    if (!on || motionPrefs.reduce || !this.layers || !this.burst || this.presence < 0.3) return
    this.flash = 1
    this.flashLen = 900
    this.kiaiBurst()
  }

  /** The kiai-entry particle burst (also used by the dev gallery / tests). */
  kiaiBurst(): void {
    if (!this.layers || !this.burst) return
    const layer = this.layers[this.mode]
    this.burst.emit((i, n, out) => layer.emitter(i, n, out), { count: 140, speed: [240, 780], size: [5, 17], life: [900, 1800], alpha: 0.95 })
  }

  private updateColors(): void {
    const F = this.F
    const base = accentNow.number
    const key = base * 1000 + Math.round(F.kiai * 100)
    if (key === this.lastAccentKey) return
    this.lastAccentKey = key
    const k = F.kiai
    F.accent = vivid(base, 1 + 0.5 * k, 0.015 * k)
    F.accentHi = vivid(base, 0.82 + 0.35 * k, 0.1)
    F.accentLo = vivid(base, 1.05 + 0.3 * k, -0.2)
    F.white = mixNumber(0xffffff, F.accent, 0.1 + 0.08 * k)
  }

  private tick = (dt: number, now: number): void => {
    const r = this.renderer
    const layers = this.layers
    if (!r || !layers || !this.burst || !this.host) return
    const { w, h } = this.size
    if (w < 2 || h < 2) return
    const res = this.resolution()
    if (this.layoutDirty || w !== this.L.w || h !== this.L.h || res !== r.resolution) {
      this.layoutDirty = false
      if (w !== r.width || h !== r.height || res !== r.resolution) r.resize(w, h, res)
      this.L = computeLayout(w, h, this.bottomInset)
      for (const m of VISUALIZER_MODES) layers[m].layout(this.L)
      this.burst.layout(w, h)
    }

    // shared frame context
    const F = this.F
    const ps = usePlayer.getState()
    const reduce = motionPrefs.reduce
    F.dt = dt
    F.now = now
    F.frame = frame()
    F.playing = ps.status === 'playing'
    F.reduce = reduce
    F.pulse = reduce ? 0 : beat.pulse
    F.kiai = reduce ? 0 : beat.kiai
    F.phase = beat.phase
    F.level = levels.level
    F.bass = levels.bass
    F.high = levels.high
    F.drive = 1 + 0.28 * F.kiai
    this.updateColors()

    // presence + mode mixes
    this.presence += (this.presenceTarget - this.presence) * (1 - Math.exp(-dt / (this.presenceTarget > this.presence ? 260 : 160)))
    for (const m of VISUALIZER_MODES) {
      const a = this.mix[m]
      if (a.v !== a.to) {
        const p = a.dur <= 0 ? 1 : Math.min(1, Math.max(0, (now - a.start - a.delay) / a.dur))
        const e = a.inbound ? easings.outQuart(p) : easings.outQuad(p)
        a.v = p >= 1 ? a.to : a.from + (a.to - a.from) * e
      }
      layers[m].update(F, a.v * this.presence)
    }
    this.burst.update(F)

    // screen-edge flashes (kiai downbeats)
    this.flash *= Math.exp(-dt / (this.flashLen * 0.42))
    const fa = this.flash * this.presence
    const eL = this.edgeL!
    const eR = this.edgeR!
    const vis = fa > 0.004
    eL.visible = eR.visible = vis
    if (vis) {
      const ew = Math.max(160, w * 0.2)
      eL.position.set(0, 0)
      eL.scale.set(ew / eL.texture.width, h / eL.texture.height)
      eR.position.set(w, 0)
      eR.scale.set(-ew / eR.texture.width, h / eR.texture.height)
      eL.tint = eR.tint = F.accent
      eL.alpha = eR.alpha = Math.min(0.9, fa * 0.75)
    }

    r.render(this.stage)
    if (!this.shown) {
      this.shown = true
      r.canvas.classList.add('pl-vis__gl--ready')
    }
  }

  destroy(): void {
    this.destroyed = true
    this.detach()
    if (this.layers) for (const m of VISUALIZER_MODES) this.layers[m].destroy()
    this.burst?.destroy()
    this.stage.destroy({ children: true })
    if (this.tex) destroyTextures(this.tex)
    this.renderer?.destroy()
    this.renderer = null
  }
}

let instance: VisualizerStage | null = null

/** The app-wide visualizer stage (created on first use). */
export function getVisualizerStage(): VisualizerStage {
  if (!instance) instance = new VisualizerStage()
  return instance
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    instance?.destroy()
    instance = null
  })
}
