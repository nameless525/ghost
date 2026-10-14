import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { sfx, type SfxName } from '../sound'
import { cx, hueStyle, type Hue } from './util'

export interface ShearButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Main text. */
  label?: ReactNode
  /** Small second line (lg size reads best). */
  hint?: ReactNode
  /** Leading icon, tinted with the hue. */
  icon?: ReactNode
  /** Hue id ('browse', 'library', …) or hex; defaults to the theme accent. */
  hue?: Hue
  /** Toggled-on look (e.g. the current sort). */
  active?: boolean
  size?: 'sm' | 'md' | 'lg'
  /** Render as disabled-looking but still focusable/hoverable (e.g. "soon"). */
  soft?: boolean
  sound?: SfxName | false
  children?: ReactNode
}

/**
 * lazer-style sheared button (song-select footer / main-menu buttons). The body is skewed by
 * --shear and the content counter-skewed so text stays upright. Hover lifts and floods the
 * hue; press squishes.
 */
export const ShearButton = forwardRef<HTMLButtonElement, ShearButtonProps>(function ShearButton(
  { label, hint, icon, hue, active, size = 'md', soft, sound = 'select', className, style, children, onClick, onPointerEnter, disabled, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      aria-disabled={soft || undefined}
      aria-pressed={active ?? undefined}
      className={cx('g-shear-btn', size !== 'md' && `g-shear-btn--${size}`, active && 'g-shear-btn--active', className)}
      style={{ ...hueStyle(hue), ...style }}
      onPointerEnter={(e) => {
        if (!disabled) sfx.play('hover')
        onPointerEnter?.(e)
      }}
      onClick={(e) => {
        if (sound && !soft) sfx.play(sound)
        else if (soft) sfx.play('error', { volume: 0.5 })
        onClick?.(e)
      }}
      {...rest}
    >
      <span className="g-shear-btn__wash" />
      <span className="g-shear-btn__bar" />
      <span className="g-shear-btn__content">
        {icon}
        {hint ? (
          <span className="g-shear-btn__text">
            <span className="g-shear-btn__label">{label ?? children}</span>
            <span className="g-shear-btn__hint">{hint}</span>
          </span>
        ) : (
          (label ?? children)
        )}
      </span>
    </button>
  )
})
