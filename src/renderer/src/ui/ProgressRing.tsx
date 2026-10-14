import type { CSSProperties, ReactNode } from 'react'
import { cx, hueStyle, type Hue } from './util'

export interface ProgressRingProps {
  /** 0..1, or null for an indeterminate spinner. */
  value: number | null
  /** Diameter px. Default 24. */
  size?: number
  /** Stroke width px. Default 2.5. */
  thickness?: number
  /** Content in the middle (an icon, a count). */
  children?: ReactNode
  hue?: Hue
  className?: string
  style?: CSSProperties
}

/** Circular progress (downloads, buffering). Animates between values. */
export function ProgressRing({ value, size = 24, thickness = 2.5, children, hue, className, style }: ProgressRingProps) {
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  const v = value === null ? 0.28 : Math.max(0, Math.min(1, value))
  return (
    <span
      className={cx('g-progress-ring', value === null && 'g-progress-ring--indeterminate g-keep-motion', className)}
      style={{ width: size, height: size, ...hueStyle(hue), ...style }}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={value ?? undefined}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={value === null ? 'g-keep-motion' : undefined}>
        <circle className="g-progress-ring__track" cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={thickness} />
        <circle
          className="g-progress-ring__bar"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={thickness}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
        />
      </svg>
      {children !== undefined && <span className="g-progress-ring__center">{children}</span>}
    </span>
  )
}
