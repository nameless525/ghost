import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { sfx, type SfxName } from '../sound'
import { Tooltip } from './Tooltip'
import { cx, hueStyle, type Hue } from './util'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** The icon element, e.g. <Heart />. */
  icon: ReactNode
  /** Accessible name; also the tooltip text unless `tooltip` is given. */
  label: string
  /** Tooltip content; false to disable. Defaults to `label`. */
  tooltip?: ReactNode | false
  /** Keyboard shortcut shown in the tooltip, e.g. 'Mod+L'. */
  shortcut?: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** 'plain' (default), 'solid' (accent fill), 'subtle' (faint surface). */
  variant?: 'plain' | 'solid' | 'subtle'
  round?: boolean
  /** Accent-coloured "on" state (e.g. liked, shuffle on). */
  active?: boolean
  hue?: Hue
  sound?: SfxName | false
  children?: ReactNode
}

/** Square icon button with tooltip, hover glow and press squish. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon, label, tooltip, shortcut, size = 'md', variant = 'plain', round, active, hue, sound = 'select', className, style, onClick, onPointerEnter, disabled, children, type = 'button', ...rest },
  ref
) {
  const btn = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={active ?? undefined}
      disabled={disabled}
      className={cx(
        'g-icon-btn',
        size !== 'md' && `g-icon-btn--${size}`,
        variant !== 'plain' && `g-icon-btn--${variant}`,
        round && 'g-icon-btn--round',
        active && 'g-icon-btn--active',
        className
      )}
      style={{ ...hueStyle(hue), ...style }}
      onPointerEnter={(e) => {
        if (!disabled) sfx.play('hover')
        onPointerEnter?.(e)
      }}
      onClick={(e) => {
        if (sound) sfx.play(sound)
        onClick?.(e)
      }}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
  if (tooltip === false) return btn
  return (
    <Tooltip content={tooltip ?? label} shortcut={shortcut}>
      {btn}
    </Tooltip>
  )
})
