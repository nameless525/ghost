// Play screen queue drawer (Q): slides in from the right over the visualizer.
import { ListMusic, X } from 'lucide-react'
import { useLayoutEffect, useRef } from 'react'
import { tween } from '../../motion/tween'
import { QueueList } from '../../overlays/now-playing/QueueList'
import { IconButton, OverlayHeader } from '../../ui'

export function QueueDrawer({ open, onClose, drawerRef }: { open: boolean; onClose: () => void; drawerRef?: (el: HTMLElement | null) => void }) {
  const el = useRef<HTMLElement | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  const first = useRef(true)

  useLayoutEffect(() => {
    const n = el.current
    if (!n) return
    const hidden = n.offsetWidth + 48
    if (first.current) {
      first.current = false
      if (!open) {
        tween(n).set({ x: hidden })
        n.style.visibility = 'hidden'
        n.setAttribute('inert', '')
        return
      }
    }
    if (open) {
      n.style.visibility = ''
      n.removeAttribute('inert')
      tween(n).clear().moveToX(0, 560, 'outQuint').fadeIn(140)
    } else {
      void tween(n)
        .clear()
        .moveToX(hidden, 420, 'outQuint')
        .then(() => {
          if (openRef.current) return
          n.style.visibility = 'hidden'
          n.setAttribute('inert', '')
        })
    }
  }, [open])

  return (
    <aside
      ref={(n) => {
        el.current = n
        drawerRef?.(n)
      }}
      className="pl-drawer"
      aria-label="Queue"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="pl-drawer__edge" />
      <OverlayHeader
        icon={<ListMusic />}
        title="Queue"
        description="Drag to reorder · Enter to jump · Del to remove"
        actions={<IconButton label="Close" shortcut="Q" icon={<X />} sound="back" onClick={onClose} />}
      />
      <div className="pl-drawer__body">
        <QueueList active={open} />
      </div>
    </aside>
  )
}
