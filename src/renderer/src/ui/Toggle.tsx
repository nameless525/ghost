import type { ReactNode } from 'react'
import { sfx } from '../sound'
import { cx, hueStyle, type Hue } from './util'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** When given, renders a full settings row: label (+ description) on the left, switch on the right. */
  label?: ReactNode
  description?: ReactNode
  disabled?: boolean
  hue?: Hue
  className?: string
  'aria-label'?: string
}

/** Switch with a springy knob that squishes on press. */
export function Toggle({ checked, onChange, label, description, disabled, hue, className, 'aria-label': ariaLabel }: ToggleProps) {
  const sw = (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
      disabled={disabled}
      className={cx('g-toggle', !label && className)}
      style={hueStyle(hue)}
      onPointerEnter={() => !disabled && sfx.play('hover')}
      onClick={(e) => {
        e.stopPropagation()
        sfx.play(checked ? 'toggleOff' : 'toggleOn')
        onChange(!checked)
      }}
    >
      <span className="g-toggle__knob" />
    </button>
  )
  if (!label) return sw
  return (
    <label
      className={cx('g-toggle-row', className)}
      onClick={(e) => {
        if (disabled || (e.target as HTMLElement).closest('.g-toggle')) return
        e.preventDefault()
        sfx.play(checked ? 'toggleOff' : 'toggleOn')
        onChange(!checked)
      }}
    >
      <span className="g-toggle-row__text">
        <span className="g-toggle-row__label">{label}</span>
        {description && <span className="g-toggle-row__desc">{description}</span>}
      </span>
      {sw}
    </label>
  )
}
