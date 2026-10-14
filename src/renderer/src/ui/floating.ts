// Positioning for floating UI (tooltips, menus, dropdowns): flip + clamp inside the viewport.
import { uiZoom } from './util'

export type Side = 'top' | 'bottom' | 'left' | 'right'
export type Align = 'start' | 'center' | 'end'

export interface Placement {
  /** Viewport px, already divided by the UI zoom so they can go straight into left/top. */
  x: number
  y: number
  side: Side
  /** Transform origin hint for the enter animation. */
  origin: string
}

const opposite: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

/** Place a box of size w×h next to `anchor` (a viewport rect). */
export function place(
  anchor: { left: number; top: number; right: number; bottom: number; width: number; height: number },
  w: number,
  h: number,
  opts: { side?: Side; align?: Align; offset?: number; margin?: number } = {}
): Placement {
  const z = uiZoom()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const margin = opts.margin ?? 8
  const offset = opts.offset ?? 8
  const align = opts.align ?? 'center'
  let side = opts.side ?? 'bottom'

  const fits = (s: Side) =>
    s === 'top' ? anchor.top - offset - h >= margin : s === 'bottom' ? anchor.bottom + offset + h <= vh - margin : s === 'left' ? anchor.left - offset - w >= margin : anchor.right + offset + w <= vw - margin
  if (!fits(side) && fits(opposite[side])) side = opposite[side]

  let x: number
  let y: number
  if (side === 'top' || side === 'bottom') {
    y = side === 'top' ? anchor.top - offset - h : anchor.bottom + offset
    x = align === 'start' ? anchor.left : align === 'end' ? anchor.right - w : anchor.left + anchor.width / 2 - w / 2
  } else {
    x = side === 'left' ? anchor.left - offset - w : anchor.right + offset
    y = align === 'start' ? anchor.top : align === 'end' ? anchor.bottom - h : anchor.top + anchor.height / 2 - h / 2
  }
  x = Math.max(margin, Math.min(x, vw - margin - w))
  y = Math.max(margin, Math.min(y, vh - margin - h))
  const origin = side === 'top' ? 'bottom center' : side === 'bottom' ? 'top center' : side === 'left' ? 'right center' : 'left center'
  return { x: x / z, y: y / z, side, origin }
}

/** Place a menu at a point (context menus), flipping to stay on screen. */
export function placeAtPoint(px: number, py: number, w: number, h: number, margin = 8): Placement {
  const z = uiZoom()
  const vw = window.innerWidth
  const vh = window.innerHeight
  let x = px
  let y = py
  let ox = 'left'
  let oy = 'top'
  if (x + w > vw - margin) {
    x = Math.max(margin, px - w)
    ox = 'right'
  }
  if (y + h > vh - margin) {
    y = Math.max(margin, py - h)
    oy = 'bottom'
  }
  return { x: x / z, y: y / z, side: 'bottom', origin: `${oy} ${ox}` }
}
