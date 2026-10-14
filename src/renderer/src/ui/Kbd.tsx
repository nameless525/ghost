import { formatCombo } from '../shell/keys'
import { cx } from './util'

export interface KbdProps {
  /** A combo like 'Mod+Shift+L', 'F6', 'Escape'. Rendered platform-aware (⌘ on macOS). */
  combo: string
  size?: 'sm' | 'md'
  className?: string
}

/** Keycaps for a shortcut. */
export function Kbd({ combo, size = 'md', className }: KbdProps) {
  return (
    <kbd className={cx('g-kbd', size === 'sm' && 'g-kbd--sm', className)} aria-label={combo}>
      {formatCombo(combo).map((k, i) => (
        <span key={i} className="g-kbd__key">
          {k}
        </span>
      ))}
    </kbd>
  )
}
