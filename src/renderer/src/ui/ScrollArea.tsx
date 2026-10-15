// Scroll container with osu!-style smoothed mouse-wheel scrolling (trackpads stay native),
// thin scrollbars, and soft fade edges when there's more content above/below.
//
//   <ScrollArea style={{ height: '100%' }}>{rows}</ScrollArea>
//   const ref = useRef<HTMLDivElement>(null); <ScrollArea viewportRef={ref} …/>; scrollToSmooth(ref.current, 400)
import { forwardRef, useEffect, useRef, type CSSProperties, type ReactNode, type Ref, type UIEvent } from 'react'
import { damp } from '../motion/easing'
import { motionPrefs } from '../motion/prefs'
import { ticker, TickPriority } from '../motion/ticker'
import { cx, mergeRefs } from './util'

export interface ScrollAreaProps {
  children?: ReactNode
  /** Horizontal instead of vertical. */
  horizontal?: boolean
  /** Smooth mouse-wheel scrolling. Default true. */
  smooth?: boolean
  /** Fade edges when scrollable. Default true. */
  fade?: boolean
  className?: string
  style?: CSSProperties
  onScroll?: (e: UIEvent<HTMLDivElement>) => void
  /** Ref to the scrolling element. */
  viewportRef?: Ref<HTMLDivElement>
  role?: string
  tabIndex?: number
}

interface Smooth {
  target: number
  off: (() => void) | null
}
const smoothState = new WeakMap<HTMLElement, Smooth>()

/** Animate an element's scroll position (vertical unless `horizontal`) with a damped approach. */
export function scrollToSmooth(el: HTMLElement | null, pos: number, horizontal = false): void {
  if (!el) return
  const max = horizontal ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight
  const target = Math.max(0, Math.min(max, pos))
  if (motionPrefs.reduce) {
    if (horizontal) el.scrollLeft = target
    else el.scrollTop = target
    return
  }
  let s = smoothState.get(el)
  if (!s) smoothState.set(el, (s = { target, off: null }))
  s.target = target
  if (s.off) return
  const st = s
  st.off = ticker.add((dt) => {
    // Content may have shrunk mid-scroll (target now unreachable) or the panel been hidden
    // (display:none ignores writes): either used to keep this subscriber alive forever.
    const max = horizontal ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight
    if (st.target > max) st.target = Math.max(0, max)
    const cur = horizontal ? el.scrollLeft : el.scrollTop
    const next = damp(cur, st.target, 55, dt)
    let done = Math.abs(next - st.target) < 0.5
    const v = done ? st.target : next
    if (horizontal) el.scrollLeft = v
    else el.scrollTop = v
    if (!done && (horizontal ? el.scrollLeft : el.scrollTop) === cur) {
      // the step was below a device pixel (or the write was ignored): land and stop
      if (horizontal) el.scrollLeft = st.target
      else el.scrollTop = st.target
      done = true
    }
    if (done || !el.isConnected || el.clientHeight === 0) {
      st.off?.()
      st.off = null
    }
  }, TickPriority.physics)
}

export const ScrollArea = forwardRef<HTMLDivElement, ScrollAreaProps>(function ScrollArea(
  { children, horizontal, smooth = true, fade = true, className, style, onScroll, viewportRef, role, tabIndex },
  ref
) {
  const el = useRef<HTMLDivElement>(null)

  const updateEdges = () => {
    const n = el.current
    if (!n || !fade) return
    const pos = horizontal ? n.scrollLeft : n.scrollTop
    const max = horizontal ? n.scrollWidth - n.clientWidth : n.scrollHeight - n.clientHeight
    n.classList.toggle('g-scroll--can-up', pos > 2)
    n.classList.toggle('g-scroll--can-down', pos < max - 2)
  }

  useEffect(() => {
    const n = el.current
    if (!n) return
    updateEdges()
    const ro = new ResizeObserver(updateEdges)
    ro.observe(n)
    if (n.firstElementChild) ro.observe(n.firstElementChild)
    const mo = new MutationObserver(updateEdges)
    mo.observe(n, { childList: true })
    if (!smooth) return () => (ro.disconnect(), mo.disconnect())
    const onWheel = (e: WheelEvent) => {
      // a control inside (a focused slider) already used this wheel
      if (e.ctrlKey || e.defaultPrevented) return
      // trackpads report small pixel deltas with momentum: leave them native
      const mouseWheel = e.deltaMode !== 0 || (Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY) && e.deltaX === 0)
      if (!mouseWheel) {
        const s = smoothState.get(n)
        if (s?.off) {
          s.off()
          s.off = null
        }
        return
      }
      const delta = (horizontal ? e.deltaY || e.deltaX : e.deltaY) * (e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? n.clientHeight : 1)
      const max = horizontal ? n.scrollWidth - n.clientWidth : n.scrollHeight - n.clientHeight
      if (max <= 0) return
      const s = smoothState.get(n)
      const base = s?.off ? s.target : horizontal ? n.scrollLeft : n.scrollTop
      const target = Math.max(0, Math.min(max, base + delta * 1.15))
      if (target === base) return
      e.preventDefault()
      scrollToSmooth(n, target, horizontal)
    }
    n.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      ro.disconnect()
      mo.disconnect()
      n.removeEventListener('wheel', onWheel)
    }
  }, [smooth, horizontal, fade]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={mergeRefs(el, ref, viewportRef)}
      role={role}
      tabIndex={tabIndex}
      className={cx('g-scroll', horizontal && 'g-scroll--x', fade && 'g-scroll--fade', className)}
      style={style}
      onScroll={(e) => {
        updateEdges()
        onScroll?.(e)
      }}
    >
      {children}
    </div>
  )
})
