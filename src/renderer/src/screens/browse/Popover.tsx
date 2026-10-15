// A small anchored popover for Browse (catalog activity, search tips): placed under its anchor,
// closed by Esc, a click outside it or a window resize. Portalled into the app root so the UI
// scale applies to it (place() returns coordinates in the zoomed space).
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { place } from '../../ui/floating'
import { cx, portalRoot } from '../../ui/util'

export interface AnchoredPopoverProps {
  anchor: HTMLElement
  onClose: () => void
  className?: string
  'aria-label': string
  children: ReactNode
}

export function AnchoredPopover({ anchor, onClose, className, children, 'aria-label': label }: AnchoredPopoverProps) {
  const box = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const p = place(anchor.getBoundingClientRect(), el.offsetWidth, el.offsetHeight, { side: 'bottom', align: 'end', offset: 10 })
    el.style.left = `${p.x}px`
    el.style.top = `${p.y}px`
    el.style.transformOrigin = p.side === 'top' ? 'bottom right' : 'top right'
  })
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (box.current?.contains(e.target as Node) || anchor.contains(e.target as Node)) return
      close.current()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      close.current()
    }
    const onResize = () => close.current()
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onResize)
    }
  }, [anchor])
  return createPortal(
    <div ref={box} className={cx('g-popover', className)} role="dialog" aria-label={label}>
      {children}
    </div>,
    portalRoot()
  )
}
