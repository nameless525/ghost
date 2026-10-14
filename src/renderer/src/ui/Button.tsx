import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { sfx, type SfxName } from '../sound'
import { LoadingRing } from './LoadingRing'
import { cx, hueStyle, type Hue } from './util'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 'primary' (accent fill), 'secondary' (surface), 'ghost', 'soft' (accent tint), 'danger'. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'soft' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  /** Leading icon (e.g. <Play />). */
  icon?: ReactNode
  /** Trailing icon. */
  iconRight?: ReactNode
  /** Shows a spinner and blocks clicks. */
  loading?: boolean
  /** Full width. */
  block?: boolean
  /** Re-colour this button (hue id like 'library' or a hex). Defaults to the theme accent. */
  hue?: Hue
  /** Click sound, or false for silence. Default 'select'. */
  sound?: SfxName | false
  /** Hover tick. Default true. */
  hoverSound?: boolean
}

/** The standard button. Hover lifts and sheens, press squishes, both with sound. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, iconRight, loading, block, hue, sound = 'select', hoverSound = true, className, children, style, onClick, onPointerEnter, disabled, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        'g-btn',
        `g-btn--${variant}`,
        size !== 'md' && `g-btn--${size}`,
        block && 'g-btn--block',
        !children && icon && 'g-btn--icon-only',
        loading && 'g-btn--loading',
        className
      )}
      style={{ ...hueStyle(hue), ...style }}
      onPointerEnter={(e) => {
        if (hoverSound && !disabled) sfx.play('hover')
        onPointerEnter?.(e)
      }}
      onClick={(e) => {
        if (sound) sfx.play(sound)
        onClick?.(e)
      }}
      {...rest}
    >
      <span className="g-btn__label">
        {icon}
        {children}
        {iconRight}
      </span>
      {loading && (
        <span className="g-btn__spinner">
          <LoadingRing size={size === 'lg' ? 22 : 16} />
        </span>
      )}
    </button>
  )
})
