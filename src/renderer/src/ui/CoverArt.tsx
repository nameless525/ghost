// Album / game artwork that fades in when loaded, cross-fades on change, and falls back to
// an accent gradient with the ghost mark when there's no art (or it fails to load).
//
//   <CoverArt src={track.cover} size={56} />
//   <CoverArt src={album.cover} size="100%" radius={14} hue={game.accent} />
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { artUrl } from '../lib/art'
import { GhostMark } from './GhostMark'
import { cx, hueStyle, type Hue } from './util'

export interface CoverArtProps {
  /** Raw art URL (routed through artUrl() for you). */
  src: string | null | undefined
  /** px or any CSS length; square unless `height` is given. Default 48. */
  size?: number | string
  height?: number | string
  /** Corner radius in px. Default 10 (6 for tiny covers). */
  radius?: number
  /** Tint for the fallback gradient (defaults to the theme accent). */
  hue?: Hue | null
  alt?: string
  /** Hairline inner ring. Default true. */
  ring?: boolean
  className?: string
  style?: CSSProperties
}

interface Layer {
  url: string
  loaded: boolean
  instant: boolean
}

export function CoverArt({ src, size = 48, height, radius, hue, alt = '', ring = true, className, style }: CoverArtProps) {
  const url = artUrl(src)
  const [layers, setLayers] = useState<Layer[]>(() => (url ? [{ url, loaded: false, instant: false }] : []))
  const [failed, setFailed] = useState<string | null>(null)
  const imgs = useRef(new Map<string, HTMLImageElement>())

  useLayoutEffect(() => {
    if (!url) {
      setLayers([])
      return
    }
    setLayers((ls) => {
      if (ls[ls.length - 1]?.url === url) return ls
      // keep the last loaded layer underneath until the new one fades in
      const keep = ls.filter((l) => l.loaded).slice(-1)
      return [...keep, { url, loaded: false, instant: false }]
    })
  }, [url])

  const onLoad = (u: string) => {
    setLayers((ls) => {
      const idx = ls.findIndex((l) => l.url === u)
      if (idx < 0) return ls
      const next = ls.map((l, i) => (i === idx ? { ...l, loaded: true } : l))
      return next
    })
    // drop older layers once the new one has faded in
    window.setTimeout(() => setLayers((ls) => (ls[ls.length - 1]?.url === u ? ls.filter((l) => l.url === u) : ls)), 520)
  }

  const w = typeof size === 'number' ? `${size}px` : size
  const h = height === undefined ? w : typeof height === 'number' ? `${height}px` : height
  const r = radius ?? (typeof size === 'number' && size < 40 ? 6 : 10)
  const showFallback = !url || failed === url || !layers.some((l) => l.loaded)

  return (
    <div className={cx('g-cover', ring && 'g-cover--ring', className)} style={{ width: w, height: h, borderRadius: r, ...hueStyle(hue ?? undefined), ...style }}>
      <div className={cx('g-cover__fallback', !showFallback && 'g-cover__fallback--hidden')}>
        <GhostMark headphones={false} />
      </div>
      {layers.map((l) =>
        failed === l.url ? null : (
          <img
            key={l.url}
            ref={(el) => {
              if (!el) {
                imgs.current.delete(l.url)
                return
              }
              imgs.current.set(l.url, el)
              // already decoded (cache hit): show without a fade
              if (!l.loaded && el.complete && el.naturalWidth > 0) {
                l.instant = true
                el.classList.add('g-cover__img--instant')
                onLoad(l.url)
              }
            }}
            className={cx('g-cover__img', l.loaded && 'g-cover__img--loaded', l.instant && 'g-cover__img--instant')}
            src={l.url}
            alt={alt}
            decoding="async"
            draggable={false}
            onLoad={() => onLoad(l.url)}
            onError={() => setFailed(l.url)}
          />
        )
      )}
    </div>
  )
}
