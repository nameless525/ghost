// The notification centre overlay: everything received this session.
import { Bell, CircleAlert, CircleCheck, Info, LoaderCircle, Trash2 } from 'lucide-react'
import { Button } from '../ui/Button'
import { CoverArt } from '../ui/CoverArt'
import { OverlayHeader } from '../ui/OverlayHeader'
import { ScrollArea } from '../ui/ScrollArea'
import { cx } from '../ui/util'
import { useNotifications } from './notifications'
import type { OverlayProps } from './types'

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return `${h} h ago`
}

export default function NotificationCenter(_props: OverlayProps) {
  const history = useNotifications((s) => s.history)
  const clear = useNotifications((s) => s.clearHistory)
  return (
    <div className="g-ncenter">
      <OverlayHeader
        icon={<Bell />}
        title="Notifications"
        description={history.length ? `${history.length} this session` : 'All quiet'}
        actions={
          history.length > 0 && (
            <Button size="sm" variant="ghost" icon={<Trash2 />} sound="back" onClick={clear}>
              Clear
            </Button>
          )
        }
      />
      <ScrollArea className="g-ncenter__list">
        {history.length === 0 && (
          <div className="g-ncenter__empty">
            <Bell />
            <div>Downloads, playlist changes and errors show up here.</div>
          </div>
        )}
        {history.map((n) => (
          <div key={n.id} className={cx('g-ncenter__item', `g-toast--${n.kind}`, !n.read && 'g-ncenter__item--unread')}>
            <div className="g-toast__icon">
              {n.image ? (
                <CoverArt src={n.image} size={36} radius={8} />
              ) : (
                <span className="g-toast__glyph">
                  {n.kind === 'success' ? <CircleCheck /> : n.kind === 'error' ? <CircleAlert /> : n.kind === 'progress' ? <LoaderCircle /> : <Info />}
                </span>
              )}
            </div>
            <div className="g-toast__text">
              <div className="g-toast__title">{n.title}</div>
              {n.body && <div className="g-toast__body">{n.body}</div>}
              {n.kind === 'progress' && (n.progress ?? 0) < 1 && (
                <div className="g-toast__progress">
                  <div className="g-toast__progress-fill" style={{ transform: `scaleX(${n.progress ?? 0})` }} />
                </div>
              )}
            </div>
            <div className="g-ncenter__time">{ago(n.createdAt)}</div>
          </div>
        ))}
      </ScrollArea>
    </div>
  )
}
