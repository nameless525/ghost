// Dropdown select with an animated popover, keyboard navigation and type-ahead.
//
//   <Select value={group} onChange={setGroup} options={[{ value: 'game', label: 'Game' }, …]} />
import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as RKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { sfx } from '../sound'
import { place } from './floating'
import { cx, hueStyle, uiZoom, type Hue, portalRoot } from './util'

export interface SelectOption<T extends string | number> {
  value: T
  label: ReactNode
  icon?: ReactNode
  /** Right-aligned muted text. */
  hint?: ReactNode
  disabled?: boolean
  /** Text used for type-ahead when label isn't a string. */
  text?: string
}

export interface SelectProps<T extends string | number> {
  value: T | null
  options: SelectOption<T>[]
  onChange: (value: T) => void
  placeholder?: ReactNode
  /** Prefix shown before the value, e.g. "sort:". */
  prefix?: ReactNode
  disabled?: boolean
  width?: number | string
  hue?: Hue
  className?: string
  style?: CSSProperties
  'aria-label'?: string
}

export function Select<T extends string | number>({ value, options, onChange, placeholder, prefix, disabled, width, hue, className, style, 'aria-label': ariaLabel }: SelectProps<T>) {
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [active, setActive] = useState(-1)
  const typed = useRef({ text: '', at: 0 })
  const selectedIndex = options.findIndex((o) => o.value === value)
  const selected = options[selectedIndex]

  const openMenu = () => {
    if (disabled) return
    setClosing(false)
    setOpen(true)
    setActive(Math.max(0, selectedIndex))
    sfx.play('select', { volume: 0.6 })
  }
  const close = (refocus = true) => {
    if (!open) return
    setClosing(true)
    window.setTimeout(() => {
      setOpen(false)
      setClosing(false)
    }, 120)
    if (refocus) trigger.current?.focus({ preventScroll: true })
  }
  const choose = (i: number) => {
    const o = options[i]
    if (!o || o.disabled) return
    sfx.play('confirm', { volume: 0.5 })
    if (o.value !== value) onChange(o.value)
    close()
  }

  useLayoutEffect(() => {
    if (!open || !list.current || !trigger.current) return
    const r = trigger.current.getBoundingClientRect()
    const el = list.current
    el.style.minWidth = `${r.width / uiZoom()}px`
    const p = place(r, el.offsetWidth, el.offsetHeight, { side: 'bottom', align: 'start', offset: 6 })
    el.style.left = `${p.x}px`
    el.style.top = `${p.y}px`
    el.style.transformOrigin = p.side === 'top' ? 'bottom left' : 'top left'
    el.focus({ preventScroll: true })
    el.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open])

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (list.current?.contains(e.target as Node) || trigger.current?.contains(e.target as Node)) return
      close(false)
    }
    const onBlur = () => close(false)
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('blur', onBlur)
    window.addEventListener('resize', onBlur)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('resize', onBlur)
    }
  })

  const move = (dir: 1 | -1) => {
    if (!options.length) return
    let i = active
    for (let n = 0; n < options.length; n++) {
      i = (i + dir + options.length) % options.length
      if (!options[i].disabled) break
    }
    setActive(i)
  }

  const onListKey = (e: RKeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'ArrowDown') move(1)
    else if (e.key === 'ArrowUp') move(-1)
    else if (e.key === 'Home') setActive(0)
    else if (e.key === 'End') setActive(options.length - 1)
    else if (e.key === 'Enter' || e.key === ' ') choose(active)
    else if (e.key === 'Escape' || e.key === 'Tab') close()
    else if (e.key.length === 1) {
      const now = performance.now()
      typed.current.text = now - typed.current.at > 700 ? e.key.toLowerCase() : typed.current.text + e.key.toLowerCase()
      typed.current.at = now
      const i = options.findIndex((o) => (o.text ?? (typeof o.label === 'string' ? o.label : String(o.value))).toLowerCase().startsWith(typed.current.text))
      if (i >= 0) setActive(i)
    } else return
    e.preventDefault()
  }

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cx('g-select', open && 'g-select--open', className)}
        style={{ width, ...hueStyle(hue), ...style }}
        onPointerEnter={() => sfx.play('hover')}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            e.stopPropagation()
            openMenu()
          }
        }}
      >
        <span className="g-select__value g-ellipsis">
          {prefix && <span className="g-muted">{prefix}</span>}
          {selected ? (
            <>
              {selected.icon}
              {selected.label}
            </>
          ) : (
            <span className="g-select__placeholder">{placeholder ?? 'Select…'}</span>
          )}
        </span>
        <ChevronDown className="g-select__chev" />
      </button>
      {open &&
        createPortal(
          <div
            ref={list}
            role="listbox"
            tabIndex={-1}
            className={cx('g-popover', closing && 'g-popover--closing')}
            style={hueStyle(hue)}
            onKeyDown={onListKey}
          >
            {options.map((o, i) => (
              <button
                key={String(o.value)}
                type="button"
                role="option"
                aria-selected={o.value === value}
                data-active={i === active}
                tabIndex={-1}
                className={cx('g-option', i === active && 'g-option--active', o.value === value && 'g-option--selected', o.disabled && 'g-option--disabled')}
                onPointerMove={() => {
                  if (active !== i) {
                    setActive(i)
                    sfx.play('hover', { volume: 0.6 })
                  }
                }}
                onClick={() => choose(i)}
              >
                {o.icon}
                <span className="g-option__label">{o.label}</span>
                {o.hint && <span className="g-option__hint">{o.hint}</span>}
                {o.value === value ? <Check className="g-option__check" /> : <span style={{ width: 15 }} />}
              </button>
            ))}
          </div>,
          portalRoot()
        )}
    </>
  )
}
