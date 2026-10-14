// Full-width seek bar drawn as the track's energy curve, like osu!'s song-progress graph.
//
// The kit Slider does the interaction (drag, wheel, keys, hover tooltip) and polls
// livePositionMs() every frame, writing --v / --h on its root. The graph is three CSS-masked
// layers (shape, kiai columns, beat ticks) rendered ONCE per size/track into canvases, so
// colours come from theme tokens (they glide with the accent for free) and the played/unplayed
// split is two counter-translated clip wrappers driven by var(--v): compositor-only per frame.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { TrackAnalysis } from '@shared/types'
import { ghost } from '../../ghost'
import { sfx } from '../../sound'
import { livePositionMs, usePlayer } from '../../state/player'
import { Slider, formatTime } from '../../ui'
import { cx } from '../../ui/util'
import { LiveTime } from '../../overlays/now-playing/controls'
import { useCurrentAnalysis } from '../../overlays/now-playing/store'

export const GRAPH_H = 42
const TICKS_H = 7
const COL = 3
const GAP = 1

interface Masks {
  shape: string
  kiai: string | null
  ticks: string | null
}

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return [c, c.getContext('2d')!]
}

/** Energy value for a time window (max of the covered points, lightly smoothed). */
function sample(energy: number[], t0: number, t1: number): number {
  const n = energy.length
  const a = Math.max(0, Math.floor(t0 * n))
  const b = Math.min(n, Math.max(a + 1, Math.ceil(t1 * n)))
  let v = 0
  for (let i = a; i < b; i++) v = Math.max(v, energy[i])
  return v
}

/**
 * Encode a mask canvas off the main thread (toBlob) and hand back an object URL. toDataURL
 * PNG-encoded ~6 ms of masks synchronously on every track change / Play mount.
 */
function toUrl(c: HTMLCanvasElement): Promise<string | null> {
  return new Promise((resolve) => c.toBlob((b) => resolve(b ? URL.createObjectURL(b) : null), 'image/png'))
}

async function buildMasks(a: TrackAnalysis, durationMs: number, width: number, dpr: number): Promise<Masks> {
  const W = Math.max(1, Math.round(width * dpr))
  const H = Math.round(GRAPH_H * dpr)
  const step = (COL + GAP) * dpr
  const col = COL * dpr
  const cols = Math.floor(W / step)
  const durS = durationMs / 1000
  const kiai = a.kiai ?? []
  const inKiai = (t: number) => kiai.some(([s, e]) => t >= s && t < e)

  // normalise so the loudest passage reaches the top
  let peak = 0.05
  for (const v of a.energy) peak = Math.max(peak, v)

  const [sc, sg] = canvas(W, H)
  const [kc, kg] = canvas(W, H)
  sg.fillStyle = kg.fillStyle = '#fff'
  let anyKiai = false
  const r = Math.min(col / 2, 1.5 * dpr)
  for (let i = 0; i < cols; i++) {
    const t0 = (i * step) / W
    const t1 = ((i + 1) * step) / W
    const v = Math.pow(sample(a.energy, t0, t1) / peak, 1.2)
    const bh = Math.max(2 * dpr, v * (H - 2 * dpr))
    const x = i * step + (step - col) / 2
    sg.beginPath()
    sg.roundRect(x, H - bh, col, bh, [r, r, 0, 0])
    sg.fill()
    if (kiai.length && inKiai(((t0 + t1) / 2) * durS)) {
      anyKiai = true
      kg.beginPath()
      kg.roundRect(x, H - bh, col, bh, [r, r, 0, 0])
      kg.fill()
    }
  }

  // beat ticks (a strip under the baseline): every beat if they're far enough apart, else
  // downbeats, else every 4th downbeat
  let ticks: Promise<string | null> = Promise.resolve(null)
  const beats = a.beats ?? []
  if (beats.length > 1 && durS > 0) {
    const pxPerS = width / durS
    const beatGap = ((beats[beats.length - 1] - beats[0]) / (beats.length - 1)) * pxPerS
    const downs = new Set((a.downbeats ?? []).map((d) => Math.round(d * 100)))
    const TH = Math.round(TICKS_H * dpr)
    const [tc, tg] = canvas(W, TH)
    tg.fillStyle = '#fff'
    const every = beatGap >= 6 ? 1 : beatGap * 4 >= 6 ? 4 : 16
    beats.forEach((b, i) => {
      if (every > 1 && i % every !== 0) return
      const major = every > 1 || downs.has(Math.round(b * 100))
      const x = Math.round((b / durS) * W)
      tg.globalAlpha = major ? 1 : 0.5
      tg.fillRect(x, 0, Math.max(1, Math.round(dpr)), major ? TH : Math.round(TH * 0.55))
    })
    ticks = toUrl(tc)
  }

  const [shape, kiaiUrl, ticksUrl] = await Promise.all([toUrl(sc), anyKiai ? toUrl(kc) : null, ticks])
  return { shape: shape ?? '', kiai: kiaiUrl, ticks: ticksUrl }
}

const revokeMasks = (m: Masks | null) => {
  if (!m) return
  for (const u of [m.shape, m.kiai, m.ticks]) if (u && u.startsWith('blob:')) URL.revokeObjectURL(u)
}

export function EnergySeekBar({ active, className }: { active: boolean; className?: string }) {
  const analysis = useCurrentAnalysis()
  const duration = usePlayer((s) => s.durationMs)
  const wrap = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [masks, setMasks] = useState<Masks | null>(null)

  useLayoutEffect(() => {
    const el = wrap.current
    if (!el) return
    let t = 0
    const measure = () => {
      window.clearTimeout(t)
      // debounce live window resizes; the old masks stretch in the meantime
      t = window.setTimeout(() => setWidth(Math.round(el.clientWidth)), 90)
    }
    setWidth(Math.round(el.clientWidth))
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => {
      ro.disconnect()
      window.clearTimeout(t)
    }
  }, [])

  const hasEnergy = !!analysis && analysis.energy.length > 1 && !!duration
  useEffect(() => {
    if (!hasEnergy || width < 10) {
      setMasks(null)
      return
    }
    let alive = true
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    void buildMasks(analysis!, duration!, width, dpr).then((m) => {
      if (alive) setMasks(m)
      else revokeMasks(m)
    })
    return () => {
      alive = false
    }
  }, [analysis, duration, width, hasEnergy])
  // the previous masks' blob URLs are released once replaced (and on unmount)
  useEffect(() => () => revokeMasks(masks), [masks])

  const kiaiSegs = useMemo(() => {
    if (!analysis || !duration) return []
    const d = duration / 1000
    return (analysis.kiai ?? []).map(([s, e]) => ({ left: (s / d) * 100, width: ((e - s) / d) * 100 }))
  }, [analysis, duration])

  const inKiai = (ms: number) => !!analysis?.kiai?.some(([s, e]) => ms / 1000 >= s && ms / 1000 < e)

  // The (large) data-URL masks go straight onto the masked layers, not through inherited custom
  // properties: the slider rewrites --v on an ancestor several times a second, and every
  // inherited-variable change restyles the subtree, re-resolving any var() mask on the way.
  const maskStyles = useMemo(() => {
    if (!masks) return null
    const m = (u: string | null): CSSProperties => (u ? { maskImage: `url(${u})`, WebkitMaskImage: `url(${u})` } : {})
    return { shape: m(masks.shape), kiai: m(masks.kiai), ticks: m(masks.ticks) }
  }, [masks])

  const graph = (
    <div className={cx('pl-graph', masks ? 'pl-graph--ready' : 'pl-graph--pending')}>
      <div className="pl-graph__zoom">
        {masks && maskStyles ? (
          <>
            <div className="pl-graph__layer pl-graph__base" style={maskStyles.shape} />
            {masks.kiai && <div className="pl-graph__layer pl-graph__kiai" style={maskStyles.kiai} />}
            <div className="pl-graph__clip">
              <div className="pl-graph__clip-inner">
                <div className="pl-graph__layer pl-graph__played" style={maskStyles.shape} />
                {masks.kiai && <div className="pl-graph__layer pl-graph__played-kiai" style={maskStyles.kiai} />}
              </div>
            </div>
          </>
        ) : (
          <div className="pl-graph__shimmer" aria-hidden />
        )}
      </div>
      {masks?.ticks && <div className="pl-graph__ticks" style={maskStyles?.ticks} />}
      <div className="pl-graph__hover" />
      <div className="pl-graph__head" />
    </div>
  )

  return (
    <div className={cx('pl-seek', className)}>
      <div className="pl-seek__times">
        <LiveTime kind="elapsed" active={active} className="pl-seek__elapsed" />
        {!hasEnergy && duration ? <span className="pl-seek__analysing g-caps">Analysing…</span> : null}
        <LiveTime kind="remaining" active={active} className="pl-seek__remaining" />
      </div>
      <div ref={wrap} className="pl-seek__bar">
        {kiaiSegs.map((k, i) => (
          <span key={i} className="pl-seek__kiai-seg" style={{ left: `${k.left}%`, width: `${k.width}%` }} />
        ))}
        <Slider
          className="pl-seek__slider"
          variant="seek"
          min={0}
          max={duration ?? 1}
          disabled={!duration}
          live={() => livePositionMs()}
          onCommit={(ms) => {
            sfx.play('tick', { volume: 0.6 })
            void ghost().player.seek(ms)
          }}
          format={(ms) => (inKiai(ms) ? `${formatTime(ms)} · kiai` : formatTime(ms))}
          wheelStep={0.015}
          background={graph}
          aria-label="Seek"
        />
      </div>
    </div>
  )
}
