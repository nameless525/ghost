import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import type { Progress } from '@shared/types'
import { ProgressAnimator, progressMode, progressPercent, progressValue, type ProgressInput } from './progress'
import { cx, hueStyle, type Hue } from './util'

export interface ProgressBarProps {
  /** A Progress (measured, estimated or unknown), a plain 0..1 value, or null for an indeterminate sweep. */
  progress: ProgressInput
  /**
   * Identity of the wait (e.g. the loading track's id): a new key starts the bar from 0. Within one
   * key it never moves back, so successive steps of one wait should use `span` and keep the key.
   */
  waitKey?: string | number | null
  /** The wait is over: the bar fills, then (with `fadeWhenDone`) fades out. */
  done?: boolean
  fadeWhenDone?: boolean
  /** 'thin' 2 px (inline under rows / chips), 'regular' 4 px. */
  size?: 'thin' | 'regular'
  /** Show the label, detail and (when measured) the percentage above the bar. */
  caption?: boolean
  hue?: Hue
  className?: string
  style?: CSSProperties
  'aria-label'?: string
}

/** An estimated step running this many times its typical length gets the sweep too: it's slow, not stuck. */
const OVERDUE_FACTOR = 2

/** Linear progress for any wait (see ui/progress.ts for how it moves). */
export function ProgressBar({ progress, waitKey, done, fadeWhenDone, size = 'regular', caption, hue, className, style, 'aria-label': ariaLabel }: ProgressBarProps) {
  const fill = useRef<HTMLSpanElement>(null)
  const anim = useRef<ProgressAnimator | null>(null)
  const lastKey = useRef<unknown>(undefined)
  const mode = done ? 'measured' : progressMode(progress)
  const p = typeof progress === 'object' ? (progress as Progress | null) : null
  const key = waitKey ?? null
  // Re-plan only when the step changes, not on every parent render.
  const sig = typeof progress === 'number' ? progress : p ? `${p.fraction}|${p.expectMs}|${p.since}|${p.span?.[0]}|${p.span?.[1]}` : null

  useLayoutEffect(() => {
    const el = fill.current
    if (!el) return
    const a = (anim.current ??= new ProgressAnimator({ el, kind: 'scaleX' }))
    if (lastKey.current !== key) {
      const first = lastKey.current === undefined
      lastKey.current = key
      // Mounting mid-wait (a screen opened while a track loads): start where the wait already is.
      a.jump(first ? (progressValue(progress) ?? 0) : 0)
    }
    if (done) a.finish()
    else a.set(progress)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sig` stands for `progress`
  }, [sig, key, done])

  useLayoutEffect(
    () => () => {
      anim.current?.dispose()
      anim.current = null
    },
    []
  )

  // An estimate past its due time holds near its ceiling; the sweep shows it's still going.
  const [overdue, setOverdue] = useState(false)
  const dueAt = !done && mode === 'estimated' && p?.expectMs ? p.since + OVERDUE_FACTOR * p.expectMs : null
  useEffect(() => {
    if (dueAt == null) return setOverdue(false)
    const left = dueAt - Date.now()
    if (left <= 0) return setOverdue(true)
    setOverdue(false)
    const t = window.setTimeout(() => setOverdue(true), left)
    return () => window.clearTimeout(t)
  }, [dueAt])

  const pct = done ? 100 : progressPercent(progress)
  return (
    <div
      className={cx('g-progress', `g-progress--${size}`, mode === 'indeterminate' && 'g-progress--indeterminate', done && fadeWhenDone && 'g-progress--done', className)}
      style={{ ...hueStyle(hue), ...style }}
      role="progressbar"
      aria-label={ariaLabel ?? p?.label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-valuetext={p ? [p.label, p.detail].filter(Boolean).join(', ') : undefined}
    >
      {caption && p && (
        <div className="g-progress__caption">
          <span className="g-progress__label">{p.label}</span>
          {p.detail && <span className="g-progress__detail">{p.detail}</span>}
          {pct != null && <span className="g-progress__pct">{pct}%</span>}
        </div>
      )}
      <div className="g-progress__track">
        <span ref={fill} className="g-progress__fill g-keep-motion" />
        {(mode === 'indeterminate' || (overdue && dueAt != null)) && <span className="g-progress__sweep g-keep-motion" />}
      </div>
    </div>
  )
}
