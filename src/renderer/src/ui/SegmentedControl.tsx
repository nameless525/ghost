// Segmented control with a sliding indicator.
//
//   <SegmentedControl value={tab} onChange={setTab} options={[{ value: 'playlists', label: 'Playlists' }, …]} />
import { useLayoutEffect, useRef, type KeyboardEvent as RKeyboardEvent, type ReactNode } from 'react'
import { sfx } from '../sound'
import { cx, hueStyle, type Hue } from './util'

export interface SegmentOption<T extends string> {
  value: T
  label: ReactNode
  icon?: ReactNode
  disabled?: boolean
}

export interface SegmentedControlProps<T extends string> {
  value: T
  options: SegmentOption<T>[]
  onChange: (value: T) => void
  /** lazer shear. */
  sheared?: boolean
  /** Stretch to fill the container. */
  block?: boolean
  hue?: Hue
  className?: string
  'aria-label'?: string
}

export function SegmentedControl<T extends string>({ value, options, onChange, sheared, block, hue, className, 'aria-label': ariaLabel }: SegmentedControlProps<T>) {
  const root = useRef<HTMLDivElement>(null)
  const ind = useRef<HTMLDivElement>(null)
  const first = useRef(true)

  useLayoutEffect(() => {
    const r = root.current
    const i = ind.current
    if (!r || !i) return
    const update = () => {
      const btn = r.querySelector<HTMLElement>('[aria-checked="true"]')
      if (!btn) {
        i.style.opacity = '0'
        return
      }
      if (first.current) i.style.transition = 'none'
      i.style.opacity = '1'
      i.style.width = `${btn.offsetWidth}px`
      i.style.transform = `translateX(${btn.offsetLeft}px)`
      if (first.current) {
        void i.offsetWidth
        i.style.transition = ''
        first.current = false
      }
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(r)
    return () => ro.disconnect()
  }, [value, options.length])

  const onKeyDown = (e: RKeyboardEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    e.stopPropagation()
    const idx = options.findIndex((o) => o.value === value)
    const dir = e.key === 'ArrowRight' ? 1 : -1
    for (let n = 1; n <= options.length; n++) {
      const o = options[(idx + dir * n + options.length) % options.length]
      if (!o.disabled) {
        sfx.play('select', { volume: 0.6 })
        onChange(o.value)
        root.current?.querySelector<HTMLElement>(`[data-value="${CSS.escape(o.value)}"]`)?.focus({ preventScroll: true })
        break
      }
    }
  }

  return (
    <div
      ref={root}
      role="radiogroup"
      aria-label={ariaLabel}
      className={cx('g-seg', sheared && 'g-seg--sheared', block && 'g-seg--block', className)}
      style={hueStyle(hue)}
      onKeyDown={onKeyDown}
    >
      <div ref={ind} className="g-seg__indicator" />
      {options.map((o) => {
        const on = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            data-value={o.value}
            tabIndex={on ? 0 : -1}
            disabled={o.disabled}
            className="g-seg__item"
            onPointerEnter={() => sfx.play('hover')}
            onClick={() => {
              if (on) return
              sfx.play('select', { volume: 0.7 })
              onChange(o.value)
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {o.icon}
              {o.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
