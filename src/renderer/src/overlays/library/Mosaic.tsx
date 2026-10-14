// Playlist cover: a 2×2 mosaic of game art (a single cover when there's only one, the ghost
// fallback when there's none).
import { Sparkles } from 'lucide-react'
import { forwardRef, type CSSProperties } from 'react'
import { CoverArt } from '../../ui/CoverArt'
import { cx } from '../../ui/util'

export interface MosaicProps {
  covers: string[]
  /** px or CSS length. */
  size: number | string
  /** Rendered width in CSS px when `size` isn't numeric (art is requested at this size). */
  w?: number
  radius?: number
  smart?: boolean
  className?: string
  style?: CSSProperties
}

/** Fill four tiles from up to four covers without leaving holes: [a,b,b,a] / [a,b,c,a]. */
function tiles(covers: string[]): string[] {
  const c = covers.filter(Boolean)
  if (c.length >= 4) return c.slice(0, 4)
  if (c.length === 3) return [c[0], c[1], c[2], c[0]]
  if (c.length === 2) return [c[0], c[1], c[1], c[0]]
  return c
}

export const Mosaic = forwardRef<HTMLDivElement, MosaicProps>(function Mosaic({ covers, size, w, radius = 12, smart, className, style }, ref) {
  const px = w ?? (typeof size === 'number' ? size : 220)
  const t = tiles(covers)
  const s = typeof size === 'number' ? `${size}px` : size
  return (
    <div ref={ref} className={cx('lx-mosaic', smart && 'lx-mosaic--smart', className)} style={{ width: s, height: s, borderRadius: radius, ...style }}>
      {t.length >= 4 ? (
        <div className="lx-mosaic__grid">
          {t.map((c, i) => (
            <CoverArt key={i} src={c} size="100%" w={px / 2} radius={0} ring={false} />
          ))}
        </div>
      ) : t.length || !smart ? (
        <CoverArt src={t[0] ?? null} size="100%" w={px} radius={0} ring={false} />
      ) : null}
      {smart && !t.length && (
        <div className="lx-mosaic__smart">
          <Sparkles />
        </div>
      )}
      <div className="lx-mosaic__ring" style={{ borderRadius: radius }} />
    </div>
  )
})
