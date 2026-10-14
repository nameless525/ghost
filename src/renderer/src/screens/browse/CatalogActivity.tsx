// Catalog activity: what the index crawls are doing, per source, and that first-time setup only
// happens once (afterwards sources refresh quietly on a schedule). The Browse status line opens
// it; Settings → Sources shows the same rows.
import { Check, Clock, Pause, RefreshCw } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { CatalogStatus, SourceIndexStatus } from '@shared/types'
import { place } from '../../ui/floating'
import { cx } from '../../ui/util'
import { DAY, formatEta, formatEvery } from './activity'
import './catalog-activity.css'

function nextRefresh(s: SourceIndexStatus, now: number): string | null {
  if (s.lastIndexedAt == null) return null
  const left = s.lastIndexedAt + s.refreshEveryMs - now
  if (left <= 0) return 'refreshes on next launch'
  const d = Math.ceil(left / DAY)
  return d <= 1 ? 'next refresh within a day' : `next in ${d} days`
}

function stateLine(s: SourceIndexStatus, now: number): ReactNode {
  if (s.state === 'running') {
    const bits = [s.initial ? 'Adding for the first time' : 'Refreshing']
    if (s.detail) bits.push(s.detail)
    if (s.etaMs != null) bits.push(`${formatEta(s.etaMs)} left`)
    return bits.join(' · ')
  }
  if (s.state === 'waiting') return s.initial ? 'Up next (first time)' : 'Up next'
  if (s.state === 'off') return 'Turned off in Settings'
  const next = nextRefresh(s, now)
  return ['Up to date', `refreshes ${formatEvery(s.refreshEveryMs)}`, next].filter(Boolean).join(' · ')
}

/** One row per source: icon by state, name, what it's doing, a progress bar while it runs. */
export function SourceActivityList({ sources }: { sources: SourceIndexStatus[] }) {
  const now = Date.now()
  return (
    <ul className="ca-list">
      {sources.map((s) => (
        <li key={s.id} className={cx('ca-row', `ca-row--${s.state}`)}>
          <span className="ca-row__icon" aria-hidden>
            {s.state === 'running' ? <RefreshCw className="ca-spin g-keep-motion" /> : s.state === 'waiting' ? <Clock /> : s.state === 'off' ? <Pause /> : <Check />}
          </span>
          <span className="ca-row__text">
            <span className="ca-row__name">{s.name}</span>
            <span className="ca-row__state">{stateLine(s, now)}</span>
            {s.state === 'running' && (
              <span className="ca-row__bar">
                <span className="ca-row__fill" style={{ transform: `scaleX(${s.progress ?? 0})` }} />
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The explanation under the list: setup happens once; refreshes are background work. */
export function ActivityNote({ status }: { status: CatalogStatus }) {
  if (status.setup)
    return (
      <p className="ca-note">
        Each source is added <b>once</b>. After that it refreshes quietly in the background on its own schedule, so you won’t wait like this again. Browse and playback work the whole time.
      </p>
    )
  return <p className="ca-note">Sources refresh in the background on a schedule. Nothing you do waits for it.</p>
}

/** Popover anchored to the Browse status line. */
export function CatalogActivityPopover({ status, anchor, onClose }: { status: CatalogStatus; anchor: HTMLElement; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null)
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
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', onClose)
    }
  }, [anchor, onClose])
  const sources = (status.sources ?? []).filter((s) => s.state !== 'off')
  return createPortal(
    <div ref={box} className="g-popover ca-pop" role="dialog" aria-label="Catalog activity">
      <div className="ca-pop__head">
        <div className="ca-pop__title">{status.setup ? 'Setting up your catalog' : status.indexing ? 'Refreshing sources' : 'Catalog sources'}</div>
        {status.indexing && status.etaMs != null && <div className="ca-pop__eta tnum">{formatEta(status.etaMs)} left</div>}
      </div>
      <SourceActivityList sources={sources} />
      <ActivityNote status={status} />
    </div>,
    document.body
  )
}
