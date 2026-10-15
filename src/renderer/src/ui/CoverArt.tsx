// Album / game artwork that fades in when loaded, cross-fades on change, and falls back to
// an accent gradient with the ghost mark when there's no art (or it fails to load).
//
//   <CoverArt src={track.cover} size={56} />
//   <CoverArt src={album.cover} size="100%" radius={14} hue={game.accent} w={256} />
//
// Art is requested at the rendered size (`w`, defaulting to a numeric `size`), so a 36 px list
// thumbnail decodes a 128 px image instead of a 1600 px scan.
import { memo, useCallback, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { artUrl } from '../lib/art'
import { GhostMark } from './GhostMark'
import { cx, hueStyle, type Hue } from './util'

export interface CoverArtProps {
  /** Raw art URL (routed through artUrl() for you). */
  src: string | null | undefined
  /** px or any CSS length; square unless `height` is given. Default 48. */
  size?: number | string
  height?: number | string
  /** Width (CSS px) to request the art at. Defaults to `size` when numeric, else 512. */
  w?: number
  /** Corner radius in px. Default 10 (6 for tiny covers). */
  radius?: number
  /** Tint for the fallback gradient (defaults to the theme accent). */
  hue?: Hue | null
  alt?: string
  /** Hairline inner ring. Default true. */
  ring?: boolean
  /** Lazy-load (long lists). Default false. */
  lazy?: boolean
  className?: string
  style?: CSSProperties
}

interface Layer {
  url: string
  loaded: boolean
  instant: boolean
}

export const CoverArt = memo(function CoverArt({ src, size = 48, height, w, radius, hue, alt = '', ring = true, lazy = false, className, style }: CoverArtProps) {
  const url = artUrl(src, { w: w ?? (typeof size === "number" ? size : 512) })
  const [layers, setLayers] = useState<Layer[]>(() => (url ? [{ url, loaded: false, instant: false }] : []))
  const [failed, setFailed] = useState<string | null>(null)
  const dropTimer = useRef(0)

  useLayoutEffect(() => {
    if (!url) {
      setLayers((ls) => (ls.length ? [] : ls))
      return
    }
    setLayers((ls) => {
      if (ls[ls.length - 1]?.url === url) return ls
      // Coming back to an image we still hold (A → B → A before B loaded): reuse its layer, so
      // there is never more than one layer (React key) per url.
      const existing = ls.find((l) => l.url === url)
      // keep the last loaded layer underneath until the new one fades in
      const keep = ls.filter((l) => l.loaded && l.url !== url).slice(-1)
      return [...keep, existing ?? { url, loaded: false, instant: false }]
    })
  }, [url])

  useLayoutEffect(() => () => window.clearTimeout(dropTimer.current), [])

  const onLoad = useCallback((u: string, instant = false) => {
    setLayers((ls) => {
      const idx = ls.findIndex((l) => l.url === u)
      if (idx < 0 || ls[idx].loaded) return ls
      return ls.map((l, i) => (i === idx ? { ...l, loaded: true, instant: instant || l.instant } : l))
    })
    // drop older layers once the new one has faded in
    window.clearTimeout(dropTimer.current)
    dropTimer.current = window.setTimeout(() => setLayers((ls) => (ls.length > 1 && ls[ls.length - 1]?.url === u ? ls.filter((l) => l.url === u) : ls)), 520)
  }, [])

  // A failed current image drops the older layer too: it sat above the fallback and kept showing
  // the previous art (e.g. the last track's cover) for as long as the new one was missing.
  const onError = useCallback((u: string) => {
    setFailed(u)
    setLayers((ls) => (ls[ls.length - 1]?.url === u ? [] : ls.filter((l) => l.url !== u)))
  }, [])

  const wCss = typeof size === 'number' ? `${size}px` : size
  const hCss = height === undefined ? wCss : typeof height === 'number' ? `${height}px` : height
  const r = radius ?? (typeof size === 'number' && size < 40 ? 6 : 10)
  const showFallback = !url || failed === url || !layers.some((l) => l.loaded)

  return (
    <div className={cx('g-cover', ring && 'g-cover--ring', className)} style={{ width: wCss, height: hCss, borderRadius: r, ...hueStyle(hue ?? undefined), ...style }}>
      <div className={cx('g-cover__fallback', !showFallback && 'g-cover__fallback--hidden')}>
        <GhostMark headphones={false} />
      </div>
      {layers.map((l) => (failed === l.url ? null : <CoverImg key={l.url} layer={l} alt={alt} lazy={lazy} onLoad={onLoad} onError={onError} />))}
    </div>
  )
})

function CoverImg({ layer: l, alt, lazy, onLoad, onError }: { layer: Layer; alt: string; lazy: boolean; onLoad: (u: string, instant?: boolean) => void; onError: (u: string) => void }) {
  // Stable ref callback: runs once per mount (not on every render).
  const ref = useCallback(
    (el: HTMLImageElement | null) => {
      // already decoded (cache hit): show without a fade
      if (el && el.complete && el.naturalWidth > 0) onLoad(l.url, true)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [l.url, onLoad]
  )
  return (
    <img
      ref={ref}
      className={cx('g-cover__img', l.loaded && 'g-cover__img--loaded', l.instant && 'g-cover__img--instant')}
      src={l.url}
      alt={alt}
      decoding="async"
      loading={lazy ? 'lazy' : undefined}
      draggable={false}
      onLoad={() => onLoad(l.url)}
      onError={() => onError(l.url)}
    />
  )
}
