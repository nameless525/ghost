import { Star } from 'lucide-react'
import type { CSSProperties } from 'react'
import { intensityColor } from '@shared/defaults'
import type { AudioFormat, SourceSummary } from '@shared/types'
import { cx } from './util'

export interface IntensityBadgeProps {
  /** 0..10 stars, or null when unknown. */
  value: number | null | undefined
  size?: 'sm' | 'md' | 'lg'
  /** Soft glow in the badge colour (for the selected row). */
  glow?: boolean
  className?: string
  style?: CSSProperties
}

/**
 * osu!-style difficulty pill: ★ value on the intensity spectrum colour (blue → green →
 * yellow → red → purple → black). High values switch to gold text like osu!.
 */
export function IntensityBadge({ value, size = 'md', glow, className, style }: IntensityBadgeProps) {
  if (value == null || Number.isNaN(value)) {
    return (
      <span className={cx('g-intensity', 'g-intensity--empty', size !== 'md' && `g-intensity--${size}`, className)} style={style} title="Intensity not analysed yet">
        <Star />–
      </span>
    )
  }
  const color = intensityColor(value)
  return (
    <span
      className={cx('g-intensity', value >= 6.5 && 'g-intensity--bright', size !== 'md' && `g-intensity--${size}`, glow && 'g-intensity--glow', className)}
      style={{ '--ic': color, ...style } as CSSProperties}
      aria-label={`Intensity ${value.toFixed(2)} stars`}
    >
      <Star />
      {value.toFixed(2)}
    </span>
  )
}

export type SourceLike = Pick<SourceSummary, 'provider' | 'format' | 'lossless' | 'bitrateKbps'> | null | undefined

/** 'FLAC' / '320' / 'CHIP' / 'YT' / … and its tone. */
export function sourceLabel(s: SourceLike | AudioFormat): { label: string; tone: 'flac' | 'hq' | 'lq' | 'chip' | 'yt' } | null {
  if (!s) return null
  if (typeof s === 'string') s = { provider: '', format: s, lossless: s === 'flac' || s === 'wav', bitrateKbps: null }
  if (s.provider === 'youtube' || s.provider === 'yt') return { label: 'YT', tone: 'yt' }
  if (s.format === 'chip') return { label: 'CHIP', tone: 'chip' }
  if (s.lossless || s.format === 'flac' || s.format === 'wav') return { label: s.format === 'wav' ? 'WAV' : 'FLAC', tone: 'flac' }
  if (s.bitrateKbps) return { label: String(Math.round(s.bitrateKbps)), tone: s.bitrateKbps >= 256 ? 'hq' : 'lq' }
  return { label: s.format === 'unknown' ? '?' : s.format.toUpperCase(), tone: 'lq' }
}

export interface SourceBadgeProps {
  /** A SourceSummary (preferred) or a bare format. */
  source: SourceLike | AudioFormat
  className?: string
  title?: string
}

/** Source quality tag: FLAC (gold), 320 (blue), CHIP (green), YT (red). */
export function SourceBadge({ source, className, title }: SourceBadgeProps) {
  const info = sourceLabel(source)
  if (!info) return null
  const provider = source && typeof source === 'object' && source.provider ? source.provider : null
  return (
    <span className={cx('g-source', `g-source--${info.tone}`, className)} title={title ?? (provider ? `${info.label} · ${provider}` : info.label)}>
      {info.label}
    </span>
  )
}
