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

/** Wheel distance (px) per step: one mouse notch; a trackpad swipe accumulates to it. */
const WHEEL_NOTCH = 40

/**
 * How often a live value (a seek bar during playback) reaches aria-valuenow / aria-valuetext.
 * Slower while focused: screen readers speak a focused slider's every change, and the clock
 * shouldn't tick aloud. The user's own changes (keys, drag, wheel) are written at once.
 */
const ARIA_LIVE_MS = 1000
const ARIA_LIVE_FOCUSED_MS = 5000

/** A slider's current value for assistive tech, written to the element without a re-render. */
export class AriaValue {
  /** When the value was last written (ms, performance.now() domain). */
  private at = -Infinity
  private valueNow = ''
  private valueText: string | null = null

  constructor(private el: () => Element | null) {}

  /** Write `v` now (a controlled value, or the user's own change). */
  write(v: number, min: number, max: number, format: ((v: number) => string) | undefined, at = 0): void {
    const el = this.el()
    if (!el) return
    this.at = at
    const c = Math.max(min, Math.min(max, v))
    const valueNow = String(Math.round(c * 1000) / 1000)
    if (valueNow !== this.valueNow) el.setAttribute('aria-valuenow', (this.valueNow = valueNow))
    const text = format ? format(c) : null
    if (text === this.valueText) return
    this.valueText = text
    if (text === null) el.removeAttribute('aria-valuetext')
    else el.setAttribute('aria-valuetext', text)
  }

  /** A live value, polled every frame: written at a modest cadence. */
  poll(v: number, min: number, max: number, format: ((v: number) => string) | undefined, at: number, focused: boolean): void {
    if (at - this.at >= (focused ? ARIA_LIVE_FOCUSED_MS : ARIA_LIVE_MS)) this.write(v, min, max, format, at)
  }
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
  const tip = useRef<HTMLDivElement>(null)
  /** Value of an ongoing wheel gesture (committed when it pauses). */
  const wheelValue = useRef<number | null>(null)
  const wheelAcc = useRef(0)
  const wheelTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const range = max - min || 1
  const st = step ?? range / 100
  const withTicks = ticks ?? variant !== 'seek'
  const aria = useRef<AriaValue>(null)
  aria.current ??= new AriaValue(() => root.current)
  const writeAria = (v: number) => aria.current!.write(v, min, max, format, performance.now())

  const writeV = (v: number) => {
    // quantised to ~1/4096 of the track (under a device pixel on any seek bar)
    const f = Math.round(Math.max(0, Math.min(1, (v - min) / range)) * 4096) / 4096
    if (f === lastWritten.current) return
    lastWritten.current = f
    root.current?.style.setProperty('--v', f.toFixed(4))
  }

  // controlled value → css (and aria)
  useEffect(() => {
    if (dragging.current || wheelValue.current !== null || live) return
    writeV(value)
    writeAria(value)
  })

  // live value → css, every frame (and at once when polling resumes, before the next paint)
  useLayoutEffect(() => {
    if (!live || dragging.current) return
    if (liveActive) writeV(live())
    writeAria(live())
  }, [liveActive]) // eslint-disable-line react-hooks/exhaustive-deps
  useTicker((_dt, now) => {
    if (dragging.current || wheelValue.current !== null || !live) return
    const v = live()
    writeV(v)
    aria.current!.poll(v, min, max, format, now, document.activeElement === root.current)
  }, !!live && liveActive)

  const valueAt = (clientX: number, r: DOMRect = root.current!.getBoundingClientRect()) => {
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
    writeAria(v)
    onChange?.(v)
    if (commit) onCommit?.(v)
  })

  const current = () => (dragging.current ? dragValue.current : (wheelValue.current ?? (live ? live() : value)))

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
    const r = root.current!.getBoundingClientRect()
    const v = valueAt(e.clientX, r)
    root.current!.style.setProperty('--h', Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)).toFixed(4))
    // the hover tip is written directly: a React state here re-rendered the slider per pointermove
    const t = tip.current
    if (t && format) {
      const text = format(v)
      if (t.textContent !== text) t.textContent = text
    }
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

  // Wheel (a non-passive listener, to preventDefault the scroll). Deltas accumulate, so a
  // trackpad swipe moves about a step per mouse notch instead of one per event, and the commit
  // (a settings write, a seek) waits for the gesture to pause instead of firing per event.
  // In a scrolling panel an unfocused slider leaves the wheel to the panel.
  const onWheel = useEvent((e: WheelEvent) => {
    const el = root.current
    if (!el || (document.activeElement !== el && el.closest('.g-scroll'))) return
    e.preventDefault()
    const d = e.deltaY || -e.deltaX
    wheelAcc.current += e.deltaMode ? Math.sign(d) * WHEEL_NOTCH : d
    if (Math.abs(wheelAcc.current) < WHEEL_NOTCH) return
    const dir = -Math.sign(wheelAcc.current)
    wheelAcc.current = 0
    const v = Math.max(min, Math.min(max, current() + dir * wheelStep * range))
    wheelValue.current = v
    tick(v)
    emit(v, false)
    clearTimeout(wheelTimer.current)
    wheelTimer.current = setTimeout(() => {
      const w = wheelValue.current
      if (w !== null) onCommit?.(w)
      // keep showing the wheel's value until the commit has had time to come back (a seek's
      // state push), so a live slider doesn't flick back to the old position for a frame
      wheelTimer.current = setTimeout(() => (wheelValue.current = null), 250)
    }, 160)
  })
  useEffect(() => {
    const el = root.current
    if (!el || !wheelStep || disabled) return
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [wheelStep, disabled, onWheel])
  useEffect(() => () => clearTimeout(wheelTimer.current), [])

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

  // aria-valuenow / aria-valuetext are written by AriaValue, not rendered
  return (
    <div
      ref={root}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-disabled={disabled || undefined}
      className={cx('g-slider', `g-slider--${variant}`, isDragging && 'is-dragging', disabled && 'g-slider--disabled', className)}
      style={{ ...hueStyle(hue), ...style }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      onFocus={() => writeAria(current())}
    >
      <div className="g-slider__track">
        {background && <div className="g-slider__bg">{background}</div>}
        {buffered !== undefined && <div className="g-slider__buffered" style={{ transform: `scaleX(${Math.max(0, Math.min(1, buffered))})` }} />}
        <div className="g-slider__hover" />
        <div className="g-slider__fill" />
      </div>
      <div className="g-slider__thumb" />
      {format && <div ref={tip} className="g-slider__tip" />}
    </div>
  )
}
