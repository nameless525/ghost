// Slider for seek bars, volume and settings. Drag (pointer capture), wheel, and keyboard.
//
//   <Slider value={vol} onChange={setVol} variant="volume" format={(v) => `${Math.round(v * 100)}%`} />
//
//   // 120 fps seek bar without React re-renders: `live` is polled every frame.
//   <Slider variant="seek" min={0} max={durationMs} live={() => livePositionMs()}
//           onCommit={(ms) => ghost().player.seek(ms)} format={formatTime}
//           background={<EnergyGraph … />} />
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { useTicker } from '../motion/ticker'
import { sfx } from '../sound'
import { cx, hueStyle, useEvent, type Hue } from './util'

export interface SliderProps {
  /** Controlled value (ignored while dragging, and when `live` is given). */
  value?: number
  /** Polled every animation frame instead of `value` (no re-renders). */
  live?: () => number
  /** Poll `live` (default true). Pass false while the slider can't be seen (closed overlay). */
  liveActive?: boolean
  min?: number
  max?: number
  /** Snap step (and keyboard step). Default (max-min)/100. */
  step?: number
  /** Fraction of the range per wheel notch. Default 0.05. Set 0 to disable wheel. */
  wheelStep?: number
  /** Fires continuously while dragging / on wheel / keys. */
  onChange?: (v: number) => void
  /** Fires once when the user lets go (or per wheel/key change). Seek here. */
  onCommit?: (v: number) => void
  /** Tooltip text for the hovered (or dragged) value. */
  format?: (v: number) => string
  variant?: 'default' | 'seek' | 'volume'
  /** 0..1 buffered fraction (seek). */
  buffered?: number
  /** Extra layer drawn inside the track under the fill (e.g. an energy curve). */
  background?: ReactNode
  disabled?: boolean
  hue?: Hue
  /** Tick sound on step changes. Default true for 'volume'/'default'. */
  ticks?: boolean
  className?: string
  style?: CSSProperties
  'aria-label'?: string
}

export function Slider({
  value = 0,
  live,
  liveActive = true,
  min = 0,
  max = 1,
  step,
  wheelStep = 0.05,
  onChange,
  onCommit,
  format,
  variant = 'default',
  buffered,
  background,
  disabled,
  hue,
  ticks,
  className,
  style,
  'aria-label': ariaLabel
}: SliderProps) {
  const root = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const dragValue = useRef(value)
  const lastWritten = useRef(-1)
  const lastTick = useRef(0)
  const [isDragging, setIsDragging] = useState(false)
  const [hoverText, setHoverText] = useState('')
  const range = max - min || 1
  const st = step ?? range / 100
  const withTicks = ticks ?? variant !== 'seek'

  const writeV = (v: number) => {
    // quantised to ~1/4096 of the track (under a device pixel on any seek bar)
    const f = Math.round(Math.max(0, Math.min(1, (v - min) / range)) * 4096) / 4096
    if (f === lastWritten.current) return
    lastWritten.current = f
    root.current?.style.setProperty('--v', f.toFixed(4))
  }

  // controlled value → css
  useEffect(() => {
    if (!dragging.current && !live) writeV(value)
  })

  // live value → css, every frame (and at once when polling resumes, before the next paint)
  useLayoutEffect(() => {
    if (liveActive && live && !dragging.current) writeV(live())
  }, [liveActive]) // eslint-disable-line react-hooks/exhaustive-deps
  useTicker(() => {
    if (!dragging.current && live) writeV(live())
  }, !!live && liveActive)

  const valueAt = (clientX: number) => {
    const r = root.current!.getBoundingClientRect()
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    let v = min + f * range
    if (step) v = Math.round((v - min) / step) * step + min
    return Math.max(min, Math.min(max, v))
  }

  const tick = (v: number) => {
    if (!withTicks) return
    const bucket = Math.round(((v - min) / range) * 20)
    if (bucket !== lastTick.current) {
      lastTick.current = bucket
      sfx.play('tick')
    }
  }

  const emit = useEvent((v: number, commit: boolean) => {
    dragValue.current = v
    writeV(v)
    onChange?.(v)
    if (commit) onCommit?.(v)
  })

  const current = () => (dragging.current ? dragValue.current : live ? live() : value)

  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return
    e.preventDefault()
    root.current!.setPointerCapture(e.pointerId)
    root.current!.focus({ preventScroll: true })
    dragging.current = true
    setIsDragging(true)
    const v = valueAt(e.clientX)
    tick(v)
    emit(v, false)
  }
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const v = valueAt(e.clientX)
    const r = root.current!.getBoundingClientRect()
    root.current!.style.setProperty('--h', Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)).toFixed(4))
    if (format) setHoverText(format(v))
    if (dragging.current) {
      tick(v)
      emit(v, false)
    }
  }
  const endDrag = (e: RPointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    setIsDragging(false)
    const v = valueAt(e.clientX)
    emit(v, true)
    lastWritten.current = -1
  }

  // wheel needs a non-passive listener to preventDefault page scroll
  useEffect(() => {
    const el = root.current
    if (!el || !wheelStep || disabled) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const dir = -Math.sign(e.deltaY || -e.deltaX)
      if (!dir) return
      const v = Math.max(min, Math.min(max, current() + dir * wheelStep * range))
      tick(v)
      emit(v, true)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const onKeyDown = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (disabled) return
    let v = current()
    const big = range / 10
    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        v -= e.shiftKey ? big : st
        break
      case 'ArrowRight':
      case 'ArrowUp':
        v += e.shiftKey ? big : st
        break
      case 'PageDown':
        v -= big
        break
      case 'PageUp':
        v += big
        break
      case 'Home':
        v = min
        break
      case 'End':
        v = max
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
    v = Math.max(min, Math.min(max, v))
    tick(v)
    emit(v, true)
  }

  const shown = live ? undefined : value
  return (
    <div
      ref={root}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={format && shown !== undefined ? format(shown) : undefined}
      aria-disabled={disabled || undefined}
      className={cx('g-slider', `g-slider--${variant}`, isDragging && 'is-dragging', disabled && 'g-slider--disabled', className)}
      style={{ ...hueStyle(hue), ...style }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      <div className="g-slider__track">
        {background && <div className="g-slider__bg">{background}</div>}
        {buffered !== undefined && <div className="g-slider__buffered" style={{ transform: `scaleX(${Math.max(0, Math.min(1, buffered))})` }} />}
        <div className="g-slider__hover" />
        <div className="g-slider__fill" />
      </div>
      <div className="g-slider__thumb" />
      {format && hoverText && <div className="g-slider__tip">{hoverText}</div>}
    </div>
  )
}
