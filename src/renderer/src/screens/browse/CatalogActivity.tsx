// Catalog activity: what the index crawls are doing, per source, and that first-time setup only
// happens once (afterwards sources refresh quietly on a schedule). The Browse status line opens
// it; Settings → Sources shows the same rows.
import { Check, Clock, Pause, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import type { CatalogStatus, SourceIndexStatus } from '@shared/types'
import { ProgressBar } from '../../ui/ProgressBar'
import { cx } from '../../ui/util'
import { DAY, formatEta, formatEvery } from './activity'
import { AnchoredPopover } from './Popover'
import { useRestartKey } from './waits'
import './catalog-activity.css'

/** An idle source: up to date (and when it's next re-read), or due and when that starts. */
function idleLine(s: SourceIndexStatus, now: number): string {
  const dueAt = s.lastIndexedAt == null ? null : s.lastIndexedAt + s.refreshEveryMs
  // When it really starts: the first launch-or-daily check after it's due (older mocks: when due).
  const at = s.nextRefreshAt ?? dueAt
  if (dueAt == null || dueAt <= now) {
    const starts = at != null && at > now ? `starts in ${formatEta(at - now)}` : null
    return [s.lastIndexedAt == null ? 'Not added yet' : 'Refresh due', starts].filter(Boolean).join(' · ')
  }
  const d = Math.ceil(((at ?? dueAt) - now) / DAY)
  return ['Up to date', `refreshes ${formatEvery(s.refreshEveryMs)}`, d <= 1 ? 'next refresh within a day' : `next in ${d} days`].join(' · ')
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
  return idleLine(s, now)
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
            {s.state === 'running' && <SourceBar name={s.name} progress={s.progress} />}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** A running source's crawl: measured when it knows how far it is, a sweep while it doesn't. */
function SourceBar({ name, progress }: { name: string; progress: number | null }) {
  const run = useRestartKey(true, progress)
  return <ProgressBar className="ca-row__bar" size="thin" progress={progress} waitKey={run} aria-label={`Indexing ${name}`} />
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
  const sources = (status.sources ?? []).filter((s) => s.state !== 'off')
  return (
    <AnchoredPopover anchor={anchor} onClose={onClose} className="ca-pop" aria-label="Catalog activity">
      <div className="ca-pop__head">
        <div className="ca-pop__title">{status.setup ? 'Setting up your catalog' : status.indexing ? 'Refreshing sources' : 'Catalog sources'}</div>
        {status.indexing && status.etaMs != null && <div className="ca-pop__eta tnum">{formatEta(status.etaMs)} left</div>}
      </div>
      <SourceActivityList sources={sources} />
      <ActivityNote status={status} />
    </AnchoredPopover>
  )
}
