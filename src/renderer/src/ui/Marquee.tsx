// Single-line text that scrolls only when it doesn't fit (compositor-driven CSS animation).
//
//   <Marquee speed={40}>{track.title}</Marquee>
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { cx } from './util'

export interface MarqueeProps {
  children: ReactNode
  /** px per second. Default 36. */
  speed?: number
  /** Gap between the repeated copies in px. Default 48. */
  gap?: number
  /** Pause while hovered. Default false. */
  pauseOnHover?: boolean
  /** Force pause (e.g. when the player is paused). */
  paused?: boolean
  className?: string
  style?: CSSProperties
}

export function Marquee({ children, speed = 36, gap = 48, pauseOnHover, paused, className, style }: MarqueeProps) {
  const root = useRef<HTMLDivElement>(null)
  const first = useRef<HTMLSpanElement>(null)
  const [overflow, setOverflow] = useState(0)

  useLayoutEffect(() => {
    const r = root.current
    const f = first.current
    if (!r || !f) return
    const measure = () => {
      // an overflowing marquee pads its left edge for the fade gutter (see ui.css): measure the text box
      const gutter = parseFloat(getComputedStyle(r).paddingLeft) || 0
      const over = f.scrollWidth - (r.clientWidth - gutter)
      setOverflow(over > 2 ? f.scrollWidth : 0)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(r)
    ro.observe(f)
    return () => ro.disconnect()
  }, [children])

  const shift = overflow + gap
  const dur = overflow ? shift / speed / 0.82 : 0 // 18% of the cycle is a hold at the start
  return (
    <div
      ref={root}
      className={cx('g-marquee', overflow > 0 && 'g-marquee--overflow', pauseOnHover && 'g-marquee--hover-pause', paused && 'g-marquee--paused', className)}
      style={{ ...style, ...(overflow ? ({ '--mq-shift': `${shift}px`, '--mq-dur': `${dur}s` } as CSSProperties) : null) }}
    >
      <span className="g-marquee__track">
        <span ref={first} className="g-marquee__item">
          {children}
        </span>
        {overflow > 0 && (
          <span className="g-marquee__item" style={{ paddingLeft: gap }} aria-hidden>
            {children}
          </span>
        )}
      </span>
    </div>
  )
}
