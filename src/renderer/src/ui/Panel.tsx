import { forwardRef, type HTMLAttributes, type ReactNode } from 'react'
import { cx, hueStyle, type Hue } from './util'

export interface PanelProps extends HTMLAttributes<HTMLDivElement> {
  /** lazer shear: skew the panel by --shear, keep content upright. */
  sheared?: boolean
  /** Hover brightens and scales to 1.02. */
  interactive?: boolean
  /** Accent edge glow (the selected carousel panel). */
  selected?: boolean
  /** Soft accent wash in the top-left corner. */
  glow?: boolean
  /** Inner padding (16 × 18). Default true. */
  padded?: boolean
  hue?: Hue
  children?: ReactNode
}

/** Glassy surface. With `sheared`, a lazer-style parallelogram whose content stays upright. */
export const Panel = forwardRef<HTMLDivElement, PanelProps>(function Panel(
  { sheared, interactive, selected, glow, padded = true, hue, className, style, children, ...rest },
  ref
) {
  return (
    <div
      ref={ref}
      className={cx(
        'g-panel',
        padded && !sheared && 'g-panel--pad',
        sheared && 'g-panel--sheared',
        interactive && 'g-panel--interactive',
        selected && 'g-panel--selected',
        glow && 'g-panel--glow',
        className
      )}
      style={{ ...hueStyle(hue), ...style }}
      {...rest}
    >
      {sheared ? <div className={cx('g-panel__content', padded && 'g-panel--pad')}>{children}</div> : children}
    </div>
  )
})

export interface WedgeProps extends PanelProps {
  /** Which screen edge the wedge bleeds off. Default 'left'. */
  side?: 'left' | 'right'
}

/**
 * A sheared panel that bleeds off one screen edge so only its far edge shows the slant,
 * like lazer's beatmap info wedge. Place it flush against that edge.
 */
export const Wedge = forwardRef<HTMLDivElement, WedgeProps>(function Wedge({ side = 'left', className, ...rest }, ref) {
  return <Panel ref={ref} sheared className={cx('g-wedge', `g-wedge--${side}`, className)} {...rest} />
})
