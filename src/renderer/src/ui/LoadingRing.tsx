import type { CSSProperties, ReactNode } from 'react'
import { cx, hueStyle, type Hue } from './util'

export interface LoadingRingProps {
  /** Diameter in px. Default 32. */
  size?: number
  /** osu!-style dark rounded box behind the ring. */
  box?: boolean
  /** Optional caption under the ring. */
  label?: ReactNode
  /** Centre absolutely inside the nearest positioned parent (fades in after a beat). */
  center?: boolean
  hue?: Hue
  className?: string
}

/** Spinning arc whose length breathes as it turns (accelerate/decelerate, osu! style). */
export function LoadingRing({ size = 32, box, label, center, hue, className }: LoadingRingProps) {
  const ring = (
    <span
      className={cx('g-loading', 'g-keep-motion', box && 'g-loading--box', className)}
      style={{ '--lr': `${size}px`, ...hueStyle(hue) } as CSSProperties}
      role="progressbar"
      aria-label="Loading"
    >
      <svg className="g-loading__svg g-keep-motion" viewBox="0 0 40 40" fill="none">
        <circle cx="20" cy="20" r="16" stroke="currentColor" strokeOpacity="0.16" strokeWidth="4" />
        <circle
          className="g-loading__arc g-keep-motion"
          cx="20"
          cy="20"
          r="16"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="30 100"
        />
      </svg>
    </span>
  )
  if (!center && !label) return ring
  return (
    <div className={center ? 'g-loading-center' : undefined} style={center ? undefined : { display: 'inline-grid', justifyItems: 'center' }}>
      {ring}
      {label && <div className="g-loading__label">{label}</div>}
    </div>
  )
}
