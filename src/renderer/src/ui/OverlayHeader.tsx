import type { ReactNode } from 'react'
import { cx } from './util'

export interface OverlayHeaderProps {
  /** Icon, shown in a sheared tile filled with the overlay hue. */
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  /** Right-aligned controls (buttons, a search box). */
  actions?: ReactNode
  className?: string
}

/**
 * Standard header for overlay panels (Library, Settings, Downloads…). It inherits the
 * overlay's hue from OverlayHost, so it's tinted correctly with no props.
 */
export function OverlayHeader({ icon, title, description, actions, className }: OverlayHeaderProps) {
  return (
    <header className={cx('g-overlay-header', className)}>
      {icon && <div className="g-overlay-header__icon">{icon}</div>}
      <div className="g-overlay-header__text">
        <div className="g-overlay-header__title">{title}</div>
        {description && <div className="g-overlay-header__desc">{description}</div>}
      </div>
      {actions && <div className="g-overlay-header__actions">{actions}</div>}
    </header>
  )
}
